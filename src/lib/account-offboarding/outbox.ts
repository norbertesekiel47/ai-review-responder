/**
 * Account-offboarding transactional-outbox enqueue cluster.
 *
 * Every function takes the caller's transaction (`tx`) as its first parameter —
 * the state change and the `job_outbox` row are written in ONE Postgres tx, per
 * the transactional-outbox invariant. This module is "born injected": it holds
 * ZERO runtime import of `@/lib/db/server` (JSONB binds go through the injected
 * client's `tx.json(...)`, byte-identical to the `jsonb()` helper), so it is not
 * a db-imports baseline entry. (Modularity A+ campaign, PR 2h-T1.)
 */
import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type postgres from 'postgres';
import { QUEUE_NAMES } from '@/lib/shared/queue-names';
import type {
  AccountOffboardingBillingSchedulePayload,
  AccountOffboardingEmailPayload,
  AccountOffboardingPurgePayload,
  AccountOffboardingReactivationPayload,
  AccountOffboardingTeardownPayload,
} from '@/lib/shared/worker-types';

type TxClient = postgres.TransactionSql;

const JOB_OUTBOX_STATUS_PENDING = 'pending';
export const AGGREGATE_TYPE_ACCOUNT_OFFBOARDING = 'account_offboarding';

const ACCOUNT_OFFBOARDING_EMAIL_OUTBOX_NAMESPACE = 'repworth:account-offboarding-email-outbox:v1';
const ACCOUNT_OFFBOARDING_REACTIVATION_OUTBOX_NAMESPACE = 'repworth:account-offboarding-reactivation-outbox:v1';

type AccountOffboardingTopic =
  (typeof QUEUE_NAMES)[Extract<keyof typeof QUEUE_NAMES, `ACCOUNT_OFFBOARDING_${string}`>];

/**
 * Whether each offboarding topic is a lifecycle STAGE: work the offboarding
 * waits on, so a `failed` row that no handler marked leaves it stranded
 * (`checkStrandedAccountOffboardings`, #1413). Typed over every
 * `ACCOUNT_OFFBOARDING_*` queue name, so a new offboarding topic fails
 * typecheck here until it is classified (#1395). That is complete only while
 * this module keeps every offboarding enqueue under that prefix — all five
 * inserts below do; a topic enqueued under another name escapes it.
 *
 * - `email`: every email type is a notice, so a lost one stops nothing.
 *   Several (`cancel_only_confirmation`, `delete_data_purge_reminder`) run
 *   while the offboarding is legitimately non-terminal.
 * - `reactivation`: a failed reversal leaves the offboarding on its scheduled
 *   path, which still proceeds; a stale claim is released by
 *   `AccountOffboardingReactivationResetPoller`.
 */
const OFFBOARDING_TOPIC_IS_STAGE = {
  [QUEUE_NAMES.ACCOUNT_OFFBOARDING_BILLING_SCHEDULE]: true,
  [QUEUE_NAMES.ACCOUNT_OFFBOARDING_TEARDOWN]: true,
  [QUEUE_NAMES.ACCOUNT_OFFBOARDING_PURGE]: true,
  [QUEUE_NAMES.ACCOUNT_OFFBOARDING_EMAIL]: false,
  [QUEUE_NAMES.ACCOUNT_OFFBOARDING_REACTIVATION]: false,
} as const satisfies Record<AccountOffboardingTopic, boolean>;

/**
 * The offboarding topics whose failure can strand an offboarding, derived from
 * `OFFBOARDING_TOPIC_IS_STAGE` above (read its comment for why each topic is
 * in or out). Bound by `checkStrandedAccountOffboardings`.
 */
export const OFFBOARDING_STAGE_TOPICS: readonly AccountOffboardingTopic[] = (
  // Safe: `satisfies Record<AccountOffboardingTopic, boolean>` makes the keys
  // exactly that union, and `Object.keys` only widens them to `string`.
  Object.keys(OFFBOARDING_TOPIC_IS_STAGE) as AccountOffboardingTopic[]
).filter((topic) => OFFBOARDING_TOPIC_IS_STAGE[topic]);

export interface EnqueueAccountOffboardingInput {
  outboxId?: string;
  accountOffboardingId: string;
  accountId: string;
  idempotencyKeyHash: string;
  correlationId?: string;
}

export interface EnqueueAccountOffboardingEmailInput {
  outboxId?: string;
  accountOffboardingId: string;
  accountId: string;
  idempotencyKeyHash?: string;
  correlationId?: string;
  emailType?: AccountOffboardingEmailPayload['email_type'];
  // purge_receipt only: carried in the payload because the row is scrubbed by then.
  recipientEmail?: string;
  purgedAt?: string;
  // purge_receipt only: the aggregate retained-row count snapshotted by the
  // finalize transaction (#643 G5). A count, never a handle.
  retainedSuppressionCount?: number;
}

export interface EnqueueAccountOffboardingReactivationInput {
  outboxId?: string;
  accountOffboardingId: string;
  accountId: string;
  actorUserId: string;
  idempotencyKeyHash: string;
  requestId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string;
}

export interface EnqueueAccountOffboardingTeardownInput {
  outboxId?: string;
  accountOffboardingId: string;
  accountId: string;
  correlationId?: string;
}

