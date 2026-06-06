import { createHash } from 'node:crypto';
import type { Job } from 'bullmq';
import { sql } from '../../../src/lib/db/server';
import {
  extractOutboxHandle,
  markOutboxCompleted,
  markOutboxFailed,
} from '../../../src/lib/shared/outbox';
import type { AccountOffboardingEmailPayload } from '../../../src/lib/shared/worker-types';
import {
  buildAccountOffboardingEmailHtml,
  sendInternalEmail,
} from '../../../src/lib/notifications/email';
import { createWorkerLogger } from '../../../src/lib/shared/logger';

const DELIVERY_ID_NAMESPACE = 'repworth:account-offboarding-email:v1';
const CANCEL_ONLY_CONFIRMATION_TEMPLATE = 'account_offboarding_cancel_only_confirmation';
const CANCEL_ONLY_REACTIVATION_CONFIRMATION_TEMPLATE =
  'account_offboarding_cancel_only_reactivation_confirmation';

interface AccountOffboardingEmailRow {
  id: string;
  account_id: string;
  mode: string;
  status: string;
  access_ends_at: Date | string | null;
  terminal_at: Date | string | null;
  recipient_email: string | null;
  location_ids: string[] | null;
}

export function accountOffboardingDeliveryId(
  accountOffboardingId: string,
  emailType: AccountOffboardingEmailPayload['email_type'],
): string {
  const digest = createHash('sha256')
    .update(`${DELIVERY_ID_NAMESPACE}:${accountOffboardingId}:${emailType}`)
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

export async function handleAccountOffboardingEmail(
  job: Job<AccountOffboardingEmailPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[AccountOffboardingEmailWorker]', job.data.correlation_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  const [offboarding] = await sql<AccountOffboardingEmailRow[]>`
    SELECT id, account_id, mode, status, access_ends_at, terminal_at, recipient_email, location_ids
    FROM account_offboardings
    WHERE id = ${job.data.account_offboarding_id}::uuid
      AND account_id = ${job.data.account_id}::uuid
  `;

  if (!offboarding) {
    await markOutboxFailed(outboxId, 'account_offboarding_not_found', outboxAttempt);
    return;
  }

  const validationError = validateEmailOffboarding(offboarding, job.data.email_type);
  if (validationError) {
    await markOutboxFailed(outboxId, validationError, outboxAttempt);
    return;
  }

  const recipient = offboarding.recipient_email!.trim();
  const businessId = offboarding.location_ids![0]!;
  const deliveryId = accountOffboardingDeliveryId(
    job.data.account_offboarding_id,
    job.data.email_type,
  );

  const claimed = await sql<{ id: string }[]>`
    INSERT INTO notification_deliveries
      (id, account_id, business_id, channel, recipient, template)
    VALUES
      (
        ${deliveryId}::uuid,
        ${job.data.account_id}::uuid,
        ${businessId}::uuid,
        'email',
        ${recipient},
        ${templateForEmailType(job.data.email_type)}
      )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;

  if (claimed.length === 0) {
    logger.log(`Dedup hit for account offboarding email ${deliveryId}`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  const bodyHtml = job.data.email_type === 'cancel_only_reactivation_confirmation'
    ? buildAccountOffboardingEmailHtml({
      emailType: job.data.email_type,
      accessEndsAt: offboarding.access_ends_at,
    })
    : buildAccountOffboardingEmailHtml({
      accessEndsAt: offboarding.access_ends_at,
    });

  let messageId: string;
  try {
    const result = await sendInternalEmail({
      to: recipient,
      subject: subjectForEmailType(job.data.email_type),
      bodyHtml,
      category: 'transactional',
    });
    messageId = result.messageId;
  } catch (err) {
    let rollbackError: unknown = null;
    try {
      await sql`
        DELETE FROM notification_deliveries
        WHERE id = ${deliveryId}::uuid
          AND external_message_id IS NULL
      `;
    } catch (deleteErr) {
      rollbackError = deleteErr;
    }

    if (rollbackError !== null) {
      const message = `send_failed_and_rollback_failed: send=${scrubErrorForStorage(errorMessage(err))} rollback=${scrubErrorForStorage(errorMessage(rollbackError))}`;
      logger.error(message);
      await markOutboxFailed(outboxId, message, outboxAttempt);
      return;
    }
    throw err;
  }

  await sql`
    UPDATE notification_deliveries
    SET external_message_id = ${messageId},
        sent_at = NOW()
    WHERE id = ${deliveryId}::uuid
  `;

  await markOutboxCompleted(outboxId, outboxAttempt);
}

function validateEmailOffboarding(
  row: AccountOffboardingEmailRow,
  emailType: AccountOffboardingEmailPayload['email_type'],
): string | null {
  if (
    emailType !== 'cancel_only_confirmation'
    && emailType !== 'cancel_only_reactivation_confirmation'
  ) {
    return `unknown_account_offboarding_email_type:${emailType}`;
  }
  if (row.mode !== 'cancel_only') return 'account_offboarding_mode_not_cancel_only';
  if (emailType === 'cancel_only_confirmation' && row.status !== 'scheduled') {
    return `account_offboarding_status_not_emailable:${row.status}`;
  }
  if (
    emailType === 'cancel_only_reactivation_confirmation'
    && row.status !== 'reactivated'
  ) {
    return `account_offboarding_status_not_reactivated:${row.status}`;
  }
  if (
    emailType === 'cancel_only_reactivation_confirmation'
    && !row.terminal_at
  ) {
    return 'account_offboarding_reactivation_not_terminal';
  }
  if (emailType === 'cancel_only_confirmation' && !row.access_ends_at) {
    return 'account_offboarding_missing_access_ends_at';
  }
  if (!row.recipient_email?.trim()) return 'account_offboarding_missing_recipient_email';
  if (!Array.isArray(row.location_ids) || row.location_ids.length === 0 || !row.location_ids[0]) {
    return 'account_offboarding_missing_location_id';
  }
  return null;
}

function templateForEmailType(
  emailType: AccountOffboardingEmailPayload['email_type'],
): string {
  return emailType === 'cancel_only_reactivation_confirmation'
    ? CANCEL_ONLY_REACTIVATION_CONFIRMATION_TEMPLATE
    : CANCEL_ONLY_CONFIRMATION_TEMPLATE;
}

function subjectForEmailType(
  emailType: AccountOffboardingEmailPayload['email_type'],
): string {
  return emailType === 'cancel_only_reactivation_confirmation'
    ? 'Your RepWorth subscription is active again'
    : 'Your RepWorth cancellation is scheduled';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function scrubErrorForStorage(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/Basic\s+[A-Za-z0-9+/]+=*/gi, 'Basic [REDACTED]')
    .replace(/(token|secret|api[_-]?key|password|authorization)=([^&\s"']+)/gi, '$1=[REDACTED]')
    .replace(/("(token|secret|api[_-]?key|password|authorization)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .slice(0, 500);
}
