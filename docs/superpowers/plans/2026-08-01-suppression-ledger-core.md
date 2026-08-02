# Suppression Ledger — Schema + Domain Core (#643) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the **Suppression ledger**'s schema and domain core — `solicitation_suppressions` and `solicitation_unsubscribe_tokens` (migrations 096/097), the single authoritative `src/lib/solicitation/suppression.ts`, the build-time populate seam, offboarding purge retention, and the analytics registrations that #644, #645, #627 and #630 all build on.

**Architecture:** One new deep module (`suppression.ts`) exporting three `as const` enum arrays, one **composable SQL fragment** that is the sole owner of the §1.2 lookup predicate, and one first-write-wins writer. Every other change deepens an existing module without widening its interface — the sole exception is the `purge_receipt` outbox payload, which gains one integer. All persistence flows through explicit `sql`/`tx` parameters (invariant #15).

**Tech Stack:** Postgres 16 via Postgres.js (fragment composition), Vitest (unit + `*.integration.test.ts` live-DB), `uuid` v7 for PKs, `node:crypto` for hashes.

**Binding documents:**
- Intake contract: `.feature/intake.json` (arming copy) / `docs/superpowers/plans/feat-643-suppression-ledger-core-intake.json` (audit copy)
- Locked spec: `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md` (§1.1–§1.3, §2.1, §2.2, §3.1, §3.2, §4.1, §4.2, §6.3, §6.4, §9.4, §9.5)
- Amendments: `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` (B4, B6, B9)
- Glossary: `CONTEXT.md` → "Solicitation suppression & unsubscribe" (Suppression ledger, Suppression scope, Unsubscribe token, Correction path, Attestation never overrides suppression)

**Use glossary terms verbatim.** Say *Suppression ledger*, *Suppression scope*, *Unsubscribe token*, *Normalized handle*, *Correction path*. Never "blocklist", "do-not-mail flag", "opt-out table", "unsuppress", "re-subscribe".

---

## Decisions locked in grilling (do NOT re-litigate)

| # | Decision | Rationale |
|---|---|---|
| G1 | `outreach_id` is a **plain UUID with a partial UNIQUE index and NO FK** | `solicitation_outreach` cascades from `solicitation_batches` from `contact_csv_uploads` (`purge-verification.ts:596-599`). A CASCADE FK would delete retained token rows, breaking the post-purge redemption §5.2 guarantees. Matches §2.2's existing treatment of `ask_id`. **Amends B9.** |
| G2 | `solicitation_suppressions` gets **ONE** disposition entry, not two | `TABLE_DISPOSITIONS` is keyed by table name and `verificationQuery` is a `switch (table)` — two entries hit the same arm twice. The single `allowed_limited_retention` arm asserts **both** facts so it can actually fail. **Amends §6.3's two-row table.** |
| G3 | **Global wins** when a handle matches both a global row and this account's `owner_manual` row | Reporting the account row would let an owner clear it under §7.6, watch the contact stay suppressed, and have no idea why. |
| G4 | 096 ships **`account_id`-leading indexes** on both tables | Both partial uniques lead with `(channel, normalized_handle)`, but the purge delete, retained count and token scrub all filter account-first. PG16 has no skip scan. This is migration 095's lesson applied up front. |
| G5 | Retained-count is **global suppression rows only**, snapshotted at purge time and threaded through the outbox payload | Token rows are opt-out *mechanisms*, not opt-out *records*, and their `account_id` is scrubbed by then. Threading (vs. querying at send) matches the existing row-less `purge_receipt` posture, keeps the email worker ignorant of the solicitation domain, and makes a retried send render a stable number. |
| G6 | Ship `recordSuppression` with **zero production callers**; the live-DB suite is its consumer | The byte-for-byte `ON CONFLICT` predicate needs one owner and needs proving the moment the indexes are created — not three tickets later. Expect a fallow unused-export finding needing a justified suppression. |
| G7 | **No `isSuppressed()` helper.** Export the SQL fragment instead | Its only consumer would be #630 (a non-goal) — abstraction before the second use. The fragment has a real production caller today (`batch-builder`) and #630 composes the same fragment later. One owner of the predicate, exactly one unused export. |
| G8 | Two migrations: 096 tables, 097 analytics CHECK | The `analytics_events` CHECK swap has taken its own file with its own `lock_timeout` every time (046 → 058 → 069 → 089 → 094) because DROP+re-ADD takes ACCESS EXCLUSIVE and re-validates every row. |
| G9 | `VerifyAccountOffboardingPurgeInput` is **NOT** widened | The account's users are derivable by subquery, exactly as the `analytics_events` arm already does at `purge-verification.ts:351`. |
| G10 | `AskCandidate.suppression.source` stays typed `string`, not the derived union | `restraint-policy.ts:116` is a **serialization contract** — evidence round-trips through JSONB and is re-read by `parseEvidence`. Narrowing it would ripple into the read model for no safety gain at the write site, which already uses the derived type. |

---

## File structure

| File | Responsibility | New/Modified |
|---|---|---|
| `supabase/migrations/096_solicitation_suppressions.sql` | Both tables, both partial uniques, both `account_id`-leading indexes, RLS deny-all | **Create** |
| `supabase/migrations/097_suppression_analytics_events.sql` | `analytics_events_event_name_check` swap admitting two names | **Create** |
| `src/lib/solicitation/suppression.ts` | **The** authoritative module: enums, §1.2 fragment, first-write-wins writer | **Create** |
| `src/lib/solicitation/__tests__/suppression.test.ts` | Enum/type contract, pure-unit | **Create** |
| `src/lib/solicitation/__tests__/suppression.integration.test.ts` | Live-DB: both `ON CONFLICT` arms, first-write-wins, CHECK pairing, same-tx analytics | **Create** |
| `src/lib/solicitation/batch-builder.ts` | §4.2 populate seam — LATERAL join + `toCandidate` | Modify (`:335`, `:417-420` region) |
| `src/lib/analytics/events.ts` | Register both event names | Modify |
| `docs/analytics/events.md` | Document both events | Modify |
| `src/lib/account-offboarding/table-disposition.ts` | Two entries, alphabetical in-place | Modify |
| `src/lib/account-offboarding/purge-verification.ts` | Two `case` arms before the fail-closed `default:` | Modify |
| `worker/jobs/account-offboarding/purge-stages.ts` | Account-row delete, token scrub, retained count | Modify (`:283-320`, `:651-751`) |
| `src/lib/account-offboarding/outbox.ts` | `retainedSuppressionCount` on the receipt enqueue | Modify |
| `src/lib/shared/worker-types.ts` | Payload type field | Modify (`:266` region) |
| `worker/jobs/account-offboarding/AccountOffboardingEmailWorker.ts` | Pass the count to the template | Modify (`:217-219`, `:404-418`) |
| `src/lib/notifications/email/templates/account-offboarding.ts` | Render the retained-count sentence | Modify (`:43`) |
| `scripts/ci/tenant-tables.ts` | Both tables + required comment blocks | Modify |
| `scripts/ci/tenant-scope-allowlist.ts` | Global-arm exemption + `ALLOWLIST_BASELINE` bump | Modify |
| `docs/security/rls-inventory.md` | One row per new tenant table | Modify |
| `src/lib/shared/__tests__/helpers/schema-ready.ts` | Two `SchemaRequirement`s | Modify |
| `.claude/reference/migrations-log.md` | 096 + 097 entries, head → 097 | Modify |
| `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md` | G1 + G2 amendment notes | Modify |

---

## Task graph (blocking edges)

```
T1 (schema + registries) ──┬── T2 (suppression.ts) ── T4 (populate seam)
                           └── T3 (purge retention) ── T5 (receipt count)
T2, T4, T5 ────────────────────── T6 (spec amendments + migrations-log)
```

T2 and T3 are independent of each other and may run in parallel once T1 lands.

---

### Task 1: Schema + registry ripple

**Files:**
- Create: `supabase/migrations/096_solicitation_suppressions.sql`
- Create: `supabase/migrations/097_suppression_analytics_events.sql`
- Modify: `src/lib/analytics/events.ts`, `docs/analytics/events.md`
- Modify: `scripts/ci/tenant-tables.ts`, `docs/security/rls-inventory.md`
- Modify: `src/lib/shared/__tests__/helpers/schema-ready.ts`
- Create: `src/lib/shared/__tests__/migration-096-solicitation-suppressions.integration.test.ts`
- Create: `src/lib/shared/__tests__/migration-097-suppression-analytics-events.integration.test.ts`

**Blocking edges:** none.

**Read first:** `supabase/migrations/093_solicitation_consent.sql` (whole file — the header-comment + RLS shape to mirror), `supabase/migrations/094_consent_analytics_events.sql` (whole file — you must copy its `IN (...)` list **verbatim**), `supabase/migrations/086_solicitation_contacts.sql` (partial unique index pattern), and invoke the `new-migration` skill before writing the first line of SQL.

- [ ] **Step 1: Write migration 096**

```sql
-- 096_solicitation_suppressions.sql
-- The Suppression ledger + Unsubscribe token table: the authoritative answer to
-- "may we send to this handle" and the durable target of a delivered ask's
-- opt-out links (#643, split from #626; locked spec:
-- docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md §2.1/§2.2).
--
-- Design notes (spec section in parentheses):
-- * Keyed on the Normalized handle per channel, NEVER on contact_id (§1.1) —
--   delete-and-re-upload must not launder an opt-out (#535 §6).
-- * Two Suppression scopes (§1.2). `global` is authored by the recipient or the
--   mail ecosystem on their behalf and keys on (channel, normalized_handle) —
--   global because every account sends from one shared identity, so from the
--   recipient's inbox there is exactly one sender. `account` is the owner's own
--   do-not-contact and keys on (channel, normalized_handle, account_id).
-- * TWO PARTIAL unique indexes, so every ON CONFLICT must re-spell its
--   predicate BYTE-FOR-BYTE or Postgres will not infer the constraint
--   (CLAUDE.md gotcha; 086 is the in-repo pattern). Writers are
--   ON CONFLICT ... DO NOTHING: FIRST WRITE WINS (§2.1).
-- * account_id is the SCOPE, not a denormalization (§1.2): the row does not
--   hang off a business, so there is nothing for it to drift from. 086's
--   warning does not apply. The CHECK pairing is ONE-DIRECTIONAL: an `account`
--   row REQUIRES account_id; a `global` row MAY carry it as provenance.
-- * NO ON DELETE SET NULL on account_id (§6.3): global rows are retained
--   through offboarding purge with account_id INTACT, pointing at the
--   already-tombstoned accounts row. The purge is an explicit, verified
--   operation, never a cascade side effect.
-- * Raw normalized handle, NOT a peppered hash (§6.4). A bare SHA-256 of an
--   email is dictionary-attackable; a real HMAC pepper is a catastrophic SPOF
--   on a compliance record — lose or rotate it and every opt-out is silently
--   un-suppressed with no way to detect or rebuild it.
-- * No time-window comparison is ever made against suppressed_at (§2.1) — both
--   evaluation points are existence checks, which deliberately sidesteps the
--   postgres.js microsecond-truncation class.
-- * outreach_id on the token table is a PLAIN UUID with NO FK (#643 grilling
--   G1, amending amendments B9). solicitation_outreach cascades from
--   solicitation_batches from contact_csv_uploads, so a CASCADE FK would delete
--   the retained token rows that §5.2 exists to guarantee. Same posture §2.2
--   already applies to ask_id.
-- * account_id-leading indexes on BOTH tables (G4): the partial uniques lead
--   with (channel, normalized_handle), but the purge delete, the retained-row
--   count and the token scrub all filter account-first, and PG16 has no skip
--   scan. This is migration 095's lesson applied up front.
-- * PK is UUIDv7, worker-supplied (repo convention, no DB default).
-- * RLS enabled with ZERO policies — deny-all, the auto_approval_policies
--   posture (invariant #14). Not decorative: a direct client read of a global
--   row would expose account_id provenance, which §7.4 forbids surfacing.
-- Rollback: safe to DROP BOTH TABLES only while empty, i.e. before the first
-- writer merges (#644/#645/#627). Revert the app deploy FIRST — batch-builder,
-- purge-verification and purge-stages all reference these tables.

CREATE TABLE IF NOT EXISTS solicitation_suppressions (
  id UUID PRIMARY KEY,                 -- UUIDv7 supplied by the worker
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  normalized_handle TEXT NOT NULL,     -- output of normalizeEmail (src/lib/solicitation/handles.ts)
  scope TEXT NOT NULL CHECK (scope IN ('global', 'account')),
  account_id UUID REFERENCES accounts(id),   -- NO ON DELETE action (§6.3)
  source TEXT NOT NULL CHECK (source IN (
    'unsubscribe_link',
    'unsubscribe_one_click',
    'bounce_permanent',
    'complaint',
    'provider_suppressed',
    'admin_manual',
    'owner_manual'
  )),
  suppressed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by_user_id UUID,             -- admin_manual / owner_manual only; plain UUID, NO FK
  note TEXT,                           -- manual entries; the §7.5 originating message reference
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT solicitation_suppressions_account_scope_pairing
    CHECK (scope <> 'account' OR account_id IS NOT NULL)
);

-- §1.2's two key shapes. PARTIAL — every ON CONFLICT re-spells the predicate
-- byte-for-byte or the constraint is not inferred.
CREATE UNIQUE INDEX IF NOT EXISTS solicitation_suppressions_global_uniq
  ON solicitation_suppressions (channel, normalized_handle)
  WHERE scope = 'global';

CREATE UNIQUE INDEX IF NOT EXISTS solicitation_suppressions_account_uniq
  ON solicitation_suppressions (channel, normalized_handle, account_id)
  WHERE scope = 'account';

-- G4: account-leading, for the offboarding purge delete (scope='account'),
-- the retained-row count (scope='global') and purge verification.
CREATE INDEX IF NOT EXISTS idx_solicitation_suppressions_account
  ON solicitation_suppressions (account_id, scope)
  WHERE account_id IS NOT NULL;

ALTER TABLE solicitation_suppressions ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: deny-all.

CREATE TABLE IF NOT EXISTS solicitation_unsubscribe_tokens (
  id UUID PRIMARY KEY,                 -- UUIDv7 supplied by the worker
  token_hash TEXT NOT NULL UNIQUE,     -- SHA-256, node:crypto (invariant #10); raw token NEVER stored (invariant #5)
  normalized_handle TEXT NOT NULL,     -- the redemption target
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  account_id UUID,                     -- provenance; scrubbed to NULL on purge (§6.3). Plain UUID, NO FK.
  business_id UUID,                    -- provenance; scrubbed on purge. Plain UUID, NO FK.
  ask_id UUID,                         -- provenance; scrubbed on purge. NO FK — referent is hard-deleted (§2.2).
  outreach_id UUID,                    -- provenance + idempotent mint key (B4). NO FK — see header (G1).
  sent_at TIMESTAMPTZ NOT NULL,
  redeemed_at TIMESTAMPTZ,             -- first redemption; a second is a no-op success
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- B4's idempotent mint key: a #630 dispatch retry re-uses the existing token
-- row for the same outreach. PARTIAL so purge-scrubbed NULLs never collide.
CREATE UNIQUE INDEX IF NOT EXISTS solicitation_unsubscribe_tokens_outreach_uniq
  ON solicitation_unsubscribe_tokens (outreach_id)
  WHERE outreach_id IS NOT NULL;

-- G4: account-leading, for the offboarding purge scrub.
CREATE INDEX IF NOT EXISTS idx_solicitation_unsubscribe_tokens_account
  ON solicitation_unsubscribe_tokens (account_id)
  WHERE account_id IS NOT NULL;

ALTER TABLE solicitation_unsubscribe_tokens ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: deny-all.
```

- [ ] **Step 2: Write migration 097**

Open `supabase/migrations/094_consent_analytics_events.sql`. Copy its `lock_timeout` preamble, its `ALTER TABLE analytics_events DROP CONSTRAINT ... ADD CONSTRAINT analytics_events_event_name_check CHECK (event_name IN (...))` statement, and its **entire `IN (...)` list verbatim**. Append exactly two members:

```
    'solicitation_suppressed',
    'solicitation_suppressed_at_dispatch'
```

Header comment must state: registering the names only in `ANALYTICS_EVENT_NAMES` is NOT enough — without the CHECK entry every emitting transaction ROLLS BACK, and `ci:analytics-events` does not catch it (it compares the TS allowlist against `docs/analytics/events.md`, never the database). This is 089's lesson, restated in 094's header. `solicitation_suppressed` is emitted by this ticket's writer; `solicitation_suppressed_at_dispatch` is emitted by **#630** and is registered here so #644 and #630 stay migration-free. The new list is a strict superset of 094's, so existing rows always pass.

- [ ] **Step 3: Register both events in TS + docs**

In `src/lib/analytics/events.ts`, add `'solicitation_suppressed'` and `'solicitation_suppressed_at_dispatch'` to `ANALYTICS_EVENT_NAMES`, following the placement of `solicitation_consent_recorded`.

In `docs/analytics/events.md`, add a section per event mirroring the `### solicitation_consent_recorded` section at `:232`. Properties per §9.4:
- `solicitation_suppressed` → `source`, `scope`, `channel`. **Never the handle.** Event key: `solicitation_suppressed_<suppression_row_id>`.
- `solicitation_suppressed_at_dispatch` → `source`, `ask_id`. Note it is emitted by #630, not this ticket.

- [ ] **Step 4: Registry ripple**

`scripts/ci/tenant-tables.ts` — add both table names with the required comment block, mirroring the `solicitation_consent` block at `:42-46`. State: deny-all RLS (migration 096, #643), zero policies, the `auto_approval_policies` posture; `solicitation_suppressions` carries `account_id` as **Suppression scope**, and its `global` arm is deliberately cross-account, exempted in `tenant-scope-allowlist.ts`.

`docs/security/rls-inventory.md` — one row per table, mirroring `:35`. `rls-audit.test.ts` asserts a row per tenant table.

`src/lib/shared/__tests__/helpers/schema-ready.ts` — add two `SchemaRequirement` exports mirroring `MIGRATION_093_SOLICITATION_CONSENT` at `:279`:

```typescript
export const MIGRATION_096_SOLICITATION_SUPPRESSIONS: SchemaRequirement = {
  migration: '096_solicitation_suppressions',
  tables: ['solicitation_suppressions', 'solicitation_unsubscribe_tokens'],
  indexes: [
    'solicitation_suppressions_global_uniq',
    'solicitation_suppressions_account_uniq',
    'idx_solicitation_suppressions_account',
    'solicitation_unsubscribe_tokens_outreach_uniq',
    'idx_solicitation_unsubscribe_tokens_account',
  ],
};
```

Register both in whatever aggregate the file uses to drive `assertSchemaReady` — read the file's tail to find it; do not guess.

- [ ] **Step 5: Provision the test DB and write the migration-shape suites**

```bash
pnpm test:db:setup
```
Expected: completes without error, applying bootstrap + every migration through 097.

Write `migration-096-solicitation-suppressions.integration.test.ts` and `migration-097-suppression-analytics-events.integration.test.ts`, following `migration-094-consent-analytics-events.integration.test.ts` **exactly**. These are migration-**shape** suites — the sanctioned exception to the no-DDL rule — so they MUST hold the cross-process lock (`acquireLiveDbLock`, `helpers/live-db-lock.ts`) and roll back any unconditional re-apply. A committed re-apply of an old migration silently reverts a later one on the shared DB.

Required test (verbatim title):
- `migration 097 admits solicitation_suppressed and solicitation_suppressed_at_dispatch into the analytics_events CHECK`

- [ ] **Step 6: Run the gates**

```bash
pnpm ci:rls-audit && pnpm ci:tenant-scope && pnpm typecheck
```
Expected: `ci:rls-audit` PASS. `ci:tenant-scope` **may FAIL** here with `missing account_id or business_id scope` — that is expected and fixed in Task 4; note it and continue. If it fails for any *other* reason, stop.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/096_solicitation_suppressions.sql supabase/migrations/097_suppression_analytics_events.sql src/lib/analytics/events.ts docs/analytics/events.md scripts/ci/tenant-tables.ts docs/security/rls-inventory.md src/lib/shared/__tests__/helpers/schema-ready.ts src/lib/shared/__tests__/migration-09*
git commit -m "feat(#643): suppression ledger schema (migrations 096-097) + registry ripple"
```

---

### Task 2: `suppression.ts` — the authoritative module

**Files:**
- Create: `src/lib/solicitation/suppression.ts`
- Create: `src/lib/solicitation/__tests__/suppression.test.ts`
- Create: `src/lib/solicitation/__tests__/suppression.integration.test.ts`

**Blocking edges:** T1.

**Read first:** `src/lib/shared/primary-tracked-keyword-sql.ts` (the fragment-builder precedent — note the `SqlExecutor` param name; `scripts/ci/lib/sql-tag-scan.ts:32` recognizes only certain tag names), `src/lib/solicitation/ingest.ts:376-414` (the `ON CONFLICT` + same-transaction `enqueueAnalyticsEvent` shape).

- [ ] **Step 1: Write the module**

```typescript
import { v7 as uuidv7 } from 'uuid'; // invariant #10 posture: uuid lib is the repo-standard UUIDv7 source
import type postgres from 'postgres';
import { enqueueAnalyticsEvent } from '@/lib/analytics/events';

/**
 * The Suppression ledger's domain core (#643; locked spec
 * docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md §1–§3).
 *
 * Sole owner of three facts, so no call site re-derives them:
 *  1. The closed source/scope/channel enums (§3.1).
 *  2. The §1.2 lookup predicate — `global` OR this account's `account` row,
 *     global winning a double match (#643 grilling G3).
 *  3. The first-write-wins writer and its byte-for-byte ON CONFLICT predicates.
 *
 * DR2 — this ledger is solicitation-only. Transactional and notification email
 * must NEVER consult it: an owner who opted out as somebody else's customer
 * must still receive approval emails, or invariant #3 is reached sideways.
 */

type SqlExecutor = postgres.Sql | postgres.TransactionSql;

export const SUPPRESSION_SOURCES = [
  'unsubscribe_link',
  'unsubscribe_one_click',
  'bounce_permanent',
  'complaint',
  'provider_suppressed',
  'admin_manual',
  'owner_manual',
] as const;
export type SuppressionSource = (typeof SUPPRESSION_SOURCES)[number];

export const SUPPRESSION_SCOPES = ['global', 'account'] as const;
export type SuppressionScope = (typeof SUPPRESSION_SCOPES)[number];

export const SUPPRESSION_CHANNELS = ['email'] as const;
export type SuppressionChannel = (typeof SUPPRESSION_CHANNELS)[number];

/**
 * §1.2's lookup, as a composable SQL fragment (the primary-tracked-keyword-sql
 * precedent) rather than a function that owns its own round trip. The batch
 * build embeds it in loadCandidateWindow's LATERAL join today; #630's dispatch
 * gate embeds the same fragment later. One owner of the predicate.
 *
 * `handleColumn` is a fragment naming the already-normalized handle column in
 * the OUTER query (e.g. sql`c.email`) — solicitation_contacts.email already
 * stores the output of normalizeEmail, so there is no re-normalization here.
 *
 * Global wins a double match (G3): reporting the account row would let an owner
 * clear it under §7.6, watch the contact stay suppressed, and have no idea why.
 *
 * Returns at most one row of { source, suppressed_at }, or none.
 */
export function suppressionMatchSql(
  exec: SqlExecutor,
  handleColumn: postgres.PendingQuery<never> | postgres.Fragment,
  accountId: string,
) {
  return exec`
    SELECT s.source, s.suppressed_at
    FROM solicitation_suppressions s
    WHERE s.channel = 'email'
      AND s.normalized_handle = ${handleColumn}
      AND (
        s.scope = 'global'
        OR (s.scope = 'account' AND s.account_id = ${accountId}::uuid)
      )
    ORDER BY (s.scope = 'global') DESC, s.suppressed_at ASC
    LIMIT 1
  `;
}

export interface RecordSuppressionInput {
  channel: SuppressionChannel;
  normalizedHandle: string;
  scope: SuppressionScope;
  accountId: string | null;
  source: SuppressionSource;
  createdByUserId?: string | null;
  note?: string | null;
}

/**
 * First-write-wins (§2.1). A complaint arriving after an unsubscribe does NOT
 * overwrite the earlier row — the state is already correct, and the history
 * lives where it belongs (the provider webhook records, and the audit trail for
 * manual entries). A second row would add nothing and would break the
 * uniqueness that makes the §1.2 lookup a plain equality.
 *
 * The ON CONFLICT predicates re-spell each partial index BYTE-FOR-BYTE. They
 * cannot be parameterized or collapsed — a mismatch means Postgres silently
 * fails to infer the constraint and the INSERT throws instead of no-op'ing.
 *
 * Returns the row id when a row was written, or null when an existing row won.
 * The §9.4 analytics event is a durable insert in the SAME transaction (§9.3
 * — there is no follow-up work, so there is deliberately NO job_outbox row),
 * and is skipped entirely on the no-op path so a repeat never double-mints.
 *
 * Properties NEVER include the handle (§9.4/§9.5).
 */
export async function recordSuppression(
  tx: postgres.TransactionSql,
  input: RecordSuppressionInput,
): Promise<string | null> {
  const id = uuidv7();

  const written =
    input.scope === 'global'
      ? await tx<{ id: string }[]>`
          INSERT INTO solicitation_suppressions
            (id, channel, normalized_handle, scope, account_id, source,
             created_by_user_id, note)
          VALUES
            (${id}, ${input.channel}, ${input.normalizedHandle}, 'global',
             ${input.accountId}, ${input.source},
             ${input.createdByUserId ?? null}, ${input.note ?? null})
          ON CONFLICT (channel, normalized_handle) WHERE scope = 'global'
          DO NOTHING
          RETURNING id
        `
      : await tx<{ id: string }[]>`
          INSERT INTO solicitation_suppressions
            (id, channel, normalized_handle, scope, account_id, source,
             created_by_user_id, note)
          VALUES
            (${id}, ${input.channel}, ${input.normalizedHandle}, 'account',
             ${input.accountId}, ${input.source},
             ${input.createdByUserId ?? null}, ${input.note ?? null})
          ON CONFLICT (channel, normalized_handle, account_id) WHERE scope = 'account'
          DO NOTHING
          RETURNING id
        `;

  const row = written[0];
  if (row === undefined) return null;

  await enqueueAnalyticsEvent(tx, {
    eventName: 'solicitation_suppressed',
    eventKey: `solicitation_suppressed_${row.id}`,
    distinctId: input.accountId ?? row.id,
    accountId: input.accountId,
    businessId: null,
    properties: {
      source: input.source,
      scope: input.scope,
      channel: input.channel,
    },
  });

  return row.id;
}
```

> **Check `enqueueAnalyticsEvent`'s real signature** in `src/lib/analytics/events.ts` before finalizing — match its parameter names and nullability exactly rather than trusting the shape above. If `businessId`/`distinctId` are optional, omit rather than passing `null`.

> **`postgres.Fragment` may not be the exported type name.** Read the `postgres` types and use whatever `primary-tracked-keyword-sql.ts` uses for the same purpose; if that file returns an untyped fragment, do the same and let inference work.

- [ ] **Step 2: Write the unit suite** (`suppression.test.ts`)

Contract-only, no DB. Required tests (verbatim titles):
- `a global row may carry account_id as provenance` — assert `RecordSuppressionInput` accepts `scope: 'global'` with a non-null `accountId` at the type level and that `SUPPRESSION_SOURCES` contains all seven §3.1 members in spec order.

- [ ] **Step 3: Write the live-DB suite** (`suppression.integration.test.ts`)

Name it `*.integration.test.ts` — the name is what puts it in vitest's serialized `integration` project. It must **NOT** apply migration SQL; assert with `assertSchemaReady` instead. Required tests (verbatim titles):

- `ON CONFLICT infers the global partial unique index and a second write is a no-op`
- `ON CONFLICT infers the account partial unique index scoped to account_id`
- `a global row and an account row for the same handle coexist`
- `first write wins: a later complaint does not overwrite an earlier unsubscribe row`
- `recordSuppression writes the solicitation_suppressed analytics row in the same transaction`
- `a repeat recordSuppression mints no duplicate analytics event`
- `the CHECK pairing rejects scope='account' with a NULL account_id`
- `isSuppressed returns the global row when both a global and an account row match`
- `isSuppressed ignores an account row belonging to a different account`

> The last two titles are fixed by the intake contract and the gate matches them **verbatim**. G7 removed the `isSuppressed` function, so these two exercise `suppressionMatchSql` — keep the titles exactly as written (they name the *behavior*, which is unchanged) and assert against the fragment composed into a probe query.

The first-write-wins test must assert the surviving row's `source` is still `unsubscribe_link` after a `complaint` write returns `null` — not merely that the row count is 1.

- [ ] **Step 4: Run**

```bash
pnpm test src/lib/solicitation/__tests__/suppression.test.ts
pnpm test src/lib/solicitation/__tests__/suppression.integration.test.ts
```
Expected: both PASS. If the `ON CONFLICT` tests throw `there is no unique or exclusion constraint matching the ON CONFLICT specification`, the predicate is not byte-for-byte identical to the index — diff them character by character, do not "fix" by dropping the predicate.

- [ ] **Step 5: Commit**

```bash
git add src/lib/solicitation/suppression.ts src/lib/solicitation/__tests__/suppression*.ts
git commit -m "feat(#643): suppression.ts — closed enums, §1.2 fragment, first-write-wins writer"
```

---

### Task 3: Offboarding purge retention

**Files:**
- Modify: `src/lib/account-offboarding/table-disposition.ts`
- Modify: `src/lib/account-offboarding/purge-verification.ts`
- Modify: `worker/jobs/account-offboarding/purge-stages.ts:283-320`
- Modify: `src/lib/account-offboarding/__tests__/purge-verification.test.ts`
- Modify: `worker/jobs/account-offboarding/__tests__/` (the purge-stages suite)

**Blocking edges:** T1.

- [ ] **Step 1: Add the disposition entries (alphabetical, in place)**

`TABLE_DISPOSITIONS` is asserted alphabetically sorted (`table-disposition.test.ts:107`). `solicitation_suppressions` sorts after `solicitation_outreach` and before `solicitation_unsubscribe_tokens`; both go after `solicitation_consent`… **verify the actual alphabetical position rather than trusting this sentence**, then insert:

```typescript
  {
    table: 'solicitation_suppressions',
    disposition: 'retain_compliance_limited_pii',
    scopeEvidence: 'compliance_handle_hash',
    purgeVerification: 'allowed_limited_retention',
    reason: 'Global opt-out rows are the RECIPIENT\'s revocation against our shared sending identity, not the account\'s data — deleting one un-suppresses an opted-out person (#535 §6 through a different door). Account-scoped (owner_manual) rows are the account\'s own preference and are deleted. One entry, not two: the inventory is keyed by table name (#643 grilling G2), so the verification arm asserts both facts.',
  },
  {
    table: 'solicitation_unsubscribe_tokens',
    disposition: 'retain_compliance_limited_pii',
    scopeEvidence: 'compliance_handle_hash',
    purgeVerification: 'allowed_limited_retention',
    reason: 'Redemption must still work after the sender is gone (§5.2): the opt-out link operates >=30 days past send while the asks it referenced are hard-deleted. Provenance (account_id, business_id, ask_id, outreach_id) is scrubbed; token_hash, normalized_handle, channel and sent_at are kept.',
  },
```

Both are the first-ever users of `retain_compliance_limited_pii` and `compliance_handle_hash`. Per §6.4, `compliance_handle_hash` is read as **scope evidence** — "this row's association is by handle, not by `account_id`" — **not** as a storage instruction. We store the raw normalized handle.

- [ ] **Step 2: Add the verification arms**

In `purge-verification.ts`, before the fail-closed `default:`. No input widening (G9) — derive the account's users by subquery exactly as the `analytics_events` arm does at `:351`.

```typescript
    // Retained by compliance basis (§6.3), so this arm cannot be "count rows
    // that exist". It asserts the TWO things that must be true post-purge:
    // (a) no account-scoped (owner_manual) row survives — those are the
    //     account's own data and are deleted; and
    // (b) no RETAINED global row still carries an identifier linking back to
    //     one of this account's users. account_id itself is deliberately KEPT
    //     on global rows (§6.3) and so is never a violation.
    // One arm rather than two entries: TABLE_DISPOSITIONS is keyed by table
    // name (#643 grilling G2, amending §6.3's two-row table).
    case 'solicitation_suppressions':
      return exec<VerificationRow[]>`
        SELECT COUNT(*) AS violation_count
        FROM solicitation_suppressions
        WHERE (scope = 'account' AND account_id = ${accountId}::uuid)
           OR (
             scope = 'global'
             AND created_by_user_id IN (
               SELECT id FROM users WHERE account_id = ${accountId}::uuid
             )
           )
      `;

    // Retained so post-purge redemption still works (§5.2). The violation is a
    // surviving row that still carries ANY provenance identifier — the scope
    // predicate cannot be account_id, because account_id is exactly what gets
    // scrubbed. This is what compliance_handle_hash scope evidence is for.
    case 'solicitation_unsubscribe_tokens':
      return exec<VerificationRow[]>`
        SELECT COUNT(*) AS violation_count
        FROM solicitation_unsubscribe_tokens
        WHERE account_id = ${accountId}::uuid
           OR business_id IN (SELECT id FROM businesses WHERE account_id = ${accountId}::uuid)
      `;
```

- [ ] **Step 3: Wire the purge stage**

In `purge-stages.ts`, inside the **existing** advisory-locked transaction at `:283-320` (which already holds `acquireCsvIngestLock` then `acquireSolicitationBatchLock`, in that order, per business). Do **not** open a new transaction and do **not** add a new advisory lock — the ledger is not written by CSV ingest, so it is outside both locks' contracts, and inventing a third lock risks the ABBA class the existing docstrings guard against.

Add, after the existing `deleteByBusiness(tx, 'solicitation_consent', row.account_id)` at `:320`:

```typescript
    // §6.3: account-scoped (owner_manual) rows are the account's own preference
    // about their own customer — once purged, no path exists to mail that
    // person through this account, so nothing is protected by keeping them.
    // GLOBAL rows are deliberately untouched: they are the recipient's
    // revocation and survive with account_id intact, pointing at the
    // already-tombstoned accounts row.
    await tx`
      DELETE FROM solicitation_suppressions
      WHERE scope = 'account' AND account_id = ${row.account_id}::uuid
    `;

    // §6.3: scrub provenance, keep the mechanism. Redemption after the sender
    // is gone still writes a ledger row (§5.2) — honoring the opt-out matters;
    // knowing which dead account sent it does not.
    await tx`
      UPDATE solicitation_unsubscribe_tokens
      SET account_id = NULL,
          business_id = NULL,
          ask_id = NULL,
          outreach_id = NULL
      WHERE account_id = ${row.account_id}::uuid
         OR business_id IN (SELECT id FROM businesses WHERE account_id = ${row.account_id}::uuid)
    `;
```

- [ ] **Step 4: Write the tests**

Required (verbatim titles):
- `purge verification fails when an account-scoped suppression row survives`
- `purge verification passes when a global suppression row survives with its account_id intact`
- `purge verification fails when a retained global row still references one of the account's users`
- `the purge scrubs account_id, business_id, ask_id and outreach_id from token rows and keeps token_hash, normalized_handle, channel and sent_at`
- `a token row survives the purge that deletes its outreach row`

The last one is the regression test for G1 — it is the test that would have caught a CASCADE FK. Seed an outreach row, a token row referencing it, run the purge, assert the outreach row is gone **and** the token row is present with `outreach_id IS NULL`.

- [ ] **Step 5: Run**

```bash
pnpm test src/lib/account-offboarding/__tests__/ worker/jobs/account-offboarding/__tests__/
```
Expected: PASS. `table-disposition.test.ts` auto-discovers any migration `CREATE TABLE` carrying `account_id`/`business_id` and **will** fire on both new tables — if it fails with "table missing from inventory", the entries in Step 1 are misplaced or misspelled.

- [ ] **Step 6: Commit**

```bash
git add src/lib/account-offboarding worker/jobs/account-offboarding
git commit -m "feat(#643): offboarding purge retains global suppressions, scrubs token provenance"
```

---

### Task 4: Build-time populate seam (§4.2)

**Files:**
- Modify: `src/lib/solicitation/batch-builder.ts` (`:335`, and `loadCandidateWindow`'s query at `:382-442`)
- Modify: `scripts/ci/tenant-scope-allowlist.ts`
- Modify: `src/lib/solicitation/__tests__/` (the batch-builder suite)

**Blocking edges:** T2.

- [ ] **Step 1: Add the LATERAL join**

`loadCandidateWindow` already joins the **Consent ledger** at `:417-420` on `consent.normalized_handle = c.email` — that is the proof `solicitation_contacts.email` already stores the **Normalized handle**, so there is no re-normalization. Add, after that LEFT JOIN:

```sql
    LEFT JOIN LATERAL (
      ${suppressionMatchSql(tx, tx`c.email`, accountId)}
    ) suppression ON TRUE
```

and select `suppression.source AS suppression_source, suppression.suppressed_at::text AS suppressed_at`. Extend `CandidateWindowRow` with both nullable fields.

**Populate, never pre-filter (§4.2).** Do not add a `WHERE suppression.source IS NULL`. The `suppressed` gate at `restraint-policy.ts:367` is shipped and contract-tested; pre-filtering would make it permanently dead code, and the withhold is what tells the owner *why* their list shrank. There is no cap cost — `evaluateBatch` counts `eligible` as `decision === 'send'` only, so withheld rows never consume `BATCH_CAP`.

- [ ] **Step 2: Populate `toCandidate`**

Replace `suppression: null,` at `:335`:

```typescript
    suppression:
      row.suppression_source !== null && row.suppressed_at !== null
        ? { source: row.suppression_source, suppressedAt: row.suppressed_at }
        : null,
```

`source` stays typed `string` at this boundary (G10) — `restraint-policy.ts:116` is a serialization contract that round-trips through JSONB.

- [ ] **Step 3: Allowlist the deliberately-unscoped global arm**

`pnpm ci:tenant-scope` will flag the new query with `missing account_id or business_id scope`, because the `scope = 'global'` arm matches rows belonging to no account **by design** (§1.1). Add an allowlist entry recording exactly that reason, and bump `ALLOWLIST_BASELINE` in the same change — `tenant-scope-audit.ts:515-517` requires the baseline move so the change is an explicit, reviewed decision.

The entry's reason must say: global suppression is cross-account by design — every account sends from one shared identity, so a recipient's revocation is not any single account's property. Scoping it would silently reintroduce per-account suppression, contradicting locked spec §1.1/D1.

- [ ] **Step 4: Write the tests**

Required (verbatim titles):
- `a suppressed candidate is withheld with reason 'suppressed' carrying the ledger source and timestamp as evidence`
- `a withheld-suppressed candidate does not consume BATCH_CAP`

- [ ] **Step 5: Run**

```bash
pnpm ci:tenant-scope && pnpm test src/lib/solicitation/
```
Expected: both PASS. `ci:tenant-scope` must now be green — if it still fails, the allowlist entry's SQL snapshot does not match the emitted query byte-for-byte.

- [ ] **Step 6: Commit**

```bash
git add src/lib/solicitation/batch-builder.ts src/lib/solicitation/__tests__ scripts/ci/tenant-scope-allowlist.ts
git commit -m "feat(#643): build-time suppression populate — LATERAL lookup, never pre-filter"
```

---

### Task 5: Aggregate purge receipt (§6.3)

**Files:**
- Modify: `worker/jobs/account-offboarding/purge-stages.ts:651-751`
- Modify: `src/lib/account-offboarding/outbox.ts`
- Modify: `src/lib/shared/worker-types.ts:266` region
- Modify: `worker/jobs/account-offboarding/AccountOffboardingEmailWorker.ts:217-219`, `:404-418`
- Modify: `src/lib/notifications/email/templates/account-offboarding.ts:43`
- Modify: `src/lib/notifications/__tests__/email-templates.test.ts`

**Blocking edges:** T3.

- [ ] **Step 1: Count inside the finalize transaction**

In `finalizePurgeInTransaction`, after the `verifyAccountOffboardingPurge` block succeeds and before `enqueueAccountOffboardingEmail`:

```typescript
    // §6.3: silently retaining PII through a purge you told the owner was
    // complete turns a defensible retention basis into a credibility problem.
    // Global suppression rows keep account_id (§6.3), so they are countable
    // here, after the scrub. Token rows are deliberately NOT counted: they are
    // pending opt-out MECHANISMS rather than opt-out records, and their
    // account_id is already NULL by this point (#643 grilling G5).
    const [retained] = await tx<{ retained_count: number }[]>`
      SELECT COUNT(*)::int AS retained_count
      FROM solicitation_suppressions
      WHERE scope = 'global' AND account_id = ${row.account_id}::uuid
    `;
    const retainedSuppressionCount = retained?.retained_count ?? 0;
```

Pass `retainedSuppressionCount` into the existing `enqueueAccountOffboardingEmail` call.

- [ ] **Step 2: Thread through the payload**

Add the field to the `purge_receipt` payload type in `worker-types.ts` (the block at `:266-268` already documents that `purge_receipt` carries its own data because the account row is scrubbed — extend that comment). Add the parameter to the enqueue helper in `outbox.ts`. Read it back in `AccountOffboardingEmailWorker`'s `purge_receipt` fork at `:219` and pass it to the template.

Snapshot-at-purge, not query-at-send: a retried send must render a stable number, and the email worker must stay ignorant of the solicitation domain.

- [ ] **Step 3: Render it**

In `account-offboarding.ts`'s `purge_receipt` branch at `:43`, add one sentence when the count is > 0:

> N opt-out records are retained so those opt-outs continue to be honored.

**No addresses, ever.** When the count is 0, render nothing — do not print "0 opt-out records are retained."

- [ ] **Step 4: Write the test**

Required (verbatim title):
- `the purge receipt reports the retained global suppression count and lists no addresses`

Assert both halves: the sentence appears with the right N, **and** the rendered body contains no `@`-bearing recipient handle from the seeded suppression rows.

- [ ] **Step 5: Run**

```bash
pnpm test src/lib/notifications/ worker/jobs/account-offboarding/ src/lib/account-offboarding/
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add worker/jobs/account-offboarding src/lib/account-offboarding/outbox.ts src/lib/shared/worker-types.ts src/lib/notifications
git commit -m "feat(#643): purge receipt reports retained opt-out records in aggregate"
```

---

### Task 6: Spec amendments + migrations log

**Files:**
- Modify: `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md`
- Modify: `.claude/reference/migrations-log.md`

**Blocking edges:** T2, T4, T5.

- [ ] **Step 1: Record the two amendments in the spec**

Add a dated amendment note under §2.2 (G1) and §6.3 (G2), each stating what changed, why, and that it was locked in #643's grilling. Do not silently edit the locked text — append the note so the original decision and its supersession are both readable.

- [ ] **Step 2: Update the migrations log**

Add 096 and 097 entries following the existing format, and move the recorded head to **097**. Invoke the `new-migration` skill's guidance on what the log entry must contain.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs .claude/reference/migrations-log.md
git commit -m "docs(#643): record G1/G2 spec amendments; migrations log head -> 097"
```

---

## Self-review

**Spec coverage.** §1.1 normalization reuse → T4 Step 1 (joins `c.email`, no re-normalization). §1.2 lookup → T2 fragment. §1.3 channel column → T1 096. §2.1 table + partial uniques + first-write-wins + RLS → T1, T2. §2.2 token table + no-expiry + hash-only → T1. §3.1 closed enum → T2. §3.2 what never suppresses → no code (nothing in this ticket writes from webhooks; #627 owns it) — **deliberate gap, named in non_goals**. §4.1 no version bump → asserted by omission; no constant changes. §4.2 populate → T4. §6.3 purge → T3, T5. §6.4 raw handle → T1 header comment + no hashing anywhere. §9.4 analytics → T1, T2. §9.5 logging → no handle is ever logged; the module logs nothing.

**Placeholder scan.** Three places defer to the codebase rather than inventing: 094's `IN (...)` list (must be copied verbatim — guessing it would silently drop existing event names), `enqueueAnalyticsEvent`'s exact signature, and the `postgres` fragment type name. Each names the file to read and why guessing is unsafe. The alphabetical insertion point in T3 Step 1 is flagged for verification rather than asserted.

**Type consistency.** `suppressionMatchSql` / `recordSuppression` / `RecordSuppressionInput` / `SuppressionSource` / `SuppressionScope` / `SuppressionChannel` are used with identical names in T2 and T4. `retainedSuppressionCount` is identical in T5 Steps 1–3. Column names in the 096 DDL match every query in T2/T3/T4/T5.

**Known tension carried forward:** two intake test titles say `isSuppressed`, but G7 removed that function. T2 Step 3 keeps the titles verbatim (the gate matches them mechanically) and points them at `suppressionMatchSql`. Flagged for review triage rather than silently renamed — changing a `tests_to_add` title is intake drift.
