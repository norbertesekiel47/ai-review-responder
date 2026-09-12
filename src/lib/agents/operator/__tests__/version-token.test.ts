// Unit seams for src/lib/agents/operator/version-token.ts — the **Version
// token**'s type, its JSONB parse site and its equality.
//
// The microsecond case is the whole reason the token is text end-to-end:
// postgres.js decodes `timestamptz` into a JS `Date`, which holds milliseconds
// and silently truncates the microseconds Postgres stores (CLAUDE.md's
// timestamptz gotcha). A token built from a round-tripped Date compares EQUAL
// to a row written up to a microsecond later — a stale proposal reading as
// fresh, which is exactly the check the token exists to make.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  parseVersionToken,
  versionTokensEqual,
  type VoiceVersionToken,
} from '../version-token';

const BUSINESS = '33333333-3333-4333-8333-333333333333';
const OTHER_BUSINESS = '44444444-4444-4444-8444-444444444444';

describe('voice version token', () => {
  it('version token equality is text-to-text on both fields and a one-microsecond difference is not equal', () => {
    const base: VoiceVersionToken = {
      businessId: BUSINESS,
      updatedAt: '2026-09-12 10:00:00.123456+00',
    };

    expect(versionTokensEqual(base, { ...base })).toBe(true);

    // One MICROSECOND later. A JS Date round trip flattens both of these to
    // 10:00:00.123 and would call them equal.
    const oneMicrosecondLater: VoiceVersionToken = {
      businessId: BUSINESS,
      updatedAt: '2026-09-12 10:00:00.123457+00',
    };
    expect(versionTokensEqual(base, oneMicrosecondLater)).toBe(false);
    expect(new Date(base.updatedAt).getTime()).toBe(
      new Date(oneMicrosecondLater.updatedAt).getTime(),
    );

    // The businessId half is compared too: the same instant on another row is
    // not the same token.
    expect(versionTokensEqual(base, { ...base, businessId: OTHER_BUSINESS })).toBe(false);

    // No normalization, deliberately: an ISO spelling of the same instant is a
    // DIFFERENT string and therefore a different token. The writer and the
    // reader both return `updated_at::text`, so they always agree; anything
    // that reformats has left the contract.
    expect(
      versionTokensEqual(base, { businessId: BUSINESS, updatedAt: '2026-09-12T10:00:00.123456Z' }),
    ).toBe(false);
  });

  it('version token parser rejects a stored token missing businessId or updatedAt', () => {
    expect(() => parseVersionToken({ updatedAt: '2026-09-12 10:00:00.123456+00' }))
      .toThrow(/prepared_version_token/);
    expect(() => parseVersionToken({ businessId: BUSINESS })).toThrow(/prepared_version_token/);
    expect(() => parseVersionToken(null)).toThrow(/prepared_version_token/);
    expect(() => parseVersionToken({ businessId: 'not-a-uuid', updatedAt: 'x' }))
      .toThrow(/prepared_version_token/);
    // An extra key is a shape no writer produces — `.strict()` rejects it
    // rather than dropping it silently.
    expect(() => parseVersionToken({
      businessId: BUSINESS,
      updatedAt: '2026-09-12 10:00:00.123456+00',
      locationRow: 'absent',
    })).toThrow(/prepared_version_token/);

    // The PgBouncer string form is the one shape that must succeed: the column
    // is JSONB and Postgres.js behind PgBouncer can hand it back as text.
    const stored = { businessId: BUSINESS, updatedAt: '2026-09-12 10:00:00.123456+00' };
    expect(parseVersionToken(JSON.stringify(stored))).toEqual(stored);
    expect(parseVersionToken(stored)).toEqual(stored);
  });
});

describe('voice version token invariants', () => {
  const token = fc.record({
    businessId: fc.constantFrom(BUSINESS, OTHER_BUSINESS),
    updatedAt: fc.string({ minLength: 1, maxLength: 40 }),
  });

  it('invariants: equal version tokens are exactly those with equal businessId and equal updatedAt text', () => {
    fc.assert(
      fc.property(token, token, (a, b) => {
        const expected = a.businessId === b.businessId && a.updatedAt === b.updatedAt;
        expect(versionTokensEqual(a, b)).toBe(expected);
        // Symmetric, and reflexive on a fresh copy.
        expect(versionTokensEqual(b, a)).toBe(expected);
        expect(versionTokensEqual(a, { ...a })).toBe(true);
      }),
    );
  });
});
