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
| G1 | `outreach_id` is `REFERENCES solicitation_outreach(id) **ON DELETE SET NULL**` with a partial UNIQUE index | **REVISED in review round 1 (findings 4+6).** The cascade chain is real — `solicitation_outreach` cascades from `solicitation_batches` from `contact_csv_uploads` — so a CASCADE FK would delete retained token rows and break §5.2. But the original no-FK choice left a hole: once `account_id`/`business_id` are scrubbed, nothing can detect a row still carrying a stale `outreach_id`. SET NULL preserves the token, nulls `outreach_id` in the DB for free, and satisfies B9 as literally written. |
| G2 | `solicitation_suppressions` gets **ONE** disposition entry, not two | `TABLE_DISPOSITIONS` is keyed by table name and `verificationQuery` is a `switch (table)` — two entries hit the same arm twice. **Amends §6.3's two-row table.** |
| G11 | Source and scope are paired by a **DB CHECK** | **Added in review round 1 (finding 3).** Without it `owner_manual + global` inserts cleanly, letting one owner suppress a recipient across every tenant — the exact cross-tenant write §1.2 exists to prevent. The enum mapping in §3.1 is total: `owner_manual` is the only `account` source. |
| G12 | Token provenance is **all-set or all-null** for `account_id`/`business_id`/`ask_id`, enforced by CHECK | **Added in review round 1 (finding 6).** Makes a partially-scrubbed row impossible, so the verifier can prove scrub completeness from any one column. Deliberately **excludes** `outreach_id`, which SET NULL may null independently while the account is still live. |
| G14 | The global input variant splits into **`admin_manual`** (actor + note required) and **machine sources** (`createdByUserId?: never`) | **Added in review round 2 (finding 16).** §7.3 requires an actor and note for admin entry, and the purge verifier's global branch only means anything if a global row's actor is provably not an owner. One flat global variant let both be omitted. |
| G13 | Retention is proven by **test**, not by the runtime verifier | **Added in review round 1 (finding 1 — CRITICAL).** `verifyAccountOffboardingPurge` counts violations, so "correctly retained" and "all rows accidentally deleted" both return 0 — it structurally cannot prove survival. The retention guarantee therefore lives in a live-DB test that asserts global rows survive with `account_id` intact. The runtime arm's job is narrowed to what it can actually do: catch surviving `account`-scoped rows. |
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
-- * outreach_id on the token table is ON DELETE SET NULL (#643 grilling G1,
--   revised in review round 1). solicitation_outreach cascades from
--   solicitation_batches from contact_csv_uploads, so a CASCADE FK would delete
--   the retained token rows that §5.2 exists to guarantee. SET NULL keeps the
--   token, nulls the provenance in the DB, and satisfies B9's referential
--   requirement as literally written. ask_id keeps §2.2's NO-FK posture because
--   solicitation_asks has no column we could hang a SET NULL on without the
--   same cascade problem.
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
    CHECK (scope <> 'account' OR account_id IS NOT NULL),
  -- G11: §3.1's source->scope mapping is TOTAL, so enforce it in the DB.
  -- Without this, `owner_manual` + `global` inserts cleanly and one owner can
  -- suppress a recipient across EVERY tenant with no recipient having spoken —
  -- the precise cross-tenant write §1.2 exists to prevent. `owner_manual` is
  -- the only account-scoped source; every other source is recipient- or
  -- ecosystem-authored and therefore global.
  CONSTRAINT solicitation_suppressions_source_scope_pairing
    CHECK (
      (scope = 'account' AND source = 'owner_manual')
      OR (scope = 'global' AND source <> 'owner_manual')
    )
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
  outreach_id UUID REFERENCES solicitation_outreach(id) ON DELETE SET NULL,  -- provenance + idempotent mint key (B4); G1
  sent_at TIMESTAMPTZ NOT NULL,
  redeemed_at TIMESTAMPTZ,             -- first redemption; a second is a no-op success
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- G12: a partially-scrubbed row must be impossible, so the purge verifier can
  -- prove scrub completeness from ANY ONE column. Deliberately EXCLUDES
  -- outreach_id: SET NULL may null it independently, while the account is still
  -- live, the moment its outreach row is deleted for unrelated reasons.
  -- Stated as an IMPLICATION, not a symmetric all-or-none (review round 2,
  -- finding 14): the earlier `(all null) OR (account_id AND business_id set)`
  -- form left `ask_id` unconstrained on the live arm, so
  -- (account set, business set, ask NULL) passed and the constraint did not
  -- mean what its name claimed. A symmetric form would ALSO be wrong here — it
  -- would force ask_id NOT NULL on every live row, which over-constrains a
  -- provenance column the spec lists as optional. What purge verification
  -- actually needs is the one-way guarantee below: scrubbing account_id
  -- implies the rest are scrubbed, so checking account_id/business_id is
  -- sufficient to prove ask_id was scrubbed too.
  CONSTRAINT solicitation_unsubscribe_tokens_provenance_scrub_implication
    CHECK (account_id IS NOT NULL OR (business_id IS NULL AND ask_id IS NULL))
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

