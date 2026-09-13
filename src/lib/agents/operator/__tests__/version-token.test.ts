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
  computeAutoApprovalVersionToken,
  parseVersionToken,
  versionTokensEqual,
  type PolicyRowVersion,
  type VersionToken,
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
  /**
   * BOTH fields draw from a SMALL constant set, and that is the whole point of
   * the generator. `fc.string()` for `updatedAt` made a collision on that field
   * vanishingly unlikely, so the property only ever generated pairs that
   * differed in the timestamp — and an implementation that compared the
   * timestamp ALONE (dropping the `businessId` half) passed every run. Three
   * timestamps and two business ids give six combinations, so the
   * different-businessId/same-updatedAt pair the invariant turns on is
   * generated many times over.
   */
  const token = fc.record({
    businessId: fc.constantFrom(BUSINESS, OTHER_BUSINESS),
    updatedAt: fc.constantFrom(
      '2026-09-12 10:00:00.123456+00',
      '2026-09-12 10:00:00.123457+00',
      '2026-09-12 11:30:00+00',
    ),
  });

  it('invariants: equal version tokens are exactly those with equal businessId and equal updatedAt text', () => {
    // Every combination the generator can draw must be seen, including the two
    // that kill a one-field comparison: same businessId / different updatedAt,
    // and DIFFERENT businessId / same updatedAt.
    const seen = new Set<string>();
    fc.assert(
      fc.property(token, token, (a, b) => {
        seen.add(`${a.businessId === b.businessId}:${a.updatedAt === b.updatedAt}`);
        const expected = a.businessId === b.businessId && a.updatedAt === b.updatedAt;
        expect(versionTokensEqual(a, b)).toBe(expected);
        // Symmetric, and reflexive on a fresh copy.
        expect(versionTokensEqual(b, a)).toBe(expected);
        expect(versionTokensEqual(a, { ...a })).toBe(true);
      }),
      { numRuns: 200 },
    );
    expect([...seen].sort()).toEqual(['false:false', 'false:true', 'true:false', 'true:true']);
  });
});

const ACCOUNT_POLICY = '55555555-5555-4555-8555-555555555555';
const LOCATION_POLICY = '66666666-6666-4666-8666-666666666666';
const STAMP = '2026-09-12 10:00:00.123456+00';
const STAMP_PLUS_1US = '2026-09-12 10:00:00.123457+00';
const LATER_STAMP = '2026-09-12 11:30:00+00';
const ABSENT: PolicyRowVersion = { id: 'absent' };
const ACCOUNT_ROW: PolicyRowVersion = { id: ACCOUNT_POLICY, updatedAt: STAMP };
const LOCATION_ROW: PolicyRowVersion = { id: LOCATION_POLICY, updatedAt: STAMP };

