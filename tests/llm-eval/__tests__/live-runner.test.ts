// tests/llm-eval/__tests__/live-runner.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { generateResponseMock, runLlmTaskMock } = vi.hoisted(() => ({
  generateResponseMock: vi.fn(),
  runLlmTaskMock: vi.fn(),
}));

vi.mock('../../../src/lib/responses/generator', () => ({
  generateResponse: generateResponseMock,
}));
vi.mock('../../../src/lib/llm/run-task', () => ({
  runLlmTask: runLlmTaskMock,
}));

import {
  assertLiveKeysPresent,
  createLiveGenerator,
  createLiveJudgeGenerator,
} from '../live-runner';
import { buildJudgePrompt } from '../../../src/lib/responses/judge';
import type { JudgeEvalRow } from '../judge-types';
import type { EvalRow } from '../types';

const ORIGINAL_ENV = { ...process.env };

const row: EvalRow = {
  id: 'r',
  category: 'positive',
  description: 'd',
  input: {
    reviewerName: 'Maria',
    starRating: 5,
    reviewText: 'Great!',
    reviewDate: '2026-05-01',
    detectedLanguage: 'en',
    businessName: 'Acme',
    businessCategory: 'cafe',
  },
  candidate: 'canned',
  expect: { maxSeverity: 'low', forbiddenCategories: [] },
};

const judgeRow: JudgeEvalRow = {
  id: 'judge-r',
  category: 'clean_pass',
  description: 'd',
  input: {
    reviewRating: 5,
    reviewText: 'Great!',
    businessName: 'Acme',
    businessCategory: 'cafe',
  },
  postedReply: 'Thank you for visiting.',
  cannedOutput: { verdict: 'pass', reasons: [], rationale: 'Safe.' },
  expect: { verdict: 'pass' },
};

beforeEach(() => {
  generateResponseMock.mockReset();
  runLlmTaskMock.mockReset();
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('assertLiveKeysPresent', () => {
  it('throws when no provider key is set', () => {
    expect(() => assertLiveKeysPresent()).toThrow(/OPENAI_API_KEY|ANTHROPIC_API_KEY/);
  });

  it('does not throw when OPENAI_API_KEY is set', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    expect(() => assertLiveKeysPresent()).not.toThrow();
  });

  it('does not throw when ANTHROPIC_API_KEY is set', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    expect(() => assertLiveKeysPresent()).not.toThrow();
  });
});

describe('createLiveGenerator', () => {
  it('calls generateResponse in demo mode and returns its responseText', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    generateResponseMock.mockResolvedValue({ responseText: 'live reply' });

    const generate = createLiveGenerator();
    const text = await generate(row);

    expect(text).toBe('live reply');
    expect(generateResponseMock).toHaveBeenCalledTimes(1);
    // arg[0] is the injected `sql`; the eval inputs follow it.
    const [, review, business, voice, options] = generateResponseMock.mock.calls[0]!;
    expect(review).toMatchObject({ reviewerName: 'Maria', starRating: 5, reviewText: 'Great!' });
    expect(business).toEqual({ name: 'Acme', category: 'cafe' });
    expect(voice).toEqual([]);
    expect(options).toEqual({ mode: 'demo' });
  });
});

describe('createLiveJudgeGenerator', () => {
  it('calls the registered judge seam with the production prompt envelope', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    const structured = { verdict: 'pass', reasons: [], rationale: 'Safe.' };
    runLlmTaskMock.mockResolvedValue({ structured });

    const generate = createLiveJudgeGenerator();
    await expect(generate(judgeRow)).resolves.toEqual(structured);

    expect(runLlmTaskMock).toHaveBeenCalledTimes(1);
    expect(runLlmTaskMock).toHaveBeenCalledWith(
      'judge',
      buildJudgePrompt({
        reviewRating: judgeRow.input.reviewRating,
        reviewText: judgeRow.input.reviewText,
        postedReplyText: judgeRow.postedReply,
      }),
    );
  });
});
