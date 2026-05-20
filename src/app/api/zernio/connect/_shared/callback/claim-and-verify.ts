import type { NextRequest } from 'next/server';
import { getCacheRedis } from '@/lib/db/redis-cache';
import { getCurrentUser } from '@/lib/db/auth';
import { pendingKey, stateKey, profileStateKey } from '@/lib/zernio/connect-state';
import type { ConnectStateBlob, ConnectPendingMarker } from '@/lib/zernio/types';

export type ClaimResult =
  | { ok: true; stored: ConnectStateBlob; pending: ConnectPendingMarker; userId: string }
  | {
      ok: false;
      code:
        | 'state_expired'
        | 'malformed_state'
        | 'pending_missing'
        | 'malformed_pending'
        | 'flow_mismatch'
        | 'user_mismatch'
        | 'internal_error';
      cleanupProfileId: string | null;
    };

/**
 * Callback steps 3–5 (spec §3.2 step 2): atomic single-use claim of
 * connect_state, first pending-marker verification, and owner re-auth.
 *
 * On failure, returns a discriminated result whose `cleanupProfileId` tells
 * the orchestrator whether to run cleanupOrphanedProfileBestEffort:
 *   - `null` for the state-claim failures (internal_error on the state GETDEL,
 *     state_expired, malformed_state) — these do NOT touch the profile.
 *   - `stored.profileId` once the state blob is in hand and a pending/auth
 *     check fails (internal_error on the pending GET, pending_missing,
 *     malformed_pending, flow_mismatch, user_mismatch).
 *
 * The best-effort connect_profile_state delete (after parsing the state blob)
 * stays inside this module — it is part of the claim, not failure cleanup.
 */
export async function claimAndVerifyConnectState(
  req: NextRequest,
  state: string,
): Promise<ClaimResult> {
  const redis = getCacheRedis();

  // 3. Atomic state claim. ioredis exposes `getdel` (atomic GET+DEL) on Redis
  // 6.2+. Single-use prevents replay even if every later step fails.
  let stateRaw: string | null;
  try {
    stateRaw = await redis.getdel(stateKey(state));
  } catch (err) {
    console.error('[api/zernio/connect/callback] redis getdel failed:', err);
    return { ok: false, code: 'internal_error', cleanupProfileId: null };
  }
  if (!stateRaw) {
    return { ok: false, code: 'state_expired', cleanupProfileId: null };
  }

  let stored: ConnectStateBlob;
  try {
    stored = JSON.parse(stateRaw) as ConnectStateBlob;
  } catch {
    return { ok: false, code: 'malformed_state', cleanupProfileId: null };
  }
  await redis.del(profileStateKey(stored.profileId)).catch(() => {
    // Best-effort: profile lookup auto-expires.
  });

  // 4. First pending verification.
  let pendingRaw: string | null;
  try {
    pendingRaw = await redis.get(pendingKey(stored.businessId));
  } catch (err) {
    console.error('[api/zernio/connect/callback] redis get pending failed:', err);
    return { ok: false, code: 'internal_error', cleanupProfileId: stored.profileId };
  }
  if (!pendingRaw) {
    return { ok: false, code: 'pending_missing', cleanupProfileId: stored.profileId };
  }

  let pending: ConnectPendingMarker;
  try {
    pending = JSON.parse(pendingRaw) as ConnectPendingMarker;
  } catch {
    return { ok: false, code: 'malformed_pending', cleanupProfileId: stored.profileId };
  }

  if (
    pending.state !== state ||
    pending.profileId !== stored.profileId ||
    pending.status !== 'oauth_in_progress'
  ) {
    return { ok: false, code: 'flow_mismatch', cleanupProfileId: stored.profileId };
  }

  // 5. Re-auth — owner session must match the user who initiated the flow.
  // Use getCurrentUser (returns null) instead of requireRole (throws) so we
  // can convert auth failures into the same friendly redirect surface.
  const user = await getCurrentUser(req).catch(() => null);
  if (!user || user.id !== stored.userId || user.id !== pending.userId) {
    return { ok: false, code: 'user_mismatch', cleanupProfileId: stored.profileId };
  }

  return { ok: true, stored, pending, userId: user.id };
}
