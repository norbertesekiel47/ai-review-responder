# Plan — Agent-run-spine archival retention (ticket #485)

Intake contract: `.feature/intake.json` (authoritative scope).
Branch: `feat/archival-run-spine-retention` · RISK=high · backend · db-touching.

## Design orientation (codebase-design)

- **Module deepened, not added:** `runArchival` in `worker/background/pollers/ArchivalPoller.ts`
  is a deliberate flat list of independent batched-DELETE arms ("the length is the
  retention vocabulary, one block per table" — existing comment, `fallow-ignore` complexity).
  We add **two more arms in the identical shape** (arms 7 & 8). No new interface, no seam,
  no extraction — extracting an arm into a helper would add a name without hiding complexity
  (each arm is one SQL statement + one count), which design.md rejects.
- **No new consumer, no new read path.** `src/lib/agents/read.ts` and the auto-approval
  governor are untouched; this feature only prunes rows behind their existing windows.

### One design decision beyond strict precedent (flag for sign-off)

The six existing arms hardcode their window as an inline SQL literal (`INTERVAL '90 days'`).
The regression guard we promised (`tests_to_add[4]`) must assert the retention window
**exceeds every consumer window** — which requires the window value to be reachable from TS.

**Decision:** introduce a module constant `AGENT_SPINE_RETENTION_DAYS = 180` in
`ArchivalPoller.ts`, interpolated into both new arms as
`NOW() - make_interval(days => ${AGENT_SPINE_RETENTION_DAYS})`, and import it in the
regression test. This is the **exact precedent the auto-approval governor already sets**
(`GOVERNOR_WINDOW_DAYS = 7` + `make_interval(days => ${GOVERNOR_WINDOW_DAYS})`,
`governor.ts:5,72`).

- It does **not** violate the intake non-goal "no env-configurable per-table window" — the
  constant is compile-time, not an env var; there is no `*_RETENTION_DAYS` env override.
- It gives the retention window a **single authoritative owner** (engineering.md), makes the
  "retention > max consumer window" invariant executable, and self-fails the build if anyone
  later raises a dashboard window past 180d.
- Existing arms are left as literals (non-goal: no refactor of existing arms).

## Consumer facts that pin the numbers (from grilling)

| Consumer | Table(s) | Lookback | Effect of 180d retention |
|---|---|---|---|
| `getReviewTimeline` | runs+steps+outcomes, per-review | none (LIMIT 20 runs) | timeline empties for >180d-old reviews; review+response persist |
| `getAgentTeamSummary` | agent_outcomes | **max 90d** (`'90d'`) | fully served (180 > 90) |
| `governor`/`suspension` | agent_outcomes | **7d** (`GOVERNOR_WINDOW_DAYS`) | fully served |
| `judge-store.findLatestRunIdForReview` | agent_runs | latest/live run | unaffected |

FK shape (migration 071): `agent_run_steps → agent_runs ON DELETE CASCADE` (auto-prune);
`agent_outcomes → agent_runs ON DELETE SET NULL` (needs its own arm, else orphans).

**Orphan guarantee (corrected after adversarial review).** The guarantee that no
NULL-linked outcome accumulates does **not** rest on `occurred_at ≤ ended_at` (the schema
does not enforce that — `recordOutcome` and `completeRun` both default to `NOW()`; it holds
only by writer discipline). The real guarantee: **arm 7 prunes every outcome by its own
`occurred_at`, independently of run deletion** — so each outcome dies at `occurred_at + 180d`
whether or not its run was ever deleted. Outcomes-before-runs (arm 7 before arm 8) is
therefore an **efficiency nicety** (avoids wasted `SET NULL` writes when arm 8 would delete a
run whose outcomes arm 7 already removed), not a correctness requirement — the arms are
separate transactions with independent windows.

**Out-of-scope, noted:** a `running` run whose worker crashes keeps `ended_at IS NULL` and is
permanently exempt from arm 8 (correct — we never delete in-flight runs). The
`agent_runs_one_active_per_subject` partial-unique index means such a stuck run is *reused*
(ON CONFLICT) rather than duplicated per subject, so growth is bounded by one-shot subjects
with abandoned runs — rare. This is a run-lifecycle/reaper concern, **not** a retention gap;
expanding this feature to reap them would violate the intake. → **follow-up ticket**, not this PR.

## Tracer-bullet tasks

### Task 1 — `agent_outcomes` retention arm (full vertical slice) — no blocking edge
End-to-end: an outcome row older than 180d is pruned, index-backed, allowlisted, tested.
- `ArchivalPoller.ts`: add `export const AGENT_SPINE_RETENTION_DAYS = 180;` + arm 7 —
  batched DELETE `WHERE occurred_at < NOW() - make_interval(days => ${AGENT_SPINE_RETENTION_DAYS})`,
  `LIMIT 5000`, `FOR UPDATE SKIP LOCKED` (arms 5/6 precedent). Wire `agent_outcomes` count into
  the `Archived` summary object + the `saturated[]` list.
- `supabase/migrations/079_agent_run_spine_archival_indexes.sql`: create the file with the
  065-style non-transactional header + `CREATE INDEX CONCURRENTLY IF NOT EXISTS
  idx_agent_outcomes_archival ON agent_outcomes (occurred_at)`.
- `scripts/ci/tenant-scope-allowlist.ts`: byte-exact allowlist entry for the arm-7 DELETE
  (cross-tenant, no account scope — same justification as the notification_deliveries arm).
- Tests (`ArchivalPoller.test.ts`): arm 7 deletes rows with `occurred_at` > 180d; summary +
  saturation include `agent_outcomes`.

### Task 2 — `agent_runs` retention arm (full vertical slice) — sequenced after Task 1
(Shares the `Archived` summary block and migration 079 file — a merge/sequencing dependency,
not a correctness one; arm 7 before arm 8 is efficiency-only, see the orphan-guarantee note.)
- `ArchivalPoller.ts`: add arm 8 **after** arm 7 — batched DELETE
  `WHERE ended_at < NOW() - make_interval(days => ${AGENT_SPINE_RETENTION_DAYS})`
  (terminal-only: `status='running' ⟺ ended_at IS NULL`, so the predicate excludes running
  runs; steps prune via CASCADE), `LIMIT 5000`, `FOR UPDATE SKIP LOCKED`. Wire `agent_runs`
  count into summary + saturation.
- `migrations/079`: add `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_runs_archival
  ON agent_runs (ended_at) WHERE ended_at IS NOT NULL` (partial — the query predicate implies
  `ended_at IS NOT NULL`).
- `tenant-scope-allowlist.ts`: byte-exact entry for the arm-8 DELETE.
- Tests: arm 8 deletes terminal rows with `ended_at` > 180d and **never** running rows
  (`ended_at IS NULL`); summary + saturation include `agent_runs`; **CASCADE guard** — after
  arm 8 prunes a terminal run, its `agent_run_steps` rows are gone (protects the "no steps arm
  needed" decision, which rests solely on `ON DELETE CASCADE`).

### Task 3 — consumer-window regression guard + migrations-log — blocked by Tasks 1 & 2
- Test (`ArchivalPoller.test.ts` invariants block): import `AGENT_SPINE_RETENTION_DAYS`,
  `DASHBOARD_WINDOWS` + `dashboardWindowParams`, and `GOVERNOR_WINDOW_DAYS`; derive the max
  dashboard window as `Math.max(...DASHBOARD_WINDOWS.map(w => dashboardWindowParams(w).windowDays))`
  (**`WINDOW_PARAMS` is module-private — not exported — so map through the exported
  `dashboardWindowParams`**); assert `AGENT_SPINE_RETENTION_DAYS >` that max **and** `>
  GOVERNOR_WINDOW_DAYS`. (Guards the binding constraint; fails if a consumer window is later
  raised past retention.)
- `.claude/reference/migrations-log.md`: add the 079 entry (head 078 → 079), describing both
  indexes and the staging-first / CONCURRENTLY / non-transactional apply note.

## Verify gate (step 5)
`scripts/verify-gate.sh` (lint, typecheck, test, all `ci:*` audits) + intake
`verification_commands`: `pnpm ci:tenant-scope`, `pnpm ci:rls-audit`.

## Ship (step 8 — high-risk lane)
Migration 079 to **staging Supabase first** (CONCURRENTLY, single-transaction UNCHECKED),
verify no INVALID index, deploy staging worker, smoke the ArchivalPoller cycle, then PR to
`main` + prod migration in lockstep at promotion.
