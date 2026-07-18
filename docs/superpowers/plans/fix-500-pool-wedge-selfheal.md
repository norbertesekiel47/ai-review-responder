# Plan — #500 Pool-wedge self-heal (map #472) — REV 3 (post-Codex ×2)

Branch: `fix-500-pool-wedge-selfheal` · RISK=high · backend · db_touching=false
Intake: `.feature/intake.json` (authoritative scope) · Glossary: `CONTEXT.md`
Rev 2 folded in Codex round 1 (7 findings). Rev 3 folds in Codex round 2:
marker is scope-not-auth (anchored prefix match), genuine runtime direct-route
verification via app_name echo + `DIRECT_URL` config + Sentry alert, explicit
`closeHealthSql()` in shutdown, and honest residual-window / guarantee wording.

## Problem (one paragraph)

A postgres.js pool connection stalls in server-side `state=active,
wait_event=ClientRead` (a socket-level stall — server waiting for client bytes
that never arrive). No server-side timeout heals it. `withTimeout` does **not**
cancel the underlying work (`with-timeout.ts:23-28`), so the wedged query's
connection is never returned to the shared pool — one leaked slot per cycle →
full-pool outage. Observed origin: `HealthAlertPoller`'s `checkStaleDispatching`
(`health-alert/checks.ts:88`). The trigger is a rare driver stall; the fix heals
regardless of trigger.

## Identity through Supavisor (the crux — verified on staging 2026-07-18)

Supavisor's transaction pooler flattens EVERY client's `application_name` to
`'Supavisor'` server-side (a pooler-routed `pg_sleep` with a custom `PGAPPNAME`
showed `application_name='Supavisor'`; a direct :5432 psql showed `'psql'`). So
we CANNOT identify our backends by `application_name`. Nor is a table name proof
of ownership — Vercel dashboard reads and other worker queries hit the same
tables through the same pooler and also show as `'Supavisor'` (Codex F1/F7).

**Identity = an explicit query-comment marker we inject: `/* rw-reapable */`.**
It rides inside the query TEXT (which the pooler forwards verbatim and
pg_stat_activity exposes), so it survives Supavisor and appears ONLY on queries
we deliberately opt in. The reaper terminates a backend only when its query
**begins with** this marker (anchored `LIKE '/* rw-reapable */%'`, not a
substring — so the marker buried in another query's comment/string can't match).

The marker is **cooperative opt-in SCOPE, not authentication** — it is forgeable
and `LIKE`-matchable, so the honest guarantee is "the reaper never terminates an
**unmarked** backend", NOT "never another service" (Codex Rev-2 F2). Only
RepWorth code injects it, today on the five read-only health-check queries;
publisher/approval/billing writes are never marked (F7 resolved by construction).

## Wedge signature (what the reaper matches)

ALL must hold: `backend_type='client backend'` AND `datname=current_database()`
AND `state='active'` AND `wait_event='ClientRead'` AND
`now()-state_change > ageThresholdS` AND `query LIKE '/* rw-reapable */%'`
(anchored PREFIX — the marker must start the query; not a substring match).
Age keys on `state_change` (continuously-active), not `query_start` (the visible
query restamps every cycle). Candidate SELECT also returns `backend_start` for
atomic revalidation at terminate time.

## Design (seams)

- **`createDedicatedPostgresClient(url, overrides?)`** — DEEPEN
  `src/lib/db/server.ts` (DB-client owner). Hides pinned postgres.js config;
  callers pass tight `max`/`statement_timeout` overrides. Two adapters (reaper,
  health) → real seam.
- **`resolveDirectUrl()` + runtime direct-route verification** (reaper module) —
  picks `DIRECT_URL ?? DATABASE_URL` (a cheap host/`:6543` pre-filter), then does
  a GENUINE runtime check: connects with `application_name='rw-wedge-reaper'` and
  runs `SELECT current_setting('application_name')`. A direct :5432 connection
  echoes it back; Supavisor swallows it to `'Supavisor'`. Only an exact echo
  counts as verified-direct. If unverified, the reaper is **disabled + raises a
  Sentry warning** (not merely logged) and never runs on the pooler it heals.
  (Rev-2 F3; resolves the env-vars.md:38 "DATABASE_URL pooled" doc-vs-staging
  discrepancy without trusting the doc or a heuristic.) `DIRECT_URL` is added to
  the worker config schema (opt).
