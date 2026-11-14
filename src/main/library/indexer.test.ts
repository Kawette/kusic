import { describe, expect, it } from "vitest";
import type { FileConflict, Playlist, Track } from "../../types.js";
import { buildTrackIndex } from "./indexer.js";

const track = (id: string, extra: Partial<Track> = {}): Track => ({
  id,
  source: "spotify",
  title: id,
  artist: "Artist",
  album: "",
  artwork: "",
  duration: 180000,
  addedAt: 1,
  ...extra,
});

const playlist = (id: string, tracks: Track[]): Playlist => ({
  id,
  source: "spotify",
  name: id,
  description: "",
  url: `https://open.spotify.com/playlist/${id}`,
  artwork: "",
  totalTracks: tracks.length,
  tracks,
  addedAt: 1,
});

const file = (name: string, linkedTrackIds: string[] = [], extra: Partial<Track> = {}): Track =>
  track(`local-${name}`, {
    source: linkedTrackIds.length ? "local" : "unknown",
    filePath: `C:\\Lib\\${name}`,
    format: "FLAC",
    sampleRate: 44100,
    linkedTrackIds,
    ...extra,
  });

describe("buildTrackIndex", () => {
  it("lists a track present in several playlists once", () => {
    const tracks = buildTrackIndex(
      [playlist("p1", [track("a"), track("b")]), playlist("p2", [track("a")])],
      [],
    );
    expect(tracks.map((t) => t.id)).toEqual(["a", "b"]);
    expect(tracks[0].playlistIds).toEqual(["p1", "p2"]);
  });

  it("attaches the linked file quality to the playlist track", () => {
    const [a] = buildTrackIndex([playlist("p1", [track("a")])], [file("a.flac", ["a"])]);
    expect(a).toMatchObject({ id: "a", source: "spotify", format: "FLAC", filePath: "C:\\Lib\\a.flac" });
  });

  it("lets one file serve the same song from two sources", () => {
    const tracks = buildTrackIndex(
      [playlist("p1", [track("spotify_a"), track("soundcloud_a", { source: "soundcloud" })])],
      [file("a.flac", ["spotify_a", "soundcloud_a"])],
    );
    expect(tracks.filter((t) => t.filePath).map((t) => t.id)).toEqual(["spotify_a", "soundcloud_a"]);
    expect(tracks).toHaveLength(2);
  });

  it("keeps a second file linked to the same track visible", () => {
    const tracks = buildTrackIndex(
      [playlist("p1", [track("a")])],
      [file("a.flac", ["a"]), file("a.mp3", ["a"], { format: "MP3" })],
    );
    expect(tracks).toHaveLength(2);
    expect(tracks[1]).toMatchObject({ source: "local", filePath: "C:\\Lib\\a.mp3" });
  });

  it("marks untagged files unknown and stale links local", () => {
    const tracks = buildTrackIndex(
      [playlist("p1", [track("a")])],
      [file("x.mp3"), file("y.mp3", ["removed_track"])],
    );
    expect(tracks.find((t) => t.filePath?.endsWith("x.mp3"))?.source).toBe("unknown");
    expect(tracks.find((t) => t.filePath?.endsWith("y.mp3"))?.source).toBe("local");
  });

  it("strips stale local data from playlist tracks", () => {
    const [a] = buildTrackIndex(
      [playlist("p1", [track("a", { format: "MP3", filePath: "C:\\old.mp3" })])],
      [],
    );
    expect(a.format).toBeUndefined();
    expect(a.filePath).toBeUndefined();
  });

  it("hides the incoming file of a conflict and flags the track", () => {
    const conflict: FileConflict = {
      id: "c1",
      trackId: "a",
      newPath: "C:\\Lib\\dl\\a.mp3",
      existingPath: "C:\\Lib\\a.flac",
      reason: "already-linked",
      createdAt: 1,
    };
    const tracks = buildTrackIndex(
      [playlist("p1", [track("a")])],
      [file("a.flac", ["a"]), file("dl\\a.mp3", ["a"])],
      [conflict],
    );
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ conflictId: "c1", filePath: "C:\\Lib\\a.flac" });
  });
});
