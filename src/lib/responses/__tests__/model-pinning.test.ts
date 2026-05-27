import { describe, it, expect } from 'vitest';
import { OPENAI_MODEL, ANTHROPIC_MODEL } from '../generator';
import { calculateCostUsd } from '@/lib/costs/audit';

describe('LLM model pinning', () => {
  it('pins the OpenAI model to a dated snapshot (no bare alias)', () => {
    expect(OPENAI_MODEL).toMatch(/^gpt-4o-mini-\d{4}-\d{2}-\d{2}$/);
    expect(OPENAI_MODEL).not.toBe('gpt-4o-mini');
  });

  it('keeps the Anthropic model pinned', () => {
    expect(ANTHROPIC_MODEL).toBe('claude-haiku-4-5-20251001');
  });

  it('has pricing for the pinned OpenAI model', () => {
    expect(() => calculateCostUsd(OPENAI_MODEL, 1000, 500)).not.toThrow();
    expect(calculateCostUsd(OPENAI_MODEL, 1_000_000, 0)).toBeCloseTo(0.15, 6);
  });
});
