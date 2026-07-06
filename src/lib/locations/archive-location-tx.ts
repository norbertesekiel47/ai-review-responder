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

import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { getLocationById, getActiveLocationCount } from './repo';
import { rethrowAsDuplicateLocation } from './duplicate-location';
import { enqueueStripeOverageRecompute, enqueueValidatePlaceId } from '@/lib/shared/job-outbox-helpers';

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
  sql: postgres.Sql,
  locationId: string,
  accountId: string,
): Promise<ArchiveGuardResult> {
  // 1. Look up the location
  const location = await getLocationById(sql, locationId);

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
  const activeCount = await getActiveLocationCount(sql, accountId);

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
}

export interface ArchiveLocationTxResult {
  /** ID of the archived location. */
  locationId: string;
  /** Confirmation that the location was archived. */
  archived: boolean;
}

export interface ArchiveLocationForOffboardingTeardownTxInput {
  locationId: string;
  accountId: string;
  accountOffboardingId: string;
}

export interface ArchiveLocationForOffboardingTeardownTxResult extends ArchiveLocationTxResult {
  alreadyArchived: boolean;
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
  sql: postgres.Sql,
  input: ArchiveLocationTxInput,
): Promise<ArchiveLocationTxResult> {
  const { locationId, accountId, actorUserId } = input;

  await sql.begin(async (tx) => {
    const context = await lockArchiveContext(tx, locationId, accountId);
    // Already archived (double-submit / concurrent archive): surface the
    // conflict BEFORE the count guard — the archived target no longer counts
    // as active, so on a 2-active-location account the count guard would
    // misreport last_active_location for a row that is simply already gone.
    if (context.archivedAt !== null) {
      throw new Error('location_archive_conflict');
    }
    if (context.activeLocationsBefore <= 1) {
      throw new Error('last_active_location');
    }
    // Race-proof primary guard: decide from the locked snapshot, not the UPDATE
    // rowcount. last_active_location is checked first (above) so the only-location
    // case never surfaces as promote_first.
    if (context.isPrimary) {
      throw new Error('promote_first');
    }
    await applyArchiveLocationUpdate(tx, {
      locationId,
      accountId,
      actorUserId,
      activeLocationsBefore: context.activeLocationsBefore,
    });
  });

  return {
    locationId,
    archived: true,
  };
}

export async function archiveLocationForAccountOffboardingTeardownTransaction(
  sql: postgres.Sql,
  input: ArchiveLocationForOffboardingTeardownTxInput,
): Promise<ArchiveLocationForOffboardingTeardownTxResult> {
  const { locationId, accountId, accountOffboardingId } = input;

  const result = await sql.begin(async (tx) => {
    const context = await lockArchiveContext(tx, locationId, accountId);
    if (context.archivedAt !== null) {
      return { locationId, archived: true, alreadyArchived: true };
    }

    await applyArchiveLocationUpdate(tx, {
      locationId,
      accountId,
      actorUserId: null,
      activeLocationsBefore: context.activeLocationsBefore,
      auditPayload: {
        location_id: locationId,
        active_locations_before: context.activeLocationsBefore,
        active_locations_after: Math.max(context.activeLocationsBefore - 1, 0),
        account_offboarding_id: accountOffboardingId,
        archive_reason: 'account_offboarding_teardown',
      },
    });

    return { locationId, archived: true, alreadyArchived: false };
  });

  return result;
}

interface ArchiveContext {
  archivedAt: Date | string | null;
  activeLocationsBefore: number;
  isPrimary: boolean;
}

