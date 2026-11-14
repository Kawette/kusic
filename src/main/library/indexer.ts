// ─── Unified track index (pure) ────────────────────────────

import type { FileConflict, Playlist, Track } from "../../types.js";
import { findMatches } from "./matching.js";
import { samePath } from "./naming.js";

const LOCAL_FILE_FIELDS = [
  "format",
  "bitRate",
  "sampleRate",
  "bitDepth",
  "fileSize",
  "filePath",
] as const;

/** Copy the quality info and path of a local file onto a playlist track. */
export function withLocalFile(track: Track, file: Track): Track {
  const merged: Track = { ...track };
  for (const key of LOCAL_FILE_FIELDS) {
    (merged as unknown as Record<string, unknown>)[key] = file[key];
  }
  return merged;
}

/** A playlist track without any local file data. */
function playlistTrack(track: Track): Track {
  const clean: Track = { ...track };
  for (const key of LOCAL_FILE_FIELDS) delete clean[key];
  delete clean.linkedTrackIds;
  delete clean.conflictId;
  delete clean.suggestedTrackIds;
  return clean;
}

export type Duplicate = Pick<FileConflict, "trackId" | "newPath" | "existingPath">;

/**
 * Library files linked to a playlist track that already has another file.
 * Per track, the file kept as "existing" is the one with the library name
 * ("Artist - Title.ext"), else the one linked to the most tracks, else the
 * first by path; each other file is a duplicate (unless it is the kept file
 * of another track). Files already in a conflict are ignored.
 */
export function findDuplicates(
  playlists: Playlist[],
  localFiles: Track[],
  conflicts: FileConflict[],
  hasLibraryName: (track: Track, file: Track) => boolean,
): Duplicate[] {
  const tracks = new Map(playlists.flatMap((p) => p.tracks).map((t) => [t.id, t]));
  const pending = conflicts.map((c) => c.newPath);
  const filesByTrack = new Map<string, Track[]>();
  for (const file of localFiles) {
    if (pending.some((p) => samePath(p, file.filePath!))) continue;
    for (const id of file.linkedTrackIds || []) {
      if (tracks.has(id)) filesByTrack.set(id, [...(filesByTrack.get(id) || []), file]);
    }
  }

  const groups = [...filesByTrack].filter(([, files]) => files.length > 1).map(([trackId, files]) => {
    const track = tracks.get(trackId)!;
    const named = (f: Track) => (hasLibraryName(track, f) ? 0 : 1);
    const links = (f: Track) => f.linkedTrackIds?.length ?? 0;
    const sorted = [...files].sort(
      (a, b) => named(a) - named(b) || links(b) - links(a) || a.filePath!.localeCompare(b.filePath!),
    );
    return { trackId, kept: sorted[0], extras: sorted.slice(1) };
  });

  const keptPaths = groups.map((g) => g.kept.filePath!);
  const duplicates: Duplicate[] = [];
  for (const { trackId, kept, extras } of groups) {
    for (const extra of extras) {
      const path = extra.filePath!;
      if (keptPaths.some((p) => samePath(p, path))) continue;
      if (duplicates.some((d) => samePath(d.newPath, path))) continue;
      duplicates.push({ trackId, newPath: path, existingPath: kept.filePath! });
    }
  }
  return duplicates;
}

/**
 * Build the unified track list:
 * - each playlist track once (even if it is in several playlists), with the
 *   quality info of the first local file linked to it;
 * - local files linked to no known track: "unknown" when untagged, "local"
 *   when their tracks left every playlist;
 * - extra files linked to an already-matched track (duplicates, normally
 *   turned into conflicts by findDuplicates) stay visible as "local";
 * - incoming files of pending conflicts are hidden, the track is flagged;
 * - unknown files get the playlist tracks they strictly match as suggestions.
 */
export function buildTrackIndex(
  playlists: Playlist[],
  localFiles: Track[],
  conflicts: FileConflict[] = [],
): Track[] {
  const byId = new Map<string, Track>();
  for (const pl of playlists) {
    for (const track of pl.tracks) {
      const existing = byId.get(track.id);
      if (existing) {
        if (!existing.playlistIds!.includes(pl.id)) existing.playlistIds!.push(pl.id);
      } else {
        byId.set(track.id, { ...playlistTrack(track), playlistIds: [pl.id] });
      }
    }
  }

  const pendingFiles = conflicts.map((c) => c.newPath);
  const matched = new Set<string>();
  const extraFiles: Track[] = [];

  const files = localFiles
    .filter((f) => !pendingFiles.some((p) => samePath(p, f.filePath!)))
    .sort((a, b) => a.filePath!.localeCompare(b.filePath!));

  for (const file of files) {
    const ids = (file.linkedTrackIds || []).filter((id) => byId.has(id));
    const freeIds = ids.filter((id) => !matched.has(id));
    for (const id of freeIds) {
      byId.set(id, withLocalFile(byId.get(id)!, file));
      matched.add(id);
    }
    if (freeIds.length > 0) continue;

    // Untagged → unknown; tagged but unmatched (stale or duplicate) → local
    extraFiles.push({
      ...file,
      source: file.linkedTrackIds?.length ? "local" : "unknown",
    });
  }

  for (const conflict of conflicts) {
    const track = byId.get(conflict.trackId);
    if (track) track.conflictId = conflict.id;
  }

  // Suggest only tracks still missing a file
  const missing = [...byId.values()].filter((t) => !t.filePath);
  for (const file of extraFiles) {
    if (file.source !== "unknown") continue;
    const matches = findMatches(file, missing);
    if (matches.length) file.suggestedTrackIds = matches.map((t) => t.id);
  }

  return [...byId.values(), ...extraFiles];
}
