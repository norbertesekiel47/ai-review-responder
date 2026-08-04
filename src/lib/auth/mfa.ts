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

export async function requireCurrentAal2FromSupabase(
  supabase: SupabaseMfaAalClient,
): Promise<Aal2Result> {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) {
    return { ok: false, reason: 'mfa_check_failed' };
  }
  if (data.currentLevel !== 'aal2') {
    return { ok: false, reason: 'mfa_required' };
  }
  return { ok: true };
}

export function mfaChallengePath(next: string): string {
  return `/mfa/challenge?next=${encodeURIComponent(next)}`;
}

/**
 * A verified MFA factor reduced to what a challenge UI needs: an id to
 * challenge against and a label to show. Anything not `verified` is dropped —
 * a factor mid-enrollment cannot satisfy a challenge.
 *
 * NOTE: `src/components/auth/useMfaEnrollment.ts` has a similar-looking
 * normalizer that deliberately keeps EVERY factor with its full shape, because
 * the settings surfaces must render an unverified factor so the user can finish
 * or abandon that enrollment. The two are not duplicates. Do not merge them.
 */
export interface ChallengeFactor {
  id: string;
  label: string;
}

function normalizeChallengeFactor(raw: unknown): ChallengeFactor | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string') return null;
  if (record.status !== 'verified') return null;
  const label =
    typeof record.friendly_name === 'string'
      ? record.friendly_name
      : typeof record.friendlyName === 'string'
        ? record.friendlyName
        : 'Authenticator app';
  return { id: record.id, label };
}

export function normalizeChallengeFactors(data: unknown): ChallengeFactor[] {
  if (!data || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  const candidates = [
    ...(Array.isArray(record.totp) ? record.totp : []),
    ...(Array.isArray(record.all) ? record.all : []),
  ];
  const unique = new Map<string, ChallengeFactor>();
  for (const candidate of candidates) {
    const factor = normalizeChallengeFactor(candidate);
    if (factor) unique.set(factor.id, factor);
  }
  return [...unique.values()];
}
