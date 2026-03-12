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
  if (view === 'settings') {
    loadSettings();
    startSettingsPolling(); // Start UI polling when entering settings
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
        <button class="track-download-btn" onclick="openSlskdSearch('${escapeHtml(track.artist)}', '${escapeHtml(track.title)}')" title="Télécharger via Soulseek">
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
  
  try {
    // Save settings first
    await saveCurrentSettings();
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

$('#btn-save-settings').addEventListener('click', async () => {
  try {
    await saveCurrentSettings();
    const saved = $('#settings-saved');
    saved.style.display = 'block';
    setTimeout(() => saved.style.display = 'none', 3000);
    showToast('Paramètres sauvegardés', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

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

// Open Soulseek search modal
window.openSlskdSearch = async function(artist, title) {
  // Check if slskd is running
  const status = await api.slskd.getStatus();
  if (!status.running) {
    showToast('Démarrez Soulseek dans les paramètres d\'abord', 'error');
    return;
  }
  
  const query = `${artist} ${title}`.trim();
  slskdSearchQuery.textContent = query;
  slskdSearchStatus.textContent = 'Recherche en cours...';
  slskdLoading.style.display = 'flex';
  slskdNoResults.style.display = 'none';
  slskdResultsList.innerHTML = '';
  slskdResultsList.appendChild(slskdLoading);
  
  slskdModal.style.display = 'flex';
  
  try {
    // Start search
    const searchResult = await api.slskd.search(query);
    currentSearchId = searchResult.id;
    
    // Display initial results
    renderSlskdResults(searchResult.results);
    
    // Poll for more results
    let pollCount = 0;
    searchPollInterval = setInterval(async () => {
      pollCount++;
      if (pollCount > 10) { // Stop after 10 polls (30 seconds total)
        clearInterval(searchPollInterval);
        slskdSearchStatus.textContent = `${getCurrentResultCount()} résultats`;
        return;
      }
      
      try {
        const results = await api.slskd.getSearchResults(currentSearchId);
        renderSlskdResults(results);
        slskdSearchStatus.textContent = `${getCurrentResultCount()} résultats (recherche en cours...)`;
      } catch (err) {
        console.error('Poll error:', err);
      }
    }, 3000);
    
  } catch (err) {
    showToast(`Erreur de recherche: ${err.message}`, 'error');
    closeSlskdModal();
  }
};

function getCurrentResultCount() {
  return slskdResultsList.querySelectorAll('.slskd-result-row').length;
}

function renderSlskdResults(results) {
  slskdLoading.style.display = 'none';
  
  if (!results || results.length === 0) {
    if (getCurrentResultCount() === 0) {
      slskdNoResults.style.display = 'flex';
      slskdResultsList.appendChild(slskdNoResults);
    }
    return;
  }
  
  slskdNoResults.style.display = 'none';
  slskdSearchStatus.textContent = `${results.length} résultats`;
  
  const html = results.slice(0, 100).map((result, i) => {
    const filename = result.filename.split('\\').pop().split('/').pop();
    const ext = result.extension.toUpperCase();
    const formatClass = ['flac', 'mp3', 'wav'].includes(result.extension) ? result.extension : 'other';
    const sizeStr = formatSize(result.size);
    const bitrateStr = result.bitRate ? `${result.bitRate}kbps` : '';
    
    return `
    <div class="slskd-result-row" data-index="${i}">
      <span class="result-filename" title="${escapeHtml(result.filename)}">${escapeHtml(filename)}</span>
      <span class="result-user" title="${escapeHtml(result.username)}">${escapeHtml(result.username)}</span>
      <span class="result-format">
        <span class="format-badge ${formatClass}">${ext}</span>
        ${bitrateStr ? `<span style="font-size:10px;color:var(--text-muted)">${bitrateStr}</span>` : ''}
      </span>
      <span class="result-size">${sizeStr}</span>
      <button class="result-download-btn" onclick="downloadFromSlskd('${escapeHtml(result.username)}', '${escapeHtml(result.filename.replace(/'/g, "\\'"))}', this)">
        Télécharger
      </button>
    </div>
  `}).join('');
  
  slskdResultsList.innerHTML = html;
}

// Download from Soulseek
window.downloadFromSlskd = async function(username, filename, btn) {
  btn.disabled = true;
  btn.textContent = '...';
  
  try {
    await api.slskd.download(username, filename);
    btn.textContent = '✓';
    btn.style.background = 'var(--success)';
    showToast('Téléchargement lancé!', 'success');
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Erreur';
    btn.style.background = 'var(--danger)';
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
}

init();
