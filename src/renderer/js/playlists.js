// ─── Playlists view ─────────────────────────────────────────

import {
  $, api, closeModal, errorMessage, escapeHtml, icon, ICONS, openModal, showToast, SOURCE_LABELS,
  toastError, withBusyButton,
} from './ui.js';
import { refreshPlaylists, setPlaylistOptions, showPlaylist } from './tracks.js';

const grid = $('#playlist-grid');
const emptyState = $('#playlists-empty');
const addModal = $('#add-playlist-modal');
const urlInput = $('#playlist-url-input');
const addError = $('#add-error');
const confirmBtn = $('#btn-confirm-add');

let playlists = [];
let loadToken = 0;

export async function loadPlaylists() {
  const token = ++loadToken;
  try {
    const result = await api.getPlaylists();
    if (token !== loadToken) return; // A newer load is in flight
    playlists = result;
    setPlaylistOptions(playlists);
    render();
  } catch (err) {
    toastError(err);
  }
}

function render() {
  if (playlists.length === 0) {
    grid.replaceChildren(emptyState);
    return;
  }

  grid.innerHTML = playlists.map((p) => {
    const pct = p.trackCount ? Math.round((p.localCount / p.trackCount) * 100) : 0;
    return `
    <div class="playlist-card" data-id="${escapeHtml(p.id)}" title="Voir les pistes">
      <div class="playlist-cover">
        ${p.artwork ? `<img src="${escapeHtml(p.artwork)}" alt="" loading="lazy">` : ''}
        <span class="playlist-source-tag ${escapeHtml(p.source)}">${SOURCE_LABELS[p.source] || escapeHtml(p.source)}</span>
      </div>
      <div class="playlist-info">
        <div class="playlist-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>
        <div class="playlist-completion" title="${p.localCount} pistes téléchargées sur ${p.trackCount}">
          <div class="playlist-completion-bar"><div style="width: ${pct}%"></div></div>
          <span>${p.localCount}/${p.trackCount}</span>
        </div>
        <div class="playlist-meta">
          <span class="playlist-track-count">${p.trackCount} pistes</span>
          <span class="playlist-buttons">
            <button class="playlist-action" data-action="export" title="Exporter en .m3u (fichiers locaux)">${icon(ICONS.export, 16)}</button>
            <button class="playlist-action playlist-remove" data-action="remove" title="Supprimer">${icon(ICONS.trash, 16)}</button>
          </span>
        </div>
      </div>
    </div>`;
  }).join('');
}

grid.addEventListener('click', async (e) => {
  const card = e.target.closest('.playlist-card');
  if (!card) return;
  const playlist = playlists.find((p) => p.id === card.dataset.id);
  const action = e.target.closest('[data-action]')?.dataset.action;

  if (action === 'remove') {
    if (!confirm(`Supprimer la playlist « ${playlist.name} » ? (les fichiers ne sont pas supprimés)`)) return;
    try {
      await api.removePlaylist(playlist.id);
      showToast('Playlist supprimée', 'success');
    } catch (err) {
      toastError(err);
    }
  } else if (action === 'export') {
    try {
      const count = await api.exportPlaylist(playlist.id);
      if (count !== null) showToast(`Playlist exportée (${count} fichiers)`, 'success');
    } catch (err) {
      toastError(err);
    }
  } else {
    showPlaylist(playlist.id);
    document.querySelector('.nav-btn[data-view="tracks"]').click();
  }
});

$('#btn-refresh-playlists').addEventListener('click', (e) => refreshPlaylists(e.currentTarget));

// ─── Add playlist ───────────────────────────────────────────
$('#btn-add-playlist').addEventListener('click', () => {
  urlInput.value = '';
  addError.hidden = true;
  openModal(addModal);
});

async function addPlaylist() {
  const url = urlInput.value.trim();
  if (!url || confirmBtn.disabled) return;
  addError.hidden = true;
  try {
    const playlist = await withBusyButton(confirmBtn, () => api.addPlaylist(url));
    closeModal(addModal);
    showToast(`Playlist « ${playlist.name} » ajoutée (${playlist.tracks.length} pistes)`, 'success');
  } catch (err) {
    addError.textContent = errorMessage(err);
    addError.hidden = false;
  }
}

confirmBtn.addEventListener('click', addPlaylist);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addPlaylist();
});
