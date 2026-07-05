// src/lib/admin/__tests__/csv-import.test.ts
//
// Unit tests for CSV parsing and validation helpers.
// Validation contract: VAL-ADMIN-008, VAL-ADMIN-012, VAL-ADMIN-013.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql } from '../../../../worker/__tests__/helpers/mock-sql';

// ── Hoisted mocks (only needed by processRow tests) ─────────────────────────

const { mockAssertCanAddLocation } = vi.hoisted(() => ({
  mockAssertCanAddLocation: vi.fn(),
}));
vi.mock('@/lib/accounts/quota', () => ({
  assertCanAddLocation: mockAssertCanAddLocation,
}));

const { mockGetAccountById, mockGetAccountOwnerUser } = vi.hoisted(() => ({
  mockGetAccountById: vi.fn(),
  mockGetAccountOwnerUser: vi.fn(),
}));
vi.mock('@/lib/accounts/repo', () => ({
  getAccountById: mockGetAccountById,
  getAccountOwnerUser: mockGetAccountOwnerUser,
}));

const { mockGetActiveLocationCount } = vi.hoisted(() => ({
  mockGetActiveLocationCount: vi.fn(),
}));
vi.mock('@/lib/locations/repo', () => ({
  getActiveLocationCount: mockGetActiveLocationCount,
}));

const { mockAddLocationTransaction } = vi.hoisted(() => ({
  mockAddLocationTransaction: vi.fn(),
}));
vi.mock('@/lib/locations/add-location-tx', () => ({
  addLocationTransaction: mockAddLocationTransaction,
}));

// csv-import.ts no longer imports the @/lib/db/server singleton — sql is an
// explicit parameter (A+ campaign 2b, T4). processRow's other dependencies
// (assertCanAddLocation, getAccountById, getAccountOwnerUser,
// addLocationTransaction) are all mocked above, so this mock client is never
// queried directly here — it only needs a stable identity to pass through.
const { mockSql } = createMockSql();
const sql = mockSql as unknown as Sql;

import {
  parseCsv,
  validateRow,
  processRow,
  MAX_FILE_SIZE,
  MAX_ROWS,
  type ParsedCsvRow,
} from '../csv-import';

