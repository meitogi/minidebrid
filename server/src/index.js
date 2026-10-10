// debrid-remote server : stream link HTTP server + WebRTC peer, sole holder of the Alldebrid key.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccess } from './access.js';
import { ad, openDownload, unlock } from './alldebrid.js';
import { missingEnv, streamSecret } from './config.js';
import { createHttpServer } from './http.js';
import { createUnlockCache } from './unlock-cache.js';
import { parsePortRange, startPeer } from './peer.js';
import { serveChannel } from './rpc.js';
import { streamUrlBuilder } from './stream-token.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(join(ROOT, '.env')); } catch { /* env comes from the container */ }

const env = process.env;
for (const name of missingEnv(env)) {
  console.error(`${name} missing — fill it in .env (see .env.example)`);
  process.exitCode = 1;
}
if (process.exitCode) process.exit();

const secret = streamSecret(env);
const httpPort = Number(env.HTTP_PORT) || 8098;
const streamUrl = streamUrlBuilder(env.PUBLIC_URL, secret);
const unlocked = createUnlockCache(unlock);
const access = createAccess({ file: env.TOKENS_FILE || join(ROOT, 'data', 'tokens.json'), appToken: env.APP_TOKEN });
const names = [];
for (const name in access.tokens()) names.push(name);
console.log(names.length ? `tokens: ${names.join(', ')}` : 'tokens: none yet — wtf debrid token add <name>');

createHttpServer({ secret, unlocked }).listen(httpPort, () => console.log(`http: listening on :${httpPort}`));

startPeer({
  relayUrl: env.RELAY_URL,
  stun: env.STUN ?? 'stun:stun.l.google.com:19302',
  icePortRange: parsePortRange(env.ICE_PORTS),
  onChannel: (channel) => serveChannel(channel, access, { ad, streamUrl, refreshUnlock: unlocked.refresh, openDownload }),
});
