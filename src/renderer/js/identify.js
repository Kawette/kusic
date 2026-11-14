// ─── Identify modal (assisted, user-confirmed) ──────────────
// Suggests playlist tracks ranked by similarity with an unknown file; the
// file is only linked when the user clicks a suggestion.

import {
  $, api, escapeHtml, formatDuration, openModal, closeModal, showToast, SOURCE_LABELS,
  toastError,
} from './ui.js';

const modal = $('#identify-modal');
const sourceTitle = $('#identify-source-title');
const searchInput = $('#identify-search-input');
const resultsList = $('#identify-results-list');
const MAX_RESULTS = 20;

let source = null; // the unknown file track
let candidates = []; // { track, tokens, text } for each playlist track
let shown = [];
let linking = false;

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

/** 0..1+ similarity between the file and a playlist track. */
function similarity(fileTokens, fileDuration, candidate) {
  let common = 0;
  for (const t of candidate.tokens) if (fileTokens.has(t)) common++;
  const union = fileTokens.size + candidate.tokens.size - common;
  let score = union ? common / union : 0;
  const { track } = candidate;
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
  const matches = (c) =>
    !query || c.text.includes(query) || [...c.tokens].some((w) => fileTokens.has(w));

  shown = candidates
    .filter(matches)
    .map((c) => ({ track: c.track, score: similarity(fileTokens, source.duration, c) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_RESULTS)
    .map((c) => c.track);

  if (shown.length === 0) {
    resultsList.innerHTML = '<p class="identify-hint">Aucun résultat</p>';
    return;
  }

  resultsList.innerHTML = shown.map((t, i) => `
    <button class="identify-result-row" data-index="${i}">
      ${t.artwork ? `<img class="identify-result-thumb" src="${escapeHtml(t.artwork)}" alt="">` : '<span class="identify-result-thumb"></span>'}
      <span class="identify-result-info">
        <span class="identify-result-title">${escapeHtml(t.title)}</span>
        <span class="identify-result-artist">${escapeHtml(t.artist)}</span>
      </span>
      <span class="identify-result-duration">${formatDuration(t.duration)}</span>
      <span class="source-badge ${escapeHtml(t.source)}">${SOURCE_LABELS[t.source] || SOURCE_LABELS.unknown}</span>
      ${t.format ? '<span class="identify-has-file" title="Cette piste a déjà un fichier">●</span>' : ''}
    </button>`).join('');
}

export async function openIdentify(track) {
  source = track;
  candidates = [];
  sourceTitle.textContent = `${track.artist} — ${track.title} (${formatDuration(track.duration)})`;
  searchInput.value = '';
  resultsList.innerHTML = '';
  openModal(modal, () => { source = null; });

  const tracks = (await api.getTracks({ source: 'all' })).filter((t) => t.playlistIds);
  if (source !== track) return; // Closed or reopened meanwhile
  candidates = tracks.map((t) => ({
    track: t,
    tokens: tokens(`${t.artist} ${t.title}`),
    text: `${t.artist} ${t.title} ${t.album}`.toLowerCase(),
  }));
  render();
}

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
