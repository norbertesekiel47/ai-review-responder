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

const VALID_ROW_JSON =
  '{"id":"a","category":"positive","description":"d","input":{"reviewerName":"x","starRating":5,"reviewText":"hi","reviewDate":"2026-01-01","detectedLanguage":"en","businessName":"b","businessCategory":null},"candidate":"thanks","expect":{"maxSeverity":"low","forbiddenCategories":[]}}';

describe('parseEvalSet', () => {
  it('skips blank lines and parses objects', () => {
    const rows = parseEvalSet(
      `${VALID_ROW_JSON}\n\n`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('a');
  });

  it('throws on invalid JSON with the line number', () => {
    expect(() => parseEvalSet('{not json}')).toThrow(
      /^eval-set line 1 is not valid JSON:/,
    );
  });

  it('reports the physical line for malformed JSON after a valid row', () => {
    expect(() => parseEvalSet(`${VALID_ROW_JSON}\n{not json}`)).toThrow(
      /^eval-set line 2 is not valid JSON:/,
    );
  });

  it('reports an earlier row-shape error before parsing a later line', () => {
    expect(() => parseEvalSet('{}\n{not json}')).toThrow(
      /^eval-set line 1 id must be a non-empty string$/,
    );
  });

  it('throws on a missing id', () => {
    expect(() => parseEvalSet('{"category":"positive"}')).toThrow(/id/);
  });

  it('throws when id is not a string', () => {
    expect(() => parseEvalSet('{"id":123,"candidate":"ok","expect":{"maxSeverity":"low","forbiddenCategories":[]}}')).toThrow(
      /line 1.*id.*string/,
    );
  });

  it('throws when candidate is missing or not a string', () => {
    expect(() => parseEvalSet('{"id":"a","expect":{"maxSeverity":"low","forbiddenCategories":[]}}')).toThrow(
      /line 1.*candidate/,
    );
    expect(() => parseEvalSet('{"id":"a","candidate":false,"expect":{"maxSeverity":"low","forbiddenCategories":[]}}')).toThrow(
      /line 1.*candidate.*string/,
    );
  });

  it('throws when expect is missing or malformed', () => {
    expect(() => parseEvalSet('{"id":"a","candidate":"ok"}')).toThrow(
      /line 1.*expect/,
    );
    expect(() => parseEvalSet('{"id":"a","candidate":"ok","expect":{"maxSeverity":"low","forbiddenCategories":"refund_discount"}}')).toThrow(
      /line 1.*forbiddenCategories.*array/,
    );
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