- **`select-terminations.ts`** — PURE `(rows, {ageThresholdS, cap}) →
  {targets: {pid, backendStart}[], droppedCount}`. No side effects; oldest-first
  by age; caps; the dangerous decision is unit/property-testable in isolation.
- **`reaper-query.ts`** — the candidate SELECT (returns pid, backend_start,
  state_change, age_s, marker-matched) and a **single revalidating terminate**:
  `SELECT pid, pg_terminate_backend(pid) AS terminated FROM pg_stat_activity
   WHERE (pid, backend_start) IN ${tuples} AND datname=current_database()
     AND state='active' AND wait_event='ClientRead'
     AND now()-state_change > make_interval(secs=>${age})
     AND query LIKE '/* rw-reapable */%'` — re-checks the full signature +
  backend_start atomically, closing the select/kill TOCTOU + PID-reuse race down
  to a residual **microsecond-scale** window inside `pg_terminate_backend` itself
  (predicate-eval vs signal-delivery), accepted given the single-replica worker
  (Rev-2 F1). Tolerates `terminated=false`/empty (already gone).
- **`health-db.ts`** — `getHealthSql()` / `recycleHealthSql()` / `closeHealthSql()`.
  `recycleHealthSql` = `try { await withTimeout(healthSql.end({timeout:1}), 2000) }
   catch {log-swallow} finally { healthSql = build fresh }` — rebuilds
  unconditionally even if end hangs/rejects (F2). `closeHealthSql()` ends the
  client without rebuild, for shutdown. Dedicated client `max: 2`.

## Two mechanisms cover each other (defense-in-depth)

- **T2 in-process self-heal (fast, ~≤30s):** health poller runs on its own
  dedicated client; on `withTimeout` expiry it end+rebuilds → client-side FIN →
  server ClientRead gets EOF → wedged backend dies (plausible per postgres.js
  `socket.end()`; not guaranteed — hence the backstop).
- **Reaper out-of-band backstop (slow, ~60s):** an independent loop on a
  separate DIRECT connection server-side-kills the marked wedge with certainty,
  even if the poller's event loop is itself starved or `recycle` throws. Distinct
  failure domains. The health-check queries carry the `/* rw-reapable */` marker
  precisely so the reaper backstops the known site.

## Tracer tickets

### T0 — foundation: dedicated-client factory + reaper config
- **Edits:** `src/lib/db/server.ts` (`createDedicatedPostgresClient`),
  `src/lib/config/worker.ts` (`POOL_WEDGE_REAPER_ENABLED` default `true`,
  `POOL_WEDGE_REAPER_INTERVAL_MS` default `60000`, `POOL_WEDGE_REAPER_AGE_S`
  default `300`, `POOL_WEDGE_REAPER_MAX_PER_SWEEP` default `3`,
  `POOL_WEDGE_REAPER_OP_TIMEOUT_MS` default `8000`, and **`DIRECT_URL` (opt)**),
  `.claude/reference/env-vars.md` (document the vars; clarify the reaper's
  direct-URL resolution + runtime app_name-echo verification; note the
  DATABASE_URL-direct-on-staging reality vs the stale "pooled" line).
- **Tests:** factory returns a client distinct from the `sql` singleton with the
  requested `max`; config accessors default + parse.
- **Blocks:** T1, T2.

### T1 — PoolWedgeReaperPoller (out-of-band backstop)
- **New:** `pool-wedge-reaper/reaper-query.ts`, `.../select-terminations.ts`,
  `.../__tests__/select-terminations.test.ts`, `PoolWedgeReaperPoller.ts`
  (single-flight; `resolveDirectUrl()`+self-validate else disable; dedicated
  client `max:2`, `statement_timeout:5000`; each sweep `withTimeout(op,
  OP_TIMEOUT_MS)` then on timeout recycle the reaper client; fetch→select→
  revalidating-terminate→log/emit warning finding per kill).
