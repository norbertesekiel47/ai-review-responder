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

## D9 — Five things T2 found that the plan did not anticipate

None changes a locked decision, and none touches `allowed_edit_surface`.

**D9a — `ci:tenant-scope` substitutes ONE `$N` per `${}` in the RAW template
text, so a nested fragment dropped straight after the account predicate destroys
the proof.** The audit reads un-evaluated template text
(`scripts/ci/tenant-scope-audit.ts`, the rule `src/lib/kpi/fragments.ts` states
for the Review-time anchor), splits each WHERE on top-level `AND`, and requires a
conjunct matching exactly `alias.account_id = $N`. Written
``WHERE r.account_id = ${scope.accountId}\n  ${inLocation}``, the first conjunct
reads as `r.account_id = $1 $2` and the arm was reported unscoped — a RED audit on
a query that is in fact scoped. The location filter therefore composes as a WHOLE
conjunct — `AND ${inLocation}`, resolving to `r.business_id = $2` in location
scope and to `TRUE` in aggregate scope. Consequence for T3/T4: each new arm
spells `r.account_id = ${scope.accountId}` in its own template (a helper would
hide it from the audit) and adds `AND ${inLocation}` as a separate conjunct.

**D9b — a backtick inside a SQL comment terminates the tagged template.** The
S5 arm's comment originally read ``-- S5 · … `solicitation_asks`, keyed …`` and
the backtick closed the template literal, producing the three `TS1005` parse
errors T6 recorded as D10d. SQL comments inside `sql\`\`` carry no backticks.

**D9c — the invariant-#15 test is a whole-file substring scan, so PROSE naming
the import path fails it.** `read.test.ts` filters modules on
`readFileSync(...).includes('@/lib/db/server')`. A doc comment saying "this
module must never import `@/lib/db/server`" is indistinguishable from the import
itself; `read.ts` states the rule without spelling the path and says why.

**D9d — the window needs an UPPER bound that `getAgentTeamSummary` does not
have.** The eval promises `getRefusalLog excludes an entry after the window
end`; the precedent read binds only `>= windowStart` (agent outcomes are always
in the past). `getRefusalLog` binds both ends off ONE `new Date()`, so the window
is `[now - windowDays, now]` and every arm shares the instant. Because the read
derives that instant at call time, the three boundary cases in
`read.integration.test.ts` freeze Date (`vi.useFakeTimers({ toFake: ['Date'] })`)
— inclusion at EXACTLY the window start is unobservable against a moving clock —
and every seeded stamp is an explicit `::timestamptz`, never `NOW()`.

**D9e — `getRefusalLog orders entries newest first` moved from the unit file to
the live-DB suite.** T0 filed it under `read.test.ts`'s query-shape describe,
where it could only ever assert that the text `ORDER BY … DESC` appears. It is a
behavioural claim, so it is now proved against three seeded asks in
`read.integration.test.ts` and the unit `.todo` was removed — one title, one
home. Placement is free: the `promised-tests` row is a fixed-string `grep -rF`
over `src`, `worker` and `scripts` (`scripts/verify-gate.sh:294-318`), matching
D6d's finding.

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

## D11 — S3's key space is the AUDIT ACTION, not the downgrade reason

The plan mapped S3 through `AUTO_POST_REVOKED_REFUSAL_CATEGORIES`, keyed by
`AutoPolicyDowngradeReason` — **six** members. `approval_audit_log.action`
stores an **audit action**, and there are only **five**: `DOWNGRADE_MARKERS`
(`worker/jobs/publisher/auto-policy-downgrade.ts:25-32`) collapses
`judge_disabled` and `judge_unhealthy` onto the single action
`auto_policy_revoked_judge_unavailable`. The read could not look up what the
database actually stores.

