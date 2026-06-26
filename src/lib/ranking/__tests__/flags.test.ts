import { afterEach, describe, expect, it } from 'vitest';
import { rankingTrackingEnabled } from '../flags';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('rankingTrackingEnabled', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['false', 'false'],
    ['uppercase TRUE', 'TRUE'],
    ['mixed case True', 'True'],
    ['numeric 1', '1'],
    ['padded true', ' true '],
  ])('is false for %s', (_label, value) => {
    if (value === undefined) delete process.env.RANKING_TRACKING_ENABLED;
    else process.env.RANKING_TRACKING_ENABLED = value;
    expect(rankingTrackingEnabled()).toBe(false);
  });

  it('is true ONLY for the exact string "true"', () => {
    process.env.RANKING_TRACKING_ENABLED = 'true';
    expect(rankingTrackingEnabled()).toBe(true);
  });
});
