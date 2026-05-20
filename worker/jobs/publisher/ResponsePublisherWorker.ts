import type { Job } from 'bullmq';
import { sql } from '../../../src/lib/db/server';
import { checkSubscription } from '../../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, extractOutboxHandle } from '../../../src/lib/shared/outbox';
import type { PublishResponsePayload } from '../../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../../src/lib/shared/logger';
import { asLocationId } from '../../../src/lib/shared/ids';
import type { LocationId } from '../../../src/lib/shared/ids';
import { loadPublishResponseContext } from './load-context';
import { parkResponseForOwnerReconnect } from './no-connection';
import { postReplyAndHandleTerminalOutcomes } from './post-reply';
import { resolvePublishableZernioReviewId } from './review-lookup';
import type { ZernioConnectionRow } from './types';

export async function handlePublishResponse(
  job: Job<PublishResponsePayload>,
): Promise<void> {
  const logger = createWorkerLogger('[ResponsePublisherWorker]', job.data.correlation_id);
  const { response_id } = job.data;
  // Cast job data IDs to branded types at entry point
  const businessId: LocationId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  const context = await loadPublishResponseContext({
    responseId: response_id,
    businessId,
    outboxId,
    outboxAttempt,
    logger,
  });
  if (context === 'completed') return;

  const { response, business } = context;

  // ── Step 2: Publishable-state gate ──────────────────────────────────
  //
  // Only proceed for states that represent owner-approved responses ready
  // to publish via Zernio. Bailing here is critical: without it, a 'failed'
  // or 'superseded' response would still call zernioClient.postReply,
  // creating a real reply on Google that we then fail to record (the
  // status-guarded UPDATE no-ops). 'pending_approval' would post an
  // unapproved response, violating the no-auto-posting invariant.
  //
  // This list mirrors the UPDATE WHERE clauses below and matches
  // AWAITING_PUBLISH_STATUSES exactly.
  const ZERNIO_PUBLISHABLE_STATES = ['approved', 'edited', 'awaiting_owner_connect'] as const;
  if (!(ZERNIO_PUBLISHABLE_STATES as readonly string[]).includes(response.status)) {
    logger.log(
      `Response ${response_id} not in publishable state (status=${response.status}), skipping`,
    );
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // ── Step 3: Subscription guard ─────────────────────────────────────
  const subCheck = checkSubscription(
    business.subscription_status,
    new Date(business.account_updated_at),
    'publisher',
  );

  if (!subCheck.allowed) {
    logger.warn(
      `Business ${businessId} subscription blocked: ${subCheck.reason}`,
    );
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  // ── Step 4: Load active Zernio connection ──────────────────────────
  const [zernioConnection] = await sql<ZernioConnectionRow[]>`
    SELECT zernio_account_id, zernio_location_id
    FROM zernio_connections
    WHERE business_id = ${businessId} AND status = 'active'
    LIMIT 1
  `;

  // ── Step 5: Branch on connection presence ──────────────────────────
  if (!zernioConnection) {
    await parkResponseForOwnerReconnect({
      responseId: response_id,
      businessId,
      outboxId,
      outboxAttempt,
      responseStatus: response.status,
      logger,
    });
    return;
  }

  // Branch B — active connection found. Resolve Zernio's review id, then
  // post the reply.
  const approvedText = response.approved_text ?? '';
  if (!response.approved_text) {
    logger.warn(
      `Response ${response_id} has null approved_text — Zernio reply body will be empty`,
    );
  }

  const zernioReviewId = await resolvePublishableZernioReviewId({
    responseId: response_id,
    businessId,
    reviewId: response.review_id,
    zernioConnection,
    outboxId,
    outboxAttempt,
    logger,
  });
  if (zernioReviewId === 'completed') return;

  const postOutcome = await postReplyAndHandleTerminalOutcomes({
    responseId: response_id,
    businessId,
    reviewId: response.review_id,
    zernioReviewId,
    approvedText,
    outboxId,
    outboxAttempt,
    correlationId: job.data.correlation_id,
    zernioConnection,
    logger,
  });
  if (postOutcome === 'completed') return;

  // ── Step 8: Success ────────────────────────────────────────────────
  await sql`
    UPDATE responses
    SET status = 'posted', posted_at = NOW(), updated_at = NOW()
    WHERE id = ${response_id}
      AND business_id = ${businessId}
      AND status IN ('approved', 'edited', 'awaiting_owner_connect')
  `;

  logger.log(
    `Response ${response_id} posted via Zernio for business ${businessId}`,
  );

  await markOutboxCompleted(outboxId, outboxAttempt);
}
