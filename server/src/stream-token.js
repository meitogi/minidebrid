// Signed stream link token : base64url({l: link, e: expiry}) + '.' + base64url(HMAC-SHA256).

import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000;

function mac(payload, secret) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Token for `link`, valid `ttlMs` from `now`. Returns {tok, expires}. */
export function signToken(link, secret, ttlMs = DEFAULT_TTL_MS, now = Date.now()) {
  const expires = now + ttlMs;
  const payload = Buffer.from(JSON.stringify({ l: link, e: expires })).toString('base64url');
  return { tok: `${payload}.${mac(payload, secret)}`, expires };
}

/** streamUrl(link, name) → {url, expires} : `publicUrl`/s/<tok>/<name>, served by http.js. */
export function streamUrlBuilder(publicUrl, secret) {
  const base = publicUrl.replace(/\/+$/, '');
  return async (link, name) => {
    if (typeof link !== 'string' || typeof name !== 'string') throw new Error('link and name are required');
    const { tok, expires } = signToken(link, secret);
    return { url: `${base}/s/${tok}/${encodeURIComponent(name)}`, expires };
  };
}

/** Locked link carried by `tok`, or null when the signature is wrong or the token expired. */
export function verifyToken(tok, secret, now = Date.now()) {
  const dot = tok.indexOf('.');
  if (dot < 1) return null;
  const payload = tok.slice(0, dot);
  const given = Buffer.from(tok.slice(dot + 1));
  const expected = Buffer.from(mac(payload, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (typeof data?.l !== 'string' || !(data.e > now)) return null;
  return data.l;
}
