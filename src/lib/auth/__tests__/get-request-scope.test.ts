// src/lib/auth/__tests__/get-request-scope.test.ts
//
// TDD assertions for getRequestScope SSR helper.
// Validation contract: VAL-AUTH-024, VAL-AUTH-025, VAL-AUTH-026, VAL-AUTH-027.
//
// getRequestScope is born-injected (sql is a parameter, A+ campaign PR 2a), so
// no module mocking is needed — the fragment-aware `createMockSql` harness
// (shared with worker suites) stands in for `sql`.
//
// Tests cover:
//   - Cookie points to valid location in user's account → returns that location
//   - Cookie points to archived location → falls back to primary
//   - Cookie points to location NOT in user's account → falls back to primary
//   - No cookie set → falls back to primary
//   - Cookie value is not a valid UUID → falls back to primary

import { describe, it, expect, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';
import { getRequestScope } from '../get-request-scope';
import type { AccountId, LocationId } from '@/lib/shared/ids';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001' as AccountId;
const PRIMARY_LOCATION_ID = 'b0000000-0000-0000-0000-000000000001' as LocationId;
const SECONDARY_LOCATION_ID = 'b0000000-0000-0000-0000-000000000002' as LocationId;
const ARCHIVED_LOCATION_ID = 'b0000000-0000-0000-0000-000000000003' as LocationId;
const OTHER_ACCOUNT_LOCATION_ID = 'b0000000-0000-0000-0000-000000000099' as LocationId;

interface LocationRow {
  id: string;
  is_primary: boolean;
  archived_at: Date | null;
}

/** Default location set: primary + secondary + archived. */
function defaultLocations(): LocationRow[] {
  return [
    { id: PRIMARY_LOCATION_ID, is_primary: true, archived_at: null },
    { id: SECONDARY_LOCATION_ID, is_primary: false, archived_at: null },
    { id: ARCHIVED_LOCATION_ID, is_primary: false, archived_at: new Date('2026-01-01') },
  ];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

let harness: MockSqlHarness;
let mockSql: Sql;

beforeEach(() => {
  harness = createMockSql();
  mockSql = harness.mockSql as unknown as Sql;
});

describe('getRequestScope', () => {
  it('returns cookie location when it belongs to the account and is not archived', async () => {
    harness.sqlReturnQueue.push(defaultLocations());

    const result = await getRequestScope(mockSql, ACCOUNT_ID, SECONDARY_LOCATION_ID);

    expect(result.currentLocationId).toBe(SECONDARY_LOCATION_ID);
    expect(result.accountId).toBe(ACCOUNT_ID);
  });

  it('falls back to primary location when cookie points to archived location', async () => {
    harness.sqlReturnQueue.push(defaultLocations());

    const result = await getRequestScope(mockSql, ACCOUNT_ID, ARCHIVED_LOCATION_ID);

    expect(result.currentLocationId).toBe(PRIMARY_LOCATION_ID);
  });

  it('falls back to primary location when cookie points to location not in user account', async () => {
    harness.sqlReturnQueue.push(defaultLocations());

    const result = await getRequestScope(mockSql, ACCOUNT_ID, OTHER_ACCOUNT_LOCATION_ID);

    expect(result.currentLocationId).toBe(PRIMARY_LOCATION_ID);
  });

  it('falls back to primary location when no cookie is set (null)', async () => {
    harness.sqlReturnQueue.push(defaultLocations());

    const result = await getRequestScope(mockSql, ACCOUNT_ID, null);

    expect(result.currentLocationId).toBe(PRIMARY_LOCATION_ID);
  });

  it('falls back to primary location when cookie value is not a valid UUID', async () => {
    harness.sqlReturnQueue.push(defaultLocations());

    const result = await getRequestScope(mockSql, ACCOUNT_ID, 'not-a-uuid' as LocationId);

    expect(result.currentLocationId).toBe(PRIMARY_LOCATION_ID);
  });

  it('returns the first non-archived location when no is_primary exists', async () => {
    const locations: LocationRow[] = [
      { id: SECONDARY_LOCATION_ID, is_primary: false, archived_at: null },
      { id: ARCHIVED_LOCATION_ID, is_primary: false, archived_at: new Date('2026-01-01') },
    ];
    harness.sqlReturnQueue.push(locations);

    const result = await getRequestScope(mockSql, ACCOUNT_ID, null);

    // Should pick the first non-archived as fallback
    expect(result.currentLocationId).toBe(SECONDARY_LOCATION_ID);
  });

  it('throws when account has no active locations at all', async () => {
    const locations: LocationRow[] = [
      { id: ARCHIVED_LOCATION_ID, is_primary: true, archived_at: new Date('2026-01-01') },
    ];
    harness.sqlReturnQueue.push(locations);

    await expect(getRequestScope(mockSql, ACCOUNT_ID, null)).rejects.toThrow(
      /no active location/i,
    );
  });
});
