import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SubscriptionTierValue } from '@/lib/accounts/tier-config';
import { resetServerConfigForTests } from '@/lib/config/server';
import {
  assertTierDailyCostLimitsConfigured,
  optionalNonnegativeCostLimitCents,
  parseRequiredPositiveCostLimitCents,
  tierDailyCostLimitCents,
} from '../tier-cost-limits';

const ENV_KEYS = [
  'DAILY_COST_LIMIT_CENTS_COPILOT',
  'DAILY_COST_LIMIT_CENTS_AUTOPILOT',
] as const;

const savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined> = {
  DAILY_COST_LIMIT_CENTS_COPILOT: undefined,
  DAILY_COST_LIMIT_CENTS_AUTOPILOT: undefined,
};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.DAILY_COST_LIMIT_CENTS_COPILOT = '101';
  process.env.DAILY_COST_LIMIT_CENTS_AUTOPILOT = '202';
  resetServerConfigForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  resetServerConfigForTests();
});

describe('tier cost limit configuration', () => {
  it('requires and resolves independent Copilot and Autopilot ceilings', () => {
    expect(() => assertTierDailyCostLimitsConfigured()).not.toThrow();
    expect(tierDailyCostLimitCents('copilot')).toBe(101);
    expect(tierDailyCostLimitCents('autopilot')).toBe(202);
  });

  it.each(ENV_KEYS)('fails closed when %s is missing', (key) => {
    delete process.env[key];
    resetServerConfigForTests();

    expect(() => assertTierDailyCostLimitsConfigured()).toThrow(key);
  });

  it.each(['', ' ', '0', '-1', '1.5', '1_000', '10c', '9007199254740992'])(
    'rejects malformed or non-positive value %j',
    (raw) => {
      expect(() => parseRequiredPositiveCostLimitCents(
        'DAILY_COST_LIMIT_CENTS_COPILOT',
        raw,
      )).toThrow(/positive decimal integer/);
    },
  );

  it('rejects an unknown tier instead of falling back', () => {
    expect(() => tierDailyCostLimitCents('unknown' as SubscriptionTierValue)).toThrow(
      /Unsupported subscription tier/,
    );
  });

  it('keeps the established optional global fallback semantics separate', () => {
    expect(optionalNonnegativeCostLimitCents(undefined, 10_000)).toBe(10_000);
    expect(optionalNonnegativeCostLimitCents('bad', 10_000)).toBe(10_000);
    expect(optionalNonnegativeCostLimitCents('0', 10_000)).toBe(0);
    expect(optionalNonnegativeCostLimitCents('123', 10_000)).toBe(123);
  });
});
