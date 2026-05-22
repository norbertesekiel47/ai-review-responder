# WhatsApp Channel Go-Live — Design

_Design spec — RepWorth — 2026-05-22_

## Source of truth

This spec governs taking the **already-built, flag-gated** WhatsApp channel to
production now that the WhatsApp Business account (WABA) is approved. It builds
on, and does not re-litigate, two prior specs:

- `docs/superpowers/specs/2026-04-23-whatsapp-phase-3-design.md` — Phase 3 owns
  the send/receive path, ingress handlers, dispatcher error classification,
  template shape, and the **§5.1 eight-point ship gate**. The ship gate criteria
  there are authoritative for go-live verification.
- `docs/superpowers/specs/2026-04-28-phase-4-owner-channel-dashboard-design.md` —
  Phase 4 owns the owner `/settings/channels` dashboard and the one-mobile-channel
  exclusivity model.

Where this spec adds new behavior (the owner WhatsApp widget, the go-live
runbook), it is authoritative. Where it references the prior specs, those win.

## Why now

Phase 3 shipped WhatsApp code-complete and flag-gated off
(`edc3b11`), explicitly deferring go-live until "external prerequisites clear."
Those prerequisites — Meta Business verification + WABA approval — have now
cleared. This spec is the activation effort.

## Current state (verified 2026-05-22)

| Surface | State |
|---|---|
| Send path (`whatsapp-channel.ts`, `whatsapp-client.ts`, `whatsapp-body.ts`) | ✅ Built |
| Inbound/status ingress (`worker/ingress/twilio/twilio-whatsapp-*.ts`) | ✅ Built |
| Dispatcher error classification (`worker/jobs/notification/{dispatch,errors,eligibility}.ts`) | ✅ Built |
| **Admin** enrollment (`/api/admin/channels/whatsapp/{start,cancel,disable}`, `WhatsAppEnrollmentWidget`, `ChannelsPanel`) | ✅ Built + tested |
| Startup env assertion (`assertChannelsWhatsAppEnv`) | ✅ Built |
| Template runbook (`docs/runbooks/whatsapp-templates.md`) | ✅ Authored |
| **Owner** self-service widget (`/settings/channels`) | ❌ Hardcoded "coming soon" stub (`ChannelsClient.tsx`) |
| External provisioning (Twilio WA sender, Meta template submission) | ❌ Not started |
| `CHANNELS_WHATSAPP_ENABLED` | `false` in production |

## Drift audit (no material drift)

The Phase 3 code (2026-04-23) was audited against multi-location (migration 034,
~2026-05-06) and the billing-tiers rework (~2026-05-22). All six surfaces hold:

| Surface | Result |
|---|---|
| Enrollment scoping by `business_id` (location) | ✅ No drift — `channel_enrollments` correctly scoped; STOP is intentionally handle-wide for opt-out compliance |
| Subscription guard reads from `accounts` (not `businesses`) | ✅ No drift — `context.ts` JOINs `accounts a ON a.id = b.account_id`, honors cancelled/past_due-grace/pending_payment |
| Channel eligibility / tier-gating | ✅ No drift — gated only by `CHANNELS_WHATSAPP_ENABLED`; no per-tier channel availability concept exists |
| Owner dashboard coherence | ⚠️ Expected gap — WhatsApp is a deliberate "coming soon" stub; this spec closes it. `shouldUseMultiLocationSettings` gating is correct |
| Env / startup assertions | ✅ No drift — `assertChannelsWhatsAppEnv` requires 7 vars + URL-base equality check; self-contained, independent of SMS |
| Account vs business id threading | ✅ No drift — `account_id` + `business_id` thread through `approval_links` and `notification_deliveries` |

**Verification action:** Stream ① re-runs the relevant suites to confirm the
audit holds against current `main`. No code fixes are anticipated; if a test
surfaces real drift, it converts to a fix task in the implementation plan.

