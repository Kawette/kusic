// ─── Settings view ──────────────────────────────────────────

import {
  $, api, errorMessage, escapeHtml, icon, ICONS, showToast, toastError, withBusyButton,
} from './ui.js';

const fields = {
  clientId: $('#spotify-client-id'),
  clientSecret: $('#spotify-client-secret'),
  username: $('#soulseek-username'),
  password: $('#soulseek-password'),
  libraryPath: $('#soulseek-library-path'),
};
const savedIndicator = $('#settings-saved');
const toggleBtn = $('#btn-slskd-toggle');
const statusText = $('#slskd-status-text');
const indicator = $('#slskd-status-indicator');
const lastErrorEl = $('#slskd-last-error');
const restartNotice = $('#slskd-restart-notice');

let pollTimer = null;
let platformSupported = true;

export async function loadSettings() {
  // Never overwrite inputs with stale values while an edit is pending
  await flushSettings();
  const settings = await api.getSettings();
  fields.clientId.value = settings.spotify.clientId;
  fields.clientSecret.value = settings.spotify.clientSecret;
  fields.username.value = settings.soulseek.username;
  fields.password.value = settings.soulseek.password;
  fields.libraryPath.value = settings.soulseek.libraryPath;

  const platform = await api.slskd.checkPlatform();
  platformSupported = platform.supported;
  if (platformSupported) {
    checkSlskdBinary().catch(toastError);
  } else {
    showUnsupportedPlatform(platform.platform);
  }
  refreshStatus();
}

// ─── Auto-save ──────────────────────────────────────────────
let saveTimer = null;
let pendingSoulseekChange = false;
let savedTimer = null;

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  const soulseekChanged = pendingSoulseekChange;
  pendingSoulseekChange = false;
  try {
    await api.saveSettings({
      spotify: { clientId: fields.clientId.value, clientSecret: fields.clientSecret.value },
      soulseek: {
        username: fields.username.value,
        password: fields.password.value,
        libraryPath: fields.libraryPath.value,
      },
    });
    savedIndicator.hidden = false;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { savedIndicator.hidden = true; }, 2000);

    if (soulseekChanged) {
      const status = await api.slskd.getStatus();
      restartNotice.hidden = !(status.running || status.starting);
    }
  } catch (err) {
    showToast(errorMessage(err), 'error');
  }
}

function scheduleSave(soulseek) {
  pendingSoulseekChange ||= soulseek;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 800);
}

/** Save immediately if an edit is waiting (e.g. when leaving the view). */
export async function flushSettings() {
  if (saveTimer) await saveNow();
}

fields.clientId.addEventListener('input', () => scheduleSave(false));
fields.clientSecret.addEventListener('input', () => scheduleSave(false));
fields.username.addEventListener('input', () => scheduleSave(true));
fields.password.addEventListener('input', () => scheduleSave(true));

$('#btn-browse-library').addEventListener('click', async () => {
  try {
    const folder = await api.browseFolder();
    if (!folder) return;
    fields.libraryPath.value = folder;
    scheduleSave(true);
    await flushSettings();
  } catch (err) {
    toastError(err);
  }
});

$('#link-spotify-dev').addEventListener('click', (e) => {
  e.preventDefault();
  api.openExternal('https://developer.spotify.com/dashboard').catch(toastError);
});

$('#btn-test-spotify').addEventListener('click', async (e) => {
  const result = $('#spotify-test-result');
  result.className = 'setting-test-result';
  result.textContent = '';
  try {
    await withBusyButton(e.currentTarget, () =>
      api.testSpotify(fields.clientId.value, fields.clientSecret.value));
    result.classList.add('ok');
    result.textContent = '✓ Identifiants valides';
  } catch (err) {
    result.classList.add('error');
    result.textContent = errorMessage(err);
  }
});

// ─── Platform & binary ──────────────────────────────────────
function showUnsupportedPlatform(platform) {
  $('#slskd-binary-text').textContent = 'Non disponible sur cette plateforme';
  $('#btn-download-slskd').hidden = true;
  const warning = $('#platform-warning');
  warning.innerHTML = `${icon(ICONS.warning, 20)}<span>Soulseek n'est disponible que sur Windows pour le moment. Plateforme détectée : ${escapeHtml(platform)}</span>`;
  warning.hidden = false;
  for (const el of [fields.username, fields.password, $('#btn-browse-library'), toggleBtn]) {
    el.disabled = true;
  }
}

