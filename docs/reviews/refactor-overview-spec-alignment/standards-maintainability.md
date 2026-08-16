# Standards & maintainability review — `refactor/overview-spec-alignment`

- **Branch**: `refactor/overview-spec-alignment` (8 commits) vs `origin/main`
- **Diff**: `git diff origin/main...HEAD` — 22 non-docs files, production **+578 / −557 (net +21)**, tests net **+647**
- **Axis**: repo standards, deep-module discipline, Fowler smells, glossary, comment quality, test quality
- **Method**: `/thermo-nuclear-code-quality-review` applied to the full diff, plus the six repo-specific checks the generic skill does not know about
- **Out of scope by instruction**: spec conformance / correctness (sibling agent), Overview reading every business row (§5.1 recorded limitation), `OVERVIEW_AT_RISK_LIMIT` placement (owner-confirmed), the pre-existing repo-wide React Doctor backlog
- **Adjudicated already**: the ten ACCEPT verdicts in `docs/superpowers/plans/refactor-overview-spec-alignment-deviations.md`. I agree with all ten and do not re-report them.

---

## Findings (≥80% confidence)

| # | Severity | Location | Finding |
|---|---|---|---|
| F1 | High | `src/lib/admin/__tests__/pool-fanout-sequential.test.ts:116-124` | The branch's headline #773 guard never dispatches the metrics query, so it cannot catch the regression its own comment claims it pins |
| F2 | Medium | `src/lib/admin/overview-service.ts:71-72, 185` | `OverviewData.responseMetricsWindowDays` is dead payload — §5.3 deleted its only consumer and the field (and a test pinning it) survived |
| F3 | Medium | `src/lib/admin/__tests__/overview-service.test.ts:523-562` | Verified: the windowing SQL contract is owned by the wrong suite (orchestrator Finding A) — reading confirmed, no siblings, gap is real |
| F4 | Low | `src/lib/admin/overview-service.ts:82` | Stale comment: "as `buildBusinessSummary` above" — this branch moved `buildBusinessSummary` out of the file |
| F5 | Low | `src/lib/admin/overview-service.ts:136,142` vs `:160` | Branch-created inconsistency: one sequential await gets the `react-doctor-disable` idiom, its two identical siblings 20 lines above get nothing |
| F6 | Low | `src/app/admin/businesses/BusinessesClient.tsx:32-42` | `formatRelative` relocated into a page client instead of `src/components/admin/ui/format.ts`, the module that declares itself the admin console's single formatter |

---

### F1 — High — the #773 sequential guard for `getBusinessSummaries` does not exercise the query it was added for

`src/lib/admin/__tests__/pool-fanout-sequential.test.ts:116-124`

```ts
it('getBusinessSummaries runs its paginated bundle one query at a time', async () => {
  // RED until T2 lands the queries (the stub throws), then green with no edit
  // to this body: rows → COUNT → metrics, sequential, peak 1.
  const { sql, getMaxConcurrency } = makeConcurrencyTrackingSql();
  await getBusinessSummaries(sql, { limit: 20, offset: 0 });
  expect(getMaxConcurrency()).toBe(1);
});
```

`makeConcurrencyTrackingSql(rows: unknown[] = [])` (same file, :56) defaults to an
empty queue, so every query resolves to `[]`. That means `businessRows` is empty →
`businessIds` is empty → `business-summary.ts:221` skips the metrics CTE entirely.
The test therefore measures peak concurrency across **two** queries (rows, COUNT),
not the three its comment names.

Why this matters more than a wording slip:

- The metrics CTE is the query **this branch newly introduced** to the paginated
  path, and the one the module's own header comment (`business-summary.ts:26-29`)
  advertises as guarded: *"rows query → (paginated only) COUNT → metrics, at most
  one query in flight … Guarded by `__tests__/pool-fanout-sequential.test.ts`."*
  It is not guarded.
