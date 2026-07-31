// The agent run spine: the ONLY module that writes agent_runs /
// agent_run_steps / agent_outcomes (migration 071). Attribution data, not an
// execution engine (design doc 2026-07-01 §3.2).
//
// Contract: every writer takes a TxClient and MUST be called inside the same
// transaction as the pipeline state change it describes. A spine failure
// fails the job (BullMQ retries) — never a best-effort side log.
// `detail` carries ids/enums/counts only — NEVER raw review/response text.
// Lock ordering: any transaction that locks an agent_runs row for a
// review-subject run (recordStep/completeRun) must hold that review's
// `reviews` row lock (FOR UPDATE) first — serializing at the review row
// makes the relative run/response lock order irrelevant. (The ingest path
// locks the review row at the top of processReview; other checkpoints must
// do the same before their first spine write.)
// "First" means before ANY statement that locks the review row, including the
// implicit FOR KEY SHARE taken by inserting/updating child rows that
// FK-reference it — take the review lock as the transaction's first statement.

import { v7 as uuidv7 } from 'uuid';
import type { TransactionSql } from 'postgres';
import type { WithholdReason } from '@/lib/solicitation/restraint-policy';

type TxClient = TransactionSql;

export const AGENT_PERSONAS = [
  'reply',
  'guardian',
  'insights',
  'solicitation',
  'system',
] as const;
export type AttributedAgentPersona = (typeof AGENT_PERSONAS)[number];
// The existing owner timeline does not expose Solicitation runs in T1.
// Ticket #544 widens that read-model/display contract with the batch UI.
export type AgentPersona = Exclude<AttributedAgentPersona, 'solicitation'>;

export const AGENT_RUN_KINDS = [
  'review_handler',
  'weekly_insights',
  'solicitation_batch',
  'solicitation_ask',
  'solicitation_send_batch',
] as const;

export const AGENT_OUTCOME_KINDS = [
  'reply_drafted', 'reply_posted', 'reply_auto_posted',
  'reply_approved_no_edit', 'reply_edited_by_owner', 'reply_vetoed_by_owner',
  'review_escalated', 'escalation_resolved', 'digest_sent',
  'solicitation_batch_built', 'solicitation_sent', 'review_attributed',
] as const;
export type AgentOutcomeKind = (typeof AGENT_OUTCOME_KINDS)[number];

// The single authoritative step→persona attribution map (design doc §3.1:
// "an attributed_agent field on the step, not vibes"). WS2/WS3/WS5 extend it.
export const STEP_PERSONA = {
  review_ingested: 'system',
  review_updated: 'system',
  triage: 'guardian',
  escalation_raised: 'guardian',
  escalation_sent: 'guardian',
  draft_generated: 'reply',
  moderation_checked: 'system',
  policy_gate: 'reply',
  owner_notified: 'reply',
  reply_posted: 'reply',
  digest_sent: 'insights',
  ask_evaluated: 'solicitation',
  batch_built: 'solicitation',
  ask_generated: 'solicitation',
  send_batch_closed: 'solicitation',
} as const satisfies Record<string, AttributedAgentPersona>;

export type AgentStepKey = keyof typeof STEP_PERSONA;

export function personaForStep(stepKey: AgentStepKey): AttributedAgentPersona {
  return STEP_PERSONA[stepKey];
}

interface StartRunBase {
  subjectId: string;
  accountId: string;
  businessId: string | null;
  correlationId?: string;
  parentRunId?: string;
}

// Discriminated on kind so the DB's agent_runs_kind_subject_type_pairing
// CHECK (migrations 071/088/091) is unrepresentable to violate in TS:
// review_handler only pairs with a 'review' subject, weekly_insights with
// 'account_week', and each Solicitation kind with its same-named subject type —
// except solicitation_send_batch, which is the send-lane sibling of the
// solicitation_batch build run and so shares its 'solicitation_batch' subject.
export type StartRunInput = StartRunBase &
  (
    | { kind: 'review_handler'; subjectType: 'review' }
    | { kind: 'weekly_insights'; subjectType: 'account_week' }
    | { kind: 'solicitation_batch'; subjectType: 'solicitation_batch' }
    | { kind: 'solicitation_ask'; subjectType: 'solicitation_ask' }
    | { kind: 'solicitation_send_batch'; subjectType: 'solicitation_batch' }
  );

