# Plan review R2 — verification only

**VERDICT: REVISE.** The revisions address substantial parts of R1, but seven dispositions remain partial. The clearest surviving failures are aggregate-property degradation, the decoy constraint being introduced on the wrong apply, and row-count-only preservation. The new property accessor also needs an explicit table-absence case for migration 118.

This is a review of the revised **plan**, not an assertion that implementation exists. “YES” means the plan now specifies a sufficient fix for the accepted finding; “PARTIAL” means part of that accepted finding remains. No unrelated unchanged section was reopened. References to plan lines below refer to `docs/superpowers/plans/fix-1301-migration-guard-execution-plan.md` as read in this round; HEAD remains `d79bc765ce630ea651efe67ec6a7b3488c5afa86`.

Read the revised plan in full, the revised intake, R1's relevant finding descriptions and Q3(c) map, the amendment metadata, and the specific audit/gate code needed for the added claims. Used the `verify-spec` evidence method under the user's narrower verification-only contract. One read-only delegate checked only promised-title matching and DML-only suite classification. This report is the only file written. No implementation, migration, database mutation, build, full test run or gate-state change was performed. The expected RED implementation gate is not a review finding.

## Fix verification

| Finding | Fix verified? | One-line reason |
|---|---|---|
| F1 | PARTIAL | Selecting `indexes` or `columns` rejects unrelated fields, but changing one array member still passes while another guarded object remains intact. |
| F2 | YES | Current-role schema default GRANT ALL challenges 118's REVOKE on recreation without changing existing tables' privileges. |
| F3 | YES | GRANT ALL introduces every PostgreSQL 17 table privilege, so a SELECT-only revoke no longer restores baseline. |
| F4 | PARTIAL | Independent index/constraint/nullability expectations fix the original circular comparisons, but 118's comments/default still lack explicit independent head expectations. |
| F5 | PARTIAL | Defaults and column comments are now observable; the identity/generated metadata explicitly requested in R1 remains absent. |
| F6 | PARTIAL | USING/WITH CHECK changes become visible, but policy roles, command and permissive/restrictive mode are still omitted. |
| F7 | PARTIAL | All grantees, PUBLIC and grant options are covered; the grantor field explicitly requested in R1 remains absent. |
| F8 | YES | The new integration test specifies success/failure rollback and unchanged error propagation; readable DML needs no migration-shape exemption. |
| F9 | PARTIAL | Second application tests idempotence, but a decoy added after restoring the real constraint cannot distinguish scoped and unscoped lookups. |
| F10 | PARTIAL | The owner-role control rejects UPDATE-all, but 051's count-only check misses value changes and deletes from an empty fixture. |
| F11 | YES | T4/T5 now explicitly require the previously missing default, column inventory, FK definitions and SET NULL action. |
| F12 | YES | T2 adds an existing-file verbatim-return test alongside the missing-file test. |
| F13 | YES | T2 adds both unlisted-table appearance and disappearance to the comparator contract and test. |
| F14 | YES | T1 updates the local recipe and associated live descriptions, adds parity coverage, and the amended surfaces/counter match. |

## Defect introduced by a fix

| Defect | Introduced by | Evidence and required correction |
|---|---|---|
| R2-D1 — dropped target has no property to dereference | F1's new accessor contract | T2 specifies `after.tables[table][property]`, while T8 deliberately removes the table. The specified lookup throws before reapplication. Define a deliberate table-absence transition and test it; do not omit the vacuity check for 118. |

**MISSING FAILING TEST:** `assertDegradeLanded accepts deliberate target-table removal without dereferencing a missing table`.

This is a plan-contract defect, not a claim about nonexistent implementation. A faithful direct implementation of the stated expression fails. An optional/absence-aware accessor or an explicit table-existence target can resolve it while still rejecting unexpected missing baselines. The original whole-table comparison could compare an object with `undefined`; the new nested access at plan lines 310–313 removes that behavior unless it is deliberately restored.

## Evidence for the partial dispositions

### F1 — property selection is still coarser than the guarded object

Plan lines 100–116 and 280–313 replace whole-table comparison with one `keyof CataloguedTable` value. This correctly rejects a comment-only change when the requested property is `indexes`. It does not distinguish individual indexes within that property.

