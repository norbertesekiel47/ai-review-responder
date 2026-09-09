# feat/1184-admin-get-fold — handoff

A resumed session bootstraps from this file. It references sources BY PATH and
restates none of them.

## What this run is

`/feature` FULL lane for GitHub issue **#1184**, dispatched by the admin-split
orchestrator (a separate session). The owner is NOT reachable from this session:
never `AskUserQuestion` — an owner decision is written into the final report and
the run stops.

- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1184-admin-get-fold`
- Branch `feat/1184-admin-get-fold`, forked from `origin/main` at `6e14c8a2`
- RISK = high (auth) · SIZE = standard · SURFACE = mixed · `db_touching: false`

## Read, in this order

1. Ticket `gh issue view 1184 --json body -q .body` (the signed-off intent,
   together with `docs/adr/0025-dual-mode-admin-gate.md` D5).
2. `docs/superpowers/plans/feat-1184-admin-get-fold-intake.json` — LOCKED.
3. `docs/superpowers/plans/feat-1184-admin-get-fold-plan.md` — tracers T1–T6,
   the shared-shim API, and the three-round plan-skeptic appendix.
4. `docs/superpowers/plans/feat-1184-admin-get-fold-deviations.md` — D1–D3.
5. `docs/superpowers/plans/2026-09-08-admin-split-orchestrator-handoff.md`
   §3 (L2 row) and §4 for where this ticket sits in the map.
6. ADR 0025 D5/D6/D9/D10 and ADR 0028 D2. LOCKED — a contradiction is a STOP.

## State

`.feature/state.json` is authoritative. `surfaceAmendments=1`,
`planReviewRounds=3`.

**BLOCKED at step 5 (verify gate), HEAD `8818cd33`.** Tracers T1–T6 are all
committed and the gate is one row from green: every check passes except the
`test` row, which fails only in `src/lib/admin/__tests__/denorm-queries.test.ts`
(3 cases). That file is outside `allowed_edit_surface`, so fixing it is surface
amendment **#2** — a hard stop the orchestrator declared. The exact failure, the
exact fix, and why no production change avoids it are in deviations **D4**.

**On approval the remaining sequence is:** apply D4's fix (one file, ~15 lines,
no assertion changes) → `bash scripts/verify-gate.sh` → `--review` → step 6
read-back → step 7 wave with red team → 7.5 → step 8. Nothing else is
outstanding.

Codex plan-skeptic thread (resume ONLY for verification, never a new axis):
`01a0836d-6da6-75f2-9388-f2eeaa16ef58`.

Red-team sidecar path the checker expects:
`docs/reviews/red-team/feat-1184-admin-get-fold-e01d50/findings.{md,json}`.

## Step 8 authority already granted by the orchestrator

1. Ride `staging` from `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/staging-ride`
   (`git pull --ff-only origin staging` → `git merge --no-ff feat/1184-admin-get-fold`
   → `git push origin staging`). Never `reset --hard`. Staging equals `main` at
   `6e14c8a2`.
2. Staging smoke on `https://staging.repworth.net`: unauthenticated GET on each
   of the nine routes → 401. A bearer without a session cookie still meets
   `src/proxy.ts` branch 4's 401 — say so; #1185 opens it. No credentials are
   held for the staging admin accounts; do not try to sign in as them.
3. `gh pr create --draft` → `red-team-status.mjs` → `gh pr ready` → CI green →
   progress comment on #1184. **STOP. No merge.**

## Hard stops

Any contradiction with an ADR · a fourth gate shape · a migration or flag flip ·
a red gate after 3 rounds · a SECOND surface amendment (one is spent) · any
touch of impersonation beyond what the audit widening requires · any production
write.
