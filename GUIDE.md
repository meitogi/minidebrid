# Setup guide

From an empty `.env` to a stream link answering through the tunnel : the
server, the relay and the stream router. Publishing the webapp is in
[README.md](README.md#run).

## Where each command runs

| Step | Where | Why |
|---|---|---|
| Unit tests (`wtf debrid test`) | devcontainer or host | offline |
| Live test (`wtf debrid test-live`) | devcontainer or host, **home connection only** | calls Alldebrid with the real key |
| DNS records | Cloudflare dashboard | — |
| Relay + router (`wtf signal …`) | VPS, `server-kevledev-mini` checkout | VPS infra |
| Server (`wtf debrid agent …` on macOS, `wtf debrid up` on Linux) | home machine | must share the home IP ; launchd and the macOS firewall are host-only |
| frpc proxy | home machine, frpc directory | outside both repos |
| Access tokens (`wtf debrid token …`) | home machine (Linux : `docker exec`, § 7) | writes the token store ; prints live setup links |
| HTTPS checks (`curl`) | host | the devcontainer firewall blocks the VPS |
| Update (§ 8) | push : where you commit ; server : home machine | Pages deploys on push ; the server runs at home |

Alldebrid bans accounts used from several IPs : anything holding
`ALLDEBRID_APIKEY` runs from the home connection, never from a laptop
elsewhere or from the VPS.

## 1. Configure the server

```sh
cp server/.env.example server/.env
openssl rand -hex 32
```

Fill `server/.env` :

| Variable | Value |
|---|---|
| `ALLDEBRID_APIKEY` | from <https://alldebrid.com/apikeys/> |
| `STREAM_SECRET` | the `openssl` output : signs the stream (VLC) links, never given to a device |
| `APP_TOKEN` | optional : one access token kept in `.env`, listed as `default` (§ 7) ; device tokens come from `wtf debrid token add` |
| `PUBLIC_URL` | `https://debrid.du.ranchchoco.boo` |
| `RELAY_URL` | `wss://signal.du.ranchchoco.boo` |
| `HTTP_PORT` | `8098` (frpc's `localPort`) |
| `ICE_PORTS` | `50000-50019` (fixed UDP range for WebRTC ; open it if the machine has a firewall) |

`server/.env` is gitignored and kept out of the Docker image. Without
`STREAM_SECRET`, `APP_TOKEN` signs the stream links (the setup before
access tokens) ; setting `STREAM_SECRET` later invalidates the links issued
until then — ask the webapp for new ones.

## 2. Test against the real account

```sh
wtf debrid test
wtf debrid test-live
```

The first is offline. The second reads the key from `server/.env` and, in
at most 7 Alldebrid calls :

- checks the account, lists the magnets, reads the files of up to 3 ready
  ones ;
- downloads the smallest file of at least 1 MB over a real WebRTC
  DataChannel (whole file up to 20 MB, otherwise cancelled after 2 MB) ;
- fetches the same file through the stream proxy with `Range` and checks
  the first and last KB match the P2P bytes.

It never uploads, deletes or restarts anything. Without `server/.env` it is
reported as skipped, naming the missing variable.

## 3. DNS

In Cloudflare, two `A` records to the VPS IP, **DNS only (grey cloud)** :

- `debrid.du` — stream links
- `signal.du` — signaling relay

An orange cloud would put Cloudflare in the byte path. Certificates use the
DNS challenge (`acme-cloudflare-dns`), which works with grey-cloud records.

## 4. VPS — relay and stream router

In the `server-kevledev-mini` checkout :

```sh
git pull
wtf signal start
wtf signal logs
```

The log should end with `signal-relay écoute ws://0.0.0.0:8787`. The stream
router (`docker/traefik/dynamic/02-debrid-remote.yml`) is hot-loaded, so
Traefik does not need a restart.

Check from any machine :

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://signal.du.ranchchoco.boo/
wtf traefik certs
```

- `426` (Upgrade Required) : the relay answers through Traefik. Any code
  other than `000` means the route works.
- `wtf traefik certs` lists `certificate obtained` for both hosts. If curl
  shows `TRAEFIK DEFAULT CERT`, the DNS challenge failed : read the `error`
  lines.

## 5. Home — the server

How it runs depends on the home machine's OS.

**macOS — run it natively, not in Docker.** Docker Desktop runs containers
in a Linux VM : even with `network_mode: host` the container only sees the
VM's addresses (`192.168.65.x`), never the Mac's LAN IP, so WebRTC finds no
path (the offer is answered, then the browser times out after 20 s).

Keep the repo out of `~/Downloads`, `~/Documents` and `~/Desktop` (e.g. in
`~/Developer`) : macOS protects those folders, and a node started by launchd
gets `Operation not permitted` there while the same command works in
Terminal. From this repo, in the shell where `node` is the one to use :

```sh
docker compose -p debrid-remote -f deploy/compose.yml down
npm --prefix server ci
wtf debrid agent install
```

`install` writes a LaunchAgent
(`~/Library/LaunchAgents/boo.ranchchoco.debrid-remote.plist`) that starts
the server at login and restarts it if it dies, logging to
`~/Library/Logs/debrid-remote.log`. It names this shell's node binary by its
absolute path and holds no secret : the server still reads `server/.env`.
Run it again after moving the repo ; it is idempotent. With the Command Line
Tools (`xcode-select -p` ; else `xcode-select --install`), it also compiles a
menu-bar icon (`deploy/macos/DebridRemoteBar.swift`, into
`~/Library/Application Support/debrid-remote/`) started by a second agent
(`boo.ranchchoco.debrid-remote.menubar`). The `down` matters if
the container was ever started : with two servers on the relay, the webapp
connects to whichever one the relay lists first.

If the macOS firewall is on, the node binary must be allowed explicitly — it
is per binary, and `install` prints these two lines with the exact path when
it is not allowed yet :

```sh
NODE_BIN="$(node -p process.execPath)"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$NODE_BIN"
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp "$NODE_BIN"
```

Day to day :

```sh
wtf debrid agent status
wtf debrid agent logs -f
wtf debrid agent stop
wtf debrid agent start
```

- `status` reads launchd : `running pid …`, `crashing` (loaded, not running :
  see the log), `stopped` or `absent`. Running means the process is up, not
  that a browser can reach it (VPN, firewall : § Troubleshooting).
- The menu-bar icon shows the same state every 3 s : filled bolt = running,
  outlined bolt = stopped, triangle = crashing, question mark = not
  installed. Its menu has **Démarrer**, **Arrêter** (the same `start` /
  `stop`) and **Ouvrir le journal**. **Quitter l'icône** quits the icon only,
  until the next login or `install`.
- `stop` unloads the agent : it stays stopped until `start` or the next login.
- **Before a foreground debug run** (`wtf debrid start`, `DEBUG='werift-ice*'
  npm --prefix server start`), `wtf debrid agent stop` — otherwise the second
  server fails with `EADDRINUSE` on `:8098`. `start` again afterwards.
- **After a node upgrade** (`nvm install`, `brew upgrade node`), run
  `wtf debrid agent install` again and allow the new path it prints : the
  plist and the firewall entry both name the old binary.
- **Login, not boot** : a LaunchAgent starts when the user's session opens.
  With auto-login (Users & Groups) that is right after a reboot ; turning
  FileVault on disables auto-login, and the server then waits for someone to
  log in.
- The log is not rotated (one line per connection). To clear it : `stop`,
  delete the file, `start`.
- `wtf debrid agent uninstall` removes the agent ; `server/.env` and the log
  stay.

**Linux — the container.** `deploy/compose.yml` uses `network_mode: host`,
which on Linux is the machine's real network, and `restart: unless-stopped`,
which brings it back after a crash and at boot when the Docker service is
enabled (`systemctl enable docker`) :

```sh
wtf debrid up
wtf debrid logs
```

Expected in the output (or the logs) :

```
tokens: phone, default
http: listening on :8098
relay: connected, peerId=srv-…
```

`tokens:` names the access tokens (§ 7) — `none yet` is fine, the first
`wtf debrid token add` applies live. The peer id is random at each start ;
the webapp finds the server by its name on the relay.

A repeating `relay: error … retry in …` means `RELAY_URL` is wrong or step 4
is not reachable yet. The server keeps retrying with backoff (up to 30 s),
so it reconnects on its own once the relay is up.

Either way the server listens on `:8098` (HTTP) and on UDP `ICE_PORTS`
(WebRTC) on the machine itself ; if it has a firewall (ufw, the macOS
firewall…), allow both. A bridge network is not an option : it hides the
machine's addresses from WebRTC the same way the Docker Desktop VM does.

## 6. Home — frpc

The server is not on frpc's Docker network (it runs natively on macOS, or
with `network_mode: host` on Linux), so frpc reaches it on the machine
itself. `localIP` in the snippet is `host.docker.internal`, which Docker
Desktop resolves to the Mac. On Linux, use the gateway of frpc's network
instead (`docker inspect frpc`, field `Gateway`, e.g. `172.18.0.1`) or the
machine's LAN IP. First check that frpc can reach it :

```sh
docker exec frpc wget -qS -O /dev/null http://host.docker.internal:8098/s/x/y
```

`HTTP/1.1 403 Forbidden` : reachable (the bogus token is rejected).
`Connection refused` or a timeout : the server is not running, or a firewall
blocks `8098`.

Then, from the frpc compose directory, back up `frpc.toml`, append
[deploy/frpc-proxy.toml](deploy/frpc-proxy.toml), and restart frpc (`up -d`
would not reload a bind-mounted config) :

```sh
cp frpc.toml frpc.toml.bak
cat <path-to-this-repo>/deploy/frpc-proxy.toml >> frpc.toml
docker compose restart frpc
docker compose logs --tail 20 frpc
```

Every proxy must log `start proxy success`. frp renders `frpc.toml` as a Go
template, comments included : a stray double brace stops frpc with
`template: frp:<line>: …` and takes **every** tunnel down. Roll back with
`cp frpc.toml.bak frpc.toml` and restart.

Check :

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://debrid.du.ranchchoco.boo/s/x/y
```

`403` means the request crossed Traefik → frps:8097 → frpc → the host's
`:8098`, and the home server rejected the bogus token. A `502`
or `404` means frpc has not loaded the proxy : look for `start proxy
success` on `debrid-remote` in the frpc logs.

## 7. Tokens — who can connect

Each device or person gets its own token, revocable alone. The server
accepts any token of the current set : the ones in
`server/data/tokens.json` (gitignored, mode 0600) plus `APP_TOKEN` from
`.env` when set, listed as `default`. On the home machine :

```sh
wtf debrid token add phone-kevin
wtf debrid token list
wtf debrid token revoke phone-kevin
```

- `add <name>` creates a token and prints its **setup link**,
  `https://meitogi.github.io/minidebrid/#t=<token>` (`&r=<relay>` is added
  when `RELAY_URL` is not the webapp's default ; `WEBAPP_URL` in `.env`
  changes the base). Opened on a device, it saves the token, removes it from
  the address bar and connects. Names : letters, digits, `.`, `_`, `-`.
- `list` prints every token's name, creation date and setup link, `default`
  included. **Each link is the credential itself** : send it over a channel
  you trust, and do not run `list` where someone can read the screen.
- `revoke <name>` removes it from the store. A running server notices within
  a second (it watches `server/data/`, no restart) : that device's open
  sessions close, and its next connection gets « Jeton refusé par le
  serveur : inconnu ou révoqué. ». Other devices are untouched, and so are
  the stream links already issued : they are signed with `STREAM_SECRET`,
  not with a token, and stay valid until
  they expire (7 days).
- `default` (`APP_TOKEN`) cannot be revoked by the CLI : remove it from
  `.env` and restart the server (`wtf debrid agent stop` / `start` on
  macOS). The device set up before tokens existed uses it.
- A hand edit of `tokens.json` that breaks the file is ignored : the server
  keeps the previous set and logs `tokens: … ignored (<reason>)`.
- Anyone can open a copy of a link until its token is revoked : a link
  cannot be made single-use from the webapp alone.

**Linux container** : `deploy/compose.yml` mounts the directory
`server/data` on `/app/data` (a directory, so the CLI's write-then-rename
reaches the container). Run the CLI inside the container, as the image's
`node` user (uid 1000) :

```sh
docker exec debrid-remote node bin/token.js add phone-kevin
docker exec debrid-remote node bin/token.js list
docker exec debrid-remote node bin/token.js revoke phone-kevin
```

`server/data` must be writable by uid 1000 : it is when the repo was cloned
by the first user of the machine ; otherwise `sudo chown 1000 server/data`
(the CLI says `cannot write … (EACCES)`).

## 8. Update — deploying a new version

Two halves, each only when its directory changed : the webapp (`web/`) is
redeployed by GitHub on push, the server (`server/`) by hand on the home
machine. A version that changes both (e.g. « Regénérer le lien ») needs both ;
the order does not matter, an old server ignores what it does not know.

**Webapp** — from the clone you commit in :

```sh
git push origin main
gh run watch
```

The **pages** run tests, builds and publishes. Then reload the webapp on each
device ; GitHub's cache can serve the previous version up to 10 minutes, a
forced reload (Cmd-Shift-R) skips it.

**Server, macOS** — on the home machine, in the repo (`~/Developer/minidebrid`) :

```sh
git pull
git diff --stat HEAD@{1} -- server
npm --prefix server ci
wtf debrid agent stop
wtf debrid agent start
wtf debrid agent logs -t 5
```

The second line lists what changed under `server/` : empty → stop there, no
restart needed. `npm ci` is only needed when `server/package-lock.json` is in
that list, harmless otherwise. Expected in the log : `tokens: …`,
`http: listening on :8098`, `relay: connected, peerId=srv-…`. A device
connected during the restart sees « Connexion au serveur perdue » :
**Se connecter** again.

**Server, Linux container** :

```sh
git pull
wtf debrid up
wtf debrid logs -t 5
```

`up` rebuilds the image and recreates the container.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Container restarting | a required variable is missing | `wtf debrid logs` names it |
| macOS : `agent status` says `crashing`, the log repeats `… missing — fill it in .env` | a required variable is missing ; launchd relaunches the server every 10 s | fill `server/.env` ; the next relaunch picks it up |
| macOS : `crashing`, the log says `Operation not permitted` | the repo is in a folder macOS protects (`~/Downloads`, `~/Documents`, `~/Desktop`) | move it (e.g. `~/Developer`), then `wtf debrid agent install` from the new place |
| macOS : `crashing`, the log says `EADDRINUSE` ; or `install` says something already listens | a foreground server (`wtf debrid start`) still holds `:8098` | stop it (Ctrl-C ; `lsof -nP -iTCP:8098 -sTCP:LISTEN` gives its pid) |
| macOS : webapp times out after a node upgrade, log shows `relay: connected` | the firewall allows the old node path, not the new one | `wtf debrid agent install`, then the two firewall lines it prints ; if that is not it, see the VPN row below |
| macOS : server down after a reboot | nobody logged in yet (no auto-login, e.g. FileVault on) | log in ; the agent starts with the session |
| macOS : no menu-bar icon | quit from its menu, `install` printed `swiftc not found` or `build failed`, or the menu bar is full | `wtf debrid agent install` again (`xcode-select --install` first if asked) ; `~/Library/Logs/debrid-remote-menubar.log` |
| macOS : `install` prints `build failed` after `redefinition of module 'SwiftBridging'` / `this SDK is not supported by the compiler` | a half-updated Command Line Tools install : a stray `module.modulemap` beside `bridging.modulemap` | `sudo mv /Library/Developer/CommandLineTools/usr/include/swift/module.modulemap{,.bak}`, then `install` again ; if it still fails, reinstall the Command Line Tools |
| "Pas de connexion après 20 s" although the server logs `answer sent` | no ICE path : server in Docker on macOS (VM), container not on the host network (Linux), or a firewall dropping UDP `ICE_PORTS` | macOS : run it natively (§ 5) ; Linux : keep `network_mode: host` ; allow UDP `ICE_PORTS` |
| "Pas de connexion après 20 s", server logs `answer sent`, nothing reaches it | a VPN active on the browser's device (or the server's) : the browser's candidates and checks go into the tunnel | turn the VPN off on both ends ; Tailscale alone did not get in the way |
| Stream link answers `502` from Traefik | frpc cannot reach `:8098` on the host | check `localIP` in `frpc.toml` (`host.docker.internal` on macOS, gateway of frpc's network or LAN IP on Linux), that the server runs, and that no firewall blocks `8098` |
| Stream link answers `403` with a real link | link expired (7 days), or `STREAM_SECRET` was set or changed (revoking or adding a token does not affect links) | ask the webapp for a new link |
| Webapp : « Jeton refusé par le serveur » | the token was revoked, mistyped, or `APP_TOKEN` changed | `wtf debrid token list` on the home machine ; send the device a new link (`token add`) |
| Webapp : « Aucun serveur sur le relay » | the home server is stopped or not connected to the relay (the token is not involved) | `wtf debrid agent status` / `logs` ; look for `relay: connected` |
| A new token is refused, the log says `tokens: … ignored (…)` | `tokens.json` was edited by hand and is malformed | fix it as the reason says ; the previous set stays in force meanwhile |
| Stream link answers `502` | Alldebrid refused the unlock | `wtf debrid logs` shows the Alldebrid error |
| A stream link stalls or fails although the server runs | the Alldebrid URL behind it died (the server keeps an unlock 6 h) | webapp : **Voir le lien** then **Regénérer le lien** — a new unlock now, its error shown at once. A server older than this button only signs a new link : update it (§ 8) |

## Commands

| Command | Does |
|---|---|
| `wtf debrid test` | offline unit tests |
| `wtf debrid test-live` | live test with the real key (home connection only) |
| `wtf debrid start` | runs the server outside Docker with `server/.env`, in the foreground (stop the agent first on macOS) |
| `wtf debrid agent install` / `uninstall` | macOS : adds / removes the LaunchAgent (start at login, restart if it dies) and the menu-bar icon |
| `wtf debrid agent start` / `stop` / `status` | macOS : loads / unloads the agent, reads its launchd state |
| `wtf debrid agent logs [-t N] [-f]` | macOS : the agent's log file |
| `wtf debrid token add <name>` | new access token for a device ; prints its setup link (home machine ; Linux container : `docker exec debrid-remote node bin/token.js add <name>`, § 7) |
| `wtf debrid token list` | names, dates and setup links of every token, `default` included (Linux : `docker exec`, § 7) |
| `wtf debrid token revoke <name>` | removes a token ; its open sessions close, live (Linux : `docker exec`, § 7) |
| `wtf debrid up` / `down` | builds and starts / stops the home container |
| `wtf debrid logs [-t N] [-f]` | container logs |
| `wtf signal start` / `stop` / `logs` | the relay, on the VPS |
