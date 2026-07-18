# Spec & Correctness Review — #500 pool-wedge self-heal

**Reviewer axis:** Spec faithfulness + correctness (review-only, no code modified).
**Verdict:** PASS — **NO HIGH-CONFIDENCE FINDINGS.**
All intake `user_visible_behavior`, `invariants`, `edge_cases`, `allowed_edit_surface`,
and `tests_to_add` items were checked against the diff and are satisfied. Targeted
test suites (74 tests) pass; `pnpm typecheck` clean; `ci:db-imports` strict audit passes.

## Findings table (≥80% confidence)

| severity | file:line | finding |
|---|---|---|
| — | — | None meeting the ≥80% confidence bar. |

## Verification evidence

### user_visible_behavior — all implemented
1. **Wedged health-check self-heals within one poll cycle** — `HealthAlertPoller.ts:57-84`
   wraps `runHealthChecks` in `withTimeout(30s)`; on `TimeoutError` calls
   `recycleHealthSql` (end+rebuild). Next cycle re-fetches via `getHealthSql`. Proven
   by `HealthAlertPoller.test.ts` "recycles the client on withTimeout expiry and the next
   cycle uses the fresh client" (CLIENT_A → CLIENT_B identity swap).
2. **Bulkhead onto dedicated client** — checks run on `getHealthSql(buildHealthClient)`,
   never the shared `sql`. `HealthAlertPoller` no longer imports `sql`. Test: "runs the
   checks on the dedicated health client, not the shared sql singleton".
3. **New reaper terminates marked wedge + warning log/finding** — `PoolWedgeReaperPoller.runSweep`
   (`:177-200`) → `terminateWedges`; each kill emits `logger.warn` + Sentry `warning`.
4. **No verified-direct route → disabled + Sentry warning, no crash, no pooler fallback** —
   `acquireVerifiedClient` three-way outcome; `disableWithAlert` on absent-URL or definitive
   pooler echo. Tests: "disabled (fail-safe) path" (3 cases).
5. **Staging mitigation revert** — `HEALTH_ALERT_POLL_INTERVAL_MS=86400000→300000` is a
   Railway runtime env var, tracked as a manual step in `…-handoff.md:109`; not a code
   change, correctly out of the diff.

### invariants — all upheld
- **Never terminates UNMARKED backend** — both `selectWedgeCandidates` (`reaper-query.ts:72`)
  and `terminateWedges` (`:113`) apply `query LIKE '/* rw-reapable */%'`. Marker contains no
  LIKE wildcards → exact prefix.
- **Anchored-prefix match** — `MARKER_PREFIX_PATTERN = '/* rw-reapable */%'`; the five health
  queries begin with the literal marker at `strings[0]` (verified by `health-alert-markers.test.ts`
  asserting `.startsWith(REAPABLE_MARKER)` on each of 5).
- **Atomic (pid, backend_start) revalidation** — single `terminateWedges` statement joins
  `pg_stat_activity` to `unnest(${pids}::int[], ${backendStarts}::timestamptz[])` AND re-checks
  the full signature (state/wait_event/age/marker/datname). Closes select→kill TOCTOU.
  `backend_start` carried as `::text` to preserve microsecond precision (deviation D2) — sound.
- **Per-sweep cap + dropped log** — `selectTerminations` caps + returns `droppedCount`; poller
  logs it (`:185-187`). fast-check property test: targets ⊆ input, |targets| ≤ cap, oldest-first.
- **Log-swallow never crashes worker** — every reaper/health catch logs and swallows;
  `recycleHealthSql`/`recycleReaperClient` bounded by `withTimeout`; `closeAllPostgresClients`
  uses `Promise.allSettled`.
- **Dedicated clients via server factory + closed in shutdown** — both built via
  `createDedicatedPostgresClient`; `closeDb: () => closeAllPostgresClients([closeReaperClient, closeHealthSql])`
  (`worker/index.ts:597`). `ci:db-imports` strict passes (helper `health-db.ts` receives injected
  builder per deviation D4).
- **Reaper only on runtime-verified-direct route (incl. F1/F2)** — unified `acquireVerifiedClient`
  used at boot AND every re-acquire; `recycleReaperClient` ends+nulls without rebuild so the next
  tick re-verifies (F2). Transient verify error defers, does not permanently disable (F1). Tests
  F1, F2(a), F2(b) cover all three lifecycle points.

### edge_cases — all handled
- Supavisor app_name flattening → identity via query-comment marker, not app_name (ADR 0007 present).
- Age keys on `state_change`, not `query_start` (`reaper-query.ts:65,71`).
- Multiple wedges → cap + oldest-first (`selectTerminations` sort `b.ageS - a.ageS`).
- No verified-direct URL → disabled + Sentry (init + poll guards).
- `end()` FIN not guaranteed → `recycleHealthSql` rebuilds UNCONDITIONALLY in `finally`
  (health-db.test: rebuilds even when end() rejects / hangs).
- Already-gone tuple tolerated → `terminateWedges` empty/`terminated:false` result (reaper-query.test).
- Overlapping terminate harmless → idempotent revalidating statement.

### Drift / scope
- No file touched outside `allowed_edit_surface`.
- `src/lib/db/server.ts` refactors the shared `sql` options into `BASE_POSTGRES_OPTIONS`; the
  singleton's effective options are byte-identical to before (prepare:false, idle_timeout:30,
  max_lifetime:1800, connect_timeout:10, statement_timeout:30_000, max:readPoolMax()). Pure refactor.
- No behavior added outside `user_visible_behavior`.
- No `tests_to_add` item missing; all are real behavior tests (not mock-tautologies) — the
  marker test asserts the actual query prefix, the property test asserts the cap/ordering
  invariants, the recycle tests assert client-identity swaps.

## Low-confidence appendix (below the ≥80% bar — NOT bugs)

- **Int-truncation at the age boundary (`select-terminations.ts:52`).** `ageS` is
  `EXTRACT(EPOCH ...)::int` (truncated), and the pure re-filter uses `ageS > ageThresholdS`,
  strictly stricter than the SQL's exact-interval filter. A backend at e.g. 300.7s (threshold
  300) is included by the SQL but dropped by the pure re-filter for that cycle. This is
  defense-in-depth being *conservative* — it never causes a wrong/extra kill, only a ≤1-cycle
  delay at the exact boundary second. Behaviorally harmless; noting for completeness.
- **Reaper is default-ON and permanently disables + fires a Sentry `warning` on every worker
  boot that lacks a genuine direct `:5432` route** (only pooler `DATABASE_URL` present →
  app_name echoes 'Supavisor' → definitive 'pooler' → permanent disable). This is the
  *specified* fail-safe, but it means the backstop is inert (and noisy at boot) until an
  operator configures `DIRECT_URL` to a real direct route. Operational/deployment concern,
  not a code defect — flag to the coordinator so `DIRECT_URL` is set on the staging/prod worker.
- **`terminateWedges` omits a `backend_type='client backend'` re-check** that the candidate
  SELECT has. Harmless: the exact `(pid, backend_start)` join + marker already pins the target
  to a marked client backend. No correctness impact.

## Intake fields verified clean
`goal`, `non_goals`, `user_visible_behavior` (5/5), `invariants` (9/9), `edge_cases` (8/8),
`allowed_edit_surface` (no drift), `tests_to_add` (6/6 present + genuine). Deviations D1–D7
verified correctly implemented (unnest-join terminate, text timestamptz round-trip, injected
`buildClient`, `closeAllPostgresClients` seam, logged recycle, unified three-way `acquireVerifiedClient`).
