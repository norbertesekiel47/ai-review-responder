// The Auto-approval lane (#631, map #617 decision 7) — the Autopilot-tier
// condition gate that decides whether a built Solicitation batch may approve
// itself as `approval_method='auto_policy'` instead of waiting on an Owner
// approval.
//
// D19 widened `auto_approval_policies` (migration 091) so the Solicitation
// persona shares the Reply lane's table rather than teaching the Governor a
// second surface: `suspended_at` is read for ANY policy row belonging to the
// account, never scoped to `persona='solicitation'` alone, because design §8
// defines the Governor's kill switch as per-ACCOUNT autonomy suspension — a
// Reply-lane trip must protect Solicitation too, with zero Governor code
// changes. D20 is the trust dial this gate enforces: four independent things
// must be true before a batch can auto-approve (both server flags, the
// Autopilot tier, and a live, unsuspended `persona='solicitation'
// AND action_class='sending' AND location_id IS NULL` policy row), and the
// dial only ever moves toward MORE restraint — there is no owner-adjustable
// path to less.
//
// ONE CONDITIONS READER. `readAutoApprovalConditions` is deliberately the
// only place that reads the four DB-backed conditions, because two readers
// with the same intent are exactly how a gate drifts from its own re-check:
// the ask-generation finale (`evaluateAutoApproval`, wired in #631 Task 4)
// and the release-time re-check (`runBatchArm` in `release.ts`, #631 Task 7)
// both call it, so a schema or precedence change made here is made once for
// both call sites, never twice.
//
// Invariant #15: this module takes its DB client as an explicit parameter
// (`sql: Sql | TransactionSql`) and never imports `@/lib/db/server`.

import * as Sentry from '@sentry/node';
import type { Sql, TransactionSql } from 'postgres';
import { tierGrantsAutopilot } from '@/lib/accounts/tier-config';
import { subscriptionGrantsFullAccess } from '@/lib/shared/subscription-status';
import { recordStep } from '@/lib/agents/run-spine';
import { enqueueSolicitationVetoNotice } from '@/lib/shared/job-outbox-helpers';
import { createWorkerLogger, toError } from '@/lib/shared/logger';
import { lockAutonomyAccount } from '@/lib/auto-approval/account-lock';
import { solicitationAutoApprovalEnabled, solicitationSendEnabled } from './flags';

const logger = createWorkerLogger('[VetoAnchor]');

export type AutoApprovalDeclineReason =
  | 'send_flag_off'
  | 'auto_flag_off'
  | 'subscription'
  | 'tier'
  | 'policy_suspended'
  | 'no_policy_row';

export type AutoApprovalDecision =
  | { eligible: true; vetoWindowMinutes: number }
  | { eligible: false; reason: AutoApprovalDeclineReason };

/**
 * The four-condition gate's inputs, read once and passed through
 * {@link decideAutoApproval} as a plain record so the decision itself stays a
 * pure function — the property test in `auto-approval.test.ts` exercises this
 * shape directly, with no DB or flag reads in the loop.
 *
 * `policy` carries only what the decision needs from the account-default
 * `persona='solicitation' AND action_class='sending' AND location_id IS NULL`
 * row: its presence (`null` = no such row = the owner never opted in, D20)
 * and its `veto_window_minutes` (30 or 60 — migration 091's CHECK).
 */
export interface AutoApprovalConditionSnapshot {
  sendFlag: boolean;
  autoFlag: boolean;
  subscriptionStatus: string;
  subscriptionTier: string;
  /** Account-wide Governor suspension (D19) — true for ANY suspended policy
   *  row on this account, regardless of persona. */
  anySuspended: boolean;
  policy: { vetoWindowMinutes: number } | null;
}

/**
 * The two process-local flag checks, factored out of {@link decideAutoApproval}
 * so `runFinaleAutoApproval` can apply them on their own, BEFORE taking the
 * account lock or reading any DB-backed condition (perf follow-up to #631
 * Task 4): unlike the account lock, which serializes this read against
 * concurrent `auto_approval_policies`/Governor-suspension writers, these two
 * flags are plain `process.env` reads — free, and in no need of that
 * serialization. Single source of truth for the reason strings/order so the
 * fast pre-check and the full decision can never drift from each other.
 */
