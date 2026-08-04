# Manual Suppression Paths (#645) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the four human-authored Suppression ledger paths — admin manual entry (§7.3), owner do-not-contact (§7.5), owner clearing of their own account rows (§7.6), and the admin-only audited Correction path (§8.2) — plus the server-side §7.4 read seam #629 consumes.

**Architecture:** The ledger's domain core `src/lib/solicitation/suppression.ts` is **deepened, not widened**: `suppressionMatchSql` gains one column in its projection (`scope`) and the file gains a display seam (`toSuppressionDisplay` + `SUPPRESSION_DISPLAY_COPY`) that returns a **closed four-key object**, so `account_id` and `source` cannot reach an owner surface through it (§7.4's cross-tenant prohibition and FU-3, enforced on the output shape and asserted by an exact-key-set test — see P-8 for what this does and does not prove). Owner paths live in `contacts-repo.ts`, which already owns the "contacts carry no `account_id`; the `businesses` join IS the account-scope check" rule and already writes a sibling ledger table (`solicitation_consent`) inside `deleteContact`'s transaction. Admin cross-tenant reads and the Correction path live in a new `src/lib/admin/suppressions-service.ts`, the `flagged-service.ts` neighbourhood; the correction itself is a single data-modifying CTE, so its atomicity does not depend on a call site remembering a transaction. Migration 098 adds `solicitation_suppression_corrections`, the §8.2 audit sink, because `account_audit_log.account_id` is `NOT NULL REFERENCES accounts(id)` and the rows §8.2 exists to correct carry no account.

**Tech Stack:** Next.js 16 App Router (server components + route handlers), Postgres.js, `zod` v4 strict objects, `fast-check` for the display invariant, Vitest (unit + serialized `integration` project for live-DB suites).

---

## Decisions this plan locks (read before any task)

Labelled **P-n** so they never collide with the spec's own **D1–D9** decision
register — a plan citing "D7" for two different decisions is how a review round
gets spent on a misunderstanding.

| # | Decision | Why |
|---|---|---|
| P-1 | The Correction path audit sink is a **new table**, `solicitation_suppression_corrections`, not `account_audit_log` | `account_audit_log.account_id` is `NOT NULL REFERENCES accounts(id) ON DELETE CASCADE`. A `global`/`admin_manual` row entered from a mailbox reply has `account_id = NULL` (there is no account to attribute), and so does a `provider_suppressed` mirror from the transactional side — the two cases §8.2 names as its reason to exist. A CASCADE would also delete the compliance record with the account |
| P-2 | The correction record carries **no FK anywhere**, and **no `account_id` column at all** | Two independent reasons. (a) The suppression row is gone by the time the record is written — that is the point — so an FK to it is impossible, and an FK to `accounts` would let a purge CASCADE away a compliance record. (b) Copying the deleted row's `account_id` in would create a NEW indefinite retention obligation for provenance whose owning row no longer exists, and would make this table "account-linked" to `accountLinkedTablesFromMigrations()` in `src/lib/account-offboarding/__tests__/table-disposition.test.ts` — which fails CI unless the table also joins `TENANT_TABLES`, `TABLE_DISPOSITIONS` and purge verification. The record says WHICH opt-out, WHO removed it and WHY; whose send originally produced it is not part of that sentence |
| P-3 | `normalized_handle` **stays** on the correction record | `suppression_id` points at a deleted row, so without the handle the record cannot say which opt-out was removed — an audit record that cannot identify its subject is not one. Retention posture matches the `scope='global'` ledger rows it describes: indefinite, minimum-necessary, documented in the migrations-log retention table |
| P-4 | Owner clearing (§7.6) writes to **`account_audit_log`**, NOT to the corrections table | The two acts are deliberately not the same thing (§7.6: "the UI must not present the two controls as the same thing"). An owner clearing their own preference is account-scoped with a non-null `account_id`; an admin removing a recipient's revocation is the compliance act. Separate sinks make the distinction structural |
| P-5 | Owner **marking** writes no audit-log row | Creation is already covered by the `solicitation_suppressed` analytics event `recordSuppression` emits in the same transaction (§9.4). Deletion has no analytics event, which is exactly why it gets the audit row. The asymmetry is the coverage, not an oversight |
| P-6 | Admin routes are **not** flag-gated; owner routes ride `solicitationWatchEnabled()` | A statutory 10-business-day obligation behind a feature flag is a violation waiting for a flag flip. The owner controls live on the already-watch-gated contacts surface, so they inherit its gate |
| P-7 | The Correction path takes **any** suppression row by id, `global` or `account` | One sink, one audit shape, no scope-dependent branching. §7.6 stays a separate owner-scoped route whose SQL predicate can only ever reach `scope='account' AND account_id = <caller's>` |
| P-8 | `toSuppressionDisplay` takes `{ scope }` and returns a closed four-key object | The **output** shape is what forbids leaking: §7.4's cross-tenant prohibition and FU-3 hold because `account_id` and `source` cannot appear in the result, and a test asserts the exact key set. The narrow **input** type documents intent but does NOT make passing extra fields impossible — TypeScript structural typing accepts a wider object in that position. Do not restate this as "structurally cannot be passed"; that overclaim was corrected in plan review round 1 |
| P-9 | `correctSuppression` is **one SQL statement** — a data-modifying CTE, not a delete-then-insert pair | Statement-level atomicity means the delete and the audit record cannot separate even if the caller forgets a transaction. The delete-plus-insert version was only atomic if every call site remembered `sql.begin`, and no test that supplies its own transaction can prove a production call site did |
| P-10 | No new analytics event name for the correction | It would require extending the `analytics_events` `CHECK` enum; the corrections table is already the durable record, and an admin-only rare action does not need a second one |

**Glossary terms used verbatim throughout** (from `CONTEXT.md` → "Solicitation suppression & unsubscribe"): Suppression ledger · Suppression scope · Normalized handle · Correction path · Attestation never overrides suppression · Consent ledger.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `supabase/migrations/098_solicitation_suppression_corrections.sql` | The §8.2 audit sink table, RLS deny-all | T2 |
| `.claude/reference/migrations-log.md` | Head bump 097→098, migration entry, retention-policy row | T2 |
| `src/lib/shared/__tests__/helpers/schema-ready.ts` | `MIGRATION_098_SUPPRESSION_CORRECTIONS` requirement | T2 |
| `src/lib/shared/__tests__/migration-098-suppression-corrections.integration.test.ts` | Migration shape suite (columns, CHECKs, RLS deny-all) | T2 |
| `src/lib/solicitation/suppression.ts` | `scope` in the `suppressionMatchSql` projection; `SuppressionDisplay`, `SUPPRESSION_DISPLAY_COPY`, `toSuppressionDisplay` | T3 |
| `src/lib/solicitation/__tests__/suppression-display.test.ts` | Display-seam unit + `fast-check` invariant | T3 |
| `src/lib/admin/suppressions-service.ts` | Admin lookup, admin manual entry, `correctSuppression` | T4 |
| `src/app/api/admin/suppressions/route.ts` | `GET` lookup + `POST` manual entry, AAL2-gated | T4 |
| `src/app/api/admin/suppressions/correct/route.ts` | `POST` Correction path, AAL2-gated | T4 |
| `scripts/ci/tenant-scope-allowlist.ts` | Allowlist entries for the admin cross-tenant reads | T4 |
| `src/lib/solicitation/contacts-repo.ts` | `suppression` on `ContactListItem`; `markContactDoNotContact`; `clearContactDoNotContact` | T5 |
| `src/app/api/dashboard/contacts/[id]/suppression/route.ts` | Owner `POST` mark + `DELETE` clear | T5 |
| `src/app/admin/suppressions/page.tsx` + `SuppressionsClient.tsx` | Admin console surface | T6 |
| `src/components/admin/nav-config.ts` | One nav entry under **Safety** | T6 |
| `src/app/(authenticated)/dashboard/requests/contacts/ContactList.tsx` | §7.4 state + owner controls | T7 |
| `docs/runbooks/channels-rollout.md` · `docs/directory.md` · `CONTEXT.md` | §7.2 servicing contract; inventory; glossary | T8 |

**Dependency graph:** T1 → {T2, T3} → {T4, T5} → {T6, T7} → T8.
**Mutually independent (parallel-dispatchable):** (T2, T3), then (T4, T5), then (T6, T7).

---

### Task 1: Eval task — the eighteen promised tests, failing

**Files:**
- Create: `src/lib/solicitation/__tests__/suppression-display.test.ts`
- Create: `src/lib/admin/__tests__/suppressions-service.test.ts`
- Create: `src/lib/admin/__tests__/suppressions-correction.integration.test.ts`
- Create: `src/app/api/admin/suppressions/__tests__/route.test.ts`
- Create: `src/app/api/dashboard/contacts/__tests__/suppression-route.test.ts`
- Create: `src/lib/solicitation/__tests__/contacts-do-not-contact.integration.test.ts`

Every title below is a **verbatim** entry in `.feature/intake.json` → `tests_to_add`; the gate's `promised-tests` row matches them as exact strings. Do not reword, re-case, or re-punctuate them.

**These must genuinely FAIL, not merely be pending.** `it.todo` satisfies the
gate's `promised-tests` row (it matches titles as strings) while asserting
nothing — so a plan that stops at `it.todo` has an eval task that cannot fail,
which is the one thing an eval task must be able to do. Write each test with a
real body that imports the symbol it needs. Every file below therefore fails at
import time until its task lands, which is the correct red. Use `it.todo` ONLY
for a test whose live-DB fixture does not exist yet, and name which task
un-todos it in a trailing comment.

- [ ] **Step 1: Write all eighteen with real bodies, distributed by owning module**

Each file imports the symbol its task will create, so the whole file is red at
import time until then. Write the bodies as they appear in the owning task
(T3 §Step 1, T4 §Steps 4–6, T5 §Steps 4–5) — this step is where they are
authored, and those tasks then make them pass without editing the assertions.

