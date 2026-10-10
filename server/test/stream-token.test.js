import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, streamUrlBuilder, verifyToken } from '../src/stream-token.js';

const SECRET = 'test-secret';
const LINK = 'https://alldebrid.com/f/abc123';

test('round trip returns the link', () => {
  const { tok, expires } = signToken(LINK, SECRET, 60_000, 1000);
  assert.equal(expires, 61_000);
  assert.equal(verifyToken(tok, SECRET, 2000), LINK);
});

test('tampered signature is rejected', () => {
  const { tok } = signToken(LINK, SECRET);
  const last = tok.at(-1) === 'A' ? 'B' : 'A';
  assert.equal(verifyToken(tok.slice(0, -1) + last, SECRET), null);
});

test('tampered payload is rejected', () => {
  const { tok } = signToken(LINK, SECRET);
  const [, sig] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ l: 'https://evil', e: Date.now() + 1e9 })).toString('base64url');
  assert.equal(verifyToken(`${forged}.${sig}`, SECRET), null);
});

test('wrong secret is rejected', () => {
  assert.equal(verifyToken(signToken(LINK, SECRET).tok, 'other'), null);
});

test('expired token is rejected', () => {
  const { tok } = signToken(LINK, SECRET, 1000, 0);
  assert.equal(verifyToken(tok, SECRET, 1000), null);
});

test('garbage is rejected', () => {
  assert.equal(verifyToken('nodot', SECRET), null);
  assert.equal(verifyToken('.abc', SECRET), null);
});

test('the link ends with the original file name, percent-encoded', async () => {
  const name = 'Série S01E05 – l’été.mkv';
  const { url } = await streamUrlBuilder('https://debrid.example/', SECRET)(LINK, name);
  assert.ok(url.startsWith('https://debrid.example/s/'));
  assert.ok(url.endsWith(`/${encodeURIComponent(name)}`));
  assert.equal(decodeURIComponent(url.slice(url.lastIndexOf('/') + 1)), name);
});
