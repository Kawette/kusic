// ─── Local audio player ─────────────────────────────────────
// Plays library files (streamed by the main process via kusic-audio://).

import { $, bus, escapeHtml, icon, showToast } from './ui.js';

const bar = $('#player');
const audio = $('#player-audio');
const toggleBtn = $('#player-toggle');
const seek = $('#player-seek');
const currentEl = $('#player-current');
const totalEl = $('#player-total');
const infoEl = $('#player-info');

const PLAY = '<polygon points="6 4 20 12 6 20 6 4" fill="currentColor"/>';
const PAUSE = '<rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/>';

let currentPath = null;

/** m:ss, 0:00 for unknown values */
const clock = (sec) => {
  const s = Math.floor(Number.isFinite(sec) ? sec : 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const audioUrl = (filePath) => `kusic-audio://file/?path=${encodeURIComponent(filePath)}`;

export function isPlaying(filePath) {
  return currentPath === filePath && !audio.paused;
}

/**
 * Play a local file, or pause/resume it if it is the current one.
 * `meta`: { title, artist, artwork } shown in the bar.
 */
export function playFile(filePath, meta = {}) {
  if (currentPath === filePath) {
    togglePlayback();
    return;
  }
  currentPath = filePath;
  audio.src = audioUrl(filePath);
  infoEl.innerHTML = `
    ${meta.artwork ? `<img class="player-art" src="${escapeHtml(meta.artwork)}" alt="">` : '<span class="player-art"></span>'}
    <span class="player-text">
      <span class="player-title">${escapeHtml(meta.title || filePath.split(/[\\/]/).pop())}</span>
      <span class="player-artist">${escapeHtml(meta.artist || '')}</span>
    </span>`;
  bar.hidden = false;
  document.body.classList.add('has-player');
  audio.play().catch((err) => showToast(`Lecture impossible : ${err.message}`, 'error'));
}

export function playTrack(track) {
  playFile(track.filePath, track);
}

function togglePlayback() {
  if (!currentPath) return;
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function stop() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  currentPath = null;
  bar.hidden = true;
  document.body.classList.remove('has-player');
  bus.emit('player:changed');
}

toggleBtn.addEventListener('click', togglePlayback);
$('#player-close').addEventListener('click', stop);

const renderState = () => {
  toggleBtn.innerHTML = icon(audio.paused ? PLAY : PAUSE, 18);
  toggleBtn.title = audio.paused ? 'Lecture' : 'Pause';
  bus.emit('player:changed');
};
audio.addEventListener('play', renderState);
audio.addEventListener('pause', renderState);
audio.addEventListener('ended', renderState);
audio.addEventListener('error', () => {
  if (currentPath) showToast('Ce fichier ne peut pas être lu', 'error');
});

audio.addEventListener('loadedmetadata', () => {
  seek.max = audio.duration || 0;
  totalEl.textContent = clock(audio.duration);
});

let seeking = false;
audio.addEventListener('timeupdate', () => {
  if (!seeking) seek.value = audio.currentTime;
  currentEl.textContent = clock(audio.currentTime);
});
seek.addEventListener('input', () => { seeking = true; });
seek.addEventListener('change', () => {
  audio.currentTime = Number(seek.value);
  seeking = false;
});

// Space toggles playback when not typing
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || !currentPath || e.target.closest('input, textarea, select, button')) return;
  e.preventDefault();
  togglePlayback();
});
