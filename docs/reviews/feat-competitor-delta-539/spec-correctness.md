# Spec & Correctness Review — Competitor Delta #539

Reviewer: spec/correctness axis · 2026-07-24  
Base: `git merge-base origin/main HEAD` = `42a4c30b`  
Reviewed head: `f6bf062b`  
Diff: 8 files, +713/−9

## Verdict

The implementation is faithful to the locked #539 contract and the accepted
adversarial correction. The digest reads the exact current
`(business_id, primary keyword, search_location)` observation series, selects
the Auto-default rival deterministically, computes signed same-snapshot gap
math and place-identity velocity, and renders the required
omit/teaser/gap-only degradation with escaped owner-visible copy.

There is one low-severity edge-contract defect: the NUMERIC parser treats an
empty or whitespace-only string as rating `0` rather than malformed `null`.
That value is intentionally absent from v1 selection and copy, so it does not
change the shipped Competitor Delta line, but it does violate the intake's
explicit normalization rule.

## Findings (confidence >=80%)

| Severity | File:line | Concrete failure scenario / violated contract |
|---|---|---|
| Low | `worker/jobs/WeeklySummaryWorker.ts:234-237` | `Number('')` and `Number('   ')` both produce finite `0`, so an empty/whitespace malformed Postgres.js rating value is normalized to `0` instead of `null`. This violates the intake edge case “Malformed or non-finite NUMERIC rating text is normalized to null,” even though rating remains deliberately absent from v1 selection and copy. |

## Intake contract — field-by-field evidence

| Field | Verdict | Evidence |
|---|---|---|
| `classification` / `surface` / `db_touching` | PASS | The diff is backend-only and deepens `WeeklySummaryWorker`; the new behavior is read-only over `businesses`, `ranking_snapshots`, and `competitor_snapshots`. Existing weekly-summary/delivery writes are unchanged. |
| `goal` | PASS | `loadCompetitorDelta` reads the primary keyword's persisted local-pack series and `selectAutoDefaultRival` returns current review-count gap plus velocity since the preceding observation when the same `place_id` exists. |
| `non_goals` | PASS | No Named-rival persistence/UI/API, scheduler cadence change, external call, rating/rank copy, account aggregation, migration, flag, or dependency was added. |
| `user_visible_behavior` | PASS | Current+preceding match renders velocity and gap; current without a preceding identity match renders gap only; configured/no usable pack renders one cadence-safe teaser; missing primary keyword/search location returns `null` and omits the line. #546's owner-pick/dropout behavior is not pre-built. |
| `invariants` | 6 PASS; 1 narrow defect | Gap is `rival.review_count - self.review_count`; selection is nearest positive gap, else closest non-positive, then rank (`NULL` last), then `place_id`; all reads carry business/keyword/search-location scope; coordinate NUMERIC text is built in SQL without JS number round-tripping; there is no external call or competitor/ranking mutation; rival/keyword copy is escaped. Rating strings are passed through `Number` and non-finite values become `null`, but empty/whitespace strings become `0` (finding 1). |
| `edge_cases` | PASS except finding 1 | Zero and negative gaps remain signed; null ranks sort last; invalid rival rows and self rows are excluded; a missing/invalid self baseline teases; missing preceding `place_id` match yields gap-only; positive/zero/negative velocity grammar is correct; changed keyword/location starts a new exact-match series. Empty/whitespace malformed ratings are the one normalization miss. |
| `existing_patterns_to_follow` | PASS | The worker's existing `loadWeeklyValueInputs` aggregation and queued-SQL harness were extended; the existing weekly email template owns conditional escaped presentation. No new module or interface was introduced. |
| `allowed_edit_surface` | PASS for product implementation | All source, test, glossary, intake, handoff, and review changes are within the declared product/test surfaces or feature-workflow `docs/` artifact surface. No unrelated production path changed. |
| `tests_to_add` | PASS by title; one quality note below | All five promised titles exist verbatim. Worker tests cover scoped series keys, deterministic ahead selection and tie breakers, signed behind fallback, omit/teaser/gap-only states, and the newer-empty-pack regression. Template tests cover cadence wording, velocity grammar, signed gaps, disclosure, omission, and escaping. |
| `verification_commands` | PASS | Independently reran the two focused suites: 2 files, 56 tests passed. Existing `.feature/gate-status.json` records lint, typecheck, full tests, every CI audit, focused suites, and promised-tests as PASS. |
| `estimated_diff_size` | PASS | Actual +713/−9 includes about 210 lines of mandatory plan/handoff material and remains close to the approved +430/−10 implementation/test/glossary/intake plus plan/handoff estimate. |
| `dependencies_added` | PASS | No package manifest or lockfile changed. |
| `rollback_plan` | PASS | The feature has no schema/data migration or new external side effect; reverting the application commits removes the line. |
| `observability` | PASS | The existing WeeklySummaryWorker success/failure path and `weekly_value_report` delivery record remain intact. The locked staging check can reconcile delivered copy against persisted snapshot rows. |
| `open_questions` | PASS | Empty, and the implementation introduces no new product decision. |

## SQL, tenancy, and snapshot anchoring

