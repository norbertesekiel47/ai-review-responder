# Review — spec & correctness axis (round 2, verification-only)

**Ticket:** #679 · **Branch:** `feat-679-import-consent-worker-guard`
**Scope:** the four fix commits `fa84bc1c`, `bfac89d4`, `6b312edb`, `a2f2ac09`
(round-1 review commit `07f57148`; branch base `main@2f369582`).
**Method:** mutation, not reading. Every behavioural claim below was verified by
breaking the production code deliberately, confirming the expected suite went
RED, and restoring the file with `git checkout`. This axis held the exclusive
live-DB lock; all four `*.integration.test.ts` suites were run.

---

## 1. Verification table

| Finding (round 1) | Verdict | Evidence |
|---|---|---|
| **Medium** — deploy-ordering consequence materially understated (`102_….sql:22-25` + 5 sites) | **LANDED** | `src/lib/reviews/import-consent.ts:465-478` savepoints both emissions; mutation-proven load-bearing in both directions (§2). Module header `import-consent.ts:55-73` now names the connect outage and states the residual risk (metric under-count, not feature loss) — and that residual claim is *true*, verified live at both emission sites. |
| **Low** — module header names a `createImportOffer` producer that does not exist | **LANDED** | `import-consent.ts:38-47` replaces `add-location-tx.ts` with the three real producers and adds an explicit "is NOT a producer" note. All three citations re-verified: `finalize-tx.ts:208`, `worker/ingress/stripe/shared.ts:159`, `src/app/api/dashboard/import-offer/route.ts:103`. |
| **Low** — seven `file.ts:NNN` cross-references invalidated (one in-surface) | **NOT LANDED** | `src/app/api/dashboard/import-offer/__tests__/route.test.ts:322` still cites `ZernioBackfillWorker.ts:379`; the actual `SET imported_count =` is at `:416`. The file is untouched by every fix commit (`git log 07f57148..HEAD -- <path>` is empty) and the omission is not recorded in the deviations log. Orchestrator triage said "the one inside `allowed_edit_surface` is fixed here". |

Net: 2 LANDED, 1 NOT LANDED, 0 REGRESSED.

---

## 2. The savepoint (`bfac89d4`) — the priority target

The remedy is `emitConsentEvent` (`src/lib/reviews/import-consent.ts:465-478`):

```ts
await tx.savepoint((sp) => enqueueAnalyticsEvent(sp, input));
```

wrapped in a `try/catch` that logs at `warn`. Called from `createImportOffer:287`
and `recordImportDecisionAndEnqueue:386`.

### Q1 — does a failed emission leave the enclosing transaction usable?

**Yes. Proven in both directions against the live test DB.**

I wrote a temporary probe suite (`src/lib/reviews/__tests__/zzz-round2-savepoint-probe.integration.test.ts`,
**deleted after use**) that drives the real module inside a real transaction and
issues a further write *after* the emission — the statement that would fail with
`25P02` if the parent were poisoned:

- **connect-shaped** — `sql.begin(tx => { createImportOffer(tx,…); tx\`UPDATE businesses SET owner_name='after-probe'\` })`
- **decision-shaped** — `recordImportDecisionAndEnqueue(sql,…,'accepted')`, whose
  post-emission work is the `enqueueInitialImport` outbox INSERT.

The failure was injected **Postgres-side**, not as a JS throw (per the brief's
warning): mutate `emitConsentEvent` to `enqueueAnalyticsEvent(sp, { ...input, businessId: uuidv7() })`,
tripping `analytics_events_business_id_fkey` — SQLSTATE `23503`, the same
in-transaction constraint class as the real `23514`.

| Run | Mutation | Result |
|---|---|---|
| A | none | 2/2 PASS (baseline: emission succeeds, tx commits) |
| B | FK injection, **savepoint present** | 2/2 **PASS** — `createImportOffer` returned `'created'`, `owner_name = 'after-probe'` committed, `import_offer_expires_at` committed, decision committed as `accepted`, **1** `zernio_initial_backfill` outbox row, **0** analytics rows, one `warn` line per emission |
| C | FK injection, **savepoint removed** (`await enqueueAnalyticsEvent(tx, {...})`) | 2/2 **FAIL** — `PostgresError … violates foreign key constraint "analytics_events_business_id_fkey"` propagates out of both writers |

Run C is the pre-`bfac89d4` shape and reproduces exactly the round-1 hazard: the
caller's whole transaction dies. Run B is the shipped shape. **The savepoint is
load-bearing and does what the commit claims.**

