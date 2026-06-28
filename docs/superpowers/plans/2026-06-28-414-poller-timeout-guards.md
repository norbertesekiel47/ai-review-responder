# Plan — #414: Timeout guards for all background loops

Branch: `fix/414-poller-timeout-guards`

## Problem

Only 4 of ~20 background loops bound a cycle with `withTimeout`
(`OutboxPoller`, `StripeLocationsReconcilePoller`, `HealthAlertPoller`,
`ZernioRecentReviewPoller`). The rest have a single-flight flag
(`isPolling`/`inProgress`) but **no client-side deadline**: a cycle that hangs
on a stale pooled connection (root cause #413) where the server-side
`statement_timeout` never fires will leave the cycle pending forever, pin the
single-flight flag, and silently disable every future tick of that loop.

## Approach (surgical)

One shared helper, `worker/background/guarded-poll.ts`, OWNS the entire repeating
scaffolding — single-flight flag, per-cycle `withTimeout` deadline, the interval
timer, the initial run, error containment, and `stop()` — so each loop stops
re-implementing start/stop/single-flight (that boilerplate was duplicated across
~13 files). Crucially, each loop's **actual work function is left in place** (not
extracted or renamed); only its hand-rolled scaffolding is replaced with a
`createGuardedPoll(...)` call. This keeps every per-loop diff small and keeps the
(pre-existing) cycle-function complexity an *inherited* finding that fallow's
`new-only` gate excludes — no new complexity, no duplicated boilerplate clone.

### Helper

```ts
createGuardedPoll(
  runCycle: (logger: WorkerLogger) => Promise<unknown>,
  options: {
    timeoutMs: number;                 // hard per-cycle deadline (> legit max, < interval)
    label: string;                     // '[XPoller]' — withTimeout label + default logger prefix
    intervalMs: number | (() => number); // resolved at start() (env-tunable loops pass the getter)
    logger?: WorkerLogger;             // reuse a module logger (schedulers); else createWorkerLogger(label)
    onSkipMessage?: string;            // .log on single-flight skip; omit = silent
    onErrorMessage?: string;           // .error on throw/timeout; default 'Poll cycle failed'
  },
): { runOnce(): Promise<void>; start(onStart?): void; stop(): void }
```

