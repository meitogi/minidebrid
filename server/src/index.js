// debrid-remote server : stream link HTTP server + WebRTC peer, sole holder of the Alldebrid key.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ad, openDownload, unlock } from './alldebrid.js';
import { createHttpServer } from './http.js';
import { parsePortRange, peerIdFromToken, startPeer } from './peer.js';
import { createRpc } from './rpc.js';
import { streamUrlBuilder } from './stream-token.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(join(ROOT, '.env')); } catch { /* env comes from the container */ }

const env = process.env;
for (const name of ['ALLDEBRID_APIKEY', 'APP_TOKEN', 'PUBLIC_URL', 'RELAY_URL']) {
  if (!env[name]) {
    console.error(`${name} missing — fill it in .env (see .env.example)`);
    process.exit(1);
  }
}
const token = env.APP_TOKEN;
const httpPort = Number(env.HTTP_PORT) || 8098;
const streamUrl = streamUrlBuilder(env.PUBLIC_URL, token);

createHttpServer({ secret: token, unlock }).listen(httpPort, () => console.log(`http: listening on :${httpPort}`));

startPeer({
  relayUrl: env.RELAY_URL,
  peerId: peerIdFromToken(token),
  stun: env.STUN ?? 'stun:stun.l.google.com:19302',
  icePortRange: parsePortRange(env.ICE_PORTS),
  onChannel(channel) {
    const rpc = createRpc(channel, { token, ad, streamUrl, openDownload });
    channel.onMessage.subscribe(rpc.onMessage);
    channel.stateChanged.subscribe((s) => { if (s === 'closed') rpc.dispose(); });
  },
});
