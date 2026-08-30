# Plan — migration 116 `refusal_events` (issue #1008, slice 1 of 7)

Intake: `docs/superpowers/plans/feat-1008-migration-116-refusal-events-intake.json`
Deviations: `docs/superpowers/plans/feat-1008-migration-116-refusal-events-deviations.md`
Locked DDL: issue #1001, answer comment "locked 2026-08-29" — **reproduced in
full in Task 1 below, with the C5 correction from D4.**
Ticket #1008 · Map #994 · Slicing #1004 · Next slice #1009

Revision 2. Round 1 of the codex plan review returned `VERDICT: REVISE`; its
findings are D4–D8 in the deviations file and are folded in here.

## Modules and seams

No interface widens and no module is added. The design work is a schema
decision #1001 already locked; this plan is its execution.

| Seam | What happens | Deepen or widen? |
|---|---|---|
| `supabase/migrations/` | one new file, `116_refusal_events.sql` | neither — a migration is a leaf artifact |
| `scripts/ci/tenant-tables.ts` | one map entry | deepen — the map gains a key |
| `docs/security/rls-inventory.md` | one table row | deepen — forced by the map entry |
| `src/lib/account-offboarding/table-disposition.ts` | one array entry | deepen — the inventory gains a row |
| `src/lib/account-offboarding/purge-verification.ts` | one `case` in `verificationQuery` | deepen — the existing switch gains an arm |
| `worker/jobs/account-offboarding/purge-stages.ts` | one `DELETE` in `runContentPurgeStage` | deepen — an existing stage gains a statement |
| `CONTEXT.md`, `docs/adr/0023-*` | vocabulary of record | new documents, no code interface |

The `codebase-design` skill is not invoked, deliberately: it decides where a
seam goes. Every seam here exists, every change adds one member to an existing
list, and no caller changes. Invoking it would produce the table above.

## The rule that orders everything

**Migration 116 reaches a database BEFORE the code that names it.**

Ticket #1008's "two-step life" (merge, then promote) assumed no deployed code
names the table. D1 broke that assumption: the forced disposition row drags in
a `verificationQuery` branch and a purge `DELETE`, both of which name
`refusal_events` in SQL. A missing relation raises `42P01` at **plan time**, and
`PurgeWorker` terminalizes the offboarding after bounded retries rather than
recovering (D6).

So this slice ships on the repository's standard RISK = high lane, migration
first in every environment — but never ahead of CI or of your merge approval.
Step 8 spells out the only order that gives both properties, and names the
exact step at which #1009 unblocks.

## Tasks

### Task 0 — the eval task (author every promised test, red)

**Blocking edges:** none. Lands first, alone, committed before any
implementation.

Author all twenty-two `tests_to_add` titles as runnable failing tests.

**New file** `src/lib/shared/__tests__/migration-116-refusal-events.integration.test.ts`
— titles 1–19. Precedent, followed exactly:
`src/lib/shared/__tests__/migration-114-solicitation-attribution.integration.test.ts`.

- `describeWithDb` + `acquireLiveDbLock` (`LIVE_DB_LOCK_HOOK_TIMEOUT_MS`), the
  cross-process lock. Titles 16–18 prove GLOBAL index behaviour, so the lock is
  required, not optional.
- `assertSchemaReady` with a `SchemaRequirement` naming migration `116`, the
  table, the three index names and the five constraint names.
- **Executes no DDL.** The file stays absent from `MIGRATION_SHAPE_FILES` in
  `scripts/ci/live-db-suites-audit.ts` — that allowlist is for suites where
  APPLYING the migration is the subject.
- Seeds its own tenant with `seedTenantAccount` / `seedLocation`, cleans up with
  `cleanupTenantAccount`.
- Every rejection case asserts the **constraint name** in the raised error,
  never merely that it threw.

**Three assertion styles, and each title uses the right one — this is D5's
lesson and it is the difference between a real eval and a decorative one:**

| Style | Reads | Used by |
|---|---|---|
| structural | `pg_class.relrowsecurity`, `pg_policies`, `pg_get_constraintdef`, `pg_indexes.indexdef`, `information_schema.columns`, `pg_constraint` (FKs), `pg_description` | 1, 2, 3, 4, 5, 7 |
| file text | the checked-in `116_refusal_events.sql` | 6 |
| module import | `TENANT_TABLES` from `scripts/ci/tenant-tables.ts` | 19 |
| behavioural | `INSERT` succeeds or raises a named constraint | 8–18 |

