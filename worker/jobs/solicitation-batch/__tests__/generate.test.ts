import type { Job } from 'bullmq';
import type { Sql } from 'postgres';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateSolicitationAsksPayload } from '@/lib/shared/worker-types';

const mocks = vi.hoisted(() => ({
  checkAskRegenBudget: vi.fn(),
  runLlmTask: vi.fn(),
  markOutboxCompletedIfOwned: vi.fn(),
  markOutboxFailed: vi.fn(),
  recordOutboxTransientError: vi.fn(),
  logger: {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// spy:true keeps the REAL domain implementations behind clearable spies: the
// dispatch tests stub per-call with mock*Once, while the budget test drives
// the genuine regenerateAsk refusal path through the handler.
vi.mock('@/lib/solicitation/ask-generation', { spy: true });
vi.mock('@/lib/costs/tracker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/costs/tracker')>()),
  checkAskRegenBudget: mocks.checkAskRegenBudget,
}));
vi.mock('@/lib/llm/run-task', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/llm/run-task')>()),
  runLlmTask: mocks.runLlmTask,
}));
vi.mock('@/lib/shared/outbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/outbox')>()),
  markOutboxCompletedIfOwned: mocks.markOutboxCompletedIfOwned,
  markOutboxFailed: mocks.markOutboxFailed,
  recordOutboxTransientError: mocks.recordOutboxTransientError,
}));
vi.mock('@/lib/shared/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/shared/logger')>()),
  createWorkerLogger: () => mocks.logger,
}));

import { CostInfraUnavailableError } from '@/lib/costs/errors';
import { RegenBudgetExceededError } from '@/lib/costs/tracker';
import { TransientLLMError } from '@/lib/llm/error-classifier';
import {
  generateAsksForBatch,
  regenerateAsk,
  settleGenerationExhaustion,
} from '@/lib/solicitation/ask-generation';
import { handleGenerateSolicitationAsks } from '../generate';
import { handleGenerateSolicitationAsksFailed } from '../generate-failed-hook';

// The handler's sql surface in these tests: completeOutboxNoop's minimal
// transaction (tx consumed only by mocked outbox CAS) plus the failed-hook's
// watchdog-budget SELECT — raw tagged-template calls pop fakeSqlRows FIFO.
const fakeSqlRows: unknown[][] = [];
const fakeSql = Object.assign(
  async (..._args: unknown[]) => fakeSqlRows.shift() ?? [],
  {
    begin: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn({}),
  },
) as unknown as Sql;

/** Watchdog budget row for the failed-hook's job_outbox read. */
function queueOutboxBudget(attempts: number, maxAttempts: number): void {
  fakeSqlRows.push([{ attempts, max_attempts: maxAttempts }]);
}

function makeJob(
  data: Partial<GenerateSolicitationAsksPayload>,
  opts: { attemptsMade?: number; attempts?: number } = {},
): Job<GenerateSolicitationAsksPayload> {
  return {
    id: 'bull-job-1',
    attemptsMade: opts.attemptsMade ?? 1,
    opts: { attempts: opts.attempts ?? 3 },
    data: {
      batch_id: 'batch-1',
      business_id: 'business-1',
      correlation_id: 'corr-1',
      outbox_id: 'outbox-1',
      outbox_attempt: 4,
      ...data,
    },
  } as unknown as Job<GenerateSolicitationAsksPayload>;
}

const emptyResult = {
  rendered: 0,
  withheld: 0,
  failed: 0,
  skippedExisting: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  fakeSqlRows.length = 0;
  mocks.markOutboxCompletedIfOwned.mockResolvedValue(true);
  mocks.markOutboxFailed.mockResolvedValue(true);
});

