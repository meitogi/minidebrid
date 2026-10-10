import { test } from 'node:test';
import assert from 'node:assert/strict';
import { episodeLabel, parse, seasonFromPath, withContext } from '../lib/release.js';

const cases = [
  ['Severance.S02E03.1080p.WEB-DL.x264-GRP.mkv',
    { title: 'Severance', season: 2, episode: 3, absolute: null, year: null, ext: 'mkv' }],
  ['the.last.of.us.s1e5.720p.mp4',
    { title: 'the last of us', season: 1, episode: 5, absolute: null, year: null, ext: 'mp4' }],
  ['Breaking Bad 1x05 HDTV.avi',
    { title: 'Breaking Bad', season: 1, episode: 5, absolute: null, year: null, ext: 'avi' }],
  ['Fallout.Season.1.Episode.8.2160p.mkv',
    { title: 'Fallout', season: 1, episode: 8, absolute: null, year: null, ext: 'mkv' }],
  ['Hunter x Hunter (2011) S01E01.mkv',
    { title: 'Hunter x Hunter', season: 1, episode: 1, absolute: null, year: 2011, ext: 'mkv' }],
  ['Shogun.2024.S01E05.MULTI.1080p.WEB.x265-TEAM.mkv',
    { title: 'Shogun', season: 1, episode: 5, absolute: null, year: 2024, ext: 'mkv' }],
  // Multi-episode: first one wins; season pack marker alone gives season only.
  ['Dark.S03E07E08.German.1080p.mkv',
    { title: 'Dark', season: 3, episode: 7, absolute: null, year: null, ext: 'mkv' }],
  ['Bref.S02.FRENCH.1080p.WEBrip.x265-TyHD.mkv',
    { title: 'Bref', season: 2, episode: null, absolute: null, year: null, ext: 'mkv' }],
  // One Piece: flat absolute numbering; SxxEyy markers are fansub noise.
  ['One.Piece.E1071.VOSTFR.1080p.mkv',
    { title: 'One Piece', season: null, episode: null, absolute: 1071, year: null, ext: 'mkv' }],
  ["0892 One Piece S21E001 Multi ''Le Pays De Wa !'' ... Webdl1080p ! 2019.mkv",
    { title: 'One Piece', season: null, episode: null, absolute: 892, year: 2019, ext: 'mkv' }],
  ['[Judas] One Piece - 1071 [1080p][HEVC x265].mkv',
    { title: 'One Piece', season: null, episode: null, absolute: 1071, year: null, ext: 'mkv' }],
  ['One Piece (1999) - 0996 VOSTFR.mkv',
    { title: 'One Piece', season: null, episode: null, absolute: 996, year: 1999, ext: 'mkv' }],
  // Episode-only marker, no season.
  ['[Elecman] Love Hina E11 [BDRIP][1080p x264 Multi].mkv',
    { title: 'Love Hina', season: null, episode: 11, absolute: null, year: null, ext: 'mkv' }],
  // Marker at position 0 or leading episode number: title comes from context.
  ['S01E08 - PREMIER NOËL DE JAROD.mkv',
    { title: '', season: 1, episode: 8, absolute: null, year: null, ext: 'mkv' }],
  ['10. Le plan Savage Guardian (Direction la cour !) I.mkv',
    { title: '', season: null, episode: 10, absolute: null, year: null, ext: 'mkv' }],
  // Flat "Series NNN Episode title" (Dragon Ball style).
  ['Dragon Ball 006 Les visiteurs de la nuit.mkv',
    { title: 'Dragon Ball', season: null, episode: 6, absolute: null, year: null, ext: 'mkv' }],
  // …but a trailing number with nothing after it stays a movie title.
  ['Apollo 13.mkv',
    { title: 'Apollo 13', season: null, episode: null, absolute: null, year: null, ext: 'mkv' }],
  // Movies.
  ['Oppenheimer.2023.1080p.WEB-DL.x264-GROUP.mkv',
    { title: 'Oppenheimer', season: null, episode: null, absolute: null, year: 2023, ext: 'mkv' }],
  ['2012.2009.1080p.BluRay.mkv',
    { title: '2012', season: null, episode: null, absolute: null, year: 2009, ext: 'mkv' }],
  ['Arrête-moi si tu peux (Catch Me If You Can) (2002) MULTI VFF 1080p.mkv',
    { title: 'Arrête-moi si tu peux', season: null, episode: null, absolute: null, year: 2002, ext: 'mkv' }],
  // Real title after the year (collection naming).
  ['Asterix - 1967 - Asterix Le Gaulois - 1080p.mkv',
    { title: 'Asterix Le Gaulois', season: null, episode: null, absolute: null, year: 1967, ext: 'mkv' }],
  ["Les.12.Travaux.D'Astérix.1976.RESTAUREE.1080p.BluRay.HEVC.DTS.AZAZE.mkv",
    { title: "Les 12 Travaux D'Astérix", season: null, episode: null, absolute: null, year: 1976, ext: 'mkv' }],
  // Post-year rewrite must NOT fire on series names.
  ['STARGATE SG-1 (1997)_S01E01E02_ MULTI.1080P.BLURAY.X265.AC3.mkv',
    { title: 'STARGATE SG-1', season: 1, episode: 1, absolute: null, year: 1997, ext: 'mkv' }],
  ['[ Torrent911.tv ] Man Of Steel 2013 MULTi VFF AC3 1080p HDLight x264.mkv',
    { title: 'Man Of Steel', season: null, episode: null, absolute: null, year: 2013, ext: 'mkv' }],
  // Accented titles must not trigger ASCII word-boundary tag matches (CAM).
  ['Le caméléon',
    { title: 'Le caméléon', season: null, episode: null, absolute: null, year: null, ext: null }],
  // Article stub left when the cut lands after "L'".
  ["Harry.Potter.L'Integrale.MULTI.1080p",
    { title: 'Harry Potter', season: null, episode: null, absolute: null, year: null, ext: null }],
  // Version Longue is release noise, not title.
  ['Le.Hobbit.Un.Voyage.Inattendu.Version.Longue.2012.MULTI.1080p.HDLight.AC3.x264-gismo65.mkv',
    { title: 'Le Hobbit Un Voyage Inattendu', season: null, episode: null, absolute: null, year: 2012, ext: 'mkv' }],
  // Dash-delimited episode number (fansub naming).
  ['[lost108] BLEACH - Sennen Kessen-hen - 41 - God of Thunder - VOSTFR - 1080p.mkv',
    { title: 'BLEACH - Sennen Kessen-hen', season: null, episode: 41, absolute: null, year: null, ext: 'mkv' }],
  // "Season NN" pack marker without episode.
  ['One Piece Season 21 VOSTFR 1080p',
    { title: 'One Piece', season: 21, episode: null, absolute: null, year: null, ext: null }],
];

