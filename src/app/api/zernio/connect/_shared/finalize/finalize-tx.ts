import { v7 as uuidv7 } from 'uuid';
import {
  activeOffboardingStateFromProjection,
  isConnectBlocked,
  type ActiveOffboardingProjection,
} from '@/lib/account-offboarding/gate';
import { sql, jsonb } from '@/lib/db/server';
import { ZernioRouteError } from '@/lib/zernio/errors';
import { assertWritableSubscriptionStatus } from '@/lib/shared/writable-subscription';
import type { AppUser } from '@/lib/db/auth';
import type { ConnectLocationsBlob } from '@/lib/zernio/types';
import type { AccountFlagsInput } from '@/lib/shared/past-due-recovery';
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue';
import { makeAnalyticsEventKey } from '@/lib/analytics/events';

interface FinalizeConnectionTxArgs {
  user: AppUser;
  stored: ConnectLocationsBlob;
  locationId: string;
  accountId: string;
}

/**
 * Step 8d: the single durable finalize transaction. INSERT/UPDATE the
 * `zernio_connections` row + drain outbox + (on first activation per the
 * needs_backfill predicate) the initial-backfill outbox enqueue — ALL inside
 * one `sql.begin` per spec §6.8 (transactional outbox). Throws
 * `ZernioRouteError(403, ...)` for scope/subscription failures; any DB error
 * propagates to the caller's orphan-recovery branch.
 */
