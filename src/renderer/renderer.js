// ─── Kusic Renderer ─────────────────────────────────────────
// Frontend logic for the Electron app

const api = window.kusic;

// ─── State ──────────────────────────────────────────────────
let currentView = 'tracks';
let completedDownloadIds = new Set();
let currentSearchTrackId = null;  // Track ID being searched for download
let downloadTrackMap = new Map(); // Map download filename -> playlist trackId
let renderedTracks = new Map();   // trackId -> track currently shown in the list

// ─── Shared markup ──────────────────────────────────────────
const ICONS = {
  download: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  retry: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>',
};

function icon(paths, size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${paths}</svg>`;
}

const SOURCE_LABELS = {
  spotify: '●  Spotify',
  soundcloud: '●  SoundCloud',
  local: '●  Local',
  unknown: '●  Inconnu'
};

/** Soulseek query for a track: "Artist Title". */
function trackQuery(track) {
  return `${track.artist} ${track.title}`.trim();
}

// ─── DOM References ─────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const views = {
  tracks: $('#view-tracks'),
  playlists: $('#view-playlists'),
  downloads: $('#view-downloads'),
  settings: $('#view-settings')
};

// ─── Navigation ─────────────────────────────────────────────
$$('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    switchView(view);
  });
});

function switchView(view) {
  const previousView = currentView;
  currentView = view;
  
  // Update nav buttons
  $$('.nav-btn').forEach(b => b.classList.remove('active'));
  $(`.nav-btn[data-view="${view}"]`).classList.add('active');
  
  // Update views
  $$('.view').forEach(v => v.classList.remove('active'));
  views[view].classList.add('active');
  
  // Refresh view data
  if (view === 'tracks') loadTracks();
  if (view === 'playlists') loadPlaylists();
  if (view === 'downloads') {
    startDownloadPolling();
    pollDownloads();
  }
  if (view === 'settings') {
    loadSettings();
    startSettingsPolling();
  }
  
  // Stop settings polling when leaving settings page
  if (previousView === 'settings' && view !== 'settings') {
    stopSettingsPolling();
  }
}

// ─── Tracks View ────────────────────────────────────────────
const searchInput = $('#search-input');
const filterSource = $('#filter-source');
const sortBy = $('#sort-by');
const trackList = $('#track-list');
const tracksEmpty = $('#tracks-empty');

let searchTimeout;

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(loadTracks, 300);
});

filterSource.addEventListener('change', loadTracks);
sortBy.addEventListener('change', loadTracks);

async function loadTracks() {
  const filters = {
    search: searchInput.value,
    source: filterSource.value,
    sortBy: sortBy.value
  };

  try {
    const tracks = await api.getTracks(filters);
    renderTracks(tracks);
    updateStats();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderTracks(tracks) {
  if (tracks.length === 0) {
    trackList.innerHTML = '';
    trackList.appendChild(tracksEmpty);
    tracksEmpty.style.display = 'flex';
    return;
  }

  tracksEmpty.style.display = 'none';
  
  renderedTracks = new Map(tracks.map(t => [t.id, t]));

  const html = tracks.map((track, i) => {
    // Format action content: quality if has local file, download button otherwise
    let actionHtml = '';
    let actionClass = 'track-actions';
    if (track.format) {
      const fmt = track.format.toUpperCase();
      const badgeClass = ['FLAC', 'MP3', 'WAV'].includes(fmt) ? fmt.toLowerCase() : 'other';
      const isLossless = ['FLAC', 'WAV', 'ALAC', 'APE'].includes(fmt);
      let qualityText = '';
      if (isLossless && track.sampleRate) {
        qualityText = `${(track.sampleRate / 1000).toFixed(1)}kHz`;
      } else if (!isLossless && track.bitRate) {
        qualityText = `${track.bitRate}kbps`;
      }
      actionHtml = `<span class="format-badge ${badgeClass}">${fmt}</span>${qualityText ? `<span class="quality-text">${qualityText}</span>` : ''}`;
      actionClass = 'track-actions quality';
    } else {
      const isCached = hasCachedResults(trackQuery(track));
      actionHtml = `
        <button class="track-download-btn${isCached ? ' cached' : ''}" data-action="download" title="${isCached ? 'Résultats en cache' : 'Télécharger via Soulseek'}">
          ${icon(ICONS.download, 16)}
        </button>`;
    }

    const sourceLabel = SOURCE_LABELS[track.source] || SOURCE_LABELS.unknown;

    // Add identify icon for unknown tracks
    const identifyIcon = track.source === 'unknown' ? `
      <span class="identify-icon" data-action="identify" title="Identifier ce morceau">
        ${icon(ICONS.search, 12)}
      </span>` : '';

    return `
    <div class="track-row" data-track-id="${escapeHtml(track.id)}">
      <span class="track-num">${i + 1}</span>
      <div class="track-title-cell">
        <img class="track-thumb" src="${escapeHtml(track.artwork)}" alt="">
        <div class="track-info">
          <span class="track-title" title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</span>
          <span class="track-artist" title="${escapeHtml(track.artist)}">${escapeHtml(track.artist)}</span>
        </div>
      </div>
      <span class="track-album" title="${escapeHtml(track.album || '')}">${escapeHtml(track.album || '—')}</span>
      <span class="track-source">
        <span class="source-badge ${escapeHtml(track.source)}">${sourceLabel}</span>${identifyIcon}
      </span>
      <span class="track-duration">${formatDuration(track.duration)}</span>
      <span class="${actionClass}">${actionHtml}</span>
    </div>
  `}).join('');

  trackList.innerHTML = html;
}

trackList.addEventListener('click', (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;
  const track = renderedTracks.get(actionEl.closest('.track-row')?.dataset.trackId);
  if (!track) return;
  if (actionEl.dataset.action === 'download') openSlskdSearch(track);
  if (actionEl.dataset.action === 'identify') openIdentifyModal(track);
});

// ─── Playlists View ─────────────────────────────────────────
const playlistGrid = $('#playlist-grid');
const playlistsEmpty = $('#playlists-empty');
const addPlaylistModal = $('#add-playlist-modal');
const playlistUrlInput = $('#playlist-url-input');
const addError = $('#add-error');

$('#btn-add-playlist').addEventListener('click', () => {
  addPlaylistModal.style.display = 'flex';
  playlistUrlInput.value = '';
  addError.style.display = 'none';
  playlistUrlInput.focus();
});

function reloadLibraryViews() {
  loadPlaylists();
  loadTracks(); // also refreshes the stats
}

async function handleRefresh(btn) {
  btn.disabled = true;
  const originalHTML = btn.innerHTML;
  btn.innerHTML = '<svg class="spinner" width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="30 70"/></svg>';

  try {
    const result = await api.refreshLibrary();
    const localMsg = result.localTracks > 0 ? `, ${result.localTracks} locales` : '';
    showToast(`Bibliothèque synchronisée (${result.totalTracks} pistes${localMsg})`, 'success');
    reloadLibraryViews();
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHTML;
  }
}

$('#btn-refresh-playlists').addEventListener('click', (e) => handleRefresh(e.currentTarget));
$('#btn-refresh-tracks').addEventListener('click', (e) => handleRefresh(e.currentTarget));

$('#btn-cancel-add').addEventListener('click', closeAddModal);

addPlaylistModal.addEventListener('click', (e) => {
  if (e.target === addPlaylistModal) closeAddModal();
});

function closeAddModal() {
  addPlaylistModal.style.display = 'none';
}

$('#btn-confirm-add').addEventListener('click', addPlaylist);

playlistUrlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addPlaylist();
});

async function addPlaylist() {
  const url = playlistUrlInput.value.trim();
  if (!url) return;

  const btn = $('#btn-confirm-add');
  const btnText = btn.querySelector('.btn-text');
  const btnLoader = btn.querySelector('.btn-loader');

  btn.disabled = true;
  btnText.style.display = 'none';
  btnLoader.style.display = 'inline-flex';
  addError.style.display = 'none';

  try {
    const playlist = await api.addPlaylist(url);
    closeAddModal();
    showToast(`Playlist "${playlist.name}" ajoutée (${playlist.tracks.length} pistes)`, 'success');
    reloadLibraryViews();
  } catch (err) {
    addError.textContent = err.message;
    addError.style.display = 'block';
  } finally {
    btn.disabled = false;
    btnText.style.display = 'inline';
    btnLoader.style.display = 'none';
  }
}

async function loadPlaylists() {
  try {
    const playlists = await api.getPlaylists();
    renderPlaylists(playlists);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderPlaylists(playlists) {
  if (playlists.length === 0) {
    playlistGrid.innerHTML = '';
    playlistGrid.appendChild(playlistsEmpty);
    playlistsEmpty.style.display = 'flex';
    return;
  }

  playlistsEmpty.style.display = 'none';

  const html = playlists.map(p => `
    <div class="playlist-card" data-id="${escapeHtml(p.id)}">
      <div class="playlist-cover">
        <img src="${escapeHtml(p.artwork)}" alt="${escapeHtml(p.name)}">
        <span class="playlist-source-tag ${escapeHtml(p.source)}">${escapeHtml(p.source)}</span>
      </div>
      <div class="playlist-info">
        <div class="playlist-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
        <div class="playlist-meta">
          <span class="playlist-track-count">${p.tracks.length} pistes</span>
          <button class="playlist-remove" title="Supprimer">
            ${icon(ICONS.trash, 16)}
          </button>
        </div>
      </div>
    </div>
  `).join('');

  playlistGrid.innerHTML = html;
}

playlistGrid.addEventListener('click', (e) => {
  if (!e.target.closest('.playlist-remove')) return;
  removePlaylist(e.target.closest('.playlist-card').dataset.id);
});

async function removePlaylist(id) {
  if (!confirm('Supprimer cette playlist ?')) return;
  try {
    await api.removePlaylist(id);
    showToast('Playlist supprimée', 'success');
    reloadLibraryViews();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ─── Settings View ──────────────────────────────────────────
async function loadSettings() {
  const settings = await api.getSettings();
  $('#spotify-client-id').value = settings.spotify?.clientId || '';
  $('#spotify-client-secret').value = settings.spotify?.clientSecret || '';
  $('#soulseek-username').value = settings.soulseek?.username || '';
  $('#soulseek-password').value = settings.soulseek?.password || '';
  $('#soulseek-library-path').value = settings.soulseek?.libraryPath || '';
  
  const platformInfo = await api.slskd.checkPlatform();
  if (platformInfo.supported) {
    checkSlskdBinary();
  } else {
    showUnsupportedPlatform(platformInfo);
  }

  // Refresh slskd status UI when entering settings
  refreshSlskdStatusUI();
}

function showUnsupportedPlatform(platformInfo) {
  $('#slskd-binary-status').classList.add('missing');
  $('#slskd-binary-text').textContent = 'Non disponible sur cette plateforme';
  $('#btn-download-slskd').style.display = 'none';

  const slskdSection = document.querySelector('.settings-group:has(#soulseek-username)');
  if (slskdSection?.querySelector('.platform-warning')) return; // already shown

  const warningEl = document.createElement('div');
  warningEl.className = 'platform-warning';
  warningEl.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
    <span>Soulseek n'est disponible que sur Windows pour le moment. Plateforme détectée: ${escapeHtml(platformInfo.platform)}</span>
  `;
  slskdSection?.insertBefore(warningEl, slskdSection.firstChild.nextSibling);

  // Disable all Soulseek inputs
  for (const sel of ['#soulseek-username', '#soulseek-password', '#btn-browse-library', '#btn-slskd-toggle', '#btn-download-slskd']) {
    $(sel).disabled = true;
  }
}

