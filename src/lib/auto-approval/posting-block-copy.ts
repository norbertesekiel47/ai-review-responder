// #1352 — the owner-facing Posting block sentences, shared by every surface
// that shows a Posting block: today the settings page, later the Owner
// Operator's Proposal card (T5). One owner for the copy so the two consumers
// cannot drift.

import type { AutoApprovalPostingBlockReason } from './types';

/**
 * Owner-language Posting block reasons — why this account is not set up to
 * post automatically, whatever the policy says. Deliberately separate from
 * the settings page's readiness copy: that one explains why the owner cannot
 * WIDEN auto-approval, this one explains why the lane is not configured to
 * act. The exhaustive mapped type is the guard — a new reason without a
 * sentence is a compile error, not a runtime blank line.
 *
 * `autopilot_tier_required` names Copilot literally, and that is correct:
 * `tierGrantsAutopilot` is true only for Autopilot, so Copilot is the only
 * tier that can produce this reason. It is a display name, not a tier
 * comparison — no code here branches on a tier value.
 */
export const POSTING_BLOCK_COPY: { readonly [R in AutoApprovalPostingBlockReason]: string } = {
  runtime_disabled: 'Auto-posting is not switched on for RepWorth yet.',
  judge_disabled: 'Our reply review step is switched off right now, and nothing posts without it.',
  autopilot_tier_required: 'Auto-posting is part of the Autopilot plan, and this account is on Copilot.',
  provider_moderation_disabled: 'Safety screening for replies is switched off right now, so nothing posts on its own.',
  publisher_subscription_denied: 'Your billing needs attention before any reply can post.',
};

/**
 * Maps Posting block reasons to their owner sentences in the GIVEN order,
 * adding nothing. Order is the caller's: `buildAutoApprovalPostingStatus`
 * pushes reasons in a fixed declaration order, and that is the order the
 * owner should read them in.
 */
export function postingBlockSentences(
  reasons: readonly AutoApprovalPostingBlockReason[],
): string[] {
  return reasons.map((reason) => POSTING_BLOCK_COPY[reason]);
}
