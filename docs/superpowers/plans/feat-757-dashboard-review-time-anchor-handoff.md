# #757 — handoff

Branch `feat-757-dashboard-review-time-anchor` ·
worktree `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-757-dashboard-review-time-anchor`

A resumed session bootstraps from this file → plan → deviations → review findings. It never needs
the prior transcript. **Prefix every Bash command with `cd <worktree-root> &&`** — the harness resets
cwd between calls.

## Lane

`RISK = high` · `SURFACE = mixed` · `SIZE = normal (full pipeline)` · `db_touching = true` (no migration —
the flag exists so the gate provisions the test DB and actually runs the live-DB suite; `pnpm
test:integration` does not hard-gate it, the #520 class).

RISK is deliberately **above the checklist floor** (no worker / webhook / migration / billing / auth).
Owner-confirmed at intake. Consequences: codex plan gate before implementing, three-axis review at
step 7, staging ride + smoke before the PR to `main`, and an explicit merge pause.

## Artifacts (read in this order — do not restate them here)

| What | Path |
|---|---|
| Locked intake (audit copy) | `docs/superpowers/plans/feat-757-dashboard-review-time-anchor-intake.json` |
| Locked intake (arming copy, gitignored) | `.feature/intake.json` — must stay byte-equal to the audit copy |
| Implementation plan (revision 2) | `docs/superpowers/plans/2026-08-11-feat-757-dashboard-review-time-anchor.md` |
| Deviations + amendment log | `docs/superpowers/plans/feat-757-dashboard-review-time-anchor-deviations.md` |
| Decision of record | `docs/adr/0019-kpi-review-time-anchor.md` |
| Consolidation decision | `docs/reviews/PATHFINDER-2026-08-10/03-unified-proposal.md` §P1 |
| Metric-by-metric evidence | `docs/reviews/PATHFINDER-2026-08-10/02-duplication-report.md` Part 2 |
| Glossary | `CONTEXT.md` → "Review-time anchor" |
| Ticket | `gh issue view 757` (its architecture-pass comment is the seed) |
| Staging smoke reference | `docs/runbooks/smoke-test-checklist.md` |

## State

- Phase record: `.feature/state.json` — authoritative. `planReviewRounds` survives session resumes;
  do **not** restart the count at 1 (#628).
- Plan review: round 1 REVISE (3 BLOCKER / 16 MAJOR / 4 MINOR, 22 accepted + 1 partially rejected,
  all folded into revision 2). Round 2 verification-only dispatched.
- Codex session (round 1): `019fefb9-a29b-7000-90dd-516b3a7eb83e`, model `gpt-5.6-sol`.
  Logs: `.feature/logs/codex-plan-round1.log`, `.feature/logs/codex-plan-round2.log`.
  Round-1 triage table lives in the plan's "Review appendix" — that is the durable record.
- Gate: last green run was **docs-only mode** (`.feature/logs/gate-checkpoint1.log`). That is a valid
  mid-feature checkpoint and **not** a review-ready signal — the real gate runs after T4.
- Amendments used: **1 of 2** (`scripts/ci/tenant-scope-allowlist.ts`, D1). A second amendment
  triggers abort criteria — stop and write a post-mortem instead of pushing through.

## Where to pick up

Step 3 is complete once round 2 returns `APPROVED` (or round 3, or an owner call after round 3 —
never loop past 3). Then:

1. `cd <worktree> && bash scripts/feature-state.sh set-phase plan_approved`
2. Step 4: `bash scripts/feature-state.sh set-phase executing`, then dispatch per-task subagents via
   `subagent-driven-development`. **T1 runs alone** — after it completes, diff
   `git status --porcelain` against `allowed_edit_surface`; an out-of-surface path means enforcement
   did not bind for subagent tool calls, so STOP and report.
3. T3 and T4 may then run as concurrent subagents (disjoint production files, no data dependency).
   Both depend on T2. Each verifies with **only its own suite** — the shared live-DB suite
   `review-time-anchor.integration.test.ts` stays partly red until both land, and is run once by
   whichever finishes second. Do not let a subagent "fix" the other's red test.
4. T5 → T6 serially. T7 (staging smoke) belongs to step 8, after the branch is on `staging`.

## Things a fresh session will otherwise get wrong

- **Plug-site line numbers moved.** Everything in issue #757's comment predates PR #767 (merged
  2026-08-11). The plan carries the re-derived post-#767 numbers; trust the plan, not the ticket.
- **Never reintroduce `Promise.all`** in `dashboard/service.ts` or `aggregate-queries.ts`. The
  sequential `settledInOrder` waves are #505's production fix and their comments say so.
- **Week assertions must not use `::text`.** postgres.js decodes `date` → JS `Date` and the mappers
  `String()` it, so a `'YYYY-MM-DD'` expectation never matches. Use the plan's `weekMarkers()`.
- **The aggregate anchor stays inside `LEFT JOIN … ON`.** In `WHERE` it becomes an inner join and
  locations with no reviews lose their zero-filled series.
- **Deleting `kpi/service.ts` requires the allowlist edit** (seven entries + baseline 408 → 401) or
  `ci:tenant-scope` fails on unused entries.
- **`src/lib/kpi/types.ts` survives** — the window vocabulary has many importers. Only the five
  Stack-A-only exports go.
- Historical records (`docs/reviews/**/blast-radius.md`, root `PLAN.md`) keep their references to
  the deleted route **by design**. Do not "clean" them.

## Step 8 (RISK = high lane)

Land on `staging` → run the plan's Task 7 smoke, evidence to
`docs/runbooks/evidence/2026-08-11-757-anchor-staging-smoke.md` → PR to `main` → all CI green →
**pause for owner merge approval**. No migration to apply in lockstep. After merge: `git pull
--ff-only`, re-sync `staging` per `deployment-guide.md` §"Re-sync staging" (a squash-merged
staging ride has diverged — `reset --hard origin/main` + `--force-with-lease`, never a sync merge),
`bash scripts/feature-cleanup.sh`, promote deviations lessons to lab-notes, `document-feature`,
domain sweep, increment the entropy counter in `.claude/reference/arch-review-log.md`.