// Browse for library folder
$('#btn-browse-library').addEventListener('click', async () => {
  const path = await api.browseFolder();
  if (path) {
    $('#soulseek-library-path').value = path;
    onSettingsInput(true);
  }
});

// Check slskd binary
async function checkSlskdBinary() {
  const statusEl = $('#slskd-binary-status');
  const textEl = $('#slskd-binary-text');
  const downloadBtn = $('#btn-download-slskd');

  const versionInfo = await api.slskd.getVersion();
  const version = versionInfo?.version || '?';
  const isInstalled = !!versionInfo?.installed;

  statusEl.classList.toggle('ready', isInstalled);
  statusEl.classList.toggle('missing', !isInstalled);
  textEl.textContent = isInstalled ? `✓ slskd v${version} installé` : `slskd v${version} non installé`;
  downloadBtn.style.display = isInstalled ? 'none' : 'inline-flex';
}

// Download slskd binary
$('#btn-download-slskd').addEventListener('click', async () => {
  const btn = $('#btn-download-slskd');
  const progressBar = $('#slskd-download-progress');
  const progressFill = $('#slskd-download-fill');
  const textEl = $('#slskd-binary-text');
  
  btn.style.display = 'none';
  progressBar.style.display = 'block';
  textEl.textContent = 'Téléchargement en cours...';
  
  // Listen for progress updates
  api.slskd.onDownloadProgress((progress) => {
    progressFill.style.width = `${progress}%`;
    textEl.textContent = `Téléchargement: ${progress}%`;
  });
  
  try {
    await api.slskd.downloadBinary();
    showToast('slskd installé avec succès!', 'success');
    checkSlskdBinary();
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
    btn.style.display = 'inline-flex';
  } finally {
    progressBar.style.display = 'none';
  }
});

