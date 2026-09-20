# Plan review R1 — migration guard execution

**Can every promised test pass while the feature is still wrong? Yes.** Deleting migration 118's column comment or its `last_cycle_at` default is invisible to the proposed catalogue. All 37 promised tests can therefore pass without the advertised regression protection. Its REVOKE test also lacks a privilege precondition: on the documented fresh PostgreSQL test database, recreation gives the clients no grants anyway. These are defects in the proposed definition of done, not objections to executing migrations instead of parsing their text.

**VERDICT: REVISE.** Review target: the plan and locked intake supplied in `.feature/plan-review-brief.md`; repository HEAD `d79bc765ce630ea651efe67ec6a7b3488c5afa86`, reviewed 2026-09-20. The plan is unimplemented. Existing untracked intake, plan, and deviations documents were preserved. The brief was the source for the plan, intake, quoted excerpts, and seven migrations; they were not re-derived from repository copies. Filesystem reads below checked uncovered mechanisms and the old assertions. One delegated, read-only investigation answered Q2 only.

This report is the only file written. No migration, mutation, provisioning, deployment, or test implementation was run. A read-only local database query confirmed PostgreSQL 17.11, zero table-default-ACL entries for the owning role, owner-only `poller_heartbeats` ACL, no user-defined `users` triggers, and zero current NULL-bearing rows in the five 057 target columns. Those observations support specific conclusions below; they are not an execution of the proposed tests.

## Findings at or above 80% confidence

P1 means a security/regression control can pass while its promised behavior is wrong. P2 means a material coverage or preservation gap. Every behavioral finding is expressed as a **MISSING FAILING TEST**, with its exact proposed title.

| ID | Severity | Plan section | One-line finding | MISSING FAILING TEST — exact title |
|---|---|---|---|---|
| F1 | P1 | §3, T2, T4–T8, §7 | Any target-table difference satisfies the vacuity check, even when the property under test was never degraded. | `assertDegradeLanded rejects an unrelated table change when the guarded property remains intact` |
| F2 | P1 | T8 / 118, §7 | Dropping 118's table never challenges client revocation; normalized ACL equality can pass with REVOKE removed. | `re-applying 118 revokes every client privilege inherited from permissive default ACLs` |
| F3 | P1 | T8 / 117 | Granting only SELECT cannot distinguish REVOKE ALL from REVOKE SELECT. | `re-applying 117 revokes every PostgreSQL 17 table privilege from both client roles` |
| F4 | P1 | T4–T6 / BEFORE oracle | Fresh provisioning can copy a regressed index predicate or role allowlist into both sides of the equality assertion. | `migration guards reject weakened index predicates and role allowlists on a freshly provisioned database` |
| F5 | P2 | T2 catalogue, T8 / 118 | Column defaults and column comments are absent, so 118 does not prove every object it declares. | `re-applying 118 restores the last_cycle_at default and column comment` |
| F6 | P1 | T2 catalogue, T3–T8 noninterference | Changing an existing policy's definition without renaming it is invisible on every other public table. | `assertOnlyTablesMoved rejects a same-name policy definition change on an unlisted table` |
| F7 | P2 | T2 catalogue / grants | Privilege strings omit grant options and the role filter omits other grantees, so ACL equality is incomplete. | `assertOnlyTablesMoved detects grant-option changes and grants to roles outside the client-role list` |
| F8 | P1 | T2 rollback wrapper | No promised test rejects a wrapper that swallows assertion or database errors, turning executing failures into passes. | `withRolledBackTransaction preserves callback errors and rolls back successful and failed callbacks` |
| F9 | P1 | T6 / 053; deleted 053 suite | The single absent-constraint fixture does not test relation/schema scoping or a second apply with the constraint present. | `re-applying 053 is idempotent and ignores same-named constraints outside public.users` |
| F10 | P1 | T5–T6; deleted 051/053 suites | Catalogue equality cannot detect row deletion or an UPDATE that promotes existing owners to admins. | `migration re-application preserves existing rows except the intended sales_partner conversion` |
| F11 | P2 | T4–T5; deleted 048/051 suites | The replacement head contracts omit previously guarded defaults and foreign keys, and 051's explicit column inventory. | `head posture pins migration 048 defaults and foreign keys and migration 051 columns and foreign keys` |
| F12 | P2 | T2 migration reader | The missing-file test does not prove that an existing file is returned verbatim. | `readMigrationSql returns every byte of an existing migration unchanged` |
| F13 | P2 | T2 catalogue diff | The two diff tests do not exercise an unlisted table appearing or disappearing. | `assertOnlyTablesMoved rejects newly created and dropped unlisted tables` |
| F14 | P2 | T1 | The canonical local E2E command remains on PostgreSQL 16 while promising CI parity. | `local E2E setup uses the same PostgreSQL 17 image as both CI database services` |

### F1 — MISSING FAILING TEST: `assertDegradeLanded rejects an unrelated table change when the guarded property remains intact`

The helper's specified predicate is only `before.tables[TABLE] !== degraded.tables[TABLE]`. It proves at least one represented attribute changed. It proves neither which attribute changed nor that every intended degrade landed.

A concrete 048 counterexample, on an already provisioned correct database:

```sql
-- Incorrect degrade: it removes ordinary indexes but leaves the security
-- property, the unique active-actor index, intact.
DROP INDEX idx_impersonation_actor_started;
DROP INDEX idx_impersonation_impersonated_started;
DROP INDEX idx_impersonation_account_started;
ALTER TABLE impersonation_sessions DISABLE ROW LEVEL SECURITY;
```

Now remove creation of `idx_impersonation_active_actor` from 048. The retained unique index already enforces one active session per actor; the real migration restores the three dropped indexes and RLS. Both the aggregate degrade check and whole-table equality pass. A typo such as `DROP INDEX IF EXISTS idx_impersonation_active_actors` produces exactly this class of no-op on the guarded object while other drops perturb the table. Equivalent failures exist when one of 051's indexes, one 117 client grant, or one of 057's five columns is never degraded.

