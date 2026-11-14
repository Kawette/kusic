// ─── Spotify Service ────────────────────────────────────────
import axios from "axios";
import type { Track, Playlist } from "../types.js";

const API = "https://api.spotify.com/v1";
const PAGE_SIZE = 100;
const ITEM_FIELDS = "id,name,type,is_local,artists(name),album(name,images),duration_ms";
const TIMEOUT = 30_000;

interface SpotifyItem {
  id: string | null;
  name: string;
  type?: string;
  is_local?: boolean;
  artists?: { name: string }[];
  album?: { name?: string; images?: { url: string }[] };
  duration_ms: number;
}

/** Playlist entries: since Feb 2026 the object is under `item` (was `track`). */
interface PlaylistEntry {
  added_at?: string;
  is_local?: boolean;
  item?: SpotifyItem | null;
  track?: SpotifyItem | null;
}

/**
 * Convert a playlist entry to a Track. Podcast episodes and local files
 * (no Spotify id) are skipped.
 */
export function mapPlaylistEntry(entry: PlaylistEntry): Track | null {
  const item = entry.item ?? entry.track;
  if (!item || entry.is_local || item.is_local || !item.id) return null;
  if (item.type && item.type !== "track") return null;

  return {
    id: `spotify_${item.id}`,
    source: "spotify",
    title: item.name,
    artist: (item.artists || []).map((a) => a.name).join(", "),
    album: item.album?.name || "",
    artwork: item.album?.images?.[1]?.url || item.album?.images?.[0]?.url || "",
    duration: item.duration_ms,
    addedAt: Date.parse(entry.added_at || "") || Date.now(),
  };
}

export function extractPlaylistId(url: string): string {
  const match = url.match(/playlist[/:]([a-zA-Z0-9]+)/);
  if (!match) throw new Error("URL de playlist Spotify invalide");
  return match[1];
}

/** Turn API failures into messages the user can act on. */
function explain(err: unknown): Error {
  if (!axios.isAxiosError(err) || !err.response) {
    return new Error(`Spotify injoignable : ${(err as Error).message}`);
  }
  switch (err.response.status) {
    case 400:
    case 401:
      return new Error("Identifiants Spotify invalides (vérifiez Client ID et Client Secret)");
    case 403:
    case 404:
      return new Error(
        "Playlist Spotify introuvable ou inaccessible (les playlists générées par Spotify ne sont pas accessibles via l'API)",
      );
    case 429:
      return new Error("Trop de requêtes Spotify, réessayez dans quelques minutes");
    default:
      return new Error(`Erreur Spotify (HTTP ${err.response.status})`);
  }
}

export class SpotifyService {
  private accessToken: string | null = null;
  private tokenExpiry = 0;

  constructor(
    private clientId: string,
    private clientSecret: string,
  ) {}

  private async authenticate(): Promise<void> {
    if (this.accessToken && Date.now() < this.tokenExpiry) return;

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const response = await axios.post(
      "https://accounts.spotify.com/api/token",
      "grant_type=client_credentials",
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: TIMEOUT,
      },
    );

    this.accessToken = response.data.access_token;
    this.tokenExpiry = Date.now() + response.data.expires_in * 1000 - 60000;
  }

  private async get(url: string, params: Record<string, unknown> = {}) {
    await this.authenticate();
    return axios.get(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
      params,
      timeout: TIMEOUT,
    });
  }

  /** Check the credentials (used by the "Tester" button). */
  async testCredentials(): Promise<void> {
    try {
      await this.authenticate();
    } catch (err) {
      throw explain(err);
    }
  }

  async getPlaylist(url: string): Promise<Playlist> {
    const playlistId = extractPlaylistId(url);
    try {
      const { data: playlist } = await this.get(`${API}/playlists/${playlistId}`, {
        fields: "id,name,description,images,external_urls,items(total),tracks(total)",
      });
      const tracks = await this.getAllPlaylistTracks(playlistId);

      return {
        id: `spotify_${playlist.id}`,
        source: "spotify",
        name: playlist.name,
        description: playlist.description || "",
        url: playlist.external_urls.spotify,
        artwork: playlist.images?.[0]?.url || "",
        totalTracks: playlist.items?.total ?? playlist.tracks?.total ?? tracks.length,
        tracks,
        addedAt: Date.now(),
      };
    } catch (err) {
      throw explain(err);
    }
  }

  private async getAllPlaylistTracks(playlistId: string): Promise<Track[]> {
    try {
      return await this.fetchEntries(`${API}/playlists/${playlistId}/items`, "item");
    } catch (err) {
      // Fall back to the pre-2026 endpoint while it still exists
      if (axios.isAxiosError(err) && [403, 404, 410].includes(err.response?.status ?? 0)) {
        return this.fetchEntries(`${API}/playlists/${playlistId}/tracks`, "track");
      }
      throw err;
    }
  }

  private async fetchEntries(endpoint: string, key: "item" | "track"): Promise<Track[]> {
    const tracks: Track[] = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data } = await this.get(endpoint, {
        offset,
        limit: PAGE_SIZE,
        fields: `items(added_at,is_local,${key}(${ITEM_FIELDS})),next`,
      });
      for (const entry of data.items as PlaylistEntry[]) {
        const track = mapPlaylistEntry(entry);
        if (track) tracks.push(track);
      }
      if (!data.next) return tracks;
    }
  }
}
