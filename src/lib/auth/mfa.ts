export type Aal2Result =
  | { ok: true }
  | { ok: false; reason: 'mfa_required' | 'mfa_check_failed' };

export interface SupabaseMfaAalClient {
  auth: {
    mfa: {
      getAuthenticatorAssuranceLevel: () => Promise<{
        data: { currentLevel: string | null; nextLevel: string | null } | null;
        error: unknown;
      }>;
    };
  };
}

export async function requireAal2FromSupabase(
  supabase: SupabaseMfaAalClient,
): Promise<Aal2Result> {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) {
    return { ok: false, reason: 'mfa_check_failed' };
  }
  if (data.nextLevel === 'aal2' && data.currentLevel !== 'aal2') {
    return { ok: false, reason: 'mfa_required' };
  }
  return { ok: true };
}

export function mfaChallengePath(next: string): string {
  return `/mfa/challenge?next=${encodeURIComponent(next)}`;
}
