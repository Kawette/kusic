// ─── Kusic Main Process ─────────────────────────────────────
import { app, BrowserWindow, ipcMain, dialog, protocol, shell } from "electron";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { store } from "./store.js";
import { Library } from "./library/library.js";
import { coverSchemePrivileges, handleCoverProtocol } from "./library/covers.js";
import { audioSchemePrivileges, handleAudioProtocol } from "./library/audio.js";
import { isInside, sanitizeFilename } from "./library/naming.js";
import {
  DownloadTracker,
  flattenTransfers,
  isSucceeded,
  parseUtc,
  type RawDownloads,
} from "./downloads.js";
import {
  clearSearchCache,
  getCachedSearch,
  getCacheSummary,
  pruneSearchCache,
  setCachedSearch,
  type SearchStats,
} from "./search-cache.js";
import { SpotifyService } from "../services/spotify.js";
import { SlskdManager } from "../services/slskd/index.js";
import type {
  AppSettings,
  ConflictChoice,
  SlskdSearchResult,
  TrackFilters,
} from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
/** Last folder picked in the folder dialog: the only accepted new library path */
let browsedLibraryPath: string | null = null;

function send(channel: string, payload?: unknown): void {
  // The window may already be gone while quitting
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

const library = new Library(() => send("library-changed"));
const slskd = new SlskdManager();
const downloads = new DownloadTracker(
  () => slskd.api,
  library,
  () => slskd.downloadsDir,
  (transfers) => send("downloads-updated", transfers),
  (event) => send("download-event", event),
  () => slskd.startedAt,
);

slskd.onBinaryProgress = (progress) => send("slskd-download-progress", progress);
slskd.onStateChange = () => {
  if (slskd.isRunning) downloads.start();
  else downloads.stop();
  send("slskd-state-changed");
};

// ─── App lifecycle ─────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: "#0a0a0f",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0a0a0f",
      symbolColor: "#ffffff",
      height: 38,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // The UI is a single local page: no navigation, no pop-ups
  mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  // In dev the UI is served from the sources and reloads when they change
  const dev = process.argv.includes("--dev");
  const rendererDir = dev
    ? path.join(__dirname, "../../src/renderer")
    : path.join(__dirname, "../renderer");
  mainWindow.loadFile(path.join(rendererDir, "index.html")).catch((err) => {
    console.error("[Kusic] Failed to load UI:", err);
  });

  if (dev) {
    mainWindow.webContents.openDevTools();
    watchRenderer(rendererDir);
  }
}

/** Dev only: reload the window when a renderer file changes. */
function watchRenderer(dir: string): void {
  let timer: NodeJS.Timeout | undefined;
  fs.watch(dir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache();
    }, 200);
  });
}

async function autoStartSlskd(): Promise<void> {
  const config = store.get("soulseek");
  if (!config.username || !config.password || !config.libraryPath) return;
  if (!slskd.isBinaryInstalled()) return;
  try {
    await slskd.start(config, store.get("slskdApiKey"));
    console.log("[Kusic] slskd started successfully");
  } catch (err) {
    console.error("[Kusic] Failed to auto-start slskd:", (err as Error).message);
  }
}

// Must run before app ready (single call for all custom schemes)
protocol.registerSchemesAsPrivileged([coverSchemePrivileges, audioSchemePrivileges]);

if (!app.requestSingleInstanceLock()) {
  // Kusic is already running: the other instance gets focused
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });

  app.whenReady().then(() => {
    handleCoverProtocol();
    handleAudioProtocol(() => store.get("soulseek").libraryPath);
    pruneSearchCache();
    createWindow();
    // A slskd left running by a crashed session must not keep sharing the library
    slskd.killOrphan().catch(() => {});
    // Pick up files changed outside Kusic
    library.rescan().catch((err) => console.error("[Kusic] Initial scan failed:", err));
    autoStartSlskd();
  });
}

app.on("window-all-closed", () => app.quit());

// Never leave slskd running (and sharing the library) after Kusic exits
let quitting = false;
app.on("will-quit", (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  try {
    downloads.stop();
  } finally {
    slskd.stop().finally(() => app.quit());
  }
});

// ─── Settings ──────────────────────────────────────────────────

/** A string from the renderer; trimmed unless it is a secret. */
function text(value: unknown, field: string, { trim = true } = {}): string {
  if (typeof value !== "string" || value.length > 1000) {
    throw new Error(`Valeur invalide pour ${field}`);
  }
  return trim ? value.trim() : value;
}

ipcMain.handle(
  "get-settings",
  (): AppSettings => ({
    spotify: store.get("spotify"),
    soulseek: store.get("soulseek"),
    autoDownload: store.get("autoDownload"),
  }),
);

