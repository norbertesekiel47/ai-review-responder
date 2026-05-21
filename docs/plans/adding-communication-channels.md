# Adding Communication Channels — SMS, Telegram, WhatsApp

_Design spec — RepWorth MVP — 2026-04-20_

## Goal

Extend RepWorth's approval notification system beyond email. Owners have been requesting SMS, Telegram, and WhatsApp. The architecture must support all three as first-class peers to email without forcing a rewrite when a fourth channel gets added later.

## Product context

- The existing schema (`src/../supabase/migrations/001_initial_schema.sql`) already anticipates SMS — `businesses.notification_preference`, `approval_links.channel`, `notification_deliveries.channel`, `inbound_events.source='twilio'`. SMS was deferred out of the MVP (see `docs/Final_Implementation_Plan.md` line 43). Telegram and WhatsApp are net new.
- `ReviewSource` is the existing pluggable transport abstraction in the reviews domain. This design mirrors that pattern for notifications.
- The 30-second-approval promise in `docs/Product_Brief_AI_Review_Responder.docx` is the primary UX constraint. Inline buttons in chat platforms beat web-link round-trips for mobile-first owners.

## Decisions (from brainstorming)

| #   | Question                          | Decision                                                                                                                         |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Launch order                      | **SMS → Telegram → WhatsApp** (phased; Meta verification starts day 0)                                                           |
| 2   | Approval UX per channel           | **Inline buttons for Approve/Regenerate, web link for Edit**                                                                     |
| 3   | Single vs multi-channel per owner | **Fully multi-channel; first-to-approve wins; siblings revoked atomically**                                                      |
| 4   | Enrollment model                  | **Hybrid: email + one primary mobile channel during the sales onboarding call; extra channels via owner self-service dashboard** |
| 5   | Failover on no-response           | **No automatic re-send. After 4h with no approval on any channel, alert sales partner via `admin_notification_failover` email**  |

---

## 1. Architecture: the `NotificationChannel` interface

Parallels the existing `ReviewSource` pattern. Each channel is a pluggable transport behind a common interface; cross-cutting concerns (subscription guard, cost guard, bounce handling, idempotency) live in the dispatcher, not the channels.

```ts
// src/lib/notifications/channels/types.ts
export type ChannelId = "email" | "sms" | "telegram" | "whatsapp";

export interface SendApprovalParams {
  handle: string; // recipient address / phone / chat_id
  businessName: string;
  reviewerName: string;
  starRating: number;
  reviewText: string | null;
  reviewDate: string;
  responsePreview: string;
  approvalUrl: string; // always provided — edit fallback + SMS link body
  approvalLinkId: string; // UUIDv7 row ID for inline button callback payloads.
  // Non-sensitive. Replaces the original plan's
  // rawToken, which would have leaked into
  // inbound_events via webhook bodies.
}

export interface NotificationChannel {
  readonly id: ChannelId;
  readonly supportsInlineActions: boolean;
  readonly requiresOptInHandshake: boolean;
  sendApprovalRequest(
    p: SendApprovalParams,
  ): Promise<{ externalMessageId: string }>;
}
```

**Implementation files:**

- `src/lib/notifications/channels/email-channel.ts` — wraps existing Resend code from `src/lib/notifications/email.ts`.
- `src/lib/notifications/channels/sms-channel.ts` — Twilio Programmable SMS REST.
- `src/lib/notifications/channels/telegram-channel.ts` — Telegram Bot API `sendMessage` with `inline_keyboard` markup.
- `src/lib/notifications/channels/whatsapp-channel.ts` — Twilio WhatsApp API (interactive template messages).

**`NotificationWorker` becomes a dispatcher** (`worker/jobs/NotificationWorker.ts`):

1. Read response + business + subscription guard (unchanged from today).
2. Query `channel_enrollments` for enrolled+verified+non-unsubscribed channels.
3. For each channel, sequentially: idempotency check → generate token → insert approval_link → send → record delivery. A failure on one channel records `failed_at` and continues to the next (no whole-job retry if at least one succeeded).

**Ingress per channel** — all webhooks terminate on Railway (per the "Third-party ingress terminates on Railway" invariant in `.claude/CLAUDE.md`):

- `POST /ingress/twilio` — SMS + WhatsApp delivery callbacks, inbound SMS (STOP/START), inbound WA button taps. Twilio signature verify shared across SMS/WA.
- `POST /ingress/telegram` — bot webhook: `/start <token>` enrollment + `callback_query` inline button taps.

---

## 2. Data model

### New table: `channel_enrollments`

Migration **021** (`supabase/migrations/021_channel_enrollments.sql`):

