# Standards & Maintainability Review — Competitor Delta #539

Reviewer role: standards & maintainability (review-only, no production/test
edits).  
Base: `origin/main...f6bf062b`.  
Method: `thermo-nuclear-code-quality-review`, RepWorth project rules,
codebase-design deep-module discipline, Fowler smell baseline, the
`CONTEXT.md` Competitor Delta glossary, and the checked-in blast-radius report.

## Overall verdict

The change is reasonably localized: the weekly worker remains below the
1,000-line threshold (425 lines), the new policy is private to its single
consumer, the renderer receives a compact discriminated value, and no new
module, dependency, ambient database import, external call, or write path was
introduced.

Two issues clear the 80% confidence bar. The selector's final tie-break is not
actually encoded as a total comparator, so its determinism partly depends on
the SQL query's incidental pre-order. Separately, rating normalization is dead
implementation work behind the module interface, and its named regression test
cannot detect removal or breakage of the parser. Both weaken the locality and
verification properties the branch is trying to establish.

## Findings

| Severity | File:line | Concrete failure scenario / named standard violated |
|---|---|---|
| Medium | `worker/jobs/WeeklySummaryWorker.ts:273` | Two equally distant rivals whose ranks are both `NULL` produce `Infinity - Infinity = NaN`; the comparator returns that before reaching the `place_id` tie-break. Equal `place_id` values also return `1`, never `0`. Today the SQL `ORDER BY` often masks the first defect, but the deterministic Auto-default rule is therefore split between query order and an invalid comparator. This violates the single-owner/locality standard and makes the pure selector unsafe for any differently ordered input. Handle null ranks explicitly and finish with a three-way `place_id` comparison (`localeCompare` or equivalent). |
| Medium | `worker/jobs/WeeklySummaryWorker.ts:234` | `parseCompetitorRating` changes a field that no branch ever reads, and `NormalizedCompetitorSnapshotRow.rating` never crosses the module interface. Consequently `parses NUMERIC competitor ratings returned by Postgres.js as strings` (`WeeklySummaryWorker.test.ts:530`) still passes if the mapper/parser is deleted or returns the original string. This fails the deep-module deletion test and creates false regression confidence. Either remove `rating` from this v1 read model until a real consumer exists (and amend the locked intake), or move normalization behind an interface whose returned value is actually consumed and directly contract-tested; do not retain an unobservable identity pipeline solely to satisfy a test title. |

## Detail

### 1. The selector should own its complete deterministic order

The selected candidate order is a domain rule, so it should be readable and
correct in one place. Mapping `NULL` to positive infinity is concise for
numeric-vs-null comparison, but subtracting two infinities yields `NaN`.
Because `NaN !== 0`, line 275 returns early and skips stable place identity.
The current database query happens to order `place_id ASC`, which hides this
for ordinary distinct identities, but that makes the selector depend on a
caller precondition absent from its interface.

The migration deliberately has no per-row uniqueness constraint, so an equal
identity is not an impossible storage state. The final comparator branch also
violates the comparator contract for that case by returning `1` in both
directions. A direct null-aware comparison removes both hidden assumptions
without adding a new abstraction.

### 2. Rating normalization has no observable contract

The locked v1 behavior deliberately excludes rating from selection and copy.
That leaves the new `rating` projection, raw row field, normalized row field,
parser, and mapping step with no behavioral effect. The test supplies
`"not-a-finite-rating"` but only asserts the same rival/gap output that would
be produced without looking at rating at all. It is therefore a surviving
mutation, not evidence for the stated invariant.

This is exactly the kind of incidental complexity the thermo-nuclear
deletion test is intended to expose: deleting the entire normalization path
makes no complexity reappear at callers. The cleanest v1 shape is to avoid
reading unused data. If project intent requires normalization now despite that
tradeoff, it needs a real, narrow read-model interface with an observable
contract rather than a presentation interface widened with unused rating
data.

## Checks that passed

- No changed production file crosses 1,000 lines.
- Competitor Delta policy is not scattered across unrelated callers.
- `loadCompetitorDelta` is explicitly tenant/location/keyword scoped and
  receives its database dependency.
- The renderer HTML-escapes rival names and teaser keywords at the presentation
  seam.
- The discriminated `CompetitorDelta` value keeps SQL row details out of the
  email template.
- The blast radius is narrow: the template is imported through the existing
  email barrel, and the worker's production importer remains `worker/index.ts`.
- No new dependency, schema mutation, external request, logging hazard, or
  non-atomic write path was introduced.

## Low-confidence appendix

- The FIFO SQL-return queue in `WeeklySummaryWorker.test.ts` now models up to
  sixteen conditional calls. It is brittle under harmless query reordering,
  but this is the established harness and the branch added fixture helpers
  rather than creating a second testing mechanism, so it does not clear the
  finding bar for this ticket.
- The three Competitor Delta reads are sequential and the optional line can
  fail the whole digest. Existing weekly ranking inputs have the same
  fail/retry posture, and the repository documents a prior connection-wedge
  caused by indiscriminate query parallelism, so neither parallelization nor
  fail-open degradation is justified here without a broader policy decision.

## Triage

- **ACCEPT — Medium, `WeeklySummaryWorker.ts:273`:** the selector must own a
  total deterministic order. Compare nullable ranks without infinity
  subtraction, then use a three-way place-identity comparison.
- **REJECT — Medium, `WeeklySummaryWorker.ts:234`:** the user explicitly
  required parsing `competitor_snapshots.rating` at the Postgres.js read
  boundary, while the locked #532 contract explicitly forbids rating from
  influencing v1 selection or copy. Removing the parser violates the request;
  exposing rating through `WeeklyValueReportParams` would widen the interface
  with forbidden presentation data. The private normalization stays, with the
  accepted malformed-blank correction; its current test proves path execution
  rather than mutation sensitivity, an intentional limitation until rating
  gains a real consumer.

## Re-review after fixes

Reviewed HEAD `b4fd8c4b`. The accepted comparator fix now handles equal nullable
ranks without subtracting infinities, performs a proper three-way
`place_id` comparison, and returns `0` for equal identities. The new reversed-
input regression test proves the selector no longer relies on SQL pre-order;
the focused worker suite passes 23/23.

The rating finding remains intentionally rejected for the documented locked-
contract reason. The added blank-string guard is local and does not widen an
interface or introduce a new maintainability regression.

| Severity | File:line | Finding |
|---|---|---|
| — | — | No remaining high-confidence standards or maintainability findings. |

## FINAL VERDICT: APPROVED
