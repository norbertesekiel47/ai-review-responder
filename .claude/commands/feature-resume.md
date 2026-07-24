---
description: Resume an in-flight /feature run from its on-disk state — reconciles claimed state against git reality before continuing
argument-hint: <branch>
---

# Feature Resume

Branch: $ARGUMENTS

Resume the `/feature` workflow for this branch from disk. Everything a
resumed session needs is in files — never ask for the prior transcript.
Resume is where correctness silently degrades, so RECONCILE before you
continue: the handoff doc's claims are hints; git state is the truth.

1. **Enter the worktree**: `../RepWorth-worktrees/<branch>/` (locate via
   `git worktree list` if not there). Apply the WORKTREE PATH DISCIPLINE
   from feature.md step 2 (`cd <worktree-root> && …` on every Bash call).
   If the worktree is missing, STOP and ask — never recreate it silently.
2. **Re-arm**: `cd <worktree-root> && bash scripts/arm-check.sh`.
   DISARMED → STOP and report instead of continuing.
3. **Reconcile claimed state against git state** (do this BEFORE trusting
   the handoff doc):
   - `git log --oneline $(git merge-base HEAD origin/main)..HEAD` — do the
     commits match the tasks the handoff claims are done?
   - `git status --porcelain` — uncommitted changes on resume are a RED
     FLAG: surface them to me (whose work? which task? commit or discard?)
     rather than absorbing them silently.
   - Diff the two intake copies: `.feature/intake.json` vs the committed
     `docs/superpowers/plans/<branch>-intake.json`. Divergence means an
     amendment updated one copy only — reconcile with me before any edit.
   - Staleness: is `.feature/gate-status.json` missing, red, or older than
     HEAD? Say so now — don't leave it for the Stop hook to catch later.
   - Main drift: `git rev-list --count HEAD..origin/main`. A branch far
     behind main rots — flag it and propose a rebase/merge before new work.
4. **Bootstrap state, in this order** (skip files that don't exist yet):
   - `docs/superpowers/plans/<branch>-handoff.md` — current step + pointers
   - `.feature/intake.json` — the locked scope contract (drift detector)
   - the `CONTEXT.md` glossary excerpt the handoff references — RE-READ IT;
     a resumed session that skips this reintroduces exactly the language
     drift the workflow exists to prevent
   - the plan in `docs/superpowers/plans/`
   - `docs/superpowers/plans/<branch>-deviations.md`
   - findings tables + triage verdicts in `docs/reviews/<branch>/`
   **Missing handoff doc**: do NOT proceed on assumption — reconstruct the
   current step from git log + the plan + the deviations file, state the
   reconstruction to me, and get a nod before continuing.
5. **State where you are in one line** (current step + what remains + any
   reconciliation flags from step 3), then continue the `/feature` workflow
   from that step under all of its rules — context discipline, anti-slop,
   deterministic enforcement.
