# Onboarding drip dropped-column repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the three live worker queries still reading the `users.business_id` column that migration 034 dropped on 2026-05-10, bound the `OnboardingDripScheduler`'s unbounded re-queue of failed **Outbox jobs**, cap drips overdue past a grace window, and make a BullMQ handler's terminal error durably visible instead of being masked by the **Watchdog**'s generic reclaim message.

**Architecture:** Three defects, one incident. **A** — `handleOnboardingDrip` throws Postgres `42703` at step 5 on every run, after claiming its `onboarding_drip_log` row and before sending, so the topic has never once completed and no email has ever left (0 `notification_deliveries`, 0 `sent_at` — the double-send hypothesis is ruled out). **B** — the scheduler's in-flight `NOT EXISTS` excludes only `status <> 'failed'`, so each failed row is re-minted next cycle; 3 locations produced 93 rows. **C** — `worker/index.ts:486` adds a Sentry *breadcrumb* on job failure and never `captureException`, so a hard deterministic crash produced no Sentry issue and `last_error` showed only the Watchdog's text. Unit mocks cannot catch A: `mockSql` is a positional queue that returns canned rows for any SQL, so the guard has to be live-DB.

**Tech Stack:** TypeScript, Postgres.js tagged templates, BullMQ, vitest (`integration` project for live-DB suites), Sentry.

**Ticket:** #719 · **Intake:** `docs/superpowers/plans/feat-719-drip-dropped-column-intake.json`

---

## Glossary (CONTEXT.md — use verbatim)

- **Outbox job** — follow-up work recorded in `job_outbox` in the same transaction as the state change; OutboxPoller dispatches it to BullMQ.
- **Watchdog** — the recovery queries inside a dispatch poller that reclaim rows orphaned by crashes. **Load-bearing here:** it owns the `job_outbox` status machine, and nothing in this plan writes a status on its behalf.
- **Full access** — subscription statuses (`active`, `trialing`) that `subscriptionGrantsFullAccess` treats as entitled.
- **Account** = billing parent; **Business** = one Google Business Profile location.

Two terms are coined by this work and land in CONTEXT.md in Task 7: **Drip staleness cap** and **Job-failure sink**.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/lib/shared/__tests__/live-db-tenant.ts` | shared live-DB tenant fixtures | **modify** — add `seedLocation` / `cleanupLocation` (existing owner of `seedTenantAccount`; no new helper file) |
| `worker/jobs/__tests__/onboarding-drip.integration.test.ts` | live-schema contract for the drip's owner/admin lookups + full day_1 path | **create** |
| `worker/background/schedulers/__tests__/onboarding-drip-scheduler.integration.test.ts` | live-schema contract for the two new scheduler bounds | **create** |
| `worker/__tests__/job-failure-sink.test.ts` | sink unit behaviour | **create** |
| `worker/jobs/summary-report-helpers.ts` | shared summary/report query helpers | **modify** — fix the join; then collapse two helpers into `resolveDashboardUrl` |
| `worker/jobs/OnboardingDripWorker.ts` | the drip handler | **modify** — delete inline duplicate query + dead admin branch |
| `worker/jobs/WeeklySummaryWorker.ts` · `worker/jobs/MonthlyImpactWorker.ts` | drip's sibling report workers | **modify** — 3-line call-site update (Task 4 only) |
| `worker/background/schedulers/OnboardingDripScheduler.ts` | mints drip Outbox jobs | **modify** — churn cap + staleness cap + skip logging |
| `src/lib/shared/outbox.ts` | sole owner of `job_outbox` writes | **modify** — add `recordOutboxLastError` sibling |
| `worker/job-failure-sink.ts` | terminal BullMQ failure → Sentry + `last_error` | **create** |
| `worker/index.ts` | registration + lifecycle | **modify** — attach the sink in the existing per-queue loop |

## Task graph

```
T1 (eval, alone — enforcement spot check)
 ├─→ T2 ─→ T3 ─→ T4        (owner-auth join → drip worker → helper collapse)
 ├─→ T5                    (scheduler bounds)      ┐ mutually independent,
 └─→ T6                    (outbox helper + sink)  ┘ disjoint files, parallel
                    T2,T5,T6 ─→ T7 (docs)
```

---

### Task 1: Eval — all 16 promised tests, failing

**Blocking edges:** none. Runs ALONE (first-task enforcement spot check).

**Files:**
- Modify: `src/lib/shared/__tests__/live-db-tenant.ts`
- Create: `worker/jobs/__tests__/onboarding-drip.integration.test.ts`
- Create: `worker/background/schedulers/__tests__/onboarding-drip-scheduler.integration.test.ts`
- Create: `worker/__tests__/job-failure-sink.test.ts`

**Live-DB conventions (non-negotiable, `ci:live-db-suites` enforces them — and since #720 it audits helper files too):** suites are named `*.integration.test.ts`; they execute **no run-time DDL**; they gate through `describeWithDb` from `@/__tests__/helpers/describe-with-db`. Provision with `pnpm test:db:setup` before running.

- [ ] **Step 1: Add the location fixture to the existing tenant helper**

`seedTenantAccount` seeds `users` + `accounts` but not `businesses`, and two suites need a location. Add to `src/lib/shared/__tests__/live-db-tenant.ts` (INSERTs only — no DDL):

```typescript
export interface LocationSeed {
  businessId: string;
}

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
      ${businessId}::uuid,
      ${accountId}::uuid,
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

