# Plan review R3 — final verification

**VERDICT: REVISE.** Six of the ten requested checks are verified, including the dropped-table fix and the new privilege derivation. Four accepted findings remain partial. The most concrete new defect is that 057's exact `absent` selectors cannot match the column strings defined by the same plan, causing the guard to reject a correctly provisioned database before applying the migration.

This is the final verification round, not another broad review. The scope is R2-D1, F1/F4/F5/F6/F7/F9/F10, shared-title ownership, and the new 117 privilege-list derivation. **F2, F3, F8, F11, F12, F13 and F14 remain closed as YES from R2.** Their implementations do not exist yet and were not re-audited. Unchanged unrelated sections, staging authority and the expected RED implementation gate were not reopened.

Read the revised plan in full, recovering the truncated middle of the first tool response; checked the intake's four new titles and totals; consulted only the relevant pending requirements in R2; and performed read-only catalogue queries plus in-memory string checks. HEAD is still `d79bc765ce630ea651efe67ec6a7b3488c5afa86`. This report is the only file written. No implementation, schema/data mutation, build, full test run or gate-state change was performed. The existing `verify-spec` method was limited to this verification-only scope; no subagents were used in this round.

All plan line references below refer to `docs/superpowers/plans/fix-1301-migration-guard-execution-plan.md` as read in this round.

## Requested checks

| Item | Fix verified? | One-line reason |
|---|---|---|
| R2-D1 | YES | The presence branch requires BEFORE existence and AFTER absence without dereferencing a dropped table; other branches require both tables. |
| F1 | PARTIAL | Per-object lists fix the aggregate check, but 057's selectors do not match rendered columns, and substring matching does not establish exact object identity. |
| F4 | YES | T8 independently pins both 118 comments and `now()` at head, closing the fresh-provisioning comparison gap. |
| F5 | PARTIAL | Identity/generated flags are added, but the generation expression explicitly requested in R2 is still not specified as captured. |
| F6 | YES | Policy serialization now includes command, mode, target roles and both expressions as well as the name. |
| F7 | YES | ACL serialization now records the grantor in addition to the previously covered grantee, privilege, column and grant option. |
| F9 | PARTIAL | The accounts decoy now challenges an absent public.users constraint correctly; the separately requested other-schema collision case remains missing. |
| F10 | PARTIAL | A nonempty flag fixture and full-record comparison fix T5; first-apply preservation of the 053 admin/control records remains unasserted. |
| Shared-title ownership | YES | Each cross-cutting title has one owner, and T6 explicitly asserts both the named index definition and role-constraint definition. |
| 117 privilege derivation | YES | `aclexplode(acldefault('r', owner))` supplies the server's full table privilege set; requiring all before and none after distinguishes ALL from SELECT-only revocation. |

## Defect introduced by a correction

| Defect | Introduced by | Evidence | Required correction |
|---|---|---|---|
| R3-D1 — 057's required BEFORE matches are impossible | F1's new substring selectors and §3 target table | Plan line 156 asks for `zernio_account_ids NULL`, but lines 317–318 render `<name> <type> <NULL\|NOT NULL>`; the real column is `zernio_account_ids text[] NULL`. All five supplied selectors have the same mismatch. | Match structured column identity/nullability, or supply exact compatible rendered values and pin their matching in a test. |

**MISSING FAILING TEST:** `assertDegradeLanded matches all five typed tombstone columns before and after NOT NULL is reinstated`.

The new BEFORE-presence requirement is correct. The selectors are wrong for that requirement. A faithful implementation must throw that each object was already missing from BEFORE, even though all five columns are present and nullable. This is a deterministic plan inconsistency, not a concern about a possible future implementation.

## Verification evidence and residual obligations

### R2-D1 — verified

The revised discriminated union at plan lines 332–334 has a separate `{ table, property: 'presence' }` variant. Lines 134–141 and 375–378 define the existence conditions explicitly: the table must exist before the degrade and disappear afterwards; other property forms require both snapshots to contain it. T8 lines 802–807 use this exact branch for 118. The pure-test title is present at line 443 and in the intake.

This closes the missing-table dereference defect without waiving vacuity checks. No optional missing-table behavior is silently granted to index, constraint or column tests.

### F1 — original aggregate hole addressed, but the replacement contract is not yet consistent

The new check verifies a changed property, membership of every requested object in BEFORE, and absence of every requested object after the degrade. The target table now names all four 048 indexes, both 051 indexes, the 053 constraint, both 117 indexes, and separate row-security transitions. That addresses the R2 counterexample where only one member of an aggregate property changed.

The 057 row, however, supplies these substring selectors:

