# Review round 3 — spec & correctness axis (#679)

**Scope:** one commit, `4c4e9df9`. Base `main@2f369582`; round-2 review commit `3b7e0404`.
**Mode:** verification-only, last round. Live-DB lock held by this axis.

---

## 1. Verification table

| # | item | status | evidence |
|---|---|---|---|
| 1a | Title `createImportOffer keeps the caller transaction usable when the emission fails` exists and passes | **LANDED** | `src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts:592`; suite 10/10 green |
| 1b | Title `recordImportDecisionAndEnqueue commits the decision and still enqueues when the emission fails` exists and passes | **LANDED** | `src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts:641`; suite 10/10 green |
| 1c | Both titles genuinely PIN — go RED when the savepoint is deleted (mutation reproduced, not trusted) | **LANDED** | Mutation A: `import-consent.ts:482` → `await enqueueAnalyticsEvent(tx, input);` ⇒ **2 failed / 8 passed**, and the two failures are exactly these two titles. Restored. |
| 1d | The `23514` injection is real, not decorative — it actually fires | **LANDED** | Baseline run emits the production warn twice with `violates check constraint "analytics_events_event_name_check"`, once per new title |
| 1e | The `Proxy` cannot make the tests pass for the wrong reason (injection silently stops firing) | **LANDED** | Mutation C: `isAnalyticsEmission` forced to `false` ⇒ **both titles RED** with `expected [ … ] to have a length of +0 but got 1`. The `toHaveLength(0)` assertions are the anti-vacuity guard, and they work. Restored. |
| 1f | The `Proxy` fires on the emission's INSERT and nothing else | **LANDED** | Mutation D (trace instrumentation): test 1 → `UPDATE businesses …` pass, `INSERT INTO analytics_events` **POISON**; test 2 → `SELECT … FOR UPDATE` pass, `UPDATE businesses SET import_decision` pass, `INSERT INTO analytics_events` **POISON**, `SELECT zc.zernio_account_id …` pass, `INSERT INTO job_outbox …` pass. Exactly one poison per test, on the emission. Restored. |
| 1g | The post-emission statements that prove survival are the caller's own, not the proxy's | **LANDED** | Test 1's `UPDATE businesses SET name` is issued on the raw `tx` (absent from the trace); test 2's survivors are production code (`enqueueInitialImport`'s `SELECT` + `INSERT INTO job_outbox`, both traced as pass) |
| 1h | `isAnalyticsEmission` cannot match a non-emission statement | **LANDED** | `enqueueAnalyticsEvent` is the only non-test `INSERT INTO analytics_events` (`src/lib/analytics/enqueue.ts:29`); no other statement in either flow carries the string |
| 2a | `import-offer-junction.test.ts` mock completion is load-bearing | **LANDED** | Mutation E: `mockTx.savepoint` removed ⇒ **5 of 6 RED**, reproducing D31's claimed count exactly |
| 2b | `import-offer-resume.test.ts` mock completion is load-bearing | **LANDED** | Same mutation ⇒ **2 of 6 RED** (`tx.savepoint is not a function` surfaced through `maybeEnqueueBackfillResume`'s logging), reproducing D36's count exactly. Combined run 7 failed / 5 passed; restored → 12/12 green |
| 2c | `import-offer-resume.test.ts`'s `begin`-returns-self shape | **LANDED (pre-existing, not introduced)** | `worker/ingress/stripe/__tests__/import-offer-resume.test.ts:72` `mockSql.begin = (cb) => cb(mockSql)` is unchanged by this commit; `4c4e9df9` only added `savepoint` on line 74 to match that existing convention. Not faithful to postgres.js in *identity* (real `begin` mints a fresh `Sql` via `scope()`), but the identity property is pinned by the live-DB suite's `max:4` executor-identity test, not by this mock |
| 3a | Stale citation fix `ZernioBackfillWorker.ts:379` → `:416` is correct | **LANDED** | `route.test.ts:322` now cites `:416`; `worker/jobs/zernio/ZernioBackfillWorker.ts:416` is `SET imported_count = ${importedCount},` — exactly the incremental write the comment describes. Old `:379` was `const phi = detectLikelyPhi(z.comment);` (unrelated) |
| 3b | Doc rewrite 1 — `supabase/migrations/102_….sql` header accurate to SHIPPED behaviour | **LANDED** | "a rejected insert rolls back only ITSELF and the enclosing transaction stays usable … cost is a LOST METRIC plus a `warn`" — reproduced live: test 1 committed both the pre- and post-emission writes and returned `'created'`; test 2 kept `import_decision='accepted'` and `outboxCount()=1`; `readAnalytics` empty in both. Commit `bfac89d4` is indeed the savepoint commit |
| 3c | Doc rewrite 2 — `.claude/reference/migrations-log.md` | **LANDED** | Same claim set; "only drift signal is a stdout `warn` with no durable or paged sink" verified at `src/lib/shared/logger.ts:89-98` (console-only sink) |
| 3d | Doc rewrite 3 — plan `2026-08-07-import-consent-worker-guard.md` §6 | **LANDED** | New "Why the ordering survives the savepoint" block; step ordering above it is byte-unchanged, so "ordering is unchanged and still load-bearing" is literally true |
| 3e | Doc rewrite 4 — `docs/analytics/events.md`, both event blocks | **LANDED** | Both rewrites drop the "rolls back the whole enclosing transaction / loses the answer" claim and state the savepoint outcome; `import_decision_recorded`'s "the owner's answer itself survives" verified live. `ci:analytics-events` still passes (heading + `**Status:**` lines intact) |
| 3f | Claim "both emissions are wrapped in a SAVEPOINT" | **LANDED** | `emitConsentEvent` is the sole `enqueueAnalyticsEvent` caller in the module; call sites `import-consent.ts:287` and `:386`; the single wrap at `:482` |
| 3g | Claim "`createImportOffer` rides `finalizeConnectionTx` and `select-location/route.ts` rethrows non-`23505`" | **LANDED** | `finalize-tx.ts:208`; route catch at `select-location/route.ts:97-108` delegates to `recoverFromFinalizeTxFailure`, which rethrows at `orphan-recovery.ts:62` for non-`23505`. Attribution is one hop indirect (the rethrow lives in `orphan-recovery.ts`, not `route.ts`) but behaviourally exact |
| 3h | Every `file.ts:NNN` citation introduced by the commit resolves | **NOT LANDED (1 of 6 stale)** | Mechanical sweep of every added `:NNN` in code + non-review docs: `:24` ✓ (`duplicate-location.ts:24` = the `code === '23505'` check), `:62` ✓ (`create-business.ts:62` = same shape), `:89-98` ✓, `:416` ✓, `:251-256` ✓ (`node_modules/postgres/src/index.js:251-256` = `scope()` minting a fresh `Sql`), **`:435-462` ✗ ×2** — see finding F1 |
| 4a | Intake contract — `tests_to_add` is 40 and every title exists VERBATIM | **LANDED** | `jq` count = 40; all 40 `grep -F` hits across `src`/`worker`/`scripts`; 0 missing |
| 4b | Intake contract — the two intake copies are byte-identical | **LANDED** | `diff <(jq -S . .feature/intake.json) <(jq -S . docs/superpowers/plans/feat-679-…-intake.json)` → identical |
| 4c | Intake contract — `allowed_edit_surface` carries exactly the two amendments | **LANDED** | `import-offer-junction.test.ts` (D31) and `import-offer-resume.test.ts` (D36) added; no other surface entry changed |
| 4d | Intake contract — nothing in the diff falls outside the amended surface | **LANDED** | All 15 files of `4c4e9df9` matched to a surface glob; whole-branch file list (42 files) also fully inside |
| P | PRIORITY — can a transient/connection failure now escape `emitConsentEvent` and re-open the connect outage? | **NO — LANDED** | Enumerated against `node_modules/postgres/src/errors.js`: `PostgresError` carries the SQLSTATE `code` (string); `Errors.connection()` sets `code: x` where x is `CONNECTION_CLOSED`/`CONNECTION_ENDED`/`CONNECTION_DESTROYED`/`CONNECT_TIMEOUT` (string); `Errors.generic(code, …)` sets a string; `Errors.notSupported` sets `'MESSAGE_NOT_SUPPORTED'`. Node system errors (`ECONNREFUSED`, `EPIPE`, `ETIMEDOUT`) carry string `code`. **Nothing transient escapes.** The "too narrow / connect outage is back" High is not triggered |
| P2 | PRIORITY, other direction — is the swallow now too wide? | **INHERITED, not introduced** | `CONNECTION_CLOSED`/`ECONNREFUSED` are swallowed as if they were schema drift. But before `4c4e9df9` **everything** was swallowed; the narrowing strictly shrank the set. `4c4e9df9` did not introduce this and cannot be charged with it. It is the exact residual #697 tracks (no durable sink for the warn). Out of scope per the brief |

---

## 2. Findings — defects `4c4e9df9` introduced

| severity | file:line | finding |
|---|---|---|
| Low | `docs/superpowers/plans/feat-679-import-consent-worker-guard-deviations.md:781` and `:805` | D34's two `` `:435-462` `` citations were correct at `3b7e0404` but are invalidated by this same commit: it inserted 117 lines above that point in the cited file, moving the rollback test to `import-offer-analytics.integration.test.ts:552-590`, while `:435-462` now lands on the `#679 T2` section comment plus the *first* happy-path test. `:805`'s "the existing rollback test at `:435-462` went RED (`55P03`)" therefore points a reader at the wrong test; `:781`'s "the success direction was already pinned at `:435-462`" is wrong by the same drift. Same stale-citation class rounds 1 and 2 each filed. Fix: `:552-590`. |

Nothing else. No Medium or High defect attributable to `4c4e9df9`.

---

## 3. Mutation log (all reverted; `git status --porcelain` clean apart from this report)

| id | mutation | expected | observed |
|---|---|---|---|
| A | `import-consent.ts:482` savepoint deleted → `await enqueueAnalyticsEvent(tx, input);` | the 2 new titles RED | 2 failed / 8 passed, exactly those two ✓ |
| C | `isAnalyticsEmission` short-circuited to `false` (injection disabled) | the 2 new titles RED | 2 failed / 8 passed, `length +0 but got 1` ✓ |
| D | trace `console.log` in the `apply` trap | poison fires once per test, on the emission only | confirmed, full statement trace captured ✓ |
| E | `mockTx.savepoint` / `mockSql.savepoint` commented out in both mocks | 5 + 2 RED per D31/D36 | 7 failed / 5 passed ✓ |

Post-restore re-runs: integration suite 10/10 green; both mock suites 12/12 green. `git diff --stat` empty.

---

## Appendix — new, untriaged (not findings)

1. **`enqueueAnalyticsEvent`'s own validation throw now escapes.** `src/lib/analytics/enqueue.ts:24-26` throws a plain `Error('Invalid analytics event name: …')` with no `code`, so post-`4c4e9df9` it is rethrown and would abort the caller's transaction (i.e. break GBP connect). Unreachable in practice: `input.eventName` is typed `AnalyticsEventName`, both names are registered at `src/lib/analytics/events.ts:28-29`, and a drift-guard title plus `ci:analytics-events` cover removal. This is the *intended* consequence of D32 ("a wiring bug should be loud"), but the JSDoc at `import-consent.ts:465-475` frames the discriminator as wiring-bug-vs-schema-drift and does not mention this third class.
2. **Attribution shorthand in three doc sites.** "`select-location/route.ts` rethrows anything that is not `23505`" — the rethrow is actually in `orphan-recovery.ts:62`, reached from the route's catch. Behaviourally exact, one hop imprecise.
3. **Round-2 review reports carry pre-fix line numbers.** `docs/reviews/…/review-{spec-correctness,standards,adversarial}-round-2.md` cite `import-consent.ts:465-478`, `:471`, `:472` and `import-offer-analytics.integration.test.ts:435-46x`, all of which described `3b7e0404`. Frozen-artefact-by-design — a review report should cite the tree it reviewed — so not filed. Noted only because the same digits appear in D34, where they are *not* frozen by design.

---

**VERDICT: APPROVED**

The one finding is a Low documentation-pointer drift in a deviations entry. Every round-2 spec fix landed, the savepoint is now mutation-proven to be pinned in both the "guard deleted" and "injection disabled" directions, the injection is proven to fire on the emission and nothing else, all four doc rewrites match shipped behaviour verified against live Postgres, and the intake contract holds field by field.

## Orchestrator triage — 2026-08-08 (branch review round 3)

| Finding | Verdict | Disposition |
|---|---|---|
| Every verification row LANDED, incl. the PRIORITY question answered NO | — | No action. The savepoint is now mutation-proven pinned in both directions, and the injection is proven to fire on the emission and nothing else. |
| **Low** — D34's two `:435-462` citations went stale | **ACCEPTED — FIXED** | Corrected to `:552-590` at both sites. The commit that wrote them inserted 117 lines above them in the same file, so they were stale before they were committed. |
| Appendix — `enqueue.ts:24-26`'s plain `Error` now escapes the narrowed catch | **ACCEPTED — promoted out of the appendix** | Verified unreachable: `eventName` is typed `AnalyticsEventName`, so removing a name from the registry fails compilation at the call site before it can fail at runtime. Throwing on a genuinely impossible state is the prescribed behaviour, not a defect. Named as error class 3 in the `emitConsentEvent` JSDoc, which previously enumerated only two. |

**Durable lesson (promote to lab notes at step 8).** Three stale-citation findings
across three rounds on this branch. The fix is not "check citations harder": a
`file.ts:NNN` reference pointing into a file the SAME commit edits is stale before
it is committed. Cite by test title or symbol name when the target moves with you.

Round-3 verdict for this axis: **APPROVED.**
