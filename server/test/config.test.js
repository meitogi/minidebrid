import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingEnv, streamSecret } from '../src/config.js';
import { signToken, streamUrlBuilder, verifyToken } from '../src/stream-token.js';

const LINK = 'https://alldebrid.com/f/abc123';
const BASE = { ALLDEBRID_APIKEY: 'k', PUBLIC_URL: 'https://debrid.example', RELAY_URL: 'wss://relay.example' };

test('streamSecret : STREAM_SECRET, else APP_TOKEN, else null', () => {
  assert.equal(streamSecret({ STREAM_SECRET: 'stream', APP_TOKEN: 'app' }), 'stream');
  assert.equal(streamSecret({ APP_TOKEN: 'app' }), 'app');
  assert.equal(streamSecret({ STREAM_SECRET: '', APP_TOKEN: 'app' }), 'app');
  assert.equal(streamSecret({}), null);
});

test('a link issued with the stream secret verifies ; one signed with a user token does not', async () => {
  const secret = streamSecret({ ...BASE, STREAM_SECRET: 'stream', APP_TOKEN: 'app' });
  const { url } = await streamUrlBuilder(BASE.PUBLIC_URL, secret)(LINK, 'film.mkv');
  const tok = url.split('/')[4];
  assert.match(url, /^https:\/\/debrid\.example\/s\/[^/]+\/film\.mkv$/);
  assert.equal(verifyToken(tok, secret), LINK);
  assert.equal(verifyToken(signToken(LINK, 'a'.repeat(64)).tok, secret), null);
});

test('migration : APP_TOKEN-signed links verify until STREAM_SECRET is set, then stop', () => {
  const old = signToken(LINK, 'app').tok;
  assert.equal(verifyToken(old, streamSecret({ APP_TOKEN: 'app' })), LINK);
  assert.equal(verifyToken(old, streamSecret({ STREAM_SECRET: 'stream', APP_TOKEN: 'app' })), null);
});

test('missingEnv : a stream secret is required, a token is not', () => {
  assert.deepEqual(missingEnv({ ...BASE, STREAM_SECRET: 's' }), []);
  assert.deepEqual(missingEnv({ ...BASE, APP_TOKEN: 'a' }), []);
  assert.deepEqual(missingEnv(BASE), ['STREAM_SECRET (or APP_TOKEN)']);
  assert.deepEqual(missingEnv({ STREAM_SECRET: 's' }), ['ALLDEBRID_APIKEY', 'PUBLIC_URL', 'RELAY_URL']);
});
