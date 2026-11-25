// ─── Soulseek queries and result relevance ──────────────────
// Soulseek returns files whose full path contains every word of the query,
// so queries must be short and spelled like file names: main artist + title,
// no "feat.", no "(Original Mix)", no accents or punctuation.

import { formatDuration } from './format.js';

/** Words that make a version a different track: kept in queries. */
const VERSION = /\b(remix|rmx|edit|bootleg|rework|vip|flip|remake|mashup|dub)\b/i;
/** Version suffixes that only narrow the search (" - Extended Mix", "Free DL"…). */
const NOISE_SUFFIX = /\b(original|extended|radio|club|mix|version|remaster(ed)?|instrumental|free (dl|download))\b/i;

/** Formats Kusic indexes (keep in sync with AUDIO_EXTENSIONS in main/library/files.ts) */
const AUDIO_EXTENSIONS = ['flac', 'mp3', 'wav', 'aiff', 'aif', 'm4a', 'aac', 'ogg', 'opus', 'wma'];

/** Lower-case words without accents or punctuation, as peers name their files. */
function searchWords(text) {
  return (text || '')
    .toLowerCase()
    .replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/œ/g, 'oe').replace(/ß/g, 'ss').replace(/ł/g, 'l')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const sentence = (words) => [...new Set(words)].join(' ');

const ARTIST_SEPARATOR = /,|&|\s(?:feat\.?|ft\.?|x|vs\.?)\s/i;

/** First credited artist: "A, B & C feat. D" → "A". */
function mainArtist(artist) {
  return (artist || '').split(ARTIST_SEPARATOR)[0];
}

/** Title without noise ("*PLAYED BY…*", "PREMIERE:", "(Original Mix)", "[CAT001]", "Free DL"…). */
function cleanTitle(title) {
  return (title || '')
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/^[^:]*premiere\s*:\s*/i, ' ')
    .replace(/[[(]([^\])]*)[\])]/g, (_, inner) => (VERSION.test(inner) ? ` (${inner}) ` : ' '))
    .replace(/\b(free\s*(dl|download)|out now)\b|\/\//gi, ' ')
    .replace(/\s[-–—]\s+([^-–—]*)$/, (part, tail) =>
      NOISE_SUFFIX.test(tail) && !VERSION.test(tail) ? ' ' : part);
}

const withoutBrackets = (text) => text.replace(/[[(][^\])]*[\])]/g, ' ');

/**
 * Split "X - Y": a version suffix ("Song - DJ X Remix") or a SoundCloud style
 * "Artist - Title" (the uploader is then often a label).
 */
function splitDash(title) {
  const match = title.match(/^(.*?)\s[-–—]\s+(.+)$/);
  if (!match) return { title };
  const [, left, right] = match;
  return VERSION.test(withoutBrackets(right))
    ? { title: left, version: right }
    : { artist: left, title: right };
}

/** Query for a playlist track: main artist + cleaned title (with its version). */
export function trackQuery(track) {
  const title = cleanTitle(track.title);
  const parts = splitDash(title);
  const artist = parts.artist ?? mainArtist(track.artist);
  return sentence(searchWords(`${artist} ${parts.title} ${parts.version ?? ''}`));
}

/** The song title alone: no artist, no version info. */
function baseTitle(track) {
  return withoutBrackets(splitDash(cleanTitle(track.title)).title);
}

/** Second try when the main query finds nothing relevant: the title alone. */
export function fallbackQuery(track) {
  const query = sentence(searchWords(baseTitle(track)));
  return query && query !== trackQuery(track) ? query : '';
}

/**
 * What a relevant file must match: every title word in its name, and one of
 * the credited artists anywhere in its path (file or folder name).
 */
export function relevanceOf(track) {
  const title = [...new Set(searchWords(baseTitle(track)))];
  const credited = `${track.artist}, ${splitDash(cleanTitle(track.title)).artist ?? ''}`;
  const artists = credited
    .split(ARTIST_SEPARATOR)
    .map(searchWords)
    .filter((words) => words.length);
  return { title, artists };
}

