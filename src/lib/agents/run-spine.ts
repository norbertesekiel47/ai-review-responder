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

type TxClient = TransactionSql;

export const AGENT_PERSONAS = ['reply', 'guardian', 'insights', 'system'] as const;
export type AgentPersona = (typeof AGENT_PERSONAS)[number];

export const AGENT_RUN_KINDS = ['review_handler', 'weekly_insights'] as const;

export const AGENT_OUTCOME_KINDS = [
  'reply_drafted', 'reply_posted', 'reply_auto_posted',
  'reply_approved_no_edit', 'reply_edited_by_owner',
  'review_escalated', 'escalation_resolved', 'digest_sent',
] as const;
export type AgentOutcomeKind = (typeof AGENT_OUTCOME_KINDS)[number];

// The single authoritative step→persona attribution map (design doc §3.1:
// "an attributed_agent field on the step, not vibes"). WS2/WS3/WS5 extend it.
export const STEP_PERSONA = {
  review_ingested: 'system',
  review_updated: 'system',
  triage: 'guardian',
  draft_generated: 'reply',
  moderation_checked: 'system',
  policy_gate: 'reply',
  owner_notified: 'reply',
  reply_posted: 'reply',
} as const satisfies Record<string, AgentPersona>;

export type AgentStepKey = keyof typeof STEP_PERSONA;

export function personaForStep(stepKey: AgentStepKey): AgentPersona {
  return STEP_PERSONA[stepKey];
}

interface StartRunBase {
  subjectId: string;
  accountId: string;
  businessId: string | null;
  correlationId?: string;
}

// Discriminated on kind so the DB's agent_runs_kind_subject_type_pairing
// CHECK (migration 071) is unrepresentable to violate in TS: review_handler
// only pairs with a 'review' subject, weekly_insights with 'account_week'.
export type StartRunInput = StartRunBase &
  (
    | { kind: 'review_handler'; subjectType: 'review' }
    | { kind: 'weekly_insights'; subjectType: 'account_week' }
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
export async function startOrGetActiveRun(
  tx: TxClient,
  input: StartRunInput,
): Promise<StartRunResult> {
  const runId = uuidv7();
  const inserted = await tx<{ id: string }[]>`
    INSERT INTO agent_runs (
      id, account_id, business_id, kind, subject_type, subject_id,
      status, correlation_id
    ) VALUES (
      ${runId}, ${input.accountId}, ${input.businessId}, ${input.kind},
      ${input.subjectType}, ${input.subjectId}, 'running',
      ${input.correlationId ?? null}
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
 * Append a step to a run. Serializes concurrent appenders: the run row is
 * locked in its OWN statement, and only a subsequent statement — whose READ
 * COMMITTED snapshot is taken AFTER the lock wait, so it sees every committed
 * step — computes the next step_index (UNIQUE (agent_run_id, step_index) is
 * the backstop). A single lock+aggregate statement would snapshot before the
 * wait and hand two appenders the same index. Persona comes from
 * STEP_PERSONA — callers cannot mis-attribute a step.
 */
export async function recordStep(tx: TxClient, input: RecordStepInput): Promise<void> {
  const lock = await tx<{ ok: number }[]>`
    SELECT 1 AS ok FROM agent_runs WHERE id = ${input.runId} FOR UPDATE
  `;
  if (lock.count === 0) {
    throw new Error(`run-spine: run not found for recordStep(${input.runId}, ${input.stepKey})`);
  }

  const [row] = await tx<{ next_index: number }[]>`
    SELECT COALESCE(MAX(step_index), 0) + 1 AS next_index
    FROM agent_run_steps
    WHERE agent_run_id = ${input.runId}
  `;

  await tx`
    INSERT INTO agent_run_steps (
      id, agent_run_id, step_index, step_key, attributed_agent,
      status, detail, latency_ms
    ) VALUES (
      ${uuidv7()}, ${input.runId}, ${row!.next_index}, ${input.stepKey},
      ${personaForStep(input.stepKey)}, ${input.status ?? 'completed'},
      ${tx.json((input.detail ?? {}) as never)}, ${input.latencyMs ?? null}
    )
  `;
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
  attributedAgent: AgentPersona;
  outcomeKind: AgentOutcomeKind;
  unitCount?: number;
}

/**
 * Emit an outcome. Retry-safe: the ON CONFLICT clause matches the
 * agent_outcomes_once_per_run_kind partial unique index byte-for-byte
 * (migration 071), so a BullMQ retry after commit cannot double-emit.
 */
export async function recordOutcome(tx: TxClient, input: RecordOutcomeInput): Promise<void> {
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

/**
 * Terminal transition. Only 'running' runs transition (idempotent: a retry
 * that re-completes an already-terminal run is a no-op, matching the
 * agent_runs_terminal_consistency CHECK). A runId that matches NO run at all
 * throws — that is a caller bug, not a replay.
 */
export async function completeRun(
  tx: TxClient,
  runId: string,
  status: 'completed' | 'failed',
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
