# Phase 2 — Telegram Channel Implementation Design

_Design spec — RepWorth — 2026-04-22_

## Source of truth

This spec is the **implementation design** for Phase 2 of `docs/adding-communication-channels.md`. The parent spec defines the architecture, security model, data flow, and UX. This document translates that into a concrete, file-level implementation plan optimized for minimum surface area and fastest delivery.

Where this spec and the parent disagree, **this spec wins for implementation details** (e.g., file names, function signatures, test breakdowns); the parent still governs product and architecture invariants.

## Scope delta from parent spec

**Explicit acceptance change.** Parent `docs/adding-communication-channels.md` §5.1 Phase 2 bullets list both admin onboarding AND owner dashboard deliverables for Phase 2. This implementation spec narrows Phase 2 to **admin business-detail page only**. New-business onboarding integration (`/admin/businesses/new`) is also optional / follow-up.

Consequences:
- The Phase 2 ship gate is judged against admin-business-detail enrollment + approval round-trip on a pilot business. "Owner dashboard can connect/disconnect Telegram" is NOT in the Phase 2 gate.
- Full owner self-service lands in Phase 4 alongside SMS and WhatsApp in the same dashboard page — avoids a half-built dashboard that has to be redesigned later.
- Before merging Phase 2, update parent §5.1 Phase 2 bullets to match this scope (or add a scope-amendment note), so the parent document stays an accurate tracker.

## Scope decisions (confirmed via brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Admin business-detail page only** — no owner dashboard, no `/admin/businesses/new` integration at ship time | Phase 4 bundles owner dashboard across all channels; new-business onboarding is a trivial follow-up that can ship independently |
| 2 | **BotFather registration + `setWebhook` are manual prereqs** documented in the launch runbook | Mirrors the Twilio console pattern from Phase 1; keeps worker startup deterministic |
| 3 | **Regenerate UX strips buttons only** (`editMessageReplyMarkup` with empty keyboard) | Minimum signal that the tap registered; new draft arrives as a separate message via the existing outbox path |
| 4 | **Flag-gated off at deploy** (`CHANNELS_TELEGRAM_ENABLED=false`); flipped on after real-bot ship gate passes | Consistent with Phase 1 SMS rollout posture |
| 5 | **No new migrations** | Migration 021 accommodates telegram handles. `inbound_events.source` is TEXT without a CHECK constraint, so `'telegram'` slots in without DDL. Audit rows reuse the existing `approval_audit_log.metadata` JSONB to carry `chat_handle_hash` + `via_channel` (see §3.4) — no schema change needed |
| 6 | **No automated E2E against the real bot** | Per parent spec §5.3 — chat-platform automation is brittle and low-value; unit + integration (mocked) + one manual walkthrough instead |
| 7 | **`approveViaCallback` AND `regenerateViaCallback` land together** | They share 90% of validation logic; splitting across phases duplicates work |
| 8 | **Direct `fetch` to `api.telegram.org`** — no `telegraf` / `node-telegram-bot-api` SDK | Four Bot API methods used (`sendMessage`, `editMessageText`, `editMessageReplyMarkup`, `answerCallbackQuery`); SDK overhead not justified |

## Non-goals (explicit)

- Owner self-service dashboard (`/dashboard/settings/channels`) — Phase 4.
- Full Phase 2 WhatsApp scaffolding — Phase 3.
- Multi-admin approvers per Telegram chat — `UNIQUE(business_id, channel)` enforces one handle per business per channel; owners with multiple approvers use the email channel.
- Bot commands beyond `/start <token>` — no `/help`, `/status`, `/disconnect` in Phase 2. Owner blocks the bot if they want out; admin can disable via the admin panel.
- Cost tracking for Telegram — Bot API is free; the dispatcher's cost-reservation branch is SMS-only and stays that way.
- Supabase Realtime for admin widget — 3s polling on the existing admin channels endpoint is simpler and sufficient for a low-frequency admin flow.

---

## 1. Architecture

### 1.1 Inbound paths (both terminate on Railway Fastify)

**Path A — Enrollment (`/start <rawToken>`):**

```
Telegram webhook → POST /ingress/telegram
  1. verifyTelegramSecret(X-Telegram-Bot-Api-Secret-Token)        — 401 on mismatch
  2. claimInboundEvent(source='telegram', dedupKey=`tg:${update.update_id}`,
                       eventType='enrollment_start', payload=redactedPayload)
     — redacted payload before persist (see §3.4)
  3. Route on message.text starting with '/start ':
        rawToken = text.slice(7).trim()
        tokenHash = sha256(rawToken)
        lookup: channel_enrollments
          WHERE verification_token_hash = $1
            AND channel = 'telegram'
            AND status = 'pending_verification'
            AND verification_token_expires_at > NOW()
        → if no match: sendMessage "This link is invalid or expired…", return 200
        → if match: atomic tx
            UPDATE enrollments SET
              handle = update.message.from.id::text,
              status = 'verified',
              verified_at = NOW(),
              verification_token_hash = NULL,
              verification_token_expires_at = NULL
          sendMessage "✅ You're connected to RepWorth — we'll ping you here when a review needs approval."
  4. Mark inbound_events processed_at = NOW(), return 200.
```

