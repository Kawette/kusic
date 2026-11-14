// ─── File naming & KUSIC tag helpers (pure) ────────────────

import path from "path";

const MAX_NAME_PART = 120;

/** Make a string safe as a Windows file name part. */
export function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "") // Invalid and control chars
    .replace(/\s+/g, " ") // Collapse spaces
    .trim()
    .slice(0, MAX_NAME_PART)
    .replace(/[. ]+$/, ""); // Windows strips trailing dots/spaces
}

/** "Artist - Title.ext" with filesystem-safe parts. */
export function libraryFilename(
  track: { artist: string; title: string },
  ext: string,
): string {
  return `${sanitizeFilename(track.artist) || "Artiste inconnu"} - ${sanitizeFilename(track.title) || "Sans titre"}${ext.toLowerCase()}`;
}

/** Windows paths are case-insensitive. */
export function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

/** True when `child` is inside `parent` (or is `parent`). */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase());
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

// The playlist track ids a file belongs to are stored in its comment tag as
// "[KUSIC:id1,id2] original comment" (works across all audio formats).
const KUSIC_TAG = /\[KUSIC:([^\]]*)\]\s*/g;

export function parseKusicIds(comment: string | undefined): string[] {
  const ids: string[] = [];
  for (const match of (comment || "").matchAll(KUSIC_TAG)) {
    for (const id of match[1].split(",")) {
      if (id.trim() && !ids.includes(id.trim())) ids.push(id.trim());
    }
  }
  return ids;
}

/** Replace any existing KUSIC tag of `comment` with one holding `ids`. */
export function formatKusicComment(
  comment: string | undefined,
  ids: string[],
): string {
  const rest = (comment || "").replace(KUSIC_TAG, "").trim();
  if (ids.length === 0) return rest;
  return `[KUSIC:${ids.join(",")}] ${rest}`.trim();
}

/** "Artist - Title" guessed from a file name, when tags are missing. */
export function parseArtistTitle(
  nameWithoutExt: string,
): { artist?: string; title: string } {
  for (const sep of [" - ", " – ", " — "]) {
    const i = nameWithoutExt.indexOf(sep);
    if (i > 0) {
      return {
        artist: nameWithoutExt.slice(0, i).trim(),
        title: nameWithoutExt.slice(i + sep.length).trim(),
      };
    }
  }
  return { title: nameWithoutExt };
}

/**
 * Local path where slskd saves a remote file: "<downloads>/<remote parent
 * directory>/<file name>", invalid characters replaced by "_" (mirrors
 * slskd's ToLocalRelativeFilename).
 */
export function slskdLocalPath(downloadsDir: string, remoteFilename: string): string {
  const clean = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  // Peer-supplied path: never let "." / ".." segments escape the downloads folder
  const parts = remoteFilename.split(/[\\/]/).filter((p) => p && p !== "." && p !== "..");
  const file = clean(parts[parts.length - 1] || remoteFilename);
  return parts.length > 1
    ? path.join(downloadsDir, clean(parts[parts.length - 2]), file)
    : path.join(downloadsDir, file);
}
