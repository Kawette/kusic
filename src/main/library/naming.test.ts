import { describe, expect, it } from "vitest";
import path from "path";
import {
  formatKusicComment,
  isInside,
  libraryFilename,
  parseArtistTitle,
  parseKusicIds,
  samePath,
  sanitizeFilename,
  slskdLocalPath,
} from "./naming.js";

describe("sanitizeFilename", () => {
  it("removes characters Windows rejects", () => {
    expect(sanitizeFilename('AC/DC: "Back" <in> Black?*|')).toBe("ACDC Back in Black");
  });

  it("removes control characters and trailing dots/spaces", () => {
    expect(sanitizeFilename("Title\u0007 ... ")).toBe("Title");
  });

  it("caps the length", () => {
    expect(sanitizeFilename("a".repeat(300)).length).toBe(120);
  });
});

describe("libraryFilename", () => {
  it('builds "Artist - Title.ext" with a lower-case extension', () => {
    expect(libraryFilename({ artist: "O'Brien", title: 'Song "Live"' }, ".FLAC")).toBe(
      "O'Brien - Song Live.flac",
    );
  });

  it("never produces an empty part", () => {
    expect(libraryFilename({ artist: "???", title: "" }, ".mp3")).toBe(
      "Artiste inconnu - Sans titre.mp3",
    );
  });
});

describe("KUSIC tag", () => {
  it("parses one or several ids", () => {
    expect(parseKusicIds("[KUSIC:spotify_1] comment")).toEqual(["spotify_1"]);
    expect(parseKusicIds("[KUSIC:spotify_1,soundcloud_2]")).toEqual(["spotify_1", "soundcloud_2"]);
    expect(parseKusicIds("no tag")).toEqual([]);
    expect(parseKusicIds(undefined)).toEqual([]);
  });

  it("replaces an existing tag instead of keeping a foreign one", () => {
    expect(formatKusicComment("[KUSIC:other_user_track] Ripped by X", ["spotify_1"])).toBe(
      "[KUSIC:spotify_1] Ripped by X",
    );
  });

  it("can store several ids and remove the tag", () => {
    expect(formatKusicComment("", ["a", "b"])).toBe("[KUSIC:a,b]");
    expect(formatKusicComment("[KUSIC:a] keep me", [])).toBe("keep me");
  });

  it("round-trips", () => {
    const comment = formatKusicComment("hello", ["spotify_1", "soundcloud_9"]);
    expect(parseKusicIds(comment)).toEqual(["spotify_1", "soundcloud_9"]);
  });
});

describe("parseArtistTitle", () => {
  it('splits "Artist - Title" on various dashes', () => {
    expect(parseArtistTitle("Daft Punk - One More Time")).toEqual({ artist: "Daft Punk", title: "One More Time" });
    expect(parseArtistTitle("Artist – Title – Remix")).toEqual({ artist: "Artist", title: "Title – Remix" });
  });

  it("keeps the whole name as title otherwise", () => {
    expect(parseArtistTitle("track01")).toEqual({ title: "track01" });
  });
});

describe("paths", () => {
  it("compares Windows paths case-insensitively", () => {
    expect(samePath("C:\\Music\\A.mp3", "c:\\music\\a.MP3")).toBe(true);
    expect(samePath("C:\\Music\\A.mp3", "C:\\Music\\B.mp3")).toBe(false);
  });

  it("detects paths inside a folder", () => {
    expect(isInside(path.join("C:\\Music", "sub", "a.mp3"), "C:\\Music")).toBe(true);
    expect(isInside("C:\\Other\\a.mp3", "C:\\Music")).toBe(false);
    expect(isInside("C:\\Music2\\a.mp3", "C:\\Music")).toBe(false);
  });

  it("mirrors where slskd saves a download", () => {
    expect(slskdLocalPath("C:\\Lib", "@@user\\Music\\Album: Live\\01 - Song?.flac")).toBe(
      path.join("C:\\Lib", "Album_ Live", "01 - Song_.flac"),
    );
    expect(slskdLocalPath("C:\\Lib", "file.mp3")).toBe(path.join("C:\\Lib", "file.mp3"));
  });
});
