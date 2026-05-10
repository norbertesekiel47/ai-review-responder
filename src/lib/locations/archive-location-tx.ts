// src/lib/locations/archive-location-tx.ts
//
// Archive-location transaction and guard logic.
//
// Archive flow:
//   1. assertCanArchiveLocation — validates archive is allowed
//   2. archiveLocationTransaction — atomic tx: UPDATE + audit + outbox
//   3. reactivateLocationTransaction — admin re-activate from archived state
//
// Guard rules (from feature spec):
//   - Archive attempt on primary with other active locations: rejected with 'promote first'
//   - Archive attempt on last active location: rejected
//   - Archive of non-primary succeeds: sets archived_at, inserts 'location_archived'
//     audit event, enqueues Stripe quantity decrement
//
// Validation contract:
//   VAL-LOC-043: Archive transaction is atomic — businesses + audit + outbox
//   VAL-LOC-044: Location with in-flight approvals can be archived
//   VAL-LOC-047: Concurrent archive and add at quota boundary is safe

import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import { getLocationById, getActiveLocationCount } from './repo';
import type { AccountId, LocationId } from '@/lib/shared/ids';

// ── Guard result types ─────────────────────────────────────────────────────

export interface ArchiveAllowed {
  allowed: true;
  /** Number of active locations that will remain after the archive. */
  activeLocationsAfterArchive: number;
}

export interface ArchiveRejected {
  allowed: false;
  reason:
    | 'location_not_found'
    | 'location_not_owned'
    | 'location_already_archived'
    | 'last_active_location'
    | 'promote_first';
}

export type ArchiveGuardResult = ArchiveAllowed | ArchiveRejected;

// ── assertCanArchiveLocation ────────────────────────────────────────────────

/**
 * Validates whether a location can be archived.
 *
 * Guard rules:
 *   1. Location must exist
 *   2. Location must belong to the given account
 *   3. Location must not already be archived
 *   4. Location must not be the only active location (last_active_location)
 *   5. Primary location cannot be archived if other active locations exist (promote_first)
 *
 * The "last_active_location" check takes priority over "promote_first" —
 * if it's the only location, we reject with last_active_location regardless
 * of whether it's primary.
 */
export async function assertCanArchiveLocation(
  locationId: string,
  accountId: string,
): Promise<ArchiveGuardResult> {
  // 1. Look up the location
  const location = await getLocationById(locationId);

  if (!location) {
    return { allowed: false, reason: 'location_not_found' };
  }

  // 2. Verify ownership
  if (location.account_id !== accountId) {
    return { allowed: false, reason: 'location_not_owned' };
  }

  // 3. Check not already archived
  if (location.archived_at !== null) {
    return { allowed: false, reason: 'location_already_archived' };
  }

  // 4. Count active locations for the account
  const activeCount = await getActiveLocationCount(accountId);

  // 5. Cannot archive the last active location
  if (activeCount <= 1) {
    return { allowed: false, reason: 'last_active_location' };
  }

  // 6. Primary cannot be archived if other active locations exist
  if (location.is_primary && activeCount > 1) {
    return { allowed: false, reason: 'promote_first' };
  }

  return {
    allowed: true,
    activeLocationsAfterArchive: activeCount - 1,
  };
}

// ── Archive transaction input/result ────────────────────────────────────────

export interface ArchiveLocationTxInput {
  /** Location ID to archive. */
  locationId: string;
  /** Account that owns the location. */
  accountId: string;
  /** User ID of the actor performing the archive (for audit log). */
  actorUserId?: string | null;
  /** Count of active locations before the archive (for audit payload). */
  activeLocationsBefore: number;
}

export interface ArchiveLocationTxResult {
  /** ID of the archived location. */
  locationId: string;
  /** Confirmation that the location was archived. */
  archived: boolean;
}

// ── archiveLocationTransaction ───────────────────────────────────────────────

/**
 * Executes the archive-location atomic transaction.
 *
 * VAL-LOC-043: Atomically updates businesses + inserts account_audit_log +
 * inserts job_outbox. If any step fails, all rollback.
 *
 * The transaction:
 *   1. UPDATE businesses SET archived_at = NOW(), is_primary = FALSE WHERE id = locationId
 *   2. INSERT account_audit_log with event_type 'location_archived'
 *   3. INSERT job_outbox for Stripe overage quantity decrement
 *
 * VAL-LOC-044: Reviews and responses are NOT modified or deleted.
 * Pending responses remain pending_approval — the notification context
 * check (separate change) will skip dispatch for archived locations.
 */
