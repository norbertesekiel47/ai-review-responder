// src/lib/zernio/connect-start.ts
//
// The Zernio connect-start state machine (#1368), extracted from
// POST /api/zernio/connect/start so the route only gates (flag, same-origin,
// auth), parses the body, calls `startZernioConnect`, and maps errors.
//
// ADR 0001: the short OAuth-handshake calls (createProfile, startConnect, and
// the best-effort orphan deletes) still run inside that one user-blocking
// request — this module moves the logic, not the runtime. Takes `sql` as a
// parameter (invariant #15).
//
// Contract: returns `{ status, body }` for every outcome the route answers
// directly; THROWS `ZernioRouteError` (and any unexpected error) for the
// route's shared `zernioRouteErrorResponse` mapping. The request lock is
// released (token CAS) on every path that acquired it, before the throw
// leaves this module.

import type { Sql } from 'postgres';
import {
  activeOffboardingStateFromProjection,
  isConnectBlocked,
  type ActiveOffboardingProjection,
} from '@/lib/account-offboarding/gate';
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue';
import { makeAnalyticsEventKey } from '@/lib/analytics/events';
import { getCacheRedis } from '@/lib/db/redis-cache';
import { ZernioRouteError } from '@/lib/zernio/errors';
import { assertWritableSubscriptionStatus } from '@/lib/shared/writable-subscription';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { zernioClient } from '@/lib/zernio/client';
import { isFreshPendingMarker, parseConnectPendingMarker } from '@/lib/zernio/pending-flow';
import {
  pendingKey,
  stateKey,
  profileStateKey,
  lockKey,
  generateFlowId,
  generateState,
  generateLockToken,
  luaTokenCAS,
  luaCASUpdate,
  luaCASDel,
} from '@/lib/zernio/connect-state';
import type { ConnectPendingMarker, ConnectStateBlob } from '@/lib/zernio/types';
import type { AccountFlagsInput } from '@/lib/shared/past-due-recovery';
import { getServerConfig } from '@/lib/config/server';

const PENDING_TTL_SECONDS = 900; // 15 min — matches Zernio connect_token TTL
const LOCK_TTL_SECONDS = 30;
const REPORT_CONTEXT = 'api/zernio/connect/start';

export interface ConnectStartInput {
  userId: string;
  accountId: string;
  /** The location to connect: the requested one, else the owner's primary. */
  locationId: string;
  /** Analytics `location_scope`: 'location' when the body named a location. */
  locationScope: 'location' | 'all';
}

export type ConnectStartResult =
  | { status: 200; body: { authUrl: string } }
  | { status: number; body: { error: string; status?: string } };

function refuse(status: number, error: string, extra?: { status: string }): ConnectStartResult {
  return { status, body: extra ? { error, ...extra } : { error } };
}

/**
 * Subscription guard + location scope + offboarding refusal. After migration
 * 034 `subscription_status`'s source of truth is `accounts`; past-due accounts
 * remain writable until recovery closes. Null means proceed.
 */
async function checkAccountGate(
  sql: Sql,
  accountId: string,
  locationId: string,
): Promise<ConnectStartResult | null> {
  const [accountRow] = await sql<Array<{
    id: string;
    subscription_status: string;
    past_due_at: Date | string | null;
    flags: AccountFlagsInput;
  } & ActiveOffboardingProjection>>`
    SELECT a.id, a.subscription_status, a.past_due_at, a.flags,
         ao.id AS offboarding_id,
         ao.account_id AS offboarding_account_id,
         ao.mode AS offboarding_mode,
         ao.status AS offboarding_status,
         ao.failed_step AS offboarding_failed_step,
         ao.access_ends_at AS offboarding_access_ends_at,
         ao.teardown_started_at AS offboarding_teardown_started_at,
         ao.purge_after AS offboarding_purge_after,
         ao.purge_started_at AS offboarding_purge_started_at,
         ao.purge_cancelled_at AS offboarding_purge_cancelled_at
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    LEFT JOIN account_offboardings ao
      ON ao.account_id = a.id
     AND ao.account_id = ${accountId}
     AND ao.terminal_at IS NULL
    WHERE b.id = ${locationId}
      AND b.account_id = ${accountId}
      AND b.archived_at IS NULL
    ORDER BY ao.created_at DESC NULLS LAST
    LIMIT 1
  `;
  if (!accountRow) {
    return refuse(403, 'invalid_location_scope');
  }
  const writable = assertWritableSubscriptionStatus({
    subscriptionStatus: accountRow.subscription_status,
    pastDueAt: accountRow.past_due_at,
    accountFlags: accountRow.flags,
  });
  if (!writable.ok) {
    return refuse(writable.status, writable.error);
  }
  const offboardingState = activeOffboardingStateFromProjection(accountRow);
  if (isConnectBlocked(offboardingState)) {
    return refuse(403, 'account_offboarding_blocked');
  }
  return null;
}

