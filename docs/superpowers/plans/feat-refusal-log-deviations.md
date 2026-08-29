# Deviations — feat/refusal-log

Every entry is something the plan or intake did not anticipate. Each carries a
verdict: ACCEPT (the adaptation is sound) or RE-PLAN (it invalidates a locked
decision).

## D1 — Surface amendment 1 of 2: ADR renumber

`docs/adr/0022-refusal-log-owner-safe-projection.md` →
`docs/adr/0023-refusal-log-owner-safe-projection.md`.

Plan review finding 20. `0022-solicitation-rate-cap-not-yield.md` already
exists at this HEAD; 0023 is the next free number. Same directory, same file
count — a corrected path, not a widening. Both intake copies updated.

**Counts as amendment 1 of 2.** One remains before the abort criteria bite.

Verdict: **ACCEPT**.

## D2 — Test retitles and additions (not an amendment)

`tests_to_add` went from 32 titles to 65. Retitles and additions are recorded
here as owner-approved deviations, never as surface amendments — the /feature
abort budget counts only `allowed_edit_surface` changes.

Four titles were **removed** because `judge_verdicts` left scope (see D3):
- `every JUDGE_REASON_CATEGORIES member maps to a RefusalCategory`
- `getRefusalLog omits judge_verdicts.rationale from every returned entry`
- `getRefusalLog excludes a judge verdict with verdict error`
- `getRefusalLog parses judge reasons delivered as a JSON string`

One was **retitled** to resolve plan-review finding 10, where the plan said
excluded codes map to `null` and the eval said they are absent from the map:
- was: `excluded source codes are absent from the mapping`
- now: `every excluded source code maps explicitly to null`

The remaining 37 additions come from plan-review findings 1–9 and 14–19. Every
one closes a case where all prior tests pass and the shipped feature is still
wrong.

Verdict: **ACCEPT**.

## D3 — Source inventory changed after the plan review

The owner approved a six-source mapping table before the review. Four sources
moved. Each change was verified against the code independently, not accepted on
the reviewer's word. The owner re-approved D3a and D3c on 2026-08-29.

**D3a — `judge_verdicts` DROPPED.** The judge runs on already-posted replies:
`judge-policy.ts:9` ("a customer-review reply that has already been posted"),
`judge-store.ts:115` (`WHERE r.status = 'posted'`), `judge/context.ts:65`
(gates on `status === 'posted' && approval_method === 'auto_policy'`). A verdict
is a post-publication observation, not a refusal. Counting it would be false and
would double-count the autonomy suspension a flag triggers.

**D3b — autonomy suspension RE-SOURCED** from
`auto_approval_policies.suspended_at/.suspended_reason` to `account_audit_log`
(`event_type = 'autonomy_suspended'`, `suspension.ts:309-313`). `unsuspend`
sets both policy columns to NULL (`suspension.ts:352-354`), so the approved
behaviour "a lifted suspension still appears" is impossible from the policy
row. `account_audit_log` is durable, carries the trigger in `payload`, and has
an owner SELECT policy (migration 035 §1g). It is `account_id`-keyed with a
nullable `location_id`; the suspension writer sets no location, so a suspension
is account-wide and appears in every location scope. That is correct — a
suspended account default applies to every location.

**D3c — `AutoApprovalBlockReason` is UNAVAILABLE, and it is the highest-volume
refusal.** 22 members at `worker/jobs/response-generation/auto-approval.ts:37`.
`persist.ts:570-576` emits them through `logger.log` only. The `policy_gate`
run-spine step records `decision: 'held_for_owner'` with no reason. So the
Refusal Log can report THAT a draft was held for the owner, never WHY. The
owner chose to ship the seven available sources and record the limit rather
than add a capture layer. ADR 0023 and CONTEXT.md own that statement.

This partially falsifies the brief's key finding, "RepWorth does NOT discard
refusal reasons". It holds for seven sources. It does not hold for this one.

**D3d — `solicitation_batches` ADDED as S7.** Plan §2 promised `admin_halt`
and `platform_halt` and gave them no source row, no query, no task and no test.

Verdict: **ACCEPT** for all four. None invalidates a locked decision — D3a and
D3c were put to the owner and re-approved; D3b and D3d are corrections that
make an already-approved behaviour reachable.

