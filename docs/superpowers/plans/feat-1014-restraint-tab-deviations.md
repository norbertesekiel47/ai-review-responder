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

**Verdict: ACCEPT.** Nothing was written into the parked worktree and nothing
needed to be. Every overlapping path is owned by this run and now carries its
own code: `read.ts`, `refusals/route.ts`, the restraint route folder, both
restraint components, `AnalyticsTabs.tsx` and the three analytics files. The
harvest ran entirely through `git show feat/refusal-log:<path>` from this
worktree, so that checkout was never a dependency of a tracer. The owner note
stands unchanged — disarming that worktree is still the owner's call.

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

**Verdict: ACCEPT.** `Coverage start` is now a LOCKED bullet in `CONTEXT.md`'s
Refusal ledger section with its own `_Avoid_` line and provenance marker, landed
in T2 alongside the read that computes it rather than as a docs afterthought.
The surface renders it through `coverageLine()` in `RestraintReport`, and the
promised test `RestraintReport renders the policy-gate disclosure line while
auto-approval is disabled` asserts the coverage sentence beside the lane
disclosure that qualifies it.

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

**Verdict: ACCEPT.** `CONTEXT.md` won. The intake carries I13 and does NOT
carry the ticket's "must never disagree" clause, and the tab states which number
it shows through `scopeLine()` — two different sentences, one per view. The
promised test `RestraintReport states which number it shows when an account-wide
suspension is in the window` renders both scopes and asserts both sentences. I7
survives separately and is proven by two live-DB titles: one suspension yields
one row per location VIEW, and exactly one row in the account total.

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

**Verdict: ACCEPT.** `refusalSource` never crosses the wire; `resolveLinkKind`
in `read.ts` decides authority server-side from the LANE, and `CATEGORY_COPY` has
no `link` column, so the mistake is not re-expressible. The promised test
`RestraintReport does not link a policy_gate_held response that shares
held_draft's unsafe_content category` feeds both lanes at once — same category,
same subject type, both with real response ids — and asserts exactly one link.
The second latent instance is closed too: `owner_review_required` carries a
response subject in the no-link test and renders no link.

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

**Verdict: ACCEPT.** Implemented in T6 step 2b. `showError` is now
`!state.loading && state.error != null`. The blast radius was re-checked rather
than assumed: `AnalyticsContent.tsx` and `ReviewsContent.tsx` are the two other
callers, and `src/components/dashboard/reviews` passes 132 tests against the
changed panel. Three tests hold the fix — the promised `RestraintContent renders
the restraint error card when the initial query fails without cached data`, plus
two in `DashboardStatePanel.test.tsx`: the defect itself, and the loading
precedence that WAS correct, so the fix cannot later be simplified into dropping
that too. `blast-radius.sh` must still list both callers at step 7.

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

**Verdict: ACCEPT.** Both halves held for the rest of the run. No tracer's
first commit imported a module a later tracer created, and every import landed
beside its first real body. The cast came out exactly where this entry said it
would — T6 step 2 widened `DashboardSurface` and added `beforeContent`, and
`DashboardStatePanel.test.tsx` now calls `renderDashboardStatePanel` on its own
signature with no cast and no `TargetPanel` type. Title 56 went from failing at
T1 to passing at T6 without its body changing, which is the RED-to-GREEN
transition the eval exists to produce.

---

## D7 — Task 2's `LEFT JOIN responses` fails `ci:tenant-scope`, and its own comment says the opposite

**When:** step 4, Task 2 (`getRefusalLog`).

**What happened.** The plan writes `subject_resolves` as a LEFT JOIN:

```sql
LEFT JOIN responses resp
  ON r.subject_type = 'response'
 AND resp.id = r.subject_id
 AND resp.business_id = r.business_id
```

and its comment claims the `business_id` correlation is what keeps
`ci:tenant-scope` happy. It does not. The audit failed both arms:

```
src/lib/refusals/read.ts: responses: missing account_id or business_id scope
src/lib/refusals/read.ts: responses: missing account_id or business_id scope
```

