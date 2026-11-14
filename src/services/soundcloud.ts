// ─── SoundCloud Service ─────────────────────────────────────
import axios from "axios";
import type { Track, Playlist } from "../types.js";

// SoundCloud rejects requests without a browser-like User-Agent
const http = axios.create({
  timeout: 30_000,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  },
});

export interface SoundCloudTrack {
  id: number;
  title?: string;
  user?: { username: string; avatar_url?: string };
  artwork_url?: string;
  duration?: number;
}

interface SoundCloudPlaylist {
  id: number;
  kind: string;
  title: string;
  description?: string;
  permalink_url: string;
  artwork_url?: string;
  track_count: number;
  tracks: SoundCloudTrack[];
}

/** Scraped from soundcloud.com and shared by all service instances */
let cachedClientId: string | null = null;

async function scrapeClientId(): Promise<string> {
  const pageRes = await http.get("https://soundcloud.com/");
  const scriptUrls: string[] =
    pageRes.data.match(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^\s"]+\.js/g) || [];
  if (scriptUrls.length === 0) {
    throw new Error("Impossible de trouver les scripts SoundCloud");
  }

  // The client id is usually defined in one of the last bundles
  for (const scriptUrl of scriptUrls.slice(-5).reverse()) {
    const scriptRes = await http.get(scriptUrl);
    const match = scriptRes.data.match(/client_id\s*:\s*"([a-zA-Z0-9]+)"/);
    if (match) return match[1];
  }
  throw new Error("Impossible de résoudre le client_id SoundCloud");
}

/**
 * Restore the playlist order: complete tracks come with the playlist, the
 * others are fetched separately by id.
 */
export function orderTracks(
  ids: number[],
  fetched: Map<number, SoundCloudTrack>,
): SoundCloudTrack[] {
  return ids.map((id) => fetched.get(id)).filter((t): t is SoundCloudTrack => !!t);
}

export class SoundCloudService {
  /** GET with the shared client id, re-scraped once if it was revoked. */
  private async api<T>(url: string, params: Record<string, unknown>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      cachedClientId ??= await scrapeClientId();
      try {
        const res = await http.get(url, { params: { ...params, client_id: cachedClientId } });
        return res.data;
      } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        if (attempt === 0 && (status === 401 || status === 403)) {
          cachedClientId = null;
          continue;
        }
        throw err;
      }
    }
  }

  async getPlaylist(url: string): Promise<Playlist> {
    const data = await this.api<SoundCloudPlaylist>("https://api-v2.soundcloud.com/resolve", { url })
      .catch((err) => {
        if (axios.isAxiosError(err) && err.response?.status === 404) {
          throw new Error("Playlist SoundCloud introuvable (privée ou supprimée ?)");
        }
        throw err;
      });

    if (data.kind !== "playlist") {
      throw new Error("L'URL fournie n'est pas une playlist SoundCloud");
    }

    const fetched = new Map<number, SoundCloudTrack>();
    const incompleteIds: number[] = [];
    for (const track of data.tracks) {
      if (track.title) fetched.set(track.id, track);
      else incompleteIds.push(track.id);
    }

    // Fetch incomplete tracks in batches of 50. A failure aborts the whole
    // fetch so a refresh never replaces a playlist with a partial one.
    for (let i = 0; i < incompleteIds.length; i += 50) {
      const batch = await this.api<SoundCloudTrack[]>("https://api-v2.soundcloud.com/tracks", {
        ids: incompleteIds.slice(i, i + 50).join(","),
      });
      for (const track of batch) fetched.set(track.id, track);
    }

    const tracks = orderTracks(
      data.tracks.map((t) => t.id),
      fetched,
    ).map(formatTrack);

    return {
      id: `soundcloud_${data.id}`,
      source: "soundcloud",
      name: data.title,
      description: data.description || "",
      url: data.permalink_url,
      // Playlists without their own cover show the first track's
      artwork: data.artwork_url
        ? data.artwork_url.replace("-large", "-t500x500")
        : tracks[0]?.artwork.replace("-t200x200", "-t500x500") || "",
      totalTracks: data.track_count,
      tracks,
      addedAt: Date.now(),
    };
  }
}

export function formatTrack(track: SoundCloudTrack): Track {
  return {
    id: `soundcloud_${track.id}`,
    source: "soundcloud",
    title: track.title || "Sans titre",
    artist: track.user?.username || "Inconnu",
    album: "",
    artwork: track.artwork_url
      ? track.artwork_url.replace("-large", "-t200x200")
      : track.user?.avatar_url || "",
    duration: track.duration || 0,
    addedAt: Date.now(),
  };
}
