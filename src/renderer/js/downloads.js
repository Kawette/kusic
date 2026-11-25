// ─── Downloads view ─────────────────────────────────────────
// Transfers are pushed by the main process (which also tags and places the
// finished files); this view only displays them.

import {
  $, api, baseName, bus, escapeHtml, formatSize, formatSpeed, icon, ICONS, showToast, toastError,
  userLabel,
} from './ui.js';
import { formatQueueRate, formatWait } from './format.js';

const list = $('#download-view-list');
const emptyState = $('#downloads-empty');
// Kept as references: the empty state is out of the document while rows are shown
const emptyTitle = $('#downloads-empty-title');
const emptyText = $('#downloads-empty-text');
const summary = $('#downloads-summary');
const navBadge = $('#nav-download-badge');

let transfers = [];
let uploads = []; // What others download from us, fetched while that tab is shown
let mode = 'downloads'; // or 'uploads'
let byTrack = new Map(); // trackId -> most relevant transfer
let withTransfer = new Set(); // trackIds of every listed transfer (succeeded and failed too)
let activeByUser = new Map(); // username -> downloads not finished yet
// Requested files not in a pushed list yet ({ username, filename, trackId, at }):
// a list polled while the request runs must not drop them from the counts
let requests = [];
const REQUEST_TIMEOUT = 60_000;
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
  if (isRemotelyQueued(t)) return t.placeInQueue > 0 ? `En file (${t.placeInQueue}ᵉ)` : 'En file';
  if (/requested/i.test(t.state)) return 'Demandé';
  // Stopped when slskd closed: it requests it again a few seconds after starting
  if (/resuming/i.test(t.state)) return 'Reprise…';
  return 'En attente';
}

/** Expected wait in a remote queue ("~25 min"), once the main process measured its speed. */
export function queueWait(t) {
  return isRemotelyQueued(t) && t.queueEstimate?.eta ? formatWait(t.queueEstimate.eta) : '';
}

/**
 * Ring filling up until the next check of the queue position (once a minute),
 * then starting over. Rows are often rebuilt: a negative delay keeps it in step.
 */
function queueCountdown(check) {
  if (!check) return '';
  const elapsed = Math.min(Math.max(Date.now() - check.at, 0), check.every);
  return `<svg class="dl-queue-countdown" viewBox="0 0 12 12" aria-hidden="true">
    <circle class="track" cx="6" cy="6" r="4.5" />
    <circle class="fill" cx="6" cy="6" r="4.5" pathLength="100"
      style="animation-duration: ${check.every}ms; animation-delay: -${elapsed}ms" />
  </svg>`;
}

/** Speed of a remote queue: text and tooltip. */
function queueSpeed(estimate) {
  if (!estimate) {
    return {
      text: '',
      title: 'Vitesse de la file : la position est vérifiée une fois par minute, première estimation après deux vérifications',
    };
  }
  const since = 'depuis la première vérification (30 dernières minutes au plus)';
  // Green when moving up the queue, red when others get ahead of us
  const trend = estimate.rate > 0 ? 'gaining' : estimate.rate < 0 ? 'losing' : '';
  // Signed like the position shown: −2/min when it goes down (the rate counts places gained)
  const rate = `<span class="dl-queue-rate ${trend}">${formatQueueRate(-estimate.rate)}</span>`;
  if (estimate.rate < 0) {
    return { text: rate, title: `Places perdues ${since} : des utilisateurs sont passés devant vous` };
  }
  if (!estimate.rate) return { text: rate, title: `Aucune place gagnée ${since}` };
  return {
    text: `${rate} · ${formatWait(estimate.eta)}`,
    title: `Places gagnées ${since}, et attente estimée à ce rythme`,
  };
}

/** Place and speed in a remote queue, shown where the progress bar goes once the transfer starts. */
function queueProgress(t) {
  // Always grouped: "1 708", not "1708" (French Intl only groups from 5 digits)
  const place = `${String(t.placeInQueue).replace(/\B(?=(\d{3})+$)/g, '\u202f')}`;
  const { text, title } = queueSpeed(t.queueEstimate);
  return `<span class="dl-queue" title="Position ${place} dans la file de cet utilisateur · ${escapeHtml(title)} · le cercle se remplit jusqu'à la prochaine vérification">
    <span class="dl-queue-place">Position : <strong>${place}</strong></span>
    <span class="dl-queue-speed">${queueCountdown(t.queueCheck)}${text}</span>
  </span>`;
}

// Known only while we wait in the user's queue (checked by the main process)
const PRESENCE_LABELS = { online: 'En ligne', away: 'Absent', offline: 'Hors ligne' };

