# Adversarial approach review — fix-1171-job-outbox-rls

Reviewed HEAD `3a7d0ca9930ae60c5ebbafb25cd962675d751e78` against supplied merge-base `602e98930810177230c0edbc0830063db5f75d43`. The supplied brief was accepted as the source for measured environment state and locked decisions. Repository reads checked specific claims and uncovered paths. No migrations, test mutations, commits, or application edits were performed.

| Severity | File:line | One-line finding |
| --- | --- | --- |
| P2 | src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:223 | The sole posture guard misses later UPDATE/DELETE/TRUNCATE grants; a TRUNCATE grant passes every assertion even though RLS cannot prevent whole-outbox deletion. |

Finding — extend the effective-privilege guard (confidence: 98%)

The catalogue query at lines 223–226 tests only SELECT and INSERT for each client role. The file-text assertions at lines 108–119 inspect only migration 119. A subsequent migration containing `GRANT TRUNCATE ON public.job_outbox TO authenticated;` therefore leaves every observed property in this suite unchanged: RLS stays enabled, FORCE stays false, policy count stays zero, SELECT/INSERT remain absent, owner privileges remain present, and migration 119's text stays unchanged. The suite cannot detect this regression even when CI provisions every migration successfully.

This violates the branch's explicit “every anon and authenticated privilege” contract (test line 108; migration line 89). TRUNCATE is a separate privilege, and whole-table operations are exempt from RLS. The resulting role would have database authority to empty the dispatch spine regardless of its zero-policy posture. This is a guard failure, not a claim that the current migration leaves TRUNCATE granted or that a public anon key can directly issue arbitrary SQL through PostgREST. [PostgreSQL row security](https://www.postgresql.org/docs/16/ddl-rowsecurity.html), [PostgreSQL GRANT](https://www.postgresql.org/docs/16/sql-grant.html).

The same omission covers UPDATE, DELETE, REFERENCES and TRIGGER; UPDATE/DELETE remain row-filtered, but their permission-denial contract still regresses. Add read-only catalogue assertions covering all table privileges supported by the database version for both client roles. Checking column privileges would also protect the stronger claim that no client access privilege remains. This needs no tenant-registry change and no DDL inside the suite.

This is distinct from D5: D5 accepts that absent bootstrap grants cannot prove the original REVOKE worked. Here a later migration supplies an actual grant during normal provisioning, and the new suite still has no observation capable of detecting it. One-time post-apply introspection of migration 119 cannot guard subsequent migrations.

Checked conclusions — no additional findings

- Runtime and dark triage path: `src/lib/db/server.ts:58` constructs the shared write client from DATABASE_POOL_URL; the dedicated read/unsubscribe clients use the same URL. Production source searches found no alternate postgres constructor outside that module, no SET ROLE/set_config role switch, and no RPC call or direct supabase-js job_outbox access. `worker/jobs/ResponseGeneratorWorker.ts:82` passes that shared client to `runTriagePhase`; `worker/jobs/response-generation/triage.ts:79` opens its transaction; `src/lib/reviews/triage.ts:269` passes that transaction into escalation. Enabling TRIAGE_ENABLED does not itself switch database identity. Production's flag-off history alone is incomplete evidence, but this checked path does not reveal a newly RLS-bound identity.
- SQL intermediaries: a targeted scan of checked-in function, procedure, view and trigger definitions found no body binding job_outbox. There is no checked-in `supabase/functions` directory. This does not establish the absence of manually deployed objects or external consumers.
- Default privileges: ALTER DEFAULT PRIVILEGES affects future objects, so it does not automatically re-grant permissions on the existing job_outbox after this REVOKE. [PostgreSQL default privileges](https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html).
- Locks: the ALTER is not a physical or lock-free no-op on production. PostgreSQL selects AccessExclusiveLock for AT_EnableRowSecurity; ATExecSetRowSecurity unconditionally updates pg_class, even when the boolean is already true. A long transaction holding an incompatible lock can make this ALTER wait and can queue later outbox operations behind it until acquisition succeeds or the five-second timeout fires. Migration lines 63–67 and 78–83 already acknowledge and bound acquisition, so this is not a separate unmitigated finding. “No-op” at line 70 should be understood only as unchanged final RLS state. [PostgreSQL implementation](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/backend/commands/tablecmds.c), [ALTER TABLE locking](https://www.postgresql.org/docs/17/sql-altertable.html).
- Apply order: staging first remains sound. In an autocommit apply, failure after ENABLE but before REVOKE leaves row filtering active; application owner access continues. If ALTER times out, ON_ERROR_STOP stops the checked psql setup path. An encompassing transaction instead rolls back on failure. No checked evidence supports reversing the project order. Introspection remains necessary to distinguish successful completion from partial hardening.
- Schema cache: cached relation metadata does not replace PostgreSQL permission checks. No checked client branches on a job_outbox permission error, so no concrete client compatibility regression was found. This review did not exercise a deployed PostgREST request.

Low-confidence appendix — not findings

- Runtime URL credentials, current_user/rolbypassrls on each deployed connection, live view/function/trigger inventories, replication subscriptions and dump consumers were not independently inspected. Source wiring supports the brief's identity claim but cannot prove those external facts. An undisclosed invoker consumer using a non-owner without BYPASSRLS could fail after staging enables RLS; no such consumer was identified.
- A session-scoped SET issued as a separate autocommit request through transaction pooling may not govern a later request on another backend. The checked local psql driver uses one session, and no evidence established that the planned remote apply splits this SQL across pooled requests, so D3 is not reported as broken.
- Owner privilege assertions are not a complete runtime-identity check. CI uses the stock Postgres service's POSTGRES_USER, a superuser, while the suite derives the table owner rather than checking a deployed worker session. This limits the claimed evidence; no current worker identity mismatch was established.

Verification was static and read-only. No test suite or browser journey was run, consistent with the review's prohibition on mutations. The only intended filesystem write is this requested report.

VERDICT: REVISE
