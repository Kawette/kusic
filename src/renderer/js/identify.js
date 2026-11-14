// ─── Identify modal (user-confirmed) ────────────────────────
// Shows the playlist tracks that strictly match the file (computed by the
// main process: same title and artist, compatible length), usually one.
// Otherwise the user searches by name. Linking only happens on click.

import {
  $, api, bus, closeModal, durationMatch, escapeHtml, formatBadge, formatDuration, icon, openModal,
  showToast, SOURCE_LABELS,
  toastError,
} from './ui.js';
import { isPlaying, playTrack } from './player.js';

const modal = $('#identify-modal');
const sourceTitle = $('#identify-source-title');
const searchInput = $('#identify-search-input');
const resultsList = $('#identify-results-list');
const hint = $('#identify-hint');
const MAX_RESULTS = 20;

let source = null; // the unknown file track
let playlistTracks = [];
let shown = [];
let linking = false;

function render() {
  const words = searchInput.value.trim().toLowerCase().split(/\s+/).filter(Boolean);

  if (words.length) {
    // Plain name search: every typed word must appear
    shown = playlistTracks
      .filter((t) => {
        const text = `${t.artist} ${t.title} ${t.album}`.toLowerCase();
        return words.every((w) => text.includes(w));
      })
      .slice(0, MAX_RESULTS);
    hint.textContent = shown.length
      ? 'Morceaux de vos playlists contenant ces mots. Cliquez pour lier le fichier.'
      : 'Aucun morceau de vos playlists ne contient ces mots. Modifiez la recherche.';
  } else {
    const ids = source.suggestedTrackIds || [];
    shown = ids.map((id) => playlistTracks.find((t) => t.id === id)).filter(Boolean);
    hint.textContent = shown.length
      ? 'Même titre et même artiste. Vérifiez la durée (orange = probablement une autre version) puis cliquez pour lier.'
      : 'Aucune correspondance évidente. Tapez un titre ou un artiste pour chercher.';
  }

  resultsList.innerHTML = shown.map((t, i) => `
    <button class="identify-result-row" data-index="${i}">
      ${t.artwork ? `<img class="identify-result-thumb" src="${escapeHtml(t.artwork)}" alt="">` : '<span class="identify-result-thumb"></span>'}
      <span class="identify-result-info">
        <span class="identify-result-title">${escapeHtml(t.title)}</span>
        <span class="identify-result-artist">${escapeHtml(t.artist)}</span>
      </span>
      <span class="identify-result-duration ${durationMatch(t.duration, source.duration).cls}" title="${durationMatch(t.duration, source.duration).title}">${formatDuration(t.duration)}</span>
      <span class="source-badge ${escapeHtml(t.source)}">${SOURCE_LABELS[t.source] || SOURCE_LABELS.unknown}</span>
      ${t.format ? `<span title="Cette piste a déjà un fichier : le lier ouvrira une comparaison pour choisir lequel garder">${formatBadge(t.format)}</span>` : ''}
    </button>`).join('');
}

export async function openIdentify(track) {
  source = track;
  playlistTracks = [];
  sourceTitle.textContent = `${track.artist} — ${track.title} (${formatDuration(track.duration)})`;
  searchInput.value = '';
  resultsList.innerHTML = '';
  hint.textContent = '';
  renderPlayButton();
  openModal(modal, () => { source = null; });

  const tracks = (await api.getTracks({ source: 'all' })).filter((t) => t.playlistIds);
  if (source !== track) return; // Closed or reopened meanwhile
  playlistTracks = tracks.sort((a, b) => a.title.localeCompare(b.title));
  if (!track.suggestedTrackIds) searchInput.value = track.title;
  render();
}

const playBtn = $('#identify-play');
const PLAY_ICON = '<polygon points="6 4 20 12 6 20 6 4" fill="currentColor"/>';
const PAUSE_ICON = '<rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/>';

function renderPlayButton() {
  const playing = !!source && isPlaying(source.filePath);
  playBtn.innerHTML = icon(playing ? PAUSE_ICON : PLAY_ICON, 14);
  playBtn.title = playing ? 'Pause' : 'Écouter le fichier';
}

playBtn.addEventListener('click', () => source && playTrack(source));
bus.on('player:changed', renderPlayButton);

let debounce;
searchInput.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => source && render(), 150);
});

resultsList.addEventListener('click', async (e) => {
  const row = e.target.closest('.identify-result-row');
  if (!row || !source || linking) return;
  const target = shown[row.dataset.index];
  linking = true;
  row.classList.add('linking');
  resultsList.querySelectorAll('.identify-result-row').forEach((r) => { r.disabled = true; });
  try {
    const result = await api.linkUnknownToTrack(source.id, target.id);
    showToast(
      result.status === 'conflict'
        ? 'Fichier lié, mais en conflit : à résoudre dans Téléchargements'
        : 'Morceau identifié et lié',
      result.status === 'conflict' ? 'error' : 'success',
    );
    closeModal(modal);
  } catch (err) {
    row.classList.remove('linking');
    resultsList.querySelectorAll('.identify-result-row').forEach((r) => { r.disabled = false; });
    toastError(err);
  } finally {
    linking = false;
  }
});
