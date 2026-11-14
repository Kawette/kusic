// ─── Kusic Main Process ─────────────────────────────────────
import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import crypto from "crypto";
import * as mm from "music-metadata";
import * as taglib from "node-taglib-sharp";
import Store from "electron-store";
import { SpotifyService } from "../services/spotify.js";
import { SoundCloudService } from "../services/soundcloud.js";
import { SlskdManager, SlskdAPI } from "../services/slskd/index.js";
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

    // Use hash of full path to ensure unique IDs for files in same directory
    const pathHash = crypto.createHash("md5").update(filePath).digest("hex");

    return {
      id: `local-${pathHash}`,
      source: linkedTrackId ? "local" : "unknown",
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

// ─── Track Index ───────────────────────────────────────────────

/** Copy the local file quality info of `local` onto a playlist track. */
function withLocalFile(track: Track, local: Track): Track {
  const { format, bitRate, sampleRate, bitDepth, filePath } = local;
  return { ...track, format, bitRate, sampleRate, bitDepth, filePath };
}

/** Strip any stale local file data from a playlist track. */
function withoutLocalFile(track: Track): Track {
  const { format, bitRate, sampleRate, bitDepth, filePath, linkedTrackId, ...clean } = track;
  return clean;
}

/**
 * Rebuild the unified track list from the playlists and the files found in
 * the library: playlist tracks get the quality info of their linked file,
 * untagged files are "unknown", and files linked to a track that no longer
 * belongs to any playlist become plain "local" tracks.
 */
async function rebuildTrackIndex(playlists: Playlist[]) {
  const localTracks = await scanLocalFiles();

  const linkedLocalFiles = new Map<string, Track>();
  const orphanedLocalTracks: Track[] = [];
  for (const localTrack of localTracks) {
    if (localTrack.linkedTrackId) {
      linkedLocalFiles.set(localTrack.linkedTrackId, localTrack);
    } else {
      orphanedLocalTracks.push(localTrack);
    }
  }

  console.log(
    `[Kusic] Found ${linkedLocalFiles.size} linked files, ${orphanedLocalTracks.length} orphaned`,
  );

  const allTracks: Track[] = [];
  const matchedLinkedIds = new Set<string>();

  for (const pl of playlists) {
    for (const track of pl.tracks) {
      const linkedLocal = linkedLocalFiles.get(track.id);
      if (linkedLocal) {
        matchedLinkedIds.add(track.id);
        allTracks.push(withLocalFile(track, linkedLocal));
      } else {
        allTracks.push(withoutLocalFile(track));
      }
    }
  }

  allTracks.push(...orphanedLocalTracks);

  for (const [linkedId, localTrack] of linkedLocalFiles) {
    if (!matchedLinkedIds.has(linkedId)) {
      allTracks.push({ ...localTrack, source: "local", linkedTrackId: undefined });
    }
  }

  store.set("tracks", allTracks);
  return { totalTracks: allTracks.length, localTracks: localTracks.length };
}

function findPlaylistTrack(trackId: string): Track | undefined {
  for (const pl of store.get("playlists")) {
    const track = pl.tracks.find((t) => t.id === trackId);
    if (track) return track;
  }
  return undefined;
}

async function fetchPlaylist(url: string): Promise<Playlist> {
  if (url.includes("spotify.com")) {
    const { clientId, clientSecret } = store.get("spotify");
    if (!clientId || !clientSecret) {
      throw new Error(
        "Configurez vos identifiants Spotify dans les paramètres",
      );
    }
    return new SpotifyService(clientId, clientSecret).getPlaylist(url);
  }
  if (url.includes("soundcloud.com")) {
    return new SoundCloudService().getPlaylist(url);
  }
  throw new Error("URL non supportée. Utilisez une URL Spotify ou SoundCloud.");
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
  const playlistData = await fetchPlaylist(url);
  const playlists = store.get("playlists");

  if (playlists.some((p) => p.url === playlistData.url)) {
    throw new Error("Cette playlist est déjà dans votre bibliothèque");
  }

  playlists.push(playlistData);
  store.set("playlists", playlists);
  await rebuildTrackIndex(playlists);

  return playlistData;
});

