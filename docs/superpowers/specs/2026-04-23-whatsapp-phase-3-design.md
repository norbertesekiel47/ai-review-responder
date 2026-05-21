# Phase 3 — WhatsApp Channel Implementation Design

_Design spec — RepWorth — 2026-04-23_

## Source of truth

This spec is the **implementation design** for Phase 3 of `docs/adding-communication-channels.md`. The parent spec owns cross-channel architecture, security model, and UX; this spec translates that into a concrete, file-level implementation plan optimized for minimum surface area and fastest delivery — and explicitly preserves every architecture invariant established by Phase 0, Phase 1 SMS, and Phase 2 Telegram.

Where this spec and the parent disagree, **this spec wins for implementation details** (file names, function signatures, test breakdowns); the parent still governs product and architecture invariants.

## External prerequisite status (2026-04-23)

**Nothing started.** No Meta Business verification, no WABA, no Twilio WA sender provisioned, no template submitted. Code ships flag-gated off; real-bot ship gate is deferred until external prerequisites clear — identical posture to Phase 1 SMS (still gated off pending 10DLC registration) and Phase 2 Telegram (gated off at merge pending prod bot registration).

## Scope delta from parent spec

The parent spec (§5.1 Phase 3) lists both admin onboarding AND owner dashboard deliverables. Phase 2 already set the precedent of narrowing to admin business-detail page only; this spec applies the identical narrowing to Phase 3.

Consequences:

- Phase 3 ship gate is judged against admin-business-detail enrollment + approval round-trip on a pilot business. "Owner dashboard can connect/disconnect WhatsApp" is NOT in the Phase 3 gate.
- New-business onboarding integration (`/admin/businesses/new`) is NOT in scope either — follow-up if needed.
- Full owner self-service lands in Phase 4 alongside SMS + Telegram + WhatsApp in the same dashboard page.
- Before merging Phase 3, update parent §5.1 Phase 3 bullets to match this scope (or add a scope-amendment note), matching the Phase 2 precedent.

## Scope decisions (confirmed via brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Admin business-detail page only** — no owner dashboard, no `/admin/businesses/new` integration at ship time | Phase 4 bundles the dashboard for all chat channels; onboarding integration is a trivial follow-up |
| 2 | **Flag-gated off at deploy** (`CHANNELS_WHATSAPP_ENABLED=false`); flipped on after real-bot ship gate passes | Consistent with Phase 1 SMS + Phase 2 Telegram rollout posture |
| 3 | **Zero migrations** | Migration 021 accommodates `channel='whatsapp'`; migration 022's partial unique index and handle lookup index already include `whatsapp`; `inbound_events.source='twilio'` reused |
| 4 | **Ingress routing: separate Fastify routes in a new file** (`worker/ingress/twilio-whatsapp.ts`) | SMS handler logic in `worker/ingress/twilio.ts` is untouched — the only change to that file is an import-line refactor (replacing the local `classifyIntent` definition with `import from './twilio-intent'`, see §2.2). SMS regression risk is limited to import wiring; shared signature verify + dedup helpers already extracted. |
| 5 | **Template shape: 3-button UTILITY template** (2 quick-reply: Approve / Regenerate + 1 URL: Edit / view full) | Mirrors Telegram UX; current Meta rules allow this mix on utility templates; fallback to 2-button is a template edit only, zero code change |
| 6 | **Opt-out storage: `channel_enrollments.unsubscribed_at` only** (no WA-specific table) | WA re-enrollment is fresh click-to-chat + handle rebind; no sender-level state to track (unlike SMS, where Twilio Messaging Service opt-out is sender-scoped) |
| 7 | **Session-window handling: delegate to Twilio/Meta** | Approval requests always send as templates (works regardless of window); post-button-tap confirmations send free-form inside auto-established 24h session; no app-side session tracking |
| 8 | **Sender config: direct WA number, no Messaging Service** | `TWILIO_WHATSAPP_NUMBER` env + `WHATSAPP_APPROVAL_TEMPLATE_SID` env; matches parent spec §5.1 Appendix A |
| 9 | **Ship gate: mirror Phase 2 Telegram** — real-bot round-trip on one pilot business | Same gating philosophy: merge on unit + integration (mocked) tests; real-bot walkthrough after external prerequisites clear |
| 10 | **`approveViaCallback` / `regenerateViaCallback` — audit context widened** | The existing `CallbackAuditContext { updateId: number; ipAddress: string \| null }` (`src/lib/approval/service.ts:443`) is Telegram-shaped. Phase 3 widens to `{ providerEventId: string; ipAddress: string \| null; telegramUpdateId?: number; twilioMessageSid?: string }`, stores `message_sid` for WhatsApp and `update_id` for Telegram in the metadata JSONB. Telegram callers pass `{ providerEventId: String(updateId), telegramUpdateId: updateId }`; WhatsApp callers pass `{ providerEventId: MessageSid, twilioMessageSid: MessageSid }`. No schema change — `approval_audit_log.metadata` is JSONB. |
| 11 | **No cost guard for WA** | Template pricing is fixed per conversation; owner daily volume is bounded by review rate; defer until real volume data shows a need |
| 12 | **`classifyIntent` + STOP/START keyword sets extracted to `worker/ingress/twilio-intent.ts`** | Currently private inside `worker/ingress/twilio.ts` (lines 150-173). WA ingress imports it rather than duplicating the keyword sets; Phase 3 extracts as a pure move, zero behavior change for SMS. |
| 13 | **URL base parity asserted via `WHATSAPP_APPROVAL_URL_BASE` env** | The approved template's URL button base (e.g. `https://app.repworth.com/approve/`) must equal `NEXT_PUBLIC_APP_URL + '/approve/'` — otherwise staging/local runs generate URLs the Meta-approved template doesn't point at. Startup assertion (in `worker/startup-assert.ts`) fails fast on mismatch. |
| 14 | **Twilio SDK explicit timeout + `autoRetry: false`** | Matches Telegram client posture. WA ingress does inline free-form confirmation sends; an unbounded Twilio hang would stall ingress processing. `twilio(sid, token, { timeout: 10_000, autoRetry: false })`; classify timeouts as a distinct `WhatsAppTimeoutError` (fall-through to generic `failed_at`, not an enrollment state change). |

## Non-goals (explicit)

- Owner self-service dashboard (`/dashboard/settings/channels`) — Phase 4.
- New-business onboarding integration for WhatsApp — follow-up if needed.
- Multi-admin approvers per WhatsApp handle — `UNIQUE(business_id, channel) WHERE archived_at IS NULL` enforces one handle per business per channel.
- WA template submission automation — human ops task, tracked in the launch runbook.
- WA per-business cost guard — deferred pending real volume data.
- Multi-language STOP beyond Twilio-native EN + ES (same policy as SMS).
- Automated E2E against the real Twilio WA sender — chat-platform automation is brittle per parent spec §5.3.

---

## 1. Architecture

### 1.1 Inbound paths (both terminate on Railway Fastify; reuse `verifyTwilioSignature` + `claimInboundEvent('twilio', …)`)

**Path A — Enrollment (click-to-chat `start-<token>` inbound message):**

