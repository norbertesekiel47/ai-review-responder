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

import type { Sql, TransactionSql } from 'postgres';
import { tierGrantsAutopilot } from '@/lib/accounts/tier-config';
import { subscriptionGrantsFullAccess } from '@/lib/shared/subscription-status';
import { recordStep } from '@/lib/agents/run-spine';
import { enqueueSolicitationVetoNotice } from '@/lib/shared/job-outbox-helpers';
import { lockAutonomyAccount } from '@/lib/auto-approval/account-lock';
import { solicitationAutoApprovalEnabled, solicitationSendEnabled } from './flags';

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
  if (!c.sendFlag) return { eligible: false, reason: 'send_flag_off' };
  if (!c.autoFlag) return { eligible: false, reason: 'auto_flag_off' };
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
 * The finale hook body (#631 Task 4 Step 3), extracted so the finale itself
 * stays orchestration: take the account lock (decision 3 — AFTER the batch
 * row lock the finale already holds, the documented batch-then-account
 * order), evaluate the gate under that serialization, then either run the
 * verb or report the decline. Called ONLY from `generateAsksForBatch`'s
 * finale transaction, only when the batch stayed open with live rows — never
 * from `regenerateAsk` (locked decision 1: regen exists only in `built`,
 * i.e. only for batches this lane already declined).
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
