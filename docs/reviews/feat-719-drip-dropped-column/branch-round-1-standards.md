# #719 — Branch review round 1: Standards & maintainability

**Reviewer axis:** repo standards, deep-module discipline, code smells, glossary discipline
**Skill run:** `thermo-nuclear-code-quality-review` (primary path — invoked successfully, no fallback needed)
**Range:** `git diff bea12e68..HEAD`
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-719-drip-dropped-column`
**Mode:** read-only; no repo file edited except this report.

---

## Findings table (≥80% confidence only)

| Severity | file:line | Finding |
|---|---|---|
| HIGH | `worker/background/schedulers/OnboardingDripScheduler.ts:51-54` | The JSDoc claims the cycle now throws and "the poll wrapper below is the only place that swallows" — but `checkAndSchedule` (`:190-192`) still catches and logs exactly as before, and `createGuardedPoll` (`worker/background/guarded-poll.ts:108-113`) never captures to Sentry. The "crashed query is indistinguishable from nothing due, no alert" observable is byte-for-byte unchanged by this PR, in the very file the ticket is about. |
| HIGH | `worker/job-failure-sink.ts:28-30` | `boundedErrorClass` does not bound, and diverges from the helper its own JSDoc says it mirrors (`worker/jobs/csv-ingest/failed-hook.ts:93-97` slices to 100 chars and falls back to `'UnknownError'`). Two same-named helpers with different behaviour where one canonical helper belongs in `src/lib/shared/logger.ts`. |
| MEDIUM | `worker/jobs/OnboardingDripWorker.ts:24` | `resolveDashboardUrl` stays inside the feature-named `worker/jobs/summary-report-helpers.ts` while gaining a third, non-summary consumer. The module name no longer describes its contents; a summary-report refactor gets no signal that the onboarding drip depends on it. |
| MEDIUM | `src/lib/shared/__tests__/live-db-tenant.ts:1` | New shared live-DB fixture sits directly in `__tests__/` while every sibling shared helper (`live-db-lock.ts`, `schema-ready.ts`, `abort-injection.ts`) lives in `__tests__/helpers/`. Both new suites import from the two paths in a single block. |
| MEDIUM | `CONTEXT.md:12` | The **Drip staleness cap** entry claims the abandoned tail "is reported for exactly one day (the `GRACE + 1` outer window) and then drops out of the query forever". A pair already past `days + GRACE + 1` when the code ships is excluded by the outer predicate (`OnboardingDripScheduler.ts:112-113`) and is reported **zero** times — including precisely the pre-existing staging backlog the cap was written for. |
| LOW | `CONTEXT.md:13` | The **Job-failure sink** entry's closing sentence "Sentry is the single durable record of a handler error" contradicts its own preceding clause: the six domain `'failed'` hooks it names are themselves durable records for their queues. |
| LOW | `worker/background/schedulers/__tests__/onboarding-drip-scheduler.integration.test.ts:5` | Header still documents `runOnboardingDripCycle(exec, asOf)` — the parameter name the branch deliberately renamed to `db` (D11) to preserve `ci:tenant-scope` coverage. A stale reference that invites the exact regression the branch just fixed. |

---

## Reasoning

### HIGH — `OnboardingDripScheduler.ts:51-54`: the doc comment asserts a fix that is not in the code

The comment on `runOnboardingDripCycle` reads:

> One drip cycle. THROWS on a query failure — the poll wrapper below is the only place that swallows. The old `checkAndSchedule` caught its own query error and returned, so a crashed query and a legitimate "nothing due" were the same observable: zero rows queued, no alert, for three months.

Three things are wrong with this, and they compound:

1. **`checkAndSchedule` is still a swallower, and it is not "the poll wrapper".** Lines `183-193`:
   ```ts
   export async function checkAndSchedule(): Promise<void> {
     try {
       if (isMockMode()) { ... return; }
       await runOnboardingDripCycle(sql, new Date());
     } catch (error) {
       logger.error('Scheduler cycle failed', error);
     }
   }
   ```
   The `catch` block is **unchanged from the pre-#719 file** (it appears as diff context, not as a `+` line). The extracted function throws into a caller that catches it identically to before. There are now two swallowers, and the inner one is the one the comment names as the root cause.

2. **Neither swallower alerts.** `createGuardedPoll` (`worker/background/guarded-poll.ts:106-113`) does `logger.error(onErrorMessage, toError(err))` and nothing else — no `Sentry.captureException`. So even if the local `try/catch` were deleted, a broken scheduler query would still produce one JSON log line and no Sentry issue. The "no alert" property the comment says was the three-month root cause is **still true after this PR**.

3. **The new sink does not cover this path.** `attachJobFailureSink` is wired only over `workersByQueue` (`worker/index.ts:476-493`) — BullMQ `Worker`s. A scheduler is not a `Worker`, so the loop that this ticket rewrote has no failure sink at all.

**Concrete failure scenario:** a future schema change breaks the new query (it now reads `job_outbox.dispatched_at` / `completed_at` and `businesses.subscription_activated_at` — the exact `42703` class as #719). The scheduler logs `Scheduler cycle failed` once an hour, raises no issue, and queues nothing. The next engineer reads this JSDoc, believes the loop is now alerting, and does not look. That is #719 reproduced verbatim.

**Recommended (ambitious) fix, per the skill's "delete complexity" bar:** the branch built a failure sink for BullMQ Workers and left the symmetric hole open for background loops. Either
(a) delete `checkAndSchedule`'s local `try/catch` entirely — `createGuardedPoll` already owns containment, so this removes a duplicated concept and makes the JSDoc true — **and** add a Sentry capture to `createGuardedPoll`'s catch, which fixes every one of the ~24 loops at once and is the natural counterpart to `job-failure-sink.ts`; or
(b) if a repo-wide loop sink is out of scope for #719, rewrite the JSDoc to say what actually changed (the cycle became callable and assertable from a test) and record the alerting gap explicitly. What must not stand is a comment that says the gap is closed.

### HIGH — `worker/job-failure-sink.ts:28-30`: `boundedErrorClass` neither bounds nor mirrors

```ts
/**
 * Error NAME only. Mirrors csv-ingest's PII contract
 * (worker/jobs/csv-ingest/failed-hook.ts:93): ...
 */
