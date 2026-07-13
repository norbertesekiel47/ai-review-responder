import { v7 as uuidv7 } from 'uuid';
import type postgres from 'postgres';
import { QUEUE_NAMES } from './queue-names';
import {
  GENERATE_RESPONSE_ORIGIN_LANES,
  type GenerateResponseOriginLane,
  type AutoPostNoticePayload,
  type EscalationNoticePayload,
  type GenerateResponsePayload,
  type PendingPostNoticePayload,
  type PublishResponsePayload,
  type SendNotificationPayload,
} from './worker-types';

type TxClient = postgres.TransactionSql;

const JOB_OUTBOX_STATUS_PENDING = 'pending';
const AGGREGATE_TYPE_REVIEW = 'review';
const AGGREGATE_TYPE_RESPONSE = 'response';
const AGGREGATE_TYPE_ESCALATION = 'escalation';
const KNOWN_ORIGIN_LANES = new Set<string>(GENERATE_RESPONSE_ORIGIN_LANES);

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
  /** Veto-window delayed publish (WS4 spec §2.5): OutboxPoller claims only
   *  rows with available_at <= NOW(), so this single column IS the delay
   *  mechanism. Omitted → NOW() (immediate publish, every other caller).
   *  Pass a DB-clock-derived instant (e.g. the RETURNING'd
   *  auto_post_scheduled_at), never a Date computed from Date.now() —
   *  app-host clock skew would split the outbox window from the
   *  owner-visible deadline. */
  availableAt?: Date;
}

export interface EnqueueSendNotificationInput {
  outboxId?: string;
  responseId: string;
  businessId: string;
  correlationId?: string;
}

export interface EnqueueAutoPostNoticeInput {
  outboxId?: string;
  responseId: string;
  businessId: string;
  correlationId?: string;
}

export interface EnqueuePendingPostNoticeInput {
  outboxId?: string;
  responseId: string;
  businessId: string;
  correlationId?: string;
}

export interface EnqueueEscalationNoticeInput {
  outboxId?: string;
  escalationId: string;
  businessId: string;
  correlationId?: string;
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
      ${tx.json(payload as never)},
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
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status, available_at)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.PUBLISH_RESPONSE},
      ${AGGREGATE_TYPE_RESPONSE},
      ${input.responseId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING},
      COALESCE(${input.availableAt ?? null}, NOW())
    )
    ON CONFLICT (topic, aggregate_id)
    WHERE topic = 'publish_response' -- topic-audit-ignore: partial-index inference needs a literal
      AND status IN ('pending', 'dispatching', 'dispatched')
    DO NOTHING
  `;
  return outboxId;
}

/**
 * Enqueues the auto-approved "your response was posted" FYI. Mirrors
 * `enqueuePublishResponse`'s in-flight guard: a PARTIAL unique index on
 * `(topic, aggregate_id) WHERE topic='auto_post_notice' AND status IN
 * ('pending','dispatching','dispatched')` (migration 067) backs the
 * byte-for-byte `ON CONFLICT` predicate below — so a no-op/race retry of the
 * publisher cannot emit a second FYI while one is still in flight. The caller
 * (`markPostedAndMaybeEnqueueAutoPostNotice`) MUST only enqueue when the
 * posted-transition affected exactly one row, AND only for
 * `approval_method='auto_policy'`. snake_case payload matches the worker reads.
 */
export async function enqueueAutoPostNotice(
  tx: TxClient,
  input: EnqueueAutoPostNoticeInput,
): Promise<string> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: AutoPostNoticePayload = {
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
      ${QUEUE_NAMES.AUTO_POST_NOTICE},
      ${AGGREGATE_TYPE_RESPONSE},
      ${input.responseId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
    ON CONFLICT (topic, aggregate_id)
    WHERE topic = 'auto_post_notice' -- topic-audit-ignore: partial-index inference needs a literal
      AND status IN ('pending', 'dispatching', 'dispatched')
    DO NOTHING
  `;
  return outboxId;
}

