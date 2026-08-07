# Review — spec & correctness axis (round 1)

> **Orchestrator triage (2026-08-07): 3 of 3 findings ACCEPTED. Table at the end of this file.**

**Ticket:** #679 · **Branch:** `feat-679-import-consent-worker-guard` · **Diff:** `2f369582..HEAD`
**Question:** does the diff faithfully implement the intake contract and the plan's tickets?
**Method:** field-by-field against `docs/superpowers/plans/feat-679-import-consent-worker-guard-intake.json`, read against the files (not from memory). Read-only; no source edited.

---

## Findings

| Severity | file:line | Finding |
|---|---|---|
| Medium | `supabase/migrations/102_import_consent_analytics_events.sql:22-25` | Deploy-ordering hazard is stated as "rolls back a legitimate owner Import consent decision"; the real worst case is the Zernio **connect** transaction rolling back, so no owner can connect a Google Business Profile. Same understatement in `.claude/reference/migrations-log.md` (102 entry), `src/lib/reviews/import-consent.ts:47-53`, `docs/analytics/events.md:279,291`, plan §6. |
| Low | `src/lib/reviews/import-consent.ts:34-38` | New module header names `add-location-tx.ts` as one of `createImportOffer`'s three producers. It neither imports nor calls it; the real third producer is `worker/ingress/stripe/shared.ts:159`. |
| Low | `src/app/api/dashboard/import-offer/__tests__/route.test.ts:322` | The guard's insertion shifted `ZernioBackfillWorker.ts` by +31 lines and `job-eligibility.ts` by +21; seven `file.ts:NNN` cross-references in the repo now point at the wrong lines. This one is inside `allowed_edit_surface`. |

Nothing above blocks the merge on its own; all three are accuracy defects in prose the diff introduced or invalidated.

---

## 1. `user_visible_behavior` — 6 of 6 delivered

| # | Behaviour | Verdict | Evidence |
|---|---|---|---|
| 1 | Non-`accepted` job imports nothing: outbox completes as a skip, no Zernio call, no `zernio_backfill_runs` row | **PASS** | `ZernioBackfillWorker.ts:160-168` returns before the run INSERT at 179-203. Tested: *"writes no zernio_backfill_runs row…"*, *"makes no Zernio API call…"*, *"leaves completed_at untouched…"* |
| 2 | Hand-inserted outbox row refused on the same predicate (D8 made true) | **PASS** | Single consumer of `ZERNIO_INITIAL_BACKFILL` is `worker/index.ts:224-225` → `handleZernioBackfill`; guard is unconditional. Tested: *"blocks a hand-inserted outbox row for a pending business"* |
| 3 | `accepted` still imports after the 7-day deadline | **PASS** | `importConsentStateSql` derives `'expired'` only for `pending` (`import-consent.ts:147-153`). Tested: *"proceeds for an accepted business whose offer deadline has passed"* (also asserts `sqlCalls` length 1, so a JS-side deadline re-check would fail) |
| 4 | Accepted-but-never-completed stays retryable | **PASS** | Guard predicate is on the consent record only; `completed_at` untouched on every skip path. 30+ pre-existing backfill tests run through `pushImportSqlSetup` with `completed_at: null` and still import |
| 5 | Runbook A5 conditioned on accepted consent | **PASS** | `runbook/page.tsx:107`; pinned by `runbook-import-consent.test.ts` on `firstCheck` **and** `fix`, incl. the D8 permanence wording |
| 6 | PostHog receives both events | **PASS** | `import-consent.ts:259-266` / `356-363`; registered in `ANALYTICS_EVENT_NAMES` and in migration 102's CHECK |

**No scope drift.** Every behaviour change in the diff maps to one of the six. The only non-listed edits are documentation (`worker-types.ts` producer JSDoc, `import-offer/route.ts` header, the two guard-ordering JSDoc blocks) and tests — all named by plan T5/T0 or accepted deviations D14/D18/D19/D22.

**No surface drift.** All 28 changed paths match an `allowed_edit_surface` glob. Checked exhaustively; `supabase/migrations/` contains exactly the one permitted file.

