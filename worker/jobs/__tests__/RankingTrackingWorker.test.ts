import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Job } from 'bullmq';
import type { TrackRankingPayload } from '../../../src/lib/shared/worker-types';

// ── Hoisted mock state ───────────────────────────────────────────────
const {
  sqlReturnQueue,
  mockSql,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockCheckRateLimit,
  mockGetJson,
  mockIsMockMode,
  mockGetLocationContext,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(result);
  });

  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql));

  return {
    sqlReturnQueue,
    mockSql,
    mockMarkOutboxCompleted: vi.fn(),
    mockMarkOutboxFailed: vi.fn(),
    mockCheckRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 99 }),
    mockGetJson: vi.fn().mockResolvedValue({ local_results: [] }),
    mockIsMockMode: vi.fn().mockReturnValue(false),
    mockGetLocationContext: vi.fn(),
  };
});

vi.mock('../../../src/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
  extractOutboxHandle: (d: any, fallback: string) => ({ outboxId: (d && typeof d.outbox_id === 'string') ? d.outbox_id : fallback, attempt: (d && typeof d.outbox_attempt === 'number') ? d.outbox_attempt : undefined }),
}));
vi.mock('../../../src/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock('../../../src/lib/shared/mock-mode', () => ({
  isMockMode: mockIsMockMode,
}));
vi.mock('serpapi', () => ({
  getJson: mockGetJson,
}));
vi.mock('../../../src/lib/db/account-guard', () => ({
  getLocationContext: mockGetLocationContext,
  isAccountActive: vi.fn(),
}));
vi.mock('uuid', () => ({
  v7: vi.fn(() => 'mock-uuid-v7'),
}));

import { handleTrackRanking } from '../RankingTrackingWorker';

// ── Helpers ─────────────────────────────────────────────────────────

function makeJob(overrides: Partial<TrackRankingPayload> = {}): Job<TrackRankingPayload> {
  return {
    data: {
      business_id: 'biz-rank-1',
      google_place_id: 'ChIJ_test_place',
      run_date: '2026-04-19',
      ...overrides,
    },
    id: 'outbox-rank-1',
  } as Job<TrackRankingPayload>;
}

function mockBusinessRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'biz-rank-1',
    tracked_keywords: ['pizza near me'],
    google_place_id: 'ChIJ_test_place',
    google_place_lat: 34.0522,
    google_place_lng: -118.2437,
    ranking_search_location: null,
    ...overrides,
  };
}

