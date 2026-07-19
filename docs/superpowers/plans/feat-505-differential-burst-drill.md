# Plan — feat-505-differential-burst-drill

Ticket-seeded `/feature` run for the two open **#505** remainders on wayfinder
map **#472**. Intent locked at map level; this plan covers the deltas only.

- Intake contract: `.feature/intake.json`
- Deviations / environment notes: `docs/superpowers/plans/feat-505-differential-burst-drill-deviations.md`
- Glossary (shared language, use terms verbatim): `CONTEXT.md`
- Parent obligation: issue **#505** obligation-status comment (remainders 1 & 3);
  remainder 2 (24h soak) is **#507**, out of scope.

## What "done" means (from the #505 obligation comment)

1. **(remainder 1) Checked-in differential experiment** that isolates
   Promise.all-vs-sequential on the **health bundle** and **reproduces the
   connection wedge on the baseline arm**. The merged `scripts/wedge-repro.ts`
   toggles `BOOT_STAGGER_ENABLED` — the wrong variable (the PR itself says
   boot-stagger is not the cause). The proven cause (off-repo differential, see
   `fix-505-pool-wedge-rootcause-deviations.md:211`) is: `runHealthChecks` firing
   its 6-query mix via `Promise.all` on the `max:2` bulkhead client over the
   Supavisor **transaction pooler** pipelines overflow queries onto shared
   connections → a pipelined response parks permanently in `ClientRead`.
   Off-repo result to reproduce in-repo: **concurrent-max2 6/6 wedged,
   sequential-max2 0/6, concurrent-max6 0/6**.
2. **(remainder 3) Synthetic-load script + executed #480 capacity-burst drill**
   on staging with recorded numbers: a **headroom arm** (1000 ingest events /
   10 min → **backlog depth** drains ≤30 min, **no** `backlog_depth` alert) and
   an **over-threshold arm** (inject past the **backlog depth alert threshold**
   ~1500 → `backlog_depth:job_outbox` fires → drains → clears).

## Design framing (codebase-design)

Two facts are today **buried and single-copied inside `scripts/wedge-repro.ts`**
and are about to get a second + third consumer. Per one-authoritative-owner,
extract them into small deep modules rather than re-copy:

- **Staging safety gate** — `assertStagingTarget` + `PROD_PROJECT_REFS` denylist +
  `describeConnectionTarget`. Security-critical; every staging script that boots
  a worker / terminates backends / injects rows must share ONE owner. →
  `scripts/staging-guard.ts`.
- **Wedge signature** — the `state=active AND wait_event='ClientRead'` query +
  `sampleWedged` / `terminateBackend` / `OBSERVER_APP_NAME`. "What a wedge looks
  like" and "how we kill one" must have one owner shared by the boot-repro
  harness and the query-level differential. → `scripts/wedge-observer.ts`.

Reused production seams (imported, **never edited** — invariant: no runtime
change): the exported `checkXxx` functions in
`worker/background/pollers/health-alert/checks.ts` (the **query mix** — single
owner) and `queryBacklogDepth` in `src/lib/shared/backlog-depth.ts` (the
**backlog depth** count — single owner). The differential proves the wedge with
its OWN concurrent client; it never reverts the shipped sequential
`runHealthChecks`.

`scripts/wedge-repro.ts` stays the **boot-readiness** harness (it drives real
worker boots + `BOOT_STAGGER_ENABLED`); the new differential is a distinct,
smaller tool that issues the health-bundle queries directly — no worker boot.

## Tracer-bullet tasks

Each task is a thin end-to-end slice, stays inside `allowed_edit_surface`, uses
glossary terms verbatim, and is TDD'd on its pure helpers (mirroring
`scripts/ci/__tests__/wedge-repro.test.ts`, which tests the guard + arg parsing +
cleanup ordering, NOT the live DB path). No migration; `db_touching=false`. No
`fast-check` property tests required (feature touches neither billing nor
approval/escalation state machines).

### T1 — Extract shared staging modules from `wedge-repro.ts`  ·  [no blockers]

- New `scripts/staging-guard.ts`: move `PROD_PROJECT_REFS`, `KNOWN_STAGING_REF`,
  `assertStagingTarget`, `describeConnectionTarget` out of `wedge-repro.ts`.
- New `scripts/wedge-observer.ts`: move `OBSERVER_APP_NAME`, the wedge-signature
  `sampleWedged`, `sampleAllPids`, `terminateBackend`.
