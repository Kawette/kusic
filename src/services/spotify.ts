// ─── Spotify Service ────────────────────────────────────────
import axios from "axios";
import type { Track, Playlist } from "../types.js";

export class SpotifyService {
  private clientId: string;
  private clientSecret: string;
  private accessToken: string | null = null;
  private tokenExpiry = 0;

  constructor(clientId: string, clientSecret: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  private async authenticate(): Promise<void> {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return;
    }

    const credentials = Buffer.from(
      `${this.clientId}:${this.clientSecret}`,
    ).toString("base64");

    const response = await axios.post(
      "https://accounts.spotify.com/api/token",
      "grant_type=client_credentials",
      {
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );

    this.accessToken = response.data.access_token;
    this.tokenExpiry = Date.now() + response.data.expires_in * 1000 - 60000;
  }

  private extractPlaylistId(url: string): string {
    const match = url.match(/playlist[/:]([a-zA-Z0-9]+)/);
    if (!match) throw new Error("URL de playlist Spotify invalide");
    return match[1];
  }

  async getPlaylist(url: string): Promise<Playlist> {
    await this.authenticate();

    const playlistId = this.extractPlaylistId(url);

    const playlistRes = await axios.get(
      `https://api.spotify.com/v1/playlists/${playlistId}`,
      {
        headers: { Authorization: `Bearer ${this.accessToken}` },
        params: {
          fields: "id,name,description,images,external_urls,tracks.total",
        },
      },
    );

    const playlist = playlistRes.data;
    const tracks = await this.getAllPlaylistTracks(playlistId);

    return {
      id: `spotify_${playlist.id}`,
      source: "spotify",
      name: playlist.name,
      description: playlist.description || "",
      url: playlist.external_urls.spotify,
      artwork: playlist.images?.[0]?.url || "",
      totalTracks: playlist.tracks.total,
      tracks,
      addedAt: Date.now(),
    };
  }

  private async getAllPlaylistTracks(playlistId: string): Promise<Track[]> {
    const tracks: Track[] = [];
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
      const response = await axios.get(
        `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
        {
          headers: { Authorization: `Bearer ${this.accessToken}` },
          params: {
            offset,
            limit,
            fields:
              "items(track(id,name,artists,album,duration_ms,external_urls,preview_url)),next",
          },
        },
      );

      for (const item of response.data.items) {
        if (!item.track) continue;

        const track = item.track;
        tracks.push({
          id: `spotify_${track.id}`,
          source: "spotify",
          title: track.name,
          artist: track.artists.map((a: { name: string }) => a.name).join(", "),
          album: track.album?.name || "",
          artwork:
            track.album?.images?.[1]?.url ||
            track.album?.images?.[0]?.url ||
            "",
          duration: track.duration_ms,
          spotifyUrl: track.external_urls.spotify,
          previewUrl: track.preview_url,
          addedAt: Date.now(),
        });
      }

      hasMore = !!response.data.next;
      offset += limit;
    }

    return tracks;
  }
}
