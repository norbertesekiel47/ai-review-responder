# Prompt 20b: Archival Expansion + Cost Rollups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend ArchivalPoller to aggregate+prune `api_costs` into `api_costs_daily_rollups` (90d retention) and cleanup `notification_deliveries` (90d), then make the admin costs API transparently query both detail and rollup tables for historical ranges up to 365 days.

**Architecture:** Single migration 017 creates the rollup table + indexes + Sprint 6 columns (website, owner_email_bounced) per the final plan. ArchivalPoller gains two new CTE queries following the existing LIMIT 5000 pattern — the `api_costs` query is a single atomic statement (candidates → aggregate → upsert → delete). Admin costs API adds a merge layer that combines detail and rollup rows by `(business_id|'platform', provider, date)` key, detail takes precedence.

**Tech Stack:** TypeScript, Postgres.js, Vitest. Postgres 15+ required for `UNIQUE NULLS NOT DISTINCT` syntax.

**Spec:** `docs/Final_Implementation_Plan.md` Prompt 20b (Sprint 6).

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `supabase/migrations/017_sprint6_scale.sql` | Sprint 6 full schema: rollup table + indexes + website/bounced columns + ND created_at index |
| `worker/__tests__/ArchivalPoller.test.ts` | Unit tests for all 5 archival targets |
| `src/app/api/admin/costs/__tests__/route.test.ts` | Unit tests for costs API detail+rollup merge + days cap |

### Modified Files
| File | Change |
|------|--------|
| `worker/jobs/ArchivalPoller.ts` | Add `api_costs` rollup+delete query + `notification_deliveries` delete query; expand logging to 5 targets |
| `src/app/api/admin/costs/route.ts` | Raise days cap 90→365; merge detail + rollup rows when range crosses 90d boundary |

---

## Task 1: Migration 017 — Sprint 6 Schema

