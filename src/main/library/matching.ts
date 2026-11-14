// ─── Strict file ↔ playlist track matching (pure) ──────────
// Only near-certain matches are suggested: same title (ignoring noise such
// as "Free Download" or "[CAT001]") and at least one common artist, with a
// compatible duration. Remixes / edits are part of the title, so a remix
// never matches the original.

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

/**
 * The (artist, title) readings of a track. SoundCloud uploads often put
 * "Artist - Title" in the title with a label as uploader.
 */
function readings({ artist, title }: Named): { artists: string[]; title: string }[] {
  const result = [{ artists: artistNames(artist), title: coreTitle(title) }];
  const dash = title.replace(PREMIERE_PREFIX, "").match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dash) result.push({ artists: artistNames(dash[1]), title: coreTitle(dash[2]) });
  return result;
}

const MAX_DURATION_GAP = 15_000;

/** Duration gap in ms when the two are a strict match, else null. */
export function matchGap(file: Named, track: Named): number | null {
  const gap = file.duration && track.duration ? Math.abs(file.duration - track.duration) : 0;
  if (gap > MAX_DURATION_GAP) return null;

  for (const f of readings(file)) {
    for (const t of readings(track)) {
      if (!f.title || f.title !== t.title) continue;
      const sameArtist = f.artists.some((a) => t.artists.includes(a));
      // Untagged file without artist: the title alone is enough if the length matches
      const unknownArtist = f.artists.length === 0 && gap > 0 && gap < 3000;
      if (sameArtist || unknownArtist) return gap;
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