- Settings are loaded by `businesses.id = businessId`; both subsequent reads
  repeat `business_id`, `keyword`, and `search_location` predicates. No
  cross-location or cross-keyword row can enter the selector.
- Coordinate-backed `search_location` uses
  `google_place_lat::text || ',' || google_place_lng::text`, matching the
  Postgres.js NUMERIC text consumed by `RankingTrackingWorker` without changing
  scale through a JS number.
- The latest two dates come from `ranking_snapshots`, the durable observation
  parent written in the same transaction even when the child Competitor pack
  is empty. Child rows are fetched only for those dates. This is the accepted
  adversarial fix: a newer empty July 20 observation cannot revive a stale July
  6 rival as “current.”
- The preceding comparison requires both the exact preceding observation date
  and the selected current rival's `place_id`; otherwise `reviewVelocity` is
  `null`.
- The pack query is bounded to at most two approximately 20-row packs and makes
  no write or provider call.

## Selection and presentation correctness

- The selector requires a current self row with integer `review_count`; without
  that same-snapshot baseline it returns the teaser path.
- Candidates require non-self, non-empty `place_id`, non-empty title, and
  integer `review_count`. If any positive gap exists, only positive candidates
  compete and the smallest wins. Otherwise descending signed gap chooses zero,
  then the least-negative challenger.
- Equal gaps use numeric rank with `NULL` mapped to positive infinity, then
  lexical `place_id`, matching the locked deterministic order.
- The template labels every v1 stand-in `Auto-selected rival:`. It says
  `gained`, `lost`, or `had no new reviews` “since our last check”; it never
  says the rival gained reviews “this week.” Gap-only output omits velocity.
- Positive, zero, and negative gaps are printed as signed numeric values.
  Rating and rank never enter owner-visible copy.
- `escapeHtml` is applied at the rendering boundary to both rival title and
  teaser keyword.

## Promised-test audit

| Promised title | Evidence |
|---|---|
| `selects the Auto-default rival by nearest review-count gap with deterministic tie breakers` | `WeeklySummaryWorker.test.ts:400`; exercises equal positive gaps, numeric-rank tie, `NULL` rank last, `place_id` tie breaker, farther-ahead rejection, exact scoped query values, and preceding identity velocity. |
| `renders review velocity since our last check and the current review-count gap` | `email-templates.test.ts:198`; covers gained/unchanged/lost grammar, signed gaps, and rejects “this week” rival wording. |
| `degrades Competitor Delta through omit teaser and gap-only empty states` | `WeeklySummaryWorker.test.ts:453`; covers unconfigured omission, configured/no observation teaser, and current-pack/no-predecessor gap-only. The separate `:496` regression covers newer-empty-over-older-nonempty history. |
| `parses NUMERIC competitor ratings returned by Postgres.js as strings` | `WeeklySummaryWorker.test.ts:530`; supplies malformed string rating through the real worker read path. See the low-confidence note: its downstream assertion does not directly distinguish parsed `null` from an unparsed unused value. |
| `escapes the Competitor Delta rival name and teaser keyword` | `email-templates.test.ts:222`; asserts escaped output and absence of raw injected tags for both variants. |

## Adversarial triage read-back

The accepted high finding is resolved at `WeeklySummaryWorker.ts:317-343`.
`ranking_snapshots` now anchors current/preceding observation dates before the
child pack lookup, and the regression at
`WeeklySummaryWorker.test.ts:496-528` proves a newer exact-series empty
observation renders the teaser instead of stale rival data. The adversarial
report's final verdict is `APPROVED`.

## Low-confidence appendix (not findings)

- The promised rating test drives a malformed string through the read path but
  only asserts the downstream Competitor Delta value, where rating is
  intentionally unused. It would not fail if normalization were removed.
  Coverage proves execution, not the normalized value. A direct assertion
  would require exposing or relocating a currently single-use private parser,
  so this is recorded as test-strength debt rather than a second finding.
- The final `place_id` comparator returns `1` instead of `0` for duplicate
  identities. This violates comparator antisymmetry, but identical place
  identity is the owner-relevant result and duplicate identities are not an
  established producer state. This matches the adversarial review's
  below-threshold assessment.
- `ranking_snapshots` supports historical `manual`/`api` source labels, while
  the observation-date query does not filter `source = 'serpapi'`. The only
  current exact-location writer is `RankingTrackingWorker` (`serpapi`); the
  admin manual route omits `search_location`, so no reachable competing
  same-series observation was found.

## Triage

- **ACCEPT — Low, `WeeklySummaryWorker.ts:234-237`:** blank or whitespace-only
  text is malformed at the read boundary and must normalize to `null` before
  the intentional v1 rating discard.

## Re-review after fixes

Reviewed HEAD `b4fd8c4b`. The accepted finding is resolved:
`parseCompetitorRating` now rejects `null`, empty, and whitespace-only text
before calling `Number`, so every declared malformed/non-finite rating
normalizes to `null`. The accompanying comparator correction establishes a
true total order by returning `0` for equal place identities; it introduces no
new spec or correctness defect. Focused verification passes: 2 files, 57
tests.

| Severity | File:line | Concrete failure scenario / violated contract |
|---|---|---|
| None | — | No remaining or newly introduced finding at >=80% confidence. |

**FINAL VERDICT: APPROVED**
