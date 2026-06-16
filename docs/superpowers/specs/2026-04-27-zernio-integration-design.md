# Zernio Integration — Design Spec

_Design spec — RepWorth — 2026-04-27_

## What this is

The implementation design for replacing manual copy-paste posting with **Zernio's Google Business Profile API** as the auto-posting backend. Zernio holds Google's GBP API approval; we use their SDK as the publishing layer so we don't wait on Google's own approval queue.

Scope is intentionally narrow: **posting only**. Review ingestion stays on SerpAPI in v1 (re-evaluated in a separate Phase 3 brainstorm). This spec is the source of truth for table shape, route surface, error handling, and rollout posture. Where this spec and `docs/Implementation_Phases_SerpAPI_First.md` Phase 5 disagree, this spec wins for posting; that doc still governs the future direct-Google-OAuth migration if/when GBP approval arrives.

## External prerequisite status (2026-04-27)

- Zernio account: not yet provisioned in production. Accelerate plan + Inbox add-on must be activated before Phase 1.
- SaaS reseller TOS confirmation: **outstanding**. Email draft prepared (see prior brainstorm transcript). Must be in writing before any code merges to main.
- Pilot customer: identified (customer #1 of pre-launch).

Code ships flag-gated off (`ZERNIO_PUBLISHING_ENABLED=false`) regardless of prerequisite status. Real-customer ship gate is conditional on TOS + pilot customer ready.

## Locked decisions (from brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Zernio for posting only in v1** — SerpAPI stays the ingestion source | Demos require SerpAPI regardless (no Zernio connection at prospect stage); vendor concentration risk; `provider_review_id` stability via Zernio is unverified |
| 2 | **Connect happens post-payment from the dashboard, not in the wizard** | Lowest signup friction; dashboard banner uses queued `awaiting_owner_connect` count as activation hook |
| 3 | **Both new self-serve and admin-onboarded businesses see the same connect CTA** | One widget, one rollout. No artificial gating between onboarding modes. |
| 4 | **Hard-block posting when disconnected** (no fall-back to manual) | Manual posting was never viable in practice — required owner credentials. Zernio is effectively the only posting path. |
| 5 | **Single shared Zernio account; one Zernio Profile per RepWorth business** | Matches Zernio's billing model (1 unit = 50 Profiles); single API key; clean per-business revocation |
| 6 | **New `zernio_connections` table** keyed by `business_id` | Avoids muddying `google_connections` (reserved for future direct-Google OAuth path); clean separation of concerns |
| 7 | **`connect_token` (15-min) lives in Redis-backed CSRF state, never persisted in Postgres** | Standard OAuth posture; survives the Google redirect; deleted after use |
| 8 | **Pilot scope: customer #1 only** for 1–2 weeks, then 5–10, then 30+ | Pre-launch — the pilot is the launch. Build correctly, prove with one, ramp. |
| 9 | **`review.new` / `review.updated` webhooks ignored in v1**, counted in Redis for Phase 3 readiness | SerpAPI is the proven ingestion source; webhook reliability not yet validated |
| 10 | **`provider_review_id` mismatch handled via Redis-cached lookup** at post time, no schema change to `reviews` | Smaller blast radius than backfill-on-connect; lookup is one-time per review |

## Non-goals (explicit)

- Multi-location support per RepWorth business — current product is single-location SMBs (CLAUDE.md). One Profile maps to one Location.
- Replacing SerpAPI for review ingestion — separate Phase 3 brainstorm after Phase 2 data
- Owner ability to choose between Zernio and manual posting — manual is an ops escape hatch only, not a user-facing option
- Direct Google OAuth integration — `google_connections` table stays unused, reserved for if/when GBP API approval arrives
- Multi-account Zernio support (i.e. one Zernio account per RepWorth business)
- Per-business Zernio cost guard — flat plan pricing makes this unnecessary in v1

---

## 1. Architecture

### 1.1 Three subsystems, all flag-gated by `ZERNIO_PUBLISHING_ENABLED`

```
┌─────────────────────────────────────────────────────────────────────┐
│              SUBSYSTEM A — CONNECT FLOW (Vercel)                    │
│                                                                     │
│  Owner-initiated headless OAuth flow. Five hops:                    │
│                                                                     │
│  /dashboard banner → /dashboard/connect                             │
│    → POST /api/zernio/connect/start                                 │
│        → Zernio: POST /v1/profiles                                  │
│        → Zernio: GET /v1/connect/google-business?headless=true      │
│        → Returns { authUrl } → window.location = authUrl            │
│                                                                     │
│  Owner OAuths with Google in Zernio's hosted screen                 │
│                                                                     │
│  Zernio redirects to                                                │
│    GET /api/zernio/connect/callback?state=...&connect_token=...     │
│        → Validates state from Redis, fetches list-locations         │
│        → Stashes connect_token + locations in Redis                 │
│        → 302 → /dashboard/connect/select-location                   │
│                                                                     │
│  Owner picks location → POST /api/zernio/connect/select-location    │
│        → Zernio: POST select-location → permanent IDs               │
│        → Postgres tx: INSERT zernio_connections (status='active')   │
│                       INSERT job_outbox (drain_pending_owner_       │
│                                          connect)                   │
│        → Redirect to /dashboard                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│        SUBSYSTEM B — POSTING PATH (Worker — existing path)          │
│                                                                     │
│  ApprovalService.approve() → job_outbox(publish_response)           │
│    → OutboxPoller → ResponsePublisherWorker                         │
│        ├─ Load business + response + zernio_connections             │
│        ├─ Subscription guard (existing)                             │
│        ├─ IF active connection exists:                              │
│        │    Lookup Zernio review_id (Redis cache → API)             │
│        │    POST /v1/accounts/{id}/gmb-reviews/{id}/reply           │
│        │      → 200 OK → status='posted'                            │
│        │      → 409 already-exists → status='posted' (idempotent)   │
│        │      → 401/403 auth → mark connection 'disconnected',      │
│        │         transition response 'awaiting_owner_connect',      │
│        │         enqueue notify_owner_reconnect                     │
│        │      → 5xx/429/network → throw, BullMQ retries 3x          │
│        │         exhausted → same as auth path (graceful)           │
│        │      → 404 review-not-found → status='failed' +            │
│        │         review_exceptions(zernio_review_id_mismatch)       │
│        └─ IF NO active connection:                                  │
│             status='awaiting_owner_connect',                        │
│             enqueue notify_owner_reconnect                          │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│       SUBSYSTEM C — WEBHOOK INGRESS (Worker — Stripe pattern)       │
│                                                                     │
│  POST /ingress/zernio (Fastify, rawBody, on Railway)                │
│    1. Verify HMAC-SHA256 (X-Zernio-Signature) — 401 mismatch        │
│    2. claimInboundEvent('zernio', X-Zernio-Event-Id, type, body)    │
│         → duplicate → 200 OK                                        │
│    3. Switch on body.event:                                         │
│       account.disconnected                                          │
│         → mark connection disconnected (FOR UPDATE)                 │
│         → enqueue notify_owner_connection_lost                      │
│       account.connected                                             │
│         → log only (defensive — state already set in connect flow)  │
│       review.new / review.updated                                   │
│         → INCRBY zernio_event_seen:{type}:{date}                    │
│         → ignored otherwise (Phase 3 readiness signal)              │
│       webhook.test                                                  │
│         → log + 200                                                 │
│    4. Mark inbound_events processed                                 │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 Architecture invariants preserved

| CLAUDE.md invariant | How this design preserves it |
|---|---|
| **Vercel serves UI only.** All SLA-critical compute on Railway | Connect flow API routes are short-lived, sub-second Zernio HTTP calls (closer to existing `/api/auth/signup` Supabase pattern than to LLM/SerpAPI batch). Webhook ingress + posting are on Railway. |
| **Transactional outbox for all async work** | Connect-finalize INSERTs `zernio_connections` + `drain_pending_owner_connect` outbox in same tx. Webhook handler INSERTs `notify_owner_connection_lost` in same tx as state mutation. ResponsePublisher branches all use `BEGIN ... COMMIT` envelopes. |
| **Third-party ingress terminates on Railway** | `POST /ingress/zernio` lives in `worker/ingress/zernio.ts`, never proxied through Next.js. |
| **No auto-posting** | Zernio is only called inside `ResponsePublisherWorker`, which only runs on outbox entries created by `ApprovalService.approve()`. Architecturally impossible to bypass approval. |
| **Approval tokens never stored raw** | Unchanged. Zernio integration touches the `responses` table after approval; approval token logic untouched. |
| **ReviewSource contract** | Unchanged. SerpAPI remains the only ReviewSource in v1. Zernio is a `Publisher`, not a `ReviewSource`. |
| **Auth scope is app-enforced** | Connect routes scope all `zernio_connections` operations by `business_id` from Supabase session. Webhook handler resolves business from `zernio_account_id` (which is server-issued, not user-supplied). |
| **Use Node.js native crypto** | HMAC verification via `node:crypto.createHmac` + `crypto.timingSafeEqual`. CSRF state via `crypto.randomBytes(32).toString('hex')`. |

### 1.3 What gets retired vs preserved

**Retired from happy path:**
- `awaiting_manual_post` status as a default outcome of `ResponsePublisherWorker`
- `buildManualPostEmailHtml` automatic firing
- The internal sales-partner email after approval

**Preserved as emergency escape hatch:**
- `awaiting_manual_post` status enum value (still in CHECK constraints + partial unique index)
- `buildManualPostEmailHtml` template (callable from admin "Manually post" action)
- Admin UI button for manual posting (covered in Section 3.5)

**Preserved unchanged:**
- SerpAPI ingestion (`ReconciliationPoller` + `ReviewSyncWorker` every 60 min)
- `ApprovalService.approve()` and the approval flow
- `checkSubscription()` early-exit guards
- All other workers

---

## 2. Schema (migration 026)

### 2.1 New table: `zernio_connections`

**Critical correction from spec review**: this codebase does NOT have the `pg_uuidv7` extension installed (per the explicit note at `001_initial_schema.sql:29-31`). All existing tables use `DEFAULT gen_random_uuid()` and the application generates UUIDv7 via the `uuidv7` npm package. This table follows the same pattern.

```sql
CREATE TABLE zernio_connections (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  -- Zernio identifiers (all populated post-location-selection)
  zernio_profile_id     TEXT NOT NULL,        -- our workspace inside Zernio (1-per-business)
  zernio_account_id     TEXT NOT NULL,        -- the connected Google account
  zernio_location_id    TEXT NOT NULL,        -- the chosen GBP location

  -- Connection state machine: pending → active → disconnected
  status                TEXT NOT NULL CHECK (status IN ('pending','active','disconnected')),

  -- Ops / audit fields
  connected_at          TIMESTAMPTZ,          -- set when status first becomes 'active'
  disconnected_at       TIMESTAMPTZ,          -- set when status flips to 'disconnected'
  disconnect_reason     TEXT,                 -- 'webhook_event' | 'auth_error_on_post' | 'manual_owner' | 'manual_admin'
  last_error            TEXT,                 -- last Zernio API error body (truncated 500 chars)
  last_error_at         TIMESTAMPTZ,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One active or pending connection per business. Disconnected rows kept
-- for audit (soft-delete model) so use a partial unique index.
CREATE UNIQUE INDEX zernio_connections_one_active_per_business
  ON zernio_connections (business_id)
  WHERE status IN ('pending','active');

-- Webhook lookup: account.disconnected events arrive with zernio_account_id;
-- need to find the business fast.
CREATE INDEX zernio_connections_account_id_idx
  ON zernio_connections (zernio_account_id)
  WHERE status = 'active';

-- Ops query: "show me all currently-broken connections"
CREATE INDEX zernio_connections_disconnected_idx
  ON zernio_connections (business_id)
  WHERE status = 'disconnected';

COMMENT ON TABLE zernio_connections IS
  'Per-business mapping to Zernio profile + Google Business location. '
  'Created lazily during /dashboard/connect flow, never via createBusinessTx.';

-- RLS: enabled to match repo posture. All other first-class tables enable RLS
-- in 001_initial_schema.sql:479-488. Production access is server-side via the
-- service role (which bypasses RLS), but enabling RLS is the deny-by-default
-- safety net if any client-key path ever touches this table by accident.
ALTER TABLE zernio_connections ENABLE ROW LEVEL SECURITY;
-- No policies = deny-all for non-service-role connections, matching the
-- existing posture for tables like notification_deliveries.

-- =====================================================================
-- Round-15: durable finalize_unknown incidents.
--
-- The Redis pending-marker `status='finalize_unknown'` is volatile — a
-- 15-min TTL would expire silently, letting the owner start a SECOND
-- Zernio flow while a half-committed account from the first flow may
-- still exist on Zernio's side. Persist the incident here so:
--   (1) connect/start blocks new flows when an unresolved incident exists
--   (2) ops has a queryable surface for reconciliation backlog
--   (3) the record survives Redis restarts/evictions
-- =====================================================================
CREATE TABLE zernio_finalize_incidents (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  zernio_profile_id     TEXT NOT NULL,
  flow_id               TEXT NOT NULL,            -- matches connect_pending.flowId
  finalize_unknown_at   TIMESTAMPTZ NOT NULL,
  resolved_at           TIMESTAMPTZ,
  resolution            TEXT CHECK (resolution IN ('account_found','no_account','manual_admin_other')),
  resolution_notes      TEXT,
  zernio_account_id     TEXT,                     -- populated on resolution='account_found'
  zernio_location_id    TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One unresolved incident per business at a time. Blocks new connect/start
-- attempts until ops resolves the incident (sets resolved_at).
CREATE UNIQUE INDEX zernio_finalize_incidents_one_unresolved_per_business
  ON zernio_finalize_incidents (business_id)
  WHERE resolved_at IS NULL;

-- Ops query: "show me all unresolved finalize incidents for triage"
CREATE INDEX zernio_finalize_incidents_unresolved_idx
  ON zernio_finalize_incidents (created_at DESC)
  WHERE resolved_at IS NULL;

ALTER TABLE zernio_finalize_incidents ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE zernio_finalize_incidents IS
  'Durable record of Zernio selectLocation calls with unknown outcome '
  '(timeout/abort/5xx). connect/start blocks while business has any '
  'unresolved row. Resolved by admin reconciliation procedure (runbook).';
```

### 2.2 Widen `responses.status` column AND extend the partial unique index

**Critical correction from spec review**: `responses.status` is `VARCHAR(20)` per migration 001 line 210 — the new value `awaiting_owner_connect` (22 chars) would be silently truncated or fail the constraint. Migration 026 must widen the column FIRST.

```sql
-- Step 1: widen the column. TEXT to match status columns elsewhere
-- (job_outbox.status, review_exceptions.status, etc. are all TEXT in
-- migration 001). VARCHAR(20) was an accidental narrow choice.
ALTER TABLE responses ALTER COLUMN status TYPE TEXT;

-- Step 2: drop and re-create the partial unique index from migration 023
-- with the new non-terminal status added.
DROP INDEX IF EXISTS responses_one_non_terminal_per_review;

CREATE UNIQUE INDEX responses_one_non_terminal_per_review
  ON responses (review_id)
  WHERE status IN (
    'pending_approval',
    'approved',
    'edited',
    'awaiting_manual_post',
    'awaiting_owner_connect'   -- NEW
  );

COMMENT ON INDEX responses_one_non_terminal_per_review IS
  'Enforces "at most one non-terminal response per review" invariant. '
  'awaiting_owner_connect is non-terminal — owner reconnect transitions '
  'it to posted (success) or admin-action terminates it as failed.';
```

App-side status enum (CLAUDE.md update):

```
'pending_approval' | 'approved' | 'edited' | 'superseded' |
'awaiting_manual_post' | 'awaiting_owner_connect' |
'posted' | 'failed'
```

### 2.3 Notification dedup index

Mirrors migration 024's pattern for `admin_manual_post`:

```sql
CREATE UNIQUE INDEX notification_deliveries_owner_reconnect_dedup
  ON notification_deliveries (response_id, template)
  WHERE response_id IS NOT NULL AND template = 'owner_reconnect_required';
```

For `owner_connection_lost` (business-scoped, not response-scoped):

**Critical correction from spec review**: `notification_deliveries.sent_at` is nullable per migration 001 line 337 — the claim-before-send pattern (`ResponsePublisherWorker.ts:164-181`) inserts the row with `sent_at IS NULL` and updates it after Resend acks. Postgres unique indexes treat each NULL as distinct, so a `(sent_at::date)` predicate would NOT dedupe concurrent claims (all would have NULL `sent_at`). Use `created_at::date` instead — which is `NOT NULL DEFAULT NOW()`:

```sql
CREATE UNIQUE INDEX notification_deliveries_connection_lost_dedup
  ON notification_deliveries (business_id, template, (created_at::date))
  WHERE template = 'owner_connection_lost';
```

This caps owner connection-lost emails at one per business per day, regardless of how many times the webhook fires, and works correctly with the claim-before-send pattern.

### 2.4 No schema changes to `inbound_events`, `job_outbox`, `reviews`, or `businesses` — but new `job_outbox` topics MUST be registered

- `inbound_events.provider` is free-form text — `'zernio'` slots in alongside `'stripe'`, `'resend'`, etc.
- `reviews` table unchanged — `provider_review_id` mismatch is handled via Redis-cached lookup at post time (Section 4.3).
- `businesses` table unchanged — connection state lives in `zernio_connections`, not on the business row.

**Critical correction from spec review**: `job_outbox.topic` is technically free-form text in the schema, but `OutboxPoller.ts:117` looks up each topic in a `topicToQueue` registry — unregistered topics are marked `failed` with a Sentry alert. Every new topic in this spec needs:
1. A queue name added to `worker/shared/queue-names.ts` (or wherever `QUEUE_NAMES` lives)
2. A queue instance created in `worker/queues.ts`
3. An entry in the `topicToQueue` map (in `OutboxPoller.ts` or its config)
4. A `Worker` instance registered in `worker/index.ts` consuming that queue
5. A handler function exported from `worker/jobs/<Name>Worker.ts`
6. A typed payload in `src/lib/shared/worker-types.ts`

For this spec, three new outbox topics map to two new queue/worker pairs.

**Critical correction from spec review**: `OutboxPoller` (`worker/jobs/OutboxPoller.ts:117`) dispatches by `entry.topic` looking up `topicToQueue` (`worker/queues.ts:78`). The map currently keys by `QUEUE_NAMES.*` strings AND any topic that doesn't match a registered string is marked `failed` with a Sentry alert. So three outbox topics → three explicit map entries (the two notify topics both alias to the same queue):

| Outbox topic (`job_outbox.topic`) | Queue name (`QUEUE_NAMES.*`) | Worker file | Payload type |
|---|---|---|---|
| `drain_pending_owner_connect` | `DRAIN_OWNER_CONNECT` | `worker/jobs/DrainOwnerConnectWorker.ts` | `{ business_id: string }` |
| `notify_owner_reconnect` | `SEND_OWNER_EMAIL` (aliased) | `worker/jobs/OwnerEmailWorker.ts` | `{ kind: 'reconnect_required', response_id: string, business_id: string }` |
| `notify_owner_connection_lost` | `SEND_OWNER_EMAIL` (aliased) | `worker/jobs/OwnerEmailWorker.ts` | `{ kind: 'connection_lost', business_id: string }` |

`worker/queues.ts` `topicToQueue` map needs three new entries:

```typescript
export const topicToQueue: Record<string, Queue> = {
  // ...existing 12 entries unchanged...
  [QUEUE_NAMES.DRAIN_OWNER_CONNECT]: queues.drainOwnerConnect,
  // Topic strings aliased to the OwnerEmail queue — the discriminated payload
  // (`payload.kind`) tells OwnerEmailWorker which handler to invoke.
  ['notify_owner_reconnect']: queues.sendOwnerEmail,
  ['notify_owner_connection_lost']: queues.sendOwnerEmail,
};
```

**Critical correction from spec review**: cannot reuse `SEND_NOTIFICATION` queue / `NotificationWorker` for these. Verified against actual code:
- `SendNotificationPayload` (`src/lib/shared/worker-types.ts:27`) requires both `response_id` AND `business_id` — `notify_owner_connection_lost` has no response_id.
- `loadNotificationContext` (`worker/jobs/notification/context.ts:73`) explicitly skips when `response.status !== 'pending_approval'` — `notify_owner_reconnect` carries a response in `awaiting_owner_connect`, so it would be silently dropped.

The new `OwnerEmailWorker` is a discriminated payload router with `kind` as the discriminant. Two handlers (`reconnect_required`, `connection_lost`) own their own context loaders, share the existing claim-before-send delivery primitives in `src/lib/notifications/email.ts`. New `SendOwnerEmailPayload` type added to `src/lib/shared/worker-types.ts`:

```typescript
export type SendOwnerEmailPayload = BasePayload & (
  | { kind: 'reconnect_required'; response_id: string; business_id: string }
  | { kind: 'connection_lost'; business_id: string }
);
```

**OwnerEmailWorker behavior — both handlers MUST honor owner_email_bounced** (matches existing pattern in `WeeklySummaryWorker.ts:60` and `worker/jobs/notification/dispatch.ts:74`):

```
For BOTH kinds (reconnect_required, connection_lost):
  1. Load business row (id, name, owner_email, owner_email_bounced, subscription_status, updated_at)
     If not found → markOutboxFailed('business_not_found'), return
  2. Subscription guard (existing checkSubscription helper) → if blocked, complete outbox, return
     -- Round-final note: `checkSubscription(status, updatedAt, workerType)` from
     -- src/lib/shared/subscription-guard.ts requires a workerType from a typed
     -- union. Existing values include 'publisher', 'notification', etc.
     -- Extend the WorkerType union in subscription-guard.ts to add:
     --   - 'owner_email'  (for OwnerEmailWorker — both reconnect_required + connection_lost)
     --   - 'drain'        (for DrainOwnerConnectWorker)
     -- Both new types follow the SAME branch logic as 'publisher' / 'notification':
     -- skip on 'cancelled', skip on 'past_due' beyond grace, skip on 'pending_payment'.
     -- (No new behavior — just enum membership for the same gating rules.)
  3. owner_email_bounced check:
       if (business.owner_email_bounced) {
         logger.log(`Business ${business_id} owner email bounced — skipping owner email`);
         await markOutboxCompleted(outboxId, outboxAttempt);
         return;
       }
  4. Kind-specific:
     'reconnect_required':
       - Load response by response_id, scope by business_id
       - If response.status != 'awaiting_owner_connect' → skip + complete outbox
         (status changed since enqueue — connection might have been restored
          and a parallel publisher already posted, or response was failed/superseded)
     'connection_lost':
       - No response context needed (business-scoped notification)
  5. Claim-before-send via the existing notification_deliveries pattern
     (uses the dedup indexes from Section 2.3)
  6. Send via sendOwnerEmail (template-specific HTML builder)
  7. Backfill external_message_id + sent_at
  8. markOutboxCompleted
```

Without the bounced check, retries against a hard-bounced address would generate Resend-side bounce events on every send — both wasting cost and re-firing the bounce-detection webhook in `worker/ingress/resend.ts`.

**Also critical**: every `INSERT INTO job_outbox` in this spec must include `aggregate_type` and `aggregate_id` columns (NOT NULL per migration 001 line 305). Updated INSERT shape:

```sql
INSERT INTO job_outbox (
  id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
) VALUES (
  ${uuidv7()},                   -- app-side via uuidv7 npm package; pg has no pg_uuidv7
  'drain_pending_owner_connect',
  'business',                    -- aggregate types in use: 'review','response','business','demo'
  ${business_id},
  ${jsonb({ business_id })},
  0, 5
)
```

Mappings for the new topics:
- `drain_pending_owner_connect` → `aggregate_type='business'`, `aggregate_id=business_id`
- `notify_owner_reconnect` → `aggregate_type='response'`, `aggregate_id=response_id`
- `notify_owner_connection_lost` → `aggregate_type='business'`, `aggregate_id=business_id`

### 2.5 Migration runner

Per CLAUDE.md `feedback_supabase_migrations.md` rule: ship `supabase/migrations/026_zernio_publishing.sql`; **user runs it via Supabase SQL editor**. Never apply migrations programmatically.

---

## 3. Connect flow (Vercel)

### 3.1 New files

| File | Purpose |
|---|---|
| `src/app/(authenticated)/dashboard/connect/page.tsx` | Authenticated landing page. SSR loads current `zernio_connections` row, renders state-appropriate UI. |
| `src/app/(authenticated)/dashboard/connect/select-location/page.tsx` | Post-OAuth location chooser. SSR loads cached locations from Redis. |
| `src/components/dashboard/ConnectGoogleBanner.tsx` | Banner on `/dashboard` showing connection state + queued response count. **Round-final correction**: actual location is `src/components/dashboard/*` (matches existing `Charts.tsx`, `ReviewsList.tsx`, `ValueSummary.tsx`), NOT under `src/app/...`. The dashboard page is `<DashboardContent />` which is a CLIENT component using `useDashboardData()` hook — banner consumes data via that hook, not via SSR. |
| API extension | `src/lib/dashboard/types.ts` + the dashboard data API endpoint | Extend the existing dashboard API response shape to include: `zernioConnection: { status: 'none'\|'pending'\|'active'\|'disconnected'\|'finalize_unknown', queuedReconnectCount: number, hasUnresolvedIncident: boolean, lastDisconnectReason?: string }`. The `useDashboardData()` hook itself does NOT need modification — only its backing API route. The route reads `zernio_connections` joined with `responses WHERE status='awaiting_owner_connect'` count + `zernio_finalize_incidents WHERE resolved_at IS NULL`. **NOT in the original scope summary — round-final addition.** |
| `src/app/api/zernio/connect/start/route.ts` | POST — generates Zernio Profile, CSRF state, returns `authUrl`. |
| `src/app/api/zernio/connect/callback/route.ts` | GET — Zernio's redirect target. Validates state, fetches locations, redirects to picker. |
| `src/app/api/zernio/connect/select-location/route.ts` | POST — finalizes, INSERTs `zernio_connections` + drain outbox in one tx. |
| `src/app/api/zernio/connect/cancel/route.ts` | POST — owner-initiated cancel of an in-flight OAuth (round-6 spec-review addition). Deletes `connect_pending`, `connect_state`, `connect_locations` Redis keys + best-effort Zernio Profile cleanup. Reachable from `/dashboard/connect` "Cancel & restart" button. |
| `src/app/api/zernio/disconnect/route.ts` | POST — owner-initiated soft disconnect of an established connection. |
| `src/lib/zernio/client.ts` | Typed wrapper around Zernio HTTP API (auth header injection, error classes, **request timeouts via AbortController** — see Section 4.6). |
| `src/lib/zernio/connect-state.ts` | Redis-backed CSRF state store (15-min TTL, single-use). Also exports the shared Lua helpers used by the connect/select-location/cancel routes (`luaCASToFinalizing`, `luaCASRevertToOauth`, `luaCASToFinalizeUnknown`, `luaDeletePendingByFlowIdAnyStatus`, `luaCASCancel`, `luaTokenCAS`) so all routes use the SAME script bodies — round-15 fix for the previous block-scoped `const` referenced across handlers. |
| `src/lib/zernio/types.ts` | Connection state + Zernio API response types. |
| `src/lib/zernio/errors.ts` | Error class hierarchy: `ZernioAuthError` (401/403, no commit), `ZernioValidationError` (400 documented pre-mutation rejects, no commit — round-14 addition), `ZernioTransientError` (5xx / 429 / timeout / network — outcome unknown for non-idempotent endpoints), `ZernioPermanentError` (round-16: non-retryable client error on idempotent endpoints), `ZernioReviewNotFoundError`, `ZernioReplyAlreadyExistsError`. **Round-final: also exports `ZernioRouteError`** — a route-layer typed error with `statusCode` and `code` fields (mirrors `AuthError(message, statusCode)` pattern from `src/lib/db/auth.ts:91`). All `throw new Http409(...)` references in this spec resolve to `throw new ZernioRouteError(409, 'finalize_unknown_admin_required')` etc. The route handler wrapper catches `ZernioRouteError` and converts to `NextResponse.json({ error: err.code }, { status: err.statusCode })` — repo idiom from `src/lib/auth/route-helpers.ts:52`. |

### 3.2 OAuth state machine (detailed)

```
1. POST /api/zernio/connect/start
   ─────────────────────────────────
   CSRF (FIRST, before any DB or external work — round 7 correction):
     await assertSameOrigin(request)  -- src/lib/shared/csrf.ts:8
   Auth: requireRole(request, 'owner') → returns AppUser (src/lib/db/auth.ts)
     IF user.businessId === null: 403 unscoped_owner
     const businessId = user.businessId
     const userId = user.id   -- round-10: declared explicitly so Step C placeholder snippet is copy-safe
   Subscription guard: skip if subscription_status != 'active' → 403

   Round-9 correction: AppUser uses camelCase `businessId` (TS convention),
   not snake_case `business_id` (DB column). Earlier spec drafts wrote
   `user.business_id` which would resolve to undefined at runtime. The
   null check is mandatory — `requireRole` does not guarantee a non-null
   business scope (e.g. an owner row whose business was deleted).

   Two-layer concurrency defense:
   - Short-lived request lock (30s TTL): prevents two simultaneous clicks
     from both calling POST /v1/profiles before either persists state.
   - Long-lived pending-flow marker (15-min TTL, matches Zernio
     connect_token validity): prevents a SECOND click during the OAuth
     window from creating a duplicate Profile while the first flow is
     still mid-OAuth.

   Critical correction from spec review: the request lock alone leaves a
   ~15-min window where the user could go idle in OAuth, click "Connect"
   again in another tab, pass the DB idempotency check (no zernio_connections
   row exists yet — that's only inserted at finalize), and create a second
   orphan Zernio Profile. The pending marker closes that window.

   Step A — Pending-flow marker check (long-lived, 15-min TTL):
     pendingKey = `connect_pending:${businessId}`
     existingPending = await redis.get(pendingKey)
     if (existingPending) {
       // A start was issued in the last 15 min; tell user to either complete
       // that flow or wait for it to expire.
       return 409 { error: 'connect_pending', expires_at: ... }
     }

   Step B — Request lock (short-lived, 30s TTL, token-stamped):
     lockKey   = `connect_lock:${businessId}`
     lockToken = crypto.randomBytes(16).toString('hex')
     acquired  = await redis.set(lockKey, lockToken, 'EX', 30, 'NX')
     if (!acquired) return 429 connect_in_progress

     // Variables declared up-front so the catch block at Step F can reach
     // them regardless of which step threw (round-6 maintainability fix).
     const startedAt = Date.now();
     // Round-9: per-flow identifier embedded in pending-marker JSON. Steps E and F
     // do CAS-on-flowId so concurrent cancel/restart can't be undone by this
     // flow's later writes, and this flow's failure can't nuke a newer flow.
     const flowId = crypto.randomBytes(16).toString('hex');
     let createdState: string | null = null;
     let createdProfileId: string | null = null;
     let placeholderRaw: string | null = null;

     try {
       // Step B-bis — DB idempotency check BEFORE planting the marker.
       // If an active/pending zernio_connections row already exists, return
       // 409 immediately. Doing this BEFORE Step C avoids planting a marker
       // that would then leak for 15 min on the early return.
       //
       // Critical correction from spec review (round 5): the previous spec
       // planted the placeholder before the DB check, then bailed with 409
       // on the early return — leaving the marker in Redis.
       const existing = await sql`
         SELECT 1 FROM zernio_connections
         WHERE business_id = ${businessId} AND status IN ('pending','active')
         LIMIT 1
       `;
       if (existing.length > 0) {
         return 409 already_connected;
       }

       // Step B-tris (round-15) — block if a finalize_unknown incident is
       // unresolved. Otherwise the owner could create a SECOND Zernio flow
       // while a half-committed account from the first MAY still exist.
       // The DB row's partial unique index makes this check cheap (single
       // index lookup).
       const unresolvedIncident = await sql`
         SELECT 1 FROM zernio_finalize_incidents
         WHERE business_id = ${businessId} AND resolved_at IS NULL
         LIMIT 1
       `;
       if (unresolvedIncident.length > 0) {
         return 409 finalize_unknown_admin_required;
       }

       // Step C — PLACEHOLDER pending marker, BEFORE any external call.
       // Critical timing fix: if Zernio's POST /v1/profiles hangs past the
       // 30s lock TTL, a second click would otherwise pass the Step A check
       // (no marker yet) and create a duplicate Profile.
       //
       // Round-9: marker carries flowId so Steps E and F can CAS on it.
       placeholderRaw = JSON.stringify({
         flowId,
         userId,
         started_at: startedAt,
         status: 'starting',
       });
       await redis.set(pendingKey, placeholderRaw, 'EX', 900);
       // 15 min — matches Zernio connect_token TTL

       try {
         // Step D — Start work (now safely behind the pending marker).
         // Each side effect assigns to its outer-scoped variable IMMEDIATELY
         // so the catch block can clean up partial state regardless of
         // which sub-step threw.

         //   POST /v1/profiles → returns { profileId }
         const { profileId } = await zernioClient.createProfile({ name: ... });
         createdProfileId = profileId;

         //   Generate CSRF state, write to Redis (connect_state:{state})
         const state = crypto.randomBytes(32).toString('hex');
         await redis.setex(`connect_state:${state}`, 900, JSON.stringify({
           businessId, profileId, userId, createdAt: startedAt,
         }));
         createdState = state;

         //   GET /v1/connect/google-business → returns { authUrl }
         const { authUrl } = await zernioClient.startConnect({
           profileId, state, redirectUrl: `${NEXT_PUBLIC_APP_URL}/api/zernio/connect/callback`,
         });

         // Step E — Update pending marker with profileId + state.
         //
         // Round-9 correction: previously this was an unconditional SET,
         // which would clobber a NEWER pending marker if a cancel/restart
         // happened between Step C and here. Now CAS on placeholderRaw —
         // overwrite ONLY if the stored value is still EXACTLY our
         // placeholder JSON. If it's been replaced (cancel/restart) or
         // already updated by something else, leave it alone and treat
         // the start as superseded.
         const fullMarker = JSON.stringify({
           flowId, userId, started_at: startedAt, profileId, state,
           status: 'oauth_in_progress',
         });
         const luaCASUpdate = `
           if redis.call("get", KEYS[1]) == ARGV[1] then
             return redis.call("set", KEYS[1], ARGV[2], "EX", ARGV[3])
           else
             return false
           end`;
         const updateResult = await redis.eval(
           luaCASUpdate, 1, pendingKey,
           placeholderRaw,        // expected current value
           fullMarker,            // new value
           '900'                  // TTL
         );
         if (!updateResult) {
           // Pending marker was overwritten/deleted by a newer flow during
           // Step D. Our flow is superseded — don't return authUrl, throw
           // so Step F's CAS-delete runs (which will also see the mismatch
           // and leave the newer flow alone).
           throw new Error('flow_superseded_during_start');
         }

         return { authUrl };
       } catch (startErr) {
         // Step F — Failure cleanup. Round-9 correction: CAS on placeholderRaw
         // (or fullMarker if Step E succeeded) so we ONLY delete OUR flow's
         // marker. If a newer flow has overwritten it, leave it alone.
         //
         // We try BOTH possible "expected values" because we don't know if
         // Step E ran successfully before whatever later step threw.
         const luaCASDel = `
           if redis.call("get", KEYS[1]) == ARGV[1] then
             return redis.call("del", KEYS[1])
           else
             return 0
           end`;
         if (placeholderRaw) {
           await redis.eval(luaCASDel, 1, pendingKey, placeholderRaw).catch(() => {});
         }
         // (If Step E completed, the marker now holds the fullMarker JSON.
         //  Step E's success means we returned authUrl and never entered
         //  this catch — so we don't need to also try fullMarker as the
         //  expected value. The only path into Step F with a fullMarker in
         //  Redis is Step E's "throw flow_superseded_during_start" — but
         //  in that case Step E itself didn't update the marker, so
         //  placeholderRaw is still the right expected value.)

         if (createdState) {
           await redis.del(`connect_state:${createdState}`).catch(() => {});
         }
         if (createdProfileId) {
           await zernioClient.deleteProfile(createdProfileId).catch(() => {});
         }
         throw startErr;
       }
     } finally {
       // Compare-and-delete on the request lock (token-stamped, see above).
       const lua = `
         if redis.call("get", KEYS[1]) == ARGV[1] then
           return redis.call("del", KEYS[1])
         else
           return 0
         end`;
       await redis.eval(lua, 1, lockKey, lockToken).catch(() => {});
     }

   The pending marker is cleared in three places:
   - SUCCESS: deleted in select-location route after zernio_connections
     row is committed (Section 3.2 step 3)
   - START-FLOW FAILURE: deleted in Step F catch above
   - CALLBACK / OAUTH FAILURE: callback route deletes on state-mismatch
     or other terminal error
   - SUPERSEDED: if owner explicitly clicks "cancel & restart" on the
     dashboard, a separate /api/zernio/connect/cancel route deletes the
     marker and any associated Zernio Profile (best-effort cleanup)
   - LAST RESORT: auto-expires after 900s

   (DB idempotency check moved up to Step B-bis above — runs BEFORE the
    pending-marker plant so 409 early returns don't leak the marker.)

   Zernio: POST /v1/profiles
     body: { name: '{ZERNIO_PROFILE_ID_PREFIX}{businessId}' }
     → returns { profileId }

   CSRF state:
     state = crypto.randomBytes(32).toString('hex')
     redis.setex(`connect_state:${state}`, 900, JSON.stringify({
       businessId, profileId, userId, createdAt: Date.now()
     }))

   Zernio: GET /v1/connect/google-business
     ?profileId={profileId}
     &headless=true
     &redirectUrl={NEXT_PUBLIC_APP_URL}/api/zernio/connect/callback
     &state={state}
   → returns { authUrl }

   Return { authUrl } → client window.location = authUrl

2. GET /api/zernio/connect/callback?state={state}&connect_token={token}
   ──────────────────────────────────────────────────────────────────────
   Atomic claim of connect_state (prevents replay AND survives errors
   for retry — see fix below):

   Critical correction from spec review (round 6): the previous version
   deleted connect_state immediately after lookup, before re-auth and
   list-locations. If any later step failed, the user could not retry
   the callback (state gone) AND connect_pending still blocked restart.
   Fix: use Redis GETDEL for atomic single-use claim, then on ANY callback
   failure clear connect_pending so the user can restart from scratch.

   stored = await redis.getdel(`connect_state:${state}`)  -- atomic GET+DEL
   IF !stored: 401 invalid_or_expired_state
   parsed = JSON.parse(stored)

   try {
     // Pending marker verification. Round-11 correction: redis.get returns
     // a string — must JSON.parse before accessing fields. Earlier draft
     // referenced pending.state etc. on the raw string (always undefined).
     const pendingRaw = await redis.get(`connect_pending:${parsed.businessId}`)
     IF !pendingRaw: 410 flow_cancelled
     let pending
     try { pending = JSON.parse(pendingRaw) }
     catch { return 410 malformed_pending_marker }
     IF pending.state !== state: 410 superseded_by_newer_flow
     IF pending.profileId !== parsed.profileId: 410 profile_mismatch
     IF pending.status !== 'oauth_in_progress': 409 unexpected_state

     // Re-auth
     IF supabaseSession.userId !== parsed.userId: 403 mismatch

     // Zernio: list locations (timeout per Section 4.6)
     locations = await zernioClient.listLocations({ connectToken: token })

     // Round-11 correction: re-verify pending marker AFTER list-locations.
     // listLocations can take seconds, during which a cancel/restart could
     // overwrite connect_pending. Without this re-check we'd happily write
     // connect_locations + set the picker cookie pointing at a stale flow,
     // and the user's NEXT click on the new picker would finalize the WRONG
     // flow. Re-read, parse, require flowId/state/profileId all still match.
     const pending2Raw = await redis.get(`connect_pending:${parsed.businessId}`)
     IF !pending2Raw: 410 flow_cancelled_during_listing
     let pending2
     try { pending2 = JSON.parse(pending2Raw) }
     catch { return 410 malformed_pending_marker }
     IF pending2.flowId !== pending.flowId
       OR pending2.state !== state
       OR pending2.profileId !== parsed.profileId:
       return 410 superseded_during_listing
     -- (NO cookie set, NO connect_locations write on superseded path.)

     // Stash for picker. Round-10: include flowId AND state so
     // select-location can verify the connect_pending marker still
     // belongs to THIS flow before finalizing (cross-route flow identity).
     newSessionId = crypto.randomBytes(16).toString('hex')
     await redis.setex(
       `connect_locations:${newSessionId}`, 600,
       JSON.stringify({
         flowId: pending2.flowId,        // re-verified value
         state,                          // OAuth state
         connect_token: token,
         profileId: parsed.profileId,
         businessId: parsed.businessId,
         userId: parsed.userId,
         locations,
       })
     )

     // Set HttpOnly signed cookie (Path=/, see round-2 fix)
     // 302 → /dashboard/connect/select-location
   } catch (cbErr) {
     // Callback failure cleanup. Round-7 + round-8 corrections combined:
     //
     // A stale OAuth callback (from a "cancel & restart"-superseded flow)
     // must NOT delete the NEWER pending marker. The check has to be
     // ATOMIC — round-7's GET-then-DEL was still racy: between our GET
     // and DEL, a cancel/restart could delete flow A's marker AND plant
     // flow B's; our DEL would then nuke flow B.
     //
     // Round-8 fix: read the current value once, then pass it as the
     // expected-value into a Lua compare-and-delete. The DEL fires only
     // if the stored value still byte-matches what we read. (Same pattern
     // as the Step-1 lock token CAS, applied to the full JSON blob.)
     //
     // connect_state is already gone (GETDEL above) so replay is still blocked
     // regardless of whether we delete the pending marker here.
     const pendingRaw = await redis.get(`connect_pending:${parsed.businessId}`).catch(() => null);
     if (pendingRaw) {
       let shouldDelete = false;
       try {
         const p = JSON.parse(pendingRaw);
         if (p.state === state && p.profileId === parsed.profileId) {
           shouldDelete = true;
         }
       } catch { /* malformed JSON — leave the marker, will auto-expire */ }

       if (shouldDelete) {
         // Atomic CAS: only delete if value is still EXACTLY pendingRaw.
         // If a parallel flow overwrote the marker between our GET and
         // this DEL, the comparison fails and we leave it alone.
         const luaCAS = `
           if redis.call("get", KEYS[1]) == ARGV[1] then
             return redis.call("del", KEYS[1])
           else
             return 0
           end`;
         await redis.eval(luaCAS, 1, `connect_pending:${parsed.businessId}`, pendingRaw)
           .catch(() => {});
       }
     }
     // Best-effort Zernio Profile cleanup (orphan from Step 1) — always safe
     // because the profile was created for THIS flow, not the newer one.
     if (parsed.profileId) {
       await zernioClient.deleteProfile(parsed.profileId).catch(() => {});
     }
     throw cbErr;
   }

   (Pending marker is NOT deleted on success here — kept until select-
    location finalizes. This lets the user retry select-location if it
    fails without restarting OAuth from scratch.)

   (The list-locations call, connect_locations stash, and cookie set are
    folded into the try-block above. Cookie config: HttpOnly, Secure,
    SameSite=Lax, Path=/ — round-2 correction; signed; 10-min TTL.)