**Path B — Inline callback (`callback_query`):**

Ack strategy (committed): `answerCallbackQuery` fires **after cheap validation** and **before the approval transaction**. Cheap validation is one INSERT-on-conflict (dedup claim), two indexed SELECTs (approval_links lookup, enrollment lookup), and one in-memory parse — well under 1s in normal operation. The approval transaction then runs AFTER the ack, so a slow tx never risks the 15s Telegram timeout. Transaction failures are surfaced via a text-only `sendMessage` fallback pointing the owner to the Edit link already visible on the original message — NOT via a second `answerCallbackQuery` (ack is already spent), and NOT embedding the approval URL (the raw token is not in memory at this point).

```
Telegram webhook → POST /ingress/telegram
  1. verifyTelegramSecret                                          — 401 on mismatch, no ack
  2. claimInboundEvent(source='telegram', dedupKey=`tg:${update.update_id}`,
                       eventType='callback_query', payload=redactedPayload)
                                                                   — 'duplicate' → return 200
                                                                     without ack (Telegram won't
                                                                     re-show a spinner for an
                                                                     already-handled update)
  3. parseCallbackPayload(callback_query.data):
        data format: 'a:<approvalLinkId>' | 'r:<approvalLinkId>'
        malformed → answerCallbackQuery("Invalid action"),
                    mark inbound_events processed_at = NOW() (permanent — no reclaim retry
                    for a structurally-invalid update; dedup key has been recorded already),
                    return 200.
        returns { action: 'approve'|'regenerate', approvalLinkId }
  4. validateInvariants (§3.2 — cheap SELECT queries, no tx):
        a. secret header — already verified in step 1
        b. approval_links row exists AND channel='telegram' AND live
        c. callback_query.from.id matches verified enrollment handle for link.business_id
     Any invariant fails → answerCallbackQuery with friendly text
        (e.g. "This approval is no longer valid — it may have been handled on another channel"),
        mark inbound_events processed, return 200. No state mutation.

  ─── ACK BOUNDARY ───
  5. answerCallbackQuery with forward-looking outcome text:
        approve:    "Approving…"
        regenerate: "Regenerating — a new draft will follow shortly"
     This consumes the Telegram callback ack budget. Anything after this point
     CANNOT surface UX feedback via answerCallbackQuery — only via editMessage*
     on the original message or a fresh sendMessage to the same chat.
  ────────────────────

  6. Invoke ApprovalService.approveViaCallback OR regenerateViaCallback:
        - opens sql.begin, SELECT … FOR UPDATE on approval_links by id
        - validates live-state again inside tx (defense-in-depth against race)
        - loads responses.review_id inside the tx (for correlation recovery — see §3.3)
        - consumes link, revokes siblings, updates response, enqueues
          publish_response or generate_response outbox entry
        - records audit row per §3.3

     Outcomes (distinct handling per error class — do NOT conflate):

     SUCCESS → fall through to step 7.

     PERMANENT LINK-STATE FAILURE — service throws any of the four typed errors:
        - ConsumedLinkError, RevokedLinkError  (another channel won the race
          between step-5 ack and step-6 tx lock — expected under multi-channel)
        - ExpiredLinkError  (wall clock crossed expires_at between step-4 cheap
          validation and step-6 tx lock — rare but possible)
        - ChannelMismatchError  (step-4 already checked this; seeing it inside
          the tx means either a bug or immutable-field corruption — still cannot
          succeed on retry)
        All four are PERMANENT from the user's perspective: retrying the same
        update would throw the same error. Handle uniformly:
        - sendMessage to the chat with channel-appropriate text:
             consumed/revoked: "This reply was just handled on another channel."
             expired:          "This approval link has expired — a new draft will
                                arrive on the next review."
             channel_mismatch: log a warning + generic "no longer valid" message
        - Mark inbound_events processed_at = NOW() (NOT 'failed' — no reclaim retry).
        - Return 200. Step 7 is skipped.

     UNEXPECTED ERROR (DB timeout, network, non-typed throw, any bug):
        - sendMessage to the chat: "⚠️ Something went wrong on our end. Please tap
          the Edit link in the approval message above to finish approval in the
          browser."  (No approvalUrl is embedded — the raw token is not in memory
          at this point, and the original message still carries the Edit URL
          button so the owner has a working path.)
        - Mark inbound_events status='failed' (reclaim retries after 2min per the
          shared helper's existing semantics).
        - Return 503 so Fastify logs the error.

  7. Success-only visible confirmation on the original message:
        approve:    editMessageText("✅ Response approved — we'll post it shortly.")
        regenerate: editMessageReplyMarkup({ inline_keyboard: [] })
     Edit-call failures (429, message_too_old) are logged, NOT retried. The user
     already saw the ack banner from step 5; losing the durable message-edit is
     cosmetic, and the approval transaction has already committed.

  8. Mark inbound_events processed_at = NOW(), return 200.
```

