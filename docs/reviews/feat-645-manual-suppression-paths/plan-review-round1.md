**Can this test suite pass while the feature is still wrong? Yes.** Several promised tests stop at mocked seams or mapper inputs, so they can pass while production SQL leaks provenance, owner mutations cross tenant boundaries, audit failures lose suppressions, or routes omit the transaction that makes correction atomic.

The plan also contains one production SQL error: `accounts.business_name` does not exist.

## Missing failing tests

### Lookup and owner-display truth

- **MISSING FAILING TEST** — `src/lib/solicitation/__tests__/suppression.integration.test.ts`  
  **Title:** `suppressionMatchSql projects scope global when global and account rows both match`  
  The existing global-wins test only selects `source` ([suppression.integration.test.ts:503](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths/src/lib/solicitation/__tests__/suppression.integration.test.ts:503)). The planned mapper test passes `{ scope: 'global' }` by hand, so SQL could return or mis-map `scope='account'` while every new test passes. It must exercise:
  ```sql
  SELECT hit.scope, hit.source
  FROM (...) probe
  LEFT JOIN LATERAL (${suppressionMatchSql(...)}) hit ON TRUE
  ```

- **MISSING FAILING TEST** — `src/lib/solicitation/__tests__/suppression.integration.test.ts`  
  **Title:** `suppressionMatchSql projects account scope only for the matching account`  
  Assert `{scope:'account', source:'owner_manual'}` for its owner and both fields `NULL` for another account.

- **MISSING FAILING TEST** — `src/lib/solicitation/__tests__/contacts-do-not-contact.integration.test.ts`  
  **Title:** `listContacts ignores an account suppression owned by another account for the same handle`  
  This is the end-to-end tenant-isolation proof missing from the mapper-only tests.

- **MISSING FAILING TEST** — `src/lib/solicitation/__tests__/contacts-do-not-contact.integration.test.ts`  
  **Title:** `listContacts returns only the suppression display shape and never source or account provenance`  
  Assert the serialized owner result has exactly `state`, `label`, `detail`, and `clearableByOwner`; no `accountId`, `account_id`, `accountName`, `source`, `note`, or actor. The proposed component test can pass while the API still sends another account’s provenance to the browser.

- **MISSING FAILING TEST** — `src/lib/solicitation/__tests__/contacts-do-not-contact.integration.test.ts`  
  **Title:** `deleting and re-uploading the same handle does not clear its suppression`  
  Mark, delete the contact, re-ingest the same normalized email, and assert `listContacts` still reports suppression. This pins the accidental re-subscribe/laundering path from §8.1.

The existing batch-builder integration test already proves a current consent attestation does not override suppression ([batch-builder.integration.test.ts:1395](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths/src/lib/solicitation/__tests__/batch-builder.integration.test.ts:1395)); that part need not be duplicated.

### Admin entry and lookup

- **MISSING FAILING TEST** — `src/lib/admin/__tests__/suppressions-correction.integration.test.ts`  
  **Title:** `admin manual entry writes a global row when only an account-scoped row already exists`  
  Required by intake edge case line 50. It also proves the global writer still infers the correct partial index.

- **MISSING FAILING TEST** — same file  
  **Title:** `admin manual no-op preserves the first global row source actor note and account provenance`  
  The sketched idempotency test only repeats `admin_manual` and checks `note`. Seed a prior `complaint` or `unsubscribe_link`; assert no field is overwritten.

- **MISSING FAILING TEST** — same file  
  **Title:** `admin manual entry persists the authenticated admin actor required note global scope and null account provenance`  
  The unit mock checks arguments, but the live test must inspect all persisted columns.

- **MISSING FAILING TEST** — same file  
  **Title:** `lookupSuppressions normalizes raw email and returns every matching live row global first with the account display name`  
  This would catch the plan’s invalid `a.business_name` SQL immediately.

- **MISSING FAILING TEST** — same file  
  **Title:** `lookupSuppressions returns only corrections for the normalized handle newest first and capped at twenty`  
  No sketched test invokes the new lookup implementation at all.

- **MISSING FAILING TEST** — `src/lib/admin/__tests__/suppressions-service.test.ts`  
  **Title:** `lookupSuppressions rejects an invalid email without issuing either cross-tenant query`

### Correction atomicity and concurrency