## D4 — Six queries became one `UNION ALL`

Plan review finding 24. One arm per accepted source, safe columns only, one
sort, one place the tenant predicates live. Simpler than six independently
scoped reads and it moots the pool-fanout concern the plan raised in §7.3.

Verdict: **ACCEPT**.

## D5 — Stale HEAD citation in the plan

Plan §2 cited HEAD `2f4497a9`. That was the pre-squash tip of
`feat/console-dashboard-density`; it is neither current nor ancestral to the
worktree base `75a1f436` (parent `5ab6bfee`, the squash merge of #993).
Pre-validation passed because it resolves the SHA, and `2f4497a9` still exists
in the object store. Corrected to `5ab6bfee`.

Verdict: **ACCEPT**.

## D6 — Four things T0 found that the plan did not anticipate

All four are paperwork or task-brief errors. None touches
`allowed_edit_surface`, so none counts against the amendment budget, and none
changes a locked decision.

**D6a — there is no vitest project named `unit`.** The T0 brief's definition of
done says
`pnpm vitest run src/lib/refusals src/components/dashboard/restraint --project unit`.
`vitest.config.ts` defines exactly two projects, `parallel` and `integration`;
`--project unit` matches nothing and the run reports zero test files, which
reads as "no tests written". The command actually run, and the one later tasks
should use, drops the flag (both projects then run, which is what is wanted —
`read.integration.test.ts` lives under the same path and is in the
`integration` project):

```
REPWORTH_DISABLE_LIVE_DB_SUITES=1 pnpm vitest run \
  src/lib/refusals src/components/dashboard/restraint \
  src/components/dashboard/analytics/__tests__/AnalyticsTabs.test.tsx \
  src/app/api/dashboard/__tests__/refusals-route.test.ts
```

Result at T0: **73 tests — 3 failed, 70 todo, 0 passed.** Nothing green, so
nothing vacuous.

**D6b — the eval is 73 titles, and plan §6 still says 65.** The intake's
`tests_to_add` array holds 73 entries (`jq '.tests_to_add | length'`). Plan §6
T0 and the rev-2 header both say 65, and D2 above says "32 titles to 65". The
gate reads the intake, not the plan, so 73 is the operative number; the plan's
prose is stale. The plan's rev-3 commit (`5672a959`) also left its own H1
reading "rev 2". Doc-only drift, recorded rather than fixed here because T0
does not own `feat-refusal-log-plan.md`.

**D6c — plan §6 T3 cannot turn "the 5 redaction tests" green.** Three of the
five are ROUTE cases — `the refusals route serializes no flagged reason at any
depth`, `… returns no flagged reason on an error path`, `… logs no flagged
reason` — and the route is T5's file. T3 can green only the two read-layer
redaction cases. The dependency edge is right (T3 → T4 → T5); only the green
list is misattributed. Corrected allocation: T3 greens 2 redaction cases, T5
greens 3.

**D6d — the T0 brief's per-file title counts are each off by one.** It asks for
"the 10 vocabulary/mapping titles + the 2 cancelled-arm null titles" in
`vocabulary.test.ts`, but the eval contains exactly ONE cancelled-arm mapping
title (`the cancelled-arm admin_halt and platform_halt outreach copies map
explicitly to null`); the other cancelled-arm title (`getRefusalLog excludes the
cancelled arm of solicitation_outreach entirely`) is a `getRefusalLog`
behavioural case and was filed with the live-DB suite. It also asks for "the 13
tab/page titles" in `RestraintContent.test.tsx` plus "the tab-bar title"
separately; there are 12 tab/page titles and 1 tab-bar title — 13 in total
across the two component files. Placement is cosmetic (the `promised-tests` row
greps `src`, `worker` and `scripts` as a whole), so the split was made on
subject: pure mapping in `vocabulary.test.ts`, anything calling `getRefusalLog`
in the live-DB suite.

Verdict: **ACCEPT** — all four are corrections to prose, not to the build.

## D7 — Round-3 anchor delta to the eval (not an amendment)

Plan review round 3 landed after T0 was already dispatched against the 73-title
eval, so this delta is owed. Titles are deviations entries, never surface
amendments; the surface stays at 21 entries and the budget at 1 of 2.

- **ADD** `getRefusalLog anchors a render-time outreach refusal on rendered_at`
- **RETITLE** `getRefusalLog does not move a withheld outreach entry when the row is mutated later`
  → `getRefusalLog does not move a render-time or run-anchored outreach entry when the row is mutated later`

Reason: the withheld arm has TWO writers. `ask-generation.ts` INSERTs a row
already withheld at render time (`render_failed`, `lint_failed`,
`moderation_high`) where `rendered_at` IS the refusal time; `dispatch.ts`
`commitWithhold` writes the other five and sets `agent_run_id` atomically. The
single anchor from D-round-2 was wrong for the render half. Full record:
`docs/reviews/feat-refusal-log/plan-review-r3.md`.

Eval is now **74 titles**. T1 adds these two to
`src/lib/refusals/__tests__/read.integration.test.ts` as `.todo`.

Verdict: **ACCEPT**.

## D6 verdicts (orchestrator triage)

- **D6a** (`--project unit` does not exist) — **ACCEPT.** My T0 brief was wrong;
  `vitest.config.ts` defines `parallel` and `integration`. Later task briefs use
  the corrected command. Verified independently: 73 tests, 3 failed, 70 todo,
  0 passed.
- **D6b** (plan §6 said 65) — **ACCEPT, fixed in rev 4.** Plan prose now says 74
  and states that the intake is the operative count.
- **D6c** (T3's green list claimed 3 route redaction tests) — **ACCEPT, fixed in
  rev 4.** T3 greens 2 read-layer cases; T5 greens the 3 route cases. The
  dependency edges were already right.
- **D6d** (per-file counts off by one) — **ACCEPT, no action.** A brief-writing
  slip, not a plan defect. T0's filing decision was correct: `getRefusalLog
  excludes the cancelled arm of solicitation_outreach entirely` is behavioural
  and belongs in the live-DB suite.

## D8 — Five things T1 found that the plan did not anticipate

None changes a locked decision, and none touches `allowed_edit_surface`.

**D8a — the tree is CI-red from T1 until T8, on two audits.** `ci:directory-map`
is CI-complete for `src/lib/`, so `src/lib/refusals/vocabulary.ts` fails it the
moment it exists ("has no row in docs/directory.md"), and `read.ts` will do the
same at T2. `docs/directory.md` is T8's file and is not in T1's edit surface, so
the rows cannot land here. `ci:feature-surface` is red for the same shape of
reason: six `allowed_edit_surface` entries still match no file, and each clears
as its task lands. **Neither is a defect and neither blocks the PR** — CI runs
on PRs only, and both go green when T8 lands. The operational consequence is
local: **`git push` fails the lefthook pre-push hook until T8**, so an
intermediate push needs `--no-verify`, exactly as the audit's own message says.

**D8b — `src/lib/refusals/vocabulary.ts` is the repo's first `src/` → `worker/`
import.** Every other cross-reference in that direction is a comment. The plan
required importing `AutoPolicyDowngradeReason` from its owner rather than
re-spelling six literals, and the owner is
`worker/jobs/publisher/auto-policy-downgrade.ts`. It is written `import type`, so
it erases at build time and pulls in no worker runtime (that module imports
`postgres` and the outbox helpers). It is ESLint-legal by design, not by luck:
`PARENT_TRAVERSAL_BAN`'s regex carries `(?!.*/(worker|scripts)/)`, an explicit
exemption for cross-tree imports that have no `@/` alias. Invariant #1's runtime
ban covers `src/app/**`, `src/components/**` and `instrumentation.ts` — not
`src/lib/**` — and is about runtime imports either way.

**D8c — S1 has no code axis at all, which is stronger than the plan's wording.**
Plan §3 Axis B says "For S1 the code stays server-side", which reads as a
redacted lookup. There is nothing to look up: `flagged_responses.reason` is
moderation prose that may never leave the server (intake invariant 4) and the
row exists only for a `high`-severity flag (`.claude/CLAUDE.md` invariant #4), so
the lane itself is the whole fact. `refusalCategoryFor('held_draft', code)`
takes `null` and returns the fixed `HELD_DRAFT_REFUSAL_CATEGORY`; a non-null code
on that lane throws, because it would mean a caller invented an axis.

**D8d — a `review` link target is CONDITIONAL, because category and source are
not 1:1.** The locked link table reads "held draft → the review", but
`unsafe_content` has two feeders: S1 (a held draft, which names a review) and S6
`moderation_high` (an outreach withhold, which names none). So the category-level
link is the marker `{ kind: 'review' }` — "resolved per entry from the review
that entry names" — and an entry with no review renders no link. T7 must not
read it as "every unsafe_content row links somewhere".

**D8e — three of the five source vocabularies cannot be enumerated at run time,
so their tests parse their owner.** `satisfies Record<Enum, …>` makes an ADDED
member a compile error but leaves nothing for a test to iterate:
`AutoPolicyDowngradeReason` and `AutonomySuspensionTrigger` are bare type unions,
and the batch halt list has no TS owner at all. Re-spelling their ten members in
`vocabulary.test.ts` would fork the enum into the test that guards it, so the
cases parse the union out of its module and the halt list out of migration 111 —
the same technique T0 already used for the outreach withheld arm. `WithholdReason`
is the one that iterates a real exported array (`WITHHOLD_REASONS`).

Verdict: **ACCEPT** for all five.

## D10 — Four things T6 found that the plan did not anticipate

None changes a locked decision, and none touches `allowed_edit_surface`.

**D10a — the tab bar cannot sit in a `.reviews-subnav` row, because Reviews and
Analytics do not share a geometry.** The T6 brief said to put it "where
`ReviewsTabs` sits in `ReviewsContent.tsx`" — a `<div className="reviews-subnav">`
between the TopBar and the content box. That row is `max-width: 1024px;
margin: 0 auto` (console.css:777), the Reviews reading column. Analytics is
full-bleed (`.content--analytics { max-width: none; padding: 18px 32px 80px }`,
console.css:735), so on a 1440px screen a capped row would inset the tabs ~208px
from the left edge of every card beneath them. The tab bar is therefore the
FIRST CHILD of `.content--analytics` on all three surfaces, which inherits the
same 32px gutter as the grid and needs no new class. A dedicated
`.analytics-subnav` would have been the other answer and it lives in
`_styles/console.css`, outside T6's five-file edit surface.

**D10b — the shell does not call `renderDashboardStatePanel`, and could not.**
The brief named it for the loading branch. The helper emits its own `TopBar`
immediately followed by its own content box, so there is no seam between them
for a tab bar; passing the tabs as its `topBarActions` slot would park route
navigation in the TopBar's right-hand control cluster on the Restraint route
only, next to where the period toolbar sits on the Metrics route — a tab bar
that moves when you click a tab. `DashboardSurface` is also a closed
`'analytics' | 'reviews'` union with no `'restraint'` member, and
`DashboardStatePanel.tsx` is outside T6's edit surface. The page composes
`TopBar` + `AnalyticsTabs` + the same loading scaffold BY CLASS
(`dashboard-skeleton` / `skeleton-card-lg` / `LiveRegion`) instead — four lines
of markup, no forked copy of the error branch, and the TopBar keeps the honest
title "Restraint" rather than "Analytics".

**D10c — CONTEXT.md calls Restraint "the third tab on `/dashboard/analytics`";
it ships as the second of two.** `/dashboard/analytics` had no tab bar at all
before T6 — the surface is one route with a period toolbar. The bar T6 creates
holds `Metrics` (the existing reputation/volume/ranking grid) and `Restraint`.
"Third" appears to have been written against a mental model of the sidebar nav,
not of a tab bar that did not exist. The locked sentence's substance — routed at
`/dashboard/analytics/restraint`, reachable from the analytics surface — is
unaffected, so this is recorded rather than re-litigated; T8 can correct the
word when it touches CONTEXT.md.

**D10d — whole-tree `pnpm typecheck` and `pnpm build` are red during T6, on
T2's file.** Three `TS1005` parse errors in `src/lib/refusals/read.ts`, which T2
was mid-edit on while T6 ran concurrently. `next build` reports "Compiled
successfully" and fails only at the `Running TypeScript` step, and `npx eslint`
over T6's own two directories exits 0. Nothing in T6 imports `read.ts`. This is
the expected cost of the parallel dispatch, not a T6 defect; the gate must be
re-run at a HEAD where T2 has landed.

Verdict: **ACCEPT** for all four.
