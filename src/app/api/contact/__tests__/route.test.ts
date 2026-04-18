import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ────────────────────────────────────────────────────

const { mockResendSend, mockCheckRateLimit } = vi.hoisted(() => ({
  mockResendSend: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(function () {
    return { emails: { send: mockResendSend } };
  }),
}));

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

// ── Helpers ──────────────────────────────────────────────────────────

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeRawRequest(rawBody: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/contact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('POST /api/contact', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9 });
  });

  it('returns 400 when name is missing', async () => {
    const { POST } = await import('../route');
    const req = makeRequest({ email: 'a@b.com', businessName: 'Acme' });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/name/i);
  });

  it('returns 400 when email is missing', async () => {
    const { POST } = await import('../route');
    const req = makeRequest({ name: 'Alice', businessName: 'Acme' });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/email/i);
  });

  it('returns 400 when email is malformed', async () => {
    const { POST } = await import('../route');
    const req = makeRequest({ name: 'Alice', email: 'not-an-email', businessName: 'Acme' });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/email/i);
  });

  it('returns 400 when businessName is missing', async () => {
    const { POST } = await import('../route');
    const req = makeRequest({ name: 'Alice', email: 'a@b.com' });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/business/i);
  });

  it('returns 200 without sending email when RESEND_API_KEY is unset', async () => {
    const { POST } = await import('../route');
    const req = makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('sends email via Resend when RESEND_API_KEY is set', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    process.env.RESEND_FROM_EMAIL = 'noreply@repworth.com';
    mockResendSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null });

    const { POST } = await import('../route');
    const req = makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockResendSend).toHaveBeenCalledOnce();

    const callArg = mockResendSend.mock.calls[0][0];
    expect(callArg.to).toBe('norbertesekiel@gmail.com');
    expect(callArg.subject).toContain('Demo Request');
    expect(callArg.text).toContain('Alice');
    expect(callArg.text).toContain('a@b.com');
    expect(callArg.text).toContain('Acme');
  });

  it('returns 500 when Resend throws', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    process.env.RESEND_FROM_EMAIL = 'noreply@repworth.com';
    mockResendSend.mockResolvedValue({ data: null, error: { message: 'send failed' } });

    const { POST } = await import('../route');
    const req = makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme' });
    const res = await POST(req);
    expect(res.status).toBe(500);
  });

  it('returns 400 when body is not an object (null)', async () => {
    const { POST } = await import('../route');
    const req = makeRawRequest('null');
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid json/i);
  });

  it('returns 400 when body is not an object (array)', async () => {
    const { POST } = await import('../route');
    const req = makeRawRequest('[1,2,3]');
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/invalid json/i);
  });

  it('returns 429 when rate limit is exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });

    const { POST } = await import('../route');
    const req = makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme' });
    const res = await POST(req);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/too many/i);
  });
});
