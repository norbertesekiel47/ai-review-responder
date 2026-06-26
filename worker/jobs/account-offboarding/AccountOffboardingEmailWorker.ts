import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../../src/lib/db/server';
import {
  errorMessage,
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
import { getWorkerConfig } from '../../../src/lib/config/worker';
import {
  assertKeepMyDataTokenSecretConfigured,
  createKeepMyDataRawToken,
  hashAccountOffboardingToken,
} from '../../../src/lib/account-offboarding/tokens';
import {
  accountOffboardingDeliveryId,
  accountOffboardingEmailSendIdempotencyKey,
} from '../../../src/lib/account-offboarding/email-dedup';
import { scrubOffboardingErrorForStorage } from '../../../src/lib/account-offboarding/scrub-error';

const CANCEL_ONLY_CONFIRMATION_TEMPLATE = 'account_offboarding_cancel_only_confirmation';
const CANCEL_ONLY_ACCESS_END_TEMPLATE = 'account_offboarding_cancel_only_access_end';
const CANCEL_ONLY_REACTIVATION_CONFIRMATION_TEMPLATE =
  'account_offboarding_cancel_only_reactivation_confirmation';
const DELETE_DATA_CONFIRMATION_TEMPLATE = 'account_offboarding_delete_data_confirmation';
const DELETE_DATA_PURGE_REMINDER_TEMPLATE = 'account_offboarding_delete_data_purge_reminder';
const KEEP_MY_DATA_CONFIRMATION_TEMPLATE = 'account_offboarding_keep_my_data_confirmation';
const STALE_DELIVERY_CLAIM_MINUTES = 15;

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

/** Every email type except purge_receipt, which is row-less and forked at the top of the handler. */
type RowBackedEmailType = Exclude<AccountOffboardingEmailPayload['email_type'], 'purge_receipt'>;

const PURGE_RECEIPT_SUBJECT = 'Your RepWorth data has been deleted';

interface EmailTypeDescriptor {
  template: string;
  subject: string;
  /** Final lifecycle email for a terminal row — recipient_email is scrubbed after send (M3). */
  isTerminalRow: boolean;
  /** delete_data_confirmation mints + embeds a keep-my-data token; needs APP_URL + token secret. */
  needsKeepMyDataToken: boolean;
  /** Type-specific precondition checks. The shared recipient/location checks run after, once. */
  validate: (row: AccountOffboardingEmailRow) => string | null;
  buildBody: (row: AccountOffboardingEmailRow, token: KeepMyDataToken | null) => string;
}

/**
 * One authoritative descriptor per row-backed email type. Adding an email type is one
 * entry here, not edits across five parallel `email_type` switches; the exhaustive
 * Record makes a missing type a compile error.
 */
const EMAIL_DESCRIPTORS: Record<RowBackedEmailType, EmailTypeDescriptor> = {
  cancel_only_confirmation: {
    template: CANCEL_ONLY_CONFIRMATION_TEMPLATE,
    subject: 'Your RepWorth cancellation is scheduled',
    isTerminalRow: false,
    needsKeepMyDataToken: false,
    validate: (row) => {
      if (row.mode !== 'cancel_only') return 'account_offboarding_mode_not_cancel_only';
      if (row.status !== 'scheduled') return `account_offboarding_status_not_emailable:${row.status}`;
      if (!row.access_ends_at) return 'account_offboarding_missing_access_ends_at';
      return null;
    },
    buildBody: (row) => buildAccountOffboardingEmailHtml({ accessEndsAt: row.access_ends_at }),
  },
  cancel_only_access_end: {
    template: CANCEL_ONLY_ACCESS_END_TEMPLATE,
    subject: 'Your RepWorth subscription has ended',
    isTerminalRow: true,
    needsKeepMyDataToken: false,
    validate: (row) => {
      if (row.mode !== 'cancel_only') return 'account_offboarding_mode_not_cancel_only';
      if (row.status !== 'churned') {
        return `account_offboarding_status_not_access_end_emailable:${row.status}`;
      }
      if (!row.terminal_at) return 'account_offboarding_access_end_not_terminal';
      if (!row.access_ends_at) return 'account_offboarding_missing_access_ends_at';
      return null;
    },
    buildBody: (row) =>
      buildAccountOffboardingEmailHtml({
        emailType: 'cancel_only_access_end',
        accessEndsAt: row.access_ends_at,
      }),
  },
  cancel_only_reactivation_confirmation: {
    template: CANCEL_ONLY_REACTIVATION_CONFIRMATION_TEMPLATE,
    subject: 'Your RepWorth subscription is active again',
    isTerminalRow: true,
    needsKeepMyDataToken: false,
    validate: (row) => {
      if (row.mode !== 'cancel_only') return 'account_offboarding_mode_not_cancel_only';
      if (row.status !== 'reactivated') return `account_offboarding_status_not_reactivated:${row.status}`;
      if (!row.terminal_at) return 'account_offboarding_reactivation_not_terminal';
      return null;
    },
    buildBody: (row) =>
      buildAccountOffboardingEmailHtml({
        emailType: 'cancel_only_reactivation_confirmation',
        accessEndsAt: row.access_ends_at,
      }),
  },
  delete_data_confirmation: {
    template: DELETE_DATA_CONFIRMATION_TEMPLATE,
    subject: 'Your RepWorth data deletion is scheduled',
    isTerminalRow: false,
    needsKeepMyDataToken: true,
    validate: (row) => {
      if (row.mode !== 'delete_data') return 'account_offboarding_mode_not_delete_data';
      if (!isEmailableDeleteDataStatus(row.status)) {
        return `account_offboarding_status_not_delete_data_emailable:${row.status}`;
      }
      if (row.purge_started_at) return 'account_offboarding_purge_already_started';
      if (!row.purge_after) return 'account_offboarding_missing_purge_after';
      return null;
    },
    buildBody: (row, token) => {
      if (!token) throw new Error('missing_keep_my_data_token');
      return buildAccountOffboardingEmailHtml({
        emailType: 'delete_data_confirmation',
        accessEndsAt: row.access_ends_at,
        purgeAfter: row.purge_after,
        keepMyDataUrl: buildKeepMyDataUrl(getWorkerConfig().NEXT_PUBLIC_APP_URL!, token.rawToken),
      });
    },
  },
  delete_data_purge_reminder: {
    template: DELETE_DATA_PURGE_REMINDER_TEMPLATE,
    subject: 'Reminder: your RepWorth data will be deleted soon',
    isTerminalRow: false,
    needsKeepMyDataToken: false,
    validate: (row) => {
      if (row.mode !== 'delete_data') return 'account_offboarding_mode_not_delete_data';
      if (row.status !== 'purge_scheduled') {
        return `account_offboarding_status_not_purge_reminder_emailable:${row.status}`;
      }
      if (row.purge_started_at) return 'account_offboarding_purge_already_started';
      if (row.purge_cancelled_at) return 'account_offboarding_purge_already_cancelled';
      if (!row.purge_after) return 'account_offboarding_missing_purge_after';
      return null;
    },
    buildBody: (row) =>
      buildAccountOffboardingEmailHtml({
        emailType: 'delete_data_purge_reminder',
        accessEndsAt: row.access_ends_at,
        purgeAfter: row.purge_after,
      }),
  },
  keep_my_data_confirmation: {
    template: KEEP_MY_DATA_CONFIRMATION_TEMPLATE,
    subject: 'Your RepWorth data will be kept',
    isTerminalRow: true,
    needsKeepMyDataToken: false,
    validate: (row) => {
      if (row.mode !== 'delete_data') return 'account_offboarding_mode_not_delete_data';
      if (!isEmailableKeepMyDataStatus(row.status)) {
        return `account_offboarding_status_not_keep_my_data_emailable:${row.status}`;
      }
      if (!row.purge_cancelled_at) return 'account_offboarding_missing_purge_cancelled_at';
      if (row.status === 'churned' && !row.terminal_at) {
        return 'account_offboarding_churned_not_terminal';
      }
      return null;
    },
    buildBody: (row) =>
      buildAccountOffboardingEmailHtml({
        emailType: 'keep_my_data_confirmation',
        accessEndsAt: row.access_ends_at,
      }),
  },
};

// Final lifecycle email for a terminal row — recipient_email is nulled after send (M3).
const TERMINAL_ROW_EMAIL_TYPES: ReadonlySet<AccountOffboardingEmailPayload['email_type']> = new Set(
  (Object.keys(EMAIL_DESCRIPTORS) as RowBackedEmailType[]).filter(
    (type) => EMAIL_DESCRIPTORS[type].isTerminalRow,
  ),
);

export async function handleAccountOffboardingEmail(
  job: Job<AccountOffboardingEmailPayload>,
): Promise<void> {
  const logger = createWorkerLogger('[AccountOffboardingEmailWorker]', job.data.correlation_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);
  const emailType = job.data.email_type;

  // purge_receipt is sent AFTER the account row is scrubbed, so it carries its
  // recipient in the outbox payload and cannot use the row-backed dedup path.
  if (emailType === 'purge_receipt') {
    await handlePurgeReceipt(job, outboxId, outboxAttempt);
    return;
  }
  const descriptor = EMAIL_DESCRIPTORS[emailType];

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

  // M3: a terminal-row email nulls recipient_email after a successful send
  // (scrubRecipientAfterTerminalEmail). On a retry that lands after that scrub but
  // before the outbox was marked completed, re-validating the scrubbed row would
  // wrongly FAIL an already-delivered email. Dedup on the persisted send first. This
  // only queries when the row is already terminal AND scrubbed — i.e. exactly the
  // post-send retry — so the happy path adds no extra read.
  if (
    offboarding.terminal_at !== null
    && !offboarding.recipient_email?.trim()
    && descriptor.isTerminalRow
  ) {
    const sentDeliveryId = accountOffboardingDeliveryId(
      job.data.account_offboarding_id,
      emailType,
    );
    if (await offboardingEmailAlreadySent(sentDeliveryId, job.data.account_id)) {
      logger.log(`Dedup hit for already-sent terminal-row email ${sentDeliveryId}`);
      await markOutboxCompleted(outboxId, outboxAttempt);
      return;
    }
  }

  const validationError = validateEmailOffboarding(offboarding, emailType);
  if (validationError) {
    await markOutboxFailed(outboxId, validationError, outboxAttempt);
    return;
  }
  if (descriptor.needsKeepMyDataToken && !getWorkerConfig().NEXT_PUBLIC_APP_URL) {
    await markOutboxFailed(outboxId, 'NEXT_PUBLIC_APP_URL not configured', outboxAttempt);
    return;
  }
  if (descriptor.needsKeepMyDataToken) {
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
    emailType,
  );

  const claimResult = await claimDelivery({
    deliveryId,
    accountId: job.data.account_id,
    businessId,
    recipient,
    template: descriptor.template,
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
    keepMyDataToken = descriptor.needsKeepMyDataToken
      ? await ensureKeepMyDataToken(offboarding, deliveryId)
      : null;
    const bodyHtml = descriptor.buildBody(offboarding, keepMyDataToken);
    const result = await sendInternalEmail({
      to: recipient,
      subject: descriptor.subject,
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
          DELETE FROM account_offboarding_tokens t
          USING account_offboardings ao
          WHERE t.id = ${keepMyDataToken.id}::uuid
            AND t.account_offboarding_id = ao.id
            AND ao.account_id = ${offboarding.account_id}::uuid
            AND t.consumed_at IS NULL
            AND t.revoked_at IS NULL
        `;
      }
      await sql`
        DELETE FROM notification_deliveries
        WHERE id = ${deliveryId}::uuid
          AND account_id = ${offboarding.account_id}::uuid
          AND external_message_id IS NULL
      `;
    } catch (deleteErr) {
      rollbackError = deleteErr;
    }

    if (rollbackError !== null) {
      const message = `send_failed_and_rollback_failed: send=${scrubOffboardingErrorForStorage(errorMessage(err))} rollback=${scrubOffboardingErrorForStorage(errorMessage(rollbackError))}`;
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
      AND account_id = ${job.data.account_id}::uuid
  `;

  // Best-effort transient-PII cleanup AFTER the email is durably sent. A failure
  // here must not flip an already-completed send to failed (log-and-swallow).
  try {
    await scrubRecipientAfterTerminalEmail(job.data);
  } catch (err) {
    logger.error(
      `recipient scrub after terminal email failed: ${scrubOffboardingErrorForStorage(errorMessage(err))}`,
    );
  }

  await markOutboxCompleted(outboxId, outboxAttempt);
}

/**
 * M3: null the transient `recipient_email` once the final lifecycle email has been
 * delivered for a terminal row (cancel_only churned/reactivated, keep-my-data
 * churned). Guarded on `terminal_at` so a non-terminal keep-my-data row keeps the
 * recipient until teardown completes; the purge path scrubs it independently.
 */
async function scrubRecipientAfterTerminalEmail(
  payload: AccountOffboardingEmailPayload,
): Promise<void> {
  if (!TERMINAL_ROW_EMAIL_TYPES.has(payload.email_type)) return;
  await sql`
    UPDATE account_offboardings
    SET recipient_email = NULL,
        updated_at = NOW()
    WHERE id = ${payload.account_offboarding_id}::uuid
      AND account_id = ${payload.account_id}::uuid
      AND terminal_at IS NOT NULL
      AND recipient_email IS NOT NULL
  `;
}

async function handlePurgeReceipt(
  job: Job<AccountOffboardingEmailPayload>,
  outboxId: string,
  outboxAttempt: number | undefined,
): Promise<void> {
  const recipient = job.data.recipient_email?.trim();
  if (!recipient) {
    await markOutboxFailed(
      outboxId,
      'account_offboarding_purge_receipt_missing_recipient',
      outboxAttempt,
    );
    return;
  }

  const deliveryId = accountOffboardingDeliveryId(job.data.account_offboarding_id, 'purge_receipt');
  // Durability + dedup come from the outbox (at-least-once) plus the deterministic
  // Resend idempotency key — not notification_deliveries, whose account/business
  // FKs no longer exist after purge.
  await sendInternalEmail({
    to: recipient,
    subject: PURGE_RECEIPT_SUBJECT,
    bodyHtml: buildAccountOffboardingEmailHtml({
      emailType: 'purge_receipt',
      accessEndsAt: null,
      purgedAt: job.data.purged_at ?? null,
    }),
    category: 'transactional',
    idempotencyKey: emailSendIdempotencyKey(deliveryId),
  });

  // Complete the outbox AND scrub the recipient PII from its payload in ONE update.
  // The recipient is the only place the address survives after purge, so completion
  // and scrub must be atomic: otherwise a crash between them (or a failed best-effort
  // scrub) leaves a raw email in job_outbox past purged_at. If this update fails the
  // outbox stays 'dispatched' and the job retries — the Resend idempotency key makes
  // the re-send a no-op, and the payload is only cleared once the row is completed.
  await completePurgeReceiptOutbox(outboxId, outboxAttempt);
}

async function completePurgeReceiptOutbox(
  outboxId: string,
  attempt: number | undefined,
): Promise<void> {
  if (typeof attempt === 'number' && Number.isFinite(attempt)) {
    await sql`
      UPDATE job_outbox
      SET status = 'completed', completed_at = NOW(), payload = '{}'::jsonb
      WHERE id = ${outboxId}::uuid
        AND status = 'dispatched'
        AND attempts = ${attempt}
    `;
    return;
  }
  await sql`
    UPDATE job_outbox
    SET status = 'completed', completed_at = NOW(), payload = '{}'::jsonb
    WHERE id = ${outboxId}::uuid
      AND status = 'dispatched'
  `;
}

async function offboardingEmailAlreadySent(
  deliveryId: string,
  accountId: string,
): Promise<boolean> {
  const [existing] = await sql<{
    sent_at: Date | string | null;
    external_message_id: string | null;
  }[]>`
    SELECT sent_at, external_message_id
    FROM notification_deliveries
    WHERE id = ${deliveryId}::uuid
      AND account_id = ${accountId}::uuid
  `;
  return Boolean(existing?.sent_at || existing?.external_message_id);
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
      AND account_id = ${input.accountId}::uuid
  `;
  if (existing?.sent_at || existing?.external_message_id) return 'already_sent';

  const reclaimed = await sql<{ id: string }[]>`
    DELETE FROM notification_deliveries
    WHERE id = ${input.deliveryId}::uuid
      AND account_id = ${input.accountId}::uuid
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
  emailType: RowBackedEmailType,
): string | null {
  const typeError = EMAIL_DESCRIPTORS[emailType].validate(row);
  if (typeError) return typeError;
  // Shared tail: every row-backed email needs a recipient and a business id.
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
    SELECT t.id
    FROM account_offboarding_tokens t
    JOIN account_offboardings ao ON ao.id = t.account_offboarding_id
    WHERE t.token_hash = ${tokenHash}
      AND t.account_offboarding_id = ${row.id}::uuid
      AND ao.account_id = ${row.account_id}::uuid
      AND t.token_type = 'keep_my_data'
      AND t.consumed_at IS NULL
      AND t.revoked_at IS NULL
      AND t.expires_at > NOW()
    LIMIT 1
  `;
  if (!existing) throw new Error('keep_my_data_token_conflict_unusable');

  return { id: existing.id, rawToken, created: false };
}

function buildKeepMyDataUrl(appUrl: string, rawToken: string): string {
  return `${appUrl.replace(/\/$/, '')}/api/account/offboarding/keep-my-data?token=${encodeURIComponent(rawToken)}`;
}

function emailSendIdempotencyKey(deliveryId: string): string {
  return accountOffboardingEmailSendIdempotencyKey(deliveryId);
}

