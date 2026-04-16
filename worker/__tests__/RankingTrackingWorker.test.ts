import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { TrackRankingPayload } from '../../src/lib/shared/worker-types';

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

vi.mock('../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));
vi.mock('../../src/lib/shared/subscription-guard', () => ({
  checkSubscription: vi.fn().mockReturnValue({ allowed: true }),
}));
vi.mock('../../src/lib/shared/rate-limit', () => ({
  checkRateLimit: mockCheckRateLimit,
}));
vi.mock('../../src/lib/shared/mock-mode', () => ({
  isMockMode: mockIsMockMode,
}));
vi.mock('serpapi', () => ({
  getJson: mockGetJson,
}));
vi.mock('uuid', () => ({
  v7: vi.fn(() => 'mock-uuid-v7'),
}));

import { handleTrackRanking } from '../jobs/RankingTrackingWorker';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';

// ── Helpers ─────────────────────────────────────────────────────────

function makeJob(overrides: Partial<TrackRankingPayload> = {}): Job<TrackRankingPayload> {
  return {
    data: {
      business_id: 'biz-rank-1',
      google_place_id: 'ChIJ_test_place',
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
    (checkSubscription as ReturnType<typeof vi.fn>).mockReturnValue({ allowed: true });
    process.env.SERPAPI_API_KEY = 'test-key';
  });

  it('marks outbox failed when business not found', async () => {
    sqlReturnQueue.push([]); // business query returns empty

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxFailed).toHaveBeenCalledWith('outbox-rank-1', 'business_not_found');
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('marks outbox completed when subscription is cancelled', async () => {
    sqlReturnQueue.push([mockBusinessRow({ subscription_status: 'cancelled' })]);
    (checkSubscription as ReturnType<typeof vi.fn>).mockReturnValue({
      allowed: false,
      reason: 'cancelled',
    });

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-rank-1');
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('marks outbox completed when tracked_keywords is empty', async () => {
    sqlReturnQueue.push([mockBusinessRow({ tracked_keywords: [] })]);

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-rank-1');
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('handles tracked_keywords as JSONB string (PgBouncer guard)', async () => {
    sqlReturnQueue.push([mockBusinessRow({ tracked_keywords: '["tacos near me"]' })]);
    mockGetJson.mockResolvedValue({
      local_results: [{ place_id: 'ChIJ_test_place', title: 'Test', position: 1 }],
    });

    await handleTrackRanking(makeJob());

    expect(mockGetJson).toHaveBeenCalled();
    // Verify upsert was called (second sql call)
    expect(mockSql).toHaveBeenCalledTimes(2);
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('marks outbox completed when monthly budget exhausted', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockCheckRateLimit.mockResolvedValue({ allowed: false, remaining: 0 });

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-rank-1');
    expect(mockGetJson).not.toHaveBeenCalled();
  });

  it('marks outbox completed when no location data available', async () => {
    sqlReturnQueue.push([mockBusinessRow({
      google_place_lat: null,
      google_place_lng: null,
      ranking_search_location: null,
    })]);

    await handleTrackRanking(makeJob());

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-rank-1');
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

  it('records rank when business found in results (index + 1)', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockGetJson.mockResolvedValue({
      local_results: [
        { place_id: 'ChIJ_other_1', title: 'Other 1', position: 1 },
        { place_id: 'ChIJ_other_2', title: 'Other 2', position: 2 },
        { place_id: 'ChIJ_test_place', title: 'Test Biz', position: 3 },
      ],
    });

    await handleTrackRanking(makeJob());

    // Second sql call is the upsert — tagged template: sql`...${id}, ${biz}, ${kw}, ${rank}, ...`
    // mockSql.mock.calls[1] = [templateStrings, id, business_id, keyword, rank_position, ...]
    const upsertCall = mockSql.mock.calls[1];
    const rankPosition = upsertCall[4]; // 4th interpolated value (index 4 in call args)
    expect(rankPosition).toBe(3);
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

    const upsertCall = mockSql.mock.calls[1];
    const rankPosition = upsertCall[4]; // 4th interpolated value
    expect(rankPosition).toBeNull();
    expect(mockMarkOutboxCompleted).toHaveBeenCalled();
  });

  it('skips SerpAPI call in mock mode and still upserts a rank', async () => {
    sqlReturnQueue.push([mockBusinessRow()]);
    mockIsMockMode.mockReturnValue(true);

    await handleTrackRanking(makeJob());

    expect(mockGetJson).not.toHaveBeenCalled();
    // Should still upsert (second sql call)
    expect(mockSql).toHaveBeenCalledTimes(2);
    const upsertCall = mockSql.mock.calls[1];
    const rankPosition = upsertCall[4]; // 4th interpolated value
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

    // Only 1 SerpAPI call despite 3 keywords
    expect(mockGetJson).toHaveBeenCalledTimes(1);
    expect(mockGetJson).toHaveBeenCalledWith(expect.objectContaining({ q: 'pizza near me' }));
    // business query + 1 upsert = 2 sql calls
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

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('custom-outbox-id');
  });
});
