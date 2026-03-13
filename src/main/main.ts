// ─── Kusic Main Process ─────────────────────────────────────
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import path from "path";
import Store from "electron-store";
import { SpotifyService } from "../services/spotify";
import { SoundCloudService } from "../services/soundcloud";
import { SlskdManager } from "../services/slskd";
import type { Playlist, Track, AppSettings, TrackFilters } from "../types";

interface StoreSchema {
  playlists: Playlist[];
  tracks: Track[];
  spotify: { clientId: string; clientSecret: string };
  soulseek: { username: string; password: string; libraryPath: string };
}

const store = new Store<StoreSchema>({
  defaults: {
    playlists: [],
    tracks: [],
    spotify: { clientId: "", clientSecret: "" },
    soulseek: { username: "", password: "", libraryPath: "" },
  },
});

let slskdManager: SlskdManager | null = null;
let mainWindow: BrowserWindow | null = null;

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
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));

  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(async () => {
  slskdManager = new SlskdManager();
  createWindow();

  // Auto-start slskd if configured
  const soulseekConfig = store.get("soulseek");
  if (
    soulseekConfig.username &&
    soulseekConfig.password &&
    soulseekConfig.libraryPath
  ) {
    try {
      if (slskdManager.isBinaryInstalled()) {
        await slskdManager.start(soulseekConfig);
        console.log("[Kusic] slskd started successfully");
      }
    } catch (err) {
      console.error(
        "[Kusic] Failed to auto-start slskd:",
        (err as Error).message,
      );
    }
  }
});