function decideFlags(
  sendFlag: boolean,
  autoFlag: boolean,
): Extract<AutoApprovalDeclineReason, 'send_flag_off' | 'auto_flag_off'> | null {
  if (!sendFlag) return 'send_flag_off';
  if (!autoFlag) return 'auto_flag_off';
  return null;
}

/**
 * Pure decision core, exported for the property test. Decision order IS the
 * reason precedence (D20's four independent things, in the order a caller
 * would want to fix them): `send_flag_off`, `auto_flag_off`, `subscription`,
 * `tier`, `policy_suspended`, `no_policy_row`. `policy_suspended` is checked
 * BEFORE `no_policy_row` on purpose — an account-wide Governor trip is a
 * safety fact, and it outranks "the owner never opted in" even when both are
 * true at once.
 */
export function decideAutoApproval(
  c: AutoApprovalConditionSnapshot,
): AutoApprovalDecision {
  const flagReason = decideFlags(c.sendFlag, c.autoFlag);
  if (flagReason) return { eligible: false, reason: flagReason };
  if (!subscriptionGrantsFullAccess(c.subscriptionStatus)) {
    return { eligible: false, reason: 'subscription' };
  }
  if (!tierGrantsAutopilot(c.subscriptionTier)) {
    return { eligible: false, reason: 'tier' };
  }
  if (c.anySuspended) return { eligible: false, reason: 'policy_suspended' };
  if (c.policy === null) return { eligible: false, reason: 'no_policy_row' };
  return { eligible: true, vetoWindowMinutes: c.policy.vetoWindowMinutes };
}

/** The DB-backed half of {@link AutoApprovalConditionSnapshot} — everything
 *  {@link readAutoApprovalConditions} reads, excluding the two server flags
 *  (those are process.env reads, not DB reads, and callers merge them in). */
export type AutoApprovalDbConditions = Omit<
  AutoApprovalConditionSnapshot,
  'sendFlag' | 'autoFlag'
>;

/**
 * Reads the three tenant-scoped, account_id-filtered facts the gate needs,
 * each as its own top-level statement (tenant-scope-auditor visibility, same
 * discipline as `worker/jobs/response-generation/auto-approval.ts`):
 *
 * 1. the account's `subscription_status` / `subscription_tier`;
 * 2. whether ANY `auto_approval_policies` row for this account is suspended
 *    (D19 — account-wide, not persona-scoped);
 * 3. the `persona='solicitation' AND action_class='sending'
 *    AND location_id IS NULL` account-default row's `veto_window_minutes`, if
 *    one exists. A Reply-persona row or a location-override row (`location_id
 *    IS NOT NULL`) never satisfies this — only the Solicitation
 *    account-default row can turn the lane on.
 *
 * Shared verbatim by the ask-generation finale gate and Task 7's release-time
 * re-check — see the module header for why there is exactly one reader.
 */
