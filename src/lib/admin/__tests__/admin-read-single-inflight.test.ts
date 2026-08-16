// Cross-cutting #773 invariant: every admin read service issues AT MOST ONE
// query in flight at a time.
//
// Why this is one shared suite rather than a case in each service's own file:
// the constraint is not a property of any single service, it is a property of
// the SHARED `sql` client's pool. On Vercel that pool is `DB_POOL_MAX` = 3 per
// Fluid Compute ISOLATE, and an isolate serves overlapping requests — so each
// service's fan-out multiplies across concurrent callers. A new admin read
// service belongs in the table below.
//
// This replaces the older "fan-out <= pool is safe" reasoning (#505), which
// staging measurement on 2026-08-13 disproved as a sufficient condition:
// `/api/admin/flagged` wedged a backend into `state=active,
// wait_event=ClientRead` with a fan-out of only TWO against the 3-connection
// pool. Evidence: branch codex/773-vercel-capacity-decision,
// docs/runbooks/evidence/2026-08-13-773-vercel-capacity-decision.md.
//
// `listOpenFlaggedResponses` is deliberately absent: it is fixed on branch
// fix/773-flagged-single-inflight (PR #809) and carries its own equivalent
// test. Add it here once that lands.

import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

import { getAdminNavCounts } from '../nav-counts-service';
import { getBusinessSummaries } from '../business-summary';
import { getAdminOffboardings } from '../offboardings-service';
import { getAdminJobsData } from '../jobs-service';
import { getMarginReport } from '../margin-service';

interface Case {
  name: string;
  /** Total queries the service issues, in order. */
  queries: number;
  /** Results for queries 2..n (query 1 is held pending by the test). */
  rest: unknown[];
  run: (sql: Sql) => Promise<unknown>;
}

const PAGE = { limit: 20, offset: 0 };

const CASES: Case[] = [
  {
    name: 'getAdminNavCounts',
    queries: 2,
    rest: [[{ total: 0 }]],
    run: (sql) => getAdminNavCounts(sql),
  },
  {
    // The held first query releases zero rows, so the metrics follow-up is
    // skipped and the paginated bundle is exactly rows → COUNT.
    name: 'getBusinessSummaries',
    queries: 2,
    rest: [[{ total: 0 }]],
    run: (sql) => getBusinessSummaries(sql, PAGE),
  },
  {
    name: 'getAdminOffboardings',
    queries: 2,
    rest: [[{ total: 0 }]],
    run: (sql) => getAdminOffboardings(sql, PAGE),
  },
  {
    name: 'getAdminJobsData',
    queries: 3,
    rest: [[], [{ total: 0 }]],
    run: (sql) => getAdminJobsData(sql, PAGE),
  },
  {
    name: 'getMarginReport',
    queries: 3,
    rest: [[], [{ total_cost_usd: 0 }]],
    run: (sql) => getMarginReport(sql, { limit: 20 }),
  },
];

describe('admin read services issue one query in flight (#773)', () => {
  for (const c of CASES) {
    // Holding the FIRST query pending and asserting nothing else has been
    // issued is the discriminator: under `Promise.all` every query registers
    // before any of them settles.
    it(`${c.name} does not issue query 2 until query 1 settles`, async () => {
      resetMockSql();
      let release!: (rows: unknown) => void;
      sqlReturnQueue.push(new Promise((resolve) => { release = resolve; }));
      for (const r of c.rest) sqlReturnQueue.push(r);

      const pending = c.run(mockSql as unknown as Sql);

      // Flush microtasks and a macrotask turn — ample for a concurrent fan-out
      // to have registered every query.
      await new Promise((resolve) => { setTimeout(resolve, 0); });

      expect(sqlCalls).toHaveLength(1);

      release([]);
      await pending;

      expect(sqlCalls).toHaveLength(c.queries);
    });
  }
});