describe('parseCsv', () => {
  it('parses a valid CSV with name and placeId columns', () => {
    const result = parseCsv('name,placeId\nDowntown Cafe,ChIJ1234');
    if ('error' in result) throw new Error(`Unexpected error: ${result.error}`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({
      rowIndex: 1,
      name: 'Downtown Cafe',
      placeId: 'ChIJ1234',
    });
  });

  it('parses CSV with optional voice config columns', () => {
    const csv = `name,placeId,tone,productsServices,avoidFacts,sampleResponses
Downtown Cafe,ChIJ1234,friendly,"Coffee and pastries","Bad coffee|Overpriced","Thanks for the review|We appreciate you"`;
    const result = parseCsv(csv);
    if ('error' in result) throw new Error(`Unexpected error: ${result.error}`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.tone).toBe('friendly');
    expect(result.rows[0]!.productsServices).toBe('Coffee and pastries');
    expect(result.rows[0]!.avoidFacts).toEqual(['Bad coffee', 'Overpriced']);
    expect(result.rows[0]!.sampleResponses).toEqual(['Thanks for the review', 'We appreciate you']);
  });

  it('parses multiple rows', () => {
    const csv = `name,placeId
Row 1,ChIJ1
Row 2,ChIJ2
Row 3,ChIJ3`;
    const result = parseCsv(csv);
    if ('error' in result) throw new Error(`Unexpected error: ${result.error}`);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]!.name).toBe('Row 1');
    expect(result.rows[2]!.name).toBe('Row 3');
  });

  it('returns error when CSV is empty', () => {
    const result = parseCsv('');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('empty');
  });

  it('returns error when header is missing name column', () => {
    const result = parseCsv('placeId,tone\nChIJ1234,friendly');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('name');
  });

  it('returns error when header is missing placeId column', () => {
    const result = parseCsv('name,tone\nDowntown,friendly');
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error).toContain('placeId');
  });

  it('handles quoted fields with commas', () => {
    const csv = `name,placeId,productsServices
"Downtown, Cafe",ChIJ1234,"Coffee, tea, pastries"`;
    const result = parseCsv(csv);
    if ('error' in result) throw new Error(`Unexpected error: ${result.error}`);
    expect(result.rows[0]!.name).toBe('Downtown, Cafe');
    expect(result.rows[0]!.productsServices).toBe('Coffee, tea, pastries');
  });

  it('handles quoted fields with embedded newlines', () => {
    const csv = 'name,placeId,productsServices\n"Downtown\nCafe",ChIJ1234,"Coffee\nTea"';
    const result = parseCsv(csv);
    if ('error' in result) throw new Error(`Unexpected error: ${result.error}`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.name).toBe('Downtown\nCafe');
    expect(result.rows[0]!.productsServices).toBe('Coffee\nTea');
  });

  it('handles escaped double-quotes in fields', () => {
    const csv = `name,placeId
"The ""Best"" Cafe",ChIJ1234`;
    const result = parseCsv(csv);
    if ('error' in result) throw new Error(`Unexpected error: ${result.error}`);
    expect(result.rows[0]!.name).toBe('The "Best" Cafe');
  });

  it('handles Windows-style CRLF line endings', () => {
    const csv = 'name,placeId\r\nRow 1,ChIJ1\r\nRow 2,ChIJ2';
    const result = parseCsv(csv);
    if ('error' in result) throw new Error(`Unexpected error: ${result.error}`);
    expect(result.rows).toHaveLength(2);
  });

  it('skips empty lines', () => {
    const csv = `name,placeId

Row 1,ChIJ1

Row 2,ChIJ2`;
    const result = parseCsv(csv);
    if ('error' in result) throw new Error(`Unexpected error: ${result.error}`);
    expect(result.rows).toHaveLength(2);
  });

  it('handles header-only CSV with no data rows', () => {
    const result = parseCsv('name,placeId');
    if ('error' in result) throw new Error(`Unexpected error: ${result.error}`);
    expect(result.rows).toHaveLength(0);
  });

  it('handles case-insensitive header matching', () => {
    const csv = `Name,PlaceID,tone
Downtown Cafe,ChIJ1234,friendly`;
    const result = parseCsv(csv);
    if ('error' in result) throw new Error(`Unexpected error: ${result.error}`);
    expect(result.rows[0]!.name).toBe('Downtown Cafe');
    expect(result.rows[0]!.placeId).toBe('ChIJ1234');
    expect(result.rows[0]!.tone).toBe('friendly');
  });

  it('handles extra columns beyond the known ones', () => {
    const csv = `name,placeId,unknownCol
Downtown Cafe,ChIJ1234,ignored`;
    const result = parseCsv(csv);
    if ('error' in result) throw new Error(`Unexpected error: ${result.error}`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.name).toBe('Downtown Cafe');
  });

  it('trims whitespace from header and values', () => {
    const csv = ` name , placeId \n  Downtown Cafe  ,  ChIJ1234  `;
    const result = parseCsv(csv);
    if ('error' in result) throw new Error(`Unexpected error: ${result.error}`);
    expect(result.rows[0]!.name).toBe('Downtown Cafe');
    expect(result.rows[0]!.placeId).toBe('ChIJ1234');
  });
});

describe('validateRow', () => {
  it('returns valid for row with name and placeId', () => {
    const row: ParsedCsvRow = { rowIndex: 1, name: 'Test', placeId: 'ChIJ1' };
    const result = validateRow(row);
    expect(result.valid).toBe(true);
  });

  it('returns invalid when name is empty', () => {
    const row: ParsedCsvRow = { rowIndex: 1, name: '', placeId: 'ChIJ1' };
    const result = validateRow(row);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('name');
  });

  it('returns invalid when placeId is empty', () => {
    const row: ParsedCsvRow = { rowIndex: 1, name: 'Test', placeId: '' };
    const result = validateRow(row);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('placeId');
  });

  it('returns invalid when both name and placeId are empty', () => {
    const row: ParsedCsvRow = { rowIndex: 1, name: '', placeId: '' };
    const result = validateRow(row);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('name');
    expect(result.reason).toContain('placeId');
  });

  it('returns valid for row with optional fields', () => {
    const row: ParsedCsvRow = {
      rowIndex: 1,
      name: 'Test',
      placeId: 'ChIJ1',
      tone: 'friendly',
      productsServices: 'Coffee',
      avoidFacts: ['Bad coffee'],
    };
    const result = validateRow(row);
    expect(result.valid).toBe(true);
  });
});