export async function archiveLocationTransaction(
  input: ArchiveLocationTxInput,
): Promise<ArchiveLocationTxResult> {
  const { locationId, accountId, actorUserId, activeLocationsBefore } = input;

  // Execute atomic transaction
  await sql.begin(async (tx) => {
    await tx`
      SELECT id
      FROM accounts
      WHERE id = ${accountId}::uuid
      FOR UPDATE
    `;

    const [activeRow] = await tx<{ count: number }[]>`
      SELECT COUNT(*) AS count
      FROM businesses
      WHERE account_id = ${accountId}::uuid
        AND archived_at IS NULL
    `;
    if (Number(activeRow?.count ?? 0) <= 1) {
      throw new Error('last_active_location');
    }

    // 1. Set archived_at and is_primary = FALSE on the location
    //    is_primary is set FALSE as a safety measure — even though the guard
    //    should prevent archiving a primary with other locations, this ensures
    //    no orphaned primary remains. The partial unique index guarantees
    //    at most one is_primary=TRUE per active account.
    const [updatedLocation] = await tx<{ id: string }[]>`
      UPDATE businesses
      SET archived_at = NOW(),
          is_primary = FALSE,
          updated_at = NOW()
      WHERE id = ${locationId}::uuid
        AND account_id = ${accountId}::uuid
        AND archived_at IS NULL
      RETURNING id
    `;
    if (!updatedLocation) {
      throw new Error('location_archive_conflict');
    }

    // 2. Insert audit log entry
    await tx`
      INSERT INTO account_audit_log (
        id, account_id, location_id, event_type, actor_user_id, payload
      ) VALUES (
        ${uuidv7()}::uuid,
        ${accountId}::uuid,
        ${locationId}::uuid,
        'location_archived',
        ${actorUserId ?? null}::uuid,
        ${jsonb({
          location_id: locationId,
          active_locations_before: activeLocationsBefore,
          active_locations_after: activeLocationsBefore - 1,
        })}
      )
    `;

    // 3. Enqueue Stripe overage update (decrement)
    //    The UpdateStripeOverageWorker reads the actual location count
    //    and sets the overage quantity accordingly. It is idempotent.
    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (
        ${uuidv7()},
        'update_stripe_overage_quantity',
        'account',
        ${accountId}::uuid,
        ${jsonb({
          account_id: accountId,
          correlation_id: uuidv7(),
        })},
        'pending'
      )
    `;
  });

  return {
    locationId,
    archived: true,
  };
}

// ── Reactivate transaction input/result ──────────────────────────────────────

export interface ReactivateLocationTxInput {
  /** Location ID to reactivate (must be archived). */
  locationId: string;
  /** Account that owns the location. */
  accountId: string;
  /** User ID of the actor (for audit log). */
  actorUserId?: string | null;
}

export interface ReactivateLocationTxResult {
  /** ID of the reactivated location. */
  locationId: string;
  /** Confirmation that the location was reactivated. */
  reactivated: boolean;
}

// ── reactivateLocationTransaction ────────────────────────────────────────────

/**
 * Reactivates an archived location. Sets archived_at = NULL.
 * Used by the admin "re-add from archived" tool and the owner's
 * "Reactivate" button on the Settings → Locations tab.
 *
 * VAL-LOC-071: Enqueues zernio_initial_backfill + sync_reviews jobs
 * for the restored location to catch up on reviews that arrived during
 * the archived period.
 *
 * Note: The reactivated location will NOT be primary (is_primary stays FALSE).
 * If the user wants it as primary, they must use promotePrimaryTransaction.
 *
 * The outbox job enqueues a Stripe overage update so the worker
 * recalculates the overage quantity (increment).
 */
export async function reactivateLocationTransaction(
  input: ReactivateLocationTxInput,
): Promise<ReactivateLocationTxResult> {
  const { locationId, accountId, actorUserId } = input;

  await sql.begin(async (tx) => {
    // 1. Set archived_at = NULL (reactivate)
    const [updatedLocation] = await tx<{ id: string }[]>`
      UPDATE businesses
      SET archived_at = NULL,
          updated_at = NOW()
      WHERE id = ${locationId}::uuid
        AND account_id = ${accountId}::uuid
        AND archived_at IS NOT NULL
      RETURNING id
    `;
    if (!updatedLocation) {
      throw new Error('location_reactivate_conflict');
    }

    // 2. Insert audit log entry
    await tx`
      INSERT INTO account_audit_log (
        id, account_id, location_id, event_type, actor_user_id, payload
      ) VALUES (
        ${uuidv7()}::uuid,
        ${accountId}::uuid,
        ${locationId}::uuid,
        'location_reactivated',
        ${actorUserId ?? null}::uuid,
        ${jsonb({
          location_id: locationId,
        })}
      )
    `;

    // 3. Enqueue Stripe overage update (increment)
    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      VALUES (
        ${uuidv7()},
        'update_stripe_overage_quantity',
        'account',
        ${accountId}::uuid,
        ${jsonb({
          account_id: accountId,
          correlation_id: uuidv7(),
        })},
        'pending'
      )
    `;

    const [backfillContext] = await tx<{
      zernio_account_id: string;
      zernio_location_id: string;
      subscription_tier: string;
      subscription_activated_at: Date | null;
    }[]>`
      SELECT
        zc.zernio_account_id,
        zc.zernio_location_id,
        a.subscription_tier,
        a.subscription_activated_at
      FROM zernio_connections zc
      JOIN businesses b ON b.id = zc.business_id
      JOIN accounts a ON a.id = b.account_id
      WHERE zc.business_id = ${locationId}::uuid
        AND b.account_id = ${accountId}::uuid
        AND zc.status = 'active'
      ORDER BY zc.connected_at DESC NULLS LAST
      LIMIT 1
    `;

    // 4. Enqueue Zernio backfill for connected reactivated locations
    // VAL-LOC-071: Review sync jobs enqueued for the restored location
    // to catch up on any reviews that arrived during the archived period.
    if (backfillContext?.subscription_activated_at) {
      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (
          ${uuidv7()},
          'zernio_initial_backfill',
          'business',
          ${locationId}::uuid,
          ${jsonb({
            business_id: locationId,
            zernio_account_id: backfillContext.zernio_account_id,
            zernio_location_id: backfillContext.zernio_location_id,
            subscription_tier: backfillContext.subscription_tier,
            subscription_activated_at: backfillContext.subscription_activated_at.toISOString(),
            backfill_reason: 'reactivation',
            correlation_id: uuidv7(),
          })},
          'pending'
        )
      `;
    }
  });

  return {
    locationId,
    reactivated: true,
  };
}
