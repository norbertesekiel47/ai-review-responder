import { describe, it, expect, vi } from 'vitest';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { TransientLLMError, redactProviderError } from '../llm-error-classifier';

// Import the SUT dynamically so the safeInstanceOf regression test can
// re-import it with a substituted openai mock.
async function loadClassifier() {
  const mod = await import('../llm-error-classifier');
  return mod.isTransientLLMError;
}

describe('isTransientLLMError', () => {
  // ── OpenAI specific error classes ──────────────────────────────────

  it('returns true for OpenAI APIConnectionError', async () => {
    const isTransientLLMError = await loadClassifier();
    const err = new OpenAI.APIConnectionError({ cause: new Error('conn') });
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for OpenAI APIConnectionTimeoutError', async () => {
    const isTransientLLMError = await loadClassifier();
    // @ts-expect-error SDK types don't expose cause in constructor at this TS level
    const err = new OpenAI.APIConnectionTimeoutError({ cause: new Error('timeout') });
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for OpenAI RateLimitError', async () => {
    const isTransientLLMError = await loadClassifier();
    // @ts-expect-error Headers param required by TS but undefined works at runtime
    const err = new OpenAI.RateLimitError(429, undefined, 'rate limited', undefined);
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for OpenAI InternalServerError', async () => {
    const isTransientLLMError = await loadClassifier();
    // @ts-expect-error Headers param required by TS but undefined works at runtime
    const err = new OpenAI.InternalServerError(500, undefined, 'internal', undefined);
    expect(isTransientLLMError(err)).toBe(true);
  });

  // ── Anthropic specific error classes ───────────────────────────────

  it('returns true for Anthropic APIConnectionError', async () => {
    const isTransientLLMError = await loadClassifier();
    const err = new Anthropic.APIConnectionError({ cause: new Error('conn') });
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for Anthropic APIConnectionTimeoutError', async () => {
    const isTransientLLMError = await loadClassifier();
    // @ts-expect-error SDK types don't expose cause in constructor at this TS level
    const err = new Anthropic.APIConnectionTimeoutError({ cause: new Error('timeout') });
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for Anthropic RateLimitError', async () => {
    const isTransientLLMError = await loadClassifier();
    // @ts-expect-error Headers param required by TS but undefined works at runtime
    const err = new Anthropic.RateLimitError(429, 'rate limited', undefined, undefined);
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for Anthropic InternalServerError', async () => {
    const isTransientLLMError = await loadClassifier();
    // @ts-expect-error Headers param required by TS but undefined works at runtime
    const err = new Anthropic.InternalServerError(500, 'internal', undefined, undefined);
    expect(isTransientLLMError(err)).toBe(true);
  });

  // ── Generic OpenAI.APIError by status code (transient) ─────────────

  it('returns true for generic OpenAI.APIError status 500', async () => {
    const isTransientLLMError = await loadClassifier();
    const err = new OpenAI.APIError(500, undefined, 'internal', undefined);
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for generic OpenAI.APIError status 502', async () => {
    const isTransientLLMError = await loadClassifier();
    const err = new OpenAI.APIError(502, undefined, 'bad gateway', undefined);
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for generic OpenAI.APIError status 503', async () => {
    const isTransientLLMError = await loadClassifier();
    const err = new OpenAI.APIError(503, undefined, 'unavailable', undefined);
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for generic OpenAI.APIError status 429', async () => {
    const isTransientLLMError = await loadClassifier();
    const err = new OpenAI.APIError(429, undefined, 'rate limited', undefined);
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for generic OpenAI.APIError status 408', async () => {
    const isTransientLLMError = await loadClassifier();
    const err = new OpenAI.APIError(408, undefined, 'timeout', undefined);
    expect(isTransientLLMError(err)).toBe(true);
  });

  // ── Generic OpenAI.APIError by status code (non-transient) ─────────

  it('returns false for generic OpenAI.APIError status 400', async () => {
    const isTransientLLMError = await loadClassifier();
    const err = new OpenAI.APIError(400, undefined, 'bad request', undefined);
    expect(isTransientLLMError(err)).toBe(false);
  });

  it('returns false for generic OpenAI.APIError status 401', async () => {
    const isTransientLLMError = await loadClassifier();
    const err = new OpenAI.APIError(401, undefined, 'unauthorized', undefined);
    expect(isTransientLLMError(err)).toBe(false);
  });

  it('returns false for generic OpenAI.APIError status 403', async () => {
    const isTransientLLMError = await loadClassifier();
    const err = new OpenAI.APIError(403, undefined, 'forbidden', undefined);
    expect(isTransientLLMError(err)).toBe(false);
  });

  it('returns false for generic OpenAI.APIError status 404', async () => {
    const isTransientLLMError = await loadClassifier();
    const err = new OpenAI.APIError(404, undefined, 'not found', undefined);
    expect(isTransientLLMError(err)).toBe(false);
  });

  it('returns false for generic OpenAI.APIError status 422', async () => {
    const isTransientLLMError = await loadClassifier();
    const err = new OpenAI.APIError(422, undefined, 'unprocessable', undefined);
    expect(isTransientLLMError(err)).toBe(false);
  });

  // ── Plain Error with transient codes / names ───────────────────────

  it('returns true for plain Error with code ETIMEDOUT', async () => {
    const isTransientLLMError = await loadClassifier();
    const err = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for plain Error with code ECONNRESET', async () => {
    const isTransientLLMError = await loadClassifier();
    const err = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for plain Error with code ECONNREFUSED', async () => {
    const isTransientLLMError = await loadClassifier();
    const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for plain Error with code EAI_AGAIN', async () => {
    const isTransientLLMError = await loadClassifier();
    const err = Object.assign(new Error('dns'), { code: 'EAI_AGAIN' });
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for plain Error with name AbortError', async () => {
    const isTransientLLMError = await loadClassifier();
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isTransientLLMError(err)).toBe(true);
  });

  it('returns true for plain Error with name TimeoutError', async () => {
    const isTransientLLMError = await loadClassifier();
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    expect(isTransientLLMError(err)).toBe(true);
  });

  // ── Non-transient / non-Error inputs ───────────────────────────────

  it('returns false for arbitrary Error', async () => {
    const isTransientLLMError = await loadClassifier();
    expect(isTransientLLMError(new Error('boom'))).toBe(false);
  });

  it('returns false for null', async () => {
    const isTransientLLMError = await loadClassifier();
    expect(isTransientLLMError(null)).toBe(false);
  });

  it('returns false for undefined', async () => {
    const isTransientLLMError = await loadClassifier();
    expect(isTransientLLMError(undefined)).toBe(false);
  });

  it('returns false for string', async () => {
    const isTransientLLMError = await loadClassifier();
    expect(isTransientLLMError('error')).toBe(false);
  });

  it('returns false for plain object', async () => {
    const isTransientLLMError = await loadClassifier();
    expect(isTransientLLMError({ status: 500 })).toBe(false);
  });

  // ── safeInstanceOf regression ──────────────────────────────────────
  //
  // These two tests substitute one SDK module each, then re-import the
  // classifier so safeInstanceOf is exercised against the stubbed shape.
  // After each, vi.resetModules() runs again so subsequent dynamic imports
  // see the real SDKs — preventing mock bleed if more tests are added below.

  it('safeInstanceOf regression: does not throw when OpenAI error subclasses are missing', async () => {
    vi.doMock('openai', () => ({ default: class MockOpenAI {} }));
    vi.resetModules();

    const { isTransientLLMError } = await import('../llm-error-classifier');
    expect(isTransientLLMError(new Error('boom'))).toBe(false);

    vi.doUnmock('openai');
    vi.resetModules();
  });

  it('safeInstanceOf regression: does not throw when Anthropic error subclasses are missing', async () => {
    vi.doMock('@anthropic-ai/sdk', () => ({ default: class MockAnthropic {} }));
    vi.resetModules();

    const { isTransientLLMError } = await import('../llm-error-classifier');
    expect(isTransientLLMError(new Error('boom'))).toBe(false);

    vi.doUnmock('@anthropic-ai/sdk');
    vi.resetModules();
  });
});

