// ─── Tracks view ────────────────────────────────────────────

import {
  $, api, bus, errorMessage, escapeHtml, formatBadge, formatDuration, formatSize, icon, ICONS,
  isLossless, qualityLabel, showMenu, showToast, SOURCE_LABELS, SPINNER, toastError, withBusyButton,
} from './ui.js';
import { cachedCount, isSearching, openSearch, toggleAutoSearch } from './search.js';
import { isFinished, transferForTrack } from './downloads.js';
import { openIdentify } from './identify.js';
import { isPlaying, playTrack } from './player.js';

const searchInput = $('#search-input');
const filterSource = $('#filter-source');
const filterPlaylist = $('#filter-playlist');
const sortBy = $('#sort-by');
const trackList = $('#track-list');
const emptyState = $('#tracks-empty');

let tracks = [];
let byId = new Map();
const statusCache = new Map(); // trackId -> rendered status html
let loadToken = 0;

async function findTrack(id) {
  return byId.get(id) || (await api.getTracks({ source: 'all' })).find((t) => t.id === id);
}

export async function loadTracks() {
  const token = ++loadToken;
  try {
    const result = await api.getTracks({
      search: searchInput.value,
      source: filterSource.value,
      playlistId: filterPlaylist.value || undefined,
      sortBy: sortBy.value,
    });
    if (token !== loadToken) return; // A newer load is in flight
    tracks = result;
    byId = new Map(tracks.map((t) => [t.id, t]));
    render();
  } catch (err) {
    showToast(errorMessage(err), 'error');
  }
  updateStats();
}

export async function updateStats() {
  try {
    const stats = await api.getStats();
    $('#stat-tracks').textContent = stats.totalTracks;
    $('#stat-missing').textContent = stats.missingTracks;
    $('#stat-playlists').textContent = stats.totalPlaylists;
  } catch {
    // Stats are informative only
  }
}

/** Show only the tracks of one playlist (from the playlists view). */
export function showPlaylist(playlistId) {
  filterPlaylist.value = playlistId;
  sortBy.value = 'playlist';
  updateTitle();
}

function updateTitle() {
  $('#tracks-title').textContent = filterPlaylist.value
    ? filterPlaylist.selectedOptions[0].textContent
    : 'Toutes les pistes';
}

export function setPlaylistOptions(playlists) {
  const selected = filterPlaylist.value;
  filterPlaylist.innerHTML = '<option value="">Toutes les playlists</option>' +
    playlists.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  filterPlaylist.value = playlists.some((p) => p.id === selected) ? selected : '';
  updateTitle();
}

// ─── Rendering ──────────────────────────────────────────────

/** The "Fichier" column: quality, download state, conflict or search button. */
function statusHtml(track) {
  if (track.conflictId) {
    return `<button class="track-status-btn conflict" data-action="conflict" title="Deux fichiers pour cette piste : à résoudre">${icon(ICONS.warning)} Conflit</button>`;
  }

  if (track.format) {
    const details = [
      [track.format.toUpperCase(), qualityLabel(track), track.bitDepth && `${track.bitDepth} bits`]
        .filter(Boolean).join(' · '),
      formatSize(track.fileSize),
      track.filePath?.split(/[\\/]/).pop(),
    ].filter((line) => line && line !== '—').join('\n');
    const upgrade = !isLossless(track.format) && track.playlistIds
      ? `<button class="track-download-btn" data-action="upgrade" title="Chercher une meilleure qualité (FLAC)">${icon(ICONS.upgrade, 16)}</button>`
      : '';
    return `${upgrade}<span class="quality-badge" data-tooltip="${escapeHtml(details)}">${formatBadge(track.format)}</span>`;
  }

  if (!track.playlistIds) return '';

  const transfer = transferForTrack(track.id);
  if (transfer && !isFinished(transfer.state)) {
    const pct = Math.round(transfer.percentComplete);
    return `<span class="track-progress" title="${escapeHtml(transfer.state)}">${/inprogress/i.test(transfer.state) ? `↓ ${pct}%` : 'En file'}</span>`;
  }
  if (transfer) {
    return `<button class="track-status-btn failed" data-action="download" title="Le téléchargement a échoué : choisir une autre source">Échec</button>`;
  }
  if (isSearching(track)) {
    return `<button class="track-download-btn searching" data-action="download" title="Recherche en cours">${SPINNER}</button>`;
  }

  const count = cachedCount(track);
  const title = count === undefined ? 'Rechercher sur Soulseek'
    : count === 0 ? 'Aucun résultat en cache : relancer la recherche' : `${count} résultats en cache`;
  return `<button class="track-download-btn${count ? ' cached' : ''}${count === 0 ? ' empty' : ''}" data-action="download" title="${title}">
    ${icon(ICONS.download, 16)}${count !== undefined ? `<span class="result-count">${count}</span>` : ''}
  </button>`;
}

