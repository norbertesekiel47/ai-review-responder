import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Textual pins for the binding review-lane lock order
// (reviews -> businesses -> responses/children -> accounts). A source guard
// alone is blind to implicit-FK misordering, so JudgeWorker.test.ts /
// failed-hook.test.ts pin the same order at runtime — keep both sides in sync.

function sourceOf(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
}

function orderedIndexes(source: string, markers: string[]): number[] {
  return markers.map((marker) => {
    const index = source.indexOf(marker);
    expect(index, `expected marker ${JSON.stringify(marker)} in source`).toBeGreaterThan(-1);
    return index;
  });
}

function expectStrictlyAscending(indexes: number[], markers: string[]): void {
  for (let i = 1; i < indexes.length; i++) {
    expect(
      indexes[i]!,
      `expected ${JSON.stringify(markers[i])} after ${JSON.stringify(markers[i - 1])}`,
    ).toBeGreaterThan(indexes[i - 1]!);
  }
}

describe('judge verdict lock-order source shape', () => {
  it.each(['JudgeWorker.ts', 'failed-hook.ts'])('%s anchors before the verdict writer', (file) => {
    const source = sourceOf(file);
    const anchor = source.indexOf('anchorReviewLockOrder(');
    const verdictWrite = source.indexOf('insertJudgeVerdict(');

    expect(anchor).toBeGreaterThan(-1);
    expect(verdictWrite).toBeGreaterThan(anchor);
    expect(source).not.toMatch(/\b(?:completeRun|recordOutcome|recordStep)\s*\(/);
  });

  it.each(['JudgeWorker.ts', 'failed-hook.ts'])(
    '%s takes the explicit businesses lock between the review anchor and the verdict writer',
    (file) => {
      const source = sourceOf(file);
      const markers = [
        'anchorReviewLockOrder(',
        'FROM businesses',
        'insertJudgeVerdict(',
      ];
      expectStrictlyAscending(orderedIndexes(source, markers), markers);
    },
  );

  it('orders the JudgeWorker tx anchor < businesses < response lock < account lock < verdict insert < suspension', () => {
    const source = sourceOf('JudgeWorker.ts');
    // 'FROM responses' first occurs in the FOR UPDATE current-state re-check
    // (the anchor's own responses pre-read lives in outcomes.ts, not here).
    const markers = [
      'anchorReviewLockOrder(',
      'FROM businesses',
      'FROM responses',
      'lockAutonomyAccount(',
      'insertJudgeVerdict(',
      'suspendAccountAutonomy(',
    ];
    expectStrictlyAscending(orderedIndexes(source, markers), markers);
  });

  it('keeps the flag-only account pre-lock out of the failed hook (error verdicts never suspend)', () => {
    const source = sourceOf('failed-hook.ts');
    expect(source).not.toContain('lockAutonomyAccount(');
    expect(source).not.toContain('suspendAccountAutonomy(');
  });
});
