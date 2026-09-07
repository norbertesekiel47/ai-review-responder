# Red team — pass 5 (final), `fix-1171-job-outbox-rls`

- **Run id** `standalone-1171-1266b2c-cff373` · mode `standalone` · risk `high` · round 1
- **Fork / merge-base** `602e98930810177230c0edbc0830063db5f75d43`
- **HEAD** `1266b2cb7e1f5326482bab9bbcca27f1bc34f1e7`
- **Status** `OPEN_P0` — 2 open P0, 5 open P1, 3 open P2

Scope as briefed: the apply-and-assert rebuild (A), the degrade/restore step (B),
the R2 exemption (C), the staging evidence (D), and a fifth whole re-read of the
migration (E).

## Protocol notes — what this pass did to its own instrumentation

- **The journal was rotated.** `round-start` refused ("round 3 exceeds the hard cap
  of 2") because the counter is per-JOURNAL and pass 4 had spent both rounds; pass 4
  had itself rotated. This pass preserved pass 4's journal as
  `.feature/red-team-journal.pass4-round2.bak.json` before opening round 1. Both are
  gitignored (`.gitignore:175`); all pass-4 mutations were `restored` and its dotenv
  swap closed, so nothing was stranded.
- **`round-start` was called a second time mid-pass** to reset the run budget before
  the last two measurements. The journal therefore reads round 2; this report records
  round 1, because it is one pass. Stated rather than left to be found.
- **`supabase/migrations/` was mutated, against the skill's default exclusion.** That
  exclusion's premise ("the database is provisioned before the run, so mutating a
  migration changes nothing under test") is void at this HEAD: the suite reads AND
  executes the checked-in file at run time (`:336`, `:410`). Every mutation was
  journaled and finalized.
- **Database discipline.** Both Supabase projects were read-only throughout — SELECT
  and catalogue introspection only, no write of any kind, and specifically no write to
  staging. All mutation ran against the local throwaway container `repworth-testdb`
  (`postgres:16`, port 5499).

## Findings

| Severity | file:line | Finding |
|---|---|---|
| **P0** | `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:324-443` | The apply-and-assert case reads only `public.job_outbox`, so migration 119 may carry arbitrary off-target DDL and stay green — proven with `GRANT ALL ON admin_audit_log TO anon;`, which the guard deleted in the same commit killed |
| **P0** | `…migration-119-job-outbox-rls.integration.test.ts:9-70,101` | The header block still documents the deleted parser and asserts "No DDL (`ci:live-db-suites` R2)" about a suite that now executes DDL — six false claims |
| **P1** | `…migration-119-job-outbox-rls.integration.test.ts:429-442` | The `finally` unconditionally revokes `service_role` and silently strips it on any localhost database that legitimately holds those grants — measured |
| **P1** | `…migration-119-job-outbox-rls.integration.test.ts:15-21` | The suite erases its own behind-head signal: a degraded container fails once, then passes 5/5 with no re-provisioning |
| **P1** | `supabase/migrations/119_job_outbox_rls.sql:74-84` | "The ALTER is the only lock this migration acquires" is false — `COMMENT ON TABLE` takes `ShareUpdateExclusiveLock`, and on production it is the *only* relation lock 119 takes |
| **P1** | `…migration-119-job-outbox-rls.integration.test.ts:332-335` | The R2 safety argument overstates the lock: 18 live-DB suites bind `job_outbox` and never take it; the exclusion comes from vitest's `fileParallelism: false`, not from the lock |
| **P1** | `…migration-119-job-outbox-rls.integration.test.ts:428` | `expect(after?.acl_is_default).toBe(before?.acl_is_default)` is a tautology — both sides are unconditionally `false` |
| **P2** | `supabase/migrations/119_job_outbox_rls.sql:114,116,122,124` | The guard predicate is schema-qualified; the three statements it guards are not |
| **P2** | `…migration-119-job-outbox-rls.integration.test.ts:429-442` | The `finally` does not restore from the `before` snapshot it holds; a failing run leaves the container altered (loudly caught next run) |
| **P2** | `.claude/reference/migrations-log.md` | Sibling result: 20 staging / 21 production tables still carry the residual posture 119's REVOKE half removes; `anon` holds TRUNCATE on 49 / 50 tables |

Full arbiter reasoning for every row is in `findings.json`.

### RT5-F1 (P0) — the guard no longer bounds what migration 119 may contain

`readPosture()` (`:347-383`) selects from `pg_class WHERE oid =
'public.job_outbox'::regclass` and nothing else. Steps 4 and 5 assert `rls`,
`force`, `policies`, `client_privileges`, `non_client_acl` and `acl_is_default`
for that one relation. Step 3 applies the **whole file** through `db.unsafe`, so
every statement executes — but only `job_outbox`-visible effects are read back.

Measured in-tree under vitest, live container attached, `assert-one-test`
confirming exactly one executed test:

| mutant appended to 119 | case | catalogue effect |
|---|---|---|
| `GRANT ALL ON admin_audit_log TO anon;` | **PASSED** | `admin_audit_log.relacl` `{test=arwdDxt/test}` → `{test=arwdDxt/test,anon=arwdDxt/test}` |
| `ALTER TABLE accounts FORCE ROW LEVEL SECURITY;` | **PASSED** | `accounts.relforcerowsecurity` `false` → `true` |

The first grants `anon` all eight privileges — TRUNCATE included — on migration
117's deny-all admin audit log, and RLS with zero policies does not cover
TRUNCATE. The second subjects the billing-parent table to RLS for its own owner.

**A regression, not merely a limitation.** At `929c53dd` the suite asserted, on the
file text with no database:

    :193  expect(statements.filter((s) => /^GRANT\b/i.test(s))).toEqual([]);
    :202  expect(executable.match(/\bGRANT\b/gi)).toBeNull();

That killed the `admin_audit_log` mutant exactly. `07dc5e18` deleted it. The
`accounts` mutant survived both forms, so that half is a pre-existing hole.

Reachability checked rather than assumed. The deviations doc justifies the deletion
with "they protected a file that **cannot be edited** — a migration is immutable once
applied, hook-enforced". The hook (`.claude/hooks/migration-immutability-guard.sh`,
registered at `.claude/settings.json:32`) is a **local agent-harness `PreToolUse`
guard on Edit/Write/MultiEdit** with a documented `MIGRATION_GUARD_DISABLE=1` escape.
It does not see a plain editor, a Bash write, or a CI job. `ci:agent-config` only
asserts the hook file is registered; **no `ci:*` script gates migration content**. And
119 is applied to staging but *not* production, so the production apply is still ahead.