### 1.2 Send path (`TelegramChannel.sendApprovalRequest`)

```
Input: SendApprovalParams {
  handle: <chat_id as string>,
  businessName, reviewerName, starRating, reviewText, reviewDate,
  responsePreview, approvalUrl, approvalLinkId
}

1. { text, inline_keyboard } = formatApprovalTelegram(params)
     text layout (HTML parse mode, escaped):
       <b>New ⭐{starRating} review — {businessName}</b>
       From: {reviewerName} · {reviewDate}
       —
       "{truncatedReviewText}"   ← null-safe, 400 char cap
       —
       Draft reply:
       {truncatedResponsePreview}   ← 400 char cap
     inline_keyboard:
       [ [ {text:'✅ Approve',    callback_data:`a:${approvalLinkId}`},
           {text:'🔄 Regenerate', callback_data:`r:${approvalLinkId}`} ],
         [ {text:'✏️ Edit / view full', url: approvalUrl} ] ]

2. POST https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/sendMessage
     body: { chat_id: handle, text, reply_markup, parse_mode: 'HTML',
             disable_web_page_preview: true }

3. On success: return { externalMessageId: `${chat_id}:${response.result.message_id}` }
   On 403 blocked: throw TelegramRecipientBlockedError
   On 400 chat not found: throw TelegramChatNotFoundError
   On 429: throw TelegramRateLimitError(retry_after)
   Other: throw TelegramApiError(description)
```

The dispatcher (`worker/jobs/NotificationWorker.ts`) catches `TelegramRecipientBlockedError` and `TelegramChatNotFoundError` in a new branch parallel to the existing SMS 21610 branch — atomic tx to flip the enrollment to `unsubscribed` or `disabled` respectively, with `unsubscribed_reason='telegram_blocked'` / `disabled_at=NOW()`. All other errors are recorded as `failed_at` + `failure_reason` and fall through to the next channel, same as any other transient failure.

---

## 2. File-level breakdown

### 2.1 New files

| Path | Purpose |
|------|---------|
| `src/lib/notifications/channels/telegram-channel.ts` | `class TelegramChannel implements NotificationChannel` — `supportsInlineActions=true`, `requiresOptInHandshake=true`. Delegates network I/O to `telegram-client.ts`. |
| `src/lib/notifications/channels/telegram-client.ts` | Thin fetch wrapper. Methods: `sendMessage`, `editMessageText`, `editMessageReplyMarkup`, `answerCallbackQuery`. Classifies errors into `TelegramRecipientBlockedError` / `TelegramChatNotFoundError` / `TelegramRateLimitError` / `TelegramApiError`. |
| `src/lib/notifications/channels/telegram-body.ts` | Pure function `formatApprovalTelegram(params) → { text, inline_keyboard }`. HTML-escape all dynamic fields. Enforce `callback_data` length ≤ 64 bytes. |
| `src/lib/notifications/channels/telegram-env.ts` | `assertChannelsTelegramEnv()` — throws clear message on missing `TELEGRAM_BOT_TOKEN` or `TELEGRAM_WEBHOOK_SECRET` when flag is on. Exempt in `MOCK_EXTERNAL_APIS=true`. |
| `worker/ingress/telegram.ts` | Fastify handler for `POST /ingress/telegram`. Two internal routes: enrollment (text `/start <token>`) and callback (`callback_query`). Uses the refactored `claimInboundEvent` helper (see §2.2 shared helper note) with `source='telegram'`. |
| `worker/ingress/shared.ts` | NEW (extracted from `worker/ingress/twilio.ts`). Exports `claimInboundEvent(source, dedupKey, eventType, payload)` with the existing INSERT ON CONFLICT + 2-min reclaim semantics, but `source` is a parameter instead of hardcoded `'twilio'`. The existing Twilio ingress is updated to call the shared helper with `source='twilio'`. |
| `worker/ingress/telegram-verify.ts` | `verifyTelegramSecret(headerValue)` — constant-time compare against `process.env.TELEGRAM_WEBHOOK_SECRET`. Separate file for independent unit testing. |
| `src/app/api/admin/channels/telegram/_shared.ts` | NEW — mirrors `src/app/api/admin/channels/sms/_shared.ts`. Exports `isTelegramEnabled()`, `flagOff()` (returns 404 to hide the route), `assertTelegramEnvReady()` (returns 503 when flag is on but `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` are missing; null when ready; bypass in `MOCK_EXTERNAL_APIS=true`). Every admin telegram route runs the pair in this order: `if (!isTelegramEnabled()) return flagOff();` then `const envErr = assertTelegramEnvReady(); if (envErr) return envErr;`. |
| `src/app/api/admin/channels/telegram/start/route.ts` | `POST` — admin-authed. Handler order: auth → flag-gate (404 if off) → env-readiness (503 if flag on + env incomplete) → subscription check → advisory lock on `(businessId,'telegram')` → upsert per §2.3 state machine. Returns `{ deepLink, qrPayload, expiresAt }`. Generates `rawToken`, persists SHA-256 + 1h expiry. |
| `src/app/api/admin/channels/telegram/cancel/route.ts` | `POST` — same auth/flag/env gating. Input: `{ businessId }`. Clears `verification_token_hash` / `expires_at` on a `pending_verification` row. Idempotent. |
| `src/app/api/admin/channels/telegram/disable/route.ts` | `POST` — same auth/flag/env gating. Input: `{ businessId }`. Sets `status='disabled', disabled_at=NOW()` on a `verified` row. Manual safety valve. |
| `src/components/admin/TelegramEnrollmentWidget.tsx` | Client component. 5 UI states: `idle → generating → awaiting_scan → verified | expired`. Renders QR + copyable deep link + 1h countdown + "Cancel" + "Refresh status" buttons. Polls `GET /api/admin/businesses/[id]/channels` every 3s during `awaiting_scan`. |

