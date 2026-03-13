// ─── Kusic Renderer ─────────────────────────────────────────
// Frontend logic for the Electron app

const api = window.kusic;

// ─── State ──────────────────────────────────────────────────
let currentView = 'tracks';

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
  
  const html = tracks.map((track, i) => {
    return `
    <div class="track-row" data-track-id="${track.id}">
      <span class="track-num">${i + 1}</span>
      <div class="track-title-cell">
        <img class="track-thumb" src="${track.artwork || ''}" alt="" 
          onerror="this.style.display='none'">
        <span class="track-title" title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</span>
      </div>
      <span class="track-artist" title="${escapeHtml(track.artist)}">${escapeHtml(track.artist)}</span>
      <span class="track-album" title="${escapeHtml(track.album || '')}">${escapeHtml(track.album || '—')}</span>
      <span class="track-source">
        <span class="source-badge ${track.source}">${track.source === 'spotify' ? '●  Spotify' : '●  SoundCloud'}</span>
      </span>
      <span class="track-duration">${formatDuration(track.duration)}</span>
      <span class="track-actions">
        <button class="track-download-btn" onclick="openSlskdSearch('${escapeJs(track.artist)}', '${escapeJs(track.title)}')" title="Télécharger via Soulseek">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
          </svg>
        </button>
      </span>
    </div>
  `}).join('');

  trackList.innerHTML = html;
}

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

async function handleRefresh(btn) {
  btn.disabled = true;
  const originalHTML = btn.innerHTML;
  btn.innerHTML = '<svg class="spinner" width="16" height="16" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="30 70"/></svg>';

  try {
    const result = await api.refreshPlaylists();
    showToast(`Playlists rafraîchies (${result.totalTracks} pistes)`, 'success');
    loadPlaylists();
    loadTracks();
    updateStats();
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHTML;
  }
}

$('#btn-refresh-playlists').addEventListener('click', () => handleRefresh($('#btn-refresh-playlists')));
$('#btn-refresh-tracks').addEventListener('click', () => handleRefresh($('#btn-refresh-tracks')));

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
    loadPlaylists();
    loadTracks();
    updateStats();
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
    <div class="playlist-card" data-id="${p.id}">
      <div class="playlist-cover">
        <img src="${p.artwork || ''}" alt="${escapeHtml(p.name)}" 
          onerror="this.parentElement.style.background='var(--bg-tertiary)'">
        <span class="playlist-source-tag ${p.source}">${p.source}</span>
      </div>
      <div class="playlist-info">
        <div class="playlist-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
        <div class="playlist-meta">
          <span class="playlist-track-count">${p.tracks.length} pistes</span>
          <button class="playlist-remove" title="Supprimer" onclick="removePlaylist('${p.id}')">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  `).join('');

  playlistGrid.innerHTML = html;
}

// Expose to onclick
window.removePlaylist = async function(id) {
  if (!confirm('Supprimer cette playlist ?')) return;
  try {
    await api.removePlaylist(id);
    showToast('Playlist supprimée', 'success');
    loadPlaylists();
    loadTracks();
    updateStats();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// ─── Settings View ──────────────────────────────────────────
async function loadSettings() {
  const settings = await api.getSettings();
  $('#spotify-client-id').value = settings.spotify?.clientId || '';
  $('#spotify-client-secret').value = settings.spotify?.clientSecret || '';
  $('#soulseek-username').value = settings.soulseek?.username || '';
  $('#soulseek-password').value = settings.soulseek?.password || '';
  $('#soulseek-library-path').value = settings.soulseek?.libraryPath || '';
  
  // Check platform support first
  await checkPlatformSupport();
  
  // Check slskd binary status
  checkSlskdBinary();
  
  // Refresh slskd status UI when entering settings
  refreshSlskdStatusUI();
}

// Check if platform is supported
async function checkPlatformSupport() {
  const platformInfo = await api.slskd.checkPlatform();
  const slskdSection = document.querySelector('.settings-group:has(#soulseek-username)');
  
  if (!platformInfo.supported) {
    // Show unsupported platform warning
    const warningEl = document.createElement('div');
    warningEl.className = 'platform-warning';
    warningEl.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <span>Soulseek n'est disponible que sur Windows pour le moment. Plateforme détectée: ${platformInfo.platform}</span>
    `;
    slskdSection?.insertBefore(warningEl, slskdSection.firstChild.nextSibling);
    
    // Disable all Soulseek inputs
    $('#soulseek-username').disabled = true;
    $('#soulseek-password').disabled = true;
    $('#btn-browse-library').disabled = true;
    $('#btn-slskd-toggle').disabled = true;
    $('#btn-download-slskd').disabled = true;
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
  
  // Check platform first
  const platformInfo = await api.slskd.checkPlatform();
  if (!platformInfo.supported) {
    statusEl.classList.add('missing');
    textEl.textContent = 'Non disponible sur cette plateforme';
    downloadBtn.style.display = 'none';
    return;
  }
  
  const versionInfo = await api.slskd.getVersion();
  const isInstalled = await api.slskd.checkBinary();
  
  if (isInstalled) {
    statusEl.classList.remove('missing');
    statusEl.classList.add('ready');
    textEl.textContent = `✓ slskd v${versionInfo?.version || '?'} installé`;
    downloadBtn.style.display = 'none';
  } else {
    statusEl.classList.remove('ready');
    statusEl.classList.add('missing');
    textEl.textContent = `slskd v${versionInfo?.version || '0.21.4'} non installé`;
    downloadBtn.style.display = 'inline-flex';
  }
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

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeJs(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

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
  }
});

