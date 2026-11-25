// ─── Soulseek search: sessions, modal, validation, auto-search ─
// One search session per normalized query, shared by the modal and the
// auto-search. The modal only displays the session it started or joined,
// so results of another search can never appear in it. The validation chains
// the modal over the tracks that have cached results, one after the other.

import {
  $, api, baseName, bus, closeModal, durationBand, durationMatch, errorMessage, escapeHtml,
  formatBadge, formatDuration, formatSize, formatTime, icon, ICONS, isLossless, normalizeQuery,
  openModal, showToast, sourceBadge, SPINNER, thumb, toastError, userLabel,
} from './ui.js';
import {
  activeDownloadsWith, failedDownloadLabel, hasTransferForTrack, isDownloadingTrack, pendingDownloadFor,
  refreshDownloads, requestDownload,
} from './downloads.js';
import {
  certainMatches, certaintyOf, fallbackQuery, isRelevant, matchDoubts, searchStats, sourceOrder,
  trackQuery,
} from './query.js';

const AUTO_SEARCH_CONCURRENCY = 3;
const AUTO_SEARCH_DELAY = 5000;
/** Certain sources tried in turn when a user cannot be reached. */
const AUTO_DOWNLOAD_TRIES = 3;
const PAGE_SIZE = 100;
const MAX_CACHED_RESULTS = 300; // Same limit as the main-process cache

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Past this age, cached results are searched again before a download is
 * chosen from them (users go offline, queues change). Older entries still
 * give the tracks' statuses.
 */
const FRESH_MS = 15 * 60 * 1000;
const isFresh = (entry) => !!entry && Date.now() - entry.timestamp < FRESH_MS;

// ─── Cache mirror (stats only, results stay in main) ────────
const cacheSummary = new Map(); // key -> { relevant, best, certain, timestamp }

export async function loadCacheSummary() {
  const summary = await api.searchCache.summary();
  cacheSummary.clear();
  for (const [key, entry] of Object.entries(summary)) cacheSummary.set(key, entry);
}

/**
 * A download stands in the way of another one for the track: any listed one
 * for a track without a file; for an upgrade, only one running or asked (the
 * finished ones brought the current file, or failed).
 */
const hasDownloadFor = (track) => (track.format ? isDownloadingTrack(track.id) : hasTransferForTrack(track.id));

// trackQuery runs a dozen regexes and statuses ask for it on every refresh:
// the key is computed once per track object (a sync brings new objects)
const trackKeys = new WeakMap();
function trackKey(track) {
  let key = trackKeys.get(track);
  if (key === undefined) {
    key = normalizeQuery(trackQuery(track));
    trackKeys.set(track, key);
  }
  return key;
}

/** Cached { relevant, best, certain } for a track's query, or undefined if not cached. */
export function cachedStats(track) {
  return cacheSummary.get(trackKey(track));
}

// ─── Sessions ───────────────────────────────────────────────
const sessions = new Map(); // key -> running session

export function isSearching(track) {
  return sessions.has(trackKey(track));
}

/** Run one slskd search and keep `session.results` updated until it completes. */
async function collect(session, query) {
  session.activeQuery = query;
  const { id } = await api.slskd.search(query);
  session.id = id;
  if (session.cancelled) {
    api.slskd.cancelSearch(id).catch(() => {});
    return;
  }
  let loadedCount = 0;
  for (let tick = 0; !session.cancelled; tick++) {
    await sleep(tick < 6 ? 500 : 1000);
    if (session.cancelled) return;
    // Cheap status poll; full results only when new files arrived
    const status = await api.slskd.getSearchResults(id, false);
    session.fileCount = status.fileCount;
    if (status.isComplete || (status.fileCount > loadedCount && tick % 2 === 1)) {
      const data = await api.slskd.getSearchResults(id, true);
      if (session.cancelled) return;
      loadedCount = status.fileCount;
      session.results = data.results.slice(0, MAX_CACHED_RESULTS);
      session.version++;
    }
    notify(session);
    if (status.isComplete) return;
  }
}