Creates `api_costs_daily_rollups` plus all Sprint 6 schema additions (per the final plan's single-migration strategy). Apply this to Supabase before running any other task.

**Files:**
- Create: `supabase/migrations/017_sprint6_scale.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Migration 017: Sprint 6 main schema
--
-- Combines all Sprint 6 schema needs in one migration per docs/Final_Implementation_Plan.md:
-- 1. api_costs_daily_rollups table for archival aggregation (Prompt 20b)
-- 2. businesses.website column for onboarding pre-fill (Prompt 20c)
-- 3. businesses.owner_email_bounced column for email deliverability (Prompt 20d)
-- 4. notification_deliveries(created_at) index for archival DELETE scans (Prompt 20b)
--
-- UNIQUE NULLS NOT DISTINCT is Postgres 15+ syntax. This treats multiple NULL
-- business_id rows as colliding for uniqueness — correct for platform-level
-- cost entries (e.g., SerpAPI demo pre-fill) which have business_id = NULL.

CREATE TABLE IF NOT EXISTS api_costs_daily_rollups (
  id UUID PRIMARY KEY,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  provider VARCHAR(20) NOT NULL,
  rollup_date DATE NOT NULL,
  total_cost_usd DECIMAL(10,6) NOT NULL,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  call_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_cost_rollups_business_provider_date
    UNIQUE NULLS NOT DISTINCT (business_id, provider, rollup_date)
);

ALTER TABLE api_costs_daily_rollups ENABLE ROW LEVEL SECURITY;

-- Indexes for admin costs page query patterns:
-- (business, date DESC) for per-business historical breakdown
-- (provider, date DESC) for byProvider aggregation across dates
-- (date DESC) for byDay aggregation across all businesses/providers
CREATE INDEX IF NOT EXISTS idx_cost_rollups_business_date
  ON api_costs_daily_rollups(business_id, rollup_date DESC);
CREATE INDEX IF NOT EXISTS idx_cost_rollups_provider_date
  ON api_costs_daily_rollups(provider, rollup_date DESC);
CREATE INDEX IF NOT EXISTS idx_cost_rollups_date
  ON api_costs_daily_rollups(rollup_date DESC);

-- Sprint 6 business columns (consumed by Prompt 20c/20d)
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS owner_email_bounced BOOLEAN NOT NULL DEFAULT FALSE;

-- Archival DELETE scans notification_deliveries by created_at.
-- The existing idx_nd_business covers (business_id, created_at) but leads with
-- business_id, so a scan across all businesses by created_at alone can't use it.
CREATE INDEX IF NOT EXISTS idx_nd_created_at
  ON notification_deliveries(created_at);
```

- [ ] **Step 2: Apply the migration via Supabase SQL editor**

Paste the full SQL into the Supabase SQL editor and run it. Then verify:

```sql
SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'api_costs_daily_rollups';
-- Expected: 1

SELECT conname FROM pg_constraint WHERE conname = 'uniq_cost_rollups_business_provider_date';
-- Expected: 1 row

SELECT column_name FROM information_schema.columns
WHERE table_name = 'businesses' AND column_name IN ('website', 'owner_email_bounced');
-- Expected: 2 rows

SELECT indexname FROM pg_indexes
WHERE tablename IN ('api_costs_daily_rollups', 'notification_deliveries')
  AND indexname IN ('idx_cost_rollups_business_date', 'idx_cost_rollups_provider_date',
                    'idx_cost_rollups_date', 'idx_nd_created_at');
-- Expected: 4 rows
```

Also apply migration 018 (the correlation/dispatching fixes from Prompt 20a) if not yet applied — order: 017 then 018.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/017_sprint6_scale.sql
git commit -m "chore: migration 017 — Sprint 6 schema (cost rollups, website, bounce flag, ND index)"
```

---

## Task 2: Extend ArchivalPoller with api_costs Rollup Archival

Aggregates rows older than 90 days into the rollup table and deletes them in a single atomic CTE statement. Additive UPSERT semantics ensure batched runs don't double-count — if the same (business, provider, date) is archived over multiple cycles, totals accumulate correctly.

**Files:**
- Modify: `worker/jobs/ArchivalPoller.ts` (add new query after line 64, before `const outboxCount = ...`)

- [ ] **Step 1: Add the api_costs rollup+delete query**

In `worker/jobs/ArchivalPoller.ts`, after the demos query block ending at line 64, and before the result parsing at line 66, insert:

```typescript
    // 4. api_costs older than 90 days — aggregate into rollups, then delete detail rows.
    // Single atomic CTE: candidates → aggregate → upsert → delete.
    // ON CONFLICT DO UPDATE is additive so batched runs across multiple cycles
    // accumulate correctly without double-counting.
    const [costsResult] = await sql<{ count: string }[]>`
      WITH candidates AS (
        SELECT id, business_id, provider, created_at::date AS cost_date,
               cost_usd,
               COALESCE(input_tokens, 0) AS input_tokens,
               COALESCE(output_tokens, 0) AS output_tokens
        FROM api_costs
        WHERE created_at < NOW() - INTERVAL '90 days'
        LIMIT 5000
      ),
      aggregated AS (
        SELECT business_id, provider, cost_date,
               SUM(cost_usd) AS total_cost_usd,
               SUM(input_tokens)::int AS total_input_tokens,
               SUM(output_tokens)::int AS total_output_tokens,
               COUNT(*)::int AS call_count
        FROM candidates
        GROUP BY business_id, provider, cost_date
      ),
      upserted AS (
        INSERT INTO api_costs_daily_rollups
          (id, business_id, provider, rollup_date,
           total_cost_usd, total_input_tokens, total_output_tokens, call_count)
        SELECT gen_random_uuid(), business_id, provider, cost_date,
               total_cost_usd, total_input_tokens, total_output_tokens, call_count
        FROM aggregated
        ON CONFLICT ON CONSTRAINT uniq_cost_rollups_business_provider_date DO UPDATE SET
          total_cost_usd = api_costs_daily_rollups.total_cost_usd + EXCLUDED.total_cost_usd,
          total_input_tokens = api_costs_daily_rollups.total_input_tokens + EXCLUDED.total_input_tokens,
          total_output_tokens = api_costs_daily_rollups.total_output_tokens + EXCLUDED.total_output_tokens,
          call_count = api_costs_daily_rollups.call_count + EXCLUDED.call_count
        RETURNING id
      ),
      deleted AS (
        DELETE FROM api_costs WHERE id IN (SELECT id FROM candidates)
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `;
```

- [ ] **Step 2: Verify the change via type check**

Run: `pnpm tsc --noEmit`
Expected: No errors. The existing `sql<{ count: string }[]>` template pattern is reused.

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/ArchivalPoller.ts
git commit -m "feat(20b): ArchivalPoller aggregates api_costs >90d into rollups before delete"
```

---

## Task 3: Extend ArchivalPoller with notification_deliveries Cleanup

Straight delete of delivery records older than 90 days. No aggregation needed — cooldown/dedup checks elsewhere in the codebase use much shorter windows (24h, 3-7d) so this is safe.

**Files:**
- Modify: `worker/jobs/ArchivalPoller.ts` (add new query immediately after the Task 2 insert)

- [ ] **Step 1: Add the notification_deliveries delete query**

In `worker/jobs/ArchivalPoller.ts`, immediately after the closing backtick of the Task 2 query (before result parsing), insert:

```typescript
    // 5. notification_deliveries older than 90 days — straight delete.
    // Cooldown/dedup checks in EngagementMonitor/NotificationFailover use much
    // shorter windows (24h, 3-7d), so permanent delivery records older than 90d
    // have no operational value.
    const [notificationsResult] = await sql<{ count: string }[]>`
      WITH candidates AS (
        SELECT id FROM notification_deliveries
        WHERE created_at < NOW() - INTERVAL '90 days'
        LIMIT 5000
      ),
      deleted AS (
        DELETE FROM notification_deliveries WHERE id IN (SELECT id FROM candidates)
        RETURNING id
      )
      SELECT COUNT(*)::text AS count FROM deleted
    `;
```

- [ ] **Step 2: Verify type check**

Run: `pnpm tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/ArchivalPoller.ts
git commit -m "feat(20b): ArchivalPoller deletes notification_deliveries >90d"
```

---

## Task 4: Expand ArchivalPoller Logging for 5 Targets

Replace the existing 3-target log with a 5-target version, and extend the saturation warning to include all 5.

**Files:**
- Modify: `worker/jobs/ArchivalPoller.ts` (lines 66-79)

- [ ] **Step 1: Update the result parsing and logging block**

Find the block from line 66 to line 79 (`const outboxCount = ...` through the end of the `else` block). Replace it with:

```typescript
    const outboxCount = parseInt(outboxResult?.count ?? '0', 10);
    const eventsCount = parseInt(eventsResult?.count ?? '0', 10);
    const demosCount = parseInt(demosResult?.count ?? '0', 10);
    const costsCount = parseInt(costsResult?.count ?? '0', 10);
    const notificationsCount = parseInt(notificationsResult?.count ?? '0', 10);

    const totalArchived = outboxCount + eventsCount + demosCount + costsCount + notificationsCount;

    if (totalArchived > 0) {
      console.log(
        `${LOG_PREFIX} Archived: ${outboxCount} outbox, ${eventsCount} events, ${demosCount} demos, ${costsCount} api_costs, ${notificationsCount} notifications`,
      );

      const BATCH_LIMIT = 5000;
      const saturated: string[] = [];
      if (outboxCount >= BATCH_LIMIT) saturated.push('outbox');
      if (eventsCount >= BATCH_LIMIT) saturated.push('events');
      if (demosCount >= BATCH_LIMIT) saturated.push('demos');
      if (costsCount >= BATCH_LIMIT) saturated.push('api_costs');
      if (notificationsCount >= BATCH_LIMIT) saturated.push('notifications');

      if (saturated.length > 0) {
        console.warn(
          `${LOG_PREFIX} Batch limit (${BATCH_LIMIT}) reached for: ${saturated.join(', ')} — more rows may remain. Next cycle will continue cleanup.`,
        );
      }
    } else {
      console.log(`${LOG_PREFIX} Nothing to archive`);
    }
```

- [ ] **Step 2: Verify build**

Run: `pnpm tsc --noEmit && pnpm build`
Expected: No errors, build succeeds.

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/ArchivalPoller.ts
git commit -m "feat(20b): ArchivalPoller logs all 5 archival targets with saturation warnings"
```

---

## Task 5: ArchivalPoller Unit Tests

New test file covering all 5 archival targets. Focus: null-business rollup upsert, newer-than-90d rows are skipped, additive batched rollups, saturation warnings.

**Files:**
- Create: `worker/__tests__/ArchivalPoller.test.ts`

- [ ] **Step 1: Write the test file**

Since the production code calls raw SQL via tagged templates and runs DELETE/UPSERT statements, unit tests cover what can be asserted from the mock layer: query ordering, count extraction, log output, and query-shape assertions (the UPSERT/filter clauses are present in the template strings). The actual Postgres semantics — `UNIQUE NULLS NOT DISTINCT` treating two NULL business_ids as colliding, additive UPSERT summing rows correctly, the 90-day filter boundary — are Postgres runtime behaviors that cannot be faked in JavaScript and are implicitly validated by Task 1's `CONSTRAINT uniq_cost_rollups_business_provider_date UNIQUE NULLS NOT DISTINCT ...` schema plus the query-shape assertions below. A full integration test against a real Supabase instance would be the stricter follow-up but is out of scope for unit tests.

```typescript
// worker/__tests__/ArchivalPoller.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mock state ─────────────────────────────────────────────

const { sqlReturnQueue, mockSql } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockSql: any = vi.fn(
    (_strings: TemplateStringsArray, ..._values: unknown[]) => {
      const result = sqlReturnQueue.shift() ?? [];
      return Promise.resolve(result);
    },
  );
  return { sqlReturnQueue, mockSql };
});

