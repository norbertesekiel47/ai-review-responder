import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { invalidBodyResponse } from '../invalid-body-response';

function zodError(): z.ZodError {
  const result = z.object({ accountId: z.string().min(1) }).safeParse({ accountId: '' });
  if (result.success) throw new Error('fixture schema unexpectedly parsed');
  return result.error;
}

describe('invalidBodyResponse', () => {
  it('is a 400 with the stable invalid_body shape', async () => {
    const response = invalidBodyResponse(zodError());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_body' });
  });

  it('never leaks the Zod issues array or field paths into the body', async () => {
    const response = invalidBodyResponse(zodError());
    const body = (await response.json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty('issues');
    expect(body).not.toHaveProperty('details');
    expect(JSON.stringify(body)).not.toMatch(/accountId/);
  });

  it('sets no headers by default, matching routes that historically set none', () => {
    const response = invalidBodyResponse(zodError());

    expect(response.headers.get('Cache-Control')).toBeNull();
  });

  it('passes through caller-supplied headers (e.g. NO_STORE_HEADERS)', () => {
    const response = invalidBodyResponse(zodError(), {
      headers: { 'Cache-Control': 'no-store, private' },
    });

    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('is stable across different ZodError shapes — the body never depends on the input', async () => {
    const otherError = (() => {
      const result = z
        .object({ email: z.email(), role: z.enum(['owner', 'admin']) })
        .safeParse({ email: 'not-an-email', role: 'nope' });
      if (result.success) throw new Error('fixture schema unexpectedly parsed');
      return result.error;
    })();

    const response = invalidBodyResponse(otherError);

    expect(await response.json()).toEqual({ error: 'invalid_body' });
  });
});