describe('MAX_FILE_SIZE and MAX_ROWS constants', () => {
  it('MAX_FILE_SIZE is 5MB', () => {
    expect(MAX_FILE_SIZE).toBe(5 * 1024 * 1024);
  });

  it('MAX_ROWS is 100', () => {
    expect(MAX_ROWS).toBe(100);
  });
});

// In-file duplicate detection moved out of csv-import.ts: the route keeps an
// inline imported-place-ids set (only SUCCESSFUL imports claim a place id), so
// findInFileDuplicatePlaceIds was deleted. Route behavior is covered in
// src/app/api/admin/locations/csv-import/__tests__/route.test.ts.

// ── processRow duplicate handling (Task C3, Change A) ────────────────────────

describe('processRow duplicate handling', () => {
  const accountId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  function happyRow(): ParsedCsvRow {
    return { rowIndex: 1, name: 'Downtown Cafe', placeId: 'ChIJ1234' };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAssertCanAddLocation.mockResolvedValue({ allowed: true, overageUnits: 1 });
    mockGetActiveLocationCount.mockResolvedValue(1);
    mockGetAccountById.mockResolvedValue({
      id: accountId,
      subscription_tier: 'standard',
      subscription_status: 'active',
    });
    mockGetAccountOwnerUser.mockResolvedValue({
      id: 'uuuuuuuu-0000-0000-0000-000000000001',
      name: 'Test Owner',
      email: 'owner@test.com',
    });
  });

  it("returns { reason: 'duplicate_location' } when the add throws Error('duplicate_location')", async () => {
    // Matches C1: addLocationTransaction catches the 23505 internally and
    // re-throws a plain Error('duplicate_location') (no code/constraint_name).
    mockAddLocationTransaction.mockRejectedValueOnce(new Error('duplicate_location'));

    const result = await processRow(sql, happyRow(), accountId);

    expect('reason' in result).toBe(true);
    if ('reason' in result) {
      expect(result.reason).toBe('duplicate_location');
    }
  });

  it('returns a generic Transaction error for an unrelated add failure (regression)', async () => {
    mockAddLocationTransaction.mockRejectedValueOnce(new Error('connection reset'));

    const result = await processRow(sql, happyRow(), accountId);

    expect('reason' in result).toBe(true);
    if ('reason' in result) {
      expect(result.reason).toContain('Transaction error');
      expect(result.reason).toContain('connection reset');
      expect(result.reason).not.toBe('duplicate_location');
    }
  });

  it('surfaces a RAW 23505 (un-remapped) as a generic Transaction error', async () => {
    // Contract: the tx module (rethrowAsDuplicateLocation) remaps the 23505 to
    // Error('duplicate_location') before processRow ever sees it. processRow
    // matches on the typed message ONLY — a raw Postgres 23505 reaching it
    // means the remap was bypassed, and it must NOT be classified as a
    // duplicate here (single owner of the remap is the tx module).
    const raw: Error & { code?: string; constraint_name?: string } = new Error(
      'duplicate key value violates unique constraint "businesses_account_place_uniq"',
    );
    raw.code = '23505';
    raw.constraint_name = 'businesses_account_place_uniq';
    mockAddLocationTransaction.mockRejectedValueOnce(raw);

    const result = await processRow(sql, happyRow(), accountId);

    expect('reason' in result).toBe(true);
    if ('reason' in result) {
      expect(result.reason).toContain('Transaction error');
      expect(result.reason).not.toBe('duplicate_location');
    }
  });
});
