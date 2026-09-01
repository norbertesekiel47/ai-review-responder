# feat/1014-restraint-tab — deviations

Entries the plan did not anticipate. Every entry gets a **Verdict:** ACCEPT or
RE-PLAN at step 6 before the review wave dispatches.

---

## D1 — Surface overlap with `feat/refusal-log` is an artifact of a stopped run, not a live collision

**When:** step 2, `feature-setup.sh` arming output.

**What happened.** The setup script reported 9 code-path overlaps (plus 8
test-glob overlaps) against the armed worktree
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-refusal-log`:

- `src/lib/refusals/read.ts`
- `src/app/api/dashboard/refusals/route.ts`
- `src/app/(authenticated)/dashboard/analytics/restraint/{page.tsx,restraint.css}`
- `src/components/dashboard/analytics/{AnalyticsTabs,AnalyticsAggregateView,AnalyticsPerLocationView}.tsx`
- `src/components/dashboard/restraint/{RestraintContent,RestraintReport}.tsx`

**Why no merge order was agreed.** `feat/refusal-log` **never merges.** Its own
tip commit `fcea7a5f` is "docs(feature): handoff — mark the run STOPPED, point
at map #994", and `4e0d8086` before it carries the post-mortem and the abort
decision. Ticket #1014 makes the relationship explicit: that branch is this
run's **harvest source**, and its `src/lib/refusals/read.ts` "survives nothing"
because #1002 decided there is never a backfill, which killed the six
`UNION ALL` arms outright.

A merge order presupposes two branches that both land. Only one does.

**What is actually true, and it is a real (small) hazard.** The parked worktree
still holds `.feature/intake.json`, so it is still ARMED even though its run
ended on 2026-08-30. Parking is supposed to be a conscious act (rename that
file); the stopped run never performed it. The consequence is only this
false-positive overlap report — the edit-surface guard is per-worktree, so
nothing here can reach that checkout and nothing there can reach this one.

**Resolution.**

1. No merge order agreed, because there is nothing to order.
2. No surface narrowed. Every overlapping path is a path this run must own.
3. **Nothing is written into the parked worktree**, including its deviations
   file. The workflow says to note a collision in both files; that rule exists
   so the *other* run's agent learns about it, and there is no other run. Its
   branch is stopped with a post-mortem, so a note there informs nobody and
   dirties a preserved artifact.
4. The harvest reads that branch through `git show feat/refusal-log:<path>`
   from **this** worktree wherever possible, so the sibling checkout is not a
   dependency of any tracer.

**Owner note (non-blocking).** The parked run can be disarmed at any time by
renaming `.feature/intake.json` inside that worktree. That is the owner's call,
not this run's — the worktree is one of two the owner deliberately kept, and
nothing here needs it changed.

**Verdict:** _(pending step 6)_

---

## D2 — `Coverage start` is not yet a LOCKED term in `CONTEXT.md`

**When:** step 1, intake grilling.

**What happened.** Ticket #1014 says the LOCKED terms — **Refusal**, **Refusal
category**, **Refusal source**, **Restraint tab**, plus **Coverage start** —
"exist today only on the parked branch". Four of the five are on `main` at
`CONTEXT.md:155-165` since #1013, so that clause reads as fully stale.

It is stale for four terms and **accurate for the fifth**. `Coverage start`
appears exactly once in the whole file, as prose inside the **Refusal source**
paragraph. It has no bullet, no `_Avoid_` line and no provenance marker. It is
a term this surface renders and no file owns.

**Resolution.** This run coins it. The `CONTEXT.md` edit is in
`allowed_edit_surface` and lands in the tracer that ships the coverage-start
line, not as a docs afterthought.

**Verdict:** _(pending step 6)_

---

## D3 — The ticket's reconciliation rule contradicts LOCKED `CONTEXT.md` text

**When:** step 1, intake grilling.

**What happened.** #1014 states: "Both views must never disagree: the account
total and the sum of per-location views reconcile, because neither includes
archived." `CONTEXT.md:165` (**Restraint tab**, LOCKED) states the opposite for
a different cause:

> an account-wide suspension appears under every location once each and
> **once** in the account total; a per-location sum therefore legitimately
> exceeds the account total whenever a suspension is in the window, and the tab
> must state which number it shows.

The ticket's *reason* is sound — archived rows are in neither view. Its
*absolute form* is false, because `autonomy_suspended` breaks reconciliation by
design and the LOCKED text says so.

**Resolution.** `CONTEXT.md` wins. Captured as intake invariant **I13**: the two
numbers may legitimately disagree, and the tab states which one it shows. The
intake does **not** carry the ticket's "must never disagree" clause.

**Adjacent trap, pinned as I7 so it is not collapsed into D3.** The ticket's
"the read must not fan them out across locations" and CONTEXT's "appears under
every location" are **not** in conflict. One suspension yields one row per
location *view* (correct) and must never be multiplied into N rows inside a
*single* result set by a join through `businesses` (the parent effort's defect).
Both halves are invariants; neither may be dropped as a restatement of the other.

**Verdict:** _(pending step 6)_
