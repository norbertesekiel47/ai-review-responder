# Handoff — feat/owner-operator-run-a (Owner Operator v1, Run A: the turn foundation)

Everything a resumed session needs is on disk. Read in this order; never re-read the prior conversation.

| What | Path |
|---|---|
| Spec of record (map, ticket-seeded) | `docs/roadmap/2026-09-11-owner-operator.md` (§2, §3.4, §4, §5, §6.1–6.2, §7, §9, §10, §11, §14) |
| Locked intake (drift detector; 5 surface amendments recorded) | `docs/superpowers/plans/feat-owner-operator-run-a-intake.json` |
| Plan (T0–T8, APPROVED after 3 Codex rounds) | `docs/superpowers/plans/feat-owner-operator-run-a-plan.md` |
| Plan review ledger | `docs/reviews/feat-owner-operator-run-a/plan-review.md` |
| Review wave rounds 1–2 (axes, Codex, triage verdicts) | `docs/reviews/feat-owner-operator-run-a/review-round-1.md`, `review-round-2.md`, `spec-correctness*.md`, `standards-maintainability*.md`, `codex-adversarial.md`, `blast-radius.md` |
| Red team, closed run (3 rounds, CLEAR at `d21db9ecd`, pre-refactor tree) | `docs/reviews/red-team/feat-owner-operator-run-a-b83a4f-rounds1-3/findings.{md,json}` — preserved history |
| Red team, FRESH run (3 rounds, CLEAR at `7583062a4`; P2-4 open) + triage | `docs/reviews/red-team/feat-owner-operator-run-a-b83a4f/findings.{md,json}`, `docs/reviews/feat-owner-operator-run-a/review-round-3.md` |
| Glossary (use terms verbatim) | `docs/context/owner-operator.md` (row in `CONTEXT-MAP.md`) |
| Deviations (step-6 read-back done; later entries appended by fixers) | `docs/superpowers/plans/feat-owner-operator-run-a-deviations.md` |
| Phase / rounds / gate truth | `.feature/state.json`, `.feature/gate-status.json`, `.feature/progress.json` |
| PR (open, ready for review) | https://github.com/RepWorth/ai-review-responder/pull/1270 |

## Where the run is (2026-09-12, end of session 2)

**CLOSED 2026-09-12.** PR #1270 squash-merged as `d8e3f334f` (all checks green). Migration 120 applied to production and introspection-verified against staging. `staging` realigned to `main` (`d8e3f334f`). Worktree removed by `scripts/feature-cleanup.sh`. Post-merge docs sweep in the `docs/owner-operator-run-a-closeout` PR. What Run B's first docs commit still owes: red-team P2-4 and the rule-11 Sentry build (see the spec §14 and `beta-launch-alerting.md` row 11). The lines below describe the state at the merge pause and stay as history.