Write two suites with **different shapes** — the earlier draft of this plan conflated them, which `ci:live-db-suites` would have rejected (review round 1, finding 7). **Neither suite re-applies migration SQL at runtime.**

- `migration-096-solicitation-suppressions.integration.test.ts` — model on **093/095**: provision once via `pnpm test:db:setup`, take the cross-process lock (`acquireLiveDbLock`, `helpers/live-db-lock.ts`), call `assertSchemaReady`, then **introspect** `pg_indexes` / `information_schema` to assert both partial uniques exist with their exact predicates.

For the CHECK constraints, asserting mere **presence is not enough** (review round 2, finding 19) — a malformed predicate is present and wrong, which is exactly the defect finding 14 caught in this plan's own first revision. Assert `pg_get_constraintdef()` semantics, **and** behaviourally exercise the tuples: for `solicitation_suppressions`, every `(scope, source)` pair in §3.1 accepted and `owner_manual + global` / `complaint + account` rejected; for `solicitation_unsubscribe_tokens`, every provenance permutation of `(account_id, business_id, ask_id)` — a rejected `(NULL, set, NULL)` and `(NULL, NULL, set)`, an accepted `(set, set, NULL)` and `(NULL, NULL, NULL)`. Introspection and inserts inside a rolled-back transaction are reads/writes, not DDL — no lock issue.
- `migration-097-suppression-analytics-events.integration.test.ts` — model on **094**: pure SQL-**text** inspection of the migration file. Read `migration-094-consent-analytics-events.integration.test.ts:1-18` first and copy its shape.

`scripts/ci/live-db-suites-audit.ts:59-69,118-142` allowlists which suites may run DDL, and that file is **outside** `allowed_edit_surface` — so a suite needing an allowlist entry cannot ship in this ticket. Both suites above avoid it by construction.

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
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue'; // NOT analytics/events — that module owns the NAME allowlist, not the writer

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