3. POST /api/zernio/connect/select-location { locationId }
   ─────────────────────────────────────────────────────────
   Critical correction from spec review: this route writes the durable
   zernio_connections row binding a Google account+location to a business.
   The signed cookie alone is insufficient — a stolen/borrowed session
   cookie could finalize against the WRONG business under the same browser
   profile (XSS, shared device, copy-paste). Per the auth-scope invariant,
   re-authenticate explicitly here.

   Auth gate (BEFORE reading cookie or calling Zernio):
     await assertSameOrigin(request)            -- src/lib/shared/csrf.ts:8
     user = await requireRole(request, 'owner') -- existing helper

   Read cookie → sessionId
   stored = await redis.get(`connect_locations:${sessionId}`)
   IF not found: 401 expired_session

   Verify the session belongs to THIS user AND THIS business:
     IF stored.userId !== user.id: 403 user_mismatch
     IF stored.businessId !== user.businessId: 403 business_mismatch

   (Note: the connect_locations Redis blob, planted in step 2 of the callback
    handler, MUST include userId and businessId — the callback handler already
    has both in scope from the connect_state lookup. This is a correction to
    the step-2 stash payload to make this verification possible.)

   Validate locationId in stored.locations[] → 400 invalid_location

   Critical correction from spec review (round 6): two parallel POST
   select-location requests with the same sessionId could both call
   Zernio before either persists the zernio_connections row. The DB
   unique index (`zernio_connections_one_active_per_business`) would
   reject one INSERT, but the second already-called Zernio's
   select-location which finalizes server-side state — leaving an
   orphan finalize at Zernio.

   Round-7 correction: the lock must encompass the ENTIRE finalize
   sequence (Zernio call + DB tx + Redis cleanup + cookie clear), not
   just the Zernio call. Otherwise a second submit can enter after
   Zernio finalizes but before the DB row is written, hit Zernio again,
   then both fight over the unique index.

   ┌── connect_finalize:{sessionId} lock held through ALL of the below ──┐
   │
   │  finalizeKey   = `connect_finalize:${sessionId}`
   │  finalizeToken = crypto.randomBytes(16).toString('hex')
   │  acquired = await redis.set(finalizeKey, finalizeToken, 'EX', 60, 'NX')
   │  if (!acquired) return 429 finalize_in_progress
   │  try {
   │    // Round-10 correction: verify connect_pending still belongs to
   │    // OUR flow before finalizing. A cancel/restart racing with
   │    // finalize would otherwise let a canceled flow complete (with
   │    // accountId already finalized at Zernio).
   │    //
   │    // Round-11 correction: ALSO atomically transition pending.status
   │    // from 'oauth_in_progress' to 'finalizing' BEFORE the Zernio call.
   │    // Cancel route refuses to delete 'finalizing' flows, so the user
   │    // can't pull the rug out mid-finalize. Lua does:
   │    //   - GET pending, parse, verify flowId matches stored.flowId
   │    //   - verify status is 'oauth_in_progress' (or already 'finalizing'
   │    //     for retry safety)
   │    //   - SET pending with status='finalizing' + same TTL
   │    //   - return 1 on success, 0 on flow mismatch, -1 on no-marker
   │    pendingRaw = await redis.get(`connect_pending:${stored.businessId}`)
   │    if (!pendingRaw) return 410 flow_cancelled
   │    let pending; try { pending = JSON.parse(pendingRaw) }
   │      catch { return 410 malformed_pending_marker }
   │    if (pending.flowId !== stored.flowId) return 410 flow_superseded
   │
   │    // Atomic CAS-update to 'finalizing' state via Lua + cjson.
   │    // Round-13 correction: ONLY allow oauth_in_progress → finalizing.
   │    // Allowing finalizing → finalizing (round-11's "retry safety")
   │    // would let a second submit double-call Zernio's non-idempotent
   │    // selectLocation after a lock TTL expiry. If we see finalizing,
   │    // refuse and surface 409 — owner must cancel (which itself
   │    // refuses to delete finalizing flows; finalize_unknown
   │    // reconciliation is the escape hatch — see post-Zernio block below).
   │    const luaCASToFinalizing = `
   │      local raw = redis.call("get", KEYS[1])
   │      if not raw then return -1 end
   │      local ok, p = pcall(cjson.decode, raw)
   │      if not ok then return -2 end
   │      if p.flowId ~= ARGV[1] then return 0 end
   │      if p.status ~= "oauth_in_progress" then
   │        return -3                    -- already finalizing or other state
   │      end
   │      p.status = "finalizing"
   │      return redis.call("set", KEYS[1], cjson.encode(p), "EX", ARGV[2])
   │    `
   │    const transitioned = await redis.eval(
   │      luaCASToFinalizing, 1,
   │      `connect_pending:${stored.businessId}`,
   │      stored.flowId, '900'
   │    )
   │    // Eval returns the SET result ("OK") on success, 0 on flow mismatch,
   │    // negative numbers on missing/malformed/wrong-status — handle each.
   │    if (transitioned === -1) return 410 flow_cancelled
   │    if (transitioned === 0) return 410 flow_superseded
   │    if (transitioned === -2) return 409 malformed_pending_marker
   │    if (transitioned === -3) return 409 finalize_in_progress
   │      // Round-13: pending was already 'finalizing' (or 'finalize_unknown'),
   │      // meaning a previous attempt is in flight or stuck. Refusing
   │      // here prevents a second non-idempotent Zernio call. Owner
   │      // must wait or admin must run reconciliation to clear the
   │      // stuck marker (see runbook).
   │
   │    // Round-12 correction: explicit recovery for the 'finalizing'
   │    // state. Without it, any throw between the CAS-to-finalizing
   │    // above and a successful DB commit leaves the marker stuck in
   │    // 'finalizing' until 15-min TTL — owner can't cancel/restart.
   │    let accountId
   │    try {
   │      Zernio: POST /v1/connect/google-business/select-location
   │        header: X-Connect-Token: {stored.connect_token}
   │        body: { locationId }
   │      → returns { accountId } (assigned to outer-scoped accountId)
   │    } catch (zernioErr) {
   │      // Round-13 + round-14 corrections: distinguish OUTCOME-KNOWN
   │      // errors (Zernio explicitly guarantees no commit) from OUTCOME-
   │      // UNKNOWN errors (anything else — selectLocation is non-
   │      // idempotent so we assume the worst when in doubt).
   │      //
   │      // Round-14: 5xx responses are NOT safe to revert. A 5xx after
   │      // Zernio's internal commit but before response serialization
   │      // is plausible. Limit "outcome known" to:
   │      //   - ZernioAuthError (401/403): Zernio rejected at auth layer,
   │      //     definitely no business-logic execution
   │      //   - ZernioValidationError (400 with documented pre-mutation
   │      //     reject codes): Zernio rejected before commit
   │      // Everything else (5xx, network errors, timeouts, abort) →
   │      // finalize_unknown.
   │      const isOutcomeKnown =
   │           zernioErr instanceof ZernioAuthError
   │        || zernioErr instanceof ZernioValidationError
   │
   │      if (isOutcomeKnown) {
   │        // Revert finalizing → oauth_in_progress so owner can retry/cancel.
   │        const luaCASRevert = `
   │          local raw = redis.call("get", KEYS[1])
   │          if not raw then return -1 end
   │          local ok, p = pcall(cjson.decode, raw)
   │          if not ok then return -2 end
   │          if p.flowId ~= ARGV[1] then return 0 end
   │          if p.status ~= "finalizing" then return -3 end
   │          p.status = "oauth_in_progress"
   │          return redis.call("set", KEYS[1], cjson.encode(p), "EX", ARGV[2])
   │        `
   │        await redis.eval(luaCASRevert, 1,
   │          `connect_pending:${stored.businessId}`,
   │          stored.flowId, '900'
   │        ).catch(() => {})
   │      } else {
   │        // OUTCOME UNKNOWN — Zernio may have a half-committed account
   │        // we don't know about. Round-15: persist a DURABLE incident
   │        // row. The DB row's partial unique index also blocks future
   │        // connect/start attempts (see step 1 Step B-tris below).
   │        //
   │        // Round-16 correction: ALWAYS attempt the Redis 7-day update
   │        // even if the DB insert fails. Otherwise a transient DB error
   │        // would recreate the expiry hole — Redis stays at the
   │        // original 900s TTL of the 'finalizing' state and silently
   │        // unblocks the owner after 15 min. Order: Redis FIRST (cheap
   │        // failsafe), DB SECOND (durable record). High-severity
   │        // Sentry alert on DB failure since the durable block is missing.
   │        const finalizeUnknownAt = new Date()
   │
   │        // Step 1: Redis transition + 7-day TTL bump (cannot fail silently).
   │        // Round-17 correction: previous draft used a `...see below...`
   │        // placeholder for the Lua body. Inline the actual body here,
   │        // and CHECK the return value — values -1/-2/-3/0 indicate
   │        // failure modes that must NOT be silently treated as success.
   │        const luaCASUnknown = `
   │          local raw = redis.call("get", KEYS[1])
   │          if not raw then return -1 end
   │          local ok, p = pcall(cjson.decode, raw)
   │          if not ok then return -2 end
   │          if p.flowId ~= ARGV[1] then return 0 end
   │          if p.status ~= "finalizing" then return -3 end
   │          p.status = "finalize_unknown"
   │          p.finalize_unknown_at = ARGV[3]
   │          return redis.call("set", KEYS[1], cjson.encode(p), "EX", ARGV[2])
   │        `
   │        let redisMarkedUnknown = false
   │        try {
   │          const result = await redis.eval(luaCASUnknown, 1,
   │            `connect_pending:${stored.businessId}`,
   │            stored.flowId, '604800', finalizeUnknownAt.toISOString()
   │          )
   │          // Lua SET returns "OK" on success. Non-string negative numbers
   │          // mean we couldn't transition (marker missing/malformed/wrong
   │          // flow/wrong status). Any of those is a failure of the Redis
   │          // failsafe — page ops since the durable block may be missing.
   │          redisMarkedUnknown = (result === 'OK')
   │          if (!redisMarkedUnknown) {
   │            Sentry.captureMessage('zernio_finalize_unknown_redis_cas_failed', {
   │              level: 'error',
   │              tags: { business_id: stored.businessId, lua_result: String(result) },
   │              extra: { flowId: stored.flowId },
   │            })
   │          }
   │        } catch (redisErr) {
   │          // Even Redis call failed. We have NO Redis-side record either.
   │          // Page ops immediately — durable DB row is the only fallback.
   │          Sentry.captureMessage('zernio_finalize_unknown_no_record', {
   │            level: 'fatal',
   │            tags: { business_id: stored.businessId, kind: 'redis_failure' },
   │            extra: { flowId: stored.flowId, redisErr: String(redisErr) },
   │          })
   │        }
   │
   │        // Step 2: Durable DB incident row (preferred record, but Redis
   │        // already protects against silent expiry above).
   │        let incidentPersisted = false
   │        try {
   │          await sql`
   │            INSERT INTO zernio_finalize_incidents (
   │              id, business_id, zernio_profile_id, flow_id,
   │              finalize_unknown_at
   │            ) VALUES (
   │              ${uuidv7()}, ${stored.businessId}, ${stored.profileId},
   │              ${stored.flowId}, ${finalizeUnknownAt}
   │            )
   │          `
   │          incidentPersisted = true
   │        } catch (incidentErr) {
   │          const code = (incidentErr as { code?: string }).code
   │          if (code === '23505') {
   │            // Existing unresolved incident already covers this business.
   │            incidentPersisted = true
   │          } else {
   │            // DB persistence failed but Redis 7-day marker is in place
   │            // (or its own failure was already paged above). Surface
   │            // separately so ops knows the DB record is missing.
   │            Sentry.captureMessage('zernio_finalize_unknown_db_insert_failed', {
   │              level: 'error',
   │              tags: { business_id: stored.businessId },
   │              extra: { flowId: stored.flowId, dbErr: String(incidentErr) },
   │            })
   │          }
   │        }
   │
   │        // Always-on Sentry alert (fires regardless of which persistence
   │        // succeeded; the *_no_record / *_db_insert_failed / *_redis_cas_
   │        // failed alerts above are additive for the worst cases).
   │        Sentry.captureMessage('zernio_finalize_unknown', {
   │          level: 'error', tags: { business_id: stored.businessId },
   │          extra: {
   │            flowId: stored.flowId,
   │            error: zernioErr.message,
   │            incidentPersisted,
   │            redisMarkedUnknown,
   │          },
   │        })
   │
   │        // Round-15 fix: throw a CONTROLLED 409 instead of bubbling the
   │        // raw transient error (which would surface as a generic 500).
   │        // The 409 carries the admin-required state contract that the
   │        // rest of the spec relies on.
   │        throw new ZernioRouteError(409, 'finalize_unknown_admin_required')
   │      }
   │      throw zernioErr  // outcome-known revert path: bubble up normally
   │    }
   │
   │    (Begin Postgres tx — see below)
   │
   │    // Round-10: CAS-delete connect_pending by flowId so we don't
   │    // nuke a newer flow if one slipped in between Zernio finalize
   │    // and here.
   │    // Round-13: must use luaDeletePendingByFlowIdAnyStatus (defined
   │    // in the post-accountId catch block below) — the marker is in
   │    // 'finalizing' state at this point, and luaCASCancel would
   │    // refuse to delete it. The any-status helper still safely
   │    // checks flowId so newer flows aren't touched.
   │    await redis.eval(luaDeletePendingByFlowIdAnyStatus, 1,
   │      `connect_pending:${stored.businessId}`,
   │      stored.flowId
   │    ).catch(() => {})
   │    await redis.del(`connect_locations:${sessionId}`).catch(() => {})
   │    Clear cookie
   │    Return 200
   │  } finally {
   │    await redis.eval(luaCAS, 1, finalizeKey, finalizeToken).catch(() => {});
   │  }
   │
   └─────────────────────────────────────────────────────────────────────┘

   (Lock TTL bumped from 30s → 60s to comfortably cover Zernio call +
   DB tx + 3 Redis ops + cookie set, even on a slow network.)

   Round-12: pending-marker `finalizing` state has explicit recovery on
   ALL failure modes:
   - Pre-accountId throw  → CAS-revert finalizing → oauth_in_progress
   - Post-accountId throw → best-effort deleteAccount + CAS-clear pending
   Without this, a finalize crash would leave the marker stuck in
   `finalizing` until 15-min TTL, blocking cancel/restart for the owner.

   Begin Postgres tx (inside the lock + post-accountId recovery):
     try {
       INSERT INTO zernio_connections (
         id, business_id, zernio_profile_id, zernio_account_id,
         zernio_location_id, status, connected_at
       ) VALUES (
         ${uuidv7()}, stored.businessId, stored.profileId, accountId,
         locationId, 'active', NOW()
       )
       INSERT INTO job_outbox (
         id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
       ) VALUES (
         ${uuidv7()},
         'drain_pending_owner_connect',
         'business',
         stored.businessId,
         jsonb_build_object('business_id', stored.businessId),
         0, 5
       )
       Commit
     } catch (dbErr) {
       // Round-12 correction: AFTER Zernio committed accountId server-side
       // but BEFORE our durable DB row exists. Two failure modes:
       //
       //   (a) Unique violation on zernio_connections_one_active_per_business
       //       — another flow finalized while we were mid-Zernio-call.
       //       Best-effort delete OUR Zernio account (it's an orphan; the
       //       DB row points at the OTHER flow's accountId), then clear
       //       pending and surface 409.
       //
       //   (b) Any other DB error (pool exhaustion, statement timeout,
       //       worker crash recovery scenario). Same recovery: delete OUR
       //       Zernio account so it doesn't linger, clear pending, surface
       //       500. We do NOT keep accountId for retry because Zernio's
       //       select-location is non-idempotent — re-calling it would
       //       create a SECOND finalize. Cleaning up + asking the owner
       //       to start over is safer than half-finalized state.
       await zernioClient.deleteAccount(accountId).catch(() => {})
       // Clear pending on this path — accountId is gone, there's nothing
       // left to finalize.
       //
       // Round-13 correction: must NOT use luaCASCancel here. That script
       // refuses status='finalizing' (returns -1), but at this point our
       // pending marker IS finalizing — using luaCASCancel would leave
       // the marker stuck and the owner unable to restart. Use the shared
       // status-agnostic helper from src/lib/zernio/connect-state.ts (round-15:
       // hoisted into module scope so the success path above can also use it):
       //
       //   export const luaDeletePendingByFlowIdAnyStatus = `
       //     local raw = redis.call("get", KEYS[1])
       //     if not raw then return 0 end
       //     local ok, p = pcall(cjson.decode, raw)
       //     if not ok then return 0 end
       //     if p.flowId == ARGV[1] then
       //       return redis.call("del", KEYS[1])
       //     else
       //       return 0
       //     end
       //   `
       const cleared = await redis.eval(luaDeletePendingByFlowIdAnyStatus, 1,
         `connect_pending:${stored.businessId}`,
         stored.flowId
       ).catch(() => 0)
       if (cleared !== 1) {
         // Pending marker was either gone or for a different flow.
         // Surface as Sentry breadcrumb but don't block the response;
         // the owner is already getting an error.
         Sentry.addBreadcrumb({
           category: 'zernio.finalize',
           message: 'pending_marker_not_cleared_post_accountid_failure',
           data: { flowId: stored.flowId, cleared },
         })
       }
       const isUniqueViolation = (dbErr as { code?: string }).code === '23505'
       throw isUniqueViolation
         ? new ZernioRouteError(409, 'already_connected_by_parallel_flow')
         : dbErr
     }

   (Redis cleanup + cookie clear + 200 return are folded into the
    finalize-lock block above per round-7 correction. They MUST run
    inside the lock so a second submit can't race past Zernio finalize
    while we're mid-cleanup.)

4. POST /api/zernio/connect/cancel  (round-8 addition — full algorithm)
   ─────────────────────────────────────────────────────────────────────
   Owner-initiated cancel of an in-flight OAuth flow. Reachable from the
   "Cancel & restart" button on /dashboard/connect. Mutates Redis state
   AND best-effort Zernio state, so it requires the same auth+CSRF
   posture as connect/start and disconnect.

   CSRF (FIRST, before any side-effecting work):
     await assertSameOrigin(request)  -- src/lib/shared/csrf.ts:8

   Auth: requireRole(request, 'owner') → returns AppUser
     IF user.businessId === null: 403 unscoped_owner
     businessId = user.businessId  -- always scoped to caller's own business

   Read pending: pendingRaw = await redis.get(`connect_pending:${businessId}`)
   IF !pendingRaw: 200 { cancelled: false, reason: 'no_in_flight_flow' }
     -- not an error; nothing to cancel is success

   Verify the pending flow belongs to THIS user:
     -- Round-13: catch parse errors. A malformed value should not 500;
     -- treat as "stale/unknown marker — needs admin clear" and surface
     -- a controlled 409 so the owner gets a clear error message.
     let parsed
     try { parsed = JSON.parse(pendingRaw) }
     catch {
       Sentry.captureMessage('zernio_malformed_pending_marker_in_cancel', {
         level: 'warning',
         tags: { business_id: businessId },
       })
       return 409 { cancelled: false, reason: 'malformed_pending_marker' }
     }
     IF parsed.userId !== user.id: 403 user_mismatch
     -- defensive: same business, different owner-session shouldn't be
     -- possible in v1 (one owner per business) but the check is cheap

   Atomic CAS-delete the pending marker BY flowId, REFUSING 'finalizing'
   flows (round-10 + round-11 corrections combined).
   Round-9 used a byte-match CAS, but if connect/start's Step E upgraded
   placeholder → full marker for the SAME flow between our GET and our
   CAS, the byte-match would fail even though it's still the SAME flow.
   Round-11 adds: cancel must REFUSE to delete a flow that's already in
   the 'finalizing' state — otherwise a finalize already in flight could
   complete (creating the durable DB connection) while cancel reports
   success.

     luaCASCancel = `
       local raw = redis.call("get", KEYS[1])
       if not raw then return 0 end                  -- nothing to cancel
       local ok, p = pcall(cjson.decode, raw)
       if not ok then return 0 end                   -- malformed: leave alone
       if p.flowId ~= ARGV[1] then return 0 end      -- different flow
       if p.status == "finalizing" then return -1 end       -- finalize in flight, refuse
       if p.status == "finalize_unknown" then return -2 end -- needs admin reconcile, refuse
       return redis.call("del", KEYS[1])
     `
     deleted = await redis.eval(luaCASCancel, 1,
       `connect_pending:${businessId}`,
       parsed.flowId
     )
     -- deleted === 1: actually cancelled this flow
     -- deleted === 0: marker was missing OR for a different flow (no-op)
     -- deleted === -1: refused — finalize is in flight (round-11)
     -- deleted === -2: refused — finalize_unknown, requires admin (round-14).
     --                Owner cancel must NOT delete this state because it
     --                erases evidence (profileId, flowId, started_at)
     --                that admin needs to list Zernio accounts and
     --                determine whether a half-committed account exists.

   Branch on Lua result (round-11 + round-14 corrections — return value
   reflects reality; side-effecting cleanup ONLY happens on the
   deleted === 1 branch so we don't trash a different flow's state or
   destroy admin reconciliation evidence):
     IF deleted === -1:
       -- Finalize in flight; cancel refused. Don't touch state/cookie/profile.
       return 409 { cancelled: false, reason: 'finalize_in_progress' }
     IF deleted === -2:
       -- finalize_unknown — needs admin reconciliation (round-14). The
       -- pending marker carries flowId, profileId, and finalize_unknown_at
       -- which the admin runbook procedure uses to list Zernio accounts
       -- and decide whether a half-committed account exists. Owner cancel
       -- must NOT erase this evidence.
       return 409 { cancelled: false, reason: 'finalize_unknown_admin_required' }
     IF deleted === 0:
       -- Different flow occupies the slot, or marker disappeared mid-cancel.
       -- Don't touch the other flow's state/profile.
       return 200 { cancelled: false, reason: 'flow_changed_during_cancel' }

   -- deleted === 1: we successfully cancelled OUR flow. Now safe to clean up.
   IF parsed.state:
     await redis.del(`connect_state:${parsed.state}`).catch(() => {})

   sessionId = readSignedCookie(request, 'zernio_connect_session')
   IF sessionId:
     await redis.del(`connect_locations:${sessionId}`).catch(() => {})
   Clear the cookie on the response.

   Best-effort Zernio Profile cleanup (only when WE actually cancelled):
     IF parsed.profileId:
       await zernioClient.deleteProfile(parsed.profileId).catch(() => {})
     -- If Zernio call fails, the user can still restart since the local
     -- pending marker is gone. Orphan profiles cost nothing in our plan.

   Return 200 { cancelled: true, reason: 'flow_cancelled' }


5. POST /api/zernio/disconnect
   ────────────────────────────
   CSRF (FIRST, before any DB or external work):
     await assertSameOrigin(request)  -- from src/lib/shared/csrf.ts:8
     -- Returns 403 SameOriginError on mismatch. This is the actual
     -- same-origin helper used by onboarding routes; settings PUT does
     -- not call it. ALL state-changing Zernio POST routes
     -- (/api/zernio/connect/start, /api/zernio/connect/select-location,
     -- /api/zernio/connect/cancel, /api/zernio/disconnect) must call
     -- assertSameOrigin BEFORE any side-effecting work.

   Auth resolution (uses AppUser shape from src/lib/db/auth.ts — camelCase):
     - If user.role='owner':
         IF user.businessId === null: 403 unscoped_owner
         businessId = user.businessId  (ignore body)
     - If user.role='admin':
         require body { businessId } — fail 400 if missing
     - Else: 403

   Critical correction from spec review: sales_partner role is intentionally
   EXCLUDED from this endpoint. Per the documented latent issue in
   docs/security-audit/2026-06-15-refresh-delta.md §2 (consolidates the former
   round-1-auth-authz.md; R1 H-1 — admin business-detail routes don't scope by
   businesses.onboarded_by = user.id, so any sales_partner gets cross-partner
   read+write to all businesses), adding a new destructive per-business write
   endpoint reachable by sales_partner would expand the blast radius of that
   bug. Owner remains scoped to their own business. Sales-partner-initiated
   disconnect can be added later, AFTER the audit issue is fixed by adding
   onboarded_by scoping to admin business routes.

   UPDATE 2026-06-15: RESOLVED — sales_partner was removed (migration 053) and
   R1 H-1 is closed at the root (cross-partner IDOR class eliminated); only
   owner/admin remain, with admin an intentional global role.

   Resolve accountId for Zernio cleanup BEFORE the tx:
     SELECT zernio_account_id FROM zernio_connections
     WHERE business_id=B AND status='active' LIMIT 1
     → if none, 404 not_connected

   Begin tx:
     UPDATE zernio_connections
     SET status='disconnected',
         disconnected_at=NOW(),
         disconnect_reason=(role='owner' ? 'manual_owner' : 'manual_admin'),
         updated_at=NOW()
     WHERE business_id=B AND status='active'
   Commit

   Best-effort (failure logged to Sentry, does not fail the request — DB is
   source of truth from RepWorth's perspective; Zernio cleanup is housekeeping):
     Zernio: DELETE /v1/accounts/{accountId}

   Return 200
```

### 3.3 `DrainOwnerConnectWorker` (new worker)

Tiny new worker handles the `drain_pending_owner_connect` topic:

```sql
-- For each response in awaiting_owner_connect for this business, enqueue a
-- publish_response outbox entry IF AND ONLY IF no live publish_response
-- outbox row already exists for that response.
--
-- Critical corrections from spec review:
--
--   1. UUID generation: a single ${uuidv7()} parameter substituted into an
--      INSERT...SELECT is evaluated ONCE by Postgres.js, so all stuck rows
--      would share the same id and the bulk insert would fail on the PK
--      after the first row. Use gen_random_uuid() inline so each row gets
--      a distinct DB-generated UUID. (Matches the column DEFAULT in
--      migration 001 line 302.)
--
--   2. Idempotency-check field: existing approval code (callback-mode.ts:55,
--      session-mode.ts:91, token-mode.ts:63) already inserts publish_response
--      outbox rows with aggregate_id = response_id. Querying by aggregate_id
--      uses the existing idx_jo_topic (topic, status) + aggregate_id index
--      directly — no expression index needed. Cleaner and faster than
--      (payload->>'response_id')::uuid.
--
--   Without the NOT EXISTS guard, a crash between INSERT and
--   markOutboxCompleted would cause BullMQ to retry this worker, inserting
--   a SECOND batch of publish_response rows pointing at the same responses.
--   Each ResponsePublisher run is idempotent (responses.status='posted'
--   early-exit), but two concurrent runs could race against the Zernio API
--   and double-publish before the 'posted' state is committed.
WITH stuck AS (
  SELECT id, business_id
  FROM responses
  WHERE business_id = ${business_id}
    AND status = 'awaiting_owner_connect'
)
INSERT INTO job_outbox (
  id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
)
SELECT
  gen_random_uuid(),                              -- DB-side per-row UUID
  'publish_response',
  'response',
  stuck.id,
  jsonb_build_object('response_id', stuck.id, 'business_id', stuck.business_id),
  0, 5
FROM stuck
WHERE NOT EXISTS (
  SELECT 1 FROM job_outbox jo
  WHERE jo.topic = 'publish_response'
    AND jo.aggregate_id = stuck.id
    AND jo.status IN ('pending', 'dispatching', 'dispatched')
)
ON CONFLICT (topic, aggregate_id)
  WHERE topic = 'publish_response'
    AND status IN ('pending', 'dispatching', 'dispatched')
DO NOTHING;
```

**Round-7 correction (revised by round-8)**: the `ON CONFLICT ... DO NOTHING` clause is required even with the WHERE NOT EXISTS guard. Without it, an INSERT...SELECT that finds N rows but races with another DrainOwnerConnectWorker run (or a fresh `publish_response` enqueue from the auth-error path) on ONE row would abort the ENTIRE batch on the unique-index violation, leaving the other N-1 stuck responses unqueued and the worker marking itself completed. ON CONFLICT DO NOTHING makes the bulk insert resilient — conflicting rows are skipped, non-conflicting rows are inserted, batch never aborts.

**Round-8 correction**: `ON CONFLICT ON CONSTRAINT <index_name>` only works with named table constraints (unique / exclusion), NOT with partial unique indexes. The inferred form `ON CONFLICT (cols) WHERE <predicate>` is the correct syntax for partial indexes — it matches the predicate against the partial index's WHERE clause. Pattern verified against `src/lib/onboarding/create-business.ts:242` (`ON CONFLICT (business_id, channel) WHERE archived_at IS NULL DO NOTHING`).

After the conditional insert: `markOutboxCompleted`.

Idempotency (defense in depth, three layers):
1. **DB partial unique index** (NEW — round 6) — hard constraint enforced by Postgres. See migration 026 addition below; mirrors the existing `idx_jo_sync_reviews_inflight` pattern from migration 018.
2. **WHERE NOT EXISTS guard** — application-level fast-path so we don't even attempt duplicate inserts on the common case.
3. **ResponsePublisherWorker `status='posted'` early-exit** — final guard if both above are bypassed.

Add to migration 026 (mirrors `idx_jo_sync_reviews_inflight` from `018_correlation_and_dispatching_indexes.sql:56`, including the pre-index duplicate cleanup pattern from `004_sync_reviews_dedup_constraint.sql:8-30`):

```sql
-- Round 9 spec-review addition: pre-index cleanup. If production already
-- contains duplicate in-flight publish_response rows for the same
-- aggregate_id, the unique-index creation below would fail. This
-- collapses any existing duplicates by keeping the oldest and marking
-- the rest 'failed' — same approach used by migrations 004 and 018.
UPDATE job_outbox
SET status = 'failed',
    last_error = 'Collapsed duplicate by migration 026',
    completed_at = NOW()
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY topic, aggregate_id
      ORDER BY created_at
    ) AS rn
    FROM job_outbox
    WHERE topic = 'publish_response'
      AND status IN ('pending', 'dispatching', 'dispatched')
  ) ranked
  WHERE rn > 1
);

