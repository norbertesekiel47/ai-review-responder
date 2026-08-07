# #677 Import offer — adversarial plan review, round 1

Primary answer: **yes**. T0's 28 titles can pass while the feature is still wrong. In particular, they do not prevent a POST from accepting the default `pending`/NULL-deadline row before an offer exists, the owner-facing reactivation path and hand-inserted jobs can still import without accepted Import consent, accept-then-reconnect can create two in-flight imports, the three-table read model has no live-Postgres proof, and the banner can be unreachable, have dead buttons, or misrender terminal outcomes.

Audit basis: clean working tree at `2731424c415c5df53ae87e72870f6e71851b107f`. This is a pre-implementation plan/eval audit; no product code was changed and no implementation validation suite was run.

## Missing failing tests

| Proposed test title | The wrong behavior it would catch | Which artifact demands it |
|---|---|---|
| `POST import-offer rejects a pending row with a NULL import_offer_expires_at as no_offer, leaves all consent columns unchanged, and enqueues nothing` | A direct POST before the subscribe+connect junction records `accepted` and imports even though no offer was created. Migration 100 gives new rows exactly `pending` + NULL deadline, while the planned `UPDATE` explicitly admits NULL. | Design D1/D9 and §3; plan T1 `no_offer` contract; migration 100:47-63 |
| `recordImportDecision rejects at the exact import_offer_expires_at boundary and leaves the row byte-identical` | Read-time derivation can use inclusive `<=` correctly while the write predicate accidentally admits equality. Titles 4 and 17 do not guarantee the live decision write is exercised at equality. | Design §5.3; intake edge case “at or after”; plan:145-147 |
| `two concurrent accept and decline transactions preserve the first committed terminal decision and the loser writes nothing` | A read-then-write implementation passes the sequential property test but overwrites `accepted` with `declined`, or vice versa, under racing tabs. | Intake F3 and edge case “racing tabs”; design §5.3 |
| `finalize-tx enqueues no initial import for declined or derived-expired consent` | Title 9 covers only pending; code could treat every non-pending state as eligible and import after No. | Design §§5.1-5.3; Import consent; D8 |
| `finalize-tx enqueues no initial import when accepted consent already has a completed backfill run` | A reconnect after a successful import runs a second import. Title 10 covers only the positive no-completed-run branch. | Design §5.1; plan:182-184 |
| `resumePrimaryBusinessBackfill creates an offer but enqueues no import when activation follows a pre-checkout connection and consent is pending` | The admin-connected-before-checkout case immediately imports instead of presenting the new offer. Titles 12 and 14 can pass independently without proving their conjunction. | Design §3 and §5.2; current `shared.ts:66-90` comment |
| `resumePrimaryBusinessBackfill enqueues nothing for pending and derived-expired offers` | Title 13 covers declined, but an expired pending row can still import. | Design §5.3; intake edge “owner never opens dashboard” |
| `resumePrimaryBusinessBackfill enqueues no initial import when an accepted run already completed` | The replacement loses the existing completed-run sentinel. | Design §5.1; `shared.ts:114-118` |
| `reactivateLocationTransaction enqueues no initial import for pending, declined, or derived-expired consent` | The third owner-facing product enqueue path remains unconditional and imports without Yes. Current insert is `archive-location-tx.ts:505-529`. | Design §5:143-150 and §5.3:207-209; ADR 0015 R2; D8 |
| `ZernioBackfillWorker no-op-completes hand-inserted jobs for pending, declined, and derived-expired consent without calling listReviews` | A manual/admin row or any missed enqueue seam fetches and stores reviews without accepted consent. All 28 titles can pass because #679 is deferred. | Design §5.3:189-201; Import consent glossary contract; invariant #2 defense in depth |
| `two concurrent accept POSTs commit one accepted transition and exactly one zernio_initial_backfill row` | Sequential duplicate tests pass while two requests race into two jobs. | Intake F3 and duplicate-POST edge case; invariant #2 |
| `accept followed by reconnect while its initial-backfill row is in flight leaves exactly one initial-backfill outbox row` | Acceptance inserts row 1; reconnect sees accepted + no completed run and inserts row 2. The proposed finalize predicate lacks Stripe's in-flight dedup. | Invariant #2; design §5.1; `shared.ts:145-150` precedent |
| `live DB: accept rolls back the decision when the job_outbox INSERT fails` | A mocked `sql.begin` assertion passes while acceptance commits without its import job. | Invariant #2; intake:29-31; plan's transaction claim |
| `live DB: late and already-answered POSTs leave decision, decision_at, expires_at, initial-backfill rows, and analytics rows unchanged` | The route returns 409/410 while an unconditional timestamp, outbox, or analytics write lands. Mocked outcome mapping cannot prove committed DB state. | Plan eval bar:97-106 and T4:238-240; F3 |
| `readImportConsent binds the requested business id and distinguishes no_offer, expired, and already_answered outcomes against live Postgres` | Caller mocks pass while the new module targets the wrong row or returns the wrong outcome. No T1 title names `readImportConsent` or the three zero-row classifications. | Invariant #8; plan T1 interface; plan's no-mocked-twin rationale |
| `readImportOfferView against live Postgres reports importing for an incomplete run with a positive partial imported_count, never imported success` | A mid-run failure with partial counts is shown as successful import. Route tests can mock the desired union without executing the join. | Design §7 “Import fails mid-run”; plan:212-227 |
| `readImportOfferView against live Postgres reports failed for a terminal non-completed outbox row, including when the run has partial counts` | The UI spins forever after the outbox dies because join/status precedence is wrong. | Intake edge:48; plan:223-227 |
| `readImportOfferView returns empty only when completed_at is non-null and imported_count is zero` | The count's DEFAULT 0 produces premature empty-success before the worker finishes or after failure. | Design §7 “Zero reviews”; migration 100:65-70; plan:218-220 |
| `readImportOfferView chooses the current location's latest relevant import row and ignores stale or foreign-account runs and outbox rows` | An old completed/failed row or another tenant's row wins the three-table join and leaks or lies about state. | Invariant #8; design §4 per-location model; plan's three-table read-model claim |
| `ImportOfferBanner posts Import my reviews, posts No thanks, and changes state only after a successful response` | The only two component tests pass even when both buttons are dead, reversed, or optimistically claim success after a failed POST. | Design §3 and intake user-visible behavior:21-24 |
| `ImportOfferBanner renders No recent reviews found rather than Imported 0 reviews for empty` | GET returns `empty` correctly but the component claims it imported zero reviews. | Design §7 zero-review row; locked terminal copy |
| `ImportOfferBanner replaces importing with failed and stops polling when the outbox becomes terminal failed` | The API reports failure correctly but the component keeps its spinner/refetch loop forever. | Intake edge:48; plan:251-254,267-273 |
| `ImportOfferBanner polls only while importing and announces each importing-to-terminal transition through LiveRegion` | Terminal states keep polling or are invisible to assistive technology. | Plan T5:251-277 |
| `DashboardOperationalContent renders ImportOfferBanner for the current location` | Isolated banner tests pass while the feature is never mounted, so owners cannot consent. | Plan:275; design §3; intake:19-20 |
| `switching location scope refetches and never reuses another location's offer, decision, or import status` | React Query cache reuse shows location A's consent/status on location B. The foreign-business POST title does not test GET caching or UI scope changes. | Design §4 and §7 multi-location row; invariant #8 |
| `add-location copies all three consent columns verbatim for accepted, live-pending, and expired-pending archived siblings` | Only declined is tested; accepted/pending timestamps can be reset or omitted while titles 25-26 pass. | Deviations D3:66-80; design §7 reconnect row |
| `add-location inherits from the most recently archived matching sibling in the same account and ignores older and foreign-account siblings` | A missing account predicate leaks consent across tenants, or an arbitrary older sibling wins. | Plan:161-164; invariant #8 |
| `add-location with a NULL google_place_id never inherits consent from an unrelated archived NULL-place row` | SQL that omits the non-NULL guard makes unrelated unresolved URL-mode locations share consent. | Plan:161-164; D3 same-place claim |
| `declined URL-mode place remains declined after Place ID resolution, re-add, and reconnect, with no offer or import row` | An archived row whose `google_place_id` remained NULL cannot be found by the proposed inheritance query, so No is resurrected. | D8; design §7 reconnect row; `add-location-tx.ts:263-279` |
| `declined archived canonical place remains byte-identically declined after re-add and reconnect, with no offer or import row` | Each unit seam passes separately while the composed lifecycle re-offers or imports. | D8; design §7 reconnect row |
| `live DB: an unanswered offer returns none at T+7d and no reconnect, activation, or reactivation path enqueues it` | The state helper derives expired but one caller still displays or imports it. | Design §7 “Owner never answers”; §5.3 |
| `declining Review import does not change live-ingest eligibility or suppress new-review drafts` | A too-broad consent gate turns No into “turn the product off,” contradicting the mandatory reassurance copy. | Intake edge:53/non-goal:14; design §3:103-110 |