function stateDisplay(t) {
  const s = (t.state || '').toLowerCase();
  if (s.includes('succeeded')) return { label: 'Terminé', cls: 'state-done' };
  if (s.includes('cancelled')) return { label: 'Annulé', cls: 'state-error' };
  if (s.includes('timedout')) return { label: 'Expiré', cls: 'state-error' };
  if (s.includes('rejected')) return { label: 'Refusé', cls: 'state-error' };
  if (t.interrupted) return { label: 'Interrompu', cls: 'state-error' };
  if (s.includes('completed')) return { label: 'Erreur', cls: 'state-error' };
  if (isTransferring(t)) return { label: 'En cours', cls: 'state-active' };
  // The place is shown in the progress column, with the queue speed
  if (isRemotelyQueued(t)) return { label: 'En file', cls: 'state-queued' };
  return { label: waitingLabel(t), cls: 'state-queued' };
}

/** True if this file is already being (or was) downloaded successfully. */
export function pendingDownloadFor(username, filename) {
  return transfers.some((t) => t.username === username && t.filename === filename && !isFailed(t.state));
}

/** Why the download of this file failed ("Expiré", "Refusé"…), or '' if it did not. */
export function failedDownloadLabel(username, filename) {
  const failed = transfers.find((t) => t.username === username && t.filename === filename && isFailed(t.state));
  return failed ? stateDisplay(failed).label : '';
}

/** True if a download of this playlist track is listed (running, failed or finished). */
export function hasTransferForTrack(trackId) {
  return withTransfer.has(trackId);
}

/**
 * Ask slskd for a file. It counts at once, while the user is contacted, for
 * hasTransferForTrack (no second download of the track) and activeDownloadsWith
 * (the next choice of user), until a pushed list has it.
 */
export async function requestDownload(username, filename, size, trackId) {
  // A new source replaces the failed downloads of the track. The same file
  // must leave slskd's list before being asked again (as a retry does).
  const failed = trackId ? transfers.filter((t) => t.trackId === trackId && isFailed(t.state)) : [];
  const sameFile = failed.filter((t) => t.username === username && t.filename === filename);
  const removeAll = (list) => Promise.all(list.map((t) => api.slskd.cancelDownload(t.username, t.id, t.filename, true)))
    // Already gone from slskd (removed meanwhile): nothing to do
    .catch((err) => console.warn('[Downloads] Could not remove a failed download:', err));
  await removeAll(sameFile);

  const request = { username, filename, trackId, at: Date.now() };
  requests.push(request);
  rebuild();
  try {
    await api.slskd.download(username, filename, size, trackId);
  } catch (err) {
    requests = requests.filter((r) => r !== request);
    rebuild();
    throw err;
  }
  request.at = Date.now(); // Asking may take long: the timeout counts from the answer
  await removeAll(failed.filter((t) => !sameFile.includes(t)));
}

/** Our downloads from this user that are not finished (waiting or running). */
export function activeDownloadsWith(username) {
  return activeByUser.get(username) || 0;
}

/** The most relevant transfer for a playlist track (active first, then failed). */
export function transferForTrack(trackId) {
  return byTrack.get(trackId) || null;
}

/** Recompute the per-track and per-user lookups from the list and the pending requests. */
function rebuild() {
  byTrack = new Map();
  withTransfer = new Set();
  activeByUser = new Map();
  for (const t of transfers) {
    if (!isFinished(t.state)) activeByUser.set(t.username, activeDownloadsWith(t.username) + 1);
    if (!t.trackId) continue;
    withTransfer.add(t.trackId);
    if (isSucceeded(t.state)) continue;
    const current = byTrack.get(t.trackId);
    if (!current || (isFinished(current.state) && !isFinished(t.state))) byTrack.set(t.trackId, t);
  }
  const now = Date.now();
  requests = requests.filter((r) => now - r.at < REQUEST_TIMEOUT && !transfers.some(
    (t) => t.username === r.username && t.filename === r.filename && !isFailed(t.state),
  ));
  for (const r of requests) {
    activeByUser.set(r.username, activeDownloadsWith(r.username) + 1);
    if (r.trackId) withTransfer.add(r.trackId);
  }
}

function setTransfers(next) {
  transfers = next || [];
  rebuild();
  const active = transfers.filter((t) => !isFinished(t.state)).length;
  navBadge.textContent = active;
  navBadge.hidden = active === 0;
  if ($('#view-downloads').classList.contains('active')) render();
  bus.emit('downloads:changed');
}

const EMPTY_TEXTS = {
  downloads: ['Aucun téléchargement', 'Les téléchargements lancés depuis Soulseek apparaîtront ici'],
  uploads: ['Aucun envoi', 'Les fichiers que les autres utilisateurs téléchargent chez vous apparaîtront ici'],
};

