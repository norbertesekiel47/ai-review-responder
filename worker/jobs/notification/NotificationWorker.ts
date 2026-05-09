// worker/jobs/notification/NotificationWorker.ts
//
// Approval-notification orchestrator. Loads response + business context,
// asks eligibility for the channel list, hands off to dispatch, finalizes
// the outbox. Channel-level failures are isolated inside dispatch — the
// failover poller handles the all-deliveries-failed case.
//
// See docs/adding-communication-channels.md §3.1.

import type { Job } from 'bullmq';
import {
  markOutboxCompleted,
  markOutboxFailed,
  extractOutboxHandle,
} from '../../../src/lib/shared/outbox';
import type { SendNotificationPayload } from '../../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { asLocationId } from '../../../src/lib/shared/ids';
import type { LocationId } from '../../../src/lib/shared/ids';
import { getEligibleChannels } from './eligibility';
import { dispatchAll } from './dispatch';
import { loadNotificationContext } from './context';

export async function handleSendNotification(
  job: Job<SendNotificationPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[NotificationWorker]', job.data.correlation_id);
  const { response_id } = job.data;
  // Cast job data IDs to branded types at entry point
  const businessId: LocationId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  const ctx = await loadNotificationContext({ responseId: response_id, businessId }, logger);
  if (ctx.kind === 'fail') {
    await markOutboxFailed(outboxId, ctx.reason, outboxAttempt);
    return;
  }
  if (ctx.kind === 'skip') {
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  const eligibility = await getEligibleChannels(
    {
      accountId: ctx.business.account_id,
      locationId: businessId,
      subscriptionStatus: ctx.business.subscription_status,
      businessUpdatedAt: new Date(ctx.business.account_updated_at),
    },
    logger,
  );
  if (!eligibility.ok) {
    if (eligibility.reason === 'no_verified_enrollments') {
      logger.warn(`Location ${businessId} has no verified channel enrollments — skipping`);
    } else {
      logger.log(`Location ${businessId} skipped: ${eligibility.reason}`);
    }
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    logger.error('NEXT_PUBLIC_APP_URL not set — cannot construct approval URLs');
    await markOutboxFailed(outboxId, 'NEXT_PUBLIC_APP_URL not configured', outboxAttempt);
    return;
  }

  const { attempted, succeeded } = await dispatchAll(
    {
      responseId: response_id,
      businessId,
      accountId: ctx.business.account_id,
      isFailover: !!(job.data as SendNotificationPayload).failover,
      appUrl,
      business: {
        name: ctx.business.name,
        owner_email_bounced: ctx.business.owner_email_bounced,
      },
      review: {
        reviewerName: ctx.response.reviewer_name,
        starRating: ctx.response.star_rating,
        reviewText: ctx.response.review_text,
        reviewDate: ctx.response.review_date,
        responsePreview: ctx.response.response_text,
      },
    },
    eligibility.enrollments,
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
