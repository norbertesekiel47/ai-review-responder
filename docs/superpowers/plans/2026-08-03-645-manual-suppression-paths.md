# Manual Suppression Paths (#645) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the four human-authored Suppression ledger paths — admin manual entry (§7.3), owner do-not-contact (§7.5), owner clearing of their own account rows (§7.6), and the admin-only audited Correction path (§8.2) — plus the server-side §7.4 read seam #629 consumes.

**Architecture:** The ledger's domain core `src/lib/solicitation/suppression.ts` is **deepened, not widened**: `suppressionMatchSql` gains one column in its projection (`scope`) and the file gains a display seam (`toSuppressionDisplay` + `SUPPRESSION_DISPLAY_COPY`) whose input type structurally cannot carry `account_id` or `source` — making both the §7.4 cross-tenant prohibition and the FU-3 no-reason-detail rule unrepresentable rather than merely unimplemented. Owner paths live in `contacts-repo.ts`, which already owns the "contacts carry no `account_id`; the `businesses` join IS the account-scope check" rule and already writes a sibling ledger table (`solicitation_consent`) inside `deleteContact`'s transaction. Admin cross-tenant reads and the Correction path live in a new `src/lib/admin/suppressions-service.ts`, the `flagged-service.ts` neighbourhood. Migration 098 adds `solicitation_suppression_corrections`, the §8.2 audit sink, because `account_audit_log.account_id` is `NOT NULL REFERENCES accounts(id)` and the rows §8.2 exists to correct carry no account.

**Tech Stack:** Next.js 16 App Router (server components + route handlers), Postgres.js, `zod` v4 strict objects, `fast-check` for the display invariant, Vitest (unit + serialized `integration` project for live-DB suites).

---

## Decisions this plan locks (read before any task)

| # | Decision | Why |
|---|---|---|
| D-1 | The Correction path audit sink is a **new table**, `solicitation_suppression_corrections`, not `account_audit_log` | `account_audit_log.account_id` is `NOT NULL REFERENCES accounts(id) ON DELETE CASCADE`. A `global`/`admin_manual` row entered from a mailbox reply has `account_id = NULL` (there is no account to attribute), and so does a `provider_suppressed` mirror from the transactional side — the two cases §8.2 names as its reason to exist. A CASCADE would also delete the compliance record with the account |
| D-2 | The correction record carries **no FK** to `accounts` or to `solicitation_suppressions` | The suppression row is gone by the time the record is written (that is the point), and §6.3's retention posture keeps `account_id` as provenance that must survive its referent |
| D-3 | Owner clearing (§7.6) writes to **`account_audit_log`**, NOT to the corrections table | The two acts are deliberately not the same thing (§7.6: "the UI must not present the two controls as the same thing"). An owner clearing their own preference is account-scoped with a non-null `account_id`; an admin removing a recipient's revocation is the compliance act. Separate sinks make the distinction structural |
| D-4 | Owner **marking** writes no audit-log row | Creation is already covered by the `solicitation_suppressed` analytics event `recordSuppression` emits in the same transaction (§9.4). Deletion has no analytics event, which is exactly why it gets the audit row. The asymmetry is the coverage, not an oversight |
| D-5 | Admin routes are **not** flag-gated; owner routes ride `solicitationWatchEnabled()` | A statutory 10-business-day obligation behind a feature flag is a violation waiting for a flag flip. The owner controls live on the already-watch-gated contacts surface, so they inherit its gate |
| D-6 | The Correction path takes **any** suppression row by id, `global` or `account` | One sink, one audit shape, no scope-dependent branching. §7.6 stays a separate owner-scoped route whose SQL predicate can only ever reach `scope='account' AND account_id = <caller's>` |
| D-7 | `toSuppressionDisplay` takes `{ scope }` only — not `source`, not `account_id` | §7.4's cross-tenant prohibition and FU-3 (no owner-visible bounce-vs-complaint detail) both become type errors instead of review comments |
| D-8 | No new analytics event name for the correction | It would require extending the `analytics_events` `CHECK` enum; the corrections table is already the durable record, and an admin-only rare action does not need a second one |

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

