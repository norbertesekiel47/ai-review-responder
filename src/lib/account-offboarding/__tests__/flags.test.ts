import { afterEach, describe, expect, it } from 'vitest';

import { accountOffboardingEnabled } from '../flags';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('account offboarding feature flag', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['false', 'false'],
    ['uppercase true', 'TRUE'],
    ['mixed case true', 'True'],
    ['numeric true', '1'],
    ['padded true', ' true '],
  ])('keeps ACCOUNT_OFFBOARDING_ENABLED disabled for %s', (_label, value) => {
    if (value === undefined) {
      delete process.env.ACCOUNT_OFFBOARDING_ENABLED;
    } else {
      process.env.ACCOUNT_OFFBOARDING_ENABLED = value;
    }

    expect(accountOffboardingEnabled()).toBe(false);
  });

  it('enables account offboarding only for exact string true', () => {
    process.env.ACCOUNT_OFFBOARDING_ENABLED = 'true';

    expect(accountOffboardingEnabled()).toBe(true);
  });
});
