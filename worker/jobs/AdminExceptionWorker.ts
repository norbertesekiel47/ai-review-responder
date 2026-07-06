import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
import { markOutboxCompleted, extractOutboxHandle } from '../../src/lib/shared/outbox';
import { getWorkerConfig } from '../../src/lib/config/worker';
import { sendInternalEmail } from '../../src/lib/notifications/email';
import type { NotifyAdminExceptionPayload } from '../../src/lib/shared/worker-types';
import { escapeHtml } from '../../src/lib/shared/html';
import { createWorkerLogger } from '../../src/lib/shared/logger';

interface ExceptionRow {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown> | string;
  review_id: string | null;
  reviewer_name: string | null;
  star_rating: number | null;
  review_text: string | null;
  business_name: string;
}

export function renderExceptionBody(
  exception: ExceptionRow,
  payload: Record<string, unknown>,
): string {
  const reviewerBlock = exception.review_id !== null
    ? `<p><strong>Reviewer:</strong> ${escapeHtml(exception.reviewer_name ?? 'Unknown reviewer')} ${exception.star_rating ? `(${'★'.repeat(exception.star_rating)}${'☆'.repeat(5 - exception.star_rating)})` : ''}</p>` +
      `<p><strong>Current review text:</strong></p>` +
      `<blockquote style="border-left:3px solid #ccc;padding:8px 12px;margin:8px 0;color:#555;">` +
      `${exception.review_text ? escapeHtml(exception.review_text) : '<em>No text</em>'}</blockquote>`
    : '<p><em>No local review record (this exception was opened before the review was ingested).</em></p>';

  const fmt = (v: unknown) => v == null ? '—' : escapeHtml(String(v));

  switch (exception.type) {
    case 'review_edited_after_post':
      return `${reviewerBlock}
        <p><strong>What happened:</strong> The reviewer edited their review after a response was already posted. The response may no longer be appropriate for the updated review.</p>
        <p><strong>Response status at time of edit:</strong> ${fmt(payload.response_status)}</p>
        <p><strong>Action needed:</strong> Review the situation and decide whether to regenerate a new response, dismiss the exception, or handle it manually.</p>`;

    case 'zernio_review_not_found':
      return `${reviewerBlock}
        <p><strong>What happened:</strong> Zernio sent a webhook for a review (id <code>${fmt(payload.provider_review_id)}</code>), but after retries the worker could not locate it via Zernio's listReviews API. The review may have been deleted at Zernio, or there may be eventual-consistency lag.</p>
        <p><strong>Zernio account / location:</strong> ${fmt(payload.zernio_account_id)} / ${fmt(payload.zernio_location_id)}</p>
        <p><strong>Retries exhausted at:</strong> ${fmt(payload.retries_exhausted_at)}</p>
        <p><strong>Action needed:</strong> Verify the review's current state in the customer's Google Business Profile. If it still exists, manual reconciliation may be needed; if deleted, dismiss the exception.</p>`;

    case 'zernio_permanent_4xx':
      return `${reviewerBlock}
        <p><strong>What happened:</strong> Posting the reply via Zernio failed with a permanent 4xx error. This is request-specific (likely malformed input or a Zernio config drift), not a connection issue.</p>
        <p><strong>Endpoint:</strong> ${fmt(payload.endpoint_kind)}</p>
        <p><strong>HTTP status:</strong> ${fmt(payload.http_status)}</p>
        <p><strong>Action needed:</strong> Inspect the error_body in the exception payload, fix the underlying issue, and either regenerate or dismiss.</p>`;

    case 'zernio_reply_verification_indeterminate':
      return `${reviewerBlock}
        <p><strong>What happened:</strong> Zernio rejected our reply with 409 reply_already_exists, but verification could not determine whether the existing reply is ours or external (after retries).</p>
        <p><strong>Reason:</strong> ${fmt(payload.reason)}</p>
        <p><strong>Zernio account / location / review:</strong> ${fmt(payload.zernio_account_id)} / ${fmt(payload.zernio_location_id)} / ${fmt(payload.zernio_review_id)}</p>
        ${payload.underlying_error ? `<p><strong>Underlying error:</strong> ${fmt(payload.underlying_error)}</p>` : ''}
        <p><strong>Action needed:</strong> Check the customer's Google Business Profile to see what reply (if any) is now visible on this review. If it's our text, mark the response posted manually; if it's external, dismiss as already-replied-external.</p>`;

    case 'zernio_unparseable_review_name':
      return `${reviewerBlock}
        <p><strong>What happened:</strong> Zernio's review.name field did not match the expected <code>accounts/{a}/locations/{l}/reviews/{r}</code> resource path. The ingest worker refused to process the review (fail-closed) because routing depends on extracting the location segment.</p>
        <p><strong>Affected review:</strong></p>
        <pre style="background:#f5f5f5;padding:8px;border-radius:4px;overflow:auto;">${escapeHtml(String(payload.review_name_truncated ?? '—'))}</pre>
        <p><strong>Zernio account / location:</strong> ${fmt(payload.zernio_account_id)} / ${fmt(payload.zernio_location_id)}</p>
        <p><strong>Action needed:</strong> Verify Zernio's API documentation for review.name shape changes. If Zernio's contract changed, update <code>extractLocationFromReviewName</code> and <code>REVIEW_NAME_RE</code> in <code>src/lib/reviews/zernio-normalize.ts</code> + <code>src/lib/zernio/parse-review-webhook.ts</code> to accept the new shape. Once fixed, re-enqueue affected ingest_zernio_review outbox rows. This is a cross-cutting Zernio API contract change — investigate immediately.</p>`;

    default: {
      const safeFields = Object.entries(payload)
        .flatMap(([k, v]) =>
          typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null
            ? [`<li><code>${escapeHtml(k)}</code>: ${fmt(v)}</li>`]
            : [],
        )
        .join('');
      return `${reviewerBlock}
        <p><strong>Exception type:</strong> <code>${escapeHtml(exception.type)}</code></p>
        <p>This exception type does not have a specific email template yet. Payload fields:</p>
        <ul>${safeFields}</ul>
        <p>See the admin dashboard for full payload + handling guidance.</p>`;
    }
  }
}