// ─── Slskd Settings Page Polling ───────────────────────
let settingsPollingInterval = null;
let slskdStarting = false; // Flag to prevent showing "Non connecté" during startup

// Settings page polling (keeps UI updated while on settings)
function startSettingsPolling() {
  stopSettingsPolling();
  refreshSlskdStatusUI(); // Immediate update
  settingsPollingInterval = setInterval(refreshSlskdStatusUI, 1500);
}

function stopSettingsPolling() {
  if (settingsPollingInterval) {
    clearInterval(settingsPollingInterval);
    settingsPollingInterval = null;
  }
}

// Update UI elements (only called when on settings page)
function updateSlskdStatusUI(status) {
  const indicator = $('#slskd-status-indicator');
  const textEl = $('#slskd-status-text');
  const toggleBtn = $('#btn-slskd-toggle');
  
  if (!indicator || !textEl || !toggleBtn) return;
  
  if (status.connected) {
    slskdStarting = false; // Clear starting flag once connected
    indicator.className = 'status-indicator connected';
    textEl.textContent = 'Connecté';
    toggleBtn.textContent = 'Arrêter';
    toggleBtn.onclick = stopSlskd;
    startDownloadPolling();
  } else if (status.connecting) {
    indicator.className = 'status-indicator running';
    textEl.textContent = 'Connexion au réseau...';
    toggleBtn.textContent = 'Arrêter';
    toggleBtn.onclick = stopSlskd;
  } else if (status.running) {
    indicator.className = 'status-indicator running';
    textEl.textContent = status.state || 'Démarrage...';
    toggleBtn.textContent = 'Arrêter';
    toggleBtn.onclick = stopSlskd;
  } else if (slskdStarting) {
    // During startup, keep showing "Démarrage..." until we get a real status
    indicator.className = 'status-indicator running';
    textEl.textContent = 'Démarrage de slskd...';
    toggleBtn.textContent = 'Arrêter';
    toggleBtn.onclick = stopSlskd;
  } else {
    indicator.className = 'status-indicator';
    textEl.textContent = 'Non connecté';
    toggleBtn.textContent = 'Démarrer';
    toggleBtn.onclick = startSlskd;
    stopDownloadPolling();
  }
}

// Refresh UI when entering settings page
async function refreshSlskdStatusUI() {
  try {
    const status = await api.slskd.getStatus();
    updateSlskdStatusUI(status);
  } catch (err) {
    // Ignore
  }
}

// Start slskd
async function startSlskd() {
  const toggleBtn = $('#btn-slskd-toggle');
  const textEl = $('#slskd-status-text');
  const indicator = $('#slskd-status-indicator');
  
  toggleBtn.disabled = true;
  toggleBtn.textContent = 'Démarrage...';
  indicator.className = 'status-indicator running';
  textEl.textContent = 'Démarrage de slskd...';
  
  // Set starting flag to prevent showing "Non connecté" during startup
  slskdStarting = true;
  
  // Remove restart notice if present
  const notice = $('#slskd-restart-notice');
  if (notice) notice.remove();
  
  try {
    await api.slskd.start();
  } catch (err) {
    slskdStarting = false;
    showToast(`Erreur: ${err.message}`, 'error');
    indicator.className = 'status-indicator error';
    textEl.textContent = `Erreur: ${err.message}`;
    toggleBtn.disabled = false;
    toggleBtn.textContent = 'Démarrer';
    return;
  }
  
  toggleBtn.disabled = false;
}

// Stop slskd
async function stopSlskd() {
  const toggleBtn = $('#btn-slskd-toggle');
  const indicator = $('#slskd-status-indicator');
  const textEl = $('#slskd-status-text');
  
  toggleBtn.disabled = true;
  toggleBtn.textContent = 'Arrêt...';
  slskdStarting = false; // Clear starting flag
  
  try {
    await api.slskd.stop();
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
  }
  
  indicator.className = 'status-indicator';
  textEl.textContent = 'Non connecté';
  toggleBtn.textContent = 'Démarrer';
  toggleBtn.disabled = false;
  toggleBtn.onclick = startSlskd;
}

// Save current settings helper
async function saveCurrentSettings() {
  const settings = {
    spotify: {
      clientId: $('#spotify-client-id').value.trim(),
      clientSecret: $('#spotify-client-secret').value.trim()
    },
    soulseek: {
      username: $('#soulseek-username').value.trim(),
      password: $('#soulseek-password').value.trim(),
      libraryPath: $('#soulseek-library-path').value.trim()
    }
  };
  await api.saveSettings(settings);
  return settings;
}

