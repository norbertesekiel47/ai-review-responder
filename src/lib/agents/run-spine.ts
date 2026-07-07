// The agent run spine: the ONLY module that writes agent_runs /
// agent_run_steps / agent_outcomes (migration 071). Attribution data, not an
// execution engine (design doc 2026-07-01 §3.2).
//
// Contract: every writer takes a TxClient and MUST be called inside the same
// transaction as the pipeline state change it describes. A spine failure
// fails the job (BullMQ retries) — never a best-effort side log.
// `detail` carries ids/enums/counts only — NEVER raw review/response text.

import { v7 as uuidv7 } from 'uuid';
import type { TransactionSql } from 'postgres';

type TxClient = TransactionSql;

export const AGENT_PERSONAS = ['reply', 'guardian', 'insights', 'system'] as const;
export type AgentPersona = (typeof AGENT_PERSONAS)[number];

export const AGENT_RUN_KINDS = ['review_handler', 'weekly_insights'] as const;
export type AgentRunKind = (typeof AGENT_RUN_KINDS)[number];

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

export interface StartRunInput {
  kind: AgentRunKind;
  subjectType: 'review' | 'account_week';
  subjectId: string;
  accountId: string;
  businessId: string | null;
  correlationId?: string;
}

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
