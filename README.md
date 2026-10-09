# debrid-remote

Drive Alldebrid from anywhere while every API call and every byte leaves from
one IP, the home machine. A Node server in Docker at home (sole holder of the
Alldebrid key) answers a WebRTC DataChannel after a token handshake and serves
signed HTTPS stream links through the frp + Traefik tunnel. A Svelte webapp on
GitHub Pages drives it from one pasted token.

Setup, live test and deployment : [GUIDE.md](GUIDE.md). The full README
comes with the webapp.