async function lockArchiveContext(
  tx: postgres.TransactionSql,
  locationId: string,
  accountId: string,
): Promise<ArchiveContext> {
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

  // FP: lock-ordering inside the tx — account FOR UPDATE lock, then active-count read, then this per-location FOR UPDATE row lock; reordering/parallelizing would break the lock acquisition order.
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
  const [location] = await tx<{ archived_at: Date | string | null; is_primary: boolean }[]>`
    SELECT archived_at, is_primary
    FROM businesses
    WHERE id = ${locationId}::uuid
      AND account_id = ${accountId}::uuid
    FOR UPDATE
  `;
  if (!location) {
    throw new Error('location_archive_conflict');
  }

  return {
    archivedAt: location.archived_at,
    activeLocationsBefore: Number(activeRow?.count ?? 0),
    isPrimary: Boolean(location.is_primary),
  };
}

// One UPDATE serves both the owner and teardown paths. The owner path's
// "never archive a primary" rule is enforced by the promote_first guard on
// the LOCKED snapshot in archiveLocationTransaction — the row is held
// FOR UPDATE from snapshot to this UPDATE, and every is_primary writer
// mutates rows via UPDATE (blocking on that lock), so the snapshot cannot
// go stale. The teardown path archives primaries intentionally. The SET
// always flips is_primary off so an archived row never lingers as primary.
async function applyArchiveLocationUpdate(
  tx: postgres.TransactionSql,
  input: {
    locationId: string;
    accountId: string;
    actorUserId?: string | null;
    activeLocationsBefore: number;
    auditPayload?: Record<string, unknown>;
  },
): Promise<void> {
  const [updatedLocation] = await tx<{ id: string }[]>`
    UPDATE businesses
    SET archived_at = NOW(),
        is_primary = FALSE,
        updated_at = NOW()
    WHERE id = ${input.locationId}::uuid
      AND account_id = ${input.accountId}::uuid
      AND archived_at IS NULL
    RETURNING id
  `;
  if (!updatedLocation) {
    throw new Error('location_archive_conflict');
  }

  await tx`
    INSERT INTO account_audit_log (
      id, account_id, location_id, event_type, actor_user_id, payload
    ) VALUES (
      ${uuidv7()}::uuid,
      ${input.accountId}::uuid,
      ${input.locationId}::uuid,
      'location_archived',
      ${input.actorUserId ?? null}::uuid,
      ${tx.json((input.auditPayload ?? {
        location_id: input.locationId,
        active_locations_before: input.activeLocationsBefore,
        active_locations_after: input.activeLocationsBefore - 1,
      }) as never)}
    )
  `;

  await enqueueStripeOverageRecompute(tx, input.accountId);
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
  /**
   * True when the account had no active primary and this location was
   * auto-promoted to primary in the same tx (zero-primary self-heal).
   */
  selfPromoted: boolean;
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
 * Primary self-heal: normally the reactivated location stays non-primary
 * (is_primary FALSE) — to make it primary the user uses
 * promotePrimaryTransaction. The exception is a zero-primary account
 * (reachable via the offboarding-cancel → reactivate flow, which can leave an
 * account with no active primary): when no active primary exists, this tx
 * silently auto-promotes the reactivated location to primary in the SAME
 * transaction. The self-heal is silent — no notification, only a
 * 'primary_promoted' audit row and the `selfPromoted` response flag. An
 * accounts FOR UPDATE lock is taken FIRST (same accounts→businesses ordering
 * as archive/promote) so concurrent reactivations can't both self-promote.
 *
 * The outbox job enqueues a Stripe overage update so the worker
 * recalculates the overage quantity (increment).
 */
export async function reactivateLocationTransaction(
  sql: postgres.Sql,
  input: ReactivateLocationTxInput,
): Promise<ReactivateLocationTxResult> {
  const { locationId, accountId, actorUserId } = input;

  // Un-archiving onto an active-duplicate (account_id, google_place_id) trips
  // businesses_account_place_uniq (migration 062, Postgres 23505). Map it to the
  // typed 'duplicate_location' error so the route returns 409 instead of a 500.
  let selfPromoted: boolean;
  try {
    selfPromoted = await sql.begin(async (tx) => {
      // 0. Lock the account FIRST — establishes the same accounts→businesses lock
      // ordering as archive/promote and serializes concurrent reactivations so two
      // can't both self-promote into a zero-primary account.
      await tx`SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR UPDATE`;

      // 1. Set archived_at = NULL (reactivate)
      const [updatedLocation] = await tx<{
        id: string;
        google_place_id: string | null;
        google_maps_url: string | null;
      }[]>`
        UPDATE businesses
        SET archived_at = NULL,
            updated_at = NOW()
        WHERE id = ${locationId}::uuid
          AND account_id = ${accountId}::uuid
          AND archived_at IS NOT NULL
        RETURNING id, google_place_id, google_maps_url
      `;
      if (!updatedLocation) {
        throw new Error('location_reactivate_conflict');
      }

      // 1a. URL-mode locations archived before resolution completed come back
      // with google_place_id IS NULL — re-enqueue validate_place_id from the
      // stored Maps URL so the location doesn't stay permanently unverified
      // and outside migration 062's duplicate enforcement (NULL never collides
      // under the partial unique index). The shared helper dedups against an
      // already-in-flight validate_place_id row for this business.
      if (!updatedLocation.google_place_id && updatedLocation.google_maps_url) {
        await enqueueValidatePlaceId(tx, {
          businessId: locationId,
          googleMapsUrl: updatedLocation.google_maps_url,
        });
      }

      // 1b. Zero-primary self-heal (see helper below).
      const promoted = await selfHealPrimaryIfMissing(tx, { accountId, locationId, actorUserId });

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
          ${tx.json({
            location_id: locationId,
          })}
        )
      `;

      // 3. Enqueue Stripe overage update (increment)
      await enqueueStripeOverageRecompute(tx, accountId);

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
            ${QUEUE_NAMES.ZERNIO_INITIAL_BACKFILL},
            'business',
            ${locationId}::uuid,
            ${tx.json({
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

      return promoted;
    });
  } catch (err) {
    rethrowAsDuplicateLocation(err);
  }

  return {
    locationId,
    reactivated: true,
    selfPromoted,
  };
}

/**
 * Zero-primary self-heal for reactivation. The just-reactivated location is
 * active but non-primary; if the account has NO active primary (reachable via
 * the offboarding-cancel → reactivate flow), silently promote it so the
 * at-least-one-primary half of the invariant is restored (canonical invariant
 * docblock: promote-primary-tx.ts). Silent: audit row + response flag only.
 *
 * Caller MUST hold the accounts FOR UPDATE lock in the same tx — that is what
 * serializes concurrent reactivations so two can't both self-promote.
 * The promote UPDATE is RETURNING-verified: the audit row must never claim a
 * promotion the database didn't apply.
 */
async function selfHealPrimaryIfMissing(
  tx: postgres.TransactionSql,
  input: { accountId: string; locationId: string; actorUserId?: string | null },
): Promise<boolean> {
  const { accountId, locationId, actorUserId } = input;

  const [primaryRow] = await tx<{ count: number }[]>`
    SELECT COUNT(*)::int AS count FROM businesses
    WHERE account_id = ${accountId}::uuid AND is_primary = TRUE AND archived_at IS NULL
  `;
  if (Number(primaryRow?.count ?? 0) !== 0) {
    return false;
  }

  const [promotedRow] = await tx<{ id: string }[]>`
    UPDATE businesses SET is_primary = TRUE, updated_at = NOW()
    WHERE id = ${locationId}::uuid AND account_id = ${accountId}::uuid
    RETURNING id
  `;
  if (!promotedRow) {
    throw new Error('location_reactivate_conflict');
  }

  await tx`
    INSERT INTO account_audit_log (id, account_id, location_id, event_type, actor_user_id, payload)
    VALUES (${uuidv7()}::uuid, ${accountId}::uuid, ${locationId}::uuid, 'primary_promoted', ${actorUserId ?? null}::uuid,
            ${tx.json({ old_primary_id: null, new_primary_id: locationId, reason: 'reactivation_self_heal' })})
  `;
  return true;
}