export interface StartRunResult {
  runId: string;
  created: boolean;
}

/**
 * Start a run for a subject, or return the already-running one. Race-safe via
 * the agent_runs_one_active_per_subject partial unique index — the ON CONFLICT
 * clause below must match its predicate byte-for-byte (migration 071).
 */
async function startOrGetActiveRunInternal(
  tx: TxClient,
  input: StartRunInput,
): Promise<StartRunResult> {
  const runId = uuidv7();
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO agent_runs (
      id, account_id, business_id, kind, subject_type, subject_id,
      status, correlation_id, parent_run_id
    ) VALUES (
      ${runId}, ${input.accountId}, ${input.businessId}, ${input.kind},
      ${input.subjectType}, ${input.subjectId}, 'running',
      ${input.correlationId ?? null}, ${input.parentRunId ?? null}
    )
    ON CONFLICT (kind, subject_type, subject_id) WHERE status = 'running'
    DO NOTHING
    RETURNING id
  `;
  if (inserted.count > 0) {
    return { runId: inserted[0]!.id, created: true };
  }

  const [existing] = await tx<{ id: string }[]>`
    SELECT id FROM agent_runs
    WHERE kind = ${input.kind}
      AND subject_type = ${input.subjectType}
      AND subject_id = ${input.subjectId}
      AND status = 'running'
    FOR UPDATE
  `;
  if (!existing) {
    throw new Error(
      `run-spine: INSERT conflicted but no active run found for ${input.kind}/${input.subjectType}/${input.subjectId}`,
    );
  }
  return { runId: existing.id, created: false };
}

export async function startOrGetActiveRun(
  tx: TxClient,
  input: StartRunInput,
): Promise<StartRunResult> {
  return startOrGetActiveRunInternal(tx, input);
}

export interface StartSolicitationBatchRunInput {
  batchId: string;
  accountId: string;
  businessId: string;
  correlationId?: string;
}

/**
 * Start or reuse the parent attribution run for one Solicitation batch.
 * Domain callers cannot select an unrelated run/subject pairing through this
 * seam, while the generic writer remains available to the review pipelines.
 */
export async function startOrGetSolicitationBatchRun(
  tx: TxClient,
  input: StartSolicitationBatchRunInput,
): Promise<StartRunResult> {
  return startOrGetActiveRunInternal(tx, {
    kind: 'solicitation_batch',
    subjectType: 'solicitation_batch',
    subjectId: input.batchId,
    accountId: input.accountId,
    businessId: input.businessId,
    correlationId: input.correlationId,
  });
}

export interface StartSolicitationSendBatchRunInput {
  batchId: string;
  accountId: string;
  businessId: string;
  correlationId?: string;
}

/**
 * Start or reuse the send-lane parent run for one Solicitation batch (#628,
 * EXEC D3). Kind `solicitation_send_batch` shares the build parent's
 * `solicitation_batch` subject — the two are siblings on the same subject, and
 * `agent_runs_one_active_per_subject` keys on (kind, subject_type, subject_id),
 * so both can run at once without contention.
 */
export async function startOrGetSolicitationSendBatchRun(
  tx: TxClient,
  input: StartSolicitationSendBatchRunInput,
): Promise<StartRunResult> {
  return startOrGetActiveRunInternal(tx, {
    kind: 'solicitation_send_batch',
    subjectType: 'solicitation_batch',
    subjectId: input.batchId,
    accountId: input.accountId,
    businessId: input.businessId,
    correlationId: input.correlationId,
  });
}

export interface StartSolicitationAskRunInput {
  askId: string;
  accountId: string;
  businessId: string;
  parentRunId: string;
}

/**
 * Start or reuse the lazy child run for one Solicitation dispatch attempt.
 *
 * Unlike the generic writer, `businessId` and `parentRunId` are both REQUIRED
 * (G7): a send-mode child is always per-location and always has the send batch
 * parent above it, so the type refuses to express the orphan and the
 * account-wide child that the generic seam's optional fields would allow. A
 * child is created at release, never at build — the spine records work
 * performed, never work planned.
 */
export async function startOrGetSolicitationAskRun(
  tx: TxClient,
  input: StartSolicitationAskRunInput,
): Promise<StartRunResult> {
  return startOrGetActiveRunInternal(tx, {
    kind: 'solicitation_ask',
    subjectType: 'solicitation_ask',
    subjectId: input.askId,
    accountId: input.accountId,
    businessId: input.businessId,
    parentRunId: input.parentRunId,
  });
}

interface CompletedChildRunBase {
  runId: string;
  askId: string;
}

export type CompletedChildRunInput = CompletedChildRunBase &
  (
    | { decision: 'send'; withheldReason?: never }
    | { decision: 'withhold'; withheldReason: WithholdReason }
  );

export interface RecordCompletedChildRunsInput {
  accountId: string;
  businessId: string;
  parentRunId: string;
  children: readonly CompletedChildRunInput[];
}

/**
 * Set-based logical fan-out writer for already-decided Solicitation asks.
 * The caller writes the authoritative solicitation_asks rows first, then
 * calls this function in the same transaction and links those asks to the
 * supplied run ids. This seam writes only completed child runs and their one
 * ask_evaluated step; its inputs/detail are ids and closed enums, never PII.
 */
export async function recordCompletedChildRuns(
  tx: TxClient,
  input: RecordCompletedChildRunsInput,
): Promise<void> {
  if (input.children.length === 0) return;

  const runIds = input.children.map((child) => child.runId);
  const askIds = input.children.map((child) => child.askId);
  const decisions = input.children.map((child) => child.decision);
  const withheldReasons = input.children.map(
    (child) => child.decision === 'withhold' ? child.withheldReason : null,
  );

  const insertedRuns = await tx<{ id: string }[]>`
    INSERT INTO agent_runs (
      id, account_id, business_id, kind, subject_type, subject_id,
      status, parent_run_id, started_at, ended_at
    )
    SELECT
      child.run_id, ${input.accountId}, ${input.businessId},
      'solicitation_ask', 'solicitation_ask', child.ask_id,
      'completed', ${input.parentRunId}, NOW(), NOW()
    FROM unnest(
      ${runIds}::uuid[],
      ${askIds}::text[]
    ) AS child(run_id, ask_id)
    RETURNING id
  `;
  if (insertedRuns.count !== input.children.length) {
    throw new Error(
      `run-spine: expected ${input.children.length} completed child runs, inserted ${insertedRuns.count}`,
    );
  }

  const stepIds = input.children.map(() => uuidv7());
  const insertedSteps = await tx<{ id: string }[]>`
    INSERT INTO agent_run_steps (
      id, agent_run_id, step_index, step_key, attributed_agent,
      status, detail
    )
    SELECT
      child.step_id, child.run_id, 1, 'ask_evaluated', 'solicitation',
      'completed',
      jsonb_strip_nulls(jsonb_build_object(
        'ask_id', child.ask_id,
        'decision', child.decision,
        'withheld_reason', child.withheld_reason
      ))
    FROM unnest(
      ${stepIds}::uuid[],
      ${runIds}::uuid[],
      ${askIds}::text[],
      ${decisions}::text[],
      ${withheldReasons}::text[]
    ) AS child(step_id, run_id, ask_id, decision, withheld_reason)
    RETURNING id
  `;
  if (insertedSteps.count !== input.children.length) {
    throw new Error(
      `run-spine: expected ${input.children.length} ask_evaluated steps, inserted ${insertedSteps.count}`,
    );
  }
}

export interface RecordGenerationStepsInput {
  parentRunId: string;
  accountId: string;
  businessId: string;
  batchId: string;
}

/**
 * Bulk-write one `ask_generated` step on the send parent per NON-CANCELLED
 * `solicitation_outreach` row of the batch (#628, EXEC D3: steps on the
 * parent, no child fan-out; D17: no `cost_cents` — render cost lives in
 * `api_costs`).
 *
 * DATABASE-DERIVED on purpose: the step set comes from one `INSERT … SELECT`
 * over the persisted outreach rows, never from an in-memory children array —
 * a retried generation job that skipped already-persisted children still
 * records their steps. Cancelled rows are excluded because a superseded
 * attempt's replacement row carries the ask's current fact.
 *
 * NOT idempotent by itself: a second call appends a second step per row. The
 * generation finale runs it exactly once behind the outbox-ownership CAS,
 * which aborts a stale replay before any domain write.
 *
 * Locking follows `appendRunStep`: the parent run row is locked in its OWN
 * statement, and only a subsequent statement — whose READ COMMITTED snapshot
 * is taken after the lock wait — computes the base step_index (via the shared
 * `nextStepIndex`, the one owner of that query).
 *
 * Step ids are `gen_random_uuid()`, the one sanctioned departure from the
 * UUIDv7 PK convention (migration 046's "database fallback" carve-out): v7
 * cannot be generated inside a single set-based Postgres 16 statement, and
 * step ordering is owned by `step_index`, never by id.
 *
 * Returns the number of steps written.
 */
export async function recordGenerationSteps(
  tx: TxClient,
  input: RecordGenerationStepsInput,
): Promise<number> {
  const lock = await tx<{ ok: number }[]>`
    SELECT 1 AS ok FROM agent_runs
    WHERE id = ${input.parentRunId}
      AND account_id = ${input.accountId}::uuid
      AND business_id = ${input.businessId}::uuid
    FOR UPDATE
  `;
  if (lock.count === 0) {
    throw new Error(
      `run-spine: send parent run not found for recordGenerationSteps(${input.parentRunId})`,
    );
  }

  const baseIndex = (await nextStepIndex(tx, { runId: input.parentRunId })) - 1;
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO agent_run_steps (
      id, agent_run_id, step_index, step_key, attributed_agent, status, detail
    )
    SELECT
      gen_random_uuid(),
      ${input.parentRunId},
      ${baseIndex} + ROW_NUMBER() OVER (ORDER BY outreach.created_at, outreach.id),
      'ask_generated',
      ${personaForStep('ask_generated')},
      'completed',
      jsonb_strip_nulls(jsonb_build_object(
        'outreach_id', outreach.id,
        'ask_id', outreach.ask_id,
        'attempt_no', outreach.attempt_no,
        'delivery_status', outreach.delivery_status,
        'disposition_reason', outreach.disposition_reason
      ))
    FROM solicitation_outreach AS outreach
    WHERE outreach.batch_id = ${input.batchId}::uuid
      AND outreach.account_id = ${input.accountId}::uuid
      AND outreach.business_id = ${input.businessId}::uuid
      AND outreach.delivery_status <> 'cancelled'
    RETURNING id
  `;
  return inserted.count;
}

