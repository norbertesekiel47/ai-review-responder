# Lab notes — Live-DB test suites

## Summary

- **Live-DB test suites** — a live-DB **suite** must be named `*.integration.test.ts` (that glob is what puts it in vitest's serialized `integration` project), and no live-DB **file** — suite or `__tests__/` helper — may execute DDL at run time: DDL's ACCESS EXCLUSIVE locks deadlock sibling suites whenever `verify-gate.sh` runs vitest in CONCURRENT PROCESSES, where in-process serialization does not reach (#573); provision with `pnpm test:db:setup`, assert with `assertSchemaReady`. Detection is AST extraction of EXECUTED SQL, not a text marker (#694, 2026-08-08 entry), over every `.ts`/`.tsx` under `__tests__/` rather than the suites alone — a helper can BUILD a DDL fragment a suite splices in, and reaches the DB by importing `postgres` (#706, 2026-08-08 entry). Two lock-enforced allowlists — migration-**shape** files and **DDL-probe** suites — must hold `acquireLiveDbLock` AND roll back any unconditional re-apply (a committed re-apply of an old migration reverts a later one on the shared DB); statically-invisible safety takes `-- live-db-ddl-ignore: <reason>`; force a transaction abort with `helpers/abort-injection.ts`, never a temporary constraint. Unsetting `TEST_DATABASE_POOL_URL` does NOT sleep the suites — `.env.local` disk fallback (#563, 2026-08-03 entry) — but `pnpm vitest run <file>` does NOT hydrate it, so a suite gated on it SKIPS silently (#694). **A THIRD surface reads that fallback: lefthook's pre-push `test-changed`** — a branch carrying an unpromoted migration can be gate-GREEN with the exports set and then fail `git push` without them, on a CONSTRAINT its own migration widened, in an error that reads like a defect in the code under test; export `TEST_DATABASE_POOL_URL` **and** `DATABASE_POOL_URL` for the push too, and when a live-DB suite fails on a constraint your migration touches, check the DB's schema before reading the diff (#629, 2026-08-17)

## Canonical entries

## 2026-07-26 — #573 live-DB suite deadlock under gate load

### [2026-07-26] Run-time migration DDL in a test suite deadlocks sibling suites across vitest PROCESSES — vitest serialization is per-process, only a session advisory lock spans processes
FAIL → `scripts/verify-gate.sh --review` failed intermittently (≈50%) with `PostgresError: deadlock detected` (40P01), always in a live-DB suite, never on an assertion; the victim varied between runs (`batch-builder.integration.test.ts`, `account-offboarding/integration-lifecycle.test.ts`) and even between tests within one suite, and the whole thing was invisible in CI (no `.env.local` → the suites skip) and unreproducible in isolation. WHY → the Postgres server log names both sides: one backend waiting for `RowShareLock` on `agent_runs` (`appendRunStep`'s `SELECT … FOR UPDATE`), the other waiting for `AccessExclusiveLock` on `solicitation_asks` while running **`088_solicitation_batch_executor.sql`** — a *test suite re-applying a migration in `beforeAll`*. DDL vs row locks on the same relations in opposite orders. Eight suites re-applied migration SQL to ensure their schema; `vitest.config.ts` already serializes `*.integration.test.ts` into its own project (`fileParallelism: false` + `groupOrder`), which makes this safe **within one vitest process** — but nothing in vitest spans processes, and `verify-gate.sh:70` launches every intake `verification_commands` entry in parallel with the main `test` row. #565's intake declared two of them (`pnpm test …ingest.integration.test.ts`, `…batch-builder.integration.test.ts`), so a `--review` run put three vitest processes on one database. Two more compounding facts: (1) `integration-lifecycle.test.ts` self-hydrated `.env.local`, so it ran even in a "no-export" gate run — which is why the issue's "every self-hydrating suite holds the shared lock, so this is ruled out" reasoning was wrong; and (2) its filename does not match `**/__tests__/**/*.integration.test.ts`, so it sat in the *parallel* project with ~740 other files. Differential proof: same two suites in ONE process 0/4 deadlocks, in TWO processes 3/6; the gate-shaped three-process arm 5/6 → 0/8 after the fix. CORRECT → remove the ingredient a test controls: the schema is provisioned once by `pnpm test:db:setup` and suites **assert** it (`assertSchemaReady`, which also owns the single migration→objects map) instead of applying it. A live-DB suite must also be named `*.integration.test.ts` so the serialized project actually claims it. Migration-**shape** suites legitimately apply DDL and are allowlisted, but must hold `acquireLiveDbLock` — a Postgres SESSION advisory lock is the only mechanism that serializes across processes (renamed from `feature-543-database-lock`, which had quietly become the shared protocol). Both rules are CI-enforced by `ci:live-db-suites`. General rule: "vitest runs these serially" is a claim about one process; the moment a script invokes vitest twice concurrently, every in-process guarantee is void — reach for a DB-side lock, or delete the contended operation.

### [2026-07-26] A migration-shape suite that COMMITS a re-apply of an old migration silently reverts a later migration on the shared test DB
FAIL → with the run-time DDL removed, `batch-builder.integration.test.ts` began failing on `agent_outcomes_outcome_kind_check` rejecting `solicitation_batch_built` — a value migration 088 explicitly added. The database had been freshly provisioned to head minutes earlier. WHY → `migration-074-…integration.test.ts`'s "applying the migration a second time is a clean no-op" test re-applied 074 **unconditionally and committed it**. 074 defines `agent_outcomes_outcome_kind_check` with its own, narrower value list; 088 later `DROP`s and re-`ADD`s that same constraint with `solicitation_batch_built` included. So a committed 074 re-apply drops the 088 version and restores the 074 one — leaving the shared DB permanently below head for every suite that runs afterwards. It had been invisible for as long as it existed because `batch-builder` re-applied 088 in its own `beforeAll` on every run and healed it; removing that DDL is what exposed it. Proven by differential: provision → constraint at head; run the 074 shape suite alone → constraint reverted, nothing else touched. CORRECT → a shape suite's unconditional re-apply runs inside `BEGIN` … `ROLLBACK` with its end-state assertions **inside** the transaction (they still observe the twice-applied schema, and nothing is left behind) — the pattern migrations 077/078's suites already used. General rule: on a SHARED database, any test that applies DDL owns the obligation to leave the schema exactly as it found it; re-applying migration N is not idempotent with respect to migration N+k when both write the same named object, and "the suite passes" says nothing about what it did to the next suite.

### [2026-08-03] TEST_DATABASE_POOL_URL fallback — unsetting it does NOT sleep live-DB suites (moved from CLAUDE.md, context diet)
`resolveTestDatabaseUrl()` (`live-db-lock.ts`) falls back to reading `.env.local` off disk, so the six suites gating on it (ingest, batch-builder, run-spine, live-db-lock, migrations 088/090) run even under `env -u`. That matters because a whole-repo `pnpm test` with the DB awake breaks the suites that set the `src/lib/db/server` singleton at import time — whichever file initializes it first wins and the rest get `ECONNREFUSED :5432` (the #520 class). CI never sees it because CI's DB *is* on :5432, so the singleton default happens to be right. Kill switch: `REPWORTH_DISABLE_LIVE_DB_SUITES=1`, honoured by both gates; `scripts/verify-gate.sh`'s full-suite row sets it alongside `env -u` (#563).
**[2026-08-31, #1009 — the MIRROR half, and it is the dangerous one.]** Unsetting the var does not put the suites to sleep; **setting it in `.env.local` does not wake them either.** `describeWithDb` reads `process.env.TEST_DATABASE_POOL_URL` DIRECTLY, and the off-disk fallback never hydrates `process.env` for it — so a suite present in the file and absent from the environment **self-skips and reports GREEN having executed nothing**. #1009 nearly shipped on that: five live-DB cases carrying the slice's entire safety argument passed without running, caught only by re-running with `--reporter=verbose` and checking the cases actually executed. CORRECT → `export` the var, never rely on `.env.local`, and confirm execution rather than exit code. And export `DATABASE_POOL_URL` to the same local URL in the same breath: `pnpm worktree:new` copies `.env*.local`, so a fresh worktree inherits the developer's **live Supabase pooler** there, and any accidental singleton import during a test run reaches production. Both halves of CLAUDE.md's "export BOTH first" are load-bearing — one decides whether the tests run, the other decides what they run against.

### [2026-08-16] live-DB lane CI gating — `pnpm test` is the gate, not `pnpm test:integration` (moved from CLAUDE.md, context diet)

- [2026-08-15] A 2026-08-15 architecture pass filed a false "correct tests that
  no gate runs" finding → it read `pnpm test:integration`'s one-suite list as
  "CI's coverage" → CORRECT: the live-DB lane IS gated in CI, by `pnpm test`.
  ci.yml's `test` job (a required check) stands up a `postgres:16` service,
  sets `TEST_DATABASE_POOL_URL` and provisions the schema via
  `.github/actions/test-db`, so `vitest run` executes both projects: 91 of 92
  integration suites run per PR (the abstainer, `trial-test-clock`, needs live
  Stripe credentials). `pnpm test:integration` hard-gates only the publisher
  edit-existing-reply suite and is a **developer fast-path, never the gate**.
  Because every suite degrades to a SILENT SKIP rather than a failure when the
  DB is absent, deleting four lines of that YAML would un-gate all 92 and leave
  CI green; `src/__tests__/ci-audit-wiring.test.ts` pins the wiring against
  exactly that. Locally, `pnpm test` runs them too (the `.env.local` fallback,
  see the 2026-08-03 note above). When touching governor/judge/publisher paths
  you can still run one file directly — export `TEST_DATABASE_POOL_URL` **and**
  `DATABASE_POOL_URL` first, or a singleton-backed suite dials the wrong host.

### [2026-08-16] #573/#706 detection notes and the fallow static-vs-coverage asymmetry (moved from CLAUDE.md, context diet)

- Live-DB DDL detection is AST extraction of **executed SQL** — every tagged
  template and `.unsafe()` call — never a text marker (#694: the
  `supabase/migrations` + `.unsafe(` conjunction missed three sites, one of
  which stranded a CHECK constraint and cost 14 spurious failures). The audited
  set is every `.ts`/`.tsx` under `__tests__/`, not just the suites (#706):
  Postgres.js splices a nested `Query` substitution in as raw SQL text, so a
  helper can build a DDL fragment a suite executes — **the finding lands on the
  file that BUILDS it**. Helpers reach the DB by importing `postgres` (they are
  handed the handle, so they name no env var); the `e2e/` Playwright lane is
  deliberately out of scope. Two sanctioned escapes, BOTH lock-enforced
  allowlists in `scripts/ci/live-db-suites-audit.ts`: migration-**shape** files
  (applying the migration IS the subject) and **DDL-probe** suites
  (session-scoped `auth.uid()` redefinition inside a rolled-back tx) — each
  must hold `acquireLiveDbLock` AND roll back any unconditional re-apply.
  Safety that is statically invisible takes a per-line
  `-- live-db-ddl-ignore: <reason>` (a `CREATE INDEX` on a `pg_temp` table
  reads exactly like one on the shared table). To force a transaction abort use
  `helpers/abort-injection.ts`, NEVER a temporary constraint — a vitest timeout
  skips the `finally` that would drop it. Provision once with
  `pnpm test:db:setup`; assert with `assertSchemaReady`.
- fallow: the coverage input is the `test` job's own `pnpm test:coverage` run
  (live-DB lane included), handed to the `fallow` job as an artifact, so a
  module covered only by an integration suite no longer reads 0% with inflated
  CRAP (#581). A bare `fallow audit` estimates CRAP from export references, so
  it **both invents findings CI lacks and misses ones CI has** (#783: a
  0%-covered component passed locally, failed CI at CRAP 420).
- Cost guard: pre-LLM Redis **transport** failures are RETRYABLE
  (`CostInfraUnavailableError` → BullMQ retry + outbox watchdog; #255 — do not
  re-terminalize); **budget-exceeded** decisions stay TERMINAL (never
  reclassify as infra); post-LLM finalize failures are governed by
  `withCostGuard`'s `onFinalizeError`, never a job-level retry (would
  re-spend). Upstash is a single-instance **SPOF** (cache + rate-limit +
  cost-reserve + regen-budget + idempotent-generation).
- Single-replica worker: four boot guards + the in-process LLM circuit breaker
  are only correct with one replica; `ci:static-policy` blocks
  `numReplicas`/`multiRegionConfig` in `railway.toml`, and replicas register in
  Redis so `HealthAlertPoller` pages when >1 is live (#587) — deliberately a
  registry, NOT a boot-gating lease (a Redis outage must never stop the worker
  starting). Before ever scaling: clear the P2 list in
  `docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md`.
- JSONB carve-out: `typeof x === 'string' ? JSON.parse(x) : x` then narrow is
  the *only* sanctioned exception to the no-`any` rule (never paper over it
  with `: any`); the allowlist (19 sites today) is the note above; HTTP/request
  bodies, provider responses, LLM output, Redis/cache values, local storage and
  `TEXT[]` reads do NOT belong on it (different parsing boundaries).
- timestamptz: any SQL comparison against a value that round-tripped through JS
  can mis-order by <1ms; fatal when a row is compared against a window/anchor
  derived FROM that same row (governor permanent re-suspension immunity #520;
  wedge-reaper `backend_start` equality before it). Truncate the DB side
  (`date_trunc('milliseconds', col) > ${jsDate}`) or keep the value `::text`
  end-to-end. JS-Date-seeded fixtures carry zero µs and CANNOT catch this —
  seed with `+ interval '419 microseconds'`.

## 2026-09-06 — #889 bounded handoff waits in live-DB concurrency suites

### [2026-09-06] A concurrency suite's bare `await deferred.promise` turns EVERY early return into an indistinguishable 30s timeout — the red carries no information, so nobody can own it
FAIL → `worker/jobs/publisher/__tests__/autopilot-entitlement-concurrency.integration.test.ts` was red at baseline across three architecture passes (2026-08-15, 2026-08-18) and was never owned. The report was a bare `30015ms` on one test, with the suite's declared `{ timeout: 30_000 }`, and a measured pass rate of **1 run in ~43** — a ~98% failure rate, not a flake. Nothing in the output said whether the cause was a production lock-order race or a test-harness lost wakeup, and #889 correctly refused to guess. At HEAD it no longer reproduces: 20/20 alone and green in CI (run `33851979573`, `✓ (10 tests) 1213ms`); the `c29258a4 → HEAD` diff does not explain it, and the #889 observations came from a mutation census on a saturated machine, so load is the likely aggravator. **The original cause remains UNCLASSIFIED and #889 stays open.**
WHY → ten waits were bare `await`s on a deferred that only a mocked call resolves. `processSubscriptionUpdated` can return `ignoredOutcome(…, 'stale_subscription')` or throw `AccountNotProvisionedYetError` **before** reaching the mocked Stripe retrieve, and on that path nothing resolves `retrieveEntered` — the body parks forever while the webhook's rejection sits unobserved. Three facts make a naive guard worse than none: (1) `statement_timeout` does NOT bound JavaScript parked inside an open transaction — no command is in flight to cancel, which IS the lost-wakeup shape; (2) a guard that throws without releasing leaves the mock holding the tier-entitlement advisory lock, so `afterAll`'s DELETEs block and one failed test wedges the whole FILE; (3) throwing from `afterEach` does not stop the file (`bail` defaults to 0), so the next `beforeEach` resets shared fixtures while the abandoned operation still writes to them (same class as the 2026-08-01 entry: abandoned, not cancelled).
CORRECT → give every wait a name, a watchdog **started when the operation starts** (not at the first await — several tests create an operation, sleep 200ms, assert, and only then await it), and a dump on expiry. `src/__tests__/helpers/concurrency-handoff.ts` (`startStage`) owns the DB-free timing logic and is unit-tested against its own failure paths; the suite supplies the dump. Budgets must NEST with margin or the evidence is destroyed before it is collected: **6s watchdog + 2s diagnostics inside a 10s `statement_timeout` inside the 30s test timeout** — equal watchdog and `statement_timeout` values let Postgres cancel the blocked statement first, leaving a bare rejection and no dump. The dump needs all three of: every backend on the database (the webhook runs on the **production singleton**, not on a suite client, so a four-connection dump omits the session holding the lock), `pg_blocking_pids()`, and `admissionStats(sql)` — an operation queued behind the #773 admission chokepoint executes NO SQL, so activity alone cannot tell it from a JS lost wakeup. Teardown is four layers and no single one is sufficient: resolve the release gates FIRST (the only layer that un-parks JS in a transaction), `connection: { statement_timeout: 10_000 }` on the suite clients, a bounded drain, and cleanup under its own wall clock with a concurrent `.end()` of all five clients — including the singleton, which this file may own because vitest defaults to `isolate: true` (module registry is per FILE). On drain expiry, **poison the suite**: latch a reason, close the clients (the only step that actually stops the work), and make every later `beforeEach` throw as its FIRST statement. Hooks need EXPLICIT timeouts — vitest defaults them to 10s and a describe-level `timeout` is a TEST timeout only. The two signatures this now prints, proven by fault injection: candidate (2) is `state=idle in transaction … blocked_by=[]` with granted advisory locks and no competing session; candidate (1) is `state=active wait=Lock/advisory blocked_by=[<pid>]` with the same advisory key granted to one pid and refused to another.

---

## History

- history/2026-08-01-to-07.md § "[2026-08-01] A vitest hook OR test-body timeout on a live-DB suite poisons the FOLLOWING tests — abandoned, not cancelled; and a budget near the observed worst case is a flake"
- history/2026-08-01-to-07.md § "[2026-08-03] `pnpm test:db:setup` DROPs schema `public`, so declaring it as a `verification_command` makes the gate race itself — provision serially BEFORE the fan-out"
- history/2026-08-01-to-07.md § "[2026-08-05] #674 — `describeWithDb` does NOT assert schema, and asserting what the suite READS is not enough"
- history/2026-08-08.md § "2026-08-08 — #694 live-DB DDL detector ship"
- history/2026-08-08.md § "[2026-08-08] #694 — `pnpm vitest run <file>` does not hydrate `.env.local`, so a live-DB suite SKIPS instead of failing"
- history/2026-08-08.md § "[2026-08-08] #680 — a `table_schema = 'public'` literal cannot follow a `pg_temp` shadow, which makes the suite that depends on it self-contradictory"
- history/2026-08-08.md § "[2026-08-08] #680 — `ci:live-db-suites` counts an unreadable `.unsafe()` argument as DDL, so a dynamically-executed guard needs its OWN pragma"
- history/2026-08-08.md § "2026-08-08 — #706 live-DB helper scan ship"
- history/2026-08-09-to-12.md § "[2026-08-09] #728 — verify-gate ran a changed publisher integration suite against vitest.setup's dummy localhost:5432"
- history/2026-08-09-to-12.md § "[2026-08-09] #730 — two live-DB integration suites fail on LOCAL env shape, not code (forced --no-verify staging pushes)"
- history/2026-08-13-to-21.md § "[2026-08-18] The local test DB is shared by every sibling worktree — another session can move it under a running suite"
- history/2026-08-21-to-31.md § "[2026-08-24] `migration-092`'s EXPLAIN-plan assertion is planner-flaky on a fresh CI database"
- history/2026-08-21-to-31.md § "2026-08-24 — #877 test-DB provisioning lock"
- history/2026-08-21-to-31.md § "[2026-08-24] rls-audit false-FAILED inside a gate whose own serialization was correct → the schema drop came from a SIBLING PROCESS → the fix is a cross-process advisory-lock protocol, not re-ordering"
- See also migrations.md § "Test-DB provisioning: local and CI applied the same "shared recipe" to different schemas" (canonical, moved with the 2026-08-14 lockstep entry)
