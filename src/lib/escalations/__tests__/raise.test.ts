import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TriageClassification } from '@/lib/reviews/triage';

const { recordOutcomeMock, recordStepMock, enqueueMock } = vi.hoisted(() => ({
  recordOutcomeMock: vi.fn(),
  recordStepMock: vi.fn(),
  enqueueMock: vi.fn(),
}));
vi.mock('@/lib/agents/run-spine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/run-spine')>()),
  recordOutcome: recordOutcomeMock,
  recordStep: recordStepMock,
}));
vi.mock('@/lib/shared/job-outbox-helpers', () => ({
  enqueueEscalationNotice: enqueueMock,
}));

import { raiseEscalation, shouldEscalate } from '../raise';

function classification(
  action: 'respond' | 'escalate' | 'respond_and_escalate',
  source = 'llm_triage_v1',
): TriageClassification {
  return {
    output: { severity: 'high', issues: ['staff_conduct'], suggested_action: action },
    source: source as TriageClassification['source'],
    model: 'gpt-4o-mini-2024-07-18',
    latencyMs: 100,
  };
}

/** Tagged-template tx stub: FIFO of results for awaited statements. */
function makeTx(results: unknown[][]) {
  const queue = [...results];
  const calls: { text: string; values: unknown[] }[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?'), values });
    const rows = queue.shift() ?? [];
    return Promise.resolve(Object.assign(rows, { count: rows.length }));
  }) as never as import('postgres').TransactionSql;
  return { tx, calls };
}

const baseInput = {
  reviewId: 'rev-1',
  businessId: 'biz-1',
  accountId: 'acc-1',
  activeRun: { id: 'run-1', account_id: 'acc-1' },
  correlationId: 'corr-1',
};

beforeEach(() => {
  recordOutcomeMock.mockReset();
  recordStepMock.mockReset();
  enqueueMock.mockReset();
});

describe('shouldEscalate', () => {
  it('is true only for escalate / respond_and_escalate', () => {
    expect(shouldEscalate(classification('respond'))).toBe(false);
    expect(shouldEscalate(classification('escalate'))).toBe(true);
    expect(shouldEscalate(classification('respond_and_escalate'))).toBe(true);
  });
});

describe('raiseEscalation', () => {
  it('inserts, records outcome + step, and enqueues when the insert wins', async () => {
    const { tx, calls } = makeTx([[{ id: 'esc-1' }]]);
    const result = await raiseEscalation(tx, {
      ...baseInput,
      classification: classification('escalate'),
    });
    expect(result.escalationId).not.toBeNull();
    expect(calls[0]!.text).toContain('INSERT INTO review_escalations');
    expect(calls[0]!.text).toContain("ON CONFLICT (review_id)");
    expect(calls[0]!.text).toContain("WHERE status <> 'resolved'");
    expect(recordOutcomeMock).toHaveBeenCalledWith(tx, expect.objectContaining({
      runId: 'run-1',
      attributedAgent: 'guardian',
      outcomeKind: 'review_escalated',
    }));
    expect(recordStepMock).toHaveBeenCalledWith(tx, expect.objectContaining({
      runId: 'run-1',
      stepKey: 'escalation_raised',
      detail: expect.objectContaining({ severity: 'high', source: 'llm_triage_v1' }),
    }));
    expect(enqueueMock).toHaveBeenCalledWith(tx, expect.objectContaining({
      businessId: 'biz-1',
      correlationId: 'corr-1',
    }));
  });

  it('skips outcome + step (but still enqueues) for a legacy review with no active run', async () => {
    const { tx } = makeTx([[{ id: 'esc-1' }]]);
    const result = await raiseEscalation(tx, {
      ...baseInput,
      activeRun: null,
      classification: classification('respond_and_escalate'),
    });
    expect(result.escalationId).not.toBeNull();
    expect(recordOutcomeMock).not.toHaveBeenCalled();
    expect(recordStepMock).not.toHaveBeenCalled();
    expect(enqueueMock).toHaveBeenCalled();
  });

  it('is a full no-op when an open escalation already exists (ON CONFLICT lost)', async () => {
    const { tx } = makeTx([[]]);
    const result = await raiseEscalation(tx, {
      ...baseInput,
      classification: classification('escalate'),
    });
    expect(result.escalationId).toBeNull();
    expect(recordOutcomeMock).not.toHaveBeenCalled();
    expect(recordStepMock).not.toHaveBeenCalled();
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('never carries review text in the step detail', async () => {
    const { tx } = makeTx([[{ id: 'esc-1' }]]);
    await raiseEscalation(tx, { ...baseInput, classification: classification('escalate') });
    const detail = recordStepMock.mock.calls[0]![1].detail as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual(
      ['escalation_id', 'severity', 'source', 'suggested_action'].sort(),
    );
  });
});
