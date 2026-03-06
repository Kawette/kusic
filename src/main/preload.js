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

  // Tracks
  getTracks: (filters) => ipcRenderer.invoke('get-tracks', filters),
  getStats: () => ipcRenderer.invoke('get-stats'),

  // Utils
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