ipcMain.handle("save-settings", async (_, settings: Partial<AppSettings>) => {
  // Validate everything before saving anything
  const spotify = settings.spotify && {
    clientId: text(settings.spotify.clientId, "Client ID"),
    clientSecret: text(settings.spotify.clientSecret, "Client Secret"),
  };
  const current = store.get("soulseek");
  const soulseek = settings.soulseek && {
    username: text(settings.soulseek.username, "nom d'utilisateur"),
    password: text(settings.soulseek.password, "mot de passe", { trim: false }),
    libraryPath: text(settings.soulseek.libraryPath, "dossier"),
  };
  // The library folder can only come from the folder picker
  if (
    soulseek &&
    soulseek.libraryPath !== current.libraryPath &&
    soulseek.libraryPath !== browsedLibraryPath
  ) {
    throw new Error("Choisissez le dossier de la bibliothèque avec le bouton Parcourir");
  }

  if (settings.autoDownload !== undefined) store.set("autoDownload", settings.autoDownload === true);
  if (spotify) store.set("spotify", spotify);
  if (soulseek) {
    store.set("soulseek", soulseek);
    if (soulseek.libraryPath !== current.libraryPath) await library.rescan();
  }
  return true;
});

ipcMain.handle("test-spotify", async (_, clientId: string, clientSecret: string) => {
  await new SpotifyService(text(clientId, "Client ID"), text(clientSecret, "Client Secret")).testCredentials();
  return true;
});

ipcMain.handle("browse-folder", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    title: "Choisir le dossier de la bibliothèque",
  });
  if (result.canceled) return null;
  browsedLibraryPath = result.filePaths[0];
  return browsedLibraryPath;
});

// ─── Library ───────────────────────────────────────────────────

ipcMain.handle("get-playlists", () => library.getPlaylists());
ipcMain.handle("add-playlist", (_, url: string) => library.addPlaylist(text(url, "URL")));
ipcMain.handle("remove-playlist", (_, id: string) => library.removePlaylist(id));
ipcMain.handle("refresh-library", () => library.refreshPlaylists());
ipcMain.handle("get-tracks", (_, filters?: TrackFilters) => library.getTracks(filters));
ipcMain.handle("get-stats", () => library.getStats());

ipcMain.handle("export-playlist", async (_, playlistId: string) => {
  const playlist = library.getPlaylists().find((p) => p.id === playlistId);
  if (!playlist || !mainWindow) return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Exporter la playlist",
    defaultPath: path.join(
      store.get("soulseek").libraryPath || app.getPath("music"),
      `${sanitizeFilename(playlist.name) || "playlist"}.m3u8`,
    ),
    filters: [{ name: "Playlist M3U (UTF-8)", extensions: ["m3u8", "m3u"] }],
  });
  if (result.canceled || !result.filePath) return null;
  return library.exportM3U(playlistId, result.filePath);
});

ipcMain.handle("link-unknown-to-track", (_, fileTrackId: string, targetTrackId: string) =>
  library.linkUnknown(fileTrackId, targetTrackId),
);
ipcMain.handle("delete-local-file", (_, trackId: string) => library.deleteLocalFile(trackId));

ipcMain.handle("get-conflicts", () => library.getConflicts());
ipcMain.handle("resolve-conflict", (_, id: string, choice: ConflictChoice) => {
  if (choice !== "keep-existing" && choice !== "replace") throw new Error("Choix invalide");
  return library.resolveConflict(id, choice);
});

// ─── Shell ─────────────────────────────────────────────────────

ipcMain.handle("open-external", async (_, url: string) => {
  if (typeof url !== "string" || new URL(url).protocol !== "https:") {
    throw new Error("Lien non autorisé");
  }
  await shell.openExternal(url);
});

ipcMain.handle("open-library-folder", async () => {
  const root = store.get("soulseek").libraryPath;
  if (root) await shell.openPath(root);
});

ipcMain.handle("show-in-folder", (_, filePath: string) => {
  const root = store.get("soulseek").libraryPath;
  if (root && typeof filePath === "string" && isInside(filePath, root)) {
    shell.showItemInFolder(filePath);
  }
});

// ─── Search cache ──────────────────────────────────────────────

ipcMain.handle("search-cache-get", (_, query: string) => getCachedSearch(query));
ipcMain.handle(
  "search-cache-set",
  (_, query: string, results: SlskdSearchResult[], stats: SearchStats) => {
    if (!Array.isArray(results)) throw new Error("Résultats invalides");
    // Only the expected fields: the entry also holds the cache file name
    setCachedSearch(text(query, "recherche"), results, {
      relevant: Number(stats?.relevant) || 0,
      best: String(stats?.best ?? "").slice(0, 10),
      certain: stats?.certain == null ? undefined : Number(stats.certain) || 0,
    });
  },
);
ipcMain.handle("search-cache-summary", () => getCacheSummary());
ipcMain.handle("search-cache-clear", () => clearSearchCache());

