# Step 7 — Spec & Correctness Review: feat/540-voice-report-card

Reviewer: spec-correctness agent · 2026-07-24
Base: `git merge-base origin/main HEAD` = `991b78c1` · Diff: 14 files, +1980/−15

## Verification summary

### Intake contract, field by field

| Field | Verdict | Evidence |
|---|---|---|
| goal | PASS | Owner-facing card on `/settings/voice`, five register traits, N-of-5 activation, deterministic, read-only. |
| non_goals | PASS | No LLM calls anywhere in the new modules; no storage/migration; no flag/tier gate; no account aggregation (route is per-`locationId`); no partial traits below activation (`examples` is `[]` below threshold, so `deriveVoiceReportCard` returns no traits); prototype variant C untouched. |
| user_visible_behavior | PASS with one wording caveat (finding 3) | Card below `BrandVoicePanel` in `VoiceClient.tsx`; keyed remount follows the location selector; activated/fallback/progress states all present in `VoiceReportCard.tsx`. |
| invariants | 5/6 PASS; 1 nuanced (finding 1/2) | Same-corpus invariant held structurally: route calls `getVoiceCorpusStatus` and derives from `status.examples`, which are byte-identically the prompt path's pairs. Snippet-from-conforming-pair held by construction (every deriver's snippet uses a member of its `conforming` set). Detection bar implemented as specified (`clearsBar` = ≥2 AND strict majority; critical exempted to ≥1 negative meaningful pair, star ≤2 via `classifySentiment` — confirmed `clamped <= 2 → 'negative'` in `src/lib/reviews/sentiment.ts:31`). Account+business scoping held (route.ts:29-34). No LLM. No raw draft/edit text logged (`reportCaughtError` receives only `{ locationId }`; derivation module has zero logging). BUT: two claim *texts* can be false relative to their own evidence — see findings 1 and 2. |
| edge_cases | 6/7 PASS; 1 drift (finding 5) | 0-edits handled (rows.length 0 → 0-of-5; no dedicated 0-count test, see appendix). Exactly 4 → tested (`voice-learning.test.ts:26`). ≥5 with zero traits → fallback tested. No negative pairs → omitted, tested. Identical draft/edit → `isMeaningfulEdit` excludes from every heuristic, tested. Location switch re-fetch → keyed remount + UI test. Invalid locationId → **400, not 404** (foreign/archived → 404). |
| allowed_edit_surface | PASS | Every changed file is inside the surface (checked against diffstat). |
| tests_to_add | PASS | All 10 titles present verbatim: 2 in `voice-learning.test.ts`, 5 in `voice-report-card.test.ts`, 3 in `report-card/__tests__/route.test.ts`. All pass (21/21 across the 4 new suites, run locally). |

### Blast radius — worker call path (critical check)

`worker/jobs/response-generation/generate-draft.ts:104` still calls `getApprovedResponsePairs(sql, businessId)`. The diff of `src/lib/responses/voice-learning.ts` shows the SQL text (query, `ORDER BY resp.posted_at DESC`, `LIMIT 10`), the `< MIN_EXAMPLES_FOR_ACTIVATION → []` activation rule, and the `rows.slice(0, 5).map(...)` mapping are all unchanged — only wrapped in `getVoiceCorpusStatus` and re-exposed via a delegating `getApprovedResponsePairs` that returns `.examples`. **Behavior is byte-identical: same query, same activation semantics, same 5-example slice, same ordering.** Other importers of changed files are tests or the new route; the 71 "importers" of the route path in blast-radius.md are a heuristic-text artifact (shared helper imports), not semantic dependents.

### Auth / tenancy on the new route

- `requireOwnerWithAccount` gate first (route.ts:20-22).
- UUID shape validated before the `::uuid` cast (no cast-error 500 on garbage input).
- Ownership query scopes by `account_id` AND `archived_at IS NULL` → foreign or archived location = 404, corpus never read (`mockGetVoiceCorpusStatus` not called — asserted in route test).
- Corpus query then scoped by the verified `business_id`. Matches invariant #8's account+business two-key scope.

### Deviations doc

All three accepted deviations verified sound in the implementation: (1) the `if (!evidence) return null` guards are unreachable-by-construction narrowing, and `null` is the deriver's own "not detected" semantics, not error swallowing; (2) `key={locationId}` remount is behavior-equivalent to the reset-in-effect and is covered by the re-fetch UI test; (3) inline styles match the sibling idiom in `VoiceClient.tsx`.

## Findings (≥80% confidence)

### 1. MAJOR — Length claim can render text that contradicts itself (voice-report-card.ts:114-122)

`deriveLength` gates on conforming pairs (edit ≤ 75% of draft words) but computes the displayed averages over **all** pairs, including non-conforming ones. Concrete failure: pairs A/B/C = 100-word drafts cut to 70 words (3/5 conforming → clears bar: 3 ≥ 2, 6 > 5); pairs D/E = 20-word drafts expanded to 200 words. avgDraft = 68, avgEdit = 122. The card renders: *"You tighten replies: your edits average 122 words; drafts average 68."* — a claim whose own numbers say the opposite of "tighten." Fix direction: compute the quoted averages over the conforming pairs (or all *meaningful* pairs and only claim when avgEdit < avgDraft).

### 2. MEDIUM — Critical-reviews single-pair claim "you replaced the draft with your own words" is false for small edits (voice-report-card.ts:204-207)

