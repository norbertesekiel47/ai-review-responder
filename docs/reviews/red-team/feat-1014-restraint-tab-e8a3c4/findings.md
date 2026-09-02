# Red team — `feat/1014-restraint-tab` (#1014, the Restraint tab)

| | |
|---|---|
| Mode | `feature` (review wave, step 7) |
| Risk | **high** |
| Round | 1 of 2 |
| Fork | `b55b07822ef92f6c85047e6f42b5513ea8427257` |
| Merge base | `b55b07822ef92f6c85047e6f42b5513ea8427257` |
| Head | `3716d2530251b2ab6f48d1a53023e4bc82393b76` |
| Intake SHA-256 | `bdda9628…7c6d8` |
| **Status** | **`OPEN_P0`** — 4 confirmed survivors, 4 open P1, 4 open P2 |

Baseline at HEAD: **73/73 green** (50 in the `parallel` project, 23 in the
`integration` project against local Postgres). Every mutation below was applied
to that tree and reverted; `finalize` restored 0 outstanding mutations and 1
dotenv file, and `git status --porcelain --untracked-files=no` is empty.

---

## Preconditions — one documented deviation

1. **Clean tracked tree at a committed SHA** — satisfied.
2. **No process serving or watching this worktree — DEVIATION, proceeded.**
   `mutation-runner.mjs watchers` aborted on four processes. The check is
   machine-wide (`ps -Ao`) and cannot scope to a worktree. I resolved each PID's
   working directory with `lsof -a -p <pid> -d cwd`:

   | PID | Command | cwd |
   |---|---|---|
   | 68547 | `pnpm dev --port 3000` | `…/startups/RepWorth` (parent checkout) |
   | 69387 | `next dev --port 3000` | `…/startups/RepWorth` (parent checkout) |
   | 69738 | `next-server` | `…/startups/RepWorth` (parent checkout) |
   | 76253 | `next-server` | `…/RepWorth-worktrees/refactor-globals-css-extraction` |

   None has this worktree in its root, and a Next dev server watches only its own
   project root plus that root's `node_modules` — a sibling worktree is neither.
   The precondition **as stated in prose** ("no process is serving or watching
   *this worktree*") is therefore true; the command's abort is a false positive of
   a deliberately over-broad guard. I proceeded rather than killing the user's dev
   servers, which is outside a verifier's authority. Recorded here so the call is
   auditable.
3. **Journal closed, round open** — `round-start: round 1 open, 30 mutation runs
   available`.

**Environment isolation.** Allowlisted env via `mutation-runner env` (temporary
`HOME`, `NODE_ENV=test`, `CI=true`, `MOCK_EXTERNAL_APIS=true`, plus the
localhost-validated `TEST_DATABASE_POOL_URL`/`DATABASE_POOL_URL`), and
`dotenv-swap` replaced `.env.local` with a scrubbed copy for the whole mutation
phase. Baseline and mutant runs shared that environment byte for byte.

**Budget.** 28 of 30 runs used. 57 in-scope candidates were not executed and are
recorded `skipped-budget`; `OPEN_P0` outranks `INCOMPLETE_BUDGET` in the status
precedence, but the partial coverage is real and stated.

---

## The ten claims, adjudicated

| # | Claim | Verdict |
|---|---|---|
| 1 | Link authority is per-LANE and cannot be re-expressed as per-category | **BROKEN** — F1 |
| 2 | An account-wide suspension appears once per location view and exactly once in the account total | **HOLDS** — the `EXISTS`→fan-out `JOIN` mutation was killed |
| 3 | `all_refusal_codes` and `refusal_code` never reach the wire | **HOLDS** — adding both to the SELECT and the DTO was killed |
| 4 | Both window bounds are bound | **HALF-BROKEN** — the account arm's upper bound and the footnote's upper bound are proven; the LOCATION arm's upper bound (F2) and the account arm's LOWER bound (F3) are not |
| 5 | The coverage-start clamp makes the empty sentence true | **HOLDS** — removing the clamp was killed |
| 6 | `showError` is fixed | **HOLDS** — restoring `&& state.hasData` killed exactly the two tests that should fail, at the panel and at the consumer |
| 7 | The footnote is account-scope only and excludes rows after `windowEnd` | **HOLDS** — both halves mutated separately, both killed |
| 8 | The archived-period pairing ignores an unmatched reactivation and leaves a trailing archive open | **HOLDS** — both branches mutated separately, both killed |
| 9 | The impersonation route test uses the REAL `requireRole` | **HOLDS** — forcing the mock back on makes the test fail. SC-3 is genuinely closed and the case is not vacuous |
| 10 | Every `file:line` citation resolves and says what is claimed | **HOLDS**, with one overstatement — F10 (P2) |

---

## Findings

### P0 — blocks the PR

All four are the same species: a property the code implements correctly and the
comments treat as load-bearing, which **no test asserts**. Each was proven by a
mutation that survived the whole 23-case live-DB suite *and* its single most
plausible covering test under `assert-one-test`.

#### F1 — `resolveLinkKind`'s per-LANE authority is asserted by nothing
`src/lib/refusals/read.ts:122` · duty 1 · **open**

Rewriting the lane key to a category key — `source === 'held_draft'` →
`category === 'unsafe_content'` — leaves all 23 live-DB cases green.

Only **one** integration case asserts `linkKind` at all
(*"distinguishes a non-null unresolved subject from a lane with no subject"*),
and its three fixtures cannot separate the two rules: every `held_draft` row it
seeds carries `unsafe_content`, and its only non-`held_draft` subject-bearing
fixture is unresolvable, so both rules return `null`.

The promised collision test (intake title 47) is a **RestraintReport** title. That
component is *handed* a `linkKind` and cannot detect a wrong one —
`RestraintReport.tsx:63-65` says exactly that. So the defence against a
`policy_gate_held` row wearing a held draft's review link is implemented in
`read.ts` and verified nowhere.

> **Arbiter.** Not equivalent: for a `policy_gate_held` row with category
> `unsafe_content` and a *resolving* `responses` subject, the original returns
> `null` and the mutant returns `'review'` — precisely the collision migration
> 116's CHECK C1 makes representable, since both lanes take
> `subject_type = 'response'`. Not an unexecuted branch: line 122 is evaluated for
> every returned entry in all 23 cases.

**Fix:** one live-DB case seeding a `policy_gate_held` row (category
`unsafe_content`, a **resolving** response subject) beside a `held_draft` row that
resolves — assert the first's `linkKind` is `null` and the second's is `'review'`.

#### F2 — the LOCATION entry arm's upper window bound is asserted by nothing
`src/lib/refusals/read.ts:281` · duty 1 · **open**

Deleting `AND r.occurred_at <= ${windowEnd}` from the location arm leaves all 23
cases green. The promised bound test (intake title 19) exercises the **account**
arm and the footnote only. `read.ts:233-235` states the bound exists because
`occurred_at` is writer-supplied and a clock-skewed row must not appear after the
range the tab prints — equally true of a location view.

> **Arbiter.** Not equivalent: a location-scope read of a future-dated row is
> included by the mutant and excluded by the original — and the suite already
> proves the same predicate matters on the account arm. Not unexecuted: the
> location arm runs in eight cases.

**Fix:** extend title 19 to a second scope, or add its location-scope twin.

#### F3 — the account entry arm's LOWER window bound is asserted by nothing
`src/lib/refusals/read.ts:310` · duty 1 · **open**

Deleting `AND r.occurred_at >= ${windowStart}` leaves all 23 cases green. Every
seeded Refusal is minutes old while `windowStart` is at most 90 days back, so **no
fixture in the suite can distinguish a bounded window from an unbounded one.**
This is the predicate that makes "30d" mean thirty days, and the edge the E13
clamp exists to move.

> **Arbiter.** Not equivalent: without it an account read returns the whole
> retained ledger regardless of the selected window, and the summary sentence then
> names a range the query did not use. Not unexecuted: the account arm's `WHERE`
> runs in roughly twenty of the 23 cases.

**Fix:** seed a Refusal at `NOW() - interval '45 days'` in a 30d read and assert
it is absent — and, for symmetry with F2, one on each arm.

#### F4 — the `subject_resolves` business correlation is asserted by nothing
`src/lib/refusals/read.ts:275` (and `:306`) · duty 1 · **open**

Removing `AND resp.business_id = r.business_id` from **both** subqueries leaves
all 23 cases green. `read.ts:253-256` sells that clause as *"stronger than a bare
id match either way: a response belonging to another location cannot resolve"* —
it is what stops a `held_draft` row linking to a **sibling location's** review.
Every fixture seeds the response under the Refusal's own business, so the
correlation is never exercised.

> **Arbiter.** Not equivalent: with a cross-location subject the original yields
> `subject_resolves = false` (`linkKind` null) and the mutant yields `true` — a
> `See the review` link into another location's review. Not unexecuted: the
> correlated `EXISTS` is evaluated for every returned row; only the discriminating
> **data** is missing.

**Fix:** seed a `held_draft` Refusal on location A whose `subject_id` is a response
owned by sibling location B; assert `linkKind` is `null`.

---

### P1 — needs adjudication (high-risk run: each must be fixed or authorized)

#### F5 — RestraintContent's success path is rendered by no test
`src/components/dashboard/restraint/RestraintContent.tsx:62` · duty 1 · **open**

All six cases return at `if (panel) return panel` — one reads the source as text,
the other five stub a pending or failing fetch. Inverting the `scope` ternary
changes nothing because the JSX is never constructed. That prop decides between
*"This is your whole account…"* and *"This is one location…"* — the D3 disclosure
`CONTEXT.md` requires — and `RestraintReport.tsx:23-28` deliberately refuses to
derive it on the grounds that passing it is safer. Nothing proves it is passed
correctly.

**Fix:** one case with a resolving fetch that asserts the report renders, plus one
with a non-`'all'` scope asserting the location sentence.

#### F6 — the null-`coverageStart` branch is rendered by no test
`src/components/dashboard/restraint/RestraintReport.tsx:121` · duty 1 · **open**

No fixture sets `coverageStart: null`, so replacing `return null` with a rendered
sentence stays green across all 17 cases. `businesses.created_at` really is
nullable — confirmed by introspecting the live test database, not only by reading
migration 001 — and `CONTEXT.md`'s Coverage-start bullet, `read.ts:372-375` and
`coverageLine`'s own comment all state the tab must **omit** the line rather than
name a date it does not have. The read's matching behaviour (a null coverage start
also leaves `windowStart` unclamped) is equally unasserted.

