// ─── Formats and durations ──────────────────────────────────
// No DOM here: shared by ui.js and query.js (which the tests load in node).

const LOSSLESS = ['FLAC', 'WAV', 'AIFF', 'AIF', 'ALAC', 'APE'];

export const isLossless = (format) => LOSSLESS.includes((format || '').toUpperCase());

export function formatDuration(ms) {
  if (!ms) return '—';
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

