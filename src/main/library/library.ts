// ─── Library service ───────────────────────────────────────
// Owns playlists, the unified track index and file conflicts. Every mutation
// goes through a single queue so concurrent IPC calls cannot overwrite each
// other's writes.

import { shell } from "electron";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { store } from "../store.js";
import { SpotifyService } from "../../services/spotify.js";
import { SoundCloudService } from "../../services/soundcloud.js";
import type {
  ConflictChoice,
  ConflictDetails,
  ConflictFileInfo,
  FileConflict,
  Playlist,
  Track,
  TrackFilters,
} from "../../types.js";
import { buildTrackIndex } from "./indexer.js";
import {
  cleanEmptyDirs,
  moveFile,
  parseAudioFile,
  readLinkedIds,
  scanLibrary,
  writeLinkedIds,
  writeTags,
} from "./files.js";
import { libraryFilename, samePath } from "./naming.js";

export type PlaceResult =
  | { status: "placed"; filePath: string }
  | { status: "conflict"; conflict: FileConflict };

export interface PlaylistSummary extends Omit<Playlist, "tracks"> {
  trackCount: number;
  localCount: number;
}

const TRACK_SORTERS: Record<string, (a: Track, b: Track) => number> = {
  title: (a, b) => a.title.localeCompare(b.title),
  artist: (a, b) => a.artist.localeCompare(b.artist),
  duration: (a, b) => a.duration - b.duration,
  recent: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
};

async function fetchPlaylist(url: string): Promise<Playlist> {
  if (/spotify\.com|^spotify:/.test(url)) {
    const { clientId, clientSecret } = store.get("spotify");
    if (!clientId || !clientSecret) {
      throw new Error("Configurez vos identifiants Spotify dans les paramètres");
    }
    return new SpotifyService(clientId, clientSecret).getPlaylist(url);
  }
  if (url.includes("soundcloud.com")) {
    return new SoundCloudService().getPlaylist(url);
  }
  throw new Error("URL non supportée. Utilisez une URL Spotify ou SoundCloud.");
}

