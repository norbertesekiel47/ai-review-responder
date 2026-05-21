# Sprint 5B Prompt 19b — Automated Ranking Tracking

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add feature-flagged automated Google Maps ranking tracking via SerpAPI, with admin UI for keyword management and manual rank entry.

**Architecture:** A `RankingTrackingScheduler` (setInterval poller, biweekly on even-week Sundays at 22:00 UTC) queries eligible businesses and creates `track_ranking` outbox entries. A `RankingTrackingWorker` processes each entry by calling SerpAPI `engine=google_maps`, matching the business by `place_id`, and upserting into `ranking_snapshots`. The admin business detail page gets two new sections: keyword management (editable list) and manual rank entry (form). Feature-flagged via `RANKING_TRACKING_ENABLED` env var (disabled by default). Monthly SerpAPI budget cap via Redis rate limiter. Mock mode generates random ranks 1-10.

**Tech Stack:** SerpAPI (`getJson` from `serpapi`), BullMQ, Postgres (via `sql` from `@/lib/db/server`), Redis rate limiter, Vitest, Zod.

**Pre-requisite:** Migration `014_retention_expansion.sql` must be applied. It adds `tracked_keywords`, `google_place_address`, `google_place_lat`, `google_place_lng`, `ranking_search_location` columns to `businesses`, and `uniq_ranking_snapshots_business_keyword_date` unique index on `ranking_snapshots`.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/lib/shared/worker-types.ts` (modify) | Add `TrackRankingPayload` |
| Create | `worker/jobs/RankingTrackingScheduler.ts` | Biweekly poller, creates outbox entries |
| Create | `worker/jobs/RankingTrackingWorker.ts` | SerpAPI ranking search + upsert |
| Modify | `worker/queues.ts` | Add `TRACK_RANKING` queue name + queue instance |
| Modify | `worker/index.ts` | Register worker + scheduler |
| Create | `src/app/api/admin/businesses/[id]/keywords/route.ts` | PUT — update tracked_keywords |
| Create | `src/app/api/admin/businesses/[id]/ranking/route.ts` | POST — manual rank entry |
| Modify | `src/app/api/admin/businesses/[id]/route.ts` | Return `trackedKeywords`, ranking location fields in GET |
| Modify | `src/app/admin/businesses/[id]/page.tsx` | Add Tracked Keywords + Ranking sections |
| Create | `worker/jobs/__tests__/RankingTrackingScheduler.test.ts` | Scheduler tests |
| Create | `worker/jobs/__tests__/RankingTrackingWorker.test.ts` | Worker tests |
| Create | `src/app/api/admin/businesses/[id]/keywords/__tests__/route.test.ts` | Keywords API tests |
| Create | `src/app/api/admin/businesses/[id]/ranking/__tests__/route.test.ts` | Ranking API tests |

---

## Task 1: Add TrackRankingPayload type

**Files:**
- Modify: `src/lib/shared/worker-types.ts`

- [ ] **Step 1: Add the payload interface**

Add at the end of `src/lib/shared/worker-types.ts`:

```typescript
export interface TrackRankingPayload {
  business_id: string;
  google_place_id: string;
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/shared/worker-types.ts
git commit -m "feat(19b): add TrackRankingPayload type"
```

---

## Task 2: Register track_ranking queue

**Files:**
- Modify: `worker/queues.ts`

- [ ] **Step 1: Add TRACK_RANKING to QUEUE_NAMES**

In `worker/queues.ts`, add to the `QUEUE_NAMES` object:

```typescript
TRACK_RANKING: 'track_ranking',
```

- [ ] **Step 2: Add queue instance**

In the `queues` object:

```typescript
trackRanking: new Queue(QUEUE_NAMES.TRACK_RANKING, { connection: opts, defaultJobOptions }),
```

- [ ] **Step 3: Add topicToQueue entry**

In the `topicToQueue` record:

```typescript
[QUEUE_NAMES.TRACK_RANKING]: queues.trackRanking,
```

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add worker/queues.ts
git commit -m "feat(19b): register track_ranking queue"
```

---

## Task 3: Build RankingTrackingScheduler

**Files:**
- Create: `worker/jobs/RankingTrackingScheduler.ts`
- Create: `worker/jobs/__tests__/RankingTrackingScheduler.test.ts`

- [ ] **Step 1: Write failing tests**

Create `worker/jobs/__tests__/RankingTrackingScheduler.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the database module before imports
vi.mock('../../../src/lib/db/server', () => ({
  sql: Object.assign(
    vi.fn().mockResolvedValue([]),
    { begin: vi.fn() },
  ),
}));

vi.mock('../../../src/lib/shared/mock-mode', () => ({
  isMockMode: vi.fn().mockReturnValue(false),
}));

import { sql } from '../../../src/lib/db/server';
import { isMockMode } from '../../../src/lib/shared/mock-mode';

// Import the internal function we'll test — we need to export it for testing
// We'll test via the runRankingCheck export
describe('RankingTrackingScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RANKING_TRACKING_ENABLED = 'true';
  });

  afterEach(() => {
    delete process.env.RANKING_TRACKING_ENABLED;
  });

  it('skips when RANKING_TRACKING_ENABLED is not true', async () => {
    process.env.RANKING_TRACKING_ENABLED = 'false';
    const { runRankingCheck } = await import('../RankingTrackingScheduler');
    await runRankingCheck();
    expect(sql).not.toHaveBeenCalled();
  });

  it('skips when feature flag env var is missing', async () => {
    delete process.env.RANKING_TRACKING_ENABLED;
    const { runRankingCheck } = await import('../RankingTrackingScheduler');
    await runRankingCheck();
    expect(sql).not.toHaveBeenCalled();
  });

  it('skips in mock mode', async () => {
    vi.mocked(isMockMode).mockReturnValue(true);
    const { runRankingCheck } = await import('../RankingTrackingScheduler');
    await runRankingCheck();
    expect(sql).not.toHaveBeenCalled();
  });

  it('skips when not an even-week Sunday at 22 UTC', async () => {
    // Mock Date to a Monday — should not fire
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-13T22:00:00Z')); // Monday
    const { runRankingCheck } = await import('../RankingTrackingScheduler');
    await runRankingCheck();
    expect(sql).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('queries eligible businesses on even-week Sunday at 22 UTC', async () => {
    vi.useFakeTimers();
    // 2026-04-19 is a Sunday, ISO week 16 (even)
    vi.setSystemTime(new Date('2026-04-19T22:30:00Z'));
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { runRankingCheck } = await import('../RankingTrackingScheduler');
    await runRankingCheck();
    expect(sql).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('creates outbox entries for eligible businesses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-19T22:30:00Z'));

    const mockBusinesses = [
      { id: 'biz-1', google_place_id: 'ChIJ_test1' },
      { id: 'biz-2', google_place_id: 'ChIJ_test2' },
    ];
    // First call returns businesses, subsequent calls for inserts return []
    const sqlMock = vi.mocked(sql as unknown as ReturnType<typeof vi.fn>);
    sqlMock.mockResolvedValueOnce(mockBusinesses);
    sqlMock.mockResolvedValue([]);

    const { runRankingCheck } = await import('../RankingTrackingScheduler');
    await runRankingCheck();

    // Should have called sql at least 3 times: 1 query + 2 inserts
    expect(sqlMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run worker/jobs/__tests__/RankingTrackingScheduler.test.ts`
Expected: FAIL — module `../RankingTrackingScheduler` not found

- [ ] **Step 3: Write the scheduler**

Create `worker/jobs/RankingTrackingScheduler.ts`:

```typescript
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { isMockMode } from '../../src/lib/shared/mock-mode';
import type { TrackRankingPayload } from '../../src/lib/shared/worker-types';

const DEFAULT_INTERVAL_MS = 3_600_000; // 1 hour — checks time conditions each cycle

let pollerInterval: ReturnType<typeof setInterval> | null = null;
let isPolling = false;

function getIntervalMs(): number {
  const env = process.env.RANKING_TRACKING_INTERVAL_MS;
  if (env) {
    const parsed = parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_INTERVAL_MS;
}

/**
 * Returns the ISO week number for a given date (ISO 8601: Monday-based weeks).
 * Week 1 is the week containing the year's first Thursday.
 */
function getIsoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/**
 * Checks if now is an even-week Sunday at 22:xx UTC.
 * Biweekly cadence: fires every other Sunday evening.
 */
function isScheduledTime(): boolean {
  const now = new Date();
  if (now.getUTCDay() !== 0) return false;  // Sunday = 0
  if (now.getUTCHours() !== 22) return false;
  const week = getIsoWeekNumber(now);
  return week % 2 === 0; // Even weeks
}

/**
 * Main poll cycle. Exported for testing.
 */
export async function runRankingCheck(): Promise<void> {
  // Feature flag gate
  if (process.env.RANKING_TRACKING_ENABLED !== 'true') {
    return;
  }

  if (isMockMode()) {
    console.log('[RankingTrackingScheduler] Mock mode — skipping');
    return;
  }

  if (!isScheduledTime()) {
    return; // Silent skip — runs hourly, fires biweekly
  }

  if (isPolling) return;
  isPolling = true;

  try {
    console.log('[RankingTrackingScheduler] Running biweekly ranking check...');

    // Query eligible businesses:
    // - active subscription
    // - verified place ID
    // - has coordinates OR explicit ranking_search_location
    // - has at least one tracked keyword
    const businesses = await sql<{ id: string; google_place_id: string }[]>`
      SELECT b.id, b.google_place_id
      FROM businesses b
      WHERE b.subscription_status = 'active'
        AND b.place_id_verified = TRUE
        AND b.google_place_id IS NOT NULL
        AND b.tracked_keywords <> '[]'::jsonb
        AND (
          (b.google_place_lat IS NOT NULL AND b.google_place_lng IS NOT NULL)
          OR b.ranking_search_location IS NOT NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM job_outbox jo
          WHERE jo.topic = 'track_ranking'
            AND jo.aggregate_id = b.id
            AND jo.status IN ('pending', 'dispatched')
        )
    `;

    if (businesses.length === 0) {
      console.log('[RankingTrackingScheduler] No eligible businesses for ranking tracking');
      return;
    }

    let queued = 0;
    for (const biz of businesses) {
      try {
        const payload: TrackRankingPayload = {
          business_id: biz.id,
          google_place_id: biz.google_place_id,
        };

        await sql`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          VALUES (
            ${uuidv7()},
            'track_ranking',
            'business',
            ${biz.id},
            ${JSON.stringify(payload)}::jsonb,
            'pending'
          )
        `;
        queued++;
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === '23505') continue; // Unique constraint — already queued
        throw err;
      }
    }

    console.log(`[RankingTrackingScheduler] Queued ${queued} ranking tracking jobs`);
  } catch (err) {
    console.error('[RankingTrackingScheduler] Error:', err);
  } finally {
    isPolling = false;
  }
}

export function startRankingTrackingScheduler(): void {
  if (pollerInterval) return;
  console.log('[RankingTrackingScheduler] Starting (interval: %dms)', getIntervalMs());
  void runRankingCheck(); // Run once immediately
  pollerInterval = setInterval(() => void runRankingCheck(), getIntervalMs());
}

export function stopRankingTrackingScheduler(): void {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    console.log('[RankingTrackingScheduler] Stopped');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run worker/jobs/__tests__/RankingTrackingScheduler.test.ts`
Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/RankingTrackingScheduler.ts worker/jobs/__tests__/RankingTrackingScheduler.test.ts
git commit -m "feat(19b): RankingTrackingScheduler — biweekly poller with feature flag"
```

---

## Task 4: Build RankingTrackingWorker

**Files:**
- Create: `worker/jobs/RankingTrackingWorker.ts`
- Create: `worker/jobs/__tests__/RankingTrackingWorker.test.ts`

- [ ] **Step 1: Write failing tests**

Create `worker/jobs/__tests__/RankingTrackingWorker.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/lib/db/server', () => ({
  sql: Object.assign(
    vi.fn().mockResolvedValue([]),
    { begin: vi.fn() },
  ),
}));

