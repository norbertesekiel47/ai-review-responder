# Multi-Location Support — Design Spec

**Date:** 2026-05-06
**Status:** Draft — pending owner review
**Author:** Claude (brainstorming session with Norbert)
**Scope:** Add support for owners managing multiple Google Business Profile
locations under one account, with tier-included quotas, per-location
overage billing, an aggregate dashboard, and hybrid org-default + per-location
notification routing.

---

## 1. Context & motivation

RepWorth's data model is rigidly 1:1: one user → one `businesses` row → one
Google Business Profile location. Owner interviews surfaced strong demand for
multi-location support, especially among small chains and franchise
operators (the Premium tier's stated audience). The current pricing page
already markets multi-location as a Premium feature ("Multi-location setup
available"), but no implementation exists.

Goal: ship multi-location support that
- preserves all existing single-location behavior unchanged,
- bills per-location overage cleanly via Stripe,
- gives owners an aggregate view + a per-location switcher,
- routes approval notifications by hybrid org-default + per-location override,
- leaves room for future franchise-style per-location managers without
  forcing that complexity now.

Non-goals (deferred):
- Per-location managers / RBAC (`location_members` table) — reserved namespace
  documented in migration; not built.
- Account-level SMS budget rollup — per-location budget continues; account
  rollup is a follow-up cost-guard concern.
- Materialized aggregate dashboard view — built only when an account crosses
  ~10 locations and per-location queries start hurting.

---

## 2. Architectural approach

**Chosen: Approach B — thin `accounts` parent over existing `businesses`.**

Rationale: the codebase has ~150+ files referencing `business_id` as the
primary scoping axis. Renaming `businesses → locations` (Approach A) is the
cleanest long-term naming but costs 3–4 weeks of refactor before any new
feature lands. Approach B introduces an `accounts` parent that owns
subscription/quota/owner identity, and lets `businesses` continue to act as
"a single Google Business Profile location" — the conceptual rot is real but
contained and documented.

A third option (Approach C — full multi-tenant org + memberships + RBAC) was
rejected as overkill: the owner explicitly chose "one owner, many locations"
with no per-location user separation.

### 2.1 Naming honesty

The `businesses` table row continues to mean "one Google Business Profile
location." The owner-facing concept of "business / account / parent org" lives
in the new `accounts` table. This will be added to the **Architecture
invariants — NEVER violate** section of `.claude/CLAUDE.md` so new
contributors don't re-discover it.

Future cleanup PR may rename `businesses → locations`; not in this spec.

---

## 3. Schema changes

All new IDs are app-generated UUIDv7 per repo convention. Migration number
follows the next available (currently 033 is the head; this lands as **034**).

### 3.1 New table: `accounts`

```sql
CREATE TABLE accounts (
  id                          UUID PRIMARY KEY,
  owner_user_id               UUID NOT NULL REFERENCES users(id),
  display_name                VARCHAR(255) NOT NULL,

  -- Subscription (moved from businesses)
  subscription_tier           VARCHAR(20) NOT NULL DEFAULT 'standard',
                              -- 'basic' | 'standard' | 'premium' | 'founders'
  subscription_status         VARCHAR(20) NOT NULL DEFAULT 'pending_payment',
                              -- 'pending_payment' | 'active' | 'past_due' | 'cancelled'
  stripe_customer_id          VARCHAR(255),
  stripe_subscription_id      VARCHAR(255),
  trial_ends_at               TIMESTAMPTZ,
  subscription_activated_at   TIMESTAMPTZ,

  -- Multi-location quota state
  locations_included          INTEGER NOT NULL DEFAULT 1,
                              -- snapshotted from tier config at upgrade time
  locations_paid              INTEGER NOT NULL DEFAULT 0,
                              -- mirror of Stripe overage subscription_item quantity
  locations_overage_price_cents INTEGER NOT NULL DEFAULT 2500,
                              -- snapshotted at upgrade so prior commitments survive price changes

  -- Per-account feature flags (e.g., beta gates)
  flags                       JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_accounts_owner ON accounts(owner_user_id);
CREATE INDEX idx_accounts_stripe_customer ON accounts(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
```

### 3.2 Changes to `businesses`

```sql
ALTER TABLE businesses
  ADD COLUMN account_id     UUID REFERENCES accounts(id),
  ADD COLUMN display_label  VARCHAR(255),
                            -- owner-facing nickname per location (e.g., "Downtown Cafe")
  ADD COLUMN is_primary     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN archived_at    TIMESTAMPTZ;
                            -- soft-delete; reviews/responses preserved for audit

-- Migration backfill (greenfield: zero-row tables in production):
-- For each existing business, create one accounts row owned by businesses.onboarded_by,
-- copy subscription_* fields, set is_primary = TRUE.

-- After backfill, mark old subscription columns as deprecated for one release:
COMMENT ON COLUMN businesses.subscription_tier IS
  'DEPRECATED: moved to accounts.subscription_tier. Drop in migration 035.';
COMMENT ON COLUMN businesses.subscription_status IS
  'DEPRECATED: moved to accounts.subscription_status. Drop in migration 035.';
COMMENT ON COLUMN businesses.stripe_customer_id IS
  'DEPRECATED: moved to accounts.stripe_customer_id. Drop in migration 035.';
COMMENT ON COLUMN businesses.stripe_subscription_id IS
  'DEPRECATED: moved to accounts.stripe_subscription_id. Drop in migration 035.';

-- Enforce account_id NOT NULL after backfill:
ALTER TABLE businesses ALTER COLUMN account_id SET NOT NULL;

-- Indexes:
CREATE INDEX idx_businesses_account ON businesses(account_id) WHERE archived_at IS NULL;
CREATE UNIQUE INDEX businesses_account_primary_uniq
  ON businesses(account_id) WHERE is_primary = TRUE AND archived_at IS NULL;
  -- exactly one primary location per active account
```

### 3.3 Changes to `users`

```sql
ALTER TABLE users
  ADD COLUMN account_id UUID REFERENCES accounts(id);

-- Backfill: users.account_id = users.business_id's accounts row.
-- After backfill: users.business_id stays for one release as a deprecated
-- pointer to the user's primary location (used by legacy code paths).
COMMENT ON COLUMN users.business_id IS
  'DEPRECATED: replaced by users.account_id. Will be dropped in migration 035.';
```

### 3.4 Changes to `channel_enrollments`

```sql
ALTER TABLE channel_enrollments
  ADD COLUMN account_id  UUID REFERENCES accounts(id),
  ADD COLUMN location_id UUID REFERENCES businesses(id);
                         -- NULL = org-level default (applies to all locations)
                         -- non-NULL = per-location override

-- Backfill: account_id = (SELECT account_id FROM businesses WHERE id = channel_enrollments.business_id)
-- Existing rows become org-level defaults (location_id stays NULL).

ALTER TABLE channel_enrollments ALTER COLUMN account_id SET NOT NULL;

-- Replace existing UNIQUE (business_id, channel) with per-scope uniqueness.
-- NOTE: the live constraint name must be verified at implementation time.
-- Migration 021 created an inline `UNIQUE (business_id, channel)` (Postgres
-- auto-names it `channel_enrollments_business_id_channel_key`); migration
-- 022 may have replaced it with `channel_enrollments_business_channel_active_key`.
-- Use `\d channel_enrollments` in psql to confirm before running. Both
-- DROP CONSTRAINT statements use IF EXISTS so they are safe to issue both:
ALTER TABLE channel_enrollments DROP CONSTRAINT IF EXISTS channel_enrollments_business_id_channel_key;
ALTER TABLE channel_enrollments DROP CONSTRAINT IF EXISTS channel_enrollments_business_channel_active_key;

CREATE UNIQUE INDEX channel_enrollments_account_channel_scope_uniq
  ON channel_enrollments (account_id, channel, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'))
  WHERE archived_at IS NULL;

-- Replace "one mobile per business" with "one mobile per (account, scope)":
DROP INDEX IF EXISTS channel_enrollments_one_mobile_per_biz;

CREATE UNIQUE INDEX channel_enrollments_one_mobile_per_scope
  ON channel_enrollments (account_id, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'))
  WHERE channel IN ('sms','telegram','whatsapp')
    AND status IN ('pending_verification','verified')
    AND archived_at IS NULL;

-- Deprecation marker on legacy column:
COMMENT ON COLUMN channel_enrollments.business_id IS
  'DEPRECATED: scope is now (account_id, location_id). Will be dropped in migration 035.';
```

### 3.5 Denormalized `account_id` on hot read tables

```sql
ALTER TABLE api_costs              ADD COLUMN account_id UUID REFERENCES accounts(id);
ALTER TABLE notification_deliveries ADD COLUMN account_id UUID REFERENCES accounts(id);
ALTER TABLE approval_audit_log     ADD COLUMN account_id UUID REFERENCES accounts(id);

-- Backfill all from businesses.account_id, then NOT NULL:
ALTER TABLE api_costs              ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE notification_deliveries ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE approval_audit_log     ALTER COLUMN account_id SET NOT NULL;

CREATE INDEX idx_api_costs_account ON api_costs(account_id, created_at);
CREATE INDEX idx_nd_account        ON notification_deliveries(account_id, created_at);
CREATE INDEX idx_audit_account     ON approval_audit_log(account_id, created_at);
```

### 3.6 New table: `account_audit_log`

```sql
CREATE TABLE account_audit_log (
  id           UUID PRIMARY KEY,
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  location_id  UUID REFERENCES businesses(id),
  event_type   TEXT NOT NULL,
                  -- 'location_created', 'location_archived', 'location_promoted_primary',
                  -- 'tier_changed', 'overage_billed', 'subscription_status_changed'
  actor_user_id UUID REFERENCES users(id),
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_account_audit ON account_audit_log(account_id, created_at);
CREATE INDEX idx_account_audit_event ON account_audit_log(event_type, created_at);
```

### 3.7 Tables that **stay scoped to `business_id`** (= location)

`reviews`, `responses`, `approval_links`, `weekly_summaries`,
`ranking_snapshots`, `review_exceptions`, `google_connections`,
`zernio_connections`, `zernio_backfill_runs`. These are intrinsically
per-location data and gain nothing from denormalization.

### 3.8 Reserved namespace (not built)

The migration includes a comment block reserving the future shape for
per-location managers:

```sql
-- FUTURE: location_members for franchise per-location managers.
-- Shape (do not invent a different one):
--   id UUID, account_id UUID, location_id UUID, user_id UUID,
--   role TEXT ('manager'|'viewer'), created_at, archived_at
--   UNIQUE (location_id, user_id) WHERE archived_at IS NULL
```

---

## 4. Billing & Stripe model

### 4.1 Tier configuration

| Tier     | Base/mo  | Locations included | Overage per extra | Multi-loc allowed? |
|----------|----------|--------------------|-------------------|--------------------|
| Basic    | $29      | 1                  | n/a               | No (must upgrade)  |
| Standard | $79      | 1                  | $25               | Yes                |
| Premium  | $199     | 5                  | $20               | Yes                |
| Founders | $19      | 1                  | $25               | Yes (Standard equiv.) |

Tier config lives in `src/lib/accounts/tier-config.ts` as a typed const map,
not in env (env-overridable for local dev only). Stripe price IDs are
resolved from env per environment (`STRIPE_PRICE_STANDARD_BASE`,
`STRIPE_PRICE_STANDARD_OVERAGE`, etc.).

### 4.2 Stripe subscription shape

One Stripe subscription per account, with two subscription items:

1. `tier_base` — quantity 1, price = tier base price.
2. `location_overage` — quantity = `max(0, locations_count - locations_included)`,
   price = tier-specific overage price.

This produces one invoice with two clear line items, automatic proration
when overage quantity changes mid-cycle, and clean tier-specific overage
pricing without webhook gymnastics.

### 4.3 Add-location flow

1. Owner submits the new-location wizard (name, address, Place ID, Zernio
   connection, voice config).
2. Server: `assertCanAddLocation(accountId)` (validates active subscription,
   tier allows multi-loc, no race against another in-flight add).
3. **Single Postgres tx with `SELECT … FOR UPDATE` on accounts row:**
   - Insert `businesses` row with `account_id`, `is_primary = FALSE`,
     `display_label = $userInput`.
   - Insert `account_audit_log` event `location_created`.
   - Insert `job_outbox` row, topic = `update_stripe_overage_quantity`.
4. Outbox worker (`worker/jobs/billing/UpdateStripeOverageWorker.ts`):
   calls `stripe.subscriptionItems.update(overage_item, { quantity: newCount,
   proration_behavior: 'create_prorations' })`.
5. Stripe webhook `customer.subscription.updated` updates
   `accounts.locations_paid` from the live `subscription_items[overage].quantity`.
   Read-only mirror — Stripe is source of truth.
6. Worker enqueues `zernio_initial_backfill` + `sync_reviews` for the new
   location (existing flow).

### 4.4 Remove/archive-location flow

1. Owner archives location from Settings → Locations.
2. Block if `is_primary = TRUE` AND another active location exists with
   "promote first" UX. Block entirely if it is the only active location.
3. Tx: `businesses.archived_at = NOW()`. Insert audit event. Enqueue Stripe
   quantity decrement. All reviews/responses preserved (history visible in a
   read-only "Archived locations" admin tab).
4. Re-add restores from archived state via admin tool.

### 4.5 Tier downgrade with locations > new included quota

Allowed. The downgrade modal shows the new bill (base + overage) and proceeds
on confirm. Example: Premium (5 included) → Standard (1 included) at 6
locations: `$79 base + 5 × $25 overage = $204/mo`. No data loss.

### 4.6 Subscription cancellation

`accounts.subscription_status = 'cancelled'` → all locations enter read-only
(workers skip per existing subscription guard, now hopping
`business → account.subscription_status`). After 30-day grace, locations
soft-archive automatically.

### 4.7 Stripe reconciliation poller

`worker/background/pollers/stripe-locations-reconcile-poller.ts` — runs
hourly. For each account, compares actual non-archived location count
against Stripe `subscription_items[overage].quantity`. Drift > 0 emits a
Sentry alert. Catches missed webhooks and outbox failures without paging.

---

## 5. Dashboard UX

### 5.1 Location switcher

A persistent dropdown in the top nav (cookie-persisted selection per browser
session):

- `All Locations` (aggregate) — default for accounts with > 1 location
- `Downtown Cafe` (location 1)
- `Westside Bakery` (location 2)
- `+ Add location` (CTA)

Single-location accounts never see the switcher (zero-friction for solo
owners).

### 5.2 `All Locations` aggregate view

- **Value summary**: aggregate replies handled, hours saved, dollars saved
  across all active locations.
- **Per-location KPI strip**: small cards, one per location, showing pending
  approval count + recent review count. Click → switches to that location's
  scoped view.
- **Global pending-approval feed**: all locations combined; each row tagged
  with a location chip (`[Downtown]`, `[Westside]`).
- **Charts**: review velocity and ranking, with stacked-by-location toggle.

### 5.3 Per-location view

Identical to today's dashboard, scoped to the selected location. No new code
on this path beyond changing the `useDashboardData` hook to accept a scope
parameter.

### 5.4 Settings page (tabbed)

- **Account** — owner profile, billing portal link, current Stripe
  subscription summary, locations quota usage bar (`3 of 5 included, 0
  overage`).
- **Locations** — list with name, address, Zernio status, voice config link,
  archive button. Primary marked. Re-arrange handles in future iteration.
- **Channels** — org-level defaults at top; per-location override panel
  below collapsed by default. Adding an override clones the default values
  and lets the owner change the handle.
- **Voice** — per-location voice config (tone, products, sample responses).
  Defaults inherited from primary location at creation; no implicit
  inheritance after creation.

### 5.5 Add-location wizard

Four steps:
1. Name + address (Google Place Autocomplete; same component as onboarding).
2. Zernio connection.
3. Voice config — with "copy from existing location" shortcut.
4. Confirm-and-pay — shows new monthly total with a proration line item.

### 5.6 Hook redesign

`useDashboardData(scope: 'all' | LocationId)` — single hook, two modes.
`'all'` resolves to the account ID from session and queries the aggregate
endpoint; `LocationId` queries the existing per-location endpoint.

---

## 6. Notification routing (hybrid)

### 6.1 Resolution algorithm

In `src/lib/notifications/resolve-channels.ts`:

```
function resolveChannels(accountId, locationId) -> ResolvedChannelSet:
  rows = SELECT * FROM channel_enrollments
    WHERE account_id = $accountId
      AND status = 'verified' AND archived_at IS NULL
      AND (location_id = $locationId OR location_id IS NULL)

  groupedByChannel = group rows by channel
  for each channel:
    if a row with location_id = $locationId exists, use that ONE
    else use the row with location_id IS NULL (org-level default)
    else channel is unconfigured for this scope; skip

  return { channels: [...] }
```

Exported from a single file. NotificationWorker imports and calls it; never
inlines the logic. Cached in Upstash with 5-min TTL keyed by
`(account_id, location_id)`; invalidated on any `channel_enrollments` write.

### 6.2 Message template prefix

Every approval template gains a location-prefix line:

- **SMS**: `[Downtown Cafe] New 4★ from Sarah K. Approve: https://…/approve/<token>`
- **Telegram / WhatsApp**: same prefix as the first body line.
- **Email**: subject becomes `[Downtown Cafe] New 4★ review needs approval`;
  body H1 includes location name.

`display_label` from `businesses` is the source. Falls back to
`businesses.name` if `display_label` is NULL.

### 6.3 Inbound SMS edge cases (STOP/START)

- STOP from a phone matched to org-default-only enrollment: marks the
  org-default `unsubscribed`. Existing behavior.
- STOP from a phone matched to multiple enrollments (org-default + one or
  more per-location overrides on the same handle): unsubscribes ALL
  enrollments where `handle = phone` for that account. Compliance over UX.
  Owner re-enrolls per-location after that.
- START: re-enrolls only the org-default row by default (the per-location
  overrides require an explicit re-enroll from settings, since the owner may
  have revoked the override deliberately). If no org-default row exists for
  that handle (i.e., the unsubscribed rows were all per-location overrides),
  START is a no-op — owner must re-enroll explicitly from settings. This
  keeps the rule simple: START never resurrects a per-location override
  silently.

Telegram / WhatsApp use unique chat IDs / WA business numbers, so handle
collisions don't occur on those channels.

### 6.4 SMS daily budget

Per-location budget continues unchanged (`per business_id` today =
`per location` tomorrow). Account-level rollup cap is a follow-up cost-guard
concern and not in this spec.

---

## 7. Approval flow

### 7.1 Token semantics

Unchanged. `approval_links.token_hash` → `responses.id` →
`responses.business_id` (= location_id) → `businesses.account_id`. The chain
is unambiguous.

### 7.2 Approve page (`/approve/[token]`)

Reads the location's `display_label` and renders it as a chip on the page
header so the owner sees which location this approval is for. No new auth or
token logic.

### 7.3 Audit log

`approval_audit_log` already stores `business_id`. We add a denormalized
`account_id` column (Section 3.5) for fast account-level forensics queries.

### 7.4 Cross-location response uniqueness

The existing `responses_non_terminal_review_uniq` partial-unique index
(migration 023) is keyed by `review_id` which is keyed by `business_id`.
Multi-location-safe — the same reviewer at two locations produces two
distinct review rows in two distinct location scopes.

---

## 8. Error handling & edge cases

| Case | Handling |
|---|---|
| Stripe quantity-update outbox job fails | Retry per existing outbox pattern. Dashboard shows "Billing update pending" pill on the new location until webhook reconciles. |
| Tier downgrade with current locations > new included | Allowed. Confirmation modal shows new bill (base + overage). |
| `subscription_status = cancelled` | All locations enter read-only via existing subscription guard, now hopping `business → account.subscription_status`. After 30-day grace, locations soft-archive. |
| Owner attempts to archive primary location | Blocked at API + UI. Requires "promote another location to primary" first, OR cancel subscription. |
| Race: two add-location requests at quota boundary | `SELECT … FOR UPDATE` on accounts row inside the add-location tx. Computes count + bumps Stripe quantity atomically. |
| Stripe webhook + outbox both write `locations_paid` | Idempotent: both compute `max(0, count - included)` from the same Stripe `subscription_items[overage].quantity` source-of-truth. Last write wins, both produce the same value. |
| Location archived with un-posted approvals in flight | Pending response stays `pending_approval` and is no-op'd by publisher worker (existing subscription guard pattern adapted). Owner notified in archive confirmation. |
| Phone number reused across org-default + one location override | STOP unsubscribes both rows for that handle. Compliance-safe. |
| Account at quota = 1 (Standard, 1 included), no overage configured | `assertCanAddLocation` rejects. UI prompts upgrade-or-pay. |
| Voice config divergence | Cloned from primary at creation; no implicit inheritance after creation (each location's voice is independently editable from then on). |

---

## 9. Testing strategy

### 9.1 Unit tests
- `resolveChannels` (`src/lib/notifications/resolve-channels.ts`) — table-driven:
  org-only, per-loc-only, both, neither, archived rows ignored, status=disabled
  rows ignored.
- `computeOverageQuantity(locationsCount, includedQuota)` — boundary cases.
- `assertCanAddLocation(accountId)` — quota exhausted, tier disallows multi-loc,
  account inactive, race against another in-flight add.
- Tier-config lookup helpers.

### 9.2 Integration tests
- Add-location end-to-end with mocked Stripe — verifies outbox row + tx
  atomicity + audit log entry.
- NotificationWorker dispatching to mixed org/per-location enrollments —
  verifies override beats default and only one notification per channel.
- Tier downgrade with overage — verifies `locations_paid` updates correctly
  via Stripe webhook.
- Subscription guard JOIN — workers skip work when
  `account.subscription_status = 'pending_payment' / 'cancelled'`.

### 9.3 Property tests (`fast-check`)
- Account → location count invariants under concurrent add/archive.
- Resolver: for any (account, location), the result set has at most one row
  per channel.

### 9.4 E2E (Playwright)
- Location switcher persistence across nav.
- Add-location wizard happy path.
- Settings tabs render correctly.
- Approval page shows location chip.
- Aggregate dashboard renders with 3+ locations.

### 9.5 Migration test
A fresh-DB test suite verifies the 1-to-1 single-location flow still works:
one `accounts` row + one `businesses` row should be functionally identical
to today's single-business behavior end-to-end (signup → connect Zernio →
review ingest → notification → approval → publish).

---

## 10. Recommendations for clean code & future scaling

1. **Branded ID types.** Introduce `AccountId` and `LocationId` as branded
   types in `src/lib/shared/ids.ts`. Type alias `BusinessId = LocationId` for
   compile-time clarity. Bare `string` IDs become forbidden at boundaries.
   Catches cross-scope bugs the schema can't.

2. **Single chokepoint per concern.**
   - `src/lib/accounts/quota.ts` — `assertCanAddLocation`,
     `computeOverageQuantity`, `currentBillingSnapshot`.
   - `src/lib/notifications/resolve-channels.ts` — the org-default vs
     per-location resolver. One function, table-driven tests.
   - `src/lib/db/account-guard.ts:isAccountActive(accountId)` — replaces
     scattered `business.subscription_status` reads.
   - `src/lib/locations/repo.ts` — `getLocationsForAccount`,
     `getLocationById`, `getActiveLocationCount`. Avoids ad-hoc SQL.

3. **Stripe reconciliation poller** (Section 4.7) — operational safety net.

4. **Location lifecycle audit table** (Section 3.6) — forensic answer to
   "why did billing change?" Cheap now, expensive to bolt on later.

5. **Aggregate dashboard via materialized view** — *deferred*. Per-location
   queries scale fine for 1–10 locations. At ~20+ the All-Locations
   aggregate query starts hurting. Build `account_dashboard_rollup` MV
   refreshed every 5 min when an account crosses 10 locations.

6. **Channel-resolution caching** (Section 6.1) — Upstash cache, 5-min TTL,
   write-invalidation. Removes the resolver query from NotificationWorker's
   hot path.

7. **Naming honesty in `CLAUDE.md`** (Section 2.1) — single paragraph in the
   "Architecture invariants — NEVER violate" block explaining
   `businesses` = location.

8. **Per-account feature flags via `accounts.flags JSONB`** — when shipping
   future multi-location-related changes (or other beta features),
   flag-gate per account so a small cohort opts in first.

9. **Denormalized `account_id` on hot read tables** (Section 3.5) — saves
   JOINs on admin dashboards and audit queries.

10. **Worker subscription-guard ergonomic upgrade.** Add
    `getLocationContext(locationId): { account, location }` helper. One
    import per worker, no JOIN authoring per worker, locks the guard pattern
    in.

11. **Defer `location_members` table but reserve the namespace** (Section
    3.8) — saves the next person from inventing a different shape.

12. **CSV/admin bulk-import for franchise prospects.** Premium tier targets
    multi-loc operators; some will come with 20+ existing locations. Build
    an admin CSV upload (locations + Place IDs + voice config) gated to
    admin role from day 1. Without it, sales has to manually click through
    20 wizards.

---

## 11. Migration plan

Greenfield (no production users yet). Migration **034** lands all schema
changes from Section 3 in one transaction. Migration **035** (next release
cycle) drops the deprecated columns marked in Section 3.

The migration is written **as if production data existed** — the
backfill SQL runs and is idempotent on `ON CONFLICT DO NOTHING`. Reason: dev
databases have seed data, staging may have test data, and the discipline
transfers when this becomes the production migration pattern next time.

Feature flag: `MULTI_LOCATION_ENABLED` env var gates the UI + add-location
endpoint. Schema lands on; UI ships when flag flips. Lets the migration go
out ahead of the user-facing change for safety.

Per project rules (`.claude/CLAUDE.md`: "Supabase migrations — user runs
them"), the SQL is written but the user runs it in the Supabase SQL editor.
Implementation plan will list the migration SQL as one of its first steps.

---

## 12. Out of scope (deferred follow-ups)

- Per-location managers / RBAC (`location_members`).
- Account-level SMS/cost rollup budget cap.
- Materialized aggregate dashboard view (build at ~10+ locations per account).
- Location grouping / hierarchies (e.g., regions for franchise chains).
- Cross-location voice templates (today, voice is fully per-location).
- Post-launch migration tool to convert existing single-location production
  customers to multi-location (greenfield assumption — no live customers to
  migrate today).
- Account-level merging (combining two accounts into one).
- Location transfer between accounts.

---

## 13. Open questions

None at spec time. All four clarifying questions resolved during
brainstorming session:
- Pricing: tier-included quotas + overage.
- Ownership: one owner, many locations.
- Routing: hybrid org-default + per-location override (recommendation).
- Migration scope: greenfield, no live-customer migration concerns.
