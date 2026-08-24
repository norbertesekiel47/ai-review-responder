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
