// ─── Strict file ↔ playlist track matching (pure) ──────────
// Only near-certain matches are suggested: same title (ignoring noise such
// as "Free Download" or "[CAT001]") and at least one common artist, with a
// compatible duration (an untagged file without artist needs the same
// length). Remix info is part of the title, so a remix never matches the
// original.

const PREMIERE_PREFIX = /^[^:]*premiere\s*:\s*/i;
const NOISE = /\b(free (download|dl)|premiere|out now|official( (audio|video))?|original mix|clip|hq|explicit)\b/g;

/** Lower-case, no accents, no punctuation, single spaces. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ø/g, "o")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Title without noise: "(Original Mix)", "[FREE DL]", "[CAT001]", "PREMIERE:"… */
export function coreTitle(title: string): string {
  return normalize(
    title
      // Bracketed parts that only hold noise or a catalog number
      .replace(/[[(]([^\])]*)[\])]/g, (part, inner: string) =>
        normalize(inner).replace(NOISE, "").trim() === "" || /^[A-Z]{2,}\s?\d+$/.test(inner.trim())
          ? " "
          : part,
      )
      .replace(PREMIERE_PREFIX, " "),
  )
    .replace(NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Individual artist names: "A, B & C feat. D" → [a, b, c, d]. */
export function artistNames(artist: string): string[] {
  return artist
    .split(/,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\bvs\.?|\bwith\b/i)
    .map(normalize)
    .filter((a) => a.length > 1);
}

interface Named {
  artist: string;
  title: string;
  duration?: number;
}

interface Reading {
  artists: string[];
  title: string;
  /** Title without version info */
  base: string;
}

/**
 * The (artist, title) readings of a track. SoundCloud uploads often put
 * "Artist - Title" in the title with a label as uploader.
 */
function readings({ artist, title }: Named): Reading[] {
  const read = (artists: string, raw: string): Reading => ({
    artists: artistNames(artists),
    title: coreTitle(raw),
    base: coreTitle(baseTitle(raw)),
  });
  const result = [read(artist, title)];
  const dash = title.replace(PREMIERE_PREFIX, "").match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) result.push(read(dash[1], dash[2]));
  return result;
}

const REMIX = /\b(remix|rmx|bootleg|rework|flip|vip|cover|remake)\b/i;

/**
 * Title without version info such as "(EDIT)" or " - Extended Mix". Remix
 * info is kept: a remix is another track, even with the same length.
 */
function baseTitle(title: string): string {
  const dropVersion = (part: string) => (REMIX.test(part) ? part : " ");
  return title
    .replace(/\s*[[(][^\])]*[\])]/g, dropVersion)
    .replace(/\s+-\s+[^-]*$/, dropVersion)
    .trim();
}

/** Same title: up to this gap (another edit of the same track). */
const MAX_SAME_TITLE_GAP = 60_000;
/** Same title once version info is removed, or no artist: only if lengths agree. */
const MAX_LOOSE_GAP = 3_000;

/** Duration gap in ms when the file and the track are the same song, else null. */
export function matchGap(file: Named, track: Named): number | null {
  const known = !!(file.duration && track.duration);
  const gap = known ? Math.abs(file.duration! - track.duration!) : 0;
  const closeLength = known && gap <= MAX_LOOSE_GAP;

  for (const f of readings(file)) {
    for (const t of readings(track)) {
      if (!f.title) continue;
      const sameArtist = f.artists.some((a) => t.artists.includes(a));
      const sameTitle = f.title === t.title;
      const sameBase = !!f.base && f.base === t.base;

      if (sameArtist && sameTitle && gap <= MAX_SAME_TITLE_GAP) return gap;
      if (sameArtist && sameBase && closeLength) return gap;
      // Untagged file without artist: the title alone is enough if the length matches
      if (f.artists.length === 0 && sameTitle && closeLength) return gap;
    }
  }
  return null;
}

/** Best strict matches for a file (at most `max`), closest duration first. */
export function findMatches<T extends Named>(file: Named, tracks: T[], max = 2): T[] {
  return tracks
    .map((track) => ({ track, gap: matchGap(file, track) }))
    .filter((m): m is { track: T; gap: number } => m.gap !== null)
    .sort((a, b) => a.gap - b.gap)
    .slice(0, max)
    .map((m) => m.track);
}
