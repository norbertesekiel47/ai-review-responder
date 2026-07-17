import { afterEach, describe, expect, it } from 'vitest';
import { resetServerConfigForTests } from '@/lib/config/server';
import {
  assertTierPurchasable,
  autopilotPurchasable,
} from '../tier-purchasability';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  resetServerConfigForTests();
});

describe('Autopilot purchasability', () => {
  it.each([
    [undefined, undefined, false],
    ['false', 'false', false],
    ['false', 'true', false],
    ['true', 'false', false],
    ['true', 'true', true],
  ] as const)(
    'composes AUTOPILOT_PURCHASABLE=%s with AUTO_APPROVAL_ENABLED=%s',
    (purchasable, runtime, expected) => {
      if (purchasable === undefined) delete process.env.AUTOPILOT_PURCHASABLE;
      else process.env.AUTOPILOT_PURCHASABLE = purchasable;
      if (runtime === undefined) delete process.env.AUTO_APPROVAL_ENABLED;
      else process.env.AUTO_APPROVAL_ENABLED = runtime;
      resetServerConfigForTests();

      expect(autopilotPurchasable()).toBe(expected);
    },
  );

  it('always permits Copilot and gates Autopilot with the composed predicate', () => {
    process.env.AUTOPILOT_PURCHASABLE = 'false';
    process.env.AUTO_APPROVAL_ENABLED = 'true';
    resetServerConfigForTests();
    expect(() => assertTierPurchasable('copilot')).not.toThrow();
    expect(() => assertTierPurchasable('autopilot')).toThrow(/not currently purchasable/);

    process.env.AUTOPILOT_PURCHASABLE = 'true';
    resetServerConfigForTests();
    expect(() => assertTierPurchasable('autopilot')).not.toThrow();
  });

  it('rejects unknown tiers instead of defaulting to Copilot', () => {
    expect(() => assertTierPurchasable('enterprise' as 'copilot')).toThrow(
      /Unknown purchasable subscription tier/,
    );
  });

  it.each(['TRUE', '1', 'yes', '', ' true '])(
    'fails config validation for malformed configured value %j',
    (value) => {
      process.env.AUTOPILOT_PURCHASABLE = value;
      process.env.AUTO_APPROVAL_ENABLED = 'true';
      resetServerConfigForTests();
      expect(() => autopilotPurchasable()).toThrow();
    },
  );
});
