// ─── Kusic Main Process ─────────────────────────────────────
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import * as mm from "music-metadata";
import * as taglib from "node-taglib-sharp";
import Store from "electron-store";
import { SpotifyService } from "../services/spotify.js";
import { SoundCloudService } from "../services/soundcloud.js";
import { SlskdManager } from "../services/slskd/index.js";
import type { Playlist, Track, AppSettings, TrackFilters } from "../types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// ─── Local File Scanner ────────────────────────────────────────

const AUDIO_EXTENSIONS = [
  ".mp3",
  ".flac",
  ".wav",
  ".m4a",
  ".aac",
  ".ogg",
  ".wma",
];

async function scanLocalFiles(): Promise<Track[]> {
  const libraryPath = store.get("soulseek").libraryPath;
  console.log("[Kusic] Scanning local files in:", libraryPath);

  if (!libraryPath || !fs.existsSync(libraryPath)) {
    console.log("[Kusic] Library path not configured or doesn't exist");
    return [];
  }

  const filePaths: string[] = [];

  function scanDir(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith(".")) {
          scanDir(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (AUDIO_EXTENSIONS.includes(ext)) {
            filePaths.push(fullPath);
          }
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  scanDir(libraryPath);

  const tracks: Track[] = [];
  for (const filePath of filePaths) {
    const track = await parseAudioFile(filePath);
    if (track) tracks.push(track);
  }

  console.log(`[Kusic] Found ${tracks.length} local audio files`);
  return tracks;
}

async function parseAudioFile(filePath: string): Promise<Track | null> {
  try {
    const metadata = await mm.parseFile(filePath);
    const stats = fs.statSync(filePath);
    const filename = path.basename(filePath);
    const nameWithoutExt = path.basename(filename, path.extname(filename));

    // Use metadata if available, fallback to filename parsing
    let artist = metadata.common.artist || "";
    let title = metadata.common.title || "";
    let album = metadata.common.album || "";

    // Fallback: parse "Artist - Title" from filename
    if (!artist || !title) {
      const separators = [" - ", " – ", " — "];
      for (const sep of separators) {
        if (nameWithoutExt.includes(sep)) {
          const parts = nameWithoutExt.split(sep);
          if (!artist) artist = parts[0].trim();
          if (!title) title = parts.slice(1).join(sep).trim();
          break;
        }
      }
      if (!title) title = nameWithoutExt;
      if (!artist) artist = "Artiste inconnu";
    }

    // Extract artwork as base64 data URL
    let artwork = "";
    if (metadata.common.picture && metadata.common.picture.length > 0) {
      const pic = metadata.common.picture[0];
      const base64 = Buffer.from(pic.data).toString("base64");
      artwork = `data:${pic.format};base64,${base64}`;
    }

    // Get format info
    const ext = path.extname(filePath).toLowerCase().slice(1);
    const format = ext.toUpperCase();
    const bitRate = metadata.format.bitrate
      ? Math.round(metadata.format.bitrate / 1000)
      : undefined;
    const sampleRate = metadata.format.sampleRate;
    const bitDepth = metadata.format.bitsPerSample;

    // Read KUSIC_TRACK_ID from comment field (format: [KUSIC:trackId] comment)
    let linkedTrackId: string | undefined;
    const commentRaw = metadata.common.comment?.[0];
    const comment =
      typeof commentRaw === "string"
        ? commentRaw
        : (commentRaw as { text?: string })?.text || "";
    const kusicMatch = comment.match(/\[KUSIC:([^\]]+)\]/);
    if (kusicMatch) {
      linkedTrackId = kusicMatch[1];
    }

    // Determine source based on linkedTrackId
    let source: "local" | "unknown" = linkedTrackId ? "local" : "unknown";

    return {
      id: `local-${Buffer.from(filePath).toString("base64").slice(0, 20)}`,
      source,
      title,
      artist,
      album,
      artwork,
      duration: Math.round((metadata.format.duration || 0) * 1000),
      addedAt: stats.mtimeMs,
      format,
      bitRate,
      sampleRate,
      bitDepth,
      filePath,
      linkedTrackId,
    };
  } catch (err) {
    console.error(`[Kusic] Failed to parse ${filePath}:`, err);
    return null;
  }
}

// ─── Metadata Writing Functions ────────────────────────────────

interface MergedMetadata {
  title: string;
  artist: string;
  album: string;
  artwork: string;
  linkedTrackId: string;
}

function mergeMetadata(
  playlistTrack: Track,
  fileMetadata: Partial<Track>,
): MergedMetadata {
  return {
    title: playlistTrack.title || fileMetadata.title || "",
    artist: playlistTrack.artist || fileMetadata.artist || "",
    album: playlistTrack.album || fileMetadata.album || "",
    artwork: playlistTrack.artwork || fileMetadata.artwork || "",
    linkedTrackId: playlistTrack.id,
  };
}

async function writeMetadataToFile(
  filePath: string,
  metadata: MergedMetadata,
): Promise<boolean> {
  try {
    const file = taglib.File.createFromPath(filePath);

    // Write standard tags
    file.tag.title = metadata.title;
    file.tag.performers = [metadata.artist];
    file.tag.album = metadata.album;

    // Store KUSIC_TRACK_ID in the comment field with a prefix
    // This is a cross-format compatible approach
    const existingComment = file.tag.comment || "";
    const kusicPrefix = "[KUSIC:";
    if (!existingComment.includes(kusicPrefix)) {
      file.tag.comment =
        `${kusicPrefix}${metadata.linkedTrackId}] ${existingComment}`.trim();
    }

    file.save();
    file.dispose();

    console.log(`[Kusic] Wrote metadata to ${filePath}`);
    return true;
  } catch (err) {
    console.error(`[Kusic] Failed to write metadata to ${filePath}:`, err);
    return false;
  }
}

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

  // Scan local files to check for linked tracks
  const localTracks = await scanLocalFiles();
  const linkedLocalFiles = new Map<string, Track>();
  for (const localTrack of localTracks) {
    if (localTrack.linkedTrackId) {
      linkedLocalFiles.set(localTrack.linkedTrackId, localTrack);
    }
  }

  // Merge tracks into unified list with local file info
  const allTracks = store.get("tracks");
  for (const track of playlistData.tracks) {
    const linkedLocal = linkedLocalFiles.get(track.id);
    if (linkedLocal) {
      allTracks.push({
        ...track,
        format: linkedLocal.format,
        bitRate: linkedLocal.bitRate,
        sampleRate: linkedLocal.sampleRate,
        bitDepth: linkedLocal.bitDepth,
        filePath: linkedLocal.filePath,
      });
    } else {
      allTracks.push(track);
    }
  }
  store.set("tracks", allTracks);

  return playlistData;
});