Even a single-property claim can be bypassed by changing something the migration restores independently: for 048, degrading its table comment while leaving RLS enabled permits an RLS-removal mutant to pass. The assertion that something changed is not property-specific negative evidence.

Require the degraded snapshot to show each exact missing index, each RLS bit false, each seeded privilege present, each targeted constraint absent, or all five 057 columns NOT NULL before executing the migration. For 118, absence of the table is sufficient evidence for recreation, but says nothing about the privilege precondition in F2.

**Q1(b):** Before/after equality proves an observed endpoint, not attribution. With property-specific negative evidence, only `tx.unsafe(readMigrationSql(...))` between observations, and exclusion of concurrent DDL, attributing restoration to executing that SQL is reasonable. As written, a property can stay correct throughout while the migration restores an unrelated part of the same table. No concurrent actor is needed to defeat the assertion.

### F2 — MISSING FAILING TEST: `re-applying 118 revokes every client privilege inherited from permissive default ACLs`

`DROP TABLE` removes an object; it does not grant privileges on its replacement. `scripts/ci/test-db-bootstrap.sql:14–51` creates the client roles and grants schema USAGE, but creates no permissive table-default ACL. Migration 122's default-ACL statements at `supabase/migrations/122_client_role_grant_sweep.sql:103–112` revoke rights, not grant them. The read-only query against this worktree's 17.11 database returned **zero** table-default-ACL entries for the owner and `{test=arwdDxtm/test}` for the heartbeat table.

Thus deleting `REVOKE ALL ON poller_heartbeats FROM anon, authenticated` from 118 still recreates a table whose effective privileges belong only to its owner. With the cited 122 reader's normalization (`aclexplode(coalesce(c.relacl, acldefault('r', c.relowner)))`, `migration-122-client-role-grant-sweep.integration.test.ts:206`), both head privilege tests and all snapshots pass. The plan's §7 claim that enumerating grants makes the REVOKE assertion meaningful regardless of bootstrap posture confuses observing absence with proving a revoke caused it.

There is a serialization qualification: a reader that explodes raw `relacl` without normalizing NULL could instead notice that omitting REVOKE leaves a NULL ACL, whereas executing it materializes the owner's default ACL. That incidental difference can make the deletion mutant fail. The plan does not specify this raw-ACL requirement, and it would still not test client revocation: replacing ALL with SELECT can materialize the same owner-only ACL while proving nothing about any other client privilege. The independent permissive-default fixture is needed under either serialization. This review does not claim an unimplemented reader has already passed the mutant.

Inside the rollback transaction, set permissive owner default privileges for both client roles before recreation, and prove those privileges would be inherited by a control creation. Then execute the whole unmodified file and require all client privileges absent. Restore those defaults through rollback. Alternatively choose a separate explicit-grant degrade on the existing table for the revoke property. Include every table privilege supported on 17, including MAINTAIN. The table's absence is still separately useful for its creation contract.

### F3 — MISSING FAILING TEST: `re-applying 117 revokes every PostgreSQL 17 table privilege from both client roles`