Every one of titles 1–19 has a style. Titles 20–22 live in existing
offboarding suites and follow those suites' established styles.

**Title 7 must be structural, not behavioural.** The standalone
`refusal_source` CHECK rejects every unmapped lane before C1 evaluates, so no
reachable row exercises C1's fall-through. A C1 with the correct seven arms and
**no** `IS TRUE` wrapper would pass every behavioural test. The test reads
`pg_get_constraintdef` and asserts the wrapper is present.

**Title 19 lives in the migration-116 suite, not in a `scripts/ci/` test.**
`scripts/ci/__tests__/tenant-tables.integration.test.ts` is NOT in
`allowed_edit_surface`, and widening the surface for one assertion would spend
the second and last amendment of the abort budget. The assertion needs no
database — it imports `TENANT_TABLES` and reads one key — so it belongs beside
the schema it describes. Rehomed, not dropped (D10).

**Existing file** `src/lib/account-offboarding/__tests__/table-disposition.test.ts`
— title 20, on the existing
`'offboarding purge sweeps uploads, contacts, visits, batches, and asks'` shape.

**Existing file** `src/lib/account-offboarding/__tests__/purge-verification.test.ts`
— title 21, on the existing
`'purge verification fails when a solicitation_consent row survives the purge'`
shape. It must use an **account-wide** fixture (`business_id IS NULL`) and a
second account's row, so an unscoped or business-joined implementation fails.

**Existing file** `worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts`
— title 22, on the existing `runContentPurgeStage` cases at `:1207` and
`:1283`. Same fixture rule: account-wide rows included, second account
untouched.

**Green when:** every title exists verbatim, and each suite fails for the right
reason (`assertSchemaReady` reports migration 116 missing; the offboarding
titles fail on the absent classification, branch and `DELETE`).

---

### Task 1 — migration 116

**Blocking edges:** Task 0.
**Turns green:** titles 1–18.
**Files:** `supabase/migrations/116_refusal_events.sql` (new).

Style precedent, followed exactly:
`supabase/migrations/114_solicitation_attribution.sql`.

**File structure**

1. **Header comment**: what the table is; that it has no writer until #1009;
   the deploy-ordering rule and that a flag protects rows, not the parse; why
   `occurred_at` and `created_at` are two different columns; why `subject_id`
   carries no FK; the LOCAL-ONLY status.
2. `BEGIN;` … `SET LOCAL lock_timeout = '10s';` … `COMMIT;`. One transaction,
   110's and 114's reasoning: psql autocommits each statement, so a partial
   re-run must not leave the table without its constraints.
