# Phase 1 — SMS Notification Channel — Design Spec

_2026-04-21 — RepWorth — ships SMS as the first non-email approval channel_

Parent spec: `docs/adding-communication-channels.md` (§5.1 Phase 1). That document
owns the cross-channel architecture; this doc owns the Phase 1 implementation
detail and supersedes the parent on any conflict for Phase 1 scope.

## 1. Goal

Add SMS as a verified peer of email in RepWorth's approval-notification
dispatcher, end-to-end: owner enrollment via admin UI, Twilio Verify code check,
approval notifications with working links, delivery webhooks, and TCPA-compliant
STOP handling. Ships behind a single env flag so code lands before a production
sender is registered.

## 2. Scope

**In scope (Phase 1):**

- `SmsChannel` implementation wiring the existing `NotificationChannel` interface
  (Phase 0) to Twilio Programmable SMS via a Messaging Service SID.
- SMS enrollment flow in admin onboarding, using Twilio Verify.
- `worker/ingress/twilio.ts` — signature verify, `inbound_events` dedup,
  delivery-status updates, STOP/START webhook handling.
- Per-business + global daily SMS cost ceiling (Redis) in a new
  `src/lib/costs/sms-tracker.ts`.
- `CHANNELS_SMS_ENABLED` env flag gating the factory, admin widget, API routes,
  and dispatcher.
- Migration 022 bundles: Phase 0's deferred `businesses.notification_preference`
  drop, `channel_enrollments` soft-delete columns + partial unique index,
  SMS handle lookup index, `sms_sender_opt_outs` table (current
  sender-level opt-out state, composite-keyed by
  `(messaging_service_sid, handle)`), `sms_sender_opt_out_events`
  append-only audit table, and RLS on both new tables.
- Unit + integration tests per new surface.

**Out of scope (deferred to later phases):**

- Telegram + WhatsApp (Phases 2/3 of parent spec).
- Owner self-service channel dashboard (Phase 4).
- SMS-based inline approve/regenerate (SMS has no inline-button UI; owner taps
  the URL to land on the existing web approval page).
- URL shorteners / branded short domain.
- Chinese / multilingual STOP handling beyond Twilio-native EN + ES.
- Automated 10DLC campaign registration (a paperwork task outside code).

## 3. Prerequisites

**Phase 0 is shipped.** All of the following already exist and are not
re-specified here: `channel_enrollments` table, `NotificationChannel` interface,
`EmailChannel`, `getChannel` factory, `NotificationWorker` dispatcher pattern,
failover poller with stale-branch admin alert, email backfill of existing
businesses.

**Twilio account state:** Account + verified trial number already provisioned.
Phase 1 code can be developed against the Twilio trial API immediately. The
production sender strategy (§7) runs in parallel and does not block code
landing.

## 4. Decisions (from brainstorming)

