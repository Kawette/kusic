// ─── Soulseek search: sessions, modal, auto-search ─────────
// One search session per normalized query, shared by the modal and the
// auto-search. The modal only displays the session of the query it shows,
// so late results of another search can never appear in it.

import {
  $, api, bus, closeModal, errorMessage, escapeHtml, formatBadge, formatDuration,
  formatSize, formatTime, icon, ICONS, normalizeQuery, openModal, showToast, trackQuery,
} from './ui.js';
import { pendingDownloadFor } from './downloads.js';

const AUTO_SEARCH_CONCURRENCY = 3;
const AUTO_SEARCH_DELAY = 5000;
const PAGE_SIZE = 100;
const DURATION_TOLERANCE_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Cache mirror (counts only, results stay in main) ───────
const cacheSummary = new Map(); // key -> { count, timestamp }

export async function loadCacheSummary() {
  const summary = await api.searchCache.summary();
  cacheSummary.clear();
  for (const [key, entry] of Object.entries(summary)) cacheSummary.set(key, entry);
}

/** Cached result count for a track's query, or undefined if not cached. */
export function cachedCount(track) {
  return cacheSummary.get(normalizeQuery(trackQuery(track)))?.count;
}

// ─── Sessions ───────────────────────────────────────────────
const sessions = new Map(); // key -> session

export function isSearching(track) {
  return sessions.has(normalizeQuery(trackQuery(track)));
}

function notify(session) {
  // Ignore sessions replaced by a newer search for the same query
  const current = sessions.get(session.key) ?? session;
  if (shown?.key === session.key && current === session) renderSession(session);
}

/** Start (or join) the search for `query`. `force` restarts it, ignoring the cache. */
function runSearch(query, { force = false } = {}) {
  const key = normalizeQuery(query);
  const existing = sessions.get(key);
  if (existing && !force) return existing;
  if (existing) cancelSession(existing);

  const session = { query, key, id: null, results: [], fileCount: 0, complete: false, cancelled: false, error: null };
  sessions.set(key, session);
  bus.emit('search:changed', key);

  session.promise = (async () => {
    try {
      const { id } = await api.slskd.search(query);
      session.id = id;
      let loadedCount = 0;
      for (let tick = 0; !session.cancelled; tick++) {
        await sleep(tick < 6 ? 500 : 1000);
        if (session.cancelled) break;
        // Cheap status poll; full results only when new files arrived
        const status = await api.slskd.getSearchResults(id, false);
        session.fileCount = status.fileCount;
        if (status.isComplete || (status.fileCount > loadedCount && tick % 2 === 1)) {
          const data = await api.slskd.getSearchResults(id, true);
          if (session.cancelled) break;
          loadedCount = status.fileCount;
          session.results = data.results;
        }
        notify(session);
        if (status.isComplete) break;
      }
      if (!session.cancelled) {
        await api.searchCache.set(query, session.results);
        cacheSummary.set(key, { count: session.results.length, timestamp: Date.now() });
      }
    } catch (err) {
      session.error = errorMessage(err);
    } finally {
      session.complete = true;
      if (sessions.get(key) === session) sessions.delete(key);
      notify(session);
      bus.emit('search:changed', key);
    }
  })();
  return session;
}

function cancelSession(session) {
  session.cancelled = true;
  if (session.id) api.slskd.cancelSearch(session.id).catch(() => {});
  if (sessions.get(session.key) === session) sessions.delete(session.key);
  bus.emit('search:changed', session.key);
}

// ─── Modal ──────────────────────────────────────────────────
const modal = $('#slskd-modal');
const queryInput = $('#slskd-search-query');
const statusEl = $('#slskd-search-status');
const resultsList = $('#slskd-results-list');
const targetEl = $('#slskd-target');
const filters = {
  format: $('#result-format'),
  bitrate: $('#result-bitrate'),
  freeSlots: $('#result-free-slots'),
  sort: $('#result-sort'),
};

let shown = null; // { key, query, track } displayed in the modal
let currentResults = [];
let visible = []; // filtered + sorted results currently rendered
let limit = PAGE_SIZE;
const startedDownloads = new Set(); // "username\0filename" started from the modal

async function ensureConnected() {
  const status = await api.slskd.getStatus();
  if (status.connected) return true;
  showToast(
    status.running || status.starting
      ? 'Soulseek est en cours de connexion, réessayez dans un instant'
      : 'Démarrez Soulseek dans les paramètres',
    'error',
  );
  return false;
}

/**
 * Open the search modal for a playlist track (or a free query).
 * `options.format` presets the format filter (e.g. "flac" to upgrade a file).
 */
