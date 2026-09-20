# Spec & correctness review — `fix/1301-migration-guard-execution`

Axis: SPEC AND CORRECTNESS. Read-only.
Fork `07738319cd5d7a78661ed1e3af07430bd84a8521` → head `a4becdc44e56030d10384fe7faec17493623b9ab` (frozen; no rebase, no merge).
Container: `repworth-testdb-pg17`, PostgreSQL 17.11, port 5500, db `test_1301`. Read-only use only; `pnpm test:db:setup` never run.

---

## 1. Findings

| # | Sev | Location | Finding |
|---|---|---|---|
| F-A | MEDIUM | `docs/reviews/fix-1301-migration-guard-execution/weakened-checks-reasons.md:132-135` | "What no longer has a guard anywhere: Nothing" is false — four assertions from the deleted 048 text guard have no successor and are in none of the three named retired classes |
| F-B | MEDIUM | `src/lib/shared/__tests__/migration-118-poller-heartbeats.integration.test.ts:607-609` | The 118 suite is nondeterministic: 2 of its 8 cases failed once in 21 runs of the shared integration set; the column-comment assertion failed while the default assertion two lines above passed |
| F-C | MEDIUM | `.claude/reference/arch-review-log.md:3` | "201 tests pass together sharing one advisory lock" does not match any measurement at head (48 / 50 / 236) |
| F-D | LOW-MED | 7 suites, 19 citations (e.g. `migration-048-…integration.test.ts:25`) | Every oracle-A literal cites `.feature/oracle-a-literals.txt` as its provenance; `.feature/` is gitignored, so the cited source never lands in the repo |
| F-E | LOW | `src/lib/shared/__tests__/helpers/schema-ready.ts` (new exports) | `MIGRATION_117_ADMIN_AUDIT_LOG` becomes a third, non-identical definition of a fact already defined twice locally; `MIGRATION_051_FLAGGED_RESPONSES` has zero consumers and `MIGRATION_048_IMPERSONATION_SESSIONS` is not used by the 048 suite |
| F-F | LOW | `049:196`, `053:439`, `057:344`, `117:595` | Plan §7's "Every executing case therefore carries a property-specific `assertDegradeLanded`" is untrue for 4 of the 7 noninterference cases |
| F-G | LOW | `scripts/ci/live-db-suites-audit.ts:169,176`; plan §6 | Three checked-in descriptions are wrong: "057 degrades the four columns" (five), 118's degrade described as "deny-all RLS off" (it never disables RLS), and "58 promised titles" (intake has 60, §5 enumerates 59) |
| F-H | LOW | `migration-118-poller-heartbeats.integration.test.ts:101-110` | 118's "Stated limits … None. … every object 118 declares is produced by the executing cases and asserted against either the before-read or a pinned literal" overclaims: the `CREATE TABLE` body is proven in 118 only by the `after == before` comparison the same header calls circular |

### F-A — MEDIUM · a protection loss the weakened-checks record denies

**Contract field violated:** `weakened-checks-reasons.md` § "What no longer has a guard anywhere" ("Nothing. Every assertion in the five deleted files either has a named successor case or appears in the three retired classes above with a written reason."); and intake `user_visible_behavior[0]`.

**Evidence.** The deleted `src/lib/shared/__tests__/migration-048-impersonation-sessions.test.ts` (merge-base) asserted, in `creates impersonation_sessions with UUID fallback and audit fields`:

```
expect(sql).toMatch(/id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
expect(sql).toMatch(/ticket_id TEXT NOT NULL/i);
expect(sql).toMatch(/reason TEXT NOT NULL/i);
expect(sql).toMatch(/expires_at TIMESTAMPTZ NOT NULL/i);
```

The replacement suite pins, as literals: the four `pg_get_indexdef` strings (`:98-109`), three `pg_get_constraintdef` FK strings (`:112-118`), `id`'s `gen_random_uuid()` default (`:120`), and `rowSecurity`/`forceRowSecurity`/`policies` (`:218-226`). It pins **no column inventory**. Its own header (`:34-45`) states that oracle B cannot reach the `CREATE TABLE` body because `CREATE TABLE IF NOT EXISTS` is skipped at head — so `expect(after.tables[TABLE]).toEqual(before.tables[TABLE])` is circular for exactly these four facts on a container provisioned from a weakened file.

No other guard covers them:
- `schema-ready.ts:189-197` (`MIGRATION_048_IMPERSONATION_SESSIONS`) lists tables + the four non-pkey indexes; a `columns` entry would be a presence check anyway.
- `migration-057-…integration.test.ts:136-149` pins `impersonation_sessions.{account_id, impersonated_user_id}` nullable and `actor_user_id` NOT NULL — not `ticket_id`, `reason` or `expires_at`.
- `src/lib/admin/impersonation/__tests__/session.test.ts` is fully mocked (`createMockSql`), so it asserts nothing about the catalogue.
- `migration-122-client-role-grant-sweep.integration.test.ts` asserts grants, not nullability.
- Repo-wide: no test asserts `impersonation_sessions.ticket_id`, and `impersonation_sessions_pkey` appears in no pinned literal.