| # | Question | Decision | Rationale |
|---|---|---|---|
| 1 | Feature gating | Single `CHANNELS_SMS_ENABLED` env flag, default `false` | One seatbelt; matches `MOCK_EXTERNAL_APIS` / `RANKING_TRACKING_ENABLED` pattern |
| 2 | Production sender | Toll-free interim + 10DLC final via **Twilio Messaging Service SID** | Sender swap is zero-deploy — Twilio handles sender selection from the service pool |
| 3 | 10DLC timing | Kick off paperwork on day 0 of Phase 1 coding, parallel to implementation | 1–3 week external lead time is the long pole; code is not the critical path |
| 4 | Enrollment verification | Twilio Verify API (separate service SID, separate sender pool) | Decouples one-time codes from approval-message sender reputation; fraud rules included; conversion-priced |
| 5 | STOP handling | DB-first with Twilio as safety net: webhook flips `unsubscribed_at`; send-time 21610 also flips it | Closes webhook-lost gap; keeps dispatcher skip logic simple (`unsubscribed_at IS NULL`) |
| 6 | Re-enable after STOP | **Two-step: (a) observe inbound START webhook → updates `sms_sender_opt_outs.opted_in_at`; (b) admin runs fresh Verify OTP → status flips verified.** No silent re-subscribe. Sender-level opt-out state persists in a dedicated `sms_sender_opt_outs` table so that archive/re-enroll cycles cannot bypass the gate. | Twilio's Messaging Service opt-out list is SENDER-scoped; Twilio Verify uses a different sender pool and cannot clear the MS opt-out. Requiring an observed START at OUR sender, tracked in a sender-keyed table, guarantees Twilio has cleared the block on their side before our next approval SMS. TCPA-aligned. |
| 6a | Phone-number change | `/delete` route **soft-deletes** (sets `archived_at`); row preserved for audit. Partial unique index allows fresh enrollment with different phone after archive. | Preserves TCPA consent/opt-out evidence. Hard-delete would wipe the paper trail if legally challenged. |
| 7 | Cost guard | Per-business + global daily SMS cents ceilings in Redis | Mirrors LLM cost guard mental model; 2 Redis keys |
| 7a | Default caps | `SMS_DAILY_LIMIT_CENTS_PER_BUSINESS=10`, `SMS_DAILY_LIMIT_CENTS_GLOBAL=500` | ~12 sends/biz/day, ~600 sends/day globally — generous but bug-safe |
| 8 | Country | US only | 10DLC is US-only; matches existing SerpAPI US focus |
| 9 | STOP languages | English + Spanish, Twilio-native only | Enable in Twilio dashboard; zero app code; Chinese deferred |
| 10 | SMS copy | 1 GSM-7 segment, no emoji, `Reply STOP to unsubscribe.` suffix on every send | 50% cheaper per send; name-truncation rule handles overflows |
| 11 | Credential storage | Plain env vars (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_MESSAGING_SERVICE_SID`, `TWILIO_VERIFY_SERVICE_SID`) | Global secrets, not per-tenant; KEK/DEK adds overhead without benefit |
| 12 | Dispatcher parallelism | Stay sequential | ~1–2s added to notification send is acceptable; parallelism adds error-isolation complexity |
| 13 | Failover poller | Untouched | Already channel-agnostic; stale branch already admin-alerts |

## 5. Architecture — `SmsChannel`

File: `src/lib/notifications/channels/sms-channel.ts`

Implements the existing `NotificationChannel` interface. No changes to the
dispatcher's send loop — Phase 1 replaces the factory's "not yet implemented"
throw for `sms` with a real instance.

```ts
// Pseudocode — actual implementation uses async/await, typed errors, structured logs.
// NOTE: cost guard lives in the DISPATCHER (see §9, §11), not here.
// This preserves the parent spec's invariant that cross-cutting concerns
// (cost, subscription, bounce, idempotency) do not leak into channels.
export class SmsChannel implements NotificationChannel {
  readonly id: ChannelId = 'sms';
  readonly supportsInlineActions = false;
  readonly requiresOptInHandshake = false;

  async sendApprovalRequest(p: SendApprovalParams): Promise<SendApprovalResult> {
    // 1. Format body (see §7). sms-body.ts returns a string guaranteed ≤ 160 GSM-7 chars.
    const body = formatApprovalSms({
      reviewerName: p.reviewerName,
      starRating: p.starRating,
      approvalUrl: p.approvalUrl,
    });

    // 2. Send via Twilio Messaging Service.
    try {
      const msg = await twilio.messages.create({
        messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID!,
        to: p.handle,          // E.164
        body,
        statusCallback: `${process.env.WORKER_PUBLIC_URL}/ingress/twilio/status`,
      });
      return { externalMessageId: msg.sid };  // SM-prefixed SID
    } catch (err) {
      // Twilio error codes: https://www.twilio.com/docs/api/errors
      //   21610 → number is unsubscribed (Twilio-authoritative opt-out list)
      //   21211 → invalid 'To' number
      //   21614 → number not SMS-capable (landline)
      // The 21610 case needs dispatcher-level handling (flip the enrollment,
      // skip it for future sends). We surface it as a typed error so the
      // dispatcher can act — channel does NOT write to channel_enrollments
      // directly (another cross-cutting concern).
      if (isUnsubscribedError(err)) throw new SmsRecipientUnsubscribedError();
      throw err;
    }
  }
}
```

**Why `requiresOptInHandshake = false`.** SMS can be sent to any verified E.164
number without per-send handshake. The one-time enrollment verification (§8) is
the opt-in. Telegram/WhatsApp (future phases) set this `true` because they
require the owner to initiate chat before we can send at all.

**Why `supportsInlineActions = false`.** SMS has no inline button UI. The URL in
the body lands on the existing web approval page. Dispatcher treats this as
equivalent to email for dispatch purposes.

### 5.1 Factory wiring

`src/lib/notifications/channels/index.ts` — replace the `NOT_YET_IMPLEMENTED`
guard for `sms` with a flag-gated instance:

```ts
export function getChannel(id: ChannelId): NotificationChannel {
  if (id === 'email') return new EmailChannel();
  if (id === 'sms') {
    if (process.env.CHANNELS_SMS_ENABLED !== 'true') {
      throw new Error('SMS channel disabled by CHANNELS_SMS_ENABLED env flag');
    }
    return new SmsChannel();
  }
  if (NOT_YET_IMPLEMENTED.has(id)) {
    throw new Error(`Channel "${id}" not yet implemented — scheduled for a later phase`);
  }
  throw new Error(`Unknown channel "${id}"`);
}
```

The flag-off path throws from `getChannel`. The dispatcher (§9) catches this
before reaching the factory via a dedicated defense-in-depth check so the error
path is not exercised in normal operation.

## 6. Data model

**Two new tables** — `sms_sender_opt_outs` (current sender-level opt-out
state, keyed by `(messaging_service_sid, handle)`) and
`sms_sender_opt_out_events` (append-only audit log of every STOP/START/21610
signal, retained for TCPA). Everything else reuses `channel_enrollments`
from Phase 0:
- `handle` = E.164 phone string (`+15551234567`)
- `status` = `'pending_verification'` → `'verified'` → `'disabled'` / `'unsubscribed'`
- `unsubscribed_at`, `unsubscribed_reason` already present
- `verification_token_hash` is unused for SMS (Twilio Verify owns the code
  lifecycle; we never see or store it)

**Migration 022** bundles Phase 0's deferred drop + Phase 1's schema
additions. The key structural change from prior drafts: **sender-level
opt-out state lives in a new `sms_sender_opt_outs` table, not on
`channel_enrollments`.** Twilio's Messaging Service opt-out list is keyed
by (sender, handle); putting it on the per-business enrollment row leaks
the gate across archive/recreate cycles (a phone opts out, admin deletes
the row, someone re-enrolls with the same phone → Twilio still blocks but
our DB says clean). A separate table makes opt-out state survive
enrollment lifecycle changes.

Ordering matters: ADD all columns BEFORE creating indexes that reference
them, to keep the migration self-consistent if re-run in parts.

```sql
-- supabase/migrations/022_sms_channel_infra.sql

-- 1. Drop deprecated column (promised in migration 021). No data loss —
-- commit 1b5d40e removed the last read/write before this migration.
ALTER TABLE businesses DROP COLUMN IF EXISTS notification_preference;

-- 2. Soft-delete support on channel_enrollments. /delete sets
-- archived_at rather than hard-deleting, preserving TCPA consent/opt-out
-- evidence for audit.
ALTER TABLE channel_enrollments
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archive_reason TEXT;

-- 3a. sms_sender_opt_outs: authoritative CURRENT sender-level opt-out
-- state. Keyed by (messaging_service_sid, handle) so future multi-MS
-- setups (staging/prod split, sender migration) scope opt-outs correctly
-- without over- or under-blocking. Persists across business enrollment
-- lifecycles so Twilio's actual block state is never out of sync with
-- our DB.
--
-- Lifecycle (single row per sender+handle):
--   Inbound STOP / send-time 21610 → UPSERT opted_out_at=NOW,
--     opted_in_at=NULL (reset any prior clear).
--   Inbound START → UPDATE opted_in_at=NOW (only if row exists from a
--     prior STOP; START without prior STOP is a no-op).
--   opted_in_at IS NULL AND opted_out_at IS NOT NULL ≡ "currently
--     blocked at Twilio's Messaging Service layer."
CREATE TABLE IF NOT EXISTS sms_sender_opt_outs (
  messaging_service_sid  TEXT NOT NULL,
  handle                 TEXT NOT NULL,
  opted_out_at           TIMESTAMPTZ NOT NULL,
  opted_in_at            TIMESTAMPTZ,
  last_event_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (messaging_service_sid, handle)
);

-- 3b. sms_sender_opt_out_events: append-only audit log of every STOP,
-- START, and send-time 21610 event. Durable TCPA evidence independent
-- of the 30-day inbound_events archival (worker/jobs/ArchivalPoller.ts)
-- so repeated opt-out/in cycles retain their full timeline.
CREATE TABLE IF NOT EXISTS sms_sender_opt_out_events (
  id                      UUID PRIMARY KEY,   -- uuidv7 (app-generated)
  messaging_service_sid   TEXT NOT NULL,
  handle                  TEXT NOT NULL,
  event_type              TEXT NOT NULL,   -- 'stop' | 'start' | '21610_at_send'
  source                  TEXT NOT NULL,   -- 'twilio_inbound_keyword' | 'twilio_optouttype' | 'twilio_21610'
  inbound_event_id        UUID REFERENCES inbound_events(id) ON DELETE SET NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sms_sender_opt_out_events_handle
  ON sms_sender_opt_out_events(messaging_service_sid, handle, created_at DESC);

-- 3c. RLS on both new tables. Matches Phase 0's channel_enrollments
-- posture. No policies defined → only service_role (worker + admin
-- routes using SUPABASE_SERVICE_KEY) can read/write. No owner-dashboard
-- access in Phase 1. Future phases add explicit read policies if
-- needed.
ALTER TABLE sms_sender_opt_outs ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_sender_opt_out_events ENABLE ROW LEVEL SECURITY;

-- 4. Replace the full UNIQUE(business_id, channel) with a partial unique
-- INDEX scoped to active (non-archived) rows. Partial indexes can't be
-- expressed as constraints, so we drop the constraint and create an index.
--
-- COORDINATED CODE CHANGE REQUIRED: every ON CONFLICT (business_id, channel)
-- DO UPDATE site in the codebase MUST include the index predicate, i.e.
--   ON CONFLICT (business_id, channel) WHERE archived_at IS NULL DO UPDATE ...
-- Postgres infers conflict targets from indexes; a partial index requires
-- the query's ON CONFLICT target to include the WHERE predicate verbatim.
-- Phase 0 upsert sites (see §13 Modified files) must land the predicate
-- update in the same PR as this migration.
ALTER TABLE channel_enrollments
  DROP CONSTRAINT IF EXISTS channel_enrollments_business_id_channel_key;
CREATE UNIQUE INDEX IF NOT EXISTS channel_enrollments_business_channel_active_key
  ON channel_enrollments (business_id, channel)
  WHERE archived_at IS NULL;

-- 5. Inbound webhook handle lookup index, scoped to ACTIVE rows only.
-- STOP/START handlers never act on archived rows (they'd be noisy and
-- misleading), so the index stays lean as audit history grows. Rare
-- archived-by-handle queries (TCPA challenges) can live with a seq scan.
CREATE INDEX IF NOT EXISTS idx_channel_enrollments_sms_handle
  ON channel_enrollments(handle)
  WHERE channel IN ('sms', 'whatsapp') AND handle IS NOT NULL AND archived_at IS NULL;
```

**Read/upsert query updates required across the codebase** (coordinated
with this migration; all listed in §13 Modified):

- `src/lib/notifications/enrollments.ts` — `getVerifiedEnrollments` adds
  `AND archived_at IS NULL` to its WHERE clause.
- `src/app/api/admin/businesses/route.ts` (line ~240) — Phase 0 email
  enrollment upsert: `ON CONFLICT (business_id, channel) WHERE archived_at IS NULL DO UPDATE ...`.
- `src/app/api/admin/businesses/[id]/route.ts` (line ~333) — Phase 0
  owner-email edit upsert: same predicate addition.
- `src/app/api/admin/businesses/[id]/channels/route.ts` (line ~50) —
  Phase 0 admin channels listing: add `AND e.archived_at IS NULL` to the
  SELECT (otherwise soft-deleted SMS rows would show up in the admin
  Channels section after a delete).
- All `SELECT ... FROM channel_enrollments` paths touched by Phase 1 use
  `AND archived_at IS NULL` in their WHERE clause to stay active-row-only.

**Re-enrollment after soft-delete.** An archived row for `(business_X, sms,
+15551111)` does not block inserting a new active row for the same
business + channel. The partial unique index only enforces "one active row
per (business, channel)." But see §8.2 — `/verify` separately consults
`sms_sender_opt_outs`, so re-enrollment with a handle that's still on
Twilio's opt-out list is blocked until START is observed, regardless of
archive state.

## 7. SMS body formatter

File: `src/lib/notifications/sms-body.ts`

```
New {starRating}-star review from {reviewerName}. Draft ready: {approvalUrl}
Reply STOP to unsubscribe.
```

### 7.1 Length budget — two tiers with graceful degradation

Fixed in 160 GSM-7 chars. Approval tokens are **36-char UUIDs** from
`randomUUID()` (see `src/lib/approval/create-link.ts:29`). `NEXT_PUBLIC_APP_URL`
is arbitrary. **Budget is computed at format time, with two fallback tiers.**

Two candidate templates:

**Tier 1 (preferred) — with reviewer name:**
```
New {N}-star review from {name}. Draft ready: {url}
Reply STOP to unsubscribe.
```
Fixed overhead = 66 chars (`"New N-star review from "` = 23, `". Draft ready: "` = 15, `"\nReply STOP to unsubscribe."` = 28).
Budget for `name + url` = 94 chars. For the realistic URL (≈69 chars), this
leaves ≈25 chars for the reviewer name — plenty for `"Jane D."` (7) up to
`"Bartholomew D."` (14).

**Tier 2 (fallback) — no reviewer name:**
```
New {N}-star review. Draft ready: {url}
Reply STOP to unsubscribe.
```
Fixed overhead = 60 chars (`"New N-star review"` = 17, `". Draft ready: "` = 15,
`"\nReply STOP to unsubscribe."` = 28). Budget for url = 100 chars.

Selection logic in `formatApprovalSms()` — compute the formatted name
first, THEN decide which tier fits, THEN fall back to throw:

```ts
// §7.2 returns a string that may be "Jane D." (7), "a reviewer" (10), or
// a truncated long name. We don't know the length a priori — compute it.
const formattedName = formatReviewerName(rawName);  // see §7.2

const tier1Length = 66 + formattedName.length + approvalUrl.length;
if (tier1Length <= 160) {
  return `New ${N}-star review from ${formattedName}. Draft ready: ${approvalUrl}\nReply STOP to unsubscribe.`;
}

// Tier 1 doesn't fit — drop the "from <name>" clause entirely.
const tier2Length = 60 + approvalUrl.length;
if (tier2Length <= 160) {
  return `New ${N}-star review. Draft ready: ${approvalUrl}\nReply STOP to unsubscribe.`;
}

// URL alone pushes tier 2 past 160. Deployment misconfig (extremely long
// NEXT_PUBLIC_APP_URL). Fail fast.
throw new SmsBodyTooLongError(tier2Length);
```

Length-based selection avoids the prior budget-threshold bug where a
budget of 8 or 9 chars would pass the tier-1 gate but couldn't fit the
10-char "a reviewer" fallback. With the new logic, any rendering that
doesn't actually fit in 160 chars moves down a tier.

`SmsBodyTooLongError` surfaces up to the dispatcher, which records a
failed delivery with `failure_reason='sms_body_too_long:<length>'` and
continues to the next enrollment. No Twilio call is made. Unit tests
assert boundary cases: tier-1 body at exactly 160 renders; at 161 falls
through to tier 2; tier-2 body at exactly 160 renders; at 161 throws.

### 7.2 Reviewer-name formatting rule

1. Normalize: trim whitespace; collapse inner whitespace to single space.
2. Transliterate non-GSM characters to ASCII via the `@sindresorhus/transliterate`
   npm package (small, maintained, handles CJK + accented Latin + Cyrillic).
   After transliteration, strip any remaining non-GSM-7 characters.
3. Format as `"{first} {lastInitial}."` (e.g., `"Jane D."`).
4. If transliteration produces an empty string, only punctuation, or only
   whitespace: use literal `"a reviewer"`.
5. If step 3's result exceeds 29 chars (rare — long first name): truncate to 25
   + `".."`.

### 7.3 Invariant + verification

`formatApprovalSms()` MUST return a string of `.length ≤ 160`, composed only
of characters in the GSM-7 default alphabet. Unit test enforces this across a
fixture set that includes: 1-star through 5-star, accented names (`José`),
CJK-only names, extreme-length names, empty-string names, names with surrogate
pairs.

## 8. Enrollment flow

### 8.1 Admin widget — location + payment gate + no-handle-change rule

**Location: `src/app/admin/businesses/[id]/page.tsx` only.** The sales
onboarding form at `/admin/businesses/new` currently redirects the sales
partner's browser straight to the Stripe Payment Link URL via
`window.location.href = paymentUrl` (`src/app/admin/businesses/new/page.tsx:245-252`).
No `business_id` exists in scope on that page, and the browser leaves the
admin app entirely on submission. **Phase 1 does NOT change onboarding
behavior** — the form keeps its current Stripe-redirect flow unchanged; the
SMS widget simply lives on the detail page, which the sales partner
navigates to after Stripe completes (or separately, once the owner has
paid).

**Payment gate (1C): SMS enrollment UI is locked on `pending_payment`
businesses.** Until Stripe confirms and `subscription_status` transitions to
`'active'`, the Channels section renders a locked state:

```
┌─ Channels ────────────────────────────────────┐
│ 📧 Email: owner@example.com    ✅ verified    │
│ 💬 SMS:   🔒 Complete payment first           │
└───────────────────────────────────────────────┘
```

This mirrors the shipped invariant from `.claude/CLAUDE.md` ("NotificationWorker
and ResponsePublisherWorker MUST skip pending_payment"). Gating the UI
rather than relying only on the dispatcher's subscription guard prevents
confusing sales-partner flows ("I enrolled them but no SMS is arriving") and
keeps TCPA consent scoping clean — consent is collected only after the
business is a paid customer. Phase 1 API routes ALSO enforce this
server-side (§8.2) as belt-and-suspenders; the UI gate is for UX, the route
gate is for correctness.

**No-handle-change rule (2C).** The widget NEVER lets an admin change the
phone number on an existing enrollment row. Re-enable from `disabled` or
`unsubscribed` always uses the row's current `handle`. To change the phone
number, the admin first **Deletes** the enrollment (soft-delete — sets
`archived_at`, preserves audit history — see §6 and §8.2), then enrolls
fresh from the empty state. The partial unique index on
`(business_id, channel) WHERE archived_at IS NULL` allows the new active
row to coexist with the archived one. This eliminates every
"cancel-mid-flow lost the prior handle" edge case — verify never mutates
an existing row's handle. Route-level enforcement is in §8.2.

**Flag plumbing: server-component owns the locked state; widget is only
rendered in interactive states.** The Channels section is a server
component (`src/components/admin/ChannelsSection.tsx`) that reads
`process.env.CHANNELS_SMS_ENABLED === 'true'` on the server AND the
business's `subscription_status`. It renders:

- Flag off → SMS row omitted entirely (email-only Channels section).
- Flag on + `subscription_status != 'active'` → renders a static locked
  row `"💬 SMS: 🔒 Complete payment first"` directly as JSX. No client
  widget.
- Flag on + `subscription_status == 'active'` → renders the client
  `<SmsEnrollmentWidget businessId={...} />`. The widget takes only
  `businessId` as a prop — it never renders the locked state because it is
  never mounted in that context.

This ownership split keeps the client bundle minimal (no locked-UI code
ships to browsers that can't reach it anyway) and avoids drift between
two places that could render "locked" differently. No `NEXT_PUBLIC_*` flag
leak.

`src/app/admin/businesses/[id]/page.tsx` is the thing being refactored —
if currently a `'use client'` component, the refactor converts it to a
server component wrapping client subcomponents (existing pattern in the
codebase).

**UI state machine** (widget only; locked pending-payment is handled by
the server parent):

```
empty (no active channel_enrollments row exists for channel='sms')
  → [enter E.164 phone] → POST /verify → on 200, state=sent

sent (status='pending_verification')
  → [enter 6-digit code] → POST /confirm → state=verified
  → [Cancel] → POST /cancel → revert to prior state or to empty (§8.2)

verified (status='verified')
  → shows ✅ with masked phone
  → [Disable] → POST /disable → state=disabled
  → [Delete enrollment] (confirmation required) → POST /delete → state=empty

disabled (status='disabled')
  → shows ⛔ with masked phone
  → [Re-enable — will send code to <same masked phone>]
    → POST /verify → state=sent (no START required; Twilio never blocked)
  → [Delete enrollment] (confirmation required) → POST /delete → state=empty

unsubscribed (status='unsubscribed', /status returns sender_opt_in_cleared=false)
  → shows 🚫 with reason, masked phone
  → [Start re-enable]
    → WIDGET CHANGES TO awaiting_sender_opt_in (see below)
  → [Delete enrollment] (confirmation required) → POST /delete → state=empty

awaiting_sender_opt_in (status='unsubscribed', /status sender_opt_in_cleared=false,
                        widget is polling for clear signal)
  → shows instructional text:
    "To re-enable SMS for +1 XXX-XXX-1234, ask the owner to text START
     to our RepWorth number +1 YYY-YYY-YYYY. We'll detect it automatically.
     This confirms they've opted back in at the carrier level."
  → widget polls GET /api/admin/channels/sms/status every 3s
    (or subscribes to Supabase Realtime on sms_sender_opt_outs keyed
     by the enrollment's handle)
  → when /status sender_opt_in_cleared flips to true (inbound /ingress/twilio
    START handler updated sms_sender_opt_outs.opted_in_at), widget
    advances to opt_in_received
  → [Cancel waiting] → returns to unsubscribed (no DB change; just UI state)

opt_in_received (status='unsubscribed', /status sender_opt_in_cleared=true)
  → shows ✅ "Opt-in detected. Now we'll verify possession with a 6-digit code."
  → [Send verification code]
    → POST /verify → state=sent
  → [Cancel] → returns to unsubscribed (no DB change)
```

Re-enable explicitly names the phone number being re-verified. No phone
input field appears on `disabled`, `unsubscribed`, or `awaiting_sender_opt_in`
states — the row's existing handle is used. To use a different number, admin
clicks **Delete enrollment** (confirmation modal: "This soft-deletes the
enrollment while preserving audit history. A new enrollment can then be
created with a different phone number. Continue?"). The record is archived,
not destroyed (§6 migration 022).

**Why the two-step re-enable for unsubscribed.** Twilio's Messaging
Service opt-out list is scoped to that sender; Twilio Verify uses a
separate sender pool and can send OTPs regardless. A successful Verify
round-trip DOES NOT clear the Messaging Service opt-out list. Without the
START gate, the DB would say `verified` but the next real approval SMS
would 21610-fail. START is the carrier-level mechanism for re-opting-in,
and observing it via webhook is our signal that Twilio has cleared the
block on its side.

### 8.2 API routes (five total: verify, confirm, cancel, disable, delete, plus the read-only status poll)

All routes share these guards (return `404` on flag-off, `403` on
subscription gate):
- Admin role (existing middleware).
- `CHANNELS_SMS_ENABLED !== 'true'` → `404`.
- Business `subscription_status != 'active'` → `403` with
  `{ ok: false, reason: 'subscription_not_active' }`. Enforces the 1C
  payment gate even if a caller bypasses the UI.

Routes `/verify`, `/confirm`, `/cancel`, `/disable`, and `/delete` enforce
the **no-handle-change rule (2C)** by rejecting any request that would alter
the `handle` on an existing active row. Semantics below.

---

**`POST /api/admin/channels/sms/verify`** — start a code-send. Body
`{ business_id, phone? }` — `phone` is REQUIRED only when no active
enrollment row exists (brand-new enrollment). For existing rows
(disabled/unsubscribed re-enable) the UI has no phone input; server uses
the row's existing handle. If the UI erroneously submits `phone` for an
existing-row case, server enforces that it matches `row.handle` (backstop
for the no-handle-change rule).

Wrapped in a transaction with a per-(business_id, 'sms') advisory lock to
serialize concurrent admin calls (matches the `createApprovalLink`
per-(response_id, channel) lock pattern shipped in commit `d01d729`).
The lock is held across the Twilio Verify call — that call is ~1s in
practice and admin-verify volume is low enough that serial execution is
fine. Without the lock, two admins starting Send-code simultaneously both
see "no row", both send OTPs, and one loses the partial-unique race on
INSERT, returning a confusing 500.

Twilio-first ordering: call Verify BEFORE mutating DB state so a Twilio
failure doesn't leave the row stranded in `pending_verification`.

```ts
await sql.begin(async (tx) => {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`sms_enroll:${businessId}`}, 0))`;
  // Steps 1-6 below all run inside this transaction/lock.
});
```

1. Load the current ACTIVE enrollment row (if any):
   ```sql
   SELECT handle, status FROM channel_enrollments
   WHERE business_id=$1 AND channel='sms' AND archived_at IS NULL
   ```
2. Resolve `twilioPhone` + request-shape validation. **This is where the
   no-handle-change rule (2C) and the input-shape rule are enforced.**
   - **No row** → body MUST include `phone`. Validate it parses as E.164
     `+1` via `libphonenumber-js`; reject `400 phone_required` on missing
     or `400 phone_invalid` on parse failure. Set `twilioPhone = phone`.
     Action on step 5: `INSERT` active row.
   - **Row with `status='pending_verification'`** → `twilioPhone = row.handle`.
     If body includes `phone` and it differs from `row.handle` → reject
     `400 handle_change_forbidden`. Action on step 5: no DB change
     (re-send the code).
   - **Row with `status='disabled'`** → `twilioPhone = row.handle`. Same
     phone-match backstop. Action on step 5: `UPDATE status='pending_verification'`.
   - **Row with `status='unsubscribed'`** → `twilioPhone = row.handle`.
     Same phone-match backstop. Action on step 5:
     `UPDATE status='pending_verification'`. Step 3's sender-opt-in gate
     is what actually admits this transition.
   - **Row with `status='verified'`** → `400 already_verified`. Admin
     must Disable or Delete first.
3. **Sender-level opt-out gate.** Query `sms_sender_opt_outs` scoped to
   the current Messaging Service SID:
   ```sql
   SELECT opted_out_at, opted_in_at FROM sms_sender_opt_outs
   WHERE messaging_service_sid = ${process.env.TWILIO_MESSAGING_SERVICE_SID}
     AND handle = ${twilioPhone}
   ```
   If row exists AND `opted_out_at IS NOT NULL` AND `(opted_in_at IS NULL
   OR opted_in_at < opted_out_at)`: return `400 sender_opt_in_required`.
   This gate applies **unconditionally** — brand-new enrollments,
   disabled re-enables, unsubscribed re-enables, and post-delete fresh
   enrollments all consult it. Twilio's opt-out list is keyed by
   (sender, handle), so the gate is scoped the same way. If we ever ship
   a second Messaging Service, each has its own opt-out list and each
   gate is evaluated independently.
4. Call `twilio.verify.v2.services(VERIFY_SID).verifications.create({ to: twilioPhone, channel: 'sms' })`.
   - On Twilio error (any reason): return `500 verify_send_failed`. **No
     DB mutation** — Twilio-first ordering means the row stays in
     whatever state it was before this call.
5. Execute the resolved DB action (INSERT new active row, or UPDATE
   status to `pending_verification`). Do NOT clear `unsubscribed_at`,
   `unsubscribed_reason`, `disabled_at`, or `verified_at` — those are
   preserved for audit and cancel-revert. Check `RETURNING id` row count
   = 1 for UPDATE (else 409 Conflict — race with cancel/delete).
6. Return `{ ok: true, phoneMasked: '+1 XXX-XXX-1234' }`.

---

**`POST /api/admin/channels/sms/confirm`** — check the code. Body
`{ business_id, code }`. No `phone` — the row's handle is authoritative.

Wrapped in the same per-(business_id, 'sms') advisory lock as /verify.

1. Load the active enrollment row (any status):
   ```sql
   SELECT handle, status FROM channel_enrollments
   WHERE business_id=$1 AND channel='sms' AND archived_at IS NULL
   ```
   If no row at all → `400 no_pending_verification` (truly nothing in
   progress — admin probably cancelled, or this is a stale UI).

2. **Re-check the sender-opt-out gate** before dispatching on status.
   `sms_sender_opt_outs` is the authoritative source of truth for "can
   we send" — checking it first ensures the STOP-race case produces the
   specific error rather than a generic state-conflict message.
   ```sql
   SELECT opted_out_at, opted_in_at FROM sms_sender_opt_outs
   WHERE messaging_service_sid = ${process.env.TWILIO_MESSAGING_SERVICE_SID}
     AND handle = ${row.handle}
   ```
   If opted out (same predicate as /verify's gate) → return
   `409 sender_opted_out_during_verification`. Admin widget advances
   back to `unsubscribed` / `awaiting_sender_opt_in`.
   This catches the race: /verify passed the gate at T0, owner texted
   STOP at T1 (inbound webhook flipped both `channel_enrollments.status`
   → 'unsubscribed' and `sms_sender_opt_outs` → opted out), /confirm at
   T2 now sees the opt-out before dispatching on the stale status.

3. Dispatch on row status:
   - `status='pending_verification'` → proceed to step 4.
   - Any other status (`unsubscribed` without an opt-out — webhook
     partial commit; `verified`; `disabled`) → `409 row_not_pending`
     (state conflict; row transitioned out of `pending_verification`
     between /verify and /confirm).

4. Call `twilio.verify.v2.services(VERIFY_SID).verificationChecks.create({ to: row.handle, code })`.
5. On `result.status === 'approved'`, atomically:
   ```sql
   UPDATE channel_enrollments
   SET status='verified',
       verified_at=NOW(),
       unsubscribed_at=NULL,
       unsubscribed_reason=NULL,
       updated_at=NOW()
   WHERE business_id=$1 AND channel='sms'
     AND status='pending_verification' AND archived_at IS NULL
   RETURNING id
   ```
   Clearing the unsubscribe fields here (and ONLY here) makes the state
   transition back to a clean verified row. We do NOT touch
   `sms_sender_opt_outs` or `sms_sender_opt_out_events` — sender-level
   opt-in state was established by the inbound START webhook that
   unblocked this verification, and that event is already in the append-only
   audit log. Subsequent STOP events will reset `opted_in_at=NULL`
   naturally (§10.5 STOP handler).

   RETURNING row count must be 1 (else raise — race with cancel/delete).
6. On any other Verify status → `400 invalid_code_or_expired`.
7. Verify codes have a ~10-minute TTL managed by Twilio; no server-side
   expiry tracking needed.

---

**`POST /api/admin/channels/sms/cancel`** — abort a pending verification
and revert to the prior terminal state. Body `{ business_id }`.

Wrapped in the advisory lock. Because `/verify` never changes an existing
row's handle, cancel can safely restore the row to whichever terminal
state it was in before:

```sql
WITH reverted AS (
  UPDATE channel_enrollments
  SET status = CASE
        WHEN unsubscribed_at IS NOT NULL THEN 'unsubscribed'
        WHEN disabled_at     IS NOT NULL THEN 'disabled'
        WHEN verified_at     IS NOT NULL THEN 'verified'
        ELSE 'pending_verification'  -- brand-new row: no prior terminal
      END,
      updated_at = NOW()
  WHERE business_id = $1 AND channel = 'sms'
    AND status = 'pending_verification' AND archived_at IS NULL
  RETURNING id, status
)
DELETE FROM channel_enrollments
WHERE id IN (SELECT id FROM reverted WHERE status = 'pending_verification');
```

For brand-new rows (no terminal timestamps), the CASE falls through to
`'pending_verification'` (effective no-op), then the DELETE removes it,
returning the business to `empty` UI state. For rows with prior terminal
state, the CASE restores it and the DELETE is a no-op.
`sms_sender_opt_outs` is untouched — cancel doesn't affect sender-level
opt-out/in state.

---

**`POST /api/admin/channels/sms/disable`** — disconnect a verified
enrollment. Body `{ business_id }`.

Wrapped in the advisory lock.

```sql
UPDATE channel_enrollments
SET status='disabled', disabled_at=NOW(), updated_at=NOW()
WHERE business_id=$1 AND channel='sms'
  AND status='verified' AND archived_at IS NULL
RETURNING id
```

Dispatcher skips non-verified active rows (existing `getVerifiedEnrollments`
filter + new `archived_at IS NULL` clause). No Twilio side-effect.
RETURNING row count must be 1 for a 200 response; else 409 (state
changed concurrently).

---

**`POST /api/admin/channels/sms/delete`** — soft-delete the active
enrollment row to enable a phone-number change, preserving TCPA evidence
(consent + opt-out timestamps). Body `{ business_id, confirm: true }`.

Wrapped in the advisory lock. Soft-delete only — archived rows stay
queryable:

```sql
UPDATE channel_enrollments
SET archived_at=NOW(),
    archive_reason='admin_delete',
    updated_at=NOW()
WHERE business_id=$1 AND channel='sms' AND archived_at IS NULL
RETURNING id
```

The row remains queryable for audit; TCPA challenges can retrieve the full
consent/opt-out timeline via `archived_at IS NOT NULL` filter.
Re-enrollment after delete is allowed because the partial unique index
(§6) scopes uniqueness to active rows.

**Delete does NOT bypass the sender-opt-out gate.** If the owner's phone
was opted out at the Twilio Messaging Service level (STOP event), that
state lives in `sms_sender_opt_outs` keyed by
`(messaging_service_sid, handle)` — independent of `channel_enrollments`.
A fresh enrollment via `/verify` for the same handle will consult
`sms_sender_opt_outs` (step 3 of `/verify`, scoped to the current
`TWILIO_MESSAGING_SERVICE_SID`) and reject with `sender_opt_in_required`
until a START is observed. The archive/re-enroll path cannot launder
opt-out state.

`confirm: true` in the body is required — the route rejects
`400 confirmation_required` otherwise. This is accidental-submit /
double-click defense (e.g., distinct second API call required by an
interactive client), NOT CSRF protection. CSRF is handled by the
existing same-origin + admin-session middleware on the route.

After delete, the widget returns to the `empty` state. Admin can enroll
a new phone number (different from the archived handle) from scratch
via `/verify`, which INSERTs a new active row without colliding with the
archived row's (business_id, channel) pair thanks to the partial unique
index.

---

**`GET /api/admin/channels/sms/status`** — read-only poll endpoint for the
widget's `awaiting_sender_opt_in` state. Query `?business_id=<id>`.

```sql
SELECT ce.status, ce.handle, ce.verified_at, ce.disabled_at,
       ce.unsubscribed_at, ce.unsubscribed_reason, ce.archived_at,
       -- Sender-level opt-in state from sms_sender_opt_outs, scoped to
       -- the current Messaging Service SID. sender_opt_in_cleared is
       -- TRUE iff Twilio's Messaging Service currently permits sends
       -- to this handle from THIS sender (never opted out, or opted
       -- back in after the most recent STOP).
       CASE
         WHEN so.handle IS NULL THEN TRUE  -- never opted out from this sender
         WHEN so.opted_in_at IS NOT NULL AND so.opted_in_at > so.opted_out_at THEN TRUE
         ELSE FALSE
       END AS sender_opt_in_cleared
FROM channel_enrollments ce
LEFT JOIN sms_sender_opt_outs so
  ON so.handle = ce.handle
 AND so.messaging_service_sid = $2  -- process.env.TWILIO_MESSAGING_SERVICE_SID
WHERE ce.business_id=$1 AND ce.channel='sms' AND ce.archived_at IS NULL
```

Returns 200 with the row data (or `null` if no active row). Widget uses
`sender_opt_in_cleared` to detect when the owner's START has cleared
Twilio's opt-out list. Polling the derived boolean (rather than a column
on `channel_enrollments`) means the widget naturally reflects
`sms_sender_opt_outs` updates from the inbound webhook handler.

When Supabase Realtime is configured on `sms_sender_opt_outs`, the widget
subscribes to changes on the row keyed by the current enrollment's handle
rather than polling. Polling remains the fallback and handles initial
hydration.

### 8.3 E.164 validation

Add dependency: `libphonenumber-js`. Use `parsePhoneNumber(input, 'US')` for
normalization. Reject anything that doesn't parse to a `+1` NANP number. This
matches the US-only scope (Q8).

## 9. Dispatcher changes

File: `worker/jobs/NotificationWorker.ts`

Four additions, all inside the per-enrollment loop, ordered:

### 9.1 Flag-off defense-in-depth (before anything else for sms)

```ts
if (channelId === 'sms' && process.env.CHANNELS_SMS_ENABLED !== 'true') {
  logger.log(`SMS channel disabled by flag — skipping enrollment for business ${business_id}`);
  continue;
}
```

### 9.2 Reservation + link creation + send wrapped in one try/finally

The reservation must be refunded on ANY failure between the reserve call
and the successful Twilio ACK — including `createApprovalLink` failures,
DB errors, or channel-level throws. A single try/finally around the whole
critical section does this cleanly:

```ts
// Pre-loop: reservation with early cap-rejection exit (reserveSmsCost
// auto-refunds on cap hit; no refund owed when we record failed delivery
// and continue).
let smsReservationDate: string | null = null;
if (channelId === 'sms') {
  try {
    smsReservationDate = await reserveSmsCost(business_id);
  } catch (err) {
    if (err instanceof DailySmsLimitExceededError) {
      logger.warn(`SMS cap reached for business ${business_id} (${err.scope}) — recording failed delivery`);
      await insertFailedDelivery(business_id, response_id, 'sms', enrollment.handle,
        `daily_sms_limit_exceeded:${err.scope}`);
      continue;
    }
    throw err;
  }
}

// Single try/finally wraps link creation, send, and delivery record.
// sendAccepted=true iff Twilio accepted the outbound message — that's the
// commit point for the cost reservation. Any failure before that (link
// creation, Twilio send, DB errors around the send) triggers refund.
let sendAccepted = false;
try {
  const { rawToken, approvalLinkId } = await createApprovalLink({
    responseId: response_id, businessId: business_id, channel: channelId,
  });
  const approvalUrl = `${appUrl}/approve/${rawToken}`;
  attempted++;

  let externalMessageId: string;
  try {
    const result = await getChannel(channelId).sendApprovalRequest({
      handle: enrollment.handle,
      businessName: business.name,
      reviewerName: responseRow.reviewer_name,
      starRating: responseRow.star_rating,
      reviewText: responseRow.review_text,
      reviewDate: responseRow.review_date,
      responsePreview: responseRow.response_text,
      approvalUrl,
      approvalLinkId,
    });
    externalMessageId = result.externalMessageId;
    sendAccepted = true;  // cost committed; finally will NOT refund
  } catch (err) {
    if (err instanceof SmsRecipientUnsubscribedError) {
      // Three writes in one transaction — all driven by Twilio's
      // authoritative 21610 signal:
      //   (a) sms_sender_opt_outs UPSERT — current sender-level state
      //       keyed by (messaging_service_sid, handle).
      //   (b) sms_sender_opt_out_events INSERT — append-only audit row
      //       (TCPA retention).
      //   (c) channel_enrollments UPDATE — per-business enrollment
      //       rows flipped to 'unsubscribed' so dispatcher skips them.
      const msid = process.env.TWILIO_MESSAGING_SERVICE_SID!;
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO sms_sender_opt_outs
            (messaging_service_sid, handle, opted_out_at, opted_in_at, last_event_at)
          VALUES (${msid}, ${enrollment.handle}, NOW(), NULL, NOW())
          ON CONFLICT (messaging_service_sid, handle) DO UPDATE
            SET opted_out_at = EXCLUDED.opted_out_at,
                opted_in_at = NULL,  -- reset any prior START clear
                last_event_at = EXCLUDED.last_event_at
        `;
        await tx`
          INSERT INTO sms_sender_opt_out_events
            (id, messaging_service_sid, handle, event_type, source, inbound_event_id)
          VALUES (${uuidv7()}, ${msid}, ${enrollment.handle}, '21610_at_send', 'twilio_21610', NULL)
        `;
        await tx`
          UPDATE channel_enrollments
          SET status = 'unsubscribed',
              unsubscribed_at = COALESCE(unsubscribed_at, NOW()),
              unsubscribed_reason = COALESCE(unsubscribed_reason, 'twilio_21610_at_send'),
              updated_at = NOW()
          WHERE handle = ${enrollment.handle}
            AND channel = 'sms'
            AND archived_at IS NULL
        `;
      });
    }
    const reason = err instanceof Error ? err.message : String(err);
    logger.error(`${channelId} send failed for response ${response_id}: ${reason}`);
    await insertFailedDelivery(business_id, response_id, channelId, enrollment.handle,
      err instanceof SmsRecipientUnsubscribedError
        ? 'twilio_21610_at_send'
        : `send_error:${reason}`);
    continue;  // finally runs before continue; refund triggers since sendAccepted=false
  }

  await recordNotificationDelivery({
    businessId: business_id,
    responseId: response_id,
    channel: channelId,
    recipient: enrollment.handle,
    template: 'approval_request',
    externalMessageId,
  });
  succeeded++;
  logger.log(`${channelId} approval notification sent for response ${response_id}`);
} finally {
  if (channelId === 'sms' && smsReservationDate && !sendAccepted) {
    await refundSmsCost(business_id, smsReservationDate);
  }
}
```

**Refund semantics:**
- `reserveSmsCost` cap rejection → internal auto-refund; no external action.
- `createApprovalLink` throws → finally refunds.
- `channel.sendApprovalRequest` throws (any reason) → finally refunds.
- Twilio ACK returned (`sendAccepted=true`) but `recordNotificationDelivery`
  throws → finally does NOT refund (cost was incurred). Missing delivery
  row is the same "post-send crash race" already accepted (§16).

`insertFailedDelivery` is a small helper added to
`src/lib/notifications/delivery.ts` (mirrors `recordNotificationDelivery`
but with `failed_at=NOW()` and no `external_message_id`). The existing
inline INSERT in `NotificationWorker.ts:166-173` refactors into this
helper as part of Phase 1 work.

### 9.3 Minor

- `business_id` is ALREADY in scope in the dispatcher loop (from the outer
  `job.data`). No change to `SendApprovalParams`/`NotificationChannel`
  interface is needed — the channel still receives only the fields it
  needs (`handle`, `reviewerName`, etc.).
- The existing failure-isolation, per-channel idempotency check, and
  `createApprovalLink({ channel })` calls already support `channel='sms'`
  from Phase 0.
- `getVerifiedEnrollments` also gets `AND archived_at IS NULL` added to
  its WHERE clause as part of §6's migration 022. Archived rows are
  invisible to the dispatcher.

## 10. Ingress — `worker/ingress/twilio.ts`

New file mirroring the structure of `worker/ingress/resend.ts` exactly:
signature verification → `inbound_events` insert with processing lease → type
dispatch → success/failure status update → HTTP reply.

### 10.1 Route registration

Two routes registered in `worker/index.ts` (both POST, both raw-body enabled
for signature verification):

- `POST /ingress/twilio/status` — delivery status callbacks (from our outbound
  sends via `statusCallback` URL on `messages.create`).
- `POST /ingress/twilio/inbound` — inbound SMS from customers (STOP/START,
  other).

Split paths (vs. one handler dispatching by body shape) because Twilio's webhook
dashboard lets you point each URL independently and the two event families have
disjoint concerns.

### 10.2 Signature verification + form-urlencoded parsing

Twilio webhooks are `application/x-www-form-urlencoded`. The worker's Fastify
setup currently registers `fastify-raw-body` only, not `@fastify/formbody` —
and because signature verification needs BOTH the exact raw body (to detect
tampering) AND a parsed params object (for `validateRequest`), the handler
parses the raw body manually:

```ts
const rawBody = (request as unknown as { rawBody?: string }).rawBody ?? '';
const params = Object.fromEntries(new URLSearchParams(rawBody).entries());
```

This keeps JSON parsing on other routes (Stripe, Resend) unchanged — no
global formbody plugin registration.

**URL for signature verification.** Twilio signs the exact URL it POSTed to,
including scheme and host. Railway terminates TLS upstream, so
`request.url` inside Fastify is just the path. Construct the signed URL as:

```ts
const fullUrl = `${process.env.WORKER_PUBLIC_URL}${request.url}`;
```

`WORKER_PUBLIC_URL` is a new required env var (§12) — its value must
match exactly the URL configured in the Twilio console (scheme, host, no
trailing slash). A mismatch here is the most common
signature-verification bug.

**Startup assertion** in `worker/index.ts` refuses to boot when
`CHANNELS_SMS_ENABLED=true` unless ALL of the following env vars are
set and non-empty:
- `WORKER_PUBLIC_URL`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_MESSAGING_SERVICE_SID`
- `TWILIO_VERIFY_SERVICE_SID`

