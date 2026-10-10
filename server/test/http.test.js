import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createHttpServer } from '../src/http.js';
import { signToken } from '../src/stream-token.js';
import { createUnlockCache } from '../src/unlock-cache.js';

const SECRET = 'test-secret';
const LINK = 'https://alldebrid.com/f/locked';
const DATA = randomBytes(1024 * 1024);

let upstream, proxy, base, unlockCalls = 0;

// Local upstream serving DATA with single-range support, like a *.debrid.it host.
function serveUpstream(req, res) {
  const size = DATA.length;
  const head = { 'content-type': 'video/x-matroska', 'accept-ranges': 'bytes', etag: '"v1"' };
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
  let body = DATA;
  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : size - 1;
    body = DATA.subarray(start, end + 1);
    head['content-range'] = `bytes ${start}-${end}/${size}`;
    head['content-length'] = body.length;
    res.writeHead(206, head);
  } else {
    head['content-length'] = size;
    res.writeHead(200, head);
  }
  res.end(req.method === 'HEAD' ? undefined : body);
}

before(async () => {
  upstream = createServer(serveUpstream).listen(0);
  await new Promise((r) => upstream.once('listening', r));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/file.mkv`;
  const unlock = async (link) => {
    unlockCalls++;
    assert.equal(link, LINK);
    return upstreamUrl;
  };
  proxy = createHttpServer({ secret: SECRET, unlocked: createUnlockCache(unlock) }).listen(0);
  await new Promise((r) => proxy.once('listening', r));
  base = `http://127.0.0.1:${proxy.address().port}`;
});

after(() => {
  upstream.close();
  proxy.close();
});

const path = (name = 'x.mkv') => `/s/${signToken(LINK, SECRET).tok}/${encodeURIComponent(name)}`;

test('Range request → 206 with exactly the requested bytes', async () => {
  const res = await fetch(base + path(), { headers: { Range: 'bytes=100-199' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), `bytes 100-199/${DATA.length}`);
  assert.equal(res.headers.get('content-length'), '100');
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
  assert.equal(res.headers.get('etag'), '"v1"');
  assert.match(res.headers.get('content-disposition'), /^inline; filename="x\.mkv"/);
  const body = Buffer.from(await res.arrayBuffer());
  assert.deepEqual(body, DATA.subarray(100, 200));
});

test('successive Range requests (VLC seek) each return their slice', async () => {
  for (const [start, end] of [[0, 15], [524288, 600000], [DATA.length - 10, DATA.length - 1]]) {
    const res = await fetch(base + path(), { headers: { Range: `bytes=${start}-${end}` } });
    assert.equal(res.status, 206);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), DATA.subarray(start, end + 1));
  }
});

test('full GET → 200 with the whole file', async () => {
  const res = await fetch(base + path());
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), DATA);
});

test('HEAD → headers, no body', async () => {
  const res = await fetch(base + path(), { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(DATA.length));
  assert.equal(res.headers.get('content-type'), 'video/x-matroska');
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});

test('bad token → 403, unlock never called', async () => {
  const before = unlockCalls;
  const res = await fetch(`${base}/s/bogus.sig/x.mkv`);
  assert.equal(res.status, 403);
  assert.equal(unlockCalls, before);
});

test('?dl=1 → attachment with the real name', async () => {
  const res = await fetch(base + path('Mon Film (2024).mkv') + '?dl=1', { method: 'HEAD' });
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="Mon Film \(2024\)\.mkv"/);
});

test('any file name is served : no header injection, ASCII fallback, UTF-8 in filename*', async () => {
  const name = 'a"b\r\nX-Injected: 1 l\u2019été 日本.mkv';
  const res = await fetch(base + path(name), { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-injected'), null);
  const cd = res.headers.get('content-disposition');
  assert.equal(cd, `inline; filename="a_b__X-Injected: 1 l__t_ __.mkv"; filename*=UTF-8''${encodeURIComponent(name)}`);
});

test("apostrophe is percent-encoded in filename*", async () => {
  const res = await fetch(base + path("l'été.mkv"), { method: 'HEAD' });
  assert.ok(res.headers.get('content-disposition').endsWith("filename*=UTF-8''l%27%C3%A9t%C3%A9.mkv"));
});

test('unlock is cached per link', async () => {
  const before = unlockCalls;
  await (await fetch(base + path())).arrayBuffer();
  await (await fetch(base + path())).arrayBuffer();
  assert.equal(unlockCalls, before);
});

test('malformed name escape → 400, server keeps serving', async () => {
  const res = await fetch(`${base}/s/${signToken(LINK, SECRET).tok}/%E0%A4%A`);
  assert.equal(res.status, 400);
  assert.equal((await fetch(base + path(), { method: 'HEAD' })).status, 200);
});

test('unknown route → 404', async () => {
  assert.equal((await fetch(`${base}/other`)).status, 404);
});
