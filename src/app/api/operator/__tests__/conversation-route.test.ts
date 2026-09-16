import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireRole, mockGetConversationForOwner, mockReadSummaryEntitlement } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockGetConversationForOwner: vi.fn(),
  mockReadSummaryEntitlement: vi.fn(),
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
  readSummaryEntitlement: (...a: unknown[]) => mockReadSummaryEntitlement(...a),
}));

import { GET } from '../conversation/route';

const ACCOUNT = '00000000-0000-7000-8000-00000000ac01';
const CONVERSATION = '00000000-0000-7000-8000-00000000c001';
const TURN = '00000000-0000-7000-8000-000000000011';
const LOCATION_A = '00000000-0000-7000-8000-00000000b001';

describe('GET /api/operator/conversation', () => {
  it('preserves each stored turn refusal list in a resumed conversation GET', async () => {
    const refusal = {
      type: 'refusal',
      reason: 'review_incentive',
      subjectId: '11111111-1111-4111-8111-111111111111',
      text: 'RepWorth rules prohibit offering incentives in exchange for reviews.',
    };
    const view = {
      conversation: { id: CONVERSATION, lastTurnAt: '2026-09-11T10:00:00.000Z' },
      turns: [
        {
          id: TURN, sequence: 1, status: 'completed', failureReason: null,
          locationId: LOCATION_A, ownerText: 'Offer an incentive for a review.',
          segments: [refusal], proposals: [], unsupported: [], refused: [refusal],
        },
        {
          id: '22222222-2222-4222-8222-222222222222', sequence: 2,
          status: 'completed', failureReason: null, locationId: LOCATION_A,
          ownerText: 'Show what needs me.',
          segments: [], proposals: [], unsupported: [], refused: [],
        },
      ],
      summary: null,
    };
    mockGetConversationForOwner.mockResolvedValue({ kind: 'view', view });
    const response = await GET(new NextRequest(
      `https://app.repworth.test/api/operator/conversation?id=${CONVERSATION}`,
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(view);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OWNER_OPERATOR_ENABLED = 'true';
    mockRequireRole.mockResolvedValue({ id: 'user-1', role: 'owner', accountId: ACCOUNT });
    // The default posture: an entitled account. Cases that care set their own.
    mockReadSummaryEntitlement.mockResolvedValue('active');
  });

  it("GET conversation returns the actor's most recent conversation and the summary reads with timestamps", async () => {
    mockGetConversationForOwner.mockResolvedValue({
      kind: 'view',
      view: {
        conversation: { id: CONVERSATION, lastTurnAt: '2026-09-11T10:00:00.000Z' },
        turns: [{ id: TURN, sequence: 1, status: 'completed', failureReason: null, ownerText: 'Make my replies warmer.', segments: [] }],
        summary: {
          locationId: LOCATION_A,
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
    // The summary names the location it is scoped to (C3): the panel does not
    // re-derive it from the browser's selector, which may have moved.
    expect(body.summary.locationId).toBe(LOCATION_A);
    expect(mockGetConversationForOwner.mock.calls[0]![1]).toEqual({
      accountId: ACCOUNT, actorUserId: 'user-1', conversationId: undefined, locationId: undefined,
    });

    // An explicit id is threaded through, and a foreign one is a 404.
    await GET(new NextRequest(`https://app.repworth.test/api/operator/conversation?id=${CONVERSATION}`));
    expect(mockGetConversationForOwner.mock.calls[1]![1]).toMatchObject({ conversationId: CONVERSATION });

    mockGetConversationForOwner.mockResolvedValue({ kind: 'not_found' });
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
    mockReadSummaryEntitlement.mockResolvedValue('active');
  });

  it('GET conversation scopes the summary to ?locationId= when the conversation has no turns', async () => {
    mockGetConversationForOwner.mockResolvedValue({
      kind: 'view',
      view: {
        conversation: { id: CONVERSATION, lastTurnAt: null },
        turns: [],
        summary: {
          locationId: LOCATION,
          pending: { pendingCount: 2, draftsWaiting: 2 },
          recent: { posted7d: 9, reportingPeriodDays: 7 },
          rules: { threshold: null, vetoWindowMinutes: 15, dailyCap: 5, locationOverrideExists: false },
          facts: null,
          pendingProposals: [],
          connectionStatus: 'active',
          asOf: '2026-09-12T10:00:00.000Z',
        },
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
    mockReadSummaryEntitlement.mockClear();
    mockGetConversationForOwner.mockResolvedValue({
      kind: 'view',
      view: { conversation: { id: CONVERSATION, lastTurnAt: null }, turns: [], summary: null },
    });
    const bare = await GET(new NextRequest('https://app.repworth.test/api/operator/conversation'));
    expect(bare.status).toBe(200);
    expect(mockGetConversationForOwner.mock.calls[0]![1]).toMatchObject({ locationId: undefined });
    // No summary, no entitlement read: there is nothing to gate (C1).
    expect(mockReadSummaryEntitlement).not.toHaveBeenCalled();
  });

  it('GET conversation answers 404 location_not_found for an unusable location, with or without a conversation', async () => {
    // S7. ONE outcome for one fact. Before this the same `?locationId=`
    // answered 404 `conversation_not_found` for an owner with no conversation
    // and 200 with a silently missing panel for one who had a conversation,
    // and the screen could say nothing in either case.
    mockGetConversationForOwner.mockResolvedValue({ kind: 'location_not_found' });

    const response = await GET(new NextRequest(
      `https://app.repworth.test/api/operator/conversation?locationId=${LOCATION}`,
    ));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'location_not_found' });

    // The branch with an EXISTING conversation is the module's to distinguish;
    // the route answers the same code for the same kind, so both reach the
    // client as one thing.
    const withConversation = await GET(new NextRequest(
      `https://app.repworth.test/api/operator/conversation?id=${CONVERSATION}&locationId=${LOCATION}`,
    ));
    expect(withConversation.status).toBe(404);
    expect(await withConversation.json()).toEqual({ error: 'location_not_found' });

    // And it is NOT the conversation 404: the two codes stay distinguishable.
    mockGetConversationForOwner.mockResolvedValue({ kind: 'not_found' });
    const missing = await GET(new NextRequest(
      `https://app.repworth.test/api/operator/conversation?id=${CONVERSATION}`,
    ));
    expect(await missing.json()).toEqual({ error: 'conversation_not_found' });
  });

  it('GET conversation omits the summary for an account that may not read dashboard data', async () => {
    // C1. The panel is customer KPI data and answers to the SAME entitlement
    // `/api/dashboard` enforces. The TRANSCRIPT stays readable: it is the
    // owner's own words, and Run A's read-gate decision stands.
    const view = {
      conversation: { id: CONVERSATION, lastTurnAt: '2026-09-12T10:00:00.000Z' },
      turns: [{ id: TURN, sequence: 1, status: 'completed', failureReason: null, ownerText: 'Hi.', segments: [] }],
      summary: {
        locationId: LOCATION,
        pending: { pendingCount: 7, draftsWaiting: 7 },
        recent: { posted7d: 4, reportingPeriodDays: 7 },
        rules: { threshold: null, vetoWindowMinutes: 15, dailyCap: 5, locationOverrideExists: false },
        facts: null,
        pendingProposals: [],
        connectionStatus: 'active',
        asOf: '2026-09-12T10:00:00.000Z',
      },
    };
    mockGetConversationForOwner.mockResolvedValue({ kind: 'view', view });
    mockReadSummaryEntitlement.mockResolvedValue('pending_payment');

    const response = await GET(new NextRequest('https://app.repworth.test/api/operator/conversation'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.summary).toBeNull();
    // The transcript is untouched, and no count leaked in any other field.
    expect(body.turns).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('"pendingCount"');
    expect(mockReadSummaryEntitlement).toHaveBeenCalledWith(expect.anything(), ACCOUNT);

    // `past_due` is inside the grace window and still reads, exactly as the
    // dashboard's own gate has it — the predicate is shared, not re-spelled.
    mockReadSummaryEntitlement.mockResolvedValue('past_due');
    const pastDue = await GET(new NextRequest('https://app.repworth.test/api/operator/conversation'));
    expect((await pastDue.json()).summary).not.toBeNull();

    // …and `cancelled` does not.
    mockReadSummaryEntitlement.mockResolvedValue('cancelled');
    const cancelled = await GET(new NextRequest('https://app.repworth.test/api/operator/conversation'));
    expect((await cancelled.json()).summary).toBeNull();
  });
});
