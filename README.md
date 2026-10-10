# debrid-remote

Drive Alldebrid from anywhere while every API call and every byte leaves from
one IP, the home machine — Alldebrid bans accounts used from several IPs.

- **`server/`** — Node in Docker at home, sole holder of the Alldebrid key.
  It registers on a WebSocket signaling relay, answers a WebRTC DataChannel
  after a token handshake, passes Alldebrid API calls through, sends files
  over the DataChannel, and serves signed HTTPS stream links (Range-capable,
  for VLC) through the frp + Traefik tunnel.
- **`web/`** — Svelte 5 + Vite webapp on GitHub Pages. Open the setup link
  of a token once (`wtf debrid token add`, GUIDE § 7) ; the webapp finds the
  home server on the relay, connects peer to peer, lists magnets and their
  files, downloads a file P2P to disk or copies a VLC link.

The browser never talks to Alldebrid : the webapp's network traffic is the
relay (signaling only), the DataChannel to the home server, and the stream
links, which the home server proxies.

Server setup, live test, deployment and updates : [GUIDE.md](GUIDE.md) (updates : § 8).

## Run

Tests and builds, from this directory :

```sh
wtf debrid test
npm --prefix web ci
npm --prefix web test
npm --prefix web run build
```

The first runs the server's offline suite ; the last writes `web/dist/`, with
relative asset paths : the same build works at the root of
<https://minidebrid.du.ranchchoco.boo/> and under
<https://meitogi.github.io/minidebrid/>.

Local webapp against any relay :

```sh
npm --prefix web run dev
```

Open <http://localhost:5173/#setup>, paste a token, keep the
relay `wss://signal.du.ranchchoco.boo` (or a local `ws://…`). Without a
saved token and without `#setup` the page redirects to GitHub (below).

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
<https://meitogi.github.io/minidebrid/>, or at its custom domain once set
(below). Pages on a private repository
needs a paid GitHub plan ; the repository holds no secret (`.env` is
gitignored), which is why the command above creates it public.

