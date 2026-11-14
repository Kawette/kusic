import { describe, expect, it } from "vitest";
import { extractPlaylistId, mapPlaylistEntry } from "./spotify.js";
import { formatTrack, orderTracks, type SoundCloudTrack } from "./soundcloud.js";

describe("Spotify", () => {
  const item = {
    id: "abc",
    name: "Song",
    type: "track",
    artists: [{ name: "A" }, { name: "B" }],
    album: { name: "Album", images: [{ url: "big" }, { url: "medium" }] },
    duration_ms: 200000,
    external_urls: { spotify: "https://open.spotify.com/track/abc" },
  };

  it("maps the 2026 `item` and the legacy `track` entries", () => {
    for (const entry of [{ item }, { track: item }]) {
      expect(mapPlaylistEntry(entry)).toMatchObject({
        id: "spotify_abc",
        title: "Song",
        artist: "A, B",
        album: "Album",
        artwork: "medium",
        duration: 200000,
      });
    }
  });

  it("skips episodes, local files and removed tracks", () => {
    expect(mapPlaylistEntry({ item: { ...item, type: "episode" } })).toBeNull();
    expect(mapPlaylistEntry({ is_local: true, item: { ...item, id: null } })).toBeNull();
    expect(mapPlaylistEntry({ item: null })).toBeNull();
  });

  it("extracts playlist ids from URLs and URIs", () => {
    expect(extractPlaylistId("https://open.spotify.com/playlist/37i9dQZF1DX?si=x")).toBe("37i9dQZF1DX");
    expect(extractPlaylistId("spotify:playlist:16b8D4la")).toBe("16b8D4la");
    expect(() => extractPlaylistId("https://open.spotify.com/album/x")).toThrow();
  });
});

describe("SoundCloud", () => {
  it("restores the playlist order after fetching incomplete tracks", () => {
    const fetched = new Map<number, SoundCloudTrack>([
      [3, { id: 3, title: "c" }],
      [1, { id: 1, title: "a" }],
    ]);
    expect(orderTracks([1, 2, 3], fetched).map((t) => t.id)).toEqual([1, 3]);
  });

  it("formats tracks with a larger artwork", () => {
    expect(
      formatTrack({
        id: 7,
        title: "T",
        user: { username: "U" },
        artwork_url: "https://i1.sndcdn.com/x-large.jpg",
        duration: 1000,
      }),
    ).toMatchObject({ id: "soundcloud_7", artist: "U", artwork: "https://i1.sndcdn.com/x-t200x200.jpg" });
  });
});
