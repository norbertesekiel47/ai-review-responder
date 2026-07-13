import { afterEach, describe, expect, it } from 'vitest';
import { judgeEnabled } from '../judge-flags';

describe('judgeEnabled', () => {
  afterEach(() => {
    delete process.env.JUDGE_ENABLED;
  });

  it('is true only for the literal true string', () => {
    process.env.JUDGE_ENABLED = 'true';
    expect(judgeEnabled()).toBe(true);

    process.env.JUDGE_ENABLED = '1';
    expect(judgeEnabled()).toBe(false);
  });
});