/**
 * Read-only lookup of the running review_handler run for a review, used by
 * pipeline checkpoints to attach steps/outcomes. Returns null for legacy
 * reviews ingested before the spine existed (callers skip spine writes).
 */
export async function findActiveReviewRun(
  tx: TxClient,
  reviewId: string,
): Promise<{ id: string; account_id: string } | null> {
  const [run] = await tx<{ id: string; account_id: string }[]>`
    SELECT id, account_id FROM agent_runs
    WHERE kind = 'review_handler'
      AND subject_type = 'review'
      AND subject_id = ${reviewId}
      AND status = 'running'
  `;
  return run ?? null;
}

export interface RecordStepInput {
  runId: string;
  stepKey: AgentStepKey;
  status?: 'completed' | 'failed' | 'skipped';
  /** ids/enums/counts ONLY — never raw review/response text. */
  detail?: Record<string, unknown>;
  latencyMs?: number;
}

/**
 * Next step_index for a run — the ONE owner of this query. Callers must
 * already hold the run's agent_runs row lock so the READ COMMITTED snapshot
 * here (taken after the lock wait) sees every committed step.
 */
async function nextStepIndex(
  tx: TxClient,
  input: { runId: string },
): Promise<number> {
  const [row] = await tx<{ next_index: number }[]>`
    SELECT COALESCE(MAX(step_index), 0) + 1 AS next_index
    FROM agent_run_steps
    WHERE agent_run_id = ${input.runId}
  `;
  return row?.next_index ?? 1;
}