describe('handleGenerateSolicitationAsks', () => {
  it('dispatches a whole-batch payload to generateAsksForBatch with the outbox handle', async () => {
    vi.mocked(generateAsksForBatch).mockResolvedValueOnce(emptyResult);

    await handleGenerateSolicitationAsks(fakeSql, makeJob({}));

    expect(generateAsksForBatch).toHaveBeenCalledWith(fakeSql, {
      batchId: 'batch-1',
      businessId: 'business-1',
      outboxHandle: { outboxId: 'outbox-1', attempt: 4 },
      correlationId: 'corr-1',
    });
    expect(regenerateAsk).not.toHaveBeenCalled();
  });

  it('dispatches an ask_id payload to regenerateAsk with the outbox handle', async () => {
    vi.mocked(regenerateAsk).mockResolvedValueOnce(undefined);

    await handleGenerateSolicitationAsks(fakeSql, makeJob({ ask_id: 'ask-1' }));

    expect(regenerateAsk).toHaveBeenCalledWith(fakeSql, {
      batchId: 'batch-1',
      businessId: 'business-1',
      askId: 'ask-1',
      outboxHandle: { outboxId: 'outbox-1', attempt: 4 },
      correlationId: 'corr-1',
    });
    expect(generateAsksForBatch).not.toHaveBeenCalled();
  });

  it('propagates transient domain errors so BullMQ retries', async () => {
    const transient = new Error('provider timed out');
    vi.mocked(generateAsksForBatch).mockRejectedValueOnce(transient);

    await expect(
      handleGenerateSolicitationAsks(fakeSql, makeJob({})),
    ).rejects.toBe(transient);
    // The domain did not complete the outbox and neither may the handler:
    // the row stays dispatched for the retry/watchdog pair.
    expect(mocks.markOutboxCompletedIfOwned).not.toHaveBeenCalled();
    expect(mocks.markOutboxFailed).not.toHaveBeenCalled();
  });

  it('enforces the three-per-day ask regeneration budget in the worker', async () => {
    // Real regenerateAsk (spy passthrough): the worker-enforced budget throws
    // BEFORE any reservation or LLM call, and the refusal is TERMINAL — the
    // handler resolves (no BullMQ retry) and the outbox attempt completes.
    const flagBefore = process.env.SOLICITATION_SEND_ENABLED;
    process.env.SOLICITATION_SEND_ENABLED = 'true';
    mocks.checkAskRegenBudget.mockRejectedValueOnce(
      new RegenBudgetExceededError('ask-1'),
    );

    try {
      await expect(
        handleGenerateSolicitationAsks(fakeSql, makeJob({ ask_id: 'ask-1' })),
      ).resolves.toBeUndefined();
    } finally {
      if (flagBefore === undefined) delete process.env.SOLICITATION_SEND_ENABLED;
      else process.env.SOLICITATION_SEND_ENABLED = flagBefore;
    }

    expect(mocks.checkAskRegenBudget).toHaveBeenCalledWith('ask-1', 'outbox-1');
    expect(mocks.runLlmTask).not.toHaveBeenCalled();
    expect(mocks.markOutboxCompletedIfOwned).toHaveBeenCalledWith(
      expect.anything(),
      'outbox-1',
      4,
    );
    expect(mocks.markOutboxFailed).not.toHaveBeenCalled();
    expect(mocks.logger.log).toHaveBeenCalledWith(
      'ask regeneration refused',
      expect.objectContaining({ reason: 'regen_budget_exhausted' }),
    );
  });
});