// ─── Soulseek Download Modal ────────────────────────────────
const slskdModal = $('#slskd-modal');
const slskdResultsList = $('#slskd-results-list');
const slskdLoading = $('#slskd-loading');
const slskdNoResults = $('#slskd-no-results');
const slskdSearchQuery = $('#slskd-search-query');
const slskdSearchStatus = $('#slskd-search-status');

let currentSearchId = null;
let searchPollInterval = null;

window.openSlskdSearch = async function(artist, title) {
  const status = await api.slskd.getStatus();
  if (!status.running) {
    showToast('Démarrez Soulseek dans les paramètres', 'error');
    return;
  }
  
  const query = `${artist} ${title}`.trim();
  slskdSearchQuery.textContent = query;
  slskdSearchStatus.textContent = 'Recherche...';
  slskdLoading.style.display = 'flex';
  slskdNoResults.style.display = 'none';
  slskdResultsList.innerHTML = '';
  slskdResultsList.appendChild(slskdLoading);
  slskdModal.style.display = 'flex';
  
  try {
    const { id } = await api.slskd.search(query);
    currentSearchId = id;
    let lastCount = 0;
    let tick = 0;
    
    searchPollInterval = setInterval(async () => {
      try {
        tick++;
        const loadFiles = tick % 4 === 0;
        const data = await api.slskd.getSearchResults(currentSearchId, loadFiles);
        
        if (data.fileCount > 0) {
          slskdSearchStatus.textContent = `${data.fileCount} fichiers...`;
        }
        
        if (loadFiles && data.results.length > lastCount) {
          lastCount = data.results.length;
          renderSlskdResults(data.results, !data.isComplete);
        }
        
        if (data.isComplete) {
          clearInterval(searchPollInterval);
          searchPollInterval = null;
          // Charger les résultats finaux
          const final = await api.slskd.getSearchResults(currentSearchId, true);
          slskdSearchStatus.textContent = final.results.length > 0 ? `${final.results.length} résultats` : 'Aucun résultat';
          renderSlskdResults(final.results, false);
        }
      } catch (err) {
        clearInterval(searchPollInterval);
        searchPollInterval = null;
      }
    }, 500);
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
    closeSlskdModal();
  }
};

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
  
  const html = results.slice(0, 100).map(r => {
    const name = r.filename.split(/[\\\/]/).pop();
    const ext = r.extension.toUpperCase();
    const cls = ['flac', 'mp3', 'wav'].includes(r.extension) ? r.extension : 'other';
    const quality = [r.bitRate && `${r.bitRate}kbps`, r.sampleRate && `${(r.sampleRate/1000).toFixed(1)}kHz`].filter(Boolean).join(' · ') || '—';
    
    return `<div class="slskd-result-row">
      <span class="result-filename" title="${escapeHtml(r.filename)}">${escapeHtml(name)}</span>
      <span class="result-user">${escapeHtml(r.username)}</span>
      <span class="result-format"><span class="format-badge ${cls}">${ext}</span></span>
      <span class="result-quality">${quality}</span>
      <span class="result-size">${formatSize(r.size)}</span>
      <button class="result-download-btn" onclick="downloadFromSlskd('${escapeJs(r.username)}','${escapeJs(r.filename)}',${r.size},this)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>
    </div>`;
  }).join('');
  
  slskdResultsList.innerHTML = html;
}

