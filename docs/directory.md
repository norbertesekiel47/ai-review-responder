# RepWorth — Directory Reference

A guide to every folder and file in `src/` and `worker/`, what each one does, and how they connect.

> **Class names are stable; file paths are authoritative here.** When a worker/
> module path is referenced elsewhere (skills, reference, CLAUDE.md), this file
> is the source of truth for its current location.

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

1. **Auth protection** — creates a cookie-bound Supabase SSR client, reads the session cookie, and redirects/blocks unauthenticated visitors away from protected routes (owner dashboard, admin, protected APIs).
2. **Role + AAL gating** — reads the caller's `users` row through RLS (no service key at edge), gates owner/admin paths, and redirects to `/mfa/challenge` when current AAL2 is required.

Imports `protected-routes.ts` to know which paths need a session.

---

## `src/instrumentation.ts` / `src/instrumentation-client.ts`

Next.js instrumentation hooks. `instrumentation.ts` initialises Sentry for the Node.js server runtime (scrubs sensitive fields before sending). `instrumentation-client.ts` initialises Sentry for the browser and hooks router transitions.

---

## `src/app/`

Next.js App Router pages, grouped by access level.

### `(public)/` — No login required

| Path | What it does |
|------|--------------|
| `page.tsx` | Landing page. Reads `SELF_SERVE_SIGNUP_ENABLED` + `x-coming-soon` header to decide whether to show the coming-soon screen or the full landing. Delegates to `LandingExperience`. |
| `login/page.tsx` | Owner login page. Renders `LoginFormClient`. |
| `login/error.tsx` | Error boundary for the login flow. |
| `signup/page.tsx` | Self-serve signup entry. Collects email. |
| `signup/error.tsx` | Error boundary for signup. |
| `signup/SignupFormClient.tsx` | Form component. Rate-checks via `checkRateLimit`, then POSTs to `/api/auth/signup`. |
| `signup/check-email/page.tsx` | "Check your inbox" screen. |
| `signup/check-email/CheckEmailClient.tsx` | Polls `/api/auth/signup-status` until confirmation completes. |
| `signup/finish/page.tsx` | Server shell for the Google OAuth finish-signup step. |
| `signup/finish/FinishSignupClient.tsx` | Second signup step (after Google OAuth). Collects business name, Place ID, tone, etc. POSTs to `/api/auth/finish-signup`. |
| `forgot-password/page.tsx` | Request a password reset email. |
| `reset-password/page.tsx` | Consume the reset token and set a new password. |
| `approve/[token]/page.tsx` | Approval page reached via a notification link. Server component loads the approval context. |
| `src/components/approval/approval-client.tsx` | Interactive Approve / Edit / Regenerate UI (lives under `src/components/`, not `(public)/`). **(WS4)** also renders the scheduled-auto-post state (`ScheduledAutoPostView`): a response in `approved`/`auto_policy` with a future `auto_post_scheduled_at` shows "posts at HH:MM UTC" + a **Cancel auto-post** action → POST `/api/approve/[token]/veto`. |
| `demo/[slug]/page.tsx` | Public demo page for a prospect. |
| `book-a-demo/page.tsx` | Demo booking form → `/api/demo-request`. |
| `features/page.tsx` | Features marketing page. |
| `features/FeaturesContent.tsx` | Features page content component. |
| `how-it-works/page.tsx` | How-it-works marketing page. |
| `how-it-works/HowItWorksContent.tsx` | How-it-works content component. |
| `pricing/page.tsx` | Pricing marketing page. |
| `terms/page.tsx` | **(Wave 1)** 308-redirects to `/legal/terms` (`permanentRedirect`). Canonical content moved to `/legal/*`; `next.config.mjs` `redirects()` also covers this at the routing layer. |
| `privacy/page.tsx` | **(Wave 1)** 308-redirects to `/legal/privacy`. |
| `legal/{terms,privacy,aup,dpa,cookies,sub-processors}/page.tsx` | **(Wave 1)** Canonical legal pages. Each renders `<LegalPage doc={legalDocs[...]} />` from the typed content module `src/lib/legal/content.ts` (no MDX). Sub-processors page lists only live vendors. |
| `security/page.tsx` | **(Wave 1)** Public security / vulnerability-disclosure page. States current posture honestly (e.g. "SOC 2 not yet complete"); contact `security@repworth.net` (mirrors `public/.well-known/security.txt`). |
| `feedback/thanks/page.tsx` | Confirmation after feedback form submission. |
| `help/contact/page.tsx` | **(Wave 2)** Public support contact page with channels and SLA expectations. External Help Scout wiring remains out-of-repo. |

**Shared public-page components (live under `src/components/`, not `(public)/`):**

