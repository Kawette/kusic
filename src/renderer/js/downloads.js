// ─── Downloads view ─────────────────────────────────────────
// Transfers are pushed by the main process (which also tags and places the
// finished files); this view only displays them.

import {
  $, api, bus, escapeHtml, formatSize, formatSpeed, icon, ICONS, showToast, toastError,
} from './ui.js';

const list = $('#download-view-list');
const emptyState = $('#downloads-empty');
const summary = $('#downloads-summary');
const navBadge = $('#nav-download-badge');
const conflictBadge = $('#nav-conflict-badge');
const conflictsSection = $('#conflicts-section');
const conflictsList = $('#conflicts-list');

let transfers = [];
let byTrack = new Map(); // trackId -> most relevant transfer
let rendered = [];
let renderedSignature = '';

export const isFinished = (state) => /completed/i.test(state || '');
const isSucceeded = (state) => /succeeded/i.test(state || '');
const isFailed = (state) => isFinished(state) && !isSucceeded(state);

function stateDisplay({ state, attempts }) {
  const s = (state || '').toLowerCase();
  // slskd waits before retrying a failed attempt; the transfer is queued again
  if (attempts > 0 && !s.includes('completed') && !s.includes('inprogress')) {
    return { label: `Nouvelle tentative (n°${attempts + 1})`, cls: 'state-queued' };
  }
  if (s.includes('succeeded')) return { label: 'Terminé', cls: 'state-done' };
  if (s.includes('cancelled')) return { label: 'Annulé', cls: 'state-error' };
  if (s.includes('timedout')) return { label: 'Expiré', cls: 'state-error' };
  if (s.includes('rejected')) return { label: 'Refusé', cls: 'state-error' };
  if (s.includes('completed')) return { label: 'Erreur', cls: 'state-error' };
  if (s.includes('inprogress') || s.includes('initializing')) return { label: 'En cours', cls: 'state-active' };
  if (s.includes('queued') && s.includes('remote')) return { label: 'File distante', cls: 'state-queued' };
  if (s.includes('queued') && s.includes('local')) return { label: 'File locale', cls: 'state-queued' };
  if (s.includes('queued')) return { label: 'En attente', cls: 'state-queued' };
  if (s.includes('requested')) return { label: 'Demandé', cls: 'state-queued' };
  return { label: state || '?', cls: '' };
}

/** True if this file is already being (or was) downloaded successfully. */
export function pendingDownloadFor(username, filename) {
  return transfers.some((t) => t.username === username && t.filename === filename && !isFailed(t.state));
}

/** The most relevant transfer for a playlist track (active first, then failed). */
export function transferForTrack(trackId) {
  return byTrack.get(trackId) || null;
}

function setTransfers(next) {
  transfers = next || [];
  byTrack = new Map();
  for (const t of transfers) {
    if (!t.trackId || isSucceeded(t.state)) continue;
    const current = byTrack.get(t.trackId);
    if (!current || (isFinished(current.state) && !isFinished(t.state))) byTrack.set(t.trackId, t);
  }
  const active = transfers.filter((t) => !isFinished(t.state)).length;
  navBadge.textContent = active;
  navBadge.hidden = active === 0;
  if ($('#view-downloads').classList.contains('active')) render();
  bus.emit('downloads:changed');
}