- `scripts/wedge-repro.ts`: delete the moved defs, import from the two modules.
  Everything else (trial/boot orchestration, `runEmergencyCleanup`, summary)
  untouched.
- Tests: new `scripts/ci/__tests__/staging-guard.test.ts` (prod-denylist beats
  every flag; ref must be present in target; empty/absent confirm rejected; no
  password surfaces) — carried over from the wedge-repro guard tests.
  `wedge-repro.test.ts` keeps covering wedge-repro's own pure logic and now
  imports the guard from the new module.
- **Green:** the extracted-guard tests + the existing `wedge-repro.test.ts` +
  typecheck all pass — proves the refactor preserved behavior end-to-end.

### T2 — `scripts/health-bundle-differential.ts` (the differential)  ·  [blocked by T1]

Three-arm, N-iteration (default 6) differential, invoked operator-style like
wedge-repro:
`railway run --environment staging --service repworth-worker -- pnpm tsx scripts/health-bundle-differential.ts --confirm-staging <ref> [--iterations N]`.

- Safety: `assertStagingTarget` on the worker pool URL (the client that wedges)
  AND the observer URL (runs `pg_terminate_backend`) — from `staging-guard.ts`.
- Arms (each on its OWN dedicated client via `createDedicatedPostgresClient`):
  - `concurrent-max2`: fire the 6 exported `checkXxx` via **`Promise.all`** on a
    `max:2` client → EXPECT wedge (baseline reproduces).
  - `sequential-max2`: fire them **sequentially** on a `max:2` client → EXPECT
    clean (the shipped cure).
  - `concurrent-max6`: fire them via `Promise.all` on a `max:6` client → EXPECT
    clean (proves it's the pool-size×mix pipelining, not concurrency alone — the
    control that distinguishes this from #500's falsified count>max hypothesis).
- The 6 checks are the real query mix: `checkFailedOutboxByTopic`,
  `checkOldestPendingOutbox`, `checkStaleDispatching`, `checkOpenFlaggedResponses`,
  `checkZeroDeliveryNotifications`, `checkBacklogDepth`. A throwaway
  `HealthAlertConfig` literal is fine (thresholds gate finding emission, not
  whether the QUERY runs — the query mix is what wedges).
- Observe via a SEPARATE direct observer connection (`wedge-observer.ts`):
  attribute only backends new-since-arm-start with the wedge signature to that
  arm; `pg_terminate_backend` every attributed backend on every exit path (incl.
  SIGINT/SIGTERM) — resource-ownership contract carried from wedge-repro.
- Exit code gates the expected outcome: non-zero if `concurrent-max2` did NOT
  wedge (repro failed) OR if either cure arm DID wedge (regression) OR any
  attributed backend survived cleanup. A per-arm non-repro is reported honestly.
- Pure/testable helpers (the tests): arm-outcome classification (wedged?/count),
  expected-vs-actual gating, wedge attribution set math, arg parsing/bounds.
- **Green:** `health-bundle-differential.test.ts` + typecheck.

### T3 — `scripts/burst-drill-load.ts` (synthetic-load injector)  ·  [blocked by T1]

Parametrized injector for the capacity-burst drill:
`railway run --environment staging --service repworth-worker -- pnpm tsx scripts/burst-drill-load.ts --events N --duration-min M --confirm-staging <ref> [--batch-size B]`.

- Safety: `assertStagingTarget` on the inject target (`staging-guard.ts`).
- Injection mechanism resolved in **deviations D1** (Explore spike): topic
  **`stripe_subscription_mirror_sync`**, `aggregate_type='account'`, fresh
  `uuidv7()` id, random non-existent `aggregate_id`, `payload = {account_id,
  __drill:<tag>}` via `sql.json()` (never `${JSON.stringify}::jsonb`). DB-only
  handler → drains at claim, no LLM/external spend, ends `completed` never
  `failed`, trips none of the failed/stale-dispatching health checks. Postgres.js
  client sets `statement_timeout: 30_000`.
- **Two modes** (drain is CLAIM-bound ~600/min, so a burst self-drains in ~3 min
  and would slip between 5-min poller ticks — hence the future-dated hold for the
  alert arm):
  - `inject --available-in-min 0` (default, **headroom arm**): 1000 immediately-
    claimable rows paced over 10 min → drains ≤30 min, no alert.
  - `inject --available-in-min <K>0>` (**over-threshold arm**): ~1600 **future-
    dated** rows that persist as `pending` (backlog_depth counts them) but the
    poller won't claim → backlog holds >1500 across a poller tick →
    `backlog_depth:job_outbox` fires. Then `release --drill-tag <tag>` DELETEs
    **only** `topic=... AND payload->>'__drill'=<tag> AND status='pending'` →
    backlog clears → alert clears. Scoped-delete predicate is safety-critical.
- Pacing: pure `computeInjectionSchedule(events, durationMin, batchSize)` → an
  ordered list of `{ batchCount, delayMsAfter }` spreading N rows across M
  minutes (sub-minute precision is not the point).
- Progress: optionally poll `queryBacklogDepth` (single owner) between batches to
  log the pending climb — counts only, never row content.
- Pure/testable helpers (the tests): `computeInjectionSchedule` math (N over M,
  remainder handling, batch bounds), arg parsing/bounds (positive ints, sane
  caps), the row-shape builder, safety-gate wiring.
- **Green:** `burst-drill-load.test.ts` + typecheck.

### T4 — Docs reconciliation + glossary  ·  [blocked by T2, T3]

- `CONTEXT.md`: coin **Health-bundle differential** (the three-arm
  concurrent-vs-sequential × pool-size isolation reusing the real query mix) and
  **Capacity-burst drill** (with **headroom arm** = 1000 events, stays under
  threshold, proves drain + no-false-alarm; **over-threshold arm** = injects past
  the backlog depth alert threshold, proves the alert fires and clears).
- `docs/runbooks/pool-wedge-burst-drill.md`: replace the single-arm "stays under
  1500, no alert" framing with the **two-arm** procedure (headroom + over-
  threshold), referencing `scripts/burst-drill-load.ts`, and add an empty
  **Results (executed <date>)** section for T5 to fill. Add the differential's
  invocation + expected 3-arm outcome (cross-link to `health-bundle-differential.ts`).
