# Plan — #480 queue-health backlog depth + alert (observability half)

Ticket **#480** · wayfinder map **#472** · RISK=high · SURFACE=backend · db_touching=false
Intake contract (authoritative): `.feature/intake.json`

## Glossary (CONTEXT.md — used verbatim)

- **Capacity target** (#474): 250 locations @ 6mo, ~125 reviews/day, **a 1000-event/10-minute ingest burst drained within 30 minutes**, peak 10 concurrent dashboard renders.
- **Outbox job**: follow-up work in `job_outbox`, dispatched to BullMQ by OutboxPoller.
- **NEW — Backlog depth**: the count of `status='pending'` rows in a dispatch queue table (`job_outbox`, `analytics_events`). A saturation signal for the Capacity target. To be added to CONTEXT.md in T4.
- **NEW — Backlog depth alert threshold**: the per-table pending-row count (`HEALTH_ALERT_BACKLOG_DEPTH_THRESHOLD`, default **1500**) above which HealthAlertPoller emits a `warning`.

## Design decisions (locked)

- Backlog depth = `COUNT(*) WHERE status='pending'` — **total** pending (incl. not-yet-due retries), identical for both tables.
- Single owner `queryBacklogDepth(sql)` feeds **both** the endpoint and the alert — no duplicated count SQL.
- Per-table independent findings, same 1500 threshold. Severity `warning`.
- Endpoint response gains an **additive** top-level `backlog` key (separate data source from `queues`). Backlog is **best-effort**: bounded by a 4000ms client-side `withTimeout` (< the consumer's 5s deadline) and degrades to `backlog: null` on error/timeout — it never takes down the `queues` signal (orthogonality).
- No migration (partial pending indexes exist: `idx_jo_pending` m001, `idx_analytics_events_pending` m046). No new *required* env var → no config-coverage baseline bump.

## Module shape

```ts
// src/lib/shared/backlog-depth.ts  (deep module, single owner)
export const BACKLOG_DEPTH_TABLES = ['job_outbox', 'analytics_events'] as const;
export type BacklogTable = (typeof BACKLOG_DEPTH_TABLES)[number];
export type BacklogDepth = Record<BacklogTable, number>;
export async function queryBacklogDepth(sql: Sql): Promise<BacklogDepth>;
//   one round-trip: SELECT (subcount) AS job_outbox, (subcount) AS analytics_events
```

## Tasks (tracer bullets)

### T1 — shared backlog-depth query module  [blocks: T2, T3]
- `src/lib/shared/backlog-depth.ts`: `BACKLOG_DEPTH_TABLES`, `BacklogTable`, `BacklogDepth`, `queryBacklogDepth(sql)`.
  - Single one-round-trip query, two scalar subqueries, `::int` casts, `status='pending'` predicate.
  - Domain module: `sql` is an explicit param; never imports `@/lib/db/server` (inv #15).
- `src/lib/shared/__tests__/backlog-depth.test.ts`: mocked `sql` tagged-template returns a single row → asserts `{ job_outbox, analytics_events }`. **Pins SQL semantics** (F3): assert exactly ONE tagged-template call; the joined query text contains `status = 'pending'` and `::int` for both tables and does **NOT** contain `available_at` (total-pending, not claimable).
- Gate: `pnpm test -- backlog-depth`, `pnpm ci:db-imports`.

### T2 — alert half (HealthAlertPoller check)  [blocks: T4] [needs: T1]
- `src/lib/config/worker.ts`: add `HEALTH_ALERT_BACKLOG_DEPTH_THRESHOLD: rawOpt`.
- `health-alert/checks.ts`:
  - `HealthAlertConfig.backlogDepthThreshold`; `resolveHealthAlertConfig` → `num(cfg.HEALTH_ALERT_BACKLOG_DEPTH_THRESHOLD, 1500)`.
  - `checkBacklogDepth(sql, cfg): Promise<HealthFinding[]>` — calls `queryBacklogDepth`, iterates `BACKLOG_DEPTH_TABLES`, emits a `warning` finding per table where `depth > threshold`; key `backlog_depth:<table>`; detail `{ table, count, threshold }`.
  - Register in `runHealthChecks` `Promise.all` (this is what makes it fire when #500 resumes the poller — no extra gating).
- `health-alert/__tests__/checks.test.ts`: over/at/under threshold; per-table independence (one over → exactly one finding); env override + 1500 default; keys/level. **(F2)** Extend the existing `runHealthChecks` aggregation test with an over-threshold backlog result and assert a `backlog_depth:<table>` key appears in the aggregated findings (proves the wiring, not just the standalone check).
- Gate: `pnpm test -- checks`.

### T3 — observability half (endpoint)  [blocks: T4] [needs: T1]
- `worker/internal/queue-health.ts`:
  - `QueueHealthDeps.getBacklogDepth: () => Promise<BacklogDepth>`.
  - On the **authorized** path only, compute backlog **best-effort** (F1). **Build the timed-AND-caught promise BEFORE the loop (F5+F8)** so both the timeout clock and the rejection handler are live during queue collection:
    ```ts
    const backlogResult = withTimeout(
      deps.getBacklogDepth(), BACKLOG_ENDPOINT_TIMEOUT_MS /* 4000 */, 'queue-health-backlog',
    ).catch((err) => { logger.warn('queue-health backlog unavailable', toError(err)); return null; });
    for (const name of ALL_QUEUE_NAMES) queues[name] = await deps.getQueueCounts(name);
    const backlog = await backlogResult; // already settled → adds no extra wait
    ```
    The 4000ms timer starts BEFORE the sequential `getQueueCounts` loop (budget overlaps collection, never additive), and `.catch` is attached immediately (no unhandled-rejection window if the raw promise rejects mid-loop). `queues` is always returned. 200 body: `{ queues, backlog }` where `backlog: BacklogDepth | null`. Not called on 503/401 paths.
    - `withTimeout` from `src/lib/shared/with-timeout` (same helper the poller uses); 4000ms < the consumer's 5s `AbortSignal.timeout` deadline so the endpoint returns (degraded) before the consumer aborts. `withTimeout` bounds the **wait**, not the DB op (F6) — a timed-out count detaches, still bounded by the normal-case 30s server-side `statement_timeout` (accepted limitation, same as the poller).
- `worker/index.ts`: wire `getBacklogDepth: () => queryBacklogDepth(sql)` (composition root passes the singleton; the timeout/degrade lives in the handler so the module stays DI-testable).
- `worker/internal/__tests__/queue-health.test.ts`: 200 includes `backlog` from stubbed dep; **rejecting dep → 200 with `backlog:null` + `queues` present**; **hanging dep + queue collection delayed past 4000ms (fake timers) → 200 with `backlog:null` and NO extra wait beyond the delayed queue loop** (proves the timeout clock overlapped collection, F8); `getBacklogDepth` is invoked BEFORE the queue-count loop starts (concurrent-start proof); 503/401 unchanged and `getBacklogDepth` NOT invoked on those paths.
- Gate: `pnpm test -- queue-health`.

### T4 — docs + glossary  [needs: T2, T3]
- `CONTEXT.md`: add **Backlog depth** + **Backlog depth alert threshold** terms.
- `.claude/reference/env-vars.md`: add `HEALTH_ALERT_BACKLOG_DEPTH_THRESHOLD` (default 1500) row.
- `.env.example`: commented example line alongside the other `HEALTH_ALERT_*`.
- `docs/runbooks/beta-launch-alerting.md` §5: document the new signal + the #474 burst verification (1000 < 1500 headroom → no alert; depth drains in 30 min).
- Gate: full verify gate.

## Blocking-edge graph
```
T1 ──▶ T2 ──▶ T4
  └──▶ T3 ──▶ T4
```
T2 and T3 are independent after T1 (parallelizable subagents).

## Verification
- Full gate: `scripts/verify-gate.sh` (lint, typecheck, `pnpm test`, all `ci:*` audits) + `pnpm build` as an intake `verification_command` (verify-gate skips build for a backend surface, but the user's AGENTS.md requires `pnpm build` before claiming behavior-affecting work complete — so we run it explicitly). The manual staging smoke is NOT a `verification_command` (a prose entry would be run through `bash -c` and fail the gate) — it lives in `staging_verification`.
- Staging smoke (ride-staging, step 8; `staging_verification` in intake, NOT a gate command): #474 synthetic burst — 1000 ingest events / 10 min → `/internal/queue-health` `backlog.job_outbox` climbs then drains to baseline within 30 min; **no** `backlog_depth` warning fires (headroom).
