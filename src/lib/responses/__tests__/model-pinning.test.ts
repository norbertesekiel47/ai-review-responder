import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { OPENAI_MODEL, ANTHROPIC_MODEL, getLlmTask } from '@/lib/llm/tasks';
import { calculateCostUsd } from '@/lib/costs/audit';
import { JudgeOutputSchema } from '../judge-schema';
import { SolicitationAskOutputSchema } from '@/lib/solicitation/ask-schema';

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

  it('pins the reply_generation task to the snapshot models (no bare alias)', () => {
    const task = getLlmTask('reply_generation');
    expect(task.primary).toEqual({ provider: 'openai', model: OPENAI_MODEL });
    expect(task.fallback).toEqual({ provider: 'anthropic', model: ANTHROPIC_MODEL });
  });

  it('pins the insights task (review-summary tenant) to the snapshot models (no bare alias)', () => {
    const task = getLlmTask('insights');
    expect(task.primary).toEqual({ provider: 'openai', model: OPENAI_MODEL });
    expect(task.primary.model).not.toBe('gpt-4o-mini');
    expect(task.fallback).toEqual({ provider: 'anthropic', model: ANTHROPIC_MODEL });
  });

  it('review-summary drives the seam and never hard-codes a bare gpt-4o-mini alias', () => {
    const source = readFileSync(new URL('../review-summary.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("'gpt-4o-mini'");
    expect(source).toContain("runLlmTask('insights'");
  });

  it('triage task pins both providers to the pinned snapshots', () => {
    const task = getLlmTask('triage');
    expect(task.primary).toEqual({ provider: 'openai', model: OPENAI_MODEL });
    expect(task.fallback).toEqual({ provider: 'anthropic', model: ANTHROPIC_MODEL });
    expect(task.temperature).toBe(0);
    expect(task.outputSchema).toBeDefined();
  });

  it('judge task pins both providers and its structured-output limits', () => {
    const task = getLlmTask('judge');
    expect(task.taskId).toBe('judge');
    expect(task.primary).toEqual({ provider: 'openai', model: OPENAI_MODEL });
    expect(task.primary.model).not.toBe('gpt-4o-mini');
    expect(task.fallback).toEqual({ provider: 'anthropic', model: ANTHROPIC_MODEL });
    expect(task.maxTokens).toBe(300);
    expect(task.temperature).toBe(0);
    expect(task.outputSchema).toBe(JudgeOutputSchema);
  });

  it('pins solicitation_ask to the shared model pair at temperature 0.6', () => {
    const task = getLlmTask('solicitation_ask');
    expect(task.taskId).toBe('solicitation_ask');
    expect(task.primary).toEqual({ provider: 'openai', model: OPENAI_MODEL });
    expect(task.primary.model).not.toBe('gpt-4o-mini');
    expect(task.fallback).toEqual({ provider: 'anthropic', model: ANTHROPIC_MODEL });
    expect(task.maxTokens).toBe(400);
    expect(task.temperature).toBe(0.6);
    expect(task.outputSchema).toBe(SolicitationAskOutputSchema);
  });
});
