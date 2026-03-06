const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const YTDlpWrap = require('yt-dlp-wrap').default;
const ffmpegPath = require('ffmpeg-static');

class DownloadService extends EventEmitter {
  /**
   * @param {string} libraryPath  – where music files are saved
   * @param {string} dataDir      – where yt-dlp binary lives (app userData)
   */
  constructor(libraryPath, dataDir) {
    super();
    this.libraryPath = libraryPath;
    this.dataDir = dataDir;
    this.ytdlp = null;
    this.queue = [];
    this.activeDownloads = 0;
    this.maxConcurrent = 2;
    this.isReady = false;
    this.cache = {};  // in-memory: trackId → { filePath, title, artist, downloadedAt }
    this.localTracks = []; // files in library without a playlist match
    this._cacheReady = false;
  }

  // ─── In-memory cache (no file on disk) ──────────────────────
  _cacheDownload(trackId, filePath, track) {
    this.cache[trackId] = {
      filePath,
      title: track.title,
      artist: track.artist,
      album: track.album || '',
      source: track.source,
      downloadedAt: Date.now()
    };
  }

  /**
   * Embed the trackId inside the FLAC file's Vorbis comment as KUSIC_TRACK_ID.
   * Uses ffmpeg to copy the file with the added metadata (no re-encoding).
   */
  _embedTrackId(filePath, trackId) {
    return new Promise((resolve, reject) => {
      const tmpPath = filePath + '.tmp.flac';
      execFile(ffmpegPath, [
        '-i', filePath,
        '-metadata', `KUSIC_TRACK_ID=${trackId}`,
        '-codec', 'copy',
        '-y',
        tmpPath
      ], (err) => {
        if (err) {
          // Non-fatal: file works fine, just won't be scannable
          console.error('Failed to embed trackId metadata:', err.message);
          try { fs.unlinkSync(tmpPath); } catch {}
          return resolve();
        }
        try {
          fs.renameSync(tmpPath, filePath);
        } catch (renameErr) {
          console.error('Failed to rename temp file:', renameErr.message);
          try { fs.unlinkSync(tmpPath); } catch {}
        }
        resolve();
      });
    });
  }

  /**
   * Returns a map of trackId → download info for all tracks
   * whose file still exists on disk.
   */
  getDownloadStatuses() {
    const statuses = {};

    for (const [trackId, entry] of Object.entries(this.cache)) {
      if (fs.existsSync(entry.filePath)) {
        statuses[trackId] = {
          downloaded: true,
          filePath: entry.filePath,
          downloadedAt: entry.downloadedAt
        };
      } else {
        // File was deleted externally — remove from cache
        delete this.cache[trackId];
      }
    }

    return statuses;
  }

