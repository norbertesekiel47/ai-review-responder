import type { TransactionSql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeRefusalEvent } from '@/lib/refusals/write';
import { completeOperatorRefusals } from '../refusal-completion';
import type { OperatorRefusalReason } from '../refusals';

vi.mock('@/lib/refusals/write', () => ({ writeRefusalEvent: vi.fn() }));

const writeRefusal = vi.mocked(writeRefusalEvent);
const tx = {} as TransactionSql;
const turn = {
  accountId: '00000000-0000-4000-8000-000000000001',
  locationId: '00000000-0000-4000-8000-000000000002',
};
const decidedAt = new Date('2026-09-14T20:00:00.123Z');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function reference(reason: OperatorRefusalReason) {
  return { type: 'refusal_ref', reason } as const;
}

describe('winning-completion Operator refusal persistence', () => {
  beforeEach(() => {
    writeRefusal.mockReset();
    writeRefusal.mockResolvedValue(undefined);
  });

  it('gives two same-lane refusals distinct server subjects and returns their exact ledger identities', async () => {
    const refusalIds = await completeOperatorRefusals(tx, {
      turn, decidedAt,
      references: [reference('invented_business_fact'), reference('customer_data_exposure')],
    });

    expect(new Set(Object.keys(refusalIds))).toEqual(new Set(['invented_business_fact', 'customer_data_exposure']));
    expect(refusalIds.invented_business_fact).toMatch(uuidPattern);
    expect(refusalIds.customer_data_exposure).toMatch(uuidPattern);
    expect(refusalIds.invented_business_fact).not.toBe(refusalIds.customer_data_exposure);
    expect(writeRefusal).toHaveBeenCalledTimes(2);
    for (const [transaction, event] of writeRefusal.mock.calls) {
      expect(transaction).toBe(tx);
      expect(event.refusalSource).toBe('operator_content_refused');
      expect(event.subjectId).toBe(refusalIds[event.refusalCode as OperatorRefusalReason]);
      expect(event.occurredAt).toBe(decidedAt);
    }
  });

  it.each([
    ['invented_business_fact', 'operator_content_refused', turn.locationId],
    ['customer_data_exposure', 'operator_content_refused', turn.locationId],
    ['reviewer_disparagement', 'operator_content_refused', turn.locationId],
    ['review_incentive', 'operator_policy_refused', null],
    ['review_edit_pressure', 'operator_policy_refused', null],
    ['competitor_review_reply', 'operator_policy_refused', null],
  ] as const)('records %s with its closed ledger lane and authoritative scope', async (reason, source, businessId) => {
    const refusalIds = await completeOperatorRefusals(tx, {
      turn, decidedAt, references: [reference(reason)],
    });

    expect(writeRefusal).toHaveBeenCalledExactlyOnceWith(tx, {
      accountId: turn.accountId,
      businessId,
      refusalSource: source,
      refusalCategory: 'request_not_allowed',
      refusalCode: reason,
      allRefusalCodes: null,
      subjectType: 'operator_refusal',
      subjectId: refusalIds[reason],
      occurredAt: decidedAt,
    });
  });

  it('rejects duplicate references before recording even an earlier distinct reason', async () => {
    await expect(completeOperatorRefusals(tx, {
      turn, decidedAt,
      references: [reference('review_incentive'), reference('invented_business_fact'), reference('invented_business_fact')],
    })).rejects.toThrow('duplicate refusal_ref reason');
    expect(writeRefusal).not.toHaveBeenCalled();
  });

  it('does no ledger work when the validated reply has no refusals', async () => {
    await expect(completeOperatorRefusals(tx, { turn, decidedAt, references: [] })).resolves.toEqual({});
    expect(writeRefusal).not.toHaveBeenCalled();
  });

  it('propagates the original ledger failure and stops further writes so the caller can roll back', async () => {
    const failure = new Error('ledger write failed');
    writeRefusal.mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);

    await expect(completeOperatorRefusals(tx, {
      turn, decidedAt,
      references: [reference('review_incentive'), reference('review_edit_pressure'), reference('competitor_review_reply')],
    })).rejects.toBe(failure);
    expect(writeRefusal).toHaveBeenCalledTimes(2);
    // This is error propagation through a mocked writer, not a DB rollback proof.
  });

  it('mints fresh subjects for a later distinct completion with the same reason', async () => {
    const input = { turn, decidedAt, references: [reference('review_incentive')] };
    const first = await completeOperatorRefusals(tx, input);
    const second = await completeOperatorRefusals(tx, input);
    expect(first.review_incentive).not.toBe(second.review_incentive);
  });
});