If `businesses` has additional `NOT NULL` columns without defaults, add them here with literal test values — read the live schema with `\d businesses`, do **not** guess.

- [ ] **Step 2: Write the drip live-DB suite (tests 1–6), all failing**

Create `worker/jobs/__tests__/onboarding-drip.integration.test.ts`. Tests 1–4 assert the query executes at all — that is the whole point, since a `42703` is what shipped:

```typescript
// Live-schema contract for every users-table lookup the onboarding drip makes.
// #719: these queries read users.business_id, dropped by migration 034 on
// 2026-05-10, and threw 42703 on every run for three months. A unit mock
// returns canned rows for any SQL and structurally cannot catch that; only a
// real connection can. Assert EXECUTION first, shape second.

import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type postgresType from 'postgres';
import { randomUUID } from 'node:crypto';
import { describeWithDb } from '@/__tests__/helpers/describe-with-db';
import {
  seedTenantAccount,
  cleanupTenantAccount,
  seedLocation,
  cleanupLocation,
} from '@/lib/shared/__tests__/live-db-tenant';
import { ownerHasDashboardAuth } from '../summary-report-helpers';
import { asLocationId } from '@/lib/shared/ids';

const testDatabaseUrl = process.env.TEST_DATABASE_POOL_URL;
let db: postgresType.Sql | undefined;
function sql(): postgresType.Sql {
  if (!db) throw new Error('onboarding-drip integration database was not initialized');
  return db;
}

describeWithDb('onboarding drip — live schema contract', () => {
  beforeAll(() => {
    db = postgres(testDatabaseUrl!, { max: 2, statement_timeout: 30_000, onnotice: () => {} });
  });
  afterAll(async () => { await db?.end(); });

  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  async function seedOwnedLocation(opts: { authId?: string | null } = {}) {
    const tenant = await seedTenantAccount(sql(), { subscriptionStatus: 'trialing' });
    const loc = await seedLocation(sql(), tenant.accountId, {
      subscriptionActivatedAt: new Date(Date.now() - 2 * 86_400_000),
    });
    if (opts.authId !== null) {
      await sql()`UPDATE users SET auth_id = ${opts.authId ?? randomUUID()} WHERE id = ${tenant.userId}::uuid`;
    }
    cleanups.push(async () => {
      await cleanupLocation(sql(), loc.businessId);
      await cleanupTenantAccount(sql(), tenant);
    });
    return { tenant, businessId: loc.businessId };
  }

  it('ownerHasDashboardAuth executes against the live schema and finds an owner with auth_id', async () => {
    const { businessId } = await seedOwnedLocation();
    const rows = await ownerHasDashboardAuth(sql(), asLocationId(businessId));
    expect(rows.length).toBe(1);
  });

  it('ownerHasDashboardAuth returns no row when the location owner has no auth_id', async () => {
    const { businessId } = await seedOwnedLocation({ authId: null });
    const rows = await ownerHasDashboardAuth(sql(), asLocationId(businessId));
    expect(rows.length).toBe(0);
  });

  it('ownerHasDashboardAuth does not match an owner belonging to a different account', async () => {
    const a = await seedOwnedLocation();
    const b = await seedOwnedLocation();
    // b's owner has auth_id; a's location must not see it.
    await sql()`UPDATE users SET auth_id = NULL WHERE id = ${a.tenant.userId}::uuid`;
    const rows = await ownerHasDashboardAuth(sql(), asLocationId(a.businessId));
    expect(rows.length).toBe(0);
    const other = await ownerHasDashboardAuth(sql(), asLocationId(b.businessId));
    expect(other.length).toBe(1);
  });

  it('the day_30 onboarded_by sign-off query executes against the live schema', async () => {
    const { tenant, businessId } = await seedOwnedLocation();
    await sql()`UPDATE users SET role = 'admin' WHERE id = ${tenant.userId}::uuid`;
    await sql()`UPDATE businesses SET onboarded_by = ${tenant.userId}::uuid WHERE id = ${businessId}::uuid`;
    const rows = await sql<{ name: string }[]>`
      SELECT u.name FROM users u
      JOIN businesses b ON b.onboarded_by = u.id
      WHERE b.id = ${businessId}::uuid AND u.role = 'admin'
      LIMIT 1
    `;
    expect(rows[0]?.name).toBe('Tenant Seed Owner');
  });
});
```

Tests 5 and 6 exercise `handleOnboardingDrip` end-to-end. Add a second `describeWithDb` block in the same file. Mock **only** the email transport — everything else hits the real DB, because the DB is the thing under test:

