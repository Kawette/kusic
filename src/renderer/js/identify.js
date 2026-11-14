// ─── Identify modal (assisted, user-confirmed) ──────────────
// Suggests playlist tracks ranked by similarity with an unknown file; the
// file is only linked when the user clicks a suggestion.

import {
  $, api, errorMessage, escapeHtml, formatDuration, openModal, closeModal, showToast,
  SOURCE_LABELS,
} from './ui.js';

const modal = $('#identify-modal');
const sourceTitle = $('#identify-source-title');
const searchInput = $('#identify-search-input');
const resultsList = $('#identify-results-list');
const MAX_RESULTS = 20;

let source = null; // the unknown file track
let candidates = []; // playlist tracks
let shown = [];

function tokens(text) {
  return new Set(
    (text || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\b(feat|ft|featuring|original|mix|remaster(ed)?|version)\b/g, ' ')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1),
  );
}

/** 0..1 similarity between the file and a playlist track. */
function similarity(fileTokens, fileDuration, track) {
  const trackTokens = tokens(`${track.artist} ${track.title}`);
  let common = 0;
  for (const t of trackTokens) if (fileTokens.has(t)) common++;
  const union = fileTokens.size + trackTokens.size - common;
  let score = union ? common / union : 0;
  if (fileDuration && track.duration) {
    const gap = Math.abs(fileDuration - track.duration);
    if (gap < 3000) score += 0.25;
    else if (gap > 20000) score -= 0.15;
  }
  if (!track.format) score += 0.05; // Prefer tracks still missing a file
  return score;
}

function render() {
  const query = searchInput.value.trim().toLowerCase();
  const fileTokens = tokens(query || `${source.artist} ${source.title}`);

  const matches = (t) =>
    !query ||
    `${t.artist} ${t.title} ${t.album}`.toLowerCase().includes(query) ||
    [...tokens(`${t.artist} ${t.title}`)].some((w) => fileTokens.has(w));

  shown = candidates
    .filter(matches)
    .map((t) => ({ track: t, score: similarity(fileTokens, source.duration, t) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
    .map((c) => c.track);

  if (shown.length === 0) {
    resultsList.innerHTML = '<p class="identify-hint">Aucun résultat</p>';
    return;
  }

  resultsList.innerHTML = shown.map((t, i) => `
    <button class="identify-result-row" data-index="${i}">
      <img class="identify-result-thumb" src="${escapeHtml(t.artwork)}" alt="">
      <span class="identify-result-info">
        <span class="identify-result-title">${escapeHtml(t.title)}</span>
        <span class="identify-result-artist">${escapeHtml(t.artist)}</span>
      </span>
      <span class="identify-result-duration">${formatDuration(t.duration)}</span>
      <span class="source-badge ${escapeHtml(t.source)}">${SOURCE_LABELS[t.source]}</span>
      ${t.format ? '<span class="identify-has-file" title="Cette piste a déjà un fichier">●</span>' : ''}
    </button>`).join('');
}

export async function openIdentify(track) {
  source = track;
  sourceTitle.textContent = `${track.artist} — ${track.title} (${formatDuration(track.duration)})`;
  searchInput.value = '';
  resultsList.innerHTML = '';
  openModal(modal, () => { source = null; });
  candidates = (await api.getTracks({ source: 'all' })).filter((t) => t.playlistIds);
  if (source === track) render();
}

let debounce;
searchInput.addEventListener('input', () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => source && render(), 150);
});

resultsList.addEventListener('click', async (e) => {
  const row = e.target.closest('.identify-result-row');
  if (!row || !source) return;
  const target = shown[row.dataset.index];
  row.classList.add('linking');
  row.disabled = true;
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
    row.disabled = false;
    showToast(`Erreur : ${errorMessage(err)}`, 'error');
  }
});
