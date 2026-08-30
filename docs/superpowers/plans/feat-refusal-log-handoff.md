# Handoff — feat/refusal-log

> ## ⛔ THIS `/feature` RUN IS STOPPED. DO NOT RESUME IT.
>
> It took the **abort path** at step 7 on an owner decision (2026-08-29): build
> the durable ledger first. `/feature-resume feat/refusal-log` is the WRONG
> command — it would restart a run whose premise was retired.
>
> **The live work is the wayfinder map: [#994](https://github.com/RepWorth/ai-review-responder/issues/994).**
> Continue with `/wayfinder 994`. The map is on the tracker, not in `.feature/`
> state, and a fresh session reads it there.
>
> Read `docs/superpowers/plans/feat-refusal-log-postmortem.md` before anything
> else in this directory.

## Why it stopped

The **Restraint tab** was built as a projection over six operational tables. It
is green and it cannot keep its own promise:

1. `ArchivalPoller` deletes `agent_runs` at 180 days (`AGENT_SPINE_RETENTION_DAYS`)
   and the outreach FK is `ON DELETE SET NULL`, so every dispatch-time outreach
   **Refusal** loses its immutable anchor to a mutable `updated_at`.
2. Offboarding purges the sources.
3. Vocabulary changes retroactively re-categorise decisions never recorded.

The intake inherited the brief's premise — "the reasons already exist" — without
testing it. That is true of *availability* and false of *durability*, and the
grilling never separated the two claims. Retention appears in none of the 12
edge cases, 11 invariants or 74 test titles.

## Terminal state of this branch

Branch `feat/refusal-log`, worktree
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-refusal-log`.
**HEAD `4e0d8086`, tree clean, gate GREEN (32 checks).** Parked, not merged.

| Task | State |
|---|---|
| T0 eval · T1 vocabulary · T2 read+S5 · T3 S1+S3 · T4 S4+S6+S7 · T5 route · T6 tab bar · T7 screen | **ALL LANDED**, each verified independently |
| Step 5 gate | GREEN at `1466ffc6`, re-run GREEN at `4e0d8086` |
| Step 6 deviations | 17 entries, all triaged ACCEPT |
| Step 7 review | Round 1 of 3 ran, all three axes. **18 findings, NOT fixed** — the fix round was stopped mid-flight |
| Step 7.5 red team | Never ran |
| Step 8 ship | Never ran |

Budgets at stop: plan reviews 3/3 closed · surface amendments 2/2 spent (plus
one exit-artifact addition for the post-mortem) · branch reviews 1/3.

## What survives, and where it goes

| Artifact | Fate |
|---|---|
| `src/lib/refusals/vocabulary.ts` | Carries over unchanged. #998 adds an eighth **Refusal category**, `owner_review_required`. |
| `src/components/dashboard/restraint/*` + the route + `AnalyticsTabs` | Carry over. 10 of 13 review findings ride with them (#1000). |
| `src/lib/refusals/read.ts` — six `UNION ALL` arms | **Dead.** #1002 ruled no backfill, ever, so the arms are not even the migration input they were expected to be. |
| `docs/adr/0023-…` | Correct on redaction and the two-axis vocabulary; **wrong on durability**. Superseded in part by #996. |
| The 74-title eval | Mostly survives; the per-source arm tests die with `read.ts`. |

## The open review findings, if anyone lands this branch

`docs/reviews/feat-refusal-log/{spec-correctness,standards,approach-review}` —
13 findings, 2 HIGH. #1000 triaged them: **8 carry forward** into the harvest
ticket, 3 die with `read.ts`, 1 is moot. They land in the harvest ticket,
**never on this branch**, and that ticket's `allowed_edit_surface` must include
`src/components/dashboard/shell/DashboardStatePanel.tsx` — excluding it is what
produced the duplicated loading scaffold in the first place.

The sharpest one is not on either list. `RestraintReport.tsx:146` renders "We
did not hold anything back… Everything we were asked to do, we did." That is
false while the highest-volume lane is log-only. #1000 retired the absolute
claim permanently: **no Restraint surface makes a claim about all time.**

## One thing worth carrying to any future work in this domain

**For every source, ask: what deletes this row, and when?**

This effort had 12 edge cases, 11 invariants, 74 test titles and three
adversarial plan-review rounds, and asked it of none of them.