**Fix:** a `{ coverageStart: null }` override asserting no *"We have been watching
since"* text, and a live-DB case with `businesses.created_at = NULL`.

#### F7 — the ADR 0023 redaction assertion is an absence-of-substring proxy
`src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:245` · duty 2 · **open**

`expect(container.textContent).not.toMatch(/reason|draft|moderat/i)` stands in for
*"shows no draft text, review text or moderation reason"*. It **cannot** catch a
real leak — the DTO carries no prose field, so there is nothing for the component
to render — while it **can** redden on an innocuous copy change: any future
category sentence or link label containing "draft" or "reason" fails it. That is
the absence-of-tag proxy shape this repo has already been bitten by: passes while
the bug exists, fails on the fix.

**Behavioural replacement:** assert a positive closure — the row's rendered text
set is exactly the formatted date plus the optional link label — so any added
field fails the test whatever it is spelled.

#### F8 — the routed Restraint page has no covering test in any project
`src/app/(authenticated)/dashboard/analytics/restraint/page.tsx:13` · duty 1 · **open**

Direction B: a new production file with no Vitest importer and no e2e spec.
Nothing proves the route exists, mounts `RestraintContent`, or pulls in
`restraint.css` — while `AnalyticsTabs` now links to it from three surfaces
(`AnalyticsContent`'s state panel, `AnalyticsAggregateView`,
`AnalyticsPerLocationView`) and would 404 if the page were lost. It is the
thinnest possible hunk, so **accept-risk is a defensible adjudication** — but the
rule records an uncovered production hunk as P1 and this is one.