- [ ] **Step 1: Write all eighteen as `it.todo`, distributed by owning module**

```typescript
// src/lib/solicitation/__tests__/suppression-display.test.ts
import { describe, it } from 'vitest';

describe('suppression display seam (§7.4)', () => {
  it.todo('reports a suppressed contact as opted out of RepWorth review requests, never as skipped');
  it.todo('never exposes the account_id provenance of a global row to an owner');
  it.todo('distinguishes the owner\'s own account row from a global one, because only the former is reversible');
  it.todo('global wins the display state when both a global and an account row match');
});

describe('invariants', () => {
  it.todo('invariant: every scope and source pair maps to exactly one display state and never carries account_id');
});
```

```typescript
// src/lib/admin/__tests__/suppressions-service.test.ts
import { describe, it } from 'vitest';

describe('admin manual entry (§7.3)', () => {
  it.todo('records a global admin_manual row with created_by_user_id and the required note');
  it.todo('rejects an address that fails normalizeEmail instead of minting a wrong handle');
});
```

```typescript
// src/lib/admin/__tests__/suppressions-correction.integration.test.ts
import { describe, it } from 'vitest';

describe('Correction path (§8.2)', () => {
  it.todo('is idempotent against the global partial unique index — a repeat admin entry writes no second row');
  it.todo('deletes the suppression row and writes the correction record in the same transaction');
  it.todo('rolls back the delete when the correction record write fails');
  it.todo('corrects a global row whose account_id is NULL');
  it.todo('reports not-found instead of writing an orphan correction record when the row is already gone');
});
```

```typescript
// src/app/api/admin/suppressions/__tests__/route.test.ts
import { describe, it } from 'vitest';

describe('admin suppression routes', () => {
  it.todo('requires admin AAL2 on every suppression admin route');
});
```

```typescript
// src/app/api/dashboard/contacts/__tests__/suppression-route.test.ts
import { describe, it } from 'vitest';

describe('owner do-not-contact route (§7.5/§7.6)', () => {
  it.todo('returns a uniform 404 for a contact belonging to another account');
  it.todo('refuses to clear a global row through the owner path');
});
```

```typescript
// src/lib/solicitation/__tests__/contacts-do-not-contact.integration.test.ts
import { describe, it } from 'vitest';

describe('owner do-not-contact (§7.5/§7.6)', () => {
  it.todo('writes an owner_manual account-scoped row for the caller\'s own account');
  it.todo('refuses an owner do-not-contact on a contact with no email handle');
  it.todo('clears only the account row owned by the caller\'s account, leaving a matching global row in place');
});
```

- [ ] **Step 2: Run them and confirm they are pending, not passing**

Run: `pnpm vitest run src/lib/solicitation/__tests__/suppression-display.test.ts src/lib/admin/__tests__/suppressions-service.test.ts src/app/api/admin/suppressions/__tests__/route.test.ts src/app/api/dashboard/contacts/__tests__/suppression-route.test.ts`
Expected: all files pass with every test reported as **todo/skipped**, zero passing assertions. A green run with 0 todos means a title was dropped.

- [ ] **Step 3: Verify the gate can see all eighteen titles**

