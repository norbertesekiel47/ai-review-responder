// src/lib/locations/__tests__/display-label.test.ts
//
// TDD assertions for src/lib/locations/display-label.ts.
// Tests: getDisplayLabel (pure function), updateDisplayLabel (DB write).
//
// Validation contract: VAL-DASH-004 (display_label with name fallback),
// feature spec: display_label editable via settings, changes propagate.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const { mockSql } = vi.hoisted(() => {
  const sqlFn: any = vi.fn();
  sqlFn.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(sqlFn));
  return { mockSql: sqlFn };
});

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => 'mock-uuid-v7-00000000-000000000002'),
}));

import { getDisplayLabel, updateDisplayLabel } from '../display-label';

// ── Helpers ─────────────────────────────────────────────────────────────────

const ACCOUNT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const LOCATION_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
const ACTOR_USER_ID = 'uuuuuuuu-0000-0000-0000-000000000001';

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
});

// ── getDisplayLabel (pure function) ─────────────────────────────────────────

describe('getDisplayLabel', () => {
  // VAL-DASH-004: display_label with name fallback
  it('returns display_label when set', () => {
    const result = getDisplayLabel({
      display_label: 'Downtown Cafe',
      name: 'Downtown Cafe LLC',
    });

    expect(result).toBe('Downtown Cafe');
  });

  // VAL-DASH-004: Falls back to name when display_label is NULL
  it('falls back to name when display_label is NULL', () => {
    const result = getDisplayLabel({
      display_label: null,
      name: 'Downtown Cafe LLC',
    });

    expect(result).toBe('Downtown Cafe LLC');
  });

  // Edge case: empty string display_label (treated as set, not null)
  it('returns empty string when display_label is empty string (not null)', () => {
    const result = getDisplayLabel({
      display_label: '',
      name: 'Fallback Name',
    });

    // Empty string is truthy in the null-coalescing sense but we use ??
    // which only checks null/undefined, not falsy values
    // Actually, '' ?? 'name' returns '' in JS — this is correct per spec
    // because an owner intentionally clearing the label should not show name
    expect(result).toBe('');
  });

  // CamelCase interface support
  it('handles camelCase interface (displayLabel) as well as snake_case', () => {
    const result = getDisplayLabel({
      displayLabel: 'Westside Bakery',
      name: 'Westside Bakery LLC',
    });

    expect(result).toBe('Westside Bakery');
  });

  it('falls back to name for camelCase interface when displayLabel is null', () => {
    const result = getDisplayLabel({
      displayLabel: null,
      name: 'Westside Bakery LLC',
    });

    expect(result).toBe('Westside Bakery LLC');
  });
});

// ── updateDisplayLabel ────────────────────────────────────────────────────

describe('updateDisplayLabel', () => {
  it('updates display_label and returns { updated: true }', async () => {
    // Mock the UPDATE returning a row (location found + account matches)
    mockSql.mockResolvedValueOnce([{ id: LOCATION_ID }]);

    const result = await updateDisplayLabel(
      LOCATION_ID,
      ACCOUNT_ID,
      'New Downtown Cafe',
      ACTOR_USER_ID,
    );

    expect(result.updated).toBe(true);
    expect(result.displayLabel).toBe('New Downtown Cafe');
  });

  it('returns { updated: false } when location not found or wrong account', async () => {
    // Mock the UPDATE returning no rows (location not found / wrong account)
    mockSql.mockResolvedValueOnce([]);

    const result = await updateDisplayLabel(
      LOCATION_ID,
      'wrong-account-id',
      'New Name',
      ACTOR_USER_ID,
    );

    expect(result.updated).toBe(false);
  });

  it('sets display_label to NULL when newLabel is null', async () => {
    mockSql.mockResolvedValueOnce([{ id: LOCATION_ID }]);

    const result = await updateDisplayLabel(
      LOCATION_ID,
      ACCOUNT_ID,
      null,
      ACTOR_USER_ID,
    );

    expect(result.updated).toBe(true);
    expect(result.displayLabel).toBeNull();
  });

  it('validates account ownership via WHERE clause', async () => {
    mockSql.mockResolvedValueOnce([{ id: LOCATION_ID }]);

    await updateDisplayLabel(LOCATION_ID, ACCOUNT_ID, 'New Name');

    // Verify the UPDATE WHERE clause includes account_id
    const txCalls = mockSql.mock.calls;
    const updateCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('UPDATE businesses'),
    );
    expect(updateCall).toBeDefined();
    const template = (updateCall![0] as TemplateStringsArray).join('?');
    expect(template).toContain('account_id');
  });

  it('inserts account_audit_log with event_type display_label_updated', async () => {
    mockSql.mockResolvedValueOnce([{ id: LOCATION_ID }]);

    await updateDisplayLabel(
      LOCATION_ID,
      ACCOUNT_ID,
      'New Downtown Cafe',
      ACTOR_USER_ID,
    );

    const txCalls = mockSql.mock.calls;
    const auditCall = txCalls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO account_audit_log'),
    );
    expect(auditCall).toBeDefined();
    const template = (auditCall![0] as TemplateStringsArray).join('?');
    expect(template).toContain('display_label_updated');
  });

  it('handles missing actor_user_id (nullable)', async () => {
    mockSql.mockResolvedValueOnce([{ id: LOCATION_ID }]);

    const result = await updateDisplayLabel(
      LOCATION_ID,
      ACCOUNT_ID,
      'New Name',
    );

    expect(result.updated).toBe(true);
  });

  it('excludes archived locations from update', async () => {
    mockSql.mockResolvedValueOnce([{ id: LOCATION_ID }]);

    await updateDisplayLabel(LOCATION_ID, ACCOUNT_ID, 'New Name');

    const updateCall = mockSql.mock.calls.find(
      (c: any[]) => (c[0] as TemplateStringsArray).join('?').includes('UPDATE businesses'),
    );
    expect(updateCall).toBeDefined();
    const template = (updateCall![0] as TemplateStringsArray).join('?');
    expect(template).toContain('archived_at IS NULL');
  });
});