vi.mock('../../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: vi.fn().mockResolvedValue(undefined),
  markOutboxFailed: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/lib/shared/subscription-guard', () => ({
  checkSubscription: vi.fn().mockReturnValue({ allowed: true }),
}));

vi.mock('../../../src/lib/shared/mock-mode', () => ({
  isMockMode: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../src/lib/shared/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 99 }),
}));

vi.mock('serpapi', () => ({
  getJson: vi.fn().mockResolvedValue({
    local_results: [
      { place_id: 'ChIJ_match', title: 'Test Biz', position: 1 },
      { place_id: 'ChIJ_other', title: 'Other Biz', position: 2 },
    ],
  }),
}));

import { sql } from '../../../src/lib/db/server';
import { markOutboxCompleted, markOutboxFailed } from '../../../src/lib/shared/outbox';
import { checkSubscription } from '../../../src/lib/shared/subscription-guard';
import { isMockMode } from '../../../src/lib/shared/mock-mode';
import { checkRateLimit } from '../../../src/lib/shared/rate-limit';
import { getJson } from 'serpapi';
import type { Job } from 'bullmq';
import type { TrackRankingPayload } from '../../../src/lib/shared/worker-types';

function makeJob(data: TrackRankingPayload & { outbox_id?: string }): Job<TrackRankingPayload> {
  return { data, id: 'test-job-id' } as unknown as Job<TrackRankingPayload>;
}

