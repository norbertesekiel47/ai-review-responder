# Run C promised-test audit — 2026-09-13

Read-only inspection of `.feature/intake.json`, the actual test bodies and `scripts/verify-gate.sh:451–479`. This artifact changes no promise, test, gate, or release evidence. Numbered rows below follow `tests_to_add` order exactly (63 entries).

## Finding

**0 of 63 promised strings occur verbatim in the gate's searched files.** The gate uses fixed-string file-content matching, not test discovery: only `src`, `worker`, and `scripts`, and only `*.test.ts` / `*.test.tsx`. It does not search `tests/llm-eval` or `e2e/*.spec.ts`. Parameterized test titles are matched as their source template, not their expanded runtime title; apostrophes escaped in single-quoted source also prevent a verbatim match.

Most promises have behavioral coverage under different titles. Several promises combine multiple tests, and four use wording that conflicts with the locked implementation boundaries. A string-only cleanup is insufficient for the partial/gap rows below.

Status vocabulary: **Covered** = actual assertions support the behavior; **Partial** = some promised assertions are absent; **Misworded** = literal promise conflicts with the intended contract; **Outside scan** = actual test/evidence exists where the gate never searches. None of these statuses asserts that a test was executed during this audit.

## File keys

All paths are relative to this worktree.

| Key | File |
|---|---|
| SETTINGS | `src/lib/auto-approval/__tests__/settings.test.ts` |
| SETTINGS-DB | `src/lib/auto-approval/__tests__/settings.integration.test.ts` |
| FORM | `src/app/api/settings/auto-approval/__tests__/route.test.ts` |
| CATALOG | `src/lib/agents/operator/__tests__/catalog.test.ts` |
| PROMPT | `src/lib/agents/operator/__tests__/prompt.test.ts` |
| SCHEMA | `src/lib/agents/operator/__tests__/schema.test.ts` |
| TOKEN | `src/lib/agents/operator/__tests__/version-token.test.ts` |
| APPLY | `src/lib/agents/operator/__tests__/apply.test.ts` |
| APPLY-DB | `src/lib/agents/operator/__tests__/policy-apply.integration.test.ts` |
| COUNT | `src/lib/agents/operator/__tests__/consequence.test.ts` |
| READER | `src/lib/agents/operator/__tests__/policy-state.integration.test.ts` |
| PROPOSALS | `src/lib/agents/operator/__tests__/proposals.test.ts` |
| CONTEXT | `src/lib/agents/operator/__tests__/context.test.ts` |
| WORKER | `worker/jobs/agent-turn/__tests__/AgentTurnWorker.test.ts` |
| CARDS | `src/app/(authenticated)/dashboard/operator/__tests__/ProposalCard.test.tsx` |
| OPENAI | `src/lib/llm/__tests__/openai-provider.test.ts` |
| EVAL | `tests/llm-eval/__tests__/structured-runner.test.ts` |
| E2E | `e2e/operator.spec.ts` |
| INGEST | `src/lib/reviews/__tests__/process-review.test.ts` |
| IMPORT-DB | `src/lib/reviews/__tests__/import-review.integration.test.ts` |
| ZERNIO | `worker/jobs/zernio/__tests__/zernio-ingest-shared.test.ts` |
| ORIGIN-DB | `worker/jobs/zernio/__tests__/ingestion-origin.integration.test.ts` |

## Promise-to-test map

The promise column is an abbreviated identifier; the row number identifies the complete original entry. Quoted titles are actual source titles/templates and are suitable reconciliation candidates only for the behavior they assert.