Run: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths && bash scripts/verify-gate.sh 2>&1 | tail -20`
Expected: the `promised-tests` row is **PASS** (titles are matched as strings; `it.todo` counts). Any other red row at this point is pre-existing and must be reported, not patched.

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
-- NO FOREIGN KEYS, deliberately, on either id-shaped column:
-- * suppression_id — the referent is DELETEd in the same transaction that
--   writes this row. That is the whole point of the record.
-- * account_id — provenance only, and §6.3's retention posture requires it
--   outlive its referent. The 096 tables take the same position for the same
--   reason (created_by_user_id there is likewise a plain UUID).
--
-- RLS deny-all with ZERO policies — the auto_approval_policies posture
-- (invariant #14), matching 096. Not decorative: a row here names a recipient's
-- Normalized handle and the account that mailed them, so a direct client read
-- would be the cross-tenant leak §7.4 forbids, on a record that also proves an
-- opt-out was removed.
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
  account_id UUID,                     -- provenance only; plain UUID, NO FK (§6.3)
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
| `solicitation_suppression_corrections` | **No TTL.** The record proves an opt-out was removed and by whom; deleting it would erase the only evidence that the removal was audited. Survives an account purge with `account_id` intact — same reasoning as the `scope='global'` ledger rows it describes (D7) | No poller touches it; offboarding purge deliberately does not list it |

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

```typescript
it('rejects a blank reason', async () => {
  await expect(
    db`INSERT INTO solicitation_suppression_corrections
         (id, suppression_id, channel, normalized_handle, scope, source, suppressed_at,
          account_id, removed_by_user_id, reason)
       VALUES (${randomUUID()}, ${randomUUID()}, 'email', 'x@example.com', 'global',
               'admin_manual', NOW(), NULL, ${randomUUID()}, '   ')`,
  ).rejects.toThrow(/reason_check|violates check constraint/i);
});

