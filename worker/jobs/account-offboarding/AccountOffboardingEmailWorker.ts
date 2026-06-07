import { createHash } from 'node:crypto';
import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
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
import {
  assertKeepMyDataTokenSecretConfigured,
  createKeepMyDataRawToken,
  hashAccountOffboardingToken,
} from '../../../src/lib/account-offboarding/tokens';

const DELIVERY_ID_NAMESPACE = 'repworth:account-offboarding-email:v1';
const CANCEL_ONLY_CONFIRMATION_TEMPLATE = 'account_offboarding_cancel_only_confirmation';
const CANCEL_ONLY_REACTIVATION_CONFIRMATION_TEMPLATE =
  'account_offboarding_cancel_only_reactivation_confirmation';
const DELETE_DATA_CONFIRMATION_TEMPLATE = 'account_offboarding_delete_data_confirmation';
const KEEP_MY_DATA_CONFIRMATION_TEMPLATE = 'account_offboarding_keep_my_data_confirmation';
const STALE_DELIVERY_CLAIM_MINUTES = 15;
const EMAIL_IDEMPOTENCY_NAMESPACE = 'repworth:account-offboarding-email-send:v1';

interface AccountOffboardingEmailRow {
  id: string;
  account_id: string;
  mode: string;
  status: string;
  access_ends_at: Date | string | null;
  purge_after: Date | string | null;
  purge_started_at: Date | string | null;
  purge_cancelled_at: Date | string | null;
  terminal_at: Date | string | null;
  recipient_email: string | null;
  location_ids: string[] | null;
}

interface KeepMyDataToken {
  id: string;
  rawToken: string;
  created: boolean;
}

