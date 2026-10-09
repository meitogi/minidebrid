// Download service worker of debrid-remote, registered by src/lib/download.js with the app's base
// as scope. It answers only <scope>dl-sw/<id>/<name> : an attachment whose body the page feeds
// over a MessagePort, so the browser's download manager writes a P2P file to disk. Every other
// request goes to the network untouched — nothing is cached, a Pages deploy is never masked.

const PREFIX = new URL('dl-sw/', self.registration.scope).pathname;
const HIGH_WATER = 1024 * 1024; // bytes queued in the response stream before the page waits
const WAIT_MS = 10_000; // a download URL whose port never arrives : 404
const transfers = {}; // id → {ready, arrive, port, pin} : the page's 'open' and the fetch meet here

// A new version takes over at once : it holds no state between transfers.
self.addEventListener('install', () => self.skipWaiting());

function slot(id) {
  let s = transfers[id];
  if (!s) {
    let arrive;
    const ready = new Promise((resolve) => (arrive = resolve));
    s = transfers[id] = { ready, arrive, port: null, pin: false };
  }
  return s;
}

// {t:'open', id, pin} + a port : a download is about to be requested. {t:'ping'} needs no handling :
// the message event itself keeps the worker alive (Firefox stops it after 30 s without events).
self.addEventListener('message', (event) => {
  const data = event.data;
  const port = event.ports[0];
  if (data?.t !== 'open' || !port) return;
  const s = slot(data.id);
  s.port = port;
  s.pin = !!data.pin;
  s.arrive();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const path = new URL(request.url).pathname;
  if (request.method !== 'GET' || !path.startsWith(PREFIX)) return;
  let release;
  event.waitUntil(new Promise((resolve) => (release = resolve)));
  event.respondWith(respond(path.slice(PREFIX.length).split('/')[0], release));
});

async function respond(id, release) {
  const s = slot(id);
  const timeout = new Promise((resolve) => setTimeout(resolve, WAIT_MS, 'timeout'));
  const arrived = await Promise.race([s.ready, timeout]);
  delete transfers[id];
  if (arrived === 'timeout') {
    release();
    return new Response('', { status: 404 });
  }
  // WebKit finalises the download only when this stream ends, and retires an idle worker before
  // that : the fetch event is held open until then. Chromium stops a worker whose fetch event is
  // still pending after 5 min, so everywhere else it settles now.
  if (!s.pin) release();
  const port = s.port;
  port.postMessage({ t: 'fetched' });
  return new Promise((resolve) => {
    let controller;
    let owed = false; // an ack the page waits for, sent when the stream has room again
    let ending = false; // the page sent every byte ; close once the download manager read them
    const finish = () => {
      port.onmessage = null;
      release();
    };
    const closeIfRead = () => {
      if (!ending || controller.desiredSize < HIGH_WATER) return;
      controller.close();
      finish();
    };
    const stream = new ReadableStream({
      start(c) {
        controller = c;
      },
      pull() {
        closeIfRead();
        if (!owed) return;
        owed = false;
        port.postMessage({ t: 'ack' });
      },
      cancel() {
        port.postMessage({ t: 'cancel' }); // cancelled from the browser's download UI
        finish();
      },
    }, { highWaterMark: HIGH_WATER, size: (chunk) => chunk.byteLength });
    port.onmessage = ({ data }) => {
      const t = data?.t;
      if (t === 'head') resolve(new Response(stream, { headers: data.headers }));
      else if (t === 'chunk') {
        controller.enqueue(data.bytes);
        if (controller.desiredSize > 0) port.postMessage({ t: 'ack' });
        else owed = true;
      } else if (t === 'end') {
        ending = true;
        closeIfRead();
      } else if (t === 'abort') {
        controller.error(new Error('annulé')); // the browser marks the download failed
        resolve(Response.error()); // no-op once the head was answered
        finish();
      }
    };
  });
}