- **Edit:** `worker/index.ts` (register start; register **stop + client.end()**
  in the shutdown path alongside the shared singleton close).
- **Tests (fast-check + unit):** `selectTerminations` — `targets ⊆ input`,
  `|targets| ≤ cap`, oldest-first, correct `droppedCount`;
  disabled-without-direct-URL / pooler-URL-rejected (no throw); terminate
  tolerates already-gone tuple.
- **Blocked by:** T0.

### T2 — Health-poller bulkhead + self-heal (reclaim-at-source)
- **New:** `health-alert/health-db.ts` (dedicated client via factory,
  `getHealthSql`/`recycleHealthSql`).
- **Edit:** `health-alert/checks.ts` — prepend `/* rw-reapable */` to the five
  check queries (marker for the reaper backstop; read-only, safe).
  `HealthAlertPoller.ts` — `runHealthChecks(getHealthSql())`; on `withTimeout`
  expiry (TimeoutError) call `recycleHealthSql()`; preserve single-flight, the
  `'error'` probe check-in, log-and-swallow. **Shutdown wiring (Codex Rev-3):**
  the sync `stopHealthAlertPoller()`/`stopPoolWedgeReaperPoller()` only
  `clearInterval` (they run in the sync `stopBackgroundLoops()` step). The async
  client `.end()`s must be AWAITED — expose async `closeHealthSql()` and
  `closeReaperClient()` and await BOTH inside worker/index.ts's `closeDb` dep
  (the awaited `db close` step, `worker/shutdown.ts:99`) alongside the shared
  `sql.end()`, so closure is guaranteed before exit. This small `closeDb`
  integration lands once T1 (reaper) and T2 (health) both exist.
- **Tests:** on timeout the client is ended+rebuilt (fake) and the next cycle
  uses the fresh client; single-flight preserved; catch still records `'error'`;
  health queries never touch the shared `sql` singleton; each check query carries
  the marker.
- **Blocked by:** T0.

### T3 — glossary + ADR + lab note (docs; exempt surface)
- **New:** `docs/adr/0007-supavisor-app-name-flattening.md` — Supavisor flattens
  client `application_name` → backend identity by query-comment marker, not
  app_name; consequences for #477.
- **Edit:** `CONTEXT.md` — coin **Connection wedge**, **Wedge reaper**,
  **rw-reapable marker**; sharpen **Watchdog**.
- **Edit:** `.claude/reference/lab-notes.md` — `active+ClientRead` → no timeout
  heals it → client-side `end()`/`pg_terminate_backend`; Supavisor app_name
  flattening.
- **Blocked by:** T1, T2.

## Assumptions & scope
- Worker is **single-replica** (ADR 0005 addendum). The revalidating terminate is
  idempotent, so it stays correct if the worker is ever scaled out (two replicas
  terminating the same still-matching tuple is harmless).
- Only the health-check queries are marked `/* rw-reapable */` today — the reaper
  is deliberately scoped to that known-safe site. New wedge-prone queries opt in
  by adding the marker; the reaper never blindly kills untagged backends.
- Root-cause driver stall: opportunistic bisect only (#490 concurrency, Supavisor
  server-slots), not required for the fix.
- Staging mitigation revert `HEALTH_ALERT_POLL_INTERVAL_MS=86400000 → 300000`: an
  ENV change on the staging Railway worker at ship time (step 8), not code.
- #477 pool split: separate ticket; the reaper's dedicated client is containment.

## Verify
Standard gate (`scripts/verify-gate.sh`): lint, typecheck, test, all `ci:*`
(db-imports, tenant-scope, rls-audit). No `ui` build, no migration.
**Staging tracer (proves F2+F3):** open an `active+ClientRead` backend running a
`/* rw-reapable */`-marked query against staging; assert (a) the reaper's URL
routes direct (`inet_server_port()` ≠ 6543 / non-pooler host), (b) the candidate
row shows stable pid + backend_start and monotonically aging `state_change`,
(c) after the reaper fires the backend **disappears** from pg_stat_activity, (d)
the shared pool is unaffected throughout.
