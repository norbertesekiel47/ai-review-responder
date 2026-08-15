# Handoff — `refactor-channel-route-unification`

**Current step:** 7 complete (review round 1, all axes triaged and committed).
**Next action is step 8 (SHIP).** Phase record: `.feature/state.json` → `reviewed`.

**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-channel-route-unification`
**Branch:** `refactor-channel-route-unification` (forked from `main` @ `682681ab`)

## Artifacts (read these, do not restate them)

| What | Path |
|---|---|
| Design of record | `docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md` §4 |
| Intake contract (drift detector) | `.feature/intake.json` + committed copy in `docs/superpowers/plans/` |
| Implementation plan | `docs/superpowers/plans/2026-08-15-channel-route-unification.md` |
| Deviations, all triaged | `docs/superpowers/plans/refactor-channel-route-unification-deviations.md` |
| Step-7 reports + verdicts | `docs/reviews/refactor-channel-route-unification/{spec-correctness,standards-maintainability,adversarial-approach-codex}.md` |
| Blast radius | `docs/reviews/refactor-channel-route-unification/blast-radius.md` |
| Glossary term | `CONTEXT.md` → **Channel actor** |

## Lane — read this before step 8

`classification: high` · `surface: backend` · `db_touching: false`

**Ship lane is deliberately NOT the RISK=high default.** Owner's call: run the
high-lane *controls* (adversarial plan review, third review axis at step 7) but
ship via the **normal lane** — PR straight to `main`, **no staging ride** — per
spec §2, which reasons that no worker, webhook, migration or billing surface is
touched. Step 8 follows the RISK=normal path **plus a merge-approval pause**.

Do not "promote" this to a staging ride on the strength of the `high`
classification alone; that decision was made once, deliberately, and is recorded
here and in spec §2.

## Counters and budgets (cumulative — do NOT restart)

- `planReviewRounds`: **3** (capped; round 3 produced no verdict, self-verified —
  see the plan's review appendix)
- `branchReviewRounds`: **1** of 3. Round 1 was the full parallel wave. Any
  further round is **verification-only** and must `incr-round branch` first.
- `allowed_edit_surface` amendments: **1 of 2** used (step-5 gate, `scripts/ci/**`).
  **A second amendment trips the abort criteria** — this is why three stale
  cross-references were deferred to step 8 rather than fixed in place.

## Step 7 outcome

Three axes, 16 findings: **6 fixed, 4 rejected with reasoning, 3 deferred to the
step-8 `document-feature` sweep, 3 noted.** Per-finding verdicts live at the foot
of each report. Gate re-run GREEN after the fixes (26/26 incl. `diff-coverage`).

Two findings worth carrying into the PR description:

1. **`TWILIO_WHATSAPP_NUMBER!`** — a non-null assertion on a `rawOpt` var that
   `MOCK_EXTERNAL_APIS=true` leaves unset, dereferenced *after* the enrollment
   commit, stranding a `pending_verification` row on the migration-027 unique
   slot. Fixed on both axes (throw with context; build the link before the write).
2. **The `admin-aal2` audit read prose, not code.** A header comment satisfied its
   substring clearance, so an admin route could bind `resolveOwnerActor`, skip MFA
   step-up, and stay green. The first narrow fix false-positived on a real route
   that merely documents its owner counterpart — the instrument was wrong in both
   directions, and now reads comment-stripped code.

**Rejected, with both positions recorded** (surface these in the PR body, per the
RISK=normal round rule): codex's recommended remedy for the rebindable trust
boundary — branded actor capabilities / portal-specific config factories — was
declined as a seam redesign that the plan's own tripwire routes back to step 3,
not a review-round patch. The narrow guard fix was taken instead.

## Step 8 checklist (RISK=normal + merge-approval pause)

1. Push, open PR to `main`. Carry into the PR body: the two findings above, the
   rejected-remedy position pair, the deliberate frozen-fixture break (6 sites /
   4 files, argued in the deviations log), and `.feature/deps-justification.md`
   content — **there is none; `dependencies_added` is empty.**
2. Confirm all GitHub CI checks green (incl. fallow). React Doctor does **not**
   apply — `surface: backend`.
3. **PAUSE for explicit merge approval** (the owner added this to the normal lane).
4. After merge: `git pull --ff-only` on local `main`; realign `staging` per
   `deployment-guide.md` §"Re-sync staging" (expect divergence after a squash
   merge → `reset --hard` + `--force-with-lease`, NOT a sync merge).
5. `bash scripts/feature-cleanup.sh` (dry run first) from the main checkout.
6. **Deviations promotion** — three durable lessons are already marked in the
   deviations file: the mock-mode-bypass/`!` rule, the class-field `AuthError`
   trap, and the `vi.mock('node:crypto')` precedent this branch established.
   Add the `admin-aal2` audit's floor (text scan over stripped code; aliased
   imports still clear it).
7. `document-feature` sweep — **must** clean the three deferred stale references
   listed in the deviations file (`docs/currents.md:1740`,
   `ChannelsPanel.tsx:34`, `src/lib/config/server.ts:221,224`).
8. Domain sweep (`domain-modeling`) + entropy counter in
   `.claude/reference/arch-review-log.md`.

## Follow-up ticket to file (deliberately not on this branch)

`reportCaughtError('telegram-admin', …)` / `('whatsapp-admin', …)` in the moved
env modules are now misleading — the modules serve both portals. The plan locked
the value verbatim, it is pre-existing, and changing a Sentry endpoint tag
re-groups live issues and any alerting keyed to them. Reasoning in the deviations
log's step-7 section.
