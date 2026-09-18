// tests/llm-eval/__tests__/run.test.ts
import { describe, expect, it } from 'vitest';
import { loadEvalSet } from '../load';
import { parseRunMode, readFlagValue, runEval } from '../run';
import type { EvalRow } from '../types';

describe('parseRunMode', () => {
  it('keeps offline as the default and --live as the existing live lane', () => {
    expect(parseRunMode(['node', 'run.ts'])).toBe('offline');
    expect(parseRunMode(['node', 'run.ts', '--live'])).toBe('live');
  });

  it('routes --live --structured-only to the structured lane', () => {
    expect(parseRunMode(['node', 'run.ts', '--live', '--structured-only'])).toBe('structured');
  });

  it('rejects --structured-only without --live', () => {
    expect(() => parseRunMode(['node', 'run.ts', '--structured-only'])).toThrow(/requires --live/);
  });

  it('routes --live --moderation-corpus to the moderation lane', () => {
    expect(parseRunMode(['node', 'run.ts', '--live', '--moderation-corpus'])).toBe(
      'moderation-corpus',
    );
  });

  it('rejects --moderation-corpus without --live', () => {
    expect(() => parseRunMode(['node', 'run.ts', '--moderation-corpus'])).toThrow(
      /requires --live/,
    );
  });

  it('rejects combining the two keyed lanes', () => {
    expect(() =>
      parseRunMode(['node', 'run.ts', '--live', '--structured-only', '--moderation-corpus']),
    ).toThrow(/one at a time/);
  });
});

describe('readFlagValue', () => {
  it('reads the value that follows the flag', () => {
    expect(readFlagValue(['node', 'run.ts', '--env', 'staging'], '--env')).toBe('staging');
  });

  it('returns undefined when the flag is absent', () => {
    expect(readFlagValue(['node', 'run.ts'], '--env')).toBeUndefined();
  });

  it('throws when the flag has no value', () => {
    expect(() => readFlagValue(['node', 'run.ts', '--env'], '--env')).toThrow(/requires a value/);
    expect(() => readFlagValue(['node', 'run.ts', '--env', '--out'], '--env')).toThrow(
      /requires a value/,
    );
  });
});

describe('runEval (offline)', () => {
  it('scores the seeded set with zero failures and no provider keys', async () => {
    const rows = loadEvalSet();
    const report = await runEval(rows, { live: false });
    expect(report.mode).toBe('offline');
    expect(report.total).toBe(8);
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(8);
    expect(report.results.every((r) => r.source === 'canned')).toBe(true);
  });
});

describe('runEval (live wiring)', () => {
  const row: EvalRow = {
    id: 'live-sample',
    category: 'refund_demand',
    description: 'd',
    input: {
      reviewerName: 'X',
      starRating: 1,
      reviewText: 'bad',
      reviewDate: '2026-01-01',
      detectedLanguage: 'en',
      businessName: 'B',
      businessCategory: null,
    },
    candidate: 'safe canned reply',
    expect: { maxSeverity: 'low', forbiddenCategories: ['refund_discount'] },
  };

  it('throws when live is requested without a generate function', async () => {
    await expect(runEval([row], { live: true })).rejects.toThrow(/generate/);
  });

  it('scores the live-generated text, not the canned candidate', async () => {
    const report = await runEval([row], {
      live: true,
      generate: async () => "We'll issue a full refund.",
    });
    expect(report.results[0]!.source).toBe('live');
    expect(report.results[0]!.passed).toBe(false);
    expect(report.failed).toBe(1);
  });
});
