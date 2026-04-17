import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { ValidatePlaceIdPayload } from '../../src/lib/shared/worker-types';

// ── Hoisted state shared between mock factories and tests ──────────────
const {
  mockSql,
  mockTx,
  mockMarkOutboxCompleted,
  mockMarkOutboxFailed,
  mockResolvePlaceId,
} = vi.hoisted(() => {
  const mockTx = vi.fn(
    (_strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
      return Promise.resolve([]);
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockSql: any = vi.fn(
    (_strings: TemplateStringsArray, ..._values: unknown[]): Promise<unknown[]> => {
      return Promise.resolve([]);
    },
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockSql.begin = vi.fn(async (callback: (tx: any) => Promise<any>) => {
    return callback(mockTx);
  });

  const mockMarkOutboxCompleted = vi.fn();
  const mockMarkOutboxFailed = vi.fn();
  const mockResolvePlaceId = vi.fn<(data: unknown) => Promise<string>>();

  return {
    mockSql,
    mockTx,
    mockMarkOutboxCompleted,
    mockMarkOutboxFailed,
    mockResolvePlaceId,
  };
});

// ── Module mocks (hoisted by vitest) ───────────────────────────────────
vi.mock('../../src/lib/db/server', () => ({
  sql: mockSql,
}));

vi.mock('../../src/lib/shared/outbox', () => ({
  markOutboxCompleted: mockMarkOutboxCompleted,
  markOutboxFailed: mockMarkOutboxFailed,
}));

vi.mock('../../src/lib/reviews/place-id-resolver', () => ({
  resolvePlaceId: mockResolvePlaceId,
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => 'deterministic-uuid-v7'),
}));

// Import after mocks are wired
import { handlePlaceIdValidation } from '../jobs/PlaceIdValidationWorker';

// ── Helpers ────────────────────────────────────────────────────────────

function makeJob(
  overrides: Partial<ValidatePlaceIdPayload> & { google_maps_url?: string } = {},
  jobId = 'outbox-test-place-id-001',
): Job<ValidatePlaceIdPayload> {
  return {
    data: {
      business_id: 'biz-001',
      google_maps_url: 'https://maps.google.com/?q=place_id:ChIJgUbEo8cfqokR5lP9_Wh_DaM',
      correlation_id: 'corr-upstream-abc',
      ...overrides,
    },
    id: jobId,
  } as Job<ValidatePlaceIdPayload>;
}

/**
 * Collects every JSON-string argument passed to sql-tagged-template calls
 * (both the top-level `sql` and the transaction `tx`) and parses them.
 * The sync_reviews payload is the JSON object containing `google_place_id`.
 */
function findSyncReviewsPayload(): Record<string, unknown> | undefined {
  const allCalls: unknown[] = [
    ...mockSql.mock.calls.flat(),
    ...mockTx.mock.calls.flat(),
  ];
  const jsonStrings = allCalls.filter(
    (arg: unknown): arg is string => typeof arg === 'string' && arg.startsWith('{'),
  );
  const payloads = jsonStrings
    .map((s) => {
      try {
        return JSON.parse(s) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((p): p is Record<string, unknown> => p !== null);
  return payloads.find((p) => 'google_place_id' in p);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('PlaceIdValidationWorker – handlePlaceIdValidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockImplementation(() => Promise.resolve([]));
    mockTx.mockImplementation(() => Promise.resolve([]));
  });

  it('propagates correlation_id into sync_reviews outbox payload on successful resolution', async () => {
    // Business SELECT returns a matching row — URL contains a canonical Place ID,
    // so the handler takes the fast path (no resolver call, just UPDATE + enqueue).
    mockSql.mockImplementationOnce(() =>
      Promise.resolve([{ id: 'biz-001', google_place_id: null }]),
    );

    await handlePlaceIdValidation(makeJob());

    const syncPayload = findSyncReviewsPayload();
    expect(syncPayload).toBeDefined();
    expect(syncPayload!.business_id).toBe('biz-001');
    expect(syncPayload!.google_place_id).toBe('ChIJgUbEo8cfqokR5lP9_Wh_DaM');
    expect(syncPayload!.correlation_id).toBe('corr-upstream-abc');

    expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-test-place-id-001');
    expect(mockMarkOutboxFailed).not.toHaveBeenCalled();
  });

  it('also propagates correlation_id when resolver is used (SerpAPI path)', async () => {
    // URL has no canonical Place ID — forces the resolver path.
    mockSql.mockImplementationOnce(() =>
      Promise.resolve([{ id: 'biz-002', google_place_id: null }]),
    );
    mockResolvePlaceId.mockResolvedValueOnce('ChIJResolvedFromSerpApi12345');

    await handlePlaceIdValidation(
      makeJob({
        business_id: 'biz-002',
        // URL with business name + coords but no Place ID → resolver path
        google_maps_url:
          'https://www.google.com/maps/place/Cafe+Test/@37.7749,-122.4194,15z',
        correlation_id: 'corr-resolver-xyz',
      }),
    );

    expect(mockResolvePlaceId).toHaveBeenCalledTimes(1);

    const syncPayload = findSyncReviewsPayload();
    expect(syncPayload).toBeDefined();
    expect(syncPayload!.business_id).toBe('biz-002');
    expect(syncPayload!.google_place_id).toBe('ChIJResolvedFromSerpApi12345');
    expect(syncPayload!.correlation_id).toBe('corr-resolver-xyz');
  });

  it('does not create sync_reviews outbox entry when resolver cannot identify a place', async () => {
    // Business exists, but URL has no canonical Place ID and resolver throws a
    // permanent error (no name + no coords, or no match found).
    mockSql.mockImplementationOnce(() =>
      Promise.resolve([{ id: 'biz-003', google_place_id: null }]),
    );
    mockResolvePlaceId.mockRejectedValueOnce(
      new Error('Could not verify business location — try using the search field instead'),
    );

    await handlePlaceIdValidation(
      makeJob({
        business_id: 'biz-003',
        google_maps_url:
          'https://www.google.com/maps/place/Unknown+Place/@37.0,-122.0,15z',
        correlation_id: 'corr-failure-999',
      }),
    );

    // Failure path should fail the outbox + insert a review_exception
    expect(mockMarkOutboxFailed).toHaveBeenCalledWith(
      'outbox-test-place-id-001',
      expect.stringContaining('Could not verify business location'),
    );
    expect(mockMarkOutboxCompleted).not.toHaveBeenCalled();

    // No sync_reviews payload should have been built
    const syncPayload = findSyncReviewsPayload();
    expect(syncPayload).toBeUndefined();

    // sql.begin should NOT have been called on the failure path (no UPDATE + enqueue)
    expect(mockSql.begin).not.toHaveBeenCalled();
  });
});
