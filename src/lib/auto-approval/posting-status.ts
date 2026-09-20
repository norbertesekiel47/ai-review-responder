// ── Posting block: is this account structurally eligible to auto-post? ──────
//
// A **Posting block** is a structural, account-wide condition that makes the
// Auto-approval lane decline every draft, independent of the policy row. It
// mirrors the account-wide structural refusals on the path a draft takes to
// Google and nothing else: the four account-wide gates in
// `evaluateAutoApprovalCandidate` (`worker/jobs/response-generation/auto-approval.ts`)
// plus the publisher's Judge flag gate (`worker/jobs/publisher/judge-gate.ts`),
// which refuses AFTER approval and is therefore not in that function.
//
// It reports CONFIGURED ELIGIBILITY — flags, tier, subscription — not live
// fleet health: no Posting block means the account is eligible to auto-post,
// not that the next draft posts. Judge HEALTH is deliberately excluded (three
// fleet-wide queries per render, and the publisher owns that decision).
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
