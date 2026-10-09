// DataChannel RPC : string = JSON control, binary = file bytes.
// First message must be {t:'auth', token} ; request {id, m, p} → reply {id, r} or {id, e}.

import { createHash, timingSafeEqual } from 'node:crypto';
import { sendStream } from './chunker.js';

const AD_PATH = /^\/v4(\.1)?\//;
const digest = (s) => createHash('sha256').update(String(s)).digest();

/**
 * deps : token (APP_TOKEN), ad(path, fields), streamUrl(link, name) → {url, expires},
 * openDownload(link, signal) → {size, body: ReadableStream}.
 * The caller wires channel.onMessage to `onMessage` and channel close to `dispose`.
 */
export function createRpc(channel, { token, ad, streamUrl, openDownload, authTimeoutMs = 5000 }) {
  const expected = digest(token);
  let authed = false;
  let download = null; // AbortController of the running download
  const timer = setTimeout(() => { if (!authed) channel.close(); }, authTimeoutMs);

  const send = (obj) => { if (channel.readyState === 'open') channel.send(JSON.stringify(obj)); };

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
      if (!timingSafeEqual(digest(msg.token), expected)) return channel.close();
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