describe('RankingTrackingWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SERPAPI_API_KEY = 'test-key';
  });

  it('marks failed when business not found', async () => {
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const { handleTrackRanking } = await import('../RankingTrackingWorker');
    await handleTrackRanking(makeJob({ business_id: 'missing', google_place_id: 'ChIJ_test', outbox_id: 'ob-1' }));
    expect(markOutboxFailed).toHaveBeenCalledWith('ob-1', expect.stringContaining('not found'));
  });

  it('skips cancelled subscription', async () => {
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'biz-1', subscription_status: 'cancelled', updated_at: new Date().toISOString(), tracked_keywords: '["tacos"]', google_place_id: 'ChIJ_match', google_place_lat: 37.3, google_place_lng: -121.8, ranking_search_location: null },
    ]);
    vi.mocked(checkSubscription).mockReturnValue({ allowed: false, reason: 'cancelled' });
    const { handleTrackRanking } = await import('../RankingTrackingWorker');
    await handleTrackRanking(makeJob({ business_id: 'biz-1', google_place_id: 'ChIJ_match', outbox_id: 'ob-1' }));
    expect(markOutboxCompleted).toHaveBeenCalledWith('ob-1');
    expect(getJson).not.toHaveBeenCalled();
  });

  it('skips when tracked_keywords is empty', async () => {
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'biz-1', subscription_status: 'active', updated_at: new Date().toISOString(), tracked_keywords: '[]', google_place_id: 'ChIJ_match', google_place_lat: 37.3, google_place_lng: -121.8, ranking_search_location: null },
    ]);
    const { handleTrackRanking } = await import('../RankingTrackingWorker');
    await handleTrackRanking(makeJob({ business_id: 'biz-1', google_place_id: 'ChIJ_match', outbox_id: 'ob-1' }));
    expect(markOutboxCompleted).toHaveBeenCalledWith('ob-1');
    expect(getJson).not.toHaveBeenCalled();
  });

  it('skips when monthly SerpAPI budget is exhausted', async () => {
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'biz-1', subscription_status: 'active', updated_at: new Date().toISOString(), tracked_keywords: '["tacos"]', google_place_id: 'ChIJ_match', google_place_lat: 37.3, google_place_lng: -121.8, ranking_search_location: null },
    ]);
    vi.mocked(checkRateLimit).mockResolvedValue({ allowed: false, remaining: 0 });
    const { handleTrackRanking } = await import('../RankingTrackingWorker');
    await handleTrackRanking(makeJob({ business_id: 'biz-1', google_place_id: 'ChIJ_match', outbox_id: 'ob-1' }));
    expect(markOutboxCompleted).toHaveBeenCalledWith('ob-1');
    expect(getJson).not.toHaveBeenCalled();
  });

  it('calls SerpAPI with ll= param when coordinates exist', async () => {
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'biz-1', subscription_status: 'active', updated_at: new Date().toISOString(), tracked_keywords: '["tacos san jose"]', google_place_id: 'ChIJ_match', google_place_lat: '37.3382082', google_place_lng: '-121.8863286', ranking_search_location: null },
    ]);
    // Second call for the upsert
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { handleTrackRanking } = await import('../RankingTrackingWorker');
    await handleTrackRanking(makeJob({ business_id: 'biz-1', google_place_id: 'ChIJ_match', outbox_id: 'ob-1' }));

    expect(getJson).toHaveBeenCalledWith(expect.objectContaining({
      engine: 'google_maps',
      q: 'tacos san jose',
      ll: '@37.3382082,-121.8863286,15z',
    }));
    expect(markOutboxCompleted).toHaveBeenCalledWith('ob-1');
  });

  it('uses ranking_search_location when coordinates are missing', async () => {
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'biz-1', subscription_status: 'active', updated_at: new Date().toISOString(), tracked_keywords: '["tacos"]', google_place_id: 'ChIJ_match', google_place_lat: null, google_place_lng: null, ranking_search_location: 'San Jose, CA' },
    ]);
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { handleTrackRanking } = await import('../RankingTrackingWorker');
    await handleTrackRanking(makeJob({ business_id: 'biz-1', google_place_id: 'ChIJ_match', outbox_id: 'ob-1' }));

    expect(getJson).toHaveBeenCalledWith(expect.objectContaining({
      engine: 'google_maps',
      q: 'tacos',
      location: 'San Jose, CA',
    }));
  });

  it('skips when no location data available', async () => {
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'biz-1', subscription_status: 'active', updated_at: new Date().toISOString(), tracked_keywords: '["tacos"]', google_place_id: 'ChIJ_match', google_place_lat: null, google_place_lng: null, ranking_search_location: null },
    ]);
    const { handleTrackRanking } = await import('../RankingTrackingWorker');
    await handleTrackRanking(makeJob({ business_id: 'biz-1', google_place_id: 'ChIJ_match', outbox_id: 'ob-1' }));
    expect(markOutboxCompleted).toHaveBeenCalledWith('ob-1');
    expect(getJson).not.toHaveBeenCalled();
  });

  it('records rank_position when business is found in results', async () => {
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'biz-1', subscription_status: 'active', updated_at: new Date().toISOString(), tracked_keywords: '["tacos"]', google_place_id: 'ChIJ_match', google_place_lat: '37.3', google_place_lng: '-121.8', ranking_search_location: null },
    ]);
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { handleTrackRanking } = await import('../RankingTrackingWorker');
    await handleTrackRanking(makeJob({ business_id: 'biz-1', google_place_id: 'ChIJ_match', outbox_id: 'ob-1' }));

    // Verify the upsert was called — the second sql call should contain rank 1
    const calls = vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // Find the upsert call (contains 'ranking_snapshots')
    const upsertCall = calls.find(c => String(c[0]?.[0] ?? c[0]).includes('ranking_snapshots'));
    expect(upsertCall).toBeDefined();
    expect(markOutboxCompleted).toHaveBeenCalledWith('ob-1');
  });

  it('records NULL rank_position when business not found in results', async () => {
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'biz-1', subscription_status: 'active', updated_at: new Date().toISOString(), tracked_keywords: '["tacos"]', google_place_id: 'ChIJ_no_match', google_place_lat: '37.3', google_place_lng: '-121.8', ranking_search_location: null },
    ]);
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    // SerpAPI results don't contain ChIJ_no_match
    const { handleTrackRanking } = await import('../RankingTrackingWorker');
    await handleTrackRanking(makeJob({ business_id: 'biz-1', google_place_id: 'ChIJ_no_match', outbox_id: 'ob-1' }));
    expect(markOutboxCompleted).toHaveBeenCalledWith('ob-1');
  });

  it('generates random rank 1-10 in mock mode', async () => {
    vi.mocked(isMockMode).mockReturnValue(true);
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'biz-1', subscription_status: 'active', updated_at: new Date().toISOString(), tracked_keywords: '["tacos"]', google_place_id: 'ChIJ_match', google_place_lat: '37.3', google_place_lng: '-121.8', ranking_search_location: null },
    ]);
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { handleTrackRanking } = await import('../RankingTrackingWorker');
    await handleTrackRanking(makeJob({ business_id: 'biz-1', google_place_id: 'ChIJ_match', outbox_id: 'ob-1' }));
    expect(getJson).not.toHaveBeenCalled(); // No real API call
    expect(markOutboxCompleted).toHaveBeenCalledWith('ob-1');
  });

  it('limits to 1 keyword per business', async () => {
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: 'biz-1', subscription_status: 'active', updated_at: new Date().toISOString(), tracked_keywords: '["tacos","burritos","enchiladas"]', google_place_id: 'ChIJ_match', google_place_lat: '37.3', google_place_lng: '-121.8', ranking_search_location: null },
    ]);
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const { handleTrackRanking } = await import('../RankingTrackingWorker');
    await handleTrackRanking(makeJob({ business_id: 'biz-1', google_place_id: 'ChIJ_match', outbox_id: 'ob-1' }));
    // Only 1 SerpAPI call despite 3 keywords
    expect(getJson).toHaveBeenCalledTimes(1);
    expect(getJson).toHaveBeenCalledWith(expect.objectContaining({ q: 'tacos' }));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run worker/jobs/__tests__/RankingTrackingWorker.test.ts`
Expected: FAIL — module `../RankingTrackingWorker` not found

- [ ] **Step 3: Write the worker**

Create `worker/jobs/RankingTrackingWorker.ts`:

```typescript
import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { getJson } from 'serpapi';
import { sql } from '../../src/lib/db/server';
import { markOutboxCompleted, markOutboxFailed } from '../../src/lib/shared/outbox';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { checkRateLimit } from '../../src/lib/shared/rate-limit';
import { isMockMode } from '../../src/lib/shared/mock-mode';
import type { TrackRankingPayload } from '../../src/lib/shared/worker-types';

