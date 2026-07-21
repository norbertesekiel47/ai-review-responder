# Handoff — `fix/llm-provider-circuit-breaker` (ticket F3 / P9)

**Resume with:** `/feature-resume fix/llm-provider-circuit-breaker` from a fresh
session **in the worktree** (`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-llm-provider-circuit-breaker`).
Bootstrap order: this doc → intake → plan → deviations → review tables. Never
needs the prior transcript.

## Current step

**Steps 1–6 COMPLETE. Step 7 (dual review) IN PROGRESS.**

- **Step 6 (adversarial, Codex) DONE** → verdict needs-attention, 2 real findings,
  both triaged ACCEPT and FIXED in commit `864e7d5c`:
  - F1 (high): epoch-correlated `Admission` token — `shouldAttempt` returns
    `Admission | null`, `recordAttempt(admission, error?)` ignores stale-epoch
    outcomes (fixes concurrent stale-success-closes-during-cooldown).
  - F2 (medium): `shouldAttempt` clears provider state when disabled (no stuck
    half_open on in-process toggle); stale plan-doc flag-timing corrected.
  - Report + verdicts: `docs/reviews/fix-llm-provider-circuit-breaker/step6-adversarial-codex.md`
  - Deviations: `docs/superpowers/plans/fix-llm-provider-circuit-breaker-deviations.md` (D1/D2/D3)
- **Step 5 gate RE-RUN GREEN after fixes** (commit 864e7d5c): 9002 tests pass,
  all `ci:*` audits pass, `.feature/gate-status.json` fresh (newer than HEAD),
  stop-gate exit 0.
- **Step 7 dispatched**: two parallel review agents on `git diff 880435ba...HEAD`
  → reports to `docs/reviews/fix-llm-provider-circuit-breaker/step7-{spec-correctness,standards}.md`.
  Awaiting findings tables → triage → re-run gate → then step 8 SHIP.

### (historical) Steps 1–5

- Step 4 (EXECUTE) done — T1/T2/T3 built via subagent TDD.
- Step 5 (VERIFY GATE) **GREEN** — full suite (9187 tests) + every `ci:*` audit
  pass; `.feature/gate-status.json` passed:true, fresh (newer than HEAD).
- **Commits on branch** (newest last): `6d78fe05` T1 breaker module + tests ·
  T2 wire into runLlmTask · `70363d1c` T3 docs · `6b0d256d` flags accessor ·
  `4ce64963` route flag via config/flags.ts primitive + rename
  recordOutcome→recordAttempt.
- **Two surface amendments** (owner-approved, recorded in `.feature/intake.json`
  `surface_amendments`): added `src/lib/llm/flags.ts` and
  `src/lib/config/flags.ts` (`readFlagEnabledByDefault` primitive). Invariant #13
  (flag via accessor) + `ci:process-env` (raw read in baselined config/flags.ts)
  + spine-audit name collision all resolved.
- **Breaker method renamed** `recordOutcome`→`recordAttempt` (avoids the
  agent-run-spine `recordOutcome` audit collision — do NOT rename back).

### To resume at step 6/7 (fresh session)
1. Owner runs `/codex:adversarial-review` on the branch (user-invocable only) —
   step 6. Triage findings with `superpowers:receiving-code-review`; re-run
   `scripts/verify-gate.sh` after any change.
2. Step 7 — two parallel fresh review agents on the branch diff since fork point
   (`git merge-base origin/main HEAD`): (a) spec&correctness vs
   `.feature/intake.json` field-by-field; (b) standards via
   `/thermo-nuclear-code-quality-review` (fallback `/code-review` high). Full
   reports to `docs/reviews/fix-llm-provider-circuit-breaker/`, findings tables
   only in context. Re-run gate after fixes.
3. Step 8 ship — see below.

## Authoritative artifacts (read these, don't restate)

- **Intake contract:** `.feature/intake.json` (on-disk only — `.feature/` is
  gitignored per repo convention; it still arms the hooks). The drift detector.
- **Plan (tracer tickets T1–T3, seams, failover matrix):**
  `docs/superpowers/plans/2026-07-20-llm-provider-circuit-breaker.md`
- **Parent ticket:** `docs/superpowers/plans/2026-07-16-prod-hardening-followup-map.md` (F3)
- **Glossary:** `CONTEXT.md` — term "LLM provider circuit breaker" to be ADDED in T3.
- **Deviations (if any arise):** `docs/superpowers/plans/fix-llm-provider-circuit-breaker-deviations.md`

## Classification / lane

RISK=high (LLM seam, worker-side), SURFACE=backend, no DB/migration.
→ step 6 adversarial review of the BUILD applies; step 8 ships via staging first,
then PR to `main`, **pause for owner merge approval**.

## Scope note (critical — do not re-expand)

The BullMQ-concurrency half of F3 is ALREADY SHIPPED (#508/#511: explicit
concurrency + boot-enforced Summed LLM worker-slot cap ≤9). **This run builds
ONLY the in-process per-provider circuit breaker.** Do not touch
`worker/index.ts` concurrency, `assertSummedLlmWorkerSlots`, or the cap.

## Edit surface (hook-enforced)

`src/lib/llm/circuit-breaker.ts` (new), `src/lib/llm/run-task.ts`,
`src/lib/llm/__tests__/**`, `src/lib/config/worker.ts` (likely UNUSED — flag reads
`process.env` directly), `.claude/reference/env-vars.md`, `CONTEXT.md`.

## Locked design (from grilling — see plan for detail)

Per-provider breaker keyed by `LLMProviderId`; trip 5 consecutive transient
(`isTransientLLMError`); open 30_000ms; single half-open probe (success or
non-transient closes, transient re-opens); primary-open→fallback; **any provider
blocked ⟹ retryable `TransientLLMError`**, terminal only when every provider was
attempted and every attempt non-transient; Sentry `warning` on transitions only;
kill switch `LLM_CIRCUIT_BREAKER_ENABLED` default ON (only `'false'` disables);
hand-rolled, no new dependency.

## Enforcement caveat (this harness)

Edit-surface guard: fully armed, cwd-robust. Stop-gate: cwd-sensitive and this
harness resets cwd to the parent checkout — may not arm. **Compensate manually:
do not claim completion without a green `.feature/gate-status.json` from
`scripts/verify-gate.sh` produced AFTER the final commit.**

## Remaining steps

4. EXECUTE — subagent-driven TDD: T1 → T2 → T3 (blocking edges in plan). Commit per task.
5. VERIFY GATE — `scripts/verify-gate.sh` (lint/typecheck/test + ci:* audits; no build). Property tests mandatory.
6. REVIEW 0 — PAUSE, ask owner to run `/codex:adversarial-review` on the branch.
7. REVIEW — spec&correctness + standards agents; triage; re-run gate.
8. SHIP — staging first, PR to `main`, pause for owner merge approval; post-merge sweep + glossary/ADR-0005 fold.