function rowHtml(track, i) {
  const status = statusHtml(track);
  statusCache.set(track.id, status);
  const canIdentify = !track.playlistIds && track.filePath;
  const badge = track.suggestedTrackIds
    ? `<span class="source-badge unknown matched" title="Un morceau de vos playlists correspond à ce fichier : cliquez sur la loupe pour vérifier et lier">${SOURCE_LABELS.unknown}</span>`
    : `<span class="source-badge ${escapeHtml(track.source)}">${SOURCE_LABELS[track.source] || SOURCE_LABELS.unknown}</span>`;
  return `
    <div class="track-row" data-track-id="${escapeHtml(track.id)}">
      <span class="track-num">
        <span class="track-index">${i + 1}</span>
        ${track.filePath ? `<button class="track-play-btn" data-action="play" title="Écouter">${icon(PLAY_ICON, 14)}</button>` : ''}
      </span>
      <div class="track-title-cell">
        ${track.artwork ? `<img class="track-thumb" src="${escapeHtml(track.artwork)}" alt="" loading="lazy">` : '<span class="track-thumb"></span>'}
        <div class="track-info">
          <span class="track-title" title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</span>
          <span class="track-artist" title="${escapeHtml(track.artist)}">${escapeHtml(track.artist)}</span>
        </div>
      </div>
      <span class="track-album" title="${escapeHtml(track.album)}">${escapeHtml(track.album || '—')}</span>
      <span class="track-source">
        ${badge}
        ${canIdentify ? `<button class="identify-icon" data-action="identify" title="Identifier ce morceau">${icon(ICONS.search, 12)}</button>` : ''}
      </span>
      <span class="track-duration">${formatDuration(track.duration)}</span>
      <span class="track-actions">${status}</span>
      <button class="track-download-btn track-menu-btn" data-action="menu" title="Plus d'actions">${icon(ICONS.more, 16)}</button>
    </div>`;
}

function render() {
  statusCache.clear();
  if (tracks.length === 0) {
    const filtered = searchInput.value || filterSource.value !== 'all' || filterPlaylist.value;
    emptyState.querySelector('h2').textContent = filtered ? 'Aucun résultat' : 'Aucune piste';
    emptyState.querySelector('p').textContent = filtered
      ? 'Aucune piste ne correspond à ces filtres'
      : 'Ajoutez une playlist Spotify ou SoundCloud pour commencer';
    trackList.replaceChildren(emptyState);
    return;
  }
  trackList.innerHTML = tracks.map(rowHtml).join('');
  markPlaying();
}

/** Refresh only the status cells that changed (search/download progress). */
function refreshStatuses() {
  for (const row of trackList.querySelectorAll('.track-row')) {
    const track = byId.get(row.dataset.trackId);
    if (!track) continue;
    const status = statusHtml(track);
    if (statusCache.get(track.id) !== status) {
      statusCache.set(track.id, status);
      row.querySelector('.track-actions').innerHTML = status;
    }
  }
}

let statusFrame = 0;
function scheduleStatusRefresh() {
  // Hidden view: statuses are recomputed when it is shown again
  if (!$('#view-tracks').classList.contains('active')) return;
  cancelAnimationFrame(statusFrame);
  statusFrame = requestAnimationFrame(refreshStatuses);
}

bus.on('search:changed', scheduleStatusRefresh);

