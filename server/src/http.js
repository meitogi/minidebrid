// Stream link server : GET|HEAD /s/<tok>/<name> → Range proxy of the unlocked Alldebrid URL.
// Never redirects : the player must fetch from this machine, not from its own IP.

import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { verifyToken } from './stream-token.js';

const UNLOCK_TTL_MS = 6 * 3600 * 1000;
const FORWARDED = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
const ROUTE = /^\/s\/([^/]+)\/(.+)$/;
// RFC 8187 ext-value : encodeURIComponent leaves ' ( ) ! * raw, which would end or garble filename*.
const extValue = (s) => encodeURIComponent(s).replace(/['()!*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/** `unlock(link)` resolves a locked link into a direct URL ; `secret` signs the tokens. */
export function createHttpServer({ secret, unlock }) {
  const cache = {}; // locked link → {url, at}

  async function unlocked(link) {
    const hit = cache[link];
    if (hit && Date.now() - hit.at < UNLOCK_TTL_MS) return hit.url;
    const url = await unlock(link);
    cache[link] = { url, at: Date.now() };
    return url;
  }

  async function handle(req, res) {
    const method = req.method;
    const url = new URL(req.url, 'http://x');
    const m = ROUTE.exec(url.pathname);
    if (!m || (method !== 'GET' && method !== 'HEAD')) return res.writeHead(404).end();
    const link = verifyToken(m[1], secret);
    if (!link) return res.writeHead(403).end();

    const name = decodeURIComponent(m[2]);
    // Node throws on header chars above U+00FF (’, CJK…) : the quoted fallback is printable ASCII
    // only, filename* carries the real UTF-8 name.
    const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    let upstream;
    try {
      const headers = { 'accept-encoding': 'identity' }; // fetch would gunzip and desync content-length
      const range = req.headers.range;
      if (range) headers.range = range;
      upstream = await fetch(await unlocked(link), { method, headers, signal: abort.signal });
    } catch (e) {
      if (abort.signal.aborted) return;
      console.log(`http: upstream failed for ${ascii}: ${e.message}`);
      return res.writeHead(502).end();
    }
    const status = upstream.status;
    if (status >= 400) delete cache[link];

    const out = {};
    for (const h of FORWARDED) {
      const v = upstream.headers.get(h);
      if (v !== null) out[h] = v;
    }
    const disposition = url.searchParams.get('dl') === '1' ? 'attachment' : 'inline';
    out['content-disposition'] = `${disposition}; filename="${ascii}"; filename*=UTF-8''${extValue(name)}`;
    res.writeHead(status, out);

    const body = upstream.body;
    if (method === 'HEAD' || !body) return res.end();
    Readable.fromWeb(body, { signal: abort.signal }).on('error', () => res.destroy()).pipe(res);
  }

  // An async handler's throw is an unhandled rejection, which ends the process : contain it here.
  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.log(`http: ${req.method} failed: ${e.message}`);
      if (res.headersSent) res.destroy();
      else res.writeHead(400).end();
    });
  });
}
