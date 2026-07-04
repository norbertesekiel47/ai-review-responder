import { getLlmTask } from './tasks';
import { openaiProvider } from './openai-provider';
import { anthropicProvider } from './anthropic-provider';
import { isTransientLLMError, TransientLLMError, redactProviderError } from './error-classifier';
import type { ChatPrompt, LLMCallResult, LLMProvider, LLMProviderId, LLMTaskId } from './types';

const PROVIDERS: Record<LLMProviderId, LLMProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
};

/**
 * Every provider attempt failed — decide what the worker retry ladder sees.
 * If any failure is transient (network, 5xx, rate-limit, timeout), surface
 * the MOST RECENT transient cause as TransientLLMError so the worker rethrows
 * for BullMQ/outbox retry. Wrapping a non-transient cause instead would let
 * the worker retry forever against a permanent failure (e.g. a 401 after a
 * 503) — classification logic verbatim from generator.ts callLLMWithFallback,
 * generalized to any attempt count so fallback-less tasks keep
 * transient-uniform semantics. When nothing is transient, the last failure
 * is rethrown raw.
 */
function throwExhaustedAttempts(attemptErrors: readonly unknown[]): never {
  const transientCause = [...attemptErrors].reverse().find(isTransientLLMError);
  if (transientCause !== undefined) throw new TransientLLMError(transientCause);
  throw attemptErrors[attemptErrors.length - 1];
}

/**
 * Execute a registered LLM task: primary provider, then fallback, with the
 * transient/terminal classification the worker retry ladder depends on
 * (relocated verbatim from generator.ts callLLMWithFallback — A+ PR 1c).
 * COST-GUARD CONTRACT: production callers wrap this in withCostGuard — see
 * types.ts header.
 */
export async function runLlmTask(taskId: LLMTaskId, prompt: ChatPrompt): Promise<LLMCallResult> {
  const task = getLlmTask(taskId);
  // Honesty guard: outputSchema is declared-but-unenforced until the first
  // structured task (triage) lands. Fail loudly rather than silently return
  // unvalidated text a caller believes is schema-checked.
  if (task.outputSchema) throw new Error(`structured output not yet implemented: ${taskId}`);
  const request = { ...prompt, maxTokens: task.maxTokens, temperature: task.temperature };
  try {
    return await PROVIDERS[task.primary.provider].complete({ ...request, model: task.primary.model });
  } catch (primaryError) {
    if (!task.fallback) throwExhaustedAttempts([primaryError]);
    console.error(
      `[llm:${taskId}] ${task.primary.provider} call failed, falling back to ${task.fallback.provider}:`,
      redactProviderError(primaryError),
    );
    try {
      return await PROVIDERS[task.fallback.provider].complete({ ...request, model: task.fallback.model });
    } catch (fallbackError) {
      throwExhaustedAttempts([primaryError, fallbackError]);
    }
  }
}
