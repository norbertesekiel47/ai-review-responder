import { describe, it, expect } from 'vitest';
import { getLlmTask, OPENAI_MODEL, ANTHROPIC_MODEL } from '../tasks';
import { SafetyReviewOutputSchema } from '@/lib/moderation/safety-review-schema';

// Plan round-1 finding 13: `model-pinning.test.ts` lives at
// src/lib/responses/__tests__/ — outside T2's selection — and its assertions
// are not task-general, so it does not cover a new task's descriptor. This
// suite is the task registry's own door, under the LLM test directory the
// intake already allows.

describe('LLM_TASKS registry', () => {
  it('registers safety_review with the declared pinned model policy, zero temperature, and SafetyReviewOutputSchema', () => {
    const task = getLlmTask('safety_review');

    // Pinned IDs, never a bare alias — a silent model swap changes what a
    // POSTING GATE decides, which is the one place a regression cannot be
    // noticed from output quality alone.
    expect(task.primary).toEqual({ provider: 'openai', model: OPENAI_MODEL });

    // Deviation D5, the owner's decision: the Anthropic fallback is KEPT, so a
    // blocked primary reaches the fallback and only an all-attempts
    // failure yields not-cleared. Availability was chosen over the literal
    // no-call contract; the price is paid by recording the answering provider.
    expect(task.fallback).toEqual({ provider: 'anthropic', model: ANTHROPIC_MODEL });

    // 0, like triage and judge. A posting gate must be reproducible: the same
    // draft must not clear on one call and block on the next.
    expect(task.temperature).toBe(0);

    // The verdict is {cleared, concern}, not prose.
    expect(task.maxTokens).toBe(120);

    // The schema is the executor's authority (`validateStructured`'s safeParse), so
    // the contradiction refine only protects the gate if THIS schema is the one
    // registered here.
    expect(task.outputSchema).toBe(SafetyReviewOutputSchema);
  });
});
