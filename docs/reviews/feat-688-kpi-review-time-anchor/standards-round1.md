# Standards & Maintainability Review — feat-688-kpi-review-time-anchor (round 1)

- **Branch / range**: `feat-688-kpi-review-time-anchor`, `git diff 8db5fe28..HEAD`
- **Method**: `thermo-nuclear-code-quality-review` skill applied with repo standards on top
  (CLAUDE.md working rules, deep-module discipline, CONTEXT.md glossary discipline,
  live-DB test conventions, ADR house format vs `docs/adr/0016-import-consent-enforcement-locus.md`).
- **Scope reviewed**: `src/lib/kpi/service.ts`, `src/lib/kpi/__tests__/service.test.ts`,
  `src/lib/kpi/__tests__/service.anchor.integration.test.ts`,
  `scripts/ci/tenant-scope-allowlist.ts`, `docs/adr/0019-kpi-review-time-anchor.md`, `CONTEXT.md`.
- **Context read, not re-litigated**: `docs/superpowers/plans/feat-688-kpi-review-time-anchor-deviations.md`
  (all nine entries adjudicated ACCEPT; nothing below re-opens an adjudicated deviation).
- **Verification run during review** (evidence, not fixes):
  - `pnpm vitest run src/lib/kpi/__tests__/service.test.ts` → 20/20 pass
  - `pnpm ci:tenant-scope` → passed, 408 entries (baseline 408 — re-pin is byte-exact, no allowlist growth)
  - `pnpm ci:live-db-suites` → passed (new integration suite is DML-only; no DDL findings)

## Verdict

**Approve with two low-severity findings.** No structural regression, no missed
code-judo move of consequence, no file-size or spaghetti concern. The change is a
textbook module deepening: both public signatures (`getLocationKpiSummary`,
`getAccountKpiSummary`) and the `DashboardKpiSummary` return type are unchanged,
and all new complexity lives behind two lazy fragments that follow the file's
established factory pattern. The two findings are test-fixture issues in the new
integration suite, not design issues.

---

## Findings (≥80% confidence)

### F1 — LOW: Calendar-boundary flake window between `beforeAll` seeding and assert-time expectations

`src/lib/kpi/__tests__/service.anchor.integration.test.ts:170-233` (fixtures) and
`:250-256`, `:258-280`, `:290-297`, `:299-313` (tests 1, 2, 4, 5).

The suite's comment block (`:21-22`) claims all time arithmetic happens in SQL —
true, and it correctly defends against JS-Date/DB-clock skew and the µs-truncation
gotcha. But the calendar-bucket fixtures are seeded from `NOW()` **in `beforeAll`**
while the queries under test (and the expected-week computations in tests 2 and 5)
evaluate `DATE_TRUNC('month'|'week', NOW())` **at assert time**. If a DB-local
Monday 00:00 (week flip) or 1st-of-month 00:00 (month flip) falls in the seconds
between seeding and assertion, the failures are deterministic:

- Test 1: `review_date = DATE_TRUNC('month', NOW_seed) − 10 days` becomes two
  months back after a month flip → falls out of the `prior_month` FILTER →
  `priorMonth` reads 0, not 1.
- Test 2: `importWeek` is recomputed from `NOW_assert`, so the expectation names a
  different Monday than the seeded row's bucket → `importPoint.reviewCount` reads 0.
- Test 4: the row detected at `NOW_seed` leaves `currentMonth` after a month flip.
- Test 5: the clamped row's bucket is the seed-time week; the expectation is the
  assert-time week.

The fixtures defended month-length (`≥ 28 days > 10`) and Monday alignment, but not
the seed-vs-assert straddle itself. Probability per run is tiny (the suite runs in
seconds), but a CI/full-suite run scheduled across midnight at a week or month turn
fails 2–4 tests with error messages that point at anchor *semantics* — an expensive
misdirection for whoever investigates.

**Concrete failure scenario** (the maintainability test this fails): a nightly
full-suite run on the 1st of a month at 00:00 DB-local goes red on
"volume MoM buckets an imported review into its review_date month" and the on-call
engineer spends an hour auditing `reviewTimeAnchor` before noticing the timestamp
of the run.

**Suggested remedy (review-only; not applied)**: derive expectations at assert time
from the *stored* rows rather than recomputing the seed's arithmetic — e.g. one SQL
round-trip per calendar test comparing the seeded row's anchor against the same
`DATE_TRUNC` boundaries the query under test uses (`SELECT LEAST(review_date,
detected_at) >= DATE_TRUNC('month', NOW()) …` on the fixture row), and asserting
the summary against that derived bucket. That makes the expectation and the query
share one `NOW()` epoch. Alternatively (cheaper, partial): seed calendar-test
rows at safely-interior offsets *and* re-assert the seed's bucket membership at
assert time, skipping-with-reason on straddle. Either preserves the suite's
"all arithmetic in SQL" rule.

