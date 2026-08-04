import { describe, expect, it, vi } from 'vitest';
import {
  requireAal2FromSupabase,
  requireCurrentAal2FromSupabase,
  normalizeChallengeFactors,
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