Missing any one → log the list of missing vars and `process.exit(1)`. A
partial Twilio config (e.g., SID set but token missing) would otherwise
fail only during the first enrollment or send — a far worse debugging
experience than a boot-time failure. The Next.js admin routes perform
the same check on startup and refuse to serve `/api/admin/channels/sms/*`
until all five vars are present (returning 503 rather than crashing
unrelated admin surfaces).

`MOCK_EXTERNAL_APIS=true` bypasses the assertion entirely (local dev
sanity).

**Validation:** Use Twilio's official
`twilio.validateRequest(authToken, signatureHeader, fullUrl, params)` helper.
Header: `X-Twilio-Signature`. In `MOCK_EXTERNAL_APIS=true` and no
`TWILIO_AUTH_TOKEN`, fail-open with warning log — matches Resend pattern.

### 10.3 Dedup

Use the existing `inbound_events` table with `source='twilio'`,
`external_event_key`:
- Status callback events: `MessageSid + ':' + MessageStatus` (same SID can
  fire multiple status callbacks: `sent`, `delivered`, etc. — each status is
  its own dedup key).
- Inbound SMS: `MessageSid` (each inbound message has a unique SID).

Status lease pattern (`received → processed` with 2-minute stale reclaim)
matches `worker/ingress/resend.ts:202-234` exactly. Reuse that shape.

