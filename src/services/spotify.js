const axios = require('axios');

class SpotifyService {
  constructor(clientId, clientSecret) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = null;
    this.tokenExpiry = 0;
  }

  async authenticate() {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return;
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const response = await axios.post('https://accounts.spotify.com/api/token', 
      'grant_type=client_credentials', {
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    this.accessToken = response.data.access_token;
    this.tokenExpiry = Date.now() + (response.data.expires_in * 1000) - 60000; // 1 min buffer
  }

  extractPlaylistId(url) {
    // Handles:
    // https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
    // https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc123
    // spotify:playlist:37i9dQZF1DXcBWIGoYBM5M
    const match = url.match(/playlist[/:]([a-zA-Z0-9]+)/);
    if (!match) throw new Error('URL de playlist Spotify invalide');
    return match[1];
  }

  async getPlaylist(url) {
    await this.authenticate();

    const playlistId = this.extractPlaylistId(url);

    // Get playlist metadata
    const playlistRes = await axios.get(
      `https://api.spotify.com/v1/playlists/${playlistId}`, {
        headers: { 'Authorization': `Bearer ${this.accessToken}` },
        params: { fields: 'id,name,description,images,external_urls,tracks.total' }
      }
    );

    const playlist = playlistRes.data;

    // Get all tracks (handles pagination)
    const tracks = await this.getAllPlaylistTracks(playlistId);

    return {
      id: `spotify_${playlist.id}`,
      source: 'spotify',
      name: playlist.name,
      description: playlist.description || '',
      url: playlist.external_urls.spotify,
      artwork: playlist.images?.[0]?.url || '',
      totalTracks: playlist.tracks.total,
      tracks: tracks,
      addedAt: Date.now()
    };
  }

  async getAllPlaylistTracks(playlistId) {
    const tracks = [];
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
      const response = await axios.get(
        `https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
          headers: { 'Authorization': `Bearer ${this.accessToken}` },
          params: {
            offset,
            limit,
            fields: 'items(track(id,name,artists,album,duration_ms,external_urls,preview_url)),next'
          }
        }
      );

      for (const item of response.data.items) {
        if (!item.track) continue; // Skip null tracks (deleted/unavailable)

        const track = item.track;
        tracks.push({
          id: `spotify_${track.id}`,
          source: 'spotify',
          title: track.name,
          artist: track.artists.map(a => a.name).join(', '),
          album: track.album?.name || '',
          artwork: track.album?.images?.[1]?.url || track.album?.images?.[0]?.url || '',
          duration: track.duration_ms,
          spotifyUrl: track.external_urls.spotify,
          previewUrl: track.preview_url,
          addedAt: Date.now()
        });
      }

      hasMore = !!response.data.next;
      offset += limit;
    }

    return tracks;
  }
}

module.exports = SpotifyService;
