// Live test against the real Alldebrid account, through the production modules :
// real werift DataChannel + RPC (auth, ad passthrough, P2P download) and the local stream proxy.
// Reads ALLDEBRID_APIKEY and APP_TOKEN from server/.env ; skipped when either is missing.
// Run it only from the home connection (Alldebrid bans accounts seen from several IPs) :
//   npm run test:live        (or: wtf debrid test-live)
// At most 7 sequential Alldebrid calls ; downloads one small file, never uploads or deletes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RTCPeerConnection } from 'werift';
import { ad, openDownload, unlock } from '../src/alldebrid.js';
import { createHttpServer } from '../src/http.js';
import { createRpc } from '../src/rpc.js';
import { streamUrlBuilder } from '../src/stream-token.js';

try { process.loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '..', '.env')); } catch { /* skip below */ }
const token = process.env.APP_TOKEN;
const missing = ['ALLDEBRID_APIKEY', 'APP_TOKEN'].filter((n) => !process.env[n]);

const FULL_DOWNLOAD_MAX = 20 * 1024 * 1024; // above this, cancel after PARTIAL bytes
const PARTIAL = 2 * 1024 * 1024;
const MAGNETS_SCANNED = 3;

function flatten(entries, prefix = '', out = []) {
  for (const entry of entries) {
    if (entry.e) flatten(entry.e, `${prefix}${entry.n}/`, out);
    else out.push({ path: prefix + entry.n, name: entry.n, size: entry.s ?? 0, link: entry.l });
  }
  return out;
}

function gathered(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    pc.iceGatheringStateChange.subscribe((s) => { if (s === 'complete') resolve(); });
  });
}

// Browser-side stand-in : offerer + RPC client by id, binary frames into `received`.
async function connect(rpcDeps) {
  const offerer = new RTCPeerConnection({ iceServers: [] });
  const answerer = new RTCPeerConnection({ iceServers: [] });
  answerer.onDataChannel.subscribe((channel) => {
    const rpc = createRpc(channel, rpcDeps);
    channel.onMessage.subscribe(rpc.onMessage);
    channel.stateChanged.subscribe((s) => { if (s === 'closed') rpc.dispose(); });
  });
  const channel = offerer.createDataChannel('live');
  const pending = {};
  const client = { received: [], receivedBytes: 0, onBytes: null, terminal: null, onTerminal: null };
  let nextId = 1;
  const authed = new Promise((resolve, reject) => {
    channel.stateChanged.subscribe((s) => {
      if (s === 'open') channel.send(JSON.stringify({ t: 'auth', token }));
      if (s === 'closed') reject(new Error('channel closed : token refused'));
    });
    channel.onMessage.subscribe((data) => {
      if (typeof data !== 'string') {
        client.received.push(data);
        client.receivedBytes += data.length;
        client.onBytes?.();
        return;
      }
      const msg = JSON.parse(data);
      if (msg.t === 'auth') return resolve();
      if (msg.t) { client.terminal = msg; return client.onTerminal?.(msg); }
      const p = pending[msg.id];
      delete pending[msg.id];
      if ('e' in msg) p.reject(new Error(msg.e));
      else p.resolve(msg.r);
    });
  });
  client.call = (m, p) => new Promise((resolve, reject) => {
    const id = String(nextId++);
    pending[id] = { resolve, reject };
    channel.send(JSON.stringify({ id, m, p }));
  });
  client.send = (obj) => channel.send(JSON.stringify(obj));
  client.close = async () => { await offerer.close(); await answerer.close(); };

  await offerer.setLocalDescription(await offerer.createOffer());
  await gathered(offerer);
  await answerer.setRemoteDescription(offerer.localDescription);
  await answerer.setLocalDescription(await answerer.createAnswer());
  await gathered(answerer);
  await offerer.setRemoteDescription(answerer.localDescription);
  await authed;
  return client;
}

test('live : RPC passthrough, P2P download and stream proxy agree byte for byte', {
  skip: missing.length ? `${missing.join(', ')} missing in server/.env` : false,
  timeout: 300_000,
}, async (t) => {
  const proxy = createHttpServer({ secret: token, unlock }).listen(0);
  await new Promise((r) => proxy.once('listening', r));
  const streamUrl = streamUrlBuilder(`http://127.0.0.1:${proxy.address().port}`, token);
  const client = await connect({ token, ad, streamUrl, openDownload });
  try {
    const user = (await client.call('ad', { path: '/v4/user' })).user;
    assert.equal(typeof user?.username, 'string');
    t.diagnostic(`account ${user.username}, premium=${user.isPremium}`);

    const magnets = (await client.call('ad', { path: '/v4.1/magnet/status' })).magnets ?? [];
    const ready = magnets.filter((m) => m.statusCode === 4).slice(0, MAGNETS_SCANNED);
    t.diagnostic(`${magnets.length} magnets, scanning ${ready.length} ready ones`);
    if (!ready.length) return t.skip('no ready magnet on the account');

    let file = null;
    for (const magnet of ready) {
      const data = await client.call('ad', { path: '/v4/magnet/files', fields: { 'id[]': String(magnet.id) } });
      for (const f of flatten(data.magnets?.[0]?.files ?? [])) {
        if (f.size > 0 && (!file || f.size < file.size)) file = f;
      }
    }
    assert.ok(file?.link, 'no file with a link in the scanned magnets');
    t.diagnostic(`file ${file.path} (${file.size} B)`);

    const full = file.size <= FULL_DOWNLOAD_MAX;
    const done = new Promise((resolve) => { client.onTerminal = resolve; });
    if (!full) client.onBytes = () => { if (client.receivedBytes >= PARTIAL) { client.onBytes = null; client.send({ t: 'cancel' }); } };
    const { size } = await client.call('download', { link: file.link, name: file.name });
    assert.equal(size, file.size);
    const terminal = await done;
    const got = Buffer.concat(client.received);
    if (full) {
      assert.deepEqual(terminal, { t: 'end' });
      assert.equal(got.length, size);
    } else {
      assert.deepEqual(terminal, { t: 'cancelled' });
      assert.ok(got.length >= PARTIAL && got.length < size);
    }
    t.diagnostic(`P2P ${full ? 'complete' : 'cancelled'} after ${got.length} B`);

    const { url } = await client.call('streamUrl', { link: file.link, name: file.name });
    const head = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
    assert.equal(head.status, 206);
    assert.match(head.headers.get('content-range'), new RegExp(`^bytes 0-1023/${size}$`));
    assert.deepEqual(Buffer.from(await head.arrayBuffer()), got.subarray(0, 1024));
    if (full && size > 2048) {
      const tail = await fetch(url, { headers: { Range: `bytes=${size - 1024}-${size - 1}` } });
      assert.deepEqual(Buffer.from(await tail.arrayBuffer()), got.subarray(size - 1024));
    }
  } finally {
    await client.close();
    proxy.close();
  }
});
