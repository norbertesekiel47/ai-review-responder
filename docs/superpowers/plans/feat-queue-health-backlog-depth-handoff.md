# Handoff — #480 queue-health backlog depth + alert

**Branch:** `feat-queue-health-backlog-depth`
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-queue-health-backlog-depth` (session cwd MUST stay here)
**Current step:** 8 — SHIP (RISK=high lane). Steps 0–7 complete; verify gate GREEN at `321ca990`.

## Review outcomes (steps 6–7)
- **Step 6 adversarial (Codex):** needs-attention → 2 findings FIXED in `e5221006`. F-high: DB op now bounded by `SET LOCAL statement_timeout=4000` in `queryBacklogDepth` (releases the pooled connection; no pool-exhaustion amplification). F-medium: `checkBacklogDepth` isolated via `.catch` so it can't suppress the other 5 health checks. Triage: `docs/reviews/.../step6-adversarial-triage.md`.
- **Step 7 dual review:** both axes clean; 2 LOW findings FIXED in `321ca990` (stale timeout comment in queue-health.ts; added `docs/reviews/**` to surface). Spec agent verified every intake field faithful. Triage: `docs/reviews/.../step7-triage.md`.
- **Deferred follow-up ticket:** harden `runHealthChecks` to per-check isolation (`allSettled`) so ANY single check failure can't blank the cycle (pre-existing, out of #480 scope).

## Ship notes (step 8)
- RISK=high lane: ride staging → PR to main → PAUSE for explicit merge approval. NO migration (both partial pending indexes pre-exist) → no lockstep migration step.
- **#500 caveat:** HealthAlertPoller is PAUSED on staging, so the ALERT half + the #474 burst-drain drill cannot be fully smoked until it resumes. The ENDPOINT half (`GET /internal/queue-health` `backlog` key) IS verifiable on staging now. Burst/alert drills documented in `beta-launch-alerting.md` §4 for when #500 resumes.

## Resume bootstrap (read in this order)
1. `.feature/intake.json` — authoritative intake contract (drift detector).
2. `docs/superpowers/plans/feat-queue-health-backlog-depth.md` — the plan (T1–T4, blocking edges, module shape, F1–F8 resolutions).
3. `CONTEXT.md` — glossary (Capacity target #474, Outbox job; **Backlog depth** term to be ADDED in T4).
4. This doc for status.

## On resume in a fresh session
- `cd` into the worktree (above). Re-run the ARM CHECK from `/feature` step 2 (guard exit 2 on out-of-surface probe; stop-gate exit 2 with no gate-status.json). Both hooks were verified armed at setup.
- Then continue from the step-4 task cursor below.

## Status
- **Intent:** ticket-seeded from wayfinder map #472. 3 design forks locked with user: total-pending count, per-table same-1500 threshold (independent findings), `warning` severity.
- **Plan review (step 3, RISK=high):** Codex rescue adversarial review — 3 rounds, findings F1–F8 all resolved (best-effort bounded endpoint backlog built timed+caught BEFORE the queue loop; single-owner query; aggregation-wiring test; SQL-semantics-pinned test; `pnpm build` added per user AGENTS.md). Plan + intake committed (`3e767846`).
- **Enforcement:** feature-mode armed (`.feature/intake.json` committed as branch base). edit-surface-guard + stop-gate verified.

## Task cursor (step 4 — DONE)
- [x] **T1** — `queryBacklogDepth` module + test  → commit `56dcd498` (5 tests, ci:db-imports green)
- [x] **T2** — alert half (checkBacklogDepth + config threshold + aggregation test)  → commit `95bdedfc` (7 tests, config-coverage green)
- [x] **T3** — endpoint half (best-effort backlog + worker/index.ts wiring)  → commit `baf3f5fa` (13 tests, incl. fake-timer timeout + concurrent-start)
- [x] **T4** — docs + glossary  → commit `d018928b`
- Step 5 verify gate: GREEN (15/15 incl. pnpm build). `.feature/gate-status.json` passed.

## Remaining workflow steps after execute
- Step 5: `scripts/verify-gate.sh` (+ `pnpm build` via intake verification_commands) → green before review.
- Step 6: adversarial review (RISK=high) — user runs `/codex:adversarial-review`.
- Step 7: dual review (spec+correctness / standards) — reports to `docs/reviews/<branch>/`.
- Step 8: ride staging (worker change) → #474 burst smoke (`staging_verification` in intake) → PR to main, pause for merge approval.

## Deviations
None yet. Any mid-execution surprise → `docs/superpowers/plans/feat-queue-health-backlog-depth-deviations.md`.
