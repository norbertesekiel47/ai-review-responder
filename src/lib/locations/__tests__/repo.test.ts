// src/lib/locations/__tests__/repo.test.ts
//
// TDD assertions for src/lib/locations/repo.ts.
// Tests: getActiveLocationCount, getLocationsForAccount, getLocationById.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mock for sql ────────────────────────────────────────────────

const { mockSql } = vi.hoisted(() => ({
  mockSql: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
}));

import {
  getActiveLocationCount,
  getLocationsForAccount,
  getLocationById,
} from '../repo';

// ── Helpers ─────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOCATION_ID_1 = 'bbbbbbbb-0000-0000-0000-000000000001';
const LOCATION_ID_2 = 'bbbbbbbb-0000-0000-0000-000000000002';
const LOCATION_ID_3 = 'bbbbbbbb-0000-0000-0000-000000000003';

function mkLocationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LOCATION_ID_1,
    account_id: ACCOUNT_ID,
    name: 'Downtown Cafe',
    display_label: null as string | null,
    is_primary: false,
    archived_at: null as Date | null,
    google_place_id: null as string | null,
    created_at: new Date('2026-01-01'),
    ...overrides,
  };
}

// ── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
});

// ── getActiveLocationCount ──────────────────────────────────────────────────

describe('getActiveLocationCount', () => {
  it('returns correct count excluding archived locations', async () => {
    mockSql.mockResolvedValueOnce([{ count: 2 }]);

    const count = await getActiveLocationCount(ACCOUNT_ID);

    expect(count).toBe(2);

    // Verify the query excludes archived locations
    const call = mockSql.mock.calls[0];
    const template = (call![0] as TemplateStringsArray).join('?');
    expect(template).toContain('archived_at IS NULL');
    expect(template).toContain('account_id');
  });

  it('returns 0 when no locations exist', async () => {
    mockSql.mockResolvedValueOnce([{ count: 0 }]);

    const count = await getActiveLocationCount(ACCOUNT_ID);

    expect(count).toBe(0);
  });

  it('returns 0 when all locations are archived', async () => {
    mockSql.mockResolvedValueOnce([{ count: 0 }]);

    const count = await getActiveLocationCount(ACCOUNT_ID);

    expect(count).toBe(0);
  });

  it('returns correct count for single active location', async () => {
    mockSql.mockResolvedValueOnce([{ count: 1 }]);

    const count = await getActiveLocationCount(ACCOUNT_ID);

    expect(count).toBe(1);
  });
});

// ── getLocationsForAccount ──────────────────────────────────────────────────

describe('getLocationsForAccount', () => {
  it('returns ordered list: primary first, then by created_at', async () => {
    const locations = [
      mkLocationRow({
        id: LOCATION_ID_2,
        name: 'Westside Bakery',
        is_primary: false,
        created_at: new Date('2026-03-01'),
      }),
      mkLocationRow({
        id: LOCATION_ID_1,
        name: 'Downtown Cafe',
        is_primary: true,
        created_at: new Date('2026-01-01'),
      }),
      mkLocationRow({
        id: LOCATION_ID_3,
        name: 'Airport Branch',
        is_primary: false,
        created_at: new Date('2026-06-01'),
      }),
    ];
    mockSql.mockResolvedValueOnce(locations);

    const result = await getLocationsForAccount(ACCOUNT_ID);

    expect(result).toHaveLength(3);

    // Verify query has ORDER BY with is_primary and created_at
    const call = mockSql.mock.calls[0];
    const template = (call![0] as TemplateStringsArray).join('?');
    expect(template).toContain('ORDER BY');
    expect(template).toContain('is_primary');
    expect(template).toContain('created_at');
  });

  it('excludes archived locations from the list', async () => {
    const activeLocations = [
      mkLocationRow({ id: LOCATION_ID_1, name: 'Downtown Cafe', is_primary: true }),
    ];
    mockSql.mockResolvedValueOnce(activeLocations);

    const result = await getLocationsForAccount(ACCOUNT_ID);

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe(LOCATION_ID_1);

    // Verify query excludes archived
    const call = mockSql.mock.calls[0];
    const template = (call![0] as TemplateStringsArray).join('?');
    expect(template).toContain('archived_at IS NULL');
  });

  it('returns empty array when no locations exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    const result = await getLocationsForAccount(ACCOUNT_ID);

    expect(result).toHaveLength(0);
  });

  it('returns locations with display_label field', async () => {
    const locations = [
      mkLocationRow({
        id: LOCATION_ID_1,
        display_label: 'Downtown Cafe',
        is_primary: true,
      }),
    ];
    mockSql.mockResolvedValueOnce(locations);

    const result = await getLocationsForAccount(ACCOUNT_ID);

    expect(result[0]!.display_label).toBe('Downtown Cafe');
  });

  it('returns locations with null display_label (falls back to name)', async () => {
    const locations = [
      mkLocationRow({
        id: LOCATION_ID_1,
        display_label: null,
        name: 'Downtown Cafe',
        is_primary: true,
      }),
    ];
    mockSql.mockResolvedValueOnce(locations);

    const result = await getLocationsForAccount(ACCOUNT_ID);

    expect(result[0]!.display_label).toBeNull();
    expect(result[0]!.name).toBe('Downtown Cafe');
  });
});

// ── getLocationById ──────────────────────────────────────────────────────────

describe('getLocationById', () => {
  it('returns the location when it exists', async () => {
    const location = mkLocationRow({ id: LOCATION_ID_1, name: 'Downtown Cafe' });
    mockSql.mockResolvedValueOnce([location]);

    const result = await getLocationById(LOCATION_ID_1);

    expect(result).toBeDefined();
    expect(result!.id).toBe(LOCATION_ID_1);
    expect(result!.name).toBe('Downtown Cafe');
  });

  it('returns null when location does not exist', async () => {
    mockSql.mockResolvedValueOnce([]);

    const result = await getLocationById('00000000-0000-7f00-8000-000000000000');

    expect(result).toBeNull();
  });

  it('returns archived locations as well (no archived_at filter)', async () => {
    const location = mkLocationRow({
      id: LOCATION_ID_1,
      archived_at: new Date('2026-04-01'),
    });
    mockSql.mockResolvedValueOnce([location]);

    const result = await getLocationById(LOCATION_ID_1);

    expect(result).toBeDefined();
    expect(result!.archived_at).toBeTruthy();
  });

  it('includes account_id in the returned row', async () => {
    const location = mkLocationRow({ id: LOCATION_ID_1, account_id: ACCOUNT_ID });
    mockSql.mockResolvedValueOnce([location]);

    const result = await getLocationById(LOCATION_ID_1);

    expect(result).toBeDefined();
    expect(result!.account_id).toBe(ACCOUNT_ID);
  });
});
