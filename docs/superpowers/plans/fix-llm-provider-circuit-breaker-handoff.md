# Handoff — `fix/llm-provider-circuit-breaker` (ticket F3 / P9)

**Resume with:** `/feature-resume fix/llm-provider-circuit-breaker` from a fresh
session **in the worktree** (`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/fix-llm-provider-circuit-breaker`).
Bootstrap order: this doc → intake → plan → deviations → review tables. Never
needs the prior transcript.

## Current step

**Step 4 (EXECUTE) — starting.** Steps 1–3 complete: intake locked, worktree +
ARM CHECK done, plan written and adversarially gated (codex, all findings
resolved), owner signed off 2026-07-20.

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