async function checkSlskdBinary() {
  const info = await api.slskd.getVersion();
  const statusEl = $('#slskd-binary-status');
  const btn = $('#btn-download-slskd');
  statusEl.classList.toggle('ready', info.installed && !info.updateAvailable);
  statusEl.classList.toggle('missing', !info.installed);

  if (!info.installed) {
    $('#slskd-binary-text').textContent = `slskd v${info.version} non installé`;
    btn.textContent = 'Télécharger slskd';
  } else if (info.updateAvailable) {
    $('#slskd-binary-text').textContent = `slskd v${info.installedVersion || '?'} installé, v${info.version} disponible`;
    btn.textContent = 'Mettre à jour';
  } else {
    $('#slskd-binary-text').textContent = `✓ slskd v${info.version} installé`;
  }
  btn.hidden = info.installed && !info.updateAvailable;
}

$('#btn-download-slskd').addEventListener('click', async () => {
  const btn = $('#btn-download-slskd');
  const progressBar = $('#slskd-download-progress');
  const fill = $('#slskd-download-fill');
  const text = $('#slskd-binary-text');

  btn.hidden = true;
  progressBar.hidden = false;
  text.textContent = 'Téléchargement en cours...';
  const unsubscribe = api.slskd.onDownloadProgress((progress) => {
    fill.style.width = `${progress}%`;
    text.textContent = `Téléchargement : ${progress} %`;
  });

  try {
    await api.slskd.downloadBinary();
    showToast('slskd installé', 'success');
  } catch (err) {
    toastError(err);
  } finally {
    unsubscribe();
    progressBar.hidden = true;
    fill.style.width = '0';
    checkSlskdBinary().catch(toastError);
  }
});

// ─── slskd status ───────────────────────────────────────────
function renderStatus(status) {
  let label = 'Non connecté';
  let cls = '';
  if (status.connected) {
    label = `Connecté${status.username ? ` (${status.username})` : ''}`;
    cls = 'connected';
  } else if (status.starting) {
    label = 'Démarrage de slskd...';
    cls = 'running';
  } else if (status.connecting) {
    label = 'Connexion au réseau...';
    cls = 'running';
  } else if (status.running) {
    label = status.state || 'Démarrage...';
    cls = 'running';
  } else if (status.lastError) {
    cls = 'error';
  }

  indicator.className = `status-indicator ${cls}`;
  statusText.textContent = label;
  const active = status.running || status.starting;
  toggleBtn.textContent = active ? 'Arrêter' : 'Démarrer';
  toggleBtn.dataset.action = active ? 'stop' : 'start';
  toggleBtn.disabled = !platformSupported || !!status.starting;
  if (!active) restartNotice.hidden = true;

  lastErrorEl.hidden = !status.lastError;
  lastErrorEl.textContent = status.lastError ? `Dernière erreur slskd : ${status.lastError}` : '';
}

export async function refreshStatus() {
  try {
    renderStatus(await api.slskd.getStatus());
  } catch {
    // Main process busy; next poll will retry
  }
}

export function startStatusPolling() {
  stopStatusPolling();
  pollTimer = setInterval(refreshStatus, 2000);
}

export function stopStatusPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

async function startSlskd() {
  await flushSettings();
  restartNotice.hidden = true;
  renderStatus({ starting: true });
  try {
    await api.slskd.start();
  } catch (err) {
    toastError(err);
  }
  refreshStatus();
}

async function stopSlskd() {
  toggleBtn.disabled = true;
  try {
    await api.slskd.stop();
  } catch (err) {
    toastError(err);
  }
  refreshStatus();
}

toggleBtn.addEventListener('click', () => (toggleBtn.dataset.action === 'stop' ? stopSlskd() : startSlskd()));

$('#btn-slskd-restart').addEventListener('click', async () => {
  restartNotice.hidden = true;
  await stopSlskd();
  await startSlskd();
});

api.slskd.onStateChanged(refreshStatus);
