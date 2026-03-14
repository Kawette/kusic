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
  refreshLibrary: () => ipcRenderer.invoke("refresh-library"),

  // Tracks
  getTracks: (filters?: unknown) => ipcRenderer.invoke("get-tracks", filters),
  getStats: () => ipcRenderer.invoke("get-stats"),
  tagDownloadedFile: (filename: string, trackId: string) =>
    ipcRenderer.invoke("tag-downloaded-file", filename, trackId),

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
    cancelSearch: (searchId: string) =>
      ipcRenderer.invoke("slskd-cancel-search", searchId),
    getSearchResults: (searchId: string, includeFiles = true) =>
      ipcRenderer.invoke("slskd-get-search-results", {
        searchId,
        includeFiles,
      }),
    download: (username: string, filename: string, size: number) =>
      ipcRenderer.invoke("slskd-download", { username, filename, size }),
    getDownloads: () => ipcRenderer.invoke("slskd-get-downloads"),
    cancelDownload: (username: string, id: string, remove = false) =>
      ipcRenderer.invoke("slskd-cancel-download", { username, id, remove }),
    retryDownload: (
      username: string,
      id: string,
      filename: string,
      size: number,
    ) =>
      ipcRenderer.invoke("slskd-retry-download", {
        username,
        id,
        filename,
        size,
      }),
    clearCompletedDownloads: () =>
      ipcRenderer.invoke("slskd-clear-completed-downloads"),
    getUploads: () => ipcRenderer.invoke("slskd-get-uploads"),
    rescanShares: () => ipcRenderer.invoke("slskd-rescan-shares"),
    getShares: () => ipcRenderer.invoke("slskd-get-shares"),
  },
});