/** Monthly SerpAPI budget for ranking searches. */
const MONTHLY_RANKING_BUDGET = 100;
/** Budget window in seconds (roughly 30 days). */
const BUDGET_WINDOW_SECONDS = 30 * 24 * 3600;
/** Max keywords per business per run (Sprint 5B initial rollout). */
const MAX_KEYWORDS_PER_BUSINESS = 1;

interface SerpApiLocalResult {
  place_id?: string;
  title?: string;
  position?: number;
}

export async function handleTrackRanking(job: Job<TrackRankingPayload>): Promise<void> {
  const { business_id, google_place_id } = job.data;
  const outboxId = (job.data as unknown as { outbox_id?: string }).outbox_id ?? job.id!;

  // 1. Load business
  const [business] = await sql<{
    id: string;
    subscription_status: string;
    updated_at: string;
    tracked_keywords: string | string[];
    google_place_id: string;
    google_place_lat: string | null;
    google_place_lng: string | null;
    ranking_search_location: string | null;
  }[]>`
    SELECT id, subscription_status, updated_at, tracked_keywords,
           google_place_id, google_place_lat, google_place_lng, ranking_search_location
    FROM businesses WHERE id = ${business_id}
  `;

  if (!business) {
    await markOutboxFailed(outboxId, `Business ${business_id} not found`);
    return;
  }

  // 2. Subscription guard
  const subCheck = checkSubscription(business.subscription_status, new Date(business.updated_at), 'summary');
  if (!subCheck.allowed) {
    console.log(`[RankingTrackingWorker] Skipped ${business_id}: ${subCheck.reason}`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // 3. Parse tracked_keywords (JSONB guard)
  const rawKeywords = typeof business.tracked_keywords === 'string'
    ? JSON.parse(business.tracked_keywords) as string[]
    : business.tracked_keywords;

  if (!Array.isArray(rawKeywords) || rawKeywords.length === 0) {
    console.log(`[RankingTrackingWorker] Skipped ${business_id}: no tracked keywords`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // 4. Limit to MAX_KEYWORDS_PER_BUSINESS
  const keywords = rawKeywords.slice(0, MAX_KEYWORDS_PER_BUSINESS);

  // 5. Check monthly SerpAPI budget
  const budgetCheck = await checkRateLimit('serpapi:ranking:monthly', MONTHLY_RANKING_BUDGET, BUDGET_WINDOW_SECONDS);
  if (!budgetCheck.allowed) {
    console.log(`[RankingTrackingWorker] Monthly SerpAPI ranking budget exhausted (remaining: ${budgetCheck.remaining})`);
    await markOutboxCompleted(outboxId);
    return;
  }

  // 6. Determine location params
  const hasCoords = business.google_place_lat != null && business.google_place_lng != null;
  const hasSearchLocation = business.ranking_search_location != null && business.ranking_search_location.trim() !== '';

  if (!hasCoords && !hasSearchLocation) {
    console.log(`[RankingTrackingWorker] Skipped ${business_id}: no location data for ranking search`);
    await markOutboxCompleted(outboxId);
    return;
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  for (const keyword of keywords) {
    let rankPosition: number | null = null;

    if (isMockMode()) {
      // Mock mode: random rank 1-10
      rankPosition = Math.floor(Math.random() * 10) + 1;
      console.log(`[RankingTrackingWorker] Mock rank for "${keyword}": #${rankPosition}`);
    } else {
      // Build SerpAPI params
      const params: Record<string, string> = {
        engine: 'google_maps',
        q: keyword,
        api_key: process.env.SERPAPI_API_KEY!,
      };

      if (hasCoords) {
        params.ll = `@${business.google_place_lat},${business.google_place_lng},15z`;
      } else {
        params.location = business.ranking_search_location!;
      }

      try {
        const response = await getJson(params);

        if (response.error) {
          console.error(`[RankingTrackingWorker] SerpAPI error for "${keyword}":`, response.error);
          throw new Error(`SerpAPI error: ${response.error}`);
        }

        const localResults: SerpApiLocalResult[] = response.local_results ?? [];
        const matchIndex = localResults.findIndex(
          (r) => r.place_id === google_place_id,
        );

        rankPosition = matchIndex >= 0 ? matchIndex + 1 : null;
        console.log(`[RankingTrackingWorker] "${keyword}" rank for ${business_id}: ${rankPosition ?? 'not found'}`);
      } catch (err) {
        console.error(`[RankingTrackingWorker] SerpAPI call failed for "${keyword}":`, err);
        // Throw to trigger BullMQ retry for transient errors
        throw err;
      }
    }

    // 7. Upsert into ranking_snapshots
    await sql`
      INSERT INTO ranking_snapshots (id, business_id, keyword, rank_position, search_location, snapshot_date, source)
      VALUES (
        ${uuidv7()},
        ${business_id},
        ${keyword},
        ${rankPosition},
        ${hasCoords ? `${business.google_place_lat},${business.google_place_lng}` : business.ranking_search_location},
        ${today}::date,
        'serpapi'
      )
      ON CONFLICT (business_id, keyword, snapshot_date)
      DO UPDATE SET rank_position = EXCLUDED.rank_position,
                    search_location = EXCLUDED.search_location,
                    source = 'serpapi'
    `;
  }

  await markOutboxCompleted(outboxId);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run worker/jobs/__tests__/RankingTrackingWorker.test.ts`
Expected: all 11 tests PASS

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/RankingTrackingWorker.ts worker/jobs/__tests__/RankingTrackingWorker.test.ts
git commit -m "feat(19b): RankingTrackingWorker — SerpAPI ranking search + upsert"
```

---

## Task 5: Register worker + scheduler in worker/index.ts

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Add imports**

Add after the existing imports at the top of `worker/index.ts`:

```typescript
import { startRankingTrackingScheduler, stopRankingTrackingScheduler } from './jobs/RankingTrackingScheduler';
import { handleTrackRanking } from './jobs/RankingTrackingWorker';
```

- [ ] **Step 2: Add worker instance**

After the `engagementAlertWorker` line, add:

```typescript
const rankingTrackingWorker = new Worker(QUEUE_NAMES.TRACK_RANKING, handleTrackRanking, workerOpts);
```

- [ ] **Step 3: Add to workers array**

Update the `workers` array to include `rankingTrackingWorker`:

```typescript
const workers = [demoWorker, reviewSyncWorker, responseGenWorker, notificationWorker, publisherWorker, adminExceptionWorker, weeklySummaryWorker, placeIdValidationWorker, monthlyImpactWorker, engagementAlertWorker, rankingTrackingWorker];
```

- [ ] **Step 4: Add scheduler start**

In the `main()` function, after `startEngagementMonitorPoller();`, add:

```typescript
startRankingTrackingScheduler();
```

- [ ] **Step 5: Add scheduler stop**

In the `shutdown()` function, after `stopEngagementMonitorPoller();`, add:

```typescript
stopRankingTrackingScheduler();
```

- [ ] **Step 6: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add worker/index.ts
git commit -m "feat(19b): register RankingTrackingWorker + scheduler"
```

---

## Task 6: Keywords API route

**Files:**
- Create: `src/app/api/admin/businesses/[id]/keywords/route.ts`
- Create: `src/app/api/admin/businesses/[id]/keywords/__tests__/route.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/app/api/admin/businesses/[id]/keywords/__tests__/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../../../../src/lib/db/server', () => ({
  sql: Object.assign(vi.fn().mockResolvedValue([]), { begin: vi.fn() }),
}));

vi.mock('../../../../../../../src/lib/db/auth', () => ({
  requireRole: vi.fn().mockResolvedValue({ user: { id: 'u1' }, role: 'admin', businessId: null }),
}));

import { sql } from '../../../../../../../src/lib/db/server';

describe('PUT /api/admin/businesses/[id]/keywords', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 for non-array keywords', async () => {
    const { PUT } = await import('../route');
    const req = new Request('http://localhost/api/admin/businesses/biz-1/keywords', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: 'not-an-array' }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'biz-1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 400 for more than 5 keywords', async () => {
    const { PUT } = await import('../route');
    const req = new Request('http://localhost/api/admin/businesses/biz-1/keywords', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'biz-1' }) });
    expect(res.status).toBe(400);
  });

  it('updates tracked_keywords for valid input', async () => {
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: 'biz-1' }]);
    const { PUT } = await import('../route');
    const req = new Request('http://localhost/api/admin/businesses/biz-1/keywords', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: ['tacos san jose', 'best tacos'] }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'biz-1' }) });
    expect(res.status).toBe(200);
  });

  it('allows empty array to clear keywords', async () => {
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: 'biz-1' }]);
    const { PUT } = await import('../route');
    const req = new Request('http://localhost/api/admin/businesses/biz-1/keywords', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keywords: [] }),
    });
    const res = await PUT(req, { params: Promise.resolve({ id: 'biz-1' }) });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/api/admin/businesses/\\[id\\]/keywords/__tests__/route.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the route**

