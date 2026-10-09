// P2P download : DataChannel chunks → one sink per mode, never a Blob of the whole file in memory.
// Modes and their order : lib/save-mode.js. Every sink has the same lifecycle :
//   open()       — at the click, inside the user gesture ; false = the user closed a picker
//   start(size)  — the server answered with the size (0 = unknown)
//   write(bytes) — one batch at a time, through the pump (createPump) : resolves when the sink
//                  took it, so a slow sink queues in the pump, capped, instead of in memory freely
//   finish()     — every byte written
//   abort()      — cancel or failure : no file left behind (picker, OPFS), download failed (SW)

import { createPump, declaredSize, fitsQuota, responseHeaders, webkitVersion } from './save-mode.js';
import { formatSize } from './util.js';

const BASE = import.meta.env?.BASE_URL ?? '/';
const SW_URL = BASE + 'dl-sw.js';
const SW_PATH = 'dl-sw/'; // download URLs : <scope>dl-sw/<id>/<name>, the only ones the SW answers
const PING_MS = 10_000; // Firefox stops an idle SW after 30 s, an open response stream does not count
const FETCH_WAIT_MS = 10_000; // the download URL must reach the SW within this delay
const STAGING = 'debrid-remote-staging'; // OPFS directory of the staged files
const STAGED_TTL_MS = 10 * 60_000; // a staged file outlives its hand-off by this much (no "download done" event)

let worker = null; // active service worker, set by probe()
let webkit = null;

async function probeSw() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return false;
  try {
    // Scope = the app's base. No clients.claim : the page talks to the worker, it needs no control.
    await navigator.serviceWorker.register(SW_URL, { scope: BASE });
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ]);
    worker = registration.active;
    return !!worker;
  } catch {
    return false; // denied (Brave settings, private modes), blocked, or too slow
  }
}

async function stagingDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(STAGING, { create: true });
}

/** Removes every staged file ; one still open by a writable stays (locked). */
async function sweep(dir) {
  for await (const name of dir.keys()) await dir.removeEntry(name).catch(() => {});
}

async function probeOpfs() {
  // Functional : a private window can expose getDirectory and reject it (Firefox), and Safari
  // before 26 has OPFS without createWritable.
  try {
    if (typeof FileSystemFileHandle?.prototype.createWritable !== 'function') return false;
    await sweep(await stagingDir()); // start-up sweep : files staged by a previous visit
    return true;
  } catch {
    return false;
  }
}

/** What this browser can do, tried not only looked up : {picker, android, sw, opfs, webkit}. */
export async function probe() {
  const ua = navigator.userAgent;
  webkit = webkitVersion(ua);
  const [sw, opfs] = await Promise.all([probeSw(), probeOpfs()]);
  return { picker: typeof window.showSaveFilePicker === 'function', android: /Android/.test(ua), sw, opfs, webkit };
}

function pickerSink(file) {
  let handle;
  let writable;
  return {
    async open() {
      try {
        handle = await window.showSaveFilePicker({ suggestedName: file.name });
      } catch (e) {
        if (e.name === 'AbortError') return false;
        throw e;
      }
      writable = await handle.createWritable();
    },
    async start() {},
    write: (bytes) => writable.write(bytes),
    finish: () => writable.close(),
    // abort() only drops the buffered bytes : the picker already created the file, empty. Remove it
    // too, so a cancelled or failed transfer leaves nothing behind (remove() : Chromium ≥ 110).
    async abort() {
      await writable.abort().catch(() => {});
      await handle.remove?.().catch(() => {});
    },
  };
}

/**
 * The browser's download manager writes the file : a hidden iframe opens <scope>dl-sw/<id>/<name>,
 * the SW (public/dl-sw.js) answers with a stream fed from here over a MessagePort, handed to it
 * with {t:'open', id, pin} (pin : WebKit). Port messages :
 * page → SW {t:'head', headers} | {t:'chunk', bytes} | {t:'end'} | {t:'abort'} ;
 * SW → page {t:'fetched'} (the URL reached it) | {t:'ack'} (room for the next batch) |
 * {t:'cancel'} (cancelled from the browser's download UI).
 */
