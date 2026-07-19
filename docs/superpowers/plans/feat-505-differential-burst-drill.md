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
- **Wedge signature** — `state=active AND wait_event='ClientRead'`. Authoritative
  owner is CONTEXT.md's **Connection wedge** glossary entry. The differential's
  use is **read-only corroboration only** (see T2 redesign, D2#2/#8), so it owns a
  minimal read-only sampler commented as implementing that glossary signature — we
  do NOT extract a shared destructive observer from the merged `wedge-repro.ts`
  (churn/regression not worth it once the differential stops doing destructive pid
  attribution).

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
  **Guard hardened to a positive allowlist (D2#7):** in addition to the prod
  denylist (which still wins over every flag), the target ref must **equal**
  `KNOWN_STAGING_REF` and `--confirm-staging` must equal it too — "not prod" is no
  longer sufficient; the target must be provably staging.
- Only the guard is extracted (NOT a wedge-observer — D2#8). `wedge-repro.ts`
  deletes the moved guard defs and imports them; everything else (its observer,
  trial/boot orchestration, `runEmergencyCleanup`, summary) untouched.
- Tests: new `scripts/ci/__tests__/staging-guard.test.ts` — prod-denylist beats
  every flag; **target must equal `KNOWN_STAGING_REF`** (a non-prod, non-staging
  ref is now rejected); empty/absent/mismatched confirm rejected; no password
  surfaces. Carried over + extended from the wedge-repro guard tests;
  `wedge-repro.test.ts` keeps covering wedge-repro's own logic, importing the
  guard from the new module.
- **Green:** the extracted-guard tests + the existing `wedge-repro.test.ts` +
  typecheck all pass — proves the refactor preserved behavior end-to-end.

### T2 — `scripts/health-bundle-differential.ts` (the differential)  ·  [blocked by T1]

Three-arm, N-iteration (default 6) differential, invoked operator-style like
wedge-repro:
`railway run --environment staging --service repworth-worker -- pnpm tsx scripts/health-bundle-differential.ts --confirm-staging <ref> [--iterations N]`.

- Safety: `assertStagingTarget` (positive allowlist) on the target pool URL AND
  the read-only observer URL — from `staging-guard.ts`.
- **Fresh client per iteration (D2#1):** each of the N iterations builds a NEW
  dedicated client so a wedged connection can't leak into the next iteration.
  Client options MUST match the real health client — read
  `worker/background/pollers/health-alert/health-db.ts` `buildClient()` and mirror
  its `createDedicatedPostgresClient` options (differing only in `max`).
- Arms:
  - `concurrent-max2`: replicate the **exact pre-fix `Promise.all`** of the 6
    exported `checkXxx` on a `max:2` client → EXPECT wedge.
  - `sequential-max2`: call the **shipped `runHealthChecks(sql)` directly** on a
    `max:2` client (proves THE cure, not a hand-rolled sequential) → EXPECT clean.
  - `concurrent-max6`: the same pre-fix `Promise.all` on a `max:6` client → EXPECT
    clean (proves pool-size×mix pipelining, not concurrency alone — the control
    that distinguishes this from #500's falsified count>max hypothesis).
  The 6 checks (`checkFailedOutboxByTopic`, `checkOldestPendingOutbox`,
  `checkStaleDispatching`, `checkOpenFlaggedResponses`,
  `checkZeroDeliveryNotifications`, `checkBacklogDepth`) are the real query mix; a
  throwaway `HealthAlertConfig` literal is fine (thresholds gate emission, not
  whether the query runs).
- **Detection (redesigned — D2#2): the PRIMARY signal is whether the arm's queries
  RESOLVE within a bounded deadline**, observed in-process — concurrent-max2's
  `Promise.all` never settles before the deadline = wedge; the two cure arms settle
  = clean. No destructive `pg_stat_activity` pid-attribution (unsound over the
  transaction pooler). A SEPARATE read-only observer optionally samples the wedge
  signature to CORROBORATE + count, and is REPORTED — never used to
  `pg_terminate_backend` a backend not provably ours.
- **Cleanup (D2#3): force-close each arm's OWN client** via `client.end({ timeout })`
  — exactly how production recycles a wedged health client (`health-db.ts:53`);
  closing the socket releases the ClientRead-wedged server backend. SIGINT/SIGTERM
  force-closes all live arm clients; process exit closes sockets. Any residual
  wedge-signature backend after close is REPORTED for manual review, not
  auto-terminated (soak-safe).
- Exit code gates the expected outcome: non-zero if `concurrent-max2` did NOT wedge
  (repro failed) OR if either cure arm DID wedge (regression) OR a residual
  wedge-signature backend was reported after cleanup. A per-arm non-repro is
  reported honestly.
- Pure/testable helpers (the tests): arm-outcome classification (resolved vs
  timed-out → wedged?), expected-vs-actual gating, the bounded-deadline wrapper,
  arg parsing/bounds.
- **Green:** `health-bundle-differential.test.ts` + typecheck.

### T3 — `scripts/burst-drill-load.ts` (synthetic-load injector)  ·  [blocked by T1]

Parametrized injector for the capacity-burst drill:
`railway run --environment staging --service repworth-worker -- pnpm tsx scripts/burst-drill-load.ts --events N --duration-min M --confirm-staging <ref> [--batch-size B]`.

- Safety: `assertStagingTarget` (positive allowlist) on the inject target
  (`staging-guard.ts`).
- **Scope (honest framing — D2#4):** this drill proves **outbox DISPATCH-drain**
  of a burst of pending `job_outbox` rows + `backlog_depth` observability — it does
  NOT prove full ingest→draft→notification pipeline throughput (deliberately, per
  the "cheap drainable rows, mocked externals" decision). All docs/results say
  "outbox dispatch drain", never "1000-review pipeline capacity".
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
    `backlog_depth:job_outbox` fires. Then `release --drill-tag <tag>` clears it.
- **Release protocol (hardened — D2#6):** every injected row carries a **unique
  per-run `__drill:<tag>`** (tag = a run id, logged). `release` DELETEs **only**
  `topic='stripe_subscription_mirror_sync' AND payload->>'__drill'=<tag> AND
  status='pending' AND created_at >= <run-start horizon>` — never real rows, never
  non-pending rows, never another run's rows. Release is **idempotent** (re-runnable)
  and ends with a **post-run inventory**: COUNT remaining rows for `<tag>` and
  assert 0 (else warn + list). Belt: `inject` also prints the exact `release`
  command with the tag baked in, so cleanup is never lost.
- Pacing: pure `computeInjectionSchedule(events, durationMin, batchSize)` → an
  ordered list of `{ batchCount, delayMsAfter }` spreading N rows across M
  minutes (sub-minute precision is not the point).
- Progress: optionally poll `queryBacklogDepth` (single owner) between batches to
  log the pending climb — counts only, never row content.
- Pure/testable helpers (the tests): `computeInjectionSchedule` math (N over M,
  remainder handling, batch bounds), arg parsing/bounds (positive ints, sane
  caps), the row-shape builder, safety-gate wiring, and — safety-critical — the
  **scoped-delete predicate builder** (asserts it ALWAYS includes topic +
  drill-tag + status='pending' + horizon; a missing clause must be impossible).
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
  over-threshold arm. State the scope honestly (outbox dispatch drain, D2#4).
- **Explicit clear-evidence (D2#5):** the runbook defines exactly what "fires" and
  "clears" mean at the alert sink — first read `worker/background/pollers/health-alert/emit.ts`
  to learn whether findings are re-emitted per cycle or have explicit
  resolution/recovery semantics, then record: **fires** = a `backlog_depth:job_outbox`
  finding at the Discord/Sentry sink on a cycle where pending>1500; **clears** =
  the next cycle after `release` emits NO such finding (pending<1500). Keep "drain"
  (headroom arm) and "fire+clear" (over-threshold arm) as distinct claims.
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
