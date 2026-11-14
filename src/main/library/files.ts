// ─── Audio files: tags, scan, moves ────────────────────────

import crypto from "crypto";
import fs from "fs";
import path from "path";
import * as mm from "music-metadata";
import * as taglib from "node-taglib-sharp";
import { scanCache, type ScanCacheEntry } from "../store.js";
import type { Track } from "../../types.js";
import { coverExists, saveCover } from "./covers.js";
import {
  formatKusicComment,
  isInside,
  parseArtistTitle,
  parseKusicIds,
  samePath,
} from "./naming.js";

/** Indexed audio formats (keep in sync with AUDIO_EXTENSIONS in renderer/js/query.js) */
const AUDIO_EXTENSIONS = [".mp3", ".flac", ".wav", ".aiff", ".aif", ".m4a", ".aac", ".ogg", ".opus", ".wma"];
const PARSE_CONCURRENCY = 4;

function commentText(comment: unknown): string {
  return typeof comment === "string" ? comment : (comment as { text?: string })?.text || "";
}

/** Read an audio file into a local Track (no playlist link resolution). */
export async function parseAudioFile(filePath: string): Promise<Track | null> {
  try {
    const [metadata, stats] = await Promise.all([
      mm.parseFile(filePath),
      fs.promises.stat(filePath),
    ]);
    const { common, format } = metadata;
    const ext = path.extname(filePath);

    let artist = common.artist || "";
    let title = common.title || "";
    if (!artist || !title) {
      const guess = parseArtistTitle(path.basename(filePath, ext));
      artist ||= guess.artist || "Artiste inconnu";
      title ||= guess.title;
    }

    const picture = common.picture?.[0];
    const linkedTrackIds = parseKusicIds(common.comment?.map(commentText).join(" "));

    return {
      id: `local-${crypto.createHash("md5").update(filePath).digest("hex")}`,
      source: linkedTrackIds.length ? "local" : "unknown",
      title,
      artist,
      album: common.album || "",
      artwork: picture ? saveCover(picture.data) : "",
      duration: Math.round((format.duration || 0) * 1000),
      addedAt: stats.mtimeMs,
      format: ext.slice(1).toUpperCase(),
      bitRate: format.bitrate ? Math.round(format.bitrate / 1000) : undefined,
      sampleRate: format.sampleRate,
      bitDepth: format.bitsPerSample,
      fileSize: stats.size,
      filePath,
      linkedTrackIds,
    };
  } catch (err) {
    console.error(`[Kusic] Failed to parse ${filePath}:`, err);
    return null;
  }
}

/** All audio files under `root`, skipping hidden folders (e.g. a legacy .incomplete). */
export async function listAudioFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // Skip directories we can't read
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) await walk(fullPath);
      } else if (
        entry.isFile() &&
        AUDIO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())
      ) {
        found.push(fullPath);
      }
    }
  };
  await walk(root);
  return found;
}

/**
 * Scan the library. Files whose size and mtime did not change since the last
 * scan are taken from the cache instead of being parsed again.
 */
export async function scanLibrary(root: string): Promise<Track[]> {
  if (!root || !fs.existsSync(root)) return [];

  const previous = scanCache.get("files");
  const next: Record<string, ScanCacheEntry> = {};
  const queue = await listAudioFiles(root);

  const worker = async () => {
    for (let filePath = queue.pop(); filePath; filePath = queue.pop()) {
      const stats = await fs.promises.stat(filePath).catch(() => null);
      if (!stats) continue;
      const cached = previous[filePath];
      if (
        cached &&
        cached.mtimeMs === stats.mtimeMs &&
        cached.size === stats.size &&
        coverExists(cached.track.artwork)
      ) {
        next[filePath] = cached;
        continue;
      }
      const track = await parseAudioFile(filePath);
      if (track) next[filePath] = { mtimeMs: stats.mtimeMs, size: stats.size, track };
    }
  };
  await Promise.all(Array.from({ length: PARSE_CONCURRENCY }, worker));

  scanCache.set("files", next);
  const tracks = Object.values(next).map((e) => e.track);
  console.log(`[Kusic] Scanned ${tracks.length} local files`);
  return tracks;
}

/** Local files as of the last scan, without touching the disk. */
export function cachedLocalFiles(): Track[] {
  return Object.values(scanCache.get("files")).map((e) => e.track);
}

/** Open a file's tags, always releasing the handle (Windows locks open files). */
function withTags<T>(filePath: string, fn: (file: taglib.File) => T): T {
  const file = taglib.File.createFromPath(filePath);
  try {
    return fn(file);
  } finally {
    file.dispose();
  }
}

/** Write title/artist/album and the KUSIC link tag. Throws on failure. */
export function writeTags(
  filePath: string,
  values: { title: string; artist: string; album: string; linkedTrackIds: string[] },
): void {
  withTags(filePath, (file) => {
    file.tag.title = values.title;
    file.tag.performers = [values.artist];
    file.tag.album = values.album;
    file.tag.comment = formatKusicComment(file.tag.comment, values.linkedTrackIds);
    file.save();
  });
}

/** Update only the KUSIC link tag of a file. */
export function writeLinkedIds(filePath: string, ids: string[]): void {
  withTags(filePath, (file) => {
    file.tag.comment = formatKusicComment(file.tag.comment, ids);
    file.save();
  });
}

export function readLinkedIds(filePath: string): string[] {
  return withTags(filePath, (file) => parseKusicIds(file.tag.comment));
}

/** Move a file (across drives if needed), then prune emptied folders. */
export function moveFile(from: string, to: string, libraryRoot: string): void {
  // renameSync silently replaces an existing target on Windows
  if (fs.existsSync(to) && !samePath(from, to)) {
    throw new Error(`Un fichier existe déjà : ${path.basename(to)}`);
  }
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(from);
  }
  cleanEmptyDirs(path.dirname(from), libraryRoot);
}

/** Remove `dir` and its parents while they are empty, never `stopAt` itself. */
export function cleanEmptyDirs(dir: string, stopAt: string): void {
  for (
    let current = dir;
    isInside(current, stopAt) && !samePath(current, stopAt);
    current = path.dirname(current)
  ) {
    try {
      if (fs.readdirSync(current).length > 0) return;
      fs.rmdirSync(current);
    } catch {
      return;
    }
  }
}
