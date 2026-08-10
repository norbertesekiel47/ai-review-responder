import { describe, expect, it, vi } from 'vitest';
import { apiErrorMessage, readJsonObject } from '@/lib/client-response';

describe('client response helpers', () => {
  it('reads JSON objects from JSON responses', async () => {
    const response = new Response(JSON.stringify({ detail: 'Try again later' }), {
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(readJsonObject(response)).resolves.toEqual({ detail: 'Try again later' });
  });

  it('does not attempt to parse an HTML error page as JSON', async () => {
    const json = vi.fn();
    const response = {
      headers: new Headers({ 'Content-Type': 'text/html; charset=utf-8' }),
      json,
    } as unknown as Response;

    await expect(readJsonObject(response)).resolves.toEqual({});
    expect(json).not.toHaveBeenCalled();
  });

  it('returns an empty object for malformed JSON', async () => {
    const response = {
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: () => Promise.reject(new SyntaxError('Unexpected token')),
    } as unknown as Response;

    await expect(readJsonObject(response)).resolves.toEqual({});
  });

  it('prefers server detail and falls back to a status-bearing recovery message', () => {
    expect(apiErrorMessage({ detail: 'Password is incorrect' }, 'Unable to verify password', 401))
      .toBe('Password is incorrect');
    expect(apiErrorMessage({}, 'Unable to verify password', 502))
      .toBe('Unable to verify password (502)');
  });
});