---

## 2. Invariants — all hold

| Invariant | Verdict | Evidence |
|---|---|---|
| #2 transactional outbox — guard completes only, enqueues nothing | **PASS** | `job-eligibility.ts:185-202`: one SELECT + `markOutboxCompleted`. No INSERT. `pnpm ci:outbox-seam` passes (15 helper-owned topics), `ci:outbox-status` unaffected |
| #8 tenant scope | **PASS** | `b.id` alone, mirroring `guardZernioJobEligibility:85`. `pnpm ci:tenant-scope` → **414 entries, baseline 414** — no new allowlist entry, as the intake promised |
| #15 explicit DB client | **PASS** | `guardImportConsent(sql: Sql, …)`; `pnpm ci:db-imports` passes strict |
| Spec §5.3 fail-closed — proceeds only on `'accepted'` | **PASS** | `job-eligibility.ts:193`. `declined`/`expired`/`pending`/missing all fall through to skip |
| Spec §5.1 — declined/expired permanent, accepted-incomplete retryable | **PASS** | Predicate reads the consent record, never run existence. See §4 below for the retryability walk-through |
| One owner for the derivation | **PASS** | `importConsentStateSql(tx)` imported, not re-spelled. Pinned by *"derives expiry from Postgres now()…"*, which compares the rendered SQL against the fragment's own text — an assertion a retyped copy cannot satisfy |
| Postgres `now()`, never a JS Date | **PASS** | Same test asserts no bound value `instanceof Date` |
| Live ingest structurally independent | **PASS** | Separate exported function, one caller. Ingest suite partial-mocks only `guardImportConsent` and asserts it is never called **and** that no query text contains `import_decision` |
| Skip-as-success | **PASS** | `markOutboxCompleted`; never `markOutboxFailed`, never throws. Asserted in *"writes no zernio_backfill_runs row…"* |
| Events durable, in `ANALYTICS_EVENT_NAMES`, emitted in-transaction | **PASS** | `events.ts:28-29`; D14's negative-loop addition pins them out of `CLIENT_ENQUEUEABLE_EVENT_NAMES` (nothing in the types enforces that) |
| Migration 102 is the real registration | **PASS** | See §5 |

---

## 3. The fail-closed guard — is there any path to the import that skips it?

Attacked all six vectors named in the brief.

1. **Both `backfill_reason` values.** The guard sits at `ZernioBackfillWorker.ts:160`, *above* the `isReactivationBackfill` branch at 170. Neither lane can reach the run INSERT without it. Tested both directions in *"gates a reactivation backfill on accepted consent"* — declined blocks, then `resetHarnessForNextRun()` + accepted runs the catch-up through its correlation-keyed claim.
2. **Retries.** BullMQ re-invokes `handleZernioBackfill` from the top; the guard re-reads consent every attempt. No memoization, no early-exit cache.
3. **`completed_at` short-circuit.** At 223-227, *below* the guard. An already-completed run whose consent is not `accepted` exits via the consent block, which is the intake's stated behaviour.
4. **`isSubscriptionTier` throw at 135-137.** Precedes the guard — the owner-approved carve-out. No import occurs on that path either; only the outbox disposition differs. Pinned by *"throws on an unsupported tier before reaching the consent guard"*, which additionally asserts `sqlCalls` is empty and `mockSql.begin` was never called, so a reorder is a red test.
5. **Hand-inserted `job_outbox` row.** The only dispatcher is the OutboxPoller → the one BullMQ registration at `worker/index.ts:224`. `rg` over every non-test reference to `ZERNIO_INITIAL_BACKFILL` confirms no second consumer, no admin route, no script that performs the import directly.
6. **Producers.** All four still gate at enqueue time (`enqueueInitialImport` ×3 plus `archive-location-tx.ts:539-545`, verified to require `reactivationConsent?.state === 'accepted'`), so the worker guard is defence-in-depth as designed rather than the only gate.

**Verdict: no bypass found.**

---

## 4. Spec §5.1 retryability — preserved