- `sections/landing/LandingExperience.tsx` — the entire scroll-morph landing page (#436): one pinned, scroll-linked stage that crossfades hero video → full-bleed morph → final glass tilt card. Styled by its colocated `sections/landing/landing-experience.css`.
- `ui/PageShell.tsx` — header + footer wrapper used by all public pages.
- `ui/SiteNav.tsx` — navigation bar with logo and links.
- `ui/marketing-links.ts` — **(A+ campaign)** single owner of `NAV_LINKS` / `MARKETING_LINKS`; imported by SiteNav, SiteFooter, and LandingExperience (closed the Q1 nav-link duplication).

---

### `(authenticated)/` — Owner login required

`src/proxy.ts` redirects to `/login` if no session.

| Path | What it does |
|------|--------------|
| `layout.tsx` | Verifies session; queries `users` by `auth_id` to get `business_id`; renders `OwnerNav`. |
| `dashboard/page.tsx` | Owner dashboard — reviews list, approval actions, charts, Zernio connection banner. Renders `DashboardContent`. |
| `dashboard/reviews/[reviewId]/timeline/page.tsx` | **(WS5)** Deep-linkable owner view of one review's attributed agent runs, steps, outcomes, display state, and escalation actions. Fetches the account-scoped timeline API and renders `src/components/dashboard/timeline/`. |
| `dashboard/connect/page.tsx` | Zernio Google Business Profile connect entry point. 6-state UI: none / starting / oauth_in_progress / finalizing / active / finalize_unknown / disconnected. Shows Cancel button during oauth_in_progress; spinner-only during finalizing. |
| `dashboard/connect/select-location/page.tsx` | Server component that loads candidate GBP locations from Zernio after OAuth returns. |
| `dashboard/connect/select-location/LocationPicker.tsx` | Client component displaying the location list; POSTs selected location to `/api/zernio/connect/select-location`. |
| `dashboard/past-replies/page.tsx` | "Past Replies" tab — read-only paginated list of every review with a `posted` response, bucketed into "From your active period" (review_date >= subscription_activated_at) and "From before you joined" (review_date < activated_at, or all rows when activated_at IS NULL). Renders `PastReplyCard` rows + `HistoricalUpgradeBanner` above the historical section for non-premium owners. Gated by `PAST_REPLIES_VIEW_ENABLED`; companion ingest path gated by `EXTERNAL_REPLY_IMPORT_ENABLED`. The full edit/regenerate/recovery feature is parked on tag `wip/edit-existing-replies-zernio-v1` pending direct GBP API. |
| `dashboard/add-location/` | 4-step "add location" wizard (gated by `MULTI_LOCATION_ENABLED`). `AddLocationWizard.tsx` is a composing shell; `wizard/reducer.ts` is the pure state machine; `wizard/useAddLocationWizard.ts` owns the two fetch effects + submit/navigation; `wizard/steps/Step{1..4}*.tsx` are presentational; `wizard/billing.ts` + `wizard/payload.ts` hold the pure proration/payload helpers. |
| `settings/layout.tsx` | Settings shell — renders the grouped `SettingsSidebar` (Responses: Brand Voice, Auto-approval, Notifications · Account: Locations, Profile, Billing, Security) as a persistent left rail; each child route renders its own panel + `TopBar`. |
| `settings/page.tsx` | Index — server `redirect('/settings/voice')` (Brand Voice is the first tab). |
| `settings/voice/` | Brand Voice route (`VoiceClient` + `useLocationVoiceForm`): one panel for a single location, per-location selector when >1. Un-gated — renders for every account. |
| `settings/profile/` | Profile route — locked business-profile fields (`ProfilePanel`) + `DeleteDataPanel` danger zone. |
| `settings/billing/` | Billing route — plan, location quota, tier change, Manage-billing portal (`BillingPanel`) + `CancelSubscriptionPanel`. |
| `settings/channels/page.tsx` | Server shell for the owner channel-management page. Auth + subscription guard run server-side; fetches enrollment state for SSR hydration. |
| `settings/channels/ChannelsClient.tsx` | Client component. Renders `OwnerTelegramWidget` for Telegram (live enrollment UI) and `ComingSoonChannelRow` for WhatsApp. |

---

### `admin/` — Sales partner or admin role required

| Path | What it does |
|------|--------------|
| `layout.tsx` | Role-checks session; renders `AdminNav`. |
| `providers.tsx` | React context providers wrapping the admin layout. |
| `overview/page.tsx` | Admin dashboard overview stats. |
| `login/page.tsx` | Admin login (never gated by `SELF_SERVE_SIGNUP_ENABLED`). |
| `forgot-password/page.tsx` | Admin forgot-password. |
| `reset-password/page.tsx` | Admin reset-password. |
| `businesses/page.tsx` | List all businesses. |
| `businesses/new/page.tsx` | Create a new business. |
| `businesses/new/schema.ts` | Zod schema for the new-business form. |
| `businesses/new/components/BusinessInfoSection.tsx` | Form section: business name, Place ID, address. |
| `businesses/new/components/OwnerInfoSection.tsx` | Form section: owner email, name. |
| `businesses/new/components/SubscriptionTierSection.tsx` | Form section: tier picker. |
| `businesses/new/components/VoiceContextSection.tsx` | Form section: tone + product context. |
| `businesses/new/components/_shared.tsx` | Shared field primitives for the new-business form. |
| `businesses/new/hooks/useBusinessPrefill.ts` | Hook that calls `/api/admin/businesses/prefill` on Place ID change. |
| `businesses/[id]/page.tsx` | Business detail page (shell; delegates to sub-components). |
| `businesses/[id]/types.ts` | TypeScript types for the business detail page. |
| `businesses/[id]/hooks/useBusinessDetail.ts` | Hook that fetches and refreshes `GET /api/admin/businesses/[id]`. |
| `businesses/[id]/components/ChannelsPanel.tsx` | Displays all three channel enrollment widgets side-by-side. |
| `businesses/[id]/components/ManualPostFlow.tsx` | UI for marking a response as manually posted. |
| `businesses/[id]/components/ManualRankingSection.tsx` | Manual ranking snapshot input. |
| `businesses/[id]/components/ProfileEditor.tsx` | Inline editor for business profile fields. |
| `businesses/[id]/components/ReviewsList.tsx` | Reviews + responses list for the admin detail view. |
| `businesses/[id]/components/TrackedKeywordsSection.tsx` | Add/remove ranking keywords. |
| `businesses/[id]/components/ZernioConnectionPanel.tsx` | Displays Zernio connection status; lets admin disconnect. |
| `jobs/page.tsx` | BullMQ queue health and counts. |
| `costs/page.tsx` | API cost tracking and usage. |
| `demos/page.tsx` | Demo requests list. |
| `notifications/page.tsx` | Notification delivery logs. |
| `autonomy/page.tsx` | **(WS6)** Admin-only server shell for the suspended-autonomy queue; loads the branded `AutonomySuspensionsClient`. |
| `autonomy/AutonomySuspensionsClient.tsx` | **(WS6)** Lists account suspensions with governor rates and recent flag verdicts, collects a required operator note, and POSTs the manual unsuspend action with truthful success/conflict states. |
| `runbook/page.tsx` | Internal runbook (links to `NEXT_PUBLIC_DOCS_BASE_URL`). |
| `impersonate/page.tsx` | **(Wave 2)** Admin support entry for starting an audited read-only view-as session. |
| `impersonate/ImpersonationStartClient.tsx` | **(Wave 2)** Client form that posts account/user/ticket/reason to `/api/admin/impersonation/start` and follows the returned view URL. |
| `impersonate/[sessionId]/view/page.tsx` | **(Wave 2)** Admin-owned read-only impersonation shell. Validates the signed cookie + active DB session; does not mount owner routes. |
| `impersonate/[sessionId]/view/EndImpersonationButton.tsx` | **(Wave 2)** Ends the current impersonation session via `/api/admin/impersonation/end`. |

---

### `onboarding/`

| Path | What it does |
|------|--------------|
| `error.tsx` | Error boundary for the onboarding flow. |
| `pay/page.tsx` | Stripe checkout step during owner onboarding. |
| `pay/PlanPickerClient.tsx` | Plan tier picker; redirects to Stripe Payment Link. |
| `payment-success/page.tsx` | Shown after payment. |
| `payment-success/PaymentSuccessClient.tsx` | Polls `/api/auth/signup-status` until the subscription grants full access (paid or trial). |
| `business/page.tsx` | 3-step onboarding wizard shell. |
| `business/BusinessWizardClient.tsx` | Client orchestrator for the 3-step wizard. Tracks current step, validates each step before advancing. |
| `business/ProgressDots.tsx` | Step progress indicator. |
| `business/StepLocation.tsx` | Step 1 — business name + Place ID (uses `PlaceAutocomplete`). |
| `business/StepProfile.tsx` | Step 2 — products/services, avoid-facts. |
| `business/StepVoice.tsx` | Step 3 — response tone. |
| `business/guard.ts` | `resolveWizardDestination` — 4-rule redirect guard called server-side before rendering the wizard. |

---

### `api/` — API routes (all thin; no LLM or heavy work)

#### `auth/`

| Route | What it does |
|-------|--------------|
| `signup/route.ts` | Creates `users` + `businesses` rows in one transaction (`createBusinessTx`). Rate-limited. Returns 409 on duplicate email. |
| `finish-signup/route.ts` | Saves business details after Google OAuth. Guards against non-`email_confirmed` calls. |
| `callback/route.ts` | Supabase OAuth callback (Google sign-in). |
| `verify-otp/route.ts` | Verifies the 6-digit OTP from the confirmation email; transitions user to the onboarding flow. |
| `forgot-password/route.ts` | Requests password reset email via Supabase. |
| `reset-password/route.ts` | Consumes reset token and updates password. Signs out immediately after. |
| `mfa/challenge/route.ts` | **(Wave 2)** Same-origin, session-bound Supabase MFA challenge/verify endpoint with strict rate limiting. |
| `resend-confirmation/route.ts` | Resends verification email. Owner-only. |
| `signup-status/route.ts` | Polls whether the email confirmation has been clicked. |

#### `approve/[token]/`

The approval API. All routes read the token from the URL path and verify a device cookie + CSRF header.

| Route | What it does |
|-------|--------------|
| `route.ts` (GET) | Returns approval session data (review text, draft response, business name). **(WS4)** includes the scheduled-auto-post state (`auto_post_scheduled_at`) so the page can render the veto surface. |
| `session/route.ts` | POST: binds a device cookie to the approval session. Called on first page load. |
| `approve/route.ts` | POST: approves the draft. |
| `edit/route.ts` | POST: saves the owner's edited text. |
| `regenerate/route.ts` | POST: marks current draft superseded; enqueues a new generation job. |
| `veto/route.ts` | **(WS4)** POST: owner cancels a scheduled auto-post inside the veto window. Same wrapper machinery as the siblings (rate limit, CSRF, device binding, one tx), but the action is `vetoAutoPost` — NOT `lockPendingResponse` — because the target response is `approved`/`auto_policy`. `cancelled`/`already_cancelled` → 200 (idempotent double-tap); `too_late` → tx rollback + truthful 409. |

#### `dashboard/`

| Route | What it does |
|-------|--------------|
| `route.ts` (GET) | Returns all dashboard data for the logged-in owner (reviews, responses, metrics, Zernio connection state, pending-payment banner flag). Delegates to `src/lib/dashboard/service.ts`. |
| `reviews/[reviewId]/approve/route.ts` | Approve from dashboard. |
| `reviews/[reviewId]/edit/route.ts` | Edit from dashboard. |
| `reviews/[reviewId]/regenerate/route.ts` | Regenerate from dashboard. |
| `reviews/[reviewId]/timeline/route.ts` | **(WS5)** GET: owner/account-scoped read of one review's run timeline. Returns 404 for unknown or out-of-scope reviews and delegates all spine reads to `src/lib/agents/read.ts`. |
| `agent-team/route.ts` | **(WS5)** GET: windowed Reply/Guardian/Insights outcome counts for the current account or selected location. Foreign or archived location scopes return 404. |
| `escalations/route.ts` | **(WS5)** GET: bounded Needs-attention queue of the account's open Guardian escalations, with a separate `totalOpen` count. Delegates to `src/lib/escalations/list.ts`. |
| `escalations/[escalationId]/acknowledge/route.ts` | **(WS3)** POST: owner acknowledges an open Guardian escalation. Same-origin + owner auth + writable-subscription guard; delegates to `src/lib/escalations/transitions.ts` (404 not-found in scope, 409 already-resolved). |
| `escalations/[escalationId]/resolve/route.ts` | **(WS3)** POST: owner resolves an escalation (direct escalated → resolved stamps both timestamps). Same guards; records `escalation_resolved` on a completed run. |
_(No `past-replies/*` API routes on `feat/past-replies-view` — the tab is read-only, all data fetched server-side from the page component. The full edit/publish/retry/restore-original route set is parked on tag `wip/edit-existing-replies-zernio-v1`.)_
| `channels/route.ts` | GET: returns owner-scoped enrollment status for all channels (`{ enrollments, available, reasons }`). Auth: `businessId` from session only. |
| `channels/telegram/start/route.ts` | POST: starts a Telegram enrollment for the owner (generates QR token). |
| `channels/telegram/cancel/route.ts` | POST: cancels a pending Telegram enrollment. |
| `channels/telegram/disable/route.ts` | POST: disables an active Telegram enrollment. |

#### `settings/route.ts`

GET + POST owner settings (tone, products/services, avoid-facts).

#### `onboarding/`

| Route | What it does |
|-------|--------------|
| `business/route.ts` | POST: persists step-by-step business profile data from the 3-step wizard (`/onboarding/business`). Validates step input via `signup-schemas.ts` and updates the existing `businesses` row created at signup. |
| `select-plan/route.ts` | POST: records the selected tier and returns the matching `STRIPE_PAYMENT_LINK_*` URL for the client to redirect to. |

#### `signup/place-prefill/route.ts`

POST: hits SerpAPI for a Place ID during the self-serve signup wizard to prefill business name, address, and category. Strict rate-limited (10/min per session, 75/day global) to cap SerpAPI cost. Gated by `SELF_SERVE_SIGNUP_ENABLED`.

#### `zernio/connect/`

Handles the Zernio OAuth connect flow for GBP auto-posting. All routes gated by `ZERNIO_PUBLISHING_ENABLED`.

| Route | What it does |
|-------|--------------|
| `start/route.ts` | Initiates the Zernio OAuth flow; creates a Zernio profile, sets a signed connect-session cookie, and redirects the owner to Zernio. |
| `callback/route.ts` | Receives the OAuth callback from Zernio; creates a `zernio_connections` row and redirects to `select-location`. |
| `select-location/route.ts` | POST: finalises connection by selecting a GBP location; updates `zernio_connections` to `active`. |
| `cancel/route.ts` | POST: cancels an in-progress OAuth flow; cleans up pending DB + Redis state. |

#### `zernio/disconnect/route.ts`

POST: disconnects an active Zernio connection; marks `zernio_connections` status `disconnected`.

#### `admin/`

| Route | What it does |
|-------|--------------|
| `overview/route.ts` | Admin overview stats. |
| `businesses/route.ts` | GET list + POST create (calls `AdminOnboardingService`). |
| `businesses/prefill/route.ts` | Prefill form from Google Place ID (via SerpAPI). |
| `businesses/[id]/route.ts` | GET / PATCH / DELETE a business. |
| `businesses/[id]/channels/route.ts` | GET + POST channel enrollments. |
| `businesses/[id]/keywords/route.ts` | GET + POST ranking keywords. |
| `businesses/[id]/ranking/route.ts` | GET ranking snapshot. |
| `businesses/[id]/mark-posted/route.ts` | Mark a response as manually posted. |
| `costs/route.ts` | GET cost summary. |
| `demos/route.ts` | GET + POST demo requests. |
| `demos/generate/route.ts` | POST: queues a demo generation job via outbox. |
| `jobs/route.ts` | GET queue health. |
| `notifications/route.ts` | GET delivery logs. |
| `autonomy/suspensions/route.ts` | **(WS6)** Admin-only GET for the cross-account suspended-policy read model (current rates + five newest flag verdicts); delegates to `listSuspendedPolicies`. |
| `autonomy/unsuspend/route.ts` | **(WS6)** Admin-only POST that validates `{ accountId, note }`, takes the account-level autonomy lock inside one transaction, and maps already-manual state to 409. |
| `billing/grant-extension/route.ts` | **(Wave 2)** Admin + current-AAL2 action that grants a short past_due extension in `accounts.flags` and writes `account_audit_log`. |
| `impersonation/start/route.ts` | **(Wave 2)** Starts an audited one-hour admin impersonation session. Same-origin, admin, current AAL2, validates owner/account, sets a signed httpOnly cookie. |
| `impersonation/end/route.ts` | **(Wave 2)** Ends the current signed impersonation session and clears the cookie. |
| `locations/csv-import/route.ts` | Admin CSV bulk-location import. Returns partial-success row failures and writes aggregate audit + billing outbox. |
| `channels/telegram/_shared.ts` | `isTelegramEnabled()`, `flagOff()`, `assertTelegramEnvReady()` — shared by all Telegram admin routes. |
| `channels/telegram/start/route.ts` | POST: start Telegram enrollment (generates QR token). |
| `channels/telegram/cancel/route.ts` | POST: cancel pending enrollment. |
| `channels/telegram/disable/route.ts` | POST: disable active enrollment. |
| `channels/whatsapp/_shared.ts` | `isWhatsAppEnabled()`, `flagOff()`, `assertWhatsAppEnvReady()` — shared by all WhatsApp admin routes. |
| `channels/whatsapp/start/route.ts` | POST: start WhatsApp enrollment (sends click-to-chat link). |
| `channels/whatsapp/cancel/route.ts` | POST: cancel pending enrollment. |
| `channels/whatsapp/disable/route.ts` | POST: disable active enrollment. |

#### `contact/route.ts` / `demo-request/route.ts` / `feedback/route.ts`

Public form submission handlers. Write to DB and optionally send an internal notification email.

---

## `src/hooks/`

Custom React hooks shared across pages.

| File | What it does |
|------|--------------|
| `useDashboardData.ts` | Fetches and refreshes `/api/dashboard` data. Returns `{ data, error, refresh }`. Used by `DashboardContent` and the connect page. |

---

## `src/components/`

Reusable React components imported by multiple pages.

- Component placement convention: see `docs/src-structure-preferences.md` → "Component placement rule".

| File | What it does |
|------|--------------|
| `DashboardContent.tsx` | Top-level owner dashboard shell. Composes sub-components (`ReviewsList`, `Charts`, `ValueSummary`, `ConnectGoogleBanner`, etc.) and passes dashboard data down. |
| `OwnerNav.tsx` | Top nav bar for the owner dashboard (logo, business name, settings link, logout). |
| `AdminNav.tsx` | Top nav bar for the admin panel. |
| `PlaceAutocomplete.tsx` | Google Places autocomplete input (uses `PlaceAutocompleteElement`; guarded for SSR with `typeof window !== 'undefined'`). |
| `admin/ChannelsSection.tsx` | Admin panel section showing all three channel widgets side-by-side. |
| `admin/TelegramEnrollmentWidget.tsx` | 8-state machine UI for Telegram enrollment. Shows QR code (server-rendered data URL). 3s polling + 1h TTL countdown. |
| `admin/WhatsAppEnrollmentWidget.tsx` | 8-state machine UI for WhatsApp enrollment. Masked phone `+15•••4567`. Same polling pattern as Telegram. |
| `auth/LoginFormClient.tsx` | Login form (email + password → Supabase sign-in). |
| `auth/ForgotPasswordFormClient.tsx` | Forgot-password form. |
| `auth/ResetPasswordFormClient.tsx` | Reset-password form. |
| `dashboard/AccountStateScreens.tsx` | Full-page states for non-active accounts (pending payment, cancelled, past-due). |
| `dashboard/Charts.tsx` | Recharts-based charts for the owner dashboard (response rate, star distribution, etc.). |
| `dashboard/ConnectGoogleBanner.tsx` | Banner surfacing the owner's Zernio GBP connection state. States: active (hidden), none (blue CTA), disconnected (orange CTA), finalize_unknown (yellow ops-alert). |
| `dashboard/ComingSoonChannelRow.tsx` | Placeholder row for channels not yet available to owners (WhatsApp only). |
| `dashboard/HistoricalUpgradeBanner.tsx` | Soft upsell banner shown on the "Past Replies" tab to non-premium owners above the historical section. References the future GBP-era edit feature. Rendered when `PAST_REPLIES_VIEW_ENABLED=true` and the owner is non-premium. |
| `dashboard/PastReplyCard.tsx` | Read-only card for one already-posted Google reply on the Past Replies tab. Shows review summary on the left, current Google reply on the right, and a provenance label ("Imported from Google · YYYY-MM-DD" / "Posted via RepWorth · YYYY-MM-DD"). No edit affordances — the full edit drawer (`EditReplyDrawer`) is parked on tag `wip/edit-existing-replies-zernio-v1`. |
| `dashboard/AgentTeamStrip.tsx` | **(WS5)** Three-card Reply/Guardian/Insights summary strip. Follows the dashboard's account/location scope and time window; zero-count agents remain visible as "Standing by". |
| `dashboard/NeedsAttentionList.tsx` | **(WS5)** Owner exception queue backed by `/api/dashboard/escalations`; hidden when empty, otherwise links each open escalation to its review timeline. |
| `dashboard/timeline/` | **(WS5)** Timeline presentation package: `TimelineContent`, `RunTimeline`, `TimelineStepRow`, `RunStateBadge`, and `TimelineEscalationActions`. Renders stored persona attribution and structured facts; acknowledge/resolve actions reuse the existing Guardian transition routes. |
| `dashboard/OwnerTelegramWidget.tsx` | Owner-facing Telegram enrollment widget. Uses `useEnrollment` + `enrollmentReducer`; SSR-hydrated from server-loaded enrollment row. |
| `dashboard/ReviewActions.tsx` | Approve / Edit / Regenerate action buttons for a single review. |
| `dashboard/ReviewsList.tsx` | List of reviews with inline response drafts and action buttons. |
| `dashboard/settings/SettingsSidebar.tsx` | Grouped settings nav — vertical sidebar (desktop) / native `<select>` with `<optgroup>` (mobile ≤768px); active item from `usePathname()`. Rendered once by `settings/layout.tsx`. |
| `dashboard/ValueSummary.tsx` | Value-at-a-glance metrics strip (e.g. responses sent, approval rate). |
| `legal/LegalPage.tsx` | **(Wave 1)** Shared renderer for every `/legal/*` page. Takes a `LegalDoc` from `src/lib/legal/content.ts` and renders its title, version + effective date, and sections (prose / bullets / table). |

---

## `src/lib/`

All shared business logic. Both `src/app/` and `worker/` import from here.

### `db/`

Database and cache clients.

> **Injection convention (A+ campaign, invariant #15).** `server.ts` is the DB
> singleton **owner**, imported only by **composition roots** (route handlers,
> server pages/layouts, `worker/index.ts`/`queues.ts`, registered worker
> handlers/pollers/schedulers, ingress) + the owner-classified `auth.ts`.
> Every domain module under `src/lib/**` + every worker helper takes its DB
> client (`sql`/`supabaseServer`, or `tx` inside a transaction) as an **explicit
> parameter** — it never imports `@/lib/db/server`. Enforced strict by
> `ci:db-imports` (`scripts/ci/db-imports-audit.ts`, roots derived from
> `worker/index.ts` registration; no baseline). `jsonb(x)` is
> composition-root-only; domain modules use `tx.json(x)`.

| File | What it does |
|------|--------------|
| `server.ts` | Exports the Postgres.js `sql` tagged-template client (PgBouncer pool) and `supabaseServer` (service-role Supabase client). Also exports `jsonb(value)` helper — the only correct way to pass JSONB values. Composition-root-only import (invariant #15). |
| `browser.ts` | `supabaseClient` — Supabase JS client for browser-side code (anon key, SSR-safe cookie management). |
| `supabase-server.ts` | `createSupabaseServerClient()` — SSR Supabase client (anon key, reads request cookies). Used in API routes and middleware. |
| `auth.ts` | `requireRole(req, role)` — throws `AuthError` if the session lacks the required role. |
| `redis-cache.ts` | `getCacheRedis()` — Redis client for application caching (separate Redis instance from BullMQ). |
| `client.ts` | **Tombstone.** Previously re-exported server + browser clients. Now a comment directing imports to the correct modules. |
| `index.ts` | **Tombstone.** Same as `client.ts` — do not barrel-import server and browser together. |

### `dashboard/`

Dashboard query layer.

| File | What it does |
|------|--------------|
| `service.ts` | `buildDashboardData(businessId)` — queries reviews, responses, weekly metrics, and Zernio connection state. Returns `DashboardDataActive`. Used by `GET /api/dashboard`. |
| `types.ts` | `DashboardData` discriminated union (`DashboardDataActive | DashboardDataPendingPayment | ...`), `ZernioConnectionState`. |

### `agents/`

Run-spine write and owner-facing read contracts for attributed agent work.

| File | What it does |
|------|--------------|
| `run-spine.ts` | Single writer API for `agent_runs`, `agent_run_steps`, and `agent_outcomes`, including the authoritative step-to-persona map and idempotent active-run/outcome constraints. |
| `read.ts` | **(WS5)** Account-scoped review timeline reads, stored-attribution team-summary aggregates, and the ordered `RunDisplayState` derivation. Parses and narrows the PgBouncer-stringified `agent_runs.error` and `agent_run_steps.detail` JSONB columns. |

### `analytics/` *(Wave 2)*

First-party analytics queue and PostHog dispatch helpers.

| File | What it does |
|------|--------------|
| `events.ts` | Canonical analytics event allowlist, event-key helper, and property sanitizer. Kept in sync with migration 046 by a drift-guard test. |
| `enqueue.ts` | `enqueueAnalyticsEvent()` — inserts UUIDv7 rows into `analytics_events` with `ON CONFLICT (event_key) DO NOTHING` idempotency. |
| `posthog.ts` | Lazy PostHog server client wrapper used by Railway dispatch. Exposes configured/capture/flush/shutdown helpers. No browser SDK. |

### `shared/`

Cross-cutting utilities imported by both Next.js and worker.

| File | What it does |
|------|--------------|
| `queue-names.ts` | Canonical queue name constants. Single source of truth for `job_outbox.topic` strings and BullMQ queue names, including WS6 `judge_verdict`, `autonomy_suspended_notice`, and `autonomy_admin_alert`. |
| `queue-health-states.ts` | `QUEUE_HEALTH_JOB_STATES` — the BullMQ job-count states surfaced to the admin panel. Single owner shared by `worker/internal/queue-health.ts` and the admin jobs page (`src/app/admin/jobs`). Same no-side-effect contract as `queue-names.ts` (never imports bullmq/ioredis). |
| `worker-types.ts` | TypeScript types for every BullMQ job payload (`SyncReviewsPayload`, `GenerateResponsePayload`, etc.); **WS6** owns the suspension-trigger/evidence vocabulary and the three judge/suspension payloads here. |
| `job-outbox-helpers.ts` | Typed transactional enqueue helpers. **WS6** adds exact-partial-index-deduped helpers for judge verdicts, owner suspension notices, and admin suspension alerts; callers invoke them in the state-change transaction. |
| `outbox.ts` | `markOutboxCompleted()`, `markOutboxFailed()`, `extractOutboxHandle()` — called at the end of every job handler. **WS5/WS6:** attempt-aware failure and `markOutboxCompletedIfOwned()` completion CASes return ownership so a stale BullMQ replay cannot write coupled terminal/domain state. |
| `subscription-guard.ts` | `checkSubscription(business)` — returns the subscription status and whether the worker should proceed. Checks `cancelled` / `past_due` grace window / `pending_payment`. |
| `past-due-recovery.ts` | **(Wave 2)** Shared past_due deadline calculator. Uses `accounts.past_due_at` + `accounts.flags.past_due_extension`; consumed by UI/write guards and worker subscription guard. |
| `subscription-eligibility-sql.ts` | **(WS6)** Reusable Postgres.js fragment for publisher-equivalent subscription eligibility (`active`/`trialing` or `past_due` inside the shared grace deadline), used when selecting judge candidates. |
| `writable-subscription.ts` | **(Wave 2)** Helpers that convert shared past_due recovery state into `402 past_due_read_only` write guards. |
| `response-status.ts` | `ALL_RESPONSE_STATUSES`, `HANDLED_STATUSES`, `RECENT_REVIEW_DISPLAY_STATUSES` — centralized status groups used across dashboard metrics, admin counts, and weekly/monthly summaries. Single source of truth so `awaiting_owner_connect` is counted alongside `awaiting_manual_post` everywhere. |
| `protected-routes.ts` | List of route prefixes that require auth (used by `src/proxy.ts`). |
| `schemas.ts` | Zod validation schemas for API request bodies (admin onboarding, mark-posted, etc.). |
| `signup-schemas.ts` | Zod schemas specific to the owner signup / onboarding wizard flow. |
| `rate-limit.ts` | Redis-backed rate limiter (gracefully skips if Redis is unavailable). |
| `csrf.ts` | `assertSameOrigin()` / `SameOriginError` — CSRF guard for owner-facing POST routes. Also generates + validates CSRF tokens for the approval flow. |
| `auth-flow.ts` | Helpers for the owner signup / login flow (e.g., redirect destination resolution). |
| `auth-responses.ts` | `accountExistsResponse()` — standard anti-enumeration 409 response used by both signup and finish-signup to prevent timing-based email probing. |
| `mock-mode.ts` | `isMockMode()` — reads `MOCK_EXTERNAL_APIS`. Used everywhere external APIs are called. |
| `logger.ts` | Structured logger with correlation ID support. `createWorkerLogger(correlationId)` for worker jobs. |
| `sanitize.ts` | HTML sanitisation (strips tags from user-provided content before saving). |
| `html.ts` | `escapeHtml()` — used in notification formatters. |
| `churn-score.ts` | Computes a churn-risk score (0–100) from review + engagement metrics. |
| `feedback-hmac.ts` | HMAC generation + verification for satisfaction-pulse feedback links. |
| `db-array.ts` | `parseDbArray(val)` — parses a TEXT[] column that PgBouncer may return as a JSON-encoded string. Filters out non-string elements. |
| `request-ip.ts` | `getRequestIp(req)` — extracts the leftmost `x-forwarded-for` entry for rate-limit keying. Consistent across all callsites. |
| `constants.ts` | `NO_STORE_HEADERS` and other shared HTTP header presets. |

### `auth/`

| File | What it does |
|------|--------------|
| `route-helpers.ts` | Route wrappers for rate limiting, same-origin checks, and Supabase session reads. |
| `mfa.ts` | **(Wave 2)** Supabase AAL helper functions used by proxy and sensitive routes. |
| `require-owner-access.ts` | Server-component guard for owner-only pages. Resolves auth user → `users` row → validates role + subscription_status; redirects on failure. Returns `{ authId, businessId, email }` when all checks pass. |

### `approval/`

Everything related to the email approval link flow.

| File | What it does |
|------|--------------|
| `service.ts` | Barrel re-export of the modularized approval layer (errors, correlation, audit, locks, the three mode files). New code imports the specific module directly. |
| `token-mode.ts` / `session-mode.ts` / `callback-mode.ts` | The three approval lanes: token link (`/approve/[token]`), dashboard session, and Telegram/WhatsApp button callbacks (`approveViaCallback` — button lanes cannot edit). **(WS4)** each approve/edit chokepoint (five total) records `reply_approved_no_edit` / `reply_edited_by_owner` in-tx via `outcomes.ts`. |
| `locks.ts` | Lock + validation helpers shared by all three modes (`lockValidLink`, `lockPendingResponse`, `verifyDevice`, `consumeLink`) — `SELECT … FOR UPDATE` inside the caller's tx. |
| `http-routes.ts` | Route wrappers (`runTokenApprovalAction`, `runDashboardReviewAction`) — rate limit, CSRF, device binding, one tx, audit context, standard error mapping. **(WS4)** the dashboard wrapper takes the reviews-first lock anchor (`anchorReviewLockOrder`) as its tx's FIRST statement. |
| `outcomes.ts` | **(WS4)** Owner-decision outcome instrumentation shared by the five approve/edit chokepoints, plus `anchorReviewLockOrder` — the global lock-order anchor (unlocked pre-read of the immutable `review_id`, then reviews `FOR UPDATE` BEFORE any response lock; the veto.ts header owns the deadlock analysis). Regenerate lanes record no outcome. |
| `veto.ts` | **(WS4)** `vetoAutoPost()` — owner cancel of a scheduled auto-post (spec §2.6), takes `tx`. The pending `publish_response` outbox row is the atomicity token: succeeds IFF the tx terminalizes it while still `pending` (`completed` + `last_error='auto_post_vetoed_by_owner'` — the ONE `AUTO_POST_VETOED_BY_OWNER` marker, also written to `posting_error` below); then guarded downgrade to `pending_approval` (`posting_error='auto_post_vetoed_by_owner'`, clears `auto_post_scheduled_at`), audit `veto_cancel`, `reply_vetoed_by_owner` outcome on an active run, link consumed, re-notify enqueued. 0 rows ⇒ `too_late`/`already_cancelled` — never a posted-after-"cancelled" state. |
| `create-link.ts` | `createApprovalLink()` — generates a secure raw token (random bytes), hashes it with SHA-256, stores only the hash in `approval_links`. Channel-scoped. |
| `cookies.ts` | Device-cookie and CSRF-cookie management (set / read / clear). |
| `correlation.ts` | `recoverCorrelationId()` — reads correlation ID from the current approval session for audit logging. |
| `audit.ts` | `insertAuditLog()` — `approval_audit_log` writes, same-tx as the action they record. **WS6** adds `auto_policy_revoked_judge_unavailable` for the publisher's judge-health downgrade. |
| `errors.ts` | Approval-specific error classes (`ConsumedLinkError`, `RevokedLinkError`, `ExpiredLinkError`, `ChannelMismatchError`, `ResponseNotPendingError`; **(WS4)** `VetoTooLateError`). |
| `http-errors.ts` | Maps approval errors to HTTP status codes and response bodies. **(WS4)** maps a 40P01 deadlock-loser rollback to a retryable 409 `conflict_retry` (the veto ↔ mark-posted collision is expected concurrency, not a 500). |
| `types.ts` | Shared approval types (`ApprovalLink`, audit contexts). |

**Connection:** `NotificationWorker` and `pending-post-notice/dispatch.ts` call `create-link.ts` to produce tokens before sending. The approval API routes consume them via the mode files; the veto route calls `veto.ts`.

### `auto-approval/`

Auto-policy evaluation plus the WS6 account-level safety governor and suspension state machine.

| File | What it does |
|------|--------------|
| `flags.ts` | Server-only `autoApprovalEnabled()` / provider-readiness accessors; **WS6** adds `governorEnabled()` over `readFlag`, default off. |
| `account-lock.ts` | **(WS6)** `lockAutonomyAccount()` serializes suspend, governor, and admin-unsuspend transactions on the billing-parent account row and throws a typed not-found error. It takes no review-lane locks. |
| `governor.ts` | **(WS6)** Fair circular candidate scan, in-transaction stale revalidation, batched seven-day owner-edit/veto/judge-signal rates, minimum sample floors, and threshold evaluation for account-level suspension. |
| `suspension.ts` | **(WS6)** Idempotent account-default policy suspension (including override-only accounts), durable account audit + owner/admin outboxes in one transaction, manual admin re-arm, and the bounded admin suspension read model. WS4 suspension semantics remain authoritative. |

### `reviews/`

Everything about fetching and normalising Google reviews.

| File | What it does |
|------|--------------|
| `types.ts` | `NormalizedReview` DTO, `ReviewSource` interface, `MonitoredReview`. |
| `serpapi-source.ts` | `SerpApiSource` — implements `ReviewSource`. Calls SerpAPI to fetch reviews for a Place ID. |
| `serpapi-monitor.ts` | `SerpApiMonitor` — wraps `SerpApiSource` and detects new / edited / deleted reviews by comparing against DB. |
| `serpapi-normalize.ts` | Converts raw SerpAPI JSON to `NormalizedReview`. Computes `provider_review_id` and `review_content_hash`. |
| `serpapi-prefill.ts` | Calls SerpAPI to get business name, address, and initial star rating (used at signup). |
| `url-parser.ts` | `extractPlaceId()` / `isPlaceId()` — extracts or validates a Place ID from a Google Maps URL. |
| `place-id-resolver.ts` | Resolves a canonical Place ID from a business name + address string via SerpAPI. |
| `process-review.ts` | Processes one `NormalizedReview`: deduplication, identity-collision detection, upsert into `reviews` table. |
| `status.ts` | `REVIEW_STATUS` — canonical `reviews.status` value vocabulary (the reviews-table sibling of `shared/response-status.ts`). Guarded by `scripts/ci/reviews-status-audit.ts` (baseline ratchet on raw status literals in reviews-table SQL). |
| `detect-language.ts` | Detects the language of a review text (used to make AI respond in the same language). |
| `sentiment.ts` | `classifySentiment(starRating)` — deterministic star-based sentiment (`deterministic_star_v1`), written at review-content write sites. |
| `triage-schema.ts` | WS2/WS3 Guardian triage vocabulary — severities, issue taxonomy, suggested actions (+ `ESCALATING_ACTIONS`), `TRIAGE_SOURCE` tags, owner-facing labels (`TRIAGE_SEVERITY_LABELS` / `TRIAGE_ISSUE_LABELS`), `TriageOutputSchema` (zod), and the `TriageClassification` result type (owned here so `escalations/raise.ts` avoids a triage ⇄ raise type cycle). Leaf module (imports only zod); values in lockstep with migration 072's CHECKs. |
| `triage.ts` | WS2: `classifyReviewTriage` (cost-guarded `triage` LLM task, severity-high fallback on terminal errors) + `persistTriage` (review lock → `reviews.triage_*` UPDATE → guardian `triage` step → `ESCALATION_ENABLED`-gated `raiseEscalation` (WS3), one tx). Re-exports `TriageClassification` from `triage-schema.ts`. |
| `flags.ts` | `triageEnabled()` — `TRIAGE_ENABLED` accessor over `readFlag`. |
| `mock-source.ts` / `mock-monitor.ts` | Canned data used when `MOCK_EXTERNAL_APIS=true`. |

**Connection:** `ReviewSyncWorker` instantiates `SerpApiMonitor` → calls `process-review.ts` for each result → writes to DB → enqueues `GenerateResponsePayload` via outbox.

### `escalations/`

WS3 Guardian escalations — triage said "alert the owner", so a durable
`review_escalations` row is raised, the owner is notified, and the owner works
it acknowledge → resolve (spec `docs/superpowers/specs/2026-07-07-ws3-guardian-escalation-design.md`).

| File | What it does |
|------|--------------|
| `types.ts` | `ESCALATION_STATUS` — single owner of the `review_escalations` status vocabulary (forward-only escalated → acknowledged → resolved); `OpenEscalationStatus` (resolved rows never reach the client). |
| `flags.ts` | `escalationEnabled()` — `ESCALATION_ENABLED` accessor over `readFlag`. Checked at RAISE time (`persistTriage`) and again at SEND time (`EscalationNoticeWorker`). |
| `raise.ts` | `shouldEscalate(classification)` (derives from `ESCALATING_ACTIONS`) + `raiseEscalation()` — inside the triage-persist tx: `review_escalations` INSERT (one-open-per-review `ON CONFLICT` dedup, migration 073), `review_escalated` outcome + `escalation_raised` step (skipped for run-less legacy reviews), `escalation_notice` outbox enqueue. Lost conflict = full no-op. |
| `transitions.ts` | `acknowledgeEscalation()` / `resolveEscalation()` — owner-driven forward-only state machine; same-action repeat is an idempotent no-op, backward transition → `invalid_transition` (route maps to 409); review row FOR UPDATE first (lock-ordering rule); resolve on a completed run records `escalation_resolved`. |
| `list.ts` | **(WS5)** Account-scoped, bounded read model for the Needs-attention queue. Counts and lists unresolved escalations with explicit status/severity/oldest-first ordering and inline review/business scope joins. |

**Connection:** `persistTriage` (`reviews/triage.ts`) calls `raiseEscalation()` in the same tx as the triage write → OutboxPoller dispatches `escalation_notice` → `EscalationNoticeWorker` sends. The dashboard escalation routes call `transitions.ts`.

### `llm/`

The LLM task seam (A+ campaign PR 1c; **the sole path for every LLM
generation/insights call** — Q4/Q5 close-out) — a provider-agnostic executor
between callers (`responses/generator.ts`, `responses/review-summary.ts`,
`reviews/triage.ts`) and the OpenAI/Anthropic SDKs. Deliberately bounded: no
streaming, tool-calls, or multi-turn loops.

| File | What it does |
|------|--------------|
| `types.ts` | Task vocabulary (`LLMTaskId`: `reply_generation` \| `triage` \| `judge` \| `insights`), `LLMProvider` interface, `LLMTaskDescriptor`. Cost-guard contract: every `runLlmTask` call in production code must be wrapped in `withCostGuard` by its caller — the guard stays caller-side (the idempotent-cache write must happen inside the guarded closure). |
| `tasks.ts` | `getLlmTask(taskId)` — pinned-model registry. `OPENAI_MODEL` / `ANTHROPIC_MODEL` constants are guarded by `model-pinning.test.ts`. `reply_generation`, `insights`, `triage`, and **WS6 `judge`** are registered; judge uses the same pinned provider constants and structured `JudgeOutputSchema`. |
| `run-task.ts` | `runLlmTask(taskId, prompt)` — the executor: calls the primary provider, falls back to the secondary on failure, and classifies exhausted-attempt errors as `TransientLLMError` (worker retries) vs terminal (rethrown raw). Tasks declaring an `outputSchema` (`triage`, **WS6 `judge`**) get structured-output enforcement — fence-strip → `JSON.parse` → zod validate; schema-invalid counts as that provider attempt failing (fallback tried), all-invalid throws terminal `LLMStructuredOutputError`; validated value lands on `LLMCallResult.structured`. Production callers are cost-guarded; the explicit live-eval caller is the narrow exception. |
| `openai-provider.ts` / `anthropic-provider.ts` | Thin SDK adapters implementing `LLMProvider` — lazily construct a singleton client with `LLM_CLIENT_OPTIONS` and map the SDK response to `LLMCallResult`. |
| `client-options.ts` | `LLM_CLIENT_OPTIONS` — explicit `{ timeout: 30_000, maxRetries: 0 }`. Without it the SDKs default to a 10-minute timeout + 2 internal retries; `maxRetries: 0` makes the BullMQ + outbox-watchdog ladder the single source of retry truth. |
| `error-classifier.ts` | `isTransientLLMError(err)`, `TransientLLMError`, `redactProviderError(err)` (strips `.body`/`.response`/`.request` before logging — some 4xx provider errors echo the prompt). Moved here from the deleted `responses/llm-error-classifier.ts` re-export shim. |

**Connection:** `generator.ts` calls `runLlmTask('reply_generation', prompt)` and `review-summary.ts` calls `runLlmTask('insights', prompt)` instead of hand-rolling the primary/fallback loop. Invariant #1's ESLint ban (`@/lib/llm/*`) treats the whole directory as worker-only.

### `responses/`

AI response generation.

| File | What it does |
|------|--------------|
| `types.ts` | `BusinessContext`, `GenerationOptions`, `GenerationResult`, `VoiceExample`. |
| `generator.ts` | `generateResponse(review, context, options)` — full pipeline: cost guard → idempotent cache → `runLlmTask('reply_generation')` via the LLM seam → save → cache. Two modes: `demo` (fast, no cost guard) and `production`. |
| `prompt-builder.ts` | Builds the system prompt and user message from `BusinessContext` + `VoiceExample[]`. |
| `voice-learning.ts` | Queries DB for recent owner-edited responses to use as few-shot examples. Returns empty array until ≥ 5 examples exist. |
| `review-summary.ts` | Generates a one-line summary of a review for the weekly report. |
| `mock-generator.ts` | Returns a template response string when `MOCK_EXTERNAL_APIS=true`. |
| `judge-schema.ts` | **(WS6)** Strict structured-output contract: `pass`/`warn`/`flag`, up to five bounded reason categories, and a rationale capped at 500 characters. Shared by the LLM task and offline/live eval lane. |
| `judge-policy.ts` | **(WS6)** Versioned, hashable post-hoc safety rubric prompt covering compensation, PII, fabricated claims, and hostile tone. |
| `judge.ts` | **(WS6)** Builds delimiter-safe prompts and executes `runLlmTask('judge')` inside caller-side two-phase `withCostGuard`; Redis transport failures remain retryable and budget decisions terminal. |
| `judge-store.ts` | **(WS6)** Injected-SQL verdict insert and read helpers: idempotent verdict persistence, latest run correlation, and the subscription-eligible 24-hour unjudged auto-post anti-join. |
| `judge-health.ts` | **(WS6)** Fail-closed publisher health probe over verdict freshness and recent error density; query errors are deliberately propagated to the worker retry path. |
| `judge-flags.ts` | **(WS6)** Server-only `JUDGE_ENABLED` accessor over `readFlag`, default off. |

**Connection:** `ResponseGeneratorWorker` calls `generateResponse()`. `DemoGenerationWorker` calls it in `demo` mode.

### `notifications/`

Sending approval notifications to business owners.

| File | What it does |
|------|--------------|
| `email.ts` | Barrel re-export of the modularized email layer. New code should import directly from `email/client`, `email/headers`, or `email/templates/<family>`. |
| `email/client.ts` | `getResend()` — lazy Resend client (constructed on first use). |
| `email/headers.ts` | Shared email header helpers (List-Unsubscribe, etc.). |
| `email/templates/approval.ts` | HTML template for the approval request email. |
| `email/templates/internal.ts` | HTML template for internal admin notification emails. |
| `email/templates/manual-post.ts` | HTML template for manual-posting instruction emails. |
| `email/templates/monthly-impact.ts` | HTML template for monthly impact report emails. |
| `email/templates/onboarding.ts` | HTML template for onboarding drip emails. |
| `email/templates/owner-nudge.ts` | HTML template for owner re-engagement nudge emails. |
| `email/templates/partner-alerts.ts` | HTML templates for partner/admin alert emails. |
| `email/templates/shared.ts` | Shared layout primitives (header, footer, button) used by all templates. |
| `email/templates/weekly-value-report.ts` | HTML template for weekly value report emails. |
| `email/templates/owner-connection-lost.ts` | HTML template for Zernio "connection lost" owner email (GBP connection went offline). |
| `email/templates/owner-reconnect-required.ts` | HTML template for Zernio "reconnect required" owner email (response queued, reconnect to post). |
| `email/templates/escalation-notice.ts` | **(WS3)** HTML template for the Guardian escalation-notice owner email (severity/issue labels from `triage-schema.ts`; fallback-sourced escalations use "couldn't assess" copy, no severity claim). Delivery template `escalation_notice`. |
| `email/templates/pending-post-notice.ts` | **(WS4)** HTML template for the veto-window "your reply will post automatically" owner email — review + draft, the scheduled-post time phrase, one CTA to the tokenized approve page (view / edit / cancel). Delivery template `pending_post_notice`. |
| `email/templates/autonomy-suspended-notice.ts` | **(WS6)** Account-only HTML safety notice: auto-posting paused, drafts continue for manual approval, reason, settings CTA, and support link; accepts no review/response text. |
| `delivery.ts` | `recordNotificationDelivery()` / `insertFailedDelivery()` — writes to `notification_deliveries` — plus claim-before-send helpers for auto-post, escalation, pending-post, and **WS6 account-scoped autonomy-suspension notices**. The WS6 claim distinguishes settled vs live-pending conflicts and reaps stale claims by account before using migration 076's exact partial unique key; lifecycle uses `finalizeDeliverySent` / `failDelivery` / `releaseDeliveryClaim`. |
| `enrollments.ts` | `getVerifiedEnrollments(businessId)` — returns all `verified` channel enrollments for a business. |
| `channels/types.ts` | `ChannelId` union type; `NotificationChannel` interface — five purpose-built methods per ADR 0003 (no generic `sendText`): approval, auto-post FYI, escalation (WS3), pending-post (WS4), and account-only autonomy-suspended safety notice (WS6). |
| `channels/scheduled-post-time.ts` | **(WS4)** `formatScheduledPostTime()` — single owner of the pending-post notice's "posting at" copy (absolute UTC + relative phrase), consumed by the email template and the Telegram/WhatsApp body builders. Pure; caller supplies `now`. |
| `channels/index.ts` | `getChannel(channelId)` factory — returns the correct channel implementation. Re-exports all channel classes and typed errors. |
| `channels/email-channel.ts` | Email implementation of `NotificationChannel`; **WS6** routes autonomy suspension through the dedicated template with suspension-event idempotency. |
| `channels/telegram-channel.ts` | Telegram via Bot API. Checks `CHANNELS_TELEGRAM_ENABLED`; **WS6** sends the account-only suspension body and HTTPS settings button. |
| `channels/telegram-client.ts` | Low-level Telegram REST client (native `fetch`, 10s timeout, 4 typed error classes). |
| `channels/telegram-body.ts` | Formats the Telegram HTML messages and inline keyboards (approval request, auto-post FYI, escalation notice, **WS4** pending-post, and **WS6** autonomy-suspended notice). |
| `channels/whatsapp-channel.ts` | WhatsApp via Twilio Content API. Checks `CHANNELS_WHATSAPP_ENABLED`; **WS6** skips suspension notices cleanly when the optional approved template SID is absent. |
| `channels/whatsapp-client.ts` | Low-level WhatsApp client (Twilio SDK, 7 typed error classes, `classifyError` dispatch). |
| `channels/whatsapp-body.ts` | Builds Twilio Content variables for five WhatsApp templates (approval, autopost FYI, escalation, **WS4** pending-post, **WS6** autonomy-suspended); extracts tokens where applicable, validates the fixed WS6 settings suffix, and owns body-length budgets (authoritative copy: `docs/runbooks/whatsapp-templates.md`). |
| `channels/enrollment-reducer.ts` | Pure `(state, action) => state` reducer for QR/deep-link channel enrollment (8 states, 27 unit tests). Handles Telegram (and future Discord/Slack). No I/O or timers — all logic is side-effect-free. |
| `channels/use-enrollment.ts` | React hook wiring `enrollmentReducer` to fetch calls (start / cancel / disable / status), 3s polling loop, 1s TTL tick, and HTTP error classification. Browser-only (marked `'use client'`). |

**Connection:** `NotificationWorker` calls `getVerifiedEnrollments()` then iterates, calling `getChannel(id).send(...)` for each. Delivery is recorded with `recordNotificationDelivery()`.

### `costs/`

LLM cost tracking and enforcement.

| File | What it does |
|------|--------------|
| `tracker.ts` | `reserveCost()` / `finalizeCost()` / `refundCost()` — Redis INCRBY/DECRBY for pessimistic reservation before LLM calls. Enforces per-business and global daily ceilings. |
| `audit.ts` | `recordApiCost()` — writes completed costs to the `api_costs` table (audit trail, reconciled hourly by `ReconciliationPoller`). |

### `payments/`

| File | What it does |
|------|--------------|
| `payment-link.ts` | `getPaymentLink(businessId)` — returns the correct Stripe Payment Link URL (`STRIPE_PAYMENT_LINK_*` env vars). |

### `admin/` *(Wave 2 additions)*

Admin-side domain helpers.

| File | What it does |
|------|--------------|
| `impersonation/cookie.ts` | HMAC signs/verifies the `rw_impersonation` session cookie. |
| `impersonation/session.ts` | Starts, ends, and loads active impersonation sessions with account audit logging. |
| `impersonation/view.ts` | Resolves an admin-owned impersonation view session and loads account-scoped location data. |
| `impersonation/guard.ts` | Non-destructive action allowlist for impersonation surfaces. |

### `onboarding/`

| File | What it does |
|------|--------------|
| `create-business.ts` | `createBusinessTx(sql, params)` — atomic transaction that inserts `users` + `businesses` + `channel_enrollments` (email) rows. Used by both admin and self-serve signup. Dual mode (`admin` / `self_serve`). |
| `admin-onboarding-service.ts` | `onboardBusinessAsAdmin(sql, supabase, input)` — validates admin onboarding input, calls `createBusinessTx` in `admin` mode, handles `DuplicateEmailError`, and invites the owner via Supabase `inviteUserByEmail`. `rollbackProvisionedBusiness(sql, createdResult)` runs the shared FK-ordered 4-DELETE compensating rollback used by both failure paths. Used by `POST /api/admin/businesses`. |

### `demos/`

| File | What it does |
|------|--------------|
| `generator.ts` | `generateDemoResponses(reviews, context)` — calls `generateResponse` in `demo` mode for each review. |
| `types.ts` | Demo-specific types (`DemoRequest`, `DemoResult`). |

### `publishing/`

GBP reply publishing logic.

| File | What it does |
|------|--------------|
| `index.ts` | Barrel re-export for the publishing module. |
| `zernio-publisher.ts` | `resolveZernioReviewId()` + `publishViaZernio()` — resolves our internal SerpAPI review ID to Zernio's canonical review ID via a Redis-cached field match (displayName + rating + comment + createTime ±24h), then posts the reply via `zernioClient.publishReply()`. Falls back on transient errors. |

### `zernio/`

All Zernio API client code and shared connect-flow state.

| File | What it does |
|------|--------------|
| `client.ts` | `ZernioClient` class — typed HTTP client for the Zernio API (all endpoint kinds: `createProfile`, `startConnect`, `selectLocation`, `listReviews`, `getReview`, `publishReply`, `editReply`, `deleteReply`). Handles auth errors, validation errors, transient vs permanent errors, and the no-body endpoint set. Includes strict allowlists for safe pre-mutation 400 codes and 409 "reply already exists" codes. |
| `connect-state.ts` | Lua CAS scripts (`luaTokenCAS`, `luaCASUpdate`, `luaCASDel`) + `pendingKey(businessId)` helper for the Redis connect-flow state machine. Prevents race conditions when concurrent start/cancel flows race. |
| `connect-session-cookie.ts` | HMAC-signed cookie for the Zernio connect session. Format: `{sessionId}.{hmac}`. Mirrors the approval device-cookie pattern (`SameSite=Lax` to survive top-level OAuth redirect). |
| `errors.ts` | Typed error classes: `ZernioAuthError`, `ZernioValidationError`, `ZernioTransientError`, `ZernioPermanentError`, `ZernioReviewNotFoundError`, `ZernioReplyAlreadyExistsError`, `ZernioReplyAlreadyDeletedError`, `ZernioReplyVerificationIndeterminateError`, `ZernioRateLimitError`, plus the `inbox_addon_required` validation classification. |
| `parse-review-webhook.ts` | Parses Zernio `review.new` / `review.updated` webhook bodies. Extracts nested `account.id` per spec §5.4 (NOT flat `accountId` — common gotcha). Returns the normalized review payload used for outbox fan-out. |
| `canonicalize-reply.ts` | Normalizes reply text for comparison — strips trailing whitespace, normalizes line endings. Used by the edit-publisher to detect whether owner edits actually changed anything before calling Zernio (skips no-op writes). |
| `auth-error-fallback.ts` | `applyTransientExhaustionFallback()` — single Postgres tx that flips `zernio_connections.status='disconnected'`, transitions the response to `awaiting_owner_connect`, and enqueues `owner-email` (connection_lost). Triggered when Zernio auth/transient errors exhaust retries. |
| `types.ts` | `EndpointKind`, `ZernioConnectionStatus`, `ZernioConnectionRow`, `ZernioReview`, `ZernioLocationOption`, `ConnectPendingMarker`. |

### `security/` *(Wave 1)*

| File | What it does |
|------|--------------|
| `phi-scanner.ts` | `detectLikelyPhi(text)` — conservative likely-PHI detector. Matches well-scoped MRN / insurance-identifier patterns (identifier + digits) and a co-occurrence rule (self-reference like `my`/`we` AND a medical-context term) to avoid quarantining ordinary reviews. `redactPhiForLog()` returns a placeholder so raw text never reaches logs. Used by every Zernio ingest path to block before persistence. |

### `legal/` *(Wave 1)*

| File | What it does |
|------|--------------|
| `content.ts` | Typed legal content module — the single source of truth for every `/legal/*` page (`legalDocs` keyed by slug; each `LegalDoc` has `version`, `effectiveDate`, and ordered `sections`). Includes the reconciled sub-processor table. No MDX/markdown runtime dependency. |

### `ui/` *(Wave 1)*

| File | What it does |
|------|--------------|
| `disclosures.ts` | Shared user-facing copy. Exports `AI_DRAFT_DISCLOSURE` ("Draft generated by AI. Review carefully before approving.") so the public approval page and the in-app edit drawer render one identical string. |

---

## `worker/`

Standalone Node.js process (Railway). Entry point is `worker/index.ts`.

### `worker/env.ts`

Calls `dotenv.config({ path: '.env.local' })`. **Must be the first import in `index.ts`** — before any module that reads `process.env`.

### `worker/index.ts`

Starts everything:

1. Calls `env.ts` (dotenv load).
2. Runs startup assertions (env vars for enabled channels).
3. Creates a Fastify server on `PORT` (default 3001) with `rawBody` enabled.
4. Registers BullMQ workers (one per queue, handler imported from `jobs/`).
5. Registers webhook routes (`POST /ingress/*`).
6. Starts all pollers and schedulers.
7. On `SIGTERM` / `SIGINT`: drains workers, stops pollers, closes Fastify, exits.

### `worker/queues.ts`

Defines all BullMQ `Queue` instances (one per job type), including WS6 judge verdict, autonomy owner-notice, and autonomy admin-alert queues on the shared retry defaults. Exports:

- `queues` — object keyed by queue name.
- `topicToQueue` — maps `job_outbox.topic` strings to `Queue` instances (used by `OutboxPoller`).
- `getRedisOptions()` — Upstash Redis connection config for BullMQ.

Imports queue name constants from `src/lib/shared/queue-names.ts`.

### `worker/internal/queue-health.ts`

First-party internal endpoint backing the admin jobs panel's per-queue depth (`GET` with `WORKER_INTERNAL_SECRET` bearer auth, constant-time compare; 503 `{disabled}` when the secret is unset). Lives in `worker/internal/` because it is not third-party webhook ingress (invariant #6). Dependency-injected (secret reader + per-queue count fetcher) so `worker/index.ts` owns the BullMQ/Redis wiring. Imports the shared job-states list from `src/lib/shared/queue-health-states.ts` (and re-exports it for its callers).

### `worker/config/startup-assert.ts`

`assertChannelsSmsEnv()`, `assertChannelsTelegramEnv()`, `assertChannelsWhatsAppEnv()`, `assertSelfServeSignupEnv()`, `assertZernioEnv()` — each checks that required env vars are present when the corresponding feature flag is `true`. `assertServerOnlyFeatureOptionalBooleansEnv()` also rejects loose values for WS6 `JUDGE_ENABLED` / `GOVERNOR_ENABLED`. Called once at startup; throws if invalid.

---

### `worker/jobs/` — BullMQ Job Handlers

Each file exports a single `handle*` function that a BullMQ `Worker` calls per job.

**All handlers follow this contract:**
1. Parse the typed job payload.
2. Load DB data.
3. Check subscription status (via `checkSubscription`).
4. Do the work.
5. Call `markOutboxCompleted()` or `markOutboxFailed()`.
6. All operations are idempotent — safe to replay.

| File | Queue | What it does |
|------|-------|--------------|
| `ReviewSyncWorker.ts` | `sync-reviews` | Calls `SerpApiMonitor.poll()`, deduplicates via `process-review.ts`, enqueues `GenerateResponsePayload` per new/updated review. **Legacy SerpAPI ingestion path** — superseded by `ZernioReviewIngestWorker` when `ZERNIO_PUBLISHING_ENABLED=true`. |
| `ZernioReviewIngestWorker.ts` | `ingest-zernio-review` | Zernio webhook → outbox → this handler. Per-location `listReviews` call, dedups by Zernio's canonical `provider_review_id`, upserts into `reviews`, creates a `responses` row (`status='pending_approval'`), and enqueues `generate-response` via outbox. Migration 030's partial unique index on `(business_id, zernio_review_id)` keeps in-flight rows from duplicating during webhook retries. Maps `ZernioReviewNotFoundError` to a `review_exceptions` row + admin alert. |
| `ZernioBackfillWorker.ts` | `zernio-initial-backfill` | First-connect bulk ingestion. Walks Zernio paginated `listReviews` up to `ZERNIO_INGEST_MAX_PAGES` (default 4), gap-window-aware (uses `subscription_activated_at` to classify reviews older than the gap as "older skipped" + record count in `zernio_backfill_runs`). Concurrency 1 (heavy). Subscription-guarded. |
| `ResponseGeneratorWorker.ts` | `generate-response` | Loads review + business context, calls `generateResponse()`, saves draft, enqueues notification via outbox. **(WS5)** terminal draft failures close the matching outbox attempt and complete the active review run as failed in one reviews-first transaction. |
| `NotificationWorker.ts` | `send-notification` | Orchestrates the notification send loop. Delegates context loading to `notification/context.ts`, eligibility filtering to `notification/eligibility.ts`, and per-channel dispatch to `notification/dispatch.ts`. Skips `pending_payment` and `cancelled`. |
| `EscalationNoticeWorker.ts` | `escalation_notice` | **(WS3)** Sends the Guardian escalation notice to the owner's channels. Re-checks `ESCALATION_ENABLED` at SEND time (kill switch stops outbound notices without hiding raised escalations), reuses the approval worker's eligibility primitive, then hands off to `escalation-notice/dispatch.ts`. Afterwards records the `escalation_sent` step BEST-EFFORT (log-and-swallow — `notification_deliveries` is the authoritative per-channel record). |
| `AutoPostNoticeWorker.ts` | `auto_post_notice` | Sends the auto-approved post FYI ("your reply was posted") to the owner's channels after an `auto_policy` publish. Reuses the approval worker's eligibility primitive, then hands off to `auto-post-notice/dispatch.ts`. NEVER mutates the already-posted response — a send failure retries on this job alone. |
| `PendingPostNoticeWorker.ts` | `pending_post_notice` | **(WS4)** Sends the veto-window "your reply will post automatically" notice. Re-checks `AUTO_APPROVAL_ENABLED` at SEND time (spec §2.12; flag off ⇒ complete without sending — the publisher's downgrade backstop owns the record), loads the still-scheduled `auto_policy` response via `pending-post-notice/context.ts` freshness guards, reuses the approval worker's eligibility primitive, then hands off to `pending-post-notice/dispatch.ts`. NEVER mutates the response; the delayed publish outbox row is independent and fires at the deadline regardless. |
| `AutonomyAdminAlertWorker.ts` | `autonomy_admin_alert` | **(WS6)** Renders an internal account-suspension alert from bounded trigger/evidence facts, sends it to `ADMIN_NOTIFICATION_EMAIL`, then independently attempts Sentry warning telemetry so observability cannot poison a successful email path. |
| `ResponsePublisherWorker.ts` | `publish-response` | POST-only flow. Checks `zernio_connections` for the business. **WS6:** every unposted `auto_policy` response first passes the judge flag/health gate; disabled or unhealthy downgrades to owner review under a durable audit action, while query failures retry. Active Zernio → resolves review ID + posts via `zernio-publisher.ts`, marking `posted`. Connection required but absent → transitions to `awaiting_owner_connect` + enqueues `owner-email` (reconnect_required). Uses `publisher-error-handlers.ts` for error classification. The DELETE+POST edit branch (`runEditPublisherIfApplicable`) is parked on tag `wip/edit-existing-replies-zernio-v1` pending direct GBP API. |
| `DrainOwnerConnectWorker.ts` | `drain-owner-connect` | Re-enqueues stuck `publish_response` outbox rows when an owner (re)connects Zernio. Inserts fresh outbox entries for all `awaiting_owner_connect` responses, with three layers of idempotency (partial unique index, NOT EXISTS guard, ResponsePublisher early-exit). |
| `OwnerEmailWorker.ts` | `owner-email` | Discriminated payload router for owner-directed Zernio emails. `reconnect_required` → owner needs to reconnect Zernio so the queued reply can be published. `connection_lost` → Zernio reported GBP connection went offline. Both handlers apply subscription guard + bounce check + claim-before-send deduplication. |
| `AdminExceptionWorker.ts` | `notify-admin-exception` | Sends an internal alert email when a review processing failure requires human review. |
| `WeeklySummaryWorker.ts` | `weekly-summary` | Queries 7-day metrics and sends the Insights-labeled weekly report via Resend. **(WS5)** a newly claimed send first records and completes a `weekly_insights` run with a `digest_sent` step/outcome in the same transaction as the `sent_at` flip; replayed claims emit neither spine rows nor email. |
| `PlaceIdValidationWorker.ts` | `validate-place-id` | Verifies a Place ID is still accessible via SerpAPI; updates `place_id_verified` flag. |
| `MonthlyImpactWorker.ts` | `monthly-impact` | Generates monthly impact report email. |
| `EngagementAlertWorker.ts` | `engagement-alert` | Checks engagement thresholds, sends alert if below floor. |
| `RankingTrackingWorker.ts` | `track-ranking` | Calls SerpAPI for each keyword, saves ranking snapshots. |
| `OnboardingDripWorker.ts` | `onboarding-drip` | Sends onboarding email at the configured step (day 1 / 7 / 30). |
| `DemoGenerationWorker.ts` | `generate-demo` | Fetches SerpAPI reviews for a prospect, calls `generateResponse()` in `demo` mode, saves to `prospect_demos`. |
| `live-draft-guard.ts` | — (helper) | **(WS5)** `hasLiveOwnerActionableResponse(tx, reviewId)` — shared by `ResponseGeneratorWorker` and `publisher/failed-hook` terminal checkpoints; a run is never completed `failed` while an owner-actionable draft (non-terminal status) exists for the review. |

#### `worker/jobs/judge/` — JudgeWorker package **(WS6)**

| File | What it does |
|------|--------------|
| `JudgeWorker.ts` | Kill-switch-first post-hoc evaluator. Loads eligible posted auto-policy context, executes the cost-guarded pinned judge task, then anchors the review lock before inserting the verdict; `flag` suspends account autonomy in the same transaction. It adds no agent-run completion. |
| `context.ts` | Loads response/review/business/account context and applies post-hoc eligibility guards without leaking source-specific data into the judge prompt. |
| `failed-hook.ts` | Terminal BullMQ exhaustion checkpoint: exact-attempt-CAS fails the outbox and records an `error` verdict in a reviews-first transaction; stale replays cannot write terminal state. |

#### `worker/jobs/autonomy-suspended-notice/` — owner safety notice package **(WS6)**

| File | What it does |
|------|--------------|
| `AutonomySuspendedNoticeWorker.ts` | Account-level owner-notice orchestrator. Re-checks the current suspension event, subscription/offboarding posture, and owner channels, dispatches without review/reply content, and keeps a live delivery claim retryable. |
| `context.ts` | Loads the suspension audit event, account, delivery-anchor business, and verified enrollments; guard-and-return branches make stale/mismatched/offboarded notices harmless. |
| `dispatch.ts` | Per-channel claim-before-send loop. Handles settled claims, keeps concurrent/live pending claims incomplete, pre-filters the optional WhatsApp template, and isolates provider errors from delivery-lifecycle DB failures. |
| `errors.ts` | Pure transient-vs-terminal notice-send classifier; never mutates enrollment state. |

#### `worker/jobs/notification/` — NotificationWorker sub-modules

Extracted from `NotificationWorker.ts` to keep each concern focused. The orchestrator imports all four.

| File | What it does |
|------|--------------|
| `NotificationWorker.ts` | Orchestrator. Imports all four sub-modules below and runs the notification send loop. |
| `context.ts` | Loads response + business rows; applies early-exit guards (not found, ID mismatch, wrong status). Returns discriminated `{ result: 'ok' | 'skip' | 'fail' }`. |
| `dispatch.ts` | Per-channel send loop with isolated error handling. One failed channel does not abort the rest. Calls `getChannel()`, `createApprovalLink()`, `recordNotificationDelivery()`. |
| `eligibility.ts` | Subscription guard + feature-flag check + `getVerifiedEnrollments()`. Returns the list of channels eligible to receive the notification. |
| `errors.ts` | `classifyChannelError()` — maps provider errors to a discriminated dispatch directive (enrollment mutation, failure reason, log level). No DB writes; the dispatcher applies the directive. |

#### `worker/jobs/escalation-notice/` — EscalationNoticeWorker sub-modules

| File | What it does |
|------|--------------|
| `EscalationNoticeWorker.ts` | Orchestrator (see the queue table above). |
| `context.ts` | Loads escalation + review + business rows with escalation-specific guards: not-found/id-mismatch → fail; `resolved` → skip (moot); archived/offboarding → skip. Triage snapshot comes from the `review_escalations` row — no LLM call. |
| `dispatch.ts` | Per-channel delivery loop, SEPARATE from the approval dispatcher (no `approval_links`). Claim-before-send idempotency on `notification_deliveries` (partial-unique claim index, migration 073); pre-filters WhatsApp when `WHATSAPP_ESCALATION_TEMPLATE_SID` is unset. Log lines carry escalation ids only. |
| `errors.ts` | `classifyEscalationNoticeSendError()` — retryable (claim released for BullMQ retry) vs terminal (failed delivery row), driven by the single-owner `isTransientChannelSendError` predicate; never flips enrollment. |

#### `worker/jobs/auto-post-notice/` — AutoPostNoticeWorker sub-modules

| File | What it does |
|------|--------------|
| `AutoPostNoticeWorker.ts` | Orchestrator (see the queue table above). |
| `context.ts` | Loads the posted `auto_policy` response + business rows; skip guards (not found/mismatch → fail; not posted / not auto-policy / archived / offboarding → skip). |
| `dispatch.ts` | Per-channel FYI loop — no `approval_links` (the post already happened; single "View on Google" CTA). Claim-before-send idempotency via `claimAutoPostNoticeDelivery`; pre-filters WhatsApp when `WHATSAPP_AUTOPOST_TEMPLATE_SID` is unset. |
| `errors.ts` | Retryable-vs-terminal classification for FYI sends; never flips enrollment. |

#### `worker/jobs/pending-post-notice/` — PendingPostNoticeWorker sub-modules **(WS4)**

Third topic-clone sibling of `auto-post-notice`/`escalation-notice` (bounced-owner email skip included from day one).

| File | What it does |
|------|--------------|
| `PendingPostNoticeWorker.ts` | Orchestrator (see the queue table above). |
| `context.ts` | Loads response + review + business rows with veto-window freshness guards: not found/mismatch → fail; no longer `approved`/`auto_policy` (vetoed, kill-switch-downgraded, posted, superseded) → skip; `auto_post_scheduled_at` NULL or already passed → skip (stale backlog — an unactionable notice is noise); archived/offboarding → skip. Deadline staleness is compared IN SQL against the same DB clock that stamped it. |
| `dispatch.ts` | Per-channel delivery loop. Unlike its two siblings it creates an approval link per delivery (`create-link.ts`) — the notice's single CTA is the tokenized approve page (view / edit / cancel). Claim-before-send idempotency via `claimPendingPostNoticeDelivery` (partial-unique claim index, migration 074); pre-filters WhatsApp when `WHATSAPP_PENDING_POST_TEMPLATE_SID` is unset. Log lines carry ids only; the raw token is redacted from `failure_reason` too (invariant #5). |
| `errors.ts` | Retryable (claim released for BullMQ retry) vs terminal (failed delivery row), driven by the single-owner `isTransientChannelSendError`; never flips enrollment. Notice delivery failure never blocks the publish. |

#### `worker/jobs/publisher/` — ResponsePublisher helpers

| File | What it does |
|------|--------------|
| `publisher-error-handlers.ts` | Maps Zernio API errors raised by `ResponsePublisherWorker` to typed dispatch outcomes (`PublisherTransientWithContext`, `PublisherTerminalWithContext`, etc.). Keeps the worker handler small by externalizing the error → action mapping. |
| `failed-hook.ts` | BullMQ exhaustion hook for publish jobs. **(WS5)** only terminal/no-resume branches complete the active run as failed, with reviews-first locking and exact outbox-attempt CAS; reconnect-resumable branches deliberately leave the run running. |
| `judge-gate.ts` | **(WS6)** Fail-closed auto-policy publish gate: `JUDGE_ENABLED` off or unhealthy verdict processing atomically downgrades to owner review; health-query errors propagate for retry. |
| `auto-policy-downgrade.ts` | Shared kill-switch/notice/judge downgrade transaction. **WS6** enforces reviews → businesses → responses locking, claims the exact outbox attempt before mutation, and records the judge-unavailable audit plus owner re-notification atomically. |

#### `worker/jobs/zernio/` — Zernio ingestion helpers

| File | What it does |
|------|--------------|
| `zernio-ingest-shared.ts` | Shared helpers for `ZernioReviewIngestWorker` and `ZernioBackfillWorker` — webhook fan-out (insert one outbox row per active Zernio connection), pagination state, `processReview()` deduplication, and outbox claim helpers. Also `reconcileExternallyAnsweredReview()` (which PHI-gates before each import branch) and **(Wave 1)** `openPhiReviewException()` — opens a `zernio_likely_phi_review` exception + admin-notify outbox row in one **caller-owned** transaction (`sql.begin`), idempotent via `ON CONFLICT DO NOTHING`, Sentry only on a newly-created row. |

### `worker/background/` — Background Loops (Pollers & Schedulers)

These are not BullMQ job handlers — they run as standalone loops inside the worker process. Split into two subfolders by trigger model: `pollers/` react to Postgres state, `schedulers/` fire on time-based cadences.

#### `worker/background/pollers/` — Postgres-state-driven loops

| File | What it does |
|------|--------------|
| `OutboxPoller.ts` | Every 10s: (1) watchdog resets stuck `dispatching` rows, (2) reads `pending` rows and dispatches to BullMQ via `topicToQueue`, (3) marks corresponding rows `completed`. Uses `FOR UPDATE SKIP LOCKED` for safe concurrency. |
| `NotificationFailoverPoller.ts` | Detects notifications stuck in `sent` without a delivery confirmation; alerts admin if all channels failed. Skipped when `NOTIFICATION_FAILOVER_DISABLED=true` or mock mode. |
| `ArchivalPoller.ts` | Archives old reviews, responses, and cost rows to keep the main tables fast. |
| `EngagementMonitorPoller.ts` | Scans businesses for low-engagement signals and enqueues `engagement-alert` jobs. |
| `CleanupAbandonedSignupsPoller.ts` | Deletes `users` + `businesses` rows where signup was never completed (configurable batch + interval). TOCTOU-safe via `FOR UPDATE` re-validation inside the tx. |
| `EmailChannelReconcilePoller.ts` | Detects `active`-subscription owner businesses with no `channel_enrollments` email row and inserts one. Recovers from `verify-otp` / `finish-signup` inline INSERT failures. |
| `StripeLocationsReconcilePoller.ts` | Hourly billing drift detection. **Wave 1 (PR #85)** expanded it from location-count drift to full reconciliation: missing / duplicate / status / price / quantity / upcoming-invoice drift between Stripe and the DB → Sentry alert; **never auto-corrects**. Expected-invoice math lives in the `billing-reconciliation/` subfolder and uses *stored* grandfathered quota; `past_due` within the 7-day grace window is informational. Single-flight + per-account error isolation. |
| `ZernioRecentReviewPoller.ts` | Polls connected accounts for recent reviews. Unanswered → `processReview`; externally-answered → `reconcileExternallyAnsweredReview`. **Wave 1:** the unanswered branch now PHI-gates (`detectLikelyPhi`) before persistence, quarantining via `openPhiReviewException` inside a `sql.begin`. |
| `AnalyticsDispatchPoller.ts` | **(Wave 2)** Dispatches pending `analytics_events` rows to PostHog from Railway. Leaves rows pending when PostHog is unconfigured, flushes before marking completed, and backs off failed event rows. |
| `JudgeSweepPoller.ts` | **(WS6)** Every minute by default, scans the bounded 24-hour window for subscription-eligible posted auto-policy responses with no verdict and transactionally enqueues deduplicated `judge_verdict` jobs. `JUDGE_ENABLED` off makes the cycle inert. |

**`worker/background/pollers/billing-reconciliation/` *(Wave 1)*:** focused modules for `StripeLocationsReconcilePoller` — `expected-invoice.ts` (DB-expected base + overage from stored quota), `drift.ts` (drift classification, grace-window check, upcoming-invoice comparison), `types.ts` (shared shapes). The poller stays the single registered entry point.

#### `worker/background/schedulers/` — Time-cadence-driven loops

| File | What it does |
|------|--------------|
| `WeeklySummaryScheduler.ts` | Enqueues `weekly-summary` jobs for all `active` businesses on schedule. |
| `MonthlyImpactScheduler.ts` | Enqueues `monthly-impact` jobs. |
| `RankingTrackingScheduler.ts` | Enqueues `track-ranking` jobs when `RANKING_TRACKING_ENABLED=true`. |
| `OnboardingDripScheduler.ts` | Enqueues `onboarding-drip` jobs at configured intervals. |
| `AutonomyGovernorScheduler.ts` | **(WS6)** Every 15 minutes by default, fairly rotates through autonomous accounts, computes seven-day rates, revalidates a breached candidate under the account lock, and invokes the idempotent suspension writer. `GOVERNOR_ENABLED` off makes the cycle inert. |

---

### `worker/ingress/` — Inbound Webhook Handlers

Each handler is registered as a Fastify route in `worker/index.ts`. They all follow the same pattern:

1. Verify the request signature.
2. Write an `inbound_events` row first (deduplication — rejects duplicate event IDs).
3. Execute business logic (update DB, write to `job_outbox`).
4. Return `200` quickly.

| File | Route | What it does |
|------|-------|--------------|
| `shared.ts` | *(utility)* | `claimInboundEvent()`, `markInboundEventProcessed()`, `markInboundEventFailed()` — atomically insert/update `inbound_events` rows. Used as the dedup guard in every other ingress handler. |
| `stripe.ts` | `POST /ingress/stripe` | Verifies Stripe webhook signature. `checkout.session.completed` → transitions `subscription_status` to `active` + enqueues `SyncReviewsPayload`. `customer.subscription.updated` → updates status. |
| `resend.ts` | `POST /ingress/resend` | Verifies Svix signature. Maps `email.delivered` / `email.bounced` / `email.complained` events to `notification_deliveries` status updates and `owner_email_bounced` flag; **WS6** classifies `autonomy_suspended_notice` as owner-directed for hard-bounce suppression. |
| `twilio/twilio-intent.ts` | *(utility)* | `classifyIntent(body)` — shared STOP/START keyword detection used by WhatsApp ingress. |
| `twilio/twilio-verify.ts` | *(utility)* | Verifies Twilio request signatures (HMAC-SHA1 on URL + params). |
| `twilio/twilio-whatsapp.ts` | *(barrel)* | Re-exports both WhatsApp ingress handlers and shared helpers for unit tests. Mounts were moved to focused modules. |
| `twilio/twilio-whatsapp-status.ts` | `POST /ingress/twilio/whatsapp-status` | WhatsApp delivery status callback. Signature verify → dedup on `${MessageSid}:${MessageStatus}` → first-wins terminal state → update `notification_deliveries`. |
| `twilio/twilio-whatsapp-inbound.ts` | `POST /ingress/twilio/whatsapp-inbound` | WhatsApp inbound message handler. Routes: ButtonPayload (Approve/Regenerate tap) → `approveViaCallback`; `start-<token>` deep link → enrollment; STOP keyword → opt-out; everything else → log + mark processed. |
| `twilio/whatsapp-shared.ts` | *(utility)* | `fullUrl()` and redaction helpers shared by both WhatsApp status and inbound handlers. |
| `telegram/telegram.ts` | `POST /ingress/telegram` | Orchestrator. Verifies webhook secret, dispatches to `telegram-enrollment.ts` (`/start <token>`) or `telegram-callback.ts` (callback_query). Rejects group/channel chats on `/start`. PII stripped before `inbound_events.payload` write. |
| `telegram/telegram-enrollment.ts` | *(called by telegram.ts)* | Handles `/start <rawToken>` — looks up `channel_enrollments` by SHA-256(token), flips status to `verified`, stores `chat_id` as handle. Model A ack ordering: `markInboundEventProcessed` before confirmation `sendMessage`. |
| `telegram/telegram-callback.ts` | *(called by telegram.ts)* | Handles `callback_query` (Approve / Regenerate button taps). Model A ack ordering: validate → `answerCallbackQuery` → approval tx → `editMessageText`. Permanent link-state errors edit message in place; unexpected errors return 503 for retry. |
| `telegram/telegram-shared.ts` | *(utility)* | Narrow Telegram update DTO type, link-state error classifier, and small helpers shared by `telegram-enrollment.ts` and `telegram-callback.ts`. |
| `telegram/telegram-verify.ts` | *(utility)* | Constant-time comparison of `X-Telegram-Bot-Api-Secret-Token` header against `TELEGRAM_WEBHOOK_SECRET`. |
| `zernio/zernio.ts` | `POST /ingress/zernio` | Zernio event webhook handler. HMAC-SHA256 verification (via `zernio-verify.ts`). Routes: `account.disconnected` → marks `zernio_connections` disconnected + enqueues `owner-email` (connection_lost). Reads nested `body.account.id` per spec §5.4. |
| `zernio/zernio-verify.ts` | *(utility)* | `verifyZernioSignature()` — HMAC-SHA256 verification using `ZERNIO_WEBHOOK_SECRET`. |

---

## How the Main Flows Connect

### Owner signup (self-serve)

```
SignupFormClient → POST /api/auth/signup
  → createBusinessTx (users + businesses + email enrollment in one tx)
  → Supabase sends OTP confirmation email
/signup/check-email polls /api/auth/signup-status
  → POST /api/auth/verify-otp → email confirmed
  → /onboarding/pay → Stripe checkout → stripe.ts ingress webhook
  → subscription_status = 'active' + job_outbox row (sync-reviews)
  → OutboxPoller → ReviewSyncWorker → process-review → outbox row (generate-response)
  → OutboxPoller → ResponseGeneratorWorker → generateResponse() → outbox row (send-notification)
  → OutboxPoller → NotificationWorker → approval email sent
```

### Owner approves via email

```
Email link → /approve/[token] (page loads, binds device cookie via /session)
  → POST /api/approve/[token]/approve
  → ApprovalService.approve() → response status = 'approved'
  → job_outbox row (publish-response)
  → OutboxPoller → ResponsePublisherWorker
      → if Zernio active: resolveZernioReviewId + publishReply → status = 'posted'
      → if Zernio absent: status = 'awaiting_owner_connect' + owner-email (reconnect_required)
      → if no Zernio flag: status = 'awaiting_manual_post'
```

### Zernio (re)connect — drain parked responses

```
Owner visits /dashboard/connect → /api/zernio/connect/start
  → ZernioClient.createProfile + startConnect → OAuth redirect to Zernio
  → Zernio redirects back → /api/zernio/connect/callback
  → zernio_connections row created (pending)
  → /dashboard/connect/select-location → owner picks location
  → POST /api/zernio/connect/select-location → zernio_connections status = 'active'
  → job_outbox row (drain-owner-connect)
  → OutboxPoller → DrainOwnerConnectWorker
  → inserts publish_response outbox rows for all awaiting_owner_connect responses
  → OutboxPoller → ResponsePublisherWorker → status = 'posted'
```

### Telegram / WhatsApp button tap

```
Owner taps "Approve" button in Telegram / WhatsApp
  → telegram.ts / twilio-whatsapp-inbound.ts ingress
  → claimInboundEvent (dedup)
  → approveViaCallback(token, channel, auditContext)
  → same approval path as email flow
  → editMessageText / answerCallbackQuery confirms in-chat
```

### Demo generation (admin-triggered)

```
Admin submits demo form → POST /api/admin/demos
  → INSERT prospect_demos + job_outbox (generate-demo) in one tx
  → OutboxPoller → DemoGenerationWorker
  → SerpApiSource (real) + generateResponse (demo mode, no cost guard)
  → prospect_demos status = 'completed'
  → /demo/[slug] public page shows results
```

### Zernio webhook ingestion (live)

```
Zernio fires review.new / review.updated → POST /ingress/zernio
  → verifyZernioSignature (HMAC-SHA256)
  → claimInboundEvent (dedup by event ID)
  → parseReviewWebhook (extracts nested account.id)
  → fan-out: one job_outbox row per active zernio_connection on this account
    (topic='ingest-zernio-review', dedup'd by migration 030 partial index)
  → OutboxPoller → ZernioReviewIngestWorker
  → listReviews → processReview (dedup by provider_review_id)
  → INSERT reviews + INSERT responses (pending_approval) + outbox (generate-response)
  → ResponseGeneratorWorker → NotificationWorker → owner email
```

### Past replies — read-only history of every posted Google reply

```
Owner navigates to /dashboard/past-replies (PAST_REPLIES_VIEW_ENABLED=true)
  → server component reads reviews JOIN responses ON status='posted'
  → bucketed into "From your active period" (review_date >= activated_at)
                + "From before you joined" (review_date < activated_at)
  → renders PastReplyCard rows (review + reply + provenance label)
  → HistoricalUpgradeBanner above the historical section for non-premium owners
  → no further action — the tab is read-only on this branch
```

Imported replies arrive via the `EXTERNAL_REPLY_IMPORT_ENABLED` ingest path
inside `reconcileExternallyAnsweredReview` (see `worker/jobs/zernio/zernio-ingest-shared.ts`).

Edit / regenerate / publish / retry / restore-original flows are parked on
tag `wip/edit-existing-replies-zernio-v1` pending direct GBP API approval.
When GBP arrives, the parked branch's structural patterns (route shapes,
drawer state machine minus the recovery state, optimistic-concurrency
snapshot) can be cherry-picked; the orphan-marker / DELETE+POST locked-tx /
verify409InTx machinery gets dropped (GBP's single PUT makes them moot).

---

## `scripts/`

Operational scripts. Run with `tsx scripts/<name>.ts`. Not part of the runtime.

| File | What it does |
|------|--------------|
| `redis.ts` | Helpers for the other scripts to construct Redis clients from env vars (avoids re-implementing `getCacheRedis` outside the app). |
| `clear-signup-rate-limits.ts` | Wipes signup rate-limit keys in Redis. Used when a real owner gets stuck behind rate limits during dev / first-customer onboarding. |
| `zernio-count-reviews.ts` | One-shot diagnostic: hits Zernio `listReviews` for a given business and prints counts per page. Used during the Zernio ingestion smoke test to verify pagination + tier caps. |
| `zernio-backfill-external-replies.ts` | One-off backfill helper for the read-only Past Replies feature (migration 031). Walks Zernio reviews for a business and ingests existing owner replies as `posted` responses so they appear in the "Past Replies" tab. Requires `EXTERNAL_REPLY_IMPORT_ENABLED=true` to run (otherwise the underlying helpers no-op). Idempotent. |
| `ci/rls-audit.ts` | **(Wave 1)** Reads `pg_class.relrowsecurity` and exits non-zero if any tenant-scoped table (see `ci/tenant-tables.ts`) has RLS disabled. Needs a DB URL — documented as staging-gated until `TEST_DATABASE_POOL_URL` is in CI. |
| `ci/tenant-scope-audit.ts` | **(Wave 1)** Static scan of inline `sql\`…\`` queries in `src/` + `worker/`; flags `SELECT`/`UPDATE`/`DELETE` on a tenant table without an `account_id`/`business_id` predicate. Runs in the blocking `lint` CI job. Backed by `ci/tenant-scope-allowlist.ts` (vetted known-good exceptions, with dead-entry + duplicate guards) and `ci/tenant-tables.ts` (the tenant-table inventory). |
| `ci/db-imports-audit.ts` | **(A+ campaign)** `ci:db-imports` — bans any non-composition-root file from importing `@/lib/db/server` (invariant #15). **STRICT** (PR 3, #456): no baseline — any non-root importer fails. Worker root status is **derived from `worker/index.ts` registration** via TypeScript-AST parsing (not file position); `import type` excluded (runtime-value-precise). The checked-in baseline snapshot was deleted when the importer set hit 0 (arc: 105 → 0). Unit-tested (11/11); runs in the blocking `lint` CI job. |
| `ci/lib/ratchet-harness.ts` | **(A+ campaign)** Shared file-walker + ratchet/baseline-diff engine used by the `ci:*` audit scripts (consolidated in 2i, #455) so each guard declares only its own predicate, not its own traversal. |
| `ci/process-env-audit.ts` | **(A+ campaign)** `ci:process-env` — ratchets raw `process.env` reads down toward the typed config layer (`src/lib/config/*`); baseline 10. Widened in PR 3 (#456). |
| `ci/normalize-v8-coverage.ts` | **(A+ campaign)** Normalizes the V8 coverage report so `ci:fallow --coverage` reads a stable shape (PR 3, #456). |

---

## `tests/llm-eval/` — Offline and optional live LLM safety gates

| File | What it does |
|------|--------------|
| `judge-eval-set.jsonl` | **(WS6)** Twelve deterministic judge fixtures: clean pass, compensation/PII/fabrication/hostility flags, mediocre-safe forbidden-flag cases, and adversarial near-misses. Each carries a schema-valid canned output for keyless scoring. |
| `judge-types.ts` | **(WS6)** Strict fixture, expectation, result, report, category, and live-generator types for the judge lane. |
| `judge-load.ts` | **(WS6)** JSONL loader and shape validator with duplicate-id rejection before scoring. |
| `judge-scorer.ts` | **(WS6)** Parses outputs through `JudgeOutputSchema` and scores required/forbidden verdict agreement without vacuous assertions. |
| `jsonl.ts` | Shared line-aware JSONL parser used by both offline eval lanes; rejects malformed JSON without duplicating fixture-domain validation. |
| `run.ts` | Main `pnpm eval:llm` runner. **WS6** always runs the offline judge lane and, under `--live`, reports live judge agreement alongside the existing suites. |
| `live-runner.ts` | Optional provider-backed runner. **WS6** invokes `runLlmTask('judge')` per fixture through the explicitly documented eval-only cost-guard exception; production callers remain guarded. |

### WS6 contract-test inventory

| Area | Test modules |
|------|--------------|
| Flags/startup | `worker/config/__tests__/startup-assertion.test.ts`, `src/lib/responses/__tests__/judge-flags.test.ts`, and the WS6 cases in `src/lib/auto-approval/__tests__/flags.test.ts` / `src/lib/config/__tests__/worker.test.ts`. |
| Judge domain | `src/lib/responses/__tests__/{judge-health,judge-policy,judge-schema,judge-store,judge-store.integration,judge}.test.ts` plus the judge block in `model-pinning.test.ts`. |
| Governor/suspension | `src/lib/auto-approval/__tests__/{account-lock-order,governor,suspension,suspension.integration}.test.ts` plus the governor cases in `flags.test.ts`. |
| Migration/shared contracts | `src/lib/shared/__tests__/migration-076-judge-verdicts-governor.integration.test.ts`; WS6 cases in `job-outbox-helpers.test.ts`, `outbox.test.ts`, and `past-due-recovery.test.ts`. |
| Judge worker/publisher | `worker/jobs/judge/__tests__/{JudgeWorker,failed-hook,lock-order-source}.test.ts`; `worker/jobs/publisher/__tests__/{judge-gate,auto-policy-downgrade,auto-policy-downgrade-lock-order}.test.ts`; WS6 cases in `ResponsePublisherWorker.test.ts`. |
| Governor loops | `worker/background/pollers/__tests__/JudgeSweepPoller.test.ts` and `worker/background/schedulers/__tests__/{AutonomyGovernorScheduler,AutonomyGovernorScheduler.integration}.test.ts`. |
| Suspension notices/admin alert | `worker/jobs/autonomy-suspended-notice/__tests__/{AutonomySuspendedNoticeWorker,context,dispatch}.test.ts`, `worker/jobs/__tests__/AutonomyAdminAlertWorker.test.ts`, `src/lib/notifications/email/templates/__tests__/autonomy-suspended-notice.test.ts`, WS6 cases in `src/lib/notifications/__tests__/delivery.test.ts` and `src/lib/notifications/channels/__tests__/{email-channel,factory,telegram-body,telegram-channel,whatsapp-body,whatsapp-channel}.test.ts`, plus `worker/ingress/__tests__/resend-webhook-bounce.test.ts`. |
| Admin recovery UI/API | `src/app/admin/autonomy/__tests__/AutonomySuspensionsClient.test.tsx`, `src/app/admin/autonomy/__tests__/page-source.test.ts`, and `src/app/api/admin/autonomy/__tests__/routes.test.ts`. |
| Eval lane | `tests/llm-eval/__tests__/judge-eval.test.ts` plus WS6 live-judge coverage in `live-runner.test.ts`. |

---

## `supabase/migrations/`

All schema migrations live here, numbered `001` … `076` (repository/local-test head; next is `077`). Supabase staging/production migrations are a user-run promotion step. Recent agent-platform migrations: `071` run spine, `072` triage, `073` Guardian escalations, `074` trust dial + veto window, **WS5** `075` agent-run subject lookup, and **WS6** `076_judge_verdicts_governor.sql` (`judge_verdicts` table with deny-all RLS and its account/time/RI indexes, the posted-auto-policy response query index, `notification_deliveries.entity_id` plus the autonomy-notice claim index, and three exact in-flight outbox indexes). Migration 076 is applied only to the local test database until the user-run staging→production promotion. For the full per-migration narrative, ordering rules, deployment status, and residual risks, read `.claude/reference/migrations-log.md`.

---

## Other top-level surfaces (not detailed here)

- `.claude/CLAUDE.md` — always-loaded project facts + the canonical architecture-invariants list + gotchas + a "where things live" index. Source of truth for architecture.
- `.claude/rules/` — always-loaded behavioral law: `repworth.md` (project rules) plus the generic `engineering.md` / `production.md` / `design.md`.
- `.claude/skills/` — patterns to follow, invoked on demand (cost-guard, approval-security, outbox-pattern, onboarding-demo-cost-guard).
- `.claude/reference/` — recall-when-needed inventories, read on demand (env-vars, migrations-log, lab-notes, review-ingestion).
- `docs/runbooks/` — operational + deployment runbooks (Zernio launch, smoke tests, ops, email deliverability, beta deployment plan; **Wave 1** added `secrets-rotation-*.md` + `security-scan-staging.md`; **channels** added `channels-rollout.md` (prod flip: Telegram-first/WhatsApp-follows) + `channels-staging-smoke-test.md` (end-to-end staging verification)).
- `docs/security/` — **(Wave 1)** RLS inventory, tenant-isolation model, vendor-risk + access registers, CSP rollout plan.
- `docs/finance/` — **(Wave 1)** pilot invoice-review template for the first multi-location accounts (`accounts.flags.is_pilot`).
- `docs/legal/` — legal source docs + external-gate status (`legal-review.md`, `insurance.md`); rendered pages come from `src/lib/legal/content.ts`, not these.
- `public/.well-known/security.txt` — **(Wave 1)** RFC 9116 disclosure pointer (contact `security@repworth.net`, links to `/security`).
- `docs/superpowers/` — historical specs + plans for every feature, dated. The plan file at the head of each branch is the spec of record for that feature.
- `tests/` and per-module `__tests__/` directories — Vitest unit + integration tests; the WS6 LLM-eval lane and contract-test inventory are detailed above, and Playwright E2E lives in `tests/e2e/`.
