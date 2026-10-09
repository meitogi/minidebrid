import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenFiles, formatSize, peerIdFromToken, sortMagnets } from '../lib/util.js';

test('peerIdFromToken matches the server vector', async () => {
  assert.equal(await peerIdFromToken('debrid-remote-test-vector'), 'srv-93ae31c007f77a9b');
});

test('flattenFiles walks nested folders and keeps size and link', () => {
  const tree = [
    { n: 'a', e: [
      { n: 'b', e: [{ n: 'c.mkv', s: 1234567, l: 'https://alldebrid.com/f/c' }] },
      { n: 'readme.nfo', s: 12, l: 'https://alldebrid.com/f/nfo' },
    ] },
    { n: 'top.srt', s: 900, l: 'https://alldebrid.com/f/srt' },
  ];
  assert.deepEqual(flattenFiles(tree), [
    { path: 'a/b/c.mkv', name: 'c.mkv', size: 1234567, link: 'https://alldebrid.com/f/c' },
    { path: 'a/readme.nfo', name: 'readme.nfo', size: 12, link: 'https://alldebrid.com/f/nfo' },
    { path: 'top.srt', name: 'top.srt', size: 900, link: 'https://alldebrid.com/f/srt' },
  ]);
});

test('flattenFiles : missing size → 0, empty or missing tree → []', () => {
  assert.deepEqual(flattenFiles([{ n: 'x', l: 'L' }]), [{ path: 'x', name: 'x', size: 0, link: 'L' }]);
  assert.deepEqual(flattenFiles([]), []);
  assert.deepEqual(flattenFiles(undefined), []);
});

test('formatSize', () => {
  assert.equal(formatSize(0), '0 o');
  assert.equal(formatSize(1023), '1023 o');
  assert.equal(formatSize(1536), '1,5 Ko');
  assert.equal(formatSize(868 * 1024 * 1024), '868 Mo');
  assert.equal(formatSize(4.2 * 1024 ** 3), '4,2 Go');
  assert.equal(formatSize(undefined), '0 o');
});

test('sortMagnets : ready first, then newest, input untouched', () => {
  const input = [
    { id: 1, statusCode: 1, uploadDate: 300 },
    { id: 2, statusCode: 4, uploadDate: 100 },
    { id: 3, statusCode: 4, uploadDate: 200 },
    { id: 4, statusCode: 7, uploadDate: 400 },
  ];
  assert.deepEqual(sortMagnets(input).map((m) => m.id), [3, 2, 4, 1]);
  assert.deepEqual(input.map((m) => m.id), [1, 2, 3, 4]);
  assert.deepEqual(sortMagnets(undefined), []);
});