ipcMain.handle("refresh-library", async () => {
  const refreshed: Playlist[] = [];

  for (const pl of store.get("playlists")) {
    try {
      const freshData = await fetchPlaylist(pl.url);
      freshData.addedAt = pl.addedAt;
      refreshed.push(freshData);
    } catch {
      refreshed.push(pl);
    }
  }

  store.set("playlists", refreshed);
  return { playlists: refreshed, ...(await rebuildTrackIndex(refreshed)) };
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
      let filePath = findFileInLibrary(libraryPath, filename);
      if (!filePath) {
        return { success: false, error: "File not found in library" };
      }

      const playlistTrack = findPlaylistTrack(trackId);
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

      // Move/rename to "Artist - Title.ext" (replace existing if any)
      const targetPath = path.join(
        libraryPath,
        libraryFilename(playlistTrack, path.extname(filePath)),
      );
      if (filePath !== targetPath) {
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
        moveIntoLibrary(filePath, targetPath, libraryPath);
        filePath = targetPath;
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

/** "Artist - Title<suffix><ext>" with filesystem-safe parts. */
function libraryFilename(track: Track, ext: string, suffix = ""): string {
  return `${sanitizeFilename(track.artist)} - ${sanitizeFilename(track.title)}${suffix}${ext}`;
}

/** Rename a file and remove the subdirectories it leaves empty. */
function moveIntoLibrary(from: string, to: string, libraryPath: string) {
  const fromDir = path.dirname(from);
  fs.renameSync(from, to);
  if (fromDir !== libraryPath) cleanEmptyDirs(fromDir, libraryPath);
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

function findFileInLibrary(dir: string, filename: string): string | null {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findFileInLibrary(fullPath, filename);
        if (found) return found;
      } else if (entry.name === filename) {
        return fullPath;
      }
    }
  } catch {
    // Skip inaccessible directories
  }
  return null;
}

ipcMain.handle(
  "link-unknown-to-track",
  async (_, unknownTrackId: string, targetTrackId: string) => {
    try {
      const tracks = store.get("tracks");
      const libraryPath = store.get("soulseek").libraryPath;

      // Find the unknown track (local file)
      const unknownTrack = tracks.find(
        (t) => t.id === unknownTrackId && t.source === "unknown",
      );
      if (!unknownTrack || !unknownTrack.filePath) {
        return { success: false, error: "Fichier source non trouvé" };
      }

      const targetTrack = findPlaylistTrack(targetTrackId);
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
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Rename file to "Artiste - Titre.ext", suffixing " (n)" on conflicts
      const ext = path.extname(filePath);
      let finalPath = path.join(libraryPath, libraryFilename(targetTrack, ext));
      for (
        let counter = 1;
        finalPath !== filePath && fs.existsSync(finalPath);
        counter++
      ) {
        finalPath = path.join(
          libraryPath,
          libraryFilename(targetTrack, ext, ` (${counter})`),
        );
      }

      if (
        path.normalize(filePath).toLowerCase() !==
        path.normalize(finalPath).toLowerCase()
      ) {
        moveIntoLibrary(filePath, finalPath, libraryPath);
      }

      // Update tracks store: remove unknown track and merge quality info with target track
      const linkedFile = { ...unknownTrack, filePath: finalPath };
      let targetFound = false;
      const updatedTracks = tracks
        .filter((t) => t.id !== unknownTrackId)
        .map((t) => {
          if (t.id !== targetTrackId) return t;
          targetFound = true;
          return withLocalFile(t, linkedFile);
        });

      // If target track wasn't in the store, add it with quality info
      if (!targetFound) {
        updatedTracks.push(withLocalFile(targetTrack, linkedFile));
      }

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
  const allPlaylists = store.get("playlists");
  const removed = allPlaylists.find((p) => p.id === playlistId);
  const playlists = allPlaylists.filter((p) => p.id !== playlistId);
  store.set("playlists", playlists);

  if (removed) {
    // Drop the tracks that only belonged to the removed playlist
    const remainingIds = new Set(playlists.flatMap((p) => p.tracks.map((t) => t.id)));
    const removedIds = new Set(removed.tracks.map((t) => t.id));
    store.set(
      "tracks",
      store.get("tracks").filter((t) => remainingIds.has(t.id) || !removedIds.has(t.id)),
    );
  }

  return playlists;
});

const TRACK_SORTERS: Record<string, (a: Track, b: Track) => number> = {
  title: (a, b) => a.title.localeCompare(b.title),
  artist: (a, b) => a.artist.localeCompare(b.artist),
  duration: (a, b) => a.duration - b.duration,
  recent: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
};

ipcMain.handle("get-tracks", (_, filters: TrackFilters = {}) => {
  let tracks = store.get("tracks");

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

  return tracks.sort(TRACK_SORTERS[filters.sortBy ?? "recent"] ?? TRACK_SORTERS.recent);
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

/** The slskd API client, or an error when the daemon is not running. */
function slskdApi(): SlskdAPI {
  if (!slskdManager?.isRunning) throw new Error("slskd n'est pas démarré");
  return slskdManager.getAPI();
}

ipcMain.handle("slskd-search", (_, query: string) => {
  console.log(`[Search] Starting search for: "${query}"`);
  return slskdApi().search(query);
});

ipcMain.handle("slskd-cancel-search", async (_, searchId: string) => {
  if (slskdManager?.isRunning) await slskdApi().cancelSearch(searchId);
});

ipcMain.handle(
  "slskd-get-search-results",
  (
    _,
    {
      searchId,
      includeFiles = true,
    }: { searchId: string; includeFiles?: boolean },
  ) => slskdApi().getSearchResults(searchId, includeFiles),
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
    await slskdApi().download(username, [{ filename, size }]);
    return true;
  },
);

ipcMain.handle("slskd-get-downloads", () =>
  slskdManager?.isRunning ? slskdApi().getDownloads() : [],
);

ipcMain.handle(
  "slskd-cancel-download",
  async (
    _,
    { username, id, remove }: { username: string; id: string; remove: boolean },
  ) => {
    await slskdApi().cancelDownload(username, id, remove);
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
    await slskdApi().retryDownload(username, id, filename, size);
    return true;
  },
);