-- Round 6 spec-review addition: hard DB-level uniqueness for in-flight
-- publish_response rows. Without this, the WHERE NOT EXISTS guard alone
-- can race under concurrent DrainOwnerConnectWorker retries.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jo_publish_response_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'publish_response'
    AND status IN ('pending', 'dispatching', 'dispatched');

COMMENT ON INDEX idx_jo_publish_response_inflight IS
  'At-most-one in-flight publish_response per response. Mirrors the '
  'idx_jo_sync_reviews_inflight pattern. The DrainOwnerConnectWorker NOT '
  'EXISTS guard is the application-level fast-path; this index is the '
  'hard guarantee.';
```

Note: single-row producers (e.g. ResponsePublisherWorker handlers, the auth-error-path INSERT in Section 4.2) catch unique violation (`23505`) and treat it as success — matches the existing pattern at `ReconciliationPoller.ts:71`. The DrainOwnerConnectWorker bulk insert uses `ON CONFLICT DO NOTHING` instead of catch-and-treat-as-success because a single conflicting row in INSERT...SELECT would otherwise abort the entire batch.

The existing `ResponsePublisherWorker` does the rest — same code path as a freshly-approved response.

### 3.3.5 `/dashboard/connect` page UI states (round-final addition)

The page reads its own `connect_pending:{businessId}` Redis marker SSR (or via the dashboard API extension — same data source as the banner) and renders one of four states:

| Marker state | UI content | CTAs visible |
|---|---|---|
| **No marker** AND no active connection | "Connect Google Business to start auto-posting your approved responses." Brief 1-paragraph explanation of what connecting does. | "Connect Google Business" → triggers POST `/api/zernio/connect/start`, then `window.location = authUrl` |
| **`status='oauth_in_progress'`** | "Connection in progress... waiting for you to finish in Google's window." Show spinner + relative time since `started_at` (e.g. "Started 2 min ago"). | "Cancel & restart" → POST `/api/zernio/connect/cancel`. Show "If Google's window is closed, click cancel to start over." |
| **`status='finalizing'`** | "Finalizing connection — please wait..." Show spinner. Refresh page automatically every 2s for up to 30s. After 30s, show: "Taking longer than expected — refresh the page or contact support." | NO cancel button (route would 409 anyway — finalize lock holds for the duration) |
| **`status='finalize_unknown'`** | Big yellow alert box: "Connection requires manual review. We've notified our support team — they'll have this resolved within 24 hours. You don't need to do anything." Show contact email. | NO connect or cancel buttons (both would 409). |
| **Connection already active** | (Page redirects to `/dashboard` — handled by SSR guard.) | — |
| **Connection disconnected** | "Auto-posting is disconnected. Reconnect to publish queued responses." Show queued response count if any. | "Reconnect Google Business" — same as initial connect flow. |

The page-level state machine matches the API-layer state machine from §3.2 — the UI is just a visualization. No new state introduced at the UI layer.

### 3.4 Banner state matrix

| Connection state | Pending response count | Banner | CTA |
|---|---|---|---|
| No row | any | "Connect Google Business to start auto-posting your approved responses." | "Connect" → `/dashboard/connect` |
| `status='active'` | any | (none) | — |
| `status='disconnected'` | ≥1 in `awaiting_owner_connect` | "**N approved responses are waiting to publish.** Reconnect Google Business to send them." | "Reconnect" → `/dashboard/connect` |
| `status='disconnected'` | 0 | "Auto-posting is currently disconnected. Reconnect anytime to resume." | "Reconnect" → `/dashboard/connect` |

### 3.5 Admin UI — business detail page (`/admin/businesses/[id]`)

New panel "Zernio connection" shows:
- Current state (`active` / `disconnected` / `not connected`) with timestamps
- `disconnect_reason` if applicable, with last_error preview
- "Manually disconnect" button (calls `/api/zernio/disconnect` with admin scope)
- "Manually post" button per `awaiting_owner_connect` response — triggers existing `awaiting_manual_post` path as escape hatch

Counts in the existing admin overview page (`/admin/overview`) get a new column "Pending owner reconnect" alongside "Pending approval".

### 3.6 Security posture

1. **CSRF protection** — random 32-byte state, single-use, 15-min TTL, validated on callback.
2. **Session re-validation on callback** — Supabase user must match the user who started the flow.
3. **`connect_token` never persisted in Postgres** — Redis-only with 10-min ceiling, deleted after use.
4. **Master Zernio API key** — env var `ZERNIO_API_KEY`, never sent to browser, never logged.
5. **Cookie scoped to `Path=/`** — required because the cookie must be sent to `/api/zernio/connect/select-location` (not under `/dashboard/connect`). Cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, signed via Next's iron-session helpers, ~10-min TTL, single-use, cleared on success or cancel. Round-2 correction; round-12 ensured no stale references reintroduce the earlier path-scoped bug.

---

## 4. ResponsePublisher branching (worker)

### 4.1 Scope of change

Single worker file: `worker/jobs/ResponsePublisherWorker.ts`. Steps 1–3 (load + idempotency + subscription guard) stay identical. Steps 4–8 (transition to `awaiting_manual_post` + admin email) are replaced with the branch below.

New file: `src/lib/publishing/zernio-publisher.ts` — owns Zernio HTTP surface, error classification, and Redis-cached `provider_review_id` → Zernio review ID lookup. Keeps the worker readable and the publishing surface unit-testable in isolation.

### 4.2 New control flow

```
Step 4 — Load Zernio connection
  SELECT zernio_account_id, zernio_location_id
  FROM zernio_connections
  WHERE business_id=X AND status='active'
  LIMIT 1

