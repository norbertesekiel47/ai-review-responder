import { describe, expect, it, vi } from 'vitest';
import { requireAal2FromSupabase } from '../mfa';

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
