import { v7 as uuidv7 } from 'uuid';
import type postgres from 'postgres';
import {
  activeOffboardingStateFromProjection,
  isConnectBlocked,
  type ActiveOffboardingProjection,
} from '@/lib/account-offboarding/gate';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import { ZernioRouteError } from '@/lib/zernio/errors';
import { assertWritableSubscriptionStatus } from '@/lib/shared/writable-subscription';
import type { AppUser } from '@/lib/db/auth';
import type { ConnectLocationsBlob } from '@/lib/zernio/types';
import type { AccountFlagsInput } from '@/lib/shared/past-due-recovery';
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue';
import { makeAnalyticsEventKey } from '@/lib/analytics/events';
import { isSubscriptionTier } from '@/lib/accounts/tier-config';
import {
  createImportOffer,
  enqueueInitialImport,
  readImportConsent,
} from '@/lib/reviews/import-consent';

interface FinalizeConnectionTxArgs {
  user: AppUser;
  stored: ConnectLocationsBlob;
  locationId: string;
  accountId: string;
}

/**
 * Step 8d: the single durable finalize transaction. INSERT/UPDATE the
 * `zernio_connections` row + drain outbox + (at the junction, and only when the
 * owner has ACCEPTED the Import offer) the initial-import outbox enqueue — ALL
 * inside one `sql.begin` per spec §6.8 (transactional outbox). Throws
 * `ZernioRouteError(403, ...)` for scope/subscription failures; any DB error
 * propagates to the caller's orphan-recovery branch.
 *
 * The `needs_backfill` predicate this doc used to name is DELETED (#677). It
 * asked "has a backfill ever completed?" as a proxy for "should we import?", and
 * the proxy is now wrong: the question is whether the owner said yes.
 */
export async function finalizeConnectionTx(
  sql: postgres.Sql,
  {
    user,
    stored,
    locationId,
    accountId,
  }: FinalizeConnectionTxArgs,
): Promise<void> {
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
      LEFT JOIN account_offboardings ao
        ON ao.account_id = a.id
       AND ao.account_id = ${ownerAccountId}
       AND ao.terminal_at IS NULL
      WHERE b.id = ${stored.businessId}
        AND b.account_id = ${ownerAccountId}
        AND b.archived_at IS NULL
      ORDER BY ao.created_at DESC NULLS LAST
      LIMIT 1
      FOR UPDATE OF b, a
    `;

    if (!accountLocation) {
      throw new ZernioRouteError(403, 'business_mismatch');
    }
    if (!isSubscriptionTier(accountLocation.subscription_tier)) {
      throw new Error(
        `invalid_ws8_subscription_tier:${accountLocation.subscription_tier}`,
      );
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

    // `connectionId` (the resolved id of the row we are about to write) was only
    // ever read by the deleted `needs_backfill` predicate, which excluded it via
    // `id != ${connectionId}` — the source of that predicate's documented #41
    // over-fire. With the predicate gone the binding has no remaining reader.
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
        ${QUEUE_NAMES.DRAIN_OWNER_CONNECT},
        'business',
        ${stored.businessId},
        ${tx.json({ business_id: stored.businessId, kind: 'drain' } as never)},
        0,
        5
      )
    `;

    await enqueueAnalyticsEvent(tx, {
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
    });

    // Review import is CONSENT-GATED from #677 on (spec §3, D8/D9). This is
    // producer 1 of 4, and it is the junction site in the common ordering:
    // subscription already active, Google just connected.
    //
    // The old `needs_backfill` SELECT is DELETED along with its documented #41
    // over-fire. That predicate asked "has a backfill ever completed?" as a proxy
    // for "should we import?", and the proxy is now wrong: the question is
    // whether the OWNER said yes. The over-fire comment described a re-enqueue
    // made benign by the worker's ON CONFLICT guard; the new predicate has no
    // over-fire to describe, because an un-accepted offer enqueues nothing at all.
    //
    // The businesses row is already locked FOR UPDATE at the top of this
    // transaction (`FOR UPDATE OF b, a`), so the row-lock discipline every
    // producer shares is satisfied with no new code.
    if (accountLocation.subscription_activated_at) {
      // Create the offer if this is the first time both halves are true. Never
      // extends an existing deadline, and never touches an answered row.
      await createImportOffer(tx, stored.businessId, ownerAccountId);

      const consent = await readImportConsent(tx, stored.businessId, ownerAccountId);

      if (consent?.state === 'accepted') {
        // Delegated to `import-consent.ts` (round-1 O3, deviations D11). This
        // block used to carry its own copy of the payload, the completed-run
        // guard and the deduped INSERT; the copy had diverged from the other two
        // producers AND from `readImportOfferView` on `run_reason`, which is the
        // A4 bug. `enqueueInitialImport` re-resolves the connection row and the
        // account snapshot from THIS transaction — the row this finalize just
        // wrote — so the payload is identical to the one built here before,
        // sourced from the database rather than from a caller's snapshot.
        //
        // Both dedup guards (no completed INITIAL run, no in-flight row) and the
        // byte-for-byte in-flight status tuple live there now. The businesses
        // row lock this function already holds (`FOR UPDATE OF b, a` above) is
        // that function's stated precondition.
        await enqueueInitialImport(tx, stored.businessId, ownerAccountId);
      } else {
        // The proof that declines are honoured at the product paths, and the
        // counterpart to #679's worker-side skip line. `pending` is the ordinary
        // case here: the owner has not seen the banner yet.
        console.log(
          `[zernio-connect] Review import not enqueued for ${stored.businessId} — import consent is ${consent?.state ?? 'unknown'}`,
        );
      }
    } else {
      // Connect flow is gated on writable subscription state upstream, so
      // this branch is unreachable for activated accounts.
      console.warn(
        `[zernio-connect] Connect succeeded but subscription_activated_at NULL for ${stored.businessId}`,
      );
    }
  });
}
