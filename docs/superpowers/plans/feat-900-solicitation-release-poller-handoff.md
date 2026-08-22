# Handoff — feat-900-solicitation-release-poller

A resumed session bootstraps from this file. It never needs the prior transcript.

**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-900-solicitation-release-poller`
**Branch:** `feat-900-solicitation-release-poller`
**Issue:** #900 — Solicitation release poller.
**Lane:** RISK = high · SURFACE = backend · `db_touching: true` · no migration.
**Phase at last write:** `plan_approved`. Next step is `/feature` step 4 (EXECUTE).

## Read these, by path — do not restate them here

| Artifact | Path |
|---|---|
| Intake contract (39 promised tests) | `.feature/intake.json`, audit copy in `docs/superpowers/plans/feat-900-solicitation-release-poller-intake.json` |
| The plan (11 tasks, blocking edges) | `docs/superpowers/plans/2026-08-22-solicitation-release-poller.md` |
| Deviations | `docs/superpowers/plans/feat-900-solicitation-release-poller-deviations.md` |
| Plan review rounds 1–2 | `docs/reviews/feat-900-solicitation-release-poller/plan-round{1,2}-codex.md` |
| Design of record | `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` §4 D7/D9/D10, §5 D11/D12/D14, §7 D18 |
| Amendments (win on conflict) | `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` B3, B6, B7, B10, B14, B15 |
| Glossary | `CONTEXT.md` — Halt latch, Owner approval, Send breaker, Dispatch gate, Batch state, Lazy child |

## Plan gate — closed

Three rounds, counter at `planReviewRounds=3` in `.feature/state.json`.

- Reviewer: codex, read-only. Thread `01a02a22-d338-7d92-9901-9c126aaa72af`.
- Round 1: `REVISE`, 13 findings — 12 accepted, 1 rejected.
- Round 2: `REVISE`, 2 residual (governor order, unknown-sweep atomicity).
- Round 3: **`APPROVED`**.

The review's primary question — *can the eval pass while the feature is still wrong?* — was
answered **yes, thirteen times** across rounds 1–2. Every accepted finding became a test
title. `tests_to_add` grew 27 → 39.

## Eight owner decisions, locked at grilling

1. Amendment B14's `platform_halt` gap is DEFERRED to a new issue (Task 10). No migration here.
2. The release phase checks `SOLICITATION_SEND_ENABLED`; no row reaches `queued` under a flag-off.
3. `latchHalt` gains a third arm `latchSystemHalt`; `actorUserId` widens to `string | null`.
4. A Judge downgrade writes a spine step and a Sentry warning. No owner notification.
5. `UNKNOWN_GRACE_MINUTES = 60`, hardcoded, anchored on `solicitation_outreach.sending_at`.
6. `solicitation_batches.sending_started_at` is stamped in the first release transaction, CAS on NULL.
7. Drip pacing is a per-tick release budget. True yield-to-transactional is deferred.
8. The flag gates the RELEASE PHASE ONLY. The three sweeps and the backstop always run.

## Facts a resumed session must not re-derive

- **Spec §9's parent disposition rollup is already built.** `closeBatchIfSettled`
  (`src/lib/solicitation/outreach.ts`) writes the `send_batch_closed` step detail with
  `disposition` and all five counts. This feature adds no rollup code.
- **Migration 091 enforces the Judge split.** `solicitation_batches_send_ordering` says
  `sending_started_at IS NULL OR approved_at IS NOT NULL`, so a mid-drip downgrade is
  impossible at the database once decision 6 stamps that column at first release.
- **091's halt CHECK forces `halted_by IS NULL`** for `send_window_elapsed` and
  `batch_expired`. That is why the actor type widens.
- **The Lazy child run is created at `src/lib/solicitation/dispatch.ts:1752`, inside #899's
  tx1, BEFORE the `sending` CAS.** A crash therefore leaves both a `sending` Outreach row
  and a `running` child. The `unknown` sweep must terminalize both, in one transaction.
- **Release-level governor order is quoted from amendment B6's closing paragraph:**
  breaker → platform ceiling → account cap → `subscriptionGrantsFullAccess`, then the Judge
  split. B6's per-child item numbering is a different list and does not govern it.
- **Issue #895(b)** proves `latchHalt`'s `AND halted_at IS NULL` CAS is unreachable through
  both existing arms. The new arm skips `lockBatchForAction`, so the CAS becomes the only
  defense. The monotonicity property test is what pins it.

## Task order and parallelism

Task 0 (eval) → Tasks 1 and 2 **in parallel** (disjoint files, no edges) → Tasks 3, 4, 5, 6,
7 **serial** (all edit `release.ts`) → Task 8 → Task 9 → Task 10.

The first-task enforcement spot check runs after Task 0, before any parallel dispatch.

## Ship lane

RISK = high: ride `staging` first, verify the touched path, then open the PR to `main` and
PAUSE for explicit merge approval. No migration to apply in lockstep.
