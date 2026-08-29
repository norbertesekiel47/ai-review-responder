# Standards & maintainability review — `feat/refusal-log`

Axis: code quality, repo standards, how this ages. **Not** spec conformance, **not**
tenant-scoping correctness, **not** the overall approach — three other agents own those.

- Worktree `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-refusal-log`
- Branch `feat/refusal-log`, HEAD `1466ffc6`, fork point `5ab6bfee`
- Diff: 28 files, +6,867 / −2. Production TS/TSX/CSS: 8 new files, ~1,267 lines.
- Method: `/thermo-nuclear-code-quality-review` applied to the full diff, plus the
  six repo-specific checks and the anti-slop checks from the brief. Read whole:
  `vocabulary.ts`, `read.ts`, `route.ts`, `RestraintContent.tsx`, `RestraintReport.tsx`,
  `AnalyticsTabs.tsx`, `page.tsx`, `restraint.css`, all five test files (sampled),
  plus every precedent the branch names — `agents/read.ts`, `agent-team/route.ts`,
  `BatchReport.tsx`, `ReviewsTabs.tsx`, `step-facts.ts` — and the neighbours it did
  not name: `DashboardStatePanel.tsx`, `AnalyticsContent.tsx`, `AgentTeamStrip.tsx`,
  `useDashboardData.ts`, `held-draft.ts`, `delivery-status.ts`, `CardViewTabs.tsx`.

---

## Findings (≥80% confidence)

| # | Severity | Location | Finding |
|---|----------|----------|---------|
| 1 | HIGH | `src/components/dashboard/restraint/RestraintContent.tsx:179-233` | `useRefusalLog` hand-rolls request keying, stale-response rejection, abort lifecycle and loading-derivation that `@tanstack/react-query` already provides — and that `AgentTeamStrip.tsx:69-72`, the consumer of the very precedent this branch cites, already uses. |
| 2 | HIGH | `src/components/dashboard/restraint/RestraintContent.tsx:56-57,94-143` | Re-implements `renderDashboardStatePanel` (`src/components/dashboard/shell/DashboardStatePanel.tsx:45-88`) — the module extracted to be that scaffold's single owner — including its three-term `showError` precedence and its error paragraph's inline style. Consequence: the Analytics tab bar disappears during load/error on `/dashboard/analytics` but persists on `/dashboard/analytics/restraint`. |
| 3 | MEDIUM | `src/lib/refusals/read.ts:159` | `AUTONOMY_SUSPENDED_EVENT_TYPE` is a third hand-spelling of `'autonomy_suspended'` with nothing tying it to its writer, and the integration fixture re-spells the same literal — so a rename in `src/lib/auto-approval/suspension.ts:311` silently empties the S4 arm with every test green. The branch already owns the fix technique (`read.test.ts:92-110` parses `DOWNGRADE_MARKERS` out of its owner). |
| 4 | MEDIUM | `src/lib/refusals/read.ts:212-237` | `deriveActionCategories`'s `<Action extends string>` parameter and its closing `as Record<Action, …>` cast are both dead — the sole production caller (`read.ts:245-250`) annotates the result `Readonly<Record<string, …>>`, erasing exactly the key precision the generic exists to produce. Both parameters are `Record<string, …>`, so key-space mismatch is a runtime throw (`:219-223`) where a second type parameter would make it unrepresentable. |
| 5 | LOW | `docs/directory.md` (§`dashboard/` routes, around `:342`) | The branch added `src/app/api/dashboard/refusals/route.ts` with no row, in a table that is otherwise complete for `api/dashboard/**` — its direct sibling `agent-team/route.ts` is listed. |
| 6 | LOW | `src/lib/refusals/read.ts:11` | Cites `src/lib/agents/read.ts:424`; `getAgentTeamSummary` is at line **432** at HEAD, and this branch's own 8-line insert at `agents/read.ts:194-201` is what moved it. |
| 7 | LOW | `src/lib/refusals/read.ts:135-151` | Six consecutive two-line comments, each closing with the verbatim sentence "Checked against the closed union at compile time." One comment above the block says the same thing in a sixth of the space. |
| 8 | LOW | `src/components/dashboard/restraint/RestraintContent.tsx:249-252` | `isRefusalCategory` returns `boolean` where its three sibling guards in the same file return `value is T`, so `isRefusalEntry`/`isRefusalCategoryGroup` narrow nothing for the field they claim to have proven. |