### 10.4 Status callback handler — scoped updates, terminal precedence, retry-safe race handling

Twilio posts form-encoded params: `MessageSid`, `MessageStatus`, `ErrorCode`
(only on errors).

**Invariants:**
- First terminal callback wins. Once `delivered_at` or `failed_at` is set,
  later callbacks are no-ops (handles out-of-order Twilio retries).
- Intermediate statuses (`queued`, `sending`, `sent`) are no-ops regardless
  of whether the delivery row exists yet. They never trigger 503/retry.
- A terminal-status callback arriving BEFORE the dispatcher's delivery-row
  INSERT (rare but possible) marks the inbound_event as `failed` and
  returns 503. Marking `failed` is critical — the `inbound_events` dedup
  lease reclaim logic only picks up rows with `status IN ('failed', 'received-but-stale')`.
  Leaving the row as `received` after a 503 would cause Twilio's retry to
  be acknowledged as "in_flight" by our dedup check and never actually
  processed.

Handler logic:

```ts
// After signature verify + inbound_events lease claim (status='received').
const isTerminal = ['delivered', 'undelivered', 'failed'].includes(MessageStatus);

if (!isTerminal) {
  // Intermediate (queued/sending/sent) or unknown-future status.
  // No DB change. Just close the lease and ack.
  if (!['queued', 'sending', 'sent'].includes(MessageStatus)) {
    logger.log(`Unknown Twilio MessageStatus ${MessageStatus} for SID ${MessageSid}`);
  }
  await sql`UPDATE inbound_events SET status='processed', processed_at=NOW() WHERE external_event_key=${dedupKey}`;
  reply.status(200).send({ received: true });
  return;
}

// Terminal status. We need the delivery row.
const [row] = await sql<{ id: string; delivered_at: Date | null; failed_at: Date | null }[]>`
  SELECT id, delivered_at, failed_at FROM notification_deliveries
  WHERE external_message_id = ${MessageSid} AND channel = 'sms'
  LIMIT 1
