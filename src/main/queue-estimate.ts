// ─── Remote queue speed ─────────────────────────────────────
// Our place in a user's upload queue is checked once a minute. Keeping the
// recent positions gives how many places we gain per minute, hence an
// estimate of the wait. The net progress is what counts: users jumping ahead
// (privileged ones) slow us down as much as a slow upload does.

import type { QueueEstimate } from "../types.js";

/** Window over which the speed is measured */
export const QUEUE_RATE_WINDOW = 30 * 60_000;
/** The position is asked once a minute; answers may arrive a few seconds early or late */
const SAMPLE_INTERVAL = 45_000;

export interface QueueSample {
  place: number;
  at: number;
}


/**
 * Add the current place (if it is due) and drop samples that left the window.
 * Returns the same array when nothing changed.
 */
export function addQueueSample(samples: QueueSample[], place: number, now: number): QueueSample[] {
  const last = samples[samples.length - 1];
  if (last && last.place === place && now - last.at < SAMPLE_INTERVAL) return samples;
  const kept = samples.filter((s) => now - s.at <= QUEUE_RATE_WINDOW);
  return [...kept, { place, at: now }];
}

/** Speed and wait from the samples, or undefined while measuring. */
export function estimateQueue(samples: QueueSample[]): QueueEstimate | undefined {
  if (samples.length < 2) return undefined;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const span = last.at - first.at;
  // Two consecutive checks are enough for a first (rough) speed
  if (span < SAMPLE_INTERVAL) return undefined;
  const rate = (first.place - last.place) / (span / 60_000);
  return rate > 0 ? { rate, eta: (last.place / rate) * 60_000 } : { rate };
}