/**
 * Step A — the long-lived (15-min TTL) pending-flow marker. Null means no
 * marker, or a stale one that the new flow's placeholder will overwrite.
 */
function pendingMarkerRefusal(existingPending: string | null): ConnectStartResult | null {
  if (!existingPending) return null;
  const parsed = parseConnectPendingMarker(existingPending);
  if (!parsed) {
    return refuse(409, 'malformed_pending_marker');
  }
  // Round-X (Fix 3): finalize_unknown is an admin-required terminal-ish
  // state. If the corresponding zernio_finalize_incidents row failed to
  // insert (transient DB error), this Redis marker is the only safety
  // net. It MUST NOT be auto-recovered by the stale-age fall-through
  // below — admin must reconcile before a new flow can start.
  if (parsed.status === 'finalize_unknown') {
    return refuse(409, 'finalize_unknown_admin_required');
  }
  // Defensive: if started >15 min ago, the TTL should have already
  // expired but Redis clock skew or a freshly-bumped marker can leave
  // a stale entry. Fall through and recreate in that case.
  if (isFreshPendingMarker(parsed, PENDING_TTL_SECONDS)) {
    return refuse(409, 'connect_pending', { status: parsed.status });
  }
  return null;
}

/**
 * Reconnect self-heal: a prior disconnected connection at this location
 * leaves an orphaned Zernio profile whose name is deterministic
 * (`${ZERNIO_PROFILE_ID_PREFIX}${locationId}`), so createProfile would
 * collide → Zernio 400 and the owner could never reconnect (the
 * `auth_error_on_post` → reconnect-400 loop). Zernio REFUSES to delete a
 * profile that still has a connected account, so the account goes FIRST,
 * then the profile. Both best-effort: a 404 (already gone) is fine and no
 * orphan is a no-op. Cleaning up HERE (not in every disconnect path) keeps
 * reconnect self-healing regardless of how the disconnect happened.
 */
async function deleteOrphanedProfiles(sql: Sql, locationId: string): Promise<void> {
  const orphanedConnections = await sql<{
    zernio_account_id: string | null;
    zernio_profile_id: string;
  }[]>`
    SELECT DISTINCT zernio_account_id, zernio_profile_id
    FROM zernio_connections
    WHERE business_id = ${locationId}
      AND status = 'disconnected'
      AND zernio_profile_id IS NOT NULL
  `;
  for (const orphan of orphanedConnections) {
    if (orphan.zernio_account_id) {
      await zernioClient.deleteAccount(orphan.zernio_account_id).catch((cleanupErr) => {
        reportCaughtError(REPORT_CONTEXT, cleanupErr, {
          step: 'orphaned_account_cleanup',
          accountId: orphan.zernio_account_id,
          businessId: locationId,
        });
      });
    }
    await zernioClient.deleteProfile(orphan.zernio_profile_id).catch((cleanupErr) => {
      reportCaughtError(REPORT_CONTEXT, cleanupErr, {
        step: 'orphaned_profile_cleanup',
        profileId: orphan.zernio_profile_id,
        businessId: locationId,
      });
    });
  }
}

type CacheRedis = ReturnType<typeof getCacheRedis>;

/** Per-flow identity shared by the locked steps. */
interface FlowContext {
  userId: string;
  accountId: string;
  locationId: string;
  locationScope: 'location' | 'all';
  pKey: string;
  flowId: string;
  startedAt: number;
}