```sql
-- IDs are app-generated UUIDv7 (matches repo convention — migration 002
-- dropped DB-side UUID defaults on every other table). The backfill INSERT
-- below uses gen_random_uuid() one-off, which is acceptable for a migration
-- script since production runtime inserts are what must obey the convention.
CREATE TABLE channel_enrollments (
  id                              UUID PRIMARY KEY,
  business_id                     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel                         TEXT NOT NULL,
                                  -- 'email' | 'sms' | 'telegram' | 'whatsapp'
  handle                          TEXT,
                                  -- email address, E.164 phone, or telegram chat_id.
                                  -- NULLABLE: Telegram/WhatsApp enrollment rows are
                                  -- inserted before the owner's handle is known
                                  -- (the handle arrives only when /start <token>
                                  -- hits the ingress). A CHECK constraint below
                                  -- forbids NULL handles on status = 'verified'.
  status                          TEXT NOT NULL DEFAULT 'pending_verification',
                                  -- 'pending_verification' | 'verified' | 'disabled' | 'unsubscribed'
  verified_at                     TIMESTAMPTZ,
  disabled_at                     TIMESTAMPTZ,
  unsubscribed_at                 TIMESTAMPTZ,
  unsubscribed_reason             TEXT,
  -- SHA-256 hash of the one-time enrollment verification token. The raw token
  -- is returned to the admin UI once (QR / deep-link generation), never
  -- persisted. Ingress handlers hash the inbound `/start <token>` or
  -- `start-<token>` payload and look up by hash. Same pattern as
  -- approval_links.token_hash. See §4.2.
  verification_token_hash         TEXT,
  verification_token_expires_at   TIMESTAMPTZ,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, channel),
  -- A verified enrollment MUST have a handle; otherwise the dispatcher has
  -- no recipient. Pending / disabled / unsubscribed rows may have NULL
  -- handles transiently (e.g., Telegram pending_verification before the
  -- owner taps the deep link).
  CHECK (status <> 'verified' OR handle IS NOT NULL)
);

CREATE INDEX idx_channel_enrollments_business ON channel_enrollments(business_id);
CREATE INDEX idx_channel_enrollments_verify
  ON channel_enrollments(verification_token_hash)
  WHERE verification_token_hash IS NOT NULL;

-- Backfill: every existing business gets an auto-verified email enrollment.
-- gen_random_uuid() is fine for this one-off migration — production runtime
-- writes use app-generated UUIDv7.
INSERT INTO channel_enrollments (id, business_id, channel, handle, status, verified_at)
SELECT gen_random_uuid(), id, 'email', owner_email, 'verified', created_at
FROM businesses
WHERE owner_email IS NOT NULL
ON CONFLICT (business_id, channel) DO NOTHING;

-- Mark the legacy column deprecated but do NOT drop yet. Drop in migration 022 after
-- the codebase stops referencing notification_preference.
COMMENT ON COLUMN businesses.notification_preference IS
  'DEPRECATED: see channel_enrollments. Do not read — will be dropped in migration 022.';
```

### Existing tables — no DDL, values expanded

- `approval_links.channel` — TEXT already; expand TS enum to `'email' | 'sms' | 'telegram' | 'whatsapp'`.
- `notification_deliveries.channel` — same.
- `inbound_events.source` — add `'telegram'` alongside the existing `'twilio' | 'stripe' | 'resend' | 'google_pubsub'`.

### Why a separate table and not columns on `businesses`

Adding `sms_phone`, `telegram_chat_id`, `whatsapp_phone`, plus per-channel status/verification columns bloats `businesses` with ~12 nullable fields and forces a schema migration every time a new channel is considered. A separate table captures per-channel lifecycle (`pending_verification → verified → disabled → unsubscribed`) cleanly and lets a fifth channel be added later with zero DDL changes.

---

## 3. Notification flow end-to-end

### 3.1 Send path (`NotificationWorker` dispatcher)

```
handleSendNotification(job):
  response, review, business ← load + guard (pending_approval, subscription, bounce flag)
                                — unchanged from today

  channels ← SELECT channel, handle FROM channel_enrollments
             WHERE business_id = $1
               AND status = 'verified'
               AND unsubscribed_at IS NULL

  for each (channel_id, handle) in channels:                 — sequential, deterministic order
    # Idempotency: if a successful send already exists, skip.
    if notification_deliveries has (response_id, channel=channel_id,
         template='approval_request', sent_at IS NOT NULL, failed_at IS NULL):
      continue

    { rawToken, approvalLinkId } = createApprovalLink({
        responseId, businessId, channel: channel_id, revokeMode: 'orphaned_only' })
    // rawToken stays in memory only — not passed to channel. approvalLinkId
    // (UUIDv7 row ID) is what inline-capable channels receive for button payloads.

    approvalUrl = APP_URL + '/approve/' + rawToken

    try:
      result = channel.sendApprovalRequest({ handle, ..., approvalUrl, approvalLinkId })
      INSERT notification_deliveries (channel=channel_id, recipient=handle,
        sent_at=NOW(), external_message_id=result.externalMessageId)
    except err:
      INSERT notification_deliveries (channel=channel_id, recipient=handle,
        failed_at=NOW(), failure_reason=err.message)
      continue                                                — do NOT abort other channels

  markOutboxCompleted(outboxId)
```

A single-channel failure records `failed_at` and proceeds. If every channel fails, `NotificationFailoverPoller.all_deliveries_failed` branch (already shipped) catches it and alerts admin — no new code path.

### 3.2 Inline callback path (Telegram + WhatsApp)

New ingress handler `worker/ingress/telegram.ts`; Twilio's existing handler extended for WhatsApp:

**Button payload design — raw approval tokens NEVER appear in callback payloads.**
Inline button payloads carry the `approval_links.id` (a UUIDv7 row ID, 74 bits of random entropy, not a secret), NOT the raw approval token. The raw token stays in the email/web URL path only. This preserves the invariant in `.claude/CLAUDE.md`: "Approval tokens are NEVER stored raw… in Postgres, outbox payloads, or logs." Since `inbound_events.payload` persists webhook bodies for dedup, putting raw tokens in button payloads would leak them into Postgres on every Telegram/WhatsApp tap.