- `docs/runbooks/beta-launch-alerting.md` §4: reconcile the two bullets so
  "Backlog depth over threshold" and "#474 capacity burst (headroom)" both point
  at `burst-drill-load.ts` and the map's "fires at ~1500 and clears" maps to the
  over-threshold arm.
- `.claude/reference/lab-notes.md`: the pipelining finding is already noted; add
  only a one-line pointer to the checked-in differential harness if missing.
- **Green:** standard gate (lint/typecheck/test + all `ci:*` audits); docs-only
  changes carry no new code path.

### T5 — EXECUTE on staging (post-soak) + record numbers  ·  [blocked by T1–T4 AND the #507 soak window closing ~2026-07-20 07:00 UTC]

Not a code task — the operational deliverable, run at SHIP (step 8) **after** the
#507 soak, so it can't contaminate a launch-blocker verification (the
differential deliberately wedges the pooler; the burst fires health warnings).

- Run the differential (`both`/all arms) → record concurrent-max2 wedge count,
  sequential-max2 = 0, concurrent-max6 = 0.
- Run the burst drill headroom arm (1000/10 min) → record backlog climb, drain
  time (≤30 min target), and that `backlog_depth` did NOT fire.
- Run the over-threshold arm → record the `backlog_depth:job_outbox` alert firing
  and clearing on drain.
- Fill the runbook **Results** section; comment the numbers on **#505**.
- Prod `HEALTH_ALERT_POLL_INTERVAL_MS` removal stays out of scope (#507 / launch
  promotion).

## Blocking-edge graph

```
T1 (extract shared modules)
 ├── T2 (differential)  ─┐
 └── T3 (load script)   ─┴── T4 (docs) ── T5 (execute, post-soak)
```

## Risks / watch-items

- T1 edits the merged `wedge-repro.ts` — keep the extraction surgical; its
  existing tests are the regression net (behavior must be byte-identical).
- T2 must NOT import/execute `wedge-repro.ts`'s `runDirectCli` side effect — it
  imports only from `staging-guard.ts` / `wedge-observer.ts` (pure modules).
- T3 injection mechanism is the one open design detail → resolved by the Explore
  spike (D1) before implementation; the plan owns the CONTRACT (drainable, no
  spend, no spurious pages), the module owns the concrete topic.
- Staging execution (T5) is gated on the #507 soak — do not run mid-soak.
```
