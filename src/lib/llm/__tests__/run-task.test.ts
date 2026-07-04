import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { ChatPrompt, LLMCallResult, LLMTaskDescriptor } from '../types';

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
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('falling back to anthropic'),
      expect.anything(),
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

    await expect(runLlmTask('triage', prompt)).rejects.toThrow(
      'LLM task not registered: triage',
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

  it('throws loudly for a descriptor declaring outputSchema (not yet implemented)', async () => {
    getLlmTask.mockReturnValueOnce({
      ...fallbackLessTask,
      outputSchema: z.object({}),
    });

    const { runLlmTask } = await import('../run-task');

    await expect(runLlmTask('reply_generation', prompt)).rejects.toThrow(
      'structured output not yet implemented: reply_generation',
    );
    expect(openaiComplete).not.toHaveBeenCalled();
    expect(anthropicComplete).not.toHaveBeenCalled();
  });
});
