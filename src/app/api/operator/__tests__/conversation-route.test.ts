import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireRole, mockGetConversationForOwner } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockGetConversationForOwner: vi.fn(),
}));

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return { requireRole: (...a: unknown[]) => mockRequireRole(...a), AuthError };
});
vi.mock('@/lib/db/server', () => ({ sql: Object.assign(() => Promise.resolve([]), { begin: vi.fn() }), jsonb: (v: unknown) => v }));
vi.mock('@/lib/agents/operator/reads', () => ({
  getConversationForOwner: (...a: unknown[]) => mockGetConversationForOwner(...a),
}));

import { GET } from '../conversation/route';

const ACCOUNT = '00000000-0000-7000-8000-00000000ac01';
const CONVERSATION = '00000000-0000-7000-8000-00000000c001';
const TURN = '00000000-0000-7000-8000-000000000011';

describe('GET /api/operator/conversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OWNER_OPERATOR_ENABLED = 'true';
    mockRequireRole.mockResolvedValue({ id: 'user-1', role: 'owner', accountId: ACCOUNT });
  });

  it("GET conversation returns the actor's most recent conversation and the summary reads with timestamps", async () => {
    mockGetConversationForOwner.mockResolvedValue({
      conversation: { id: CONVERSATION, lastTurnAt: '2026-09-11T10:00:00.000Z' },
      turns: [{ id: TURN, sequence: 1, status: 'completed', failureReason: null, ownerText: 'Make my replies warmer.', segments: [] }],
      summary: {
        pending: { pendingCount: 3, draftsWaiting: 4 },
        recent: { posted7d: 9, reportingPeriodDays: 7 },
        // `null`, not the plan snippet's `'manual'`: `RuleSummary.threshold` is
        // `AutoApprovalThreshold | null` (4 | 5 | null) and "no threshold is
        // set" is exactly what `'manual'` was reaching for — the same one-word
        // fix the T3 deviations entry flagged for this suite.
        rules: { threshold: null, vetoWindowMinutes: 30, dailyCap: 10, locationOverrideExists: false },
        facts: { tone: 'warm', productsServices: null, avoidFacts: [], highlightFacts: [] },
        pendingProposals: [],
        asOf: '2026-09-11T10:00:00.000Z',
      },
    });

    // No ?id: the actor's most recent conversation for this account.
    const latest = await GET(new NextRequest('https://app.repworth.test/api/operator/conversation'));
    expect(latest.status).toBe(200);
    const body = await latest.json();
    expect(body.conversation.id).toBe(CONVERSATION);
    // The SUMMARY is a live read and carries the instant it was read at; the
    // TRANSCRIPT's status segments are frozen values. Two different questions,
    // two different sources, and the panel says which it is showing.
    expect(body.summary.asOf).toBe('2026-09-11T10:00:00.000Z');
    expect(body.summary.recent.reportingPeriodDays).toBe(7);
    expect(body.summary.rules.locationOverrideExists).toBe(false);
    expect(mockGetConversationForOwner.mock.calls[0]![1]).toEqual({
      accountId: ACCOUNT, actorUserId: 'user-1', conversationId: undefined,
    });

    // An explicit id is threaded through, and a foreign one is a 404.
    await GET(new NextRequest(`https://app.repworth.test/api/operator/conversation?id=${CONVERSATION}`));
    expect(mockGetConversationForOwner.mock.calls[1]![1]).toMatchObject({ conversationId: CONVERSATION });

    mockGetConversationForOwner.mockResolvedValue(null);
    const missing = await GET(new NextRequest('https://app.repworth.test/api/operator/conversation'));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'conversation_not_found' });

    // Flag off: the surface does not exist, before auth.
    process.env.OWNER_OPERATOR_ENABLED = 'false';
    mockRequireRole.mockClear();
    const disabled = await GET(new NextRequest('https://app.repworth.test/api/operator/conversation'));
    expect(disabled.status).toBe(404);
    expect(mockRequireRole).not.toHaveBeenCalled();
  });
});

describe('GET /api/operator/conversation — location scoping', () => {
  const LOCATION = '00000000-0000-7000-8000-00000000b101';

  // ITS OWN SETUP. The file's existing `beforeEach` is scoped to the first
  // `describe`, so without this block `mockRequireRole` returns `undefined`,
  // the route answers 401, and every assertion below fails for the wrong
  // reason.
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OWNER_OPERATOR_ENABLED = 'true';
    mockRequireRole.mockResolvedValue({ id: 'user-1', role: 'owner', accountId: ACCOUNT });
  });

  it('GET conversation scopes the summary to ?locationId= when the conversation has no turns', async () => {
    mockGetConversationForOwner.mockResolvedValue({
      conversation: { id: '00000000-0000-7000-8000-00000000c001', lastTurnAt: null },
      turns: [],
      summary: {
        pending: { pendingCount: 2, draftsWaiting: 2 },
        recent: { posted7d: 9, reportingPeriodDays: 7 },
        rules: { threshold: null, vetoWindowMinutes: 15, dailyCap: 5, locationOverrideExists: false },
        facts: null,
        pendingProposals: [],
        connectionStatus: 'active',
        asOf: '2026-09-12T10:00:00.000Z',
      },
    });

    const response = await GET(new NextRequest(
      `https://app.repworth.test/api/operator/conversation?locationId=${LOCATION}`,
    ));

    expect(response.status).toBe(200);
    expect(mockGetConversationForOwner).toHaveBeenCalledTimes(1);
    // The module gets the location; the ROUTE does not resolve it, decide what
    // it means, or fall back to one.
    expect(mockGetConversationForOwner.mock.calls[0]![1]).toMatchObject({ locationId: LOCATION });

    // A malformed value is a 404, matching this route's own `?id` rule — never
    // a 400 that distinguishes "badly shaped" from "not yours".
    mockGetConversationForOwner.mockClear();
    const malformed = await GET(new NextRequest(
      'https://app.repworth.test/api/operator/conversation?locationId=not-a-uuid',
    ));
    expect(malformed.status).toBe(404);
    expect(await malformed.json()).toEqual({ error: 'location_not_found' });
    expect(mockGetConversationForOwner).not.toHaveBeenCalled();

    // Absent: the module is called with no locationId at all, which is Run A's
    // behaviour unchanged (the summary is scoped to the latest turn, or null).
    mockGetConversationForOwner.mockClear();
    mockGetConversationForOwner.mockResolvedValue({
      conversation: { id: '00000000-0000-7000-8000-00000000c001', lastTurnAt: null },
      turns: [],
      summary: null,
    });
    const bare = await GET(new NextRequest('https://app.repworth.test/api/operator/conversation'));
    expect(bare.status).toBe(200);
    expect(mockGetConversationForOwner.mock.calls[0]![1]).toMatchObject({ locationId: undefined });
  });
});
