import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseMode, contentDisposition, createPump, declaredSize, fitsQuota, mimeType, responseHeaders,
  swBlocker, webkitVersion,
} from '../lib/save-mode.js';

const UA = {
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:157.0) Gecko/20100101 Firefox/157.0',
  firefoxAndroid: 'Mozilla/5.0 (Android 15; Mobile; rv:157.0) Gecko/157.0 Firefox/157.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15',
  iosSafari187: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1',
  iosSafari183: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3 Mobile/15E148 Safari/604.1',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/155.0.0.0 Mobile/15E148 Safari/604.1',
  ipadSafari15: 'Mozilla/5.0 (iPad; CPU OS 15_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.2 Mobile/15E148 Safari/604.1',
};

test('webkitVersion : Safari and every iOS browser, never Blink or Gecko', () => {
  assert.deepEqual(webkitVersion(UA.safariMac), { major: 27, minor: 0 });
  assert.deepEqual(webkitVersion(UA.iosSafari187), { major: 18, minor: 7 });
  assert.deepEqual(webkitVersion(UA.iosChrome), { major: 26, minor: 0 }); // no Version/ : OS x_y
  assert.deepEqual(webkitVersion(UA.ipadSafari15), { major: 15, minor: 2 });
  for (const ua of [UA.chromeMac, UA.edge, UA.chromeAndroid, UA.firefox, UA.firefoxAndroid]) assert.equal(webkitVersion(ua), null, ua);
});

test('swBlocker : WebKit before 15.4, 18.2–18.3, or without a size', () => {
  assert.equal(swBlocker(null, 0), null); // not WebKit : no size needed
  assert.equal(swBlocker({ major: 15, minor: 3 }, 10), 'webkit-old');
  assert.equal(swBlocker({ major: 14, minor: 9 }, 10), 'webkit-old');
  assert.equal(swBlocker({ major: 15, minor: 4 }, 10), null);
  assert.equal(swBlocker({ major: 18, minor: 2 }, 10), 'webkit-18.2');
  assert.equal(swBlocker({ major: 18, minor: 3 }, 10), 'webkit-18.2');
  assert.equal(swBlocker({ major: 18, minor: 4 }, 10), null);
  assert.equal(swBlocker({ major: 27, minor: 0 }, 0), 'webkit-no-size');
});

// One probe per target browser of the support matrix (LOG § 5), as the thin probe builds it.
const probe = (ua, apis) => ({ picker: false, android: /Android/.test(ua), sw: false, opfs: false, webkit: webkitVersion(ua), ...apis });
const GB = 4 * 1024 ** 3;

test('chooseMode : the cascade per browser, mode and reason', () => {
  const cases = [
    ['Chrome desktop', probe(UA.chromeMac, { picker: true, sw: true, opfs: true }), GB, 'sw', 'sw'],
    ['Edge', probe(UA.edge, { picker: true, sw: true, opfs: true }), GB, 'sw', 'sw'],
    ['Chrome desktop, SW registration failed', probe(UA.chromeMac, { picker: true, opfs: true }), GB, 'picker', 'no-sw'],
    ['Brave without the flag', probe(UA.chromeMac, { sw: true, opfs: true }), GB, 'sw', 'sw'],
    ['Brave, SW denied', probe(UA.chromeMac, { opfs: true }), GB, 'opfs', 'no-sw'],
    ['Chrome Android', probe(UA.chromeAndroid, { picker: true, sw: true, opfs: true }), GB, 'picker', 'android'],
    ['Chrome Android < 132', probe(UA.chromeAndroid, { sw: true, opfs: true }), GB, 'sw', 'sw'],
    ['Firefox', probe(UA.firefox, { sw: true, opfs: true }), GB, 'sw', 'sw'],
    ['Firefox private window, SW off', probe(UA.firefox, {}), GB, 'link', 'no-sw,no-opfs'],
    ['Firefox Android', probe(UA.firefoxAndroid, { sw: true, opfs: true }), 0, 'sw', 'sw'],
    ['Safari 27', probe(UA.safariMac, { sw: true, opfs: true }), GB, 'sw', 'sw'],
    ['Safari 27, size unknown', probe(UA.safariMac, { sw: true, opfs: true }), 0, 'opfs', 'webkit-no-size'],
    ['iOS 18.7', probe(UA.iosSafari187, { sw: true, opfs: true }), GB, 'sw', 'sw'],
    ['iOS 18.3', probe(UA.iosSafari183, { sw: true, opfs: true }), GB, 'opfs', 'webkit-18.2'],
    ['iOS 18.3 private window', probe(UA.iosSafari183, { sw: true }), GB, 'link', 'webkit-18.2,no-opfs'],
    ['iPad 15.2', probe(UA.ipadSafari15, { sw: true, opfs: true }), GB, 'opfs', 'webkit-old'],
    ['Chrome on iOS 26', probe(UA.iosChrome, { sw: true, opfs: true }), GB, 'sw', 'sw'],
  ];
  for (const [name, p, size, mode, reason] of cases) assert.deepEqual(chooseMode(p, size), { mode, reason }, name);
});

test('declaredSize : the server size ; on WebKit the listed one when the server sent none', () => {
  assert.equal(declaredSize(5000, 4000, null), 5000);
  assert.equal(declaredSize(0, 4000, null), 0);
  assert.equal(declaredSize(0, 4000, { major: 27, minor: 0 }), 4000);
  assert.equal(declaredSize(5000, 4000, { major: 27, minor: 0 }), 5000);
});

