import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockCheckRateLimit, mockGetUser, mockSql } = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockGetUser: vi.fn(),
  mockSql: vi.fn(),
}));

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
  })),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
process.env.ONBOARDING_DEMO_ENABLED = 'true';

import { GET } from '../route';

function mkReq(): NextRequest {
  return new NextRequest('https://app.example.com/api/onboarding/demo/status');
}

const mockUser = { id: 'auth-uuid-123', email: 'owner@example.com' };

function demoRow(overrides: Partial<{
  generation_status: string;
  completed_at: Date | null;
  source: string | null;
}> = {}) {
  return {
    generation_status: overrides.generation_status ?? 'completed',
    completed_at: overrides.completed_at ?? new Date('2026-05-21T12:00:00Z'),
    source: overrides.source ?? 'google',
  };
}

function ownerRow() {
  return {
    user_id: 'user-1',
    business_id: 'biz-1',
  };
}

describe('GET /api/onboarding/demo/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ONBOARDING_DEMO_ENABLED = 'true';
    mockGetUser.mockResolvedValue({ data: { user: mockUser }, error: null });
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 59 });
    mockSql.mockResolvedValue([]);
  });

  it('returns 404 when onboarding demo flow is disabled', async () => {
    process.env.ONBOARDING_DEMO_ENABLED = 'false';

    const res = await GET(mkReq());

    expect(res.status).toBe(404);
    expect(mockGetUser).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 401 when unauthenticated', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });

    const res = await GET(mkReq());

    expect(res.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('returns 404 not_found when no eligible owner demo exists', async () => {
    mockSql.mockResolvedValueOnce([]);

    const res = await GET(mkReq());

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('not_found');
  });

  it('returns demo status for an owner demo', async () => {
    mockSql
      .mockResolvedValueOnce([ownerRow()])
      .mockResolvedValueOnce([demoRow()]);

    const res = await GET(mkReq());

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({
      status: 'completed',
      completedAt: '2026-05-21T12:00:00.000Z',
      source: 'google',
    });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('returns 404 not_found when authenticated row is not owner', async () => {
    mockSql.mockResolvedValueOnce([]);

    const res = await GET(mkReq());

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe('not_found');
  });

  it('SQL boundary: demo lookup filters on users.role = owner', async () => {
    mockSql
      .mockResolvedValueOnce([ownerRow()])
      .mockResolvedValueOnce([demoRow()]);

    await GET(mkReq());

    const callArgs = mockSql.mock.calls[0] as unknown[];
    const query = (callArgs[0] as TemplateStringsArray).join('?');
    expect(query).toContain("u.role = 'owner'");
  });

  it('SQL boundary: demo lookup filters by resolved user and business ids', async () => {
    mockSql
      .mockResolvedValueOnce([ownerRow()])
      .mockResolvedValueOnce([demoRow()]);

    await GET(mkReq());

    const callArgs = mockSql.mock.calls[1] as unknown[];
    const query = (callArgs[0] as TemplateStringsArray).join('?');
    expect(query).toContain('d.user_id = ?::uuid');
    expect(query).toContain('d.business_id = ?::uuid');
  });

  it('returns 429 when rate limit is exceeded', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });

    const res = await GET(mkReq());

    expect(res.status).toBe(429);
    expect(mockSql).not.toHaveBeenCalled();
  });
});