**Derived, not duplicated.** `AUTO_POST_REVOKED_ACTION_CATEGORIES` is built by
`deriveActionCategories` re-keying the reason map through the reason→action
table, so the reason map keeps its `satisfies Record<AutoPolicyDowngradeReason,
…>` exhaustiveness guard — a seventh downgrade reason still fails the build
there — and the two cannot drift. Two reasons collapsing onto one action must
agree on the category or the derivation throws
(`ConflictingRefusalActionError`); both judge reasons carry
`watchdog_unavailable` today, so the collapse is consistent. A silent pick would
misfile every refusal written under the losing reason under a heading the owner
cannot tell from a real one — the same failure a closed vocabulary exists to
make impossible. Covered by `deriveActionCategories throws when two collapsed
reasons carry different categories`.

Verdict: **ACCEPT**.

## D12 — Six things T3 found that the plan did not anticipate

None changes a locked decision, and none touches `allowed_edit_surface`.

**D12a — `DOWNGRADE_MARKERS` is module-PRIVATE, so D11's reason→action table
could not be imported.** The task brief said to derive through it. It is not
exported, its owner is outside T3's edit surface, and it lives in `worker/`
whose runtime graph pulls `postgres` and the outbox helpers — so even an
exported const could not be imported by a leaf mapping file. The table is
re-stated in `vocabulary.ts` from the IMPORTED `AUDIT_ACTION_*` constants (no
literal is re-spelled) and `vocabulary.test.ts` PARSES `DOWNGRADE_MARKERS` out
of its owner and asserts the copy equals it, resolving constant NAMES against
the imported values. Same technique as the migration-111 and bare-union cases
(D8e). Six reasons in, five distinct actions out, both pinned.

**D12b — `vocabulary.ts` is no longer a pure leaf, and that is a live hazard for
T7.** Importing `@/lib/approval/audit` for the action constants pulls `uuid` and
`node:crypto` into this module's graph. Nothing imports `vocabulary.ts` outside
`src/lib/refusals/` today and `pnpm build` is green, but **a `'use client'`
component that imports `REFUSAL_CATEGORY_META` would drag `node:crypto` into the
browser bundle** — Next polyfills no `node:`-prefixed builtin. T7 should read
the meta map in a SERVER component and pass labels down as props (or import only
the types), exactly as `BatchReport.tsx` receives its `BatchView`. Fixing the
seam properly means exporting `DOWNGRADE_MARKERS` (or splitting the action
literals into their own leaf), which is another task's file.

**D12c — "the tenant predicate on both sides" needs a `businesses` bridge,
because neither `reviews` nor `responses` carries an `account_id`.** Their only
tenant column is `business_id` (`scripts/ci/tenant-tables.ts:132`), so the
obvious `rev.business_id = r.business_id` proves nothing to `ci:tenant-scope`:
`directlyScoped` needs a BOUND predicate, and the chain rule (`viaBusiness`)
needs a `businesses` binding to chain through — and `flagged_responses` is in
`REVIEWED_NOT_TENANT_SCOPED`, so the root cannot confer scope either. Both arms
therefore join `businesses loc ON loc.id = r.business_id AND loc.account_id =
${scope.accountId}` and tie the child to `loc.id`. That is stronger than the
plan's wording as well as auditable: the root's business must belong to the
scoped account AND the child must belong to that business, so a root row
claiming a foreign `business_id` is dropped in aggregate scope too.

Proved non-vacuous rather than assumed: driving the audit's exported
`auditSourceText` over the real module and over two in-memory mutations gives
0 findings as written, 4 without the bridge's bound predicate
(`businesses` ×2, `reviews`, `responses`), and 2 without the child-to-bridge tie.
A green `ci:tenant-scope` on this file is a real proof, not silence.

**D12d — a DANGLING `flagged_responses.review_id` is unrepresentable, so
`getRefusalLog drops a flagged response whose review row is gone` cannot mean
what it sounds like.** Migration 051:18 declares the FK `ON DELETE CASCADE`:
deleting the review deletes the flag row. The case asserts the observable
behaviour (the entry is gone, the sibling entry stays) and records that the
INNER JOIN is the second lock, not the only one. The join's real work is proved
by the cross-tenant case beside it, where the review exists and belongs to
somebody else.

