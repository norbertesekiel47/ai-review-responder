import { describe, it, expect, vi, beforeEach } from 'vitest';

// Safety review — the fail-closed implied-content check on the Auto-approval
// lane (G4-F1). Harness follows src/lib/reviews/__tests__/triage.test.ts, with
// ONE deliberate difference that plan round-1 finding 1 turns on:
//
//   triage.test.ts mocks `withCostGuard` away, so a cost failure is simulated
//   by making the wrapped callback throw. That cannot prove the reservation
//   PRECEDES the spend, nor that a finalize outage is not silently swallowed.
//   Here the REAL withCostGuard runs and `@/lib/costs/tracker` is mocked
//   instead, so reserve → spend → finalize/release is exercised for real.
//
// Injecting CostInfraUnavailableError through a stubbed runTask was the round-1
// defect; do not reintroduce it.

const { mockSql, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

const reserveCost = vi.hoisted(() => vi.fn(async () => '2026-09-18'));
const finalizeCost = vi.hoisted(() => vi.fn(async () => undefined));
const releaseCost = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/costs/tracker', () => ({ reserveCost, finalizeCost, releaseCost }));

const recordApiCost = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/lib/costs/audit', () => ({
  recordApiCost,
  calculateCostUsd: vi.fn(() => 0.00002),
}));

const isMockMode = vi.hoisted(() => vi.fn(() => false));
vi.mock('@/lib/shared/mock-mode', () => ({ isMockMode }));

const reportCaughtError = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shared/report-caught-error', () => ({ reportCaughtError }));

// The two providers and the breaker, for the tests that must run the REAL
// runLlmTask rather than an injected double (round-1 finding 7 / deviation D5:
// a stubbed runTask cannot show that a blocked primary reaches the fallback).
const openaiComplete = vi.hoisted(() => vi.fn());
const anthropicComplete = vi.hoisted(() => vi.fn());
vi.mock('@/lib/llm/openai-provider', () => ({
  openaiProvider: { id: 'openai', complete: openaiComplete },
}));
vi.mock('@/lib/llm/anthropic-provider', () => ({
  anthropicProvider: { id: 'anthropic', complete: anthropicComplete },
}));
const shouldAttempt = vi.hoisted(() =>
  vi.fn<(provider: string) => { provider: string; epoch: number } | null>((provider) => ({
    provider,
    epoch: 0,
  })),
);
vi.mock('@/lib/llm/circuit-breaker', () => ({
  llmCircuitBreaker: { shouldAttempt, recordAttempt: vi.fn() },
}));

import { reviewSafety } from '../safety-review';
import type { SafetyVerdict } from '../safety-review-schema';
import { LLMStructuredOutputError } from '@/lib/llm/run-task';
import type { ChatPrompt } from '@/lib/llm/types';
import { CostInfraUnavailableError } from '@/lib/costs/errors';

const INPUT = {
  draftText: 'Thank you for the feedback. We would like to make this right.',
  businessId: 'biz-1',
  accountId: 'acct-1',
  subscriptionTier: 'autopilot',
  correlationId: 'corr-1',
} as const;

/** The review text must never reach the prompt (ADR 0032) — bait for test 14. */
const REVIEW_TEXT = 'REVIEW_TEXT_THAT_MUST_NEVER_REACH_THE_PROMPT';

function llmResult(structured: unknown, provider: 'openai' | 'anthropic' = 'openai') {
  return {
    text: JSON.stringify(structured),
    provider,
    model: provider === 'openai' ? 'gpt-4o-mini-2024-07-18' : 'claude-haiku-4-5-20251001',
    usage: { promptTokens: 210, completionTokens: 12 },
    structured,
  };
}

const CLEARED = { cleared: true, concern: null };
const NOT_CLEARED = { cleared: false, concern: 'implied_threat' };

function runTaskReturning(structured: unknown, provider: 'openai' | 'anthropic' = 'openai') {
  return vi.fn(async () => llmResult(structured, provider));
}

