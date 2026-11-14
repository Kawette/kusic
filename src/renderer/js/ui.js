// ─── Shared UI helpers ──────────────────────────────────────

export const api = window.kusic;

export const $ = (sel) => document.querySelector(sel);
export const $$ = (sel) => document.querySelectorAll(sel);

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Escape a value for use in HTML text and quoted attributes. */
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

export const ICONS = {
  download: '<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  retry: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>',
  export: '<path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>',
  upgrade: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  play: '<polygon points="6 4 20 12 6 20 6 4" fill="currentColor"/>',
  pause: '<rect x="6" y="4" width="4" height="16" fill="currentColor"/><rect x="14" y="4" width="4" height="16" fill="currentColor"/>',
  more: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  warning: '<path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
};

export function icon(paths, size = 14) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${paths}</svg>`;
}

export const SPINNER = '<svg class="spinner" width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="3" stroke-dasharray="30 70"/></svg>';

export const SOURCE_LABELS = {
  spotify: 'Spotify',
  soundcloud: 'SoundCloud',
  local: 'Local',
  unknown: 'Inconnu',
};

const LOSSLESS = ['FLAC', 'WAV', 'AIFF', 'AIF', 'ALAC', 'APE'];

export const isLossless = (format) => LOSSLESS.includes((format || '').toUpperCase());

/** Formats the built-in player can read (keep in sync with MIME in main/library/audio.ts) */
const PLAYABLE = ['MP3', 'FLAC', 'WAV', 'M4A', 'AAC', 'OGG', 'OPUS'];

export const isPlayable = (format) => PLAYABLE.includes((format || '').toUpperCase());

/** File name of a local or Soulseek path. */
export const baseName = (filePath) => (filePath || '').split(/[\\/]/).pop();

export function sourceBadge(source) {
  return `<span class="source-badge ${escapeHtml(source)}">${SOURCE_LABELS[source] || SOURCE_LABELS.unknown}</span>`;
}

/** Soulseek user name with a status dot (class of the dot, '' when unknown). */
export function userLabel(username, dot, tooltip) {
  return `<span class="user-label"${tooltip ? ` data-tooltip="${escapeHtml(tooltip)}"` : ''}>`
    + `<span class="user-dot ${dot}"></span><span class="user-name">${escapeHtml(username)}</span></span>`;
}

/** Artwork image, or an empty placeholder of the same size. */
export function thumb(url, cls) {
  return url
    ? `<img class="${cls}" src="${escapeHtml(url)}" alt="" loading="lazy">`
    : `<span class="${cls} thumb-empty">${icon(ICONS.music)}</span>`;
}

/** Up to this gap, a file has the same length as the track. */
const DURATION_SAME_MS = 3000;
/** Above this gap, a file's duration is flagged as another version of the track. */
const DURATION_TOLERANCE_MS = 15000;

/** 0: same length, 1: close, 2: another version or unknown. */
export function durationBand(lengthMs, referenceMs) {
  if (!lengthMs || !referenceMs) return 2;
  const gap = Math.abs(lengthMs - referenceMs);
  return gap <= DURATION_SAME_MS ? 0 : gap <= DURATION_TOLERANCE_MS ? 1 : 2;
}

/** Cache key; must stay identical to normalizeQuery in main/search-cache.ts. */
export function normalizeQuery(query) {
  return query.toLowerCase().trim().replace(/\s+/g, ' ');
}

export function formatDuration(ms) {
  if (!ms) return '—';
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

/** Green when a length matches the reference, orange when clearly another version. */
export function durationMatch(lengthMs, referenceMs) {
  if (!lengthMs || !referenceMs) return { cls: '', title: '' };
  const band = durationBand(lengthMs, referenceMs);
  if (band === 0) return { cls: 'duration-ok', title: 'Même durée' };
  if (band === 2) {
    return { cls: 'duration-mismatch', title: `Durée très différente (${formatDuration(referenceMs)}) : probablement une autre version` };
  }
  return { cls: '', title: `Écart de ${Math.round(Math.abs(lengthMs - referenceMs) / 1000)} s` };
}

export function formatSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

export function formatSpeed(bytesPerSec) {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} o/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(0)} Ko/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} Mo/s`;
}

