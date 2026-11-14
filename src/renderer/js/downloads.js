// ─── Downloads view ─────────────────────────────────────────
// Transfers are pushed by the main process (which also tags and places the
// finished files); this view only displays them.

import {
  $, api, baseName, bus, escapeHtml, formatSize, formatSpeed, icon, ICONS, showToast, toastError,
} from './ui.js';

const list = $('#download-view-list');
const emptyState = $('#downloads-empty');
const summary = $('#downloads-summary');
const navBadge = $('#nav-download-badge');

let transfers = [];
let byTrack = new Map(); // trackId -> most relevant transfer
let rendered = [];
let renderedSignature = null;

// ─── Transfer states (slskd: "Queued, Remotely", "Completed, Succeeded"…) ──
// The main process has its own isSucceeded: there is no module shared by both sides.
export const isFinished = (state) => /completed/i.test(state || '');
const isSucceeded = (state) => /succeeded/i.test(state || '');
const isFailed = (state) => isFinished(state) && !isSucceeded(state);
export const isTransferring = (t) => /inprogress|initializing/i.test(t.state);
const isRemotelyQueued = (t) => /queued/i.test(t.state) && /remotely/i.test(t.state);

/** Label of a transfer that is waiting (shared with the track list). */
export function waitingLabel(t) {
  // slskd waits before retrying a failed attempt; the transfer is queued again
  if (t.attempts > 0) return `Relance (n°${t.attempts + 1})`;
  if (isRemotelyQueued(t)) return t.placeInQueue > 0 ? `En file (${t.placeInQueue}ᵉ)` : 'En file';
  if (/requested/i.test(t.state)) return 'Demandé';
  return 'En attente';
}

const PRESENCE_LABELS = { offline: 'hors ligne', away: 'absent' };

function stateDisplay(t) {
  const s = (t.state || '').toLowerCase();
  if (s.includes('succeeded')) return { label: 'Terminé', cls: 'state-done' };
  if (s.includes('cancelled')) return { label: 'Annulé', cls: 'state-error' };
  if (s.includes('timedout')) return { label: 'Expiré', cls: 'state-error' };
  if (s.includes('rejected')) return { label: 'Refusé', cls: 'state-error' };
  if (s.includes('completed')) return { label: 'Erreur', cls: 'state-error' };
  if (isTransferring(t)) return { label: 'En cours', cls: 'state-active' };
  const presence = isRemotelyQueued(t) ? PRESENCE_LABELS[t.userPresence] : '';
  return {
    label: `${waitingLabel(t)}${presence ? ` · ${presence}` : ''}`,
    cls: t.userPresence === 'offline' && presence ? 'state-error' : 'state-queued',
  };
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
  if (signature === renderedSignature) return;
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
      (failedRow || isRemotelyQueued(t)) && t.trackId && `<button class="dl-action-btn dl-other" title="Choisir une autre source" data-action="other">${icon(ICONS.search)}</button>`,
      failedRow && `<button class="dl-action-btn dl-cancel" title="Retirer de la liste" data-action="remove">${icon(ICONS.close)}</button>`,
    ].filter(Boolean).join('');

    return `<div class="dl-row" data-index="${i}">
      <span class="dl-col-name" title="${escapeHtml(t.filename)}">${t.trackId ? '<span class="dl-linked" title="Lié à une piste de playlist">♪</span> ' : ''}${escapeHtml(baseName(t.filename))}</span>
      <span class="dl-col-user">${escapeHtml(t.username)}</span>
      <span class="dl-col-size">${sizeText}</span>
      <span class="dl-col-progress">${progress}</span>
      <span class="dl-col-state ${cls}" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
      <span class="dl-col-actions">${actions}</span>
    </div>`;
  }).join('');
}

list.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  const t = btn && rendered[btn.closest('.dl-row').dataset.index];
  if (!t) return;
  const { action } = btn.dataset;
  // Opening the search changes nothing here: keep the button usable
  if (action === 'other') {
    bus.emit('search:open-track', t.trackId);
    return;
  }
  btn.disabled = true;
  try {
    if (action === 'cancel') await api.slskd.cancelDownload(t.username, t.id, t.filename, false);
    if (action === 'remove') await api.slskd.cancelDownload(t.username, t.id, t.filename, true);
    if (action === 'retry') {
      await api.slskd.retryDownload(t.username, t.id, t.filename, t.size);
      showToast('Téléchargement relancé');
    }
  } catch (err) {
    btn.disabled = false;
    toastError(err);
  }
});

async function clearFinished(kind) {
  try {
    const count = await api.slskd.clearDownloads(kind);
    showToast(count > 1 ? `${count} téléchargements retirés de la liste` : `${count} téléchargement retiré de la liste`);
  } catch (err) {
    toastError(err);
  }
}

$('#dl-clear-done').addEventListener('click', () => clearFinished('succeeded'));
$('#dl-clear-failed').addEventListener('click', () => clearFinished('failed'));
$('#btn-open-library').addEventListener('click', () => api.openLibraryFolder().catch(toastError));

// ─── Main-process events ────────────────────────────────────
api.slskd.onDownloadsUpdated(setTransfers);

// (The library-changed event that follows refreshes the tracks and conflicts.)
api.slskd.onDownloadEvent((event) => {
  if (event.type === 'placed') {
    showToast(`Rangé : ${baseName(event.filePath)}`, 'success');
  } else if (event.type === 'conflict') {
    showToast('Conflit de fichier : à résoudre dans la liste des pistes', 'error');
  } else if (event.type === 'error') {
    showToast(`Fichier téléchargé non rangé : ${event.message}`, 'error');
  }
});

export async function refreshDownloads() {
  setTransfers(await api.slskd.getDownloads().catch(() => []));
}