**Failure scenario.** Someone edits `supabase/migrations/048_impersonation_sessions.sql` to drop `NOT NULL` from `expires_at` — the column that makes an impersonation session time-boxed. CI runs `pnpm test:db:setup`, which builds the container from the weakened file. All 50 #1301 cases pass: oracle B compares the weakened BEFORE to the weakened AFTER, and no oracle-A literal names the column. Before this branch, the deleted regex failed.

**Scope note.** The practical risk is bounded by the fact that editing an applied historical migration is itself a violation, which is why this is MEDIUM and not HIGH. The finding is that the written record says nothing was lost; something was.

### F-B — MEDIUM · a nondeterministic guard case

**Contract field violated:** intake `invariants[3]` ("No executing case can pass vacuously") in spirit and `observability[0]` ("A CI run on the PR is itself the evidence"); a guard that fails on a clean tree is not evidence.

**Evidence.** Run 3 of `pnpm vitest run --project integration src/lib/shared/__tests__/` (42 files) reported:

```
 Test Files  1 failed | 35 passed | 6 skipped (42)
      Tests  2 failed | 294 passed | 56 skipped (352)
```

both failures inside `migration-118-poller-heartbeats.integration.test.ts`. The surviving `[2/2]` trace:

```
    609|         ).toBe(LAST_CYCLE_AT_COMMENT);
       |           ^
 ❯ src/lib/shared/__tests__/helpers/migration-guard.ts:600:7
 ❯ withRolledBackTransaction src/lib/shared/__tests__/helpers/migration-guard.ts:599:5
 ❯ src/lib/shared/__tests__/migration-118-poller-heartbeats.integration.test.ts:587:7
```

Lines 604-609 are, in order, the `columnDefaults` assertion for `last_cycle_at` and then the `columnComments` one. The **default** assertion passed and the **column comment** assertion failed, so `after.tables['poller_heartbeats']` existed and the re-applied table carried the right `now()` default while its column comment did not match the pinned literal. That is a property of the degrade/re-apply/read cycle, not a missing table.

**Non-reproduction, stated plainly.** 20 further runs of the same 42-file command all returned `296 passed | 56 skipped`, and 25 consecutive runs of the 118 file alone returned exit 0. Observed rate ≈ 1 in 46 executions of the suite. I could not identify the mechanism; candidates I could not confirm are OID reuse across the in-transaction `DROP TABLE` / `CREATE TABLE` and a `pg_description` visibility effect in `col_description(att.attrelid, att.attnum)` (`migration-guard.ts:302-304`).

**Failure scenario.** The `test` job is a required check. A ~2% red rate on a clean tree on the one suite whose subject is "Judge availability is a posting precondition" invites the standard response to a flaky guard, which is to weaken or skip it — the exact outcome #1301 exists to prevent.

### F-C — MEDIUM · an unverifiable measurement in a checked-in governance record

**Contract field violated:** CLAUDE.md § Gate evidence ("Green CI is not proof that documentation is true. Re-check cited line numbers and doc claims against current HEAD").

**Evidence.** `.claude/reference/arch-review-log.md:3` states: "Production diff 50 lines across four files; **201 tests pass together sharing one advisory lock**; the container is byte-identical afterwards". Measured at `a4becdc44`:

| Set | Tests |
|---|---|
| the seven #1301 suites | 48 |
| the seven suites + `helpers/migration-guard.integration.test.ts` | **50** (exit 0) |
| all eleven touched test files (adds `migration-guard.test.ts`, `ci-audit-wiring.test.ts`, `live-db-suites-audit.test.ts`) | **236** (exit 0) |
| the whole `integration` project | 1453 (1025 passed / 425 skipped / 3 pre-existing failures — see appendix) |

No reading equals 201. The two docs-only commits after the code commit (`5dbda4d56`, `a4becdc44`) change no test, so the count cannot have drifted after measurement.

**Failure scenario.** A future session reads 201 as the baseline, counts 50 or 236, and concludes either that cases were lost or that the branch is larger than it is — the D13 failure mode ("two agents reported opposite facts about the same four lines") recurring through the record itself.

### F-D — LOW-MEDIUM · the oracle-A provenance never lands

**Contract field violated:** deviation D7 ("pinned catalogue literals are coupled to PostgreSQL's deparse output") and each suite's own header.

**Evidence.** 19 references to `.feature/oracle-a-literals.txt` across all seven suites (e.g. `migration-048-…:25`, `migration-051-…:190` region, `migration-118-…:163`, `migration-053-…:157`). `git check-ignore -v .feature/oracle-a-literals.txt` → `.gitignore:32:.env*` matches `.feature/` via the directory entry; `git ls-files .feature` is empty; the file is untracked.

