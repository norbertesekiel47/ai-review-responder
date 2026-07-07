// src/lib/escalations/raise.ts
//
// WS3 Guardian escalation raise (spec §2.2). Called by persistTriage inside
// the triage-persist transaction, AFTER the reviews.triage_* UPDATE and the
// triage step, with the review row already locked FOR UPDATE (lock-ordering
// rule). All-or-nothing with the triage write: a failure here rolls the whole
// triage tx back and the generation job retries.
//
// Dedup: the INSERT's ON CONFLICT matches the partial unique index
// review_escalations_one_open_per_review (migration 073) byte-for-byte. A
// lost conflict (open escalation already exists) is a FULL no-op — no
// outcome, no step, no enqueue.

import { v7 as uuidv7 } from 'uuid';
import type { TransactionSql } from 'postgres';
import { recordOutcome, recordStep } from '@/lib/agents/run-spine';
import { enqueueEscalationNotice } from '@/lib/shared/job-outbox-helpers';
import {
  ESCALATING_ACTIONS,
  type TriageClassification,
  type TriageOutput,
} from '@/lib/reviews/triage-schema';
import { ESCALATION_STATUS } from './types';

// Widened readonly view of the taxonomy-owned tuple so `.includes` accepts
// any suggested_action value (the literal tuple's element type would reject
// non-escalating members at the call site).
const escalatingActions: ReadonlyArray<TriageOutput['suggested_action']> = ESCALATING_ACTIONS;

/** Trigger predicate (spec §2.1): source-agnostic — fallback rows escalate
 *  immediately; mock rows never reach here (mock always suggests 'respond'). */
export function shouldEscalate(classification: TriageClassification): boolean {
  return escalatingActions.includes(classification.output.suggested_action);
}

export interface RaiseEscalationInput {
  reviewId: string;
  businessId: string;
  accountId: string;
  /** The review's running review_handler run, or null for legacy reviews
   *  (outcome + step are skipped; the escalation row still persists). Only
   *  the id is consumed — account scope comes from accountId, single owner. */
  activeRun: { id: string } | null;
  classification: TriageClassification;
  correlationId?: string;
}

export interface RaiseEscalationResult {
  /** null ⇔ an open escalation already existed (nothing was raised). */
  escalationId: string | null;
}

export async function raiseEscalation(
  tx: TransactionSql,
  input: RaiseEscalationInput,
): Promise<RaiseEscalationResult> {
  const { output } = input.classification;
  const escalationId = uuidv7();

  const inserted = await tx<{ id: string }[]>`
    INSERT INTO review_escalations (
      id, account_id, business_id, review_id, agent_run_id, status,
      triage_severity, triage_source, triage_suggested_action, triage_issues
    ) VALUES (
      ${escalationId}, ${input.accountId}, ${input.businessId}, ${input.reviewId},
      ${input.activeRun?.id ?? null}, ${ESCALATION_STATUS.ESCALATED},
      ${output.severity}, ${input.classification.source},
      ${output.suggested_action}, ${output.issues}
    )
    ON CONFLICT (review_id)
    WHERE status <> 'resolved'
    DO NOTHING
    RETURNING id
  `;
  if (inserted.count === 0) {
    return { escalationId: null };
  }

  if (input.activeRun) {
    await recordOutcome(tx, {
      runId: input.activeRun.id,
      accountId: input.accountId,
      businessId: input.businessId,
      attributedAgent: 'guardian',
      outcomeKind: 'review_escalated',
    });
    await recordStep(tx, {
      runId: input.activeRun.id,
      stepKey: 'escalation_raised',
      detail: {
        severity: output.severity,
        suggested_action: output.suggested_action,
        source: input.classification.source,
        escalation_id: escalationId,
      },
    });
  }

  await enqueueEscalationNotice(tx, {
    escalationId,
    businessId: input.businessId,
    correlationId: input.correlationId,
  });

  return { escalationId };
}