---

## Detail

### 1 · HIGH — `useRefusalLog` re-implements the repo's canonical query layer

`@tanstack/react-query@^5.100.14` is a first-class dependency (`package.json:67`),
its `QueryClientProvider` is mounted in
`src/app/(authenticated)/_components/AuthenticatedProviders.tsx` — the same route
group `/dashboard/analytics/restraint` lives in — and it is the idiom for scoped,
windowed dashboard sub-payload reads across eight client surfaces including
`DashboardContent.tsx`, `NeedsAttentionList.tsx`, `TimelineContent.tsx` and
`ImportOfferBanner.tsx`.

Most pointedly, `AgentTeamStrip.tsx` is the client consumer of
`GET /api/dashboard/agent-team` — the endpoint this branch's route file describes as
"`agent-team/route.ts` WITH ONE NAME CHANGED". Its whole read is:

```ts
const query = useQuery({
  queryKey: ['dashboard-agent-team', scope, window],
  queryFn: ({ signal }) => fetchAgentTeam(scope, window, signal),
});
```

`useRefusalLog` reproduces the same four behaviours by hand across 55 lines: a
`SettledRefusalLog` type that stamps the result with the `(scope, period)` it was
fetched for, a manual `AbortController`, a derived-`loading` comparison at
`:224-232`, and a 14-line comment (`:165-178`) explaining that clearing state at the
top of the effect would trip `react-hooks/set-state-in-effect` — a problem `useQuery`
does not have.

The `fetch` + guard half **is** correct precedent: `fetchAgentTeam`
(`AgentTeamStrip.tsx:126-148`) has the identical `headers: { Accept }`,
`await response.json().catch(() => ({}))`, error-message extraction and
"response was incomplete" throw. So the branch found the right precedent and then
re-implemented the half of it that was already free.

Concrete cost: refetch-on-focus, dedup across mounts, retry policy, cache invalidation
and devtools work on every other dashboard read and not on this one. The moment
Restraint wants a refresh button, a window prefetch, or invalidation after any write,
that all has to be built by hand into a hook nothing else shares.

**Remedy:** delete `useRefusalLog` and `SettledRefusalLog`; keep the guards and the
fetch function; call `useQuery({ queryKey: ['dashboard-refusals', scope, period], queryFn })`.
Net −50 lines and one fewer state machine to reason about.

### 2 · HIGH — the loading/error scaffold is duplicated, and the two Analytics tabs now behave differently

`DashboardStatePanel.tsx:45-51` states its own purpose: *"One owner of the TopBar +
content wrapper + LiveRegion + error-card markup the analytics and reviews
orchestrators previously duplicated."* This branch adds a third copy.

`RestraintShell` / `RestraintLoading` / `RestraintError` (`RestraintContent.tsx:94-143`)
reproduce the same `<TopBar>` + `.content content--analytics` + `<LiveRegion>` +
`.dashboard-skeleton` / `.skeleton-card-lg` + `.card` / `.card-h2` structure, and
`restraint.css:181-187`'s `.rst-error-body` is a class-form copy of the panel's inline
`{ fontSize: 14, color: 'var(--rw-app-text-muted)', marginTop: 4 }`.

The subtle part is worse than the markup. `RestraintContent.tsx:57` re-derives:

```ts
const showError = !loading && data !== null && error !== null;
```

which is byte-equivalent to `DashboardStatePanel.tsx:61`'s
`!state.loading && state.hasData && state.error != null`. That expression has a
non-obvious consequence — `useDashboardData` returns `data === null` on a *first*
fetch failure (`useDashboardData.ts:167-172`: `dataState.data` is still null, the key
matches, `error` is set, `loading` false), so `showError` is false and the branch
renders the **skeleton**, not the error. Whatever one thinks of that behaviour, it now
has two homes that must be changed together.

**The visible consequence.** `AnalyticsTabs` is rendered inside
`AnalyticsAggregateView.tsx:44` and `AnalyticsPerLocationView.tsx:52` — i.e. *after*
`AnalyticsContent.tsx:38-40` has already returned `renderDashboardStatePanel(...)` on
the loading/error path. So on `/dashboard/analytics` the tab bar is absent while the
page loads and while it errors; on `/dashboard/analytics/restraint` it is present in
both. One tab bar, two behaviours, decided by which copy of the scaffold ran. The
`RestraintShell` docstring even claims the tabs "never disappear mid-load" — true for
this route, false for its sibling, and false on this route's own
`SubscriptionUnavailableCard` branch (`:68-76`), which bypasses `RestraintShell`
entirely.

