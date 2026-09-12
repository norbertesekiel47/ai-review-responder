import { v7 as uuidv7 } from 'uuid';
import type postgres from 'postgres';
import { QUEUE_NAMES } from './queue-names';
import {
  GENERATE_RESPONSE_ORIGIN_LANES,
  type AgentTurnPayload,
  type AutonomyAdminAlertPayload,
  type AutonomySuspendedNoticePayload,
  type AutonomySuspensionEvidence,
  type AutonomySuspensionTrigger,
  type GenerateResponseOriginLane,
  type AutoPostNoticePayload,
  type BuildSolicitationBatchPayload,
  type CsvIngestPayload,
  type EscalationNoticePayload,
  type GenerateResponsePayload,
  type GenerateSolicitationAsksPayload,
  type JudgeVerdictPayload,
  type PendingPostNoticePayload,
  type PublishResponsePayload,
  type SendNotificationPayload,
  type SolicitationAttributionPayload,
  type SolicitationSendPayload,
  type SolicitationVetoNoticePayload,
} from './worker-types';

type TxClient = postgres.TransactionSql;

const JOB_OUTBOX_STATUS_PENDING = 'pending';
const AGGREGATE_TYPE_REVIEW = 'review';
const AGGREGATE_TYPE_RESPONSE = 'response';
const AGGREGATE_TYPE_ESCALATION = 'escalation';
const AGGREGATE_TYPE_SUSPENSION_EVENT = 'suspension_event';
const AGGREGATE_TYPE_CONTACT_CSV_UPLOAD = 'contact_csv_upload';
const AGGREGATE_TYPE_SOLICITATION_BATCH = 'solicitation_batch';
const AGGREGATE_TYPE_SOLICITATION_OUTREACH = 'solicitation_outreach';
const AGGREGATE_TYPE_AGENT_TURN = 'agent_turn';
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
  /** NotificationFailoverPoller's re-queue marker. The wire payload has always
   *  carried this field; the helper simply could not express it, which is why
   *  the poller hand-wrote its own INSERT. Omitted by every first-delivery
   *  caller. */
  failover?: SendNotificationPayload['failover'];
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

export interface EnqueueJudgeVerdictInput {
  outboxId?: string;
  responseId: string;
  businessId: string;
  accountId: string;
  correlationId?: string;
}

export interface EnqueueAutonomySuspendedNoticeInput {
  outboxId?: string;
  accountId: string;
  suspensionEventId: string;
  trigger: AutonomySuspensionTrigger;
  correlationId?: string;
}

export interface EnqueueAutonomyAdminAlertInput {
  outboxId?: string;
  accountId: string;
  suspensionEventId: string;
  trigger: AutonomySuspensionTrigger;
  evidence: AutonomySuspensionEvidence;
}

export interface EnqueueCsvIngestInput {
  outboxId?: string;
  uploadId: string;
  businessId: string;
  correlationId?: string;
}

export interface EnqueueBuildSolicitationBatchInput {
  outboxId?: string;
  batchId: string;
  businessId: string;
  correlationId?: string;
}

export interface EnqueueGenerateSolicitationAsksInput {
  outboxId?: string;
  batchId: string;
  /** Tenant proof for the generation module's queries (invariant #8). */
  businessId: string;
  /** Present only for a single-ask regeneration (#629); omitted for the
   *  whole-batch generation the build transaction enqueues. */
  askId?: string;
  correlationId?: string;
}

export interface EnqueueSolicitationSendInput {
  outboxId?: string;
  /** The Outreach row this dispatch attempt sends. Also the `aggregate_id`. */
  outreachId: string;
  batchId: string;
  /** Tenant proof for the send worker's queries (invariant #8). */
  businessId: string;
  correlationId?: string;
}

export interface EnqueueSolicitationVetoNoticeInput {
  outboxId?: string;
  /** The Send batch parent that just auto-approved. Also the `aggregate_id`. */
  batchId: string;
  /** Tenant proof for the notice worker's queries (invariant #8). */
  businessId: string;
  correlationId?: string;
}

