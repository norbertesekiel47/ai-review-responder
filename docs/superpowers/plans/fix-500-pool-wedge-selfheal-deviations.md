# Deviations — #500 pool-wedge self-heal

Deviations from `fix-500-pool-wedge-selfheal.md` discovered during implementation.

## T1

### D1 — revalidating terminate uses `unnest(a::int[], b::timestamptz[])`, not a row-value `IN ${tuples}`

**Plan text:** `reaper-query.ts` → "single revalidating terminate … WHERE (pid,
backend_start) IN ${tuples} …".

**What I found (verified against postgres.js 3.4.9 offline):** postgres.js's
dynamic-value builder does **not** render a correct row-value tuple IN list.

- `(pid, backend_start) IN ${sql(tuples)}` renders `IN ($1,$2),($3,$4)` — the
  `in` builder emits the row groups **without** the outer wrap a row-value IN
  needs (`IN ((..),(..))`), producing invalid SQL.
- `(pid, backend_start) IN (${sql(tuples)})` **crashes**: the literal `(` before
  the fragment matches postgres.js's `\(`→`select` builder, which treats the
  tuples as column identifiers (`str.replace is not a function`).
- The only IN form that renders correctly is the surprising no-space `IN(${…})`
  (→ `IN(($1,$2),($3,$4))`), which a later editor adding one space would
  silently break back into the crashing `\(` path — rejected as too fragile
  (design.md: "surprising code is complexity").