`;

if (!row) {
  // Delivery row not yet inserted by dispatcher. Mark this inbound_event
  // FAILED so Twilio's retry reclaims it via the 'failed' branch in the
  // dedup lease logic (see worker/ingress/resend.ts:211-219 pattern).
  // Without this mark, a retry would land on status='received' and be
  // silently acknowledged as in_flight, permanently swallowing the event.
  await sql`
    UPDATE inbound_events
    SET status='failed', error_message='delivery_row_not_yet_present'
    WHERE external_event_key=${dedupKey}
  `;
  reply.status(503).send({ received: true, retry: 'delivery_row_not_yet_present' });
  return;
}

if (row.delivered_at || row.failed_at) {
  // Terminal state already set. First-wins; acknowledge silently.
  await sql`UPDATE inbound_events SET status='processed', processed_at=NOW() WHERE external_event_key=${dedupKey}`;
  reply.status(200).send({ received: true, terminal_state_preserved: true });
  return;
}

// UPDATE with inline race guard — if two callbacks fire simultaneously,
// only the first to match the IS NULL filter actually flips the state.
if (MessageStatus === 'delivered') {
  await sql`
    UPDATE notification_deliveries SET delivered_at = NOW()
    WHERE id = ${row.id} AND channel = 'sms'
      AND delivered_at IS NULL AND failed_at IS NULL
  `;
} else {
  // 'undelivered' or 'failed'
  await sql`
    UPDATE notification_deliveries
    SET failed_at = NOW(), failure_reason = ${`twilio:${ErrorCode ?? 'unknown'}`}
    WHERE id = ${row.id} AND channel = 'sms'
      AND delivered_at IS NULL AND failed_at IS NULL
  `;
}

await sql`UPDATE inbound_events SET status='processed', processed_at=NOW() WHERE external_event_key=${dedupKey}`;
reply.status(200).send({ received: true });
```

**Why 503 only for terminal + missing-row:** intermediate statuses don't
need the delivery row — they're ignored anyway — so retrying them on the
tiny race window is wasted roundtrips. Only the terminal callbacks carry
information we can't reconstruct otherwise.

**Why mark `inbound_events` as `failed` before 503:** the dedup reclaim
CTE in the Resend pattern (`resend.ts:211-219`) only reclaims rows where
`status='failed' OR (status='received' AND received_at < NOW() - INTERVAL '2 minutes')`.
A row left at `status='received'` with a fresh `received_at` is treated as
"another worker is actively processing" and silently acknowledged. The
`failed` mark is what tells the dedup logic "this event needs retrying."

### 10.5 Inbound handler

Twilio posts: `From` (sender E.164), `To` (our sender number), `Body` (message
text), `MessageSid`. Twilio has already processed any Twilio-recognized STOP
keyword BEFORE this webhook fires — their auto-reply and opt-out list update are
done. We just record the state.

Logic (all success paths end by transitioning `inbound_events` to
`status='processed'` and replying 200, matching the Resend pattern):

