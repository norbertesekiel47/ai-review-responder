# Plan — migration guard suites execute their migration (#1301, #1307 RT-4)

Branch `fix/1301-migration-guard-execution`. Intake:
`docs/superpowers/plans/fix-1301-migration-guard-execution-intake.json`.
Deviations: `docs/superpowers/plans/fix-1301-migration-guard-execution-deviations.md`.
Plan review round 1: `docs/reviews/fix-1301-migration-guard-execution/plan-review-r1.md`
(VERDICT: REVISE, 14 findings, all accepted — see §8).

Written for an engineer who is skilled but knows nothing of this codebase.

---

## 1. The problem, stated once

A **migration guard suite** is a test whose subject is a checked-in file under
`supabase/migrations/`. Its job is to fail when someone removes a security
property that migration established.

Six of these suites prove their migration by reading its SQL **text** and
matching patterns against it. That approach lost five red-team passes on #1171.
Each pass defeated a hand-rolled approximation of a SQL lexer: line-anchored
counting, then `CREATE\nPOLICY` split across a newline, then
`DISABLE/**/ROW LEVEL SECURITY` with a block comment inside it, then `--`
inside a string literal, then a comment standing in as evidence. Every fix
closed one lexical class and the next pass found another.

The verdict of that fifth pass was that the **approach** was wrong. The suite
stopped parsing the file and started running it. PostgreSQL is the parser now.

`src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts` is
the result and the pattern this plan copies.

### The seven files

| Migration | Current suite | State |
|---|---|---|
| 048 impersonation_sessions | `migration-048-impersonation-sessions.test.ts` (32 lines) | text guard, wrong name |
| 049 analytics_events RLS | `migration-049-analytics-events-rls.test.ts` (22 lines) | text guard, wrong name |
| 051 flagged_responses | `migration-051-structure.test.ts` (67 lines) | text guard, wrong name |
| 053 users role constraint | `migration-053-structure.test.ts` (50 lines) | text guard, wrong name |
| 057 tombstone nullability | `migration-057-account-offboarding-tombstone-nullability.test.ts` (52 lines) | text guard, wrong name |
| 117 admin_audit_log | `migration-117-admin-audit-log.integration.test.ts` (296 lines) | text guard, correct name |
| 118 poller_heartbeats | none | missing |

"Wrong name" is rule **R1** in `scripts/ci/live-db-suites-audit.ts`: a suite
that reaches the shared local Postgres must be named `*.integration.test.ts`,
because that glob is what puts it in vitest's serialized `integration` project.
A suite that misses the glob runs fully parallel against every other live-DB
writer.

---

## 2. Facts that were checked, not assumed

**Fact 1 — none of the seven migration files carries its own `BEGIN;` or
`COMMIT;`.** Only 119 does, which is why 119 must run on a `max: 1` connection
and cannot be wrapped. All seven of ours can run inside an outer transaction.