Create `src/app/api/admin/businesses/[id]/keywords/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db/server';
import { requireRole } from '@/lib/db/auth';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

const KeywordsSchema = z.object({
  keywords: z.array(z.string().min(1).max(255).trim()).max(5, 'Maximum 5 keywords'),
});

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
    const { id: businessId } = await params;

    const body = await request.json();
    const parsed = KeywordsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const result = await sql`
      UPDATE businesses
      SET tracked_keywords = ${JSON.stringify(parsed.data.keywords)}::jsonb,
          updated_at = NOW()
      WHERE id = ${businessId}
      RETURNING id
    `;

    if (result.length === 0) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404, headers: NO_STORE_HEADERS });
    }

    return NextResponse.json({ success: true }, { headers: NO_STORE_HEADERS });
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return NextResponse.json(
      { error: status === 401 || status === 403 ? 'Unauthorized' : 'Internal server error' },
      { status, headers: NO_STORE_HEADERS },
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/api/admin/businesses/\\[id\\]/keywords/__tests__/route.test.ts`
Expected: all 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/admin/businesses/[id]/keywords/"
git commit -m "feat(19b): PUT /api/admin/businesses/:id/keywords — tracked keywords management"
```

---

## Task 7: Manual ranking entry API route

**Files:**
- Create: `src/app/api/admin/businesses/[id]/ranking/route.ts`
- Create: `src/app/api/admin/businesses/[id]/ranking/__tests__/route.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/app/api/admin/businesses/[id]/ranking/__tests__/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../../../../src/lib/db/server', () => ({
  sql: Object.assign(vi.fn().mockResolvedValue([]), { begin: vi.fn() }),
}));