it('accepts a correction record with no account provenance', async () => {
  // The §8.2 case account_audit_log structurally cannot hold.
  const inserted = await db<{ id: string }[]>`
    INSERT INTO solicitation_suppression_corrections
      (id, suppression_id, channel, normalized_handle, scope, source, suppressed_at,
       account_id, removed_by_user_id, reason)
    VALUES (${randomUUID()}, ${randomUUID()}, 'email', 'nobody@example.com', 'global',
            'admin_manual', NOW(), NULL, ${randomUUID()}, 'admin typo on a mailbox reply')
    RETURNING id`;
  expect(inserted).toHaveLength(1);
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

Clean up every inserted row in `afterAll` (no `seedTenantAccount` needed — this table has no FKs).

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
    fc.assert(
      fc.property(
        fc.constantFrom(...SUPPRESSION_SCOPES),
        fc.constantFrom(...SUPPRESSION_SOURCES),
        fc.uuid(),
        (scope, source, accountId) => {
          // Every field the ledger row carries beyond `scope` is passed in and
          // must be invisible in the output — the mapper reads scope alone.
          const display = toSuppressionDisplay({ scope, source, accountId } as { scope: string });
          expect(display).not.toBeNull();
          expect(display?.state).toBe(scope);
          expect(display?.clearableByOwner).toBe(scope === 'account');
          const serialized = JSON.stringify(display);
          expect(serialized).not.toContain(accountId);
          expect(serialized).not.toContain(source);
          expect(display?.label).toBe(SUPPRESSION_DISPLAY_COPY[scope].label);
        },
      ),
    );
  });
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
 * §7.4's display contract, as a type rather than a convention.
 *
 * The parameter is `{ scope }` and nothing else, deliberately:
 *  - `account_id` cannot be passed, so a global row's provenance cannot reach
 *    an owner surface through this seam (§7.4, invariant #8). The ledger row
 *    carries it; this type is where it stops.
 *  - `source` cannot be passed either, so FU-3 (bounce vs complaint vs
 *    unsubscribe is NOT owner-visible) is unrepresentable rather than merely
 *    unimplemented.
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
             s.account_id, a.business_name AS account_name,
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
 * §8.2. The DELETE and the correction record are one statement pair inside the
 * caller's transaction, and the record is built from the DELETE's RETURNING —
 * never from a row read earlier — so a concurrent correction cannot produce a
 * record describing a row this call did not remove. A DELETE that matches
 * nothing returns 'not_found' and writes no orphan record.
 */
export async function correctSuppression(
  tx: TransactionSql,
  input: { suppressionId: string; adminUserId: string; reason: string },
): Promise<CorrectSuppressionResult> {
  const removed = await tx<{
    id: string;
    channel: string;
    normalized_handle: string;
    scope: SuppressionScope;
    source: SuppressionSource;
    account_id: string | null;
    suppressed_at: Date;
  }[]>`
    DELETE FROM solicitation_suppressions
    WHERE id = ${input.suppressionId}::uuid
    RETURNING id, channel, normalized_handle, scope, source, account_id, suppressed_at
  `;

  const row = removed[0];
  if (row === undefined) return 'not_found';

  await tx`
    INSERT INTO solicitation_suppression_corrections
      (id, suppression_id, channel, normalized_handle, scope, source,
       suppressed_at, account_id, removed_by_user_id, reason)
    VALUES
      (${uuidv7()}, ${row.id}, ${row.channel}, ${row.normalized_handle},
       ${row.scope}, ${row.source}, ${row.suppressed_at}, ${row.account_id},
       ${input.adminUserId}, ${input.reason})
  `;

  return 'corrected';
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
    const result = await sql.begin((tx) => correctSuppression(tx, {
      suppressionId: parsed.data.suppressionId,
      adminUserId: gate.admin.id,
      reason: parsed.data.reason,
    }));
    if (result === 'not_found') {
      return NextResponse.json(
        { error: 'not_found' },
        { status: 404, headers: NO_STORE_HEADERS },
      );
    }
    return NextResponse.json({ corrected: true }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return internalError('[api/admin/suppressions/correct] failed:', error);
  }
}

export const POST = withSameOrigin()(correct);
```

If `NO_STORE_HEADERS` is not exported from `@/lib/shared/constants`, use the local `const NO_STORE = { 'Cache-Control': 'no-store, private' } as const` that `src/app/api/admin/flagged/route.ts` defines — match whichever the neighbouring admin routes actually use; do not introduce a third spelling.

- [ ] **Step 3: Add the tenant-scope allowlist entries**

Append three entries to `TENANT_SCOPE_ALLOWLIST` in `scripts/ci/tenant-scope-allowlist.ts` (category `'admin-after-require-role'`) for `solicitation_suppressions`, `solicitation_suppression_corrections`, and `accounts` in `src/lib/admin/suppressions-service.ts`, and **bump `ALLOWLIST_BASELINE` by exactly the number of entries you added** (the audit fails on any count mismatch in either direction). Reason text for each: `#645 §7.3/§8.2 admin suppression servicing — cross-tenant by design behind requireAdminWithAal2; a handle-keyed compliance record has no tenant to scope to.`

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
  // reason of '   ' violates the CHECK; call correctSuppression inside
  // db.begin and expect the transaction to reject, then assert the ledger row
  // is STILL PRESENT. This is the atomicity proof — a non-transactional
  // implementation loses the opt-out and keeps no record of why.
  await expect(
    db.begin((tx) => correctSuppression(tx, { suppressionId, adminUserId, reason: '   ' })),
  ).rejects.toThrow();
  const still = await db`SELECT id FROM solicitation_suppressions WHERE id = ${suppressionId}`;
  expect(still).toHaveLength(1);
});

it('corrects a global row whose account_id is NULL', async () => {
  // the §8.2 case account_audit_log structurally cannot hold — seed with
  // accountId: null via recordAdminManualSuppression, then correct it
});

it('reports not-found instead of writing an orphan correction record when the row is already gone', async () => {
  const result = await db.begin((tx) => correctSuppression(tx, {
    suppressionId: randomUUID(), adminUserId, reason: 'already removed',
  }));
  expect(result).toBe('not_found');
  const corrections = await db`SELECT id FROM solicitation_suppression_corrections
                               WHERE removed_by_user_id = ${adminUserId}`;
  expect(corrections).toHaveLength(0);
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