describe('auto-approval version token', () => {
  it('compute: no locationRow property is the account shape and an absent sentinel is a targeted location', () => {
    const account = computeAutoApprovalVersionToken({ accountDefaultRow: ABSENT });
    expect(account).toStrictEqual({ accountDefaultRow: { id: 'absent' } });
    expect('locationRow' in account).toBe(false);

    const location = computeAutoApprovalVersionToken({ accountDefaultRow: ABSENT, locationRow: ABSENT });
    expect(location).toStrictEqual({ locationRow: { id: 'absent' }, accountDefaultRow: { id: 'absent' } });

    // Field-by-field copy: extra columns on a caller's row never reach the JSONB.
    const rowWithColumns = { id: ACCOUNT_POLICY, updatedAt: STAMP, max_rating: 5 };
    expect(computeAutoApprovalVersionToken({ accountDefaultRow: rowWithColumns }))
      .toStrictEqual({ accountDefaultRow: { id: ACCOUNT_POLICY, updatedAt: STAMP } });

    // The writer refuses to produce a token the parser would reject.
    expect(() => computeAutoApprovalVersionToken({ accountDefaultRow: { id: 'absent', updatedAt: STAMP } }))
      .toThrow(/computeAutoApprovalVersionToken/);
    expect(() => computeAutoApprovalVersionToken({ accountDefaultRow: { id: ACCOUNT_POLICY, updatedAt: '' } }))
      .toThrow(/computeAutoApprovalVersionToken/);
    // A present-but-undefined locationRow is not "account scope": it throws.
    expect(() => computeAutoApprovalVersionToken({ accountDefaultRow: ABSENT, locationRow: undefined }))
      .toThrow(/computeAutoApprovalVersionToken/);
  });

  it('parser accepts both auto-approval shapes, including the PgBouncer string form', () => {
    const accepted: VersionToken[] = [
      { accountDefaultRow: ABSENT },
      { accountDefaultRow: ACCOUNT_ROW },
      { locationRow: ABSENT, accountDefaultRow: ABSENT },
      { locationRow: LOCATION_ROW, accountDefaultRow: ACCOUNT_ROW },
    ];
    for (const token of accepted) {
      expect(parseVersionToken(token)).toEqual(token);
      expect(parseVersionToken(JSON.stringify(token))).toEqual(token);
    }
  });

  it('parser rejects a loose absent sentinel, a stamp-less present row, and missing or extra fields', () => {
    const rejected: unknown[] = [
      // The absent sentinel is exact.
      { accountDefaultRow: { id: 'absent', updatedAt: STAMP } },
      { accountDefaultRow: { id: 'ABSENT' } },
      { accountDefaultRow: 'absent' },
      { accountDefaultRow: {} },
      { accountDefaultRow: { id: null } },
      // A present row always has an id and a non-empty text stamp.
      { accountDefaultRow: { id: ACCOUNT_POLICY } },
      { accountDefaultRow: { id: ACCOUNT_POLICY, updatedAt: '' } },
      { accountDefaultRow: { id: ACCOUNT_POLICY, updatedAt: 1_757_671_200_123 } },
      { accountDefaultRow: { id: 'not-a-uuid', updatedAt: STAMP } },
      { accountDefaultRow: { id: ACCOUNT_POLICY, updatedAt: STAMP, businessId: BUSINESS } },
      // A location token without its parent row is not a token.
      { locationRow: ABSENT },
      { locationRow: LOCATION_ROW },
      // Extra top-level keys, including a mix of scopes.
      { accountDefaultRow: ABSENT, updatedAt: STAMP },
      { locationRow: ABSENT, accountDefaultRow: ABSENT, businessId: BUSINESS },
      { businessId: BUSINESS, updatedAt: STAMP, accountDefaultRow: ABSENT },
      {},
    ];
    for (const value of rejected) {
      expect(() => parseVersionToken(value)).toThrow(/prepared_version_token/);
    }
  });

  it('equality never crosses scopes, and account differs from location even when every row is absent', () => {
    const tokens: VersionToken[] = [
      { businessId: BUSINESS, updatedAt: STAMP },
      { accountDefaultRow: ABSENT },
      { locationRow: ABSENT, accountDefaultRow: ABSENT },
      { accountDefaultRow: ACCOUNT_ROW },
      { locationRow: ABSENT, accountDefaultRow: ACCOUNT_ROW },
    ];
    tokens.forEach((a, i) => {
      tokens.forEach((b, j) => {
        expect(versionTokensEqual(a, structuredClone(b))).toBe(i === j);
      });
    });
  });

  it('equality changes on one microsecond of either policy row, and on first-row creation', () => {
    const base: VersionToken = { locationRow: LOCATION_ROW, accountDefaultRow: ACCOUNT_ROW };
    expect(versionTokensEqual(base, structuredClone(base))).toBe(true);
    // Key order is not part of the token.
    expect(versionTokensEqual(base, { accountDefaultRow: ACCOUNT_ROW, locationRow: LOCATION_ROW })).toBe(true);

    expect(new Date(STAMP).getTime()).toBe(new Date(STAMP_PLUS_1US).getTime());
    expect(versionTokensEqual(base, {
      locationRow: { id: LOCATION_POLICY, updatedAt: STAMP_PLUS_1US },
      accountDefaultRow: ACCOUNT_ROW,
    })).toBe(false);
    expect(versionTokensEqual(base, {
      locationRow: LOCATION_ROW,
      accountDefaultRow: { id: ACCOUNT_POLICY, updatedAt: STAMP_PLUS_1US },
    })).toBe(false);
    // Same stamp on a different row id is a different row.
    expect(versionTokensEqual(base, {
      locationRow: { id: ACCOUNT_POLICY, updatedAt: STAMP },
      accountDefaultRow: ACCOUNT_ROW,
    })).toBe(false);
    // No normalization: an ISO spelling of the same instant is a different token.
    expect(versionTokensEqual(base, {
      locationRow: { id: LOCATION_POLICY, updatedAt: '2026-09-12T10:00:00.123456Z' },
      accountDefaultRow: ACCOUNT_ROW,
    })).toBe(false);

    // First-row creation: 'absent' matches only while the row stays absent.
    expect(versionTokensEqual({ accountDefaultRow: ABSENT }, { accountDefaultRow: ACCOUNT_ROW })).toBe(false);
    expect(versionTokensEqual(
      { locationRow: ABSENT, accountDefaultRow: ACCOUNT_ROW },
      { locationRow: LOCATION_ROW, accountDefaultRow: ACCOUNT_ROW },
    )).toBe(false);
    expect(versionTokensEqual(
      { locationRow: LOCATION_ROW, accountDefaultRow: ABSENT },
      { locationRow: LOCATION_ROW, accountDefaultRow: ACCOUNT_ROW },
    )).toBe(false);
  });

  it('a changed parent row invalidates both an inheriting and an overridden location', () => {
    const movedParent: PolicyRowVersion = { id: ACCOUNT_POLICY, updatedAt: LATER_STAMP };

    const inheriting: VersionToken = { locationRow: ABSENT, accountDefaultRow: ACCOUNT_ROW };
    expect(versionTokensEqual(inheriting, { locationRow: ABSENT, accountDefaultRow: ACCOUNT_ROW })).toBe(true);
    expect(versionTokensEqual(inheriting, { locationRow: ABSENT, accountDefaultRow: movedParent })).toBe(false);

    const overridden: VersionToken = { locationRow: LOCATION_ROW, accountDefaultRow: ACCOUNT_ROW };
    expect(versionTokensEqual(overridden, { locationRow: LOCATION_ROW, accountDefaultRow: ACCOUNT_ROW })).toBe(true);
    expect(versionTokensEqual(overridden, { locationRow: LOCATION_ROW, accountDefaultRow: movedParent })).toBe(false);
  });
});

