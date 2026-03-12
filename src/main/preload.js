const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kusic', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // Playlists
  getPlaylists: () => ipcRenderer.invoke('get-playlists'),
  addPlaylist: (url) => ipcRenderer.invoke('add-playlist', url),
  removePlaylist: (id) => ipcRenderer.invoke('remove-playlist', id),
  refreshPlaylists: () => ipcRenderer.invoke('refresh-playlists'),

  // Tracks
  getTracks: (filters) => ipcRenderer.invoke('get-tracks', filters),
  getStats: () => ipcRenderer.invoke('get-stats'),

  // Utils
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
