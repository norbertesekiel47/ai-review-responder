// ── Shared write-guards for the two auto-approval settings lanes ────────────
//
// The primitives BOTH `settings.ts` (the Reply machinery) and
// `solicitation-settings.ts` (the Solicitation lane) enforce on every policy
// write: the entitlement row the opening FOR UPDATE captured, the
// subscription-writability predicate, the expansion confirmation rule, and
// the errors those gates throw. Housed here — not in `settings.ts` — because
// `settings.ts` imports the Solicitation lane for its PATCH/GET join points,
// so guards living in `settings.ts` made the two lanes a module cycle.
//
// Invariant #15: no DB client is imported here; the predicates take the row.

import type { AccountFlagsInput } from '@/lib/shared/past-due-recovery';
import { subscriptionGrantsFullAccess } from '@/lib/shared/subscription-status';
import { assertWritableSubscriptionStatus } from '@/lib/shared/writable-subscription';
import type {
  AutoApprovalConfirmationLevel,
  AutoApprovalReadinessBlockReason,
} from './types';

// Received by every mutation gate: the SAME locked account row the opening
// FOR UPDATE captured — never a re-read.
export interface SettingsAccountEntitlementRow {
  id: string;
  subscription_tier: string;
  subscription_status: string;
  past_due_at: Date | string | null;
  flags: AccountFlagsInput;
}

export class AutoApprovalConfirmationRequiredError extends Error {
  constructor(readonly confirmationLevel: AutoApprovalConfirmationLevel) {
    super('auto_approval_confirmation_required');
    this.name = 'AutoApprovalConfirmationRequiredError';
  }
}

export class AutoApprovalExpansionBlockedError extends Error {
  constructor(readonly blockReasons: AutoApprovalReadinessBlockReason[]) {
    super('auto_approval_expansion_blocked');
    this.name = 'AutoApprovalExpansionBlockedError';
  }
}

// Every expansion requires the 'standard' confirmation ('all_ratings' died
// with the 1-star threshold in WS4). Any submitted level satisfies it — a
// stale cached client may still send 'all_ratings', and the pre-WS4
// confirmationSatisfies already accepted it as covering 'standard'; that
// tolerance is kept for one release (see the schema comment in types.ts).
// Returns the required level (or null) for the audit row. Both lanes'
// expansions demand the same level, so the rule has one owner. The parameter
// is only the confirmation field, so the guard never depends on either
// lane's full input type.
export function assertConfirmationProvided(
  input: { confirmationLevel?: AutoApprovalConfirmationLevel },
  expansion: boolean,
): AutoApprovalConfirmationLevel | null {
  if (!expansion) return null;
  if (input.confirmationLevel === undefined) {
    throw new AutoApprovalConfirmationRequiredError('standard');
  }
  return 'standard';
}

// One owner of "which subscription states may write settings".
export function accountSubscriptionWritable(account: SettingsAccountEntitlementRow): boolean {
  if (subscriptionGrantsFullAccess(account.subscription_status)) return true;
  return assertWritableSubscriptionStatus({
    subscriptionStatus: account.subscription_status,
    pastDueAt: account.past_due_at,
    accountFlags: account.flags,
  }).ok;
}