describe('TransientLLMError', () => {
  it('preserves cause and message from Error cause', () => {
    const cause = new Error('underlying failure');
    const err = new TransientLLMError(cause);
    expect(err.message).toBe('underlying failure');
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('TransientLLMError');
  });

  it('handles non-Error cause (string)', () => {
    const err = new TransientLLMError('network hiccup');
    expect(err.message).toBe('network hiccup');
    expect(err.cause).toBe('network hiccup');
    expect(err.name).toBe('TransientLLMError');
  });

  it('handles null cause with descriptive message', () => {
    const err = new TransientLLMError(null);
    expect(err.message).toBe('Unknown LLM Error');
    expect(err.cause).toBe(null);
  });

  it('handles undefined cause with descriptive message', () => {
    const err = new TransientLLMError(undefined);
    expect(err.message).toBe('Unknown LLM Error');
    expect(err.cause).toBe(undefined);
  });
});

describe('redactProviderError', () => {
  it('extracts name, message, status, code, type from a provider Error', () => {
    const err = Object.assign(new Error('rate limit exceeded'), {
      name: 'RateLimitError',
      status: 429,
      code: 'rate_limit_exceeded',
      type: 'rate_limit',
    });
    expect(redactProviderError(err)).toEqual({
      name: 'RateLimitError',
      message: 'rate limit exceeded',
      status: 429,
      code: 'rate_limit_exceeded',
      type: 'rate_limit',
    });
  });

  it('omits status/code/type when absent', () => {
    expect(redactProviderError(new Error('something broke'))).toEqual({
      name: 'Error',
      message: 'something broke',
    });
  });

  it('does NOT include .body, .response, .request, or .headers', () => {
    const err = Object.assign(new Error('bad request'), {
      status: 400,
      body: { prompt: 'review with PII like john@example.com' },
      response: { headers: { authorization: 'Bearer secret' } },
      request: { body: 'echoed prompt' },
      headers: { 'x-request-id': 'abc' },
    });
    const out = redactProviderError(err);
    expect(out).not.toHaveProperty('body');
    expect(out).not.toHaveProperty('response');
    expect(out).not.toHaveProperty('request');
    expect(out).not.toHaveProperty('headers');
  });

  it('truncates long messages to 500 chars', () => {
    const out = redactProviderError(new Error('x'.repeat(2000)));
    expect(out.message.length).toBe(500);
  });

  it('handles non-Error inputs (null/undefined/string/object)', () => {
    expect(redactProviderError(null)).toEqual({ name: 'NonError', message: 'null' });
    expect(redactProviderError(undefined)).toEqual({ name: 'NonError', message: 'undefined' });
    expect(redactProviderError('boom')).toEqual({ name: 'NonError', message: 'boom' });
    expect(redactProviderError({ foo: 'bar' })).toEqual({ name: 'NonError', message: '[object Object]' });
  });

  it('truncates non-Error stringification too', () => {
    const out = redactProviderError('y'.repeat(2000));
    expect(out.message.length).toBe(500);
  });

  it('ignores non-string code and non-number status', () => {
    const err = Object.assign(new Error('odd shape'), { status: '500', code: 42 });
    const out = redactProviderError(err);
    expect(out).not.toHaveProperty('status');
    expect(out).not.toHaveProperty('code');
  });
});