**Why the audit is right.** `localScopedBindings`
(`scripts/ci/tenant-scope-audit.ts:1005`) proves a binding inside ONE query
block three ways: a literal binding (`directlyScoped`), a relation to a scoped
`accounts` row, or a relation to a scoped `businesses` row. There is no generic
"sibling tenant table on a matching `business_id`" rule at block level — that
shape is proven only ACROSS nesting levels, by `scopedFromAncestor`
(`:1194`). `responses` has no `account_id` column at all, so a same-block join
to it from `refusal_events` is unprovable by construction, and the account arm
has no single `businessId` to bind literally.

**Resolution — a correlated `EXISTS`, not a join.**

```sql
EXISTS (
  SELECT 1 FROM responses resp
  WHERE r.subject_type = 'response'
    AND resp.id = r.subject_id
    AND resp.business_id = r.business_id
) AS subject_resolves
```

The subquery makes `r` an ancestor, `scopedFromAncestor` matches
`resp.business_id` to `r.business_id` on the `business` kind, and the binding is
proven. `pnpm ci:tenant-scope` passes at 371 entries against a 371 baseline — no
allowlist entry was added, which was the point: an allowlist entry would have
recorded a permanent exception for a query that simply had the wrong shape.

It is also the shape the module's own account arm already argues for ("EXISTS,
never a JOIN"), so the two halves of the file now agree with each other. The
semantics are unchanged: `EXISTS` is false for a NULL `subject_id`, for an
unresolved id, and for a response under another location — the three cases the
promised test `distinguishes a non-null unresolved subject from a lane with no
subject` covers, and it passes.

**Two smaller corrections in the same task.**

1. **The plan's `seedAccountWithLocation` fixture cannot work as written.**
   `accounts.created_at` and `businesses.created_at` both default to `NOW()`, so
   a tenant seeded inside a test IS its own **Coverage start** — and
   `getRefusalLog` correctly clamps `windowStart` up to it. Every backdated
   fixture was therefore excluded, and three cases failed reporting an empty log,
   which reads as a broken query rather than a working clamp. The suite's helper
   now pushes both columns 200 days back (`SEEDED_COVERAGE_AGE_MS`), behind the
   widest selectable window, so the clamp is inert unless a case sets it. The
   three cases that PROVE the clamp set it themselves.