  // ─── Setup ──────────────────────────────────────────────────
  async ensureReady() {
    if (this.isReady) return;

    // Ensure library folder exists
    if (!fs.existsSync(this.libraryPath)) {
      fs.mkdirSync(this.libraryPath, { recursive: true });
    }

    // Determine yt-dlp binary path (in app's dataDir)
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    const ytdlpBin = path.join(this.dataDir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
    
    if (!fs.existsSync(ytdlpBin)) {
      this.emit('status', { type: 'setup', message: 'Téléchargement de yt-dlp...' });
      try {
        await YTDlpWrap.downloadFromGithub(ytdlpBin);
      } catch (err) {
        throw new Error(`Impossible de télécharger yt-dlp: ${err.message}`);
      }
    }

    this.ytdlp = new YTDlpWrap(ytdlpBin);
    this.isReady = true;
    this.emit('status', { type: 'ready', message: 'yt-dlp prêt' });
  }

  // ─── Search YouTube for a track ─────────────────────────────
  buildSearchQuery(track) {
    // Build a robust search query to find the right track on YouTube
    let query = `${track.artist} - ${track.title}`;
    if (track.source === 'spotify') {
      query += ' audio';
    }
    return query;
  }

  // ─── Download a single track ────────────────────────────────
  async downloadTrack(track) {
    await this.ensureReady();

    // Build filename: Artist - Title.flac
    const safeName = `${track.artist} - ${track.title}`
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    
    const outputPath = path.join(this.libraryPath, `${safeName}.flac`);

    // Skip if already downloaded (check cache first, then file on disk)
    const cacheEntry = this.cache[track.id];
    if (cacheEntry && fs.existsSync(cacheEntry.filePath)) {
      return { 
        trackId: track.id, 
        status: 'exists', 
        path: cacheEntry.filePath,
        message: 'Déjà téléchargé' 
      };
    }

    if (fs.existsSync(outputPath)) {
      this._cacheDownload(track.id, outputPath, track);
      return { 
        trackId: track.id, 
        status: 'exists', 
        path: outputPath,
        message: 'Déjà téléchargé' 
      };
    }

    let downloadUrl;

    if (track.source === 'soundcloud' && track.soundcloudUrl) {
      // SoundCloud: download directly from the permalink URL
      downloadUrl = track.soundcloudUrl;
    } else {
      // Spotify or other: search on YouTube
      downloadUrl = `ytsearch1:${this.buildSearchQuery(track)}`;
    }

    const args = [
      downloadUrl,
      '-x',                          // Extract audio
      '--audio-format', 'flac',      // Convert to FLAC
      '--audio-quality', '0',        // Best quality
      '--ffmpeg-location', ffmpegPath,
      '-o', outputPath,
      '--no-playlist',               // Single track only
      '--embed-thumbnail',           // Embed cover art
      '--add-metadata',              // Add metadata
      '--no-warnings',
      '--no-check-certificates',
    ];

    // Add metadata via postprocessor args
    if (track.title) {
      args.push('--parse-metadata', `${track.title}:%(meta_title)s`);
    }
    if (track.artist) {
      args.push('--parse-metadata', `${track.artist}:%(meta_artist)s`);
    }
    if (track.album) {
      args.push('--parse-metadata', `${track.album}:%(meta_album)s`);
    }

    return new Promise((resolve, reject) => {
      let lastProgress = 0;

      const process = this.ytdlp.exec(args)
        .on('progress', (progress) => {
          if (progress.percent && progress.percent !== lastProgress) {
            lastProgress = progress.percent;
            this.emit('progress', {
              trackId: track.id,
              percent: progress.percent,
              size: progress.totalSize,
              speed: progress.currentSpeed,
              eta: progress.eta
            });
          }
        })
        .on('ytDlpEvent', (eventType, eventData) => {
          // Additional logging if needed
        })
        .on('error', (err) => {
          reject(new Error(`Erreur téléchargement "${track.title}": ${err.message}`));
        })
        .on('close', async () => {
          // Check if file was created  
          let finalPath = null;
          if (fs.existsSync(outputPath)) {
            finalPath = outputPath;
          } else {
            // yt-dlp might add format extension, check for temp files
            const possibleFiles = fs.readdirSync(this.libraryPath)
              .filter(f => f.startsWith(safeName));
            if (possibleFiles.length > 0) {
              finalPath = path.join(this.libraryPath, possibleFiles[0]);
            }
          }

          if (finalPath) {
            // Embed trackId in FLAC metadata for future re-linking
            await this._embedTrackId(finalPath, track.id);
            this._cacheDownload(track.id, finalPath, track);
            resolve({
              trackId: track.id,
              status: 'downloaded',
              path: finalPath,
              message: 'Téléchargé avec succès'
            });
          } else {
            reject(new Error(`Fichier non créé pour "${track.title}"`));
          }
        });
    });
  }

  // ─── Download multiple tracks (queue) ───────────────────────
  async downloadTracks(tracks, onTrackComplete) {
    await this.ensureReady();

    const results = [];
    let completed = 0;
    const total = tracks.length;

    for (const track of tracks) {
      try {
        this.emit('progress', { 
          trackId: track.id, 
          percent: 0, 
          queuePosition: completed + 1,
          queueTotal: total
        });

        const result = await this.downloadTrack(track);
        results.push(result);

        completed++;
        if (onTrackComplete) {
          onTrackComplete(result, completed, total);
        }

        this.emit('track-complete', { result, completed, total });
      } catch (err) {
        const errorResult = {
          trackId: track.id,
          status: 'error',
          message: err.message
        };
        results.push(errorResult);
        completed++;

        if (onTrackComplete) {
          onTrackComplete(errorResult, completed, total);
        }

        this.emit('track-error', { error: err.message, trackId: track.id, completed, total });
      }
    }

    return results;
  }

  // ─── Check yt-dlp version ───────────────────────────────────
  async getVersion() {
    await this.ensureReady();
    try {
      const version = await this.ytdlp.getVersion();
      return version;
    } catch {
      return 'unknown';
    }
  }

  setLibraryPath(newPath) {
    this.libraryPath = newPath;
    this.cache = {};
    this.localTracks = [];
    this._cacheReady = false;
  }

  /**
   * Scan the library folder for audio files, read the embedded KUSIC_TRACK_ID
   * tag, and rebuild the in-memory cache.
   * Files without a KUSIC_TRACK_ID or whose ID is unknown are collected as localTracks.
   * @param {Array} knownTracks – all tracks from the store, for metadata enrichment
   * @returns {{ found: number, total: number, localCount: number }} scan results
   */
  async scanLibrary(knownTracks = []) {
    const mm = await import('music-metadata');

    if (!fs.existsSync(this.libraryPath)) {
      return { found: 0, total: 0, localCount: 0 };
    }

    const files = fs.readdirSync(this.libraryPath)
      .filter(f => /\.(flac|mp3|wav|ogg|m4a|opus)$/i.test(f));

    // Build a lookup map from trackId → track info
    const trackMap = {};
    for (const t of knownTracks) {
      trackMap[t.id] = t;
    }
    const knownIds = new Set(Object.keys(trackMap));

    // Collect existing cached trackIds to know which are truly new
    const alreadyCached = new Set(Object.keys(this.cache));
    let found = 0;
    const orphans = [];

    for (const file of files) {
      const filePath = path.join(this.libraryPath, file);

      try {
        const metadata = await mm.parseFile(filePath, { skipCovers: true });
        const tags = metadata.native;

        // Look for KUSIC_TRACK_ID in vorbis or ID3 tags
        let trackId = null;
        for (const format of Object.values(tags)) {
          for (const tag of format) {
            if (tag.id === 'KUSIC_TRACK_ID' || tag.id === 'TXXX:KUSIC_TRACK_ID') {
              trackId = tag.value;
              break;
            }
          }
          if (trackId) break;
        }

        if (trackId && knownIds.has(trackId)) {
          // Known playlist track — add to download cache
          const knownTrack = trackMap[trackId];
          this.cache[trackId] = {
            filePath,
            title: knownTrack?.title || metadata.common.title || path.basename(file, path.extname(file)),
            artist: knownTrack?.artist || metadata.common.artist || 'Inconnu',
            album: knownTrack?.album || metadata.common.album || '',
            source: knownTrack?.source || 'local',
            downloadedAt: fs.statSync(filePath).mtimeMs
          };
          if (!alreadyCached.has(trackId)) {
            found++;
          }
        } else {
          // Orphan file: no KUSIC_TRACK_ID, or ID not matching any playlist
          const baseName = path.basename(file, path.extname(file));
          const durationMs = metadata.format.duration
            ? Math.round(metadata.format.duration * 1000)
            : 0;
          orphans.push({
            id: `local_${Buffer.from(filePath).toString('base64url')}`,
            source: 'local',
            title: metadata.common.title || baseName,
            artist: metadata.common.artist || 'Inconnu',
            album: metadata.common.album || '',
            artwork: '',
            duration: durationMs,
            filePath,
            addedAt: fs.statSync(filePath).mtimeMs
          });

          // Also mark as downloaded in cache
          const localId = `local_${Buffer.from(filePath).toString('base64url')}`;
          this.cache[localId] = {
            filePath,
            title: metadata.common.title || baseName,
            artist: metadata.common.artist || 'Inconnu',
            album: metadata.common.album || '',
            source: 'local',
            downloadedAt: fs.statSync(filePath).mtimeMs
          };
        }
      } catch (err) {
        console.warn(`Scan: impossible de lire ${file}:`, err.message);
      }
    }

    this.localTracks = orphans;
    this._cacheReady = true;
    return { found, total: files.length, localCount: orphans.length };
  }
}

module.exports = DownloadService;
