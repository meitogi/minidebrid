import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccess } from '../src/access.js';
import { writeStore } from '../src/tokens.js';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const APP = 'app-token-from-env';
const CREATED = '2026-10-09T10:00:00.000Z';

const tempStore = () => join(mkdtempSync(join(tmpdir(), 'access-')), 'tokens.json');
// Access only ever closes a channel : the double carries `close` and nothing else.
const channel = () => {
  const ch = { closed: 0, close() { ch.closed++; } };
  return ch;
};
const until = async (check, ms = 2000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

test('admit : a listed token → its name, anything else → null', (t) => {
  const file = tempStore();
  writeStore(file, { phone: { token: A, created: CREATED } });
  const access = createAccess({ file, appToken: APP, log: () => {} });
  t.after(() => access.close());
  assert.equal(access.admit(A, channel()), 'phone');
  assert.equal(access.admit(APP, channel()), 'default');
  assert.equal(access.admit(B, channel()), null);
  assert.deepEqual(access.tokens(), { phone: A, default: APP });
});

test('revoking a token closes its live channels only ; a released channel is left alone', async (t) => {
  const file = tempStore();
  writeStore(file, { phone: { token: A, created: CREATED }, laptop: { token: B, created: CREATED } });
  const logs = [];
  const access = createAccess({ file, appToken: APP, delayMs: 30, log: (m) => logs.push(m) });
  t.after(() => access.close());
  const phone1 = channel();
  const phone2 = channel();
  const gone = channel();
  const laptop = channel();
  const app = channel();
  access.admit(A, phone1);
  access.admit(A, phone2);
  access.admit(A, gone);
  access.admit(B, laptop);
  access.admit(APP, app);
  access.release(gone);

  writeStore(file, { laptop: { token: B, created: CREATED } });
  await until(() => phone1.closed > 0);
  assert.deepEqual([phone1.closed, phone2.closed, gone.closed, laptop.closed, app.closed], [1, 1, 0, 0, 0]);
  assert.equal(access.admit(A, channel()), null);
  assert.equal(access.admit(B, channel()), 'laptop');
  assert.ok(logs.some((m) => m.includes('- phone') && m.includes('2 sessions closed')));
  for (const m of logs) assert.ok(!m.includes(A) && !m.includes(B), 'a log line carries a token');

  writeStore(file, { laptop: { token: B, created: CREATED }, phone: { token: A, created: CREATED } });
  await until(() => access.admit(A, channel()) === 'phone');
});

test('a malformed store at start : APP_TOKEN only, logged ; fixed later → picked up', async (t) => {
  const file = tempStore();
  writeFileSync(file, '{ nope');
  const logs = [];
  const access = createAccess({ file, appToken: APP, delayMs: 30, log: (m) => logs.push(m) });
  t.after(() => access.close());
  assert.deepEqual(access.tokens(), { default: APP });
  assert.match(logs[0], /tokens\.json/);
  writeStore(file, { phone: { token: A, created: CREATED } });
  await until(() => access.admit(A, channel()) === 'phone');
});

test('a store directory that does not exist : no watch, still serves APP_TOKEN', (t) => {
  const logs = [];
  const access = createAccess({ file: join(tempStore(), 'missing', 'tokens.json'), appToken: APP, log: (m) => logs.push(m) });
  t.after(() => access.close());
  assert.equal(access.admit(APP, channel()), 'default');
  assert.ok(logs.some((m) => m.includes('not watched')));
});