export interface EnqueueSolicitationAttributionInput {
  outboxId?: string;
  /** The newly ingested review to look back from. Also the `aggregate_id`. */
  reviewId: string;
  /** Tenant proof for the attribution module's queries (invariant #8). */
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
 * Enqueues post-hoc Judge work. The conflict predicate is byte-for-byte the
 * idx_jo_judge_verdict_inflight predicate from migration 076.
 */
export async function enqueueJudgeVerdict(
  tx: TxClient,
  input: EnqueueJudgeVerdictInput,
): Promise<string> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: JudgeVerdictPayload = {
    response_id: input.responseId,
    business_id: input.businessId,
    account_id: input.accountId,
  };
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.JUDGE_VERDICT},
      ${AGGREGATE_TYPE_RESPONSE},
      ${input.responseId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
    ON CONFLICT (topic, aggregate_id)
    WHERE topic = 'judge_verdict' -- topic-audit-ignore: partial-index inference needs a literal
      AND status IN ('pending', 'dispatching', 'dispatched')
    DO NOTHING
  `;
  return outboxId;
}

export interface EnqueueAgentTurnInput {
  turnId: string;
  accountId: string;
  conversationId: string;
  correlationId?: string;
  outboxId?: string;
}

/**
 * Enqueues one Owner Operator turn in the SAME transaction as the turn insert
 * (invariant #2).
 *
 * NO `ON CONFLICT`, deliberately. Every in-flight unique index on `job_outbox`
 * is pinned to one literal topic (004/018 for `sync_reviews`, plus 030, 091 and
 * 114), so there is no generic `(topic, aggregate_id)` partial index for a
 * conflict target to infer and a clause naming one would raise `42P10`.
 * Duplicate work is impossible anyway: the caller reaches this helper only when
 * its `agent_turns` INSERT actually created a row, and
 * `agent_turns_account_client_key_uniq` is what makes that decision. Same shape
 * as `enqueueCsvIngest`.
 */
export async function enqueueAgentTurn(
  tx: TxClient,
  input: EnqueueAgentTurnInput,
): Promise<string> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: AgentTurnPayload = {
    turn_id: input.turnId,
    account_id: input.accountId,
    conversation_id: input.conversationId,
  };
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.AGENT_TURN},
      ${AGGREGATE_TYPE_AGENT_TURN},
      ${input.turnId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
  `;
  return outboxId;
}

/**
 * Enqueues the owner safety notice in the same transaction as suspension.
 * The conflict predicate matches idx_jo_autonomy_suspended_notice_inflight.
 */
export async function enqueueAutonomySuspendedNotice(
  tx: TxClient,
  input: EnqueueAutonomySuspendedNoticeInput,
): Promise<string> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: AutonomySuspendedNoticePayload = {
    account_id: input.accountId,
    suspension_event_id: input.suspensionEventId,
    trigger: input.trigger,
  };
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.AUTONOMY_SUSPENDED_NOTICE},
      ${AGGREGATE_TYPE_SUSPENSION_EVENT},
      ${input.suspensionEventId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
    ON CONFLICT (topic, aggregate_id)
    WHERE topic = 'autonomy_suspended_notice' -- topic-audit-ignore: partial-index inference needs a literal
      AND status IN ('pending', 'dispatching', 'dispatched')
    DO NOTHING
  `;
  return outboxId;
}

/**
 * Enqueues the internal safety alert in the suspension transaction. The
 * conflict predicate matches idx_jo_autonomy_admin_alert_inflight.
 */
export async function enqueueAutonomyAdminAlert(
  tx: TxClient,
  input: EnqueueAutonomyAdminAlertInput,
): Promise<string> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: AutonomyAdminAlertPayload = {
    account_id: input.accountId,
    suspension_event_id: input.suspensionEventId,
    trigger: input.trigger,
    evidence: input.evidence,
  };

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.AUTONOMY_ADMIN_ALERT},
      ${AGGREGATE_TYPE_SUSPENSION_EVENT},
      ${input.suspensionEventId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
    ON CONFLICT (topic, aggregate_id)
    WHERE topic = 'autonomy_admin_alert' -- topic-audit-ignore: partial-index inference needs a literal
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
  if (input.failover !== undefined) {
    payload.failover = input.failover;
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
 * Enqueues the csv_ingest job in the SAME transaction that persists the
 * contact_csv_uploads row (invariant #2, #541 contract). `aggregate_id =
 * uploadId` IS the deterministic idempotency key: uploadId is a fresh
 * uuidv7 minted once per upload, so this helper is called exactly once per
 * aggregate — unlike publish_response/auto_post_notice (which guard against
 * re-triggering from multiple call sites via a migration-backed partial
 * unique index), there is no such index on job_outbox for this topic, so
 * this is a plain INSERT, mirroring enqueueSendNotification. Retried BullMQ
 * delivery of this same outbox row is handled by ingestContactsCsvUpload's
 * own terminal-state check + per-business advisory lock (Task 5), not by an
 * ON CONFLICT guard here. Wire payload is snake_case CsvIngestPayload
 * (worker-types.ts); this camelCase-input → snake_case-wire mapping is the
 * same shape every sibling enqueue helper uses.
 */
export async function enqueueCsvIngest(
  tx: TxClient,
  input: EnqueueCsvIngestInput,
): Promise<string> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: CsvIngestPayload = {
    upload_id: input.uploadId,
    business_id: input.businessId,
  };
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.CSV_INGEST},
      ${AGGREGATE_TYPE_CONTACT_CSV_UPLOAD},
      ${input.uploadId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
  `;
  return outboxId;
}

