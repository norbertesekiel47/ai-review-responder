import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type { Sql } from 'postgres';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

import { getAdminOffboardings, type AdminOffboarding } from '../offboardings-service';

/**
 * Every timestamptz column on `account_offboardings` (migration 056) as a real
 * `Date` — exactly what Postgres.js decodes them into. The RSC boundary
 * preserves `Date` instances, so a DTO field typed `string` holding a Date
 * breaks the server page on first paint (and no route test can catch it,
 * because `JSON.stringify` hides the difference).
 */
function rowWithDateTimestamps() {
  return {
    id: 'off-1',
    account_id: 'acct-1',
    account_name: 'Acme Dental',
    subscription_status: 'cancelled',
    mode: 'delete_data',
    status: 'failed',
    failed_step: 'teardown',
    last_error: null,
    requested_at: new Date('2026-06-01T12:00:00.000Z'),
    access_ends_at: new Date('2026-06-02T12:00:00.000Z'),
    teardown_started_at: new Date('2026-06-03T12:00:00.000Z'),
    teardown_completed_at: new Date('2026-06-04T12:00:00.000Z'),
    purge_after: new Date('2026-07-01T12:00:00.000Z'),
    purge_started_at: new Date('2026-07-02T12:00:00.000Z'),
    purge_cancelled_at: new Date('2026-07-03T12:00:00.000Z'),
    purged_at: new Date('2026-07-04T12:00:00.000Z'),
    terminal_at: new Date('2026-07-05T12:00:00.000Z'),
    stripe_step: 'success',
    zernio_accounts_step: 'failed',
    zernio_profiles_step: 'not_applicable',
    location_archival_step: 'success',
    job_terminalization_step: 'success',
    retry_count: 2,
    provider_dispositions: [],
    is_stuck: true,
  };
}

/** The nine timestamptz columns → their DTO field, for the type audit below. */
const TIMESTAMP_FIELDS = [
  'requestedAt',
  'accessEndsAt',
  'teardownStartedAt',
  'teardownCompletedAt',
  'purgeAfter',
  'purgeStartedAt',
  'purgeCancelledAt',
  'purgedAt',
  'terminalAt',
] as const satisfies readonly (keyof AdminOffboarding)[];