The stated justification (`RestraintContent.tsx:41-44`) is that the helper "emits a
`TopBar` immediately followed by the content box, leaving nowhere between the two for
the routed tab bar, and `DashboardSurface` has no `'restraint'` member (**its file is
outside this feature's edit surface**)". The parenthetical is a process constraint, not
an engineering one, and it is what produced the divergence. The helper already takes a
`topBarActions` slot; adding a `'restraint'` member plus a `contentPrefix?: ReactNode`
slot is roughly ten lines in the file that exists for this, and it fixes the Analytics
tab-bar behaviour in the same change.

**Remedy:** extend `renderDashboardStatePanel` with the third surface and a
before-content slot; render `<AnalyticsTabs>` through it on both routes; delete
`RestraintShell`, `RestraintLoading`, `RestraintError` and `.rst-error-body`.

### 3 · MEDIUM — the one re-spelled stored value with no cross-check

`read.ts:159` declares `const AUTONOMY_SUSPENDED_EVENT_TYPE = 'autonomy_suspended'`,
and its own comment concedes the failure mode: *"A wrong spelling shows up as an empty
arm."* It is the third hand-spelling — `src/lib/auto-approval/suspension.ts:311`
writes it, `worker/jobs/autonomy-suspended-notice/context.ts:127` reads it.

The comment claims the S4 presence case catches a drift. It does not:
`read.integration.test.ts`'s `seedSuspensionAudit` writes `'autonomy_suspended'` as its
own literal into `account_audit_log`, so fixture and read agree with each other while
both disagree with the writer. Rename the event type in `suspension.ts` and the S4 arm
returns nothing in production with the entire suite green.

This is the *only* ownerless vocabulary in the branch left unguarded. The author solved
the identical problem twice elsewhere: `vocabulary.test.ts:198-223` parses
`supabase/migrations/111_platform_halt_reason.sql` for the batch-halt and
outreach-disposition lists, and `read.test.ts:92-110`'s `downgradeMarkerTable()` parses
`DOWNGRADE_MARKERS` out of `worker/jobs/publisher/auto-policy-downgrade.ts` because it
is module-private and cross-tree. `suspension.ts` is neither — a two-line
`export const AUTONOMY_SUSPENDED_EVENT_TYPE` there, imported by both readers, is
cheaper than either parse the branch already wrote.

### 4 · MEDIUM — `deriveActionCategories`'s generic and cast buy nothing

```ts
export function deriveActionCategories<Action extends string>(
  categoriesByReason: Readonly<Record<string, RefusalCategory | null>>,
  actionByReason: Readonly<Record<string, Action>>,
): Readonly<Record<Action, RefusalCategory | null>> {
  …
  ) as Record<Action, RefusalCategory | null>;      // :236
}
```

The type parameter's only product is a key-precise return type, and the sole production
caller throws it away:

```ts
export const AUTO_POST_REVOKED_ACTION_CATEGORIES: Readonly<
  Record<string, RefusalCategory | null>          // :245-246 — widened
> = deriveActionCategories(…);
```

Nothing in the module ever observes `Record<AutoPolicyAuditAction, …>`. Drop the
generic and the `as` at `:236` disappears with it, matching the shape its immediate
neighbour `refusalCodesOf` (`:258-264`) already uses.

Separately, both parameters are keyed `string`, so the two maps' key spaces are
unrelated to the compiler — `deriveActionCategories(ASK_WITHHELD_REFUSAL_CATEGORIES,
AUTO_POST_REVOKED_ACTION_FOR_REASON)` compiles and fails at runtime. That is why
`:219-223` needs a `'reason' has no refusal category` throw at all. A second parameter,
`<Reason extends string>` shared across both maps, makes that branch unreachable — a
deleted error path, not a moved one.

Finally, the function is exported with one production caller, reached elsewhere only by
`read.test.ts:336,346`. Working rule: *"no abstractions for a single caller."* The
`ConflictingRefusalActionError` throw is worth keeping — the derivation genuinely can
misfile a refusal if the collapse ever becomes inconsistent — but it does not need a
generic, a cast, or an export to do it.

### 5 · LOW — a route landed without its `docs/directory.md` row

The `#### dashboard/` route table is complete for `src/app/api/dashboard/**` (every one
of the 38 route files is either listed or covered by the `past-replies/*` parenthetical).
`refusals/route.ts` is the one omission, sitting two rows away from the
`agent-team/route.ts` entry it is modelled on.

`ci:directory-map` only enforces `worker/` + `src/lib/`, so CI is green — and the two
`src/lib/refusals/` rows the branch *did* add are accurate at HEAD (verified below).
This is a hand-maintained section the author was already editing.

The `page.tsx`, `restraint.css`, `AnalyticsTabs.tsx` and the two `restraint/`
components have no rows either, but the pages table carries no `dashboard/analytics/*`
entries at all and `ReviewsTabs.tsx` is likewise unlisted, so those omissions match
existing practice and are not findings.

### 6 · LOW — one stale line citation, created by this branch

`read.ts:11-12`: *"THE SHAPE IS `getAgentTeamSummary`'s (`src/lib/agents/read.ts:424`)"*.
At HEAD it is line **432**. The branch's own diff added the 8-line `DashboardReadScope`
docstring at `agents/read.ts:194-201`, which is precisely what shifted it — the citation
was stale the moment it was written.

Every other cited line I checked is accurate: `restraint-policy.ts:45`
(`WITHHOLD_REASONS`), `BatchReport.tsx:27`/`:29`, `auto-approval.ts:37`,
`persist.ts:570-576`, `judge-store.ts:115`, `suspension.ts:311`/`:352-354`,
`context.ts:127`, `dispatch.ts:1371-1379`. So this is one slip in a file that otherwise
holds its citations well — worth fixing precisely because the rest can be trusted.

### 7 · LOW — six copies of one comment

`read.ts:135-151` declares six source constants, each preceded by a two-line comment
whose second line is verbatim identical:

```
/** S1 · the held draft. Checked against the closed union at compile time. */
/** S3 · `approval_audit_log`. Checked against the closed union at compile time. */
… ×6
```

Twelve lines to say one thing six times. The lane-to-table mapping is the useful half
and it is already in `vocabulary.ts:86-93`; one comment above the block carries the
`satisfies` rationale.

This is the branch's only comment-padding instance of consequence — see the density
assessment below, which is otherwise a pass.

### 8 · LOW — one guard is not a type predicate

`RestraintContent.tsx:249-252`:

```ts
function isRefusalCategory(value: unknown): boolean {
```

Its three siblings in the same block (`isRefusalEntry`, `isRefusalCategoryGroup`,
`isRefusalLog`, `:254-277`) all return `value is T`. Because this one returns plain
`boolean`, `isRefusalEntry`'s `value is RefusalEntry` claim is unbacked for `category` —
TypeScript sees an unrelated boolean in the conjunction. Change the return type to
`value is RefusalCategory`. One token, and it makes a future edit that drops the call
visible rather than silent.

---

## Checks that passed — stated because the brief asked

**Deep-module discipline (check 2).** Both large files pass the deletion test.

`read.ts` at 637 lines is 305 comment lines (48%) — the remaining ~330 are ~200 lines of
one irreducible six-arm `UNION ALL` plus ~130 of derivation. `getRefusalLog(sql, scope,
window)` hides six tables, six vocabularies, two key spaces, a reason-dependent
timestamp partition and the tenant bridge behind three parameters. That is a deep
module, not an accumulation site. The one blemish is export surface: `deriveActionCategories`,
`ConflictingRefusalActionError`, `AUTO_POST_REVOKED_ACTION_FOR_REASON` and
`AUTO_POST_REVOKED_ACTION_CATEGORIES` are exported only so tests can reach them, which
makes a one-function interface read as six. Finding 4 covers the worst of it; the rest
matches repo practice (`held-draft.ts` exports `openFlagExistsSql` the same way).

`vocabulary.ts` at 430 lines is 203 comment lines (47%); of the ~227 remaining, nearly
all are the maps themselves. There is no logic to split out — `refusalCategoryFor` is
10 lines. Splitting it would produce two files that must be read together.

**Comment density and idiom (check 5).** 48% / 47% is squarely in band for load-bearing
modules here: `batch-view.ts` 43%, `business-summary.ts` 44%, `delivery-status.ts` 58%,
`kpi/fragments.ts` 75%. The comments carry mechanism, not restatement — the S6
reason-dependent anchor note (`read.ts:554-571`), the `ci:tenant-scope` placeholder trap
(`:326-337`) and the account-wide-S4 multiplication warning (`:505-511`) each explain
something a reader could not derive and could plausibly break. Only finding 7 is padding.

The `node:crypto` / client-bundle rationale is restated in six places
(`vocabulary.ts:13-23`, `read.ts:29-36`, `read.ts:171-173`, `RestraintReport.tsx:9-15`,
plus both test headers) and the `latchHalt` double-count trap in seven. That is a lot of
copies of two facts, but each sits at a site where you could break it, which is the
repo's "traps" idiom rather than a violation — noted in the appendix, not the table.

**Glossary conformance (check 3).** Clean. All four LOCKED terms are used exactly:
`RefusalCategory` / `REFUSAL_CATEGORIES`, `RefusalSource` / `REFUSAL_SOURCES`,
`RefusalEntry`/`RefusalLog` for the Refusal itself, "Restraint" throughout the tab
(`AnalyticsTabs.tsx:38`, `page.tsx:7`, `RestraintContent.tsx:107`, the `rst-` CSS
prefix). No _Avoid_ term appears in an identifier, comment or string: no `refusal type`,
no `refusal origin`, no `bucket`, no `blocked reason`, no `refusals dashboard`. The
route path `/api/dashboard/refusals` is a plural of the locked noun, which is correct.

**`docs/directory.md` accuracy for `src/lib/` (check 4).** Both new rows are true at
HEAD. Verified against the code: "42 source codes: 25 to a category, 17 to explicit
`null`" — 6+4+5+8+2 = 25 non-null across the five keyed maps, 1+4+12 = 17 null, 42
total ✓. "Four vocabularies are `satisfies Record<SourceEnum, …>`-guarded" — exactly the
four keyed by an upstream enum (`AutoPolicyDowngradeReason`, `AutonomySuspensionTrigger`,
`WithholdReason`, `RenderWithholdReason`) ✓. "the five `AUDIT_ACTION_*` value imports" —
`read.ts:65-69` ✓. "the window needs an UPPER bound the `getAgentTeamSummary` precedent
lacks" — `agents/read.ts:438-457` has `occurred_at >= windowStart` and no upper bound ✓.
No stale row. The gap is the missing *route* row, finding 5.

**Test quality (check 6).** `read.integration.test.ts` at 1,483 lines is **not** a wall
of near-duplicate fixtures. It has the seeding helper layer the brief asked whether it
lacked: `seedBatch`, `seedContact`, `seedWithheldAsk`, `seedReview`, `seedDraftResponse`,
`seedHeldDraft`, `seedDowngrade`, `seedSuspensionAudit`, `seedSendAskChain`,
`seedAgentRun`, `seedOutreach`, plus assertion helpers `onlyEntry`, `entryIds`,
`accountScope`, `locationScope`. Each takes only the axis its cases vary and derives the
constraint-satisfying rest — `seedBatch` derives `halted_by` from `HUMAN_HALT_REASONS`
because migration 111 makes it a function of the reason; `seedWithheldAsk` mirrors
`evidence` because 090 CHECKs it. That is the right factoring, and it is *why* 38 cases
fit in 1,483 lines rather than 4,000. It reuses the shared tenant fixtures
(`live-db-tenant`, `live-db-lock`, `schema-ready`, `outreach-fixture`) rather than
forking them, keeps both live-DB conventions, and freezes only `Date`. Reads as
maintainable.

The unit and component suites (401 / 392 / 527 / 414 / 53 lines) are proportionate and
each case is distinct. The route suite's three redaction cases (body at any depth, error
path, logs) are the right shape for the risk.

