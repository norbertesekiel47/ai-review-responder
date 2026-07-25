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
  startOrGetSolicitationBatchRun: vi.fn(),
  recordCompletedChildRuns: vi.fn(),
  completeSolicitationBatchRun: vi.fn(),
  failSolicitationBatchRun: vi.fn(),
  solicitationWatchEnabled: vi.fn(),
}));

vi.mock('@/lib/shared/outbox', () => ({
  lockDispatchedOutboxAttemptIfOwned: mocks.lockDispatchedOutboxAttemptIfOwned,
  markOutboxCompletedIfOwned: mocks.markOutboxCompletedIfOwned,
}));
vi.mock('@/lib/agents/run-spine', () => ({
  startOrGetSolicitationBatchRun: mocks.startOrGetSolicitationBatchRun,
  recordCompletedChildRuns: mocks.recordCompletedChildRuns,
  completeSolicitationBatchRun: mocks.completeSolicitationBatchRun,
  failSolicitationBatchRun: mocks.failSolicitationBatchRun,
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
  mocks.startOrGetSolicitationBatchRun.mockResolvedValue({
    runId: 'parent-run-1',
    created: true,
  });
  mocks.recordCompletedChildRuns.mockResolvedValue(undefined);
  mocks.completeSolicitationBatchRun.mockResolvedValue(undefined);
  mocks.failSolicitationBatchRun.mockResolvedValue(undefined);
  mocks.solicitationWatchEnabled.mockReturnValue(true);
});

describe('solicitation batch candidate loader', () => {
  it('gate closure completion-CASes ownership before failing the active parent and deleting the unbuilt batch', async () => {
    mocks.solicitationWatchEnabled.mockReturnValue(false);
    sqlReturnQueue.push(
      mkTaggedResult([{
        id: 'batch-1',
        account_id: 'account-1',
        business_id: 'business-1',
        built_at: null,
      }]),
      mkTaggedResult([{ subscription_status: 'active' }]),
      mkTaggedResult([{ id: 'parent-run-1' }]),
      mkTaggedResult([{ id: 'batch-1' }]),
    );

    await expect(
      buildSolicitationBatch(mockSql as unknown as Sql, {
        batchId: 'batch-1',
        businessId: 'business-1',
        outboxId: 'outbox-1',
        attempt: 2,
      }),
    ).resolves.toEqual({
      status: 'gate_closed',
      reason: 'flag_disabled',
      parentTerminalized: true,
    });

    expect(mocks.markOutboxCompletedIfOwned).toHaveBeenCalledWith(
      mockSql,
      'outbox-1',
      2,
    );
    expect(mocks.failSolicitationBatchRun).toHaveBeenCalledWith(
      mockSql,
      {
        runId: 'parent-run-1',
        failure: { code: 'gate_closed', gate: 'flag_disabled' },
      },
    );
    const deleteIndex = sqlCalls.findIndex((call) =>
      call.text.includes('DELETE FROM solicitation_batches'),
    );
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(
      mocks.markOutboxCompletedIfOwned.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.failSolicitationBatchRun.mock.invocationCallOrder[0]!);
    expect(
      mocks.markOutboxCompletedIfOwned.mock.invocationCallOrder[0],
    ).toBeLessThan(mockSql.mock.invocationCallOrder[deleteIndex]!);
  });

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
    expect(mocks.startOrGetSolicitationBatchRun).toHaveBeenCalledWith(
      mockSql,
      {
        batchId: 'batch-1',
        accountId: 'account-1',
        businessId: 'business-1',
        correlationId: undefined,
      },
    );
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
    expect(mocks.completeSolicitationBatchRun).toHaveBeenCalledWith(
      mockSql,
      {
        runId: 'parent-run-1',
        accountId: 'account-1',
        businessId: 'business-1',
        batchId: 'batch-1',
        candidateCount: 1,
        sendCount: 0,
        withholdCount: 1,
        withheldByReason: {
          no_consent: 0,
          suppressed: 0,
          already_reviewed: 0,
          stale_visit: 0,
          over_contacted: 1,
          velocity_banked: 0,
        },
      },
    );
  });
});