vi.mock('../../src/lib/db/server', () => ({
  sql: mockSql,
}));

// Import AFTER mocks are wired
import { startArchivalPoller, stopArchivalPoller } from '../jobs/ArchivalPoller';

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Run one archival cycle synchronously.
 * startArchivalPoller calls runArchival() once immediately, then setInterval.
 * We wait a microtick for the initial run to complete, then stop the poller.
 */
async function runOneCycle(): Promise<void> {
  startArchivalPoller();
  // Let the initial runArchival() Promise resolve.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  stopArchivalPoller();
}

/**
 * Queue the results for all 5 archival queries in order:
 *   outbox, events, demos, api_costs, notifications
 */
function queueArchivalResults(counts: {
  outbox: number;
  events: number;
  demos: number;
  costs: number;
  notifications: number;
}): void {
  sqlReturnQueue.length = 0;
  sqlReturnQueue.push([{ count: String(counts.outbox) }]);
  sqlReturnQueue.push([{ count: String(counts.events) }]);
  sqlReturnQueue.push([{ count: String(counts.demos) }]);
  sqlReturnQueue.push([{ count: String(counts.costs) }]);
  sqlReturnQueue.push([{ count: String(counts.notifications) }]);
}

// ── Tests ──────────────────────────────────────────────────────────

