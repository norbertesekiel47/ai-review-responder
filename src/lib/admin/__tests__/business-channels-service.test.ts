import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { asLocationId } from '@/lib/shared/ids';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

import { getBusinessChannelEnrollments } from '../business-channels-service';

const ACCOUNT_ID = '00000000-0000-0000-0000-0000000000ac';
const L2 = asLocationId('00000000-0000-0000-0000-0000000000a2');

function enrollmentRow(overrides: Record<string, unknown> = {}) {
  return {
    channel: 'telegram',
    handle: '111111111',
    status: 'verified',
    verified_at: null,
    disabled_at: null,
    unsubscribed_at: null,
    unsubscribed_reason: null,
    expires_at: null,
    last_activity_at: null,
    location_id: null,
    ...overrides,
  };
}

describe('getBusinessChannelEnrollments', () => {
  it('masks the handle and converts every timestamptz column to an ISO string', async () => {
    resetMockSql();
    sqlReturnQueue.push([{ account_id: ACCOUNT_ID }]);
    sqlReturnQueue.push([
      enrollmentRow({
        // Real Dates, exactly what Postgres.js decodes a timestamptz into. The
        // RSC boundary preserves Date instances, so a DTO field typed `string`
        // holding a Date breaks the detail server page on first paint.
        verified_at: new Date('2026-01-01T00:00:00.000Z'),
        disabled_at: new Date('2026-02-02T01:02:03.000Z'),
        unsubscribed_at: new Date('2026-03-03T04:05:06.000Z'),
        unsubscribed_reason: 'owner_opt_out',
        expires_at: new Date('2026-04-04T07:08:09.000Z'),
        last_activity_at: new Date('2026-05-05T10:11:12.000Z'),
      }),
    ]);

    const { enrollments } = await getBusinessChannelEnrollments(mockSql as unknown as Sql, L2);

    expect(enrollments).toEqual([
      {
        channel: 'telegram',
        // telegram handle masked to the last 4 digits
        handle: '••• 1111',
        status: 'verified',
        verified_at: '2026-01-01T00:00:00.000Z',
        disabled_at: '2026-02-02T01:02:03.000Z',
        unsubscribed_at: '2026-03-03T04:05:06.000Z',
        unsubscribed_reason: 'owner_opt_out',
        expires_at: '2026-04-04T07:08:09.000Z',
        last_activity_at: '2026-05-05T10:11:12.000Z',
      },
    ]);

    // The trap guard: `toEqual` above would pass for a Date whose ISO string
    // matches, so assert the runtime type explicitly for every timestamp.
    const e = enrollments[0]!;
    for (const field of [
      'verified_at',
      'disabled_at',
      'unsubscribed_at',
      'expires_at',
      'last_activity_at',
    ] as const) {
      expect(typeof e[field]).toBe('string');
    }
  });

  it('leaves null timestamps null and labels a handle-less row as pending', async () => {
    resetMockSql();
    sqlReturnQueue.push([{ account_id: ACCOUNT_ID }]);
    sqlReturnQueue.push([enrollmentRow({ handle: null, status: 'pending_verification' })]);

    const { enrollments } = await getBusinessChannelEnrollments(mockSql as unknown as Sql, L2);

    expect(enrollments[0]!.handle).toBe('(pending verification)');
    expect(enrollments[0]!.status).toBe('pending_verification');
    expect(enrollments[0]!.verified_at).toBeNull();
    expect(enrollments[0]!.last_activity_at).toBeNull();
  });

  it('prefers a per-location override over the org-default for the same channel', async () => {
    resetMockSql();
    sqlReturnQueue.push([{ account_id: ACCOUNT_ID }]);
    // Both rows exist for the SAME channel. The query's ORDER BY places
    // overrides first, so the override row arrives first in this mocked set.
    sqlReturnQueue.push([
      enrollmentRow({ handle: '111111111', location_id: L2 }),
      enrollmentRow({ handle: '999999999', location_id: null }),
    ]);

    const { enrollments } = await getBusinessChannelEnrollments(mockSql as unknown as Sql, L2);

    expect(enrollments).toHaveLength(1);
    expect(enrollments[0]!.handle).toBe('••• 1111');
    // `location_id` is an internal precedence detail, never part of the DTO.
    expect(enrollments[0]).not.toHaveProperty('location_id');
  });

  it('returns no enrollments and skips the enrollment query for an unknown location', async () => {
    resetMockSql();
    sqlReturnQueue.push([]); // account resolution: no row

    const { enrollments } = await getBusinessChannelEnrollments(mockSql as unknown as Sql, L2);

    expect(enrollments).toEqual([]);
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0]!.text).toContain('SELECT account_id FROM businesses');
  });

  it('keys the enrollment read by account_id, scopes deliveries to the viewed location, and skips archived rows', async () => {
    resetMockSql();
    sqlReturnQueue.push([{ account_id: ACCOUNT_ID }]);
    sqlReturnQueue.push([]);

    await getBusinessChannelEnrollments(mockSql as unknown as Sql, L2);

    const enrollmentQuery = sqlCalls[1]!.text;
    expect(enrollmentQuery).toMatch(/FROM channel_enrollments e/);
    expect(enrollmentQuery).toMatch(/e\.archived_at IS NULL/);
    expect(enrollmentQuery).toMatch(/e\.account_id = \?/);
    expect(enrollmentQuery).toMatch(/e\.location_id = \?/);
    expect(enrollmentQuery).toMatch(/e\.location_id IS NULL/);
    // last_activity_at scopes deliveries to the VIEWED location, not the
    // enrollment row's legacy business_id — otherwise an org-default row would
    // surface the creator location's activity on this page.
    expect(enrollmentQuery).toMatch(/nd\.business_id = \?/);
    expect(enrollmentQuery).not.toMatch(/nd\.business_id = e\.business_id/);
    expect(sqlCalls[1]!.values).toEqual([L2, ACCOUNT_ID, L2, ['email', 'telegram', 'whatsapp']]);
  });
});