test('responseHeaders : exact values, non-ASCII name, size 0 → no Content-Length', () => {
  assert.deepEqual(responseHeaders('Épisode 01.mkv', 3145728), {
    'Content-Type': 'video/x-matroska',
    'Content-Disposition': `attachment; filename="_pisode 01.mkv"; filename*=UTF-8''%C3%89pisode%2001.mkv`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Length': '3145728',
  });
  const headers = responseHeaders('slow.bin', 0);
  assert.equal('Content-Length' in headers, false);
  assert.equal(headers['Content-Type'], 'application/octet-stream');
});

test('contentDisposition : quotes, backslash, RFC 8187 specials and CJK', () => {
  assert.equal(contentDisposition(`l'"a\\b (1)!*.srt`), `attachment; filename="l'_a_b (1)!*.srt"; filename*=UTF-8''l%27%22a%5Cb%20%281%29%21%2A.srt`);
  assert.equal(contentDisposition('映画.mp4'), `attachment; filename="__.mp4"; filename*=UTF-8''%E6%98%A0%E7%94%BB.mp4`);
});

test('mimeType : by extension, case-insensitive, octet-stream otherwise', () => {
  assert.equal(mimeType('A.MP4'), 'video/mp4');
  assert.equal(mimeType('ep01.fr.srt'), 'application/x-subrip');
  assert.equal(mimeType('archive.7z'), 'application/x-7z-compressed');
  assert.equal(mimeType('README'), 'application/octet-stream');
  assert.equal(mimeType('.mkv'), 'application/octet-stream');
});

test('fitsQuota : size against quota − usage, unknown size allowed', () => {
  assert.equal(fitsQuota({ usage: 100, quota: 1100 }, 1000), true);
  assert.equal(fitsQuota({ usage: 101, quota: 1100 }, 1000), false);
  assert.equal(fitsQuota({ usage: 0, quota: 100 * 1024 * 1024 }, GB), false); // Incognito ~100 MB
  assert.equal(fitsQuota({}, 0), true);
  assert.equal(fitsQuota(undefined, 10), false);
});

/** A sink whose writes wait until release() : records every batch it got. */
function slowSink() {
  const batches = [];
  let gate = Promise.withResolvers();
  return {
    batches,
    write: async (bytes) => { batches.push(Array.from(bytes)); await gate.promise; },
    release() { gate.resolve(); gate = Promise.withResolvers(); },
    open() { gate.resolve(); gate = { promise: Promise.resolve() }; },
  };
}
const chunk = (...bytes) => new Uint8Array(bytes).buffer;
const tick = () => new Promise((r) => setTimeout(r, 0));

test('createPump : one write in flight, waiting chunks queued then coalesced in order', async () => {
  const sink = slowSink();
  const pump = createPump(sink.write);
  assert.equal(pump.push(chunk(1, 2)), true);
  assert.equal(pump.push(chunk(3)), true);
  assert.equal(pump.push(chunk(4, 5, 6)), true);
  await tick();
  // paused sink : the first chunk is in flight, the other two wait
  assert.deepEqual(sink.batches, [[1, 2]]);
  assert.equal(pump.queued, 4);
  sink.open();
  await pump.drain();
  assert.deepEqual(sink.batches, [[1, 2], [3, 4, 5, 6]]);
  assert.equal(pump.queued, 0);
});

test('createPump : batches never exceed the batch size, nothing lost', async () => {
  const sink = slowSink();
  const pump = createPump(sink.write, { batch: 4 });
  pump.push(chunk(0));
  for (let i = 1; i <= 9; i++) pump.push(chunk(i));
  pump.push(chunk(10, 11, 12, 13, 14)); // larger than a batch : goes out alone
  sink.open();
  await pump.drain();
  assert.deepEqual(sink.batches, [[0], [1, 2, 3, 4], [5, 6, 7, 8], [9], [10, 11, 12, 13, 14]]);
});

test('createPump : over the cap → push false, queue kept for the caller to cancel', async () => {
  const sink = slowSink();
  const pump = createPump(sink.write, { cap: 4 });
  assert.equal(pump.push(chunk(1, 2)), true); // in flight
  await tick();
  assert.equal(pump.push(chunk(3, 4)), true);
  assert.equal(pump.push(chunk(5, 6)), true);
  assert.equal(pump.queued, 4);
  assert.equal(pump.push(chunk(7)), false);
  assert.equal(pump.queued, 5);
  sink.open();
  await pump.drain();
  assert.deepEqual(sink.batches, [[1, 2], [3, 4, 5, 6, 7]]);
});

test('createPump : a write error stops the pump, push false, drain rejects with it', async () => {
  let calls = 0;
  const pump = createPump(async () => { calls++; throw new Error('disque plein'); });
  pump.push(chunk(1));
  pump.push(chunk(2));
  await assert.rejects(pump.drain(), /disque plein/);
  assert.equal(calls, 1);
  assert.equal(pump.push(chunk(3)), false);
  assert.equal(pump.error.message, 'disque plein');
});

test('createPump : Uint8Array views are copied at their offset', async () => {
  const seen = [];
  const pump = createPump(async (b) => seen.push(Array.from(b)));
  const big = new Uint8Array([9, 9, 1, 2, 3, 9]);
  pump.push(big.subarray(2, 5));
  await pump.drain();
  assert.deepEqual(seen, [[1, 2, 3]]);
});
