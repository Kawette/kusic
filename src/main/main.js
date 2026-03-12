const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Store = require('electron-store');
const SpotifyService = require('../services/spotify');
const SoundCloudService = require('../services/soundcloud');

const store = new Store({
  defaults: {
    playlists: [],
    tracks: [],
    spotify: {
      clientId: '',
      clientSecret: ''
    }
  }
});

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0f',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0a0a0f',
      symbolColor: '#ffffff',
      height: 38
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── IPC Handlers ──────────────────────────────────────────────

// Settings
ipcMain.handle('get-settings', () => {
  return {
    spotify: store.get('spotify')
  };
});

ipcMain.handle('save-settings', (_, settings) => {
  if (settings.spotify) store.set('spotify', settings.spotify);
  return true;
});

// Playlists
ipcMain.handle('get-playlists', () => {
  return store.get('playlists');
});

ipcMain.handle('add-playlist', async (_, url) => {
  try {
    let playlistData;

    if (url.includes('spotify.com')) {
      const spotifyConfig = store.get('spotify');
      if (!spotifyConfig.clientId || !spotifyConfig.clientSecret) {
        throw new Error('Configurez vos identifiants Spotify dans les paramètres');
      }
      const spotify = new SpotifyService(spotifyConfig.clientId, spotifyConfig.clientSecret);
      playlistData = await spotify.getPlaylist(url);
    } else if (url.includes('soundcloud.com')) {
      const sc = new SoundCloudService();
      playlistData = await sc.getPlaylist(url);
    } else {
      throw new Error('URL non supportée. Utilisez une URL Spotify ou SoundCloud.');
    }

    const playlists = store.get('playlists');
    
    // Check for duplicate
    const exists = playlists.find(p => p.url === playlistData.url);
    if (exists) {
      throw new Error('Cette playlist est déjà dans votre bibliothèque');
    }

    playlists.push(playlistData);
    store.set('playlists', playlists);

    // Merge tracks into unified list
    const allTracks = store.get('tracks');
    for (const track of playlistData.tracks) {
      const duplicate = allTracks.find(t => 
        t.title.toLowerCase() === track.title.toLowerCase() && 
        t.artist.toLowerCase() === track.artist.toLowerCase()
      );
      if (!duplicate) {
        allTracks.push(track);
      }
    }
    store.set('tracks', allTracks);

    return playlistData;
  } catch (err) {
    throw new Error(err.message);
  }
});

ipcMain.handle('refresh-playlists', async () => {
  const playlists = store.get('playlists');
  const refreshed = [];

  for (const pl of playlists) {
    try {
      let freshData;
      if (pl.source === 'spotify') {
        const spotifyConfig = store.get('spotify');
        if (!spotifyConfig.clientId || !spotifyConfig.clientSecret) continue;
        const spotify = new SpotifyService(spotifyConfig.clientId, spotifyConfig.clientSecret);
        freshData = await spotify.getPlaylist(pl.url);
      } else if (pl.source === 'soundcloud') {
        const sc = new SoundCloudService();
        freshData = await sc.getPlaylist(pl.url);
      } else {
        refreshed.push(pl);
        continue;
      }
      freshData.addedAt = pl.addedAt; // Keep original add date
      refreshed.push(freshData);
    } catch {
      refreshed.push(pl); // Keep old data on error
    }
  }

  store.set('playlists', refreshed);

  // Rebuild unified track list
  const allTracks = [];
  const seen = new Set();
  for (const pl of refreshed) {
    for (const track of pl.tracks) {
      const key = `${track.title.toLowerCase()}|${track.artist.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        allTracks.push(track);
      }
    }
  }
  store.set('tracks', allTracks);

  return { playlists: refreshed, totalTracks: allTracks.length };
});

ipcMain.handle('remove-playlist', (_, playlistId) => {
  let playlists = store.get('playlists');
  const playlist = playlists.find(p => p.id === playlistId);
  
  playlists = playlists.filter(p => p.id !== playlistId);
  store.set('playlists', playlists);

  // Remove tracks only from this playlist (unless shared with another)
  if (playlist) {
    const remainingTrackIds = new Set();
    playlists.forEach(p => p.tracks.forEach(t => remainingTrackIds.add(t.id)));
    
    let tracks = store.get('tracks');
    tracks = tracks.filter(t => remainingTrackIds.has(t.id) || !playlist.tracks.find(pt => pt.id === t.id));
    store.set('tracks', tracks);
  }

  return playlists;
});

// Tracks
ipcMain.handle('get-tracks', (_, { search, source, sortBy } = {}) => {
  let tracks = [...store.get('tracks')];

  if (search) {
    const q = search.toLowerCase();
    tracks = tracks.filter(t =>
      t.title.toLowerCase().includes(q) ||
      t.artist.toLowerCase().includes(q) ||
      (t.album && t.album.toLowerCase().includes(q))
    );
  }

  if (source && source !== 'all') {
    tracks = tracks.filter(t => t.source === source);
  }

  if (sortBy === 'title') {
    tracks.sort((a, b) => a.title.localeCompare(b.title));
  } else if (sortBy === 'artist') {
    tracks.sort((a, b) => a.artist.localeCompare(b.artist));
  } else if (sortBy === 'duration') {
    tracks.sort((a, b) => a.duration - b.duration);
  } else {
    // Default: most recent first
    tracks.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }

  return tracks;
});

ipcMain.handle('get-stats', () => {
  const playlists = store.get('playlists');
  const tracks = store.get('tracks');
  return {
    totalPlaylists: playlists.length,
    totalTracks: tracks.length,
    spotifyTracks: tracks.filter(t => t.source === 'spotify').length,
    soundcloudTracks: tracks.filter(t => t.source === 'soundcloud').length
  };
});

ipcMain.handle('open-external', (_, url) => {
  const { shell } = require('electron');
  shell.openExternal(url);
});