vi.mock('../../../../../../../src/lib/db/auth', () => ({
  requireRole: vi.fn().mockResolvedValue({ user: { id: 'u1' }, role: 'admin', businessId: null }),
}));

import { sql } from '../../../../../../../src/lib/db/server';

describe('POST /api/admin/businesses/[id]/ranking', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 for missing keyword', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/admin/businesses/biz-1/ranking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rankPosition: 3, date: '2026-04-15' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'biz-1' }) });
    expect(res.status).toBe(400);
  });

  it('returns 400 for rank_position out of range', async () => {
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/admin/businesses/biz-1/ranking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: 'tacos', rankPosition: 0, date: '2026-04-15' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'biz-1' }) });
    expect(res.status).toBe(400);
  });

  it('inserts manual ranking snapshot', async () => {
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: 'snap-1' }]);
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/admin/businesses/biz-1/ranking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: 'tacos', rankPosition: 4, date: '2026-04-15' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'biz-1' }) });
    expect(res.status).toBe(200);
  });

  it('defaults date to today when omitted', async () => {
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: 'snap-1' }]);
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/admin/businesses/biz-1/ranking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: 'tacos', rankPosition: 5 }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'biz-1' }) });
    expect(res.status).toBe(200);
  });

  it('allows null rank_position (not found)', async () => {
    vi.mocked(sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ id: 'snap-1' }]);
    const { POST } = await import('../route');
    const req = new Request('http://localhost/api/admin/businesses/biz-1/ranking', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: 'tacos', rankPosition: null, date: '2026-04-15' }),
    });
    const res = await POST(req, { params: Promise.resolve({ id: 'biz-1' }) });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/api/admin/businesses/\\[id\\]/ranking/__tests__/route.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the route**