## Scope decisions (confirmed via brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **Reconcile drift, then go live** — verify the Phase 3 code against multi-location/billing first, then activate | Code is months old; cheap to verify before flipping a customer-facing flag |
| 2 | **Build the owner self-service widget now** — replace the "coming soon" stub | True self-serve GA; owners connect WhatsApp themselves, not just admin-on-behalf |
| 3 | **Mobile-channel conflict → block with a clear message** | Smallest change; matches the existing 409 (`MultipleMobileChannelsError`) backend exactly. No auto-swap, no radio-picker redesign |
| 4 | **Run the three streams in parallel** | Meta template review is the multi-day long pole; submit it day-1 while the owner widget lands safely behind the flag, converge at the ship gate |

## Non-goals (explicit / YAGNI)

- **Auto-swap or radio-style channel picker** — decision #3 chose block-with-message.
- **WA per-business cost guard** — deferred per Phase 3 §5.2 pending real volume data.
- **`/admin/businesses/new` onboarding integration** for WhatsApp — follow-up if needed.
- **Multi-language STOP beyond Twilio-native EN + ES** — same policy as SMS.
- **Automated E2E against the real Twilio WA sender** — manual ship-gate walkthrough per Phase 3 §5.3.

---

## Stream ① — Verify (no code expected)

1. Run `pnpm test` scoped to: notification dispatch (`worker/jobs/notification/**`),
   WhatsApp channel/client/body (`src/lib/notifications/channels/whatsapp-*`),
   ingress (`worker/ingress/twilio/twilio-whatsapp-*`), and admin whatsapp routes
   (`src/app/api/admin/channels/whatsapp/**`). Confirm green against current `main`.
2. Re-confirm the audit findings above hold (no fixes expected).
3. If any test surfaces genuine drift, file it as a fix task in the plan before
   proceeding to activation.

---

## Stream ② — Owner self-service widget (the only net-new code)

Lands behind `CHANNELS_WHATSAPP_ENABLED` — zero customer surface until the flag
flips. Every new unit mirrors its existing Telegram counterpart.

### New files

**`src/components/dashboard/OwnerWhatsAppWidget.tsx`**
- Mirrors `OwnerTelegramWidget.tsx`.
- Uses the generic `useEnrollment` hook:
  ```ts
  useEnrollment({
    channel: 'whatsapp',
    endpoints: {
      start:  '/api/dashboard/channels/whatsapp/start',
      cancel: '/api/dashboard/channels/whatsapp/cancel',
      disable:'/api/dashboard/channels/whatsapp/disable',
      status: '/api/dashboard/channels',
    },
    postBody: {},
    initialSnapshot: rowToInitialSnapshot(initialEnrollment ?? null),
  })
  ```
- Renders the click-to-chat QR / deep link (`https://wa.me/<number>?text=start-<token>`),
  reusing the QR-rendering logic already in the admin `WhatsAppEnrollmentWidget`.
- Masks the phone handle (`maskHandle`), confirm-on-disconnect.
- Renders state copy for `idle | generating | awaiting_scan | verified | error`,
  plus the **conflict** message (see Error handling).

**`src/app/api/dashboard/channels/whatsapp/start/route.ts`**
- Mirrors `…/telegram/start/route.ts` and admin `…/whatsapp/start/route.ts`.
- `requireRole('owner')`; `locationId` from session (NEVER from body).
- Wrapped with `withSameOrigin()` (CSRF).
- Flag check → 404 (`flagOff`); env not ready → 503 (`assertWhatsAppEnvReady`).
- Subscription guard: `SELECT a.id, a.subscription_status FROM accounts a JOIN businesses b ON b.account_id = a.id WHERE b.id = ${locationId}`; non-`ACTIVE` → 403 `subscription_not_active`.
- Generate `rawToken = randomUUID()`, `tokenHash = sha256(rawToken)`, TTL from `TOKEN_TTL_MS`; build QR/deep link.
- Insert pending enrollment inside `sql.begin`; on Postgres 23505 call
  `classifyEnrollmentError(err)` → `MultipleMobileChannelsError` → **409**
  `{ error: 'multiple_mobile_channels' }`; `EnrollmentDatabaseError` → 500 (no constraint leak).