export async function readAutoApprovalConditions(
  sql: Sql | TransactionSql,
  accountId: string,
): Promise<AutoApprovalDbConditions> {
  const [account] = await sql<
    { subscription_status: string; subscription_tier: string }[]
  >`
    SELECT subscription_status, subscription_tier
    FROM accounts
    WHERE id = ${accountId}::uuid
  `;
  if (!account) {
    throw new Error(`auto_approval_conditions_account_missing:${accountId}`);
  }

  const [suspension] = await sql<{ any_suspended: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM auto_approval_policies
      WHERE account_id = ${accountId}::uuid
        AND suspended_at IS NOT NULL
    ) AS any_suspended
  `;

  const [policyRow] = await sql<{ veto_window_minutes: number }[]>`
    SELECT veto_window_minutes
    FROM auto_approval_policies
    WHERE account_id = ${accountId}::uuid
      AND persona = 'solicitation'
      AND action_class = 'sending'
      AND location_id IS NULL
  `;

  return {
    subscriptionStatus: account.subscription_status,
    subscriptionTier: account.subscription_tier,
    anySuspended: suspension?.any_suspended ?? false,
    policy: policyRow ? { vetoWindowMinutes: policyRow.veto_window_minutes } : null,
  };
}

/**
 * The DB-backed evaluator: reads both server flags and the three DB
 * conditions, then decides through the pure core.
 *
 * CALLER CONTRACT (#631 Task 4 wires this): by the time this is called, the
 * enclosing finale transaction already holds the **Send batch parent**'s
 * batch row lock AND the account-wide autonomy lock —
 * `lockAutonomyAccount(tx, accountId)` in `src/lib/auto-approval/
 * account-lock.ts`, taken in the documented batch-then-account order. That is
 * the same serialization Settings writers (`src/lib/auto-approval/
 * settings.ts`) and the Governor's suspension writer take, so no opt-in,
 * opt-out or suspension can commit between this read and the caller's
 * approval CAS — closing the race plan round-1 finding 2 identified. This
 * function itself takes no lock; it trusts the caller.
 */
export async function evaluateAutoApproval(
  tx: TransactionSql,
  input: { accountId: string },
): Promise<AutoApprovalDecision> {
  const conditions = await readAutoApprovalConditions(tx, input.accountId);
  return decideAutoApproval({
    sendFlag: solicitationSendEnabled(),
    autoFlag: solicitationAutoApprovalEnabled(),
    ...conditions,
  });
}

// ── The release-time re-check (#631 Task 7, decision 6) ─────────────────────

/**
 * The four reasons the release lane may DOWNGRADE an `auto_policy` batch back
 * to owner review. Deliberately NARROWER than {@link AutoApprovalDeclineReason}
 * — B14/B15 exclude the other two conditions from the re-check by design:
 * a subscription lapse is the existing recoverable `subscription` withhold in
 * `runAccountArm` (the batch resumes on recovery, so un-approving it would
 * destroy evidence a payment would have revived), and the master send flag
 * already stops the whole release phase (`flag_off`) before any batch arm
 * runs, so consulting it here could never fire.
 */
export type AutoDowngradeReason =
  | 'auto_approval_disabled'
  | 'autopilot_entitlement_lost'
  | 'policy_removed'
  | 'policy_suspended';

/**
 * Re-check the FOUR release-time conditions for an `auto_policy` batch's
 * account: the auto flag, the Autopilot tier, account-wide Governor
 * suspension, and the policy row's presence. Returns the first failing
 * condition's downgrade reason — the same precedence order
 * {@link decideAutoApproval} uses, minus the two conditions B14/B15 exclude —
 * or `null` when all four hold.
 *
 * ONE reader: the DB-backed half routes through
 * {@link readAutoApprovalConditions}, so this re-check cannot drift from the
 * approval-time gate (see the module header). The flag short-circuits before
 * the DB read — `auto_approval_disabled` is a process.env fact.
 *
 * Two call sites, both in `release.ts` (#631 decision 6): the arm-level quick
 * read in `runBatchArm` (no locks — cheap, advisory), and the serialized
 * re-reads inside the downgrade transaction and inside `releaseOutreachRow`'s
 * release transaction, where the caller holds the batch row lock and
 * `lockAutonomyAccount` (batch-then-account) so no opt-out, suspension or
 * tier change can commit between the read and the write it guards.
 */
export async function findAutoDowngradeReason(
  sql: Sql | TransactionSql,
  accountId: string,
): Promise<AutoDowngradeReason | null> {
  if (!solicitationAutoApprovalEnabled()) return 'auto_approval_disabled';
  const conditions = await readAutoApprovalConditions(sql, accountId);
  if (!tierGrantsAutopilot(conditions.subscriptionTier)) {
    return 'autopilot_entitlement_lost';
  }
  if (conditions.anySuspended) return 'policy_suspended';
  if (conditions.policy === null) return 'policy_removed';
  return null;
}

// ── The auto-approve verb (#631 Task 4) ─────────────────────────────────────

const PG_UNIQUE_VIOLATION = '23505';

/** The one 23505 the verb is allowed to absorb: migration 091's partial
 *  unique index that keeps ONE active approved send batch per business. */
const ONE_ACTIVE_SEND_CONSTRAINT = 'solicitation_batches_one_active_send_per_business';

/**
 * Postgres unique-violation detector scoped to ONE named constraint — the
 * house shape (`src/lib/channels/unique-violation.ts` narrows the same
 * `code` + `constraint_name` pair to a name set; this one narrows to a single
 * name). Anything else — another constraint, another SQLSTATE, a non-Postgres
 * error — returns false and the caller rethrows (decision 13).
 */
function isUniqueViolationOn(error: unknown, constraintName: string): boolean {
  if (error === null || typeof error !== 'object') return false;
  const pg = error as { code?: unknown; constraint_name?: unknown };
  return pg.code === PG_UNIQUE_VIOLATION && pg.constraint_name === constraintName;
}

export interface AutoApproveBatchInput {
  /** ALREADY canonical — the finale's `ctx.batchId` round-tripped through
   *  Postgres (`loadBatchContext`), the approval.ts X18 discipline. */
  batchId: string;
  accountId: string;
  businessId: string;
  /** The Send batch parent run the `batch_approved` step lands on. */
  sendParentRunId: string;
  /** Granted window read from the policy row by the caller's evaluate — the
   *  step records it so the Veto anchor can read it back (decision 5). */
  vetoWindowMinutes: number;
  correlationId?: string;
}

export type AutoApproveOutcome =
  | { status: 'approved'; approvedCount: number; vetoWindowMinutes: number }
  | { status: 'owner_won' }
  | { status: 'slot_held' };

/**
 * Stamps `approval_method='auto_policy'` on a built, unapproved, unhalted,
 * unclosed batch, records the `batch_approved` spine step, and enqueues the
 * Veto notice — all in the CALLER's transaction (invariant #2).
 *
 * CALLER CONTRACT: the enclosing finale transaction already holds the
 * per-business advisory lock, the batch row lock, and the account-wide
 * autonomy lock (`lockAutonomyAccount`, batch-then-account order) — see
 * {@link evaluateAutoApproval}. NEVER sets `approved_by_user_id` (091's
 * approval-consistency CHECK requires it NULL for `auto_policy`) and NEVER
 * sets `veto_deadline_at` — the deadline is anchored later from the first
 * provider-accepted notice send (decision 4), fail-closed.
 *
 * The CAS runs through a savepoint so a 23505 from the one-active-send index
 * cannot poison the finale transaction (decision 13): the error ESCAPES the
 * savepoint callback and is classified OUTSIDE it. Only
 * {@link ONE_ACTIVE_SEND_CONSTRAINT} maps to `slot_held` (the business's one
 * active-send slot is already held — fall back to owner review); any other
 * constraint rethrows. A CAS miss with `approved_at` already set is the
 * owner-won race (plan decision 2) — a quiet outcome, never a throw.
 */
export async function autoApproveBatch(
  tx: TransactionSql,
  input: AutoApproveBatchInput,
): Promise<AutoApproveOutcome> {
  const { batchId, accountId, businessId, vetoWindowMinutes } = input;

  let casRow: { id: string } | undefined;
  try {
    await tx.savepoint(async (sp) => {
      const rows = await sp<{ id: string }[]>`
        UPDATE solicitation_batches
        SET approved_at = NOW(), approval_method = 'auto_policy'
        WHERE id = ${batchId}::uuid AND account_id = ${accountId}::uuid
          AND business_id = ${businessId}::uuid
          AND approved_at IS NULL AND halted_at IS NULL
          AND send_closed_at IS NULL AND built_at IS NOT NULL
        RETURNING id
      `;
      casRow = rows[0];
    });
  } catch (error) {
    if (isUniqueViolationOn(error, ONE_ACTIVE_SEND_CONSTRAINT)) {
      return { status: 'slot_held' };
    }
    throw error;
  }
  if (casRow === undefined) {
    // The row lock is held, so the ONLY way the CAS misses is a pre-existing
    // approval (owner raced ahead between the last render and the finale) —
    // R1 finding 1. Anything else is corruption: assert it.
    const [b] = await tx<{ approved_at: string | null; halted_at: string | null }[]>`
      SELECT approved_at::text AS approved_at, halted_at::text AS halted_at
      FROM solicitation_batches WHERE id = ${batchId}::uuid
        AND account_id = ${accountId}::uuid AND business_id = ${businessId}::uuid
    `;
    if (b?.approved_at !== null) return { status: 'owner_won' };
    throw new Error(`autoApproveBatch: CAS missed for ${batchId} with no prior approval`);
  }

  // Rendered Outreach count — the approveBatch:411 shape: what the owner
  // WOULD have reviewed is what auto_policy just approved.
  const [live] = await tx<{ approved: number }[]>`
    SELECT COUNT(*)::int AS approved
    FROM solicitation_outreach
    WHERE batch_id = ${batchId}::uuid
      AND account_id = ${accountId}::uuid
      AND business_id = ${businessId}::uuid
      AND delivery_status = 'rendered'
  `;
  const approvedCount = live?.approved ?? 0;

  // NO approved_by_user_id key — 091's CHECK requires the column NULL for
  // auto_policy, and the step detail mirrors the row's truth.
  await recordStep(tx, {
    runId: input.sendParentRunId,
    stepKey: 'batch_approved',
    detail: {
      approval_method: 'auto_policy',
      approved_count: approvedCount,
      veto_window_minutes: vetoWindowMinutes,
    },
  });

  // SAME transaction as the approval (invariant #2). The notice never gates
  // the approval; its failure fails CLOSED at release instead (no anchor, no
  // release — D9).
  await enqueueSolicitationVetoNotice(tx, {
    batchId,
    businessId,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });

  return { status: 'approved', approvedCount, vetoWindowMinutes };
}

/** What the ask-generation finale learns from this lane: the verb's outcome,
 *  or a decline — which is a LOG LINE, never a spine step (plan decision 9). */
export type FinaleAutoApprovalOutcome =
  | AutoApproveOutcome
  | { status: 'declined'; reason: AutoApprovalDeclineReason };

/**
 * The finale hook body (#631 Task 4 Step 3; flag-first ordering added as a
 * perf follow-up), extracted so the finale itself stays orchestration.
 *
 * Cheapest-first: {@link decideFlags}'s two `process.env` reads are checked
 * BEFORE anything else, since — unlike the DB-backed conditions below — they
 * need no serialization against a concurrent writer. Only once both flags
 * pass does this take the account lock (decision 3 — AFTER the batch row
 * lock the finale already holds, the documented batch-then-account order)
 * and evaluate the remaining DB-backed conditions under that serialization —
 * the lock exists to serialize against `auto_approval_policies`/Governor
 * suspension writers, not against a flag flip, so it would otherwise be an
 * unconditional row lock plus three reads on every finale for no reason: the
 * auto-approval lane is off in every environment today
 * (`SOLICITATION_AUTO_APPROVAL_ENABLED` unset). Either declines or runs the
 * verb. Called ONLY from `generateAsksForBatch`'s finale transaction, only
 * when the batch stayed open with live rows — never from `regenerateAsk`
 * (locked decision 1: regen exists only in `built`, i.e. only for batches
 * this lane already declined).
 */
export async function runFinaleAutoApproval(
  tx: TransactionSql,
  input: {
    batchId: string;
    accountId: string;
    businessId: string;
    sendParentRunId: string;
    correlationId?: string;
  },
): Promise<FinaleAutoApprovalOutcome> {
  const flagReason = decideFlags(solicitationSendEnabled(), solicitationAutoApprovalEnabled());
  if (flagReason) return { status: 'declined', reason: flagReason };

  await lockAutonomyAccount(tx, input.accountId);
  const decision = await evaluateAutoApproval(tx, { accountId: input.accountId });
  if (!decision.eligible) return { status: 'declined', reason: decision.reason };
  return autoApproveBatch(tx, {
    batchId: input.batchId,
    accountId: input.accountId,
    businessId: input.businessId,
    sendParentRunId: input.sendParentRunId,
    vetoWindowMinutes: decision.vetoWindowMinutes,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });
}

// ── The Veto anchor (#631 Task 6, decision 4) ───────────────────────────────
//
// D9 is fail-closed: an `auto_policy` batch may release ONLY after a FULL
// veto window has elapsed since the FIRST provider-accepted Veto notice send
// — `MIN(sent_at)`, never `delivered_at` (Telegram has no delivery receipt,
// the Reply lane's shipped `veto-window-gate.ts:84` semantic). No sent
// notice, no anchor, no release, ever. This phase is what turns that fact
// into the `veto_deadline_at` column `release.ts`'s P4 scan reads.
//
// Wired by `release.ts`'s `runReleaseCycle` immediately before the release
// phase, through the SAME `tallyPhase`/`alertPhaseFailure` seam every other
// phase in that file uses — see its module header for the full phase order.

/** Structurally identical to `release.ts`'s private `PhaseTally` — duplicated
 *  rather than imported so this module (which `release.ts` imports FROM)
 *  never depends on its own caller. TypeScript's structural typing makes the
 *  object this returns assignable to `tallyPhase`'s parameter either way. */
export interface VetoAnchorTally {
  handled: number;
  failed: number;
}

interface VetoAnchorCandidate {
  id: string;
  account_id: string;
  business_id: string;
}

/** Stable Sentry title / log prefix — `Sentry.captureException` groups by
 *  message text, matching every other per-item failure sink in this lane. */
const ANCHOR_ITEM_FAILURE_MESSAGE = 'Veto anchor candidate failed and was isolated';

/**
 * P4.5's scan (plan Task 6, decision 4's exact predicate) — `auto_policy`
 * batches with no anchored deadline yet, whose Veto notice has landed at
 * least once. `halted_at IS NULL AND send_closed_at IS NULL` keep a Halt
 * latch or a release-time downgrade winner out of the candidate set; the CAS
 * in {@link anchorOneBatch} re-asserts both under the batch lock regardless,
 * but excluding them here keeps the scan itself honest about what it counts.
 */
async function selectAnchorCandidates(
  sql: Sql,
  scanLimit: number,
): Promise<VetoAnchorCandidate[]> {
  return sql<VetoAnchorCandidate[]>`
    SELECT b.id, b.account_id, b.business_id
    FROM solicitation_batches b
    WHERE b.approval_method = 'auto_policy'
      AND b.veto_deadline_at IS NULL
      AND b.halted_at IS NULL AND b.send_closed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM notification_deliveries nd
        WHERE nd.entity_id = b.id
          AND nd.template = 'solicitation_veto_notice'
          AND nd.sent_at IS NOT NULL
      )
    LIMIT ${scanLimit}
  `;
}

/**
 * ONE candidate's isolated body — a throw here costs this batch, not the
 * phase or the tick. `release.ts`'s `isolateItem` docstring states why every
 * per-item loop in this lane needs this; duplicated here rather than
 * imported for the reason {@link VetoAnchorTally} gives.
 */
async function isolateAnchorItem<T>(
  context: Record<string, string>,
  tally: { failed: number },
  body: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await body();
  } catch (error) {
    tally.failed += 1;
    const cause = toError(error);
    try {
      Sentry.captureException(cause, {
        level: 'warning',
        tags: { subsystem: 'solicitation-release', phase: 'veto_anchor' },
        extra: { ...context },
      });
    } catch {
      // The log line below is the fallback sink for Sentry itself being
      // unreachable, so it lives OUTSIDE this guard — same shape as every
      // other per-item catch in this lane.
    }
    logger.error(ANCHOR_ITEM_FAILURE_MESSAGE, cause, { phase: 'veto_anchor', ...context });
    return undefined;
  }
}

/**
 * Anchor ONE candidate: lock the batch, read the granted window back from the
 * send parent's LATEST `batch_approved` step, then CAS the deadline computed
 * IN SQL from `MIN(sent_at)` — never a JS `Date` round-trip (#520's µs-
 * truncation gotcha: postgres.js decodes `timestamptz` to a JS `Date`,
 * silently truncating microseconds). Returns whether this call anchored the
 * batch.
 *
 * LOCK ORDER IS BATCH → RUN, `release.ts`'s sole order for this lane — the
 * batch row locks first (below), and the send-parent lookup is folded into
 * that same locking statement (the `downgradeApproval` shape), so no second
 * lock is taken to find it.
 *
 * A missing send parent, or a `batch_approved` step with no
 * `veto_window_minutes`, is an IMPOSSIBLE state for a batch this scan ever
 * selects: `autoApproveBatch` writes both facts, together, in the SAME
 * transaction as the `auto_policy` stamp (Task 4). Assert it loudly — a
 * corrupt candidate is isolated to itself by the caller's
 * {@link isolateAnchorItem}, never silently skipped.
 */
async function anchorOneBatch(
  tx: TransactionSql,
  batch: VetoAnchorCandidate,
): Promise<boolean> {
  const [locked] = await tx<{ send_parent_run_id: string | null }[]>`
    SELECT (
             SELECT r.id
               FROM agent_runs r
              WHERE r.kind = 'solicitation_send_batch'
                AND r.subject_type = 'solicitation_batch'
                AND r.subject_id = b.id::text
                AND r.account_id = ${batch.account_id}::uuid
                AND r.business_id = ${batch.business_id}::uuid
              ORDER BY r.started_at DESC
              LIMIT 1
           ) AS send_parent_run_id
      FROM solicitation_batches b
     WHERE b.id = ${batch.id}::uuid
       AND b.account_id = ${batch.account_id}::uuid
       AND b.business_id = ${batch.business_id}::uuid
     FOR UPDATE OF b
  `;
  if (locked === undefined) {
    throw new Error(`anchorVetoDeadlines: batch ${batch.id} vanished before its lock`);
  }
  if (locked.send_parent_run_id === null) {
    throw new Error(
      `anchorVetoDeadlines: no Send batch parent found for auto_policy batch ${batch.id}`,
    );
  }
  const sendParentRunId = locked.send_parent_run_id;

  const [step] = await tx<{ granted_window_minutes: number | null }[]>`
    SELECT (detail->>'veto_window_minutes')::int AS granted_window_minutes
    FROM agent_run_steps
    WHERE agent_run_id = ${sendParentRunId}::uuid AND step_key = 'batch_approved'
    ORDER BY step_index DESC
    LIMIT 1
  `;
  if (step === undefined || step.granted_window_minutes === null) {
    throw new Error(
      `anchorVetoDeadlines: batch ${batch.id}'s send parent ${sendParentRunId} has no ` +
        'batch_approved step carrying veto_window_minutes',
    );
  }
  const grantedMinutes = step.granted_window_minutes;

  // The CAS: the deadline is computed IN SQL from MIN(sent_at) — the
  // DATABASE clock decides it, never a JS Date round-trip. Re-asserting
  // approval_method/halted_at/send_closed_at/veto_deadline_at here (not just
  // in the scan) is what makes zero rows the honest answer to "a Halt latch
  // or a release-time downgrade won the race between the scan and this
  // lock" — skip quietly, no step.
  const [cas] = await tx<{ veto_deadline_at: string; first_sent: string }[]>`
    UPDATE solicitation_batches b
    SET veto_deadline_at = sub.first_sent + make_interval(mins => ${grantedMinutes})
    FROM (
      SELECT MIN(nd.sent_at) AS first_sent
      FROM notification_deliveries nd
      WHERE nd.entity_id = ${batch.id}::uuid
        AND nd.account_id = ${batch.account_id}::uuid
        AND nd.business_id = ${batch.business_id}::uuid
        AND nd.template = 'solicitation_veto_notice'
        AND nd.sent_at IS NOT NULL
    ) sub
    WHERE b.id = ${batch.id}::uuid AND b.account_id = ${batch.account_id}::uuid
      AND b.business_id = ${batch.business_id}::uuid
      AND b.approval_method = 'auto_policy' AND b.veto_deadline_at IS NULL
      AND b.halted_at IS NULL AND b.send_closed_at IS NULL
    RETURNING b.veto_deadline_at::text AS veto_deadline_at, sub.first_sent::text AS first_sent
  `;
  if (cas === undefined) return false;

  // Through run-spine's single writer (decision 5; the surface-amendment-2
  // fix that deleted this file's Task-6 duplicate writer): `recordStep`
  // re-takes the run-row lock and computes `step_index` under it, exactly as
  // the duplicate did.
  await recordStep(tx, {
    runId: sendParentRunId,
    stepKey: 'veto_window_granted',
    detail: {
      granted_window_minutes: grantedMinutes,
      first_sent_at: cas.first_sent,
      veto_deadline_at: cas.veto_deadline_at,
      actor: 'system',
    },
  });
  return true;
}

/**
 * The Veto anchor. CASes `veto_deadline_at` on every `auto_policy` batch
 * whose Veto notice has been provider-accepted at least once, fail-closed
 * per D9.
 *
 * Returns a `{ handled, failed }` tally — the same shape `release.ts`'s
 * `tallyPhase` expects from every other phase, so `runReleaseCycle` wires
 * this one in identically (see the module-header note above and this file's
 * deviations log entry for why the shape is `{ handled, failed }` rather
 * than a bare count).
 */
export async function anchorVetoDeadlines(
  sql: Sql,
  scanLimit: number,
): Promise<VetoAnchorTally> {
  const candidates = await selectAnchorCandidates(sql, scanLimit);
  const tally: VetoAnchorTally = { handled: 0, failed: 0 };
  for (const batch of candidates) {
    const anchored = await isolateAnchorItem(
      { batch_id: batch.id, account_id: batch.account_id, business_id: batch.business_id },
      tally,
      () => sql.begin((tx) => anchorOneBatch(tx, batch)),
    );
    if (anchored === true) tally.handled += 1;
  }
  return tally;
}
