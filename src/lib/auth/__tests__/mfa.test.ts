import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  factorStatusBefore,
  requireAal2FromSupabase,
  requireCurrentAal2FromSupabase,
  normalizeChallengeFactors,
  nextFactorFriendlyName,
} from '../mfa';

describe('requireAal2FromSupabase', () => {
  it('allows current aal2 sessions', async () => {
    const supabase = {
      auth: {
        mfa: {
          getAuthenticatorAssuranceLevel: vi.fn(async () => ({
            data: { currentLevel: 'aal2', nextLevel: 'aal2' },
            error: null,
          })),
        },
      },
    } as never;

    await expect(requireAal2FromSupabase(supabase)).resolves.toEqual({ ok: true });
  });

  it('requires challenge for aal1 sessions with aal2 next level', async () => {
    const supabase = {
      auth: {
        mfa: {
          getAuthenticatorAssuranceLevel: vi.fn(async () => ({
            data: { currentLevel: 'aal1', nextLevel: 'aal2' },
            error: null,
          })),
        },
      },
    } as never;

    await expect(requireAal2FromSupabase(supabase)).resolves.toEqual({
      ok: false,
      reason: 'mfa_required',
    });
  });

  it('allows aal1 sessions when Supabase reports no enrolled second factor', async () => {
    const supabase = {
      auth: {
        mfa: {
          getAuthenticatorAssuranceLevel: vi.fn(async () => ({
            data: { currentLevel: 'aal1', nextLevel: 'aal1' },
            error: null,
          })),
        },
      },
    } as never;

    await expect(requireAal2FromSupabase(supabase)).resolves.toEqual({ ok: true });
  });

  it('fails closed when the AAL check errors', async () => {
    const supabase = {
      auth: {
        mfa: {
          getAuthenticatorAssuranceLevel: vi.fn(async () => ({
            data: null,
            error: new Error('network'),
          })),
        },
      },
    } as never;

    await expect(requireAal2FromSupabase(supabase)).resolves.toEqual({
      ok: false,
      reason: 'mfa_check_failed',
    });
  });
});

describe('requireCurrentAal2FromSupabase', () => {
  it('allows only sessions currently at aal2', async () => {
    const supabase = {
      auth: {
        mfa: {
          getAuthenticatorAssuranceLevel: vi.fn(async () => ({
            data: { currentLevel: 'aal2', nextLevel: 'aal2' },
            error: null,
          })),
        },
      },
    } as never;

    await expect(requireCurrentAal2FromSupabase(supabase)).resolves.toEqual({ ok: true });
  });

  it('rejects aal1 sessions even when no enrolled second factor exists', async () => {
    const supabase = {
      auth: {
        mfa: {
          getAuthenticatorAssuranceLevel: vi.fn(async () => ({
            data: { currentLevel: 'aal1', nextLevel: 'aal1' },
            error: null,
          })),
        },
      },
    } as never;

    await expect(requireCurrentAal2FromSupabase(supabase)).resolves.toEqual({
      ok: false,
      reason: 'mfa_required',
    });
  });
});

describe('normalizeChallengeFactors', () => {
  it('keeps verified factors and projects them to id + label', () => {
    expect(
      normalizeChallengeFactors({
        totp: [{ id: 'f1', friendly_name: 'Phone', status: 'verified' }],
      }),
    ).toEqual([{ id: 'f1', label: 'Phone' }]);
  });

  it('drops unverified factors — a half-enrolled factor cannot satisfy a challenge', () => {
    expect(
      normalizeChallengeFactors({
        totp: [{ id: 'f1', friendly_name: 'Phone', status: 'unverified' }],
      }),
    ).toEqual([]);
  });

  it('falls back to a generic label when the factor has no friendly name', () => {
    expect(
      normalizeChallengeFactors({ totp: [{ id: 'f1', status: 'verified' }] }),
    ).toEqual([{ id: 'f1', label: 'Authenticator app' }]);
  });

  it('accepts the camelCase spelling of friendlyName', () => {
    expect(
      normalizeChallengeFactors({
        totp: [{ id: 'f1', friendlyName: 'Laptop', status: 'verified' }],
      }),
    ).toEqual([{ id: 'f1', label: 'Laptop' }]);
  });

  it('dedupes a factor appearing in both totp and all', () => {
    expect(
      normalizeChallengeFactors({
        totp: [{ id: 'f1', friendly_name: 'Phone', status: 'verified' }],
        all: [{ id: 'f1', friendly_name: 'Phone', status: 'verified' }],
      }),
    ).toEqual([{ id: 'f1', label: 'Phone' }]);
  });

  it('returns an empty array for junk input rather than throwing', () => {
    expect(normalizeChallengeFactors(null)).toEqual([]);
    expect(normalizeChallengeFactors('nope')).toEqual([]);
    expect(normalizeChallengeFactors({})).toEqual([]);
  });

  it('skips entries with no string id', () => {
    expect(
      normalizeChallengeFactors({ totp: [{ friendly_name: 'X', status: 'verified' }] }),
    ).toEqual([]);
  });
});