R1's original counterexample still works against a healthy preprovisioned database: drop three ordinary 048 indexes but accidentally leave `idx_impersonation_active_actor` intact, and remove that index's CREATE from the candidate migration. The `indexes` array changes, so the revised helper passes. The candidate restores the three dropped indexes; the retained unique index makes AFTER equal BEFORE. Oracle A reads the correct installed index and passes. This is the same accepted F1 failure, not a new front. Analogously, changing one 057 column makes `columns` differ while another targeted column never becomes NOT NULL.

**Remaining MISSING FAILING TEST:** `assertDegradeLanded rejects a partial index or column degrade when another guarded object remains intact`.

Require each named index absent, each named column in its exact degraded nullability, each challenged client privilege present, and each RLS flag false. An aggregate helper is fine as a coarse check, but it cannot be the sole mandatory proof that every intended negative state landed. Add assertions per guarded object or a selector/expected-degraded-value contract. An in-memory check in this review confirmed that both arrays differ while the protected second member remains unchanged.

### F4 — the architectural fix is sound, but its coverage is not yet complete

Credit the actual improvement: plan lines 84–96 require literals independent of candidate SQL; T4 at 451–459 explicitly pins the four index definitions, and T6 at 555–557 pins the exact owner/admin allowlist. T7 at 602–607 independently pins both changed and protected nullabilities. The global exact-index instruction and T5's explicit negative case at 506 also require its partial-index expectation; do not treat an abbreviated local list as permission to omit that global obligation. Copying vetted baseline output into checked-in literals is materially different from deriving the expected value at test runtime from the candidate migration or database.

The remaining interaction is with the newly added F5 fields. The general Oracle A list at 84–87 names indexes, constraints, nullability and client privileges. T8's 118 contract at 664–708 describes its comments/default and their Oracle B restoration, but never pins their independent expected **values** at head. Its assertion that adding fields alone makes comment/default deletion fail remains circular after candidate provisioning:

1. Remove 118's column COMMENT or `DEFAULT NOW()` before provisioning.
2. Provision the candidate. BEFORE already has the missing comment/default.
3. Grant permissive defaults, drop the table, and reapply the same candidate.
4. The real REVOKE still works; RLS, constraints and client head posture remain correct; missing comment/default compare equal.

The new observer fixes visibility, but an observer is not an independent specification. This directly combines the already accepted F4 and F5 failures within the changed two-oracle design.

**Remaining MISSING FAILING TEST:** `head posture rejects missing poller_heartbeats comments and last_cycle_at default after fresh provisioning`.

Specify literal expected table comment, column comment and `now()` default under 118's Oracle A, or equivalent independent behavior for the default. State exactly which assertions carry the shared F4 title; title presence alone is not mutation evidence. The added-claim assessment below explains the placement issue without reopening other suites.

### F5 — accepted column-metadata coverage remains incomplete

Plan lines 266–268 add `columnDefaults` and `columnComments`, so the old 118 invisibility counterexamples are fixed at the representation level. However, R1 F5 explicitly also requested identity/generated flags and generation expressions, with the exact missing test `readPublicCatalogue distinguishes column defaults, identity modes and generated expressions`. That portion was not implemented in the revised interface or otherwise narrowed by a recorded disposition.

