import { getLlmTask } from './tasks';
import { openaiProvider } from './openai-provider';
import { anthropicProvider } from './anthropic-provider';
import { isTransientLLMError, TransientLLMError, redactProviderError } from './error-classifier';
import { llmCircuitBreaker } from './circuit-breaker';
import { createWorkerLogger } from '@/lib/shared/logger';
import type { z } from 'zod';
import type {
  ChatPrompt,
  LLMCallResult,
  LLMProvider,
  LLMProviderId,
  LLMRequest,
  LLMTaskDescriptor,
  LLMTaskId,
} from './types';

const PROVIDERS: Record<LLMProviderId, LLMProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
};

/**
 * Terminal: the completion did not satisfy the task's outputSchema.
 * Deliberately NOT transient — at temperature 0 the same provider returns the
 * same shape, so the FALLBACK provider is the retry; when every attempt fails
 * validation, retrying the job would spend without converging. The message
 * carries no completion text (logging rules); the cause has detail for local
 * debugging and passes through redactProviderError in the failover log.
 */
export class LLMStructuredOutputError extends Error {
  constructor(taskId: LLMTaskId, provider: LLMProviderId, cause: unknown) {
    super(`llm: structured output invalid for task ${taskId} from ${provider}`, { cause });
    this.name = 'LLMStructuredOutputError';
  }
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? fenced[1]! : trimmed;
}

function validateStructured(
  taskId: LLMTaskId,
  schema: z.ZodTypeAny,
  result: LLMCallResult,
): LLMCallResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(result.text));
  } catch (err) {
    // Never carry the raw SyntaxError: its message embeds a snippet of the
    // completion text ("Unexpected token 'S', \"Sorry, I c\"...") and Sentry's
    // linkedErrors integration walks error.cause into exception values that
    // the scrubber doesn't touch.
    throw new LLMStructuredOutputError(
      taskId,
      result.provider,
      new Error(`JSON.parse failed: ${err instanceof Error ? err.name : 'unknown'}`),
    );
  }
  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new LLMStructuredOutputError(taskId, result.provider, validated.error);
  }
  return { ...result, structured: validated.data };
}

async function completeAttempt(
  provider: LLMProvider,
  request: LLMRequest,
  task: LLMTaskDescriptor,
): Promise<LLMCallResult> {
  const result = await provider.complete(request);
  return task.outputSchema
    ? validateStructured(task.taskId, task.outputSchema, result)
    : result;
}

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
 * Marker cause for a failure that ended with at least one breaker-blocked
 * provider (never attempted). Carries no provider/completion text — it exists
 * only so the retryable TransientLLMError has a meaningful `cause` for logs.
 * A blocked provider may recover on a later retry, so the outcome is retryable.
 */
class LlmCircuitOpenError extends Error {
  constructor() {
    super('llm: circuit breaker open — provider attempt skipped');
    this.name = 'LlmCircuitOpenError';
  }
}

/**
 * One provider attempt, gated by the LLM provider circuit breaker.
 * - `blocked`: the breaker refused the attempt — no provider call, no error,
 *   NOT an entry in attemptErrors (it must never be mistaken for a transient
 *   attempt error by throwExhaustedAttempts).
 * - `ok` / `error`: the provider was called; the breaker records the outcome
 *   and internally discriminates transient vs non-transient (do not pre-filter
 *   here).
 */
type Attempt =
  | { kind: 'ok'; result: LLMCallResult }
  | { kind: 'blocked' }
  | { kind: 'error'; error: unknown };

async function attemptProvider(
  provider: LLMProviderId,
  request: LLMRequest,
  task: LLMTaskDescriptor,
): Promise<Attempt> {
  const admission = llmCircuitBreaker.shouldAttempt(provider);
  if (admission === null) return { kind: 'blocked' };
  try {
    const result = await completeAttempt(PROVIDERS[provider], request, task);
    llmCircuitBreaker.recordAttempt(admission);
    return { kind: 'ok', result };
  } catch (error) {
    llmCircuitBreaker.recordAttempt(admission, error);
    return { kind: 'error', error };
  }
}

/**
 * Execute a registered LLM task: primary provider, then fallback, with the
 * transient/terminal classification the worker retry ladder depends on
 * (relocated verbatim from generator.ts callLLMWithFallback — A+ PR 1c).
 * COST-GUARD CONTRACT: production callers wrap this in withCostGuard — see
 * types.ts header.
 *
 * USAGE ACCOUNTING (structured tasks): a validation-failed attempt's token
 * spend is NOT accumulated into the returned usage — finalizeCost under-reports
 * on failover, and on all-invalid terminal the reservation is released.
 * Bounded by the pessimistic reserve + small structured-task maxTokens;
 * revisit if margin data shows it matters.
 */
export async function runLlmTask(taskId: LLMTaskId, prompt: ChatPrompt): Promise<LLMCallResult> {
  const task = getLlmTask(taskId);
  const request = { ...prompt, maxTokens: task.maxTokens, temperature: task.temperature };

  // Only real thrown attempt errors enter this array — a `blocked` result never
  // does (see Attempt). `sawBlocked` makes any all-failure outcome retryable.
  const attemptErrors: unknown[] = [];
  let sawBlocked = false;

  const primary = await attemptProvider(
    task.primary.provider,
    { ...request, model: task.primary.model },
    task,
  );
  if (primary.kind === 'ok') return primary.result;
  if (primary.kind === 'error') attemptErrors.push(primary.error);
  else sawBlocked = true;

  if (!task.fallback) {
    if (sawBlocked) throw new TransientLLMError(new LlmCircuitOpenError());
    throwExhaustedAttempts(attemptErrors);
  }

  // Preserve the existing failover log line only when the primary was actually
  // attempted and threw — a `blocked` primary has no error to redact.
  if (primary.kind === 'error') {
    createWorkerLogger(`[llm:${taskId}]`).error(
      `${task.primary.provider} call failed, falling back to ${task.fallback.provider}`,
      { error: redactProviderError(primary.error) },
    );
  }

  const fallback = await attemptProvider(
    task.fallback.provider,
    { ...request, model: task.fallback.model },
    task,
  );
  if (fallback.kind === 'ok') return fallback.result;
  if (fallback.kind === 'error') attemptErrors.push(fallback.error);
  else sawBlocked = true;

  // Blocked ⟹ retryable: a skipped provider may succeed on a later retry.
  // Otherwise fall back to the unchanged transient/terminal classification over
  // the attempted errors.
  if (sawBlocked) throw new TransientLLMError(new LlmCircuitOpenError());
  throwExhaustedAttempts(attemptErrors);
}
