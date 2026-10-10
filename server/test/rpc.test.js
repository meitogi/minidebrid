import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRpc } from '../src/rpc.js';

const TOKEN = 'app-token';

// Channel double limited to the werift RTCDataChannel surface the server uses :
// send, readyState, bufferedAmount, bufferedAmountLowThreshold, bufferedAmountLow.subscribe, close.
// `sent` is the test's own record, not a channel method. send throws above 64 KB like werift
// (the remote's max-message-size). bufferedAmount grows on send and drains
// asynchronously, firing bufferedAmountLow like the real channel, so backpressure is exercised.
function makeChannel() {
  let subs = [];
  const channel = {
    readyState: 'open',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    sent: [],
    send(data) {
      const size = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
      if (size > 65536) throw new Error(`max-message-size exceeded: ${size} > 65536`);
      channel.sent.push(data);
      if (typeof data !== 'string') channel.bufferedAmount += data.length;
      if (channel.bufferedAmount > 1024 * 1024) {
        setImmediate(() => {
          channel.bufferedAmount = 0;
          for (const fn of subs.slice()) fn();
        });
      }
    },
    close() { channel.readyState = 'closed'; },
    bufferedAmountLow: {
      subscribe(fn) {
        subs.push(fn);
        return { unSubscribe() { subs = subs.filter((f) => f !== fn); } };
      },
    },
  };
  return channel;
}

const json = (channel) => channel.sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d));
const tick = () => new Promise((r) => setImmediate(r));

// ReadableStream yielding `buf` in irregular pieces, like a fetch body.
function streamOf(buf) {
  let off = 0;
  return new ReadableStream({
    pull(ctrl) {
      if (off >= buf.length) return ctrl.close();
      const n = 1000 + Math.floor(Math.random() * 70000);
      ctrl.enqueue(new Uint8Array(buf.subarray(off, off + n)));
      off += n;
    },
  });
}

function setup(overrides = {}) {
  const channel = makeChannel();
  const calls = { ad: [] };
  const rpc = createRpc(channel, {
    authenticate: (token) => (token === TOKEN ? 'default' : null),
    ad: async (path, fields) => { calls.ad.push([path, fields]); return { ok: path }; },
    streamUrl: async (link, name) => ({ url: `https://h/s/t/${name}`, expires: 42 }),
    openDownload: async () => { throw new Error('not wired'); },
    authTimeoutMs: 50,
    ...overrides,
  });
  return { channel, rpc, calls };
}

test('wrong token → channel closed, requests ignored', async () => {
  const { channel, rpc, calls } = setup();
  rpc.onMessage(JSON.stringify({ t: 'auth', token: 'nope' }));
  assert.equal(channel.readyState, 'closed');
  rpc.onMessage(JSON.stringify({ id: 1, m: 'ad', p: { path: '/v4/user' } }));
  await tick();
  assert.equal(calls.ad.length, 0);
  rpc.dispose();
});

test('no auth within the timeout → channel closed', async () => {
  const { channel, rpc } = setup();
  rpc.onMessage(JSON.stringify({ id: 1, m: 'ad', p: { path: '/v4/user' } }));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(channel.readyState, 'closed');
  assert.deepEqual(channel.sent, []);
  rpc.dispose();
});

test('right token → ack, then {id, r} with the passthrough payload', async () => {
  const { channel, rpc, calls } = setup();
  rpc.onMessage(JSON.stringify({ t: 'auth', token: TOKEN }));
  rpc.onMessage(JSON.stringify({ id: 7, m: 'ad', p: { path: '/v4/magnet/files', fields: { 'id[]': '12' } } }));
  await tick();
  assert.equal(channel.readyState, 'open');
  assert.deepEqual(calls.ad, [['/v4/magnet/files', { 'id[]': '12' }]]);
  assert.deepEqual(json(channel), [{ t: 'auth', ok: true }, { id: 7, r: { ok: '/v4/magnet/files' } }]);
  rpc.dispose();
});

test('ad path outside /v4 → {id, e}, ad never called', async () => {
  const { channel, rpc, calls } = setup();
  rpc.onMessage(JSON.stringify({ t: 'auth', token: TOKEN }));
  for (const path of ['/v3/user', 'https://evil/v4/x', '/v4', '/v4.1x/a']) {
    rpc.onMessage(JSON.stringify({ id: path, m: 'ad', p: { path } }));
  }
  await tick();
  assert.equal(calls.ad.length, 0);
  const errors = json(channel).filter((m) => m.e);
  assert.equal(errors.length, 4);
  rpc.dispose();
});

// Joins {frag} frames back into messages, as the webapp must.
function reassemble(strings) {
  const out = [];
  let parts = [];
  for (const s of strings) {
    const msg = JSON.parse(s);
    if (msg.frag === undefined) { out.push(msg); continue; }
    parts.push(msg.frag);
    if (msg.last) { out.push(JSON.parse(parts.join(''))); parts = []; }
  }
  return out;
}

