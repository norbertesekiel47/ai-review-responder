import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// ── Hoisted shared state ────────────────────────────────────────────

const {
  mockRequireDashboardReviewOwner,
  mockAssertWritableSubscriptionForAccount,
  mockAcknowledgeEscalation,
  mockResolveEscalation,
} = vi.hoisted(() => ({
  mockRequireDashboardReviewOwner: vi.fn(),
  mockAssertWritableSubscriptionForAccount: vi.fn(),
  mockAcknowledgeEscalation: vi.fn(),
  mockResolveEscalation: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ sql: {} }));

vi.mock('@/lib/approval/http-routes', () => ({
  requireDashboardReviewOwner: (...args: unknown[]) => mockRequireDashboardReviewOwner(...args),
}));

vi.mock('@/lib/shared/writable-subscription', () => ({
  assertWritableSubscriptionForAccount: (...args: unknown[]) =>
    mockAssertWritableSubscriptionForAccount(...args),
}));

vi.mock('@/lib/escalations/transitions', () => ({
  acknowledgeEscalation: (...args: unknown[]) => mockAcknowledgeEscalation(...args),
  resolveEscalation: (...args: unknown[]) => mockResolveEscalation(...args),
}));

// ── Helpers ─────────────────────────────────────────────────────────

const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001';
const ESCALATION_ID = 'esc-001';
const APP_URL = 'http://localhost:3000';

function ownerContext() {
  return { id: 'user-1', accountId: ACCOUNT_ID };
}

function makeRequest(url: string, opts: { origin?: string | null } = {}): NextRequest {
  const headers: Record<string, string> = {};
  const origin = opts.origin === undefined ? APP_URL : opts.origin;
  if (origin !== null) headers.Origin = origin;

  return new NextRequest(`http://localhost:3000${url}`, {
    method: 'POST',
    headers,
  });
}

function makeParams(escalationId: string): { params: Promise<{ escalationId: string }> } {
  return { params: Promise.resolve({ escalationId }) };
}

describe.each([
  {
    label: 'acknowledge',
    routePath: '../[escalationId]/acknowledge/route',
    transitionMock: () => mockAcknowledgeEscalation,
    otherTransitionMock: () => mockResolveEscalation,
    invalidTransitionBody: { error: 'Escalation is already resolved' },
  },
  {
    label: 'resolve',
    routePath: '../[escalationId]/resolve/route',
    transitionMock: () => mockResolveEscalation,
    otherTransitionMock: () => mockAcknowledgeEscalation,
    invalidTransitionBody: { error: 'Invalid escalation state' },
  },
])('POST /api/dashboard/escalations/[escalationId]/$label', ({
  label,
  routePath,
  transitionMock,
  otherTransitionMock,
  invalidTransitionBody,
}) => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
    mockAssertWritableSubscriptionForAccount.mockResolvedValue({ ok: true });
  });

  it('passes through the response when the owner is unauthenticated', async () => {
    const unauthenticated = NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    mockRequireDashboardReviewOwner.mockResolvedValue(unauthenticated);

    const { POST } = await import(routePath);
    const res = await POST(makeRequest(`/api/dashboard/escalations/${ESCALATION_ID}/${label}`), makeParams(ESCALATION_ID));

    expect(res.status).toBe(401);
    expect(mockAssertWritableSubscriptionForAccount).not.toHaveBeenCalled();
    expect(transitionMock()).not.toHaveBeenCalled();
  });

  it('passes through the status/error when the subscription is read-only', async () => {
    mockRequireDashboardReviewOwner.mockResolvedValue(ownerContext());
    mockAssertWritableSubscriptionForAccount.mockResolvedValue({
      ok: false,
      status: 402,
      error: 'past_due_read_only',
    });

    const { POST } = await import(routePath);
    const res = await POST(makeRequest(`/api/dashboard/escalations/${ESCALATION_ID}/${label}`), makeParams(ESCALATION_ID));

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'past_due_read_only' });
    expect(transitionMock()).not.toHaveBeenCalled();
  });

  it('returns 404 when the transition reports not_found', async () => {
    mockRequireDashboardReviewOwner.mockResolvedValue(ownerContext());
    transitionMock().mockResolvedValue({ ok: false, code: 'not_found' });

    const { POST } = await import(routePath);
    const res = await POST(makeRequest(`/api/dashboard/escalations/${ESCALATION_ID}/${label}`), makeParams(ESCALATION_ID));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Escalation not found' });
  });

  it('returns 409 when the transition reports invalid_transition', async () => {
    mockRequireDashboardReviewOwner.mockResolvedValue(ownerContext());
    transitionMock().mockResolvedValue({ ok: false, code: 'invalid_transition' });

    const { POST } = await import(routePath);
    const res = await POST(makeRequest(`/api/dashboard/escalations/${ESCALATION_ID}/${label}`), makeParams(ESCALATION_ID));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(invalidTransitionBody);
  });

  it('returns 200 with the resulting status on success', async () => {
    mockRequireDashboardReviewOwner.mockResolvedValue(ownerContext());
    transitionMock().mockResolvedValue({ ok: true, status: label === 'acknowledge' ? 'acknowledged' : 'resolved', noop: false });

    const { POST } = await import(routePath);
    const res = await POST(makeRequest(`/api/dashboard/escalations/${ESCALATION_ID}/${label}`), makeParams(ESCALATION_ID));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      status: label === 'acknowledge' ? 'acknowledged' : 'resolved',
    });
    expect(res.headers.get('Cache-Control')).toBe('no-store, private');
    expect(transitionMock()).toHaveBeenCalledWith({}, { escalationId: ESCALATION_ID, accountId: ACCOUNT_ID });
    expect(otherTransitionMock()).not.toHaveBeenCalled();
  });

  it('returns 403 when Origin does not match the app origin', async () => {
    mockRequireDashboardReviewOwner.mockResolvedValue(ownerContext());

    const { POST } = await import(routePath);
    const res = await POST(
      makeRequest(`/api/dashboard/escalations/${ESCALATION_ID}/${label}`, { origin: 'https://evil.example.com' }),
      makeParams(ESCALATION_ID),
    );

    expect(res.status).toBe(403);
    expect(mockRequireDashboardReviewOwner).not.toHaveBeenCalled();
  });
});
