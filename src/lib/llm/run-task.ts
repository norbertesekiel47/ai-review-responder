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
 * Execute a registered LLM task: primary provider, then fallback, with the
 * transient/terminal classification the worker retry ladder depends on
 * (relocated verbatim from generator.ts callLLMWithFallback — A+ PR 1c).
 * COST-GUARD CONTRACT: production callers wrap this in withCostGuard — see
 * types.ts header.
 */
export async function runLlmTask(taskId: LLMTaskId, prompt: ChatPrompt): Promise<LLMCallResult> {
  const task = getLlmTask(taskId);
  const request = { ...prompt, maxTokens: task.maxTokens, temperature: task.temperature };
  try {
    return await PROVIDERS[task.primary.provider].complete({ ...request, model: task.primary.model });
  } catch (primaryError) {
    if (!task.fallback) throw primaryError;
    console.error(
      `[llm:${taskId}] ${task.primary.provider} call failed, falling back to ${task.fallback.provider}:`,
      redactProviderError(primaryError),
    );
    try {
      return await PROVIDERS[task.fallback.provider].complete({ ...request, model: task.fallback.model });
    } catch (fallbackError) {
      // Wrap the actually-transient cause — wrapping the wrong one would let
      // the worker retry forever against a permanent failure (e.g. a 401
      // after a 503). Verbatim from generator.ts.
      const primaryTransient = isTransientLLMError(primaryError);
      const fallbackTransient = isTransientLLMError(fallbackError);
      if (primaryTransient || fallbackTransient) {
        throw new TransientLLMError(fallbackTransient ? fallbackError : primaryError);
      }
      throw fallbackError;
    }
  }
}
