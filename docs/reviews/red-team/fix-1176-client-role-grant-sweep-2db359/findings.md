# Red team — fix-1176-client-role-grant-sweep (feature, round 1)

- Mode: feature · Risk: high · Issue #1176
- Fork `b73c6a001b7467b6ac3811fa5ddbc5e30e3bfb58` = merge-base · HEAD `b39178a6019ba43301519473063ba7297f9857ab`
- Intake SHA-256 `868cf514966b8a8f65b8e3c8359e46ae38645b13cddfa48682b943f726c8422c` (`.feature/intake.json`, byte-identical to the committed copy)
- **Status: INCOMPLETE_ORACLE** — 11 inventory rows: 8 killed, 2 inconclusive (oracle), 1 excluded. Findings: 0 P0, 1 open P1, 2 open P2.

## Preconditions

- The worktree was clean at HEAD. `watchers`: none.
- `round-start`: round 1 opened with 30 runs available. 24 runs were used.
- The environment followed the allowlist: temporary HOME and `TEST_DATABASE_POOL_URL` from the local test container only (localhost, postgres:16). `dotenv-swap` scrubbed `.env.local` for the mutation phase and `dotenv-restore` put it back. No connection was made to staging or production.

## Severity table

| Severity | file:line | Finding | Disposition |
|---|---|---|---|
| P1 | supabase/migrations/122_client_role_grant_sweep.sql:110 | RT-1: two hunks have no executable covering test: the PG17 MAINTAIN branch (108-114) and the `lock_timeout` backstop (70). The only proof is the mandatory post-apply PG17 query. | open (high risk, so the user adjudicates) |
| P2 | docs/superpowers/plans/fix-1176-client-role-grant-sweep-handoff.md:25 | RT-2: the handoff (fork point, "Red team BLOCKED") and deviation D6 are stale after the #1302 merge | open |
| P2 | src/lib/shared/__tests__/migration-122-client-role-grant-sweep.integration.test.ts:320 | RT-3: the suite's restore reverts only grants and the default ACL, so a migration that changes RLS leaves the shared test DB dirty | open |

## Scope decision: mutating the migration

The skill excludes `supabase/migrations/` because the database is normally provisioned before the run, so changing the file changes nothing under test. That premise does not hold here. The 122 suite `readFileSync`s the checked-in file inside `beforeAll` and applies it verbatim with `db.unsafe`. A mutant of the file is therefore exactly what the suite executes. Mutations ran against the local test DB only, with one mutant per run. Each mutant was restored by named-path `git checkout -- <file>` and verified against the HEAD blob before the next mutation. The orchestrator's `finalize` will find every journaled entry at its original OID.

## Inventory

| ID | Candidate | Outcome | Evidence |
|---|---|---|---|
| INV-1 | removes the four rights on every public table | killed | M1a drops TRIGGER (:88) → fails. M1b revokes FROM anon only → fails. |
| INV-2 | removes every client privilege from the twenty deny-all tables | killed | M2a removes one table from the list → fails. M2b narrows REVOKE ALL to SELECT/INSERT/UPDATE → fails. |
| INV-3 | keeps client DML elsewhere, owner and service_role unchanged | killed | M3a adds DELETE → fails on reviews. M3b adds service_role → non-client ACL diff fails. |
| INV-4 | no RLS flag, policy or column-grant change | killed | M4a REVOKE ALL on businesses → column ACL fails. M4b FORCE RLS on agent_runs → fails. The force flag was then reset by hand (RT-3). |
| INV-5 | default privileges lose the four rights and keep DML | killed | M5a deletes step 3 → fails. M5b REVOKE ALL defaults → fails. |
| INV-6 | second apply is a no-op | killed | M6a appends a toggling GRANT/REVOKE DO block → fails. |
| INV-7 | owner guard refuses | killed | M7a turns RAISE EXCEPTION into WARNING → fails. M7b narrows the guard to relkind 'p' → fails. |
| INV-8 | PG17 MAINTAIN branch (:108-114) | inconclusive (oracle) → RT-1 | The container is PG16 (160014; ci.yml:252 `postgres:16`), so the branch cannot execute. Not mutated. |
| INV-9 | `SET LOCAL lock_timeout` (:70) | inconclusive (oracle) → RT-1 | Only contention can observe it and no test creates contention. Not proven equivalent, because it also bounds pg_class tuple-lock waits. |
| INV-10 | `MIGRATION_SHAPE_FILES` entry (scripts/ci/live-db-suites-audit.ts:136-138), oracle `pnpm ci:live-db-suites` | killed | The first baseline was red for an infra reason: the tsx IPC socket path under the long TMPDIR was too long. Rerun with a short home: green. MA1 deletes the entry → audit fails with runtime-ddl on the 122 suite. |
| INV-11 | scripts/ci/__tests__/live-db-suites-audit.test.ts | excluded | This unchanged importer tests synthetic content only and cannot observe the real-tree entry. |