---

### P2 — recorded, non-blocking

#### F9 — three singular owner-facing count phrases are rendered and asserted by nothing
`src/components/dashboard/restraint/RestraintReport.tsx:285` · duty 2 · **open**

Mutating `'thing'`→`'things'`, `'time'`→`'times'` and `'1 archived location'`→
`'1 archived locations'` together leaves all 17 cases green, so *"1 things we chose
not to do"* and *"1 times"* would ship. Two of the three arms are **executed** by
the single-entry link fixtures — rendered, simply not asserted. On a surface whose
own header says "THIS COMPONENT OWNS EVERY OWNER-FACING SENTENCE" and whose
comment calls the words the contract, the plural forms are pinned and the singular
forms are not.

#### F10 — `docs/directory.md`'s new `read.ts` row overstates trap (d)
`docs/directory.md:892` · duty 3 · **open**

The row says *"link authority is the server-resolved `linkKind`, **never** the
Refusal category"*. `read.ts:123-124` keys `auto-approval` on
`category === 'autonomy_paused'` and `contacts` on `category === 'no_permission'`;
only the **review** link is lane-keyed. `read.ts:113-115` states the distinction
correctly. The row's trailing clause carries the real reason, so a reader who
finishes the sentence is not misled — which is why this is recorded rather than
raised as a false claim. Narrow it to *"the REVIEW link is never keyed on the
Refusal category"*.

