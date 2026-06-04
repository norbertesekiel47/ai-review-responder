import type { ModerationDecision } from '../../../src/lib/moderation/output-filter';
import {
  resolveEffectivePolicy,
  starMeetsThreshold,
} from '../../../src/lib/auto-approval/policy';
import type {
  EffectiveAutoApprovalPolicy,
  PolicyRowState,
} from '../../../src/lib/auto-approval/types';
import {
  autoApprovalRuntimeEnabled,
  providerModerationEnabled,
} from '../../../src/lib/auto-approval/flags';
import {
  checkSubscription,
  type AccountFlagsInput,
  type SubscriptionCheckResult,
} from '../../../src/lib/shared/subscription-guard';
import {
  GENERATE_RESPONSE_ORIGIN_LANE,
  type GenerateResponseOriginLane,
} from '../../../src/lib/shared/worker-types';
import type postgres from 'postgres';

type TxClient = postgres.TransactionSql;

export type AutoApprovalBlockReason =
  | 'policy_not_enabled'
  | 'rating_below_threshold'
  | 'bad_origin_lane'
  | 'unsupported_version'
  | 'suppressed_notification'
  | 'review_content_hash_missing'
  | 'review_content_changed_before_persist'
  | 'current_rating_missing'
  | 'provider_moderation_disabled'
  | 'provider_moderation_error'
  | 'moderation_flagged'
  | 'moderation_held'
  | 'publisher_subscription_denied'
  | 'archived_location'
  | 'active_zernio_connection_missing'
  | 'auto_approval_disabled';

export interface AutoApprovalCandidateInput {
  originLane: GenerateResponseOriginLane | null;
  version: number;
  suppressNotification: boolean;
  loadedReviewContentHash: string | null;
  currentReviewContentHash: string | null;
  currentStarRating: number | null;
  effectivePolicy: EffectiveAutoApprovalPolicy;
  moderation: ModerationDecision;
  held: boolean;
  subscriptionStatus: string;
  accountPastDueAt: Date | string | null;
  accountFlags: AccountFlagsInput;
  activeLocationNow: boolean;
  activeZernioConnectionNow: boolean;
  now?: Date;
}

export interface AutoApprovalDecision {
  approved: boolean;
  blockReasons: AutoApprovalBlockReason[];
  publisherSubscription: SubscriptionCheckResult;
  reviewContentHashMatched: boolean;
  providerModerationEnabled: boolean;
  runtimeEnabled: boolean;
}

interface AutoApprovalCurrentStateRow {
  star_rating: number | null;
  review_content_hash: string | null;
  archived_at: Date | null;
  subscription_status: string;
  account_past_due_at: Date | null;
  account_flags: AccountFlagsInput | null;
}

interface AutoApprovalPolicyRow {
  id: string;
  account_id: string;
  location_id: string | null;
  auto_approve_min_star: 1 | 2 | 3 | 4 | 5 | null;
}

export interface AutoApprovalRuntimeState {
  currentReviewContentHash: string | null;
  currentStarRating: number | null;
  effectivePolicy: EffectiveAutoApprovalPolicy;
  subscriptionStatus: string;
  accountPastDueAt: Date | null;
  accountFlags: AccountFlagsInput;
  activeLocationNow: boolean;
  activeZernioConnectionNow: boolean;
}

export function providerModerationClean(moderation: ModerationDecision): boolean {
  return providerModerationEnabled()
    && moderation.providerStatus === 'clean'
    && moderation.flagged === false;
}

function policyRowsToEffectivePolicy(
  rows: AutoApprovalPolicyRow[],
  accountId: string,
  businessId: string,
): EffectiveAutoApprovalPolicy {
  const accountDefault = rows.find((row) => row.account_id === accountId && row.location_id === null);
  const locationOverride = rows.find((row) => row.account_id === accountId && row.location_id === businessId);

  const toPolicy = (row: AutoApprovalPolicyRow | undefined): PolicyRowState | null => {
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.account_id,
      locationId: row.location_id,
      autoApproveMinStar: row.auto_approve_min_star,
    };
  };

  return resolveEffectivePolicy(toPolicy(accountDefault), toPolicy(locationOverride));
}

