// tests/llm-eval/__tests__/moderation-corpus.test.ts
import { describe, expect, it } from 'vitest';
import { runOutputFilter, type ModerationDecision } from '../../../src/lib/moderation/output-filter';
import { loadModerationCorpus, parseModerationCorpus } from '../moderation-corpus-load';
import { runModerationCorpus, MODERATION_CORPUS_ACCEPTANCE } from '../moderation-runner';
import {
  SAFE_BUCKETS,
  UNSAFE_BUCKETS,
  type ModerationCorpusRow,
} from '../moderation-types';

const CORPUS = loadModerationCorpus();

describe('moderation corpus integrity (keyless)', () => {
  it('loads rows with unique ids and both labels represented', () => {
    expect(CORPUS.length).toBeGreaterThan(0);
    expect(new Set(CORPUS.map((row) => row.id)).size).toBe(CORPUS.length);
    expect(CORPUS.some((row) => row.label === 'safe')).toBe(true);
    expect(CORPUS.some((row) => row.label === 'unsafe')).toBe(true);
  });

  it('covers every declared bucket', () => {
    const present = new Set(CORPUS.map((row) => row.bucket));
    for (const bucket of [...SAFE_BUCKETS, ...UNSAFE_BUCKETS]) {
      expect(present.has(bucket), `bucket "${bucket}" has no row`).toBe(true);
    }
  });

  // Without this, a live false positive could come from either layer and the
  // run would prove nothing about the provider.
  it('keeps every safe row clean against the local filter', () => {
    for (const row of CORPUS.filter((r) => r.label === 'safe')) {
      const decision = runOutputFilter(row.text);
      expect(decision.flagged, `${row.id} trips local rule(s): ${decision.reason}`).toBe(false);
    }
  });

  // Without this, a provider-targeted row could be caught by the local filter
  // and score a true positive while the provider was never exercised.
  it('keeps every provider-targeted unsafe row clean against the local filter', () => {
    for (const row of CORPUS.filter((r) => r.expectProviderFlag)) {
      const decision = runOutputFilter(row.text);
      expect(decision.flagged, `${row.id} trips local rule(s): ${decision.reason}`).toBe(false);
    }
  });

  it('gives the false-positive budget at least one row of headroom', () => {
    const safeTotal = CORPUS.filter((row) => row.label === 'safe').length;
    expect(safeTotal * MODERATION_CORPUS_ACCEPTANCE.maxFalsePositiveRate).toBeGreaterThanOrEqual(1);
  });
});

describe('parseModerationCorpus validation', () => {
  const valid = {
    id: 'x-1',
    label: 'safe',
    bucket: 'positive_reply',
    description: 'd',
    text: 'thanks',
    expectProviderFlag: false,
  };
  const line = (patch: Record<string, unknown>) =>
    JSON.stringify({ ...valid, ...patch });

  it('rejects an empty corpus', () => {
    expect(() => parseModerationCorpus('\n\n')).toThrow(/empty/);
  });

  it('rejects a duplicate id', () => {
    expect(() => parseModerationCorpus(`${line({})}\n${line({})}`)).toThrow(/duplicate/);
  });

  it('rejects an unknown bucket', () => {
    expect(() => parseModerationCorpus(line({ bucket: 'nope' }))).toThrow(/bucket/);
  });

  it('rejects a label and bucket that disagree', () => {
    expect(() => parseModerationCorpus(line({ bucket: 'threat' }))).toThrow(/unsafe bucket/);
    expect(() =>
      parseModerationCorpus(line({ label: 'unsafe', bucket: 'positive_reply' })),
    ).toThrow(/safe bucket/);
  });

  it('rejects a safe row that expects a provider flag', () => {
    expect(() => parseModerationCorpus(line({ expectProviderFlag: true }))).toThrow(
      /must not expect a provider flag/,
    );
  });

  it('rejects a missing text field', () => {
    expect(() => parseModerationCorpus(line({ text: '  ' }))).toThrow(/text/);
  });
});

// --- runner classification, with a stubbed provider ----------------------

const LOCAL_CLEAN: ModerationDecision = {
  flagged: false,
  severity: 'low',
  reason: null,
  categories: {},
  score: 0,
  source: null,
  providerStatus: null,
};

const providerClean = (): ModerationDecision => ({
  ...LOCAL_CLEAN,
  providerStatus: 'clean',
  categories: { openai_moderation: 'clean' },
});

const providerFlagged = (): ModerationDecision => ({
  flagged: true,
  severity: 'high',
  reason: 'openai_moderation',
  categories: { openai_categories: { harassment: true } },
  score: 1,
  source: 'openai_moderation',
  providerStatus: null,
});

