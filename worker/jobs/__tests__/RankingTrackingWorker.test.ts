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
    subscription_status: 'active',
    updated_at: new Date(),
    tracked_keywords: ['pizza near me'],
    google_place_id: 'ChIJ_test_place',
    google_place_lat: 34.0522,
    google_place_lng: -118.2437,
    ranking_search_location: null,
    ...overrides,
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
  });

  afterEach(() => {
    delete process.env.SERPAPI_API_KEY;
    delete process.env.REDIS_CACHE_URL;
  });

  it('marks outbox failed when business not found', async () => {
    sqlReturnQueue.push([]); // business query returns empty

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-rank-1', 'business_not_found', undefined);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('marks outbox completed when subscription is not active', async () => {
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'cancelled' })]);

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-rank-1', undefined);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('marks outbox completed when subscription is past_due (strict active-only)', async () => {
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'past_due' })]);

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-rank-1', undefined);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('marks outbox completed when google_place_id is null', async () => {
    sqlReturnQueue.push([mockBusinessRow({ google_place_id: null })]);

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-rank-1', undefined);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('marks outbox completed when tracked_keywords is empty', async () => {
    sqlReturnQueue.push([mockBusinessRow({ tracked_keywords: [] })]);

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-rank-1', undefined);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('handles tracked_keywords as JSONB string (PgBouncer guard)', async () => {
    sqlReturnQueue.push([mockBusinessRow({ tracked_keywords: '["tacos near me"]' })]);
    mockGetJson.mockResolvedValue({
      local_results: [{ place_id: 'ChIJ_test_place', title: 'Test', position: 1 }],
    });

    await handleTrackRanking(makeJob());

    expect(mockGetJson).toHaveBeenCalled();
    expect(mockSql).toHaveBeenCalledTimes(2);
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

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-rank-1', undefined);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('marks outbox completed when REDIS_CACHE_URL is missing (strict fail-closed)', async () => {
    delete process.env.REDIS_CACHE_URL;
    sqlReturnQueue.push([mockBusinessRow()]);
    // checkRateLimit with { strict: true } throws when REDIS_CACHE_URL is unset
    mockCheckRateLimit.mockRejectedValueOnce(new Error('REDIS_CACHE_URL not configured'));

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-rank-1', undefined);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('marks outbox completed when Redis is configured but unavailable (strict fail-closed)', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    // Simulates Redis connection failure propagated through strict mode
    mockCheckRateLimit.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-rank-1', undefined);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('marks outbox completed when monthly budget exhausted', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-rank-1', undefined);
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('marks outbox completed when no location data available', async () => {
    sqlReturnQueue.push([mockBusinessRow({
      google_place_lat: null,
      google_place_lng: null,
      ranking_search_location: null,
    })]);

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-rank-1', undefined);
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

    // Should use position (5) not index+1 (3)
    const upsertCall = mockSql.mock.calls[1];
    const rankPosition = upsertCall[4];
    expect(rankPosition).toBe(5);
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

    const upsertCall = mockSql.mock.calls[1];
    const rankPosition = upsertCall[4];
    expect(rankPosition).toBe(2); // index 1 + 1
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

    const upsertCall = mockSql.mock.calls[1];
    const rankPosition = upsertCall[4];
    expect(rankPosition).toBeNull();
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('skips SerpAPI call in mock mode and still upserts a rank', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockIsMockMode.mockReturnValue(true);

    await handleTrackRanking(makeJob());

    expect(mockGetJson).not.toHaveBeenCalled();
    expect(mockSql).toHaveBeenCalledTimes(2);
    const upsertCall = mockSql.mock.calls[1];
    const rankPosition = upsertCall[4];
    expect(rankPosition).toBeGreaterThanOrEqual(1);
    expect(rankPosition).toBeLessThanOrEqual(10);
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
    expect(mockSql).toHaveBeenCalledTimes(2);
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

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('custom-outbox-id', undefined);
  });
});
