# Red team — fix-1176-client-role-grant-sweep (feature, round 2)

- Mode: feature · Risk: high · Issue #1176
- Fork `b73c6a001b7467b6ac3811fa5ddbc5e30e3bfb58` = merge-base · HEAD `2dd74a20fcf7cc761a46b183f7b88268768c9710`
- Intake SHA-256 `13cc93ffdfcc6bc74bcb87d280b73e4b94332edaf485bfa48870a4400c4203b2` (`.feature/intake.json`, byte-identical to the committed copy)
- Generated 2026-09-17T12:58:04Z
- **Status: CLEAR** — 12 inventory rows: 10 killed, 0 inconclusive, 2 excluded. Findings: 0 P0, 0 open P1, 1 open P2; 3 fixed.

> Rendered from `findings.json` (the round-2 sidecar) by the orchestrating session. The round-2 agent's own write of this file failed, so the JSON is the source; every row below restates its `reason`. Round 1 (head `b39178a60`, status INCOMPLETE_ORACLE) is in git history at commit `762233bbb`.

## Scope

Round 2 is scoped to the fix hunks between the round-1 head `b39178a60` and HEAD, their direct callers, and round 1's two inconclusive oracle rows (INV-8, INV-9).

## Environments

- Local test DB: localhost, postgres:16, `server_version_num` 160014 — the CI major.
- Disposable postgres:17-alpine container: localhost:5517, `server_version_num` 170010, provisioned by the repo driver (`test-db-bootstrap.sql`, then all 122 migrations), removed after the pass.
- No connection to staging or production. `.env.local` swapped and restored. 24 of 30 runs used.

## Inventory

| ID | Candidate | Outcome | Evidence |
|---|---|---|---|
| INV-1 | removes TRUNCATE, REFERENCES, TRIGGER and MAINTAIN on every public table | killed | PG17: M8a (`:111` table-level REVOKE MAINTAIN deleted) and M8c (version gate `:110` raised to 180000) fail — anon:MAINTAIN survives on `account_audit_log`. Round-1 PG16 kills stand; migration blob unchanged. |
| INV-2 | removes every client privilege from the twenty deny-all tables | killed | PG16: M2a (drops `solicitation_unsubscribe_tokens` from the REVOKE ALL list) fails. |
| INV-3 | keeps client DML elsewhere; owner and service_role unchanged | killed | PG16: M3a (adds DELETE to the revoke) fails on `reviews`. |
| INV-4 | no RLS flag, policy or column-grant change | killed | PG17: M4b (FORCE RLS on `agent_runs`) and M4c (DISABLE RLS on `reviews`) fail. After each run: 0 forced / 58 RLS tables — the RT-3 restore works. |
| INV-5 | default privileges lose the four rights, keep DML | killed | PG17: M8b (`:112` default REVOKE MAINTAIN deleted) and M8c fail — the default probe keeps anon:MAINTAIN. |
| INV-6 | second apply is a no-op | killed | PG16: M6a (toggling DO block) fails. |
| INV-7 | owner guard refuses | killed | PG16: M7a (RAISE EXCEPTION → WARNING) fails. |
| INV-8 | PG17 MAINTAIN branch `:108-114`, via INV-1 and INV-5 on PostgreSQL 17 | killed | Resolves round 1's inconclusive row. Suite baseline on PG17: 8 passed. M8a, M8b, M8c: 4 of 4 killed. CI stays PG16 (RT-4). |
| INV-9 | lock-contention case for `SET LOCAL lock_timeout` `:70` | killed | Resolves round 1's inconclusive row. PG16: M9a (line deleted) and M9b (moved after step 4) fail with "expected 57014 to be 55P03" at the 15 s applier timeout. Also green on PG17. |
| INV-10 | `pnpm ci:live-db-suites` — `MIGRATION_SHAPE_FILES` entry | killed | Round-1 kill MA1 carried (audit file unchanged); baseline re-run at HEAD passed. |
| INV-11 | `scripts/ci/__tests__/live-db-suites-audit.test.ts` | excluded | Unchanged importer; synthetic content only; INV-10 measures the hunk. |
| INV-12 | `restore()` RLS-flag restore and verification (RT-3 fix hunk) | excluded | Runs in `beforeAll`, no single `it()` oracle. Measured out of suite: flags clean after M4b/M4c; with the flag-apply line removed plus M4b, `beforeAll` failed — the verification is not vacuous. |

## Findings

| Severity | Location | Finding | Disposition |
|---|---|---|---|
| P1 | `supabase/migrations/122_client_role_grant_sweep.sql:110` | RT-1: the PG17 MAINTAIN branch and the `lock_timeout` backstop had no executable covering test | fixed |
| P2 | `docs/superpowers/plans/fix-1176-client-role-grant-sweep-handoff.md:4` | RT-2: handoff and deviation D6 stale after the #1302 merge | fixed |
| P2 | `src/lib/shared/__tests__/migration-122-client-role-grant-sweep.integration.test.ts:323` | RT-3: suite restore ignored RLS/FORCE flags | fixed |
| P2 | `.github/workflows/ci.yml:252` | RT-4: CI runs the suite on PostgreSQL 16 only, so no CI run executes the MAINTAIN branch | open |

### Arbiter reasoning

- **RT-1 — fixed.** The lock-contention case kills M9a and M9b on PG16. On PG17, INV-1 and INV-5 kill each MAINTAIN mutant and the gate mutant (4 of 4). The uncovered-change condition no longer holds; the CI residual is RT-4.
- **RT-2 — fixed.** Handoff line 4 records fork `889c8be6e` at creation and merge-base `b73c6a001`; `b39178a60` is the merge commit; D6 records the owner decision. D7 claims hold: intake copies byte-identical, the eighth title matches the suite verbatim, 55P03 vs 57014 reproduced.
- **RT-3 — fixed.** Flags restored under M4b and M4c; removing the flag-apply line makes `beforeAll` fail. Flags are computed after the ROLLBACK, applied inside the restore transaction, and re-read before the grant comparison.
- **RT-4 — open, P2.** A covering test exists and kills every MAINTAIN mutant on PG17, so this is not an uncovered change. What is missing is a PG17 CI lane: a later edit to that branch would pass CI unchecked. Mitigations in the contract: the migration applies once, staging first, and the mandatory PG17 four-right post-apply query in migrations-log entry 122 must return 0 on each project.

## Authorizations

None.

## Restoration

All 14 mutations (13 to the migration, 1 to the suite) restored; both blobs match HEAD. The orchestrator's `finalize` closed the journal (0 files needed restoring). `.env.local` restored. The PG17 container and the scratch files holding its URL were removed. The PG16 test DB is clean: 0 forced tables, no client role holds TRUNCATE.
