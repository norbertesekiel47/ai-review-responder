// src/lib/notifications/__tests__/resolve-channels.test.ts
//
// Table-driven tests for resolveChannels — the single chokepoint that
// resolves channels for a given (accountId, locationId).
//
// Validation contract: VAL-NOTIF-001 through VAL-NOTIF-010, VAL-NOTIF-020.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChannelId } from '../channels/types';
import { CHANNEL_IDS } from '../channels/types';

// ── Hoisted mock state ──────────────────────────────────────────────────

const {
  sqlReturnQueue,
  mockSql,
  mockRedisGet,
  mockRedisSet,
  mockRedisKeys,
  mockRedisDel,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const result = sqlReturnQueue.shift() ?? [];
    return Promise.resolve(result);
  });

  return {
    sqlReturnQueue,
    mockSql,
    mockRedisGet: vi.fn().mockResolvedValue(null),
    mockRedisSet: vi.fn().mockResolvedValue('OK'),
    mockRedisKeys: vi.fn().mockResolvedValue([]),
    mockRedisDel: vi.fn().mockResolvedValue(0),
  };
});

vi.mock('../../db/server', () => ({
  sql: mockSql,
}));

vi.mock('../../db/redis-cache', () => ({
  getCacheRedis: () => ({
    get: mockRedisGet,
    set: mockRedisSet,
    keys: mockRedisKeys,
    del: mockRedisDel,
  }),
}));

// Import after mocks are wired
import { resolveChannels, invalidateChannelCache, safeInvalidateChannelCache } from '../resolve-channels';
import { asAccountId, asLocationId } from '@/lib/shared/ids';

// ── Test fixtures ────────────────────────────────────────────────────────

