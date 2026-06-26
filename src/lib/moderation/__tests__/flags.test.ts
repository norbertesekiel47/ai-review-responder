import { afterEach, describe, expect, it } from 'vitest';
import { openaiModerationEnabled } from '../flags';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('openaiModerationEnabled', () => {
  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['false', 'false'],
    ['uppercase TRUE', 'TRUE'],
    ['mixed case True', 'True'],
    ['numeric 1', '1'],
    ['padded true', ' true '],
  ])('is false for %s', (_label, value) => {
    if (value === undefined) delete process.env.OPENAI_MODERATION_ENABLED;
    else process.env.OPENAI_MODERATION_ENABLED = value;
    expect(openaiModerationEnabled()).toBe(false);
  });

  it('is true ONLY for the exact string "true"', () => {
    process.env.OPENAI_MODERATION_ENABLED = 'true';
    expect(openaiModerationEnabled()).toBe(true);
  });
});
