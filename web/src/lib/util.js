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
