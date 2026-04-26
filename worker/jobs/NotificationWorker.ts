// worker/jobs/NotificationWorker.ts
//
// Dispatcher for approval notifications. Loads per-business channel enrollments
// and sends through a NotificationChannel interface. Channel-level failures are
// isolated (one bad channel does not abort the rest). The failover poller
// handles the all-deliveries-failed case separately.
//
// See docs/adding-communication-channels.md §3.1 for the full flow.

import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../src/lib/shared/outbox';
import type { SendNotificationPayload } from '../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../src/lib/shared/logger';
import { getEligibleChannels } from './notification/eligibility';
import { dispatchAll } from './notification/dispatch';

export async function handleSendNotification(
  job: Job<SendNotificationPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[NotificationWorker]', job.data.correlation_id);
  const { response_id, business_id } = job.data;
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  const [responseRow] = await sql<{
    id: string; response_text: string; status: string;
    resp_business_id: string; review_id: string;
    reviewer_name: string; star_rating: number;
    review_text: string | null; review_date: string;
  }[]>`
    SELECT resp.id, resp.response_text, resp.status,
           resp.business_id AS resp_business_id, resp.review_id,
           r.reviewer_name, r.star_rating, r.review_text, r.review_date
    FROM responses resp
    JOIN reviews r ON resp.review_id = r.id
    WHERE resp.id = ${response_id}
  `;

  if (!responseRow) {
    logger.warn(`Response ${response_id} not found`);
    await markOutboxFailed(outboxId, 'response_not_found', outboxAttempt);
    return;
  }
  if (responseRow.resp_business_id !== business_id) {
    logger.error(`Response ${response_id} belongs to business ${responseRow.resp_business_id}, not ${business_id}`);
    await markOutboxFailed(outboxId, 'business_id_mismatch', outboxAttempt);
    return;
  }
  if (responseRow.status !== 'pending_approval') {
    logger.warn(`Response ${response_id} is ${responseRow.status}, not pending_approval — skipping`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  const [business] = await sql<{
    name: string;
    owner_email_bounced: boolean;
    subscription_status: string;
    updated_at: Date;
  }[]>`
    SELECT name, owner_email_bounced, subscription_status, updated_at
    FROM businesses WHERE id = ${business_id}
  `;
  if (!business) {
    logger.warn(`Business ${business_id} not found`);
    await markOutboxFailed(outboxId, 'business_not_found', outboxAttempt);
    return;
  }

  const eligibility = await getEligibleChannels(
    {
      businessId: business_id,
      subscriptionStatus: business.subscription_status,
      businessUpdatedAt: new Date(business.updated_at),
    },
    logger,
  );
  if (!eligibility.ok) {
    if (eligibility.reason === 'no_verified_enrollments') {
      logger.warn(`Business ${business_id} has no verified channel enrollments — skipping`);
    } else {
      logger.log(`Business ${business_id} skipped: ${eligibility.reason}`);
    }
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }
  const enrollments = eligibility.enrollments;
  if (enrollments.length === 0) {
    // All enrollments were filtered out by per-channel feature flags.
    // Outbox completes cleanly — there's no work to do, but no error either.
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  const isFailover = !!(job.data as SendNotificationPayload).failover;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    logger.error('NEXT_PUBLIC_APP_URL not set — cannot construct approval URLs');
    await markOutboxFailed(outboxId, 'NEXT_PUBLIC_APP_URL not configured', outboxAttempt);
    return;
  }

  const { attempted, succeeded } = await dispatchAll(
    {
      responseId: response_id,
      businessId: business_id,
      isFailover,
      appUrl,
      business: {
        name: business.name,
        owner_email_bounced: business.owner_email_bounced,
      },
      review: {
        reviewerName: responseRow.reviewer_name,
        starRating: responseRow.star_rating,
        reviewText: responseRow.review_text,
        reviewDate: responseRow.review_date,
        responsePreview: responseRow.response_text,
      },
    },
    enrollments,
    logger,
  );

  if (attempted > 0 && succeeded === 0) {
    throw new Error(
      `All ${attempted} channel send(s) failed for response ${response_id}. ` +
      `Failed deliveries recorded. BullMQ will retry.`,
    );
  }

  await markOutboxCompleted(outboxId, outboxAttempt);
}