- `runOnce` — single-flight + `withTimeout(runCycle, timeoutMs)` + catch→log +
  `finally` reset. **The flag is released in `finally` after `withTimeout`
  settles**, so a timed-out cycle frees the flag (the #414 fix) instead of
  wedging it. Never rejects.
- `start(onStart?)` — idempotent (`timer !== null` guard, which also survives a
  falsy mocked `setInterval` handle). Fires `onStart` exactly once (the loop's
  bespoke "Starting" line), runs `runOnce` immediately, then on each interval.
- `stop()` — clears the timer and logs `'Stopped'`; idempotent + safe before
  `start()`.

The 4 pre-existing guards keep their bespoke variants (token overlap guard /
AbortController / Sentry-cron check-in / env-tunable watchdog) — behavior this
helper intentionally does not model.

### Per-loop application

**Helper (`createGuardedPoll`), 13 loops** — exported `start*`/`stop*` keep the
same names/signatures (so `worker/index.ts` is untouched); they now delegate to
`guard.start(onStart)` / `guard.stop()`. The work function stays in place; only
its single-flight wrapper (`if (isPolling) return; isPolling = true; … finally {
isPolling = false }`) is removed:
- 5 offboarding pollers (`AccessEnd`, `Purge`, `PurgeReminder`,
  `ReactivationReset`, `TeardownRetry`) — `runXOnce` (the single-flight wrapper)
  becomes `export const runXOnce = guard.runOnce`; the inner `runXInner` is
  untouched; the enablement gate moves into the tiny `runCycle` closure.
- 4 inline pollers (`Archival`, `CancellationGrace`, `EngagementMonitor`,
  `NotificationFailover`) — the inline cycle keeps its body + internal try/catch
  verbatim; single-flight is dropped (helper owns it).
- 4 schedulers (`WeeklySummary`, `MonthlyImpact`, `RankingTracking`,
  `OnboardingDrip`) — `checkAndSchedule`/`runRankingCheck` keep their body +
  internal catch (and the `fallow-ignore-next-line complexity` markers on the two
  with one); single-flight dropped.

**Minimal `withTimeout` wrap (bespoke contract preserved, NOT the helper), 3
loops** — these have single-flight contracts the generic helper does not model,
so only the inner call is wrapped:
- `AnalyticsDispatchPoller` — promise-returning single-flight (`activeRun`) that
  `stop()` awaits to drain; `withTimeout(dispatchOnce(), …)`.
- `EmailChannelReconcilePoller` — `runOnce` returns a result + propagates errors;
  `withTimeout(runOnceInner(logger), …)`.
- `CleanupAbandonedSignupsPoller` — `runOnce` propagates errors;
  `withTimeout(runOnceInner(logger), …)`.

## Per-loop timeout / interval table

Constraint: `timeoutMs > legitimate max cycle` AND `timeoutMs < interval`.
Timeouts are plain module consts (matches `HEALTH_CHECK_TIMEOUT_MS`).

| Loop | Interval | Timeout | Legit max cycle (why timeout is safe) | Mechanism |
|---|---|---|---|---|
| AnalyticsDispatchPoller | 30s | **20s** | in-memory capture of ≤250 events + 1 PostHog flush → seconds | minimal wrap |
| AccountOffboardingAccessEndPoller | 60s | **45s** | batched claim+enqueue (≤100 small txns) → seconds | helper |
| AccountOffboardingPurgePoller | 60s | **45s** | claim+enqueue only (heavy purge runs in the teardown worker) → seconds | helper |
| AccountOffboardingPurgeReminderPoller | 60s | **45s** | claim+notify enqueue → seconds | helper |
| AccountOffboardingReactivationResetPoller | 60s | **45s** | claim+reset → seconds | helper |
| AccountOffboardingTeardownRetryPoller | 60s | **45s** | claim+re-enqueue → seconds | helper |
| EmailChannelReconcilePoller | 10m | **5m** | ≤1000 serial INSERTs, normally light | minimal wrap |
| WeeklySummaryScheduler | 1h | **10m** | business scan + outbox insert loop → seconds | helper |
| MonthlyImpactScheduler | 1h | **10m** | business scan + outbox insert loop → seconds | helper |
| RankingTrackingScheduler | 1h | **10m** | candidate scan + outbox insert loop → seconds | helper |
| OnboardingDripScheduler | 1h | **10m** | due-drip scan + outbox insert loop → seconds | helper |
| NotificationFailoverPoller | 2h | **30m** | ≤200 rows × ≤2 admin emails (~7m worst) | helper |
| ArchivalPoller | 24h | **30m** | 6 batched DELETEs (LIMIT 5000 each) → minutes | helper |
| EngagementMonitorPoller | 24h | **30m** | one metrics CTE + per-business insert loop → minutes | helper |
| CancellationGracePoller | 24h | **30m** | expired-account scan + per-account soft-archive tx → minutes | helper |
| CleanupAbandonedSignupsPoller | 24h | **60m** | default batch 100 × 10s deleteUser cap = ~16m worst; 60m leaves margin | minimal wrap |

Tightest margins: Analytics (20s < 30s) and offboarding (45s < 60s) — both have
sub-second-to-seconds legit cycles, so the deadline only ever trips on a true
hang. Cleanup's ~16m legit worst-case drove its larger 60m deadline.

## Tests

- `worker/background/__tests__/guarded-poll.test.ts` — comprehensive unit test of
  the helper: `runOnce` (cycle + logger passthrough; single-flight skip silent &
  with message; **hung cycle bounded, logs `onErrorMessage`, flag resets so the
  next tick runs** — the core regression; in-time cycle does not trip; thrown
  cycle caught + reset; default-logger fallback) and `start`/`stop` (initial run +
  single interval; idempotent start; function-`intervalMs` resolved at start;
  stop clears + logs `'Stopped'`; safe-before-start; falsy `setInterval` handle).
- Representative per-loop guard regression in
  `AccountOffboardingAccessEndPoller.test.ts`: a hung cycle is bounded within
  `timeoutMs`, logs, and the next `runOnce` executes (flag released). The two
  "starts only one timer" timer-count tests drain the initial cycle's deadline
  timer with `advanceTimersByTimeAsync(0)`.

## Verify gate

`pnpm ci:fallow` (No issues — no new complexity/duplication; pre-existing
cycle-function complexity stays an inherited/excluded finding), `pnpm lint`,
`pnpm typecheck`, `pnpm test` (full suite). Worker-only, no schema/query change.
The `SUBSCRIPTION_STATUS_LITERAL_ALLOWLIST` line refs for the 4 loops whose SQL
predicates shifted were updated in lockstep.
