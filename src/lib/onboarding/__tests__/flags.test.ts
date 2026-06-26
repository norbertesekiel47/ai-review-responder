import { afterEach, describe, expect, it } from 'vitest';
import { onboardingDemoEnabled } from '../flags';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('onboardingDemoEnabled', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['false', 'false'],
    ['uppercase TRUE', 'TRUE'],
    ['mixed case True', 'True'],
    ['numeric 1', '1'],
    ['padded true', ' true '],
  ])('is false for %s', (_label, value) => {
    if (value === undefined) delete process.env.ONBOARDING_DEMO_ENABLED;
    else process.env.ONBOARDING_DEMO_ENABLED = value;
    expect(onboardingDemoEnabled()).toBe(false);
  });

  it('is true ONLY for the exact string "true"', () => {
    process.env.ONBOARDING_DEMO_ENABLED = 'true';
    expect(onboardingDemoEnabled()).toBe(true);
  });
});
