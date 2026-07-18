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

## Step 8 staging validation (blocker discovered)

### D8 — reaper's genuine-direct route is unreachable from Railway (Supabase direct = IPv6-only, Railway egress = IPv4-only) → Supabase IPv4 add-on required

**What the staging tracer prerequisite surfaced (2026-07-18):** after landing the
branch on `staging` and deploying the Railway worker, the reaper logged, every
boot/tick:

```
[ERRO] Direct-route verification errored (will retry)
  error="connect ENETUNREACH 2600:1f14:359d:...:5432 - Local (:::0)"
[WARN] Direct-route verification deferred (transient error at boot) — will retry on the loop
```

**Root cause (evidence):**
- `db.kubdiqdhqbhwmqfditeg.supabase.co` (staging direct host, the reaper's
  `DIRECT_URL ?? DATABASE_URL` target) has **only an AAAA record** (IPv6
  `2600:1f14:...`), **no A record** — Supabase direct connections are IPv6-only
  unless the dedicated-IPv4 add-on is enabled.
- The Railway worker's external egress is **IPv4-only** → `ENETUNREACH` to that
  IPv6 address. (Same class of gotcha CLAUDE.md already documents for the
  *internal* Railway network — here it bites the *external* direct route.)
- The worker's normal transactional client uses `DATABASE_POOL_URL` (the IPv4
  Supavisor pooler, `src/lib/db/server.ts:35`), so nothing exercised the IPv6
  direct route until the reaper. Local `psql` staging tests passed because the
  developer laptop has IPv6 — "works locally, fails on Railway."
- The only IPv4 path to the DB is the Supavisor pooler, which the reaper
  deliberately refuses (ADR 0007 app_name flattening → self-disable).

**Impact:** T1 reaper is **permanently inert** on Railway→Supabase as-is (F1 fix
behaving correctly: classifies ENETUNREACH as transient, retries every 60s,
never crashes, never permanently disables). **T2** (health-poller bulkhead +
recycle-on-timeout self-heal) is UNAFFECTED — it runs on the IPv4 pooler and
deployed cleanly; it is the primary #500 mitigation.

**Decision (user, 2026-07-18):** enable the **Supabase dedicated-IPv4 add-on**
(~$4/mo per project) on **staging AND prod** so `db.<ref>.supabase.co` gains an A
record reachable from Railway. No code change; reaper works as designed.
- Staging: enable now (unblocks the tracer). Prod: pre-merge prerequisite (reaper
  is default-ON → prod reaper would be inert without it).
- Meanwhile staging `HEALTH_ALERT_POLL_INTERVAL_MS` restored to `86400000` (24h
  mitigation) until the reaper works AND T2's self-heal is proven end-to-end,
  then reverted to `300000`.

> **SUPERSEDED by D9.** The user subsequently chose NOT to buy the IPv4 add-on
> now, and to ship the reaper DORMANT (`POOL_WEDGE_REAPER_ENABLED=false`) with the
> mitigation kept. D8's root-cause evidence still stands; only its "buy IPv4 now +
> revert to 300000" resolution is replaced.

### D9 — ship T2 (validated) with the reaper DORMANT; keep the 24h mitigation; root-cause + reaper-enable deferred to follow-ups

**Staging tracer RESULTS (2026-07-18, reaper set `POOL_WEDGE_REAPER_ENABLED=false`,
health interval temporarily 60000):**
- **#500 wedge reproduces live.** A marked health backend parks in
  `state=active, wait_event=ClientRead`, age climbing monotonically (sampled
  3s→46s+) — the exact signature `selectWedgeCandidates` targets. Root mechanism:
  the health checks' `Promise.all` batch through postgres.js on the **Supavisor
  transaction pooler** stalls at the protocol layer even though each query is
  fast (<40ms measured direct). NOT a slow query.
- **T2 containment VALIDATED.** Only ~1 marked backend exists at a time (no
  accumulation); the recycle's client-FIN flips the prior cycle's wedged backend
  `active→idle`; all other ~20 pollers keep running throughout — the **shared
  `sql` pool is never affected**. Bulkhead + recycle-on-timeout work exactly as
  designed.
- **Reaper dormant** confirmed (`Skipped — POOL_WEDGE_REAPER_ENABLED is not
  "true"`, no ENETUNREACH spam).
- **NEW finding:** the health poller wedges on **100% of cycles** → health
  alerting is entirely non-functional (only ever times out). This is
  **pre-existing** (the root wedge that caused #500 and prompted the 24h
  mitigation); T2 contains the blast radius but does NOT cure the Supavisor
  protocol stall — that was never in the self-heal's scope.

**Decisions (user, 2026-07-18):**
1. **Ship T2 now** (validated containment + marker + shutdown wiring) with the
   reaper **shipped dormant** via env `POOL_WEDGE_REAPER_ENABLED=false` on staging
   AND prod. Code default stays ON (backstop intent); the env flag gates it off
   until a direct route exists.
2. **Keep `HEALTH_ALERT_POLL_INTERVAL_MS=86400000`** (24h mitigation) on staging
   AND prod — do NOT revert to 300000. Running the poller at short cadence now
   would only spam timeouts with zero health signal (still wedges every cycle).
3. **Two follow-up tickets** (NOT in this PR's scope):
   - Root-cause the postgres.js↔Supavisor transaction-pooler wedge on the health
     client (likely: run the 5 checks sequentially, or give each its own
     connection / bump `max`, or a Supavisor-compat connection option) so the
     poller completes → then it's safe to revert to 300000.
   - Enable the reaper (`POOL_WEDGE_REAPER_ENABLED=true`) once a genuine-direct
     route is reachable from Railway (Supabase IPv4 add-on, or an alternative
     routing), and run the T1 termination tracer then.

**Net:** this branch is a strict improvement — it contains a pre-existing wedge
that previously starved the shared pool (#500) — and lands the infra needed to
later re-enable the poller safely. Nothing regresses; the mitigation stays.
