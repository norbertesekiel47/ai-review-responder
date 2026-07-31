import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult } =
  await vi.hoisted(async () => {
    const helpers = await import('../../../../worker/__tests__/helpers/mock-sql');
    return { ...helpers.createMockSql(), mkTaggedResult: helpers.mkTaggedResult };
  });

const mocks = vi.hoisted(() => ({
  lockDispatchedOutboxAttemptIfOwned: vi.fn(),
  markOutboxCompletedIfOwned: vi.fn(),
  startOrGetSolicitationSendBatchRun: vi.fn(),
  recordGenerationSteps: vi.fn(),
  recordStep: vi.fn(),
  acquireSolicitationBatchLock: vi.fn(),
  insertOutreachRender: vi.fn(),
  supersedeLiveRender: vi.fn(),
  closeBatchIfSettled: vi.fn(),
  solicitationSendEnabled: vi.fn(),
  runLlmTask: vi.fn(),
  moderateResponse: vi.fn(),
  openaiModerationEnabled: vi.fn(),
  reserveCost: vi.fn(),
  finalizeCost: vi.fn(),
  releaseCost: vi.fn(),
  checkAskRegenBudget: vi.fn(),
  acquireConcurrencySlot: vi.fn(),
  releaseConcurrencySlot: vi.fn(),
  recordApiCost: vi.fn(),
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/shared/outbox', () => ({
  lockDispatchedOutboxAttemptIfOwned: mocks.lockDispatchedOutboxAttemptIfOwned,
  markOutboxCompletedIfOwned: mocks.markOutboxCompletedIfOwned,
}));
vi.mock('@/lib/agents/run-spine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agents/run-spine')>()),
  startOrGetSolicitationSendBatchRun: mocks.startOrGetSolicitationSendBatchRun,
  recordGenerationSteps: mocks.recordGenerationSteps,
  recordStep: mocks.recordStep,
}));
vi.mock('../batch-builder', () => ({
  acquireSolicitationBatchLock: mocks.acquireSolicitationBatchLock,
}));
vi.mock('../outreach', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../outreach')>()),
  insertOutreachRender: mocks.insertOutreachRender,
  supersedeLiveRender: mocks.supersedeLiveRender,
  closeBatchIfSettled: mocks.closeBatchIfSettled,
}));
vi.mock('../flags', () => ({
  solicitationWatchEnabled: vi.fn(),
  solicitationSendEnabled: mocks.solicitationSendEnabled,
}));
vi.mock('@/lib/llm/run-task', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/llm/run-task')>()),
  runLlmTask: mocks.runLlmTask,
}));
vi.mock('@/lib/moderation/moderate', () => ({
  moderateResponse: mocks.moderateResponse,
}));
vi.mock('@/lib/moderation/flags', () => ({
  openaiModerationEnabled: mocks.openaiModerationEnabled,
}));
vi.mock('@/lib/costs/tracker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/costs/tracker')>()),
  reserveCost: mocks.reserveCost,
  finalizeCost: mocks.finalizeCost,
  releaseCost: mocks.releaseCost,
  checkAskRegenBudget: mocks.checkAskRegenBudget,
}));
vi.mock('@/lib/costs/concurrency-guard', () => ({
  acquireConcurrencySlot: mocks.acquireConcurrencySlot,
  releaseConcurrencySlot: mocks.releaseConcurrencySlot,
}));
vi.mock('@/lib/costs/audit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/costs/audit')>()),
  recordApiCost: mocks.recordApiCost,
}));
vi.mock('@/lib/shared/logger', () => ({
  createWorkerLogger: () => mocks.logger,
}));

import { LLMStructuredOutputError } from '@/lib/llm/run-task';
import {
  CostLimitExceededError,
  RegenBudgetExceededError,
} from '@/lib/costs/tracker';
import { TransientLLMError } from '@/lib/llm/error-classifier';
import { OPENAI_MODEL } from '@/lib/llm/tasks';
import {
  generateAsksForBatch,
  regenerateAsk,
  SOLICITATION_ASK_ESTIMATE_CENTS,
} from '../ask-generation';

