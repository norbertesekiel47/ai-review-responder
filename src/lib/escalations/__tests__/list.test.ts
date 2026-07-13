import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql } from '../../../../worker/__tests__/helpers/mock-sql';
import { listOpenEscalations } from '../list';

describe('listOpenEscalations', () => {
  const harness = createMockSql();

  beforeEach(() => {
    harness.resetMockSql();
    harness.mockSql.mockClear();
    harness.mockSql.begin.mockClear();
  });

  it('returns the bounded open-escalation contract and total for one account', async () => {
    harness.sqlReturnQueue.push(
      [{ total_open: 24 }],
      [
        {
          id: 'escalation-1',
          status: 'escalated',
          triage_severity: 'high',
          triage_suggested_action: 'escalate',
          created_at: new Date('2026-07-12T10:00:00.000Z'),
          review_id: 'review-1',
          business_name: 'Corner Cafe',
          review_rating: 1,
        },
      ],
    );

    await expect(
      listOpenEscalations(harness.mockSql as unknown as Sql, {
        accountId: 'account-1',
      }),
    ).resolves.toEqual({
      totalOpen: 24,
      items: [
        {
          id: 'escalation-1',
          status: 'escalated',
          severity: 'high',
          suggestedAction: 'escalate',
          createdAt: '2026-07-12T10:00:00.000Z',
          reviewId: 'review-1',
          businessName: 'Corner Cafe',
          reviewRating: 1,
        },
      ],
    });

    expect(harness.sqlCalls).toHaveLength(2);
    for (const call of harness.sqlCalls) {
      const normalizedSql = call.text.replace(/\s+/g, ' ');
      expect(normalizedSql).toMatch(
        /FROM review_escalations e JOIN reviews r ON r\.id = e\.review_id JOIN businesses b ON b\.id = r\.business_id/,
      );
      expect(normalizedSql).toContain(
        "WHERE e.account_id = ? AND b.account_id = ? AND b.archived_at IS NULL AND e.status <> 'resolved'",
      );
      expect(call.values).toEqual(['account-1', 'account-1']);
    }
    expect(harness.sqlCalls[1]!.text).toMatch(/\bLIMIT\s+20\b/);
    expect(harness.mockSql.begin).toHaveBeenCalledExactlyOnceWith(
      'isolation level repeatable read read only',
      expect.any(Function),
    );
  });

  it('passes a rating-less review through as reviewRating: null', async () => {
    harness.sqlReturnQueue.push(
      [{ total_open: 1 }],
      [
        {
          id: 'escalation-null-rating',
          status: 'escalated',
          triage_severity: 'medium',
          triage_suggested_action: 'escalate',
          created_at: new Date('2026-07-12T10:00:00.000Z'),
          review_id: 'review-null-rating',
          business_name: 'Corner Cafe',
          review_rating: null,
        },
      ],
    );

    const result = await listOpenEscalations(harness.mockSql as unknown as Sql, {
      accountId: 'account-1',
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.reviewRating).toBeNull();
  });

  it('excludes escalations on archived locations in both the count and list statements', async () => {
    harness.sqlReturnQueue.push([{ total_open: 0 }], []);

    await listOpenEscalations(harness.mockSql as unknown as Sql, {
      accountId: 'account-1',
    });

    expect(harness.sqlCalls).toHaveLength(2);
    for (const call of harness.sqlCalls) {
      expect(call.text.replace(/\s+/g, ' ')).toContain('b.archived_at IS NULL');
    }
  });

  it('pins escalated-first, high-to-low severity, then oldest-first ordering', async () => {
    harness.sqlReturnQueue.push([{ total_open: 0 }], []);

    await listOpenEscalations(harness.mockSql as unknown as Sql, {
      accountId: 'account-1',
    });

    const listSql = harness.sqlCalls[1]!.text.replace(/\s+/g, ' ');
    expect(listSql).toContain(
      "CASE e.status WHEN 'escalated' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END",
    );
    expect(listSql).toContain(
      "CASE e.triage_severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END",
    );
    expect(listSql).toContain('e.created_at ASC');
  });

  it('awaits the count before issuing the bounded list query in the snapshot', async () => {
    let resolveCount: ((rows: { total_open: number }[]) => void) | undefined;
    const countRows = new Promise<{ total_open: number }[]>((resolve) => {
      resolveCount = resolve;
    });
    harness.sqlReturnQueue.push(countRows, []);

    const pending = listOpenEscalations(harness.mockSql as unknown as Sql, {
      accountId: 'account-1',
    });

    await vi.waitFor(() => expect(harness.sqlCalls).toHaveLength(1));
    expect(harness.sqlCalls[0]!.text).toContain('COUNT(*)::int AS total_open');
    resolveCount?.([{ total_open: 0 }]);
    await pending;

    expect(harness.sqlCalls).toHaveLength(2);
    expect(harness.sqlCalls[1]!.text).toContain('LIMIT 20');
  });
});