2. **Title 15's second clause is not assertable at T2.** `excludes Refusals after
   windowEnd from entries **and the archived-location footnote**` is listed in
   Task 2's turns-green, but `archivedLocations` is `null` until Task 3 adds the
   footnote query. T2 asserts the entries half and pins `archivedLocations` to
   `null`; the test body carries a `T3 EXTENDS THIS CASE` marker naming what Task
   3 must add. The title is not finished until it does.

**Verdict: ACCEPT.** The correlated `EXISTS` shipped and `ci:tenant-scope`
passes at 371 entries against a 371 baseline — no allowlist entry was added,
which was the point of not taking the easy exit. All three of the read's queries
cleared the audit unmodified afterwards, including T3's footnote JOIN and T4's
audit-log read. The fixture correction held: `SEEDED_COVERAGE_AGE_MS` pushes both
`created_at` columns 200 days back, and the three cases that PROVE the clamp set
it themselves. Title 15's deferred half is closed — T3 gave it an archived
location with one row inside the window and one after it, and the `T3 EXTENDS
THIS CASE` marker is gone because the work it named is done.

---

## D8 — Task 6 asks for a `docs/directory.md` row that the file's own rule forbids

**When:** step 4, Task 6 (the tab bar and the state-panel slot).

**What happened.** Task 6 Step 7 says to "add the `docs/directory.md` row for
`AnalyticsTabs.tsx`, then commit", and lists `docs/directory.md` among its files.
`docs/directory.md:16` states the opposite:

> A mention inside a description is NOT a row. `src/app/**` and
> `src/components/**` are described at folder level by design and are not
> audited.

`ci:directory-map` is complete for `worker/` and `src/lib/` only, which is why it
passed before and after this task with no edit. There is no
`src/components/dashboard/analytics/` table to add a row to, and no per-file
table for the analytics routes either — adding a lone row would have created a
section the convention says should not exist.

**Resolution.** No `docs/directory.md` change in T6. The plan's own file table
carries `docs/directory.md` for tasks 2, 5, 6, 7 and 8; it is correct for 2 and 5
(`src/lib/refusals/read.ts` and `src/app/api/dashboard/refusals/route.ts`, both
rows already landed) and wrong for 6. Task 7 and Task 8 are re-checked against
the same rule when they run — `restraint/page.tsx`, `restraint.css`,
`RestraintContent.tsx` and `RestraintReport.tsx` all sit under the two unaudited
roots.

**Two tests beyond the promised set, and both are D5's proof.** The
`showError` fix has no promised title of its own at this tracer — title 48 is
`RestraintContent`'s and lands in Task 7 — so without these the shared-module
change would ship with its behaviour asserted nowhere:

- `shows the error card on a first-load failure instead of an endless skeleton`
  is the defect itself: not loading, an error, and `hasData` false precisely
  BECAUSE the fetch failed.
- `keeps showing the skeleton while a request is in flight, even with a stale
  error` pins the half of the old comment that WAS right, so the fix cannot be
  "simplified" into dropping the loading precedence as well.

**Verdict: ACCEPT.** No `docs/directory.md` change was made in T6 or T7, and
`ci:directory-map` passed at every gate — 586 files under `worker` and `src/lib`
with a row each, no stale rows. The re-check this entry promised was performed:
`restraint/page.tsx`, `restraint.css`, `RestraintContent.tsx` and
`RestraintReport.tsx` all sit under the two unaudited roots, so T7 added no rows
either. The two rows the plan was RIGHT about both landed — `read.ts` in T2 and
`refusals/route.ts` in T5 — and T2 also repaired the section intro, which still
said "the READ half is #1014 and lives nowhere yet".

---

## D9 — the plan's ship order prescribes a staging ride; this branch skips it

**The plan says (§"Ship order (step 8) — RISK=high", step 2-3):** realign
`staging` first, then push the branch to `staging` and verify the tab end to end
on the staging stack.

**What happened instead:** the branch goes straight to a PR against `main`. No
`staging` push, no `staging` reset.

**Why.** `CLAUDE.md` triggers a staging ride for a change touching the **worker**,
a **webhook**, a **migration**, or **billing**. This branch touches none of them —
`git diff --name-only` over the whole branch returns no path under `worker/` or
`supabase/migrations/`, and nothing billing- or ingress-related. Migration 116 is
already on both Supabase projects, so there is nothing to promote in lockstep.
The plan chose a ride because the run is RISK=high, which is stricter than the
standing rule rather than required by it.

**What the ride would have cost.** `staging` is a disposable integration anchor
and is currently **7 commits ahead of `main` and 1 behind** — the plan's recorded
figures (`5358bd82`, 8 ahead, 25 behind) are stale and were re-measured rather
than trusted. Riding a diverged tip proves nothing, so a ride implies
`git reset --hard origin/main` plus `--force-with-lease`, discarding those 7
commits. That is a destructive, outward-facing action taken to prove a UI-and-read
change that a per-PR preview deploy already renders.

**Owner decision 2026-09-02: skip the ride, go straight to PR.** Recorded here
rather than left as an unexplained departure from the plan's own ship order.

**Verdict: ACCEPT.**

---

## D10 — the red-team sidecar is stale against HEAD, and the phase does not claim otherwise

**The facts, in order.** The tenth and final red-team pass returned `CLEAR` at
`6b90d6b9`; the report and sidecar were committed at `98cdbf7c`; the branch then
merged `origin/main` (7 commits) at `8cfc03ae`, and the full gate is GREEN there.

`red-team-status.mjs` now reports one issue: *"the tree moved since 6b90d6b9
outside this run's own two artifacts"*. That is correct and expected — the rule
fires on any commit, and a merge is one.

**Why the evidence is nonetheless sound.** `git diff --name-only 98cdbf7c HEAD`
lists 38 files and **not one of them is owned by this branch** — no `refusals`,
no `restraint`, no `dashboard/analytics` path appears. The merge brought main's
own reviewed work; it changed nothing the red-team pass measured.

**What was deliberately NOT done.** The phase was left at `gate_green` rather than
forced back to `reviewed`. Stamping `reviewed` over a failing checker would be
precisely the class of false claim this branch's own red-team record spends ten
passes correcting. The `reviewed` transition happened, is recorded, and was valid
at `98cdbf7c`; anyone needing a green checker at the merged HEAD must re-run the
pass, and this entry is the reason they would.

**Verdict: ACCEPT.**
