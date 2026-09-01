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

---

## D4 — Plan round 1 found a design error of mine: link authority was keyed on the category, which does not carry the lane

**When:** step 3, plan-skeptic round 1 (session `01a05eee-b142-7410-a022-6e3dca104ea7`).

**What happened.** The first plan dropped `refusalSource` from the read DTO
entirely, on the reasoning that fewer server concepts should cross the wire, and
keyed the tab's links off the **Refusal category** instead. Dropping
`refusal_code` and `all_refusal_codes` was correct (ADR 0023). Dropping the LANE
was not.

`held_draft` maps to `unsafe_content` (`vocabulary.ts:244`) and so does
`policy_gate_held`'s `moderation_flagged` (`vocabulary.ts:471`) — **verified, not
taken on the reviewer's word** — and migration 116's CHECK C1 gives both lanes
`subject_type = 'response'`. A category-keyed link rule therefore hands a
policy-gate row the same review link a held draft gets: a link to a draft the
owner was never asked to review. Every one of the original 49 promised tests
would have stayed green, because they exercise a held-draft link and a no-link
category and never the same-category collision.

**Resolution.** The lane stays server-side and is projected into a `linkKind`
field by `resolveLinkKind` in `read.ts`. `refusalSource` still never crosses the
wire. Captured as intake invariant **I14** and edge case **E18**, with the
failing test
`RestraintReport does not link a policy_gate_held response that shares held_draft's unsafe_content category`.
`CATEGORY_COPY` loses its `link` column outright, so the mistake is not
re-expressible. A second latent instance was fixed in the same pass:
`owner_review_required` had also been given a subject link, and the ticket names
exactly three links, none of them that one.

**Verdict:** _(pending step 6)_

---

## D5 — Fixing the Restraint tab's error state also fixes a pre-existing bug on two other surfaces

**When:** step 3, plan-skeptic round 1.

**What happened.** `DashboardStatePanel.tsx:61` reads:

```typescript
const showError = !state.loading && state.hasData && state.error != null;
```

The `hasData` conjunct gates the error card. On a FIRST-load failure `loading` is
false, `error` is set and `hasData` is false — so the panel falls through to the
skeleton branch and the owner watches a loading animation that never resolves.
The comment above it ("Loading takes precedence over a stale error while data is
absent") describes the `loading === true` case, which the first conjunct already
handles.

**Why this run takes it anyway.** It is a pre-existing defect in a shared module
and the fix reaches `/dashboard/analytics` and `/dashboard/reviews`, which is
outside #1014's ticket. Two reasons override that:

1. The Restraint tab cannot satisfy its own promised error-state behaviour while
   it stands — the promised test
   `RestraintContent renders the restraint error card when the initial query fails without cached data`
   fails against the current panel.
2. The change is strictly an improvement on both other surfaces: an error card
   replaces an endless skeleton. There is no state in which the old behaviour is
   preferable.

The alternative — having `RestraintContent` pass `hasData: true` on error — was
rejected: it makes the component lie to the panel to route around a bug, and
leaves the other two surfaces broken.

**Blast radius to re-check at step 7.** `src/components/dashboard/analytics/AnalyticsContent.tsx`
and `src/components/dashboard/reviews/ReviewsContent.tsx` are the two other
callers. `blast-radius.sh` must list them and the review wave must look at both.

**Verdict:** _(pending step 6)_

---

## D6 — Task 1's example import crashes collection, and its "real failing test" rule collides with the typecheck gate row

**When:** step 4, Task 1 (the eval).

**What happened.** Two of Task 1's own instructions cannot both be followed as
written.

**First, the import.** Task 1 Step 2 gives this "example shape" for the read
suite:

```typescript
import { getRefusalLog } from '@/lib/refusals/read';
```

`src/lib/refusals/read.ts` does not exist until Task 2. A named import of an
absent module fails the whole FILE at collection, so vitest reports zero titles
rather than 22 pending ones — and `promised-tests` would still pass, because it
greps source text, which is precisely how this would have gone unnoticed. Task
1's own Step 4 states the opposite expectation: "todos reported, zero passes for
unimplemented behaviour, **no import crash**". The sibling suite
`write.integration.test.ts` documents the same trap in its own header and
reaches an absent export through a namespace import for that reason.

**Second, the failing test.** Step 2's rule is that a title whose module EXISTS
but whose behaviour is unimplemented is a real `it()` that FAILS. Exactly one of
the 56 qualifies — title 56, because `DashboardStatePanel.tsx` is the shared
scaffold and already exists. Task 6 Step 5 supplies the body verbatim. But that
body passes `'restraint'` to a two-member union and a fourth argument to a
three-parameter function, so it does not typecheck, and `typecheck` is a gate
row that must stay green at every boundary.

**Resolution.**

1. **No T1 file imports a module a later task creates.** The six all-`it.todo`
   files import `describe` and `it` from vitest and nothing else. Tasks 2, 5, 6,
   7 and 8 each add their import alongside their first real body. The example
   snippet is treated as illustrative of the `it.todo` shape, which is what the
   surrounding prose actually specifies, not of the import list.
2. **Title 56 is a real failing test, called through a cast to the TARGET
   signature.** `DashboardStatePanel.test.tsx` declares the four-parameter,
   three-member-union type Task 6 ships and casts the import to it once. The
   test compiles today and fails at run time for the right reason — the panel
   reads `SURFACE_STATE_COPY['restraint']`, gets `undefined`, and throws on
   `copy.title`. **Task 6 Step 2 deletes the cast** when it widens the union and
   adds the parameter; the call body then stands unchanged. The alternative —
   demoting title 56 to `it.todo` — was rejected: it would leave the one title
   that CAN fail today silently green, and the RED phase's whole value is that
   the eval fails before the implementation lands.

**Evidence at T1.** `pnpm vitest run` over the five directories reports
`1 failed | 58 todo`, no collection error, and every pre-existing suite in those
directories still green. `pnpm typecheck` and `pnpm lint` are clean.
`promised-tests PASS` — all 56 titles matched verbatim.

**Verdict:** _(pending step 6)_
