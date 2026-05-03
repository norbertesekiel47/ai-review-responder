import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

/**
 * Wraps a transient LLM provider error so callers can rethrow for retry
 * instead of marking the outbox failed. Permanent errors (auth, bad
 * request, guardrail) surface as ordinary Errors.
 */
export class TransientLLMError extends Error {
  constructor(public readonly cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : String(cause ?? 'Unknown LLM Error'),
    );
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
  // NOTE: "OpenAI returned empty response" / "Anthropic returned empty response"
  // Errors thrown by callOpenAI/callAnthropic are intentionally NOT classified
  // as transient. Empty responses almost always mean content-moderation refusal
  // or max_tokens hit before any output — both deterministic for the same prompt.
  // Retrying would loop forever; better to fail terminally so the issue surfaces.
  return false;
}

// ── Provider-error redaction for logging ────────────────────────────

const REDACTED_MESSAGE_MAX_CHARS = 500;

export interface RedactedProviderError {
  name: string;
  message: string;
  status?: number;
  code?: string;
  type?: string;
}

/**
 * Strip provider-error fields likely to echo the request body (`.body`,
 * `.response`, `.request`, `.headers`) before logging. Some 4xx provider
 * errors include the prompt in the response body, which means logging the
 * raw error can leak review text / PII to worker logs.
 *
 * Returns a structured summary safe for `console.error`. Message truncated
 * to {@link REDACTED_MESSAGE_MAX_CHARS} chars as defence-in-depth — provider
 * messages are usually short ("rate limit exceeded", "invalid api key") but
 * truncation prevents a misbehaving provider from blowing this up.
 */
export function redactProviderError(err: unknown): RedactedProviderError {
  if (!(err instanceof Error)) {
    return { name: 'NonError', message: String(err).slice(0, REDACTED_MESSAGE_MAX_CHARS) };
  }
  const e = err as Error & { status?: number; code?: string; type?: string };
  const out: RedactedProviderError = {
    name: e.name,
    message: e.message.slice(0, REDACTED_MESSAGE_MAX_CHARS),
  };
  if (typeof e.status === 'number') out.status = e.status;
  if (typeof e.code === 'string') out.code = e.code;
  if (typeof e.type === 'string') out.type = e.type;
  return out;
}