/**
 * What Step D created so far — filled in as each resource exists, so Step F
 * cleans up exactly what this flow made, whichever sub-step threw.
 */
interface CreatedResources {
  state: string | null;
  profileId: string | null;
  profileStateKey: string | null;
}

/** Step B-bis / B-tris — DB idempotency checks BEFORE planting the marker. */
async function assertNoOpenConnection(sql: Sql, locationId: string): Promise<void> {
  const existingActive = await sql<{ exists: number }[]>`
    SELECT 1 AS exists
    FROM zernio_connections
    WHERE business_id = ${locationId} AND status IN ('pending', 'active')
    LIMIT 1
  `;
  if (existingActive.length > 0) {
    throw new ZernioRouteError(409, 'already_connected');
  }

  // Round-15 — block if a finalize_unknown incident is unresolved.
  const unresolvedIncident = await sql<{ exists: number }[]>`
    SELECT 1 AS exists
    FROM zernio_finalize_incidents
    WHERE business_id = ${locationId} AND resolved_at IS NULL
    LIMIT 1
  `;
  if (unresolvedIncident.length > 0) {
    throw new ZernioRouteError(409, 'finalize_unknown_admin_required');
  }
}

/**
 * Capture gbp_connect_started server-side (account-scoped, like gbp_connected)
 * so the per-account connect funnel joins. The client cannot — it has no
 * account_id and would attribute the event to an anonymous cookie. Keyed on
 * flowId so legitimate retries are not deduped. Best-effort: never blocks connect.
 */
async function recordConnectStarted(sql: Sql, ctx: FlowContext): Promise<void> {
  try {
    await enqueueAnalyticsEvent(sql, {
      eventName: 'gbp_connect_started',
      eventKey: makeAnalyticsEventKey('gbp_connect_started', [ctx.locationId, ctx.flowId]),
      distinctId: ctx.accountId,
      accountId: ctx.accountId,
      businessId: ctx.locationId,
      properties: {
        account_id: ctx.accountId,
        business_id: ctx.locationId,
        location_scope: ctx.locationScope,
      },
    });
  } catch (analyticsErr) {
    reportCaughtError(REPORT_CONTEXT, analyticsErr, {
      step: 'gbp_connect_started_enqueue',
      businessId: ctx.locationId,
      flowId: ctx.flowId,
    });
  }
}

/**
 * Step D + E — the OAuth handshake behind the placeholder marker: orphan
 * self-heal, Zernio profile, OAuth start, state keys, then the marker CAS to
 * `oauth_in_progress`. Records each created resource in `created` as it
 * comes into existence. Returns the Zernio `authUrl`.
 */
async function performHandshake(
  sql: Sql,
  redis: CacheRedis,
  ctx: FlowContext,
  placeholderRaw: string,
  created: CreatedResources,
): Promise<string> {
  await deleteOrphanedProfiles(sql, ctx.locationId);

  const profileIdPrefix = getServerConfig().ZERNIO_PROFILE_ID_PREFIX ?? 'repworth-prod-';
  const { profileId } = await zernioClient.createProfile({
    name: `${profileIdPrefix}${ctx.locationId}`,
  });
  created.profileId = profileId;

  const requestedState = generateState();

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    throw new ZernioRouteError(500, 'app_url_not_configured');
  }
  const redirectUrl = `${appUrl}/api/zernio/connect/callback`;
  const { authUrl, state: returnedState } = await zernioClient.startConnect({
    profileId,
    state: requestedState,
    redirectUrl,
  });
  const state = returnedState ?? requestedState;
  const stateBlob: ConnectStateBlob = {
    businessId: ctx.locationId,
    profileId,
    userId: ctx.userId,
    createdAt: ctx.startedAt,
  };
  await redis.setex(stateKey(state), PENDING_TTL_SECONDS, JSON.stringify(stateBlob));
  await redis.setex(profileStateKey(profileId), PENDING_TTL_SECONDS, state);
  created.state = state;
  created.profileStateKey = profileStateKey(profileId);

  // Step E — Update pending marker with profileId + state via CAS.
  const fullMarker: ConnectPendingMarker = {
    flowId: ctx.flowId,
    userId: ctx.userId,
    started_at: ctx.startedAt,
    status: 'oauth_in_progress',
    profileId,
    state,
  };
  const updateResult = await redis.eval(
    luaCASUpdate,
    1,
    ctx.pKey,
    placeholderRaw,
    JSON.stringify(fullMarker),
    String(PENDING_TTL_SECONDS),
  );
  if (!updateResult) {
    // Marker overwritten/deleted by a newer flow — our flow is superseded.
    throw new ZernioRouteError(409, 'flow_superseded_during_start');
  }
  return authUrl;
}