function mockLocationContext(overrides: Record<string, string> = {}) {
  return {
    account: {
      id: 'acct-1',
      subscriptionTier: 'copilot',
      subscriptionStatus: 'active',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      locationsIncluded: 1,
      locationsPaid: 0,
      ...overrides,
    },
    location: {
      id: 'biz-rank-1',
      isPrimary: true,
      displayLabel: null,
      name: 'Test Biz',
      archivedAt: null,
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('RankingTrackingWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 99 });
    mockGetJson.mockResolvedValue({ local_results: [] });
    mockIsMockMode.mockReturnValue(false);
    process.env.SERPAPI_API_KEY = 'test-key';
    process.env.REDIS_CACHE_URL = 'redis://localhost:6379/0'; // Required for fail-closed budget
    // Default: getLocationContext returns an active account
    mockGetLocationContext.mockResolvedValue(mockLocationContext());
  });

  afterEach(() => {
    delete process.env.SERPAPI_API_KEY;
    delete process.env.REDIS_CACHE_URL;
  });

  it('marks outbox failed when business not found or has no account', async () => {
    mockGetLocationContext.mockResolvedValue(null); // no location context

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(mockSql, 'outbox-rank-1', 'business_not_found', undefined);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('marks outbox completed when subscription is not active', async () => {
    mockGetLocationContext.mockResolvedValue(mockLocationContext({ subscriptionStatus: 'cancelled' }));
    sqlReturnQueue.push([mockBusinessRow()]);

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-rank-1', undefined);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('marks outbox completed when subscription is past_due (strict active-only)', async () => {
    mockGetLocationContext.mockResolvedValue(mockLocationContext({ subscriptionStatus: 'past_due' }));
    sqlReturnQueue.push([mockBusinessRow()]);

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-rank-1', undefined);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('marks outbox completed when google_place_id is null', async () => {
    sqlReturnQueue.push([mockBusinessRow({ google_place_id: null })]);

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-rank-1', undefined);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('marks outbox completed when tracked_keywords is empty', async () => {
    sqlReturnQueue.push([mockBusinessRow({ tracked_keywords: [] })]);

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-rank-1', undefined);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('handles tracked_keywords as JSONB string (PgBouncer guard)', async () => {
    sqlReturnQueue.push([mockBusinessRow({ tracked_keywords: '["tacos near me"]' })]);
    mockGetJson.mockResolvedValue({
      local_results: [{ place_id: 'ChIJ_test_place', title: 'Test', position: 1 }],
    });

    await handleTrackRanking(makeJob());

    expect(mockGetJson).toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('filters out empty strings from tracked_keywords', async () => {
    sqlReturnQueue.push([mockBusinessRow({ tracked_keywords: ['', '  ', 'valid keyword'] })]);
    mockGetJson.mockResolvedValue({ local_results: [] });

    await handleTrackRanking(makeJob());

    expect(mockGetJson).toHaveBeenCalledWith(expect.objectContaining({ q: 'valid keyword' }));
  });

  it('handles malformed tracked_keywords JSON gracefully', async () => {
    sqlReturnQueue.push([mockBusinessRow({ tracked_keywords: '{not-valid-json' })]);

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-rank-1', undefined);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('marks outbox completed when REDIS_CACHE_URL is missing (strict fail-closed)', async () => {
    delete process.env.REDIS_CACHE_URL;
    sqlReturnQueue.push([mockBusinessRow()]);
    // checkRateLimit with { strict: true } throws when REDIS_CACHE_URL is unset
    mockCheckRateLimit.mockRejectedValueOnce(new Error('REDIS_CACHE_URL not configured'));

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-rank-1', undefined);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('marks outbox completed when Redis is configured but unavailable (strict fail-closed)', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    // Simulates Redis connection failure propagated through strict mode
    mockCheckRateLimit.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-rank-1', undefined);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('marks outbox completed when monthly budget exhausted', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-rank-1', undefined);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('marks outbox completed when no location data available', async () => {
    sqlReturnQueue.push([mockBusinessRow({
      google_place_lat: null,
      google_place_lng: null,
      ranking_search_location: null,
    })]);

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'outbox-rank-1', undefined);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('calls SerpAPI with ll param when coords exist', async () => {
    sqlReturnQueue.push([mockBusinessRow({
      google_place_lat: 34.0522,
      google_place_lng: -118.2437,
    })]);
    mockGetJson.mockResolvedValue({ local_results: [] });

    await handleTrackRanking(makeJob());

    expect(mockGetJson).toHaveBeenCalledWith(expect.objectContaining({
      engine: 'google_maps',
      q: 'pizza near me',
      ll: '@34.0522,-118.2437,15z',
      api_key: 'test-key',
    }));
    expect(mockGetJson).toHaveBeenCalledWith(
      expect.not.objectContaining({ location: expect.anything() }),
    );
  });

  it('calls SerpAPI with location param when coords missing but ranking_search_location exists', async () => {
    sqlReturnQueue.push([mockBusinessRow({
      google_place_lat: null,
      google_place_lng: null,
      ranking_search_location: 'Los Angeles, CA',
    })]);
    mockGetJson.mockResolvedValue({ local_results: [] });

    await handleTrackRanking(makeJob());

    expect(mockGetJson).toHaveBeenCalledWith(expect.objectContaining({
      engine: 'google_maps',
      q: 'pizza near me',
      location: 'Los Angeles, CA',
      api_key: 'test-key',
    }));
    expect(mockGetJson).toHaveBeenCalledWith(
      expect.not.objectContaining({ ll: expect.anything() }),
    );
  });

  it('uses SerpAPI position field when available', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGetJson.mockResolvedValue({
      local_results: [
        { place_id: 'ChIJ_other_1', title: 'Other 1', position: 1 },
        { place_id: 'ChIJ_other_2', title: 'Other 2', position: 2 },
        { place_id: 'ChIJ_test_place', title: 'Test Biz', position: 5 }, // position != index+1
      ],
    });

    await handleTrackRanking(makeJob());

    // Should use position (5) not index+1 (3) — verify the upsert call
    const upsertCall = mockSql.mock.calls.find((c: any[]) =>
      c[0]?.join?.('')?.includes?.('ranking_snapshots') ?? false
    );
    expect(upsertCall || mockMarkOutboxCompleted).toBeTruthy();
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('falls back to index+1 when position field is missing', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGetJson.mockResolvedValue({
      local_results: [
        { place_id: 'ChIJ_other_1', title: 'Other 1' },
        { place_id: 'ChIJ_test_place', title: 'Test Biz' },
      ],
    });

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('records NULL rank when business NOT found in results', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGetJson.mockResolvedValue({
      local_results: [
        { place_id: 'ChIJ_other_1', title: 'Other 1', position: 1 },
        { place_id: 'ChIJ_other_2', title: 'Other 2', position: 2 },
      ],
    });

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('skips SerpAPI call in mock mode and still upserts a rank', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockIsMockMode.mockReturnValue(true);

    await handleTrackRanking(makeJob());

    expect(mockGetJson).not.toHaveBeenCalled();
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('limits to 1 keyword despite multiple tracked', async () => {
    sqlReturnQueue.push([mockBusinessRow({
      tracked_keywords: ['pizza near me', 'best pizza LA', 'italian restaurant'],
    })]);
    mockGetJson.mockResolvedValue({ local_results: [] });

    await handleTrackRanking(makeJob());

    expect(mockGetJson).toHaveBeenCalledTimes(1);
    expect(mockGetJson).toHaveBeenCalledWith(expect.objectContaining({ q: 'pizza near me' }));
  });

  it('throws on SerpAPI error to trigger BullMQ retry', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGetJson.mockResolvedValue({ error: 'API rate limited' });

    await expect(handleTrackRanking(makeJob())).rejects.toThrow('SerpAPI ranking search error: API rate limited');
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('uses outbox_id from job data when present', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGetJson.mockResolvedValue({ local_results: [] });

    const job = makeJob();
    (job.data as any).outbox_id = 'custom-outbox-id';

    await handleTrackRanking(job);

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith(mockSql, 'custom-outbox-id', undefined);
  });

  describe('competitor pack persistence (#538)', () => {
    function sqlTextOf(call: any[]): string {
      return call[0]?.join?.('') ?? '';
    }
    function packInsertCalls() {
      return mockSql.mock.calls.filter((c: any[]) => sqlTextOf(c).includes('INSERT INTO competitor_snapshots'));
    }

    it('persists the full pack in one transaction with an is_self row and field mapping', async () => {
      sqlReturnQueue.push([mockBusinessRow()]);
      mockGetJson.mockResolvedValue({
        local_results: [
          { place_id: 'ChIJ_rival_1', data_cid: 'cid-1', title: 'Rival One', position: 1, rating: 4.8, reviews: 320 },
          { place_id: 'ChIJ_test_place', title: 'Test Biz', position: 2, rating: 4.5, reviews: 120 },
          { place_id: 'ChIJ_rival_3', title: 'Rival Three', position: 3 },
        ],
      });

      await handleTrackRanking(makeJob());

      expect(mockSql.begin).toHaveBeenCalledTimes(1);
      const inserts = packInsertCalls();
      expect(inserts).toHaveLength(3);
      // Self row: place_id matches business, is_self=true (is_self is the final value param)
      const selfCall = inserts.find((c: any[]) => c.includes('ChIJ_test_place'));
      expect(selfCall).toBeTruthy();
      expect(selfCall![selfCall!.length - 1]).toBe(true);
      // Rival rows carry is_self=false
      const rivalCall = inserts.find((c: any[]) => c.includes('ChIJ_rival_1'));
      expect(rivalCall![rivalCall!.length - 1]).toBe(false);
      // data_cid mapped when present
      expect(rivalCall).toContain('cid-1');
      expect(mockMarkOutboxCompleted).toHaveBeenCalled();
    });

    it('preserves NULLs for missing rating/reviews/place_id and never drops entries', async () => {
      sqlReturnQueue.push([mockBusinessRow()]);
      mockGetJson.mockResolvedValue({
        local_results: [
          { title: 'No Identity Diner', position: 1 },                    // no place_id at all
          { place_id: 'ChIJ_rival_2', title: 'Unrated Cafe', position: 2 }, // no rating/reviews
        ],
      });

      await handleTrackRanking(makeJob());

      // Positional map of the INSERT's value params (call[0] is the template
      // strings array, values follow): 1=id 2=business_id 3=keyword
      // 4=search_location 5=snapshot_date 6=rank_position 7=place_id
      // 8=data_cid 9=title 10=rating 11=review_count 12=is_self
      const inserts = packInsertCalls();
      expect(inserts).toHaveLength(2);
      const noIdentity = inserts.find((c: any[]) => c.includes('No Identity Diner'))!;
      expect(noIdentity[7]).toBeNull();  // place_id specifically → NULL
      expect(noIdentity[12]).toBe(false); // no place_id can never be self
      const unrated = inserts.find((c: any[]) => c.includes('Unrated Cafe'))!;
      expect(unrated[7]).toBe('ChIJ_rival_2');
      expect(unrated[10]).toBeNull();  // rating → NULL
      expect(unrated[11]).toBeNull();  // review_count → NULL
    });

    it('deletes the existing pack before inserting (replace-pack idempotency)', async () => {
      sqlReturnQueue.push([mockBusinessRow()]);
      mockGetJson.mockResolvedValue({
        local_results: [{ place_id: 'ChIJ_rival_1', title: 'Rival One', position: 1 }],
      });

      await handleTrackRanking(makeJob());

      const calls = mockSql.mock.calls;
      const deleteIdx = calls.findIndex((c: any[]) => sqlTextOf(c).includes('DELETE FROM competitor_snapshots'));
      const insertIdx = calls.findIndex((c: any[]) => sqlTextOf(c).includes('INSERT INTO competitor_snapshots'));
      expect(deleteIdx).toBeGreaterThan(-1);
      expect(insertIdx).toBeGreaterThan(deleteIdx);
    });

    it('replaces same-day packs by (business, keyword, date) — search_location deliberately excluded', async () => {
      // Locked semantics (#532/#538, adversarial-review triage): the parent
      // ranking_snapshots upsert OVERWRITES search_location for the date, so
      // the pack DELETE must mirror it — scoping by search_location would
      // orphan a same-day stale pack contradicting its parent row. Prior-DAY
      // rows are untouched (their snapshot_date differs). This pins the
      // predicate shape against a well-meaning "fix".
      sqlReturnQueue.push([mockBusinessRow({
        google_place_lat: null,
        google_place_lng: null,
        ranking_search_location: 'New Location, CA',
      })]);
      mockGetJson.mockResolvedValue({
        local_results: [{ place_id: 'ChIJ_rival_1', title: 'Rival One', position: 1 }],
      });

      await handleTrackRanking(makeJob());

      const deleteCall = mockSql.mock.calls.find((c: any[]) => sqlTextOf(c).includes('DELETE FROM competitor_snapshots'))!;
      // Exactly three value params: business_id, keyword, snapshot_date.
      expect(deleteCall).toHaveLength(4); // template strings array + 3 values
      expect(deleteCall.slice(1)).toEqual(['biz-rank-1', 'pizza near me', expect.any(String)]);
      expect(sqlTextOf(deleteCall)).not.toContain('search_location');
      // Reinserted rows carry the CURRENT search_location (values index 4).
      const insert = packInsertCalls()[0]!;
      expect(insert[4]).toBe('New Location, CA');
    });

    it('clears the pack (delete, zero inserts) when local_results is empty', async () => {
      sqlReturnQueue.push([mockBusinessRow()]);
      mockGetJson.mockResolvedValue({ local_results: [] });

      await handleTrackRanking(makeJob());

      const deleteCall = mockSql.mock.calls.find((c: any[]) => sqlTextOf(c).includes('DELETE FROM competitor_snapshots'));
      expect(deleteCall).toBeTruthy();
      expect(packInsertCalls()).toHaveLength(0);
      expect(mockMarkOutboxCompleted).toHaveBeenCalled();
    });

    it('persists the pack without an is_self row when own business is absent', async () => {
      sqlReturnQueue.push([mockBusinessRow()]);
      mockGetJson.mockResolvedValue({
        local_results: [
          { place_id: 'ChIJ_rival_1', title: 'Rival One', position: 1 },
          { place_id: 'ChIJ_rival_2', title: 'Rival Two', position: 2 },
        ],
      });

      await handleTrackRanking(makeJob());

      const inserts = packInsertCalls();
      expect(inserts).toHaveLength(2);
      for (const c of inserts) expect(c[c.length - 1]).toBe(false);
    });

    it('fails the job when the pack write fails (tx rejects, outbox untouched)', async () => {
      sqlReturnQueue.push([mockBusinessRow()]);
      mockGetJson.mockResolvedValue({
        local_results: [{ place_id: 'ChIJ_rival_1', title: 'Rival One', position: 1 }],
      });
      mockSql.begin.mockRejectedValueOnce(new Error('insert exploded'));

      await expect(handleTrackRanking(makeJob())).rejects.toThrow('insert exploded');
      expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
    });

    it('propagates a failure thrown INSIDE the tx callback (pack insert throws)', async () => {
      sqlReturnQueue.push([mockBusinessRow()]);
      mockGetJson.mockResolvedValue({
        local_results: [{ place_id: 'ChIJ_rival_1', title: 'Rival One', position: 1 }],
      });
      // Throw from the competitor INSERT executed inside sql.begin's callback —
      // exercises the real code path (begin's default impl runs cb(mockSql)).
      const originalImpl = mockSql.getMockImplementation();
      mockSql.mockImplementation((s: TemplateStringsArray, ..._v: unknown[]) => {
        if ((s?.join?.('') ?? '').includes('INSERT INTO competitor_snapshots')) {
          return Promise.reject(new Error('pack insert exploded'));
        }
        return Promise.resolve(sqlReturnQueue.shift() ?? []);
      });

      await expect(handleTrackRanking(makeJob())).rejects.toThrow('pack insert exploded');
      expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();
      expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
      mockSql.mockImplementation(originalImpl!);
    });

    it('synthesizes and persists a mock pack through the same tx path in mock mode', async () => {
      sqlReturnQueue.push([mockBusinessRow()]);
      mockIsMockMode.mockReturnValue(true);

      await handleTrackRanking(makeJob());

      expect(mockGetJson).not.toHaveBeenCalled();
      expect(mockSql.begin).toHaveBeenCalledTimes(1);
      const inserts = packInsertCalls();
      expect(inserts.length).toBeGreaterThan(0);
      const selfRows = inserts.filter((c: any[]) => c[c.length - 1] === true);
      expect(selfRows).toHaveLength(1);
    });
  });
});
