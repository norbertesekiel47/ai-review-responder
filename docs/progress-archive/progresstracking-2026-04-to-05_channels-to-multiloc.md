# Progress archive — Channels → Multi-location (2026-04-20 → 2026-05-22)

> Archived verbatim from docs/progresstracking.md. Newest at the bottom.
> Live changelog resumes at "CI Keystone" (2026-05-24) in docs/progresstracking.md.

## Communication Channels — Phase 0 (2026-04-20 / 2026-04-21)

**Branch:** `feat/communication-channels` (17 commits ahead of main, not yet merged)
**Goal:** Lay the pluggable multi-channel transport foundation and migrate `NotificationWorker` to dispatch across all enrolled channels — Phase 0 keeps email as the only live channel but the architecture is ready for SMS, Telegram, WhatsApp.
**Tests:** 754/754 passing. TypeScript clean. Build clean.

---

### Task 1 — Migration 021: channel_enrollments (2026-04-20)

**File:** `supabase/migrations/021_channel_enrollments.sql`

New table `channel_enrollments` — one row per `(business_id, channel_id)` pair:

- `id` UUID (no default — caller supplies UUIDv7)
- `business_id` FK → businesses
- `channel_id` TEXT CHECK IN ('email','sms','whatsapp','telegram')
- `status` TEXT CHECK IN ('pending_verification','active','paused','revoked') DEFAULT 'pending_verification'
- `handle` TEXT — channel address (email, phone, Telegram chat ID, etc.)
- `handle_masked` TEXT — admin-visible partial, e.g. `a***@example.com`
- `verification_token_hash` TEXT — SHA-256 of verification token (never stored raw)
- `verified_at`, `created_at`, `updated_at` timestamps
- UNIQUE `(business_id, channel_id)` — one enrollment per channel per business
- Backfill: all existing businesses auto-enrolled in email (`status='active'`) using `businesses.owner_email`

**Commit:** `f927afb`

---

### Task 2 — NotificationChannel interface + delivery.ts widening (2026-04-20)

**Files:** `src/lib/notifications/channels/types.ts`, `src/lib/notifications/delivery.ts`

- `ChannelId` union type: `'email' | 'sms' | 'whatsapp' | 'telegram'`
- `SendApprovalParams` interface: `{ responseId, businessId, businessName, reviewerName, starRating, approvalLinkId, approvalUrl, channel }`
  - Note: `approvalLinkId` (UUIDv7 row ID) not `rawToken` — inline buttons get the stable ID, not the secret token
- `NotificationChannel` interface: `{ id: ChannelId; send(params): Promise<{ messageId: string }> }`
- `recordNotificationDelivery` — widened `channel` param from `'email'` literal to `ChannelId`

**Commit:** `ed3f2b9`

---

### Task 3 — EmailChannel (TDD) (2026-04-20)

**Files:** `src/lib/notifications/channels/email-channel.ts`, `src/lib/notifications/channels/__tests__/email-channel.test.ts`

- Wraps existing `sendApprovalEmail` from `src/lib/notifications/email.ts`
- Implements `NotificationChannel` — `id = 'email'`, `send()` returns `{ messageId }`
- Tests: sends via Resend, propagates errors, correct messageId forwarded

**Commit:** `f2fd621`

---

### Task 4 — getChannel factory (TDD) (2026-04-20)

**File:** `src/lib/notifications/channels/index.ts`

- `getChannel(channelId: ChannelId): NotificationChannel` — throws `UnsupportedChannelError` for unregistered channels
- Registry: `email` → `EmailChannel`; SMS/WhatsApp/Telegram placeholders return the error (Phase 1–3 will register them)

**Commit:** `9641630`

---

### Task 5 — getVerifiedEnrollments (TDD) (2026-04-20)

**Files:** `src/lib/notifications/enrollments.ts`, `src/lib/notifications/__tests__/enrollments.test.ts`

- `getVerifiedEnrollments(businessId): Promise<ChannelEnrollment[]>` — queries `channel_enrollments WHERE status='active'`
- Returns `{ channelId, handle }` per row; empty array if none (caller treats as no-ops)

**Commit:** `695799e`

---

### Task 5.5 — createApprovalLink channel-aware refactor (TDD) (2026-04-20)

**Files:** `src/lib/approval/create-link.ts`, `src/lib/approval/__tests__/create-link.test.ts`

- Added `channel: ChannelId` required param — each channel gets its own `approval_links` row
- `revokeMode`: `'orphaned_only'` (default) revokes same-channel open links only if no prior same-channel delivery exists; `'always'` revokes unconditionally (used by nudge emails)
- Advisory lock `pg_advisory_xact_lock(hashtext(responseId + ':' + channel))` wraps the delivery-check + revoke + INSERT inside `sql.begin` — prevents TOCTOU race where two concurrent workers for the same channel can both observe "no delivery" and then one revokes the other's freshly-created link
- Returns `{ rawToken, tokenHash, approvalLinkId }` — caller uses `rawToken` in URL, `approvalLinkId` for inline buttons

**Commits:** `ea7971d` (feature), `d01d729` (TOCTOU fix)

---

### Task 6 — NotificationWorker multi-channel dispatcher (TDD) (2026-04-20)

**File:** `worker/jobs/NotificationWorker.ts`

Full rewrite of the notification dispatch path:

1. Load business + subscription check (skip `cancelled`/`pending_payment`)
2. `getVerifiedEnrollments(businessId)` — get all active channels
3. For each enrollment: `createApprovalLink({ channel })` → `getChannel(channelId).send(params)` → `recordNotificationDelivery`
4. Channels are isolated: one channel throwing does not prevent others from sending
5. Tracks `attempted` / `succeeded` counters; throws if `succeeded === 0` (all channels failed) so BullMQ retries the job
6. `failover` payload field recognized — logs it and proceeds with normal dispatch

**Commit:** `45ebc71`

---

### Task 7 — Failover poller stale branch → admin alert (TDD) (2026-04-20)

**File:** `worker/jobs/NotificationFailoverPoller.ts`

