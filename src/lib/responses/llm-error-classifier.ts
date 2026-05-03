import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Wraps a transient LLM provider error so callers can rethrow for retry
 * instead of marking the outbox failed. Permanent errors (auth, bad
 * request, guardrail) surface as ordinary Errors.
 */
export class TransientLLMError extends Error {
  constructor(public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'TransientLLMError';
  }
}

// `instanceof` against a class that might be undefined (e.g. when the SDK is
// mocked without its error subclasses) throws TypeError. Guard each check so
// a minimal mock can't crash classification.
function safeInstanceOf(err: unknown, ctor: unknown): boolean {
  return typeof ctor === 'function' && err instanceof (ctor as new (...args: unknown[]) => unknown);
}

export function isTransientLLMError(err: unknown): boolean {
  if (safeInstanceOf(err, OpenAI.APIConnectionError)) return true;
  if (safeInstanceOf(err, OpenAI.APIConnectionTimeoutError)) return true;
  if (safeInstanceOf(err, OpenAI.RateLimitError)) return true;
  if (safeInstanceOf(err, OpenAI.InternalServerError)) return true;
  if (safeInstanceOf(err, Anthropic.APIConnectionError)) return true;
  if (safeInstanceOf(err, Anthropic.APIConnectionTimeoutError)) return true;
  if (safeInstanceOf(err, Anthropic.RateLimitError)) return true;
  if (safeInstanceOf(err, Anthropic.InternalServerError)) return true;
  // Generic API errors: retry on 5xx and 429
  if (safeInstanceOf(err, OpenAI.APIError) || safeInstanceOf(err, Anthropic.APIError)) {
    const status = (err as { status?: number }).status;
    if (typeof status === 'number' && (status >= 500 || status === 429 || status === 408)) return true;
  }
  // Node fetch / undici timeouts + ECONNRESET surface as plain Errors
  if (err instanceof Error) {
    const code = (err as { code?: string }).code;
    if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN') return true;
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  }
  return false;
}
