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
}

export interface SyncReviewsPayload extends BasePayload {
  business_id: string;
  google_place_id: string;
}

export interface GenerateResponsePayload extends BasePayload {
  review_id: string;
  business_id: string;
  version: number;
}

export interface SendNotificationPayload extends BasePayload {
  response_id: string;
  business_id: string;
  /** Present only when re-queued by the NotificationFailoverPoller. */
  failover?: {
    reason: 'stale_no_delivery' | 'all_deliveries_failed';
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
