import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const {
  dbState,
  mockCheckRateLimit,
  mockJsonb,
  mockResendSend,
  mockSql,
} = vi.hoisted(() => {
  const dbState = {
    rejectNext: false,
    calls: [] as Array<{ text: string; values: unknown[] }>,
  };

  const mockSql = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    dbState.calls.push({ text: strings.join('?'), values });

    if (dbState.rejectNext) {
      return Promise.reject(new Error('synthetic database failure'));
    }

    return Promise.resolve([{ id: '018f0000-0000-7000-8000-000000000001' }]);
  });

  return {
    dbState,
    mockCheckRateLimit: vi.fn(),
    mockJsonb: vi.fn((value: unknown) => value),
    mockResendSend: vi.fn(),
    mockSql,
  };
});

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock('@/lib/db/server', () => ({
  jsonb: mockJsonb,
  sql: mockSql,
}));

vi.mock('resend', () => ({
  Resend: vi.fn().mockImplementation(function () {
    return { emails: { send: mockResendSend } };
  }),
}));

function makeRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/lead-intake', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'vitest-agent',
      Referer: 'https://repworth.com/',
      'x-forwarded-for': '203.0.113.10, 10.0.0.1',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function makeRawRequest(rawBody: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/lead-intake', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: rawBody,
  });
}

describe('POST /api/lead-intake', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbState.rejectNext = false;
    dbState.calls = [];
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    delete process.env.CONTACT_NOTIFY_TO;
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
    mockResendSend.mockResolvedValue({ data: { id: 'msg-1' }, error: null });
  });

  it('returns 400 for invalid JSON and does not write to the database', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRawRequest('{'));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid json/i);
    expect(dbState.calls).toHaveLength(0);
  });

  it('returns 400 when name is missing and does not write to the database', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({
      email: 'owner@example.com',
      businessName: 'Alice Bakery',
    }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/name/i);
    expect(dbState.calls).toHaveLength(0);
  });

  it('returns 400 when email is malformed and does not write to the database', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({
      name: 'Alice Owner',
      email: 'not-an-email',
      businessName: 'Alice Bakery',
    }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/email/i);
    expect(dbState.calls).toHaveLength(0);
  });

  it('returns 400 when businessName is missing and does not write to the database', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({
      name: 'Alice Owner',
      email: 'owner@example.com',
    }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/business/i);
    expect(dbState.calls).toHaveLength(0);
  });

  it('returns 400 when googleMapsUrl is not HTTPS and does not write to the database', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({
      name: 'Alice Owner',
      email: 'owner@example.com',
      businessName: 'Alice Bakery',
      googleMapsUrl: 'http://maps.google.com/?cid=123',
    }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/https/i);
    expect(dbState.calls).toHaveLength(0);
  });

  it('persists a valid waitlist lead', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({
      name: ' Alice Owner ',
      email: ' OWNER@Example.COM ',
      businessName: ' Alice Bakery ',
      googleMapsUrl: ' https://maps.google.com/?cid=123 ',
      intent: 'waitlist',
      source: 'landing',
    }));

    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(dbState.calls).toHaveLength(1);
    expect(dbState.calls[0].text).toContain('INSERT INTO owner_leads');
    expect(dbState.calls[0].text).toContain('ON CONFLICT (email_normalized, intent)');
    expect(dbState.calls[0].values).toEqual(expect.arrayContaining([
      'Alice Owner',
      'owner@example.com',
      'Alice Bakery',
      'https://maps.google.com/?cid=123',
      'waitlist',
      'landing',
    ]));
  });

  it('defaults missing intent and source to waitlist and unknown', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({
      name: 'Alice Owner',
      email: 'owner@example.com',
      businessName: 'Alice Bakery',
    }));

    expect(res.status).toBe(200);
    expect(dbState.calls[0].values).toEqual(expect.arrayContaining(['waitlist', 'unknown']));
  });

  it('preserves future demo intent with book-a-demo source', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({
      name: 'Alice Owner',
      email: 'owner@example.com',
      businessName: 'Alice Bakery',
      intent: 'demo',
      source: 'book-a-demo',
    }));

    expect(res.status).toBe(200);
    expect(dbState.calls[0].values).toEqual(expect.arrayContaining(['demo', 'book-a-demo']));
  });

  it('returns 400 for unsupported intent and does not write to the database', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({
      name: 'Alice Owner',
      email: 'owner@example.com',
      businessName: 'Alice Bakery',
      intent: 'subscribe',
    }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/intent/i);
    expect(dbState.calls).toHaveLength(0);
  });

  it('returns 400 for unsupported source and does not write to the database', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({
      name: 'Alice Owner',
      email: 'owner@example.com',
      businessName: 'Alice Bakery',
      source: 'partner',
    }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/source/i);
    expect(dbState.calls).toHaveLength(0);
  });

  it('returns 429 when rate limited and does not write to the database', async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });

    const { POST } = await import('../route');
    const res = await POST(makeRequest({
      name: 'Alice Owner',
      email: 'owner@example.com',
      businessName: 'Alice Bakery',
    }));

    expect(res.status).toBe(429);
    expect(dbState.calls).toHaveLength(0);
    expect(mockCheckRateLimit).toHaveBeenCalledWith('lead-intake:hour:203.0.113.10', 5, 3600);
  });

  it('sends a Resend email after persistence and uses CONTACT_NOTIFY_TO', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    process.env.CONTACT_NOTIFY_TO = 'leads@example.com';

    const { POST } = await import('../route');
    const res = await POST(makeRequest({
      name: 'Alice Owner',
      email: 'owner@example.com',
      businessName: 'Alice Bakery',
      googleMapsUrl: 'https://maps.google.com/?cid=123',
      source: 'landing',
    }));

    expect(res.status).toBe(200);
    expect(dbState.calls).toHaveLength(1);
    expect(mockResendSend).toHaveBeenCalledOnce();
    expect(mockResendSend.mock.invocationCallOrder[0]).toBeGreaterThan(mockSql.mock.invocationCallOrder[0]);

    const email = mockResendSend.mock.calls[0][0];
    expect(email.to).toBe('leads@example.com');
    expect(email.subject).toBe('New owner lead - waitlist - RepWorth');
    expect(email.text).toContain('Name: Alice Owner');
    expect(email.text).toContain('Email: owner@example.com');
    expect(email.text).toContain('Business: Alice Bakery');
    expect(email.text).toContain('Intent: waitlist');
    expect(email.text).toContain('Source: landing');
    expect(email.text).toContain('Google Maps: https://maps.google.com/?cid=123');
    expect(email.text).toContain('Submitted at:');
  });

  it('returns 500 on database failure and skips email', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    dbState.rejectNext = true;

    const { POST } = await import('../route');
    const res = await POST(makeRequest({
      name: 'Alice Owner',
      email: 'owner@example.com',
      businessName: 'Alice Bakery',
    }));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to save lead');
    expect(dbState.calls).toHaveLength(1);
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it('returns 500 when Resend returns an error after persistence', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    mockResendSend.mockResolvedValue({ data: null, error: { message: 'send failed' } });

    const { POST } = await import('../route');
    const res = await POST(makeRequest({
      name: 'Alice Owner',
      email: 'owner@example.com',
      businessName: 'Alice Bakery',
    }));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to send notification');
    expect(dbState.calls).toHaveLength(1);
    expect(mockResendSend).toHaveBeenCalledOnce();
  });
});
