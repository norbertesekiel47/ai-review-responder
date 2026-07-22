# Runbook — #505 differential + #480 capacity-burst drill (staging)

**Created:** 2026-07-18 (ticket #505, map #472) · **Updated:** 2026-07-19 (T2/T3
scripts landed — two-arm burst drill + branch-isolated differential)
**Owner:** @norbertesekiel
**Applies to:** (a) reproducing the pipelining connection wedge proven in
`.claude/reference/lab-notes.md` (2026-07-18 entry) via a checked-in
differential, and (b) validating the design-burst capacity target from ADR
0005's addendum / ticket #474 against the backlog-depth alert shipped in
#480/#501 (already on `main`). Cross-linked from
`docs/runbooks/beta-launch-alerting.md` §4 (acceptance drills).

This covers OP4 in the #505 plan plus the two open #505 remainders (see
`docs/superpowers/plans/feat-505-differential-burst-drill.md`). Run the burst
drill **after** the poller-resume procedure (`beta-launch-alerting.md` §1b) so
the `HealthAlertPoller` is observing it at its designed 5-minute cadence, not
the slowed mitigation interval.

## Two separate tools, two separate proofs

| Tool | Proves | Runs against |
|---|---|---|
| `scripts/health-bundle-differential.ts` | The pipelining wedge mechanism itself (`Promise.all` × pool-size on the real health-check query mix) | An **ephemeral Supabase branch** off staging (isolated, sole client) |
| `scripts/burst-drill-load.ts` | Outbox **dispatch-drain** under load + `backlog_depth` alert fire/clear | **Shared staging** |

Neither is `scripts/wedge-repro.ts` (the #505 **boot-readiness** harness —
drives repeated fresh **worker boots** to characterize boot-burst wedging,
`BOOT_STAGGER_ENABLED`). All three are distinct, smaller-scoped tools; do not
conflate them. See "Relationship to the boot-readiness harness" below.

## Honest scope (read this before running anything)