ipcMain.handle("refresh-library", async () => {
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

  // Scan local files from library
  const localTracks = await scanLocalFiles();
  console.log(`[Kusic] Scanned ${localTracks.length} local files`);

  // Create a map of linkedTrackId -> local file data for merging
  const linkedLocalFiles = new Map<string, Track>();
  const orphanedLocalTracks: Track[] = [];

  for (const localTrack of localTracks) {
    if (localTrack.linkedTrackId) {
      linkedLocalFiles.set(localTrack.linkedTrackId, localTrack);
      console.log(
        `[Kusic] Linked file: ${localTrack.filePath} -> ${localTrack.linkedTrackId}`,
      );
    } else {
      orphanedLocalTracks.push(localTrack);
    }
  }

  console.log(
    `[Kusic] Found ${linkedLocalFiles.size} linked files, ${orphanedLocalTracks.length} orphaned`,
  );

  // Rebuild unified track list with merged data
  const allTracks: Track[] = [];
  const matchedLinkedIds = new Set<string>();

  for (const pl of refreshed) {
    for (const track of pl.tracks) {
      // Check if there's a linked local file for this track
      const linkedLocal = linkedLocalFiles.get(track.id);
      if (linkedLocal) {
        matchedLinkedIds.add(track.id);
        console.log(`[Kusic] Merging track ${track.title} with local file`);
        // Merge: keep playlist metadata, add local file quality info
        allTracks.push({
          ...track,
          format: linkedLocal.format,
          bitRate: linkedLocal.bitRate,
          sampleRate: linkedLocal.sampleRate,
          bitDepth: linkedLocal.bitDepth,
          filePath: linkedLocal.filePath,
        });
      } else {
        // Ensure no stale local file data - push clean track
        allTracks.push({
          id: track.id,
          source: track.source,
          title: track.title,
          artist: track.artist,
          album: track.album,
          artwork: track.artwork,
          duration: track.duration,
          addedAt: track.addedAt,
          spotifyUrl: track.spotifyUrl,
          soundcloudUrl: track.soundcloudUrl,
          previewUrl: track.previewUrl,
          streamUrl: track.streamUrl,
          // Explicitly NO format, bitRate, sampleRate, bitDepth, filePath
        });
      }
    }
  }

  // Add orphaned local files (unknown source)
  for (const track of orphanedLocalTracks) {
    allTracks.push(track);
  }

  // Add linked files whose playlists were removed (convert to local orphan)
  for (const [linkedId, localTrack] of linkedLocalFiles) {
    if (!matchedLinkedIds.has(linkedId)) {
      // Playlist was removed, convert to local orphan
      allTracks.push({
        ...localTrack,
        source: "local" as const,
        linkedTrackId: undefined, // Clear the stale link
      });
    }
  }

  store.set("tracks", allTracks);

  return {
    playlists: refreshed,
    totalTracks: allTracks.length,
    localTracks: localTracks.length,
  };
});

