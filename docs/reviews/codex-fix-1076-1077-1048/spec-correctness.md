# Spec/correctness review

Base: `249389c7e16aa9b2efb0646f0f1b6b88410b017a`
HEAD: `27069fef26fb001ec5133fa41ec893521a2722f2`

Reviewed the supplied approved contract and production diff, committed source,
tests, relevant domain documentation, and every entry in the committed
spec-correctness finding checklist. No working-tree source, other review-axis
conclusions, tests, mutations, remote actions, or browser controller were used.
The dispatch reports the committed full/review gates green; this review does
not independently rerun those gates. Computer Use remains unavailable, as
explicitly recorded in the committed verification document.

## Finding

### S1 — Low: archival-disclosure tests render the wrong scope

- File: `src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx:364`
  (also line 369).
- Confidence: 100%.
- Contract: #1077 discloses incomplete archival history in the location view;
  edge cases include account/location views and the promised rendering test
  qualifies omitted archived periods.
- Evidence: both newly added tests put `scope: 'location'` inside `logWith`,
  but `renderReport` defaults its second argument to `'account'` at line 110
  and renders `{ ...log, scope }` at line 115. It overwrites their location
  setting. Therefore both tests actually exercise an account payload; the
  real database only returns archival history in location scope.
- Concrete failure: the branch has no positive rendering assertion for the
  actual location-only overflow payload. A regression omitting the qualifier
  specifically when `log.scope === 'location'` would not be caught by these
  new tests, despite suppressing #1077's disclosure for every real overflow.
  This is established by the helper's argument/overwrite behavior, not a
  claimed mutation-test execution.
- Fix: pass `'location'` as the second argument to `renderReport` in both
  tests. Assert the rendered location scope sentence as a non-vacuous fixture
  check, or adjust the helper so the payload's supplied scope is authoritative.

No production correctness defect met the reporting threshold.

## Contract coverage

| Contract area | Review result |
| --- | --- |
| #1076 policy history | Flag-on and flag-off copy always enters the common notes block, including empty and populated windows. It has no selected-window or time-based expiry. Existing/new render tests cover both flag values and the enabled empty/populated cases. |
| #1077 bounded archive history | Read uses newest-first timestamp/ID ordering, fetches 201, detects overflow, pairs only 200 retained events in chronological order, and returns a separate boolean. Account scope returns false. Existing full refusal count and entry truncation remain independent. 0/200/201 and an omitted in-window pair are exercised at the live-DB seam. Leading unpaired reactivation is still ignored by unchanged pairing. Rendering test scope defect is S1. |
| #1048 recorded attribution | Bulk read is bounded by candidate IDs, uses account/location predicates plus ask/contact/review consistency joins, requires attribution timestamp and an extant dated non-deleted review, and has no attribution/display-age cutoff. DISTINCT ON selects deterministically by attribution timestamp then outreach ID. No name matching, sentiment/rating input, or sibling matching is introduced. |
| Evidence, precedence, persistence | `toCandidate` supplies real review ID/date; unchanged `evaluateAsk` preserves consent then suppression then already-reviewed precedence. Existing `commitAskDecisions` writes ask evidence, Refusal through the single writer, completed child run and links inside batch construction's transaction. Lock ownership, CAS, replay behavior, six reasons, category mapping and kill switch are unchanged. |
| Missing/foreign/history edges | New live-DB cases cover retained 90/120-day history, multiple evidence rows, physical/soft deletion, null date, no attribution, foreign review pointers in sibling and other-account locations, both higher-precedence gates, replay and disabled ledger. Assertions inspect actual stored evidence, ask/run linkage, mapped Refusal and no duplicate effects. |
| Owner claims | Requests copy is qualified by retained dated evidence linked to prior requests at this location, with no never-ask-again promise. Refusal response adds only an archival completeness boolean; no raw codes, moderation prose, or PII are added. Runtime payload validation rejects malformed boolean input. |
| Scope/non-goals | Changed paths fit the approved surface including D1's architecture-log amendment. No schema, dependencies, flag changes, backfill, new writer or outbox owner. Pre-merge architecture entry leaves the counter unchanged. |
| Verification seam limits | Tests cover each promised test theme through the existing database, component and Requests seams, subject to S1. Window-independent disclosure logic was inspected for all selectable windows. Desktop/mobile, interaction/error-path browser results and screenshot evidence are explicitly blocked, not claimed verified. |