- **MISSING FAILING TEST** — `src/app/api/admin/suppressions/__tests__/route.test.ts`  
  **Title:** `runs correction inside sql.begin and returns success only after the transaction resolves`  
  The planned rollback test supplies `db.begin(...)` itself. It therefore passes even if the production route calls `correctSuppression(sql, ...)` without a transaction—the exact non-atomic delete-plus-audit failure the test claims to exclude.

- **MISSING FAILING TEST** — `src/lib/admin/__tests__/suppressions-correction.integration.test.ts`  
  **Title:** `two concurrent corrections remove one suppression and write exactly one correction record`  
  Assert one result is `corrected`, the other `not_found`, one audit row exists, and the suppression is gone.

- **MISSING FAILING TEST** — `src/app/api/admin/suppressions/__tests__/route.test.ts`  
  **Title:** `uses the authenticated admin id for entry and correction and rejects client-supplied actor fields`  
  Otherwise the audit can name an arbitrary user while all service tests pass.

- **MISSING FAILING TEST** — same file  
  **Title:** `rejects blank entry notes blank correction reasons malformed suppression ids and unknown fields before any write`

- **MISSING FAILING TEST** — same file  
  **Title:** `enforces same-origin on both admin suppression mutations`  
  A mocked AAL2 test does not test the `withSameOrigin()` exports.

### Owner marking and clearing

- **MISSING FAILING TEST** — `src/lib/solicitation/__tests__/contacts-do-not-contact.integration.test.ts`  
  **Title:** `repeating owner do-not-contact is a no-op against the account partial unique index`  
  Existing core coverage proves `recordSuppression`’s account index ([suppression.integration.test.ts:257](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths/src/lib/solicitation/__tests__/suppression.integration.test.ts:257)); this test proves the actual owner wrapper reaches it and reports `already_marked`.

- **MISSING FAILING TEST** — same file  
  **Title:** `attributes owner do-not-contact to the authenticated owner user`  
  The sketched test selects `created_by_user_id` but does not assert it.

- **MISSING FAILING TEST** — same file  
  **Title:** `a foreign account can neither mark nor clear another account contact`  
  Exercise both real repo functions, not a route mock, and assert no suppression or audit rows changed.

- **MISSING FAILING TEST** — same file  
  **Title:** `clearing one account row leaves the global row and every other account row untouched`  
  The sketch retains the global row but does not seed or verify another account’s account-scoped row.

- **MISSING FAILING TEST** — same file  
  **Title:** `a global-only suppression returns not_marked and writes no owner-clear audit row`  
  This is the real SQL proof that an owner cannot clear a global row. The proposed route test only mocks `'not_marked'`.

- **MISSING FAILING TEST** — same file  
  **Title:** `owner clear writes the exact audit actor account location entity and payload without the normalized handle`  
  Assert:
  ```sql
  SELECT account_id, location_id, actor_user_id, event_type,
         entity_type, entity_id, payload
  FROM account_audit_log
  WHERE entity_id = $suppression_id
  ```
  with `event_type='solicitation_do_not_contact_cleared'` and no email anywhere in `payload`.

- **MISSING FAILING TEST** — same file  
  **Title:** `owner clear rolls back the suppression delete when the audit insert fails`  
  Pass a nonexistent actor UUID so `account_audit_log.actor_user_id` rejects; assert the owner suppression remains. This is the owner-side lost-opt-out path absent from the plan.

- **MISSING FAILING TEST** — `src/app/api/dashboard/contacts/__tests__/suppression-route.test.ts`  
  **Title:** `enforces same-origin on both owner suppression mutations`

- **MISSING FAILING TEST** — same file  
  **Title:** `derives account business contact and actor ids only from authenticated scope and route params`

- **MISSING FAILING TEST** — same file  
  **Title:** `returns the feature-disabled 404 before attempting owner authentication`

### Migration 098

The three proposed shape tests allow materially different, unsafe schemas to pass.

- **MISSING FAILING TEST** — `src/lib/shared/__tests__/migration-098-suppression-corrections.integration.test.ts`  
  **Title:** `has exactly the correction audit columns with the locked types nullability and defaults`

- **MISSING FAILING TEST** — same file  
  **Title:** `enforces the authoritative suppression channel scope and source value sets`

- **MISSING FAILING TEST** — same file  
  **Title:** `has no foreign keys to suppressions accounts or users so correction history survives its referents`

