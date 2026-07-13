import { beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createMockSql } from '../../../../worker/__tests__/helpers/mock-sql';
import { listOpenEscalations } from '../list';

describe('listOpenEscalations', () => {
  const harness = createMockSql();

  beforeEach(() => {
    harness.resetMockSql();
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
        "WHERE e.account_id = ? AND b.account_id = ? AND e.status <> 'resolved'",
      );
      expect(call.values).toEqual(['account-1', 'account-1']);
    }
    expect(harness.sqlCalls[1]!.text).toMatch(/\bLIMIT\s+20\b/);
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
});
