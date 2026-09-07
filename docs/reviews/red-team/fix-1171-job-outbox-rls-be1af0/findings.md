# Red-team pass — `fix-1171-job-outbox-rls`

- **Mode:** feature · **Round:** 1 · **Risk:** high (from the signed-off intake)
- **fork / merge-base:** `602e98930810177230c0edbc0830063db5f75d43`
- **HEAD (subject):** `3a7d0ca9930ae60c5ebbafb25cd962675d751e78`
- **intake sha256:** `f0c748c386b0714fcf8360f40e19a43624ba69542d66460872293d1c89bfac7e` (`.feature/intake.json` and `docs/superpowers/plans/fix-1171-job-outbox-rls-intake.json` are byte-identical)
- **Status:** `OPEN_P0`

## Preconditions

| Check | Result |
|---|---|
| Tracked tree clean at HEAD | yes — only `?? docs/reviews/fix-1171-job-outbox-rls/` (a concurrent reviewer's staging dir, untracked) |
| `mutation-runner.mjs watchers` | `none — no dev server, watch worker, or E2E server is serving this worktree` |
| `mutation-runner.mjs round-start` | `round 1 open, 30 mutation runs available` |
| Env isolation | `mutation-runner.mjs env --tmp-home <mktemp -d> --test-db postgresql://test:***@localhost:5499/<db>` — allowlist only; `TEST_DATABASE_POOL_URL` validated localhost. No dotenv swap was needed: the runner injects the allowlisted `TEST_DATABASE_POOL_URL`, which covered every live-DB candidate. |

## Journal of side effects, and their restoration

1. **Files.** Eight file mutations, each applied through `mutation-runner.mjs mutate` (blob-OID journaled) and reverted by `mutation-runner.mjs finalize` inside the same cycle. Final `finalize`: `reap: every journaled process group is empty (16 recorded)` / `finalize: restored 0 mutated file(s) and 0 dotenv file(s); journal closed`. `git status --porcelain` after restoration shows only the untracked concurrent-reviewer directory; `git rev-parse HEAD` is unmoved at `3a7d0ca9`.
2. **Database.** Catalogue mutations were NOT applied to the shared `test_ws4`, because concurrent reviewers share this worktree and this local Postgres. A throwaway clone was created — `CREATE DATABASE test_rt1171 TEMPLATE test_ws4;` — every catalogue mutation ran against the clone, and the clone was dropped (`DROP DATABASE IF EXISTS test_rt1171;`). Post-run introspection of `test_ws4` confirms it never moved: `relrowsecurity = t`, `relforcerowsecurity = f`, `pg_policies` count `0`. `pnpm test:db:setup` was deliberately NOT run — it drops schema `public` and would have raced the concurrent reviewers for the live-DB advisory lock.
3. **Remote databases.** Production (`udeyaqnvpojbwgoaxwdg`) and staging (`kubdiqdhqbhwmqfditeg`) were read with `SELECT`-only introspection through the Supabase MCP. No write, no DDL, no `apply_migration`.

## Protocol deviations, stated rather than hidden

- **The "at most 2 mutations per test" cap was exceeded on three rows** — 4 on `T2`, 4 on `T3`, 3 on `T6`. Total runs 16 of the 30-per-round budget, so the round budget held. The extra mutants produced RT-1, RT-2 and RT-5; the deviation added evidence rather than removing it, and it is recorded here so the arbiter can discount it.
- **`supabase/migrations/` is normally out of scope** ("the database is provisioned before the run, so mutating a migration changes nothing under test"). That exclusion does not hold for this diff: three of the six assertions read `supabase/migrations/119_job_outbox_rls.sql` as FILE TEXT, so a migration mutation is directly under test. Rows `T2`/`T3` therefore mutate the migration file rather than being `excluded`.

---

## Duty 1 — hand-mutation

Baseline at HEAD against a clone of the at-head test database: **6/6 passed** (`numTotalTests 6, numPassedTests 6, numFailedTests 0`).

| # | Target | Mutation | Test run | Result |
|---|---|---|---|---|
| C1 | catalogue | `ALTER TABLE job_outbox DISABLE ROW LEVEL SECURITY` | T4 | **killed** |
| C2 | catalogue | `CREATE POLICY rt_probe ON job_outbox FOR SELECT USING (true)` | T4 | **killed** |
| C3 | catalogue | `ALTER TABLE job_outbox FORCE ROW LEVEL SECURITY` | T5 | **killed** |
| C4 | catalogue | `GRANT SELECT ON job_outbox TO anon` | T6 | **killed** |
| C5 | catalogue | `REVOKE ALL ON job_outbox FROM test` (the owner) | T6 | **SURVIVED → RT-1 (P0)** |
| F1 | migration | delete the `REVOKE ALL …` line | T2 | **killed** |
| F2 | migration | widen to `… FROM anon, authenticated, service_role;` | T2 | **killed** |
| F3 | migration | append `CREATE POLICY job_outbox_read … USING (true);` | T3 | **killed** |
| F4 | migration | append `ALTER TABLE job_outbox FORCE ROW LEVEL SECURITY;` | T3 | **killed** |
| F5 | migration | delete `ALTER TABLE … ENABLE ROW LEVEL SECURITY;` | T3 | **killed** |
| F6 | migration | keep the REVOKE, append `GRANT SELECT, INSERT ON job_outbox TO authenticated;` | T2, T3 | survived both (→ RT-5, P2; killed by T6, same class as C4) |
| F7 | migration | append `SELECT 1; REVOKE ALL ON job_outbox FROM service_role;` | T2, T6 | survived both (→ RT-2, P1) |
| F8 | `scripts/ci/tenant-tables.ts` | delete the `job_outbox` `REVIEWED_NOT_TENANT_SCOPED` entry | T1 | **killed** |

`assert-one-test` reported `exactly one test executed` on every `-t`-filtered run.

### RT-1 — the owner arms of the privileges case cannot fail in any environment the suite runs in (P0)

**Mutation.** On the clone, `REVOKE ALL ON job_outbox FROM test;` — `test` is the table owner in the local container. This is precisely the "widened REVOKE" the assertion's own comment names as its target.

**Observed.**

```
REVOKE
{}        -- pg_class.relacl: every privilege removed, owner included
t|t       -- has_table_privilege('test','public.job_outbox','SELECT') | pg_roles.rolsuper
passed | migration 119 job_outbox deny-all RLS migration 119 leaves the job_outbox
         owner's privileges intact and denies the client roles
```

**Expected.** The test fails. Its comment at `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:238` states verbatim: *"The four owner arms are the load-bearing half — NOT vacuous on any container, and exactly what a widened REVOKE would break."*

**Root cause.** `has_table_privilege()` returns TRUE unconditionally for a SUPERUSER, whatever the ACL says. The local test container's `job_outbox` owner is `test`, and `test` is the bootstrap superuser (`pg_roles.rolsuper = t`, measured above). The four `owner_*: true` arms at lines 248-251 are constants, not observations.

**Arbiter confirmation.** The mutant is not equivalent: `pg_class.relacl` changed from a populated ACL to `{}`, and a non-superuser owner would have lost every privilege on the outbox — the exact platform-stopping outcome the comment describes. It is not on an unexecuted branch: the assertion issues the query and compares all eight fields on every run, and the same assertion correctly FAILED under C4. The survival is caused by the oracle, not by the mutant being inert.

**Generality — not "local only".** The CI `test` job stands up `postgres:16` with `POSTGRES_USER: test` (`.github/workflows/ci.yml:251`), so the owner in CI is the same bootstrap superuser and the arms are equally inert there. The suite runs in no other environment. On the two Supabase projects the owner is `postgres` with `rolsuper=false, rolbypassrls=true` (introspected 2026-09-07), where the arms WOULD be load-bearing — but the suite never runs against them.

**Why P0 rather than P1.** Both halves of the P0 definition at once.

1. *A proven-fake assertion.* After D2 dropped the `service_role` arms, the only assertion in the suite that can detect a widened REVOKE is this case's owner half — measured inert. The branch designates this suite as the sole regression guard for the boundary, because `ci:rls-audit` audits only `TENANT_TABLES` and `job_outbox` is deliberately not a member (verified: `scripts/ci/rls-audit.ts` sets `REQUIRED_RLS_TABLES = TENANT_TABLES`).
2. *A false doc claim.* Three artifacts enumerate this suite's vacuity limits and all three omit this one, while one positively asserts the opposite: the test comment at line 238; deviations D5 (`docs/superpowers/plans/fix-1171-job-outbox-rls-deviations.md:115`), which scopes the admitted vacuity to `anon`/`authenticated`; and the migrations-log "Known limit of the local guard" paragraph (`.claude/reference/migrations-log.md:2726`). A reader is told coverage exists that measurement shows does not.

**Behavioural replacement.** Assert the ACL rather than the effective privilege — `pg_class.relacl` / `aclexplode(relacl)` / `information_schema.role_table_grants` (the seam the intake's own `test_seams[2]` named), which is superuser-blind; or provision a non-superuser owner for the test container. C4 shows the `anon`/`authenticated` arms remain genuinely live in the GRANT direction, so the case is worth keeping once its owner half is made real.

---

## Duty 2 — fragile assertions

### RT-2 — the one-REVOKE guard is a line-anchored regex, and a wider revoke can evade it (P1)

`src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:117-119`

```
const revokes = text.match(/^\s*REVOKE\b.*$/gim) ?? [];
expect(revokes).toHaveLength(1);
expect(revokes[0]).not.toMatch(/\b(postgres|service_role|PUBLIC)\b/);
```

The comment above it declares this the guard for the migration's stated worst case ("the dangerous mutation here is a WIDER revoke, not a missing one", echoed in the migrations-log "Why the REVOKE, and why exactly two roles" paragraph). The regex counts LINES THAT BEGIN with `REVOKE` — incidental structure, not statement structure.

**Mutation F7 (observed):** appending `SELECT 1; REVOKE ALL ON job_outbox FROM service_role;` leaves `revokes.length` at 1 and `revokes[0]` free of the forbidden role names. `T2` passed. `T6` (the catalogue case) also passed, because D2 removed the `service_role` arms — so this mutant survives BOTH guards the branch names.

Bounded honestly: the platform impact of that specific mutant is limited — production application traffic reaches Postgres as `postgres`, the table owner (`pg_stat_activity`: `postgres`/`Supavisor`), not as `service_role` — and the mutant's formatting is not how an author would write it. Hence P1, not a second P0. The defect is the assertion, not a live break.

**Behavioural replacement.** Split on `;` and inspect statements, or assert the resulting ACL for `service_role` in the two real environments as part of the post-apply introspection the intake already promises, instead of anchoring on line starts.

### RT-5 — the file-text guard pins the REVOKE but forbids no GRANT (P2)

Same block, lines 110-120 and 124-133. Mutation F6 kept the REVOKE verbatim and appended `GRANT SELECT, INSERT ON job_outbox TO authenticated;`. Both file-text cases (`T2`, `T3`) passed. The realistic future regression on this table is a re-grant, not a deleted REVOKE, and the DB-free half of the suite — the half the branch leans on because it "can never silently skip" — does not see it.

Not a P0: mutation C4 proves the catalogue case DOES catch a client-role grant (`GRANT SELECT ON job_outbox TO anon` → `T6` failed), so the suite as a whole kills this class wherever a database is reachable. Recorded so the split of responsibility between the two halves is not overstated.

### Scanned and clean

No absence-of-tag proxy, no exact string count on rendered output, no order assertion over an uncontracted ordering. The two `not.toMatch` assertions at lines 130 and 133 (`CREATE POLICY`, `FORCE ROW LEVEL SECURITY`) are absence assertions, but both were measured live — F3 and F4 killed `T3` — and they guard SQL keywords with no synonym in this file, so they are not proxies in the failing sense.

---

## Duty 3 — docs vs reality, re-resolved at HEAD

`~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py` was not used: the diff's added lines contain **no `path:line` citations at all** (verified by extracting every `<file>.<ext>:<n>` token from the added lines of `git diff 602e9893..3a7d0ca9`; the set is empty). Every claim below was hand-resolved, and this report says so as the skill requires.

| Claim | Where | Verdict |
|---|---|---|
| `job_outbox` was the ONLY table of the **54** in schema `public` whose RLS state differed | migration:11-12, migrations-log, arch-review-log | **TRUE.** Both projects expose exactly 54 `relkind='r'` relations in `public`, identical name sets. Prod: `relrowsecurity=true` on all 54. Staging: `true` on 53, `false` on `job_outbox` alone. |
| prod `relrowsecurity=true, 0 policies`; staging `false, 0 policies` | migration:14-15 | **TRUE.** Introspected 2026-09-07. |
| on BOTH projects `anon` and `authenticated` still hold the Supabase default table privileges | migration:17-18 | **TRUE.** Both hold SELECT and INSERT on `job_outbox` in both projects — so the REVOKE is a real production change, as `edge_cases[1]` says. |
| **78 production files** bind `job_outbox` | migration:63, migrations-log, arch-review-log | **TRUE.** `rg -l job_outbox src worker` excluding `__tests__/`, `*.test.ts`, `*.spec.ts` → exactly 78 (206 including tests). |
| **zero** matches for `from('job_outbox')` in `src` and `worker` | migration:45-46, migrations-log, `invariants[5]` | **TRUE.** No matches. |
| `service_role` carries BYPASSRLS | migration:39 | **TRUE.** Prod `pg_roles`: `service_role rolbypassrls=true`; `postgres` (owner) also `rolbypassrls=true`, `rolsuper=false`. |
| every access is Postgres.js **as the table OWNER** | migration:37-38 | **TRUE, independently corroborated.** Production `pg_stat_activity` shows application connections arriving as `postgres`/`Supavisor`; `postgres` owns `job_outbox`. The only other app role connected is `authenticator`/`postgrest`, not an outbox path. |
| `ci:rls-audit` audits only `TENANT_TABLES`, so this suite is the boundary's guard | migration:65-68 | **TRUE.** `scripts/ci/rls-audit.ts`: `export const REQUIRED_RLS_TABLES = TENANT_TABLES;`. `job_outbox` absent from `TENANT_TABLES`, present in `REVIEWED_NOT_TENANT_SCOPED` (`scripts/ci/tenant-tables.ts:226`). |
| precedent 107 deliberately deferred the `job_outbox` repair | migration:29-32 | **TRUE.** `107_drop_legacy_ensure_rls_event_trigger.sql:22,26`. |
| precedents 117 / 118 for `ENABLE RLS` + `REVOKE ALL … FROM anon, authenticated` | migration:52-58 | **TRUE.** `117_admin_audit_log.sql:65,68`; `118_poller_heartbeats.sql:78,81`. |
| precedents 092 / 101 for session-scoped `SET lock_timeout` (vs 088/109/114's `SET LOCAL`) | migration:78-82, D3 | **TRUE.** `092:75`, `101:30` session-scoped; `088:16`, `109:25`, `114:33` use `SET LOCAL`. |
| migrations-log head bumped to 119 / next is 120 | `.claude/reference/migrations-log.md:4` | **TRUE.** |
| `assertSchemaReady` cannot gate this migration (D4) | suite header, D4 | **TRUE by construction** — 119 creates no relation/column/index/constraint. |

### RT-3 — "production has run this exact posture for five months" is false as written (P1)

`supabase/migrations/119_job_outbox_rls.sql:39-40`:

> *"The strongest evidence is empirical: production has run this exact posture for five months."*

Production has run the **RLS half** since 2026-04-05. It has **never** run the REVOKE half: `anon` and `authenticated` still hold SELECT and INSERT on production `job_outbox` today (introspected 2026-09-07); the migration says so itself 40 lines later, and `edge_cases[1]` says so again. "This exact posture" is the paragraph's designated *strongest* safety evidence, and it does not cover the one statement in the migration that could plausibly break the worker.

The conclusion the sentence supports is nonetheless correct — production application traffic connects as the owner `postgres`, verified independently — so this is P1, not P0. The sibling formulations are precise and need no change: arch-review-log and migrations-log both say "the posture prod has run without incident", scoped to RLS.

---

## Duty 4 — missed sibling cases

**Patterns searched.** Over BOTH Supabase projects, read-only `SELECT` over `pg_class` × `pg_namespace` × `pg_policies` × `has_table_privilege`, `nspname='public'`, `relkind='r'`, all 54 relations, no exclusions:

1. *RLS-state drift between the projects* — `relrowsecurity` or `relforcerowsecurity` differing for the same table name. **Result: exactly one, `job_outbox`, which this branch closes.** No other table differs on either flag; name sets identical; `pg_policies` counts match table-for-table. Zero siblings — a sound search that found nothing, recorded as one.
2. *Deny-all intent without the REVOKE* — RLS enabled, **zero** policies, `anon`/`authenticated` still holding table privileges. **Result: 19 siblings**, identical in both projects: `agent_outcomes`, `agent_run_steps`, `agent_runs`, `analytics_events`, `auto_approval_policies`, `flagged_responses`, `google_connections`, `impersonation_sessions`, `inbound_events`, `judge_verdicts`, `owner_leads`, `poller_cursors`, `prospect_demos`, `refusal_events`, `review_escalations`, `solicitation_consent`, `solicitation_send_breaker`, `solicitation_suppression_corrections`, `solicitation_suppressions`, `solicitation_unsubscribe_tokens`. Only four tables carry the full posture 119 gives `job_outbox`: `account_offboarding_tokens`, `account_offboardings`, `admin_audit_log` (117), `poller_heartbeats` (118).

### RT-6 — nineteen tables share the "deny-all but never revoked" shape (P2)

Recorded, not charged against the branch: `non_goals[3]` says verbatim *"Do not REVOKE anon/authenticated on any other deny-all table. That is a separate reviewed change."* The scope call is explicit and pre-registered. Two facts belong on the record anyway:

- The residual exposure is bounded — with RLS on and zero policies a client key gets an empty result set and a refused INSERT, materially different from the `job_outbox` staging case (RLS **off**). The "last drift" framing is accurate for RLS state and must not be read as "the last deny-all gap".
- Three of the nineteen matter for the follow-up ticket: `auto_approval_policies` (CLAUDE.md invariant #14, server-owned) and `agent_runs`/`agent_run_steps`/`agent_outcomes` (the run spine).

---

## Duty 5 — operational completeness

**In-diff failure paths: none.** The diff adds no TypeScript, no worker code, no new terminal or swallowed failure path, and therefore requires no new rule row in `docs/runbooks/beta-launch-alerting.md`. The six-facet comparison has no new signal to compare. A sound negative, recorded as one.

| Signal (`observability[i]`) | Does it distinguish success from silent failure? |
|---|---|
| 0 — OutboxPoller dispatch continues on the staging worker after apply | Yes. A break would be immediate and total (permission denied on the claim query), not silent. |
| 1 — post-apply introspection of `pg_class` / `pg_policies` / `role_table_grants` on both projects, in the PR body | Yes, and given RT-1 it is the ONLY thing that can prove the REVOKE half. Manual, with no automated backstop. |
| 2 — PostgREST probe with the staging anon key returns a permission error | Yes; the only end-to-end proof of the fix's stated purpose. |
| 3 — `worker/background/pollers/health-alert/checks.ts` backlog alerting stays quiet | Yes. `outbox_pending_age` (default `HEALTH_ALERT_PENDING_AGE_S` 900s), `outbox_stale_dispatching` and `backlog_depth:job_outbox` all exist at HEAD and read `job_outbox` directly. A dispatch stall surfaces within one threshold window. |

### RT-4 — the rollback plan over-reverts production (P1)

`docs/superpowers/plans/fix-1171-job-outbox-rls-intake.json:73` (and the byte-identical `.feature/intake.json:73`):

> *"write migration 120 with `ALTER TABLE job_outbox DISABLE ROW LEVEL SECURITY` and `GRANT SELECT, INSERT, UPDATE, DELETE ON job_outbox TO anon, authenticated`, and apply it staging first."*

Applied as written to **production**, that is not an inverse of 119 — it is strictly looser than production's pre-119 state. Production has had `relrowsecurity = true` since 2026-04-05 (the branch's own central fact). The rollback would turn it OFF and re-grant `anon` INSERT, manufacturing on production the exact staging vulnerability this branch exists to close, in the middle of an incident. Two secondary defects in the same sentence: the four named privileges do not restore the Supabase default grant set (which also carries `REFERENCES`, `TRIGGER`, `TRUNCATE`), and applying "staging first" is the wrong order for an incident whose trigger is *production* dispatch stopping.

The stated trigger — "only warranted if worker dispatch stops, which would mean the owner-role assumption is wrong" — makes the correct rollback obvious and narrow: re-`GRANT` only, and only in the environment that broke. The `DISABLE ROW LEVEL SECURITY` half addresses nothing, because RLS never applied to the owner in the first place.

**Apply-time failure modes the branch does detect:** `SET lock_timeout = '5s'` is session-scoped (D3) so it survives the psql path, and a lock-acquisition failure surfaces as a statement error in whichever apply tool is used — loud, not silent.

**Apply-time failure mode nothing in the branch detects: a half-applied lockstep.** If 119 lands on staging and the production apply is skipped or fails, no automated check notices: `ci:rls-audit` covers only `TENANT_TABLES` (so not `job_outbox`), and the new suite reads only the local container. The branch's answer is `observability[1]`, a manual introspection recorded in the PR body. Acceptable for a one-off — and it is exactly how the current drift survived from 2026-05-30 to 2026-09-07 undetected. Folded into RT-4 rather than raised separately, because the same "the runbook step is the only detector" weakness produces both.

---

## Inventory

| id | test | outcome | note |
|---|---|---|---|
| INV-1 | job_outbox stays REVIEWED_NOT_TENANT_SCOPED and NOT a TENANT_TABLES member | killed | F8 |
| INV-2 | migration 119 revokes every anon and authenticated privilege on job_outbox | killed | F1, F2 killed; F6a, F7a survived → RT-2, RT-5 |
| INV-3 | migration 119 grants no policy and does not force row level security | killed | F3, F4, F5 killed; F6b survived → RT-5 |
| INV-4 | migration 119 enables row level security on job_outbox and defines zero policies | killed | C1, C2 |
| INV-5 | migration 119 leaves FORCE row level security off so the owner-role worker keeps dispatching | killed | C3 |
| INV-6 | migration 119 leaves the job_outbox owner's privileges intact and denies the client roles | **survived-confirmed-P0** | C5 survived (RT-1); C4 killed the client-role half; F7b survived |

Direction B (production surface): the only behaviour-affecting production hunk is `supabase/migrations/119_job_outbox_rls.sql`. Its three effective statements are each covered by at least one row above (`ENABLE RLS` → INV-3 + INV-4; `REVOKE` → INV-2 + INV-6; `COMMENT ON TABLE` → inert metadata, no covering test owed). No production hunk is uncovered; no test was deleted; the four `tests_to_add` titles exist verbatim in the file.

## Findings

| id | severity | at | duty | disposition | title |
|---|---|---|---|---|---|
| RT-1 | **P0** | `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:238` | 1 | open | Owner-privilege arms cannot fail: the container owner is a superuser, so `has_table_privilege` is a constant — and three artifacts claim the opposite |
| RT-2 | P1 | `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:117` | 2 | open | The one-REVOKE guard anchors on line starts; a wider revoke evades it and also evades the catalogue case |
| RT-3 | P1 | `supabase/migrations/119_job_outbox_rls.sql:39` | 3 | open | "production has run this exact posture for five months" — production has never run the REVOKE half |
| RT-4 | P1 | `docs/superpowers/plans/fix-1171-job-outbox-rls-intake.json:73` | 5 | open | The rollback plan disables RLS on production, leaving it looser than pre-119; and nothing detects a half-applied lockstep |
| RT-5 | P2 | `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:110` | 2 | open | The DB-free guard pins the REVOKE but forbids no subsequent GRANT (caught only by the catalogue case) |
| RT-6 | P2 | `supabase/migrations/119_job_outbox_rls.sql:60` | 4 | open | 19 sibling tables carry RLS-on / zero-policies / client grants intact; an explicit non-goal, recorded for the follow-up |

## Authorizations

None. No finding on this run is `accepted-risk`.

## Not findings — verified and clean

- The safety core of the change is sound. `job_outbox` is reached only as the table owner (production `pg_stat_activity`), FORCE stays off and is asserted in both catalogue and text (C3, F4 both killed), zero policies is asserted and live (C1, C2 both killed), and no `supabase-js` path touches the table.
- `describeWithDb` is correctly scoped: the three file-text cases sit OUTSIDE it, so the `lint` job (no database) still executes them rather than skipping the whole file.
- The intake's `tests_to_add` retitle (D2) is honest and the four titles resolve verbatim at HEAD.
- The new migrations-log entry sits directly against the 118 entry with no separating blank line; entries 117, 115 and 111 do the same, so this is house style, not a defect.