- **MISSING FAILING TEST** — same file  
  **Title:** `indexes corrections by channel normalized handle and created_at descending`

- **MISSING FAILING TEST** — same file  
  **Title:** `rejects every empty-or-whitespace reason and accepts a nonblank reason`

### UI wiring

- **MISSING FAILING TEST** — `src/app/admin/suppressions/__tests__/page.test.tsx`  
  **Title:** `requires an admin AAL2 page gate before rendering the suppressions console`

- **MISSING FAILING TEST** — `src/app/admin/suppressions/__tests__/SuppressionsClient.test.tsx`  
  **Title:** `submits the selected suppression id and trimmed reason to the correction endpoint only after confirmation`

- **MISSING FAILING TEST** — same file  
  **Title:** `keeps the live suppression visible when correction fails`

- **MISSING FAILING TEST** — same file  
  **Title:** `manual entry posts the email and required originating message reference to the entry endpoint`

- **MISSING FAILING TEST** — `src/app/(authenticated)/dashboard/requests/contacts/__tests__/contacts-ui.test.tsx`  
  **Title:** `marking do-not-contact posts to the suppression endpoint and never hard-deletes the contact`

- **MISSING FAILING TEST** — same file  
  **Title:** `clearing owner do-not-contact deletes the suppression endpoint and never deletes the contact endpoint`

- **MISSING FAILING TEST** — same file  
  **Title:** `a failed suppression mutation does not refresh into an apparently successful state`

## Eval-task defect

Task 1 does not create failing tests: `it.todo` is pending and the promised-tests gate explicitly treats it as satisfying the contract. More concretely, the Step 2 command at plan lines 141–142 omits both live-DB files:

- `src/lib/admin/__tests__/suppressions-correction.integration.test.ts`
- `src/lib/solicitation/__tests__/contacts-do-not-contact.integration.test.ts`

It therefore runs only 10 of the 18 titles while claiming to confirm all eighteen.

## Cited-artifact check

I read all requested artifacts in full. The worktree is clean.

Verified citations include:

- The locked spec really contains §§7.1–7.6 and §§8.1–8.2 with the claimed manual/correction contracts ([spec:570](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths/docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md:570)).
- All six named glossary terms exist in the requested section ([CONTEXT.md:84](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths/CONTEXT.md:84)).
- `suppressionMatchSql`, `recordSuppression`, and all three exported enum arrays exist with the claimed signatures ([suppression.ts:25](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths/src/lib/solicitation/suppression.ts:25)).
- Migration 096 has both exact partial indexes and RLS deny-all ([096_solicitation_suppressions.sql:88](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths/supabase/migrations/096_solicitation_suppressions.sql:88)).
- Migration head is 097/next 098; `MIGRATION_096_SOLICITATION_SUPPRESSIONS` exists.
- The autonomy, flagged, contacts-route, audit-log, admin-page, UI-primitive, ContactList, and fast-check precedents exist and have the generally claimed shapes.
- `NO_STORE_HEADERS` is exported; the fallback at plan line 907 is unnecessary ([constants.ts:12](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths/src/lib/shared/constants.ts:12)).

Citation failures:

1. **Invalid column:** plan line 620 selects `a.business_name`, but `accounts` has `display_name`, not `business_name` ([034_multi_location_schema.sql:27](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths/supabase/migrations/034_multi_location_schema.sql:27)). Exact correction:
   ```sql
   LEFT JOIN accounts a ON a.id = s.account_id
   SELECT ..., a.display_name AS account_name, ...
   ```

2. **Nonexistent test path:** plan line 917 cites `src/lib/admin/flagged-service.test.ts`; the real file is `src/lib/admin/__tests__/flagged-service.test.ts`.

3. **Nonexistent intake precedent:** intake line 64 cites `src/lib/admin/businesses-list-service.ts`; no such file exists.

4. **Wrong tenant-allowlist count:** plan line 911 says three entries. The audit keys entries by exact `file + table + SQL statement` ([tenant-scope-audit.ts:450](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths/scripts/ci/tenant-scope-audit.ts:450)). The proposed service needs four:

   - lookup SELECT × `solicitation_suppressions`
   - same lookup SELECT × `accounts`
   - corrections SELECT × `solicitation_suppression_corrections`
   - correction DELETE × `solicitation_suppressions`

   Therefore `ALLOWLIST_BASELINE` must increase by four, not three.