Create `src/app/api/admin/businesses/[id]/ranking/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import { requireRole } from '@/lib/db/auth';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

const RankingSchema = z.object({
  keyword: z.string().min(1).max(255).trim(),
  rankPosition: z.number().int().min(1).max(100).nullable(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD').optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
    const { id: businessId } = await params;

    const body = await request.json();
    const parsed = RankingSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const snapshotDate = parsed.data.date ?? new Date().toISOString().slice(0, 10);

    const result = await sql`
      INSERT INTO ranking_snapshots (id, business_id, keyword, rank_position, snapshot_date, source)
      VALUES (${uuidv7()}, ${businessId}, ${parsed.data.keyword}, ${parsed.data.rankPosition}, ${snapshotDate}::date, 'manual')
      ON CONFLICT (business_id, keyword, snapshot_date)
      DO UPDATE SET rank_position = EXCLUDED.rank_position, source = 'manual'
      RETURNING id
    `;

    if (result.length === 0) {
      return NextResponse.json({ error: 'Insert failed' }, { status: 500, headers: NO_STORE_HEADERS });
    }

    return NextResponse.json({ success: true, id: result[0]!.id }, { headers: NO_STORE_HEADERS });
  } catch (err: unknown) {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    return NextResponse.json(
      { error: status === 401 || status === 403 ? 'Unauthorized' : 'Internal server error' },
      { status, headers: NO_STORE_HEADERS },
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/api/admin/businesses/\\[id\\]/ranking/__tests__/route.test.ts`
Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/admin/businesses/[id]/ranking/"
git commit -m "feat(19b): POST /api/admin/businesses/:id/ranking — manual rank entry"
```

---

## Task 8: Extend GET business detail API to return ranking data

**Files:**
- Modify: `src/app/api/admin/businesses/[id]/route.ts`

- [ ] **Step 1: Add tracked_keywords and location columns to the business query**

In the GET handler of `src/app/api/admin/businesses/[id]/route.ts`, extend the business SELECT to include the new columns. Find the existing business query and add these columns:

```sql
b.tracked_keywords, b.google_place_lat, b.google_place_lng,
b.ranking_search_location, b.google_place_address
```

- [ ] **Step 2: Add ranking snapshots query**

Add a third parallel query alongside the existing business and reviews queries to fetch recent ranking snapshots:

```typescript
const rankingSnapshotsPromise = sql<{ keyword: string; rank_position: number | null; snapshot_date: string; source: string }[]>`
  SELECT keyword, rank_position, snapshot_date, source
  FROM ranking_snapshots
  WHERE business_id = ${businessId}
  ORDER BY snapshot_date DESC
  LIMIT 50
`;
```

Await it in the same `Promise.all` as the other queries.

- [ ] **Step 3: Include in response**

Add to the response JSON object:

```typescript
trackedKeywords: parseJsonbField(business.tracked_keywords, []),
googlePlaceLat: business.google_place_lat,
googlePlaceLng: business.google_place_lng,
rankingSearchLocation: business.ranking_search_location,
googlePlaceAddress: business.google_place_address,
rankingSnapshots: rankingSnapshots,
```

Where `parseJsonbField` handles the JSONB-as-string PgBouncer behavior:

```typescript
function parseJsonbField<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return value as T;
}
```

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Run existing tests**

Run: `npx vitest run`
Expected: all existing tests PASS

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/admin/businesses/[id]/route.ts"
git commit -m "feat(19b): return trackedKeywords + ranking data from business detail API"
```

---

## Task 9: Add Tracked Keywords + Ranking UI sections to admin detail page

**Files:**
- Modify: `src/app/admin/businesses/[id]/page.tsx`

- [ ] **Step 1: Extend interfaces**

Add to the `BusinessDetail` interface:

```typescript
trackedKeywords: string[];
googlePlaceLat: number | null;
googlePlaceLng: number | null;
rankingSearchLocation: string | null;
googlePlaceAddress: string | null;
```

Add a new interface:

```typescript
interface RankingSnapshot {
  keyword: string;
  rankPosition: number | null;
  snapshotDate: string;
  source: string;
}
```

Extend `DetailData`:

```typescript
interface DetailData {
  business: BusinessDetail;
  reviews: ReviewRow[];
  rankingSnapshots: RankingSnapshot[];
}
```

- [ ] **Step 2: Build TrackedKeywordsSection component**

Add a new component inside the page file (or as a separate import — inline is fine for a focused section):