export async function loadAutoApprovalRuntimeState(
  tx: TxClient,
  input: {
    reviewId: string;
    businessId: string;
    accountId: string;
  },
): Promise<AutoApprovalRuntimeState> {
  const { reviewId, businessId, accountId } = input;
  const [state] = await tx<AutoApprovalCurrentStateRow[]>`
    SELECT r.star_rating, r.review_content_hash, b.archived_at,
           a.subscription_status, a.past_due_at AS account_past_due_at,
           a.flags AS account_flags
    FROM reviews r
    JOIN businesses b ON b.id = r.business_id
    JOIN accounts a ON a.id = b.account_id
    WHERE r.id = ${reviewId}
      AND r.business_id = ${businessId}
      AND b.account_id = ${accountId}
  `;

  if (!state) {
    throw new Error('auto_approval_current_state_missing');
  }

  const policyRows = await tx<AutoApprovalPolicyRow[]>`
    SELECT id, account_id, location_id, auto_approve_min_star
    FROM auto_approval_policies
    WHERE account_id = ${accountId}
      AND (location_id IS NULL OR location_id = ${businessId})
  `;

  const [activeConnection] = await tx<{ id: string }[]>`
    SELECT id
    FROM zernio_connections
    WHERE business_id = ${businessId}
      AND status = 'active'
    LIMIT 1
  `;

  return {
    currentReviewContentHash: state.review_content_hash,
    currentStarRating: state.star_rating,
    effectivePolicy: policyRowsToEffectivePolicy(policyRows, accountId, businessId),
    subscriptionStatus: state.subscription_status,
    accountPastDueAt: state.account_past_due_at,
    accountFlags: state.account_flags ?? {},
    activeLocationNow: state.archived_at === null,
    activeZernioConnectionNow: Boolean(activeConnection),
  };
}

export function evaluateAutoApprovalCandidate(input: AutoApprovalCandidateInput): AutoApprovalDecision {
  const publisherSubscription = checkSubscription({
    status: input.subscriptionStatus,
    pastDueAt: input.accountPastDueAt,
    accountFlags: input.accountFlags,
    workerType: 'publisher',
    now: input.now,
  });
  const providerEnabled = providerModerationEnabled();
  const runtimeEnabled = autoApprovalRuntimeEnabled();
  const reviewContentHashMatched = input.loadedReviewContentHash !== null
    && input.currentReviewContentHash !== null
    && input.loadedReviewContentHash === input.currentReviewContentHash;
  const thresholdReason = thresholdBlockReason(input);

  const blockReasons = compactBlockReasons([
    thresholdReason,
    when(input.originLane !== GENERATE_RESPONSE_ORIGIN_LANE.LIVE_INGEST_NEW, 'bad_origin_lane'),
    reviewContentHashBlockReason(input, reviewContentHashMatched),
    when(input.currentStarRating === null && thresholdReason !== 'current_rating_missing', 'current_rating_missing'),
    providerModerationBlockReason(input.moderation, providerEnabled),
    when(input.moderation.flagged, 'moderation_flagged'),
    when(input.held, 'moderation_held'),
    when(!publisherSubscription.allowed, 'publisher_subscription_denied'),
    when(!input.activeLocationNow, 'archived_location'),
    when(!input.activeZernioConnectionNow, 'active_zernio_connection_missing'),
    when(!runtimeEnabled, 'auto_approval_disabled'),
    when(input.version !== 1, 'unsupported_version'),
    when(input.suppressNotification, 'suppressed_notification'),
  ]);

  return {
    approved: blockReasons.length === 0 && providerModerationClean(input.moderation),
    blockReasons,
    publisherSubscription,
    reviewContentHashMatched,
    providerModerationEnabled: providerEnabled,
    runtimeEnabled,
  };
}

function thresholdBlockReason(input: Pick<
  AutoApprovalCandidateInput,
  'currentStarRating' | 'effectivePolicy'
>): AutoApprovalBlockReason | null {
  if (starMeetsThreshold(input.currentStarRating, input.effectivePolicy.threshold)) {
    return null;
  }
  if (input.effectivePolicy.threshold === null) {
    return 'policy_not_enabled';
  }
  if (input.currentStarRating === null) {
    return 'current_rating_missing';
  }
  return 'rating_below_threshold';
}

function reviewContentHashBlockReason(
  input: Pick<AutoApprovalCandidateInput, 'loadedReviewContentHash' | 'currentReviewContentHash'>,
  reviewContentHashMatched: boolean,
): AutoApprovalBlockReason | null {
  if (input.loadedReviewContentHash === null || input.currentReviewContentHash === null) {
    return 'review_content_hash_missing';
  }
  return reviewContentHashMatched ? null : 'review_content_changed_before_persist';
}

function providerModerationBlockReason(
  moderation: ModerationDecision,
  providerEnabled: boolean,
): AutoApprovalBlockReason | null {
  if (!providerEnabled) {
    return 'provider_moderation_disabled';
  }
  return moderation.providerStatus === 'clean' ? null : 'provider_moderation_error';
}

function when(
  condition: boolean,
  reason: AutoApprovalBlockReason,
): AutoApprovalBlockReason | null {
  return condition ? reason : null;
}

function compactBlockReasons(
  blockReasons: Array<AutoApprovalBlockReason | null>,
): AutoApprovalBlockReason[] {
  return blockReasons.filter((reason): reason is AutoApprovalBlockReason => reason !== null);
}
