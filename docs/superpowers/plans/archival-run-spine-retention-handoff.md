# Handoff — Agent-run-spine archival retention (ticket #485)

Branch: `feat/archival-run-spine-retention` (sibling worktree at
`../RepWorth-worktrees/feat-archival-run-spine-retention`). RISK=high · backend · db-touching.

A resumed session bootstraps from the files below — it never needs the prior transcript.
Re-enter with `/feature-resume feat/archival-run-spine-retention` (re-runs ARM CHECK).

## State: step 8 (ship) — staging ride DONE + verified; PR open + CI green; awaiting merge approval

- Steps 1–5 complete; 6 folded into 7 (Codex quota-blocked at plan time; a later
  `/codex:adversarial-review` on the branch flagged only this handoff doc — reconciled here);
  7 triaged.
- **Verify gate GREEN** (16/16) — `.feature/gate-status.json`; re-run after this handoff fix so
  it stays newer than HEAD.
- **Step 7 reviews** (`docs/reviews/feat-archival-run-spine-retention/`): spec+correctness =
  no ≥80% findings; standards = 2 Low (stale 6→8 comment/label) accepted + fixed. Triage in
  `triage.md`.
- Feature-branch commits: intake → plan/handoff → surface-amend → Task1 → Task2 → Task3 →
  review-fixes (tip `e870e6d4`, pre-handoff-fix).

### Staging ride — COMPLETE and verified (per-artifact status)

- **Feature branch pushed** → `origin/feat/archival-run-spine-retention` (pre-push hook green).
- **Landed on `staging`** → `origin/staging` = **`9c517ff1`** (`merge: land agent-run-spine
  archival retention on staging`; parent = feature HEAD `e870e6d4`). Push auto-deployed the
  full staging stack.
- **Migration 079 applied to staging Supabase** (`kubdiqdhqbhwmqfditeg`), non-transactionally
  via the direct/session connection (NOT the pooler). **Both indexes verified
  `indisvalid=true`**: `idx_agent_outcomes_archival (occurred_at)`,
  `idx_agent_runs_archival (ended_at) WHERE (ended_at IS NOT NULL)`. No INVALID index.
- **ArchivalPoller smoke on staging** — `EXPLAIN` (with `enable_seqscan=off`) of both arm-7 /
  arm-8 retention predicates confirms each uses its archival index on the live staging schema.
- **PR to `main`**: [#497](https://github.com/RepWorth/ai-review-responder/pull/497) — all 14
  CI checks green.

> **Ordering note (Codex finding #2).** On staging the executed order was push→(worker
> auto-deploy)→apply-migration→verify→smoke. That is safe here only because migration 079 is
> purely-additive indexes and the arms run correctly without them (a brief index-less window =
> seq-scan of near-empty staging tables, no timeout risk), AND the end state was re-verified
> (indexes valid + EXPLAIN smoke). It is NOT the canonical order — see the prod rule below.

### Remaining — awaiting explicit user merge approval

Enforce **migration-before-deploy** for prod (do NOT repeat staging's push-first order):
1. Apply migration 079 to **prod Supabase** (`udeyaqnvpojbwgoaxwdg`) non-transactionally over
   the direct/session connection; **confirm both indexes exist with `indisvalid=true`** before
   proceeding.
2. Merge PR #497 → `main` (this is what auto-deploys the prod worker — so it happens AFTER the
   indexes exist).
3. Post-merge: `git pull --ff-only` main, ff `staging` onto `main`, remove worktree + delete
   branch, `document-feature` sweep, `domain-modeling` term fold-in (CONTEXT.md), increment the
   `arch-review-log.md` merge counter.

Blocked on: user merge approval only. All prior artifacts above are done + verified.

## (historical) State at step 3 → 4 boundary (plan locked, execution starting)

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
