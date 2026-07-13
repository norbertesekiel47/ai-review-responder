import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

const { mockRequireDashboardReviewOwner, mockGetReviewTimeline } = vi.hoisted(() => ({
  mockRequireDashboardReviewOwner: vi.fn(),
  mockGetReviewTimeline: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  sql: vi.fn(),
}));

vi.mock('@/lib/approval/http-routes', () => ({
  requireDashboardReviewOwner: (...args: unknown[]) => mockRequireDashboardReviewOwner(...args),
}));

vi.mock('@/lib/agents/read', () => ({
  getReviewTimeline: (...args: unknown[]) => mockGetReviewTimeline(...args),
}));

import { GET } from '../route';

const REVIEW_ID = '01234567-0000-0000-0000-000000000001';
const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001';

function request(): NextRequest {
  return new NextRequest(`http://localhost:3000/api/dashboard/reviews/${REVIEW_ID}/timeline`);
}

function context(reviewId = REVIEW_ID): { params: Promise<{ reviewId: string }> } {
  return { params: Promise.resolve({ reviewId }) };
}

describe('GET /api/dashboard/reviews/[reviewId]/timeline', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the canonical 401 auth response without reading the timeline', async () => {
    const authResponse = NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: NO_STORE_HEADERS },
    );
    mockRequireDashboardReviewOwner.mockResolvedValue(authResponse);

    const response = await GET(request(), context());

    expect(response).toBe(authResponse);
    expect(mockGetReviewTimeline).not.toHaveBeenCalled();
  });

  it('returns the canonical 403 response when the owner has no account', async () => {
    const authResponse = NextResponse.json(
      { error: 'No account associated with this user' },
      { status: 403, headers: NO_STORE_HEADERS },
    );
    mockRequireDashboardReviewOwner.mockResolvedValue(authResponse);

    const response = await GET(request(), context());

    expect(response).toBe(authResponse);
    expect(mockGetReviewTimeline).not.toHaveBeenCalled();
  });

  it('rejects an invalid review UUID before auth or data access', async () => {
    const response = await GET(request(), context('not-a-uuid'));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid review ID' });
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockRequireDashboardReviewOwner).not.toHaveBeenCalled();
    expect(mockGetReviewTimeline).not.toHaveBeenCalled();
  });

  it.each(['unknown review', 'out-of-scope review'])(
    'returns 404 when the timeline read reports an %s',
    async () => {
      mockRequireDashboardReviewOwner.mockResolvedValue({
        id: 'user-1',
        accountId: ACCOUNT_ID,
      });
      mockGetReviewTimeline.mockResolvedValue(null);

      const response = await GET(request(), context());

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'Review not found' });
      expect(response.headers.get('Cache-Control')).toBe('no-store, private');
      expect(mockGetReviewTimeline).toHaveBeenCalledOnce();
      expect(mockGetReviewTimeline).toHaveBeenCalledWith(expect.any(Function), {
        accountId: ACCOUNT_ID,
        reviewId: REVIEW_ID,
      });
    },
  );

  it('returns the timeline contract unchanged with private no-store caching', async () => {
    const timeline = {
      review: {
        id: REVIEW_ID,
        rating: 5,
        reviewerName: 'Jamie',
        submittedAt: '2026-07-12T15:00:00.000Z',
        status: 'processed',
      },
      response: {
        id: '11234567-0000-0000-0000-000000000001',
        status: 'pending_approval',
        approvalMethod: null,
        autoPostScheduledAt: '2026-07-12T15:10:00.000Z',
        postedAt: null,
        responseText: 'Thank you for visiting.',
        version: 1,
      },
      escalation: {
        id: '21234567-0000-0000-0000-000000000001',
        status: 'open',
        severity: 'medium',
        suggestedAction: 'Contact the customer',
        createdAt: '2026-07-12T15:02:00.000Z',
        acknowledgedAt: null,
        resolvedAt: null,
      },
      runs: [
        {
          id: '31234567-0000-0000-0000-000000000001',
          status: 'running',
          startedAt: '2026-07-12T15:01:00.000Z',
          endedAt: null,
          error: null,
          displayState: 'waiting_on_owner',
          steps: [
            {
              stepIndex: 1,
              stepKey: 'draft_generated',
              attributedAgent: 'reply',
              status: 'completed',
              detail: { response_id: '11234567-0000-0000-0000-000000000001' },
              latencyMs: 125,
              createdAt: '2026-07-12T15:01:01.000Z',
            },
          ],
          outcomes: [
            {
              outcomeKind: 'reply_drafted',
              attributedAgent: 'reply',
              occurredAt: '2026-07-12T15:01:01.000Z',
            },
          ],
        },
      ],
    };
    mockRequireDashboardReviewOwner.mockResolvedValue({
      id: 'user-1',
      accountId: ACCOUNT_ID,
    });
    mockGetReviewTimeline.mockResolvedValue(timeline);

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(timeline);
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    expect(mockGetReviewTimeline).toHaveBeenCalledWith(expect.any(Function), {
      accountId: ACCOUNT_ID,
      reviewId: REVIEW_ID,
    });
  });
});
