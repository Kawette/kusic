// ─── Persistent stores ─────────────────────────────────────
import crypto from "crypto";
import Store from "electron-store";
import type {
  FileConflict,
  Playlist,
  SoulseekConfig,
  SpotifyConfig,
  Track,
} from "../types.js";

interface SettingsSchema {
  spotify: SpotifyConfig;
  soulseek: SoulseekConfig;
  autoDownload: boolean;
  /** Key protecting the local slskd API, generated once */
  slskdApiKey: string;
}

export const store = new Store<SettingsSchema>({
  defaults: {
    spotify: { clientId: "", clientSecret: "" },
    soulseek: { username: "", password: "", libraryPath: "" },
    autoDownload: false,
    slskdApiKey: "",
  },
});

if (!store.get("slskdApiKey")) {
  store.set("slskdApiKey", crypto.randomBytes(24).toString("hex"));
}

export interface LibraryData {
  playlists: Playlist[];
  tracks: Track[];
  conflicts: FileConflict[];
}

/** Playlists, track index and conflicts (rewritten on every library change) */
export const libraryStore = new Store<LibraryData>({
  name: "library",
  defaults: { playlists: [], tracks: [], conflicts: [] },
});

// Older versions (and pre-migration backups) kept the library inside config.json
{
  const legacy = store as unknown as Store<Record<string, unknown>>;
  const playlists = legacy.get("playlists") as Playlist[] | undefined;
  if (playlists) {
    if (libraryStore.get("playlists").length === 0) libraryStore.set("playlists", playlists);
    for (const key of ["playlists", "tracks", "conflicts"]) legacy.delete(key);
  }
}

// Other large or frequently written data also lives in separate files so that saving
// it does not rewrite the main config.

export interface ScanCacheEntry {
  mtimeMs: number;
  size: number;
  track: Track;
}

export const scanCache = new Store<{ files: Record<string, ScanCacheEntry> }>({
  name: "scan-cache",
  defaults: { files: {} },
});

/** A download requested for a playlist track, keyed by username + remote path */
export interface PendingDownload {
  username: string;
  filename: string;
  size: number;
  trackId: string;
  requestedAt: number;
  attempts: number;
  error?: string;
}

export const downloadsStore = new Store<{ pending: Record<string, PendingDownload> }>({
  name: "downloads",
  defaults: { pending: {} },
});

/** Index of cached Soulseek searches; results live in one file per query */
export interface CachedSearchEntry {
  file: string;
  count: number;
  /** Audio files whose name contains the track title (absent in old entries) */
  relevant?: number;
  /** Best format among relevant results, e.g. "FLAC" */
  best?: string;
  /** Results certainly the track (absent in older entries) */
  certain?: number;
  timestamp: number;
}

export const searchCacheIndex = new Store<{ searches: Record<string, CachedSearchEntry> }>({
  name: "search-cache",
  defaults: { searches: {} },
});
