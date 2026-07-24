---
name: feature-resume
description: Resume an in-flight /feature run from its on-disk state — handoff doc, intake contract, plan, deviations, review verdicts
---

# Feature Resume

Branch: $ARGUMENTS

Resume the `/feature` workflow for this branch from disk. Everything a
resumed session needs is in files — never ask for the prior transcript.

1. **Enter the worktree**: `../RepWorth-worktrees/<branch>/` (locate via
   `git worktree list` if not there). Apply the feature skill's CWD
   discipline: prefix every Bash call with `cd <worktree-root> && ...` and
   use absolute paths for edits. If the worktree is missing, STOP and ask —
   never recreate it silently.
2. **Re-arm**: run `cd <worktree-root> && bash scripts/arm-check.sh` and
   re-run the ARM CHECK from feature.md step 2. DISARMED → STOP and report
   instead of continuing.
3. **Reconcile before bootstrapping**:
   - Read `.feature/state.json` first, if present, and compare its `phase`,
     `headSha`, `lastGreenGateSha`, and `intakeSha256` with Git reality.
   - If `headSha` differs from `git rev-parse HEAD`, reconcile from Git and
     repair the phase with `bash scripts/feature-state.sh set-phase <phase>`;
     never trust stale claims silently.
   - Inspect `git log --oneline $(git merge-base HEAD origin/main)..HEAD` and
     `git status --porcelain`; unexpected uncommitted changes are a red flag
     to surface, not permission to widen the run.
   - Compare `.feature/intake.json` with
     `docs/superpowers/plans/<branch>-intake.json` and stop on mismatch.
   - Treat a missing, red, or stale `.feature/gate-status.json`, or a
     `lastGreenGateSha` that does not match HEAD, as incomplete.
   - Check `git rev-list --count HEAD..origin/main` and flag meaningful main
     drift before new work.
4. **Bootstrap state, in this order** (skip files that don't exist yet):
   - `docs/superpowers/plans/<branch>-handoff.md` — current step + pointers
   - `.feature/intake.json` — the locked scope contract (drift detector)
   - the `CONTEXT.md` glossary excerpt referenced by the handoff — re-read it
     to prevent resumed-session language drift
   - the plan in `docs/superpowers/plans/`
   - `docs/superpowers/plans/<branch>-deviations.md`
   - findings tables + triage verdicts in `docs/reviews/<branch>/`
   - `.feature/gate-status.json` — last verify-gate result
   - If the handoff doc is missing, reconstruct the current step from Git,
     the plan, and deviations; state that reconstruction and get user
     confirmation before editing.
5. **State where you are in one line** (current step, remaining work, and any
   reconciliation flags), then
   continue the `/feature` workflow from that step under all of its rules —
   context discipline, anti-slop, deterministic enforcement.