describe('handleGenerateSolicitationAsksFailed', () => {
  it('does nothing before retries are exhausted', async () => {
    await handleGenerateSolicitationAsksFailed(
      fakeSql,
      makeJob({}, { attemptsMade: 2, attempts: 3 }),
      new Error('boom'),
    );

    expect(mocks.markOutboxFailed).not.toHaveBeenCalled();
  });

  it('marks the owned outbox attempt failed on regeneration exhaustion — parent and render stay healthy', async () => {
    await handleGenerateSolicitationAsksFailed(
      fakeSql,
      makeJob({ ask_id: 'ask-1' }, { attemptsMade: 3, attempts: 3 }),
      new Error('boom'),
    );

    expect(mocks.markOutboxFailed).toHaveBeenCalledWith(
      fakeSql,
      'outbox-1',
      'generate_solicitation_asks_exhausted:Error',
      4,
    );
    expect(settleGenerationExhaustion).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'ask generation exhausted',
      expect.objectContaining({ status: 'terminalized', outbox_attempt: 4 }),
    );
  });

  it('whole-batch terminal exhaustion runs the coupled dead-letter settlement', async () => {
    vi.mocked(settleGenerationExhaustion).mockResolvedValueOnce({
      status: 'settled',
      filled: 2,
      close: { status: 'closed' },
    } as Awaited<ReturnType<typeof settleGenerationExhaustion>>);

    await handleGenerateSolicitationAsksFailed(
      fakeSql,
      makeJob({}, { attemptsMade: 3, attempts: 3 }),
      new Error('boom'),
    );

    expect(settleGenerationExhaustion).toHaveBeenCalledWith(fakeSql, {
      batchId: 'batch-1',
      businessId: 'business-1',
      outboxHandle: { outboxId: 'outbox-1', attempt: 4 },
      errorClass: 'Error',
    });
    // The domain owns the CAS inside its coupled transaction — the hook must
    // not race it with a second bare CAS.
    expect(mocks.markOutboxFailed).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'ask generation exhausted',
      expect.objectContaining({
        status: 'terminalized_and_settled',
        filled: 2,
        close_status: 'closed',
      }),
    );
  });

  it('a dead-letter settlement failure leaves the row dispatched for the watchdog', async () => {
    vi.mocked(settleGenerationExhaustion).mockRejectedValueOnce(new Error('db down'));

    await expect(
      handleGenerateSolicitationAsksFailed(
        fakeSql,
        makeJob({}, { attemptsMade: 3, attempts: 3 }),
        new Error('boom'),
      ),
    ).resolves.toBeUndefined();

    expect(mocks.logger.error).toHaveBeenCalledWith(
      'ask generation exhausted',
      expect.objectContaining({ status: 'terminal_checkpoint_failed' }),
    );
  });

  it('leaves transient LLM exhaustion watchdog-eligible after partial persistence', async () => {
    // Exhausted in-band attempts on a TransientLLMError must NOT terminalize:
    // the row stays 'dispatched' so the watchdog re-drives, and the §7.4
    // DB-existence idempotency resumes past already-persisted renders.
    queueOutboxBudget(2, 5);
    await handleGenerateSolicitationAsksFailed(
      fakeSql,
      makeJob({}, { attemptsMade: 3, attempts: 3 }),
      new TransientLLMError(new Error('provider 503')),
    );

    expect(mocks.markOutboxFailed).not.toHaveBeenCalled();
    expect(mocks.recordOutboxTransientError).toHaveBeenCalledWith(
      fakeSql,
      'outbox-1',
      'generate_solicitation_asks_exhausted_retryable:TransientLLMError',
      4,
    );
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'ask generation exhausted',
      expect.objectContaining({
        status: 'watchdog_eligible',
        error_class: 'TransientLLMError',
      }),
    );
  });

  it('leaves cost-infra exhaustion watchdog-eligible', async () => {
    queueOutboxBudget(2, 5);
    await handleGenerateSolicitationAsksFailed(
      fakeSql,
      makeJob({}, { attemptsMade: 3, attempts: 3 }),
      new CostInfraUnavailableError('reserveCost'),
    );

    expect(mocks.markOutboxFailed).not.toHaveBeenCalled();
    expect(mocks.recordOutboxTransientError).toHaveBeenCalledWith(
      fakeSql,
      'outbox-1',
      'generate_solicitation_asks_exhausted_retryable:CostInfraUnavailableError',
      4,
    );
  });

  it('a retryable class on the FINAL watchdog attempt dead-letters the whole batch (codex round-3)', async () => {
    // attempts == max_attempts: the watchdog will never re-pend this row —
    // its generic terminalizer would strand the lane, so the hook settles NOW.
    queueOutboxBudget(5, 5);
    vi.mocked(settleGenerationExhaustion).mockResolvedValueOnce({
      status: 'settled',
      filled: 1,
      close: { status: 'closed' },
    } as Awaited<ReturnType<typeof settleGenerationExhaustion>>);

    await handleGenerateSolicitationAsksFailed(
      fakeSql,
      makeJob({}, { attemptsMade: 3, attempts: 3 }),
      new TransientLLMError(new Error('provider 503')),
    );

    expect(mocks.recordOutboxTransientError).not.toHaveBeenCalled();
    expect(settleGenerationExhaustion).toHaveBeenCalledWith(fakeSql, {
      batchId: 'batch-1',
      businessId: 'business-1',
      outboxHandle: { outboxId: 'outbox-1', attempt: 4 },
      errorClass: 'TransientLLMError',
    });
  });

  it('a retryable regeneration on the FINAL watchdog attempt takes the bare terminal CAS', async () => {
    queueOutboxBudget(5, 5);

    await handleGenerateSolicitationAsksFailed(
      fakeSql,
      makeJob({ ask_id: 'ask-1' }, { attemptsMade: 3, attempts: 3 }),
      new CostInfraUnavailableError('checkAskRegenBudget'),
    );

    expect(mocks.recordOutboxTransientError).not.toHaveBeenCalled();
    expect(settleGenerationExhaustion).not.toHaveBeenCalled();
    expect(mocks.markOutboxFailed).toHaveBeenCalledWith(
      fakeSql,
      'outbox-1',
      'generate_solicitation_asks_exhausted:CostInfraUnavailableError',
      4,
    );
  });

  it('skips the terminal write when the exact attempt is missing', async () => {
    const job = makeJob({}, { attemptsMade: 3, attempts: 3 });
    delete (job.data as { outbox_attempt?: number }).outbox_attempt;

    await handleGenerateSolicitationAsksFailed(fakeSql, job, new Error('boom'));

    expect(mocks.markOutboxFailed).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith(
      'ask generation exhausted',
      expect.objectContaining({ status: 'missing_exact_attempt' }),
    );
  });

  it('leaves the row dispatched when the failure CAS itself throws', async () => {
    mocks.markOutboxFailed.mockRejectedValueOnce(new Error('db down'));

    await expect(
      handleGenerateSolicitationAsksFailed(
        fakeSql,
        makeJob({}, { attemptsMade: 3, attempts: 3 }),
        new Error('boom'),
      ),
    ).resolves.toBeUndefined();

    expect(mocks.logger.error).toHaveBeenCalledWith(
      'ask generation exhausted',
      expect.objectContaining({ status: 'terminal_checkpoint_failed' }),
    );
  });
});
