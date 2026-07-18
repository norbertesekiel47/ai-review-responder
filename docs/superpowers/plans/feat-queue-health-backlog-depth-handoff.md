# Handoff — #480 queue-health backlog depth + alert

**Branch:** `feat-queue-health-backlog-depth`
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-queue-health-backlog-depth` (session cwd MUST stay here)
**Current step:** 4 — EXECUTE (subagent-driven, TDD). Steps 0–3 complete + user-signed-off.

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

## Task cursor (step 4)
- [ ] **T1** — `src/lib/shared/backlog-depth.ts` + test  (blocks T2, T3)  ← NEXT
- [ ] **T2** — alert half (checks.ts + config threshold + aggregation test)  [needs T1]
- [ ] **T3** — endpoint half (queue-health.ts best-effort backlog + worker/index.ts wiring)  [needs T1]
- [ ] **T4** — docs + glossary (CONTEXT.md, env-vars.md, .env.example, beta-launch-alerting.md)  [needs T2, T3]
- T2 ∥ T3 are parallelizable after T1.

## Remaining workflow steps after execute
- Step 5: `scripts/verify-gate.sh` (+ `pnpm build` via intake verification_commands) → green before review.
- Step 6: adversarial review (RISK=high) — user runs `/codex:adversarial-review`.
- Step 7: dual review (spec+correctness / standards) — reports to `docs/reviews/<branch>/`.
- Step 8: ride staging (worker change) → #474 burst smoke (`staging_verification` in intake) → PR to main, pause for merge approval.

## Deviations
None yet. Any mid-execution surprise → `docs/superpowers/plans/feat-queue-health-backlog-depth-deviations.md`.
