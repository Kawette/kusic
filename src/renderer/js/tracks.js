// ─── Tracks view ────────────────────────────────────────────

import {
  $, api, baseName, bus, escapeHtml, formatBadge, formatDuration, formatSize, icon, ICONS,
  isLossless, isPlayable, qualityLabel, showMenu, showToast, sourceBadge, SPINNER, thumb, toastError,
  withBusyButton,
} from './ui.js';
import { cachedStats, isSearching, openSearch, toggleAutoSearch } from './search.js';
import { isFinished, isTransferring, transferForTrack, waitingLabel } from './downloads.js';
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
    toastError(err);
  }
  updateStats();
}

export async function updateStats() {
  try {
    const stats = await api.getStats();
    $('#stat-tracks').textContent = stats.totalTracks;
    $('#stat-missing').textContent = stats.missingTracks;
    $('#stat-playlists').textContent = stats.totalPlaylists;
    showConflictCount(stats.conflicts);
  } catch {
    // Stats are informative only
  }
}

/** Conflicts are resolved from the track list: badge in the menu + banner. */
function showConflictCount(count) {
  const badge = $('#nav-conflict-badge');
  badge.textContent = count;
  badge.hidden = count === 0;
  // No banner while the conflicts are already the ones listed
  $('#conflicts-banner').hidden = count === 0 || filterSource.value === 'conflicts';
  $('#conflicts-banner-text').textContent = count > 1 ? `${count} conflits à résoudre` : '1 conflit à résoudre';
}

$('#btn-show-conflicts').addEventListener('click', () => {
  filterSource.value = 'conflicts';
  loadTracks();
});

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

const otherSourceButton = `<button class="track-download-btn" data-action="download" title="Choisir une autre source">${icon(ICONS.download, 16)}</button>`;

/** The "Fichier" column: quality, download state, conflict or search button. */
function statusHtml(track) {
  if (track.conflictId) {
    return `<span class="status-tag conflict" title="Deux fichiers pour cette piste : menu ⋯ → Résoudre le conflit">Conflit</span>`;
  }

  if (track.format) {
    const details = [
      [track.format.toUpperCase(), qualityLabel(track), track.bitDepth && `${track.bitDepth} bits`]
        .filter(Boolean).join(' · '),
      formatSize(track.fileSize),
      baseName(track.filePath),
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
    if (transfer.userPresence === 'offline') {
      return `<span class="status-tag failed" title="L'utilisateur qui doit envoyer ce fichier est hors ligne">Hors ligne</span>${otherSourceButton}`;
    }
    // A source is chosen: the download button says so, the details are in the downloads view
    const state = isTransferring(transfer) ? `en cours (${pct} %)` : waitingLabel(transfer).toLowerCase();
    return `<button class="track-download-btn pending" data-action="download" title="Téléchargement ${escapeHtml(state)} · cliquer pour choisir une autre source">${icon(ICONS.check, 16)}</button>`;
  }
  if (transfer) {
    return `<span class="status-tag failed" title="Le téléchargement a échoué">Échec</span>${otherSourceButton}`;
  }
  if (isSearching(track)) {
    return `<button class="track-download-btn searching" data-action="download" title="Recherche en cours">${SPINNER}</button>`;
  }

  // Cached search: number of relevant results
  const stats = cachedStats(track);
  const count = stats?.relevant;
  const title = !stats ? 'Rechercher sur Soulseek'
    : count === 0 ? 'Aucun résultat pertinent en cache : relancer la recherche'
      : `${count} résultat${count > 1 ? 's' : ''} pertinent${count > 1 ? 's' : ''}, meilleur format : ${stats.best}`;
  return `<button class="track-download-btn${count ? ' cached' : ''}${count === 0 ? ' empty' : ''}" data-action="download" title="${escapeHtml(title)}">
    ${icon(ICONS.download, 16)}${stats ? `<span class="result-count">${count}</span>` : ''}
  </button>`;
}

function rowHtml(track, i) {
  const status = statusHtml(track);
  statusCache.set(track.id, status);
  const canIdentify = !track.playlistIds && track.filePath;
  const badge = track.suggestedTrackIds
    ? `<span class="source-badge unknown matched" title="Un morceau de vos playlists correspond à ce fichier : cliquez sur la loupe pour vérifier et lier">Identifiable</span>`
    : sourceBadge(track.source);
  return `
    <div class="track-row" data-track-id="${escapeHtml(track.id)}">
      <span class="track-num">
        <span class="track-index">${i + 1}</span>
        ${track.filePath && isPlayable(track.format) ? `<button class="track-play-btn" data-action="play" title="Écouter">${icon(ICONS.play, 14)}</button>` : ''}
      </span>
      <div class="track-title-cell">
        ${thumb(track.artwork, 'track-thumb')}
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

/** Highlight the row being played. */
function markPlaying() {
  for (const row of trackList.querySelectorAll('.track-row')) {
    const track = byId.get(row.dataset.trackId);
    const playing = !!track?.filePath && isPlaying(track.filePath);
    if (row.classList.contains('playing') === playing) continue;
    row.classList.toggle('playing', playing);
    const btn = row.querySelector('.track-play-btn');
    if (btn) {
      btn.innerHTML = icon(playing ? ICONS.pause : ICONS.play, 14);
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
  if (track.conflictId) {
    items.push({ label: 'Résoudre le conflit…', action: () => bus.emit('conflict:open', track.conflictId) });
  }
  if (track.playlistIds) {
    items.push({ label: 'Rechercher sur Soulseek', action: () => openSearch(track).catch(toastError) });
  }
  if (!track.playlistIds && track.filePath) {
    items.push({ label: 'Identifier…', action: () => openIdentify(track).catch(toastError) });
  }
  if (track.filePath) {
    if (isPlayable(track.format)) {
      items.push({ label: isPlaying(track.filePath) ? 'Pause' : 'Écouter', action: () => playTrack(track) });
    }
    items.push({ label: 'Afficher dans le dossier', action: () => api.showInFolder(track.filePath).catch(toastError) });
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
  const name = baseName(track.filePath);
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
