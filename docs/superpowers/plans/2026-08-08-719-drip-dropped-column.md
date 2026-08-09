# Onboarding drip dropped-column repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the three live worker queries still reading the `users.business_id` column that migration 034 dropped on 2026-05-10, bound the `OnboardingDripScheduler`'s unbounded re-queue of failed **Outbox jobs**, cap drips overdue past a grace window, and make a terminal BullMQ handler error raise a real Sentry issue instead of a breadcrumb nobody reads.

**Architecture:** Three defects, one incident. **A** — `handleOnboardingDrip` throws Postgres `42703` at step 5 on every run, after claiming its `onboarding_drip_log` row and before sending, so the topic has never once completed and no email has ever left. **B** — the scheduler's in-flight `NOT EXISTS` excludes only `status <> 'failed'`, so each failed row is re-minted next cycle; 3 locations produced 93 rows. **C** — `worker/index.ts:486` adds a Sentry *breadcrumb* on job failure and never `captureException`, so a hard deterministic crash raised no issue at all.

**Tech Stack:** TypeScript, Postgres.js tagged templates, BullMQ, vitest (`integration` project for live-DB suites), Sentry.

**Ticket:** #719 · **Intake:** `docs/superpowers/plans/feat-719-drip-dropped-column-intake.json`
**Revision:** v2, after Codex plan-review round 1 returned `VERDICT: REVISE` (11 HIGH / 4 MEDIUM). Round-1 report: `docs/reviews/feat-719-drip-dropped-column/plan-round-1.md`.

---

## What round 1 changed, and why (read before implementing)

Four findings reshaped the design. Do not re-introduce what they removed.

1. **The sink no longer writes `job_outbox.last_error`. Sentry only.**
   `OutboxPoller.ts:140-143`'s watchdog terminalizer sets `last_error = 'Stale dispatched entry
   exceeded max_attempts'` **unconditionally**, so anything the sink wrote is destroyed by exactly
   the message it was meant to replace. Preserving it would require editing `OutboxPoller.ts` —
   outside `allowed_edit_surface`, and a second amendment triggers the step-5 abort rule. Two more
   findings independently condemn the write: `worker/jobs/csv-ingest/failed-hook.ts:34` states an
   explicit PII contract (only the bounded error **class** may be persisted or logged, because
   Postgres messages can embed contact handles), and
   `worker/jobs/solicitation-batch/generate-failed-hook.ts:263` deliberately leaves retryable
   exhaustion `dispatched` with its own `last_error`, which a generic `status = 'dispatched'`
   guard would happily overwrite. The `last_error` write was never in the signed-off scope.

2. **Two helpers already exist. Do not write new ones.**
   `recordOutboxTransientError` (`src/lib/shared/outbox.ts:183`) and `isTerminalAttempt` (`:211`)
   already do what the v1 plan proposed to add. `src/lib/shared/outbox.ts` has been **removed from
   `allowed_edit_surface`** — the sink imports `isTerminalAttempt` and `errorMessage` from it and
   adds nothing. Note `isTerminalAttempt`'s predicate is `attemptsMade >= max || attemptsMade + 1
   >= max`, deliberately more generous than a naive `>=`; use it as-is.

3. **The scheduler gets an injected `asOf` seam.** Every boundary this feature promises is a time
   boundary, and separate `NOW()` evaluations cannot pin equality. `runOnboardingDripCycle(exec,
   asOf)` also returns its skip counts, so tests assert a value instead of scraping a log line —
   and, critically, it **throws** where the old `checkAndSchedule` swallowed. A swallowed `42703`
   produced "zero rows queued", which is indistinguishable from a correct skip; every negative
   scheduler test in v1 could have passed against a crashing query.

4. **The eval is 25 tests, not 16.** Round 1 found ten ways all 16 could pass while the feature
   stayed wrong — chief among them that four of them already passed *before* any fix, that day_7
   was never live-tested at all, and that `describeWithDb`'s two-argument form silently registers
   **skipped** suites when `TEST_DATABASE_POOL_URL` is unset, so vitest exits green with all 11
   live cases never run.

Two v1 citations were wrong and are corrected below: `require-owner-access.ts:63` joins by
*authenticated user*, not target-location → account owner, so it is **not** the precedent for this
join; and `AutonomyGovernorScheduler.integration.test.ts` passes its own client explicitly rather
than redirecting the singleton — the real precedent is `ArchivalPoller.integration.test.ts:250-261`.

---

## Glossary (CONTEXT.md — use verbatim)

- **Outbox job** — follow-up work recorded in `job_outbox` in the same transaction as the state change; OutboxPoller dispatches it to BullMQ.
- **Watchdog** — the recovery queries inside a dispatch poller that reclaim rows orphaned by crashes. **Load-bearing here:** it owns the `job_outbox` status machine *and* the terminal `last_error`, which is why the sink writes neither.
- **Full access** — subscription statuses (`active`, `trialing`) that `subscriptionGrantsFullAccess` treats as entitled.
- **Account** = billing parent; **Business** = one Google Business Profile location.

Coined by this work, landing in CONTEXT.md in Task 6: **Drip staleness cap**, **Job-failure sink**.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/lib/shared/__tests__/live-db-tenant.ts` | shared live-DB tenant fixtures | **modify** — add `seedLocation` / `cleanupLocation` |
| `worker/jobs/__tests__/onboarding-drip.integration.test.ts` | live-schema contract: helper + all three drip branches | **create** |
| `worker/background/schedulers/__tests__/onboarding-drip-scheduler.integration.test.ts` | live-schema contract for both scheduler bounds | **create** |
| `worker/__tests__/job-failure-sink.test.ts` | sink behaviour + boot wiring | **create** |
| `worker/jobs/summary-report-helpers.ts` | shared summary/report helpers | **modify** — `ownerHasDashboardAuth` + `buildDashboardUrl` → `resolveDashboardUrl` |
| `worker/jobs/OnboardingDripWorker.ts` | the drip handler | **modify** — use the helper; delete the dead admin branch |
| `worker/jobs/WeeklySummaryWorker.ts` · `worker/jobs/MonthlyImpactWorker.ts` | sibling report workers | **modify** — 3-line call-site update |
| `worker/background/schedulers/OnboardingDripScheduler.ts` | mints drip Outbox jobs | **modify** — `asOf` seam + churn cap + staleness cap |
| `worker/job-failure-sink.ts` | terminal BullMQ failure → Sentry | **create** |
| `worker/index.ts` | registration + lifecycle | **modify** — attach the sink in the existing per-queue loop |