**Resolution:** the terminate joins `pg_stat_activity` against the requested
tuples via `JOIN unnest(${pids}::int[], ${backendStarts}::timestamptz[]) AS
req(pid, backend_start)`. postgres.js parameterizes this cleanly
(`$1::int[], $2::timestamptz[]`), it is robust to formatting, and it preserves
the exact invariant: one atomic statement that re-checks the full wedge
signature **and** the `(pid, backend_start)` tuples, idempotent (a vanished or
mutated backend simply doesn't join → not signalled).

### D2 — `backend_start` / `state_change` are projected as TEXT

**Why:** postgres.js decodes `timestamptz` into a millisecond-precision JS
`Date`, truncating Postgres's microsecond precision. Round-tripping a captured
`backend_start` back into the revalidating terminate would then fail the
`req.backend_start = sa.backend_start` equality for any backend whose start time
has sub-millisecond microseconds — the terminate would never match. The candidate
SELECT therefore returns `backend_start::text` / `state_change::text`, and the
terminate casts the text array back with `::timestamptz[]`, preserving exact
equality. (The plan's row-value IN form would have hit the same latent bug.)

### D3 — direct-route pre-filter (host/`:6543`) omitted

The plan notes a cheap host/port pre-filter "can short-circuit" the direct-route
check. Omitted deliberately: the `application_name`-echo self-check is the
authoritative proof, and a URL-parsing heuristic would only add a second, weaker
source of truth (engineering.md: one authoritative owner per fact). No behavior
change — an unverified route still disables + Sentry-alerts.

## T2

### D4 — `health-db.ts` receives an injected `buildClient`, does NOT import the db/server factory

**Plan text:** "`getHealthSql()` — returns the module-held dedicated client,
building it lazily on first use via `createDedicatedPostgresClient(<url>, { max: 2 })`
… it may create the dedicated client via the `server.ts` factory."

**What I found:** `ci:db-imports` (`scripts/ci/db-imports-audit.ts`) is STRICT with
no allowlist — only composition roots (the fixed set + worker modules **registered
in `worker/index.ts`**) may import `src/lib/db/server`. `health-db.ts` is a helper
under `background/pollers/health-alert/`, not a registered root, so importing the
factory there fails the audit (confirmed: "not a composition root"). This is
exactly invariant #15's rule — domain modules receive their DB client as an
explicit parameter; only roots import the singleton owner.

**Resolution:** the factory import + the `DATABASE_POOL_URL`/`max:2` choice live in
the registered composition root `HealthAlertPoller.ts` (which already imported
db/server for the shared `sql`), exposed as a module-level `buildHealthClient()`.
`health-db.ts` imports nothing from db/server; it holds only the module-level
client state + reclaim semantics and receives `buildClient: BuildHealthClient` as
an explicit parameter to `getHealthSql(buildClient)` / `recycleHealthSql(buildClient, logger)`.
This mirrors the reaper precedent (the factory lives in the registered
`PoolWedgeReaperPoller.ts`, never a helper) and keeps `ci:db-imports` green.
Interface change vs the plan: `getHealthSql`/`recycleHealthSql` take the builder;
`closeHealthSql()` is unchanged (it never rebuilds). No behavior change.

## closeDb integration (shutdown wiring)

### D6 — the shutdown-wiring test needed a testable seam; option (c) chosen — extract the close-order contract into the db owner (`closeAllPostgresClients`)

**Plan text (`tests_to_add`):** "Shutdown closes both dedicated clients (reaper +
health) — `closeHealthSql` and the reaper client `end()` are invoked from the
worker shutdown path."

**The obstacle:** the wiring first landed **inline** in the `closeDb` dep in
`worker/index.ts`. `worker/index.ts` boots unconditionally on import (`main()`,
`createGracefulShutdown`, `process.on(...)` — no `require.main`/`import.meta`
boot guard), so the real inline `closeDb` cannot be reached from a unit test
without booting the whole worker. Its canonical test home
`worker/__tests__/shutdown.test.ts` is **outside** the allowed surface, and there
`closeDb` is only exercised via an injected fake — so even surface-expansion
alone would not have tested the real body. A test in the allowed
`pollers/__tests__/**` could only exercise a reconstructed copy (brittle "test
the copy" anti-pattern).

**Resolution — option (c), fully in-surface (chosen by the coordinator):** rather
than a boot guard, a `shutdown.ts` dep change, or expanding the test surface, the
close-order + best-effort contract was extracted into
`closeAllPostgresClients(dedicatedClosers)` in `src/lib/db/server.ts` — the DB
owner that already owns `sql`. It runs `Promise.allSettled(dedicatedClosers)`
FIRST, then `await sql.end()`, so a wedged/rejecting dedicated `.end()` can never
skip the shared pool close. `worker/index.ts`'s `closeDb` dep reduces to a
one-liner: `() => closeAllPostgresClients([closeReaperClient, closeHealthSql])`
(delegation; the argument list is composition-root wiring left to code review).
The seam is unit-tested in `src/lib/db/__tests__/server.test.ts` (in surface):
both closers invoked → then `sql.end()` (mocked, no real connection); a REJECTING
closer still runs the other AND still calls `sql.end()` (the load-bearing
resilience invariant); and close-ordering (`reaper`, `health`, then `sql.end`).
Combined with T1/T2's leaf tests (that `closeReaperClient`/`closeHealthSql`
actually `.end()` their clients), this genuinely covers the `tests_to_add` item.

No boot guard, no `worker/shutdown.ts` change, no surface expansion, no
`intake.json` edit were needed. Import style: `closeAllPostgresClients` is
imported statically at the top of `worker/index.ts` (added to the existing
`import { sql, supabaseServer } from '../src/lib/db/server'`), matching that
file's established static db-import precedent — the earlier dynamic `import()`
inside `closeDb` was the redundant outlier and is gone.

### D5 — `recycleHealthSql` log-swallows via the injected `WorkerLogger` (not a silent catch)

The plan's `recycleHealthSql` sketch shows a bare `catch { /* log-swallow */ }`.
Made the logger an explicit required parameter and `logger.warn(...)` the failed
`end()` (mirrors the reaper's `recycleReaperClient`), so the catch is genuinely
log-and-swallow, not silent (engineering.md: no silent catches). The rebuild is
still unconditional in `finally`.

## Step 6 adversarial-review fixes (Codex F1 + F2)

### D7 — direct-route verification unified across the reaper's FULL lifecycle (three-way outcome), with the poll cadence as the retry backoff

**What the review found** (`fix-500-pool-wedge-selfheal-review-triage.md`):
- **F1 [high]:** `initPoolWedgeReaper` swallowed ANY verify error into
  `verified=false`, which fed `disableWithAlert` (process-lifetime `disabled`). A
  transient DB/network blip at boot therefore PERMANENTLY removed the backstop
  until process restart — the exact degraded-dependency case the reaper exists to
  survive.
- **F2 [medium]:** `recycleReaperClient` rebuilt a client into `reaperSql`
  WITHOUT re-verifying, so a post-recycle route change (DNS/failover/topology)
  could run a sweep through Supavisor — violating the runtime-verified-direct
  invariant.

**Root cause (shared):** verification ran exactly once at boot and conflated a
*transient* verify failure with a *definitive* non-direct answer.

**Resolution — one unified verify path, three-way outcome.** Replaced the boolean
`isVerifiedDirect(client)` with `acquireVerifiedClient(logger): AcquireOutcome`
returning `{status:'verified',client}` | `{status:'pooler'}` |
`{status:'transient'}`. The load-bearing distinction: a verify query that RETURNS
a row whose `application_name` ≠ `rw-wedge-reaper` is a *definitive* pooler route
(permanent disable); a verify query that THROWS/times out is *indeterminate*
(transient → retry). Both `initPoolWedgeReaper` (boot) and `pollPoolWedgeReaper`
(acquire-on-demand when `reaperSql` is null) go through this single path, so the
strengthened invariant — **the reaper only ever sweeps on a verified-direct
connection at every point in its lifecycle** — holds at boot, steady-state, AND
post-recycle. `recycleReaperClient` now only ends+nulls the client (no rebuild);
the next tick re-acquires + re-verifies (fixes F2). Permanent disable now happens
ONLY on a definitive pooler echo or absent config (env immutable after boot); a
transient error defers without setting `disabled` (fixes F1).

**Deliberate choice — poll cadence IS the retry backoff.** A transient outcome
does not spin up a separate jittered retry loop; it simply returns and the
existing `setInterval` cadence (default 60s) re-attempts the acquire on the next
tick. This matches the poller precedent and design.md's "fewer moving parts"
bias — the loop already exists and already runs on a slow cadence, so reusing it
as the backoff avoids a second timer/state machine. Only an outage that outlasts
successive poll ticks keeps the backstop deferred; a brief boot blip self-heals
on the very next tick.

**Test note (non-obvious):** the recycle-on-timeout branch keys on
`err instanceof TimeoutError`. Because the test suite uses `vi.resetModules()`
per test, the module-under-test imports a FRESH `with-timeout` (fresh
`TimeoutError` class); the F2 tests therefore import `TimeoutError` DYNAMICALLY
after the reset (same fresh module graph) so the `instanceof` identity aligns — a
statically-imported `TimeoutError` would silently never match and the recycle
branch would look untested-but-passing.