| # | Promise | Status and actual test/title |
|---|---|---|
| 1 | Transaction writer writes and reloads on caller transaction | **Covered.** SETTINGS: `the tx export runs every statement and the audit on the caller transaction without opening its own` asserts executor identity, one audit and reloaded override values. |
| 2 | Wrapper and settings form behavior remain unchanged | **Covered across tests.** SETTINGS: `%s seeds a first location dial write as manual with the other dial inherited (complete-disable contraction)` runs wrapper and transaction seams and asserts one versus zero opened transactions. FORM: `PATCH maps confirmation errors to the spec body`, `PATCH maps readiness blocks to the spec body`, and `PATCH still accepts a stale all_ratings confirmation level (one-release tolerance)` preserve the route contract. Split the compound promise rather than rename one test to claim all of it. |
| 3 | Writer locks account before policy read/write | **Covered.** SETTINGS: `$seam: the account FOR UPDATE precedes the first policy statement for $name`; SETTINGS-DB: `tx writer: waits on an owner-held account row lock, then reads the account default the holder committed`. |
| 4 | Transaction writer rejects impersonation before writes | **Covered.** SETTINGS: `%s rejects an impersonated actor before any statement or audit`; SETTINGS-DB: `tx writer: an impersonated actor is rejected on the caller transaction with zero writes`. |
| 5 | Transaction writer refuses every archived-policy write | **Misworded.** SETTINGS: `%s refuses set_location_override on an archived location before any write`. APPLY-DB: `an archived target refuses setting an override scope but permits manual contractions and repeated receipts`. Archived contraction is intentional; do not add a blanket rejection test. |
| 6 | First location row seeds account defaults | **Covered.** SETTINGS: `%s seeds a first location dial write as manual with the other dial inherited (complete-disable contraction)`; SETTINGS-DB: `tx writer: a first dial write seeds manual + the inherited dial with one audit; a later dial write keeps untouched fields`. |
| 7 | One audit shares the transaction | **Covered.** SETTINGS: `the tx export runs every statement and the audit on the caller transaction without opening its own`; SETTINGS-DB: `tx writer: a caller throw after the writer returns rolls back both the policy row and its audit row`. |
| 8 | Three policy operations at contract version 1 | **Covered.** CATALOG: `catalog separates read, proposable, and capture kinds by type and exposes only model-visible operations to the prompt` and `invariants: every catalog operation declares a contract version, a label, an effect and a describer`. |
| 9 | Scope parseInput rejects invalid input | **Covered.** CATALOG: `policy inputs enforce their domains and refuse keys they do not own`. |
| 10 | Three describers show full before/after | **Covered.** CATALOG: `policy describeChange renders the full before and after, and explains a created row with its inherited values`. |
| 11 | Dial-only row creation is described as override creation | **Covered.** CATALOG title in #10 and CARDS: `a new manual location rule shows every dial, creation, veto wording and one-click Apply`. |
| 12 | Prompt lists policy operations and inputs | **Covered.** PROMPT: `the user envelope lists every operation the wire schema accepts, with exactly that schema input keys`. |
| 13 | OpenAI receives validator-derived Operator schema | **Covered with transport-adaptation caveat.** OPENAI: `%s: derived schemas on OpenAI then Anthropic; refusal + truncation stay billed` includes owner_operator and checks registered root keys, nonempty object fields, required fields, and strict objects. SCHEMA: `the model output schema converts to JSON Schema that meets the strict-provider object rules`. This is derived transport-schema coverage, not a mathematical proof that provider grammar and local Zod accept identical languages. |
| 14 | Anthropic receives validator-derived Operator schema | **Covered with transport-adaptation caveat.** OPENAI parameterized title in #13 exercises both real adapters with mocked SDKs. Anthropic converts UUID formatting constraints into descriptions while the original Zod validator still checks UUIDs. Reconcile as “derived registered schema reaches the adapter; original local validation remains authoritative,” not byte-identical schema equivalence. |
| 15 | Model has no count/approval/receipt fields | **Covered.** SCHEMA: `model output schema has no field for counts, approval, confirmation, or receipts`. |
| 16 | Policy tokens contain both row identities/absence and stamps | **Covered.** TOKEN: `compute: no locationRow property is the account shape and an absent sentinel is a targeted location`; `parser rejects a loose absent sentinel, a stamp-less present row, and missing or extra fields`. |
| 17 | Absent account and absent location scopes differ | **Covered.** TOKEN: `equality never crosses scopes, and account differs from location even when every row is absent`. |
| 18 | Policy Apply locks account before proposal | **Covered.** APPLY: `policy Apply locks the account row before the proposal row, reads policy state only after both, and writes one standard-confirmed dial`. |
| 19 | Wrong typed scope writes nothing | **Covered.** APPLY: `policy Apply leaves an expansion pending and writes nothing unless the typed scope matches byte for byte`; APPLY-DB #31 also snapshots persistent footprints for five mismatches. |
| 20 | Valid phrase maps to standard | **Covered.** APPLY title in #18 asserts the exact shared-writer input including `confirmationLevel: 'standard'`. |
| 21 | Unready expansion refuses, contraction succeeds | **Covered.** APPLY: `readiness blocks only the expansion; a contraction applies without reading readiness or a phrase`; APPLY-DB: `readiness rejects expansion while a contraction still commits`. |
| 22 | Wrong contract version refuses | **Covered.** APPLY: `applyProposal rejects a proposal whose contract_version is not the catalog's with contract_changed before any lock`. The actual title uses double quotes in source, so its apostrophe is unescaped. |
| 23 | Simulation uses publisher threshold and partitions counts | **Covered.** COUNT: `partitions a hand-counted 10-review table` plus `calls the shared threshold predicate for every non-imported review, including a null threshold`. |
| 24 | Cap two holds third qualifying review | **Covered.** COUNT: `holds the third qualifying review when the cap is 2 on one business/day`. |
| 25 | Null threshold yields no eligible reviews | **Covered.** COUNT: `classifies every review as manual when the threshold is null`. |
| 26 | Imported reviews excluded from eligible and held | **Covered.** COUNT: `excludes imported high ratings from every count and from the cap`. |
| 27 | Predicate called for every review in window | **Misworded.** COUNT: `calls the shared threshold predicate for every non-imported review, including a null threshold`. Imported reviews are intentionally excluded before the predicate; unknown origins never enter the simulator. |
| 28 | Simulator uses publisher SQL day expression | **Misworded ownership.** The pure simulator consumes server-provided day keys; READER owns SQL bucketing. READER: `bounds the cohort to [windowEnd - 30 days, windowEnd) and splits 23:59:59.999999 and 00:00:00 UTC into two days`; COUNT: `resets the cap on the next day and keeps each business cap independent`. |
| 29 | Empty 30-day cohort returns zeros and no days | **Covered at simulator boundary.** COUNT: `returns zeros for empty input`. READER's archived-location test also checks an empty cohort; WORKER's target-snapshot test uses zero included reviews. Do not claim the pure function performs the database's 30-day filtering. |
| 30 | Worker consequence and snapshot share one scoped read | **Misworded if “snapshot” means model Context snapshot.** WORKER: `worker stamps a policy proposal from the snapshot of its own target, not the turn location`; PROPOSALS: `buildProposalRows stamps a policy proposal from its STORED target snapshot, never the turn location or the model`; READER #61 covers the single statement. The server-only policy snapshot is separate from the model Context snapshot and may target account scope. |
| 31 | Apply recomputes old/new receipt counts | **Covered.** APPLY-DB: `exact account phrase applies once, with hand-counted consequences, retained veto, and no posting or cost` adds a live review after preparation, then asserts the recomputed before/after counts. APPLY #18 asserts both computations use the same pre-write snapshot. |
| 32 | Receipt counts previously granted veto windows | **Covered.** READER: `readRetainedVetoCount counts one latest grant per scoped auto-policy approval and locks only the audit rows`; APPLY-DB title in #31 verifies the receipt. It is an as-of count under the account lock; only audit rows receive extra row locks. |
| 33 | Expansion field and no plain Apply | **Covered.** CARDS: `pins account scope and requires the exact phrase, never a plain Apply`. |
| 34 | Contraction has one-click Apply | **Covered.** CARDS: `a new manual location rule shows every dial, creation, veto wording and one-click Apply`. |
| 35 | Expansions last and separated from contractions/facts | **Partial.** CARDS: `renders expansions once, after ordinary cards, text and unsupported requests` verifies expansion group membership/count and placement after text/unsupported. It renders an ordinary voice card but does not directly assert that card precedes the expansion group; no contraction card appears in this fixture. Add direct ordinary/fact/contraction order assertions to make the broad promise discriminating. |
| 36 | Screen has no Apply-all | **GAP in explicit assertion.** No `Apply.all` assertion found in the Operator suites. Add a negative accessible-control assertion to the mixed-card rendering case; no new production behavior is needed. |
| 37 | Scope consequence says eligible, never would-have-posted | **Partial.** CARDS #33 asserts `eligible to auto-post`; CATALOG #10 rejects `would have posted` in descriptions. No Console consequence test explicitly rejects that phrase. Add the negative rendering assertion to #33. |
| 38 | Veto card shows counts and fixed wait phrase | **Partial assertion coverage.** CARDS #34 asserts the exact wait phrase, all dials and Apply behavior, but does not assert the consequence eligible/held sentence in that veto fixture. Scope-card counts are covered separately. Add explicit counts to the veto-card test. |
| 39 | Cap card shows busiest day | **Covered.** CARDS: `cap cards show busiest day and policy receipts show actual old/new counts and retained drafts`. |
| 40 | Form-first stale; Apply-first form preserves serial order | **Partial; actual concurrency GAP.** APPLY-DB: `form write versus Apply: %s serializes account before proposal and makes the old token stale` covers same location, first override and parent-default variants, but the form owns the lock first in all three. Add the reverse order: hold Apply before commit, start the form writer on another connection, prove blocking, release Apply, and assert final policy/audit/receipt serial outcomes. |
| 41 | First proposal stales second on same scope | **Covered.** APPLY-DB: `two prepared proposals racing to create the first policy row commit exactly one receipt and audit` asserts one applied and one stale/not_pending; PROPOSALS: `markSiblingProposalsStale sweeps only the token domain its write moved` pins update scope. |
| 42 | Concurrent first-row Apply yields one row | **Covered.** APPLY-DB title in #41 asserts exactly one policy and audit. |
| 43 | Changed parent invalidates inheriting location | **Covered.** APPLY-DB parameterized title in #40 includes `parent default`; TOKEN: `a changed parent row invalidates both an inheriting and an overridden location`. |
| 44 | Ten reviews equal hand count | **Covered.** COUNT: `partitions a hand-counted 10-review table` (10 inputs, one imported excluded, total 9). |
| 45 | Repeated Apply returns receipt without writes | **Covered.** APPLY: `a repeat policy Apply returns the stored row and reads no policy state`; APPLY-DB #31 checks exact receipt and unchanged persistent footprint. |
| 46 | Keyed Operator case proposes requested scope | **Outside scan.** EVAL: `runs every structured task through the primary seam and the registered fallback (4 x 2)` uses the real case checks with mocked transports; the case is `owner-operator-widen-scope`. Its live result is in `docs/reviews/codex-owner-operator-run-c/evidence/live-structured.json`. A renamed EVAL title alone cannot satisfy the current gate. |
| 47 | Expansion field at 390/1440 | **Outside scan.** E2E: `e2e: policy expansion requires the exact scope, saves consequence counts and replays one receipt` loops both widths, asserts the field visible and captures screenshots. The test's existence is not browser-execution evidence; root owns those outcomes. Renaming a `.spec.ts` does not put it in this gate. |
| 48 | Registered schemas reach both providers; unstructured unchanged | **Covered across transport tests.** OPENAI: `%s: derived schemas on OpenAI then Anthropic; refusal + truncation stay billed` plus `sends an unstructured request byte-identical to the pre-schema mapping`; Anthropic's own adapter suite also pins its unstructured request. Keep the actual source parameterized title, not an expanded owner_operator title. |
| 49 | One live keyed case per structured task | **Outside scan / execution evidence.** `live-structured.json` records startedAt `2026-09-13T10:49:04.771Z`, 4 cases passed, 0 failed. EVAL #46 verifies task pairing/request bounds offline; a source title cannot prove that providers were called. Retain the live command/artifact requirement independently of title reconciliation. No live calls were made in this audit. |
| 50 | Account caps independent by location and UTC day | **Covered.** COUNT: `resets the cap on the next day and keeps each business cap independent`; READER: `account scope counts only confirmed-live reviews of active locations, caps each business independently and labels every exclusion`. |
| 51 | Account lock precedes reads and proposal lock | **Covered.** APPLY #18 has ordered call-log assertions; APPLY-DB #40 checks a real blocked query and takes the proposal lock `NOWAIT` while the form still holds the account lock. |
| 52 | Domain-isolated invalidation across conversations | **Partial.** PROPOSALS: `markSiblingProposalsStale sweeps only the token domain its write moved` asserts closed operation lists and location/account scope, but does not assert absence of a conversation predicate. APPLY-DB: `first dial-only override is manual, inherits the other dial, and preserves voice and other-location proposals` and #41 cover real untouched-domain and stale outcomes. No dedicated two-conversation live fixture was found. Add an account-default Apply with pending policy proposals in a second conversation and assert they become stale while voice proposals stay pending. |
| 53 | Live processReview marker; atomic importReview marker | **Covered across tests.** INGEST: `new review via %s records ingestion_origin=%s`; `importReview records the review_ingested run-spine step and completes the run`; `importReview does all of its work in exactly one transaction`. IMPORT-DB: `importReview stores the review against the live schema and returns new`. ORIGIN-DB: `attaching an external reply to an existing live review keeps its live marker and run` proves persisted live provenance. |
| 54 | Losing insert/content update never rewrites marker | **Covered.** INGEST: `a race loser whose content changed records review_updated with no origin marker`; `a race loser with unchanged content writes no step at all`; ORIGIN-DB title in #53. |
| 55 | BACKFILL imported; other explicit lane unknown; exclusions | **Covered across seams.** INGEST: `new review via %s records ingestion_origin=%s` and `the case table covers every origin lane`; READER #50 asserts exclusion counts. The reader fixture uses imported/unknown marker classes independently of calling the ingest path. |
| 56 | Preminted-id win only; import/live races preserve origin | **Covered.** ZERNIO: `a genuine insert records imported provenance under the billing account before the response write`; `a conflict returns the existing row and writes no provenance for it`. ORIGIN-DB: `a same-identity insert race keeps only the live winner marker`; `an answered import that genuinely inserts records imported under the billing account; a duplicate adds nothing`. |
| 57 | Billing account resolved from businesses | **Covered.** ZERNIO: `a genuine insert records imported provenance under the billing account before the response write`; ORIGIN-DB #56 verifies stored tenant account, distinct from provider account. |
| 58 | Foreign account/business/subject markers cannot qualify | **Covered.** READER #50 uses same-target-business/subject under a foreign account, wrong business, wrong subject, and foreign location fixtures; asserts the exact included review IDs. |
| 59 | Missing/unrecognized/conflicting origins become excludedUnknown | **Covered.** READER #50 includes no initial marker, `backfill` unrecognized marker, and mixed live/imported markers; asserts exactly 5 unknown exclusions. |
| 60 | Duplicate live markers cannot inflate counts/caps | **Covered.** READER #50 seeds two completed live markers for one review; asserts exact unique review IDs, total 7 and exact cap holds. |
| 61 | Origin filtering preserves detected_at bounds/day keys | **Covered, with boundary precision limit.** READER: `bounds the cohort to [windowEnd - 30 days, windowEnd) and splits 23:59:59.999999 and 00:00:00 UTC into two days`. It tests inside/outside the window and exact midnight adjacency; it does not seed a review exactly equal to the captured statement's start/end instant. No claim of exact endpoint equality coverage should be inferred from the title alone. |
| 62 | Unknown exclusions/window survive worker, Apply, Console even at zero | **Partial; zero-count rendering GAP.** WORKER #30 has `total: 0`, `excludedUnknown: 3`, the full window and equality assertions. APPLY-DB #31 checks nonzero cohort exclusions; CARDS #33/#39 and `location receipts show saved counts, retained-window time and remaining restrictions separately from the preview` check nonzero exclusions. No zero-included-count card/receipt fixture asserts unknown count plus consequence window; the Apply zero-cohort persistence case also lacks explicit exclusion/window assertions. Add these behavioral assertions. |
| 63 | Manual null override remains manual under active parent | **Covered.** CONTEXT: `a deliberate manual location override stays manual under an enabled account default, in the projection and the snapshot`; READER: `location scope: a manual row replaces the whole default, an inheritor stamps both rows, an archived target keeps its state with no cohort`. |

