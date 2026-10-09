# debrid-remote

Drive Alldebrid from anywhere while every API call and every byte leaves from
one IP, the home machine — Alldebrid bans accounts used from several IPs.

- **`server/`** — Node in Docker at home, sole holder of the Alldebrid key.
  It registers on a WebSocket signaling relay, answers a WebRTC DataChannel
  after a token handshake, passes Alldebrid API calls through, sends files
  over the DataChannel, and serves signed HTTPS stream links (Range-capable,
  for VLC) through the frp + Traefik tunnel.
- **`web/`** — Svelte 5 + Vite webapp on GitHub Pages. Paste the server's
  `APP_TOKEN` once ; the webapp derives the server's relay id from it,
  connects peer to peer, lists magnets and their files, downloads a file
  P2P to disk or copies a VLC link.

The browser never talks to Alldebrid : the webapp's network traffic is the
relay (signaling only), the DataChannel to the home server, and the stream
links, which the home server proxies.

Server setup, live test and deployment : [GUIDE.md](GUIDE.md).

## Run

Tests and builds, from this directory :

```sh
wtf debrid test
npm --prefix web ci
npm --prefix web test
npm --prefix web run build
```

The first runs the server's offline suite ; the last writes `web/dist/`, with
every asset under `/minidebrid/` (the Pages project path = the GitHub repo
name ; rename one, change `base` in `web/vite.config.js` too).

Local webapp against any relay :

```sh
npm --prefix web run dev
```

Open <http://localhost:5173/minidebrid/>, paste the token, keep the relay
`wss://signal.du.ranchchoco.boo` (or a local `ws://…`).

Publish the webapp, once, on the host :

```sh
gh repo create minidebrid --public --source . --remote origin
gh api -X POST repos/{owner}/{repo}/pages -f build_type=workflow
git push -u origin main
```

The second line sets Pages' source to GitHub Actions (the same switch is in
Settings → Pages) before the first push triggers a deploy. Each push to
`main` touching `web/` runs
[`.github/workflows/pages.yml`](.github/workflows/pages.yml) (`npm ci`, tests,
build, deploy) and the app is served at
<https://meitogi.github.io/minidebrid/>. Pages on a private repository
needs a paid GitHub plan ; the repository holds no secret (`.env` is
gitignored), which is why the command above creates it public.

If that URL shows this README instead of the token form, Pages' source is
still "Deploy from a branch" : a run named *pages build and deployment*
(GitHub's built-in Jekyll build) published the branch over the app. Switch
Settings → Pages → Source to **GitHub Actions**, then Actions → **pages** →
**Run workflow**.

## Using the webapp

| Step | What you see |
|---|---|
| Settings | Token + relay URL, kept in this browser's localStorage. **Se connecter**. |
| Connection | Progress, then the ICE path : `LAN direct`, `P2P direct (srflx/…)` from outside, `TURN (relay)` never (no TURN server). |
| Magnets | Ready ones first. **Actualiser** re-reads them ; nothing polls Alldebrid in the background (limit 12 req/s, 600/min). |
| Files | Real names from Alldebrid. **Télécharger (P2P)** streams the file to disk through the DataChannel (Chromium : `showSaveFilePicker`) with a progress bar and **Annuler**. Firefox and Safari get **Télécharger (lien direct)** instead : the stream link with `?dl=1`. **Lien VLC** copies a stream link valid 7 days. |

"Aucun serveur pour ce jeton" means no server is registered on the relay
under the id derived from that token : the token is wrong, or the home
server is down or not connected to the relay.

## Where each command runs

| | Runs on | Why |
|---|---|---|
| `wtf debrid test`, `npm --prefix web ci / test / run build / run dev` | **devcontainer** | Offline. `web/node_modules` holds per-platform binaries (Rolldown, Lightning CSS) for the platform that ran `npm ci` : run every `web/` npm command on the same side, here. CI installs its own. |
| `wtf debrid test-live` | devcontainer or host, **home connection only** | Calls Alldebrid with the real key. |
| `wtf debrid up` / `logs` (server container), frpc paste | **host**, home machine | Must share the home IP ; frpc lives outside this repo. |
| `wtf signal start` / `logs` (relay) | **host**, VPS checkout of `server-kevledev-mini` | VPS infra. |
| `gh repo create`, `git push`, Pages enablement | **host** | Needs GitHub credentials. |
| HTTPS checks (`curl https://…du.ranchchoco.boo`) | **host** | The devcontainer firewall blocks the VPS. |
