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
