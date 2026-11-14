// ─── Conflict resolution modal ──────────────────────────────
// Shows the incoming and the existing file side by side; the user picks
// which one to keep. The other one goes to the Windows trash.

import {
  $, api, bus, closeModal, errorMessage, escapeHtml, formatBadge, formatDuration,
  formatSize, formatTime, openModal, qualityLabel, showToast, withBusyButton,
} from './ui.js';
import { loadConflicts } from './downloads.js';

const modal = $('#conflict-modal');
const body = $('#conflict-body');
let current = null;

function fileCard(title, file, track) {
  if (!file.exists) {
    return `<div class="conflict-card"><h4>${title}</h4><p class="muted">Fichier introuvable</p>
      <p class="conflict-path">${escapeHtml(file.path)}</p></div>`;
  }
  const gap = track.duration && file.duration ? Math.abs(file.duration - track.duration) : 0;
  return `<div class="conflict-card">
    <h4>${title}</h4>
    <div class="conflict-quality">${formatBadge(file.format)} <span>${escapeHtml(qualityLabel(file))}</span>
      ${file.bitDepth ? `<span>${file.bitDepth} bits</span>` : ''}</div>
    <dl>
      <dt>Durée</dt><dd class="${gap > 5000 ? 'duration-mismatch' : ''}">${formatDuration(file.duration)}${gap > 5000 ? ' (≠ piste)' : ''}</dd>
      <dt>Taille</dt><dd>${formatSize(file.size)}</dd>
      <dt>Lié à</dt><dd>${file.linkedTo.length ? file.linkedTo.map(escapeHtml).join('<br>') : '—'}</dd>
    </dl>
    <p class="conflict-path" title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</p>
    <button class="btn-secondary btn-small" data-show="${escapeHtml(file.path)}">Afficher dans le dossier</button>
  </div>`;
}

async function openConflict(id) {
  const conflicts = await loadConflicts();
  current = conflicts.find((c) => c.id === id);
  if (!current) return;
  const { track } = current;

  body.innerHTML = `
    <p class="modal-desc">
      <strong>${escapeHtml(track.artist)} — ${escapeHtml(track.title)}</strong> (${formatDuration(track.duration)})<br>
      ${current.reason === 'already-linked'
        ? 'Cette piste a déjà un fichier dans la bibliothèque.'
        : 'Un fichier porte déjà ce nom dans la bibliothèque.'}
      Téléchargé le ${formatTime(current.createdAt)}.
    </p>
    <div class="conflict-compare">
      ${fileCard('Nouveau fichier', current.newFile, track)}
      ${fileCard('Fichier existant', current.existingFile, track)}
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" data-choice="keep-existing">Garder l'existant</button>
      <button class="btn-primary" data-choice="replace">Remplacer par le nouveau</button>
    </div>
    <p class="setting-help">Le fichier écarté est envoyé à la corbeille Windows.</p>`;
  openModal(modal, () => { current = null; });
}

body.addEventListener('click', async (e) => {
  const show = e.target.closest('[data-show]');
  if (show) {
    api.showInFolder(show.dataset.show);
    return;
  }
  const btn = e.target.closest('[data-choice]');
  if (!btn || !current) return;
  try {
    await withBusyButton(btn, () => api.resolveConflict(current.id, btn.dataset.choice));
    showToast(btn.dataset.choice === 'replace' ? 'Fichier remplacé' : 'Fichier existant conservé', 'success');
    closeModal(modal);
    loadConflicts();
  } catch (err) {
    showToast(`Erreur : ${errorMessage(err)}`, 'error');
  }
});

bus.on('conflict:open', openConflict);