function swSink(file, { cancelled }) {
  const id = crypto.randomUUID();
  const { port1, port2 } = new MessageChannel();
  const active = worker;
  let ack = null;
  let fetched;
  let failFetch;
  const reached = new Promise((resolve, reject) => {
    fetched = resolve;
    failFetch = reject;
  });
  reached.catch(() => {}); // awaited by start() ; a failure before start must not go unhandled
  let ping = null;
  let wait = null;
  let iframe = null;
  port1.onmessage = ({ data }) => {
    const t = data?.t;
    if (t === 'ack') {
      const done = ack;
      ack = null;
      done?.();
    } else if (t === 'fetched') {
      clearTimeout(wait);
      fetched();
    }
    else if (t === 'cancel') cancelled();
  };
  const cleanup = () => {
    clearInterval(ping);
    clearTimeout(wait);
    port1.onmessage = null;
    const frame = iframe;
    setTimeout(() => frame?.remove(), 30_000); // the download is the browser's from here
  };
  return {
    open() {
      active.postMessage({ t: 'open', id, pin: !!webkit }, [port2]);
      iframe = document.createElement('iframe');
      iframe.hidden = true;
      iframe.src = `${BASE}${SW_PATH}${id}/${encodeURIComponent(file.name)}`;
      document.body.append(iframe);
      ping = setInterval(() => active.postMessage({ t: 'ping' }), PING_MS);
      wait = setTimeout(() => failFetch(new Error("le navigateur n'a pas pris en charge le téléchargement")), FETCH_WAIT_MS);
    },
    async start(size) {
      port1.postMessage({ t: 'head', headers: responseHeaders(file.name, declaredSize(size, file.size, webkit)) });
      await reached;
    },
    write: (bytes) => new Promise((resolve) => {
      ack = resolve;
      port1.postMessage({ t: 'chunk', bytes }); // structured clone : a copy, never a transfer
    }),
    async finish() {
      port1.postMessage({ t: 'end' });
      cleanup();
    },
    async abort() {
      port1.postMessage({ t: 'abort' });
      ack?.();
      cleanup();
    },
  };
}

/** Staged in the origin private file system, then handed to the browser as an object URL. */
function opfsSink(file) {
  let dir;
  let name;
  let writable;
  return {
    async open() {},
    async start(size) {
      const need = size || file.size;
      if (!fitsQuota(await navigator.storage.estimate(), need)) {
        throw new Error(`pas assez d'espace de stockage pour la copie temporaire (${formatSize(need)})`);
      }
      dir = await stagingDir();
      await sweep(dir); // the previous download's staged file
      name = crypto.randomUUID();
      writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    },
    write: (bytes) => writable.write(bytes),
    async finish() {
      await writable.close();
      const staged = await (await dir.getFileHandle(name)).getFile(); // disk-backed, not read here
      const url = URL.createObjectURL(staged);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      document.body.append(a);
      a.click();
      a.remove();
      // No event says the browser finished copying it : removed after a delay, by the next OPFS
      // download, or by the start-up sweep of the next visit.
      const kept = name;
      setTimeout(() => {
        URL.revokeObjectURL(url);
        dir.removeEntry(kept).catch(() => {});
      }, STAGED_TTL_MS);
    },
    async abort() {
      await writable?.abort().catch(() => {});
      if (name) await dir.removeEntry(name).catch(() => {});
    },
  };
}

const SINKS = { picker: pickerSink, sw: swSink, opfs: opfsSink };

/**
 * Streams `session.download(link)` into the sink of `mode` (picker | sw | opfs).
 * onProgress(received, size, phase) — phase 'handoff' once every byte is staged (OPFS).
 * Resolves 'end' | 'cancelled' | 'aborted' ('aborted' = the user closed the picker, nothing
 * was requested from the server). Call it from the click handler : open() needs the gesture.
 */
export async function save(session, { link, name, size: listed = 0 }, mode, onProgress = () => {}) {
  let userCancel = false;
  const sink = SINKS[mode]({ name, size: listed }, {
    cancelled: () => {
      userCancel = true;
      session.cancel();
    },
  });
  if ((await sink.open()) === false) return 'aborted';
  let size = 0;
  let received = 0;
  let failure = null;
  let started = Promise.resolve();
  const fail = (e) => {
    if (failure) return;
    failure = e;
    session.cancel();
  };
  const pump = createPump(async (bytes) => {
    await started;
    try {
      await sink.write(bytes);
    } catch (e) {
      fail(new Error(`écriture impossible : ${e.message}`)); // the server stops sending at once
      throw e;
    }
  });
  const transfer = {
    start(total) {
      size = total;
      started = sink.start(total);
      started.catch(fail);
      onProgress(0, size);
    },
    chunk(buffer) {
      received += buffer.byteLength;
      if (!pump.push(buffer)) fail(new Error("l'enregistrement ne suit pas le transfert : annulé"));
      onProgress(received, size);
    },
  };
  let outcome;
  try {
    outcome = await session.download(link, transfer);
    if (!failure && outcome === 'end') {
      await started;
      await pump.drain();
    }
  } catch (e) {
    await sink.abort();
    throw failure ?? e;
  }
  if (failure) {
    await sink.abort();
    throw failure;
  }
  if (outcome === 'cancelled' || userCancel) {
    await sink.abort();
    return 'cancelled';
  }
  if (mode === 'opfs') onProgress(received, size, 'handoff');
  await sink.finish();
  return outcome;
}

/** The stream link as an attachment, for browsers with no P2P mode. */
export const attachmentUrl = (url) => url + (url.includes('?') ? '&' : '?') + 'dl=1';
