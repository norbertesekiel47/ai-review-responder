import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

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

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/demo-request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/demo-request', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    delete process.env.CONTACT_NOTIFY_TO;
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
  });

  it('returns 400 when name is missing', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({ email: 'a@b.com', businessName: 'Acme', googleMapsUrl: '' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/name/i);
  });

  it('returns 400 when email is malformed', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({ name: 'Alice', email: 'bad', businessName: 'Acme', googleMapsUrl: '' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/email/i);
  });

  it('returns 400 when businessName is missing', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({ name: 'Alice', email: 'a@b.com', googleMapsUrl: '' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/business/i);
  });

  it('returns 200 without email when RESEND_API_KEY is unset', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme', googleMapsUrl: '' }));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('sends email with googleMapsUrl when RESEND_API_KEY is set', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    process.env.RESEND_FROM_EMAIL = 'noreply@repworth.com';
    mockResendSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
    const { POST } = await import('../route');
    const res = await POST(makeRequest({
      name: 'Alice', email: 'a@b.com', businessName: 'Acme',
      googleMapsUrl: 'https://maps.google.com/?cid=123',
    }));
    expect(res.status).toBe(200);
    const callArg = mockResendSend.mock.calls[0]?.[0] as Parameters<typeof mockResendSend>[0];
    expect(callArg.to).toBe('noreply@repworth.com');
    expect(callArg.subject).toContain('Demo Request');
    expect(callArg.text).toContain('Alice');
    expect(callArg.text).toContain('https://maps.google.com/?cid=123');
  });

  it('returns 429 when rate limit exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });
    const { POST } = await import('../route');
    const res = await POST(makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme', googleMapsUrl: '' }));
    expect(res.status).toBe(429);
  });

  it('returns 500 when Resend returns error', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    process.env.RESEND_FROM_EMAIL = 'noreply@repworth.com';
    mockResendSend.mockResolvedValue({ data: null, error: { message: 'fail' } });
    const { POST } = await import('../route');
    const res = await POST(makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme', googleMapsUrl: '' }));
    expect(res.status).toBe(500);
  });

  it('returns 400 when googleMapsUrl is not https', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme', googleMapsUrl: 'http://maps.google.com' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/https/i);
  });

  it('accepts valid https googleMapsUrl', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme', googleMapsUrl: 'https://maps.google.com/maps?cid=123' }));
    expect(res.status).toBe(200);
  });
});