// Tag a downloaded file with playlist track metadata
ipcMain.handle(
  "tag-downloaded-file",
  async (_, filename: string, trackId: string) => {
    try {
      const libraryPath = store.get("soulseek").libraryPath;
      if (!libraryPath) {
        return { success: false, error: "Library path not configured" };
      }

      // Find the file in library (slskd might put it in subdirectories)
      let filePath = await findFileInLibrary(libraryPath, filename);
      if (!filePath) {
        return { success: false, error: "File not found in library" };
      }

      // Find the playlist track
      const playlists = store.get("playlists");
      let playlistTrack: Track | null = null;
      for (const pl of playlists) {
        const track = pl.tracks.find((t) => t.id === trackId);
        if (track) {
          playlistTrack = track;
          break;
        }
      }

      if (!playlistTrack) {
        return { success: false, error: "Playlist track not found" };
      }

      // Read current file metadata
      const fileMetadata = await parseAudioFile(filePath);
      if (!fileMetadata) {
        return { success: false, error: "Could not read file metadata" };
      }

      // Merge and write
      const merged = mergeMetadata(playlistTrack, fileMetadata);
      const success = await writeMetadataToFile(filePath, merged);

      // Generate clean filename: "Title - Artist.ext"
      const ext = path.extname(filePath);
      const cleanTitle = sanitizeFilename(playlistTrack.title);
      const cleanArtist = sanitizeFilename(playlistTrack.artist);
      const newFilename = `${cleanArtist} - ${cleanTitle}${ext}`;
      const targetPath = path.join(libraryPath, newFilename);

      // Handle name conflicts
      let finalPath = targetPath;
      if (fs.existsSync(targetPath) && targetPath !== filePath) {
        let counter = 1;
        while (fs.existsSync(finalPath)) {
          finalPath = path.join(
            libraryPath,
            `${cleanArtist} - ${cleanTitle} (${counter})${ext}`,
          );
          counter++;
        }
      }

      // Move/rename file
      if (filePath !== finalPath) {
        const fileDir = path.dirname(filePath);
        fs.renameSync(filePath, finalPath);
        filePath = finalPath;
        console.log(`[Kusic] Renamed file to: ${path.basename(finalPath)}`);

        // Clean up empty directories if moved from subdirectory
        if (fileDir !== libraryPath) {
          cleanEmptyDirs(fileDir, libraryPath);
        }
      }

      return { success, filePath };
    } catch (err) {
      console.error("[Kusic] tag-downloaded-file error:", err);
      return { success: false, error: (err as Error).message };
    }
  },
);

function sanitizeFilename(name: string): string {
  // Remove/replace characters invalid in filenames
  return name
    .replace(/[<>:"/\\|?*]/g, "") // Remove invalid chars
    .replace(/\s+/g, " ") // Collapse spaces
    .trim();
}

function cleanEmptyDirs(dir: string, stopAt: string) {
  // Don't delete the library root or go above it
  if (dir === stopAt || !dir.startsWith(stopAt)) return;

  try {
    const entries = fs.readdirSync(dir);
    if (entries.length === 0) {
      fs.rmdirSync(dir);
      console.log(`[Kusic] Removed empty directory: ${dir}`);
      // Recursively check parent
      cleanEmptyDirs(path.dirname(dir), stopAt);
    }
  } catch {
    // Directory not empty or can't be deleted
  }
}

async function findFileInLibrary(
  libraryPath: string,
  filename: string,
): Promise<string | null> {
  const searchRecursive = (dir: string): string | null => {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = searchRecursive(fullPath);
          if (found) return found;
        } else if (entry.name === filename) {
          return fullPath;
        }
      }
    } catch (err) {
      // Skip inaccessible directories
    }
    return null;
  };
  return searchRecursive(libraryPath);
}

