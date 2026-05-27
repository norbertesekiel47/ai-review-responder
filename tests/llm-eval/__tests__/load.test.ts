// tests/llm-eval/__tests__/load.test.ts
import { describe, expect, it } from 'vitest';
import { loadEvalSet, parseEvalSet } from '../load';
import { scoreRow } from '../scorer';
import type { EvalCategory } from '../types';

const EXPECTED_CATEGORIES: EvalCategory[] = [
  'positive',
  'negative_complaint',
  'refund_demand',
  'prompt_injection',
  'competitor_mention',
  'no_written_review',
  'bilingual',
  'sensitive_category',
];

describe('parseEvalSet', () => {
  it('skips blank lines and parses objects', () => {
    const rows = parseEvalSet(
      '{"id":"a","category":"positive","description":"d","input":{"reviewerName":"x","starRating":5,"reviewText":"hi","reviewDate":"2026-01-01","detectedLanguage":"en","businessName":"b","businessCategory":null},"candidate":"thanks","expect":{"maxSeverity":"low","forbiddenCategories":[]}}\n\n',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('a');
  });

  it('throws on invalid JSON with the line number', () => {
    expect(() => parseEvalSet('{not json}')).toThrow(/line 1/);
  });

  it('throws on a missing id', () => {
    expect(() => parseEvalSet('{"category":"positive"}')).toThrow(/id/);
  });

  it('throws on a duplicate id', () => {
    const line =
      '{"id":"dup","category":"positive","description":"d","input":{"reviewerName":"x","starRating":5,"reviewText":"hi","reviewDate":"2026-01-01","detectedLanguage":"en","businessName":"b","businessCategory":null},"candidate":"thanks","expect":{"maxSeverity":"low","forbiddenCategories":[]}}';
    expect(() => parseEvalSet(`${line}\n${line}`)).toThrow(/duplicate/);
  });
});

describe('loadEvalSet (the seeded launch set)', () => {
  const rows = loadEvalSet();

  it('contains exactly 8 rows', () => {
    expect(rows).toHaveLength(8);
  });

  it('covers all 8 launch categories', () => {
    const seen = new Set(rows.map((r) => r.category));
    expect([...seen].sort()).toEqual([...EXPECTED_CATEGORIES].sort());
  });

  it('every canned candidate passes its own expectation (set is internally consistent)', () => {
    for (const row of rows) {
      const result = scoreRow(row, row.candidate, 'canned');
      expect(
        result.passed,
        `row "${row.id}" failed: ${result.failures.join('; ')}`,
      ).toBe(true);
    }
  });
});
