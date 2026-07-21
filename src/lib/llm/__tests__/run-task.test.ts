import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import type { ChatPrompt, LLMCallResult, LLMProviderId, LLMTaskDescriptor } from '../types';
import { llmCircuitBreaker } from '../circuit-breaker';

// ── Mock the provider seam (not the raw SDKs) — run-task.ts resolves
// providers through the registry, so the unit under test is the fallback
// orchestration, not client construction. ──────────────────────────────

const openaiComplete = vi.fn();
vi.mock('../openai-provider', () => ({
  openaiProvider: { id: 'openai', complete: openaiComplete },
}));

const anthropicComplete = vi.fn();
vi.mock('../anthropic-provider', () => ({
  anthropicProvider: { id: 'anthropic', complete: anthropicComplete },
}));

// The circuit breaker emits Sentry warnings on state transitions; capture them
// so the trip test can assert exactly one closed→open alert fired.
const captureMessage = vi.fn();
vi.mock('@sentry/node', () => ({
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

// getLlmTask defaults to the real registry; individual tests inject synthetic
// descriptors (fallback-less, schema-bearing) via mockReturnValueOnce.
// (clearAllMocks clears calls, not the implementation set here.)
const getLlmTask = vi.fn();
vi.mock('../tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tasks')>();
  getLlmTask.mockImplementation(actual.getLlmTask);
  return { ...actual, getLlmTask };
});

// ── Helpers ──────────────────────────────────────────────────────────

function callResult(overrides: Partial<LLMCallResult> = {}): LLMCallResult {
  return {
    text: 'Thanks!',
    provider: 'openai',
    model: 'gpt-4o-mini-2024-07-18',
    usage: { promptTokens: 100, completionTokens: 50 },
    ...overrides,
  };
}

const prompt: ChatPrompt = {
  system: 'You are a helpful assistant.',
  user: 'Say thanks.',
};

describe('runLlmTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The breaker is a process-wide singleton consulted on every attempt —
    // reset it so state never leaks across tests.
    llmCircuitBreaker.reset();
  });

  it('returns the primary provider result when it succeeds', async () => {
    openaiComplete.mockResolvedValueOnce(
      callResult({ provider: 'openai', text: 'Thanks, Jane!' }),
    );

    const { runLlmTask } = await import('../run-task');
    const result = await runLlmTask('reply_generation', prompt);

    expect(result.provider).toBe('openai');
    expect(result.text).toBe('Thanks, Jane!');
    expect(openaiComplete).toHaveBeenCalledOnce();
    expect(anthropicComplete).not.toHaveBeenCalled();
  });

  it('falls back to Anthropic when the primary throws, and logs the failover', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    openaiComplete.mockRejectedValueOnce(new Error('OpenAI rate limit'));
    anthropicComplete.mockResolvedValueOnce(
      callResult({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', text: 'Merci, Jane!' }),
    );

    const { runLlmTask } = await import('../run-task');
    const result = await runLlmTask('reply_generation', prompt);

    expect(result.provider).toBe('anthropic');
    expect(result.text).toBe('Merci, Jane!');
    // The structured logger (createWorkerLogger) emits one JSON line to
    // console.error; the failover message is embedded in that line.
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('falling back to anthropic'),
    );

    consoleErrorSpy.mockRestore();
  });

  // M4-equivalent regression (see generator.test.ts): when only ONE
  // provider's failure is transient, the TransientLLMError must wrap the
  // actually-transient one — wrapping the wrong one would let the worker
  // retry forever against a permanent failure.

  it('wraps the primary cause when primary is transient + fallback is permanent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const primaryTransient = Object.assign(new Error('openai 503'), { code: 'ECONNRESET' });
    const fallbackPermanent = Object.assign(new Error('anthropic auth failed'), {
      name: 'AuthenticationError',
    });

    openaiComplete.mockRejectedValueOnce(primaryTransient);
    anthropicComplete.mockRejectedValueOnce(fallbackPermanent);

    const { runLlmTask } = await import('../run-task');
    const { TransientLLMError } = await import('../error-classifier');

    try {
      await runLlmTask('reply_generation', prompt);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TransientLLMError);
      expect((err as InstanceType<typeof TransientLLMError>).cause).toBe(primaryTransient);
    }
  });

  it('wraps the fallback cause when fallback is transient + primary is permanent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const primaryPermanent = Object.assign(new Error('openai bad request'), {
      name: 'BadRequestError',
    });
    const fallbackTransient = Object.assign(new Error('anthropic timeout'), { code: 'ETIMEDOUT' });

    openaiComplete.mockRejectedValueOnce(primaryPermanent);
    anthropicComplete.mockRejectedValueOnce(fallbackTransient);

    const { runLlmTask } = await import('../run-task');
    const { TransientLLMError } = await import('../error-classifier');

    try {
      await runLlmTask('reply_generation', prompt);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TransientLLMError);
      expect((err as InstanceType<typeof TransientLLMError>).cause).toBe(fallbackTransient);
    }
  });

  it('rethrows the fallback error (not TransientLLMError) when both failures are permanent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const primaryPermanent = Object.assign(new Error('openai bad request'), {
      name: 'BadRequestError',
    });
    const fallbackPermanent = Object.assign(new Error('anthropic auth failed'), {
      name: 'AuthenticationError',
    });

    openaiComplete.mockRejectedValueOnce(primaryPermanent);
    anthropicComplete.mockRejectedValueOnce(fallbackPermanent);

    const { runLlmTask } = await import('../run-task');
    const { TransientLLMError } = await import('../error-classifier');

    try {
      await runLlmTask('reply_generation', prompt);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).not.toBeInstanceOf(TransientLLMError);
      expect(err).toBe(fallbackPermanent);
    }
  });

  it('throws for an unregistered task id', async () => {
    const { runLlmTask } = await import('../run-task');

    await expect(runLlmTask('unregistered' as never, prompt)).rejects.toThrow(
      'LLM task not registered: unregistered',
    );
    expect(openaiComplete).not.toHaveBeenCalled();
    expect(anthropicComplete).not.toHaveBeenCalled();
  });

  // Fallback-less tasks (none registered today) keep transient-uniform
  // semantics: a transient primary failure is wrapped in TransientLLMError
  // exactly like the two-provider path, so the worker retry ladder never
  // depends on whether a task happens to declare a fallback.

  const fallbackLessTask: LLMTaskDescriptor = {
    taskId: 'reply_generation',
    primary: { provider: 'openai', model: 'gpt-4o-mini-2024-07-18' },
    maxTokens: 300,
    temperature: 0.7,
  };

  it('no-fallback task: transient primary failure is wrapped in TransientLLMError', async () => {
    getLlmTask.mockReturnValueOnce(fallbackLessTask);
    const transient = Object.assign(new Error('openai 503'), { code: 'ECONNRESET' });
    openaiComplete.mockRejectedValueOnce(transient);

    const { runLlmTask } = await import('../run-task');
    const { TransientLLMError } = await import('../error-classifier');

    try {
      await runLlmTask('reply_generation', prompt);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TransientLLMError);
      expect((err as InstanceType<typeof TransientLLMError>).cause).toBe(transient);
    }
    expect(anthropicComplete).not.toHaveBeenCalled();
  });

  it('no-fallback task: permanent primary failure rethrows raw', async () => {
    getLlmTask.mockReturnValueOnce(fallbackLessTask);
    const permanent = Object.assign(new Error('openai bad request'), {
      name: 'BadRequestError',
    });
    openaiComplete.mockRejectedValueOnce(permanent);

    const { runLlmTask } = await import('../run-task');
    const { TransientLLMError } = await import('../error-classifier');

    try {
      await runLlmTask('reply_generation', prompt);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).not.toBeInstanceOf(TransientLLMError);
      expect(err).toBe(permanent);
    }
    expect(anthropicComplete).not.toHaveBeenCalled();
  });

  describe('structured output', () => {
    const schema = z.strictObject({ severity: z.enum(['low', 'medium', 'high']) });
    const structuredTask: LLMTaskDescriptor = {
      taskId: 'triage',
      primary: { provider: 'openai', model: 'gpt-4o-mini-2024-07-18' },
      fallback: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
      maxTokens: 200,
      temperature: 0,
      outputSchema: schema,
    };

    it('parses and validates a JSON completion onto result.structured', async () => {
      getLlmTask.mockReturnValueOnce(structuredTask);
      openaiComplete.mockResolvedValueOnce(callResult({ text: '{"severity":"high"}' }));

      const { runLlmTask } = await import('../run-task');
      const result = await runLlmTask('triage', prompt);

      expect(result.structured).toEqual({ severity: 'high' });
      expect(result.text).toBe('{"severity":"high"}');
    });

    it('strips markdown code fences before parsing', async () => {
      getLlmTask.mockReturnValueOnce(structuredTask);
      openaiComplete.mockResolvedValueOnce(
        callResult({ text: '```json\n{"severity":"low"}\n```' }),
      );

      const { runLlmTask } = await import('../run-task');
      const result = await runLlmTask('triage', prompt);

      expect(result.structured).toEqual({ severity: 'low' });
    });

    it('falls back to the second provider when the primary output fails validation', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      getLlmTask.mockReturnValueOnce(structuredTask);
      openaiComplete.mockResolvedValueOnce(callResult({ text: 'Sorry, I cannot help.' }));
      anthropicComplete.mockResolvedValueOnce(
        callResult({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', text: '{"severity":"medium"}' }),
      );

      const { runLlmTask } = await import('../run-task');
      const result = await runLlmTask('triage', prompt);

      expect(result.provider).toBe('anthropic');
      expect(result.structured).toEqual({ severity: 'medium' });
    });

    it('throws a terminal LLMStructuredOutputError (not transient) when both providers return invalid output', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      getLlmTask.mockReturnValueOnce(structuredTask);
      openaiComplete.mockResolvedValueOnce(callResult({ text: 'not json' }));
      anthropicComplete.mockResolvedValueOnce(
        callResult({ provider: 'anthropic', text: '{"severity":"catastrophic"}' }),
      );

      const { runLlmTask, LLMStructuredOutputError } = await import('../run-task');
      const { TransientLLMError } = await import('../error-classifier');

      try {
        await runLlmTask('triage', prompt);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(LLMStructuredOutputError);
        expect(err).not.toBeInstanceOf(TransientLLMError);
        // Logging rules: the message never embeds the completion text.
        expect((err as Error).message).not.toContain('catastrophic');
      }
    });

    it('still wraps a transient transport failure as TransientLLMError when the other attempt is schema-invalid', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      getLlmTask.mockReturnValueOnce(structuredTask);
      const transient = Object.assign(new Error('openai 503'), { code: 'ECONNRESET' });
      openaiComplete.mockRejectedValueOnce(transient);
      anthropicComplete.mockResolvedValueOnce(callResult({ provider: 'anthropic', text: 'not json' }));

      const { runLlmTask } = await import('../run-task');
      const { TransientLLMError } = await import('../error-classifier');

      try {
        await runLlmTask('triage', prompt);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(TransientLLMError);
        expect((err as InstanceType<typeof TransientLLMError>).cause).toBe(transient);
      }
    });

    it('never leaks completion text into the error message or cause chain on invalid JSON', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      getLlmTask.mockReturnValueOnce(structuredTask);
      // Node's SyntaxError message embeds a snippet of the parsed input —
      // the seam must replace it with a sanitized cause (logging rules +
      // Sentry linkedErrors walks err.cause into exception values). The
      // marker must be <= 10 chars: V8 truncates the snippet ("SECRETRVW "...)
      // so a longer marker would never appear and the test would prove nothing.
      const marker = 'SECRETRVW';
      openaiComplete.mockResolvedValueOnce(callResult({ text: `${marker} is not json` }));
      anthropicComplete.mockResolvedValueOnce(
        callResult({ provider: 'anthropic', text: `${marker} still not json` }),
      );

      const { runLlmTask, LLMStructuredOutputError } = await import('../run-task');

      try {
        await runLlmTask('triage', prompt);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(LLMStructuredOutputError);
        let link: unknown = err;
        while (link instanceof Error) {
          expect(link.message).not.toContain(marker);
          link = link.cause;
        }
      }
    });

    it('fallback-less structured task: invalid primary output is terminal', async () => {
      getLlmTask.mockReturnValueOnce({ ...structuredTask, fallback: undefined });
      openaiComplete.mockResolvedValueOnce(callResult({ text: 'not json' }));

      const { runLlmTask, LLMStructuredOutputError } = await import('../run-task');
      const { TransientLLMError } = await import('../error-classifier');

      try {
        await runLlmTask('triage', prompt);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(LLMStructuredOutputError);
        expect(err).not.toBeInstanceOf(TransientLLMError);
      }
      expect(anthropicComplete).not.toHaveBeenCalled();
    });

    it('wraps the fallback transport cause when primary is schema-invalid + fallback is transient', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      getLlmTask.mockReturnValueOnce(structuredTask);
      openaiComplete.mockResolvedValueOnce(callResult({ text: 'not json' }));
      const transient = Object.assign(new Error('anthropic timeout'), { code: 'ETIMEDOUT' });
      anthropicComplete.mockRejectedValueOnce(transient);

      const { runLlmTask } = await import('../run-task');
      const { TransientLLMError } = await import('../error-classifier');

      try {
        await runLlmTask('triage', prompt);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(TransientLLMError);
        expect((err as InstanceType<typeof TransientLLMError>).cause).toBe(transient);
      }
    });

    it('does not touch result.structured for schema-less tasks', async () => {
      openaiComplete.mockResolvedValueOnce(callResult({ text: 'plain text reply' }));

      const { runLlmTask } = await import('../run-task');
      const result = await runLlmTask('reply_generation', prompt);

      expect(result.structured).toBeUndefined();
    });
  });

  // ── Circuit breaker failover matrix ───────────────────────────────────
  // The breaker gates each provider attempt. A `blocked` provider (breaker
  // open) is skipped before completeAttempt — the only behavior change vs the
  // pre-breaker seam is that any all-failure outcome touching a blocked
  // provider is now retryable (TransientLLMError). Everything else — return
  // shape, transient/terminal classification over ATTEMPTED errors, the
  // failover log — is byte-identical.
  describe('circuit breaker', () => {
    /** Trip a provider's breaker open via 5 consecutive transient outcomes,
     *  each admitted first (the breaker now records outcomes against the
     *  admission token the attempt was admitted under). */
    function tripOpen(provider: LLMProviderId): void {
      const transient = Object.assign(new Error('provider outage'), { code: 'ECONNRESET' });
      for (let i = 0; i < 5; i++) {
        const admission = llmCircuitBreaker.shouldAttempt(provider);
        if (admission !== null) llmCircuitBreaker.recordAttempt(admission, transient);
      }
    }

    function transientError(message: string): Error {
      return Object.assign(new Error(message), { code: 'ETIMEDOUT' });
    }

    function permanentError(message: string): Error {
      return Object.assign(new Error(message), { name: 'BadRequestError' });
    }

    afterEach(() => {
      // Some cases flip the kill switch via env; restore the default-ON state
      // and re-read the flag so later tests see an enabled, empty breaker.
      delete process.env.LLM_CIRCUIT_BREAKER_ENABLED;
      llmCircuitBreaker.reset();
    });

    // Row 1: primary blocked + fallback transient → TransientLLMError.
    it('primary blocked + fallback transient → TransientLLMError', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      tripOpen('openai');
      anthropicComplete.mockRejectedValueOnce(transientError('anthropic timeout'));

      const { runLlmTask } = await import('../run-task');
      const { TransientLLMError } = await import('../error-classifier');

      await expect(runLlmTask('reply_generation', prompt)).rejects.toBeInstanceOf(TransientLLMError);
      expect(openaiComplete).not.toHaveBeenCalled();
      expect(anthropicComplete).toHaveBeenCalledOnce();
    });

    // ST-2 (step-7 standards): a blocked provider must NOT erase a real
    // transient cause. When the fallback actually fails transiently, the
    // retryable TransientLLMError must wrap THAT error (for the failover log),
    // not the synthetic LlmCircuitOpenError marker.
    it('primary blocked + fallback transient → wraps the REAL fallback cause, not LlmCircuitOpenError', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      tripOpen('openai');
      const fallbackTransient = transientError('anthropic timeout');
      anthropicComplete.mockRejectedValueOnce(fallbackTransient);

      const { runLlmTask } = await import('../run-task');
      const { TransientLLMError } = await import('../error-classifier');

      try {
        await runLlmTask('reply_generation', prompt);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(TransientLLMError);
        expect((err as InstanceType<typeof TransientLLMError>).cause).toBe(fallbackTransient);
      }
    });

    // ST-2 boundary: with NO real transient cause to preserve (both providers
    // blocked), the synthetic LlmCircuitOpenError marker is the cause — still
    // retryable, just contextless because there is no attempted error to carry.
    it('both providers blocked → cause is the LlmCircuitOpenError marker', async () => {
      tripOpen('openai');
      tripOpen('anthropic');

      const { runLlmTask } = await import('../run-task');
      const { TransientLLMError } = await import('../error-classifier');

      try {
        await runLlmTask('reply_generation', prompt);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(TransientLLMError);
        const cause = (err as InstanceType<typeof TransientLLMError>).cause;
        expect((cause as Error).name).toBe('LlmCircuitOpenError');
      }
    });

    // Row 2: primary blocked + fallback permanent → TransientLLMError (sawBlocked ⟹ retry).
    it('primary blocked + fallback permanent → TransientLLMError (sawBlocked wins)', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      tripOpen('openai');
      anthropicComplete.mockRejectedValueOnce(permanentError('anthropic bad request'));

      const { runLlmTask } = await import('../run-task');
      const { TransientLLMError } = await import('../error-classifier');

      await expect(runLlmTask('reply_generation', prompt)).rejects.toBeInstanceOf(TransientLLMError);
      expect(openaiComplete).not.toHaveBeenCalled();
    });

    // Row 3: primary blocked + fallback blocked → TransientLLMError, NEITHER provider called.
    it('primary blocked + fallback blocked → TransientLLMError and no provider is called', async () => {
      tripOpen('openai');
      tripOpen('anthropic');

      const { runLlmTask } = await import('../run-task');
      const { TransientLLMError } = await import('../error-classifier');

      await expect(runLlmTask('reply_generation', prompt)).rejects.toBeInstanceOf(TransientLLMError);
      expect(openaiComplete).not.toHaveBeenCalled();
      expect(anthropicComplete).not.toHaveBeenCalled();
    });

    // Row 4: primary transient + fallback blocked → TransientLLMError.
    it('primary transient + fallback blocked → TransientLLMError', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      tripOpen('anthropic');
      openaiComplete.mockRejectedValueOnce(transientError('openai timeout'));

      const { runLlmTask } = await import('../run-task');
      const { TransientLLMError } = await import('../error-classifier');

      await expect(runLlmTask('reply_generation', prompt)).rejects.toBeInstanceOf(TransientLLMError);
      expect(openaiComplete).toHaveBeenCalledOnce();
      expect(anthropicComplete).not.toHaveBeenCalled();
    });

    // Row 5: primary permanent + fallback blocked → TransientLLMError (sawBlocked ⟹ retry).
    it('primary permanent + fallback blocked → TransientLLMError (sawBlocked wins)', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      tripOpen('anthropic');
      openaiComplete.mockRejectedValueOnce(permanentError('openai bad request'));

      const { runLlmTask } = await import('../run-task');
      const { TransientLLMError } = await import('../error-classifier');

      await expect(runLlmTask('reply_generation', prompt)).rejects.toBeInstanceOf(TransientLLMError);
      expect(openaiComplete).toHaveBeenCalledOnce();
      expect(anthropicComplete).not.toHaveBeenCalled();
    });

    // Row 6: primary transient + fallback permanent → TransientLLMError (today's behavior).
    it('primary transient + fallback permanent → TransientLLMError (unchanged)', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const primaryTransient = transientError('openai timeout');
      openaiComplete.mockRejectedValueOnce(primaryTransient);
      anthropicComplete.mockRejectedValueOnce(permanentError('anthropic bad request'));

      const { runLlmTask } = await import('../run-task');
      const { TransientLLMError } = await import('../error-classifier');

      try {
        await runLlmTask('reply_generation', prompt);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(TransientLLMError);
        expect((err as InstanceType<typeof TransientLLMError>).cause).toBe(primaryTransient);
      }
    });

    // Row 7: primary permanent + fallback permanent (no blocks) → rethrow permanent (terminal).
    it('primary permanent + fallback permanent → rethrows the permanent error (terminal)', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const fallbackPermanent = permanentError('anthropic bad request');
      openaiComplete.mockRejectedValueOnce(permanentError('openai bad request'));
      anthropicComplete.mockRejectedValueOnce(fallbackPermanent);

      const { runLlmTask } = await import('../run-task');
      const { TransientLLMError } = await import('../error-classifier');

      try {
        await runLlmTask('reply_generation', prompt);
        throw new Error('expected throw');
      } catch (err) {
        expect(err).not.toBeInstanceOf(TransientLLMError);
        expect(err).toBe(fallbackPermanent);
      }
    });

    // Row 8: no-fallback task + primary blocked → TransientLLMError.
    it('no-fallback task + primary blocked → TransientLLMError', async () => {
      const fallbackLessTask: LLMTaskDescriptor = {
        taskId: 'reply_generation',
        primary: { provider: 'openai', model: 'gpt-4o-mini-2024-07-18' },
        maxTokens: 300,
        temperature: 0.7,
      };
      getLlmTask.mockReturnValueOnce(fallbackLessTask);
      tripOpen('openai');

      const { runLlmTask } = await import('../run-task');
      const { TransientLLMError } = await import('../error-classifier');

      await expect(runLlmTask('reply_generation', prompt)).rejects.toBeInstanceOf(TransientLLMError);
      expect(openaiComplete).not.toHaveBeenCalled();
      expect(anthropicComplete).not.toHaveBeenCalled();
    });

    // Trip test: 5 consecutive transient primary failures open the breaker; the
    // 6th call skips the primary and uses the fallback. Exactly one Sentry
    // warning fires on the closed→open transition.
    it('trips after 5 transient primary failures; 6th call skips primary, one alert fires', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      openaiComplete.mockRejectedValue(transientError('openai timeout'));
      anthropicComplete.mockResolvedValue(
        callResult({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', text: 'Merci' }),
      );

      const { runLlmTask } = await import('../run-task');

      for (let i = 0; i < 5; i++) {
        const result = await runLlmTask('reply_generation', prompt);
        expect(result.provider).toBe('anthropic'); // primary transient → fallback
      }
      expect(openaiComplete).toHaveBeenCalledTimes(5);

      const sixth = await runLlmTask('reply_generation', prompt);
      expect(sixth.provider).toBe('anthropic');
      expect(openaiComplete).toHaveBeenCalledTimes(5); // primary skipped on the 6th

      const openTransitions = captureMessage.mock.calls.filter(
        (call) => (call[1] as { level?: string })?.level === 'warning',
      );
      expect(openTransitions).toHaveLength(1);
    });

    // Kill switch: flag off ⇒ breaker never blocks; failover is byte-identical
    // to the pre-breaker seam even across what would be 6 tripping failures.
    it('LLM_CIRCUIT_BREAKER_ENABLED=false: primary is attempted every time, breaker never blocks', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      process.env.LLM_CIRCUIT_BREAKER_ENABLED = 'false';
      llmCircuitBreaker.reset();

      openaiComplete.mockRejectedValue(transientError('openai timeout'));
      anthropicComplete.mockResolvedValue(
        callResult({ provider: 'anthropic', model: 'claude-haiku-4-5-20251001', text: 'Merci' }),
      );

      const { runLlmTask } = await import('../run-task');

      for (let i = 0; i < 6; i++) {
        const result = await runLlmTask('reply_generation', prompt);
        expect(result.provider).toBe('anthropic');
      }
      expect(openaiComplete).toHaveBeenCalledTimes(6); // never skipped
    });
  });
});