```
on inbound callback (update.callback_query for Telegram, button_reply for WA):
  1. Verify provider signature:
       - Telegram: X-Telegram-Bot-Api-Secret-Token == TELEGRAM_WEBHOOK_SECRET
       - Twilio WA: twilio-signature HMAC (shared with SMS ingress)
     FAIL → 401, no further processing, no state mutation.

  2. Dedup via inbound_events (external_event_key = provider update_id) — returns early
     if duplicate. The persisted payload is REDACTED before write (see §3.2.1).

  3. FOR TELEGRAM ONLY: answerCallbackQuery immediately (15s provider timeout).
     Heavy work happens async after this ack.

  4. Parse callback payload:
       action ∈ { 'approve', 'regenerate' }
       approval_link_id = UUIDv7 suffix from the button payload

  5. Look up approval_links BY ID:
       WHERE id = <approval_link_id>
         AND consumed_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > NOW()
         AND channel = <matches ingress source>   ← cross-channel replay protection

  6. Sender-handle binding (critical — see §3.2.2):
       Extract inbound sender handle:
         - Telegram: callback_query.from.id (numeric chat_id, provider-authenticated)
         - WhatsApp: From number in Twilio payload (provider-authenticated)
       Look up the matching channel_enrollments row:
         WHERE business_id = approval_link.business_id
           AND channel = <ingress source>
           AND status = 'verified'
           AND handle = <inbound sender handle>
       If no match: reject (403). A forwarded message or leaked callback cannot
       approve from an account other than the verified enrollment handle.

  7. Call ApprovalService.approveViaCallback({ approvalLinkId, viaChannel, chatHandle }):
       Internally calls the EXISTING ApprovalService.approve() path:
       - Opens sql.begin transaction
       - Consumes this approval_link (consumed_at=NOW)
       - Revokes ALL sibling approval_links for the same response_id in the same txn
       - Updates responses.status = 'approved'   ← ONLY 'approved'. Never sets
         'awaiting_manual_post' directly — the ResponsePublisherWorker handles
         that SerpAPI-mode transition when consuming the publish_response entry.
       - Inserts publish_response outbox entry
       - Inserts approval_audit_log row with device_cookie_hash=NULL,
         chat_handle_hash=sha256(chatHandle), action='approved_via_<channel>'

  8. Send confirmation via channel.editMessageText (Telegram) or
     channel.sendReply (WA): "✅ Response approved — we'll post it shortly"
```

#### 3.2.1 Payload redaction before `inbound_events` write

Defense in depth. Before persisting the webhook body to `inbound_events.payload`, redact the button callback fields:

- Telegram: replace `update.callback_query.data` with the literal string `"[redacted]"` before JSON serialization. Retain everything else (from, chat, message metadata) for forensics.
- WhatsApp (Twilio): replace the `ButtonPayload` form field similarly.

This is belt-and-suspenders — since the payload now contains `approval_link_id` (non-secret) rather than a raw token, leakage risk is already mitigated. Redaction still runs so that if a future change accidentally re-introduces sensitive fields, they are caught.

#### 3.2.2 Security invariants (all must hold for approval to proceed)

1. Provider signature verifies (HTTPS + shared secret — Telegram or Twilio).
2. `approval_links.id` lookup succeeds AND `channel = <ingress source>` (cross-channel replay blocked: a Telegram approval_link_id submitted via `/ingress/twilio` is rejected).
3. Inbound sender handle matches a `'verified'` `channel_enrollments.handle` row for the same business + channel (blocks approval from forwarded messages or leaked button payloads reaching an account other than the enrolled one).
4. `approval_links` row is not `consumed_at`, `revoked_at`, or past `expires_at`.

Failure of any invariant terminates the callback without state change. Raw tokens stay on the web/email path, which retains the existing device-cookie-bound approval flow unchanged.

### 3.3 Edit path

Unchanged. The inline "Edit" button is always a URL button pointing to `APP_URL/approve/<rawToken>` — URL buttons work on every channel (Telegram `InlineKeyboardButton.url`, WhatsApp CTA url template). The owner lands on the existing approval page and follows the existing device-cookie-bound edit flow. No new code.

### 3.4 Multi-channel race (first-to-approve-wins)

Already guaranteed by existing primitives:

- `approval_links.consumed_at` is unique per link and set inside `sql.begin`.
- Sibling revocation happens in the same transaction.
- Second tap: its approval_links lookup in step 5 above returns nothing (revoked), ingress handler replies "Already approved via another channel" without mutating state.

### 3.5 Failover poller changes

File: `worker/jobs/NotificationFailoverPoller.ts`

- **Stale branch** (pending*approval >4h AND at least one approval_request send was attempted): \_do not* queue a new `send_notification` outbox entry. Instead, call `sendInternalEmail` to `ADMIN_NOTIFICATION_EMAIL` (the existing env var — sales partner / admin routing is handled at the mailbox level, not here) with a new `approval_responsiveness_alert` email body. Record the send as `notification_deliveries.template = 'approval_responsiveness_alert'` with the existing 24h dedup check so we don't re-alert the same stuck response daily. This replaces the entire "re-send stale on primary channel" path.

  **Stale detection query gates on `sent_at`, not `delivered_at`.** Telegram Bot API has no "delivered to recipient" callback; Twilio SMS/WA delivery webhooks are unreliable in some regions. Using `delivered_at IS NULL` would false-alert whenever any enrolled channel lacks delivery confirmation. The correct signal is "we tried at least once" (`notification_deliveries.sent_at IS NOT NULL` for at least one row) + "no approval" (`responses.status = 'pending_approval'`) + "no in-flight outbox". Owners on Telegram-only would otherwise trigger constant spurious alerts.

- **All-failed branch** (every approval_request delivery has `failed_at`): unchanged — still alerts admin + queues a retry. This is a delivery problem, distinct from responsiveness.
- Remove the `failover.reason = 'stale_no_delivery'` code path in `NotificationWorker`. The failover outbox entry type stays only for `all_deliveries_failed`.

---

## 4. Enrollment + onboarding

### 4.1 Email (auto-enrolled, no verification)

Onboarding form already collects `owner_email`. Business creation writes `channel_enrollments(business_id, 'email', owner_email, 'verified')` in the same transaction. Bounce detection (already shipped in S6) handles invalid addresses after the first send, so no pre-send verification needed.

### 4.2 Primary mobile channel — during the 20-minute onboarding call

Admin onboarding form (`/admin/businesses/new`) adds a section:

> **Approval channel** (choose one to set up now; more can be added later)
>
> ◯ SMS ◯ Telegram ◯ WhatsApp ◯ Skip for now

Selecting a channel swaps in an inline verification widget rendered in the same page. Sales partner completes the verification during the call before submitting the form; a green check on the row indicates success.

**SMS (Twilio Verify flow):**

