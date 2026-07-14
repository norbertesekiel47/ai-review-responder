import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  JUDGE_PROMPT_VERSION,
  JUDGE_SYSTEM_PROMPT,
  judgeSystemPromptHash,
} from '../judge-policy';

describe('judge prompt policy', () => {
  it('versions and hashes the complete safety rubric', () => {
    expect(JUDGE_PROMPT_VERSION).toBe('2026-07-13.1');
    expect(judgeSystemPromptHash()).toBe(
      createHash('sha256').update(JUDGE_SYSTEM_PROMPT).digest('hex'),
    );

    const rubric = JUDGE_SYSTEM_PROMPT.toLowerCase();
    for (const required of [
      'compensation',
      'discount',
      'personally identifiable information',
      'pii',
      'fabricated',
      'hostile',
      'defensive',
      'brand-safe',
      'json',
    ]) {
      expect(rubric).toContain(required);
    }
  });
});
