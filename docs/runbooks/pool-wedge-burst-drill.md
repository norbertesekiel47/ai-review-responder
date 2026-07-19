# Runbook — #480 capacity-burst drill (staging)

**Created:** 2026-07-18 (ticket #505, map #472) · **Owner:** @norbertesekiel
**Applies to:** validating the design-burst capacity target from ADR 0005's
addendum / ticket #474, and the backlog-depth alert shipped in #480/#501
(already on `main`). Cross-linked from `docs/runbooks/beta-launch-alerting.md`
§4 (acceptance drills).

This is the operational drill referenced as OP4 in the #505 plan
(`docs/superpowers/plans/fix-505-pool-wedge-rootcause.md`). Run it **after**
the poller-resume procedure (`beta-launch-alerting.md` §1b) so the
`HealthAlertPoller` is observing the drill at its designed 5-minute cadence,
not the slowed mitigation interval.

## What this proves

The capacity target locked in ADR 0005's addendum (ticket #474): **250
locations at 6 months, ~125 reviews/day fleet-wide steady state, a design
burst of 1000 ingest events in 10 minutes drained within 30 minutes**, with a
queue-health alert at ~1500 pending outbox rows as headroom. This drill
injects that exact burst on staging and confirms two things simultaneously:

1. **Drain**: `job_outbox` climbs toward ~1000 pending then drains back to
   baseline within 30 minutes — the pipeline absorbs the burst without a
   growing backlog.
2. **No false alarm**: the backlog-depth alert (`HEALTH_ALERT_BACKLOG_DEPTH_THRESHOLD`,
   default 1500 — see `CONTEXT.md` "Backlog depth alert threshold") does
   **not** fire during a burst that stays under its headroom (1000 < 1500).
   It exists to validate the observability path is correctly *not* noisy at
   the capacity target, not to prove the alert can fire at all — a separate
   drill in `beta-launch-alerting.md` §4 ("Backlog depth over threshold")
   already covers that by inserting rows directly past the threshold.

## Preconditions

- The #505 boot-readiness cure is deployed to staging and validated (OP1/OP2
  in the #505 plan — `scripts/wedge-repro.ts` treatment run shows zero wedge).
- `HEALTH_ALERT_POLL_INTERVAL_MS` has been removed on staging per
  `beta-launch-alerting.md` §1b, so the poller is on its normal 5-minute
  cadence during the drill.
- `WORKER_INTERNAL_SECRET` is set identically on the Vercel staging project
  and the Railway staging worker (see `.claude/reference/env-vars.md`), so
  `GET /internal/queue-health` is reachable for observation — or observe via
  a direct `psql` count against `job_outbox` instead (either works; the
  endpoint returns `{queues, backlog}` with `backlog.job_outbox` as the
  pending-row count).

## Procedure

1. **Baseline.** Before injecting anything, confirm the current backlog is
   near zero:
   ```sql
   SELECT count(*) FROM job_outbox WHERE status = 'pending';
   ```
   or `GET /internal/queue-health` (`Authorization: Bearer $WORKER_INTERNAL_SECRET`)
   and read `backlog.job_outbox`.

2. **Inject the burst — 1000 events over 10 minutes.** There is no dedicated
   synthetic-load script in-tree for this; the drill follows the same
   direct-insert pattern as the other acceptance drills in
   `beta-launch-alerting.md` §4 ("Stuck outbox" etc.) — insert `job_outbox`
   rows shaped like a real `live_ingest_new` v1 job (see
   `.claude/reference/review-ingestion.md` for the payload contract) against
   a staging test account/business, paced across 10 minutes rather than in
   one batch (a tight loop with a short sleep, or ten batches of 100 one
   minute apart, both approximate the design burst adequately — the drill
   cares about the drain and alert behavior over the following 30 minutes,
   not sub-minute injection precision).

3. **Watch the climb.** Poll `GET /internal/queue-health` (or the SQL count)
   every 1–2 minutes during injection. `backlog.job_outbox` should climb
   toward, but stay under, ~1000.

4. **Confirm no alert during headroom.** Watch the Discord/Sentry route
   (`beta-launch-alerting.md` §1) for the full 30-minute drain window.
   `backlog_depth:job_outbox` must **not** fire — 1000 pending stays under
   the 1500 threshold. If it fires, that's a drill failure: either the
   threshold or the injected volume drifted from the #474 target and needs
   reconciling before shipping.

5. **Confirm the drain.** Continue polling `backlog.job_outbox` after
   injection stops. It should trend back to baseline (near zero) within 30
   minutes of the burst starting — the OutboxPoller's normal dispatch cadence
   (5s) draining the queue, not a special-cased burst handler.

6. **Clean up.** The injected rows should have dispatched through the normal
   pipeline (review ingest → draft → notification) against the staging test
   account, same as any other staging test data — no separate teardown beyond
   the account's normal staging hygiene. If a row was stuck (drain failed),
   investigate via the "Queue lag" triage playbook in
   `docs/runbooks/observability.md` before re-running.

## Relationship to the T1 repro harness

`scripts/wedge-repro.ts` (the #505 boot-readiness cure's validation harness)
is a **separate** tool — it drives repeated fresh **worker boots** to
characterize the connection wedge, not steady-state ingest throughput. It is
not used in this drill. Its invocation (for reference, if the two drills are
ever run back-to-back on the same staging window) is:

```
railway run --environment staging --service repworth-worker -- \
  pnpm tsx scripts/wedge-repro.ts both --confirm-staging kubdiqdhqbhwmqfditeg
```

(`kubdiqdhqbhwmqfditeg` is the staging Supabase project ref the harness's
prod-reject guard checks against — see
`fix-505-pool-wedge-rootcause-deviations.md` T1 section and
`deployment-guide.md:1150-1151` for the verified ref pair.)

Do not run the two drills concurrently — the harness's `both` mode spawns and
tears down worker child processes and terminates backends it identifies as
its own wedges, which would confuse the burst drill's backlog observation.