5. **False type claim:** plan lines 7/23/448 claim `{ scope }` structurally cannot carry `account_id` or `source`. TypeScript structural typing allows an object variable with extra properties, and the proposed signature explicitly accepts `{ scope: string }`. The mapper’s exact output shape prevents propagation; the input type does not make passing provenance impossible.

6. **Broken decision citation:** plan line 251 attributes correction retention to “D7,” but plan D-7 is the display-input decision. Spec D7 is retention; the reference is ambiguous/wrong as written.

7. **Unfulfilled intake observability claim:** intake line 124 promises correction error logs carry the suppression row id. The proposed route logs only a static label plus the caught error at plan line 900; no step or test ensures the suppression id is logged.

## Architecture invariants

- **Invariant 2:** Intended design is compatible—no outbox is required, and analytics/audit are transactional. The missing route-transaction and owner-audit-rollback tests leave the two dangerous seams unproved.
- **Invariant 8:** Intended predicates are correctly account/business scoped, but mapper-only and route-mock tests do not prove the owner response excludes global provenance end to end.
- **Invariant 10:** No violation; UUID generation uses the existing `uuid` convention and no new crypto implementation is introduced.
- **Invariant 13:** No violation; owner access uses the existing server-side watch gate.
- **Invariant 14:** No direct browser table access is planned; both ledger tables use RLS deny-all.
- **Invariant 15:** The proposed domain functions receive `Sql`/`TransactionSql` explicitly; singleton imports remain in route/page composition roots.

## Unsupported assumptions and simpler alternatives

- The spec requires an audit record naming who removed the row and why. It does **not** require a permanent raw-handle snapshot, a handle index, correction-history lookup by email, or indefinite retention of corrected PII. Those are plan inventions, and the new table is omitted from `TABLE_DISPOSITIONS`.
- A smaller correction table—`id`, `suppression_id`, `scope`, `source`, `removed_by_user_id`, `reason`, `created_at`—would meet §8.2 without retaining a corrected email forever.
- Correction can be made structurally atomic with one SQL statement, eliminating reliance on route-owned transaction discipline:
  ```sql
  WITH removed AS (
    DELETE FROM solicitation_suppressions
    WHERE id = ${suppressionId}::uuid
    RETURNING id, scope, source
  )
  INSERT INTO solicitation_suppression_corrections
    (id, suppression_id, scope, source, removed_by_user_id, reason)
  SELECT ${uuidv7()}, id, scope, source, ${adminUserId}::uuid, ${reason}
  FROM removed
  RETURNING suppression_id;
  ```
  An insert failure rolls back the delete automatically; zero returned rows means `not_found`.
- The `fast-check` mapper property generates illegal source/scope pairs and then casts around the intended input type. Two table-driven mapper cases plus the two live SQL projection tests above are simpler and test the real contract.

## Must change

1. Add the missing live-DB tests that prove SQL scope projection, tenant isolation, global-row immutability, partial-index inference through both manual paths, and delete/re-upload persistence.
2. Add owner audit success and rollback tests, plus a route test proving correction’s production call is atomic.
3. Add real lookup coverage; fix `accounts.business_name` to `accounts.display_name`.
4. Expand migration 098’s suite to pin exact columns, enums, no-FK posture, reason constraint, index, and RLS.
5. Add same-origin, authenticated-actor, strict-validation, and server-payload tests for both admin and owner routes.
6. Correct the tenant-scope allowlist plan to four exact entries and increase the baseline by four.
7. Resolve correction-record retention against the spec and offboarding inventory; remove unnecessary raw-handle history or explicitly specify, inventory, and test that new retention policy.
8. Make Task 1 execute all eighteen files and use genuinely failing tests rather than counting `it.todo` as implementation evidence.

VERDICT: REVISE
---

# TRIAGE (orchestrator, 2026-08-03) — applied in commit 711575f4

Verdicts on every round-1 finding. 37 of the 38 required test titles are now in
the plan; the one exception is recorded below with its reasoning.

## Accepted — design-changing

