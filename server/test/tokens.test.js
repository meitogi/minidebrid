import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticator, diff, loadTokens, newToken, parseStore, watchTokens, writeStore } from '../src/tokens.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);
const APP = 'app-token-from-env';
const CREATED = '2026-10-09T10:00:00.000Z';

const tempStore = () => join(mkdtempSync(join(tmpdir(), 'tokens-')), 'tokens.json');
const writeJson = (file, obj) => writeFileSync(file, JSON.stringify(obj));
const until = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('missing store : only the implicit APP_TOKEN entry', () => {
  assert.deepEqual(loadTokens(tempStore(), APP), { default: APP });
  assert.deepEqual(loadTokens(tempStore(), undefined), {});
});

test('store merged with APP_TOKEN : names and tokens', () => {
  const file = tempStore();
  writeJson(file, { phone: { token: A, created: CREATED }, laptop: { token: B, created: CREATED } });
  assert.deepEqual(loadTokens(file, APP), { phone: A, laptop: B, default: APP });
  assert.deepEqual(loadTokens(file, ''), { phone: A, laptop: B });
});

test('parseStore rejects what would lock devices out or confuse the CLI', () => {
  const bad = {
    'not JSON': '{',
    'an array': '[]',
    'duplicate token': JSON.stringify({ phone: { token: A, created: CREATED }, laptop: { token: A, created: CREATED } }),
    'reserved name': JSON.stringify({ default: { token: A, created: CREATED } }),
    'unsafe name': JSON.stringify({ 'rm -rf': { token: A, created: CREATED } }),
    'short token': JSON.stringify({ phone: { token: 'abc', created: CREATED } }),
    'bad date': JSON.stringify({ phone: { token: A, created: 'yesterday' } }),
  };
  for (const label in bad) assert.throws(() => parseStore(bad[label]), Error, label);
  assert.throws(() => parseStore(JSON.stringify({ phone: { token: A, created: CREATED } }), A), /APP_TOKEN/);
  assert.deepEqual(parseStore(JSON.stringify({ 'tel_kevin.2': { token: A, created: CREATED } })),
    { 'tel_kevin.2': { token: A, created: CREATED } });
});

test('diff : added and removed with their tokens, a changed token counts as both', () => {
  assert.deepEqual(diff({ phone: A, laptop: B }, { phone: A, tablet: C }), {
    added: { tablet: C },
    removed: { laptop: B },
  });
  assert.deepEqual(diff({ phone: A }, { phone: B }), { added: { phone: B }, removed: { phone: A } });
  assert.deepEqual(diff({ phone: A }, { phone: A }), { added: {}, removed: {} });
});

test('authenticator : token → its name, unknown → null', () => {
  const auth = authenticator({ phone: A, default: APP });
  assert.equal(auth(A), 'phone');
  assert.equal(auth(APP), 'default');
  assert.equal(auth(B), null);
  assert.equal(auth(undefined), null);
  assert.equal(auth('constructor'), null);
});

test('writeStore : atomic, mode 0600, round trip, no temp file left', () => {
  const file = tempStore();
  const entries = { phone: { token: A, created: CREATED } };
  writeStore(file, entries);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(parseStore(readFileSync(file, 'utf8')), entries);
  assert.deepEqual(readdirSync(join(file, '..')), ['tokens.json']);
});

test('newToken : 64 hex, never twice the same', () => {
  const t = newToken();
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.notEqual(newToken(), t);
});

test('watchTokens : reloads on change and on atomic rename, keeps the old set on a malformed file', async () => {
  const file = tempStore();
  writeJson(file, { phone: { token: A, created: CREATED } });
  const initial = loadTokens(file, APP);
  const changes = [];
  const logs = [];
  const watcher = watchTokens(file, APP, initial, (next, d) => changes.push({ next, d }), { delayMs: 30, log: (m) => logs.push(m) });
  try {
    writeJson(file, { phone: { token: A, created: CREATED }, laptop: { token: B, created: CREATED } });
    await until(() => changes.length === 1);
    assert.deepEqual(changes[0].d, { added: { laptop: B }, removed: {} });
    assert.deepEqual(watcher.current(), { phone: A, laptop: B, default: APP });

    writeFileSync(file, '{ "phone": ');
    await until(() => logs.length === 1);
    assert.match(logs[0], /kept 3 tokens/);
    assert.equal(changes.length, 1);
    assert.deepEqual(watcher.current(), { phone: A, laptop: B, default: APP });

    const tmp = `${file}.tmp`;
    writeJson(tmp, { laptop: { token: B, created: CREATED } });
    renameSync(tmp, file);
    await until(() => changes.length === 2);
    assert.deepEqual(changes[1].d, { added: {}, removed: { phone: A } });
    assert.deepEqual(changes[1].next, { laptop: B, default: APP });

    // The rename replaced the inode : a watch on the file itself would miss this one.
    writeJson(file, { laptop: { token: B, created: CREATED }, tablet: { token: C, created: CREATED } });
    await until(() => changes.length === 3);
    assert.deepEqual(changes[2].d, { added: { tablet: C }, removed: {} });
  } finally {
    watcher.close();
  }
});