```
Twilio webhook → POST /ingress/twilio/whatsapp-inbound
  1. verifyTwilioSignature(X-Twilio-Signature, fullUrl, params)         — 401 on mismatch
  2. claimInboundEvent(source='twilio', dedupKey=MessageSid,
                       eventType='whatsapp_inbound',
                       payload=redactWhatsAppPayload(params))           — 'duplicate' → 200
  3. Classify Body:
       - classifyIntent first (STOP/START keywords — imported from the extracted
         `worker/ingress/twilio-intent.ts` shared module; see §2.1):
           'stop' → UPDATE channel_enrollments SET status='unsubscribed',
                      unsubscribed_reason='whatsapp_stop' ... WHERE handle = stripWaPrefix(From)
                      AND channel='whatsapp' AND archived_at IS NULL
           'start' → no-op (admin must re-verify via /start route; matches SMS §4.4 policy)
       - if intent='none' AND Body starts with 'start-':
           rawToken = Body.slice(6).trim()
           tokenHash = sha256(rawToken)
           lookup: channel_enrollments
             WHERE verification_token_hash = tokenHash
               AND channel = 'whatsapp'
               AND status = 'pending_verification'
               AND verification_token_expires_at > NOW()
               AND archived_at IS NULL
           match → atomic tx:
               UPDATE channel_enrollments
               SET handle = stripWaPrefix(From),
                   status = 'verified',
                   verified_at = NOW(),
                   verification_token_hash = NULL,
                   verification_token_expires_at = NULL
               WHERE id = <matched row>
                 AND archived_at IS NULL  -- guard survives partial-unique index semantics
             sendFreeform("✅ You're connected to RepWorth — we'll ping you here when a review needs approval.")
           no match → sendFreeform("This link is invalid or expired.")
  4. Mark inbound_events processed_at = NOW(), return 200.
```

**Path B — Inline button tap (template quick_reply returns as inbound with `ButtonPayload` field):**