```typescript
vi.mock('@/lib/notifications/email', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendInternalEmail: vi.fn().mockResolvedValue({ messageId: 'msg-live-drip' }),
}));
```

```typescript
  it('handleOnboardingDrip completes the outbox row and records a delivery for day_1', async () => {
    // seed location + a 'dispatched' job_outbox row for topic onboarding_drip,
    // then invoke handleOnboardingDrip with { business_id, drip_type: 'day_1',
    // outbox_id, outbox_attempt: 1 } and assert ALL THREE terminal facts:
    //   job_outbox.status = 'completed'
    //   onboarding_drip_log.sent_at IS NOT NULL
    //   notification_deliveries has template 'onboarding_drip_day_1'
    // These are exactly the three facts that are false in staging today.
  });

  it('day_30 omits the sign-off when the location has no onboarded_by admin', async () => {
    // seed with onboardedBy: null, run day_30, assert buildOnboardingDay30Html
    // received supportContactName: null and the handler completed the row.
  });
```

Write these two bodies out in full when implementing — the comments above name every assertion; do not leave them as comments in the committed file.

- [ ] **Step 3: Write the scheduler live-DB suite (tests 7–11), all failing**

Create `worker/background/schedulers/__tests__/onboarding-drip-scheduler.integration.test.ts`. Each test seeds a location plus N `job_outbox` rows in a chosen state, calls `checkAndSchedule()`, then asserts whether a **new** `pending` row was minted.

The scheduler imports the singleton `sql` from `src/lib/db/server`, so point that singleton at the test DB the way the existing suites do. Copy the mechanism from `worker/background/schedulers/__tests__/AutonomyGovernorScheduler.integration.test.ts` (closest analogue — a scheduler integration suite in the same directory); `worker/background/pollers/__tests__/ArchivalPoller.integration.test.ts` is a second reference. Do not invent a third mechanism.

```typescript
  it('the scheduler skips a business and drip_type with 3 or more onboarding_drip failures in the last 24 hours', async () => { /* 3 failed rows, completed_at NOW() - 1 hour → 0 new pending rows */ });
  it('the scheduler re-queues a business and drip_type whose 3 failures are all older than 24 hours', async () => { /* completed_at NOW() - 30 hours → exactly 1 new pending row */ });
  it('the scheduler still queues a business and drip_type with only 2 failures in the last 24 hours', async () => { /* 2 failed rows recent → exactly 1 new pending row */ });
  it('the scheduler does not queue a drip whose due date passed more than the staleness grace window ago', async () => { /* subscription_activated_at NOW() - 10 days, day_1 → 0 new pending rows */ });
  it('the scheduler queues a drip that is overdue but still inside the staleness grace window', async () => { /* subscription_activated_at NOW() - 3 days, day_1 (due at 1d, grace 3d → cap at 4d) → exactly 1 new pending row */ });
```

- [ ] **Step 4: Write the sink unit suite (tests 12–16), all failing**

Create `worker/__tests__/job-failure-sink.test.ts`. Pure unit — mock `@sentry/node` and the outbox module; build fake `Job`s with `attemptsMade` / `opts.attempts`.

```typescript
  it('the job-failure sink captures the handler error to Sentry only on the final BullMQ attempt', async () => { /* attemptsMade 5, opts.attempts 5 → captureException called once with tags {subsystem:'worker_job', queue} */ });
  it('the job-failure sink records the real handler error on the outbox row without changing its status', async () => { /* recordOutboxLastError called with (sql, outboxId, err.message, outboxAttempt); assert markOutboxFailed NOT called */ });
  it('the job-failure sink does not capture when an intermediate attempt fails and a retry remains', async () => { /* attemptsMade 2, opts.attempts 5 → captureException NOT called, recordOutboxLastError NOT called */ });
  it('the job-failure sink does not overwrite last_error on an outbox row a domain hook already terminalized', async () => { /* recordOutboxLastError resolves 0 rows (status no longer 'dispatched'); assert the sink does not throw and logs the no-op */ });
  it('the job-failure sink no-ops when the job payload carries no outbox_id', async () => { /* job.data = {} → recordOutboxLastError NOT called; Sentry still captures */ });
```

Note test 16 deliberately does **not** use `extractOutboxHandle`: that helper falls back to `job.id`, which is load-bearing for every worker but wrong here — a BullMQ job id is not an outbox id and writing against it would be a silent no-op UPDATE against a random row key.

- [ ] **Step 5: Run the full eval and verify everything fails for the RIGHT reason**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-719-drip-dropped-column
pnpm test:db:setup
pnpm vitest run worker/jobs/__tests__/onboarding-drip.integration.test.ts \
  worker/background/schedulers/__tests__/onboarding-drip-scheduler.integration.test.ts \
  worker/__tests__/job-failure-sink.test.ts
