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

// ── Safety-review corpus mode (G4-F1) ──────────────────────────────────────
//
// The recorded 2026-09-17 run FAILED identically in staging and production:
// omni-moderation-latest returns providerStatus "clean" on a veiled threat and
// on sexual innuendo. This mode adds the missing layer to the scorer.
//
// Three review findings shape what is asserted here, and each one is a way the
// lane could have recorded a PASS that tested nothing:
//   round-1 finding 3  — an OUTAGE must never read as a classification.
//   round-1 finding 9  — a safety-only catch must not silently satisfy a
//                        provider requirement on rows it was not meant to.
//   round-2 finding 10 — zero combined-lane FN does not prove the safety
//                        reviewer resisted injection; another layer can mask it.

import {
  assertSafetyModeEnvironment,
  MODERATION_CORPUS_SAFETY_ACCEPTANCE,
} from '../moderation-runner';
import { loadSafetyCorpus, SAFETY_MODE_RESCUABLE } from '../moderation-corpus-load';
import type { SafetyVerdict } from '../../../src/lib/moderation/safety-review-schema';

const safeVerdict = (over: Partial<SafetyVerdict> = {}): SafetyVerdict => ({
  cleared: true,
  concern: null,
  source: 'llm',
  provider: 'openai',
  ...over,
});
const unsafeVerdict = (over: Partial<SafetyVerdict> = {}): SafetyVerdict => ({
  cleared: false,
  concern: 'implied_threat',
  source: 'llm',
  provider: 'openai',
  ...over,
});

/** The file's own `row` helper, defaulted to an UNSAFE row for this block. */
/** ModerateFn adapters: the decision builders above are sync and take no text. */
const cleanFn = async (_text: string) => providerClean();
const flaggedFn = async (_text: string) => providerFlagged();

const mkRow = (patch: Partial<ModerationCorpusRow>): ModerationCorpusRow =>
  row({ id: 'r-1', label: 'unsafe', bucket: 'threat', text: 'some text', ...patch });

const G4F1_THREAT = mkRow({ id: 'unsafe-threat-02', expectProviderFlag: true });
const G4F1_SEXUAL = mkRow({ id: 'unsafe-sexual-01', bucket: 'sexual', expectProviderFlag: true });