### 2.2 Modified files

| Path | Change |
|------|--------|
| `src/lib/notifications/channels/index.ts` | Factory: remove `'telegram'` from `NOT_YET_IMPLEMENTED`. Gate telegram on flag in the same shape as SMS: `if (id === 'telegram') { if (process.env.CHANNELS_TELEGRAM_ENABLED !== 'true') throw new Error('Telegram channel disabled by CHANNELS_TELEGRAM_ENABLED env flag'); return new TelegramChannel(); }`. The throw is a safety net only — the dispatcher skips first (see `NotificationWorker` modification below). |
| `worker/jobs/NotificationWorker.ts` | Add flag-skip branch for telegram, parallel to the existing SMS skip at line 118: `if (channelId === 'telegram' && process.env.CHANNELS_TELEGRAM_ENABLED !== 'true') { logger.log(...); continue; }`. Without this, a retained `verified` telegram enrollment after a flag-off rollback would propagate through the dispatcher and throw from the factory on every send attempt, failing the whole notification. The SMS/chat-blocked error-handling branch is also extended to catch `TelegramRecipientBlockedError` / `TelegramChatNotFoundError` and flip the enrollment atomically (mirrors the SMS 21610 branch, not a new invention). |
| `src/lib/approval/service.ts` | Add `approveViaCallback({ approvalLinkId, chatHandle, viaChannel, audit: { updateId, ipAddress } })` and `regenerateViaCallback(...)` with the same signature, **living in `service.ts` itself** (not a new file) so they can call the existing module-private helpers `lockPendingResponse()` (line 136), `consumeLink()` (line 127), `revokeSiblings()` (line 151), `insertAuditLog()` (line 44) without exporting them. Throws four typed errors — `ConsumedLinkError` / `RevokedLinkError` / `ExpiredLinkError` / `ChannelMismatchError` — all classified by the ingress as permanent (see §1.1 Path B step 6). Internals: opens `sql.begin`; `SELECT … FOR UPDATE` on `approval_links` by id; validates inside the tx (not consumed/revoked/expired, `channel` matches caller); `SELECT review_id FROM responses WHERE id = link.response_id` so the correlation helper has both keys; calls `recoverCorrelationId(tx, { reviewId, responseId: link.response_id })` — existing helper returns `Promise<string>`, falls back to `responseId` when no upstream row is found (see `src/lib/approval/correlation.ts:28`); invokes the module-private helpers above with the audit row shape described in §3.3 (token_hash from the loaded link, device_cookie_hash NULL, ip_address from `audit.ipAddress`, action `'approved_via_telegram'`/`'regenerated_via_telegram'`, metadata carrying `chat_handle_hash` + `via_channel` + `update_id` + always-set `correlation_id`). Non-typed throws propagate for the caller to route to the "unexpected" fallback. |
| `src/lib/approval/errors.ts` | Add four new classes following the existing `{State}{Subject}Error` convention (see `InvalidTokenError`, `ExpiredTokenError`, `RevokedTokenError`, `ConsumedTokenError`): `ConsumedLinkError`, `RevokedLinkError`, `ExpiredLinkError`, `ChannelMismatchError`. These are distinct from the existing `*TokenError` classes because the callback validation path looks up `approval_links` by id, not by token_hash; throwing a token-flavored error from a by-id lookup would mislead forensics. Same `extends Error` + `this.name = '…'` pattern. |
| `worker/index.ts` | Register `POST /ingress/telegram` via the Fastify app. Call `assertChannelsTelegramEnv()` during startup when `CHANNELS_TELEGRAM_ENABLED=true`. |
| `worker/ingress/twilio.ts` | Replace local `claimInboundEvent` with `import { claimInboundEvent } from './shared'` and call with `source='twilio'`. Pure refactor, no behavior change. |
| `src/app/api/admin/businesses/[id]/route.ts` | Extend response JSON with `telegramEnabled: process.env.CHANNELS_TELEGRAM_ENABLED === 'true'`. |
| `src/app/admin/businesses/[id]/page.tsx` | In the Channels section, flag-gate on `business.telegramEnabled` and render `<TelegramEnrollmentWidget businessId={business.id} />` alongside the SMS widget. |
| `src/app/admin/businesses/new/page.tsx` | Optional: add Telegram to the initial-channel picker during onboarding. Same widget, different mount. Low priority — can ship in a follow-up PR. |
| `.env.example` | Add `CHANNELS_TELEGRAM_ENABLED=false`, `TELEGRAM_BOT_TOKEN=`, `TELEGRAM_WEBHOOK_SECRET=` under a new "Channels — Telegram" section. |
| `.claude/CLAUDE.md` | Status update: Phase 2 Telegram shipped; add the three env vars to the "Feature flags / non-obvious env vars" list. |

