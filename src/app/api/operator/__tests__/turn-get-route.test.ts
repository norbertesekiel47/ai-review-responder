import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireRole, mockGetTurnForOwner } = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockGetTurnForOwner: vi.fn(),
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
vi.mock('@/lib/agents/operator/reads', () => ({ getTurnForOwner: (...a: unknown[]) => mockGetTurnForOwner(...a) }));

import { GET } from '../turns/[id]/route';

const ACCOUNT = '00000000-0000-7000-8000-00000000ac01';
const LOCATION = '00000000-0000-7000-8000-00000000b101';
const TURN = '00000000-0000-7000-8000-000000000011';

describe('GET /api/operator/turns/:id', () => {
  it('returns stored refusals under a separate GET key without converting them to unsupported requests', async () => {
    const refused = [{
      type: 'refusal',
      reason: 'invented_business_fact',
      subjectId: '11111111-1111-4111-8111-111111111111',
      text: 'RepWorth rules prohibit inventing or claiming unverified business facts, including licenses and credentials.',
    }];
    mockGetTurnForOwner.mockResolvedValue({
      id: TURN, status: 'completed', failureReason: null, locationId: LOCATION,
      segments: refused, proposals: [], unsupported: [], refused,
    });
    const response = await GET(
      new NextRequest(`https://app.repworth.test/api/operator/turns/${TURN}`),
      { params: Promise.resolve({ id: TURN }) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: TURN, status: 'completed', failureReason: null,
      segments: refused, proposals: [], unsupported: [], refused,
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OWNER_OPERATOR_ENABLED = 'true';
    mockRequireRole.mockResolvedValue({ id: 'user-1', role: 'owner', accountId: ACCOUNT });
  });

  it('GET turn returns rendered segments and stored rows scoped by account and 404 across accounts', async () => {
    mockGetTurnForOwner.mockResolvedValue({
      id: TURN,
      status: 'completed',
      failureReason: null,
      locationId: LOCATION,
      segments: [
        { type: 'notice', text: 'I do not read review text here. Open it in the Reviews list to draft a reply.' },
        { type: 'status', metric: 'pending_count', value: 3, reportingPeriodDays: 7, asOf: '2026-09-11T10:00:00.000Z' },
        { type: 'proposal', proposalId: 'prop-1' },
      ],
      proposals: [{ id: 'prop-1', operation: 'set_tone', labelKind: 'fact', status: 'pending' }],
      unsupported: [{ id: 'unsup-1', request: 'Stop replying on weekends', context: '' }],
      refused: [],
    });

    const response = await GET(
      new NextRequest(`https://app.repworth.test/api/operator/turns/${TURN}`),
      { params: Promise.resolve({ id: TURN }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    // A scrubbed turn's notice survives a refresh because it is a STORED
    // `server_notice` segment, not a flag the GET route would have to re-derive
    // from an owner message it never sees.
    expect(body.segments[0]).toEqual({
      type: 'notice',
      text: 'I do not read review text here. Open it in the Reviews list to draft a reply.',
    });
    // A number on screen is a FROZEN read: the value, its period and its
    // timestamp were materialized at fenced completion and pass through the
    // renderer untouched. The route issues NO metrics query, so a count from a
    // week ago cannot be silently replaced by today's.
    expect(body.segments[1]).toEqual({
      type: 'status', metric: 'pending_count', value: 3,
      reportingPeriodDays: 7, asOf: '2026-09-11T10:00:00.000Z',
    });
    // Two kinds, two keys — a renderer can never grow Apply onto an unsupported row.
    expect(body.proposals).toHaveLength(1);
    expect(body.unsupported).toHaveLength(1);
    expect(body.refused).toEqual([]);
    expect(mockGetTurnForOwner.mock.calls[0]![1]).toEqual({ turnId: TURN, accountId: ACCOUNT });

    // Another account's turn is indistinguishable from one that does not exist.
    mockGetTurnForOwner.mockResolvedValue(null);
    const foreign = await GET(
      new NextRequest(`https://app.repworth.test/api/operator/turns/${TURN}`),
      { params: Promise.resolve({ id: TURN }) },
    );
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'turn_not_found' });

    // Flag off: the surface does not exist, before auth.
    process.env.OWNER_OPERATOR_ENABLED = 'false';
    mockRequireRole.mockClear();
    const disabled = await GET(
      new NextRequest(`https://app.repworth.test/api/operator/turns/${TURN}`),
      { params: Promise.resolve({ id: TURN }) },
    );
    expect(disabled.status).toBe(404);
    expect(mockRequireRole).not.toHaveBeenCalled();
  });
});