- Worktree `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-owner-operator-run-a`, branch `feat/owner-operator-run-a`. **Fork moved to `10c9444a9`** (origin/main) — the branch merged main at `5b223e33f` BEFORE the fresh red-team pass (owner decision; PR #1270 was `BEHIND`, so the update was owed at merge time regardless). 0 behind main at session end.
- Phase `reviewed`, set by hand under owner authorization after `transition-state.mjs` refused on a missing deviations verdict line (the full story and the re-verification command: deviations.md "session 2 closeout"). Gate GREEN with a current fingerprint at the final HEAD (`.feature/gate-status.json`).
- **Red team, fresh run** (`docs/reviews/red-team/feat-owner-operator-run-a-b83a4f/`, triage `docs/reviews/feat-owner-operator-run-a/review-round-3.md`): round 1 at `5b223e33f` → 1 P0 (the `claimTurn` lease predicate — the spend guard — had no oracle), 7 P1, 1 P2; all fixed in `3a377f656`; round 2 re-killed every guarded line (`0cfee39e0`, CLEAR); round 3 (owner-authorized, doc-only) fixed P2-2/P2-3 (`7583062a4`, sidecar `fdd129179`, CLEAR). **P2-4 open, non-blocking** (runbook triage hop via `outbox_id`). CLEAR is a SCOPE claim: 237 never-executed rows are `excluded` under the round-2 scope rule (owner decision); the sidecar says so.
- **On resume `red-team-status.mjs` reports "tree moved since 7583062a4".** That is the verdict-line + handoff commit, by design. Verify with `git diff --stat 7583062a4 HEAD -- . ':(exclude)docs/reviews/red-team/**'` → exactly `…-deviations.md` and `…-handoff.md`. If anything else appears, the evidence IS stale — go to step 6.5.
- Surface amendments: **5** (#5 = `health-alert/checks.ts`, its unit test, `beta-launch-alerting.md`, owner-approved for the `agent_turn` alert-path fixes). Intake SHA-256 `43b0b7ef…`; both copies identical.
- `pnpm ci:fallow:coverage` (CI's variant, with the gate's merged coverage) → no issues. `pnpm ci:fallow` without coverage shows a CRAP estimate on the unchanged `postTurn` route — not the CI signal.
- PR #1270: pushed at the end of session 2 (verify `git rev-parse origin/feat/owner-operator-run-a` = local HEAD); PR body updated with the fresh-run sections. Checks: watch `gh pr checks 1270`.
- Staging: migration 120 applied and introspection-verified (session 1); `staging` carries the branch at `14c47445b` as merge commit `493c65970`. Commits after that are tests, one allowlist entry, one import swap and docs — nothing that needs a second staging ride.
- Codex sessions non-resumable on this machine (session 1 note still true). Model routing (owner instruction): Fable orchestrates and reviews; every writing subagent runs on `opus`.

## Resume checklist — what the next session does

1. `cd` to the worktree; `git status --porcelain` empty; `bash scripts/arm-check.sh` ARMED; run the stale-evidence diff above.
2. If PR #1270 checks are not all green: read the failing job, fix ONLY that, re-run the gate, note that the red-team diff now includes the fix (a code fix reopens step 6.5).
3. **Merge pause — owner action.** `gh pr merge 1270 --squash` (ruleset: branch up to date — it is, unless main moved again; if it did, take main by merge and re-run the gate; a docs-only main commit does not touch red-team scope). At promotion apply migration 120 to PRODUCTION `udeyaqnvpojbwgoaxwdg` (same SQL; `.claude/reference/migrations-log.md`: replace LOCAL-ONLY with the applied sentence; verify by introspection: RLS on, FORCE off, 0 policies, `has_table_privilege` false for `anon`/`authenticated`, both uniques, indexes). Then realign `staging` per `deployment-guide.md` § Re-sync staging (staging has a merge commit → `reset --hard origin/main` + `--force-with-lease`; destructive for the auto-mode classifier — owner runs or allows it).
4. Post-merge (step 8 tail): `git pull --ff-only` on local `main`; `bash scripts/feature-cleanup.sh` dry run then `--apply`; promote the lab-note candidates listed in deviations.md "session 2 closeout" (`.claude/reference/lab-notes/README.md` § How to add); `document-feature`; arch-review-log counter; `progress.mjs step ready done`, `live-view.mjs snapshot`/`stop`.
5. **Run B's first docs commit** owes: P2-4 (runbook triage step: `outbox_id` → `job_outbox.payload` → `agent_turns.status`), and the rule-11 Sentry build step (click-path row 11) before `OWNER_OPERATOR_ENABLED` is flipped anywhere.

## Decisions locked in the grill (do not reopen)

Same model pair as `reply_generation`, temperature 0.2, 1200 tokens, zod output schema on the seam · lease 180 s, predecessor stall 20 min, wait 10 s · star bands per location `{ total, byStar: {1..5} }` plus an account aggregate · new server-only flag `OWNER_OPERATOR_ENABLED`, default off; flag-on LLM envelope cap 11 → 12 with an ADR 0005 amendment · Run A registers only the four voice operations, the three reads, and `record_unsupported_request`.

## Phase cost (session 1, from `phase-cost.mjs`)

| Step | Input tokens | Output | Wall |
|---|---|---|---|
| intake locked | 17.4M (99% cached) | 61K | 16 min |
| plan approved | 38.1M | 88K | 115 min |
| execute tracers | 29.9M | 42K | 84 min |
| verified gate | 23.4M | 21K | 13 min |
| review | 46.0M | 59K | 148 min |
| review-ready (so far) | 3.0M | 3K | 4 min |
| total | 158.1M | 275K | 380 min |

Most expensive step: review (three axes + Codex + three red-team rounds, then the fallow gate). The thing to trim next: run `pnpm ci:fallow` before the review wave, and open the red-team journal cap question with the owner before round 3 rather than after.

## Phase cost (cumulative through session 2, `phase-cost.mjs` at the ship step)

| Step | Input tokens | Output | Wall |
|---|---|---|---|
| intake locked | 17.4M (99% cached) | 61K | 16 min |
| plan approved | 38.1M | 88K | 115 min |
| execute tracers | 29.9M | 42K | 84 min |
| verified gate | 23.4M | 21K | 13 min |
| review | 85.4M | 101K | 330 min |
| total | 333.2M | 476K | 561 min |

Session 2 alone: three red-team rounds (fresh run), one fixer, five gate runs, ~180 min of review wall clock. What to trim next: give summary sections in the deviations file a verdict line when they are written; check `pnpm ci:fallow:coverage` (not `ci:fallow`) before the wave; decide the round-2 inventory scope rule up front instead of after the verifier reports INCOMPLETE_BUDGET.