**Fact 2 — all seven are re-runnable in place.** They use
`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
`ALTER TABLE … ENABLE ROW LEVEL SECURITY`, `REVOKE`, a catalogue-guarded
`DO $$` block, and `ALTER COLUMN … DROP NOT NULL`. #1301's idempotency caveat
bites none of them.

**Fact 3 — a multi-statement `tx.unsafe()` inside `db.begin()` works.** Proven
against postgres.js 3.4.9 on PostgreSQL 17.11 before this plan was gated:
degrade dropped two of five indexes, the verbatim re-apply restored all five
and set `relrowsecurity` back to true, the sentinel rolled back, and the
container still read five indexes afterwards.

**Fact 4 — exactly two workflows pin a Postgres major**: `ci.yml:282` and
`e2e.yml:71`. `.github/actions/test-db` pins none; it receives connection
inputs. There is no third database lane.

---

## 3. The pattern every suite follows

Every suite carries **two independent oracles**. Neither alone is sufficient,
and round 1's F4 is the reason.

### Oracle A — the pinned head posture (independent)

Literal expectations, written in the test, for what the catalogue must contain
at head: exact `pg_get_indexdef` strings, exact `pg_get_constraintdef` strings,
the exact nullability of each named column, the exact privilege set for `anon`
and `authenticated`.

These literals are **not derived from the migration file**. That is the whole
point. Consider someone deleting `WHERE ended_at IS NULL` from migration 048.
CI then runs `pnpm test:db:setup`, which builds the container *from the
weakened file*. A BEFORE reading taken from that container carries the weakened
index, the re-apply recreates the weakened index, and `AFTER == BEFORE` passes.
Self-comparison is circular on a freshly provisioned database. Oracle A is what
catches it, and being a catalogue assertion rather than a text match, it stays
immune to every lexical evasion #1171 enumerated.

### Oracle B — degrade, re-apply, and diff

```
await withRolledBackTransaction(db, async (tx) => {
  const before = await readPublicCatalogue(tx);
  await tx.unsafe(DEGRADE_SQL);
  const degraded = await readPublicCatalogue(tx);
  assertDegradeLanded(before, degraded, {
    table: TABLE,
    property: 'indexes',
    absent: ['idx_impersonation_active_actor', 'idx_impersonation_actor_started'],
  });
  await tx.unsafe(readMigrationSql(MIGRATION));
  const after = await readPublicCatalogue(tx);
  expect(after.tables[TABLE]).toEqual(before.tables[TABLE]);
  assertOnlyTablesMoved(before, after, [TABLE]);
});
```

`assertDegradeLanded` names the **property AND every individual object** the
degrade must remove (F1, round 2). Three progressively weaker contracts were
rejected on the way here, and the reason each failed is worth stating:

1. "the table changed somehow" accepts a degrade that perturbed an unrelated
   column while leaving the guarded index in place.
2. "the named property changed" accepts a degrade that dropped one of four
   indexes while the other three were never challenged.
3. Only "each named object was present in BEFORE and is absent now" proves the
   degrade reached every object the re-apply is about to be credited with
   restoring.

`absent` entries match a `CatalogueEntry.name` **exactly** — never as a
substring (round 3). `assertDegradeLanded` throws if any named object was
already missing from BEFORE, because otherwise a typo in the name would make
the check vacuous in the other direction.

**Degrades that ADD rather than remove use `present` instead.** Two of the
seven move that way: 057's degrade reinstates `NOT NULL`, and 117's degrade
grants privileges. Forcing them into `absent` is what produced round 3's
selector mismatch. `present` asserts each named object was **missing** from
BEFORE and is **there** now — the same three-part contract with its polarity
reversed, and the same protection against a typo passing vacuously.

**Deliberate table removal.** Migration 118's degrade drops its table outright,
so `degraded.tables['poller_heartbeats']` is `undefined` and any property
lookup on it would throw before the re-apply ran (round 2, R2-D1). The
contract therefore accepts `property: 'presence'`: the target must exist in
BEFORE and be absent afterwards. Every other value of `property` still requires
the table to exist on both sides, so an unexpectedly missing table remains a
loud failure rather than a silent pass.

### Every suite's degrade target, in one table

Each row is the exact `assertDegradeLanded` call the suite makes. A suite whose
degrade removes objects of two kinds calls it twice.

| Suite | `property` | selector | names |
|---|---|---|---|
| 049 | `rowSecurity` | *(boolean)* | — |
| 048 | `indexes` | `absent` | `idx_impersonation_actor_started`, `idx_impersonation_impersonated_started`, `idx_impersonation_account_started`, `idx_impersonation_active_actor` |
| 048 | `rowSecurity` | *(boolean)* | — |
| 051 | `indexes` | `absent` | `idx_flagged_responses_status_created`, `idx_flagged_responses_open_response` |
| 051 | `rowSecurity` | *(boolean)* | — |
| 053 | `constraints` | `absent` | `users_role_check` |
| 057 | `notNullColumns` | `present` | `account_offboardings`: `zernio_account_ids`, `zernio_profile_ids` · `approval_audit_log`: `response_id` · `impersonation_sessions`: `account_id`, `impersonated_user_id` — one call per table |
| 117 | `indexes` | `absent` | `idx_admin_audit_actor_created`, `idx_admin_audit_event_created` |
| 117 | `grants` | `present` | every `anon:<priv>` and `authenticated:<priv>` name derived from `acldefault('r', <owner>)` — see T8 |
| 117 | `rowSecurity` | *(boolean)* | — |
| 118 | `presence` | *(the table itself)* | — |

`notNullColumns` exists precisely so 057 has an exact name to select on. Its
entries are bare column names, so `present: ['zernio_account_ids']` is an exact
match with no type string in the way — the defect round 3 found.

For a boolean property, the three-part contract reduces to "the value flipped",
which the property comparison already proves, so neither selector applies.

### Why the rollback, and not an explicit restore

Later migrations layer on these tables. 057 drops `NOT NULL` on
`impersonation_sessions`, which 048 creates. 122 sweeps client grants on every
public table. So "drop the table, re-apply 048" would restore 048's posture and
**lose** 057's and 122's. The shared container is read by every other live-DB
suite, and that damage would persist for the rest of the run.

A transaction that always rolls back removes the whole class. Fact 1 says
nothing blocks the wrapping and fact 3 proves the mechanism.

`migration-122-client-role-grant-sweep.integration.test.ts:242-259` already
uses `sql().begin` with a rollback sentinel, so the mechanism has precedent
here.

### Why the degrade is narrow

**A degrade may only remove what a verbatim re-apply restores.** That is
indexes, row security, and `GRANT`/`REVOKE`. It is never the `CREATE TABLE`
body: the table exists at head, so `CREATE TABLE IF NOT EXISTS` is skipped and
column definitions and inline `CHECK` constraints are not re-created. Oracle A
guards those instead.

One exception: `poller_heartbeats` (118) may be dropped whole, because no
migration after 118 alters it. Its re-created table takes a **new OID**, which
is why the catalogue is keyed on names and contains no OID anywhere.

### Why the harness executes no DDL

`scripts/ci/live-db-suites-audit.ts` treats any live-DB file that executes DDL
as needing membership in `MIGRATION_SHAPE_FILES`, and it enforces that every
member names a cross-process lock marker **in its own text**. The harness does
not acquire the lock; the suite does. Putting `tx.unsafe(…)` in the harness
would force it to claim a lock it does not own.

So the harness reads (SELECT), compares (pure), and wraps (`begin`). Every
`tx.unsafe` call stays in the suite that owns the lock. This keeps the audit's
enforcement truthful rather than merely satisfied.

---

## 4. Modules and seams

**New module — `src/lib/shared/__tests__/helpers/migration-guard.ts`.**
Five functions. Behind them sit the catalogue joins and the diff logic. Seven
suites and roughly 40 cases call it. Delete it and the catalogue query
reappears in seven files, so it passes the deletion test. It takes its database
handle as a parameter and never resolves one.

**Unchanged module — `src/lib/shared/__tests__/helpers/live-db-lock.ts`.** Lock
lifecycle is a different responsibility. Merging the two would widen that
module's interface for no shared logic.

**Deepened, no interface change —
`scripts/ci/live-db-suites-audit.ts`**: seven entries added to
`MIGRATION_SHAPE_FILES`.
**`src/lib/shared/__tests__/helpers/schema-ready.ts`**: six
`SchemaRequirement` entries added.

**No production module changes.** Nothing under `src/lib/**` outside
`__tests__/`, nothing under `worker/`, no migration SQL.

---

## 5. Tracers

Eight tracers. T1 runs alone so its enforcement spot check proves the edit
guard binds for subagent tool calls. T2 runs alone because every later tracer
imports it. **T3 to T8 are mutually independent**: disjoint file sets, no
blocking edges, and T2 has already made every shared-file edit they would
otherwise contend over.

---

### T1 — move the CI and e2e lanes to PostgreSQL 17 (#1307 RT-4)

**Modify:** `.github/workflows/ci.yml` (line 282), `.github/workflows/e2e.yml`
(line 71), `src/__tests__/ci-audit-wiring.test.ts`,
`docs/runbooks/e2e-local-setup.md` (line 11), `.claude/reference/env-vars.md`
(line 88), `vitest.config.ts` (line 13 comment),
`.claude/rules/live-db-tests.md` (line 23),
`.claude/reference/lab-notes/live-db-test-suites.md` (line 26).

**Behavior contract.** CI's `test` job and the `e2e` workflow both stand up
`postgres:17`. Migration 122's `MAINTAIN` statements run only on PostgreSQL
≥ 17, so before this change no CI run ever executed them. Both Supabase
projects are 17.

The two `services:` blocks are documented to stay in lockstep (`ci.yml:275`).
Today nothing enforces it. After this tracer a test does.

Every current document stating the major moves with it. The local E2E runbook
is not cosmetic: it is the canonical command a developer runs, and leaving it
on 16 while CI runs 17 recreates the exact CI-versus-local split RT-4 exists to
close (F14).

**Negative cases.** Change one workflow's image and not the other: the first
test fails and names both files. Leave the runbook on 16: the second test
fails.

**Invariant.** Only the image tag changes. Environment variables, the tmpfs
data directory, health-check options, and every other service key stay exactly
as they are.

**Seam.** `src/__tests__/ci-audit-wiring.test.ts` — it reads workflow YAML off
disk and opens no database, which is why `live-db-suites-audit.ts` lists it in
`NOT_LIVE_DB`. Do not move it.

**Precedent.** `src/__tests__/ci-audit-wiring.test.ts:203` already asserts
`/^\s+image:\s*postgres:\d+/m` against the `test` job. That assertion is loose
by design today; this tracer replaces it with an exact, cross-file check.

**Test titles (verbatim):**
- `the test job and the e2e job pin the same postgres major`
- `local E2E setup uses the same PostgreSQL 17 image as both CI database services`

The first test extracts `image: postgres:<major>` from both workflows, asserts
both equal `17`, and asserts the two are equal to each other. Asserting
equality alone would pass if both regressed to 16 together.

**Local environment, already done in setup.** A second container
`repworth-testdb-pg17` (postgres:17.11, port 5500, database `test_1301`) runs
beside the existing postgres:16 container, which still serves seven databases
for other worktrees. This worktree's `.env.local` points at the new container;
the previous value is kept at `.env.local.pg16-backup`. The full migration
chain provisioned to head with zero `ERROR:` or `FATAL:` lines, and migration
122's mandatory post-apply MAINTAIN query returns 0. No tracer recreates or
deletes the 16 container.

---

### T2 — the migration-guard harness and the shared registrations

**Create:** `src/lib/shared/__tests__/helpers/migration-guard.ts`,
`src/lib/shared/__tests__/helpers/migration-guard.test.ts`,
`src/lib/shared/__tests__/helpers/migration-guard.integration.test.ts`.
**Modify:** `scripts/ci/live-db-suites-audit.ts`,
`scripts/ci/__tests__/live-db-suites-audit.test.ts`,
`src/lib/shared/__tests__/helpers/schema-ready.ts`.

**Behavior contract — the interface.**

```ts
/**
 * Every catalogue property is a list of NAMED entries, never a flat string.
 * Round 3 rejected flat strings twice over: `columns` rendered
 * "<name> <type> <NULL|NOT NULL>", so a selector written as
 * "zernio_account_ids NULL" is not a substring of
 * "zernio_account_ids text[] NULL" — the type sits between the two halves.
 * And substring matching cannot establish identity at all:
 * `idx_impersonation_actor_started` is a substring of
 * `idx_impersonation_actor_started_v2`. A named entry makes selection an
 * exact match on `name` and keeps the whole rendering in `definition` for the
 * equality diff.
 */