/** Step F — failure cleanup, all best-effort. CAS-delete only if the marker is still ours. */
async function cleanupFailedStart(
  redis: CacheRedis,
  pKey: string,
  placeholderRaw: string,
  created: CreatedResources,
): Promise<void> {
  await redis
    .eval(luaCASDel, 1, pKey, placeholderRaw)
    .catch(() => {
      // Best-effort: marker either gone or overwritten; leave it alone.
    });
  if (created.state) {
    await redis.del(stateKey(created.state)).catch(() => {
      // Best-effort.
    });
  }
  if (created.profileStateKey) {
    await redis.del(created.profileStateKey).catch(() => {
      // Best-effort.
    });
  }
  if (created.profileId) {
    await zernioClient.deleteProfile(created.profileId).catch(() => {
      // Best-effort orphan cleanup at Zernio.
    });
  }
}

/** Everything behind the request lock: idempotency checks, Step C marker, Step D–F. */
async function runLockedStart(sql: Sql, redis: CacheRedis, ctx: FlowContext): Promise<string> {
  await assertNoOpenConnection(sql, ctx.locationId);

  // Step C — PLACEHOLDER pending marker, BEFORE any external call.
  const placeholderMarker: ConnectPendingMarker = {
    flowId: ctx.flowId,
    userId: ctx.userId,
    started_at: ctx.startedAt,
    status: 'starting',
  };
  const placeholderRaw = JSON.stringify(placeholderMarker);
  await redis.set(ctx.pKey, placeholderRaw, 'EX', PENDING_TTL_SECONDS);

  const created: CreatedResources = { state: null, profileId: null, profileStateKey: null };
  try {
    const authUrl = await performHandshake(sql, redis, ctx, placeholderRaw, created);
    await recordConnectStarted(sql, ctx);
    return authUrl;
  } catch (startErr) {
    await cleanupFailedStart(redis, ctx.pKey, placeholderRaw, created);
    throw startErr;
  }
}

/**
 * Starts (or refuses) a Zernio OAuth connect flow for one owned location and
 * returns the Zernio `authUrl`. Callers authenticate, enforce same-origin and
 * the publishing flag, and resolve `locationId` first.
 */
export async function startZernioConnect(
  sql: Sql,
  input: ConnectStartInput,
): Promise<ConnectStartResult> {
  const gated = await checkAccountGate(sql, input.accountId, input.locationId);
  if (gated) return gated;

  const redis = getCacheRedis();
  const pKey = pendingKey(input.locationId);
  const lKey = lockKey(input.locationId);

  const pendingRefusal = pendingMarkerRefusal(await redis.get(pKey));
  if (pendingRefusal) return pendingRefusal;

  // Step B — Request lock (short-lived, 30s TTL, token-stamped).
  const lockToken = generateLockToken();
  const acquired = await redis.set(lKey, lockToken, 'EX', LOCK_TTL_SECONDS, 'NX');
  if (!acquired) {
    return refuse(429, 'connect_in_progress');
  }

  const ctx: FlowContext = { ...input, pKey, flowId: generateFlowId(), startedAt: Date.now() };
  try {
    const authUrl = await runLockedStart(sql, redis, ctx);
    return { status: 200, body: { authUrl } };
  } finally {
    // Lock release — compare-and-delete (token-stamped).
    await redis.eval(luaTokenCAS, 1, lKey, lockToken).catch(() => {
      // Best-effort: if the lock was already released or ownership changed,
      // the 30s TTL is the safety net.
    });
  }
}