// Auto-save on input change with debounce
let settingsSaveTimeout = null;
function onSettingsInput(isSoulseek = false) {
  clearTimeout(settingsSaveTimeout);
  settingsSaveTimeout = setTimeout(async () => {
    try {
      await saveCurrentSettings();
      showToast('Paramètres enregistrés', 'success');
      if (isSoulseek) {
        // If slskd is running, notify that a restart is needed
        const status = await api.slskd.getStatus();
        if (status && (status.running || status.connected || status.connecting)) {
          showSlskdRestartNotice();
        }
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }, 1000);
}

function showSlskdRestartNotice() {
  const existing = $('#slskd-restart-notice');
  if (existing) return; // already shown
  
  const bar = $('#slskd-status-bar');
  if (!bar) return;
  
  const notice = document.createElement('div');
  notice.id = 'slskd-restart-notice';
  notice.className = 'slskd-restart-notice';
  notice.innerHTML = `<span>Redémarrer pour appliquer</span>
    <button class="btn-small btn-accent" id="btn-slskd-restart">Redémarrer</button>`;
  bar.parentNode.insertBefore(notice, bar.nextSibling);
  
  $('#btn-slskd-restart').addEventListener('click', async () => {
    notice.remove();
    await stopSlskd();
    // Small delay to let the process fully stop
    setTimeout(() => startSlskd(), 500);
  });
}

// Spotify inputs — auto-save
$('#spotify-client-id').addEventListener('input', () => onSettingsInput(false));
$('#spotify-client-secret').addEventListener('input', () => onSettingsInput(false));

// Soulseek inputs — auto-save + restart notice
$('#soulseek-username').addEventListener('input', () => onSettingsInput(true));
$('#soulseek-password').addEventListener('input', () => onSettingsInput(true));

// ─── Stats ──────────────────────────────────────────────────
async function updateStats() {
  try {
    const stats = await api.getStats();
    $('#stat-tracks').textContent = stats.totalTracks;
    $('#stat-playlists').textContent = stats.totalPlaylists;
  } catch (err) {
    // Ignore stats errors
  }
}

// ─── Toast ──────────────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = $('#toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 200ms ease';
    setTimeout(() => toast.remove(), 200);
  }, 4000);
}

// ─── Utilities ──────────────────────────────────────────────
function formatDuration(ms) {
  if (!ms) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape a value for use in HTML text and quoted attributes. */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Hide images that fail to load (artwork URLs can expire or be blocked by CSP)
document.addEventListener('error', (e) => {
  if (e.target instanceof HTMLImageElement) e.target.style.display = 'none';
}, true);

// ─── Keyboard shortcuts ─────────────────────────────────────
document.addEventListener('keydown', (e) => {
  // Ctrl+F → focus search
  if (e.ctrlKey && e.key === 'f') {
    e.preventDefault();
    switchView('tracks');
    searchInput.focus();
  }
  // Escape → close modal
  if (e.key === 'Escape') {
    closeAddModal();
    closeSlskdModal();
    closeIdentifyModal();
  }
});

// ─── Soulseek Download Modal ────────────────────────────────
const slskdModal = $('#slskd-modal');
const slskdResultsList = $('#slskd-results-list');
const slskdLoading = $('#slskd-loading');
const slskdNoResults = $('#slskd-no-results');
const slskdSearchQuery = $('#slskd-search-query');
const slskdSearchStatus = $('#slskd-search-status');

let searchPollInterval = null;
let foregroundSearch = null; // { query, pollFn } of the search shown in the modal
let slskdResults = []; // results currently rendered in the modal

// ─── Search Cache ───────────────────────────────────────────
const SEARCH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const searchCache = new Map(); // normalizedQuery -> { results, timestamp }
const backgroundSearches = new Map(); // normalizedQuery -> { searchId, interval }

function normalizeQuery(query) {
  return query.toLowerCase().trim().replace(/\s+/g, ' ');
}

function getCachedResults(query) {
  const key = normalizeQuery(query);
  const cached = searchCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.timestamp > SEARCH_CACHE_TTL) {
    searchCache.delete(key);
    return null;
  }
  return { results: cached.results, timestamp: cached.timestamp };
}

function setCachedResults(query, results) {
  const key = normalizeQuery(query);
  const isNew = !searchCache.has(key);
  searchCache.set(key, { results, timestamp: Date.now() });
  // Refresh track list to update cache indicators
  if (isNew && currentView === 'tracks') {
    loadTracks();
  }
}

function hasCachedResults(query) {
  return getCachedResults(query) !== null;
}

function formatCacheTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// ─── Auto Search ────────────────────────────────────────────
const AUTO_SEARCH_MAX_CONCURRENT = 3;
const AUTO_SEARCH_DELAY = 5000; // 5s between searches

let autoSearchActive = false;
let autoSearchQueue = [];
let autoSearchRunning = 0;
let autoSearchCompleted = 0;
let autoSearchTotal = 0;
let autoSearchInFlight = new Map(); // query -> searchId, tracks currently being searched
let autoSearchTimers = []; // pending setTimeout IDs for staggered launches

const autoSearchBtn = $('#btn-auto-search');
const autoSearchStatus = $('#auto-search-status');
const autoSearchText = $('#auto-search-text');

autoSearchBtn.addEventListener('click', toggleAutoSearch);

async function toggleAutoSearch() {
  if (autoSearchActive) {
    stopAutoSearch();
  } else {
    await startAutoSearch();
  }
}

