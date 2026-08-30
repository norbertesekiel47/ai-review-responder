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
   DISARMED → STOP and report instead of continuing. arm-check also
   self-heals the `.feature/` tree (`logs/`, `live/`) and auto-initializes
   the step ladder from the intake when `.feature/progress.json` is missing
   — a resumed pre-ladder worktree arms cleanly instead of failing at the
   gate with "no such file or directory".
3. **Reconcile claimed state against git state** (do this BEFORE trusting
   the handoff doc):
   - Read `.feature/state.json` FIRST — the machine-readable phase record
     (`phase`, `headSha`, `lastGreenGateSha`, `intakeSha256`, and the
     review-round counters `planReviewRounds` / `branchReviewRounds`). If
     `headSha` ≠ actual `git rev-parse HEAD`, work happened without a
     phase update — reconcile from git, then re-run
     `bash scripts/feature-state.sh set-phase <phase>` to repair it. If
     the file is missing (pre-state-machine run), fall through to the git
     checks below.
   - The round counters are CUMULATIVE across sessions — a resumed review
     continues from the recorded count under feature.md's caps (1 full +
     2 verification-only rounds, then feature.md's round-3 rule — escalate
     on RISK = high, decide-and-record on normal). Never restart at
     round 1 because the transcript is gone; uncounted rounds are how a
     "max 3" review reached round 5.
   - `git log --oneline $(git merge-base HEAD origin/main)..HEAD` — do the
     commits match the tasks the handoff (and `state.json` phase) claim
     are done?
   - `git status --porcelain` — uncommitted changes on resume are a RED
     FLAG: surface them to me (whose work? which task? commit or discard?)
     rather than absorbing them silently.
   - Diff the two intake copies: `.feature/intake.json` vs the committed
     `docs/superpowers/plans/<branch>-intake.json`. Divergence means an
     amendment updated one copy only — reconcile with me before any edit.
   - Staleness: is `.feature/gate-status.json` missing, red, or older than
     HEAD? Does `state.json`'s `lastGreenGateSha` match HEAD? Say so now —
     don't leave it for the Stop hook to catch later. **Ignore
     `.feature/gate-fast.json` entirely for this question**: a fast run is the
     fix loop's own signal, never evidence, and a green one beside a red or
     absent `gate-status.json` means the branch has NO gate evidence.
   - A gate may still be (or claim to be) running from the prior session:
     `bash scripts/verify-gate.sh --status` answers RUNNING / DEAD / last
     result in one command. Never blocking-wait for a gate you have not
     confirmed alive, and never launch a second gate over a RUNNING one.
   - Stale commit refs in the handoff: every SHA the handoff doc cites must
     still resolve (`git cat-file -e <sha>^{commit}`), and any `HEAD is
     <sha>` claim must equal `git rev-parse HEAD`. Run it mechanically —
     `python3 ~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py
     docs/superpowers/plans/<branch>-handoff.md --repo .` — which also
     re-resolves the doc's `path:line` citations against current HEAD. A
     resumed session that trusts a stale ref reconciles against fiction.
   - Main drift: `git rev-list --count HEAD..origin/main`. A branch far
     behind main rots — flag it and propose a rebase/merge before new work.
     **But the phase decides whether that is still allowed.** At
     `plan_approved`, `executing` or `gate_green`, take main now — it costs one
     gate run. Once the review wave has opened (or the phase is `reviewed`), a
     rebase voids the gate result, the fingerprint, the blast radius and the
     red-team sidecar together; on feat/1008 that cost 67 minutes. Report the
     drift, do NOT rebase, and finish the round first. See
     `.agents/skills/feature/references/execution-lanes.md` § Pin the fork.
   - **A `reviewed` phase is a claim, not evidence — revalidate the red-team
     sidecar before trusting it or taking ANY external action:**
     `cd <worktree-root> && node .agents/skills/feature/scripts/red-team-status.mjs`.
     A non-zero exit means the sidecar is absent, self-inconsistent, or stale
     against HEAD (a fix commit landed after the pass), or that a high-risk
     open P1 has no recorded authorization. A run that reached `reviewed`
     before step 7.5 existed has no adversarial pass at all. In every one of
     those cases the branch is at step 7.5, not step 8 — say so and go there.
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