The failure mode a bad guard would introduce is blocking a legitimate recovery. Walked it:

- `accepted` + `completed_at IS NULL` → guard returns `proceed`, worker re-enters the same run row idempotently (`ON CONFLICT … DO NOTHING` + the `completed_at` sentinel). Unchanged.
- Every skip path leaves `zernio_backfill_runs` entirely unwritten (the guard runs before the INSERT), so a skip can never consume the sentinel. Asserted by *"leaves completed_at untouched when consent blocks the run"* via `findCompletedAtUpdates()` and `findImportCountsCalls()`.
- The **lost-import race** (intake edge case 16) is the one way an accepted import could become unrecoverable, and it is closed by serialization: `sql.begin` + `SELECT … FOR UPDATE` on `businesses` + in-transaction `markOutboxCompleted`, business-before-outbox — the same order `recordImportDecisionAndEnqueue:315-321`, `archive-location-tx`, and `stripe/shared.ts:117-124` use. I checked for a lock cycle: the OutboxPoller takes `job_outbox` locks and never touches `businesses`, so no counter-ordered holder exists.
- The race is genuinely pinned, not merely covered. D16 honestly reports that the original `Promise.all` harness could not fail; D21's replacement forces the interleaving on three labelled sessions and is mutation-tested in **both** directions (drop `FOR UPDATE`; split the transaction) with the invariant — *0 runnable rows* — failing first and the `acceptanceWasBlockedByTheGuard` tripwire second. `git diff worker/jobs/zernio/job-eligibility.ts` was empty after the mutation runs. This is the strongest single artifact on the branch.

---

## 5. Migration 102

- **Strict superset of 097, in order:** 097's 23 names appear verbatim in the same sequence at `102_….sql:48-70`, with the two new names appended at 71-72. Diffed both files directly; no member dropped, no reordering. `migration 102 keeps every event name from migration 097 in the CHECK` asserts exactly this with `slice(0, previous.length)` equality — the assertion shape that catches retyping.
- **Rejection is proved live**, not inferred from superset+subset: a bogus name inside a rolled-back `sql.begin`, asserted on SQLSTATE `23514`. This was the round-1 restored title and it earns its place.
- **Drift guard handed off correctly.** 097's suite drops the live `ANALYTICS_EVENT_NAMES` check and re-pins its own immutable 23-name list; 102's suite picks the guard up. Matches the stated 089 → 094 → 097 precedent. `pnpm ci:analytics-events` passes.
- **Live-DB conventions honoured:** `*.integration.test.ts`, `describeWithDb`, no run-time DDL. `pnpm ci:live-db-suites` passes.
- **Constraint-only, no `SchemaRequirement`** — consistent with 094/097 and correctly justified in the migrations-log entry.

---

## 6. The two analytics emissions

| Property | Verdict | Evidence |
|---|---|---|
| `import_offer_created` fires only on genuine creation | **PASS** | `import-consent.ts:249` returns `'unchanged'` before the emission. Tested live in *"records no analytics event when the offer already exists"* |
| `import_decision_recorded` fires only on a recorded decision | **PASS** | Emission at 356 sits after the zero-rows classifier returns at 341-346. Tested across **all three** rejection classes (`no_offer`, `expired`, `already_answered`) |
| Both on the transaction handle, never the outer `sql` | **PASS** | `enqueueAnalyticsEvent(tx, …)` at both sites. Pinned behaviourally by *"rolls back import_decision_recorded when the decision transaction aborts"*, which D20 mutation-verified goes red |
| No path emits twice | **PASS** | `ON CONFLICT (event_key) DO NOTHING` with business-scoped keys; both replay titles force a second write and assert the count stays 1 and the key is identical |
| Decline counted | **PASS** | Emission precedes the `decision === 'declined'` early return at 365 — deliberate and tested. D20's warning against moving the emission after `enqueueInitialImport` is correct and worth preserving |