async function startAutoSearch() {
  // Check if slskd is running
  const status = await api.slskd.getStatus();
  if (!status.running) {
    showToast('Démarrez Soulseek dans les paramètres', 'error');
    return;
  }
  
  // Get all tracks without local files and not in cache
  const tracks = await api.getTracks({ source: 'all' });
  const tracksToSearch = tracks.filter(t => {
    if (t.format) return false; // Has local file
    if (t.source !== 'spotify' && t.source !== 'soundcloud') return false;
    const query = trackQuery(t);
    if (hasCachedResults(query)) return false;
    // Skip queries already in flight from a previous run
    if (autoSearchInFlight.has(normalizeQuery(query))) return false;
    return true;
  });
  
  if (tracksToSearch.length === 0 && autoSearchInFlight.size === 0) {
    showToast('Toutes les pistes sont déjà en cache', 'success');
    return;
  }
  
  autoSearchActive = true;
  autoSearchQueue = tracksToSearch.map(t => ({ query: trackQuery(t) }));
  autoSearchRunning = autoSearchInFlight.size; // Count already in-flight
  autoSearchCompleted = 0;
  autoSearchTotal = autoSearchQueue.length + autoSearchInFlight.size;
  
  autoSearchBtn.classList.add('active');
  autoSearchText.textContent = 'Stop';
  updateAutoSearchStatus();
  
  // Stagger initial batch with 5s between each launch
  const toLaunch = Math.min(AUTO_SEARCH_MAX_CONCURRENT - autoSearchInFlight.size, autoSearchQueue.length);
  for (let i = 0; i < toLaunch; i++) {
    const timer = setTimeout(() => processNextAutoSearch(), i * AUTO_SEARCH_DELAY);
    autoSearchTimers.push(timer);
  }
}

function stopAutoSearch() {
  autoSearchActive = false;
  autoSearchQueue = [];
  // Clear pending launch timers
  for (const t of autoSearchTimers) clearTimeout(t);
  autoSearchTimers = [];
  autoSearchBtn.classList.remove('active');
  autoSearchText.textContent = 'Recherche auto';
  autoSearchStatus.textContent = '';
  showToast(`Recherche arrêtée (${autoSearchCompleted}/${autoSearchTotal})`, 'info');
  // Note: in-flight searches keep running in background, autoSearchInFlight is preserved
}

function updateAutoSearchStatus() {
  if (autoSearchActive) {
    autoSearchStatus.textContent = `${autoSearchCompleted}/${autoSearchTotal}`;
  }
}

async function processNextAutoSearch() {
  if (!autoSearchActive || autoSearchQueue.length === 0) {
    if (autoSearchRunning === 0 && autoSearchActive) {
      // All done
      autoSearchActive = false;
      autoSearchBtn.classList.remove('active');
      autoSearchStatus.textContent = '';
      autoSearchText.textContent = 'Recherche auto';
      showToast(`Recherche terminée (${autoSearchCompleted} pistes)`, 'success');
      loadTracks(); // Refresh to show cache indicators
    }
    return;
  }
  
  const track = autoSearchQueue.shift();
  const key = normalizeQuery(track.query);
  
  // Skip if already in flight (safety check)
  if (autoSearchInFlight.has(key)) {
    processNextAutoSearch();
    return;
  }
  
  autoSearchRunning++;
  
  try {
    const { id } = await api.slskd.search(track.query);
    autoSearchInFlight.set(key, id);
    
    // Poll until complete
    await pollAutoSearch(id, track.query);
    
  } catch (err) {
    console.error('Auto search error:', err);
  }
  
  autoSearchInFlight.delete(key);
  autoSearchRunning--;
  autoSearchCompleted++;
  updateAutoSearchStatus();
  
  // Wait 5s then start next search
  if (autoSearchActive) {
    const timer = setTimeout(() => processNextAutoSearch(), AUTO_SEARCH_DELAY);
    autoSearchTimers.push(timer);
  }
}

async function pollAutoSearch(searchId, query) {
  return new Promise((resolve) => {
    const poll = setInterval(async () => {
      try {
        const data = await api.slskd.getSearchResults(searchId, true);
        
        if (data.results.length > 0) {
          setCachedResults(query, data.results);
        }
        
        if (data.isComplete) {
          clearInterval(poll);
          resolve();
        }
      } catch (err) {
        clearInterval(poll);
        resolve();
      }
    }, 1000);
  });
}

async function openSlskdSearch(track) {
  const status = await api.slskd.getStatus();
  if (!status.running) {
    showToast('Démarrez Soulseek dans les paramètres', 'error');
    return;
  }

  // Store the trackId for linking when download starts
  currentSearchTrackId = track.id;

  const query = trackQuery(track);
  slskdSearchQuery.value = query;
  slskdModal.style.display = 'flex';

  executeSlskdSearch(query);
}

const slskdSearchBtn = $('#slskd-search-btn');
let isSearching = false;

// Event listeners for manual search
function submitManualSearch() {
  const query = slskdSearchQuery.value.trim();
  if (query) executeSlskdSearch(query);
}

slskdSearchBtn.addEventListener('click', submitManualSearch);
slskdSearchQuery.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitManualSearch();
});

