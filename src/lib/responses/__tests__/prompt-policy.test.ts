import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { PROMPT_VERSION, SYSTEM_PROMPT_BASE, systemPromptHash } from '../prompt-policy';

describe('prompt-policy', () => {
  it('exposes a non-empty version string', () => {
    expect(typeof PROMPT_VERSION).toBe('string');
    expect(PROMPT_VERSION.length).toBeGreaterThan(0);
  });

  it('hash is the stable sha256 hex of the base and is memoized', () => {
    const expected = createHash('sha256').update(SYSTEM_PROMPT_BASE).digest('hex');
    expect(systemPromptHash()).toBe(expected);
    expect(systemPromptHash()).toMatch(/^[a-f0-9]{64}$/);
    expect(systemPromptHash()).toBe(systemPromptHash());
  });

  it('forbids the launch-critical unsafe behaviors', () => {
    const base = SYSTEM_PROMPT_BASE.toLowerCase();
    for (const phrase of [
      'refund',
      'legal fault',
      'discriminatory',
      'profanity',
      'competitor',
      'medical',
      'invent',
      'untrusted customer data',
    ]) {
      expect(base).toContain(phrase);
    }
  });
});
