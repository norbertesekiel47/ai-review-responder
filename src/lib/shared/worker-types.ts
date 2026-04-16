/**
 * Job payload interfaces shared between outbox producers and BullMQ consumers.
 * Every worker and every outbox INSERT must use these types for the payload shape.
 *
 * DemoJobPayload lives in src/lib/demos/types.ts (already exists).
 */

export interface SyncReviewsPayload {
  business_id: string;
  google_place_id: string;
}

export interface GenerateResponsePayload {
  review_id: string;
  business_id: string;
  version: number;
}

export interface SendNotificationPayload {
  response_id: string;
  business_id: string;
  /** Present only when re-queued by the NotificationFailoverPoller. */
  failover?: {
    reason: 'stale_no_delivery' | 'all_deliveries_failed';
  };
}

export interface PublishResponsePayload {
  response_id: string;
  business_id: string;
}

export interface NotifyAdminExceptionPayload {
  review_exception_id: string;
  business_id: string;
}

export interface WeeklySummaryPayload {
  business_id: string;
  /** ISO date 'YYYY-MM-DD' — always a Monday (start of the week being summarized). */
  week_start_date: string;
}

export interface ValidatePlaceIdPayload {
  business_id: string;
  google_maps_url: string;
}

export interface SendMonthlyImpactPayload {
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

export interface EngagementAlertPayload {
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

export interface TrackRankingPayload {
  business_id: string;
  google_place_id: string;
  /** ISO date 'YYYY-MM-DD' — the scheduler run that created this job. Used for outbox dedup. */
  run_date: string;
}

export interface OnboardingDripPayload {
  business_id: string;
  drip_type: 'day_1' | 'day_7' | 'day_30';
}
