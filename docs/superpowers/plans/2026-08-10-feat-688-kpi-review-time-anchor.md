# KPI Review-time Anchor (#688) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-anchor the reputation KPIs (review volume MoM, 8-week sentiment trend, avg star) on the **Review-time anchor** `LEAST(review_date, detected_at)` so a consented Review import lands in its true months/weeks; keep response rate on `detected_at`; exclude `approved_at < detected_at` rows from avg time-to-respond.

**Architecture:** Pure deepening of the KPI service module (`src/lib/kpi/service.ts`) — the interface (`getLocationKpiSummary`/`getAccountKpiSummary`) is untouched; two new lazy fragment factories join the existing `detectedAtWindowFilter` pattern, and `ttrHandledWindowFilter` gains one predicate. No migration, no new seam. Evidence is a new live-DB integration suite (SQL semantics) plus fragment-text assertions in the existing mock suite.

**Tech Stack:** Postgres.js lazy fragments, vitest + fragment-aware `createMockSql`, live-DB suite conventions (`describeWithDb`, `assertSchemaReady`, `seedTenantAccount`/`seedLocation`).

**Intake contract:** `docs/superpowers/plans/feat-688-kpi-review-time-anchor-intake.json` (armed copy `.feature/intake.json`). Glossary: **Review import**, **Import window** (CONTEXT.md); this feature coins **Review-time anchor** (Task 4).

