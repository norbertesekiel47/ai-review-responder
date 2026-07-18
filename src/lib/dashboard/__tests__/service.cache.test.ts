import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  createMockSql,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';

// The per-location payload is now wrapped in a 45s fail-open Upstash read cache
// (#478), mirroring the aggregate-service block. Hoisted get/set mocks let each
// test drive HIT/MISS/throw and assert on the key + TTL the wrapper writes.
// NOTE: getCacheRedis().get is ALSO called by readPendingMarker inside the
// compute, so `getMock` fires twice on a MISS (payload read + pending marker);
// assertions therefore key off `setMock`, which only the payload cache writes.
const { getMock, setMock } = vi.hoisted(() => ({
  getMock: vi.fn<(key: string) => Promise<string | null>>(async () => null),
  setMock: vi.fn<(key: string, value: string, mode: 'EX', ttl: number) => Promise<string>>(
    async () => 'OK',
  ),
}));
vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ get: getMock, set: setMock }),
}));

import { getActiveDashboardData, BusinessNotFoundError } from '../service';

let harness: MockSqlHarness;
let mockSql: Sql;

const BUSINESS_ID = 'biz-cache-1';

// getActiveDashboardData main Promise.all sql call order (no reputation flag):
// 0 business, 1 totalReviews, 2 totalResponded, 3 velocity, 4 ranking,
// 5 recentReviews, 6 monthlyBrief, 7 weeklyBrief, 8 zernioConn,
// 9 queuedReconnect, 10 unresolvedIncident, 11 ratingBreakdown.
function seedDashboardQueries(overrides?: {
  business?: unknown[];
  recentReviews?: unknown[];
}) {
  harness.resetMockSql();
  harness.sqlReturnQueue.push(
    overrides?.business ?? [{ name: 'Biz', created_at: new Date('2026-01-01T00:00:00Z') }],
    [{ count: 0 }],
    [{ count: 0 }],
    [],
    [],
    overrides?.recentReviews ?? [],
    [],
    [],
    [],
    [],
    [],
    [],
  );
}

describe('getActiveDashboardData — read cache (#478)', () => {
  beforeEach(() => {
    harness = createMockSql();
    mockSql = harness.mockSql as unknown as Sql;
    getMock.mockReset();
    getMock.mockResolvedValue(null);
    setMock.mockReset();
    setMock.mockResolvedValue('OK');
  });

  it('HIT: returns the cached payload and issues ZERO SQL', async () => {
    const payload = { scope: 'active', valueSummary: { totalReviewsHandled: 7 } };
    getMock.mockResolvedValue(JSON.stringify(payload));

    const result = await getActiveDashboardData(mockSql, BUSINESS_ID);

    expect(result).toEqual(payload);
    expect(harness.sqlCalls).toHaveLength(0);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('MISS: computes then writes the payload with the expected key and 45s TTL', async () => {
    seedDashboardQueries();

    await getActiveDashboardData(mockSql, BUSINESS_ID);

    expect(harness.sqlCalls.length).toBeGreaterThan(0);
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith(
      `dashboard:location:${BUSINESS_ID}:30d:norep`,
      expect.any(String),
      'EX',
      45,
    );
  });

  it('GET throws: fails open to a fresh compute and still writes', async () => {
    getMock.mockRejectedValue(new Error('redis get down'));
    seedDashboardQueries();

    const result = await getActiveDashboardData(mockSql, BUSINESS_ID);

    expect(result).toBeDefined();
    expect(harness.sqlCalls.length).toBeGreaterThan(0);
    expect(setMock).toHaveBeenCalledTimes(1);
  });

  it('SET throws: still returns the fresh computed payload', async () => {
    setMock.mockRejectedValue(new Error('redis set down'));
    seedDashboardQueries();

    const result = await getActiveDashboardData(mockSql, BUSINESS_ID);

    expect(result).toBeDefined();
    expect(result.valueSummary).toBeDefined();
  });

  it('key varies by window', async () => {
    seedDashboardQueries();
    await getActiveDashboardData(mockSql, BUSINESS_ID, { window: '7d' });
    expect(setMock.mock.calls[0]?.[0]).toBe(`dashboard:location:${BUSINESS_ID}:7d:norep`);

    setMock.mockClear();
    seedDashboardQueries();
    await getActiveDashboardData(mockSql, BUSINESS_ID, { window: '90d' });
    expect(setMock.mock.calls[0]?.[0]).toBe(`dashboard:location:${BUSINESS_ID}:90d:norep`);
  });

  it('key varies by includeReputationMetrics (rep vs norep) — but never by opts.business', async () => {
    // The reputation branch fires its own inner Promise.all, so pass a
    // pre-fetched `business` row to skip the business query and keep the compute
    // independent of queue-order alignment. `business` must NOT enter the key —
    // both sub-cases pass it, yet only the rep flag flips the suffix.
    const business = { name: 'Biz', created_at: new Date('2026-01-01T00:00:00Z') } as never;

    seedDashboardQueries();
    await getActiveDashboardData(mockSql, BUSINESS_ID, {
      business,
      includeReputationMetrics: true,
    });
    expect(setMock.mock.calls[0]?.[0]).toBe(`dashboard:location:${BUSINESS_ID}:30d:rep`);

    setMock.mockClear();
    seedDashboardQueries();
    await getActiveDashboardData(mockSql, BUSINESS_ID, {
      business,
      includeReputationMetrics: false,
    });
    expect(setMock.mock.calls[0]?.[0]).toBe(`dashboard:location:${BUSINESS_ID}:30d:norep`);
  });

  it('BusinessNotFoundError: never caches the 404 signal', async () => {
    seedDashboardQueries({ business: [] });

    await expect(getActiveDashboardData(mockSql, BUSINESS_ID)).rejects.toBeInstanceOf(
      BusinessNotFoundError,
    );
    expect(setMock).not.toHaveBeenCalled();
  });

  it('JSON round-trip fidelity: store-then-read yields a byte-identical serialization', async () => {
    // A Date-valued field (autoPostScheduledAt passes through raw) is the exact
    // case a naive cache could mutate: it serializes to an ISO string on store
    // and reads back as that string, so re-stringifying both must match.
    seedDashboardQueries({
      recentReviews: [
        {
          id: 'rev-1',
          reviewer_name: 'Reviewer',
          star_rating: 5,
          review_text: 'great',
          review_date: '2026-06-01',
          status: 'pending_approval',
          response_text: 'draft',
          response_status: 'pending_approval',
          approval_method: null,
          auto_post_scheduled_at: new Date('2026-07-13T18:00:00.000Z'),
          escalation_id: null,
        },
      ],
    });

    const freshResult = await getActiveDashboardData(mockSql, BUSINESS_ID);
    const stored = setMock.mock.calls[0]?.[1] as string;

    // Simulate the subsequent HIT: the wrapper reads `stored` and JSON.parses it.
    getMock.mockResolvedValue(stored);
    harness.resetMockSql();
    const cachedReadResult = await getActiveDashboardData(mockSql, BUSINESS_ID);

    expect(harness.sqlCalls).toHaveLength(0);
    expect(JSON.stringify(cachedReadResult)).toBe(JSON.stringify(freshResult));
  });
});