- It is the most plausible future regression. A developer optimising this module
  would reach for `Promise.all([countQuery, metricsQuery])` — and with zero rows
  the metrics branch collapses to `Promise.resolve([])`, so peak stays 1 and the
  test **still passes**. The assertion cannot invert.
- The repo has this exact failure mode written into `CLAUDE.md`: *"an
  existing-but-not-run suite is how #520 shipped."* This is the same class one
  level down — an existing suite whose assertion does not reach the code.
- The sibling `getAdminOverview` case (:83-94) documents the same gap **honestly**
  ("The tracking sql yields no rows, so that module's conditional metrics CTE is
  skipped"). The new test asserts the opposite. Of the two comments, the false one
  is on the new test.
- `src/lib/admin/__tests__/admin-read-single-inflight.test.ts:55-60` — the other
  place this module's in-flight property is checked — is also honest about it
  ("The held first query releases zero rows, so the metrics follow-up is skipped").
  So **no test in the repo dispatches all three queries in sequence.**

Fix is one line — seed the FIFO queue so the base query returns a row:

```ts
const { sql, getMaxConcurrency } = makeConcurrencyTrackingSql([
  [{ id: 'b1000000-0000-4000-8000-000000000001' }],
  [{ total: 1 }],
]);
```

…and either keep the comment or make it match what runs. Given the module exists
almost entirely to hold a sequencing invariant, the guard should exercise the full
sequence.

---

### F2 — Medium — `OverviewData.responseMetricsWindowDays` is dead payload

`src/lib/admin/overview-service.ts:71-72` (declaration), `:161` (destructure),
`:185` (return)

```ts
/** Trailing window (days) that responseRate + avgResponseTimeHours cover. */
responseMetricsWindowDays: number;
```

Nothing reads it. `OverviewClient.tsx:15` destructures `{ systemHealth, atRisk }`
and otherwise touches only `data.totalBusinesses`. A repo-wide grep for
`responseMetricsWindowDays` outside tests returns three declaration/plumbing sites
in `overview-service.ts`, three in `business-summary.ts`, and exactly one real
consumer — `BusinessesClient.tsx:165`, on the *other* page.

On `main` the field had a consumer: Overview rendered `Response rate (30d)` and
`Avg time (30d)` columns whose headers derived from it (`origin/main`'s
`OverviewClient.tsx` `buildColumns(windowDays)`). §5.4 moved both columns to
`/admin/businesses`; the field stayed behind.

This is not inherited debt the branch merely failed to notice — the branch
**reshaped this exact interface** in the same commit, deleting `limit` and
`offset` and renaming `businesses` → `atRisk`. Three of the five fields on
`OverviewData` were audited; the fourth was not.

Concrete cost:

- Its own JSDoc is now false in context: it advertises the window covering
  `responseRate + avgResponseTimeHours`, neither of which Overview renders. The
  next person adding a window-labelled element to Overview will trust a number no
  page validates.
- It is the only reason `getAdminOverview` destructures three fields from
  `getBusinessSummaries` instead of two (`:161`).
- It keeps a test alive against a contract with no consumer
  (`overview-service.test.ts:554-562`) — see F3, which is the same two tests.

Standard: Fowler *speculative generality* / dead code. Removing it deletes a DTO
field, a destructure, a return key and half a test with zero behaviour change.
(Note the `atRisk` payload also carries the full `BusinessSummary` DTO of which
the client reads three fields — but that is locked decision 8, "no second
narrower DTO invented for a single caller", and I am not re-litigating it.)

---

### F3 — Medium — orchestrator Finding A verified: the windowing SQL contract is pinned in the wrong suite

`src/lib/admin/__tests__/overview-service.test.ts:523-562`

The orchestrator raised this as seeded focus context rather than patching it, and
asked reviewers to verify the reading and check for siblings. Both done:

**Reading — correct.** `getAdminOverview` issues five queries of its own
(`overview-service.ts:133-153`), so `harness.sqlCalls[5]` is the sixth — the base
query inside `business-summary.ts:189`, reached transitively. Both tests in that
`describe` assert against it (`:531` binds it to a local named `businessQuery`;
`:561` indexes it directly).

**Siblings — none.** `sqlCalls[` appears exactly twice in the whole file, at
:531 and :561. No other test in `overview-service.test.ts` reaches across the
module boundary.

**Gap — real.** `business-summary.test.ts:252-257` pins the base query's
`FROM businesses b`, the `JOIN accounts`, the `LEFT JOIN responses`, the two
status literals and `ORDER BY b.name ASC` — but **not** the trailing-window
`FILTER (… created_at >= CURRENT_DATE - ?::int)`, nor `AS total_responses`,
`AS completed_responses`, `AS avg_response_time_hours`, nor the "must stay
all-time" assertions on `pending_approval_count` / `pending_reconnect_count` /
`last_activity`. Those exist in exactly one place and it is the Overview suite.

So editing `business-summary.ts`'s windowing breaks a test named
`getAdminOverview — response-metric windowing`. That inverted ownership is
precisely the discipline this PR exists to establish, which makes it worth
fixing in the PR rather than after it. The describe block should move to
`business-summary.test.ts` and index `sqlCalls[0]`.

Nuance the orchestrator already got right, and I confirm: the first assertion of
`surfaces responseMetricsWindowDays…` (`:558`) is genuinely `getAdminOverview`'s
payload contract and belongs where it is — though if F2 is acted on, it should be
deleted rather than moved. Only its second assertion (`:561`) reaches across.

---

### F4 — Low — stale comment: the referent moved, the pointer stayed

`src/lib/admin/overview-service.ts:82-84`

```
// Same estimated-coverage CRAP artifact as buildBusinessSummary above — this
// is a flat, already-minimal defaulting + boolean derivation pinned by the
// 6 redState characterization tests in overview-service.test.ts.
```

`buildBusinessSummary` is not above. It is not in this file at all — this branch
moved it to `business-summary.ts:108`. The comment is byte-identical to `main`
(verified against `origin/main:src/lib/admin/overview-service.ts:163-165`), where
it was true. The branch moved its referent and left the pointer.

The load-bearing part (why `deriveEmailHealth` carries a `fallow-ignore`) still
holds; only the cross-reference dangles. A reader following it finds nothing and
has to guess whether the rationale still applies.

Same class, milder, in the relocated comment itself —
`business-summary.ts:101-106` ends *"(the overview characterization tests exercise
every branch)"*, but this branch moved those tests into
`business-summary.test.ts:286-458`. Both are one-word fixes ("in
`business-summary.ts`" / "the characterization tests below").

For the record: the `// fallow-ignore-next-line complexity` marker itself
relocated correctly and is still accurate — see the repo-specific checks below.

---

### F5 — Low — one sequential await is suppressed, its two identical siblings are not

`src/lib/admin/overview-service.ts:160` carries the house idiom with a real,
specific reason (pool size 3, pipelining, permanent wedge). Good — that is exactly
the form check 2 asks for, and the same reason string is used correctly at
`business-summary.ts:211`.

But awaits 2 and 3 of the *same function* — `failedJobsRows` (:136) and
`todayCostRows` (:142) — are the same rule, the same justification, twenty lines
above, and carry nothing. The branch's own deviations log confirms they still fire:
*"This branch's only doctor finding is the warning 'Sequential independent awaits'
at `overview-service.ts:136,142`."*

The warnings are pre-existing; the **inconsistency is branch-created**. Before this
branch the file had zero suppressions and N warnings — internally consistent, if
noisy. Now a reader sees await #6 explicitly defended and awaits #2/#3 silent, and
the natural inference is that #2/#3's sequencing is accidental and safe to
parallelise. It is not: they share the same three-connection pool and the same
`sql` singleton. Either extend the suppression to the block, or add one file-level
comment the individual sites point at.

(The pre-existing repo-wide doctor backlog is out of scope and is not what this
says. This is about two lines inside the function the branch edited.)

---

### F6 — Low — `formatRelative` moved to a page client, not to the module that owns admin formatting

`src/app/admin/businesses/BusinessesClient.tsx:26-42`

The helper came over verbatim from `OverviewClient` with the metric columns. Its
new comment says:

```
// Absorbed from OverviewClient with the metric columns (spec §5.4) — the admin
// console has one spelling of a relative timestamp, and unlike `formatAdminDate`
// it is deliberately zone-free (a relative age needs no zone label).
```

The comment names `formatAdminDate`, so the author knew about
`src/components/admin/ui/format.ts` — but it answers *why the behaviour differs*,
not *why the code lives here*. That module's header declares itself **"The admin
console's single date/number formatter (CF-1)"** and carries a caller CONTRACT
enforced by a source scan in `__tests__/format.test.ts`. It is the canonical home
for exactly this.

The claim "the admin console has one spelling of a relative timestamp" is true
today, but it is true by luck rather than by structure — and this helper has
*already* been copied out of one page into another once, in this very diff. The
next admin surface wanting "last activity" copies it a third time, which is the
drift CF-1 exists to prevent. Moving it to `format.ts` as `formatAdminRelative`
costs one export and makes the single-owner claim structural.

(No contract violation — `formatRelative` calls no `toLocale*` API, so the scanned
rule does not fire. This is a layer/ownership point, not a lint failure.)

---

## Repo-specific checks — results

| # | Check | Result |
|---|---|---|
| 1 | `fallow-ignore-next-line complexity` on `buildBusinessSummary` relocated intact | **PASS (with F4 caveat)** |
| 2 | `react-doctor-disable-next-line …/server-sequential-independent-await` reasons are real, not vague | **PASS (with F5)** |
| 3 | `src/lib/**` does not import `@/app/**` (`APP_LEAF_IMPORT_BAN`) | **PASS** |
| 4 | `page-sizes.ts` outage explanation not weakened | **PASS** |
| 5 | `HealthBadge` is a genuine `StatusBadge` peer; `ChurnScore['level']` typing | **PASS — an improvement, not an over-tightening** |
| 6 | Glossary: **At-risk list** / **Business summary** used consistently | **PASS** |

**1 — fallow marker.** Present at `business-summary.ts:107`, immediately above
`function buildBusinessSummary` at `:108`, with the full six-line rationale at
`:101-106` carried over. Placement is correct for the directive (immediately
preceding line). The rationale's substance — cyclomatic 24, dominated by
null-coalescing in object construction rather than control flow, so decomposition
would not reduce it — is still accurate against the function as it stands. Its
closing parenthetical names the wrong suite now; folded into F4. `ci:fallow:coverage`
is not at risk. The second marker, on `deriveEmailHealth`
(`overview-service.ts:85`), also sits correctly.

**2 — React Doctor suppressions.** Two added, both new:
`business-summary.ts:211` (the conditional COUNT) and `overview-service.ts:160`
(the `getBusinessSummaries` call). Both carry the same concrete reason naming the
mechanism, the pool size and the failure mode — the opposite of a vague
suppression, and matching the house idiom at
`src/app/admin/businesses/[id]/page.tsx:32`. Sites that legitimately do *not*
need one: the metrics await (`business-summary.ts:221`) sits inside a ternary and
does not trip the rule. The gap is F5.

**3 — leaf-import ban.** `business-summary.ts` imports `postgres` (type-only),
`@/lib/shared/churn-score` and `@/lib/shared/response-status`. `overview-service.ts`
imports `postgres` (type-only) and `./business-summary`. No `@/app/**` anywhere in
`src/lib/**` on this branch. `npx eslint` over all six changed source files is
clean. The `OVERVIEW_AT_RISK_LIMIT` placement is the correct resolution of this
ban, and the pointer comment left in `page-sizes.ts` is the right residue.

**4 — `page-sizes.ts`.** The 25-line `WHY THIS FILE EXISTS` header — the
client-reference-stub mechanism, the verbatim `SQLSTATE 22P02` error text, the
"went live on staging 2026-08-10 and took out seven admin pages" record, and the
directional rule — is **byte-identical to `main`**. The only edit replaces the
`OVERVIEW_PAGE_SIZE` export with a five-line pointer explaining where the cap went
and why. Not weakened; arguably improved, since the file now explains an absence
that would otherwise read as an oversight.

**5 — `HealthBadge`.** A genuine peer of `StatusBadge`: same directory, same
shape (module-level `Record` map + labels + a small presentational component),
same pill markup. `font-medium` vs `StatusBadge`'s `font-semibold` is a
pre-existing divergence carried over verbatim from `main`'s inline version — not
introduced here.

The typing is an **improvement, not an over-tightening**. `main`'s inline version
was:

```tsx
const HEALTH_BADGE_STYLES: Record<string, string> = { … };
HEALTH_BADGE_STYLES[level] ?? HEALTH_BADGE_STYLES.healthy
HEALTH_BADGE_LABELS[level] ?? level
```

An unknown level rendered as a **green "healthy" pill** — the worst possible
failure mode for a risk badge, silently downgrading an unrecognised risk state to
"fine". Keying on `ChurnScore['level']` deletes both fallbacks and converts adding
a level in `src/lib/shared/churn-score.ts` into a compile error at the one place
that must be updated. `score` stays `number`, which is right — it is a computed
value, not an enum. `HealthBadge.test.tsx:35-54` pins the badge against the real
`computeChurnRiskScore` + `LEVEL_THRESHOLDS` so the badge cannot grow its own
thresholds. No over-tightening: nothing legitimate is now unrepresentable.

**6 — glossary.** Both terms coined in this branch's `CONTEXT.md` edit are used
consistently. **At-risk list**: `OverviewData.atRisk`, the `atRisk` local, the
`— at-risk selection (filter → sort → cap)` describe, the UI heading `At risk
(N of M)`, and the comments in `overview-service.ts:9,14` and
`OverviewClient.tsx:84`. No stray "top 5", "risk list", "watchlist" or "churn
table" anywhere in the diff. **Business summary**: `BusinessSummary`,
`BusinessSummariesResult`, `getBusinessSummaries`, `buildBusinessSummary`,
`business-summary.ts`, `business-summary.test.ts`. The `_Avoid_` list is honoured —
`businessRow` survives only as the DB-row fixture/interface name, which is the
glossary's own stated meaning for it. `docs/directory.md` and `CONTEXT.md` both
updated in the same change, and the deleted `businesses-list-service.ts` is
cross-referenced out of `docs/directory.md`.

---

## Deep-module assessment

**Is `business-summary.ts` genuinely deep, or did it just move code?** Genuinely
deep. One exported function with a two-parameter signature (`sql`, optional page)
returning a three-field result, behind which sit: a 16-line grouped base query, a
conditional COUNT, a 45-line churn-signal CTE, id-keying, a `Map` join and a
24-branch DTO mapper including the churn model call. Interface-to-implementation
ratio is strongly in the right direction, and it *replaced* two shallow modules
that each spelled the same `businesses × accounts × responses` join. This is the
good case: net +21 production lines that delete a duplicated query.

**Is `opts?: { limit, offset }` the right seam, or does the split leak?** It does
not leak. `total` is computed two ways (`COUNT(*)` when paginated,
`businesses.length` when not) but the two are the *same number by construction* —
an unpaginated read holds every row, so its length **is** the unfiltered total.
Callers never branch on which path produced it: `overview-service.ts:184` and
`BusinessesClient.tsx:172` both just consume `total`. The alternative — two
exported functions — would re-duplicate the base query, which is the thing being
removed. Locked decision 2 is the right call and I would have made it too.

**Did `overview-service.ts` actually get shallower?** Yes, and without becoming a
pass-through: 286 → 189 lines, minus two queries, minus the CTE, minus
`buildBusinessSummary`. What remains is five queries it owns, `deriveEmailHealth`,
and the at-risk ranking — real work with a real interface.

**Fowler baseline.** No long function (largest is `getBusinessSummaries` at ~120
lines, of which ~80 are SQL literals). No shotgun surgery — the change consolidates
rather than scatters. No primitive obsession beyond `subscriptionStatus: string`,
which is the **consistent repo-wide convention** across every admin DTO
(`business-detail-types.ts`, `margin-service.ts`, `offboardings-service.ts`,
`BusinessDetailClient.tsx`) and therefore not this branch's finding. One mild
feature-envy candidate is in the appendix. No speculative generality except F2.

**Standards sweep.** No `any`. No silent catches. No new string literals for
subscription status / tier / job name / review status — `HANDLED_STATUSES` is
imported and the three inline SQL status literals (`'pending_approval'`,
`'awaiting_owner_connect'`, `'superseded'`) moved verbatim from `main` and fall
under `response-status.ts`'s own stated carve-out for narrow inline lists.
Invariant #12: both routes stay orchestration-only, and
`/api/admin/overview/route.ts` got *thinner* (clamping deleted). Invariant #15:
`business-summary.ts` is born-injected, takes `sql`, never imports
`@/lib/db/server`; the four composition roots supply the singleton. Invariant #1:
no new runtime `postgres`/LLM/BullMQ import under `src/app/**` or
`src/components/**` — `HealthBadge` imports `ChurnScore` type-only. Invariant #13:
no new `NEXT_PUBLIC_*`. "No new file": three files added
(`business-summary.ts`, `HealthBadge.tsx`, and their tests), one deleted
(`businesses-list-service.ts` + its test) — each justified, each registered in
`docs/directory.md`. `scripts/ci/tenant-scope-allowlist.ts` correctly re-keyed to
the new file with the baseline dropped 403 → 396 and the reasoning recorded inline.

**No code-judo move left on the table** that I can defend at ≥80%. The obvious
candidate — pushing the churn ranking into SQL so Overview stops reading every row
— is explicitly a non-goal with a recorded rejected alternative, and the CONTEXT.md
entry argues it correctly (`computeChurnRiskScore` is a weighted TS composite in
which account age alone gives every business a non-zero score, so no cheap SQL
predicate is a provable superset of "at risk").

---

## Test quality

Strong overall — these pin behaviour, not implementation, and would fail if the
behaviour inverted.

- `computeChurnRiskScore` is left **unmocked** in every relevant suite, as the
  intake required. `business-summary.test.ts:284` and
  `overview-service.test.ts:26` both say so, and the assertions prove it: real
  scores are pinned (`65`, `6`, `70/55/45/38`, `71/33`), not stubbed. The
  comparator assertions therefore exercise the production model.
- The ordering tests would genuinely invert. `orders the at-risk list by churn
  score descending` feeds rows **scrambled** so a pass-through of the DB's
  `ORDER BY b.name ASC` fails. `breaks a score-and-pending tie on business name
  ascending` feeds name-descending **and guards the guard** — it asserts the two
  rows have equal score *and* equal pending count, so an earlier comparator tier
  cannot silently be what decided it. `returns an empty at-risk list when every
  business is healthy` is the filter-then-cap ordering test and would fail loudly
  against a cap-then-filter implementation.
- `caps the at-risk list at OVERVIEW_AT_RISK_LIMIT` imports the real constant
  rather than hard-coding `5`, and separately asserts `totalBusinesses === 6` so
  "capped" cannot be confused with "filtered away".
- The bounded-fetch property — the one §5.4 exists for, and invisible in the
  returned DTO — is pinned the only way it can be, on the metrics query's bound
  values: `business-summary.test.ts:119-120` asserts `values[0]` equals exactly
  the two page ids *and* equals `result.businesses.map(b => b.id)`.
- `requests metrics for every row when called unpaginated` asserts the **absence**
  of the COUNT query, not just the value of `total` — so "drops one query" is a
  real assertion rather than a coincidence.
- `renders the metric columns absorbed from Overview` uses a `14`-day window
  fixture and asserts `Response rate (14d)` present **and** `(30d)` absent, which
  is how you prove a header derives from data rather than a literal.
- The `HealthBadge` suite pins the mapping itself rather than either page's markup,
  and its third case ties the badge to the real `LEVEL_THRESHOLDS` so it cannot
  grow private thresholds.

The two exceptions are F1 (a guard that cannot invert) and F3 (a real assertion
living in the wrong suite).

---

## Low-confidence appendix — not findings, recorded for the owner

These did not clear the ≥80% bar and are deliberately excluded from the table.

1. **Comparator placement / mild feature envy.** The at-risk sort
   (`overview-service.ts:167-173`) reaches into five `BusinessSummary` fields
   across two objects. A `compareByChurnRisk` exported from `business-summary.ts`
   beside the DTO would be tighter and testable in isolation. Against it:
   `CONTEXT.md` locks the At-risk list — including its ordering — as
   `overview-service.ts`'s concept, `OVERVIEW_AT_RISK_LIMIT` is owner-confirmed to
   live there, and moving the comparator without the cap would split one rule
   across two modules. Probably right as-is; noting only because it is the single
   place a reader must hold both modules in their head.

2. **`formatRelative` and hydration.** It calls `Date.now()` during render, so a
   row near a bucket boundary can render `59m ago` on the server and `1h ago` in
   the browser. `format.ts`'s header shows the repo takes admin hydration
   mismatches seriously. Pre-existing behaviour relocated verbatim, and the drift
   window is narrow — but if F6 is acted on, `format.ts` is where the fix would
   naturally land too.

3. **`HealthBadge.test.tsx:23.** `expect([...seen.keys()]).toEqual(['healthy',
   'watch', 'at_risk'])` restates the loop that just populated the map and cannot
   fail. Harmless; the line below it (three distinct class strings) is the real
   assertion.

4. **Badge weight divergence.** `HealthBadge` uses `text-xs font-medium`,
   `StatusBadge` `text-xs font-semibold`. Carried over verbatim from `main`, so
   not this branch's, but the two now sit side by side in the same table row on
   `/admin/businesses` where the difference is visible for the first time.

5. **`atRisk` payload width.** `/api/admin/overview` now ships the full
   `BusinessSummary` for up to five businesses while `OverviewClient` reads three
   fields. Locked decision 8 ("no second narrower DTO invented for a single
   caller") and I agree with it — five rows is nothing, and a second DTO is the
   duplication this PR removes. Recorded only so the reasoning is visible next
   time someone asks why.

---

## Verdict

The refactor is entropy-negative and structurally sound: two shallow modules
collapsed into one genuinely deep one, a duplicated join deleted, a silent
`?? 'healthy'` fallback replaced with a type error, and net +21 production lines.
The invariants that matter here (#1, #12, #13, #15, #773 sequencing,
`APP_LEAF_IMPORT_BAN`) are respected, the load-bearing incident comments survived
relocation, and the new tests mostly pin behaviour against the real churn model.

Nothing here is a structural regression or a merge blocker on my axis. **F1 is
worth fixing before merge** — it is one line, and it is the difference between the
module's headline guarantee being guarded and merely being claimed. F2 and F3 are
cheap cleanups in the same neighbourhood (F2 deletes half of F3's subject). F4–F6
are comment and placement hygiene.
