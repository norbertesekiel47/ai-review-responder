# feat-688 deviations log

Dated notes where execution had to depart from (or disambiguate) the plan
`2026-08-10-feat-688-kpi-review-time-anchor.md`. Task numbers refer to that plan.

- [2026-08-10, Task 1] **`SentimentTrendPoint.weekStart` is NOT an ISO date at
  runtime — the plan's `::date::text` expectation spelling can never match it.**
  postgres.js decodes a `date` (OID 1082) column into a JS `Date`, and
  `mapTrend`'s `String(r.week_start)` therefore emits the long local form
  (`"Mon Aug 10 2026 00:00:00 GMT-0700 …"`), not `2026-08-10` — the
  `types.ts` doc comment ("ISO date") is wrong about the runtime value. The
  suite computes expected week starts in SQL as `::date` (no `::text`) so the
  expectation round-trips through the same decode + `String()` path the
  production mapper uses. Tests 2 and 5 would otherwise fail for the wrong
  reason (test 5 is a mandated pin). Task 2's executor should NOT "fix" this
  in passing — the wire format is a pre-existing observation, out of #688's
  scope; flag it separately if it matters.
- [2026-08-10, Task 1] **There is no `RESPONSE_STATUS` export.**
  `src/lib/shared/response-status.ts` owns named GROUPS (arrays) only —
  exactly what the plan's "use the actual exported name — grep the file"
  anticipated. The fixture anchors its posted literal to the vocabulary via
  `'posted' satisfies (typeof HANDLED_STATUSES)[number]`.
- [2026-08-10, Task 1] **Tests 7/8 ordering made explicit.** The plan's "seed
  order makes 7+8 assert the same summary" is implemented as: review H seeded
  in `beforeAll`, test 8 (the pin) DECLARED before test 7, and test 7 seeds
  review G + its pre-dated response inside its own body. Today: 8 reads only H
  (green, 6h), 7 reads G+H (red, −105h). After Task 3 both read the same final
  state and both assert 6.
- [2026-08-10, Task 1] **Supplementary account-scope test is a scope-consistency
  pin, not the plan's `priorMonth ≥ 1` example.** The plan's example assertion
  is post-#688 semantics — red today — which would break the mandated
  EXACTLY-4-red outcome (tests 1, 2, 3, 7). Instead the test asserts
  bucket-level equality between `getAccountKpiSummary` and the sum of the seven
  location summaries (volume buckets, response-rate numerator/denominator,
  per-week trend counts). Green under either anchor; red if Task 2 lands the
  anchor in one scope only — which is the behavior the supplementary exists to
  lock.
- [2026-08-10, Task 1] **`seedLocation` defaults `isPrimary: true` and
  `businesses_account_primary_uniq` allows one primary per account** — seeding
  seven clusters requires `isPrimary: bizId === VOLUME_BIZ` (first run failed
  on the partial unique). Worth knowing for any future multi-location live-DB
  suite built on `seedLocation`.
