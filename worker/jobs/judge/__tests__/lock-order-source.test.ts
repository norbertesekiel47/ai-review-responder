import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('judge verdict lock-order source shape', () => {
  it.each(['JudgeWorker.ts', 'failed-hook.ts'])('%s anchors before the verdict writer', (file) => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const anchor = source.indexOf('anchorReviewLockOrder(');
    const verdictWrite = source.indexOf('insertJudgeVerdict(');

    expect(anchor).toBeGreaterThan(-1);
    expect(verdictWrite).toBeGreaterThan(anchor);
    expect(source).not.toMatch(/\b(?:completeRun|recordOutcome|recordStep)\s*\(/);
  });
});
