import { randomUUID } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { writeRefusalEvent, type RefusalOccurredAt } from '@/lib/refusals/write';
import { OPERATOR_REFUSAL_RULES, type OperatorRefusalReason } from './refusals';
import type { Segment } from './schema';
import type { ClaimedTurn } from './turns';

interface CompleteOperatorRefusalsInput {
  /** Scope from the stored claimed turn, never a model-provided location. */
  turn: Pick<ClaimedTurn, 'accountId' | 'locationId'>;
  references: readonly Extract<Segment, { type: 'refusal_ref' }>[];
  /** Use transaction_time when completion stores NOW(), preserving PostgreSQL microseconds. */
  decidedAt: RefusalOccurredAt;
}

/**
 * Call only AFTER the caller wins the terminal turn fence, on that same
 * transaction. The returned subjects bind materializeReply to these decisions.
 * A ledger error propagates so the caller rolls back its entire completion.
 */
export async function completeOperatorRefusals(
  tx: TransactionSql,
  input: CompleteOperatorRefusalsInput,
): Promise<Partial<Record<OperatorRefusalReason, string>>> {
  const reasons = input.references.map((reference) => reference.reason);
  if (new Set(reasons).size !== reasons.length) {
    throw new Error('agents/operator: duplicate refusal_ref reason');
  }

  const refusalIds: Partial<Record<OperatorRefusalReason, string>> = {};
  for (const reason of reasons) {
    const rule = OPERATOR_REFUSAL_RULES[reason];
    const subjectId = randomUUID();
    const scope = rule.scope === 'location'
      ? { refusalSource: rule.source, businessId: input.turn.locationId }
      : { refusalSource: rule.source, businessId: null };
    await writeRefusalEvent(tx, {
      ...scope,
      accountId: input.turn.accountId,
      refusalCategory: rule.category,
      refusalCode: reason,
      allRefusalCodes: null,
      subjectType: 'operator_refusal',
      subjectId,
      occurredAt: input.decidedAt,
    });
    refusalIds[reason] = subjectId;
  }
  return refusalIds;
}
