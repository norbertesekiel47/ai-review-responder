import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Sql, TransactionSql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SEND_ELIGIBLE_ATTESTATION_VERSIONS } from '../attestation';
import { MAX_DATA_ROWS } from '../contacts-csv';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, isInTransaction, mkTaggedResult } =
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
  solicitationSendEnabled: vi.fn(),
  enqueueGenerateSolicitationAsks: vi.fn(),
  lockAccountBeforeOffboardingProjection: vi.fn(),
  getOffboardingState: vi.fn(),
  isProcessingBlocked: vi.fn(),
}));

vi.mock('@/lib/shared/outbox', () => ({
  lockDispatchedOutboxAttemptIfOwned: mocks.lockDispatchedOutboxAttemptIfOwned,
  markOutboxCompletedIfOwned: mocks.markOutboxCompletedIfOwned,
}));
vi.mock('@/lib/shared/job-outbox-helpers', () => ({
  enqueueGenerateSolicitationAsks: mocks.enqueueGenerateSolicitationAsks,
}));
vi.mock('@/lib/agents/run-spine', () => ({
  startOrGetSolicitationBatchRun: mocks.startOrGetSolicitationBatchRun,
  recordCompletedChildRuns: mocks.recordCompletedChildRuns,
  completeSolicitationBatchRun: mocks.completeSolicitationBatchRun,
  failSolicitationBatchRun: mocks.failSolicitationBatchRun,
}));
vi.mock('../flags', () => ({
  solicitationWatchEnabled: mocks.solicitationWatchEnabled,
  solicitationSendEnabled: mocks.solicitationSendEnabled,
}));
vi.mock('@/lib/account-offboarding/gate', () => ({
  lockAccountBeforeOffboardingProjection:
    mocks.lockAccountBeforeOffboardingProjection,
  getOffboardingState: mocks.getOffboardingState,
  isProcessingBlocked: mocks.isProcessingBlocked,
}));

import {
  acquireSolicitationBatchLock,
  buildSolicitationBatch,
} from '../batch-builder';

beforeEach(() => {
  resetMockSql();
  mockSql.mockClear();
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
  // Mirrors production: the send flag exists in no environment yet.
  mocks.solicitationSendEnabled.mockReturnValue(false);
  mocks.enqueueGenerateSolicitationAsks.mockResolvedValue('generation-outbox-1');
  mocks.lockAccountBeforeOffboardingProjection.mockResolvedValue(true);
  mocks.getOffboardingState.mockResolvedValue(null);
  mocks.isProcessingBlocked.mockReturnValue(false);
});

