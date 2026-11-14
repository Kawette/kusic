// ─── Unified track index (pure) ────────────────────────────

import type { FileConflict, Playlist, Track } from "../../types.js";
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
  return clean;
}

/**
 * Build the unified track list:
 * - each playlist track once (even if it is in several playlists), with the
 *   quality info of the first local file linked to it;
 * - local files linked to no known track: "unknown" when untagged, "local"
 *   when their tracks left every playlist;
 * - extra files linked to an already-matched track stay visible as "local";
 * - incoming files of pending conflicts are hidden, the track is flagged.
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

  return [...byId.values(), ...extraFiles];
}