**Failure scenario.** PostgreSQL changes a deparse rendering (D7's stated hazard) or a migration is legitimately amended. A reviewer opens the suite, reads "taken from `.feature/oracle-a-literals.txt` (machine-generated exact catalogue renderings, captured on a known-good container)", finds no such file in the repo, and has no recorded way to regenerate a literal or to tell a stale pin from a regression. The literals become unmaintainable strings of unknown origin.

### F-E — LOW · a new shared fact that does not displace its duplicates

**Contract field violated:** CLAUDE.md § Lab notes ("one authoritative owner per fact"), which the 117 suite's own comment cites as the reason for the new export (`migration-117-…:284-286`: "The shared requirement from `schema-ready.ts` rather than a local copy of it: one authoritative owner per fact").

**Evidence.** After this branch there are **three** definitions of `MIGRATION_117_ADMIN_AUDIT_LOG`:
- `scripts/ci/__tests__/mint-admin.integration.test.ts:58` — local, `{tables, columns:[actor_user_id,event_type], indexes:[idx_admin_audit_actor_created]}`
- `scripts/ci/__tests__/revoke-admin.integration.test.ts:48` — local, byte-identical to the above
- `src/lib/shared/__tests__/helpers/schema-ready.ts` (new) — `{tables, indexes:[both], constraints:[actor FK]}`, **not** equivalent to either local copy

Neither `scripts/ci/__tests__/*` file is on the intake's `allowed_edit_surface`, so the branch could not consolidate them; nothing records the drift (the deviations doc mentions both files only under D4, about staleness of an unrelated comment). Additionally `MIGRATION_051_FLAGGED_RESPONSES` has **zero** consumers repo-wide, and `MIGRATION_048_IMPERSONATION_SESSIONS` is consumed only by the **053** suite — so plan T2's stated reason for adding them ("a container missing them fails with the actionable `pnpm test:db:setup` message") is delivered for neither 048 nor 051.

**Failure scenario.** Migration 117 gains an index. Someone updates the shared requirement; `mint-admin` and `revoke-admin` keep asserting the old one and keep passing on a behind-head container, which is the failure the requirement exists to catch.

### F-F — LOW · a blanket vacuity claim that four cases do not meet

**Contract field violated:** plan §7 ("Every executing case therefore carries a property-specific `assertDegradeLanded`").

**Evidence.** `re-applying … moves no other table in public` calls `assertDegradeLanded` in 048 (via `withDegradedAndReapplied`, `:157-167`), 051 (via `degradeAndApply`, `:296-310`) and 118 (`:496`). It does **not** in 049 (`:196-209`), 053 (`:439-452`), 057 (`:344-353`) or 117 (`:595-610`) — each degrades, applies, and calls `assertOnlyTablesMoved` with no proof the degrade landed.

**Failure scenario.** Narrow, which is why this is LOW: the off-target check does not depend on the degrade landing (the re-apply runs either way). The finding is that the plan's stated invariant is not uniformly implemented, so a reader cannot rely on it when judging a future case.

### F-G — LOW · three wrong descriptions in checked-in files

- `scripts/ci/live-db-suites-audit.ts:169` — "057 degrades **the four columns** the OTHER way" and then lists five (`account_offboardings.zernio_*` ×2, `approval_audit_log.response_id`, `impersonation_sessions.account_id`, `impersonation_sessions.impersonated_user_id`). The suite degrades five (`migration-057-…:152-163`) and the plan T7 says five.
- `scripts/ci/live-db-suites-audit.ts:176-178` — "118 degrades poller_heartbeats: **deny-all RLS off** and the client-role privileges the migration revokes granted back". The actual degrade (`migration-118-…:224-230`) is `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated` followed by `DROP TABLE poller_heartbeats` — it issues no `DISABLE ROW LEVEL SECURITY` and grants nothing directly. The comment describes the 117 degrade, not this one.
- Plan §6 — "58 promised titles. T1 two, T2 sixteen, T3 four, T4 five, T5 five, T6 nine, T7 four, T8 fourteen." The intake carries 60; those per-tracer figures sum to 59; and §5's verbatim bullet lists omit `assertDegradeLanded cannot be called with an empty object list`, which **is** implemented (`migration-guard.test.ts:208`). No coverage gap — a stale count and a stale enumeration.

### F-H — LOW · 118's "no stated limit" overclaims

`migration-118-…:101-110` says: "**Stated limits** … None. The whole table is dropped and re-created, so every object 118 declares — the table, both columns with their types and nullability, the natural-key primary index and constraint, the table comment, the column comment, the `last_cycle_at` default, RLS enabled with zero policies, and the client-role REVOKE — is produced by the executing cases and asserted against either the before-read or a pinned literal."

For the `CREATE TABLE` body the only assertion inside 118 is `expect(after.tables[TABLE]).toEqual(before.tables[TABLE])` (`:487`) — the before-read, which the same header (`:36-44`) calls circular on a container provisioned from the file under test. 118 pins independent literals for the table comment, the column comment and the default only (`:434-460`, `:601-615`). Independent literals for `poller_heartbeats_pkey`, `poller_name text NOT NULL` and `last_cycle_at timestamp with time zone NOT NULL` exist — but in a **different** file, `helpers/migration-guard.integration.test.ts:200-205, 243-247, 258-261`. The coverage is real; the claim that 118's executing cases provide it is not, and "Stated limits: None" is therefore the wrong entry.

---

## 2. The six questions

### Q1 — did any suite's oracle A drift back to reading the migration file? **No.**

All 19 occurrences of `readMigrationSql` in the seven suites are of the form `await tx.unsafe(readMigrationSql(MIGRATION_FILE));` — verified by enumerating every call site (048:169; 049:189,200; 051:312,391; 053:394,428,443,486,500,551,595; 057:333,349; 117:584,599,640; 118:477,504,564,593). `readFileSync` appears in each suite exactly once, reading **the suite's own source text** for the registry case (`auditLiveDbFile(SUITE_PATH, ownSourceText)`), never a migration. No expectation anywhere is derived from migration text or from the BEFORE reading alone; every oracle-A value is a string, boolean or array literal declared in the test file:

| Suite | Oracle-A literals (all in-file) |
|---|---|
| 048 | 4 × `pg_get_indexdef`, 3 × FK `pg_get_constraintdef`, `gen_random_uuid()`, RLS/FORCE/policies |
| 049 | `rls_enabled=true`, `policy_count='0'` |
| 051 | 14-column inventory, 6 FK defs, 3 CHECK defs, 2 index defs, RLS/FORCE/policies |
| 053 | `USERS_ROLE_CHECK_DEF`, `ACTIVE_ACTOR_INDEX_DEF`, `legacy_rows='0'`, policy name list |
| 057 | `HEAD_NULLABILITY` — 5 loosened + 5 deliberately untouched columns |
| 117 | 10-column inventory w/ types+defaults, index substrings, FK `confdeltype='a'`, 3-arm empty-ACL |
| 118 | table comment, column comment, `now()`, RLS/FORCE/policies, 3-arm empty-ACL |

Where the circularity mattered most, the pins are asserted **after** the re-apply against a literal (048:239-244, 053:400, 118:601-615), so a weakened file fails the comparison even on a container built from it.

### Q2 — is every `assertDegradeLanded` call per-object? **Yes, at all 21 call sites.**

| Suite:line | Target | Selector | Objects covered vs objects the degrade removes |
|---|---|---|---|
| 048:157 | `indexes` | `absent: nonEmptyNames(GUARDED_INDEXES)` | 4 / 4 (`GUARDED_INDEXES = Object.keys(GUARDED_INDEX_DEFINITIONS)`, 4 entries; degrade drops exactly those 4) |
| 048:167 | `rowSecurity` | boolean variant | n/a |
| 049:184 | `rowSecurity` | boolean variant | n/a |
| 051:296 | `indexes` | `absent` ×2 | 2 / 2 |
| 051:304 | `rowSecurity` | boolean variant | n/a |
| 053:388, 469, 521 | `constraints` | `absent: [users_role_check]` | 1 / 1 |
| 053:477 | `accounts.constraints` | `present: [users_role_check]` | decoy landing proven |
| 057:317 | `account_offboardings.notNullColumns` | `present` ×2 | 2 / 2 |
| 057:322 | `approval_audit_log.notNullColumns` | `present` ×1 | 1 / 1 |
| 057:327 | `impersonation_sessions.notNullColumns` | `present` ×2 | 2 / 2 — five columns total, matching the degrade |
| 117:566 | `grants` | `present: nonEmptyNames(clientGrantNames(privileges))` | 16 / 16 on PG17 (8 derived privileges × 2 roles), derived from `acldefault('r', relowner)` with a `>= 7` floor assertion |
| 117:571 | `indexes` | `absent: [ACTOR_INDEX, EVENT_INDEX]` | 2 / 2 |
| 117:579 | `rowSecurity` | boolean variant | n/a |
| 118:475, 496, 562, 591 | `presence` | table-removal form | the degrade is total |

No call site passes an empty list, and it could not: `DegradeTarget`'s list variants take `NamedObjects = readonly [string, ...string[]]`, so `absent: []` is a compile error (`migration-guard.ts:92-99, 141-150`), the two computed lists go through the checked narrowing `nonEmptyNames`, and a runtime guard at `:470-476` throws for a caller that casts past the type. The boolean variant (`rowSecurity` / `forceRowSecurity`) is its own `DegradeTarget` member with no selector, so the four suites that need it no longer write `absent: []` as a placeholder.

### Q3 — did any degrade leak state past its rollback? **No — verified independently, outside any transaction.**

After the full 8-file run I queried the container directly with `psql` (a separate process, no transaction):

```
default_acl_rows=0
decoy_schema=0
poller_relacl={test=arwdDxtm/test}
users_rows=0
flagged_rows=0
probe_table=0
impersonation_idx=5
analytics_rls=true
users_role_check=1
version=PostgreSQL 17.11
```

- `SELECT count(*) FROM pg_default_acl` = **0** — 118's `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated` rolled back completely. Nothing created afterwards anywhere in the repo can inherit client grants.
- `poller_heartbeats.relacl` holds the owner only — the `DROP TABLE` / re-create / `REVOKE` cycle left no client privilege behind.
- `decoy_1301` absent — 053's `CREATE SCHEMA` inside the transaction rolled back.
- `poller_heartbeats_default_acl_probe` absent, `users` and `flagged_responses` empty — no fixture row or probe table survived (051 seeds 6 rows, 053 seeds 4).
- `impersonation_sessions` still carries 5 indexes (4 guarded + pkey); `analytics_events.relrowsecurity` still true; `users_role_check` still present exactly once.

The suite also asserts the same thing on every run: 118 reads `pg_default_acl` through `sql()` **before** entering the wrapper and re-reads it **after** the wrapper returns (`:526, 584`), so the hazard is checked per-run rather than trusted to one measurement. That mechanism is correct and I confirmed the outcome without relying on it.

### Q4 — do the seven suites pass as a set, serially, sharing one advisory lock? **Yes.**

```
pnpm vitest run --project integration <7 suites> helpers/migration-guard.integration.test.ts
 Test Files  8 passed (8)
      Tests  50 passed (50)
EXIT=0
```

Ran as one `vitest` invocation in the `integration` project, which sets `fileParallelism: false` and `sequence.groupOrder: 1` (`vitest.config.ts`), so the eight files execute one after another in one worker. Each suite takes the cross-process lock in `beforeAll` via `acquireLiveDbLock(databaseUrl)` and releases it in `afterAll`; all eight name the same helper, so they serialize against each other and against every other live-DB writer. `--reporter=verbose` confirms every DB-gated case ran (no `↓`/skip lines) — the registry case in each suite is outside `describeWithDb` and cannot silently skip.

Wider: 21 runs of the whole 42-file `src/lib/shared/__tests__/` integration set — 20 green at `296 passed | 56 skipped`, 1 red (F-B). 25 runs of the 118 suite alone — all green.

### Q5 — verifying `weakened-checks-reasons.md`, row by row

`pnpm ci:weakened-checks` run at head: **passed, 10 row(s) for the reviewer.** REVIEW rows never fail, so a green audit is not acceptance. My verdict for each:

| # | Row | Verdict | Where the protection now lives |
|---|---|---|---|
| 1 | `test-file-deleted` `migration-048-impersonation-sessions.test.ts` | **PARTIAL LOSS — see F-A** | Indexes → 048:98-109 + 239-244 (literals); FKs → 048:112-118 + 274-279; `id` default → 048:120 + 269-272; RLS/no-policy → 048:218-226. **Not carried:** `id … PRIMARY KEY`, `ticket_id TEXT NOT NULL`, `reason TEXT NOT NULL`, `expires_at TIMESTAMPTZ NOT NULL` |
| 2 | `test-file-deleted` `migration-049-analytics-events-rls.test.ts` | no loss | Both old assertions (`ENABLE ROW LEVEL SECURITY`, `not.toMatch(/CREATE POLICY/)`) → `analytics_events carries row security enabled at head` (049:139-166): `rls_enabled === true`, `policy_count === '0'` |
| 3 | `test-file-deleted` `migration-051-structure.test.ts` | no loss | 13 `it.each` columns → the 14-entry literal inventory (051:189-214, all 13 present); 5 FK regexes + `ON DELETE SET NULL` → 6 literal `pg_get_constraintdef` strings (051:222-241); `status`/`severity` CHECK → 3 literal CHECK defs (051:245-256); RLS + no policy → 051:178-186; index regex → 2 literal `pg_get_indexdef` strings (051:260-269); `not.toMatch(/DROP TABLE|UPDATE|DELETE/)` → `re-applying 051 preserves every existing flagged_responses row unchanged` (051:341-411), which seeds a real row through its 4-table parent chain and compares the whole record, and would also fail on a `DROP TABLE` because `after.tables[TABLE]` would be `undefined` |
| 4 | `test-file-deleted` `migration-053-structure.test.ts` | no loss | `UPDATE … WHERE role='sales_partner'` → `re-applying 053 converts a stray sales_partner row to admin` (053:407-436), asserting all three seeded roles **on the first apply**; `runs the conversion exactly once` → retired class 2, replaced by the second apply (053:487-508) which also asserts `afterSecond == afterFirst` and no row moved; `users_role_check` + `CHECK (role IN …)` → `USERS_ROLE_CHECK_DEF` literal (053:167-169, asserted at :227, :400, :490, :620); `conname` guard → the second apply; `t.relname = 'users'` scoping → the `public.accounts` decoy (053:455-510); plus a `decoy_1301.users` decoy for the `n.nspname` filter (053:511-568); `not.toMatch(/DROP TABLE|DROP COLUMN|DROP CONSTRAINT/)` → `expect(after.tables['users']).toEqual(before.tables['users'])` (053:402) + `assertOnlyTablesMoved` (053:450) |
| 5 | `test-file-deleted` `migration-057-…-nullability.test.ts` | no loss beyond the two named retirements | 5 loosened + 5 deliberately-untouched columns → `HEAD_NULLABILITY` literal (057:136-149), asserted at :288-296; `not.toMatch(/CREATE TABLE|CREATE POLICY|CREATE INDEX/)` → per-table full equality for all three tables (057:338-340) plus `assertOnlyTablesMoved` (057:351), which reports an appeared table by name; `not.toMatch(/\bpurging\b/)` and `not.toMatch(/NEXT_PUBLIC_/)` → **retired class 1**, reason stated in the 057 header and in the doc. I agree with the retirement: neither corresponds to a catalogue object |
| 6 | `quality-config-changed` `.github/workflows/ci.yml` | no relaxation | `git diff` is one line, `image: postgres:16` → `postgres:17`, inside `services.postgres`. `POSTGRES_USER/PASSWORD/DB`, the tmpfs data dir, health-check options and ports are untouched. Newly **pinned** by two tests (`ci-audit-wiring.test.ts` — `the test job and the e2e job pin the same postgres major`, `local E2E setup uses the same PostgreSQL 17 image as both CI database services`), each asserting the exact major *and* cross-file equality, so neither a drift apart nor a joint regression to 16 passes |
| 7 | `quality-config-changed` `scripts/ci/live-db-suites-audit.ts` | no relaxation — a tightening | Every changed line is inside the `MIGRATION_SHAPE_FILES` `Set` literal or a comment (`git diff`: +44/-4, all within `:106-181`). No rule, threshold, escape hatch or detection path changed; `NOT_LIVE_DB`, `SHARED_LOCK_MARKER` and `auditLiveDbFile` are untouched. Adding an entry subjects that file to the lock-marker check, so seven more files are now checked. `pnpm ci:live-db-suites` → `passed`; `scripts/ci/__tests__/live-db-suites-audit.test.ts` (37 cases, unchanged) → green |
| 8 | `quality-config-changed` `vitest.config.ts` | no relaxation | Comment only: one digit inside a `//` line. `projects`, `fileParallelism: false`, `sequence.groupOrder`, `coverage` and `INTEGRATION_GLOB` unchanged (`git diff --numstat` = 1/1 on a comment line) |
| 9 | `suppression-added` `migration-guard.test.ts` — "`@ts-expect-error` IS the assertion" | not a suppression | The comment line itself tripped the detector. The directive it describes is real and consumed: `pnpm typecheck` is clean at head, and TypeScript raises `TS2578: Unused '@ts-expect-error' directive` when a directive has nothing to suppress — so if `DegradeTarget` widened back to `readonly string[]`, typecheck would fail |
| 10 | `suppression-added` `migration-guard.test.ts:224` — `// @ts-expect-error an empty selector list is not a DegradeTarget` | not a suppression | Same mechanism, plus a runtime half: `assertDegradeLanded` throws on an empty list (`migration-guard.ts:470-476`) and the same case (`:208-236`) asserts that throw with `toThrow(/empty selector list/)`. Both doors are closed, and the doc's reasoning is accurate |

Rows 2-10 check out as written. Row 1 does not — F-A.

The doc's own "three genuinely retired assertion classes" section is accurate: class 1 (057's two word bans) and class 3 (117's one text case) are both real and both carry written reasons in their suite headers; class 2 (053's "conversion exactly once") is replaced by something strictly stronger.