/**
 * Start (or join) the search for `query`, made for `track` (relevance).
 * `force` restarts it, ignoring the cache. When `fallback` is given and the
 * query finds nothing relevant, the search is retried with it.
 */
function runSearch(query, track, { force = false, fallback = '' } = {}) {
  const key = normalizeQuery(query);
  const existing = sessions.get(key);
  if (existing && !force) return existing;
  if (existing) cancelSession(existing);

  const session = {
    query, key, track, id: null, results: [], version: 0, fileCount: 0,
    complete: false, cancelled: false, error: null,
  };
  sessions.set(key, session);
  bus.emit('search:changed', key);

  session.promise = (async () => {
    try {
      await collect(session, query);
      if (!session.cancelled && fallback && searchStats(session.results, track).relevant === 0) {
        session.results = [];
        session.version++;
        await collect(session, fallback);
      }
      if (!session.cancelled) {
        const stats = searchStats(session.results, track);
        await api.searchCache.set(query, session.results, stats);
        cacheSummary.set(key, { ...stats, timestamp: Date.now() });
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

/** Search for a playlist track (or join its running search), with the title-only second try. */
function searchTrack(track) {
  return runSearch(trackQuery(track), track, { fallback: fallbackQuery(track) });
}

function cancelSession(session) {
  session.cancelled = true;
  if (session.id) api.slskd.cancelSearch(session.id).catch(() => {});
  if (sessions.get(session.key) === session) sessions.delete(session.key);
  bus.emit('search:changed', session.key);
}

function notify(session) {
  if (shown?.session === session) renderSession(session);
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
  sort: $('#result-sort'),
};
const queueBar = $('#slskd-queue');
const queuePosition = $('#slskd-queue-position');
const queueHint = $('#slskd-queue-hint');
const LOADING_HTML = `<div class="slskd-loading">${SPINNER}<p>Recherche sur le réseau Soulseek…</p></div>`;

/** What the modal displays: the track, and the session or cached results shown. */
let shown = null; // { track, key, session, renderedVersion }
let currentResults = [];
let visible = []; // filtered + sorted results currently rendered
let limit = PAGE_SIZE;
let showOffTopic = false; // results whose file name lacks the title
let relevantCount = 0; // relevant results among currentResults (last render)
let queue = null; // validation: { tracks, index }
let requesting = false; // validation: a download request is in flight

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
 * Open the search modal for a playlist track. `options.format` presets the
 * format filter; by default "lossless" for a track to upgrade, else none.
 */
export async function openSearch(track, options = {}) {
  if (!(await ensureConnected())) return;
  queue = null;
  queueBar.hidden = true;
  openModal(modal, () => { shown = null; });
  await showTrack(track, options);
}

/** Display a track in the (open) modal: its card, then its cached or new results. */
async function showTrack(track, options = {}) {
  shown = { track };
  // An upgrade: only the lossless results matter
  filters.format.value = options.format ?? (canUpgrade(track) ? 'lossless' : '');
  filters.bitrate.value = '0';
  filters.sort.value = 'duration';
  queryInput.value = trackQuery(track);
  // The playlist track, to compare results against
  targetEl.innerHTML = `
    ${thumb(track.artwork, 'slskd-target-art')}
    <div class="slskd-target-info">
      <span class="slskd-target-title">${escapeHtml(track.title)}</span>
      <span class="slskd-target-artist">${escapeHtml(track.artist)}${track.album ? ` · ${escapeHtml(track.album)}` : ''}</span>
    </div>
    ${sourceBadge(track.source)}
    <span class="slskd-target-duration" title="Durée de la piste">${formatDuration(track.duration)}</span>
    ${track.format ? `<span class="slskd-target-file" title="Format du fichier actuel">${formatBadge(track.format)}</span>` : ''}`;
  await showQuery(queryInput.value);
}

async function showQuery(query, { force = false } = {}) {
  const key = normalizeQuery(query);
  const view = { ...shown, key, session: null, renderedVersion: -1 };
  shown = view;

  // Never leave the previous query's results on screen (or clickable)
  limit = PAGE_SIZE;
  showOffTopic = false;
  currentResults = [];
  visible = [];
  resultsList.innerHTML = LOADING_HTML;
  resultsList.scrollTop = 0;
  statusEl.textContent = 'Recherche…';

  if (!force && !sessions.has(key) && isFresh(cacheSummary.get(key))) {
    const cached = await api.searchCache.get(query);
    if (shown !== view) return; // Another query was opened meanwhile
    if (cached) {
      currentResults = cached.results;
      renderResults(false);
      statusEl.textContent = `${resultCount()} · en cache (${formatTime(cached.timestamp)})`;
      return;
    }
  }

  // Only the track's own query gets the title-only second try
  const track = view.track;
  const fallback = key === trackKey(track) ? fallbackQuery(track) : '';
  view.session = runSearch(query, track, { force, fallback });
  renderSession(view.session);
}

/** "5 résultats pertinents (sur 34)" for the results on screen (after a render). */
function resultCount() {
  const n = relevantCount;
  const label = `${n} résultat${n > 1 ? 's' : ''} pertinent${n > 1 ? 's' : ''}`;
  return n === currentResults.length ? label : `${label} (sur ${currentResults.length})`;
}

function renderSession(session) {
  // Rebuild the rows only when results changed (keeps clicks and buttons stable)
  if (shown.renderedVersion !== session.version || session.complete) {
    shown.renderedVersion = session.version;
    currentResults = session.results;
    renderResults(!session.complete);
  }
  const retry = session.activeQuery !== session.query ? ` · 2ᵉ essai avec « ${session.activeQuery} »` : '';
  if (session.error) {
    statusEl.textContent = `Erreur : ${session.error}`;
  } else if (session.complete) {
    statusEl.textContent = session.cancelled ? 'Recherche annulée' : `${resultCount()}${retry}`;
  } else {
    statusEl.textContent = `Recherche… ${session.fileCount} fichiers${retry}`;
  }
}

/** `certainRank`: position of a certain match in the preferred order (Infinity otherwise). */
function applyFilters(results, certainRank = () => Infinity) {
  const format = filters.format.value;
  const minBitrate = Number(filters.bitrate.value);
  const target = shown?.track?.duration;
  const band = (r) => durationBand(r.length && r.length * 1000, target);

  const filtered = results.filter((r) => {
    const lossless = isLossless(r.extension);
    if (format === 'lossless' && !lossless) return false;
    if (format && format !== 'lossless' && r.extension !== format) return false;
    if (minBitrate && !lossless && (r.bitRate || 0) < minBitrate) return false;
    return true;
  });

  // Certain matches first, in the order the automatic download would try them
  const sorters = {
    quality: (a, b) => b.quality - a.quality,
    duration: (a, b) => certainRank(a) - certainRank(b) || band(a) - band(b) || b.quality - a.quality,
    speed: (a, b) => b.uploadSpeed - a.uploadSpeed,
    size: (a, b) => b.size - a.size,
  };
  return filtered.sort(sorters[filters.sort.value] || sorters.quality);
}

function renderResults(searching) {
  // Off-topic results (other files of the same folder, .nfo, images…) are folded
  const certainty = certaintyOf(shown.track);
  const relevant = [];
  const offTopic = [];
  for (const r of currentResults) (isRelevant(r, certainty.relevance) ? relevant : offTopic).push(r);
  relevantCount = relevant.length;
  // Why each relevant result is not certain; the certain ones in the automatic download's order
  const doubts = new Map(relevant.map((r) => [r, matchDoubts(r, shown.track, certainty)]));
  const certain = relevant.filter((r) => doubts.get(r).length === 0).sort(sourceOrder(activeDownloadsWith));
  const rank = new Map(certain.map((r, i) => [r, i]));
  const best = certain[0];
  const all = [
    ...applyFilters(relevant, (r) => rank.get(r) ?? Infinity),
    ...(showOffTopic ? applyFilters(offTopic) : []),
  ];
  visible = all.slice(0, limit);
  const offTopicToggle = offTopic.length
    ? `<button class="btn-secondary load-more" id="btn-off-topic">${showOffTopic ? 'Masquer' : 'Afficher aussi'} les ${offTopic.length} résultats hors sujet</button>`
    : '';

  if (visible.length === 0) {
    resultsList.innerHTML = searching
      ? LOADING_HTML
      : `<div class="slskd-no-results"><p>${relevant.length ? 'Aucun résultat avec ces filtres' : 'Aucun résultat pertinent'}</p></div>${offTopicToggle}`;
    return;
  }

  const target = shown?.track?.duration;
  const rows = visible.map((r, i) => {
    const name = baseName(r.filename);
    const quality = [r.bitRate && `${r.bitRate} kbps`, r.sampleRate && `${(r.sampleRate / 1000).toFixed(1)} kHz`]
      .filter(Boolean).join(' · ') || '—';
    const duration = durationMatch(r.length && r.length * 1000, target);
    const started = pendingDownloadFor(r.username, r.filename);
    // Already tried and failed: still downloadable (same source again), but flagged
    const failed = !started && failedDownloadLabel(r.username, r.filename);
    // Unknown (no dot) in older cached results
    const slot = r.hasFreeUploadSlot == null ? '' : r.hasFreeUploadSlot ? 'free' : 'busy';
    const userInfo = [
      r.queueLength && `File d'attente : ${r.queueLength}`,
      `Vitesse d'envoi : ${Math.round(r.uploadSpeed / 1024)} Ko/s`,
    ].filter(Boolean).join('\n');

    const off = !doubts.has(r);
    const failedTag = failed
      ? `<span class="match-tag failed" title="Le téléchargement de ce fichier a échoué. Le relancer remplace l'échec dans les téléchargements">Échec : ${escapeHtml(failed.toLowerCase())}</span>`
      : '';
    const tags = failedTag + matchTags(doubts.get(r), r === best);
    const rowClass = [off && 'off-topic', r === best && 'best-match', failed && 'failed-source'].filter(Boolean).join(' ');
    return `<div class="slskd-result-row ${rowClass}" ${off ? 'title="Le nom du fichier ne contient pas le titre"' : ''}>
      <div class="result-file">
        <span class="result-filename" title="${escapeHtml(r.filename)}">${escapeHtml(name)}</span>
        ${tags ? `<span class="result-tags">${tags}</span>` : ''}
      </div>
      ${userLabel(r.username, slot, userInfo)}
      <span class="result-format">${formatBadge(r.extension)}</span>
      <span class="result-quality">${escapeHtml(quality)}</span>
      <span class="result-duration ${duration.cls}" title="${duration.title}">${r.length ? formatDuration(r.length * 1000) : '—'}</span>
      <span class="result-size">${formatSize(r.size)}</span>
      <button class="result-download-btn${started ? ' done' : ''}" data-index="${i}" ${started ? 'disabled title="Téléchargement lancé"' : `title="${failed ? 'Réessayer ce fichier' : 'Télécharger'}"`}>
        ${icon(started ? ICONS.check : ICONS.download)}
      </button>
    </div>`;
  });

  if (all.length > visible.length) {
    rows.push(`<button class="btn-secondary load-more" id="btn-load-more">Afficher plus (${all.length - visible.length} restants)</button>`);
  }
  rows.push(offTopicToggle);
  resultsList.innerHTML = rows.join('');
}

/** Tags of a result: why it is not certain, or that it is (none for off-topic results). */
function matchTags(doubts, best) {
  if (!doubts) return '';
  if (best) return '<span class="match-tag certain" title="Correspondance certaine : le fichier que le mode auto télécharge">Choix auto</span>';
  if (doubts.length === 0) return '<span class="match-tag certain" title="Correspondance certaine">Certain</span>';
  return doubts.map((d) => `<span class="match-tag doubt">${escapeHtml(d)}</span>`).join('');
}

function rerender() {
  renderResults(!!shown?.session && !shown.session.complete);
}

resultsList.addEventListener('click', async (e) => {
  if (e.target.closest('#btn-load-more')) {
    limit += PAGE_SIZE;
    rerender();
    return;
  }
  if (e.target.closest('#btn-off-topic')) {
    showOffTopic = !showOffTopic;
    rerender();
    return;
  }
  const btn = e.target.closest('.result-download-btn');
  if (!btn || btn.disabled) return;
  const result = visible[btn.dataset.index];
  const trackId = shown?.track?.id;
  const current = queue;
  if (current) {
    if (requesting) return; // One file per track
    // The auto-search may have downloaded it meanwhile
    if (hasDownloadFor(shown.track)) {
      showToast('Cette piste a déjà un téléchargement', 'info');
      await nextInQueue();
      return;
    }
    requesting = true;
    btn.disabled = true;
  } else {
    // The choice is made: back to the list, where the download shows up
    closeModal(modal);
  }
  try {
    await requestDownload(result.username, result.filename, result.size, trackId);
    showToast('Téléchargement lancé', 'success');
  } catch (err) {
    btn.disabled = false;
    toastError(err);
    return;
  } finally {
    if (current) requesting = false;
  }
  // Validation: on to the next track, unless the user already moved on ("Passer")
  if (current && queue === current && shown?.track?.id === trackId) await nextInQueue();
});

// ─── Validation ─────────────────────────────────────────────
// The tracks with relevant cached results, shown one after the other in the
// modal: download one of the results (certain or not) or skip the track.
// Tracks with a lossy file come after, when lossless results were found.

/** Playlist tracks without a file, one per query: [{ track, key }]. */
function missingTracks(tracks) {
  const keys = new Set();
  const list = [];
  for (const track of tracks) {
    if (track.format || !track.playlistIds) continue;
    const key = trackKey(track);
    if (keys.has(key)) continue;
    keys.add(key);
    list.push({ track, key });
  }
  return list;
}

/** Relevant results recent enough to choose from without searching again. */
const isValidatable = (entry) => isFresh(entry) && entry.relevant > 0;

/**
 * Displayed tracks waiting for a choice: without a file, no download and
 * fresh relevant cached results; then lossy files with fresh lossless results.
 */
export function validationQueue(tracks) {
  const missing = missingTracks(tracks)
    .filter(({ track, key }) => !hasTransferForTrack(track.id) && isValidatable(cacheSummary.get(key)));
  // A query shown once: the same song without a file is downloaded, not upgraded
  const keys = new Set(missing.map(({ key }) => key));
  const upgrades = upgradableTracks(tracks).filter((track) => !keys.has(trackKey(track)) && hasLosslessResults(track));
  return [...missing.map(({ track }) => track), ...upgrades];
}

/** Fresh cached results with a lossless one, to choose an upgrade from. */
function hasLosslessResults(track) {
  const cached = cachedStats(track);
  return isValidatable(cached) && isLossless(cached.best);
}

/** `tracks`: the tracks currently displayed. */
export async function openValidation(tracks) {
  const [connected] = await Promise.all([
    ensureConnected(),
    refreshDownloads(), // The pushed list may be empty right after slskd starts
  ]);
  if (!connected) return;
  const list = validationQueue(tracks);
  if (list.length === 0) {
    showToast('Aucune piste à valider : lancez d\'abord la recherche auto', 'success');
    return;
  }
  queue = { tracks: list, index: 0 };
  queueBar.hidden = false;
  openModal(modal, () => { cancelPrefetch(); shown = null; queue = null; });
  await showQueueTrack();
}

let prefetched = null; // validation: the next track's search, started ahead

/** Stop the next track's search when it is not needed any more (skipped, closed). */
function cancelPrefetch() {
  const session = prefetched;
  prefetched = null;
  // Kept when now shown (it was the next track) or awaited by the auto-search
  if (session && !session.complete && shown?.session !== session && !autoSessions.has(session)) {
    cancelSession(session);
  }
}

async function showQueueTrack() {
  const track = queue.tracks[queue.index];
  queuePosition.textContent = `Piste ${queue.index + 1} / ${queue.tracks.length}`;
  // Validation holds tracks without a file, then tracks to upgrade
  const upgrade = canUpgrade(track);
  queueHint.textContent = upgrade ? 'Amélioration' : 'Téléchargement';
  queueHint.classList.toggle('upgrade', upgrade);
  await showTrack(track);
  cancelPrefetch();
  // Searched while this one is checked, so that it shows up-to-date results at once
  const next = queue?.tracks[queue.index + 1];
  if (next && !isFresh(cachedStats(next))) prefetched = searchTrack(next);
}

/** Next track, skipping those downloaded meanwhile. */
async function nextInQueue() {
  if (!queue) return;
  let index = queue.index + 1;
  while (index < queue.tracks.length && hasDownloadFor(queue.tracks[index])) index++;
  if (index >= queue.tracks.length) {
    closeModal(modal);
    showToast('Validation terminée', 'success');
    return;
  }
  queue.index = index;
  await showQueueTrack();
}

$('#slskd-queue-skip').addEventListener('click', () => nextInQueue().catch(toastError));

Object.values(filters).forEach((el) => el.addEventListener('change', () => {
  limit = PAGE_SIZE;
  rerender();
}));

function submitQuery(force) {
  const query = queryInput.value.trim();
  if (query && shown) showQuery(query, { force }).catch(toastError);
}

$('#slskd-search-btn').addEventListener('click', () => submitQuery(true));
queryInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitQuery(false);
});

// ─── Auto-search and auto-upgrade ───────────────────────────
// Auto-search: results are cached for the user to choose from. Only with the
// opt-in "autoDownload" setting, a track whose results hold a certain match
// (see certainMatches) is downloaded without a click.
// Auto-upgrade (its own button): tracks whose file is lossy are searched;
// those with lossless results join the validation, and with "autoDownload"
// their certain FLAC/WAV match is downloaded. The two files then meet as a
// conflict, where the user picks the one to keep.
// Both can run at once: their tracks wait in one shared queue served by the
// same few workers (the load on Soulseek stays that of one run), the tracks
// without a file first.
const AUTO_KINDS = {
  search: {
    btn: $('#btn-auto-search'), text: $('#auto-search-text'), status: $('#auto-search-status'),
    label: 'Recherche auto', name: 'Recherche',
  },
  upgrade: {
    btn: $('#btn-auto-upgrade'), text: $('#auto-upgrade-text'), status: $('#auto-upgrade-status'),
    label: 'Amélioration auto', name: 'Amélioration',
  },
};
/** The run of each kind: { kind, total, done, autoDownload, downloaded } */
const runs = { search: null, upgrade: null };
const starting = { search: false, upgrade: false };
/** Tracks waiting for a worker, per kind ({ run, track }): "search" ones go first */
const waiting = { search: [], upgrade: [] };
/** Searches running for the workers (kept when the validation drops its prefetch) */
const autoSessions = new Set();
let workerCount = 0;

function renderAutoState() {
  for (const [kind, { btn, text, status, label }] of Object.entries(AUTO_KINDS)) {
    const run = runs[kind];
    btn.classList.toggle('active', !!run);
    text.textContent = run ? 'Arrêter' : label;
    status.textContent = run ? `${run.done}/${run.total}` : '';
  }
}

/** Queue the tracks of a new run, and start the workers still missing. */
function startRun(kind, tracks, autoDownload) {
  const run = { kind, total: tracks.length, done: 0, autoDownload, downloaded: 0 };
  runs[kind] = run;
  waiting[kind] = tracks.map((track) => ({ run, track }));
  renderAutoState();
  const missing = Math.min(AUTO_SEARCH_CONCURRENCY - workerCount, waiting.search.length + waiting.upgrade.length);
  for (let i = 0; i < missing; i++) {
    // Spaced after the busy workers too: searches never start together
    autoWorker((workerCount + i) * AUTO_SEARCH_DELAY).catch(toastError);
  }
  workerCount += missing;
}

/** Stop a run: its waiting tracks are dropped, its running searches end in the cache. */
function stopRun(kind, message, type = 'info') {
  runs[kind] = null;
  waiting[kind] = [];
  renderAutoState();
  if (message) showToast(message, type);
}

/** Soulseek lost: every run stops and the searches are cancelled (except the validation's). */
function stopAllRuns(message) {
  if (!runs.search && !runs.upgrade) return; // Already stopped by another worker
  for (const kind of Object.keys(runs)) stopRun(kind);
  for (const session of autoSessions) {
    if (shown?.session !== session && prefetched !== session) cancelSession(session);
  }
  showToast(message, 'error');
}

/** Stop the running run of this kind; true when there was one (or one is starting). */
function stopIfRunning(kind) {
  const run = runs[kind];
  if (run) stopRun(kind, `${AUTO_KINDS[kind].name} arrêtée (${run.done}/${run.total})`);
  return !!run || starting[kind];
}

/** `tracks`: the tracks currently displayed. */
export async function toggleAutoSearch(tracks) {
  if (stopIfRunning('search')) return;
  starting.search = true;
  try {
    if (!(await ensureConnected())) return;
    const [{ autoDownload }] = await Promise.all([
      api.getSettings(),
      loadCacheSummary(), // Drop entries that expired during a long session
      refreshDownloads(), // The pushed list may be empty right after slskd starts
    ]);
    const queue = [];
    for (const { track, key } of missingTracks(tracks)) {
      if (sessions.has(key)) continue;
      const cached = cacheSummary.get(key);
      const noTransfer = !hasTransferForTrack(track.id);
      // Stale relevant results are searched again to be validated; otherwise cached
      // tracks only to look for a certain match (older entries have no certain count)
      if (!cached || (noTransfer && (
        (cached.relevant > 0 && !isFresh(cached))
        || (autoDownload && (cached.certain ?? cached.relevant) > 0)))) {
        queue.push(track);
      }
    }
    if (queue.length === 0) {
      showToast('Toutes les pistes affichées ont déjà des résultats en cache', 'success');
      return;
    }

    startRun('search', queue, autoDownload);
  } catch (err) {
    toastError(err);
  } finally {
    starting.search = false;
  }
}

/** A playlist track whose file is lossy (MP3…): a lossless version may replace it. */
export const canUpgrade = (track) => !!track.format && !isLossless(track.format) && !!track.playlistIds;

/** Displayed tracks with a lossy file, one per query, not being downloaded or in conflict. */
function upgradableTracks(tracks) {
  const keys = new Set();
  return tracks.filter((track) => {
    if (!canUpgrade(track)) return false;
    if (track.conflictId || hasDownloadFor(track)) return false;
    const key = trackKey(track);
    if (keys.has(key) || sessions.has(key)) return false;
    keys.add(key);
    return true;
  });
}

/** `tracks`: the tracks currently displayed. */
export async function toggleAutoUpgrade(tracks) {
  if (stopIfRunning('upgrade')) return;
  starting.upgrade = true;
  try {
    if (!(await ensureConnected())) return;
    const [{ autoDownload }] = await Promise.all([api.getSettings(), loadCacheSummary(), refreshDownloads()]);
    const candidates = upgradableTracks(tracks);
    // Without auto-download, fresh results are already there to validate
    const queue = autoDownload ? candidates : candidates.filter((track) => !isFresh(cachedStats(track)));
    if (queue.length === 0) {
      const found = candidates.filter(hasLosslessResults).length;
      showToast(!candidates.length
        ? 'Aucune piste affichée à améliorer (toutes en FLAC/WAV, ou déjà en téléchargement)'
        : found
          ? `Pistes déjà cherchées récemment : ${found} à valider dans « À valider »`
          : 'Pistes déjà cherchées récemment : aucune version sans perte trouvée', 'success');
      return;
    }
    startRun('upgrade', queue, autoDownload);
  } catch (err) {
    toastError(err);
  } finally {
    starting.upgrade = false;
  }
}

/** Take the waiting tracks one by one (missing ones first), pausing after each search. */
async function autoWorker(initialDelay) {
  try {
    await sleep(initialDelay);
    for (let item = nextWaiting(); item; item = nextWaiting()) {
      const searched = await processWaiting(item);
      if (searched && (waiting.search.length || waiting.upgrade.length)) await sleep(AUTO_SEARCH_DELAY);
    }
  } finally {
    // At once, not a microtask later: a run starting meanwhile sees the free slot
    workerCount--;
  }
}

const nextWaiting = () => waiting.search.shift() || waiting.upgrade.shift();

/** Search a track (or read its fresh results), then maybe download it. True if searched. */
async function processWaiting({ run, track }) {
  const current = () => runs[run.kind] === run;
  let results = null;
  // Not cached, or stale: users may have gone offline (see FRESH_MS)
  const stale = !isFresh(cacheSummary.get(trackKey(track)));
  if (stale) {
    const session = searchTrack(track);
    autoSessions.add(session);
    await session.promise;
    autoSessions.delete(session);
    if (session.error && current()) {
      const status = await api.slskd.getStatus().catch(() => ({}));
      if (!status.connected) {
        stopAllRuns('Soulseek est déconnecté : recherches auto arrêtées');
        return true;
      }
    }
    if (!session.error && !session.cancelled) results = session.results;
  } else if (run.autoDownload) {
    // Recent results (or searched meanwhile, in the modal…): no new search
    results = (await api.searchCache.get(trackQuery(track)).catch(() => null))?.results;
  }
  if (run.autoDownload && results && current()) {
    // A failure for one track leaves it to choose by hand: the run goes on
    await downloadCertainMatch(run, track, results)
      .catch((err) => console.warn('[Kusic] Auto-download failed:', errorMessage(err)));
  }
  if (!current()) return stale;
  run.done++;
  renderAutoState();
  if (run.done === run.total) {
    const n = run.downloaded;
    const downloads = run.autoDownload ? `, ${n} téléchargement${n > 1 ? 's' : ''} lancé${n > 1 ? 's' : ''}` : '';
    stopRun(run.kind, `${AUTO_KINDS[run.kind].name} terminée (${run.done} pistes${downloads})`, 'success');
  }
  return stale;
}

/**
 * Download the track from its best certain source (lossless only for an
 * upgrade), if any; otherwise it stays a manual choice.
 */
async function downloadCertainMatch(run, track, results) {
  if (hasDownloadFor(track)) return;
  // One file per user: when a user is unreachable, their other files would fail too
  const matches = [];
  for (const match of certainMatches(results, track, activeDownloadsWith)) {
    if (matches.length === AUTO_DOWNLOAD_TRIES) break;
    if (run.kind === 'upgrade' && !isLossless(match.extension)) continue;
    if (!matches.some((m) => m.username === match.username)) matches.push(match);
  }
  // Unticked during the run: no more automatic downloads
  if (!matches.length || !(await api.getSettings()).autoDownload) return;
  for (const match of matches) {
    // Stopped, or downloaded by hand while the settings were read
    if (runs[run.kind] !== run || hasDownloadFor(track)) return;
    try {
      await requestDownload(match.username, match.filename, match.size, track.id);
      run.downloaded++;
      return;
    } catch (err) {
      // Unreachable user…: try the next certain source
      console.warn('[Kusic] Auto-download failed:', errorMessage(err));
    }
  }
}
