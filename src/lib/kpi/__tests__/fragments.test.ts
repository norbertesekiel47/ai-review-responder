// src/lib/kpi/__tests__/fragments.test.ts
//
// Unit pins for the Review-time anchor fragments (#757, ADR 0019) plus the
// single-owner source audit that keeps `src/lib/kpi/fragments.ts` the ONLY
// place the anchor is spelled.
//
// The first two tests are `.todo` until the module exists — Task 2 of the #757
// plan converts them. A surviving `.todo` satisfies the promised-tests gate
// while proving nothing; treat one as a review-blocking defect.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const OWNER = join('src', 'lib', 'kpi', 'fragments.ts');
const ANCHOR_PATTERN = /LEAST\(\s*(?:[A-Za-z_][\w$]*\.)?review_date\s*,/;

function sourceFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((p) => /\.tsx?$/.test(p) && !p.includes('__tests__'))
    .map((p) => join(root, p));
}

describe('kpi/fragments — Review-time anchor owner (#757)', () => {
  it.todo('reviewTimeAnchor emits the unprefixed and r.-prefixed spellings and nothing else');
  it.todo('reviewTimeWindowFilter binds the window as an integer parameter, never interpolated text');

  it('the Review-time anchor is spelled only in kpi/fragments.ts', () => {
    const offenders = [...sourceFiles('src'), ...sourceFiles('worker')]
      .filter((f) => f !== OWNER && ANCHOR_PATTERN.test(readFileSync(f, 'utf8')));
    // Every composer must go through the fragment. A hand-spelled LEAST in
    // dashboard/service.ts would satisfy the live-DB suite AND the shape pins
    // while leaving fragments.ts dead — this is the only test that catches it.
    expect(offenders).toEqual([]);
  });
});
