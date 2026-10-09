import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePortRange, peerIdFromToken } from '../src/peer.js';

// Shared vector : web/src/lib/util.js peerIdFromToken (WebCrypto) must return the same value.
test('peerIdFromToken = srv- + first 16 hex of sha256(token)', () => {
  assert.equal(peerIdFromToken('debrid-remote-test-vector'), 'srv-93ae31c007f77a9b');
});

test('parsePortRange', () => {
  assert.deepEqual(parsePortRange('50000-50019'), [50000, 50019]);
  assert.equal(parsePortRange(''), undefined);
  assert.equal(parsePortRange(undefined), undefined);
  assert.equal(parsePortRange('50000'), undefined);
});
