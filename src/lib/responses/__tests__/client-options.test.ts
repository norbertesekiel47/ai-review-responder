import { describe, it, expect } from 'vitest';
import { LLM_CLIENT_OPTIONS } from '@/lib/llm/client-options';

// Guard for deep-scan §5.1/§5.2: the OpenAI and Anthropic clients in the LLM
// seam providers (openai-provider.ts / anthropic-provider.ts) MUST be
// constructed with an explicit 30s timeout and zero SDK retries. Reverting to
// the SDK defaults (10-minute timeout, 2 internal retries) would let a provider
// stall pin a worker and stack up to 6 billed LLM attempts under BullMQ attempts:3.
// Both constructors reference LLM_CLIENT_OPTIONS, so asserting the constant here
// locks the values that reach `new OpenAI(...)` / `new Anthropic(...)`.
describe('LLM client construction options', () => {
  it('bounds the request timeout to 30s', () => {
    expect(LLM_CLIENT_OPTIONS.timeout).toBe(30_000);
  });

  it('disables SDK-internal retries (BullMQ + outbox watchdog own retries)', () => {
    expect(LLM_CLIENT_OPTIONS.maxRetries).toBe(0);
  });

  it('exposes exactly the construction options (no accidental extra knobs)', () => {
    expect(LLM_CLIENT_OPTIONS).toEqual({ timeout: 30_000, maxRetries: 0 });
  });
});
