# fix-1176 — client-role grant sweep (migration 122) — plan

- Intake (locked, owner sign-off 2026-09-16): `docs/superpowers/plans/fix-1176-client-role-grant-sweep-intake.json`
- Issue: #1176. Split-off tickets: #1300 (registry split + recurrence guard), #1301 (older suite rebuilds).
- Fork point: `889c8be6e` (origin/main at worktree creation).
- Precedent: `supabase/migrations/119_job_outbox_rls.sql` + `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts`.

## Measured baseline (2026-09-16, read-only introspection)

| Fact | Production | Staging | Local test DB |
|---|---|---|---|
| server_version_num | not read | 170006 | 160014 |
| tables in public (relkind r) | 58 | 58 | at head |
| deny-all (RLS on, 0 policies) tables with client grants | 20 | 20 | n/a (no Supabase defaults) |
| tables where anon / authenticated hold TRUNCATE | 49 / 49 | 49 / 49 | n/a |
| tables with RLS off | 0 | 0 | — |
| table owner / grantor of the client grants | not read | postgres / postgres | test (superuser) |
| default ACL for owner in public, relations | not read | `anon=arwdDxtm`, `authenticated=arwdDxtm`, `service_role=arwdDxtm` (schema-level entry; no global entry) | none |
| views / matviews / foreign tables in public | not read | 0 | — |

The twenty deny-all tables with client grants (identical on both projects):
`agent_outcomes, agent_run_steps, agent_runs, analytics_events, auto_approval_policies, flagged_responses, google_connections, impersonation_sessions, inbound_events, judge_verdicts, owner_leads, poller_cursors, prospect_demos, refusal_events, review_escalations, solicitation_consent, solicitation_send_breaker, solicitation_suppression_corrections, solicitation_suppressions, solicitation_unsubscribe_tokens`.

## Modules and seams (codebase-design)

No TypeScript module changes. Two artifacts, no new interface:

- **Migration 122** — a new file; deepens nothing, widens nothing.
- **Suite 122** — a new live-DB suite on the 119 execute-not-parse seam, registered in the existing `MIGRATION_SHAPE_FILES` allowlist.

## Migration 122 — code-shaped spec

File: `supabase/migrations/122_client_role_grant_sweep.sql`. Header follows 119's section order (what was wrong, why safe, why these rights, default privileges, version guard, locking, transaction, idempotent/lockstep). Body:

```sql
BEGIN;

SET LOCAL lock_timeout = '5s';

-- Fail closed if applied by a role that does not own the tables: ALTER DEFAULT
-- PRIVILEGES without FOR ROLE targets current_user, so a wrong applier would
-- change nobody's defaults while the rest of the file still reported success.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND c.relowner <> current_user::regrole
  ) THEN
    RAISE EXCEPTION 'migration 122 must be applied by the role that owns every table in public';
  END IF;
END $$;

-- 1. Rights no client role needs, on every table. TRUNCATE is exempt from row
--    policies entirely.
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- 2. Deny-all tables: RLS with zero policies already denies rows; remove the
--    table privileges too (117/118/119 precedent).
REVOKE ALL ON
  agent_outcomes, agent_run_steps, agent_runs, analytics_events,
  auto_approval_policies, flagged_responses, google_connections,
  impersonation_sessions, inbound_events, judge_verdicts, owner_leads,
  poller_cursors, prospect_demos, refusal_events, review_escalations,
  solicitation_consent, solicitation_send_breaker,
  solicitation_suppression_corrections, solicitation_suppressions,
  solicitation_unsubscribe_tokens
FROM anon, authenticated;

-- 3. Stop new tables inheriting the same rights.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLES FROM anon, authenticated;

-- 4. MAINTAIN exists from PostgreSQL 17 (both Supabase projects); the test
--    container is 16, where the keyword is a syntax error.
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 170000 THEN
    EXECUTE 'REVOKE MAINTAIN ON ALL TABLES IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE MAINTAIN ON TABLES FROM anon, authenticated';
  END IF;
END $$;

COMMIT;
```

## Suite 122 — code-shaped spec

File: `src/lib/shared/__tests__/migration-122-client-role-grant-sweep.integration.test.ts`. Shape copied from the 119 suite (lock, `max: 1`, `prepare: false`, `statement_timeout`, `describeWithDb`, `assertLocalTestDatabaseUrl`). All DDL happens in ONE `beforeAll` that captures snapshots and restores the container in `finally` BEFORE any `it` runs; every `it` is a pure assertion over captured data.