const sql = mockSql as unknown as Sql;

const BATCH_ID = 'batch-1';
const ACCOUNT_ID = 'account-1';
const BUSINESS_ID = 'business-1';
const OUTBOX = { outboxId: 'outbox-1', attempt: 3 };
const GENERATE_INPUT = { batchId: BATCH_ID, businessId: BUSINESS_ID, outboxHandle: OUTBOX };

/** Copy that passes the REAL lint against the context/ask fixtures below. */
const CLEAN_STRUCTURED = {
  subject: 'Thanks for visiting Testers Cafe',
  body: 'Hi Alice, thanks for coming by Testers Cafe. Would you share how it went?',
};

function llmResult(structured: unknown) {
  return {
    text: JSON.stringify(structured),
    provider: 'openai' as const,
    model: OPENAI_MODEL,
    usage: { promptTokens: 500, completionTokens: 120 },
    structured,
  };
}

function contextRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BATCH_ID,
    account_id: ACCOUNT_ID,
    business_id: BUSINESS_ID,
    subscription_status: 'active',
    subscription_tier: 'copilot',
    business_name: 'Testers Cafe',
    business_category: 'restaurant',
    postal_address: '123 Main St, Austin, TX 78701',
    // Dynamic on purpose: deriveBatchState compares against the REAL clock, so
    // a fixed date would silently flip this fixture to `expired` over time.
    built_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
    approved_at: null,
    veto_deadline_at: null,
    sending_started_at: null,
    send_closed_at: null,
    halted_at: null,
    ...overrides,
  };
}

function askRow(n: number, overrides: Record<string, unknown> = {}) {
  return {
    ask_id: `ask-${n}`,
    contact_id: `contact-${n}`,
    decided_at: new Date('2026-07-28T12:00:00Z'),
    contact_name: 'Alice Smith',
    visit_date: '2026-07-25',
    visit_note: null,
    ...overrides,
  };
}

const probeRow = (nonCancelled: number, maxAttempt = nonCancelled) =>
  mkTaggedResult([{ non_cancelled: nonCancelled, max_attempt: maxAttempt }]);

const tallyRow = (alive: number, failedCount = 0, withheldCount = 0) =>
  mkTaggedResult([{ alive, failed_count: failedCount, withheld_count: withheldCount }]);

/** FIFO for the finale transaction: batch FOR UPDATE row, then the tally. */
function enqueueFinale(tally = tallyRow(1)) {
  sqlReturnQueue.push(mkTaggedResult([{ id: BATCH_ID }]), tally);
}

function cleanModeration() {
  return {
    flagged: false,
    severity: 'low' as const,
    reason: null,
    categories: {},
    score: 0,
    source: null,
    providerStatus: 'clean' as const,
  };
}

beforeEach(() => {
  resetMockSql();
  mockSql.mockClear();
  mockSql.begin.mockClear();
  for (const mock of Object.values(mocks)) {
    if (typeof (mock as { mockReset?: unknown }).mockReset === 'function') {
      (mock as ReturnType<typeof vi.fn>).mockReset();
    }
  }
  for (const fn of Object.values(mocks.logger)) fn.mockReset();

  mocks.solicitationSendEnabled.mockReturnValue(true);
  mocks.lockDispatchedOutboxAttemptIfOwned.mockResolvedValue(true);
  mocks.markOutboxCompletedIfOwned.mockResolvedValue(true);
  mocks.startOrGetSolicitationSendBatchRun.mockResolvedValue({
    runId: 'parent-run-1',
    created: true,
  });
  mocks.recordGenerationSteps.mockResolvedValue(1);
  mocks.recordStep.mockResolvedValue(undefined);
  mocks.acquireSolicitationBatchLock.mockResolvedValue(undefined);
  mocks.insertOutreachRender.mockResolvedValue('outreach-new');
  mocks.supersedeLiveRender.mockResolvedValue({ priorAttemptNo: 1 });
  mocks.closeBatchIfSettled.mockResolvedValue({ status: 'not_settled', liveCount: 1 });
  mocks.runLlmTask.mockResolvedValue(llmResult(CLEAN_STRUCTURED));
  mocks.moderateResponse.mockResolvedValue(cleanModeration());
  mocks.openaiModerationEnabled.mockReturnValue(true);
  mocks.reserveCost.mockResolvedValue('2026-07-30');
  mocks.finalizeCost.mockResolvedValue(undefined);
  mocks.releaseCost.mockResolvedValue(undefined);
  mocks.checkAskRegenBudget.mockResolvedValue(undefined);
  mocks.recordApiCost.mockResolvedValue('api-cost-1');
});

