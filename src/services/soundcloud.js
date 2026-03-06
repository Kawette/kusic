const axios = require('axios');

class SoundCloudService {
  constructor() {
    this.clientId = null; // Will be resolved dynamically
  }

  /**
   * Resolves a SoundCloud client_id by fetching the main page
   * and extracting it from one of the script bundles.
   */
  async resolveClientId() {
    if (this.clientId) return this.clientId;

    try {
      // Fetch main page
      const pageRes = await axios.get('https://soundcloud.com/', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });

      // Extract script URLs
      const scriptUrls = pageRes.data.match(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^\s"]+\.js/g);
      if (!scriptUrls || scriptUrls.length === 0) {
        throw new Error('Impossible de trouver les scripts SoundCloud');
      }

      // Check last few scripts (client_id is usually in one of the last)
      for (let i = scriptUrls.length - 1; i >= Math.max(0, scriptUrls.length - 5); i--) {
        const scriptRes = await axios.get(scriptUrls[i], {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });

        const match = scriptRes.data.match(/client_id\s*:\s*"([a-zA-Z0-9]+)"/);
        if (match) {
          this.clientId = match[1];
          return this.clientId;
        }
      }

      throw new Error('Impossible de résoudre le client_id SoundCloud');
    } catch (err) {
      throw new Error(`Erreur SoundCloud: ${err.message}`);
    }
  }

  /**
   * Resolves a SoundCloud URL to get the resource data
   */
  async resolve(url) {
    const clientId = await this.resolveClientId();

    const response = await axios.get('https://api-v2.soundcloud.com/resolve', {
      params: { url, client_id: clientId },
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    return response.data;
  }

  async getPlaylist(url) {
    const data = await this.resolve(url);

    // SoundCloud can return a playlist (set) or a user's likes, etc.
    if (data.kind !== 'playlist') {
      throw new Error('L\'URL fournie n\'est pas une playlist SoundCloud');
    }

    const clientId = await this.resolveClientId();

    // Some tracks in playlist may only have partial data
    // Fetch full track details for those that need it
    const tracks = [];
    const incompleteIds = [];

    for (const track of data.tracks) {
      if (track.title) {
        tracks.push(this.formatTrack(track));
      } else {
        incompleteIds.push(track.id);
      }
    }

    // Fetch incomplete tracks in batches of 50
    for (let i = 0; i < incompleteIds.length; i += 50) {
      const batch = incompleteIds.slice(i, i + 50);
      try {
        const res = await axios.get('https://api-v2.soundcloud.com/tracks', {
          params: {
            ids: batch.join(','),
            client_id: clientId
          },
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });

        for (const track of res.data) {
          tracks.push(this.formatTrack(track));
        }
      } catch (err) {
        console.error(`Failed to fetch batch of SoundCloud tracks: ${err.message}`);
      }
    }

    return {
      id: `soundcloud_${data.id}`,
      source: 'soundcloud',
      name: data.title,
      description: data.description || '',
      url: data.permalink_url,
      artwork: data.artwork_url ? data.artwork_url.replace('-large', '-t500x500') : '',
      totalTracks: data.track_count,
      tracks: tracks,
      addedAt: Date.now()
    };
  }

  formatTrack(track) {
    let artwork = '';
    if (track.artwork_url) {
      artwork = track.artwork_url.replace('-large', '-t200x200');
    } else if (track.user?.avatar_url) {
      artwork = track.user.avatar_url;
    }

    return {
      id: `soundcloud_${track.id}`,
      source: 'soundcloud',
      title: track.title || 'Sans titre',
      artist: track.user?.username || 'Inconnu',
      album: '',
      artwork: artwork,
      duration: track.duration || 0, // Already in ms
      soundcloudUrl: track.permalink_url,
      streamUrl: track.stream_url || null,
      addedAt: Date.now()
    };
  }
}

module.exports = SoundCloudService;
