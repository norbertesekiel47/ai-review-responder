// src/lib/db/__tests__/auth.test.ts
//
// Unit coverage for cookieBackedServerClient — the single owner of the
// read-only cookie-backed Supabase SSR adapter (previously copy-pasted into
// getCurrentUser, the since-deleted `withSession` wrapper, and the admin MFA
// gate). Pins the security-relevant wiring: getAll() returns the request
// cookies; setAll() is a no-op.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: {} })),
}));

// db/auth imports sql at module load; cookieBackedServerClient never uses it,
// but the import must resolve without spinning up a real Postgres client.
vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));

import { cookieBackedServerClient } from '../auth';
import { createServerClient } from '@supabase/ssr';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-test';
});

describe('cookieBackedServerClient', () => {
  it('builds the client with the public URL/anon key and the request cookies', () => {
    const mockCreate = vi.mocked(createServerClient);
    const req = new NextRequest('https://app.example.com/api/x', {
      method: 'POST',
      headers: { cookie: 'sb-access-token=tok123' },
    });

    cookieBackedServerClient(req);

    expect(mockCreate).toHaveBeenCalledOnce();
    const [url, key, opts] = mockCreate.mock.calls[0]!;
    expect(url).toBe('https://test.supabase.co');
    expect(key).toBe('anon-key-test');

    const cookies = (opts as any).cookies.getAll();
    expect(cookies).toContainEqual(
      expect.objectContaining({ name: 'sb-access-token', value: 'tok123' }),
    );
  });

  it('uses a no-op setAll (route handlers cannot mutate request cookies)', () => {
    const mockCreate = vi.mocked(createServerClient);
    cookieBackedServerClient(
      new NextRequest('https://app.example.com/api/x', { method: 'POST' }),
    );

    const [, , opts] = mockCreate.mock.calls[0]!;
    expect(() => (opts as any).cookies.setAll([{ name: 'x', value: 'y' }])).not.toThrow();
  });
});