### F2 — LOW: `approval_method` seeded as a raw `'owner'` literal although `APPROVAL_METHOD.OWNER` exists

`src/lib/kpi/__tests__/service.anchor.integration.test.ts:132` (`seedPostedResponse`).

The fixture INSERTs `approval_method` as the free-floating literal `'owner'`.
`src/lib/auto-approval/types.ts:18-30` exports the authoritative vocabulary
(`APPROVAL_METHOD.OWNER` / `.AUTO_POLICY` + the `ApprovalMethod` type), and the
sibling live-DB suite
`worker/jobs/response-generation/__tests__/auto-approval-daily-cap.integration.test.ts:138,337`
imports it for exactly this column. The repo's working rule ("No string literals
for subscription status, tier IDs, job names, or review status — import the
constant from its single authoritative TS file") does not literally enumerate
`approval_method`, but invariant #3 makes it a security-relevant status vocabulary
and the codebase already treats it as constant-owned. Notably this suite *did* go
to `satisfies`-lengths for the `'posted'` response status (deviations entry 2,
adjudicated — where no per-value constant exists), which makes the untethered
`'owner'` two lines below it an inconsistency rather than a style choice: if the
`APPROVAL_METHOD` values ever change spelling, this fixture drifts silently while
the `satisfies`-anchored one fails typecheck.

**Suggested remedy**: `import { APPROVAL_METHOD } from '@/lib/auto-approval/types'`
and bind `${APPROVAL_METHOD.OWNER}`. One-line change, no behavior difference.

---

## Axis-by-axis assessment

### Deep-module discipline — PASS (this is what deepening looks like)

- **Interface unchanged**: both exported function signatures and
  `DashboardKpiSummary` are byte-identical to the fork point; `src/lib/kpi/types.ts`
  is untouched. The implementation got richer (anchor semantics, TTR validity
  filter) behind the same contract. No interface widening anywhere.
- **No FROM/JOIN/SELECT leaks into factories**: `reviewTimeAnchor` emits only
  `LEAST(review_date, detected_at)`; `reviewTimeWindowFilter` composes the anchor
  plus a comparison. Both respect the constraint documented at
  `src/lib/kpi/service.ts:99-115` — every tenant-scope `FROM`/`JOIN`/predicate
  stays literal in the caller's template, which `pnpm ci:tenant-scope` (run green,
  408/408) confirms end-to-end.
- **Abstractions earn their keep**: `reviewTimeAnchor` has 12 call sites across
  both scopes; `reviewTimeWindowFilter` has 2 (both star queries) and exists to
  mirror the pre-existing `detectedAtWindowFilter` shape — symmetric, not
  speculative. The prefix-branching (`'' | 'r.'`) duplicates the established
  `notDeletedFilter`/`detectedAtWindowFilter` house pattern; a generic
  column-prefix builder would be the kind of "magic" the thermo-nuclear standard
  warns against, and postgres.js identifier interpolation would fight the
  raw-text tenant-scope scanner. The boring repeat is correct here.
- **Code judo check**: the obvious "dramatic" alternative — a generated column or
  SQL view owning `LEAST(review_date, detected_at)` so the fragment disappears and
  the expression becomes indexable — is a migration, and ADR 0019 §Alternatives
  explicitly rejects schema cost for a single consumer (same reasoning as the
  rejected provenance column). With one consumer and per-tenant row counts, the
  fragment is the minimal-footprint framing. No missed simplification. (See
  appendix A5 for the revisit trigger.)
- **File size**: `service.ts` is 404 lines (+30 net). No 1k concern.
- **Spaghetti check**: zero new conditionals in shared flows; the one semantic
  branch in the system ("reputation KPIs anchor, workflow KPIs don't") is expressed
  as *which named fragment a query composes*, not as an `if` — exactly the
  preferred remedy shape.

### Glossary discipline — PASS

- `CONTEXT.md` coins **Review-time anchor** with the house glossary anatomy
  (definition, failure-mode rationale, single owner, _Avoid_ terms, coined-at
  attribution) and places it adjacent to the Review-import cluster.
- The code and both test suites use the coined term verbatim
  (`service.ts:135` doc comment, integration suite header `:8`, unit-suite
  describe block). The _Avoid_ terms ("review_date anchor", "import exclusion")
  appear nowhere in the diff outside the _Avoid_ clause itself (grep-verified).
