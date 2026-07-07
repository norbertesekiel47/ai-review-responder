// src/lib/escalations/transitions.ts
//
// Owner-driven escalation state machine (WS3 spec §2.7): forward-only
// escalated → acknowledged → resolved, direct escalated → resolved stamps
// both timestamps. Repeating the SAME action is an idempotent no-op success;
// backward transitions are invalid (route maps to 409). Lock ordering: the
// review row FOR UPDATE is the tx's FIRST statement (run-spine contract) —
// serializes against persistTriage/raiseEscalation on the same review.

import type { Sql, TransactionSql } from 'postgres';
import { recordOutcome } from '@/lib/agents/run-spine';
import { ESCALATION_STATUS, type EscalationStatus } from './types';

export type EscalationTransitionResult =
  | { ok: true; status: EscalationStatus; noop: boolean }
  | { ok: false; code: 'not_found' | 'invalid_transition' };

export interface EscalationTransitionInput {
  escalationId: string;
  /** Owner's billing-parent scope (invariant #8) — never trusted from the client. */
  accountId: string;
}

interface LockedEscalationRow {
  id: string;
  status: EscalationStatus;
  account_id: string;
  business_id: string;
  review_id: string;
  agent_run_id: string | null;
}

async function lockScopedEscalation(
  tx: TransactionSql,
  input: EscalationTransitionInput,
): Promise<LockedEscalationRow | null> {
  const [row] = await tx<LockedEscalationRow[]>`
    SELECT id, status, account_id, business_id, review_id, agent_run_id
    FROM review_escalations
    WHERE id = ${input.escalationId} AND account_id = ${input.accountId}::uuid
    FOR UPDATE
  `;
  return row ?? null;
}

export async function acknowledgeEscalation(
  sql: Sql,
  input: EscalationTransitionInput,
): Promise<EscalationTransitionResult> {
  // Scope pre-check outside the tx so a wrong-tenant id never takes locks.
  const [pre] = await sql<{ review_id: string }[]>`
    SELECT review_id FROM review_escalations
    WHERE id = ${input.escalationId} AND account_id = ${input.accountId}::uuid
  `;
  if (!pre) return { ok: false, code: 'not_found' };

  return sql.begin(async (tx) => {
    await tx`SELECT id FROM reviews WHERE id = ${pre.review_id} FOR UPDATE`;
    const row = await lockScopedEscalation(tx, input);
    if (!row) return { ok: false, code: 'not_found' } as const;

    if (row.status === ESCALATION_STATUS.ACKNOWLEDGED) {
      return { ok: true, status: row.status, noop: true } as const;
    }
    if (row.status !== ESCALATION_STATUS.ESCALATED) {
      return { ok: false, code: 'invalid_transition' } as const;
    }

    await tx`
      UPDATE review_escalations
      SET status = ${ESCALATION_STATUS.ACKNOWLEDGED},
          acknowledged_at = NOW(),
          updated_at = NOW()
      WHERE id = ${row.id} AND account_id = ${input.accountId}::uuid
    `;
    return { ok: true, status: ESCALATION_STATUS.ACKNOWLEDGED, noop: false } as const;
  });
}

export async function resolveEscalation(
  sql: Sql,
  input: EscalationTransitionInput,
): Promise<EscalationTransitionResult> {
  const [pre] = await sql<{ review_id: string }[]>`
    SELECT review_id FROM review_escalations
    WHERE id = ${input.escalationId} AND account_id = ${input.accountId}::uuid
  `;
  if (!pre) return { ok: false, code: 'not_found' };

  return sql.begin(async (tx) => {
    await tx`SELECT id FROM reviews WHERE id = ${pre.review_id} FOR UPDATE`;
    const row = await lockScopedEscalation(tx, input);
    if (!row) return { ok: false, code: 'not_found' } as const;

    if (row.status === ESCALATION_STATUS.RESOLVED) {
      return { ok: true, status: row.status, noop: true } as const;
    }

    // Direct escalated → resolved stamps both timestamps (resolve implies
    // acknowledge — the state_timestamps CHECK makes anything else invalid).
    await tx`
      UPDATE review_escalations
      SET status = ${ESCALATION_STATUS.RESOLVED},
          acknowledged_at = COALESCE(acknowledged_at, NOW()),
          resolved_at = NOW(),
          updated_at = NOW()
      WHERE id = ${row.id} AND account_id = ${input.accountId}::uuid
    `;

    // Run-spine interplay (spec §2.6): the stored agent_run_id lets resolution
    // attribute to a run that may have COMPLETED long ago; recordOutcome does
    // not require a running run. NULL (legacy review / deleted run) → skip.
    if (row.agent_run_id !== null) {
      await recordOutcome(tx, {
        runId: row.agent_run_id,
        accountId: row.account_id,
        businessId: row.business_id,
        attributedAgent: 'guardian',
        outcomeKind: 'escalation_resolved',
      });
    }

    return { ok: true, status: ESCALATION_STATUS.RESOLVED, noop: false } as const;
  });
}