/** An audio file whose name has the track title and whose path has one of its artists. */
export function isRelevant(result, { title, artists }) {
  if (!AUDIO_EXTENSIONS.includes(result.extension)) return false;
  const parts = result.filename.split(/[\\/]/);
  const name = new Set(searchWords(parts.pop()));
  if (!title.every((w) => name.has(w))) return false;
  const path = new Set(searchWords(parts.join(' ')).concat([...name]));
  return artists.length === 0 || artists.some((words) => words.every((w) => path.has(w)));
}

// ─── Certain matches (opt-in automatic download) ────────────
/** Words naming another version of a song: the file must have exactly the track's ones. */
const VERSION_MARKERS = new Set([
  'remix', 'rmx', 'edit', 'bootleg', 'rework', 'vip', 'flip', 'remake', 'mashup', 'dub',
  'extended', 'radio', 'club', 'live', 'acoustic', 'unplugged', 'instrumental', 'acapella',
  'cappella', 'karaoke', 'cover', 'demo', 'reprise', 'sped', 'slowed', 'nightcore', 'reverb',
  'orchestral', 'piano', 'techno', 'hardstyle', 'house', 'tekk', 'hardtekk', 'speed',
  // DJ pool versions: muted or uncensored lyrics
  'clean', 'dirty', 'explicit', 'censored',
]);
/** Up to this gap, a file has the track's length (encoder padding only). */
const CERTAIN_DURATION_MS = 2000;
const MIN_MP3_BITRATE = 320;

const capitalize = (w) => w.charAt(0).toUpperCase() + w.slice(1);

/** What a certain file must match, worked out once per track (see matchDoubts). */
export function certaintyOf(track) {
  const relevance = relevanceOf(track);
  const parts = splitDash(cleanTitle(track.title));
  // Only a SoundCloud title holds the artist ("Artist - Title", the uploader being
  // often a label). Elsewhere " - Acoustic", " - Live at Wembley"… is part of the title.
  const dashArtist = track.source === 'soundcloud' ? parts.artist : undefined;
  const title = parts.artist !== undefined && dashArtist === undefined
    ? `${parts.artist} ${parts.title}`
    : `${parts.title} ${parts.version ?? ''}`;
  const titleWords = new Set(relevance.title);
  // Artist names ("Club Yoko", "Live Wire"…) are not version markers
  const artistWords = new Set(relevance.artists.flat());
  const versionOf = (words) => new Set(words.filter((w) => VERSION_MARKERS.has(w) && !artistWords.has(w)));
  return {
    relevance,
    duration: track.duration,
    // Every credited artist must be in the path. An artist named like the title
    // ("fake_friends" for "Fake Friends") proves nothing and is not counted.
    credited: (dashArtist ?? track.artist ?? '')
      .split(ARTIST_SEPARATOR)
      .map((name) => ({ name: name.trim(), words: searchWords(name) }))
      .filter(({ words }) => words.length && !words.every((w) => titleWords.has(w))),
    // Title and version: the remixer's name too
    wanted: [...new Set(searchWords(title))],
    // Markers of the full title, so that an unwanted "(Live)" dropped by the cleaning still counts
    version: versionOf(searchWords(track.title)),
    versionOf,
  };
}

/**
 * Formats a certain match may have, as the settings say: other lossless ones
 * (AIFF, ALAC, APE) are not read by the built-in player.
 */
function isCertainFormat(result) {
  const ext = (result.extension || '').toLowerCase();
  return ext === 'flac' || ext === 'wav' || (ext === 'mp3' && (result.bitRate || 0) >= MIN_MP3_BITRATE);
}

/**
 * Why a result is not certainly the track (short labels, e.g. "Extended",
 * "Durée +1:17", "Artiste absent : Morelia"); empty when it is certain:
 * relevant, every credited artist in the path, every word of the title and its
 * version (remixer…) in the file name, no version marker more or less, same
 * length within 2 s, and FLAC, WAV or MP3 320.
 */