**Precedent conformance (anti-slop).** Genuinely followed, with one exception:

- `getAgentTeamSummary` — same `(sql, scope, window)`, same `DashboardReadScope`, same
  `dashboardWindowParams`, same aggregate/location branch ✓. The rename to
  `DashboardReadScope` is complete: zero `AgentTeamScope` occurrences remain outside
  historical review logs.
- `agent-team/route.ts` — `refusals/route.ts` is structurally identical, same
  `withDashboardOwnerRead` / `resolveDashboardRequest` / `resolveDashboardLocation` /
  `{ window, ...payload }` ✓.
- `BatchReport.tsx` — `RestraintReport` matches its `Record<ClosedEnum, Meta>` label
  table, its module-scope `Intl` formatters, its pure-presentation-over-one-object
  contract, and its `import type` discipline ✓.
- `ReviewsTabs.tsx` — `AnalyticsTabs` is a faithful structural copy (`<nav className="tabs">`,
  `aria-current`, plain `next/link`, literal `active` prop) and correctly rejects
  `CardViewTabs` as the precedent, as `CardViewTabs`' own comment instructs ✓.
- `step-facts.ts` — cited in the ADR and plan as the owner-safe-projection precedent;
  the read applies the same rule (project an allowlist, never a redacted-on-render field).
  No code path selects `flagged_responses.reason` ✓.