type DeliveryClaimResult = 'claimed' | 'already_sent' | 'in_progress';

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
    SELECT id, account_id, mode, status, access_ends_at, purge_after, purge_started_at,
           purge_cancelled_at, terminal_at, recipient_email, location_ids
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
  if (job.data.email_type === 'delete_data_confirmation' && !process.env.NEXT_PUBLIC_APP_URL) {
    await markOutboxFailed(outboxId, 'NEXT_PUBLIC_APP_URL not configured', outboxAttempt);
    return;
  }
  if (job.data.email_type === 'delete_data_confirmation') {
    try {
      assertKeepMyDataTokenSecretConfigured();
    } catch {
      await markOutboxFailed(outboxId, 'SESSION_COOKIE_SECRET not configured', outboxAttempt);
      return;
    }
  }

  const recipient = offboarding.recipient_email!.trim();
  const businessId = offboarding.location_ids![0]!;
  const deliveryId = accountOffboardingDeliveryId(
    job.data.account_offboarding_id,
    job.data.email_type,
  );

  const claimResult = await claimDelivery({
    deliveryId,
    accountId: job.data.account_id,
    businessId,
    recipient,
    template: templateForEmailType(job.data.email_type),
  });

  if (claimResult === 'already_sent') {
    logger.log(`Dedup hit for sent account offboarding email ${deliveryId}`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }
  if (claimResult === 'in_progress') {
    throw new Error(`account_offboarding_email_claim_in_progress:${deliveryId}`);
  }

  let messageId: string;
  let keepMyDataToken: KeepMyDataToken | null = null;
  try {
    keepMyDataToken = job.data.email_type === 'delete_data_confirmation'
      ? await ensureKeepMyDataToken(offboarding, deliveryId)
      : null;
    const bodyHtml = buildBodyHtmlForEmailType(job.data.email_type, offboarding, keepMyDataToken);
    const result = await sendInternalEmail({
      to: recipient,
      subject: subjectForEmailType(job.data.email_type),
      bodyHtml,
      category: 'transactional',
      idempotencyKey: emailSendIdempotencyKey(deliveryId),
    });
    messageId = result.messageId;
  } catch (err) {
    let rollbackError: unknown = null;
    try {
      if (keepMyDataToken?.created) {
        await sql`
          DELETE FROM account_offboarding_tokens
          WHERE id = ${keepMyDataToken.id}::uuid
            AND consumed_at IS NULL
            AND revoked_at IS NULL
        `;
      }
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

async function claimDelivery(input: {
  deliveryId: string;
  accountId: string;
  businessId: string;
  recipient: string;
  template: string;
}): Promise<DeliveryClaimResult> {
  const claimed = await insertDeliveryClaim(input);
  if (claimed.length > 0) return 'claimed';

  const [existing] = await sql<{
    sent_at: Date | string | null;
    external_message_id: string | null;
  }[]>`
    SELECT sent_at, external_message_id
    FROM notification_deliveries
    WHERE id = ${input.deliveryId}::uuid
  `;
  if (existing?.sent_at || existing?.external_message_id) return 'already_sent';

  const reclaimed = await sql<{ id: string }[]>`
    DELETE FROM notification_deliveries
    WHERE id = ${input.deliveryId}::uuid
      AND sent_at IS NULL
      AND external_message_id IS NULL
      AND created_at < NOW() - (${STALE_DELIVERY_CLAIM_MINUTES} * INTERVAL '1 minute')
    RETURNING id
  `;
  if (reclaimed.length === 0) return 'in_progress';

  const retryClaimed = await insertDeliveryClaim(input);
  return retryClaimed.length > 0 ? 'claimed' : 'in_progress';
}

async function insertDeliveryClaim(input: {
  deliveryId: string;
  accountId: string;
  businessId: string;
  recipient: string;
  template: string;
}): Promise<Array<{ id: string }>> {
  return sql<{ id: string }[]>`
    INSERT INTO notification_deliveries
      (id, account_id, business_id, channel, recipient, template)
    VALUES
      (
        ${input.deliveryId}::uuid,
        ${input.accountId}::uuid,
        ${input.businessId}::uuid,
        'email',
        ${input.recipient},
        ${input.template}
      )
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  `;
}

function validateEmailOffboarding(
  row: AccountOffboardingEmailRow,
  emailType: AccountOffboardingEmailPayload['email_type'],
): string | null {
  if (
    emailType !== 'cancel_only_confirmation'
    && emailType !== 'cancel_only_reactivation_confirmation'
    && emailType !== 'delete_data_confirmation'
    && emailType !== 'keep_my_data_confirmation'
  ) {
    return `unknown_account_offboarding_email_type:${emailType}`;
  }
  if (emailType === 'keep_my_data_confirmation') {
    if (row.mode !== 'delete_data') return 'account_offboarding_mode_not_delete_data';
    if (!isEmailableKeepMyDataStatus(row.status)) {
      return `account_offboarding_status_not_keep_my_data_emailable:${row.status}`;
    }
    if (!row.purge_cancelled_at) return 'account_offboarding_missing_purge_cancelled_at';
    if (row.status === 'churned' && !row.terminal_at) {
      return 'account_offboarding_churned_not_terminal';
    }
    if (!row.recipient_email?.trim()) return 'account_offboarding_missing_recipient_email';
    if (!Array.isArray(row.location_ids) || row.location_ids.length === 0 || !row.location_ids[0]) {
      return 'account_offboarding_missing_location_id';
    }
    return null;
  }
  if (emailType === 'delete_data_confirmation') {
    if (row.mode !== 'delete_data') return 'account_offboarding_mode_not_delete_data';
    if (!isEmailableDeleteDataStatus(row.status)) {
      return `account_offboarding_status_not_delete_data_emailable:${row.status}`;
    }
    if (row.purge_started_at) return 'account_offboarding_purge_already_started';
    if (!row.purge_after) return 'account_offboarding_missing_purge_after';
    if (!row.recipient_email?.trim()) return 'account_offboarding_missing_recipient_email';
    if (!Array.isArray(row.location_ids) || row.location_ids.length === 0 || !row.location_ids[0]) {
      return 'account_offboarding_missing_location_id';
    }
    return null;
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

function isEmailableDeleteDataStatus(status: string): boolean {
  return status === 'pending' || status === 'tearing_down' || status === 'purge_scheduled';
}

function isEmailableKeepMyDataStatus(status: string): boolean {
  return status === 'pending'
    || status === 'tearing_down'
    || status === 'purge_scheduled'
    || status === 'churned';
}

async function ensureKeepMyDataToken(
  row: AccountOffboardingEmailRow,
  deliveryId: string,
): Promise<KeepMyDataToken> {
  if (!row.purge_after) {
    throw new Error('account_offboarding_missing_purge_after');
  }
  const rawToken = createKeepMyDataRawToken({
    accountOffboardingId: row.id,
    deliveryId,
  });
  const tokenHash = hashAccountOffboardingToken(rawToken);
  const tokenId = uuidv7();

  const inserted = await sql<{ id: string }[]>`
    INSERT INTO account_offboarding_tokens
      (id, account_offboarding_id, token_hash, token_type, expires_at)
    VALUES (
      ${tokenId}::uuid,
      ${row.id}::uuid,
      ${tokenHash},
      'keep_my_data',
      ${row.purge_after}
    )
    ON CONFLICT (token_hash) DO NOTHING
    RETURNING id
  `;
  if (inserted[0]) return { id: inserted[0].id, rawToken, created: true };

  const [existing] = await sql<{ id: string }[]>`
    SELECT id
    FROM account_offboarding_tokens
    WHERE token_hash = ${tokenHash}
      AND account_offboarding_id = ${row.id}::uuid
      AND token_type = 'keep_my_data'
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > NOW()
    LIMIT 1
  `;
  if (!existing) throw new Error('keep_my_data_token_conflict_unusable');

  return { id: existing.id, rawToken, created: false };
}

function buildBodyHtmlForEmailType(
  emailType: AccountOffboardingEmailPayload['email_type'],
  offboarding: AccountOffboardingEmailRow,
  keepMyDataToken: KeepMyDataToken | null,
): string {
  if (emailType === 'cancel_only_reactivation_confirmation') {
    return buildAccountOffboardingEmailHtml({
      emailType,
      accessEndsAt: offboarding.access_ends_at,
    });
  }
  if (emailType === 'delete_data_confirmation') {
    if (!keepMyDataToken) {
      throw new Error('missing_keep_my_data_token');
    }
    return buildAccountOffboardingEmailHtml({
      emailType,
      accessEndsAt: offboarding.access_ends_at,
      purgeAfter: offboarding.purge_after,
      keepMyDataUrl: buildKeepMyDataUrl(process.env.NEXT_PUBLIC_APP_URL!, keepMyDataToken.rawToken),
    });
  }
  if (emailType === 'keep_my_data_confirmation') {
    return buildAccountOffboardingEmailHtml({
      emailType,
      accessEndsAt: offboarding.access_ends_at,
    });
  }
  return buildAccountOffboardingEmailHtml({
    accessEndsAt: offboarding.access_ends_at,
  });
}

function buildKeepMyDataUrl(appUrl: string, rawToken: string): string {
  return `${appUrl.replace(/\/$/, '')}/api/account/offboarding/keep-my-data?token=${encodeURIComponent(rawToken)}`;
}

function emailSendIdempotencyKey(deliveryId: string): string {
  return `${EMAIL_IDEMPOTENCY_NAMESPACE}:${deliveryId}`;
}

function templateForEmailType(
  emailType: AccountOffboardingEmailPayload['email_type'],
): string {
  if (emailType === 'cancel_only_reactivation_confirmation') {
    return CANCEL_ONLY_REACTIVATION_CONFIRMATION_TEMPLATE;
  }
  if (emailType === 'delete_data_confirmation') {
    return DELETE_DATA_CONFIRMATION_TEMPLATE;
  }
  if (emailType === 'keep_my_data_confirmation') {
    return KEEP_MY_DATA_CONFIRMATION_TEMPLATE;
  }
  return CANCEL_ONLY_CONFIRMATION_TEMPLATE;
}

function subjectForEmailType(
  emailType: AccountOffboardingEmailPayload['email_type'],
): string {
  if (emailType === 'cancel_only_reactivation_confirmation') {
    return 'Your RepWorth subscription is active again';
  }
  if (emailType === 'delete_data_confirmation') {
    return 'Your RepWorth data deletion is scheduled';
  }
  if (emailType === 'keep_my_data_confirmation') {
    return 'Your RepWorth data will be kept';
  }
  return 'Your RepWorth cancellation is scheduled';
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