describe('generateAsksForBatch', () => {
  it('skips reservation for asks that already hold a live render at the current prompt version', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow()]),
      mkTaggedResult([askRow(1), askRow(2)]),
      probeRow(1), // ask-1 already holds a live render
      probeRow(0), // ask-2 is un-generated
    );
    enqueueFinale();

    const result = await generateAsksForBatch(sql, GENERATE_INPUT);

    expect(result).toEqual({ rendered: 1, withheld: 0, failed: 0, skippedExisting: 1 });
    // The probe runs BEFORE the reservation (cost-guard skill: check first,
    // acquire nothing for already-done work) — exactly one reserve for ask-2.
    expect(mocks.reserveCost).toHaveBeenCalledTimes(1);
    expect(mocks.insertOutreachRender).toHaveBeenCalledTimes(1);
    expect(mocks.insertOutreachRender.mock.calls[0]![1]).toMatchObject({
      askId: 'ask-2',
      deliveryStatus: 'rendered',
      attemptNo: 1,
      agentRunId: 'parent-run-1',
    });
  });

  it('a withheld attempt also skips — terminal rows are never re-generated on retry (decision 5)', async () => {
    // The probe counts ANY non-cancelled row; a withheld (terminal) attempt
    // reports non_cancelled = 1 exactly like a live one, so the retry skips it.
    sqlReturnQueue.push(
      mkTaggedResult([contextRow()]),
      mkTaggedResult([askRow(1)]),
      probeRow(1),
    );
    enqueueFinale(tallyRow(0, 1, 0));

    const result = await generateAsksForBatch(sql, GENERATE_INPUT);

    expect(result).toEqual({ rendered: 0, withheld: 0, failed: 0, skippedExisting: 1 });
    expect(mocks.reserveCost).not.toHaveBeenCalled();
    expect(mocks.runLlmTask).not.toHaveBeenCalled();
    expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
  });

  it('budget exhaustion mid-batch settles the remaining asks as withheld/render_failed and completes (decision 6)', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow()]),
      mkTaggedResult([askRow(1), askRow(2), askRow(3)]),
      probeRow(0), // ask-1: renders
      probeRow(0), // ask-2: reserve throws
      probeRow(0), // ask-2 re-probe inside the budget-stop settle
      probeRow(0), // ask-3 probe inside the budget-stop settle
    );
    enqueueFinale();

    mocks.reserveCost
      .mockResolvedValueOnce('2026-07-30')
      .mockRejectedValueOnce(new CostLimitExceededError(BUSINESS_ID));

    const result = await generateAsksForBatch(sql, GENERATE_INPUT);

    // The job COMPLETES (no rethrow — a same-day retry would fail identically).
    expect(result).toEqual({ rendered: 1, withheld: 0, failed: 2, skippedExisting: 0 });
    expect(mocks.runLlmTask).toHaveBeenCalledTimes(1);

    const inserts = mocks.insertOutreachRender.mock.calls.map((call) => call[1]);
    expect(inserts).toHaveLength(3);
    expect(inserts[0]).toMatchObject({ askId: 'ask-1', deliveryStatus: 'rendered' });
    // ask-2 was assembled before its reservation was refused: snapshot kept.
    expect(inserts[1]).toMatchObject({
      askId: 'ask-2',
      deliveryStatus: 'withheld',
      dispositionReason: 'render_failed',
      moderationStatus: 'error',
      renderedSubject: null,
      renderedBody: null,
    });
    expect(inserts[1]).toHaveProperty(
      'interpolationInputs.contact_first_name',
      'Alice',
    );
    // ask-3 was never assembled: empty snapshot per locked decision 6.
    expect(inserts[2]).toMatchObject({
      askId: 'ask-3',
      deliveryStatus: 'withheld',
      dispositionReason: 'render_failed',
      interpolationInputs: {},
    });
    // The finale still completed the outbox attempt.
    expect(mocks.markOutboxCompletedIfOwned).toHaveBeenCalledWith(
      expect.anything(),
      OUTBOX.outboxId,
      OUTBOX.attempt,
    );
  });

  describe('moderation verdict mapping (SPEC §3.2)', () => {
    async function runSingleAsk() {
      sqlReturnQueue.push(
        mkTaggedResult([contextRow()]),
        mkTaggedResult([askRow(1)]),
        probeRow(0),
      );
      enqueueFinale();
      return generateAsksForBatch(sql, GENERATE_INPUT);
    }

    it('high severity withholds with moderation_high — its own reason, bodies stored', async () => {
      mocks.moderateResponse.mockResolvedValue({
        ...cleanModeration(),
        flagged: true,
        severity: 'high',
        reason: 'harassment',
        providerStatus: null,
      });
      const result = await runSingleAsk();
      expect(result).toEqual({ rendered: 0, withheld: 1, failed: 0, skippedExisting: 0 });
      const insert = mocks.insertOutreachRender.mock.calls[0]![1] as Record<string, unknown>;
      expect(insert).toMatchObject({
        deliveryStatus: 'withheld',
        dispositionReason: 'moderation_high',
        moderationStatus: 'flagged',
        renderedSubject: CLEAN_STRUCTURED.subject,
      });
      expect(insert.renderedBody).not.toBeNull();
    });

    it('flagged medium renders with moderation_status flagged and the advisory detail', async () => {
      mocks.moderateResponse.mockResolvedValue({
        ...cleanModeration(),
        flagged: true,
        severity: 'medium',
        reason: 'profanity',
        providerStatus: 'clean',
      });
      const result = await runSingleAsk();
      expect(result.rendered).toBe(1);
      expect(mocks.insertOutreachRender.mock.calls[0]![1]).toMatchObject({
        deliveryStatus: 'rendered',
        moderationStatus: 'flagged',
        moderationDetail: expect.objectContaining({ severity: 'medium' }),
      });
    });

    it('provider error renders with moderation_status error — produced, not dispatchable', async () => {
      mocks.moderateResponse.mockResolvedValue({
        ...cleanModeration(),
        providerStatus: 'error',
      });
      const result = await runSingleAsk();
      expect(result.rendered).toBe(1);
      expect(mocks.insertOutreachRender.mock.calls[0]![1]).toMatchObject({
        deliveryStatus: 'rendered',
        moderationStatus: 'error',
      });
    });

    it('moderation disabled renders with moderation_status disabled — produced, not dispatchable', async () => {
      mocks.openaiModerationEnabled.mockReturnValue(false);
      mocks.moderateResponse.mockResolvedValue({
        ...cleanModeration(),
        providerStatus: null,
      });
      const result = await runSingleAsk();
      expect(result.rendered).toBe(1);
      expect(mocks.insertOutreachRender.mock.calls[0]![1]).toMatchObject({
        deliveryStatus: 'rendered',
        moderationStatus: 'disabled',
      });
    });

    it('clean provider verdict renders with moderation_status clean', async () => {
      const result = await runSingleAsk();
      expect(result.rendered).toBe(1);
      expect(mocks.insertOutreachRender.mock.calls[0]![1]).toMatchObject({
        deliveryStatus: 'rendered',
        moderationStatus: 'clean',
      });
    });
  });

  describe('render_failed fills (locked decision 2)', () => {
    async function runSingleAsk() {
      sqlReturnQueue.push(
        mkTaggedResult([contextRow()]),
        mkTaggedResult([askRow(1)]),
        probeRow(0),
      );
      enqueueFinale(tallyRow(0, 1, 0));
      return generateAsksForBatch(sql, GENERATE_INPUT);
    }

    function expectRenderFailedFills() {
      const insert = mocks.insertOutreachRender.mock.calls[0]![1] as Record<string, unknown>;
      expect(insert).toMatchObject({
        deliveryStatus: 'withheld',
        dispositionReason: 'render_failed',
        renderedSubject: null,
        renderedBody: null,
        lintDetail: [],
        moderationStatus: 'error',
        moderationDetail: {},
      });
      expect(insert).toHaveProperty('interpolationInputs.contact_first_name', 'Alice');
    }

    it('LLMStructuredOutputError withholds render_failed with the locked fills and continues the batch', async () => {
      mocks.runLlmTask.mockRejectedValue(
        new LLMStructuredOutputError('solicitation_ask', 'openai', new Error('bad json')),
      );
      const result = await runSingleAsk();
      expect(result).toEqual({ rendered: 0, withheld: 0, failed: 1, skippedExisting: 0 });
      expectRenderFailedFills();
      expect(mocks.moderateResponse).not.toHaveBeenCalled();
    });

    it('an effectively-empty (whitespace-only) LLM body is render_failed, not a rendered footer-only ask', async () => {
      mocks.runLlmTask.mockResolvedValue(llmResult({ subject: 'Hello', body: '   \n ' }));
      const result = await runSingleAsk();
      expect(result.failed).toBe(1);
      expectRenderFailedFills();
      expect(mocks.moderateResponse).not.toHaveBeenCalled();
    });

    it('k=0 hands closeBatchIfSettled the generation_failed failure (D14) and never fails the parent directly', async () => {
      mocks.runLlmTask.mockRejectedValue(
        new LLMStructuredOutputError('solicitation_ask', 'openai', new Error('bad json')),
      );
      await runSingleAsk();
      expect(mocks.closeBatchIfSettled).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          batchId: BATCH_ID,
          failure: { code: 'generation_failed', failedCount: 1, withheldCount: 0 },
        }),
      );
    });
  });

  describe('lint outcomes', () => {
    async function runSingleAsk() {
      sqlReturnQueue.push(
        mkTaggedResult([contextRow()]),
        mkTaggedResult([askRow(1)]),
        probeRow(0),
      );
      enqueueFinale(tallyRow(0, 0, 1));
      return generateAsksForBatch(sql, GENERATE_INPUT);
    }

    it('a missing postal address withholds lint_failed/missing_required_element with NULL bodies', async () => {
      sqlReturnQueue.push(
        mkTaggedResult([contextRow({ postal_address: null })]),
        mkTaggedResult([askRow(1)]),
        probeRow(0),
      );
      enqueueFinale(tallyRow(0, 0, 1));
      const result = await generateAsksForBatch(sql, GENERATE_INPUT);
      expect(result.withheld).toBe(1);
      expect(mocks.insertOutreachRender.mock.calls[0]![1]).toMatchObject({
        deliveryStatus: 'withheld',
        dispositionReason: 'lint_failed',
        lintDetail: ['missing_required_element'],
        renderedSubject: null,
        renderedBody: null,
        moderationStatus: 'error',
        moderationDetail: {},
      });
      expect(mocks.moderateResponse).not.toHaveBeenCalled();
    });

    it('a lint-blocked draft folds to lint_failed with matched classes and is never moderated (AMEND B1, decision 4)', async () => {
      mocks.runLlmTask.mockResolvedValue(
        llmResult({
          subject: 'Thanks for visiting Testers Cafe',
          body: 'Hi Alice, thanks for coming by Testers Cafe. Enjoy a discount next time you visit.',
        }),
      );
      const result = await runSingleAsk();
      expect(result.withheld).toBe(1);
      const insert = mocks.insertOutreachRender.mock.calls[0]![1] as Record<string, unknown>;
      expect(insert).toMatchObject({
        deliveryStatus: 'withheld',
        dispositionReason: 'lint_failed',
        moderationStatus: 'error',
      });
      expect(insert.lintDetail).toContain('incentive_language');
      expect(insert.renderedBody).not.toBeNull();
      expect(mocks.moderateResponse).not.toHaveBeenCalled();
    });
  });

  it('generates sequentially with the 1¢ estimate and never touches the reply concurrency slots', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow()]),
      mkTaggedResult([askRow(1), askRow(2)]),
      probeRow(0),
      probeRow(0),
    );
    enqueueFinale();

    await generateAsksForBatch(sql, GENERATE_INPUT);

    expect(SOLICITATION_ASK_ESTIMATE_CENTS).toBe(1);
    expect(mocks.reserveCost).toHaveBeenCalledTimes(2);
    for (const call of mocks.reserveCost.mock.calls) {
      expect(call).toEqual([BUSINESS_ID, 'copilot', SOLICITATION_ASK_ESTIMATE_CENTS]);
    }
    // SPEC §7.3: withConcurrency false — the shared per-business slots are for
    // latency-critical reply generation, never for the drip lane.
    expect(mocks.acquireConcurrencySlot).not.toHaveBeenCalled();
  });

  it('rethrows transient LLM failures without completing the outbox attempt', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow()]),
      mkTaggedResult([askRow(1)]),
      probeRow(0),
    );
    mocks.runLlmTask.mockRejectedValue(new TransientLLMError(new Error('socket hangup')));

    await expect(
      generateAsksForBatch(sql, GENERATE_INPUT),
    ).rejects.toBeInstanceOf(TransientLLMError);

    expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompletedIfOwned).not.toHaveBeenCalled();
    expect(mocks.recordGenerationSteps).not.toHaveBeenCalled();
  });

  describe('no-op paths complete the outbox attempt (a no-op is a SUCCESS)', () => {
    it('flag off: completes the outbox without loading anything', async () => {
      mocks.solicitationSendEnabled.mockReturnValue(false);
      const result = await generateAsksForBatch(sql, GENERATE_INPUT);
      expect(result).toEqual({ rendered: 0, withheld: 0, failed: 0, skippedExisting: 0 });
      expect(mocks.markOutboxCompletedIfOwned).toHaveBeenCalledTimes(1);
      expect(sqlCalls.filter((call) => call.text.includes('FROM solicitation_batches'))).toHaveLength(0);
      expect(mocks.startOrGetSolicitationSendBatchRun).not.toHaveBeenCalled();
    });

    it('subscription without full access: completes the outbox and generates nothing (invariant #11)', async () => {
      sqlReturnQueue.push(mkTaggedResult([contextRow({ subscription_status: 'cancelled' })]));
      const result = await generateAsksForBatch(sql, GENERATE_INPUT);
      expect(result).toEqual({ rendered: 0, withheld: 0, failed: 0, skippedExisting: 0 });
      expect(mocks.markOutboxCompletedIfOwned).toHaveBeenCalledTimes(1);
      expect(mocks.reserveCost).not.toHaveBeenCalled();
    });

    it('zero send asks: completes the outbox defensively', async () => {
      sqlReturnQueue.push(mkTaggedResult([contextRow()]), mkTaggedResult([]));
      const result = await generateAsksForBatch(sql, GENERATE_INPUT);
      expect(result).toEqual({ rendered: 0, withheld: 0, failed: 0, skippedExisting: 0 });
      expect(mocks.markOutboxCompletedIfOwned).toHaveBeenCalledTimes(1);
      expect(mocks.startOrGetSolicitationSendBatchRun).not.toHaveBeenCalled();
    });
  });

  it('a stale attempt at the parent-run step does nothing — no second send parent is minted', async () => {
    sqlReturnQueue.push(mkTaggedResult([contextRow()]), mkTaggedResult([askRow(1)]));
    mocks.lockDispatchedOutboxAttemptIfOwned.mockResolvedValue(false);

    const result = await generateAsksForBatch(sql, GENERATE_INPUT);

    expect(result).toEqual({ rendered: 0, withheld: 0, failed: 0, skippedExisting: 0 });
    expect(mocks.startOrGetSolicitationSendBatchRun).not.toHaveBeenCalled();
    expect(mocks.reserveCost).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompletedIfOwned).not.toHaveBeenCalled();
  });

  it('the finale runs the ownership CAS FIRST and aborts with zero domain writes when stale', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow()]),
      mkTaggedResult([askRow(1)]),
      probeRow(0),
    );
    // The finale CAS loses (watchdog re-dispatched while we generated).
    mocks.markOutboxCompletedIfOwned.mockResolvedValue(false);

    await generateAsksForBatch(sql, GENERATE_INPUT);

    expect(mocks.markOutboxCompletedIfOwned).toHaveBeenCalledTimes(1);
    expect(mocks.recordGenerationSteps).not.toHaveBeenCalled();
    expect(mocks.closeBatchIfSettled).not.toHaveBeenCalled();
    expect(mocks.acquireSolicitationBatchLock).not.toHaveBeenCalled();
  });

  it('an owned finale orders CAS → advisory lock → batch row → steps → close', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow()]),
      mkTaggedResult([askRow(1)]),
      probeRow(0),
    );
    enqueueFinale();
    const order: string[] = [];
    mocks.markOutboxCompletedIfOwned.mockImplementation(async () => {
      order.push('cas');
      return true;
    });
    mocks.acquireSolicitationBatchLock.mockImplementation(async () => {
      order.push('advisory');
    });
    mocks.recordGenerationSteps.mockImplementation(async () => {
      order.push('steps');
      return 1;
    });
    mocks.closeBatchIfSettled.mockImplementation(async () => {
      order.push('close');
      return { status: 'not_settled', liveCount: 1 };
    });

    await generateAsksForBatch(sql, GENERATE_INPUT);

    expect(order).toEqual(['cas', 'advisory', 'steps', 'close']);
  });
});

