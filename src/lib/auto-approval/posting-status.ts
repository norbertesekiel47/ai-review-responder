// ── Posting block: is this account structurally eligible to auto-post? ──────
//
// A **Posting block** is a structural, ACCOUNT-WIDE condition that makes the
// Auto-approval lane decline every draft **for the whole account**, independent
// of the policy row. It mirrors the account-wide structural refusals on the
// path a draft takes to Google and nothing else: the four account-wide gates in
// `evaluateAutoApprovalCandidate` (`worker/jobs/response-generation/auto-approval.ts`)
// plus the publisher's Judge flag gate (`worker/jobs/publisher/judge-gate.ts`),
// which refuses AFTER approval and is therefore not in that function.
//
// It reports ACCOUNT-WIDE CONFIGURED ELIGIBILITY — flags, tier, subscription —
// so "no Posting block" means the account is eligible to auto-post, NOT that
// the next draft posts. Three classes of runtime refusal are deliberately out,
// and each is a named residual rather than an oversight:
//
//   1. Judge HEALTH (`isJudgeHealthy`) — three fleet-wide queries per render
//      for a transient answer the publisher owns. `JUDGE_ENABLED=true` with a
//      dead judge sweep still reads as posting.
//   2. PER-LOCATION structural gates — `archived_location` and
//      `active_zernio_connection_missing` (`evaluateAutoApprovalCandidate`).
//      Both are structural and persistent, but they are scoped to one
//      location, and this fact is account-wide. On a single-location account
//      they block every draft while the headline still claims posting.
//   3. PER-DRAFT gates — moderation, triage, rating, daily cap, review hash.
//      Never in scope: the settings page has no draft.
//
// NOT readiness (`readiness.ts`), which answers a different question: may the
// owner WIDEN auto-approval? Readiness' `autopilot_unavailable` folds in
// `autopilotPurchasable()`, which the runtime never reads — an Autopilot
// account with a paused sale carries that reason AND still posts. Nothing here
// is keyed on purchasability, and the input field is named
// `tierGrantsAutopilot` so the readiness value cannot be passed by accident.
//
// Takes no per-draft input: the settings page has no draft.

import type { AutoApprovalPostingBlockReason, AutoApprovalPostingStatus } from './types';

interface BuildAutoApprovalPostingStatusInput {
  runtimeEnabled: boolean;
  judgeEnabled: boolean;
  tierGrantsAutopilot: boolean;
  providerModerationEnabled: boolean;
  publisherSubscriptionAllowed: boolean;
}

export function buildAutoApprovalPostingStatus({
  runtimeEnabled,
  judgeEnabled,
  tierGrantsAutopilot,
  providerModerationEnabled,
  publisherSubscriptionAllowed,
}: BuildAutoApprovalPostingStatusInput): AutoApprovalPostingStatus {
  const reasons: AutoApprovalPostingBlockReason[] = [];

  if (!runtimeEnabled) reasons.push('runtime_disabled');
  if (!judgeEnabled) reasons.push('judge_disabled');
  if (!tierGrantsAutopilot) reasons.push('autopilot_tier_required');
  if (!providerModerationEnabled) reasons.push('provider_moderation_disabled');
  if (!publisherSubscriptionAllowed) reasons.push('publisher_subscription_denied');

  return { blocked: reasons.length > 0, reasons };
}