describe('nextFactorFriendlyName', () => {
  it('nextFactorFriendlyName returns RepWorth when no factor holds it', () => {
    expect(nextFactorFriendlyName([])).toBe('RepWorth');
    expect(nextFactorFriendlyName(['Laptop', null])).toBe('RepWorth');
  });

  it('nextFactorFriendlyName returns the first unused numbered name and fills a gap', () => {
    expect(nextFactorFriendlyName(['RepWorth'])).toBe('RepWorth 2');
    expect(nextFactorFriendlyName(['RepWorth', 'RepWorth 3'])).toBe('RepWorth 2');
    expect(nextFactorFriendlyName(['RepWorth', 'RepWorth 2'])).toBe('RepWorth 3');
  });

  it('nextFactorFriendlyName ignores null names and names outside the sequence', () => {
    expect(nextFactorFriendlyName(['RepWorth', null, 'Laptop', 'repworth 2'])).toBe('RepWorth 2');
  });
});

// Property tests (fast-check): the house style for invariant-level coverage —
// /feature requires at least one per declared invariant on billing/approval/
// escalation logic (feature.md step 5).
describe('nextFactorFriendlyName invariants', () => {
  // Biased toward the `RepWorth`/`RepWorth N` sequence itself — an arbitrary
  // drawn from `fc.string()` alone almost never lands inside the sequence, so
  // the property below never falsifies against the mutant that hardcodes
  // `return 'RepWorth'`. Mixing in the sequence values, arbitrary strings, and
  // null gives the property real inputs to fail on.
  const existingNamesArb = fc.array(
    fc.oneof(
      fc.constantFrom('RepWorth', 'RepWorth 2', 'RepWorth 3', 'RepWorth 4', 'RepWorth 5'),
      fc.string(),
      fc.constant(null),
    ),
    { maxLength: 20 },
  );

  it('invariant: nextFactorFriendlyName never returns a name an existing factor holds', () => {
    fc.assert(
      fc.property(existingNamesArb, (existingNames) => {
        const next = nextFactorFriendlyName(existingNames);
        expect(existingNames).not.toContain(next);
      }),
    );
  });

  it('invariant: the result is always the first unused name in the sequence', () => {
    fc.assert(
      fc.property(existingNamesArb, (existingNames) => {
        const taken = new Set(existingNames.filter((name): name is string => name !== null));
        const next = nextFactorFriendlyName(existingNames);
        const match = /^RepWorth(?: (\d+))?$/.exec(next);
        expect(match).not.toBeNull();
        const n = match![1] ? Number(match![1]) : 1;
        for (let i = 1; i < n; i += 1) {
          const smaller = i === 1 ? 'RepWorth' : `RepWorth ${i}`;
          expect(taken.has(smaller)).toBe(true);
        }
      }),
    );
  });
});

describe('factorStatusBefore', () => {
  it('reports unverified for a factor still mid-enrollment', () => {
    expect(
      factorStatusBefore([{ id: 'f1', status: 'unverified', factor_type: 'totp' }], 'f1'),
    ).toBe('unverified');
  });

  it('reports verified for an already-enrolled factor', () => {
    expect(
      factorStatusBefore(
        [
          { id: 'f0', status: 'unverified' },
          { id: 'f1', status: 'verified' },
        ],
        'f1',
      ),
    ).toBe('verified');
  });

  it('reports unknown when the list is absent, the id is missing, or the status is not a known value', () => {
    expect(factorStatusBefore(undefined, 'f1')).toBe('unknown');
    expect(factorStatusBefore(null, 'f1')).toBe('unknown');
    expect(factorStatusBefore([], 'f1')).toBe('unknown');
    expect(factorStatusBefore([{ id: 'f2', status: 'verified' }], 'f1')).toBe('unknown');
    expect(factorStatusBefore([{ id: 'f1', status: 'pending' }], 'f1')).toBe('unknown');
    expect(factorStatusBefore([null, 'junk', 42], 'f1')).toBe('unknown');
  });
});
