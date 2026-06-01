import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

type SqlTemplateMock = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;

const {
  mockCheckRateLimit,
  mockSql,
  mockSetDeviceCookie,
  mockSetCsrfCookie,
  mockVerifyDeviceCookie,
} = vi.hoisted(() => ({
  mockCheckRateLimit: vi.fn(),
  mockSql: vi.fn<SqlTemplateMock>(),
  mockSetDeviceCookie: vi.fn(),
  mockSetCsrfCookie: vi.fn(),
  mockVerifyDeviceCookie: vi.fn(),
}));

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

vi.mock('@/lib/approval/cookies', () => ({
  setDeviceCookie: (...args: unknown[]) => mockSetDeviceCookie(...args),
  setCsrfCookie: (...args: unknown[]) => mockSetCsrfCookie(...args),
  verifyDeviceCookie: (...args: unknown[]) => mockVerifyDeviceCookie(...args),
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockSql.mockReset();
  mockVerifyDeviceCookie.mockReturnValue(false);
});

function requestWithLegacyIp(): NextRequest {
  const req = new NextRequest('http://localhost:3000/api/approve/raw-token', {
    method: 'GET',
  });
  Object.defineProperty(req, 'ip', {
    value: '203.0.113.42',
    configurable: true,
  });
  return req;
}

describe('GET /api/approve/[token]', () => {
  it('rate-limits by legacy request.ip when x-forwarded-for is absent', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false });

    const { GET } = await import('../route');
    const res = await GET(requestWithLegacyIp(), {
      params: Promise.resolve({ token: 'raw-token' }),
    });

    expect(mockCheckRateLimit).toHaveBeenCalledWith('approve:get:ip:203.0.113.42', 10, 60);
    expect(res.status).toBe(429);
  });

  it('keeps successful GET read-only and sets approval cookies', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: true });

    mockSql
      .mockResolvedValueOnce([
        {
          id: 'link-1',
          response_id: 'resp-1',
          business_id: 'biz-1',
          expires_at: new Date(Date.now() + 60_000),
          consumed_at: null,
          revoked_at: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          response_text: 'Thanks for visiting.',
          version: 1,
          status: 'pending_approval',
          reviewer_name: 'Pat',
          star_rating: 5,
          review_text: 'Great.',
          review_date: '2026-05-01T00:00:00.000Z',
          business_name: 'Cafe Test',
          display_label: null,
          account_id: 'acct-1',
          is_archived: false,
        },
      ]);

    const { GET } = await import('../route');
    const res = await GET(requestWithLegacyIp(), {
      params: Promise.resolve({ token: 'raw-token' }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      review: { reviewerName: 'Pat', starRating: 5 },
      response: { responseText: 'Thanks for visiting.', status: 'pending_approval' },
      businessName: 'Cafe Test',
    });

    expect(mockVerifyDeviceCookie).toHaveBeenCalledTimes(1);
    expect(mockSetDeviceCookie).toHaveBeenCalledTimes(1);
    expect(mockSetCsrfCookie).toHaveBeenCalledTimes(1);

    const sqlText = mockSql.mock.calls
      .map((call) => Array.from(call[0] as TemplateStringsArray).join(' '))
      .join('\n');
    expect(sqlText).toMatch(/\bSELECT\b/i);
    expect(sqlText).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });
});