export function render() {
  const items = mode === 'uploads' ? uploads : transfers;
  // Rebuilding identical rows would only lose clicks and text selection
  const signature = mode + JSON.stringify(items);
  if (signature === renderedSignature) return;
  renderedSignature = signature;

  const active = items.filter((t) => !isFinished(t.state));
  const done = items.filter((t) => isSucceeded(t.state));
  const failed = items.filter((t) => isFailed(t.state));
  const isDownloads = mode === 'downloads';

  summary.innerHTML = `
    <div class="dl-summary-item"><span class="dl-summary-value state-active">${active.length}</span><span class="dl-summary-label">En cours</span></div>
    <div class="dl-summary-item"><span class="dl-summary-value state-done">${done.length}</span><span class="dl-summary-label">Terminés</span></div>
    <div class="dl-summary-item"><span class="dl-summary-value state-error">${failed.length}</span><span class="dl-summary-label">Échoués</span></div>`;
  $('#dl-clear-done').hidden = !isDownloads || done.length === 0;
  $('#dl-clear-failed').hidden = !isDownloads || failed.length === 0;

  if (items.length === 0) {
    [emptyTitle.textContent, emptyText.textContent] = EMPTY_TEXTS[mode];
    list.replaceChildren(emptyState);
    return;
  }

  rendered = [...active, ...failed.reverse(), ...done.reverse()];
  list.innerHTML = rendered.map((t, i) => {
    const { label, cls } = stateDisplay(t);
    const pct = Math.round(t.percentComplete);
    const running = !isFinished(t.state);
    const failedRow = isFailed(t.state);
    const presence = isRemotelyQueued(t) && t.userPresence ? t.userPresence : '';
    const sizeText = running ? `${formatSize(t.bytesTransferred)} / ${formatSize(t.size)}` : formatSize(t.size);
    // Waiting in a remote queue: its speed replaces the (empty) progress bar
    const progress = isRemotelyQueued(t) && t.placeInQueue
      ? queueProgress(t)
      : running
      ? `<span class="dl-speed">${t.averageSpeed > 0 ? formatSpeed(t.averageSpeed) : '—'}</span><div class="dl-progress-bar"><div class="dl-progress-fill" style="width: ${pct}%"></div></div><span class="dl-pct">${pct}%</span>`
      : '';
    // Uploads are only shown: slskd manages them
    // Same order on every row, the close button always last (cancel or remove)
    const actions = isDownloads && [
      failedRow && `<button class="dl-action-btn dl-retry" title="Réessayer avec la même source" data-action="retry">${icon(ICONS.retry)}</button>`,
      (failedRow || isRemotelyQueued(t)) && t.trackId && `<button class="dl-action-btn dl-other" title="Choisir une autre source" data-action="other">${icon(ICONS.search)}</button>`,
      running && `<button class="dl-action-btn dl-cancel" title="Annuler" data-action="cancel">${icon(ICONS.close)}</button>`,
      failedRow && `<button class="dl-action-btn dl-cancel" title="Retirer de la liste" data-action="remove">${icon(ICONS.close)}</button>`,
    ].filter(Boolean).join('');

    return `<div class="dl-row" data-index="${i}">
      <span class="dl-col-name" title="${escapeHtml(t.filename)}">${escapeHtml(baseName(t.filename))}</span>
      <span class="dl-col-user">${userLabel(t.username, presence, PRESENCE_LABELS[presence])}</span>
      <span class="dl-col-size">${sizeText}</span>
      <span class="dl-col-state ${cls}" title="${escapeHtml(label)}">${escapeHtml(label)}</span>
      <span class="dl-col-progress">${progress}</span>
      <span class="dl-col-actions">${actions || ''}</span>
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

// ─── Uploads tab ────────────────────────────────────────────
async function refreshUploads() {
  uploads = await api.slskd.getUploads().catch(() => uploads);
  if (mode === 'uploads') render();
}

$('#dl-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-mode]');
  if (!tab || tab.dataset.mode === mode) return;
  mode = tab.dataset.mode;
  for (const b of $('#dl-tabs').children) b.classList.toggle('active', b === tab);
  render();
  if (mode === 'uploads') refreshUploads();
});

// Polled only while the uploads are on screen
setInterval(() => {
  if (mode === 'uploads' && $('#view-downloads').classList.contains('active')) refreshUploads();
}, 3000);

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
  // On error, the known list stays: an empty one would hide every transfer from the auto-search
  const next = await api.slskd.getDownloads().catch(() => null);
  if (next) setTransfers(next);
}
