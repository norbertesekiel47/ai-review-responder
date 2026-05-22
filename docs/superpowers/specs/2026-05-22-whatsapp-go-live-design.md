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
| 3 | **Mobile-channel conflict → block** (owner disconnects current channel first) | Smallest change; reuses the existing 409 (`MultipleMobileChannelsError`) + the shared reducer's generic "disconnect your current channel" copy. No auto-swap, no radio-picker redesign, no reducer change (channel-named copy is an explicit optional enhancement) |
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

## Stream ② — Owner self-service widget

Lands behind `CHANNELS_WHATSAPP_ENABLED` — zero customer surface until the flag
flips. Every new unit mirrors its existing Telegram counterpart.

### Refactor first — extract enrollment helpers (entry-point invariant)

`src/lib/channels/whatsapp-enrollment.ts` currently exports only
`cancelWhatsAppEnrollment`. The admin start route
(`src/app/api/admin/channels/whatsapp/start/route.ts`) **inlines** the full
advisory-lock + SELECT-FOR-UPDATE + state-machine upsert. Per the repo invariant
*"entry points orchestrate; modules own failure behavior,"* extract the logic
into the helper module so both routes orchestrate rather than duplicate:

- Add `startWhatsAppEnrollment(tx, { accountId, businessId, tokenHash, expiresAt })`
  → `{ kind: 'ok' } | { kind: 'already_verified' }`, holding the state machine
  (no row → INSERT; pending/unsubscribed/disabled → reset to pending; verified →
  `already_verified`). Caller holds the `mobile_enroll:${businessId}` advisory
  lock inside `sql.begin`. Mirrors `startTelegramEnrollment`.
- Add `disableWhatsAppEnrollment(tx, businessId)`, mirroring `disableTelegramEnrollment`.
- **Refactor the existing admin start route** to call `startWhatsAppEnrollment`
  (pure move, zero behavior change; its tests are the regression net).
- The new owner routes call the same helpers.

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
- Inside `sql.begin`: take the `mobile_enroll:${locationId}` advisory lock, then
  call `startWhatsAppEnrollment(...)` (the extracted helper). On Postgres 23505 the
  helper's caught path calls `classifyEnrollmentError(err)` → `MultipleMobileChannelsError`
  → **409** `{ error: 'multiple_mobile_channels' }`; `EnrollmentDatabaseError` → 500 (no constraint leak).
  `already_verified` → 409 `{ error: 'already_verified' }`.
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

### Unify the env-readiness predicate (review finding #4)

The "is WhatsApp available?" check is currently **inconsistent across three call
sites**, which lets the UI render a Connect button that immediately 503s:

| Call site | Vars checked |
|---|---|
| `worker/config/startup-assert.ts::assertChannelsWhatsAppEnv` | 7 vars + `whatsapp:+…` format + URL-base equality |
| `src/app/api/admin/channels/whatsapp/_shared.ts::assertWhatsAppEnvReady` | 5 vars (incl. `WHATSAPP_APPROVAL_URL_BASE`) |
| `page.tsx::whatsappAvailable` + `api/dashboard/channels/route.ts::whatsappAvailable` | **4 vars (missing `WHATSAPP_APPROVAL_URL_BASE`)** |

Fix: introduce a single shared predicate (the **5-var Next.js list** — the worker
keeps its stricter 7-var boot assertion since `WORKER_PUBLIC_URL` is worker-only)
in `whatsapp/_shared.ts`, e.g. `whatsappEnvReady(): boolean`, and have
`assertWhatsAppEnvReady`, both `whatsappAvailable()` functions, and the new owner
route guard all derive from it. After this change, `whatsappAvailable()` ⟺ the
route guard passes — no Connect button that the start route would reject.

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