### Q6 — can the new tests pass while the promised behavior is wrong?

**All 60 promised titles are present verbatim, each implemented exactly once.** I string-matched every title from `tests_to_add` across `src`, `scripts`, `worker`, `tests`, `e2e`, `.github`. 57 matched once; three matched twice (`admin_audit_log carries row security enabled and no policy at head`, `admin_audit_log grants no privilege to anon or authenticated at head`, `re-applying 117 moves no other table in public`) and in each case the second occurrence is header prose (`117:43,51,64`) with exactly one `it()` (`117:371,401,595`). The two cross-cutting titles sit where §5/§6 assign them: `head posture pins migration 048 defaults and foreign keys and migration 051 columns and foreign keys` in 048 (`:259`, with 051's half under 051's own head case) and `migration guards reject weakened index predicates and role allowlists on a freshly provisioned database` in 053 (`:617`, asserting both literals).

For each promised behavior, can the test pass while the behavior is wrong?

| Weakening of the migration | Caught by | Verdict |
|---|---|---|
| 048 loses `WHERE ended_at IS NULL` | 048:107-108 literal + 053:174-177 literal, both compared directly | caught |
| 048 loses an index entirely | `assertDegradeLanded` throws "already absent from the before catalogue" on a reprovisioned container | caught, loudly |
| 048 loses `ENABLE ROW LEVEL SECURITY` | 048:222 | caught |
| 048 loses a column NOT NULL / the PK | — | **NOT caught — F-A** |
| 049 loses its one statement, in any lexical form | 049:161-167 (catalogue, not text) | caught |
| 051 loses an index or a CHECK | 051:245-269 literals | caught |
| 051 gains a `DELETE`/`UPDATE` | 051:341-411 whole-record equality on a seeded row | caught |
| 053 widens the allowlist | 053:167 literal | caught |
| 053 loses its `UPDATE`, or the `WHERE` becomes universal | 053:428-435 (three-role control, first apply) | caught |
| 053 loses the `DO` guard's `relname`/`nspname` scoping | 053:455-568 (two decoys, planted while the real constraint is absent) | caught |
| 057 loses or adds an `ALTER COLUMN` | 057:136-149 (both polarities pinned) | caught |
| 117 `REVOKE ALL` → `REVOKE SELECT` | 117:612-655 — degrade grants all 8 derived PG17 privileges to both roles, re-apply must grant none | caught |
| 117 loses an index or a column | 117:492-526 (preserved cases, both `toContain` a literal ordering) | caught |
| 118 loses its `REVOKE` | 118:552-585 — the default-ACL degrade plus a probe table that **proves** the inheritance before the drop, so the REVOKE is genuinely falsifiable | caught |
| 118 loses a `COMMENT ON` or `DEFAULT NOW()` | 118:434-460 and 601-615, pinned literals | caught |
| 118 loses its PK or a column type | pinned only in `helpers/migration-guard.integration.test.ts` — F-H | caught, but not where the header says |

