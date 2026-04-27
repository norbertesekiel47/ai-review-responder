// worker/jobs/notification/context.ts
//
// Loads the response + business rows needed by the notification orchestrator
// and applies the early-exit guards verbatim from the original worker:
//   - response not found              → fail outbox with reason
//   - response/business id mismatch   → fail outbox with reason
//   - response status != pending      → complete outbox (skip)
//   - business not found              → fail outbox with reason
//
// The orchestrator decides outbox finalization based on the discriminated
// result: 'ok' continues to dispatch, 'skip' means complete outbox cleanly,
// 'fail' carries the reason string for markOutboxFailed.

import { sql } from '../../../src/lib/db/server';

export interface NotificationContextInput {
  responseId: string;
  businessId: string;
}

export interface ContextLogger {
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

export interface ResponseRow {
  id: string;
  response_text: string;
  status: string;
  resp_business_id: string;
  review_id: string;
  reviewer_name: string;
  star_rating: number;
  review_text: string | null;
  review_date: string;
}

export interface BusinessRow {
  name: string;
  owner_email_bounced: boolean;
  subscription_status: string;
  updated_at: Date;
}

export type NotificationContextResult =
  | { kind: 'ok'; response: ResponseRow; business: BusinessRow }
  | { kind: 'fail'; reason: string }
  | { kind: 'skip' };

export async function loadNotificationContext(
  input: NotificationContextInput,
  logger: ContextLogger,
): Promise<NotificationContextResult> {
  const [response] = await sql<ResponseRow[]>`
    SELECT resp.id, resp.response_text, resp.status,
           resp.business_id AS resp_business_id, resp.review_id,
           r.reviewer_name, r.star_rating, r.review_text, r.review_date
    FROM responses resp
    JOIN reviews r ON resp.review_id = r.id
    WHERE resp.id = ${input.responseId}
  `;

  if (!response) {
    logger.warn(`Response ${input.responseId} not found`);
    return { kind: 'fail', reason: 'response_not_found' };
  }
  if (response.resp_business_id !== input.businessId) {
    logger.error(
      `Response ${input.responseId} belongs to business ${response.resp_business_id}, not ${input.businessId}`,
    );
    return { kind: 'fail', reason: 'business_id_mismatch' };
  }
  if (response.status !== 'pending_approval') {
    logger.warn(
      `Response ${input.responseId} is ${response.status}, not pending_approval — skipping`,
    );
    return { kind: 'skip' };
  }

  const [business] = await sql<BusinessRow[]>`
    SELECT name, owner_email_bounced, subscription_status, updated_at
    FROM businesses WHERE id = ${input.businessId}
  `;
  if (!business) {
    logger.warn(`Business ${input.businessId} not found`);
    return { kind: 'fail', reason: 'business_not_found' };
  }

  return { kind: 'ok', response, business };
}
