import type { Sql } from 'postgres';
import fc from 'fast-check';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql, mkTaggedResult } =
  await vi.hoisted(async () => {
    const helpers = await import('../../../../worker/__tests__/helpers/mock-sql');
    return { ...helpers.createMockSql(), mkTaggedResult: helpers.mkTaggedResult };
  });

const mocks = vi.hoisted(() => ({
  lockDispatchedOutboxAttemptIfOwned: vi.fn(),
  markOutboxCompletedIfOwned: vi.fn(),
  markOutboxFailed: vi.fn(),
  startOrGetSolicitationSendBatchRun: vi.fn(),
  recordGenerationSteps: vi.fn(),
  recordStep: vi.fn(),
  acquireSolicitationBatchLock: vi.fn(),
  insertOutreachRender: vi.fn(),
  supersedeLiveRender: vi.fn(),
  closeBatchIfSettled: vi.fn(),
  solicitationSendEnabled: vi.fn(),
  solicitationAutoApprovalEnabled: vi.fn(),
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
  // #1011 — the Refusal ledger's writer. Mocked HERE and only here: this
  // suite drives `sql` through the fragment-aware mock whose return queue is a
  // strict FIFO, so an unmocked ledger INSERT would shift a queued result out
  // from under the next real query in every pre-existing test. The live-DB
  // sibling runs the REAL helper against the REAL table, which is where the
  // row's validity, its transaction and the kill switch are proven.
  //
  // BOTH ARMS, NEVER ONE (#1082). The ledger is one module with two arms and
  // this lane uses both: `settleGenerationExhaustion` batches its holes into
  // `writeRefusalEvents`, the other three writers stay single-row. Mocking
  // only `writeRefusalEvent` leaves `refusalCalls()` blind to the batching
  // lane and every negative assertion below naming one half of a two-half
  // writer — green, and covering nothing.
  writeRefusalEvent: vi.fn(),
  writeRefusalEvents: vi.fn(),
  logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/shared/outbox', () => ({
  lockDispatchedOutboxAttemptIfOwned: mocks.lockDispatchedOutboxAttemptIfOwned,
  markOutboxCompletedIfOwned: mocks.markOutboxCompletedIfOwned,
  markOutboxFailed: mocks.markOutboxFailed,
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
  // #631 Task 4: the finale's auto-approval hook (../auto-approval.ts) reads
  // this flag too — same resolved module, same mock. Defaulted off below so
  // the hook's default outcome is an `auto_flag_off` decline, not a thrown
  // "not a function".
  solicitationAutoApprovalEnabled: mocks.solicitationAutoApprovalEnabled,
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
vi.mock('@/lib/refusals/write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/refusals/write')>()),
  writeRefusalEvent: mocks.writeRefusalEvent,
  writeRefusalEvents: mocks.writeRefusalEvents,
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
import { ANTHROPIC_MODEL } from '@/lib/llm/tasks';
import {
  generateAsksForBatch,
  isRegenerableBatchState,
  regenerateAsk,
  settleGenerationExhaustion,
  SOLICITATION_ASK_ESTIMATE_CENTS,
} from '../ask-generation';
import { BATCH_STATES, type BatchState } from '../outreach';

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

/** The per-child persist tx re-reads the batch lifecycle FOR UPDATE (round-2 finding 2). */
const lifecycleRow = (overrides: Record<string, unknown> = {}) =>
  mkTaggedResult([contextRow(overrides)]);

const tallyRow = (alive: number, failedCount = 0, withheldCount = 0) =>
  mkTaggedResult([{ alive, failed_count: failedCount, withheld_count: withheldCount }]);

/**
 * The finale's auto-approval hook (#631 Task 4, `runFinaleAutoApproval` in
 * ../auto-approval.ts) fires whenever the finale stays open with a live row
 * (`tally.alive > 0` and `closeBatchIfSettled` — defaulted `not_settled` in
 * `beforeEach` — agrees) AND both process-env flags pass: the perf follow-up
 * checks `solicitationSendEnabled`/`solicitationAutoApprovalEnabled` FIRST,
 * BEFORE taking the account lock or reading any DB-backed condition — so
 * with this suite's default flags (`solicitationSendEnabled` true,
 * `solicitationAutoApprovalEnabled` false, see `beforeEach`), the hook
 * declines on `auto_flag_off` WITHOUT touching `sql` at all, and these four
 * queries are never owed. Only a test that flips
 * `solicitationAutoApprovalEnabled` on (alongside the send flag) reaches
 * `lockAutonomyAccount`/`readAutoApprovalConditions` and needs this queued.
 */
function enqueueAutoApprovalDecline() {
  sqlReturnQueue.push(
    mkTaggedResult([{ id: ACCOUNT_ID }]), // lockAutonomyAccount
    mkTaggedResult([{ subscription_status: 'active', subscription_tier: 'copilot' }]), // readAutoApprovalConditions: account
    mkTaggedResult([{ any_suspended: false }]), // readAutoApprovalConditions: suspension
    mkTaggedResult([]), // readAutoApprovalConditions: solicitation policy row (none)
  );
}

/** FIFO for the finale transaction: batch FOR UPDATE row, then the tally —
 *  plus the auto-approval hook's four queries, but ONLY when the tally
 *  reports a live row AND both process-env flags are on for this test (see
 *  {@link enqueueAutoApprovalDecline}) — otherwise the flag pre-check declines
 *  before ever reaching `sql`, and the DB-backed conditions are unread. */
function enqueueFinale(tally = tallyRow(1)) {
  sqlReturnQueue.push(mkTaggedResult([{ id: BATCH_ID }]), tally);
  const bothFlagsOn =
    mocks.solicitationSendEnabled() === true && mocks.solicitationAutoApprovalEnabled() === true;
  if ((tally[0]?.alive ?? 0) > 0 && bothFlagsOn) enqueueAutoApprovalDecline();
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
  mocks.solicitationAutoApprovalEnabled.mockReturnValue(false);
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
  mocks.writeRefusalEvent.mockResolvedValue(undefined);
  mocks.writeRefusalEvents.mockResolvedValue(undefined);
});

describe('generateAsksForBatch', () => {
  it('skips reservation for asks that already hold a live render at the current prompt version', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow()]),
      mkTaggedResult([askRow(1), askRow(2)]),
      lifecycleRow(), // parent-mint revalidation
      probeRow(1), // ask-1 already holds a live render
      probeRow(0), // ask-2 is un-generated
      lifecycleRow(), // ask-2 persist revalidation
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
      lifecycleRow(), // parent-mint revalidation
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
      lifecycleRow(), // parent-mint revalidation
      probeRow(0), // ask-1: renders
      lifecycleRow(), // ask-1 persist revalidation
      probeRow(0), // ask-2: reserve throws
      probeRow(0), // ask-2 re-probe inside the budget-stop settle
      lifecycleRow(), // ask-2 persist revalidation
      probeRow(0), // ask-3 probe inside the budget-stop settle
      lifecycleRow(), // ask-3 persist revalidation
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
        lifecycleRow(), // parent-mint revalidation
        probeRow(0),
        lifecycleRow(),
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
        lifecycleRow(), // parent-mint revalidation
        probeRow(0),
        lifecycleRow(),
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
        lifecycleRow(), // parent-mint revalidation
        probeRow(0),
        lifecycleRow(),
      );
      enqueueFinale(tallyRow(0, 0, 1));
      return generateAsksForBatch(sql, GENERATE_INPUT);
    }

    it('a missing postal address withholds lint_failed/missing_required_element with NULL bodies', async () => {
      sqlReturnQueue.push(
        mkTaggedResult([contextRow({ postal_address: null })]),
        mkTaggedResult([askRow(1)]),
        lifecycleRow(), // parent-mint revalidation
        probeRow(0),
        lifecycleRow(),
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
      lifecycleRow(), // parent-mint revalidation
      probeRow(0),
      lifecycleRow(),
      probeRow(0),
      lifecycleRow(),
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
      lifecycleRow(), // parent-mint revalidation
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
      lifecycleRow(), // parent-mint revalidation
      probeRow(0),
      lifecycleRow(),
    );
    // The finale CAS loses (watchdog re-dispatched while we generated).
    mocks.markOutboxCompletedIfOwned.mockResolvedValue(false);

    await generateAsksForBatch(sql, GENERATE_INPUT);

    expect(mocks.markOutboxCompletedIfOwned).toHaveBeenCalledTimes(1);
    expect(mocks.recordGenerationSteps).not.toHaveBeenCalled();
    expect(mocks.closeBatchIfSettled).not.toHaveBeenCalled();
    // Exactly two advisory acquisitions — parent mint + child persist; the
    // stale finale itself must never reach its own advisory lock.
    expect(mocks.acquireSolicitationBatchLock).toHaveBeenCalledTimes(2);
  });

  it('an owned finale orders CAS → advisory lock → batch row → steps → close', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow()]),
      mkTaggedResult([askRow(1)]),
      lifecycleRow(), // parent-mint revalidation
      probeRow(0),
      lifecycleRow(),
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

    // The two leading 'advisory' entries are the parent-mint (round-3
    // finding 2) and child-persist (round-2 finding 2) B11 acquisitions; the
    // finale's ladder follows unchanged.
    expect(order).toEqual(['advisory', 'advisory', 'cas', 'advisory', 'steps', 'close']);
  });

  describe('lifecycle revalidation (codex round-2 finding 2 + round-3 finding 2)', () => {
    it('a batch no longer built at start refuses to mint a parent and completes the outbox', async () => {
      sqlReturnQueue.push(
        mkTaggedResult([contextRow()]),
        mkTaggedResult([askRow(1)]),
        lifecycleRow({ halted_at: new Date() }), // parent-mint revalidation
      );

      const result = await generateAsksForBatch(sql, GENERATE_INPUT);

      expect(result).toEqual({ rendered: 0, withheld: 0, failed: 0, skippedExisting: 0 });
      expect(mocks.startOrGetSolicitationSendBatchRun).not.toHaveBeenCalled();
      expect(mocks.runLlmTask).not.toHaveBeenCalled();
      // Any orphan parent from a prior attempt is closed when settled.
      expect(mocks.closeBatchIfSettled).toHaveBeenCalledTimes(1);
      expect(mocks.markOutboxCompletedIfOwned).toHaveBeenCalledTimes(1);
      expect(mocks.logger.log).toHaveBeenCalledWith(
        'ask generation no-op: batch not generatable at start',
        expect.objectContaining({ batch_state: 'halted' }),
      );
    });

    it('a halt that lands mid-generation stops the lane: no insert, spend audited, lane closed-if-settled', async () => {
      sqlReturnQueue.push(
        mkTaggedResult([contextRow()]),
        mkTaggedResult([askRow(1)]),
        lifecycleRow(), // parent-mint revalidation (still built)
        probeRow(0),
        lifecycleRow({ halted_at: new Date() }), // child persist revalidation
      );

      const result = await generateAsksForBatch(sql, GENERATE_INPUT);

      expect(result).toEqual({ rendered: 0, withheld: 0, failed: 0, skippedExisting: 0 });
      expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
      // The discarded render's spend is still audited (regen-door precedent).
      expect(mocks.recordApiCost).toHaveBeenCalledTimes(1);
      // The stop is a SUCCESS no-op: outbox completes, the FINALE never runs
      // (no steps) but the lane still closes-if-settled so no orphan parent
      // survives the stop (round-3 finding 2).
      expect(mocks.markOutboxCompletedIfOwned).toHaveBeenCalledTimes(1);
      expect(mocks.recordGenerationSteps).not.toHaveBeenCalled();
      expect(mocks.closeBatchIfSettled).toHaveBeenCalledTimes(1);
      const closeArgs = mocks.closeBatchIfSettled.mock.calls[0]![1] as Record<string, unknown>;
      expect(closeArgs.failure).toBeUndefined();
      expect(mocks.logger.log).toHaveBeenCalledWith(
        'ask generation stopped: batch left generatable state mid-run',
        expect.objectContaining({ batch_state: 'halted' }),
      );
    });

    it('an expired batch refuses new renders on a late re-drive and closes when settled', async () => {
      sqlReturnQueue.push(
        mkTaggedResult([contextRow()]),
        mkTaggedResult([askRow(1)]),
        lifecycleRow(), // parent-mint revalidation (still built)
        probeRow(0),
        lifecycleRow({ built_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) }),
      );

      const result = await generateAsksForBatch(sql, GENERATE_INPUT);

      expect(result).toEqual({ rendered: 0, withheld: 0, failed: 0, skippedExisting: 0 });
      expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
      expect(mocks.closeBatchIfSettled).toHaveBeenCalledTimes(1);
      expect(mocks.logger.log).toHaveBeenCalledWith(
        'ask generation stopped: batch left generatable state mid-run',
        expect.objectContaining({ batch_state: 'expired' }),
      );
    });

    it('a stale outbox attempt at child persist stops writing and leaves the outbox to its new owner', async () => {
      sqlReturnQueue.push(
        mkTaggedResult([contextRow()]),
        mkTaggedResult([askRow(1)]),
        lifecycleRow(), // parent-mint revalidation
        probeRow(0),
      );
      // Parent-run gate owns the attempt; the watchdog re-dispatches before
      // the child persists.
      mocks.lockDispatchedOutboxAttemptIfOwned
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const result = await generateAsksForBatch(sql, GENERATE_INPUT);

      expect(result).toEqual({ rendered: 0, withheld: 0, failed: 0, skippedExisting: 0 });
      expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
      expect(mocks.recordApiCost).toHaveBeenCalledTimes(1);
      expect(mocks.markOutboxCompletedIfOwned).not.toHaveBeenCalled();
      // A stale job never closes the lane — the newer attempt owns it.
      expect(mocks.closeBatchIfSettled).not.toHaveBeenCalled();
    });
  });

  it('a structured-output failure finalizes the billed spend and audits every attempt (codex round-2 finding 1)', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow()]),
      mkTaggedResult([askRow(1)]),
      lifecycleRow(), // parent-mint revalidation
      probeRow(0),
      lifecycleRow(),
    );
    enqueueFinale(tallyRow(0, 1, 0));
    mocks.runLlmTask.mockRejectedValue(
      new LLMStructuredOutputError('solicitation_ask', 'anthropic', new Error('bad json'), [
        {
          provider: 'openai',
          model: OPENAI_MODEL,
          usage: { promptTokens: 500, completionTokens: 120 },
        },
        {
          provider: 'anthropic',
          model: ANTHROPIC_MODEL,
          usage: { promptTokens: 500, completionTokens: 110 },
        },
      ]),
    );

    const result = await generateAsksForBatch(sql, GENERATE_INPUT);

    expect(result).toEqual({ rendered: 0, withheld: 0, failed: 1, skippedExisting: 0 });
    // The reservation is FINALIZED against the billed completions, never
    // released as if nothing ran.
    expect(mocks.finalizeCost).toHaveBeenCalledTimes(1);
    expect(mocks.releaseCost).not.toHaveBeenCalled();
    // One api_costs audit row per billed attempt, each under its own model.
    expect(mocks.recordApiCost).toHaveBeenCalledTimes(2);
    const audited = mocks.recordApiCost.mock.calls.map(
      (call) => (call[1] as { provider: string; costUsd: number }),
    );
    expect(audited[0]).toMatchObject({ provider: 'openai' });
    expect(audited[1]).toMatchObject({ provider: 'anthropic' });
    for (const row of audited) expect(row.costUsd).toBeGreaterThan(0);
    // The child itself is still the locked render_failed shape.
    expect(mocks.insertOutreachRender.mock.calls[0]![1]).toMatchObject({
      deliveryStatus: 'withheld',
      dispositionReason: 'render_failed',
    });
  });
});