One structural note: `enqueueAnalyticsEvent` inserts a row carrying `business_id`, whose FK takes `FOR KEY SHARE` on the `businesses` row the enclosing transaction already holds `FOR UPDATE`. Same transaction, so no self-block — but this is exactly why the `tx`→`sql` regression **hangs** rather than silently commits (D20). The header documents the rule; it does not document that failure signature. Appendix item.

---

## 7. Edge cases — 17 of 17 handled; 16 directly tested

| Edge case | Handled | Tested |
|---|---|---|
| Business row missing → blocked, completed, logged | ✅ | ✅ unit + worker (`{ reason: 'missing' }`) |
| `pending` + NULL deadline | ✅ | ✅ (also asserts the `IS NOT NULL` arm is in the SQL) |
| `pending` + future deadline | ✅ | ✅ |
| `pending` + deadline == `now()` (inclusive `<=`) | ✅ | ✅ *by the predicate's owner* — `import-consent.integration.test.ts:299` *"evaluates the deadline with Postgres now at the inclusive boundary"*. The guard consumes the fragment, so this is the right place for it |
| `accepted` + past deadline → proceeds | ✅ | ✅ |
| `reactivation` gated identically | ✅ | ✅ both directions |
| Guard before the run INSERT | ✅ | ✅ ordering asserted on `sqlCalls` indices **and** `consentIndex === 0` |
| Already-completed run + declined consent | ✅ *by construction* | ⚠️ no dedicated title — see appendix |
| `createImportOffer` `'unchanged'` emits nothing | ✅ | ✅ |
| Rejected decision emits nothing | ✅ | ✅ ×3 classes |
| Business-scoped keys drop replays | ✅ | ✅ ×2 |
| 102 ⊃ 097 in order | ✅ | ✅ |
| Deploy ordering | ✅ | n/a — see Finding 1 |
| Lost-import race | ✅ | ✅ forced + mutation-tested |
| Malformed-payload carve-out | ✅ | ✅ |
| `subscription_status=missing` unreachable for backfill | ✅ | ✅ rewritten test asserts the new authority **and** the absence of the dead line |

---

## 8. `tests_to_add` — 38 of 38 present, and meaningful

Every title matched verbatim against the changed test files by script; zero misses. I then read each new/rewritten suite for vacuity. No title asserts nothing. Three are worth calling out as unusually load-bearing:

- *"…completes the outbox row inside the same transaction as its consent read"* — the only assertion that goes red when serialization is removed (D16). `beforeEach` uses `vi.clearAllMocks()` rather than `resetAllMocks()` specifically so the `inTransaction` recorder survives; the file says so.
- *"…scopes the derived-state SELECT to b.id = businessId"* — asserts the predicate text **and** the bound value, and that the *default* business id is absent. Every other state test passes against an unscoped query.
- *"…rolls back import_decision_recorded when the decision transaction aborts"* — mutation-verified red.

The six D12 titles that pass at T0 are honestly enumerated as regression pins rather than counted as wins.

**Blast-radius callers checked against changed semantics** (typecheck cannot catch these):
- `guardZernioJobEligibility` — signature and behaviour unchanged; the only semantic delta is that its backfill row-missing branch is now unreachable, which both JSDoc blocks state and the rewritten test asserts. Its other caller (`ZernioReviewIngestWorker`) still reaches the branch and is untouched.
- `createImportOffer` — all three real callers (`finalize-tx.ts:208`, `stripe/shared.ts:159`, `import-offer/route.ts:103`) already run inside a transaction holding the `businesses` row lock, so the new in-transaction INSERT is safe at every one. Return type unchanged.
- `recordImportDecisionAndEnqueue` — single caller (`import-offer/route.ts:176`); outcome enum unchanged.
- `ZernioInitialBackfillPayload` (112 importers) — JSDoc only, no shape change.

---

## Finding detail

### Medium — the deploy-ordering consequence is materially understated
`supabase/migrations/102_import_consent_analytics_events.sql:22-25`

The **instruction** ("apply 102 before the emitting code, staging then prod") is correct and repeated consistently. The **stated consequence** is not. Four places say the cost is the metric or the owner's answer:

- migration header:22-25 — *"turns every Import offer mint and every owner Import decision into a rolled-back transaction"*
- `.claude/reference/migrations-log.md` 102 entry — *"the answer would be lost, not just the metric"*
- `src/lib/reviews/import-consent.ts:47-53` — *"rolls back a legitimate owner Import consent decision — losing the answer, not just the metric"*
- `docs/analytics/events.md:279,291` and plan §6

Because the emission now lives inside `createImportOffer`, an un-migrated project fails at three call sites, and the worst is not the decision:

1. `src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts:208` — inside `finalizeConnectionTx`. A `23514` rolls the whole finalize back; `select-location/route.ts:99-109` routes it to `recoverFromFinalizeTxFailure`, which rethrows anything that is not a `23505`. **Result: no owner with an activated subscription can complete a Google Business Profile connection.** That is a full onboarding outage, not a lost metric.
2. `src/app/api/dashboard/import-offer/route.ts:103` — `selfHealImportOffer` throws inside the GET `try`, so the handler returns **500 on every import-offer poll** for any location in the `pending` + NULL-deadline state, i.e. exactly the population the banner serves.
3. `worker/ingress/stripe/shared.ts:159` — swallowed by `resumePrimaryBusinessBackfill`, so the activation-junction offer *and* enqueue silently never happen. Silent failure, no alert.

Concrete scenario: promote the app to prod before applying 102 (the exact slip the docs exist to prevent) → the first owner to finish Zernio connect gets a hard failure with orphan recovery, and ops reading migration 102's header believes the worst case is a missing analytics row. Fix is prose only: state the real blast radius (connect outage + banner 500 + silent Stripe-path no-op) in the migration header and the migrations-log entry, and mirror it in plan §6 step 5.

### Low — module header names a `createImportOffer` producer that does not exist
`src/lib/reviews/import-consent.ts:34-38`

> *"…because `createImportOffer` has three producers (`finalize-tx.ts`, `add-location-tx.ts`, and the GET self-heal in `src/app/api/dashboard/import-offer/route.ts`)"*

`src/lib/locations/add-location-tx.ts` neither imports nor calls `createImportOffer` — `rg 'import-consent' src/lib/locations/add-location-tx.ts` returns nothing; the two hits for the symbol are prose in the consent-inheritance comment at 254 and 265. The actual second producer is `worker/ingress/stripe/shared.ts:159`. The count (three) is right; the enumeration is wrong, and it is the same mis-enumeration that produced the Medium above. Ironically, `src/lib/shared/worker-types.ts:226-236` — edited in this same diff — gets the producer list exactly right for the *enqueue* path, so the two headers now disagree about who the Import-offer producers are.

### Low — seven line-number cross-references invalidated
`src/app/api/dashboard/import-offer/__tests__/route.test.ts:322` (in surface) + 6 out of surface

Inserting the guard moved `ZernioBackfillWorker.ts`'s `ON CONFLICT (business_id)` from **170 → 201** and its `SET imported_count =` from **379 → 416**; appending the guard moved `job-eligibility.ts`'s eligibility SELECT from **61 → 82** and its `archived_at` branch from **75 → 96**. Stale citations:

| Citation | Site | Now |
|---|---|---|
| `ZernioBackfillWorker.ts:170` | `src/lib/locations/archive-location-tx.ts:528`, `…/__tests__/archive-location-tx.test.ts:1147` | 201 |
| `ZernioBackfillWorker.ts:379` | `src/lib/reviews/import-offer-view.ts:128`, `…/__tests__/import-offer-view.integration.test.ts:17,151`, `src/app/api/dashboard/import-offer/__tests__/route.test.ts:322` | 416 |
| `job-eligibility.ts:60-81` | `src/lib/locations/archive-location-tx.ts:532`, `…/__tests__/archive-location-tx.test.ts:1152,1241` | ~81-103 |

CLAUDE.md's working rules ask for cross-references to be cleaned in the same change. One of the seven is inside `allowed_edit_surface` and could be fixed here; the other six belong on the post-merge sweep alongside the already-recorded `.claude/CLAUDE.md` "ADR 0015 R2" and spec §5 three-producer corrections.