// Highlight the row being played
const PLAY_ICON = '<polygon points="6 4 20 12 6 20 6 4" fill="currentColor"/>';
const PAUSE_ICON = '<rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/>';
function markPlaying() {
  for (const row of trackList.querySelectorAll('.track-row')) {
    const track = byId.get(row.dataset.trackId);
    const playing = !!track?.filePath && isPlaying(track.filePath);
    if (row.classList.contains('playing') === playing) continue;
    row.classList.toggle('playing', playing);
    const btn = row.querySelector('.track-play-btn');
    if (btn) {
      btn.innerHTML = icon(playing ? PAUSE_ICON : PLAY_ICON, 14);
      btn.title = playing ? 'Pause' : 'Écouter';
    }
  }
}
bus.on('player:changed', markPlaying);
bus.on('downloads:changed', scheduleStatusRefresh);

trackList.addEventListener('click', (e) => {
  const actionEl = e.target.closest('[data-action]');
  const track = actionEl && byId.get(actionEl.closest('.track-row')?.dataset.trackId);
  if (!track) return;
  const { action } = actionEl.dataset;
  if (action === 'download') openSearch(track).catch(toastError);
  if (action === 'upgrade') openSearch(track, { format: 'flac' }).catch(toastError);
  if (action === 'identify') openIdentify(track).catch(toastError);
  if (action === 'play') playTrack(track);
  if (action === 'conflict') bus.emit('conflict:open', track.conflictId);
  if (action === 'menu') {
    const rect = actionEl.getBoundingClientRect();
    showTrackMenu(track, rect.right, rect.bottom);
  }
});

trackList.addEventListener('contextmenu', (e) => {
  const track = byId.get(e.target.closest('.track-row')?.dataset.trackId);
  if (!track) return;
  e.preventDefault();
  showTrackMenu(track, e.clientX, e.clientY);
});

/** Per-track actions; anything destructive asks for confirmation. */
function showTrackMenu(track, x, y) {
  const items = [];
  if (track.playlistIds) {
    items.push({ label: 'Rechercher sur Soulseek', action: () => openSearch(track).catch(toastError) });
  }
  if (!track.playlistIds && track.filePath) {
    items.push({ label: 'Identifier…', action: () => openIdentify(track).catch(toastError) });
  }
  if (track.filePath) {
    items.push({ label: isPlaying(track.filePath) ? 'Pause' : 'Écouter', action: () => playTrack(track) });
    items.push({ label: 'Afficher dans le dossier', action: () => api.showInFolder(track.filePath) });
    items.push('separator');
    items.push({
      label: 'Supprimer le fichier (corbeille)',
      danger: true,
      action: () => deleteFile(track),
    });
  }
  showMenu(x, y, items);
}

async function deleteFile(track) {
  const name = track.filePath.split(/[\\/]/).pop();
  if (!confirm(`Envoyer « ${name} » à la corbeille ?`)) return;
  try {
    await api.deleteLocalFile(track.id);
    showToast('Fichier envoyé à la corbeille', 'success');
  } catch (err) {
    toastError(err);
  }
}


// ─── Controls ───────────────────────────────────────────────
let searchTimeout;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(loadTracks, 250);
});
filterSource.addEventListener('change', loadTracks);
sortBy.addEventListener('change', loadTracks);
filterPlaylist.addEventListener('change', () => {
  updateTitle();
  if (!filterPlaylist.value && sortBy.value === 'playlist') sortBy.value = 'recent';
  loadTracks();
});

$('#btn-auto-search').addEventListener('click', () => toggleAutoSearch(tracks));

/** Fetch every playlist again from Spotify / SoundCloud. */
export async function refreshPlaylists(btn) {
  try {
    const result = await withBusyButton(btn, () => api.refreshLibrary());
    showToast(`Bibliothèque synchronisée (${result.totalTracks} pistes, ${result.localTracks} fichiers locaux)`, 'success');
    for (const error of result.errors) showToast(error, 'error');
  } catch (err) {
    toastError(err);
  }
}

$('#btn-refresh-tracks').addEventListener('click', (e) => refreshPlaylists(e.currentTarget));

bus.on('search:open-track', async (trackId) => {
  try {
    const track = await findTrack(trackId);
    if (track) await openSearch(track);
  } catch (err) {
    toastError(err);
  }
});
