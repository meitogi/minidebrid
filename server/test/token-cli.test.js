import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'token.js');
const APP = 'f'.repeat(64);

/** A temp store and .env ; never the real ones. */
function sandbox(envFile = '') {
  const dir = mkdtempSync(join(tmpdir(), 'token-cli-'));
  writeFileSync(join(dir, '.env'), envFile);
  const run = (...args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, TOKENS_FILE: join(dir, 'data', 'tokens.json'), ENV_FILE: join(dir, '.env') },
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const store = () => JSON.parse(readFileSync(join(dir, 'data', 'tokens.json'), 'utf8'));
  return { dir, run, store };
}

test('add : the store holds the entry, stdout the setup link with that exact token', () => {
  const { dir, run, store } = sandbox();
  const r = run('add', 'phone');
  assert.equal(r.code, 0, r.err);
  const entry = store().phone;
  assert.match(entry.token, /^[0-9a-f]{64}$/);
  assert.ok(Date.now() - Date.parse(entry.created) < 60_000);
  assert.ok(r.out.includes(`https://meitogi.github.io/minidebrid/#t=${entry.token}\n`), r.out);
  assert.equal(statSync(join(dir, 'data', 'tokens.json')).mode & 0o777, 0o600);
});

test('add : an existing, reserved or unsafe name is refused and the store is unchanged', () => {
  const { run, store } = sandbox();
  run('add', 'phone');
  const before = store();
  for (const name of ['phone', 'default', 'rm -rf', '']) {
    const r = run('add', name);
    assert.equal(r.code, 1, name);
    assert.equal(r.out, '', name);
  }
  assert.deepEqual(store(), before);
});

test('list : names, dates and links, the APP_TOKEN one marked as such', () => {
  const { run, store } = sandbox(`APP_TOKEN=${APP}\n`);
  run('add', 'phone');
  run('add', 'laptop');
  const tokens = store();
  const r = run('list');
  assert.equal(r.code, 0, r.err);
  for (const name of ['phone', 'laptop']) {
    const line = r.out.split('\n').find((l) => l.startsWith(name + ' '));
    assert.ok(line, `${name} listed`);
    assert.ok(line.includes(tokens[name].created.slice(0, 10)), line);
    assert.ok(line.endsWith(`#t=${tokens[name].token}`), line);
  }
  const implicit = r.out.split('\n').find((l) => l.startsWith('default '));
  assert.match(implicit, /APP_TOKEN/);
  assert.ok(implicit.endsWith(`#t=${APP}`), implicit);
});

test('list : empty store, no APP_TOKEN → says how to add one', () => {
  const r = sandbox().run('list');
  assert.equal(r.code, 0);
  assert.match(r.out, /token add <name>/);
});

test('revoke : removes exactly that entry ; default and unknown names are refused', () => {
  const { run, store } = sandbox(`APP_TOKEN=${APP}\n`);
  run('add', 'phone');
  run('add', 'laptop');
  const laptop = store().laptop;
  const r = run('revoke', 'phone');
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(store(), { laptop });

  const d = run('revoke', 'default');
  assert.equal(d.code, 1);
  assert.match(d.err, /APP_TOKEN/);
  assert.equal(run('revoke', 'nobody').code, 1);
  assert.deepEqual(store(), { laptop });
});

test('link : &r= only for a non-default relay, WEBAPP_URL overrides the base', () => {
  const { run, store } = sandbox('RELAY_URL=wss://relay.example/x\nWEBAPP_URL=https://example.org/app\n');
  const r = run('add', 'phone');
  assert.ok(r.out.includes(`https://example.org/app/#t=${store().phone.token}&r=wss%3A%2F%2Frelay.example%2Fx\n`), r.out);
  const d = sandbox('RELAY_URL=wss://signal.du.ranchchoco.boo\n');
  assert.ok(!d.run('add', 'phone').out.includes('&r='));
});

test('a malformed store is reported, never overwritten', () => {
  const { dir, run } = sandbox();
  run('add', 'phone');
  const file = join(dir, 'data', 'tokens.json');
  writeFileSync(file, '{ broken');
  const r = run('add', 'laptop');
  assert.equal(r.code, 1);
  assert.match(r.err, /tokens\.json/);
  assert.equal(readFileSync(file, 'utf8'), '{ broken');
});

test('an unwritable store directory → a clear message, exit 1, no stack trace', { skip: process.getuid?.() === 0 }, () => {
  const { dir, run } = sandbox();
  mkdirSync(join(dir, 'data'), { mode: 0o500 });
  const r = run('add', 'phone');
  assert.equal(r.code, 1);
  assert.match(r.err, /cannot write .*tokens\.json \(EACCES\)/);
  assert.doesNotMatch(r.err, /at .*\(node:/);
});

test('no or unknown action → usage, exit 1', () => {
  const { run } = sandbox();
  assert.match(run().err, /usage/i);
  assert.equal(run('frobnicate').code, 1);
});