```
1. inbound_events dedup lease (as §10.3). On true duplicate, reply 200 silently.

2. Classify the event. Twilio includes an OptOutType field on the webhook
   payload when its Advanced Opt-Out feature triggered (per Twilio's
   opt-out docs). Possible values:
     - 'STOP' → owner texted an opt-out keyword recognized by Twilio
     - 'START' (a.k.a. 'UNSTOP') → owner cleared their opt-out
     - 'HELP' → owner asked for help; no state change needed
   When OptOutType is present, trust it. Otherwise fall back to keyword
   matching on Body as belt-and-suspenders.

3. Resolve intent:
   a. If OptOutType == 'STOP' → intent=stop.
   b. Else if OptOutType == 'START' (or 'UNSTOP') → intent=start.
   c. Else parse Body: trim, uppercase, strip leading/trailing
      punctuation, split on whitespace, take first token.
      - intent=stop if token ∈ {STOP, STOPALL, UNSUBSCRIBE, CANCEL,
        END, QUIT, REVOKE, OPTOUT,                             -- EN superset incl. reviewer-flagged additions
        PARE, PARAR, PARARLO, CANCELAR, DESUSCRIBIR, DETENER}  -- ES
      - intent=start if token ∈ {START, UNSTOP, YES, ARRANCAR}
      - else intent=none.

4. If intent == 'stop':
   Twilio's Messaging Service opt-out list is sender-scoped — the same
   phone enrolled across multiple businesses is blocked for ALL of them
   at Twilio's layer. Webhook payload includes `MessagingServiceSid` (use
   that; falls back to `process.env.TWILIO_MESSAGING_SERVICE_SID` if
   missing, though it should always be present). Three writes in a
   single transaction (atomicity is critical — partial commit would
   diverge /verify's gate from dispatcher's enrollment filter):

     sql.begin:
       -- a. Sender-level current state (authoritative for /verify gate).
       INSERT INTO sms_sender_opt_outs
         (messaging_service_sid, handle, opted_out_at, opted_in_at, last_event_at)
       VALUES (<MessagingServiceSid>, <From>, NOW(), NULL, NOW())
       ON CONFLICT (messaging_service_sid, handle) DO UPDATE
         SET opted_out_at = EXCLUDED.opted_out_at,   -- latest STOP timestamp
             opted_in_at = NULL,                      -- reset any prior START
             last_event_at = EXCLUDED.last_event_at

       -- b. Append-only audit event (TCPA retention).
       INSERT INTO sms_sender_opt_out_events
         (id, messaging_service_sid, handle, event_type, source, inbound_event_id)
       VALUES (<uuidv7>, <MessagingServiceSid>, <From>, 'stop',
               <'twilio_inbound_keyword' | 'twilio_optouttype'>, <inbound_events.id>)

       -- c. Per-business enrollment rows.
       UPDATE channel_enrollments
       SET status = 'unsubscribed',
           unsubscribed_at = COALESCE(unsubscribed_at, NOW()),
           unsubscribed_reason = COALESCE(unsubscribed_reason, 'sms_stop'),
           updated_at = NOW()
       WHERE handle = <From> AND channel = 'sms' AND archived_at IS NULL
       -- NOTE: no `status <> 'unsubscribed'` guard. If a row is already
       -- unsubscribed and the owner STOPs again, updated_at ticks and
       -- the sms_sender_opt_outs UPSERT above resets opted_in_at=NULL.

5. If intent == 'start':
   Record that Twilio cleared its Messaging Service opt-out list for
   this sender (or that the owner proactively signalled intent-to-receive
   even without a prior STOP). /verify's gate consults current state on
   re-enrollment; the audit log preserves the full signal history. Two
   writes in one transaction:

     sql.begin:
       -- a. Update current state. If no prior STOP row exists, this
       --    UPDATE affects zero rows — no current-state change, because
       --    the invariant is "sms_sender_opt_outs row exists iff we've
       --    observed a STOP at some point." Do NOT INSERT a row with
       --    opted_out_at=NULL.
       UPDATE sms_sender_opt_outs
       SET opted_in_at = NOW(), last_event_at = NOW()
       WHERE messaging_service_sid = <MessagingServiceSid>
         AND handle = <From>
         AND opted_out_at IS NOT NULL

       -- b. Append-only audit event — written UNCONDITIONALLY, even if
       --    step (a) affected zero rows. A spontaneous START (no prior
       --    STOP) is still TCPA-relevant intent-to-receive signal; we
       --    preserve it in the audit log. Future compliance queries can
       --    see every inbound START event regardless of whether it
       --    changed current state.
       INSERT INTO sms_sender_opt_out_events
         (id, messaging_service_sid, handle, event_type, source, inbound_event_id)
       VALUES (<uuidv7>, <MessagingServiceSid>, <From>, 'start',
               <'twilio_inbound_keyword' | 'twilio_optouttype'>, <inbound_events.id>)

   No change to channel_enrollments — admin must trigger fresh
   verification to transition a row back to 'verified'.

6. If no active channel_enrollments row matches handle=<From> AND
   channel='sms': log (wrong-number, archived row, new sender's opt-out
   event recorded). Note we still updated sms_sender_opt_outs in step 4a
   even if no active enrollment exists — opt-out state must be persisted
   regardless (it applies to future re-enrollments too).

7. Otherwise (intent=none): log + no state change. Notification-only
   channel; we don't run conversations.

8. In ALL success paths (4, 5, 6, 7): UPDATE inbound_events SET
   status='processed' and reply 200. DB write failures transition to
   status='failed' with 5xx reply so Twilio retries (reclaimable via the
   same dedup-lease logic described in §10.4).
```

Keyword list is a superset of Twilio's built-in set in EN + ES — we still match
these even though Twilio already acted, because (a) our DB flag is authoritative
for the dispatcher, (b) some keyword variants (e.g., regional spellings) might
not trigger Twilio's auto-opt-out but should still disable sends on our side.

### 10.6 `inbound_events` payload redaction

Raw `Body` field may contain PII. Redact the `Body` field to `'[redacted]'`
before persisting `inbound_events.payload`, keeping metadata (`From`, `To`,
`MessageSid`, `MessageStatus`, `ErrorCode`) intact. Matches the parent spec's
§3.2.1 defense-in-depth pattern even though SMS bodies don't carry secrets —
consistency helps future reviewers.

## 11. Cost guard

File: `src/lib/costs/sms-tracker.ts` (new, disjoint from `tracker.ts`)

```ts
import { getCacheRedis } from '@/lib/db/redis-cache';

// TFN: ~$0.0079/msg → round up to 1 cent. Refine to 1 cent (unchanged) for
// 10DLC at ~$0.0089/msg + carrier fee.
const SMS_SEND_COST_CENTS = 1;
const TTL_SECONDS = 86_400;

export class DailySmsLimitExceededError extends Error {
  constructor(public readonly scope: 'per_business' | 'global') { super(`sms_cap:${scope}`); }
}

function todayDateStr(): string { return new Date().toISOString().slice(0, 10); }
function perBizKey(bId: string, d: string): string { return `cost:sms:${bId}:${d}`; }
function globalKey(d: string): string { return `cost:sms:global:${d}`; }

/**
 * Reserves pessimistic SMS cost against daily budgets. Returns the reservation
 * date string — callers MUST pass this same date back to refundSmsCost() to
 * avoid wrong-key refunds across UTC midnight. Matches the pattern in
 * src/lib/costs/tracker.ts (reserveCost → finalizeCost/releaseCost).
 */
export async function reserveSmsCost(businessId: string): Promise<string> {
  const redis = getCacheRedis();
  const date = todayDateStr();
  const bKey = perBizKey(businessId, date);
  const gKey = globalKey(date);

  const [[, bizTotal], [, globalTotal]] = await redis.pipeline()
    .incrby(bKey, SMS_SEND_COST_CENTS)
    .incrby(gKey, SMS_SEND_COST_CENTS)
    .exec() as [[null, number], [null, number]];

  const perBizCap = parseCentsEnv('SMS_DAILY_LIMIT_CENTS_PER_BUSINESS', 10);
  const globalCap = parseCentsEnv('SMS_DAILY_LIMIT_CENTS_GLOBAL', 500);

  if (bizTotal > perBizCap || globalTotal > globalCap) {
    await redis.pipeline().decrby(bKey, SMS_SEND_COST_CENTS).decrby(gKey, SMS_SEND_COST_CENTS).exec();
    throw new DailySmsLimitExceededError(bizTotal > perBizCap ? 'per_business' : 'global');
  }

  await redis.pipeline().expire(bKey, TTL_SECONDS).expire(gKey, TTL_SECONDS).exec();
  return date;
}

export async function refundSmsCost(businessId: string, reservationDate: string): Promise<void> {
  const redis = getCacheRedis();
  await redis.pipeline()
    .decrby(perBizKey(businessId, reservationDate), SMS_SEND_COST_CENTS)
    .decrby(globalKey(reservationDate), SMS_SEND_COST_CENTS)
    .exec();
}
```

Reuse `safeParseLimitCents`-style strict parser from `tracker.ts` for env var
parsing (copy or extract to a shared helper).

No `api_costs` audit trail entry per send — Twilio delivery receipts are the
authoritative cost log, and reconciliation via `notification_deliveries.external_message_id`
is available if needed.

## 12. Environment variables

Add to `.env.example`:

```bash
# --- SMS channel (Phase 1) ---
# Master flag. When false (default), SMS widget is hidden, API routes 404,
# dispatcher skips sms enrollments, factory throws on getChannel('sms').
CHANNELS_SMS_ENABLED=false

# Twilio credentials (from console.twilio.com)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# Messaging Service SID (NOT a raw phone number) — holds both toll-free interim
# sender and 10DLC long code. Twilio routes sends through the highest-priority
# sender in the service.
TWILIO_MESSAGING_SERVICE_SID=MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# Verify service SID — separate from Messaging Service, owns one-time codes.
TWILIO_VERIFY_SERVICE_SID=VAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# SMS cost ceilings (per calendar day, cents)
SMS_DAILY_LIMIT_CENTS_PER_BUSINESS=10
SMS_DAILY_LIMIT_CENTS_GLOBAL=500

# Worker public URL — used as statusCallback base for outbound SMS and Verify webhooks.
# Must be HTTPS. Example: https://worker.repworth.net
WORKER_PUBLIC_URL=https://worker.repworth.net
```

## 13. Files changed / created

### New

```
supabase/migrations/022_sms_channel_infra.sql
src/lib/notifications/channels/sms-channel.ts
src/lib/notifications/channels/__tests__/sms-channel.test.ts
src/lib/notifications/sms-body.ts
src/lib/notifications/__tests__/sms-body.test.ts
src/lib/costs/sms-tracker.ts
src/lib/costs/__tests__/sms-tracker.test.ts
worker/ingress/twilio.ts
worker/ingress/__tests__/twilio.test.ts
src/app/api/admin/channels/sms/verify/route.ts
src/app/api/admin/channels/sms/confirm/route.ts
src/app/api/admin/channels/sms/cancel/route.ts
src/app/api/admin/channels/sms/disable/route.ts
src/app/api/admin/channels/sms/delete/route.ts
src/app/api/admin/channels/sms/status/route.ts   (GET — widget polls this during awaiting_sender_opt_in; returns enrollment row shape)
src/app/api/admin/channels/sms/__tests__/routes.test.ts
src/components/admin/ChannelsSection.tsx        (SERVER component — reads CHANNELS_SMS_ENABLED + business.subscription_status; OWNS locked pending-payment render inline; only mounts client widget when flag on AND active)
src/components/admin/SmsEnrollmentWidget.tsx    (CLIENT component — accepts business_id only; handles empty/sent/verified/disabled/unsubscribed/awaiting_sender_opt_in/opt_in_received states)
```

### Modified