Spec §7's fewer-than-100 and live-review dedupe rows already have direct regression titles in `ZernioBackfillWorker.test.ts:860-873` and `import-review.integration.test.ts:197-213`. Its zero-review producer is also covered at `ZernioBackfillWorker.test.ts:462-478`; the missing tests above are the read-model and UI half. Mid-run producer retryability is covered at `ZernioBackfillWorker.test.ts:360-386`, but not its consent/read-model composition.

## Cited-artifact check

| Citation | Exists? | Note |
|---|---:|---|
| Plan, intake, deviations, design, ADR | Yes | All five artifacts exist at the named paths. |
| Design §§3, 4, 5.1, 5.2, 5.3, 7 | Yes | Correct headings and meanings at design:87,117,152,165,173,269. |
| ADR 0015 R1/R2 | Yes | No-flag decision at ADR:42-47; binding #677-before/with-#676 ordering at ADR:49-56. |
| `CONTEXT.md` — Review import | Yes | Defined at CONTEXT:25; `importReview` exists at `process-review.ts:518`. |
| `CONTEXT.md` — Import consent | Partial | Term exists at CONTEXT:26, but it already claims the fail-closed worker guard that #679 has not implemented. `ZernioBackfillWorker` has no `import_decision`/`guardImportConsent` check today. |
| `CONTEXT.md` — Import window | Yes | Defined at CONTEXT:27; `selectImportWindow` exists at `ZernioBackfillWorker.ts:78`. |
| `CONTEXT.md` — Live-ingest cutoff | Yes | Defined at CONTEXT:28; `liveIngestCutoff` exists at `zernio-ingest-shared.ts:51`. |
| `CONTEXT.md` — Import offer | **No** | No glossary entry exists. Plan:71-73 incorrectly says all five terms already come from CONTEXT; plan:285-288 later acknowledges T6 must coin it. |
| Repo-law invariants #1, #2, #8, #12, #13, #15 and gotchas | Yes | All named invariants and the relevant outbox/DB/live-suite gotchas exist in `.claude/CLAUDE.md`. |
| `suppressionMatchSql` | Yes | Exported at `src/lib/solicitation/suppression.ts:75`; returns the claimed composable tagged-SQL fragment at :81-92. |
| `job-outbox-status.ts` in-flight set | Yes | `OUTBOX_IN_FLIGHT_STATUSES` exports the exact ordered set at :34. |
| Migration 100 | Yes | Consent columns at :47-50 and `imported_count`/`skipped_count` at :65-67. Its original CHECK was four-valued. |
| Migration 101 | Yes | Corrective three-valued CHECK at :32-39; migrations-log head is 101. |
| `zernio_backfill_runs.imported_count` worker write | Yes | `ZernioBackfillWorker.ts:376-383`, specifically :379. |
| `assertSchemaReady` | Yes | Exported at `schema-ready.ts:411`; `MIGRATION_100_IMPORT_CONSENT` lists all three consent columns and both counters at :389-400. |
| `describeWithDb` | Yes | Exported overloads/implementation at `describe-with-db.ts:31-41`. |
| `seedTenantAccount` / `cleanupTenantAccount` | Yes | Exported at `live-db-tenant.ts:43` and :75. |
| Migration-100 live-DB precedent | Yes | `migration-100-import-consent.integration.test.ts:83-92` uses the named helpers and does not apply migration SQL. |
| `fast-check` “invariants” block | Yes | Import at `sentiment.test.ts:1`; block and properties at :42-86. |
| `.github/workflows/ci.yml:118-133` | Yes | Those exact lines define `postgres:16` and `TEST_DATABASE_POOL_URL`; `pnpm test` runs at :147-148. |
| `ZernioInitialBackfillPayload` | Yes | Interface at `worker-types.ts:229-239`; `correlation_id` is inherited from `BasePayload`. `finalize-tx.ts:213-221` builds the required shape. |
| Typed helper for `ZERNIO_INITIAL_BACKFILL` | No, as claimed | No such helper exists in `job-outbox-helpers.ts`. Raw producers currently exist in finalize, Stripe resume, and reactivation, so current invariant #2 permits the raw insert. |
| `finalizeConnectionTx` | Yes | Exported with explicit SQL argument at `finalize-tx.ts:34-42`. |
| `needs_backfill` CTE | **No** | The behavior exists, but it is a plain `SELECT (...) AS needs_backfill` at `finalize-tx.ts:195-209`, not a CTE. Plan:21 and :177 misname the seam. |
| `#41` over-fire comment | Yes | Present at `finalize-tx.ts:187-194`. |
| `gbp_connected` analytics precedent | Yes | Same-transaction call at `finalize-tx.ts:167-178`. |
| `subscription_activated_at IS NULL` warning | Yes | Present at `finalize-tx.ts:234-240`. |
| `maybeEnqueueBackfillResume` | Yes | Module-private at `stripe/shared.ts:92`; target query establishes active connection, activated subscription, and no completed run at :95-120. |
| `resumePrimaryBusinessBackfill` | Yes | Exported at `stripe/shared.ts:173`; log-and-swallow boundary at :175-179. |
| `apply-subscription-state.ts` | Yes | Exists; it is the single subscription-state applier. |
| `addLocationTransaction` | Yes | Exported at `add-location-tx.ts:97`; transaction and business insert at :194 and :214-241. |
| `duplicate-place-id.integration.test.ts` ownership claim | **No — meaning misstated** | File exists, but it seeds one active row and tests a second active duplicate (:50-60,78-103). It does not already own an archived/active sibling inheritance shape as plan:51-53 claims. |
| `finalize-modules.test.ts` harness | Yes | `vi.hoisted`, `txCalls`, and `txScenario` exist at :18-24. |
| `add-location-tx.test.ts` harness | Yes | Hoisted `mockSql` exists at :14-20. |
| POST draft route precedent | Partial | `withSameOrigin`, scope resolution, and `sql.begin` exist, but it no longer performs a raw outbox insert: it calls typed `enqueueGenerateResponse` at `draft/route.ts:48,232-239`. Intake:58 misstates the precedent. |
| GET draft-status precedent | Yes | GET/CSRF note at :18-20, owner scope at :45-54, in-flight mapping at :95-101, and terminal fallthrough to failed at :138-143. |
| `ConnectGoogleBanner` | Yes | Exported at :20; self-nulls at :21 and uses the claimed banner/Icon vocabulary. |
| `DashboardContent` / `DashboardOperationalContent` / `useQuery` / `LiveRegion` | Yes | Imports/query at `DashboardContent.tsx:5,18,20,33-46`; operational component at :125; current Connect banner slot at :310-320. |
| Existing `importReview` live-DB convention | Yes | Header at `import-review.integration.test.ts:3-8` explicitly separates mocked bindings from live SQL execution. |
| Planned `import-consent.ts` | No, expected | Explicitly marked new; absent before implementation. |
| Planned `import-offer-view.ts` | No, expected | Explicitly marked new; absent before implementation. |
| Planned `ImportOfferBanner.tsx` | No, expected | Explicitly marked new; absent before implementation. |
| Planned import-offer API route and T0 test files | No, expected | Explicit T0/T4/T5 creation targets; absent before implementation. |
| Planned consent/view exports | No, expected | `IMPORT_OFFER_WINDOW_DAYS`, consent functions, and `readImportOfferView` are future interfaces, not current symbols. |
| Planned analytics names | No, expected | The registries exist, but `import_offer_created` and `import_decision_recorded` have not been added yet. |

