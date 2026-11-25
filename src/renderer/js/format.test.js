import { describe, expect, it } from 'vitest';
import { formatQueueRate, formatWait } from './format.js';

const MIN = 60_000;

describe('formatWait', () => {
  it('rounds to minutes, hours or days', () => {
    expect(formatWait(10_000)).toBe('~1 min');
    expect(formatWait(25 * MIN)).toBe('~25 min');
    expect(formatWait(130 * MIN)).toBe('~2 h 10');
    expect(formatWait(180 * MIN)).toBe('~3 h');
    expect(formatWait(3 * 24 * 60 * MIN)).toBe('~3 j');
  });
});

describe('formatQueueRate', () => {
  it('signs the change like the position, per hour when slower than one a minute', () => {
    expect(formatQueueRate(2.5)).toBe('+2,5/min');
    expect(formatQueueRate(1)).toBe('+1/min');
    expect(formatQueueRate(0.1)).toBe('+6/h');
    expect(formatQueueRate(-3)).toBe('−3/min');
    expect(formatQueueRate(-0.05)).toBe('−3/h');
    expect(formatQueueRate(0)).toBe('0/min');
  });
});
