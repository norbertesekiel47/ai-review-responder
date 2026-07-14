import * as Sentry from '@sentry/node';
import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { getWorkerConfig } from '@/lib/config/worker';
import { sendInternalEmail } from '@/lib/notifications/email';
import { escapeHtml } from '@/lib/shared/html';
import { createWorkerLogger } from '@/lib/shared/logger';
import { extractOutboxHandle, markOutboxCompleted } from '@/lib/shared/outbox';
import type {
  AutonomyAdminAlertPayload,
  AutonomySuspensionEvidence,
} from '@/lib/shared/worker-types';

function renderEvidence(evidence: AutonomySuspensionEvidence): string {
  if ('verdict_id' in evidence) {
    return `<p><strong>Verdict ID:</strong> <code>${escapeHtml(evidence.verdict_id)}</code></p>`;
  }
  return `<ul>
    <li><strong>Rate:</strong> ${escapeHtml(String(evidence.rate))}</li>
    <li><strong>Numerator:</strong> ${escapeHtml(String(evidence.numer))}</li>
    <li><strong>Denominator:</strong> ${escapeHtml(String(evidence.denom))}</li>
    <li><strong>Window days:</strong> ${escapeHtml(String(evidence.windowDays))}</li>
  </ul>`;
}

/**
 * Sends the self-contained internal alert for an autonomy suspension. This
 * worker has no review anchor and takes no review-lane locks; the durable fact
 * already lives in account_audit_log and this job owns only notification +
 * outbox completion.
 */
export async function handleAutonomyAdminAlert(
  sql: Sql,
  job: Job<AutonomyAdminAlertPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[AutonomyAdminAlertWorker]', job.data.correlation_id);
  const { account_id, suspension_event_id, trigger, evidence } = job.data;
  const { outboxId, attempt } = extractOutboxHandle(job.data, job.id!);
  const adminEmail = getWorkerConfig().ADMIN_NOTIFICATION_EMAIL;

  let emailFailure: { error: unknown } | null = null;
  if (!adminEmail) {
    logger.error(
      `ADMIN_NOTIFICATION_EMAIL not set — cannot send autonomy alert event=${suspension_event_id}`,
    );
  } else {
    const bodyHtml = `<h2>Autonomy suspended</h2>
      <p><strong>Account ID:</strong> <code>${escapeHtml(account_id)}</code></p>
      <p><strong>Suspension event ID:</strong> <code>${escapeHtml(suspension_event_id)}</code></p>
      <p><strong>Trigger:</strong> <code>${escapeHtml(trigger)}</code></p>
      <h3>Evidence</h3>
      ${renderEvidence(evidence)}`;

    try {
      await sendInternalEmail({
        to: adminEmail,
        subject: `Autonomy suspended — ${trigger}`,
        bodyHtml,
        category: 'internal',
        idempotencyKey: `autonomy_admin_alert:${suspension_event_id}`,
      });
    } catch (error) {
      // Preserve the ORIGINAL primary error while still attempting the
      // independent Sentry redundancy signal below.
      logger.error(`autonomy_admin_alert email-failed event=${suspension_event_id}`);
      emailFailure = { error };
    }
  }

  // Best-effort independent paging route: attempt it even when email is unset
  // or failed. Its result never decides retry and can never mask emailFailure.
  try {
    Sentry.captureMessage('autonomy suspended', {
      level: 'warning',
      tags: { subsystem: 'autonomy_watchdog', trigger },
    });
  } catch {
    logger.warn(`autonomy_admin_alert sentry-failed event=${suspension_event_id}`);
  }

  if (emailFailure) throw emailFailure.error;

  await markOutboxCompleted(sql, outboxId, attempt);
  logger.log(
    `autonomy_admin_alert ${adminEmail ? 'sent' : 'email-unset'} event=${suspension_event_id} trigger=${trigger}`,
  );
}