describe('settleGenerationExhaustion (codex round-2 finding 4)', () => {
  const DEAD_LETTER_INPUT = {
    batchId: BATCH_ID,
    businessId: BUSINESS_ID,
    outboxHandle: OUTBOX,
    errorClass: 'Error',
  };

  it('fills withheld render_failed rows for un-rendered send asks and closes generation_failed', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ account_id: ACCOUNT_ID }]), // batch FOR UPDATE
      mkTaggedResult([
        { ask_id: 'ask-2', contact_id: 'contact-2', next_attempt: 1 },
        { ask_id: 'ask-3', contact_id: 'contact-3', next_attempt: 1 },
      ]), // holes
      mkTaggedResult([{ id: 'parent-run-1' }]), // send parent
      tallyRow(0, 3, 0), // nothing live after the fills
    );
    mocks.markOutboxFailed.mockResolvedValue(true);
    mocks.closeBatchIfSettled.mockResolvedValue({
      status: 'closed',
      parentRunId: 'parent-run-1',
      disposition: 'generation_failed',
      parentStatus: 'failed',
      counts: {},
    });

    const settled = await settleGenerationExhaustion(sql, DEAD_LETTER_INPUT);

    expect(settled.status).toBe('settled');
    if (settled.status !== 'settled') throw new Error('unreachable');
    expect(settled.filled).toBe(2);
    expect(mocks.markOutboxFailed).toHaveBeenCalledWith(
      expect.anything(),
      OUTBOX.outboxId,
      'generate_solicitation_asks_exhausted:Error',
      OUTBOX.attempt,
    );
    expect(mocks.insertOutreachRender).toHaveBeenCalledTimes(2);
    expect(mocks.insertOutreachRender.mock.calls[0]![1]).toMatchObject({
      askId: 'ask-2',
      deliveryStatus: 'withheld',
      dispositionReason: 'render_failed',
      interpolationInputs: {},
      agentRunId: 'parent-run-1',
      attemptNo: 1,
    });
    expect(mocks.recordGenerationSteps).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ parentRunId: 'parent-run-1', batchId: BATCH_ID }),
    );
    expect(mocks.closeBatchIfSettled).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        batchId: BATCH_ID,
        failure: { code: 'generation_failed', failedCount: 3, withheldCount: 0 },
      }),
    );
  });

  it('keeps genuinely rendered rows live: no failure handed over while something is alive', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([{ account_id: ACCOUNT_ID }]),
      mkTaggedResult([{ ask_id: 'ask-3', contact_id: 'contact-3', next_attempt: 1 }]),
      mkTaggedResult([{ id: 'parent-run-1' }]),
      tallyRow(2, 1, 0), // two rendered rows stay approvable
    );
    mocks.markOutboxFailed.mockResolvedValue(true);
    mocks.closeBatchIfSettled.mockResolvedValue({ status: 'not_settled', liveCount: 2 });

    const settled = await settleGenerationExhaustion(sql, DEAD_LETTER_INPUT);

    expect(settled.status).toBe('settled');
    const closeArgs = mocks.closeBatchIfSettled.mock.calls[0]![1] as Record<string, unknown>;
    expect(closeArgs.failure).toBeUndefined();
  });

  it('a stale attempt writes nothing', async () => {
    mocks.markOutboxFailed.mockResolvedValue(false);

    const settled = await settleGenerationExhaustion(sql, DEAD_LETTER_INPUT);

    expect(settled).toEqual({ status: 'stale' });
    expect(mocks.acquireSolicitationBatchLock).not.toHaveBeenCalled();
    expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
    expect(mocks.closeBatchIfSettled).not.toHaveBeenCalled();
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

    // Charged by logical request: the outbox id is the idempotency key, so
    // BullMQ replays of this same regeneration reuse the charge.
    expect(mocks.checkAskRegenBudget).toHaveBeenCalledWith('ask-1', 'outbox-1');
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

  it('refuses a regenerate once the batch is approved, leaving the live render untouched', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow({ approved_at: new Date(Date.now() - 60_000) })]),
    );

    await regenerateAsk(sql, REGEN_INPUT);

    // ADR 0020: approved bytes are final. No spend, no supersede, no insert —
    // and the outbox attempt still completes, because a refusal is a SUCCESS.
    expect(mocks.runLlmTask).not.toHaveBeenCalled();
    expect(mocks.supersedeLiveRender).not.toHaveBeenCalled();
    expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompletedIfOwned).toHaveBeenCalledTimes(1);
  });

  it('refuses a regenerate in veto_window and in sending, the two states amendment B2 previously allowed', async () => {
    const approvedAt = new Date(Date.now() - 60_000);

    // veto_window: approved, deadline still ahead.
    sqlReturnQueue.push(
      mkTaggedResult([
        contextRow({
          approved_at: approvedAt,
          veto_deadline_at: new Date(Date.now() + 10 * 60_000),
        }),
      ]),
    );
    await regenerateAsk(sql, REGEN_INPUT);

    // sending: the drip has started.
    sqlReturnQueue.push(
      mkTaggedResult([
        contextRow({ approved_at: approvedAt, sending_started_at: approvedAt }),
      ]),
    );
    await regenerateAsk(sql, REGEN_INPUT);

    expect(mocks.runLlmTask).not.toHaveBeenCalled();
    expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompletedIfOwned).toHaveBeenCalledTimes(2);
  });

  it('aborts the swap when the batch is approved between the pre-check and the locked re-check', async () => {
    // Pre-checks see `built`; the locked re-read sees `approved`. This is the
    // owner clicking regenerate and then approving before the worker ran.
    enqueuePreChecks('rendered');
    sqlReturnQueue.push(
      mkTaggedResult([contextRow({ approved_at: new Date() })]),
    );

    await regenerateAsk(sql, REGEN_INPUT);

    // The replacement was generated (spend happened, and is audited) but the
    // swap rolled back: nothing supersedes an approved render.
    expect(mocks.runLlmTask).toHaveBeenCalled();
    expect(mocks.supersedeLiveRender).not.toHaveBeenCalled();
    expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
    expect(mocks.recordApiCost).toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'ask regeneration discarded after generation',
      expect.objectContaining({ reason: 'batch_not_regenerable:approved' }),
    );
  });

  describe('invariants', () => {
    it('property: regeneration is accepted for the built batch state and refused for every other', () => {
      const ALL_STATES: BatchState[] = [
        'pending',
        'built',
        'approved',
        'veto_window',
        'sending',
        'closed',
        'halted',
        'expired',
      ];
      // The annotation rejects a non-state; this rejects an OMITTED one, since
      // BATCH_STATES is the union's single source of truth. Together they are
      // the exhaustiveness proof — a ninth state cannot slip past unclassified.
      expect([...ALL_STATES].sort()).toEqual([...BATCH_STATES].sort());

      fc.assert(
        fc.property(fc.constantFrom(...ALL_STATES), (state) => {
          expect(isRegenerableBatchState(state)).toBe(state === 'built');
        }),
      );
    });
  });
});

