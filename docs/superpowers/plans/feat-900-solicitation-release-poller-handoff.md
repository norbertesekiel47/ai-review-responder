# Handoff — feat-900-solicitation-release-poller

A resumed session bootstraps from this file. **It never needs the prior transcript.**

**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-900-solicitation-release-poller`
**Branch:** `feat-900-solicitation-release-poller` · **Issue:** #900
**Lane:** RISK = high · SURFACE = backend · `db_touching: true` · **no migration**
**Phase:** `reviewed` — steps 0–7 COMPLETE. **Next action: step 8, ride staging.**

## Reconciliation — run the checks, they should agree

Self-verifying by design; no hardcoded SHAs, because the commit writing this file changes HEAD.

| Check | Expected |
|---|---|
| `.feature/state.json` `headSha` | **equals** `git rev-parse HEAD` |
| `lastGreenGateSha` | **equals** HEAD — gate GREEN, 28 rows, `--review` mode |
| `phase` | `reviewed` **or** `gate_green` — see the note below |
| `planReviewRounds` | 3 (plan gate CLOSED at APPROVED) |
| `branchReviewRounds` | **3 — THE CAP. Do NOT open a round 4.** |
| `git status --porcelain` | empty |
| intake copies | byte-identical |
| `git rev-list --count HEAD..origin/main` | 0 |
| `scripts/arm-check.sh` | ARMED |
| `it.fails` markers | 0 |

**On `phase`:** `scripts/verify-gate.sh` stamps `gate_green` on every green run, overwriting `reviewed`. `gate_green` here does NOT mean step 5 is the current step. Trust this document.

**The one non-PASS row is expected:** `reclassify` WARN. Production is 2.1x its 820-line estimate. The trigger fired, the owner was given three options (proceed as one PR / split into stacked PRs / tear down and re-plan as an epic) and **chose to proceed as one PR** on 2026-08-22. Recorded in the deviations file. Do not re-litigate it; do not "fix" it.

## What shipped

`SolicitationReleasePoller` — five phases in a fixed order, every 60s:
1. `unknown` sweep (D12d) — **this is what discharges issue #915**
2. `send_window_elapsed` latch · 3. `batch_expired` latch (B7)
4. Release phase — the ONLY phase `SOLICITATION_SEND_ENABLED` gates
5. Backstop join — a second CALLER of `closeBatchIfSettled`, never a second implementation

## Step 8, and nothing before it is outstanding

1. **Ride staging first.** Land the branch on `staging` (push → full stack auto-deploys). **No migration to apply** — 091 and 110 already carry every column, CHECK member and index this feature writes.
2. **Verify on staging.** Smoke the touched path. `SOLICITATION_SEND_ENABLED` stays OFF — the release phase is inert, so what is verifiable is that the three sweeps and the backstop run and the poller registers cleanly at boot. Do NOT flip the flag; #915 governs that and this branch does not discharge the flip decision, only its blocker.
3. **Open the PR to `main`,** confirm GitHub CI green, then **PAUSE for the owner's explicit merge approval.** Do not merge on your own judgment.

## After merge — obligations already identified, do not rediscover them

- `git pull --ff-only` on local `main`; realign `staging` per `deployment-guide.md` §"Re-sync staging" (**squash-merge means the branches diverged — `git reset --hard origin/main` + `--force-with-lease`, NOT a sync merge**).
- `bash scripts/feature-cleanup.sh` (dry run, review, then `--apply`).
- **PROMOTION OBLIGATION, recorded in the round 3 triage:** the false-rationale pattern goes into `.claude/reference/lab-notes.md`. Six times on this branch a load-bearing rationale in a comment was FALSE; all six were claims about **this module's own internal structure**, while every cross-file claim was correct. That file is already on `allowed_edit_surface` (amendment 4).
- `document-feature` skill sweep · final `domain-modeling` pass · increment the merge counter in `.claude/reference/arch-review-log.md`.

## Read these, by path — do not restate them

| Artifact | Path |
|---|---|
| Intake contract (39 tests, 21 surface entries) | `.feature/intake.json` |
| The plan | `docs/superpowers/plans/2026-08-22-solicitation-release-poller.md` |
| **Deviations — 33 entries, step 6 read-back at the top** | `docs/superpowers/plans/feat-900-solicitation-release-poller-deviations.md` |
| Review rounds 1–3 + triage verdicts | `docs/reviews/feat-900-solicitation-release-poller/branch-round{1-spec,1-standards,1-adversarial,3-final}.md` |
| Blast radius | `docs/reviews/feat-900-solicitation-release-poller/blast-radius.md` |
| Glossary | `CONTEXT.md` — Halt latch, Owner approval, Send breaker, Dispatch gate, Batch state, Lazy child, Settled batch |

## Review outcome — 19 accepted findings across 3 rounds, all resolved

| Round | Found | Accepted | Fixed | Deferred | Rejected |
|---|---|---|---|---|---|
| 1 | 12 | 11 | 6 | 3 → #919 | 1 |
| 2 | 5 | 5 | 5 | 2 → #919 | 0 |
| 3 | 2 | 2 | 2 | 0 | 0 |

**The rejected one:** module shape (a 1206-line single-export file). The standards agent — whose axis it is — examined it and declined to flag it, naming 652 code vs 496 comment lines, a narrow interface, and no seam with a second caller. The adversarial agent asserted the opposite without naming the seam. Argument beat assertion. **Do not re-open it.**

**Two re-grades, both by the orchestrator, both defensible:** the detached-cycle cap overrun HIGH → MEDIUM (counters re-read committed `queued_at` per cycle, so the overrun is bounded by the detached cycle's uncommitted rows; round 2's adversarial agent was told to attack this re-grade and UPHELD it), and the `account_cap` silence Low → MEDIUM (the field's whole purpose is the distinction it had lost).

## Five facts a resumed session must NOT re-derive

1. **`commitSendTerminal` is ONE transaction** (`dispatch.ts:1103`, called inside `sql.begin` at `:1970`) containing the Outreach terminal UPDATE, the child `completeRun`, the outbox completion AND `closeBatchIfSettled`. That is why the "halted-batch join leak" is UNREACHABLE, not merely harmless — preserve that property.
2. **The P4 capped-account arm can only UNDER-exclude.** `resolveAccountDailySendCap` is `Math.min(configured ?? 10, 10)`, and the CTE predicate is character-identical to `countAccountDispatchAttemptsToday`. Verified independently twice.
3. **`alertPhaseFailure` RETHROWS.** Control flow is unchanged, which is what keeps `readSendBreaker`'s fail-closed throw working as a halt signal. Do not convert it to swallow.
4. **The release phase has TWO isolation units** — the account for the two gate reads, the batch for everything else. Both are stated at `release.ts:1108`.
5. **`sending_started_at` is nullable and deliberately absent from the candidate null-guard.** A comment once claimed otherwise; tightening the guard drops every first-release candidate.

## Deferred, filed, do not fix here

- **#917** — B14's halt-aware send window / `platform_halt` reason (needs a 091 CHECK widening) + the §7.1 yield-to-transactional obligation.
- **#918** — no CI audit enforces the `env-vars.md` registry row; the house rule is convention only.
- **#919** — release-phase counter object + `stopPhase`; `seedUpload` hand-copied in SIX test files; no `CONTEXT.md` term for the release lane; the sub-default configured-cap gap; the subscription gate's structural shape.

## Amendment budget: 4 of 2, all owner-approved

Three were one intake defect with three symptoms (the four-registry root cause, promoted to lab-notes). The fourth was the documentation-only edit that promoted that lesson. **A fifth is not another exception to request — stop and surface it as a re-plan decision.**