ipcMain.handle(
  "link-unknown-to-track",
  async (_, unknownTrackId: string, targetTrackId: string) => {
    try {
      const tracks = store.get("tracks");
      const playlists = store.get("playlists");
      const libraryPath = store.get("soulseek").libraryPath;

      // Find the unknown track (local file)
      const unknownTrack = tracks.find(
        (t) => t.id === unknownTrackId && t.source === "unknown",
      );
      if (!unknownTrack || !unknownTrack.filePath) {
        return { success: false, error: "Fichier source non trouvé" };
      }

      // Find the target playlist track
      let targetTrack: Track | null = null;
      for (const pl of playlists) {
        const found = pl.tracks.find((t) => t.id === targetTrackId);
        if (found) {
          targetTrack = found;
          break;
        }
      }
      if (!targetTrack) {
        return { success: false, error: "Morceau cible non trouvé" };
      }

      const filePath = unknownTrack.filePath;

      // Write metadata with KUSIC tag
      const merged = mergeMetadata(targetTrack, unknownTrack);
      const tagSuccess = await writeMetadataToFile(filePath, merged);
      if (!tagSuccess) {
        return { success: false, error: "Impossible d'écrire les métadonnées" };
      }

      // Small delay to ensure file handle is released on Windows
      await new Promise(resolve => setTimeout(resolve, 100));

      // Rename file to "Artiste - Titre.ext"
      const ext = path.extname(filePath);
      const cleanTitle = sanitizeFilename(targetTrack.title);
      const cleanArtist = sanitizeFilename(targetTrack.artist);
      const newFilename = `${cleanArtist} - ${cleanTitle}${ext}`;
      let finalPath = path.join(libraryPath, newFilename);

      // Handle name conflicts
      if (fs.existsSync(finalPath) && finalPath !== filePath) {
        let counter = 1;
        while (fs.existsSync(finalPath)) {
          finalPath = path.join(
            libraryPath,
            `${cleanArtist} - ${cleanTitle} (${counter})${ext}`,
          );
          counter++;
        }
      }

      // Move/rename file
      const normalizedFilePath = path.normalize(filePath).toLowerCase();
      const normalizedFinalPath = path.normalize(finalPath).toLowerCase();
      
      if (normalizedFilePath !== normalizedFinalPath) {
        const fileDir = path.dirname(filePath);
        fs.renameSync(filePath, finalPath);

        if (fileDir !== libraryPath) {
          cleanEmptyDirs(fileDir, libraryPath);
        }
      }

      // Remove the unknown track from store (it will be re-added as linked on next refresh)
      const updatedTracks = tracks.filter((t) => t.id !== unknownTrackId);
      store.set("tracks", updatedTracks);

      console.log(
        `[Kusic] Linked unknown track to ${targetTrack.title} - ${targetTrack.artist}`,
      );

      return { success: true, filePath: finalPath };
    } catch (err) {
      console.error("[Kusic] link-unknown-to-track error:", err);
      return { success: false, error: (err as Error).message };
    }
  },
);

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
    localTracks: tracks.filter((t) => t.source === "local").length,
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

ipcMain.handle("slskd-cancel-search", async (_, searchId: string) => {
  if (!slskdManager || !slskdManager.isRunning) {
    return;
  }
  const api = slskdManager.getAPI();
  await api.cancelSearch(searchId);
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

ipcMain.handle(
  "slskd-cancel-download",
  async (
    _,
    { username, id, remove }: { username: string; id: string; remove: boolean },
  ) => {
    if (!slskdManager || !slskdManager.isRunning) {
      throw new Error("slskd n'est pas démarré");
    }
    await slskdManager.getAPI().cancelDownload(username, id, remove);
    return true;
  },
);

ipcMain.handle(
  "slskd-retry-download",
  async (
    _,
    {
      username,
      id,
      filename,
      size,
    }: { username: string; id: string; filename: string; size: number },
  ) => {
    if (!slskdManager || !slskdManager.isRunning) {
      throw new Error("slskd n'est pas démarré");
    }
    await slskdManager.getAPI().retryDownload(username, id, filename, size);
    return true;
  },
);

ipcMain.handle("slskd-clear-completed-downloads", async () => {
  if (!slskdManager || !slskdManager.isRunning) {
    throw new Error("slskd n'est pas démarré");
  }
  await slskdManager.getAPI().clearCompletedDownloads();
  return true;
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
