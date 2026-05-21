import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import { ZernioRouteError } from '@/lib/zernio/errors';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import type { AppUser } from '@/lib/db/auth';
import type { ConnectLocationsBlob } from '@/lib/zernio/types';

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
  await sql.begin(async (tx) => {
    const [accountLocation] = await tx<
      {
        subscription_status: string;
        subscription_tier: string;
        subscription_activated_at: Date | null;
      }[]
    >`
      SELECT
        a.subscription_status,
        a.subscription_tier,
        a.subscription_activated_at
      FROM businesses b
      JOIN accounts a ON a.id = b.account_id
      WHERE b.id = ${stored.businessId}
        AND b.account_id = ${user.accountId}
        AND b.archived_at IS NULL
      FOR UPDATE OF b, a
    `;

    if (!accountLocation) {
      throw new ZernioRouteError(403, 'business_mismatch');
    }
    if (accountLocation.subscription_status !== SubscriptionStatus.ACTIVE) {
      throw new ZernioRouteError(403, 'subscription_required');
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

    // Backfill-needed predicate (spec §6.8 round-final M2). Fires when
    // EITHER (a) no prior connect existed for this business OR
    // (b) prior connections existed but no backfill has ever COMPLETED
    // (handles the case where a prior backfill auth-failed mid-flight).
    // The worker's ON CONFLICT (business_id) DO NOTHING on
    // zernio_backfill_runs is the second-line guard.
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
        // Pre-payment connect — connect flow is gated on active
        // subscription upstream, so this branch is unreachable.
        console.warn(
          `[zernio-connect] Connect succeeded but subscription_activated_at NULL for ${stored.businessId}`,
        );
      }
    }
  });
}
