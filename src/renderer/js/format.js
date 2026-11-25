// ─── Formats and durations ──────────────────────────────────
// No DOM here: shared by ui.js and query.js (which the tests load in node).

const LOSSLESS = ['FLAC', 'WAV', 'AIFF', 'AIF', 'ALAC', 'APE'];

export const isLossless = (format) => LOSSLESS.includes((format || '').toUpperCase());

export function formatDuration(ms) {
  if (!ms) return '—';
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

/** Rough wait: "~25 min", "~2 h 10", "~3 j". */
export function formatWait(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `~${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `~${hours} h ${String(rest).padStart(2, '0')}` : `~${hours} h`;
  }
  return `~${Math.round(hours / 24)} j`;
}

/**
 * Change of a queue position, like the number shown: + = it goes up (we move
 * back), − = it goes down (we move forward). Per minute, or per hour when slower.
 */
export function formatQueueRate(perMinute) {
  const sign = perMinute > 0 ? '+' : perMinute < 0 ? '−' : '';
  const n = (v) => Math.abs(v).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
  if (!perMinute || Math.abs(perMinute) >= 1) return `${sign}${n(perMinute)}/min`;
  return `${sign}${n(perMinute * 60)}/h`;
}
