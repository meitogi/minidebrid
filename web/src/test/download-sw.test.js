// The SW mode end to end in Node : the real public/dl-sw.js in a vm context, the real download.js
// runner and sink, real MessageChannel / ReadableStream / Response. The doubles are only what a
// browser provides around them : `self` (listeners, registration.scope), the iframe whose src
// becomes the SW's fetch event, navigator.serviceWorker handing the active worker over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { probe, save } from '../lib/download.js';

const SW_SOURCE = readFileSync(new URL('../../public/dl-sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://pages.test';
const UA_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
const UA_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15';

// download.js waits 5 s for the SW, keeps its iframe 30 s, pings every 10 s : those timers must not hold the test
// process open once a case is over.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const timer = realSetTimeout(fn, ms, ...args);
  if (ms >= 5000) timer.unref();
  return timer;
};

/** Boots the worker and the page globals ; resolves the fetch outcome of the next download. */
async function browser(ua) {
  const listeners = {};
  const self = {
    registration: { scope: ORIGIN + '/' }, // download.js's BASE is '/' outside Vite
    addEventListener: (type, fn) => (listeners[type] = fn),
    skipWaiting() {},
  };
  vm.runInNewContext(SW_SOURCE, { self, URL, ReadableStream, Response, Promise, setTimeout, Error });
  const fetches = [];
  const active = { postMessage: (data, ports = []) => listeners.message({ data, ports }) };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: ua,
      serviceWorker: { register: async () => {}, ready: Promise.resolve({ active }) },
      storage: { getDirectory: () => Promise.reject(new Error('no OPFS here')) },
    },
  });
  globalThis.window = { isSecureContext: true };
  globalThis.document = {
    body: { append() {} },
    createElement: () => {
      const frame = { hidden: false, remove() {} };
      Object.defineProperty(frame, 'src', {
        set(src) {
          // the navigation reaches the SW as a fetch event, after the page's current task
          realSetTimeout(() => {
            const waits = [];
            let response = null;
            listeners.fetch({
              request: { method: 'GET', url: new URL(src, ORIGIN).href },
              waitUntil: (p) => waits.push(p),
              respondWith: (p) => (response = p),
            });
            fetches.push({ src, waits, response });
          }, 0);
        },
      });
      return frame;
    },
  };
  const caps = await probe();
  return { caps, fetches };
}

// Deterministic file : byte i = i % 251.
const source = (size) => Uint8Array.from({ length: size }, (_, i) => i % 251);

/** session.download : start(size), then 16 KB chunks one task apart, stops on cancel(). */
function fakeSession(bytes, { announce = bytes.length, cancelAt = Infinity } = {}) {
  return {
    cancels: 0,
    cancel() { this.cancels++; },
    async download(_link, sink) {
      sink.start(announce);
      for (let off = 0; off < bytes.length; off += 16384) {
        if (this.cancels) return 'cancelled';
        if (off >= cancelAt) this.cancel();
        sink.chunk(bytes.slice(off, off + 16384).buffer);
        await new Promise((r) => setImmediate(r));
      }
      return this.cancels ? 'cancelled' : 'end';
    },
  };
}

const until = async (check) => {
  while (!check()) await new Promise((r) => realSetTimeout(r, 1));
};

/** Reads a Response body, `delay` ms between reads ; stops after `stopAfter` bytes (cancel). */
async function drain(response, { delay = 0, stopAfter = Infinity } = {}) {
  const reader = response.body.getReader();
  const parts = [];
  let length = 0;
  for (;;) {
    if (length >= stopAfter) {
      await reader.cancel();
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    length += value.byteLength;
    if (delay) await new Promise((r) => realSetTimeout(r, delay));
  }
  return Buffer.concat(parts);
}

test('SW mode : byte-exact through the worker with a slow reader, exact headers, fetch event released', async () => {
  const { caps, fetches } = await browser(UA_CHROME);
  assert.deepEqual(caps, { picker: false, android: false, sw: true, opfs: false, webkit: null });
  const bytes = source(3 * 1024 * 1024 + 123);
  const progress = [];
  const outcome = save(fakeSession(bytes), { link: 'l', name: 'Épisode 01.mkv', size: bytes.length }, 'sw', (r, s) => progress.push([r, s]));
  await until(() => fetches.length === 1);
  const { src, waits, response } = fetches[0];
  assert.match(src, /^\/dl-sw\/[0-9a-f-]{36}\/%C3%89pisode%2001\.mkv$/);
  const res = await response;
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), String(bytes.length));
  assert.equal(res.headers.get('content-type'), 'video/x-matroska');
  assert.equal(res.headers.get('content-disposition'), `attachment; filename="_pisode 01.mkv"; filename*=UTF-8''%C3%89pisode%2001.mkv`);
  // not WebKit : the fetch event's lifetime promise is already settled (Chromium's 5-min limit)
  assert.equal(await Promise.race([waits[0].then(() => 'released'), new Promise((r) => realSetTimeout(r, 20, 'held'))]), 'released');
  const body = await drain(res, { delay: 2 }); // slower than the producer : the ack loop must hold
  assert.equal(await outcome, 'end');
  assert.equal(body.length, bytes.length);
  assert.ok(body.equals(Buffer.from(bytes)), 'body differs from the source');
  assert.deepEqual(progress.at(-1), [bytes.length, bytes.length]);
});

test('SW mode : cancelled from the download UI → server cancelled, outcome cancelled', async () => {
  const { fetches } = await browser(UA_CHROME);
  const session = fakeSession(source(4 * 1024 * 1024));
  const outcome = save(session, { link: 'l', name: 'big.bin', size: 0 }, 'sw');
  await until(() => fetches.length === 1);
  const res = await fetches[0].response;
  assert.equal(res.headers.get('content-length'), String(4 * 1024 * 1024));
  const got = await drain(res, { stopAfter: 512 * 1024 });
  assert.ok(got.length >= 512 * 1024);
  assert.equal(await outcome, 'cancelled');
  assert.equal(session.cancels, 1);
});

test('SW mode : Annuler in the page → the download stream errors (download failed)', async () => {
  const { fetches } = await browser(UA_CHROME);
  const session = fakeSession(source(4 * 1024 * 1024), { cancelAt: 1024 * 1024 });
  const outcome = save(session, { link: 'l', name: 'big.bin', size: 0 }, 'sw');
  await until(() => fetches.length === 1);
  const res = await fetches[0].response;
  await assert.rejects(drain(res), /annulé/);
  assert.equal(await outcome, 'cancelled');
});

test('SW mode on WebKit : fetch event held until the body ends ; no server size → the listed size', async () => {
  const { caps, fetches } = await browser(UA_SAFARI);
  assert.deepEqual(caps.webkit, { major: 27, minor: 0 });
  const bytes = source(300 * 1024);
  const outcome = save(fakeSession(bytes, { announce: 0 }), { link: 'l', name: 'film.mp4', size: bytes.length }, 'sw');
  await until(() => fetches.length === 1);
  const { waits, response } = fetches[0];
  const res = await response;
  assert.equal(res.headers.get('content-length'), String(bytes.length));
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  let released = false;
  waits[0].then(() => (released = true));
  const reader = res.body.getReader();
  await reader.read();
  await new Promise((r) => realSetTimeout(r, 10));
  assert.equal(released, false, 'released before the body ended');
  for (;;) if ((await reader.read()).done) break;
  assert.equal(await outcome, 'end');
  await new Promise((r) => realSetTimeout(r, 0));
  assert.equal(released, true);
});
