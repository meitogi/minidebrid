import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUnlockCache } from '../src/unlock-cache.js';

function counter() {
  const calls = [];
  return { calls, unlock: async (link) => { calls.push(link); return `${link}#${calls.length}`; } };
}

test('get unlocks once, then reads the cache', async () => {
  const { calls, unlock } = counter();
  const cache = createUnlockCache(unlock);
  assert.equal(await cache.get('L'), 'L#1');
  assert.equal(await cache.get('L'), 'L#1');
  assert.deepEqual(calls, ['L']);
});

test('refresh replaces the cached URL ; get then reads the new one without unlocking', async () => {
  const { calls, unlock } = counter();
  const cache = createUnlockCache(unlock);
  await cache.get('L');
  assert.equal(await cache.refresh('L'), 'L#2');
  assert.equal(await cache.get('L'), 'L#2');
  assert.equal(calls.length, 2);
});

test('forget and the TTL both lead to a new unlock', async () => {
  const { calls, unlock } = counter();
  const cache = createUnlockCache(unlock);
  await cache.get('L');
  cache.forget('L');
  assert.equal(await cache.get('L'), 'L#2');
  const expired = createUnlockCache(unlock, -1);
  await expired.get('M');
  await expired.get('M');
  assert.deepEqual(calls.slice(2), ['M', 'M']);
});
