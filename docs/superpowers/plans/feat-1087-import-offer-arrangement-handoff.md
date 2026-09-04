# Handoff — feat/1087-import-offer-arrangement

Resume with `/feature-resume feat/1087-import-offer-arrangement`.

## Where this run is

**Step 3 complete, step 4 not started.** Phase `plan_approved`. No code written.
Prepared 2026-09-03 so a resumed session starts from findings, not from a blank
ticket.

## Read these, by path

| What | Where |
|---|---|
| Locked scope contract | `docs/superpowers/plans/feat-1087-import-offer-arrangement-intake.json` |
| Plan, and the NAMED defect | `docs/superpowers/plans/feat-1087-import-offer-arrangement.md` |
| Decision ticket | `gh issue view 1087` |
| Build ticket | `gh issue view 1096` |

## Do this first

**T1 is a screenshot pass, not code.** The defect in the plan is read from CSS,
not seen. Confirm it at 390px and 1440px before editing. If it does not
reproduce, say so and re-plan rather than fixing a defect that is not there.

## The two things that break silently

- The offer copy is **locked verbatim** — do not reword to fit a layout.
- `BannerShell` must remain the element at the parent's return position in every
  state, or the terminal screen-reader announcement is lost with no test failing.

## Assumptions to confirm or overrule

Four are recorded in the plan under "Assumptions recorded, not asked". They are
reversible. The owner has not seen them.

## The guard says ARMED. Verify that it binds.

`scripts/arm-check.sh` reports ARMED and is telling the truth — the hook IS
registered. But `.claude/hooks/edit-surface-guard.sh` is a **PreToolUse hook on
`Edit` / `Write` / `MultiEdit`**, and its own header names the gap:

> Known gap (inherent to PreToolUse): file changes made through Bash … routing
> repo edits through Bash during a feature run.

A session whose output mode routes file changes through **Bash** bypasses the
guard entirely. On feat/1092 three files landed outside the declared surface and
nothing stopped them. If that is this session, **enforce the surface by hand**:
diff every commit's `--name-only` against `allowed_edit_surface` before
committing, and handle `->` rename entries on BOTH sides.

## Reproduce the fallow gate properly

`pnpm test:coverage && pnpm ci:fallow:coverage` — nothing else predicts CI's
`fallow` job. A bare `fallow audit` reported clean three separate times on
feat/1090, feat/1093 and feat/1092 while CI failed.