Every baseline (B1–B7, BA2) passed, and `assert-one-test` confirmed exactly one executed test for each Vitest run. Every mutant run also executed exactly one test and failed on an assertion, not on setup. `beforeAll` finished each time, so the suite's self-verifying restore passed.

## Out-of-suite measurements (not test oracles)

- **PG17 correctness (RT-1).** The check ran on a throwaway `postgres:17-alpine` container (170010) with roles anon, authenticated and service_role, and 22 synthetic RLS tables (the twenty plus reviews and users) under default ALL grants. The checked-in file applied cleanly twice. The effective count of the four rights (including MAINTAIN) was 0, reviews kept 8 client DML rights, and service_role kept MAINTAIN on all 22. A rolled-back new-table probe showed client SELECT/INSERT/UPDATE/DELETE only. The container was stopped with `--rm`.
- **Locking claim.** A second throwaway PG17 ran `REVOKE TRUNCATE` with `lock_timeout = '1s'` while another session held ACCESS EXCLUSIVE, and again under ROW EXCLUSIVE. It completed both times, which supports the header claim that "REVOKE takes no relation lock".

## Duty 2 — fragile assertions

The seven cases were scanned and none was found. The array comparisons read SQL with `ORDER BY`, so an ordering contract exists. No absence-of-tag proxies or exact string counts are used. The guard case's kill surfaced as Chai rejecting `toContain` on `null`. That still fails closed, and the test checks the real behaviour (a missing error).

## Duty 3 — docs vs reality

`prevalidate-plan.py` ran on the plan, handoff, deviations, migrations-log and triage. Citations: 0 in each. The four "stale commit" hits are Codex session UUID fragments (`01a0adb0…`, `01a0adcc…`), which are false positives. The following claims were hand-checked against HEAD and hold:

- `.github/workflows/ci.yml:252` is `postgres:16`.
- `055_auto_approval_policy.sql:72` and `076_judge_verdicts_governor.sql:61` revoke authenticated INSERT/UPDATE/DELETE.
- supabase-js reads `users` only, at `src/proxy.ts:252`, `src/app/api/auth/callback/route.ts:112` and `src/components/auth/hooks/useLoginSubmit.ts:94`. No other `.from('<table>')` exists in `src` or `worker` outside tests.
- Column ACLs exist only on businesses and channel_enrollments (local DB).
- There are 58 public tables and 0 views, matviews or foreign tables (local DB).
- There is no path:line claim to re-resolve.

Stale items are recorded as RT-2.

## Duty 4 — missed sibling cases

- **Pattern:** deny-all tables (RLS on, zero `pg_policy` rows) in `public` at migrations head on the local test DB. **Result:** 29. That is the twenty in the migration plus the nine the intake names as already revoked. For each of the nine, `rg "REVOKE ALL[^;]*\b<table>\b" supabase/migrations` finds its revoke: 056 (account_offboarding_tokens, account_offboardings), 117 (admin_audit_log), 118 (poller_heartbeats), 119 (job_outbox), 120 (agent_conversations, agent_proposals, agent_turns, agent_unsupported_requests). **Siblings missed: 0.**
- **Pattern:** relkind v/m/f/p in public. **Result:** 0.
- **Exclusions:** sequences, functions and supabase_admin defaults (intake non-goals, #1300). Production data was not read.

## Duty 5 — operational completeness

The diff adds no runtime code path, Sentry signal or `beta-launch-alerting.md` rule: it is a migration plus a test and a CI allowlist entry. The detectors the intake relies on (post-apply introspection and 42501 watch) are manual acceptance steps. There is nothing to compare statically, and nothing was found.

## Restoration

- The migration was mutated 13 times and the audit script twice (MA1 ran twice because of the infra retry). Each time the file was restored by named-path checkout and its hash verified against HEAD. `git status --porcelain` was empty before the report files were written.
- `.env.local` was restored with `dotenv-restore`.
- The local test DB was restored by the suite on every run, and `agent_runs` FORCE RLS was reset by hand (0 forced tables re-read).
- The journal still holds 15 entries in state `applied` whose working blob equals `originalOid`. The orchestrator's `finalize` closes them. It was not run here, per instruction.

## Authorizations

None.
