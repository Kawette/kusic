import { describe, expect, it } from "vitest";
import { artistNames, coreTitle, findMatches, matchGap } from "./matching.js";

const t = (artist: string, title: string, duration = 200_000) => ({ artist, title, duration });

describe("coreTitle", () => {
  it("drops noise but keeps remix information", () => {
    expect(coreTitle("Hasta Siempre (MATRAKK REMIX) / FREE DOWNLOAD")).toBe("hasta siempre matrakk remix");
    expect(coreTitle("Je ne t'aime plus (Remix) [NRRS01]")).toBe("je ne t aime plus remix");
    expect(coreTitle("Song (Original Mix)")).toBe("song");
    expect(coreTitle("BANGKIT PREMIERE: Euromir")).toBe("euromir");
  });
});

describe("artistNames", () => {
  it("splits collaborations", () => {
    expect(artistNames("ROSALÍA, Björk & Yves Tumor feat. Xavi")).toEqual(["rosalia", "bjork", "yves tumor", "xavi"]);
  });
});

describe("matchGap", () => {
  it("matches the same song with a common artist", () => {
    expect(matchGap(t("Ben Gold", "It Really Don't Matter"), t("Ben Gold, CIS", "It Really Don't Matter (Original Mix)", 203_000))).toBe(3000);
  });

  it("never matches a remix with the original", () => {
    expect(matchGap(t("Artist", "Song"), t("Artist", "Song (Someone Remix)"))).toBeNull();
  });

  it("rejects different artists and very different lengths", () => {
    expect(matchGap(t("Other", "Song"), t("Artist", "Song"))).toBeNull();
    expect(matchGap(t("Artist", "Song", 200_000), t("Artist", "Song", 400_000))).toBeNull();
  });

  it("accepts another edit of the same title and artist (shown as a duration gap)", () => {
    expect(matchGap(t("Will Atkinson", "Big Bada Boom", 182_000), t("Will Atkinson", "Big Bada Boom", 207_000))).toBe(25_000);
    expect(matchGap(t("ANDATA", "Never Gonna Stop", 252_000), t("ANDATA, 2HOT2PLAY", "Never Gonna Stop", 230_000))).toBe(22_000);
  });

  it("ignores version info only when the length is the same", () => {
    const track = t("Rian Wood, Mr.Machine", "Better Off Alone", 254_000);
    expect(matchGap(t("Rian Wood", "Rian Wood, Mr.Machine - Better Off Alone (EDIT)", 254_000), track)).toBe(0);
    expect(matchGap(t("Fenrick", "Played-A-Live (Fenrick Extended Edit)", 236_000), t("Fenrick", "Played-A-Live - Fenrick Edit", 183_000))).toBeNull();
  });

  it('reads SoundCloud "Artist - Title" titles', () => {
    expect(matchGap(t("NOAH", "Euromir"), t("Some Label", "BANGKIT PREMIERE: NOAH - Euromir"))).toBe(0);
  });

  it("accepts an untagged file only with a matching length", () => {
    expect(matchGap(t("", "Song", 200_500), t("Artist", "Song", 200_000))).toBe(500);
    expect(matchGap(t("", "Song", 210_000), t("Artist", "Song", 200_000))).toBeNull();
  });
});

describe("findMatches", () => {
  it("returns only strict matches, closest first, two at most", () => {
    const tracks = [t("Alpha", "Song", 230_000), t("Alpha", "Other"), t("Alpha", "Song", 201_000), t("Alpha", "Song", 205_000)];
    expect(findMatches(t("Alpha", "Song"), tracks)).toEqual([tracks[2], tracks[3]]);
    expect(findMatches(t("Nobody", "Nothing"), tracks)).toEqual([]);
  });
});
