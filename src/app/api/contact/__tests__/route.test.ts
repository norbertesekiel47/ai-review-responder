import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ────────────────────────────────────────────────────

const { mockNotify, mockCheckRateLimit } = vi.hoisted(() => ({
  mockNotify: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock('@/lib/notifications/contact-notify', () => ({
  notifyContactSubmission: mockNotify,
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
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9 });
    mockNotify.mockResolvedValue({ sent: true });
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

  it('calls notifyContactSubmission with the submission and returns 200', async () => {
    const { POST } = await import('../route');
    const req = makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mockNotify).toHaveBeenCalledOnce();
    const arg = mockNotify.mock.calls[0]![0] as { subject: string; lines: string[] };
    expect(arg.subject).toContain('Demo Request');
    const body = arg.lines.join('\n');
    expect(body).toContain('Alice');
    expect(body).toContain('a@b.com');
    expect(body).toContain('Acme');
  });

  it('returns 500 when Resend throws', async () => {
    mockNotify.mockRejectedValueOnce(new Error('send failed'));
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
