import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

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
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
    mockNotify.mockResolvedValue({ sent: true });
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

  it('notifies with the submission incl. googleMapsUrl and returns 200', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({
      name: 'Alice', email: 'a@b.com', businessName: 'Acme',
      googleMapsUrl: 'https://maps.google.com/?cid=123',
    }));
    expect(res.status).toBe(200);
    expect(mockNotify).toHaveBeenCalledOnce();
    const arg = mockNotify.mock.calls[0]![0] as { subject: string; lines: string[] };
    expect(arg.subject).toContain('Demo Request');
    const body = arg.lines.join('\n');
    expect(body).toContain('Alice');
    expect(body).toContain('https://maps.google.com/?cid=123');
  });

  it('returns 429 when rate limit exceeded', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });
    const { POST } = await import('../route');
    const res = await POST(makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme', googleMapsUrl: '' }));
    expect(res.status).toBe(429);
  });

  it('returns 500 when Resend returns error', async () => {
    mockNotify.mockRejectedValueOnce(new Error('send failed'));
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