### Q2 — does a *successful* emission still die with the caller's rollback?

**Yes.** Two independent proofs:

1. **Positive, on the shipped code.** `"recordImportDecisionAndEnqueue rolls back
   import_decision_recorded when the decision transaction aborts"`
   (`import-offer-analytics.integration.test.ts:435-460`) passes GREEN against the
   savepointed emission and asserts `readAnalytics('import_decision_recorded')`
   is length 0 after the parent aborts. A savepoint-committed row *is* rolled
   back with its parent.
2. **Structural.** postgres.js `src/index.js:250-278`: `scope()` issues `commit`
   **only** when `name` is falsy, i.e. only for the top-level transaction. A
   savepoint scope never commits; it only issues `SAVEPOINT` on entry and
   `ROLLBACK TO` on throw. There is no path by which `tx.savepoint` produces an
   independent write.
3. **Mutation.** Turning the emission into a genuinely independent write —
   `emitConsentEvent(tx, …)` → `enqueueAnalyticsEvent(sql, …)` at
   `import-consent.ts:386` — turns **4 of the 8** titles in
   `import-offer-analytics.integration.test.ts` RED in ~5s each, including the
   abort title (`expected … { code: '23503' }` / `received { code: '55P03' }`).
   Reproduces D27's claim exactly. Reverted; `git diff` on the file is empty.

### Q3 — can the savepoint's own failure handling poison the transaction?

**No, and there is no release/rollback ordering hazard to get wrong**, because
postgres.js never issues `RELEASE SAVEPOINT` at all (`src/index.js:257-272`):
`SAVEPOINT s<n>` on entry, `ROLLBACK TO s<n>` in the catch, nothing on success.
So the "`RELEASE` on an already-aborted savepoint" failure mode the brief asks
about cannot arise in this driver. Two further checks:

- The savepoint scope gets its **own** `Sql(handler)` with its own
  `uncaughtError` (`src/index.js:249-295`), so the failing INSERT never sets the
  *parent* scope's `uncaughtError` — which is why the parent still reaches
  `commit`. Confirmed empirically by run B above.
- The `SAVEPOINT` statement itself sits *outside* the inner `try`. If it failed
  (only possible on an already-aborted parent or a dead connection) the error
  propagates to `emitConsentEvent`'s catch. Not reachable from either call site,
  since both have already read rows successfully from the same transaction.
- No nested savepoints anywhere: `rg savepoint` over the repo returns exactly one
  production call site.

### Q4 — is the fallback a `warn`, or a swallow that hides schema drift forever?

**A `warn`, and it carries a usable payload.** Observed live in run B:

```
{"level":"warn","logger":"import-consent","message":"Import consent analytics emission failed",
 "data":{"business_id":"…","event_name":"import_offer_created",
         "error":"insert or update on table \"analytics_events\" violates foreign key constraint …"}}
```

Business id, event name, and the Postgres primary message only — no properties,
no review text, no tokens, as the JSDoc promises. On the real `23514` the message
is `… violates check constraint "analytics_events_event_name_check"`, which names
the migration-102 gap directly. `logRejection` correctly stays at `log`; this one
is `warn`. The distinction is deliberate and correct.

**But the warn is the *only* signal**, and nothing pins it — see finding S1.

---

## 3. Findings — what a fix commit broke or left open

| Severity | file:line | Finding |
|---|---|---|
| **Medium** | `src/lib/reviews/import-consent.ts:465-478` | The savepoint — the highest-risk change on the branch — has **zero test coverage**. Deleting `emitConsentEvent`'s savepoint and catch entirely (back to the exact pre-`bfac89d4` `await enqueueAnalyticsEvent(tx, input)`) leaves **all 37 live-DB tests** across the four integration suites and **all 42** affected unit tests GREEN. A revert of the connect-outage fix is mechanically invisible to CI. |
| **Low** | `src/lib/reviews/import-consent.ts:471-477` | The `catch` is unbounded, so it also swallows non-Postgres programming errors. If any handle reaching `emitConsentEvent` lacks `.savepoint` (root `sql`, `sql.reserve()`, a `Sql`-shaped `Proxy` — this suite already builds two), `tx.savepoint` is `undefined`, the `TypeError` is eaten, and **both analytics events stop being emitted forever** behind a `warn` that reads like a migration problem. D27 records this as "structurally undetectable" and leaves it. Catching only `PostgresError` (or rethrowing `TypeError`) keeps the safety property and makes the programming error loud. |
| **Low** | `src/app/api/dashboard/import-offer/__tests__/route.test.ts:322` | Round-1's in-surface stale citation, which the triage said would be fixed on this branch, was not. `ZernioBackfillWorker.ts:379` → `:416`. One-token edit, inside `allowed_edit_surface`. |