/**
 * Append a step to a run. Serializes concurrent appenders: the run row is
 * locked in its OWN statement, and only a subsequent statement — whose READ
 * COMMITTED snapshot is taken AFTER the lock wait, so it sees every committed
 * step — computes the next step_index (UNIQUE (agent_run_id, step_index) is
 * the backstop). A single lock+aggregate statement would snapshot before the
 * wait and hand two appenders the same index. Persona comes from
 * STEP_PERSONA — callers cannot mis-attribute a step.
 */
async function appendRunStep(tx: TxClient, input: RecordStepInput): Promise<void> {
  const lock = await tx<{ ok: number }[]>`
    SELECT 1 AS ok FROM agent_runs WHERE id = ${input.runId} FOR UPDATE
  `;
  if (lock.count === 0) {
    throw new Error(`run-spine: run not found for recordStep(${input.runId}, ${input.stepKey})`);
  }

  const nextIndex = await nextStepIndex(tx, { runId: input.runId });

  await tx`
    INSERT INTO agent_run_steps (
      id, agent_run_id, step_index, step_key, attributed_agent,
      status, detail, latency_ms
    ) VALUES (
      ${uuidv7()}, ${input.runId}, ${nextIndex}, ${input.stepKey},
      ${personaForStep(input.stepKey)}, ${input.status ?? 'completed'},
      ${tx.json((input.detail ?? {}) as never)}, ${input.latencyMs ?? null}
    )
  `;
}

