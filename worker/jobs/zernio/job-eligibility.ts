// worker/jobs/zernio/job-eligibility.ts
//
// Shared eligibility gate for the Zernio job workers (ZernioReviewIngestWorker
// and ZernioBackfillWorker). Both workers run the identical
// businesses⋈accounts lookup followed by the same two guards; this module is
// the single owner of that sequence and of the guard-ordering convention.

import type { Sql } from 'postgres';
import {
  checkSubscription,
  type AccountFlagsInput,
} from '../../../src/lib/shared/subscription-guard';
import { markOutboxCompleted } from '../../../src/lib/shared/outbox';
import { SKIP_REASON_ARCHIVED_LOCATION } from '../../../src/lib/shared/worker-types';
import type { WorkerLogger } from '../../../src/lib/shared/logger';

export interface ZernioJobAccountState {
  subscription_status: string;
  past_due_at: Date | null;
  account_flags: AccountFlagsInput;
  archived_at: Date | null;
}

export type ZernioJobEligibility =
  | { kind: 'proceed'; account: ZernioJobAccountState }
  | { kind: 'skipped' };

/**
 * Loads business + account state in one row (accounts via the businesses
 * join, not deprecated businesses.subscription_status) and runs the shared
 * pre-flight guards. Every skip is skip-as-success: the outbox row is
 * completed — never failed, thrown, or retried.
 *
 * Guard order (project convention — archived-before-subscription):
 *   1. Row missing → complete + skip (backfill logs subscription_status=missing,
 *      preserving its historical skip line; ingest skips silently).
 *   2. Archived location → structured { reason: SKIP_REASON_ARCHIVED_LOCATION }
 *      log + complete. Checked BEFORE the subscription guard so an
 *      archived+cancelled location exits via this queryable archived path,
 *      not the silent subscription skip. Archived locations keep
 *      status='active' Zernio connections for reactivation backfill, so jobs
 *      already queued when the location was archived must skip here without
 *      touching the Zernio API.
 *   3. Subscription guard (workerType: 'generator') → complete + skip.
 *      Ingest completes silently; backfill logs its skip line.
 *
 * This gate only completes the OUTBOX row. Backfill-specific durable state
 * (zernio_backfill_runs.completed_at) is deliberately untouched on skip —
 * un-archiving or restored billing re-enters the same run row idempotently.
 */
export async function guardZernioJobEligibility(sql: Sql, input: {
  businessId: string;
  outboxId: string;
  attempt: number | undefined;
  logger: WorkerLogger;
  jobKind: 'ingest' | 'backfill';
}): Promise<ZernioJobEligibility> {
  const { businessId, outboxId, attempt, logger, jobKind } = input;

  const [acct] = await sql<ZernioJobAccountState[]>`
    SELECT a.subscription_status, a.past_due_at, a.flags AS account_flags, b.archived_at
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    WHERE b.id = ${businessId}
  `;

  if (!acct) {
    if (jobKind === 'backfill') {
      logger.log(`Backfill skipped for business=${businessId}: subscription_status=missing`);
    }
    await markOutboxCompleted(outboxId, attempt);
    return { kind: 'skipped' };
  }

  if (acct.archived_at) {
    logger.log(`archived — skipping ${jobKind}`, {
      reason: SKIP_REASON_ARCHIVED_LOCATION,
      business_id: businessId,
    });
    await markOutboxCompleted(outboxId, attempt);
    return { kind: 'skipped' };
  }

  if (!checkSubscription({
    status: acct.subscription_status,
    pastDueAt: acct.past_due_at,
    accountFlags: acct.account_flags ?? {},
    workerType: 'generator',
  }).allowed) {
    if (jobKind === 'backfill') {
      logger.log(
        `Backfill skipped for business=${businessId}: subscription_status=${acct.subscription_status}`,
      );
    }
    await markOutboxCompleted(outboxId, attempt);
    return { kind: 'skipped' };
  }

  return { kind: 'proceed', account: acct };
}
