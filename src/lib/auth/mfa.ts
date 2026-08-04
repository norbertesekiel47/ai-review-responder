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

/**
 * Gathers factors from a `listFactors()` payload — which reports them under
 * `totp` and/or `all` — and de-dupes by id, preserving first-seen order.
 *
 * The per-item projection is a parameter precisely because the two consumers
 * need different ones and must keep needing different ones: the challenge path
 * drops unverified factors, while the enrollment surfaces keep every factor so
 * a half-finished enrollment stays visible. Only this collect-and-dedupe
 * traversal is shared; nothing about what a factor *means* is.
 */
export function collectFactors<T extends { id: string }>(
  data: unknown,
  normalize: (raw: unknown) => T | null,
): T[] {
  if (!data || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  const candidates = [
    ...(Array.isArray(record.totp) ? record.totp : []),
    ...(Array.isArray(record.all) ? record.all : []),
  ];
  const unique = new Map<string, T>();
  for (const candidate of candidates) {
    const factor = normalize(candidate);
    if (factor) unique.set(factor.id, factor);
  }
  return [...unique.values()];
}

export function normalizeChallengeFactors(data: unknown): ChallengeFactor[] {
  return collectFactors(data, normalizeChallengeFactor);
}