/**
 * Enqueues the veto-window "your reply will post automatically" notice (WS4
 * spec §2.7). In-flight guard mirrors enqueueAutoPostNotice: the partial
 * unique index idx_jo_pending_post_notice_inflight (migration 074) backs the
 * byte-for-byte ON CONFLICT below. Caller contract: enqueued in the SAME tx
 * as the auto-approval transition (persist.ts's auto-approve branch, outbox
 * invariant #2); the notice is best-effort transparency and must NEVER gate
 * the publish — its outbox row is independent of the delayed publish row, and
 * a total notice failure still lets the reply post at the deadline. Payload
 * is ids-only; the deadline lives on responses.auto_post_scheduled_at.
 */
export async function enqueuePendingPostNotice(
  tx: TxClient,
  input: EnqueuePendingPostNoticeInput,
): Promise<string> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: PendingPostNoticePayload = {
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
      ${QUEUE_NAMES.PENDING_POST_NOTICE},
      ${AGGREGATE_TYPE_RESPONSE},
      ${input.responseId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
    ON CONFLICT (topic, aggregate_id)
    WHERE topic = 'pending_post_notice' -- topic-audit-ignore: partial-index inference needs a literal
      AND status IN ('pending', 'dispatching', 'dispatched')
    DO NOTHING
  `;
  return outboxId;
}

/**
 * Enqueues the Guardian escalation notice (WS3). In-flight guard mirrors
 * enqueueAutoPostNotice: partial unique index idx_jo_escalation_notice_inflight
 * (migration 073) backs the byte-for-byte ON CONFLICT below. The caller
 * (raiseEscalation) only enqueues when the escalation INSERT affected a row,
 * so this guard is defense-in-depth against replays.
 */
export async function enqueueEscalationNotice(
  tx: TxClient,
  input: EnqueueEscalationNoticeInput,
): Promise<string> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: EscalationNoticePayload = {
    escalation_id: input.escalationId,
    business_id: input.businessId,
  };
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.ESCALATION_NOTICE},
      ${AGGREGATE_TYPE_ESCALATION},
      ${input.escalationId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
    ON CONFLICT (topic, aggregate_id)
    WHERE topic = 'escalation_notice' -- topic-audit-ignore: partial-index inference needs a literal
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
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
  `;
  return outboxId;
}

/**
 * Enqueue an UpdateStripeOverageWorker recompute for the account. Single owner
 * of this enqueue shape — used by location add/archive/reactivate, admin CSV
 * import, and the Stripe webhook recovery paths. The worker recomputes the
 * quantity from committed state, so a redundant enqueue is harmless
 * convergence. Takes the surrounding transaction — like every enqueue helper
 * in this file, the TxClient parameter IS the transactional-outbox invariant
 * expressed as a type.
 */
export async function enqueueStripeOverageRecompute(
  tx: TxClient,
  accountId: string,
  correlationId?: string,
): Promise<void> {
  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${uuidv7()},
      ${QUEUE_NAMES.UPDATE_STRIPE_OVERAGE},
      'account',
      ${accountId}::uuid,
      ${tx.json({
        account_id: accountId,
        correlation_id: correlationId ?? uuidv7(),
      } as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
  `;
}

/**
 * Enqueue a validate_place_id job with in-flight dedup: if a pending /
 * dispatching / dispatched validate_place_id row already exists for this
 * business, the INSERT is a no-op. Single owner of that dedup rule — used by
 * the onboarding routes and addLocationTransaction (URL-mode adds).
 * Returns true when a row was inserted.
 */
export async function enqueueValidatePlaceId(
  tx: TxClient,
  input: { businessId: string; googleMapsUrl: string; correlationId?: string },
): Promise<boolean> {
  const payload: Record<string, unknown> = {
    business_id: input.businessId,
    google_maps_url: input.googleMapsUrl,
    correlation_id: input.correlationId ?? uuidv7(),
  };
  const rows = await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    SELECT ${uuidv7()}::uuid, ${QUEUE_NAMES.VALIDATE_PLACE_ID}, 'business', ${input.businessId}::uuid,
           ${tx.json(payload as never)}, 'pending'
    WHERE NOT EXISTS (
      SELECT 1 FROM job_outbox jo
      WHERE jo.aggregate_id = ${input.businessId}::uuid
        AND jo.topic = ${QUEUE_NAMES.VALIDATE_PLACE_ID}
        AND jo.status IN ('pending', 'dispatching', 'dispatched')
    )
    RETURNING id
  `;
  return rows.length > 0;
}