### 2.3 `start` endpoint upsert semantics (clarification)

The `POST /api/admin/channels/telegram/start` endpoint is the single entry for all enrollment transitions. It branches on the current state of the `channel_enrollments` row (looked up under the partial unique index `(business_id, channel) WHERE archived_at IS NULL`):

| Current state | Action |
|---|---|
| No row | INSERT new row with `status='pending_verification'`, fresh hash + 1h expiry |
| `pending_verification` (hash live or expired) | UPDATE — overwrite hash + expiry; reset `updated_at` |
| `unsubscribed` | UPDATE to `pending_verification`, clear `unsubscribed_at`/`unsubscribed_reason`, clear `handle`, fresh hash + expiry (owner must re-`/start` from a fresh chat) |
| `disabled` | Same as `unsubscribed` — reset to `pending_verification` with fresh token |
| `verified` | Reject with 409: "Telegram is already connected. Disable it first if you want to re-enroll." |

This means no separate "delete" or "re-enable" endpoint is needed. The `cancel` endpoint clears the current verification attempt; `disable` is the manual admin kill-switch; `start` handles re-enrollment by upsert.

### 2.4 Deferred beyond Phase 2

- Any `edit` callback via inline button — parent spec keeps Edit as a URL button only; no change from that plan.
- Hard-delete of enrollment rows — soft-delete via `archived_at` (from migration 022) is sufficient; no DELETE endpoint added in Phase 2.
- Automatic `editMessageText` retry after approval when Telegram returns 429 — polish; deferred (see §7 risks).

---

## 3. Security

### 3.1 Callback payload format

- Payload string: `<op>:<approval_link_id>` where `op ∈ {'a','r'}`.
- UUIDv7 is 36 chars; `a:` + 36 = 38 bytes, well under the 64-byte Telegram limit.
- **Never put raw approval tokens in `callback_data`** — parent spec invariant. `approval_link_id` is non-secret (74 bits of random entropy, DB row identifier).

### 3.2 Four invariants enforced on every callback

1. **Provider signature.** `X-Telegram-Bot-Api-Secret-Token === process.env.TELEGRAM_WEBHOOK_SECRET` (constant-time compare). Fail → 401, no state change.
2. **Approval-link liveness + channel binding.** `SELECT … WHERE id=$1 AND channel='telegram' AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`. A link id from another channel (SMS, email) submitted to the Telegram ingress is rejected by the `channel` clause.
3. **Sender-handle binding.** `callback_query.from.id` (provider-authenticated) must equal a `'verified'` `channel_enrollments.handle` row for the same `business_id + channel='telegram'`. Blocks forwarded-message replay and leaked-payload misuse from another Telegram account.
4. **Dedup.** `claimInboundEvent(source='telegram', dedupKey='tg:<update_id>', eventType, payload)` — Telegram retries deliver the same `update_id`. Second attempt is a no-op 200 with no `answerCallbackQuery` call.

Any failure terminates the callback with an appropriate HTTP status and zero state mutation. `answerCallbackQuery` carries outcome text (see §1.1 Path B ack strategy) but no authorization weight — it's purely UX feedback to stop the spinner and tell the user what happened.

### 3.3 Audit row shape (no migration)

The current `approval_audit_log` schema has columns `(id, response_id, business_id, token_hash, device_cookie_hash, action, ip_address, metadata JSONB, created_at, actor_user_id, auth_method)`. `auth_method` has a CHECK constraint accepting `'token' | 'owner_session'`. To avoid a migration, Telegram callback audit rows use:

```
{
  id:                 uuidv7(),
  response_id:        link.response_id,
  business_id:        link.business_id,
  token_hash:         link.token_hash,          -- link lookup is by id, but the hash IS loaded
                                                --  with the row and recorded for forensics parity
                                                --  with the email/web approval path
  device_cookie_hash: NULL,                      -- no browser-side binding for chat callbacks
  action:             'approved_via_telegram' | 'regenerated_via_telegram',
  ip_address:         request.ip,                -- ingress server sees Telegram's IP; kept for forensics
  actor_user_id:      NULL,
  auth_method:        'token',                   -- stays within the CHECK constraint; the
                                                 --  approval-link token IS still the authorization
                                                 --  primitive, just accessed via row id + Telegram
                                                 --  signature instead of URL entry
  metadata: {
    via_channel:      'telegram',
    chat_handle_hash: sha256(callback_query.from.id),
    update_id:        callback_query.update_id,
    correlation_id:   <recovered — see below>   -- always set; helper falls back to responseId
                                                --  when no upstream outbox row is found
  }
}
```

**Correlation ID recovery.** The callback ingress handler has no correlation_id of its own — it only holds `approvalLinkId` from the button payload. The existing helper `recoverCorrelationId(tx, { reviewId, responseId })` (at `src/lib/approval/correlation.ts:28`) requires BOTH keys. The callback service therefore does this inside the approval transaction, after locking `approval_links`:

```ts
const [{ review_id: reviewId }] = await tx<{ review_id: string }[]>`
  SELECT review_id FROM responses WHERE id = ${link.response_id}
`;
const correlationId = await recoverCorrelationId(tx, { reviewId, responseId: link.response_id });
```

The helper returns `Promise<string>` — it **always** returns a value. When no upstream `generate_response` outbox row is found (edge case — e.g., pre-S6 data), it falls back to `responseId` so the publish hop stays traceable. `metadata.correlation_id` is therefore **always** set to the returned string; matches what the email/web approval path already writes into its audit rows, keeping forensics consistent across channels.

This preserves the full security trail (what channel, which chat, which update, which correlation) inside `metadata` JSONB, without a DDL change. If later phases need to query on `chat_handle_hash` at volume, migration 024+ can promote it to a column; for Phase 2, forensic queries over JSONB are fine given audit rows are never a hot path.

### 3.4 Payload redaction before `inbound_events` write

- `update.callback_query.data` → replaced with `'[redacted]'` before JSON serialization.
- `message.text` (for enrollment `/start <token>`) → replaced with `'[redacted]'` before persist. Raw token would only sit briefly in the payload (since we clear `verification_token_hash` on successful enrollment) but redaction removes it from the durable audit trail.
- Rest of payload (from, chat, update_id, message metadata) preserved for forensics.

Same belt-and-suspenders posture as the Twilio ingress — the payload already carries only non-secret identifiers, redaction catches any future field that accidentally leaks sensitive data.

---

## 4. Environment variables

Added to `.env.example`:

```bash
# Channels — Telegram
# Server-authoritative flag. Admin UI reads it via the business detail API.
# Do NOT prefix with NEXT_PUBLIC_ — the widget reads from server-rendered props.
CHANNELS_TELEGRAM_ENABLED=false

# BotFather token for @RepWorthBot. Format: <bot_id>:<hash>. Rotate via BotFather.
TELEGRAM_BOT_TOKEN=

# Random 32+ byte string. Set in the setWebhook call AND here — they must match.
# Rotate by re-running setWebhook with a new value + updating this env var.
TELEGRAM_WEBHOOK_SECRET=
```

Runbook addition (`docs/launch-runbook.md`, append to the channels section):