export function matchDoubts(result, track, certainty = certaintyOf(track)) {
  const { relevance, credited, wanted, version, versionOf, duration } = certainty;
  // A title without Latin letters or digits (日本語, кириллица…) cannot be compared:
  // any file of the artist would pass
  if (!relevance.title.length || !wanted.length) return ['Titre non comparable'];
  if (!isRelevant(result, relevance)) return ['Hors sujet'];
  const doubts = [];

  const pathWords = new Set(searchWords(result.filename));
  for (const { name, words } of credited) {
    if (!words.every((w) => pathWords.has(w))) doubts.push(`Artiste absent : ${name}`);
  }

  const name = searchWords(result.filename.split(/[\\/]/).pop());
  const nameSet = new Set(name);
  const missing = wanted.filter((w) => !nameSet.has(w));
  const fileVersion = versionOf(name);
  doubts.push(...[...fileVersion].filter((w) => !version.has(w)).map(capitalize));
  if (missing.length) doubts.push(`Manque « ${missing.join(' ')} »`);
  // Markers only in the full title ("(Live at …)" is dropped from the cleaned one)
  const absent = [...version].filter((w) => !fileVersion.has(w) && !missing.includes(w));
  if (absent.length) doubts.push(`Manque « ${absent.join(' ')} »`);

  if (!result.length || !duration) {
    doubts.push('Durée inconnue');
  } else {
    const gap = result.length * 1000 - duration;
    if (Math.abs(gap) > CERTAIN_DURATION_MS) doubts.push(`Durée ${gap < 0 ? '−' : '+'}${formatDuration(Math.abs(gap))}`);
  }

  if (!isCertainFormat(result)) {
    const ext = (result.extension || '?').toUpperCase();
    doubts.push(ext === 'MP3' ? `${ext} ${result.bitRate || '?'} kbps` : ext);
  }
  return doubts;
}

/** True only when a result is, beyond doubt, the track (see matchDoubts). */
export function isCertainMatch(result, track, certainty = certaintyOf(track)) {
  return matchDoubts(result, track, certainty).length === 0;
}

const formatRank = (r) => ({ flac: 2, wav: 1 })[(r.extension || '').toLowerCase()] || 0;

/**
 * Order of certain sources: FLAC always first, then WAV; within a
 * format, the user with the fewest of our running downloads (spreads them, a
 * user's queue being often slow or capped), then free slot, shortest queue,
 * fastest user. `downloadsWith(username)`: our running downloads from that user.
 */
export function sourceOrder(downloadsWith = () => 0) {
  return (a, b) => formatRank(b) - formatRank(a)
    || downloadsWith(a.username) - downloadsWith(b.username)
    || Number(!!b.hasFreeUploadSlot) - Number(!!a.hasFreeUploadSlot)
    || (a.queueLength || 0) - (b.queueLength || 0)
    || (b.uploadSpeed || 0) - (a.uploadSpeed || 0);
}

/** The results that can be downloaded automatically, preferred first (empty when none is certain). */
export function certainMatches(results, track, downloadsWith) {
  const certainty = certaintyOf(track);
  return results.filter((r) => isCertainMatch(r, track, certainty)).sort(sourceOrder(downloadsWith));
}

/** Relevant and certain results counts, best format among them, e.g. { relevant: 5, best: 'FLAC', certain: 1 }. */
export function searchStats(results, track) {
  const certainty = certaintyOf(track);
  const relevant = results.filter((r) => isRelevant(r, certainty.relevance));
  const best = relevant.reduce((a, b) => (!a || b.quality > a.quality ? b : a), null);
  return {
    relevant: relevant.length,
    best: best ? best.extension.toUpperCase() : '',
    certain: relevant.filter((r) => isCertainMatch(r, track, certainty)).length,
  };
}
