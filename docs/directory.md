# RepWorth — Directory Reference

A guide to every folder and file in `src/` and `worker/`, what each one does, and how they connect.

> **Class names are stable; file paths are authoritative here.** When a worker/
> module path is referenced elsewhere (skills, reference, CLAUDE.md), this file
> is the source of truth for its current location.

> **CI-complete for `worker/` + `src/lib/`.** `pnpm ci:directory-map`
> (`scripts/ci/directory-map-audit.ts`) fails when a production `.ts`/`.tsx`
> under either root has no row here, or when a row here names a file that no
> longer exists. A **row** is a table line whose FIRST cell names the file in a
> code span (`` `x.ts` ``, `` `sub/x.ts` ``, `` `{a,b}.ts` ``), or a heading that
> names a file; the path resolves against the section heading (the `db/`
> heading under the `src/lib/` heading → `src/lib/db/`). A mention inside a description is
> NOT a row. `src/app/**` and `src/components/**` are described at folder level
> by design and are not audited.

> **The map is split into pages.** This file is the INDEX: architecture,
> `src/proxy.ts`, instrumentation, `src/hooks/`, and the end-to-end flows. Every
> folder inventory lives in a page under `docs/directory/` (one subject per page,
> each ≤ 3,000 words — see [Pages](#pages)). The audit reads this index PLUS every
> `docs/directory/*.md`, parsing each page with its own heading stack: a `src/lib/`
> page begins with `` ## `src/lib/` `` and a `worker/` page with `` ## `worker/` ``,
> so a relative `` ### `db/` `` heading resolves inside its page exactly as it did
> in the single file. Findings name `file:line`. A new production file under
> `worker/` or `src/lib/` ships with its row in the page that owns its folder.

---

## Pages

Every page starts with the verbatim `##` root heading of the folder it inventories, so a heading such as `` ### `db/` `` reads (and audits) exactly as it did in the one-file map. `src/lib/` folders are assigned by default as below; a small folder may sit on a sibling page to keep that page under the cap — the row here is the record of where it went.

| Page | Covers |
|------|--------|
| [`docs/directory/app-public.md`](directory/app-public.md) | `src/app/` intro + `(public)/` — no login required: landing + marketing pages, login / signup / password reset, the `approve/[token]` and `u/[token]` recipient pages, demo, legal, security, help. |
| [`docs/directory/app-authenticated.md`](directory/app-authenticated.md) | `src/app/(authenticated)/` — owner login required: dashboard, connect / select-location, review timeline + history, add-location, `requests/` (solicitation approval lane + contacts), `settings/` (voice, profile, billing, channels) + `src/app/onboarding/` — the pay step and the 3-step business wizard. |
| [`docs/directory/app-admin.md`](directory/app-admin.md) | `src/app/admin/` — sales partner or admin role required: shell + auth pages, overview, jobs, costs, notifications, runbook, `businesses/` (list, detail panels, new-business form), `locations/csv-import/`, flagged drafts, impersonation. |
| [`docs/directory/app-api-a.md`](directory/app-api-a.md) | `src/app/api/` part 1 — `_shared/channels/`, `u/`, `auth/`, `approve/[token]/`, `dashboard/`. |
| [`docs/directory/app-api-b.md`](directory/app-api-b.md) | `src/app/api/` part 2 (`` ### `api/` (continued) ``) — `settings/`, `settings/postal-address/`, `onboarding/`, `signup/place-prefill/`, `zernio/connect/`, `zernio/disconnect/`, `admin/`, `contact/` / `demo-request/` / `feedback/`. |
| [`docs/directory/components.md`](directory/components.md) | `src/components/` — reusable React components (folder-level, not audited). |
| [`docs/directory/lib-db-config-shared.md`](directory/lib-db-config-shared.md) | `src/lib/` intro + root modules, `db/`, `shared/` (`config/` sits in lib-dashboard-locations-accounts.md — moved to keep this page under the 3,000-word cap). |
| [`docs/directory/lib-platform.md`](directory/lib-platform.md) | `src/lib/` — `kpi/`, `agents/`, `analytics/`, `audit/`, `competitors/`, `google/`, `ranking/`, `auth/`, `llm/`, `costs/`, `publishing/`, `zernio/`, `security/`, `legal/` (`ui/` sits in lib-notifications-channels-messaging.md — cap). |
| [`docs/directory/lib-dashboard-locations-accounts.md`](directory/lib-dashboard-locations-accounts.md) | `src/lib/` — `config/`, `dashboard/`, `locations/`, `accounts/`, `past-replies/`. |
| [`docs/directory/lib-reviews-responses.md`](directory/lib-reviews-responses.md) | `src/lib/` — `reviews/`, `responses/`, `approval/`, `auto-approval/`, `escalations/`. |
| [`docs/directory/lib-moderation.md`](directory/lib-moderation.md) | `src/lib/` — `moderation/` (the local filter, the provider pass, the held-draft gate, and the Safety review). Split out when the Safety review's two files pushed `lib-reviews-responses.md` past the 3,000-word cap and every sibling was also at it — same reason as `lib-owner-operator.md`. |
| [`docs/directory/lib-refusals.md`](directory/lib-refusals.md) | `src/lib/refusals/` — the Refusal ledger. |
| [`docs/directory/lib-owner-operator.md`](directory/lib-owner-operator.md) | `src/lib/` — `agents/operator/` (Owner Operator Run A) + `responses/voice-settings.ts` (`` ### `responses/` (continued) ``) + `demos/` (moved whole from lib-platform.md, #1104). Both default pages (lib-platform.md, lib-reviews-responses.md) were at the 3,000-word cap, so these rows went to a sibling. |
| [`docs/directory/lib-solicitation-a.md`](directory/lib-solicitation-a.md) | `src/lib/solicitation/` part 1 of 3 (the folder's 5,900-word inventory is split at table boundaries; `approval.ts` alone is a 900-word row). |
| [`docs/directory/lib-solicitation-b.md`](directory/lib-solicitation-b.md) | `src/lib/solicitation/` part 2 of 3 (`` ### `solicitation/` (continued) ``). |
| [`docs/directory/lib-solicitation-c.md`](directory/lib-solicitation-c.md) | `src/lib/solicitation/` part 3 of 3 (`` ### `solicitation/` (continued) ``). |
| [`docs/directory/lib-notifications-channels-messaging.md`](directory/lib-notifications-channels-messaging.md) | `src/lib/` — `notifications/`, `channels/`, `messaging/`, `ui/`. |
| [`docs/directory/lib-admin-onboarding-payments.md`](directory/lib-admin-onboarding-payments.md) | `src/lib/` — `admin/`, `onboarding/`, `payments/`. |
| [`docs/directory/lib-account-offboarding.md`](directory/lib-account-offboarding.md) | `src/lib/account-offboarding/` — owner offboarding (cancel_only / delete_data / purge). |
| [`docs/directory/worker-root.md`](directory/worker-root.md) | `worker/` intro + root modules (`env.ts`, `index.ts`, `queues.ts`, `internal/queue-health.ts`, boot/lifecycle/sinks) + `worker/config/`. |
| [`docs/directory/worker-jobs-a.md`](directory/worker-jobs-a.md) | `worker/jobs/` part 1 — the BullMQ job-handler table + `csv-ingest/`, `judge/`, `agent-turn/`, `autonomy-suspended-notice/`, `notification/`, `escalation-notice/`, `auto-post-notice/`, `pending-post-notice/`, `solicitation-veto-notice/`. |
| [`docs/directory/worker-jobs-b.md`](directory/worker-jobs-b.md) | `worker/jobs/` part 2 (`` ### `worker/jobs/` (continued) ``) — `publisher/`, `response-generation/`, `onboarding-drip/`, `engagement-alert/`. |
| [`docs/directory/worker-jobs-c.md`](directory/worker-jobs-c.md) | `worker/jobs/` part 3 — `zernio/`, `onboarding-demo/`, `solicitation-batch/`, `solicitation-send/`, `billing/`, `account-offboarding/`. |
| [`docs/directory/worker-background.md`](directory/worker-background.md) | `worker/background/` — shared loop primitives, `pollers/` (+ `billing-reconciliation/`, `health-alert/`), `schedulers/`. |
| [`docs/directory/worker-ingress.md`](directory/worker-ingress.md) | `worker/ingress/` — inbound webhook handlers, `stripe/` per-event handlers, `resend/` Solicitation lane + classifier. |
| [`docs/directory/repo-surfaces.md`](directory/repo-surfaces.md) | `scripts/`, `tests/llm-eval/` (+ the WS6 contract-test inventory), `supabase/migrations/`, and the other top-level surfaces (`.claude/`, `docs/`, `public/`, `src/app/fonts/`, `tests/`). |

---

## High-Level Architecture

```
Browser / Vercel (Next.js)          Railway (worker process)
─────────────────────────           ────────────────────────
src/app/                            worker/
  (public)/   ← owner + visitor       index.ts        ← entry point
  (authenticated)/ ← owner dashboard  jobs/           ← BullMQ handlers
  admin/       ← sales partner        ingress/        ← webhook receivers
  onboarding/  ← self-serve signup    queues.ts       ← queue definitions
  api/         ← API routes
src/lib/      ← shared logic
src/components/
src/hooks/
src/proxy.ts
                   ↑ both sides share ↓
              src/lib/shared/   (types, queue names, outbox helpers)
              src/lib/db/       (Postgres.js client, Redis)
              src/lib/reviews/, responses/, approval/, etc.
```

**Key rule:** Next.js handles UI and thin API routes only. Every LLM call, SerpAPI call, slow operation, and inbound webhook is handled by the Railway worker.

---

## `src/proxy.ts`

Next edge proxy that runs before protected requests. Does two things:

1. **Auth protection** — ordinary Admin APIs pass through after CORS to their canonical bearer gate without creating a cookie client. Owner routes, surviving Admin pages, and the permanent impersonation API exception retain cookie-bound SSR authentication.
2. **Role + AAL gating** — reads the caller's `users` row through RLS (no service key at edge), gates owner/admin paths, and redirects to `/mfa/challenge` when current AAL2 is required.

Imports `protected-routes.ts` to know which paths need a session.

---

## `src/instrumentation.ts` / `src/instrumentation-client.ts`

Next.js instrumentation hooks. `instrumentation.ts` initialises Sentry for the Node.js server runtime (scrubs sensitive fields before sending). `instrumentation-client.ts` initialises Sentry for the browser and hooks router transitions.

---

## `src/hooks/`

Custom React hooks shared across pages.

| File | What it does |
|------|--------------|
| `useDashboardData.ts` | Fetches and refreshes `/api/dashboard` data. Returns `{ data, error, refresh }`. Used by `DashboardContent` and the connect page. |
| `useSavedFlash.ts` | The "Saved" flash a settings form raises after a successful PUT — true for 1800 ms, re-armed (not stacked) by a second save, cleared on unmount. `useSettingsForm` and `useLocationVoiceForm` each carried the state + timeout ref + cleanup effect by hand; this is the one owner. |
| `useAdminActionForm.ts` | **(#880)** The admin control plane's ONE submit-form state machine — fields, `busy`, `error`, and a success channel — replacing the hand-written `useReducer` + 7-to-9-member action union that five admin surfaces each carried a copy of (`ImpersonationStartClient`, `CsvImportClient`, `ManualRankingSection`, `PastDueExtensionPanel`, `SolicitationBatchPanel`). **The success channel is a TYPE PARAMETER, not a unified field**, because measured across the five it is four different things: a boolean flag, a message string (×2), nothing at all, and a whole `CsvImportReport`. `TOutcome` defaults to `never`, which is the honest type for a form that navigates away on success — `succeed` is then uncallable. Traps: (a) the FETCH stays in the surface — five different bodies, response shapes and failure sentences, and a hook that owned them would need a config object per surface; (b) `run` clears both channels then holds `busy`, and its `finally` clears ONLY `busy`, so a `fail`/`succeed` raised inside the body survives; (c) a surface that validates first calls `clearOutcome()` BEFORE validating and never enters `run`, so the button does not announce work that is not happening; (d) a field edit does not touch the outcome — `ManualRankingSection` is the one surface that clears on edit and composes `set` + `clearOutcome` itself rather than turning one surface's behaviour into five surfaces' API. |

---

## How the Main Flows Connect

### Owner signup (self-serve)

```
AuthIslandClient (SignupForm) → POST /api/auth/signup
  → provisionAuthUser (supabase.auth.signUp → Supabase sends the OTP confirmation email)
  → createBusinessTx (accounts + businesses + users in one tx; subscription_status pending_payment)
/signup/check-email (OTP entry) → POST /api/auth/verify-otp → email confirmed
  → enrollOwnerEmailChannel (email channel_enrollments row) → resolveFunnelEntry
  → /onboarding/pay (when ONBOARDING_DEMO_ENABLED: /onboarding/start → /onboarding/demo → /onboarding/pay)
  → POST /api/onboarding/select-plan → createCheckoutSession → Stripe Checkout
  → checkout.session.completed → worker/ingress/stripe.ts → stripe/checkout-completed.ts
  → subscription_status = 'active' ('trialing' when TRIAL_ENABLED)
  → /onboarding/payment-success polls /api/auth/signup-status → /onboarding/business wizard → /dashboard
  → owner connects Zernio: POST /api/zernio/connect/start → GET …/callback → POST …/select-location
      → finalizeConnectionTx (zernio_connections 'active' + drain_pending_owner_connect + createImportOffer)
    ├→ [Import offer accepted] POST /api/dashboard/import-offer → enqueueInitialImport
    │     → outbox row (zernio_initial_backfill) → ZernioBackfillWorker → importReview (stored, NO draft)
    └→ [live] Zernio webhook review.new (worker/ingress/zernio/zernio.ts) → outbox row (ingest_zernio_review)
  → OutboxPoller → ZernioReviewIngestWorker → processReview → outbox row (generate_response)
  → OutboxPoller → ResponseGeneratorWorker → runTriagePhase → generateResponse() → moderateResponse → outbox row (send_notification)
  → OutboxPoller → NotificationWorker → approval email sent
```

The email `channel_enrollments` row is written at verify-otp, not inside `createBusinessTx` — an owner who never verifies has
no notification channel. Post-OTP and post-login destinations are ONE pure decision, `resolveFunnelEntry`
(`src/lib/onboarding/funnel-entry.ts`); every Stripe Session parameter comes from the `accounts.checkout_attempt_*` snapshot.
Historical reviews arrive only via the consented Review import (`zernio_initial_backfill`, fail-closed `guardImportConsent`)
and are stored draft-less; the first *drafted* reply comes from the live `review.new` lane. Downstream code gates on
`subscriptionGrantsFullAccess`, never `=== 'active'`.
### Owner approves via email

```
Email link → /approve/[token] (page loads → GET /api/approve/[token] sets __device/__csrf cookies
                                → POST /api/approve/[token]/session binds the device)
  → POST /api/approve/[token]/approve  (rate limit → CSRF → device HMAC → one sql.begin)
  → approve() (src/lib/approval/token-mode.ts) → lockValidLink + verifyDevice → response status = 'approved',
      approval_method = 'owner', approval_audit_log 'approve', run-spine owner-decision outcome
  → job_outbox row (publish_response)
  → OutboxPoller → ResponsePublisherWorker
      → if Zernio active: resolveTarget (ReviewPublisher seam) + publishReply + verifyOwnReplyAttached → status = 'posted'
      → if Zernio absent: status = 'awaiting_owner_connect' + job_outbox (notify_owner_reconnect → OwnerEmailWorker, reconnect_required)
```

No `ApprovalService` class exists — `src/lib/approval/service.ts` is a barrel over `token-mode.ts` (`approve`/`edit`).
The publisher never reads `ZERNIO_PUBLISHING_ENABLED`; its only inputs are the `zernio_connections` active row and
provider errors. `awaiting_manual_post` is dead for `responses` since migration 029 (with the flag off there is no
active connection, so the row parks as `awaiting_owner_connect` and the connect finalize tx re-drives it via
`drain_pending_owner_connect`). Owner-approved posts get no `auto_post_notice` FYI.
### Zernio (re)connect — drain parked responses

```
Owner visits /dashboard/connect → /api/zernio/connect/start
  → zernioClient.createProfile + startConnect → { authUrl } → browser redirects to Zernio
  → Zernio redirects back → /api/zernio/connect/callback
  → zernioClient.listLocations → locations stashed in Redis + signed session cookie (no DB row yet)
  → /dashboard/connect/select-location → owner picks location
  → POST /api/zernio/connect/select-location → zernioClient.selectLocation → accountId
  → finalizeConnectionTx (one sql.begin): zernio_connections upsert status = 'active'
  → job_outbox row (drain_pending_owner_connect)
  → OutboxPoller → DrainOwnerConnectWorker
  → inserts publish_response outbox rows for all awaiting_owner_connect responses
  → OutboxPoller → ResponsePublisherWorker → status = 'posted'
```

The callback writes no DB row: `zernio_connections` first exists — already `'active'` — inside
`finalizeConnectionTx` (`src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts`). The same tx also
enqueues the `gbp_connected` analytics event and, only when `import_decision = 'accepted'`, the consented
Review import via `enqueueInitialImport` (`src/lib/reviews/import-consent.ts`) — conditional, so not drawn.
`listLocations` (callback) and `selectLocation` (select-location) are ADR 0001's two sanctioned synchronous
Zernio calls on Vercel; every step from `/start` on is gated by `ZERNIO_PUBLISHING_ENABLED`.
### Telegram / WhatsApp button tap

```
Owner taps "Approve" (or "Regenerate") button in Telegram / WhatsApp
  → POST /ingress/telegram (telegram.ts) / POST /ingress/twilio/whatsapp-inbound (twilio-whatsapp-inbound.ts)
  → verifyTelegramSecret / verifyTwilioSignature (401 on miss)
  → claimInboundEvent (dedup on inbound_events)
  → telegram.ts → telegram-callback.ts (callback_query) / handleButtonTap (ButtonPayload)
  → validate: approval_links live for this channel + sender is a verified channel_enrollments row
  → Telegram only: answerCallbackQuery (pre-tx toast)
  → approveViaCallback(sql, { approvalLinkId, chatHandle, viaChannel, audit })   [or regenerateViaCallback]
  → same approval path as email flow (lock → consume link → approved/owner → revoke siblings → publish_response outbox → audit)
  → editMessageText (Telegram) / sendFreeform Twilio message (WhatsApp) confirms in-chat
  → markInboundEventProcessed → 200
```

The button carries `a:<approval_links.id>` / `r:<id>`, never a raw token; the link is locked by id + channel
(`lockLinkByIdForCallback`), so a Telegram link cannot be approved from WhatsApp. Callback mode runs no
`verifyDevice` — authorization is the provider signature plus the sender-handle ↔ verified enrollment check.
Both service functions live in `src/lib/approval/callback-mode.ts`.
### Demo generation (admin-triggered)

```
Admin submits demo form → POST /api/admin/demos/generate (AAL2 + fail-closed rate limits)
  → INSERT prospect_demos (generation_status='queued') + job_outbox (generate_demo) in one tx
  → OutboxPoller → DemoGenerationWorker (claimDemo: queued → running)
  → generateDemo: fetchSerpApiReviews (SerpApiSource, real) + generateResponsesForReviews → generateResponse (demo mode, no cost guard)
  → prospect_demos generation_status = 'completed' (+ outbox completed, same tx)
  → /demo/[slug] public page shows results
```

`GET /api/admin/demos` is the list endpoint; the write is `/generate`, whose three `strict:true` rate limits are
a deliberate exception to the fail-open API-limiter rule (this LLM path has no worker cost reservation).
Distinct lane, do not merge: the PRE-pay **onboarding demo** — `POST /api/onboarding/start` → topic
`onboarding_demo_response` → `worker/jobs/OnboardingDemoWorker.ts` → table `onboarding_demos` — carries a 20¢
cost reservation and a 3-review cap; it shares only `src/lib/demos/lifecycle.ts` with this flow.
### Zernio webhook ingestion (live)

```
Zernio fires review.new / review.updated → POST /ingress/zernio
  → zernioPublishingEnabled() gate → verifyZernioSignature (HMAC-SHA256)
  → claimInboundEvent (dedup by event ID)
  → parseZernioReviewWebhook (extracts nested account.id + review id + location)
  → fan-out: one job_outbox row per active zernio_connection on this account/location
    (topic='ingest_zernio_review', dedup'd by migration 030 partial index)
  → OutboxPoller → ZernioReviewIngestWorker
  → guardZernioJobEligibility (archived-location / subscription) → connection still active
  → listReviews → location match → external-reply reconcile → PHI gate (screenPhiOrOpenException)
  → processReview (dedup by (provider, provider_review_name))
  → INSERT reviews + run spine (review_ingested) + outbox (generate_response)
  → ResponseGeneratorWorker (load-context → triage → generateDraft → moderateResponse
      → INSERT responses (pending_approval) + moderation hold + auto-approval gate)
  → outbox (send_notification) → NotificationWorker → owner notification (email / Telegram / WhatsApp)
```

No `responses` row is written at ingest — `ResponseGeneratorWorker` inserts it (`response-generation/persist.ts`).
Auto-policy branch (not the happy path): when `AUTO_APPROVAL_ENABLED` + policy/trust-dial/tier gates pass, `persist.ts`
flips the row to `approved`/`auto_policy` and enqueues `publish_response` delayed to the veto deadline plus
`pending_post_notice` INSTEAD of `send_notification`; a high-severity moderation flag holds the draft and skips both
(invariant #4). `ZernioRecentReviewPoller` is a second entry into `processReview` (in-process, 5-min poll, own
reconcile + PHI gates) — it does NOT enqueue `ingest_zernio_review`; the ingress fan-out is that topic's only producer.
### Reviews list — every review for the location, unanswered first (#678)

```
Owner navigates to /dashboard/reviews → "All Reviews" tab → /dashboard/reviews/history (no flag; renders always)
  → server component reads reviews LEFT JOIN responses (+ draft / pending_gen / orphan LATERALs)
  → grouped "Unanswered" then "Answered", newest-first within each, PAGE_SIZE 50
  → deriveAxes() per row: reply_state (none|posted|orphan) × draft_state
                          (none|generating|ready|held — server-internal, #727)
  → deriveRowAction(): the Action slot (row_action) from the 3×4 cross-product;
                       the wire carries reply_state + row_action only (ADR 0018)
  → provenanceBadge() per answered row (replaces the dead gap/historical split)
  → renders PastReplyCard rows
  → Generate  → InlineGeneratePanel → POST reviews/:id/generate (generate_response row, origin lane on_demand_generate)
                                    → GET  reviews/:id/draft-status (poll)
                                    → Approve & post → POST reviews/:id/approve (or /edit)
  → Regenerate → EditReplyDrawer → the past-replies edit routes  [EDIT_REPLIES_ENABLED]
  → Copilot and Autopilot receive the same paid history/edit entitlement
```

Imported replies arrive via the `EXTERNAL_REPLY_IMPORT_ENABLED` ingest path
inside `reconcileExternallyAnsweredReview` (see `worker/jobs/zernio/zernio-ingest-shared.ts`).

Edit / regenerate / publish / retry / restore-original flows are ON `main` behind
`EDIT_REPLIES_ENABLED` (off in every env) — revived from tag
`wip/edit-existing-replies-zernio-v1` by #56 (Phase A, flag off); the tag survives
only as the pre-split single-flag (`EDIT_EXISTING_REPLIES_ENABLED`) snapshot. The
flag stays off pending direct GBP API approval. When GBP arrives, the in-tree
structural patterns (route shapes, drawer state machine minus the recovery state,
optimistic-concurrency snapshot) carry over; the orphan-marker / DELETE+POST
locked-tx / `verify409InTx` machinery (`worker/jobs/publisher/{edit-publish,
publisher-error-handlers}.ts`, `src/lib/publishing/orphan-markers.ts`) gets dropped
(GBP's single PUT makes them moot). `EDIT_REPLIES_ENABLED` is read by BOTH Next.js
and the worker — set it in both places.