for (const [input, expected] of cases) {
  test(input, () => {
    const got = parse(input);
    assert.deepEqual(
      { title: got.title, season: got.season, episode: got.episode, absolute: got.absolute, year: got.year, ext: got.ext },
      expected,
    );
  });
}

// ── Flat numbering wins over every other season signal ────────────────────
// The season is always recomputed from the absolute number, so any SxxEyy in
// the name, any "Saison NN" folder and any magnet context must be discarded.

test('un SxxEyy fansub ne masque pas le numéro flat', () => {
  for (const [input, absolute] of [
    ['One.Piece.S21E13.628.VOSTFR.1080p.mkv', 628],
    ['One.Piece.S01E1171.MULTI.1080p.mkv', 1171],
    ['[Erai-raws] One Piece - 1180 [1080p][MULTIPLE-SUBTITLE].mkv', 1180],
  ]) {
    const got = parse(input);
    assert.equal(got.absolute, absolute, input);
    assert.equal(got.season, null, input);
    assert.equal(got.episode, null, input);
  }
});

test('la saison du dossier et celle du magnet sont écartées', () => {
  const fp = parse('One Piece 628.mkv');
  fp.season ??= seasonFromPath('One Piece/Saison 21/One Piece 628.mkv');
  assert.equal(fp.season, 21, 'seasonFromPath la détecte bien…');

  const merged = withContext(fp, parse('One Piece Saison 21 COMPLETE VOSTFR'));
  assert.equal(merged.absolute, 628, '…mais le flat reste la seule autorité');
  assert.equal(merged.season, null);
  assert.equal(merged.episode, null);
});

