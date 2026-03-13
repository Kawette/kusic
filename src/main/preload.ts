// ─── Kusic Preload Script ───────────────────────────────────
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("kusic", {
  // Settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings: unknown) =>
    ipcRenderer.invoke("save-settings", settings),

  // Playlists
  getPlaylists: () => ipcRenderer.invoke("get-playlists"),
  addPlaylist: (url: string) => ipcRenderer.invoke("add-playlist", url),
  removePlaylist: (id: string) => ipcRenderer.invoke("remove-playlist", id),
  refreshPlaylists: () => ipcRenderer.invoke("refresh-playlists"),

  // Tracks
  getTracks: (filters?: unknown) => ipcRenderer.invoke("get-tracks", filters),
  getStats: () => ipcRenderer.invoke("get-stats"),

  // Utils
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  browseFolder: () => ipcRenderer.invoke("browse-folder"),

  // Slskd
  slskd: {
    checkPlatform: () => ipcRenderer.invoke("slskd-check-platform"),
    getVersion: () => ipcRenderer.invoke("slskd-get-version"),
    checkBinary: () => ipcRenderer.invoke("slskd-check-binary"),
    downloadBinary: () => ipcRenderer.invoke("slskd-download-binary"),
    onDownloadProgress: (callback: (progress: number) => void) => {
      ipcRenderer.on("slskd-download-progress", (_, progress) =>
        callback(progress),
      );
    },
    start: () => ipcRenderer.invoke("slskd-start"),
    stop: () => ipcRenderer.invoke("slskd-stop"),
    getStatus: () => ipcRenderer.invoke("slskd-status"),
    search: (query: string) => ipcRenderer.invoke("slskd-search", query),
    getSearchResults: (searchId: string, includeFiles = true) =>
      ipcRenderer.invoke("slskd-get-search-results", {
        searchId,
        includeFiles,
      }),
    download: (username: string, filename: string, size: number) =>
      ipcRenderer.invoke("slskd-download", { username, filename, size }),
    getDownloads: () => ipcRenderer.invoke("slskd-get-downloads"),
    getUploads: () => ipcRenderer.invoke("slskd-get-uploads"),
    rescanShares: () => ipcRenderer.invoke("slskd-rescan-shares"),
    getShares: () => ipcRenderer.invoke("slskd-get-shares"),
  },
});