`src/lib/shared/outbox.ts` is **read-only** for this feature.

## Task graph

```
T1 (eval, alone — enforcement spot check)
 ├─→ T2 ─→ T3        (resolveDashboardUrl → drip worker)
 ├─→ T4              (scheduler)   ┐ mutually independent,
 └─→ T5              (sink)        ┘ disjoint files, parallel
              T3,T4,T5 ─→ T6 (docs)
```

T6 blocks on **T3** (not merely T2) because its lab note asserts the drip-worker repair landed.

---

### Task 1: Eval — all 25 promised tests, failing

**Blocking edges:** none. Runs ALONE (first-task enforcement spot check).

**Files:** modify `src/lib/shared/__tests__/live-db-tenant.ts`; create the three suites listed above.

**Live-DB conventions** (`ci:live-db-suites` enforces them, and since #720 it audits helper files too): suites named `*.integration.test.ts`; **no run-time DDL**; gate through `describeWithDb`. Provision with `pnpm test:db:setup`.

- [ ] **Step 1: Add the location fixture to the existing tenant helper**

`seedTenantAccount` seeds `users` + `accounts` but not `businesses`. Verified against the live schema: `businesses`' only NOT NULL columns without defaults are `id, name, owner_name, owner_email, account_id`, all supplied here.

```typescript
export interface LocationSeed { businessId: string }

export interface SeedLocationOverrides {
  businessId?: string;
  name?: string;
  ownerName?: string;
  ownerEmail?: string;
  isPrimary?: boolean;
  subscriptionActivatedAt?: Date | null;
  onboardedBy?: string | null;
}

export async function seedLocation(
  db: Sql,
  accountId: string,
  overrides: SeedLocationOverrides = {},
): Promise<LocationSeed> {
  const businessId = overrides.businessId ?? randomUUID();
  await db`
    INSERT INTO businesses (
      id, account_id, name, owner_name, owner_email, is_primary,
      subscription_activated_at, onboarded_by
    )
    VALUES (
      ${businessId}::uuid, ${accountId}::uuid,
      ${overrides.name ?? 'Seed Location'},
      ${overrides.ownerName ?? 'Seed Owner'},
      ${overrides.ownerEmail ?? `loc-${businessId}@test.local`},
      ${overrides.isPrimary ?? true},
      ${overrides.subscriptionActivatedAt ?? null},
      ${overrides.onboardedBy ?? null}
    )
  `;
  return { businessId };
}

export async function cleanupLocation(db: Sql, businessId: string): Promise<void> {
  await db`DELETE FROM businesses WHERE id = ${businessId}::uuid`;
}
```

- [ ] **Step 2: Add the execution sentinel — the test that proves the other live tests RAN**

`describeWithDb`'s two-argument form registers *skipped* suites when `TEST_DATABASE_POOL_URL` is unset, so vitest can exit green with zero live coverage.

**The sentinel must sit OUTSIDE `describeWithDb`.** Putting it inside would make it skip under
exactly the condition it exists to detect — a guard that disappears whenever it is needed is not a
guard. It therefore runs unconditionally, silenced only by the repo's sanctioned opt-out
`REPWORTH_DISABLE_LIVE_DB_SUITES=1`, so an *accidentally* missing URL fails loudly while a
*deliberate* local opt-out stays quiet. Put it at the top of
`worker/jobs/__tests__/onboarding-drip.integration.test.ts`, before any `describeWithDb` block:

```typescript
import { assertSchemaReady } from '@/lib/shared/__tests__/helpers/schema-ready';

// Deliberately NOT inside describeWithDb: that helper SKIPS when the URL is
// absent, which is the exact failure this test exists to catch. A silent skip
// of the other 10 live cases is indistinguishable from a green run, and that
// blindness is how #719 shipped in the first place.
const liveDbDeliberatelyDisabled = process.env.REPWORTH_DISABLE_LIVE_DB_SUITES === '1';

describe.skipIf(liveDbDeliberatelyDisabled)('#719 live-DB eval preconditions', () => {
  it('the live-DB eval executes against migration-head Postgres', async () => {
    expect(process.env.TEST_DATABASE_POOL_URL ?? '').not.toBe('');
    const probe = postgres(process.env.TEST_DATABASE_POOL_URL!, { max: 1, onnotice: () => {} });
    try {
      await assertSchemaReady(probe);
    } finally {
      await probe.end();
    }
  });
});
```

This is the one test in the eval that is **green before any implementation task** — it asserts
infrastructure, not behaviour, and is a discriminator for "did the guard run", not for "is the
feature fixed". Every other title (2–25) must be red before its implementing task.

- [ ] **Step 3: Write the drip live-DB suite (titles 2–11), failing**

File: `worker/jobs/__tests__/onboarding-drip.integration.test.ts`. Follow `ArchivalPoller.integration.test.ts:250-261` if the handler needs the singleton redirected. Mock **only** the email transport:

```typescript
vi.mock('@/lib/notifications/email', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'msg-live-drip' }),
}));
```

Titles 2–7 exercise `resolveDashboardUrl` (Task 2's shape) — **not a copied SQL literal**. Round 1's finding: a test that runs its own copy of the fixed query passes before the fix and proves nothing about production. Import the real function.

| # | Title | Seed → assert |
|---|---|---|
| 2 | `resolveDashboardUrl returns a dashboard URL for a location whose account owner has auth_id` | owner with `auth_id` → `'<appUrl>/dashboard'` |
| 3 | `resolveDashboardUrl returns null when the location account owner has no auth_id` | `auth_id = NULL` → `null` |
| 4 | `resolveDashboardUrl returns null for an authenticated non-owner on the account` | second user, `role='staff'`, `auth_id` set, owner's `auth_id` NULL → `null`. **Catches a query that drops `u.role = 'owner'`** |
| 5 | `resolveDashboardUrl resolves the account owner for a non-primary location` | two locations on one account, target `is_primary=false` → URL. **Catches a query that restricts to the primary business** |
| 6 | `resolveDashboardUrl does not match an owner belonging to a different account` | account A owner `auth_id` NULL, account B owner set; query A → `null` |
| 7 | `resolveDashboardUrl returns null without querying when no app URL is configured` | `appUrl` undefined → `null`, and assert no query ran (spy the client) |

Titles 8–11 run the **real** `handleOnboardingDrip` against a seeded `dispatched` `job_outbox` row. Every one asserts the transport call **as well as** the DB facts — writing the log/delivery/completion rows without actually sending must fail:

| # | Title | Assert |
|---|---|---|
| 8 | `handleOnboardingDrip sends day_1 to the seeded owner with a dashboard URL and completes the outbox row` | transport called once, `to` = seeded owner email, rendered body contains `/dashboard`; `job_outbox.status='completed'`; `onboarding_drip_log.sent_at IS NOT NULL`; delivery template `onboarding_drip_day_1` |
| 9 | `handleOnboardingDrip sends day_7 against the live schema and records an onboarding_drip_day_7 delivery` | same three DB facts for `day_7`. **The only live coverage of day_7's five branch-specific queries** — seed activation ≥7d old plus one handled response so the recap has content |
| 10 | `handleOnboardingDrip signs day_30 with the seeded onboarded_by admin name` | seed an `admin` user + `businesses.onboarded_by`; assert `buildOnboardingDay30Html` received that exact name |
| 11 | `handleOnboardingDrip omits the day_30 sign-off when the location has no onboarded_by admin` | `onboardedBy: null` → `supportContactName: null`, row completed |

- [ ] **Step 4: Write the scheduler live-DB suite (titles 12–20), failing**

File: `worker/background/schedulers/__tests__/onboarding-drip-scheduler.integration.test.ts`. Call `runOnboardingDripCycle(db, asOf)` (Task 4's seam) **directly** with an explicit `asOf` and the suite's own client — no singleton redirection, no wall-clock.

**Contamination hazard — read before writing an assertion.** `runOnboardingDripCycle` scans **every**
business in the database, not just the one under test. Any leftover eligible business from another
suite lands in the returned counts and in `job_outbox`. Two consequences, both mandatory:

- **Never assert a global count.** Not `result.queued === 1`, not `SELECT count(*) FROM job_outbox
  WHERE topic = 'onboarding_drip'`. Every assertion scopes to the seeded `business_id`:
  `SELECT count(*) … WHERE aggregate_id = ${businessId} AND status = 'pending'`. For the skip
  cases, assert the seeded pair produced **no** row of its own rather than that the cycle queued
  nothing at all.
- **Enrol in `acquireLiveDbLock`**, following `ArchivalPoller.integration.test.ts` — the precedent
  for a suite whose subject sweeps shared tables. Release it in `afterAll`.

For the `tooLate` / `churnCapped` counts, which are inherently global, seed the negative fixture and
assert the count **increased by exactly one** relative to a baseline cycle run before the seed —
never that it equals one.

Grace = 3 days, so day_1's cap is `activated + 4 days` and the outer reporting window is `+ 5 days`.

| # | Title | Seed → assert |
|---|---|---|
| 12 | `the scheduler queues day_1 exactly at the staleness grace boundary` | `activated = asOf - 4 days` exactly → 1 pending row. **The locked intake says send AT the boundary; v1's `<=` skipped it** |
| 13 | `the scheduler skips and warns just past the staleness grace boundary` | `asOf - 4 days - 1 minute` → 0 rows, `tooLate` count 1 |
| 14 | `the scheduler stops reporting a drip at the grace-plus-one outer boundary` | `asOf - 5 days` and `- 10 days` → 0 rows **and** `tooLate` count 0 |
| 15 | `the scheduler treats three failures exactly 24 hours old as outside the churn window` | 3 failed, clock exactly `asOf - 24h` → 1 pending row (window is strict `>`) |
| 16 | `the scheduler skips a drip with more than three failures inside the churn window` | 4 recent failures → 0 rows. **Catches `count = 3`** |
| 17 | `the scheduler counts a recent dispatch failure whose outbox row was created more than 24 hours ago` | 3 rows: `status='failed'`, `completed_at=NULL`, `created_at=asOf-30h`, `dispatched_at=asOf-1h` → capped, 0 rows. **This is why the clock is `COALESCE(completed_at, dispatched_at, created_at)`: the poller's dispatch-error path never sets `completed_at`** |
| 18 | `the churn cap counts only failed rows for the same topic, business and drip_type` | 2 matching failures + failures for another business, another drip_type, another topic → still queues |
| 19 | `the scheduler applies the churn and staleness bounds to day_7 and day_30` | one churn-capped day_7 and one stale day_30 → correct outcome each. **Catches bounds wired to day_1 only** |
| 20 | `every scheduler skip completes without a swallowed SQL error` | for each negative fixture assert the call **resolves** (not rejects) and `logger.error` was not called. **`checkAndSchedule` used to swallow, so "0 rows" could mean the query crashed** |

- [ ] **Step 5: Write the sink suite (titles 21–25), failing**

File: `worker/__tests__/job-failure-sink.test.ts`. Unit — mock `@sentry/node`; build fake `Job`s with `attemptsMade` / `opts.attempts`.

| # | Title | Assert |
|---|---|---|
| 21 | `the job-failure sink captures to Sentry only on the terminal BullMQ attempt` | `attemptsMade=5, opts.attempts=5` → `captureException` once, tags `{subsystem:'worker_job', queue}` |
| 22 | `the job-failure sink does not capture when an intermediate attempt fails and a retry remains` | `attemptsMade=1, opts.attempts=5` → not called |
| 23 | `the job-failure sink logs a bounded error class and never the raw message` | error whose `.message` embeds `secret-handle@example.com` → assert no logger call argument contains it, and the log carries `error_class` |
| 24 | `the job-failure sink ignores a failed event with an undefined job` | `job = undefined` → no Sentry call, resolves |
| 25 | `worker boot attaches the failure sink to every registered worker` | one attachment per `workersByQueue` entry. **A perfect sink that is never wired passes every other test** |

- [ ] **Step 6: Run the eval and verify it fails for the RIGHT reasons**

`test:db:setup` reads `.env.local` internally but does **not** export the URL to the later vitest process — export it explicitly or every live test skips:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-719-drip-dropped-column
pnpm test:db:setup
export TEST_DATABASE_POOL_URL="$(rg -m1 '^TEST_DATABASE_POOL_URL=' .env.local | cut -d= -f2-)"
pnpm vitest run worker/jobs/__tests__/onboarding-drip.integration.test.ts \
  worker/background/schedulers/__tests__/onboarding-drip-scheduler.integration.test.ts \
  worker/__tests__/job-failure-sink.test.ts
```

Expected: title 1 PASSES (the sentinel proves the DB is live — if it *skips*, stop, nothing else is meaningful). Titles 2–11 FAIL with `column "business_id" does not exist` or "resolveDashboardUrl is not a function". Titles 12–20 FAIL on the missing `runOnboardingDripCycle` export. Titles 21–25 FAIL on the missing module.

**Every one of 2–25 must be red.** Round 1 caught four v1 tests that passed pre-fix; if any test here is green before implementation, it does not discriminate — fix the test.

- [ ] **Step 7: `pnpm ci:live-db-suites`** — expected PASS. Fix naming/DDL/lock enrolment if flagged; do not add an allowlist entry.

- [ ] **Step 8: Commit**

```bash
git add src/lib/shared/__tests__/live-db-tenant.ts worker/jobs/__tests__/onboarding-drip.integration.test.ts worker/background/schedulers/__tests__/onboarding-drip-scheduler.integration.test.ts worker/__tests__/job-failure-sink.test.ts
git commit -m "test(#719): failing eval — 25 tests across live schema, scheduler bounds, job-failure sink"
```

---

### Task 2: `resolveDashboardUrl`

**Blocking edges:** T1. **Turns green:** 2–7.

**Files:** modify `worker/jobs/summary-report-helpers.ts:218-231`, `worker/jobs/WeeklySummaryWorker.ts:213-216`, `worker/jobs/MonthlyImpactWorker.ts:294-297`

Fix and collapse in one task: all three call sites compose `ownerHasDashboardAuth` + `buildDashboardUrl` verbatim, `Array<{exists: number}>` is interface nobody needed, and keeping the old names would have forced deliberately false test titles.

- [ ] **Step 1: Replace both exports with one**

```typescript
/**
 * Resolves the owner-facing dashboard URL for a location, or null when the
 * owner cannot use one (no owner row, no auth_id, or no configured app URL).
 *
 * The join is the post-034 location→owner path: businesses.account_id →
 * users.account_id. `users.business_id` was dropped by migration 034 on
 * 2026-05-10 and the previous query still read it, throwing 42703 on every
 * WeeklySummary, MonthlyImpact and onboarding-drip run until #719.
 *
 * `u.role = 'owner'` and the account join are both load-bearing: without the
 * role an authenticated staff user satisfies it, and without the account scope
 * it would resolve across tenants.
 */
export async function resolveDashboardUrl(
  sql: postgres.Sql,
  businessId: LocationId,
  appUrl: string | undefined,
): Promise<string | null> {
  if (!appUrl) return null;   // skip the query entirely — the old pair always ran it, then discarded the result
  const rows = await sql<{ exists: number }[]>`
    SELECT 1 AS exists
    FROM users u
    JOIN businesses b ON b.account_id = u.account_id
    WHERE b.id = ${businessId}
      AND u.role = 'owner'
      AND u.auth_id IS NOT NULL
    LIMIT 1
  `;
  return rows.length > 0 ? `${appUrl}/dashboard` : null;
}
```

- [ ] **Step 2: Update the two sibling call sites**

```typescript
const dashboardUrl = await resolveDashboardUrl(db, businessId, cfg.NEXT_PUBLIC_APP_URL);                 // WeeklySummaryWorker
const dashboardUrl = await resolveDashboardUrl(sql, businessId, getWorkerConfig().NEXT_PUBLIC_APP_URL);  // MonthlyImpactWorker
```

Update both import blocks; drop the now-unused names.

- [ ] **Step 3: Verify no orphans**

```bash
rg -n "ownerHasDashboardAuth|buildDashboardUrl" worker/ src/ --type ts
```
Expected: only `src/hooks/useDashboardData.ts` (an unrelated same-named local function).

- [ ] **Step 4: Run titles 2–7 + the two workers' suites + typecheck, then commit**

```bash
pnpm typecheck && pnpm vitest run worker/jobs/__tests__/
git add worker/jobs/summary-report-helpers.ts worker/jobs/WeeklySummaryWorker.ts worker/jobs/MonthlyImpactWorker.ts
git commit -m "fix(#719): resolveDashboardUrl joins through accounts — users.business_id died in 034"
```

---

### Task 3: Drip worker — use the helper, delete the dead branch

**Blocking edges:** T2. **Turns green:** 8–11.

**Files:** modify `worker/jobs/OnboardingDripWorker.ts` (~144-149 and ~412-432)

- [ ] **Step 1: Replace the inline duplicate (lines 144-149)**

```typescript
import { resolveDashboardUrl } from './summary-report-helpers';
```
```typescript
  // ── 5. Dashboard URL (null when the owner has no auth) ────────────
  const dashboardUrl = await resolveDashboardUrl(sql, businessId, appUrl);
```

- [ ] **Step 2: Delete the dead business-scoped-admin branch (lines ~412-432)**

`users.role = 'admin' AND business_id = …` cannot match post-034: the column is gone, and every `admin` user carries `account_id IS NULL`, so no account-scoped rewrite would match either. Delete, do not port.

```typescript
  // Staff sign-off name — resolved only from the onboarding staff member on
  // businesses.onboarded_by. The former business-scoped-admin branch read
  // users.business_id (dropped in migration 034) and is deleted rather than
  // ported: admins carry account_id IS NULL, so no rewrite of it could match.
  const [onboarder] = await sql<{ name: string }[]>`
    SELECT u.name FROM users u
    JOIN businesses b ON b.onboarded_by = u.id
    WHERE b.id = ${business.id} AND u.role = 'admin'
    LIMIT 1
  `;
  const supportContactName: string | null = onboarder?.name ?? null;
```

- [ ] **Step 3: Run titles 8–11 and repair the unit suite**

```bash
pnpm vitest run worker/jobs/__tests__/onboarding-drip.integration.test.ts worker/jobs/__tests__/OnboardingDripWorker.test.ts
```
`OnboardingDripWorker.test.ts` feeds `mockSql` from a positional queue, so removing two queries shifts it. Update the fixture ordering — **and treat any case that still passes without an edit as suspect**, because that is the same blindness that let #719 ship.

- [ ] **Step 4: Commit**

```bash
git add worker/jobs/OnboardingDripWorker.ts worker/jobs/__tests__/OnboardingDripWorker.test.ts
git commit -m "fix(#719): drip worker uses resolveDashboardUrl; drop the dead admin sign-off branch"
```

---

### Task 4: Scheduler — `asOf` seam, churn cap, staleness cap

**Blocking edges:** T1. **Independent of T2/T3/T5.** **Turns green:** 12–20.

**Files:** modify `worker/background/schedulers/OnboardingDripScheduler.ts:25-95`

- [ ] **Step 1: Constants**

```typescript
// Drip staleness cap (#719): a drip whose due date passed by more than this
// grace window is never queued and never sent. Without it, any outage that
// pauses drips clears into a burst of "Welcome to day 1!" emails to owners who
// joined long ago. Send AT the boundary, skip past it.
const STALENESS_GRACE_DAYS = 3;

// Churn cap (#719): stop re-minting an Outbox job for a (location, drip_type)
// that already failed this many times in the rolling window below. The
// in-flight NOT EXISTS excludes 'failed', so before this a permanently-broken
// drip re-queued every cycle forever — 93 rows across 3 locations on staging.
// Rolling rather than lifetime so a transient provider outage self-heals the
// next day; the Job-failure sink (T5) is what makes a persistent failure
// visible within the hour instead of silently trickling.
const MAX_FAILURES_PER_DAY = 3;
const CHURN_WINDOW_HOURS = 24;
```

- [ ] **Step 2: Extract the injectable cycle**

The old `checkAndSchedule` caught its own query error and returned, making "0 rows queued" indistinguishable from a crash — every negative test would have been vacuous. The cycle now **throws**; only the poll wrapper swallows. It also takes `asOf`, because every bound this feature promises is a time boundary and separate `NOW()` evaluations cannot pin equality. Explicit `exec` also satisfies invariant #15.

```typescript
export interface DripCycleResult {
  queued: number;
  tooLate: number;
  churnCapped: number;
}

export async function runOnboardingDripCycle(
  exec: Sql,
  asOf: Date,
): Promise<DripCycleResult> {
  const dueDrips = await exec<{
    business_id: string;
    drip_type: string;
    too_late: boolean;
    churn_capped: boolean;
  }[]>`
    SELECT b.id AS business_id, d.drip_type,
           b.subscription_activated_at
             < ${asOf}::timestamptz - ((d.days + ${STALENESS_GRACE_DAYS}) || ' days')::interval
             AS too_late,
           (
             SELECT count(*) FROM job_outbox jo
             WHERE jo.topic = ${QUEUE_NAMES.ONBOARDING_DRIP}
               AND jo.aggregate_id = b.id
               AND jo.payload->>'drip_type' = d.drip_type
               AND jo.status = 'failed'
               -- Three-way COALESCE because the two paths that write 'failed'
               -- disagree: the watchdog stamps completed_at, the poller's
               -- dispatch-error path (OutboxPoller.ts:293-299) does not but has
               -- refreshed dispatched_at at claim time. created_at is the floor.
               AND COALESCE(jo.completed_at, jo.dispatched_at, jo.created_at)
                     > ${asOf}::timestamptz - make_interval(hours => ${CHURN_WINDOW_HOURS})
           ) >= ${MAX_FAILURES_PER_DAY} AS churn_capped
    FROM businesses b
    JOIN accounts a ON a.id = b.account_id
    CROSS JOIN (VALUES ('day_1', 1), ('day_7', 7), ('day_30', 30)) AS d(drip_type, days)
    WHERE a.subscription_status IN ('active', 'trialing')  -- enum: SubscriptionStatus.ACTIVE / .TRIALING
      AND b.subscription_activated_at IS NOT NULL
      AND b.subscription_activated_at <= ${asOf}::timestamptz - (d.days || ' days')::interval
      -- Abandoned tail: a pair past the grace window is reported for exactly one
      -- day (so the skip is observable) and then never selected again.
      AND b.subscription_activated_at
            > ${asOf}::timestamptz - ((d.days + ${STALENESS_GRACE_DAYS} + 1) || ' days')::interval
      AND NOT EXISTS (
        SELECT 1 FROM onboarding_drip_log dl
        WHERE dl.business_id = b.id AND dl.drip_type = d.drip_type
          AND dl.sent_at IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1 FROM job_outbox jo
        WHERE jo.topic = ${QUEUE_NAMES.ONBOARDING_DRIP}
          AND jo.aggregate_id = b.id
          AND jo.status <> 'failed'
          AND jo.payload->>'drip_type' = d.drip_type
      )
  `;

  const tooLate = dueDrips.filter((r) => r.too_late);
  // Staleness wins when a pair is both: a too-late pair is leaving for good, and
  // reporting it as merely churn-capped would imply it returns tomorrow.
  const churnCapped = dueDrips.filter((r) => !r.too_late && r.churn_capped);
  const actionable = dueDrips.filter((r) => !r.too_late && !r.churn_capped);

  let queued = 0;
  for (const row of actionable) {
    const payload: OnboardingDripPayload = {
      business_id: row.business_id,
      drip_type: row.drip_type as OnboardingDripPayload['drip_type'],
      correlation_id: uuidv7(),
    };
    try {
      const inserted = await exec`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (${uuidv7()}, ${QUEUE_NAMES.ONBOARDING_DRIP}, 'business',
                ${row.business_id}, ${jsonb(payload)}, 'pending')
        ON CONFLICT DO NOTHING
      `;
      if (inserted.count > 0) queued++;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') continue;
      logger.error(`Failed to queue ${row.drip_type} for business ${row.business_id}`, err);
    }
  }

  if (tooLate.length > 0) {
    logger.warn('Skipped drips past the staleness grace window', {
      count: tooLate.length, grace_days: STALENESS_GRACE_DAYS,
    });
  }
  if (churnCapped.length > 0) {
    logger.warn('Skipped drips at the daily failure cap', {
      count: churnCapped.length, max_failures_per_day: MAX_FAILURES_PER_DAY,
    });
  }
  if (queued > 0) logger.log(`Queued ${queued} onboarding_drip outbox entries`);

  return { queued, tooLate: tooLate.length, churnCapped: churnCapped.length };
}
```

- [ ] **Step 3: Reduce `checkAndSchedule` to the poll wrapper**

```typescript
export async function checkAndSchedule(): Promise<void> {
  try {
    if (isMockMode()) { logger.log('Mock mode — skipping'); return; }
    await runOnboardingDripCycle(sql, new Date());
  } catch (error) {
    logger.error('Scheduler cycle failed', error);
  }
}
```

`jsonb(x)` stays here: this file is a registered composition root.

- [ ] **Step 4: Run titles 12–20 and the existing unit suite, then commit**

```bash
pnpm vitest run worker/background/schedulers/
git add worker/background/schedulers/
git commit -m "fix(#719): bound the drip scheduler — 3 failures/24h churn cap + 3-day staleness cap, asOf seam"
```

---

### Task 5: Job-failure sink (Sentry only)

**Blocking edges:** T1. **Independent of T2/T3/T4.** **Turns green:** 21–25.

**Files:** create `worker/job-failure-sink.ts`; modify `worker/index.ts:486-488`

**Do not add anything to `src/lib/shared/outbox.ts`** — `isTerminalAttempt` and `errorMessage` already exist there and this module imports them. **Do not write `job_outbox.last_error`** — see "What round 1 changed" §1.

- [ ] **Step 1: Create the sink**

```typescript
// Terminal BullMQ job failure → a real Sentry issue.
//
// Before #719 the only reporting here was a Sentry *breadcrumb*, which attaches
// to some later unrelated event or to nothing at all. A handler that threw on
// every attempt therefore produced no issue, and the onboarding drip crashed
// deterministically for three months behind that gap.
//
// Deliberately does NOT touch job_outbox. The watchdog owns the status machine
// AND overwrites last_error unconditionally when it terminalizes
// (OutboxPoller.ts:140-143), so a write here is destroyed by the very message it
// would replace; queues that want durable per-domain error text own a domain
// 'failed' hook that writes it properly (see csv-ingest, solicitation-batch).
//
// Extracted rather than inlined per invariant #12.
import * as Sentry from '@sentry/node';
import type { Job, Worker } from 'bullmq';
import { createWorkerLogger, toError } from '../src/lib/shared/logger';
import { isTerminalAttempt } from '../src/lib/shared/outbox';

const logger = createWorkerLogger('[JobFailureSink]');

/**
 * Error NAME only. Mirrors csv-ingest's PII contract
 * (worker/jobs/csv-ingest/failed-hook.ts:93): a driver message may embed
 * contact handles, and string logger arguments bypass the object sanitizer.
 * The full error still reaches Sentry, which has its own scrubber.
 */
function boundedErrorClass(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

export function reportJobFailure(queueName: string, job: Job | undefined, err: Error): void {
  try {
    if (!job || !isTerminalAttempt(job)) return;

    Sentry.captureException(err, {
      tags: { subsystem: 'worker_job', queue: queueName },
      extra: {
        job_id: job.id,
        job_name: job.name,
        outbox_id: (job.data as { outbox_id?: unknown } | undefined)?.outbox_id,
        attempts_made: job.attemptsMade,
      },
    });

    logger.error(`${queueName} job exhausted its retries`, {
      job_id: job.id,
      error_class: boundedErrorClass(err),
    });
  } catch (sinkError) {
    // Last-resort sink: a failure to REPORT a failure must never escalate.
    logger.error('job failure sink failed', toError(sinkError));
  }
}

export function attachJobFailureSink(worker: Pick<Worker, 'on'>, queueName: string): void {
  worker.on('failed', (job, err) => reportJobFailure(queueName, job, err));
}
```

Synchronous throughout — nothing awaits, so there is no floating promise and no listener-ordering hazard against the domain hooks.

- [ ] **Step 2: Wire it**

In `worker/index.ts`, inside the existing `for (const [queueName, worker] of Object.entries(workersByQueue))` loop, **replace** the breadcrumb-only `worker.on('failed', …)` at lines 486-488 with:

```typescript
  attachJobFailureSink(worker, queueName);
```

Add the import. Leave `'active'` / `'completed'` breadcrumbs and all six domain `'failed'` hooks untouched.

- [ ] **Step 3: Run titles 21–25, then commit**

```bash
pnpm vitest run worker/__tests__/
git add worker/job-failure-sink.ts worker/index.ts
git commit -m "feat(#719): job-failure sink — terminal BullMQ errors raise a Sentry issue, not a breadcrumb"
```

---

### Task 6: Domain sweep — CONTEXT.md + lab notes

**Blocking edges:** T3, T4, T5.

**Files:** modify `CONTEXT.md`, `.claude/reference/lab-notes.md`

- [ ] **Step 1: Coin the two terms in CONTEXT.md**, after the **Watchdog** entry:

- **Drip staleness cap** — the `STALENESS_GRACE_DAYS` (3) bound in `OnboardingDripScheduler`: a drip whose due date passed by more than the grace window is never queued and never sent, permanently. It exists so an outage that pauses drips does not clear into a burst of late "Welcome to day 1!" emails. Sends **at** the boundary, skips past it. Enforced at the **producer only** — the scheduler is the topic's sole producer, so a second handler-side check would be defensive branching around a state the producer excludes. The abandoned tail is reported for one day (the `GRACE + 1` outer window) and then drops out of the query forever. *(coined in #719)*
- **Job-failure sink** — `worker/job-failure-sink.ts`, attached to every BullMQ `Worker` alongside `attachEmitterErrorLogger`. On the **terminal** attempt only (`isTerminalAttempt`), it raises a Sentry issue rather than the breadcrumb that preceded it. It deliberately writes **nothing** to `job_outbox`: the **Watchdog** overwrites `last_error` unconditionally when it terminalizes, and a raw driver message can embed contact PII, so durable per-domain error text stays the job of the six domain `'failed'` hooks. Sentry is the single durable record of a handler error. *(coined in #719)*

Also sharpen the **Watchdog** entry: its `'Stale dispatched entry exceeded max_attempts'` text describes the *reclaim*, never the underlying handler failure, and it overwrites whatever `last_error` was there. Reading it as a diagnosis is what let #719 hide for three months — the diagnosis is in Sentry.

- [ ] **Step 2: Lab notes** (`- [DATE] WHAT FAILED → WHY → CORRECT APPROACH`)

```markdown
- [2026-08-09] `onboarding_drip` never once completed on staging (93 failed rows, 0 completed) → `handleOnboardingDrip` read `users.business_id`, dropped by migration 034 on 2026-05-10, throwing `42703` after claiming the drip-log row and before sending; three sites shared it (`OnboardingDripWorker` ×2, `ownerHasDashboardAuth`, the latter latent in `WeeklySummaryWorker`/`MonthlyImpactWorker`) → post-034 the location→owner path is `businesses.account_id → users.account_id`. **A dropped column is invisible to these unit tests**: worker suites mock `sql` as a positional queue returning canned rows for any SQL, so only a `*.integration.test.ts` catches it — and `describeWithDb` SKIPS rather than fails without `TEST_DATABASE_POOL_URL`, so the suite needs an execution sentinel or the guard silently does not run.
- [2026-08-09] The failure was undiagnosable → `worker/index.ts` added a Sentry *breadcrumb* on job failure and never `captureException`, so a deterministic crash raised no issue → the **Job-failure sink** now captures on the terminal attempt. It writes nothing to `job_outbox`: the watchdog's terminalizer at `OutboxPoller.ts:140-143` sets `last_error` **unconditionally**, so anything written there is destroyed by the generic text it was meant to replace.
- [2026-08-09] The pile was *growing*, not stale → `OnboardingDripScheduler`'s in-flight `NOT EXISTS` excludes only `status <> 'failed'`, so every failed row was re-minted next cycle: each burns 5 watchdog attempts over ~75 min, then a fresh one appears → any scheduler re-queuing on a predicate that excludes `failed` needs a failure bound. Rolling (3/24h) over lifetime, so a transient outage self-heals.
- [2026-08-09] Counting recent `job_outbox` failures by `completed_at` alone under-counts, and `COALESCE(completed_at, created_at)` still gets it wrong → the watchdog's terminate path stamps `completed_at`, the poller's dispatch-error path (`OutboxPoller.ts:293-299`) does not, and a long-lived row can fail recently → use `COALESCE(completed_at, dispatched_at, created_at)`: the claim UPDATE refreshes `dispatched_at` on every attempt.
- [2026-08-09] Before adding an outbox write helper or a BullMQ final-attempt check, grep `src/lib/shared/outbox.ts` → `recordOutboxTransientError` (:183) and `isTerminalAttempt` (:210) already exist; a plan round-1 review caught both about to be reinvented. `isTerminalAttempt` is deliberately `attemptsMade >= max || attemptsMade + 1 >= max`, not a naive `>=`.
- [2026-08-09] A generic worker-level `'failed'` listener must not persist or string-log `err.message` → `worker/jobs/csv-ingest/failed-hook.ts:34` states the contract (only the bounded error CLASS, because Postgres messages may embed contact handles) and string logger args bypass the object sanitizer → log `err.name`, let Sentry carry the message under its own scrubber.
```

- [ ] **Step 3: Commit**

```bash
git add CONTEXT.md .claude/reference/lab-notes.md
git commit -m "docs(#719): coin Drip staleness cap + Job-failure sink; lab notes for the 034 dropped-column class"
```

---

## Verification gate

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-719-drip-dropped-column
export TEST_DATABASE_POOL_URL="$(rg -m1 '^TEST_DATABASE_POOL_URL=' .env.local | cut -d= -f2-)"
bash scripts/verify-gate.sh --review
```

All rows green including `promised-tests` (25 verbatim titles), `diff-coverage` (≥80% changed lines), and `reclassify` (prod ≤240, test ≤1600). A `SKIP` on the integration row is **not** review-ready for this feature.

## Staging ride (RISK = high)

1. Push to `staging`; Railway worker + Vercel staging auto-deploy.
2. Watch for a **new** `onboarding_drip` `job_outbox` row reaching `status='completed'` — the topic has never done this. The 93 existing failed rows are all well past the 24h churn window, so the cap will not block a fresh mint.
3. Confirm: `onboarding_drip_log.sent_at IS NOT NULL`, a `notification_deliveries` row with `template='onboarding_drip_day_1'`, and the mail in `norbertliverpool+e1/+e3/+e7@gmail.com`.
4. **Timing:** the three staging locations activated 2026-08-05/06, so with a 3-day grace their day_1 window closes 2026-08-09 15:47 UTC / 2026-08-10 01:42 UTC. Past that, day_1 is correctly skipped as too-late and the ride verifies **day_7** (due 08-12/13) instead. Do **not** shorten the grace to force a day_1 send.
5. Do **not** purge the 93 failed rows — they are the before/after evidence.
6. PR to `main`, CI green, then PAUSE for explicit merge approval.

## Follow-ups filed separately

- A `ci:*` audit extracting SQL column references and diffing them against migration-head schema. Declined here as its own epic-sized ticket; the live-DB suites cover this feature's queries only, so the class remains open elsewhere.
- Making the watchdog's terminalizer preserve a non-generic `last_error` (`OutboxPoller.ts:140-143`). Out of surface for #719; it is the missing half of durable per-job diagnosis.