app.on("window-all-closed", () => {
  slskdManager?.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── IPC Handlers ──────────────────────────────────────────────

ipcMain.handle(
  "get-settings",
  (): AppSettings => ({
    spotify: store.get("spotify"),
    soulseek: store.get("soulseek"),
  }),
);

ipcMain.handle("save-settings", (_, settings: Partial<AppSettings>) => {
  if (settings.spotify) store.set("spotify", settings.spotify);
  if (settings.soulseek) store.set("soulseek", settings.soulseek);
  return true;
});

ipcMain.handle("get-playlists", (): Playlist[] => store.get("playlists"));

ipcMain.handle("add-playlist", async (_, url: string): Promise<Playlist> => {
  let playlistData: Playlist;

  if (url.includes("spotify.com")) {
    const spotifyConfig = store.get("spotify");
    if (!spotifyConfig.clientId || !spotifyConfig.clientSecret) {
      throw new Error(
        "Configurez vos identifiants Spotify dans les paramètres",
      );
    }
    const spotify = new SpotifyService(
      spotifyConfig.clientId,
      spotifyConfig.clientSecret,
    );
    playlistData = await spotify.getPlaylist(url);
  } else if (url.includes("soundcloud.com")) {
    const sc = new SoundCloudService();
    playlistData = await sc.getPlaylist(url);
  } else {
    throw new Error(
      "URL non supportée. Utilisez une URL Spotify ou SoundCloud.",
    );
  }

  const playlists = store.get("playlists");

  if (playlists.find((p) => p.url === playlistData.url)) {
    throw new Error("Cette playlist est déjà dans votre bibliothèque");
  }

  playlists.push(playlistData);
  store.set("playlists", playlists);

  // Merge tracks into unified list
  const allTracks = store.get("tracks");
  for (const track of playlistData.tracks) {
    const duplicate = allTracks.find(
      (t) =>
        t.title.toLowerCase() === track.title.toLowerCase() &&
        t.artist.toLowerCase() === track.artist.toLowerCase(),
    );
    if (!duplicate) {
      allTracks.push(track);
    }
  }
  store.set("tracks", allTracks);

  return playlistData;
});

ipcMain.handle("refresh-playlists", async () => {
  const playlists = store.get("playlists");
  const refreshed: Playlist[] = [];

  for (const pl of playlists) {
    try {
      let freshData: Playlist;
      if (pl.source === "spotify") {
        const spotifyConfig = store.get("spotify");
        if (!spotifyConfig.clientId || !spotifyConfig.clientSecret) {
          refreshed.push(pl);
          continue;
        }
        const spotify = new SpotifyService(
          spotifyConfig.clientId,
          spotifyConfig.clientSecret,
        );
        freshData = await spotify.getPlaylist(pl.url);
      } else if (pl.source === "soundcloud") {
        const sc = new SoundCloudService();
        freshData = await sc.getPlaylist(pl.url);
      } else {
        refreshed.push(pl);
        continue;
      }
      freshData.addedAt = pl.addedAt;
      refreshed.push(freshData);
    } catch {
      refreshed.push(pl);
    }
  }

  store.set("playlists", refreshed);

  // Rebuild unified track list
  const allTracks: Track[] = [];
  const seen = new Set<string>();
  for (const pl of refreshed) {
    for (const track of pl.tracks) {
      const key = `${track.title.toLowerCase()}|${track.artist.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        allTracks.push(track);
      }
    }
  }
  store.set("tracks", allTracks);

  return { playlists: refreshed, totalTracks: allTracks.length };
});

ipcMain.handle("remove-playlist", (_, playlistId: string) => {
  let playlists = store.get("playlists");
  const playlist = playlists.find((p) => p.id === playlistId);

  playlists = playlists.filter((p) => p.id !== playlistId);
  store.set("playlists", playlists);

  if (playlist) {
    const remainingTrackIds = new Set<string>();
    playlists.forEach((p) =>
      p.tracks.forEach((t) => remainingTrackIds.add(t.id)),
    );

    let tracks = store.get("tracks");
    tracks = tracks.filter(
      (t) =>
        remainingTrackIds.has(t.id) ||
        !playlist.tracks.find((pt) => pt.id === t.id),
    );
    store.set("tracks", tracks);
  }

  return playlists;
});

ipcMain.handle("get-tracks", (_, filters: TrackFilters = {}) => {
  let tracks = [...store.get("tracks")];

  if (filters.search) {
    const q = filters.search.toLowerCase();
    tracks = tracks.filter(
      (t) =>
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.album?.toLowerCase().includes(q),
    );
  }

  if (filters.source && filters.source !== "all") {
    tracks = tracks.filter((t) => t.source === filters.source);
  }

  if (filters.sortBy === "title") {
    tracks.sort((a, b) => a.title.localeCompare(b.title));
  } else if (filters.sortBy === "artist") {
    tracks.sort((a, b) => a.artist.localeCompare(b.artist));
  } else if (filters.sortBy === "duration") {
    tracks.sort((a, b) => a.duration - b.duration);
  } else {
    tracks.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  }

  return tracks;
});

ipcMain.handle("get-stats", () => {
  const playlists = store.get("playlists");
  const tracks = store.get("tracks");
  return {
    totalPlaylists: playlists.length,
    totalTracks: tracks.length,
    spotifyTracks: tracks.filter((t) => t.source === "spotify").length,
    soundcloudTracks: tracks.filter((t) => t.source === "soundcloud").length,
  };
});

ipcMain.handle("open-external", (_, url: string) => {
  shell.openExternal(url);
});

// ─── Slskd Handlers ────────────────────────────────────────────

ipcMain.handle("browse-folder", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Choisir le dossier de la bibliothèque",
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("slskd-check-platform", () => ({
  supported: slskdManager?.isPlatformSupported() ?? false,
  platform: process.platform,
  arch: process.arch,
}));

ipcMain.handle("slskd-get-version", () =>
  slskdManager
    ? {
        version: slskdManager.getVersion(),
        installed: slskdManager.isBinaryInstalled(),
      }
    : null,
);

ipcMain.handle(
  "slskd-check-binary",
  () => slskdManager?.isBinaryInstalled() ?? false,
);

ipcMain.handle("slskd-download-binary", async () => {
  if (!slskdManager) throw new Error("Manager not initialized");
  return await slskdManager.downloadBinary((progress) => {
    mainWindow?.webContents.send("slskd-download-progress", progress);
  });
});

ipcMain.handle("slskd-start", async () => {
  if (!slskdManager) throw new Error("Manager not initialized");

  const config = store.get("soulseek");
  if (!config.username || !config.password) {
    throw new Error("Configurez vos identifiants Soulseek dans les paramètres");
  }
  if (!config.libraryPath) {
    throw new Error(
      "Configurez le dossier de votre bibliothèque dans les paramètres",
    );
  }

  await slskdManager.start(config);
  return true;
});

ipcMain.handle("slskd-stop", () => {
  slskdManager?.stop();
  return true;
});

ipcMain.handle("slskd-status", async () => {
  if (!slskdManager) return { running: false, connected: false };
  return await slskdManager.getStatus();
});

ipcMain.handle("slskd-search", async (_, query: string) => {
  if (!slskdManager || !slskdManager.isRunning) {
    throw new Error("slskd n'est pas démarré");
  }
  const api = slskdManager.getAPI();
  return await api.search(query);
});

ipcMain.handle(
  "slskd-get-search-results",
  async (
    _,
    {
      searchId,
      includeFiles = true,
    }: { searchId: string; includeFiles?: boolean },
  ) => {
    if (!slskdManager || !slskdManager.isRunning) {
      throw new Error("slskd n'est pas démarré");
    }
    const api = slskdManager.getAPI();
    return await api.getSearchResults(searchId, includeFiles);
  },
);

ipcMain.handle(
  "slskd-download",
  async (
    _,
    {
      username,
      filename,
      size,
    }: { username: string; filename: string; size: number },
  ) => {
    if (!slskdManager || !slskdManager.isRunning) {
      throw new Error("slskd n'est pas démarré");
    }
    const api = slskdManager.getAPI();
    await api.download(username, [{ filename, size }]);
    return true;
  },
);

ipcMain.handle("slskd-get-downloads", async () => {
  if (!slskdManager || !slskdManager.isRunning) return [];
  return await slskdManager.getAPI().getDownloads();
});

ipcMain.handle("slskd-get-uploads", async () => {
  if (!slskdManager || !slskdManager.isRunning) return [];
  return await slskdManager.getAPI().getUploads();
});

ipcMain.handle("slskd-rescan-shares", async () => {
  if (!slskdManager || !slskdManager.isRunning) {
    throw new Error("slskd n'est pas démarré");
  }
  await slskdManager.getAPI().rescanShares();
  return true;
});

ipcMain.handle("slskd-get-shares", async () => {
  if (!slskdManager || !slskdManager.isRunning) return null;
  return await slskdManager.getAPI().getShares();
});
