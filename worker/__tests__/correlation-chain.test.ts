// Worker-chain correlation test.
//
// Proves the correlation_id injected at the sync entry point flows through
// the full review→response→notification chain:
//
//   sync_reviews [corr-X]
//     → ReviewSyncWorker / processReview
//     → generate_response [corr-X]                  ← asserted in Part A
//       → ResponseGeneratorWorker / persistResponseAndNotify
//       → send_notification [corr-X]                ← asserted in Part B
//
// Each worker runs in a separate BullMQ context, so we assert the boundary
// contract at each hop: whatever correlation_id comes in must be present in
// every outbox payload this worker creates.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { SyncReviewsPayload } from '../../src/lib/shared/worker-types';
import type { MonitorResult } from '../../src/lib/reviews/types';

const UPSTREAM_CORRELATION = 'upstream-corr-chain-xyz';

// ─── Part A shared state ────────────────────────────────────────────

const {
  sqlReturnQueueA,
  mockSqlA,
  mockTxA,
  mockMarkOutboxCompletedA,
  mockMarkOutboxFailedA,
  mockFetchReviews,
} = vi.hoisted(() => {
  const sqlReturnQueueA: unknown[] = [];

  const mockTxA = vi.fn(
    (_strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> =>
      Promise.resolve([]),
  );

  const mockSqlA = vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => {
    const result = sqlReturnQueueA.shift() ?? [];
    return Promise.resolve(result);
  }) as unknown as {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
    begin: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    mock: { calls: unknown[][] };
  };

  (mockSqlA as unknown as { begin: (cb: (tx: unknown) => Promise<unknown>) => Promise<unknown> }).begin = vi.fn(
    async (callback: (tx: unknown) => Promise<unknown>) => callback(mockTxA),
  );

  const mockMarkOutboxCompletedA = vi.fn();
  const mockMarkOutboxFailedA = vi.fn();

  const mockFetchReviews = vi.fn<(placeId: string) => Promise<MonitorResult>>();

  return {
    sqlReturnQueueA,
    mockSqlA,
    mockTxA,
    mockMarkOutboxCompletedA,
    mockMarkOutboxFailedA,
    mockFetchReviews,
  };
});

// ─── Common mocks ────────────────────────────────────────────────────

vi.mock('../../src/lib/db/server', () => ({
  sql: mockSqlA,
}));

vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompletedA,
  markOutboxFailed: mockMarkOutboxFailedA,
}));

vi.mock('../../src/lib/shared/mock-mode', () => ({
  getReviewMonitor: () => ({ fetchReviews: mockFetchReviews }),
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => 'test-uuid-v7'),
}));

// Imports after mocks are wired
import { handleReviewSync } from '../jobs/ReviewSyncWorker';

// ─── Helpers ─────────────────────────────────────────────────────────

function activeBusiness(overrides: Record<string, unknown> = {}) {
  return {
    id: 'biz-001',
    subscription_status: 'active',
    google_place_id: 'ChIJ-test',
    place_id_verified: true,
    baseline_captured_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeSyncJob(correlationId: string): Job<SyncReviewsPayload> {
  return {
    data: {
      business_id: 'biz-001',
      google_place_id: 'ChIJ-test',
      correlation_id: correlationId,
    },
    id: 'sync-outbox-id',
  } as unknown as Job<SyncReviewsPayload>;
}

function makeMonitorResult(): MonitorResult {
  return {
    reviews: [
      {
        review: {
          reviewerName: 'Test User',
          starRating: 5,
          reviewText: 'Great place!',
          reviewDate: new Date().toISOString(),
          detectedLanguage: 'en',
        },
        identity: {
          provider: 'serpapi_poll',
          providerReviewId: 'sha-256-identity',
          providerReviewName: 'serpapi://place/reviews/sha-256-identity',
          providerLocationName: 'serpapi://place',
          identityStrategy: 'name_date_hash',
        },
        contentHash: 'content-hash-abc',
      },
    ],
    collisions: [],
  };
}

/**
 * Scan all SQL and TX template-arg calls for JSON-serialized payload strings
 * and return parsed objects. Used to verify outbox INSERT payloads.
 */
function collectOutboxPayloads(mockFns: Array<{ mock: { calls: unknown[][] } }>): Record<string, unknown>[] {
  const jsonArgs: string[] = [];
  for (const fn of mockFns) {
    for (const call of fn.mock.calls) {
      for (const arg of call) {
        if (typeof arg === 'string' && arg.startsWith('{') && arg.endsWith('}')) {
          jsonArgs.push(arg);
        }
      }
    }
  }
  return jsonArgs
    .map((s) => {
      try {
        return JSON.parse(s) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((p): p is Record<string, unknown> => p !== null);
}

// ─── Part A: sync_reviews → generate_response boundary ──────────────

describe('correlation chain — Part A: ReviewSyncWorker propagates to generate_response', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueueA.length = 0;
    mockTxA.mockImplementation(() => Promise.resolve([]));
  });

  it('passes incoming correlation_id through to every generate_response outbox payload it creates', async () => {
    // Queue the business lookup (first SELECT)
    sqlReturnQueueA.push([activeBusiness()]);
    // After fetchReviews returns, processReview runs inside sql.begin using mockTxA.
    // mockTxA defaults to returning [] for every call, which means:
    //   - SELECT existing review (FOR UPDATE) → [] (NEW review branch)
    //   - INSERT reviews → [] (no RETURNING used)
    //   - INSERT job_outbox generate_response → [] (this is what we're verifying)
    // baseline_captured_at is already set so captureRoiBaseline is skipped.
    mockFetchReviews.mockResolvedValue(makeMonitorResult());

    await handleReviewSync(makeSyncJob(UPSTREAM_CORRELATION));

    // Extract all JSON payloads from both sql and tx mock calls
    const payloads = collectOutboxPayloads([
      mockSqlA as unknown as { mock: { calls: unknown[][] } },
      mockTxA,
    ]);

    // Find the generate_response payload (has review_id + business_id + version=1)
    const generatePayload = payloads.find(
      (p) =>
        typeof p.review_id === 'string' &&
        typeof p.business_id === 'string' &&
        typeof p.version === 'number',
    );

    expect(generatePayload).toBeDefined();
    expect(generatePayload!.correlation_id).toBe(UPSTREAM_CORRELATION);
  });
});

// ─── Part B: generate_response → send_notification boundary ─────────
//
// The runtime assertion for this hop lives in ResponseGeneratorWorker.test.ts
// (test: "propagates incoming correlation_id into the serialized
// send_notification outbox payload"). That test runs the full handler path
// with mocked dependencies and parses the JSON-serialized payload from the
// tx mock call args to verify correlation_id matches the incoming job's value.
// Together with Part A above, the chain is proven at runtime through both
// worker boundaries.