async function executeSlskdSearch(query) {
  // Block if already searching
  if (isSearching) return;
  
  // Check cache first
  const cached = getCachedResults(query);
  if (cached) {
    slskdLoading.style.display = 'none';
    slskdNoResults.style.display = 'none';
    slskdSearchStatus.textContent = `${cached.results.length} résultats · ${formatCacheTime(cached.timestamp)}`;
    renderSlskdResults(cached.results, false);
    return;
  }
  
  // Check if there's a background search for this query
  const key = normalizeQuery(query);
  if (backgroundSearches.has(key)) {
    // Wait for background search - show loading, results will come via cache
    slskdSearchStatus.textContent = 'Recherche en cours...';
    slskdLoading.style.display = 'flex';
    return;
  }
  
  isSearching = true;
  slskdSearchBtn.disabled = true;
  
  slskdSearchStatus.textContent = 'Recherche...';
  slskdLoading.style.display = 'flex';
  slskdNoResults.style.display = 'none';
  slskdResultsList.innerHTML = '';
  slskdResultsList.appendChild(slskdLoading);
  
  try {
    const { id } = await api.slskd.search(query);
    let lastCount = 0;
    let tick = 0;
    let hasFiles = false;

    // Stop whichever interval (foreground or background) is polling this search
    const stopPolling = (isBackground) => {
      const bgKey = normalizeQuery(query);
      const bg = backgroundSearches.get(bgKey);
      if (bg) {
        clearInterval(bg.interval);
        backgroundSearches.delete(bgKey);
      }
      if (!isBackground && searchPollInterval) {
        clearInterval(searchPollInterval);
        searchPollInterval = null;
        isSearching = false;
        slskdSearchBtn.disabled = false;
      }
    };

    const pollFn = async (isBackground = false) => {
      try {
        tick++;
        // Load files every 2 ticks (1s) once we know there are files, or check every 4 ticks initially
        const loadFiles = hasFiles ? (tick % 2 === 0) : (tick % 4 === 0);
        const data = await api.slskd.getSearchResults(id, loadFiles);
        
        if (data.fileCount > 0) {
          hasFiles = true;
          if (!isBackground) {
            slskdSearchStatus.textContent = `${data.fileCount} fichiers...`;
          }
        }
        
        if (loadFiles && data.results.length > lastCount) {
          lastCount = data.results.length;
          if (!isBackground) {
            renderSlskdResults(data.results, !data.isComplete);
          }
          // Cache intermediate results
          if (data.results.length > 0) {
            setCachedResults(query, data.results);
          }
        }
        
        if (data.isComplete) {
          stopPolling(isBackground);
          // Cache final results
          const final = await api.slskd.getSearchResults(id, true);
          if (final.results.length > 0) {
            setCachedResults(query, final.results);
          }
          if (!isBackground) {
            slskdSearchStatus.textContent = final.results.length > 0 ? `${final.results.length} résultats` : 'Aucun résultat';
            renderSlskdResults(final.results, false);
          }
        }
      } catch {
        stopPolling(isBackground);
      }
    };

    searchPollInterval = setInterval(() => pollFn(false), 500);
    // Kept so closing the modal can move the polling to the background
    foregroundSearch = { query, pollFn };
    
  } catch (err) {
    isSearching = false;
    slskdSearchBtn.disabled = false;
    showToast(`Erreur: ${err.message}`, 'error');
    closeSlskdModal();
  }
}

function renderSlskdResults(results, searching = false) {
  slskdLoading.style.display = 'none';
  
  if (!results || results.length === 0) {
    if (!searching) {
      slskdNoResults.style.display = 'flex';
      slskdResultsList.innerHTML = '';
      slskdResultsList.appendChild(slskdNoResults);
    }
    return;
  }
  
  slskdNoResults.style.display = 'none';

  slskdResults = results.slice(0, 100);
  const html = slskdResults.map((r, i) => {
    const name = r.filename.split(/[\\\/]/).pop();
    const ext = escapeHtml(r.extension.toUpperCase());
    const cls = ['flac', 'mp3', 'wav'].includes(r.extension) ? r.extension : 'other';
    const quality = [r.bitRate && `${r.bitRate}kbps`, r.sampleRate && `${(r.sampleRate/1000).toFixed(1)}kHz`].filter(Boolean).join(' · ') || '—';
    
    return `<div class="slskd-result-row">
      <span class="result-filename" title="${escapeHtml(r.filename)}">${escapeHtml(name)}</span>
      <span class="result-user">${escapeHtml(r.username)}</span>
      <span class="result-format"><span class="format-badge ${cls}">${ext}</span></span>
      <span class="result-quality">${quality}</span>
      <span class="result-size">${formatSize(r.size)}</span>
      <button class="result-download-btn" data-index="${i}">${icon(ICONS.download, 14)}</button>
    </div>`;
  }).join('');
  
  slskdResultsList.innerHTML = html;
}

slskdResultsList.addEventListener('click', (e) => {
  const btn = e.target.closest('.result-download-btn');
  if (btn) downloadFromSlskd(slskdResults[btn.dataset.index], btn);
});

async function downloadFromSlskd({ username, filename, size }, btn) {
  btn.disabled = true;
  btn.innerHTML = '<svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>';
  
  try {
    // Store mapping between filename and playlist trackId for tagging after completion
    if (currentSearchTrackId) {
      const basename = filename.split(/[\\/]/).pop();
      downloadTrackMap.set(basename, currentSearchTrackId);
    }
    
    await api.slskd.download(username, filename, size);
    startDownloadPolling();
    btn.innerHTML = icon(ICONS.check, 14);
    btn.style.background = btn.style.borderColor = 'var(--success)';
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = icon(ICONS.close, 14);
    btn.style.background = btn.style.borderColor = 'var(--danger)';
    showToast(`Erreur: ${err.message}`, 'error');
  }
}

function closeSlskdModal() {
  slskdModal.style.display = 'none';
  
  // Move current search to background instead of stopping it
  if (searchPollInterval && foregroundSearch) {
    const { query, pollFn } = foregroundSearch;
    const key = normalizeQuery(query);
    
    // Stop foreground interval
    clearInterval(searchPollInterval);
    searchPollInterval = null;
    
    // Start background interval
    const bgInterval = setInterval(() => pollFn(true), 500);
    backgroundSearches.set(key, { interval: bgInterval });

    foregroundSearch = null;
  }

  currentSearchTrackId = null;
  // Reset search state to allow new searches
  isSearching = false;
  slskdSearchBtn.disabled = false;
}

$('#btn-close-slskd-modal').addEventListener('click', closeSlskdModal);

// ─── Identify Modal ─────────────────────────────────────────
const identifyModal = $('#identify-modal');
const identifySearchInput = $('#identify-search-input');
const identifyResultsList = $('#identify-results-list');
const identifySourceTitle = $('#identify-source-title');
let identifySourceTrackId = null; // The unknown track to identify

const IDENTIFY_HINT = '<p class="identify-hint">Recherchez un morceau de votre bibliothèque pour l\'associer à ce fichier.</p>';