- `safeInvalidateChannelCache` after commit.
- Response headers: `Cache-Control: no-store, private`.

**`src/app/api/dashboard/channels/whatsapp/cancel/route.ts`** and
**`…/whatsapp/disable/route.ts`** — owner-scoped mirrors of the Telegram cancel/disable routes.

### Modified files

**`src/app/(authenticated)/settings/channels/ChannelsClient.tsx`**
- Replace the WhatsApp `ComingSoonChannelRow` with:
  ```tsx
  {initialAvailability.whatsapp
    ? <OwnerWhatsAppWidget initialEnrollment={findChannel(initialEnrollments, 'whatsapp')} />
    : <ComingSoonChannelRow icon="🟢" name="WhatsApp" reason="Available once Meta business verification clears" />}
  ```
  — identical pattern to the Telegram row.

**`src/app/(authenticated)/settings/channels/page.tsx`**
- `whatsappAvailable()` and `KNOWN_CHANNELS` already include WhatsApp. Verify the
  SSR enrollment query returns the `whatsapp` row for hydration; adjust only if missing.

### Data flow

```
Owner taps Connect
  → POST /api/dashboard/channels/whatsapp/start
      → pending channel_enrollments row (business_id-scoped) + QR/deep link returned
  → owner scans QR → WhatsApp opens prefilled "start-<token>" → owner taps Send
  → Twilio webhook → POST /ingress/twilio/whatsapp-inbound   (already built, Phase 3)
      → token hash match → enrollment status = 'verified'
  → widget polls /api/dashboard/channels → "Connected · ••• 1234"
```

The inbound verification path is unchanged from Phase 3; this stream only adds the
owner-initiated *start* of that flow.

### Error handling

| Condition | Response | Owner-facing |
|---|---|---|
| `CHANNELS_WHATSAPP_ENABLED !== 'true'` | 404 | Row stays "coming soon" |
| Env incomplete | 503 | "WhatsApp is temporarily unavailable" |
| Not `owner` role | 401 | — |
| Subscription not `ACTIVE` | 403 `subscription_not_active` | "Complete payment to enable WhatsApp" |
| **Another mobile channel pending/verified** | **409 `multiple_mobile_channels`** | **"Disconnect Telegram first to use WhatsApp."** (name the conflicting channel if known, else generic) |
| Other Postgres unique violation | 500 `EnrollmentDatabaseError` | Generic error (no constraint leak) |
| Token expired | per `useEnrollment` TTL handling | "Link expired — tap Connect again" |

---

## Stream ③ — Activate (ops runbook)

Extends `docs/runbooks/whatsapp-templates.md` with a go-live checklist. **Copy is
locked before submission** — the `repworth_approval_request_v1` body copy and
button labels in the runbook are final; any change after submission restarts the
Meta review clock.

1. **Provision** WABA → Twilio WhatsApp sender.
2. **Submit** `repworth_approval_request_v1` (`twilio/card`, 2 quick-reply + 1 URL
   button, 9 body variables) to Meta verbatim from the runbook → capture the
   returned Content SID.
3. **Set Railway env** (flag stays `false` until the gate passes):
   - `TWILIO_WHATSAPP_NUMBER` — `whatsapp:+<digits>`
   - `WHATSAPP_APPROVAL_TEMPLATE_SID` — the captured SID
   - `WHATSAPP_APPROVAL_URL_BASE` — must equal `NEXT_PUBLIC_APP_URL + '/approve/'`
   - existing: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `WORKER_PUBLIC_URL`, `NEXT_PUBLIC_APP_URL`
4. **Pin Twilio webhooks** → `WORKER_PUBLIC_URL/ingress/twilio/whatsapp-inbound`
   and `…/whatsapp-status`.
