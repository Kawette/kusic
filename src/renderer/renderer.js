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
  if (view === 'settings') loadSettings();
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
}

$('#btn-save-settings').addEventListener('click', async () => {
  const settings = {
    spotify: {
      clientId: $('#spotify-client-id').value.trim(),
      clientSecret: $('#spotify-client-secret').value.trim()
    }
  };

  try {
    await api.saveSettings(settings);
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
}

init();
