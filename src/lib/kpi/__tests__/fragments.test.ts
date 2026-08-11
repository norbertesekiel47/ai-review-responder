// src/lib/kpi/__tests__/fragments.test.ts
//
// Unit pins for the Review-time anchor fragments (#757, ADR 0019) plus the
// single-owner source audit that keeps `src/lib/kpi/fragments.ts` the ONLY
// place the anchor is spelled.
//
// The first two tests were authored `.todo` before the module existed and were
// converted in Task 2 of the #757 plan. A surviving `.todo` satisfies the
// promised-tests gate while proving nothing; treat one as a review-blocking
// defect.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';

import { createMockSql } from '../../../../worker/__tests__/helpers/mock-sql';
import { reviewTimeAnchor, reviewTimeWindowFilter } from '../fragments';

const OWNER = join('src', 'lib', 'kpi', 'fragments.ts');
// Matches the anchor in EITHER argument order. LEAST(detected_at, review_date)
// is semantically identical, so pinning only the review_date-first spelling
// would let a hand-rolled copy of the anchor slip past this audit.
const COL = String.raw`(?:[A-Za-z_][\w$]*\.)?`;
const ANCHOR_PATTERN = new RegExp(
  String.raw`LEAST\(\s*${COL}(?:review_date\s*,\s*${COL}detected_at|detected_at\s*,\s*${COL}review_date)\s*\)`,
);

function sourceFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((p) => /\.tsx?$/.test(p) && !p.includes('__tests__'))
    .map((p) => join(root, p));
}

describe('kpi/fragments — Review-time anchor owner (#757)', () => {
  it('reviewTimeAnchor emits the unprefixed and r.-prefixed spellings and nothing else', async () => {
    const harness = createMockSql();
    const sql = harness.mockSql as unknown as Sql;
    await sql`SELECT ${reviewTimeAnchor(sql, '')} AS a`;
    await sql`SELECT ${reviewTimeAnchor(sql, 'r.')} AS a`;
    expect(harness.sqlCalls[0]!.text).toBe('SELECT LEAST(review_date, detected_at) AS a');
    expect(harness.sqlCalls[1]!.text).toBe('SELECT LEAST(r.review_date, r.detected_at) AS a');
    // No FROM/JOIN and no tenant predicate may ever live in the fragment —
    // ci:tenant-scope reads raw template text and would stop seeing it.
    for (const call of harness.sqlCalls) {
      expect(call.text).not.toMatch(/\bFROM\b|\bJOIN\b|business_id|account_id/);
      expect(call.values).toEqual([]);
    }
  });

  it('reviewTimeWindowFilter binds the window as an integer parameter, never interpolated text', async () => {
    const harness = createMockSql();
    const sql = harness.mockSql as unknown as Sql;
    await sql`SELECT 1 WHERE ${reviewTimeWindowFilter(sql, '', 30)}`;
    const call = harness.sqlCalls[0]!;
    expect(call.text).toBe(
      'SELECT 1 WHERE LEAST(review_date, detected_at) >= NOW() - make_interval(days => ?)',
    );
    expect(call.text).not.toMatch(/INTERVAL\s+'\d+\s+days'/i);
    expect(call.values).toEqual([30]);
  });

  it('the Review-time anchor is spelled only in kpi/fragments.ts', () => {
    const offenders = [...sourceFiles('src'), ...sourceFiles('worker')]
      .filter((f) => f !== OWNER && ANCHOR_PATTERN.test(readFileSync(f, 'utf8')));
    // Every composer must go through the fragment. A hand-spelled LEAST in
    // dashboard/service.ts would satisfy the live-DB suite AND the shape pins
    // while leaving fragments.ts dead — this is the only test that catches it.
    expect(offenders).toEqual([]);
  });
});
