import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
import { markOutboxCompleted } from '../../src/lib/shared/outbox';
import { sendInternalEmail } from '../../src/lib/notifications/email';
import type { NotifyAdminExceptionPayload } from '../../src/lib/shared/worker-types';
import { escapeHtml } from '../../src/lib/shared/html';

const LOG_PREFIX = '[AdminExceptionWorker]';

export async function handleAdminException(
  job: Job<NotifyAdminExceptionPayload>,
): Promise<void> {
  const { review_exception_id, business_id } = job.data;
  const outboxId = (job.data as unknown as { outbox_id?: string }).outbox_id ?? job.id!;

  // Read exception with review + business info
  const [exception] = await sql<{
    id: string;
    type: string;
    status: string;
    payload: Record<string, unknown> | string;
    reviewer_name: string;
    star_rating: number;
    review_text: string | null;
    business_name: string;
  }[]>`
    SELECT re.id, re.type, re.status, re.payload,
           r.reviewer_name, r.star_rating, r.review_text,
           b.name AS business_name
    FROM review_exceptions re
    JOIN reviews r ON re.review_id = r.id
    JOIN businesses b ON re.business_id = b.id
    WHERE re.id = ${review_exception_id}
  `;

  if (!exception) {
    console.warn(`${LOG_PREFIX} Exception ${review_exception_id} not found`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // Already resolved — another worker got there first
  if (exception.status !== 'open') {
    console.log(`${LOG_PREFIX} Exception ${review_exception_id} already ${exception.status}`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // JSONB parsing guard (PgBouncer may return string)
  const payload = typeof exception.payload === 'string'
    ? JSON.parse(exception.payload) as Record<string, unknown>
    : exception.payload;

  const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (!adminEmail) {
    console.error(`${LOG_PREFIX} ADMIN_NOTIFICATION_EMAIL not set — cannot send alert`);
    await markOutboxCompleted(outboxId);
    return;
  }

  const bodyHtml = `
    <h2>Review Exception: ${escapeHtml(exception.business_name)}</h2>
    <p><strong>Type:</strong> ${escapeHtml(exception.type)}</p>
    <p><strong>Reviewer:</strong> ${escapeHtml(exception.reviewer_name)} (${'★'.repeat(exception.star_rating)}${'☆'.repeat(5 - exception.star_rating)})</p>
    <p><strong>Current review text:</strong></p>
    <blockquote style="border-left:3px solid #ccc;padding:8px 12px;margin:8px 0;color:#555;">
      ${exception.review_text ? escapeHtml(exception.review_text) : '<em>No text</em>'}
    </blockquote>
    <p><strong>What happened:</strong> The reviewer edited their review after a response was already posted. The response may no longer be appropriate for the updated review.</p>
    <p><strong>Response status at time of edit:</strong> ${escapeHtml(String(payload.response_status ?? 'unknown'))}</p>
    <p><strong>Action needed:</strong> Review the situation and decide whether to regenerate a new response, dismiss the exception, or handle it manually.</p>
  `;

  try {
    await sendInternalEmail({
      to: adminEmail,
      subject: `Review exception: ${exception.business_name} — ${exception.type}`,
      bodyHtml,
    });
  } catch (err) {
    // Throw for BullMQ retry
    console.error(`${LOG_PREFIX} Failed to send alert for exception ${review_exception_id}: ${err instanceof Error ? err.message : err}`);
    throw err;
  }

  await markOutboxCompleted(outboxId);
  console.log(`${LOG_PREFIX} Alert sent for exception ${review_exception_id} (${exception.type})`);
}