export async function finalizeConnectionTx({
  user,
  stored,
  locationId,
  accountId,
}: FinalizeConnectionTxArgs): Promise<void> {
  const newConnectionId = uuidv7();
  const ownerAccountId = user.accountId;
  if (!ownerAccountId) {
    throw new ZernioRouteError(403, 'business_mismatch');
  }

  await sql.begin(async (tx) => {
    const [accountLocation] = await tx<
      Array<{
        account_id: string;
        subscription_status: string;
        past_due_at: Date | string | null;
        flags: AccountFlagsInput;
        subscription_tier: string;
        subscription_activated_at: Date | null;
      } & ActiveOffboardingProjection>
    >`
      SELECT
        a.id AS account_id,
        a.subscription_status,
        a.past_due_at,
        a.flags,
        a.subscription_tier,
        a.subscription_activated_at,
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
      LEFT JOIN LATERAL (
        SELECT id, account_id, mode, status, failed_step, access_ends_at,
               teardown_started_at, purge_after, purge_started_at,
               purge_cancelled_at
        FROM account_offboardings
        WHERE account_id = a.id
          AND terminal_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1
      ) ao ON TRUE
      WHERE b.id = ${stored.businessId}
        AND b.account_id = ${ownerAccountId}
        AND b.archived_at IS NULL
      FOR UPDATE OF b, a
    `;

    if (!accountLocation) {
      throw new ZernioRouteError(403, 'business_mismatch');
    }
    const writable = assertWritableSubscriptionStatus({
      subscriptionStatus: accountLocation.subscription_status,
      pastDueAt: accountLocation.past_due_at,
      accountFlags: accountLocation.flags,
    });
    if (!writable.ok) {
      throw new ZernioRouteError(writable.status, writable.error);
    }
    const offboardingState = activeOffboardingStateFromProjection(accountLocation);
    if (isConnectBlocked(offboardingState)) {
      throw new ZernioRouteError(403, 'account_offboarding_blocked');
    }

    const [existingConnection] = await tx<{ id: string }[]>`
      SELECT id
      FROM zernio_connections
      WHERE business_id = ${stored.businessId}
        AND status IN ('active', 'pending')
      ORDER BY connected_at DESC NULLS LAST, created_at DESC
      LIMIT 1
      FOR UPDATE
    `;

    const connectionId = existingConnection?.id ?? newConnectionId;
    if (existingConnection) {
      await tx`
        UPDATE zernio_connections
        SET zernio_profile_id = ${stored.profileId},
            zernio_account_id = ${accountId},
            zernio_location_id = ${locationId},
            status = 'active',
            connected_at = NOW(),
            updated_at = NOW()
        WHERE id = ${existingConnection.id}
      `;
    } else {
      await tx`
        INSERT INTO zernio_connections (
          id, business_id, zernio_profile_id, zernio_account_id,
          zernio_location_id, status, connected_at, created_at, updated_at
        ) VALUES (
          ${newConnectionId},
          ${stored.businessId},
          ${stored.profileId},
          ${accountId},
          ${locationId},
          'active',
          NOW(),
          NOW(),
          NOW()
        )
      `;
    }

    await tx`
      INSERT INTO job_outbox (
        id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
      ) VALUES (
        ${uuidv7()},
        'drain_pending_owner_connect',
        'business',
        ${stored.businessId},
        ${jsonb({ business_id: stored.businessId, kind: 'drain' })},
        0,
        5
      )
    `;

    await enqueueAnalyticsEvent({
      eventName: 'gbp_connected',
      eventKey: makeAnalyticsEventKey('gbp_connected', [stored.businessId]),
      distinctId: ownerAccountId,
      accountId: ownerAccountId,
      businessId: stored.businessId,
      properties: {
        account_id: ownerAccountId,
        business_id: stored.businessId,
        location_count: stored.locations.length,
      },
    }, tx);

    // Backfill-needed predicate (spec §6.8 round-final M2). Fires when
    // EITHER (a) no prior connect existed for this business OR
    // (b) prior connections existed but no backfill has ever COMPLETED
    // (handles the case where a prior backfill auth-failed mid-flight).
    // The worker's ON CONFLICT (business_id) WHERE run_reason = 'initial'
    // DO NOTHING on zernio_backfill_runs is the second-line guard.
    //
    // KNOWN over-fire (issue #41 item 3, intentionally NOT fixed): on a
    // single-row reconnect, clause (a)'s `id != connectionId AND connected_at
    // IS NOT NULL` is always false (the only row is the one just updated,
    // excluded by id), so the predicate returns true and re-enqueues backfill
    // even when one already completed. This is benign — the ON CONFLICT guard
    // above makes the re-enqueue idempotent. A fix would gate clause (a) on the
    // PRE-update connected_at, but (a)/(b) are entangled and a wrong gate could
    // suppress the legitimate auth-failed-mid-flight re-fire, so we leave it.
    const [predicate] = await tx<{ needs_backfill: boolean }[]>`
      SELECT (
        NOT EXISTS (
          SELECT 1 FROM zernio_connections
          WHERE business_id = ${stored.businessId}
            AND id != ${connectionId}
            AND connected_at IS NOT NULL
        )
        OR NOT EXISTS (
          SELECT 1 FROM zernio_backfill_runs
          WHERE business_id = ${stored.businessId}
            AND completed_at IS NOT NULL
        )
      ) AS needs_backfill
    `;

    if (predicate?.needs_backfill) {
      if (accountLocation.subscription_activated_at) {
        await tx`
          INSERT INTO job_outbox (
            id, topic, aggregate_type, aggregate_id, payload, status
          ) VALUES (
            ${uuidv7()},
            'zernio_initial_backfill',
            'business',
            ${stored.businessId},
            ${jsonb({
              business_id: stored.businessId,
              zernio_account_id: accountId,
              zernio_location_id: locationId,
              subscription_tier: accountLocation.subscription_tier,
              subscription_activated_at:
                accountLocation.subscription_activated_at.toISOString(),
              correlation_id: uuidv7(),
            })},
            'pending'
          )
        `;
      } else {
        // Connect flow is gated on writable subscription state upstream, so
        // this branch is unreachable for activated accounts.
        console.warn(
          `[zernio-connect] Connect succeeded but subscription_activated_at NULL for ${stored.businessId}`,
        );
      }
    }
  });
}