describe('safety-review corpus mode', () => {
  it('scores unsafe-threat-02 as true_positive in the safety-review corpus mode', async () => {
    const report = await runModerationCorpus([G4F1_THREAT], cleanFn, 'test', {
      safetyReview: async () => unsafeVerdict(),
    });

    expect(report.results[0]?.outcome).toBe('true_positive');
    expect(report.verdict).toBe('PASS');
  });

  it('scores unsafe-sexual-01 as true_positive in the safety-review corpus mode', async () => {
    const report = await runModerationCorpus([G4F1_SEXUAL], cleanFn, 'test', {
      safetyReview: async () => unsafeVerdict({ concern: 'implied_sexual' }),
    });

    expect(report.results[0]?.outcome).toBe('true_positive');
    expect(report.verdict).toBe('PASS');
  });

  it('records a safety-only G4-F1 catch without claiming that provider moderation caught the draft', async () => {
    // Round-1 finding 9. Rescuing the row must NOT rewrite attribution:
    // `flaggedByProvider` stays exactly what the provider said, and the report
    // has to say which layer actually caught it, or the evidence doc would
    // claim a provider classification that never happened.
    const report = await runModerationCorpus([G4F1_THREAT], cleanFn, 'test', {
      safetyReview: async () => unsafeVerdict(),
    });

    const result = report.results[0]!;
    expect(result.flaggedByProvider).toBe(false);
    expect(result.flaggedBySafetyReview).toBe(true);
    expect(result.caughtBy).toBe('safety_review');
  });

  it('a safety catch does not erase a provider miss on a row that still requires provider moderation', async () => {
    // Round-2 finding 9. The rescue is bounded by a NAMED SET, not by the
    // predicate "the provider missed it and safety caught it" — that predicate
    // is true of every provider-targeted row, so a future provider regression
    // on an unrelated row would be silently rescued and the protection the
    // lane exists for would vanish.
    const other = mkRow({ id: 'unsafe-harassment-01', bucket: 'harassment', expectProviderFlag: true });
    expect(SAFETY_MODE_RESCUABLE.has(other.id)).toBe(false);

    const report = await runModerationCorpus([other], cleanFn, 'test', {
      safetyReview: async () => unsafeVerdict({ concern: 'targeted_abuse' }),
    });

    expect(report.results[0]?.outcome).toBe('provider_miss');
    expect(report.verdict).toBe('FAIL');
  });

  // ── an outage is not evidence (round-1 finding 3) ────────────────────────

  it('fails the safety-review corpus when an unsafe row receives source=failed instead of a model judgment', async () => {
    // Fail-closed at RUNTIME is correct. Fail-closed as EVIDENCE is a lie: a
    // timeout would otherwise score as a true positive and authorize readiness
    // without the classifier ever having recognized the content.
    const report = await runModerationCorpus([G4F1_THREAT], cleanFn, 'test', {
      safetyReview: async () => unsafeVerdict({ source: 'failed', provider: null }),
    });

    expect(report.results[0]?.outcome).toBe('safety_error');
    expect(report.verdict).toBe('FAIL');
  });

  it('fails the safety-review corpus on a safe-row check failure even when the false-positive budget is not exceeded', async () => {
    // The FP budget is 5%, so one isolated outage on a safe row would fit
    // inside it and disappear. safety_error has its own budget of ZERO.
    const safeRows = Array.from({ length: 40 }, (_, i) =>
      mkRow({ id: `safe-${i}`, label: 'safe', bucket: 'positive_reply', expectProviderFlag: false }),
    );
    const report = await runModerationCorpus(safeRows, cleanFn, 'test', {
      safetyReview: async (text: string) =>
        text.endsWith('safe-0') ? safeVerdict({ source: 'failed', provider: null }) : safeVerdict(),
    });

    expect(report.falsePositiveRate).toBeLessThanOrEqual(
      MODERATION_CORPUS_SAFETY_ACCEPTANCE.maxFalsePositiveRate,
    );
    expect(report.safetyErrors).toBeGreaterThan(0);
    expect(report.verdict).toBe('FAIL');
  });

  it.each(['mock', 'skipped'] as const)(
    'rejects safety-review corpus evidence containing mock or skipped verdicts',
    async (source) => {
      // Deviation D2: reviewSafety returns a mock CLEARANCE under
      // MOCK_EXTERNAL_APIS. A corpus that accepted it would record a PASS that
      // tested nothing — the exact silent-failure shape this lane was built for.
      const report = await runModerationCorpus([G4F1_THREAT], cleanFn, 'test', {
        safetyReview: async () => unsafeVerdict({ source, provider: null }),
      });

      expect(report.results[0]?.outcome).toBe('safety_error');
      expect(report.verdict).toBe('FAIL');
    },
  );

  it('refuses the live safety-review corpus before external calls when MOCK_EXTERNAL_APIS=true', async () => {
    // Deviation D3. BEFORE, not after: refusing once the calls have been made
    // still burns the budget and still produces a transcript that looks like a
    // run. Mirrors the lane's existing OPENAI_MODERATION_ENABLED guard.
    const previous = process.env.MOCK_EXTERNAL_APIS;
    process.env.MOCK_EXTERNAL_APIS = 'true';
    try {
      expect(() => assertSafetyModeEnvironment()).toThrow(/MOCK_EXTERNAL_APIS/);
    } finally {
      if (previous === undefined) delete process.env.MOCK_EXTERNAL_APIS;
      else process.env.MOCK_EXTERNAL_APIS = previous;
    }
  });

  it('records which provider answered each safety-review corpus row', async () => {
    // Deviation D5 mitigation. The Anthropic fallback is kept, so production
    // may answer from a provider the corpus never measured. The evidence must
    // never be able to claim coverage it does not have.
    const report = await runModerationCorpus([G4F1_THREAT, G4F1_SEXUAL], cleanFn, 'test', {
      safetyReview: async (text: string) =>
        unsafeVerdict({ provider: text === G4F1_SEXUAL.text ? 'anthropic' : 'openai' }),
    });

    expect(report.results.map((r) => r.safetyProvider)).toEqual(['openai', 'openai']);
  });

  // ── injection resistance (round-1 finding 10, round-2 finding 10) ────────

  it('requires zero false negatives on the injection-resistant safety corpus rows', async () => {
    const injectionRows = loadSafetyCorpus();
    expect(injectionRows.length).toBeGreaterThanOrEqual(2);

    const report = await runModerationCorpus(injectionRows, cleanFn, 'test', {
      safetyReview: async () => unsafeVerdict(),
    });

    expect(report.falseNegatives).toBe(0);
    expect(report.verdict).toBe('PASS');
  });

  it('injection-targeted rows fail when the safety reviewer clears them even if another moderation layer flags them', async () => {
    // Round-2 finding 10, the masking path. output-filter.ts:67 already flags
    // "ignore previous" and "system prompt" at HIGH severity, so the combined
    // decision can be correct while the layer under test obeyed the injection.
    const injectionRows = loadSafetyCorpus();

    const report = await runModerationCorpus(injectionRows, flaggedFn, 'test', {
      safetyReview: async () => safeVerdict(),
    });

    expect(report.safetyInjectionMisses).toBeGreaterThan(0);
    expect(report.verdict).toBe('FAIL');
  });

  // ── the default mode is untouched (round-2 NEW A) ────────────────────────

  it('leaves the default corpus mode unchanged, so the recorded 2026-09-17 evidence stays reproducible', async () => {
    const withoutOptions = await runModerationCorpus(CORPUS, cleanFn, 'test');
    const withEmptyOptions = await runModerationCorpus(CORPUS, cleanFn, 'test', {});

    expect(withEmptyOptions.results).toEqual(withoutOptions.results);
    expect(withEmptyOptions.acceptance).toEqual(MODERATION_CORPUS_ACCEPTANCE);
    for (const result of withoutOptions.results) {
      expect(result.outcome).not.toBe('safety_error');
    }
  });

  it('loads the default corpus from disk with the recorded row count and report shape', async () => {
    // Round-2 NEW A. Hand-built rows handed to the scorer twice cannot detect
    // the real regression: the injection rows landing in the SHARED file, which
    // loadModerationCorpus returns wholesale (moderation-corpus-load.ts:101)
    // and the report counts as `total` (moderation-runner.ts:151). 53 is the
    // number the 2026-09-17 evidence doc records.
    expect(loadModerationCorpus()).toHaveLength(53);

    const report = await runModerationCorpus(loadModerationCorpus(), cleanFn, 'test');

    expect(report.total).toBe(53);
    expect(report.acceptance).toEqual(MODERATION_CORPUS_ACCEPTANCE);
    expect(Object.keys(report.acceptance).sort()).toEqual([
      'maxFalseNegatives',
      'maxFalsePositiveRate',
      'maxProviderErrors',
      'maxProviderMisses',
    ]);
    // The safety-mode rows live in their OWN file and must never be in this one.
    const ids = new Set(loadModerationCorpus().map((r) => r.id));
    for (const injectionRow of loadSafetyCorpus()) {
      expect(ids.has(injectionRow.id)).toBe(false);
    }
  });
});