describe('reviewSafety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isMockMode.mockReturnValue(false);
    reserveCost.mockResolvedValue('2026-09-18');
    finalizeCost.mockResolvedValue(undefined);
    releaseCost.mockResolvedValue(undefined);
    recordApiCost.mockResolvedValue(undefined);
    shouldAttempt.mockImplementation((provider: string) => ({ provider, epoch: 0 }));
    resetMockSql();
  });

  // ── the model's own answers ──────────────────────────────────────────────

  it('returns cleared with no concern for an ordinary safe draft', async () => {
    const verdict = await reviewSafety(mockSql as never, INPUT, { runTask: runTaskReturning(CLEARED) });
    expect(verdict).toMatchObject({ cleared: true, concern: null, source: 'llm' });
  });

  it('returns not-cleared with the concern the model named for an unsafe draft', async () => {
    const verdict = await reviewSafety(mockSql as never, INPUT, { runTask: runTaskReturning(NOT_CLEARED) });
    expect(verdict).toMatchObject({
      cleared: false,
      concern: 'implied_threat',
      source: 'llm',
    });
  });

  it('records the answering provider on every safety verdict', async () => {
    // Deviation D5: the Anthropic fallback is KEPT, so production may answer
    // from a provider the corpus never measured. The verdict has to say which.
    const fromOpenai = await reviewSafety(mockSql as never, INPUT, {
      runTask: runTaskReturning(CLEARED, 'openai'),
    });
    expect(fromOpenai.provider).toBe('openai');

    const fromAnthropic = await reviewSafety(mockSql as never, INPUT, {
      runTask: runTaskReturning(CLEARED, 'anthropic'),
    });
    expect(fromAnthropic.provider).toBe('anthropic');
  });

  it('passes only the draft text to the LLM task, never the review text', async () => {
    // ADR 0032's central claim. The first version asserted the absence of a
    // string that was never passed in and that `ReviewSafetyInput` has no field
    // to carry — it could not fail for ANY implementation.
    //
    // What is actually assertable is that the prompt is built from the draft
    // and NOTHING ELSE the caller handed over. Every other input field is a
    // real value here, so interpolating any of them into the prompt — the
    // shape a "give the model more context" change would take — fails this.
    const runTask = runTaskReturning(CLEARED);
    await reviewSafety(mockSql as never, INPUT, { runTask });

    const [firstCall] = runTask.mock.calls as unknown as Array<[ChatPrompt]>;
    const prompt = firstCall![0];
    const serialized = `${prompt.system}\n${prompt.user}`;

    expect(serialized).toContain(INPUT.draftText);
    for (const [field, value] of Object.entries(INPUT)) {
      if (field === 'draftText') continue;
      expect(serialized, `prompt leaked ${field}`).not.toContain(String(value));
    }
    // RT-12: the removed line here asserted `Object.keys(INPUT)` lacks
    // `reviewText` — a property of the test-local literal at :65, which no
    // change to safety-review.ts can falsify. The falsifiable half is the loop
    // above, which pins that the prompt carries the draft and NOTHING else in
    // the input. The line below is kept deliberately as a documented canary for
    // ADR 0032's "never the review text" rule: it cannot fail while
    // `ReviewSafetyInput` has no field to carry a review, and it turns into a
    // real assertion the moment one is added.
    expect(serialized).not.toContain(REVIEW_TEXT);
  });

  // ── schema and contradiction ─────────────────────────────────────────────

  it('returns not-cleared when the model output fails the schema', async () => {
    const runTask = vi.fn(async () => llmResult({ cleared: 'yes', concern: 'nope' }));
    const verdict = await reviewSafety(mockSql as never, INPUT, { runTask });
    expect(verdict).toMatchObject({ cleared: false, concern: null, source: 'failed' });
  });

  it('returns not-cleared when the model returns cleared=true with a non-null safety concern', async () => {
    // Round-1 finding 2: the gate reads only `cleared`, so a model naming a
    // threat could otherwise permit posting.
    //
    // The verdict is DERIVED, not rejected, and `source` is what shows the
    // difference. Revision 3a rejected this combination in the schema; the
    // security review proved that a refine failure is a provider FAILOVER, so
    // the fallback would be asked fresh and could clear the very draft the
    // primary flagged. Deriving keeps the model's finding — `source: 'llm'`,
    // the concern preserved — instead of discarding it as a failed attempt.
    const runTask = vi.fn(async () => llmResult({ cleared: true, concern: 'implied_threat' }));
    const verdict = await reviewSafety(mockSql as never, INPUT, { runTask });
    expect(verdict.cleared).toBe(false);
    expect(verdict.source).toBe('llm');
    expect(verdict.concern).toBe('implied_threat');
  });

  it('never asks the fallback after the primary named a concern', async () => {
    // The fix for the security axis's high finding, pinned. Runs the REAL
    // executor: a contradiction must resolve inside the verdict, so the second
    // provider is never given a fresh chance to clear the draft.
    openaiComplete.mockResolvedValue(llmResult({ cleared: true, concern: 'implied_threat' }));
    anthropicComplete.mockResolvedValue(llmResult(CLEARED, 'anthropic'));

    const verdict = await reviewSafety(mockSql as never, INPUT);

    expect(openaiComplete).toHaveBeenCalledTimes(1);
    expect(anthropicComplete).not.toHaveBeenCalled();
    expect(verdict).toMatchObject({
      cleared: false,
      concern: 'implied_threat',
      source: 'llm',
      provider: 'openai',
    });
  });

  // ── cost boundary: reserve → spend → finalize ────────────────────────────

  it('makes no LLM call when cost reservation is denied or unavailable', async () => {
    // Round-1 finding 1: the reservation must PRECEDE the spend. Proven at the
    // real tracker boundary, not by making a stubbed runTask throw.
    reserveCost.mockRejectedValueOnce(new CostInfraUnavailableError('reserveCost'));
    const runTask = runTaskReturning(CLEARED);

    const verdict = await reviewSafety(mockSql as never, INPUT, { runTask });

    expect(runTask).not.toHaveBeenCalled();
    expect(verdict).toMatchObject({ cleared: false, source: 'failed' });
  });

  it('returns not-cleared when the cost reservation fails, and does not rethrow', async () => {
    reserveCost.mockRejectedValueOnce(new CostInfraUnavailableError('reserveCost'));
    await expect(
      reviewSafety(mockSql as never, INPUT, { runTask: runTaskReturning(CLEARED) }),
    ).resolves.toMatchObject({ cleared: false, source: 'failed' });
  });

  it('returns not-cleared when cost finalization fails after a cleared model verdict', async () => {
    // Round-1 finding 1, the silent-clearance path: with
    // onFinalizeError: 'log-and-return-value' the guard returns the CLEARED
    // value and the outer catch never sees the outage. The module must use the
    // throwing default so this lands fail-closed.
    finalizeCost.mockRejectedValueOnce(new Error('redis INCRBY failed'));

    const verdict = await reviewSafety(mockSql as never, INPUT, { runTask: runTaskReturning(CLEARED) });

    expect(verdict.cleared).toBe(false);
    expect(verdict.source).toBe('failed');
  });

  it('returns not-cleared when the safety-review cost audit write fails', async () => {
    // Round-1 finding 1, the swallowed-audit path: tryRecordTriageCost logs and
    // continues (`tryRecordTriageCost`). A lost audit row must not become a clearance.
    recordApiCost.mockRejectedValueOnce(new Error('api_costs insert failed'));

    const verdict = await reviewSafety(mockSql as never, INPUT, { runTask: runTaskReturning(CLEARED) });

    expect(verdict.cleared).toBe(false);
    expect(verdict.source).toBe('failed');
  });

  it.each([
    ['malformed output', [{ provider: 'openai' as const, model: 'gpt-4o-mini-2024-07-18', usage: { promptTokens: 200, completionTokens: 9 } }]],
    ['a refusal', [{ provider: 'openai' as const, model: 'gpt-4o-mini-2024-07-18', usage: { promptTokens: 200, completionTokens: 4 } }]],
    ['truncation', [{ provider: 'openai' as const, model: 'gpt-4o-mini-2024-07-18', usage: { promptTokens: 200, completionTokens: 120 } }]],
    ['multiple billed attempts', [
      { provider: 'openai' as const, model: 'gpt-4o-mini-2024-07-18', usage: { promptTokens: 200, completionTokens: 9 } },
      { provider: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', usage: { promptTokens: 200, completionTokens: 11 } },
    ]],
  ])(
    'finalizes and audits billed invalid safety-review completions before returning not-cleared without retry (%s)',
    async (_case, billedAttempts) => {
      // Round-1 finding 8. These completions WERE billed. Letting the error
      // escape the guarded callback makes `withCostGuard`'s `finally` release the
      // reservation, so real spend vanishes from enforcement and the audit.
      const runTask = vi.fn(async () => {
        throw new LLMStructuredOutputError(
          'safety_review',
          'openai',
          new Error('schema invalid'),
          billedAttempts,
        );
      });

      const verdict = await reviewSafety(mockSql as never, INPUT, { runTask });

      expect(verdict).toMatchObject({ cleared: false, source: 'failed' });
      expect(finalizeCost).toHaveBeenCalled();
      expect(releaseCost).not.toHaveBeenCalled();
      expect(recordApiCost).toHaveBeenCalledTimes(billedAttempts.length);
    },
  );

  // ── the executor seam: circuit breaker and fallback (deviation D5) ───────

  it('clears from the Anthropic fallback when the primary safety-review circuit is open', async () => {
    // Round-1 finding 7. Runs the REAL runLlmTask: a stubbed runTask that
    // throws a circuit error cannot show that a blocked primary reaches the
    // fallback and returns normally. D5 accepted that behaviour deliberately.
    shouldAttempt.mockImplementation((provider: string) =>
      provider === 'openai' ? null : { provider, epoch: 0 },
    );
    anthropicComplete.mockResolvedValue(llmResult(CLEARED, 'anthropic'));

    const verdict = await reviewSafety(mockSql as never, INPUT);

    expect(openaiComplete).not.toHaveBeenCalled();
    expect(anthropicComplete).toHaveBeenCalledTimes(1);
    expect(verdict).toMatchObject({ cleared: true, source: 'llm', provider: 'anthropic' });
  });

  it('returns not-cleared when every safety-review provider attempt fails', async () => {
    openaiComplete.mockRejectedValue(new Error('openai 503'));
    anthropicComplete.mockRejectedValue(new Error('anthropic 503'));

    const verdict = await reviewSafety(mockSql as never, INPUT);

    expect(verdict).toMatchObject({ cleared: false, concern: null, source: 'failed' });
    expect(verdict.provider).toBeNull();
  });

  // ── the never-throw contract ─────────────────────────────────────────────

  it('returns not-cleared when the LLM task throws', async () => {
    const runTask = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(reviewSafety(mockSql as never, INPUT, { runTask })).resolves.toMatchObject({
      cleared: false,
      concern: null,
      source: 'failed',
    });
  });

  it('reports a fail-closed outage to the alert sink, carrying no draft text', async () => {
    // Failing closed is SILENT: the owner sees drafts arriving for approval,
    // exactly as before the feature existed. Alerting rule 14 is the only way
    // an outage becomes visible, and a rule with no emitter is half a path.
    const runTask = vi.fn(async () => {
      throw new Error('provider exploded');
    });

    const verdict = await reviewSafety(mockSql as never, INPUT, { runTask });

    expect(verdict.source).toBe('failed');
    expect(reportCaughtError).toHaveBeenCalledTimes(1);
    const [endpoint, , context] = reportCaughtError.mock.calls[0] as [string, unknown, unknown];
    expect(endpoint).toBe('moderation/safety-review');
    // The filter in rule 14 is this exact tag; a rename silently unhooks it.
    expect(JSON.stringify(context)).not.toContain(INPUT.draftText);
  });

  it('does not report a model-judged block to the alert sink', async () => {
    // The other half. A not-cleared verdict the MODEL produced is the check
    // working; paging on it would make the rule useless within a day.
    await reviewSafety(mockSql as never, INPUT, { runTask: runTaskReturning(NOT_CLEARED) });

    expect(reportCaughtError).not.toHaveBeenCalled();
  });

  it('never throws, for any injected failure', async () => {
    // The whole point of the module. A throw here reaches BullMQ and buys a
    // second paid draft to fix a gate failure — the locked "No retry" invariant.
    const failures: Array<() => void> = [
      () => {
        reserveCost.mockRejectedValueOnce(new CostInfraUnavailableError('reserveCost'));
      },
      () => {
        finalizeCost.mockRejectedValueOnce(new Error('finalize down'));
      },
      () => {
        recordApiCost.mockRejectedValueOnce(new Error('audit down'));
      },
    ];
    const throwers: Array<unknown> = [
      new Error('plain'),
      new CostInfraUnavailableError('reserveCost'),
      new LLMStructuredOutputError('safety_review', 'openai', new Error('invalid'), []),
      'a bare string',
      null,
      undefined,
    ];

    for (const arm of failures) {
      vi.clearAllMocks();
      reserveCost.mockResolvedValue('2026-09-18');
      arm();
      const verdict: SafetyVerdict = await reviewSafety(mockSql as never, INPUT, {
        runTask: runTaskReturning(CLEARED),
      });
      expect(verdict.cleared).toBe(false);
    }

    for (const thrown of throwers) {
      vi.clearAllMocks();
      reserveCost.mockResolvedValue('2026-09-18');
      const runTask = vi.fn(async () => {
        throw thrown;
      });
      const verdict: SafetyVerdict = await reviewSafety(mockSql as never, INPUT, { runTask });
      expect(verdict.cleared).toBe(false);
      expect(verdict.source).toBe('failed');
    }
  });

  // ── mock mode (deviation D2) ─────────────────────────────────────────────

  it('short-circuits to a distinguishable mock clearance under MOCK_EXTERNAL_APIS', async () => {
    // Deviation D2. Local dev must be able to exercise the lane. `source` is
    // what stops a mock clearance ever being read as evidence — deviation D3
    // makes the corpus refuse to run at all in this mode.
    isMockMode.mockReturnValue(true);
    const runTask = runTaskReturning(CLEARED);

    const verdict = await reviewSafety(mockSql as never, INPUT, { runTask });

    expect(runTask).not.toHaveBeenCalled();
    expect(reserveCost).not.toHaveBeenCalled();
    expect(verdict).toMatchObject({ cleared: true, concern: null, source: 'mock', provider: null });
  });
});