### Detail — S1 (Medium): the savepoint is unpinned

`rg -n savepoint` over the whole repo returns the one production call site plus
four comments. No test exercises the containment property, and the fix commit
says so explicitly: *"Tests deliberately untouched; a follow-up agent owns the
test for this behaviour."* No follow-up commit delivered it — `6b312edb` split
and re-hardened the abort test, `a2f2ac09` renamed a file.

Mutation evidence (the whole point of this round):

```
# mutation: emitConsentEvent body → `await enqueueAnalyticsEvent(tx, input);`
vitest run --project integration \
  src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts \
  src/lib/reviews/__tests__/import-consent.integration.test.ts \
  worker/jobs/zernio/__tests__/job-eligibility.integration.test.ts \
  src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts
→ Test Files 4 passed (4) · Tests 37 passed (37)
```

This is the same defect class the branch has been chasing all run: a property
that is true, believed, documented at length — and unverified. Round 1 found
five instances of false coverage on this branch and **every one was caught by
mutation, none by reading**. The savepoint is now the sixth candidate, and it
guards a full onboarding outage.

The fix is cheap and entirely in-surface (`src/lib/reviews/__tests__/**`): one
title in `import-offer-analytics.integration.test.ts` that injects a Postgres-side
emission failure and asserts the caller's transaction still commits. The
injection shape is already available in that file — `abortingExecutor` proves the
team knows how to force a real `23503` without DDL; a sibling helper that fails
the *emission* rather than the enclosing statement is a small variation on it.
My probe (§2, run B) is a working proof of concept and took ~40 lines.

### Detail — S2 (Low): the catch is wider than the hazard it exists for

`emitConsentEvent` exists to contain a **Postgres** in-transaction abort. It
currently also contains:

- `enqueueAnalyticsEvent`'s own `throw new Error('Invalid analytics event name: …')`
  (`src/lib/analytics/enqueue.ts:25-27`), which fires *before* any SQL — a typo'd
  event name degrades from a hard failure to a warn.
- Any `TypeError` from a handle without `.savepoint`.

Today TypeScript covers the production call sites (both take `TransactionSql`),
so this is Low. It becomes real the moment someone widens the parameter type,
introduces a reserved connection, or a test double stops forwarding `savepoint`.
The asymmetry is worth fixing while the module is open, because it is precisely
what makes S1's mutation invisible.

---

## 4. Regression sweep over the rest of the fix diff

Everything below was re-verified after the fix commits; none of it regressed.

| Property (round-1 verdict) | Round-2 status | Evidence |
|---|---|---|
| All 38 `tests_to_add` titles present | **Holds** | Scripted grep of every `.tests_to_add[]` entry from `.feature/intake.json` against `src`/`worker`/`scripts`: **0 missing**, after both the suite split (`6b312edb`) and the rename (`a2f2ac09`). |
| Both events registered + emitted in-transaction | **Holds** | `pnpm ci:analytics-events` passes. Q2 above. |
| Live-DB conventions (`*.integration.test.ts`, no run-time DDL) | **Holds, improved** | `pnpm ci:live-db-suites` passes. `rg 'ALTER TABLE\|CREATE INDEX\|DROP CONSTRAINT' src/lib/reviews/__tests__/` is empty — the D27 replacement genuinely removed the DDL rather than renaming it. |
| Emission uses `tx`, never outer `sql` | **Holds** | 4/8 mutation, §2 Q2.3. |
| Fail-closed guard, race serialization, spec §5.1 retryability | **Holds** | Untouched by the fix commits (`git diff --name-only 07f57148..HEAD` lists no production file but `import-consent.ts`). Per the brief, not re-derived. |
| Typecheck / lint | **Clean** | `pnpm typecheck` clean; `eslint` clean over all seven changed files. |
| Migration-102 precondition placement (`6b312edb`) | **Correct** | `assertAnalyticsEventNamesRegistered` (`schema-ready.ts:434-462`) reads `pg_get_constraintdef` and substring-matches each quoted name — sound for a constraint-replacing migration, and no other name in the CHECK can satisfy `'import_offer_created'` or `'import_decision_recorded'` spuriously. Applied to exactly the two suites that assert an event row exists. `import-consent.integration.test.ts` correctly omits it: after the split it retains only a cleanup `DELETE FROM analytics_events` (`:212`) and explanatory comments, no assertion. |
| `a2f2ac09` rename | **Correct** | `import-offer-analytics` → slug `src-lib-reviews---tests---import-offer-a`, distinct from the parent's 40-char `src-lib-reviews---tests---import-consent`. All four suites run green concurrently with the parent. |

