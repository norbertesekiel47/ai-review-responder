---
paths:
  - "src/lib/agents/**"
  - "src/lib/auto-approval/**"
  - "src/lib/escalations/**"
  - "worker/jobs/judge/**"
  - "worker/jobs/escalation-notice/**"
  - "worker/jobs/autonomy-suspended-notice/**"
  - "worker/jobs/pending-post-notice/**"
  - "worker/jobs/AutonomyAdminAlertWorker.ts"
  - "worker/jobs/live-draft-guard.ts"
  - "src/app/api/dashboard/agent-team/**"
  - "src/app/api/admin/autonomy/**"
---

# Agentic platform rules

## Read first

- design of record `docs/roadmap/2026-07-01-agentic-reputation-platform-design.md` — **§8 As-built status is the entry point** (what shipped WS1–WS8, deltas, gates, what's deliberately unbuilt) → per-WS specs in `docs/superpowers/specs/2026-07-*-ws*-design.md` + WS1 plan `docs/superpowers/plans/2026-07-01-agentic-platform-phase1-run-spine.md` (has the WS1–WS8 decomposition) + staging proof in `docs/runbooks/evidence/2026-07-2*-agentic-*.md`
- Run spine, personas, triage, trust dial + veto window, judge, governor, Copilot/Autopilot tiers — and planning Phase 2 (run engine + Solicitation agent) — all start from §8 of the design of record.
- File map: `docs/directory/lib-platform.md` § `agents/`; `docs/directory/lib-reviews-responses.md` § `auto-approval/` and § `escalations/`; judge and notice workers in `docs/directory/worker-jobs-*.md`.
- Skills: `approval-security` (approval links, tokens, the `/approve` route), `flag-flip` before touching any autonomy flag (`TRIAGE_ENABLED`, `ESCALATION_ENABLED`, `JUDGE_ENABLED`, `GOVERNOR_ENABLED`, `AUTO_APPROVAL_ENABLED`, `AUTOPILOT_PURCHASABLE`).

## Traps

- No trap clauses were moved from `.claude/CLAUDE.md` for this area; the binding constraints are invariants #3 (no unapproved posting; Judge availability is a posting precondition; `tierGrantsAutopilot`) and #4 (high-severity drafts are held, not notified), which stay in `.claude/CLAUDE.md`.
- Every persona action is recorded on the run spine via the single writer `src/lib/agents/run-spine.ts`; all autonomy flags are OFF in prod (ordered go-live flip per design doc §8.4).

## Rules

- Nothing was moved; see the design of record §8 for what shipped WS1–WS8, deltas, gates, and what is deliberately unbuilt.