1. Sales partner enters owner's phone in E.164 (`+1` prefilled for US).
2. Server inserts `channel_enrollments(..., 'sms', phone, 'pending_verification')` and calls Twilio Verify API to send a 6-digit code.
3. Sales partner reads the code from the owner over the phone, enters it.
4. Server validates via Twilio Verify → flip to `'verified'`, green check appears.

**Telegram (deep-link flow):**

1. Generate `rawVerificationToken = randomUUID()` in memory only. Hash it: `verification_token_hash = sha256(rawVerificationToken)`. Store ONLY the hash on the enrollment row (`verification_token_hash`, `verification_token_expires_at = NOW() + 1h`). The raw token is returned ONCE to the admin UI for QR/deep-link rendering, then discarded.
2. Widget renders a QR code and a clickable link using the raw token: `https://t.me/RepWorthBot?start=<rawVerificationToken>`.
3. Sales partner shares the QR on screen share (or texts the link). Owner taps → Telegram opens bot → taps "Start" → Telegram client sends `/start <rawVerificationToken>`.
4. `/ingress/telegram` receives the message, hashes the inbound token, and looks up the enrollment row by `verification_token_hash`. On match: stores `handle = <chat_id>`, status → `'verified'`, sets `verification_token_hash = NULL` and `verification_token_expires_at = NULL` (one-time use). Bot replies: "✅ You're connected to RepWorth — we'll ping you here when a new review needs approval."
5. Admin UI polls (3s) or uses Supabase Realtime on the enrollment row — green check flips on.

**WhatsApp (click-to-chat flow):**

1. Same token generation as Telegram — raw token returned once, only `verification_token_hash` persisted.
2. Widget renders QR + deep link: `https://wa.me/<RepWorthBusinessNumber>?text=start-<rawVerificationToken>`.
3. Owner taps → WhatsApp opens pre-filled → owner sends → Twilio WA webhook hits `/ingress/twilio`, hashes the inbound token, matches `verification_token_hash`, binds `handle = <owner wa number>`, flips status to `'verified'`, clears the hash. Bot replies with a Meta-pre-approved confirmation template message.

**Safety rails:**

- Verification tokens are single-use, 1-hour TTL. Only the SHA-256 hash is persisted (same pattern as approval_links.token_hash) — DB compromise cannot yield a replayable verification token. Expired rows show "Link expired — regenerate" in the admin UI.
- Repeated enrollment attempt on same (business, channel) pair updates the existing row (UNIQUE constraint) — no row duplication, no orphaned hashes.

### 4.3 Self-service owner dashboard (Phase 4)

Page: `/dashboard/settings/channels`.

- Lists every enrollment with a status badge (`✅ verified | ⏳ pending | ⛔ disabled | 🚫 unsubscribed`), handle (phone masked as `+1••••1234`, email full, telegram chat_id hidden), and Connect / Disconnect actions.
- Connect → same verification widgets as admin onboarding, driven by the owner themselves.
- Disconnect → `UPDATE channel_enrollments SET status='disabled', disabled_at=NOW()`. Dispatcher's fetch query excludes disabled rows from the next notification onward.

### 4.4 Opt-out + compliance

- **SMS STOP** (TCPA requirement in US): Twilio delivers inbound SMS with body `STOP`, `UNSUBSCRIBE`, `CANCEL`, `QUIT`, `END` to our webhook. Handler finds enrollment by `From` number, sets `unsubscribed_at = NOW(), unsubscribed_reason = 'sms_stop'`. Twilio automatically sends the "You have been unsubscribed" reply (carrier compliance). Re-enrollment requires owner to text `START` AND a fresh verification run — no silent re-subscription.
- **Telegram blocked**: Bot `sendMessage` returns `403 Forbidden: bot was blocked by the user`. Error handler flips enrollment to `unsubscribed_at = NOW(), unsubscribed_reason = 'telegram_blocked'`.
- **WhatsApp opt-out**: Twilio WA raises an equivalent event (user reports spam or blocks). Same handling.

### 4.5 Admin visibility

`/admin/businesses/[id]` gets a "Channels" section:

- Per-enrollment row: channel, masked handle, status badge, last activity timestamp (latest confirmed delivery or attempted send — Telegram has no delivery webhook so delivery-only would read blank), unsubscribe reason if applicable.
- Manual "Disable" safety valve for sales partners handling complaints in real time.

---

## 5. Phasing + risks

### 5.1 Phased rollout

**Phase 0 — Refactor + infra** ✅ _SHIPPED 2026-04-22 (merged to main)_

- Migration 021: `channel_enrollments` + backfill existing businesses with verified email rows.
- `NotificationChannel` interface + `EmailChannel` (wrapping current Resend code).
- `NotificationChannel`, `SendApprovalParams`, `ChannelId` types in `src/lib/notifications/channels/types.ts`.
- Refactor `NotificationWorker` into dispatcher pattern (loop of size 1 = identical behavior for existing customers).
- `getChannel` factory, `getVerifiedEnrollments` query helper.
- `createApprovalLink` channel-scoped with advisory lock.
- Failover poller stale branch → admin alert (no re-dispatch).
- Admin Channels section UI + read API.

**Phase 1 — SMS** ✅ _CODE COMPLETE 2026-04-22 (merged to main, flag-gated off pending 10DLC)_

- Migration 022: soft-delete + `sms_sender_opt_outs` / `sms_sender_opt_out_events` tables (RLS, CHECK constraints), partial unique index on `channel_enrollments`, handle lookup index.
- `SmsChannel` via Twilio Programmable SMS REST API (Messaging Service SID).
- `sms-body.ts`: GSM-7 single-segment formatter, two-tier fallback, `SmsBodyTooLongError`.
- `sms-tracker.ts`: per-business + global daily cents cost guard (Redis).
- `worker/ingress/twilio.ts`: signature verify, status-callback (terminal-precedence, race-safe retry), inbound STOP/START (sender-wide opt-out fan-out + TCPA audit log, EN/ES keyword set).
- 6 admin API routes: verify/confirm/cancel/disable/delete/status (advisory lock, Twilio-first, env-readiness 503).
- `SmsEnrollmentWidget` (7-state client UI), `ChannelsSection` server component.
- `NotificationWorker` cost-reservation try/finally + sender-wide 21610 handling.
- Worker startup assertion (`assertChannelsSmsEnv`).
- **Ship gate status:** 10DLC registration paperwork pending. Real-phone manual walkthrough (spec §15) not yet run. Flag stays off (`CHANNELS_SMS_ENABLED=false`) in production.
- **Gate:** end-to-end on one test business with a real phone — SMS received, link tap, approval confirmation, STOP/re-enable cycle.