// Order is §3.1's table order, verbatim — the unit test asserts it.
export const SUPPRESSION_SOURCES = [
  'unsubscribe_one_click',
  'unsubscribe_link',
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
  db: SqlExecutor, // MUST be named `db` — see the tag-name note below
  handleColumn: postgres.PendingQuery<never> | postgres.Fragment,
  accountId: string,
) {
  return db`
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

/**
 * A discriminated union, not a bag of independent fields (G11). The DB CHECK is
 * the last line of defence; this makes the illegal combination unrepresentable
 * at the call site, so `owner_manual` + `global` cannot even be typed.
 */
export type RecordSuppressionInput =
  | {
      // G14: admin_manual is its own variant because §7.3 REQUIRES an actor and
      // a note, and §6.3's verification branch (b) only means anything if a
      // global row's actor is provably an admin. Folding it in with the machine
      // sources let a global row omit both (review round 2, finding 16).
      scope: 'global';
      channel: SuppressionChannel;
      normalizedHandle: string;
      accountId: string | null;
      source: 'admin_manual';
      createdByUserId: string;
      note: string;
    }
  | {
      // Machine-authored: no human actor exists, so `?: never` makes claiming
      // one a type error rather than a silently-accepted field.
      scope: 'global';
      channel: SuppressionChannel;
      normalizedHandle: string;
      /** Provenance only — which account's send produced this. Retained through purge (§6.3). */
      accountId: string | null;
      source: Exclude<SuppressionSource, 'owner_manual' | 'admin_manual'>;
      createdByUserId?: never;
      note?: never;
    }
  | {
      scope: 'account';
      channel: SuppressionChannel;
      normalizedHandle: string;
      /** The SCOPE, not provenance — non-null by construction (§1.2). */
      accountId: string;
      source: 'owner_manual';
      createdByUserId: string;
      note?: string | null;
    };

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

> **Check `enqueueAnalyticsEvent`'s real signature** in `src/lib/analytics/enqueue.ts:8-23` before finalizing — match its parameter names and nullability exactly rather than trusting the shape above. If `businessId`/`distinctId` are optional, omit rather than passing `null`.

> **`postgres.Fragment` may not be the exported type name.** Read the `postgres` types and use whatever `primary-tracked-keyword-sql.ts` uses for the same purpose; if that file returns an untyped fragment, do the same and let inference work.

- [ ] **Step 2: Write the unit suite** (`suppression.test.ts`)

Contract-only, no DB. Assert `SUPPRESSION_SOURCES` contains all seven §3.1 members **in §3.1's table order** (`unsubscribe_one_click` first, then `unsubscribe_link` — review round 1, finding 11), and that `SUPPRESSION_SCOPES` / `SUPPRESSION_CHANNELS` match the spec.

The title `a global row may carry account_id as provenance` does **not** live here — it moved to the live-DB suite (review round 1, finding 9). A type-level assertion cannot catch a reversed or two-directional DB CHECK, which is the failure it exists to detect.

- [ ] **Step 3: Write the live-DB suite** (`suppression.integration.test.ts`)

Name it `*.integration.test.ts` — the name is what puts it in vitest's serialized `integration` project. It must **NOT** apply migration SQL; assert with `assertSchemaReady` instead. Required tests (verbatim titles):

- `ON CONFLICT infers the global partial unique index and a second write is a no-op`
- `ON CONFLICT infers the account partial unique index scoped to account_id`
- `a global row and an account row for the same handle coexist`
- `first write wins: a later complaint does not overwrite an earlier unsubscribe row`
- `recordSuppression writes the solicitation_suppressed analytics row in the same transaction`
- `a repeat recordSuppression mints no duplicate analytics event`
- `the CHECK pairing rejects scope='account' with a NULL account_id`
- `a global row may carry account_id as provenance` — moved here from the unit suite (finding 9). Insert a REAL row with `scope='global'` and a non-null `accountId` and assert it succeeds; this is what catches a reversed CHECK.
- `isSuppressed returns the global row when both a global and an account row match`
- `isSuppressed ignores an account row belonging to a different account`

Add one more, not in the intake but required by G11 (finding 3) — it is new coverage for a new constraint, not a promised-test substitution:
- `the source-scope CHECK rejects owner_manual at global scope`

**Fixture cleanup order (finding 13):** `solicitation_suppressions.account_id` is a NO-ACTION FK to `accounts`, and `live-db-tenant.ts:71-83`'s `cleanupTenantAccount` deletes accounts directly. Every suite that retains a global row MUST delete its suppression fixtures **before** calling that helper, or teardown throws a FK violation.

> The last two titles are fixed by the intake contract and the gate matches them **verbatim**. G7 removed the `isSuppressed` function, so these two exercise `suppressionMatchSql` — keep the titles exactly as written (they name the *behavior*, which is unchanged) and assert against the fragment composed into a probe query.

The first-write-wins test must assert the surviving row's `source` is still `unsubscribe_link` after a `complaint` write returns `null` — not merely that the row count is 1.

- [ ] **Step 4: Run**

```bash
pnpm test src/lib/solicitation/__tests__/suppression.test.ts
pnpm test src/lib/solicitation/__tests__/suppression.integration.test.ts
```
Expected: both PASS. If the `ON CONFLICT` tests throw `there is no unique or exclusion constraint matching the ON CONFLICT specification`, the predicate is not byte-for-byte identical to the index — diff them character by character, do not "fix" by dropping the predicate.

- [ ] **Step 5: Write the fallow suppression for `recordSuppression`**

G6 accepted that this export has no production caller until #644. That is a **known** fallow `unused-export` finding, so write the justified suppression now rather than discovering it in CI (review round 1, finding 8):

`fallow-ignore-next-line` means literally the next line, so the rationale goes **above** the marker and the marker sits alone directly on top of the declaration. An earlier revision of this plan put five rationale lines between the two, contradicting its own adjacency rule (review round 2, finding 8):

```typescript
// G6: this is the single owner of the byte-for-byte ON CONFLICT predicates for
// both partial unique indexes. It ships ahead of its callers (#644 redemption,
// #645 manual paths, #627 webhook sources) so the predicates are proven against
// the real indexes the moment they are created, not three tickets later.
// Remove this suppression when #644 lands the first production caller.
// fallow-ignore-next-line unused-export
export async function recordSuppression(
```

Cross-check the exact placement against a working in-repo example (`src/lib/config/worker.ts:265-266`) before committing. Then run `pnpm ci:fallow` and confirm the finding is gone — #628 burned a round on markers that looked right and were not applied.

- [ ] **Step 6: Commit**

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
    // SCOPE NOTE (G13): this verifier counts VIOLATIONS, so it structurally
    // cannot prove RETENTION — "correctly retained" and "every row wrongly
    // deleted" both return 0. The retention guarantee is therefore a TEST
    // obligation (Task 3 Step 4), never a runtime check.
    //
    // TWO branches, both of which CAN fire:
    // (a) a surviving account-scoped row — the account's own data, must be gone;
    // (b) a retained global row still naming one of this account's users.
    //
    // Branch (b) is vacuous for VALID data — admin users carry
    // users.account_id IS NULL (migration 039), so an admin_manual row never
    // matches — and review round 1 (finding 2) was right that it proves
    // nothing about retention. It is retained anyway (review round 2, finding
    // 15) because it is the only detector for an INVALID row that named an
    // owner as the actor on a global suppression, and because the intake
    // promises a test for exactly that case. Defence-in-depth against a state
    // the type layer now also forbids (G14) is not the same as decoration.
    //
    // One arm rather than two entries: TABLE_DISPOSITIONS is keyed by table
    // name (G2, amending §6.3's two-row table).
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

    // Retained so post-purge redemption still works (§5.2). G12's all-or-none
    // CHECK makes a partially-scrubbed row impossible, so checking account_id
    // and business_id is sufficient to prove ask_id was scrubbed too — without
    // it, a row with account_id NULL but ask_id set would be invisible here
    // (review round 1, finding 6). outreach_id is excluded from that CHECK and
    // is nulled by its own ON DELETE SET NULL (G1).
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
    // G12's all-or-none CHECK covers account_id/business_id/ask_id, so these
    // three MUST be nulled in one statement — nulling a subset throws. Note
    // outreach_id is deliberately absent: its own ON DELETE SET NULL (G1) nulls
    // it when the outreach row cascades away, and it is excluded from the
    // CHECK precisely so that can happen independently.
    await tx`
      UPDATE solicitation_unsubscribe_tokens
      SET account_id = NULL,
          business_id = NULL,
          ask_id = NULL
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

The last one is the regression test for G1 — it is the test that would have caught a CASCADE FK. Seed an outreach row, a token row referencing it, run the purge, assert the outreach row is gone **and** the token row is present with `outreach_id IS NULL` (nulled by the FK's SET NULL, not by the explicit scrub).

**Plus the G13 retention proof — the single most important test in this ticket.** The runtime verifier cannot prove retention (it counts violations, so total deletion also reads as 0), so this test carries the guarantee alone:

- `a global suppression row survives the purge with its account_id intact`

Seed one `global` row and one `account` row for the same handle under the purging account, run the **full production purge path**, then assert: the `account` row is gone, the `global` row is present, and its `account_id` still equals the purged account's id. A test that only asserts "no violations" would pass against a purge that deleted everything.

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

`pnpm ci:tenant-scope` flags the deliberately-unscoped `scope = 'global'` arm with `missing account_id or business_id scope`, because that arm matches rows belonging to no account **by design** (§1.1). Add an allowlist entry recording exactly that reason, and bump `ALLOWLIST_BASELINE` in the same change — `tenant-scope-audit.ts:515-517` requires the baseline move so the change is an explicit, reviewed decision.

**The entry targets `src/lib/solicitation/suppression.ts`, NOT `batch-builder.ts`** (review round 1, finding 5). The audit reads SQL template *text*: `batch-builder`'s outer template contains only the `${suppressionMatchSql(...)}` interpolation, so `solicitation_suppressions` never appears there — the literal `FROM solicitation_suppressions` lives in the fragment's own template. An entry pointed at `batch-builder.ts` would match nothing and then fail the audit's own `unused tenant scope allowlist entry` check (`tenant-scope-audit.ts:31`).

**The fragment's executor parameter MUST be named `db`, not `exec`** (review round 2, finding 5). `ci:tenant-scope` does **not** use `scripts/ci/lib/sql-tag-scan.ts` — it never imports it. It has its own extractor, `extractSqlTagNames` (`tenant-scope-audit.ts:711`), seeded with `new Set(['sql', 'tx', 'db'])` and extended only by names imported from db-server. `exec` is absent, so a template tagged `exec` is **silently skipped**: no violation is reported, and the allowlist entry then fails the unused-entry check. `primaryTrackedKeywordSql` uses `exec` and is invisible to this audit for the same reason — it is not a counter-example, it is the same blind spot. An earlier revision of this plan asserted the opposite; that assertion was wrong.

**Run `pnpm ci:tenant-scope` and read the actual finding before writing the entry.** Do not pre-write it from this plan's prediction; match the audit's reported file/snippet exactly.

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

**Concurrency contract, stated because it is not enforced (review round 1, finding 12).** Content purge, tombstone and finalize are separate transactions (`PurgeWorker.ts:72-89`); finalize locks only the outbox row. A `recordSuppression` landing between the purge stage and this count would be omitted from the receipt, and one landing after verification could leave post-purge residue. **This is not reachable today** — `recordSuppression` has zero production callers (G6) — so the fix is a documented contract, not machinery:

> **Boundary states, named explicitly.** A suppression writer MUST NOT write a `scope='account'` row for an account whose `account_offboardings.status` is any **active teardown** state — `purge_scheduled` included — not merely a terminal one. `purge_scheduled` is precisely the window in which purge runs, and verification completes *before* the transition to `purged`, so a writer gated on "terminal" would sail straight through it. A global row written after the boundary MUST carry `accountId: null`, so it is retained without re-introducing account provenance the purge just removed.

That wording is the fix for review round 2, finding 12 — the earlier "terminal state" phrasing did not serialize anything, because the state that matters is an active one. #644/#645/#627 own honouring this when they land the first callers; this ticket owns stating it.

Record it as a comment at the count site and add it to the ticket's deviations file so it reaches the sibling tickets. **Do NOT add a third advisory lock** — an unordered one reintroduces the ABBA class the existing lock order guards against.

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
