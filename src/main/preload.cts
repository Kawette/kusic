// ─── Kusic Preload Script ───────────────────────────────────
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

/** Subscribe to a main-process event; returns the unsubscribe function. */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_: IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("kusic", {
  // Settings
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings: unknown) => ipcRenderer.invoke("save-settings", settings),
  testSpotify: (clientId: string, clientSecret: string) =>
    ipcRenderer.invoke("test-spotify", clientId, clientSecret),

  // Playlists
  getPlaylists: () => ipcRenderer.invoke("get-playlists"),
  addPlaylist: (url: string) => ipcRenderer.invoke("add-playlist", url),
  removePlaylist: (id: string) => ipcRenderer.invoke("remove-playlist", id),
  refreshLibrary: () => ipcRenderer.invoke("refresh-library"),
  exportPlaylist: (id: string) => ipcRenderer.invoke("export-playlist", id),

  // Tracks
  getTracks: (filters?: unknown) => ipcRenderer.invoke("get-tracks", filters),
  getStats: () => ipcRenderer.invoke("get-stats"),
  linkUnknownToTrack: (fileTrackId: string, targetTrackId: string) =>
    ipcRenderer.invoke("link-unknown-to-track", fileTrackId, targetTrackId),
  deleteLocalFile: (trackId: string) => ipcRenderer.invoke("delete-local-file", trackId),
  onLibraryChanged: (callback: () => void) => subscribe("library-changed", callback),

  // Conflicts
  getConflicts: () => ipcRenderer.invoke("get-conflicts"),
  resolveConflict: (id: string, choice: string) =>
    ipcRenderer.invoke("resolve-conflict", id, choice),

  // Search cache
  searchCache: {
    get: (query: string) => ipcRenderer.invoke("search-cache-get", query),
    set: (query: string, results: unknown, stats: unknown) =>
      ipcRenderer.invoke("search-cache-set", query, results, stats),
    summary: () => ipcRenderer.invoke("search-cache-summary"),
  },

  // Utils
  openExternal: (url: string) => ipcRenderer.invoke("open-external", url),
  browseFolder: () => ipcRenderer.invoke("browse-folder"),
  openLibraryFolder: () => ipcRenderer.invoke("open-library-folder"),
  showInFolder: (filePath: string) => ipcRenderer.invoke("show-in-folder", filePath),

  // Slskd
  slskd: {
    checkPlatform: () => ipcRenderer.invoke("slskd-check-platform"),
    getVersion: () => ipcRenderer.invoke("slskd-get-version"),
    downloadBinary: () => ipcRenderer.invoke("slskd-download-binary"),
    onDownloadProgress: (callback: (progress: number) => void) =>
      subscribe("slskd-download-progress", callback),
    onStateChanged: (callback: () => void) => subscribe("slskd-state-changed", callback),
    start: () => ipcRenderer.invoke("slskd-start"),
    stop: () => ipcRenderer.invoke("slskd-stop"),
    getStatus: () => ipcRenderer.invoke("slskd-status"),
    search: (query: string) => ipcRenderer.invoke("slskd-search", query),
    cancelSearch: (searchId: string) => ipcRenderer.invoke("slskd-cancel-search", searchId),
    getSearchResults: (searchId: string, includeFiles = true) =>
      ipcRenderer.invoke("slskd-get-search-results", { searchId, includeFiles }),
    download: (username: string, filename: string, size: number, trackId?: string) =>
      ipcRenderer.invoke("slskd-download", { username, filename, size, trackId }),
    getDownloads: () => ipcRenderer.invoke("slskd-get-downloads"),
    onDownloadsUpdated: (callback: (transfers: unknown[]) => void) =>
      subscribe("downloads-updated", callback),
    onDownloadEvent: (callback: (event: unknown) => void) => subscribe("download-event", callback),
    cancelDownload: (username: string, id: string, filename: string, remove = false) =>
      ipcRenderer.invoke("slskd-cancel-download", { username, id, filename, remove }),
    retryDownload: (username: string, id: string, filename: string, size: number) =>
      ipcRenderer.invoke("slskd-retry-download", { username, id, filename, size }),
    clearDownloads: (kind: "succeeded" | "failed") =>
      ipcRenderer.invoke("slskd-clear-downloads", kind),
  },
});
