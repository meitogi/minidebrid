// Minimal Alldebrid v4 client (Bearer apikey auth). Generalised from media-sorter's adPost.

const BASE = 'https://api.alldebrid.com';

/** POST `path` with `fields`, returns the `data` of the envelope, throws on `status !== 'success'`. */
export async function ad(path, fields = {}) {
  const apikey = process.env.ALLDEBRID_APIKEY;
  if (!apikey) throw new Error('ALLDEBRID_APIKEY missing — fill it in .env');
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apikey}` },
    body: new URLSearchParams(fields),
  });
  const payload = await res.json();
  if (payload.status !== 'success') {
    const err = payload.error ?? {};
    throw new Error(`AllDebrid ${path}: ${err.code ?? res.status} — ${err.message ?? 'unknown error'}`);
  }
  return payload.data;
}

/** Turns a locked https://alldebrid.com/f/… link into a direct download URL. */
export async function unlock(link) {
  return (await ad('/v4/link/unlock', { link })).link;
}

/** Unlocks `link` and opens its bytes : {size, body: ReadableStream}. size is 0 when unknown. */
export async function openDownload(link, signal) {
  if (typeof link !== 'string') throw new Error('link is required');
  const res = await fetch(await unlock(link), { signal, headers: { 'accept-encoding': 'identity' } });
  if (!res.ok) throw new Error(`upstream ${res.status}`);
  return { size: Number(res.headers.get('content-length')) || 0, body: res.body };
}