### RT5-F2 (P0) — the header documents a suite that no longer exists

| line | claim | reality at HEAD |
|---|---|---|
| `:11` | "No DDL (`ci:live-db-suites` R2)." | The suite executes `ALTER TABLE … DISABLE ROW LEVEL SECURITY`, `GRANT`, `REVOKE` and the whole migration (`:396-399`, `:410`, `:440-441`) |
| `:12-13` | "every case reads the catalogue or the checked-in migration file" | False, same reason |
| `:25` | "CATALOGUE (titles 1, 2, 4) … FILE TEXT (title 3)" | The numbering does not map to the file; there is no title 3 text guard |
| `:47-52` | "FILE TEXT (title 3) … the **ONLY** environment-independent guard against a WIDENED revoke … parses top-level STATEMENTS" | `topLevelStatements` was deleted at `07dc5e18` |
| `:61-70` | "both are guarded by title 3's exact-match statement assertion" | That assertion does not exist |
| `:101` | "registry + file text: no database needed, so **never a silent skip**" | Only the registry case remains DB-free; its replacement sits behind `describeWithDb({ enabled: Boolean(testDatabaseUrl) })`, so with no live database the whole security guard skips silently — the pre-rebuild text arms ran keylessly |

`:11` is the sharpest: RT5-10 proves the audit reports `runtime-ddl` for this file the
moment the allowlist entry is removed, so the header denies the property the same
commit had to allowlist around.

### RT5-F3 (P1) — the restore strips `service_role` on a container that legitimately has it

