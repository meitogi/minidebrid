// Pure logic of the P2P save : which mode a browser uses, the headers the service worker answers
// with, the OPFS quota check, and the pump every mode writes through. No DOM : node --test.
//
// Modes, best first (support matrix and order : plans LOG § 5) :
//   picker — showSaveFilePicker, streamed writable (Chromium desktop, Chrome Android ≥ 132)
//   sw     — service worker answers a download URL with a streamed body, the browser's download
//            manager writes it (Chromium, Firefox, Safari ≥ 15.4)
//   opfs   — staged in the origin private file system, then handed over as a download
//   link   — no P2P : the stream link with ?dl=1 (through the tunnel)

export const QUEUE_CAP = 64 * 1024 * 1024; // bytes waiting for the sink before the transfer is cancelled
export const BATCH_MAX = 256 * 1024; // one write / one post : WebKit drops larger SW posts (LOG § 5)

/**
 * WebKit version from a user agent : {major, minor}, or null when the engine is not WebKit.
 * Every iOS browser is WebKit ; Safari carries Version/x.y, Chrome / Firefox on iOS only OS x_y.
 */
export function webkitVersion(ua) {
  let m = null;
  if (/iPhone|iPad|iPod/.test(ua)) m = ua.match(/Version\/(\d+)\.(\d+)/) ?? ua.match(/OS (\d+)_(\d+)/);
  else if (/Safari\//.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox|Android/.test(ua)) m = ua.match(/Version\/(\d+)\.(\d+)/);
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/**
 * Why the SW mode cannot be used on this WebKit for this size, or null if it can. A page cannot
 * observe whether the download manager consumed the SW stream, so this part is version-based :
 * before 15.4 Safari re-fetched the URL from the network ; 18.2–18.3 interrupted SW downloads ;
 * iOS truncates a SW download that declares no Content-Length.
 */
export function swBlocker(webkit, size) {
  if (!webkit) return null;
  const { major, minor } = webkit;
  if (major < 15 || (major === 15 && minor < 4)) return 'webkit-old';
  if (major === 18 && minor >= 2 && minor < 4) return 'webkit-18.2';
  if (!(size > 0)) return 'webkit-no-size';
  return null;
}

/**
 * probe : {picker, android, sw, opfs, webkit} — booleans from a functional probe (the API was
 * tried, not only found), webkit from webkitVersion. size : the file size known before the
 * transfer (0 = unknown). → {mode, reason} ; reason names why a better mode was skipped.
 */
export function chooseMode(probe, size) {
  if (probe.picker && probe.android) return { mode: 'picker', reason: 'android' };
  const blocked = probe.sw ? swBlocker(probe.webkit, size) : 'no-sw';
  if (!blocked) return { mode: 'sw', reason: 'sw' };
  if (probe.picker) return { mode: 'picker', reason: blocked };
  if (probe.opfs) return { mode: 'opfs', reason: blocked };
  return { mode: 'link', reason: `${blocked},no-opfs` };
}

/** Size the SW declares : the server's, else on WebKit the size listed by Alldebrid — an
 * over-estimate only ends the progress early there, no Content-Length truncates the file. */
export const declaredSize = (serverSize, listedSize, webkit) => serverSize || (webkit ? listedSize || 0 : 0);

const TYPES = {
  mkv: 'video/x-matroska', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', avi: 'video/x-msvideo',
  mov: 'video/quicktime', ts: 'video/mp2t', mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac',
  ogg: 'audio/ogg', wav: 'audio/wav', srt: 'application/x-subrip', zip: 'application/zip',
  rar: 'application/vnd.rar', '7z': 'application/x-7z-compressed', iso: 'application/x-iso9660-image',
  pdf: 'application/pdf', epub: 'application/epub+zip', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', nfo: 'text/plain', txt: 'text/plain',
};

/** iOS names a SW download from its Content-Type, not the filename : octet-stream gets `.html`. */
export function mimeType(name) {
  const dot = name.lastIndexOf('.');
  return (dot > 0 && TYPES[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

// RFC 8187 ext-value : encodeURIComponent leaves ' ( ) ! * raw, which would end or garble filename*.
const extValue = (s) => encodeURIComponent(s).replace(/['()!*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** Same encoding as the server's stream link : ASCII fallback, real name in filename*. */
export const contentDisposition = (name) =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${extValue(name)}`;

/** Headers of the SW's download response. size 0 → no Content-Length. */
export function responseHeaders(name, size) {
  const headers = {
    'Content-Type': mimeType(name),
    'Content-Disposition': contentDisposition(name),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  };
  if (size > 0) headers['Content-Length'] = String(size);
  return headers;
}

/**
 * Staging needs `size` free in the origin's quota. estimate() reports a share of the total disk,
 * not the free space : the download's own copy cannot be checked here. size 0 → unknown, allowed
 * (a full quota then fails the write, with its own error).
 */
export const fitsQuota = ({ usage = 0, quota = 0 } = {}, size) => !(size > 0) || quota - usage >= size;

/**
 * Serialises writes to a sink that may be slower than the DataChannel, which cannot be paused :
 * one write(Uint8Array) in flight, waiting chunks coalesced up to `batch` bytes (each batch is a
 * copy), at most `cap` bytes waiting. push() → false once over the cap or after a failed write :
 * the caller cancels the transfer. drain() resolves when everything is written, or rejects with
 * the write error.
 */
export function createPump(write, { cap = QUEUE_CAP, batch = BATCH_MAX } = {}) {
  const queue = [];
  let head = 0;
  let queued = 0;
  let busy = false;
  let error = null;
  let idle = null; // {resolve, reject} of a pending drain()

  function settle() {
    if (!idle || (busy && !error)) return;
    const { resolve, reject } = idle;
    idle = null;
    if (error) reject(error);
    else resolve();
  }

  function next() {
    const first = queue[head];
    let length = first.byteLength;
    let end = head + 1;
    const count = queue.length;
    while (end < count && length + queue[end].byteLength <= batch) length += queue[end++].byteLength;
    const out = new Uint8Array(length);
    let off = 0;
    for (let i = head; i < end; i++) {
      const chunk = queue[i];
      out.set(new Uint8Array(chunk.buffer ?? chunk, chunk.byteOffset ?? 0, chunk.byteLength), off);
      off += chunk.byteLength;
    }
    head = end;
    if (head > 1024) {
      queue.splice(0, head);
      head = 0;
    }
    queued -= length;
    return out;
  }

  async function run() {
    busy = true;
    try {
      while (head < queue.length && !error) await write(next());
    } catch (e) {
      error = e;
    }
    busy = false;
    settle();
  }

  return {
    push(chunk) {
      if (error) return false;
      queue.push(chunk);
      queued += chunk.byteLength;
      if (queued > cap) return false;
      if (!busy) run();
      return true;
    },
    drain() {
      if (!busy && (error || head >= queue.length)) return error ? Promise.reject(error) : Promise.resolve();
      return new Promise((resolve, reject) => (idle = { resolve, reject }));
    },
    get queued() {
      return queued;
    },
    get error() {
      return error;
    },
  };
}