## Reconciliation recommendation

1. Preserve every acceptance obligation. For covered entries, reconcile to actual source test titles, consolidating repeated promises that share one test and splitting compound promises where several tests are necessary. Use source parameter placeholders (`%s`, `$seam`), not runtime interpolation. No comments or inert title strings.
2. Correct the locked-semantics wording in #5, #27, #28 and #30: archived scope-setting versus permitted contractions; non-imported simulator input; SQL reader owns day/window bucketing; server policy snapshot versus model Context snapshot. #13/#14 must acknowledge provider schema adaptations plus local validation.
3. Complete #40's reverse concurrency experiment, #52's cross-conversation invalidation case and the missing assertions in #35–38/#62 before reconciling those titles. These are existing production contracts, not scope additions.
4. Keep #46/#47/#49 in their proper eval/browser evidence requirements. Their existing files are outside the matcher; do not create a vacuous `src` test claiming live/browser execution. If these entries must remain literally in `tests_to_add`, the gate's search-surface mismatch is an explicit workflow issue to resolve through the authorized process, not evidence of 63 missing tests.

No production defect was established by this title audit. The strongest missing behavioral experiment is Apply-first/form-second contention. The most concrete UI gap is zero included reviews with nonzero unknown exclusions and preserved reporting-window metadata.

## Root reconciliation and closure

All 63 original acceptance obligations remain in the plan and this map. The intake now records the real source test titles, deduplicating overlapping coverage and splitting compound promises. The live eval and 390/1440 browser obligations remain explicit in the plan, verification commands, live-structured.json and browser-campaign.md; the gate cannot infer a live execution from a test title. No placeholder titles, inert comments or gate-search changes were added.

The identified gaps are closed by actual assertions: Apply-first concurrent form ordering; account-default invalidation across four separate conversations while voice stays pending; zero-included-review Apply persistence with a newly arrived unknown review; zero-count card/receipt windows, exclusions and independent timestamps; contraction/voice ordering, absence of Apply-all, prohibited posted wording and veto counts. Backend 13/13 and UI 38/38 pass after these additions. Misworded archived, predicate, UTC-bucket and snapshot descriptions are reconciled to the already locked contract, not newly expanded behavior.
