import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  createMockSql,
  type MockSqlHarness,
} from '../../../../worker/__tests__/helpers/mock-sql';

vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ get: async () => null, set: async () => 'OK' }),
}));

import { getActiveDashboardData } from '../service';

let harness: MockSqlHarness;
let mockSql: Sql;

const BUSINESS_ID = 'biz-feed-1';

function seedDashboardQueries() {
  harness.resetMockSql();
  harness.sqlReturnQueue.push(
    [{ name: 'Biz', created_at: new Date('2026-01-01T00:00:00Z') }],
    [{ count: 0 }],
    [{ count: 0 }],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
    [],
  );
}

function recentReviewsQuery() {
  return harness.sqlCalls.find((call) => call.text.includes('FROM reviews rev'));
}

function lateralBody(queryText: string, alias: 'resp' | 'esc'): string {
  const startMarker = 'LEFT JOIN LATERAL (';
  const endMarker = `) ${alias} ON true`;
  const endIndex = queryText.indexOf(endMarker);
  const startIndex = queryText.lastIndexOf(startMarker, endIndex);

  if (startIndex === -1 || endIndex === -1) {
    throw new Error(`Missing ${alias} LATERAL join in recent-reviews query`);
  }

  return queryText.slice(startIndex + startMarker.length, endIndex).trim();
}

describe('getActiveDashboardData — feed projection', () => {
  beforeEach(() => {
    harness = createMockSql();
    mockSql = harness.mockSql as unknown as Sql;
  });

  it('reads the current scheduling fields and latest displayable response', async () => {
    seedDashboardQueries();

    await getActiveDashboardData(mockSql, BUSINESS_ID);

    const query = recentReviewsQuery();
    expect(query).toBeDefined();
    const responseLateral = lateralBody(query!.text, 'resp');
    expect(query!.text).toContain('resp.approval_method');
    expect(query!.text).toContain('resp.auto_post_scheduled_at');
    expect(responseLateral).toContain(
      'SELECT COALESCE(approved_text, response_text) AS response_text, status, approval_method, auto_post_scheduled_at',
    );
    expect(responseLateral).toContain('ORDER BY version DESC');
    expect(query!.values.filter((value) => value === BUSINESS_ID)).toHaveLength(3);
  });

  it("uses the open-escalation partial-index predicate verbatim", async () => {
    seedDashboardQueries();

    await getActiveDashboardData(mockSql, BUSINESS_ID);

    const query = recentReviewsQuery();
    expect(query).toBeDefined();
    const escalationLateral = lateralBody(query!.text, 'esc');
    expect(escalationLateral).toContain("AND e.status <> 'resolved'");
    expect(escalationLateral).toContain('LIMIT 1');
  });

  // #730 T5: pins that the openFlagExistsSql migration keeps the held
  // predicate INSIDE the response LATERAL bodies, with its polarity intact.
  it.todo('the response LATERALs keep held-filtering inside the LATERAL: polarity and placement pinned');
});