const ACCOUNT_A = asAccountId('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
const LOCATION_L1 = asLocationId('11111111-1111-1111-1111-111111111111');
const LOCATION_L2 = asLocationId('22222222-2222-2222-2222-222222222222');

interface EnrollmentRow {
  channel: ChannelId;
  handle: string;
  location_id: string | null;
  status: string;
  archived_at: Date | null;
  unsubscribed_at: Date | null;
  account_id: string;
}

function makeEnrollmentRow(overrides: Partial<EnrollmentRow> = {}): EnrollmentRow {
  return {
    channel: 'email',
    handle: 'owner@example.com',
    location_id: null,
    status: 'verified',
    archived_at: null,
    unsubscribed_at: null,
    account_id: ACCOUNT_A,
    ...overrides,
  };
}

/**
 * Seeds the SQL mock queue for a non-archived location + enrollment query.
 * The resolver makes 2 SQL calls:
 *   1. SELECT archived_at FROM businesses WHERE id = $locationId AND account_id = $accountId
 *   2. SELECT channel, handle, location_id FROM channel_enrollments WHERE ...
 *
 * This helper pushes both results into the queue in order.
 */
function seedSqlQueue(enrollments: EnrollmentRow[]): void {
  sqlReturnQueue.push(
    [{ archived_at: null }], // 1st call: location is not archived
    enrollments,              // 2nd call: channel_enrollments rows
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function beforeEachSetup() {
  sqlReturnQueue.length = 0;
  mockSql.mockClear();
  mockRedisGet.mockReset().mockResolvedValue(null);
  mockRedisSet.mockReset().mockResolvedValue('OK');
  mockRedisKeys.mockReset().mockResolvedValue([]);
  mockRedisDel.mockReset().mockResolvedValue(0);
}

// ── Tests: Channel resolution logic (VAL-NOTIF-001 through VAL-NOTIF-007) ──

describe('resolveChannels', () => {
  beforeEach(beforeEachSetup);

  // VAL-NOTIF-001: Org-default enrollment returned when no per-location override exists
  it('returns org-default enrollments when no per-location override exists', async () => {
    seedSqlQueue([
      makeEnrollmentRow({ channel: 'email', handle: 'owner@example.com', location_id: null }),
      makeEnrollmentRow({ channel: 'telegram', handle: '@ownerbot', location_id: null }),
    ]);

    const result = await resolveChannels(mockSql, ACCOUNT_A, LOCATION_L1);

    expect(result).toEqual([
      { channel: 'email', handle: 'owner@example.com', location_id: null },
      { channel: 'telegram', handle: '@ownerbot', location_id: null },
    ]);
  });

  // VAL-NOTIF-002: Per-location override enrollment returned when one exists
  it('returns per-location override when one exists', async () => {
    seedSqlQueue([
      makeEnrollmentRow({ channel: 'telegram', handle: '@ownerbot', location_id: null }),
      makeEnrollmentRow({ channel: 'telegram', handle: '@downtownbot', location_id: LOCATION_L1 }),
    ]);

    const result = await resolveChannels(mockSql, ACCOUNT_A, LOCATION_L1);

    // Per-location override should be returned for telegram
    const telegramEnrollments = result.filter(c => c.channel === 'telegram');
    expect(telegramEnrollments).toHaveLength(1);
    expect(telegramEnrollments[0]!.handle).toBe('@downtownbot');
    expect(telegramEnrollments[0]!.location_id).toBe(LOCATION_L1);
  });

  // VAL-NOTIF-003: Per-location override beats org-default for the SAME channel
  it('returns exactly one enrollment per channel when both org-default and per-location exist', async () => {
    seedSqlQueue([
      makeEnrollmentRow({ channel: 'telegram', handle: '@ownerbot', location_id: null }),
      makeEnrollmentRow({ channel: 'telegram', handle: '@downtownbot', location_id: LOCATION_L1 }),
      makeEnrollmentRow({ channel: 'email', handle: 'owner@example.com', location_id: null }),
    ]);

    const result = await resolveChannels(mockSql, ACCOUNT_A, LOCATION_L1);

    // One entry per channel
    const channels = result.map(c => c.channel);
    expect(channels).toEqual(['email', 'telegram']);

    // Telegram is the per-location override
    const telegram = result.find(c => c.channel === 'telegram')!;
    expect(telegram.handle).toBe('@downtownbot');
    expect(telegram.location_id).toBe(LOCATION_L1);

    // Email is the org-default (no per-location override)
    const email = result.find(c => c.channel === 'email')!;
    expect(email.handle).toBe('owner@example.com');
    expect(email.location_id).toBeNull();
  });

  // VAL-NOTIF-004: Channels with no enrollment at either level omitted
  it('omits channels with no enrollment at either level', async () => {
    seedSqlQueue([
      makeEnrollmentRow({ channel: 'email', handle: 'owner@example.com', location_id: null }),
      makeEnrollmentRow({ channel: 'telegram', handle: '@ownerbot', location_id: null }),
    ]);

    const result = await resolveChannels(mockSql, ACCOUNT_A, LOCATION_L1);

    const channels = result.map(c => c.channel);
    expect(channels).not.toContain('whatsapp');
  });

  // VAL-NOTIF-005: Archived channel_enrollments rows ignored
  // NOTE: The SQL query already filters archived_at IS NULL, so archived rows
  // won't even be returned from the query. The test verifies the query shape.
  it('ignores archived channel_enrollments rows (query shape)', async () => {
    seedSqlQueue([
      makeEnrollmentRow({ channel: 'email', handle: 'owner@example.com', location_id: null }),
      // The archived telegram row would be filtered out by the SQL WHERE clause
      // and never reach the application code.
    ]);

    const result = await resolveChannels(mockSql, ACCOUNT_A, LOCATION_L1);

    expect(result).toEqual([
      { channel: 'email', handle: 'owner@example.com', location_id: null },
    ]);

    // Verify the SQL query includes the archived_at filter
    const enrollmentsCall = mockSql.mock.calls[1];
    const [template] = enrollmentsCall as [TemplateStringsArray, ...unknown[]];
    const queryText = template.join('?');
    expect(queryText).toMatch(/archived_at IS NULL/);
  });

  // VAL-NOTIF-006: Rows with status != 'verified' ignored (query shape)
  it('ignores rows with status != verified (query shape)', async () => {
    seedSqlQueue([
      makeEnrollmentRow({ channel: 'email', handle: 'owner@example.com', location_id: null }),
    ]);

    const _result = await resolveChannels(mockSql, ACCOUNT_A, LOCATION_L1);

    // Verify the SQL query includes the status = 'verified' filter
    const enrollmentsCall = mockSql.mock.calls[1];
    const [template] = enrollmentsCall as [TemplateStringsArray, ...unknown[]];
    const queryText = template.join('?');
    expect(queryText).toMatch(/status = 'verified'/);
  });

  // VAL-NOTIF-007: Rows with unsubscribed_at IS NOT NULL ignored (query shape)
  it('ignores rows with unsubscribed_at IS NOT NULL (query shape)', async () => {
    seedSqlQueue([
      makeEnrollmentRow({ channel: 'email', handle: 'owner@example.com', location_id: null }),
    ]);

    const _result = await resolveChannels(mockSql, ACCOUNT_A, LOCATION_L1);

    // Verify the SQL query includes the unsubscribed_at filter
    const enrollmentsCall = mockSql.mock.calls[1];
    const [template] = enrollmentsCall as [TemplateStringsArray, ...unknown[]];
    const queryText = template.join('?');
    expect(queryText).toMatch(/unsubscribed_at IS NULL/);
  });

  // VAL-NOTIF-020: resolveChannels returns no channels for an archived location
  it('returns empty result for archived location', async () => {
    const ARCHIVED_LOCATION = asLocationId('99999999-9999-9999-9999-999999999999');

    // The resolver checks if the location is archived first
    // and returns empty immediately without querying channel_enrollments
    sqlReturnQueue.push([
      { archived_at: new Date('2026-01-01') },
    ]);

    const result = await resolveChannels(mockSql, ACCOUNT_A, ARCHIVED_LOCATION);

    expect(result).toEqual([]);
    // Should NOT query channel_enrollments (only 1 SQL call for archived check)
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  // Additional edge case: no enrollments at all
  it('returns empty array when account has no channel enrollments', async () => {
    seedSqlQueue([]);

    const result = await resolveChannels(mockSql, ACCOUNT_A, LOCATION_L1);

    expect(result).toEqual([]);
  });

  // Edge case: per-location override for a DIFFERENT location should not affect this one
  it('does not use per-location override from a different location', async () => {
    seedSqlQueue([
      makeEnrollmentRow({ channel: 'telegram', handle: '@ownerbot', location_id: null }),
      // The SQL WHERE clause filters to (location_id = $L1 OR location_id IS NULL),
      // so L2 overrides won't be in the result set at all.
      makeEnrollmentRow({ channel: 'email', handle: 'owner@example.com', location_id: null }),
    ]);

    // Requesting channels for L1 — the L2 override is excluded by SQL
    const result = await resolveChannels(mockSql, ACCOUNT_A, LOCATION_L1);

    const telegram = result.find(c => c.channel === 'telegram')!;
    expect(telegram.handle).toBe('@ownerbot'); // org-default, not L2 override
    expect(telegram.location_id).toBeNull();
  });

  // VAL-NOTIF-018: WhatsApp/Telegram channels included in resolver result when configured
  it('includes WhatsApp channel when enrollment exists', async () => {
    seedSqlQueue([
      makeEnrollmentRow({ channel: 'email', handle: 'owner@example.com', location_id: null }),
      makeEnrollmentRow({ channel: 'whatsapp', handle: '+15551234567', location_id: null }),
    ]);

    const result = await resolveChannels(mockSql, ACCOUNT_A, LOCATION_L1);

    expect(result.map(c => c.channel)).toContain('whatsapp');
  });

  it('includes WhatsApp channel at per-location scope when enrollment exists', async () => {
    seedSqlQueue([
      makeEnrollmentRow({ channel: 'email', handle: 'owner@example.com', location_id: null }),
      makeEnrollmentRow({ channel: 'whatsapp', handle: '+15559876543', location_id: LOCATION_L1 }),
    ]);

    const result = await resolveChannels(mockSql, ACCOUNT_A, LOCATION_L1);

    const whatsapp = result.find(c => c.channel === 'whatsapp')!;
    expect(whatsapp.handle).toBe('+15559876543');
    expect(whatsapp.location_id).toBe(LOCATION_L1);
  });
});

// ── Tests: Cache behavior (VAL-NOTIF-008, VAL-NOTIF-009) ─────────────────

describe('resolveChannels — channel cache', () => {
  beforeEach(beforeEachSetup);

  // VAL-NOTIF-008: Cache stores result with 5-min TTL keyed on (account_id, location_id)
  it('caches result in Redis with 5-min TTL on cache miss', async () => {
    seedSqlQueue([
      makeEnrollmentRow({ channel: 'email', handle: 'owner@example.com', location_id: null }),
    ]);

    await resolveChannels(mockSql, ACCOUNT_A, LOCATION_L1);

    // Redis SET should have been called with TTL = 300 (5 minutes)
    expect(mockRedisSet).toHaveBeenCalledTimes(1);
    const setCall = mockRedisSet.mock.calls[0]!;
    // Key should contain both account_id and location_id
    expect(setCall[0]).toMatch(/rch:channels:v2:/);
    expect(setCall[0]).toContain(ACCOUNT_A);
    expect(setCall[0]).toContain(LOCATION_L1);
    // TTL should be 300 seconds (5 minutes)
    expect(setCall[2]).toBe('EX');
    expect(setCall[3]).toBe(300);
  });

  it('returns cached result on cache hit without SQL query', async () => {
    // Simulate cache hit
    mockRedisGet.mockResolvedValueOnce(
      JSON.stringify([
        { channel: 'email', handle: 'cached@example.com', location_id: null },
      ]),
    );

    const result = await resolveChannels(mockSql, ACCOUNT_A, LOCATION_L1);

    // Should return cached data
    expect(result).toEqual([
      { channel: 'email', handle: 'cached@example.com', location_id: null },
    ]);
    // SQL should NOT have been called
    expect(mockSql).not.toHaveBeenCalled();
  });

  // VAL-NOTIF-009: Cache invalidated on any channel_enrollments write for that account
  it('invalidates cache for all locations of an account on channel_enrollments write', async () => {
    // Simulate existing cache keys for the account
    mockRedisKeys.mockResolvedValueOnce([
      `rch:channels:${ACCOUNT_A}:${LOCATION_L1}`,
      `rch:channels:${ACCOUNT_A}:${LOCATION_L2}`,
    ]);

    await invalidateChannelCache(ACCOUNT_A);

    // Should delete all keys for this account
    expect(mockRedisDel).toHaveBeenCalledTimes(1);
    // The keys array passed to del should contain both location keys
    const delArgs = mockRedisDel.mock.calls[0]![0];
    expect(delArgs).toHaveLength(2);
  });

  it('logs and resolves when safe cache invalidation fails', async () => {
    const logger = { warn: vi.fn() };
    mockRedisKeys.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(
      safeInvalidateChannelCache(ACCOUNT_A, 'test.context', logger),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      'channel-cache-invalidate-failed',
      expect.objectContaining({
        accountId: ACCOUNT_A,
        context: 'test.context',
        error: 'redis unavailable',
      }),
    );
  });

  it('cache miss followed by cache hit returns same data', async () => {
    // First call: cache miss
    seedSqlQueue([
      makeEnrollmentRow({ channel: 'email', handle: 'owner@example.com', location_id: null }),
      makeEnrollmentRow({ channel: 'telegram', handle: '@ownerbot', location_id: null }),
    ]);

    const result1 = await resolveChannels(mockSql, ACCOUNT_A, LOCATION_L1);
    expect(result1).toHaveLength(2);

    // Second call: cache hit
    mockRedisGet.mockResolvedValueOnce(
      JSON.stringify(result1),
    );

    const result2 = await resolveChannels(mockSql, ACCOUNT_A, LOCATION_L1);
    expect(result2).toEqual(result1);

    // SQL should only have been called on the first call (2 SQL calls)
    expect(mockSql).toHaveBeenCalledTimes(2);
  });

  it('caches empty result for archived locations', async () => {
    const ARCHIVED_LOCATION = asLocationId('99999999-9999-9999-9999-999999999999');

    sqlReturnQueue.push([
      { archived_at: new Date('2026-01-01') },
    ]);

    await resolveChannels(mockSql, ACCOUNT_A, ARCHIVED_LOCATION);

    // Even empty results should be cached
    expect(mockRedisSet).toHaveBeenCalledTimes(1);
    const setCall = mockRedisSet.mock.calls[0]!;
    expect(setCall[0]).toContain(ARCHIVED_LOCATION);
    expect(setCall[3]).toBe(300);
  });
});

// ── Tests: Stale channel guard (SMS removal) ─────────────────────────────

describe('resolveChannels — stale channel guard', () => {
  beforeEach(beforeEachSetup);

  // Guard: SQL filters to the supported channel set so stale 'sms' rows in
  // channel_enrollments.channel (TEXT column) are excluded at the DB layer.
  it('filters the enrollment query to supported channels only', async () => {
    seedSqlQueue([
      makeEnrollmentRow({ channel: 'email', handle: 'owner@example.com', location_id: null }),
    ]);

    await resolveChannels(mockSql, ACCOUNT_A, LOCATION_L1);

    // Second SQL call is the channel_enrollments query
    const enrollmentsCall = mockSql.mock.calls[1];
    const [template, ...boundValues] = enrollmentsCall as [TemplateStringsArray, ...unknown[]];
    const queryText = template.join('?');

    // Must use the = ANY(...::text[]) idiom (single owner: CHANNEL_IDS)
    expect(queryText).toMatch(/channel = ANY\(/);
    // The channel list is a bound parameter (not inlined), so it must not
    // appear as SQL literals in the query text.
    expect(queryText).not.toContain("'email'");
    expect(queryText).not.toContain("'sms'");
    // The bound values must include an array equal to [...CHANNEL_IDS]
    const channelArray = boundValues.find(
      (v) => Array.isArray(v) && (v as unknown[]).includes('email'),
    );
    expect(channelArray).toEqual([...CHANNEL_IDS]);
  });

  // Guard: cache namespace bumped to v2 so entries cached before SMS removal
  // (which may contain 'sms' resolutions) are unreadable instead of waiting
  // out the 300s TTL.
  it('uses the v2 cache namespace', async () => {
    seedSqlQueue([
      makeEnrollmentRow({ channel: 'email', handle: 'owner@example.com', location_id: null }),
    ]);

    await resolveChannels(mockSql, ACCOUNT_A, LOCATION_L1);

    // Both get (cache miss) and set (cache store) must use the v2 prefix
    const getKey = mockRedisGet.mock.calls[0]![0] as string;
    expect(getKey).toMatch(/^rch:channels:v2:/);

    const setKey = mockRedisSet.mock.calls[0]![0] as string;
    expect(setKey).toMatch(/^rch:channels:v2:/);
  });
});

// ── Tests: Query shape verification ──────────────────────────────────────

describe('resolveChannels — query shape', () => {
  beforeEach(beforeEachSetup);

  it('queries channel_enrollments with account_id and location filters', async () => {
    seedSqlQueue([
      makeEnrollmentRow({ channel: 'email', handle: 'owner@example.com', location_id: null }),
    ]);

    await resolveChannels(mockSql, ACCOUNT_A, LOCATION_L1);

    // Check that the SQL query includes the right filters
    // Second SQL call is the channel_enrollments query
    const enrollmentsCall = mockSql.mock.calls[1];
    const [template] = enrollmentsCall as [TemplateStringsArray, ...unknown[]];
    const queryText = template.join('?');

    expect(queryText).toMatch(/channel_enrollments/);
    expect(queryText).toMatch(/account_id/);
    expect(queryText).toMatch(/location_id/);
    expect(queryText).toMatch(/status = 'verified'/);
    expect(queryText).toMatch(/archived_at IS NULL/);
    expect(queryText).toMatch(/unsubscribed_at IS NULL/);
  });

  it('checks archived state of location before querying enrollments', async () => {
    seedSqlQueue([
      makeEnrollmentRow({ channel: 'email', handle: 'owner@example.com', location_id: null }),
    ]);

    await resolveChannels(mockSql, ACCOUNT_A, LOCATION_L1);

    // First SQL call should check archived_at on the location
    const archivedCheckCall = mockSql.mock.calls[0];
    const [template] = archivedCheckCall as [TemplateStringsArray, ...unknown[]];
    const queryText = template.join('?');

    expect(queryText).toMatch(/businesses/);
    expect(queryText).toMatch(/archived_at/);
  });
});