describe('regenerateAsk', () => {
  const REGEN_INPUT = { batchId: BATCH_ID, businessId: BUSINESS_ID, askId: 'ask-1', outboxHandle: OUTBOX };

  const currentRow = (deliveryStatus: string, attemptNo = 1) =>
    mkTaggedResult([{ delivery_status: deliveryStatus, attempt_no: attemptNo }]);

  /** FIFO through the pre-checks: context, ask, current outreach row. */
  function enqueuePreChecks(status = 'rendered') {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow()]),
      mkTaggedResult([askRow(1)]),
      currentRow(status),
    );
  }

  /** FIFO for the swap tx: batch lifecycle FOR UPDATE, locked row, parent run. */
  function enqueueSwap(status = 'rendered') {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow()]),
      currentRow(status),
      mkTaggedResult([{ id: 'parent-run-1' }]),
    );
  }

  it('refuses regeneration for a blocked ask', async () => {
    enqueuePreChecks('withheld');

    await regenerateAsk(sql, REGEN_INPUT);

    // Blocked is terminal (SPEC §8.2 r6): no spend, no supersede, no insert —
    // but the outbox attempt still completes (a refusal is a SUCCESS).
    expect(mocks.reserveCost).not.toHaveBeenCalled();
    expect(mocks.runLlmTask).not.toHaveBeenCalled();
    expect(mocks.supersedeLiveRender).not.toHaveBeenCalled();
    expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompletedIfOwned).toHaveBeenCalledTimes(1);
  });

  it('enforces the regen budget in the worker before any load — outbox replay cannot bypass it', async () => {
    mocks.checkAskRegenBudget.mockRejectedValue(new RegenBudgetExceededError('ask-1'));

    await regenerateAsk(sql, REGEN_INPUT);

    expect(mocks.checkAskRegenBudget).toHaveBeenCalledWith('ask-1');
    expect(mocks.reserveCost).not.toHaveBeenCalled();
    expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompletedIfOwned).toHaveBeenCalledTimes(1);
    expect(sqlCalls.filter((call) => call.text.includes('FROM solicitation_batches'))).toHaveLength(0);
  });

  it('refuses when the batch is not in a regenerable state (AMEND B2)', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow({ halted_at: new Date('2026-07-29T00:00:00Z') })]),
    );

    await regenerateAsk(sql, REGEN_INPUT);

    expect(mocks.runLlmTask).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompletedIfOwned).toHaveBeenCalledTimes(1);
  });

  it('swaps: supersede then insert at attempt_no + 1 with one regen step, CAS first (decision 7)', async () => {
    enqueuePreChecks('rendered');
    enqueueSwap('rendered');
    const order: string[] = [];
    mocks.markOutboxCompletedIfOwned.mockImplementation(async () => {
      order.push('cas');
      return true;
    });
    mocks.acquireSolicitationBatchLock.mockImplementation(async () => {
      order.push('advisory');
    });
    mocks.supersedeLiveRender.mockImplementation(async () => {
      order.push('supersede');
      return { priorAttemptNo: 1 };
    });
    mocks.insertOutreachRender.mockImplementation(async () => {
      order.push('insert');
      return 'outreach-2';
    });
    mocks.recordStep.mockImplementation(async () => {
      order.push('step');
    });
    mocks.closeBatchIfSettled.mockImplementation(async () => {
      order.push('close');
      return { status: 'not_settled', liveCount: 1 };
    });

    await regenerateAsk(sql, REGEN_INPUT);

    expect(order).toEqual(['cas', 'advisory', 'supersede', 'insert', 'step', 'close']);
    expect(mocks.insertOutreachRender.mock.calls[0]![1]).toMatchObject({
      askId: 'ask-1',
      attemptNo: 2,
      deliveryStatus: 'rendered',
      agentRunId: 'parent-run-1',
    });
    expect(mocks.recordStep).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 'parent-run-1',
        stepKey: 'ask_generated',
        detail: expect.objectContaining({ ask_id: 'ask-1', attempt_no: 2, regenerated: true }),
      }),
    );
    // Generation ran OUTSIDE the swap: no transaction was open around the LLM
    // call (decision 7) — the reserve happened before sql.begin was entered.
    expect(mocks.runLlmTask).toHaveBeenCalledTimes(1);
  });

  it('a blocked replacement still supersedes and inserts — the ask ends with no live render (AMEND B2)', async () => {
    mocks.runLlmTask.mockResolvedValue(
      llmResult({
        subject: 'Thanks for visiting Testers Cafe',
        body: 'Hi Alice, thanks for coming by Testers Cafe. Enjoy a discount next time.',
      }),
    );
    enqueuePreChecks('rendered');
    enqueueSwap('rendered');

    await regenerateAsk(sql, REGEN_INPUT);

    expect(mocks.supersedeLiveRender).toHaveBeenCalledTimes(1);
    expect(mocks.insertOutreachRender.mock.calls[0]![1]).toMatchObject({
      deliveryStatus: 'withheld',
      dispositionReason: 'lint_failed',
      attemptNo: 2,
    });
    // A withheld replacement terminalizes the ask, so the swap joins in the
    // SAME transaction (outreach.ts single-join contract) — blocking the last
    // live render must not strand the batch un-settled until expiry.
    expect(mocks.closeBatchIfSettled).toHaveBeenCalledWith(
      expect.anything(),
      { batchId: BATCH_ID, accountId: ACCOUNT_ID, businessId: BUSINESS_ID },
    );
  });

  it('a failed re-verification under the locks rolls back the swap but still completes the outbox', async () => {
    enqueuePreChecks('rendered');
    // Between generation and the swap the row was released: re-verify fails.
    enqueueSwap('queued');

    await regenerateAsk(sql, REGEN_INPUT);

    expect(mocks.supersedeLiveRender).not.toHaveBeenCalled();
    expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
    // Once inside the aborted swap (rolled back), once in the minimal
    // completion transaction: the attempt never strands in dispatched.
    expect(mocks.markOutboxCompletedIfOwned).toHaveBeenCalledTimes(2);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'ask regeneration discarded after generation',
      expect.objectContaining({ ask_id: 'ask-1' }),
    );
    // The spend is still audited (accepted rare waste).
    expect(mocks.recordApiCost).toHaveBeenCalledTimes(1);
  });

  it('a stale outbox attempt aborts the swap with zero writes and no extra completion', async () => {
    enqueuePreChecks('rendered');
    mocks.markOutboxCompletedIfOwned.mockResolvedValue(false);

    await regenerateAsk(sql, REGEN_INPUT);

    expect(mocks.supersedeLiveRender).not.toHaveBeenCalled();
    expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompletedIfOwned).toHaveBeenCalledTimes(1);
  });
});