export class Library {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private onChange: () => void = () => {}) {}

  /** Run `fn` after every previously queued mutation. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private get root(): string {
    return store.get("soulseek").libraryPath;
  }

  // ─── Index ────────────────────────────────────────────────

  private async rebuildNow() {
    const localFiles = await scanLibrary(this.root);
    // Drop conflicts whose incoming file is gone (deleted outside Kusic)
    const conflicts = store
      .get("conflicts")
      .filter((c) => fs.existsSync(c.newPath));
    store.set("conflicts", conflicts);

    const tracks = buildTrackIndex(store.get("playlists"), localFiles, conflicts);
    store.set("tracks", tracks);
    this.onChange();
    return { totalTracks: tracks.length, localTracks: localFiles.length };
  }

  /** Rescan the local files (no network). */
  rescan() {
    return this.exclusive(() => this.rebuildNow());
  }

  getTracks(filters: TrackFilters = {}): Track[] {
    let tracks = store.get("tracks");

    if (filters.search) {
      const q = filters.search.toLowerCase();
      tracks = tracks.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          t.artist.toLowerCase().includes(q) ||
          t.album?.toLowerCase().includes(q),
      );
    }

    if (filters.source === "missing") {
      tracks = tracks.filter((t) => t.playlistIds && !t.format);
    } else if (filters.source && filters.source !== "all") {
      tracks = tracks.filter((t) => t.source === filters.source);
    }

    const playlist = filters.playlistId
      ? store.get("playlists").find((p) => p.id === filters.playlistId)
      : undefined;
    if (playlist) {
      const order = new Map(playlist.tracks.map((t, i) => [t.id, i]));
      tracks = tracks.filter((t) => order.has(t.id));
      if (filters.sortBy === "playlist" || !filters.sortBy) {
        return tracks.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
      }
    }

    return tracks.sort(TRACK_SORTERS[filters.sortBy ?? "recent"] ?? TRACK_SORTERS.recent);
  }

  getStats() {
    const tracks = store.get("tracks");
    return {
      totalPlaylists: store.get("playlists").length,
      totalTracks: tracks.length,
      missingTracks: tracks.filter((t) => t.playlistIds && !t.format).length,
      conflicts: store.get("conflicts").length,
    };
  }

  // ─── Playlists ────────────────────────────────────────────

  getPlaylists(): PlaylistSummary[] {
    const localIds = new Set(
      store.get("tracks").filter((t) => t.playlistIds && t.format).map((t) => t.id),
    );
    return store.get("playlists").map(({ tracks, ...pl }) => ({
      ...pl,
      trackCount: tracks.length,
      localCount: tracks.filter((t) => localIds.has(t.id)).length,
    }));
  }

  async addPlaylist(url: string): Promise<Playlist> {
    const playlist = await fetchPlaylist(url.trim());
    return this.exclusive(async () => {
      const playlists = store.get("playlists");
      if (playlists.some((p) => p.id === playlist.id || p.url === playlist.url)) {
        throw new Error("Cette playlist est déjà dans votre bibliothèque");
      }
      store.set("playlists", [...playlists, playlist]);
      await this.rebuildNow();
      return playlist;
    });
  }

  removePlaylist(id: string) {
    return this.exclusive(async () => {
      store.set(
        "playlists",
        store.get("playlists").filter((p) => p.id !== id),
      );
      await this.rebuildNow();
      return this.getPlaylists();
    });
  }

  /**
   * Fetch every playlist again. A playlist that fails (network, partial
   * SoundCloud response…) keeps its previous content.
   */
  async refreshPlaylists() {
    const fresh = new Map<string, Playlist>();
    const errors: string[] = [];
    for (const pl of store.get("playlists")) {
      try {
        fresh.set(pl.id, await fetchPlaylist(pl.url));
      } catch (err) {
        errors.push(`${pl.name} : ${(err as Error).message}`);
      }
    }

    return this.exclusive(async () => {
      // Re-read: playlists may have been added or removed meanwhile
      const playlists = store.get("playlists").map((pl) => {
        const updated = fresh.get(pl.id);
        return updated ? { ...updated, addedAt: pl.addedAt } : pl;
      });
      store.set("playlists", playlists);
      return { ...(await this.rebuildNow()), errors };
    });
  }

  exportM3U(playlistId: string, destination: string): number {
    const playlist = store.get("playlists").find((p) => p.id === playlistId);
    if (!playlist) throw new Error("Playlist introuvable");
    const byId = new Map(store.get("tracks").map((t) => [t.id, t]));
    const lines = ["#EXTM3U", `#PLAYLIST:${playlist.name}`];
    let count = 0;
    for (const { id } of playlist.tracks) {
      const track = byId.get(id);
      if (!track?.filePath) continue;
      lines.push(
        `#EXTINF:${Math.round(track.duration / 1000)},${track.artist} - ${track.title}`,
        track.filePath,
      );
      count++;
    }
    fs.writeFileSync(destination, lines.join("\r\n") + "\r\n", "utf8");
    return count;
  }

  // ─── Placing files ────────────────────────────────────────

  private findPlaylistTrack(trackId: string): Track | undefined {
    for (const pl of store.get("playlists")) {
      const track = pl.tracks.find((t) => t.id === trackId);
      if (track) return track;
    }
    return undefined;
  }

  /**
   * Tag `filePath` for `trackId` and move it to "<library>/Artist - Title.ext".
   * Nothing is overwritten: if the track already has a file, or the target
   * name is taken, a conflict is recorded and the file stays where it is.
   */
  private async placeFileNow(filePath: string, trackId: string): Promise<PlaceResult> {
    const root = this.root;
    if (!root) throw new Error("Dossier de la bibliothèque non configuré");
    const track = this.findPlaylistTrack(trackId);
    if (!track) throw new Error("Morceau de playlist introuvable");

    // Tags first: if writing fails, the file is not moved
    writeTags(filePath, {
      title: track.title,
      artist: track.artist,
      album: track.album,
      linkedTrackIds: [trackId],
    });

    const localFiles = await scanLibrary(root);
    const alreadyLinked = localFiles.find(
      (f) => f.linkedTrackIds?.includes(trackId) && !samePath(f.filePath!, filePath),
    );
    const target = path.join(root, libraryFilename(track, path.extname(filePath)));
    const existingPath =
      alreadyLinked?.filePath ??
      (fs.existsSync(target) && !samePath(target, filePath) ? target : undefined);

    if (existingPath) {
      const conflict: FileConflict = {
        id: crypto.randomUUID(),
        trackId,
        newPath: filePath,
        existingPath,
        reason: alreadyLinked ? "already-linked" : "same-name",
        createdAt: Date.now(),
      };
      store.set("conflicts", [
        ...store.get("conflicts").filter((c) => !samePath(c.newPath, filePath)),
        conflict,
      ]);
      await this.rebuildNow();
      return { status: "conflict", conflict };
    }

    if (filePath !== target) moveFile(filePath, target, root);
    await this.rebuildNow();
    return { status: "placed", filePath: target };
  }

  placeFile(filePath: string, trackId: string) {
    return this.exclusive(() => this.placeFileNow(filePath, trackId));
  }

  /** Link an unknown local file to a playlist track (user-confirmed). */
  linkUnknown(fileTrackId: string, targetTrackId: string) {
    return this.exclusive(async () => {
      const file = store.get("tracks").find((t) => t.id === fileTrackId && t.filePath);
      if (!file?.filePath) throw new Error("Fichier source non trouvé");
      return this.placeFileNow(file.filePath, targetTrackId);
    });
  }

  // ─── Conflicts ────────────────────────────────────────────

  private async describeFile(filePath: string): Promise<ConflictFileInfo> {
    if (!fs.existsSync(filePath)) return { path: filePath, exists: false, linkedTo: [] };
    const info = await parseAudioFile(filePath);
    const linkedTo = (info?.linkedTrackIds || []).map((id) => {
      const t = this.findPlaylistTrack(id);
      return t ? `${t.artist} - ${t.title}` : id;
    });
    return {
      path: filePath,
      exists: true,
      format: info?.format,
      bitRate: info?.bitRate,
      sampleRate: info?.sampleRate,
      bitDepth: info?.bitDepth,
      duration: info?.duration,
      size: info?.fileSize,
      linkedTo,
    };
  }

  async getConflicts(): Promise<ConflictDetails[]> {
    const details: ConflictDetails[] = [];
    for (const conflict of store.get("conflicts")) {
      const track = this.findPlaylistTrack(conflict.trackId);
      details.push({
        ...conflict,
        track: {
          id: conflict.trackId,
          title: track?.title ?? "?",
          artist: track?.artist ?? "?",
          duration: track?.duration ?? 0,
          artwork: track?.artwork ?? "",
        },
        newFile: await this.describeFile(conflict.newPath),
        existingFile: await this.describeFile(conflict.existingPath),
      });
    }
    return details;
  }

  /**
   * keep-existing: the incoming file goes to the trash and the existing file
   * is linked to the track too (same song in two playlists/sources).
   * replace: the existing file goes to the trash and the incoming one takes
   * its place and its links.
   */
  resolveConflict(id: string, choice: ConflictChoice) {
    return this.exclusive(async () => {
      const conflict = store.get("conflicts").find((c) => c.id === id);
      if (!conflict) throw new Error("Conflit introuvable");
      const root = this.root;
      const existingIds = fs.existsSync(conflict.existingPath)
        ? readLinkedIds(conflict.existingPath)
        : [];
      const ids = [...new Set([...existingIds, conflict.trackId])];

      if (choice === "keep-existing") {
        if (fs.existsSync(conflict.existingPath) && ids.length !== existingIds.length) {
          writeLinkedIds(conflict.existingPath, ids);
        }
        await shell.trashItem(conflict.newPath);
        cleanEmptyDirs(path.dirname(conflict.newPath), root);
      } else {
        const track = this.findPlaylistTrack(conflict.trackId);
        if (!track) throw new Error("Morceau de playlist introuvable");
        const target = path.join(root, libraryFilename(track, path.extname(conflict.newPath)));
        if (
          fs.existsSync(target) &&
          !samePath(target, conflict.newPath) &&
          !samePath(target, conflict.existingPath)
        ) {
          throw new Error(`Un autre fichier occupe déjà ${path.basename(target)}`);
        }
        writeLinkedIds(conflict.newPath, ids);
        if (fs.existsSync(conflict.existingPath)) await shell.trashItem(conflict.existingPath);
        if (!samePath(target, conflict.newPath)) moveFile(conflict.newPath, target, root);
      }

      store.set(
        "conflicts",
        store.get("conflicts").filter((c) => c.id !== id),
      );
      await this.rebuildNow();
    });
  }
}