// ─── Slskd ─────────────────────────────────────────────────────

ipcMain.handle("slskd-check-platform", () => ({
  supported: slskd.isPlatformSupported(),
  platform: process.platform,
}));

ipcMain.handle("slskd-get-version", () => slskd.getVersionInfo());

ipcMain.handle("slskd-download-binary", () => slskd.downloadBinary());

ipcMain.handle("slskd-start", async () => {
  await slskd.start(store.get("soulseek"), store.get("slskdApiKey"));
  return true;
});

ipcMain.handle("slskd-stop", async () => {
  await slskd.stop();
  return true;
});

ipcMain.handle("slskd-status", () => slskd.getStatus());

ipcMain.handle("slskd-search", (_, query: string) => {
  console.log(`[Search] Starting search for: "${query}"`);
  return slskd.getAPI().search(text(query, "recherche"));
});

ipcMain.handle("slskd-cancel-search", async (_, searchId: string) => {
  await slskd.api?.cancelSearch(searchId);
});

ipcMain.handle(
  "slskd-get-search-results",
  (_, { searchId, includeFiles = true }: { searchId: string; includeFiles?: boolean }) =>
    slskd.getAPI().getSearchResults(searchId, includeFiles),
);

ipcMain.handle(
  "slskd-download",
  async (
    _,
    {
      username,
      filename,
      size,
      trackId,
    }: { username: string; filename: string; size: number; trackId?: string },
  ) => {
    await slskd.getAPI().download(username, [{ filename, size }]);
    if (trackId) downloads.register(username, filename, size, trackId);
    // The list with the new transfer reaches the UI before the call returns
    await downloads.refresh().catch(() => {});
    return true;
  },
);

ipcMain.handle("slskd-get-downloads", () => (slskd.api ? downloads.refresh() : []));

// What other users download from the shared library (display only)
const MAX_UPLOADS = 200;
ipcMain.handle("slskd-get-uploads", async () => {
  if (!slskd.api) return [];
  const uploads = flattenTransfers((await slskd.api.getUploads()) as RawDownloads[]);
  // Oldest first like the downloads, running ones (no end time) last
  const end = (t: { endedAt?: string }) => (t.endedAt ? parseUtc(t.endedAt) : Number.MAX_SAFE_INTEGER);
  uploads.sort((a, b) => end(a) - end(b));
  return uploads.slice(-MAX_UPLOADS).map(({ endedAt: _endedAt, ...t }) => t);
});

ipcMain.handle(
  "slskd-cancel-download",
  async (
    _,
    {
      username,
      id,
      filename,
      remove,
    }: { username: string; id: string; filename: string; remove: boolean },
  ) => {
    const listed = downloads.listed(id);
    if (remove && listed && downloads.isPlacing(listed)) {
      throw new Error("Fichier en cours de rangement dans la bibliothèque : réessayez dans un instant");
    }
    await slskd.getAPI().cancelDownload(username, id, remove);
    if (remove) downloads.forget(username, filename);
    await downloads.refresh();
    return true;
  },
);

ipcMain.handle(
  "slskd-retry-download",
  async (
    _,
    { username, id, filename, size }: { username: string; id: string; filename: string; size: number },
  ) => {
    const api = slskd.getAPI();
    // Retrying removes the failed transfer first: with an offline user, nothing would be left
    if ((await api.getUserPresence(username).catch(() => null)) === "offline") {
      throw new Error(`${username} est hors ligne : réessayez quand il revient, ou choisissez une autre source`);
    }
    await api.retryDownload(username, id, filename, size);
    downloads.resetAttempts(username, filename);
    await downloads.refresh();
    return true;
  },
);

/** Remove finished transfers from the list: succeeded ones, or failed ones. */
ipcMain.handle("slskd-clear-downloads", async (_, kind: "succeeded" | "failed") => {
  const api = slskd.getAPI();
  const finished = (await downloads.refresh()).filter(
    (t) =>
      /completed/i.test(t.state) &&
      isSucceeded(t.state) === (kind === "succeeded") &&
      // Keep succeeded downloads that are not placed in the library yet
      !downloads.isPlacing(t),
  );
  await Promise.all(finished.map((t) => api.cancelDownload(t.username, t.id, true)));
  if (kind === "failed") finished.forEach((t) => downloads.forget(t.username, t.filename));
  await downloads.refresh();
  return finished.length;
});
