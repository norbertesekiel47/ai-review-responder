import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockEnqueueAnalyticsEvent, mockCookieGet } = vi.hoisted(() => ({
  mockEnqueueAnalyticsEvent: vi.fn(),
  mockCookieGet: vi.fn(),
}));

vi.mock('@/lib/analytics/enqueue', () => ({
  enqueueAnalyticsEvent: (...args: unknown[]) => mockEnqueueAnalyticsEvent(...args),
}));

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 4 })),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: mockCookieGet,
  })),
}));

const APP_URL = 'https://app.example.com';

function req(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${APP_URL}/api/analytics/enqueue`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: APP_URL,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/analytics/enqueue', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
    mockEnqueueAnalyticsEvent.mockReset();
    mockCookieGet.mockReset();
  });

  it('rejects cross-origin requests before enqueue', async () => {
    const { POST } = await import('../route');
    const res = await POST(req({ eventName: 'signup_started' }, { origin: 'https://evil.example.com' }));
    expect(res.status).toBe(403);
    expect(mockEnqueueAnalyticsEvent).not.toHaveBeenCalled();
  });

  it('rejects unknown event names', async () => {
    const { POST } = await import('../route');
    const res = await POST(req({ eventName: 'freeform_event', clientEventId: 'c1' }));
    expect(res.status).toBe(400);
  });

  it('enqueues allowed pre-account event with anonymous id', async () => {
    const { POST } = await import('../route');
    const res = await POST(req({
      eventName: 'signup_started',
      clientEventId: 'client-1',
      properties: { signup_source: 'homepage' },
    }));
    expect(res.status).toBe(202);
    expect(mockEnqueueAnalyticsEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: 'signup_started',
      eventKey: expect.stringMatching(/^signup_started:/),
      properties: { signup_source: 'homepage' },
    }));
  });
});