describe('getAdminOffboardings', () => {
  it('maps a row with Date timestamps to ISO strings and passes is_stuck through', async () => {
    resetMockSql();
    sqlReturnQueue.push([rowWithDateTimestamps()]);
    sqlReturnQueue.push([{ total: 7 }]);

    const { offboardings, total } = await getAdminOffboardings(mockSql as unknown as Sql, {
      limit: 50,
      offset: 0,
    });

    expect(total).toBe(7);
    expect(offboardings).toHaveLength(1);
    const item = offboardings[0]!;

    // The trap guard: `toEqual` on an ISO string would also pass for a Date
    // whose serialization matches, so assert the RUNTIME type of every one.
    for (const field of TIMESTAMP_FIELDS) {
      expect(typeof item[field], `${field} must cross the RSC boundary as a string`).toBe('string');
    }

    expect(item.requestedAt).toBe('2026-06-01T12:00:00.000Z');
    expect(item.accessEndsAt).toBe('2026-06-02T12:00:00.000Z');
    expect(item.teardownStartedAt).toBe('2026-06-03T12:00:00.000Z');
    expect(item.teardownCompletedAt).toBe('2026-06-04T12:00:00.000Z');
    expect(item.purgeAfter).toBe('2026-07-01T12:00:00.000Z');
    expect(item.purgeStartedAt).toBe('2026-07-02T12:00:00.000Z');
    expect(item.purgeCancelledAt).toBe('2026-07-03T12:00:00.000Z');
    expect(item.purgedAt).toBe('2026-07-04T12:00:00.000Z');
    expect(item.terminalAt).toBe('2026-07-05T12:00:00.000Z');

    expect(item.isStuck).toBe(true);
    expect(item.retryCount).toBe(2);
    expect(item.providerSteps).toEqual({
      stripe: 'success',
      zernioAccounts: 'failed',
      zernioProfiles: 'not_applicable',
      locationArchival: 'success',
      jobTerminalization: 'success',
    });

    expect(sqlCalls[0]!.text).toContain('FROM account_offboardings ao');
    expect(sqlCalls[0]!.text).toContain('JOIN accounts a ON a.id = ao.account_id');
    expect(sqlCalls[0]!.text).toContain('AS is_stuck');
    expect(sqlCalls[0]!.text).toContain('ao.terminal_at IS NULL');
    expect(sqlCalls[0]!.values).toEqual([50, 0]);
    expect(sqlCalls[1]!.text).toContain('SELECT COUNT(*)::int AS total');
  });

  it('passes NULL timestamps through as null', async () => {
    resetMockSql();
    sqlReturnQueue.push([
      {
        ...rowWithDateTimestamps(),
        access_ends_at: null,
        teardown_started_at: null,
        teardown_completed_at: null,
        purge_after: null,
        purge_started_at: null,
        purge_cancelled_at: null,
        purged_at: null,
        terminal_at: null,
        is_stuck: false,
      },
    ]);
    sqlReturnQueue.push([{ total: 1 }]);

    const { offboardings } = await getAdminOffboardings(mockSql as unknown as Sql, {
      limit: 50,
      offset: 0,
    });

    const item = offboardings[0]!;
    expect(item.requestedAt).toBe('2026-06-01T12:00:00.000Z');
    expect(item.accessEndsAt).toBeNull();
    expect(item.terminalAt).toBeNull();
    expect(item.isStuck).toBe(false);
  });

  it('keeps only concrete admin provider dispositions from the JSONB column', async () => {
    resetMockSql();
    sqlReturnQueue.push([
      {
        ...rowWithDateTimestamps(),
        provider_dispositions: [
          {
            type: 'admin_provider_disposition',
            provider: 'zernio',
            resource_type: 'account',
            scrubbed_resource_reference: 'sha256:abc',
            reason: 'Provider support confirmed teardown.',
            admin_actor_user_id: 'admin-1',
            recorded_at: '2026-06-07T12:00:00.000Z',
            ticket: 'SUP-123',
          },
          { type: 'something_else', provider: 'zernio' },
        ],
      },
    ]);
    sqlReturnQueue.push([{ total: 1 }]);

    const { offboardings } = await getAdminOffboardings(mockSql as unknown as Sql, {
      limit: 50,
      offset: 0,
    });

    expect(offboardings[0]!.providerDispositions).toHaveLength(1);
    expect(offboardings[0]!.providerDispositions[0]!.ticket).toBe('SUP-123');
  });

  describe('scrubAdminLastError (security-relevant redactor, moved byte-for-byte)', () => {
    async function lastErrorFor(raw: string): Promise<string | null> {
      resetMockSql();
      sqlReturnQueue.push([{ ...rowWithDateTimestamps(), last_error: raw }]);
      sqlReturnQueue.push([{ total: 1 }]);
      const { offboardings } = await getAdminOffboardings(mockSql as unknown as Sql, {
        limit: 50,
        offset: 0,
      });
      return offboardings[0]!.lastError;
    }

    it('redacts a Bearer token', async () => {
      const scrubbed = await lastErrorFor('zernio rejected: Bearer live-secret-abc123');
      expect(scrubbed).toContain('Bearer [redacted]');
      expect(scrubbed).not.toContain('live-secret-abc123');
    });

    it('redacts an api_key= pair', async () => {
      const scrubbed = await lastErrorFor('call failed api_key=raw-api-key-value and died');
      expect(scrubbed).toContain('[redacted]');
      expect(scrubbed).not.toContain('raw-api-key-value');
    });

    it('truncates at 500 characters', async () => {
      const scrubbed = await lastErrorFor('x'.repeat(900));
      expect(scrubbed).toHaveLength(500);
    });

    it('returns null for a null last_error', async () => {
      resetMockSql();
      sqlReturnQueue.push([{ ...rowWithDateTimestamps(), last_error: null }]);
      sqlReturnQueue.push([{ total: 1 }]);
      const { offboardings } = await getAdminOffboardings(mockSql as unknown as Sql, {
        limit: 50,
        offset: 0,
      });
      expect(offboardings[0]!.lastError).toBeNull();
    });
  });

  it('returns an empty list and a zero total for empty results', async () => {
    resetMockSql();
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    const result = await getAdminOffboardings(mockSql as unknown as Sql, { limit: 50, offset: 100 });

    expect(result).toEqual({ offboardings: [], total: 0 });
    expect(sqlCalls[0]!.values).toEqual([50, 100]);
  });
});
