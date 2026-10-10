import { test } from 'node:test';
import assert from 'node:assert/strict';
import { episodeLabel } from '../lib/release.js';
import { flattenFiles, formatSize, isExtra, matches, matchesEpisode, sortMagnets } from '../lib/util.js';

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

test('matches : case, accents, dots and every word', () => {
  assert.equal(matches('Le.Caméléon.S01.FRENCH', 'cameleon'), true);
  assert.equal(matches('Le.Caméléon.S01.FRENCH', 'LE CAMÉLÉON french'), true);
  assert.equal(matches('Breaking_Bad.S05', 'breaking bad'), true);
  assert.equal(matches('Breaking.Bad.S05', 'breaking dead'), false);
  assert.equal(matches('anything', ''), true);
  assert.equal(matches('anything', '   '), true);
});

// A season pack : 3 seasons × 12 episodes, episode 4 of season 2 titled.
function pack() {
  const files = [];
  for (let s = 1; s <= 3; s++) {
    for (let e = 1; e <= 12; e++) {
      const tag = `S0${s}E${String(e).padStart(2, '0')}`;
      const name = s === 2 && e === 4 ? `Show.${tag}.The.Pilot.Returns.1080p.mkv` : `Show.${tag}.1080p.WEB.mkv`;
      files.push({ path: `Season ${s}/${name}`, name });
    }
  }
  return files.map((f) => ({ ...f, label: episodeLabel(f, 'Show Complete') }));
}
const search = (files, q) => files
  .filter((f) => matchesEpisode(`${f.path} ${f.label?.series ?? ''} ${f.label?.title ?? ''}`, f.label, q))
  .map((f) => f.label.code);

test('matchesEpisode : episode numbers in every usual spelling', () => {
  const files = pack();
  assert.deepEqual(search(files, 's2e5'), ['S02E05']);
  assert.deepEqual(search(files, 'S02E05'), ['S02E05']);
  assert.deepEqual(search(files, '2x05'), ['S02E05']);
  assert.deepEqual(search(files, 'e5'), ['S01E05', 'S02E05', 'S03E05']);
  assert.deepEqual(search(files, 'ep 5'), ['S01E05', 'S02E05', 'S03E05']);
  assert.equal(search(files, 's2').length, 12);
  assert.ok(search(files, 'saison 2').every((c) => c.startsWith('S02')));
  assert.equal(search(files, 'season 3').length, 12);
  assert.deepEqual(search(files, 's2 e5'), ['S02E05']);
});

test('matchesEpisode : episode titles and plain words, numbers as text too', () => {
  const files = pack();
  assert.deepEqual(search(files, 'pilot'), ['S02E04']);
  assert.deepEqual(search(files, 's2 pilot'), ['S02E04']);
  assert.deepEqual(search(files, 's1 pilot'), []);
  assert.equal(search(files, '1080p').length, 36);
  assert.equal(search(files, '').length, 36);
  const op = [{ path: 'One.Piece.E1071.mkv', name: 'One.Piece.E1071.mkv' }].map((f) => ({ ...f, label: episodeLabel(f, 'One Piece') }));
  assert.deepEqual(search(op, '1071'), ['1071']);
  assert.deepEqual(search(op, 'e1071'), ['1071']);
  const plain = [{ path: 'Extras/Making of 2019.mp4', name: 'Making of 2019.mp4', label: null }];
  assert.equal(matchesEpisode(plain[0].path, null, '2019'), true);
  assert.equal(matchesEpisode(plain[0].path, null, 's1e1'), false);
});

test('isExtra : the usual side files and samples, never subtitles', () => {
  for (const path of ['a.nfo', 'b.TXT', 'c.sfv', 'd.md5', 'e.url', 'f.jpg', 'g.jpeg', 'h.png', 'Sample/x.mkv', 'x.sample.mkv', 'Show-sample.mp4']) {
    assert.equal(isExtra(path), true, path);
  }
  for (const path of ['ep.mkv', 'ep.fr.srt', 'ep.ass', 'sampler.mkv', 'Samples of life.mkv', 'notes.txt.mkv']) {
    assert.equal(isExtra(path), false, path);
  }
});
