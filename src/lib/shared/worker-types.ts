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
}

export interface PublishResponsePayload {
  response_id: string;
  business_id: string;
}

export interface NotifyAdminExceptionPayload {
  review_exception_id: string;
  business_id: string;
}
