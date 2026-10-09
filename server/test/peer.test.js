import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePortRange } from '../src/peer.js';

test('parsePortRange', () => {
  assert.deepEqual(parsePortRange('50000-50019'), [50000, 50019]);
  assert.equal(parsePortRange(''), undefined);
  assert.equal(parsePortRange(undefined), undefined);
  assert.equal(parsePortRange('50000'), undefined);
});