export function formatTime(timestamp) {
  return new Date(timestamp).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** "44.1 kHz" for lossless files, "320 kbps" otherwise */
export function qualityLabel({ format, bitRate, sampleRate }) {
  if (isLossless(format) && sampleRate) return `${(sampleRate / 1000).toFixed(1)} kHz`;
  if (bitRate) return `${bitRate} kbps`;
  return '';
}

export function formatBadge(format) {
  const fmt = (format || '?').toUpperCase();
  const cls = ['FLAC', 'MP3', 'WAV'].includes(fmt) ? fmt.toLowerCase() : 'other';
  return `<span class="format-badge ${cls}">${escapeHtml(fmt)}</span>`;
}

// ─── Toasts ─────────────────────────────────────────────────
export function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  $('#toast-container').appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 200);
  }, type === 'error' ? 6000 : 4000);
}

export function errorMessage(err) {
  // IPC errors arrive as "Error invoking remote method 'x': Error: message"
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
}

/** `.catch(toastError)` for fire-and-forget calls from event handlers. */
export function toastError(err) {
  showToast(`Erreur : ${errorMessage(err)}`, 'error');
}

// ─── Modals ─────────────────────────────────────────────────
const modalCloseHandlers = new Map();

/** Show a modal overlay; `onClose` runs when it is closed by any means. */
export function openModal(el, onClose) {
  el.hidden = false;
  if (onClose) modalCloseHandlers.set(el, onClose);
  (el.querySelector('input:not([type=checkbox])') || el.querySelector('.modal-actions button'))?.focus();
}

export function closeModal(el) {
  if (el.hidden) return;
  el.hidden = true;
  const onClose = modalCloseHandlers.get(el);
  modalCloseHandlers.delete(el);
  onClose?.();
}

export function closeAllModals() {
  $$('.modal-overlay').forEach(closeModal);
}

// Backdrop clicks and [data-close-modal] buttons close their modal. A drag
// that starts inside the modal and ends on the backdrop is not a click on it.
let pressedOn = null;
document.addEventListener('mousedown', (e) => { pressedOn = e.target; });
document.addEventListener('click', (e) => {
  const overlay = e.target.closest('.modal-overlay');
  if (!overlay) return;
  const onBackdrop = e.target === overlay && pressedOn === overlay;
  if (onBackdrop || e.target.closest('[data-close-modal]')) closeModal(overlay);
});

// Hide images that fail to load (artwork URLs can expire or be blocked by CSP)
document.addEventListener('error', (e) => {
  if (e.target instanceof HTMLImageElement) e.target.style.visibility = 'hidden';
}, true);

// ─── Context menu ───────────────────────────────────────────
let openMenu = null;

function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

/**
 * Show a small menu at (x, y). `items`: { label, action, danger? } or
 * 'separator'. Closes on click anywhere, Escape, scroll or resize.
 */
export function showMenu(x, y, items) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  const actions = [];
  menu.innerHTML = items.map((item) => {
    if (item === 'separator') return '<div class="context-menu-separator"></div>';
    actions.push(item.action);
    return `<button role="menuitem" class="${item.danger ? 'danger' : ''}" data-index="${actions.length - 1}">${escapeHtml(item.label)}</button>`;
  }).join('');
  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-index]');
    if (!btn) return;
    closeMenu();
    actions[btn.dataset.index]();
  });
  document.body.appendChild(menu);

  // Keep the menu inside the window
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - height - 8)}px`;
  openMenu = menu;
  menu.querySelector('button')?.focus();
}

document.addEventListener('mousedown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
}, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('resize', closeMenu);
document.addEventListener('scroll', closeMenu, true);

/** Replace a button's content with a spinner while `fn` runs. */
export async function withBusyButton(btn, fn) {
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = SPINNER;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

/** Minimal event bus between views. */
const listeners = new Map();
export const bus = {
  on(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
  },
  emit(event, payload) {
    listeners.get(event)?.forEach((fn) => fn(payload));
  },
};