/**
 * Enqueues one build job for a newly-created unbuilt Solicitation batch.
 * The caller owns replay idempotency through the source-upload unique batch
 * insert and calls this helper only when that insert returns a row.
 */
export async function enqueueBuildSolicitationBatch(
  tx: TxClient,
  input: EnqueueBuildSolicitationBatchInput,
): Promise<string> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: BuildSolicitationBatchPayload = {
    batch_id: input.batchId,
    business_id: input.businessId,
  };
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.BUILD_SOLICITATION_BATCH},
      ${AGGREGATE_TYPE_SOLICITATION_BATCH},
      ${input.batchId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
  `;
  return outboxId;
}

/**
 * Enqueues ask generation for a built Solicitation batch — whole-batch when
 * `askId` is omitted (the build transaction, EXEC D21), single-ask
 * regeneration when present (#629's route). `aggregate_id = batchId` per the
 * migration 091 comment contract, and the ON CONFLICT predicate below is
 * spelled byte-for-byte against 091's partial unique index
 * `job_outbox_generate_solicitation_asks_inflight`.
 *
 * Returns the outbox id when a row was inserted, or `null` when an in-flight
 * generation row already exists for this batch — the atomic, exception-free
 * form of the "regeneration already in progress" contract
 * (`enqueueValidatePlaceId` is the dedup-variant precedent). The build-tx
 * caller treats `null` as fine (idempotent build retry); #629's route
 * surfaces it as 409.
 */
export async function enqueueGenerateSolicitationAsks(
  tx: TxClient,
  input: EnqueueGenerateSolicitationAsksInput,
): Promise<string | null> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: GenerateSolicitationAsksPayload = {
    batch_id: input.batchId,
    business_id: input.businessId,
  };
  if (input.askId !== undefined) {
    payload.ask_id = input.askId;
  }
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }

  const rows = await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.GENERATE_SOLICITATION_ASKS},
      ${AGGREGATE_TYPE_SOLICITATION_BATCH},
      ${input.batchId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
    ON CONFLICT (topic, aggregate_id)
    WHERE topic = 'generate_solicitation_asks' -- topic-audit-ignore: partial-index inference needs a literal
      AND status IN ('pending', 'dispatching', 'dispatched')
    DO NOTHING
    RETURNING id
  `;
  return rows.length > 0 ? outboxId : null;
}