```

Expected: tests 1–4 FAIL with `column "business_id" does not exist` (**this is the reproduction — if any of them passes, stop and re-diagnose**); tests 12–16 FAIL with "Cannot find module '../job-failure-sink'"; tests 7–11 FAIL on the un-capped scheduler minting rows it should skip.

- [ ] **Step 6: Verify the live-DB conventions audit passes**

```bash
pnpm ci:live-db-suites
```
Expected: PASS. If it flags the new files, fix naming/DDL/lock enrolment — do not add an allowlist entry.

- [ ] **Step 7: Commit**

```bash
git add src/lib/shared/__tests__/live-db-tenant.ts worker/jobs/__tests__/onboarding-drip.integration.test.ts worker/background/schedulers/__tests__/onboarding-drip-scheduler.integration.test.ts worker/__tests__/job-failure-sink.test.ts
git commit -m "test(#719): failing eval — live-schema contract for drip queries, scheduler bounds, job-failure sink"
```

---

### Task 2: Fix the owner-auth join

**Blocking edges:** T1. **Turns green:** tests 1, 2, 3.

**Files:** Modify `worker/jobs/summary-report-helpers.ts:218-224`

- [ ] **Step 1: Rewrite the query to join through accounts**

Post-034 the path from location to owner runs `businesses.account_id → users.account_id`. Precedent: `src/lib/auth/require-owner-access.ts:63` and `src/lib/db/auth.ts:67`.

```typescript
export async function ownerHasDashboardAuth(sql: postgres.Sql, businessId: LocationId): Promise<Array<{ exists: number }>> {
  // users.business_id was dropped in migration 034; join through accounts
  // instead — same path as require-owner-access.ts:63. Reading the dropped
  // column threw 42703 on every WeeklySummary, MonthlyImpact and onboarding
  // drip run from 2026-05-10 until #719.
  return sql<{ exists: number }[]>`
    SELECT 1 AS exists
    FROM users u
    JOIN businesses b ON b.account_id = u.account_id
    WHERE b.id = ${businessId}
      AND u.role = 'owner'
      AND u.auth_id IS NOT NULL
    LIMIT 1
  `;
}
```

- [ ] **Step 2: Run tests 1–3**

```bash
pnpm vitest run worker/jobs/__tests__/onboarding-drip.integration.test.ts -t 'ownerHasDashboardAuth'
```
Expected: 3 passed.

- [ ] **Step 3: Confirm the sibling report workers still typecheck and pass**

```bash
pnpm typecheck && pnpm vitest run worker/jobs/__tests__/WeeklySummaryWorker.test.ts worker/jobs/__tests__/MonthlyImpactWorker.test.ts
```
Expected: PASS. The return type is unchanged, so no call site moves.

- [ ] **Step 4: Commit**

```bash
git add worker/jobs/summary-report-helpers.ts
git commit -m "fix(#719): ownerHasDashboardAuth joins through accounts — users.business_id died in 034"
```

---

### Task 3: Delete the drip worker's duplicate query and dead admin branch

**Blocking edges:** T2. **Turns green:** tests 4, 5, 6.

**Files:** Modify `worker/jobs/OnboardingDripWorker.ts` (lines ~144-149 and ~412-432)

- [ ] **Step 1: Replace the inline duplicate with the shared helper**

Delete lines 144-149 and use the pair the two report workers already use:

```typescript
import { ownerHasDashboardAuth, buildDashboardUrl } from './summary-report-helpers';
```

```typescript
  // ── 5. Check owner has auth (for dashboard URL) ───────────────────
  const dashboardUrl = buildDashboardUrl(
    await ownerHasDashboardAuth(sql, businessId),
    appUrl,
  );
```

This deletes the second copy of a query that was broken in both places. Do not re-spell it.

- [ ] **Step 2: Delete the dead business-scoped-admin branch**

`users.role = 'admin' AND business_id = …` cannot match post-034: the column is gone, and every `admin` user has `account_id IS NULL`, so there is no account-scoped rewrite that would match either. The `ResponsePublisherWorker` chain the comment cites no longer exists. Delete the branch rather than port it — the `onboarded_by` fallback is the only live path.

Replace lines ~412-432 with:

```typescript
  // Staff sign-off name — resolved only from the onboarding staff member on
  // businesses.onboarded_by. The former business-scoped-admin branch read
  // users.business_id (dropped in migration 034) and is deleted, not ported:
  // admins carry account_id IS NULL, so no rewrite of it could ever match.
  const [onboarder] = await sql<{ name: string }[]>`
    SELECT u.name FROM users u
    JOIN businesses b ON b.onboarded_by = u.id
    WHERE b.id = ${business.id} AND u.role = 'admin'
    LIMIT 1
  `;
  const supportContactName: string | null = onboarder?.name ?? null;