function boundedErrorClass(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}
```

The helper it names (`worker/jobs/csv-ingest/failed-hook.ts:93-97`) is:

```ts
/** Error NAME only, bounded — never the message (may embed handle values). */
function boundedErrorClass(err: unknown): string {
  if (err instanceof Error && err.name) return err.name.slice(0, 100);
  return 'UnknownError';
}
```

Three concrete divergences from the contract the copy claims to mirror:

- **No bound.** The identifier says `bounded`; the body applies no `.slice`. A synthesized or wrapped error name goes into the log line at whatever length it has.
- **Empty-name hole.** `err.name === ''` is falsy — csv-ingest guards it and returns `'UnknownError'`; the copy emits `error_class: ""`.
- **Wrong fallback shape.** `typeof err` yields `'object'` for a thrown plain object and `'string'` for a thrown string — a JS primitive kind, not an error class. The field is named `error_class` at the call site (`:48`), so the log record now carries a value that is not a class.

**Named standard violated:** "Bespoke helpers where the codebase already has a canonical utility for the job" / "Copy-pasted logic instead of extracted helpers" (skill §What to Flag Aggressively). Two functions with the same name, the same stated contract, and different behaviour now exist in `worker/`.

**Recommended fix:** lift one implementation into `src/lib/shared/logger.ts`, which already owns `toError` and `errorMessage`, and have both `csv-ingest/failed-hook.ts` and `job-failure-sink.ts` import it. That deletes a duplicate and gives the PII contract a single owner instead of two drifting copies.

*(Also noted in the appendix: the JSDoc's stated rationale — "string logger arguments bypass the object sanitizer" — describes neither this call site nor the real hazard.)*

### MEDIUM — `worker/jobs/OnboardingDripWorker.ts:24`: feature-named module becomes cross-cutting

Before this branch, `worker/jobs/summary-report-helpers.ts` had exactly two importers: `WeeklySummaryWorker.ts` and `MonthlyImpactWorker.ts` (verified by `rg -l summary-report-helpers`). The branch adds `OnboardingDripWorker.ts` — a worker that produces no summary report — as a third.

The collapse of `ownerHasDashboardAuth` + `buildDashboardUrl` into `resolveDashboardUrl` is a genuine deepening (one call replaces two, the query is skipped when `appUrl` is unset, and the impossible-state pair is gone). The problem is only its **home**: `resolveDashboardUrl` is now a cross-cutting owner-auth concern living behind a name that says "summary report".

**Maintenance scenario:** someone retiring or restructuring the summary-report feature greps `Summary` / reads the module name and concludes the file's blast radius is the two summary workers. The onboarding drip silently loses its dashboard link (or the file gets moved and the drip import breaks in a way that reads as unrelated). This is the "logic in the wrong layer when there is a clear canonical home" case.

**Recommended fix:** either rename the module to something that covers all three consumers, or extract just `resolveDashboardUrl` to its own small module. The repo's "default is no new file" rule argues for the rename, which is also the cheaper change.

### MEDIUM — `src/lib/shared/__tests__/live-db-tenant.ts`: inconsistent with its own siblings

Every other shared live-DB test helper lives one directory deeper:

- `src/lib/shared/__tests__/helpers/live-db-lock.ts`
- `src/lib/shared/__tests__/helpers/schema-ready.ts`
- `src/lib/shared/__tests__/helpers/abort-injection.ts` (named in `.claude/CLAUDE.md`)

`live-db-tenant.ts` is the only non-`*.test.ts` file sitting directly in `src/lib/shared/__tests__/`. Both new suites import across the split in one block — e.g. `onboarding-drip-scheduler.integration.test.ts:39-57` pulls `live-db-lock` and `schema-ready` from `.../__tests__/helpers/` and `live-db-tenant` from `.../__tests__/`.

The file's own header spends six lines arguing it is safe from vitest's include glob because the glob only matches `*.test.{ts,tsx}` — an argument that is unnecessary for anything in `helpers/`, and which becomes load-bearing the moment someone widens that glob or adds a "no bare `.ts` in `__tests__/`" lint rule.

**Recommended fix:** move to `src/lib/shared/__tests__/helpers/live-db-tenant.ts` and delete the glob-safety paragraph.

### MEDIUM — `CONTEXT.md:12`: the Drip staleness cap entry over-promises the abandoned tail

The entry ends:

> The abandoned tail is reported for exactly one day (the `GRACE + 1` outer window) and then drops out of the query forever.

The outer predicate is (`OnboardingDripScheduler.ts:112-113`):

```sql
AND b.subscription_activated_at
      > ${asOf}::timestamptz - ((d.days + ${STALENESS_GRACE_DAYS} + 1) || ' days')::interval