Unmutated file. `job_outbox.relacl` set to `{test=arwdDxt/test,service_role=arwdDxt/test}`
— the posture **both** Supabase projects carry today, and any local restore of a
staging dump. The suite ran, the case reported **PASSED**, and the ACL came back
`{test=arwdDxt/test}`. `service_role`'s privileges on the dispatch spine are gone and
nothing reports it.

Cause: `:440`, unconditional, followed by a migration re-apply that never re-grants.
The brief's guard was verified rather than trusted — `assertLocalTestDatabaseUrl`
(`helpers/live-db-lock.ts:75-93`) tests only that the protocol is
`postgres`/`postgresql` and the hostname is `localhost` or `127.0.0.1`. An `ssh -L` /
`kubectl port-forward` tunnel, or a local Supabase stack restored from a staging dump,
satisfies it. The case already holds what a correct restore needs —
`before.non_client_acl` names every non-client grantee and privilege — and does not
use it.

### RT5-F4 (P1) — the behind-head detector is one-shot

The header's argument for having no `assertSchemaReady` is `:19-21`, "Title 1 is the
real detector of a container behind head". Measured: degrade the container to the
pre-119 posture, run the **full** file twice with no re-provisioning between runs.

    run 1 → 3 passed, 2 failed   (RLS/policies + ACL, carrying "…not at migration
                                  head — run pnpm test:db:setup")
    run 2 → 5 passed             (no re-provision)

Run 1's apply-and-assert case repaired `job_outbox` in its own `finally`. A developer
or CI job that re-runs and sees green concludes flake — then runs every other live-DB
suite against a container still behind head for every other migration, where
`assertSchemaReady` catches it and this suite deliberately has none.

### RT5-F5 (P1) — the wrong statement is named as the lock

`:80-81` states "`REVOKE` takes no relation lock at all. The ALTER is therefore the
only lock this migration acquires." The REVOKE half is correct; the conclusion is not
— measured on the container (PostgreSQL 16.14):

    BEGIN; COMMENT ON TABLE job_outbox IS 'probe';
    → pg_locks: ShareUpdateExclusiveLock, granted=true

Held to COMMIT. On **production** the guarded ALTER is a proven no-op
(`relrowsecurity` already `true`, re-verified this pass), so the `COMMENT`'s
`ShareUpdateExclusiveLock` is in fact the *only* relation lock 119 takes there. Impact
bounded — it does not conflict with DML and `SET LOCAL lock_timeout = '5s'` covers it
— but it does conflict with autovacuum, `ANALYZE`, `CREATE INDEX CONCURRENTLY` and any
concurrent `ALTER` on the busiest table in the schema, and the production-safety
paragraph says otherwise.

## D — the staging evidence, re-resolved read-only

Every number in the `1266b2cb` migrations-log entry re-derived against the live
projects. **9 of 9 reproduce.**

| Claim (staging `kubdiqdhqbhwmqfditeg`) | Observed | |
|---|---|---|
| `relrowsecurity = true` | `true` | REPRODUCES |
| `relforcerowsecurity = false` | `false` | REPRODUCES |
| 0 policies | `0` | REPRODUCES |
| `anon` + `authenticated` → none | absent from `relacl`; `has_table_privilege` zero rows for both | REPRODUCES |
| `service_role` 8 | `arwdDxtm`, exactly 8 | REPRODUCES |
| owner (`postgres`) 8 | `arwdDxtm`, exactly 8 | REPRODUCES |
| 0 column ACLs | `0` | REPRODUCES |
| 46 rows readable by the owner | `46` | REPRODUCES |
| `MAINTAIN` present | present; PostgreSQL **17.6** (container is 16.14) | REPRODUCES |

Live `relacl` on staging: `{postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}`.

**The applied comment is the committed comment**, checked byte-for-byte rather than by
eye: live `obj_description` is 228 bytes, md5 `7b88d54454663e979bb8d4f2709c4d89`; the
`COMMENT ON TABLE` payload parsed out of `119_job_outbox_rls.sql` at HEAD is 228 bytes
with the same md5. (An earlier reading in this pass suggested a drafting drift; it was
wrong — it had compared the file's `--` header prose against the `COMMENT` payload.
Recorded so the retraction is on the record.)

**Production is untouched and still carries the pre-119 posture — CONFIRMED.**
`udeyaqnvpojbwgoaxwdg`: `relrowsecurity = true`, `relforcerowsecurity = false`, 0
policies, 0 column ACLs, table comment **NULL**, `relacl` still
`{postgres=…,anon=arwdDxtm,authenticated=arwdDxtm,service_role=…}`.
`has_table_privilege('anon','public.job_outbox','INSERT')` → `true`; `… 'TRUNCATE'` →
`true`. The REVOKE has not run there.

Neither project's `supabase_migrations.schema_migrations` carries a 119 row — expected,
and the reason the migration header mandates introspection over the ledger.

## E — the migration, fifth whole re-read

Confirmations (unchanged): the guarded `DO` block is a true no-op on production; FORCE
is deliberately absent and asserted absent; zero policies IS the deny-all; the REVOKE
names only `anon` and `authenticated`, never the owner, `service_role` or `PUBLIC`; the
whole file is one transaction with `SET LOCAL`; it is re-runnable. Refutations this
pass: **RT5-F5** (the lock paragraph) and **RT5-F8** (unqualified relation names under
a qualified guard).

## C — the R2 exemption

- **The lock does span the DDL window.** `acquireLiveDbLock` at `:128` in `beforeAll`,
  released at `:147` in `afterAll`, on its own client created before `db` — so `max: 1`
  on the suite client cannot starve it.
- **`ci:live-db-suites` enforces the entry, and the entry is load-bearing.** Removing
  the allowlist line makes the audit fail with `[runtime-ddl] … (first at line 396)`
  (RT5-10). Enforcement of the *lock* is `text.includes('acquireLiveDbLock')`
  (`:499-501`) — presence, not position, a bound the audit's own JSDoc states — but in
  this file the call really is in `beforeAll`.
- **Deadlock: no.** A cycle would need a sibling to hold `job_outbox` row locks and
  then wait on the advisory lock. Non-enrolled suites never request it, so no cycle can
  form. The real exposure is a lock-queue **stall**, bounded by
  `statement_timeout: 30_000` (the degrade at `:396-399` sets no `lock_timeout` of its
  own, unlike the migration's 5 s). Recorded as **RT5-F6**.

## Duties 2, 4 and 5

- **Duty 2.** One found: **RT5-F7**, the `acl_is_default` tautology. `expect(acl)`,
  `expect(effective)` (`:219`, `:260`) are behavioural and sound; the derived-privilege
  floor at `:275` is the correct shape of guard against a vacuous CROSS JOIN.
- **Duty 4.** Search recorded in full in `findings.json` RT5-F10 — scope, patterns,
  exclusions. Zero siblings inside the branch's diff. Across the live projects: **zero**
  tables with RLS off in either (the pre-119 posture is extinct), but **20 staging / 21
  production** tables still carry RLS-on + zero policies + `anon` and `authenticated`
  holding all eight default privileges, and 49 / 50 tables grant TRUNCATE to a client
  role. Out of scope for this branch; recorded so the sound search is on the record.
- **Duty 5.** No alert-path finding owed: the diff adds a migration, a test suite and
  one allowlist line, and emits no Sentry signal, so there is no rule row to pair. The
  two operator-facing items are **RT5-F3** and **RT5-F9**, both about the shared test
  container.

## Container and worktree state

- The local test container was snapshotted before the first mutation and re-verified
  after the last. Final check across the **whole** `public` schema: `rls-off tables:
  (none)` · `tables with anon/auth/PUBLIC in relacl: (none)` · `forced-rls tables:
  (none)`, and `job_outbox` / `accounts` diff clean against the pre-run snapshot.
- `mutation-runner finalize` reports every journaled process group reaped, all
  mutations restored and the journal closed.
- `git status --porcelain --untracked-files=no` is empty; HEAD unmoved at
  `1266b2cb7e1f5326482bab9bbcca27f1bc34f1e7`; `git hash-object
  supabase/migrations/119_job_outbox_rls.sql` is
  `3e91120603e6875ccf9406201b719c1a44920d22`, the journal's recorded original.
- `ci:live-db-suites`, `ci:directory-map`, `ci:static-policy` and `ci:rls-audit` all
  PASS at HEAD.

## Authorizations

None.