test('reply above 64 KB → {frag} frames under the limit, reassembled payload intact', async () => {
  const magnets = [];
  for (let i = 0; i < 3000; i++) magnets.push({ id: i, filename: `Film "${i}" l’été 日本 😀\n`, size: i * 1e9 });
  const { channel, rpc } = setup({ ad: async () => ({ magnets }) });
  rpc.onMessage(JSON.stringify({ t: 'auth', token: TOKEN }));
  rpc.onMessage(JSON.stringify({ id: 5, m: 'ad', p: { path: '/v4.1/magnet/status' } }));
  await tick();
  const strings = channel.sent.filter((d) => typeof d === 'string');
  assert.ok(strings.length > 3, 'expected fragmentation');
  assert.ok(strings.every((s) => Buffer.byteLength(s) <= 65536));
  assert.deepEqual(reassemble(strings), [{ t: 'auth', ok: true }, { id: 5, r: { magnets } }]);
  rpc.dispose();
});

test('streamUrl → {id, r: {url, expires}}', async () => {
  const { channel, rpc } = setup();
  rpc.onMessage(JSON.stringify({ t: 'auth', token: TOKEN }));
  rpc.onMessage(JSON.stringify({ id: 3, m: 'streamUrl', p: { link: 'L', name: 'a.mkv' } }));
  await tick();
  assert.deepEqual(json(channel)[1], { id: 3, r: { url: 'https://h/s/t/a.mkv', expires: 42 } });
  rpc.dispose();
});

test('streamUrl with fresh → a new unlock first ; without → none', async () => {
  const refreshed = [];
  const { channel, rpc } = setup({ refreshUnlock: async (link) => { refreshed.push(link); } });
  rpc.onMessage(JSON.stringify({ t: 'auth', token: TOKEN }));
  rpc.onMessage(JSON.stringify({ id: 3, m: 'streamUrl', p: { link: 'L', name: 'a.mkv' } }));
  rpc.onMessage(JSON.stringify({ id: 4, m: 'streamUrl', p: { link: 'L', name: 'a.mkv', fresh: true } }));
  await tick();
  assert.deepEqual(refreshed, ['L']);
  assert.deepEqual(json(channel)[2], { id: 4, r: { url: 'https://h/s/t/a.mkv', expires: 42 } });
  rpc.dispose();
});

test('streamUrl with fresh : an unlock error is the reply', async () => {
  const { channel, rpc } = setup({ refreshUnlock: async () => { throw new Error('AllDebrid /v4/link/unlock: LINK_DOWN — down'); } });
  rpc.onMessage(JSON.stringify({ t: 'auth', token: TOKEN }));
  rpc.onMessage(JSON.stringify({ id: 5, m: 'streamUrl', p: { link: 'L', name: 'a.mkv', fresh: true } }));
  await tick();
  assert.deepEqual(json(channel)[1], { id: 5, e: 'AllDebrid /v4/link/unlock: LINK_DOWN — down' });
  rpc.dispose();
});

test('download → {size}, chunks equal to the source byte for byte, then end', async () => {
  const source = randomBytes(3 * 1024 * 1024 + 123);
  let gotLink;
  const { channel, rpc } = setup({
    openDownload: async (link) => { gotLink = link; return { size: source.length, body: streamOf(source) }; },
  });
  rpc.onMessage(JSON.stringify({ t: 'auth', token: TOKEN }));
  rpc.onMessage(JSON.stringify({ id: 9, m: 'download', p: { link: 'https://alldebrid.com/f/x', name: 'x' } }));
  while (json(channel).at(-1)?.t !== 'end') await tick();

  assert.equal(gotLink, 'https://alldebrid.com/f/x');
  const strings = json(channel);
  assert.deepEqual(strings, [{ t: 'auth', ok: true }, { id: 9, r: { size: source.length } }, { t: 'end' }]);
  const firstBinary = channel.sent.findIndex((d) => typeof d !== 'string');
  assert.ok(firstBinary > channel.sent.indexOf(JSON.stringify({ id: 9, r: { size: source.length } })));
  const chunks = channel.sent.filter((d) => typeof d !== 'string');
  assert.ok(chunks.every((c) => Buffer.isBuffer(c) && c.length <= 16 * 1024));
  assert.deepEqual(Buffer.concat(chunks), source);
  rpc.dispose();
});

test('second download while one runs → {id, e} ; cancel → cancelled', async () => {
  let release;
  const body = new ReadableStream({
    start(ctrl) { ctrl.enqueue(new Uint8Array(1000)); },
    pull() { return new Promise((r) => { release = r; }); },
  });
  const { channel, rpc } = setup({ openDownload: async () => ({ size: 5000, body }) });
  rpc.onMessage(JSON.stringify({ t: 'auth', token: TOKEN }));
  rpc.onMessage(JSON.stringify({ id: 1, m: 'download', p: { link: 'a' } }));
  await tick();
  rpc.onMessage(JSON.stringify({ id: 2, m: 'download', p: { link: 'b' } }));
  rpc.onMessage(JSON.stringify({ t: 'cancel' }));
  release?.();
  while (json(channel).at(-1)?.t !== 'cancelled') await tick();
  const strings = json(channel);
  assert.ok(strings.some((m) => m.id === 2 && m.e));
  assert.ok(!strings.some((m) => m.t === 'end'));
  rpc.dispose();
});