Step 5 — Branch on connection presence

  IF NO active connection:
    Begin tx:
      updated = UPDATE responses SET status='awaiting_owner_connect',
        updated_at=NOW()
        WHERE id=R AND business_id=B
          AND status IN ('approved','edited','awaiting_owner_connect')
        RETURNING 1;
      IF updated.count == 0:
        -- Already terminal (posted by parallel worker, failed, superseded).
        -- Skip notify enqueue — owner doesn't need an email about a row
        -- they no longer need to act on.
        COMMIT; markOutboxCompleted; return.
      INSERT INTO job_outbox (
        id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
      ) VALUES (
        ${uuidv7()},
        'notify_owner_reconnect',
        'response', R,
        jsonb_build_object(
          'kind', 'reconnect_required',
          'response_id', R,
          'business_id', B
        ),
        0, 5
      )
    Commit
    markOutboxCompleted, return

  ELSE (active connection):
    zernioReviewId = await lookupZernioReviewId(businessId, ourReviewId, accountId)
      -- Redis-cached; falls back to Zernio API (Section 4.3)
    Call Zernio:
      POST /v1/accounts/{accountId}/gmb-reviews/{zernioReviewId}/reply
      header: Authorization: Bearer {ZERNIO_API_KEY}
      body: { comment: response.approved_text }

    Branch on response:

      200 OK:
        Begin tx:
          UPDATE responses SET status='posted', posted_at=NOW(),
            updated_at=NOW()
            WHERE id=R AND business_id=B
              AND status IN ('approved','edited','awaiting_owner_connect')
        Commit
        markOutboxCompleted, return

      ZernioReplyAlreadyExistsError (409):
        Same as 200 OK. Treat as idempotent success — Zernio confirms a reply
        is already in place. Covers the worker-crashed-after-Zernio-success
        window.

      ZernioAuthError (401/403):
        Begin tx:
          UPDATE zernio_connections SET status='disconnected',
            disconnected_at=NOW(),
            disconnect_reason='auth_error_on_post',
            last_error=trunc(body, 500),
            last_error_at=NOW()
            WHERE business_id=B AND status='active'
          updated = UPDATE responses SET status='awaiting_owner_connect',
            updated_at=NOW()
            WHERE id=R AND business_id=B
              AND status IN ('approved','edited','awaiting_owner_connect')
            RETURNING 1;
          IF updated.count == 0:
            -- Response already terminal (posted/failed/superseded) — connection
            -- mutation above still useful; skip notification enqueues so we
            -- don't email about a non-stuck response. Note: notify_owner_
            -- connection_lost may still be appropriate but it's already
            -- per-day-deduped at delivery layer (see Section 2.3) — fire it
            -- only when there's actually a pending response we just blocked.
            COMMIT; markOutboxCompleted; return.

          INSERT INTO job_outbox (
            id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
          ) VALUES (
            ${uuidv7()}, 'notify_owner_reconnect', 'response', R,
            jsonb_build_object(
              'kind', 'reconnect_required',
              'response_id', R,
              'business_id', B
            ), 0, 5
          )
          INSERT INTO job_outbox (
            id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
          ) VALUES (
            ${uuidv7()}, 'notify_owner_connection_lost', 'business', B,
            jsonb_build_object(
              'kind', 'connection_lost',
              'business_id', B
            ), 0, 5
          )
        Commit
        markOutboxCompleted, return
        (Don't retry — auth is broken at the connection level, not transient.)

      ZernioTransientError (5xx, 429, network):
        throw — let BullMQ retry with existing exponential backoff (3 attempts).
        On final attempt failure (BullMQ onFailed hook for this queue):
          Same path as ZernioAuthError above (mark connection disconnected
          + transition response + email). Asymmetric vs other workers but
          intentional — silent failure of an approved response is the worst
          owner experience.

      ZernioReviewNotFoundError (404 on the reviewId):
        Likely cause: SerpAPI synthetic provider_review_id doesn't match a
        Zernio-visible review. PERMANENT failure (do not retry).

        Critical correction from spec review:
        - response UPDATE must guard by current status (parallel worker may
          have already posted/failed/superseded the row)
        - downstream payload field is review_exception_id (not exception_id)
          per src/lib/shared/worker-types.ts:43 and AdminExceptionWorker:13
        - INSERT ... ON CONFLICT DO NOTHING RETURNING id returns NO ROW on
          conflict; must use a CTE pattern that selects the existing open
          exception id when our INSERT was a no-op.

        Begin tx:
          updated = UPDATE responses SET status='failed',
            updated_at=NOW()
            WHERE id=R AND business_id=B
              AND status IN ('approved','edited','awaiting_owner_connect')
            RETURNING 1;
          IF updated.count == 0:
            -- Row already terminal (posted/failed/superseded). No exception
            -- to file. Outbox should still complete cleanly.
            COMMIT; markOutboxCompleted; return.

          -- review_exceptions column is `payload` (not `details`) per
          -- migration 001 line 430. The partial unique idx_review_exceptions_open
          -- (review_id, type) WHERE status='open' enforces one-open-per-pair.
          --
          -- Critical correction from spec review: a CTE pattern with
          -- ON CONFLICT DO NOTHING + fallback SELECT can race under
          -- READ COMMITTED — a concurrent transaction's row is visible
          -- to the unique-index check (dirty conflict detection) but NOT
          -- to a sibling SELECT. The SELECT can return zero rows even
          -- after the conflict. ON CONFLICT DO UPDATE with a no-op
          -- payload self-assignment guarantees a returned id in every
          -- code path (including conflict).
          INSERT INTO review_exceptions (
            id, business_id, review_id, response_id, type, payload
          ) VALUES (
            ${uuidv7()}, B, response.review_id, R,
            'zernio_review_id_mismatch',
            jsonb_build_object(
              'our_review_id', response.review_id,
              'attempted_zernio_review_id', attempted,
              'error_body', error_body,
              'response_id', R
            )
          )
          ON CONFLICT (review_id, type) WHERE status='open'
          DO UPDATE SET payload = review_exceptions.payload  -- no-op write, returns existing row
          RETURNING id INTO exception_id;

          INSERT INTO job_outbox (
            id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
          ) VALUES (
            ${uuidv7()}, 'notify_admin_review_exception', 'review',
            response.review_id,
            jsonb_build_object(
              'review_exception_id', exception_id,   -- field name matches NotifyAdminExceptionPayload
              'business_id', B
            ),
            0, 5
          )
        Commit
        markOutboxCompleted, return
```

### 4.3 `provider_review_id` mismatch handling

**Problem**: `reviews.provider='serpapi_poll'` and `provider_review_id = SHA-256(reviewerName + "|" + reviewDate + "|" + reviewerProfileUrl)` — synthetic. Zernio's reply endpoint expects Google's actual review ID.

**Solution**: Redis-cached lookup at post time, no schema change.

```
async function lookupZernioReviewId(
  businessId: string,
  ourReviewId: string,
  accountId: string,
): Promise<string> {
  // 1. Cache check (24h TTL)
  const cached = await redis.get(`zernio_review_map:${businessId}:${ourReviewId}`);
  if (cached) return cached;

  // 2. Load our review's matchable fields.
  // postgres.js returns an array — use destructure pattern matching the rest
  // of the codebase (e.g. ResponsePublisherWorker.ts:19).
  // Scope by business_id to defend against a stale ourReviewId pointing at
  // another business's review (paranoid guard; the publisher already scopes
  // by business_id but defense in depth).
  const [ourReview] = await sql<{
    reviewer_name: string;
    review_date: Date;
    review_text: string | null;
    star_rating: number;
  }[]>`
    SELECT reviewer_name, review_date, review_text, star_rating
    FROM reviews
    WHERE id = ${ourReviewId} AND business_id = ${businessId}
    LIMIT 1
  `;
  if (!ourReview) {
    throw new ZernioReviewNotFoundError({
      ourReviewId, accountId, reason: 'review_not_found_or_wrong_business',
    });
  }

  // 3. Fetch Zernio's reviews for this account.
  // Pagination: walk nextPageToken up to 4 pages (200 reviews) — covers the
  // recency window for any plausible match. If we hit page 4 without a match,
  // throw ZernioReviewNotFoundError; older reviews aren't replied to anyway.
  const zernioReviews = await zernioClient.listAllReviews(accountId, {
    pageSize: 50,
    maxPages: 4,
  });

  // 4. Match by (reviewer.displayName, createTime, comment, rating).
  // Normalize null/empty comments — SerpAPI may store empty as null while
  // Zernio may return empty string, or vice versa.
  const ourComment = (ourReview.review_text ?? '').trim();
  const match = zernioReviews.find(z =>
    z.reviewer.displayName === ourReview.reviewer_name &&
    z.rating === ourReview.star_rating &&
    (z.comment ?? '').trim() === ourComment &&
    Math.abs(new Date(z.createTime).getTime() - ourReview.review_date.getTime()) < 86400000
  );

  if (!match) {
    throw new ZernioReviewNotFoundError({
      ourReviewId, accountId,
      candidatesChecked: zernioReviews.length,
      reason: 'no_field_match',
    });
  }

  // 5. Cache + return
  await redis.setex(`zernio_review_map:${businessId}:${ourReviewId}`, 86400, match.id);
  return match.id;
}

// Round-final note — handling reviewer edits between SerpAPI ingest and post:
//
// SerpAPI's ReviewSyncWorker mutates `reviews.review_text` when a reviewer
// edits their review (via the `review_content_hash` change-detection path).
// Zernio also reflects the edit in their `comment` field. When publish
// happens AFTER an edit:
//   - First-publish-per-review (cache miss): comparison uses CURRENT text
//     from both sides — match succeeds. ✅
//   - Re-publish (cache hit, e.g. owner regenerated): cached zernioReviewId
//     is still valid (Zernio's review.id is stable across edits). ✅
//   - Edge: edit happens DURING our request, after we read `ourReview`
//     but before Zernio listReviews returns: match could fail. Falls
//     through to `ZernioReviewNotFoundError` → review_exception →
//     admin investigates + re-runs. Acceptable rate.
//
// We do NOT need to re-fetch `ourReview` mid-flight; cache invalidation
// on edit is unnecessary because Zernio's stable review.id means the
// cached mapping never goes stale.
```

**Tradeoffs explicit**: First-publish-per-review pays a Zernio API round-trip. Subsequent replies (regenerate, edit) hit cache. Match key is conservative (4 fields) — collisions extremely unlikely. Failed matches are visible (`review_exceptions` rows + admin email).

### 4.4 BullMQ exhaustion handling

**Critical correction from spec review**: `worker/queues.ts` only constructs `Queue` objects (no `Worker` instances). `Worker` instances are created in `worker/index.ts:125` (e.g. `publisherWorker = new Worker(QUEUE_NAMES.PUBLISH_RESPONSE, handlePublishResponse, workerOpts)`). The `onFailed` listener must attach to the `Worker` instance, not to a Queue object — so this code lives in `worker/index.ts`, not `worker/queues.ts`:

```typescript
// In worker/index.ts, immediately after publisherWorker construction:
publisherWorker.on('failed', async (job, err) => {
  if (!job) return;
  if (job.attemptsMade < job.opts.attempts!) return;  // not the final attempt

  // Final attempt failed.
  //
  // Critical correction from spec review: ResponsePublisherWorker handlers
  // bubble thrown errors (e.g. ResponsePublisherWorker.ts:246). They do NOT
  // call markOutboxFailed on throw — the outbox row is left in 'dispatched'
  // until OutboxPoller's hourly watchdog reclaims it. On final BullMQ
  // attempt we must explicitly close out the outbox row.
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);
  const isZernioTransient = err instanceof ZernioTransientError;

  if (isZernioTransient) {
    // Graceful degradation: mark connection disconnected, transition response
    // to awaiting_owner_connect, enqueue both notify outbox rows.
    // Same single-tx mutation block as the in-worker auth-error path; lives
    // in src/lib/publishing/zernio-publisher.ts to avoid duplication.
    await applyTransientExhaustionFallback(job.data);
    await markOutboxFailed(outboxId, 'zernio_transient_max_attempts', outboxAttempt);
  } else {
    // Non-Zernio errors (DB exception, programming bug, etc.) — close the
    // outbox row with the error message so it's visible in the admin jobs
    // page rather than only surfacing on the next watchdog sweep.
    const reason = err instanceof Error ? err.message : String(err);
    await markOutboxFailed(outboxId, reason, outboxAttempt);
  }
});
```

The `applyTransientExhaustionFallback` helper lives in `src/lib/publishing/zernio-publisher.ts` and contains the same single-tx mutation block as the in-worker auth-error path (with the same status-predicate guards from Section 4.2). Reuse, don't duplicate.

### 4.5 Cost guard

None. Zernio's pricing is flat (Accelerate plan + Inbox add-on). Per-call cost is zero. Keep it simple — no Redis cost reservation, no `api_costs` rows for Zernio calls.

### 4.6 HTTP client timeouts (mandatory)

**Critical correction from spec review (round 5)**: every Zernio HTTP call MUST have an explicit timeout. Matches the existing pattern in `src/lib/notifications/channels/telegram-client.ts:64` (AbortController) and `src/lib/notifications/channels/whatsapp-client.ts:99` (Twilio SDK 10s timeout). Without timeouts, a hung Zernio response stalls the worker handler indefinitely, blocking the BullMQ queue and tying up the connect-flow Redis lock past its 30s TTL.

`src/lib/zernio/client.ts` implements a single `request()` primitive that all per-endpoint methods use:

```typescript
async function request<T>(opts: {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  endpointKind: EndpointKind;   // round-16: required for endpoint-aware classification
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;  // declared so it's visible in catch
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ZERNIO_API_BASE}${opts.path}`, {
      method: opts.method,
      headers: {
        'Authorization': `Bearer ${ZERNIO_API_KEY}`,
        'Content-Type': 'application/json',
        ...opts.headers,
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    return await classifyAndParse<T>(res, opts.endpointKind);
    // round-16 fix: must `await` since classifyAndParse is async (it calls
    // res.json()/res.text()). round-15 declared it sync, which wouldn't compile.
  } catch (err) {
    // Preserve already-classified Zernio errors so we don't re-wrap them.
    if (err instanceof ZernioAuthError) throw err
    if (err instanceof ZernioValidationError) throw err
    if (err instanceof ZernioReplyAlreadyExistsError) throw err
    if (err instanceof ZernioReviewNotFoundError) throw err
    if (err instanceof ZernioPermanentError) throw err
    if (err instanceof ZernioTransientError) throw err

    // Round-16 fix: AbortError covers timeout + manual abort, but fetch
    // throws TypeError for DNS/socket/connection failures. Without
    // wrapping, those would skip the transient branch in the BullMQ
    // onFailed handler (Section 4.4) and never trigger
    // applyTransientExhaustionFallback, leaving stuck responses silent.
    if (err instanceof Error && err.name === 'AbortError') {
      throw new ZernioTransientError('request_timeout', { path: opts.path, timeoutMs });
    }
    throw new ZernioTransientError('network_error', {
      path: opts.path,
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    clearTimeout(timer);
  }
}
```

**Per-endpoint timeout budgets:**

| Method | Endpoint | Default timeout |
|---|---|---|
| `createProfile` | POST /v1/profiles | 10s |
| `startConnect` | GET /v1/connect/google-business | 10s |
| `listLocations` | GET /v1/connect/google-business/list-locations | 10s |
| `selectLocation` | POST /v1/connect/google-business/select-location | 15s (slowest — Zernio finalizes server-side state) |
| `listReviews` | GET /v1/accounts/{id}/gmb-reviews | 15s (paginated; per-page) |
| `postReply` | POST /v1/accounts/{id}/gmb-reviews/{id}/reply | 15s |
| `deleteAccount` | DELETE /v1/accounts/{id} | 10s |
| `deleteProfile` | DELETE /v1/profiles/{id} | 10s |

Aborts classify as `ZernioTransientError` so they participate in the existing BullMQ retry logic and `applyTransientExhaustionFallback` graceful-degradation path (Section 4.4).

### 4.7 Error class allowlist for `classifyAndParse` (round-15 addition)

The select-location finalize path's outcome-known vs outcome-unknown branch (Section 3.2 step 3) hinges on classification correctness. **Mis-classifying a 5xx or 400 as `ZernioValidationError` would route us to the unsafe revert path**, potentially creating a duplicate Zernio account on retry. Classification must be CONSERVATIVE: only the codes explicitly enumerated below qualify as pre-mutation rejects.

```typescript
// Round-16: endpoint-aware classification. Unknown 4xx means different
// things depending on idempotency:
//   - select-location is non-idempotent: unknown 4xx → outcome-unknown
//     (finalize_unknown path, NOT auto-retry)
//   - publish-reply / list-reviews / list-locations are safe to call
//     repeatedly: unknown 4xx → permanent client error (don't disconnect
//     the connection on retry exhaustion)
type EndpointKind =
  | 'select_location'   // non-idempotent — outcome-unknown semantics
  | 'publish_reply'     // bounded-idempotent (409 = "already replied")
  | 'list_reviews'
  | 'list_locations'
  | 'create_profile'
  | 'delete_profile'
  | 'delete_account'
  | 'start_connect';

// Endpoints that don't return a JSON body (DELETE, etc.) — round-17 fix.
// res.json() on an empty body throws SyntaxError; without this gate it
// would get caught by request()'s outer catch and wrapped as
// ZernioTransientError('network_error'), erroneously triggering retry +
// graceful-degradation disconnect on a successful no-content response.
const NO_BODY_ENDPOINTS = new Set<EndpointKind>([
  'delete_profile',
  'delete_account',
]);

async function classifyAndParse<T>(res: Response, endpointKind: EndpointKind): Promise<T> {
  if (res.ok) {
    // Round-17: handle 204 No Content + no-body endpoints + empty body.
    if (res.status === 204 || NO_BODY_ENDPOINTS.has(endpointKind)) {
      return undefined as unknown as T;
    }
    const text = await res.text();
    if (!text) return undefined as unknown as T;
    try { return JSON.parse(text) as T }
    catch (parseErr) {
      // 200 OK with malformed JSON — Zernio bug or proxy mangling. Treat
      // as transient (retry-able) since we don't know if the action took.
      throw new ZernioTransientError('malformed_response_body', {
        path: res.url, status: res.status,
        bodyPreview: text.slice(0, 200),
      });
    }
  }

  // ── ZernioAuthError: 401 / 403 (no business-logic execution) ──
  if (res.status === 401 || res.status === 403) {
    throw new ZernioAuthError(res.status, await res.text().catch(() => ''));
  }

  // ── ZernioReplyAlreadyExistsError: 409 on publish_reply with documented body ──
  if (res.status === 409 && endpointKind === 'publish_reply') {
    throw new ZernioReplyAlreadyExistsError(await res.json().catch(() => ({})));
  }

  // ── ZernioReviewNotFoundError: 404 on publish_reply ──
  if (res.status === 404 && endpointKind === 'publish_reply') {
    throw new ZernioReviewNotFoundError(await res.json().catch(() => ({})));
  }

  // ── ZernioValidationError: STRICT allowlist of documented
  //    pre-mutation reject codes (see maintenance rule below).
  const PRE_MUTATION_400_CODES = new Set([
    'invalid_connect_token',     // expired/malformed token, no work attempted
    'unknown_location_id',       // locationId not in this profile's listing
    'profile_not_found',         // referenced profile doesn't exist
    'missing_required_field',    // request validation, no work attempted
  ]);
  if (res.status === 400) {
    const body = await res.json().catch(() => ({}));
    // Round-17 correction: PRE_MUTATION_400_CODES → ZernioValidationError
    // ONLY for select_location, where the class is meaningful for the
    // revert-vs-finalize_unknown decision. On publisher / list endpoints,
    // the same codes should route to ZernioPermanentError so they hit
    // the admin-exception path (not retry / disconnect).
    if (endpointKind === 'select_location') {
      if (body?.code && PRE_MUTATION_400_CODES.has(body.code)) {
        throw new ZernioValidationError(body.code, body);
      }
      // Unknown 400 on non-idempotent endpoint → outcome-unknown.
      throw new ZernioTransientError('unknown_4xx_unknown_outcome', { status: 400, body });
    }
    // Non-select_location endpoints: ALL 400s are permanent client errors
    // (allowlisted code or not). Surface as ZernioPermanentError so the
    // worker logs + opens review_exceptions WITHOUT triggering graceful-
    // degradation disconnect.
    throw new ZernioPermanentError('http_400', { status: 400, body, endpointKind });
  }

  // ── 5xx / 429 / other status → transient ──
  // 5xx is INTENTIONALLY transient (NOT validation) because a 5xx
  // after Zernio's internal commit but before response serialization
  // is plausible for non-idempotent endpoints. The select-location
  // finalize path treats this as outcome-unknown → finalize_unknown.
  throw new ZernioTransientError(`http_${res.status}`, {
    status: res.status,
    body: await res.text().catch(() => ''),
  });
}
```

**Endpoint-aware error classes** (round-16 addition to `src/lib/zernio/errors.ts`):
- `ZernioPermanentError` — non-retryable client error on idempotent endpoints (`publish_reply`, `list_reviews`, etc.). Worker should log, mark response failed (or open `review_exceptions`), and NOT trigger `applyTransientExhaustionFallback` (which would wrongly disconnect the connection).
- `ZernioTransientError('unknown_4xx_unknown_outcome', ...)` — kept distinct from generic `unknown_4xx` so the select-location finalize_unknown classifier can route it correctly.

**Maintenance rule**: any addition to `PRE_MUTATION_400_CODES` requires either (a) explicit confirmation in Zernio's published docs that the code is returned pre-commit, or (b) the corresponding error documented as outcome-unknown in `zernio-launch-runbook.md`. Default-deny prevents future changes from accidentally introducing the round-14 unsafe-revert bug.

**ResponsePublisherWorker handling for `ZernioPermanentError`** (extends Section 4.2 branch table):

```
ZernioPermanentError (idempotent endpoint, unknown 4xx):
  Begin tx:
    -- Round-17 correction: gate side effects on the UPDATE's row count.
    -- A response that's already terminal (posted/failed/superseded) by a
    -- parallel worker should NOT generate admin noise.
    updated = UPDATE responses SET status='failed', updated_at=NOW()
      WHERE id=R AND business_id=B
        AND status IN ('approved','edited','awaiting_owner_connect')
      RETURNING 1;
    IF updated.count == 0:
      -- Already terminal. Skip exception/outbox; complete outbox cleanly.
      COMMIT; markOutboxCompleted; return.

    INSERT INTO review_exceptions (
      id, business_id, review_id, response_id, type, payload
    ) VALUES (
      ${uuidv7()}, B, response.review_id, R,
      'zernio_permanent_4xx',
      jsonb_build_object(
        'response_id', R,
        'endpoint_kind', endpointKind,
        'error_body', err.body,
        'http_status', 400
      )
    )
    ON CONFLICT (review_id, type) WHERE status='open'
    DO UPDATE SET payload = review_exceptions.payload  -- round-13 idempotent CTE pattern
    RETURNING id INTO exception_id;

    INSERT INTO job_outbox (
      id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
    ) VALUES (
      ${uuidv7()}, 'notify_admin_review_exception', 'review',
      response.review_id,
      jsonb_build_object('review_exception_id', exception_id, 'business_id', B),
      0, 5
    )
  Commit
  markOutboxCompleted, return
  (Connection state untouched — admin investigates the specific request.)
```

---

## 5. Webhook ingress (worker)

### 5.1 New files

| File | Purpose |
|---|---|
| `worker/ingress/zernio.ts` | Fastify handler — modeled exactly on `worker/ingress/stripe.ts:198`. |
| `worker/ingress/zernio-verify.ts` | HMAC-SHA256 verification utility (`crypto.timingSafeEqual`). |
| `worker/jobs/OwnerEmailWorker.ts` | Discriminated-payload router for `owner_connection_lost` and `owner_reconnect_required` (Sec 2.4). |
| `src/lib/notifications/email/templates/owner-reconnect-required.ts` | HTML builder for `owner_reconnect_required` template. Mirrors existing `templates/owner-nudge.ts` shape — exports `buildOwnerReconnectRequiredEmailHtml({ businessName, reviewerName, dashboardConnectUrl })`. **Round-final addition**, not in original scope summary. |
| `src/lib/notifications/email/templates/owner-connection-lost.ts` | HTML builder for `owner_connection_lost` template. Same pattern — exports `buildOwnerConnectionLostEmailHtml({ businessName, queuedCount, dashboardConnectUrl })`. **Round-final addition.** |

### 5.2 Modified files

- `worker/index.ts` — register `POST /ingress/zernio` route with `rawBody: true` (fastify-raw-body, same as Stripe). Also register `OwnerEmailWorker` instance.
- `worker/startup-assert.ts` — add Zernio env-var assertions when flag on.

`worker/jobs/NotificationWorker.ts` is NOT modified — owner-email templates live in the new `OwnerEmailWorker` to avoid contract conflict with `SendNotificationPayload`'s required `response_id` and the context loader's pending-only filter (Sec 2.4).

### 5.3 Handler structure

```
POST /ingress/zernio  (Fastify on Railway)

  1. If ZERNIO_PUBLISHING_ENABLED !== 'true': 503 feature_disabled
  2. Read raw body via fastify-raw-body
  3. Verify signature
       Mirror the safer pattern from src/lib/shared/feedback-hmac.ts:22-30 —
       Node's crypto.timingSafeEqual THROWS when buffer lengths differ, so we
       must reject malformed signatures BEFORE comparison.

         const HEX_64 = /^[0-9a-f]{64}$/i;
         const header = request.headers['x-zernio-signature'];
         if (typeof header !== 'string' || !HEX_64.test(header)) {
           return reply.status(401).send({ error: 'invalid_signature_format' });
         }
         const expected = crypto.createHmac('sha256', ZERNIO_WEBHOOK_SECRET)
           .update(rawBody)
           .digest('hex');
         const ok = crypto.timingSafeEqual(
           Buffer.from(expected, 'hex'),
           Buffer.from(header, 'hex'),
         );
         if (!ok) return reply.status(401).send({ error: 'invalid_signature' });

  4. Extract eventId BEFORE claimInboundEvent (it's the dedup key — must exist):
       const eventId = (request.headers['x-zernio-event-id'] as string)
         ?? body?.id;
       if (!eventId) {
         return reply.status(400).send({ error: 'missing_event_id' });
       }
  5. Dedup
       claim = await claimInboundEvent('zernio', eventId, body.event, body)
       if claim === 'duplicate': 200 { received: true, duplicate: true }
  6. Switch on body.event:
       account.disconnected → process per Section 5.4
       account.connected    → log only (defensive drift detector)
       review.new           → INCRBY zernio_event_seen:review.new:{date}
       review.updated       → INCRBY zernio_event_seen:review.updated:{date}
       webhook.test         → log + 200
       default              → log unhandled, 200 (don't trigger retries)
  7. UPDATE inbound_events SET status='processed', processed_at=NOW()
       (existing pattern)
     On exception: SET status='failed' + 500 (Zernio retries 7x over 51h)
```

### 5.4 `account.disconnected` handler

**Critical correction from spec review (round 5)**: the `zernio_connections_account_id_idx` is non-unique by design (Section 2.1) — the same Google Business account COULD theoretically be connected to multiple Zernio Profiles owned by the same person across multiple RepWorth businesses. The handler must therefore notify EVERY business affected by the disconnect, not just the first one found.

```
Begin Postgres tx:
  -- UPDATE returns one row per affected business; we then insert one
  -- notify outbox per returned business.
  WITH disconnected AS (
    UPDATE zernio_connections
      SET status='disconnected',
          disconnect_reason='webhook_event',
          disconnected_at=NOW(),
          last_error=COALESCE(body.reason, 'webhook account.disconnected'),
          last_error_at=NOW()
      WHERE zernio_account_id = body.account.id
        AND status = 'active'
      RETURNING business_id
  )
  INSERT INTO job_outbox (
    id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
  )
  SELECT
    gen_random_uuid(),                          -- DB-side per-row UUID
    'notify_owner_connection_lost',
    'business',
    business_id,
    jsonb_build_object(
      'kind', 'connection_lost',
      'business_id', business_id
    ),
    0, 5
  FROM disconnected;
Commit
(No-op if no active connection found — webhook arrived after the
 auth-error-on-post path already disconnected. Safe.)
```

### 5.5 Notification templates

| Template | Trigger | Dedup scope | Subject |
|---|---|---|---|
| `owner_connection_lost` | `account.disconnected` webhook OR auth-error-on-post | `(business_id, template, created_at::date)` — one per biz per day | "Google Business connection paused for {Business Name}" |
| `owner_reconnect_required` | Response transitions to `awaiting_owner_connect` | `(response_id, template)` — one per stuck response | "Your reply to {Reviewer Name} is ready to publish" |

Both emails contain a single CTA button to `/dashboard/connect`. Delivery rows use the same claim-before-send pattern as `admin_manual_post` (`ResponsePublisherWorker.ts:164-181`) — INSERT-on-conflict-do-nothing, then send, then UPDATE with provider message_id; rollback claim on send failure.

**Critical correction from spec review**: both new templates are owner-directed (recipient is the business owner, not ADMIN_NOTIFICATION_EMAIL). `worker/ingress/resend.ts:127` defines `OWNER_DIRECTED_TEMPLATES` for hard-bounce handling — when a hard bounce arrives for an owner-directed template, `businesses.owner_email_bounced` is flagged. Both new templates MUST be added to that set:

```typescript
// In worker/ingress/resend.ts
const OWNER_DIRECTED_TEMPLATES = new Set([
  'approval_request',
  'weekly_value_report',
  'monthly_impact',
  'owner_nudge',
  'owner_reconnect_required',    // NEW
  'owner_connection_lost',       // NEW
]);
```

Without this, hard bounces on Zernio reconnect emails would silently miss the bounce flag — the owner would never get the email AND the system wouldn't know.

### 5.6 Boot-time assertions (`worker/startup-assert.ts`)

When `ZERNIO_PUBLISHING_ENABLED=true` AND `MOCK_EXTERNAL_APIS !== 'true'`:

```
Required env vars (worker fails to boot if missing):
  - ZERNIO_API_KEY                  (Bearer token for outbound calls)
  - ZERNIO_WEBHOOK_SECRET           (HMAC signing secret)
  - WORKER_PUBLIC_URL               (already required when SMS enabled)
  - NEXT_PUBLIC_APP_URL             (already required)

Optional env vars (defaults applied):
  - ZERNIO_PROFILE_ID_PREFIX        (default 'repworth-prod-')
```

Existing `MOCK_EXTERNAL_APIS=true` bypass keeps local dev unbroken.

### 5.7 Operational config (Zernio dashboard)

After deploying, configure in Zernio's webhook settings:
- **Webhook URL**: `{WORKER_PUBLIC_URL}/ingress/zernio`
- **Subscribed events**: `account.connected`, `account.disconnected`, `review.new`, `review.updated`, `webhook.test`
- **Signing secret**: must match `ZERNIO_WEBHOOK_SECRET`

---

## 6. Phased rollout

### 6.1 Feature flag posture

`ZERNIO_PUBLISHING_ENABLED` — server-side env var, default `false`. **No `NEXT_PUBLIC_*` companion.** Browser learns flag state via business-detail API response (`zernioPublishingEnabled` field).

### 6.2 Phase breakdown

```
PHASE 0 — SCAFFOLDING (flag off everywhere)
─────────────────────────────────────────────
Goal: code on main, deployed to prod, completely inert.

  [ ] Migration 026 written (you run it via Supabase SQL editor)
  [ ] All new files merged
  [ ] Boot assertion added but flag-gated off
  [ ] No env vars set in prod yet
  [ ] Unit tests + integration tests passing
  [ ] E2E test: connect flow happy path against Zernio sandbox

  Exit: PR merged, prod healthy, no behavior change observable to anyone.

PHASE 1 — SINGLE-CUSTOMER PILOT
─────────────────────────────────
Goal: prove Zernio works end-to-end with one real customer.

  [ ] Set ZERNIO_API_KEY + ZERNIO_WEBHOOK_SECRET in prod env
  [ ] Configure webhook URL in Zernio dashboard
  [ ] Flip ZERNIO_PUBLISHING_ENABLED=true
  [ ] Onboard customer #1 → they connect via /dashboard/connect
  [ ] Monitor for 1-2 weeks:
        - Reply success rate (target: 100% on real reviews)
        - Webhook reliability (account.disconnected fires correctly)
        - provider_review_id matching (Redis cache hit rate, lookup failures)
        - End-to-end latency (approval click → reply visible on Google)

  Exit: customer #1 has 5+ approved replies posted via Zernio with zero
        ZernioReviewNotFoundError occurrences and zero silent failures.
        Owner reports replies appearing on Google.

PHASE 2 — EXPANSION TO 5-10 CUSTOMERS
───────────────────────────────────────
Goal: prove the integration scales to your initial customer cohort.

  No code changes — just onboarding more customers.
  Watch:
    - Rate limit headroom (well under 600 req/min)
    - Cost (Build tier $26/mo for first 10, second unit if needed)
    - Provider_review_id mismatch rate as data volume grows
    - Connection breakage rate

  Exit: 10 connected customers stable for 30 days, no manual intervention
        needed for posting.

PHASE 3 — INGESTION SWAP DECISION (deferred, separate spec)
─────────────────────────────────────────────────────────────
Re-evaluate dropping SerpAPI for ingestion on connected businesses.
Out of scope for THIS spec.
```

### 6.3 Pre-Phase-1 checklist (operational)

```
[ ] Zernio sales reseller TOS confirmed in writing
[ ] Zernio Accelerate plan + Inbox add-on activated on annual billing
[ ] Production Zernio API key generated, scoped to one workspace
[ ] Webhook secret generated (32+ bytes from `openssl rand -hex 32`)
[ ] Webhook URL configured in Zernio dashboard pointing at WORKER_PUBLIC_URL
[ ] Subscribed to: account.connected, account.disconnected,
      review.new, review.updated, webhook.test
[ ] Test webhook fired manually from Zernio dashboard, observed 200 in
      worker logs and inbound_events row created
[ ] Customer #1 identified and primed (knows they're the pilot)
```

### 6.4 Rollback strategy

Two-stage, no DB rollback ever needed (additive migration):

1. **Soft rollback** — Flip `ZERNIO_PUBLISHING_ENABLED=false` in prod env. Worker restarts. Webhooks return 503. ResponsePublisher skips Zernio branch (responses to-be-published transition to `awaiting_manual_post` — admin uses existing manual-post flow). Already-posted responses stay posted. Time: under 5 minutes.

2. **Hard rollback** — Revert PR + redeploy. Migration 026 stays applied (additive, no harm). Time: under 30 minutes.

### 6.5 Observability & monitoring

| Signal | Where it shows | Alert threshold |
|---|---|---|
| Zernio reply success rate | Sentry transaction tags + structured logs | < 95% in 1h → page |
| `ZernioAuthError` rate | Sentry | > 1/h → email |
| `ZernioReviewNotFoundError` count | `review_exceptions` row count | > 0 in 24h → email |
| Webhook signature failures | `inbound_events` filter | > 0 in 1h → page (likely secret rotation) |
| `awaiting_owner_connect` response count | Admin dashboard panel | > 5 per business → manual nudge |
| Connection drop rate | `zernio_connections` filter `disconnected_at > NOW() - 24h` | > 1/day → investigate |
| Zernio review event counters | Admin runbook page | Phase 3 readiness signal |

---

## 7. Testing approach

| Layer | Coverage |
|---|---|
| **Unit (Vitest)** | Zernio error classification (auth vs transient vs not-found vs already-exists); HMAC verification (good signature passes, bad rejected, replay rejected); CSRF state Redis encoding/decoding; `provider_review_id` → Zernio review ID lookup with cache hit/miss; `DrainOwnerConnectWorker` happy + idempotent paths; banner state matrix; subscription guard pass-through |
| **Integration (Vitest + real Supabase)** | Full ResponsePublisher branching: happy path, no-connection path, auth-error path with state mutation in single tx, transient-then-success replay, 409 idempotent treatment, 404 → review_exceptions; webhook ingress: account.disconnected → DB state → next publish queues correctly; `drain_pending_owner_connect` outbox processes all stuck responses; `notification_deliveries_owner_reconnect_dedup` constraint enforcement |
| **E2E (Playwright)** | Connect flow: dashboard → click connect → mock Zernio sandbox → location picker → select → dashboard banner gone. Disconnect via UI: confirm DB state. Approve a response with no connection: confirm `awaiting_owner_connect` + email queued. Reconnect after disconnect: confirm `drain` outbox runs and pending response posts |
| **Mock mode** | `MOCK_EXTERNAL_APIS=true` short-circuits all Zernio calls — connect flow returns fake `accountId`, reply API returns 200, webhook ingress accepts a `mock-signature` literal. Lets local dev work without Zernio sandbox credentials |

---

## 8. Documentation updates (in same PR as code)

- **CLAUDE.md** — three changes:
  - Add `Zernio: Auto-posting (Phase 1+)` to tech stack
  - Add `ZERNIO_PUBLISHING_ENABLED` and related env vars to feature-flag section
  - Update directory tree: new `src/lib/zernio/`, `src/app/(authenticated)/dashboard/connect/`, `src/lib/publishing/zernio-publisher.ts`, `worker/ingress/zernio.ts`, `worker/jobs/DrainOwnerConnectWorker.ts`
  - Add `awaiting_owner_connect` to response status enum line
  - Add Zernio entry to "Lab notes" if any non-obvious finding emerges during pilot
- **`docs/zernio-launch-runbook.md`** (new) — operational runbook mirroring `docs/signup-test-runbook.md` style: pilot scenarios, rollback steps, common errors and their causes, "test webhook fired" verification flow.

  **Round-13 → round-15 finalize_unknown reconciliation procedure** (triggered by Sentry alert `zernio_finalize_unknown`; reachable from cancel route's 409 `finalize_unknown_admin_required` response; also visible by querying `SELECT * FROM zernio_finalize_incidents WHERE resolved_at IS NULL`):

  1. From the alert OR the `zernio_finalize_incidents` row, obtain `business_id`, `flow_id`, `zernio_profile_id`, `finalize_unknown_at`.
  2. List Zernio accounts attached to that profile via `GET /v1/profiles/{zernio_profile_id}/accounts` (or platform equivalent).
  3. **Branch A — account exists** (Zernio committed before our request aborted):
     - Use `accountId` and `locationId` from the listing.
     - Round-16 correction: use `INSERT ... RETURNING` and conditional follow-ups. If the connection insert hits ON CONFLICT (an active row already exists), we must NOT blindly resolve the incident — that existing row may point to a DIFFERENT account, and resolving the incident would lift the block while leaving the recovered Zernio account orphaned. Verify and branch:
       ```sql
       BEGIN;

       -- Try to insert; capture whether a row was actually written.
       WITH ins AS (
         INSERT INTO zernio_connections (
           id, business_id, zernio_profile_id, zernio_account_id,
           zernio_location_id, status, connected_at
         ) VALUES (
           gen_random_uuid(), :business_id, :profile_id, :account_id,
           :location_id, 'active', NOW()
         )
         ON CONFLICT (business_id) WHERE status IN ('pending','active') DO NOTHING
         RETURNING id
       )
       SELECT (SELECT id FROM ins) AS inserted_id,
              (SELECT zernio_account_id FROM zernio_connections
                 WHERE business_id = :business_id AND status = 'active'
                 LIMIT 1) AS existing_account_id;
       -- (Run this query, inspect the result in your psql session.)
       ```

     - **Sub-case A-1**: `inserted_id IS NOT NULL` — fresh row created. Proceed with the drain + resolve in the SAME tx:
       ```sql
       -- continuing in the same transaction:
       INSERT INTO job_outbox (
         id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
       ) VALUES (
         gen_random_uuid(), 'drain_pending_owner_connect',
         'business', :business_id,
         jsonb_build_object('business_id', :business_id),
         0, 5
       );

       UPDATE zernio_finalize_incidents
       SET resolved_at = NOW(),
           resolution = 'account_found',
           zernio_account_id = :account_id,
           zernio_location_id = :location_id,
           updated_at = NOW()
       WHERE business_id = :business_id AND resolved_at IS NULL;

       COMMIT;
       ```

     - **Sub-case A-2**: `inserted_id IS NULL` AND `existing_account_id = :account_id` — there's already an active row pointing at the SAME account (likely a previous reconciliation already happened, or a parallel auto-finalize succeeded). Just resolve the incident:
       ```sql
       UPDATE zernio_finalize_incidents
       SET resolved_at = NOW(),
           resolution = 'manual_admin_other',
           resolution_notes = 'pre-existing active row with same account_id',
           updated_at = NOW()
       WHERE business_id = :business_id AND resolved_at IS NULL;
       COMMIT;
       ```

     - **Sub-case A-3**: `inserted_id IS NULL` AND `existing_account_id != :account_id` — there's an active row for a DIFFERENT account. This is a hard conflict — the recovered Zernio account is orphaned. Do NOT resolve; ROLLBACK; escalate (delete the orphan via Zernio API, then revisit whether the existing row is correct). Manual judgement required.
       ```sql
       ROLLBACK;
       -- Then, separately:
       -- (1) Verify with the customer which account they actually intended.
       -- (2) Either: (a) delete the recovered account via Zernio (it's the
       --     orphan) AND mark incident resolved with notes; OR
       --     (b) replace the existing zernio_connections row + delete its
       --     account at Zernio + insert the recovered one + resolve.
       -- This branch is rare and judgment-laden — escalate to engineering.
       ```

       Without the `drain_pending_owner_connect` outbox row in the same tx (Sub-case A-1), any responses already in `awaiting_owner_connect` would stay stuck forever even though the connection is now active. The incident-resolve in the same tx ensures atomic transition.
     - Then clear the Redis pending marker via Lua CAS (helper from §3.2 step 3): `redis.eval(luaDeletePendingByFlowIdAnyStatus, 1, 'connect_pending:'+businessId, flowId)`.
  4. **Branch B — no account exists** (Zernio did NOT commit — our timeout was real):
     - Update incident as resolved with no-account outcome:
       ```sql
       UPDATE zernio_finalize_incidents
       SET resolved_at = NOW(),
           resolution = 'no_account',
           updated_at = NOW()
       WHERE business_id = :business_id AND resolved_at IS NULL;
       ```
     - Clear the Redis pending marker (same Lua CAS as Branch A). Owner restarts the flow normally.
  5. Note the resolution in the Sentry alert and the launch runbook log. The `zernio_finalize_incidents` row is the durable audit trail — do NOT delete it, only mark resolved.
- **`docs/Implementation_Phases_SerpAPI_First.md`** — annotate Phase 5 (GBP API direct) as "superseded for posting by Zernio Phase 1; still relevant for direct OAuth migration if/when Google approval arrives"

---

## 9. Total scope summary

- 1 migration (`026_zernio_publishing.sql`) covering: `responses.status` column widened to TEXT; new `zernio_connections` table; new `zernio_finalize_incidents` table (round-15 — durable record of unknown-outcome finalize attempts); reworked partial unique index from migration 023; 2 new notification dedup indexes; new `idx_jo_publish_response_inflight` partial unique index (round-6 addition); pre-index duplicate cleanup (round-9)
- 4 new env vars (`ZERNIO_PUBLISHING_ENABLED` flag, `ZERNIO_API_KEY` + `ZERNIO_WEBHOOK_SECRET` required when flag on, `ZERNIO_PROFILE_ID_PREFIX` optional). `WORKER_PUBLIC_URL` and `NEXT_PUBLIC_APP_URL` are existing requirements that get reused.
- 15 new files in `src/`: 3 UI (2 pages + 1 banner component at `src/components/dashboard/ConnectGoogleBanner.tsx`), 5 API routes (`connect/start`, `connect/callback`, `connect/select-location`, `connect/cancel`, `disconnect`), 4 `lib/zernio/*` (`client.ts`, `connect-state.ts`, `types.ts`, `errors.ts` — `errors.ts` exports `ZernioRouteError` for route-layer typed errors), 1 `lib/publishing/zernio-publisher.ts`, 2 email templates at `src/lib/notifications/email/templates/owner-reconnect-required.ts` and `owner-connection-lost.ts` (round-final additions)
- 4 new files in `worker/`: `ingress/zernio.ts`, `ingress/zernio-verify.ts`, `jobs/DrainOwnerConnectWorker.ts`, `jobs/OwnerEmailWorker.ts`
- 5 modified worker files:
  - `worker/jobs/ResponsePublisherWorker.ts` — Zernio branching (Sec 4)
  - `worker/startup-assert.ts` — Zernio env-var assertions (Sec 5.6)
  - `worker/index.ts` — register `/ingress/zernio` route; register `DrainOwnerConnectWorker` + `OwnerEmailWorker`; attach `publisherWorker.on('failed')` handler (Sec 4.4)
  - `worker/queues.ts` — register `DRAIN_OWNER_CONNECT` + `SEND_OWNER_EMAIL` queues
  - `worker/ingress/resend.ts` — add 2 new templates to `OWNER_DIRECTED_TEMPLATES` (Sec 5.5)
- 4 shared file updates (round-final added items 3 and 4):
  - `src/lib/shared/queue-names.ts` — add `DRAIN_OWNER_CONNECT` + `SEND_OWNER_EMAIL` constants
  - `src/lib/shared/worker-types.ts` — add `SendOwnerEmailPayload` (discriminated) + `DrainOwnerConnectPayload` types
  - `src/lib/shared/subscription-guard.ts` — extend `WorkerType` union with `'owner_email'` + `'drain'` (no behavior change, just enum membership for the same gating rules)
  - `src/lib/dashboard/types.ts` + the dashboard data API route — add `zernioConnection: { status, queuedReconnectCount, hasUnresolvedIncident, lastDisconnectReason? }` to the response shape so `useDashboardData()` exposes it to `ConnectGoogleBanner`
- 1 OutboxPoller config update: `worker/jobs/OutboxPoller.ts` — extend `topicToQueue` map for 3 new topics (Sec 2.4)
- 2 new docs (`docs/zernio-launch-runbook.md` + CLAUDE.md updates)

`worker/jobs/NotificationWorker.ts` is NOT modified — owner emails go through the new `OwnerEmailWorker` (per the Section 2.4 correction). Existing `SEND_NOTIFICATION` queue and worker remain untouched.

---

## 10. Open issues / risks

| # | Risk | Mitigation |
|---|------|-----------|
| 1 | **Headless OAuth assumption — `redirectUrl` + `state` params** were inferred from standard OAuth conventions; Zernio docs were thin on these specific field names. If Zernio's actual headless flow uses polling for `connect_token` instead of redirect, callback route becomes a polling endpoint (architecture otherwise identical). | Verify in first implementation step before writing the routes. If wrong, swap GET callback for POST poll-for-token; everything else unchanged. |
| 2 | **`provider_review_id` mismatch rate** unknown until Phase 1. SerpAPI's synthetic ID may differ enough from Zernio's view (e.g. anonymous reviewers, reviews edited between SerpAPI poll and Zernio post) that match rate is < 95%. | Phase 1 instrumentation: log every `lookupZernioReviewId` outcome. If mismatch rate > 5%, escalate to Phase 1.5 — add a backfill step that pre-populates Zernio review IDs at connection time. |
| 3 | **Zernio reply API behavior on already-existing reply** unconfirmed (overwrite vs error). | Implementation handles both: 200 OK and 409 already-exists are both treated as success. If actual behavior is "200 OK with overwritten content," that's also fine — the response text is what we wanted to post. |
| 4 | **Zernio outage during Phase 2** breaks publishing for all connected businesses simultaneously. | Connections gracefully degrade to `awaiting_owner_connect`. No silent loss. Manual-post escape hatch remains for emergencies (admin can trigger). Sentry alerts on `ZernioTransientError` rate spike. |
| 5 | **Webhook secret rotation** requires coordinated env-var update + Zernio dashboard update. | Document in launch runbook. Worker handles a brief window of signature failures with 401 (Zernio retries 7x over 51h, easily covers a rotation window). |
| 6 | **Drain worker race**: connection becomes active → drain enqueues N publish jobs → owner immediately disconnects → all N transition to `awaiting_owner_connect`. | This is correct behavior, not a bug — the disconnect is real and the responses correctly queue for next reconnect. Idempotent. |

---

## 11. References

- `worker/ingress/stripe.ts` — webhook ingress pattern (signature verify → `claimInboundEvent` → switch on event)
- `worker/jobs/ResponsePublisherWorker.ts` — current manual-post worker (Steps 1-3 preserved, Steps 4-8 replaced)
- `supabase/migrations/023_non_terminal_response_uniqueness.sql` — the partial unique index this design widens
- `supabase/migrations/024_notification_delivery_dedup.sql` — claim-before-send dedup pattern this design extends
- `src/app/onboarding/business/guard.ts` — `resolveWizardDestination` (no changes needed; connect lives post-wizard)
- `docs/Implementation_Phases_SerpAPI_First.md` — Phase 5 (superseded for posting by this spec)
- Zernio docs:
  - https://docs.zernio.com/guides/connecting-accounts
  - https://docs.zernio.com/google-business/get-google-business-reviews
  - https://docs.zernio.com/google-business/reply-to-google-business-review
  - https://docs.zernio.com/webhooks