**D12e — `refusalCategoryFor('auto_post_revoked', …)` answers in TWO key
spaces.** The eval's locked feeder table (`every source code maps to its locked
RefusalCategory`) names the six DOWNGRADE REASONS; the read passes the five
stored ACTIONS. `CODE_MAPS.auto_post_revoked` merges both, and the action half
is derived from the reason half, so they cannot disagree. No key collides. One
lane, one lookup, two spellings of the same six decisions.

**D12f — one eval title moved file, and three non-eval cases were added.**
`getRefusalLog returns no draft text or review text for a held draft` moved from
`read.test.ts` (where T0 filed it as `.todo` in a describe that can only read
module TEXT) to `read.integration.test.ts`, where it asserts that real seeded
moderation prose, a real draft body and a real review body do not survive the
read — D9e's precedent, and placement is free because the `promised-tests` gate
is a fixed-string grep. Added beyond the eval: `getRefusalLog maps a
policy-suspended downgrade to autonomy_paused` (so the arm reads the whole
five-action list, not the one action the other fixtures use),
`refusalCategoryFor resolves a stored auto-policy audit action`, and the two
D11 derivation cases.

Verdict: **ACCEPT** for all six. D12b is the one that carries forward: T7 must
not import `vocabulary.ts` from a client component as things stand.

## D13 — Six things T4 found that the plan did not anticipate

D12b is **closed**, not carried forward: `vocabulary.ts` is now
`import type`-only and a `'use client'` component may import
`REFUSAL_CATEGORY_META` directly. None of the below changes a locked decision,
and none touches `allowed_edit_surface`.

**D13a — `refusalCategoryFor` could not follow the action key space out of
`vocabulary.ts`, so the read gained ONE translation.** Moving
`AUTO_POST_REVOKED_ACTION_CATEGORIES` into `read.ts` (the brief's §A list)
necessarily removes the action half from the vocabulary's `CODE_MAPS` — the
alternative is `vocabulary.ts` importing `read.ts`, which imports it back. So
`refusalCategoryFor` now answers in ONE key space (the six downgrade REASONS,
which is what the plan's feeder table names and what its eval case asserts) and
`read.ts` exports `resolveRefusalCategory`, which is `refusalCategoryFor` plus
exactly the S3 action→category step and delegates unchanged for every other
lane. `groupEntries` calls it. D12e's "one lane, one lookup, two spellings" is
preserved as ONE lookup with a translation in front of it, rather than two
competing tables — and the derivation still throws
`ConflictingRefusalActionError`, so the two spellings still cannot disagree.
The four cases moved to `read.test.ts` with titles VERBATIM;
`refusalCategoryFor resolves a stored auto-policy audit action` now asserts both
halves — the read resolves what the database stores, and `refusalCategoryFor`
beneath it still refuses to invent a category for an action it does not read.
`AUTO_POST_REVOKED_ACTION_FOR_REASON` is exported from `read.ts` solely so its
`DOWNGRADE_MARKERS` parse-guard can see it, which is the same reason it was
exported before.

**D13b — two `docs/directory.md` rows are now stale, and they are T8's file.**
Row `vocabulary.ts` says `refusalCategoryFor` THROWS `UnknownRefusalCodeError`
and counts "42 source codes: 25 to a category, 17 to explicit `null`" — both
still true of the vocabulary, but the row should now also say the file is
`import type`-only BY REQUIREMENT and that the S3 audit-action key space lives
in `read.ts`. Row `read.ts` should gain the action key space, `resolveRefusalCategory`,
and the reason-dependent S6 anchor. T4 does not own that file.

**D13c — `ci:tenant-scope` proves the S6 arm through the `businesses` bridge,
not through `r.account_id`, so D9a's `$N` hazard cannot bite it.** Driving the
audit's exported `auditSourceText` over the real module and five in-memory
mutations: 0 findings as written; 1 finding each for the bridge's bound
predicate removed (`businesses`), the `agent_runs` join left unscoped
(`agent_runs`), S7's account predicate dropped (`solicitation_batches`) and S4's
dropped (`account_audit_log`); and **0** for S6's own account predicate dropped
or for its location fragment inlined D9a-style — because `viaBusiness` already
chains `r.business_id = loc.id` off the scoped bridge. A green
`ci:tenant-scope` on this file is a real proof for four of the five, and S6's
account scoping is proved behaviourally instead (`never returns a withheld
outreach from another location`, which is the eval's per-arm requirement
anyway).

**D13d — the SQL code lists are DEFENCE IN DEPTH, not the only lock, and the
exclusion cases do not distinguish them.** Widening `BATCH_HALTED_CODES` from
the derived two to all six halt reasons left every exclusion case green:
`groupEntries` drops a `null` category before it becomes an entry. That is the
documented design (`read.ts` says a row that still arrives means a widened query
rather than a fault), but it means the five exclusion cases prove the
VOCABULARY's `null` mappings, not the arms' `= ANY(…)` filters. Recorded so a
later reader does not mistake one for the other. Both locks are derived from the
same map, so neither can drift on its own.

**D13e — S6's anchor is computed ONCE, in a `CROSS JOIN LATERAL`.** The
reason-dependent `CASE` is needed three times — the projection and both window
bounds — and spelling it three times invites exactly the drift where the value
the owner sees and the value the window filters on disagree. A `sql` fragment
was rejected (postgres.js fragment reuse inside one template is not something to
rely on, and D9a's substitution rule makes nested fragments a hazard near
predicates); the LATERAL is one definition, plain SQL, and audits clean.

**D13f — migration 111 has no `schema-ready.ts` marker, so `platform_halt` is
asserted by a fixture rather than by `assertSchemaReady`.** The suite requires
074, 088, 090, 091 and 110. A local DB behind 111 fails the two `platform_halt`
cases loudly on 111(a)'s halt-consistency CHECK rather than returning nothing,
which is the acceptable shape; adding the marker means editing
`schema-ready.ts`, outside T4's edit surface.

Verdict: **ACCEPT** for all six.

## D14 — Four things T5 found that the plan did not anticipate

None changes a locked decision, and none touches `allowed_edit_surface`.

**D14a — the log-redaction claim has a boundary limit the route does not own.**
`reportCaughtError` (`src/lib/shared/report-caught-error.ts`, reached through
`withDashboardOwnerRead`'s catch) serializes an error's `name` and `message` —
and its `stack` on any lane that is not production-configured. So a database
error whose MESSAGE embeds `flagged_responses.reason` puts that prose in a log
line no matter what this route does; the only fix is a change to the shared
sink, which is outside T5's surface and would move ~40 other routes with it.
`the refusals route logs no flagged reason` is therefore scoped to the two
vectors the route does own, and asserts both: the refusal PAYLOAD reaches no
sink (the success path emits zero log lines, and the error line's `data` is
exactly `{ accountId }`), and the postgres.js error BODY — `query`,
`parameters`, `detail`, the fields that actually carry a row — never appears,
which is what "never echo a DB error body" means operationally. The response
case is unconditional by contrast: `the refusals route returns no flagged
reason on an error path` plants the reason in the message AND the body and the
500 is still the boundary's fixed literal.

**D14b — `ci:feature-surface` cannot go green on an uncommitted file.** Its two
inputs are `git diff --name-only <merge-base> HEAD` and `git ls-files`
(`scripts/ci/feature-surface-audit.ts:154,169`), so a brand-new route that
exists only in the working tree still reports as an entry matching NO file. The
T5 definition of done reads "creating it should turn that audit green"; the
accurate form is "committing it does". Verified: red immediately after `Write`,
green at the T5 commit, with `src/app/api/dashboard/refusals/route.ts` the last
unmatched entry in the whole feature.

**D14c — no dashboard API route is impersonation-aware, and this one must not
become the first.** Impersonation resolves inside `requireRole`: the session
already IS the impersonated owner, and `IMPERSONATION_COOKIE_NAME` gates
MUTATIONS only (`src/app/api/settings/auto-approval/route.ts:30,61` passes
`impersonated` to a settings write, never to a read). So `the refusals route
reads only the impersonated account` cannot be proved by a cookie branch — a
branch there would be the defect, not the fix. It is proved behaviourally
instead: the resolved owner's `accountId` is the only account reaching
`getRefusalLog`, and the ADMIN's own location resolves to the same uniform
`Business not found` 404 as any other tenant's, so the impersonated session's
tenant boundary is the ordinary one.

**D14d — the invariant-#12 source scan missed re-shaping until a mutation probe
found it.** Two probes were run against the committed route to prove the
redaction cases bite rather than pass vacuously. Probe 1 (echo the caught error
into the body and `console.error` the error object) turned `… returns no
flagged reason on an error path` and `… logs no flagged reason` red, as it
should. Probe 2 (`log.categories.map(…)` re-shaping each entry with the
request's `?reason=`) turned `… serializes no flagged reason at any depth` red —
but slipped past the #12 source scan, whose forbidden list held `.filter(`,
`.reduce(` and `.sort(` and not `.map(`. `.map(` is now on the list: re-shaping
what the read returned is exactly the leak this route must not be able to do,
and the body is `{ window, ...log }` or nothing.

Verdict: **ACCEPT** for all four.

## D15 — Surface amendment 2 of 2, and the re-classification

**The budget is now SPENT. A third `allowed_edit_surface` change triggers the
abort criteria** — tear down, post-mortem, restart at step 1. Note especially
that step 8 asks to promote durable deviations into
`.claude/reference/lab-notes.md`, which is NOT in the surface; do that from the
main checkout after merge, where the worktree guard does not apply, never by
amending again.

### D15a — amendment: `.claude/reference/arch-review-log.md`

`ci:merge-ledger` fails any PR that changes production files and adds no line to
that log (#896, #849, #905 — a merge skipping the workflow is otherwise
invisible by construction). It is a required check in the `lint` job, so the PR
cannot merge without it, and `/feature` step 8 mandates the same line. My intake
should have listed the file and did not.

The owner approved the NARROW form (this one file) over widening to
`.claude/reference/*.md`, on 2026-08-29. Both intake copies updated; surface is
now 22 entries. Verdict: **ACCEPT**.

### D15b — re-classification trigger fired, lane confirmed unchanged

The gate's `reclassify` row: production **1,267** changed lines against
`estimated_prod_lines: 700` — over 2×. Tests **2,914** against 2,000 — under.

Step 0 re-run honestly against the four epic triggers:

| Trigger | Verdict |
|---|---|
| Surface untightenable beyond a few top-level dirs | **No** — 21 specific paths, `ci:feature-surface` green with every entry matching |
| Spans multiple risk domains (schema + billing + worker) | **No** — no migration, no billing, no worker change |
| More than ~8 tracer tickets | **No** — exactly 8, T1–T8, plus T0 the eval |
| Open investigation questions grilling cannot resolve | **No** — none remain |

So **RISK = high, SURFACE = mixed, normal feature** stands. The lane was right;
the estimate was wrong.

**Where the estimate went wrong, for the next estimator.** `read.ts` came in at
637 lines against ~250 estimated. The miss was not the six arms — it was what
each arm costs once tenant isolation must be *proved* rather than asserted:
every arm needs a `businesses` bridge predicate plus a child tie (T3's D12c),
its own `AND ${inLocation}` conjunct spelled apart from the account predicate so
`ci:tenant-scope` can see it (T2's D9a), and — because one `UNION ALL` defeats
structural assertions — its own behavioural negative-row test. Roughly 3× the
naive per-arm estimate.

Estimates corrected to 1,600 / 3,400, which includes T7's projected screen.
Owner confirmed "lane stands, continue to T7" on 2026-08-29.

Verdict: **ACCEPT**.