## Accepted-finding checklist audit

Numbers below refer to the 36 entries in the committed checklist in file order.
Each entry was considered; unrelated subjects remain outside this change.

| Entry | Result / scope rationale |
| --- | --- |
| 1 | No metadata parser or dynamic title guard changes. |
| 2 | No layout/title exclusion changes. |
| 3 | No Open Graph/title scanning or deferred OG work. |
| 4 | Tests use real read/build/render seams; checked assertions against their intended behavior. S1 identifies a wrong rendering fixture. |
| 5 | Applicable wrong-subject fixture class: S1's apparent location scope is overwritten by the helper. |
| 6 | No public page/title promise adopted. New Requests promise matches retained evidence. |
| 7 | New review-date copy is supported by `r.review_date IS NOT NULL` and preserves that value. No received-versus-written KPI claim. |
| 8 | New disclosure text has no hardcoded selected-window duration and runs for all window values. |
| 9 | No score weighting or nullable KPI formula; conditional disclosure states uncertainty explicitly. |
| 10 | New product copy is checked against actual flag/read gates; no unconditional all-review processing promise. |
| 11 | Account/location branches inspected; rendering coverage shortfall recorded as S1. Browser scope coverage is explicitly blocked in verification. |
| 12 | No breakpoint or positioned-panel CSS changes; no unperformed browser sizing claim made. |
| 13 | No new LiveRegion behavior promised; render assertions target the real RestraintReport. |
| 14 | No tooltip/described-by association changes. |
| 15 | No positioning/transform or containing-block changes. |
| 16 | D1 references a file and factual pre-merge entry, without stale line-number citations. |
| 17 | No shared banner selector changes or unenumerated CSS consumer changes. |
| 18 | No viewport/container breakpoint changes. Browser verification remains explicitly unavailable. |
| 19 | No failure component/remount or live announcement transition changes. |
| 20 | New component assertions claim textual rendering, not jsdom geometry; their scope mismatch is S1. |
| 21 | No disabled hover/inline-style changes. |
| 22 | No external layout harness measurements asserted. |
| 23 | No selector specificity or disabled hover fallback changes. |
| 24 | No pixel-basis bounds or visual measurement claims. |
| 25 | No shell-shape invariant introduced. New persistence assertions inspect ask/run/refusal cardinality and replay directly. |
| 26 | No font/preflight-dependent recorded measurements. |
| 27 | No nowrap/clipping/layout change. |
| 28 | Promised tests inspected for actual positive/negative comparisons; retained evidence IDs/dates and count boundaries are asserted. S1 covers the incorrect rendering subject. |
| 29 | No color-encoded chart work; missing desktop/mobile browser evidence is recorded with its controller blocker. |
| 30 | Review date, archival history and full refusal count nouns match their respective reads. |
| 31 | Empty-history and empty-refusal paths inspected: overflow qualifier is independent of paired-period count and zero total. |
| 32 | New qualifiers appear once in common notes; no duplicate empty-branch caption introduced. |
| 33 | No chart cadence or unsupported axis-readability premise. |
| 34 | Prior flag-on omission assertion was replaced with a positive disclosure assertion. No obsolete test exclusion found; S1 is the remaining fixture issue. |
| 35 | Added architecture entry contains no positional source citation and explicitly leaves merge counter unchanged. |
| 36 | Verification records implementation, gates and remaining local review/browser boundaries; no stale T1-only handoff or failing-test markers asserted. |

REVISE

