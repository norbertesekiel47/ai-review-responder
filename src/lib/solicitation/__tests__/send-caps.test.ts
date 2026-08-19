import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DAILY_SEND_CAP_ACCOUNT,
  resolveAccountDailySendCap,
  resolvePlatformDailyCap,
} from '../send-caps';

describe('solicitation send caps', () => {
  it('resolveAccountDailySendCap returns the platform default of 10 when the policy cap is null', () => {
    // Amendment B3 / #622 D4: a NULL dial resolves to the platform default, not
    // to unlimited. Ten is asserted literally because the number IS the
    // contract — it forces a 25-ask batch across >= 3 calendar days.
    expect(resolveAccountDailySendCap({ dailySendCap: null })).toBe(
      DEFAULT_DAILY_SEND_CAP_ACCOUNT,
    );
    expect(DEFAULT_DAILY_SEND_CAP_ACCOUNT).toBe(10);
  });

  it('resolvePlatformDailyCap returns 0 when SOLICITATION_PLATFORM_DAILY_CAP is unset or unparseable', () => {
    // FAILS CLOSED: 0 means no sends. Every one of these is a configuration a
    // deploy could plausibly produce, and none may be read as "unlimited".
    for (const value of [undefined, '', '   ', 'nope', '1.5', '-1', 'NaN', 'Infinity']) {
      expect(resolvePlatformDailyCap(value)).toBe(0);
    }
  });

  it('resolvePlatformDailyCap treats an explicit 0 as the dial at rest and not a misconfiguration', () => {
    // '0' and "unset" are deliberately indistinguishable in the RESULT, because
    // both must stop sending — there is no error arm to distinguish them into.
    expect(resolvePlatformDailyCap('0')).toBe(0);
    expect(resolvePlatformDailyCap('50')).toBe(50);
    expect(resolvePlatformDailyCap(' 5000 ')).toBe(5000);
  });

  it('resolvePlatformDailyCap returns 0 for a value too large to be a safe integer', () => {
    // The one branch Number.isSafeInteger exists for: /^\d+$/ admits the digits,
    // Number() silently rounds past 2^53, and a ceiling nobody can reach is not
    // a ceiling. Fails closed like every other unparseable value.
    expect(resolvePlatformDailyCap('99999999999999999999')).toBe(0);
  });
});

// Property tests (fast-check): the house style for invariant-level coverage.
describe('invariants', () => {
  it('resolveAccountDailySendCap never exceeds the platform default for any configured value', () => {
    // #619 D20 / amendment B3: the dial moves toward restraint ONLY. The schema
    // CHECK admits 1..50, so an admin CAN store 50 — the resolver is what makes
    // that harmless. An example test cannot cover the 1..50 range; this can.
    fc.assert(
      fc.property(fc.option(fc.integer({ min: 1, max: 50 }), { nil: null }), (configured) => {
        const effective = resolveAccountDailySendCap({ dailySendCap: configured });
        expect(effective).toBeLessThanOrEqual(DEFAULT_DAILY_SEND_CAP_ACCOUNT);
        expect(effective).toBeGreaterThanOrEqual(1);
        if (configured !== null) expect(effective).toBeLessThanOrEqual(configured);
      }),
    );
  });
});
