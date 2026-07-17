# Spec & Correctness Review — feat-archival-run-spine-retention

Adversarial, read-only review of `git diff main...HEAD` against the locked
`.feature/intake.json`. Verdict: **PASS — no >=80%-confidence correctness or
spec findings.** Two cosmetic stale-comment nits in the low-confidence appendix.

## Contract conformance (field by field)

| Contract field | Verdict | Evidence |
|---|---|---|
| goal (180d retention via batched DELETE + migration 079) | MET | ArchivalPoller arms 7/8 add straight batched DELETE; migration 079 adds the two supporting indexes. |
| non_goals (no rollup, no env window, no touch to audit logs / read.ts / governor / dashboard, no refactor) | MET | Diff adds only two arms in the existing shape; no audit-log tables, consumers, or abstractions touched. `AGENT_SPINE_RETENTION_DAYS` is a hardcoded const, matching the six existing arms' hardcoded intervals. |
| user_visible_behavior (daily prune of terminal runs >180d + cascade steps; outcomes own arm >180d; empty timeline for aged reviews; log line + saturation include both new tables) | MET | Runs arm cascades steps (FK `ON DELETE CASCADE`, migration 071 L51); outcomes arm independent; `Archived` log + `saturated[]` include `agent_outcomes`/`agent_runs`. Empty-timeline behavior is inherent to `getReviewTimeline` (no time filter). |
| invariants (running never deleted; 180 > 90 dashboard AND > 7 governor; getReviewTimeline/judge-store unaffected; LIMIT 5000 + SKIP LOCKED; audits green byte-exact; migration CONCURRENTLY non-transactional) | MET | See challenges 1–6 below. |
| edge_cases (SET NULL orphan prevention; outcomes-before-runs ordering; uniform-window no-permanent-orphan; bounded cascade fan-out; saturation reporting) | MET | See challenges 3–4 below. |
| tests_to_add (5 items) | MET | See challenge 7. All five present; unit suite runs green (19 passed). |
| allowed_edit_surface (6 files) | MET | Diff touches exactly the 6 allowed files (+ intake/plan/handoff docs under `.feature/` and `docs/superpowers/plans/`, which are process artifacts, not code). No drift. |

## Adversarial challenge results

**1. Is 180d safe for EVERY reader?** Verified by re-grepping all consumers of
`agent_runs` / `agent_outcomes` / `agent_run_steps` across `src/` and `worker/`:
- `getAgentTeamSummary` (`src/lib/agents/read.ts:397`) reads `agent_outcomes`
  windowed by `dashboardWindowParams(window).windowDays`. `WINDOW_PARAMS`
  (`src/lib/kpi/types.ts:76`) max = 90 (`90d`). 180 > 90. Safe.
- Governor (`src/lib/auto-approval/governor.ts:224`) LEFT JOINs `agent_outcomes`
  over `GOVERNOR_WINDOW_DAYS = 7`. 180 > 7. Safe.
- `getReviewTimeline` (`read.ts:320`) — per-review, no time filter; aged runs
  vanish → empty timeline. Declared in user_visible_behavior. Safe.
- `findLatestRunIdForReview` (`judge-store.ts:66`) — latest run by `started_at
  DESC LIMIT 1`, no interval filter; used for live/recent auto-post judging
  (runs within `JUDGE_LOOKBACK_HOURS`), never a >180d lookback. Safe.
- Offboarding purge (`purge-stages.ts`, `purge-verification.ts`) — account-scoped
  hard delete, independent of retention. Safe.
- No lifetime-aggregate / unbounded historical consumer of the spine exists
  (confirms non_goal #1). No reader breaks at 180d.

**2. Can arm 8 ever delete a running run?** No. Migration 071 L28-29 CHECK
`agent_runs_terminal_consistency`: `(status = 'running') = (ended_at IS NULL)`.
The arm filters `ended_at < NOW() - make_interval(days => 180)`, and `< NULL`
never matches. A running run therefore cannot enter the candidate set. There is
no path to set `ended_at` to a stale past value on a running row: doing so would
flip the CHECK (status would have to become terminal), and
`agent_runs_ended_after_started` (L34-35) additionally forbids `ended_at <
started_at`. Safe.

**3. Do outcomes (ON DELETE SET NULL) accumulate as orphans?** No. The
independent `occurred_at` arm prunes every outcome on its own age, regardless of
whether its parent run was deleted (link nulled) earlier. Even if the
`occurred_at <= ended_at` temporal assumption were ever violated, the result is
only a bounded lingering NULL-linked outcome that its own `occurred_at` arm
prunes later — self-correcting, never a permanent orphan. Edge case fully
handled.

**4. Concurrency / production timeout.** Both arms carry `LIMIT 5000` + `FOR
UPDATE SKIP LOCKED` (matches arms 4–6). Cascade fan-out from up to 5000 runs to
their steps is indexed — `agent_run_steps_index_uniq UNIQUE (agent_run_id,
step_index)` (migration 071 L61) leads with `agent_run_id`, so the FK cascade is
not a seq-scan. Well within the 30s Postgres.js `statement_timeout` and the
30-min cycle deadline. Both new arms sit inside the same single `try/catch` as
the existing six (sequential awaits, autocommit statements) — identical shape to
the existing arms, so an earlier arm's committed DELETE is never lost, and the
next daily cycle retries anything skipped. Matches the "same shape" contract.

**5. Tenant-scope allowlist.** The two new `sqlSnippet` values are the arm
templates with whitespace normalized and `${AGENT_SPINE_RETENTION_DAYS}` kept as
a literal placeholder — the same convention existing entries use (e.g.
`${GOVERNOR_WINDOW_DAYS}` at L124). Byte-exact to the arm CTEs; tightly scoped to
the full statement (not loose). `ALLOWLIST_BASELINE` bumped 393 → 395 (+2,
correct for two new arms). `pnpm ci:tenant-scope` gate passed.

**6. Migration correctness.** Non-transactional header present and accurate
(CONCURRENTLY cannot run in a tx; INVALID-index recovery documented). Both
statements use `CREATE INDEX CONCURRENTLY IF NOT EXISTS`. Partial predicate
`WHERE ended_at IS NOT NULL` correctly serves `ended_at < …` (predicate implies
non-NULL, mirroring 065's `idx_jo_recovery`). 079 is the correct next number
(head was 078); migrations-log head/next updated 078→079 / 079→080.

**7. Tests.** Regression guard (`ArchivalPoller.test.ts`) ties
`AGENT_SPINE_RETENTION_DAYS` to the REAL consumer constants —
`Math.max(...DASHBOARD_WINDOWS.map(w => dashboardWindowParams(w).windowDays))`
and `GOVERNOR_WINDOW_DAYS` — not a hardcoded 90/7, so raising a consumer window
past retention fails the build (strict `toBeGreaterThan`, which is safe: it fires
even at equality). Integration test asserts `indexdef` contains `occurred_at`;
partial `ended_at ... WHERE (ended_at IS NOT NULL)`; and the cascade guard
asserts `pg_constraint.confdeltype = 'c'` on the `agent_run_steps → agent_runs`
FK. All five `tests_to_add` present. Unit suite: 19 passed.

## Low-confidence appendix (<80% — cosmetic only)

- `ArchivalPoller.test.ts:129` — test description still reads "when all **6**
  targets return 0" (now 8 targets). Cosmetic stale label; assertion is correct.
- The block comment updated "Six … arms" → "Eight … arms" correctly, but the
  test-description "6" above was missed. No behavioral impact.