```
src/lib/notifications/channels/index.ts           (wire SmsChannel + flag gate)
worker/jobs/NotificationWorker.ts                 (flag check + SMS cost reserve/refund with reservationDate + sender-wide unsub flip + sms_sender_opt_outs UPSERT on 21610)
worker/index.ts                                   (register /ingress/twilio/* routes + startup assertion: CHANNELS_SMS_ENABLED=true requires all of WORKER_PUBLIC_URL, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_MESSAGING_SERVICE_SID, TWILIO_VERIFY_SERVICE_SID)
src/lib/notifications/delivery.ts                 (extract insertFailedDelivery helper from inline NotificationWorker INSERT)
src/lib/notifications/enrollments.ts              (getVerifiedEnrollments: add AND archived_at IS NULL to filter)
src/app/api/admin/businesses/route.ts             (Phase 0 upsert: change ON CONFLICT (business_id, channel) → ON CONFLICT (business_id, channel) WHERE archived_at IS NULL — required by migration 022's partial unique index)
src/app/api/admin/businesses/[id]/route.ts        (Phase 0 owner_email edit upsert: same ON CONFLICT predicate addition)
src/app/api/admin/businesses/[id]/channels/route.ts  (Phase 0 admin read: add AND e.archived_at IS NULL to SELECT so soft-deleted SMS rows don't show in the Channels section; update existing tests)
src/app/admin/businesses/[id]/page.tsx            (refactor to render server ChannelsSection; widget NOT added to /new)
.env.example                                      (§12 — includes WORKER_PUBLIC_URL)
package.json                                      (add twilio, libphonenumber-js, @sindresorhus/transliterate)
.claude/CLAUDE.md                                 (status update, env var notes, migration counter bump to 023, lab notes if any land)
```

**NOT modified:** `src/app/admin/businesses/new/page.tsx`. Per §8.1 the widget
cannot function there — no `business_id` exists until after POST. Enrollment
happens on the detail page only.

## 14. Testing strategy

### 14.1 Unit tests (Vitest)

Test scope matches the §5/§9 boundary: channel tests cover Twilio send/error
mapping only; cost-guard, enrollment updates, and failed-delivery recording
are dispatcher-level concerns and live in `NotificationWorker` tests.

