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

**BLOCKED at step 7.5 by the red-team round cap.** HEAD `c0d71f1c`.

- **Gate: GREEN** at HEAD, review mode — lint, typecheck, test, all 22 `ci:*`
  audits, build, `promised-tests` 48/48, `diff-coverage`. Amendments 1–3 all
  owner-approved and applied; deviations D1–D6 all verdict ACCEPT.
- **Review wave: complete.** Four axes, 18 findings, all triaged in
  `docs/reviews/feat-1184-admin-get-fold/triage.md` (2 rejected with argument).
- **Red team: 2 rounds, the maximum.** Sidecar status **CLEAR** — `p0_open` 0,
  `p1_open` 0, `p2_open` 7 recorded as follow-ups, 5 fixed, 1 rejected.
- **`red-team-status.mjs` REFUSES the `reviewed` transition**: "the tree moved
  since 083faf8d outside this run's own two artifacts — the red-team evidence is
  stale". The delta carries TWO non-report files, both without executable
  content: a **comment-only** edit to `scripts/ci/admin-aal2-audit.ts` fixing
  round 2's own P1 (a miscount, 5+1+2 over a list of seven), and this handoff
  document. (An earlier draft of this bullet said "ONE commit, `c0d71f1c`" — and
  writing that sentence created the second commit and falsified it. The gating
  agent caught it; it is left recorded rather than quietly corrected, because a
  handoff that hides its own drift is the thing this file exists to prevent.)
- **A third round is barred**: `.agents/skills/red-team/SKILL.md:70` — round-start
  "refuses a third round outright". The journal was NOT reset.

Both available paths needed the owner: leaving the P1 open fails the checker on a
high-risk open P1, and fixing it fails the checker on staleness. The fix was taken
so the code is correct; the staleness is the residue.

**Step 8 has NOT started** — no staging ride, no PR — because
`red-team-status.mjs` must pass before any external action.

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