**Constraints the executor must not violate:**
- Tenant-scope predicates and FROM/JOIN stay written out literally in every query template (`scripts/ci/tenant-scope-audit.ts` reads raw template text — see the comment block at `src/lib/kpi/service.ts:100-114`). The new fragments compose like `detectedAtWindowFilter` — they never contain FROM/JOIN or the `SELECT` keyword.
- Live-DB suite rules (#573): named `*.integration.test.ts`, `describeWithDb`-gated, `assertSchemaReady`, NO run-time DDL, fixtures via DML only, all time arithmetic in SQL (`NOW() - interval …`), never JS `Date`.
- No string literals for statuses: import `REVIEW_STATUS` (`@/lib/reviews/status`) and `HANDLED_STATUSES`/response status constants (`@/lib/shared/response-status`).
- Allowed edit surface: `src/lib/kpi/service.ts`, `src/lib/kpi/__tests__/**`, `docs/adr/0019-kpi-review-time-anchor.md`, `CONTEXT.md`, `docs/superpowers/plans/**`, `docs/reviews/**`.

---

## Task 1: EVAL — live-DB integration suite with all 8 promised tests

**Files:**
- Create: `src/lib/kpi/__tests__/service.anchor.integration.test.ts`

**Blocking edges:** none (runs FIRST, alone — enforcement spot check).

Boilerplate precedent: `src/lib/past-replies/__tests__/load-replies.integration.test.ts` (imports, `describeWithDb` gating, `beforeAll` connect + `assertSchemaReady` + `seedTenantAccount`, `afterAll` `cleanupTenantAccount` + `db.end()`). All needed columns predate migration 071, so `assertSchemaReady(sql(), MIGRATION_071_RUN_SPINE)` is a valid floor.

- [ ] **Step 1: Write the suite.** Structure (complete fixture/assertion spec — executor writes the boilerplate from the precedent):

```ts
// src/lib/kpi/__tests__/service.anchor.integration.test.ts
//
// EVAL suite for #688 — Review-time anchor semantics. The mocked suite
// (service.test.ts) asserts the SHAPE of the SQL; this proves the bucketing
// MEANS what #688 decided, against real Postgres: LEAST NULL-skip, week/month
// bucketing, and the TTR validity filter. Live-DB conventions per CLAUDE.md.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import { cleanupTenantAccount, seedTenantAccount, seedLocation, cleanupLocation, type TenantSeed } from '@/lib/shared/__tests__/live-db-tenant';
import { assertSchemaReady, MIGRATION_071_RUN_SPINE } from '@/lib/shared/__tests__/helpers/schema-ready';
import { REVIEW_STATUS } from '@/lib/reviews/status';
import { RESPONSE_STATUS } from '@/lib/shared/response-status'; // use the actual exported name — grep the file
import { getAccountKpiSummary, getLocationKpiSummary } from '../service';

// KPI summaries read the Upstash cache first; always-miss stub keeps this
// suite Postgres-only (cache contract lives in service.cache.test.ts).
vi.mock('@/lib/db/redis-cache', () => ({
  getCacheRedis: () => ({ get: async () => null, set: async () => 'OK' }),
}));
```

One ISOLATED business per KPI cluster (location-scope summaries are per-business, so per-cluster isolation makes every expectation exact — mirror the `isolatedBusinessId` pattern; create each with `seedLocation` under `tenant.accountId`, clean with `cleanupLocation`):
`VOLUME_BIZ`, `TREND_BIZ`, `STAR_BIZ`, `NULLFB_BIZ`, `FUTURE_BIZ`, `RATE_BIZ`, `TTR_BIZ`.

`seedReview` helper (DML insert; all timestamps as SQL expressions passed via `sql.unsafe`-free tagged params — build intervals with `NOW() - make_interval(days => ${n})` or pass an SQL fragment): insert into `reviews` with explicit `review_date`, `detected_at`, `star_rating`, `sentiment_score`, `status: REVIEW_STATUS.NEW`, unique `provider_review_id`/`provider_review_name` per row (prefix `kpi-anchor-${randomUUID()}`). `seedResponse` helper: insert into `responses` with `status` = posted constant, explicit `approved_at`.

The 8 promised tests (titles VERBATIM — the gate's `promised-tests` row greps them):

1. `it('volume MoM buckets an imported review into its review_date month, not the import month', …)`
   - VOLUME_BIZ: review with `review_date = DATE_TRUNC('month', NOW()) - interval '10 days'` (always prior calendar month), `detected_at = NOW()`.
   - Assert `reviewVolume` is `{ currentMonth: 0, priorMonth: 1, … }`. (RED today: counts as currentMonth.)
2. `it('sentiment trend buckets an imported review into its review_date week, not the import week', …)`
   - TREND_BIZ: review with `review_date = DATE_TRUNC('week', NOW()) - interval '21 days'` (Monday, 3 weeks back), `sentiment_score = 0.8`, `detected_at = NOW()`.
   - Compute expected weekStart IN SQL: `SELECT (DATE_TRUNC('week', NOW()) - interval '21 days')::date::text AS wk` — never via JS Date.
   - Assert that weekStart's trend point has `reviewCount: 1`, and the current week's point has `reviewCount: 0`. (RED today.)
3. `it('avg star window excludes a review whose review_date is outside the window even though detected_at is inside', …)`
   - STAR_BIZ: review star 1, `review_date = NOW() - interval '60 days'`, `detected_at = NOW()`; review star 5, `review_date = NOW() - interval '1 day'`, `detected_at = NOW() - interval '1 day'`.
   - Assert `averageStarRating === 5`. (RED today: reads 3.)
4. `it('review-time anchor falls back to detected_at when review_date is NULL', …)`
   - NULLFB_BIZ: review star 4, `review_date = NULL`, `detected_at = NOW()`.
   - Assert `averageStarRating === 4` AND `reviewVolume.currentMonth === 1`. (GREEN today and after — regression pin for the LEAST NULL-skip.)
5. `it('review-time anchor clamps a future review_date to detected_at', …)`
   - FUTURE_BIZ: review `review_date = NOW() + interval '2 days'`, `sentiment_score = 0.5`, `detected_at = NOW()`.
   - Assert the CURRENT week's trend point has `reviewCount: 1` (sum of all points === 1). (GREEN today; guards against a naive `COALESCE(review_date, detected_at)` implementation, under which the future week vanishes from the generate_series LEFT JOIN.)
6. `it('response rate still windows on detected_at so imported unanswered reviews drag the rate', …)`
   - RATE_BIZ: unanswered review `review_date = NOW() - interval '200 days'`, `detected_at = NOW()`.
   - Assert `responseRate` is `{ received: 1, handled: 0, ratePct: 0 }`. (GREEN today and after — pins the workflow-KPI half of the #688 decision.)
7. `it('time-to-respond excludes a response whose approved_at predates its review's detected_at', …)` *(escape the apostrophes or use double quotes — title must match the intake string byte-for-byte)*
   - TTR_BIZ: review G `detected_at = NOW() - interval '1 day'` + posted response `approved_at = NOW() - interval '10 days'` (inside the 30d approved_at window, BEFORE detected_at — the bounded in-window negative case measured on staging).
   - Plus the Task-8 pair below in the same business; assert `averageTimeToRespondHours === 6` — G contributes nothing. (RED today: negative sample drags the average.)
8. `it('time-to-respond keeps a response whose approved_at follows its review's detected_at', …)`
   - TTR_BIZ: review H `detected_at = NOW() - interval '10 hours'` + posted response `approved_at = NOW() - interval '4 hours'` → 6.0h.
   - Assert `averageTimeToRespondHours === 6`. (GREEN today only if test 7's row is absent — seed order makes 7+8 assert the same summary; keep both titles, both assert 6.)

Supplementary (NOT in the promised list): `it('account scope applies the same review-time anchor', …)` — `getAccountKpiSummary(sql(), tenant.accountId)` must aggregate identically (e.g. `reviewVolume.priorMonth ≥ 1` from VOLUME_BIZ and star/trend consistent with the per-business expectations).

- [ ] **Step 2: Run the suite RED.** `cd <worktree> && TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/kpi/__tests__/service.anchor.integration.test.ts`
  Expected: tests 1, 2, 3, 7 FAIL (detected_at bucketing / negative TTR sample); tests 4, 5, 6, 8 PASS (regression pins). If a "pin" test fails, the fixture is wrong — fix the fixture, not the assertion.
- [ ] **Step 3: Commit** `test(#688): eval suite — review-time anchor semantics (4 red / 4 pin)`.

## Task 2: Review-time anchor fragments + star/volume/trend (both scopes)

**Files:**
- Modify: `src/lib/kpi/service.ts` (fragments ~`:123-153`; location queries `:194-243`; account queries `:294-360`; header comment `:5`)
- Modify: `src/lib/kpi/__tests__/service.test.ts` (fragment-text assertions)

**Blocking edges:** Task 1.

- [ ] **Step 1: Add the fragment factories** beside `detectedAtWindowFilter`:

```ts
/**
 * Review-time anchor (#688, ADR 0019) — the timestamp the reputation KPIs
 * (volume MoM, sentiment trend, avg star) bucket on, so a consented Review
 * import lands in its true months/weeks instead of spiking the import month.
 * LEAST ignores NULLs in Postgres: a NULL review_date falls back to
 * detected_at, and a clock-skewed FUTURE review_date clamps to detected_at
 * (unclamped, a future week silently vanishes from the trend's
 * generate_series LEFT JOIN). Workflow KPIs (response rate) deliberately
 * stay on detected_at — imported unanswered reviews are meant to drag the
 * rate (#675 nudge reasoning).
 */
function reviewTimeAnchor(sql: Sql, prefix: '' | 'r.') {
  return prefix === 'r.'
    ? sql`LEAST(r.review_date, r.detected_at)`
    : sql`LEAST(review_date, detected_at)`;
}

/** Rolling review-time lookback for the avg-star query (both scopes). */
function reviewTimeWindowFilter(sql: Sql, prefix: '' | 'r.', windowDays: number) {
  return sql`${reviewTimeAnchor(sql, prefix)} >= NOW() - make_interval(days => ${windowDays})`;
}
```

- [ ] **Step 2: Apply to the six query sites.**
  - Avg star, location (`:200`): `${detectedAtWindowFilter(sql, '', windowDays)}` → `${reviewTimeWindowFilter(sql, '', windowDays)}`. Account (`:307`): prefix `'r.'`.
  - Volume, location (`:205-209`): both `FILTER (WHERE …)` predicates swap `detected_at` for `${reviewTimeAnchor(sql, '')}`. Account (`:314-317`): `${reviewTimeAnchor(sql, 'r.')}`.
  - Trend inner subquery, location (`:233-240`): `DATE_TRUNC('week', ${reviewTimeAnchor(sql, '')})` in the SELECT and the GROUP BY (same fragment → identical text, which Postgres requires), and the week filter becomes `${reviewTimeAnchor(sql, '')} >= NOW() - make_interval(weeks => ${trendWeeks})`. Account (`:344-353`): prefix `'r.'`.
  - `detectedAtWindowFilter` doc comment: now "response-rate query only (workflow KPI — #688 keeps it on detected_at)".
  - Header comment `:5`: drop "No real-DB test" (Task 1 added one).
- [ ] **Step 3: Mock-suite fragment assertions** in `service.test.ts` (query order is fixed: 0 rate, 1 star, 2 volume, 3 ttr, 4 trend):

```ts
it('anchors star/volume/trend on the review-time anchor and keeps rate on detected_at', async () => {
  seed();
  await getLocationKpiSummary(mockSql, 'biz-1');
  expect(harness.sqlCalls[1].text).toContain('LEAST(review_date, detected_at)');
  expect(harness.sqlCalls[2].text).toContain('LEAST(review_date, detected_at)');
  expect(harness.sqlCalls[4].text).toContain('LEAST(review_date, detected_at)');
  expect(harness.sqlCalls[0].text).not.toContain('LEAST(');
  expect(harness.sqlCalls[0].text).toContain('detected_at >=');
});
```
  Plus the account-scope twin asserting `'LEAST(r.review_date, r.detected_at)'` on calls 1/2/4.
- [ ] **Step 4: Verify.** `pnpm vitest run src/lib/kpi/ && TEST_DATABASE_POOL_URL=<resolved> pnpm vitest run src/lib/kpi/__tests__/service.anchor.integration.test.ts`
  Expected: integration tests 1-6 PASS; 7 still FAILS (TTR is Task 3); mock suites all PASS. Then `pnpm ci:tenant-scope` — PASS (fragments hide no FROM/JOIN).
- [ ] **Step 5: Commit** `feat(#688): review-time anchor for volume/trend/avg-star KPIs`.

## Task 3: TTR validity filter

**Files:**
- Modify: `src/lib/kpi/service.ts` (`ttrHandledWindowFilter`, `:149-153`)
- Modify: `src/lib/kpi/__tests__/service.test.ts`

**Blocking edges:** Task 2 (same file).

- [ ] **Step 1: Extend `ttrHandledWindowFilter`:**

```ts
function ttrHandledWindowFilter(sql: Sql, handled: string[], windowDays: number) {
  // approved_at >= r.detected_at: a pre-existing Google reply imported by
  // reconcileExternallyAnsweredReview carries its ORIGINAL timestamp, which
  // can predate detection — a negative duration is never our response
  // latency (#688; 16 rows at up to −2.9y measured on staging).
  return sql`${handledStatusFilter(sql, handled)}
        AND resp.approved_at IS NOT NULL
        AND resp.approved_at >= r.detected_at
        AND resp.approved_at >= NOW() - make_interval(days => ${windowDays})`;
}
```
  (Both scopes alias reviews as `r`, so one change covers both.)
- [ ] **Step 2: Mock assertion** — extend the Task 2 test (location + account): `expect(harness.sqlCalls[3].text).toContain('approved_at >= r.detected_at')`.
- [ ] **Step 3: Verify ALL GREEN.** Same commands as Task 2 Step 4; integration tests 1-8 PASS, mock suites PASS.
- [ ] **Step 4: Commit** `fix(#688): exclude pre-existing-reply rows from avg time-to-respond`.

## Task 4: ADR 0019 + CONTEXT.md glossary

**Files:**
- Create: `docs/adr/0019-kpi-review-time-anchor.md`
- Modify: `CONTEXT.md` (glossary — insert alphabetically near the Review-import cluster)

**Blocking edges:** Task 1 complete (may run PARALLEL with Tasks 2-3 — disjoint files).

- [ ] **Step 1: ADR 0019** — follow the house format of `docs/adr/0016-import-consent-enforcement-locus.md` (Status/Context/Decision/Consequences/Rejected). Content: #688 grilling (2026-08-10) decided the Review-time anchor `LEAST(review_date, detected_at)` for reputation KPIs; response rate + MonthlyImpactWorker digest stay detection-time (activity semantics, #675 nudge preserved); TTR gains the `approved_at >= detected_at` validity filter (exclusion, not clamp). Rejected: import discriminator migration (schema cost, provenance-by-column deferred until a second consumer; imported rows would stay invisible in volume while the Reviews list shows them), accept-as-is (ships a fake growth spike at GA), TTR clamp-to-zero (reads faster-than-real). Supersedes the #675 intake's "accepted as-is" holding position.
- [ ] **Step 2: CONTEXT.md glossary entry:**

```md
- **Review-time anchor**: `LEAST(review_date, detected_at)` — the timestamp the reputation KPIs (review volume MoM, 8-week sentiment trend, avg star) bucket on, so a consented Review import lands in its true months/weeks instead of spiking the import month (and instantly yields a real historical trend). LEAST ignores NULLs: a NULL `review_date` falls back to `detected_at`; a clock-skewed future `review_date` clamps to `detected_at` (unclamped it vanishes from the trend's `generate_series` LEFT JOIN). Workflow surfaces — response rate and the MonthlyImpactWorker digest — deliberately stay on `detected_at`: an import is account activity, and imported unanswered reviews are meant to drag the rate (#675 nudge reasoning). Time-to-respond carries the companion validity filter `approved_at >= detected_at`, so a pre-existing Google reply imported by reconcile can never contribute a negative duration. One owner: `reviewTimeAnchor` (`src/lib/kpi/service.ts`). _Avoid_: review_date anchor (names the column, not the clamp), import exclusion (rejected design — imported rows participate, in their true buckets). *(coined at #688 grilling 2026-08-10; ADR 0019)*
```
- [ ] **Step 3: Commit** `docs(#688): ADR 0019 + Review-time anchor glossary entry`.

---

## Post-task verification (orchestrator, step 5)

`bash scripts/verify-gate.sh` after Task 3, `--review` variant before step 7. Deviations file: `docs/superpowers/plans/feat-688-kpi-review-time-anchor-deviations.md`.

## Self-review notes

- Spec coverage: intake behaviors 1-5 ↔ tests 1-8 + supplementary account test; invariants covered by ci:tenant-scope + fragment shape; non-goals touch no task.
- Type consistency: `reviewTimeAnchor`/`reviewTimeWindowFilter` named identically in Tasks 2-3; no new exports.
- Mutual independence: only Task 4 ∥ Tasks 2-3.
