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
}

export interface TrackFilters {
  search?: string;
  source?: "all" | "missing" | "matched" | PlaylistSource | "local" | "unknown";
  playlistId?: string;
  sortBy?: "recent" | "title" | "artist" | "duration" | "playlist";
}

/**
 * A downloaded (or identified) file that could not be placed because the
 * track already has a file, or its "Artist - Title" name is taken.
 */
export interface FileConflict {
  id: string;
  trackId: string;
  /** Incoming file, left where it is until the user decides */
  newPath: string;
  /** File currently holding the slot */
  existingPath: string;
  reason: "already-linked" | "same-name";
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
  /** Failed attempts so far; slskd retries automatically (state "Queued, Locally") */
  attempts?: number;
  /** Position in the remote user's upload queue (last known, 0 = unknown) */
  placeInQueue?: number;
  /** Whether the remote user is connected (checked while we wait in their queue) */
  userPresence?: UserPresence;
  trackId?: string;
}