Identity mode is not a default expression. `GENERATED ALWAYS AS IDENTITY` versus `GENERATED BY DEFAULT AS IDENTITY` can have identical name, type, nullability and ordinary default representation. A generated expression must also be read together with its generated-column status, rather than being assumed equivalent to an ordinary default. PostgreSQL records those distinctions in separate fields. [PostgreSQL 17 pg_attribute](https://www.postgresql.org/docs/17/catalog-pg-attribute.html).

**Remaining MISSING FAILING TEST:** `readPublicCatalogue distinguishes column defaults, identity modes and generated expressions`.

This is a remainder explicitly recorded in R1 F5, not a new demand to inventory unrelated object types. Add the metadata or explicitly revise the accepted preservation scope rather than marking the whole finding fixed.

### F6 — expressions do not constitute the complete policy definition

The new string at plan line 265 contains name, USING and WITH CHECK. It fixes R1's `USING (true)` example. R1 F6 also explicitly required roles, command and permissive/restrictive mode, and those remain absent.

An `ALTER POLICY ... TO ...` can change applicability while preserving name and both expressions. A same-name policy recreated for another command or with a different permissive/restrictive mode also has the same proposed serialization. These are policy-definition changes covered by the original finding. PostgreSQL exposes `polroles`, `polcmd` and `polpermissive` separately from `polqual` and `polwithcheck`. [PostgreSQL 17 pg_policy](https://www.postgresql.org/docs/17/catalog-pg-policy.html).

**Remaining MISSING FAILING TEST:** `assertOnlyTablesMoved rejects same-name policy role command and permissiveness changes`.

Serialize these dimensions using stable role names, including PUBLIC where appropriate. A pure fixture test with differing prebuilt strings cannot establish that the live reader includes the required dimensions; the plan's reader contract must include them too.

### F7 — grant principals and options are fixed; provenance is not

Plan lines 272 and 304–308 now specify every grantee, PUBLIC and grant options. Those were the two principal surviving mutations identified in R1 and are fixed in the planned representation.

R1 F7's accepted correction also called for grantor. The revised string still has no grantor field. Two ACL states can have the same grantee/privilege/column/grantability but a different grantor, leaving this representation unchanged despite different grant dependency/revocation provenance. This is not an effective-privilege or role-membership expansion; it is the missing `aclexplode` output field already named in R1.

**Remaining MISSING FAILING TEST:** `assertOnlyTablesMoved detects a changed ACL grantor with unchanged grantee privilege and grant option`.

Include stable grantor identity or explicitly narrow the accepted ACL-equality claim. F7 is PARTIAL rather than NO because its all-grantee and grant-option changes are correct.

### F9 — the decoy must coexist with an absent target

Plan lines 535–553 first drop the real constraint, apply 053 and restore it, then create the decoy **before the second apply**. At that point both the correct scoped lookup and the broken name-only lookup find an existing real `public.users.users_role_check`, so both skip ADD. Neither lookup modifies the decoy. The advertised negative case at 561–562 therefore does not follow from this fixture.

| State before apply | Correct scoped lookup | Broken name-only lookup | Distinguishes them? |
|---|---|---|---|
| Target absent, no decoy — first proposed apply | Adds target | Adds target | No |
| Target present, decoy present — second proposed apply | Skips ADD | Skips ADD | No |
| Target absent, decoy present — required collision arm | Adds target | Incorrectly skips ADD | Yes |

The second application is a valid idempotence test and deserves to remain. Put the decoy before an application in which the real constraint is absent, preferably in a separate rollback case. Retain R1's separate other-schema collision requirement as well as another relation in public. Take any noninterference baseline after creating the deliberate decoy, or explicitly account for it, so fixture changes are not attributed to the migration.

**Remaining MISSING FAILING TEST:** `re-applying 053 creates the missing public.users constraint despite same-named decoys on other relations and schemas`.

An in-memory truth-table check reproduced the three cases above. No database DDL was run for this verification.

### F10 — row cardinality is not row preservation

The new owner control at plan lines 537–543 correctly catches the original `UPDATE users SET role = 'admin'` mutant. That portion is fixed.

T5 lines 501–504 compare only the number of flag rows and call that an equivalent replacement for the old UPDATE/DELETE protection. Two original failure modes survive:

- With no seeded flag row, a fresh database has zero rows both before and after `DELETE FROM flagged_responses`.
- With populated rows, `UPDATE flagged_responses SET reason = 'changed'` preserves the count while mutating existing content. Delete-and-reinsert can preserve cardinality too.

R1 F10 explicitly asked for a representative nonempty flag fixture and comparison of its contents. It also asked for owner/admin control preservation in 053. The new admin fixture is seeded but its first-apply unchanged state is not explicitly asserted. “No row changes” on the second apply cannot establish that an idempotent unwanted change did not happen on the first apply.

**Remaining MISSING FAILING TEST:** `migration re-application preserves nonempty flag contents and owner and admin control rows`.

Seed valid nonempty data inside the rollback boundary; compare stable row identities and contents around the first apply, with the single permitted legacy role conversion. Preserve the existing owner-role check. This is the accepted data-preservation obligation, not a broader data audit.

## Why the YES dispositions are justified

### F2 and F3 — revocation is now challenged

T8 lines 671–679 use `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated` on the same transaction role that recreates the table. Those defaults apply to newly created objects, not existing tables. Consequently the recreated heartbeat table inherits client table rights, and omitting REVOKE leaves them visible in its ACL. Replacing REVOKE ALL with SELECT leaves non-SELECT privileges. Existing public tables are not retrospectively granted anything. The default-ACL catalogue itself changes inside the transaction, which is intentional; rollback restores it. This is consistent with the table-only noninterference assertion. [PostgreSQL 17 ALTER DEFAULT PRIVILEGES](https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html).

The reasoning assumes the stated same `tx`/current role throughout creation and apply; no SET ROLE or separate creator is proposed. A hostile-default control assertion remains a good way to demonstrate fixture setup, but the specific SQL now establishes the required adverse condition. R2-D1 must still be fixed for the shared helper to accept the dropped-table transition.

T8 lines 643–647 grant ALL on the existing 117 table. This includes the PostgreSQL 17 table privileges rather than only SELECT, fixing the old selective-revoke counterexample. The full grant arrays already planned in T2 can observe the residual rights.

### F8 — wrapper verification and audit exemption

T2 lines 319–343 specify private-sentinel identity, unchanged rethrow of other failures, and a dedicated `.integration.test.ts` using an INSERT inside the wrapper plus an outside observation that the row is absent. Success and failure cases reject accidental commit and swallowed errors; testing DML rollback is sufficient for this wrapper contract. A destructive heartbeat fixture is not required to establish transaction behavior.

The classification reasoning is correct for statically readable DML. In `scripts/ci/live-db-suites-audit.ts`, live helper imports make the file visible at 462–465, the integration suffix satisfies naming at 469–476, and the no-DDL return at 486–487 precedes migration allowlisting at 491. INSERT/SELECT are not DDL verbs. The suite can and should hold its promised shared lock even though this audit does not enforce a lock on DML-only files.

Implementation qualification: use tagged-template or literal readable DML. An opaque `.unsafe(queryVariable)` is deliberately treated as DDL by the existing audit, even when its runtime value happens to be an INSERT. That known detector boundary is not a newly discovered issue or a reason to add the suite to the migration allowlist.

### F11–F14 and intake bookkeeping

- **F11:** T4 lines 451–455 pin the UUID default and three FK definitions. T5 lines 496–499 pin the full typed/nullability column inventory, five FK definitions including SET NULL, and three CHECK definitions. These are the independent installed-schema replacements requested by R1 F11. The already acknowledged limitation of applying CREATE IF NOT EXISTS against an existing table is not reopened.
- **F12:** T2 adds `readMigrationSql returns every byte of an existing migration unchanged`, preserving the explicit no-trim/no-normalization contract. The implementation should use an existing content-rich fixture/known file without adding writes during this review; that is future implementation work.
- **F13:** T2 lines 315–317 and its added title explicitly include both appearing and disappearing unlisted tables, closing the intersection-only comparator counterexample.
- **F14:** T1 includes the runbook, env-vars description, vitest comment and already-scoped live-DB documentation alongside both service images, and adds the local/CI parity test. Parsed intake has **51 titles, all unique, and 37 surface entries**. Both intake JSON copies are identical. `.feature/state.json` records `surfaceAmendments: 1` and log entry `n: 1`, reason `auto-approved (1st amendment)`. Every intake title appears in the plan. There are 52 title-list occurrences because the F4 title is listed in T4 and T6, with explicit single execution placement.

## Three added claims

| Added claim | Verified? | Assessment |
|---|---|---|
| (i) Shared-title placement and once-only gate matching | PARTIAL | One occurrence is sufficient for the gate; collective T4/T5 head coverage is assigned, but T6's combined index/allowlist title does not specify the index assertion it owns. |
| (ii) Retirement of 057's two word bans | YES | T7 gives a specific semantic rationale and requires it in the header and weakened-checks justification. |
| (iii) Preservation of all 117 cases enumerated in R1 | YES | Every non-migration-text case named in R1 Q3(c) appears in T8's preserve-unchanged list. |

### (i) Presence is gate-compatible; assertion ownership still needs one clarification

`scripts/gate-promised-tests.sh:103–110` uses fixed-string search and succeeds on the first eligible test-file match. `scripts/verify-gate.sh:525–530` checks each promised title across the source/test roots, with no per-suite count or path requirement. `scripts/ci/__tests__/gate-promised-tests.test.ts:151–155` already covers a single matching fixture. Therefore exactly one occurrence of either long title is sufficient. No duplicate test or audit change is necessary.

The first title has an explicit collective implementation map: T4 owns the named test and 048 assertions; T5 carries the 051 half in its head-posture case. That is sound as aggregate suite coverage, although the T4 test alone should not be described as executing 051 assertions it does not contain.

For the second title, plan lines 476–478 place it in T6 “where both halves — an index predicate and a role allowlist — are available.” T6 is the 053 constraint migration; its enumerated assertions concern user roles and the role constraint. It neither names an index to assert nor says that the titled test reads 048/051's indexes. A full-public catalogue query makes such assertions possible, but is not itself an assertion. The independent index coverage lives in T4/T5. Make the mapping equally explicit: either the single titled case deliberately checks named index literals plus the role literal, or the title is a collective label with the index half expressly delegated to T4/T5. The gate will accept either arrangement; it cannot adjudicate meaning.

This is a clarification of the newly introduced shared-title wiring and F4's verification coverage, not a new unrelated finding. It does not negate the independent literal checks already required in T4/T5.

### (ii) The retirement reason is sufficient

T7 lines 613–618 identifies the exact assertions being retired and explains why arbitrary word occurrences in SQL do not identify catalogue behavior. It preserves the real nullability invariants through literal head assertions and requires the reason in both header and review justification. This addresses R1's request for an explicit retirement rather than a claim of fictitious catalogue equivalence.

`scripts/ci/weakened-checks-audit.ts:182–186` emits REVIEW for deleted test files; `:201–212` allows REVIEW-only results to pass and assigns the explanation to the reviewer. It does not require these lexical bans to survive or have an automatic one-for-one matcher. No quality-gate bypass is requested by this written semantic narrowing.

### (iii) 117 preservation map

| Existing 117 case | Revised T8 preservation |
|---|---|
| `:71` — REVIEWED_NOT_TENANT_SCOPED rationale and absence from TENANT_TABLES | First bullet at plan 651; includes the actor_user_id rationale check under “unchanged.” |
| `:133` — RLS true, FORCE false, zero policies, eight effective role privilege checks | Second bullet at 652. |
| `:185` — exact ten columns, types, nullability/defaults and no account column | Third bullet at 653. |
| `:209` — actor/event indexes with newest-first definitions | Fourth bullet at 654. |
| `:220` — FK update/delete NO ACTION and referenced-admin deletion rejected with named FK/23503 | Fifth bullet at 655. |
| `:241` — real writer persists exactly one row and round-trips metadata/payload | Sixth bullet at 656. |
| `:286` — missing actor rejected with named FK/23503 | Sixth bullet at 656. |

Nothing from R1's non-text preserve list is missing. The migration-text case at `:78` is intentionally replaced: RLS/policies/revocation get executing checks, and its actor-column/FK/deletion semantics retain the existing head and behavior cases. T8 also retains the instruction to explain any text-only obligation without a catalogue equivalent. No additional preservation finding is warranted.

## New, untriaged

None raised. Unchanged staging scope, historical transaction wording, unrelated migrations, and other prior qualifications were not reopened. This round's required revisions are confined to the accepted findings and the helper/shared-title changes introduced to address them.

The next revision should complete per-object degraded-state checks, make the dropped-table case legal, finish the already-requested catalogue dimensions, independently pin 118's expected comments/default, move the 053 decoy to the absent-target arm, and replace counts with nonempty row-content preservation. Keep the sound default-grant, GRANT ALL, wrapper-test, independent-literal and preservation-list changes.

VERDICT: REVISE