The owner-facing copy is produced by the **shared** `classifyConnectError` in
`enrollment-reducer.ts` (used by every channel via `useEnrollment`). The default
scope of this spec **does not change that shared reducer** — so the spec promises
exactly the strings the reducer already emits (review finding #3). The route
status codes below are what the reducer maps from:

| Condition | Route response | Reducer copy (current, shared) |
|---|---|---|
| `CHANNELS_WHATSAPP_ENABLED !== 'true'` | 404 | "This channel is currently unavailable." (row stays "coming soon" anyway) |
| Env incomplete | 503 | "Service temporarily unavailable. Please try again." |
| Not `owner` role | 401 | "Session expired — please sign in again." |
| Subscription not `ACTIVE` | 403 `subscription_not_active` | "Session expired — please sign in again." *(generic — see note)* |
| **Another mobile channel pending/verified** | **409 `multiple_mobile_channels`** | **"Disconnect your current channel before connecting another."** *(generic, not channel-named)* |
| Already verified | 409 `already_verified` | "Already connected." |
| Other Postgres unique violation | 500 `EnrollmentDatabaseError` | "Could not connect (500)." (no constraint leak) |
| Token expired | `useEnrollment` TTL handling | re-prompt to tap Connect again |

**Optional enhancement (out of default scope, flag in plan):** to get
channel-specific 409 copy ("Disconnect Telegram first") and a distinct 403
subscription message, extend `classifyConnectError` to read an optional
`reason`/`conflictChannel` from the JSON error body and branch on it. This touches
the reducer shared by SMS/Telegram/WhatsApp, so it carries cross-channel test
cost and is deliberately excluded unless the user wants it — it only becomes
worthwhile once the backend returns `conflictingChannel` reliably and the
reducer/hook maps `multiple_mobile_channels` with that context. The 403→"session
expired" mismapping is **pre-existing** (affects Telegram today), not introduced
by this work, and low-impact: lapsed owners are normally caught by the page-level
subscription guard before they reach the channel widget.

---

## Stream ③ — Activate (ops runbook)

Extends `docs/runbooks/whatsapp-templates.md` with a go-live checklist.

### 0. Verify the template type, THEN lock copy (review finding #5)

The runbook currently specifies `twilio/card`. Per Twilio's current Content API
docs, **`twilio/card` puts all WhatsApp text in `title` (the `body` field is
RCS-only)** and constrains button-type mixing. Our template needs body text **plus
a mix of 2 QUICK_REPLY + 1 URL button** — that is the **`whatsapp/card`** content
type (real `body` field up to 1024 chars with variables; supports mixed
QUICK_REPLY/URL buttons; optional `footer`/`header`).

Actions before copy-lock:
- Update the runbook template definition from `twilio/card` → `whatsapp/card`,
  moving the message into `body`, buttons into `actions`.
- Validate the exact Content API submission JSON and the **9-variable mapping
  against `src/lib/notifications/channels/whatsapp-body.ts`** (`formatApprovalWhatsApp`
  must emit the same indices the submitted template references). The send code is
  content-type-agnostic (it passes `contentSid` + `contentVariables`), so this is
  a runbook/submission change only — *provided* the variable layout matches.
- Refs: twilio/card, whatsapp/card, WhatsApp buttons (Twilio docs).

Only after the type + variable map are verified is the copy **locked** — any
change after Meta submission restarts the review clock.

### Provisioning + env + gate

1. **Provision** WABA → Twilio WhatsApp sender.
2. **Submit** `repworth_approval_request_v1` (`whatsapp/card`, 2 quick-reply + 1 URL
   button, 9 variables) to Meta verbatim from the runbook → capture the returned
   Content SID.
3. **Set env in BOTH platforms** — Next.js routes + `/settings/channels` run on
   **Vercel**, the worker runs on **Railway** (CLAUDE.md: "Vercel = UI only").
   The flag and WhatsApp env must be set in **both**, or the UI/routes stay
   hidden/404/503 even with the worker ready (review finding #1). Flag stays
   `false` everywhere until the gate passes.

   | Var | Vercel (UI/routes) | Railway (worker) |
   |---|---|---|
   | `CHANNELS_WHATSAPP_ENABLED` | ✅ | ✅ |
   | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | ✅ | ✅ |
   | `TWILIO_WHATSAPP_NUMBER` (`whatsapp:+<digits>`) | ✅ | ✅ |
   | `WHATSAPP_APPROVAL_TEMPLATE_SID` | ✅ | ✅ |
   | `WHATSAPP_APPROVAL_URL_BASE` (= `NEXT_PUBLIC_APP_URL + '/approve/'`) | ✅ | ✅ |
   | `NEXT_PUBLIC_APP_URL` | ✅ | ✅ |
   | `WORKER_PUBLIC_URL` | — | ✅ (worker-only) |

4. **Pin Twilio webhooks** → `WORKER_PUBLIC_URL/ingress/twilio/whatsapp-inbound`
   and `…/whatsapp-status`.
5. **Canary enablement for the gate (review finding #2).** The §5.1 ship gate
   exercises admin/owner enrollment routes, which are flag-gated — so the flag
   must be ON in a controlled scope *before* the gate runs. There is no
   per-business flag; the global flag gates the routes. Pick one:
   - **(a) Staging canary (preferred):** enable the flag in a staging environment
     that has its **own** Meta-approved template SID + URL base (the URL-base
     equality check forbids sharing the prod template). Run the full gate there.
   - **(b) Prod time-boxed canary:** flip the flag in prod but enroll **only the
     pilot business**. Send attempts are naturally scoped to businesses with a
     verified WhatsApp enrollment, so only the pilot receives WhatsApp. Run the
     gate, then keep the flag on for GA (or flip back off if the gate fails).

   Run the Phase 3 §5.1 **eight-point gate** in the chosen scope: webhook
   signature verify · click-to-chat enroll · Approve round-trip · Regenerate
   round-trip · blocked-recipient handling · re-enrollment · cross-channel race ·
   STOP inside session.
6. **Full flip** once the gate passes: set `CHANNELS_WHATSAPP_ENABLED=true` in
   **both Vercel and Railway** and redeploy. Vercel exposes the owner widget +
   routes; the worker boots through `assertChannelsWhatsAppEnv` (refuses to start
   on URL-base mismatch).

**Environment note:** the URL-base equality check means staging/local must use
their own Meta-approved template SID or run flag-off — they cannot share the
production template.

---

## Testing

**Unit (Vitest):**
- `startWhatsAppEnrollment` / `disableWhatsAppEnrollment` helpers: each state
  transition (no row → INSERT; pending/unsubscribed/disabled → reset; verified →
  `already_verified`), mirroring the Telegram helper tests.
- Owner whatsapp routes (`start`/`cancel`/`disable`): flag-off 404, env-not-ready
  503, auth 401, subscription-not-active 403, **409 multiple_mobile_channels**,
  `already_verified` 409, happy-path token+QR generation. Mirror the admin/telegram route test files.
- `start` route: assert no raw token appears in any `console.*` argument
  (raw-token invariant), mirroring the Phase 3 anti-regression assertion.
- Admin start-route regression suite stays green after the helper refactor.
- Env unification: `whatsappEnvReady()` returns false when any of the 5 vars
  (incl. `WHATSAPP_APPROVAL_URL_BASE`) is missing, and `whatsappAvailable()` ⟺
  the route guard (no Connect button when the route would 503).

**Component:**
- `OwnerWhatsAppWidget` renders each state (idle / generating / awaiting_scan /
  verified / conflict / error) with correct copy and the QR for awaiting_scan.
- **Conflict copy lock:** on a 409 `multiple_mobile_channels`, assert the widget
  renders the existing generic reducer string verbatim — *"Disconnect your current
  channel before connecting another."* This pins the launch behavior and will fail
  loudly if the optional channel-named enhancement is ever added without updating
  the contract.

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
| Flag/env set on Railway but not Vercel (or vice versa) | Stream ③ env matrix sets both platforms; gate is run only after both are configured; `whatsappEnvReady()` UI check matches the route guard |
| Wrong Content type (`twilio/card`) drops body text on WhatsApp | Stream ③ step 0 switches to `whatsapp/card` and validates the 9-variable map against `whatsapp-body.ts` before copy-lock/submission |
| Admin start-route refactor changes behavior | Extraction is a pure move; existing admin route tests are the regression net and must stay green |

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
- `src/lib/channels/whatsapp-enrollment.ts` — add `startWhatsAppEnrollment`, `disableWhatsAppEnrollment`
- `src/lib/channels/__tests__/whatsapp-enrollment.test.ts` — cover the new helpers
- `src/app/api/admin/channels/whatsapp/start/route.ts` — refactor to call `startWhatsAppEnrollment` (pure move)
- `src/app/api/admin/channels/whatsapp/_shared.ts` — add unified `whatsappEnvReady()`; `assertWhatsAppEnvReady` derives from it
- `src/app/(authenticated)/settings/channels/page.tsx` — `whatsappAvailable()` uses `whatsappEnvReady()` (5-var); verify SSR whatsapp row
- `src/app/api/dashboard/channels/route.ts` — `whatsappAvailable()` uses `whatsappEnvReady()` (5-var)
- `src/app/(authenticated)/settings/channels/ChannelsClient.tsx` — swap WhatsApp stub for `OwnerWhatsAppWidget`

### Stream ③ (modify)
- `docs/runbooks/whatsapp-templates.md` — switch template to `whatsapp/card`, validate 9-var mapping, add Vercel+Railway env matrix, canary-before-gate step, copy-lock note

### Tests touching existing harnesses
- Owner enrollment integration test (new file alongside the Phase 3 integration suite)
- Playwright spec under the existing E2E channels suite
