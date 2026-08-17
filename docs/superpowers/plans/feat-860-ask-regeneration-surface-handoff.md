# feat-860 — handoff (step 3 → step 4 boundary)

**Issue:** #860 — per-ask **Ask regeneration** surface (route + 3/day budget UI), resolving #629 deviation **D3**.
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-860-ask-regeneration-surface`
**Branch:** `feat-860-ask-regeneration-surface` · base `0101522a` · phase `plan_approved` · gate GREEN at `3eb51a01`
**Lane:** RISK = high · SURFACE = mixed · SIZE = normal (full pipeline)

## Read these, in this order — not this file's summary, and never the prior transcript

1. `.feature/intake.json` — the locked contract. 40 `tests_to_add` titles, matched VERBATIM by the gate.
2. `docs/superpowers/plans/2026-08-17-860-ask-regeneration-surface.md` — the plan. **Its two review appendices at the end are load-bearing**: they record why three design decisions are what they are, and reversing any of them re-opens a defect a review already caught.
3. `docs/superpowers/plans/feat-860-ask-regeneration-surface-deviations.md` — D1 (merge order with #859), D2 (surface amendment), D3 (`job_outbox` is not a tenant table).
4. Glossary: `CONTEXT.md` → **Owner approval**, **Ask exclusion**, **Halt latch**. **Ask regeneration** is coined by Task 2 and does not exist yet.

## Next action

**Step 4, EXECUTE.** Set `bash scripts/feature-state.sh set-phase executing`, then dispatch Task 1 (the eval task) **alone** — its completion is the enforcement spot check. After it passes, Tasks 2 and 3 may run in parallel, then 4 and 5, then 6. The graph is in the plan.

## Three things that will look wrong and are not

1. **`requestAskRegeneration` enqueues BEFORE it validates.** Deliberate. `regenerateAsk`'s swap locks the `job_outbox` row first (`markOutboxCompletedIfOwned` is its opening statement) and only then takes the advisory lock, so amendment B11's stated "advisory first" order is incomplete. A validate-first request path deadlocks against the worker it is enqueueing for. Refusals therefore abort by throwing `RegenRequestAbort`, because postgres.js commits on a normal return. Round 1, finding 1.
2. **The new `job_outbox` read in `batch-view.ts` carries no tenant predicate.** Correct: `job_outbox` is absent from `scripts/ci/tenant-tables.ts`, so the statement is unauditable and needs no allowlist entry. Do NOT join `solicitation_batches` to make it "look scoped" — that pulls a tenant table in and demands keys on a query whose proof lives upstream. Deviations D3.
3. **The exclusion set is keyed on `askId`, not `outreachId`.** A regeneration mints a new outreach id. Keying on the outreach id and pruning stale entries — the plan's own round-1 approach — silently re-selected the contact, which could send a message the owner had deselected. Round 1, finding 6. There is no `pruneExclusions`.

## Coordination — check before Tasks 4 and 5

Merge order is **`codex/859-tenant-scope-subqueries` before this branch** (owner decision, D1). #859 rewrites `approval.ts` and `batch-view.ts` — the two files Tasks 4 and 5 touch — collapsing `lockBatchForAction`'s two-statement split and `approveBatch`'s anti-join. `lockBatchForAction`'s signature does not change, so Task 4's reuse is unaffected either way.

Before starting Task 4 or 5, check whether #859 has merged to `main`. If yes, rebase and write the new SQL in the post-fix convention. If no, write it scanner-shaped; #859 already reverts the #629 workarounds and will take one more.

## Budgets

- **Surface amendments: 1 of 2 spent** (`src/lib/agents/*`, for the `ask_regeneration_requested` step key). A second triggers the abort criteria.
- **Plan review rounds: 3 of 3 spent.** The loop is closed; do not dispatch another plan review.
- **Gate-fail rounds: 0 of 3.**
- Intake field changes so far (`tests_to_add` 32 → 40, two retitles, `estimated_test_lines` 1200 → 1600) are deviations, **not** amendments — they do not count against the budget.

## Codex sessions (plan review, all read-only)

| Round | Thread / artifact | Verdict |
|---|---|---|
| 1 | `01a0118d-5b8a-7a72-9743-0d4524f913cd` · `scratchpad/codex-plan-review.md` | REVISE — 10 findings, 1 CRITICAL |
| 2 | `scratchpad/codex-round2.md` | REVISE — design fixes confirmed; tests not carried into tasks |
| 3 | `scratchpad/codex-round3.md` | REVISE — 429 stub missing; deadlock test self-hung. Both fixed |

Scratchpad paths are session-local and will not survive a `/clear`. Everything needed to execute is in the plan's review appendices, which are committed.

## Step 8 when the time comes

RISK = high: ride `staging` first. **The feature ships inert** — `SOLICITATION_SEND_ENABLED` is unset in every environment, so the verification is that the Requests screen stays byte-identical to watch-mode. **Do not flip the flag**: `assertSolicitationSendEnv` requires four vars that do not exist in staging, and standing up the sending identity is #633, still open. No migration, so rollback is a plain revert.