function openIdentifyModal(track) {
  identifySourceTrackId = track.id;
  identifySourceTitle.textContent = `${track.title} - ${track.artist}`;
  identifySearchInput.value = '';
  identifyResultsList.innerHTML = IDENTIFY_HINT;
  identifyModal.style.display = 'flex';
  identifySearchInput.focus();
}

function closeIdentifyModal() {
  identifyModal.style.display = 'none';
  identifySourceTrackId = null;
}

$('#btn-close-identify-modal').addEventListener('click', closeIdentifyModal);

identifySearchInput.addEventListener('input', async (e) => {
  const query = e.target.value.trim().toLowerCase();
  if (query.length < 2) {
    identifyResultsList.innerHTML = IDENTIFY_HINT;
    return;
  }
  
  // Get all playlist tracks (not unknown ones)
  const tracks = await api.getTracks({ source: 'all' });
  const playlistTracks = tracks.filter(t => t.source === 'spotify' || t.source === 'soundcloud');
  
  // Filter by search query
  const results = playlistTracks.filter(t => 
    t.title.toLowerCase().includes(query) || 
    t.artist.toLowerCase().includes(query) ||
    (t.album && t.album.toLowerCase().includes(query))
  ).slice(0, 20);
  
  if (results.length === 0) {
    identifyResultsList.innerHTML = '<p class="identify-hint">Aucun résultat</p>';
    return;
  }
  
  identifyResultsList.innerHTML = results.map(t => `
    <div class="identify-result-row" data-target-id="${escapeHtml(t.id)}">
      <img class="identify-result-thumb" src="${escapeHtml(t.artwork)}" alt="">
      <div class="identify-result-info">
        <span class="identify-result-title">${escapeHtml(t.title)}</span>
        <span class="identify-result-artist">${escapeHtml(t.artist)}</span>
      </div>
      <span class="source-badge ${t.source}">${SOURCE_LABELS[t.source]}</span>
      <span class="linking-spinner"></span>
    </div>
  `).join('');
});

identifyResultsList.addEventListener('click', (e) => {
  const row = e.target.closest('.identify-result-row');
  if (row) linkToTrack(row);
});

async function linkToTrack(row) {
  if (!identifySourceTrackId) return;

  row.classList.add('linking');
  row.style.pointerEvents = 'none';

  let error;
  try {
    const result = await api.linkUnknownToTrack(identifySourceTrackId, row.dataset.targetId);
    if (result.success) {
      showToast('Morceau identifié et lié avec succès', 'success');
      closeIdentifyModal();
      loadTracks();
      return;
    }
    error = result.error;
  } catch (err) {
    error = err.message;
  }
  row.classList.remove('linking');
  row.style.pointerEvents = '';
  showToast(`Erreur: ${error}`, 'error');
}

function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ─── Downloads View ─────────────────────────────────────────
const downloadViewList = $('#download-view-list');
const downloadsEmpty = $('#downloads-empty');
const downloadsSummary = $('#downloads-summary');
const navDownloadBadge = $('#nav-download-badge');
let downloadPollInterval = null;
let renderedTransfers = []; // transfers currently shown, indexed by row

function startDownloadPolling() {
  if (downloadPollInterval) return;
  downloadPollInterval = setInterval(pollDownloads, 2000);
}

function stopDownloadPolling() {
  if (downloadPollInterval) {
    clearInterval(downloadPollInterval);
    downloadPollInterval = null;
  }
}

async function pollDownloads() {
  try {
    const data = await api.slskd.getDownloads();
    const transfers = flattenTransfers(data);
    renderDownloadsView(transfers);
    
    // Check for newly completed downloads
    const currentCompleted = transfers.filter(t => isTerminalState(t.state) && isCompletedOk(t.state));
    let hasNewCompletion = false;
    for (const t of currentCompleted) {
      if (!completedDownloadIds.has(t.id)) {
        completedDownloadIds.add(t.id);
        hasNewCompletion = true;
        
        // Tag the downloaded file with playlist metadata
        const basename = t.filename.split(/[\\/]/).pop();
        const trackId = downloadTrackMap.get(basename);
        if (trackId) {
          try {
            const result = await api.tagDownloadedFile(basename, trackId);
            if (result.success) {
              console.log(`[Kusic] Tagged ${basename} with track ${trackId}`);
            } else {
              console.warn(`[Kusic] Failed to tag ${basename}: ${result.error}`);
            }
          } catch (err) {
            console.error(`[Kusic] Error tagging ${basename}:`, err);
          }
          downloadTrackMap.delete(basename);
        }
      }
    }
    
    // Refresh track list if new downloads completed
    if (hasNewCompletion) {
      await api.refreshLibrary();
      loadTracks();
    }
  } catch {
    // slskd not running
  }
}

function flattenTransfers(users) {
  const transfers = [];
  for (const user of users) {
    const username = user.username || '';
    for (const dir of user.directories || []) {
      for (const file of dir.files || []) {
        transfers.push({
          username,
          id: file.id || '',
          filename: file.filename || '',
          state: file.state || '',
          size: file.size || 0,
          bytesTransferred: file.bytesTransferred || 0,
          percentComplete: file.percentComplete || 0,
          averageSpeed: file.averageSpeed || 0,
          elapsedTime: file.elapsedTime || '',
        });
      }
    }
  }
  return transfers;
}