export async function handleAdminException(
  job: Job<NotifyAdminExceptionPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[AdminExceptionWorker]', job.data.correlation_id);
  const { review_exception_id } = job.data;
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // Read exception with review + business info
  const [exception] = await sql<ExceptionRow[]>`
    SELECT re.id, re.type, re.status, re.payload, re.review_id,
           r.reviewer_name, r.star_rating, r.review_text,
           b.name AS business_name
    FROM review_exceptions re
    LEFT JOIN reviews r ON re.review_id = r.id
    JOIN businesses b ON re.business_id = b.id
    WHERE re.id = ${review_exception_id}
  `;

  if (!exception) {
    logger.warn(`Exception ${review_exception_id} not found`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  // Already resolved — another worker got there first
  if (exception.status !== 'open') {
    logger.log(`Exception ${review_exception_id} already ${exception.status}`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  // JSONB parsing guard (PgBouncer may return string)
  const payload = typeof exception.payload === 'string'
    ? JSON.parse(exception.payload) as Record<string, unknown>
    : exception.payload;

  const adminEmail = getWorkerConfig().ADMIN_NOTIFICATION_EMAIL;
  if (!adminEmail) {
    logger.error(`ADMIN_NOTIFICATION_EMAIL not set — cannot send alert`);
    await markOutboxCompleted(sql, outboxId, outboxAttempt);
    return;
  }

  const bodyHtml = `
    <h2>Review Exception: ${escapeHtml(exception.business_name)}</h2>
    <p><strong>Type:</strong> ${escapeHtml(exception.type)}</p>
    ${renderExceptionBody(exception, payload)}
  `;

  try {
    await sendInternalEmail({
      to: adminEmail,
      subject: `Review exception: ${exception.business_name} — ${exception.type}`,
      bodyHtml,
      category: 'internal',
    });
  } catch (err) {
    // Throw for BullMQ retry
    logger.error(`Failed to send alert for exception ${review_exception_id}: ${err instanceof Error ? err.message : err}`);
    throw err;
  }

  await markOutboxCompleted(sql, outboxId, outboxAttempt);
  logger.log(`Alert sent for exception ${review_exception_id} (${exception.type})`);
}