- **The exception** is `AgentTeamStrip.tsx`, the client half of the named precedent —
  finding 1.

**Net-negative bias (anti-slop).** Nothing in the diff is unjustified new code beyond
what findings 1, 2 and 4 name. `isObject` (`RestraintContent.tsx:235`) is a fifth
module-private copy but matches established practice (`AgentTeamStrip.tsx:152`,
`NeedsAttentionList.tsx:168`). `enterStagger` and `WINDOW_PHRASE` are local and earn
their place. No migration, no new env var, no new top-level directory, no new dependency.

**Invariants and hygiene.** #12 — the route orchestrates only, 26 lines of body, pinned
by `refusals-route.test.ts:363` ✓. #15 — `sql` is an explicit parameter everywhere; the
route is the only composition root; `read.test.ts:389` scans the directory ✓. No `any`,
no `@ts-ignore`, no `eslint-disable`, no `console.*` anywhere in the new production code.
No silent catch beyond `.catch(() => ({}))` on a JSON body, which is verbatim the
`useDashboardData:57` / `AgentTeamStrip:135` idiom. `restraint.css` is token-only, no
hardcoded colour outside a contrast-annotation comment, no `!important`, honours
`prefers-reduced-motion`.

---

## Low-confidence appendix — judgement calls, not findings

