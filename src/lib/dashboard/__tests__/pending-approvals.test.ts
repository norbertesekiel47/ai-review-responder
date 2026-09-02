// src/lib/dashboard/__tests__/pending-approvals.test.ts
//
// UX audit D2: the Needs Action queue's own read — paged, tenant-scoped, with
// the authoritative pending count riding alongside the page total.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import {
  createMockSql,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';
import {
  listPendingApprovals,
  normalizePendingOffset,
  PENDING_APPROVALS_PAGE_SIZE,
} from '../pending-approvals';

let harness: MockSqlHarness;
let sql: Sql;

const BUSINESS_ID = 'b0000000-0000-0000-0000-000000000001';
const ACCOUNT_ID = 'a0000000-0000-0000-0000-000000000001';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rev-1',
    reviewer_name: 'Daniel',
    star_rating: 5,
    review_text: 'Great.',
    review_date: new Date('2026-07-01T00:00:00Z'),
    status: 'pending_approval',
    response_text: 'Thanks!',
    response_status: 'pending_approval',
    approval_method: null,
    auto_post_scheduled_at: null,
    escalation_id: null,
    escalation_status: null,
    escalation_severity: null,
    location_id: BUSINESS_ID,
    location_name: 'Downtown',
    location_display_label: null,
    ...overrides,
  };
}

beforeEach(() => {
  harness = createMockSql();
  sql = harness.mockSql as unknown as Sql;
});

describe('listPendingApprovals — location scope', () => {
  it('runs count, total and page sequentially and returns both totals', async () => {
    harness.sqlReturnQueue.push([{ count: 57 }], [{ total: 58 }], [row(), row({ id: 'rev-2' })]);

    const page = await listPendingApprovals(sql, { kind: 'location', accountId: ACCOUNT_ID, businessId: BUSINESS_ID });

    expect(page.pendingTotal).toBe(57);
    expect(page.total).toBe(58);
    expect(page.items.map((item) => item.id)).toEqual(['rev-1', 'rev-2']);
    expect(page.limit).toBe(PENDING_APPROVALS_PAGE_SIZE);
    expect(page.offset).toBe(0);
    // Per-location rows carry no location chip fields.
    expect(page.items[0]).not.toHaveProperty('locationDisplayName');
    expect(harness.sqlCalls).toHaveLength(3);
  });

  it('scopes every statement to the business and pages with LIMIT/OFFSET binds', async () => {
    harness.sqlReturnQueue.push([{ count: 0 }], [{ total: 0 }], []);

    await listPendingApprovals(sql, { kind: 'location', accountId: ACCOUNT_ID, businessId: BUSINESS_ID }, { offset: 100 });

    const [countCall, totalCall, pageCall] = harness.sqlCalls;
    expect(countCall!.text).toContain('resp.business_id = ?');
    // The account boundary is spelled in every statement; the location narrows it.
    for (const call of [totalCall!, pageCall!]) {
      expect(call.text).toContain('b.account_id = ?::uuid');
      expect(call.text).toContain('rev.business_id = ?::uuid');
      expect(call.values).toEqual(expect.arrayContaining([ACCOUNT_ID, BUSINESS_ID]));
    }
    expect(pageCall!.text).toMatch(/LIMIT \? OFFSET \?/);
    expect(pageCall!.values.slice(-2)).toEqual([PENDING_APPROVALS_PAGE_SIZE, 100]);
    expect(pageCall!.text).toContain('ORDER BY rev.detected_at DESC');
  });

  it('keeps the queue predicate: pending drafts OR an open auto-post veto window, never held drafts', async () => {
    harness.sqlReturnQueue.push([{ count: 0 }], [{ total: 0 }], []);

    await listPendingApprovals(sql, { kind: 'location', accountId: ACCOUNT_ID, businessId: BUSINESS_ID });

    const pageCall = harness.sqlCalls[2]!;
    expect(pageCall.text).toContain('resp.auto_post_scheduled_at > NOW()');
    expect(pageCall.text).toContain('NOT EXISTS');
    // Statuses reach SQL as binds, never as literals in the query text.
    expect(pageCall.text).not.toMatch(/'pending_approval'|'approved'|'auto_policy'/);
    expect(pageCall.values).toEqual(expect.arrayContaining(['pending_approval', 'approved', 'auto_policy']));
  });
});

describe('listPendingApprovals — account scope', () => {
  it('sums the per-location pending counts and adds location chip fields', async () => {
    harness.sqlReturnQueue.push(
      [{ business_id: 'b1', count: 3 }, { business_id: 'b2', count: 4 }],
      [{ total: 7 }],
      [row({ location_name: 'Downtown', location_display_label: 'DT' })],
    );

    const page = await listPendingApprovals(sql, { kind: 'account', accountId: ACCOUNT_ID });

    expect(page.pendingTotal).toBe(7);
    expect(page.items[0]).toMatchObject({ locationId: BUSINESS_ID, locationDisplayName: 'DT' });
    const pageCall = harness.sqlCalls[2]!;
    expect(pageCall.text).toContain('b.account_id = ?::uuid');
    expect(pageCall.text).toContain('b.archived_at IS NULL');
    // No location narrowing: the business id binds as NULL on both sides.
    expect(pageCall.values.filter((value) => value === null)).toHaveLength(2);
    expect(pageCall.values).not.toContain(BUSINESS_ID);
  });
});

describe('normalizePendingOffset', () => {
  it.each([
    [null, 0],
    ['', 0],
    ['50', 50],
    ['-1', 0],
    ['abc', 0],
    ['1.5', 0],
  ])('normalizes %j to %d', (raw, expected) => {
    expect(normalizePendingOffset(raw)).toBe(expected);
  });
});