export async function openSearch(track, options = {}) {
  if (!(await ensureConnected())) return;

  const query = options.query || trackQuery(track);
  shown = { key: normalizeQuery(query), query, track };
  filters.format.value = options.format || '';
  filters.bitrate.value = '0';
  filters.freeSlots.checked = false;
  filters.sort.value = 'quality';
  queryInput.value = query;

  targetEl.hidden = !track;
  if (track) {
    targetEl.innerHTML = `Pour : <strong>${escapeHtml(track.artist)} — ${escapeHtml(track.title)}</strong>
      <span class="muted">(${formatDuration(track.duration)}${track.format ? `, fichier actuel ${escapeHtml(track.format)}` : ''})</span>`;
  }

  openModal(modal, () => { shown = null; });
  showQuery(query);
}

async function showQuery(query, { force = false } = {}) {
  const key = normalizeQuery(query);
  shown = { ...shown, key, query };
  limit = PAGE_SIZE;

  if (!force && !sessions.has(key)) {
    const cached = await api.searchCache.get(query);
    if (shown?.key !== key) return;
    if (cached) {
      currentResults = cached.results;
      renderResults(false);
      statusEl.textContent = `${cached.results.length} résultats · en cache (${formatTime(cached.timestamp)})`;
      return;
    }
  }

  currentResults = [];
  resultsList.innerHTML = '<div class="slskd-loading"><p>Recherche sur le réseau Soulseek...</p></div>';
  statusEl.textContent = 'Recherche...';
  renderSession(runSearch(query, { force }));
}

function renderSession(session) {
  currentResults = session.results;
  if (session.error) {
    statusEl.textContent = `Erreur : ${session.error}`;
  } else if (session.complete) {
    statusEl.textContent = session.cancelled ? 'Recherche annulée' : `${session.results.length} résultats`;
  } else {
    statusEl.textContent = `Recherche... ${session.fileCount} fichiers`;
  }
  renderResults(!session.complete);
}

const LOSSLESS_EXT = ['flac', 'wav', 'alac', 'ape', 'aiff'];

function applyFilters(results) {
  const format = filters.format.value;
  const minBitrate = Number(filters.bitrate.value);
  const target = shown?.track?.duration;
  const durationGap = (r) => (target && r.length ? Math.abs(r.length * 1000 - target) : Infinity);

  const filtered = results.filter((r) => {
    if (format === 'lossless' && !LOSSLESS_EXT.includes(r.extension)) return false;
    if (format && format !== 'lossless' && r.extension !== format) return false;
    if (minBitrate && !LOSSLESS_EXT.includes(r.extension) && (r.bitRate || 0) < minBitrate) return false;
    if (filters.freeSlots.checked && !r.freeUploadSlots) return false;
    return true;
  });

  const sorters = {
    quality: (a, b) => b.quality - a.quality,
    duration: (a, b) => durationGap(a) - durationGap(b) || b.quality - a.quality,
    speed: (a, b) => b.uploadSpeed - a.uploadSpeed,
    size: (a, b) => b.size - a.size,
  };
  return filtered.sort(sorters[filters.sort.value] || sorters.quality);
}

function downloadKey(r) {
  return `${r.username}\u0000${r.filename}`;
}

function renderResults(searching) {
  const all = applyFilters([...currentResults]);
  visible = all.slice(0, limit);

  if (visible.length === 0) {
    resultsList.innerHTML = searching
      ? '<div class="slskd-loading"><p>Recherche sur le réseau Soulseek...</p></div>'
      : `<div class="slskd-no-results"><p>${currentResults.length ? 'Aucun résultat avec ces filtres' : 'Aucun résultat trouvé'}</p></div>`;
    return;
  }

  const target = shown?.track?.duration;
  const rows = visible.map((r, i) => {
    const name = r.filename.split(/[\\/]/).pop();
    const quality = [r.bitRate && `${r.bitRate} kbps`, r.sampleRate && `${(r.sampleRate / 1000).toFixed(1)} kHz`]
      .filter(Boolean).join(' · ') || '—';
    const gap = target && r.length ? Math.abs(r.length * 1000 - target) : 0;
    const durationCls = gap > DURATION_TOLERANCE_MS ? 'duration-mismatch' : '';
    const durationTitle = gap > DURATION_TOLERANCE_MS ? `Durée différente de la piste (${formatDuration(target)})` : '';
    const started = startedDownloads.has(downloadKey(r)) || pendingDownloadFor(r.username, r.filename);
    const userInfo = `${r.freeUploadSlots ? 'Slot libre' : 'Pas de slot libre'}${r.queueLength ? ` · file d'attente : ${r.queueLength}` : ''} · ${Math.round(r.uploadSpeed / 1024)} Ko/s`;

    return `<div class="slskd-result-row">
      <span class="result-filename" title="${escapeHtml(r.filename)}">${escapeHtml(name)}</span>
      <span class="result-user" title="${escapeHtml(userInfo)}">${r.freeUploadSlots ? '' : '<span class="no-slot">●</span> '}${escapeHtml(r.username)}</span>
      <span class="result-format">${formatBadge(r.extension)}</span>
      <span class="result-quality">${quality}</span>
      <span class="result-duration ${durationCls}" title="${durationTitle}">${r.length ? formatDuration(r.length * 1000) : '—'}</span>
      <span class="result-size">${formatSize(r.size)}</span>
      <button class="result-download-btn${started ? ' done' : ''}" data-index="${i}" ${started ? 'disabled title="Téléchargement lancé"' : 'title="Télécharger"'}>
        ${icon(started ? ICONS.check : ICONS.download)}
      </button>
    </div>`;
  });

  if (all.length > visible.length) {
    rows.push(`<button class="btn-secondary load-more" id="btn-load-more">Afficher plus (${all.length - visible.length} restants)</button>`);
  }
  resultsList.innerHTML = rows.join('');
}