117's degrade grants SELECT only. Replacing its `REVOKE ALL` with `REVOKE SELECT` then restores the exact baseline, while INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER and MAINTAIN revocation is untested. The cold test bootstrap and later 122 sweep can also leave head without those privileges, so head posture does not close the hole. Seed and verify all server-supported table privileges for each client, then require their removal. PostgreSQL 17's table privilege vocabulary includes MAINTAIN. [PostgreSQL 17 REVOKE](https://www.postgresql.org/docs/17/sql-revoke.html).

### F4 — MISSING FAILING TEST: `migration guards reject weakened index predicates and role allowlists on a freshly provisioned database`

The BEFORE snapshot is not an independent expected specification when CI builds the database from the same changed migration. For example, mutate 048's active-actor index predicate to `WHERE ended_at IS NOT NULL`. On an empty newly provisioned database, the wrong index exists under the right name. The proposed head contract checks RLS and columns; schema readiness checks named object existence. Drop/reapply now reconstructs that same wrong index and equality passes. The same applies to 051's unique-open-response predicate.

For 053, broadening the CHECK to allow `sales_partner` can likewise populate the baseline with the broader constraint; the seeded row still converts because the UPDATE remains correct. A head assertion that merely finds `users_role_check` is not an independent allowlist assertion. `schema-ready.ts:453–457` explicitly documents that presence by name cannot establish a constraint's definition.

Pin the intended index columns, uniqueness and predicates, and the role allowlist, independently of the current database snapshot. Behavioral duplicate-insert/rejected-role cases are suitable. Require mutation evidence in both modes: a pre-existing correct database and a fresh database provisioned from the changed file. This preserves the advantages of catalogue diffs without making the migration its own oracle.

### F5 — MISSING FAILING TEST: `re-applying 118 restores the last_cycle_at default and column comment`

`CataloguedTable.columns` contains only name, type and nullability. `comment` is the table's `obj_description`. Removing 118's `COMMENT ON COLUMN` leaves every represented field identical, contradicting T8's explicit promise that removing either comment must fail. Removing `DEFAULT NOW()` from `last_cycle_at` is also invisible: the recreated column remains `timestamptz NOT NULL`, with the same primary key and table comment.

Capture column comments separately and include default expressions. Also represent `attidentity`, `attgenerated` and generation expressions: they are not encoded by the proposed column strings. The corresponding additional **MISSING FAILING TEST** is `readPublicCatalogue distinguishes column defaults, identity modes and generated expressions`. Those flags are distinct PostgreSQL column properties, not implied by a type or NOT NULL. [PostgreSQL 17 pg_attribute](https://www.postgresql.org/docs/17/catalog-pg-attribute.html). This is an observer gap even when the degrade and transaction are perfect.

### F6 — MISSING FAILING TEST: `assertOnlyTablesMoved rejects a same-name policy definition change on an unlisted table`

The catalogue records only sorted policy names. Appending `ALTER POLICY users_self_select ON users USING (true)` to 049 changes another table's access policy without changing any policy name, column, index, constraint, grant or RLS flag. The legitimate 049 restoration still succeeds, and every proposed catalogue equality accepts the unrelated security change. The existing `users_self_select` policy is established by `supabase/migrations/006_users_rls_policy.sql:10`.

Record policy command, roles, permissive/restrictive mode, USING and WITH CHECK definitions, with stable expression rendering. PostgreSQL stores these separately from the policy name. [PostgreSQL 17 pg_policy](https://www.postgresql.org/docs/17/catalog-pg-policy.html). Zero-policy assertions on the seven target tables are useful, but do not protect policies on other tables in the full-public snapshot.

### F7 — MISSING FAILING TEST: `assertOnlyTablesMoved detects grant-option changes and grants to roles outside the client-role list`

The promised strings omit `is_grantable` and grantor, and filter grantees to anon, authenticated, service_role and the session role, with an explicit PUBLIC special case. Elevating an already represented grant to WITH GRANT OPTION yields the same `<role>:<privilege>` string. A grant to another existing role is outside the promised list. Both violate a claim of unchanged ACLs without changing the snapshot.

Record every ACL entry's grantee, privilege, grantability and grantor using stable names, or explicitly narrow the claimed invariant. Include grantee OID 0 as PUBLIC without an inner join that drops it. Table and column ACLs must stay distinct; inherited/effective role access is a separate question from enumerating direct ACLs. PostgreSQL provides separate privilege checks for grant options and for effective column access. [PostgreSQL 17 privilege inquiry functions](https://www.postgresql.org/docs/17/functions-info.html#FUNCTIONS-INFO-ACCESS-TABLE).

### F8 — MISSING FAILING TEST: `withRolledBackTransaction preserves callback errors and rolls back successful and failed callbacks`

None of T2's five tests invokes the transaction wrapper. A wrapper with `catch {}` instead of rethrowing non-sentinel errors makes assertion failures inside the executing callback resolve successfully. Head posture can remain correct on a preprovisioned database; all pure helper tests still pass. This is a direct route to all executing cases going green while the migrations fail to restore their properties.

Test success and failure paths, including original error identity, and observe state after the transaction from outside it. Include a pre-existing heartbeat row so a mistakenly committed drop/recreate is observable, not hidden by an empty table and OID-free snapshot. The test needs to establish rollback as well as successful callback execution. Module-private sentinel identity must be the only swallowed error.

### F9 — MISSING FAILING TEST: `re-applying 053 is idempotent and ignores same-named constraints outside public.users`

The planned fixture drops `public.users.users_role_check` and seeds one legacy role. A mutant that removes the relation/schema predicates but retains `WHERE conname = 'users_role_check'` still works if there is no decoy constraint. The deleted suite explicitly checks relation scoping at `migration-053-structure.test.ts:40–42`. Create a same-named constraint on another relation, and separately in another schema, before the apply; public.users must still receive its own constraint.

Likewise, removing the IF-NOT-EXISTS guard still works in the one absent-constraint apply. Apply again without dropping the restored constraint and assert unchanged rows/catalogue. This is the semantic replacement for the old guard-presence and single-UPDATE checks at lines 24–38. Counting one UPDATE never proved idempotency, but deleting that weak check is not evidence that the replacement tests it.

### F10 — MISSING FAILING TEST: `migration re-application preserves existing rows except the intended sales_partner conversion`

Append `DELETE FROM flagged_responses` to 051: it changes no catalogue entry. On an empty database it trivially passes; on a populated database it can delete rows inside the transaction while all planned snapshots still pass. Rollback protects the test container, but the test has failed to reject a destructive production migration. The deleted 051 suite rejects UPDATE and DELETE text at lines 62–65.

For 053, replacing `UPDATE users SET role = 'admin' WHERE role = 'sales_partner'` with an unqualified UPDATE still converts the one seeded sales_partner and restores the constraint. It also promotes every owner, which the proposed single-row assertion never observes. Seed owner and admin controls plus legacy rows and require the intended exact row delta. For 051, seed a representative valid flag and verify its contents survive the apply, before rollback. Catalogue noninterference cannot substitute for data noninterference.

### F11 — MISSING FAILING TEST: `head posture pins migration 048 defaults and foreign keys and migration 051 columns and foreign keys`

T4 explicitly promises head columns, but not 048's UUID fallback/default or its three FK definitions. The default is absent from the generic catalogue; the FK definitions are observed only for equality against an already provisioned baseline. T5 explicitly promises CHECK constraints, but not the old 13-column inventory or five FK targets and `api_cost_id ON DELETE SET NULL` behavior. The latter prevents the api-cost retention prune from being blocked.

The skipped CREATE TABLE body is an honest, stated limitation for verbatim reapplication. It does not make deletion of these independent guards coverage-neutral. Retain equivalent explicit head assertions, and document separately that they prove the installed schema rather than an edited historical CREATE TABLE on a stale container. A stronger file-specific creation test would need an isolated creation environment; it must not destructively rebuild shared head tables in place.

### F12 — MISSING FAILING TEST: `readMigrationSql returns every byte of an existing migration unchanged`

The sole reader test exercises a missing filename. A reader that throws for missing files but returns cached SQL, strips comments, trims text, or normalizes whitespace for existing files passes it. Unchanged migrations can still execute successfully, so the integration tests do not prove the locked verbatim-read invariant either. Test an existing fixture with meaningful newlines, comments, dollar-quoted text and trailing bytes, comparing directly to its known complete contents. This is a reader contract test, not a return to parsing migrations for security properties.

### F13 — MISSING FAILING TEST: `assertOnlyTablesMoved rejects newly created and dropped unlisted tables`

The planned negative fixture changes an existing unlisted table. An implementation that compares only the intersection of before/after names passes both promised diff tests yet misses new or removed tables. The unmodified seven migrations do not supply those negative examples either. Add separate appearance/disappearance fixtures, excluding only explicitly allowed names. This closes the plan's own stated table-set invariant rather than broadening it to unrelated object types.

### F14 — MISSING FAILING TEST: `local E2E setup uses the same PostgreSQL 17 image as both CI database services`

`docs/runbooks/e2e-local-setup.md:3` promises the same setup as CI, but its executable Docker command at `:11` pins postgres:16. `scripts/test-db-setup.sh:107` directs developers to that recipe. T1's exact both-workflows=17 test cannot detect this local/CI mismatch. Update the active recipe and its parity check. This is a reproducibility and MAINTAIN-coverage gap; no database-cache bump or PostgreSQL 17 runtime incompatibility was established.

## Q1 — all 37 promised test titles

“Yes” below means the title can pass while a relevant promised guard is wrong, under the concrete failure classes above. It does not mean a registry or setup test is individually responsible for proving a migration. “Scoped” identifies a useful check whose limited purpose should not be mistaken for the whole definition of done. Full target equality in 057 is interpreted charitably as comparing all three target tables, in addition to permitting those three in the noninterference check.

| # | Promised title, verbatim | Can pass while the feature is wrong? Why |
|---|---|---|
| 1 | `the test job and the e2e job pin the same postgres major` | Yes, scoped: pins 17 correctly, but none of F1–F13 depends on running 16. It does not inspect other service keys. |
| 2 | `assertDegradeLanded throws when the target table did not change` | Yes: F1's partially degraded table differs. |
| 3 | `assertDegradeLanded passes when the target table lost an index` | Yes: it positively accepts F1's unrelated-index counterexample. |
| 4 | `assertOnlyTablesMoved throws when an unlisted table changed` | Yes: a hand-built changed field does not exercise the live reader's invisible fields, F6/F7, or missing table-set cases F13. |
| 5 | `assertOnlyTablesMoved passes when only the named table changed` | Yes: correct positive case; says nothing about F6/F7/F13 negative cases. |
| 6 | `readMigrationSql throws when the migration file is missing` | Yes: F12 returns transformed/cached SQL for existing files. |
| 7 | `migration 049 suite is registered in MIGRATION_SHAPE_FILES` | Yes, scoped: registration can be correct while F6 admits unrelated policy damage. |
| 8 | `analytics_events carries row security enabled at head` | Yes: a correct installed head is independent of an edited file; F8 can swallow the subsequent executing failure. Its explicit true/zero-policy assertions are otherwise useful. |
| 9 | `re-applying 049 restores row security after it is disabled` | With the exact DISABLE, faithful reader and error propagation, removing ENABLE fails. It can still pass with F6's unrelated policy change, or F8 swallowing its assertion. |
| 10 | `re-applying 049 moves no other table in public` | Yes: F6 same-name policy alteration is invisible. |
| 11 | `migration 048 suite is registered in MIGRATION_SHAPE_FILES` | Yes, scoped: F1/F4/F11 do not affect membership. |
| 12 | `impersonation_sessions carries row security enabled at head` | Yes: RLS and planned column checks do not pin the partial-index predicate or F11's omitted default/FKs. |
| 13 | `re-applying 048 restores the guarded indexes after they are dropped` | Yes: F1's retained unique index, or F4's freshly provisioned bad predicate, passes. |
| 14 | `re-applying 048 moves no other table in public` | Yes: it deliberately excludes the target, and misses F6/F7 on other tables. |
| 15 | `migration 051 suite is registered in MIGRATION_SHAPE_FILES` | Yes, scoped: membership is independent of F4/F10/F11. |
| 16 | `flagged_responses carries row security enabled and no policy at head` | Yes: even retaining the promised CHECK assertions leaves F4's index predicate and F11's FK/column inventory uncovered. |
| 17 | `re-applying 051 restores the guarded indexes after they are dropped` | Yes: F4's bad baseline or F10's appended DELETE leaves the expected represented schema. |
| 18 | `re-applying 051 moves no other table in public` | Yes: F10 deletes data without any table-shape change; F6/F7 also apply. |
| 19 | `migration 053 suite is registered in MIGRATION_SHAPE_FILES` | Yes, scoped: membership does not exercise F9/F10. |
| 20 | `users carries the users_role_check constraint at head` | Yes: name presence is compatible with F4's weakened CHECK; even an exact head CHECK does not test F9's conditional lookup. |
| 21 | `re-applying 053 restores users_role_check after it is dropped` | Yes: unscoped lookup with no decoy, or unconditional ADD on the sole apply, passes (F9). |
| 22 | `re-applying 053 converts a stray sales_partner row to admin` | Yes: UPDATE-all promotes the fixture and all owners (F10). |
| 23 | `re-applying 053 moves no other table in public` | Yes: owner rows and policy predicates can change with the same represented shape, F10/F6. |
| 24 | `migration 057 suite is registered in MIGRATION_SHAPE_FILES` | Yes, scoped: membership does not establish all five degrades. |
| 25 | `the five tombstone columns are nullable at head` | Yes: a previously correct database still has five nullable columns if the historical file is edited; F1 can leave the removed clause's column nullable throughout. |
| 26 | `re-applying 057 restores nullability after NOT NULL is reinstated` | Yes under F1's incomplete degrade. With all five NOT NULL transitions explicitly proven and all three tables compared, deleting any clause does fail. |
| 27 | `re-applying 057 moves no other table in public` | Yes: whitelist alone proves no restoration on its three allowed targets; F6/F7 remain invisible elsewhere. |
| 28 | `migration 117 suite is registered in MIGRATION_SHAPE_FILES` | Yes, scoped: F3 does not change membership. |
| 29 | `admin_audit_log carries row security enabled and no policy at head` | Yes: REVOKE SELECT mutant in F3 still leaves RLS and policies correct. |
| 30 | `admin_audit_log grants no privilege to anon or authenticated at head` | Yes: cold bootstrap and 122 can supply this state independently of the historical REVOKE ALL (F3). |
| 31 | `re-applying 117 restores the revoked client grants after they are granted` | Yes: SELECT-only seed proves SELECT-only revocation, F3. |
| 32 | `re-applying 117 moves no other table in public` | Yes: says nothing about unchallenged target privileges and misses F6/F7. |
| 33 | `migration 118 suite is registered in MIGRATION_SHAPE_FILES` | Yes, scoped: registration survives F2/F5. |
| 34 | `poller_heartbeats carries row security enabled and no policy at head` | Yes: F2/F5 leave RLS and policy count unchanged. |
| 35 | `poller_heartbeats grants no privilege to anon or authenticated at head` | Yes: F2's cold defaults already deny privileges. |
| 36 | `re-applying 118 restores the table after it is dropped` | Yes: F2's omitted REVOKE and F5's omitted default/comment all pass the proposed equality. |
| 37 | `re-applying 118 moves no other table in public` | Yes: target omissions F2/F5 are excluded from this check; F6/F7 remain invisible on other tables. |

### Q1(c) — what the catalogue can and cannot see

| Property requested in the review | Represented? | Consequence |
|---|---|---|
| Partial-index predicate, key columns and uniqueness | Yes, in full `pg_get_indexdef(index_oid)` output | Do not flag a serialization omission. F4 is an oracle problem even with perfect rendering. Do not request just one index column's definition. |
| Index opclass and collation | Yes, full index decompilation represents nondefault index semantics | Defaults can be omitted canonically; meaningful changes to a nondefault definition are distinguishable. |
| Constraint definition, FK actions and deferrability | Yes, full `pg_get_constraintdef` includes applicable deferrability and actions | Do not confuse omitted column properties with an omitted FK definition. A fixture should establish the query uses full definitions. |
| Column name/type/NULL status | Yes | Preserve complete type rendering, including typmods. |
| Column default, identity and generated-ness/expression | No | F5; also limits whole-public noninterference. |
| Table ACL and column ACL | Partially | Both sources are promised, but grant options/grantor and non-enumerated grantees are absent (F7). |
| PUBLIC ACLs | Intended to be yes | `aclexplode` exposes grantee 0; it must be explicitly preserved despite the named-role filter. The plan says to do so; an implementation bug here is not presumed. |
| `relforcerowsecurity` | Yes | `forceRowSecurity` is already in the interface. No omission finding. |
| Policy definitions | No | Names only; F6. |
| Table comments | Yes | A dropped/recreated 118 table with its table comment removed differs. On 048/051/117, removing a COMMENT statement without degrading the existing comment is another instance of F1. |
| Column comments | No | Removing 118's column comment cannot fail this snapshot, F5. |
| Effect of `REVOKE ALL ON poller_heartbeats FROM anon, authenticated` | The final direct privileges can be observed; causation is not established | Cold defaults make the statement redundant in the test environment, F2. |

The distinction between full index/constraint decompilation and separate column/comment metadata follows PostgreSQL's catalogue functions. [PostgreSQL 17 system catalogue functions](https://www.postgresql.org/docs/17/functions-info.html#FUNCTIONS-INFO-CATALOG-TABLE).

`relkind IN ('r','p')` deliberately excludes sequences, views and foreign tables; the interface also omits functions, triggers, owners and default ACLs. It must not be described as a byte-for-byte database snapshot. No finding assumes these seven current migrations secretly operate on such objects. The demonstrated table-policy and column-default counterexamples already defeat the stated table-level invariant.

### Q1(d) — concurrency and the noninterference assertion

**No interleaving defect found among the seven correctly enrolled suites.** `acquireLiveDbLock` acquires an exclusive session advisory lock on a dedicated max-one connection (`helpers/live-db-lock.ts:106–140`), and its release explicitly unlocks and closes that connection (`:143–161`). The suite holds it across all executing transactions and releases it after closing the test client. Other suites following the same protocol cannot commit competing DDL between these snapshots. RLS audit readers take the shared version of the same lock.

057 and 048 touching the same table therefore does not itself produce a race. 057 must compare all three target snapshots for restoration and permit those same three names in `assertOnlyTablesMoved`; the latter alone intentionally ignores all changes to those targets. Normal concurrent row writes do not alter these catalogue fields. An external writer that ignores the lock protocol is outside the claimed seven-suite interleaving, discussed only in the low-confidence appendix.

## Q2 — cited artifacts and mechanism checked against HEAD

| Check | Verdict | Filesystem evidence and interpretation |
|---|---|---|
| Existing cited artifact paths | VERIFIED | The two workflows, CI wiring suite, live-DB audit and its suite, `schema-ready.ts`, `live-db-lock.ts`, `describe-with-db.ts`, and 119/122 suites exist. The five old suites and 117 were read for uncovered assertion coverage. Planned new paths are intentionally future files. |
| Absent MIGRATION_SHAPE_FILES entries | VERIFIED | `scripts/ci/live-db-suites-audit.ts:540–553` obtains tracked paths with `git ls-files` and loops those paths. It does not iterate the allowlist or require every member to exist. The line-491 membership check is not the whole proof; this discovery path is. A tracked file removed from disk but still in the index is different: reading it can fail. |
| Lock enforcement on every abstract set member | QUALIFIED | `:459–487` returns early for NOT_LIVE_DB, missing live-DB marker, or no detected DDL. Only then does `:504–506` require an `acquireLiveDbLock` text marker. Membership by itself does not guarantee a check runs, and text presence does not prove acquisition order or successful locking. |
| Lock enforcement on these seven proposed suites | VERIFIED | Their helper marker, integration suffix and opaque `tx.unsafe(readMigrationSql(...))` qualify them. Opaque unsafe arguments are treated as DDL at `:385–395`, `:415–418`; all seven explicitly acquire the lock under the plan. No additional exemption is needed. |
| Helper stays outside MIGRATION_SHAPE_FILES | VERIFIED IN DESIGN | SELECT catalogue reads and `begin` are not DDL. Keeping opaque unsafe calls in the actual suites preserves the audit's current conservative boundary. |
| Pinned postgres.js | VERIFIED | `package.json:85` specifies `^3.4.9`; `pnpm-lock.yaml:3637` resolves 3.4.9. Installed source is the resolved version used for the following check. |
| Multi-statement transaction-free `tx.unsafe` inside `begin` | VERIFIED | `node_modules/postgres/src/index.js:119–125` selects simple protocol for unsafe with no bound args. `:234–245`, `:291–304` reserve a connection and bind the transaction handle to it. `connection.js:605–606` throws UNSAFE_TRANSACTION only for a BEGIN command tag on a non-reserved connection with max other than one. Neither condition bites this plan; max-one is also conservative. The 119 comment does not prohibit this use. |
| Migration 053 DO block detection | VERIFIED | The actual planned opaque unsafe call is conservatively DDL. If literal SQL were visible instead, the unanchored DDL regex at `live-db-suites-audit.ts:258–259` sees the inner ALTER TABLE; dollar-quoted DO bodies are not discarded. DO containing only DML is not classified merely for being DO. |
| Seeded 053 user versus tenant audit | VERIFIED | `scripts/ci/tenant-scope-audit.ts:1413–1418` excludes `__tests__` and test/spec paths. The fixture does not need a tenant-scope exception. Nullable account_id is established by 039; the supplied required user fields agree with `001_initial_schema.sql:44–58` and subsequent user changes. |
| Seeded 053 user versus RLS audit | VERIFIED | `scripts/ci/rls-audit.ts:44–51`, `:72–76`, `:170–175`, `:193–220` scan migration RLS declarations/read catalogue posture and coordinate with the shared advisory key. They do not lint fixture INSERTs. The local owner can seed the row. |
| PostgreSQL image pins | VERIFIED | Active service pins are exactly `.github/workflows/ci.yml:282` and `e2e.yml:71`. The wiring precedent is at `ci-audit-wiring.test.ts:203`. No additional executable version-16 service pin was found in active CI/provisioning/E2E paths. |
| Cache compatibility | VERIFIED | `.github/actions/setup/action.yml:31` caches Node/pnpm. `e2e.yml:117` and `cache-warm.yml:47` key Playwright by OS/architecture/version. No persistent PostgreSQL data cache or major-16 database cache key was found. `.github/actions/test-db/action.yml:30–34` delegates to version-neutral provisioning. |

Two factual qualifications belong in the revised plan, but are not additional behavioral findings:

- “Only 119” contains BEGIN/COMMIT is false as a repository-wide statement. Outside the supplied seven, examples include `122_client_role_grant_sweep.sql:68,116`, `121_operator_refusals.sql:8,53`, and `120_owner_operator.sql:56,161`, plus earlier migrations. The operative narrower fact remains true: none of the seven supplied files contains transaction control. This correction does not invalidate their wrapping.
- “No migration after 118 alters it” is too broad: 122's ON ALL TABLES sweep at lines 90 and 111 includes `poller_heartbeats`. On the documented fresh bootstrap the table already lacks those client rights, so this does not demonstrate a failed recreation equality or unsafe rollback. The justification should concern actual head properties, not absence of later statements.

Remaining major-version references also need ordinary documentation reconciliation. `docs/runbooks/e2e-local-setup.md:11` still instructs users to start `postgres:16`; `.claude/rules/live-db-tests.md:23`, `.claude/reference/env-vars.md:88`, and `.claude/reference/lab-notes/live-db-test-suites.md:26` describe CI as 16. These are verified stale-after-change instructions, not evidence that 17 breaks runtime behavior. Historical records need not be rewritten. No unproved version incompatibility is included in the findings table.

**Executed mechanism probes:** Installed postgres.js 3.4.9, configured with max:4 and prepare:false, executed two SELECT statements in one `tx.unsafe` inside `db.begin('read only', ...)`. Both result sets used the same backend; values 1 and 2 were returned; throwing a private sentinel rolled back and preserved error identity. The existing audit was also exercised in memory: an allowlisted SELECT-only file without a lock marker passed; literal UPDATE plus DO/ALTER and opaque unsafe each produced unlocked-ddl without a marker; adding the acquireLiveDbLock marker passed. TSX caching was disabled. An initial native Node import failed on an extensionless TS dependency, then the installed TSX loader succeeded. These are bounded mechanism checks, not implementation-suite verification. No full test/build or browser verification is claimed for an unimplemented plan.

## Q3 — invariants, deletion equivalence and authority

### Q3(a) — rollback and nontransactional effects

For the **specified degrades**, transactional rollback is the right mechanism: DROP INDEX, DISABLE RLS, GRANT, DROP CONSTRAINT, SET NOT NULL and DROP TABLE are transactional. The seeded 053 row supplies its UUID explicitly; the local users table has no user-defined trigger. None of the supplied seven migration bodies or prescribed degrades calls nextval/setval or takes its own session advisory lock. 118 has a text primary key, not a sequence. Thus there is no demonstrated sequence leak in the actual proposed fixtures.

Rollback is not a universal database-reset mechanism. Existing-sequence nextval/setval effects are not undone; session advisory locks survive rollback and require release or session termination. The outer lock's explicit finally/release is therefore essential, and the current lock helper does supply it. PostgreSQL also consumes transaction/object identifiers and writes internal state during rolled-back work, so “byte-identical” should mean unchanged committed application data and relevant logical catalogue, not identical physical database bytes. [PostgreSQL sequence semantics](https://www.postgresql.org/docs/17/functions-sequence.html), [PostgreSQL advisory-lock semantics](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS).

The actionable missing protection is F8: the plan has no test demonstrating its new wrapper preserves errors and actually rolls back. No hypothetical sequence mutation was run against the shared database to manufacture a finding.

### Q3(b) — 057 NULL precondition

The specified check is sound for the serialized cooperating suite population. Checking all five columns within the same transaction observes the current fixture, and SET NOT NULL itself validates the data while taking the required table lock. A pre-existing NULL must produce an explicit fixture-incompatibility failure, not a skip or an automatic data rewrite. The local read-only query found zero such rows at review time; this is not a permanent assumption about future runs.

The same transaction alone does not prevent an unrelated session from inserting NULL between a SELECT and ALTER at READ COMMITTED. In that situation PostgreSQL rejects SET NOT NULL rather than admitting an invalid constraint. Translate that database error into the same named setup failure if robust diagnostics for non-cooperating writers are wanted, or acquire the relevant table locks before the precheck. This is not an interleaving among the seven shared-lock holders, nor a demonstrated current flake. Separately, F1 requires proving **all five** NOT NULL changes landed before apply.

### Q3(c) — complete old-assertion equivalence audit

Paths in this table are under `src/lib/shared/__tests__/`. Each group accounts for the assertions in all five deleted suites and in the existing 117 suite. “Installed equivalent” means it tests provisioned head; it does not magically execute a skipped CREATE TABLE body from an edited file.

| Existing file and assertion location | What was asserted | Equivalent in the proposed design / required stated reason |
|---|---|---|
| `migration-048-impersonation-sessions.test.ts:12` | CREATE TABLE IF NOT EXISTS | Existing-table reapply would fail on unconditional CREATE; deleting CREATE altogether can pass on an existing head. State the historical-create limitation. |
| Same, `:13` | UUID primary key and `gen_random_uuid()` fallback | Generic constraints can observe PK, but head columns alone do not pin PK/default and generic columns omit defaults. F11. A reason is owed for the lost explicit fallback guard. |
| Same, `:14–16` | Three UUID, NOT NULL FK columns and targets | Column types/current nullability can be pinned at head. 057 intentionally makes account_id and impersonated_user_id nullable, so original NOT NULL text assertions cannot be copied literally. Three exact FK assertions are not promised by T4; F11. State the later-057 reason for nullability translation. |
| Same, `:17–19` | ticket_id/reason TEXT NOT NULL; expires_at TIMESTAMPTZ NOT NULL | Covered if “head-posture case asserts the columns” explicitly pins these values. |
| Same, `:23–25` | Active-actor unique index and its predicate; account-started index | Degrade/reapply plus index catalogue observes these on a correct baseline. F1/F4 show why exact negative state and independent expected predicate remain necessary. |
| Same, `:29–30` | RLS enabled; no CREATE POLICY | RLS degradation plus complete target equality and zero-policy baseline replace the semantic protection. A create/drop policy with no final effect need not be banned lexically. |
| `migration-049-analytics-events-rls.test.ts:14,20` | ENABLE RLS; no CREATE POLICY | Explicit head true/zero-policy state plus RLS degrade/reapply and target equality are semantic equivalents. No unique lost assertion beyond shared harness defects. The title's “re-runnable” was not itself separately tested. |
| `migration-051-structure.test.ts:17` | CREATE TABLE IF NOT EXISTS | Existing-table reapply catches unconditional CREATE; presence of CREATE in an edited historical file is not independently guarded. State the skipped-body limit. |
| Same, `:20–35` | Columns response_id, account_id, business_id, review_id, api_cost_id, source, reason, severity, status, reviewed_by_user_id, reviewed_at, created_at, updated_at | T5 only explicitly promises head CHECK assertions, not this full inventory. F11. No silently assumed replacement. |
| Same, `:39–45` | FK targets responses/accounts/businesses/reviews/api_costs; api_cost_id ON DELETE SET NULL | No independent head expectation is specified; same-table baseline comparison is not equivalent after fresh provisioning. F11. |
| Same, `:49–50` | status CHECK includes open; severity CHECK includes high | T5's explicit three-CHECK head contract is stronger if it pins exact expected definitions/behavior. Preserve it independently of BEFORE. |
| Same, `:54–55` | ENABLE RLS; no CREATE POLICY | Replaced semantically by head RLS/zero policies and target equality after degrade. |
| Same, `:59` | Admin status read-path index | Reapplication/catalogue can replace it, subject to F1/F4. |
| Same, `:63–65` | No DROP TABLE, UPDATE or DELETE | Final structure catches many destructive DDL outcomes but not destructive DML or drop/recreate with identical schema. F10. Removing lexical bans requires a data-preservation replacement or an explicit admitted coverage loss. |
| `migration-053-structure.test.ts:19–21` | UPDATE is limited to sales_partner and sets admin | Seeded legacy row proves conversion only, not WHERE exclusivity. F10's owner/admin controls are missing. |
| Same, `:25–26` | Exactly one UPDATE users occurrence | No equivalent operation-count assertion; that lexical count did not prove no-op reapplication. Replace with repeated-apply data assertions (F9/F10), and state why statement count is intentionally retired. |
| Same, `:30–33` | Named constraint and exact owner/admin allowlist | Name readiness and BEFORE equality are not independent expected semantics (F4). Explicit allowlist head/rejection assertions are required. |
| Same, `:37–38` | Constraint-existence guard | One apply after dropping the constraint never exercises already-present state. F9. |
| Same, `:41–42` | Guard relation scoping | No decoy relation/schema fixture. F9. |
| Same, `:46–48` | No DROP TABLE/COLUMN/CONSTRAINT | Final target/all-table equality covers represented final damage, not temporary destructive operations with data loss or invisible column-default loss. F10/F5 identify the missing semantic preservation. State why harmless intermediate DDL is no longer lexically forbidden. |
| `migration-057-account-offboarding-tombstone-nullability.test.ts:20–22,28–29,39–41` | Three target tables and five DROP NOT NULL clauses | Replaced by five explicit head nullable checks and five verified negative states followed by equality across all three targets. F1 concerns incomplete negative-state proof. |
| Same, `:23–24,30–35,42` | Keep location_ids/provider_dispositions, approval account_id/business_id, impersonation actor_user_id nonnullable | Full target column equality protects these relative to correct BEFORE. Explicit head expected values should preserve the original independent invariant, rather than accepting an already weakened baseline. This is F4's oracle principle applied to nullability. |
| Same, `:46–48` | No new tables, policies or indexes | All-public table-set/definition diff is a semantic replacement for persistent additions, provided F13 is addressed. Policy changes under existing names need F6. Transient create/drop with no lasting effect need not fail merely for its text. |
| Same, `:49–50` | No `purging` or `NEXT_PUBLIC_` tokens | No equivalent catalogue assertion, intentionally: these can appear in comments without behavior. Record explicit retirement of lexical vocabulary checks, identify any real status/flag invariant still intended, and cite its actual semantic guard. Do not claim catalogue equality checks arbitrary text. |
| `migration-117-admin-audit-log.integration.test.ts:71–75` | REVIEWED_NOT_TENANT_SCOPED reason mentions actor_user_id; not in TENANT_TABLES | Preserve unchanged under “replace only the text-matching cases.” New MIGRATION_SHAPE_FILES membership is a different registry and cannot replace it. |
| Same, `:80–82` | File ENABLE RLS, no CREATE POLICY, REVOKE ALL | Executing RLS/zero-policy checks improve lexical coverage; SELECT-only degrade is not an equivalent ALL-privilege check (F3). |
| Same, `:84–85` | actor UUID NOT NULL FK, no destructive delete action | Existing exact-column and FK behavior tests provide installed-schema equivalents. Header must retain the stated historical CREATE TABLE limitation. |
| Same, `:133–183` | RLS true, FORCE false, zero policies, eight role/DML privilege checks | Preserve unchanged as required. Generic `forceRowSecurity` can also observe FORCE; no missing-field finding applies. Expanded privilege assertions should supplement these. |
| Same, `:185–205` | Exact ten columns/types/nullability/defaults; no account column | Preserve unchanged. Replacing this with generic column strings would lose default checks and violate T8's retention instruction. |
| Same, `:209–217` | Actor/event indexes newest first | Preserve unchanged; executing drops provide additional file-specific restoration evidence. |
| Same, `:220–236` | FK NO ACTION on delete/update; referenced-admin deletion fails 23503 with named FK | Preserve unchanged. It is both catalogue and behavior evidence. |
| Same, `:241–283` | Real writer persists exactly one row and round-trips payload/optional metadata | Preserve unchanged under “replace only the text-matching cases.” Although not one of the 37 new titles, the plan does not authorize deleting this behavioral case. |
| Same, `:286–295` | Missing actor rejected with 23503 and named FK | Preserve unchanged for the same reason; generic head snapshots are not a replacement. |

All five deleted files need a reasoned replacement map. `scripts/ci/weakened-checks-audit.ts:159–186` emits REVIEW for deleted test files and surviving test files with a net loss of expect calls; `:203–211` allows REVIEW rows to pass. Therefore a green `ci:weakened-checks` is not acceptance of those losses. T8 correctly calls for explanations on 117; the same standard must cover the other five deletions. The F9/F10/F11 gaps are not resolved by merely saying a test was replaced by an integration test.

### Q3(d) — staging waiver and remaining authority

**Waiving a production-like staging ride is sound for this actual edit surface.** The change is test infrastructure and CI configuration; it changes no production migration, worker, billing path, or browser journey. Deploying it to a persistent staging app would not exercise GitHub's PostgreSQL service or the test-only harness. The authoritative environment rule in `.claude/CLAUDE.md` requires staging for changes touching the worker, webhook, migration or billing; this plan executes existing SQL against a disposable local database and edits none of those production surfaces.

High risk still warrants independent adversarial/mutation evidence and the real PostgreSQL 17 integration/CI runs; it does not authorize substituting a staging label for those checks. `.agents/skills/feature/SKILL.md:417–427` retains the high-risk red-team requirement, and `references/shipping-boundaries.md:7–23` separates local work from deployment/remote-migration authority. The supplied intake authorizes no remote mutation here. No remote apply is owed, and destructive local degrades must not be pointed at either Supabase project. Browser testing is inapplicable to this review and this test-only implementation surface; CI E2E still needs to run on the upgraded service for its own compatibility evidence.

## Low-confidence appendix — excluded from findings table

- A non-cooperating external DDL writer could change a READ COMMITTED catalogue snapshot between its multiple SELECTs; a non-cooperating row writer could race 057's NULL precheck. Neither was demonstrated, and neither is an interleaving among the seven correctly locked suites. If support for that population is intended, the exact additional test would be `migration 057 reports a concurrent NULL insertion as a named fixture precondition failure`.
- PostgreSQL 17 may change query plans or timing elsewhere, but no concrete runtime break was found in active image pins, provisioning, E2E configuration or caches. Run the actual lanes; do not manufacture a compatibility finding from a remaining prose reference to 16.
- A future edited migration might call a sequence or take session advisory locks. The supplied seven do neither, and a transactional harness is not a sandbox for arbitrary SQL side effects. If the declared isolation contract is expanded to cover arbitrary mutated SQL, the exact additional test would be `migration guard isolation detects sequence advancement and releases session advisory locks after failure`. No such mutation was executed during this review.

## Stop-hook gate status — review completion versus implementation completion

After the review, the stop hook reported the existing verification gate RED. The diagnostics were inspected read-only:

- `.feature/logs/feature-surface.log`: eight planned allowed-edit-surface paths do not exist yet: the migration-guard helper and its test, plus the new 048, 049, 051, 053, 057 and 118 integration suites.
- `.feature/logs/extra-pnpm-vitest-run-src-lib-shared---tests---46d2d0.log`: Vitest exits 1 with “No test files found” for the planned `src/lib/shared/__tests__/helpers/migration-guard.test.ts`.
- `.feature/logs/baseline-gate.log`: records those same two failures in the pre-existing baseline gate.

These are consistent with the user's explicit premise that the plan has not been implemented. They are not evidence that this review's report failed a content check, nor are they new migration-behavior findings. The gate remains RED. Creating the planned implementation, narrowing its intake, changing hook/gate state, or weakening its checks would exceed this review's sole-file write authorization. No such action was taken, and this report makes no implementation-complete or gate-green claim.

The revision should make the negative state property-specific, make expected security semantics independent of freshly provisioned BEFORE, exercise the revoke preconditions, complete the catalogue observer where it makes preservation claims, and retain explicit replacements for deleted protections. The execution-and-rollback architecture itself remains viable.

VERDICT: REVISE