**Every other citation in the change resolves and says what is claimed:**
`flags.ts:3` (the `autoApprovalRuntimeEnabled` export) · `vocabulary.ts:30-33`
(the quoted presentation boundary) · `DashboardStatePanel.tsx:61` **at the fork**
(the `&& state.hasData` gate, exact) · `console.css`'s `section-enter-6` ceiling
(the `enterStagger` clamp) · `docs/design/console/DESIGN.md` § Tabs (line 530) ·
migration 116's `-- C1` (:97) and `-- C3` (:125) · `ReviewsTabs` ·
`CardViewTabs.tsx:15` ("Route-level switches are NOT this component") ·
`BatchReport.tsx:218` (the module-scope-formatter rule) · `VAL-LOC-044`
(13 hits across 8 files) · `getAgentTeamSummary` (`src/lib/agents/read.ts`).
Both nullability claims were verified by **introspecting the live schema**, not
by reading the migration: `businesses.created_at` `is_nullable = YES`,
`accounts.created_at` `NO`.

`prevalidate-plan.py` was run on all three changed plan documents: the plan
(9 citations) and the deviations log (7) PASS; the handoff reports two "stale
commits", both false positives — `01a05eee-b142-7410-a022-6e3dca104ea7` is a
Codex **session UUID** on lines 139 and 150, and the script matched two of its
hex segments as short SHAs.

#### F11 — `restraint.css` ships three rule sets for elements no component renders
`src/app/(authenticated)/dashboard/analytics/restraint/restraint.css:112` · duty 4 · **open**

`.rst-group-link` (:112, :120, and a `prefers-reduced-motion` rule at :179),
`.rst-row-ago` (:157) and `.rst-error-body` (:184) match nothing — a repo-wide
grep over `.ts`/`.tsx` finds no emitter. `.rst-error-body` in particular is the
fingerprint of a local error card the ticket deliberately replaced with the shared
state panel, so this is an incomplete cleanup rather than forward-looking CSS.

#### F12 — five new production files were added with no `docs/directory.md` row
`docs/directory.md:454` · duty 3 · **open**

`ci:directory-map` **passes** (586 files under `worker/` + `src/lib/`), and
`src/lib/refusals/read.ts` correctly got its row. But the map also maintains
per-file rows for `src/components/` — including `dashboard/AgentTeamStrip.tsx`,
this ticket's own cited precedent — and for route-colocated app files, including
`dashboard/requests/requests.css`. `RestraintContent.tsx`, `RestraintReport.tsx`,
`AnalyticsTabs.tsx`, the restraint `page.tsx` and `restraint.css` have none. The
CLAUDE.md rule scopes the requirement to the two enforced roots, so this does not
block — but the code map other agents read is now incomplete for this feature.

