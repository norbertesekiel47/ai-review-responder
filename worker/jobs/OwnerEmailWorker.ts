// worker/jobs/OwnerEmailWorker.ts
//
// Owner-directed email worker for the Zernio integration. Discriminated
// payload router with `kind` as the discriminant. Two handlers:
//
//   - reconnect_required → response transitioned to awaiting_owner_connect
//                          and the owner needs to reconnect Zernio so the
//                          queued reply can be published.
//   - connection_lost    → Zernio reported the GBP connection went offline
//                          (account.disconnected webhook OR auth-error-on-post).
//
// Both handlers share the eligibility flow:
//   1. Load business
//   2. Subscription guard
//   3. owner_email_bounced check
//   4. Kind-specific context load
//   5. Claim-before-send into notification_deliveries (uses migration 026
//      partial unique indexes)
//   6. Send via sendInternalEmail
//   7. Backfill external_message_id + sent_at
//   8. markOutboxCompleted
//
// See spec §2.4 (2026-04-27-zernio-integration-design.md).

import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import {
  markOutboxCompleted,
  markOutboxFailed,
  extractOutboxHandle,
} from '../../src/lib/shared/outbox';
import {
  sendInternalEmail,
  buildOwnerReconnectRequiredEmailHtml,
  buildOwnerConnectionLostEmailHtml,
} from '../../src/lib/notifications/email';
import type { SendOwnerEmailPayload } from '../../src/lib/shared/worker-types';
import { createWorkerLogger, type WorkerLogger } from '../../src/lib/shared/logger';

interface BusinessRow {
  id: string;
  name: string;
  owner_email: string;
  owner_email_bounced: boolean;
  subscription_status: string;
  updated_at: Date;
}

