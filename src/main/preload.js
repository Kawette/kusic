const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kusic', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  selectLibraryFolder: () => ipcRenderer.invoke('select-library-folder'),

  // Playlists
  getPlaylists: () => ipcRenderer.invoke('get-playlists'),
  addPlaylist: (url) => ipcRenderer.invoke('add-playlist', url),
  removePlaylist: (id) => ipcRenderer.invoke('remove-playlist', id),
  refreshPlaylists: () => ipcRenderer.invoke('refresh-playlists'),

  // Tracks
  getTracks: (filters) => ipcRenderer.invoke('get-tracks', filters),
  getStats: () => ipcRenderer.invoke('get-stats'),

  // Downloads
  downloadTrack: (track) => ipcRenderer.invoke('download-track', track),
  downloadTracks: (tracks) => ipcRenderer.invoke('download-tracks', tracks),
  checkDownloadReady: () => ipcRenderer.invoke('download-check-ready'),
  getDownloadStatuses: () => ipcRenderer.invoke('get-download-statuses'),
  openLibraryFolder: () => ipcRenderer.invoke('open-library-folder'),

  // Download events (main → renderer)
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (_, data) => cb(data)),
  onDownloadTrackComplete: (cb) => ipcRenderer.on('download-track-complete', (_, data) => cb(data)),
  onDownloadTrackError: (cb) => ipcRenderer.on('download-track-error', (_, data) => cb(data)),
  onDownloadStatus: (cb) => ipcRenderer.on('download-status', (_, data) => cb(data)),

  // Utils
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
