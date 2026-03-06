const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');
const SpotifyService = require('../services/spotify');
const SoundCloudService = require('../services/soundcloud');
const DownloadService = require('../services/download');

const store = new Store({
  defaults: {
    playlists: [],
    tracks: [],
    libraryPath: path.join(app.getPath('music'), 'Kusic'),
    spotify: {
      clientId: '',
      clientSecret: ''
    }
  }
});

let mainWindow;
let downloadService;

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
    libraryPath: store.get('libraryPath'),
    spotify: store.get('spotify')
  };
});

ipcMain.handle('save-settings', (_, settings) => {
  if (settings.libraryPath) store.set('libraryPath', settings.libraryPath);
  if (settings.spotify) store.set('spotify', settings.spotify);
  return true;
});

ipcMain.handle('select-library-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Choisir le dossier de bibliothèque'
  });
  if (!result.canceled && result.filePaths.length > 0) {
    store.set('libraryPath', result.filePaths[0]);
    return result.filePaths[0];
  }
  return null;
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

  // Merge local (orphan) tracks from library scan
  if (downloadService && downloadService._cacheReady) {
    const localTracks = downloadService.localTracks || [];
    // Avoid duplicates by checking IDs
    const existingIds = new Set(tracks.map(t => t.id));
    for (const lt of localTracks) {
      if (!existingIds.has(lt.id)) {
        tracks.push(lt);
      }
    }
  }

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
  const localCount = (downloadService && downloadService._cacheReady)
    ? (downloadService.localTracks || []).length
    : 0;
  return {
    totalPlaylists: playlists.length,
    totalTracks: tracks.length + localCount,
    spotifyTracks: tracks.filter(t => t.source === 'spotify').length,
    soundcloudTracks: tracks.filter(t => t.source === 'soundcloud').length,
    localTracks: localCount
  };
});

ipcMain.handle('open-external', (_, url) => {
  const { shell } = require('electron');
  shell.openExternal(url);
});

// ─── Download ─────────────────────────────────────────────────

function getDownloadService() {
  const libPath = store.get('libraryPath');
  const dataDir = path.join(app.getPath('userData'), 'kusic-data');
  if (!downloadService) {
    downloadService = new DownloadService(libPath, dataDir);
    
    // Forward events to renderer
    downloadService.on('progress', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-progress', data);
      }
    });
    downloadService.on('track-complete', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-track-complete', data);
      }
    });
    downloadService.on('track-error', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-track-error', data);
      }
    });
    downloadService.on('status', (data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download-status', data);
      }
    });
  } else {
    downloadService.setLibraryPath(libPath);
  }
  return downloadService;
}

ipcMain.handle('download-track', async (_, track) => {
  const svc = getDownloadService();
  return await svc.downloadTrack(track);
});

ipcMain.handle('download-tracks', async (_, tracks) => {
  const svc = getDownloadService();
  return await svc.downloadTracks(tracks);
});

ipcMain.handle('download-check-ready', async () => {
  try {
    const svc = getDownloadService();
    await svc.ensureReady();
    const version = await svc.getVersion();
    return { ready: true, version };
  } catch (err) {
    return { ready: false, error: err.message };
  }
});

ipcMain.handle('open-library-folder', () => {
  const { shell } = require('electron');
  const libPath = store.get('libraryPath');
  shell.openPath(libPath);
});

ipcMain.handle('get-download-statuses', async () => {
  const svc = getDownloadService();
  // Always re-scan library to rebuild in-memory cache from FLAC metadata
  const tracks = store.get('tracks', []);
  await svc.scanLibrary(tracks);
  return svc.getDownloadStatuses();
});