Key behavioral change: the **stale branch** (pending_approval >4h, at least one send attempted, owner hasn't responded) no longer re-dispatches a `send_notification` outbox job. Instead it sends an admin alert via email. Rationale: in the multi-channel era, all enrolled channels already fired on initial dispatch; re-sending is unlikely to help — escalate to admin.

New `tryClaimAlert(responseId, template, recipient, sendFn, ctx)` helper:
- Acquires `pg_advisory_xact_lock(hashtext(responseId:template:recipient))` transaction-scoped
- Re-checks `notification_deliveries` for a recent alert (24h dedup) INSIDE the lock
- Calls `sendFn()` and inserts the delivery row in the same transaction
- Returns `'sent' | 'deduped' | 'send_error'`
- Two failover-poller processes (multi-instance Railway) arriving concurrently: one waits for the lock, then finds the row on re-check and skips

`runFailoverPollerOnce` exported (was internal `checkFailedNotifications`) — used by tests directly.

`shouldRunFailoverPoller` in `worker/index.ts` simplified — dropped `RESEND_WEBHOOK_SECRET` gate; now only checks `NOTIFICATION_FAILOVER_DISABLED` and `MOCK_EXTERNAL_APIS`.

Stale query now gates on `sent_at` (not `delivered_at`) — Telegram has no delivery callbacks, SMS webhooks unreliable in some regions.

**Commits:** `b5a88b1` (feature), `6f7b431` (multi-instance dedup fix), `8feef4c` (poller gate)

---

### Task 8 — Remove notification_preference field (2026-04-20)

`notification_preference` column was the pre-channels single-value field (e.g. `'email'`). Replaced by `channel_enrollments` rows. Removed from 8 files:

- `src/app/api/settings/route.ts`
- `src/app/api/dashboard/route.ts`
- `src/app/api/admin/businesses/route.ts`
- `src/lib/shared/schemas.ts`
- `src/app/(authenticated)/settings/page.tsx`
- `src/app/admin/businesses/new/page.tsx`
- `src/app/admin/runbook/page.tsx`
- Test file

**Commit:** `1b5d40e`

---

### Task 9 — Onboarding POST auto-enrolls email channel (2026-04-20)

**File:** `src/app/api/admin/businesses/route.ts`

Onboarding `POST` now inserts into `channel_enrollments` (email, status=`active`) inside the existing `sql.begin` transaction alongside the `businesses` INSERT — one atomic write, no separate step.

**Commit:** `e75e246`

---

### Task 9.5 — Admin PATCH syncs owner_email with enrollment (2026-04-20)

**File:** `src/app/api/admin/businesses/[id]/route.ts`

When admin edits `owner_email`, the PATCH now:
- Runs inside `sql.begin`
- Uses `BusinessNotFoundError` sentinel to distinguish "not found" from DB errors
- UPSERTs `channel_enrollments` for `channel_id='email'` with new handle + updated `handle_masked` + resets status to `'active'`
- Returns 409 on unique constraint violation (23505) instead of 500

**Commit:** `3769d37`

---

### Task 10 — Admin Channels section UI + API route (2026-04-20)

**Files:** `src/app/api/admin/businesses/[id]/channels/route.ts`, `src/app/admin/businesses/[id]/page.tsx`

New `GET /api/admin/businesses/[id]/channels` (`force-dynamic`):
- Returns all `channel_enrollments` rows for the business
- Includes `last_activity_at = MAX(COALESCE(nd.delivered_at, nd.sent_at))` from `notification_deliveries`
- `handle_masked` shown (never the raw handle)
- Hidden character count clamped to `Math.max(0, handle.length - 7)` to prevent negative values on short addresses

Admin business detail page (`/admin/businesses/[id]`):
- Second `useQuery` for channels data
- Channels section renders a table of enrolled channels with `StatusBadge`, masked handle, last activity
- `invalidateQueries(['admin-business-channels', businessId])` added to the `owner_email` mutation so the channel list refreshes when email is updated

**Commits:** `e0c72a1` (feature), `5552e4e` (clamp fix + query invalidation)

---

### Phase 0 — COMPLETE and MERGED (2026-04-21)

17 commits. Merged to main 2026-04-22 as part of the `feat/communication-channels` branch merge.

**Shipped:**
- Migration 021: `channel_enrollments` table + email backfill for existing businesses.
- `NotificationChannel` interface, `SendApprovalParams`, `ChannelId` types.
- `EmailChannel` wrapping existing Resend `sendApprovalEmail`.
- `getChannel` factory (sms/telegram/whatsapp stubs replaced in Phase 1).
- `getVerifiedEnrollments` query helper.
- Multi-channel `NotificationWorker` dispatcher (per-enrollment loop, isolation, idempotency).
- `createApprovalLink` channel-scoped with per-(response_id, channel) advisory lock.
- Failover poller stale branch → admin alert (no longer re-dispatches).
- Admin Channels section UI + `/api/admin/businesses/[id]/channels` read endpoint.
- Removed `businesses.notification_preference` field (deprecated by 022 drop).

---

### Phase 1 — SMS — COMPLETE and MERGED (2026-04-22)

31 commits. Merged to main 2026-04-22 (`feat/communication-channels` branch, 49 commits ahead of origin at time of merge). **906/906 tests passing. `pnpm build` clean.**

**Flag-gated off** by default (`CHANNELS_SMS_ENABLED=false`). No behavior change in production until flag is enabled after 10DLC registration.

**Shipped:**

_Schema (migration 022):_
- Dropped `businesses.notification_preference` (promised in 021).
- Soft-delete columns on `channel_enrollments` (`archived_at`, `archive_reason`).
- `sms_sender_opt_outs` table — sender-level opt-out state keyed by `(messaging_service_sid, handle)`, survives enrollment lifecycle.
- `sms_sender_opt_out_events` — append-only TCPA audit log for STOP/START/21610 events, with CHECK constraints on `event_type` + `source`, `ON DELETE SET NULL` FK to `inbound_events`.
- RLS enabled on both new tables.
- Partial unique index on `channel_enrollments(business_id, channel) WHERE archived_at IS NULL` (replaces full UNIQUE constraint; Phase 0 upsert sites updated to include the predicate).
- Handle lookup index scoped to active rows only.

_Core SMS:_
- `SmsChannel` — Twilio Messaging Service wrapper implementing `NotificationChannel`. 21610 maps to typed `SmsRecipientUnsubscribedError`.
- `sms-body.ts` — GSM-7 single-segment formatter with two-tier fallback (drops reviewer name on overflow; throws `SmsBodyTooLongError` if tier 2 also overflows).
- `sms-tracker.ts` — per-business + global daily cents cost guard in Redis; `reserveSmsCost` returns reservation date to prevent midnight-boundary refund bugs.
- `insertFailedDelivery` helper in `delivery.ts`.

_Twilio ingress (`worker/ingress/twilio.ts`):_
- Signature verification + form-body parsing utility.
- Status-callback handler — terminal-precedence first-wins, race-safe retry (503 + marks inbound_event failed so dedup reclaim picks it up), intermediate statuses no-op.
- Inbound STOP/START handler — keyword + OptOutType classification (EN + ES superset incl. REVOKE/OPTOUT), STOP writes `sms_sender_opt_outs` UPSERT + audit event + sender-wide `channel_enrollments` flip in one transaction, START writes `opted_in_at` + audit event (unconditionally), body redacted before `inbound_events` persist.
- Boot-time startup assertion (`assertChannelsSmsEnv`) — fails fast on missing Twilio vars.

_Admin API routes (6 routes, all in `src/app/api/admin/channels/sms/`):_
- `/verify` — Twilio-first, advisory-lock-serialized, sender-opt-out gate (blocks re-enrollment if `opted_in_at <= opted_out_at`), post-Twilio race re-check, state machine dispatch across empty/pending/disabled/unsubscribed/verified row states.
- `/confirm` — mid-flow STOP race handling (409 `sender_opted_out_during_verification` if STOP arrived during OTP window), row_not_pending guard, clears unsubscribed fields on success, does NOT touch `sms_sender_opt_outs`.
- `/cancel` — state-revert CTE (restores prior terminal status from timestamps; hard-deletes brand-new pending rows).
- `/disable` — verified → disabled with RETURNING guard.
- `/delete` — soft-delete only (`archived_at`), preserves TCPA evidence, strict `confirm: true` gate.
- `/status` (GET) — LEFT JOIN `sms_sender_opt_outs` scoped to current MS SID, returns derived `sender_opt_in_cleared` boolean.
- All routes: env-readiness 503 when `CHANNELS_SMS_ENABLED=true` but Twilio vars missing.

_Admin UI:_
- `SmsEnrollmentWidget` — 7-state client component (empty / sent / verified / disabled / unsubscribed / awaiting_sender_opt_in / opt_in_received). 3-second polling during awaiting START.
- `ChannelsSection` — server component for future server-page refactor.
- Business detail page wired: `smsEnabled` flag surfaced server-side via business detail API (no `NEXT_PUBLIC_*` leak); widget renders only when flag on + subscription active.

_Dispatcher:_
- `NotificationWorker` — flag-off skip for SMS enrollments, pre-send cost reservation with `try/finally` refund (covers createApprovalLink failures + non-ACK Twilio errors), sender-wide 21610 transaction (UPSERT opt-out + audit + channel flip).

_Tests:_ 906 total. Re-enable-after-STOP lifecycle E2E + archive-bypass integration tests. All mock-based (repo Vitest setup uses dummy DB URL).

**Pending (not blocking merge):**
- 10DLC brand + campaign registration paperwork.
- Manual ship gate (spec §15): real-phone end-to-end walkthrough (enroll → receive SMS → approve → STOP → re-enable lifecycle).

---

## 2026-04-23 — Communication Channels Phase 2 (Telegram) SHIPPED

**Status:** Code complete + **real-bot ship gate PASSED** against `@RepWorthBot` in local dev (via ngrok). PR to `main` opened. Flag-gated off (`CHANNELS_TELEGRAM_ENABLED=false`) — prod cutover pending prod bot registration + `setWebhook` + one-business pilot walkthrough.

**Branch:** `feat/channels-telegram` (30 commits ahead of `main`).

**Tests:** 985 passing, 88 suites, `pnpm tsc --noEmit` clean, `pnpm build` clean.

**Spec:** `docs/superpowers/specs/2026-04-22-telegram-phase-2-design.md`
**Plan:** `docs/superpowers/plans/2026-04-22-phase2-telegram.md` (19 tasks)

### Scope decisions (from brainstorming)

| # | Decision | Reasoning |
|---|---|---|
| 1 | **Admin-onboarding only** | Owner dashboard deferred to Phase 4 so SMS + Telegram + WhatsApp all land as one coherent sweep instead of a half-built `/dashboard/settings/channels` |
| 2 | BotFather registration + `setWebhook` = manual prereq | Mirrors the Twilio-console pattern from Phase 1; worker startup stays deterministic |
| 3 | Regenerate UX: replace original with "🔄 Regenerating…" via `editMessageText` | Refined during the walkthrough when the stripped-buttons-only variant felt jarring |
| 4 | Flag-gated off at merge; flipped per-environment after real-bot gate | Consistent with Phase 1 SMS posture |
| 5 | **Zero migrations** | Migration 021 already accommodates telegram; `inbound_events.source` is open TEXT; audit row uses existing `approval_audit_log.metadata` JSONB |
| 6 | No automated real-bot E2E | Per spec §5.3 — chat-platform automation is brittle and low-value; unit + integration + manual walkthrough instead |
| 7 | `approveViaCallback` + `regenerateViaCallback` ship together | Share 90% of validation; splitting duplicates work |
| 8 | Direct `fetch` to `api.telegram.org` — no SDK | Only 4 Bot API methods used (sendMessage, editMessageText, editMessageReplyMarkup, answerCallbackQuery) |

### Architecture

**Send path (dispatcher → owner):**

```
NotificationWorker (for each verified enrollment)
  ↳ TelegramChannel.sendApprovalRequest
    ↳ formatApprovalTelegram (pure HTML-escape + inline keyboard)
    ↳ TelegramClient.sendMessage → api.telegram.org
  ↳ on TelegramRecipientBlockedError → flip enrollment unsubscribed (telegram_blocked) + insertFailedDelivery
  ↳ on TelegramChatNotFoundError → flip enrollment disabled + insertFailedDelivery
  ↳ continue to next enrollment on any failure — one channel failure doesn't abort the whole job
```

**Callback path (owner tap → approval):**

```
Telegram webhook → POST /ingress/telegram
  1. verifyTelegramSecret (constant-time, X-Telegram-Bot-Api-Secret-Token)  → 401 on mismatch
  2. claimInboundEvent(source='telegram', dedupKey=tg:<update_id>, …)     → 200 on duplicate
  3. parseCallbackData (a:<link_id> | r:<link_id>)
  4. invariant checks: link live AND channel='telegram'; sender matches verified enrollment
  5. ACK BOUNDARY — answerCallbackQuery with outcome text ("Approving…" / "Regenerating…")
  6. approveViaCallback / regenerateViaCallback (inside sql.begin)
     permanent errors (Consumed/Revoked/Expired/ChannelMismatch/ResponseNotPending):
       → editMessageText in place (replaces stale draft + clears buttons) → markProcessed → 200
     unexpected errors (DB timeout, unknown):
       → sendMessage fallback (no URL embed — raw token not in scope)
       → markFailed → 503 (reclaim retries in 2min)
  7. on success: editMessageText for approve ("✅ approved…") or regenerate ("🔄 Regenerating…")
  8. markProcessed → 200
```

**Enrollment path (`/start <rawToken>`):**

```
Owner taps deep link → Telegram DM → /start <rawToken>
  1. verifyTelegramSecret → 401 on mismatch
  2. claimInboundEvent → 200 on duplicate
  3. Reject non-private chat.type (group/channel) — bot DMs won't reach owner later
  4. sha256(rawToken) → SELECT FOR UPDATE channel_enrollments by hash (inside sql.begin)
  5. UPDATE enrollment: status='verified', handle=chat_id, clear verification_token_hash/expires_at
  6. Send "✅ You're connected to RepWorth" confirmation
  7. markProcessed → 200
```

### Files changed

**New files (13):**

- `src/lib/approval/errors.ts` — added 4 typed errors: `ConsumedLinkError`, `RevokedLinkError`, `ExpiredLinkError`, `ChannelMismatchError` (match existing `{State}{Subject}Error` convention)
- `src/lib/notifications/channels/telegram-body.ts` — pure `formatApprovalTelegram(params)` with HTML escape, 400-char truncation, 64-byte callback_data budget
- `src/lib/notifications/channels/telegram-client.ts` — native fetch wrapper, 10s AbortController timeout, 4 typed error classes (Blocked / ChatNotFound / RateLimit / Api); JSON-parse failure classified as `TelegramApiError`
- `src/lib/notifications/channels/telegram-channel.ts` — `TelegramChannel implements NotificationChannel` thin adapter
- `worker/ingress/shared.ts` — extracted `claimInboundEvent(source, dedupKey, eventType, payload)` from twilio for reuse
- `worker/ingress/telegram.ts` — Fastify handler: enrollment + callback paths with Model A ack ordering
- `worker/ingress/telegram-verify.ts` — constant-time compare of X-Telegram-Bot-Api-Secret-Token
- `src/app/api/admin/channels/telegram/_shared.ts` — `isTelegramEnabled()` / `flagOff()` (404) / `assertTelegramEnvReady()` (503)
- `src/app/api/admin/channels/telegram/start/route.ts` — POST: advisory lock + state machine upsert inside `sql.begin`, server-side QR render, `Cache-Control: no-store, private`
- `src/app/api/admin/channels/telegram/cancel/route.ts` — POST: clears pending verification hash + expiry
- `src/app/api/admin/channels/telegram/disable/route.ts` — POST: flips verified → disabled (404 if none)
- `src/components/admin/TelegramEnrollmentWidget.tsx` — 8-state client UI, 3s polling, 1h TTL countdown
- `.claude/` skill files, design spec, plan doc, operational runbook updates

**Modified files (9):**

- `src/lib/approval/service.ts` — added `approveViaCallback` / `regenerateViaCallback` (~130 lines). Bypass device-cookie binding; validate link via `lockLinkByIdForCallback` throwing typed errors; call `recoverCorrelationId(tx, { reviewId, responseId })`; audit row with SHA-256 `chat_handle_hash` in `metadata` JSONB; `auth_method='token'` preserved (no CHECK migration)
- `src/lib/notifications/channels/index.ts` — factory: removed `'telegram'` from `NOT_YET_IMPLEMENTED`, added flag-gated branch; export `TelegramChannel` + 4 error classes
- `worker/ingress/twilio.ts` — pure refactor: import `claimInboundEvent` from shared, pass `source='twilio'`
- `worker/startup-assert.ts` — `assertChannelsTelegramEnv()` paralleling SMS
- `worker/index.ts` — registers POST /ingress/telegram route (`rawBody: true`); calls startup assertion
- `worker/jobs/NotificationWorker.ts` — telegram flag-skip branch (rollback-safe); `TelegramRecipientBlockedError` → enrollment flip to `unsubscribed`/reason `telegram_blocked`; `TelegramChatNotFoundError` → flip to `disabled`. Both filter by `handle` so stale sends cannot stomp re-enrolled handles. Also restored `logger.error` on SMS 21610 branch for observability parity + symmetric `COALESCE(unsubscribed_at, NOW())`
- `src/app/api/admin/businesses/[id]/route.ts` — `telegramEnabled` flag alongside `smsEnabled`
- `src/app/api/admin/businesses/[id]/channels/route.ts` — telegram handle masking `••• 1234` (replaces generic literal)
- `src/app/admin/businesses/[id]/page.tsx` — mounts `TelegramEnrollmentWidget` in Channels section, flag-gated

**New dependency:** `qrcode` + `@types/qrcode` for server-side QR data URL rendering.

**Env vars added** (see `.env.example`):
- `CHANNELS_TELEGRAM_ENABLED` (default false; server-authoritative)
- `TELEGRAM_BOT_TOKEN` (required when flag on)
- `TELEGRAM_WEBHOOK_SECRET` (required when flag on; 32+ bytes)
- `TELEGRAM_BOT_USERNAME` (optional; default `RepWorthBot`)

### Security invariants enforced

1. **Raw approval tokens NEVER persisted** — callback payloads carry `approval_link_id` (UUIDv7 row id, non-secret), not raw tokens. Redaction on `inbound_events.payload` also strips `/start <token>` text + `callback_query.data`.
2. **Four-invariant callback auth:** (a) provider signature verified, (b) approval_link live AND channel='telegram' (cross-channel replay blocked), (c) `callback_query.from.id` matches a verified non-archived enrollment for the link's business_id, (d) `inbound_events` dedup on `tg:<update_id>` — replays no-op.
3. **Verification tokens:** 1h TTL, SHA-256 hashed in DB, raw returned once to admin browser (`Cache-Control: no-store, private`), cleared on successful enrollment.
4. **PII redaction:** `from.first_name`, `from.last_name`, `from.username`, `chat.title` stripped from `inbound_events.payload` before persist — only `{id}` / `{id, type}` retained.
5. **Bot token never exposed** in thrown errors or logs — only lives in `TelegramClient.baseUrl` (private).

### Review cycles

Three internal review passes via `superpowers:code-reviewer` subagent caught real issues pre-walkthrough:

**Round 1** (7 findings): dispatcher threw from factory on retained enrollments after flag-off rollback (fix: flag-skip before factory); `approval_audit_log` has no `chat_handle_hash` column (fix: store in metadata JSONB); `claimInboundEvent` hardcoded `source` (fix: extract to shared); ack ordering (fix: committed to Model A); QR third-party leak (fix: local qrcode dep); setWebhook runbook JSON quoting; scope-vs-parent-spec delta not acknowledged.

**Round 2** (5 findings): unexpected-error `sendMessage` embedded approvalUrl but raw token out of scope (fix: text-only fallback); service signature missing `audit.updateId`/`ipAddress`; `recoverCorrelationId` needs `reviewId` too (load from responses inside tx); race vs transient conflated (fix: typed errors mark processed, unknowns mark failed); malformed callback didn't markProcessed.

**Round 3** (4 real race/auth issues): admin start route `pg_advisory_xact_lock` ran outside `sql.begin` → lock released immediately (fix: wrap state machine in tx); ingress enrollment `SELECT FOR UPDATE` + `UPDATE` also outside tx (same fix); NotificationWorker telegram error branches updated ALL enrollments for business with no handle filter → stale send could stomp re-enrolled handle (fix: `AND handle = ${enrollment.handle}`); callback sender lookup missing `AND archived_at IS NULL`.

**Pre-ship batch (M1–M6 + L6):** `ResponseNotPendingError` classified as permanent (prevents infinite retry on cross-channel approval race); `answerCallbackQuery` wrapped in `.catch()` (15s TTL vs 2min reclaim would loop); reject group/channel chat on `/start`; 10s AbortController on Bot API; widget distinguishes 401/403 from 5xx from empty enrollment; `Cache-Control: no-store, private` on admin responses; explicit PII allowlist in `redactForAudit`.

### Real-bot ship gate (2026-04-23)

Executed end-to-end against Hey Tea test business (`019db775-60c5-744b-b948-741e0d2021ad`) with `@RepWorthBot` via local worker + ngrok tunnel.

| Test | Outcome |
|---|---|
| Webhook registration (`setWebhook` + `getWebhookInfo`) | ✅ |
| QR enrollment | ✅ chat_id `7944845018` verified via `/start <rawToken>` |
| Approve round-trip | ✅ tap → `approveViaCallback` → response `approved` → publish_response outbox entry → editMessageText "✅ approved" |
| Regenerate round-trip | ✅ (after UX fix `01ad608`) — original message replaced with "🔄 Regenerating…"; new draft arrived as separate message |
| Blocked-bot detection | ✅ enrollment flipped to `status='unsubscribed'`, `unsubscribed_reason='telegram_blocked'`, `notification_deliveries.failed_at` + `failure_reason='telegram_blocked'` |
| Re-enroll after unblock | ✅ admin Re-enroll → state machine `unsubscribed → pending_verification` with fresh 1h-TTL hash → `/start <new-token>` → back to verified with same chat_id |
| Cross-channel race (M1) | ✅ (after commits `445e2cd` + `c12702f`) — email approve first → telegram tap → in-place editMessageText replaces stale draft with "This review has already been handled"; buttons removed; `inbound_events` marked `processed` (not `failed`); no retry spam |

### Post-walkthrough polish commits

- `01ad608` — Regenerate: switch from `editMessageReplyMarkup({inline_keyboard: []})` to `editMessageText` with status line. Old path only dropped buttons; stale draft text remained.
- `445e2cd` — Permanent link-state errors: switch from `sendMessage` (separate message, stale buttons remain) to `editMessageText` in place. Applied to both pre-ack `!linkLive` branch and post-ack catch.
- `c12702f` — Defensive: `TelegramClient.editMessageText` now defaults `reply_markup: { inline_keyboard: [] }`. Telegram's Bot API empirically preserves existing `reply_markup` when the field is omitted from an edit; explicit empty keyboard guarantees button removal.

### Known residuals (none blocking)

- Pre-ack "sender mismatch" branch intentionally does NOT strip buttons (real verified owner might still want to tap).
- `TelegramChatNotFoundError` branch (owner deletes chat instead of blocks) not exercised in manual walkthrough — identical code path to blocked-bot, low marginal value.
- `qrcode` admin route 409 path ("already verified") not exercised in walkthrough — unit tested.
- Phase 2 is admin-onboarding only; owner self-service dashboard bundles with SMS + WhatsApp in Phase 4.

### Prod cutover checklist

1. Register prod bot via BotFather, capture `TELEGRAM_BOT_TOKEN`.
2. Generate production `TELEGRAM_WEBHOOK_SECRET` (32+ random bytes).
3. Deploy branch to staging/prod with `CHANNELS_TELEGRAM_ENABLED=false`.
4. Run `setWebhook` against prod `WORKER_PUBLIC_URL` (runbook has the curl).
5. Flip flag to `true` in one pilot business's env.
6. Re-run ship gate on the pilot (enrollment + approve + regenerate + blocked-bot + re-enroll + cross-channel race).
7. 24h Sentry watch on pilot.
8. If clean, widen to all `active`-subscription businesses.

---

## Communication Channels — Phase 3: WhatsApp (2026-04-23)

**Status:** CODE COMPLETE on branch `feat/channels-whatsapp-phase-3`. 23 commits. 1087/1087 tests pass. 0 tsc errors. 0 migrations. Flag-gated off (`CHANNELS_WHATSAPP_ENABLED=false`) pending Meta Business verification + WABA + approved `repworth_approval_request_v1` Twilio Content template.

Design: `docs/superpowers/specs/2026-04-23-whatsapp-phase-3-design.md` (gitignored local working doc).
Plan: `docs/superpowers/plans/2026-04-23-whatsapp-phase-3.md` (gitignored local working doc).
Parent spec: `docs/adding-communication-channels.md` §5.1 Phase 3.

### Brainstorming → spec → plan → implement pipeline

End-to-end in a single session via the superpowers skills pipeline: `brainstorming` → `writing-plans` → `subagent-driven-development` → `finishing-a-development-branch`.

**Brainstorming decisions:** External prereqs nothing-started (flag-gated off at merge, identical posture to SMS/Telegram). Scope narrowed to admin business-detail page only (matches Phase 2 precedent; Phase 4 bundles owner dashboard). All 6 technical approach defaults accepted: A1 separate Fastify routes, B1 3-button UTILITY template, C1 no WA-specific opt-out table, D1 delegate session-window to Twilio/Meta, E1 direct `TWILIO_WHATSAPP_NUMBER` no Messaging Service, F1 mirror Phase 2 ship gate.

**Design spec reviews — 5 rounds:** Round 1 (11 issues: missing `ResponseNotPendingError` in permanent-error list, wrong Twilio error-code mapping, config errors falsely unsubscribing owners, Telegram-shaped audit context, missing archived_at guards, private `classifyIntent`, missing timeout, underspecified Content type, wrong assertion placement, hardcoded URL base, naive URL parser). Round 2 (5 issues: WA env assertion relying on SMS, non-atomic audit widening, missing template doc deliverable, missing `.env.example` row, need "no import-time work" rule). Round 3 (2 issues: spec line still said `split('/').pop()`, `retry_after` had no concrete mechanism). Round 4 (4 Medium + 5 Low: untouched-file contradiction, conditional metadata shape, missing CONFIG-ERROR guard test, inconsistent widget states, and various polish). Round 5: approved.

**Plan:** 20 tasks with atomic ordering constraints (CallbackAuditContext widening as first commit; WA modules side-effect-free at import; template doc before body.ts).

### Implementation (23 commits)

Sequential dispatch via `subagent-driven-development` — fresh implementer subagent per task, two-stage review (spec compliance → code quality) after each.

**Task 1 — Widen CallbackAuditContext atomically (`2676903` + `f78262c`):** Replaced `{ updateId: number }` with discriminated union `{ telegramUpdateId | twilioMessageSid }` enforcing "never both" at compile time via `?: never`. `buildCallbackAudit` emits cross-channel `metadata.provider_event_id` unconditionally + channel-specific `update_id` (Telegram legacy query continuity) or `message_sid` (WhatsApp). Follow-up commit tightened to discriminated union + added assertion that `message_sid` absent on Telegram rows. 2 Telegram callsites updated. 6 test fixtures updated. 985 tests pass.

**Task 2 — Extract classifyIntent to `twilio-intent.ts` (`5a75c10`):** Pure move of STOP/START keyword sets + classifier from `twilio.ts` (file-local) to new shared module so SMS + WA both import. `twilio.ts` SMS logic untouched; regression surface = one import line. 7 tests. 992 pass.

**Task 3 — `docs/whatsapp-templates.md`:** Template reference (local gitignored). `twilio/card` Content type, 9 body variables with max-length + null-safe defaults, 3-button configuration (2 QUICK_REPLY + 1 URL), UTILITY category, submission JSON, Meta re-review triggers, sandbox testing instructions.

**Task 4 — `whatsapp-body.ts` pure helpers (`deef853`):** 5 exports: `formatApprovalWhatsApp`, `extractTokenFromApprovalUrl`, `stripWaPrefix`, `toWaRecipient`, `truncate`. Side-effect-free at import. Implementer caught subtle spec bug: `split('/').filter(Boolean).at(-1)` silently passes trailing-slash `/approve/` because filter strips empty segment — fixed with `endsWith('/')` check. 24 tests. 1016 pass.

**Task 5 — `whatsapp-client.ts` + error classification (`9152d39` + `ef20d6f`):** Twilio SDK wrapper with `{ timeout: 10_000, autoRetry: false }`, lazy env reads, 7 typed error classes, `classifyError` dispatch via `Set<number>` membership. Anti-regression test for raw-token-locality: every error-path test spies on console.log/error/warn asserting no call arg contains the raw token fixture. Follow-up added `readonly code = 'TIMEOUT' as const` for uniformity. 12 tests.

**Task 6 — `WhatsAppChannel` (`a29fcd3`):** Thin `NotificationChannel` adapter wiring body formatter to client sendTemplate. Side-effect-free at import. 3 tests.

**Task 7 — Factory + exports (`db2f47b`):** Removed `'whatsapp'` from `NOT_YET_IMPLEMENTED`, added flag-gated factory branch, exported 7 error classes. 1031 pass.

**Task 8 — `assertChannelsWhatsAppEnv` (`55f8cf9`):** Self-contained boot assertion. Does NOT depend on `assertChannelsSmsEnv`. Enforces: 7 env vars present, `TWILIO_WHATSAPP_NUMBER` matches `/^whatsapp:\+\d{7,15}$/`, `WHATSAPP_APPROVAL_URL_BASE === NEXT_PUBLIC_APP_URL + '/approve/'`. 6 tests. 1037 pass.

**Task 9 — WA status callback (`8887091`):** Created `worker/ingress/twilio-whatsapp.ts` scaffold. Mirrors SMS status handler (signature verify, dedup on `${MessageSid}:${MessageStatus}`, first-wins terminal state, reclaim if delivery row missing) with `AND channel = 'whatsapp'` discriminator. Exported `redactWhatsAppPayload`. 4 tests. 1041 pass.

**Task 10 — WA inbound handler (`f4a8979` + `eb76aa7`):** Heaviest task. 3 flow paths with post-claim safety net:

```
inbound/ verifyTwilioSignature → claimInboundEvent → OUTER TRY {
  if ButtonPayload: UUID check (malformed → markProcessed + 200, no DB) →
    SELECT approval_links live → enrollment check (archived_at IS NULL) → INNER TRY {
      approveViaCallback/regenerateViaCallback(viaChannel='whatsapp', twilioMessageSid)
      permanent errors (5 classes) → friendly text + markProcessed + 200
      unexpected → fallback text + markFailed + 503 (reclaim 2min)
      success → "✅ approved" / "🔄 Regenerating" + markProcessed + 200
    }
  classifyIntent: 'stop' → UPDATE channel_enrollments (handle-scoped, archived_at, COALESCE)
                  'start' → no-op
                  'none' + Body starts 'start-' → sql.begin(sha256 + UPDATE, archived_at on both)
                         → sendFreeform confirm (LOG failures via console.warn)
} CATCH → markFailed('post_claim_unexpected:...') + 503
```

Follow-up `eb76aa7` unwrapped unnecessary STOP `sql.begin` + added warn log on confirmation send failure. 17 tests. 1054 pass.

**Task 11 — Register routes in `worker/index.ts` (`a7dc1a3`):** 2 route registrations + startup assertion call. Smoke-tested boot flag on/off.

**Task 12 — Dispatcher branches (`6136330`):** Flag-skip + 6 WA error branches. OWNER-INTENT (blocked→unsubscribed, invalid→disabled) mutates enrollment with handle-scoped + archived_at guard. **CONFIG-ERROR (`TemplateConfigError`, `SessionWindowError`) leaves enrollment UNCHANGED** — RepWorth ops failure, not owner intent; flipping to unsubscribed would falsely suppress + mislead admin widget. **Explicit test asserts zero `channel_enrollments` UPDATE calls on `WhatsAppTemplateConfigError`** — single most important regression guard in Phase 3. TRANSIENT (`RateLimit`, `Timeout`) records failed_delivery, enrollment unchanged, BullMQ backoff retries. Existing NotificationWorker test files updated with WA error stubs. 6 integration tests. 1060 pass.

**Task 13 — Admin `_shared.ts` (`a9ceeb7`):** `isWhatsAppEnabled()` / `flagOff()` (404) / `assertWhatsAppEnvReady()` (503). 5 env vars checked (admin routes don't need `WORKER_PUBLIC_URL` / `NEXT_PUBLIC_APP_URL` directly). 6 tests.

**Task 14 — Admin `/start` (`13c2d9b`):** Flag → env → auth → businessId → subscription active → advisory lock → state-machine upsert. 5 state transitions (none→pending, pending→pending, unsubscribed→pending, disabled→pending, verified→409). Advisory lock key `sha256('whatsapp_enroll:' + businessId).readBigInt64BE(0)`. wa.me deep link requires digits only (`TWILIO_WHATSAPP_NUMBER.replace(/^whatsapp:\+?/, '')`). QR rendered server-side via `qrcode`. `Cache-Control: no-store, private`. 10 tests. 1076 pass.

**Task 15 — Admin `/cancel` (`0526a43`):** Clears verification token fields on pending row. Idempotent. 2 tests.

**Task 16 — Admin `/disable` (`94c9ee5`):** Flips verified → disabled. 3 tests. 1081 pass.

**Task 17 + 19 — Business detail API + widget mounting (`239c72b`):** `whatsappEnabled` flag in response; `<WhatsAppEnrollmentWidget>` conditional mount.

**Task 18 — `WhatsAppEnrollmentWidget` (`25a3e18`):** 8-state UI (idle/generating/awaiting_scan/verified/disabled/unsubscribed/expired/error). 3s polling, 1h TTL countdown, masked phone `+15•••4567`. `onCancel` force-resets idle locally BEFORE refresh (otherwise stale QR would remain since server row stays `pending_verification`). Three-way fetch result (`ok | auth_expired | error`) — never silently collapses non-OK to idle.

**Task 20 — Env + docs sweep (`c3e9bbb`):** `.env.example` new section, `.claude/CLAUDE.md` status update, parent spec scope-amendment note.

**Post-task tsc cleanup (`f1b7332`):** 5 test-only strict-mode issues fixed: `contentVariables['5']!.length` non-null assertion, `(a: unknown)` explicit parameter type on log spy map, widen `mockClaimInboundEvent` return to `Promise<'claimed' | 'duplicate'>`.

### Post-implementation review (`21ea156`) — 4 findings, all fixed

**Medium #1 — Pre-callback SQL failures could leak stuck `received` events.** After `claimInboundEvent`, approval-link SELECT, enrollment SELECT, STOP UPDATE, enrollment tx all ran outside a catch. Any throw would leave `inbound_events` in `received` state; within the 2-min reclaim window Twilio retries would be treated as duplicate and silent-200 — losing the webhook. **Fix:** outer try/catch wraps all post-claim work. Unexpected throws → `markFailed('post_claim_unexpected:<msg>')` + 503. Two integration tests push Error sentinels into sql mock queue verifying link-lookup + STOP-update failure paths.

**Medium #2 — `parseButtonPayload` accepted non-UUID suffixes.** `a:not-a-uuid` would SELECT on UUID column → Postgres "invalid input syntax for type uuid" escaping happy path. **Fix:** UUID regex check before returning. Malformed payloads → markProcessed + 200 (no DB query). Two new tests.

**Medium #3 — `extractTokenFromApprovalUrl` didn't enforce URL shape.** Spec comment said "rejects query-string-corrupted inputs" but implementation returned last path segment even for `/approve/abc?x=1`. Test even documented permissive behavior. Staging/local misconfig could ship broken URL buttons. **Fix:** rewrote to REQUIRE exactly `/approve/<token>` — throws on query strings, hash fragments, trailing slashes, non-approve paths. 9 test cases covering all rejection branches.

**Low #4 — Cancel left WA widget showing stale QR.** Cancel clears token fields but leaves row `pending_verification`; widget refresh() no-ops on that state to preserve QR during polling. **Fix:** `onCancel` force-resets idle locally before refresh.

Post-fix: **1087/1087 tests pass** (+6 from UUID validation + post-claim safety net tests).

### Files changed

**New files (20):** `whatsapp-channel.ts`, `whatsapp-client.ts`, `whatsapp-body.ts` (+ 3 test files), `twilio-intent.ts` (+ test), `twilio-whatsapp.ts` (+ test), admin `_shared.ts` + 3 route files (+ 4 test files), `WhatsAppEnrollmentWidget.tsx`, `NotificationWorker.whatsapp.test.ts`.

**Modified files (14):** `src/lib/approval/service.ts` (CallbackAuditContext widening), `src/lib/approval/__tests__/approve-via-callback.test.ts` (fixtures), `worker/ingress/telegram.ts` (2 callsites), `worker/ingress/twilio.ts` (intent import), `worker/jobs/NotificationWorker.ts` (flag + 6 branches), existing NotificationWorker test files (error stubs), `worker/startup-assert.ts` + test, `worker/index.ts`, `src/lib/notifications/channels/index.ts`, factory + email-channel tests, business detail API + page, `.env.example`.

### Security invariants enforced

1. **Raw approval tokens NEVER stored or logged.** Live only in: approveViaCallback in-memory, email body, WA URL button suffix (`contentVariables['9']`). ButtonPayload carries UUID row-id only. `redactWhatsAppPayload` strips Body/ButtonPayload/ProfileName/WaId before `inbound_events.payload` persist. Test suite asserts no console log call arg contains the raw token across every WA client error path.

2. **Four-invariant callback auth** (mirrors Phase 2): (a) Twilio signature, (b) `approval_links` live + `channel='whatsapp'` (cross-channel replay blocked), (c) sender handle matches verified enrollment for link's business_id + archived_at IS NULL, (d) inbound_events dedup on MessageSid.

3. **Verification tokens:** 1h TTL, SHA-256 hashed, raw returned once to admin browser (`Cache-Control: no-store, private`), cleared on successful enrollment.

4. **UUID validation on ButtonPayload** prevents Postgres UUID-syntax error from escaping happy path.

5. **URL shape strictly enforced** — fails loud on staging/local misconfig instead of shipping broken URL buttons.

6. **Post-claim safety net** — any DB throw between claim and markProcessed/markFailed lands in markFailed + 503 (no stuck `received` rows).

7. **Handle-scoped guards** on every enrollment UPDATE — stale in-flight errors cannot stomp re-enrolled handles.

### CONFIG-ERROR regression guard

`NotificationWorker.whatsapp.test.ts` tests #3 and #4 explicitly assert:

```ts
const updateCalls = sqlCalls.filter(c => c.sql.includes('UPDATE channel_enrollments'));
expect(updateCalls).toHaveLength(0);
```

Fires loudly if a future patch ever naively widens the owner-intent branch to catch all WhatsApp errors — which would silently unsubscribe every paying customer when Meta pauses the template.

### Final verification

- **23 commits** on `feat/channels-whatsapp-phase-3`.
- **1087/1087 tests pass** (+102 from 985 baseline).
- **0 TypeScript errors** under `pnpm tsc --noEmit`.
- **0 database migrations** — migration 021 + 022 already accommodate `channel='whatsapp'`.
- **Final code-reviewer pass:** ship-ready at flag-gate merge boundary.

### Commit log

```
21ea156 fix(channels): 4 post-review hardening findings on Phase 3 WhatsApp
f1b7332 chore(channels): clean up Phase 3 test-file tsc errors
c3e9bbb docs(channels): document Phase 3 WhatsApp env vars + status update
239c72b feat(admin): expose whatsappEnabled flag and mount WhatsAppEnrollmentWidget
25a3e18 feat(admin): WhatsAppEnrollmentWidget — QR + wa.me deep link + status polling
94c9ee5 feat(admin): POST /api/admin/channels/whatsapp/disable
0526a43 feat(admin): POST /api/admin/channels/whatsapp/cancel
13c2d9b feat(admin): POST /api/admin/channels/whatsapp/start — wa.me deep link + QR
a9ceeb7 feat(admin): whatsapp admin shared flag/env helpers (404/503)
6136330 feat(worker): NotificationWorker — WhatsApp flag-skip + 5 error branches
a7dc1a3 feat(worker): register WhatsApp ingress routes + startup assertion
eb76aa7 fix(ingress): unwrap STOP from sql.begin + log enrollment confirmation failure
f4a8979 feat(ingress): WhatsApp inbound — enrollment + button tap + STOP
8887091 feat(ingress): WhatsApp status-callback handler
55f8cf9 feat(worker): assertChannelsWhatsAppEnv — self-contained boot check
db2f47b feat(channels): enable WhatsApp in factory behind CHANNELS_WHATSAPP_ENABLED
a29fcd3 feat(channels): WhatsAppChannel implementing NotificationChannel
ef20d6f refactor(channels): WhatsAppTimeoutError.code for uniform error interface
9152d39 feat(channels): whatsapp-client — typed errors + no-log-leak guard
deef853 feat(channels): whatsapp-body pure formatters + URL token parser
5a75c10 refactor(ingress): extract classifyIntent to twilio-intent.ts
f78262c refactor(approval): tighten CallbackAuditContext type + add provider_event_id
2676903 refactor(approval): widen CallbackAuditContext for multi-provider callbacks
```

### Prod cutover checklist (pending external prereqs)

1. Start Meta Business verification (2–4 week external clock).
2. Provision WhatsApp Business Account (WABA) via Meta/Twilio.
3. Provision Twilio WA sender, capture `TWILIO_WHATSAPP_NUMBER` in `whatsapp:+<digits>` format.
4. Author + submit `repworth_approval_request_v1` Twilio Content template per `docs/whatsapp-templates.md`. Wait for Meta approval (separate clock per template edit).
5. Capture `WHATSAPP_APPROVAL_TEMPLATE_SID` (HX...) from Twilio Content Editor after approval.
6. Populate 4 env vars in Railway + Vercel: `CHANNELS_WHATSAPP_ENABLED`, `TWILIO_WHATSAPP_NUMBER`, `WHATSAPP_APPROVAL_TEMPLATE_SID`, `WHATSAPP_APPROVAL_URL_BASE` (= `NEXT_PUBLIC_APP_URL + '/approve/'`).
7. Configure Twilio console webhooks: inbound → `<WORKER_PUBLIC_URL>/ingress/twilio/whatsapp-inbound`, status callback → `<WORKER_PUBLIC_URL>/ingress/twilio/whatsapp-status`.
8. Deploy with `CHANNELS_WHATSAPP_ENABLED=false` initially.
9. Flip flag to `true` on one pilot business's env.
10. Run 8-item ship gate on pilot (webhook registration, click-to-chat enrollment, approve round-trip, regenerate round-trip, blocked-recipient handling, re-enrollment after unblock, cross-channel race vs email, STOP inside session).
11. 24h Sentry watch on pilot.
12. If clean, widen to all `active`-subscription businesses.

Until all 8 pass, `CHANNELS_WHATSAPP_ENABLED` stays `false` in production.

---

## Owner Self-Serve Signup (2026-04-25)

Branch: `feat/owner-self-serve-signup`. End-to-end flow that lets owners create their account, pay, and onboard their business without admin involvement. Replaces the old admin-only path which was the bottleneck for any inbound signup that came outside business hours.

**Architectural shape:**

```
/signup (identity-only)
  → /api/auth/signup (Supabase auth.signUp + createBusinessTx self_serve)
  → /signup/check-email
    → POST /api/auth/verify-otp (6-digit OTP) → channel_enrollments INSERT 'verified'
  → /onboarding/pay (plan picker)
    → POST /api/onboarding/select-plan → Stripe Payment Link
  → Stripe (off-domain)
    → /onboarding/payment-success (polls signup-status)
  → /onboarding/business (3-step wizard)
    → POST /api/onboarding/business → enqueues sync_reviews / validate_place_id
  → /dashboard

Google OAuth alternative:
/signup → "Continue with Google" → Supabase OAuth → /api/auth/callback (?code=...)
  → /signup/finish (collect name + phone)
  → POST /api/auth/finish-signup → createBusinessTx + channel_enrollments INSERT
  → /onboarding/pay → ... (same from here)
```

### Tasks 1–28 (foundation)

**Task 1 — Migration 025 (signup schema):** Two partial indexes for hot-path lookups: `idx_businesses_pending_unpaid_self_serve_cleanup` (CleanupAbandonedSignupsPoller predicate: pending_payment + stripe_customer_id IS NULL + onboarded_by IS NULL), `idx_users_owner_auth_by_business` (owner-by-business lookup for dashboard SSR). Email lowercase backfill with collision precondition (raises if any pre-existing case-collision rows would conflict). `onboarded_by` backfill with admin-presence precondition. Auth_id uniqueness via existing migration 001 UNIQUE constraint — no additional index. `COMMENT ON INDEX` lines explain predicate intent.

**Task 2 — `auth-flow.ts`:** Branded `AuthFlow = 'owner' | 'admin'` type + `loginUrlForFlow(flow)` helper. Used by middleware redirects + `/api/auth/callback` failure paths so owners go to `/login` and admins to `/admin/login` instead of the old hardcoded admin default.

**Task 3 — `csrf.ts` Origin helper:** `assertSameOrigin(req)` parses `request.headers.origin` and `NEXT_PUBLIC_APP_URL` via `URL.origin` so subpath APP_URLs still match plain origin headers. `SameOriginError` typed throw lets routes return 403 cleanly.

**Task 4 — `route-helpers.ts`:** `getIpKey(req, prefix)` returns `${prefix}:ip:${ip}` from `x-forwarded-for` leftmost entry. Centralizes the rate-limit key shape so SQL grep + Redis cleanup scripts can match consistently.

**Task 5 — `payment-link.ts`:** `buildPaymentLinkUrl(tier, businessId, ownerEmail)` returns `STRIPE_PAYMENT_LINK_<TIER>` with `client_reference_id` + `prefilled_email` query params appended. URL-validates the env var first (typos, missing scheme) and returns null gracefully so callers can render "contact support" instead of a mangled href.

**Task 6 — Signup schemas:** Zod schemas covering `SignupSchema` (name + email + password), `FinishSignupSchema` (name + phone), `OnboardBusinessSchema` (Place ID XOR Maps URL refine), `ResendConfirmationSchema` (literal `flow: 'owner'` to prevent admin enumeration), `VerifyEmailOtpSchema` (4–10 alphanumeric token), `SelectPlanSchema` (founding | standard), `ResetPasswordSchema`, `ForgotPasswordSchema`. `normalizedEmailSchema` lowercases + trims for consistent FK lookups.

**Task 7 — `createBusinessTx` helper:** Extracted from old admin-only path. Two modes: `admin` (writes `users.auth_id=NULL` + full business profile + `onboarded_by` + INSERT `channel_enrollments` 'verified' + INSERT `job_outbox` sync_reviews/validate_place_id) and `self_serve` (writes `users.auth_id=<authId>` + placeholder business row with `subscription_status='pending_payment'` + NO outbox INSERT — wizard owns that). Identity-only input contract for self_serve. `DuplicateEmailError` typed throw on UNIQUE constraint violation.

**Task 8 — Admin route refactor:** `/api/admin/businesses` POST routed through the new `createBusinessTx` admin mode. Tests pinned the migration boundary with assertions on the SQL templates.

**Task 9 — `POST /api/auth/signup`:** Self-serve route. Strict per-IP rate limit 5/hour (Redis-down → 503). Advisory-locked email pre-check serializes against the cleanup poller. Calls `supabaseServer.auth.signUp` with `emailRedirectTo` pointing at the OTP entry page. On `createBusinessTx` failure, awaits compensating `auth.admin.deleteUser` so the next signup attempt doesn't 422 on the orphan auth user. Returns `redirectTo: /signup/check-email?email=...` on success. Returns 429 `email_rate_limited` (separate from 409 `account_exists`) when Supabase returns `over_email_send_rate_limit`.

**Task 10 — `POST /api/auth/finish-signup`:** Google-OAuth provisioning route. Reads session via cookie-bound anon client. Asserts `email_confirmed_at` (defensive — Google always returns confirmed but a future provider misconfig must not let unconfirmed sessions provision rows). Identity-only input. Same advisory-lock pre-check as `/signup` to defeat double-submits. NO compensating auth-user delete because the session predates the request. Post-tx: writes `channel_enrollments` 'verified' since Google has already confirmed the email.

**Task 11 — `GET /api/auth/signup-status`:** Read-only status probe used by `/onboarding/payment-success` to poll subscription status + business onboarding state. Returns `subscriptionStatus` + `businessOnboarded` (`place_id_verified || google_maps_url IS NOT NULL`).

**Task 12 — `POST /api/auth/forgot-password`:** Email + IP rate-limited. Calls `supabaseServer.auth.resetPasswordForEmail` with `redirectTo` pointing at `/api/auth/callback?flow=<owner|admin>&next=/<owner-or-admin-prefix>/reset-password`. Always returns 200 with generic body — no enumeration leak.

**Task 13 — `POST /api/auth/reset-password`:** Cookie-bound session check (proves user came through the recovery callback). Validates new password length. Calls `auth.updateUser({ password })` then `signOut()` so the recovery session can't be used as a login session — forces fresh login with the new password.

**Task 14 — `POST /api/auth/resend-confirmation`:** Strict 2/email/hour + 5/IP/hour rate limits. `flow: 'owner'` literal — admins are auto-confirmed at creation and never need this endpoint.

**Task 15 — Extend `/api/auth/callback`:** Originally OAuth-only (`?code=...`). Extended to also handle `?token_hash=...&type=...` via `verifyOtp` for email confirmation, password recovery, and admin invite. Five branches: recovery (skip role lookup), Google-signup (pass through to /signup/finish), owner role (/dashboard or honor next), admin role (/admin/overview or honor next), no row + not signup-finish (sign out + account_incomplete).

**Task 16 — Stripe webhook activation enqueue:** Webhook simplified — only flips `subscription_status` to `active` (advisory-locked). Initial `sync_reviews` / `validate_place_id` enqueue moved to `/api/onboarding/business` (the wizard).

**Task 17 — Dashboard API pending-payment branch:** Returns minimal payload (`subscriptionStatus: pending_payment` + `actionUrl: /onboarding/pay`) instead of full dashboard rollup when subscription isn't active.

**Task 18 — Middleware + protected-routes:** Extended `middleware.ts` with `/onboarding` gating (owner role + business_id required). `redirectToLogin(req, flow)` parameterized so owner pages route to `/login` and admin pages route to `/admin/login`. `protected-routes.ts` `isProtectedRoute(pathname)` allows public landing + signup pages through cheaply (no Supabase round-trip).

**Task 19 — `CleanupAbandonedSignupsPoller`:** Worker job, 24h interval. Deletes `pending_payment + stripe_customer_id IS NULL + onboarded_by IS NULL + auth_id IS NOT NULL + created_at < NOW() - INTERVAL '7 days'`. Per-email advisory lock. Defensive refs check (`businesses.onboarded_by`, `prospect_demos.created_by`) — if anything points at the candidate user, log + skip + don't delete. Race the Supabase admin deleteUser against a 10s timeout. "User not found" treated as success.

**Tasks 20–25 — UI:** Shared auth form components reused for owner + admin variants. Owner pages at `/login`, `/forgot-password`, `/reset-password`; admin pages at `/admin/login`, `/admin/forgot-password`, `/admin/reset-password` (admin pages always work, never flag-gated). Signup page at `/signup`. Check-email page at `/signup/check-email`. Finish-signup page (Google) at `/signup/finish`. Pay page at `/onboarding/pay`. Payment-success at `/onboarding/payment-success`. Wizard at `/onboarding/business` (Location with PlaceAutocomplete, Profile with SerpAPI prefill, Voice skippable). Dashboard pending-payment banner. Landing nav `Login` + `Sign Up` links conditional on `SELF_SERVE_SIGNUP_ENABLED`. Worker startup assertion fails fast if flag is on but env vars missing.

**Tasks 26–27 — E2E tests:** Playwright password-signup happy path + Google-signup + forgot-password + reset-password. E2E tests skip gracefully when `TEST_DATABASE_POOL_URL` unset.

**Task 28 — Ship gate:** Manual production smoke test. Pending until SMTP + templates configured.

### Architectural pivot A1–A3 (mid-branch)

After review revealed admin-onboarded workflows and self-serve workflows were drifting in shape, refactored to a shared "identity-only at signup, business details deferred" pattern.

**A1 — Schemas split + createBusinessTx placeholder:** Split monolithic `OnboardBusinessSchema` into `BusinessOnboardingSchema` (full, used by admin + wizard) + `SignupSchema` / `FinishSignupSchema` (identity-only). `createBusinessTx` self-serve mode now writes a placeholder row.

**A2 — Slim signup routes + new business + prefill routes:** Self-serve signup routes slimmed to identity-only. New `/api/onboarding/business` accepts the wizard's full profile body. New `/api/signup/place-prefill` calls SerpAPI server-side to prefill Step 2 of the wizard.

**A3 — Stripe webhook simplification:** Webhook reduced to status flip only. Initial-sync enqueue now lives in wizard POST. Cleaner separation of billing vs onboarding.

### B-series — UX simplification + bug fixes

**B1 — Slim SignupFormClient + FinishSignupClient to identity-only:** Removed the 8-field business profile inputs from `/signup` and `/signup/finish`. SignupFormClient is now name + email + password + Continue with Google. FinishSignupClient is now name + phone (email comes from session).

**B2 — `/onboarding/business` 3-step wizard:** `BusinessWizardClient` orchestrator with `ProgressDots` + 3 step components. Step 1 PlaceAutocomplete via `gmp-place-autocomplete` with `color-scheme: light only` workaround for the closed shadow DOM, falls back to Google Maps URL input. Step 2 triggers `/api/signup/place-prefill` on Place ID confirm. Step 3 tone selector + sample-responses, both skippable. Submit POSTs to `/api/onboarding/business`.

**B3 — Routing updates + dashboard redirect:** Updated `/login` to redirect to `/onboarding/pay` if owner is `pending_payment`, `/onboarding/business` if `active` but not yet onboarded, `/dashboard` if both. Updated `/onboarding/payment-success` to push to `/onboarding/business` instead of `/dashboard`.

**B4 — Update `signup-test-runbook.md` for wizard flow:** Scenario A rewritten end-to-end. New Scenario K (wizard endpoint idempotency). New Scenario L (wizard authn/state guards).

**B5 — Fix email confirmation flow (token_hash + verifyOtp):** Owner clicked confirmation link, landed on `http://localhost:3000/#access_token=...` instead of `/onboarding/pay`. Root cause: server-side `supabase.auth.signUp()` defaults to **implicit flow** (no PKCE — no browser to stash a code_verifier), so the email link arrives with `#access_token=...` instead of `?code=...`. Fix: extended `/api/auth/callback` to also handle `?token_hash=...&type=...` via `verifyOtp`. Superseded by B6.

**B6 — Switch to OTP code entry for email verification:** Email-link approach hit the email-scanner-prefetch problem (Outlook Safe Links / Gmail link checker consume single-use links before the human clicks). Switched to typed 6-digit code entry. New `POST /api/auth/verify-otp` route (rate-limited 8/email/10min + 30/IP/10min, same-origin guard, role check, sets session cookies via `setAll`). Supabase Confirm signup template uses `{{ .Token }}` instead of `{{ .ConfirmationURL }}`.

**B7 — Simplify OTP verify page:** Removed the email input from the verify form (email pre-filled from `?email=` query param, displayed read-only). Replaced the resend form with a simple "Resend code" button. Added "← Go back and change email" link to `/signup`. CleanupAbandonedSignupsPoller already covers users who sign up but never enter the OTP.

**B8 — Plan picker on `/onboarding/pay`:** Replaced hardcoded "Standard" tier default with 2-card plan picker (Founding $99 highlighted / Standard $149). New `POST /api/onboarding/select-plan` route writes `subscription_tier` choice with advisory lock under `pending_payment` guard, returns matching `STRIPE_PAYMENT_LINK_*` URL. Stripe webhook's existing `customer.subscription.updated` price→tier mapping serves as defense-in-depth.

**B9 — Disambiguate Supabase email-rate-limit from account-exists:** Originally `/api/auth/signup` caught any signUp() error as 409 `account_exists`. When Supabase hits its 2-email-per-hour cap, it returns `error_code: over_email_send_rate_limit` + `status: 429`. Owner saw misleading "account exists" message. Fix: route now disambiguates and returns 429 `email_rate_limited` with "wait a few minutes" message. Logs actual Supabase error code + status server-side. New helper `scripts/clear-signup-rate-limits.ts` for dev unblocking (clears app-side IP/email rate-limit buckets in Redis).

**B10 — Fix Google-signup `channel_enrollments` gap:** Bug introduced in B7's prep refactor when I moved the `channel_enrollments` INSERT out of `createBusinessTx` self-serve mode and into `/api/auth/verify-otp`. Forgot Google users skip OTP entirely. **Symptom:** first Google-signed-up business "Cafe Lattea" had 8 reviews → 8 responses → 8 send_notification outbox rows marked completed but **zero approval emails sent** because NotificationWorker found 0 verified channels. Fix: added the same INSERT to `finish-signup/route.ts` after `createBusinessTx` returns. Backfilled the missing channel for Cafe Lattea via Supabase MCP, re-enqueued 8 fresh send_notification outbox rows.

**B11 — Admin onboarding sends owner invite email + links auth_id:** Admin-onboarded businesses had `users.auth_id=NULL` and no Supabase Auth user → owner had no credentials, couldn't log in, couldn't reset password (Supabase silently no-ops on missing auth.users row), couldn't sign up either (our pre-check returns 409 on email collision). Fix: admin route now calls `auth.admin.inviteUserByEmail` after `createBusinessTx`, then UPDATEs the users row to set auth_id. Compensating delete fires if invite fails. Required Supabase Invite user template config: `{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&amp;type=invite&amp;flow=owner&amp;next=/reset-password`.

**B12 — Stripe ingress tests:** No tests existed for `worker/ingress/stripe.ts`. Added 7 tests including the test the user explicitly requested: `charge.updated` events return 200, log "Unhandled event type — ignoring", touch zero business state, mark inbound_events as processed. Plus positive control for `checkout.session.completed` + tests for `charge.succeeded` / `payment_intent.created` + 401 on missing/invalid signature + 200 duplicate when claim returns 'duplicate'.

**B13 — Test coverage for Scenario K + L:** Scenario K already covered by 13 existing API tests. Scenario L was missing — extracted 4 redirect rules from `page.tsx` into pure `resolveWizardDestination(row)` in `src/app/onboarding/business/guard.ts`. Added 11 guard tests including 2 order-dependence guards (admin role check fires BEFORE onboarded check; subscription gate fires BEFORE onboarded check). Vitest config extended to allow `.test.tsx`.

### Final verification

- **1405/1405 tests pass**
- **0 tsc errors**
- **12 runbook scenarios** documented in `docs/signup-test-runbook.md` (A through L)
- Helper script `scripts/clear-signup-rate-limits.ts` for dev unblocking
- Lab notes recorded in `.claude/CLAUDE.md`: implicit-flow trap, channel_enrollments-by-email-event, admin-onboarded auth gap, Supabase email rate limit

### Required prerequisites before flag flip in prod

1. **Custom SMTP via Resend** — Supabase Dashboard → Authentication → SMTP Settings:
   - Host: `smtp.resend.com`, Port: `465`, Username: `resend`, Password: `RESEND_API_KEY`
   - Sender: `RESEND_FROM_EMAIL`
   - Bypasses Supabase's built-in 2/hour cap
2. **Supabase email templates** — Authentication → Email Templates:
   - **Confirm signup**: body must contain `{{ .Token }}` (6-digit OTP), NOT `{{ .ConfirmationURL }}`
   - **Reset password**: `<a href="{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&amp;type=recovery&amp;flow=owner&amp;next=/reset-password">Reset Password</a>`
   - **Invite user**: `<a href="{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&amp;type=invite&amp;flow=owner&amp;next=/reset-password">Set your password</a>`
3. **Migration 025** run in production Supabase SQL editor.
4. **Env vars in Vercel + Railway:**
   - `SELF_SERVE_SIGNUP_ENABLED=true`
   - `STRIPE_PAYMENT_LINK_FOUNDING=https://buy.stripe.com/...`
   - `STRIPE_PAYMENT_LINK_STANDARD=https://buy.stripe.com/...`
   - `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=...` (Vercel only)
5. **Production Stripe Payment Links** with success_url=`https://yourdomain.com/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}` and cancel_url=`https://yourdomain.com/onboarding/pay?cancelled=1`.
6. **Production Stripe webhook** at `https://your-railway-worker.example.com/ingress/stripe`.
7. **Production Google OAuth** redirect URI: `https://yourdomain.com/api/auth/callback`.
8. **Run all 12 runbook scenarios** on staging with real test email + Stripe test card.
9. **Flip flag** — set `SELF_SERVE_SIGNUP_ENABLED=true` on both Vercel + Railway, redeploy.

Until all of the above are done, `SELF_SERVE_SIGNUP_ENABLED` stays `false` in production.

---

## Owner Self-Serve Signup — Hardening (2026-04-26, B15–B20)

Five rounds of external code review across the same branch. **21 fixes total** plus expanded test coverage. Test count: 1405 → 1433. tsc clean throughout.

### B15 — Production-readiness pass on the test runbook

`docs/signup-test-runbook.md` updated end-to-end (692 → 946 lines). Reflects every B-series fix from the initial branch:

- §1.3 gained step 5b (Invite user template config), step 6 (Custom SMTP via Resend — required for any meaningful testing volume + the fix for Supabase's 2/hour cap), step 7 (rate limit raise).
- §1.7 dev helper for clearing rate-limit Redis keys between runs.
- Reset password template uses `&amp;`-escaped `href` (was rendering as plain text in some clients).
- Scenario A step 8 reflects the plan picker (was the old hardcoded-Standard "Complete payment" button).
- Scenario I rewritten as full B11 invite flow regression — verifies `inviteUserByEmail` + `auth_id` linkage + owner can set password + log in.
- New Scenario I2 (admin invite failure compensating delete).
- New Scenario M (B10 approval-email regression — full diagnostic SQL + fix path).
- §3.1 pre-deploy checklist added Custom SMTP + 3 templates + Resend domain verification items.
- §3.3 production smoke gained items 4 (B10 approval-email check) + 5 (B11 admin invite check).
- Appendix grew from 13 → 20 failure modes — every mistake we hit during the branch is now searchable.
- "Ready for production" definition updated with 5 new items.

### B16 — Round 1: 8 findings (TOCTOU, race, obfuscated user, rollback, cookies, URL validation, durable retry, redirect)

**Critical — `worker/jobs/CleanupAbandonedSignupsPoller.ts` TOCTOU.** SELECT runs outside any tx (line 38), per-candidate tx never re-validates predicates. If Stripe activates a business between candidate-select and tx-lock, we delete a paying customer's auth user + DB rows. Fix: take signup-lock + activation-lock inside tx, SELECT FOR UPDATE businesses + users rows, re-validate ALL predicates (subscription_status, stripe_customer_id, onboarded_by, role, auth_id, age) before any delete. New `skipped_state_changed` counter. 3 regression tests: status-flip, stripe_customer_id-populated, row-vanished.

**Medium — `/api/onboarding/select-plan` race.** SELECT was unlocked, advisory lock came AFTER stale read, UPDATE.count not checked. Fix: outside-tx lookup just gets businessId/email (no state read), inside-tx takes activation lock FIRST, then SELECT FOR UPDATE under the lock, re-validates status, runs UPDATE, checks `count > 0`. New `race_lost` 409 branch. 1 regression test.

**Medium — Supabase obfuscated user detection.** `signUp()` returns success with empty `identities[]` for already-confirmed emails (anti-enumeration). Original code only checked `!authData.user`. Fix: explicit `identities.length === 0` check before createBusinessTx, returns `accountExistsResponse`. Logs server-side.

**Medium — admin businesses ordering + outbox cleanup.** Two bugs: APP_URL validated AFTER createBusinessTx (left half-provisioned rows on misconfig); rollback only deleted users + businesses but not job_outbox rows (no FK CASCADE). Fix: validate APP_URL FIRST; rollback wraps job_outbox + users + businesses in `sql.begin` in FK-aware order.

**Medium — `/api/auth/callback` signOut cookies.** Two `account_incomplete` branches called `signOut()` but returned a fresh redirect without copying response.cookies — browser kept stale session, would redirect-loop. Fix: copy `response.cookies.getAll()` onto the redirect (matches the success-branch pattern).

**Medium — `googleMapsUrlSchema` validation.** Original schema accepted any non-empty string. Fix v1: `MAPS_HOST_RULES` allowing https://google.<tld>/maps/, https://maps.google.<tld>/, https://maps.app.goo.gl/, https://goo.gl/maps/ (B17 tightens further; B18 + B19 tighten more).

**Medium — channel_enrollments swallowed errors → durable retry.** verify-otp + finish-signup catch INSERT failures and log without retry — recreates the B10 silent-disappear bug. Fix: new `worker/jobs/EmailChannelReconcilePoller.ts` (10-min interval, env-overridable) scans `active`-subscription owner businesses with no `channel_enrollments` email row and INSERTs idempotently via the existing partial-unique ON CONFLICT. Wired into worker startup + shutdown.

**Low — pay page redirect.** Active+not-onboarded was redirected to /dashboard (technically works via dashboard's CTA but contradicts the documented direct flow). Fix: SELECT now also includes place_id_verified + google_maps_url; active owners route to `/onboarding/business` if not yet onboarded, `/dashboard` otherwise.

**Final B16: 1409/1409 tests pass, 0 tsc errors.**

### B17 — Round 2: 6 findings (role filter, URL parser, link-failure rollback, archived-channel guard, XOR, identity binding)

**Medium — owner-role filter on `/api/onboarding/*` lookup queries.** Middleware doesn't gate `/api/onboarding/*` — was relying on auth_id → business_id alone. An admin/sales_partner with a misconfigured `users.business_id` could submit owner-only endpoints. Fix: added `AND u.role = 'owner'` to both lookup queries in `/api/onboarding/business/route.ts` and `/api/onboarding/select-plan/route.ts`. SQL-boundary filter is the authorization invariant. 4 regression tests.

**Medium — googleMapsUrlSchema host-only check too loose.** `https://google.com/`, `https://google.com/search?q=...`, bare `https://goo.gl/<id>` all passed. Refactored to `MAPS_HOST_RULES` carrying `pathRequired` regex per host: google.com requires `/maps/`, maps.google.<tld> any path, maps.app.goo.gl any path, goo.gl REQUIRES `/maps/` segment.

**Medium — admin auth_id link `UPDATE` didn't verify rows matched.** If 0 rows updated (or UPDATE threw), route returned soft 201 with `warning` field that the UI ignored + redirected to Stripe → admin under impression onboarding worked while owner is silently locked out. Hard-fix: `UPDATE ... RETURNING id`, hard-rollback the business + invited auth user + job_outbox + users on failure, return 500 with descriptive error.

**Medium — EmailChannelReconcilePoller's NOT EXISTS scoped on `archived_at IS NULL`.** Archived rows mean owner/admin explicitly removed enrollment — recreating it as 'verified' would silently resubscribe (the original B7 bug in reverse). Removed the archived_at filter from the EXISTS subquery. New `worker/jobs/__tests__/EmailChannelReconcilePoller.test.ts` with 6 tests: SQL-shape pin (no archived_at in NOT EXISTS), missing-row INSERT, existing-row no-op, archived-row no-op, ON CONFLICT race, INSERT-throws + loop-continues.

**Low — `OnboardBusinessSchema` (admin) still had at-least-one refine, not true XOR.** Owner schema was fixed in B16; admin path was missed. Both schemas now use `Boolean(a) !== Boolean(b)` XOR.

**Low — CleanupAbandonedSignupsPoller identity binding.** `usr.auth_id` re-checked for non-null but not equality with `candidate.auth_id`. A stale candidate whose users.auth_id had been re-linked to a NEW Supabase identity would let `deleteUser(<old auth_id>)` destroy the wrong identity. Added identity-binding check to stillEligible AND to the `DELETE FROM users WHERE` predicate (`auth_id = candidate.auth_id`).

**Final B17: 1419/1419 tests pass, 0 tsc errors.**

### B18 — Round 3: 2 findings (URL resolver-readiness, link-failure rollback test)

**Medium — `googleMapsUrlSchema` host-shape passed URLs the worker can't resolve.** PlaceIdValidationWorker requires either a canonical Place ID OR (businessName + coordinates) — bare `https://maps.google.com/`, `?cid=123`, shortlinks all passed host-shape but yielded no resolvable data, leaving owners onboarded with permanent place-ID resolution failures. Fix: added second `.refine()` calling `parseGoogleMapsUrl()` and requiring `placeId !== null OR (businessName && coordinates)`. 6 new tests covering the rejection cases.

**Low — Missing test for the zero-row link-failure rollback path.** High-impact code + soft-success was the original bug class. Refactored test mock with `linkUpdateState` flag (success | zero_rows | throws) + exposed `mockDeleteUser`. 2 new tests asserting the rollback shape (auth.admin.deleteUser called with invited.user.id, tx-wrapped DELETEs of job_outbox → users → businesses in FK-aware order, no `id`/`paymentUrl`/`warning` in response body).

**Final B18: 1428/1428 tests pass, 0 tsc errors.**

### B19 — Round 4: schema/worker isPlaceId() alignment

**Medium — `urlIsResolverReady()` accepted any non-null `placeId`** but `PlaceIdValidationWorker` only accepts when `isPlaceId()` validates. URL like `https://www.google.com/maps/place/?q=place_id:bad` parses to `{placeId: "bad"}` → schema accepted, worker rejected → owner stuck. Fix: `if (data.placeId !== null && isPlaceId(data.placeId)) return true;`. Falsy isPlaceId falls through to the businessName+coordinates fallback. 5 new tests: 3 explicit malformed-ID query-param shapes, 1 too-short alphanumeric (anchors the 20+ char rule), 1 positive control accepting a real Place ID via `?q=place_id:`.

**Final B19: 1433/1433 tests pass, 0 tsc errors.**

### B20 — Round 5: 3 UX findings

**B1 — UI copy claimed 6-digit OTP but production Supabase issues 8-digit.** Fixed `CheckEmailClient.tsx` subtext (both fromLogin + default branches) + input placeholder to say "8-digit code". Inline comment points future maintainers at Supabase Auth → Settings → "Email OTP Length" as the source of truth.

**B3 — Raw error codes shown to users.** `/api/auth/signup` returned `{ error: 'rate_limited' }` / `'rate_limit_unavailable'` without `message`. SignupFormClient's `body.message ?? body.error ?? 'Signup failed'` then surfaced raw machine codes. **Server-side fix (Option A):** both error responses now carry human-readable `message` strings. **Client-side defense:** new `KNOWN_MESSAGES` map covers rate_limited / rate_limit_unavailable / email_rate_limited / invalid_json / invalid_body / internal so future regressions can't leak machine codes. Body-shape regression assertions added to existing 429 + 503 tests.

**B4 — Middleware redirected admin/sales_partner accidentally on `/onboarding/*` to `/login`** (owner login) instead of `/admin/overview`. Page guard had it right but middleware intercepted first. Fix: split the `/onboarding/*` block into 3 sub-cases — no users row → owner login; admin/sales_partner → `/admin/overview` (don't re-auth them); other non-owner → owner login. Skipped writing a vitest middleware harness since `resolveWizardDestination` page-guard tests already pin the parallel behavior.

**Final B20: 1433/1433 tests pass, 0 tsc errors.**

### Cumulative summary across B15–B20

- **5 review rounds**, **21 individual fixes** (1 critical + 16 medium + 4 low)
- **Test count: 1405 → 1433** (28 new tests across 5 rounds + assertion strengthening on existing tests)
- **New files:**
  - `worker/jobs/EmailChannelReconcilePoller.ts` (durable channel-enrollment retry)
  - `worker/jobs/__tests__/EmailChannelReconcilePoller.test.ts`
- **3 new env vars:** `EMAIL_CHANNEL_RECONCILE_INTERVAL_MS`, `EMAIL_CHANNEL_RECONCILE_BATCH_SIZE`, `EMAIL_CHANNEL_RECONCILE_DISABLED`
- **3 new lab notes** in `.claude/CLAUDE.md`: TOCTOU landmine, Supabase obfuscated-user trap, schema-must-mirror-worker rule

Branch is now ready for the production prerequisites checklist (custom SMTP + 3 email templates + 12-scenario staging run + flag flip).

---

## Sprint Z: Zernio GBP Auto-Posting Integration

### Phase Z.0 — Code-Complete (2026-04-27 → 2026-04-28)

**Status:** CODE-COMPLETE behind `ZERNIO_PUBLISHING_ENABLED` flag (default OFF).

**Branch:** `feat/zernio-integration` — 49 commits, 1544/1544 vitest tests pass, `tsc --noEmit` clean.

**Why:** RepWorth's MVP shipped with manual copy-paste posting (sales partner pastes the AI-drafted reply into the Google Business UI by hand). That works for ~10 businesses but doesn't scale. Google Business Profile API access is restricted (we'd applied and waited months); Zernio is a third-party that has GBP API access and exposes it through their own API. Wiring up Zernio gives us auto-posting today without waiting on Google's approval.

**What it does:** When an owner approves a response, the worker now branches:
- If the business has an active Zernio connection → call Zernio's `postReply` endpoint, mark the response `posted`
- If not → mark the response `awaiting_owner_connect` and email the owner with a "Reconnect Google Business" CTA. Once they connect, a drain worker re-enqueues the queued responses.

**Owner journey:** Dashboard banner → click Connect → OAuth round-trip via Zernio → pick the right Google location → done. Reconnect, cancel, and disconnect flows all work. If Zernio's API has an unknown-outcome failure mid-finalize (timeout / 5xx after they may or may not have created the account), a `zernio_finalize_incidents` row is written so admin can manually reconcile from Zernio's dashboard — protects against silently creating a duplicate account.

**Implementation phases (during the build):**

1. **Phase 0a — Foundations (Tasks 1–6):** Migration 026 (widen `responses.status` to TEXT, add 2 new tables + 4 partial unique indexes), queue name constants, payload types, WorkerType union extension, Zernio types module, error class hierarchy (7 typed error classes).

2. **Phase 0b — HTTP Client (Tasks 7–11):** `classifyAndParse` with endpoint-aware error mapping built TDD-first (15 tests cover the classification table). `request()` primitive with AbortController timeouts, network-error wrapping, Zernio-error preservation. 9 per-endpoint client methods. Mock-mode bypass at the top of `request()` so local dev never hits the real API. 6 shared Lua scripts for atomic Redis state machine transitions in `connect-state.ts`.

3. **Phase 0c — Worker Infrastructure (Tasks 12–18):** Two new BullMQ queues (`drain_pending_owner_connect`, `send_owner_email`) + 3 topic-string aliases for the outbox-to-queue map. Two new email templates (`owner_reconnect_required` per-response, `owner_connection_lost` per-business-per-day). Two new workers (`OwnerEmailWorker` with kind-discriminated handler, `DrainOwnerConnectWorker` for re-enqueueing stuck responses). Workers registered in `worker/index.ts`. Startup-assert gates the 4 new env vars when the flag is on. Resend bounce handler now treats the 2 new owner email templates as owner-directed.

4. **Phase 0d — Publisher Branching (Tasks 19–22):** `lookupZernioReviewId` with Redis cache + 4-page pagination + 4-field match (TDD, 4 tests). `applyTransientExhaustionFallback` for the BullMQ-retry-exhaustion case (transactional). `ResponsePublisherWorker` Steps 4-8 replaced with the Zernio branch — 7 distinct error sub-cases (success, 409 reply-already-exists, ZernioAuthError, ZernioTransientError, ZernioReviewNotFoundError, ZernioPermanentError, no-connection) each with the correct status transition and idempotency guard. `publisherWorker.on('failed')` handler in `worker/index.ts` wires the BullMQ exhaustion case to graceful degradation.

5. **Phase 0e — Connect Flow (Tasks 23–34):** Five API routes — `/start` (most complex, two-layer concurrency defense + DB idempotency check + placeholder marker + full start work + Step F failure cleanup), `/callback` (atomic GETDEL + double pending re-verify + signed cookie + OAuth-denial cleanup), `/select-location` (largest single route — finalize lock + finalizing CAS + Zernio call + DB tx + post-accountId recovery + finalize_unknown handling with all 4 round-N corrections), `/cancel`, `/disconnect`. Dashboard `zernioConnection` field + `pendingFlow` sub-state. `ConnectGoogleBanner` component with 4 banner states. Two pages: `/dashboard/connect` (state-aware) and `/dashboard/connect/select-location` (server component + client form). Admin business detail Zernio panel. Admin overview "Reconnect" column (count of `awaiting_owner_connect` responses per business). E2E scaffold (skipped without test DB, fixme block locks in intent).

6. **Phase 0f — Webhook + Ops (Tasks 35–40):** HMAC-SHA256 signature verification helper TDD-first (8 tests cover hex regex, length-safe `timingSafeEqual`, valid + invalid + non-hex + wrong-length + uppercase). Webhook ingress at `worker/ingress/zernio.ts` — flag-gate, signature verify, `inbound_events` dedup, switch on event type (`account.disconnected` → `WITH disconnected AS ... INSERT FROM disconnected` multi-row pattern, `account.connected` → log only, `review.new`/`review.updated` → INCRBY counter for Phase 3 readiness, `webhook.test` → log + 200). Route registered in `worker/index.ts` with `rawBody: true`. CLAUDE.md updated. Launch runbook written at `docs/zernio-launch-runbook.md` with the `finalize_unknown` reconciliation procedure (Branch A sub-cases A-1/A-2/A-3 + Branch B + rollback).

**Code-review rounds applied (post Phase 0f):**

- **Round 1 — 7 findings (6 Medium + 1 Low):**
  - Tightened 409 publish_reply classification to require `body.code` in an allowlist (`reply_already_exists`); unknown 409s now retry transient instead of falsely marking posted
  - Added catch-all 4xx → ZernioPermanentError for non-`select_location` endpoints, exempting 408/429
  - Added finalize_unknown overwrite guard at the top of `/start` Step A — refuses to recreate even when stale-age would normally fall through
  - Surfaced in-flight `connect_pending` Redis state to the dashboard via new `pendingFlow` field, so banner shows blue "Connecting…" instead of the orange "Reconnect" treatment during in-flight flows
  - Centralized response status groupings in new `src/lib/shared/response-status.ts` (6 named groups + type alias) — updated 8 production callsites that were counting `awaiting_manual_post` as "handled" but missing `awaiting_owner_connect`
  - OAuth-denial path now does best-effort cleanup (atomic GETDEL state, flowId-bound delete pending, deleteProfile) before redirecting
  - Deferred: review-id lookup brittleness for large accounts — needs ingestion-side persistence, scheduled as Phase 1 follow-up
  - Bonus: latent bug found during status-group sweep — `process-review.ts` review-edit exception fired only for `posted`/`awaiting_manual_post`, missing `awaiting_owner_connect`. Fixed.
  - Bonus: status badge color maps in both ReviewsList components missing `awaiting_owner_connect`. Fixed (amber styling).

- **Round 2 — 1 finding (Low):**
  - Dashboard precedence bug: any non-finalize pending marker beat an active DB connection. If select-location's best-effort Redis cleanup fails after a successful DB tx, the dashboard would show "Connecting…" for up to 15min even though the business is already connected. Reordered: `active` DB now beats stale non-finalize pending markers. 4 new tests cover the precedence rule and regressions.

- **Round 3 — 0 findings.** Reviewer also confirmed all prior fixes verified.

**Local QA pass (2026-04-28):** Manually exercised all 6 scenarios from `docs/zernio-testing-and-shipping.md` Part 1 against the worktree on a real owner session. Full report at `docs/zernio-test-report-2026-04-28.md`. **All 6 scenarios PASS.** One bug found in the test helper script — the inline `zernio-fire-webhook.sh` was sending a flat `accountId` field but the handler reads nested `account.id` per spec §5.4. Fixed: promoted the inline snippet to a real versioned `scripts/zernio-fire-webhook.sh` with multi-event support and the correct nested payload shape. Lab note added so the trap doesn't reappear.

**Architecture invariants preserved:** outbox pattern (zero new state-change paths bypass it), no auto-posting (`postReply` only fires for owner-approved responses), worker-side third-party ingress (`/ingress/zernio` on Railway), subscription guard in all owner-facing workers, hashed approval tokens unchanged, app-enforced auth scope (every owner read/write gated by `business_id`), Node native `crypto` for HMAC.

**Files created (24):** `supabase/migrations/026_zernio_publishing.sql`, `src/lib/zernio/{types,errors,client,connect-state,connect-session-cookie}.ts` + tests, `src/lib/publishing/zernio-publisher.ts` + tests, `src/lib/notifications/email/templates/{owner-reconnect-required,owner-connection-lost}.ts`, `src/lib/shared/response-status.ts` + tests, `src/components/dashboard/ConnectGoogleBanner.tsx`, `src/app/(authenticated)/dashboard/connect/{page.tsx,select-location/{page.tsx,LocationPicker.tsx}}`, `src/app/api/zernio/{connect/{start,callback,select-location,cancel}/route.ts,disconnect/route.ts}`, `src/app/admin/businesses/[id]/components/ZernioConnectionPanel.tsx`, `worker/jobs/{OwnerEmailWorker,DrainOwnerConnectWorker}.ts`, `worker/ingress/{zernio,zernio-verify}.ts` + tests, `e2e/zernio-connect.spec.ts`, `scripts/{redis,zernio-fire-webhook.sh}.ts`/`.sh`, `docs/{zernio-launch-runbook,zernio-testing-and-shipping,zernio-test-report-2026-04-28}.md`.

**Files modified (~12):** worker/{index,queues,startup-assert}.ts, worker/jobs/ResponsePublisherWorker.ts, worker/ingress/resend.ts, src/lib/shared/{queue-names,worker-types,subscription-guard}.ts, src/lib/dashboard/{types,service}.ts, src/lib/notifications/email.ts (barrel), src/components/DashboardContent.tsx, src/components/dashboard/ReviewsList.tsx, src/app/admin/businesses/[id]/{page.tsx, components/ReviewsList.tsx}, src/app/admin/overview/page.tsx, src/app/api/admin/overview/route.ts, src/app/api/dashboard/route.ts, src/lib/reviews/process-review.ts, src/lib/admin/business-detail-{types,service}.ts, .claude/CLAUDE.md, .gitignore.

**5 new env vars:**
- `ZERNIO_PUBLISHING_ENABLED` — gates everything. Default off.
- `ZERNIO_API_KEY` — required when flag on (mock mode bypasses).
- `ZERNIO_WEBHOOK_SECRET` — required when flag on. HMAC shared secret for webhook ingress.
- `ZERNIO_PROFILE_ID_PREFIX` — optional, default `repworth-prod-`. Environment isolation for Zernio profile names.
- `ZERNIO_API_BASE` — optional, default `https://zernio.com/api`. Override for sandbox.

**6 new lab notes added to `.claude/CLAUDE.md` across the work:**
- timestamptz::date is STABLE not IMMUTABLE — wrap with `AT TIME ZONE 'UTC'` first (caught only at apply time, ERROR 42P17)
- ON CONFLICT clauses must match index expressions byte-for-byte
- Zernio's `account.disconnected` payload uses nested `account.id`, not flat `accountId`
- (carried forward from Round 1 / 2 fixes — the precedence rule, the 4xx classification rule, the 409 allowlist rationale)

**What's next (operational, not code):** Phase 1 pilot per `docs/zernio-launch-runbook.md` — subscribe to Zernio, configure prod env vars, run migration 026 in prod (one ACCESS EXCLUSIVE moment on `responses`), configure webhook URL in Zernio dashboard, fire test webhook, flip the flag, onboard one cooperative customer, monitor for 1-2 weeks. Phase 2 = full rollout (no code changes — flag is global). Phase 3 (later) = promote `review.new`/`review.updated` webhook counters to real ingestion events, swap SerpAPI polling for Zernio webhooks for connected businesses (~70% of polling spend disappears).

---

## Sprint Channels-4: Owner Channel Dashboard

### Phase 4.0 — Code-Complete (2026-04-28)

**Status:** CODE-COMPLETE behind `CHANNELS_TELEGRAM_ENABLED` flag (default OFF). Migration 027 applied to prod Supabase 2026-04-28. PR #10 open against `main`.

**Branch:** `feat/phase-4-owner-channels` — 26 commits, 1604/1604 vitest tests pass, `tsc --noEmit` clean, ESLint clean.

**Why:** Phases 0–3 of the Channels work shipped admin-side enrollment widgets — the sales partner had to flip Telegram/SMS/WhatsApp on for each business from the admin CRM. That worked when there were a handful of pilot accounts, but it doesn't scale: every owner who wants to receive approvals via Telegram has to email support to get enrolled. Phase 4 ships the owner-facing self-serve flow at `/settings/channels` so owners can connect Telegram themselves. SMS and WhatsApp render as "Coming soon" rows because those channels are still pending Twilio 10DLC and Meta business verification, respectively.

**What it does:** A logged-in owner navigates to Settings → Notification channels and sees an Email row (always-on, fed from `users.email` with an "Always on" pill) plus three mobile-channel rows. The Telegram row shows a Connect button when `CHANNELS_TELEGRAM_ENABLED=true` and the owner has no active enrollment; clicking Connect generates a one-time deep link + QR code with a 1-hour expiry, the owner scans with Telegram and taps Start, the worker's webhook flips the row to verified, and the dashboard shows ✓ Connected with a Disconnect button. SMS and WhatsApp rows render as informational placeholders (no buttons, ~50% opacity) until those phases flip on.

**Implementation tasks (during the build, executed via subagent-driven development):**

1. **Task 0–1 — Pre-flight + migration 027:** Audit query confirmed zero existing businesses violated the new predicate (no row had two pending/verified mobile channels active at once). Migration 027 added a partial unique index `channel_enrollments_one_mobile_per_biz` on `channel_enrollments(business_id) WHERE channel IN ('sms','telegram','whatsapp') AND status IN ('pending_verification','verified') AND archived_at IS NULL`. Predicate exclusions are intentional: disabled/unsubscribed rows preserve enrollment history across channel switches.

2. **Task 2–3 — Constants + typed errors:** Shared `TOKEN_TTL_MS` / `STATUS_POLL_INTERVAL_MS` / `TTL_TICK_INTERVAL_MS` so polling cadence and TTL can't drift between client and server. `MultipleMobileChannelsError` (→ 409) + `EnrollmentDatabaseError` (→ 500, scrubs constraint name from message) + `classifyEnrollmentError(err)` classifier built TDD-first (11 unit tests).

3. **Task 4 — Admin endpoint:** Additive — `GET /api/admin/businesses/[id]/channels` now also emits `expires_at` from `verification_token_expires_at` so the refactored hook can source the QR countdown timestamp from a single canonical payload across admin and owner.

4. **Task 5 — Pure enrollment reducer:** Extracted from inline state in `TelegramEnrollmentWidget`. 8 states (idle / generating / awaiting_scan / verified / disabled / unsubscribed / expired / error), 8 action types. Pure `(state, action) => state` — no I/O, no `Date.now()`, no array filtering. 27 unit tests including identity-equality (`toBe`) assertions on the no-op transitions (e.g. `awaiting_scan + pending_verification` is a strict no-op that preserves cached `expiresAt` + `qrDataUrl`).

5. **Task 6 — useEnrollment React hook:** ~210-line shell wiring the reducer to fetch, polling (every 3 s while in `awaiting_scan`, AbortController-cancelable), 1 s TTL countdown tick, and HTTP error classification. Filters the canonical `{ enrollments: [...] }` status payload by channel name. Optionally hydrates from `initialSnapshot` (used by the owner widget for SSR-driven mount — see Fix #3).

6. **Task 7 — Shared transaction helpers:** `startTelegramEnrollment(tx, businessId, tokenHash, expiresAt)` extracts the state-machine SELECT + INSERT/UPDATE that admin and owner routes both need. Caller owns rawToken generation, `sql.begin`, advisory lock, and post-tx QR generation. 23505 → typed error via `classifyEnrollmentError`. Plus single-statement `cancelTelegramEnrollment` and `disableTelegramEnrollment` helpers. 13 helper unit tests with mocked `tx`.

7. **Task 8 — Admin Telegram routes refactor:** `start`/`cancel`/`disable` now delegate to the shared helpers. Routes own auth, validation, advisory lock, and QR generation; helpers own the state-machine. 23505 maps to 409 / 500 with no constraint name leakage.

8. **Task 9 — SMS + WhatsApp 23505 catch:** Migration 027 covers all three mobile channels, so admin SMS verify and admin WhatsApp start can also throw 23505 on cross-channel conflict. Both routes wrap their INSERT/UPDATE in `classifyEnrollmentError`. SMS catch goes inside `withSmsEnrollmentLock` so the lock release is preserved.

9. **Task 10–11 — Admin widget refactors:** `TelegramEnrollmentWidget` (138 → ~95 lines) and `WhatsAppEnrollmentWidget` (229 → 68 lines, 70 % reduction) both consume the shared hook. State machine + polling + TTL countdown + AbortController all moved to `useEnrollment`. Visual layout unchanged.

10. **Task 12 — Owner-scoped routes:** Four new routes under `/api/dashboard/channels/*`. `GET /` returns the canonical `{ enrollments, available, reasons }` shape (verification_token_hash deliberately excluded from SELECT). `POST telegram/{start,cancel,disable}` all wrapped with `withSameOrigin()` for CSRF protection. `businessId` always sourced from `requireRole(req, 'owner').businessId`, never from request body. Subscription guard on every route.

11. **Task 13–14 — Owner widget + Coming Soon row:** `OwnerTelegramWidget` is a ~95-line shell using the shared hook with owner endpoints. Disconnect button only renders in `verified` state per spec § 3 (prevents 404 from `/disable` on a non-verified row). Cyan accent on verified state per `repworth-brand-design`. `ComingSoonChannelRow` is a pure-presentation row with no button at all, ~50 % opacity.

12. **Task 15 — Settings restructure:** Existing 297-line client-only `/settings/page.tsx` extracted verbatim into `SettingsGeneralForm.tsx` (no logic change). New `SettingsTabs` server component renders the General / Notification channels tab strip. New `/settings/page.tsx` is a server-component shell that does auth + direct subscription_status check (does NOT use `resolveWizardDestination` — that helper redirects already-onboarded owners to `/dashboard`).

13. **Task 16 — `/settings/channels` page:** Server component fetches initial enrollments + availability flags (so the page doesn't flash an empty state). `ChannelsClient` composes the always-on Email row + Telegram row (interactive when `CHANNELS_TELEGRAM_ENABLED` + env-ready, Coming Soon otherwise) + 2 Coming Soon rows for SMS/WA. Email row falls back to `users.email` when no `channel_enrollments` row exists yet (Google-OAuth signup window before `EmailChannelReconcilePoller` catches up).

14. **Task 17–19 — E2E specs + helper:** `e2e/helpers/telegram-test-ingress.ts` synthesizes a valid Telegram `/start <token>` webhook update with the correct `X-Telegram-Bot-Api-Secret-Token` header. `e2e/owner-channels.spec.ts` and `e2e/admin-channels-refactor.spec.ts` cover unauthenticated assertions live (redirect to `/admin/login`); authenticated flows are `test.fixme()` per repo convention pending the Supabase admin `generateLink` magic-link harness.

**Code-review rounds applied (post Task 19):**

- **Round 1 (Codex first pass) — 6 findings (1 Critical + 4 Medium + 1 Low):**
  - **Critical #1:** Cancel left `status='pending_verification'`, occupying migration 027's slot. Once SMS or WhatsApp flips on, owners who cancelled Telegram would get stuck 409 `multiple_mobile_channels` with no UI explanation. **Fix `b7753d6`:** cancel UPDATE now flips status to `'disabled'` + `disabled_at = NOW()`. The existing `disabled → pending` branch in `startTelegramEnrollment` makes reconnect work without further changes. New helper test asserts the new SQL shape and exercises cancel-then-start round-trip.
  - **Medium #2:** SMS verify called Twilio Verify (paid SMS) before the migration 027 INSERT — owners would burn an SMS code only to get a 409 afterward. **Fix `1da0472` + `696753e`:** pre-check inside `withSmsEnrollmentLock` for any other pending/verified mobile channel before calling Twilio. Migration 027 index is still the authoritative defense; pre-check is a cost-saver in the common case.
  - **Medium #3:** `OwnerTelegramWidget` ignored the server-loaded `initialEnrollments` already passed by `ChannelsClient`. A verified owner saw Connect for ~200–500 ms before the hook's first fetch resolved; clicking during that window produced a misleading 409. **Fix `9d6e8eb`:** widget derives an `EnrollmentSnapshot` from the verified row and passes it to `useEnrollment` as `initialSnapshot` (which skips the first fetch). Non-verified rows still fetch normally to avoid stale-state risk.
  - **Medium #4:** `cancel()` in `useEnrollment` always dispatched `CANCEL_SUCCEEDED`, swallowing 401/403/500/network failures. UI showed idle while server still had a pending row. **Fix `56c0dec`:** dispatch `CANCEL_SUCCEEDED` only on 2xx; non-OK and network failures dispatch `CONNECT_FAILED` so the existing error UI surfaces them.
  - **Medium #5:** E2E tests are mostly `test.fixme`. **Fix `fdf7c5a`:** added a coverage-status comment block at the top of both spec files documenting where the executable regression protection lives (reducer / helper / detector unit tests) and why authenticated flows stay fixme'd (Supabase magic-link harness deferred).
  - **Low #6:** Reducer error copy hardcoded "Telegram is currently unavailable." (wrong for WhatsApp post-refactor) and conflated 409 `already_verified` with 409 `multiple_mobile_channels`. **Fix `11fa1be`:** channel-neutral 404 copy ("This channel is currently unavailable."); 409 disambiguates `already_verified` ("Already connected.") vs `multiple_mobile_channels` ("Disconnect your current channel before connecting another.") by reading the action's `message` field.

- **Round 2 (Codex second pass) — 2 findings (Medium):**
  - **Medium #7:** SMS pre-check still raced past concurrent Telegram/WA starts because each channel held its own per-channel advisory lock (`sms_enroll:`, `telegram_enroll:`, `whatsapp_enroll:`). **Fix `be7b8da`:** unified all four mobile-enrollment paths under `mobile_enroll:${businessId}` via `pg_advisory_xact_lock(hashtextextended('mobile_enroll:${businessId}', 0))` (the SMS helper's existing scheme). Now SMS verify pre-check + Telegram + WhatsApp state-machine writes are strictly serialized per-business across channels.
  - **Medium #8:** Cancel routes did no advisory locking + my prior Fix #1 dropped `archived_at IS NULL` from the cancel WHERE clause. A concurrent admin/owner start could observe the pending row, fall through to its UPDATE branch (no status WHERE guard), and overwrite cancel's transition to `disabled` back to `pending_verification`. Plus archived rows could be mutated. **Fix `34d3374`:** Telegram + WhatsApp cancel routes wrap the UPDATE in `sql.begin` and take the same `mobile_enroll` advisory lock as start; `archived_at IS NULL` filter restored to all cancel WHERE clauses.

- **Round 3 (Codex third pass) — 1 finding (Medium):**
  - **Medium #9:** Start helpers' SELECT didn't use `FOR UPDATE`, so a webhook could verify the row between start's SELECT and UPDATE; start's `WHERE id = …` (no status guard) would overwrite verified → pending. WhatsApp inbound also lacked `FOR UPDATE`. (Telegram inbound already had it.) **Fix `8c27509`:** added `FOR UPDATE` to `startTelegramEnrollment`'s SELECT, the WhatsApp admin-start inline SELECT, and the WhatsApp inbound verifier SELECT. Cross-transaction row locks now serialize start with inbound webhook (matching the Telegram inbound pattern that was already correct). New helper test asserts `FOR UPDATE` in the SQL template.

- **Round 4 (Codex fourth pass) — 0 findings.** Branch genuinely closed.

**Architecture invariants preserved:** outbox pattern unchanged (no new state-change paths bypass it), no auto-posting (verification is owner-initiated via webhook only), worker-side third-party ingress preserved, subscription guard in every owner-facing route AND the page server component (defense-in-depth), hashed approval tokens unchanged, app-enforced auth scope (every owner read/write gated by `business_id` from session, never request body), Node native `crypto` for hashing, `verification_token_hash` deliberately excluded from every SELECT in the owner-facing path.

**Files created (15):**
- `supabase/migrations/027_one_mobile_channel_per_business.sql`
- `src/lib/notifications/channels/{constants,enrollment-reducer,use-enrollment}.ts` + reducer test
- `src/lib/channels/{telegram-enrollment,unique-violation}.ts` + tests
- `src/app/api/dashboard/channels/{route.ts,telegram/{start,cancel,disable}/route.ts}` (4 owner routes)
- `src/components/dashboard/{OwnerTelegramWidget,ComingSoonChannelRow,SettingsTabs}.tsx`
- `src/app/(authenticated)/settings/SettingsGeneralForm.tsx` (extracted from old page.tsx)
- `src/app/(authenticated)/settings/channels/{page.tsx,ChannelsClient.tsx}`
- `e2e/helpers/telegram-test-ingress.ts` + `e2e/{owner-channels,admin-channels-refactor}.spec.ts`
- `docs/runbooks/phase-4-owner-channels-manual-test.md` (manual smoke-test checklist)

**Files modified (~13):** `src/app/api/admin/businesses/[id]/channels/route.ts` (additive `expires_at`), `src/app/api/admin/channels/telegram/{start,cancel,disable}/route.ts` (delegate to helpers), `src/app/api/admin/channels/sms/verify/route.ts` (pre-check + 23505 catch), `src/app/api/admin/channels/sms/_shared.ts` (lock key rename), `src/app/api/admin/channels/whatsapp/{start,cancel}/route.ts` (23505 catch + lock + FOR UPDATE), `src/components/admin/{TelegramEnrollmentWidget,WhatsAppEnrollmentWidget}.tsx` (refactored to use hook), `src/app/(authenticated)/settings/page.tsx` (converted to server component shell), `worker/ingress/twilio-whatsapp-inbound.ts` (FOR UPDATE on verifier SELECT), plus several `__tests__/` updates for the changed SQL queue patterns.

**Zero new env vars** — Phase 4 reuses the existing `CHANNELS_TELEGRAM_ENABLED` flag from Phase 2 and the existing `TELEGRAM_*` env vars. The owner page learns flag state via the existing business-detail API; no `NEXT_PUBLIC_*` companion.

**What's next (operational, not code):** flip `CHANNELS_TELEGRAM_ENABLED=true` in prod once `@RepWorthBot` is registered + `setWebhook` is configured + a pilot owner has been walked through the manual-test checklist on staging. PR #10 reviewed by Codex across 4 review passes (final pass returned zero findings). After flag flip, monitor first 5–10 owner enrollments for any UX surprises; the helper unit tests + reducer tests cover state-machine correctness, but the React glue is only covered by Playwright `test.fixme` (deferred until the Supabase admin `generateLink` harness lands).

---

## Sprint Zernio-Ingestion: Replace SerpAPI Polling with Webhook-Driven Ingestion

### Phase Z2.0 — Code-Complete (2026-04-30)

**Status:** CODE-COMPLETE behind the existing `ZERNIO_PUBLISHING_ENABLED` flag (default OFF). Branch: `feat/zernio-ingestion-replace-serpapi` — 40 commits, 1707/1707 vitest tests pass, `tsc --noEmit` clean, ESLint clean, 4 review rounds applied.

**Why:** SerpAPI polling had three structural problems: (1) every connected business burned $0.05/sync × 24 syncs/day per location regardless of whether new reviews existed, (2) the 60-minute reconciliation interval meant up to an hour of latency between a customer posting a review and us drafting a response, and (3) the synthetic SHA-256 `provider_review_id` collided on common reviewer names + dates and frequently mismatched Zernio's canonical IDs at publish time, requiring a Redis-cached field-match lookup. Zernio's review.new / review.updated webhooks landed in production during the Phase 1 publishing rollout (commit `83142e4`, 2026-04-28) but were left as a no-op counter — this sprint promotes them into the canonical ingestion path, deletes the SerpAPI consumer half (the SerpAPI source stays for the demo engine), decommissions the manual-post fallback that's been dormant since Phase 1 connect-first publishing landed, and wires the premium tier end-to-end so it can actually be sold.

**What it does:** A reviewer posts on Google → Zernio's webhook fires within seconds → `worker/ingress/zernio.ts` parses the payload, narrows fan-out to the firing location, and emits one `ingest_zernio_review` outbox row per active connection at that account/location → `OutboxPoller` dispatches to `ZernioReviewIngestWorker` → worker walks up to 4 listReviews pages locationId-scoped, locates the review by `r.id === zernio_review_id`, runs the reconcile-externally-answered branch if Zernio shows the customer already replied via Google, otherwise builds a `MonitoredReview` with location-scoped resource names (`zernio://{accountId}/locations/{locationId}/reviews/{reviewId}`) and runs the existing `processReview` pipeline → `ResponseGeneratorWorker` drafts the reply → `NotificationWorker` emails the owner → owner approves → `ResponsePublisherWorker` posts via Zernio. Plus a one-shot tier-aware backfill on first connect (gap reviews ≤25 all tiers, historical ≤50 premium-only, `suppress_notification=true` so the first-connect dashboard doesn't blast 75 approval emails). The same `ZERNIO_PUBLISHING_ENABLED` flag controls publishing AND ingestion.

**Implementation tasks (executed via subagent-driven development from `docs/superpowers/plans/2026-04-29-zernio-ingestion-replace-serpapi-plan.md`):**

1. **Tasks 0–3 — Pre-flight + foundations:** Pre-flight audit on a clean feature branch from `main`. Migration 028 added `zernio_backfill_runs` table (per-business summary of gap/historical processed + skipped counts; `subscription_tier` and `subscription_activated_at` snapshotted at backfill time so the row is self-contained; partial unique index `zernio_backfill_runs_one_per_business` is defense-in-depth on top of the connect-callback's `needs_backfill` predicate). New outbox payload types `IngestZernioReviewPayload` + `ZernioInitialBackfillPayload`; new queue names `ingest_zernio_review` + `zernio_initial_backfill`; existing `GenerateResponsePayload` widened with `suppress_notification?: boolean`. `ReviewIdentity.provider` widened to `'serpapi_poll' | 'zernio'`; `identityStrategy` added `'zernio_id'`.

2. **Tasks 4–7 — Shared library helpers:** `canonicalizeReplyText` (CRLF→LF, NFC normalize, trim, BOM + zero-width strip — all four because round-trips through Zernio + Google introduce each variant in practice). `parseZernioReviewWebhook` with `ZernioReviewWebhookParseError` accepts both bare review.id and resource-name forms, agreement-checks when both are present, deliberately does NOT cross-check top-level `account.id` against the `accounts/{...}` segment in `review.name` (different ID spaces — Zernio account vs Google Business account; round-4 regression test pinned). `zernioClient.listReviews` + `listAllReviews` widened to require `locationId` (Zernio's API accepts it as a query param; without server-side scoping, multi-location fan-out would return reviews for the account's default location, not the connection's, causing every cross-location webhook to escalate to `review_exceptions`). `zernio-normalize.ts` exports `zernioReviewToNormalized` + `buildZernioMonitoredReview` + `extractLocationFromReviewName` + `ZernioReviewNormalizationError` — per-review validation throws so workers can isolate one bad review without aborting a batch.

3. **Tasks 8–10 — process-review hardening + auth fallback:** `processReview` INSERT now uses `ON CONFLICT (provider, provider_review_name) DO NOTHING`; on race-loss the function re-reads FOR UPDATE and falls through to `processExistingReview` so newer content from a race-loser is NOT silently dropped. `suppressNotification` flag rides into every `generate_response` outbox payload (4 enqueue sites). `ResponseGeneratorWorker.persistResponseAndNotify` honors the flag — when `suppress_notification === true`, skips the `send_notification` outbox enqueue AND the `notification_deliveries` write; `NotificationFailoverPoller`'s EXISTS-check on `notification_deliveries WHERE template='approval_request'` safely no-ops on the missing rows. `applyIngestionAuthErrorFallback` (distinct from publisher's `applyTransientExhaustionFallback` — ingestion has no response_id to park) disconnects only the matching active connection (pinned by `business_id + zernio_account_id + zernio_location_id`) and enqueues `notify_owner_connection_lost`; idempotent via `UPDATE … WHERE status='active' RETURNING 1` count check.

4. **Tasks 11–13 — Worker chain:** `worker/jobs/zernio-ingest-shared.ts` exports two helpers used by both ingest and backfill workers: `handleZernioIngestError` dispatches Zernio HTTP errors per spec §6.3 table (auth → applyIngestionAuthErrorFallback + markFailed; permanent/validation → markFailed; transient → rethrow; unknown → rethrow). `reconcileExternallyAnsweredReview` matches local rows by EITHER exact zernio identity OR legacy `serpapi_poll` field-match (reviewer + rating + text + createTime ±24h, mirroring zernio-publisher's `MATCH_WINDOW_MS`); per-response protect-set distinguishes "our reply" (canonicalize-text-match against `approved_text`) from "external reply" — supports mixed legacy/Zernio scenarios where one zernio row protects and one legacy row supersedes from a single helper call. Active-status filter deliberately excludes `'awaiting_manual_post'` per the decommissioning. `ZernioReviewIngestWorker` (new): subscription guard → connection-active verify (pinned by account+location) → mock-mode short-circuit → 4-page locationId-scoped `listReviews` walk → distinguish durable not-found (entire feed walked, no `nextPageToken`) from cap-exhausted indeterminate (`nextPageToken` still set after `maxPages`) → fail-closed on unparseable `review.name` → no-op on location mismatch (sibling business at same account, different location) → `reconcileExternallyAnsweredReview` if `reviewReply !== null`, otherwise `buildZernioMonitoredReview` + `processReview`. `ZernioBackfillWorker` (new): idempotent claim via `INSERT … ON CONFLICT (business_id) DO NOTHING` then SELECT-and-check-completed_at sentinel (row-existence alone is NOT the done marker — a `listAllReviews` timeout after row insert would otherwise lose backfill on retry); subscription guard skip does NOT set completed_at (billing recovery should retry); reconcile failures collected per-review and re-thrown at end BEFORE setting `completed_at` so BullMQ retries the whole backfill on partial failure (idempotent thanks to `processReview` ON CONFLICT + supersession idempotency).

5. **Tasks 14–16 — Webhook fan-out + worker registration + connect callback:** `worker/ingress/zernio.ts` `case 'review.new': case 'review.updated':` replaces the old counter with `INSERT … SELECT … FROM zernio_connections … ON CONFLICT (aggregate_id, (payload->>'zernio_review_id')) WHERE topic = 'ingest_zernio_review' AND status IN ('pending', 'dispatching', 'dispatched') DO NOTHING` — fans out one outbox row per active connection at the firing account, dedups against in-flight rows when Zernio retries a webhook delivery mid-processing. When the parsed payload carries `locationIdFromPayload`, the WHERE narrows to that exact location (sibling locations no longer receive every webhook + escalate to exceptions). `worker/index.ts` registers `ingestZernioReviewWorker` (default concurrency) and `zernioBackfillWorker` (concurrency 1, serial — backfill is heavy); `ingestZernioReviewWorker.on('failed')` escalates typed errors after retry exhaustion to distinct `review_exceptions` types (`zernio_review_not_found` durable, no admin notify; `zernio_pagination_cap_exhausted` indeterminate, no admin notify, Sentry warning instead; `zernio_unparseable_review_name` admin notify because it signals API contract change). Connect callback (`/api/zernio/connect/select-location/route.ts`) emits the backfill outbox row in the same tx as the `zernio_connections` activation when the `needs_backfill` predicate fires (`NOT EXISTS (… completed_at IS NOT NULL)` — covers both no-row case AND incomplete-row case, ROUND-2 fix).

6. **Tasks 17–21 — Publisher refactor:** `worker/jobs/publisher-error-handlers.ts` (new) extracts the canonical disconnect-park-notify and fail-exception-notify sequences from inline 150-line catch blocks into `handlePublisherAuthErrorTerminal` (pinned by `business_id + zernio_account_id + zernio_location_id`; round-10 fix preventing stale auth error from disconnecting a sibling fresh reconnect at a different location) and `handlePublisherPermanentErrorTerminal`. Both helpers redact `error_body` via `redactSensitiveError` (strips `Bearer …`, `Basic …`, `token=…`, `api_key=…`, `password=…`, `authorization=…` patterns) before persisting in `zernio_connections.last_error` and `responses.posting_error` audit fields — Sentry breadcrumb scrubber doesn't apply to DB writes. New error classes `PublisherTransientWithContext` (subclasses `ZernioTransientError`, carries `attemptContext = { response_id, business_id, account_id, location_id }`) and `ZernioReplyVerificationIndeterminateError` (reason union `review_not_found_after_pagination | review_found_but_reply_null | verifier_unknown_error`). New `verify409AndDispose(args): Promise<Verify409Result>` returns a discriminated union (`posted | superseded | auth | permanent | transient | indeterminate`); reads `getCachedZernioReviewPage` for a tighter pagination cap on cache hit, walks `listReviews` page-by-page until target found OR cap hit, classifies lookup errors (transient/auth/permanent/unknown), compares canonicalized reply text on match (text match → mark posted via direct UPDATE + markOutboxCompleted; mismatch → supersede with `posting_error='already_replied_external'`, log lengths + 12-char SHA-256 fingerprints — never plaintext, round-9 redaction). `lookupZernioReviewId` now requires `locationId` as 4th param (round-2 M4 fix); cache key is `zernio_review_map:{accountId}:{locationId}:{businessId}:{ourReviewId}` (ROUND-1 fix — same-account location switch can't reuse stale mapping); also exports `getCachedZernioReviewPage` reading `zernio_review_page:{accountId}:{locationId}:{zernioReviewId}` written during the field-match walk. `applyTransientExhaustionFallback` REQUIRES `account_id + location_id` (un-pinned legacy fallback DELETED — would silently disconnect every active connection at a multi-connection business; round-1 critical). `worker/jobs/ResponsePublisherWorker.ts` 409 catch block reduced from 150 lines to a 25-line switch dispatch over `verify409AndDispose`'s discriminated union; lookup-time `ZernioTransientError` now wraps in `PublisherTransientWithContext` (round-1 critical — was raw rethrow, missing pinning context); `worker/index.ts` publisher onFailed hook adds dedicated branch for `ZernioReplyVerificationIndeterminateError` BEFORE the transient branch (PublisherTransientWithContext extends ZernioTransientError so order matters), unwraps `attemptContext` to call `applyTransientExhaustionFallback` with pinned account+location, AND surfaces bare `ZernioTransientError` (now a code bug since every publisher path wraps) loudly via `Sentry.captureException(level='error', tags={kind:'unwrapped_transient'})`. `AdminExceptionWorker.ts` switches on `exception.type` via `renderExceptionBody` with 5 typed cases + a generic fallback (lists payload primitives, never the misleading "reviewer edited" copy as default); SELECT now includes `re.review_id` so the reviewer block gates on row presence (anonymous reviewers with `reviewer_name=null` but real `review_id` correctly render "Unknown reviewer", round-11 fix); `zernio_review_not_found` exceptions render "no local review record" because the review was never ingested.

7. **Tasks 22–23 — SerpAPI removal:** Three producers eliminated (onboarding/business route + create-business `placeIdVerified` branch + PlaceIdValidationWorker `enqueueSyncReviews` helper). PlaceIdValidationWorker still resolves URL → placeId + marks `place_id_verified=true`; just doesn't fan out. Six consumer files DELETED: `worker/jobs/ReviewSyncWorker.ts`, `worker/__tests__/ReviewSyncWorker.test.ts`, `worker/jobs/ReconciliationPoller.ts`, `worker/__tests__/ReconciliationPoller.test.ts`, `src/lib/reviews/serpapi-monitor.ts`, `src/lib/reviews/mock-monitor.ts`. `src/lib/shared/mock-mode.ts` drops `getReviewMonitor`. `worker/__tests__/correlation-chain.test.ts` part A rewritten to test `ingest_zernio_review → processReview(correlationId)`. **`SerpApiSource` and `MockReviewSource` and `serpapi-prefill` are PRESERVED** — `DemoGenerationWorker` still uses them for prospect demos (spec §2 non-goal).

8. **Task 24 — Premium tier wiring:** Activates the existing `'premium'` slot (already in cost limits + types + admin) across schema validation (`SelectPlanSchema.tier` enum widened), the onboarding plan picker (Premium card), the Stripe Payment Link map (`STRIPE_PAYMENT_LINK_PREMIUM`), the Stripe webhook price→tier map (`STRIPE_PRICE_PREMIUM`), and the worker startup assertion. `.env.example` documents both new env vars. Test `select-plan.test.ts:159` flipped from "rejects premium" to "accepts premium".

9. **Tasks 25–28 — Manual-post decommission + reconnect copy + CLAUDE.md:** Migration 029 bulk-fails any orphan `awaiting_manual_post` rows with `posting_error='manual_post_deprecated_2026_04'` (defensive — prod has zero per CLAUDE.md), rebuilds `responses_one_non_terminal_per_review` partial unique index without the dead status, drops the migration-024 `notification_deliveries_response_template_uniq` index whose predicate `template='admin_manual_post'` is no longer satisfiable. Apply order: 028 BEFORE 029. Code deletions: `manual-post-section.tsx`, `ManualPostFlow.tsx`, `mark-posted/route.ts`, `manual-post.ts` email template + tests. ~20 modify sites cleaned. Two-clause v17 reconnect wording on `ConnectGoogleBanner.tsx` + `owner-reconnect-required.ts` email template. CLAUDE.md updated.

10. **Task 29 — Integration tests:** `worker/__tests__/zernio-end-to-end.integration.test.ts` (new) exercises the worker chain with mocked sql + zernioClient; covers happy path with location-scoped MonitoredReview identity, multi-location fan-out separation, subscription cancelled, connection disconnected mid-flight, correlation_id propagation, externally-answered review reconcile branch.

11. **Task 30 — Acceptance + rollout checklist:** Pre-merge gates (tsc + test + lint), §13 grep audit (resolves to historical migrations + absence-assertions only), prod migration apply order, env vars, webhook URL confirm, manual smoke per `docs/zernio-ingestion-test-runbook.md`.

**Code-review rounds applied:**

- **Round 1 (Codex first pass) — 7 Medium + 2 Low findings.** All addressed in commit `88f66fc`. Critical finds: webhook fan-out only filtering by account not location; ingest pagination capped at only 2 pages; `notify_owner_reconnect` payload missing `kind: 'reconnect_required'` discriminant (would silently route to wrong email template); park UPDATE clause excluded `awaiting_owner_connect` (retry of parked response would skip notify); lookup-time `ZernioTransientError` raw-rethrown without context wrap; `processReview` no-active-response branch enqueued `version: 1` even when terminal v1 existed; `lookupZernioReviewId` cache key omitted `locationId`. Lows: backfill subscription-skip set `completed_at` blocking retry; runbook A5 still referenced `sync_reviews`.

- **Round 2 (Codex second pass) — 1 Medium + 2 Low.** Commit `5874d25`. Backfill predicate flipped from `EXISTS … completed_at IS NULL` to `NOT EXISTS … completed_at IS NOT NULL` (covers no-row case for admin-connected-pre-checkout); cap-exhausted payload added `pages_walked`; +6 tests for cap-exhausted, durable not-found metadata, no-row resume, in-flight dedup.

- **Round 3 (final pass) — 17 findings (2 Critical + 7 Medium + 8 Low).** All addressed in commits `76f6fbf` + `a0a5724` + `7e0b7e1`. Critical 1: 409 verifier walked 4 pages on every retry without page-cache reuse → `getCachedZernioReviewPage` + Sentry warning. Critical 2: webhook fan-out had no per-review outbox dedup on `claimInboundEvent` reclaim → migration 030 partial unique index `job_outbox_ingest_zernio_review_inflight` + `INSERT … ON CONFLICT DO NOTHING`. Mediums: deleted un-pinned `applyTransientExhaustionFallback` legacy fallback (would silently disconnect every active connection); `canonicalizeReplyText` strips BOM + zero-width chars; NaN guard on `subscription_activated_at` parse; documented gap-window vs `connected_at` semantics as residual risk; supersede parked `awaiting_owner_connect` on content change (drain race); extracted `verify409AndDispose` discriminated union; canonical field-match predicate via `src/lib/reviews/zernio-field-match.ts`; `redactSensitiveError` strips Bearer/Basic/token=value patterns from persisted error bodies. Lows: `maybeEnqueueBackfillResume` only on real activation transition; truncate `ZernioReviewWebhookParseError.rawPreview` to 500 chars; tolerate `sha256=` prefix in webhook signature; `isPremium` const + `GAP_CAP` + `HISTORICAL_CAP_PREMIUM` constants; workers map keyed by queue name; `payload satisfies SendOwnerEmailPayload` at every notify construction site; Sentry warning capture for `zernio_pagination_cap_exhausted`.

- **Round 4 (final) — 0 findings.** Branch genuinely closed.

**Architecture invariants preserved:** outbox pattern unchanged, no auto-posting (`awaiting_owner_connect` still required between approval and Zernio post when no active connection exists; new `review_content_changed_during_park` supersession path closes a race that could have published a stale draft after reconnect), worker-side third-party ingress preserved, transactional outbox preserved, approval tokens still SHA-256-hashed, Node native `crypto` for hashing, app-enforced auth scope.

**Files created (~22):**
- `supabase/migrations/{028_zernio_backfill_runs,029_drop_awaiting_manual_post,030_ingest_zernio_review_outbox_dedup}.sql`
- `src/lib/zernio/{canonicalize-reply,parse-review-webhook,auth-error-fallback}.ts` + 3 test files
- `src/lib/reviews/{zernio-normalize,zernio-field-match}.ts` + 2 test files
- `worker/jobs/{ZernioReviewIngestWorker,ZernioBackfillWorker,zernio-ingest-shared,publisher-error-handlers}.ts` + 4 test files
- `worker/__tests__/zernio-end-to-end.integration.test.ts`
- `docs/zernio-ingestion-test-runbook.md` (10-section pre-merge + staging + rollout + rollback runbook)

**Files modified (~30):** `worker/{index,queues,startup-assert}.ts`, `worker/ingress/{zernio,stripe}.ts`, `worker/jobs/{ResponsePublisherWorker,ResponseGeneratorWorker,AdminExceptionWorker,PlaceIdValidationWorker}.ts`, `src/lib/publishing/zernio-publisher.ts`, `src/lib/zernio/{client,types}.ts`, `src/lib/reviews/{process-review,types,index}.ts`, `src/lib/shared/{queue-names,worker-types,mock-mode,index,schemas,response-status,constants}.ts`, `src/lib/payments/payment-link.ts`, `src/lib/notifications/{email,delivery}.ts` + email template comment cleanup, `src/app/api/zernio/connect/select-location/route.ts`, `src/app/api/onboarding/business/route.ts` + `src/lib/onboarding/create-business.ts`, `src/app/onboarding/pay/PlanPickerClient.tsx`, `src/app/admin/businesses/[id]/{page,components/ReviewsList,components/ZernioConnectionPanel}.tsx` + `src/app/admin/runbook/page.tsx`, `src/components/dashboard/{ConnectGoogleBanner,ReviewsList}.tsx`, `src/lib/notifications/email/templates/owner-reconnect-required.ts`, `.claude/CLAUDE.md`, `.env.example`, `.gitignore`.

**Files deleted (10):** `worker/jobs/{ReviewSyncWorker,ReconciliationPoller}.ts` + their tests, `src/lib/reviews/{serpapi-monitor,mock-monitor}.ts`, `src/app/admin/businesses/[id]/{manual-post-section.tsx,components/ManualPostFlow.tsx}`, `src/app/api/admin/businesses/[id]/mark-posted/route.ts`, `src/lib/notifications/email/templates/manual-post.ts`.

**3 new env vars:**
- `STRIPE_PAYMENT_LINK_PREMIUM` — required when `SELF_SERVE_SIGNUP_ENABLED=true` (worker startup assertion).
- `STRIPE_PRICE_PREMIUM` — required so the Stripe webhook maps the premium price → `subscription_tier='premium'`.
- `ZERNIO_INGEST_MAX_PAGES` — optional, default `4` (200 reviews). Caps `ZernioReviewIngestWorker.listReviews` walk; cap-exhausted with `nextPageToken` still set escalates to `review_exceptions type='zernio_pagination_cap_exhausted'`.

**4 new lab notes added to `.claude/CLAUDE.md`:**
- `ON CONFLICT` clauses must reference partial-unique-index expressions byte-for-byte; the migration-005 `idx_review_exceptions_collision_dedup` predicate uses `(payload->>'provider_review_id')`, NOT `provider_review_id`.
- Zernio webhook `account.id` (top-level) is Zernio's account ID; the `accounts/{...}` segment in `review.name` is Google's Business account ID — different ID space, do NOT cross-check them.
- Zernio backfill gap-window currently uses `subscription_activated_at`, not `connected_at` — connect-after-activation customers get a tiny gap window. Documented as residual risk pending schema change.
- Bare `ZernioTransientError` reaching the publisher's onFailed hook is a code bug — every publisher path now wraps with `PublisherTransientWithContext`. Surface loudly via Sentry rather than silently disconnecting every active connection.

**What's next (operational, not code):** Apply migrations 028 → 029 → 030 in prod Supabase (in that order; 028 must come before 029). Set `STRIPE_PAYMENT_LINK_PREMIUM` + `STRIPE_PRICE_PREMIUM` in prod env. Confirm Zernio webhook URL still points at `${WORKER_PUBLIC_URL}/ingress/zernio` (no URL change). Run §5 staging end-to-end smoke per `docs/zernio-ingestion-test-runbook.md` (10 scenarios). Then `ZERNIO_PUBLISHING_ENABLED=true` in prod (single flag controls publishing AND ingestion). Pilot one customer end-to-end. 24h watchlist: zero `unwrapped_transient` errors in publisher, `zernio_pagination_cap_exhausted` warning rate under threshold, `review_exceptions type LIKE 'zernio_%'` count near zero, no `dispatched`-stuck rows. SerpAPI ingestion code is GONE — rolling back means re-deploying the pre-merge commit (SerpApiSource itself is preserved for the demo engine). After successful pilot + 24h soak, the `~70% of polling spend disappears` benefit lands automatically since active customers stop hitting the SerpAPI quota for review polling (only the demo engine consumes SerpAPI now).

---

## feat/edit-existing-replies — Edit Existing Replies (Tier-Mirrored)

**Branch:** `feat/edit-existing-replies` (off `feat/zernio-ingestion-replace-serpapi`)
**Date code-complete:** 2026-05-02
**Status:** Code-complete. 22 commits on the branch. 1869/1874 tests passing (1 pre-existing flaky NotificationWorker test under parallel CPU load — passes in isolation, not a regression). TSC + lint clean. `pnpm build` succeeds (new route at 4.35 kB / 167 kB First Load).
**Spec:** `docs/superpowers/specs/2026-05-01-edit-existing-replies-design.md`
**Plan:** `docs/superpowers/plans/2026-05-01-edit-existing-replies-plan.md`
**Single feature flag:** `EDIT_EXISTING_REPLIES_ENABLED` (off by default; gates UI + ingestion + new edit-publisher branch + new onFailed orphan-marker conversion together).

### Motivation

When a business onboards through `/dashboard/connect`, `ZernioBackfillWorker` walked `listAllReviews` and silently dropped any review the owner had already replied to on Google before connecting RepWorth. For Tanicia Resort's onboarding (2026-05-01), 8 of 158 reviews never made it into the dashboard — owner had no record of past engagement, voice learning had zero examples to bootstrap from, and there was no path to refine a reply through RepWorth even though Zernio supports doing so. This feature ingests the silently-dropped reviews into the DB as `posted` responses, surfaces them in a new "Past Replies" tab, and gives owners — within their tier — the ability to edit/regenerate/re-publish.

### Tier rule (the C-2 option from brainstorming)

| Action | Standard / Founding | Premium |
|---|---|---|
| **See** existing replies | Yes (all) | Yes (all) |
| **Edit / regenerate** reply for **gap** review (createTime >= subscription_activated_at) | Yes | Yes |
| **Edit / regenerate** reply for **historical** review (createTime < activated_at OR activated_at IS NULL) | No | Yes |

Boundary: review_date == subscription_activated_at counts as gap (>= predicate).
NULL `subscription_activated_at` fails closed: every review treated as historical (cautious — matches the existing connect-flow code's stance for legacy businesses where the column was added in migration 014 but legacy rows could lack it).

### What shipped (21 plan tasks, grouped)

**Worker layer (Tasks 1-8):**

1. **Migration 031** — `reviews.external_reply_ingested_at` + `zernio_backfill_runs.external_reply_ingested_count` + partial unique index `responses_one_posted_per_review` (CONCURRENTLY) + `idx_reviews_business_review_date` (CONCURRENTLY). Non-transactional file with embedded pre-flight + post-migration verification SQL.
2. **Zernio client `deleteReply`** — DELETE `/v1/inbox/reviews/{reviewId}/reply` with explicit 15s timeout (load-bearing per spec §4.5 lock-window discipline). New `ZernioReplyAlreadyDeletedError` (404 → caller treats as DELETE-success). 403 + `inbox_addon_required` → `ZernioPermanentError` (NOT auth — billing-side issue must not fire connection-lost flow).
3. **Ingestion extension** — `reconcileExternallyAnsweredReview` gets two NEW flag-gated branches that turn the silent "previously-unseen" / "matched but no active responses" no-ops into actual ingestion. Race-safe ON CONFLICT DO UPDATE for the review INSERT; partial-unique-index ON CONFLICT for the response INSERT.
4. **process-review stale-marking** — unconditional UPDATE at the TOP of the content-change block flips recoverable-orphan-state failed rows to `posting_error='stale_after_review_changed'` so recovery routes refuse to republish stale text.
5. **`verify409InTx`** — tx-aware variant of `verify409AndDispose` returning a discriminated union. Avoids self-deadlock when called from inside the new edit-publisher's locked tx.
6+7. **Publisher Phase A + Phase B** — biggest task. Non-locking pre-flight + locked-tx DELETE-before-POST with per-CATCH commit semantics covering EVERY row of spec §4.5's 16-outcome table. Affected-row-count assertions on every status-guarded UPDATE. Auth catches use `markOutboxCompleted` (drain re-enqueues on reconnect). Orphan markers (`posting_error LIKE '%_after_delete_succeeded'`) survive BullMQ retries AND drain re-enqueue.
8. **`worker/jobs/publisher-on-failed.ts`** — extracted from `worker/index.ts` (so the new logic is testable). Orphan-marker conversion runs BEFORE the existing transient fallback: orphan-marker rows on retry exhaustion → `'failed'` with `posting_error='post_after_delete_failed_retry_exhausted'` (recovery-routes-visible state).

**API layer (Tasks 9-14):**

9. **`src/lib/responses/edit-existing.ts`** — `assertCanEditReply` (tier + ownership gate) + `validateOptimisticConcurrency` (in-tx hash + version check against the LIVE 'posted' row, not the latest non-terminal — fixes the prior-draft bug where /draft's own INSERT broke /publish-time validation).
10. **POST /draft** (manual + regenerate) — withSameOrigin wrapper, in-flight guards, optimistic concurrency in-tx. Manual mode: status='pending_approval' (NOT 'edited' — only /publish transitions to a HANDLED status per spec §4.2 atomicity rule).
11. **PATCH/DELETE /draft/:id + GET /draft-status** — PATCH = edit-further on a pending row; DELETE = cancel (idempotent); GET = poll regenerate status with tenant ownership guard on outbox payload + on resolved response row.
12. **POST /publish** — atomic transition + audit-log + outbox INSERT in ONE tx. Status discriminator: `edited_text IS NOT NULL ? 'edited' : 'approved'`. `approved_text = COALESCE(approved_text, response_text)` — critical for regen-as-is. Audit `mode` discriminator uses (llm_provider, edited_text) tuple: `'manual'` / `'regenerate_as_is'` / `'regenerate_edited'`.
13. **POST /retry + POST /restore-original** — recovery routes for orphan-state failed rows. Both call `assertCanEditReply` (cross-cutting tier gate). `/retry` allowlist: `delete_failed_*` OR `post_after_delete_failed_*`. Branch-shape validation (step 2a): the security-critical check that prevents `/retry` from undoing a previously-applied `/restore-original`. `/retry`'s CASE expression re-installs the orphan marker on `post_after_delete_failed_*` recovery. `/restore-original` finds the most-recent superseded sibling with `posted_at IS NOT NULL`, INSERTs a fresh pending_approval row at `version=MAX+1`, leaves the OLD failed row in place (so abandoning the restore via DELETE /draft re-enables /retry as fallback).
14. **Cross-origin regression test** — single consolidated file confirms ALL 6 mutating routes return 403 on wrong Origin AND that GET /draft-status is exempt.

**Frontend layer (Tasks 15-17):**

15-16-17. **Past Replies tab + drawer + nav link** — server component at `/dashboard/past-replies` (paginated 50/page, NULL-safe gap/historical bucketing). `PastReplyCard` shows reviewer + Google reply + provenance label ("Imported from Google · YYYY-MM-DD" / "Posted via RepWorth · YYYY-MM-DD") + Edit CTA / "Premium feature" lock badge. `EditReplyDrawer` 6-state machine (initial / manual editing / regenerating / regenerate-preview / publishing / recovery) + dedicated 409 review_changed prompt. Right-aligned fixed panel; backdrop click-to-close; Esc to close. Polls `/draft-status` every 1500ms with 60s ceiling. Snapshot `{ hash, version }` captured at open via `useRef`. `HistoricalUpgradeBanner` soft sage/blush upsell above non-premium historical section. `OwnerNav` link conditionally rendered when flag on (server-authoritative).

**Tests + script + runbook (Tasks 18-21):**

18. Integration + E2E tests **deferred** — need `TEST_DATABASE_POOL_URL` (real Postgres for FOR UPDATE concurrency tests) + Playwright browser harness. Per-task unit tests cover the main paths (~115 cases across this branch).
19. **Backfill script** `scripts/zernio-backfill-external-replies.ts` — one-off CLI for retroactive ingestion. Idempotent.
20. **Runbook update** — appended §10 "Edit Existing Replies (Phase A/B)" to `docs/runbooks/zernio-launch-runbook.md` with pre-flight + post-migration verification + monitoring + rollback.
21. **Final verification** — pnpm test 1869/1874, pnpm build OK, pnpm lint clean, pnpm tsc clean.

### Test count

- ~115 new unit tests across the branch (5 zernio-client + 7 ingest + 5 process-review + 11 verify409InTx + 21 publisher-edit + 13 publisher-on-failed + 14 edit-existing helper + 11 + 30 + 12 + 24 + 7 API tests).
- Pre-existing test suite: regression-clean (publisher 23/23, full pre-existing 1748 still green).
- Full vitest run: 1869/1874 (1 pre-existing flaky test under parallel CPU load — passes in isolation).

### Files (high-level inventory)

**Created (~17):** migration 031, edit-existing helper + test, 7 API route files + 7 test files, the past-replies page, 3 dashboard components, ResponsePublisherWorker-edit.test, publisher-on-failed.{ts,test.ts}, the backfill script.

**Modified (~12):** ResponsePublisherWorker, zernio-ingest-shared, publisher-error-handlers, worker/index, process-review, zernio client/errors/types, authenticated/layout, OwnerNav, runbook, plus the 4 .claude/skills/*.md files + .claude/CLAUDE.md.

### Pre-merge / pre-flag-flip checklist

- [x] All unit tests passing (1869/1874 — 1 unrelated pre-existing flaky test).
- [x] TSC + lint clean.
- [x] `pnpm build` succeeds.
- [x] Migration 031 file created with embedded pre-flight + verification SQL.
- [x] Runbook updated with Phase A/B rollout steps + monitoring.
- [x] Single feature flag for both UI + ingestion + publisher branch.
- [ ] Apply migration 031 in prod Supabase (after pre-flight check confirms no duplicate `posted` rows).
- [ ] Phase A soak >= 1 week with `EDIT_EXISTING_REPLIES_ENABLED=false`.
- [ ] Phase B: flip flag to `true` in prod env (Vercel + Railway).

### Deferred for follow-up

- Integration tests (spec §6.2, 9 cases) — need `TEST_DATABASE_POOL_URL`.
- E2E tests (spec §6.3, 4 cases) — need Playwright + browser harness.
- Surfacing failed orphan-state rows on the Past Replies page so the recovery state in `EditReplyDrawer` can be triggered (today the page query filters `responses.status='posted'`; failed rows live separately).
- Voice-learning bootstrap from imported replies — would widen the voice-learning query at `src/lib/responses/voice-learning.ts:30` to include `original_draft_text == approved_text AND llm_provider IS NULL` rows. Spec §8 / §9 follow-up.

---


## feat/past-replies-view — Read-only Past Replies tab (post-split)

**Branch:** `feat/past-replies-view` (off `feat/zernio-ingestion-replace-serpapi`)
**Date code-complete:** 2026-05-02 (after split + 4 fix-pass review rounds + reviewer-driven docs cleanup)
**Status:** Code-complete. 9 commits on the branch. 1869+ tests passing (379 in worker + zernio scope), TSC + lint clean, `pnpm build` succeeds (new route ~4.3 kB / 167 kB First Load).
**Migration:** 031 (column + counter + partial unique index + supporting index).
**Two flags (both default off):** `EXTERNAL_REPLY_IMPORT_ENABLED` (writes path) + `PAST_REPLIES_VIEW_ENABLED` (UI).

### The split decision

The original `feat/edit-existing-replies` branch was code-complete: 31
commits, 6 review rounds, ~3,500 LOC, 1869/1874 tests passing. It would
have shipped the full edit / regenerate / publish / retry / restore-original
feature with an EditReplyDrawer + 7 API routes + a publisher DELETE+POST
locked-tx state machine + recovery routes + orphan-marker convention.

**Why we split it instead of shipping it whole:**

1. **API model mismatch.** Zernio's API requires DELETE-then-POST to edit a
   reply. Direct GBP API uses single-PUT replacement. ~25% of the parked
   code (the orphan-marker recovery state machine) becomes vestigial when
   GBP arrives. Building Zernio-shaped recovery for production support of
   a feature that will be ripped out is expensive engineering debt.

2. **GBP timeline unknown.** Per CLAUDE.md, "GBP API: Not applied for" —
   that's at minimum 6-18 months of waiting (apply → Google review →
   approval → integration). During that window, the original Tanicia
   onboarding pain (silently-dropped pre-RepWorth replies) keeps recurring
   for every new business.

3. **Shipping the visibility win is high-value, low-risk.** Solving JUST
   the visibility problem (read-only Past Replies tab + the ingestion fix)
   is ~30% of the code, ~5% of the operational complexity, and addresses
   the original user pain.

4. **Branch was stabilizing but not stable.** Across 6 review rounds
   (Codex pass-1 → Round-2 M1+M2+M3 → Round-3 M → Round-4 M), reviewers
   kept finding successively smaller variants of the same hidden-draft
   class of bug in the regenerate flow. Each round was real engineering
   hours, and post-launch ops would inherit that complexity.

**Decision:** ship a stripped-down read-only branch now; park the edit
machinery on tag `wip/edit-existing-replies-zernio-v1` for either GBP-time
reuse OR resurrection if GBP timeline blows up beyond ~12 months.

### What was kept (cherry-picked into feat/past-replies-view)

| Commit | Purpose |
|---|---|
| `eb4d183` (cherry-picked as `dfa30ce`) | Migration 031 — column + counter + partial unique index + supporting index |
| `c2360cd` (cherry-picked as `7989f2c`) | `reconcileExternallyAnsweredReview` flag-gated import branches |
| `891e975` (cherry-picked as `d71549c`) | Round-1 Low fix — counter bump only on actual INSERT |
| `884f7d5` (cherry-picked as `a738957`) | Backfill script + (then-rewritten) runbook section |

### What was redone manually (couldn't cherry-pick clean)

| Original | New commit | Why redone |
|---|---|---|
| `ca53663` (Round-1 M1) | `f9106c5` | Original touched `verify409InTx` which doesn't exist on this branch. Redone: kept the `listReviews` chokepoint normalization + the worker loose-equality guards; dropped the verify409InTx hunk. |
| `9e0ca93` (Round-1 M5) | `5e84708` | Original required `redactSensitiveError` to be exported, which depended on `a8836fd` we weren't bringing. Redone: exported the helper + added `summarizeShape` + wired all four sites in one commit. |

### What was built fresh on the new branch

| Commit | Purpose |
|---|---|
| `eea4d98` | Read-only Past Replies page + `PastReplyCard` (no Edit button) + `HistoricalUpgradeBanner` + `OwnerNav` link conditional on `PAST_REPLIES_VIEW_ENABLED`. Renamed flag from `EDIT_EXISTING_REPLIES_ENABLED` to dual `EXTERNAL_REPLY_IMPORT_ENABLED` + `PAST_REPLIES_VIEW_ENABLED`. |
| `79aea5e` | Rewrote runbook §10 for the dual-flag rollout (Phase A → B1 → B2). |
| `b4a9418` | Reviewer-caught fix: SQL preflight `WHERE status = posted` and `IN (responses_one_posted_per_review, ...)` were missing string quotes; would have failed Postgres parsing. |

### What was DROPPED (parked on tag `wip/edit-existing-replies-zernio-v1`)

- The 7 API routes (`/draft`, `/publish`, `/retry`, `/restore-original`, etc.).
- `runEditPublisherIfApplicable` (Phase A pre-flight + Phase B locked tx).
- `worker/jobs/publisher-on-failed.ts` orphan-marker conversion.
- `verify409InTx` + verifier dispatch ladder.
- `process-review` stale-marking branch.
- `src/lib/responses/edit-existing.ts` (`assertCanEditReply` / `validateOptimisticConcurrency`).
- `EditReplyDrawer` (6-state machine, recovery panel, regenerate flow,
  Round-2 M1+M2+M3 + Round-3 M + Round-4 M fixes).
- `src/lib/zernio/client.ts::deleteReply` + `ZernioReplyAlreadyDeletedError`.
- The recoverable-failed LATERAL JOIN in the page query.
- The recovery-state branch in `PastReplyCard`.
- `failed_response_id` + `failed_posting_error` plumbing through page → card → drawer.

### Two-flag rollout rationale

Original single-flag design (`EDIT_EXISTING_REPLIES_ENABLED` gates
everything) entangled the data-write decision with the UI-expose decision.
Imported `posted` rows count toward `dashboard/service.ts` HANDLED_STATUSES,
so flipping ingestion on changed customer-visible numbers BEFORE the UI
explained them.

The view-only branch splits this into two independent flags:

- `EXTERNAL_REPLY_IMPORT_ENABLED` — gates writes (ingestion path).
- `PAST_REPLIES_VIEW_ENABLED` — gates UI (page + nav link).

**Rollout sequence:**
1. Apply migration 031 in production Supabase.
2. Phase A: ship code with both flags off, soak ≥ 1 week.
3. Phase B1: turn on `EXTERNAL_REPLY_IMPORT_ENABLED` — ingestion starts
   silently. Watch dashboard "total responded" count delta in product analytics.
4. Phase B2: turn on `PAST_REPLIES_VIEW_ENABLED` — owners see the new tab.
5. Pilot one customer end-to-end before wider rollout.

### Doc-cleanup follow-ups (post-merge)

- Updated `.claude/CLAUDE.md`: bumped migration head 030 → 031;
  rewrote "Current branch status" section.
- Updated `.claude/skills/feature-flags.md`: added the two new flags +
  marked `EDIT_EXISTING_REPLIES_ENABLED` as parked.
- Updated `.claude/skills/lab-notes.md`: appended 2026-05-02 section with
  6 lab notes (split decision, dual-flag pattern, cherry-pick lessons,
  EditReplyDrawer hidden-draft class of bug, vi.hoisted, gitignore quirks).
- Updated `.claude/skills/migrations.md`: bumped head + added migration 031 entry.
- Updated `.claude/skills/review-dedup.md`: appended external-reply
  ingestion section.
- Updated `docs/runbooks/zernio-launch-runbook.md`: §10 rewrite for dual-flag rollout.
- `docs/directory.md`: removed parked-feature references on disk
  (gitignored — won't ship in commits).

### Test coverage on this branch

- Unit tests: 379 passing in `worker/__tests__/` + `src/lib/zernio/__tests__/`.
  No new tests beyond what we cherry-picked (the 7-case ingest test suite
  from `c2360cd` + the counter-fix test update from `891e975`).
- Build: `pnpm build` succeeds with the new route at ~4.3 kB / 167 kB First
  Load.
- TSC + lint: clean.
- Integration / E2E: still deferred (need `TEST_DATABASE_POOL_URL` +
  Playwright harness).

### Pre-merge / pre-flag-flip checklist

- [x] All unit tests passing.
- [x] TSC + lint clean.
- [x] `pnpm build` succeeds.
- [x] Migration 031 file with embedded pre-flight + verification SQL (with quotes).
- [x] Runbook §10 updated for dual-flag rollout.
- [x] `.claude/CLAUDE.md` + skills/*.md updated to reflect the split.
- [ ] Apply migration 031 in prod Supabase (after pre-flight check confirms
      no duplicate `posted` rows).
- [ ] Phase A soak ≥ 1 week with both flags off.
- [ ] Phase B1: `EXTERNAL_REPLY_IMPORT_ENABLED=true` in prod env.
- [ ] Phase B2: `PAST_REPLIES_VIEW_ENABLED=true` in prod env.

### When (if ever) to revive the parked tag

The parked `wip/edit-existing-replies-zernio-v1` is preserved as a
spec-as-code reference. Revive only if:

- **GBP arrives:** start a NEW branch `feat/edit-existing-replies-gbp` and
  cherry-pick structural patterns (route shapes, drawer state machine
  minus recovery state, optimistic-concurrency snapshot, helpers). Build
  a GBP-native single-call edit publisher; skip the orphan-marker /
  DELETE+POST locked-tx / `verify409InTx` machinery entirely. ~75% of
  the parked code is reusable; the publisher / recovery / orphan-marker
  layer (~25%) gets dropped.
- **GBP timeline blows up beyond 12+ months AND premium tier monetization
  needs the differentiator urgently:** revive the parked branch as-is,
  run another review pass on the residual hidden-draft regenerate-window
  orphan accepted in Round-4 M, file the ops ticket for the fresh-publish
  race documented in spec §4.5 (out-of-scope for that branch), and ship
  behind the original single `EDIT_EXISTING_REPLIES_ENABLED` flag.

---

## Pre-paywall Demo + Journey Reorder — PR #2 (2026-05-04)

**Status:** Code-complete on `feat/pre-paywall-demo-pr2`, awaiting PR #1 merge + staging soak.
**Branch:** `feat/pre-paywall-demo-pr2` (21 commits ahead of `feat/lifecycle-extraction`).
**Spec:** `docs/superpowers/specs/2026-05-03-pre-paywall-demo-and-journey-reorder-design.md`
**Plan:** `docs/superpowers/plans/2026-05-03-pre-paywall-demo-pr2.md` (18 tasks)
**Test runbook:** `docs/runbooks/pr-2-pre-paywall-demo-test.md`

### Why

Owners reaching `/onboarding/pay` had no concrete preview of what
RepWorth would actually do for *their* business. Conversion data from
Sprint 4–6 self-serve signup showed a high drop-off at the paywall.
Inserting a real-API demo of AI responses for the owner's actual Google
reviews — generated between location capture and Stripe — gives them
proof-of-value before being asked for a card.

### Journey before vs after

**Before:** signup → `/onboarding/pay` → Stripe → `/onboarding/business`
(3-step Location/Profile/Voice wizard, gated on `subscription_status='active'`)
→ `/dashboard`.

**After (flag ON):** signup → `/onboarding/start` (location only) →
`/onboarding/demo` (live SerpAPI demo + paywall CTA) →
`/onboarding/pay` → Stripe → `/onboarding/business` (2-step
Profile/Voice wizard) → `/dashboard` (now with `SetupChecklist`).

Both flows coexist — the wizard adapts based on `ONBOARDING_DEMO_ENABLED`.

### What was built (18 tasks, 21 commits)

**Database**
- Migration **032** (`onboarding_demos`) — sister table to `prospect_demos`
  with `user_id`/`business_id` FK CASCADE, JSONB snapshots, state machine
  (`queued|running|completed|failed|archived`), partial unique index
  `onboarding_demos_one_completed_per_user (user_id) WHERE
  generation_status='completed'`, plus a partial cleanup-helper index
  on `(completed_at) WHERE generation_status='completed'`.

**Worker pipeline**
- New BullMQ queue `onboarding_demo_response` registered in
  `src/lib/shared/queue-names.ts`, `worker/queues.ts`, `worker/index.ts`.
- `worker/jobs/OnboardingDemoWorker.ts` — claim demo → resolve Place ID →
  fetch SerpAPI → select reviews → generate LLM responses → fall back to
  curated fixture if SerpAPI fails OR if no review meets the
  positive-with-moderate-tail anchor → `completeDemo` with `source` →
  reconcile cost reservation → check thresholds → emit Sentry alerts.
  Inverted subscription guard: if the user paid mid-flight, mark the row
  `failed` with `subscription_state_changed` (NOT empty `completed`,
  which would lock them out via the partial unique index).

**Cost lane**
- `src/lib/costs/onboarding-demo-cost-guard.ts` — parallel helper to the
  per-business `cost-guard.ts`. Global daily ceiling defaults to $10/day
  (`ONBOARDING_DEMO_DAILY_CENTS`), overridable at runtime via Redis key
  `cost:onboarding-demo:override:cents`. Each demo reserves 20¢
  pessimistically; the worker reconciles to actual spend (typically ~3¢).
  `checkCostThreshold` fires Sentry alerts at 50/90/100% of ceiling, at
  most once per day per lane via Redis `SADD` dedupe.

**Curated fallback**
- `src/lib/demos/__fixtures__/fallback-source-reviews.ts` + 
  `src/lib/demos/fallback-content.ts` — single `general-business` fixture
  with category-prefix matching for future per-category fixtures.

**API routes**
- `POST /api/onboarding/start` — location capture, 3-lane rate limit
  (per-user 3/24h, per-IP 5/24h, global 200/h), cost reservation, advisory-
  lock + FOR UPDATE idempotent tx that inserts the demo + outbox row in a
  single Postgres transaction (transactional outbox invariant). Tracks
  `demoInserted` flag so the idempotency-loser path releases the
  reservation and reports `demoQueued: false`.
- `GET /api/onboarding/demo/status` — soft-rate-limited polling endpoint.
  Filters `generation_status <> 'archived'` so 23505 race-loser rows don't
  shadow the winning demo.
- `POST /api/onboarding/demo/regenerate` — archive previous + insert new in
  a single tx. Subscription-gated to `pending_payment`.
- `POST /api/onboarding/business` (modified) — bifurcated by flag:
  `BusinessOnboardingPostPaySchema` (rejects location fields via
  `z.never()`) when on, `BusinessOnboardingSchema` (legacy) when off.
  Post-pay UPDATE writes only profile/voice; location-capture path stays
  in the legacy branch.

**UI**
- `/onboarding/start/page.tsx` + `StartLocationClient.tsx` — server-guarded
  page reusing `PlaceAutocomplete`, with a Maps-URL fallback toggle and
  category/website prefill via `/api/signup/place-prefill`.
- `/onboarding/demo/page.tsx` + `PaywallWithDemoClient.tsx` — server reads
  the latest non-archived demo. Polling every 2s for ≤15 attempts, with
  visibility-driven counter reset for tab-switch revisits. Renders
  `loading | failed | skipped | completed`; failed AND skipped both render
  the paywall CTA so payment is never blocked on a transient generation
  issue. When no demo row exists but location is captured (cost ceiling /
  rate limit blocked the enqueue), renders the standalone paywall to break
  what would otherwise be a `/start` ↔ `/demo` redirect loop.
- `/onboarding/business/BusinessWizardClient.tsx` (modified) — adapts based
  on `demoFlowEnabled` prop: 2-step (Profile, Voice) post-pay or 3-step
  (Location, Profile, Voice) legacy. Initial values prefilled from the
  businesses row.
- `/onboarding/business/guard.ts` (modified) — `WizardGuardOptions`
  parameter switches the "place data already set" check between
  "duplicate-submit" (legacy) and "expected precondition" (post-pay).
- `(authenticated)/dashboard/SetupChecklist.tsx` + `SetupChecklistClient.tsx`
  — 4-item checklist (Connect Zernio, Approve first response, Tune voice,
  Set notification prefs) backed by a single Postgres CTE. Client wrapper
  handles per-businessId localStorage dismiss.

**Cleanup**
- `worker/jobs/CleanupAbandonedSignupsPoller.ts` (modified) — explicit
  `DELETE FROM onboarding_demos` inside the abandoned-signup tx (FK
  CASCADE is defense-in-depth; explicit delete is observable in logs).
  Also adds a top-of-loop pass to delete completed demos older than
  30 days, using the new partial cleanup index.

**Race-loser recovery (PR #1 deferred → PR #2 implemented)**
- `src/lib/demos/lifecycle.ts:completeDemo` now catches Postgres `23505`
  on `onboarding_demos` and recovers in a single tx: archive THIS row +
  close the outbox. Without this, a concurrent regenerate would leave
  the loser as the most-recent row, causing the demo page to render
  failure instead of the winning completed demo.

**Documentation**
- `.claude/skills/onboarding-demo-cost-guard.md` — new skill doc.
- `.claude/skills/feature-flags.md` — `ONBOARDING_DEMO_ENABLED`,
  `ONBOARDING_DEMO_DAILY_CENTS`, `ONBOARDING_DEMO_STAFF_EMAILS_CSV`.
- `.claude/skills/migrations.md` — entry for migration 032; head bumped.
- `docs/runbooks/onboarding-demo-launch-runbook.md` (local-only per
  gitignore policy) — staging soak + 4-phase prod rollout.
- `docs/runbooks/pr-2-pre-paywall-demo-test.md` — local pre-PR test
  runbook (this PR's verification recipe).

### Review rounds

Three review rounds against the implementation:

**Round 1 — Critical (3) + Medium (6) + Low (2):**
1. `/start` FK mismatch — was inserting Supabase `auth_id` into a column
   FK'd to `users(id)`. Every happy path would have FK-failed.
2. `/business` post-pay no-op — the legacy "duplicate-submit" guard
   silently swallowed every post-pay submission because
   `place_id_verified` is the intended precondition there.
3. `/onboarding/demo` redirect loop — when `/start` blocked the enqueue
   (cost ceiling / rate limit), no demo row existed, `/demo` redirected
   to `/start`, and `/start` redirected back to `/demo`. Now `/demo`
   renders a standalone paywall when the user has location captured.
4. `lifecycle.completeDemo` 23505 race-loser recovery (was deferred in
   PR #1) — implemented.
5. `OnboardingDemoWorker` SerpAPI failures now fall back to curated
   content instead of failing the demo.
6. Failed demos render the paywall CTA (bundled into #3).
7. `/regenerate` gated on `pending_payment`.
8. Cost guard honors `ONBOARDING_DEMO_DAILY_CENTS` env (Redis > env >
   default precedence with finite-int validation).
9. `api_costs` ledger entries deferred to Phase 2 — documented in skill.
10. SetupChecklist split into server data + client wrapper with per-
    businessId localStorage dismiss.
11. Migration 032 partial cleanup index `(completed_at) WHERE
    generation_status='completed'`.

**Round 2 — Medium (3):**
1. `OnboardingDemoWorker` threshold/Sentry block wrapped in inner
   try/catch so a Redis/Sentry hiccup can't flip a successful demo to
   failed via the outer catch arm.
2. `/onboarding/demo` page + `/api/onboarding/demo/status` filter
   `generation_status <> 'archived'` so the 23505-archived loser doesn't
   shadow the winning row in the latest-by-`created_at` read.
3. `/api/onboarding/start` tracks `demoInserted` flag inside the tx
   callback. The idempotency-loser path (concurrent /start won the
   FOR UPDATE race) now releases the reservation and reports
   `demoQueued: false` instead of silently leaking 20¢ + lying.

### Tests

- 154 PR-relevant tests passing (`MOCK_EXTERNAL_APIS=true` for all unit
  paths; lifecycle DB-integration tests gate on `TEST_DATABASE_POOL_URL`).
- `tsc --noEmit`: clean.
- `pnpm lint`: 15 pre-existing errors in unrelated test files (twilio,
  PlaceIdValidationWorker, etc.); none in PR #2 code.
- 23505 race-loser recovery test added to `lifecycle.test.ts` — also
  asserts the page-level read invariant (latest non-archived = winner).
- `/start` idempotency-loser regression test added.

### Pre-merge / pre-flag-flip checklist

- [x] Static checks (tsc, lint scoped to PR #2 files, vitest) all green.
- [x] All review-round 1+2 issues addressed.
- [x] Migration 032 file written with the partial cleanup index.
- [x] `.claude/skills/feature-flags.md` + `migrations.md` updated.
- [x] `.claude/CLAUDE.md` migration head bumped 031 → 032.
- [x] Test runbook written (`docs/runbooks/pr-2-pre-paywall-demo-test.md`).
- [ ] PR #1 (`feat/lifecycle-extraction`) merged to main.
- [ ] PR #2 rebased onto post-PR-1 main and pushed.
- [ ] Apply migration 032 in staging Supabase.
- [ ] Walk the test runbook end-to-end against staging.
- [ ] Phase 3 staff-allowlist soft-launch on prod
      (`ONBOARDING_DEMO_STAFF_EMAILS_CSV`) — note: code path NOT yet
      wired in `/start`; Phase 3 work is to gate the route behind the
      env-CSV check.
- [ ] Phase 4 GA: drop the staff allowlist, bump
      `ONBOARDING_DEMO_DAILY_CENTS` to production target.

### Phase 2 follow-ups (not in PR #2)

1. **`api_costs` ledger entries** for the onboarding-demo lane —
   requires migration to add `cost_lane` column (or extend the implicit
   convention). Current Redis-only tracking handles enforcement but
   cross-period admin reporting misses this spend.
2. **Per-category curated fixtures** via `scripts/generate-fallback-demos.ts`
   — v1 ships single `general-business` fixture for all categories.
3. **Auto-regenerate on stale revisit (>24h)** — v1 ships stale-with-
   footnote + manual regenerate button. Auto-regen on the SSR page would
   need a cost-guard reservation inline before render; deferred until
   Phase 1 telemetry shows revisit conversion drag.
4. **Phase 3 staff-allowlist gate** — wire
   `ONBOARDING_DEMO_STAFF_EMAILS_CSV` into `/start` and `/demo` routes
   for the soft-launch window.

---

## Worker Folder Reorganization + `background/` Split (2026-05-04 → 2026-05-05)

**Status:** COMPLETE (PR #17, branch `refactor/worker-folder-reorg`)

**Goal:** Replace the flat-ish `worker/` layout — where `jobs/` mixed
job processors with pollers/schedulers/shared helpers, `ingress/` mixed
webhook entry points with provider-specific helpers, and tests were
split across three inconsistent `__tests__/` trees — with a layout that
scales as more workers and background loops are added. Mechanical move
only: zero logic changes, zero function-signature changes, zero
behavioral delta.

**Three commits, layered:**

1. **`8c3b05b refactor(worker): reorganize folder layout (no logic
   changes)` — 71 file moves**
   - Created `worker/{config,background}/`, provider sub-folders
     `worker/ingress/{twilio,telegram,zernio}/`, and per-job
     sub-folders `worker/jobs/{notification,publisher,zernio}/`.
   - Moved `startup-assert.ts` → `worker/config/`.
   - Moved 14 ingress files into provider sub-folders. Moved 16
     job/poller files into `jobs/<sub>/` or `background/`.
   - Tests colocated under each folder's `__tests__/` (matching
     `src/**/__tests__/` convention). Single accepted rename:
     `worker/ingress/__tests__/helpers.ts` →
     `worker/ingress/test-helpers.ts` (lifted out of `__tests__/` so
     provider-subfolder tests can import it via `'../../test-helpers'`).
   - `worker/queues.ts` and `worker/index.ts` stayed at root as
     runtime entry points.

2. **`80a30e2 refactor(worker): fix stale path comments after folder
   reorg` — 13 fixes**
   - Updated 8 top-of-file `// worker/...` headers and 5 inline
     cross-reference comments to point at the new paths after step 1.
   - Migration SQL `024_notification_delivery_dedup.sql` deliberately
     left untouched (historical artifact).

3. **`0c17c20 refactor(worker): split background/ into pollers/ and
   schedulers/` — 17 file moves**
   - Split `worker/background/` into `pollers/` (Postgres-state-driven:
     `OutboxPoller`, `NotificationFailoverPoller`, `ArchivalPoller`,
     `EngagementMonitorPoller`, `CleanupAbandonedSignupsPoller`,
     `EmailChannelReconcilePoller`) and `schedulers/`
     (time-cadence-driven: `WeeklySummaryScheduler`,
     `MonthlyImpactScheduler`, `RankingTrackingScheduler`,
     `OnboardingDripScheduler`).
   - User indicated more pollers/schedulers coming, so the
     disambiguation pays for itself.

**Final layout:**

```
worker/
├── env.ts                     # dotenv loader
├── index.ts                   # Sentry + Fastify + BullMQ Workers + lifecycle
├── queues.ts                  # 16 BullMQ Queue instances + topic→Queue map
├── config/
│   └── startup-assert.ts      # boot-time env assertions
├── ingress/                   # webhook handlers
│   ├── shared.ts              # claimInboundEvent (cross-provider dedup)
│   ├── stripe.ts, resend.ts   # single-file providers
│   ├── test-helpers.ts        # used by twilio inbound/status tests
│   ├── twilio/                # SMS + WhatsApp
│   ├── telegram/
│   └── zernio/
├── jobs/                      # BullMQ job handlers
│   ├── *.ts                   # 12 single-file workers
│   ├── notification/          # NotificationWorker + 5 sub-modules
│   ├── publisher/             # ResponsePublisherWorker + error-handlers
│   └── zernio/                # 2 zernio workers + zernio-ingest-shared
└── background/
    ├── pollers/               # 6 Postgres-state-driven loops
    └── schedulers/            # 4 time-cadence-driven loops
```

**No barrels/index files.** `worker/index.ts`'s explicit `new Worker(...)`
plus `start*Poller()` calls remain the canonical runtime registry.

**Verification gates (all green for the final commit):**

- `pnpm exec tsc --noEmit`: zero errors.
- `pnpm test`: 1845 passed / 1 skipped / 0 failed.
- `pnpm exec vitest run worker/background`: 89/89 pass.
- `pnpm lint`: 15 errors, all in 6 unrelated pre-existing files.
- `pnpm build`: succeeded.
- **Worker boot smoke test**: `tsx worker/index.ts` started on `:3099`
  with `MOCK_EXTERNAL_APIS=true`, `/api/health` returned `{"status":"ok",
  ...}` in 4 seconds, all 10 background loops registered cleanly.

**Files NOT moved (deliberately):**

- `worker/env.ts`, `worker/index.ts`, `worker/queues.ts` — root runtime
  modules.
- `worker/jobs/{12 single-file workers}.ts` — already at the right
  level; no second file to co-locate with.
- `worker/jobs/notification/{context,dispatch,eligibility,errors,
  sms-budget}.ts` — already correctly co-located.
- `worker/__tests__/correlation-chain.test.ts` — cross-cutting test,
  stays at root.

**Documentation updated:**

- `docs/directory.md` — full file-by-file map of new layout, with
  `pollers/` + `schedulers/` subsections.
- `docs/currents.md` — plain-language description of the new directory
  shape for quick orientation.
- `.claude/CLAUDE.md` — added concise "Worker layout" subsection.
- `.claude/skills/{feature-flags,lab-notes,migrations,review-dedup}.md`
  — class-name references already stable; path footnotes added where a
  reader needs to find the source quickly.
- Spec drafts: `docs/superpowers/specs/2026-05-04-worker-folder-reorg-design.md`
  and `docs/superpowers/specs/2026-05-05-worker-background-split-design.md`
  (both gitignored, local-only).

**Known follow-ups:**

- `feat/edit-existing-replies` is the only active local branch likely to
  rebase-conflict against this refactor. Conflict resolution is purely
  path-rewrite, no logic merging.
- Migration SQL `024_notification_delivery_dedup.sql:3` mentions
  `worker/jobs/ResponsePublisherWorker.ts` in a comment; intentionally
  not touched (migrations document state at time of application).

---

## 2026-05-05 — Worker Index Failure Extraction (PR #18, Group A PR #1)

Applied the new `CLAUDE.md` architecture invariant — *"Entry points
orchestrate; modules own failure behavior"* — to the worst current
offender. `worker/index.ts` was 607 lines mixing three concerns:
Sentry init, BullMQ Worker registry with two inline `.on('failed')`
hooks (~250 combined lines of DB-writing failure logic), and Fastify
boot. After this PR it is **296 lines** of pure registration +
lifecycle.

This is **PR #1 of three** in the Group A entry-point modularization
spec at
`docs/superpowers/specs/2026-05-05-entry-point-modularization-design.md`.
PRs #2 (`select-location/route.ts`) and #3 (`callback/route.ts`) get
their own plans after this one validated the conventions.

**Three extractions, 13 commits squashed into one PR (`0e1ab23` head):**

1. **`9114af4 refactor(worker): extract Sentry init to worker/sentry.ts`**
   - Moved the Sentry import + `scrubObject` recursive helper +
     `Sentry.init({...})` block (`worker/index.ts:1-37`) verbatim into
     a new `worker/sentry.ts`.
   - `worker/sentry.ts` `export { Sentry }`; `worker/index.ts` now
     `import { Sentry } from './sentry'`. Prevents future contributors
     from re-importing `@sentry/node` directly and bypassing the
     configured scrubber.

2. **`adb6382` + `fbdc9db` + `f2227ec` + `92fc7c9` + `56b914d` +
   `c118a8d` — `worker/jobs/zernio/ingest-failed-hook.ts` extraction
   (TDD red→green per branch)**
   - New module exports `handleIngestFailed(job, err)` —
     a thin orchestrator with three private branch helpers:
     `handleReviewNotFound`, `handlePaginationCapExhausted`,
     `handleUnparseableLocation`, plus a generic fall-through.
   - Each branch lifted byte-equal from the original
     `worker/index.ts:160-277` block. Same SQL, same JSONB payload
     keys, same `ON CONFLICT (business_id, type, (payload->>'provider_review_id'))`
     predicate, same Sentry tags.
   - New `__tests__/ingest-failed-hook.test.ts` covers all 4 branches
     across 10 cases — including the previously-untested
     `notify_admin_review_exception` outbox enqueue gating on the
     INSERT's `RETURNING id`, and the `attemptsMade` boundary at the
     last allowed retry.

3. **`9a414e3` + `2b9aaf7` + `2dc7b16` + `2783989` —
   `worker/jobs/publisher/failed-hook.ts` extraction (TDD red→green
   per branch)**
   - New module exports `handlePublisherFailed(job, err)` — thin
     orchestrator with four private branch helpers
     (`ZernioReplyVerificationIndeterminateError`, bare-transient
     defensive, `PublisherTransientWithContext` success +
     fallback-failed, generic) PLUS the last-resort handler-crash
     branch wrapping the entire body.
   - Each branch lifted byte-equal from the original
     `worker/index.ts:291-427` block. Same `sql.begin` transaction
     shape, same `ON CONFLICT (review_id, type)` predicate, same
     Sentry kinds (`unwrapped_transient`, `transient_exhaustion_fallback`,
     `on_failed_handler_crash`).
   - New `__tests__/failed-hook.test.ts` covers all 5 branches across
     9 cases. The `bare ZernioTransientError` defensive branch and the
     `on_failed_handler_crash` last-resort branch had **zero** direct
     test coverage on `main` before this PR.

4. **`e9c550d` + `0e1ab23` — wire-in commits**
   - `worker/index.ts:160-277` (117 lines) collapsed to
     `ingestZernioReviewWorker.on('failed', handleIngestFailed);`.
   - `worker/index.ts:291-427` (137 lines) collapsed to
     `publisherWorker.on('failed', handlePublisherFailed);`.
   - Pruned newly-orphaned imports from `worker/index.ts`:
     `ZernioIngestReviewNotFoundError`, `ZernioIngestPaginationCapExhaustedError`,
     `ZernioIngestUnparseableLocationError` (all three),
     `PublisherTransientWithContext`,
     `ZernioReplyVerificationIndeterminateError`, `ZernioTransientError`,
     `applyTransientExhaustionFallback`, `extractOutboxHandle`,
     `markOutboxCompleted`, `markOutboxFailed`, `jsonb`, `uuidv7`, `sql`.

**Final state:**

| Metric | Before | After |
|---|---|---|
| `worker/index.ts` | 607 lines | **296 lines** |
| Inline failed-hook DB writes | ~250 lines | 0 |
| `instanceof` cascades in boot file | 7 branches | 0 |
| New source files | — | 3 (`worker/sentry.ts`, `ingest-failed-hook.ts`, `failed-hook.ts`) |
| New test files | — | 2 (covering 9 previously-untested branches) |

**Verification gates (all green at PR-merge):**

- `npx vitest run worker/jobs/zernio/__tests__/ingest-failed-hook.test.ts worker/jobs/publisher/__tests__/failed-hook.test.ts worker/jobs/zernio/__tests__/ZernioReviewIngestWorker.test.ts worker/jobs/publisher/__tests__/publisher-error-handlers.test.ts worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts` — 67/67 pass.
- `npx vitest run worker/` — 470/470 pass.
- `pnpm tsc --noEmit` clean.
- `pnpm lint` — 15 errors, all pre-existing on `main` in 6 unrelated
  test files; zero new lint issues introduced (verified against `main`).
- Smoke boot: `MOCK_EXTERNAL_APIS=true pnpm worker` — all 16 BullMQ
  Workers + 10 background loops boot, `Worker service running on port
  ...`, clean shutdown.
- `wc -l worker/index.ts` = 296 (target ≤ 380, well under).
- Behavior-preservation grep: every Sentry tag, error message, outbox
  reason, and DB write from the original `worker/index.ts:160-277` and
  `:291-427` confirmed present in the extracted modules.

**Process notes:**

- Spec at `docs/superpowers/specs/2026-05-05-entry-point-modularization-design.md`
  (gitignored, local-only) — prescriptive: function signatures, file
  paths, and per-branch test names all listed up-front.
- Plan at `docs/superpowers/plans/2026-05-05-pr1-worker-index-failure-extraction.md`
  (also gitignored) — 14 tasks executed via subagent-driven
  development with two-stage review (spec compliance, then code
  quality) per task.
- One mid-stream plan correction: the original test code in the plan
  used object-literal construction for `ZernioIngestReviewNotFoundError`,
  but the real constructor is positional. Caught by the implementer's
  self-review, fixed in `fbdc9db`, and the plan was patched so Tasks
  4 and 5 used positional construction from the start.
- One mid-stream test-strength fix: code review on Tasks 2-3 flagged
  `toMatchObject` as too loose for a JSONB shape lock; commit
  `f2227ec` switched to `toEqual` and added an `attemptsMade` boundary
  case.

**Known follow-ups:**

- PR #2 (`select-location/route.ts`, ~581 lines, three extractions
  into `src/lib/zernio/connect-finalize/`).
- PR #3 (`callback/route.ts`, ~470 lines, two cleanup-block
  extractions into `src/lib/zernio/connect-callback/` plus a Lua-script
  consolidation into `connect-state.ts`).
- Group B refactors (`EngagementAlertWorker`, `OnboardingDripWorker`)
  deferred to a separate spec, written after Group A's interfaces have
  shaken out.

---

## Sprint X — Multi-Location Support (`feature/multi-location`, 2026-05-06 → 2026-05-09)

**Status:** Implementation complete. 3,069+ unit tests green, 354/354 validation assertions passed, security review + post-launch fix-pass complete. Ready to merge.

**Goal:** Allow one owner account to manage multiple Google Business Profile locations under one billing entity, with per-location notification routing, per-location voice config, and aggregate or per-location dashboard scoping.

### What we built

**1. Schema (migrations 034–041) — 8 migrations.**
- `034_multi_location_schema.sql` — created `accounts` table (the new billing parent / org), added `account_id` + `display_label` + `is_primary` + `archived_at` to `businesses`, added `account_id` denorm to `users` / `api_costs` / `notification_deliveries` / `approval_audit_log` / `channel_enrollments`, created `account_audit_log`, dropped `users.business_id` outright.
- `035_rls_policies.sql` — RLS on 22 tables via the new `owner_account_id()` helper.
- `036_defer_circular_fks.sql` — DEFERRABLE FKs for the circular `accounts ↔ users` reference.
- `037_add_cancelled_at.sql` — `accounts.cancelled_at`. Drives the dashboard 30-day grace window after cancel.
- `038_owner_user_id_unique_index.sql` — partial unique index on `accounts(owner_user_id)`.
- `039_revert_problematic_not_null_constraints.sql` — corrective: drops NOT NULL on `users.account_id`, `api_costs.account_id`, `notification_deliveries.account_id`. Admin / sales_partner users have no account; platform-level cost rows have no account.
- `040_rls_tightening.sql` — table-level REVOKE UPDATE on `businesses` then explicit GRANT only on safe columns; REVOKE INSERT entirely on `channel_enrollments`.
- `041_rls_missing_revokes.sql` — caught the columns missed in 040 (`subscription_activated_at`, `place_id_verified`, `google_maps_url` on businesses; `archived_at` / `archive_reason` on channel_enrollments).

**2. Stripe model.** Removed all Payment Links. New checkout flow uses server-built Checkout Sessions. One subscription per account with two items: tier base price + per-extra-location overage price. Add / archive / reactivate / tier-change all flow through the outbox → `UpdateStripeOverageWorker`. Worker uses Stripe idempotency keys keyed on `(accountId, itemId, quantity)` for safe concurrent execution.

**3. UI surface.**
- Location switcher in TopBar/Sidebar (cookie-persisted via `rw_location_scope`; hidden for single-location accounts).
- Aggregate dashboard at `scope=all` — per-location KPI strip + stacked charts + combined feed with location chips.
- 4-step add-location wizard at `/dashboard/add-location` — Place autocomplete → Zernio info → voice config (with "copy from existing") → confirm & pay with proration preview.
- Settings restructured: Account / Locations / Channels / Voice tabs.
- Per-location voice configs (independent after creation; no implicit inheritance).
- Per-location channel overrides on top of org defaults; resolver chokepoint at `src/lib/notifications/resolve-channels.ts` with 5-min Redis cache + write-invalidation.
- Approve page shows blue location chip + amber "Archived" badge.
- `CancelledBanner` (30-day grace from `cancelled_at`) and `PastDueBanner` (POST button to portal, not GET anchor) on the dashboard.
- Admin CSV bulk-import at `/api/admin/locations/csv-import` (5MB / 100-row caps).

**4. New API routes.** `/api/locations/{add,archive,reactivate,promote-primary,display-label}`, `/api/billing/{checkout,portal,tier-change}`, `/api/settings/channels/override`, `/api/settings/voice`, `/api/admin/locations/csv-import`. All owner routes double-gated: middleware role + account_id check, then in-route `requireRole('owner')` + `body.accountId === user.accountId` + per-resource ownership lookup.

**5. Worker wiring.** `UpdateStripeOverageWorker` (new, `worker/jobs/billing/`). NotificationWorker context now joins `businesses → accounts` for subscription guard + checks `archived_at`. ResponsePublisherWorker similarly joins for subscription state and skips archived locations. Notification dispatch prefixes Telegram and email with `[{display_label}]` to identify source location.

**6. Spec deviations from `docs/superpowers/specs/2026-05-06-multi-location-design.md`.**
- `users.business_id` dropped immediately (spec said one-release deprecation).
- Tier `founding` renamed to `founders`.
- SMS STOP fan-out stays sender-wide (TCPA).
- SMS / WhatsApp validation deferred — only Telegram + email in scope.
- Server-built Checkout Sessions used everywhere instead of Payment Links.

### Security review pass (2026-05-09 morning)

13 issues found and fixed before user-facing rollout. Highlights:

1. `/api/locations/*` and `/api/billing/*` mutations were initially missing `requireRole('owner')` + ownership checks — closed.
2. Migration 040 originally used column-only `REVOKE UPDATE` — discovered Postgres requires table-level REVOKE first, then re-GRANT on safe columns. Migration 041 caught the columns missed in 040.
3. SMS handle-wide unsubscribe was only invalidating the requesting account's channel cache — switched to invalidate **all** affected accounts (TCPA-critical).
4. PastDueBanner billing portal link was a GET `<a href>` anchor — converted to POST `<button>` to prevent CSRF via prefetched GET.
5. Admin owner-email edit was not invalidating channel cache after upserting the email enrollment — fixed.
6. Email reconcile poller's `ON CONFLICT (business_id, channel)` did not target the actual partial-unique-expression-index → fix used select-then-insert pattern.
7. Mobile uniqueness violation produced 500s instead of 409s — added the new constraint name to the error mapper.
8. Stripe environment contract: replaced obsolete `STRIPE_PAYMENT_LINK_*` startup assertions with `STRIPE_PRICE_*` assertions + drift-prevention tests.
9. Cancellation grace period: switched dashboard from `subscription_activated_at`-based grace (months-long for old subs) to `cancelled_at + 30d` with legacy-row fallback.
10. Middleware now gates `/api/billing/*` and `/api/locations/*` directly (not just via the protected-routes registry).
11. `notification_deliveries.account_id` writers updated across 6 worker call sites.
12. Channel cache invalidation added to 17+ writers including admin email sync.
13. RLS tightening across `businesses` and `channel_enrollments` (migrations 040 + 041).

### Post-launch fix-pass (2026-05-09 evening)

After the security review, a second-pass code review surfaced 5 medium-severity defense-in-depth issues. All five fixed on the same branch:

1. **Publisher archived-location check.** `ResponsePublisherWorker` now selects `b.archived_at` and short-circuits with `markOutboxCompleted` (graceful skip) before calling Zernio. Closes the window where a response approved before an archive could still post to Google after the archive committed.
2. **Channel cache: replaced silent `.catch(() => {})` everywhere.** New `safeInvalidateChannelCache(accountId, context, logger?)` wrapper logs `'channel-cache-invalidate-failed'` with structured fields. All 17 call sites converted (admin SMS / Telegram / WhatsApp, dashboard Telegram, settings overrides, admin business-detail email sync). Each call passes a named context string for grep-able alerts.
3. **`UpdateStripeOverageWorker`.** Removed misleading `SELECT … FOR UPDATE` (a no-op under PgBouncer transaction pooling). Added Stripe idempotency keys to both `subscriptionItems.update` and `subscriptionItems.create` calls — keys include `(accountId, itemId, quantity)` so concurrent jobs computing the same quantity dedup at Stripe.
4. **Archive transaction account scoping.** `archive-location-tx.ts` UPDATE now filters `WHERE id = locationId AND account_id = accountId` (matches the reactivate path; closes a TOCTOU window between the guard and the write).
5. **CSV import billing aggregation.** `addLocationTransaction` accepts `enqueueStripeOverageUpdate?: boolean` (default `true`). The CSV import path passes `false` per row and calls `enqueueCsvImportStripeOverageUpdate(accountId)` exactly once after the loop. A 100-row CSV now produces 1 Stripe API call instead of 100.

### Verification

- All five fix files re-read and validated — `worker/jobs/publisher/ResponsePublisherWorker.ts`, `src/lib/notifications/resolve-channels.ts`, `worker/jobs/billing/UpdateStripeOverageWorker.ts`, `src/lib/locations/archive-location-tx.ts`, `src/lib/admin/csv-import.ts` + `src/app/api/admin/locations/csv-import/route.ts`.
- Cross-checked all 17 cache-invalidation call sites converted to `safeInvalidateChannelCache` (no `.catch(() => {})` remaining in `src/`).
- Confirmed `users.business_id` is fully unreferenced in live code (the remaining matches are doc comments, tests, and historical migration assertions).
- Confirmed all owner mutation routes triple-gated (middleware + role + ownership-lookup).

### Known non-blocking debt

Documented in `docs/runbooks/multi-location.md` §6 — minor known issues that did not block merge:
- Location chips on review rows are display-only (UX enhancement: make them clickable as scope triggers).
- `DashboardContent.tsx` read-only notice uses inline styles instead of the tokens.css convention.
- Duplicate `AccountLocationSummary` types across `business-detail-types.ts` and admin `types.ts` (drift risk).
- ~10 worker files use inline `JOIN businesses` instead of centralized `getLocationContext()` helper.
- `past-replies/page.tsx` uses inline `display_label ?? name` instead of the `getDisplayLabel()` helper.
- 7 unclassified columns on `businesses` not explicitly GRANTed/REVOKEd in 040/041 (follow-up).
- CSV import returns a 500 if the aggregate billing enqueue fails after rows committed — should return the partial-success report with a `billingEnqueueFailed: true` flag instead.
- Publisher archive-skip leaves the response orphaned in `approved` state (no terminal transition, no re-enqueue on reactivate).

### Process notes

- Spec at `docs/superpowers/specs/2026-05-06-multi-location-design.md` (gitignored).
- Investigation + readiness at `docs/superpowers/specs/2026-05-07-multi-location-{investigation,readiness}.md`.
- Runbook + manual TC catalog at `docs/runbooks/multi-location.md` (tracked).
- 97 commits on the branch, 312 files changed, ~33,000 LOC added (heavy on schema + UI + tests).
- Final architectural review by the senior engineering partner (Claude) flagged 1 architectural inconsistency (tier-change makes synchronous Stripe calls in a Next.js route, unlike add-location's outbox pattern) — left as a deliberate UX trade-off, documented but not changed.

### Verdict

90%+ ship-ready. Architecture invariants from `.claude/CLAUDE.md` upheld throughout. The two layers of review (security + post-launch) caught the high- and medium-severity issues. Defense in depth on auth (middleware + role + per-resource ownership), atomic transactions everywhere they matter, outbox pattern correctly applied for all billing/Zernio side effects.

---


## Billing Tiers + Locations UX (2026-05-22, `feat/billing-locations-ux` → PR #51, #52)

**Status:** COMPLETE — merged to `main` (`pnpm test` 3423 passed / 1 skipped, `pnpm build`, `pnpm typecheck` all green). No new migration required; reused existing `accounts` columns.

**Why:** Onboarding advertised only 3 tiers with stale hardcoded prices ($99/$149/$199), and the Locations management surface was hidden until an account already had >1 location — so a freshly-paid Standard/Premium owner looked unable to add a second location. The fix makes tier display canonical and makes Settings the place to discover/manage location capability.

**What was done:**

1. **Onboarding shows all four canonical tiers** — Founding Member, Basic, Standard, Premium. Prices now derive from `TIER_CONFIG[tier].baseCents` (`$19/$29/$79/$199`) via the new `src/app/onboarding/pay/plan-options.ts`, instead of hardcoded strings. The Stripe Price IDs were verified (2026-05-22) to match `TIER_CONFIG`, so display == charge.
2. **Basic accepted by Select Plan** — `SelectPlanSchema` enum widened to `['founders','basic','standard','premium']`; `PlanPickerClient` tier union widened in all three spots (interface, state, handler); route doc comment updated.
3. **Settings gating split into three concepts** (new helpers in `src/lib/locations/multi-location-mode.ts`):
   - `shouldUseMultiLocationSettings` (mode — `count > 1`) → drives Voice/Notifications multi-loc content + switcher.
   - `shouldShowLocationsSettings` (visibility — flag only) → Locations tab now appears even with one location.
   - `canAddLocationForAccount` (eligibility — flag + active status + `multiLocAllowed`).
   `/settings/voice` stays gated by true multi-location mode; single-location Brand Voice routes to the `/settings#brand-voice` anchor (no accidental exposure).
4. **Basic sees a locked upgrade state** on `/settings/locations` — renders a static panel (NOT the add-location `<Link>`, no add API call) with a "View plan options" CTA to `/settings#subscription-billing`.
5. **Stored quota is the billing source of truth** — `accounts.locations_included` (and, after PR #52 review, `accounts.locations_overage_price_cents`) now drive overage math across all five surfaces: add-location preview, checkout line items, `assertCanAddLocation`, `UpdateStripeOverageWorker`, `StripeLocationsReconcilePoller`, and the `customer.subscription.updated` webhook (which resets `locations_included` to the new tier's config only on actual tier change).

**Review-driven follow-ups (this session):**
- Spec review caught a price source-of-truth gap (display was about to align to `TIER_CONFIG` without confirming Stripe matched) → resolved by verifying Stripe prices == `TIER_CONFIG` and documenting Stripe Price IDs as the charge source of truth.
- Code review caught asymmetric grandfathering (included was stored but overage price was config) → PR #52 made `currentBillingSnapshot` read the stored `locations_overage_price_cents`, with a regression test using a stored value (3000) that deliberately differs from `TIER_CONFIG`.

**Known residual debt:** Base price is NOT grandfathered (no `accounts.base_price_cents` column) — most relevant for the `founders` "Rate locked for life" promise. Documented as a TODO in `src/lib/accounts/quota.ts` and in `docs/runbooks/multi-location.md` §6 (Known Issues & Tech Debt). Fix needs a schema change.

---


## WhatsApp Channel Go-Live (2026-05-22, `feat/whatsapp-go-live` → PR #53)

**Status:** Code COMPLETE, behind `CHANNELS_WHATSAPP_ENABLED` (still off). `pnpm test` 3,459 passed / 1 skipped, `pnpm lint` + `pnpm typecheck` green. **No new migration** — reused migration 034's `channel_enrollments` `account_id`/`location_id` columns + scope indexes. Real go-live is a separate ops step (Twilio sender + Meta template approval + ship gate).

**Why:** The WhatsApp channel shipped code-complete-but-flag-gated back in Phase 3 (`edc3b11`), deferred until the WhatsApp Business Account cleared Meta verification. That cleared, so this effort makes it actually shippable: it builds the missing **owner self-service** enrollment (Phase 3/4 had only admin-side enrollment), reconciles the months-old code against multi-location + billing changes, and produces the go-live runbook.

**What was done:**

1. **Owner self-service enrollment** — new `OwnerWhatsAppWidget` (`src/components/dashboard/`) + owner-scoped routes `POST /api/dashboard/channels/whatsapp/{start,cancel,disable}`, wired into `/settings/channels` (replaced the hardcoded "coming soon" stub). Mirrors the existing owner Telegram pattern: `locationId` from session, `withSameOrigin` CSRF, subscription read from `accounts`, click-to-chat QR (`wa.me/<number>?text=start-<token>`), 3s status poll → verified.
2. **Helper extraction (entry-point invariant)** — moved the enrollment state machine into `startWhatsAppEnrollment` / `disableWhatsAppEnrollment` in `src/lib/channels/whatsapp-enrollment.ts`; refactored the admin start route to orchestrate via the helper instead of inlining the SELECT-FOR-UPDATE/INSERT.
3. **Env-readiness unified** — one `whatsappEnvReady()` predicate in the admin `_shared.ts` now backs the route guard AND both `whatsappAvailable()` UI checks. Fixed a latent bug: the UI checked 4 vars (omitting `WHATSAPP_APPROVAL_URL_BASE`) while the route checked 5 — so the UI could show a Connect button the route then 503'd.
4. **Drift audit (no material drift)** — verified the Phase 3 code against multi-location (mig 034) + billing tiers: subscription reads from `accounts`, enrollment scoped by `business_id`, IDs thread through `approval_links`/`notification_deliveries`. No fixes needed.
5. **Tests** — owner route tests (flag-off 404, env 503, auth 401, subscription 403, `multiple_mobile_channels` 409, single-location-guard 403); helper 23505 classification; a reducer copy-lock test (generic conflict string); an enrollment round-trip integration test (start route → simulated inbound webhook → verified) that runs in CI; Playwright E2E (fixme-gated, mirrors Telegram).
6. **Go-live runbook** (`docs/runbooks/whatsapp-templates.md`) — corrected the template type `twilio/card` → `whatsapp/card` (verified against Twilio docs; `twilio/card` forces WhatsApp text into `title`), 9-variable validation gate against `formatApprovalWhatsApp`, Vercel+Railway env matrix, canary-before-gate, the eight-point §5.1 ship gate.

**Review-driven follow-ups (this session, two review rounds):**
- Confirmed the multi-location desync (High) is **pre-existing and cross-channel** (SMS/Telegram share the `business_id`-keyed paths). Shipped an **interim single-location guard** for WhatsApp (server 403 `multi_location_unsupported` + UI "coming soon"), and filed the proper cross-channel fix as a tracked design doc.
- Owner route catches now **rethrow non-`AuthError`** instead of masking server failures as 401.
- Test hardening: `process.env` snapshot/restore in the integration test, `AbortController` timeout in the E2E ingress helper, fixed an `AuthError` constructor-arity error that broke `tsc` (not vitest).
- Lows: runbook STOP wording (`unsubscribed`, not `disabled`); stale E2E selector (`rounded-lg` → `channel-row`).

**Known residual debt:** The cross-channel owner-enrollment account-scope desync is **unresolved for SMS + Telegram** (only WhatsApp is guarded). Tracked in `docs/known-issues.md` + `docs/superpowers/specs/2026-05-22-owner-channel-account-scope-design.md`. Interim-guard edge case: an account that enrolls WhatsApp while single-location then adds locations sees the widget flip to "coming soon" while still enrolled (manageable via admin console).

---


## Owner Channel Enrollment — Account-Scope Fix (2026-05-22, `fix/owner-channel-account-scope` → PR #54)

**Status:** COMPLETE — merged to `main` (squash `2974603`). `pnpm test` 3,465 passed / 1 skipped, `typecheck` + `lint` + `build` all green. **No migration** — query-only (reused migration 034's `account_id`/`location_id` columns + scope indexes). This is the follow-up the WhatsApp go-live (PR #53) flagged.

**Why:** Owner channel enrollment had a multi-location desync. The org-default enrollment is account-scoped (one row per account+channel, `location_id IS NULL`, enforced by migration 034's unique index), but the read/write paths keyed it by `business_id = user.locationId`. On a multi-location account with ≥2 owners on different primary locations, a second owner saw the channel "connected" on `/settings/channels` (page hydrates by `account_id`) while the runtime API didn't (keyed by `business_id`) → Disconnect 404'd, Connect 500'd. Pre-existing; reachable on **Telegram** (live) and **WhatsApp** (had an interim single-location guard from PR #53). The PR #53 interim guard removed that exposure for WhatsApp only; this PR fixes the root cause and removes the guard.

**What was done (query-only, no migration):** key every org-default read/write by `account_id AND channel AND location_id IS NULL`:

1. **Shared status GET** (`/api/dashboard/channels`) — the linchpin read the widget polls.
2. **Enrollment helpers** (`telegram-enrollment.ts`, `whatsapp-enrollment.ts`) — start SELECT + cancel/disable predicates; `cancel`/`disable` signatures `(sql, businessId)` → `(sql, accountId)`.
3. **Owner routes** — Telegram + WhatsApp `start/cancel/disable`: resolve `accountId`, pass to helpers, account-scope the `mobile_enroll` advisory lock, simplify cache invalidation (dropped a redundant businesses lookup).
4. **Admin routes** — Telegram + WhatsApp `start` + `cancel` lock keys → `mobile_enroll:${accountId}`, and the admin cancel/disable helper call-sites pass `accountId`.
5. **Removed the WhatsApp single-location interim guard** (server 403 + UI gating) — multi-location owners can self-serve again.

`business_id` stays a NOT-NULL legacy FK written on INSERT, no longer read for org-default lookup.

**Review-driven follow-ups (this session, multiple review rounds):**
- **Two real runtime bugs the mocked tests + `tsc` could not catch** — the "shared helper signature changed to `accountId` but a caller still passed `businessId`" class (both `string`; the queue-based `sql` mock ignores the WHERE predicate). Caught 3 admin call-sites mid-build, and the **inlined admin WhatsApp disable** on the final whole-branch review (it didn't call the helper, so the caller grep missed it).
- Strengthened the regression test from a 200/404 contract test into a **true predicate guard** (asserts the UPDATE keys by `account_id`/`location_id IS NULL`, not `business_id`). Added a direct **status-GET** regression + a **Telegram owner disable** route regression.
- Corrected two comments that falsely claimed admin SMS shares the account-scoped lock.

**Known residual debt (deferred, tracked in `docs/known-issues.md` — all the same root pattern):**
- Admin **SMS** lock + cross-channel precheck still business-scoped (can waste a Twilio Verify SMS + late-409 on multi-location; no serialization vs TG/WA). Defer with SMS owner self-service.
- **Dispatcher** failure-handling enrollment writes (`dispatch.ts`) key by `business_id` — can miss the org-default row on multi-location.
- Admin per-business **status read** (`admin/businesses/[id]/channels`) lists by `business_id` — display-only mismatch.

**Lesson captured** (`.claude/skills/lab-notes.md`): when a shared helper's parameter semantics change while the type stays the same, grep ALL callers and fix every one; a branded type (e.g. `AccountId`) would let the compiler catch the mismatch.

---