| File | Titles it owns | Body authored from |
|---|---|---|
| `src/lib/solicitation/__tests__/suppression-display.test.ts` | reports a suppressed contact as opted out… · never exposes the account_id provenance… · distinguishes the owner's own account row… · global wins the display state… · invariant: every scope and source pair… | T3 Step 1 (verbatim) |
| `src/lib/admin/__tests__/suppressions-service.test.ts` | records a global admin_manual row… · rejects an address that fails normalizeEmail… | T4 Step 4 |
| `src/lib/admin/__tests__/suppressions-correction.integration.test.ts` | is idempotent against the global partial unique index… · deletes the suppression row and writes the correction record… · rolls back the delete… · corrects a global row whose account_id is NULL · reports not-found instead of writing an orphan… | T4 Step 5 |
| `src/app/api/admin/suppressions/__tests__/route.test.ts` | requires admin AAL2 on every suppression admin route | T4 Step 6 |
| `src/app/api/dashboard/contacts/__tests__/suppression-route.test.ts` | returns a uniform 404 for a contact belonging to another account · refuses to clear a global row through the owner path | T5 Step 5 |
| `src/lib/solicitation/__tests__/contacts-do-not-contact.integration.test.ts` | writes an owner_manual account-scoped row… · refuses an owner do-not-contact on a contact with no email handle · clears only the account row owned by the caller's account… | T5 Step 4 |

Shape, using the display file as the worked example — note the import of a
symbol that does not exist yet, which is what makes the file red:

```typescript
// src/lib/solicitation/__tests__/suppression-display.test.ts
import { describe, expect, it } from 'vitest';
import { toSuppressionDisplay } from '../suppression'; // does not exist until T3

describe('suppression display seam (§7.4)', () => {
  it('reports a suppressed contact as opted out of RepWorth review requests, never as skipped', () => {
    const display = toSuppressionDisplay({ scope: 'global' });
    expect(display?.label).toBe('Opted out of RepWorth review requests');
    expect(JSON.stringify(display).toLowerCase()).not.toContain('skipped');
  });
  // … the remaining four, verbatim from T3 Step 1
});
```

The two live-DB files need a seeded tenant before their bodies can run. Author
them fully anyway and let them fail on the missing import; if a fixture genuinely
cannot exist until its task, mark that ONE test `it.todo` with a trailing
`// un-todo in T4 Step 5` comment rather than leaving the whole file pending.

- [ ] **Step 2: Run all SIX files and confirm they are RED**

```bash
pnpm vitest run \
  src/lib/solicitation/__tests__/suppression-display.test.ts \
  src/lib/solicitation/__tests__/contacts-do-not-contact.integration.test.ts \
  src/lib/admin/__tests__/suppressions-service.test.ts \
  src/lib/admin/__tests__/suppressions-correction.integration.test.ts \
  src/app/api/admin/suppressions/__tests__/route.test.ts \
  src/app/api/dashboard/contacts/__tests__/suppression-route.test.ts
```

Expected: FAIL — unresolved imports (`toSuppressionDisplay`,
`correctSuppression`, `markContactDoNotContact`, the route modules). A run that
passes green means the tests assert nothing. Note the earlier version of this
step listed only four files while claiming to confirm all eighteen titles; all
six are required.

