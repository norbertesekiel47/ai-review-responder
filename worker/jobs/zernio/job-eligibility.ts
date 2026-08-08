// worker/jobs/zernio/job-eligibility.ts
//
// Shared eligibility gate for the Zernio job workers (ZernioReviewIngestWorker
// and ZernioBackfillWorker). Both workers run the identical
// businesses⋈accounts lookup followed by the same two guards; this module is
// the single owner of that sequence and of the guard-ordering convention.
//
// It also owns `guardImportConsent` (#679, spec §5.3) — the fail-closed Import
// consent gate the BACKFILL worker runs first. That guard is deliberately a
// SEPARATE function rather than a `jobKind === 'backfill'` branch inside
// `guardZernioJobEligibility`: a merged guard would have two callers, one of
// which must never reach the consent code. Splitting makes live-ingest
// independence structural — the ingest worker never learns the interface —
// instead of a runtime branch a future edit can flip.

import type { Sql } from 'postgres';
import {
  checkSubscription,
  type AccountFlagsInput,
} from '../../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxCompletedWithReason } from '../../../src/lib/shared/outbox';
import { OUTBOX_COMPLETION_REASON } from '../../../src/lib/shared/outbox-completion-reason';
import {
  importConsentStateSql,
  type ImportConsentState,
} from '../../../src/lib/reviews/import-consent';
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
 *
 *      FOR THE BACKFILL WORKER THAT BRANCH IS NOW UNREACHABLE (#679).
 *      `ZernioBackfillWorker` runs `guardImportConsent` BEFORE this gate, and a
 *      missing `businesses` row yields no consent state at all — so the consent
 *      guard intercepts it first and emits `{ reason: 'missing' }` instead. That
 *      is deliberate: fail-closed "no consent on record" is the more accurate
 *      reason for a backfill than "subscription_status=missing", and the line
 *      above is retained only for the INGEST worker, whose lane never consults
 *      consent. Do not restore a backfill assertion on it.
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
    await markOutboxCompleted(sql, outboxId, attempt);
    return { kind: 'skipped' };
  }

  if (acct.archived_at) {
    logger.log(`archived — skipping ${jobKind}`, {
      reason: SKIP_REASON_ARCHIVED_LOCATION,
      business_id: businessId,
    });
    await markOutboxCompleted(sql, outboxId, attempt);
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
    await markOutboxCompleted(sql, outboxId, attempt);
    return { kind: 'skipped' };
  }

  return { kind: 'proceed', account: acct };
}

/**
 * Outcome of the Import consent gate.
 *
 * Deliberately NOT `ZernioJobEligibility`: that type's `'proceed'` arm carries
 * an `account` payload this guard has no business loading. Consent is one fact
 * about one `businesses` row, and the caller re-reads account state through
 * `guardZernioJobEligibility` immediately afterwards.
 */
export type ImportConsentGate = { kind: 'proceed' } | { kind: 'skipped' };

/** What the guard refused on: the derived state, or no `businesses` row at all. */
type ImportConsentBlockReason = ImportConsentState | 'missing';

/**
 * Fail-closed Import consent gate for the Review import (#679, spec §5.3).
 *
 * Proceeds ONLY when the derived Import consent state is `'accepted'`. Under
 * spec D9 an enqueue exists only after a Yes, so anything else reaching the
 * backfill worker is a hand-inserted `zernio_initial_backfill` row or a bug —
 * and a `pending` row that ran would import a customer's review history without
 * consent. Every other state, and a missing row, is skip-as-success: the outbox
 * row is COMPLETED, never failed, thrown or retried (this module's convention),
 * because a declined or expired import must not churn the queue forever.
 *
 * Expiry is DERIVED IN POSTGRES via the shared `importConsentStateSql`
 * fragment — imported, never re-spelled (spec §5.3's single-owner rule), which
 * is why this query MUST alias `businesses` as `b`: the fragment hardcodes that
 * alias and takes no interpolation. Reading `import_offer_expires_at` into JS
 * and branching there would be the second spelling §5.3 forbids, and would drag
 * a JS `Date` across a boundary postgres.js truncates to milliseconds.
 *
 * THE WHOLE BODY RUNS INSIDE `sql.begin`, AND THAT IS A CORRECTNESS
 * REQUIREMENT, NOT TIDINESS. Without serialization: the guard reads `pending`
 * from an in-flight row; the owner accepts, and
 * `recordImportDecisionAndEnqueue`'s
 * `NOT EXISTS (… status IN ('pending','dispatching','dispatched'))` sees that
 * row still in flight and inserts NO replacement; the guard then completes the
 * row as a consent skip. Final state: `import_decision = 'accepted'`, no
 * completed initial run, and no runnable outbox row — silent permanent data
 * loss for a customer who said yes, violating spec §5.1's accepted-but-
 * incomplete retryability. The fix is the `businesses` row lock plus issuing
 * `markOutboxCompletedWithReason` on the SAME `tx`, so either interleaving resolves:
 * guard-first completes the row and acceptance inserts a fresh runnable one;
 * acceptance-first means the guard reads `accepted` and proceeds.
 * `SELECT … FOR UPDATE` is a NO-OP outside `sql.begin()` under Supabase's
 * transaction pooling (CLAUDE.md gotcha), so both halves are load-bearing.
 *
 * Lock order is business-before-outbox, matching `recordImportDecisionAndEnqueue`,
 * `worker/ingress/stripe/shared.ts` and `archive-location-tx.ts` — do not reorder.
 *
 * Tenant scope: `b.id` alone, no `account_id`. The backfill payload carries no
 * account id, and `businesses.id` IS the tenant key — `guardZernioJobEligibility`
 * above binds exactly the same way.
 *
 * THE REFUSAL IS DURABLE, NOT JUST LOGGED (#695). The completed row carries
 * `completion_reason = 'import_consent_blocked'`, so a policy refusal is
 * separable by SQL from a genuine completed import — previously the only trace
 * was the log line above plus the ABSENCE of a `zernio_backfill_runs` row.
 *
 * ONE marker covers all four refusal states, and it proves only THAT a refusal
 * happened, not which state caused it. The state at refusal time lives in the log
 * line above and NOWHERE else: reading `businesses` afterwards can disagree (a
 * `pending` refusal whose owner later accepts) or find nothing at all (the
 * `missing` case). That is the deliberate trade — a per-state marker would put a
 * point-in-time fact in a column readers would inevitably compare against current
 * state. Nothing reads the marker in code — no poller, no alert — because a
 * refusal is this guard working correctly (ADR 0016).
 */
export async function guardImportConsent(sql: Sql, input: {
  businessId: string;
  outboxId: string;
  attempt: number | undefined;
  logger: WorkerLogger;
}): Promise<ImportConsentGate> {
  const { businessId, outboxId, attempt, logger } = input;

  return sql.begin(async (tx): Promise<ImportConsentGate> => {
    const [row] = await tx<{ state: ImportConsentState }[]>`
      SELECT ${importConsentStateSql(tx)} AS state
      FROM businesses b
      WHERE b.id = ${businessId}::uuid
      FOR UPDATE
    `;

    if (row?.state === 'accepted') return { kind: 'proceed' };

    const reason: ImportConsentBlockReason = row?.state ?? 'missing';
    logger.log('import consent blocked — skipping backfill', {
      reason,
      business_id: businessId,
    });
    await markOutboxCompletedWithReason(
      tx, outboxId, OUTBOX_COMPLETION_REASON.IMPORT_CONSENT_BLOCKED, attempt,
    );
    return { kind: 'skipped' };
  });
}
