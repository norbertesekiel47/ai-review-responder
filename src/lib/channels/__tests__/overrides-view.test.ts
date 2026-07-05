// getChannelOverridesView takes `sql` as an explicit leading param (A+
// campaign 2e-2b); the fragment-aware createMockSql harness stands in for it
// directly (worker/__tests__/helpers/mock-sql.ts) — no more @/lib/db/server mock.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql, type MockSqlHarness } from '../../../../worker/__tests__/helpers/mock-sql';

const { mockGetAllLocationsForAccount } = vi.hoisted(() => ({
  mockGetAllLocationsForAccount: vi.fn(),
}));

vi.mock('@/lib/locations/repo', () => ({
  getAllLocationsForAccount: (...args: unknown[]) => mockGetAllLocationsForAccount(...args),
}));

import { getChannelOverridesView } from '../overrides-view';

const ACCOUNT_ID = 'a0000000-0000-4000-8000-000000000001';
const ACTIVE_LOCATION_ID = 'b1111111-0000-4000-8000-000000000001';
const ARCHIVED_LOCATION_ID = 'c2222222-0000-4000-8000-000000000002';
const UNKNOWN_LOCATION_ID = 'd3333333-0000-4000-8000-000000000003';

function locationRow(overrides: Record<string, unknown>) {
  return {
    id: ACTIVE_LOCATION_ID,
    account_id: ACCOUNT_ID,
    name: 'Fallback Name',
    display_label: null,
    is_primary: false,
    archived_at: null,
    google_place_id: null,
    google_place_address: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function enrollmentRow(overrides: Record<string, unknown>) {
  return {
    id: 'enrollment-1',
    channel: 'telegram',
    handle: '@downtown',
    status: 'verified',
    verified_at: new Date('2026-01-02T03:04:05.000Z'),
    location_id: ACTIVE_LOCATION_ID,
    ...overrides,
  };
}

describe('getChannelOverridesView', () => {
  let harness: MockSqlHarness;
  let mockSql: Sql;

  beforeEach(() => {
    vi.clearAllMocks();
    harness = createMockSql();
    mockSql = harness.mockSql as unknown as Sql;
    mockGetAllLocationsForAccount.mockResolvedValue([]);
  });

  it('maps override rows to DTOs: display label, archived flag, ISO timestamps', async () => {
    harness.sqlReturnQueue.push([
      enrollmentRow({ id: 'enrollment-active', location_id: ACTIVE_LOCATION_ID }),
      enrollmentRow({
        id: 'enrollment-archived',
        handle: '@uptown',
        verified_at: new Date('2026-02-01T00:00:00.000Z'),
        location_id: ARCHIVED_LOCATION_ID,
      }),
    ]);
    mockGetAllLocationsForAccount.mockResolvedValueOnce([
      locationRow({ id: ACTIVE_LOCATION_ID, display_label: 'Downtown', is_primary: true }),
      locationRow({
        id: ARCHIVED_LOCATION_ID,
        name: 'Uptown Branch',
        display_label: 'Uptown',
        archived_at: new Date('2026-03-01T00:00:00.000Z'),
      }),
    ]);

    const view = await getChannelOverridesView(mockSql, ACCOUNT_ID);

    expect(mockGetAllLocationsForAccount).toHaveBeenCalledExactlyOnceWith(ACCOUNT_ID);
    expect(harness.mockSql).toHaveBeenCalledTimes(1);
    expect(view.overrides).toEqual([
      {
        enrollmentId: 'enrollment-active',
        locationId: ACTIVE_LOCATION_ID,
        locationName: 'Downtown',
        archived: false,
        channel: 'telegram',
        handle: '@downtown',
        status: 'verified',
        verified_at: '2026-01-02T03:04:05.000Z',
      },
      {
        enrollmentId: 'enrollment-archived',
        locationId: ARCHIVED_LOCATION_ID,
        // The label is plain — "(archived)" is derived from the flag at render time.
        locationName: 'Uptown',
        archived: true,
        channel: 'telegram',
        handle: '@uptown',
        status: 'verified',
        verified_at: '2026-02-01T00:00:00.000Z',
      },
    ]);
  });

  it('returns every location (active AND archived) with displayName falling back to name', async () => {
    mockGetAllLocationsForAccount.mockResolvedValueOnce([
      locationRow({ id: ACTIVE_LOCATION_ID, name: 'No Label Cafe', display_label: null, is_primary: true }),
      locationRow({
        id: ARCHIVED_LOCATION_ID,
        display_label: 'Uptown',
        archived_at: new Date('2026-03-01T00:00:00.000Z'),
      }),
    ]);

    const view = await getChannelOverridesView(mockSql, ACCOUNT_ID);

    expect(view.locations).toEqual([
      { id: ACTIVE_LOCATION_ID, displayName: 'No Label Cafe', isPrimary: true, archived: false },
      { id: ARCHIVED_LOCATION_ID, displayName: 'Uptown', isPrimary: false, archived: true },
    ]);
  });

  it('falls back to the raw UUID and archived=false for a truly-unknown location id', async () => {
    harness.sqlReturnQueue.push([
      enrollmentRow({ id: 'enrollment-orphan', location_id: UNKNOWN_LOCATION_ID }),
    ]);

    const view = await getChannelOverridesView(mockSql, ACCOUNT_ID);

    expect(view.overrides).toHaveLength(1);
    expect(view.overrides[0]).toMatchObject({
      locationName: UNKNOWN_LOCATION_ID,
      archived: false,
      verified_at: '2026-01-02T03:04:05.000Z',
    });
  });

  it('partitions org-default rows out of overrides and reports only VERIFIED ones as verifiedOrgChannels, in CHANNEL_IDS order', async () => {
    harness.sqlReturnQueue.push([
      enrollmentRow({ id: 'org-telegram', channel: 'telegram', location_id: null, status: 'verified' }),
      enrollmentRow({ id: 'org-email', channel: 'email', location_id: null, status: 'verified' }),
      enrollmentRow({ id: 'org-whatsapp', channel: 'whatsapp', location_id: null, status: 'pending' }),
      enrollmentRow({ id: 'enrollment-1', channel: 'whatsapp', location_id: ACTIVE_LOCATION_ID }),
    ]);
    mockGetAllLocationsForAccount.mockResolvedValueOnce([
      locationRow({ id: ACTIVE_LOCATION_ID, display_label: 'Downtown' }),
    ]);

    const view = await getChannelOverridesView(mockSql, ACCOUNT_ID);

    // Org-level rows never appear as overrides.
    expect(view.overrides.map((o) => o.enrollmentId)).toEqual(['enrollment-1']);
    // email before telegram (CHANNEL_IDS order), pending whatsapp excluded.
    expect(view.verifiedOrgChannels).toEqual(['email', 'telegram']);
  });

  it('handles a null verified_at on an override row', async () => {
    harness.sqlReturnQueue.push([
      enrollmentRow({ status: 'pending', verified_at: null }),
    ]);
    mockGetAllLocationsForAccount.mockResolvedValueOnce([
      locationRow({ id: ACTIVE_LOCATION_ID, display_label: 'Downtown' }),
    ]);

    const view = await getChannelOverridesView(mockSql, ACCOUNT_ID);

    expect(view.overrides[0]).toMatchObject({ status: 'pending', verified_at: null });
  });
});
