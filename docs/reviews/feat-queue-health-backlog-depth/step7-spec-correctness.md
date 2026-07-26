# Step 7 — Spec & Correctness Review — feat-queue-health-backlog-depth (#480)

Read-only review of `git diff main...HEAD` against `.feature/intake.json`, field by field.

## Verdict

The branch faithfully implements the intake contract and ticket #480. Every
`user_visible_behavior`, `invariant`, `edge_case`, and `tests_to_add` item is
satisfied. One low-severity `allowed_edit_surface` drift (a review-artifact
file), no correctness defects.

## Field-by-field verification

### goal
Backlog depth (total pending count) exposed in `GET /internal/queue-health` +
per-table HealthAlertPoller warning at the ~1500 target. Both delivered:
- Endpoint: `worker/internal/queue-health.ts:101-116` adds `backlog` to the 200 body.
- Alert: `worker/background/pollers/health-alert/checks.ts:160-173` `checkBacklogDepth`, wired at `runHealthChecks` (`checks.ts:187-192`).

### non_goals — all respected
- No drain-rate change (observability only). ✓
- No `src/app`/`src/components` edits — none in diff. ✓
- No migration/schema change — none in diff; count reuses `idx_jo_pending` / `idx_analytics_events_pending`. ✓
- No un-pausing of HealthAlertPoller — only the check is wired; poller start unchanged. ✓
- Per-table independent findings, no combined sum — `BACKLOG_DEPTH_TABLES.filter(...).map(...)` yields independent findings. ✓
- No new *required* env var — `HEALTH_ALERT_BACKLOG_DEPTH_THRESHOLD` is `rawOpt` (`src/lib/config/worker.ts:128`) with a 1500 default. ✓

### user_visible_behavior — all present
1. Additive `backlog:{job_outbox,analytics_events}` sibling of `queues`; null on timeout/error; `queues` always returned. ✓ (`queue-health.ts:110-116`)
2/3. `backlog_depth:job_outbox` / `backlog_depth:analytics_events` warning keys > threshold. ✓ (`checks.ts:167`)
4. `HEALTH_ALERT_BACKLOG_DEPTH_THRESHOLD` default 1500. ✓ (`checks.ts:44`)

No behavior outside this list — no scope creep.

### invariants — all satisfied
- **Total pending semantics** — `WHERE status = 'pending'`, no `available_at` filter, both tables. ✓ (`backlog-depth.ts:37-38`)
- **Single owner** — `queryBacklogDepth(sql)` is the only count SQL; consumed by both the endpoint (`worker/index.ts:477`) and the check (`checks.ts:161`). No duplicated count SQL. ✓
- **Domain module / invariant #15** — `backlog-depth.ts` takes `sql: postgres.Sql`, imports only `import type postgres`; never `@/lib/db/server`. Composition root `worker/index.ts:477` passes the singleton. ✓
- **Invariant #12 (DI, unit-testable)** — `getBacklogDepth` added to `QueueHealthDeps`; handler testable with a stub, no DB/queue boot. ✓
- **Auth unchanged / no PII** — 503-on-unset / 401-on-bad-bearer logic untouched; body carries only integer counts. ✓
- **Severity = warning** — `level: 'warning'` on both the finding and the error-degrade finding. ✓
- **No-additive-wait / concurrent start / no unhandled-rejection window** — `backlogResult` (timed + `.catch`) built at `queue-health.ts:101-108` BEFORE the sequential loop; `await backlogResult` after reads an already-settled value. ✓
- **Bound the DB op (F-high)** — `queryBacklogDepth` runs `SET LOCAL statement_timeout = 4000` inside `sql.begin()` so Postgres cancels and releases the pooled connection; the endpoint `withTimeout(4000)` only bounds the WAIT. Both 4s, under the consumer's 5s AbortSignal. ✓ (`backlog-depth.ts:31-44`)
- **Isolate check failure (F-medium)** — `checkBacklogDepth(sql,cfg).catch(...)` in the `Promise.all` degrades to a `health_check_error:backlog_depth` warning; cannot reject the batch and suppress critical checks. ✓ (`checks.ts:187-192`)
- **Best-effort endpoint degrade** — `.catch(() => null)` → `backlog: null`, `queues` always sent. ✓
- **Additive/backward-compatible** — consumer `src/app/api/admin/jobs/route.ts:162-169` reads only `body.queues`; new sibling `backlog` key is ignored. ✓

### edge_cases — all handled
- Zero rows → 0, no finding (strict `>`). ✓ (tested: under-threshold)
- Exactly at threshold → no finding. ✓ (`checks.test.ts` "returns no finding at the threshold (strict >)")
- 1000 < 1500 burst headroom → no fire (threshold logic). ✓
- bigint → `::int` cast. ✓
- Threshold unset/invalid/negative → 1500 via `num()` `>= 0` guard (`checks.ts:29-31`). ✓
- Poll-cycle DB error → surfaces to isolated `.catch` (does not wedge single-flight poller). ✓
- Slow/failed endpoint count → 4000ms `withTimeout` → `backlog: null`, warn log, `queues` returned. ✓

### tests_to_add — all present
1. `queryBacklogDepth` SQL semantics pin — `status='pending'` ×2, `::int`, no `available_at`. ✓ (`backlog-depth.test.ts:68-83`)
2. `checkBacklogDepth` per-table over-threshold, keys, independence. ✓ (`checks.test.ts` describe block)
3. Threshold override + 1500 default. ✓ ("backlog-depth threshold config")
4. Handler 200 `backlog`, 503/401, `getBacklogDepth` not called on disabled/unauthorized. ✓ (`queue-health.test.ts:58-134`)
5. Handler degrade-to-null on reject AND timeout, `queues` present. ✓ (`queue-health.test.ts:136-189`)
6. `runHealthChecks` aggregation includes `backlog_depth:*` reaching output. ✓ (`checks.test.ts` "aggregates findings across all checks") + F-medium isolation aggregation test.

### verification_commands
`pnpm build` — not executed (read-only review); logic + types inspected and consistent (`sql.begin(...) as Promise<BacklogDepth>` cast, typed `tx<{...}[]>` template).

## Findings

### HIGH confidence (>=80%)

| severity | file | finding |
|---|---|---|
| low | docs/reviews/feat-queue-health-backlog-depth/step6-adversarial-triage.md | Touched file (15-line review artifact) is not covered by any `allowed_edit_surface` glob — `docs/reviews/**` is not listed. Objective drift outside the contract surface, though it is a review-workflow artifact with no runtime impact. |

## Low-confidence appendix

- `backlog-depth.test.ts` "pins SQL semantics" reads `mockSql.mock.calls[0][0]` as the SELECT but does not explicitly assert exactly ONE tagged-template invocation (the SET LOCAL routes through `.unsafe`, so the assumption holds today). `tests_to_add` #1 phrased it as "asserts a SINGLE tagged-template invocation." Semantics ARE pinned; the count-of-calls assertion is implicit rather than explicit. Not a defect — noted for completeness.
- "starts the backlog read BEFORE the first getQueueCounts await" asserts `callOrder[0]==='backlog'` (invocation order), which proves the promise is created pre-loop but not literal wall-clock overlap. Adequate as wiring proof.
- Poller path now caps `queryBacklogDepth` at 4s server-side (via the shared `SET LOCAL`), stricter than the poller's 30s budget — an intentional tightening, not a regression.