- [ ] **Step 3: Verify the gate can see all eighteen titles**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths && bash scripts/verify-gate.sh 2>&1 | tail -20`
Expected: the `promised-tests` row is **PASS** — all eighteen titles found. The
`test` row is expected **FAIL** at this checkpoint and that is the point of the
eval task; do not patch it, and do not claim a green gate until T8. Any red row
that is neither `test` nor a downstream consequence of it is pre-existing and
must be reported.

- [ ] **Step 4: Commit**

```bash
git add src/lib/solicitation/__tests__ src/lib/admin/__tests__ src/app/api/admin/suppressions/__tests__ src/app/api/dashboard/contacts/__tests__
git commit -m "test(#645): eval task — eighteen promised tests as failing specs"
```

---

### Task 2: Migration 098 — the Correction path audit sink

**Blocking edges:** T1.
**Turns green:** none yet (its own shape suite; the correction tests land in T4).

**Files:**
- Create: `supabase/migrations/098_solicitation_suppression_corrections.sql`
- Modify: `.claude/reference/migrations-log.md` (head line, migration entry, retention-policy table)
- Modify: `src/lib/shared/__tests__/helpers/schema-ready.ts`
- Create: `src/lib/shared/__tests__/migration-098-suppression-corrections.integration.test.ts`

**Read first:** `.claude/reference/migrations-log.md` (head must read **097**; yours is 098) and `supabase/migrations/096_solicitation_suppressions.sql` for the header style this file mirrors.

- [ ] **Step 1: Write the migration**

```sql
-- 098_solicitation_suppression_corrections.sql
-- The Correction path's audit sink (#645; locked spec
-- docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md §8.2).
--
-- WHY A NEW TABLE RATHER THAN account_audit_log. §8.2's posture is
-- writeAccountAuditLog's — an audit record in the SAME transaction as the
-- delete — but not its table: account_audit_log.account_id is
-- NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, and the rows §8.2 exists
-- to correct carry no account. An `admin_manual` global row entered from a
-- forwarded mailbox reply has no account to attribute (the §7.3 input is an
-- address and a note), and a `provider_suppressed` mirror originating on the
-- transactional side (§3.3) has none either. Those are two of the three cases
-- §8.2 names. A CASCADE would additionally delete the compliance record along
-- with the account it merely names as provenance.
--
-- NO FOREIGN KEYS anywhere, deliberately: `suppression_id`'s referent is
-- DELETEd by the very statement that writes this row (that is the whole point),
-- and `removed_by_user_id` follows 096's `created_by_user_id` posture — a plain
-- UUID, because a compliance record must outlive the user row it names.
--
-- NO `account_id` COLUMN AT ALL, and that is a decision rather than an
-- omission (plan P-2). Copying the deleted row's provenance in would create a
-- fresh indefinite retention obligation for data whose owning row no longer
-- exists, and would make this table account-linked to
-- accountLinkedTablesFromMigrations() in
-- src/lib/account-offboarding/__tests__/table-disposition.test.ts — which then
-- requires entries in TENANT_TABLES, TABLE_DISPOSITIONS and purge verification
-- for a record that has no tenant. The sentence this table exists to record is
-- "WHICH opt-out was removed, by WHOM, and WHY"; whose send originally produced
-- the suppression is not part of it.
--
-- RLS deny-all with ZERO policies — the auto_approval_policies posture
-- (invariant #14), matching 096. Not decorative: a row here names a recipient's
-- Normalized handle, so a direct client read would expose that an identified
-- person's opt-out was removed.
--
-- The record is immutable: no updated_at, no soft-delete column. A correction
-- that was itself wrong is a new suppression row via §7.3, not an edit here.
--
-- Rollback: revert the app deploy FIRST (the admin routes are the only
-- writers), then DROP TABLE. Safe while empty; drops only correction history
-- when not. Nothing in the ledger, the batch build or the offboarding purge
-- reads this table.

CREATE TABLE IF NOT EXISTS solicitation_suppression_corrections (
  id UUID PRIMARY KEY,                 -- UUIDv7 supplied by the app (repo convention, no DB default)
  suppression_id UUID NOT NULL,        -- the removed row's id; NO FK (referent is gone by design)
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  normalized_handle TEXT NOT NULL,     -- what was removed; raw, matching §6.4's posture on the ledger
  scope TEXT NOT NULL CHECK (scope IN ('global', 'account')),
  source TEXT NOT NULL CHECK (source IN (
    'unsubscribe_link',
    'unsubscribe_one_click',
    'bounce_permanent',
    'complaint',
    'provider_suppressed',
    'admin_manual',
    'owner_manual'
  )),
  suppressed_at TIMESTAMPTZ NOT NULL,  -- when the REMOVED row was recorded, copied from it
  removed_by_user_id UUID NOT NULL,    -- the admin; plain UUID, NO FK (096's created_by_user_id posture)
  reason TEXT NOT NULL CHECK (length(btrim(reason)) > 0),  -- "why" is not optional on this path
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The admin lookup shows prior corrections for a handle alongside its live
-- rows, so a re-entry after a correction is visible rather than a surprise.
-- Handle-leading because that is the only way this table is ever queried.
CREATE INDEX IF NOT EXISTS idx_solicitation_suppression_corrections_handle
  ON solicitation_suppression_corrections (channel, normalized_handle, created_at DESC);

ALTER TABLE solicitation_suppression_corrections ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: deny-all.

COMMENT ON TABLE solicitation_suppression_corrections IS
  'Correction path audit records (#645, spec §8.2): error correction, NEVER re-subscribe. One row per admin-removed suppression, written in the same transaction as the DELETE.';
```

- [ ] **Step 2: Bump the head and add the log entries**

In `.claude/reference/migrations-log.md`: change the head line to `Current head: **098** — next migration is **099**`, add a `**098**` entry mirroring 096's prose (what it does, why no FKs, why not `account_audit_log`, rollback), and add a retention-policy row:

| Table | Retention | Enforced by |
|---|---|---|
| `solicitation_suppression_corrections` | **No TTL.** The record proves an opt-out was removed and by whom; deleting it would erase the only evidence that the removal was audited. Retains `normalized_handle` indefinitely — the minimum needed to identify WHICH opt-out was removed, since `suppression_id` points at a deleted row — matching the retention posture of the `scope='global'` ledger rows it describes (spec D7). It carries **no** `account_id` (plan P-2), so it is not account-linked and correctly absent from `TABLE_DISPOSITIONS` | No poller touches it; the offboarding purge deliberately does not list it, and `table-disposition.test.ts` confirms that is correct rather than an omission because the table has no account-linked column |

- [ ] **Step 3: Add the schema requirement**

```typescript
// src/lib/shared/__tests__/helpers/schema-ready.ts — append after MIGRATION_096_SOLICITATION_SUPPRESSIONS

/**
 * 098 creates the Correction path's audit sink. The handle-leading index is the
 * migration's last object before the RLS switch, so its presence implies the
 * whole file ran.
 */
export const MIGRATION_098_SUPPRESSION_CORRECTIONS: SchemaRequirement = {
  migration: '098_solicitation_suppression_corrections',
  tables: ['solicitation_suppression_corrections'],
  indexes: ['idx_solicitation_suppression_corrections_handle'],
};
```

- [ ] **Step 4: Write the migration shape suite**

Mirror `src/lib/shared/__tests__/migration-096-solicitation-suppressions.integration.test.ts` exactly — `describeWithDb`, `acquireLiveDbLock` in `beforeAll` with `LIVE_DB_LOCK_HOOK_TIMEOUT_MS`, `assertLocalTestDatabaseUrl`, `assertSchemaReady([MIGRATION_098_SUPPRESSION_CORRECTIONS])`, and **no migration SQL applied** (#573). Assert behaviourally, not by existence:

Six tests. Introspect the real schema — asserting a constraint merely *exists*
proves nothing, because a malformed predicate is present and wrong (096's own
first revision shipped that defect):

```typescript
it('has exactly the correction audit columns with the locked types nullability and defaults', async () => {
  const columns = await db<{ column_name: string; data_type: string; is_nullable: string;
                             column_default: string | null }[]>`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = 'solicitation_suppression_corrections'
    ORDER BY column_name`;
  expect(columns.map((c) => c.column_name)).toEqual([
    'channel', 'created_at', 'id', 'normalized_handle', 'reason',
    'removed_by_user_id', 'scope', 'source', 'suppressed_at', 'suppression_id',
  ]);
  // Every column is NOT NULL: this record has no optional facts.
  expect(columns.filter((c) => c.is_nullable === 'YES')).toEqual([]);
  // id has NO database default — UUIDv7 is app-supplied (repo convention).
  expect(columns.find((c) => c.column_name === 'id')?.column_default).toBeNull();
});

it('has no account-linked column, so the offboarding inventory correctly excludes it', async () => {
  // P-2 asserted against the schema rather than the plan: if a later change
  // adds account_id/business_id here, table-disposition.test.ts starts failing
  // and THIS test says why before anyone goes looking.
  const columns = await db<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'solicitation_suppression_corrections'`;
  expect(columns.map((c) => c.column_name)).not.toContain('account_id');
  expect(columns.map((c) => c.column_name)).not.toContain('business_id');
});

it('enforces the authoritative suppression channel scope and source value sets', async () => {
  // Drive from the exported enums so a divergence between TS and the DB fails
  // here rather than at the first production insert of a new source.
  for (const source of SUPPRESSION_SOURCES) {
    // every legal source inserts
  }
  for (const scope of SUPPRESSION_SCOPES) {
    // every legal scope inserts
  }
  // and rejects: channel 'sms', scope 'everyone', source 'unsubscribed'
});

it('has no foreign keys to suppressions accounts or users so correction history survives its referents', async () => {
  const fks = await db`
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'solicitation_suppression_corrections'::regclass AND contype = 'f'`;
  expect(fks).toEqual([]);
});

it('indexes corrections by channel normalized handle and created_at descending', async () => {
  const [index] = await db<{ indexdef: string }[]>`
    SELECT indexdef FROM pg_indexes
    WHERE indexname = 'idx_solicitation_suppression_corrections_handle'`;
  expect(index?.indexdef).toMatch(/\(channel, normalized_handle, created_at DESC\)/);
});

it('rejects every empty-or-whitespace reason and accepts a nonblank reason', async () => {
  for (const blank of ['', ' ', '\t', '\n', '   ']) {
    await expect(insertCorrection({ reason: blank })).rejects.toThrow(/check constraint/i);
  }
  await expect(insertCorrection({ reason: 'admin typo on a mailbox reply' })).resolves.toBeDefined();
});

it('is deny-all: RLS is enabled with zero policies', async () => {
  const [rls] = await db<{ relrowsecurity: boolean }[]>`
    SELECT relrowsecurity FROM pg_class WHERE relname = 'solicitation_suppression_corrections'`;
  expect(rls?.relrowsecurity).toBe(true);
  const policies = await db`
    SELECT policyname FROM pg_policies WHERE tablename = 'solicitation_suppression_corrections'`;
  expect(policies).toHaveLength(0);
});
```

`insertCorrection` is a local helper in this file taking overrides over a valid
row. Clean up every inserted row in `afterAll` — no `seedTenantAccount` needed,
this table has no FKs and no tenant.

- [ ] **Step 5: Provision the DB and run the suite**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths
pnpm test:db:setup
pnpm vitest run src/lib/shared/__tests__/migration-098-suppression-corrections.integration.test.ts
```
Expected: PASS. A failure naming a missing relation means `test:db:setup` did not pick up 098 — re-run it, do not apply the SQL from the test (#573).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/098_solicitation_suppression_corrections.sql .claude/reference/migrations-log.md src/lib/shared/__tests__
git commit -m "feat(#645): migration 098 — Correction path audit sink"
```

---

### Task 3: The §7.4 display seam

**Blocking edges:** T1.
**Turns green:** "reports a suppressed contact as opted out of RepWorth review requests, never as skipped" · "never exposes the account_id provenance of a global row to an owner" · "distinguishes the owner's own account row from a global one, because only the former is reversible" · "global wins the display state when both a global and an account row match" · "invariant: every scope and source pair maps to exactly one display state and never carries account_id"

**Files:**
- Modify: `src/lib/solicitation/suppression.ts`
- Modify: `src/lib/solicitation/__tests__/suppression-display.test.ts`

- [ ] **Step 1: Replace the `it.todo`s with real failing tests**

```typescript
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  SUPPRESSION_DISPLAY_COPY,
  SUPPRESSION_SCOPES,
  SUPPRESSION_SOURCES,
  toSuppressionDisplay,
} from '../suppression';

describe('suppression display seam (§7.4)', () => {
  it('reports a suppressed contact as opted out of RepWorth review requests, never as skipped', () => {
    const display = toSuppressionDisplay({ scope: 'global' });
    expect(display?.label).toBe('Opted out of RepWorth review requests');
    expect(JSON.stringify(display).toLowerCase()).not.toContain('skipped');
  });

  it('never exposes the account_id provenance of a global row to an owner', () => {
    // The input type has no account_id field; this asserts the runtime shape
    // too, so a later widening of the parameter cannot leak through the mapper.
    const display = toSuppressionDisplay({ scope: 'global' });
    expect(Object.keys(display ?? {}).sort()).toEqual(
      ['clearableByOwner', 'detail', 'label', 'state'],
    );
  });

  it('distinguishes the owner\'s own account row from a global one, because only the former is reversible', () => {
    expect(toSuppressionDisplay({ scope: 'account' })?.clearableByOwner).toBe(true);
    expect(toSuppressionDisplay({ scope: 'global' })?.clearableByOwner).toBe(false);
    expect(toSuppressionDisplay({ scope: 'account' })?.label)
      .not.toBe(toSuppressionDisplay({ scope: 'global' })?.label);
  });

  it('global wins the display state when both a global and an account row match', () => {
    // G3 is enforced in SQL by suppressionMatchSql's ORDER BY, which returns at
    // most one row; the mapper's contract is that it faithfully renders
    // whichever row the fragment picked. This asserts the seam does not
    // second-guess it, and the live-DB proof of the ORDER BY itself lives in
    // suppression.integration.test.ts.
    expect(toSuppressionDisplay({ scope: 'global' })?.state).toBe('global');
  });

  it('returns null for a contact with no match', () => {
    expect(toSuppressionDisplay(null)).toBeNull();
    expect(toSuppressionDisplay(undefined)).toBeNull();
  });

  it('throws on a scope outside the closed enum rather than defaulting', () => {
    expect(() => toSuppressionDisplay({ scope: 'everyone' })).toThrow(/everyone/);
  });
});

describe('invariants', () => {
  it('invariant: every scope and source pair maps to exactly one display state and never carries account_id', () => {
    // What this proves is OUTPUT CLOSURE, not input impossibility (P-8): a
    // caller CAN hand this mapper a whole ledger row — TypeScript accepts a
    // wider object where `{ scope: string }` is expected — so the guarantee
    // that matters is that nothing beyond the four display keys survives the
    // mapping. Generate only LEGAL (scope, source) pairs: the G11 DB CHECK
    // makes the illegal ones unreachable, and asserting behaviour on rows the
    // database cannot hold tests nothing.
    fc.assert(
      fc.property(
        fc.constantFrom(...SUPPRESSION_SCOPES),
        fc.uuid(),
        (scope, accountId) => {
          const source = scope === 'account' ? 'owner_manual' : 'complaint';
          const wholeRow = { scope, source, accountId, note: 'internal note' };
          const display = toSuppressionDisplay(wholeRow as { scope: string });
          expect(display).not.toBeNull();
          expect(Object.keys(display!).sort())
            .toEqual(['clearableByOwner', 'detail', 'label', 'state']);
          expect(display?.state).toBe(scope);
          expect(display?.clearableByOwner).toBe(scope === 'account');
          const serialized = JSON.stringify(display);
          expect(serialized).not.toContain(accountId);
          expect(serialized).not.toContain(source);
          expect(serialized).not.toContain('internal note');
          expect(display?.label).toBe(SUPPRESSION_DISPLAY_COPY[scope].label);
        },
      ),
    );
  });
});
```

- [ ] **Step 1b: Add the two SQL-projection tests to the EXISTING ledger suite**

The mapper tests above hand-build their input, so SQL could return the wrong
`scope` and every one of them would still pass. These close that gap and belong
next to the existing global-wins test in
`src/lib/solicitation/__tests__/suppression.integration.test.ts` (which today
selects only `source`):

```typescript
it('suppressionMatchSql projects scope global when global and account rows both match', async () => {
  // seed BOTH rows for one handle, probe through the fragment in a LATERAL:
  //   SELECT hit.scope, hit.source FROM (…) probe
  //   LEFT JOIN LATERAL (${suppressionMatchSql(db, db`probe.handle`, accountId, 'email')}) hit ON TRUE
  // assert scope 'global' — G3 proven on the projection, not just the ordering
});

it('suppressionMatchSql projects account scope only for the matching account', async () => {
  // one owner_manual row for account A; probe as A → { scope: 'account',
  // source: 'owner_manual' }; probe as B → both columns NULL
});
```

- [ ] **Step 2: Run and confirm the failure is "not exported"**

Run: `pnpm vitest run src/lib/solicitation/__tests__/suppression-display.test.ts`
Expected: FAIL — `toSuppressionDisplay is not a function` / no export named `SUPPRESSION_DISPLAY_COPY`.

- [ ] **Step 3: Add `scope` to the fragment's projection**

In `src/lib/solicitation/suppression.ts`, change the `SELECT` inside `suppressionMatchSql` and extend its doc comment:

```typescript
  return db`
    SELECT s.scope, s.source, s.suppressed_at
    FROM solicitation_suppressions s
```

Append to the function's doc block:

```
 * Returns `scope` as well as `source` because §7.4 requires an owner surface to
 * distinguish their own reversible account row from a global one. Deriving it
 * caller-side from `source === 'owner_manual'` would be correct today only
 * because the G11 DB CHECK makes the mapping total — a second account-scoped
 * source would silently mislabel every row. One owner for the scope dimension,
 * same argument as the channel parameter above. The existing consumer
 * (batch-builder's LATERAL) names its columns explicitly, so this is additive.
```

- [ ] **Step 4: Add the display seam below `suppressionMatchSql`**

```typescript
/**
 * §7.4's display contract, enforced on the OUTPUT shape.
 *
 * The returned object has exactly four keys, and that closure is the
 * guarantee: a global row's `account_id` provenance cannot reach an owner
 * surface through this seam (§7.4, invariant #8), and neither can `source`, so
 * FU-3 (bounce vs complaint vs unsubscribe is NOT owner-visible) holds by
 * construction. The ledger row carries both; this function is where they stop.
 *
 * The narrow `{ scope }` parameter states intent but does NOT prevent a caller
 * passing a whole row — TypeScript accepts a wider object in that position. The
 * output closure is what is actually load-bearing, and the exact-key-set test
 * is what proves it.
 *
 * Two consumers today: the contacts list (#645) and the Requests surface
 * (#629, spec §11 hands §7.4's rendering there). Both feed it a row picked by
 * `suppressionMatchSql`, so G3's global-wins ordering is already applied.
 */
export type SuppressionDisplayState = SuppressionScope;

export interface SuppressionDisplay {
  state: SuppressionDisplayState;
  label: string;
  detail: string;
  /** §7.6: only an account row is the owner's to reverse. */
  clearableByOwner: boolean;
}

/**
 * Owner-facing copy. "Opted out" and never "skipped" — #622 §6.3 requires the
 * global effect be stated honestly, and "skipped" reads as a scheduling
 * accident rather than a person's decision. The global copy deliberately does
 * not say WHO they opted out from: naming another business is the cross-tenant
 * leak §7.4 forbids.
 */
export const SUPPRESSION_DISPLAY_COPY = {
  global: {
    label: 'Opted out of RepWorth review requests',
    detail: 'This person opted out of review requests. We will not contact them.',
  },
  account: {
    label: 'You marked this contact do-not-contact',
    detail: 'You asked us not to send this contact review requests. You can undo this.',
  },
} as const satisfies Record<SuppressionDisplayState, { label: string; detail: string }>;

export function toSuppressionDisplay(
  match: { scope: string } | null | undefined,
): SuppressionDisplay | null {
  if (match == null) return null;
  // Assert the impossible state rather than defaulting to one of the two: the
  // DB CHECK makes any other value unreachable, so reaching it means the row
  // did not come from this ledger and silently rendering it as "global" would
  // claim an opt-out nobody made.
  if (match.scope !== 'global' && match.scope !== 'account') {
    throw new Error(`toSuppressionDisplay: unknown suppression scope ${match.scope}`);
  }
  return {
    state: match.scope,
    ...SUPPRESSION_DISPLAY_COPY[match.scope],
    clearableByOwner: match.scope === 'account',
  };
}
```

- [ ] **Step 5: Run the display suite and the existing ledger suites**

```bash
pnpm vitest run src/lib/solicitation/__tests__/suppression-display.test.ts src/lib/solicitation/__tests__/suppression.test.ts src/lib/solicitation/__tests__/batch-builder.test.ts
```
Expected: PASS. `batch-builder` must stay green — it names its columns, so the extra projected column is inert there.

- [ ] **Step 6: Commit**

```bash
git add src/lib/solicitation/suppression.ts src/lib/solicitation/__tests__/suppression-display.test.ts
git commit -m "feat(#645): §7.4 display seam — scope in the lookup projection, copy constants, mapper"
```

---

### Task 4: Admin manual entry, lookup, and the Correction path

**Blocking edges:** T1, T2.
**Turns green:** "records a global admin_manual row with created_by_user_id and the required note" · "rejects an address that fails normalizeEmail instead of minting a wrong handle" · "is idempotent against the global partial unique index — a repeat admin entry writes no second row" · "deletes the suppression row and writes the correction record in the same transaction" · "rolls back the delete when the correction record write fails" · "corrects a global row whose account_id is NULL" · "reports not-found instead of writing an orphan correction record when the row is already gone" · "requires admin AAL2 on every suppression admin route"

**Files:**
- Create: `src/lib/admin/suppressions-service.ts`
- Create: `src/app/api/admin/suppressions/route.ts`
- Create: `src/app/api/admin/suppressions/correct/route.ts`
- Modify: `scripts/ci/tenant-scope-allowlist.ts`
- Modify: the three test files from T1 that own these titles

**Precedents to mirror, in order:** `src/app/api/admin/autonomy/unsuspend/route.ts` (the whole mutation shape: `requireAdminWithAal2` → `z.strictObject` → `sql.begin(tx => domainFn(tx, …))` → mapped result → `withSameOrigin()` export), `src/app/api/admin/flagged/route.ts` (the AAL2-gated GET and its `src/lib/admin/*-service.ts` delegation), `src/lib/admin/flagged-service.ts` (service shape).

- [ ] **Step 1: Write the service**

```typescript
// src/lib/admin/suppressions-service.ts
import type { Sql, TransactionSql } from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { normalizeEmail } from '@/lib/solicitation/handles';
import {
  recordSuppression,
  type SuppressionScope,
  type SuppressionSource,
} from '@/lib/solicitation/suppression';

/**
 * The admin-owned Suppression ledger paths (#645; locked spec
 * docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md §7.3,
 * §8.2). Cross-tenant by design and admin-only by authorization: G14 notes that
 * `recordSuppression`'s `createdByUserId` is a plain string the type cannot
 * prove is an admin — THIS module's callers own that proof, and they are the
 * two `requireAdminWithAal2` routes in src/app/api/admin/suppressions.
 *
 * The Correction path is error correction, NEVER re-subscribe: it has no owner
 * entry point, no recipient entry point, and no self-serve surface anywhere.
 */

export interface AdminSuppressionRow {
  id: string;
  channel: string;
  normalizedHandle: string;
  scope: SuppressionScope;
  source: SuppressionSource;
  accountId: string | null;
  accountName: string | null;
  createdByUserId: string | null;
  note: string | null;
  suppressedAt: string;
}

export interface AdminSuppressionCorrectionRow {
  id: string;
  suppressionId: string;
  scope: SuppressionScope;
  source: SuppressionSource;
  removedByUserId: string;
  reason: string;
  createdAt: string;
}

export type LookupSuppressionsResult =
  | {
      ok: true;
      handle: string;
      rows: AdminSuppressionRow[];
      corrections: AdminSuppressionCorrectionRow[];
    }
  | { ok: false; error: 'invalid_handle' };

/**
 * Every live ledger row for one Normalized handle, plus the Correction path
 * records for it, so a re-entry after a correction is visible rather than a
 * surprise. Admin-only: the rows name accounts across every tenant.
 */
export async function lookupSuppressions(
  sql: Sql,
  rawEmail: string,
): Promise<LookupSuppressionsResult> {
  const handle = normalizeEmail(rawEmail);
  if (handle === null) return { ok: false, error: 'invalid_handle' };

  const [rows, corrections] = await Promise.all([
    sql<{
      id: string;
      channel: string;
      normalized_handle: string;
      scope: SuppressionScope;
      source: SuppressionSource;
      account_id: string | null;
      account_name: string | null;
      created_by_user_id: string | null;
      note: string | null;
      suppressed_at: string;
    }[]>`
      SELECT s.id, s.channel, s.normalized_handle, s.scope, s.source,
             s.account_id, a.display_name AS account_name,
             s.created_by_user_id, s.note, s.suppressed_at::text
      FROM solicitation_suppressions s
      LEFT JOIN accounts a ON a.id = s.account_id
      WHERE s.channel = 'email' AND s.normalized_handle = ${handle}
      ORDER BY (s.scope = 'global') DESC, s.suppressed_at ASC
    `,
    sql<{
      id: string;
      suppression_id: string;
      scope: SuppressionScope;
      source: SuppressionSource;
      removed_by_user_id: string;
      reason: string;
      created_at: string;
    }[]>`
      SELECT id, suppression_id, scope, source, removed_by_user_id, reason,
             created_at::text
      FROM solicitation_suppression_corrections
      WHERE channel = 'email' AND normalized_handle = ${handle}
      ORDER BY created_at DESC
      LIMIT 20
    `,
  ]);

  return {
    ok: true,
    handle,
    rows: rows.map((row) => ({
      id: row.id,
      channel: row.channel,
      normalizedHandle: row.normalized_handle,
      scope: row.scope,
      source: row.source,
      accountId: row.account_id,
      accountName: row.account_name,
      createdByUserId: row.created_by_user_id,
      note: row.note,
      suppressedAt: row.suppressed_at,
    })),
    corrections: corrections.map((row) => ({
      id: row.id,
      suppressionId: row.suppression_id,
      scope: row.scope,
      source: row.source,
      removedByUserId: row.removed_by_user_id,
      reason: row.reason,
      createdAt: row.created_at,
    })),
  };
}

export type RecordAdminManualResult =
  | { ok: true; created: boolean; handle: string }
  | { ok: false; error: 'invalid_handle' };

/**
 * §7.3. Takes RAW input — this is the only suppression path that does, because
 * every other one reads an already-normalized handle off a stored row — and
 * REJECTS an address that fails normalization rather than minting a wrong
 * handle (the handles.ts posture). `created` is false when an existing global
 * row won the first-write-wins race (§2.1): a no-op success, not an error.
 *
 * `accountId` is deliberately null: a mailbox reply names no account, and
 * guessing one would write false provenance into a compliance record.
 */
export async function recordAdminManualSuppression(
  tx: TransactionSql,
  input: { rawEmail: string; adminUserId: string; note: string },
): Promise<RecordAdminManualResult> {
  const handle = normalizeEmail(input.rawEmail);
  if (handle === null) return { ok: false, error: 'invalid_handle' };

  const id = await recordSuppression(tx, {
    scope: 'global',
    channel: 'email',
    normalizedHandle: handle,
    accountId: null,
    source: 'admin_manual',
    createdByUserId: input.adminUserId,
    note: input.note,
  });

  return { ok: true, created: id !== null, handle };
}

export type CorrectSuppressionResult = 'corrected' | 'not_found';

/**
 * §8.2, as ONE statement (P-9). The data-modifying CTE makes atomicity
 * structural: an INSERT failure — a blank reason hitting the CHECK, a type
 * violation, anything — aborts the whole statement, so the DELETE cannot commit
 * without its audit record even if a call site forgot a transaction. The
 * delete-then-insert version was atomic only if every caller remembered
 * `sql.begin`, and no test that supplies its own transaction can prove a
 * production call site did.
 *
 * The record is built from the DELETE's RETURNING, never from a row read
 * earlier, so a concurrent correction cannot produce a record describing a row
 * this call did not remove: exactly one caller's DELETE matches, the other
 * returns zero rows and writes nothing.
 *
 * Takes `Sql | TransactionSql` because it no longer needs an outer transaction
 * to be correct — it composes into one if a caller has one, and is safe alone.
 */
export async function correctSuppression(
  db: Sql | TransactionSql,
  input: { suppressionId: string; adminUserId: string; reason: string },
): Promise<CorrectSuppressionResult> {
  const written = await db<{ suppression_id: string }[]>`
    WITH removed AS (
      DELETE FROM solicitation_suppressions
      WHERE id = ${input.suppressionId}::uuid
      RETURNING id, channel, normalized_handle, scope, source, suppressed_at
    )
    INSERT INTO solicitation_suppression_corrections
      (id, suppression_id, channel, normalized_handle, scope, source,
       suppressed_at, removed_by_user_id, reason)
    SELECT ${uuidv7()}, removed.id, removed.channel, removed.normalized_handle,
           removed.scope, removed.source, removed.suppressed_at,
           ${input.adminUserId}::uuid, ${input.reason}
    FROM removed
    RETURNING suppression_id
  `;

  // Zero rows means the DELETE matched nothing: no row removed, no orphan
  // record written. There is no third outcome.
  return written.length === 0 ? 'not_found' : 'corrected';
}
```

- [ ] **Step 2: Write the routes**

```typescript
// src/app/api/admin/suppressions/route.ts
// GET  — look up every Suppression ledger row for one address (§7.3 servicing).
// POST — admin manual entry (§7.3).
// Route orchestrates only: AAL2 gate, body parse, one service call, mapped
// result. Deliberately NOT flag-gated (D-5): a statutory obligation behind a
// feature flag is a violation waiting for a flag flip.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { internalError, requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import {
  lookupSuppressions,
  recordAdminManualSuppression,
} from '@/lib/admin/suppressions-service';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Same sensitivity as /admin/flagged's GET: the rows name recipients and the
  // accounts that mailed them across every tenant.
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  const email = request.nextUrl.searchParams.get('email') ?? '';
  const result = await lookupSuppressions(sql, email);
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  return NextResponse.json(result, { headers: NO_STORE_HEADERS });
}

const EntrySchema = z.strictObject({
  email: z.string().trim().min(1).max(320),
  // Required, per §7.3: the originating message reference is what makes the
  // entry auditable ten business days later.
  note: z.string().trim().min(1).max(1_000),
});

async function recordEntry(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_body' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const parsed = EntrySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid_request' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const result = await sql.begin((tx) => recordAdminManualSuppression(tx, {
      rawEmail: parsed.data.email,
      adminUserId: gate.admin.id,
      note: parsed.data.note,
    }));
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json(
      { created: result.created, handle: result.handle },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    return internalError('[api/admin/suppressions] entry failed:', error);
  }
}

export const POST = withSameOrigin()(recordEntry);
```

```typescript
// src/app/api/admin/suppressions/correct/route.ts
// POST — the Correction path (§8.2): admin-only, audited removal of a
// factually-wrong suppression row. Error correction, NEVER re-subscribe.
// A separate route from the entry surface so the two acts never share a
// handler, a schema, or a copy string.

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { internalError, requireAdminWithAal2 } from '@/lib/auth/admin-mfa-gate';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { sql } from '@/lib/db/server';
import { correctSuppression } from '@/lib/admin/suppressions-service';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

const CorrectSchema = z.strictObject({
  suppressionId: z.uuid(),
  // "Why" is not optional on this path — it is the audit record's whole point.
  reason: z.string().trim().min(1).max(1_000),
});

async function correct(request: NextRequest): Promise<NextResponse> {
  const gate = await requireAdminWithAal2(request);
  if (!gate.ok) return gate.response;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid_body' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
  const parsed = CorrectSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid_request' },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }

  try {
    // No sql.begin: correctSuppression is a single statement (P-9), so the
    // transaction would add a moving part without adding a guarantee. The
    // actor id comes from the AAL2 gate, never from the body — EntrySchema and
    // CorrectSchema are strictObject precisely so a client-supplied actor
    // field is a 400 rather than a silently ignored key.
    const result = await correctSuppression(sql, {
      suppressionId: parsed.data.suppressionId,
      adminUserId: gate.admin.id,
      reason: parsed.data.reason,
    });
    if (result === 'not_found') {
      return NextResponse.json(
        { error: 'not_found' },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }
    // §9.5: the suppression row id is the correlation key. Never the handle.
    logger.info('suppression corrected', { suppressionId: parsed.data.suppressionId });
    return NextResponse.json({ corrected: true }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return internalError(
      `[api/admin/suppressions/correct] failed for ${parsed.data.suppressionId}:`,
      error,
    );
  }
}

export const POST = withSameOrigin()(correct);
```

`NO_STORE_HEADERS` **is** exported from `@/lib/shared/constants` (verified in plan review round 1) — use it, no fallback. For `logger`, use whatever the neighbouring admin routes use for structured logging; if they log nothing, put the suppression id in the `internalError` prefix only (as above) and skip the success line rather than introducing a new logging pattern for one route.

- [ ] **Step 3: Add the tenant-scope allowlist entries**

**Do not guess the count.** The audit keys entries by exact `file + table + SQL
statement` (`scripts/ci/tenant-scope-audit.ts`), so the number depends on how
many statements it flags — the lookup's two reads hit `solicitation_suppressions`
and `accounts`, and the correction CTE hits `solicitation_suppressions` again as
one statement. `solicitation_suppression_corrections` needs an entry only if it
is in `TENANT_TABLES`, which it is not (P-2: no account-linked column).

Procedure: run `pnpm ci:tenant-scope`, add exactly the entries it names
(category `'admin-after-require-role'`), then set `ALLOWLIST_BASELINE` to the
real entry count — the audit fails on a mismatch in either direction, so a
wrong guess fails loudly rather than shipping. Reason text for each:
`#645 §7.3/§8.2 admin suppression servicing — cross-tenant by design behind requireAdminWithAal2; a handle-keyed compliance record has no tenant to scope to.`

> **Known conflict:** the `admin-console-phase3` worktree also appends here and bumps the same baseline. Append-only, so resolve by re-appending after rebase — never by reverting the other branch's entries or reusing its baseline number.

- [ ] **Step 4: Replace the service `it.todo`s with real tests**

`src/lib/admin/__tests__/suppressions-service.test.ts` — unit, no DB. Mirror the fake-`sql` style of the neighbouring `src/lib/admin/flagged-service.test.ts`; the two titles here only need `normalizeEmail` behaviour and the `recordSuppression` call shape:

```typescript
it('records a global admin_manual row with created_by_user_id and the required note', async () => {
  // assert the recordSuppression input: scope 'global', source 'admin_manual',
  // accountId null, note passed through, handle lowercased/trimmed
});

it('rejects an address that fails normalizeEmail instead of minting a wrong handle', async () => {
  const result = await recordAdminManualSuppression(fakeTx, {
    rawEmail: 'not an email', adminUserId: randomUUID(), note: 'ref #1',
  });
  expect(result).toEqual({ ok: false, error: 'invalid_handle' });
  // and: no INSERT was attempted
});

it('lookupSuppressions rejects an invalid email without issuing either cross-tenant query', () => {
  // fake sql that throws if called at all; assert { ok: false, error: 'invalid_handle' }
});
```

- [ ] **Step 5: Replace the correction `it.todo`s with a live-DB suite**

`src/lib/admin/__tests__/suppressions-correction.integration.test.ts` — mirror `src/lib/solicitation/__tests__/suppression.integration.test.ts`'s harness exactly (`describeWithDb`, `acquireLiveDbLock`, `assertSchemaReady([MIGRATION_096_SOLICITATION_SUPPRESSIONS, MIGRATION_098_SUPPRESSION_CORRECTIONS])`, `seedTenantAccount`/`cleanupTenantAccount`, no migration SQL). The five titles:

```typescript
it('is idempotent against the global partial unique index — a repeat admin entry writes no second row', async () => {
  const first = await db.begin((tx) => recordAdminManualSuppression(tx, {
    rawEmail: ' Person@Example.COM ', adminUserId, note: 'mailbox ref 1',
  }));
  const second = await db.begin((tx) => recordAdminManualSuppression(tx, {
    rawEmail: 'person@example.com', adminUserId, note: 'mailbox ref 2',
  }));
  expect(first).toEqual({ ok: true, created: true, handle: 'person@example.com' });
  expect(second).toEqual({ ok: true, created: false, handle: 'person@example.com' });
  const rows = await db`SELECT id, note FROM solicitation_suppressions
                        WHERE channel = 'email' AND normalized_handle = 'person@example.com'`;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.note).toBe('mailbox ref 1'); // first write wins, §2.1
});

it('deletes the suppression row and writes the correction record in the same transaction', async () => {
  // seed a row, correct it, assert: ledger row gone, exactly one correction row
  // carrying its id, scope, source, suppressed_at, reason and removed_by_user_id
});

it('rolls back the delete when the correction record write fails', async () => {
  // Call correctSuppression on the POOLED client with NO outer transaction —
  // that is the whole point (P-9). A blank reason violates the CHECK, the
  // single statement aborts, and the ledger row must survive. Supplying our
  // own db.begin here would prove nothing about production, which does not
  // open one.
  await expect(
    correctSuppression(db, { suppressionId, adminUserId, reason: '   ' }),
  ).rejects.toThrow(/check constraint/i);
  const still = await db`SELECT id FROM solicitation_suppressions WHERE id = ${suppressionId}`;
  expect(still).toHaveLength(1);
  const orphans = await db`SELECT id FROM solicitation_suppression_corrections
                           WHERE suppression_id = ${suppressionId}`;
  expect(orphans).toHaveLength(0);
});

it('corrects a global row whose account_id is NULL', async () => {
  // the §8.2 case account_audit_log structurally cannot hold — seed with
  // accountId: null via recordAdminManualSuppression, then correct it
});

it('reports not-found instead of writing an orphan correction record when the row is already gone', async () => {
  const result = await correctSuppression(db, {
    suppressionId: randomUUID(), adminUserId, reason: 'already removed',
  });
  expect(result).toBe('not_found');
  const corrections = await db`SELECT id FROM solicitation_suppression_corrections
                               WHERE removed_by_user_id = ${adminUserId}`;
  expect(corrections).toHaveLength(0);
});

it('two concurrent corrections remove one suppression and write exactly one correction record', async () => {
  // Promise.all two correctSuppression calls on the same id. Assert: one
  // 'corrected' and one 'not_found', the suppression is gone, and exactly one
  // correction record exists. The single statement is what makes this safe —
  // there is no read-then-write window to lose.
});

it('admin manual entry writes a global row when only an account-scoped row already exists', async () => {
  // seed an owner_manual account row for the handle, then run the admin entry:
  // created === true, and BOTH rows now exist. Different partial unique
  // indexes; the global writer must still infer its own.
});

it('admin manual no-op preserves the first global row source actor note and account provenance', async () => {
  // seed a 'complaint' global row with account provenance, then run admin
  // entry for the same handle: created === false and NOT ONE column changed —
  // source stays 'complaint', account_id stays set, note stays null.
  // §2.1 first-write-wins across SOURCES, not just repeated admin entries.
});

it('admin manual entry persists the authenticated admin actor required note global scope and null account provenance', async () => {
  // inspect every persisted column on the live row, not just the call args
});

it('lookupSuppressions normalizes raw email and returns every matching live row global first with the account display name', async () => {
  // seed a global row (account provenance → display_name resolves) and an
  // account row for a second account; look up with ' Person@Example.COM '
  // and assert order (global first) and account_name resolution.
  // This is the test that would have caught accounts.business_name.
});

it('lookupSuppressions returns only corrections for the normalized handle newest first and capped at twenty', async () => {
  // seed 21 correction records across two handles; assert filtering, ordering
  // and the LIMIT 20
});
```

- [ ] **Step 6: Replace the route `it.todo` with the AAL2 test**

`src/app/api/admin/suppressions/__tests__/route.test.ts` — mirror the mocking style of `src/app/api/admin/autonomy/__tests__/`. One test covering all three handlers:

```typescript
it('requires admin AAL2 on every suppression admin route', async () => {
  // requireAdminWithAal2 mocked to return { ok: false, response: 401 }
  // assert GET, POST (entry) and POST (correct) each return that response and
  // that neither service function was called
});

it('uses the authenticated admin id for entry and correction and rejects client-supplied actor fields', async () => {
  // POST both routes with an extra body key (adminUserId / removedByUserId /
  // createdByUserId set to some other uuid). strictObject must 400 on the
  // unknown key, and on a VALID body the service must receive gate.admin.id —
  // otherwise the audit record can name an arbitrary user.
});

it('rejects blank entry notes blank correction reasons malformed suppression ids and unknown fields before any write', async () => {
  // table-driven: note '', note '   ', reason '', reason '  ', suppressionId
  // 'not-a-uuid', an unknown key. Each → 400, and the service is never called.
});

it('enforces same-origin on both admin suppression mutations', async () => {
  // a cross-origin POST to each mutation is rejected by the withSameOrigin()
  // wrapper — a mocked-AAL2 test alone never exercises the exported wrapper
});
```

- [ ] **Step 7: Run everything this task touches**

```bash
pnpm vitest run src/lib/admin/__tests__/suppressions-service.test.ts src/app/api/admin/suppressions/__tests__/route.test.ts
pnpm vitest run src/lib/admin/__tests__/suppressions-correction.integration.test.ts
pnpm ci:tenant-scope && pnpm ci:rls-audit
```
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/admin src/app/api/admin/suppressions scripts/ci/tenant-scope-allowlist.ts
git commit -m "feat(#645): admin manual entry, lookup, and the audited Correction path"
```

---

### Task 5: Owner do-not-contact and clearing

**Blocking edges:** T1, T3.
**Turns green:** "writes an owner_manual account-scoped row for the caller's own account" · "refuses an owner do-not-contact on a contact with no email handle" · "clears only the account row owned by the caller's account, leaving a matching global row in place" · "returns a uniform 404 for a contact belonging to another account" · "refuses to clear a global row through the owner path"

**Files:**
- Modify: `src/lib/solicitation/contacts-repo.ts`
- Create: `src/app/api/dashboard/contacts/[id]/suppression/route.ts`
- Modify: `src/lib/solicitation/__tests__/contacts-do-not-contact.integration.test.ts`, `src/app/api/dashboard/contacts/__tests__/suppression-route.test.ts`
- Modify: `src/lib/solicitation/__tests__/contacts-repo.integration.test.ts` (the `listContacts` shape gains a field)

**Precedent to mirror:** `src/app/api/dashboard/contacts/[id]/route.ts` — `requireContactsWriteAccess` + `resolveContactsScopedId` + `withSameOrigin()`, flag gate inherited from `requireContactsWriteAccess`. Confirm by reading it before writing the new route; if the flag gate is NOT inside that helper, add `if (!solicitationWatchEnabled()) return errorResponse('Not found', 404);` as the first line, matching `src/app/api/dashboard/contacts/route.ts`.

- [ ] **Step 1: Add the suppression join to `listContacts`**

```typescript
// src/lib/solicitation/contacts-repo.ts — imports
import { suppressionMatchSql, toSuppressionDisplay, type SuppressionDisplay } from './suppression';

export interface ContactListItem {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  lastVisitDate: string;
  visitCount: number;
  /** §7.4 display state, or null when this contact is contactable. */
  suppression: SuppressionDisplay | null;
}
```

In the page query, add the LATERAL join (the `batch-builder.ts:446` precedent — composing `suppressionMatchSql` is how this join and the dispatch gate stay ONE predicate, G7) and project `scope`:

```sql
      SELECT c.id, c.name, c.email, c.phone,
             MAX(v.visit_date)::text AS last_visit_date,
             COUNT(v.id)::int AS visit_count,
             suppression.scope AS suppression_scope
      FROM solicitation_contacts c
      JOIN solicitation_visits v ON v.contact_id = c.id AND v.business_id = ${businessId}
      JOIN businesses b ON b.id = c.business_id
      -- suppressionMatchSql is the ONE owner of the §1.2 lookup (G7). c.email
      -- already holds the Normalized handle (normalized at CSV parse), so
      -- nothing is re-normalized here; a phone-only contact has a NULL email
      -- and simply matches no row.
      LEFT JOIN LATERAL (
        ${suppressionMatchSql(sql, sql`c.email`, accountId, 'email')}
      ) suppression ON TRUE
      WHERE c.business_id = ${businessId} AND b.account_id = ${accountId}
      GROUP BY c.id, suppression.scope
      ORDER BY MAX(v.visit_date) DESC, c.id
      LIMIT ${limit} OFFSET ${offset}
```

Map it: `suppression: toSuppressionDisplay(row.suppression_scope === null ? null : { scope: row.suppression_scope })`.

- [ ] **Step 2: Add the two owner operations**

```typescript
export type MarkDoNotContactResult =
  | 'marked'
  | 'already_marked'
  | 'not_found'
  | 'no_email_handle';

/**
 * §7.5. The owner is the liable sender under CAN-SPAM even when we send on
 * their behalf, so they get a mechanism to stop mail going out under their own
 * name. Writes `scope='account'` — global would let one owner silently degrade
 * every other tenant's reach with no recipient having spoken (§1.2).
 *
 * Keyed on the Normalized handle, never the contact row id: delete-and-
 * re-upload must not launder it (#535 §6).
 */
export async function markContactDoNotContact(
  sql: Sql,
  input: { accountId: string; businessId: string; contactId: string; actorUserId: string },
): Promise<MarkDoNotContactResult> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ email: string | null }[]>`
      SELECT c.email
      FROM solicitation_contacts c
      JOIN businesses b ON b.id = c.business_id
      WHERE c.id = ${input.contactId}
        AND c.business_id = ${input.businessId}
        AND b.account_id = ${input.accountId}
    `;
    const row = rows[0];
    if (row === undefined) return 'not_found';
    if (row.email === null) return 'no_email_handle';

    const id = await recordSuppression(tx, {
      scope: 'account',
      channel: 'email',
      normalizedHandle: row.email,
      accountId: input.accountId,
      source: 'owner_manual',
      createdByUserId: input.actorUserId,
    });
    return id === null ? 'already_marked' : 'marked';
  });
}

export type ClearDoNotContactResult =
  | 'cleared'
  | 'not_marked'
  | 'not_found'
  | 'no_email_handle';

/**
 * §7.6. An owner may remove a row THEY created — their own preference about
 * their own customer, no recipient ever spoke. The `scope = 'account' AND
 * account_id = <caller's>` predicate is what makes "an owner may never clear a
 * global row" unreachable rather than merely unimplemented: there is no input
 * to this function that reaches one. This is emphatically NOT re-subscribe
 * (§8.1), and the Correction path (§8.2) is a different act with a different
 * sink.
 *
 * The audit row is here and not on the marking path because creation already
 * emits the §9.4 `solicitation_suppressed` analytics event inside
 * recordSuppression's transaction, and deletion emits nothing.
 */
export async function clearContactDoNotContact(
  sql: Sql,
  input: { accountId: string; businessId: string; contactId: string; actorUserId: string },
): Promise<ClearDoNotContactResult> {
  return sql.begin(async (tx) => {
    const rows = await tx<{ email: string | null }[]>`
      SELECT c.email
      FROM solicitation_contacts c
      JOIN businesses b ON b.id = c.business_id
      WHERE c.id = ${input.contactId}
        AND c.business_id = ${input.businessId}
        AND b.account_id = ${input.accountId}
    `;
    const row = rows[0];
    if (row === undefined) return 'not_found';
    if (row.email === null) return 'no_email_handle';

    const deleted = await tx<{ id: string }[]>`
      DELETE FROM solicitation_suppressions
      WHERE channel = 'email'
        AND normalized_handle = ${row.email}
        AND scope = 'account'
        AND account_id = ${input.accountId}::uuid
      RETURNING id
    `;
    const removed = deleted[0];
    if (removed === undefined) return 'not_marked';

    await writeAccountAuditLog(tx, {
      accountId: input.accountId,
      locationId: input.businessId,
      actorUserId: input.actorUserId,
      eventType: 'solicitation_do_not_contact_cleared',
      entityType: 'solicitation_suppression',
      entityId: removed.id,
      // NEVER the Normalized handle (§9.5) — the entity id is the correlation key.
      payload: { channel: 'email', scope: 'account' },
    });

    return 'cleared';
  });
}
```

Add the import: `import { writeAccountAuditLog } from '@/lib/audit/log';` and extend `recordSuppression` to the existing `./suppression` import.

- [ ] **Step 3: Write the owner route**

```typescript
// src/app/api/dashboard/contacts/[id]/suppression/route.ts
// POST   — §7.5 owner do-not-contact on one contact.
// DELETE — §7.6 clear a do-not-contact THIS account created. An owner may never
//          clear a global row: the repo predicate cannot reach one.
// Route orchestrates only; mirrors the sibling DELETE /api/dashboard/contacts/[id].

import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { errorResponse, jsonResponse, withSameOrigin } from '@/lib/auth/route-helpers';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import {
  clearContactDoNotContact,
  markContactDoNotContact,
} from '@/lib/solicitation/contacts-repo';
import {
  requireContactsWriteAccess,
  resolveContactsScopedId,
} from '../../location-scope';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

async function mark(request: NextRequest, { params }: Params): Promise<NextResponse> {
  const owner = await requireContactsWriteAccess(sql, request);
  if (!owner.ok) return owner.response;
  const { user, accountId } = owner;

  try {
    const scoped = await resolveContactsScopedId(sql, request, {
      accountId, userLocationId: user.locationId,
    }, params);
    if (!scoped.ok) return scoped.response;

    const result = await markContactDoNotContact(sql, {
      accountId, businessId: scoped.locationId, contactId: scoped.id, actorUserId: user.id,
    });
    // A foreign contact and a missing one are the same 404 — the sibling
    // delete route's uniform-not-found posture.
    if (result === 'not_found') return errorResponse('Not found', 404);
    if (result === 'no_email_handle') {
      return errorResponse('This contact has no email address to suppress', 409);
    }
    return jsonResponse({ state: 'marked', alreadyMarked: result === 'already_marked' });
  } catch (error) {
    reportCaughtError('api/dashboard/contacts/[id]/suppression', error, { accountId });
    return errorResponse('Failed to update contact', 500);
  }
}

async function clear(request: NextRequest, { params }: Params): Promise<NextResponse> {
  const owner = await requireContactsWriteAccess(sql, request);
  if (!owner.ok) return owner.response;
  const { user, accountId } = owner;

  try {
    const scoped = await resolveContactsScopedId(sql, request, {
      accountId, userLocationId: user.locationId,
    }, params);
    if (!scoped.ok) return scoped.response;

    const result = await clearContactDoNotContact(sql, {
      accountId, businessId: scoped.locationId, contactId: scoped.id, actorUserId: user.id,
    });
    if (result === 'not_found') return errorResponse('Not found', 404);
    if (result === 'no_email_handle') {
      return errorResponse('This contact has no email address to suppress', 409);
    }
    // 'not_marked' covers "never marked" AND "suppressed globally, not by you":
    // both mean this account has no row to clear, and distinguishing them here
    // would tell the owner nothing they may act on.
    if (result === 'not_marked') return errorResponse('No do-not-contact to clear', 409);
    return jsonResponse({ state: 'cleared' });
  } catch (error) {
    reportCaughtError('api/dashboard/contacts/[id]/suppression', error, { accountId });
    return errorResponse('Failed to update contact', 500);
  }
}

export const POST = withSameOrigin()(mark);
export const DELETE = withSameOrigin()(clear);
```

- [ ] **Step 4: Write the live-DB owner suite**

`src/lib/solicitation/__tests__/contacts-do-not-contact.integration.test.ts`, harness mirroring `contacts-repo.integration.test.ts`:

```typescript
it('writes an owner_manual account-scoped row for the caller\'s own account', async () => {
  const result = await markContactDoNotContact(db, { accountId, businessId, contactId, actorUserId });
  expect(result).toBe('marked');
  const [row] = await db`SELECT scope, source, account_id, created_by_user_id
                         FROM solicitation_suppressions
                         WHERE normalized_handle = ${contactEmail}`;
  expect(row).toMatchObject({ scope: 'account', source: 'owner_manual', account_id: accountId });
});

it('refuses an owner do-not-contact on a contact with no email handle', async () => {
  // seed a phone-only contact
  expect(await markContactDoNotContact(db, { ...input, contactId: phoneOnlyId }))
    .toBe('no_email_handle');
  const rows = await db`SELECT id FROM solicitation_suppressions WHERE account_id = ${accountId}`;
  expect(rows).toHaveLength(0);
});

it('clears only the account row owned by the caller\'s account, leaving a matching global row in place', async () => {
  // seed BOTH: a global row for the same handle (source 'complaint') and this
  // account's owner_manual row. Clear, then assert the global row survives and
  // listContacts still reports the contact as suppressed.
  await db.begin((tx) => recordSuppression(tx, {
    scope: 'global', channel: 'email', normalizedHandle: contactEmail,
    accountId: null, source: 'complaint',
  }));
  await markContactDoNotContact(db, input);
  expect(await clearContactDoNotContact(db, input)).toBe('cleared');
  const remaining = await db`SELECT scope FROM solicitation_suppressions
                             WHERE normalized_handle = ${contactEmail}`;
  expect(remaining).toEqual([{ scope: 'global' }]);
  const { contacts } = await listContacts(db, accountId, businessId, { limit: 50, offset: 0 });
  expect(contacts.find((c) => c.id === contactId)?.suppression?.state).toBe('global');
});

it('repeating owner do-not-contact is a no-op against the account partial unique index', async () => {
  // second call → 'already_marked', still exactly one row. Proves the owner
  // wrapper actually reaches recordSuppression's ON CONFLICT path.
});

it('attributes owner do-not-contact to the authenticated owner user', async () => {
  // assert created_by_user_id === actorUserId on the persisted row
});

it('a foreign account can neither mark nor clear another account contact', async () => {
  // call BOTH repo functions with account B's id against account A's contact:
  // both return 'not_found', and no suppression or audit row changed anywhere
});

it('clearing one account row leaves the global row and every other account row untouched', async () => {
  // seed: global row + account A row + account B row, all one handle.
  // A clears → A's row gone, global and B's row both still present.
});

it('a global-only suppression returns not_marked and writes no owner-clear audit row', async () => {
  // The REAL SQL proof that an owner cannot clear a global row — the route
  // test only mocks this outcome. Assert the global row survives and
  // account_audit_log gained nothing.
});

it('owner clear writes the exact audit actor account location entity and payload without the normalized handle', async () => {
  const [entry] = await db`
    SELECT account_id, location_id, actor_user_id, event_type,
           entity_type, entity_id, payload
    FROM account_audit_log
    WHERE entity_id = ${suppressionId}`;
  expect(entry).toMatchObject({
    account_id: accountId, location_id: businessId, actor_user_id: actorUserId,
    event_type: 'solicitation_do_not_contact_cleared',
    entity_type: 'solicitation_suppression',
  });
  expect(JSON.stringify(entry?.payload)).not.toContain(contactEmail); // §9.5
});

it('owner clear rolls back the suppression delete when the audit insert fails', async () => {
  // The owner-side lost-opt-out path. Pass an actorUserId that does not exist
  // in users so account_audit_log.actor_user_id's FK rejects; assert the
  // transaction rejects AND the owner_manual row is still present. Failing
  // safe here means KEEPING the suppression.
});

it('deleting and re-uploading the same handle does not clear its suppression', async () => {
  // §8.1 + #535 §6, end to end: mark do-not-contact, deleteContact, re-ingest
  // the same normalized email as a new contact row, then assert listContacts
  // STILL reports it suppressed. This is the laundering path the handle keying
  // exists to close, and nothing else in the suite covers it.
});

it('listContacts ignores an account suppression owned by another account for the same handle', async () => {
  // account B marks the handle; account A's listContacts must show account A's
  // contact as NOT suppressed. Invariant #8, proven through the real query.
});

it('listContacts returns only the suppression display shape and never source or account provenance', async () => {
  // serialize the listContacts result and assert it contains no 'account_id',
  // 'accountId', 'accountName', 'source', 'note', nor any actor uuid — the
  // component test cannot catch the API shipping provenance to the browser
});
```

- [ ] **Step 5: Write the owner route suite**

`src/app/api/dashboard/contacts/__tests__/suppression-route.test.ts`, mirroring the mocking style of the existing contacts route tests:

```typescript
it('returns a uniform 404 for a contact belonging to another account', async () => {
  // repo mocked to return 'not_found'; assert 404 and that the body carries no
  // hint that the contact exists elsewhere
});

it('refuses to clear a global row through the owner path', async () => {
  // repo mocked to return 'not_marked' (the shape a global-only match produces);
  // assert 409 and that the response never says the contact was un-suppressed
});

it('enforces same-origin on both owner suppression mutations', async () => {
  // cross-origin POST and DELETE are rejected by the withSameOrigin() wrappers
});

it('derives account business contact and actor ids only from authenticated scope and route params', async () => {
  // POST/DELETE with accountId, businessId and actorUserId in the BODY set to
  // other tenants' ids; assert the repo receives the authenticated values and
  // never the body's
});

it('returns the feature-disabled 404 before attempting owner authentication', async () => {
  // solicitationWatchEnabled() false → 404 and the auth helper is never called
  // (invariant #13 ordering: flag gate first)
});
```

- [ ] **Step 6: Run**

```bash
pnpm vitest run src/lib/solicitation/__tests__/contacts-do-not-contact.integration.test.ts src/lib/solicitation/__tests__/contacts-repo.integration.test.ts
pnpm vitest run src/app/api/dashboard/contacts/__tests__/
```
Expected: PASS. `contacts-repo.integration.test.ts` may need its `listContacts` assertions updated for the new `suppression` field — update them, do not weaken them.

- [ ] **Step 7: Commit**

```bash
git add src/lib/solicitation src/app/api/dashboard/contacts
git commit -m "feat(#645): owner do-not-contact and account-scoped clearing"
```

---

### Task 6: Admin console surface

**Blocking edges:** T4.
**Turns green:** none directly — it is the §7.2 servicing entry point the runbook in T8 points at.

**Files:**
- Create: `src/app/admin/suppressions/page.tsx`
- Create: `src/app/admin/suppressions/SuppressionsClient.tsx`
- Create: `src/app/admin/suppressions/__tests__/SuppressionsClient.test.tsx`
- Modify: `src/components/admin/nav-config.ts`
- Modify: `src/components/admin/__tests__/AdminSidebar.test.tsx` (if it asserts the item list)

**Invoke the `repworth-brand-design` skill before writing any JSX.** Mirror `src/app/admin/flagged/page.tsx` (server-first, `requireAdminPage(sql, { from: '/admin/suppressions', aal2: true })`) and build the client on the Phase 2 primitives in `src/components/admin/ui/` (`AdminPage`, `DataTable`, `EmptyState`, `ErrorState`, `StatusBadge`). Do **not** modify `DataTable.tsx` — the `admin-console-phase3` worktree owns it right now; if it lacks something you need, render a plain table in this client instead and say so in the deviations file.

- [ ] **Step 1: Add the nav entry**

```typescript
  {
    label: 'Safety',
    items: [
      { href: '/admin/flagged', label: 'Flagged', badge: 'flaggedOpen' },
      { href: '/admin/autonomy', label: 'Autonomy' },
      { href: '/admin/suppressions', label: 'Suppressions' },
      { href: '/admin/security', label: 'Security' },
    ],
  },
```

- [ ] **Step 2: The page**

```tsx
import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { SuppressionsClient } from './SuppressionsClient';

export const dynamic = 'force-dynamic';

export default async function AdminSuppressionsPage() {
  // The rows name recipients and the accounts that mailed them across every
  // tenant — same sensitivity as /admin/flagged, same unconditional AAL2 gate.
  await requireAdminPage(sql, { from: '/admin/suppressions', aal2: true });
  // Lookup-first by design: there is no "all suppressions" list. The servicing
  // ritual (§7.2) starts from an address in a forwarded mailbox reply, and a
  // browsable dump of every opted-out recipient is a liability with no use.
  return <SuppressionsClient />;
}
```

- [ ] **Step 3: The client**

Three regions, in this order:

1. **Look up an address** — one input, `GET /api/admin/suppressions?email=…`. Renders live rows (scope, source, when, note, the account name when the row carries one) and, below them, prior Correction path records for the same handle. `invalid_handle` renders as "That is not a valid email address" — never as "not found".
2. **Enter a manual opt-out (§7.3)** — email + a **required** note field labelled `Originating message reference` with helper text `Where this opt-out came from — the reply's subject, date, or message id. Required: this is the audit trail.` `POST /api/admin/suppressions`. `created: false` renders as "Already suppressed — no change" (a success, not an error).
3. **Correction path (§8.2)** — per-row, behind a confirm step, with a **required** reason textarea. `POST /api/admin/suppressions/correct`.

Copy rules that are not negotiable, because they are the whole point of §8.2's framing:
- The action is labelled **"Correct this record"**, never "Unsuppress", "Re-subscribe", "Restore", or "Undo".
- The confirm step reads: **"Error correction only. This removes a suppression that was recorded in error — it is not a re-subscribe, and it does not give anyone permission to contact this person again."**
- The reason field is labelled **"Why is this record wrong?"** and the submit button stays disabled while it is empty.

- [ ] **Step 4: Test the client**

`src/app/admin/suppressions/__tests__/SuppressionsClient.test.tsx` — mirror `src/app/admin/flagged/__tests__/FlaggedClient.test.tsx`:

```typescript
it('never offers a re-subscribe affordance on the correction control', () => {
  // render with one global row; assert the visible text matches /correct/i and
  // matches none of /re-?subscribe|unsuppress|restore|opt.?back.?in/i
});
it('keeps the correction submit disabled until a reason is entered', () => { /* … */ });
it('reports an already-suppressed entry as a no-op success, not an error', () => { /* … */ });
it('submits the selected suppression id and trimmed reason to the correction endpoint only after confirmation', () => {
  // assert NOTHING is posted before the confirm step, then the exact body
});
it('keeps the live suppression visible when correction fails', () => {
  // a 500 must not optimistically drop the row from the table — an admin
  // believing an opt-out was removed when it was not is the inverse hazard
});
it('manual entry posts the email and required originating message reference to the entry endpoint', () => { /* … */ });
```

Also add `src/app/admin/suppressions/__tests__/page.test.tsx`:

```typescript
it('requires an admin AAL2 page gate before rendering the suppressions console', () => {
  // requireAdminPage mocked; assert it is called with { from:
  // '/admin/suppressions', aal2: true } and that no service call happens when
  // the gate rejects
});
```

- [ ] **Step 5: Run**

```bash
pnpm vitest run src/app/admin/suppressions src/components/admin/__tests__/AdminSidebar.test.tsx
pnpm build
```
Expected: PASS, and a clean build (SURFACE includes ui, so the gate builds too).

- [ ] **Step 6: Commit**

```bash
git add src/app/admin/suppressions src/components/admin
git commit -m "feat(#645): admin suppressions console — lookup, manual entry, correction"
```

---

### Task 7: Owner contacts surface

**Blocking edges:** T5.
**Turns green:** the §7.4 titles are already green from T3; this renders them.

**Files:**
- Modify: `src/app/(authenticated)/dashboard/requests/contacts/ContactList.tsx`
- Modify: `src/app/(authenticated)/dashboard/requests/contacts/__tests__/contacts-ui.test.tsx`

**Invoke the `repworth-brand-design` skill before writing any JSX.**

- [ ] **Step 1: Render the state and the controls**

Per contact row, when `contact.suppression` is non-null, render `contact.suppression.label` as a badge and `detail` as its title/tooltip. The action beneath the row:
- `suppression === null` → **"Don't contact"** → `POST /api/dashboard/contacts/<id>/suppression`, behind the same confirm-step pattern the existing delete control uses.
- `suppression.clearableByOwner === true` → **"Allow requests again"** → `DELETE …/suppression`.
- `suppression.clearableByOwner === false` → **no control at all.** Not a disabled button, not a tooltip explaining why — §7.6 requires the two controls not be presented as the same thing, and a greyed-out clear button presents them as the same thing with one unavailable.

Refresh via the existing `onRefresh` epoch bump after either action.

- [ ] **Step 2: Test**

```typescript
it('shows an opted-out contact as opted out and offers no way to undo a global row', () => {
  // suppression: { state: 'global', clearableByOwner: false, … }
  // assert the label renders and no control matching /allow|undo|clear/i exists
});
it('offers the owner a way to undo their own do-not-contact', () => { /* clearableByOwner: true */ });
it('never renders another account name on a suppressed contact', () => { /* §7.4 */ });
it('marking do-not-contact posts to the suppression endpoint and never hard-deletes the contact', () => {
  // wiring the mark button to DELETE /api/dashboard/contacts/<id> would erase
  // a customer record instead of suppressing a handle — assert the exact URL
  // and method, and that the delete endpoint is never called
});
it('clearing owner do-not-contact deletes the suppression endpoint and never deletes the contact endpoint', () => { /* same hazard, mirrored */ });
it('a failed suppression mutation does not refresh into an apparently successful state', () => {
  // a rejected POST must surface the error and leave the row unchanged rather
  // than bumping the epoch and re-rendering as if it worked
});
```

- [ ] **Step 3: Run**

```bash
pnpm vitest run "src/app/(authenticated)/dashboard/requests/contacts"
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add "src/app/(authenticated)/dashboard/requests/contacts"
git commit -m "feat(#645): owner contacts surface — §7.4 state and the do-not-contact controls"
```

---

### Task 8: The §7.2 servicing contract and doc sweep

**Blocking edges:** T4, T5, T6.

**Files:**
- Modify: `docs/runbooks/channels-rollout.md`
- Modify: `docs/directory.md`
- Modify: `CONTEXT.md`

- [ ] **Step 1: Write the servicing contract into the channels runbook**

A new section, **"Unsubscribe mailbox servicing (spec §7.2)"**, stating verbatim the locked contract: a **daily business-day check** of the mailbox forwarded from `unsubscribe@feedback.repworth.net`; every opt-out entered through `/admin/suppressions` with the originating message reference in the note; and **mailbox liveness as a documented probe, not a poller** — send a test message to the address, confirm it lands, record the date. Name the failure mode explicitly: a broken Cloudflare forward makes opt-outs vanish with zero signal, and the statutory bar is 10 business days.

- [ ] **Step 2: `docs/directory.md`**

Add rows for `src/lib/admin/suppressions-service.ts`, `src/app/api/admin/suppressions/**`, `src/app/admin/suppressions/**`, `src/app/api/dashboard/contacts/[id]/suppression/route.ts`, and `supabase/migrations/098_*.sql`.

- [ ] **Step 3: `CONTEXT.md`**

Extend the existing **Correction path** glossary entry (do not add a new term — the term is already locked) with the sink decision: the audit record is a `solicitation_suppression_corrections` row written in the same transaction as the delete, deliberately NOT `account_audit_log`, whose `account_id NOT NULL` cannot hold the account-less rows §8.2 exists to correct; and note that §7.6 owner clearing writes to `account_audit_log` instead, because the two acts are not the same thing.

- [ ] **Step 4: Full gate**

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths
bash scripts/verify-gate.sh --review 2>&1 | tail -30
```

- [ ] **Step 5: Commit**

```bash
git add docs CONTEXT.md
git commit -m "docs(#645): §7.2 servicing contract, directory rows, Correction path sink"
```

---

## Self-review against the spec

| Spec section | Task |
|---|---|
| §7.1 admin manual is not optional | T4 (service + routes), T6 (entry point), T8 (servicing contract) |
| §7.2 servicing contract | T8 |
| §7.3 admin surface | T4 + T6 |
| §7.4 owner-facing display rules | T3 (seam + copy), T5 (join), T7 (render); #629 consumes the same seam |
| §7.5 owner manual suppression | T5 |
| §7.6 owner clears only their own account rows | T5 (SQL predicate), T7 (no control at all on a global row) |
| §8.1 no re-subscribe | T6 copy rules + the test asserting no re-subscribe affordance; nothing in this plan writes a path that removes a global row outside §8.2 |
| §8.2 correction path | T2 (sink), T4 (atomic delete + record), T6 (framing) |
| §9.3 no outbox row | Nothing in this plan enqueues; `recordSuppression`'s analytics insert stays the only side effect |
| §9.4/§9.5 no handle in analytics or logs | T5's audit payload carries `entityId`, never the handle; no new analytics event (D-8) |
| §10 no new env var | Nothing added |