- Function name `reviewTimeAnchor` matches the coined term; the CONTEXT.md entry
  names it as the single owner and the code agrees.

### Test quality — PASS with F1/F2

- **Mock assertions are meaningful, not tautological**: the new
  `review-time anchor (#688)` describe block runs the real service against the
  fragment-flattening `createMockSql` harness and asserts composed output — per
  query index, with a *negative* assertion (`not.toContain('LEAST(')`) pinning the
  deliberate detected_at carve-out on the rate query. They restate intent the
  byte-exact characterization pins already lock (see appendix A3), but they are
  labeled by decision rather than by byte-diff, which is what survives the next
  sanctioned pin re-derivation.
- **Characterization pins correctly re-derived**: the pin block's own comment
  records this as the second sanctioned re-derivation with the #688 rationale, per
  the block's contract ("re-derive from scratch, do not relax").
- **Integration suite conventions — verified**: named `*.integration.test.ts`
  (serialized `integration` project) ✓; gated by `describeWithDb` with the valid
  3-arg `{ timeout }` overload ✓; `assertSchemaReady` with the
  `MIGRATION_071_RUN_SPINE` floor and an explicit argument for why that floor is a
  valid head proxy (#688 ships no migration; every touched column predates 071) ✓;
  fixtures are DML-only — `pnpm ci:live-db-suites` run green ✓; ALL time
  arithmetic in SQL fragments, never JS Dates ✓; FK-ordered cleanup in `afterAll`
  covering rows seeded inside test bodies (review G is deleted by the
  per-business DELETE) ✓; the always-miss cache mock correctly prevents the 45s
  TTL cache from poisoning the tests-7/8 same-business re-reads ✓.
- **Flake defense**: strong on month-length, Monday alignment, decode-path
  round-tripping (deviations entry 1), and the future-clamp vanishing mode — but
  see **F1** for the one calendar hazard the fixtures did not defend against.
- **Test 7/8 declaration-order coupling** is unusual (the pin must run before the
  red probe seeds more data into the same business) but is documented twice at the
  point of coupling and was adjudicated in the deviations log; vitest declaration
  order within a file is stable, so this holds.

### tenant-scope allowlist — PASS

Mechanical re-pin of exactly the three trend-query `sqlSnippet` strings the anchor
rewrite invalidated; byte-verified by the audit run (408 entries, baseline 408, no
growth). `category` and `reason` fields untouched and still accurate about the
scope argument. Star/volume queries correctly remain un-allowlisted (their scope
predicate is directly visible to the scanner). See appendix A2 for a cosmetic
staleness inside the `reason` strings.

### ADR 0019 / CONTEXT.md accuracy — PASS

- **House format**: section-for-section match with ADR 0016 (`Status` with
  "Accepted — date (ticket)" and supersession note / `Context` / `Decision` /
  `Alternatives considered` with per-alternative For–Against / `Consequences`,
  including the 0016 signature move of stating the honest limits of its own
  claims — e.g. the "Stated precisely" TTR bounding at §Context item 4).
- **Code consistency, claim by claim**: `reviewTimeAnchor` single-owner ✓;
  identical treatment in both scopes ✓ (and pinned by the supplementary
  cross-scope integration test); `LEAST`-not-`COALESCE` rationale matches the code
  comment and is proven by integration tests 4/5 ✓; response rate stays on
  `detected_at` ✓ (test 6 pins it); MonthlyImpactWorker digest stays on
  `detected_at` ✓ (verified `worker/jobs/MonthlyImpactWorker.ts:140-202` —
  untouched by this branch); TTR validity filter is an exclusion composed into
  `ttrHandledWindowFilter`, not a clamp ✓; "no migration, no new index" ✓.
- **CONTEXT.md entry** is consistent with the ADR and the code, including the
  companion-filter sentence and the single-owner citation.

---

## Low-confidence appendix (speculative — below the 80% bar)

- **A1 — ADR index citation implies sargability the expression doesn't have.**
  ADR 0019 §Consequences cites `idx_reviews_business_review_date` (migration 031)
  in the "pure read-path change" bullet. That index is `(business_id,
  review_date DESC)`; the anchor expression `LEAST(review_date, detected_at)` in a
  WHERE/GROUP BY is not sargable against it — the plans are served by the
  `business_id` equality prefix, same as before. Harmless today (per-tenant row
  counts are small and every query leads with the tenant predicate), but a future
  reader could take the citation as "the anchor predicate is index-backed." A
  one-clause precision fix if the ADR is ever touched again. (~60%)
- **A2 — Allowlist `reason` strings now under-describe the stripped subquery.**
  The three re-pinned entries still say only "The notDeletedFilter fragment … sits
  entirely inside the stripped subquery"; the subquery now also contains three
  `reviewTimeAnchor` interpolations. The safety argument is unchanged (the anchor
  fragment hides no FROM/JOIN/scope), so this is cosmetic staleness, not a gap. (~50%)
- **A3 — The mock anchor describe block is subsumed by the byte-exact pins.**
  Everything `toContain`/`not.toContain` asserts is already locked byte-for-byte
  by the characterization constants in the same file. Defensible redundancy —
  the block documents *which decision* each fragment encodes and survives pin
  re-derivation — but it is a second thing to update on the next re-derivation. (~40%
  that this is a net negative.)
- **A4 — Four prose copies of the anchor rationale.** The LEAST/NULL/future-clamp
  rationale now lives in `service.ts:134-144`, CONTEXT.md, ADR 0019, and the
  integration suite header. Each is arguably load-bearing at its site (the code
  comment states the correctness-critical LEAST semantics; the glossary is the
  coined term's home; the ADR is the decision record; the test header orients the
  suite), and cross-citations exist — but a future semantics change must touch
  four spellings with nothing mechanical keeping them aligned. House style
  currently embraces this; noting the drift surface only. (~35%)
- **A5 — Revisit trigger for a schema-owned anchor.** If a second consumer of the
  Review-time anchor appears (e.g. Insights weekly digest or a future reporting
  surface adopting review-time semantics), the "single owner" should likely move
  from a TS fragment to a Postgres generated column or view — at which point the
  expression also becomes indexable and A1 dissolves. ADR 0019's
  provenance-column rejection ("deferred until a second consumer actually
  exists") already encodes this trigger; recording it here so round-2 reviewers
  don't re-derive it. (Not a finding — a future signpost.)

## Triage verdicts (orchestrator, 2026-08-10)

- LOW (calendar-boundary flake: beforeAll seed vs assert-time bucket
  recompute) — **ACCEPT as documented risk, wontfix**: seconds-wide window,
  fails loudly, rerun passes; deterministic clock injection would widen the
  production interface (NOW() is baked into the KPI queries). Suite header
  comment added documenting the adjudication.
- LOW (`approval_method` raw `'owner'` literal) — **ACCEPT, FIXED**: fixture
  now imports `APPROVAL_METHOD` from `@/lib/auto-approval/types` and uses
  `APPROVAL_METHOD.OWNER`.

## Round 2 verification (standards axis)

Verified fix commit `aafe96b5` against the round-1 triage verdicts (2026-08-10).

- **F1 (calendar-boundary flake, adjudicated wontfix) — VERIFIED.** The suite
  header comment (`src/lib/kpi/__tests__/service.anchor.integration.test.ts:24-32`)
  documents the adjudication accurately: beforeAll seed vs assert-time
  `DATE_TRUNC` recompute, seconds-wide window, loud failure with a passing
  rerun, and clock injection rejected because `NOW()` is baked into the
  production KPI queries. The comment's factual claims check out against the
  code — the future-clamp fixture it cites is indeed `NOW() + interval
  '2 days'` (line 224), and its Sat/Sun-only ISO-week-crossing arithmetic is
  correct for Monday-start weeks. The commit's diff on this file touches only
  the header comment, one import, and one fixture value binding — no fixture
  time arithmetic and no assertion changed, so the adjudicated risk profile is
  unaltered.
- **F2 (`approval_method` raw `'owner'` literal) — VERIFIED.** The fixture now
  imports `APPROVAL_METHOD` from `@/lib/auto-approval/types` (line 52) and
  binds `${APPROVAL_METHOD.OWNER}` in `seedPostedResponse` (line 143) —
  identical import path and usage shape to the sibling live-DB suite
  `worker/jobs/response-generation/__tests__/auto-approval-daily-cap.integration.test.ts:40`.
  `APPROVAL_METHOD.OWNER === 'owner'`, so no behavior change; the value moved
  from an inline SQL literal to a bind parameter, which is the house pattern.
- **No new violations in `aafe96b5`.** The only code change is the test file
  (comment block matches the file's existing header style; no `any`; one stray
  literal removed, none added). The remaining additions are the two round-1
  review reports under `docs/reviews/feat-688-kpi-review-time-anchor/` — docs
  only.
- **Checks re-run**: `pnpm typecheck` → clean; `TEST_DATABASE_POOL_URL` (from
  `.env.local`) `pnpm vitest run src/lib/kpi/__tests__/service.anchor.integration.test.ts`
  → 9/9 passed (330ms). Working tree clean for `src/lib/kpi/` at verification
  time.

**Round-2 verdict: VERIFIED — all accepted findings addressed as triaged; no
new findings.**
