import { describe, expect, it } from 'vitest';
import { fallbackQuery, isRelevant, relevanceOf, searchStats, trackQuery } from './query.js';

const track = (artist, title) => ({ artist, title });
const result = (filename, extension = 'flac', quality = 100) => ({ filename, extension, quality });

describe('trackQuery', () => {
  it('keeps only the main artist and plain words', () => {
    expect(trackQuery(track('Snoritz, Sven Kruetzmann, Redux Rangers', 'Never Look Back'))).toBe('snoritz never look back');
    expect(trackQuery(track('Flour, GALLØ', 'Back To You'))).toBe('flour back to you');
    expect(trackQuery(track('HiTMiLØW, HUMAN ERROR', 'PIMPIN´'))).toBe('hitmilow pimpin');
  });

  it('drops noise but keeps remix / edit information', () => {
    expect(trackQuery(track('REVEX, Vespera', 'Bouncy Malice - Original mix'))).toBe('revex bouncy malice');
    expect(trackQuery(track('SHVDZ', 'Candy Shop (SHVDZ Edit) FREE DL'))).toBe('shvdz candy shop edit');
    expect(trackQuery(track('Radar, 666', 'Bass Up (feat. 666) - Extended Mix'))).toBe('radar bass up');
    expect(trackQuery(track('Lock N Load', 'Blow Ya Mind - DJ Daddy Trance Remix'))).toBe('lock n load blow ya mind dj daddy trance remix');
  });

  it('uses the artist written in SoundCloud "Artist - Title" titles', () => {
    expect(trackQuery(track('Polyamor Records', 'FOVOS - Ya Mama'))).toBe('fovos ya mama');
    expect(trackQuery(track('TBR', 'Justin Timberlake - SexyBack (TBR Edit) *PLAYED BY: I HATE MODELS*'))).toBe('justin timberlake sexyback tbr edit');
  });
});

describe('fallback and relevance', () => {
  it('falls back to the bare title', () => {
    expect(fallbackQuery(track('Contec, Lina Maly', 'Als du gingst - edit'))).toBe('als du gingst');
    expect(fallbackQuery(track('Sopik', 'Levada'))).toBe('levada');
  });

  it('needs the title in the file name and an artist in the path', () => {
    const words = relevanceOf(track('AZZEL 447', 'Breeze'));
    expect(isRelevant(result('@@music\\Techno\\AZZEL_447-Breeze-WEB\\01-azzel_447-breeze.flac'), words)).toBe(true);
    expect(isRelevant(result('@@music\\Techno\\AZZEL_447-Breeze-WEB\\02-azzel_447-other.flac'), words)).toBe(false);
    expect(isRelevant(result('@@music\\AZZEL 447 - Breeze\\breeze.nfo', 'nfo'), words)).toBe(false);
    // Same title by someone else
    expect(isRelevant(result('@@music\\Pop\\Other Artist - Breeze.mp3', 'mp3'), words)).toBe(false);
  });

  it('accepts any credited artist, also from SoundCloud titles', () => {
    const multi = relevanceOf(track('snoritz, Sven Kruetzmann', 'Never Look Back'));
    expect(isRelevant(result('x\\Sven Kruetzmann\\Never Look Back.flac'), multi)).toBe(true);
    const sc = relevanceOf(track('Polyamor Records', 'FOVOS - Ya Mama'));
    expect(isRelevant(result('x\\FOVOS - Ya Mama.wav', 'wav'), sc)).toBe(true);
  });

  it('counts relevant results and their best format', () => {
    const t = track('Mac Declos', 'Sexiness');
    const stats = searchStats([
      result('a\\Mac Declos - Sexiness.mp3', 'mp3', 80),
      result('b\\Mac Declos - Sexiness.flac', 'flac', 120),
      result('c\\Mac Declos - Other.flac', 'flac', 130),
    ], t);
    expect(stats).toEqual({ relevant: 2, best: 'FLAC' });
  });
});