Final green re-run after every mutation was reverted:
`Test Files 4 passed (4) · Tests 37 passed (37)`. `git status --porcelain` shows
no modified file.

---

## Appendix — new, untriaged (not findings this round)

- **Two further stale `import-consent.ts:NNN` citations, both pre-existing.**
  `docs/superpowers/plans/2026-08-07-import-consent-worker-guard.md:69` cites
  `import-consent.ts:467-472` for the in-flight dedup `NOT EXISTS`. That was
  accurate against `main@2f369582` (`:467-472`), was already wrong at the
  round-1 review commit (`:531-537`), and `bfac89d4` moved it again (now
  `:606-611`). `src/lib/reviews/__tests__/import-consent-lock-order-source.test.ts:357`
  cites `import-consent.ts:72-97` for `importConsentStateSql`, now at `:172-180`.
  Neither was in round 1's "seven", and neither was *introduced* by a fix commit
  — so out of scope — but both are in-surface (`docs/superpowers/plans/**`,
  `src/lib/reviews/__tests__/**`) and belong with the S3 one-token fix.
- **The Q2 pin is indirect.** `"…rolls back import_decision_recorded when the
  decision transaction aborts"` detects the independent-write mutation via a
  `55P03` lock timeout (the outer-`sql` INSERT takes `FOR KEY SHARE` against the
  transaction's own `FOR UPDATE`), not by observing an orphaned analytics row.
  The suite header documents this and the `lock_timeout: 5_000` that bounds it.
  It is red either way, so the pin holds; it is worth knowing that the failure
  message names a lock, not the semantics.
- **`emitConsentEvent`'s `warn` fires once per emission attempt with no
  suppression.** On a project that promoted before migration 102, that is one
  warn per GBP connect, per Stripe activation, and per owner decision —
  correct, and the volume is low. Noted only because the module header calls the
  warn line "how a project that got the order wrong announces itself", and
  nothing routes it to an alert sink.

---

**VERDICT: REVISE** — the savepoint is correct and mutation-proven in both
directions, and two of three round-1 findings landed cleanly. Two cheap,
in-surface items remain: pin the savepoint's containment property with one
integration title (S1 — otherwise the branch ships its highest-risk fix with
the same false-coverage gap that produced five round-1 findings), and land the
one-token cross-reference fix the round-1 triage already accepted (S3).

---

## Orchestrator triage — 2026-08-08 (branch review round 2)

| Finding | Verdict | Disposition |
|---|---|---|
| Medium — deploy-ordering understated — **LANDED** | — | No action. |
| Low — phantom `createImportOffer` producer — **LANDED** | — | No action. |
| Low — stale cross-reference — **NOT LANDED** | **ACCEPTED — FIXED** | `src/app/api/dashboard/import-offer/__tests__/route.test.ts:322` now cites `ZernioBackfillWorker.ts:416`, verified against the actual `SET imported_count =` site. The round-1 triage did promise this and it was missed; the miss is real. |
| Medium — savepoint has zero test coverage (`import-consent.ts:465-478`) | **ACCEPTED — FIXED** | **The decisive finding of round 2.** Converged with the standards axis. Coverage added to `src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts` and mutation-verified: deleting the savepoint must turn it RED. |
| Low — the `catch` is unbounded | **ACCEPTED — FIXED** | Converged with standards (Medium) and adversarial (Medium). The catch now rethrows non-Postgres errors, discriminating on the string `code` property that a `PostgresError` carries and a `TypeError` does not. Cost one surface amendment (owner-approved, **1 of 2**) to complete `mockTx` in the junction suite. Supersedes deviation **D27**'s "structurally undetectable" disposition. |

**On the low-confidence appendix note about warn volume and no alert sink** —
promoted to a real disposition rather than left in the appendix, because the
adversarial axis raised the same thing as a table finding. Filed as **#697**;
the alerting seam is out of surface and migration-before-code ordering remains
the enforced primary control.

Round-2 verdict for this axis: **REVISE → resolved.**