| Selector in §3 | Rendered BEFORE value required by `CataloguedTable.columns` | Substring present? |
|---|---|---|
| `zernio_account_ids NULL` | `zernio_account_ids text[] NULL` | No |
| `zernio_profile_ids NULL` | `zernio_profile_ids text[] NULL` | No |
| `response_id NULL` | `response_id uuid NULL` | No |
| `account_id NULL` | `account_id uuid NULL` | No |
| `impersonated_user_id NULL` | `impersonated_user_id uuid NULL` | No |

A read-only query of `pg_attribute` on the existing PostgreSQL 17.11 test database confirmed these types and nullable states. A direct in-memory `rendered.includes(selector)` check returned false for all five. R3-D1 above is therefore established without running a migration.

There is also a narrower contract remainder in the newly chosen substring mechanism: plan lines 129–132 say that a typo must fail because the named object was missing from BEFORE, but a truncated name such as `users_role_chec` still matches `users_role_check: CHECK (...)`. A differently named object sharing the requested prefix can satisfy that test as well. Substring occurrence is not exact object identity.

**Remaining MISSING FAILING TEST:** `assertDegradeLanded rejects a missing exact object name even when another rendered definition contains it`.

Use a catalogue name key or an exact field identity for objects; use explicit nullability for columns. This is a correction to F1's new matching rule, not a request to parse migration SQL. For boolean forms, an empty `absent` list can express the table's “no object list” while satisfying the declared TypeScript signature; the independently pinned true head state plus a flip then proves the intended false degraded state.

### F4 — verified

T8 lines 809–815 now requires three literals in the test: the table comment, `last_cycle_at` column comment and the catalogue default expression `now()`. The added head-posture title appears in both plan and intake. Deleting one of those declarations before a fresh provision now causes the independently specified head expectation to fail, rather than merely comparing two copies of the weakened state.

This is the exact missing coverage from R2 F4. The table-removal restoration case continues to provide complementary execution evidence. The general distinction remains that a head oracle can reject a fresh weakened baseline even when the restoration comparison itself reproduces it; the added independent literals close the required detection path.

### F5 — flags are fixed; the expression requirement remains

The new column format includes `[IDENTITY <a|d>] [GENERATED <s>]`, correctly distinguishing identity mode and stored-generation status. That closes the mode/flag part of R2 F5.

R2 F5 also explicitly required **generation expressions**. The revised format adds only the `s` marker; `columnDefaults` remains described as `<name> = <default expression>`, with its rationale restricted to 118's ordinary `DEFAULT NOW()`. No rule states that generated-column expressions are included in that collection or elsewhere. Changing a generated column's computation while leaving its name, type, nullability and `GENERATED s` unchanged remains outside the specified representation.

**Remaining MISSING FAILING TEST:** `readPublicCatalogue distinguishes column defaults, identity modes and generated expressions`.

