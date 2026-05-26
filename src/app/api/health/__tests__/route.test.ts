import { describe, it, expect } from 'vitest';
import { GET } from '../route';

describe('GET /api/health', () => {
  it('returns 200 with ok status for the web service', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.service).toBe('web');
    expect(typeof body.timestamp).toBe('string');
    expect(() => new Date(body.timestamp as string).toISOString()).not.toThrow();
  });
});