describe('solicitation batch candidate loader', () => {
  it('build_solicitation_batch treats delete_data offboarding as gate_closed before candidate evaluation', async () => {
    mocks.getOffboardingState.mockResolvedValue({
      id: 'offboarding-1',
      accountId: 'account-1',
      mode: 'delete_data',
      status: 'pending',
    });
    mocks.isProcessingBlocked.mockReturnValue(true);
    sqlReturnQueue.push(
      mkTaggedResult([{
        id: 'batch-1',
        account_id: 'account-1',
        business_id: 'business-1',
        built_at: null,
      }]),
      mkTaggedResult([{ subscription_status: 'active' }]),
      mkTaggedResult([]),
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
      reason: 'account_offboarding_blocked',
      parentTerminalized: false,
    });

    expect(mocks.lockAccountBeforeOffboardingProjection).toHaveBeenCalledWith(
      mockSql,
      'account-1',
    );
    expect(mocks.getOffboardingState).toHaveBeenCalledWith(
      'account-1',
      mockSql,
    );
    expect(sqlCalls.some((call) =>
      call.text.includes('FROM solicitation_contacts c'),
    )).toBe(false);
    expect(mocks.startOrGetSolicitationBatchRun).not.toHaveBeenCalled();
    expect(mocks.recordCompletedChildRuns).not.toHaveBeenCalled();
  });

  it('rechecks delete_data offboarding in construction before reading contact history', async () => {
    mocks.getOffboardingState
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'offboarding-1',
        accountId: 'account-1',
        mode: 'delete_data',
        status: 'pending',
      });
    mocks.isProcessingBlocked
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    sqlReturnQueue.push(
      mkTaggedResult([{
        id: 'batch-1',
        account_id: 'account-1',
        business_id: 'business-1',
        built_at: null,
      }]),
      mkTaggedResult([{ subscription_status: 'active' }]),
      mkTaggedResult([]),
      // Construction: the advisory lock is issued BEFORE the batch row lock.
      mkTaggedResult([]),
      mkTaggedResult([{
        id: 'batch-1',
        account_id: 'account-1',
        business_id: 'business-1',
        built_at: null,
      }]),
      mkTaggedResult([{ subscription_status: 'active' }]),
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
      reason: 'account_offboarding_blocked',
      parentTerminalized: true,
    });

    expect(mocks.lockAccountBeforeOffboardingProjection).toHaveBeenCalledTimes(2);
    expect(mocks.getOffboardingState).toHaveBeenCalledTimes(2);
    expect(sqlCalls.some((call) =>
      call.text.includes('FROM solicitation_contacts c'),
    )).toBe(false);
    expect(mocks.failSolicitationBatchRun).toHaveBeenCalledWith(
      mockSql,
      {
        runId: 'parent-run-1',
        failure: {
          code: 'gate_closed',
          gate: 'account_offboarding_blocked',
        },
      },
    );
    expect(mocks.recordCompletedChildRuns).not.toHaveBeenCalled();
  });

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

  it('prepareBatch and constructBatch derive the closed-gate reason from one owner', async () => {
    // Every gate condition is closed at once, so the shared precedence
    // (offboarding → flag_disabled → subscription_inactive) decides the reason.
    const allGatesClosed = () => {
      mocks.solicitationWatchEnabled.mockReturnValue(false);
      mocks.getOffboardingState.mockResolvedValue({
        id: 'offboarding-1',
        accountId: 'account-1',
        mode: 'delete_data',
        status: 'pending',
      });
      mocks.isProcessingBlocked.mockReturnValue(true);
    };

    allGatesClosed();
    sqlReturnQueue.push(
      mkTaggedResult([{
        id: 'batch-1',
        account_id: 'account-1',
        business_id: 'business-1',
        built_at: null,
      }]),
      mkTaggedResult([{ subscription_status: 'cancelled' }]),
      mkTaggedResult([]),
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
      reason: 'account_offboarding_blocked',
      parentTerminalized: false,
    });
    const preparationAccountRead = sqlCalls.find((call) =>
      call.text.includes('FROM accounts'),
    );
    const preparationDelete = sqlCalls.find((call) =>
      call.text.includes('DELETE FROM solicitation_batches'),
    );

    // Second run: preparation's gate is open, construction's is closed. The
    // double evaluation is deliberate — only the reason derivation is shared.
    resetMockSql();
    mocks.lockAccountBeforeOffboardingProjection.mockClear();
    mocks.getOffboardingState.mockClear();
    sqlReturnQueue.push(
      mkTaggedResult([{
        id: 'batch-1',
        account_id: 'account-1',
        business_id: 'business-1',
        built_at: null,
      }]),
      mkTaggedResult([{ subscription_status: 'active' }]),
      mkTaggedResult([]),
      // Construction: the advisory lock is issued BEFORE the batch row lock.
      mkTaggedResult([]),
      mkTaggedResult([{
        id: 'batch-1',
        account_id: 'account-1',
        business_id: 'business-1',
        built_at: null,
      }]),
      mkTaggedResult([{ subscription_status: 'cancelled' }]),
      mkTaggedResult([{ id: 'batch-1' }]),
    );
    allGatesClosed();
    mocks.solicitationWatchEnabled.mockReturnValueOnce(true);
    mocks.isProcessingBlocked.mockReturnValueOnce(false);
    mocks.getOffboardingState.mockResolvedValueOnce(null);

    await expect(
      buildSolicitationBatch(mockSql as unknown as Sql, {
        batchId: 'batch-1',
        businessId: 'business-1',
        outboxId: 'outbox-1',
        attempt: 2,
      }),
    ).resolves.toEqual({
      status: 'gate_closed',
      reason: 'account_offboarding_blocked',
      parentTerminalized: true,
    });

    // Both call sites evaluate the gate — and each evaluation is the same
    // account read and the same unbuilt-batch delete, byte for byte.
    expect(mocks.lockAccountBeforeOffboardingProjection).toHaveBeenCalledTimes(2);
    expect(mocks.getOffboardingState).toHaveBeenCalledTimes(2);
    const constructionAccountRead = sqlCalls.filter((call) =>
      call.text.includes('FROM accounts'),
    );
    expect(constructionAccountRead).toHaveLength(2);
    for (const call of constructionAccountRead) {
      expect(call.text).toBe(preparationAccountRead?.text);
      expect(call.values).toEqual(['account-1']);
    }
    const constructionDelete = sqlCalls.find((call) =>
      call.text.includes('DELETE FROM solicitation_batches'),
    );
    expect(constructionDelete?.text).toBe(preparationDelete?.text);
    expect(constructionDelete?.values).toEqual(preparationDelete?.values);
    expect(constructionDelete?.values).toEqual([
      'batch-1',
      'account-1',
      'business-1',
    ]);
  });

  it('evaluateBatchGate runs before the activeParent row lock in prepareBatch', async () => {
    mocks.solicitationWatchEnabled.mockReturnValue(false);
    sqlReturnQueue.push(
      mkTaggedResult([{
        id: 'batch-1',
        account_id: 'account-1',
        business_id: 'business-1',
        built_at: null,
      }]),
      mkTaggedResult([{ subscription_status: 'active' }]),
      mkTaggedResult([]),
      mkTaggedResult([{ id: 'batch-1' }]),
    );

    await expect(
      buildSolicitationBatch(mockSql as unknown as Sql, {
        batchId: 'batch-1',
        businessId: 'business-1',
        outboxId: 'outbox-1',
        attempt: 2,
      }),
    ).resolves.toMatchObject({ status: 'gate_closed', reason: 'flag_disabled' });

    const accountReadIndex = sqlCalls.findIndex((call) =>
      call.text.includes('FROM accounts'),
    );
    const activeParentIndex = sqlCalls.findIndex((call) =>
      call.text.includes('FROM agent_runs'),
    );
    expect(accountReadIndex).toBeGreaterThanOrEqual(0);
    expect(activeParentIndex).toBeGreaterThanOrEqual(0);
    expect(sqlCalls[activeParentIndex]!.text).toContain('FOR UPDATE');

    // The accounts row lock is taken before the agent_runs row lock; reversing
    // it would invert this transaction's lock order.
    expect(accountReadIndex).toBeLessThan(activeParentIndex);
    const activeParentOrder = mockSql.mock.invocationCallOrder[activeParentIndex]!;
    expect(
      mocks.lockAccountBeforeOffboardingProjection.mock.invocationCallOrder[0]!,
    ).toBeLessThan(activeParentOrder);
    expect(
      mocks.getOffboardingState.mock.invocationCallOrder[0]!,
    ).toBeLessThan(activeParentOrder);
  });

  it('candidate history query pre-aggregates visits and asks before the 5000-contact limit', async () => {
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
      // Construction: the advisory lock is issued BEFORE the batch row lock.
      mkTaggedResult([]),
      mkTaggedResult([{
        id: 'batch-1',
        account_id: 'account-1',
        business_id: 'business-1',
        built_at: null,
        category: 'automotive',
      }]),
      mkTaggedResult([{ subscription_status: 'active' }]),
      mkTaggedResult([{ category: 'automotive' }]),
      mkTaggedResult([{
        contact_id: 'contact-1',
        last_visit_date: '2026-07-23',
        consent_attested: true,
        consent_upload_id: 'upload-1',
        consent_attestation_version: 'consent_attestation_v2',
      }]),
      mkTaggedResult([{ pool_count: 1 }]),
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
      poolCount: 1,
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
    const priorSendQuery = sqlCalls.find((call) =>
      call.text.includes('FROM solicitation_asks send_ask'),
    );
    expect(candidateQuery?.text).toContain('JOIN solicitation_visits latest_visit');
    expect(candidateQuery?.text).toContain('JOIN contact_csv_uploads u');
    expect(candidateQuery?.text).toContain('FROM solicitation_visits candidate_visit');
    expect(candidateQuery?.text).toContain('JOIN contact_csv_uploads candidate_upload');
    expect(candidateQuery?.text).toContain('LEFT JOIN solicitation_asks latest_evaluation');
    expect(candidateQuery?.text).toContain('FROM solicitation_asks candidate_ask');
    expect(candidateQuery?.text).toContain("u.status = 'completed'");
    expect(candidateQuery?.text).toContain(
      'candidate_upload.account_id = ?::uuid',
    );
    expect(candidateQuery?.text).toContain(
      'candidate_upload.business_id = ?::uuid',
    );
    expect(candidateQuery?.text).toContain(
      'candidate_visit.business_id = ?::uuid',
    );
    expect(candidateQuery?.text).toContain(
      'latest_visit.business_id = ?::uuid',
    );
    expect(candidateQuery?.text).toContain('u.account_id = ?::uuid');
    expect(candidateQuery?.text).toContain('u.business_id = ?::uuid');
    expect(candidateQuery?.text).toContain(
      'latest_evaluation.account_id = ?::uuid',
    );
    expect(candidateQuery?.text).toContain(
      'latest_evaluation.business_id = ?::uuid',
    );
    expect(candidateQuery?.text).toContain(
      'candidate_ask.account_id = ?::uuid',
    );
    expect(candidateQuery?.text).toContain(
      'candidate_ask.business_id = ?::uuid',
    );
    expect(candidateQuery?.text).toContain('c.business_id = ?::uuid');
    // #620 §6.1: consent derives from the ledger + allowlist, not the upload
    // row (the pre-#625 tautology).
    expect(candidateQuery?.text).toContain('LEFT JOIN solicitation_consent consent');
    expect(candidateQuery?.text).toContain("consent.channel = 'email'");
    expect(candidateQuery?.text).toContain('consent.normalized_handle = c.email');
    expect(candidateQuery?.text).toContain('consent.business_id = ?::uuid');
    expect(candidateQuery?.text).toContain('consent.attestation_version = ANY(?::text[])');
    expect(candidateQuery?.text).not.toContain('u.attested_at');
    expect(candidateQuery?.values).toContainEqual([...SEND_ELIGIBLE_ATTESTATION_VERSIONS]);
    expect(priorSendQuery?.text).toContain("send_ask.status = 'send'");
    expect(candidateQuery?.text).toContain(
      'latest_evaluation.decided_at ASC NULLS FIRST',
    );
    expect(candidateQuery?.text).toContain('latest_visit.visit_date DESC');
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

describe('send-mode generation enqueue (EXEC D21)', () => {
  // A candidate that passes every per-candidate restraint gate: attested
  // consent, no suppression/review/prior send, visited today (inside every
  // vertical's freshness window regardless of when the suite runs).
  const todayUtcDate = new Date().toISOString().slice(0, 10);

  /** prepareBatch results: batch row lock, gate account read, activeParent. */
  function pushPreparationResults(): void {
    sqlReturnQueue.push(
      mkTaggedResult([{
        id: 'batch-1',
        account_id: 'account-1',
        business_id: 'business-1',
        built_at: null,
      }]),
      mkTaggedResult([{ subscription_status: 'active' }]),
      mkTaggedResult([]),
    );
  }

  /** constructBatch results up to the candidate window (advisory lock first). */
  function pushConstructionPreamble(): void {
    sqlReturnQueue.push(
      mkTaggedResult([]),
      mkTaggedResult([{
        id: 'batch-1',
        account_id: 'account-1',
        business_id: 'business-1',
        built_at: null,
      }]),
      mkTaggedResult([{ subscription_status: 'active' }]),
      mkTaggedResult([{ category: 'automotive' }]),
    );
  }

  /** One send-decision candidate: window row, pool, prior sends, ask insert,
   *  run link, built_at CAS. */
  function pushSendCandidateResults(): void {
    sqlReturnQueue.push(
      mkTaggedResult([{
        contact_id: 'contact-1',
        last_visit_date: todayUtcDate,
        upload_id: 'upload-1',
        consent_attested: true,
      }]),
      mkTaggedResult([{ pool_count: 1 }]),
      mkTaggedResult([]),
      mkTaggedResult([{ id: 'ask-1' }]),
      mkTaggedResult([{ id: 'ask-1' }]),
      mkTaggedResult([{ id: 'batch-1' }]),
    );
  }

  it('does not enqueue generation when the batch has zero send asks', async () => {
    mocks.solicitationSendEnabled.mockReturnValue(true);
    pushPreparationResults();
    pushConstructionPreamble();
    sqlReturnQueue.push(
      mkTaggedResult([]),
      mkTaggedResult([{ pool_count: 0 }]),
      mkTaggedResult([{ id: 'batch-1' }]),
    );

    await expect(
      buildSolicitationBatch(mockSql as unknown as Sql, {
        batchId: 'batch-1',
        businessId: 'business-1',
        outboxId: 'outbox-1',
        attempt: 2,
      }),
    ).resolves.toMatchObject({ status: 'built', sendCount: 0 });

    // Zero send asks ⇒ no enqueue, no send parent — the watch-mode report is
    // the whole outcome.
    expect(mocks.enqueueGenerateSolicitationAsks).not.toHaveBeenCalled();
  });

  it('does not enqueue generation while SOLICITATION_SEND_ENABLED is off even when the batch has send asks', async () => {
    // beforeEach default: solicitationSendEnabled() === false (no env has the
    // flag yet) — the built path must stay byte-identical to today's.
    pushPreparationResults();
    pushConstructionPreamble();
    pushSendCandidateResults();

    await expect(
      buildSolicitationBatch(mockSql as unknown as Sql, {
        batchId: 'batch-1',
        businessId: 'business-1',
        outboxId: 'outbox-1',
        attempt: 2,
      }),
    ).resolves.toMatchObject({ status: 'built', sendCount: 1 });

    expect(mocks.solicitationSendEnabled).toHaveBeenCalled();
    expect(mocks.enqueueGenerateSolicitationAsks).not.toHaveBeenCalled();
  });

  it('enqueues generate_solicitation_asks inside the built_at transaction after the CAS when the flag is on', async () => {
    mocks.solicitationSendEnabled.mockReturnValue(true);
    let enqueuedInTransaction: boolean | null = null;
    mocks.enqueueGenerateSolicitationAsks.mockImplementation(async () => {
      enqueuedInTransaction = isInTransaction();
      return 'generation-outbox-1';
    });
    pushPreparationResults();
    pushConstructionPreamble();
    pushSendCandidateResults();

    await expect(
      buildSolicitationBatch(mockSql as unknown as Sql, {
        batchId: 'batch-1',
        businessId: 'business-1',
        outboxId: 'outbox-1',
        attempt: 2,
        correlationId: 'corr-1',
      }),
    ).resolves.toMatchObject({ status: 'built', sendCount: 1 });

    expect(mocks.enqueueGenerateSolicitationAsks).toHaveBeenCalledExactlyOnceWith(
      mockSql,
      { batchId: 'batch-1', correlationId: 'corr-1' },
    );
    // Same transaction as the batch build (invariant #2), and strictly after
    // the built_at CAS — the enqueue rides the transition, never precedes it.
    expect(enqueuedInTransaction).toBe(true);
    const builtCasIndex = sqlCalls.findIndex((call) =>
      call.text.includes('UPDATE solicitation_batches'),
    );
    expect(builtCasIndex).toBeGreaterThanOrEqual(0);
    expect(mockSql.mock.invocationCallOrder[builtCasIndex]!).toBeLessThan(
      mocks.enqueueGenerateSolicitationAsks.mock.invocationCallOrder[0]!,
    );
  });
});

// The solicitation_batch lane's source roots. The advisory-lock KEY may be
// built in exactly one file; every other holder goes through
// acquireSolicitationBatchLock, which also owns the hashtext wrapping and the
// advisory-before-row-locks rule. Mirrors the csv_ingest guard in
// ingest.test.ts — #582's lesson is that two derivations is how a lock
// silently stops contending while still looking taken.
const LOCK_LANE_ROOTS = ['src/lib', 'worker'];
// Only a reconstruction of the key counts: the prefix either terminates a
// string literal (`'solicitation_batch_' || business_id`) or is followed by an
// interpolation. Prose (`solicitation_batch_<business>`) is deliberately out.
const BATCH_LOCK_KEY_CONSTRUCTION = /solicitation_batch_(\$\{|['"`])/;

function* walkLockLaneSources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      yield* walkLockLaneSources(join(dir, entry.name));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      yield join(dir, entry.name);
    }
  }
}

function filesBuildingTheBatchLockKey(): string[] {
  const files: string[] = [];
  for (const root of LOCK_LANE_ROOTS) {
    for (const filePath of walkLockLaneSources(join(process.cwd(), root))) {
      if (BATCH_LOCK_KEY_CONSTRUCTION.test(readFileSync(filePath, 'utf-8'))) {
        files.push(relative(process.cwd(), filePath).split('\\').join('/'));
      }
    }
  }
  return files.sort();
}

describe('solicitation_batch advisory lock', () => {
  it('acquireSolicitationBatchLock is the single owner of the solicitation_batch advisory-lock key', async () => {
    await acquireSolicitationBatchLock(
      mockSql as unknown as TransactionSql,
      'business-1',
    );

    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0]!.text).toContain('pg_advisory_xact_lock');
    expect(sqlCalls[0]!.text).toContain('hashtext');
    // Key VALUE pinned: changing it would silently stop serializing against
    // the offboarding purge, which takes the same key.
    expect(sqlCalls[0]!.values).toEqual(['solicitation_batch_business-1']);
    expect(filesBuildingTheBatchLockKey()).toEqual([
      'src/lib/solicitation/batch-builder.ts',
    ]);
  });

  it('constructBatch takes the advisory lock before the batch row lock', async () => {
    sqlReturnQueue.push(
      // preparation
      mkTaggedResult([{
        id: 'batch-1',
        account_id: 'account-1',
        business_id: 'business-1',
        built_at: null,
      }]),
      mkTaggedResult([{ subscription_status: 'active' }]),
      mkTaggedResult([]),
      // construction: advisory lock, then the batch row lock
      mkTaggedResult([]),
      mkTaggedResult([{
        id: 'batch-1',
        account_id: 'account-1',
        business_id: 'business-1',
        built_at: null,
      }]),
      mkTaggedResult([{ subscription_status: 'active' }]),
      mkTaggedResult([{ category: 'automotive' }]),
      mkTaggedResult([]),
      mkTaggedResult([{ pool_count: 0 }]),
      mkTaggedResult([{ id: 'batch-1' }]),
    );

    await expect(
      buildSolicitationBatch(mockSql as unknown as Sql, {
        batchId: 'batch-1',
        businessId: 'business-1',
        outboxId: 'outbox-1',
        attempt: 2,
      }),
    ).resolves.toMatchObject({ status: 'built' });

    const advisoryIndex = sqlCalls.findIndex((call) =>
      call.text.includes('pg_advisory_xact_lock'),
    );
    const batchRowLockIndex = sqlCalls.findIndex((call) =>
      call.text.includes('FROM solicitation_batches sb')
      && call.text.includes('FOR UPDATE OF sb')
      && call.values.includes('account-1'),
    );
    expect(advisoryIndex).toBeGreaterThanOrEqual(0);
    expect(batchRowLockIndex).toBeGreaterThanOrEqual(0);
    // Global order: advisory first, then row locks. The reverse is an ABBA
    // deadlock against the offboarding purge, which holds this key across the
    // deletes that row-lock these same batches.
    expect(advisoryIndex).toBeLessThan(batchRowLockIndex);
    expect(sqlCalls[advisoryIndex]!.values).toEqual([
      'solicitation_batch_business-1',
    ]);
  });
});
