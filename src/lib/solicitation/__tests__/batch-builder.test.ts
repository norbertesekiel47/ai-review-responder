import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_DATA_ROWS } from '../contacts-csv';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult } =
  await vi.hoisted(async () => {
    const helpers = await import('../../../../worker/__tests__/helpers/mock-sql');
    return {
      ...helpers.createMockSql(),
      mkTaggedResult: helpers.mkTaggedResult,
    };
  });

const mocks = vi.hoisted(() => ({
  lockDispatchedOutboxAttemptIfOwned: vi.fn(),
  markOutboxCompletedIfOwned: vi.fn(),
  startOrGetActiveRun: vi.fn(),
  recordCompletedChildRuns: vi.fn(),
  recordStep: vi.fn(),
  recordOutcome: vi.fn(),
  completeRun: vi.fn(),
  solicitationWatchEnabled: vi.fn(),
}));

vi.mock('@/lib/shared/outbox', () => ({
  lockDispatchedOutboxAttemptIfOwned: mocks.lockDispatchedOutboxAttemptIfOwned,
  markOutboxCompletedIfOwned: mocks.markOutboxCompletedIfOwned,
}));
vi.mock('@/lib/agents/run-spine', () => ({
  startOrGetActiveRun: mocks.startOrGetActiveRun,
  recordCompletedChildRuns: mocks.recordCompletedChildRuns,
  recordStep: mocks.recordStep,
  recordOutcome: mocks.recordOutcome,
  completeRun: mocks.completeRun,
}));
vi.mock('../flags', () => ({
  solicitationWatchEnabled: mocks.solicitationWatchEnabled,
}));

import { buildSolicitationBatch } from '../batch-builder';

beforeEach(() => {
  resetMockSql();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.lockDispatchedOutboxAttemptIfOwned.mockResolvedValue(true);
  mocks.markOutboxCompletedIfOwned.mockResolvedValue(true);
  mocks.startOrGetActiveRun.mockResolvedValue({ runId: 'parent-run-1', created: true });
  mocks.recordCompletedChildRuns.mockResolvedValue(undefined);
  mocks.recordStep.mockResolvedValue(undefined);
  mocks.recordOutcome.mockResolvedValue(undefined);
  mocks.completeRun.mockResolvedValue(undefined);
  mocks.solicitationWatchEnabled.mockReturnValue(true);
});

describe('solicitation batch candidate loader', () => {
  it('binds the accumulated-pool rotation order, 5000 cap, completed-upload consent, and send-only history', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{
        id: 'batch-1',
        account_id: 'account-1',
        business_id: 'business-1',
        built_at: null,
        subscription_status: 'active',
      }]),
      mkTaggedResult([{ subscription_status: 'active' }]),
      mkTaggedResult([]),
      mkTaggedResult([{
        id: 'batch-1',
        account_id: 'account-1',
        business_id: 'business-1',
        built_at: null,
        category: 'automotive',
      }]),
      mkTaggedResult([]),
      mkTaggedResult([{ category: 'automotive' }]),
      mkTaggedResult([{ contact_id: 'contact-1' }]),
      mkTaggedResult([{
        contact_id: 'contact-1',
        last_visit_date: '2026-07-23',
        upload_id: 'upload-1',
        consent_attested: true,
      }]),
      mkTaggedResult([{
        contact_id: 'contact-1',
        prior_batch_id: 'prior-batch-1',
        prior_decision_at: '2026-07-23T00:00:00.000Z',
      }]),
      mkTaggedResult([{ id: 'ask-1' }]),
      mkTaggedResult([{ id: 'ask-1' }]),
      mkTaggedResult([{ id: 'batch-1' }]),
    );

    const result = await buildSolicitationBatch(mockSql as unknown as Sql, {
      batchId: 'batch-1',
      businessId: 'business-1',
      outboxId: 'outbox-1',
      attempt: 2,
    });

    expect(result).toMatchObject({
      status: 'built',
      candidateCount: 1,
      sendCount: 0,
      withholdCount: 1,
    });
    const candidateQuery = sqlCalls.find((call) =>
      call.text.includes('FROM solicitation_contacts c'),
    );
    const visitQuery = sqlCalls.find((call) =>
      call.text.includes('FROM solicitation_visits v') &&
      call.text.includes('JOIN contact_csv_uploads u'),
    );
    const priorSendQuery = sqlCalls.find((call) =>
      call.text.includes('FROM solicitation_asks send_ask'),
    );
    expect(visitQuery?.text).toContain("u.status = 'completed'");
    expect(priorSendQuery?.text).toContain("send_ask.status = 'send'");
    expect(candidateQuery?.text).toContain(
      'MAX(evaluation_ask.decided_at) ASC NULLS FIRST',
    );
    expect(candidateQuery?.text).toContain('MAX(v.visit_date) DESC');
    expect(candidateQuery?.text).toContain('c.id ASC');
    expect(candidateQuery?.text).toContain('LIMIT ?');
    expect(candidateQuery?.values).toContain(MAX_DATA_ROWS);
    expect(mocks.recordCompletedChildRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        children: [
          expect.objectContaining({
            decision: 'withhold',
            withheldReason: 'over_contacted',
          }),
        ],
      }),
    );
  });
});
