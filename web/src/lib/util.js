// Pure helpers shared by the UI and `node --test` (no DOM, no Svelte).

/**
 * Alldebrid `/v4/magnet/files` tree → flat list. Leaf `{n, s, l}`, folder `{n, e: [...]}`.
 * Ported from collectFiles in apps/media-sorter/src/alldebrid.js.
 */
export function flattenFiles(entries, prefix = '') {
  const files = [];
  for (const entry of entries ?? []) {
    const name = entry.n;
    if (entry.e) {
      for (const file of flattenFiles(entry.e, `${prefix}${name}/`)) files.push(file);
    } else {
      files.push({ path: prefix + name, name, size: entry.s ?? 0, link: entry.l });
    }
  }
  return files;
}

/** `srv-` + 16 hex chars of sha256(token) — same value as server/src/peer.js. */
export async function peerIdFromToken(token) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const bytes = new Uint8Array(hash);
  let hex = '';
  for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return 'srv-' + hex;
}

const UNITS = ['o', 'Ko', 'Mo', 'Go', 'To'];

/** 1536 → '1,5 Ko' ; binary multiples, French units. */
export function formatSize(bytes) {
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toFixed(digits).replace('.', ',')} ${UNITS[unit]}`;
}

/** Ready magnets (statusCode 4) first, then newest upload first. Returns a new array. */
export function sortMagnets(magnets) {
  return [...(magnets ?? [])].sort((a, b) => (b.statusCode === 4) - (a.statusCode === 4) || (b.uploadDate ?? 0) - (a.uploadDate ?? 0));
}