```typescript
function TrackedKeywordsSection({ businessId, keywords: initial }: { businessId: string; keywords: string[] }) {
  const [keywords, setKeywords] = useState<string[]>(initial);
  const [newKeyword, setNewKeyword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  async function save(updated: string[]) {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/businesses/${businessId}/keywords`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: updated }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? 'Failed to save');
        return;
      }
      setKeywords(updated);
      queryClient.invalidateQueries({ queryKey: ['business-detail', businessId] });
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  }

  function addKeyword() {
    const trimmed = newKeyword.trim();
    if (!trimmed || keywords.includes(trimmed) || keywords.length >= 5) return;
    save([...keywords, trimmed]);
    setNewKeyword('');
  }

  function removeKeyword(kw: string) {
    save(keywords.filter((k) => k !== kw));
  }

  return (
    <section className="bg-white rounded-lg shadow p-6 mb-6">
      <h2 className="text-lg font-semibold mb-4">Tracked Keywords</h2>
      <p className="text-sm text-gray-500 mb-3">
        Keywords used for automated Google Maps ranking tracking (max 5). The first keyword is tracked automatically.
      </p>
      <div className="flex flex-wrap gap-2 mb-3">
        {keywords.map((kw) => (
          <span key={kw} className="inline-flex items-center gap-1 bg-blue-100 text-blue-800 px-3 py-1 rounded-full text-sm">
            {kw}
            <button onClick={() => removeKeyword(kw)} disabled={saving} className="ml-1 text-blue-600 hover:text-red-600">&times;</button>
          </span>
        ))}
        {keywords.length === 0 && <span className="text-gray-400 text-sm">No keywords configured</span>}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={newKeyword}
          onChange={(e) => setNewKeyword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addKeyword()}
          placeholder="e.g. tacos san jose"
          className="border rounded px-3 py-1.5 text-sm flex-1"
          maxLength={255}
          disabled={saving || keywords.length >= 5}
        />
        <button
          onClick={addKeyword}
          disabled={saving || !newKeyword.trim() || keywords.length >= 5}
          className="bg-blue-600 text-white px-4 py-1.5 rounded text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          Add
        </button>
      </div>
      {error && <p className="text-red-600 text-sm mt-2">{error}</p>}
    </section>
  );
}
```

- [ ] **Step 3: Build ManualRankingSection component**

```typescript
function ManualRankingSection({ businessId, snapshots }: { businessId: string; snapshots: RankingSnapshot[] }) {
  const [keyword, setKeyword] = useState('');
  const [rankPosition, setRankPosition] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const queryClient = useQueryClient();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!keyword.trim()) return;
    setSaving(true);
    setError(null);
    setSuccess(false);
    try {
      const res = await fetch(`/api/admin/businesses/${businessId}/ranking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword: keyword.trim(),
          rankPosition: rankPosition ? parseInt(rankPosition, 10) : null,
          date,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        setError(data.error ?? 'Failed to save');
        return;
      }
      setSuccess(true);
      setKeyword('');
      setRankPosition('');
      queryClient.invalidateQueries({ queryKey: ['business-detail', businessId] });
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="bg-white rounded-lg shadow p-6 mb-6">
      <h2 className="text-lg font-semibold mb-4">Ranking</h2>

      {/* Recent snapshots */}
      {snapshots.length > 0 && (
        <div className="mb-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="pb-2 pr-4">Date</th>
                <th className="pb-2 pr-4">Keyword</th>
                <th className="pb-2 pr-4">Rank</th>
                <th className="pb-2">Source</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.slice(0, 10).map((s, i) => (
                <tr key={`${s.keyword}-${s.snapshotDate}-${i}`} className="border-b last:border-0">
                  <td className="py-1.5 pr-4">{s.snapshotDate}</td>
                  <td className="py-1.5 pr-4">{s.keyword}</td>
                  <td className="py-1.5 pr-4">{s.rankPosition != null ? `#${s.rankPosition}` : 'Not found'}</td>
                  <td className="py-1.5">
                    <span className={`text-xs px-2 py-0.5 rounded ${s.source === 'serpapi' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'}`}>
                      {s.source}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Manual entry form */}
      <h3 className="text-sm font-medium text-gray-700 mb-2">Add Manual Entry</h3>
      <form onSubmit={submit} className="flex flex-wrap gap-2 items-end">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Keyword</label>
          <input type="text" value={keyword} onChange={(e) => setKeyword(e.target.value)} className="border rounded px-3 py-1.5 text-sm w-48" placeholder="e.g. tacos" required />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Rank (leave empty = not found)</label>
          <input type="number" value={rankPosition} onChange={(e) => setRankPosition(e.target.value)} className="border rounded px-3 py-1.5 text-sm w-20" min={1} max={100} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="border rounded px-3 py-1.5 text-sm" />
        </div>
        <button type="submit" disabled={saving || !keyword.trim()} className="bg-gray-800 text-white px-4 py-1.5 rounded text-sm hover:bg-gray-900 disabled:opacity-50">
          Save
        </button>
      </form>
      {error && <p className="text-red-600 text-sm mt-2">{error}</p>}
      {success && <p className="text-green-600 text-sm mt-2">Ranking saved</p>}
    </section>
  );
}
```

- [ ] **Step 4: Render the new sections in the page**

In the main page component, after the Engagement/Churn section and before the Awaiting Manual Post section, add:

```tsx
<TrackedKeywordsSection businessId={business.id} keywords={business.trackedKeywords} />
<ManualRankingSection businessId={business.id} snapshots={data.rankingSnapshots} />
```

- [ ] **Step 5: Verify the page compiles**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Start the dev server and verify UI**

Run: `pnpm dev`

Navigate to `/admin/businesses/{id}` for any business. Verify:
- Tracked Keywords section shows with add/remove functionality
- Ranking section shows an empty table (or existing data) and a manual entry form
- Adding a keyword and saving works
- Submitting a manual rank entry works

- [ ] **Step 7: Commit**

```bash
git add "src/app/admin/businesses/[id]/page.tsx"
git commit -m "feat(19b): add Tracked Keywords + Ranking sections to admin business detail"
```

---

## Task 10: Add RANKING_TRACKING_ENABLED to env template

**Files:**
- Modify: `.env.local` (or `.env.example`)

- [ ] **Step 1: Add the env var**

Add to the `.env.local` file under the configurable section:

```env
# Ranking tracking (Sprint 5B) — disabled by default
RANKING_TRACKING_ENABLED=false
# RANKING_TRACKING_INTERVAL_MS=3600000
```

- [ ] **Step 2: Commit**

```bash
git add .env.local
git commit -m "feat(19b): add RANKING_TRACKING_ENABLED env var (default false)"
```

---

## Task 11: Run full test suite and verify

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: all existing + new tests PASS (previous baseline was 427 tests)

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Final commit if any fixups needed**

If any tests needed adjustment:

```bash
git add -A
git commit -m "fix(19b): test fixups after ranking tracking integration"
```
