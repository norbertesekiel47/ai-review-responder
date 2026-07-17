# Handoff — Agent-run-spine archival retention (ticket #485)

Branch: `feat/archival-run-spine-retention` (sibling worktree at
`../RepWorth-worktrees/feat-archival-run-spine-retention`). RISK=high · backend · db-touching.

A resumed session bootstraps from the files below — it never needs the prior transcript.
Re-enter with `/feature-resume feat/archival-run-spine-retention` (re-runs ARM CHECK).

## State: step 3 → 4 boundary (plan locked, execution starting)

- Intent + scope: **`.feature/intake.json`** (committed; authoritative drift detector).
- Plan (tracer bullets, design orientation): **`docs/superpowers/plans/archival-run-spine-retention-plan.md`**.
- Ticket: GitHub #485 (parent map #472). Glossary: **`CONTEXT.md`** (run-spine retention term to be folded in at step 8).

## Decisions locked (grill + adversarial plan review)

1. **180-day uniform window** across all three tables. Binding floor = 90d (max dashboard
   `getAgentTeamSummary` window); governor/suspension = 7d; both cleared.
2. **Straight DELETE, no rollup** — no lifetime-aggregate consumer exists (unlike api_costs).
3. **Migration 079** — two `CREATE INDEX CONCURRENTLY` (non-transactional, 065-style header).
4. **`AGENT_SPINE_RETENTION_DAYS = 180` module constant + `make_interval`** (governor precedent),
   so the "retention > every consumer window" invariant is test-guardable. Not an env knob.
5. Orphan guarantee rests on arm 7 pruning outcomes by their **own `occurred_at`**, independent
   of run deletion (NOT `occurred_at ≤ ended_at`, which the schema doesn't enforce). Arm-order
   (7 before 8) is efficiency-only.
6. **Out of scope:** reaper for crashed `running` runs (ended_at NULL forever) → follow-up ticket.

## Tasks (sequential — shared ArchivalPoller summary block + migration 079 file)

- **Task 1** — `agent_outcomes` arm 7 + migration 079 (outcomes index) + allowlist entry + tests.
- **Task 2** — `agent_runs` arm 8 (terminal-only, steps cascade) + runs index + allowlist + tests
  incl. **CASCADE guard**.
- **Task 3** — consumer-window regression guard (derive max via `dashboardWindowParams`, NOT the
  unexported `WINDOW_PARAMS`) + migrations-log 079 entry.

## Enforcement status (ARM CHECK passed)

- edit-surface guard: ARMED, file-anchored to worktree. Out-of-surface → exit 2.
- stop gate: ARMED, anchors to worktree root (confirmed live). Needs green
  `.feature/gate-status.json` (from `scripts/verify-gate.sh`, step 5) before the session can end.
- Allowed edit surface (hook-enforced): `ArchivalPoller.ts` (+test),
  `supabase/migrations/079_agent_run_spine_archival_indexes.sql`,
  `.claude/reference/migrations-log.md`, `scripts/ci/tenant-scope-allowlist.ts`.

## Gate (step 5)
`scripts/verify-gate.sh` + `pnpm ci:tenant-scope` + `pnpm ci:rls-audit`.

## Ship (step 8, high-risk lane)
Migration 079 → staging Supabase first (CONCURRENTLY, single-transaction UNCHECKED; verify no
INVALID index), staging worker smoke, then PR to `main` + prod migration in lockstep.