// ── #1011 · the outreach_withheld RENDER lane ────────────────────────────────
//
// FOUR writers, THREE physical ledger call sites (`settleBudgetStop` reuses
// `persistChildRender`'s). What lives HERE rather than in the live-DB sibling:
// the SHAPE of every call (lane, code, category, subject, tenant) and the two
// properties a row read back out of Postgres cannot show —
//
//   * that the `Date` handed to the ledger is the SAME INSTANCE the outreach
//     insert carried, not a second `new Date()` that happened to land in the
//     same millisecond (round 1, R1-9), and
//   * that the guard paths call NEITHER writer, which a zero-row count in the
//     database cannot distinguish from a row written and then rolled back.
describe('the outreach_withheld render lane (#1011)', () => {
  interface RefusalCall {
    accountId: string;
    businessId: string | null;
    refusalSource: string;
    refusalCode: string | null;
    allRefusalCodes: readonly string[] | null;
    refusalCategory: string;
    subjectType: string | null;
    subjectId: string | null;
    occurredAt: Date | 'transaction_time';
  }

  /**
   * Every Refusal this lane proposed, across BOTH ledger arms, in the order
   * the lane proposed them (#1082).
   *
   * `invocationCallOrder` IS NOT LOAD-BEARING TODAY, AND SAYING SO IS THE
   * POINT. An earlier version of this docblock claimed arm-order
   * concatenation "mis-pairs every row the moment a second arm appears". The
   * red-team pass falsified it: replacing the sort with plain
   * `[...single, ...set]` leaves the suite green, because the only test that
   * mixes arms runs the writers W1 -> W2 -> W3 -> W4 and W4 is the only
   * set-arm writer, so its calls are already last. That is happenstance of
   * test order, not a property of the helper.
   *
   * THE SORT STAYS ANYWAY, for order-INDEPENDENCE rather than for today.
   * The matrix test below pairs `refusalCalls()[i]` with `withheld[i]`
   * positionally against `insertOutreachRender`'s own call order, so a later
   * test that interleaves the arms — W4 before W1, say — would mis-pair every
   * row under plain concatenation, and silently. The counter is global and
   * monotonic across mocks, so sorting on it costs nothing and removes the
   * trap. Indexing it is safe: `mockClear` empties `calls` and
   * `invocationCallOrder` in one function and the two are pushed on adjacent
   * unconditional lines (`@vitest/spy`), so they cannot desync.
   *
   * A SET CALL FLATTENS IN ITS INPUT ORDER, which is the loop order the lane
   * collected the holes in — so the fan-out reads exactly as N single-row
   * calls would have. The count is the ROW count, never the call count: that
   * is the property #1082 changed the lane to preserve.
   */
  const refusalCalls = (): RefusalCall[] => {
    const single = mocks.writeRefusalEvent.mock.calls.map((call, index) => ({
      order: mocks.writeRefusalEvent.mock.invocationCallOrder[index]!,
      inputs: [call[1] as RefusalCall],
    }));
    const set = mocks.writeRefusalEvents.mock.calls.map((call, index) => ({
      order: mocks.writeRefusalEvents.mock.invocationCallOrder[index]!,
      inputs: [...(call[1] as readonly RefusalCall[])],
    }));
    return [...single, ...set]
      .sort((left, right) => left.order - right.order)
      .flatMap((invocation) => invocation.inputs);
  };

  /** Both arms, for the guard paths that must reach NEITHER (#1082). */
  const expectNoRefusalWrite = (): void => {
    expect(mocks.writeRefusalEvent).not.toHaveBeenCalled();
    expect(mocks.writeRefusalEvents).not.toHaveBeenCalled();
  };

  /**
   * Both arms, for a test that drives several writers in PHASES and asserts
   * between them (#1082).
   *
   * A ONE-ARMED CLEAR IS THE TRAP THE SORT ABOVE EXISTS FOR, which is why
   * this is a helper and not two lines at each site. Clearing only
   * `writeRefusalEvent` leaves an earlier phase's set-arm call in the mock;
   * its `invocationCallOrder` is lower than the current phase's, so it sorts
   * FIRST and shifts every positional assertion by one. That is silent — the
   * lengths still match if the phases happen to be the same size.
   */
  const clearRefusalCalls = (): void => {
    mocks.writeRefusalEvent.mockClear();
    mocks.writeRefusalEvents.mockClear();
  };

  const insertInputs = (): Record<string, unknown>[] =>
    mocks.insertOutreachRender.mock.calls.map((call) => call[1] as Record<string, unknown>);

  /** Distinct ids per insert, so a subject traces to the row that minted it. */
  function mintDistinctOutreachIds(): void {
    let minted = 0;
    mocks.insertOutreachRender.mockImplementation(async () => `outreach-${++minted}`);
  }

  /** W1: one ask, one child — the withhold reason is the caller's to choose. */
  async function runSingleChild(contextOverrides: Record<string, unknown> = {}): Promise<void> {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow(contextOverrides)]),
      mkTaggedResult([askRow(1)]),
      lifecycleRow(), // parent-mint revalidation
      probeRow(0),
      lifecycleRow(), // child persist revalidation
    );
    enqueueFinale(tallyRow(0, 0, 1));
    await generateAsksForBatch(sql, GENERATE_INPUT);
  }

  /** W2: ask-1 renders, ask-2's reservation is refused, asks 2+3 are settled. */
  async function runBudgetStop(): Promise<void> {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow()]),
      mkTaggedResult([askRow(1), askRow(2), askRow(3)]),
      lifecycleRow(), // parent-mint revalidation
      probeRow(0), // ask-1: renders
      lifecycleRow(), // ask-1 persist revalidation
      probeRow(0), // ask-2: reserve throws
      probeRow(0), // ask-2 re-probe inside the settle
      lifecycleRow(), // ask-2 persist revalidation
      probeRow(0), // ask-3 probe inside the settle
      lifecycleRow(), // ask-3 persist revalidation
    );
    enqueueFinale();
    mocks.reserveCost
      .mockResolvedValueOnce('2026-07-30')
      .mockRejectedValueOnce(new CostLimitExceededError(BUSINESS_ID));
    await generateAsksForBatch(sql, GENERATE_INPUT);
  }

  const LANE_REGEN_INPUT = {
    batchId: BATCH_ID,
    businessId: BUSINESS_ID,
    askId: 'ask-1',
    outboxHandle: OUTBOX,
  };

  /** W3: a RENDERED current row re-rolled into a replacement attempt. */
  async function runRegeneration(contextOverrides: Record<string, unknown> = {}): Promise<void> {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow(contextOverrides)]), // loadBatchContext
      mkTaggedResult([askRow(1)]), // loadSendAskById
      mkTaggedResult([{ delivery_status: 'rendered', attempt_no: 1 }]), // pre-check row
      mkTaggedResult([contextRow()]), // swap: batch lifecycle FOR UPDATE
      mkTaggedResult([{ delivery_status: 'rendered', attempt_no: 1 }]), // swap: locked row
      mkTaggedResult([{ id: 'parent-run-1' }]), // swap: send parent
    );
    await regenerateAsk(sql, LANE_REGEN_INPUT);
  }

  const LANE_DEAD_LETTER_INPUT = {
    batchId: BATCH_ID,
    businessId: BUSINESS_ID,
    outboxHandle: OUTBOX,
    errorClass: 'Error',
  };

  /** W4: terminal exhaustion filling `holeCount` holes in ONE invocation. */
  async function runExhaustion(holeCount: number): Promise<void> {
    sqlReturnQueue.push(
      mkTaggedResult([{ account_id: ACCOUNT_ID }]), // batch FOR UPDATE
      mkTaggedResult(
        Array.from({ length: holeCount }, (_unused, index) => ({
          ask_id: `ask-${index + 1}`,
          contact_id: `contact-${index + 1}`,
          next_attempt: 1,
        })),
      ),
      mkTaggedResult([{ id: 'parent-run-1' }]), // send parent
      tallyRow(0, holeCount, 0),
    );
    mocks.markOutboxFailed.mockResolvedValue(true);
    await settleGenerationExhaustion(sql, LANE_DEAD_LETTER_INPUT);
  }

  it('the render lane maps render_failed and lint_failed to below_our_bar and moderation_high to unsafe_content', async () => {
    // `render_failed` and `lint_failed` are DIFFERENT codes sharing ONE
    // category — the owner-facing fact is identical, the debugging fact is
    // not. Each reason is produced by the path that really emits it, so a
    // hand-written reason→category table cannot stand in for this.
    mocks.runLlmTask.mockRejectedValueOnce(
      new LLMStructuredOutputError('solicitation_ask', 'openai', new Error('bad json')),
    );
    await runSingleChild();
    expect(refusalCalls()).toHaveLength(1);
    expect(refusalCalls()[0]).toMatchObject({
      refusalCode: 'render_failed',
      refusalCategory: 'below_our_bar',
    });

    clearRefusalCalls();
    resetMockSql();
    // No attested postal address (#622 §7.6): the footer cannot be assembled.
    await runSingleChild({ postal_address: null });
    expect(refusalCalls()).toHaveLength(1);
    expect(refusalCalls()[0]).toMatchObject({
      refusalCode: 'lint_failed',
      refusalCategory: 'below_our_bar',
    });

    clearRefusalCalls();
    resetMockSql();
    mocks.moderateResponse.mockResolvedValue({
      ...cleanModeration(),
      flagged: true,
      severity: 'high',
      reason: 'harassment',
      providerStatus: null,
    });
    await runSingleChild();
    expect(refusalCalls()).toHaveLength(1);
    expect(refusalCalls()[0]).toMatchObject({
      refusalCode: 'moderation_high',
      refusalCategory: 'unsafe_content',
    });
  });

  it('every render-lane refusal_events row carries subject_type solicitation_outreach and the account and location of the generation context', async () => {
    mintDistinctOutreachIds();
    await runSingleChild({ postal_address: null });

    expect(refusalCalls()).toEqual([
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        // C3's `AtLocation` arm: this lane always names the location, so a
        // null here would make an account-wide claim the lane never makes.
        businessId: BUSINESS_ID,
        subjectType: 'solicitation_outreach',
        subjectId: 'outreach-1',
      }),
    ]);
  });

  it('every render-lane refusal_events row carries refusal_source outreach_withheld and refusal_code equal to its solicitation_outreach disposition_reason', async () => {
    // `WriteRefusalEventInput` accepts ANY string as the code, so a
    // valid-but-wrong reason keeps the expected category and survives a
    // category-only assertion (round 1, R1-8). The code is pinned against the
    // paired outreach row's own `dispositionReason`, never against a literal.
    mintDistinctOutreachIds();
    await runBudgetStop();

    const withheld = insertInputs().filter((input) => input.deliveryStatus === 'withheld');
    expect(withheld).toHaveLength(2);
    expect(refusalCalls()).toHaveLength(2);
    for (const [index, call] of refusalCalls().entries()) {
      expect(call.refusalSource).toBe('outreach_withheld');
      expect(call.refusalCode).toBe(withheld[index]!.dispositionReason);
      expect(call.allRefusalCodes).toBeNull();
    }
  });

  it("all four render writers carry the paired outreach's tenant category subject and occurred_at shape", async () => {
    // The cross-writer matrix. `persistChildRender` and `settleBudgetStop`
    // share a call site; `regenerateAsk` and `settleGenerationExhaustion` do
    // not, and a Refusal shaped right at one of them proves nothing about the
    // other two (round 1, R1-8).
    mintDistinctOutreachIds();

    await runSingleChild({ postal_address: null }); // W1
    resetMockSql();
    await runBudgetStop(); // W2 — two settled rows in ONE call
    resetMockSql();
    await runRegeneration({ postal_address: null }); // W3
    resetMockSql();
    await runExhaustion(2); // W4 — two holes in ONE call

    const inserts = insertInputs();
    const withheld = inserts.filter((input) => input.deliveryStatus === 'withheld');
    // 1 (W1) + 2 (W2) + 1 (W3) + 2 (W4). The count is the writers' per-row
    // fan-out, never the number of invocations.
    expect(withheld).toHaveLength(6);
    expect(refusalCalls()).toHaveLength(6);

    for (const [index, call] of refusalCalls().entries()) {
      const insert = withheld[index]!;
      expect(call).toMatchObject({
        accountId: insert.accountId,
        businessId: insert.businessId,
        refusalSource: 'outreach_withheld',
        refusalCode: insert.dispositionReason,
        refusalCategory: expect.stringMatching(/^(below_our_bar|unsafe_content)$/),
        subjectType: 'solicitation_outreach',
      });
      // The subject is the row THAT insert minted, never a shared id.
      expect(call.subjectId).toBe(`outreach-${inserts.indexOf(insert) + 1}`);
      // The sentinel is never used in this lane: `NOW()` freezes at
      // transaction START, and every one of these transactions waits on the
      // per-Business advisory lock before it decides anything.
      expect(call.occurredAt).not.toBe('transaction_time');
      expect(call.occurredAt).toBe(insert.renderedAt);
    }
    expect(new Set(refusalCalls().map((call) => call.subjectId)).size).toBe(6);
  });

  it('a forced clock advance between outreach insertion and refusal writing cannot change occurred_at from the outreach rendered_at', async () => {
    // Column equality in SQL proves the two columns AGREE; it does not prove
    // the `Date` was REUSED, because two `new Date()` calls in the same
    // millisecond agree too (round 1, R1-9). Advancing the clock by five
    // seconds between the insert and the ledger call separates them: a writer
    // minting its own timestamp records 12:00:05, the reused instance 12:00:00.
    const decisionInstant = new Date('2026-08-30T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(decisionInstant);
    try {
      mocks.insertOutreachRender.mockImplementation(async () => {
        vi.setSystemTime(new Date(decisionInstant.getTime() + 5_000));
        return 'outreach-1';
      });
      await runSingleChild({ postal_address: null });
    } finally {
      vi.useRealTimers();
    }

    const [insert] = insertInputs();
    const [refusal] = refusalCalls();
    expect(insert!.renderedAt).toEqual(decisionInstant);
    expect(refusal!.occurredAt).toEqual(decisionInstant);
    // IDENTITY, not equality: one `Date`, two writes.
    expect(refusal!.occurredAt).toBe(insert!.renderedAt);
  });

  it('a stale outbox attempt writes neither an outreach row nor a refusal_events row', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow({ postal_address: null })]),
      mkTaggedResult([askRow(1)]),
      lifecycleRow(), // parent-mint revalidation
      probeRow(0),
    );
    // The parent-run gate owns the attempt; the watchdog re-dispatches before
    // the child persists, so the CAS inside `persistChildRender` loses.
    mocks.lockDispatchedOutboxAttemptIfOwned
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await generateAsksForBatch(sql, GENERATE_INPUT);

    expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
    expectNoRefusalWrite();
  });

  it('a batch halted during the LLM round trip writes neither an outreach row nor a refusal_events row', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow({ postal_address: null })]),
      mkTaggedResult([askRow(1)]),
      lifecycleRow(), // parent-mint revalidation (still built)
      probeRow(0),
      lifecycleRow({ halted_at: new Date() }), // child persist revalidation
    );

    await generateAsksForBatch(sql, GENERATE_INPUT);

    // The render WAS produced and withheld — and still nothing is recorded,
    // because the lifecycle re-check refused the insert it would accompany.
    expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
    expectNoRefusalWrite();
  });

  it('a regeneration rejected by swap revalidation writes neither a replacement outreach row nor a refusal_events row', async () => {
    sqlReturnQueue.push(
      mkTaggedResult([contextRow({ postal_address: null })]), // loadBatchContext
      mkTaggedResult([askRow(1)]), // loadSendAskById
      mkTaggedResult([{ delivery_status: 'rendered', attempt_no: 1 }]),
      // Approved between the pre-check and the locked re-check.
      mkTaggedResult([contextRow({ approved_at: new Date() })]),
    );

    await regenerateAsk(sql, LANE_REGEN_INPUT);

    expect(mocks.supersedeLiveRender).not.toHaveBeenCalled();
    expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
    expectNoRefusalWrite();
  });

  it('a stale generation-exhaustion attempt writes no Refusal through either the single-row or the set arm', async () => {
    // The CAS loses, so the lane returns before the hole query — neither arm
    // is reached. Renamed from "…neither outreach hole rows nor
    // refusal_events rows" at #1082: this lane now batches, and a negative
    // assertion naming one arm of a two-arm writer is exactly the assertion
    // that stays green while covering nothing.
    mocks.markOutboxFailed.mockResolvedValue(false);

    const settled = await settleGenerationExhaustion(sql, LANE_DEAD_LETTER_INPUT);

    expect(settled).toEqual({ status: 'stale' });
    expect(mocks.insertOutreachRender).not.toHaveBeenCalled();
    expectNoRefusalWrite();
  });

  it("a generation exhaustion records every hole's Refusal in ONE writeRefusalEvents call, never one call per hole", async () => {
    // THE TICKET (#1082). A single-row write per iteration puts one round
    // trip per hole inside a transaction already holding the per-Business
    // advisory lock AND the `solicitation_batches` row lock.
    //
    // THREE HOLES, NOT A CEILING FIXTURE, and the ceiling is 25 rather than
    // the 5,000 this test first cited: `holes` filters `ask.status = 'send'`
    // and `evaluateBatch` keeps at most `BATCH_CAP` send decisions per batch.
    // Three is enough — a writer that records one Refusal per INVOCATION sits
    // at 1 here, and a one-hole fixture would not tell the two apart.
    //
    // THE CALL COUNT IS THE ASSERTION, and the row count is checked beside it:
    // a writer that batched but dropped rows, and a writer that kept every row
    // but looped, both fail here and neither fails a count-only test.
    mintDistinctOutreachIds();
    await runExhaustion(3);

    expect(mocks.writeRefusalEvent).not.toHaveBeenCalled();
    expect(mocks.writeRefusalEvents).toHaveBeenCalledTimes(1);
    // One INPUT per hole. `refusalCalls()` flattens the set arm, so this reads
    // the fan-out the lane proposed, not the number of times it called.
    expect(refusalCalls()).toHaveLength(3);
    expect(refusalCalls().map((call) => call.subjectId)).toEqual([
      'outreach-1',
      'outreach-2',
      'outreach-3',
    ]);
    // The fills still happen per hole — batching `insertOutreachRender` is
    // out of this ticket's scope and is a separate writer of a separate table.
    expect(mocks.insertOutreachRender).toHaveBeenCalledTimes(3);
  });

  it('a generation exhaustion that finds no holes issues no Refusal write through either arm', async () => {
    await runExhaustion(0);

    // THE TITLE'S PROPERTY, first and on its own: zero Refusals proposed
    // through either arm. This is what "issues no Refusal write" means, and
    // it holds however the lane spells the empty case.
    expect(refusalCalls()).toEqual([]);
    expect(mocks.writeRefusalEvent).not.toHaveBeenCalled();
    expect(mocks.insertOutreachRender).not.toHaveBeenCalled();

    // A DESIGN PIN, NOT THE TITLE'S PROPERTY — kept deliberately separate
    // because the two fail for different reasons (red team, P2). The empty
    // case belongs to the helper: `writeRefusalEvents` documents that an
    // empty input issues NO STATEMENT and returns before it even reads the
    // kill switch, so the lane calls it unconditionally rather than
    // re-spelling that guarantee behind an `if` — a caller-side length check
    // would be the second authority that drifts. A future `if
    // (refusals.length > 0)` would be outcome-identical and would turn THESE
    // two lines red and none of the three above; that is the signal working,
    // and the fix then is to delete this pin, not to weaken the test.
    expect(mocks.writeRefusalEvents).toHaveBeenCalledTimes(1);
    expect(mocks.writeRefusalEvents.mock.calls[0]![1]).toEqual([]);
  });
});