```

So a `(location, drip_type)` pair is only ever *selected* while `subscription_activated_at` sits inside a one-day band. That produces the promised one-day report **only for pairs that cross the boundary while the scheduler is live**. Any pair already older than `days + GRACE + 1` at deploy time — for `day_1`, activated more than 5 days ago — never enters the result set and is therefore reported **zero** times. It is dropped silently, with no `warn` line.

That population is not hypothetical: it is exactly the staging backlog (93 failed rows across 3 locations, per the same PR's lab notes) that motivated the cap. On the deploy that ships this, the drips the reader would most want reported are the ones the glossary promises will be reported and the code does not report.

The entry is not wrong about the mechanism; it is wrong about the scope. A glossary that over-claims observability is worse than silence, because it stops the reader from adding the check.

**Recommended fix:** add the qualifier — "reported for one day *for pairs that cross the boundary while the scheduler is running*; pairs already past the outer window when the cap ships are dropped without a log line."

### LOW — `CONTEXT.md:13`: internal contradiction in the Job-failure sink entry

> ... so durable per-domain error text stays the job of the six domain `'failed'` hooks. **Sentry is the single durable record of a handler error.**

The second sentence contradicts the first. For the six queues that own a domain hook (`csv-ingest`, `publisher`, `zernio/ingest`, `judge`, `solicitation-batch/failed-hook`, `solicitation-batch/generate-failed-hook` — count verified), the hook writes durable per-domain error text, so Sentry is not the *single* record there. The claim is true only for the queues without a hook.

**Recommended fix:** "Sentry is the only durable record for the queues that own no domain `'failed'` hook."

*(The rest of both new entries and the Watchdog extension check out — see "Glossary discipline" below.)*

### LOW — `onboarding-drip-scheduler.integration.test.ts:5`: stale `exec` in the suite header

> ... the cycle is called through the `runOnboardingDripCycle(exec, asOf)` seam ...

The parameter is `db`. Commit `861d4411` renamed `exec` → `db` specifically because `ci:tenant-scope` recognizes tagged-template clients only under `sql` / `tx` / `db` (`scripts/ci/tenant-scope-audit.ts:712`), and naming it `exec` made this file's global scan invisible to the audit — which would have reported its three allowlist entries as dead and quietly deleted the audit's only record of a deliberate cross-tenant sweep. That reasoning is documented at length in the scheduler's JSDoc (`:61-67`) and in D11.

Leaving `exec` in the suite header is the one remaining place in the tree that shows the forbidden name as if it were the signature. Cheap to fix, and the cost of not fixing it is a future contributor copying it back.

---

## Standards checked and found clean

Run in the worktree, all green:

| Check | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm ci:tenant-scope` | pass — entries: 412 (baseline: 412); the refreshed `ONBOARDING_DRIP_CANDIDATES_SQL` snippet matches and all three entries stay live |
| `pnpm ci:static-policy` | pass (1129 files scanned) — invariants #10, #13, #14 |
| `pnpm ci:db-imports` | pass (strict) — invariant #15 |
| `pnpm ci:live-db-suites` | pass — both new integration suites are correctly named, hold `acquireLiveDbLock`, and execute no run-time DDL |