function renderDownloadsView(transfers) {
  const active = transfers.filter(t => !isTerminalState(t.state));
  const completed = transfers.filter(t => isTerminalState(t.state) && isCompletedOk(t.state));
  const failed = transfers.filter(t => isTerminalState(t.state) && !isCompletedOk(t.state));

  // Update nav badge
  navDownloadBadge.textContent = active.length;
  navDownloadBadge.style.display = active.length > 0 ? 'inline-flex' : 'none';

  // Summary bar
  const completedCount = completed.length + failed.length;
  downloadsSummary.innerHTML = `
    <div class="dl-summary-item">
      <span class="dl-summary-value state-active">${active.length}</span>
      <span class="dl-summary-label">En cours</span>
    </div>
    <div class="dl-summary-item">
      <span class="dl-summary-value state-done">${completed.length}</span>
      <span class="dl-summary-label">Terminés</span>
    </div>
    <div class="dl-summary-item">
      <span class="dl-summary-value state-error">${failed.length}</span>
      <span class="dl-summary-label">Échoués</span>
    </div>
  `;

  // Show/hide clear button
  const clearBtn = document.getElementById('dl-clear-btn');
  if (clearBtn) clearBtn.style.display = completed.length > 0 ? 'inline-flex' : 'none';

  if (transfers.length === 0) {
    downloadViewList.innerHTML = '';
    downloadViewList.appendChild(downloadsEmpty);
    downloadsEmpty.style.display = 'flex';
    return;
  }

  downloadsEmpty.style.display = 'none';
  renderedTransfers = [...active, ...failed.reverse(), ...completed.reverse()];

  downloadViewList.innerHTML = renderedTransfers.map((t, i) => {
    const name = t.filename.split(/[\\/]/).pop() || t.filename;
    const stateInfo = getStateDisplay(t.state);
    const pct = Math.round(t.percentComplete);
    const isActive = !isTerminalState(t.state);
    const speed = isActive && t.averageSpeed > 0 ? formatSpeed(t.averageSpeed) : '—';
    const isFailed = isTerminalState(t.state) && !isCompletedOk(t.state);
    const sizeText = isActive
      ? `${formatSize(t.bytesTransferred)} / ${formatSize(t.size)}`
      : formatSize(t.size);

    return `<div class="dl-row ${stateInfo.cls}" data-index="${i}">
      <span class="dl-col-name" title="${escapeHtml(t.filename)}">${escapeHtml(name)}</span>
      <span class="dl-col-user">${escapeHtml(t.username)}</span>
      <span class="dl-col-size">${sizeText}</span>
      <span class="dl-col-progress">
        ${isActive ? `<span class="dl-speed">${speed}</span><div class="dl-progress-bar"><div class="dl-progress-fill" style="width: ${pct}%"></div></div><span class="dl-pct">${pct}%</span>` : ''}
      </span>
      <span class="dl-col-state ${stateInfo.cls}">${escapeHtml(stateInfo.label)}</span>
      <span class="dl-col-actions">
        ${isActive ? `<button class="dl-action-btn dl-cancel" title="Annuler" data-action="cancel">${icon(ICONS.close, 14)}</button>` : ''}
        ${isFailed ? `<button class="dl-action-btn dl-retry" title="Réessayer" data-action="retry">${icon(ICONS.retry, 14)}</button><button class="dl-action-btn dl-cancel" title="Supprimer" data-action="remove">${icon(ICONS.close, 14)}</button>` : ''}
      </span>
    </div>`;
  }).join('');
}

function isTerminalState(state) {
  if (!state) return false;
  const s = state.toLowerCase().replace(/[^a-z,]/g, '');
  return s.includes('completed') || s.includes('errored') || s.includes('cancelled');
}

function isCompletedOk(state) {
  if (!state) return false;
  const s = state.toLowerCase();
  return s.includes('completed') && !s.includes('aborted') && !s.includes('errored') && !s.includes('cancelled');
}

function getStateDisplay(state) {
  if (!state) return { label: '?', cls: '' };
  const s = state.toLowerCase();
  if (s.includes('cancelled')) return { label: 'Annulé', cls: 'state-error' };
  if (s.includes('completed') && !s.includes('aborted') && !s.includes('errored')) return { label: 'Terminé', cls: 'state-done' };
  if (s.includes('errored') || s.includes('aborted')) return { label: 'Erreur', cls: 'state-error' };
  if (s.includes('inprogress') || s.includes('in progress') || s.includes('initializing')) return { label: 'En cours', cls: 'state-active' };
  if (s.includes('queued') && s.includes('remote')) return { label: 'File distante', cls: 'state-queued' };
  if (s.includes('queued') && s.includes('local')) return { label: 'File locale', cls: 'state-queued' };
  if (s.includes('queued')) return { label: 'En attente', cls: 'state-queued' };
  if (s.includes('requested')) return { label: 'Demandé', cls: 'state-queued' };
  return { label: state, cls: '' };
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

downloadViewList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]');
  const t = btn && renderedTransfers[btn.closest('.dl-row').dataset.index];
  if (!t) return;
  if (btn.dataset.action === 'cancel') cancelDownload(t, false);
  if (btn.dataset.action === 'remove') cancelDownload(t, true);
  if (btn.dataset.action === 'retry') retryDownload(t);
});

async function cancelDownload({ username, id }, remove) {
  try {
    await api.slskd.cancelDownload(username, id, remove);
    pollDownloads();
  } catch (err) {
    console.error('cancelDownload error', err);
    showToast(`Erreur: ${err.message}`, 'error');
  }
}

async function retryDownload({ username, id, filename, size }) {
  try {
    await api.slskd.retryDownload(username, id, filename, size);
    showToast('Téléchargement relancé');
    pollDownloads();
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
  }
}

$('#dl-clear-btn').addEventListener('click', async () => {
  try {
    const data = await api.slskd.getDownloads();
    const transfers = flattenTransfers(data);
    const succeeded = transfers.filter(t => isTerminalState(t.state) && isCompletedOk(t.state));
    await Promise.all(succeeded.map(t => api.slskd.cancelDownload(t.username, t.id, true)));
    pollDownloads();
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
  }
});

// ─── External links ─────────────────────────────────────────
const spotifyDevLink = $('#link-spotify-dev');
if (spotifyDevLink) {
  spotifyDevLink.addEventListener('click', (e) => {
    e.preventDefault();
    api.openExternal('https://developer.spotify.com/dashboard');
  });
}

// ─── Init ───────────────────────────────────────────────────
async function init() {
  await loadTracks();
  await updateStats();
  // Start polling downloads if slskd is running
  try {
    const status = await api.slskd.getStatus();
    if (status && status.connected) startDownloadPolling();
  } catch {}
}

init();