This can be closed without another top-level field: explicitly require the reader to collect and deparse both ordinary defaults and generation expressions from `pg_attrdef`, distinguishing them through the generated flag, or add a named generation-expression field. PostgreSQL stores both kinds of expression in `pg_attrdef`; the implementation must not read only ordinary defaults. [PostgreSQL 17 pg_attrdef](https://www.postgresql.org/docs/17/catalog-pg-attrdef.html).

This is not a new metadata request: the generation-expression obligation appears verbatim in R2's F5 section and remains unaddressed by adding only the flag.

### F6 and F7 — verified

Plan lines 315–316 and 353–357 now serialize policy name, command, PERMISSIVE/RESTRICTIVE mode, roles and both expressions. That makes the specific role/command/mode changes identified in R2 observable. The already-required sorted representation should normalize the role list as part of producing a stable definition; no new policy dimension is requested here.

Plan lines 324–325 and 366–373 add grantor identity to each grant entry while preserving grantee, privilege, optional column and grant option. Grantor-only changes no longer map to the same string. This closes the exact remaining F7 field omission; previously approved all-grantee/PUBLIC behavior was not reopened.

### F9 — correct relation-decoy timing, incomplete collision coverage

T6 lines 634–649 correctly drops the real constraint, creates a same-name decoy on accounts, applies 053 and requires the constraint on public.users while retaining the decoy. A name-only lookup now finds the decoy and incorrectly skips the real ADD, so the test distinguishes the faulty guard. Its explanation of why the previous ordering tested nothing is correct.

R2 also explicitly retained a **separate other-schema collision** case. That case is still absent. Removing only `n.nspname = 'public'` from the migration's guard leaves the `t.relname = 'users'` filter, so the accounts decoy is ignored and the new relation-decoy test passes. A same-name constraint on `other_schema.users`, with the real public.users constraint absent, distinguishes that remaining mutant.

**Remaining MISSING FAILING TEST:** `re-applying 053 creates the missing public.users constraint despite a same-named constraint on another schema's users table`.

Preserve the now-correct accounts case and the previously added second-apply case. This is a pending part of accepted F9, not a reopening of the independently verified idempotence behavior or a new migration concern.

### F10 — T5 fixed; the pending T6 control assertion remains

T5 lines 567–588 now seeds nonempty flag data inside the rollback boundary, reads the complete record and compares it after applying the migration. This closes the accepted empty-count and value-rewrite counterexamples. The new title is present in both plan and intake. Stable record comparison can operate on the returned object; SQL `ORDER BY` orders rows, so “ordered by column name” should be understood as deterministic field representation if one is needed, not a literal SQL ordering operation over `SELECT *` columns.

R2 F10 also explicitly identified first-apply preservation of the existing owner/admin control records. T6 is still unchanged on that point: it seeds three users, checks the converted role and owner role, and checks no changes only on the **second** apply. It does not assert that the seeded admin or the owner/admin records' other values survive the first apply.

For example, an appended idempotent `UPDATE users SET name = 'changed' WHERE role = 'admin'` can change the admin control on the first apply. The legacy row still becomes admin, the owner remains owner, the constraint is correct, and the second apply leaves the same row values. Those stated checks pass.

**Remaining MISSING FAILING TEST:** `re-applying 053 preserves owner and admin control records on the first apply`.

Compare the full control records before/after the first application, allowing only the intended sales_partner role conversion in that separate fixture. This carries forward R2's explicit accepted requirement; it does not undo credit for the completed flag-row correction.

### Shared-title ownership — verified

T6 lines 655–666 now says the single cross-cutting F4 test asserts both `idx_impersonation_active_actor`'s full index definition and `users_role_check`'s full constraint definition, using the full-public catalogue. T4/T5 retain their local independent expectations. Section 6 at 846–858 states the same ownership and once-only implementation rule.

The other cross-cutting title remains assigned to T4, with the 051 half explicitly implemented in T5's head case. This is the collective coverage arrangement accepted in R2. No change to the previously verified first-match promised-title gate is needed or reviewed anew.

### 117 privilege derivation — correct and sufficient for the stated distinction

The new assertion at T8 lines 757–764 correctly separates a grant-adding degrade from the helper's removal contract. `acldefault('r', owner)` constructs the server's built-in default table ACL; exploding it and taking its privilege names obtains the table-right vocabulary independently of the table's current ACL or user-configured default grants. This is not a read of potentially already-weakened client privileges. [PostgreSQL 17 ACL functions](https://www.postgresql.org/docs/17/functions-info.html).

Read-only queries on the two existing local servers returned:

| Server | Privileges from `aclexplode(acldefault('r', current_user::regrole))` |
|---|---|
| PostgreSQL 16.14 | DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE |
| PostgreSQL 17.11 | DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE |

In implementation, use the table owner's OID (`relowner`) as specified and project the distinct `privilege_type` values. The read-only probes used the local owning role and confirmed the version difference without changing grants.

Requiring **every** derived privilege for **both** anon and authenticated in the degraded catalogue proves the adverse precondition. Requiring none after application rejects REVOKE SELECT because the non-SELECT privileges remain. It also rejects revoking all privileges from only one of the two clients. This verifies the newly requested derivation; it does not reopen F3's already accepted GRANT ALL choice or claim to enumerate a different object type's privileges.

## Intake and evidence limits

- The intake contains **55 promised titles**, all unique, and `estimated_test_lines: 2100`.
- The four newly named tests are present in both plan and intake. Every intake title appears in the plan's title lists. The checked-in-path intake and `.feature/intake.json` parse to identical objects.
- `pnpm agent:rules` returned `none` for this report path.
- Read-only PostgreSQL queries verified the table privilege lists and the exact types/nullability relevant to R3-D1. The string-matching counterexamples were checked in memory; no fixture or implementation file was created.
- A RED implementation gate remains expected and is not a finding. No implementation success or gate-green claim is made.

## New, untriaged

No unrelated concern is raised. The remaining items above are either explicit pending obligations from R2 or a defect in the newly introduced F1 selector contract. Previously verified YES findings remain closed.

## Owner decision after the review cap

The plan's position is that all nine corrections are complete; this verification credits six checks, but identifies the incompatible 057 selectors plus unfinished parts of the already accepted F1/F5/F9/F10 contracts.

**With no review round remaining, the owner must decide whether to approve implementation conditional on correcting the 057 selector mismatch and completing these residual checks, or override the review with an explicitly narrowed coverage contract.**

VERDICT: REVISE
