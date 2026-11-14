// ─── Kusic Main Process ─────────────────────────────────────
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { store } from "./store.js";
import { Library } from "./library/library.js";
import { registerCoverScheme, handleCoverProtocol } from "./library/covers.js";
import { isInside } from "./library/naming.js";
import { DownloadTracker, isSucceeded } from "./downloads.js";
import {
  getCachedSearch,
  getCacheSummary,
  pruneSearchCache,
  setCachedSearch,
} from "./search-cache.js";
import { SpotifyService } from "../services/spotify.js";
import { SlskdManager, type SlskdAPI } from "../services/slskd/index.js";
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
  mainWindow?.webContents.send(channel, payload);
}

const library = new Library(() => send("library-changed"));
const slskd = new SlskdManager();
const downloads = new DownloadTracker(
  () => (slskd.isRunning ? slskd.getAPI() : null),
  library,
  () => store.get("soulseek").libraryPath,
  (transfers) => send("downloads-updated", transfers),
  (event) => send("download-event", event),
);

slskd.onStateChange = () => {
  if (slskd.isRunning) downloads.start();
  else downloads.stop();
  send("slskd-state-changed");
};

// ─── App lifecycle ─────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
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

  // The UI is a single local page: no navigation, no pop-ups
  mainWindow.webContents.on("will-navigate", (e) => e.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html")).catch((err) => {
    console.error("[Kusic] Failed to load UI:", err);
  });

  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }
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

registerCoverScheme();

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
    pruneSearchCache();
    createWindow();
    // Pick up files changed outside Kusic (also migrates older index formats)
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
  downloads.stop();
  slskd.stop().finally(() => app.quit());
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── Settings ──────────────────────────────────────────────────

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 1000) {
    throw new Error(`Valeur invalide pour ${field}`);
  }
  return value.trim();
}

ipcMain.handle(
  "get-settings",
  (): AppSettings => ({
    spotify: store.get("spotify"),
    soulseek: store.get("soulseek"),
  }),
);

ipcMain.handle("save-settings", async (_, settings: Partial<AppSettings>) => {
  if (settings.spotify) {
    store.set("spotify", {
      clientId: text(settings.spotify.clientId, "Client ID"),
      clientSecret: text(settings.spotify.clientSecret, "Client Secret"),
    });
  }

  if (settings.soulseek) {
    const current = store.get("soulseek");
    const libraryPath = text(settings.soulseek.libraryPath, "dossier");
    // The library folder can only come from the folder picker
    if (libraryPath !== current.libraryPath && libraryPath !== browsedLibraryPath) {
      throw new Error("Choisissez le dossier de la bibliothèque avec le bouton Parcourir");
    }
    store.set("soulseek", {
      username: text(settings.soulseek.username, "nom d'utilisateur"),
      password: text(settings.soulseek.password, "mot de passe"),
      libraryPath,
    });
    if (libraryPath !== current.libraryPath) await library.rescan();
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
ipcMain.handle("rescan-library", () => library.rescan());
ipcMain.handle("get-tracks", (_, filters?: TrackFilters) => library.getTracks(filters));
ipcMain.handle("get-stats", () => library.getStats());

ipcMain.handle("export-playlist", async (_, playlistId: string) => {
  const playlist = library.getPlaylists().find((p) => p.id === playlistId);
  if (!playlist || !mainWindow) return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Exporter la playlist",
    defaultPath: path.join(
      store.get("soulseek").libraryPath || app.getPath("music"),
      `${playlist.name.replace(/[<>:"/\\|?*]/g, "")}.m3u`,
    ),
    filters: [{ name: "Playlist M3U", extensions: ["m3u", "m3u8"] }],
  });
  if (result.canceled || !result.filePath) return null;
  return library.exportM3U(playlistId, result.filePath);
});

ipcMain.handle("link-unknown-to-track", (_, fileTrackId: string, targetTrackId: string) =>
  library.linkUnknown(fileTrackId, targetTrackId),
);

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
ipcMain.handle("search-cache-set", (_, query: string, results: SlskdSearchResult[]) =>
  setCachedSearch(query, results),
);
ipcMain.handle("search-cache-summary", () => getCacheSummary());

// ─── Slskd ─────────────────────────────────────────────────────

/** The slskd API client, or an error when the daemon is not running. */
function slskdApi(): SlskdAPI {
  if (!slskd.isRunning) throw new Error("slskd n'est pas démarré");
  return slskd.getAPI();
}

ipcMain.handle("slskd-check-platform", () => ({
  supported: slskd.isPlatformSupported(),
  platform: process.platform,
  arch: process.arch,
}));

ipcMain.handle("slskd-get-version", () => slskd.getVersionInfo());

ipcMain.handle("slskd-download-binary", () =>
  slskd.downloadBinary((progress) => send("slskd-download-progress", progress)),
);

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
  return slskdApi().search(text(query, "recherche"));
});

ipcMain.handle("slskd-cancel-search", async (_, searchId: string) => {
  if (slskd.isRunning) await slskdApi().cancelSearch(searchId);
});

ipcMain.handle(
  "slskd-get-search-results",
  (_, { searchId, includeFiles = true }: { searchId: string; includeFiles?: boolean }) =>
    slskdApi().getSearchResults(searchId, includeFiles),
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
    await slskdApi().download(username, [{ filename, size }]);
    if (trackId) downloads.register(username, filename, size, trackId);
    downloads.refresh().catch(() => {});
    return true;
  },
);

ipcMain.handle("slskd-get-downloads", () =>
  slskd.isRunning ? downloads.refresh() : [],
);

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
    await slskdApi().cancelDownload(username, id, remove);
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
    await slskdApi().retryDownload(username, id, filename, size);
    await downloads.refresh();
    return true;
  },
);

/** Remove finished transfers from the list: succeeded ones, or failed ones. */
ipcMain.handle("slskd-clear-downloads", async (_, kind: "succeeded" | "failed") => {
  const api = slskdApi();
  const finished = (await downloads.refresh()).filter(
    (t) => /completed/i.test(t.state) && isSucceeded(t.state) === (kind === "succeeded"),
  );
  await Promise.all(finished.map((t) => api.cancelDownload(t.username, t.id, true)));
  if (kind === "failed") finished.forEach((t) => downloads.forget(t.username, t.filename));
  await downloads.refresh();
  return finished.length;
});
