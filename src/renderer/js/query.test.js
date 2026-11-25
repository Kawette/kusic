import { describe, expect, it } from 'vitest';
import {
  certainMatches, fallbackQuery, isCertainMatch, isRelevant, matchDoubts, relevanceOf, searchStats,
  trackQuery,
} from './query.js';

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
    expect(stats).toEqual({ relevant: 2, best: 'FLAC', certain: 0 }); // No duration: never certain
  });
});

describe('certain matches (automatic download)', () => {
  const song = (artist, title, seconds) => ({ artist, title, duration: seconds * 1000 });
  const file = (filename, extra = {}) => ({
    filename, extension: filename.split('.').pop(), length: 300, bitRate: 0, hasFreeUploadSlot: true, ...extra,
  });

  it('accepts the same song, same length, good quality', () => {
    const t = song('Mac Declos', 'Sexiness', 300);
    expect(isCertainMatch(file('a/Mac Declos - Sexiness.flac'), t)).toBe(true);
    expect(isCertainMatch(file('a/Mac Declos/01 - Sexiness (Original Mix).mp3', { bitRate: 320, length: 301 }), t)).toBe(true);
  });

  it('refuses another version of the song', () => {
    const t = song('Mac Declos', 'Sexiness', 300);
    expect(isCertainMatch(file('a/Mac Declos - Sexiness (DJ X Remix).flac'), t)).toBe(false);
    expect(isCertainMatch(file('a/Mac Declos - Sexiness (Extended Mix).flac'), t)).toBe(false);
    expect(isCertainMatch(file('a/Mac Declos - Sexiness (Live).flac'), t)).toBe(false);
    expect(isCertainMatch(file('a/Mac Declos - Sexiness (Instrumental).flac'), t)).toBe(false);
  });

  it('needs the right remixer for a remix', () => {
    const t = song('Lock N Load', 'Blow Ya Mind - DJ Daddy Trance Remix', 300);
    expect(isCertainMatch(file('x/Lock N Load - Blow Ya Mind (DJ Daddy Trance Remix).flac'), t)).toBe(true);
    expect(isCertainMatch(file('x/Lock N Load - Blow Ya Mind (Other Guy Remix).flac'), t)).toBe(false);
    expect(isCertainMatch(file('x/Lock N Load - Blow Ya Mind.flac'), t)).toBe(false);
  });

  it('refuses a different length, an unknown length or a poor quality', () => {
    const t = song('Mac Declos', 'Sexiness', 300);
    expect(isCertainMatch(file('a/Mac Declos - Sexiness.flac', { length: 303 }), t)).toBe(false);
    expect(isCertainMatch(file('a/Mac Declos - Sexiness.flac', { length: 0 }), t)).toBe(false);
    expect(isCertainMatch(file('a/Mac Declos - Sexiness.mp3', { bitRate: 256 }), t)).toBe(false);
    expect(isCertainMatch(file('a/Mac Declos - Sexiness.m4a'), t)).toBe(false);
  });

  it('does not mistake an artist name for a version', () => {
    const t = song('Club Yoko', 'Sunrise', 300);
    expect(isCertainMatch(file('a/Club Yoko - Sunrise.flac'), t)).toBe(true);
  });

  it('does not trust an artist named like the title', () => {
    const t = song('fake_friends, Jacidorex, AIROD', 'Fake Friends', 300);
    expect(isCertainMatch(file('Joan Jett and The Blackhearts - Album - 01 Fake Friends.flac'), t)).toBe(false);
    expect(isCertainMatch(file('Jacidorex & AIROD/01 Fake Friends.flac'), t)).toBe(true);
    // Every other credited artist is needed
    expect(isCertainMatch(file('Jacidorex/01 Fake Friends.flac'), t)).toBe(false);
    // A song named after its only artist stays possible
    expect(isCertainMatch(file('a/Sopik - Sopik.flac'), song('Sopik', 'Sopik', 300))).toBe(true);
  });

  it('refuses DJ pool clean / dirty versions', () => {
    const t = song('Panteros666', 'Chasing Dreams', 300);
    expect(isCertainMatch(file('a/Panteros666 - Chasing Dreams (Clean) 9A 98.mp3', { bitRate: 320 }), t)).toBe(false);
    expect(isCertainMatch(file('a/Panteros666 - Chasing Dreams (Dirty).flac'), t)).toBe(false);
  });

  it('explains why a result is not certain', () => {
    const t = song('LUKA, Morelia', 'Breathe', 216);
    expect(matchDoubts(file('a/Luka - Breathe (Extended Mix).m4a', { length: 293 }), t))
      .toEqual(['Artiste absent : Morelia', 'Extended', 'Durée +1:17', 'M4A']);
    expect(matchDoubts(file('a/Luka & Morelia - Breathe.mp3', { bitRate: 256, length: 214 }), t))
      .toEqual(['MP3 256 kbps']); // 2 s off: still the same length
    expect(matchDoubts(file('a/Luka & Morelia - Breathe.flac', { length: 216 }), t)).toEqual([]);
    const remix = song('Lock N Load', 'Blow Ya Mind - DJ Daddy Trance Remix', 300);
    expect(matchDoubts(file('x/Lock N Load - Blow Ya Mind.flac'), remix)).toEqual(['Manque « dj daddy trance remix »']);
    const live = song('Mac Declos', 'Sexiness (Live at Fabric)', 300);
    expect(matchDoubts(file('a/Mac Declos - Sexiness.flac'), live)).toEqual(['Manque « live »']);
  });

  it('prefers FLAC, then a free slot', () => {
    const t = song('Mac Declos', 'Sexiness', 300);
    const busyFlac = file('a/Mac Declos - Sexiness.flac', { hasFreeUploadSlot: false });
    const freeMp3 = file('b/Mac Declos - Sexiness.mp3', { bitRate: 320 });
    const freeFlac = file('c/Mac Declos - Sexiness.flac');
    expect(certainMatches([freeMp3, busyFlac], t)).toEqual([busyFlac, freeMp3]);
    expect(certainMatches([busyFlac, freeMp3, freeFlac], t)[0]).toBe(freeFlac);
    expect(certainMatches([file('d/Mac Declos - Sexiness (Remix).flac')], t)).toEqual([]);
  });

  it('never trusts a title it cannot read', () => {
    const t = song('YOASOBI', '夜に駆ける', 300);
    expect(matchDoubts(file('m/YOASOBI/03 - 群青.flac'), t)).toEqual(['Titre non comparable']);
  });

  it('reads " - Acoustic" as the version outside SoundCloud', () => {
    const t = song('Ed Sheeran', 'Perfect - Acoustic', 300);
    expect(isCertainMatch(file('m/Ed Sheeran - Perfect (Acoustic).flac'), t)).toBe(true);
    expect(isCertainMatch(file('m/Ed Sheeran - Thinking Out Loud (Acoustic).flac'), t)).toBe(false);
    expect(matchDoubts(file('m/Band - Perfect (Acoustic).flac'), t)).toEqual(['Artiste absent : Ed Sheeran']);
    // SoundCloud: the artist of the title, not the uploader
    const sc = { ...song('Polyamor Records', 'FOVOS - Ya Mama', 300), source: 'soundcloud' };
    expect(isCertainMatch(file('x/FOVOS - Ya Mama.flac'), sc)).toBe(true);
  });

  it('spreads downloads over users, FLAC still first', () => {
    const t = song('Mac Declos', 'Sexiness', 300);
    const busy = file('a/Mac Declos - Sexiness.flac', { username: 'busy' });
    const idle = file('b/Mac Declos - Sexiness.flac', { username: 'idle', hasFreeUploadSlot: false });
    const idleMp3 = file('c/Mac Declos - Sexiness.mp3', { username: 'other', bitRate: 320 });
    const downloadsWith = (user) => (user === 'busy' ? 4 : 0);
    expect(certainMatches([busy, idle, idleMp3], t, downloadsWith)).toEqual([idle, busy, idleMp3]);
    // Only one FLAC: taken even from a busy user
    expect(certainMatches([busy, idleMp3], t, downloadsWith)[0]).toBe(busy);
  });
});