window.downloadFromSlskd = async function(username, filename, size, btn) {
  btn.disabled = true;
  btn.innerHTML = '<svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>';
  
  try {
    await api.slskd.download(username, filename, size);
    startDownloadPolling();
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
    btn.style.background = btn.style.borderColor = 'var(--success)';
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    btn.style.background = btn.style.borderColor = 'var(--danger)';
    showToast(`Erreur: ${err.message}`, 'error');
  }
};

function closeSlskdModal() {
  slskdModal.style.display = 'none';
  if (searchPollInterval) {
    clearInterval(searchPollInterval);
    searchPollInterval = null;
  }
  currentSearchId = null;
}

$('#btn-close-slskd-modal').addEventListener('click', closeSlskdModal);
slskdModal.addEventListener('click', (e) => {
  if (e.target === slskdModal) closeSlskdModal();
});

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

  if (transfers.length === 0) {
    downloadViewList.innerHTML = '';
    downloadViewList.appendChild(downloadsEmpty);
    downloadsEmpty.style.display = 'flex';
    return;
  }

  downloadsEmpty.style.display = 'none';
  const sorted = [...active, ...failed.reverse(), ...completed.reverse()];

  downloadViewList.innerHTML = sorted.map(t => {
    const name = t.filename.split(/[\\/]/).pop() || t.filename;
    const stateInfo = getStateDisplay(t.state);
    const pct = Math.round(t.percentComplete);
    const isActive = !isTerminalState(t.state);
    const speed = isActive && t.averageSpeed > 0 ? formatSpeed(t.averageSpeed) : '—';
    const isFailed = isTerminalState(t.state) && !isCompletedOk(t.state);
    const sizeText = isActive
      ? `${formatSize(t.bytesTransferred)} / ${formatSize(t.size)}`
      : formatSize(t.size);

    return `<div class="dl-row ${stateInfo.cls}">
      <span class="dl-col-name" title="${escapeHtml(t.filename)}">${escapeHtml(name)}</span>
      <span class="dl-col-user">${escapeHtml(t.username)}</span>
      <span class="dl-col-size">${sizeText}</span>
      <span class="dl-col-speed">${speed}</span>
      <span class="dl-col-progress">
        ${isActive ? `<div class="dl-progress-bar"><div class="dl-progress-fill" style="width: ${pct}%"></div></div><span class="dl-pct">${pct}%</span>` : ''}
      </span>
      <span class="dl-col-state ${stateInfo.cls}">${stateInfo.label}</span>
      <span class="dl-col-actions">
        ${isActive ? `<button class="dl-action-btn dl-cancel" title="Annuler" onclick="cancelDownload('${escapeJs(t.username)}','${escapeJs(t.id)}',false)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>` : ''}
        ${isFailed ? `<button class="dl-action-btn dl-retry" title="Réessayer" onclick="retryDownload('${escapeJs(t.username)}','${escapeJs(t.id)}','${escapeJs(t.filename)}',${t.size})">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
        </button><button class="dl-action-btn dl-cancel" title="Supprimer" onclick="cancelDownload('${escapeJs(t.username)}','${escapeJs(t.id)}',true)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>` : ''}
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

window.cancelDownload = async function(username, id, remove) {
  try {
    await api.slskd.cancelDownload(username, id, remove);
    pollDownloads();
  } catch (err) {
    console.error('cancelDownload error', err);
    showToast(`Erreur: ${err.message}`, 'error');
  }
};

window.retryDownload = async function(username, id, filename, size) {
  try {
    await api.slskd.retryDownload(username, id, filename, size);
    showToast('Téléchargement relancé');
    pollDownloads();
  } catch (err) {
    showToast(`Erreur: ${err.message}`, 'error');
  }
};

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
