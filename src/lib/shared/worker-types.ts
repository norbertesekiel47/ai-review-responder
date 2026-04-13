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