```bash
# One-time setup per environment. Prefer JSON body so allowed_updates is an actual array.
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d "$(cat <<JSON
{
  "url": "${WORKER_PUBLIC_URL}/ingress/telegram",
  "secret_token": "${TELEGRAM_WEBHOOK_SECRET}",
  "allowed_updates": ["message", "callback_query"],
  "drop_pending_updates": true
}
JSON
)"

# Verify
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

> Earlier draft used `-d "allowed_updates=['message','callback_query']"` which is invalid — Telegram requires a JSON array with double quotes. The JSON-body form above avoids the URL-encoding gotcha entirely.

---

## 5. Testing strategy

### 5.1 Unit tests (`src/lib/notifications/channels/__tests__/`)

| File | Covers |
|------|--------|
| `telegram-body.test.ts` | Body composition; HTML escaping of `<`, `>`, `&` in reviewerName + businessName + reviewText + responsePreview; truncation at 400 chars; `callback_data` length ≤ 64 bytes for realistic approvalLinkIds; inline_keyboard shape (2 rows, 3 buttons, URL button last). |
| `telegram-channel.test.ts` | `fetch` mocked; assert URL includes token, body includes chat_id + parse_mode + reply_markup; identity flags (`supportsInlineActions=true`, `requiresOptInHandshake=true`); happy path returns `externalMessageId = chat_id:message_id`; 403 → `TelegramRecipientBlockedError`; 400 chat_not_found → `TelegramChatNotFoundError`; 429 → `TelegramRateLimitError` with retry_after; generic → `TelegramApiError`. |
| `telegram-client.test.ts` | Error code classification only — thin unit around the fetch wrapper. |
| `telegram-env.test.ts` | Env assertion throws on missing vars when flag is on; exempt in mock mode. |
| `telegram-verify.test.ts` | Constant-time compare; header present/absent/mismatched; no timing leaks. |

### 5.2 Integration tests (`worker/ingress/__tests__/`)

| File | Covers |
|------|--------|
| `telegram-enrollment.test.ts` | Happy `/start <token>`: enrollment row flipped to verified, handle = chat_id, hash cleared; expired token → bot reply, enrollment unchanged; unknown token → bot reply, no state change; already-verified enrollment gets polite no-op; missing secret → 401; duplicate update_id → second call is 200 no-op. |
| `telegram-callback.test.ts` | Ack strategy (Model A): `answerCallbackQuery` fires after cheap validation and before the approval transaction. Assert call ordering by stubbing the client and recording invocation sequence, AND assert `inbound_events` terminal status per case. **Happy approve:** sequence = `validateInvariants → answerCallbackQuery("Approving…") → approveViaCallback → editMessageText`. One ack, one edit, no sendMessage; `inbound_events.processed_at` set. **Happy regenerate:** sequence = `… → answerCallbackQuery("Regenerating…") → regenerateViaCallback → editMessageReplyMarkup({inline_keyboard: []})`; processed. **Malformed callback_data:** `answerCallbackQuery("Invalid action")` once, `inbound_events.processed_at` set (NOT `failed` — permanent, no reclaim retry), 200. **Pre-ack invariant fail** (cross-channel replay / sender mismatch / consumed link seen before ack): `answerCallbackQuery("no longer valid…")` once; zero service calls; zero edit/sendMessage; `inbound_events.processed_at` set; 200. **Permanent link-state failure after ack** — parametrize across all four typed errors: `ConsumedLinkError` / `RevokedLinkError` / `ExpiredLinkError` / `ChannelMismatchError`. For each: ack was "Approving…" or "Regenerating…" (whichever path), then one `sendMessage` with the error-type-appropriate copy, zero editMessage calls, `inbound_events.processed_at` set (NOT `failed`), 200. **Unexpected tx failure after ack:** ack was success text, `sendMessage` fallback with text-only "please tap the Edit link" (no URL embedded), zero editMessage calls, `inbound_events.status='failed'`, 503. **Signature-mismatch:** 401 before any ack, zero `answerCallbackQuery`, `inbound_events` row not even claimed (claim happens at step 2). **Duplicate `update_id`:** 200 with ZERO `answerCallbackQuery` calls, no further work. Call-count invariants across the whole suite: `answerCallbackQuery ≤ 1` per update; `sendMessage + editMessageText + editMessageReplyMarkup ≤ 1` per update; service methods called at most once. |

### 5.3 Approval service tests (`src/lib/approval/__tests__/`)

| File | Covers |
|------|--------|
| `approve-via-callback.test.ts` | Service API: `approveViaCallback({ approvalLinkId, chatHandle, viaChannel, audit: { updateId, ipAddress } })`. Tx correctness: link consumed, siblings revoked, response → approved, publish_response outbox entry inserted. Audit row matches §3.3 shape — `token_hash=link.token_hash`, `device_cookie_hash=NULL`, `ip_address=<passed>`, `auth_method='token'`, `action='approved_via_telegram'`, `metadata.via_channel='telegram'`, `metadata.chat_handle_hash=sha256(chatHandle)`, `metadata.update_id=<passed value>`. Correlation recovery: helper called with BOTH `reviewId` (loaded from `responses.review_id` inside tx) AND `responseId`; when upstream `generate_response` outbox has a `correlation_id`, assert `metadata.correlation_id` equals it; when upstream row is missing or has null correlation_id, assert `metadata.correlation_id` equals `responseId` (helper's documented fallback, matches email/web approval path audit behavior). Typed error assertions: pre-consumed link → throws `ConsumedLinkError`, no audit row; revoked link → `RevokedLinkError`; expired link → `ExpiredLinkError`; channel mismatch → `ChannelMismatchError`. All typed errors fire before any state mutation. |
| `regenerate-via-callback.test.ts` | Same shape; response → superseded + new `generate_response` outbox; audit action `'regenerated_via_telegram'`. |

### 5.4 Admin API route tests (`src/app/api/admin/channels/telegram/__tests__/`)

| File | Covers |
|------|--------|
| `start.test.ts` | Non-admin → 403; **flag off → 404 via `flagOff()`**; **flag on + missing env → 503 `telegram_env_not_ready` via `assertTelegramEnvReady()`**; happy path returns `{ deepLink, qrPayload, expiresAt }` with persisted hash matching `sha256(deepLink.token)` and 1h expiry; advisory lock prevents concurrent starts; state-machine transitions per §2.3 (new row, re-pending, unsubscribed→pending, disabled→pending, verified→409). |
| `cancel.test.ts` | Same flag/env gating (404 / 503); clears hash + expiry on pending row; idempotent on already-cleared row; non-admin → 403. |
| `disable.test.ts` | Same flag/env gating (404 / 503); flips verified → disabled; 404 on no-such-enrollment; non-admin → 403. |

### 5.5 Manual ship gate

One walkthrough on a pilot business with a real Telegram account:

1. Admin opens `/admin/businesses/[id]`, clicks "Connect Telegram."
2. QR + deep link appear; admin opens deep link on a phone, taps Start.
3. Admin panel polls and shows "✅ Verified" within 5s.
4. Trigger a new review (or use the admin "send test approval" affordance if one exists; else wait for SerpAPI poll).
5. Approval message arrives in Telegram; owner taps ✅ Approve.
6. Bot edits message to "✅ approved — posting shortly"; admin panel shows response status = `approved` or `awaiting_manual_post`.
7. Repeat with a fresh review + 🔄 Regenerate — buttons disappear on the original; new draft arrives as a separate message.
8. Block the bot from the Telegram client. Trigger another review. Enrollment flips to `unsubscribed` with reason `telegram_blocked`; failover poller catches the no-other-channels case and alerts admin.

---

## 6. Rollout + ship gate

Phase 2 ships behind `CHANNELS_TELEGRAM_ENABLED=false` in every environment at merge time. Flag is flipped on **per environment** only after:

1. All tests green in CI.
2. BotFather bot registered; production `setWebhook` executed pointing at `${WORKER_PUBLIC_URL}/ingress/telegram` with the matching secret.
3. Manual walkthrough above passes on a pilot business.
4. 24h Sentry clean on the pilot business after flag-on.

Rollback: flip `CHANNELS_TELEGRAM_ENABLED` off. Existing `verified` enrollments remain in `channel_enrollments` untouched; the dispatcher's flag-skip branch (§2.2 `NotificationWorker.ts` modification) short-circuits the loop iteration before reaching the channel factory, so no send attempts are made and no deliveries fail. Zero data loss, zero spurious failures. Re-enabling later resumes sends immediately without re-enrollment.

---

## 7. Risks specific to this phase

| Risk | Mitigation |
|------|------------|
| Owner taps a button while a parallel email approval is also in flight | Already covered by `approval_links.consumed_at` uniqueness + atomic sibling revoke. Second ingress call returns "already processed" via `answerCallbackQuery` + no state mutation. |
| Webhook URL leaks and an attacker floods `/ingress/telegram` with crafted updates | Secret header verification (invariant 1) rejects everything without the token. `claimInboundEvent` dedup bounds DB impact even if an attacker replays legitimate updates. No authorization weight on unauthenticated requests. |
| BotFather token leaks from env | Telegram lets you revoke via BotFather + regenerate instantly. Rotation is a one-command deploy + `setWebhook` re-registration. Store via existing encrypted-env mechanisms in production. |
| `answerCallbackQuery` not called within 15s (e.g., DB slow) | Cheap validation (signature, dedup, parse, 2 SELECTs) completes well under 1s. `answerCallbackQuery` fires at step 5 (the ACK BOUNDARY) with outcome text. The heavy approval transaction runs at step 6 AFTER the ack — so a slow tx cannot starve the ack. If somehow validation itself exceeds 15s, Telegram shows a stale loading spinner; the approval state change still completes on the next reclaim since `approval_links` hasn't been consumed and update-id dedup allows retry once `inbound_events.status='failed'`. |
| Dropped `editMessageText` after successful approval (Telegram 429 or offline) | Approval has already committed; the owner's chat will look unchanged, but re-running the SerpAPI poll or next notification will clearly indicate the response is approved. Consider a follow-up `editMessageText` retry with 1 attempt at exponential backoff — deferred to a v2 polish pass, not blocking Phase 2 ship. |
| Admin polls 3s forever if the sales partner closes the tab mid-flow | UI stops polling on unmount; pending rows auto-expire at the 1h TTL and surface "link expired" on next admin visit. |

---

## Appendix — Open questions (non-blocking)

1. **Bot username.** `@RepWorthBot` assumed; confirm availability via BotFather before Phase 2 starts. If taken, `@RepWorthHQBot` / `@RepWorthAIBot` etc. — update `.env.example` comments + runbook deep-link template accordingly.
2. **QR code library.** MUST be local generation — the QR encodes the raw one-time verification token, which is sensitive material (see parent spec §4.2). Third-party QR rendering services (`api.qrserver.com`, `chart.googleapis.com`, etc.) are explicitly prohibited because they would receive the raw token in a request URL and log it. Use `qrcode` (Node) for server-side SVG/PNG data URLs, or `qrcode.react` for client-side rendering from a prop. Decision between server-side vs client-side is made at implementation time based on whether we want to render the QR in the React widget directly (client) or pre-render from the API response (server).
3. **Bot profile setup.** Admin-level polish (bot photo, description, "/start" hint in BotFather). Not code — document in runbook alongside `setWebhook` command. Cosmetic; no ship-gate impact.