| Finding | Verdict | Evidence |
|---|---|---|
| `accounts.business_name` does not exist | **ACCEPT** | `display_name` confirmed in `034_multi_location_schema.sql:30`; plan and all lookup tests updated |
| Correction is not provably atomic against the production call path | **ACCEPT, and fixed more strongly than proposed** | `correctSuppression` is now a single data-modifying CTE (P-9). Validated against real Postgres with scratch tables: happy path writes exactly one record and removes the row; a missing id returns zero rows and writes no orphan; a blank reason throws and the suppression row SURVIVES — **with no outer transaction**, which is what production does |
| Corrections table omitted from `TABLE_DISPOSITIONS` | **ACCEPT, resolved by removing the cause** | Verified by running the exact `linkedColumnPattern` + `referencesTenantRootPattern` regexes from `table-disposition.test.ts` against both variants: the revised table (no `account_id`) → `false`/`false`; the same table WITH `account_id` → `true`. Dropping the column keeps the table honestly outside the offboarding inventory AND avoids a fresh indefinite retention obligation for provenance whose owning row is being deleted (P-2) |
| "structurally cannot carry account_id" is a false type claim | **ACCEPT** | Restated as output closure (P-8); the property test now generates only legal `(scope, source)` pairs and asserts the exact four-key result |
| Task 1's `it.todo` cannot fail; Step 2 ran 4 of 6 files | **ACCEPT** | T1 now requires real bodies importing not-yet-existing symbols, and runs all six files |
| Tenant-scope allowlist count guessed at three | **ACCEPT** | Plan now derives the count by running `pnpm ci:tenant-scope` and setting `ALLOWLIST_BASELINE` to the real entry count |
| Migration 098 shape suite too loose | **ACCEPT** | Expanded to pin exact columns/types/nullability, both enum sets driven from the exported constants, zero-FK posture, index definition, the reason CHECK across five blank forms, and RLS deny-all — plus a new test asserting no account-linked column, so a future regression explains itself |
| 37 missing failing tests across ledger SQL projection, tenant isolation, laundering, concurrency, routes, and UI wiring | **ACCEPT** | All 37 added to the owning tasks |
| `src/lib/admin/flagged-service.test.ts` path wrong; intake cites nonexistent `businesses-list-service.ts` | **ACCEPT** | Both corrected; the latter exists only in the `admin-console-phase3` worktree, not on `main` |
| "D7" ambiguous between plan and spec registers | **ACCEPT** | Plan decisions renumbered **P-1 … P-10** so they cannot collide with the spec's D1–D9 |
| Observability claim unfulfilled (correction logs lack the suppression id) | **ACCEPT** | The id is now in both the success log line and the `internalError` prefix; never the handle (§9.5) |
| `NO_STORE_HEADERS` fallback unnecessary | **ACCEPT** | Hedge removed |

## Rejected, with reasoning

| Finding | Verdict | Reasoning |
|---|---|---|
| Add test `runs correction inside sql.begin and returns success only after the transaction resolves` | **REJECT AS WRITTEN — underlying concern accepted** | The fix removed `sql.begin` from the correction path entirely, so a test asserting its presence would pin an implementation detail that no longer exists and would fail against the correct code. The concern it encodes — *atomicity must be provable against the production call path, not against a transaction the test supplied* — is closed by `rolls back the delete when the correction record write fails`, now run on the pooled client with no outer transaction, and independently validated against live Postgres |
| Drop `normalized_handle` from the correction record | **REJECT** | `suppression_id` references a row this statement deletes, so it resolves to nothing. Without the handle the record cannot identify which opt-out was removed, and an audit record that cannot name its subject is not one. Retention posture matches the `scope='global'` ledger rows it describes and is documented in the migrations-log retention table (P-3) |
| Drop correction-history lookup by email and its index | **REJECT** | §7.2's servicing ritual starts from an address in a forwarded mailbox reply. Showing prior corrections for that handle is what stops an admin re-entering an opt-out that was just corrected, and the index is what keeps that query off a sequential scan of a no-TTL table |
| Replace the `fast-check` property with two table-driven cases | **PARTIAL** | The property's *stated* invariant was wrong and is fixed; the property itself is kept because the title is a locked `tests_to_add` entry in the intake contract, and output closure over generated legal inputs is a real invariant. The two live SQL projection tests were added as proposed — they cover what the property cannot |

## Round 2

Dispatched as verification-only and **stopped before producing any output** — no
verdict, no partial report. The three design-changing fixes were instead
verified directly by the orchestrator with the concrete evidence cited above
(schema introspection, the real detector regexes, and live-Postgres execution of
the CTE), which is stronger evidence than a second model opinion on the same
prose.