export async function handleOwnerEmail(
  job: Job<SendOwnerEmailPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[OwnerEmailWorker]', job.data.correlation_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  const businessId = job.data.business_id;

  const [business] = await sql<BusinessRow[]>`
    SELECT id, name, owner_email, owner_email_bounced, subscription_status, updated_at
    FROM businesses
    WHERE id = ${businessId}
  `;

  if (!business) {
    logger.error(`Business ${businessId} not found`);
    await markOutboxFailed(outboxId, `business_not_found: ${businessId}`, outboxAttempt);
    return;
  }

  const subCheck = checkSubscription(
    business.subscription_status,
    new Date(business.updated_at),
    'owner_email',
  );

  if (!subCheck.allowed) {
    logger.warn(
      `Business ${businessId} subscription blocked: ${subCheck.reason}`,
    );
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  if (business.owner_email_bounced) {
    logger.log(
      `Business ${businessId} owner email bounced — skipping owner email`,
    );
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    logger.error('NEXT_PUBLIC_APP_URL not set — cannot construct reconnect URL');
    await markOutboxFailed(outboxId, 'NEXT_PUBLIC_APP_URL not configured', outboxAttempt);
    return;
  }
  const dashboardConnectUrl = `${appUrl}/dashboard/connect`;

  if (job.data.kind === 'reconnect_required') {
    await sendReconnectRequired(
      job.data,
      business,
      dashboardConnectUrl,
      outboxId,
      outboxAttempt,
      logger,
    );
    return;
  }

  await sendConnectionLost(
    business,
    dashboardConnectUrl,
    outboxId,
    outboxAttempt,
    logger,
  );
}

// ─── reconnect_required ─────────────────────────────────────────────────

async function sendReconnectRequired(
  payload: Extract<SendOwnerEmailPayload, { kind: 'reconnect_required' }>,
  business: BusinessRow,
  dashboardConnectUrl: string,
  outboxId: string,
  outboxAttempt: number | undefined,
  logger: WorkerLogger,
): Promise<void> {
  // Verify the response is still awaiting_owner_connect — status may have
  // transitioned since enqueue (connection restored, response superseded,
  // admin marked failed, etc.).
  const [response] = await sql<{ status: string; review_id: string }[]>`
    SELECT status, review_id
    FROM responses
    WHERE id = ${payload.response_id}
      AND business_id = ${payload.business_id}
  `;

  if (!response) {
    logger.warn(
      `Response ${payload.response_id} not found — completing outbox`,
    );
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  if (response.status !== 'awaiting_owner_connect') {
    logger.log(
      `Response ${payload.response_id} status=${response.status} (not awaiting_owner_connect) — skipping`,
    );
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  const [review] = await sql<{ reviewer_name: string }[]>`
    SELECT reviewer_name
    FROM reviews
    WHERE id = ${response.review_id}
  `;
  const reviewerName = review?.reviewer_name ?? 'a reviewer';

  // Atomically claim the delivery slot BEFORE sending.
  // Uses migration 026's notification_deliveries_owner_reconnect_dedup
  // partial unique index on (response_id, template).
  const deliveryId = uuidv7();
  const claimed = await sql<{ id: string }[]>`
    INSERT INTO notification_deliveries
      (id, business_id, response_id, channel, recipient, template)
    VALUES
      (${deliveryId}, ${business.id}, ${payload.response_id}, 'email',
       ${business.owner_email}, 'owner_reconnect_required')
    ON CONFLICT (response_id, template)
      WHERE response_id IS NOT NULL AND template = 'owner_reconnect_required'
      DO NOTHING
    RETURNING id
  `;

  if (claimed.length === 0) {
    logger.log(
      `reconnect_required: dedup hit for response ${payload.response_id} — already claimed`,
    );
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  const bodyHtml = buildOwnerReconnectRequiredEmailHtml({
    businessName: business.name,
    reviewerName,
    dashboardConnectUrl,
  });

  let messageId: string;
  try {
    const result = await sendInternalEmail({
      to: business.owner_email,
      subject: `Your reply for ${business.name} is ready to publish`,
      bodyHtml,
      category: 'marketing',
    });
    messageId = result.messageId;
  } catch (err) {
    // Roll back the claim so a retry can re-attempt delivery. Without this
    // the next BullMQ attempt would see the claim row and skip, losing the
    // email entirely on any transient Resend failure. Mirrors
    // ResponsePublisherWorker's claim-rollback pattern.
    let deleteError: unknown = null;
    try {
      await sql`
        DELETE FROM notification_deliveries
        WHERE id = ${deliveryId} AND external_message_id IS NULL
      `;
    } catch (delErr) {
      deleteError = delErr;
      logger.error(
        `Failed to roll back delivery claim ${deliveryId} after send error: ${delErr instanceof Error ? delErr.message : delErr}`,
      );
    }

    if (deleteError !== null) {
      const sendReason = err instanceof Error ? err.message : String(err);
      const delReason = deleteError instanceof Error ? deleteError.message : String(deleteError);
      await markOutboxFailed(
        outboxId,
        `send_failed_and_rollback_failed: send=${sendReason} rollback=${delReason}`,
        outboxAttempt,
      );
      return;
    }
    throw err;
  }

  await sql`
    UPDATE notification_deliveries
    SET external_message_id = ${messageId}, sent_at = NOW()
    WHERE id = ${deliveryId}
  `;

  logger.log(
    `reconnect_required email sent for response ${payload.response_id} (business ${business.id})`,
  );

  await markOutboxCompleted(outboxId, outboxAttempt);
}

// ─── connection_lost ────────────────────────────────────────────────────

async function sendConnectionLost(
  business: BusinessRow,
  dashboardConnectUrl: string,
  outboxId: string,
  outboxAttempt: number | undefined,
  logger: WorkerLogger,
): Promise<void> {
  // Count queued responses for the email body. Best-effort — if zero, the
  // template hides the count line.
  const queuedCountRows = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM responses
    WHERE business_id = ${business.id}
      AND status = 'awaiting_owner_connect'
  `;
  const queuedCount = queuedCountRows[0]?.count ?? '0';

  // Atomically claim the delivery slot BEFORE sending.
  // CRITICAL: the ON CONFLICT clause MUST match migration 026's index
  // expression byte-for-byte. The index uses
  //   ((created_at AT TIME ZONE 'UTC')::date)
  // because timestamptz::date is STABLE (not IMMUTABLE) in Postgres —
  // wrapping with `AT TIME ZONE 'UTC'` first yields an IMMUTABLE
  // expression that's legal in an index predicate / key. Using
  // (created_at::date) here would fail with "no unique or exclusion
  // constraint matching the ON CONFLICT specification".
  const deliveryId = uuidv7();
  const claimed = await sql<{ id: string }[]>`
    INSERT INTO notification_deliveries
      (id, business_id, channel, recipient, template)
    VALUES
      (${deliveryId}, ${business.id}, 'email',
       ${business.owner_email}, 'owner_connection_lost')
    ON CONFLICT (business_id, template, ((created_at AT TIME ZONE 'UTC')::date))
      WHERE template = 'owner_connection_lost'
      DO NOTHING
    RETURNING id
  `;

  if (claimed.length === 0) {
    logger.log(
      `connection_lost: dedup hit for business ${business.id} — already sent today`,
    );
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  const bodyHtml = buildOwnerConnectionLostEmailHtml({
    businessName: business.name,
    queuedCount: Number(queuedCount),
    dashboardConnectUrl,
  });

  let messageId: string;
  try {
    const result = await sendInternalEmail({
      to: business.owner_email,
      subject: `Google Business connection paused for ${business.name}`,
      bodyHtml,
      category: 'marketing',
    });
    messageId = result.messageId;
  } catch (err) {
    let deleteError: unknown = null;
    try {
      await sql`
        DELETE FROM notification_deliveries
        WHERE id = ${deliveryId} AND external_message_id IS NULL
      `;
    } catch (delErr) {
      deleteError = delErr;
      logger.error(
        `Failed to roll back delivery claim ${deliveryId} after send error: ${delErr instanceof Error ? delErr.message : delErr}`,
      );
    }

    if (deleteError !== null) {
      const sendReason = err instanceof Error ? err.message : String(err);
      const delReason = deleteError instanceof Error ? deleteError.message : String(deleteError);
      await markOutboxFailed(
        outboxId,
        `send_failed_and_rollback_failed: send=${sendReason} rollback=${delReason}`,
        outboxAttempt,
      );
      return;
    }
    throw err;
  }

  await sql`
    UPDATE notification_deliveries
    SET external_message_id = ${messageId}, sent_at = NOW()
    WHERE id = ${deliveryId}
  `;

  logger.log(
    `connection_lost email sent for business ${business.id} (queued=${queuedCount})`,
  );

  await markOutboxCompleted(outboxId, outboxAttempt);
}
