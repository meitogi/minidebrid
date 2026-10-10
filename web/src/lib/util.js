// Pure helpers shared by the UI and `node --test` (no DOM, no Svelte).

import { VIDEO_EXT_RE } from './release.js';

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

/** Search form of a string : no accents, lower case, `.` and `_` as spaces. */
export function normalize(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[._]+/g, ' ');
}

const terms = (query) => normalize(query)
  .replace(/\b(saison|season|episode|ep)\s+(\d)/g, '$1$2') // "saison 2", "ep 5" : one term
  .split(/\s+/)
  .filter(Boolean);

/** Every word of `query` appears in `text` ; an empty query matches. */
export function matches(text, query) {
  const hay = normalize(text);
  for (const term of terms(query)) if (!hay.includes(term)) return false;
  return true;
}

/**
 * `matches`, plus episode numbers read against `label` (release.js episodeLabel, or null) :
 * s2e5 / s02e05 / 2x05, e5 / ep5 / episode5, s2 / saison2 / season2, and a bare number as an
 * episode, an absolute number or plain text.
 */
export function matchesEpisode(text, label, query) {
  const hay = normalize(text);
  const season = label?.season ?? null;
  const episode = label?.episode ?? null;
  const absolute = label?.absolute ?? null;
  for (const term of terms(query)) {
    let m;
    if ((m = /^s(\d{1,2})e(\d{1,4})$/.exec(term) ?? /^(\d{1,2})x(\d{1,4})$/.exec(term))) {
      if (season !== Number(m[1]) || episode !== Number(m[2])) return false;
    } else if ((m = /^(?:e|ep|episode)(\d{1,4})$/.exec(term))) {
      const n = Number(m[1]);
      if (episode !== n && absolute !== n) return false;
    } else if ((m = /^(?:s|saison|season)(\d{1,2})$/.exec(term))) {
      if (season !== Number(m[1])) return false;
    } else if (/^\d+$/.test(term)) {
      const n = Number(term);
      if (episode !== n && absolute !== n && !hay.includes(term)) return false;
    } else if (!hay.includes(term)) {
      return false;
    }
  }
  return true;
}

const EXTRA_EXT = /\.(nfo|txt|sfv|md5|url|jpe?g|png)$/i;
const SAMPLE = /(^|[/ ._-])sample([/ ._-]|$)/i;

/** Side files hidden by default : info / checksum / link / image files, and sample videos. */
export function isExtra(path) {
  return EXTRA_EXT.test(path) || (VIDEO_EXT_RE.test(path) && SAMPLE.test(path));
}

/** [head, tail] : the tail (last `n` characters, extension included) stays visible when the head is cut. */
export function cutTail(text, n = 12) {
  const at = Math.max(0, text.length - n);
  return [text.slice(0, at), text.slice(at)];
}