---

## Duty 4 — sibling searches, including the ones that found nothing

| Pattern searched | Scope | Exclusions | Result |
|---|---|---|---|
| An error display gated on a data-present flag (the D5 `showError` defect) | `grep -rn 'error && (data\|hasData)\|hasData &&\|&& data)' --include=*.tsx src/components/dashboard/` | `__tests__` | **Zero siblings.** The only hit is `DashboardStatePanel.tsx:74`'s early return, which is a different predicate. `DashboardContent.tsx:76-84` renders its own error card on a bare `if (offboardingError)` with no data gate; `ReviewsContent.tsx:31` and `AnalyticsContent.tsx:42` both route through the fixed panel. |
| Other callers of `renderDashboardStatePanel` that might need `beforeContent` | `grep -rn 'renderDashboardStatePanel' --include=*.tsx src/` | none | Three callers (analytics, reviews, restraint). Reviews has no tab bar to preserve; the other two pass theirs. `DashboardSkeleton.tsx:10` and `DashboardContent.tsx:108` both carry comments explaining why they stay out. No missed caller. |
| Any second reader of `refusal_events` that could key a link on the category | `grep` for `refusal_events` outside `src/lib/refusals/` | migrations, tests | **Zero.** `read.ts` is the ledger's only reader (`write.ts` its only writer), so F1's defect class has exactly one site. |
| `rst-*` classes emitted but unstyled | scripted diff of `className` tokens vs `.rst-` selectors | none | Zero unstyled (`.rst-summary`/`.rst-group` intentionally compose with `.card`); three styled-but-unemitted → F11. |

## Duty 5 — operational completeness

**No finding.** The diff's only operator-visible failure path is the route's error
arm, which reaches `reportCaughtError('api/dashboard/refusals', …)` →
`policy.ts:77` → Sentry, carrying `{ accountId }` and nothing else (pinned by the
third redaction case). It emits **no new tag or `subsystem`**, so none of
`docs/runbooks/beta-launch-alerting.md`'s six rules (all keyed on
`subsystem`/`cost_event`/`feature`/`finding` from worker code) can or should match
it, and there is no orphan rule row on the other side. The sibling precedent,
`agent-team/route.ts` (WS5), likewise has no rule row — the alerting model does not
page on dashboard-read 500s, by design. `RestraintContent`'s
`await response.json().catch(() => ({}))` is a client-side swallow that degrades
to the fixed owner-facing message; it is not operator-actionable and matches the
existing dashboard fetch idiom.

## Operational completeness of the surface itself

| Condition | Behaviour | Proven? |
|---|---|---|
| Empty account | `total: 0` → the window-scoped empty sentence | yes (live-DB + component) |
| Cold cache | n/a — `useQuery` with no persisted cache; the panel's pending branch renders | yes |
| Null coverage start | line omitted **and** `windowStart` left unclamped | **no** — F6 |
| 90d window on a 2-day-old account | `windowStart` clamps up to `accounts.created_at` | the 30d equivalent is proven; the code path is identical |
| Location view of an archived location | zero rows, enforced by the read itself, not only by the route | yes (M15 killed) |
| Account-wide suspension across scopes | once per location view, once in the account total | yes (M2 killed) |

---

## Inventory

79 rows in `findings.json`: 13 killed, 4 confirmed survivors, 4 inconclusive
(all class `oracle`), 1 excluded, 57 `skipped-budget`. Every changed test case
appears, executed or not, plus two Direction-B rows for production hunks with no
covering candidate.

## Authorizations

None. No finding on this run is `accepted-risk`.

## What round 2 should verify

F1–F4 each need one added test case; F5–F7 need one each. Round 2 re-runs those
seven mutations and may report new findings inside the fix hunks and their direct
callers — nothing else.