/**
 * Enqueues ONE dispatch attempt for ONE Outreach row (#899's send worker is the
 * consumer, #900's release poller the producer). `aggregate_id` is the OUTREACH
 * id, not the batch id — migration 091 states the contract explicitly
 * ("generate_solicitation_asks stores the batch id in aggregate_id …
 * solicitation_send stores the outreach id"), because the Dispatch gate is
 * per-child and therefore per-contact. The ON CONFLICT predicate below is
 * spelled byte-for-byte against 091's partial unique index
 * `job_outbox_solicitation_send_inflight`; the in-flight status set is
 * re-spelled by hand — members AND order, per `job-outbox-status.ts` — because
 * a bind parameter inside an `ON CONFLICT … WHERE` defeats partial-index
 * inference.
 *
 * Returns the outbox id when a row was inserted, or `null` when an in-flight
 * send row already exists for this Outreach row. `null` rather than a throw is
 * amendment B10's shape and the `enqueueValidatePlaceId` /
 * `enqueueGenerateSolicitationAsks` precedent: the suppressed insert IS the
 * answer to "is an attempt already in flight", decided atomically by the index
 * inside the caller's transaction, with no exception to unwind a transaction
 * that has not done anything wrong. The caller decides what the answer means.
 *
 * This topic is the one place in the system where a duplicate outbox row means
 * a **duplicate email to a real customer**, not a wasted retry — which is why it
 * carries TWO guards, not one: this helper's `ON CONFLICT` against a concurrent
 * enqueue, and the caller's CAS on the Outreach row (`rendered` → `queued`)
 * against a re-release of a row that already moved. The release transaction
 * asserts rather than branches: a row whose CAS just succeeded cannot already
 * own an in-flight send job, so a `null` there is a bug and throws.
 */
export async function enqueueSolicitationSend(
  tx: TxClient,
  input: EnqueueSolicitationSendInput,
): Promise<string | null> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: SolicitationSendPayload = {
    batch_id: input.batchId,
    business_id: input.businessId,
    outreach_id: input.outreachId,
  };
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }

  const rows = await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.SOLICITATION_SEND},
      ${AGGREGATE_TYPE_SOLICITATION_OUTREACH},
      ${input.outreachId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
    ON CONFLICT (topic, aggregate_id)
    WHERE topic = 'solicitation_send' -- topic-audit-ignore: partial-index inference needs a literal
      AND status IN ('pending', 'dispatching', 'dispatched')
    DO NOTHING
    RETURNING id
  `;
  return rows.length > 0 ? outboxId : null;
}

/**
 * Enqueues the D9 Veto notice for an `auto_policy`-approved Solicitation
 * batch (#631). In-flight guard mirrors enqueuePendingPostNotice: the partial
 * unique index idx_jo_solicitation_veto_notice_inflight (migration 113) backs
 * the byte-for-byte ON CONFLICT below. Caller contract: enqueued in the SAME
 * tx as the auto approval (`autoApproveBatch`, outbox invariant #2); the
 * notice is the veto window's transparency half and must NEVER gate the
 * approval — a total notice failure fails CLOSED at release instead (no
 * anchored `veto_deadline_at` means the batch never releases, D9). Payload is
 * ids-only; the granted window lives on the `batch_approved` spine step.
 */
export async function enqueueSolicitationVetoNotice(
  tx: TxClient,
  input: EnqueueSolicitationVetoNoticeInput,
): Promise<string> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: SolicitationVetoNoticePayload = {
    batch_id: input.batchId,
    business_id: input.businessId,
  };
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }

  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.SOLICITATION_VETO_NOTICE},
      ${AGGREGATE_TYPE_SOLICITATION_BATCH},
      ${input.batchId},
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
    ON CONFLICT (topic, aggregate_id)
    WHERE topic = 'solicitation_veto_notice' -- topic-audit-ignore: partial-index inference needs a literal
      AND status IN ('pending', 'dispatching', 'dispatched')
    DO NOTHING
  `;
  return outboxId;
}

