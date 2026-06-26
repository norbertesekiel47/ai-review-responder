import { afterEach, describe, expect, it } from 'vitest';
import { multiLocationEnabled } from '../flags';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('multiLocationEnabled', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['false', 'false'],
    ['uppercase TRUE', 'TRUE'],
    ['mixed case True', 'True'],
    ['numeric 1', '1'],
    ['padded true', ' true '],
  ])('is false for %s', (_label, value) => {
    if (value === undefined) delete process.env.MULTI_LOCATION_ENABLED;
    else process.env.MULTI_LOCATION_ENABLED = value;
    expect(multiLocationEnabled()).toBe(false);
  });

  it('is true ONLY for the exact string "true"', () => {
    process.env.MULTI_LOCATION_ENABLED = 'true';
    expect(multiLocationEnabled()).toBe(true);
  });
});