```

- [ ] **Step 3: Run the drip suites**

```bash
pnpm vitest run worker/jobs/__tests__/onboarding-drip.integration.test.ts worker/jobs/__tests__/OnboardingDripWorker.test.ts
```
Expected: all pass. The existing unit suite feeds `mockSql` from a positional queue, so removing two queries shifts the queue — **update the fixture ordering in `OnboardingDripWorker.test.ts` to match, and treat any test that still passes without an edit as suspect.**

- [ ] **Step 4: Commit**

```bash
git add worker/jobs/OnboardingDripWorker.ts worker/jobs/__tests__/OnboardingDripWorker.test.ts
git commit -m "fix(#719): drip worker uses the shared owner-auth helper; drop the dead admin sign-off branch"
```

---

### Task 4: Collapse the helper pair into `resolveDashboardUrl` (droppable)

**Blocking edges:** T3. **Turns green:** none — pure deepening, existing tests must stay green.

**Files:** Modify `worker/jobs/summary-report-helpers.ts`, `worker/jobs/WeeklySummaryWorker.ts:213-216`, `worker/jobs/MonthlyImpactWorker.ts:294-297`, `worker/jobs/OnboardingDripWorker.ts`

All three call sites compose the two helpers verbatim and nothing else calls either. `Array<{exists: number}>` is interface a caller should never have had to learn.

- [ ] **Step 1: Replace both exports with one**

```typescript
/**
 * Resolves the owner-facing dashboard URL for a location, or null when the
 * owner cannot use one (no owner row, no auth_id, or no configured app URL).
 *
 * Collapsed from ownerHasDashboardAuth + buildDashboardUrl at #719: all three
 * callers composed them verbatim, so the row shape was interface nobody needed.
 */
