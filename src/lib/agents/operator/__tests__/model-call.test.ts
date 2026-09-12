import { describe, it, expect, vi, beforeEach } from 'vitest';

const { runLlmTask, recordApiCost, calculateCostUsd, withCostGuard, capturedCents } = vi.hoisted(() => {
  const capturedCents: number[] = [];
  return {
    runLlmTask: vi.fn(),
    recordApiCost: vi.fn(),
    // 1¢ per 1000 tokens, so the expected sum is arithmetic rather than a
    // second copy of the production formula.
    calculateCostUsd: vi.fn((_model: string, input: number, output: number) => (input + output) / 100_000),
    // A pass-through that records what the closure asked the guard to finalize.
    withCostGuard: vi.fn(async (
      _opts: unknown,
      fn: () => Promise<{ value: unknown; actualCostCents: number }>,
    ) => {
      const result = await fn();
      capturedCents.push(result.actualCostCents);
      return result.value;
    }),
    capturedCents,
  };
});

vi.mock('@/lib/llm/run-task', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/llm/run-task')>()),
  runLlmTask,
}));
vi.mock('@/lib/costs/cost-guard', () => ({ withCostGuard }));
vi.mock('@/lib/costs/audit', () => ({ calculateCostUsd, recordApiCost }));

import { LLMStructuredOutputError } from '@/lib/llm/run-task';
import { generateOperatorReply } from '../model-call';
import { OWNER_OPERATOR_PROMPT_VERSION, operatorSystemPromptHash } from '../prompt';
import type { Snapshot } from '../context';

const ACCOUNT = '00000000-0000-7000-8000-00000000ac01';
const LOCATION = '00000000-0000-7000-8000-00000000b101';
const OTHER_LOCATION = '00000000-0000-7000-8000-00000000b102';
const TURN = '00000000-0000-7000-8000-000000000011';

// The same fixture shape as render.test.ts, deliberately: one `Snapshot`
// spelling for both suites means a field change breaks them together rather
// than letting one drift silently.
const snapshot: Snapshot = {
  accountId: ACCOUNT,
  locationId: LOCATION,
  locationName: 'Salon',
  subscriptionTier: 'copilot',
  turns: [],
  pendingProposals: [],
  operatingRules: {
    account: { threshold: null, vetoWindowMinutes: 30, dailyCap: 10 },
    location: { threshold: null, vetoWindowMinutes: 30, dailyCap: 10 },
    locationOverrideExists: false,
  },
  facts: { tone: null, productsServices: null, avoidFacts: [], highlightFacts: [] },
  allowedOperations: [
    { id: 'set_tone', kind: 'proposable', labelKind: 'fact', describe: 'Set the reply tone' },
    { id: 'read_pending_work', kind: 'read', labelKind: null, describe: 'Count what is waiting' },
  ],
  locations: [
    { id: LOCATION, name: 'Salon' },
    { id: OTHER_LOCATION, name: 'Cafe' },
  ],
  metrics: {
    pendingCount: 3,
    draftsWaiting: 4,
    posted7d: 9,
    starBands: { locationId: LOCATION, total: 3, byStar: { '1': 1, '2': 0, '3': 0, '4': 1, '5': 1 } },
    accountStarBands: { locationId: null, total: 4, byStar: { '1': 1, '2': 0, '3': 0, '4': 1, '5': 2 } },
    reportingPeriodDays: 7,
    asOf: '2026-09-11T10:00:00.000Z',
  },
};

const sql = (() => Promise.resolve([])) as never;

/** Two BILLED completions whose shapes were both invalid (run-task.ts:55-59). */
const BILLED = [
  { provider: 'openai' as const, model: 'gpt-4o-mini-2024-07-18', usage: { promptTokens: 900, completionTokens: 100 } },
  { provider: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', usage: { promptTokens: 900, completionTokens: 200 } },
];

function validReply() {
  return {
    text: '',
    provider: 'openai' as const,
    model: 'gpt-4o-mini-2024-07-18',
    usage: { promptTokens: 800, completionTokens: 200 },
    structured: {
      segments: [{ type: 'text', text: 'Apply the card below and I will use it next time.' }],
      proposals: [],
      unsupported: [],
    },
  };
}

describe('operator model call', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedCents.length = 0;
  });

  it('generateOperatorReply records one api_costs row per billed attempt', async () => {
    // Attempt 1: both providers billed, both shapes invalid. The seam throws
    // LLMStructuredOutputError carrying them (src/lib/llm/run-task.ts:31-52).
    runLlmTask
      .mockRejectedValueOnce(new LLMStructuredOutputError('owner_operator', 'anthropic', new Error('bad shape'), BILLED))
      .mockResolvedValueOnce(validReply());

    const result = await generateOperatorReply(sql, {
      accountId: ACCOUNT,
      locationId: LOCATION,
      subscriptionTier: 'copilot',
      snapshot,
      ownerText: 'Make my replies warmer.',
      turnId: TURN,
    });

    // ONE ROW PER BILLED COMPLETION, plus one for the successful call.
    expect(recordApiCost).toHaveBeenCalledTimes(3);
    for (const call of recordApiCost.mock.calls) {
      expect(call[1]).toMatchObject({
        accountId: ACCOUNT,
        businessId: LOCATION,
        endpoint: 'owner-operator',
        responseId: null,
        promptVersion: OWNER_OPERATOR_PROMPT_VERSION,
        systemPromptHash: operatorSystemPromptHash(),
      });
    }
    expect(recordApiCost.mock.calls.map((c) => (c[1] as { provider: string }).provider))
      .toEqual(['openai', 'anthropic', 'openai']);

    // The FIRST guarded call finalizes the two billed attempts' real spend, not
    // zero: 1000 + 1100 tokens at 1¢/1000 → ceil(0.021 * 100) = 3.
    expect(capturedCents[0]).toBe(
      Math.ceil((calculateCostUsd('m', 900, 100) + calculateCostUsd('m', 900, 200)) * 100),
    );
    expect(capturedCents[0]).toBe(3);
    // The guard was ENTERED twice and never thrown past: a shape failure is a
    // returned value, so the reservation finalizes instead of being released.
    expect(withCostGuard).toHaveBeenCalledTimes(2);
    expect(capturedCents).toHaveLength(2);

    // The retry carried the reason and then succeeded.
    expect(runLlmTask).toHaveBeenCalledTimes(2);
    expect((runLlmTask.mock.calls[1]![1] as { user: string }).user)
      .toContain('previousAttemptRejectedBecause');
    expect(result).toMatchObject({ ok: true, attempts: 2 });
  });

  it('fails model_output_invalid when both attempts return an invalid shape', async () => {
    runLlmTask.mockRejectedValue(
      new LLMStructuredOutputError('owner_operator', 'anthropic', new Error('bad shape'), BILLED),
    );

    const result = await generateOperatorReply(sql, {
      accountId: ACCOUNT,
      locationId: LOCATION,
      subscriptionTier: 'copilot',
      snapshot,
      ownerText: 'Make my replies warmer.',
      turnId: TURN,
    });

    expect(result).toEqual({ ok: false, reason: 'model_output_invalid', attempts: 2 });
    // Four billed completions across two attempts, four audit rows.
    expect(recordApiCost).toHaveBeenCalledTimes(4);
    expect(capturedCents).toEqual([3, 3]);
  });
});
