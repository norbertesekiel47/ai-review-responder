/**
 * Job payload interfaces shared between outbox producers and BullMQ consumers.
 * Every worker and every outbox INSERT must use these types for the payload shape.
 *
 * DemoJobPayload lives in src/lib/demos/types.ts (already exists).
 */

/**
 * Base interface for all outbox job payloads.
 * correlation_id is optional for backward compat with existing outbox rows.
 */
export interface BasePayload {
  correlation_id?: string;
  outbox_id?: string;
  outbox_attempt?: number;
}

export const GENERATE_RESPONSE_ORIGIN_LANE = {
  LIVE_INGEST_NEW: 'live_ingest_new',
  LIVE_INGEST_UPDATE: 'live_ingest_update',
  BACKFILL: 'backfill',
  REGENERATE: 'regenerate',
} as const;

export const GENERATE_RESPONSE_ORIGIN_LANES = Object.values(GENERATE_RESPONSE_ORIGIN_LANE);

export type GenerateResponseOriginLane =
  (typeof GENERATE_RESPONSE_ORIGIN_LANES)[number];

export interface GenerateResponsePayload extends BasePayload {
  review_id: string;
  business_id: string;
  version: number;
  /**
   * Producer-required. Every generate_response job is emitted through
   * `enqueueGenerateResponse`, whose typed input requires a lane, so this field
   * is always present on freshly produced jobs and a producer cannot silently
   * omit it. Legacy in-flight jobs that predate this field are tolerated only at
   * the runtime boundary by `normalizeGenerateResponsePayload`, which reads
   * `job.data` as `unknown` and resolves a missing/unknown lane to a non-auto
   * `null` — that tolerance lives in the parser, not in this wire contract.
   */
  origin_lane: GenerateResponseOriginLane;
  /**
   * When true, the ResponseGeneratorWorker skips the send_notification
   * outbox enqueue. Used by ZernioBackfillWorker so the first-connect
   * backfill of up to 75 reviews does NOT blast 75 approval emails.
   * Added by Zernio ingestion plan (spec §4.6, §6.6, §6.7).
   */
  suppress_notification?: boolean;
}

export interface SendNotificationPayload extends BasePayload {
  response_id: string;
  business_id: string;
  /** Present only when re-queued by the NotificationFailoverPoller. */
  failover?: {
    reason: 'all_deliveries_failed';
    // 'stale_no_delivery' was removed in Phase 0 — the poller alerts admin
    // directly instead of re-dispatching. See docs/adding-communication-channels.md §3.5.
  };
}

export interface PublishResponsePayload extends BasePayload {
  response_id: string;
  business_id: string;
}

export interface NotifyAdminExceptionPayload extends BasePayload {
  review_exception_id: string;
  business_id: string;
}

export interface WeeklySummaryPayload extends BasePayload {
  business_id: string;
  /** ISO date 'YYYY-MM-DD' — always a Monday (start of the week being summarized). */
  week_start_date: string;
}

export interface ValidatePlaceIdPayload extends BasePayload {
  business_id: string;
  google_maps_url: string;
}

export interface SendMonthlyImpactPayload extends BasePayload {
  business_id: string;
  /** ISO date 'YYYY-MM-DD' — always the 1st of the month being summarized. */
  month_start_date: string;
}

export type EngagementAlertType =
  | 'owner_nudge'
  | 'partner_engagement_alert'
  | 'partner_escalation_alert'
  | 'partner_low_engagement'
  | 'partner_satisfaction_alert';

export interface EngagementAlertPayload extends BasePayload {
  business_id: string;
  alert_type: EngagementAlertType;
  /** Required for all alert types except partner_satisfaction_alert. */
  metrics?: {
    days_since_approval: number | null;
    oldest_pending_age_days: number | null;
    pending_count: number;
    approval_rate: number | null;
    notified_count: number;
  };
  /** Present only for partner_satisfaction_alert — carries the satisfaction pulse response data. */
  satisfaction?: {
    rating: 'great' | 'ok' | 'not_great';
    comment: string | null;
    week_start_date: string;
  };
}

export interface TrackRankingPayload extends BasePayload {
  business_id: string;
  google_place_id: string;
  /** ISO date 'YYYY-MM-DD' — the scheduler run that created this job. Used for outbox dedup. */
  run_date: string;
}

export interface OnboardingDripPayload extends BasePayload {
  business_id: string;
  drip_type: 'day_1' | 'day_7' | 'day_30';
}

export interface DrainOwnerConnectPayload extends BasePayload {
  business_id: string;
}

export type SendOwnerEmailPayload = BasePayload & (
  | { kind: 'reconnect_required'; response_id: string; business_id: string }
  | { kind: 'connection_lost'; business_id: string }
);

/**
 * IngestZernioReviewPayload — emitted by the Zernio webhook handler (one row
 * per active connection at the firing account). Fanned out across same-account
 * multi-location connections; the worker filters by location after fetching
 * the review.
 */
export interface IngestZernioReviewPayload extends BasePayload {
  business_id: string;
  zernio_account_id: string;
  zernio_location_id: string;
  /** BARE id (not resource path); matches ZernioReview.id */
  zernio_review_id: string;
}

/**
 * ZernioInitialBackfillPayload — emitted by the connect-callback when the
 * `needs_backfill` predicate is satisfied, and by reactivation catch-up.
 */
export interface ZernioInitialBackfillPayload extends BasePayload {
  business_id: string;
  zernio_account_id: string;
  zernio_location_id: string;
  /** Subscription tier string (forward-compat, use SubscriptionTier.FOUNDERS etc.) */
  subscription_tier: string;
  /** ISO timestamp from accounts.subscription_activated_at */
  subscription_activated_at: string;
  /** Initial connect is one-shot; reactivation catch-up may run after archive/restore. */
  backfill_reason?: 'initial' | 'reactivation';
}

export interface StripeCheckoutReconcilePayload extends BasePayload {
  account_id: string;
  checkout_session_id: string;
}

export interface AccountOffboardingBillingSchedulePayload extends BasePayload {
  account_offboarding_id: string;
  account_id: string;
  idempotency_key_hash: string;
}

export interface AccountOffboardingEmailPayload extends BasePayload {
  account_offboarding_id: string;
  account_id: string;
  email_type: 'cancel_only_confirmation' | 'cancel_only_reactivation_confirmation';
  idempotency_key_hash?: string;
}