5. **Run the Phase 3 §5.1 eight-point ship gate** on a pilot business
   (enrollment via admin OR the new owner widget):
   webhook signature verify · click-to-chat enroll · Approve round-trip ·
   Regenerate round-trip · blocked-recipient handling · re-enrollment ·
   cross-channel race · STOP inside session.
6. **Flip** `CHANNELS_WHATSAPP_ENABLED=true` in Railway + redeploy the worker.
   `assertChannelsWhatsAppEnv` validates all env on boot (refuses to start on
   URL-base mismatch).

**Environment note:** the URL-base equality check means staging/local must either
use their own Meta-approved template SID or run with the flag off — they cannot
share the production template.

---

## Testing

**Unit (Vitest):**
- Owner whatsapp routes (`start`/`cancel`/`disable`): flag-off 404, env-not-ready
  503, auth 401, subscription-not-active 403, **409 multiple_mobile_channels**,
  happy-path token+QR generation. Mirror the admin/telegram route test files.
- `start` route: assert no raw token appears in any `console.*` argument
  (raw-token invariant), mirroring the Phase 3 anti-regression assertion.

**Component:**
- `OwnerWhatsAppWidget` renders each state (idle / generating / awaiting_scan /
  verified / conflict / error) with correct copy and the QR for awaiting_scan.

**Integration (Vitest + real Supabase pool):**
- Owner `start` → simulate `/ingress/twilio/whatsapp-inbound` with `start-<token>`
  → enrollment `verified` → `/api/dashboard/channels` reflects whatsapp. Reuse the
  Phase 3 enrollment integration harness.
- Conflict: seed a verified Telegram enrollment → owner `start` whatsapp → 409,
  no whatsapp row created.

**E2E (Playwright):**
- `/settings/channels`: Connect WhatsApp → QR renders → simulated inbound webhook
  → widget flips verified → Disconnect → idle.

**Regression:**
- Notification/dispatch + admin whatsapp + ingress suites stay green (Stream ①).

---

## Risks + mitigations (deltas from Phase 3 §5.2)

| Risk | Mitigation |
|---|---|
| Owner widget reachable before flag/env ready | Route returns 404 (flag) / 503 (env); `ChannelsClient` keeps the "coming soon" row when `initialAvailability.whatsapp` is false |
| Mobile-channel 409 confuses owners | Inline message names the conflicting channel and the required action; no silent failure |
| Owner connects while subscription lapsed | 403 `subscription_not_active`, reading status from `accounts` (multi-location-correct) |
| Template copy edited after submission | Runbook enforces copy-lock before submit; `_v1` naming reserves room for versioned resubmits |
| Staging sends URLs the prod template doesn't point at | `WHATSAPP_APPROVAL_URL_BASE` equality check in `assertChannelsWhatsAppEnv` refuses boot on mismatch |
| Owner widget regresses Telegram/SMS rows | New component + routes only; existing rows untouched; their tests are the regression net |

---

## File map

### Stream ② (new)
- `src/components/dashboard/OwnerWhatsAppWidget.tsx`
- `src/app/api/dashboard/channels/whatsapp/start/route.ts`
- `src/app/api/dashboard/channels/whatsapp/cancel/route.ts`
- `src/app/api/dashboard/channels/whatsapp/disable/route.ts`
- `src/app/api/dashboard/channels/whatsapp/__tests__/routes.test.ts`
- `src/components/dashboard/__tests__/OwnerWhatsAppWidget.test.tsx`

### Stream ② (modify)
- `src/app/(authenticated)/settings/channels/ChannelsClient.tsx`
- `src/app/(authenticated)/settings/channels/page.tsx` (verify only; modify if SSR row missing)

### Stream ③ (modify)
- `docs/runbooks/whatsapp-templates.md` (add go-live checklist + copy-lock note)

### Tests touching existing harnesses
- Owner enrollment integration test (new file alongside the Phase 3 integration suite)
- Playwright spec under the existing E2E channels suite