Manually verified:

- **No `any`.** The two casts present (`err as { code?: string }` at `OnboardingDripScheduler.ts:158`, `job.data as { outbox_id?: unknown }` at `job-failure-sink.ts:41`) both narrow through `unknown`-shaped object types, not `any`. `:41` is the correct shape for the JSONB carve-out.
- **No silent catches.** Every new `catch` logs. `OnboardingDripScheduler.ts:159` (`if (code === '23505') continue;`) is a deliberate, commented no-op paired with the `ON CONFLICT DO NOTHING`; `job-failure-sink.ts:50-53` is a documented last-resort sink that logs.
- **Best-effort work after a primary side effect is wrapped.** `reportJobFailure`'s whole body is inside `try/catch` — a reporting failure cannot escalate to an `uncaughtException` from a `'failed'` listener.
- **No string literals for constrained vocabularies — improved.** The branch *removes* a standing carve-out: `subscription_status IN ('active','trialing')` becomes `IN (${SubscriptionStatus.ACTIVE}, ${SubscriptionStatus.TRIALING})` (`OnboardingDripScheduler.ts:107`), matching `CancellationGracePoller.ts:48`. Topic names come from `QUEUE_NAMES` throughout. `'pending'` / `'failed'` / `'business'` remain raw, consistent with the rest of the outbox call sites and outside the four constrained vocabularies the rule names.
- **`node:crypto` only.** `src/lib/shared/__tests__/live-db-tenant.ts:19` uses `randomUUID` from `node:crypto`; no `crypto-js` anywhere in the diff.
- **Invariant #12 (entry points orchestrate).** Satisfied and improved: the `'failed'` branch is extracted out of `worker/index.ts` into a named module with its own tests, and `worker/index.ts` shrinks to one-line wiring. `checkAndSchedule` is now a thin orchestrator over `runOnboardingDripCycle`.
- **Invariant #15.** `runOnboardingDripCycle(db: Sql, asOf: Date)` takes the client explicitly; only `checkAndSchedule` (composition root, registered in `worker/index.ts`) reaches for the singleton, and `jsonb()` stays inside that root's file. `resolveDashboardUrl(sql: postgres.Sql, ...)` follows the same rule. `ci:db-imports` confirms.
- **No new top-level directories, no new dependencies, no lockfile churn.** `worker/job-failure-sink.ts` is a sibling of the existing `worker/emitter-errors.ts` / `worker/sentry.ts` root modules — the established home for cross-worker wiring.
- **Structured logging.** All new log calls go through `createWorkerLogger`; counts and IDs are passed as object args (sanitizer path). No review text, tokens, or secrets.
- **No file crosses 1000 lines.** Largest changed production file is `OnboardingDripScheduler.ts` at 209 lines (from 96). The largest new file overall is a 540-line integration suite.

### Glossary discipline (my axis)