export function render() {
  // Rebuilding identical rows would only lose clicks and text selection
  const signature = JSON.stringify(transfers);
  if (signature === renderedSignature && list.firstElementChild !== emptyState) return;
  renderedSignature = signature;

  const active = transfers.filter((t) => !isFinished(t.state));
  const done = transfers.filter((t) => isSucceeded(t.state));
  const failed = transfers.filter((t) => isFailed(t.state));

  summary.innerHTML = `
    <div class="dl-summary-item"><span class="dl-summary-value state-active">${active.length}</span><span class="dl-summary-label">En cours</span></div>
    <div class="dl-summary-item"><span class="dl-summary-value state-done">${done.length}</span><span class="dl-summary-label">Terminés</span></div>
    <div class="dl-summary-item"><span class="dl-summary-value state-error">${failed.length}</span><span class="dl-summary-label">Échoués</span></div>`;
  $('#dl-clear-done').hidden = done.length === 0;
  $('#dl-clear-failed').hidden = failed.length === 0;

  if (transfers.length === 0) {
    list.replaceChildren(emptyState);
    return;
  }

  rendered = [...active, ...failed.reverse(), ...done.reverse()];
  list.innerHTML = rendered.map((t, i) => {
    const name = t.filename.split(/[\\/]/).pop() || t.filename;
    const { label, cls } = stateDisplay(t);
    const pct = Math.round(t.percentComplete);
    const running = !isFinished(t.state);
    const failedRow = isFailed(t.state);
    const sizeText = running ? `${formatSize(t.bytesTransferred)} / ${formatSize(t.size)}` : formatSize(t.size);
    const progress = running
      ? `<span class="dl-speed">${t.averageSpeed > 0 ? formatSpeed(t.averageSpeed) : '—'}</span><div class="dl-progress-bar"><div class="dl-progress-fill" style="width: ${pct}%"></div></div><span class="dl-pct">${pct}%</span>`
      : '';
    const actions = [
      running && `<button class="dl-action-btn dl-cancel" title="Annuler" data-action="cancel">${icon(ICONS.close)}</button>`,
      failedRow && `<button class="dl-action-btn dl-retry" title="Réessayer avec la même source" data-action="retry">${icon(ICONS.retry)}</button>`,
      failedRow && t.trackId && `<button class="dl-action-btn dl-retry" title="Choisir une autre source" data-action="other">${icon(ICONS.search)}</button>`,
      failedRow && `<button class="dl-action-btn dl-cancel" title="Retirer de la liste" data-action="remove">${icon(ICONS.close)}</button>`,
    ].filter(Boolean).join('');

    return `<div class="dl-row ${cls}" data-index="${i}">
      <span class="dl-col-name" title="${escapeHtml(t.filename)}">${t.trackId ? '<span class="dl-linked" title="Lié à une piste de playlist">♪</span> ' : ''}${escapeHtml(name)}</span>
      <span class="dl-col-user">${escapeHtml(t.username)}</span>
      <span class="dl-col-size">${sizeText}</span>
      <span class="dl-col-progress">${progress}</span>
      <span class="dl-col-state ${cls}">${escapeHtml(label)}</span>
      <span class="dl-col-actions">${actions}</span>
    </div>`;
  }).join('');
}

list.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  const t = btn && rendered[btn.closest('.dl-row').dataset.index];
  if (!t) return;
  btn.disabled = true;
  try {
    const { action } = btn.dataset;
    if (action === 'cancel') await api.slskd.cancelDownload(t.username, t.id, t.filename, false);
    if (action === 'remove') await api.slskd.cancelDownload(t.username, t.id, t.filename, true);
    if (action === 'retry') {
      await api.slskd.retryDownload(t.username, t.id, t.filename, t.size);
      showToast('Téléchargement relancé');
    }
    if (action === 'other') bus.emit('search:open-track', t.trackId);
  } catch (err) {
    btn.disabled = false;
    toastError(err);
  }
});

async function clearFinished(kind) {
  try {
    const count = await api.slskd.clearDownloads(kind);
    showToast(`${count} téléchargement(s) retiré(s) de la liste`);
  } catch (err) {
    toastError(err);
  }
}

$('#dl-clear-done').addEventListener('click', () => clearFinished('succeeded'));
$('#dl-clear-failed').addEventListener('click', () => clearFinished('failed'));
$('#btn-open-library').addEventListener('click', () => api.openLibraryFolder());

// ─── Conflicts ──────────────────────────────────────────────
export async function loadConflicts() {
  let conflicts;
  try {
    conflicts = await api.getConflicts();
  } catch (err) {
    toastError(err);
    return [];
  }
  conflictBadge.textContent = conflicts.length;
  conflictBadge.hidden = conflicts.length === 0;
  conflictsSection.hidden = conflicts.length === 0;
  conflictsList.innerHTML = conflicts.map((c) => `
    <div class="conflict-row">
      <span class="conflict-icon">${icon(ICONS.warning, 16)}</span>
      <span class="conflict-title">${escapeHtml(c.track.artist)} — ${escapeHtml(c.track.title)}</span>
      <span class="conflict-reason">${c.reason === 'already-linked' ? 'La piste a déjà un fichier' : 'Nom de fichier déjà pris'}</span>
      <button class="btn-small btn-accent" data-conflict-id="${escapeHtml(c.id)}">Comparer et choisir</button>
    </div>`).join('');
  return conflicts;
}

conflictsList.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-conflict-id]');
  if (btn) bus.emit('conflict:open', btn.dataset.conflictId);
});

// ─── Main-process events ────────────────────────────────────
api.slskd.onDownloadsUpdated(setTransfers);

// (The library-changed event that follows refreshes tracks and conflicts.)
api.slskd.onDownloadEvent((event) => {
  if (event.type === 'placed') {
    showToast(`Rangé : ${event.filePath.split(/[\/]/).pop()}`, 'success');
  } else if (event.type === 'conflict') {
    showToast('Conflit de fichier : à résoudre dans Téléchargements', 'error');
  } else if (event.type === 'error') {
    showToast(`Fichier téléchargé non rangé : ${event.message}`, 'error');
  }
});

export async function refreshDownloads() {
  setTransfers(await api.slskd.getDownloads().catch(() => []));
}
