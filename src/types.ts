// ─── Kusic Shared Types ─────────────────────────────────────

export type PlaylistSource = "spotify" | "soundcloud";

export interface Track {
  id: string;
  source: PlaylistSource | "local" | "unknown";
  title: string;
  artist: string;
  album: string;
  artwork: string;
  duration: number;
  addedAt: number;
  /** Playlists containing this track (playlist tracks only) */
  playlistIds?: string[];
  // Local file metadata
  format?: string;
  bitRate?: number;
  sampleRate?: number;
  bitDepth?: number;
  fileSize?: number;
  filePath?: string;
  /** Playlist track ids stored in the file's [KUSIC:...] tag */
  linkedTrackIds?: string[];
  /** Pending file conflict for this track, resolved by the user */
  conflictId?: string;
  /** Unknown file: playlist tracks it strictly matches (link on user click) */
  suggestedTrackIds?: string[];
}

export interface Playlist {
  id: string;
  source: PlaylistSource;
  name: string;
  description: string;
  url: string;
  artwork: string;
  totalTracks: number;
  tracks: Track[];
  addedAt: number;
}

export interface SpotifyConfig {
  clientId: string;
  clientSecret: string;
}

export interface SoulseekConfig {
  username: string;
  password: string;
  libraryPath: string;
}

export interface AppSettings {
  spotify: SpotifyConfig;
  soulseek: SoulseekConfig;
  /** Auto-search downloads the results that are certainly the track (opt-in) */
  autoDownload: boolean;
}

export interface TrackFilters {
  search?: string;
  source?: "all" | "missing" | "matched" | "conflicts" | PlaylistSource | "local" | "unknown";
  playlistId?: string;
  sortBy?: "recent" | "title" | "artist" | "duration" | "playlist";
}

/**
 * Two files competing for a playlist track: a downloaded (or identified)
 * file that could not be placed because the track already has a file or its
 * "Artist - Title" name is taken, or a duplicate found in the library.
 */
export interface FileConflict {
  id: string;
  trackId: string;
  /** Incoming file, left where it is until the user decides */
  newPath: string;
  /** File currently holding the slot */
  existingPath: string;
  /** already-linked / same-name: when placing a file; duplicate: found by a scan */
  reason: "already-linked" | "same-name" | "duplicate";
  createdAt: number;
}

export interface ConflictFileInfo {
  path: string;
  exists: boolean;
  format?: string;
  bitRate?: number;
  sampleRate?: number;
  bitDepth?: number;
  duration?: number;
  size?: number;
  /** Cover embedded in the file (kusic-cover:// thumbnail), if any */
  artwork?: string;
  /** Titles of the playlist tracks this file is linked to */
  linkedTo: string[];
}

export interface ConflictDetails extends FileConflict {
  track: Pick<Track, "id" | "title" | "artist" | "duration" | "artwork">;
  newFile: ConflictFileInfo;
  existingFile: ConflictFileInfo;
}

export type ConflictChoice = "keep-existing" | "replace";

// ─── Slskd Types ────────────────────────────────────────────

export interface SlskdStatus {
  running: boolean;
  connected: boolean;
  connecting?: boolean;
  starting?: boolean;
  username?: string;
  state?: string;
  lastError?: string;
}

export interface SlskdSearchResult {
  username: string;
  hasFreeUploadSlot: boolean;
  uploadSpeed: number;
  queueLength?: number;
  filename: string;
  size: number;
  bitRate?: number;
  sampleRate?: number;
  bitDepth?: number;
  length?: number;
  extension: string;
  quality: number;
}

export type UserPresence = "online" | "away" | "offline";

/** Speed of a remote upload queue (see main/queue-estimate.ts) */
export interface QueueEstimate {
  /** Places gained per minute: 0 = no progress, negative = we lost places */
  rate: number;
  /** Expected wait in ms, when there is progress */
  eta?: number;
}

/** A download as shown in the UI, annotated with the playlist track it is for */
export interface Transfer {
  username: string;
  id: string;
  filename: string;
  state: string;
  size: number;
  bytesTransferred: number;
  percentComplete: number;
  averageSpeed: number;
  /** Position in the remote user's upload queue (last known, 0 = unknown) */
  placeInQueue?: number;
  /** Whether the remote user is connected (checked while we wait in their queue) */
  userPresence?: UserPresence;
  /** Speed of the remote queue (measured while we wait in it, from the second check) */
  queueEstimate?: QueueEstimate;
  /** Last check of the queue position and how often it is checked (ms) */
  queueCheck?: { at: number; every: number };
  /** Stopped when slskd closed and not requested again since (user offline…) */
  interrupted?: boolean;
  /** Downloaded, waiting to be tagged and placed in the library */
  placing?: boolean;
  trackId?: string;
}