**Phase 2 — Telegram** ✅ _SHIP GATE PASSED 2026-04-23 (PR to main opened; flag-gated off in prod pending prod bot registration + pilot walkthrough)_

Scope narrowed to **admin-onboarding only** (owner dashboard deferred to Phase 4 — see `docs/superpowers/specs/2026-04-22-telegram-phase-2-design.md` scope delta). No migrations — migration 021 already accommodated telegram.

- Register `@RepWorthBot` via BotFather. Envs: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME` (optional), `CHANNELS_TELEGRAM_ENABLED` (server-authoritative flag, default off). Worker startup assertion fails fast if flag on + env incomplete.
- `TelegramChannel` + `TelegramClient` (native `fetch`, no SDK; 10s AbortController timeout; 4 typed error classes — Blocked/ChatNotFound/RateLimit/Api) + `formatApprovalTelegram` (pure HTML-escaped body + 2-row inline keyboard: Approve/Regenerate as callback_data `a:<link_id>`/`r:<link_id>`, Edit as URL button).
- `worker/ingress/telegram.ts` — `/start <token>` enrollment (SHA-256 token lookup, atomic `SELECT FOR UPDATE + UPDATE` in one `sql.begin`, group/channel chat rejection) + `callback_query` with **Model A ack ordering** (ack AFTER cheap validation AND BEFORE approval tx — stays inside Telegram's 15s budget while keeping the approval atomic). Four typed `*LinkError` + `ResponseNotPendingError` route to `markProcessed` with editMessageText-in-place (replaces stale draft + drops buttons); unexpected errors route to `markFailed` for reclaim retry with text-only sendMessage fallback (no raw token embed). Payload redaction strips `from.first_name`/`last_name`/`username` before `inbound_events` persist.
- `worker/ingress/telegram-verify.ts` — constant-time compare of `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_WEBHOOK_SECRET`.
- `worker/ingress/shared.ts` — extracted `claimInboundEvent(source, dedupKey, eventType, payload)` from Twilio, sets up Phase 3.
- `ApprovalService.approveViaCallback` / `regenerateViaCallback` (`src/lib/approval/service.ts`) — bypass device-cookie binding (authorization is provider-signature + sender-handle bound in ingress). Opens `sql.begin`, `SELECT … FOR UPDATE` on `approval_links` by id, validates live state, throws typed `ConsumedLinkError`/`RevokedLinkError`/`ExpiredLinkError`/`ChannelMismatchError`. Calls existing `recoverCorrelationId(tx, { reviewId, responseId })` for correlation. Audit row metadata: `via_channel`, SHA-256 `chat_handle_hash`, `update_id`, `correlation_id` (stored in `approval_audit_log.metadata` JSONB — no schema change).
- 3 admin API routes (`start`/`cancel`/`disable` under `src/app/api/admin/channels/telegram/`) mirror the SMS pattern — flag → env → auth gate with 404 hiding route when flag off, 503 when env missing, advisory lock + state machine inside `sql.begin`, `Cache-Control: no-store, private` on every response (the `start` body carries the raw one-time token). State machine handles none/pending/unsubscribed/disabled → `pending_verification` with fresh 1h-TTL hash; verified → 409.
- Server-rendered QR data URLs via `qrcode` dep (raw token never leaves the server except to the admin browser that initiated the `start` call).
- `TelegramEnrollmentWidget` (`src/components/admin/TelegramEnrollmentWidget.tsx`) — 8-state client UI (idle/generating/awaiting_scan/verified/disabled/unsubscribed/expired/error), 3s polling during awaiting_scan, 1h TTL countdown, distinguishes 401/403 (session expired) from 5xx (server error) from empty enrollment. Masked chat_id display (`••• 1234`).
- `NotificationWorker` — telegram flag-skip (rollback-safe: retained verified rows don't throw on flag-off), `TelegramRecipientBlockedError` → enrollment flip `status='unsubscribed'`/`unsubscribed_reason='telegram_blocked'`, `TelegramChatNotFoundError` → `status='disabled'`. Both branches include `AND handle = ${enrollment.handle}` filter so stale in-flight send errors can't stomp a re-enrolled handle.
- **Ship gate** (passed 2026-04-23 on Hey Tea test business against `@RepWorthBot` via ngrok): webhook registration, QR enrollment, approve round-trip (button → "✅ approved" edit → response flipped to `approved`), regenerate round-trip (button → "🔄 Regenerating…" edit → new draft arrives as new message), blocked-bot (enrollment flip to `unsubscribed` with reason `telegram_blocked`), re-enroll after unblock (state machine transition `unsubscribed → pending_verification → verified`), cross-channel race (email approve first → telegram tap shows "This review has already been handled" with buttons removed in place).

**Phase 3 — WhatsApp** ✅ _CODE COMPLETE 2026-04-23 (branch `feat/channels-whatsapp-phase-3`, 23 commits, 1087/1087 tests pass, 0 tsc errors, 0 migrations; flag-gated off pending Meta verification + WABA + template approval)_

**Scope amendment (2026-04-23):** Phase 3 ship gate narrowed to admin business-detail page only, matching the Phase 2 precedent. Owner dashboard bundled into Phase 4. New-business onboarding integration not in scope. See `docs/superpowers/specs/2026-04-23-whatsapp-phase-3-design.md` for the implementation-level spec.

- **Preparatory refactor shipped as first atomic commit:** widened `CallbackAuditContext` (`src/lib/approval/service.ts`) from Telegram-shaped `{ updateId: number }` to a provider-agnostic discriminated union `{ providerEventId: string; ipAddress; telegramUpdateId XOR twilioMessageSid }`. `buildCallbackAudit` writes cross-channel `metadata.provider_event_id` unconditionally; Telegram rows continue to write `metadata.update_id` (historical query compatibility), WhatsApp rows write `metadata.message_sid` — discriminated union enforces "never both" at compile time.
- **Second refactor:** extracted `classifyIntent` + `STOP_KEYWORDS` / `START_KEYWORDS` from `worker/ingress/twilio.ts` to new shared `worker/ingress/twilio-intent.ts`. SMS ingress logic otherwise untouched; regression surface = one import line.
- **`WhatsAppChannel` + `WhatsAppClient`** (`src/lib/notifications/channels/`) — Twilio SDK wrapper with explicit `{ timeout: 10_000, autoRetry: false }`, 7 typed error classes. `classifyError` dispatch: 63014/63033 → `RecipientBlocked`, 63024/21211/21408 → `InvalidRecipient`, 63040-42/63027-28 → `TemplateConfig`, 63016 → `SessionWindow`, 63017/63018/429 → `RateLimit`, AbortError/ETIMEDOUT → `Timeout`, else → generic `ApiError`. Module side-effect-free at import (spec §2.0 rule 2).
- **`whatsapp-body.ts` pure helpers** — `formatApprovalWhatsApp` produces the 9 Twilio Content variables for `repworth_approval_request_v1` (see `docs/whatsapp-templates.md` for template reference). `extractTokenFromApprovalUrl` enforces strict `/approve/<token>` shape — throws on query strings, hash fragments, trailing slashes, non-approve paths, empty tokens; prevents staging/local shipping broken URL buttons into a Meta-approved template.
- **`worker/ingress/twilio-whatsapp.ts`** (sibling to `worker/ingress/twilio.ts`, zero touch to SMS logic):
  - Status callback mirrors SMS pattern (signature verify, dedup on `${MessageSid}:${MessageStatus}`, first-wins terminal state, reclaim if delivery row not yet present) with `channel='whatsapp'` discriminator.
  - Inbound handler dispatches on payload shape with strict precedence: (1) `ButtonPayload` present → approve/regenerate via `approveViaCallback`/`regenerateViaCallback` with `viaChannel='whatsapp'` + `twilioMessageSid` audit; (2) STOP keyword → single-statement UPDATE (no `sql.begin`) with COALESCE pattern, handle-scoped + `archived_at IS NULL`; (3) START keyword → intentional no-op; (4) `Body.startsWith('start-')` → `sql.begin` enrollment tx (sha256 hash lookup + UPDATE with archived_at guards on both); (5) else → log + markProcessed.
  - **UUID validation on `ButtonPayload`:** regex `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` check BEFORE the DB SELECT — malformed payloads route to the same processed-200 path as bad prefix, preventing Postgres "invalid input syntax for type uuid" from escaping the happy path.
  - **Post-claim try/catch safety net:** wraps ALL post-`claimInboundEvent` work. Any DB throw between claim and markProcessed/markFailed lands in `markFailed('post_claim_unexpected:...')` + 503 instead of leaking a stuck `received` row (Twilio retries within the 2-min reclaim window would otherwise see it as duplicate and silent-200). Two integration tests push Error sentinels into the sql mock queue to cover link-lookup and STOP-update failure paths.
  - **Permanent link-state errors** (`ConsumedLinkError`, `RevokedLinkError`, `ExpiredLinkError`, `ChannelMismatchError`, `ResponseNotPendingError`) → friendly freeform + markProcessed + 200. **Unexpected errors** → freeform fallback + markFailed + 503 for 2-min reclaim. Zero raw-token embed in any fallback message.
  - **Payload redaction** (`redactWhatsAppPayload`): strips `Body`, `ButtonPayload`, `ProfileName`, `WaId` before `inbound_events.payload` persist. Keyword/token classification reads params BEFORE redaction.
- **3 admin API routes** (`/start`/`/cancel`/`/disable` under `src/app/api/admin/channels/whatsapp/`) mirror the Telegram pattern — flag → env → auth gate with 404 hiding route when off, 503 when env incomplete, advisory lock + state machine inside `sql.begin`, `Cache-Control: no-store, private` on every response. `/start` uses wa.me digit-only deep link construction (`TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:\+?/, '')` → `https://wa.me/<digits>?text=start-<rawToken>`), server-rendered QR data URL via `qrcode` dep.
- **`WhatsAppEnrollmentWidget`** (`src/components/admin/WhatsAppEnrollmentWidget.tsx`) — 8-state client UI (idle/generating/awaiting_scan/verified/disabled/unsubscribed/expired/error), 3s polling during awaiting_scan, 1h TTL countdown, masked phone display (first 3 + `•`-padded middle + last 4), Cancel force-resets to idle locally before `refresh()` so the QR vanishes immediately.
- **`NotificationWorker` dispatcher split** — flag-skip + 6 WA error branches. OWNER-INTENT (`RecipientBlocked`→`unsubscribed`/`whatsapp_blocked`, `InvalidRecipient`→`disabled`) flips enrollment with handle-scoped + `archived_at IS NULL` guard and COALESCE pattern. **CONFIG-ERROR (`TemplateConfigError`, `SessionWindowError`) leaves enrollment `verified` UNCHANGED** — template paused/broken is a RepWorth ops failure, not owner intent, and flipping to unsubscribed would falsely suppress notifications + mislead the admin widget. Explicit integration test asserts zero `channel_enrollments` UPDATE calls on `WhatsAppTemplateConfigError` — single most important regression guard in Phase 3. Transient (`RateLimit`, `Timeout`) records `failed_delivery` only; BullMQ queue-level backoff handles retry.
- **Startup assertion** `assertChannelsWhatsAppEnv` in `worker/startup-assert.ts` is **self-contained** — does NOT depend on `assertChannelsSmsEnv` (which early-returns when SMS flag is off). Verifies 7 env vars present + `TWILIO_WHATSAPP_NUMBER` matches `/^whatsapp:\+\d{7,15}$/` format + `WHATSAPP_APPROVAL_URL_BASE === NEXT_PUBLIC_APP_URL + '/approve/'` equality.
- **Raw-token locality invariant maintained** — raw token exists only in `contentVariables['9']` for the URL button (same semantic boundary as the email channel's URL), never in `ButtonPayload` (carries UUID-shaped `approval_link_id`, not the token), never in `inbound_events.payload`, never in logs (asserted by `WhatsAppClient` test spy on console.log/error/warn across every error path with fixture raw token).
- **Template contract** documented in `docs/whatsapp-templates.md` (local, gitignored): `twilio/card` Content type, 9 body variables, 2 quick-reply buttons (Approve/Regenerate with payload `{{7}}`=`a:<uuid>` / `{{8}}`=`r:<uuid>`) + 1 URL button (`https://app.repworth.com/approve/{{9}}`), UTILITY category, body copy pinned. Any edit triggers a fresh Meta review cycle.
- **Review cycles:** 5 internal review passes via `superpowers:code-reviewer` subagent caught 11 design-spec issues + 11 code-review findings + 4 post-review hardening issues pre-ship. Final state: zero blocking issues.
- **Gate:** same 8-item ship gate as Phase 2 — real Twilio WA sender + approved template on one pilot business: (1) webhook registration, (2) click-to-chat enrollment, (3) approve round-trip, (4) regenerate round-trip, (5) blocked-recipient handling, (6) re-enrollment after unblock, (7) cross-channel race vs email, (8) STOP inside session. Until all 8 pass, `CHANNELS_WHATSAPP_ENABLED=false` in production.
- **External prerequisites (nothing started at merge):** Meta Business verification (2–4 week clock), WABA creation, Twilio WA sender provisioning, `repworth_approval_request_v1` Content template submission + Meta approval, populate 4 env vars in Railway + Vercel, configure Twilio console webhooks at `/ingress/twilio/whatsapp-{inbound,status}`.

**Phase 4 — Owner self-service dashboard** _(can slot as early as Phase 1.5 if customer demand shows up)_

- `/dashboard/settings/channels` page. Reuses the admin onboarding verification widgets.

### 5.2 Risks + mitigations

| Risk                                                   | Mitigation                                                                                                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10DLC registration latency blocks Phase 1              | Use a Twilio verified toll-free number as interim sender. Swap to 10DLC long code when registered.                                                                                |
| Meta Business verification blocks Phase 3 indefinitely | Phase 3 is strictly last. Phases 0–2 + Phase 4 ship full customer value without it. If Meta denies, silently drop WhatsApp — architecture supports it.                            |
| WhatsApp 24h session window breaks Edit flow           | Edit button is a URL button, not an interactive reply button. URL buttons work inside template messages and open the browser regardless of session state.                         |
| Telegram 15s callback timeout                          | `answerCallbackQuery` immediately after `inbound_events` dedup passes. Do the real approval work async; update the chat via `editMessageText` when done.                          |
| Multi-channel approval race                            | Already covered by `approval_links.consumed_at` uniqueness + atomic sibling revoke inside `sql.begin`. Loser taps return "already approved via [other channel]" without mutation. |
| Cost runaway on chatty owners                          | `DAILY_CHANNEL_SEND_LIMIT_CENTS` in `CostTracker`, mirroring LLM cost guard.                                                                                                      |
| STOP regret (owner unsubscribes then wants back)       | Admin UI "Re-enable" button requires a fresh verification flow. No silent re-subscribe.                                                                                           |
| Telegram bot token leak                                | Store via existing KEK/DEK envelope encryption. Rotation = new BotFather token + deploy; old token auto-invalidated by Telegram.                                                  |
| Inline callback signature bypass                       | All three checks must hold: provider signature verifies, `inbound_events` dedup passes, `approval_links.channel` matches ingress source. Test every path with a forged fixture.   |
| First-time SMS routes to spam                          | Twilio A2P registered sender + conservative send rate + no marketing content in approval body.                                                                                    |

### 5.3 Testing strategy

Per phase, before ship gate:

- **Unit:** each `NotificationChannel` with mocked provider SDK. Signature verifiers with known-good + known-bad fixtures per channel.
- **Integration:** full outbox → dispatcher → N channels with one channel failing → verify (a) other channels deliver, (b) `notification_deliveries` has one success + one fail row, (c) outbox entry marked completed, (d) no retry loop.
- **Integration:** replay a send_notification outbox entry twice → verify zero duplicate sends, zero duplicate approval_links.
- **Security:** forged inline callback with tampered signature → 401, no state change. Cross-channel token replay (token from channel A submitted via channel B's ingress) → rejected by the `AND channel = <source>` clause.
- **Compliance:** inbound `STOP` via Twilio webhook → enrollment flipped to `unsubscribed`, next `send_notification` dispatch skips the channel.
- **E2E (Playwright):** owner dashboard channel enrollment flow (connect → verify → appears as verified).
- **Manual end-to-end per channel:** monitored test business with real phone/Telegram/WhatsApp — not automated (real chat-platform automation is brittle and low-value).

### 5.4 Out of scope (YAGNI)

Explicitly not covered by this design:

- Push notifications (iOS/Android native apps).
- Discord / Slack / generic webhook channel. The interface supports them; no one is asking.
- SMS long-form content. Approval SMS body: `"New ⭐3 review from Jane. Draft ready: [approval URL]"`. Full review text is only on the web approval page.
- Per-channel message template translation for channel boilerplate. Response text is already multilingual via existing language detection; channel wrapper text (button labels, confirmation messages) stays English for MVP.
- Multi-recipient per channel. `UNIQUE(business_id, channel)` enforces one handle per channel per business. Owners with multiple approvers use shared email aliases (the email channel's native mechanism).
- Pre-send channel health pings (e.g., checking Telegram bot is reachable before a real notification). The failover poller and bounce detection cover this reactively — proactive probing is over-engineering at this scale.

---

## Appendix A — File-level work breakdown (implementation reference)

The implementation plan (to be produced by the `writing-plans` skill after this spec is approved) should cover, at minimum:

**Phase 0 — Refactor:**

- `supabase/migrations/021_channel_enrollments.sql` (new)
- `src/lib/notifications/channels/types.ts` (new)
- `src/lib/notifications/channels/email-channel.ts` (new — wraps existing `sendApprovalEmail`)
- `src/lib/notifications/email.ts` (no change; `EmailChannel` wraps the existing `sendApprovalEmail` function)
- `src/lib/approval/create-link.ts` (refactor: accept `channel` param + channel-scoped revoke; returns `approvalLinkId`)
- `worker/jobs/NotificationWorker.ts` (refactor: dispatcher pattern)
- `worker/jobs/NotificationFailoverPoller.ts` (stale branch → admin alert)
- `worker/index.ts` (drop `RESEND_WEBHOOK_SECRET` gate on failover poller)
- `src/lib/shared/worker-types.ts` (narrow `failover.reason` to `'all_deliveries_failed'`)
- `src/lib/notifications/delivery.ts` (widen `channel` param type to `ChannelId`)
- `src/app/api/admin/businesses/[id]/channels/route.ts` (new — admin read endpoint)
- `src/app/api/admin/businesses/[id]/route.ts` (extend PATCH: sync email enrollment on `ownerEmail` change)
- `src/app/admin/businesses/[id]/page.tsx` (Channels section)
- Task 8 sweep: `src/app/api/settings/route.ts`, `src/app/api/dashboard/route.ts`, `src/app/api/admin/businesses/route.ts`, `src/lib/shared/schemas.ts`, `src/app/(authenticated)/settings/page.tsx`, `src/app/admin/businesses/new/page.tsx`, `src/app/admin/runbook/page.tsx`
- Vitest suites in `src/lib/notifications/channels/__tests__/`, `src/lib/approval/__tests__/`

**Deferred to Phase 2/3 (listed here for traceability):**

- `src/lib/approval/service.ts` — `approveViaCallback` method lands with Telegram (Phase 2) because it's only exercised by inline-callback ingress paths.

**Phase 1 — SMS:**

- `src/lib/notifications/channels/sms-channel.ts` (new — Twilio Programmable SMS)
- `worker/ingress/twilio.ts` (new — signature verify, delivery webhooks, STOP/START inbound)
- `src/app/admin/businesses/new/page.tsx` (modify — add SMS verification widget)
- `src/app/api/admin/channels/sms/verify/route.ts` (new — calls Twilio Verify API)
- `src/app/api/admin/channels/sms/confirm/route.ts` (new — validates 6-digit code)
- `src/lib/costs/tracker.ts` (modify — add `DAILY_CHANNEL_SEND_LIMIT_CENTS` counter)
- `.env.example` (add Twilio variables)
- Integration tests for ingress handler

**Phase 2 — Telegram:**

- `src/lib/notifications/channels/telegram-channel.ts` (new — Bot API)
- `worker/ingress/telegram.ts` (new — `/start` + `callback_query`)
- `src/lib/approval/service.ts` (new method `approveViaCallback` — skips device-cookie requirement when ingress signature verified; invoked by the Telegram + WhatsApp callback ingress handlers)
- `src/app/admin/businesses/new/page.tsx` (modify — add Telegram QR widget)
- `src/app/api/admin/channels/telegram/start/route.ts` (new — generates verification token, returns deep link)
- `.env.example` (add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`)
- Unit test for inline callback signature verification

**Phase 3 — WhatsApp:**

- `src/lib/notifications/channels/whatsapp-channel.ts` (new — Twilio WA)
- `worker/ingress/twilio.ts` (extend — WA button reply handling alongside existing SMS)
- `src/app/admin/businesses/new/page.tsx` (modify — add WhatsApp click-to-chat widget)
- Meta Business Platform template JSON (separate file, `docs/whatsapp-templates.md`)
- `.env.example` (add `TWILIO_WHATSAPP_NUMBER`, `WHATSAPP_APPROVAL_TEMPLATE_SID`)

**Phase 4 — Owner dashboard:**

- `src/app/(authenticated)/dashboard/settings/channels/page.tsx` (new)
- `src/app/api/owner/channels/[channel]/start/route.ts` (new — shared across channels)
- `src/app/api/owner/channels/[channel]/disconnect/route.ts` (new)

## Appendix B — Open questions to confirm before implementation

These don't block spec approval but should be nailed down before Phase 1 code starts:

1. **Twilio account strategy.** Single trial account for dev + prod, or separate sub-accounts? Sub-accounts simplify cost attribution and credential rotation but need paid plan.
2. **Telegram bot naming.** `@RepWorthBot` assumed. Check availability; confirm bot username convention with brand guidelines (if any).
3. **WhatsApp template wording.** Meta approves specific button labels — decide "Approve" vs "Yes, post this" etc. before submission (approval latency restarts on every template edit).
4. **CostTracker ceiling values.** Per-business daily channel-send ceiling defaults: SMS $0.02/day (~2 notifications at $0.008 each + headroom), WA $0.05/day, Telegram $0 (free). Open to tuning based on early customer data.
5. **STOP/START language coverage.** TCPA requires English; do we also honor `PARAR` / `ANNULER` / other locale keywords for multilingual owners? Recommendation: no — Twilio's default handling covers EN + ES, rely on that.