export async function recordStep(tx: TxClient, input: RecordStepInput): Promise<void> {
  await appendRunStep(tx, input);
}

export interface RecordOutcomeInput {
  /**
   * Always a real run id: a null agent_run_id would silently escape the
   * ON CONFLICT dedup (the partial index is WHERE agent_run_id IS NOT NULL).
   * The DB column stays nullable only for ON DELETE SET NULL orphaning of
   * historical outcomes; widen this type only when a genuinely run-less
   * outcome caller arrives.
   */
  runId: string;
  accountId: string;
  businessId: string | null;
  attributedAgent: AttributedAgentPersona;
  outcomeKind: AgentOutcomeKind;
  unitCount?: number;
}

/**
 * Emit an outcome. Retry-safe: the ON CONFLICT clause matches the
 * agent_outcomes_once_per_run_kind partial unique index byte-for-byte
 * (migration 071), so a BullMQ retry after commit cannot double-emit.
 */
async function emitRunOutcome(tx: TxClient, input: RecordOutcomeInput): Promise<void> {
  await tx`
    INSERT INTO agent_outcomes (
      id, account_id, business_id, agent_run_id, attributed_agent,
      outcome_kind, unit_count
    ) VALUES (
      ${uuidv7()}, ${input.accountId}, ${input.businessId}, ${input.runId},
      ${input.attributedAgent}, ${input.outcomeKind}, ${input.unitCount ?? 1}
    )
    ON CONFLICT (agent_run_id, outcome_kind) WHERE agent_run_id IS NOT NULL
    DO NOTHING
  `;
}

export async function recordOutcome(tx: TxClient, input: RecordOutcomeInput): Promise<void> {
  await emitRunOutcome(tx, input);
}

/**
 * Terminal transition. Only 'running' runs transition (idempotent: a retry
 * that re-completes an already-terminal run is a no-op, matching the
 * agent_runs_terminal_consistency CHECK). A runId that matches NO run at all
 * throws — that is a caller bug, not a replay.
 */