describe('version token invariants across scopes', () => {
  /**
   * Small constant sets again, for the reason the voice property gives: every
   * collision the invariant turns on must be generated. The rows include the
   * absent sentinel, a one-microsecond pair, and a second id with the same
   * stamp, so a location pair that differs in ONLY the location row or ONLY the
   * parent row occurs many times.
   */
  const ROWS: PolicyRowVersion[] = [
    ABSENT,
    { id: ACCOUNT_POLICY, updatedAt: STAMP },
    { id: ACCOUNT_POLICY, updatedAt: STAMP_PLUS_1US },
    { id: LOCATION_POLICY, updatedAt: STAMP },
  ];
  const row = fc.constantFrom(...ROWS);
  const anyToken: fc.Arbitrary<VersionToken> = fc.oneof(
    fc.record({
      businessId: fc.constantFrom(BUSINESS, OTHER_BUSINESS),
      updatedAt: fc.constantFrom(STAMP, STAMP_PLUS_1US),
    }),
    fc.record({ accountDefaultRow: row }),
    fc.record({ locationRow: row, accountDefaultRow: row }),
  );

  // An independent oracle: a hand-built key per scope, never the implementation.
  const rowKey = (r: PolicyRowVersion): string => ('updatedAt' in r ? `row|${r.id}|${r.updatedAt}` : 'absent');
  const tokenKey = (t: VersionToken): string => {
    if ('businessId' in t) return `voice|${t.businessId}|${t.updatedAt}`;
    if ('locationRow' in t) return `location|${rowKey(t.locationRow)}|${rowKey(t.accountDefaultRow)}`;
    return `account|${rowKey(t.accountDefaultRow)}`;
  };
  const scope = (t: VersionToken): string => tokenKey(t).split('|')[0]!;

  it('invariants: tokens are equal exactly when scope and every row identity match, and parse round-trips', () => {
    const seen = new Set<string>();
    fc.assert(
      fc.property(anyToken, anyToken, (a, b) => {
        const expected = tokenKey(a) === tokenKey(b);
        expect(versionTokensEqual(a, structuredClone(b))).toBe(expected);
        expect(versionTokensEqual(b, a)).toBe(expected);
        expect(versionTokensEqual(a, parseVersionToken(JSON.stringify(a)))).toBe(true);

        if (scope(a) !== scope(b)) seen.add('cross-scope');
        else seen.add(expected ? 'same-scope-equal' : 'same-scope-unequal');
        if ('locationRow' in a && 'locationRow' in b) {
          const sameLocation = rowKey(a.locationRow) === rowKey(b.locationRow);
          const sameParent = rowKey(a.accountDefaultRow) === rowKey(b.accountDefaultRow);
          if (sameLocation !== sameParent) seen.add(sameLocation ? 'parent-only-differs' : 'location-only-differs');
        }
      }),
      { numRuns: 600 },
    );
    expect([...seen].sort()).toEqual([
      'cross-scope',
      'location-only-differs',
      'parent-only-differs',
      'same-scope-equal',
      'same-scope-unequal',
    ]);
  });
});