- `sms-body.test.ts`: formatter invariants (≤160 GSM-7 chars), two-tier
  fallback selected by **actual formatted name length** (not a
  budget-threshold heuristic): tier 1 with reviewer name renders when the
  full body fits; tier 2 no-reviewer fallback when tier 1 overflows;
  **SmsBodyTooLongError** thrown when tier 2 also overflows. Boundary
  tests: tier 1 at exactly 160 renders, at 161 falls to tier 2; tier 2 at
  exactly 160 renders, at 161 throws. Fixture set: accented names, CJK
  names (via transliterate), long names, empty names (→ tier 1 with "a
  reviewer"), realistic URLs (69 chars), long URLs (→ tier 2),
  pathological URLs (→ throw), all 5 star ratings. Assert no UCS-2
  characters in any produced output.
- `sms-tracker.test.ts`: reserve returns date; refund round-trip with same
  date; per-business cap rejection; global cap rejection; TTL set correctly;
  concurrent-reserve race behavior (either rejection is fine, but no
  over-count); explicit midnight-boundary test (mock `todayDateStr` to
  simulate UTC roll, verify refund hits the original day's key).
- `sms-channel.test.ts`: mocked Twilio SDK ONLY. Successful send returns
  SID. 21610 error maps to `SmsRecipientUnsubscribedError` (no DB writes in
  this test — channel doesn't touch the DB). Other Twilio errors re-throw
  untouched. No cost-guard, no enrollment-update assertions here.
- `NotificationWorker.test.ts` (extended): cost reservation before link
  creation; `DailySmsLimitExceededError` path records failed delivery with
  scoped reason and does NOT call Twilio; **`createApprovalLink` failure
  between reserve and send triggers refund via the outer try/finally** (no
  Redis budget leak); `SmsRecipientUnsubscribedError` from channel UPSERTs
  `sms_sender_opt_outs (opted_out_at=NOW, opted_in_at=NULL)` AND flips all
  active `channel_enrollments` rows with matching handle to 'unsubscribed'
  (sender-wide); flag-off path skips SMS enrollments entirely; refund
  happens on non-ACK channel errors; refund does NOT happen after
  successful Twilio ACK even if `recordNotificationDelivery` throws;
  archived enrollment rows are not picked up by `getVerifiedEnrollments`.
- `admin/channels/sms/*.test.ts`: verify + confirm + cancel + disable +
  delete + status routes; E.164 validation; 404 when flag off; 403 when
  `subscription_status != 'active'`; 400 `handle_change_forbidden` when
  submitted phone differs from existing row's handle (covers disabled and
  unsubscribed states); **400 `sender_opt_in_required` when
  `sms_sender_opt_outs` has `opted_out_at IS NOT NULL AND opted_in_at IS
  NULL` for the submitted phone** — applies to brand-new enrollments,
  disabled re-enables, unsubscribed re-enables, AND post-delete fresh
  enrollments (blocks the archive/re-enroll bypass); 400 `already_verified`
  on verified row; **Twilio Verify failure leaves row unchanged (500
  response, no pending_verification transition)**; **concurrency: two
  simultaneous /verify calls from empty state → advisory lock serializes,
  only one INSERT succeeds, the other returns a clean error (not a race
  violation)**; cancel reverts to prior terminal state
  (verified/disabled/unsubscribed) or deletes if brand-new; **delete
  soft-deletes (archived_at set) and preserves prior timestamps**;
  re-enrollment after soft-delete succeeds ONLY IF sender is no longer
  opted out (partial unique index alone doesn't bypass the gate);
  delete requires `confirm: true` (400 otherwise); confirm clears
  `unsubscribed_at`, `unsubscribed_reason` on success and does NOT touch
  `sms_sender_opt_outs` (audit preserved); verify does NOT clear any
  terminal timestamp.
- `admin/channels/sms/__tests__/onconflict.test.ts` (NEW): integration
  test hitting the Phase 0 email upsert sites (`/api/admin/businesses`
  POST and `/api/admin/businesses/[id]` PATCH owner_email) to verify the
  updated `ON CONFLICT (business_id, channel) WHERE archived_at IS NULL`
  target works against the partial unique index post-migration. A
  regression of dropping the `WHERE` predicate would crash business
  creation in production.
- **/confirm re-check of sender gate.** Test: /verify succeeds (fresh
  enrollment, no prior opt-out) → INSERT pending row → inject a STOP
  webhook event (UPSERT sms_sender_opt_outs with opted_out_at=NOW,
  opted_in_at=NULL) → /confirm with valid OTP returns 409
  `sender_opted_out_during_verification`; channel_enrollments row stays
  in pending_verification (not flipped to verified).
- **messaging_service_sid scoping.** /verify gate + /status derived
  boolean correctly scope queries by the current TWILIO_MESSAGING_SERVICE_SID.
  Fixture: row exists in sms_sender_opt_outs for a DIFFERENT MS SID with
  the same handle — /verify must NOT block (opt-out applies only to the
  other sender). Future multi-MS validity.
- **sms_sender_opt_out_events audit trail.** STOP → START → STOP →
  START sequence produces 4 rows in the audit table in order; the
  `sms_sender_opt_outs` row has only the latest state; deleting 30+
  day-old `inbound_events` rows does not cascade to the audit
  (ON DELETE SET NULL on the FK).
- **RLS posture.** Direct SELECT on both new tables via anon key returns
  empty (no policies defined). Service-role queries work normally.

### 14.2 Integration tests (Vitest + real Supabase)

- `worker/ingress/twilio.test.ts`: good signature + known-good fixtures for
  each event type → correct DB effects; bad signature → 401; replay (same
  `MessageSid:MessageStatus`) → dedup. STOP inbound →
  `sms_sender_opt_outs` UPSERT (opted_out_at=NOW, opted_in_at=NULL) AND
  all active matching `channel_enrollments` rows flipped to
  'unsubscribed' (sender-wide fan-out across businesses); idempotent
  under retry; archived rows untouched by STOP/START; **STOP on an
  already-unsubscribed handle that had a prior START observed (opted_in_at
  set) must reset `opted_in_at=NULL`** — this is Critical 2 from the
  round-5 review; without it a subsequent /verify would incorrectly pass
  the sender-opt-in gate. START inbound → UPDATE
  `sms_sender_opt_outs.opted_in_at=NOW` on matching row (only if row
  exists from prior STOP; START without prior STOP is a no-op); NO change
  to `channel_enrollments` (admin must run /verify to complete
  re-enrollment). **Twilio OptOutType header preferred over keyword
  matching when present.** EN keyword set includes REVOKE + OPTOUT; ES
  keyword set covers Twilio-native set.
- **Status-callback race coverage:** terminal-status callback arrives
  before dispatcher-INSERT → inbound_event marked `failed`, 503 returned,
  retry reclaims via dedup-lease `failed` branch; intermediate status
  callback (queued/sent) with no delivery row → 200 no-op, NO 503;
  callback arrives after row already has `delivered_at` → 200 no-op,
  inbound_event marked processed; out-of-order callbacks (`failed`
  arriving after `delivered`) → first terminal wins, second is no-op.
- NotificationWorker with SMS enrollment + flag off → SMS enrollment
  skipped (dispatcher's defense-in-depth), email still sent.
- NotificationWorker with SMS enrollment + flag on + mocked Twilio → SMS
  delivery recorded; subscription_status='pending_payment' → SMS skipped
  (existing subscription guard).
- Cap rejection in dispatcher → `notification_deliveries` row with
  `failure_reason='daily_sms_limit_exceeded:<scope>'`, no Twilio call
  made, Redis counter correctly decremented back (no drift).
- **Re-enable-after-STOP end-to-end.** Simulated lifecycle: enroll+verify
  → inbound STOP webhook (sms_sender_opt_outs row created with
  opted_out_at, opted_in_at=NULL) → admin attempts /verify (expect 400
  `sender_opt_in_required`) → inbound START webhook (opted_in_at set) →
  admin /verify succeeds → admin /confirm with OTP → status back to
  verified; `unsubscribed_*` cleared on confirm;
  `sms_sender_opt_outs` row untouched on confirm (audit preserved).
- **Archive-then-reenroll cannot bypass the opt-out gate.** Simulated:
  enroll+verify → STOP → /delete (soft-delete) → admin attempts /verify
  with the SAME phone for the SAME business → 400 `sender_opt_in_required`
  (confirms Critical 3 mitigation — the `sms_sender_opt_outs` table
  survives enrollment archival).

### 14.3 Manual end-to-end (ship gate)

§15 below. Not automated — real-phone SMS automation is brittle and
low-value.

## 15. Ship gate (manual end-to-end)

Gate criteria — all must pass on one test business using a real phone:

1. **Enrollment.** Admin enters phone in widget → clicks Send code → phone
   receives 6-digit code within 30s → admin enters code → widget shows ✅ →
   `channel_enrollments` row has `status='verified'`.
2. **Approval notification.** Test business has a new review (manually inject
   via existing admin flow or wait for SerpAPI sync) → after generation, phone
   receives 1-segment SMS with working approval URL.
3. **SMS content check.** Body matches template, fits in 1 segment (verify via
   Twilio console — "Num Segments: 1"), `Reply STOP to unsubscribe.` suffix
   present, reviewer name correctly formatted.
4. **Approval round-trip.** Tap URL → web approval page loads → approve →
   response transitions to `awaiting_manual_post` → existing manual post flow
   unchanged.
5. **Delivery webhook.** Twilio status callback fires → `notification_deliveries.delivered_at`
   populated within 60s of send.
6. **STOP flow.** Reply `STOP` from phone → Twilio auto-reply received →
   our webhook fires → `sms_sender_opt_outs` UPSERTed
   (opted_out_at=NOW, opted_in_at=NULL) AND `channel_enrollments.status`
   → 'unsubscribed' → next approval notification does NOT send SMS
   (email still sent) → admin UI shows 🚫.
7. **Re-enable gate (sender opt-in required).** Admin clicks "Start re-enable"
   on unsubscribed row → widget enters `awaiting_sender_opt_in` → admin
   attempts /verify API directly (skipping the wait) and receives 400
   `sender_opt_in_required` (confirms the gate works).
8. **Re-enable flow.** Reply `START` from phone → Twilio clears its
   Messaging Service opt-out list + our webhook fires →
   `sms_sender_opt_outs.opted_in_at=NOW()` set → widget advances to
   `opt_in_received` → admin clicks Send verification code → OTP arrives
   → admin enters code → status flips to verified, `unsubscribed_*`
   cleared, `sms_sender_opt_outs` preserved for audit → next
   notification sends SMS again (no 21610).
9. **STOP → START → STOP resets the gate.** Reply `STOP` again → another
   /verify attempt returns 400 `sender_opt_in_required` (verifies
   Critical 2 mitigation — second STOP nulls `opted_in_at` regardless of
   prior row state).
10. **Archive-re-enroll cannot bypass the gate.** In the STOP'd state
    from step 6, admin clicks Delete (soft-delete) → admin immediately
    attempts to enroll the same phone for the same business → 400
    `sender_opt_in_required` (verifies Critical 3 mitigation).
11. **Delete + fresh re-enrollment with different phone.** Admin clicks
    Delete on verified row → confirmation modal → row soft-deleted
    (`archived_at` set) → widget returns to empty → admin enrolls a
    DIFFERENT phone number (not previously STOP'd) → verify/confirm →
    SMS arrives at new phone. Audit query confirms archived row is still
    retrievable with all timestamps intact.
12. **/confirm re-check catches mid-flow STOP.** Start a fresh
    verification (brand-new phone). After receiving the OTP but BEFORE
    entering it, reply STOP from the test phone. Then attempt /confirm
    with the OTP → 409 `sender_opted_out_during_verification`. Row
    stays out of verified state. (Exercises Medium 1 mitigation.)
13. **Audit events preserved beyond 30-day archival.** Run a STOP →
    START → STOP sequence on the test phone over 2–3 minutes. Query
    `SELECT * FROM sms_sender_opt_out_events WHERE handle=...
    ORDER BY created_at` — three rows (`stop`, `start`, `stop`) in
    order. Confirms TCPA audit trail is independent of
    `inbound_events` archival.
14. **Flag-off safety.** Flip `CHANNELS_SMS_ENABLED=false` → admin
    widget hidden by ChannelsSection (server-side) → factory throws if
    somehow invoked → dispatcher skips SMS enrollment → existing SMS
    enrollment row remains but is inert.

## 16. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 10DLC registration latency blocks prod launch | High | Medium | Messaging Service holds toll-free as primary sender; 10DLC added when ready with zero code change. Ship gate testable on trial immediately. |
| Twilio signature verify false-rejects legitimate webhook | Low | High | Use official `twilio.validateRequest` — tested; explicit `MOCK_EXTERNAL_APIS` fail-open for dev. |
| Webhook lost → enrollment shows "subscribed" while Twilio has auto-blocked | Low | Low | Send-time 21610 error catches (§5) → flips `unsubscribed_at` on next send attempt. Self-healing. |
| Post-send crash race (same as Phase 0 email) | Medium | Low | Accepted as-is — matches shipped email behavior. Failover poller + 24h dedup cover the symmetric lost-delivery case. |
| Reviewer name causes > 1 segment | Medium | Low | Unit test asserts `.length ≤ 160` for fixture set; runtime check before send throws if formatter invariant violated. Defense-in-depth. |
| SMS cap rejection blocks legitimate notification | Low | Low | Default caps are generous (~12 sends/biz/day vs. ~6 expected). Failover poller's stale-branch admin alert still runs — sales partner sees stuck response regardless of cap. |
| Inbound webhook body contains PII logged to `inbound_events.payload` | Low | Medium | Redact `Body` field to `[redacted]` before persisting — §10.6. |
| Admin accidentally enrolls owner with no consent | Low | High | TCPA consent is verbal during sales call; the Verify code loop ensures owner has physical possession of the phone. Admin UI shows explicit "By sending, confirm owner has consented to SMS notifications" warning next to Send button. |
| Twilio cost drift after 10DLC switchover | Low | Low | `SMS_SEND_COST_CENTS=1` rounds up both TFN ($0.0079) and 10DLC ($0.0089+fee); cap math remains conservative. Revisit if adding international. |
| Migration 022 replaces UNIQUE constraint with partial index — Phase 0 upserts break if not coordinated | Medium | **Critical** | Migration 022 PR MUST also update `src/app/api/admin/businesses/route.ts:240` and `src/app/api/admin/businesses/[id]/route.ts:333` to use `ON CONFLICT (business_id, channel) WHERE archived_at IS NULL DO UPDATE`. Integration test `admin/channels/sms/__tests__/onconflict.test.ts` exercises both upsert sites post-migration; CI blocks merge if they regress. Ship gate step 1 (business creation) validates in production. |
| Concurrent admin /verify racing two Twilio OTPs | Low | Low | Per-(business_id,'sms') advisory lock wraps load → Twilio → mutate. Matches the `createApprovalLink` pattern shipped in `d01d729`. Lock held across Twilio call (~1s); admin volume trivial. |
| Archive/re-enroll bypasses sender-level opt-out | Eliminated | N/A | `sms_sender_opt_outs` table is keyed by `(messaging_service_sid, handle)` and survives all `channel_enrollments` lifecycle transitions. /verify's sender-opt-in gate consults it unconditionally (scoped to the current `TWILIO_MESSAGING_SERVICE_SID`). Covered by ship gate step 10 and integration test. |
| STOP → START → STOP sequence incorrectly keeps opt-in clear | Eliminated | N/A | STOP handler's `sms_sender_opt_outs` UPSERT unconditionally sets `opted_in_at=NULL` regardless of prior row state. Ship gate step 9 + unit test verify. |
| Status callback arrives before dispatcher INSERT | Low | Low | Handler marks `inbound_events.status='failed'` BEFORE 503, so dedup-lease reclaim picks it up on Twilio's retry. Only terminal statuses trigger 503 (intermediates are no-ops regardless of delivery row presence). |
| `sms_sender_opt_outs` only carries current state; repeated STOP/START cycles lose history to `inbound_events` 30-day archival | Low | Medium | Append-only `sms_sender_opt_out_events` table (§6) writes every STOP/START/21610 in the same transaction as the state UPSERT. Never archived — TCPA retention indefinite. FK `ON DELETE SET NULL` against `inbound_events.id` lets archival run without losing audit rows. |
| New tables skip RLS by default (Supabase ships tables WITHOUT RLS until explicitly enabled) | Low | Medium | Migration 022 explicitly `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` on both `sms_sender_opt_outs` and `sms_sender_opt_out_events`. No policies defined → only service_role can read. Matches Phase 0 `channel_enrollments` posture. |
| Mid-verification STOP race — /verify passes gate, owner texts STOP before OTP entry | Low | Medium | /confirm re-checks `sms_sender_opt_outs` inside its transaction; 409 if opted out. Widget reverts to `awaiting_sender_opt_in`. Ship gate step 12 verifies. |
| Future multi-Messaging-Service setup collides with single-handle keying | Eliminated | N/A | All tables + queries key by `(messaging_service_sid, handle)` from day 1. A second MS (staging/prod split, sender migration) gets its own independent opt-out list with no data migration. |

## 17. Rollout sequence

**Rollout is gated by enrollment actions, not by a per-business flag.** The
global `CHANNELS_SMS_ENABLED=true` alone does nothing — only businesses that
have a `status='verified'` SMS row in `channel_enrollments` receive SMS.
Since the admin widget is the only way to create such rows, controlling who
gets SMS is equivalent to controlling which business detail pages an admin
has run enrollment on. There is no separate allowlist/kill-switch
infrastructure in Phase 1.

Staged rollout in practice:

1. **Day 0 (parallel):** Kick off 10DLC brand + campaign registration
   paperwork in Twilio console. Code work proceeds independently.
2. **PR 1 — infra + coordinated Phase 0 upsert updates.** Migration 022
   (column drops, soft-delete columns, partial unique index, sms_sender_opt_outs
   table, scoped handle index), coordinated ON CONFLICT predicate updates
   in `src/app/api/admin/businesses/route.ts` and
   `src/app/api/admin/businesses/[id]/route.ts`, `archived_at IS NULL`
   filter added to `src/app/api/admin/businesses/[id]/channels/route.ts`
   and `getVerifiedEnrollments`, plus `sms-body.ts`, `sms-tracker.ts`,
   `SmsChannel` class (not yet wired into factory), all unit tests.
   **Migration and upsert updates MUST ship together** — migration without
   upsert updates crashes business creation; upsert updates without
   migration have no effect. Flag stays off. No user-visible behavioral
   change. Integration test `onconflict.test.ts` gate-checks both sites.
3. **PR 2 — ingress + admin routes.** `worker/ingress/twilio.ts`, admin API
   routes (verify/confirm/cancel/disable/delete), admin widget component,
   server-component ChannelsSection. Wired behind flag. No behavioral
   change on flag-off path.
4. **PR 3 — factory wire-up + dispatcher defense-in-depth.** Replace
   factory stub with `SmsChannel`. Add dispatcher flag check. Add
   cost-reserve/refund wrapping. Still flag-off; test infrastructure is
   ready.
5. **Flip `CHANNELS_SMS_ENABLED=true` globally.** With no SMS enrollments
   yet existing in the DB, this is a no-op for all existing customers — the
   dispatcher's per-business enrollment fetch returns empty SMS sets for
   everyone. Admin UI unlocks the widget across all detail pages.
6. **Manually enroll ONE test business via admin UI.** Run the ship gate
   (§15). Only this business now has a verified SMS row, so only this
   business receives SMS. Document outcome in `.claude/CLAUDE.md`
   "Current status" line.
7. **10DLC registered → add long code to Messaging Service.** No code
   change. Monitor `notification_deliveries.failure_reason` for
   regressions; caps unchanged.
8. **Manually enroll real customers one at a time over the first week.**
   Admin enrolls per business as they opt in during onboarding calls. If
   regression spotted, `CHANNELS_SMS_ENABLED=false` flips the kill switch
   — dispatcher skips all SMS enrollments, admin widget locks back to
   hidden. Existing verified rows persist unchanged for when the flag
   flips back on.

Each PR is independently revertable. PRs 1–3 can land with flag off over
any cadence without customer impact. Step 5 is the true code-ready
milestone. Steps 6 and 8 are enrollment-driven and don't require deploys.

## 18. Open execution-time details (not blocking design)

These don't block this spec. They resolve when Phase 1 execution starts:

- Which specific business is the test business for the ship gate? (Pick an
  internal test account or a cooperative customer.)
- Who owns the 10DLC paperwork submission? (Sales partner likely.)
- Exact copy for the admin widget's TCPA consent warning — draft separately;
  not architecture.
- Twilio Verify locale — EN default; confirm matches customer phone's carrier
  language default (Twilio handles automatically).

---

_End of Phase 1 design spec. Implementation plan follows via `writing-plans`._