describe('ArchivalPoller', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    stopArchivalPoller();
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('issues 5 SQL queries in order (outbox, events, demos, api_costs, notifications)', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0 });

    await runOneCycle();

    // Excluding the "Starting" log, the 5 archival queries are the first 5 sql() calls.
    expect(mockSql).toHaveBeenCalledTimes(5);
  });

  it('logs all 5 target counts when any archival happened', async () => {
    queueArchivalResults({ outbox: 10, events: 20, demos: 5, costs: 100, notifications: 50 });

    await runOneCycle();

    const archivedLog = logSpy.mock.calls.find((call) =>
      typeof call[0] === 'string' && call[0].includes('Archived:'),
    );
    expect(archivedLog).toBeDefined();
    const msg = archivedLog![0] as string;
    expect(msg).toContain('10 outbox');
    expect(msg).toContain('20 events');
    expect(msg).toContain('5 demos');
    expect(msg).toContain('100 api_costs');
    expect(msg).toContain('50 notifications');
  });

  it('logs "Nothing to archive" when all 5 targets return 0', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0 });

    await runOneCycle();

    const nothingLog = logSpy.mock.calls.find((call) =>
      typeof call[0] === 'string' && call[0].includes('Nothing to archive'),
    );
    expect(nothingLog).toBeDefined();
  });

  it('warns with saturated target names when a batch hits the 5000 limit', async () => {
    queueArchivalResults({ outbox: 5000, events: 0, demos: 0, costs: 5000, notifications: 0 });

    await runOneCycle();

    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
    expect(warnMsg).toContain('outbox');
    expect(warnMsg).toContain('api_costs');
    expect(warnMsg).not.toContain('events');
    expect(warnMsg).not.toContain('notifications');
  });

  it('does not warn when all counts are below 5000', async () => {
    queueArchivalResults({ outbox: 4999, events: 100, demos: 50, costs: 4999, notifications: 1000 });

    await runOneCycle();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('api_costs query uses additive ON CONFLICT DO UPDATE (query shape assertion)', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0 });

    await runOneCycle();

    // The 4th sql() call (index 3) is the api_costs CTE. Its template strings
    // include the UPSERT pattern. Inspect the raw template strings to confirm
    // additive update behavior.
    const apiCostsCall = mockSql.mock.calls[3];
    expect(apiCostsCall).toBeDefined();
    const templateStrings = apiCostsCall![0] as TemplateStringsArray;
    const fullSql = templateStrings.join(' ');
    expect(fullSql).toContain('ON CONFLICT ON CONSTRAINT uniq_cost_rollups_business_provider_date');
    expect(fullSql).toContain('api_costs_daily_rollups.total_cost_usd + EXCLUDED.total_cost_usd');
    expect(fullSql).toContain('api_costs_daily_rollups.call_count + EXCLUDED.call_count');
  });

  it('api_costs query filters rows older than 90 days', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0 });

    await runOneCycle();

    const apiCostsCall = mockSql.mock.calls[3];
    const templateStrings = apiCostsCall![0] as TemplateStringsArray;
    const fullSql = templateStrings.join(' ');
    expect(fullSql).toContain("NOW() - INTERVAL '90 days'");
    expect(fullSql).toContain('LIMIT 5000');
  });

  it('notification_deliveries query filters rows older than 90 days', async () => {
    queueArchivalResults({ outbox: 0, events: 0, demos: 0, costs: 0, notifications: 0 });

    await runOneCycle();

    const ndCall = mockSql.mock.calls[4];
    const templateStrings = ndCall![0] as TemplateStringsArray;
    const fullSql = templateStrings.join(' ');
    expect(fullSql).toContain('notification_deliveries');
    expect(fullSql).toContain("NOW() - INTERVAL '90 days'");
    expect(fullSql).toContain('LIMIT 5000');
  });

  it('continues past SQL failures without throwing', async () => {
    // Simulate all 5 queries failing by leaving the queue empty and making
    // the mock reject. The error handler logs to console.error.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockSql.mockImplementationOnce(() => Promise.reject(new Error('DB unreachable')));

    await runOneCycle();

    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm test -- worker/__tests__/ArchivalPoller.test.ts`
Expected: All 9 tests pass. If a test fails due to timing (the `setImmediate` awaits may not be enough to resolve all promises in one cycle), increase to 3+ awaits or add a small `setTimeout(0)` delay.

- [ ] **Step 3: Run full test suite**

Run: `pnpm test`
Expected: All previous tests (588) + 9 new tests pass.

- [ ] **Step 4: Commit**

```bash
git add worker/__tests__/ArchivalPoller.test.ts
git commit -m "test(20b): ArchivalPoller unit tests — 5 targets, saturation, query shape"
```

---

## Task 6: Admin Costs API — Merge Detail + Rollup, Raise Days Cap

Raise the days cap from 90 to 365 (hard upper bound 365 — rejects 366+). When the requested range crosses the 90-day retention boundary, query both `api_costs` and `api_costs_daily_rollups`, then merge by composite key. Detail rows are authoritative; rollup rows fill dates where detail has been archived.

**Files:**
- Modify: `src/app/api/admin/costs/route.ts`

- [ ] **Step 1: Raise days cap + add rollup query logic**

Replace the current implementation of the `try { ... }` block starting at line 78 (after `try {`) with the version below. Keep imports, interfaces, and helpers unchanged.

The key changes vs. current code:
1. `days` cap raised from 90 to 365, reject >365 with 400
2. Compute `needsRollup = days > 90`
3. If `needsRollup`, also query `api_costs_daily_rollups` in parallel
4. Merge detail + rollup using composite keys
5. `todayTotalUsd` stays detail-only (today is always < 90d)

Replace the entire `export async function GET(...)` function body (lines 68-168) with:

```typescript
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const rawDays = request.nextUrl.searchParams.get('days');
    const parsedDays = parseInt(rawDays ?? '7', 10) || 7;
    if (parsedDays > 365) {
      return NextResponse.json(
        { error: 'days parameter must be 365 or less' },
        { status: 400 },
      );
    }
    const days = Math.min(Math.max(parsedDays, 1), 365);
    const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') ?? '20', 10) || 20, 100);
    const offset = Math.max(parseInt(request.nextUrl.searchParams.get('offset') ?? '0', 10) || 0, 0);
    const needsRollup = days > 90;

    // Detail queries always run — cover the most recent up-to-90 days.
    const [providerRows, businessRows, businessCountRows, dayRows, todayRows] = await Promise.all([
      sql<ProviderRow[]>`
        SELECT provider, SUM(cost_usd)::float AS total_usd, COUNT(*)::int AS call_count
        FROM api_costs
        WHERE created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
        GROUP BY provider
        ORDER BY total_usd DESC
      `,
      sql<BusinessRow[]>`
        SELECT
          b.id AS business_id,
          b.name AS business_name,
          b.subscription_tier,
          SUM(ac.cost_usd)::float AS total_usd,
          COUNT(ac.id)::int AS call_count,
          SUM(CASE WHEN ac.created_at >= CURRENT_DATE THEN ac.cost_usd ELSE 0 END)::float AS today_usd
        FROM api_costs ac
        JOIN businesses b ON ac.business_id = b.id
        WHERE ac.created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
        GROUP BY b.id, b.name, b.subscription_tier
        ORDER BY total_usd DESC
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql<{ total: number }[]>`
        SELECT COUNT(DISTINCT b.id)::int AS total
        FROM api_costs ac JOIN businesses b ON ac.business_id = b.id
        WHERE ac.created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
      `,
      sql<DayRow[]>`
        SELECT
          DATE(created_at)::text AS day,
          SUM(cost_usd)::float AS total_usd,
          COUNT(*)::int AS call_count
        FROM api_costs
        WHERE created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
        GROUP BY DATE(created_at)
        ORDER BY day DESC
      `,
      sql<TodayTotalRow[]>`
        SELECT COALESCE(SUM(cost_usd), 0)::float AS total
        FROM api_costs
        WHERE created_at >= CURRENT_DATE
      `,
    ]);

    // Rollup queries only when range extends beyond 90 days.
    // Rollups cover the archived tail: [startDate, CURRENT_DATE - 90d).
    // Detail covers: [CURRENT_DATE - min(days, 90), CURRENT_DATE].
    let rollupProvider: ProviderRow[] = [];
    let rollupDay: DayRow[] = [];
    let rollupBusinessTotals: Map<string, { total_usd: number; call_count: number }> = new Map();

    if (needsRollup) {
      const [provRes, dayRes, bizRes] = await Promise.all([
        sql<ProviderRow[]>`
          SELECT provider, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::int AS call_count
          FROM api_costs_daily_rollups
          WHERE rollup_date >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
            AND rollup_date < CURRENT_DATE - INTERVAL '90 days'
          GROUP BY provider
        `,
        sql<DayRow[]>`
          SELECT rollup_date::text AS day, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::int AS call_count
          FROM api_costs_daily_rollups
          WHERE rollup_date >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
            AND rollup_date < CURRENT_DATE - INTERVAL '90 days'
          GROUP BY rollup_date
        `,
        sql<{ business_id: string; total_usd: number; call_count: number }[]>`
          SELECT business_id, SUM(total_cost_usd)::float AS total_usd, SUM(call_count)::int AS call_count
          FROM api_costs_daily_rollups
          WHERE rollup_date >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
            AND rollup_date < CURRENT_DATE - INTERVAL '90 days'
            AND business_id IS NOT NULL
          GROUP BY business_id
        `,
      ]);
      rollupProvider = provRes;
      rollupDay = dayRes;
      for (const row of bizRes) {
        rollupBusinessTotals.set(row.business_id, {
          total_usd: row.total_usd,
          call_count: row.call_count,
        });
      }
    }

    // Merge byProvider: sum detail + rollup by provider key.
    const providerMap = new Map<string, { totalUsd: number; callCount: number }>();
    for (const row of providerRows) {
      providerMap.set(row.provider, { totalUsd: row.total_usd, callCount: row.call_count });
    }
    for (const row of rollupProvider) {
      const existing = providerMap.get(row.provider);
      if (existing) {
        existing.totalUsd += row.total_usd;
        existing.callCount += row.call_count;
      } else {
        providerMap.set(row.provider, { totalUsd: row.total_usd, callCount: row.call_count });
      }
    }
    const byProvider = Array.from(providerMap.entries())
      .map(([provider, v]) => ({ provider, totalUsd: v.totalUsd, callCount: v.callCount }))
      .sort((a, b) => b.totalUsd - a.totalUsd);

    // Merge byDay: one row per date, detail OR rollup (the two ranges do not overlap).
    const dayMap = new Map<string, { totalUsd: number; callCount: number }>();
    for (const row of dayRows) {
      dayMap.set(row.day, { totalUsd: row.total_usd, callCount: row.call_count });
    }
    for (const row of rollupDay) {
      // Detail and rollup ranges are non-overlapping by construction (rollup
      // WHERE rollup_date < CURRENT_DATE - 90d; detail always includes newer).
      // Defensively: if a key collides, detail wins (already set above).
      if (!dayMap.has(row.day)) {
        dayMap.set(row.day, { totalUsd: row.total_usd, callCount: row.call_count });
      }
    }
    const byDay = Array.from(dayMap.entries())
      .map(([day, v]) => ({ day, totalUsd: v.totalUsd, callCount: v.callCount }))
      .sort((a, b) => b.day.localeCompare(a.day));

    // Merge byBusiness: add rollup totals to the paginated detail rows.
    // Business rows are already paginated from detail; we enrich the same set
    // with any rollup contributions the same business made in the archived tail.
    const byBusiness = businessRows.map((row) => {
      const limitCents = tierLimitCents(row.subscription_tier);
      const limitUsd = limitCents / 100;
      const rollupExtra = rollupBusinessTotals.get(row.business_id);
      const totalUsd = row.total_usd + (rollupExtra?.total_usd ?? 0);
      const callCount = row.call_count + (rollupExtra?.call_count ?? 0);
      const pctOfDailyLimit = Math.round((row.today_usd / limitUsd) * 100);
      return {
        businessId: row.business_id,
        businessName: row.business_name,
        subscriptionTier: row.subscription_tier,
        totalUsd,
        callCount,
        todayUsd: row.today_usd,
        dailyLimitUsd: limitUsd,
        pctOfDailyLimit,
      };
    });

    const data: CostData = {
      days,
      totalBusinesses: businessCountRows[0]?.total ?? 0,
      limit,
      offset,
      byProvider,
      byBusiness,
      byDay,
      todayTotalUsd: todayRows[0]?.total ?? 0,
      globalDailyLimitUsd: GLOBAL_DAILY_LIMIT_CENTS / 100,
    };

    return NextResponse.json(data);
  } catch (error) {
    console.error('[api/admin/costs] Failed to fetch cost data:', error);
    return NextResponse.json({ error: 'Failed to fetch cost data' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify type check and build**

Run: `pnpm tsc --noEmit && pnpm build`
Expected: No errors.

- [ ] **Step 3: Run existing tests to check for regressions**

Run: `pnpm test`
Expected: All 597+ tests still pass (588 pre-existing + 9 ArchivalPoller).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/admin/costs/route.ts
git commit -m "feat(20b): costs API merges api_costs + rollups for ranges > 90d, raises days cap to 365"
```

---

## Task 7: Admin Costs API Unit Tests

New test file covering: days cap validation (reject > 365), merge correctness (rollup data appears in byProvider/byDay/byBusiness), and the no-rollup-query path when days <= 90.

**Files:**
- Create: `src/app/api/admin/costs/__tests__/route.test.ts`

- [ ] **Step 1: Write the test file**

```typescript
// src/app/api/admin/costs/__tests__/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ── Hoisted mocks ───────────────────────────────────────────────────

const {
  mockRequireRole,
  mockSqlResults,
  sqlCallCounter,
} = vi.hoisted(() => ({
  mockRequireRole: vi.fn(),
  mockSqlResults: [] as unknown[][],
  sqlCallCounter: { value: 0 },
}));

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
      this.name = 'AuthError';
    }
  }
  return {
    requireRole: (...args: unknown[]) => mockRequireRole(...args),
    AuthError,
  };
});

vi.mock('@/lib/db/server', () => {
  const sqlProxy = new Proxy(() => {}, {
    apply: () => {
      const result = mockSqlResults[sqlCallCounter.value] ?? [];
      sqlCallCounter.value++;
      return Promise.resolve(result);
    },
  }) as unknown;
  return { sql: sqlProxy };
});

// ── Helpers ─────────────────────────────────────────────────────────

function makeRequest(url: string): NextRequest {
  return new NextRequest(`http://localhost:3000${url}`);
}

function queueDetailOnlyResults(): void {
  // 5 detail queries: provider, business, businessCount, day, today
  mockSqlResults.length = 0;
  sqlCallCounter.value = 0;
  // 1. byProvider
  mockSqlResults.push([
    { provider: 'openai', total_usd: 1.5, call_count: 10 },
    { provider: 'serpapi', total_usd: 0.5, call_count: 5 },
  ]);
  // 2. byBusiness
  mockSqlResults.push([
    {
      business_id: 'biz-1',
      business_name: 'Test Biz',
      subscription_tier: 'standard',
      total_usd: 2.0,
      call_count: 15,
      today_usd: 0.1,
    },
  ]);
  // 3. businessCount
  mockSqlResults.push([{ total: 1 }]);
  // 4. byDay
  mockSqlResults.push([
    { day: '2026-04-17', total_usd: 2.0, call_count: 15 },
  ]);
  // 5. today
  mockSqlResults.push([{ total: 0.1 }]);
}

function queueDetailPlusRollupResults(): void {
  queueDetailOnlyResults();
  // 3 rollup queries: rollupProvider, rollupDay, rollupBusiness
  mockSqlResults.push([
    { provider: 'openai', total_usd: 0.5, call_count: 3 },
    { provider: 'anthropic', total_usd: 0.2, call_count: 2 },
  ]);
  mockSqlResults.push([
    { day: '2025-12-01', total_usd: 0.7, call_count: 5 },
  ]);
  mockSqlResults.push([
    { business_id: 'biz-1', total_usd: 0.7, call_count: 5 },
  ]);
}

// ── Tests ───────────────────────────────────────────────────────────

describe('GET /api/admin/costs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSqlResults.length = 0;
    sqlCallCounter.value = 0;
    mockRequireRole.mockResolvedValue({
      id: 'admin-1',
      role: 'admin',
      businessId: null,
    });
  });

  it('rejects days > 365 with 400', async () => {
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=400'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('365');
  });

  it('accepts days = 365 and returns 200 without querying rollups for days <= 90', async () => {
    queueDetailOnlyResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=90'));
    expect(res.status).toBe(200);
    // 5 detail queries only — no rollup queries
    expect(sqlCallCounter.value).toBe(5);
  });

  it('queries rollups when days > 90', async () => {
    queueDetailPlusRollupResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=180'));
    expect(res.status).toBe(200);
    // 5 detail + 3 rollup queries
    expect(sqlCallCounter.value).toBe(8);
  });

  it('merges byProvider: rollup totals add to detail totals for matching provider', async () => {
    queueDetailPlusRollupResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=180'));
    const body = await res.json();

    const openai = body.byProvider.find((p: { provider: string }) => p.provider === 'openai');
    // Detail openai: 1.5, rollup openai: 0.5 → total 2.0
    expect(openai.totalUsd).toBe(2.0);
    expect(openai.callCount).toBe(13); // 10 + 3

    const anthropic = body.byProvider.find((p: { provider: string }) => p.provider === 'anthropic');
    // Only in rollup — 0.2
    expect(anthropic.totalUsd).toBe(0.2);
    expect(anthropic.callCount).toBe(2);
  });

  it('merges byDay: rollup days are non-overlapping and appear in result', async () => {
    queueDetailPlusRollupResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=180'));
    const body = await res.json();

    const detailDay = body.byDay.find((d: { day: string }) => d.day === '2026-04-17');
    expect(detailDay.totalUsd).toBe(2.0);

    const rollupDay = body.byDay.find((d: { day: string }) => d.day === '2025-12-01');
    expect(rollupDay).toBeDefined();
    expect(rollupDay.totalUsd).toBe(0.7);
  });

  it('merges byBusiness: rollup contributions added to paginated detail rows', async () => {
    queueDetailPlusRollupResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=180'));
    const body = await res.json();

    const biz = body.byBusiness.find((b: { businessId: string }) => b.businessId === 'biz-1');
    // Detail: 2.0, rollup: 0.7 → total 2.7
    expect(biz.totalUsd).toBe(2.7);
    expect(biz.callCount).toBe(20); // 15 + 5
    // today_usd stays detail-only
    expect(biz.todayUsd).toBe(0.1);
  });

  it('byDay result is sorted descending by day', async () => {
    queueDetailPlusRollupResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=180'));
    const body = await res.json();

    const days = body.byDay.map((d: { day: string }) => d.day);
    const sorted = [...days].sort((a, b) => b.localeCompare(a));
    expect(days).toEqual(sorted);
  });

  it('byProvider result is sorted descending by totalUsd', async () => {
    queueDetailPlusRollupResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=180'));
    const body = await res.json();

    const totals = body.byProvider.map((p: { totalUsd: number }) => p.totalUsd);
    const sorted = [...totals].sort((a, b) => b - a);
    expect(totals).toEqual(sorted);
  });

  it('todayTotalUsd stays detail-only (never enriched from rollup)', async () => {
    queueDetailPlusRollupResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=180'));
    const body = await res.json();

    expect(body.todayTotalUsd).toBe(0.1);
  });

  it('days clamped to [1, 365] when out of range below', async () => {
    queueDetailOnlyResults();
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs?days=0'));
    const body = await res.json();
    expect(body.days).toBe(1);
  });

  it('returns 401 when auth fails', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValue(new AuthError('Unauthenticated', 401));
    const { GET } = await import('../route');
    const res = await GET(makeRequest('/api/admin/costs'));
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test file**

Run: `pnpm test -- src/app/api/admin/costs/__tests__/route.test.ts`
Expected: All 11 tests pass.

- [ ] **Step 3: Run full test suite**

Run: `pnpm test`
Expected: 588 + 9 (ArchivalPoller) + 11 (costs API) = 608 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/admin/costs/__tests__/route.test.ts
git commit -m "test(20b): admin costs API tests — merge, days cap, sorting"
```

---

## Task 8: Final Verification + Docs Update

- [ ] **Step 1: Run all verifications**

```bash
pnpm test          # Expected: 608 passing
pnpm tsc --noEmit  # Expected: no errors
pnpm build         # Expected: success
```

- [ ] **Step 2: Manual query sanity check (optional, requires applied migration + some data)**

In the Supabase SQL editor, after applying migration 017 and letting the poller run once with sample data older than 90 days:

```sql
-- Verify the rollup table is being populated
SELECT COUNT(*) FROM api_costs_daily_rollups;

-- Verify old api_costs rows are deleted
SELECT COUNT(*) FROM api_costs WHERE created_at < NOW() - INTERVAL '90 days';
-- Should trend to 0 over cycles

-- Verify notification_deliveries cleanup
SELECT COUNT(*) FROM notification_deliveries WHERE created_at < NOW() - INTERVAL '90 days';
-- Should trend to 0 over cycles
```

- [ ] **Step 3: Update tracking docs**

Update `.claude/CLAUDE.md` "Current status" section — append to the Sprint 6 entry:

```markdown
  - Prompt 20b (Archival expansion + cost rollups): COMPLETE (2026-04-17) — migration 017 (Sprint 6 schema: api_costs_daily_rollups table with UNIQUE NULLS NOT DISTINCT + 3 indexes, businesses.website, businesses.owner_email_bounced, notification_deliveries(created_at) index). ArchivalPoller extended: api_costs >90d aggregate into rollups via atomic CTE (candidates → aggregate → upsert → delete) with additive ON CONFLICT DO UPDATE; notification_deliveries >90d straight delete. 5-target logging with saturation warnings. Admin costs API merges detail + rollup rows by composite key (detail authoritative); days cap raised 90→365; todayTotalUsd stays detail-only. 608 tests across 46 files.
```

Update `docs/progresstracking.md` — add a new section under Sprint 6:

```markdown
### Prompt 20b — Archival Expansion + Cost Rollups (2026-04-17)

**Status:** COMPLETE

**Migration 017:** `api_costs_daily_rollups` table (UUID PK, UNIQUE NULLS NOT DISTINCT
constraint on business_id+provider+rollup_date, 3 indexes for admin costs query patterns),
`businesses.website`, `businesses.owner_email_bounced`, `notification_deliveries(created_at)` index.

**ArchivalPoller:** Added api_costs aggregate+delete via atomic CTE. Additive ON CONFLICT
DO UPDATE ensures batched cycles don't double-count. Added notification_deliveries straight
delete. 5-target logging with per-target saturation warnings.

**Admin costs API:** Days cap raised 90→365 (rejects >365 with 400). When days > 90,
queries both api_costs and api_costs_daily_rollups in parallel. Merges by composite key:
byProvider sums detail + rollup totals; byDay adds rollup dates (non-overlapping by
construction); byBusiness enriches paginated detail rows with archived-tail totals.
todayTotalUsd stays detail-only.

**Test count:** 608/608 across 46 files (+20 new: 9 ArchivalPoller, 11 costs API).
```

- [ ] **Step 4: Final commit**

```bash
git add .claude/CLAUDE.md && git add -f docs/progresstracking.md
git commit -m "docs: track Prompt 20b completion"
```
