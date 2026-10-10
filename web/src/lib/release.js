// Release-name parser : title / year / season / episode (or One Piece's flat absolute number).
// Ported from apps/media-sorter/src/parse.js (its tests run here too, test/release.test.js) ;
// additions marked "debrid-remote" : episodeTitle, episodeLabel.

export const VIDEO_EXT_RE = /\.(mkv|mp4|avi|m4v|mov|wmv|ts|webm)$/i;

// Season/episode markers, tried in order.
const SE_RES = [
  /\bS(\d{1,2})[ .\-]?E(\d{1,4})/i,               // S01E05, S01.E05, s1e5, S01E05E06
  /\b(\d{1,2})x(\d{2,3})\b/,                       // 1x05
  /\bSeason[ ._]?(\d{1,2})[ ._\-]*(?:Episode|Ep)[ ._]?(\d{1,4})/i,
];
// Season-only marker (season packs: "Bref.S01.FRENCH…", "One Piece Season 21").
const SEASON_ONLY_RE = /\b(?:Season|Saison)[ ._-]?(\d{1,2})\b|\bS(\d{1,2})\b/i;

// Shows using flat absolute numbering. Their SxxEyy markers are unreliable
// (fansub season splits never agree) and are IGNORED: only the flat episode
// number counts.
const ABSOLUTE_SHOWS_RE = /one[ ._\-]?piece/i;

// Release tags: everything from the first tag onward is noise for the title.
// ASCII \b is unusable here: accented letters create false word boundaries
// ("caméléon" would match CAM), hence the explicit letter/digit lookarounds.
const TAG_RE = /(?<![A-Za-zÀ-ÿ0-9])(2160p|1080p|720p|576p|480p|4K|WEB[ .\-]?DL|WEBRip|WEB|BluRay|Blu-Ray|BDRip|BRRip|HDTV|HDRip|DVDRip|CAM|REMUX|HDLight|4KLight|mHD|x264|x265|h\.?264|h\.?265|HEVC|AVC|XviD|AAC(?:\d\.\d)?|AC-?3|EAC-?3|DDP?\d?\.?\d?|DTS(?:[ .-]?HD)?(?:[ .-]?MA)?|TrueHD|Atmos|Opus|FLAC|MP3|\d+CH|10bits?|8bits?|HDR10(?:Plus|\+)?|HDR|DoVi|DOLBY[ .]?VISION|DV|SDR|VOSTFR|VOSTA|VOSTF?|VF[FQI]?2?|VOF|VO|MULTI|MULTi|TRUEFRENCH|FRENCH|FR|ENG?|SUBBED|SUBFRENCH|UNCENSORED|REPACK|PROPER|INTERNAL|EXTENDED|UNRATED|REMASTERED|RESTAUREE|RESTORED|CUSTOM|COMPLETE|INT[EÉ]GRALE|VERSION[ .]?LONGUE|DUAL[ .]?AUDIO|DUBBED|TRILOGIE|TRILOGY|DUOLOGY|COLLECTION|FINAL|LIMITED|iNT|MAX|AD)(?![A-Za-zÀ-ÿ0-9])/i;

const YEAR_RE = /\b(19|20)\d{2}\b/g;