Trust-boundary negative tests exist where they matter: the 118 default-ACL rollback is asserted on every run (`:526, 584`); the derived privilege list has a `>= 7` fail-loud floor in both 117 and 118 so no "grants none of them" assertion can pass vacuously; `PUBLIC` (grantee OID 0) is matched explicitly in both three-arm ACL cases; column-level effective privilege is checked separately (Arm C) because Arm A filters on grantee name and `has_table_privilege` ignores column grants. The pure guard tests (`migration-guard.test.ts`, 15 cases) are genuine negatives, not smoke tests — including the substring trap (`idx_reviews_account` vs `idx_reviews_account_v2`), both polarities of the vacuity check, appearing/disappearing unlisted tables, a same-name policy rewrite, grant-option changes, and byte-equality of the verbatim read.

**Compromises the review record does not already name:** F-A, F-B, F-C, F-D, F-E, F-F, F-G, F-H above, plus the untested catalogue branches in the appendix.

---

## 3. The "also check" list

| Item | Result |
|---|---|
| No migration SQL edited | `git diff --stat 0773873..a4becdc -- supabase/` is **empty** |
| No suite outside the #1301 list rebuilt | The only other test file touched is `migration-122-client-role-grant-sweep.integration.test.ts`, +11/-7 in its **header comment only** (stated-limit text: "the MAINTAIN branch cannot execute on the PG16 container" → "CI and e2e run postgres:17 … the MAINTAIN branch executes here"). No code, no assertion. It is on the allowed edit surface. 074/076/077/078/088/116/119/121 untouched |
| #1173 untouched | Nothing under `worker/` in the diff; no reference to the autonomy boot line |
| Every changed file within `allowed_edit_surface` | **Yes**, all 36. Six allowed paths untouched: `docs/agents/change-ledger.md` (`pnpm ci:merge-ledger` → `passed (0 production + 3 governance file(s))`, so no row owed), the three review-report paths, `scripts/ci/__tests__/live-db-suites-audit.test.ts` (asserts no set size/contents, so T2's conditional did not fire — 37 cases green), `scripts/test-db-setup.sh` (non-goal honoured) |
| All 60 titles verbatim, once each | Yes — see Q6 |
| `migration-guard.ts` executes no DDL, opens no connection ⇒ exemption earned | **Earned.** No `unsafe(`, no `postgres(`, no DDL keyword outside a string literal or comment. Its only statements are two `tx<…>` SELECTs over `pg_class`/`pg_namespace`/`pg_attribute`/`pg_policy`/`pg_index`/`pg_constraint`/`pg_attrdef`/`aclexplode` and one `db.begin`. `readMigrationSql` is `existsSync` + `readFileSync`. `pnpm ci:live-db-suites` → `passed`, and each suite's registry case runs the real audit over its own real text |
| 117 preserved seven cases unchanged | **All survive byte-identical.** I diffed the merge-base bodies against head for: `admin_audit_log is REVIEWED_NOT_TENANT_SCOPED and NOT a TENANT_TABLES member` (:235), `enables deny-all RLS (no FORCE), defines zero policies, and grants the client roles nothing` (:317), `creates the ten locked columns …` (:492), `indexes the actor and the event type, both newest-first` (:516), `the actor FK carries NO referential action …` (:527), `writeAdminAuditLog persists a row keyed on the admin …` (:658), `rejects a row for an actor that is not a users row, by the named FK` (:703). Exactly one old case was removed: `the migration file enables RLS with no policy and revokes the client roles` — the text-matching one, retired class 3 |
| `schema-ready.ts` change additive | **Yes.** `git diff --numstat` = **104 added / 0 deleted** across 90 importers. Six new exported consts + comments; `SchemaRequirement`, `assertSchemaReady`, `findMismatchedColumnTypes` and every pre-existing export untouched. Caveat in F-E: one of the new exports has no consumer |

### Gates run at `a4becdc44`

| Command | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm ci:live-db-suites` | passed |
| `pnpm ci:weakened-checks` | passed, 10 REVIEW rows (Q5) |
| `pnpm ci:merge-ledger` | passed |
| `pnpm vitest run helpers/migration-guard.test.ts` | 15 passed |
| `pnpm vitest run src/__tests__/ci-audit-wiring.test.ts` | green (within 186 across 3 files) |
| 7 suites + helper integration, one run | 8 files / 50 tests, exit 0 |
| all 11 touched test files | 236 passed, exit 0 |

---

## 4. Appendix — uncertain or non-actionable observations

1. **Catalogue branches never exercised against a real database.** `readPublicCatalogue`'s generated-column `expression=` rendering (`migration-guard.ts:278-285`), the column-ACL `":<column>"` grant form (`:341-350`), the `":GRANT OPTION"` suffix (`:339,348`) and `forceRowSecurity = true` have no schema object in `public` that produces them, so `readPublicCatalogue reports every catalogue dimension for a known table` cannot cover them. They are proven only by hand-built fixtures in the pure test — which is precisely the gap deviation D5 added the reader case to close. Not actionable without DDL the suite is not allowed to run; worth knowing that the F5/F7 corrections are unverified at the SQL level.
2. **Three failures in the full `--project integration` run are this worktree's environment, not the branch.** `worker/jobs/zernio/__tests__/zernio-end-to-end.integration.test.ts` (×2) and `worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts` (#614) fail identically in isolation. This worktree's `.env.local` has been replaced by a 3-line file ("red-team scrubbed replacement") setting `MOCK_EXTERNAL_APIS=true`; the real env is at `.env.local.pg16-backup` with `MOCK_EXTERNAL_APIS=false` and `TEST_DATABASE_POOL_URL` still pointing at port 5499/`test_ws4`. CLAUDE.md names `MOCK_EXTERNAL_APIS=true` as the cause of exactly that Zernio breakage ("`true` short-circuits Zernio transport and breaks real-path tests"). Both files are gitignored (`.gitignore:32`), so no secret reaches the commit. **Implication for the gate:** any full-suite evidence produced from this worktree is unreliable until `.env.local` is restored, and the branch should not be judged on it.
3. **048 and 049 have no `assertSchemaReady`, so a partially-applied container fails with a raw Postgres error rather than the named message.** 048's header states this deliberately ("this suite proves the container is at head itself"); it holds when the *table* is missing (`expect(table?.rowSecurity, BEHIND_HEAD)`), but a container with the table present and one index missing reaches `DROP INDEX idx_impersonation_actor_started` and raises `index … does not exist`. 049 would raise a raw `regclass` error if `analytics_events` were absent. Intake `user_visible_behavior[1]` says each case names `pnpm test:db:setup`; in these two narrow shapes it does not. Low value, and the requirement object for 048 already exists (F-E).
4. **`postgresImageMajor(E2E_YML)` matches the first `image: postgres:<n>` in the whole file**, not a named job (`ci-audit-wiring.test.ts:157-159`). A second postgres service on a different major in `e2e.yml` would not be detected. The `ci.yml` side is job-scoped and correct.
5. **`blast-radius.md` says "No changed production source files"** while `arch-review-log.md:3` says "Production diff 50 lines across four files". `scripts/ci/live-db-suites-audit.ts` is both changed and imported by all seven new suites. The two statements use different definitions of "production"; I could not establish which the tool intends, so this is an observation rather than a finding.
6. **F-B's mechanism.** I could not determine it. The two hypotheses I could not confirm or rule out: OID reuse for the re-created `poller_heartbeats` combined with a stale `pg_description` row, and a visibility effect in `col_description(att.attrelid, att.attnum)` under `DROP TABLE` + `CREATE TABLE` + `COMMENT ON` inside one transaction. The `columnDefaults` assertion two lines earlier passing argues against a simple "table missing" or "re-apply did not run" explanation.
7. **Plan §6's note that "the gate's `promised-tests` row searches all test roots for each title and succeeds on the first match"** means the gate cannot detect a title implemented in the wrong suite. I verified ownership by hand for the two cross-cutting titles and found both where §5/§6 say they should be. No finding; recorded so the next reviewer does not have to re-derive it.
