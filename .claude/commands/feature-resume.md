---
description: Resume an in-flight /feature run from its on-disk state — handoff doc, intake contract, plan, deviations, review verdicts
argument-hint: <branch>
---

# Feature Resume

Branch: $ARGUMENTS

Resume the `/feature` workflow for this branch from disk. Everything a
resumed session needs is in files — never ask for the prior transcript.

1. **Enter the worktree**: `../RepWorth-worktrees/<branch>/` (locate via
   `git worktree list` if not there). `cd` to the worktree root and keep the
   session cwd pinned there for the whole run (CWD PIN rule, feature.md
   step 2). If the worktree is missing, STOP and ask — never recreate it
   silently.
2. **Re-run the ARM CHECK** from feature.md step 2. DISARMED → STOP and
   report instead of continuing.
3. **Bootstrap state, in this order** (skip files that don't exist yet):
   - `docs/superpowers/plans/<branch>-handoff.md` — current step + pointers
   - `.feature/intake.json` — the locked scope contract (drift detector)
   - the plan in `docs/superpowers/plans/`
   - `docs/superpowers/plans/<branch>-deviations.md`
   - findings tables + triage verdicts in `docs/reviews/<branch>/`
   - `.feature/gate-status.json` — last verify-gate result
4. **State where you are in one line** (current step + what remains), then
   continue the `/feature` workflow from that step under all of its rules —
   context discipline, anti-slop, deterministic enforcement.