const cleanTitle = (s) => s
  .replace(/\([^)]*\)/g, ' ')   // parenthesized alt titles / groups
  .replace(/\[[^\]]*\]/g, ' ')
  .replace(/['’]{2}/g, ' ')
  .replace(/[()[\]]/g, ' ')     // orphans left when the cut lands mid-group
  .replace(/\s+/g, ' ')
  .replace(/^[\s\-–!]+|[\s\-–!'’]+$/g, '')
  .replace(/\s[LlDd]['’]?$/, '') // article stub left by a cut ("Harry Potter L'…")
  .trim();

/**
 * @param {string} filename e.g. "Severance.S02E03.1080p.WEB-DL.x264-GRP.mkv"
 * @returns {{ title: string, year: number|null, season: number|null,
 *             episode: number|null, absolute: number|null, ext: string|null }}
 */
export function parse(filename) {
  let name = filename.trim();

  let ext = null;
  const extMatch = name.match(VIDEO_EXT_RE);
  if (extMatch) {
    ext = extMatch[1].toLowerCase();
    name = name.slice(0, extMatch.index);
  }

  // Leading "[Group] " blocks (common on anime releases).
  name = name.replace(/^\s*(\[[^\]]*\]\s*)+/, '');
  // Dots and underscores are word separators in release names.
  const clean = name.replace(/[._]/g, ' ');

  let season = null;
  let episode = null;
  let seIndex = -1;
  let seLength = 0;
  for (const re of SE_RES) {
    const m = clean.match(re);
    if (m) {
      season = Number(m[1]);
      episode = Number(m[2]);
      seIndex = m.index;
      seLength = m[0].length;
      break;
    }
  }
  if (season === null) {
    const m = clean.match(SEASON_ONLY_RE);
    if (m) {
      season = Number(m[1] ?? m[2]);
      seIndex = m.index;
      seLength = m[0].length;
    }
  }
  // Episode without season: "Love Hina E11", "Episode 12".
  if (season === null && episode === null) {
    const m = clean.match(/\bE(?:p|pisode)?[ .]?(\d{1,4})\b/i);
    if (m) {
      episode = Number(m[1]);
      seIndex = m.index;
      seLength = m[0].length;
    }
  }
  // Dash-delimited episode number: "BLEACH - Sennen Kessen-hen - 41 - God of
  // Thunder". Year-shaped numbers stay years ("Asterix - 1967 - …").
  if (season === null && episode === null) {
    const m = clean.match(/\s[-–]\s(\d{1,4})\s[-–]\s/);
    if (m && !/^(19|20)\d{2}$/.test(m[1])) {
      episode = Number(m[1]);
      seIndex = m.index;
      seLength = m[0].length;
    }
  }
  // Leading episode number: "10. Le plan Savage….mkv" (series name lives in
  // the parent folder — title is left empty for the caller to fill). Matched
  // on the raw name: the dot/dash before the space is what disambiguates it
  // from number-titled movies ("300.2006.1080p.mkv").
  let leadingEpisode = false;
  let titleFrom = seIndex >= 0 ? seIndex + seLength : -1; // debrid-remote : where an episode title would start
  if (season === null && episode === null) {
    const m = name.match(/^(\d{1,4})[.\-] /);
    if (m && !/^(19|20)\d{2}$/.test(m[1])) {
      episode = Number(m[1]);
      leadingEpisode = true;
      titleFrom = m[0].length; // debrid-remote
    }
  }

  // Year: last year-looking token wins ("2012.2009.1080p" → 2009), but a
  // token at position 0 is a title ("1917", "1923"), not a year.
  let year = null;
  let yearIndex = -1;
  for (const m of clean.matchAll(YEAR_RE)) {
    if (m.index === 0) continue;
    year = Number(m[0]);
    yearIndex = m.index;
  }

  // Title = everything before the earliest marker (SxxEyy / year / first tag).
  // A marker at position 0 ("S01E08 - …") means the title isn't in the
  // filename at all — the caller falls back to folder/magnet context.
  const bracketed = clean.search(/\[[^\]]*\]/);
  const tagged = clean.search(TAG_RE);
  const cutCandidates = [seIndex, yearIndex, bracketed, tagged].filter((i) => i > 0);
  const cut = cutCandidates.length ? Math.min(...cutCandidates) : clean.length;
  let title = (seIndex === 0 || leadingEpisode) ? '' : cleanTitle(clean.slice(0, cut));

  // "Series NNN Episode title" shape (Dragon Ball style flat numbering):
  // only when the name carries no other marker at all.
  if (title && season === null && episode === null && year === null && cut === clean.length) {
    const m = clean.match(/^(.*?[a-zA-ZÀ-ÿ].*?)\s(\d{2,4})\s+\S/);
    if (m && !/^(19|20)\d{2}$/.test(m[2])) {
      title = cleanTitle(m[1]);
      episode = Number(m[2]);
      titleFrom = m[1].length + 1 + m[2].length; // debrid-remote
    }
  }

  // "Collection - 1967 - Real Title - 1080p" shape: the segment between the
  // year and the first tag/bracket is the actual movie title. Never applies
  // when a season/episode marker exists (series names keep their prefix).
  if (yearIndex > 0 && cut === yearIndex && seIndex < 0) {
    const afterYear = clean.slice(yearIndex + 4);
    const stops = [
      afterYear.search(TAG_RE),
      afterYear.search(/\[[^\]]*\]/),
      afterYear.search(/\bS\d{1,2}\b|\b\d{1,2}x\d{2,3}\b/i),
    ].filter((i) => i >= 0);
    const segment = cleanTitle(afterYear.slice(0, stops.length ? Math.min(...stops) : afterYear.length));
    if ((segment.match(/[a-zA-ZÀ-ÿ]/g) ?? []).length >= 3) title = segment;
  }

  // Flat-numbered shows (One Piece): the bare or E-prefixed number is the
  // episode; any SxxEyy marker is fansub noise and is discarded.
  let absolute = null;
  if (ABSOLUTE_SHOWS_RE.test(clean)) {
    if (season === null && episode !== null) {
      // Episode-only / leading-number / "Series NNN" matches ARE the flat number.
      absolute = episode;
    } else {
      // Remove the SxxEyy substring (fansub noise) so its digits can't be
      // picked up, then take the first non-year standalone number.
      const zone = seIndex >= 0 ? clean.slice(0, seIndex) + ' ' + clean.slice(seIndex + seLength) : clean;
      const eMatch = zone.match(/\b(?:E|Ep(?:isode)?)[ .]?(\d{1,4})\b/i);
      if (eMatch) {
        absolute = Number(eMatch[1]);
      } else {
        for (const m of zone.matchAll(/\b(\d{3,4})\b/g)) {
          if (/^(19|20)\d{2}$/.test(m[1])) continue; // year-like → not an episode
          absolute = Number(m[1]);
          break;
        }
      }
      // "One Piece S01E1171" (flat number carried by the SxxEyy marker itself).
      if (absolute === null && episode !== null) absolute = episode;
    }
    if (absolute !== null) {
      title = 'One Piece';
      season = null;
      episode = null;
    }
  }

  const episodeTitle = (episode !== null || absolute !== null) && titleFrom >= 0 ? tailTitle(clean.slice(titleFrom)) : null;
  return { title, year, season, episode, absolute, ext, episodeTitle };
}

// debrid-remote : the episode's own title after its marker ("S01E08 - Premier Noël", "41 - God of
// Thunder"), up to the first release tag, bracket or year ; null when fewer than 3 letters remain.
function tailTitle(rest) {
  rest = rest.replace(/^(?:[\s\-–]*E\d{1,4}\b)+/i, ''); // the E08 of S03E07E08
  const stops = [rest.search(TAG_RE), rest.search(/\[[^\]]*\]/), rest.search(/\b(19|20)\d{2}\b/)].filter((i) => i >= 0);
  const title = cleanTitle(rest.slice(0, stops.length ? Math.min(...stops) : rest.length));
  return (title.match(/[a-zA-ZÀ-ÿ]/g) ?? []).length >= 3 ? title : null;
}

/** Season carried by a folder name ("Saison 02/", "S2/"). */
export function seasonFromPath(path) {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  const m = dir.match(/(?:saison|season)[ ._-]?(\d{1,2})|\bS(\d{1,2})\b/i);
  return m ? Number(m[1] ?? m[2]) : null;
}

/**
 * Merges a file parse with its container context (magnet name in AllDebrid
 * mode). The file wins on everything it knows; the context fills the gaps.
 * If the context is a flat-numbered show (One Piece), a bare episode number
 * becomes the flat absolute number.
 */
export function withContext(file, context) {
  const merged = {
    title: file.title || context.title,
    year: file.year ?? context.year,
    season: file.season,
    episode: file.episode,
    absolute: file.absolute,
    ext: file.ext,
  };
  if (merged.absolute === null && ABSOLUTE_SHOWS_RE.test(merged.title) && merged.episode !== null) {
    // Flat-numbered show: any season info (file, folder or magnet) is noise.
    merged.absolute = merged.episode;
  } else if (merged.absolute === null) {
    merged.season ??= context.season;
    return merged;
  }
  merged.season = null;
  merged.episode = null;
  return merged;
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * debrid-remote : what the file list shows above a video's path, or null (not a video, or no
 * episode number). The file's own name wins ; its folder ("Saison 2/") then the magnet name fill
 * the series and the season.
 * @returns {{series: string, season: number|null, episode: number|null, absolute: number|null,
 *            code: string, title: string|null} | null}
 */
export function episodeLabel({ path, name }, magnetName) {
  if (!VIDEO_EXT_RE.test(name)) return null;
  const file = parse(name);
  file.season ??= seasonFromPath(path);
  const { title: series, season, episode, absolute } = withContext(file, parse(magnetName ?? ''));
  if (episode === null && absolute === null) return null;
  let code;
  if (absolute !== null) code = String(absolute);
  else if (season !== null) code = `S${pad(season)}E${pad(episode)}`;
  else code = `E${pad(episode)}`;
  return { series, season, episode, absolute, code, title: file.episodeTitle };
}