- **Identifier ↔ coined-term match:** clean. `STALENESS_GRACE_DAYS` / "Drip staleness cap" and `worker/job-failure-sink.ts` / "Job-failure sink" line up; no synonym drift ("grace window", "failure hook", "error sink") anywhere in the production code.
- **Watchdog extension:** accurate and non-contradictory. `OutboxPoller.ts:140-143` does write `last_error = 'Stale dispatched entry exceeded max_attempts'` unconditionally in the terminate arm, and that arm fires only on stale-`dispatched` reclaim — so "that text describes the reclaim, never the handler failure underneath it" is correct and does not conflict with the original definition.
- **Drip staleness cap "sole producer" claim:** verified. `rg ONBOARDING_DRIP` across non-test, non-doc sources shows the scheduler as the only writer of that topic; `worker/queues.ts` and `worker/index.ts` are registration only. The producer-only enforcement argument holds.
- **Job-failure sink "six domain hooks":** verified — `csv-ingest`, `publisher`, `zernio/ingest`, `judge`, `solicitation-batch/failed-hook`, `solicitation-batch/generate-failed-hook` (`failed-hook-shared.ts` is shared infrastructure, correctly not counted).
- Two accuracy defects found — `CONTEXT.md:12` and `:13`, in the table above.

### Lab notes (`.claude/reference/lab-notes.md`, 8 entries)

Every checkable citation verified against the code:

| Claim | Verified |
|---|---|
| `OutboxPoller.ts:140-143` sets `last_error` unconditionally on terminalize | ✓ `last_error` at line 142, inside the 139-146 UPDATE |
| `OutboxPoller.ts:293-299` dispatch-error path sets `'failed'` without `completed_at` | ✓ log at 289, UPDATE immediately after, no `completed_at` |
| `recordOutboxTransientError` at `outbox.ts:183`, `isTerminalAttempt` at `:211` | ✓ exact |
| `isTerminalAttempt` is `attemptsMade >= max \|\| attemptsMade + 1 >= max`, not a naive `>=` | ✓ verbatim |
| `csv-ingest/failed-hook.ts:34` states the PII contract | ✓ ("PII contract: only the bounded error CLASS is persisted/logged") |
| `tenant-scope-audit.ts:712` is the `['sql','tx','db']` tag set | ✓ exact line |
| `CancellationGracePoller.ts:48` binds the status from the enum | ✓ exact line |
| The scheduler's in-flight `NOT EXISTS` excludes only `status <> 'failed'` | ✓ |
| The three-way `COALESCE(completed_at, dispatched_at, created_at)` rationale | ✓ matches both writer paths |

No factual defects found in the lab notes. Note the sink's own comment cites `csv-ingest/failed-hook.ts:**93**` (the function) while the lab note cites `:**34**` (the prose contract) — both resolve to something real, so this is not a defect, but see the appendix.

### Settled deviations — not re-litigated

Per the review brief and `docs/superpowers/plans/feat-719-drip-dropped-column-deviations.md`: the sink writing nothing to `job_outbox` (D3), `isTerminalAttempt` being imported rather than reimplemented (D4), and the `exec` → `db` rename (D11) are all accepted and are **not** flagged. D11 in particular is defended above as the correct call.

---

## Low-confidence appendix (deliberately excluded from the table)

These are taste-level, speculative, or overlap the adversarial reviewer's lane. Recorded for completeness; none should block.

1. **Observability machinery embedded in the selection query.** `runOnboardingDripCycle` returns rows it immediately discards — `too_late` and `churn_capped` exist only so two `warn` counts can be emitted, and the `GRACE + 1` outer predicate exists only to make the skip visible for a day. That is two boolean columns, a correlated subquery, an extra `WHERE` clause, three `.filter` passes and two `if` branches in service of logging rather than behaviour. A leaner shape: select only actionable rows, and emit skip counts from one aggregate. **Overlaps the adversarial reviewer's approach-level critique — deferring to them rather than duplicating.**

2. **Three `.filter` passes over `dueDrips`** (`OnboardingDripScheduler.ts:128-132`) where one loop would partition in a single pass. Micro; the current form is more readable.

