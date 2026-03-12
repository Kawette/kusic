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
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  browseFolder: () => ipcRenderer.invoke('browse-folder'),

  // ─── Soulseek / slskd ─────────────────────────────────────────
  slskd: {
    checkPlatform: () => ipcRenderer.invoke('slskd-check-platform'),
    getVersion: () => ipcRenderer.invoke('slskd-get-version'),
    checkBinary: () => ipcRenderer.invoke('slskd-check-binary'),
    downloadBinary: () => ipcRenderer.invoke('slskd-download-binary'),
    onDownloadProgress: (callback) => {
      ipcRenderer.on('slskd-download-progress', (_, progress) => callback(progress));
    },
    start: () => ipcRenderer.invoke('slskd-start'),
    stop: () => ipcRenderer.invoke('slskd-stop'),
    getStatus: () => ipcRenderer.invoke('slskd-status'),
    search: (query) => ipcRenderer.invoke('slskd-search', query),
    getSearchResults: (searchId) => ipcRenderer.invoke('slskd-get-search-results', searchId),
    download: (username, filename) => ipcRenderer.invoke('slskd-download', { username, filename }),
    getDownloads: () => ipcRenderer.invoke('slskd-get-downloads'),
    getUploads: () => ipcRenderer.invoke('slskd-get-uploads'),
    rescanShares: () => ipcRenderer.invoke('slskd-rescan-shares'),
    getShares: () => ipcRenderer.invoke('slskd-get-shares')
  }
});
