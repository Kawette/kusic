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
  playlists: Playlist[];
  tracks: Track[];
  conflicts: FileConflict[];
  spotify: SpotifyConfig;
  soulseek: SoulseekConfig;
  /** Key protecting the local slskd API, generated once */
  slskdApiKey: string;
}

export const store = new Store<SettingsSchema>({
  defaults: {
    playlists: [],
    tracks: [],
    conflicts: [],
    spotify: { clientId: "", clientSecret: "" },
    soulseek: { username: "", password: "", libraryPath: "" },
    slskdApiKey: "",
  },
});

if (!store.get("slskdApiKey")) {
  store.set("slskdApiKey", crypto.randomBytes(24).toString("hex"));
}

// Large or frequently written data lives in separate files so that saving
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
  timestamp: number;
}

export const searchCacheIndex = new Store<{ searches: Record<string, CachedSearchEntry> }>({
  name: "search-cache",
  defaults: { searches: {} },
});
