// ─── Kusic Renderer entry point ─────────────────────────────

import { $, $$, api, closeAllModals, toastError } from './ui.js';
import { loadTracks, updateStats } from './tracks.js';
import { loadPlaylists } from './playlists.js';
import { loadConflicts, refreshDownloads, render as renderDownloads } from './downloads.js';
import { loadCacheSummary } from './search.js';
import {
  flushSettings, loadSettings, refreshStatus, startStatusPolling, stopStatusPolling,
} from './settings.js';
import './conflicts.js';

let currentView = 'tracks';

function switchView(view) {
  if (view === currentView && view !== 'tracks') return;
  if (currentView === 'settings' && view !== 'settings') {
    flushSettings();
    stopStatusPolling();
  }
  currentView = view;

  $$('.nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === view);
    b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');
  });
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));

  if (view === 'tracks') loadTracks();
  if (view === 'playlists') loadPlaylists();
  if (view === 'downloads') {
    renderDownloads();
    refreshDownloads();
    loadConflicts();
  }
  if (view === 'settings') {
    loadSettings().catch(toastError);
    startStatusPolling();
  }
}

$$('.nav-btn').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));

document.addEventListener('keydown', (e) => {
  // Ctrl+F → search tracks
  if (e.ctrlKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    closeAllModals();
    switchView('tracks');
    $('#search-input').focus();
  }
  if (e.key === 'Escape') closeAllModals();
});

// The library changed in the main process (scan, download placed, conflict…)
api.onLibraryChanged(() => {
  loadCacheSummary().catch(() => {});
  if (currentView === 'tracks') loadTracks();
  else updateStats();
  loadPlaylists();
  loadConflicts();
});

async function init() {
  await loadCacheSummary().catch(() => {});
  await Promise.allSettled([loadTracks(), loadPlaylists(), loadConflicts()]);
  refreshDownloads();
  refreshStatus();
}

init();