export async function resolveDashboardUrl(
  sql: postgres.Sql,
  businessId: LocationId,
  appUrl: string | undefined,
): Promise<string | null> {
  if (!appUrl) return null;
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

Note the early return on `!appUrl` skips the query entirely — strictly better than the old pair, which always queried and then discarded the result.

- [ ] **Step 2: Update all three call sites**

```typescript
const dashboardUrl = await resolveDashboardUrl(db, businessId, cfg.NEXT_PUBLIC_APP_URL);   // WeeklySummaryWorker
const dashboardUrl = await resolveDashboardUrl(sql, businessId, getWorkerConfig().NEXT_PUBLIC_APP_URL); // MonthlyImpactWorker
const dashboardUrl = await resolveDashboardUrl(sql, businessId, appUrl);                    // OnboardingDripWorker
```

Update the three import blocks. Update test 1–3 titles' subject in the integration suite to `resolveDashboardUrl` **only if** you also update the corresponding entries in `.feature/intake.json` and the committed intake copy — the gate's `promised-tests` row matches titles verbatim. Simpler and preferred: keep the test titles as written and have them call `resolveDashboardUrl`, asserting `toBe(null)` / `toBe('https://…/dashboard')` instead of row counts.

- [ ] **Step 3: Verify no orphans**

```bash
rg -n "ownerHasDashboardAuth|buildDashboardUrl" worker/ src/ --type ts
```
Expected: only `src/hooks/useDashboardData.ts` (an unrelated same-named local function). Any other hit is a missed call site.

- [ ] **Step 4: Run the three workers' suites + typecheck, then commit**

```bash
pnpm typecheck && pnpm vitest run worker/jobs/__tests__/
git add -A worker/jobs
git commit -m "refactor(#719): collapse ownerHasDashboardAuth + buildDashboardUrl into resolveDashboardUrl"
```

---

### Task 5: Scheduler churn cap + staleness cap

**Blocking edges:** T1. **Independent of T2/T3/T6** — disjoint files, safe to run in parallel.

**Files:** Modify `worker/background/schedulers/OnboardingDripScheduler.ts:35-91`

- [ ] **Step 1: Add the two constants**

```typescript
// Drip staleness cap (#719): a drip whose due date passed by more than this
// grace window is never sent. Without it, any outage that pauses drips clears
// into a burst of "Welcome to day 1!" emails to owners who joined long ago.
const STALENESS_GRACE_DAYS = 3;

// Churn cap (#719): stop re-minting an Outbox job for a (location, drip_type)
// that has already failed this many times in the last 24h. The in-flight
// NOT EXISTS below excludes 'failed', so before this a permanently-broken drip
// re-queued every cycle forever — 93 rows across 3 locations on staging.
// Rolling rather than lifetime so a transient provider outage self-heals the
// next day; the job-failure sink (T6) is what makes a persistent failure
// visible within the hour instead of silently trickling.
const MAX_FAILURES_PER_DAY = 3;
```

- [ ] **Step 2: Extend the due-drip query**

Return the two skip flags rather than filtering both in SQL, so a skip is observable rather than indistinguishable from "nothing due". The outer window is `GRACE + 1` days so a too-late pair is reported for exactly one day and then drops out permanently — the abandoned tail must not be re-read every cycle forever.

```typescript
    const dueDrips = await sql<{
      business_id: string;
      drip_type: string;
      too_late: boolean;
      churn_capped: boolean;
    }[]>`
      SELECT b.id AS business_id, d.drip_type,
             b.subscription_activated_at
               <= NOW() - ((d.days + ${STALENESS_GRACE_DAYS}) || ' days')::interval AS too_late,
             (
               SELECT count(*) FROM job_outbox jo
               WHERE jo.topic = ${QUEUE_NAMES.ONBOARDING_DRIP}
                 AND jo.aggregate_id = b.id
                 AND jo.payload->>'drip_type' = d.drip_type
                 AND jo.status = 'failed'
                 -- COALESCE because the two paths that write 'failed' disagree:
                 -- the watchdog stamps completed_at, the poller's dispatch-error
                 -- path does not. created_at is always present.
                 AND COALESCE(jo.completed_at, jo.created_at) > NOW() - INTERVAL '24 hours'
             ) >= ${MAX_FAILURES_PER_DAY} AS churn_capped
      FROM businesses b
      JOIN accounts a ON a.id = b.account_id
      CROSS JOIN (VALUES ('day_1', 1), ('day_7', 7), ('day_30', 30)) AS d(drip_type, days)
      WHERE a.subscription_status IN ('active', 'trialing')  -- enum: SubscriptionStatus.ACTIVE / .TRIALING
        AND b.subscription_activated_at IS NOT NULL
        AND b.subscription_activated_at <= NOW() - (d.days || ' days')::interval
        -- Abandoned tail: a pair past the grace window is reported for one day
        -- (so the skip is visible) and then never selected again.
        AND b.subscription_activated_at
              > NOW() - ((d.days + ${STALENESS_GRACE_DAYS} + 1) || ' days')::interval
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

    if (dueDrips.length === 0) return;

    const tooLate = dueDrips.filter((r) => r.too_late);
    const churnCapped = dueDrips.filter((r) => !r.too_late && r.churn_capped);
    const actionable = dueDrips.filter((r) => !r.too_late && !r.churn_capped);

    if (tooLate.length > 0) {
      logger.warn('Skipped drips past the staleness grace window', {
        count: tooLate.length,
        grace_days: STALENESS_GRACE_DAYS,
      });
    }
    if (churnCapped.length > 0) {
      logger.warn('Skipped drips at the daily failure cap', {
        count: churnCapped.length,
        max_failures_per_day: MAX_FAILURES_PER_DAY,
      });
    }
```

Then change the insert loop's `for (const row of dueDrips)` to `for (const row of actionable)`.

- [ ] **Step 3: Run tests 7–11**

```bash
pnpm vitest run worker/background/schedulers/__tests__/onboarding-drip-scheduler.integration.test.ts worker/background/schedulers/__tests__/OnboardingDripScheduler.test.ts
```
Expected: all pass. The existing unit suite may need its `mockSql` row shape widened to include the two new boolean columns.

- [ ] **Step 4: Commit**

```bash
git add worker/background/schedulers/
git commit -m "fix(#719): bound the drip scheduler — 3 failures/24h churn cap + 3-day staleness cap"
```

---

### Task 6: `recordOutboxLastError` + the job-failure sink

**Blocking edges:** T1. **Independent of T2/T3/T5.** **Turns green:** tests 12–16.

**Files:** Modify `src/lib/shared/outbox.ts`; Create `worker/job-failure-sink.ts`; Modify `worker/index.ts:478-489`

- [ ] **Step 1: Add the outbox sibling**

Append to `src/lib/shared/outbox.ts`, reusing the module's existing `dispatchedRow` / `hasAttempt` / `warnOutboxNoop` internals:

```typescript
/**
 * Records a handler's real error text on a still-`dispatched` outbox row
 * WITHOUT touching its status.
 *
 * Deliberately not a terminal write. The OutboxPoller watchdog owns the
 * job_outbox status machine, and terminalizing on BullMQ exhaustion would
 * delete the watchdog's outer retry loop for every worker. This only replaces
 * the text the watchdog would otherwise leave as the generic
 * 'Stale dispatched entry exceeded max_attempts' — the message that hid a hard
 * deterministic crash for three months (#719).
 *
 * The `status = 'dispatched'` guard is load-bearing: six queues own a domain
 * 'failed' hook that already terminalized the row with a better message, and
 * this must never overwrite it. A 0-row UPDATE is the expected outcome there.
 */
export async function recordOutboxLastError(
  exec: SqlExecutor,
  outboxId: string,
  message: string,
  attempt?: number,
): Promise<void> {
  // Bounded: a driver error can carry a large body, and last_error is read by
  // operators, not machines.
  const truncated = message.length > 500 ? `${message.slice(0, 500)}…` : message;
  const res = await exec`
    UPDATE job_outbox
    SET last_error = ${truncated}
    WHERE ${dispatchedRow(exec, outboxId, attempt)}
  `;
  if (hasAttempt(attempt) && res.count === 0) {
    warnOutboxNoop('recordOutboxLastError', outboxId, attempt);
  }
}
```

- [ ] **Step 2: Create the sink**

Create `worker/job-failure-sink.ts`. Precedent: `worker/emitter-errors.ts` — a small named worker-level module attached per-queue from `worker/index.ts`, whose listener may never throw.

```typescript
// Terminal BullMQ job failure → Sentry issue + the real error on the outbox row.
//
// Before #719 the only failure reporting was a Sentry *breadcrumb*, which is
// attached to some later unrelated event or to nothing at all. A handler that
// threw on every attempt therefore produced no Sentry issue, and the outbox
// row's last_error showed only the watchdog's generic reclaim text. The
// onboarding drip crashed deterministically for three months behind that gap.
//
// Extracted rather than inlined per invariant #12: this is an error-handling
// branch well past the ~30-line bar for a worker boot file.
import * as Sentry from '@sentry/node';
import type { Job, Worker } from 'bullmq';
import type postgres from 'postgres';
import { createWorkerLogger, toError } from '../src/lib/shared/logger';
import { recordOutboxLastError } from '../src/lib/shared/outbox';

const logger = createWorkerLogger('[JobFailureSink]');

/** True only once BullMQ has spent the job's whole retry budget. */
function isFinalAttempt(job: Job): boolean {
  const budget = job.opts?.attempts ?? 1;
  return job.attemptsMade >= budget;
}

export async function reportJobFailure(
  sql: postgres.Sql,
  queueName: string,
  job: Job | undefined,
  err: Error,
): Promise<void> {
  try {
    if (!job || !isFinalAttempt(job)) return;

    // Read outbox_id directly rather than via extractOutboxHandle: that helper
    // falls back to job.id, which is load-bearing for every worker but wrong
    // here — a BullMQ job id is not an outbox id, and an UPDATE keyed on one
    // would silently match nothing while looking like it worked.
    const data = (job.data ?? {}) as { outbox_id?: unknown; outbox_attempt?: unknown };
    const outboxId = typeof data.outbox_id === 'string' ? data.outbox_id : null;
    const attempt =
      typeof data.outbox_attempt === 'number' && Number.isFinite(data.outbox_attempt)
        ? data.outbox_attempt
        : undefined;

    Sentry.captureException(err, {
      tags: { subsystem: 'worker_job', queue: queueName },
      extra: {
        job_id: job.id,
        job_name: job.name,
        outbox_id: outboxId,
        attempts_made: job.attemptsMade,
      },
    });

    logger.error(`${queueName} job exhausted its retries: ${err.message}`, {
      job_id: job.id,
      outbox_id: outboxId,
    });

    if (outboxId) {
      await recordOutboxLastError(sql, outboxId, err.message, attempt);
    }
  } catch (sinkError) {
    // Last-resort sink: a failure to REPORT a failure must never escalate.
    logger.error('job failure sink failed', toError(sinkError));
  }
}

export function attachJobFailureSink(
  sql: postgres.Sql,
  worker: Pick<Worker, 'on'>,
  queueName: string,
): void {
  worker.on('failed', (job, err) => {
    // reportJobFailure never rejects (it owns a total try/catch), so this
    // floating promise cannot become an unhandledRejection.
    void reportJobFailure(sql, queueName, job, err);
  });
}
```

- [ ] **Step 3: Wire it into the existing loop**

In `worker/index.ts`, inside the `for (const [queueName, worker] of Object.entries(workersByQueue))` loop, **replace** the breadcrumb-only `worker.on('failed', …)` (lines 486-488) with:

```typescript
  attachJobFailureSink(sql, worker, queueName);
```

Add `import { attachJobFailureSink } from './job-failure-sink';`. Leave the `'active'` and `'completed'` breadcrumb listeners alone. The six per-queue domain `'failed'` hooks registered earlier stay exactly as they are — they now run alongside the sink, and the sink's `status = 'dispatched'` guard is what keeps their `last_error` authoritative.

- [ ] **Step 4: Run tests 12–16 and the worker boot suite**

```bash
pnpm vitest run worker/__tests__/job-failure-sink.test.ts worker/__tests__/
```
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/outbox.ts worker/job-failure-sink.ts worker/index.ts worker/__tests__/job-failure-sink.test.ts
git commit -m "feat(#719): job-failure sink — terminal BullMQ errors reach Sentry and job_outbox.last_error"
```

---

### Task 7: Domain sweep — CONTEXT.md + lab notes

**Blocking edges:** T2, T5, T6.

**Files:** Modify `CONTEXT.md`, `.claude/reference/lab-notes.md`

- [ ] **Step 1: Coin the two terms in CONTEXT.md**

Append after the **Watchdog** entry:

- **Drip staleness cap** — the `STALENESS_GRACE_DAYS` (3) bound in `OnboardingDripScheduler`: a drip whose due date passed by more than the grace window is never queued and never sent, permanently. It exists so an outage that pauses drips does not clear into a burst of late "Welcome to day 1!" emails. Deliberately enforced at the **producer only**, not also in the handler: the scheduler is the topic's sole producer, and a second handler-side check would be defensive branching around a state the producer excludes. The abandoned tail is reported for one day (the `GRACE + 1` outer window) and then drops out of the query forever. *(coined in #719)*
- **Job-failure sink** — `worker/job-failure-sink.ts`, attached to every BullMQ `Worker` alongside `attachEmitterErrorLogger`. On the **final** attempt only, it raises a Sentry issue (not a breadcrumb) and writes the handler's real error to `job_outbox.last_error` **without touching status** — the **Watchdog** keeps sole ownership of the status machine. Its `status = 'dispatched'` guard means a queue with its own domain `'failed'` hook keeps that hook's better message. *(coined in #719)*

Also sharpen the **Watchdog** entry with one clause: its `'Stale dispatched entry exceeded max_attempts'` reclaim message describes the *reclaim*, never the underlying handler failure — reading it as a diagnosis is what let #719 hide for three months.

- [ ] **Step 2: Add the lab note**

Format is `- [DATE] WHAT FAILED → WHY → CORRECT APPROACH`:

```markdown
- [2026-08-09] `onboarding_drip` never once completed on staging (93 failed rows, 0 completed) → `handleOnboardingDrip` read `users.business_id`, dropped by migration 034 on 2026-05-10, throwing `42703` after claiming the drip-log row and before sending; three sites shared the defect (`OnboardingDripWorker` ×2, `ownerHasDashboardAuth`, the latter latent in `WeeklySummaryWorker`/`MonthlyImpactWorker`) → post-034 the location→owner path is `businesses.account_id → users.account_id` (`require-owner-access.ts:63`). **A dropped column is invisible to unit tests here**: worker suites mock `sql` as a positional queue that returns canned rows for any SQL, so only a `*.integration.test.ts` against a provisioned DB can catch it.
- [2026-08-09] The failure was undiagnosable from the data → `worker/index.ts` added a Sentry *breadcrumb* on job failure and never `captureException`, so a deterministic crash raised no issue; the only durable text was the watchdog's generic `'Stale dispatched entry exceeded max_attempts'`, which describes the reclaim and not the fault → the **Job-failure sink** now captures on the final attempt and writes the real error to `last_error` without touching status.
- [2026-08-09] The pile was *growing*, not stale → `OnboardingDripScheduler`'s in-flight `NOT EXISTS` excludes only `status <> 'failed'`, so every failed row was re-minted the next cycle: each row burns 5 watchdog attempts over ~75 min, then a fresh one appears → any scheduler that re-queues on a predicate excluding `failed` needs a failure bound. Rolling (3/24h) over lifetime, so a transient outage self-heals.
- [2026-08-09] When counting recent `job_outbox` failures, `completed_at` alone under-counts → the watchdog's terminate path stamps `completed_at` but the OutboxPoller's dispatch-error path does not → use `COALESCE(jo.completed_at, jo.created_at)`.
```

- [ ] **Step 3: Commit**

```bash
git add CONTEXT.md .claude/reference/lab-notes.md
git commit -m "docs(#719): coin Drip staleness cap + Job-failure sink; lab notes for the 034 dropped-column class"
```

---

## Verification gate

After the last task:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-719-drip-dropped-column
export TEST_DATABASE_POOL_URL=...   # required — DB-touching queries, live-DB suites must RUN
bash scripts/verify-gate.sh --review
```

All rows green, including `promised-tests` (16 verbatim titles), `diff-coverage` (≥80% on changed lines), and `reclassify` (prod ≤ 240, test ≤ 1000).

## Staging ride (RISK = high)

1. Push the branch to `staging`; both the Railway worker and the Vercel staging env auto-deploy.
2. Watch for a **new** `job_outbox` row with `topic='onboarding_drip'` reaching `status='completed'` — the topic has never done this. The 93 existing failed rows all have `COALESCE(completed_at, created_at)` older than 24h by then, so the churn cap will not block the fresh mint.
3. Confirm the three terminal facts: `onboarding_drip_log.sent_at IS NOT NULL`, a `notification_deliveries` row with `template='onboarding_drip_day_1'`, and the actual email in the `norbertliverpool+e1/+e3/+e7@gmail.com` inboxes.
4. **Timing note:** the three staging locations activated 2026-08-05/06, so with a 3-day grace their day_1 window closes 2026-08-09 15:47 UTC / 2026-08-10 01:42 UTC. If the ride slips past that, day_1 is correctly skipped as too-late and the ride must instead verify **day_7** (due 2026-08-12/13). Do not shorten the grace window to force a day_1 send.
5. Do **not** purge the 93 failed rows — they are the before/after evidence.
6. Open the PR to `main`, confirm CI green, then PAUSE for merge approval.

## Follow-up filed separately

A `ci:*` audit that extracts column references from tagged-template SQL and diffs them against the migration-head schema. Weighed during #719 grilling and declined as its own epic-sized ticket; the live-DB suites here cover this feature's queries only, so the class remains open elsewhere.
