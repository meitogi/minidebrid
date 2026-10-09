// DataChannel RPC : string = JSON control, binary = file bytes.
// First message must be {t:'auth', token} ; request {id, m, p} → reply {id, r} or {id, e}.
// A message over FRAME_MAX bytes goes out as {frag} frames, the last one {frag, last:true} :
// the receiver joins the frag strings and parses the result. werift refuses to send anything
// above the remote's max-message-size (64 KB for werift, 256 KB for Chrome).

import { sendStream } from './chunker.js';

const AD_PATH = /^\/v4(\.1)?\//;
export const FRAME_MAX = 60 * 1024;
const FRAG_CHARS = 8192; // ≤ 6 bytes per char once JSON-escaped : a frame stays under 64 KB

/**
 * deps : authenticate(token) → token name or null (access.js), ad(path, fields), streamUrl(link, name) → {url, expires},
 * openDownload(link, signal) → {size, body: ReadableStream}.
 * The caller wires channel.onMessage to `onMessage` and channel close to `dispose`.
 */
export function createRpc(channel, { authenticate, ad, streamUrl, openDownload, authTimeoutMs = 5000 }) {
  let authed = false;
  let download = null; // AbortController of the running download
  const timer = setTimeout(() => { if (!authed) channel.close(); }, authTimeoutMs);

  function send(obj) {
    if (channel.readyState !== 'open') return;
    const text = JSON.stringify(obj);
    if (Buffer.byteLength(text) <= FRAME_MAX) return channel.send(text);
    const length = text.length;
    for (let off = 0; off < length; off += FRAG_CHARS) {
      const end = off + FRAG_CHARS;
      channel.send(JSON.stringify(end >= length ? { frag: text.slice(off), last: true } : { frag: text.slice(off, end) }));
    }
  }

  const methods = {
    ad({ path, fields }) {
      if (typeof path !== 'string' || !AD_PATH.test(path)) throw new Error('path must start with /v4/ or /v4.1/');
      return ad(path, fields ?? {});
    },
    streamUrl({ link, name }) {
      return streamUrl(link, name);
    },
  };

  async function runDownload(id, { link }) {
    if (download) return send({ id, e: 'a download is already running' });
    const abort = new AbortController();
    download = abort;
    const signal = abort.signal;
    let started = false;
    try {
      const { size, body } = await openDownload(link, signal);
      send({ id, r: { size } });
      started = true;
      const complete = await sendStream(channel, body, signal);
      send(complete ? { t: 'end' } : { t: 'cancelled' });
    } catch (e) {
      if (signal.aborted) send(started ? { t: 'cancelled' } : { id, e: 'cancelled' });
      else send(started ? { t: 'error', e: e.message } : { id, e: e.message });
    } finally {
      download = null;
    }
  }

  async function call(id, m, p) {
    try {
      const fn = methods[m];
      if (!fn) throw new Error(`unknown method ${m}`);
      send({ id, r: await fn(p ?? {}) });
    } catch (e) {
      send({ id, e: e.message });
    }
  }

  function onMessage(data) {
    if (typeof data !== 'string') return;
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (!authed) {
      if (msg?.t !== 'auth') return;
      clearTimeout(timer);
      if (!authenticate(msg.token)) return channel.close();
      authed = true;
      return send({ t: 'auth', ok: true });
    }
    if (msg?.t === 'cancel') return download?.abort();
    const id = msg?.id;
    if (id === undefined) return;
    if (msg.m === 'download') runDownload(id, msg.p ?? {});
    else call(id, msg.m, msg.p);
  }

  function dispose() {
    clearTimeout(timer);
    download?.abort();
  }

  return { onMessage, dispose };
}

/** Wires a werift DataChannel : RPC, auth against `access` (access.js), release and dispose on close. */
export function serveChannel(channel, access, deps) {
  const rpc = createRpc(channel, { ...deps, authenticate: (token) => access.admit(token, channel) });
  channel.onMessage.subscribe(rpc.onMessage);
  channel.stateChanged.subscribe((s) => {
    if (s !== 'closed') return;
    access.release(channel);
    rpc.dispose();
  });
}
