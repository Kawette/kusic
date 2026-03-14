// ─── Kusic Shared Types ─────────────────────────────────────

export interface Track {
  id: string;
  source: "spotify" | "soundcloud" | "local" | "unknown";
  title: string;
  artist: string;
  album: string;
  artwork: string;
  duration: number;
  addedAt: number;
  spotifyUrl?: string;
  soundcloudUrl?: string;
  previewUrl?: string | null;
  streamUrl?: string | null;
  // Local file metadata
  format?: string;
  bitRate?: number;
  sampleRate?: number;
  bitDepth?: number;
  filePath?: string;
  linkedTrackId?: string;  // KUSIC_TRACK_ID for linking to playlist track
}

export interface Playlist {
  id: string;
  source: "spotify" | "soundcloud";
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

export interface AppStats {
  totalPlaylists: number;
  totalTracks: number;
  spotifyTracks: number;
  soundcloudTracks: number;
}

export interface TrackFilters {
  search?: string;
  source?: "all" | "spotify" | "soundcloud" | "local" | "unknown";
  sortBy?: "recent" | "title" | "artist" | "duration";
}

// ─── Slskd Types ────────────────────────────────────────────

export interface SlskdStatus {
  running: boolean;
  connected: boolean;
  connecting?: boolean;
  username?: string;
  state?: string;
}

export interface SlskdSearchResult {
  username: string;
  freeUploadSlots: number;
  uploadSpeed: number;
  filename: string;
  size: number;
  bitRate?: number;
  sampleRate?: number;
  bitDepth?: number;
  length?: number;
  extension: string;
  quality: number;
}

export interface SlskdSearchResponse {
  id: string;
  results: SlskdSearchResult[];
}

export interface PlatformInfo {
  supported: boolean;
  platform: string;
  arch?: string;
}

export interface VersionInfo {
  version: string;
  installed: boolean;
}