export interface CatalogueEntry {
  name: string;        // selected on, matched EXACTLY
  definition: string;  // compared on, the full rendering
}

export interface CataloguedTable {
  table: string;                  // the key; never an OID
  rowSecurity: boolean;           // pg_class.relrowsecurity
  forceRowSecurity: boolean;      // pg_class.relforcerowsecurity
  policies: readonly CatalogueEntry[];   // name → "<cmd> <PERMISSIVE|RESTRICTIVE>
                                         //   TO <roles>: <qual> / <withcheck>"
  columns: readonly CatalogueEntry[];    // name → "<type> <NULL|NOT NULL>
                                         //   [IDENTITY <a|d>]
                                         //   [GENERATED <s>: <expression>]"
  notNullColumns: readonly string[];     // column names with attnotnull, sorted
  columnDefaults: readonly CatalogueEntry[];  // name → default expression
  columnComments: readonly CatalogueEntry[];  // name → comment
  indexes: readonly CatalogueEntry[];    // index name → pg_get_indexdef
  constraints: readonly CatalogueEntry[];// constraint name → pg_get_constraintdef
  comment: string | null;                // obj_description on the table
  grants: readonly CatalogueEntry[];     // "<grantee>:<privilege>[:<column>]"
                                         //   → "<grantor>[:GRANT OPTION]"
}

export interface PublicCatalogue {
  tables: Readonly<Record<string, CataloguedTable>>;
}

export type DegradeTarget =
  | { table: string; property: 'presence' }
  | { table: string; property: keyof CataloguedTable; absent: readonly string[] }
  | { table: string; property: keyof CataloguedTable; present: readonly string[] };