- **`RENDER_WITHHOLD_CODES` (`read.ts:306`) is an identity alias** of
  `RENDER_WITHHOLD_REASONS` carrying a six-line comment, existing only to widen a
  `readonly` tuple to `readonly string[]` for the `= ANY(…)` bind. Whether
  `${RENDER_WITHHOLD_REASONS}` binds directly under postgres.js's parameter typing I did
  not verify, so I will not call it dead. If it does, the alias and its comment go.
- **Three near-identical routed tab bars.** `ReviewsTabs` and `AnalyticsTabs` are the
  same 20 lines with different copy, and `CardViewTabs` already proves the repo will
  generify a tab control when it has two callers. A
  `<RoutedTabs label tabs={[{href,label,key}]} active />` would delete both. Two callers
  is right at the "no abstractions for a single caller" boundary, so this is a judgement
  call rather than a violation — worth doing on the third route tab bar, not this one.
- **The `node:crypto` and `latchHalt` rationales are restated six and seven times.** The
  repo's "one authoritative owner per fact" rule argues for a single home plus pointers;
  the "traps live where you'd break them" idiom argues for what is there. I lean toward
  trimming `read.ts:171-173` (which both restates *and* points at the two headers), but
  this is style, not a standard.
- **Two reads to render one tab.** `RestraintContent` fetches the full `/api/dashboard`
  payload — KPIs, trends, feeds, none of which it renders — solely to evaluate
  `perLocationActive(data)` for the entitlement gate, then fetches
  `/api/dashboard/refusals`. Both fire in parallel, so this is not serialised
  orchestration, and Analytics and Reviews do exactly the same, so it is the precedent.
  Still, the Restraint tab's time-to-content is gated on a payload it never shows, and a
  narrow entitlement endpoint would help all three surfaces. Out of this axis' scope but
  worth someone's backlog.
- **The `showError` skeleton-instead-of-error behaviour** (see finding 2's detail) is
  pre-existing in `renderDashboardStatePanel` and reproduced faithfully rather than
  introduced. It is a bug, but it is not this branch's bug — only the second copy is.