function rerender() {
  const session = shown && sessions.get(shown.key);
  renderResults(!!session && !session.complete);
}

resultsList.addEventListener('click', async (e) => {
  if (e.target.closest('#btn-load-more')) {
    limit += PAGE_SIZE;
    rerender();
    return;
  }
  const btn = e.target.closest('.result-download-btn');
  if (!btn || btn.disabled) return;
  const result = visible[btn.dataset.index];
  btn.disabled = true;
  try {
    await api.slskd.download(result.username, result.filename, result.size, shown?.track?.id);
    startedDownloads.add(downloadKey(result));
    btn.classList.add('done');
    btn.innerHTML = icon(ICONS.check);
    showToast('Téléchargement lancé', 'success');
  } catch (err) {
    btn.disabled = false;
    showToast(`Erreur : ${errorMessage(err)}`, 'error');
  }
});

Object.values(filters).forEach((el) => el.addEventListener('change', () => {
  limit = PAGE_SIZE;
  rerender();
}));

function submitQuery(force) {
  const query = queryInput.value.trim();
  if (query && shown) showQuery(query, { force });
}

$('#slskd-search-btn').addEventListener('click', () => submitQuery(true));
queryInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitQuery(false);
});

export function closeSearch() {
  closeModal(modal);
}

// ─── Auto-search ────────────────────────────────────────────
// Searches only: results are cached for the user to choose from, nothing is
// downloaded automatically.
const autoBtn = $('#btn-auto-search');
const autoText = $('#auto-search-text');
const autoStatus = $('#auto-search-status');
let auto = null; // { queue, total, done, sessions }
let autoStarting = false;

function renderAutoState() {
  autoBtn.classList.toggle('active', !!auto);
  autoText.textContent = auto ? 'Arrêter' : 'Recherche auto';
  autoStatus.textContent = auto ? `${auto.done}/${auto.total}` : '';
}

/** `tracks`: the tracks currently displayed. */
export async function toggleAutoSearch(tracks) {
  if (auto) {
    stopAutoSearch(`Recherche arrêtée (${auto.done}/${auto.total})`);
    return;
  }
  if (autoStarting) return;
  autoStarting = true;
  try {
    if (!(await ensureConnected())) return;
    const keys = new Set();
    const queue = [];
    for (const track of tracks) {
      if (track.format || !track.playlistIds) continue;
      const query = trackQuery(track);
      const key = normalizeQuery(query);
      if (keys.has(key) || cacheSummary.has(key) || sessions.has(key)) continue;
      keys.add(key);
      queue.push(query);
    }
    if (queue.length === 0) {
      showToast('Toutes les pistes affichées ont déjà des résultats en cache', 'success');
      return;
    }

    const run = { queue, total: queue.length, done: 0, sessions: new Set() };
    auto = run;
    renderAutoState();
    const workers = Array.from({ length: Math.min(AUTO_SEARCH_CONCURRENCY, queue.length) },
      (_, i) => autoWorker(run, i * AUTO_SEARCH_DELAY));
    Promise.all(workers).then(() => {
      if (auto === run) stopAutoSearch(`Recherche terminée (${run.done} pistes)`, 'success');
    });
  } finally {
    autoStarting = false;
  }
}

async function autoWorker(run, initialDelay) {
  await sleep(initialDelay);
  while (auto === run && run.queue.length > 0) {
    const query = run.queue.shift();
    const key = normalizeQuery(query);
    if (!cacheSummary.has(key)) {
      const session = runSearch(query);
      run.sessions.add(session);
      await session.promise;
      run.sessions.delete(session);
      if (session.error && auto === run) {
        const status = await api.slskd.getStatus().catch(() => ({}));
        if (!status.connected) {
          stopAutoSearch('Soulseek est déconnecté : recherche auto arrêtée', 'error');
          return;
        }
      }
    }
    if (auto !== run) return;
    run.done++;
    renderAutoState();
    if (run.queue.length > 0) await sleep(AUTO_SEARCH_DELAY);
  }
}

function stopAutoSearch(message, type = 'info') {
  const run = auto;
  auto = null;
  // Cancel in-flight searches, except the one displayed in the modal
  for (const session of run?.sessions || []) {
    if (shown?.key !== session.key) cancelSession(session);
  }
  renderAutoState();
  if (message) showToast(message, type);
}