test('notre propre sortie se re-parse — le renommage est idempotent', () => {
  const got = parse('One Piece 628 - (S16E50).mkv');
  assert.equal(got.absolute, 628);
  assert.equal(got.season, null);
  assert.equal(got.title, 'One Piece');
});

// ── debrid-remote : episode title and the label shown in the file list ─────

test('episodeTitle : the text after the episode marker, when there is one', () => {
  for (const [input, title] of [
    ['S01E08 - PREMIER NOËL DE JAROD.mkv', 'PREMIER NOËL DE JAROD'],
    ['Show.S01E02.The.Pilot.1080p.WEB.mkv', 'The Pilot'],
    ['[lost108] BLEACH - Sennen Kessen-hen - 41 - God of Thunder - VOSTFR - 1080p.mkv', 'God of Thunder'],
    ['10. Le plan Savage Guardian (Direction la cour !) I.mkv', 'Le plan Savage Guardian I'],
    ['Dragon Ball 006 Les visiteurs de la nuit.mkv', 'Les visiteurs de la nuit'],
    ['Severance.S02E03.1080p.WEB-DL.x264-GRP.mkv', null],
    ['Show.S01E02.FRENCH.1080p.mkv', null],
    ['Shogun.2024.S01E05.MULTI.1080p.WEB.x265-TEAM.mkv', null],
    ['[Elecman] Love Hina E11 [BDRIP][1080p x264 Multi].mkv', null],
    ['Show.S01E02.mkv', null],
    ['Oppenheimer.2023.1080p.WEB-DL.x264-GROUP.mkv', null],
  ]) {
    assert.equal(parse(input).episodeTitle, title, input);
  }
});

test('episodeLabel : series from the magnet when the file lacks it, season from the folder', () => {
  assert.deepEqual(
    episodeLabel({ path: 'Saison 1/S01E08 - PREMIER NOËL DE JAROD.mkv', name: 'S01E08 - PREMIER NOËL DE JAROD.mkv' }, 'Le Caméléon Saison 1 FRENCH'),
    { series: 'Le Caméléon', season: 1, episode: 8, absolute: null, code: 'S01E08', title: 'PREMIER NOËL DE JAROD' },
  );
  assert.deepEqual(
    episodeLabel({ path: 'Saison 3/10. Le plan Savage.mkv', name: '10. Le plan Savage.mkv' }, 'Les Gardiens'),
    { series: 'Les Gardiens', season: 3, episode: 10, absolute: null, code: 'S03E10', title: 'Le plan Savage' },
  );
  assert.deepEqual(
    episodeLabel({ path: 'Severance.S02E03.1080p.WEB-DL.x264-GRP.mkv', name: 'Severance.S02E03.1080p.WEB-DL.x264-GRP.mkv' }, 'Severance S02'),
    { series: 'Severance', season: 2, episode: 3, absolute: null, code: 'S02E03', title: null },
  );
});

test('episodeLabel : One Piece absolute, subtitles and movies have no label', () => {
  assert.deepEqual(
    episodeLabel({ path: 'One.Piece.E1071.VOSTFR.1080p.mkv', name: 'One.Piece.E1071.VOSTFR.1080p.mkv' }, 'One Piece'),
    { series: 'One Piece', season: null, episode: null, absolute: 1071, code: '1071', title: null },
  );
  assert.equal(episodeLabel({ path: 'Subs/S01E01.fr.srt', name: 'S01E01.fr.srt' }, 'Show'), null);
  assert.equal(episodeLabel({ path: 'Oppenheimer.2023.1080p.mkv', name: 'Oppenheimer.2023.1080p.mkv' }, 'Oppenheimer'), null);
});