The non-generalized else-branch fires for ANY meaningful negative-pair edit where editWords ≥ draftWords. A one-word typo fix on a 2-star reply ("...for you feedback" → "...for your feedback", equal word counts) renders *"On your 2-star review you replaced the draft with your own words"* directly above a before/after snippet showing the draft essentially intact. Same for a draft with one appended sentence. The claim is contradicted by its own evidence snippet. Fix direction: require a minimum edit distance/word-overlap threshold for the "replaced" wording, or fall back to neutral wording ("you reworked the draft").

### 3. MINOR — Fallback copy states a capped count as an absolute fact (VoiceReportCard.tsx:177 + voice-learning.ts LIMIT 10)

`editedCount` is capped at 10 by the corpus query's `LIMIT 10` (documented on `VoiceCorpusStatus`). The zero-trait fallback renders *"You've edited {editedCount} replies"* as an absolute statement — an owner with 30 edited replies reads "You've edited 10 replies." The pre-activation progress state is unaffected (counts 0-4 are exact). Fix direction: "your 10 most recent edited replies" / "10+ replies", or drop the number.

### 4. MINOR — Sign-off heuristic mistakes sentence-final em-dash phrases for sign-offs on single-line replies (voice-report-card.ts:43,130-137)

`TRAILING_SIGNOFF_RE` (`/[—–]\s*([^—–\n]{1,40})$/`) captures any ≤40-char tail after the last em/en dash of the last line. For single-line casual edits the dash is usually a greeting/clause dash, not a signature. Concrete failure: an owner who habitually edits to "Hi {name} — thanks so much!" (identical trailing phrase, 3 of 5 pairs; formal drafts have no signoff so `withSignoff` admits them; 3/5 clears the bar) gets the claim *"You sign as '— thanks so much!.'"* — a false sign-off claim manufactured from a mid-sentence dash. Fix direction: require the own-line form (`OWN_LINE_SIGNOFF_RE`) for single-line texts, or require the captured tail to look name-like (≤3 words, no sentence punctuation).

### 5. MINOR — Intake vs implementation: invalid (malformed) locationId returns 400, intake edge case says 404 (route.ts:25-27)

Intake edge_cases: "Invalid or foreign locationId -> 404". Code: missing/non-UUID → 400; foreign/archived → 404. This matches the plan's interface contract ("400 missing/invalid locationId · 404 foreign/archived") and the sibling voice route idiom, so the plan and intake conflict and the code followed the plan. Not a security issue (400 leaks nothing). Flagged as spec drift for the record; recommend amending the intake copy rather than the code.

### 6. MINOR — Ownership query sits outside the try/catch, bypassing the declared observability path (route.ts:29-37 vs intake observability)

Intake: "Route failures report via reportCaughtError('api/settings/voice/report-card GET') -> Sentry." A DB error in the ownership SELECT (lines 29-34) escapes the handler unreported-by-`reportCaughtError` (Next's generic 500 path instead). The corpus/derivation path is covered. Fix direction: widen the try block to include the ownership query.

## Low-confidence appendix (NOT findings; <80% or non-defect)

- **No dedicated 0-edited-replies test.** The 0-of-5 state is handled by the same `rows.length < 5` branch tested at 3 and 4, and the intake's own tests_to_add never demanded a 0-count title; listing for completeness only.
- **"every detected trait's snippet comes from a conforming pair" test is partially vacuous** (`voice-report-card.test.ts:68-78`): the `find` predicate short-circuits to true whenever `snippet.before` contains "words", and the after-check short-circuits on `afterCore.startsWith('—')`. The invariant itself IS held by construction in the derivers; the test just under-asserts it. Test-quality note, not a correctness defect.
- **Greeting "never 'Dear'" claim is scoped to the 5-pair window** — an owner whose 6th-most-recent edit used "Dear" still gets "never 'Dear.'" Window-scoped claims are inherent to the locked corpus decision; acceptable.
- **`clearsBar` denominators use all pairs (including non-meaningful ones) as "applicable"** for greeting/length/point-of-view. Strictly more conservative than excluding them (can only under-detect, never over-detect); consistent with the intake's "identical pair is non-conforming for all heuristics."
- **`derivePointOfView` counts "I'm" as one first-singular hit via the bare `i` alternative** (alternation order makes `i'm` unreachable). Counting outcome is identical; cosmetic regex nit.
- **UI `catch` swallows the distinction between network failure and non-OK status** into one message; matches the intake's "visible error state" requirement, so fine.

## Verdict

Spec conformance is strong: corpus-identity invariant, tenancy scoping, detection bar, activation states, edit surface, and all 10 promised tests check out; the worker prompt path is provably unchanged. The real defects are all in **claim-text soundness** (findings 1, 2, and 4): three deterministic heuristics can emit owner-facing claims their own displayed evidence contradicts. None are security- or data-affecting; all are contained in `voice-report-card.ts` claim construction and one UI copy string.

## Orchestrator triage verdicts (step 7)

- major length-claim averages — ACCEPTED, fixed (averages over conforming pairs; claim reworded).
- medium critical else-branch over-claim — ACCEPTED, fixed (isSubstantiveRewrite bar: ≤0.75 cut OR Jaccard <0.7).
- minor fallback editedCount absolute — ACCEPTED, fixed ("10+" floor rendering).
- minor trailing sign-off false positive — ACCEPTED, fixed (name-shaped TRAILING_SIGNOFF_RE).
- minor 400 vs intake 404 — REJECTED as code change: code follows the plan's sharper contract (400 malformed / 404 foreign); intake edge-case wording harmonized instead (both copies).
- minor ownership SELECT outside try/catch — ACCEPTED, fixed (SELECT inside try; reportCaughtError path covers it).
