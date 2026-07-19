# Handoff — feat-505-differential-burst-drill

A resumed session bootstraps from THIS doc → the referenced files (below) →
nothing else. The prior transcript is not needed. All state is on disk.

## What this is

Ticket-seeded `/feature` run for the two open **#505** remainders on wayfinder
map **#472** (PR #506 already merged the cure). Two deliverables:
(a) a checked-in **health-bundle differential** proving the Promise.all-vs-sequential
pooler wedge; (b) a synthetic-load script + **capacity-burst drill** executed on
staging with recorded numbers. Remainder 2 (24h soak) is **#507**, out of scope.

## Read these (by path — do not restate)

| Need | File |
|---|---|
| Locked scope / drift detector | `.feature/intake.json` |
| Tracer-task plan (T1–T5, blocking edges) | `docs/superpowers/plans/feat-505-differential-burst-drill.md` |
| Env adaptation + spike + codex triage | `docs/superpowers/plans/feat-505-differential-burst-drill-deviations.md` (D0 enforcement, D1 OutboxPoller spike, D2 codex round-1 triage) |
| Shared domain language (use verbatim) | `CONTEXT.md` (Connection wedge, Backlog depth [alert threshold]; T4 coins Health-bundle differential + Capacity-burst drill) |
| Parent obligation | GitHub issue **#505** obligation-status comment |

## Environment / enforcement (CRITICAL — see D0)

- Session cwd can't be pinned to the worktree (sandbox resets it to the parent;
  `$CLAUDE_PROJECT_DIR` = parent). Hooks anchor on the **parent** `.feature/`.
- Bridge in place: parent `.feature/gate-status.json` is a **symlink** →
  worktree `.feature/gate-status.json`. `scripts/verify-gate.sh` runs IN THE
  WORKTREE and populates it; the parent-anchored Stop hook reads it through the
  symlink. ARM CHECK passed + confirmed live (D0).
- **All edits target the worktree** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-505-differential-burst-drill/…`.
  Inspect the parent with `git -C <parent>` / absolute reads; never `cd` away
  expecting it to stick.
- **Teardown ordering:** do NOT remove the worktree until after the final green
  stop (or first delete the parent `.feature/intake.json`) — else the symlink
  dangles and the Stop hook blocks.

## Current step

**Step 3 (PLAN) — plan gate in progress.** Codex round 1 → `REVISE` (9 findings,
all triaged in D2, plan revised + committed `fb33fdc7`). **Codex round 2
re-review is running** (resume agent `a2d0d603ab752b74a` / ref `059e61`).

### Immediate next actions (in order)

1. **Receive codex round-2 verdict.** If `REVISE`: triage (receiving-code-review),
   revise plan, re-submit (max 3 rounds total; after that surface disagreement to
   the user). If `APPROVED`: proceed.
2. **User sign-off on the revised plan** (step 3 requires it for RISK=high), INCLUDING
   the two intake amendments (positive-allowlist guard; db_touching clarification)
   and the D2#4 scope narrowing (drill proves outbox dispatch-drain, not full LLM
   pipeline throughput — confirm acceptable).
3. **Step 4 (EXECUTE)** via `superpowers:subagent-driven-development`: dispatch
   fresh per-task subagents in blocking-edge order — **T1 → {T2, T3} → T4**. Each
   subagent gets its plan slice + the CONTEXT.md glossary excerpt + "edits target
   the worktree root". TDD the pure helpers. Commit per task.
4. **Step 5 VERIFY GATE**: `scripts/verify-gate.sh` (in the worktree) → green
   `.feature/gate-status.json` (read by the Stop hook via the symlink).
5. **Step 6 REVIEW 0 (RISK=high)**: pause, ask the user to run
   `/codex:adversarial-review` on the branch.
6. **Step 7 REVIEW**: two parallel agents (spec+correctness / standards) on the diff.
7. **Step 8 SHIP**: normal PR to `main` for the CODE (T1–T4, inert tooling); the
   staging drill **execution (T5)** happens post-#507-soak (~2026-07-20 07:00 UTC)
   — record numbers, comment on #505.

## Task graph

```
T1 extract staging-guard.ts (positive allowlist) + rewire wedge-repro
 ├── T2 health-bundle-differential.ts (resolution-based detection, force-close cleanup)
 └── T3 burst-drill-load.ts (inject/release, hardened scoped-delete)
        └── T4 docs reconciliation + glossary
               └── T5 EXECUTE on staging (post-soak) + record numbers
```

## Guardrails (from intake — the drift detector)

- `allowed_edit_surface`: `scripts/{health-bundle-differential,burst-drill-load,staging-guard}.ts`,
  `scripts/wedge-repro.ts`, `scripts/ci/__tests__/**`, the two runbooks,
  `CONTEXT.md`, `docs/adr/**`, `.claude/reference/lab-notes.md`,
  `docs/superpowers/plans/**`, `.feature/**`. **`worker/**` is NOT in scope** —
  the differential IMPORTS the exported checks; touching worker runtime = stop +
  re-plan.
- No new dependency; no `package.json`/`pnpm-lock` change; `db_touching=false`.
- Property tests not required (no billing/approval/escalation state machine).
