import { afterEach, describe, expect, it } from 'vitest';
import { triageEnabled } from '../flags';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('triageEnabled', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['false', 'false'],
    ['uppercase true', 'TRUE'],
    ['numeric true', '1'],
    ['padded true', ' true '],
  ])('stays disabled for %s values', (_label, value) => {
    if (value === undefined) {
      delete process.env.TRIAGE_ENABLED;
    } else {
      process.env.TRIAGE_ENABLED = value;
    }

    expect(triageEnabled()).toBe(false);
  });

  it('enables triage only for exact string true', () => {
    process.env.TRIAGE_ENABLED = 'true';

    expect(triageEnabled()).toBe(true);
  });
});