/**
 * Enqueue the #632 attribution lookback for ONE newly ingested review.
 *
 * The WHERE EXISTS guard is a deliberately COARSER SUPERSET of the matcher's
 * candidate predicate: it drops the anchor comparison and the bounce and
 * complaint arms, so every real candidate satisfies it. It skips only
 * businesses that have never sent an ask — which is every business while
 * SOLICITATION_SEND_ENABLED is off. Over-enqueueing is harmless: the handler
 * resolves no_candidates and exits. Do NOT tighten it into a second copy of
 * the candidate query — that would give one fact two owners.
 *
 * **It carries NO time bound, and must never grow one** (deviation D3). The
 * candidate window is ANCHOR-relative, not NOW()-relative: a review posted 13
 * days ago but detected today anchors 13 days back, which makes an ask sent 20
 * days ago a legitimate candidate. A sent_at > NOW() - 14 days guard is FALSE
 * for that row, so no job is ever enqueued and the match is lost silently.
 * Dropping the bound is what makes the superset claim provable — and it is also
 * why this file needs no window constant and therefore no domain import.
 *
 * The "not yet attributed" marker is attributed_at, NEVER attributed_review_id
 * (migration 114, round-1 finding A3). The FK nulls the review id when a review
 * is deleted; keying the guard on it would resurrect an already-attributed row
 * and keep enqueueing lookbacks for a business whose only ask is spent. All
 * FOUR sites — candidate query, this guard, the index predicate and the CAS —
 * agree on the timestamp.
 *
 * ON CONFLICT targets migration 114's partial unique index
 * job_outbox_solicitation_attribution_inflight, spelled byte-for-byte: without
 * a matching predicate Postgres infers no constraint and the INSERT throws
 * INSIDE the review-ingest transaction (deviation D5). The in-flight status set
 * is re-spelled by hand — members AND order, per job-outbox-status.ts — because
 * a bind parameter inside an ON CONFLICT ... WHERE defeats that inference.
 *
 * Returns the outbox id when a row was written, or `null` when the business has
 * never sent an ask or a lookback for this review is already in flight. `null`
 * rather than a throw follows enqueueSolicitationSend / enqueueValidatePlaceId:
 * the suppressed insert IS the answer, decided atomically inside the caller's
 * transaction, and a shadow metric must never be able to fail review ingest.
 */
export async function enqueueSolicitationAttribution(
  tx: TxClient,
  input: EnqueueSolicitationAttributionInput,
): Promise<string | null> {
  const outboxId = input.outboxId ?? uuidv7();
  const payload: SolicitationAttributionPayload = {
    review_id: input.reviewId,
    business_id: input.businessId,
  };
  if (input.correlationId !== undefined) {
    payload.correlation_id = input.correlationId;
  }

  const rows = await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    SELECT
      ${outboxId}::uuid,
      ${QUEUE_NAMES.SOLICITATION_ATTRIBUTION},
      ${AGGREGATE_TYPE_REVIEW},
      ${input.reviewId}::uuid,
      ${tx.json(payload as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    WHERE EXISTS (
      SELECT 1 FROM solicitation_outreach o
       WHERE o.business_id = ${input.businessId}::uuid
         AND o.delivery_status = 'sent'
         AND o.attributed_at IS NULL
    )
    ON CONFLICT (topic, aggregate_id)
    WHERE topic = 'solicitation_attribution' -- topic-audit-ignore: partial-index inference needs a literal
      AND status IN ('pending', 'dispatching', 'dispatched')
    DO NOTHING
    RETURNING id
  `;
  return rows.length > 0 ? outboxId : null;
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
 * Durably projects the canonical account subscription status onto the
 * deprecated businesses mirror after the canonical transaction commits. A
 * dedicated job keeps Stripe status writers out of the publisher's
 * business -> entitlement lock edge while guaranteeing eventual convergence.
 */
export async function enqueueStripeSubscriptionMirrorSync(
  tx: TxClient,
  accountId: string,
): Promise<string> {
  const outboxId = uuidv7();
  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (
      ${outboxId},
      ${QUEUE_NAMES.STRIPE_SUBSCRIPTION_MIRROR_SYNC},
      'account',
      ${accountId}::uuid,
      ${tx.json({ account_id: accountId } as never)},
      ${JOB_OUTBOX_STATUS_PENDING}
    )
  `;
  return outboxId;
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
