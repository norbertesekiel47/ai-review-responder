# Adversarial approach review — fix/1083-ledger-attribution

Runner: Codex (`codex exec`, read-only sandbox), round 1.
Fork `91b32506a694954643e9523eae3901d784a348ca` · HEAD under review `c94277bf1fe7fa789bba7bbb7208c7f7210b9188`.
`VERDICT: REVISE`. 131,664 tokens.

This axis challenges the APPROACH and its assumptions, not line-level defects.
The other three axes cover those. Its brief carried the intake, the triaged
deviations and the full production diff, so it re-derived nothing.

> The reviewer's transcript is not committed. It is 865 KB, almost all of it
> tool output, and `docs/reviews/` is a record of findings rather than of how
> they were reached. The findings below are reproduced in full.

## Findings

### A1 — The writer seam drops the only useful decision identity for set writes · ACCEPTED

The central seam is sound for guaranteeing attribution, but its claim that
caller context is unnecessary is not. The set arm emitted only `row_count` and
`refusal_lanes` — no tenant, batch, run or job identifier. Yet the
`ask_withheld` caller holds `batch.id` and `parentRunId`
(`src/lib/solicitation/batch-builder.ts:670`). When the transaction rolls back
the generated ask and run links may not exist, leaving an operator with "this
lane failed for N rows" and nothing to join on. The later terminal job event
carries `job_id` but is a separate `subsystem=worker_job` capture with no
explicit linkage (`worker/job-failure-sink.ts:68`).

**Smallest correction proposed**: keep writer-owned capture, but let each write
supply one bounded operation identifier — `batch_id`, `response_id` or
`suspension_event_id` — without restoring caller-side wrappers.

**Disposition — ACCEPTED, resolved differently and deliberately.** The finding
is right that the payload was unusable; it is wrong that the fix needs a new
parameter. `batch_id` and `run_id` would widen the writer's interface, which is
the single property this branch exists to protect — the moment a caller must
pass context, a caller can omit it, and that is the defect class the whole
change closes. The writer already holds the **account**, which is the join key
that matters in a multi-tenant system. Set-arm `extra` is now
`{ row_count, account_id, account_count }`: `account_id` is the sole distinct
value or `null`, `account_count` the distinct cardinality. Both bounded, no
interface change. Recorded in deviations D10.

### A2 — Writer attribution has unbounded event amplification · REJECTED (owner)

`captureLedgerWriteFault` calls `captureException` on every failure with no
latch, cooldown or cap. A deterministic defect therefore emits once per attempt:
five times for each `generate_response` job, three on default queues
(`worker/queues.ts:38`). `tracesSampleRate` covers tracing, not error-event
sampling, and `beforeSend` only scrubs (`worker/sentry.ts:6`). This can consume
Sentry quota and crowd out unrelated failures precisely during a systemic ledger
incident. The same module explicitly prevents per-decision floods for the
disabled-ledger signal and caps vocabulary events.

**Smallest correction proposed**: a bounded per-process cooldown keyed by closed
lane plus bounded error class, preserving the first event and emitting a capped
suppression marker.

**Disposition — REJECTED. Owner decision, 2026-09-04.** The precedent argument
does not transfer, and the reason is specific rather than a matter of taste.
Both existing latches exist to stop unbounded issue-GROUP scattering: their keys
are distinct block reason codes, so an uncapped signal opens one Sentry issue
group per distinct set and defeats per-issue throttling. This capture cannot
scatter — one exception shape across seven bounded lanes — so Sentry groups every
occurrence into a single issue with a count, which is the behaviour a latch
would be approximating. And a latch on an `error`-level write fault actively
harms the operator it serves: it hides whether the fault is still happening,
during exactly the incident where that is the question. The volume concern is
real but it is a quota concern, not a signal-quality one, and Sentry's own
client-side rate limiting is the right layer for it.

## Explicitly cleared

The axis attacked two things and found nothing at 80% confidence:

- **Deleting the `held_draft` wrapper loses nothing.** Its `response_id` value
  remains available as `subject_id`, neither payload sets a custom fingerprint,
  and the capture still precedes the rethrow.
- **The retry-cost scope split is defensible.** The plan carries an explicit
  follow-up task, though the reviewer notes that ticket must be filed before
  shipping.
