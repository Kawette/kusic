// ─── Conflict resolution modal ──────────────────────────────
// Shows the existing and the incoming file (or duplicate) side by side, each
// above its button; the user picks which one to keep. The other one goes to
// the Windows trash.

import {
  $, api, bus, closeModal, durationBand, escapeHtml, formatBadge, formatDuration, formatSize,
  formatTime, icon, ICONS, isPlayable, openModal, qualityLabel, showToast, thumb, toastError,
  withBusyButton,
} from './ui.js';
import { isPlaying, playFile } from './player.js';

const modal = $('#conflict-modal');
const body = $('#conflict-body');
let current = null;
let busy = false;

function fileCard(title, file, track) {
  if (!file.exists) {
    return `<div class="conflict-card"><h4>${title}</h4><p class="muted">Fichier introuvable</p>
      <p class="conflict-path">${escapeHtml(file.path)}</p></div>`;
  }
  const mismatch = durationBand(file.duration, track.duration) === 2 && file.duration && track.duration;
  return `<div class="conflict-card">
    <div class="conflict-card-head">
      <span title="${file.artwork ? 'Pochette du fichier' : 'Pas de pochette dans le fichier'}">${thumb(file.artwork, 'conflict-art')}</span>
      <div>
        <h4>${title}</h4>
        <div class="conflict-quality">${formatBadge(file.format)} <span>${escapeHtml(qualityLabel(file))}</span>
          ${file.bitDepth ? `<span>${file.bitDepth} bits</span>` : ''}</div>
      </div>
    </div>
    <dl>
      <dt>Durée</dt><dd class="${mismatch ? 'duration-mismatch' : ''}">${formatDuration(file.duration)}${mismatch ? ' (≠ piste)' : ''}</dd>
      <dt>Taille</dt><dd>${formatSize(file.size)}</dd>
      <dt>Lié à</dt><dd>${file.linkedTo.length ? file.linkedTo.map(escapeHtml).join('<br>') : '—'}</dd>
    </dl>
    <p class="conflict-path" title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</p>
    <div class="conflict-buttons">
      ${isPlayable(file.format) ? `<button class="player-btn" data-play="${escapeHtml(file.path)}" title="Écouter"></button>` : ''}
      <button class="btn-secondary btn-small" data-show="${escapeHtml(file.path)}">Afficher dans le dossier</button>
    </div>
  </div>`;
}

async function openConflict(id) {
  const conflicts = await api.getConflicts();
  current = conflicts.find((c) => c.id === id);
  if (!current) return;
  const { track } = current;
  const existingGone = !current.existingFile.exists;
  // Duplicates are two files already in the library, found by a scan
  const duplicate = current.reason === 'duplicate';
  const explanation = {
    'already-linked': 'La piste a déjà un fichier dans la bibliothèque.',
    'same-name': 'Un fichier porte déjà ce nom dans la bibliothèque.',
    duplicate: 'Deux fichiers de la bibliothèque sont liés à la même piste.',
  }[current.reason];

  body.innerHTML = `
    <p class="modal-desc">
      ${explanation}
      ${duplicate ? 'Détecté' : 'Téléchargé'} le ${formatTime(current.createdAt)}.
    </p>
    <div class="conflict-compare">
      ${fileCard(duplicate ? 'Fichier de la piste' : 'Fichier existant', current.existingFile, track)}
      ${fileCard(duplicate ? 'Doublon' : 'Nouveau fichier', current.newFile, track)}
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" data-choice="keep-existing" ${existingGone ? 'disabled title="Le fichier existant a disparu"' : ''}>${duplicate ? 'Garder le fichier de la piste' : "Garder l'existant"}</button>
      <button class="btn-primary" data-choice="replace">${duplicate ? 'Garder le doublon' : 'Remplacer par le nouveau'}</button>
    </div>
    <p class="setting-help">Le fichier écarté est envoyé à la corbeille Windows.</p>`;
  renderPlayButtons();
  openModal(modal, () => { current = null; });
}

function renderPlayButtons() {
  for (const btn of body.querySelectorAll('[data-play]')) {
    const playing = isPlaying(btn.dataset.play);
    btn.innerHTML = icon(playing ? ICONS.pause : ICONS.play, 14);
    btn.title = playing ? 'Pause' : 'Écouter';
  }
}

bus.on('player:changed', renderPlayButtons);

body.addEventListener('click', async (e) => {
  const show = e.target.closest('[data-show]');
  if (show) {
    api.showInFolder(show.dataset.show).catch(toastError);
    return;
  }
  const play = e.target.closest('[data-play]');
  if (play && current) {
    const title = play.closest('.conflict-card').querySelector('h4').textContent;
    playFile(play.dataset.play, { title, artist: `${current.track.artist} — ${current.track.title}` });
    return;
  }
  const btn = e.target.closest('[data-choice]');
  if (!btn || !current || busy) return;
  const conflict = current;
  // One decision at a time: both choices are locked while it runs
  busy = true;
  body.querySelectorAll('[data-choice]').forEach((b) => { b.disabled = true; });
  try {
    await withBusyButton(btn, () => api.resolveConflict(conflict.id, btn.dataset.choice));
    showToast(btn.dataset.choice === 'replace' ? 'Fichier remplacé' : 'Fichier existant conservé', 'success');
    // The modal may have been reopened for another conflict meanwhile
    if (current === conflict) closeModal(modal);
  } catch (err) {
    toastError(err);
    if (current === conflict) {
      body.querySelectorAll('[data-choice]').forEach((b) => {
        b.disabled = b.dataset.choice === 'keep-existing' && !conflict.existingFile.exists;
      });
    }
  } finally {
    busy = false;
  }
});

bus.on('conflict:open', (id) => openConflict(id).catch(toastError));
