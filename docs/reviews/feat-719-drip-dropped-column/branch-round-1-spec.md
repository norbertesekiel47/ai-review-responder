# Branch review round 1 — Spec & correctness axis (#719)

**Scope:** `git diff bea12e68..HEAD` on `feat-719-drip-dropped-column`.
**Question owned:** does the diff faithfully implement `.feature/intake.json`?
Style, naming, abstraction quality and design-approach challenge are owned by the two sibling reviewers and are deliberately absent here.

---

## Verdict

**The diff is a faithful implementation of the locked contract.** All three defects (A dropped column, B unbounded churn, C invisible failure) are fixed as specified; every `non_goal` holds; all 25 `tests_to_add` titles are present **verbatim** and all but one assert something discriminating; the boundary arithmetic is correct as written in SQL (not merely as described in the comments); every changed file is inside `allowed_edit_surface`; the rollback plan is accurate.

Three findings, none blocking correctness of the shipped behaviour: one test-harness defect that inverts the eval's own execution sentinel (Medium), and two contract-fidelity gaps left over from the D3 design reversal (Low, Low).

### Evidence run in this review

| Command | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm ci:tenant-scope` | passed — entries 412 (baseline 412) |
| `pnpm ci:static-policy` | passed (1129 files) |
| `pnpm ci:live-db-suites` | passed |
| `pnpm ci:db-imports` | passed (strict) |
| `pnpm ci:outbox-status` | passed |
| `pnpm ci:outbox-seam` | passed |
| `pnpm ci:feature-surface` | passed — 24 changed files, all within the declared surface |
| `pnpm ci:config-coverage`, `ci:process-env` | passed |
| unit: job-failure-sink, OnboardingDripWorker, summary-report-helpers, Weekly, Monthly, OnboardingDripScheduler | 77/77 pass |
| live-DB: `worker/jobs/__tests__/onboarding-drip.integration.test.ts` | 11/11 **only with `TEST_DATABASE_POOL_URL` exported**; 10/11 otherwise — see F1 |
| live-DB: `worker/background/schedulers/__tests__/onboarding-drip-scheduler.integration.test.ts` | 9/9 pass |
| blast-radius importers: `notification/__tests__/bounced-skip.test.ts`, `src/lib/agents/__tests__/run-spine.integration.test.ts` | 13/13 pass |
| `src/__tests__/ci-audit-wiring.test.ts`, `eslint-boundaries.test.ts` | 78/78 pass |

---

## Findings

| Severity | file:line | Finding |
|---|---|---|
| Medium | `worker/jobs/__tests__/onboarding-drip.integration.test.ts:101` | The eval's execution sentinel asserts `process.env.TEST_DATABASE_POOL_URL` instead of `resolveTestDatabaseUrl()`, so it fails red in the exact local setup where the 10 live tests *did* run against migration-head Postgres (URL supplied by the documented `.env.local` fallback) — the sentinel's signal is inverted. Contract field: `tests_to_add[0]`. |
| Low | `worker/job-failure-sink.ts:37` | Sentry tags are `{subsystem, queue}`; `observability[5]` (`.feature/intake.json:112`) promises `{queue, topic}`. Topic reaches Sentry only as `extra.job_name`, which is not a filterable tag, and for the three legacy topic aliases routed to one queue the `queue` tag alone cannot identify the topic. No deviation entry covers the narrowing. |
| Low | `.feature/intake.json:43-45` | D3 cut the sink's `job_outbox.last_error` write and D6 swept `goal` + `observability`, but three `edge_cases` entries still specify behaviour of that cut write. They are now vacuously satisfied and untested, so the contract still asserts a fact the design reversed — the precise failure class D6 itself named. Contract field: `edge_cases[8..10]`. |

### F1 — the execution sentinel is inverted (Medium)

`worker/jobs/__tests__/onboarding-drip.integration.test.ts:99-108` deliberately sits **outside** `describeWithDb` so that a silent skip fails loudly. That intent is right and valuable. But line 101 reads the raw env var:

```ts
expect(process.env.TEST_DATABASE_POOL_URL ?? '').not.toBe('');
```

The repo's resolver is `resolveTestDatabaseUrl()` (`src/lib/shared/__tests__/helpers/live-db-lock.ts:57-71`), which falls back to reading `TEST_DATABASE_POOL_URL` **off `.env.local` on disk** when the env var is unset. That fallback is a documented CLAUDE.md gotcha and is what `describeWithDb` (line 219/326 of the two live suites) gates on. The two therefore disagree.

Reproduced in this worktree:

* `pnpm vitest run worker/jobs/__tests__/onboarding-drip.integration.test.ts` → **10 passed, 1 failed** — the ten live tests executed against the local `repworth-testdb` container, and the sentinel that exists to prove they executed reported the opposite.
* Same command with `TEST_DATABASE_POOL_URL` exported → **11 passed**.

CI is unaffected (`.github/workflows/ci.yml` sets `TEST_DATABASE_POOL_URL` on the `test` job), and a *genuine* skip is still caught, so the direction of failure is safe. The cost is that the one test in the eval whose entire job is signal integrity produces a false red on a developer machine — the same "is this a real failure or harness noise?" ambiguity the ticket exists to remove. Fix is one line: gate on `resolveTestDatabaseUrl()` and probe with its return value.

### F2 — the `topic` Sentry tag was never built (Low)

`observability[5]` is explicit: *"Sentry issue (not a breadcrumb) with tags `{queue, topic}`"*. As built:

```ts
tags: { subsystem: 'worker_job', queue: queueName },
extra: { job_id, job_name, outbox_id, attempts_made },
```

`OutboxPoller.ts:253` dispatches with `queue.add(entry.topic, …)`, so `job.name` **is** the topic — it is captured, but as an `extra`, not a tag, so it cannot be used to filter or group issues in Sentry. For 40 of the 43 topics `queue === topic` and the gap is cosmetic; for the three legacy aliases in `worker/queues.ts` (`notify_owner_reconnect`, `notify_owner_connection_lost`, and `QUEUE_NAMES.SEND_OWNER_EMAIL` all routed to `queues.sendOwnerEmail`) the `queue` tag genuinely does not identify which topic failed.

Two secondary notes: the plan already specced the narrower set (`docs/superpowers/plans/2026-08-08-719-drip-dropped-column.md:261`), so the drift entered at plan time and no deviations entry records it; and the unit assertion (`worker/__tests__/job-failure-sink.test.ts:78`) uses `toMatchObject` against exactly the two tags that exist, so it cannot catch the omission. Either add `topic: job.name` to `tags` (one line, and the extra becomes redundant), or record the narrowing as a deviation.

### F3 — three `edge_cases` entries still describe the write D3 cut (Low)

D3 removed the sink's `job_outbox.last_error` write entirely; D6 then corrected `goal` and the `observability` bullet and recorded the lesson: *"a design reversal has to sweep **every** field of the contract that asserts the reversed fact."* Three `edge_cases` entries were not swept (`.feature/intake.json:43-45`, byte-identical in the plans copy):

* *"the generic sink must not stomp the domain hook's `last_error`"*
* *"the sink must no-op rather than write against a BullMQ job id"*
* *"The sink's own write failing — must be log-and-swallow"*

All three are phrased entirely in terms of a write that no longer exists, so they are vacuously true and have no test. The *behaviour* is correct (a sink that writes nothing cannot stomp anything), and the third's substance — log-and-swallow — does survive in the `try/catch` at `worker/job-failure-sink.ts:50-53`. But the contract as locked still describes a design that was reversed, which is exactly what D6 said must not happen again. Cost is a paragraph in the deviations file, not code.

---

## Per-intake-field evidence

### 1. `goal` (corrected text, D6)

| Clause | Evidence | Verdict |
|---|---|---|
| Repair the three live queries reading `users.business_id` | `summary-report-helpers.ts:231-249` (`resolveDashboardUrl`, `businesses.account_id → users.account_id`); `OnboardingDripWorker.ts:145` (inline copy collapsed into it); `OnboardingDripWorker.ts:408-414` (day_30 sign-off now joins `businesses.onboarded_by`). Three sites, three fixes. | PASS |
| Bound the unbounded re-queue | `OnboardingDripScheduler.ts:86-98` churn subquery + `:131` filter. `MAX_FAILURES_PER_DAY = 3` / `CHURN_WINDOW_HOURS = 24`. | PASS |
| Cap drips overdue past a grace window | `OnboardingDripScheduler.ts:83-84` (`too_late`), `:112-113` (outer window), `:128-132` filters. | PASS |
| Terminal error → real Sentry issue | `job-failure-sink.ts:36-44`; `worker/index.ts:492` replaces the breadcrumb listener. | PASS |
| **Sentry ONLY — the sink writes no `job_outbox`** | `job-failure-sink.ts` contains no SQL, no `sql`/`tx` import, no `outbox.ts` write helper import (only `isTerminalAttempt`). `src/lib/shared/outbox.ts` untouched in the diff. | PASS |

### 2. `non_goals` (8/8 hold)

| # | Non-goal | Evidence |
|---|---|---|
| 1 | No migration / schema change | `git diff --name-status` lists no `supabase/migrations/` file. |
| 2 | No SQL-vs-schema CI audit | No new script in `scripts/ci/`; only `tenant-scope-allowlist.ts` (a data constant) changed. |
| 3 | 93 staging rows untouched | Nothing in the diff DELETEs or UPDATEs `job_outbox` rows outside test fixtures. The scheduler only `INSERT … ON CONFLICT DO NOTHING`. The integration suite's `afterAll` DELETE is scoped to the local test DB, `status='pending'`, and `created_at >= suiteStartedAt`. |
| 4 | Watchdog / 15-min window / `max_attempts` unchanged | `worker/background/pollers/OutboxPoller.ts` not in the diff. |
| 5 | No BullMQ attempts/backoff change | `worker/index.ts` diff is 3 hunks: one import, one comment block, one listener swap. `worker/queues.ts` untouched. |
| 6 | Weekly/Monthly changed only to consume the helper | Both diffs are import-list + a single call-site line. |
| 7 | No re-firing outside the grace window | The `too_late` rows are filtered out of `actionable` and never enqueued (`:132`, `:135`). |
| 8 | No new env var / feature flag | `ci:process-env` passed at baseline 9; `ci:config-coverage` passed at baseline 7; no `NEXT_PUBLIC_*` added (`ci:static-policy` green). |

### 3. `user_visible_behavior` (6/6 traceable)

| # | Behaviour | Traced to |
|---|---|---|
| 1 | day_1 inside grace now sends | `onboarding-drip.integration.test.ts:454-473` — real schema, real claim, real outbox `completed`, `notification_deliveries` row with template `onboarding_drip_day_1`. Ran green. |
| 2 | day_7/day_30 send instead of throwing | ibid. `:475-497`, `:499-538`. |
| 3 | Weekly/Monthly stop throwing 42703 | Both now call the same `resolveDashboardUrl`, which is live-tested at `:378-430`. The shared helper is the whole of the fix for all three consumers. |
| 4 | day_30 sign-off resolves only from `businesses.onboarded_by`; no sign-off when absent | `OnboardingDripWorker.ts:408-415`; tests `:499` and `:522` assert `supportContactName` = name and `null` respectively against the real `buildOnboardingDay30Html`. |
| 5 | Past-grace drip is never sent | `OnboardingDripScheduler.ts:83-84` + `:132`; test `:291`. |
| 6 | No owner-facing surface/route/template change | `src/app/**`, `src/components/**`, `src/lib/notifications/email*` absent from the diff. |

### 4. `invariants` (8/8 hold)

| Invariant | Evidence |
|---|---|
| #1 Railway-only, no Next.js runtime import change | Every production file changed is under `worker/`. `eslint-boundaries.test.ts` green. |
| #11 `subscriptionGrantsFullAccess`, never a raw literal | `OnboardingDripWorker.ts:63` unchanged. The scheduler additionally **improves** here: raw `'active','trialing'` literals became bound `SubscriptionStatus.ACTIVE/.TRIALING` (`OnboardingDripScheduler.ts:107`), retiring a `ci:static-policy` file:line exemption. |
| #15 explicit `sql`; only composition roots import the singleton | `resolveDashboardUrl(sql, …)` takes it explicitly; `runOnboardingDripCycle(db, asOf)` takes it explicitly; the scheduler is registered in `worker/index.ts` so its module-level `sql` import is root-sanctioned. `ci:db-imports` passed **strict**. |
| #12 sink is a named module | `worker/job-failure-sink.ts` (58 lines); `worker/index.ts` holds a one-line call inside the existing registration loop. |
| #2 in-flight status vocabulary untouched; sink writes no status | `ci:outbox-status` passed. The sink issues no SQL. The scheduler's `NOT EXISTS` still uses `status <> 'failed'` (unchanged from `bea12e68`); the new churn subquery reads `status = 'failed'`, which is outside the in-flight set. |
| Watchdog remains sole owner of the status machine | Vacuously stronger than specified — with no sink write there is no `status='dispatched'` guard to get wrong, and no domain hook's `last_error` can be overwritten. |
| Tenant scope | `ci:tenant-scope` passed at 412/412. D11's `db`-not-`exec` parameter naming is verified load-bearing: the audit still *sees* the global scan (its three allowlist entries are live, not dead). The refreshed `ONBOARDING_DRIP_CANDIDATES_SQL` matches the new query text — a mismatch would have surfaced as dead entries and a count drift. |
| Drip idempotency — three-way claim precedes every side effect | `OnboardingDripWorker.ts:98-138` (INSERT → own-retry takeover → stale takeover) is byte-unchanged, and sits at step 4, **before** `resolveDashboardUrl` at step 5 (`:145`) and before the send. |

### 5. `edge_cases` (11 — 8 handled + covered, 3 vacuous)

| # | Edge case | Handled | Covered |
|---|---|---|---|
| 1 | owner `auth_id IS NULL` → null URL, drip still sends | `summary-report-helpers.ts:245` | test `:386` |
| 2 | no owner row at all | same query returns `[]` → `null` | **not directly** — see appendix A1 |
| 3 | multi-location, no cross-account leak | join on `b.account_id = u.account_id` (`:242`) | tests `:402` (non-primary location resolves) and `:423` (other account does not) |
| 4 | 3 failures exactly 24h old | strict `>` at `:96-97` → boundary row excluded | test `:323`, asserts the drip IS queued |
| 5 | 2 failures in last 24h → still re-queued | `>= 3` at `:98` | test `:374` seeds exactly 2 recent for the pair and asserts 1 pending |
| 6 | exactly at the staleness grace boundary | `<` at `:84` → boundary is NOT too-late | tests `:279` (sends at boundary), `:291` (skips one minute past), `:303` (drops out at grace+1) |
| 7 | `subscription_activated_at` NULL for day_7/day_30 → `markOutboxFailed` unchanged | `OnboardingDripWorker.ts:91-95` byte-unchanged | pre-existing unit coverage; contract only requires "stay unchanged" |
| 8 | fails then succeeds on retry → sink writes nothing | `isTerminalAttempt` guard at `job-failure-sink.ts:34` | test `:84` |
| 9 | domain `'failed'` hook not stomped | vacuous (no write) | none — F3 |
| 10 | job with no `outbox_id` | vacuous (no write); `outbox_id` is read defensively as `(job.data as {outbox_id?: unknown})?.outbox_id` | none — F3 |
| 11 | sink's own write failing → log-and-swallow | `try/catch` at `:33/:50` wraps the whole body including `captureException` | partially, via test `:126` (undefined job does not throw) — F3 |

### 6. `tests_to_add` — 25/25 present verbatim

Verified title-by-title against the three suites. All 25 strings match the intake exactly.

* Titles 1–11 → `worker/jobs/__tests__/onboarding-drip.integration.test.ts` (lines 100, 378, 386, 392, 402, 423, 432, 454, 475, 499, 522)
* Titles 12–20 → `worker/background/schedulers/__tests__/onboarding-drip-scheduler.integration.test.ts` (lines 279, 291, 303, 323, 342, 352, 374, 396, 415)
* Titles 21–25 → `worker/__tests__/job-failure-sink.test.ts` (lines 69, 84, 95, 126, 135)

Discriminating power spot-checks (a title that exists but asserts nothing is a finding):

* Title 7 (`returns null without querying`) — genuinely counts invocations through a `Proxy` `apply` trap (`:436-449`) and asserts `queries === 0`. This is the only assertion that can catch a regression to the old always-query pair. Real.
* Title 14 (grace-plus-one outer boundary) — asserts both "no row" and "`tooLate` delta is **0**", i.e. it pins that the pair left the query entirely rather than merely being skipped. That distinction is the whole point of the outer bound. Real.
* Title 17 (recent dispatch failure, old row) — seeds `completed_at = NULL, dispatched_at = now-1h, created_at = now-30h`, which fails against both `completed_at` alone and `COALESCE(completed_at, created_at)`. Real, and it is the only test that pins the three-way COALESCE.
* Title 19 (bounds apply to day_7/day_30) — the only test that would catch bounds wired to day_1 only. Real.
* Titles 12/13/15 pin the boundary *direction* (send at, skip past; 24h-old failure is outside) rather than merely "some skip happened". Real.
* Title 25 (boot attaches the sink) — a source-text assertion (`readFileSync` + index arithmetic on the registration loop), not behavioural. Weak in kind, but it does discriminate: it asserts exactly one `attachJobFailureSink(worker, queueName)` **inside** the loop and no residual `worker.on('failed'`. Accepted; see appendix A2.
* Title 13 says "skips **and warns**" but asserts only the `tooLate` counter delta, not `loggerStub.warn`. The counter is the stronger of the two and the warn is asserted nowhere; see appendix A3.

### 7. `allowed_edit_surface` — no escapes

24 changed files, all matched: `pnpm ci:feature-surface` passed. Manual cross-check confirms `scripts/ci/tenant-scope-allowlist.ts` (amendment #2, D12) and the `worker/jobs/__tests__/**` glob (D8) are the only entries doing non-obvious work, and `src/lib/shared/__tests__/live-db-tenant.ts` (new `seedLocation`/`cleanupLocation`) falls under the pre-existing `src/lib/shared/__tests__/**` glob. Both intake copies (`.feature/intake.json` and `docs/superpowers/plans/feat-719-drip-dropped-column-intake.json`) are byte-identical.

### 8. `observability` (6/7 will appear as claimed)

| # | Signal | Verdict |
|---|---|---|
| 1 | `onboarding_drip` row reaches `status='completed'` | Proven end-to-end against real Postgres — `readOutboxStatus(outboxId) === 'completed'` in tests 8, 9, 10, 11. |
| 2 | `notification_deliveries` row with `template='onboarding_drip_day_1'` | Asserted in tests 8/9/10 via `readDeliveryTemplates`. |
| 3 | `onboarding_drip_log.sent_at` non-NULL | Asserted in tests 8/9/11. |
| 4 | `[OnboardingDripWorker] day_1 sent for business <id>` | `OnboardingDripWorker.ts:194` emits `` `${drip_type} sent for business ${businessId}` `` under the `[OnboardingDripWorker]` prefix. |
| 5 | Scheduler log naming churn-skip and staleness-skip counts | `OnboardingDripScheduler.ts:164-175` — two distinct `logger.warn` calls carrying `count` plus the bound that fired. |
| 6 | Sentry issue with tags `{queue, topic}` | **Partial — F2.** Issue: yes. `queue` tag: yes. `topic` tag: no. |
| 7 | `last_error` deliberately still reads the reclaim text; CONTEXT.md + lab notes say so | Both say so: `CONTEXT.md` **Watchdog** entry rewritten, plus new **Drip staleness cap** and **Job-failure sink** entries; `.claude/reference/lab-notes.md` gains the four-bullet 034 dropped-column section. |

### 9. `rollback_plan`

Accurate. No migration, no schema change, no env var, no flag, no data mutation — a `git revert` restores pre-fix behaviour exactly. The independent-revert claim also holds: dropping the `attachJobFailureSink(worker, queueName)` call leaves those workers with **no** `'failed'` listener, which is safe (unlike `'error'`, a missing `'failed'` listener on a BullMQ `Worker` is not promoted to `uncaughtException`).

---

## Boundary arithmetic — read from the SQL, not the comments

With `G = STALENESS_GRACE_DAYS = 3` and `n = d.days`:

| Predicate | SQL (`OnboardingDripScheduler.ts`) | Meaning |
|---|---|---|
| due | `:109` `activated <= asOf - n days` | drip is due |
| outer report window | `:112-113` `activated > asOf - (n + G + 1) days` | pair drops out of the query at exactly `activated + (n+G+1)` |
| `too_late` | `:83-84` `activated < asOf - (n + G) days` | strict `<`, so `asOf = activated + (n+G)` is **not** too-late |

Therefore for day_1 (`n=1`): the last instant a drip is sent is `activated + 4 days` **inclusive**, and the pair stops being reported at `activated + 5 days` **exclusive-of-the-boundary** (at exactly +5d, `activated > activated` is false → excluded). That is precisely "send AT the boundary and skip past it", and precisely the `+4d` cap / `+5d` reporting window the intake states. Tests 12/13/14 pin all three edges.

Churn window: `:96-97` `COALESCE(...) > asOf - make_interval(hours => 24)`. Strict `>`, so a failure stamped exactly 24h before `asOf` is **outside** the window — confirmed by test 15, which seeds three such rows and asserts the drip still queues. Cap is `>= 3` (`:98`), so exactly 3 inside the window skips (test 19, day_7 arm) and 2 inside re-queues (test 18).

**`COALESCE(completed_at, dispatched_at, created_at)` is the right clock.** Verified against all three writers of `status='failed'` on this topic:

* watchdog terminate arm — `OutboxPoller.ts:135-146` sets `completed_at = NOW()` → first COALESCE arm is correct and recent.
* poller dispatch-error terminal arm — `OutboxPoller.ts:293-299` sets `status='failed', last_error` and **not** `completed_at`; the row's `dispatched_at` was refreshed to `NOW()` by the claim UPDATE, so the second arm is correct and recent. Keying on `completed_at` alone (or `COALESCE(completed_at, created_at)`) would read these rows as old and re-mint forever — which is the 93-row failure mode. Test 17 pins exactly this.
* `markOutboxFailed` (`src/lib/shared/outbox.ts:166-170`) sets `completed_at = NOW()` → first arm.

`created_at` as the floor covers any row that never dispatched. Correct as specified.

**`too_late` / `churn_capped` precedence:** `:128-132` — `tooLate` is filtered first, and `churnCapped` explicitly excludes `!r.too_late`. Staleness wins, as the intake requires. The counters are therefore disjoint and sum-safe.

**The deleted day_30 admin branch — no regression.** The old first branch was `SELECT name FROM users WHERE role = 'admin' AND business_id = <location>`; `users.business_id` has not existed since migration 034, so post-034 that statement threw `42703` — and in any case the handler already threw at step 5 before ever reaching `buildDay30`, so the entire day_30 sign-off path was dead code. The surviving query is byte-identical to the old *fallback* branch (same `businesses.onboarded_by` join, same `u.role = 'admin'` filter). For a location that HAS an `onboarded_by` admin, the new code produces exactly what the old fallback produced. Test 10 pins the name; test 11 pins `null`. Contract `user_visible_behavior[4]` mandates the deletion regardless.

---

## Blast-radius call-site analysis

`blast-radius.md` lists importers; typecheck catches signature breaks but not semantic ones. The two semantic changes were traced per caller.

### Change 1 — `ownerHasDashboardAuth` + `buildDashboardUrl` → `resolveDashboardUrl` (now short-circuits to `null` on falsy `appUrl` **without querying**)

| Caller | Old shape | New shape | Semantic risk | Verdict |
|---|---|---|---|---|
| `WeeklySummaryWorker.ts:212` | `buildDashboardUrl(await ownerHasDashboardAuth(db, id), cfg.NEXT_PUBLIC_APP_URL)` | `await resolveDashboardUrl(db, id, cfg.NEXT_PUBLIC_APP_URL)` | Same return value in every case. The only observable difference is **one fewer SQL statement when `appUrl` is falsy** — which matters because this suite mocks `sql` as a **positional queue**, so a dropped statement shifts every later fixture. Checked: `WeeklySummaryWorker.test.ts:294` sets `NEXT_PUBLIC_APP_URL`, so the query still runs and the queue does not shift. Suite ran green. | SAFE |
| `MonthlyImpactWorker.ts:293` | same pair | same call | Identical analysis; `MonthlyImpactWorker.test.ts:139` sets the var. Suite ran green. | SAFE |
| `OnboardingDripWorker.ts:145` | **inline duplicate** of the broken query + inline ternary | delegates to the helper | Query count unchanged (1 → 1). `OnboardingDripWorker.test.ts:101` sets the var. The unit suite's positional queue was re-derived for the day_30 cases (9 → 8 pushes) because the *sign-off* branch lost a statement — done correctly in the diff and confirmed green. | SAFE |
| `worker/jobs/__tests__/summary-report-helpers.test.ts` | asserted `buildDashboardUrl` directly | case deleted, superseded by live titles 2/3/7 | The deleted unit case fed a hand-built `Array<{exists:number}>` and so was structurally incapable of catching the dropped column. Replacement coverage is strictly stronger. | SAFE |
| `worker/jobs/__tests__/summary-report-fixtures.ts`, `bounced-skip.test.ts`, `run-spine.integration.test.ts` | import the modules, not the deleted exports | — | Ran green (13/13). | SAFE |

**Behavioural note, not a finding:** post-034 the dashboard-URL gate is now **account**-scoped (`b.account_id = u.account_id`) where the pre-034 query was **location**-scoped (`users.business_id`). In a multi-location account whose location `owner_email` is a manager with no `users` row, the drip email will now carry a dashboard link the recipient personally cannot use. This is the join the contract explicitly mandates (`edge_cases[2]`, `existing_patterns_to_follow[0..1]`), and matches `require-owner-access.ts` / `db/auth.ts`. Recorded so it is a decision, not an accident.

### Change 2 — `OnboardingDripScheduler.checkAndSchedule` → thin wrapper over `runOnboardingDripCycle(db, asOf)` which **throws**

| Caller | Effect |
|---|---|
| `worker/index.ts` | Imports only `startOnboardingDripScheduler` / `stopOnboardingDripScheduler`. `checkAndSchedule` (`:183-193`) **still** wraps the cycle in `try/catch` + `logger.error`, and `createGuardedPoll` is configured identically. The throw is therefore confined to the new exported seam; the boot path's failure behaviour is byte-for-byte what it was. No production caller observes the throw. |
| `onboarding-drip-scheduler.integration.test.ts` | The intended consumer of the throwing seam — title 20 relies on it (a swallowed `42703` used to be indistinguishable from a correct skip). |
| `OnboardingDripScheduler.test.ts` (unit) | Still drives `checkAndSchedule`; updated for the bound status parameters rather than the old literal regex. Green. |

`worker/index.ts`'s 90 importers all consume its `QUEUE_NAMES` / `queues` / `topicToQueue` re-exports, none of which changed; the diff there is confined to the registration loop. `ci:config-coverage` (which parses `worker/index.ts`) and `ci-audit-wiring.test.ts` both green.

---

## Low-confidence appendix

Not findings. Recorded so the next reviewer does not re-derive them.

**A1 — `edge_cases[1]` ("no owner user row at all") has no dedicated test.** The behaviour is right (`resolveDashboardUrl` returns `[]` → `null`), and title 6 is the nearest fixture, but title 6's account-A owner exists with `auth_id = NULL` rather than being absent. Same code path, so the coverage gap is theoretical.

**A2 — title 25 is a source-text assertion.** `readFileSync` + `indexOf('\n}')` to bound the registration loop is brittle to reformatting: it depends on the loop's closing brace being the first `}` at column 0 after the loop start. It works today (nested handlers close with indented `});`). A behavioural alternative (construct a fake `Pick<Worker,'on'>` and assert the listener) exists but would not prove the *boot file* wires it, which is the thing that actually matters. Judged an acceptable trade, not a finding.

**A3 — title 13 says "skips **and warns**" but asserts only the counter.** `loggerStub.warn` is never asserted anywhere in the scheduler suite, so `observability[4]`'s log line is unpinned. The counters (`tooLate` / `churnCapped`) are the stronger signal and they are asserted, so a regression would still be caught — just not through the log.

**A4 — the "reported for exactly one day" comment (`OnboardingDripScheduler.ts:110-111`) reads as one *report*.** The outer window is one day wide and the scheduler ticks hourly, so a stale pair emits ~24 warnings before dropping out. Bounded and intentional; the wording could mislead an on-call reader.

**A5 — the `resolveDashboardUrl` docstring claim "admins carry `account_id IS NULL`" (`summary-report-helpers.ts` / `OnboardingDripWorker.ts:409-411`) is not universally true.** The eval's own `seedAuthenticatedNonOwner` (`onboarding-drip.integration.test.ts:203-214`) inserts an `admin` **with** an `account_id`, which is what makes title 4 a real discriminator. The *conclusion* (delete the branch rather than port it) is mandated by `user_visible_behavior[4]` independent of the justification, so nothing behavioural turns on it — but the stated reason is weaker than the comment implies.

**A6 — day-interval arithmetic is calendar-day, not 24h.** `asOf::timestamptz - ('4 days')::interval` respects the session timezone across a DST transition, so the grace window can be 95 or 97 hours wide. Both the due bound and the too-late bound use the same construction (as did the pre-#719 query), so they stay consistent with each other; only the absolute width moves. Pre-existing pattern, not introduced here.

**A7 — `isTerminalAttempt`'s `attemptsMade >= max || attemptsMade + 1 >= max`** fires one attempt early if BullMQ has already incremented `attemptsMade` before emitting `'failed'`. Pre-existing shared helper (`src/lib/shared/outbox.ts:211-216`), deliberately reused per D4 rather than reinvented, and used identically by the domain hooks. Out of this diff's scope; noted because F2's sibling assertion (title 22) is satisfied by the same predicate.

**A8 — `.feature/state.json` `headSha` (`eaada51c`) lags the current branch head (`0ced136b`).** The file is untracked and outside the reviewed diff; flagged only in case step 8 reads it.