3. **Ambiguous shared log message.** `checkAndSchedule`'s catch (`:191`) and `createGuardedPoll`'s `onErrorMessage` (`:200`) both emit `'Scheduler cycle failed'` at `.error`, from two different causes (a cycle throw vs. the 10-minute `withTimeout` deadline). Since the inner catch now absorbs all throws, the outer message can only mean "deadline exceeded" — but on-call cannot tell them apart from the log line. Pre-existing; folded into the HIGH finding as supporting detail. Would resolve for free if the local catch is deleted.

4. **Two structural-typing idioms for the same wiring.** `attachJobFailureSink(worker: Pick<Worker, 'on'>, ...)` vs `attachEmitterErrorLogger(emitter: ErrorEmitting, ...)` — both called on the same object in the same loop in `worker/index.ts:487-492`. Harmless, but a reader now has to hold two conventions. A shared `ErrorEmitting`-style alias would unify them.

5. **The sink's PII rationale is imprecise about its own call site.** The JSDoc (`job-failure-sink.ts:23-26`) says "string logger arguments bypass the object sanitizer" — but `error_class` is passed inside an *object* arg (`:46-49`), which does go through `sanitizeAnalyticsProperties`. The real hazard it should name is that `Error` args also bypass the sanitizer: `serializeError` (`src/lib/shared/logger.ts:33-45`) copies `err.message` verbatim into `error_message`. That is why passing the raw error would leak, and it is also why `OnboardingDripScheduler.ts:160` and `:191` — which both pass a raw `Error` — log full Postgres messages while the new sink carefully does not. The conclusion (log the name only) is right; the reason given is not the operative one, and the same PR is internally inconsistent about it. Both scheduler lines are pre-existing and unchanged in behaviour, so this is not raised as a violation.

6. **Duplicated test vocabulary.** `DRIP_TYPES` is spelled identically in both new integration suites (`onboarding-drip-scheduler.integration.test.ts:96-100`, `onboarding-drip.integration.test.ts:118-122`), and `DRIP_OFFSET_DAYS` (`:102-106`) re-spells the scheduler's SQL `VALUES ('day_1',1),('day_7',7),('day_30',30)` table. Drift would fail loudly rather than silently (the suites compute activation instants from their own table), so the risk is low — but the offset table now has two owners and is a natural candidate for the shared fixture.

7. **`worker/job-failure-sink.ts` is not listed in `.claude/CLAUDE.md`'s "Worker layout" section**, which enumerates the worker-root modules (`sentry.ts`, `emitter-errors.ts`, `config/`, `queues.ts`, `redis-connection.ts`). `docs/directory.md` does not enumerate worker-root files at all, so there is no audit tick to fix there. The gap: a future contributor reading that list sees `emitter-errors.ts` as the only emitter-listener module and may re-inline a `'failed'` listener in `index.ts`. Adding one bullet would close it; excluded from the table because the section explicitly says it "lists only the conventions that decide *where new worker code goes*", and a reasonable author could judge this file as covered by the existing `emitter-errors.ts` precedent.

8. **`boundedErrorClass` returns `''`** when `err.name === ''`. Folded into the HIGH finding rather than listed separately.

9. **`reportJobFailure` is exported solely for the unit suite**; `attachJobFailureSink` is the only production consumer. Standard testing-seam tradeoff, called out in D9. Not a finding.

10. **`DripCycleResult` is returned and then discarded** by `checkAndSchedule` (`:189`) — in production the counts survive only as log lines. The JSDoc is honest that this is a test seam ("Skips are COUNTS so tests assert a value, not a log line"), which is a legitimate reason.

---

## Verdict on the approval bar

The branch is structurally sound: the extraction is a genuine deepening, `resolveDashboardUrl` collapses an impossible-state pair into one call, the sink is correctly extracted per invariant #12, no file approaches 1000 lines, no ad-hoc branching is bolted onto unrelated flows, and every CI audit passes. Two things hold it back from clean:

- the **HIGH** JSDoc claim at `OnboardingDripScheduler.ts:51-54`, which tells a future reader that the ticket's own failure mode is now alerting when it is not; and
- the **HIGH** duplicated-and-divergent `boundedErrorClass`, which forks a stated PII contract into two implementations.

Both are small edits. The first, taken ambitiously (delete the redundant catch, add a Sentry capture to `createGuardedPoll`), would close the symmetric observability hole for all ~24 background loops and is the strongest code-judo move available on this branch.