Constants: `DENY_ALL_TABLES` (the twenty, sorted), `MIGRATION_FILE`, `CANDIDATE_REVOKED_RIGHTS = ['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']`. `REVOKED_RIGHTS` = candidates ∩ privilege types derived from `aclexplode(acldefault('r', current_user::regrole))`, so PG16 checks three and PG17 four. Assert `serverPrivileges.length >= 7` and `REVOKED_RIGHTS.length >= 3` (fail-open guard, as 119).

Snapshot `readCatalogue()` returns, per table in public (`relkind IN ('r','p')`):
- `rls`, `force`, `policies` (pg_policy name, cmd, permissive, roles, qual, withcheck — as 121's `catalogue()`), `columnAcl` (attname=attacl text),
- `acl`: sorted `grantee:privilege:grantable` from `aclexplode(coalesce(relacl, acldefault('r', relowner)))`, grantee 0 rendered `PUBLIC`,
- `clientEffective`: `role:privilege` for `anon`/`authenticated` over server privileges where `has_table_privilege` is true;
plus schema-wide `sequenceAcl` and `functionAcl` text for public; `defaultAcl`: EVERY `pg_default_acl` row normalized to sorted `role|namespace-or-*|objtype|grantee|privilege|grantable` (all roles, all object types, global and schema scope — plan round 1 finding 3); and `defaultProbe`: inside `sql.begin`, `CREATE TABLE public.__migration_122_default_probe (id int)`, read its `has_table_privilege` for anon/authenticated/service_role over server privileges, then throw a rollback sentinel (the table never commits).

`beforeAll` sequence:
1. `original = readCatalogue()`; also capture original table grants, column grants (from `attacl`) and the full `defaultAcl`.
2. **Owner-guard probe** (plan round 1 finding 5): `CREATE TABLE public.__migration_122_owner_probe (id int); ALTER TABLE public.__migration_122_owner_probe OWNER TO service_role;` Apply the file verbatim, capture the error, `ROLLBACK`, `DROP TABLE public.__migration_122_owner_probe`, then `ownerGuardAfter = readCatalogue()`. Record the error message (or `null` if the apply succeeded).
3. Degrade to the measured Supabase posture WITHOUT granting DML the container lacks (plan round 1 finding 1):
   - `GRANT ALL ON <DENY_ALL_TABLES> TO anon, authenticated;`
   - `GRANT <REVOKED_RIGHTS> ON ALL TABLES IN SCHEMA public TO anon, authenticated;`
   - positive DML control: `GRANT SELECT, INSERT, UPDATE, DELETE ON reviews TO anon, authenticated;`
   - positive control for the one real client read (`src/proxy.ts` `.from('users')`, plan round 2): `GRANT SELECT ON users TO authenticated;`
   - `GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`
   - `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;`
   Migration 040's negative controls stay: `authenticated` keeps no table-level UPDATE on `businesses` and no table-level INSERT/UPDATE on `channel_enrollments`, only its column grants.
4. `before = readCatalogue()`.
5. Apply the file verbatim: `sql.unsafe(readFileSync(MIGRATION_FILE))`.
6. `after = readCatalogue()`.
7. Apply the file verbatim again; `afterSecond = readCatalogue()`.
8. `finally` (plan round 1 finding 4): first `ROLLBACK` (a no-op warning when no transaction is open, and the repair when a failed apply left one aborted — 121 suite precedent). Then, in `sql.begin`: `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role;` + `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role;`, then re-GRANT every original table grant and column grant for those three roles and every original schema-public table default entry for them (WITH GRANT OPTION where grantable), and `DROP TABLE IF EXISTS` both probe tables. Then read the catalogue and throw if the three roles' table and column entries or the FULL `defaultAcl` differ from `original`. A restore failure never hides an earlier apply failure: when both occur, the thrown error names both.

Tests (titles verbatim from the intake):

| Title | Assertion |
|---|---|
| migration 122 removes TRUNCATE, REFERENCES, TRIGGER and MAINTAIN from anon and authenticated on every public table | `before`: every table's `clientEffective` contains every REVOKED_RIGHT for both roles (degrade landed). `after`: no table's `clientEffective` contains any REVOKED_RIGHT. |
| migration 122 removes every anon and authenticated privilege from the twenty deny-all tables | Every name in DENY_ALL_TABLES exists in `after` with `rls = true` and zero policies. `before` shows client privileges on each. `after` shows `clientEffective = []` on each. |
| migration 122 keeps anon and authenticated DML on tables outside the deny-all list and leaves owner and service_role privileges unchanged | Controls landed in `before`: both roles hold SELECT/INSERT/UPDATE/DELETE on `reviews`; `authenticated` holds SELECT on `users`, and still holds it in `after`; `authenticated` holds no table-level UPDATE on `businesses` and no table-level INSERT or UPDATE on `channel_enrollments`. For EVERY table outside DENY_ALL_TABLES: `after.clientEffective` EXACTLY equals `before.clientEffective − REVOKED_RIGHTS` (catches removal and addition alike). For every table: `acl` entries whose grantee is not anon/authenticated are identical in `before` and `after`. |
| migration 122 changes no RLS flag, policy or column grant on any public table | Same table-name set; per table `rls`, `force`, `policies`, `columnAcl` identical in `before` and `after`; `sequenceAcl` and `functionAcl` identical. |
| migration 122 removes the four rights from the owning role's default table privileges and keeps default DML | `before.defaultProbe`: anon and authenticated hold every REVOKED_RIGHT (degrade landed). `after.defaultProbe`: they hold none of REVOKED_RIGHTS, still hold SELECT/INSERT/UPDATE/DELETE, and the service_role set equals `before`'s. `after.defaultAcl` EXACTLY equals `before.defaultAcl` minus the entries `current_user|public|r|{anon,authenticated}|{REVOKED_RIGHTS}` — no other default of any role, object type or scope moves. |
| migration 122 is a no-op when applied a second time | `afterSecond` deep-equals `after`. |
| migration 122 refuses to run when a public table is owned by a role other than the applier | The owner-guard apply raised an error whose message contains `migration 122 must be applied by the role that owns every table in public`, and `ownerGuardAfter` deep-equals `original`. |

Probed on the local test DB 2026-09-16 inside a rolled-back transaction: (a) a table-level `REVOKE TRUNCATE, REFERENCES, TRIGGER` leaves a column `UPDATE` grant and table `SELECT` intact; (b) a table-level `REVOKE ALL … FROM authenticated` DOES remove that role's column grants — which is why step 7 re-grants column entries, and why migration 122's `REVOKE ALL` is safe only because none of the twenty tables carries a column grant on staging (column grants exist only on `businesses` and `channel_enrollments`); (c) a schema-level `ALTER DEFAULT PRIVILEGES … REVOKE TRUNCATE, REFERENCES, TRIGGER` after a schema-level `GRANT ALL` yields new tables with SELECT but without TRUNCATE/TRIGGER; (d) a full schema-level default REVOKE leaves no `pg_default_acl` row, so the restore returns the container to "no entry".

Stated limits (to go in the suite header): the MAINTAIN branch cannot execute on the PG16 container (`.github/workflows/ci.yml` pins `postgres:16`). The derived REVOKED_RIGHTS keeps every other assertion meaningful there, and the MANDATORY PG17 evidence query in step 8 below is the only proof of that branch.

## Tracers

### T1 — eval: the failing suite (blocks T2)

- Behavior: the seven intake tests exist and fail because migration 122 does not exist.
- Files: `src/lib/shared/__tests__/migration-122-client-role-grant-sweep.integration.test.ts`, `scripts/ci/live-db-suites-audit.ts` (add to `MIGRATION_SHAPE_FILES` with a reason comment).
- Evidence: `pnpm ci:live-db-suites` passes; `TEST_DATABASE_POOL_URL=… pnpm vitest run --project integration <suite>` fails in `beforeAll` with ENOENT on the migration file (red for the right reason); typecheck clean.
- Commit: `test(db): failing guard suite for migration 122 (#1176)`.

### T2 — migration 122 + bookkeeping (blocked by T1)

- Behavior: all seven tests pass against the local test DB at head.
- Files: `supabase/migrations/122_client_role_grant_sweep.sql`, `.claude/reference/migrations-log.md` (head → 122, next 123; entry in 119's format including the measured baseline and the rollback inverse).
- Evidence: `pnpm test:db:setup` then the suite green; the 119, 120 and 121 suites still green; `pnpm ci:rls-audit`, `pnpm ci:tenant-scope`, `pnpm ci:live-db-suites` pass.
- Commit: `fix(db): migration 122 revokes client-role grants behind deny-all RLS and TRUNCATE everywhere (#1176)`.

Independence: none — T2 depends on T1. Serial.

## Out of the plan, owned by step 8

Staging apply first, then production, each preceded by an ACL snapshot saved to the PR evidence and followed by the posture query, the default-ACL read, the PostgREST anon probe and the log watch named in the intake `observability`.

**Mandatory PG17 evidence, pass/fail, on each project after apply** (plan round 1 finding 2). It must return `0`; any other value blocks promotion:

```sql
SELECT count(*)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN unnest(ARRAY['anon','authenticated']) AS r(role)
  CROSS JOIN unnest(ARRAY['TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) AS p(priv)
 WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
   AND has_table_privilege(r.role, c.oid, p.priv);
```

**Mandatory preflight on each project BEFORE apply** (branch round 1, adversarial finding 2). Migration 122 changes only the schema-level default ACL, and a schema-level revoke cannot subtract a GLOBAL default grant. Both checks must pass, or the apply stops:

1. No global default entry for the applying role grants anon or authenticated any of the four rights: `SELECT … FROM pg_default_acl d CROSS JOIN LATERAL aclexplode(d.defaclacl) x WHERE d.defaclnamespace = 0 AND d.defaclobjtype = 'r' AND d.defaclrole = current_user::regrole AND x.grantee IN ('anon'::regrole, 'authenticated'::regrole) AND x.privilege_type IN ('TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')` returns zero rows.
2. After apply, a rolled-back probe as the applying role — `BEGIN; CREATE TABLE public.__m122_probe (id int);` then the four-right `has_table_privilege` check for anon and authenticated on it; `ROLLBACK;` — shows none of the four rights.

**Rollback is an exact inverse, never a blanket grant** (branch round 1, spec + adversarial). The saved pre-apply snapshot is per table, role, privilege and grant option. Migration 123, if ever needed, re-grants exactly the (table, role, privilege) triples present in that snapshot and absent after 122, plus the exact default-ACL entries removed. `GRANT ALL` on the twenty is wrong: migrations 055 and 076 had already removed authenticated INSERT/UPDATE/DELETE on `auto_approval_policies` and `judge_verdicts`.

`.claude/reference/arch-review-log.md` merge counter after merge.

## Plan review appendix

### Round 1 — Codex plan skeptic, session `01a0adb0-dc33-7372-ae5a-4e580e36636f`, VERDICT: REVISE

| # | Sev | Finding (short) | Verdict | Fix |
|---|---|---|---|---|
| 1 | High | Blanket GRANT ALL degrade masks a migration that ADDS client DML (e.g. table UPDATE on `businesses`, defeating 040) | ACCEPT | Degrade grants DML only on the positive control `reviews`; 040's negative controls asserted; exact before/after client-set equality outside the twenty |
| 2 | High | PG16 container cannot run the MAINTAIN branch; remote evidence checked only TRUNCATE | ACCEPT | Mandatory four-right × two-role × every-table pass/fail query on both PG17 projects in step 8; intake observability updated |
| 3 | Medium | Default-ACL checks see only three grantees on tables; other default changes (e.g. function EXECUTE from PUBLIC) pass | ACCEPT | `defaultAcl` snapshots every `pg_default_acl` row; only the authorized delta is allowed; restore compares the full snapshot |
| 4 | Medium | Cleanup after a failed verbatim apply hits 25P02 and never restores | ACCEPT IN PART | `finally` starts with `ROLLBACK`, restore runs in a transaction and is verified, both errors surface. REJECTED: a dedicated injected-apply-error test — it tests the suite's harness, not migration 122; the restore verification already fails loudly on a bad restore |
| 5 | Medium | Owner guard can be deleted with all tests green | ACCEPT | New case with a `service_role`-owned probe table; asserts the named exception and an unchanged catalogue |

### Round 2 — verification, resumed session `01a0adb0-dc33-7372-ae5a-4e580e36636f`, VERDICT: REVISE

| # | Addressed | Remaining / introduced | Verdict | Fix |
|---|---|---|---|---|
| 1 | Partial | The container gives `authenticated` no SELECT on `users` (relacl NULL, probed), so `REVOKE SELECT ON users FROM authenticated` in the migration would pass all seven tests — and that is the app's one client-role table read (`src/proxy.ts`) | ACCEPT | Degrade seeds `GRANT SELECT ON users TO authenticated`; test 3 asserts it in `before` and `after`; exact equality retained |
| 2–5 | Yes | none introduced; round 2 accepted the rejection of the injected-error test | — | — |

Round 3 decision: `contract-changed` reported CHANGED, so round 3 ran.

### Round 3 — verification, resumed session `01a0adb0-dc33-7372-ae5a-4e580e36636f`, VERDICT: APPROVED

Finding 1's remaining gap (the `users` read control) closed; no defect introduced. Report: `.feature/codex/plan-round-3-report.md`.