If that URL shows this README instead of the token form, Pages' source is
still "Deploy from a branch" : a run named *pages build and deployment*
(GitHub's built-in Jekyll build) published the branch over the app. Switch
Settings → Pages → Source to **GitHub Actions**, then Actions → **pages** →
**Run workflow**.

### Custom domain

The webapp's address is <https://minidebrid.du.ranchchoco.boo/>. Once, in
this order, any time — the build works at both addresses, so pushes do not
wait for it :

1. **Cloudflare** — dash.cloudflare.com → the `ranchchoco.boo` zone → **DNS**
   → **Records** → **Add record** :

   | Field | Value |
   |---|---|
   | Type | `CNAME` |
   | Name | `minidebrid.du` |
   | Target | `meitogi.github.io` (no `/minidebrid`) |
   | Proxy status | **off** — grey cloud, « DNS only » |
   | TTL | Auto |

   **Save**. Grey, not orange : GitHub issues the certificate itself and
   must see its own address behind the name.
2. **GitHub** — the `meitogi/minidebrid` repository → **Settings** →
   **Pages** (left column, *Code and automation*) → **Custom domain** :
   type `minidebrid.du.ranchchoco.boo` → **Save**. The line below shows
   « DNS check in progress », then « DNS check successful » (a red
   « improperly configured » : the record of step 1 is missing, orange, or
   not propagated yet — **Check again** after a minute). No `CNAME` file to
   commit : the site is deployed by Actions, the setting is enough.
   Same thing from a shell :
   `gh api -X PUT repos/meitogi/minidebrid/pages -f cname=minidebrid.du.ranchchoco.boo`.
3. **HTTPS** — same page, once the certificate is issued (minutes to an
   hour ; until then the box is greyed out, « Unavailable for your site
   because … not properly configured to support HTTPS ») : tick
   **Enforce HTTPS**. Shell :
   `gh api -X PUT repos/meitogi/minidebrid/pages -F https_enforced=true`.
4. **Check** — <https://minidebrid.du.ranchchoco.boo/#setup> shows the form
   with a valid padlock ; <https://meitogi.github.io/minidebrid/#setup>
   lands on the same page.
5. **Devices** — on every one, open its setup link once more
   (`wtf debrid token list`) : a new address is a new origin, the saved
   token stays with the old one.

GitHub serves a Pages site on one domain : from step 2,
`https://meitogi.github.io/minidebrid/…` redirects there, fragment included,
so links handed out before keep working.

Optional, against another account claiming the name if the `CNAME` ever
outlives the site : your **account** settings (avatar → **Settings**, not
the repository's) → **Pages** → **Add a domain** → `ranchchoco.boo` (covers
its subdomains) → GitHub shows a `TXT` record
(`_github-pages-challenge-meitogi.…` and a value) → add it in Cloudflare as
in step 1 (Type `TXT`, Name and Content as shown) → back on GitHub,
**Verify**.
Without the domain, set `WEBAPP_URL=https://meitogi.github.io/minidebrid/`
in `server/.env` so `wtf debrid token` prints working links.

## Using the webapp

| Step | What you see |
|---|---|
| Setup link | `https://minidebrid.du.ranchchoco.boo/#t=<token>` (from `wtf debrid token add`, optionally `&r=<relay>`) : saves the token (and relay) in this browser, removes it from the address bar and connects. A device that already holds another token asks « Remplacer le jeton enregistré par celui du lien ? » ; **Annuler** keeps the old one. A relay in a link is accepted only as `wss://` (or `ws://` on `localhost` / `127.0.0.1`). |
| Landing | A saved token connects at load, no click ; if that fails the settings form shows the error, and nothing retries by itself. No saved token and no link : the page sends you to <https://github.com/meitogi/minidebrid>. `…/#setup` always shows the form instead. |
| Settings | Token (hidden ; the eye button shows it) + relay URL, kept in this browser's localStorage. **Se connecter**. **Déconnecter** comes back here and stays here. |
| Connection | Progress, then the ICE path : `LAN direct`, `P2P direct (srflx/…)` from outside, or `P2P direct (IPv6/public)` when both ends have a public IPv6 (typical on 4G), `TURN (relay)` never (no TURN server). |
| Magnets | Ready ones first. **Actualiser** re-reads them ; nothing polls Alldebrid in the background (limit 12 req/s, 600/min). The search field filters them by name (case, accents, `.` and `_` ignored ; every word must match). |
| Open magnet | The address becomes `…/#m=<id>` : copy it, paste it on any device holding a token, and that magnet opens after the automatic connection ; the browser's back button returns to the list. A magnet no longer listed or not ready yet → a notice, then the list. |
| Files | Videos get a line above their path : series, `S01E05` (or One Piece's absolute number), and the episode's title when the file name carries one — all read from the file, folder and magnet names, nothing fetched. The search field understands episode numbers : `s2e5`, `S02E05` or `2x05` (that episode), `e5` / `ep 5` (episode 5 of every season), `s2` / `saison 2` (a season), a bare number (an episode, an absolute number, or text), and any other word in the path, series or episode title. Side files (`.nfo .txt .sfv .md5 .url .jpg .jpeg .png` and sample videos) are hidden ; **Afficher tous les fichiers (n masqué(s))** shows them, remembered in this browser ; subtitles always show. Real names from Alldebrid. **Télécharger** brings the bytes over the DataChannel from the home server, never through the VPS, with a progress bar and **Annuler** ; the way it reaches the disk depends on the browser (table below, named under the magnet's title). In a browser with no P2P mode, **Télécharger** instead starts the browser's own download of the stream link with `?dl=1`, through the tunnel. **Copier le lien** copies a stream link valid 7 days (VLC, any player) and confirms with « Copié ✓ » ; **Voir le lien** shows it in a read-only field that a click selects whole (its expiry behind the « i » beside it : hover, or tap on a phone), next to a share icon linking to it (right click → copy the address) ; once shown, the button becomes **Regénérer le lien** : a new signed link, and the home server unlocks the file again on Alldebrid, so a dead Alldebrid link is replaced (« Nouveau lien ✓ »). Each file has a checkbox : **Tout cocher** checks the files the search and the side-file toggle show (search `s2`, then check a whole season), **Tout décocher** clears every check ; **Copier les liens** copies the checked files' links, one per line in the files' order (« Copié ✓ (n) »), and **Voir les liens** lists them in a field to select by hand — shown on its own when the browser refuses the copy. |

P2P download mode per browser — first one that works, chosen per file :

| Browser | Mode | What you see |
|---|---|---|
| Chrome, Edge (desktop) | download manager (service worker) | the browser's Downloads list with its own progress ; cancelling there cancels the transfer |
| Brave (desktop) | download manager ; with `brave://flags/#file-system-access-api` on, still the download manager | same as Chrome |
| Chrome Android (132+) | save picker (`showSaveFilePicker`) | you choose where the file goes ; **Annuler** leaves no file behind |
| Firefox (desktop, Android) | download manager | Downloads list ; in a private window too |
| Safari macOS, iOS / iPadOS (15.4+, not 18.2–18.3) | download manager | Downloads list ; needs the file size, else the next row |
| Safari / iOS 26+ without a known size | temporary copy (origin private file system), then download | progress here, « préparation du téléchargement », then the file appears ; the copy is deleted later (needs as much free browser storage as the file) |
| Anything else : Safari 15.4–25 without a known size, iOS 18.2–18.3, Safari before 15.4, a private window with neither service worker nor storage | `?dl=1` link | **Télécharger**, through the tunnel |

Service worker mode needs the tab to stay open (and in the foreground on a phone) until the
end : the page is what feeds the download. A download paused in the browser for more than a few
seconds is cancelled (the home server cannot be paused).

« Aucun serveur sur le relay » means the home server is down or not
connected to the relay ; « Jeton refusé par le serveur » means the server
was reached and does not know the token (mistyped, or revoked).

The setup link **is** the credential : whoever reads the message holds the
token until it is revoked. The token sits after `#`, which browsers never
send to GitHub's servers, and the page removes it from the address bar ; the
browser's history (and its sync) can still hold the full link. The redirect only
keeps casual visitors out of the form — the app's code is public and
`#setup` opens it ; the server's token check is the only gate.

## Where each command runs

| | Runs on | Why |
|---|---|---|
| `wtf debrid test`, `npm --prefix web ci / test / run build / run dev` | **devcontainer** | Offline. `web/node_modules` holds per-platform binaries (Rolldown, Lightning CSS) for the platform that ran `npm ci` : run every `web/` npm command on the same side, here. CI installs its own. |
| `wtf debrid test-live` | devcontainer or host, **home connection only** | Calls Alldebrid with the real key. |
| `wtf debrid agent …` / `wtf debrid start` (macOS, native under launchd / foreground) or `wtf debrid up` / `logs` (Linux, container), frpc paste | **host**, home machine | Must share the home IP ; frpc lives outside this repo. On macOS, Docker Desktop's VM hides the Mac's addresses from WebRTC (GUIDE § 5), and launchd only exists there. |
| `wtf debrid token add / list / revoke` | **host**, home machine (Linux : `docker exec`, GUIDE § 7) | Writes the token store next to the server ; `add` and `list` print live setup links. |
| `wtf signal start` / `logs` (relay) | **host**, VPS checkout of `server-kevledev-mini` | VPS infra. |
| `gh repo create`, `git push`, Pages enablement | **host** | Needs GitHub credentials. |
| HTTPS checks (`curl https://…du.ranchchoco.boo`) | **host** | The devcontainer firewall blocks the VPS. |