## Plan-level findings

| Severity | Location | Finding | Recommendation |
|---|---|---|---|
| Critical | T1 `recordImportDecision`; plan:136-139 | The proposed atomic predicate treats NULL deadline as answerable. Every business defaults to `pending` with NULL deadline before an offer exists, so a direct POST can manufacture accepted consent and enqueue the import. This also makes the advertised `no_offer` outcome unreachable for an existing default row. | Require `import_offer_expires_at IS NOT NULL AND import_offer_expires_at > now()` in the guarded `UPDATE`; classify pending+NULL as `no_offer`; add the first missing test above. |
| High | T3 finalize | `accepted AND NOT EXISTS(completed run)` has no in-flight outbox dedup. Acceptance followed by reconnect can insert two `zernio_initial_backfill` rows. The worker run-row conflict is only a second-line execution guard and does not meet the one-row contract. | Add atomic in-flight dedup matching `('pending','dispatching','dispatched')`, or a partial unique index, at every producer. |
| High | T3 / merge ordering | #677 leaves `reactivateLocationTransaction` un-gated at `archive-location-tx.ts:489-529`. This is an owner-facing route, not merely a manual admin seam. Deviations D1:31-37 is factually wrong that only hand-inserts remain after #677. | Gate reactivation in #677, or land #679/#676 atomically with #677. At minimum the authoritative worker fail-closed gate must precede any state advertised as coherent. |
| High | T2 / D3 | Verbatim inheritance is correct only when a canonical non-NULL `google_place_id` already exists on both lineage rows. URL-mode rows intentionally start NULL; an archived declined/expired row can therefore be missed and re-offered after re-add. | Define durable same-place lineage across Place-ID resolution, reconcile consent in the resolver, or reactivate/reuse the archived row instead of creating a new row. |
| Medium | T2 / D3 | `ORDER BY archived_at DESC LIMIT 1` is nondeterministic when timestamps tie, and titles 25-26 do not prove the account predicate. | Add a deterministic tie-breaker (`created_at`, then `id`) and live sibling-decoy/cross-account tests. |
| High | T3 Stripe reliability | Offer creation after activation is swallowed by `resumePrimaryBusinessBackfill`'s best-effort boundary. A transient failure is ACKed after activation and may never see another junction event; the owner can permanently receive no offer. “Same reliability class” understates the new user-visible loss. | Create the offer in the activation transaction, or enqueue a durable retryable junction-reconciliation job in that transaction. |
| Medium | T3 Stripe flag seam | `maybeEnqueueBackfillResume` currently returns before all work when `ZERNIO_PUBLISHING_ENABLED` is off. If offer creation stays behind that early return, an unflagged Import offer is silently skipped with no replay when the kill switch returns. | Put durable offer creation before the enqueue kill switch, or specify and test a recovery path. |
| Medium | T3 Stripe transaction shape | `createImportOffer` requires `TransactionSql`, but the current resume path uses root `sql` and no transaction. The plan does not explicitly add a secondary transaction spanning offer, analytics, consent read, and deduped enqueue. | Spell out one best-effort secondary `sql.begin` transaction, or move the durable junction fact to the activation transaction. |
| High | T4 test placement | `readImportOfferView` is a new three-table SQL module, yet all GET tests are planned as mocked route tests. Its SQL can be invalid, cross-tenant, choose stale rows, or apply wrong precedence while every title passes. | Add a live-DB `import-offer-view.integration.test.ts` covering pending, partial/in-flight, positive complete, zero complete, failed, stale-row ordering, and tenant isolation. |
| High | T4 route atomicity | Mocked route tests cannot prove consent+outbox rollback or byte-identical rejected states. The plan's own eval bar demands database state, not response codes, but places the route suite in the mocked bucket. | Extract a domain transaction function and live-test committed state, concurrent decisions, duplicate accept, rejected writes, and forced outbox failure. |
| High | T5 eval | Titles 27-28 cover only copy and self-null. They do not cover button wiring, mutation failures, terminal states, polling, LiveRegion, dashboard mounting, or location-scope cache keys. The entire UI can be nonfunctional or unreachable while T0 is green. | Add the interaction, terminal, polling, accessibility, dashboard-wiring, and scope-switch titles above. |
| Medium | T1 no-mocked-twin rationale | Caller mocks prove only how callers invoke mocked exports; they do not prove `readImportConsent` binding, no-row classification, or fragment composition. The eight live titles do not name these cases. | Keep one live suite if preferred, but add explicit business isolation, NULL/no-offer, outcome, and composition tests; narrow the rationale. |
| Medium | T4 architecture claim | The plan says routes “parse, call one module, map,” but also assigns `sql.begin`, the transition, raw outbox insert, and analytics enqueue directly to the route. That is internally inconsistent with invariant #12's thin-entry-point posture. | Put the acceptance/decline transaction in a domain module that receives `sql`; let the route validate, call it once, and map the result. |
| Medium | Schema readiness | `MIGRATION_100_IMPORT_CONSENT` proves the columns and a constraint name, but cannot distinguish migration 100's four-valued CHECK from migration 101's replacement because the name is unchanged. A local DB stopped at 100 can pass the helper. | Add a migration-101 requirement that inspects the actual CHECK definition, or make the consent suite assert the three-valued constraint shape explicitly. |
| Confirmed | T3 old predicate attack | Deleting the old `needs_backfill` SELECT does not itself lose the connected-before-checkout case. Under the new product, activation should create a pending offer instead of immediately importing; the real risk is unreliable offer creation. | Do not restore the old predicate; fix durability and add the conjunctive pending-offer test. |
| Confirmed | `createImportOffer` idempotency | Once a canonical declined row is successfully inherited, “update only pending+NULL” is row-idempotent and will not resurrect it. The failure is place-lineage inheritance, not the row-local transition. | Describe the guarantee as row-local and fix the NULL-place lineage gap. |
| Confirmed | Invariant #2 helper seam | No helper owns `ZERNIO_INITIAL_BACKFILL`; a raw insert is currently legal and `ci:outbox-seam` will not fail merely for using it. | Keep raw SQL unless all producers migrate together; still add in-flight dedup. |

## Low-confidence appendix

- **75%:** the read model will need an explicit rule for multiple historical outbox rows (latest attempt versus any failed versus completed run). The plan gives status precedence but not row-selection precedence; implementation could resolve this cleanly, so this is framed as a required test rather than a definite design defect.
- **65%:** copying `accepted` from an archived business row to a newly inserted business row may cause a second place-level import into a new per-business inventory. D3 explicitly accepts this behavior, so changing it requires a product decision about whether “one-time” is per business row, place lineage, or account-place pair.

VERDICT: REVISE
Reasons: T0 misses multiple feature-defeating paths; the decision predicate admits acceptance without an offer; owner reactivation and manual jobs can import without accepted consent; finalize can enqueue duplicates; the activation-second offer is not durably recoverable; and the live SQL/UI seams are insufficiently tested.