export interface EnqueueAccountOffboardingPurgeInput {
  outboxId?: string;
  accountOffboardingId: string;
  accountId: string;
  correlationId?: string;
}

export async function enqueueAccountOffboardingBillingSchedule(
  tx: TxClient,
  input: EnqueueAccountOffboardingInput,
): Promise<string> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: AccountOffboardingBillingSchedulePayload = {
    account_offboarding_id: input.accountOffboardingId,
    account_id: input.accountId,
    idempotency_key_hash: input.idempotencyKeyHash,
  };
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.ACCOUNT_OFFBOARDING_BILLING_SCHEDULE},
      ${AGGREGATE_TYPE_ACCOUNT_OFFBOARDING},
      ${input.accountOffboardingId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
  `;
  return outboxId;
}

export async function enqueueAccountOffboardingEmail(
  tx: TxClient,
  input: EnqueueAccountOffboardingEmailInput,
): Promise<string> {
  const emailType = input.emailType ?? 'cancel_only_confirmation';
  const outboxId = input.outboxId ?? deterministicAccountOffboardingEmailOutboxId(
    input.accountOffboardingId,
    emailType,
  );
  const payload: AccountOffboardingEmailPayload = {
    account_offboarding_id: input.accountOffboardingId,
    account_id: input.accountId,
    email_type: emailType,
  };
  if (input.idempotencyKeyHash !== undefined) {
    payload.idempotency_key_hash = input.idempotencyKeyHash;
  }
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }
  if (input.recipientEmail !== undefined) {
    payload.recipient_email = input.recipientEmail;
  }
  if (input.purgedAt !== undefined) {
    payload.purged_at = input.purgedAt;
  }
  if (input.retainedSuppressionCount !== undefined) {
    payload.retained_suppression_count = input.retainedSuppressionCount;
  }

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.ACCOUNT_OFFBOARDING_EMAIL},
      ${AGGREGATE_TYPE_ACCOUNT_OFFBOARDING},
      ${input.accountOffboardingId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  return outboxId;
}

export async function enqueueAccountOffboardingReactivation(
  tx: TxClient,
  input: EnqueueAccountOffboardingReactivationInput,
): Promise<string> {
  const outboxId = input.outboxId ?? deterministicAccountOffboardingReactivationOutboxId(
    input.accountOffboardingId,
    input.idempotencyKeyHash,
  );
  const payload: AccountOffboardingReactivationPayload = {
    account_offboarding_id: input.accountOffboardingId,
    account_id: input.accountId,
    actor_user_id: input.actorUserId,
    idempotency_key_hash: input.idempotencyKeyHash,
  };
  if (input.requestId !== undefined) {
    payload.request_id = input.requestId;
  }
  if (input.ip !== undefined) {
    payload.ip = input.ip;
  }
  if (input.userAgent !== undefined) {
    payload.user_agent = input.userAgent;
  }
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.ACCOUNT_OFFBOARDING_REACTIVATION},
      ${AGGREGATE_TYPE_ACCOUNT_OFFBOARDING},
      ${input.accountOffboardingId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  return outboxId;
}

export async function enqueueAccountOffboardingTeardown(
  tx: TxClient,
  input: EnqueueAccountOffboardingTeardownInput,
): Promise<string> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: AccountOffboardingTeardownPayload = {
    account_offboarding_id: input.accountOffboardingId,
    account_id: input.accountId,
  };
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.ACCOUNT_OFFBOARDING_TEARDOWN},
      ${AGGREGATE_TYPE_ACCOUNT_OFFBOARDING},
      ${input.accountOffboardingId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
  `;
  return outboxId;
}

export async function enqueueAccountOffboardingPurge(
  tx: TxClient,
  input: EnqueueAccountOffboardingPurgeInput,
): Promise<string> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: AccountOffboardingPurgePayload = {
    account_offboarding_id: input.accountOffboardingId,
    account_id: input.accountId,
  };
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.ACCOUNT_OFFBOARDING_PURGE},
      ${AGGREGATE_TYPE_ACCOUNT_OFFBOARDING},
      ${input.accountOffboardingId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
  `;
  return outboxId;
}

/**
 * Deterministic, collision-resistant outbox id derived from a namespace + parts
 * (UUIDv5-shaped: SHA-256 of `namespace:part:part...`, version 0x5 / RFC-4122
 * variant). Same inputs always yield the same id, so it doubles as the outbox
 * idempotency key. Changing the namespace or the parts changes the id — never
 * reorder or alter them for an existing job type.
 */
function deterministicOutboxId(namespace: string, ...parts: string[]): string {
  const digest = createHash('sha256')
    .update([namespace, ...parts].join(':'))
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

function deterministicAccountOffboardingEmailOutboxId(
  accountOffboardingId: string,
  emailType: AccountOffboardingEmailPayload['email_type'],
): string {
  return deterministicOutboxId(
    ACCOUNT_OFFBOARDING_EMAIL_OUTBOX_NAMESPACE,
    accountOffboardingId,
    emailType,
  );
}

function deterministicAccountOffboardingReactivationOutboxId(
  accountOffboardingId: string,
  idempotencyKeyHash: string,
): string {
  return deterministicOutboxId(
    ACCOUNT_OFFBOARDING_REACTIVATION_OUTBOX_NAMESPACE,
    accountOffboardingId,
    idempotencyKeyHash,
  );
}
