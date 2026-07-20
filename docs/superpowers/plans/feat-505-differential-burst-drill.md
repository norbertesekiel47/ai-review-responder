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
  `assertStagingTarget`, `describeConnectionTarget` out of `wedge-repro.ts`. The
  **prod denylist wins over every flag** in all modes. Two target modes:
  - **`assertStagingTarget` (positive allowlist — D2#7):** target ref must **equal**
    `KNOWN_STAGING_REF` and `--confirm-staging` must equal it too. Used by
    `wedge-repro.ts` and `burst-drill-load.ts` (they run against shared staging).
  - **`assertEphemeralBranchTarget` (branch mode — D5):** target ref must equal
    `--confirm-branch <ref>` AND be **neither** the prod ref **nor** `KNOWN_STAGING_REF`
    (a throwaway branch is distinct from both long-lived envs). Used by the
    differential (T2).
- Only the guard is extracted (NOT a wedge-observer — D2#8). `wedge-repro.ts`
  deletes the moved guard defs and imports `assertStagingTarget`; everything else
  (its observer, trial/boot orchestration, `runEmergencyCleanup`, summary) untouched.
- Tests: new `scripts/ci/__tests__/staging-guard.test.ts` — prod-denylist beats
  every flag in BOTH modes; `assertStagingTarget` requires `== KNOWN_STAGING_REF`;
  `assertEphemeralBranchTarget` rejects prod AND staging refs and requires a matching
  distinct branch ref; empty/mismatched confirm rejected; no password surfaces.
  `wedge-repro.test.ts` keeps covering wedge-repro's own logic, importing the guard.
- **Green:** the extracted-guard tests + the existing `wedge-repro.test.ts` +
  typecheck all pass — proves the refactor preserved behavior end-to-end.

### T2 — `scripts/health-bundle-differential.ts` (the differential)  ·  [blocked by T1]

Three-arm, N-iteration (default 6) differential run against an **ephemeral Supabase
branch** off staging (D5) — the differential is the SOLE client, so cleanup needs
no per-backend attribution (ADR-0007 dissolved). Branch create/drop is the operator's
T5 step; the script takes the branch's **transaction-pooler URL**:
`pnpm tsx scripts/health-bundle-differential.ts --branch-pool-url <url> --confirm-branch <branch-ref> [--iterations N]`.

- Safety (`staging-guard.ts`, branch mode — D5): hard-reject the prod denylist
  (defense-in-depth), and require `--confirm-branch <ref>` that matches the target
  AND is NEITHER the prod NOR the staging ref (must be a throwaway branch). Applied
  to the target pool URL AND the read-only observer URL.
- **Fresh client per iteration (D2#1)** with the REAL construction (fixes codex #3):
  `createDedicatedPostgresClient(<branch pool url>, { max: 2 })` — mirrors the real
  `buildHealthClient()` at `worker/background/pollers/HealthAlertPoller.ts:34-35`.
  A wedged connection can't leak into the next iteration.
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
  `checkZeroDeliveryNotifications`, `checkBacklogDepth`) are the real query mix,
  fired with the **EXACT resolved health config** `runHealthChecks` uses — NOT a
  throwaway literal (fixes codex #3: `failedWindowS`/`staleDispatchingThresholdS`/
  `zeroDeliveryWindowS` are live SQL query parameters, `checks.ts:54,92,134`, so a
  wrong value changes the queries themselves).
- **Detection (D2#2 + D3-A): explicit ~40s deadline + 4-way taxonomy + MANDATORY
  signature corroboration.** Deadline is > the 30s server `statement_timeout` (a
  wedge is `ClientRead`, a wait state, so statement_timeout never heals it). Per-arm
  outcome: `fulfilled` (all 6 resolved), `rejected` (a check threw), **`wedged`**
  (deadline passed AND the read-only observer corroborates the `ClientRead`
  signature on the arm's OWN backends), `hung-unknown` (deadline passed WITHOUT the
  signature → NOT the known wedge; inconclusive, not a repro). A bare timeout does
  NOT prove the wedge — the read-only observer is **mandatory**.
- **Cleanup (D5 — no attribution needed on the isolated branch):** the differential
  is the branch's SOLE client, so EVERY wedge-signature backend is provably ours.
  Per-arm ladder: `client.end({ timeout })` (best-effort FIN; documented unreliable
  per `HealthAlertPoller`/#477, so NOT the guarantee) → **`pg_terminate_backend`
  every wedge-signature backend on the branch** (safe — nothing else is there). Then
  a **baseline barrier**: verify a zero wedge-signature baseline before the next arm;
  a residual that survives terminate-all → ABORT (branch is misbehaving). SIGINT/
  SIGTERM runs the same ladder for all live clients. **Final teardown = operator
  `delete_branch`** (T5) nukes any residual regardless. The prod denylist still
  guards terminate-all as defense-in-depth (never run this against a prod-shaped
  target).
- Exit code gates the expected outcome: non-zero if `concurrent-max2` is not
  `wedged` (repro failed / branch pooler didn't reproduce — reported as inconclusive,
  see feasibility note) OR a cure arm is `wedged` (regression) OR the run ABORTED (a
  residual survived terminate-all). `hung-unknown` on the baseline arm is a non-repro
  reported honestly (not a pass), and signals a possible branch-pooler-mode mismatch.
- Pure/testable helpers (the tests): the **4-way arm classifier** (fulfilled /
  rejected / wedged[=timeout+signature] / hung-unknown[=timeout, no signature]),
  expected-vs-actual gating, the bounded-deadline wrapper, the branch-target guard
  (rejects prod + staging refs, requires a distinct branch ref), arg parsing/bounds.
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
  and ends with a **post-run inventory**: COUNT remaining rows for `<tag>`; a
  non-zero count is a **HARD-FAIL** (non-zero exit + list), never just a warning
  (D3-E). Belt: `inject` also prints the exact `release` command with the tag baked
  in, so cleanup is never lost.
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
- **Explicit clear-evidence (D2#5 + D3-D):** `emit.ts` has **no recovery/resolution
  event** (confirm when writing T4). So the runbook records: **fires** = a
  `backlog_depth:job_outbox` finding at the Discord/Sentry sink on a cycle where
  pending>1500; **clears** = after `release`, `queryBacklogDepth`/`queue-health`
  shows pending<1500 **AND** a subsequent HealthAlertPoller cycle **completes a
  successful check-in emitting no such finding** (absence-of-finding alone is not
  enough — it must be a completed cycle). Keep "drain" (headroom arm) and
  "fire+clear" (over-threshold arm) as distinct claims.
- `.claude/reference/lab-notes.md`: the pipelining finding is already noted; add
  only a one-line pointer to the checked-in differential harness if missing.
- **Green:** standard gate (lint/typecheck/test + all `ci:*` audits); docs-only
  changes carry no new code path.

### T5 — EXECUTE on staging (post-soak) + record numbers  ·  [blocked by T1–T4 AND the #507 soak window closing ~2026-07-20 07:00 UTC]

Not a code task — the operational deliverable, run at SHIP (step 8).

- **Differential (branch-isolated — D5):** operator `create_branch` off STAGING
  (Supabase MCP/CLI) → pass the branch's transaction-pooler URL + `--confirm-branch
  <branch-ref>` → run the differential (all arms) → record concurrent-max2 =
  `wedged` (+ the ClientRead corroboration), sequential-max2 + concurrent-max6 =
  clean → operator `delete_branch`. Because it's on an isolated branch it does NOT
  contaminate the #507 soak, but still run it post-soak to avoid project-level
  resource contention. If concurrent-max2 does NOT wedge on the branch, record it as
  inconclusive (branch-pooler-mode difference to investigate — do NOT claim the cure
  regressed).
- **Burst drill (shared staging — needs the #507 gate, D3-F):** the runbook step
  must VERIFY, not assume: (1) a **recorded #507 PASS/closure comment** exists, AND
  (2) a **clean HealthAlertPoller baseline** right before starting (recent cycles
  show no `health-alert-checks timed out` and no standing `backlog_depth` finding).
  "The ~24h window has closed" is NOT sufficient — abort if either is unmet.
  - Headroom arm (1000/10 min) → record backlog climb, drain time (≤30 min target),
    and that `backlog_depth` did NOT fire.
  - Over-threshold arm → record `backlog_depth:job_outbox` firing, then clearing per
    the D3-D clear-evidence (pending<1500 + a successful poller check-in with no
    finding); run `release` and confirm the zero-residual inventory.
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
- T2 imports only `staging-guard.ts` + the exported `checkXxx`/`runHealthChecks`
  from `checks.ts`; it owns its OWN minimal read-only wedge sampler (no
  `wedge-observer.ts` extraction — D2#8/D3-H). It must NOT import/execute
  `wedge-repro.ts`'s `runDirectCli` side effect.
- T2 runs on an **ephemeral branch** where it is the sole client, so terminate-all-
  wedge is safe (no ADR-0007 attribution needed — D5); the prod denylist still
  guards terminate-all as defense-in-depth. `application_name` is NOT usable for
  identity through Supavisor (ADR 0007) — do not reintroduce it.
- Branch feasibility is self-verified by the concurrent-max2 arm; a non-wedge there
  is reported as inconclusive (branch-pooler-mode), never a cure regression.
- T3 injection mechanism resolved by the Explore spike (D1); the plan owns the
  CONTRACT (drainable, no spend, no spurious pages), the module owns the topic.
- Burst-drill execution (T5, shared staging) is gated on RECORDED #507 PASS + a
  clean poller baseline — do not run mid-soak or on an unverified window (D3-F).
```