---

## Low-confidence appendix (NOT findings)

- **`already-completed run + non-accepted consent` has no dedicated test.** Intake edge case 8. It is unreachable-by-construction (the guard runs before any run read, so run state cannot influence the outcome) and the `declined` worker test already asserts the guard fires with no run row queued. Adding a title would pin ordering that `consentIndex === 0` already pins. Noted only for completeness.
- **The self-heal analytics test reproduces the route's transaction rather than invoking the route** (`route.integration.test.ts:262-296`), because `route.ts` binds the `sql` singleton at module scope. Same constraint as the pre-existing `finalizeLikeProducer` in that suite. It therefore cannot catch the route *removing* its `createImportOffer` call — that is covered by the unit `route.test.ts`. Acceptable, but the coupling is worth knowing.
- **The guard costs one extra transaction + `businesses` row lock per redundant job**, including jobs that would have exited on the `completed_at` sentinel one statement later. Bounded and almost certainly irrelevant at current volume; flagging only because the lock is exclusive and the same row is contended by the decision POST and the 4s banner poll.
- **`import-consent.integration.test.ts` performs run-time DDL** (`ALTER TABLE job_outbox ADD/DROP CONSTRAINT`) to force the abort, and on timeout strands the constraint across the shared container (D20 saw 14 spurious failures). The orchestrator's read-back already routed this to the standards axis; not re-reported.
- **The `tx`→`sql` regression hangs rather than commits** (D20's FK / `FOR KEY SHARE` discovery). The header documents the *rule* but not this *signature*; a future engineer will see "Test timed out in 30000ms". A one-line addition to the header would be cheap. Not a defect in the shipped behaviour.
- **`archive-location-tx.ts:528` also predates the guard's insertion in a second way**: it describes the worker's dedup as living at a line that is now the reactivation INSERT's `ON CONFLICT (correlation_id)`. Content, not just number, now reads misleadingly. Same post-merge sweep.

---

**VERDICT: PASS** — the diff faithfully implements the intake contract and the plan's tickets. All six `user_visible_behavior` items are delivered, all eleven invariants hold (three verified by running the CI audits), all seventeen `edge_cases` are handled, and all thirty-eight `tests_to_add` titles are present and non-vacuous. No scope drift, no surface drift, no bypass of the fail-closed guard. The three findings are prose-accuracy defects, one of which (deploy-ordering blast radius) materially affects an operator decision on a high-risk lane and should be corrected before the staging ride.

---

## Orchestrator triage — 2026-08-07 (branch review round 1)

| Finding | Verdict | Disposition |
|---|---|---|
| Medium — deploy-ordering hazard understated (`102_….sql:22-25` + 5 further sites) | **ACCEPT** | Verified independently: `finalizeConnectionTx` calls `createImportOffer` at `finalize-tx.ts:208`, and `select-location/route.ts:97-108` rethrows anything but `23505` — so an unapplied migration 102 fails **GBP connect entirely**, not just a consent decision. The **adversarial axis rated the same issue High**; that convergence is what escalated it. The remedy goes beyond prose: both emissions are now savepoint-wrapped so the failure cannot reach the parent transaction, and the docs are rewritten to describe the shipped post-savepoint behaviour rather than a hazard that no longer applies. |
| Low — module header names `add-location-tx.ts` as a `createImportOffer` producer | **ACCEPT** | Confirmed — that file only *mentions* the symbol in comments. **This error was mine**: my T2 brief listed the wrong producer and it propagated into the module header. Real third producer is `worker/ingress/stripe/shared.ts:159`; all three call sites re-verified. |
| Low — stale `file.ts:NNN` cross-references after guard insertion | **ACCEPT, split** | The one inside `allowed_edit_surface` is fixed here; the other six ride the post-merge documentation sweep, consistent with how the spec's own three-vs-four producer drift (deviation D8) is handled. |

**Net: 3 of 3 accepted.** Nothing rejected. Only the Medium touches operator behaviour on the high-risk lane, and it is now fixed in code rather than only in prose.
