# 0014 — Send-mode: one terminal spine state, no active ones; batch lifecycle stays on the domain entity; children are lazy

Date: 2026-07-28 (accepted 2026-07-29 with #624)
Status: accepted
Context: ticket #619 (wayfinder map #617); spec
`docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md`; gap analysis
`docs/research/2026-07-28-send-mode-executor-gap.md` (branch
`research/send-mode-executor-gap`) (#618). Supersedes nothing; completes ADR 0011's
deferred set.

## Context

ADR 0011 deferred physical fan-out, join, halt/lifecycle verbs, and status
growth to send-mode as "their first real requirement," and promised send-mode
would add *states and verbs, not columns-plus-rework*. #618 verified that
promise against `main` and found the cost of enum growth is **asymmetric**:
`agent_runs_terminal_consistency` is written as an equivalence on `'running'`,
so a new **terminal** state satisfies it unchanged while a new **active** state
rewrites it, rebuilds `agent_runs_one_active_per_subject`, and forces a
byte-for-byte edit of the writer's `ON CONFLICT` — where a mismatch stops
enforcing uniqueness **silently**.

## Decision

1. The spine gains exactly one new status, `cancelled`, terminal. No active
   states. `completed` = plan exhausted naturally; `cancelled` = stopped early
   by a decision or a deadline; `failed` = execution error.
2. Batch approval, veto, and halt state live on `solicitation_batches` as
   monotone timestamps with a read-time `deriveBatchState`. `held_for_approval`
   is **derived** (`waiting_on_owner`, WS5 precedent), never stored.
3. Send-mode children are created **lazily at release**, one per dispatch
   attempt, under a new parent kind `solicitation_send_batch`. The plan lives in
   `solicitation_asks` (ADR 0011 D5); the spine records work performed.
4. Halt is a monotone latch on the batch with two entry points (owner veto
   pre-first-send, owner/admin halt mid-drip) and a system entry
   (`send_window_elapsed`). No resume.
5. Per-ask send lifecycle and rendered artifacts live in a new
   `solicitation_outreach` table, not on `solicitation_asks`.

## Consequences

- **ADR 0011's promise holds on the spine and does not hold on the domain
  tables** — and the reason is not ADR 0011's error. Migration 090 (#593, four
  days later) welded `solicitation_asks.status` to `evidence->>'decision'`,
  making the ask's status a provenance column. That forecloses reusing it for a
  send lifecycle regardless of any spine decision. Recorded rather than papered
  over.
- Both coupled constraints stay byte-for-byte frozen; the writer's `ON CONFLICT`
  is untouched. #618's S9 parent-join index is not needed because the join is a
  domain-table question.
- Lazy children mean halt has nothing to cancel in the spine, no child is
  long-lived enough to be misread as `stalled`, and a bulk *running*-child
  writer is not required.
- The parent is legitimately long-lived (≤10 days by construction), so
  `deriveRunDisplayState`'s `stalled` threshold becomes **kind-aware**, set from
  the kind's contractual maximum lifetime rather than raised by feel.
- **The kind-aware threshold is wired now, not deferred** (revised G10, accepted
  with #624). `deriveRunDisplayState` takes `kind` as an input,
  `getReviewTimeline` selects and passes it, and the derivation calls
  `stalledThresholdMsForKind(kind)` rather than the bare
  `STALLED_RUNNING_THRESHOLD_MS`. Behaviour for the one live caller
  (`review_handler`) is **unchanged** — it maps to the existing threshold — so
  this is a pure widening with no display change, and the helper has a real
  consumer on the day it lands. The earlier resolution shipped the helper as
  dead code beside an untouched signature; the plan gate correctly read that as
  a knowing violation of a binding decision (D15b) rather than a deferral.
- **No advisory lock can protect a send across its provider call, so an in-flight
  send must be visible to purge in *committed state*.** The dispatch path's
  provider call sits between two transactions, and `pg_advisory_xact_lock`
  releases at the end of the transaction that took it —
  `acquireSolicitationBatchLock` is transaction-scoped by construction and
  bridges nothing. The discipline this ADR fixes: the transaction that claims an
  outreach row for sending must commit that claim (a `sending` delivery status
  the offboarding purge reads) *before* the provider call, and must take the
  advisory lock **before** its batch-row lock so the claim and the purge
  serialize on it rather than merely observing each other. #624 establishes the
  global order (advisory → row) and documents the trap at the helper; it builds
  no send worker, so closing the dispatch-versus-purge race is bound to #630 by
  cross-spec amendment B11.
- Cost of reversal: moving batch lifecycle onto the spine later requires the
  coupled CHECK/index/writer change this ADR avoids, plus a backfill — the same
  deliberate trade ADR 0011 made, taken again with the evidence that the
  asymmetry is real.
