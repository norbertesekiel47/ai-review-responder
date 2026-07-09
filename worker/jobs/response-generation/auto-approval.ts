import type { ModerationDecision } from '../../../src/lib/moderation/output-filter';
import {
  resolveDailyCap,
  resolveEffectivePolicy,
  starMeetsThreshold,
} from '../../../src/lib/auto-approval/policy';
import {
  APPROVAL_METHOD,
  POLICY_ACTION_POSTING,
  POLICY_PERSONA_REPLY,
  type EffectiveAutoApprovalPolicy,
  type PolicyRowState,
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
import { TRIAGE_SOURCE, type TriageSeverity } from '../../../src/lib/reviews/triage-schema';
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
  | 'auto_approval_disabled'
  | 'triage_high_severity'
  | 'triage_fallback'
  | 'rating_below_positive_quadrant'
  | 'daily_cap_exhausted'
  | 'policy_suspended';

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
  triageSeverity: TriageSeverity | null;
  triageSource: string | null;
  autoApprovedTodayCount: number;
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
  triage_severity: TriageSeverity | null;
  triage_source: string | null;
}

interface AutoApprovalPolicyRow {
  id: string;
  account_id: string;
  location_id: string | null;
  // Migration 074 CHECK-constrains auto_approve_min_star to 4..5,
  // veto_window_minutes to 15|30, daily_auto_post_cap to NULL or 1..50.
  auto_approve_min_star: 4 | 5 | null;
  veto_window_minutes: 15 | 30;
  daily_auto_post_cap: number | null;
  suspended_at: Date | null;
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
  triageSeverity: TriageSeverity | null;
  triageSource: string | null;
  /** Auto-approvals GRANTED for this location today (UTC), counted under the business lock. */
  autoApprovedTodayCount: number;
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
      vetoWindowMinutes: row.veto_window_minutes,
      dailyAutoPostCap: row.daily_auto_post_cap,
      suspendedAt: row.suspended_at,
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
           a.flags AS account_flags,
           r.triage_severity, r.triage_source
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
    SELECT id, account_id, location_id, auto_approve_min_star,
           veto_window_minutes, daily_auto_post_cap, suspended_at
    FROM auto_approval_policies
    WHERE account_id = ${accountId}
      AND (location_id IS NULL OR location_id = ${businessId})
      AND persona = ${POLICY_PERSONA_REPLY}
      AND action_class = ${POLICY_ACTION_POSTING}
  `;
  const effectivePolicy = policyRowsToEffectivePolicy(policyRows, accountId, businessId);

  // Same-tx RE-TAKE of the businesses row lock (idempotent — Postgres row
  // locks don't stack within a transaction). The REAL first take happens in
  // persist.ts immediately after its reviews FOR UPDATE, BEFORE the responses
  // INSERT: that INSERT's business_id FK grabs an implicit FOR KEY SHARE on
  // this row, and taking FOR UPDATE only here would be a share → exclusive
  // upgrade that deadlocks (40P01) against a concurrent persist for the same
  // business. Kept in the loader so its cap-count correctness stays
  // self-contained even if a future caller forgets the early lock (that
  // caller re-introduces the deadlock risk, but never a cap overshoot).
  // Global lock order: reviews → businesses → child rows, where "first"
  // means before ANY statement that takes an implicit FK lock on the row —
  // explicit FOR UPDATE statement order alone is not enough.
  // FP: ordered on purpose — the lock must be held BEFORE the count below or
  // two concurrent persists both read a below-cap count and overshoot the cap.
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
  await tx`SELECT id FROM businesses WHERE id = ${businessId} FOR UPDATE`;

  // Auto-approvals GRANTED today (UTC calendar day), not posts landed today —
  // vetoed/downgraded rows still consume their slot (conservative; fails
  // toward the owner). Kept as its own top-level statement: the tenant-scope
  // auditor strips subqueries, so the business_id scope must be visible here.
  const [capRow] = await tx<{ auto_approved_today: number }[]>`
    SELECT count(*)::int AS auto_approved_today
    FROM responses
    WHERE business_id = ${businessId}
      AND approval_method = ${APPROVAL_METHOD.AUTO_POLICY}
      AND approved_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  `;
  if (!capRow) {
    // count(*) always yields one row — reaching this means the query itself
    // broke (or a test queued the wrong rows); fail the tx rather than
    // evaluate the cap gate against fabricated data.
    throw new Error('auto_approval_cap_count_missing');
  }

  // Kept as a separate top-level statement on purpose: the tenant-scope auditor
  // strips subqueries before crediting business_id/account_id scope, so folding
  // this into an EXISTS on the state SELECT reads as unscoped. The spec (§8)
  // accepts this extra indexed read as the cost of a current-state re-read.
  // FP: two reads on the shared tx, deliberately kept as separate top-level statements (see comment above) so the tenant-scope auditor credits business_id/account_id scope; not independently parallelizable.
  // react-doctor-disable-next-line react-doctor/server-sequential-independent-await
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
    effectivePolicy,
    autoApprovedTodayCount: capRow.auto_approved_today,
    subscriptionStatus: state.subscription_status,
    accountPastDueAt: state.account_past_due_at,
    accountFlags: state.account_flags ?? {},
    activeLocationNow: state.archived_at === null,
    activeZernioConnectionNow: Boolean(activeConnection),
    triageSeverity: state.triage_severity,
    triageSource: state.triage_source,
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
    when(input.currentStarRating === null, 'current_rating_missing'),
    providerModerationBlockReason(input.moderation, providerEnabled),
    when(input.moderation.flagged, 'moderation_flagged'),
    when(input.held, 'moderation_held'),
    when(!publisherSubscription.allowed, 'publisher_subscription_denied'),
    when(!input.activeLocationNow, 'archived_location'),
    when(!input.activeZernioConnectionNow, 'active_zernio_connection_missing'),
    when(!runtimeEnabled, 'auto_approval_disabled'),
    when(input.version !== 1, 'unsupported_version'),
    when(input.suppressNotification, 'suppressed_notification'),
    when(input.triageSeverity === 'high', 'triage_high_severity'),
    when(input.triageSource === TRIAGE_SOURCE.FALLBACK, 'triage_fallback'),
    // WS4 gates (spec §2.2–§2.4). The positive-quadrant hard floor sits ABOVE
    // the dial — it fires regardless of the policy row, like the triage and
    // moderation vetoes. Unrated stays blocked by current_rating_missing.
    when(input.currentStarRating !== null && input.currentStarRating <= 3, 'rating_below_positive_quadrant'),
    when(input.autoApprovedTodayCount >= resolveDailyCap(input.effectivePolicy), 'daily_cap_exhausted'),
    when(input.effectivePolicy.suspended, 'policy_suspended'),
  ]);

  return {
    approved: blockReasons.length === 0,
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
  return [...new Set(
    blockReasons.filter((reason): reason is AutoApprovalBlockReason => reason !== null),
  )];
}