async function transitionRunToTerminal(
  tx: TxClient,
  runId: string,
  status: 'completed' | 'cancelled' | 'failed',
  error?: Record<string, unknown>,
): Promise<void> {
  const updated = await tx<{ id: string }[]>`
    UPDATE agent_runs
    SET status = ${status},
        ended_at = NOW(),
        error = ${error ? tx.json(error as never) : null}
    WHERE id = ${runId}
      AND status = 'running'
    RETURNING id
  `;
  if (updated.count > 0) {
    return;
  }

  const [existing] = await tx<{ status: string }[]>`
    SELECT status FROM agent_runs WHERE id = ${runId}
  `;
  if (!existing) {
    throw new Error(`run-spine: run not found for completeRun(${runId}, ${status})`);
  }
  // Row exists but is already terminal — a replayed completion is a no-op.
}

export async function completeRun(
  tx: TxClient,
  runId: string,
  status: 'completed' | 'cancelled' | 'failed',
  error?: Record<string, unknown>,
): Promise<void> {
  await transitionRunToTerminal(tx, runId, status, error);
}

export interface CompleteSolicitationBatchRunInput {
  runId: string;
  accountId: string;
  businessId: string;
  batchId: string;
  candidateCount: number;
  sendCount: number;
  withholdCount: number;
  withheldByReason: Readonly<Record<WithholdReason, number>>;
}

/**
 * Terminal attribution for one successfully built Solicitation batch.
 *
 * The caller supplies the transaction that also persists the authoritative
 * asks and batch built_at fact. This focused seam keeps the parent step,
 * outcome, and completion inseparable while accepting ids/enums/counts only.
 */
export async function completeSolicitationBatchRun(
  tx: TxClient,
  input: CompleteSolicitationBatchRunInput,
): Promise<void> {
  await appendRunStep(tx, {
    runId: input.runId,
    stepKey: 'batch_built',
    detail: {
      batch_id: input.batchId,
      candidate_count: input.candidateCount,
      send_count: input.sendCount,
      withhold_count: input.withholdCount,
      withheld_by_reason: input.withheldByReason,
    },
  });
  await emitRunOutcome(tx, {
    runId: input.runId,
    accountId: input.accountId,
    businessId: input.businessId,
    attributedAgent: 'solicitation',
    outcomeKind: 'solicitation_batch_built',
    unitCount: input.candidateCount,
  });
  await transitionRunToTerminal(tx, input.runId, 'completed');
}

export type SolicitationBatchRunFailure =
  | {
      code: 'gate_closed';
      gate:
        | 'flag_disabled'
        | 'subscription_inactive'
        | 'account_offboarding_blocked';
    }
  | {
      code: 'build_failed';
      errorClass: string;
    }
  // D14: every render for the batch failed or was withheld, so nothing is
  // releasable and the owner has nothing to approve. The two counts are the
  // only way to tell those causes apart afterwards — one disposition, two
  // very different operational stories.
  | {
      code: 'generation_failed';
      failedCount: number;
      withheldCount: number;
    };

export interface FailSolicitationBatchRunInput {
  runId: string;
  failure: SolicitationBatchRunFailure;
}

/** Closed union → the snake_case shape the agent_runs.error jsonb carries. */
function failureToError(
  failure: SolicitationBatchRunFailure,
): Record<string, unknown> {
  switch (failure.code) {
    case 'gate_closed':
      return failure;
    case 'build_failed':
      return { code: failure.code, error_class: failure.errorClass };
    case 'generation_failed':
      return {
        code: failure.code,
        failed_count: failure.failedCount,
        withheld_count: failure.withheldCount,
      };
  }
}

/**
 * Terminal attribution for an owned Solicitation parent that cannot finish.
 * The closed union prevents callers from turning this into a generic spine
 * escape hatch; values remain bounded gates or sanitized error-class names.
 */
export async function failSolicitationBatchRun(
  tx: TxClient,
  input: FailSolicitationBatchRunInput,
): Promise<void> {
  await transitionRunToTerminal(tx, input.runId, 'failed', failureToError(input.failure));
}