The burst drill proves **outbox DISPATCH-drain** of a burst of pending
`job_outbox` rows plus `backlog_depth` observability. It does **not** prove
full ingest→draft→notification (LLM) pipeline throughput — the injected rows
are cheap, DB-only `stripe_subscription_mirror_sync` jobs that self-complete
with no LLM/external spend (see `scripts/burst-drill-load.ts` header and
`docs/superpowers/plans/feat-505-differential-burst-drill-deviations.md` D1 /
D2#4). Never describe a passing drill as "1000-review pipeline capacity
proven" — it proves the OutboxPoller claim-and-dispatch path drains a burst
and the alert observes it correctly, nothing about the LLM-bound stages
downstream.

## Part A — Health-bundle differential (proves the wedge mechanism)

**What it proves:** the checked-in `scripts/health-bundle-differential.ts`
reproduces the exact differential recorded in lab-notes (2026-07-18): the real
6-query health-check bundle fired via `Promise.all` on a `max:2` postgres.js
client wedges over the Supavisor transaction pooler; the same bundle run
**sequentially** (the shipped `runHealthChecks`, i.e. the actual cure) does
not; and the same bundle concurrent on `max:6` (one connection per query) does
not either — proving pool-size×mix pipelining, not concurrency alone, is the
trigger.

**Why an ephemeral branch, not shared staging:** running the pre-fix
concurrent arm against shared staging would wedge connections on the pooler
serving the live #507 soak / real traffic. A throwaway Supabase branch off
staging isolates the differential as the *sole* client on that branch, so
cleanup (terminate every wedge-signature backend) is provably safe and the
run cannot contaminate the #507 soak or production traffic. See deviations
D4/D5 for the full history of why this replaced an in-repo
`application_name`-attribution design (Supavisor flattens `application_name`
to the literal `'Supavisor'` server-side — ADR 0007 — which made that design
inoperable).

### Procedure

1. **Operator: create an ephemeral branch off staging** (Supabase MCP/CLI
   `create_branch`, base = the staging project). Capture its
   **transaction-pooler URL** (`:6543`, transaction mode — matching staging's
   topology is required or the wedge won't form) and its project ref.
2. **Run the differential:**
   ```
   pnpm tsx scripts/health-bundle-differential.ts \
     --branch-pool-url <branch transaction-pooler url> \
     --confirm-branch  <branch-project-ref> \
     [--iterations 6] [--observer-url <url>]
   ```
   The script self-verifies the target is neither the prod ref nor the known
   staging ref (`assertEphemeralBranchTarget`, `scripts/staging-guard.ts`) —
   it refuses to run against anything but a genuine throwaway branch.
3. **Expected outcome (3 arms × N iterations, default 6):**
   - `concurrent-max2` → **`wedged`** (deadline passed, read-only observer
     corroborates the `state=active, wait_event='ClientRead'` signature).
   - `sequential-max2` → **`fulfilled`** (the shipped `runHealthChecks` — the
     actual cure).
   - `concurrent-max6` → **`fulfilled`** (the pool-size control — proves it's
     pool-size×mix pipelining, not concurrency alone).
   - If `concurrent-max2` does **not** wedge, the script reports the run as
     `inconclusive`, never a false "cure regression" — that's a possible
     branch-pooler-mode difference from shared staging's pooler, worth
     investigating separately, not evidence the fix broke.
4. **Operator: delete the branch** (Supabase MCP/CLI `delete_branch`) —
   final teardown regardless of the script's own cleanup ladder.

Because the differential runs on an isolated branch, it does **not**
contaminate the #507 soak — but still run it **post-soak** (per T5's blocking
edge) to avoid unrelated project-level resource contention on the parent
staging project while the branch exists.

Record the 3-arm outcome in **Results** below.

## Part B — Capacity-burst drill (proves dispatch-drain + alert fire/clear)

**Design target (ADR 0005 addendum / #474):** 250 locations at 6 months,
~125 reviews/day fleet-wide steady state, a design burst of 1000 events in
10 minutes drained within 30 minutes, with a queue-health alert at ~1500
pending outbox rows as headroom.

This drill uses `scripts/burst-drill-load.ts` — the checked-in synthetic-load
injector (ticket #505, T3) — in **two arms** against shared staging.

### Execution gate — verify BEFORE starting (do not skip)

The drill runs on **shared staging**, so it must not run mid-soak or on an
unverified assumption. Before injecting anything, verify **both**:

1. A **recorded #507 PASS/closure comment** exists on the #507 issue (the
   24h soak result). "The ~24h window has closed" is **not** sufficient on
   its own — the soak must have actually passed, recorded.
2. A **clean HealthAlertPoller baseline** right now: recent poller cycles
   show no `health-alert-checks timed out` log lines and no standing
   `backlog_depth` finding already open on the Discord/Sentry route.

If either is unmet, **abort** — do not run the drill.

### Preconditions

- The #505 boot-readiness cure is deployed to staging (OP1/OP2 in the #505
  plan — `scripts/wedge-repro.ts` treatment run shows zero wedge).
- `HEALTH_ALERT_POLL_INTERVAL_MS` has been removed on staging per
  `beta-launch-alerting.md` §1b, so the poller is on its normal 5-minute
  cadence during the drill.
- `WORKER_INTERNAL_SECRET` is set identically on the Vercel staging project
  and the Railway staging worker, so `GET /internal/queue-health` is
  reachable for observation (`backlog.job_outbox` is the pending-row count) —
  or observe via `queryBacklogDepth` / a direct `psql` count against
  `job_outbox` instead.

### Fires / clears — precise definitions (D3-D)

`worker/background/pollers/health-alert/emit.ts` was read as part of this
task and confirmed to have **no recovery/resolution event** — `emitHealthFindings`
only ever calls `Sentry.captureMessage` per finding; there is no paired
"resolved" message, and `recordProbeCheckIn` is the poller's own liveness
dead-man switch, unrelated to any individual finding. So:

- **Fires** = a `backlog_depth:job_outbox` finding lands at the Discord/Sentry
  sink on a HealthAlertPoller cycle where `queryBacklogDepth` /
  `/internal/queue-health` shows `job_outbox` pending **> 1500**.
- **Clears** = after running `release`, **both**: (a) pending drops **< 1500**
  (via `queryBacklogDepth` / `/internal/queue-health`), **and** (b) a
  **subsequent HealthAlertPoller cycle completes a successful check-in**
  (Sentry Cron check-in lands `ok`) **that emits no `backlog_depth:job_outbox`
  finding**. Absence of a new alert alone is not enough to call it cleared —
  it must be a completed cycle that checked in clean, not silence from a
  poller that stalled or crashed.

Keep "drain" (headroom arm, below) and "fire+clear" (over-threshold arm)
as distinct claims — do not conflate them.

### Headroom arm — proves drain + no false alarm

Inject 1000 immediately-claimable rows over 10 minutes:

```
railway run --environment staging --service repworth-worker -- \
  pnpm tsx scripts/burst-drill-load.ts inject \
    --events 1000 --duration-min 10 --confirm-staging kubdiqdhqbhwmqfditeg
```

(`--available-in-min` defaults to `0` — immediately claimable. The OutboxPoller
claims at ~600 rows/min, which outpaces the ~100 rows/min inject rate, so
pending stays low throughout.)

1. **Baseline** — confirm current backlog is near zero (`SELECT count(*) FROM
   job_outbox WHERE status = 'pending';` or `/internal/queue-health`).
2. **Run the command above.** It prints per-batch progress
   (`backlog_depth.job_outbox(pending)=<n>`) as it injects.
3. **Watch the climb** — `job_outbox` pending should stay low throughout (the
   drain rate outpaces injection).
4. **Confirm no alert** — watch the Discord/Sentry route for the full 30-minute
   window from injection start. `backlog_depth:job_outbox` must **not** fire.
   If it fires, that's a drill failure — reconcile the threshold or injected
   volume against the #474 target before shipping.
5. **Confirm the drain** — pending should trend back to baseline within 30
   minutes of the burst starting. Headroom-arm rows self-complete (the
   mirror-sync handler completes for a missing account); no manual cleanup is
   needed for this arm.

Record the observed backlog climb, drain time, and non-alert in **Results**
below.

### Over-threshold arm — proves the alert fires and clears

Inject ~1600 **future-dated** rows that count toward `backlog_depth` but the
poller cannot yet claim, so pending holds above the 1500 threshold across at
least one HealthAlertPoller tick (5 min):

```
railway run --environment staging --service repworth-worker -- \
  pnpm tsx scripts/burst-drill-load.ts inject \
    --events 1600 --duration-min 5 --available-in-min 15 \
    --confirm-staging kubdiqdhqbhwmqfditeg
```

`--available-in-min` must be **≥ 15** — comfortably past at least one 5-minute
poller cycle, so the alert has a chance to actually evaluate the held backlog
before any row becomes claimable. The command prints its own drill tag and
the exact `release` invocation for cleanup — do not lose it.

1. **Inject** using the command above (adjust `--events`/`--available-in-min`
   only if the threshold or poller cadence has since changed — keep well
   past 1500 and well past one poller tick).
2. **Watch the climb** — pending should climb past 1500 and hold there (the
   rows are future-dated, so the poller does not drain them).
3. **Confirm the alert fires** — per the fires/clears definitions above,
   watch the Discord/Sentry route for `backlog_depth:job_outbox` (`warning`)
   on a cycle where pending > 1500.
4. **Release** — run the printed cleanup command:
   ```
   pnpm tsx scripts/burst-drill-load.ts release \
     --drill-tag <tag> --confirm-staging kubdiqdhqbhwmqfditeg
   ```
   This DELETEs only this run's tagged, still-`pending` rows and prints a
   **post-run inventory**. A non-zero remaining count is a **HARD-FAIL**
   (non-zero exit code + the listed rows) — investigate before considering the
   arm complete; never treat a non-zero residual as a soft warning.
5. **Confirm the clear** — per the definitions above: pending drops below
   1500 **and** a subsequent HealthAlertPoller cycle completes a clean
   check-in with no `backlog_depth:job_outbox` finding.

Record the fire time, clear time, and the release inventory result in
**Results** below.

## Relationship to the boot-readiness harness

`scripts/wedge-repro.ts` (the #505 boot-readiness cure's validation harness)
is a **separate** tool from both Part A and Part B — it drives repeated fresh
**worker boots** to characterize the boot-burst wedge candidate, not
steady-state health-check pipelining or outbox throughput. It is not used in
either drill above. Its invocation, for reference:

```
railway run --environment staging --service repworth-worker -- \
  pnpm tsx scripts/wedge-repro.ts both --confirm-staging kubdiqdhqbhwmqfditeg
```

(`kubdiqdhqbhwmqfditeg` is the staging Supabase project ref the harness's
prod-reject guard checks against — see
`fix-505-pool-wedge-rootcause-deviations.md` T1 section and
`deployment-guide.md:1150-1151` for the verified ref pair. It is also the
`--confirm-staging` value for `burst-drill-load.ts`, which shares the same
positive-allowlist guard.)

Do not run `wedge-repro.ts both` concurrently with the burst drill (Part B) —
it spawns and tears down worker child processes and terminates backends it
identifies as its own wedges, which would confuse the burst drill's backlog
observation. The differential (Part A) runs on an isolated branch and has no
such conflict with either.

## Results (executed <date>) — differential (Part A)

_Fill in after running `scripts/health-bundle-differential.ts` on an
ephemeral branch (T5)._

| Arm | Expected | Observed | Iterations (per-iteration outcomes) |
|---|---|---|---|
| `concurrent-max2` | `wedged` | | |
| `sequential-max2` | `fulfilled` | | |
| `concurrent-max6` | `fulfilled` | | |

Verdict: _(repro-confirmed / inconclusive / cure-regression / aborted-residual)_

## Results (executed <date>) — capacity-burst drill (Part B)

_Fill in after running `scripts/burst-drill-load.ts` against staging (T5)._

**Headroom arm** (`--events 1000 --duration-min 10`)
- Peak pending observed:
- Drain time (target ≤30 min):
- `backlog_depth:job_outbox` fired: _(expected: no)_

**Over-threshold arm** (`--events 1600 --available-in-min <K>`)
- Time pending crossed 1500:
- `backlog_depth:job_outbox` fire time / finding:
- `release` run time / drill tag:
- Post-run inventory result: _(expected: 0 remaining — hard-fail if non-zero)_
- Time pending dropped below 1500:
- Time of the next clean HealthAlertPoller check-in with no finding (the
  clear):
