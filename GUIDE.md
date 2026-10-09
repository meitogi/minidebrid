# Setup guide

From an empty `.env` to a stream link answering through the tunnel. The
webapp is not covered yet ; this guide stops at the server, the relay and
the stream router.

## Where each command runs

| Step | Where | Why |
|---|---|---|
| Unit tests (`wtf debrid test`) | devcontainer or host | offline |
| Live test (`wtf debrid test-live`) | devcontainer or host, **home connection only** | calls Alldebrid with the real key |
| DNS records | Cloudflare dashboard | — |
| Relay + router (`wtf signal …`) | VPS, `server-kevledev-mini` checkout | VPS infra |
| Server container (`wtf debrid up`) | home machine | must share the home IP |
| frpc proxy | home machine, frpc directory | outside both repos |
| HTTPS checks (`curl`) | host | the devcontainer firewall blocks the VPS |

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
| `APP_TOKEN` | the `openssl` output ; the one string you will paste into the webapp |
| `PUBLIC_URL` | `https://debrid.du.ranchchoco.boo` |
| `RELAY_URL` | `wss://signal.du.ranchchoco.boo` |
| `HTTP_PORT` | `8098` (frpc's `localPort`) |
| `ICE_PORTS` | `50000-50019` (must match `deploy/compose.yml`) |

`server/.env` is gitignored and kept out of the Docker image.

## 2. Test against the real account

```sh
wtf debrid test
wtf debrid test-live
```

The first is offline. The second reads the key and token from
`server/.env` and, in at most 7 Alldebrid calls :

- checks the account, lists the magnets, reads the files of up to 3 ready
  ones ;
- downloads the smallest file over a real WebRTC DataChannel (whole file up
  to 20 MB, otherwise cancelled after 2 MB) ;
- fetches the same file through the stream proxy with `Range` and checks
  the first and last KB match the P2P bytes.

It never uploads, deletes or restarts anything. Without `server/.env` it is
reported as skipped, with the missing variable names.

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

## 5. Home — the server container

From this repo on the home machine :

```sh
wtf debrid up
wtf debrid logs
```

Expected in the logs :

```
http: listening on :8098
relay: connected, peerId=srv-…
```

A repeating `relay: error … retry in …` means `RELAY_URL` is wrong or step 4
is not reachable yet. The server keeps retrying with backoff (up to 30 s),
so it reconnects on its own once the relay is up.

The container joins the existing external `web` network (Jellyfin's) and
publishes UDP `50000-50019` for WebRTC.

## 6. Home — frpc

Append [deploy/frpc-proxy.toml](deploy/frpc-proxy.toml) to the home
`frpc.toml`, then from the frpc compose directory :

```sh
docker compose up -d frpc
```

Check :

```sh
curl -sS -o /dev/null -w '%{http_code}\n' https://debrid.du.ranchchoco.boo/s/x/y
```

`403` means the request crossed Traefik → frps:8097 → frpc →
`debrid-remote:8098`, and the home server rejected the bogus token. A `502`
or `404` means frpc has not loaded the proxy : look for `start proxy
success` on `debrid-remote` in the frpc logs.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Container restarting | a required variable is missing | `wtf debrid logs` names it |
| From 4G the connection stays on "connecting" | Docker's NAT breaks the ICE mapping | in `deploy/compose.yml`, replace `ports` + `networks` with `network_mode: host`, and set frpc's `localIP` to the machine's LAN IP |
| Stream link answers `403` with a real link | token expired (7 days) or `APP_TOKEN` changed | ask the webapp for a new link |
| Stream link answers `502` | Alldebrid refused the unlock | `wtf debrid logs` shows the Alldebrid error |

## Commands

| Command | Does |
|---|---|
| `wtf debrid test` | offline unit tests |
| `wtf debrid test-live` | live test with the real key (home connection only) |
| `wtf debrid start` | runs the server outside Docker with `server/.env` |
| `wtf debrid up` / `down` | builds and starts / stops the home container |
| `wtf debrid logs [-t N] [-f]` | container logs |
| `wtf signal start` / `stop` / `logs` | the relay, on the VPS |