const localOnlyFlagged = (): ModerationDecision => ({
  flagged: true,
  severity: 'high',
  reason: 'profanity',
  categories: { profanity: 1, openai_moderation: 'clean' },
  score: 1,
  source: 'local_regex',
  providerStatus: 'clean',
});

const providerError = (): ModerationDecision => ({
  ...LOCAL_CLEAN,
  providerStatus: 'error',
  categories: { openai_moderation: 'error' },
});

const row = (patch: Partial<ModerationCorpusRow>): ModerationCorpusRow => ({
  id: 'r',
  label: 'safe',
  bucket: 'positive_reply',
  description: 'd',
  text: 'Thank you for the kind words.',
  expectProviderFlag: false,
  ...patch,
});

const outcomeOf = async (
  r: ModerationCorpusRow,
  decision: ModerationDecision,
): Promise<string> => {
  const report = await runModerationCorpus([r], async () => decision, 'test');
  return report.results[0]!.outcome;
};

describe('runModerationCorpus classification', () => {
  it('scores a clean safe row as a true negative', async () => {
    await expect(outcomeOf(row({}), providerClean())).resolves.toBe('true_negative');
  });

  it('scores a flagged safe row as a false positive', async () => {
    await expect(outcomeOf(row({}), providerFlagged())).resolves.toBe('false_positive');
  });

  it('scores a provider-flagged unsafe row as a true positive', async () => {
    const r = row({ label: 'unsafe', bucket: 'harassment', expectProviderFlag: true });
    await expect(outcomeOf(r, providerFlagged())).resolves.toBe('true_positive');
  });

  it('scores an unflagged unsafe row as a false negative', async () => {
    const r = row({ label: 'unsafe', bucket: 'harassment', expectProviderFlag: true });
    await expect(outcomeOf(r, providerClean())).resolves.toBe('false_negative');
  });

  it('scores a provider-targeted row caught only locally as a provider miss', async () => {
    const r = row({ label: 'unsafe', bucket: 'harassment', expectProviderFlag: true });
    await expect(outcomeOf(r, localOnlyFlagged())).resolves.toBe('provider_miss');
  });

  it('scores a provider error as provider_error, whatever the label', async () => {
    await expect(outcomeOf(row({}), providerError())).resolves.toBe('provider_error');
  });

  // The runbook's named silent-failure mode: the flag is off, the provider is
  // never called, and every row would otherwise look clean.
  it('scores an untouched local decision as provider_not_reached', async () => {
    await expect(outcomeOf(row({}), LOCAL_CLEAN)).resolves.toBe('provider_not_reached');
  });
});

describe('runModerationCorpus verdict', () => {
  const safeRows = (count: number) =>
    Array.from({ length: count }, (_, index) => row({ id: `safe-${index}` }));

  it('passes when every row is correct', async () => {
    const report = await runModerationCorpus(safeRows(20), async () => providerClean(), 'test');
    expect(report.verdict).toBe('PASS');
    expect(report.violations).toEqual([]);
  });

  it('passes with a false-positive count inside the budget', async () => {
    // One FP out of 20 safe rows is 5%, exactly the budget.
    const rows = safeRows(20);
    rows[0]!.text = 'FP';
    const report = await runModerationCorpus(
      rows,
      async (text) => (text === 'FP' ? providerFlagged() : providerClean()),
      'test',
    );
    expect(report.falsePositives).toBe(1);
    expect(report.falsePositiveRate).toBe(0.05);
    expect(report.verdict).toBe('PASS');
    // The row is still counted as incorrect; the verdict is the budget, not the count.
    expect(report.failed).toBe(1);
  });

  it('fails when the false-positive rate exceeds the budget', async () => {
    const rows = safeRows(20);
    rows[0]!.text = 'FP';
    rows[1]!.text = 'FP';
    const report = await runModerationCorpus(
      rows,
      async (text) => (text === 'FP' ? providerFlagged() : providerClean()),
      'test',
    );
    expect(report.verdict).toBe('FAIL');
    expect(report.violations.join(' ')).toMatch(/false-positive rate/);
  });

  it('fails on a single false negative regardless of the rest', async () => {
    const rows = [
      ...safeRows(20),
      row({ id: 'u-1', label: 'unsafe', bucket: 'threat', expectProviderFlag: true, text: 'MISS' }),
    ];
    const report = await runModerationCorpus(
      rows,
      async () => providerClean(),
      'test',
    );
    expect(report.falseNegatives).toBe(1);
    expect(report.verdict).toBe('FAIL');
    expect(report.violations.join(' ')).toMatch(/false negatives/);
  });

  it('fails and names the flag when the provider was never reached', async () => {
    const report = await runModerationCorpus(safeRows(3), async () => LOCAL_CLEAN, 'test');
    expect(report.verdict).toBe('FAIL');
    expect(report.violations.join(' ')).toMatch(/OPENAI_MODERATION_ENABLED/);
  });
});
