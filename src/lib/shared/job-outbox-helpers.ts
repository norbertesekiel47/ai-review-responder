import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import type postgres from 'postgres';
import { jsonb } from '@/lib/db/server';
import { QUEUE_NAMES } from './queue-names';
import {
  GENERATE_RESPONSE_ORIGIN_LANES,
  type GenerateResponseOriginLane,
  type AccountOffboardingBillingSchedulePayload,
  type AccountOffboardingEmailPayload,
  type GenerateResponsePayload,
  type PublishResponsePayload,
  type SendNotificationPayload,
} from './worker-types';

type TxClient = postgres.TransactionSql;

const JOB_OUTBOX_STATUS_PENDING = 'pending';
const AGGREGATE_TYPE_REVIEW = 'review';
const AGGREGATE_TYPE_RESPONSE = 'response';
const AGGREGATE_TYPE_ACCOUNT_OFFBOARDING = 'account_offboarding';
const KNOWN_ORIGIN_LANES = new Set<string>(GENERATE_RESPONSE_ORIGIN_LANES);
const ACCOUNT_OFFBOARDING_EMAIL_OUTBOX_NAMESPACE = 'repworth:account-offboarding-email-outbox:v1';

export interface NormalizedGenerateResponsePayload {
  reviewId: string;
  businessId: string;
  version: number;
  suppressNotification: boolean;
  correlationId: string | undefined;
  originLane: GenerateResponseOriginLane | null;
  unknownOriginLane: string | undefined;
}

export interface EnqueueGenerateResponseInput {
  outboxId?: string;
  reviewId: string;
  businessId: string;
  version: number;
  originLane: GenerateResponseOriginLane;
  correlationId?: string;
  suppressNotification?: boolean;
}

export interface EnqueuePublishResponseInput {
  outboxId?: string;
  responseId: string;
  businessId: string;
  correlationId?: string;
}

export interface EnqueueSendNotificationInput {
  outboxId?: string;
  responseId: string;
  businessId: string;
  correlationId?: string;
}

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
}

function isRecord(data: unknown): data is Record<string, unknown> {
  return data !== null && typeof data === 'object' && !Array.isArray(data);
}

function requireStringField(
  payload: Record<string, unknown>,
  field: 'review_id' | 'business_id',
): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`generate_response payload requires ${field}`);
  }
  return value;
}

function requireVersion(payload: Record<string, unknown>): number {
  const value = payload.version;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error('generate_response payload requires version');
  }
  return value;
}

function sanitizeUnknownOriginLane(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64);
}

function normalizeOriginLane(value: unknown): {
  originLane: GenerateResponseOriginLane | null;
  unknownOriginLane: string | undefined;
} {
  if (typeof value !== 'string') {
    return { originLane: null, unknownOriginLane: undefined };
  }
  if (KNOWN_ORIGIN_LANES.has(value)) {
    return {
      originLane: value as GenerateResponseOriginLane,
      unknownOriginLane: undefined,
    };
  }
  return {
    originLane: null,
    unknownOriginLane: sanitizeUnknownOriginLane(value),
  };
}

export function normalizeGenerateResponsePayload(
  data: unknown,
): NormalizedGenerateResponsePayload {
  if (!isRecord(data)) {
    throw new Error('generate_response payload must be an object');
  }

  const { originLane, unknownOriginLane } = normalizeOriginLane(data.origin_lane);
  const correlationId = typeof data.correlation_id === 'string'
    ? data.correlation_id
    : undefined;

  return {
    reviewId: requireStringField(data, 'review_id'),
    businessId: requireStringField(data, 'business_id'),
    version: requireVersion(data),
    suppressNotification: data.suppress_notification === true,
    correlationId,
    originLane,
    unknownOriginLane,
  };
}

export async function enqueueGenerateResponse(
  tx: TxClient,
  input: EnqueueGenerateResponseInput,
): Promise<string> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: GenerateResponsePayload = {
    review_id: input.reviewId,
    business_id: input.businessId,
    version: input.version,
    origin_lane: input.originLane,
  };
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }
  if (input.suppressNotification === true) {
    payload.suppress_notification = true;
  }

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.GENERATE_RESPONSE},
      ${AGGREGATE_TYPE_REVIEW},
      ${input.reviewId},
      ${jsonb(payload)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
  `;
  return outboxId;
}

/**
 * Publish jobs preserve the in-flight outbox guard because retries can happen
 * after a row is already approved. Generate jobs intentionally do not add that
 * helper-level guard: generation idempotency is the durable `(review_id,
 * version)` response check in `loadGenerationContext`, before LLM spend.
 */
export async function enqueuePublishResponse(
  tx: TxClient,
  input: EnqueuePublishResponseInput,
): Promise<string> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: PublishResponsePayload = {
    response_id: input.responseId,
    business_id: input.businessId,
  };
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.PUBLISH_RESPONSE},
      ${AGGREGATE_TYPE_RESPONSE},
      ${input.responseId},
      ${jsonb(payload)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
    ON CONFLICT (topic, aggregate_id)
    WHERE topic = 'publish_response'
      AND status IN ('pending', 'dispatching', 'dispatched')
    DO NOTHING
  `;
  return outboxId;
}

/**
 * Enqueues the owner approval notification. Plain INSERT (no in-flight guard):
 * unlike publish, notification has no posted-state idempotency to protect, and
 * each call site already gates on a state-guarded transition before reaching
 * here (response persistence, downgrade, or admin owner-release).
 */
export async function enqueueSendNotification(
  tx: TxClient,
  input: EnqueueSendNotificationInput,
): Promise<string> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: SendNotificationPayload = {
    response_id: input.responseId,
    business_id: input.businessId,
  };
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.SEND_NOTIFICATION},
      ${AGGREGATE_TYPE_RESPONSE},
      ${input.responseId},
      ${jsonb(payload)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
  `;
  return outboxId;
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
      ${jsonb(payload)},
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

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.ACCOUNT_OFFBOARDING_EMAIL},
      ${AGGREGATE_TYPE_ACCOUNT_OFFBOARDING},
      ${input.accountOffboardingId},
      ${jsonb(payload)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  return outboxId;
}

function deterministicAccountOffboardingEmailOutboxId(
  accountOffboardingId: string,
  emailType: AccountOffboardingEmailPayload['email_type'],
): string {
  const digest = createHash('sha256')
    .update(`${ACCOUNT_OFFBOARDING_EMAIL_OUTBOX_NAMESPACE}:${accountOffboardingId}:${emailType}`)
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