3. The `CREATE TABLE`, verbatim as below.
4. `COMMENT ON TABLE` plus `COMMENT ON COLUMN` for **all twelve** columns
   (114's precedent). The `occurred_at` and `created_at` comments must each say
   which one the retention sweep uses, in those words.
5. The three indexes, verbatim as below. Plain `CREATE INDEX`, never
   `CONCURRENTLY` — it cannot run inside a migration transaction, and the table
   holds zero rows everywhere (112's precedent).
6. `ALTER TABLE refusal_events ENABLE ROW LEVEL SECURITY;` followed by
   `-- Deliberately NO policies: deny-all.` — 098's exact shape.

**The table — twelve columns, five named CHECKs**

```sql
CREATE TABLE IF NOT EXISTS refusal_events (
  id UUID PRIMARY KEY,                       -- UUIDv7, worker-supplied, no DB default

  -- Real FKs ONLY to accounts/businesses, and no referential action on either:
  -- both parents are retain_deidentified (tombstoned, never deleted), so
  -- neither can take a Refusal away on another table's clock.
  account_id  UUID NOT NULL REFERENCES accounts(id),
  business_id UUID          REFERENCES businesses(id),

  refusal_source TEXT NOT NULL CHECK (refusal_source IN (
    'held_draft', 'auto_post_revoked', 'autonomy_suspended', 'ask_withheld',
    'outreach_withheld', 'batch_halted', 'policy_gate_held')),
  refusal_code      TEXT,      -- verbatim, never normalised. NULL only for held_draft.
  all_refusal_codes TEXT[],    -- policy_gate_held only. NOT owner-facing (ADR 0023).

  refusal_category TEXT NOT NULL CHECK (refusal_category IN (
    'unsafe_content', 'watchdog_unavailable', 'below_our_bar', 'no_permission',
    'wrong_moment', 'autonomy_paused', 'missing_information',
    'owner_review_required')),
  vocabulary_version TEXT NOT NULL,

  -- A bare uuid with NO foreign key and no referential action: NULL (this lane
  -- points at nothing) must stay distinguishable from non-null-but-unresolvable
  -- (the subject aged away).
  subject_type TEXT CHECK (subject_type IN (
    'response', 'solicitation_ask', 'solicitation_outreach', 'solicitation_batch')),
  subject_id   UUID,

  occurred_at TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- C1 — the lane determines the subject type, totally.
  CONSTRAINT refusal_events_source_subject_pairing CHECK (
    (CASE refusal_source
       WHEN 'held_draft'         THEN subject_type = 'response'
       WHEN 'policy_gate_held'   THEN subject_type = 'response'
       WHEN 'auto_post_revoked'  THEN subject_type = 'response'
       WHEN 'ask_withheld'       THEN subject_type = 'solicitation_ask'
       WHEN 'outreach_withheld'  THEN subject_type = 'solicitation_outreach'
       WHEN 'batch_halted'       THEN subject_type = 'solicitation_batch'
       WHEN 'autonomy_suspended' THEN subject_type IS NULL
     END) IS TRUE
  ),

  -- C2 — a subject is whole or absent.
  CONSTRAINT refusal_events_subject_completeness CHECK (
    (subject_type IS NULL) = (subject_id IS NULL)
  ),

  -- C3 — account-wide means suspended, and suspended means account-wide.
  CONSTRAINT refusal_events_business_pairing CHECK (
    (business_id IS NOT NULL) = (refusal_source <> 'autonomy_suspended')
  ),

  -- C4 — only held_draft has no code.
  CONSTRAINT refusal_events_code_pairing CHECK (
    (refusal_code IS NULL) = (refusal_source = 'held_draft')
  ),

  -- C5 — the code array belongs to one lane, and the winner is in it.
  CONSTRAINT refusal_events_all_codes_pairing CHECK (
    ((refusal_source =  'policy_gate_held'
        AND all_refusal_codes IS NOT NULL
        AND cardinality(all_refusal_codes) > 0
        AND array_position(all_refusal_codes, NULL) IS NULL
        AND refusal_code = ANY(all_refusal_codes))
     OR
     (refusal_source <> 'policy_gate_held'
        AND all_refusal_codes IS NULL)) IS TRUE
  )
);
```

**C5 carries two clauses #1001 did not have, and both are load-bearing (D4).**
`array_position(all_refusal_codes, NULL) IS NULL` and the outer `IS TRUE`
wrapper. Without them, `refusal_code = 'winner'` against
`all_refusal_codes = ARRAY['different', NULL]` makes `= ANY(…)` return NULL,
collapses the whole CHECK to NULL, and **Postgres accepts the row** — exactly
the row C5 exists to forbid. Do not drop either clause. Do not "simplify" C5.

**The three indexes**

```sql
-- Retention. ArchivalPoller's ORDER BY must match an index or the sweep is
-- unbounded. The sweep arm itself lands in #1009.
CREATE INDEX IF NOT EXISTS idx_refusal_events_archival
  ON refusal_events (occurred_at, id);

-- The owner read and the offboarding purge. account_id LEADS: PG16 has no skip
-- scan and the purge delete filters account-first. Covers account-wide rows
-- (business_id IS NULL) without a second index.
CREATE INDEX IF NOT EXISTS idx_refusal_events_account_window
  ON refusal_events (account_id, occurred_at DESC);

-- Idempotency. Partial, so autonomy_suspended's NULL subject is never
-- deduplicated. #1009's helper re-spells this predicate BYTE-FOR-BYTE in its
-- ON CONFLICT — ON CONFLICT cannot infer a partial index otherwise.
CREATE UNIQUE INDEX IF NOT EXISTS refusal_events_subject_uniq
  ON refusal_events (refusal_source, subject_id)
  WHERE subject_id IS NOT NULL;
```

**Four things this migration deliberately does NOT do:**

- No CHECK over the members of `all_refusal_codes` against
  `AutoApprovalBlockReason`. That enum's owner is TypeScript; a CHECK would
  create a second authority that drifts.
- No CHECK pinning `held_draft` to `unsafe_content`. True today; would make a
  future lane re-map migration-bearing, against #995.
- No `origin` column, now or later. #1002 decided there is never a backfill.
- No FK on `subject_id`, and no `ON DELETE` action on either real FK.

Then run `pnpm test:db:setup` to bring the local container to head 116.

---

### Task 2 — the tenant registries

**Blocking edges:** Task 1 (the live-DB completeness test only sees the table
once the container holds it).
**Turns green:** title 19, plus
`scripts/ci/__tests__/tenant-tables.integration.test.ts` and
`scripts/ci/__tests__/rls-audit.test.ts`, both of which go red once the
container holds an unclassified table.
**Files:** `scripts/ci/tenant-tables.ts`, `docs/security/rls-inventory.md`.

1. Add `refusal_events: ['account_id', 'business_id'],` to `TENANT_TABLES`, on
   `solicitation_batches`' shape at **line 154**.
2. Add the matching ``| `refusal_events` |`` row to
   `docs/security/rls-inventory.md`. `rls-audit.test.ts:42-49` asserts
   `REQUIRED_RLS_TABLES === TENANT_TABLES` and then requires that row for every
   member, so step 1 alone turns it red (D7). The row records the deny-all
   posture and why: `all_refusal_codes` is never owner-facing, and RLS filters
   rows rather than columns, so an owner-readable policy could not withhold it.

**Not in this task:** the `scripts/ci/tenant-scope-allowlist.ts` retention-sweep
exemption. It belongs to the PR that adds the sweep (#1009). Nothing here
queries the table cross-tenant.

---

### Task 3 — the offboarding purge arms

**Blocking edges:** Task 1. Mutually independent of Task 2 (disjoint files).
**Turns green:** titles 20, 21, 22.
**Files:** `src/lib/account-offboarding/table-disposition.ts`,
`src/lib/account-offboarding/purge-verification.ts`,
`worker/jobs/account-offboarding/purge-stages.ts`, and
`worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts` only if its
`sql` mock needs the new statement.

Three changes that must land together.

1. **`table-disposition.ts`** — one row, `hard_delete` / `direct_account_id` /
   `must_be_absent`, on `solicitation_batches`' shape (`:361-366`). The array is
   asserted sorted by the inventory test, so insert it in sorted position. The
   `reason` must exceed 20 characters and state the accurate fact: this table's
   only FKs are to `accounts` and `businesses`, **both** `retain_deidentified`
   and neither cascading, so nothing removes these rows unless the purge deletes
   them explicitly.

   **This row is not optional.** `accountLinkedTablesFromMigrations()` parses
   migration SQL for `account_id … REFERENCES accounts(id)`, so Task 1 alone
   turns the inventory test red.

2. **`purge-verification.ts`** — one `case 'refusal_events':` in
   `verificationQuery`, counting rows `WHERE account_id = $accountId`, on
   `solicitation_batches`' branch (`:620-633`). **Account-scoped, never joined
   through `businesses`** — `autonomy_suspended` rows carry `business_id IS
   NULL` and a business join would miss every one of them. Without the branch,
   `verifyAccountOffboardingPurge` throws
   `missing_purge_verification_sql:refusal_events` for every purge and the
   existing `'reports only tables with remaining verification violations'` test
   goes red.

3. **`purge-stages.ts`** — one `DELETE FROM refusal_events WHERE account_id = …`
   in `runContentPurgeStage`. Same scoping rule and the same reason. Follow the
   surrounding statements' shape and respect the stage's existing lock ordering.

**Do not add a table-existence branch around the `DELETE`.** Defensive handling
of a state the ship ordering excludes is noise that hides real bugs. The
ordering is the mitigation; see step 8.

---

### Task 4 — the record

**Blocking edges:** Tasks 1, 2, 3.
**Turns green:** nothing mechanical. Prevents `main` gaining a table with no
vocabulary and no log entry.
**Files:** `.claude/reference/migrations-log.md`, `CONTEXT.md`,
`docs/adr/0023-refusal-log-owner-safe-projection.md` (new), `docs/directory.md`
(only if `ci:directory-map` demands a row).

1. **`migrations-log.md`** — bump `Current head` to **116**, next is **117**.
   Add the 116 entry in the log's house style; 111's and 114's entries are the
   model. It must carry the **LOCAL-ONLY** marker, and it must state:
   - the deploy-ordering rule and why this slice cannot use #1008's
     merge-then-promote two-step (D6);
   - the promotion procedure — staging first, both projects in lockstep,
     verified by schema introspection, never `list_migrations`;
   - the C5 correction (D4) and why `IS TRUE` plus the NULL-member clause are
     both required.

   Add a **Data retention policy** row: `refusal_events` | `occurred_at` > 180
   days → deleted | *not yet enforced — the `ArchivalPoller` arm lands in
   #1009*. The `new-migration` skill requires a row for a new table; claiming a
   live sweep here would be false.

2. **`CONTEXT.md`** — carry the four LOCKED terms (**Refusal**, **Refusal
   source**, **Refusal category**, **Restraint tab**) from branch
   `feat/refusal-log`, **corrected**. Every correction is load-bearing:
   - **Refusal source** says six lanes. It is **seven** — `policy_gate_held`
     joins them (#1003).
   - **Refusal category** says the closed seven. It is **eight** —
     `owner_review_required` (#998).
   - **Restraint tab** says "adds no migration". It does now; name 116.
   - The **Refusal** term claims the held-draft reason is unrecordable. #1003
     records it in `all_refusal_codes`, server-side and never owner-facing.

   `CONTEXT.md` has no shape guard, but `.claude/CLAUDE.md` does — do not edit
   that file.

3. **`docs/adr/0023-refusal-log-owner-safe-projection.md`** — carry from
   `feat/refusal-log`, corrected for the same facts, and extended with what
   #1001 added: `all_refusal_codes` exists, is never owner-facing, and deny-all
   RLS is what makes that a guarantee rather than a convention, **because RLS
   filters rows, not columns**.

**Why this task is not optional:** the migration's own comments cite ADR 0023
and the closed sets. Citing an ADR absent from `main` is the stale-citation
class this repo has already paid for.

## Verification

`bash scripts/verify-gate.sh`, then `--review` for the last run.
`TEST_DATABASE_POOL_URL` **and** `DATABASE_POOL_URL` must be exported, or the
live-DB suites silently skip and the gate is not review-ready.

`pnpm ci:rls-audit` and `pnpm ci:tenant-scope` are required for DB-touching
changes; the gate runs every `ci:*` script except `fallow`, so neither needs a
`verification_commands` entry.

## Step 8 — the ship order (RISK = high, corrected by D6 and D10)

Two properties must hold at once, and only one order gives both:

- **The migration reaches a database before the code that names it** (D6).
- **No SQL reaches production before CI is green and you have approved it**
  (D10). Revision 2 applied production DDL at step 4, ahead of the PR — that
  put unreviewed, CI-ungated SQL on the production database, and
  `deployment-guide.md` §II.5 opens the PR first for exactly this reason.

No step may be reordered.

1. Open the PR to `main` with `gh pr create --draft`, then `gh pr ready`.
   Draft PRs run no CI, so nothing gates until it is marked ready.
2. Confirm every required check is green. **This is the gate on the SQL**, and
   it is why it comes before any database is touched.
3. Apply 116 to the **staging** Supabase project. Verify by introspection
   (`information_schema.columns`, `pg_constraint`, `pg_indexes`), never
   `list_migrations`.
4. Push the branch to `staging`. The staging worker deploys against a database
   that already holds the table.
5. Smoke the touched path on staging: run an account offboarding purge and
   confirm `verifyAccountOffboardingPurge` reports no `refusal_events` issue.
6. **Pause for owner merge approval.**
7. Apply 116 to the **production** Supabase project. Verify by introspection.
   This is the last step before the code that names the table can run there.
8. Merge. Production deploys against a database that already holds the table.
9. Land the promotion change: remove the LOCAL-ONLY marker from the 116 entry
   and record both promotion lines. This re-arms
   `migration-immutability-guard.sh`.
10. Re-sync `staging` to `main` per `deployment-guide.md`. The PR squash-merges,
    so the branches diverge and `--ff-only` aborts; use
    `git reset --hard origin/main` plus `--force-with-lease`, never a sync merge.

**When #1009 unblocks: at step 7, not at step 8 and not at step 9.** #1009 is
gated on 116 being present in staging and production, which is true the moment
step 7 completes. Step 9 is bookkeeping and gates nothing.

## Not in this PR

The insert helper and `REFUSAL_LEDGER_ENABLED` (#1009). The `ArchivalPoller`
arm and its tenant-scope-allowlist exemption (#1009). All eleven write sites
(#1010–#1013). The **Restraint tab** (#1014). `src/lib/refusals/vocabulary.ts`.
