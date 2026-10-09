// Access tokens : the store file written by bin/token.js, plus APP_TOKEN as the implicit `default`.
// Store = {"<name>": {"token": "<64 hex>", "created": "<ISO date>"}}. A token set = {name: token}.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';

export const IMPLICIT = 'default';
export const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/; // safe as a bare shell argument
const TOKEN = /^[0-9a-f]{64}$/;
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

export const newToken = () => randomBytes(32).toString('hex');

/** Store text → entries ; throws with the reason. `appToken` must not reappear in the store. */
export function parseStore(text, appToken) {
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a JSON object');
  const seen = {}; // token → name
  for (const name in data) {
    const entry = data[name];
    if (name === IMPLICIT) throw new Error(`name "${IMPLICIT}" is reserved for APP_TOKEN`);
    if (!NAME.test(name)) throw new Error(`bad name "${name}" (letters, digits, . _ -, 40 max)`);
    const token = entry?.token;
    if (typeof token !== 'string' || !TOKEN.test(token)) throw new Error(`"${name}": token must be 64 hex chars`);
    if (Number.isNaN(Date.parse(entry.created))) throw new Error(`"${name}": bad created date`);
    if (seen[token]) throw new Error(`"${name}" and "${seen[token]}" share the same token`);
    if (token === appToken) throw new Error(`"${name}" holds the APP_TOKEN value`);
    seen[token] = name;
  }
  return data;
}

/** Store file entries ; a missing file is an empty store. Throws on anything malformed. */
export function readStore(file, appToken) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  return parseStore(text, appToken);
}

/** Token set {name: token} : the store plus APP_TOKEN as `default` when set. */
export function loadTokens(file, appToken) {
  const entries = readStore(file, appToken);
  const set = {};
  for (const name in entries) set[name] = entries[name].token;
  if (appToken) set[IMPLICIT] = appToken;
  return set;
}

/** previous → next : {added, removed}, each {name: token} ; a changed token is in both. */
export function diff(previous, next) {
  const added = {};
  const removed = {};
  for (const name in next) if (previous[name] !== next[name]) added[name] = next[name];
  for (const name in previous) if (next[name] !== previous[name]) removed[name] = previous[name];
  return { added, removed };
}

/** token → name of the set entry holding it, or null. Lookup by sha256, never by the raw token. */
export function authenticator(set) {
  const byDigest = {};
  for (const name in set) byDigest[sha256(set[name])] = name;
  return (token) => {
    if (typeof token !== 'string') return null;
    const key = sha256(token);
    return Object.hasOwn(byDigest, key) ? byDigest[key] : null;
  };
}

/** Atomic write (temp file + rename in the same directory), mode 0600. */
export function writeStore(file, entries) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Watches the store's directory (an atomic rename replaces the file's inode, which a watch on
 * the file itself would lose) and calls `onChange(next, {added, removed})` after each effective
 * change, debounced. A malformed store keeps the current set and logs why.
 */
export function watchTokens(file, appToken, initial, onChange, { delayMs = 300, log = console.log } = {}) {
  const name = basename(file);
  let current = initial;
  let timer = null;

  function reload() {
    let next;
    try { next = loadTokens(file, appToken); } catch (e) {
      let count = 0;
      for (const _ in current) count++;
      return log(`tokens: ${file} ignored (${e.message}), kept ${count} tokens`);
    }
    const changes = diff(current, next);
    const { added, removed } = changes;
    let changed = false;
    for (const _ in added) changed = true;
    for (const _ in removed) changed = true;
    if (!changed) return;
    current = next;
    onChange(next, changes);
  }

  const watcher = watch(dirname(file), (_event, filename) => {
    if (filename && filename !== name) return;
    clearTimeout(timer);
    timer = setTimeout(reload, delayMs);
  });
  return {
    current: () => current,
    close() { clearTimeout(timer); watcher.close(); },
  };
}
