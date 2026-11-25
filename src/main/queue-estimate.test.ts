import { describe, expect, it } from "vitest";
import { addQueueSample, estimateQueue, QUEUE_RATE_WINDOW, type QueueSample } from "./queue-estimate.js";

const MIN = 60_000;

/** Samples taken once a minute, from `places[0]` at t=0. */
function sampled(places: number[]): QueueSample[] {
  return places.reduce<QueueSample[]>((acc, place, i) => addQueueSample(acc, place, i * MIN), []);
}

describe("addQueueSample", () => {
  it("ignores polls between two checks of an unchanged place", () => {
    const samples = addQueueSample([], 10, 0);
    expect(addQueueSample(samples, 10, 2000)).toBe(samples);
  });

  it("records a changed place at once", () => {
    expect(addQueueSample(addQueueSample([], 10, 0), 9, 2000)).toHaveLength(2);
  });

  it("drops samples older than the window", () => {
    const samples = sampled(Array.from({ length: 45 }, () => 10));
    expect(samples[0].at).toBeGreaterThanOrEqual(44 * MIN - QUEUE_RATE_WINDOW);
  });
});

describe("estimateQueue", () => {
  it("waits for a second check", () => {
    expect(estimateQueue(sampled([20]))).toBeUndefined();
    expect(estimateQueue(addQueueSample(sampled([20]), 19, 2000))).toBeUndefined();
  });

  it("estimates from the first minute", () => {
    expect(estimateQueue(sampled([20, 18]))).toEqual({ rate: 2, eta: 9 * MIN });
  });

  it("gives the places gained per minute and the wait", () => {
    // 20 -> 15 in 10 minutes: 0.5 place/min, 15 places left: 30 min
    const estimate = estimateQueue(sampled([20, 20, 19, 19, 18, 18, 17, 17, 16, 16, 15]));
    expect(estimate?.rate).toBeCloseTo(0.5);
    expect(estimate?.eta).toBeCloseTo(30 * MIN);
  });

  it("reports no progress when the place did not change", () => {
    expect(estimateQueue(sampled([12, 12, 13, 13, 12, 12, 12]))).toEqual({ rate: 0 });
  });

  it("reports lost places as a negative speed, without a wait", () => {
    expect(estimateQueue(sampled([10, 11, 12]))).toEqual({ rate: -1 });
  });
});