export function readPublicCatalogue(tx: TransactionSql): Promise<PublicCatalogue>;
export function assertDegradeLanded(
  before: PublicCatalogue, after: PublicCatalogue, target: DegradeTarget,
): void;
export function assertOnlyTablesMoved(
  before: PublicCatalogue, after: PublicCatalogue, tables: readonly string[],
): void;
export function withRolledBackTransaction<T>(
  db: Sql, fn: (tx: TransactionSql) => Promise<T>,
): Promise<void>;
export function readMigrationSql(fileName: string): string;
```

`readPublicCatalogue` covers every relation in schema `public` with
`relkind in ('r','p')`.

`policies` stores each policy's full **definition** — name, command,
permissive or restrictive mode, the roles it applies to, and both expressions.
A policy whose body is rewritten under the same name would otherwise be
invisible on every unlisted table, and a policy switched from `PERMISSIVE` to
`RESTRICTIVE`, or retargeted to a different role, changes its effect without
changing either expression (F6, round 2).

`columns` carries identity and generated metadata alongside type and
nullability, **including the generation expression itself** (F5, rounds 2 and
3). A column converted to `GENERATED ALWAYS AS IDENTITY` changes who may write
it while its type and nullability read identically; and a generated column
whose expression is rewritten keeps its flag, so capturing the flag alone would
miss the change that matters. Read the expression from
`pg_get_expr(adbin, adrelid)` for the attribute's default entry, which is where
PostgreSQL stores a generated column's expression.

`columnDefaults` and `columnComments` exist because migration 118 declares
both — `last_cycle_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` and a
`COMMENT ON COLUMN` — and neither is visible in `columns` alone (F5).

`grants` enumerates **every** grantee found in `relacl` and `attacl` through
`aclexplode`, not a fixed role list, and records both the grant option and the
**grantor** (F7, round 2). Grantee OID 0 is rendered as `PUBLIC`. A privilege
granted to a role outside `anon`/`authenticated`/`service_role`, the same
privilege regranted `WITH GRANT OPTION`, and the same privilege regranted by a
different grantor all register as changes — the last one matters because it
changes who can revoke it again.

`assertDegradeLanded` enforces the three-part contract in §3: the property
differs, every object named in `absent` was present in BEFORE, and every one of
them is gone afterwards. `property: 'presence'` is the table-removal form and
is the only form that tolerates an absent table on the AFTER side.

`assertOnlyTablesMoved` throws when any table outside the named list differs,
**and when a table appears or disappears outside that list** (F13). The error
names each offending table.

`withRolledBackTransaction` runs `fn` inside `db.begin` and always rolls back.
It uses a module-private sentinel error, **re-throws any other error
unchanged**, and resolves normally when the sentinel comes back. A wrapper that
swallowed a callback error would turn every failing executing case into a pass,
which is why that behaviour gets its own test rather than being assumed (F8).

`readMigrationSql` resolves `supabase/migrations/<fileName>` from the
repository root and returns the file **verbatim**, byte for byte. It throws an
error naming the missing path when the file is absent. It never normalises,
trims, or splits the SQL.

**Invariant.** `migration-guard.ts` executes no DDL and opens no connection. It
stays out of `MIGRATION_SHAPE_FILES` and is never asked to hold a lock. It is a
test helper and production code never imports it.

**The two test files, and why there are two.** The pure cases go in
`migration-guard.test.ts`, which imports no live-DB helper and names no
`TEST_DATABASE_POOL_URL`, so the audit does not classify it as a live-DB file.
Build `PublicCatalogue` fixtures by hand.

`withRolledBackTransaction` cannot be proven without a database, so its two
cases go in `migration-guard.integration.test.ts`. That file holds the
cross-process lock and uses **DML only** — insert a row into `users` inside the
wrapper and assert it is gone afterwards. It executes no DDL, so it needs no
`MIGRATION_SHAPE_FILES` entry.

**Shared registrations, made here so T3–T8 stay disjoint.**

Add all seven suite paths to `MIGRATION_SHAPE_FILES` in
`scripts/ci/live-db-suites-audit.ts`, each with a one-line comment naming the
migration and what its degrade removes:

```
src/lib/shared/__tests__/migration-048-impersonation-sessions.integration.test.ts
src/lib/shared/__tests__/migration-049-analytics-events-rls.integration.test.ts
src/lib/shared/__tests__/migration-051-flagged-responses.integration.test.ts
src/lib/shared/__tests__/migration-053-users-role-constraint.integration.test.ts
src/lib/shared/__tests__/migration-057-account-offboarding-tombstone-nullability.integration.test.ts
src/lib/shared/__tests__/migration-117-admin-audit-log.integration.test.ts
src/lib/shared/__tests__/migration-118-poller-heartbeats.integration.test.ts
```

An entry whose file does not yet exist is never consulted: the membership test
runs only for files the walk finds. So adding all seven before the suites exist
is safe, and it is what lets six tracers run in parallel.

If `scripts/ci/__tests__/live-db-suites-audit.test.ts` asserts the contents or
size of that set, update it in this tracer.

Add `SchemaRequirement` entries to `schema-ready.ts` for 048, 051, 053, 057,
117 and 118, using the objects each migration creates. **049 gets no
requirement**: it creates no relation, column, index or constraint, which is
migration 097's and 119's situation exactly.

**Test titles (verbatim), in `migration-guard.test.ts`:**
- `assertDegradeLanded throws when the target table did not change`
- `assertDegradeLanded passes when the target table lost an index`
- `assertDegradeLanded rejects an unrelated table change when the guarded property remains intact`
- `assertDegradeLanded requires every named object to be absent after the degrade`
- `assertDegradeLanded requires every named object to be present after an additive degrade`
- `assertDegradeLanded matches object names exactly and not by substring`
- `assertDegradeLanded accepts deliberate target-table removal without dereferencing a missing table`
- `assertOnlyTablesMoved throws when an unlisted table changed`
- `assertOnlyTablesMoved passes when only the named table changed`
- `assertOnlyTablesMoved rejects newly created and dropped unlisted tables`
- `assertOnlyTablesMoved rejects a same-name policy definition change on an unlisted table`
- `assertOnlyTablesMoved detects grant-option changes and grants to roles outside the client-role list`
- `readMigrationSql throws when the migration file is missing`
- `readMigrationSql returns every byte of an existing migration unchanged`

**Test titles (verbatim), in `migration-guard.integration.test.ts`:**
- `withRolledBackTransaction preserves callback errors and rolls back successful and failed callbacks`
- `readPublicCatalogue reports every catalogue dimension for a known table`

The second title was added during T2's spec check; see deviations D5. The pure
fixtures are hand-built, so they cannot detect the reader itself omitting a
dimension — and a reader that dropped one would leave all 14 pure cases green
while every suite went blind to it. The case asserts on CONTENT for all eleven
`CataloguedTable` fields, and it runs BEFORE T3–T8 fan out, because six suites
build on this reader.

---

### T3 — migration 049, analytics_events row security

**Create:** `src/lib/shared/__tests__/migration-049-analytics-events-rls.integration.test.ts`.
**Delete:** `src/lib/shared/__tests__/migration-049-analytics-events-rls.test.ts`.

This is the smallest of the seven and the first end-to-end proof of the
pattern. Build it first among T3–T8.

**Behavior contract.** Migration 049 is one statement:
`ALTER TABLE analytics_events ENABLE ROW LEVEL SECURITY;`. Migration 046
created the table without it, which made it reachable through the anon
PostgREST API.

Four cases: the DB-free registry case; oracle A at head
(`relrowsecurity = true`, zero policies, failure message naming
`pnpm test:db:setup`); oracle B (`DISABLE`, prove the degrade landed on the
`rowSecurity` property, apply verbatim, assert the table matches its BEFORE);
and the noninterference case.

**Negative case.** Delete the `ENABLE ROW LEVEL SECURITY` line from
`supabase/migrations/049_analytics_events_rls.sql` and oracle A must fail even
after a fresh `pnpm test:db:setup`. Comment it out with `/* */`, with `--`, or
split it across a newline: both oracles must still fail, because nothing reads
the text.

**Invariants.** R1 naming. The suite holds the cross-process lock via
`acquireLiveDbLock`. `describeWithDb` gates every DB case; the registry case
does not need a database and never skips.

**Precedent.** `migration-119-job-outbox-rls.integration.test.ts` — the
`beforeAll` / `afterAll` lock lifecycle, the `max: 1` client, and the header
that states the suite's limits.

**Stated limit for the header.** 049 establishes exactly one property, so this
suite has no un-guarded remainder.

**Test titles (verbatim):**
- `migration 049 suite is registered in MIGRATION_SHAPE_FILES`
- `analytics_events carries row security enabled at head`
- `re-applying 049 restores row security after it is disabled`
- `re-applying 049 moves no other table in public`

---

### T4 — migration 048, impersonation_sessions

**Create:** `src/lib/shared/__tests__/migration-048-impersonation-sessions.integration.test.ts`.
**Delete:** `src/lib/shared/__tests__/migration-048-impersonation-sessions.test.ts`.

**Behavior contract.** 048 creates the table, enables row security, and creates
four indexes: `idx_impersonation_actor_started`,
`idx_impersonation_impersonated_started`, `idx_impersonation_account_started`,
and the partial unique `idx_impersonation_active_actor`
(`ON (actor_user_id) WHERE ended_at IS NULL`). That partial unique index
enforces "one active impersonation session per actor" at the database.

Degrade: drop the four indexes and `DISABLE ROW LEVEL SECURITY`. Do **not**
drop the table. 057 later dropped `NOT NULL` on `account_id` and
`impersonated_user_id`, so a re-created table would carry the wrong nullability
and the diff would fail for a reason that is not a regression.

**Oracle A must pin literals** (F4, F11): the exact four `pg_get_indexdef`
strings including the partial predicate, the three foreign-key
`pg_get_constraintdef` strings to `users`, `users` and `accounts`, and
`id`'s `gen_random_uuid()` default. Capture the real catalogue output from the
container and paste it; do not hand-write an approximation.

**Negative case.** Remove `WHERE ended_at IS NULL` from the migration and
oracle A fails even on a freshly provisioned container, because the expected
`pg_get_indexdef` literal no longer matches.

**Stated limit for the header.** The `CREATE TABLE` body is not guarded by
oracle B, because `CREATE TABLE IF NOT EXISTS` is skipped at head. Oracle A
guards it.

**Test titles (verbatim):**
- `migration 048 suite is registered in MIGRATION_SHAPE_FILES`
- `impersonation_sessions carries row security enabled at head`
- `re-applying 048 restores the guarded indexes after they are dropped`
- `re-applying 048 moves no other table in public`
- `head posture pins migration 048 defaults and foreign keys and migration 051 columns and foreign keys` *(shared title — see T5)*
- `migration guards reject weakened index predicates and role allowlists on a freshly provisioned database` *(shared title — see T6)*

Two titles are shared across suites because the finding they answer is shared.
Place `head posture pins migration 048 defaults and foreign keys and migration
051 columns and foreign keys` in **this** suite and have T5 assert the 051 half
under its own head-posture case; place `migration guards reject weakened index
predicates and role allowlists on a freshly provisioned database` in **T6**,
where both halves — an index predicate and a role allowlist — are available.

---

### T5 — migration 051, flagged_responses

**Create:** `src/lib/shared/__tests__/migration-051-flagged-responses.integration.test.ts`.
**Delete:** `src/lib/shared/__tests__/migration-051-structure.test.ts`.

**Behavior contract.** 051 creates the table with deny-all row security and two
indexes: `idx_flagged_responses_status_created` and the partial unique
`idx_flagged_responses_open_response` (`ON (response_id) WHERE status = 'open'`).
That partial unique index stops idempotent re-runs of response generation from
stacking duplicate open flags. This table backs architecture invariant #4 —
high-confidence unsafe drafts are held, not notified.

Degrade: drop the two indexes and `DISABLE ROW LEVEL SECURITY`.

**Oracle A must pin literals** (F11): the full column inventory with types and
nullability, **all six** foreign-key definitions, and the three `CHECK`
definitions on `source`, `severity` and `status`.

The six foreign keys are `response_id`, `account_id`, `business_id` and
`review_id` (all `ON DELETE CASCADE`), `api_cost_id` (`ON DELETE SET NULL`),
and `reviewed_by_user_id` (no action). An earlier draft of this plan said five
and omitted `reviewed_by_user_id` — corrected during T2's foundation check,
deviations D6. Read the count from the catalogue, never from this prose.

**Row preservation** (F10, corrected in round 2): the old suite banned
`DROP TABLE`, `UPDATE` and `DELETE` by regex. Catalogue equality cannot see row
loss, so the executing case must check rows — but a **count** is not enough. A
count is unchanged by an `UPDATE` that rewrites every value, and on the empty
container a `DELETE` has nothing to delete, so a count-only check is vacuous
in both directions.

The case therefore seeds **one real row** inside the rolled-back transaction
and asserts it is byte-identical after the apply. `flagged_responses` has six
foreign keys, four of them `NOT NULL`, so the fixture inserts the parent chain
first — `accounts`, `businesses`, `reviews`, `responses` — with fixed UUID
literals and only the columns those tables require. The two nullable parents,
`api_cost_id` and `reviewed_by_user_id`, may be left `NULL`; seeding them is
optional and needs `api_costs` and `users` rows if you do. Seeding the chain is
not overhead: it also proves the four mandatory foreign keys accept real
values, which is part of the head posture oracle A pins.

Read the row back with `SELECT *` ordered by column name and compare the whole
record, not selected fields. A future `UPDATE` added to 051 then fails whatever
column it touches.

**Negative case.** Remove `WHERE status = 'open'` and oracle A fails. Add a
`DELETE FROM flagged_responses` or an `UPDATE` to the migration and the
row-preservation case fails.

**Stated limit for the header.** The three inline `CHECK` constraints live in
the `CREATE TABLE` body and are not restored by a re-apply, so oracle B cannot
guard them. Oracle A does. This limit is why the intake's original title for
this suite was wrong; see deviations D1.

**Test titles (verbatim):**
- `migration 051 suite is registered in MIGRATION_SHAPE_FILES`
- `flagged_responses carries row security enabled and no policy at head`
- `re-applying 051 restores the guarded indexes after they are dropped`
- `re-applying 051 moves no other table in public`
- `re-applying 051 preserves every existing flagged_responses row unchanged`

---

### T6 — migration 053, the users role allowlist

**Create:** `src/lib/shared/__tests__/migration-053-users-role-constraint.integration.test.ts`.
**Delete:** `src/lib/shared/__tests__/migration-053-structure.test.ts`.

**Behavior contract.** 053 has two statements. First
`UPDATE users SET role = 'admin' WHERE role = 'sales_partner'`. Then a
`DO $$` block that adds `CHECK (role IN ('owner', 'admin'))` as constraint
`users_role_check`, guarded by a `pg_constraint` lookup scoped to the `users`
relation. Both statements are re-runnable.

This is the only one of the seven that runs DML, and it carries the most
findings.

Degrade and fixtures, all inside the rolled-back transaction:
1. `ALTER TABLE users DROP CONSTRAINT users_role_check;`
2. Insert three rows into `users`: one `sales_partner`, one `owner`, one
   `admin`. Only `id`, `name`, `email` and `role` are needed — `account_id` is
   nullable and `role` has a default. Use fixed UUID literals.
3. Apply 053 verbatim.
4. Assert, **on the first apply**, the final role of all three seeded rows:
   the `sales_partner` row is now `admin`, the `owner` row is still `owner`,
   and the `admin` row is still `admin` (F10, rounds 2 and 3). The old regex
   proved the `WHERE` clause existed; this proves it is exclusive, which is the
   property that matters. Round 3 asked for the admin control too, and for the
   assertion to be made on the first apply rather than only after the second —
   an `UPDATE` that rewrote every row would be repaired into looking correct by
   nothing, but asserting only after the idempotence step would leave the first
   apply's effect unexamined.
5. Assert `users_role_check` is back with a definition byte-identical to the
   pinned literal.
6. **Apply 053 a second time** and assert the catalogue does not move and no
   row changes (F9). One apply after dropping the constraint never exercises
   the already-present branch of the `DO` guard, which is the branch that makes
   the migration re-runnable.
7. **The decoy case runs with the real constraint ABSENT** (F9, corrected in
   round 2). Round 1's fix placed the decoy after the real constraint was
   restored, and that arrangement tests nothing: with the real constraint
   present, a scoped and an unscoped lookup both find a row and both skip, so
   the two are indistinguishable. The correct order is:
   1. `ALTER TABLE users DROP CONSTRAINT users_role_check;`
   2. create **two** decoy `CHECK` constraints named `users_role_check`:
      one on a different relation in the same schema (`public.accounts`), and
      one on a table in a **different schema** created inside the transaction
      (`CREATE SCHEMA decoy_1301; CREATE TABLE decoy_1301.users (role text);`
      then the constraint on it);
   3. apply 053 verbatim;
   4. assert `users_role_check` is now present **on `public.users`**, and that
      both decoys are untouched.

   The two decoys test the two halves of the `DO` guard's lookup separately.
   The `accounts` decoy challenges `t.relname = 'users'`: a guard matching
   `conname` alone would find it, skip the `ADD CONSTRAINT`, and leave `users`
   unprotected. The `decoy_1301.users` decoy challenges
   `n.nspname = 'public'`: a guard that dropped the schema filter would match a
   same-named constraint on a same-named table in another schema and skip for
   the same reason. Round 3 asked for the second one specifically, and it is a
   different filter, not a duplicate of the first.

   `CREATE SCHEMA` inside the transaction rolls back with everything else, so
   the shared container never sees `decoy_1301`. `assertOnlyTablesMoved` reads
   schema `public` only, so the decoy schema's table does not register as a
   moved table.

**Oracle A must pin the allowlist literal**: the exact
`pg_get_constraintdef` string, so widening the allowlist to include
`sales_partner` fails even on a freshly provisioned container (F4).

**The shared F4 title lives here and asserts both halves.** `migration guards
reject weakened index predicates and role allowlists on a freshly provisioned
database` is one case in this suite. `readPublicCatalogue` covers every table
in `public`, not only this suite's target, so the single case can and does
assert two literals: `idx_impersonation_active_actor`'s exact
`pg_get_indexdef` string including `WHERE (ended_at IS NULL)`, and
`users_role_check`'s exact `pg_get_constraintdef` string. Both are literals in
the test, so both fail on a container provisioned from a weakened migration.
T4 and T5 keep their own per-suite head expectations; this case is the
cross-cutting proof that the oracle is independent of the file, and round 2
asked for that ownership to be stated rather than implied.

**Negative cases.** Remove the `UPDATE` line: the conversion case fails. Change
the `UPDATE`'s `WHERE` to match every row: the owner-preservation assertion
fails. Widen the allowlist: oracle A fails. Remove the `DO` guard's relation
scoping: the decoy case fails.

**Invariant.** No seeded row reaches the shared container: the transaction
always rolls back. Do not seed outside it.

**Test titles (verbatim):**
- `migration 053 suite is registered in MIGRATION_SHAPE_FILES`
- `users carries the users_role_check constraint at head`
- `re-applying 053 restores users_role_check after it is dropped`
- `re-applying 053 converts a stray sales_partner row to admin`
- `re-applying 053 moves no other table in public`
- `re-applying 053 is idempotent and ignores same-named constraints outside public.users`
- `re-applying 053 ignores a same-named constraint in another schema`
- `migration re-application preserves existing rows except the intended sales_partner conversion`
- `migration guards reject weakened index predicates and role allowlists on a freshly provisioned database`

---

### T7 — migration 057, tombstone nullability

**Create:** `src/lib/shared/__tests__/migration-057-account-offboarding-tombstone-nullability.integration.test.ts`.
**Delete:** `src/lib/shared/__tests__/migration-057-account-offboarding-tombstone-nullability.test.ts`.

**Behavior contract.** 057 drops `NOT NULL` from five columns across three
tables: `account_offboardings.zernio_account_ids`,
`account_offboardings.zernio_profile_ids`, `approval_audit_log.response_id`,
`impersonation_sessions.account_id`, and
`impersonation_sessions.impersonated_user_id`. The purge worker needs them
nullable so it can scrub raw provider identifiers from a retained lifecycle
receipt without losing the receipt.

Degrade: `SET NOT NULL` on all five. This is the only degrade that can fail for
a data reason — `SET NOT NULL` errors if any existing row holds `NULL`.

Before degrading, the suite asserts the five columns hold no `NULL` values and
reports a named failure if they do, telling the reader the container carries
data that makes the degrade impossible. Do not skip the case silently.

Three tables move, not one, so this suite passes all three to
`assertOnlyTablesMoved`.

**Oracle A must pin the nullability of the five loosened columns AND of the
columns 057 deliberately left alone** (F4): `account_offboardings.location_ids`,
`account_offboardings.provider_dispositions`,
`approval_audit_log.account_id`, `approval_audit_log.business_id`, and
`impersonation_sessions.actor_user_id` must all still be `NOT NULL`. The old
suite proved that with `not.toMatch`; oracle A proves it from the catalogue.

**Negative case.** Remove any one of the five `ALTER COLUMN` clauses and the
executing case fails, naming that column. Add a sixth clause loosening
`actor_user_id` and oracle A fails.

**Stated limit for the header.** 057's `not.toMatch(/\bpurging\b/)` and
`not.toMatch(/NEXT_PUBLIC_/)` assertions are **retired with reason**: both are
text-vocabulary checks over a SQL file, neither corresponds to any catalogue
object, and a catalogue equality assertion cannot and should not claim to
police arbitrary text. Record this in the header and in the
`ci:weakened-checks` justification.

**Test titles (verbatim):**
- `migration 057 suite is registered in MIGRATION_SHAPE_FILES`
- `the five tombstone columns are nullable at head`
- `re-applying 057 restores nullability after NOT NULL is reinstated`
- `re-applying 057 moves no other table in public`

---

### T8 — migration 117 rebuild and migration 118 new suite

**Modify:** `src/lib/shared/__tests__/migration-117-admin-audit-log.integration.test.ts`.
**Create:** `src/lib/shared/__tests__/migration-118-poller-heartbeats.integration.test.ts`.

These two share one shape — deny-all row security plus revoked client-role
privileges — so they are one tracer. Their files are disjoint from every other
tracer's.

#### 117

Already correctly named and already an integration suite, but it guards by
text. It creates `admin_audit_log`, enables row security with no policy, runs
`REVOKE ALL … FROM anon, authenticated`, and creates two indexes.

Degrade: **`GRANT ALL ON admin_audit_log TO anon, authenticated`** — every
privilege type PostgreSQL 17 defines, not `SELECT` alone. Granting only
`SELECT` cannot tell `REVOKE ALL` from `REVOKE SELECT`, so the case would pass
with the migration weakened (F3). Then drop both indexes and `DISABLE ROW LEVEL
SECURITY`. Re-apply must restore all three.

**The grant half of the degrade moves in the opposite direction**, so it does
not use `assertDegradeLanded`, which asserts objects went away. Instead the
case derives the expected privilege list from `acldefault('r', <owner>)` —
never a hand-spelled list, because PostgreSQL 16 defines seven table privileges
and 17 defines eight, and a spelled list breaks on one of them. It then asserts
the degraded catalogue grants **every** derived privilege to both `anon` and
`authenticated`, and that the re-applied catalogue grants none of them. That
pair is what makes `REVOKE ALL` distinguishable from `REVOKE SELECT`.

**Preserve unchanged** — round 1 enumerated these and the plan's "replace only
the text-matching cases" instruction covers them explicitly:
- the `REVIEWED_NOT_TENANT_SCOPED` / `TENANT_TABLES` membership case;
- the RLS-true / FORCE-false / zero-policies / role-privilege case block;
- the exact ten-column inventory with types, nullability and defaults;
- the actor and event index cases;
- the foreign-key `NO ACTION` case and its `23503` behavioural assertion;
- the real-writer round-trip case and the missing-actor `23503` case.

Only the cases that read the migration's SQL text are replaced. A text case
with no catalogue equivalent is retired **in the header with a written
reason**, never deleted silently.

#### 118

`poller_heartbeats` is one row per background loop, holding the time that loop
last completed a cycle. It backs `isJudgeHealthy`, and Judge availability is a
posting precondition (architecture invariant #3). The table has a natural
primary key `poller_name`, deny-all row security, a table comment, a column
comment, a `DEFAULT NOW()` on `last_cycle_at`, and
`REVOKE ALL … FROM anon, authenticated`.

Degrade: **`GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated` is
wrong here** — it would move every table. Instead: grant the owner's schema
default privileges back (`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL
ON TABLES TO anon, authenticated`), then `DROP TABLE poller_heartbeats`. The
re-created table then **inherits** those permissive defaults, and the
migration's own `REVOKE` is the only thing that can remove them. Without this,
122 has already stripped the owner's defaults, so a fresh `CREATE TABLE` grants
nothing and the `REVOKE` is never challenged — the case would pass with the
`REVOKE` line deleted (F2).

118 is the one migration of the seven that may be dropped whole, because no
migration after it alters the table. The re-created table takes a new OID,
which the name-keyed catalogue tolerates by design.

**Because the table is gone, the vacuity check uses the table-removal form**
(R2-D1): `assertDegradeLanded(before, degraded, { table: 'poller_heartbeats',
property: 'presence' })`. Any property-named form would dereference a table
that is not there. Dropping the vacuity check for 118 instead is not an option
— it is the one suite whose degrade is total, so it is the one where a silently
skipped degrade would be least visible.

**Oracle A must pin 118's comments and default independently** (F4, round 2).
Three literals in the test: the table comment string, the `last_cycle_at`
column comment string, and the `last_cycle_at` default expression as the
catalogue renders it (`now()`). Without them, the executing case proves only
that the re-apply reproduced whatever the container already had, which is the
circular oracle F4 exists to close — and it is circular for comments and
defaults exactly as it was for index predicates.

**Negative cases.** Remove the `REVOKE` line and the case must fail. Remove
either `COMMENT ON` statement and both the executing case and oracle A must
fail. Remove `DEFAULT NOW()` and both must fail.

**Stated limit for the 117 header.** The `CREATE TABLE` body is not guarded by
oracle B. The preserved head cases guard it.
**Stated limit for the 118 header.** None: the whole table is dropped and
re-created, so every object 118 declares is proven by the executing case.

**Test titles (verbatim):**
- `migration 117 suite is registered in MIGRATION_SHAPE_FILES`
- `admin_audit_log carries row security enabled and no policy at head`
- `admin_audit_log grants no privilege to anon or authenticated at head`
- `re-applying 117 restores the revoked client grants after they are granted`
- `re-applying 117 moves no other table in public`
- `re-applying 117 revokes every PostgreSQL 17 table privilege from both client roles`
- `migration 118 suite is registered in MIGRATION_SHAPE_FILES`
- `poller_heartbeats carries row security enabled and no policy at head`
- `poller_heartbeats pins its table comment, column comment and last_cycle_at default at head`
- `poller_heartbeats grants no privilege to anon or authenticated at head`
- `re-applying 118 restores the table after it is dropped`
- `re-applying 118 moves no other table in public`
- `re-applying 118 revokes every client privilege inherited from permissive default ACLs`
- `re-applying 118 restores the last_cycle_at default and column comment`

---

## 6. Coverage check against the intake

**60 promised titles, measured against `.feature/intake.json` at HEAD.** The
prose here said 58 while the per-tracer breakdown below it summed to 59, and
neither matched the intake — three numbers for one countable fact (#1301
RT-8/F-G). The breakdown is now per OWNING FILE, which is what a reader can
check with a grep, and it is derived by searching each title's exact text:

| Titles | Owning file |
|---:|---|
| 15 | `src/lib/shared/__tests__/helpers/migration-guard.test.ts` |
| 9 | `src/lib/shared/__tests__/migration-053-users-role-constraint.integration.test.ts` |
| 8 | `src/lib/shared/__tests__/migration-118-poller-heartbeats.integration.test.ts` |
| 6 | `src/lib/shared/__tests__/migration-117-admin-audit-log.integration.test.ts` |
| 5 | `src/lib/shared/__tests__/migration-048-impersonation-sessions.integration.test.ts` |
| 5 | `src/lib/shared/__tests__/migration-051-flagged-responses.integration.test.ts` |
| 4 | `src/lib/shared/__tests__/migration-049-analytics-events-rls.integration.test.ts` |
| 4 | `src/lib/shared/__tests__/migration-057-account-offboarding-tombstone-nullability.integration.test.ts` |
| 2 | `src/lib/shared/__tests__/helpers/migration-guard.integration.test.ts` |
| 2 | `src/__tests__/ci-audit-wiring.test.ts` |
| **60** | **total, every title found, none missing** |

Each title is implemented exactly once. Two titles are
worded as cross-cutting and their single owning suite is stated explicitly:
`head posture pins migration 048 defaults and foreign keys and migration 051
columns and foreign keys` lives in T4, with T5 carrying the 051 half under its
own head-posture case; `migration guards reject weakened index predicates and
role allowlists on a freshly provisioned database` lives in T6 and asserts both
literals there, because `readPublicCatalogue` reads every public table.

The gate's `promised-tests` row searches all test roots for each title and
succeeds on the first match, so one occurrence is the correct number. It cannot
adjudicate which suite *should* own a title, which is why §5 states ownership
in prose.

Every `user_visible_behavior` entry maps to a tracer: lexical-form
independence to T3–T8's negative cases, the behind-head message to each
suite's oracle A case, the untouched container to §3's rollback, the
PostgreSQL 17 lane to T1, and the `MIGRATION_SHAPE_FILES` registration to T2.

No task contains `TBD`, `TODO`, "add appropriate error handling", "handle edge
cases", or "similar to Task N". Every type the plan names —
`CataloguedTable`, `PublicCatalogue`, `SchemaRequirement` — is defined in T2 or
already exists in `schema-ready.ts`.

## 7. Security coverage

No tracer crosses a production trust boundary: the branch ships no runtime
code. The trust question is inverted — each suite **is** a security control,
and the failure mode is a control that passes vacuously. Every executing case
therefore carries a property-specific `assertDegradeLanded`, and T2 carries
negative tests for that guard, for the diff, and for the rollback wrapper
itself.

`grants` enumerates every grantee including `PUBLIC` and records grant options,
which is what makes 117's and 118's `REVOKE` assertions real rather than
environment-dependent.

## 8. Review appendix

### Round 1 — Codex plan skeptic (`gpt-6-astra`), VERDICT: REVISE

Session id `01a0bda7-0982-7773-8164-298827ad35d0`. A verification round resumes
this session rather than starting cold. Report:
`docs/reviews/fix-1301-migration-guard-execution/plan-review-r1.md`.

All 14 findings accepted. Dispositions:

| ID | Sev | Disposition |
|---|---|---|
| F1 | P1 | FIXED — `assertDegradeLanded` now takes `{ table, property }`; §3, T2 |
| F2 | P1 | FIXED — 118's degrade restores permissive default ACLs before the drop; T8 |
| F3 | P1 | FIXED — 117's degrade grants ALL, not SELECT; T8 |
| F4 | P1 | FIXED — oracle A, pinned literals independent of the migration file; §3 and every suite |
| F5 | P2 | FIXED — `columnDefaults` and `columnComments` added to the catalogue; T2, T8 |
| F6 | P1 | FIXED — `policies` stores definitions, not names; T2 |
| F7 | P2 | FIXED — `grants` records grant options and every grantee including PUBLIC; T2 |
| F8 | P1 | FIXED — `migration-guard.integration.test.ts` proves the wrapper re-throws; T2 |
| F9 | P1 | FIXED — second apply plus a decoy same-named constraint on another relation; T6 |
| F10 | P1 | FIXED — owner-row preservation in T6, row-count equality in T5 |
| F11 | P2 | FIXED — oracle A pins 048's defaults and FKs and 051's columns and FKs; T4, T5 |
| F12 | P2 | FIXED — verbatim-return test added; T2 |
| F13 | P2 | FIXED — appearing and disappearing unlisted tables; T2 |
| F14 | P2 | FIXED — `docs/runbooks/e2e-local-setup.md` moves with CI; T1 |

Round 1 also confirmed, against HEAD, that the staging-ride waiver is sound for
this edit surface, and that the transaction-and-shared-lock architecture itself
is viable. Its stop-hook section is an observation about implementation not yet
existing, not a finding.

### Round 2 — verification (resumed session), VERDICT: REVISE

Report: `docs/reviews/fix-1301-migration-guard-execution/plan-review-r2.md`.
Resumed session `01a0bda7-0982-7773-8164-298827ad35d0`, 53,129 tokens — against
139,203 for round 1, which is what resuming instead of starting cold buys.

Seven fixes verified outright: F2, F3, F8, F11, F12, F13, F14. Seven partial,
and one defect introduced by a round 1 fix. It opened no new fronts.

| ID | Round 2 verdict | Correction applied |
|---|---|---|
| R2-D1 | defect introduced by F1's fix | `property: 'presence'` is the table-removal form; T8/118 uses it. A property lookup on a dropped table would have thrown before the re-apply |
| F1 | PARTIAL | `absent: string[]` — every named object must be present in BEFORE and gone after. Naming only the property accepted a degrade that dropped one of four indexes |
| F4 | PARTIAL | T8 pins 118's table comment, column comment and `now()` default as literals. The oracle was circular for those three exactly as it was for index predicates |
| F5 | PARTIAL | `columns` now carries identity and generated metadata |
| F6 | PARTIAL | `policies` now carries command, permissive/restrictive mode and target roles, not only the two expressions |
| F7 | PARTIAL | `grants` now carries the grantor, which decides who can revoke again |
| F9 | PARTIAL | The decoy now exists while the real constraint is **absent**. Round 1's order tested nothing: with the real constraint present, a scoped and an unscoped lookup both skip |
| F10 | PARTIAL | T5 seeds one real row through its four-table parent chain and compares the whole record. A count is unchanged by a value rewrite, and vacuous on an empty table |

Round 2 also confirmed the three claims the plan added on its own initiative:
the shared-title arrangement is compatible with the gate's fixed-string search
(one occurrence is correct); T7's retirement of 057's two word bans carries an
adequate written reason for `ci:weakened-checks`, which emits a REVIEW row
rather than a failure and assigns the explanation to the reviewer; and T8's
preserve-unchanged list for 117 is complete against round 1's own enumeration.
Its only ask on the shared titles was that ownership be stated rather than
implied, which §5 and §6 now do.

### Round 3 — final verification (resumed session), VERDICT: REVISE

Report: `docs/reviews/fix-1301-migration-guard-execution/plan-review-r3.md`.
Same session, 80,064 tokens. Six items verified YES — R2-D1, F4, F6, F7, the
shared-title ownership, and 117's `acldefault`-derived privilege list. Four
PARTIAL. It opened no new fronts.

| Item | Round 3 verdict | Correction applied |
|---|---|---|
| F1 | PARTIAL — two selector defects | Catalogue properties are now lists of `CatalogueEntry { name, definition }`. `absent`/`present` match `name` **exactly**, never as a substring, so `idx_actor_started` can no longer match `idx_actor_started_v2`. A new `notNullColumns` property gives 057 a bare column name to select on, and a new `present` selector serves the two degrades that ADD rather than remove (057's `SET NOT NULL`, 117's `GRANT`) |
| F5 | PARTIAL | `columns` now carries the generation expression from `pg_get_expr`, not only the generated flag |
| F9 | PARTIAL | A **second** decoy on a table in another schema, created and rolled back inside the transaction, challenges the `DO` guard's `n.nspname = 'public'` filter. The `accounts` decoy challenges only `t.relname = 'users'` |
| F10 | PARTIAL | T6 asserts all three seeded rows' roles **on the first apply**, admin control included, not only after the idempotence step |

**The F1 selector mismatch was a real defect in this plan**, not a
misreading: `columns` rendered `<name> <type> <NULL\|NOT NULL>`, so the §3
table's selector `zernio_account_ids NULL` could never have matched
`zernio_account_ids text[] NULL`. A faithful implementation of the stated
contract would have failed on 057. Named entries remove the class rather than
patching the five strings.

### Review cap reached — no round 4

Round 3 is the last round the cap allows. Its closing ask is for the owner to
decide between requiring these corrections and accepting a narrower coverage
contract.

**There is no disagreement to adjudicate.** All four residual items were
accepted as correct and are fixed above, in the plan, before implementation —
not deferred into it. What the owner is asked to confirm is therefore narrow:
that these plan-level corrections stand in place of a fourth review round.
Both positions are recorded here and in the three round reports.