Twilio delivers WA quick_reply taps as a variant inbound message POST to the same endpoint. Distinguished by presence of `ButtonPayload`. No synchronous-ack budget (unlike Telegram's 15s `answerCallbackQuery`), so the approval transaction runs inline and confirmation is sent after commit.

```
Twilio webhook → POST /ingress/twilio/whatsapp-inbound
  1. verifyTwilioSignature                                              — 401 on mismatch
  2. claimInboundEvent('twilio', MessageSid, 'whatsapp_button',
                       redactWhatsAppPayload(params))                   — 'duplicate' → 200
  3. parseButtonPayload(ButtonPayload):
        'a:<linkId>' | 'r:<linkId>' → { action, approvalLinkId }
        malformed → mark processed, 200, log for forensics
  4. validateInvariants (§3.3 — cheap SELECTs, no tx):
        a. signature — already verified in step 1
        b. approval_links row exists AND channel='whatsapp' AND live
           (consumed_at IS NULL, revoked_at IS NULL, expires_at > NOW())
        c. stripWaPrefix(From) matches a verified enrollment.handle
           for link.business_id + channel='whatsapp' AND archived_at IS NULL
        Any invariant fails → sendFreeform with friendly text,
                              mark inbound_events processed, return 200.
  5. Invoke approveViaCallback / regenerateViaCallback with
       viaChannel='whatsapp':
        - opens sql.begin, SELECT … FOR UPDATE on approval_links by id
        - validates live-state again inside tx (defense-in-depth)
        - loads responses.review_id for correlation recovery
        - consumes link, revokes siblings, updates response, enqueues
          publish_response or generate_response outbox entry
        - writes approval_audit_log row per §3.5

     Outcomes:

     SUCCESS → step 6.

     PERMANENT LINK-STATE FAILURE (ConsumedLinkError / RevokedLinkError /
       ExpiredLinkError / ChannelMismatchError / ResponseNotPendingError):

       `ResponseNotPendingError` (thrown by `lockPendingResponse` at
       `src/lib/approval/service.ts:151` when the response is no longer
       `pending_approval`) is classified as PERMANENT here, matching the
       Telegram ingress behavior (`worker/ingress/telegram.ts:324`).
       Without this classification, a response already approved via email
       or dashboard would spam fallback messages on every 2-minute
       dedup reclaim cycle.

       - sendFreeform with channel-appropriate text:
           consumed/revoked/not_pending: "This reply was just handled on another channel."
           expired:          "This approval link has expired — a new draft
                              will arrive on the next review."
           channel_mismatch: log warn + generic "no longer valid" message
       - Mark inbound_events processed_at = NOW() (NOT 'failed').
       - Return 200. Step 6 skipped.

     UNEXPECTED ERROR (DB timeout, non-typed throw, any bug):
       - sendFreeform: "⚠️ Something went wrong on our end. Please tap the
          Edit link in the approval message above to finish in browser."
          (No approvalUrl embed — raw token not in memory at this point;
           original template message still carries the Edit URL button.)
       - Mark inbound_events status='failed' (reclaim retries after 2min).
       - Return 503 so Fastify logs the error.

  6. Success-only visible confirmation (free-form inside auto-established
     24h session from the button tap):
        approve:    sendFreeform("✅ Response approved — we'll post it shortly.")
        regenerate: sendFreeform("🔄 Regenerating — a new draft will follow shortly.")
     Send failures (429, session closed) are logged, NOT retried. The approval
     transaction has already committed; losing the confirmation is cosmetic.

  7. Mark inbound_events processed_at = NOW(), return 200.
```

**Path C — Status callback (`POST /ingress/twilio/whatsapp-status`):**

Same shape as the existing SMS status handler in `worker/ingress/twilio.ts` (lines 42-138). Verify signature, dedup on `(MessageSid, MessageStatus)`, branch on terminal vs intermediate, update `notification_deliveries.delivered_at` / `failed_at` with `AND channel = 'whatsapp'` discriminator. The first-wins race guard, delivery-row-not-yet-present reclaim, and unknown-status tolerance all copy verbatim.

### 1.2 Outbound (`WhatsAppChannel.sendApprovalRequest`)

```
Input: SendApprovalParams {
  handle (plain E.164, e.g. '+15551234567'),
  businessName, reviewerName, starRating, reviewText, reviewDate,
  responsePreview, approvalUrl, approvalLinkId
}

1. { contentSid, contentVariables } = formatApprovalWhatsApp(params)
     9 variables (§3.1):
       "1": businessName
       "2": reviewerName
       "3": String(starRating)
       "4": reviewDate
       "5": truncate(reviewText ?? '(no comment)', 400)
       "6": truncate(responsePreview, 400)
       "7": `a:${approvalLinkId}`         -- quick_reply[0] payload
       "8": `r:${approvalLinkId}`         -- quick_reply[1] payload
       "9": extractTokenFromApprovalUrl(approvalUrl)  -- URL button suffix

2. twilioClient.messages.create({
     from: process.env.TWILIO_WHATSAPP_NUMBER,                 // 'whatsapp:+1…'
     to: `whatsapp:${handle}`,
     contentSid: process.env.WHATSAPP_APPROVAL_TEMPLATE_SID,
     contentVariables: JSON.stringify(contentVariables),
     statusCallback: `${process.env.WORKER_PUBLIC_URL}/ingress/twilio/whatsapp-status`,
   })

3. Twilio SDK constructed with explicit timeout + no auto-retry:

       twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
              { timeout: 10_000, autoRetry: false })

   Matches Telegram client posture. WA ingress does inline free-form confirmation
   sends; an unbounded hang would stall ingress processing.

4. Error classification (OWNER-INTENT vs CONFIG-ERROR split — see §4.3):

   OWNER-INTENT (enrollment state must change, owner has expressed a signal):
     Twilio 63014 | 63033       → throw WhatsAppRecipientBlockedError
                                   (owner blocked the business / Meta opt-out)
     Twilio 63024 | 21211 | 21408 → throw WhatsAppInvalidRecipientError
                                   (handle is not a valid WA number or never was)

   CONFIG-ERROR (RepWorth-side problem, enrollment unchanged — admin alert):
     Twilio 63040 | 63041 | 63042 | 63027 | 63028
                                → throw WhatsAppTemplateConfigError
                                   (template paused, disabled, missing, or
                                    variables mismatch — OUR problem, not owner)
     Twilio 63016              → throw WhatsAppSessionWindowError
                                   (outside 24h freeform window AND no template
                                    used — should never happen for approval
                                    sends since we always use a template;
                                    indicates a bug)

   TRANSIENT:
     HTTP 429 | Twilio 63017 | 63018 → throw WhatsAppRateLimitError(retry_after)
     AbortError / ETIMEDOUT          → throw WhatsAppTimeoutError
     Other 4xx/5xx                   → throw WhatsAppApiError(code, message)

   Success → { externalMessageId: msg.sid }
```

**⚠️ CONFIRM TWILIO ERROR CODES before implementation.** Twilio revises its WhatsApp error-code reference periodically (e.g. 63015 was documented as "sandbox-only" in some older references). The mapping above is the working spec; an implementation-time verification against the current Twilio WhatsApp error-code page (https://www.twilio.com/docs/api/errors and https://www.twilio.com/docs/whatsapp/api) is required before writing `whatsapp-client.ts`, and any correction feeds back into §4.3 dispatcher branches below. Unknown codes fall through to `WhatsAppApiError` and are surfaced in logs for forensics.

Dispatcher splits handling by class (§4.3):
- **Owner-intent errors** → flip enrollment (`unsubscribed` or `disabled`) with handle-scoped guard, record `failed_at + failure_reason`.
- **Config errors** → enrollment UNCHANGED, record `failed_at + failure_reason`, existing `NotificationFailoverPoller.all_deliveries_failed` branch alerts admin via email if all channels fail.
- **Transient errors** → record `failed_at`, dispatcher continues to the next channel.

---

## 2. File-level breakdown

### 2.0 Implementation sequencing constraints

**Two rules the writing-plans step must honor:**

1. **The `CallbackAuditContext` widening is its own first patch.** The type change in `src/lib/approval/service.ts:443` (`updateId: number` → `providerEventId: string + telegramUpdateId?: number + twilioMessageSid?: string`), the matching update to `buildCallbackAudit` metadata writes, the two Telegram caller updates at `worker/ingress/telegram.ts:300,311`, and the Telegram approval test fixture updates MUST land as a single atomic commit BEFORE any WhatsApp channel/ingress/admin code. A partial state — new type with old Telegram callers, or vice versa — breaks Telegram approvals at build OR runtime. Phase 2 is in production; this refactor must be invisible to end users.

2. **WhatsApp channel + client modules are side-effect-free at import.** `whatsapp-channel.ts`, `whatsapp-client.ts`, `whatsapp-body.ts`: no top-level `new twilio(...)` client construction, no `process.env` validation, no network calls, no module-scoped singletons that touch Twilio. Env vars are read INSIDE `sendApprovalRequest` / `sendFreeform` (lazy), and config assertion is the sole job of `worker/startup-assert.ts::assertChannelsWhatsAppEnv()`. This keeps factory gating at `src/lib/notifications/channels/index.ts:25` effective — a build or test that imports the module with the flag off or env unset must not crash. Mirrors the existing Telegram module shape (`telegram-channel.ts` constructs `new TelegramClient()` inside `sendApprovalRequest`, not at module scope).

### 2.0.1 File removed from original plan

`src/lib/notifications/channels/whatsapp-env.ts` is **not** a new file. The startup assertion belongs alongside the existing SMS + Telegram assertions in `worker/startup-assert.ts`. Admin route env readiness stays in `src/app/api/admin/channels/whatsapp/_shared.ts::assertWhatsAppEnvReady()` (returns 503 NextResponse) — two distinct concerns.

### 2.0.2 Additional deliverable — `docs/whatsapp-templates.md`

The exact Twilio Content Builder JSON for the approval-request template (`repworth_approval_request_v1`, `twilio/card` type, 2 quick-reply + 1 URL button, 9 body variables per §3.1) is a **pre-ship prerequisite**, not a parallel task. The file does NOT exist yet and must be produced before the WhatsApp send-path code lands — otherwise the template shape that `formatApprovalWhatsApp` produces has no authoritative reference to diff against during Meta submission / resubmission.

The plan schedules this as a dedicated task early in the implementation sequence: after the Twilio error-code verification (Appendix B #4) and before `whatsapp-body.ts` is written. Contents: full submission JSON, variable map with types + maxlen, button payload templating, Meta category rationale, a "what triggers resubmission" checklist.

### 2.1 New files

| Path | Purpose |
|------|---------|
| `src/lib/notifications/channels/whatsapp-channel.ts` | `class WhatsAppChannel implements NotificationChannel` — `supportsInlineActions=true`, `requiresOptInHandshake=true`. Delegates network I/O to `whatsapp-client.ts`; delegates body shaping to `whatsapp-body.ts`. |
| `src/lib/notifications/channels/whatsapp-client.ts` | Thin wrapper around the existing `twilio` SDK dep. Methods: `sendTemplate({ to, contentSid, contentVariables, statusCallback })`, `sendFreeform({ to, body })`. Twilio client constructed with `{ timeout: 10_000, autoRetry: false }` to bound inline ingress sends. Error classification per §1.2 (owner-intent vs config-error vs transient split). |
| `src/lib/notifications/channels/whatsapp-body.ts` | Pure functions: `formatApprovalWhatsApp(params) → { contentSid, contentVariables }`, `extractTokenFromApprovalUrl(url)` (implemented via `new URL(url).pathname.split('/').filter(Boolean).at(-1)` with empty/malformed URL rejection, NOT a naive `split('/').pop()`), `stripWaPrefix(From)`, `toWaRecipient(handle)`, `truncate(text, limit)`. All unit-testable with no Twilio dependency. |
| `worker/ingress/twilio-intent.ts` | NEW — extracts `STOP_KEYWORDS`, `START_KEYWORDS`, `classifyIntent` from `worker/ingress/twilio.ts` (currently file-local at lines 150-173). Both SMS and WA ingress import from here. The extraction is a pure move of consts/function; zero behavior change. See §2.2 for the matching `twilio.ts` modification (replace local defs with `import from './twilio-intent'`). |
| `worker/ingress/twilio-whatsapp.ts` | Fastify handlers `handleTwilioWhatsAppInbound` (at `/ingress/twilio/whatsapp-inbound`) + `handleTwilioWhatsAppStatus` (at `/ingress/twilio/whatsapp-status`). Uses `verifyTwilioSignature` + `claimInboundEvent('twilio', …)` unchanged, imports `classifyIntent` from the new `twilio-intent.ts`. Separate file from `worker/ingress/twilio.ts` so SMS regression risk is nil. |
| `src/app/api/admin/channels/whatsapp/_shared.ts` | Mirrors the telegram + sms `_shared.ts` pattern. Exports `isWhatsAppEnabled()`, `flagOff()` (404), `assertWhatsAppEnvReady()` (503 when flag on + env incomplete; null when ready; bypass in `MOCK_EXTERNAL_APIS=true`). |
| `src/app/api/admin/channels/whatsapp/start/route.ts` | `POST` — admin-authed. Handler order: flag → env → auth → businessId → subscription → advisory lock → state-machine upsert (§4.1). Returns `{ deepLink, qrDataUrl, expiresAt }` with `Cache-Control: no-store, private` (the body carries the raw one-time token). |
| `src/app/api/admin/channels/whatsapp/cancel/route.ts` | `POST` — clears `verification_token_hash` + expiry on `pending_verification` row. Idempotent. |
| `src/app/api/admin/channels/whatsapp/disable/route.ts` | `POST` — sets `status='disabled', disabled_at=NOW()` on `verified` row. Admin safety valve. |
| `src/components/admin/WhatsAppEnrollmentWidget.tsx` | Client component, 8-state UI (§4.2), 3s polling during `awaiting_scan`, 1h TTL countdown, masked handle display. Structurally copies `TelegramEnrollmentWidget` with WA-specific labels + error codes. |
| `docs/whatsapp-templates.md` | Pre-ship prerequisite per §2.0.2. Full Twilio Content Builder JSON for `repworth_approval_request_v1` (`twilio/card` type, 2 quick-reply + 1 URL button, 9 body variables per §3.1), variable map with types + max-lengths, button payload templating, Meta UTILITY category rationale, and a "what triggers resubmission" checklist. Referenced by `formatApprovalWhatsApp` during implementation and by the launch runbook during Meta submission. |

### 2.2 Modified files

| Path | Change |
|------|--------|
| `src/lib/notifications/channels/index.ts` | Remove `'whatsapp'` from `NOT_YET_IMPLEMENTED`. Add gated branch: `if (id === 'whatsapp') { if (env !== 'true') throw; return new WhatsAppChannel(); }` mirroring the telegram branch. Export `WhatsAppRecipientBlockedError`, `WhatsAppInvalidRecipientError`, `WhatsAppTemplateConfigError`, `WhatsAppSessionWindowError`, `WhatsAppRateLimitError`, `WhatsAppTimeoutError`, `WhatsAppApiError`. |
| `worker/jobs/NotificationWorker.ts` | (a) Flag-skip branch parallel to SMS/Telegram at lines 123/128. (b) Error branches per §4.3, split owner-intent (enrollment flip) vs config (enrollment unchanged, admin alert via failover path) vs transient (failed_at only). All enrollment-flipping branches include handle-scoped `UPDATE … WHERE handle = ${enrollment.handle} AND archived_at IS NULL` guard. (c) No cost-guard integration — WA bypasses the SMS try/finally block. |
| `worker/index.ts` | Register `POST /ingress/twilio/whatsapp-inbound` and `POST /ingress/twilio/whatsapp-status`. The WA startup assertion lives in `worker/startup-assert.ts` (see that file's row below), not in a new module. |
| `worker/startup-assert.ts` | Add `assertChannelsWhatsAppEnv()` alongside the existing `assertChannelsSmsEnv()` / `assertChannelsTelegramEnv()`. **Self-contained — does NOT depend on `assertChannelsSmsEnv` for shared Twilio vars.** `assertChannelsSmsEnv` early-returns when `CHANNELS_SMS_ENABLED !== 'true'` (line 14 of current file), so a WA-on / SMS-off deployment would otherwise boot with unverified Twilio config. Enforces (when `CHANNELS_WHATSAPP_ENABLED='true'`, bypassed in `MOCK_EXTERNAL_APIS`): <br><br>**Presence check:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`, `WHATSAPP_APPROVAL_TEMPLATE_SID`, `WHATSAPP_APPROVAL_URL_BASE`, `WORKER_PUBLIC_URL`, `NEXT_PUBLIC_APP_URL` are all non-empty.<br><br>**Format check** on `TWILIO_WHATSAPP_NUMBER` — must match `/^whatsapp:\+\d{7,15}$/`. Catches the common misconfiguration where an operator sets `+15551234567` (missing `whatsapp:` prefix) or `15551234567` (no prefix at all); otherwise the typo surfaces as an opaque Twilio error at first customer-visible send. Error message reveals the expected pattern, not the actual value (avoid logging the sender number even in a boot error).<br><br>**URL-base equality check:** `WHATSAPP_APPROVAL_URL_BASE === NEXT_PUBLIC_APP_URL.replace(/\/$/, '') + '/approve/'` (the Meta-approved URL base in the template MUST match what the dispatcher builds — otherwise staging/local sends URLs the template doesn't point at). |
| `src/lib/approval/service.ts` | **Widen `CallbackAuditContext`** (line 443) from `{ updateId: number; ipAddress: string \| null }` to `{ providerEventId: string; ipAddress: string \| null; telegramUpdateId?: number; twilioMessageSid?: string }`. **Metadata JSONB keys are preserved across providers** — Telegram rows keep writing the existing `update_id` key (so in-flight forensics queries continue to work); WhatsApp rows write a new `message_sid` key. `buildCallbackAudit` (line 475) becomes:<br><br>`metadata = { via_channel, chat_handle_hash, correlation_id, ...(audit.telegramUpdateId !== undefined && { update_id: audit.telegramUpdateId }), ...(audit.twilioMessageSid !== undefined && { message_sid: audit.twilioMessageSid }) }`<br><br>Existing Telegram callers at `worker/ingress/telegram.ts:304,311` updated to pass `{ providerEventId: String(update.update_id), telegramUpdateId: update.update_id, ipAddress }`. The dynamic action string `approved_via_${input.viaChannel}` at service.ts line 529 already handles WhatsApp automatically — no switch-statement change needed. Existing `auth_method='token'` CHECK constraint and link-state error classes (`ConsumedLinkError` / `RevokedLinkError` / `ExpiredLinkError` / `ChannelMismatchError`) are channel-agnostic and stay as-is. No historical Telegram audit rows (stored `update_id`) become unqueryable. |
| `src/app/api/admin/businesses/[id]/route.ts` | Add `whatsappEnabled: process.env.CHANNELS_WHATSAPP_ENABLED === 'true'` to response JSON. |
| `src/app/admin/businesses/[id]/page.tsx` | Flag-gate on `business.whatsappEnabled`, render `<WhatsAppEnrollmentWidget businessId={business.id} />` in the Channels section. |
| `src/lib/notifications/channels/__tests__/factory.test.ts` | Remove the "whatsapp throws not-yet-implemented" assertion; add "whatsapp throws when flag off" + "whatsapp returns WhatsAppChannel when flag on" (mirrors telegram tests). |
| `src/lib/notifications/channels/__tests__/email-channel.test.ts` | Remove the `getChannel('whatsapp')` not-yet-implemented assertion. |
| `.env.example` | New "Channels — WhatsApp" section: `CHANNELS_WHATSAPP_ENABLED=false`, `TWILIO_WHATSAPP_NUMBER=`, `WHATSAPP_APPROVAL_TEMPLATE_SID=`, `WHATSAPP_APPROVAL_URL_BASE=`. Note that `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `WORKER_PUBLIC_URL`, `NEXT_PUBLIC_APP_URL` are reused from SMS + shared sections, but `assertChannelsWhatsAppEnv()` verifies them independently (does NOT rely on SMS being enabled). |
| `.claude/CLAUDE.md` | Status update: Phase 3 WhatsApp code-complete, flag-gated off. Add 3 env vars to "Feature flags / non-obvious env vars". Note zero-migration posture in "Migrations" section. |
| `docs/adding-communication-channels.md` §5.1 Phase 3 | Add scope-amendment note: "Phase 3 ship gate narrowed to admin business-detail page only, matching Phase 2 precedent; owner dashboard bundled into Phase 4." |
| `worker/ingress/twilio.ts` | Pure refactor: replace the local `STOP_KEYWORDS` / `START_KEYWORDS` consts (lines 150-154) and `classifyIntent` function (lines 159-173) with `import { classifyIntent, STOP_KEYWORDS, START_KEYWORDS } from './twilio-intent'`. Zero behavior change; existing `worker/ingress/__tests__/twilio-inbound.test.ts` fixtures continue to pass unchanged. This is the paired modification for the new file in §2.1. |

### 2.3 Shared / untouched (zero regression surface)

- `worker/ingress/shared.ts` — `claimInboundEvent` reused as-is.
- `worker/ingress/twilio-verify.ts` — signature verifier reused as-is.
- `worker/ingress/twilio.ts` — SMS handler functions untouched; only import statements change (see §2.2 row for the pure-refactor detail). No logic or signature modifications. Regression-risk-minimizing reason for putting WA in a separate file.
- `src/lib/approval/correlation.ts` — `recoverCorrelationId` already channel-agnostic.
- `src/lib/approval/errors.ts` — the four link-state errors are channel-agnostic; no new classes.
- `worker/jobs/NotificationFailoverPoller.ts` — channel-agnostic stale branch + all-failed branch; unchanged.
- `src/lib/notifications/delivery.ts` — `recordNotificationDelivery` already accepts `channel: ChannelId`; unchanged.

### 2.4 `start` endpoint upsert semantics (§4.1)

Single entry for all enrollment transitions. Branches on the current state of the `channel_enrollments` row (looked up under the partial unique index `(business_id, channel) WHERE archived_at IS NULL`):

| Current state | Action |
|---|---|
| No row | INSERT new row with `status='pending_verification'`, fresh hash + 1h expiry |
| `pending_verification` (hash live or expired) | UPDATE — overwrite hash + expiry; reset `updated_at` |
| `unsubscribed` | UPDATE to `pending_verification`, clear `unsubscribed_at`/`unsubscribed_reason`, clear `handle`, fresh hash + expiry |
| `disabled` | Same as `unsubscribed` — reset to `pending_verification` with fresh token |
| `verified` | Reject with 409 `"already_verified"` — admin must disable first |

No separate "delete" or "re-enable" endpoint. `cancel` clears the current verification attempt; `disable` is the admin kill-switch; `start` handles re-enrollment by upsert.

---

## 3. Template contract + Security

### 3.1 Template submitted to Meta

Single UTILITY-category template, produced by Twilio Content Editor → `WHATSAPP_APPROVAL_TEMPLATE_SID`. Body and button structure fixed at submission; only variable values change per send.

**Twilio Content Builder type:** `twilio/card` (the card-style type that supports body text + 2 quick-reply buttons + 1 URL call-to-action button in a single template). A plain `twilio/quick-reply` template only models quick replies and cannot carry the URL "Edit" button; a `twilio/call-to-action` template carries URL + phone buttons but not quick replies. The exact JSON schema for `twilio/card` submission lives in a new `docs/whatsapp-templates.md` that is a **pre-ship prerequisite** (see §2.0.2) — it must be authored before `whatsapp-body.ts` is written, not after. The `WHATSAPP_APPROVAL_TEMPLATE_SID` env var points at whatever Twilio assigns on submission.

**⚠️ Verify current Twilio Content Builder type** against https://www.twilio.com/docs/content-api/content-types-overview before submission — Twilio has been iterating on WhatsApp-specific content types (`whatsapp/card`, `whatsapp/authentication`, etc.) and the canonical type for "body + 2 quick-reply + 1 URL" may have been renamed since this spec was written.

**Name:** `repworth_approval_request_v1` — `_v1` suffix reserves room for versioned re-submits without breaking existing template SID bindings during migration.

**Body (9 `{{n}}` variables):**

```
New ⭐{{3}} review for {{1}}

From: {{2}} · {{4}}

"{{5}}"

Draft reply:
{{6}}
```

**Variable map:**

| # | Content | Notes |
|---|---------|-------|
| 1 | `businessName` | Plain text |
| 2 | `reviewerName` | Plain text |
| 3 | `starRating` as string `"1"`–`"5"` | WA templates require string variables |
| 4 | `reviewDate` | Short format `"Apr 18"` |
| 5 | Review text, truncated to 400 chars | Null-safe: `"(no comment)"` if absent |
| 6 | Response preview, truncated to 400 chars | |
| 7 | `a:<approvalLinkId>` | quick_reply[0] payload |
| 8 | `r:<approvalLinkId>` | quick_reply[1] payload |
| 9 | `<rawApprovalToken>` | URL button suffix — concatenated onto Meta-approved base `https://app.repworth.com/approve/` |

**Buttons (3 total):**

```
[Quick Reply] "Approve"            payload={{7}}  → delivered as ButtonPayload="a:<linkId>"
[Quick Reply] "Regenerate"         payload={{8}}  → delivered as ButtonPayload="r:<linkId>"
[URL]         "Edit / view full"   url=https://app.repworth.com/approve/{{9}}
```

**Category:** UTILITY (transactional notification, not promotional).

**Meta approval blast radius:** any edit to body text, button labels, button count, or URL base triggers a fresh review cycle. Variable values are NOT reviewed per send.

### 3.2 What the contract commits us to in code

- `formatApprovalWhatsApp` produces exactly 9 variables in this order. Any template change → bump to `_v2` and add a parallel formatter keyed by template SID; both versions coexist during migration.
- `extractTokenFromApprovalUrl(url)` parses the raw token from the dispatcher-constructed approval URL using a real URL parser — `new URL(url).pathname.split('/').filter(Boolean).at(-1)` — and rejects empty / malformed / trailing-slash / query-string-corrupted inputs by throwing. Do NOT use a naive `url.split('/').pop()` which silently accepts all of those edge cases. Unit-tested against: plain URL, trailing slash, query string appended, URL without `/approve/` segment, empty string, non-URL garbage.
- URL base domain change → template resubmit. Flagged in risks.

### 3.3 Four invariants enforced on every button tap

1. **Provider signature.** `verifyTwilioSignature(x-twilio-signature, fullUrl, params)` — reuses the exact helper SMS uses. Fail → 401, zero DB side-effect.
2. **Approval-link liveness + channel binding.** `SELECT … WHERE id=$1 AND channel='whatsapp' AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > NOW()`. A link id from another channel submitted to `/whatsapp-inbound` is rejected by the `channel` clause.
3. **Sender-handle binding.** `stripWaPrefix(From)` (Twilio-authenticated via signature) must equal a `'verified'` `channel_enrollments.handle` row for the same `business_id + channel='whatsapp' AND archived_at IS NULL`. Blocks forwarded-template replay, leaked-ButtonPayload misuse from another WhatsApp account, AND re-use of a soft-deleted (archived) enrollment handle that might still satisfy the `(business_id, channel, handle)` tuple before the partial unique index prunes it.
4. **Dedup.** `claimInboundEvent('twilio', dedupKey=MessageSid, eventType, payload=redacted)`. Twilio retries deliver the same `MessageSid`; second attempt no-ops 200.

Any failure terminates with an appropriate HTTP status and zero state mutation. Friendly text messages are UX feedback only — no authorization weight.

### 3.4 Payload redaction before `inbound_events` persist

`redactWhatsAppPayload(params)` strips sensitive / accidentally-sensitive fields before persistence:

- `Body` → `"[redacted]"` — same as SMS handler; keyword / token classification reads params BEFORE redaction.
- `ButtonPayload` → `"[redacted]"` — defense-in-depth; approval_link_id is non-secret but future template changes could accidentally introduce sensitive payload content.
- `ProfileName`, `WaId` — dropped; PII-reduction.
- Preserved for forensics: `From`, `MessageSid`, `MessagingServiceSid`, `OriginalRepliedMessageSid`.

Pure helper, unit-tested against fixtures.

### 3.5 Audit row shape (no migration)

Writes to `approval_audit_log` via the existing `insertAuditLog` helper in `src/lib/approval/service.ts`:

```
{
  id:                 uuidv7(),
  response_id:        link.response_id,
  business_id:        link.business_id,
  token_hash:         link.token_hash,                 -- loaded with FOR UPDATE row
  device_cookie_hash: NULL,                             -- no browser-side binding
  action:             'approved_via_whatsapp' | 'regenerated_via_whatsapp',
  ip_address:         request.ip,                       -- Twilio's IP; kept for forensics
  actor_user_id:      NULL,
  auth_method:        'token',                          -- within CHECK constraint
  metadata: {
    via_channel:      'whatsapp',
    chat_handle_hash: sha256(stripWaPrefix(From)),
    message_sid:      MessageSid,                       -- WhatsApp-specific key
    button_payload:   'a' | 'r',                        -- action char only
    correlation_id:   <recoverCorrelationId>            -- always set
    -- NOTE: the `update_id` key (used by Telegram rows) is NOT present on
    -- WhatsApp rows. `buildCallbackAudit` conditionally adds provider-specific
    -- keys (§2.2), so existing Telegram JSONB queries on `update_id` continue
    -- to work and new WhatsApp queries use `message_sid`. Never both.
  }
}
```

### 3.6 Raw-token locality

The raw approval token exists in exactly one place on the WA send path: `contentVariables.9`, passed to `twilio.messages.create`. Twilio substitutes it into the Meta-approved URL base; Meta renders the URL button with the full URL. Owner tap opens the browser → `/approve/<rawToken>` on the Next.js app, same code path as email.

**The token is never in `ButtonPayload`, never in `inbound_events.payload`, never in logs.** Preserves the invariant in `.claude/CLAUDE.md`: *"Raw tokens exist only in memory during generation and in the sent email."* WA send extends "sent email" to "sent email or WA URL button" — same semantic boundary.

---

## 4. Enrollment + Dispatcher integration

### 4.1 `/start` endpoint state machine

See §2.4.

**Response body:**

```json
{
  "deepLink": "https://wa.me/<digits>?text=start-<rawToken>",
  "qrDataUrl": "data:image/png;base64,...",
  "expiresAt": "2026-04-23T15:00:00.000Z"
}
```

**Deep link construction:**

```ts
const digits = process.env.TWILIO_WHATSAPP_NUMBER!.replace(/^whatsapp:\+?/, '');
const prefilled = encodeURIComponent(`start-${rawToken}`);
const deepLink = `https://wa.me/${digits}?text=${prefilled}`;
```

`wa.me` requires digits only (no `+`, no `whatsapp:`). QR is server-rendered via `qrcode` (already installed for Telegram). Raw token appears in the response body one time; never persisted except as SHA-256 hash.

Serialized under `pg_advisory_xact_lock(hash("whatsapp_enroll:<businessId>"))` to prevent concurrent admin clicks from racing the partial unique index.

**Subscription gate (inherited, intentional).** The `/start` handler rejects non-`'active'` businesses with 403, same as Phase 2 Telegram (`src/app/api/admin/channels/telegram/start/route.ts:52`). This means businesses in the 7-day `past_due` grace window cannot CREATE new WA enrollments through admin — but the dispatcher's `checkSubscription` helper still honors grace at send time for already-verified enrollments, so a business entering `past_due` after WA is verified continues to receive sends through the grace period. The asymmetry is deliberate: admin mutations during grace imply an upsell moment where payment should be collected first, while already-working notifications should degrade gracefully.

### 4.2 Widget UI states (`WhatsAppEnrollmentWidget.tsx`)

Polling target: **`GET /api/admin/businesses/[id]/channels`** (already exists at `src/app/api/admin/businesses/[id]/channels/route.ts`, returns `{ enrollments: [{ channel, handle, status, verified_at, disabled_at, unsubscribed_at, unsubscribed_reason, last_activity_at }] }` with masked handles). Widget filters `enrollments.find(e => e.channel === 'whatsapp')` to drive state. 3-second interval during `awaiting_scan`; stops once state reaches a terminal (`verified`, `disabled`, `unsubscribed`, `expired`, `error`).

Each row below is mutually exclusive and driven by a precise predicate on the polled enrollment row (call it `e`, undefined when no WA enrollment exists):

| State | Predicate | UI |
|---|---|---|
| `idle` | `e === undefined` (no WA row yet for this business) | Button: "Connect WhatsApp" |
| `generating` | Local UI state — POST `/start` in flight, no poll data yet | Spinner |
| `awaiting_scan` | `e.status === 'pending_verification'` AND local `expiresAt > now` | QR + copyable link + 1h countdown + "Cancel" |
| `expired` | `e.status === 'pending_verification'` AND local `expiresAt <= now` | "Link expired — regenerate" (calls `/start` again) |
| `verified` | `e.status === 'verified'` | Masked handle (`+15•••4567`) + "Disable" |
| `disabled` | `e.status === 'disabled'` | "Re-connect" button (calls `/start`) |
| `unsubscribed` | `e.status === 'unsubscribed'` | "Blocked by owner. Re-connect?" — same `/start` call, different copy |
| `error` | Poll rejected with 5xx, mutation route returned 503, or response shape unexpected | Red error box with Retry button |

**Polling error-code interpretation:**

- `200` with `enrollments` array → normal. Filter + set state per predicates above.
- `401 / 403` → admin session expired → redirect to login.
- `404` → **business-not-found** (unrecoverable; admin is viewing a deleted business). NOT flag-off — the `/channels` read endpoint is not flag-gated.
- `5xx` on GET → transient; set `error` state, retry on next interval.
- `5xx` / `503` on POST `/start`, `/cancel`, `/disable` → mutation-level env-not-ready or server error; set `error` state with banner ("WhatsApp not configured" for 503, generic for 5xx).

**Widget visibility** is controlled by the `whatsappEnabled: boolean` flag on the business-detail API response (`src/app/api/admin/businesses/[id]/route.ts`). When the server-authoritative flag is off, the widget is not rendered at all — admins don't see a Connect button they can't use.

### 4.3 Dispatcher changes — `worker/jobs/NotificationWorker.ts`

**(a) Flag-skip** — parallel to SMS/Telegram at lines 123/128:

```ts
if (channelId === 'whatsapp' && process.env.CHANNELS_WHATSAPP_ENABLED !== 'true') {
  logger.log(`Skipping whatsapp send for business ${business_id} — flag off`);
  continue;
}
```

**(b) Error branches** — parallel to Telegram's at lines 254-283, but split into three classes (see §1.2):

**OWNER-INTENT (enrollment state must change):**
- `WhatsAppRecipientBlockedError` → `status='unsubscribed'`, reason `whatsapp_blocked`
- `WhatsAppInvalidRecipientError` → `status='disabled'`

Both with `AND handle = ${enrollment.handle} AND archived_at IS NULL` guard and `COALESCE` pattern so re-enrolled handles aren't stomped by stale in-flight errors. Also records a `failed_delivery` row with the matching `failure_reason`.

**CONFIG-ERROR (enrollment UNCHANGED — RepWorth-side problem, not owner intent):**
- `WhatsAppTemplateConfigError` → log at `error` level with full Twilio code, `failed_delivery` row with `failure_reason='whatsapp_template_config:<code>'`, enrollment stays `verified`. Rationale: template paused / disabled / variable-mismatch is OUR ops failure. Flipping the owner to `unsubscribed` would suppress notifications indefinitely AND send a misleading signal to the admin widget ("owner blocked us") when in fact the template is broken. The existing `NotificationFailoverPoller.all_deliveries_failed` branch will alert the admin by email if WA + every other channel also fail.
- `WhatsAppSessionWindowError` → same treatment as `WhatsAppTemplateConfigError`. Should not occur on the template send path (we always pass `contentSid`); if it does, it indicates a dispatcher bug — log loudly, don't mutate enrollment.

**TRANSIENT:**
- `WhatsAppRateLimitError` → `failed_delivery` row with `failure_reason='whatsapp_rate_limit:<retry_after>'` (the retry_after value is recorded for forensics but NOT applied as a per-job delay); continue to next channel. Enrollment unchanged. **Retry is handled by BullMQ's existing queue-level exponential backoff** (3 attempts, 5s initial, exponential — configured in `worker/queues.ts:57-60` via `defaultJobOptions`). Phase 3 does NOT introduce a per-error retry_after mechanism: implementing honor-retry-after would require re-scheduling the job via BullMQ `moveToDelayed(retry_after_ms)` inside the worker, which is a cross-channel infrastructure change out of scope for this phase. If WA rate limits become a real problem, a follow-up spec can generalize this across channels.
- `WhatsAppTimeoutError` → `failed_delivery` row, continue to next channel. Enrollment unchanged. Retry via existing BullMQ backoff.
- `WhatsAppApiError` (catch-all) → `failed_delivery` row, continue to next channel. Enrollment unchanged. Retry via existing BullMQ backoff.

**(c) No cost guard** — WA bypasses the SMS try/finally at lines 163-166/309-310.

### 4.4 Opt-out handling on `/ingress/twilio/whatsapp-inbound`

- **Inbound block event** (Meta-native) → surfaces as Twilio owner-intent error on next send (63014/63033 per §1.2) → handled by dispatcher (b) above.
- **Explicit STOP keyword inside session** → `classifyIntent` (imported from `worker/ingress/twilio-intent.ts`) flips enrollment to `unsubscribed` with reason `whatsapp_stop`. UPDATE is handle-scoped AND `archived_at IS NULL`-scoped to avoid mutating soft-deleted rows.
- **START keyword ignored** — re-enrollment goes through admin `/start` route; matches SMS §4.4 TCPA-style policy.

No `sms_sender_opt_outs` parallel write. That table exists for Messaging-Service-scoped SMS opt-out tracking, which WA doesn't need.

### 4.5 Failure-mode summary

| Scenario | Code path | DB effect | UX |
|---|---|---|---|
| Approve tap, all OK | approveViaCallback → commit → confirmation sendFreeform | Response → `approved`, link consumed, siblings revoked | "✅ Response approved — we'll post it shortly" |
| Approve tap, another channel won (link consumed) | `ConsumedLinkError` / `RevokedLinkError` | None | "This reply was just handled on another channel." |
| Approve tap, response already approved via different path (e.g. email, dashboard) | `ResponseNotPendingError` (classified permanent) | None | "This reply was just handled on another channel." — identical to consumed-link UX; prevents spam via dedup-reclaim loop |
| Approve tap after link expired | `ExpiredLinkError` | None | "This approval link has expired — a new draft will arrive on the next review." |
| Template send to blocked user / opted-out at Meta | `WhatsAppRecipientBlockedError` (63014/63033) | Enrollment → `unsubscribed`, reason `whatsapp_blocked` | Owner sees nothing; admin widget reflects on next poll |
| Template send to invalid/non-WA number | `WhatsAppInvalidRecipientError` (63024/21211/21408) | Enrollment → `disabled` | Admin widget surfaces "disabled — invalid number" |
| Template paused / disabled / config-broken on Meta side | `WhatsAppTemplateConfigError` (63040-42/63027-28) | Enrollment UNCHANGED; failed_delivery row | Admin alerted via `NotificationFailoverPoller.all_deliveries_failed` if WA + every other channel also fail; owner's enrollment not falsely unsubscribed |
| Unexpected session-window mismatch (dispatcher bug) | `WhatsAppSessionWindowError` (63016) | Enrollment UNCHANGED; failed_delivery row; loud error log | Same as above — RepWorth ops concern, not owner-intent |
| Signature mismatch inbound | 401 before state touch | None | Silent |
| Crash between approve commit and confirmation send | Approval committed; confirmation failed | Response state correct | Owner sees no confirmation; draft posts normally via publisher |

---

## 5. Ship gate + Risks + Testing

### 5.1 Ship gate (deferred post-merge)

Judged against a real Twilio WA sender + approved template on one pilot business:

1. Webhook registration — Twilio console points inbound + status webhooks at `WORKER_PUBLIC_URL/ingress/twilio/whatsapp-{inbound,status}`; signature verifies on every request.
2. Click-to-chat enrollment — admin Connect → QR scan → WhatsApp opens pre-filled `start-<token>` → owner taps Send → widget flips `verified` within 3s.
3. Approve round-trip — template → Approve button → `approveViaCallback` commits → "✅ approved" free-form confirmation lands.
4. Regenerate round-trip — Regenerate button → regen outbox entry → new approval template arrives as a NEW message with fresh buttons.
5. Blocked-recipient handling — owner blocks business → next send → owner-intent error code per §1.2 (63014/63033) → enrollment `unsubscribed` (whatsapp_blocked) → widget reflects.
6. Re-enrollment — owner unblocks → admin Re-connect → state machine `unsubscribed → pending_verification → verified` with fresh token.
7. Cross-channel race — email-approve first → WA tap shows "This reply was just handled on another channel".
8. STOP inside session — owner replies STOP → enrollment `unsubscribed` (whatsapp_stop); next approval skips WA.

Until all eight pass, `CHANNELS_WHATSAPP_ENABLED=false` in production.

### 5.2 Risks + mitigations

| Risk | Mitigation |
|---|---|
| Meta Business verification blocks launch indefinitely | Code ships flag-gated off, zero surface area when flag off (factory 404s, dispatcher skips, widget hidden). Email + SMS + Telegram customers unaffected — same pattern SMS used with 10DLC. |
| Meta rejects 3-button UTILITY template | Template shape lives on Meta's side keyed by `WHATSAPP_APPROVAL_TEMPLATE_SID`. Fallback shape (2 quick-reply + URL in body text, or URL-only) is a template edit only, zero code change. Code defensively populates superset of contentVariables. |
| Template wording edit restarts Meta review clock | Runbook enforces: all copy decisions finalized before submission. `_v1` naming reserves room for versioned re-submits without breaking SID bindings. |
| URL base domain change invalidates template | Versioned-template strategy. Rare enough to accept resubmit. |
| Staging / local environment sends URLs the production-approved template doesn't point at | `WHATSAPP_APPROVAL_URL_BASE` env var + `worker/startup-assert.ts` equality check against `NEXT_PUBLIC_APP_URL`. Worker startup refuses to boot if mismatched. Means each environment either uses its OWN Meta-approved template SID or runs with the flag off. |
| Config errors (template paused/disabled) falsely flip owner to `unsubscribed` | Dispatcher error classification (§4.3 b) separates owner-intent from config-error. Only 63014/63033/63024/21211/21408 mutate enrollment. |
| URL token extraction via naive `split('/').pop()` silently accepts malformed approval URLs | `extractTokenFromApprovalUrl` implemented via `new URL(url).pathname.split('/').filter(Boolean).at(-1)` with empty/malformed URL throw. Unit-tested against edge cases (trailing slash, query string, missing path). |
| Twilio error code semantics change | Classification in `whatsapp-client.ts` is tightly scoped per §1.2 (owner-intent: 63014/63033/63024/21211/21408; config: 63040-42/63027-28/63016; transient: 63017/63018/429). Unknown codes fall through to `WhatsAppApiError` → `failed_at + failure_reason`, no enrollment mutation. Logging surfaces for forensics. Implementation verifies current Twilio docs before coding (Appendix B #4). |
| Forwarded template replay | Blocked by invariant #3 (sender-handle binding). `From` must match verified enrollment handle. |
| Inbound ButtonPayload replay after consumption | Blocked by invariant #2 (link liveness). Second tap sees `ConsumedLinkError` → friendly message. |
| 24h session closes between approval tap and confirmation send | Tap resets session; if it fails anyway, we log + move on — approval already committed. |
| WA routes to spam | Meta-approved UTILITY template + click-to-chat opt-in signal. No marketing content. |
| Ingress extension accidentally breaks SMS | New handlers in separate `worker/ingress/twilio-whatsapp.ts`; zero touch to existing Twilio file; SMS route tests remain regression safety net. |

### 5.3 Testing strategy

**Unit (Vitest, new files):**
- `whatsapp-body.ts` — formatter golden fixtures, 9-variable output, null-safe reviewText, 400-char truncation, token extraction, handle prefix strip/add.
- `whatsapp-client.ts` — error classification for each Twilio code via mocked `twilio.messages.create` rejections. **Anti-regression assertion:** every error-path test spies on `console.log` / `console.error` / `console.warn` and asserts none of their call arguments contain a substring of the raw token used in the fixture. This protects the `.claude/CLAUDE.md` raw-token invariant against a future patch that accidentally `console.error(err)`s a full Twilio request object (which carries `contentVariables[9]` = raw token).
- `whatsapp-channel.ts` — happy path + each error class propagates.
- `twilio-whatsapp.ts` ingress — signature failure, malformed ButtonPayload, dedup replay, permanent-link-state errors → processed, unexpected error → failed.
- `/api/admin/channels/whatsapp/_shared.ts` — flag-off 404, env-not-ready 503, `MOCK_EXTERNAL_APIS` bypass.
- Each admin route — auth failure, subscription-not-active 403, state machine transitions, advisory lock serialization, 409 on already-verified.

**Integration (Vitest + real Supabase pool):**
- Outbox → `NotificationWorker` → `WhatsAppChannel` with mocked Twilio — approval_link created with `channel='whatsapp'`, delivery row inserted, external_message_id threaded through.
- Replay outbox entry twice → zero duplicate sends, zero duplicate links.
- Multi-channel fan-out — email + telegram + whatsapp; telegram failure doesn't block WA; WA blocked-error flips WA only.
- Cross-channel race — email-approve vs WA-approve in same tick → one wins, other sees `ConsumedLinkError`, audit rows correct.
- Enrollment end-to-end — `POST /start` → simulate `/ingress/twilio/whatsapp-inbound` with `start-<token>` → widget polls → verified → business detail API reflects whatsapp in channels.
- STOP during session → enrollment `unsubscribed` (whatsapp_stop); next send skips WA.
- Signature forgery → 401, no state change.
- **Dispatcher owner-intent branch** — `WhatsAppRecipientBlockedError` (mocked Twilio 63014 rejection): seed enrollment in `verified`; run NotificationWorker; assert post-state `status='unsubscribed'`, `unsubscribed_reason='whatsapp_blocked'`, AND a `notification_deliveries` row with `failed_at IS NOT NULL` + `failure_reason='whatsapp_blocked'`. Same test with `WhatsAppInvalidRecipientError` asserting `status='disabled'`.
- **Dispatcher config-error branch (critical regression guard)** — `WhatsAppTemplateConfigError` (mocked Twilio 63040 rejection): seed enrollment in `verified`; run NotificationWorker; assert post-state `status='verified'` UNCHANGED, `unsubscribed_at IS NULL`, `disabled_at IS NULL`, AND a `notification_deliveries` row with `failure_reason` matching `/^whatsapp_template_config:/`. This is the single most important test in Phase 3: it fails loudly if a future patch ever widens the owner-intent branch to swallow config errors, which would silently unsubscribe customers.

**E2E (Playwright):**
- Admin business-detail page — Connect WhatsApp → QR renders → simulated inbound Twilio webhook → widget verified → Disable → idle.

**NOT automated:**
- Real Twilio WA sender round-trip. Matches parent spec §5.3 — deferred to manual ship-gate walkthrough on pilot business.

### 5.4 Launch runbook additions

`.claude/CLAUDE.md` "Current status" + `/admin/runbook` get:

- Meta Business verification procedure (WABA creation, business profile, sender provisioning).
- Twilio Content Template Editor submission for `repworth_approval_request_v1` with exact body copy + button labels documented verbatim so future resubmits don't drift.
- Webhook URL pinning: `WORKER_PUBLIC_URL/ingress/twilio/whatsapp-inbound` + `WORKER_PUBLIC_URL/ingress/twilio/whatsapp-status`.
- Flag-flip procedure: pilot business runs 3 approval round-trips successfully → `CHANNELS_WHATSAPP_ENABLED=true` in Railway + redeploy.

---

## Appendix A — Environment variables (summary)

New:

- `CHANNELS_WHATSAPP_ENABLED=false` — server-authoritative gate. Factory throws, dispatcher skips, admin routes 404, widget hidden when off.
- `TWILIO_WHATSAPP_NUMBER=whatsapp:+1…` — WA sender, required when flag on.
- `WHATSAPP_APPROVAL_TEMPLATE_SID=HX…` — Twilio Content SID for the approval-request template, required when flag on.
- `WHATSAPP_APPROVAL_URL_BASE=https://app.repworth.com/approve/` — the Meta-approved URL base embedded in the template's URL button. Required when flag on. `worker/startup-assert.ts` enforces `WHATSAPP_APPROVAL_URL_BASE === NEXT_PUBLIC_APP_URL.replace(/\/$/, '') + '/approve/'`. Staging / local environments either use a different Meta-approved template (with their own URL base) or run flag-off.

Reused from SMS + shared:

- `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `WORKER_PUBLIC_URL`, `NEXT_PUBLIC_APP_URL`.

## Appendix B — Open questions before implementation

1. **Template body copy** — finalize exact wording before Meta submission (approval clock restarts on every edit). Proposal in §3.1; owner to confirm.
2. **`app.repworth.com` URL base** — confirm this is the finalized production approval domain; any future rename triggers template resubmit. `WHATSAPP_APPROVAL_URL_BASE` env var assertion guards against code/template drift.
3. **Twilio account strategy** — same account as SMS (single `TWILIO_ACCOUNT_SID`), confirmed for Phase 3. Sub-account split deferred to future operational concern.
4. **Twilio WhatsApp error-code mapping** — verify §1.2 error classification (63014/63033 → blocked; 63024/21211/21408 → invalid recipient; 63040-42/63027-28 → template config; 63016 → session-window bug; 63017/63018/429 → rate limit) against the current https://www.twilio.com/docs/api/errors reference before writing `whatsapp-client.ts`. Wrong classification is the single highest-impact spec risk — a mismapped config error would falsely unsubscribe owners. Unit tests for `whatsapp-client.ts` MUST include fixtures for every code the spec enumerates, and any verification correction loops back into §4.3 dispatcher branches.
5. **Twilio Content Builder type for mixed quick-reply + URL button template** — confirm `twilio/card` (or current equivalent like `whatsapp/card`) against https://www.twilio.com/docs/content-api/content-types-overview before Meta submission. The exact JSON schema lands in `docs/whatsapp-templates.md` at implementation time so resubmits don't drift.
6. **Existing Telegram callers of `CallbackAuditContext`** — the widening in §2.2 (`updateId: number` → `providerEventId: string + telegramUpdateId?: number`) is a breaking interface change for `worker/ingress/telegram.ts:304,311`. The Telegram tests at `worker/ingress/__tests__/telegram.test.ts` will need fixture updates. Confirm the plan covers this as part of the `approval/service.ts` modification, not a separate task.
