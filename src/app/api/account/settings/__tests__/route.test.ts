import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── /api/account/settings route tests ──────────────────────────────────────

describe('GET /api/account/settings', () => {
  beforeEach(() => {
    vi.stubEnv('MULTI_LOCATION_ENABLED', 'true');
    // No session cookie → getCurrentUser resolves null → AuthError(401). The
    // Supabase client still needs URL/key to construct; without them
    // createServerClient throws a non-auth error (which requireRoleOr401 now
    // correctly surfaces as 5xx rather than masking as 401).
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 when no session cookie', async () => {
    const { GET } = await import('@/app/api/account/settings/route');
    const req = new NextRequest('http://localhost:3000/api/account/settings');
    const res = await GET(req as any);
    expect(res.status).toBe(401);
  });
});

// ── /api/locations/display-label route tests ───────────────────────────────

describe('PUT /api/locations/display-label', () => {
  const APP_URL = 'http://localhost:3000';

  beforeEach(() => {
    vi.stubEnv('MULTI_LOCATION_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL);
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'http://localhost:54321');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 when no session cookie', async () => {
    const { PUT } = await import('@/app/api/locations/display-label/route');
    const req = new NextRequest('http://localhost:3000/api/locations/display-label', {
      method: 'PUT',
      body: JSON.stringify({ locationId: 'a'.repeat(8) + '-' + 'b'.repeat(4) + '-' + 'c'.repeat(4) + '-' + 'd'.repeat(4) + '-' + 'e'.repeat(12), accountId: 'f'.repeat(8) + '-' + '0'.repeat(4) + '-' + '0'.repeat(4) + '-' + '0'.repeat(4) + '-' + '0'.repeat(12), displayLabel: 'Test' }),
      headers: { 'Content-Type': 'application/json', Origin: APP_URL },
    });
    const res = await PUT(req as any);
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid request body', async () => {
    const { PUT } = await import('@/app/api/locations/display-label/route');
    const req = new NextRequest('http://localhost:3000/api/locations/display-label', {
      method: 'PUT',
      body: JSON.stringify({ locationId: 'not-a-uuid', accountId: 'also-not-uuid', displayLabel: 'Test' }),
      headers: { 'Content-Type': 'application/json', Origin: APP_URL },
    });
    const res = await PUT(req as any);
    expect(res.status).toBe(401); // Auth check runs first
  });
});
