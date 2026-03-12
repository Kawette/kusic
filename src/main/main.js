const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');
const SpotifyService = require('../services/spotify');
const SoundCloudService = require('../services/soundcloud');
const { SlskdManager } = require('../services/slskd');

const store = new Store({
  defaults: {
    playlists: [],
    tracks: [],
    spotify: {
      clientId: '',
      clientSecret: ''
    },
    soulseek: {
      username: '',
      password: '',
      libraryPath: ''
    }
  }
});

// slskd manager instance
let slskdManager = null;

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

app.whenReady().then(async () => {
  // Initialize slskd manager
  slskdManager = new SlskdManager();
  
  createWindow();
  
  // Auto-start slskd if configured
  const soulseekConfig = store.get('soulseek');
  if (soulseekConfig.username && soulseekConfig.password && soulseekConfig.libraryPath) {
    try {
      if (slskdManager.isBinaryInstalled()) {
        await slskdManager.start(soulseekConfig);
        console.log('[Kusic] slskd started successfully');
      }
    } catch (err) {
      console.error('[Kusic] Failed to auto-start slskd:', err.message);
    }
  }
});

app.on('window-all-closed', () => {
  // Stop slskd on app close
  if (slskdManager) {
    slskdManager.stop();
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── IPC Handlers ──────────────────────────────────────────────

// Settings
ipcMain.handle('get-settings', () => {
  return {
    spotify: store.get('spotify'),
    soulseek: store.get('soulseek')
  };
});

ipcMain.handle('save-settings', (_, settings) => {
  if (settings.spotify) store.set('spotify', settings.spotify);
  if (settings.soulseek) store.set('soulseek', settings.soulseek);
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

// ─── Slskd Handlers ────────────────────────────────────────────

// Browse for library folder
ipcMain.handle('browse-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Choisir le dossier de la bibliothèque'
  });
  
  if (result.canceled) return null;
  return result.filePaths[0];
});

// Check platform support
ipcMain.handle('slskd-check-platform', () => {
  if (!slskdManager) return { supported: false, platform: process.platform };
  return {
    supported: slskdManager.isPlatformSupported(),
    platform: process.platform,
    arch: process.arch
  };
});

// Get slskd version info
ipcMain.handle('slskd-get-version', () => {
  if (!slskdManager) return null;
  return {
    version: slskdManager.getVersion(),
    installed: slskdManager.isBinaryInstalled()
  };
});

// Check if slskd binary is installed
ipcMain.handle('slskd-check-binary', () => {
  return slskdManager ? slskdManager.isBinaryInstalled() : false;
});

// Download slskd binary
ipcMain.handle('slskd-download-binary', async (event) => {
  if (!slskdManager) throw new Error('Manager not initialized');
  
  return await slskdManager.downloadBinary((progress) => {
    mainWindow.webContents.send('slskd-download-progress', progress);
  });
});

// Start slskd
ipcMain.handle('slskd-start', async () => {
  if (!slskdManager) throw new Error('Manager not initialized');
  
  const config = store.get('soulseek');
  if (!config.username || !config.password) {
    throw new Error('Configurez vos identifiants Soulseek dans les paramètres');
  }
  if (!config.libraryPath) {
    throw new Error('Configurez le dossier de votre bibliothèque dans les paramètres');
  }
  
  await slskdManager.start(config);
  return true;
});

// Stop slskd
ipcMain.handle('slskd-stop', () => {
  if (slskdManager) slskdManager.stop();
  return true;
});

// Get slskd status
ipcMain.handle('slskd-status', async () => {
  if (!slskdManager) return { running: false, connected: false };
  return await slskdManager.getStatus();
});

// Search on Soulseek
ipcMain.handle('slskd-search', async (_, query) => {
  if (!slskdManager || !slskdManager.isRunning) {
    throw new Error('slskd n\'est pas démarré');
  }
  
  const api = slskdManager.getAPI();
  const results = await api.searchAndWait(query, 6000);
  return results;
});

// Get search results (for polling)
ipcMain.handle('slskd-get-search-results', async (_, searchId) => {
  if (!slskdManager || !slskdManager.isRunning) {
    throw new Error('slskd n\'est pas démarré');
  }
  
  const api = slskdManager.getAPI();
  const results = await api.getSearchResults(searchId);
  return api._flattenSearchResults(results);
});

// Download a file
ipcMain.handle('slskd-download', async (_, { username, filename }) => {
  if (!slskdManager || !slskdManager.isRunning) {
    throw new Error('slskd n\'est pas démarré');
  }
  
  const api = slskdManager.getAPI();
  await api.download(username, [{ filename }]);
  return true;
});

// Get all downloads
ipcMain.handle('slskd-get-downloads', async () => {
  if (!slskdManager || !slskdManager.isRunning) {
    return [];
  }
  
  const api = slskdManager.getAPI();
  return await api.getDownloads();
});

// Get uploads (what we're sharing)
ipcMain.handle('slskd-get-uploads', async () => {
  if (!slskdManager || !slskdManager.isRunning) {
    return [];
  }
  
  const api = slskdManager.getAPI();
  return await api.getUploads();
});

// Rescan shared library
ipcMain.handle('slskd-rescan-shares', async () => {
  if (!slskdManager || !slskdManager.isRunning) {
    throw new Error('slskd n\'est pas démarré');
  }
  
  const api = slskdManager.getAPI();
  await api.rescanShares();
  return true;
});

// Get shares info
ipcMain.handle('slskd-get-shares', async () => {
  if (!slskdManager || !slskdManager.isRunning) {
    return null;
  }
  
  const api = slskdManager.getAPI();
  return await api.getShares();
});

