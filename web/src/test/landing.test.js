import { test } from 'node:test';
import assert from 'node:assert/strict';
import { landing, magnetFromHash, parseHash, validRelay } from '../lib/landing.js';

const T = '0123456789abcdef'.repeat(4);

test('parseHash : a setup link gives the token and the relay', () => {
  assert.deepEqual(parseHash(`#t=${T}`), { token: T, relay: null });
  assert.deepEqual(parseHash(`#t=${T}&r=wss%3A%2F%2Frelay.example%2Fx`), { token: T, relay: 'wss://relay.example/x' });
  assert.deepEqual(parseHash(`#r=wss://relay.example&t=${T}`), { token: T, relay: 'wss://relay.example' });
});

test('parseHash : percent-encoding decoded, unknown keys ignored, first value wins', () => {
  assert.deepEqual(parseHash('#t=a%20b%2Bc&x=1&utm=y'), { token: 'a b+c', relay: null });
  assert.deepEqual(parseHash(`#t=${T}&t=other`), { token: T, relay: null });
});

test('parseHash : an empty or undecodable token is a setup request, not a link', () => {
  assert.deepEqual(parseHash('#t='), { setup: true });
  assert.deepEqual(parseHash('#t=%20'), { setup: true });
  assert.deepEqual(parseHash('#t=%E0%A4%A'), { setup: true });
});

test('parseHash : #setup, and no hash or a foreign one', () => {
  assert.deepEqual(parseHash('#setup'), { setup: true });
  assert.equal(parseHash(''), null);
  assert.equal(parseHash('#'), null);
  assert.equal(parseHash(undefined), null);
  assert.equal(parseHash('#section-2'), null);
});

test('a link cannot point a device at an arbitrary relay', () => {
  assert.equal(validRelay('wss://signal.du.ranchchoco.boo'), 'wss://signal.du.ranchchoco.boo');
  assert.equal(validRelay('ws://localhost:18787'), 'ws://localhost:18787');
  assert.equal(validRelay('ws://127.0.0.1:18787'), 'ws://127.0.0.1:18787');
  for (const bad of ['ws://evil.example', 'https://relay.example', 'javascript:alert(1)', 'wss:/', 'nope', '', undefined]) {
    assert.equal(validRelay(bad), null, String(bad));
  }
  assert.deepEqual(parseHash(`#t=${T}&r=ws%3A%2F%2Fevil.example`), { token: T, relay: null });
});

test('landing : link, setup, app or redirect', () => {
  assert.equal(landing({ hash: `#t=${T}`, savedToken: '' }), 'link');
  assert.equal(landing({ hash: `#t=${T}`, savedToken: 'other' }), 'link');
  assert.equal(landing({ hash: '#setup', savedToken: '' }), 'setup');
  assert.equal(landing({ hash: '#setup', savedToken: T }), 'setup');
  assert.equal(landing({ hash: '#t=', savedToken: '' }), 'setup');
  assert.equal(landing({ hash: '', savedToken: T }), 'app');
  assert.equal(landing({ hash: '#section-2', savedToken: T }), 'app');
  assert.equal(landing({ hash: '', savedToken: '' }), 'redirect');
  assert.equal(landing({ hash: '', savedToken: '   ' }), 'redirect');
  assert.equal(landing({ hash: '', savedToken: null }), 'redirect');
});

test('magnetFromHash : the magnet id of #m=<id>, else null ; landing treats it as app or redirect', () => {
  assert.equal(magnetFromHash('#m=123'), '123');
  assert.equal(magnetFromHash('#m=123&x=1'), '123');
  assert.equal(magnetFromHash('#m=abc'), null);
  assert.equal(magnetFromHash(`#t=${T}`), null);
  assert.equal(magnetFromHash(''), null);
  assert.equal(magnetFromHash(undefined), null);
  assert.equal(landing({ hash: '#m=123', savedToken: T }), 'app');
  assert.equal(landing({ hash: '#m=123', savedToken: '' }), 'redirect');
});
