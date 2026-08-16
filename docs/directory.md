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
| `page.tsx` | Landing page. Resolves three server-authoritative values and delegates everything else to `LandingExperience`: `SELF_SERVE_SIGNUP_ENABLED` (gates the nav's Log in / Sign up pair — **as of 2026-08-14 this is a posture choice, not a 404-correctness one**: `/signup` still `notFound()`s without the flag, but `/login` is now always-on, so hiding the pair is about not advertising anonymous signup to strangers, which is precisely what the re-scoped flag means; an invited owner reaches `/login` by its URL from the invite flow, not from this nav), the CTA target (`/signup`, else `/book-a-demo`), and the CTA label (the trial offer only when `TRIAL_ENABLED` **and** self-serve are both on — there is no signup to start a trial from otherwise). No `NEXT_PUBLIC_*` companion for any of them (invariant #13). It does **not** read an `x-coming-soon` header; the `comingSoon` prop still exists on `SiteShell`/`SiteNav` for the other public pages, but the landing page has never consumed it. |
| `_styles/` | **(PR 3b)** The Island's marketing **page** CSS, mirroring `(authenticated)/_styles/` for the Console: `island.css` (shared island chrome — `.rw-island`, `.rw-foot`, `.rw-dot-nav` — plus the `.rw-marquee-field` atmosphere and the original landing chrome), `features.css`, `how-it-works.css`, `pricing.css`. Extracted from `globals.css`, which keeps only the Island **tokens** + `@theme inline` and `@import`s these four at the bottom of the file, in that order. The order is the cascade and the `@import` (rather than a `layout.tsx` import) is what keeps Tailwind processing them — see the closing comment in `globals.css`; guard `src/__tests__/design-scope-purity.test.ts`. Style Reference: [`docs/design/island/DESIGN.md`](./design/island/DESIGN.md). |
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
| `u/[token]/page.tsx` | **(#644)** The recipient unsubscribe landing page. Three states from one URL: the **button page** (names the originating business, or "the business that contacted you" when provenance was purged), the **success page**, and the **Neutral page** — one identical render for unknown, malformed *and* already-redeemed tokens, so no caller can tell them apart (§5.4). Success requires a verifying Success receipt **and** a live global suppression read **during that render**: a receipt proves a row existed when it was minted, and the Correction path can remove it inside the 10-min TTL. Plain `<form method="post">`, no client component — it works with JS disabled. |
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

- `sections/landing/**` — the landing page, rewritten 2026-08 (replacing the #436 scroll-morph stage). `LandingExperience.tsx` is a composition root owning only the chrome — nav, the single `<main id="main-content">` landmark, the chapter rail, the footer — plus a numbered section map; each narrative section is its own module under `sections/landing/<section>/` with colocated CSS and a `*-copy.ts` carrying its shipped-vs-roadmap accuracy contract. Shared: `agent-flip-card.tsx` (sections 3–4), `reveal.tsx`, `ambient-motion.tsx` (the WCAG 2.2.2 pause control, plus the `AmbientVideo` that every looping background clip must use so none can escape it), `scroll/` (Lenis smooth scroll + eased snap with the CSS-snap fallback, chapter rail, vertical chapter markers, section transitions). **This page is deliberately unlocked from the Island system** — read its Style Reference [`docs/design/landing/DESIGN.md`](./design/landing/DESIGN.md) and its engineering companion [`docs/design/landing/measurements.md`](./design/landing/measurements.md) before changing anything in it; most of the values in that folder are measurements with a documented failure mode, not preferences.
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
| `dashboard/reviews/history/page.tsx` | **(#678)** The **Reviews list** (`All Reviews` tab) — account/location-scoped paginated list of **every** review for the location, unanswered first then answered, newest-first within each group. **Not flag-gated**: `PAST_REPLIES_VIEW_ENABLED` was retired at #678. Each row carries the server-derived Posted-reply axis (`reply_state`) + Action slot (`row_action`) + `ProvenanceBadge` from `src/lib/past-replies/replies-view.ts` (#727, ADR 0018 — replaced the six-valued `ReviewRowState`); the mutation affordances (`Regenerate`, recovery) remain gated by `EDIT_REPLIES_ENABLED` via `editRepliesEnabled()`. Both Copilot and Autopilot receive the former paid-tier history/edit feature set. |
| `dashboard/add-location/` | 4-step "add location" wizard (gated by `MULTI_LOCATION_ENABLED`). `AddLocationWizard.tsx` is a composing shell; `wizard/reducer.ts` is the pure state machine; `wizard/useAddLocationWizard.ts` owns the two fetch effects + submit/navigation; `wizard/steps/Step{1..4}*.tsx` are presentational; `wizard/billing.ts` + `wizard/payload.ts` hold the pure proration/payload helpers. |
| `dashboard/requests/page.tsx` | **(#544)** "Requests" — the owner-facing Solicitation surface. Server component so the `SOLICITATION_WATCH_ENABLED` gate stays server-authoritative (invariant #13): `notFound()` when off, then renders `RequestsClient`. |
| `dashboard/requests/RequestsClient.tsx` | **(#544)** Client island: fetches `GET /api/dashboard/solicitation/batch` for the selected location, polls every 2s while a batch is `building` (5-minute ceiling → `stalled`), POSTs `batch/reviewed` once a built report renders, and renders one screen per phase (loading / ready / stalled / error / `gone` on a mid-session 404). Phase is keyed by the location scope it was fetched for, so a superseded response never renders against the switched-to location. |
| `dashboard/requests/BatchReport.tsx` | **(#544)** Pure presentation of a built batch: funnel hero (contacts on file → evaluated → queued/held) over the Spoilage report — every withheld Ask grouped by withhold reason in the closed enum's precedence order, with a relative build time. ADR 0012: no star rating or sentiment signal, and no internal id, is ever rendered. |
| `dashboard/requests/GhostPipeline.tsx` | **(#544)** The pre-report screen — one ghost funnel plus the six restraint gates, at two opacities. One component, two modes (`no_batch` / `building`): same skeleton, different copy. |
| `dashboard/requests/requests.css` | **(#544)** Stylesheet shared by the three Requests components. |
| `dashboard/requests/contacts/page.tsx` | **(#541; moved from `dashboard/contacts/` in #544)** Solicitation watch-mode contacts surface. Server-authoritative `SOLICITATION_WATCH_ENABLED` gate — `notFound()` when off (mirrors the API routes); passes the server-owned consent attestation text/version to the client as props so the bundle never imports the solicitation modules. **Only the PAGE moved (`/dashboard/contacts` → `/dashboard/requests/contacts`); the API path `/api/dashboard/contacts/**` is unchanged.** |
| `dashboard/requests/contacts/ContactsClient.tsx` | **(#541; moved in #544)** Client component: CSV upload with required consent-attestation checkbox, upload report polling (`uploads/[id]`), paginated per-location contacts list + per-contact delete. |
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
The console migration (spec `docs/superpowers/specs/2026-07-30-admin-console-redesign-design.md`)
landed the same shape on every page: `page.tsx` is a **server component** —
`requireAdminPage(sql, {from, aal2?})` gate → read via the owning
`src/lib/admin/*` service → `<AdminPage>` chrome → client island seeded with
that read as react-query `initialData`. Phase 3 finished the set and moved
`<AdminPage>` out of the five Phase 2 clients onto their server pages, so page
chrome renders in the RSC payload rather than behind a loading state. `PAGE_SIZE`
is declared once, in the client, and imported by the server page.

| Path | What it does |
|------|--------------|
| `layout.tsx` | Wraps everything in `AdminProviders` + `AdminShellFrame` (sidebar shell). |
| `providers.tsx` | React context providers wrapping the admin layout. |
| `loading.tsx` | Segment streaming fallback: title skeleton + shared `TableSkeleton`, at `AdminPage`'s measure. Owns no viewport height or background — the shell does. |
| `error.tsx` | Segment error boundary: reports to Sentry, focuses its heading, offers Try again / Back to overview. Rendered as a card inside the shell's main column, palette-matched to the shared `ErrorState`. |
| `login/page.tsx` | Admin login (never gated by `SELF_SERVE_SIGNUP_ENABLED`). Renders outside the shell (`ADMIN_AUTH_ROUTES`). |
| `forgot-password/page.tsx` | Admin forgot-password. Outside the shell. |
| `reset-password/page.tsx` | Admin reset-password. Outside the shell. |
| `overview/page.tsx` | **(Phase 2/3)** Server component: gate, `getAdminOverview` + `getAdminNavCounts`, owns the `<AdminPage group="Operate">` chrome and its three action links. |
| `overview/OverviewClient.tsx` | Client island: the five system-health tiles, the needs-attention strip (shares `navCountsQueryOptions`' cache entry with the sidebar badge), and the **At-risk list** — heading `At risk (N of M)` where N is `atRisk.length` and M is `totalBusinesses`, a `View all →` link to `/admin/businesses`, name + `HealthBadge` rows linking to the detail page, and `EmptyState` when nothing is at risk. **(§5.3)** No `DataTable`, no pagination and no `PAGE_SIZE` any more — Overview stopped paginating and started ranking. |
| `jobs/page.tsx` | **(Phase 2/3)** Server component: gate, `getAdminJobsData` + `fetchQueueHealth`, `<AdminPage group="Operate" title="Jobs">`. |
| `jobs/JobsClient.tsx` | Client island: outbox summary tiles + failed-jobs table + per-queue depth/pool-wait; owns `PAGE_SIZE`. |
| `costs/page.tsx` | **(Phase 2/3)** Server component: gate, `getCostReport` + `getMarginReport`, `<AdminPage group="Operate" title="Costs">`. |
| `costs/CostsClient.tsx` | Client island: API cost report + margin mini-tables; owns `PAGE_SIZE`. |
| `notifications/page.tsx` | **(Phase 2/3)** Server component: gate, `getAdminNotifications`, `<AdminPage group="Operate" title="Notifications">`. |
| `notifications/NotificationsClient.tsx` | Client island: notification delivery log + businesses filter dropdown; owns `PAGE_SIZE`. |
| `runbook/page.tsx` | Internal runbook (links to `NEXT_PUBLIC_DOCS_BASE_URL`). Static server page on `<AdminPage group="Operate">`. |
| `businesses/page.tsx` | **(Phase 3)** Server component: gate, `getBusinessSummaries` (**§5.2**, page 1 at `BUSINESSES_PAGE_SIZE` — it replaced the deleted `getAdminBusinessesList`), `<AdminPage group="Businesses">` with the Import CSV / + Add Business actions. |
| `businesses/BusinessesClient.tsx` | **(Phase 3)** Client island: the businesses table (`DataTable`, server-paginated, `rowHref` → detail), shared `StatusBadge`, `Last Sync (UTC)`; page size from `BUSINESSES_PAGE_SIZE`. **(§5.4)** Now the single inventory owner — it absorbed Overview's Reconnect (≥3 / >0 / 0 badge ladder), Response rate, Avg time, Last activity and Health (`HealthBadge`) columns. The two window-labelled headers are built by a function, not a module constant, so their `N` comes from `responseMetricsWindowDays` rather than a literal `30`. |
| `businesses/[id]/page.tsx` | **(Phase 3)** Server component: gate, `Promise.all([getBusinessDetail, getBusinessChannelEnrollments])`, `notFound()` on a missing business, `<AdminPage>` titled with the business name. |
| `businesses/[id]/BusinessDetailClient.tsx` | **(Phase 3)** Client island: meta row (health badge, tier/subscription pills, Maps link), the panels below, and both audit logs as client-paginated `DataTable`s. |
| `businesses/[id]/types.ts` | TypeScript types for the business detail page. |
| `businesses/[id]/_hooks/useBusinessDetail.ts` | Detail + channels react-query pair, both seeded from the server page's `initialDetail`/`initialChannels`; exposes the channels query's load/error state separately, plus `invalidate()` and `clearBounceFlag()`. |
| `businesses/[id]/_components/ChannelsPanel.tsx` | Channel enrollments table + the Telegram/WhatsApp enrollment widgets. Distinguishes "no enrollments" from "channels fetch failed". Owns `CHANNEL_ENROLLMENT_BADGE_STYLES`/`ChannelEnrollmentBadge` — deliberately not the shared `StatusBadge` (none of its four keys exist there). |
| `businesses/[id]/_components/ZernioConnectionPanel.tsx` | Zernio connection status, disconnect, reconnect queue, finalize incidents. Owns `ZERNIO_CONNECTION_BADGE_STYLES`/`ZernioConnectionBadge` — `pending` means something different here than in the shared map. |
| `businesses/[id]/_components/ProfileEditor.tsx` | Inline editor for business profile fields. |
| `businesses/[id]/_components/ReviewsList.tsx` | Reviews + responses list for the admin detail view. Star glyphs stay `text-rw-teal` (locked by `no-yellow-star-colors.test.ts`). |
| `businesses/[id]/_components/ManualRankingSection.tsx` | Manual ranking snapshot input. |
| `businesses/[id]/_components/TrackedKeywordsSection.tsx` | Add/remove ranking keywords. |
| `businesses/[id]/_components/PastDueExtensionPanel.tsx` | Grants a bounded past-due grace extension against a ticket. |
| `businesses/[id]/_components/AutoApprovalDiagnosticsPanel.tsx` | **(WS4)** Auto-approval readiness: block reasons, threshold/source, recent verdicts. |
| `businesses/new/page.tsx` | **(Phase 3)** Server component: gate + `<AdminPage group="Businesses" title="Onboard new business">`; no read (it is a form). |
| `businesses/new/NewBusinessClient.tsx` | **(Phase 3)** Client island: the `react-hook-form` onboarding form at the `max-w-2xl` form measure. |
| `businesses/new/schema.ts` | Zod schema for the new-business form. |
| `businesses/new/_components/{BusinessInfoSection,OwnerInfoSection}.tsx` | The two surviving form sections: business name, and owner email + name. **(2026-08-14)** The admin invite form is exactly three fields — the Place capture, `VoiceContextSection` (tone + product context), `SubscriptionTierSection` (tier picker) and `_hooks/useBusinessPrefill.ts` were **deleted**, because the owner now supplies their own location at `/onboarding/start`, their own voice in the wizard, and their own tier at `/onboarding/pay`. |
| `businesses/new/_components/_shared.tsx` | Shared field primitives for the new-business form. |
| `locations/csv-import/page.tsx` | **(Phase 3)** Server component: gate + `<AdminPage group="Businesses" title="Locations import">` (title matches the sidebar label). |
| `locations/csv-import/CsvImportClient.tsx` | **(Phase 3)** Client island: upload → validate → preview → import, at the `max-w-3xl` upload/report measure. The preview/result tables stay plain `<table>`s — a transient validation preview, not a data page. |
| `locations/csv-import/csv-validation.ts` | Client-side CSV parse + per-row validation feeding the preview. |
| `offboardings/page.tsx` | **(Phase 3)** Server component: gate with **`aal2: true`** (parity with `GET /api/admin/offboardings`' `requireAdminWithAal2`), `getAdminOffboardings`, `<AdminPage group="Businesses">`. |
| `offboardings/OffboardingsClient.tsx` | **(Phase 3)** Client island: offboarding lifecycle cards, provider-disposition mutation, shared `PaginationFooter`; owns `PAGE_SIZE` and the tone-keyed `ToneBadge` (renamed from a local `StatusBadge` that shadowed the shared primitive). |
| `flagged/page.tsx` | **(Phase 2/3)** Server component: gate, `listOpenFlaggedResponses`, `<AdminPage group="Safety" title="Flagged responses">`. |
| `flagged/FlaggedClient.tsx` | Client island: open flagged-response queue with per-item disposition actions (approve/dismiss/regenerate), shared `PaginationFooter`; owns `PAGE_SIZE`. |
| `api/admin/suppressions/_guard.ts` | **(#645)** `parseJsonBody(request, schema, schemaError?)` — the JSON-body read + `safeParse` the three admin suppressions routes share, returning a discriminated `ParsedBody`. `schemaError` defaults to zod's first issue; `lookup` passes `opaqueBodyError` so a rejection never describes a body whose only field IS the recipient address (§9.5). Deliberately does **NOT** wrap the AAL2 gate: `ci:admin-aal2` is a file-level text scan, so hiding `requireAdminWithAal2` behind a wrapper made three gated routes read as ungated — "is this admin mutation MFA-gated?" must stay answerable by grepping the route. |
| `suppressions/page.tsx` | **(#645)** Server shell for the spec §7.2 daily mailbox-servicing surface (**Safety** nav group). `requireAdminPage(sql, { aal2: true })` — same sensitivity as `/admin/flagged` — and **fetches nothing**: there is deliberately no "all suppressions" list, because the servicing ritual always starts from an address in a forwarded mailbox reply and a browsable dump of every opted-out recipient is a cross-tenant liability with no use. |
| `suppressions/SuppressionsClient.tsx` | **(#645)** Client island, three regions in the order the ritual uses them: look one address up (`POST /api/admin/suppressions/lookup` — §9.5 keeps the handle out of URLs), record a manual opt-out for it (§7.3 POST, required note), and — only for a record that is factually wrong — the audited **Correction path** (§8.2 POST to `suppressions/correct`). The copy is load-bearing, not decoration: the affordance reads "Correct this record", the confirm step says error-correction-never-re-subscribe in full, and no branch renders a raw API token — a genuine failure says the suppression is still in place, while an already-corrected row (404) says so truthfully and re-runs the lookup, because telling an admin a recipient is still protected when the row is gone is the inverse hazard. |
| `autonomy/page.tsx` | **(WS6)** Server shell for the suspended-autonomy queue; loads `AutonomySuspensionsClient`. |
| `autonomy/AutonomySuspensionsClient.tsx` | **(WS6)** Lists account suspensions with governor rates and recent flag verdicts, collects a required operator note, and POSTs the manual unsuspend action. |
| `security/page.tsx` | Server shell for the admin's own MFA enrollment. |
| `security/AdminSecurityClient.tsx` | **(Phase 2)** Client island: enroll/verify/unenroll an authenticator factor for step-up (AAL2) access to the rest of the admin control plane. |
| `demos/page.tsx` | **(Phase 3)** Server component: gate, `getAdminDemos`, `<AdminPage group="Growth" title="Demos">`. |
| `demos/DemosClient.tsx` | **(Phase 3)** Client island: generate form (measured `max-w-2xl`) + full-width demo list, polling at 5s only while a demo is `queued`/`running`. Owns `DEMO_STATUS_STYLES` (generation status has an `animate-pulse` running state the shared badge cannot express). |
| `impersonate/page.tsx` | **(Wave 2 / Phase 3)** Server component: gate + `<AdminPage group="Growth" title="Impersonation">`. |
| `impersonate/ImpersonationStartClient.tsx` | Client form that posts account/user/ticket/reason to `/api/admin/impersonation/start` and follows the returned view URL. |
| `impersonate/[sessionId]/view/page.tsx` | **(Wave 2 / Phase 3)** Admin-owned read-only impersonation shell on `<AdminPage>`. Keeps its bespoke gate — `resolveImpersonationViewSession` has four distinct redirect/notFound outcomes that `requireAdminPage` cannot express. Does not mount owner routes. |
| `impersonate/[sessionId]/view/ImpersonationLocationsTable.tsx` | **(Phase 3)** The account's locations as a `DataTable` (Name / Location ID / State); no `rowHref` — nothing is navigable inside a read-only session. |
| `impersonate/[sessionId]/view/EndImpersonationButton.tsx` | **(Wave 2)** Ends the current impersonation session via `/api/admin/impersonation/end`. |

---

### `onboarding/`

| Path | What it does |
|------|--------------|
| `error.tsx` | Error boundary for the onboarding flow. |
| `pay/page.tsx` | Stripe checkout step during owner onboarding. |
| `pay/PlanPickerClient.tsx` | Explicit Copilot/Autopilot picker with no default selection; posts the selected tier to the server, then follows the returned Stripe Checkout Session URL. Autopilot availability and founding/list prices come from the server view model. |
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

#### `_shared/channels/`

Shared by BOTH portals' channel routes — placed at the common ancestor of
`api/admin/channels/*` and `api/dashboard/channels/*` per the `_shared`
convention. All 12 enrollment routes are binding shims over these.

| File | Purpose |
|------|---------|
| `resolve-actor.ts` | The **Channel actor** seam: `resolveAdminActor` (body `businessId` + admin MFA gate, optional full-access check) and `resolveOwnerActor` (session `locationId` + `resolveWritableAccountForLocation`). The only axis that varies between the portals. |
| `start.ts` | `runChannelStart` + the shared 4-field `ChannelRouteConfig`. Token mint → advisory-locked enrollment upsert → cache invalidate → QR/deep-link response. |
| `action.ts` | `runChannelCancel`, `runChannelDisable`. |
| `flag-off.ts` | `flagOff()` — the single "channel disabled" 404. Called by the runners directly, never a config field. |

#### `u/` — unauthenticated recipient opt-out

| Route | What it does |
|-------|--------------|
| `u/[token]/route.ts` | **(#644)** POST target of the `/u/<token>` unsubscribe form. Redeems the token (`source='unsubscribe_link'`), then `303`s back to the landing page with a **relative** Location carrying `?ok=<receipt>` and `cache-control: no-store`. Mints the Success receipt **only** for `redeemed` / `already_suppressed` — never for `already_redeemed_not_suppressed`, whose whole purpose is to refuse a success claim the ledger cannot support. No auth and no session by design: the token IS the authorisation, and requiring a login to opt out would itself be the compliance defect. |

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
| `import-offer/route.ts` | **(#677)** GET + POST for the **Import offer**. **GET** resolves owner scope, calls `createImportOffer` idempotently as a self-heal (its own `sql.begin` holding the `businesses` row lock — this is what makes best-effort offer creation on the Stripe path safe; drop one and you must drop the other), then returns `readImportOfferView`. No CSRF wrapper — GETs are exempt, per `past-replies/draft-status`. **POST** is `withSameOrigin`, validates `{ decision: 'accepted' \| 'declined' }` with zod, and makes ONE call to `recordImportDecisionAndEnqueue`, mapping its four outcomes: `recorded` → 200, `expired` / `already_answered` → 409 (so the banner can tell "too late" from "recorded" without reading a body field), `no_offer` → 404. The location comes from scope, never the body. |
| `reviews/[reviewId]/approve/route.ts` | Approve from dashboard. |
| `reviews/[reviewId]/edit/route.ts` | Edit from dashboard. |
| `reviews/[reviewId]/regenerate/route.ts` | Regenerate from dashboard. |
| `reviews/[reviewId]/timeline/route.ts` | **(WS5)** GET: owner/account-scoped read of one review's run timeline. Returns 404 for unknown or out-of-scope reviews and delegates all spine reads to `src/lib/agents/read.ts`. |
| `reviews/[reviewId]/generate/route.ts` | **(#678, extracted #729)** POST: the **On-demand generation** `Generate` door for a never-replied review on the **Reviews list**. Composition root only (invariants #12/#15): `withSameOrigin`; per-owner-account rate limit *before* any DB work, ownership proof, account writable pre-check, per-review regen-budget peek, then `sql.begin(onDemandGenerateTx)` and result→HTTP mapping. The transaction itself — review lock, in-tx TOCTOU writable re-check, sibling/orphan/in-flight exclusions, `MAX(version)+1`, atomic enqueue on the `on_demand_generate` **Origin lane** (structurally excluded from auto-approval, so the draft is always owner-only, invariant #3) — lives in `src/lib/reviews/on-demand-generate.ts`, every sibling read natively business-scoped. Error strings are closed and unchanged: `review_not_found`, `already_answered`, `draft_already_exists`, `orphan_recovery_pending`, `regenerate_in_progress`, `rate_limited`, `regen_limit_reached`. |
| `reviews/[reviewId]/draft-status/route.ts` | **(#678)** GET: `reviewId`-keyed poller the inline Generate panel drives while a draft is in flight. Same-account sibling-location access is intentional; cross-account is a 404. A **moderation-held** response (open `flagged_responses` row) returns `{ status: 'idle' }` and never `response_text` — invariant #4 means the owner's only path is admin re-notification. |
| `agent-team/route.ts` | **(WS5)** GET: windowed Reply/Guardian/Insights outcome counts for the current account or selected location. Foreign or archived location scopes return 404. |
| `escalations/route.ts` | **(WS5)** GET: bounded Needs-attention queue of the account's open Guardian escalations, with a separate `totalOpen` count. Delegates to `src/lib/escalations/list.ts`. |
| `escalations/[escalationId]/acknowledge/route.ts` | **(WS3)** POST: owner acknowledges an open Guardian escalation. Same-origin + owner auth + writable-subscription guard; delegates to `src/lib/escalations/transitions.ts` (404 not-found in scope, 409 already-resolved). |
| `escalations/[escalationId]/resolve/route.ts` | **(WS3)** POST: owner resolves an escalation (direct escalated → resolved stamps both timestamps). Same guards; records `escalation_resolved` on a completed run. |
_(The `past-replies/*` route set — `draft`, `draft/[responseId]`, `draft-status`, `publish`, `[responseId]/retry`, `[responseId]/restore-original` — is the `Regenerate` lane on the **Reviews list** (it replaces a LIVE Google reply, so it stays separate from the `reviews/[reviewId]/generate` door above). All of them gate on `editRepliesEnabled()` and return 503 `feature_disabled` when `EDIT_REPLIES_ENABLED` is off; the retired `PAST_REPLIES_VIEW_ENABLED` half of the old two-flag check is gone as of #678. Shared request parsing/guards live in `past-replies/_shared/edit-reply-request.ts`.)_
| `channels/route.ts` | GET: returns owner-scoped enrollment status for all channels (`{ enrollments, available, reasons }`). Auth: `businessId` from session only. |
| `channels/telegram/start/route.ts` | POST: starts a Telegram enrollment for the owner (generates QR token). |
| `channels/telegram/cancel/route.ts` | POST: cancels a pending Telegram enrollment. |
| `channels/telegram/disable/route.ts` | POST: disables an active Telegram enrollment. |
| `contacts/route.ts` | **(#541)** GET: paginated per-location contacts list; untrusted `limit`/`offset` clamped by `clampContactListPage` before any SQL. All four `contacts/**` routes 404 **before auth** when `SOLICITATION_WATCH_ENABLED` is off, and reject the aggregate ("all locations") scope with 400. |
| `contacts/[id]/route.ts` | **(#541)** DELETE: removes one contact (same-origin + `requireWritableOwner`); uniform 404 for malformed/unknown/out-of-scope ids; delegates to `deleteContact` in `src/lib/solicitation/contacts-repo.ts`. |
| `contacts/[id]/suppression/route.ts` | **(#645)** POST §7.5 owner do-not-contact (`scope='account'` / `owner_manual`, keyed on the **Normalized handle**, never the contact row id) + DELETE §7.6 clearing of a row **this account** created. An owner may never clear a `global` row: the repo predicate cannot reach one, so there is no input to this route that expresses the forbidden operation. Same posture as the sibling contact DELETE — flag gate + `requireWritableOwner` + same-origin, all inside `requireContactsWriteAccess`; uniform 404 out of scope; delegates to `markContactDoNotContact` / `clearContactDoNotContact`. |
| `contacts/uploads/route.ts` | **(#541)** POST: multipart contacts/visits CSV upload with required consent attestation (same-origin + `requireWritableOwner`); delegates to `createContactsCsvUpload` (one tx: upload row + `csv_ingest` outbox enqueue). |
| `contacts/uploads/[id]/route.ts` | **(#541)** GET: upload status/report read for the dashboard polling loop; delegates to `getUploadStatus` in `src/lib/solicitation/uploads.ts`. |
| `solicitation/batch/route.ts` | **(#544)** GET: the latest Solicitation batch for one location, as the Requests screen renders it. Pure read — flag gate (404 before auth), `withDashboardOwnerRead`, `requireContactsLocationScope`, then `readLatestBatch` in `src/lib/solicitation/batch-view.ts`. Logs one `batch_view_read` line per non-`building` response (the client polls `building` every 2s). |
| `solicitation/batch/reviewed/route.ts` | **(#544)** POST: records that an owner opened the Spoilage report (`reviewed_at`, first-write-wins → 204 either way). Separate from the GET on purpose — a poll must not mean "a human looked". Same-origin + `requireContactsWriteAccess` (flag gate ahead of `requireWritableOwner`); `?scope=` is required, since the body carries only `batchId`. |
| `solicitation/scope-param.ts` | **(#544)** How the Solicitation client islands SEND the `scope` location query param (`SOLICITATION_SCOPE_PARAM` + `withSolicitationScope`) — a mirror of the name `resolveDashboardRequest` (`policy.ts`) reads, not its owner; the two must stay in lockstep. Server-import-free so client islands can build URLs without pulling the DB client into the bundle; a misspelled param would otherwise silently fall back to the owner's default location. |

#### `settings/route.ts`

GET + POST owner settings (tone, products/services, avoid-facts).

#### `settings/postal-address/route.ts`

**(#656)** PUT: records the **Attested postal address** for the owner's cookie-resolved active location. Auth is `resolveOwnerScope` (NOT `requireSettingsOwner`, which resolves no location and deliberately skips the writable-subscription gate) plus `withSameOrigin()`, and an explicit `getOffboardingState`/`isOperationalUIBlocked` refusal placed **before the body parse** — the subscription gate does not imply it, since `delete_data`/`pending` is operationally blocked while the subscription is still `active`. `z.strictObject` is load-bearing: a body-supplied `businessId` or `userId` is a 400, never a silently ignored tenant-selection knob, and `attestationVersion` is pinned to the constant so a client can never assent to one text while the server records another. Delegates to `attestPostalAddress` and maps its four statuses to 200/400/403/404; the lint lives in the module, never here.

#### `onboarding/`

| Route | What it does |
|-------|--------------|
| `business/route.ts` | POST: persists step-by-step business profile data from the 3-step wizard (`/onboarding/business`). Validates step input via `signup-schemas.ts` and updates the existing `businesses` row created at signup. |
| `select-plan/route.ts` | POST: validates the owner's explicit Copilot/Autopilot selection, persists the complete tier/variant snapshot under billing serialization, and returns a Stripe Checkout Session URL. No tier default or Payment Link remains. |

#### `signup/place-prefill/route.ts`

GET: hits SerpAPI for a Place ID during the onboarding location step to prefill business name, address, and category. **(2026-08-14)** No longer gated by `SELF_SERVE_SIGNUP_ENABLED` — the flag now means only "strangers may mint accounts", and this endpoint is reached by admin-invited owners with the flag off. Because removing the gate from an otherwise-**unauthenticated**, SerpAPI-billed endpoint would have made it permanently public, it gained a real boundary in the same change: authenticated session + `role = 'owner'` + a pre-activation account state, plus a new per-auth-id 10/min strict limit alongside the existing strict per-IP one (75/day global unchanged).

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
| `overview/route.ts` | Admin overview stats; delegates to `getAdminOverview`. |
| `businesses/route.ts` | GET list (auth → parse/clamp `limit`/`offset` → `getBusinessSummaries` (**§5.2**, replacing the deleted `getAdminBusinessesList`) → JSON, echoing `limit`/`offset` on top of the service payload) + POST create (calls `AdminOnboardingService`). |
| `businesses/[id]/route.ts` | GET / PATCH / DELETE a business; delegates to `business-detail-service`. |
| `businesses/[id]/resend-invite/route.ts` | **(2026-08-14)** POST: re-sends the Supabase invite email for an admin-created owner who has never signed in. Admin + AAL2 + same-origin, mirroring the create route's guards; delegates to `src/lib/onboarding/resend-invite.ts`. Eligibility is asked of the **provider** (`auth.admin.getUserById` → `last_sign_in_at IS NULL`), never of the local `auth_id`, which is populated at creation time and so cannot distinguish "invited" from "accepted". Capped at **3 per hour per business** — the one admin action that puts mail into a third party's inbox on a button press, so an accidental click-loop can't burn sender reputation; auth runs before the limit so an unauthenticated call spends no budget. |
| `businesses/[id]/channels/route.ts` | GET (delegates to `getBusinessChannelEnrollments`) + POST channel enrollments. |
| `businesses/[id]/keywords/route.ts` | GET + POST ranking keywords. |
| `businesses/[id]/ranking/route.ts` | GET ranking snapshot. |
| `businesses/[id]/zernio-queue/route.ts` | Reconnect-queue admin actions (force drain / dismiss) for a location's `awaiting_owner_connect` responses. |
| `costs/route.ts` | GET cost summary; delegates to `getCostReport` + `getMarginReport`. |
| `demos/route.ts` | GET demo list (delegates to `getAdminDemos`) + POST demo request. |
| `demos/generate/route.ts` | POST: queues a demo generation job via outbox. |
| `flagged/route.ts` | GET the open flagged-response queue (delegates to `listOpenFlaggedResponses`) + POST the disposition transaction (which stays in the route). |
| `offboardings/route.ts` | GET the offboarding lifecycle list behind `requireAdminWithAal2`; delegates to `getAdminOffboardings`. Its page gate matches (`requireAdminPage(sql, {aal2: true})`). |
| `offboardings/[offboardingId]/route.ts` | POST a provider disposition against one offboarding. |
| `jobs/route.ts` | GET queue health; delegates to `getAdminJobsData` + `fetchQueueHealth`. |
| `nav-counts/route.ts` | Thin admin-gated GET for sidebar badge counts (flagged open, failed jobs); delegates to `getAdminNavCounts`. Polled every 60s by `AdminSidebar`. |
| `notifications/route.ts` | GET delivery logs. |
| `autonomy/suspensions/route.ts` | **(WS6)** Admin-only GET for the cross-account suspended-policy read model (current rates + five newest flag verdicts); delegates to `listSuspendedPolicies`. |
| `autonomy/unsuspend/route.ts` | **(WS6)** Admin-only POST that validates `{ accountId, note }`, takes the account-level autonomy lock inside one transaction, and maps already-manual state to 409. |
| `suppressions/lookup/route.ts` | **(#645)** AAL2-gated **POST** returning every Suppression ledger row for one **Normalized handle** plus its prior Correction path records (cross-tenant by design, allowlisted in `ci:tenant-scope`). A POST rather than a GET **because of spec §9.5**: a query string puts the raw recipient address into access logs, log drains and browser history, and every other path here keeps the handle out of logs. The service's result union is mapped to an explicit response body at the route boundary, so a future failure variant cannot silently become the wire contract. |
| `suppressions/route.ts` | **(#645)** AAL2-gated POST §7.3 admin manual entry (`global` / `admin_manual`, required note, `normalizeEmail` **rejects** rather than minting a wrong handle; a repeat entry is a no-op success against the partial unique index). Deliberately **not** flag-gated: a statutory 10-business-day obligation behind a feature flag is a violation waiting for a flag flip. |
| `suppressions/correct/route.ts` | **(#645)** AAL2-gated POST: the **Correction path** (§8.2) — error correction, NEVER re-subscribe. `z.strictObject({ suppressionId, reason })`, so a client-supplied actor field is a 400 rather than a silently ignored key; the actor id comes from the gate. Delegates to `correctSuppression` with no `sql.begin` (the service is one statement), and maps an already-gone row to 404 instead of writing an orphan record. A separate route from the entry surface so the two acts never share a handler, a schema, or a copy string. |
| `billing/grant-extension/route.ts` | **(Wave 2)** Admin + current-AAL2 action that grants a short past_due extension in `accounts.flags` and writes `account_audit_log`. |
| `impersonation/start/route.ts` | **(Wave 2)** Starts an audited one-hour admin impersonation session. Same-origin, admin, current AAL2, validates owner/account, sets a signed httpOnly cookie. |
| `impersonation/end/route.ts` | **(Wave 2)** Ends the current signed impersonation session and clears the cookie. |
| `locations/csv-import/route.ts` | Admin CSV bulk-location import. Returns partial-success row failures and writes aggregate audit + billing outbox. |
| `channels/telegram/start/route.ts` | POST: start Telegram enrollment (generates QR token). |
| `channels/telegram/cancel/route.ts` | POST: cancel pending enrollment. |
| `channels/telegram/disable/route.ts` | POST: disable active enrollment. |
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
| `PlaceAutocomplete.tsx` | Google Places autocomplete input (uses `PlaceAutocompleteElement`; guarded for SSR with `typeof window !== 'undefined'`). |
| `admin/AdminSidebar.tsx` | Grouped dark sidebar shell for the admin console — desktop `<aside>` + mobile fixed top bar/drawer, nav groups from `nav-config.ts`, live badge counts via `/api/admin/nav-counts`. Returns `null` on `/admin/login`, `/admin/forgot-password`, `/admin/reset-password`. |
| `admin/nav-config.ts` | Admin nav IA as data — `ADMIN_NAV_GROUPS` (grouped nav items + optional badge key) and `ADMIN_AUTH_ROUTES` (routes where the sidebar hides). |
| `admin/nav-counts-query.ts` | **(Phase 2)** Single owner of the admin nav-badge counts fetch (`GET /api/admin/nav-counts`) + its react-query wiring (`navCountsQueryOptions`) — `AdminSidebar` and `OverviewClient`'s needs-attention strip read the same cache entry (same query key, fetcher, poll cadence) so the two can't disagree on screen at once. |
| `admin/AdminEnrollmentWidget.tsx` | The shared mobile-channel enrollment state machine (`useEnrollment`) plus an `AdminEnrollmentPresentation` seam; `TelegramEnrollmentWidget`/`WhatsAppEnrollmentWidget` are thin wrappers that differ only in label, colors, copy, and handle masking. |
| `admin/TelegramEnrollmentWidget.tsx` | 8-state machine UI for Telegram enrollment. Shows QR code (server-rendered data URL). 3s polling + 1h TTL countdown. |
| `admin/WhatsAppEnrollmentWidget.tsx` | 8-state machine UI for WhatsApp enrollment. Masked phone `+15•••4567`. Same polling pattern as Telegram. |
| `admin/AdminShellFrame.tsx` | Owns the auth-route decision for the whole shell: bare children on login/forgot/reset (no sidebar mount, no nav-counts polling), otherwise the `flex min-h-screen bg-gray-50` sidebar + main frame. The **only** owner of the admin viewport height and page background. |
| `admin/ui/AdminPage.tsx` | Page chrome primitive — breadcrumb group label, title/description, optional actions row, and the `max-w-7xl` page measure. Carries the **content-measure rule** (form `max-w-2xl` · upload/report `max-w-3xl` · data pages full width · mixed form+list measures the form only). |
| `admin/ui/DataTable.tsx` | Generic sortable table primitive with two paging modes, plus the exported `PaginationFooter` + `serverPaginationFooterState` that card-list pages (`FlaggedClient`, `OffboardingsClient`) share so the "Showing a–b of N" string and its dead-end guards cannot drift. Optional per-row "View →" link column. In server mode it pushes its display clamp back to the caller, so a caller stranded past a shrunk `totalRows` converges instead of refetching an empty page. |
| `admin/ui/format.ts` | The console's single date/number formatter — `formatAdminDateTime` (self-labels " UTC"), `formatAdminDate` (bare; caller labels the zone), `formatAdminCount`. All pinned to locale `en-US` + `timeZone: 'UTC'`, because admin pages now render on Vercel (UTC) *and* in the browser (the admin's zone and locale) and a runtime-derived `toLocale*` mismatches on every hydration. `__tests__/format.test.ts` bans `toLocale*` and un-zoned `Intl.DateTimeFormat` across `src/app/admin/**` + `src/components/admin/**`. |
| `admin/ui/FilterBar.tsx` | Search input + removable filter chips row for admin list pages. |
| `admin/ui/states.tsx` | `EmptyState`/`ErrorState`/`TableSkeleton` primitives for admin list/detail pages. |
| `admin/ui/StatTile.tsx` | Single stat tile (label/value/sub) with an alert (red-border) variant for breached thresholds. |
| `admin/ui/StatusBadge.tsx` | One authoritative status → badge-color mapping (`STATUS_BADGE_STYLES`) for the admin console — subscription statuses + outbox terminal statuses. |
| `admin/ui/HealthBadge.tsx` | **(§5.4)** The single owner of churn-**level** → style/label presentation (`HEALTH_BADGE_STYLES` / `HEALTH_BADGE_LABELS`) — a peer of `StatusBadge`, keyed off `ChurnScore['level']` so adding a level in `src/lib/shared/churn-score.ts` is a type error here rather than a silent grey pill. Extracted from `OverviewClient` when `/admin/businesses` absorbed the Health column: Overview's **At-risk list** and the Businesses inventory render the same level from the same churn score, and §5.1 names those two disagreeing as a real failure mode, so the presentation has one owner instead of two copies. |
| `auth/LoginFormClient.tsx` | Login form (email + password → Supabase sign-in). |
| `auth/ForgotPasswordFormClient.tsx` | Forgot-password form. |
| `auth/ResetPasswordFormClient.tsx` | Reset-password form. |
| `auth/useRecoveryStepUp.ts` | Headless MFA step-up for password recovery: probes the recovery session + verified factors, then challenges/verifies via `/api/auth/mfa/challenge` so the session is AAL2 before the password write. Consumed by both reset cards. |
| `auth/RecoveryStepUpField.tsx` | Presentational TOTP code field (plus factor picker when >1) shown inline on the reset cards. Styling arrives via className props. |
| `dashboard/AccountStateScreens.tsx` | Full-page states for non-active accounts (pending payment, cancelled, past-due). |
| `dashboard/Charts.tsx` | Recharts-based charts for the owner dashboard (response rate, star distribution, etc.). |
| `dashboard/charts/` | Shared chart primitives: measured-viewBox contract (`useMeasuredSvg`), d3-backed `VelocityChart`, hover/tooltip/motion presets, chart tokens. |
| `dashboard/ConnectGoogleBanner.tsx` | Banner surfacing the owner's Zernio GBP connection state. States: active (hidden), none (blue CTA), disconnected (orange CTA), finalize_unknown (yellow ops-alert). |
| `dashboard/account-state/ImportOfferBanner.tsx` | **(#677)** The **Import offer** prompt, a new adapter at the existing banner seam beside `ConnectGoogleBanner` (same `banner` / `b-title` / `banner-cta` anatomy; self-nulls on `{ state: 'none' }`). Sources state from `GET /api/dashboard/import-offer`, **not** the Redis-cached dashboard payload, so a declined offer stops rendering immediately. Carries `offer → importing → outcome → gone`, polls only while `importing`, advances only on a successful POST (never optimistically), and shows no retry on `failed` — retry is the worker's via the `completed_at IS NULL` sentinel. Query key includes the scoped `locationId` so one location's offer can never render against another. Copy is locked verbatim, incl. the 7-day disclosure and the reassurance line. |
| `dashboard/ComingSoonChannelRow.tsx` | Placeholder row for channels not yet available to owners (WhatsApp only). |
| `dashboard/reviews/PastReplyCard.tsx` | Card for one row of the **Reviews list**. Renders the server-derived `reply_state` + Action slot `row_action` (#727, via the shared `ReplyPanel`) — it never computes an affordance — so every "never offer Generate on X" rule lives in `replies-view.ts`; a moderation-held replacement arrives as `row_action 'none'`, never as a held value. Shows the review on the left, the reply (when any) on the right, and a `ProvenanceBadge`. Mutation affordances (`Regenerate` → `EditReplyDrawer`, recovery) appear only when `editRepliesEnabled` is passed true. A missing regen-budget map entry means **unknown**, not zero: `Regenerate` stays enabled and the counter hides (fail-open, per the cost-guard matrix). |
| `dashboard/reviews/InlineGeneratePanel.tsx` | **(#678)** The `Generate` door's inline expansion on a never-replied row — the low-risk counterpart to `EditReplyDrawer` (which replaces a LIVE Google reply and therefore stays a two-pane drawer). Presentational; all fetch/poll/state lives in `useInlineGenerate.ts`. |
| `dashboard/reviews/useInlineGenerate.ts` | **(#678)** Hook owning the inline Generate lifecycle: POST `reviews/[reviewId]/generate`, then poll `reviews/[reviewId]/draft-status` until `ready` or terminal, mapping the route's closed error strings to owner-facing copy. |
| `dashboard/reviews/client-helpers.ts` | **(#765)** Browser-safe JSON parsing plus the shared 1500ms cadence / 60-second Reply polling budget. The two poll state machines remain separate. |
| `dashboard/AgentTeamStrip.tsx` | **(WS5)** Three-card Reply/Guardian/Insights summary strip. Follows the dashboard's account/location scope and time window; zero-count agents remain visible as "Standing by". |
| `dashboard/NeedsAttentionList.tsx` | **(WS5)** Owner exception queue backed by `/api/dashboard/escalations`; hidden when empty, otherwise links each open escalation to its review timeline. |
| `dashboard/timeline/` | **(WS5)** Timeline presentation package: `TimelineContent`, `RunTimeline`, `TimelineStepRow`, `RunStateBadge`, and `TimelineEscalationActions`. Renders stored persona attribution and structured facts; acknowledge/resolve actions reuse the existing Guardian transition routes. |
| `dashboard/OwnerTelegramWidget.tsx` | Owner-facing Telegram enrollment widget. Uses `useEnrollment` + `enrollmentReducer`; SSR-hydrated from server-loaded enrollment row. |
| `dashboard/ReviewActions.tsx` | Approve / Edit / Regenerate action buttons for a single review. |
| `dashboard/ReviewsList.tsx` | List of reviews with inline response drafts and action buttons. |
| `dashboard/settings/SettingsSidebar.tsx` | Grouped settings nav — vertical sidebar (desktop) / native `<select>` with `<optgroup>` (mobile ≤768px); active item from `usePathname()`. Rendered once by `settings/layout.tsx`. |
| `dashboard/settings/SolicitationAddressPanel.tsx` | **(#656)** The owner-facing **Attested postal address** surface on `/settings/profile` — a **sibling** of `ProfilePanel`, never an edit to it (deviations D3), rendered FIRST so the delete-data danger zone that `ProfilePanel` itself contains stays terminal. Its state arrives as a prop the server component already fetched for the cookie-resolved active location, so nothing widens the shared `/api/settings` payload or `useSettingsForm` for one panel's data. Three load-bearing behaviours: `google_place_address` is an editable **suggestion** that never submits itself; submitting requires the attestation checkbox, whose label is `POSTAL_ADDRESS_ATTESTATION_TEXT` imported from the domain module (a hand-copied string would let the stored compliance record drift from what the owner agreed to); and editing **clears** the checkbox, the UI half of migration 099's digest CHECK. Writes go to `PUT /api/settings/postal-address`; lint reasons render as returned, never re-derived. |
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
| `admission.ts` | **The #773 admission chokepoint.** `withAdmissionControl(client, {cap, clientName})` wraps a postgres.js client so in-flight work never exceeds its pool: a top-level query takes one slot, a `sql.begin()` takes ONE slot for the whole transaction (its `tx` queries are ungated by construction), and excess callers QUEUE with a 30s deadline (`DbSlotTimeoutError`) instead of being pipelined onto a busy connection. Applied to `sql` and `sqlRead` in `server.ts` — at the CLIENT, because `src/app/**` alone has 153 files importing `sql`. Kill switch `DB_ADMISSION_ENABLED=false`. |
| `browser.ts` | `supabaseClient` — Supabase JS client for browser-side code (anon key, SSR-safe cookie management). |
| `supabase-server.ts` | `createSupabaseServerClient()` — SSR Supabase client (anon key, reads request cookies). Used in API routes and middleware. |
| `auth.ts` | `requireRole(req, role)` — throws `AuthError` if the session lacks the required role. |
| `redis-cache.ts` | `getCacheRedis()` — Redis client for application caching (separate Redis instance from BullMQ); `withTtlCache()` owns fail-open JSON read/compute/`EX` write mechanics while callers provide their log source and TTL policy. |
| `client.ts` | **Tombstone.** Previously re-exported server + browser clients. Now a comment directing imports to the correct modules. |
| `index.ts` | **Tombstone.** Same as `client.ts` — do not barrel-import server and browser together. |

### `dashboard/`

Dashboard query layer.

| File | What it does |
|------|--------------|
| `service.ts` | `getActiveDashboardData(sql, businessId, opts?)` — queries reviews, responses, weekly metrics, and Zernio connection state. Returns `DashboardDataActive`. Used by `GET /api/dashboard`. |
| `types.ts` | `DashboardData` discriminated union (`DashboardDataActive | DashboardDataPendingPayment | ...`), `ZernioConnectionState`. |

### `kpi/`

Analytics window vocabulary and the Review-time anchor fragments the dashboard payload composes.
No service layer — the consumer-less Stack A KPI service was deleted in #757.

| File | What it does |
|------|--------------|
| `types.ts` | `DASHBOARD_WINDOWS` / `DashboardWindow` / `resolveDashboardWindow` / `dashboardWindowParams` — the only window values that may reach windowed SQL, as bound integers (#403). |
| `fragments.ts` | `reviewTimeAnchor` / `reviewTimeWindowFilter` — single owner of the Review-time anchor `LEAST(review_date, detected_at)` (ADR 0019). Composed by `dashboard/service.ts` + `dashboard/aggregate-queries.ts`; carries no FROM/JOIN and no tenant predicate. |

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
| `queue-names.ts` | Canonical queue name constants. Single source of truth for `job_outbox.topic` strings and BullMQ queue names, including WS6 autonomy topics and WS8 `stripe_subscription_mirror_sync`. |
| `queue-health-states.ts` | `QUEUE_HEALTH_JOB_STATES` — the BullMQ job-count states surfaced to the admin panel. Single owner shared by `worker/internal/queue-health.ts` and the admin jobs page (`src/app/admin/jobs`). Same no-side-effect contract as `queue-names.ts` (never imports bullmq/ioredis). |
| `worker-types.ts` | TypeScript types for every BullMQ job payload (`SyncReviewsPayload`, `GenerateResponsePayload`, etc.); **WS6** owns the suspension-trigger/evidence vocabulary and the three judge/suspension payloads here. |
| `job-outbox-helpers.ts` | Typed transactional enqueue helpers. **WS6** adds exact-partial-index-deduped autonomy helpers; **WS8** adds the deprecated Stripe subscription-mirror repair job, enqueued with canonical status state. |
| `outbox.ts` | `markOutboxCompleted()`, `markOutboxFailed()`, `extractOutboxHandle()` — called at the end of every job handler. **WS5/WS6:** attempt-aware failure and `markOutboxCompletedIfOwned()` completion CASes return ownership so a stale BullMQ replay cannot write coupled terminal/domain state. |
| `outbox-completion-reason.ts` | Single owner of the `job_outbox.completion_reason` vocabulary (`OUTBOX_COMPLETION_REASON`: `owner_unreachable`, `import_consent_blocked` #695, `stale_review_content` #728) — `markOutboxCompletedWithReason` is typed against it. Operator-facing signal within the 7-day archival window; only `OWNER_UNREACHABLE` has a poller/alert. Also owns `OWNER_UNREACHABLE_AGE_FLOOR_SECONDS`. |
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
| `page-gate.ts` | **(Phase 2)** `requireAdminPage(sql, {from, aal2})` — server-component admin gate. Resolves auth user → `users` row → admin role, optional AAL2 step-up; redirects to login/MFA-challenge on failure (fail-closed even if the AAL2 check itself throws). Defense-in-depth behind `src/proxy.ts`'s `/admin` gate; every migrated admin `page.tsx` calls it. |

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
| `process-review.ts` | **Two** exported entry points over one private `insertNewReviewRow` seam. `processReview` — the live-ingest lane: deduplication, identity-collision detection, upsert into `reviews`, and `generate_response` enqueue. `importReview` (#674) — the **Review import** lane: insert-only, classifies sentiment at the write site, writes AND completes a `review_ingested` run-spine record in the insert transaction, enqueues **nothing**, and never mutates an existing row (an existing row and a lost insert race both return `'unchanged'` with zero writes). Ships callerless; its caller is #675. Carries a KNOWN HAZARD in its JSDoc — a review stored by the import is never drafted by any lane, and this needs no race; owned by #675. |
| `import-consent.ts` | **(#677)** The single owner of **Import consent**: spec §5.3's derived-expiry predicate and every write to it. `importConsentStateSql` (composable fragment — **callers must alias `businesses` as `b`**; it takes no interpolation, because the four producers' suites use hand-rolled `sql` mocks that only implement the tagged-template call form), `readImportConsent`, `createImportOffer` (proves the junction in its own SQL; deadline `now() + 7 days`, no anchor; caller must hold the `businesses` row lock), `recordImportDecisionAndEnqueue` (owns `sql.begin` → row lock → guarded transition → deduped raw `job_outbox` INSERT, so the route stays a thin mapper per invariant #12). Every export binds `accountId` directly (invariant #8). No analytics events — deferred to #679. |
| `import-offer-view.ts` | **(#677)** Read model for `ImportOfferBanner`: `readImportOfferView` → discriminated union `none / offer / importing / imported / empty / failed`. `completed_at` decides done, never `imported_count` (which DEFAULTs to 0 and is written incrementally); `empty` requires completed AND zero. Run rows are scoped to `run_reason = 'initial'` so recurring reactivation catch-ups cannot flip the banner back to `importing`. Outbox status maps per the `draft-status` precedent, importing `OUTBOX_IN_FLIGHT_STATUSES` rather than re-spelling it. |
| `status.ts` | `REVIEW_STATUS` — canonical `reviews.status` value vocabulary (the reviews-table sibling of `shared/response-status.ts`). Guarded by `scripts/ci/reviews-status-audit.ts` (baseline ratchet on raw status literals in reviews-table SQL). |
| `detect-language.ts` | Detects the language of a review text (used to make AI respond in the same language). |
| `sentiment.ts` | `classifySentiment(starRating)` — deterministic star-based sentiment (`deterministic_star_v1`), written at review-content write sites. |
| `triage-schema.ts` | WS2/WS3 Guardian triage vocabulary — severities, issue taxonomy, suggested actions (+ `ESCALATING_ACTIONS`), `TRIAGE_SOURCE` tags, owner-facing labels (`TRIAGE_SEVERITY_LABELS` / `TRIAGE_ISSUE_LABELS`), `TriageOutputSchema` (zod), and the `TriageClassification` result type (owned here so `escalations/raise.ts` avoids a triage ⇄ raise type cycle). Leaf module (imports only zod); values in lockstep with migration 072's CHECKs. |
| `triage.ts` | WS2: `classifyReviewTriage` (cost-guarded `triage` LLM task, severity-high fallback on terminal errors) + `persistTriage` (review lock → `reviews.triage_*` UPDATE → guardian `triage` step → `ESCALATION_ENABLED`-gated `raiseEscalation` (WS3), one tx). Re-exports `TriageClassification` from `triage-schema.ts`. |
| `flags.ts` | `triageEnabled()` — `TRIAGE_ENABLED` accessor over `readFlag`. |
| `mock-source.ts` / `mock-monitor.ts` | Canned data used when `MOCK_EXTERNAL_APIS=true`. |

**Connection:** `ReviewSyncWorker` instantiates `SerpApiMonitor` → calls `process-review.ts` for each result → writes to DB → enqueues `GenerateResponsePayload` via outbox.

### `past-replies/`

The read + derivation side of the **Reviews list** (the page itself is
`src/app/(authenticated)/dashboard/reviews/history/`).

| File | What it does |
|------|--------------|
| `load-replies.ts` | `loadPastRepliesPageView` — the account/location-scoped **row source** behind the list. `LEFT JOIN` (not `JOIN`) so never-replied reviews appear, plus LATERALs for the live draft (carrying a `held` flag from `flagged_responses`) and the orphan sidecar, so `is_orphan` is a column on the single row source rather than a caller-set field. Orders unanswered-first, then `review_date DESC, r.id DESC`; `PAGE_SIZE` 50. Its companion is **ONE** denominator query (#731 — was two `COUNT`s + an `AVG` in a `Promise.all` over three snapshots, which could count a review in neither group and deflate `totalPages`): `LEFT JOIN responses p ON p.review_id = r.id AND p.status = 'posted'` + `COUNT(*) FILTER (WHERE p.review_id IS NULL / IS NOT NULL)` + `AVG(r.star_rating)`, so all three figures share one snapshot. The partition is closed arithmetically (a LEFT JOIN preserves every review; `IS NULL`/`IS NOT NULL` is a total split) and cannot multiply rows because `responses_one_posted_per_review` (migration 031) is `UNIQUE (review_id) WHERE status = 'posted'`. Do **not** re-express it as a `CROSS JOIN LATERAL … EXISTS` read by both `FILTER`s — that plans one correlated SubPlan per reference (lab-notes #731). |
| `replies-view.ts` | Pure derivation (#727, ADR 0018): `deriveAxes` (Posted-reply axis `reply_state` `none`/`posted`/`orphan` + server-internal Replacement-draft axis `draft_state` `none`/`generating`/`ready`/`held`, precedence held > ready > generating > none) and `deriveRowAction` ((reply, draft) → Action slot `row_action`, total over the 3×4 cross-product; the wire carries `reply_state` + `row_action` only — `held` never crosses it), plus `provenanceBadge` (four-value `ProvenanceBadge`; `isHistorical` survives only as a badge input, never as a bucketing predicate). The card renders what the server derived — it never computes an affordance. |
| `flags.ts` | `editRepliesEnabled()` — the sole `EDIT_REPLIES_ENABLED` accessor over `readFlag`, and the module's only export since #678 retired `PAST_REPLIES_VIEW_ENABLED`. |
| `__tests__/load-replies.integration.test.ts` | **(#678)** Live-Postgres suite for the list query: unanswered-first ordering and the count denominators, asserted against the real schema rather than a mocked row shape. |

The **On-demand generation** doors' own live-Postgres suite is
`src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/generate-version.integration.test.ts`
(#678) — it proves the `MAX(version)`-derived versioning through the real chain:
discarding a v1 `Generate` draft retains it and the next POST enqueues v2.
Both suites follow the live-DB convention (`*.integration.test.ts`, no migration
SQL, `assertSchemaReady`); provision with `pnpm test:db:setup`.

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

### `solicitation/`

Phase 2 Solicitation agent (watch-mode first).

| File | What it does |
|------|--------------|
| `restraint-policy.ts` | **(#542)** Pure, sentiment-blind restraint policy: `evaluateAsk` (five per-candidate gates, first-match precedence) + `evaluateBatch` (adds `velocity_banked`), closed six-reason withhold enum, vertical mapper, versioned tunable constants (`RESTRAINT_POLICY_VERSION`). No DB, no clock — `decided_at` + business category arrive via context. Spec: `docs/superpowers/specs/2026-07-23-restraint-policy-v-watch.md`. |
| `flags.ts` | `solicitationWatchEnabled()` — `SOLICITATION_WATCH_ENABLED` accessor over `readFlag`. Default off; gates the four `/api/dashboard/contacts/**` routes plus both `/api/dashboard/solicitation/batch*` routes (404 before auth), the `/dashboard/requests` and `/dashboard/requests/contacts` pages (`notFound()`), and the `Requests` nav row in `Sidebar` + `MobileTabBar` (server prop from `(authenticated)/layout.tsx`, no `NEXT_PUBLIC_*` companion). Staging flip owned by #544. |
| `handles.ts` | **(#541)** Normalized-handle kernel (#535 contract §1.1/§6): `normalizeEmail` (lowercase/trim + plausibility) and `normalizePhone` (E.164; US assumed for 10-digit; any letter rejects). Computed ONCE at CSV ingest and stored — the future suppression ledger keys on the stored handle per channel, never on `contact_id`, so delete + re-upload cannot un-suppress. |
| `contacts-csv.ts` | **(#541)** Pure contacts CSV parse kernel (#535 §2) with a private RFC-4180 tokenizer. Syntax-only validation (staleness is the restraint policy's judgment, never ingest's); closed `ROW_REJECTION_REASONS` + `STRUCTURAL_FAILURES` enums; 5 MB / 5,000-data-row / 500-char-note caps. `todayUtc` arrives as a parameter — no clock reads, identical inputs parse identically. |
| `attestation.ts` | **(#541)** Versioned consent-attestation code constants (#535 §4): `CONSENT_ATTESTATION_VERSION` + `CONSENT_ATTESTATION_TEXT`. Wording changes MUST bump the version; the version string is stored on every upload row so "which attestation covers this person" is a query, not a guess. |
| `uploads.ts` | **(#541)** Upload lane: `createContactsCsvUpload` persists the raw CSV + consent attestation AND enqueues `csv_ingest` in ONE tx (invariant #2); `getUploadStatus` is the account-scoped status/report read (a `contact_csv_uploads.report` PgBouncer JSONB parse site — CLAUDE.md allowlist). Injected `Sql` (invariant #15). |
| `ingest.ts` | **(#541)** Ingest lane: `ingestContactsCsvUpload` — match/merge/upsert of contacts + visits, terminal report write, raw-CSV clearing, ALL inside one tx whose FIRST statement takes a per-business `pg_advisory_xact_lock` (serializes concurrent ingests and the failed-hook terminalizer). `parseStoredReport` is the second `contact_csv_uploads.report` JSONB parse site. PII contract: never logs names/handles/notes/raw CSV — counts and reason histograms only. |
| `contacts-repo.ts` | **(#541; owner suppression paths #645)** Contacts read/delete repo (#535 §5): `listContacts` (bounded; `clampContactListPage` is the single owner of the limit 1–100 / offset ≥ 0 rule) + `deleteContact`. Contacts carry NO `account_id` — every query joins `businesses` on `b.account_id = accountId`; the join IS the account-scope check (invariant #8). **#645** adds the §7.4 state to `listContacts` (a `LEFT JOIN LATERAL` over `suppressionMatchSql`, mapped through `toSuppressionDisplay` so nothing but the four display keys reaches the client) plus the two owner writes: `markContactDoNotContact` (§7.5, `scope='account'` / `owner_manual` — global would let one owner silently degrade every other tenant's reach, and the pairing CHECK refuses it anyway; writes **no** audit row, because creation already emits the §9.4 `solicitation_suppressed` analytics event inside `recordSuppression`'s tx) and `clearContactDoNotContact` (§7.6, whose predicate can only ever reach `scope='account' AND account_id = <caller's>`, with `writeAccountAuditLog` in the DELETE's transaction — deletion emits no analytics event, which is exactly why it gets the audit row). |
| `batch-view.ts` | **(#544)** Read model for the Requests screen: `readLatestBatch` (discriminated `no_batch` / `building` / `built` — funnel totals + a bounded per-reason evidence sample, all inside ONE `REPEATABLE READ, READ ONLY` transaction so an offboarding purge cannot yield a "built" batch with zero asks) + `markBatchReviewed` (idempotent first-write-wins `reviewed_at`, `GREATEST(NOW(), built_at)` against migration 088's CHECK). `parseEvidence` is the `solicitation_asks.evidence` PgBouncer JSONB parse site — CLAUDE.md allowlist. Timestamps read as `::text` (postgres.js truncates µs). Injected `Sql` (invariant #15). |
| `batch-builder.ts` | **(#593)** Batch build lane: `constructBatch` (per-business `pg_advisory_xact_lock` FIRST, then the `FOR UPDATE OF sb` row lock — one global order, advisory-before-row, so purge and construction cannot deadlock ABBA) + `prepareBatch`. Candidate selection, restraint evaluation and the ask fan-out land in one tx with the `built_at` CAS. Injected `Sql` (invariant #15). |
| `outreach.ts` | **(#624)** Send-lane lifecycle kernel: `deriveBatchState` (the read-time closed union over `solicitation_batches`' monotone timestamps — there is deliberately no `status` column), `closeBatchIfSettled` (the single owner of batch closure: CASes `send_closed_at` on NULL, records one close step, terminalizes the **Send batch parent** through an ordered disposition precedence — every write gated on the winning CAS because `appendRunStep` always appends), and the approval/send window boundaries. Disposition arrives as an explicit `failure` parameter, never read back off `agent_runs.error`, so batch→run is the sole lock order. Injected `Sql`/`TransactionSql` (invariant #15). |
| `unsubscribe.ts` | **(#644)** The Unsubscribe token kernel, consumed by BOTH surfaces. `mintUnsubscribeRawToken` (`<nonce>.<HMAC>` — #630 MUST call this, not roll its own) · `isWellFormedUnsubscribeToken`, the constant-time, **zero-DB** admission gate, so a forged token opens no connection · `hashUnsubscribeToken` (unkeyed SHA-256 — the *storage* key, deliberately not the HMAC) · `redeemUnsubscribeToken`, the claim-first `UPDATE … RETURNING account_id, normalized_handle, channel` (no `business_id` — the ledger has no field for it) feeding `recordSuppression` from the row it locked · `redemptionConfirmsSuppression`, a total `Record` over the outcome union so a fifth outcome without an answer is a **`tsc` error** · `mint`/`verifyUnsubscribeReceipt` (10-min TTL, `timingSafeEqual`, current-then-previous key) · `assertUnsubscribeTokenSecretConfigured`. Verification tries `SESSION_COOKIE_SECRET_PREVIOUS` on a miss so a rollover cannot strand delivered links inside the statutory ≥30-day window. Injected `Sql`/`TransactionSql` (invariant #15). |
| `suppression.ts` | **(#643; §7.4 display seam #645)** The **Suppression ledger**'s domain core. Closed `SUPPRESSION_SOURCES` / `SUPPRESSION_SCOPES` / `SUPPRESSION_CHANNELS` `as const` arrays (never string literals at call sites); `recordSuppression` (first-write-wins `ON CONFLICT … DO NOTHING` against the two partial unique indexes, each predicate re-spelled byte-for-byte, with the `solicitation_suppressed` analytics insert in the same tx); and `suppressionMatchSql`, the ONE owner of the §1.2 lookup (G7 — no `isSuppressed()` helper), composed by callers into a `LEFT JOIN LATERAL`. **#645** adds `scope` to that projection — §7.4 needs an owner surface to tell its own reversible `account` row from a `global` one, and deriving it caller-side from `source === 'owner_manual'` would be correct only until a second account-scoped source existed — plus the read seam `toSuppressionDisplay` + `SUPPRESSION_DISPLAY_COPY` (#629 consumes the same one). The seam returns a **closed four-key** object (`state` / `label` / `detail` / `clearableByOwner`), and that output closure is the guarantee: a global row's `account_id` provenance and its `source` cannot reach an owner surface through it (§7.4, invariant #8, FU-3). An unknown scope **throws** rather than defaulting — silently rendering it as "global" would claim an opt-out nobody made. |
| `postal-address.ts` | **(#656)** The **Attested postal address**'s domain core, and the single owner of five facts so no call site re-derives them: `POSTAL_ADDRESS_ATTESTATION_VERSION` + `POSTAL_ADDRESS_ATTESTATION_TEXT` (the compliance record of what the owner assented to — wording changes MUST bump the version); `lintPostalAddress`, the §7.5 light lint (non-empty, ≥2 NON-EMPTY lines, a US postal code on the LAST non-empty line so `12345 Elm St` is a street number, not a ZIP) plus the one minimal normalization the stored bytes get, because the address is baked into the ask footer VERBATIM; `attestPostalAddress`, which takes the RAW address and lints internally so no code path stores an unlinted one, writing ONE `UPDATE businesses` scoped by `id` AND `account_id` AND carrying the actor-membership `EXISTS` — `_attested_by_user_id` has no FK (093's lesson), so the *writer* is what stops a cross-tenant UUID being stamped as legal provenance — with the digest computed SERVER-SIDE from the same value the column stores, so it cannot disagree with what 099's CHECK recomputes; `readPostalAddressState`, the account-scoped read model that offers `google_place_address` as a suggestion **only** while no attested address exists; and `sendHandoffWithheldReason`, the pure first-match location-level rule (`postal_address_missing` ahead of `owner_email_bounced` — it is the CAN-SPAM one). Deliberately **not** part of `attestation.ts`, which owns the **Consent attestation** — a different fact with its own version namespace; two independently-versioned attestations behind one interface silently authorizes or blocks sends. Injected `Sql`/`TransactionSql` (invariant #15). |

> **Known gap, not #644's or #645's to fill:** the five `ask-*.ts` modules (#628)
> and `upload-status.ts` have no rows in this table yet.

**Connection:** `POST /api/dashboard/contacts/uploads` → `uploads.ts` (upload row + `csv_ingest` outbox, one tx) → OutboxPoller dispatches → `worker/jobs/csv-ingest/` delegates to `ingest.ts` → the dashboard polls `GET /api/dashboard/contacts/uploads/[id]` for the terminal report. The built batch then surfaces on `/dashboard/requests` via `GET /api/dashboard/solicitation/batch` → `batch-view.ts`. Unit + integration tests colocate in `__tests__/`.

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
| `generator.ts` | `generateResponse(review, context, options)` — full pipeline: cost guard → idempotent cache → `runLlmTask('reply_generation')` via the LLM seam → save → cache. Two modes: `demo` (fast, no cost guard) and `production`. **(#728)** The `(reviewId, version)` cache payload is provenance-bound: `CachedGeneration.reviewContentHash` must strict-equal the current attempt's `options.loadedReviewContentHash` (`null===null` for legacy entries) or the entry is rejected + cleared best-effort — a colliding same-version replacement job legitimately shares the key, so key equality is not content equality. |
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
| `limits.ts` | **(#765)** `MAX_REPLY_LENGTH` — the shared 2000-character server/client edit contract. |
| `generation-state.ts` | **(#765)** Injected-SQL helpers for the in-flight `generate_response` predicate and monotonic per-review `MAX(version)+1` allocation; callers retain their existing tenant proof and review locks. |
| `review-ownership.ts` | **(#765)** Whole-query account ownership proof for the Reviews-list Generate door and its account-scoped poll route; deliberately not used by cookie-location past-replies routes. |

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
| `channels/telegram-env.ts` | `assertTelegramEnvReady()` — 503 when `CHANNELS_TELEGRAM_ENABLED=true` but Telegram env is incomplete. `MOCK_EXTERNAL_APIS=true` bypasses. |
| `channels/whatsapp-channel.ts` | WhatsApp via Twilio Content API. Checks `CHANNELS_WHATSAPP_ENABLED`; **WS6** skips suspension notices cleanly when the optional approved template SID is absent. |
| `channels/whatsapp-client.ts` | Low-level WhatsApp client (Twilio SDK, 7 typed error classes, `classifyError` dispatch). |
| `channels/whatsapp-body.ts` | Builds Twilio Content variables for five WhatsApp templates (approval, autopost FYI, escalation, **WS4** pending-post, **WS6** autonomy-suspended); extracts tokens where applicable, validates the fixed WS6 settings suffix, and owns body-length budgets (authoritative copy: `docs/runbooks/whatsapp-templates.md`). |
| `channels/whatsapp-env.ts` | `missingWhatsAppEnv()`, `whatsappEnvReady()`, `assertWhatsAppEnvReady()`. `whatsappEnvReady()` is also read by the owner settings page and `GET /api/dashboard/channels` so the UI never offers a Connect button the start route would 503. |
| `channels/deep-links.ts` | `buildMobileDeepLink(channel, rawToken)` — the single owner of the `t.me` / `wa.me` enrollment deep link, exhaustive over `MobileChannel`. Two per-portal copies had diverged twice before this. |
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
| `price-tier-map.ts` | Single variant-aware owner of the four Copilot/Autopilot base Price IDs and two overage IDs; forward lookup takes `(tier, price_variant, kind)` and reverse base lookup returns `{tier, variant}`. |
| `create-checkout-session.ts` | Creates card-up-front monthly Stripe Checkout Sessions from one authoritative account attempt. Retries use its frozen Price/quantity/trial/tax/email/URL tuple under a stable idempotency key; promotion codes stay disabled. |
| `founding-window.ts` | Strict-UTC, fail-closed `FOUNDING_DEADLINE` eligibility (`now < deadline`). |
| `tier-purchasability.ts` | Composes the server-only Autopilot sales gate with auto-approval runtime readiness. |
| `plan-presentation.ts` | Server-produced Copilot/Autopilot availability and founding/list amount view model for pricing, onboarding, and billing UI. |
| `plan-activation.ts` / `overage-item.ts` | Complete stored billing-snapshot activation, single pending Checkout lease/reselection, and variant-aware overage item resolution. |
| `stripe-client.ts` | Shared pinned Stripe client with bounded timeout/retry policy. |

### `admin/` *(Wave 2 additions)*

Admin-side domain helpers.

| File | What it does |
|------|--------------|
| `impersonation/cookie.ts` | HMAC signs/verifies the `rw_impersonation` session cookie. |
| `impersonation/session.ts` | Starts, ends, and loads active impersonation sessions with account audit logging. |
| `impersonation/view.ts` | Resolves an admin-owned impersonation view session and loads account-scoped location data. |
| `impersonation/guard.ts` | Non-destructive action allowlist for impersonation surfaces. |
| `nav-counts-service.ts` | `getAdminNavCounts(sql)` — the two cross-tenant aggregate COUNT queries (flagged_responses open, job_outbox failed) behind the sidebar's badge counts. Used by `GET /api/admin/nav-counts`. |
| `jobs-service.ts` | **(Phase 2)** `getAdminJobsData(sql, {limit, offset})` — the outbox status summary (incl. `dispatching`), a page of failed jobs, and the failed total. Single owner shared by `GET /api/admin/jobs` and `jobs/page.tsx`. |
| `queue-health.ts` | **(Phase 2)** `fetchQueueHealth()` — per-queue BullMQ depth + shared-pool wait, fetched from the Railway worker's authed internal endpoint; degrades to `{unavailable: true}` / `null` on any failure (missing config, non-200, timeout). Single owner shared by `GET /api/admin/jobs` and `jobs/page.tsx`. |
| `notifications-service.ts` | **(Phase 2)** `getAdminNotifications(sql, filters)` — the notification delivery log page (dynamic `sql.unsafe()` WHERE builder) + the businesses filter dropdown. Single owner shared by `GET /api/admin/notifications` and `notifications/page.tsx`. |
| `flagged-service.ts` | **(Phase 2)** `listOpenFlaggedResponses(sql, {limit, offset})` — a page of the open flagged-response queue (joined to response/review/business) + the open total. Single owner shared by `GET /api/admin/flagged` and `flagged/page.tsx` (the POST disposition transaction stays in the route). |
| `suppressions-service.ts` | **(#645)** The admin-owned Suppression ledger paths (spec §7.3, §8.2): `lookupSuppressions` (live rows for one **Normalized handle** + its prior corrections, so a re-entry after a correction is visible rather than a surprise — cross-tenant, `ci:tenant-scope`-allowlisted), `recordAdminManualSuppression` (`global` / `admin_manual`, `accountId` deliberately null — a mailbox reply names no account and guessing one writes false provenance), and `correctSuppression` — **one** data-modifying CTE whose `DELETE … RETURNING` feeds the `solicitation_suppression_corrections` INSERT, so the delete cannot commit without its audit record even if a call site forgets a transaction, and the record is built from the DELETE's own `RETURNING` so a concurrent correction cannot describe a row this call did not remove. Zero rows back = `'not_found'`: nothing deleted, no orphan record, no third outcome. Authorization lives in the callers (the two `requireAdminWithAal2` routes), which is the proof `recordSuppression`'s `createdByUserId` string cannot carry. |
| `business-summary.ts` | **(§5.2)** `getBusinessSummaries(sql, opts?: {limit, offset})` — the **one** owner of the admin business read both admin surfaces share, and the module that replaced `businesses-list-service.ts` (deleted) plus the duplicate base query in `overview-service.ts`. It owns: the **base query** (`businesses` JOIN `accounts` LEFT JOIN non-superseded `responses`, pending-approval/pending-reconnect counts all-time, response aggregates windowed, `ORDER BY b.name ASC`, `LIMIT/OFFSET` only when `opts` is supplied); the **conditional unfiltered COUNT** — issued only on the paginated path, because an unpaginated caller already holds every row and gets `total = businesses.length` (deliberately not a window `COUNT(*) OVER ()`: the page query GROUPs, so a window total would count grouped page rows); the **metrics follow-up** (the churn-signal CTE) keyed on the ids the base query *actually returned* post-`LIMIT`, so `/admin/businesses` is bounded by its page and not by the table, and skipped entirely for an empty page; `buildBusinessSummary` (row→DTO + `computeChurnRiskScore`, carrying its `fallow-ignore-next-line complexity` marker); and `RESPONSE_METRICS_WINDOW_DAYS` (30) — the single owner of the trailing response-metrics window, surfaced as `responseMetricsWindowDays` so both pages' column labels derive from it instead of a literal `30`. Read by `/admin/overview` unpaginated (which then ranks in TS — see the **At-risk list**) and by `GET /api/admin/businesses` + `businesses/page.tsx` with a page; the limit/offset clamping stays in the route. Strictly sequential per #773 — rows → COUNT → metrics, never a `Promise.all` over `sql` — pinned by `__tests__/pool-fanout-sequential.test.ts`. |
| `business-channels-service.ts` | **(Phase 3)** `getBusinessChannelEnrollments(sql, businessId)` — account resolution, the enrollment query, per-channel dedup (location override beats org default), and `maskChannelHandle`. All timestamps ISO. Single owner shared by `GET /api/admin/businesses/[id]/channels` and `businesses/[id]/page.tsx`. |
| `offboardings-service.ts` | **(Phase 3)** `getAdminOffboardings(sql, {limit, offset})` — the lifecycle list + count, the row mapper, and `scrubAdminLastError` (the security-relevant redactor). Exports the `AdminOffboarding`/`AdminProviderDisposition` DTOs the client imports. Single owner shared by `GET /api/admin/offboardings` and `offboardings/page.tsx`. |
| `demos-service.ts` | **(Phase 3)** `getAdminDemos(sql)` — the demo list read, ISO timestamps. Single owner shared by `GET /api/admin/demos` and `demos/page.tsx`. |
| `business-detail-service.ts`, `business-detail-types.ts`, `business-detail/{queries,mappers,update,errors}.ts` | The business-detail read/write model behind `GET`/`PATCH /api/admin/businesses/[id]` and `businesses/[id]/page.tsx`. The mappers own the `timestamptz → ISO string` conversion for every `string`-typed DTO field — a raw `Date` is invisible through a route's `JSON.stringify` but crosses the RSC boundary intact and throws on first paint. |
| `overview-service.ts` | **(§5.1/§5.3)** `getAdminOverview(sql)` — the 5 system-health queries (pending/failed `job_outbox`, today's API cost, 24h notification failures, the email-delivery aggregate), `deriveEmailHealth` (delivery rate + `redState`), and the **At-risk list** selection: `getBusinessSummaries(sql)` unpaginated as its 6th sequential await, then filter `churnScore.level !== 'healthy'` → sort (score desc → pending desc → name asc → id asc) → cap at `OVERVIEW_AT_RISK_LIMIT`. It no longer owns the business base query, the metrics CTE, `buildBusinessSummary` or a separate `COUNT` — those went to `business-summary.ts` — and it takes no `{limit, offset}`: Overview stopped paginating. It also **declares** `OVERVIEW_AT_RISK_LIMIT` (5) rather than `page-sizes.ts`, because the cap is applied here and `src/lib/**` may not import `@/app/**` (eslint `APP_LEAF_IMPORT_BAN`); reasoning in `docs/superpowers/plans/refactor-overview-spec-alignment-deviations.md`. |
| `cost-report-service.ts`, `margin-service.ts`, `csv-import.ts` | API-cost report; admin-only aggregate margin signals; the CSV locations-import row processor. |

### `onboarding/`

| File | What it does |
|------|--------------|
| `create-business.ts` | `createBusinessTx(sql, params)` — atomic transaction that inserts `users` + `businesses` + `channel_enrollments` (email) rows. Used by both admin and self-serve signup. Dual mode (`admin` / `self_serve`). |
| `admin-onboarding-service.ts` | `onboardBusinessAsAdmin(sql, supabase, input)` — validates admin onboarding input, calls `createBusinessTx` in `admin` mode, handles `DuplicateEmailError`, and invites the owner via Supabase `inviteUserByEmail`. `rollbackProvisionedBusiness(sql, createdResult)` runs the shared FK-ordered 4-DELETE compensating rollback used by both failure paths. Used by `POST /api/admin/businesses`. **(2026-08-14)** Input is now only owner email, owner name and business name; it resolves no Place ID, writes no voice fields, asserts no tier (the row is created on the `copilot` default and the owner picks their real tier at `/onboarding/pay`), and enqueues no `validate_place_id` — `/api/onboarding/start` does that once the owner captures a place, exactly as it does for self-serve. |
| `funnel-entry.ts` | **(2026-08-14)** `resolveFunnelEntry(state)` — the single owner of "where in the funnel does this owner belong?", returning one of `/onboarding/{start,demo,pay,business}` or `/dashboard`. **Pure**: no DB handle, no `process.env`, no flag read (the caller passes `onboardingDemoEnabled()` in), so the whole matrix is table-testable and flag state stays server-side (invariant #13). Its output is the `funnelUrl` field on `GET /api/auth/signup-status`, `GET /api/dashboard` and `GET /api/settings`, consumed by `loginDestination` and `PendingPaymentScreen`. Replaced three disagreeing branches — `loginDestination`'s demo-blind `pending_payment → /onboarding/pay`, `verify-otp`'s private start-vs-pay branch, and the dashboard's hardcoded `paymentUrl` (that field is **gone**, not renamed). |
| `resend-invite.ts` | **(2026-08-14)** The re-invite decision + Supabase provider-error mapping behind `POST /api/admin/businesses/[id]/resend-invite`. Gates on account `pending_payment` AND the provider reporting `last_sign_in_at IS NULL`. ⚠️ **The error mapping is deliberately staging-unverified** — the module header carries a "staging-verify before prod" marker, an unknown provider error answers `502` with the raw provider code logged and is never auto-retried, and verifying the real Supabase re-invite error shapes on staging is an open ops step (`docs/runbooks/beta-onboarding-cofounder-guide.md` → Part 12). |

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

Defines all BullMQ `Queue` instances (one per job type), including WS6 autonomy queues and the WS8 Stripe subscription-mirror repair queue on the shared retry defaults. Exports:

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
| `ZernioBackfillWorker.ts` | `zernio-initial-backfill` | **(#675)** Consented Review import executor — NOT an answering backfill. Pure `selectImportWindow`: newest 100 reviews with `createTime ∈ [now − 12 months, live-ingest cutoff)` (CONTEXT.md glossary; upper bound keeps lane ownership disjoint from the live lane). Pages `listReviews` up to `ZERNIO_IMPORT_MAX_PAGES` (default 6); cap-out with target unmet is TERMINAL (`ZernioImportPaginationCapExhaustedError`, failed outbox row + Sentry, `completed_at` NULL for ops re-enqueue); non-descending pages disable both early stops (best-effort to feed end). **(#679)** Runs `guardImportConsent` FIRST — before `guardZernioJobEligibility` and before the run-row INSERT — so a job for a non-`accepted` business no-op-completes and mints no run row. Unanswered → `importReview` (zero `job_outbox` writes); answered → `reconcileExternallyAnsweredReview({consentedImport:true})`. Writes ONLY collapsed `imported_count`/`skipped_count` on `zernio_backfill_runs` — the four legacy gap/historical counters freeze at DEFAULT 0, DROP at #680 after a reconciliation preflight. Concurrency 1 (heavy). Subscription-guarded. |
| `ResponseGeneratorWorker.ts` | `generate-response` | Loads review + business context, calls `generateResponse()`, saves draft, enqueues notification via outbox. **(WS5)** terminal draft failures close the matching outbox attempt and complete the active review run as failed in one reviews-first transaction. **(#728, ADR 0017)** `persistResponseAndNotify` (`response-generation/persist.ts`) runs the lane-independent **content-freshness gate** before the lane split: under the review `FOR UPDATE` lock (the tx's first statement) it re-reads `review_content_hash`; both hashes non-null and different → skip-the-INSERT, and the handler completes the job with `markOutboxCompletedWithReason(…, STALE_REVIEW_CONTENT, …)` — nothing written, the `(review_id, version)` slot stays free for the colliding fresh job. Null on either side passes. |
| `NotificationWorker.ts` | `send-notification` | Orchestrates the notification send loop. Delegates context loading to `notification/context.ts`, eligibility filtering to `notification/eligibility.ts`, and per-channel dispatch to `notification/dispatch.ts`. Skips `pending_payment` and `cancelled`. |
| `EscalationNoticeWorker.ts` | `escalation_notice` | **(WS3)** Sends the Guardian escalation notice to the owner's channels. Re-checks `ESCALATION_ENABLED` at SEND time (kill switch stops outbound notices without hiding raised escalations), reuses the approval worker's eligibility primitive, then hands off to `escalation-notice/dispatch.ts`. Afterwards records the `escalation_sent` step BEST-EFFORT (log-and-swallow — `notification_deliveries` is the authoritative per-channel record). |
| `AutoPostNoticeWorker.ts` | `auto_post_notice` | Sends the auto-approved post FYI ("your reply was posted") to the owner's channels after an `auto_policy` publish. Reuses the approval worker's eligibility primitive, then hands off to `auto-post-notice/dispatch.ts`. NEVER mutates the already-posted response — a send failure retries on this job alone. |
| `PendingPostNoticeWorker.ts` | `pending_post_notice` | **(WS4)** Sends the veto-window "your reply will post automatically" notice. Re-checks `AUTO_APPROVAL_ENABLED` at SEND time (spec §2.12; flag off ⇒ complete without sending — the publisher's downgrade backstop owns the record), loads the still-scheduled `auto_policy` response via `pending-post-notice/context.ts` freshness guards, reuses the approval worker's eligibility primitive, then hands off to `pending-post-notice/dispatch.ts`. NEVER mutates the response; the delayed publish outbox row is independent and fires at the deadline regardless. |
| `AutonomyAdminAlertWorker.ts` | `autonomy_admin_alert` | **(WS6)** Renders an internal account-suspension alert from bounded trigger/evidence facts, sends it to `ADMIN_NOTIFICATION_EMAIL`, then independently attempts Sentry warning telemetry so observability cannot poison a successful email path. |
| `billing/StripeSubscriptionMirrorSyncWorker.ts` | `stripe_subscription_mirror_sync` | **(WS8)** Converges deprecated business subscription status/activation from canonical account state. Locks business rows in id order, then entitlement, reads the account without a row lock, updates the mirror, and completes the originating outbox entry in one transaction. |
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
| `csv-ingest/index.ts` | `csv_ingest` | **(#541)** Contacts/visits CSV ingest (`handleCsvIngest`). Subscription gate derived from the upload row's business→account join (`subscriptionGrantsFullAccess`, invariant #11 — gated accounts leave the upload `pending`); delegates all match/merge/upsert + report behavior to `src/lib/solicitation/ingest.ts`. PII contract: logs counts/ids only — never names, handles, notes, or raw CSV. |
| `live-draft-guard.ts` | — (helper) | **(WS5)** `hasLiveOwnerActionableResponse(tx, reviewId)` — shared by `ResponseGeneratorWorker` and `publisher/failed-hook` terminal checkpoints; a run is never completed `failed` while an owner-actionable draft (non-terminal status) exists for the review. |

#### `worker/jobs/csv-ingest/` — contacts CSV ingest package **(#541)**

| File | What it does |
|------|--------------|
| `index.ts` | Composition root for the `csv_ingest` queue (see the queue table above). |
| `failed-hook.ts` | Retry-exhaustion terminalizer (`handleCsvIngestFailed`, mirrors `zernio/ingest-failed-hook.ts`). Takes the SAME per-business advisory lock as the ingest tx, re-reads `status='pending'` under it, then — gated by the exact outbox-attempt CAS — terminalizes the upload to `failed` with an `ingest_failed` report and clears `raw_csv` in one transaction (§3: the raw blob's lifetime is bounded by processing, success or failure). Persists only the bounded error CLASS — raw messages can embed handle values. |

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
| `job-eligibility.ts` | Shared pre-flight gate for both Zernio job workers. `guardZernioJobEligibility()` — one `businesses ⋈ accounts` row, then the project's archived-before-subscription guard order; every skip is skip-as-success (outbox row COMPLETED, never failed or retried). **(#679)** `guardImportConsent()` — the fail-closed **Import consent** gate the BACKFILL worker runs first. Proceeds only on `accepted`; `pending`/`declined`/derived `expired`/missing row all log a structured `reason` and complete. Deliberately a SEPARATE export, not a `jobKind` branch, so the ingest worker never learns the interface. Its whole body runs in `sql.begin` with `SELECT … FOR UPDATE` + `markOutboxCompletedWithReason(tx, …)` — both load-bearing against the accept-races-guard data-loss window — and derives expiry through the imported `importConsentStateSql` fragment, which is why its query MUST alias `businesses` as `b`. **(#695)** That completion stamps `job_outbox.completion_reason = 'import_consent_blocked'` (`OUTBOX_COMPLETION_REASON`; column from migration 083), so a policy refusal is separable by SQL from a genuine completed import for the 7-day archival window — an operational signal, not an audit record, and nothing reads it in code (ADR 0016). `guardZernioJobEligibility`'s three skips deliberately keep using plain `markOutboxCompleted`, leaving `completion_reason` NULL. |
| `zernio-ingest-shared.ts` | Shared helpers for `ZernioReviewIngestWorker` and `ZernioBackfillWorker` — webhook fan-out (insert one outbox row per active Zernio connection), pagination state, `processReview()` deduplication, and outbox claim helpers. **(#675)** `liveIngestCutoff()` — single owner of the Live-ingest cutoff (`connected_at − grace`), consumed by `ZernioRecentReviewPoller` (≥ cutoff) and the consented import (< cutoff). Also `reconcileExternallyAnsweredReview()` (PHI-gates before each import branch; `consentedImport` option imports answered rows flag-independently, incl. the branch-3 consented tail via `phiGateAndImportExternalReply`) and **(Wave 1)** `openPhiReviewException()` — opens a `zernio_likely_phi_review` exception + admin-notify outbox row in one **caller-owned** transaction (`sql.begin`), idempotent via `ON CONFLICT DO NOTHING`, Sentry only on a newly-created row. |

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

Each handler is registered as a Fastify route in `worker/index.ts`. **Provider webhooks** all follow the same pattern:

1. Verify the request signature.
2. Write an `inbound_events` row first (deduplication — rejects duplicate event IDs).
3. Execute business logic (update DB, write to `job_outbox`).
4. Return `200` quickly.

**`unsubscribe.ts` is the one exception and follows none of it** — it is a
*recipient-facing* route, not a provider webhook. There is no signature to verify
(the mail client is anonymous), no `inbound_events` dedup (idempotence comes from
the token's own `redeemed_at` claim), and no `rawBody`. It is also the only ingress
route **exempt from the rate limiter**, because §9.2 forbids throttling a statutory
opt-out. Do not "fix" it to match the table above.

| File | Route | What it does |
|------|-------|--------------|
| `shared.ts` | *(utility)* | `claimInboundEvent()`, `markInboundEventProcessed()`, `markInboundEventFailed()` — atomically insert/update `inbound_events` rows. Used as the dedup guard in every other ingress handler. |
| `stripe.ts` | `POST /ingress/stripe` | Verifies Stripe webhook signatures and deduplicates delivery. Checkout completion provider-reads and validates the authoritative attempt before the single status/snapshot projection; subscription/invoice handlers converge provider-current status through the exact entitlement-locked account and durably enqueue deprecated mirror repair. |
| `resend.ts` | `POST /ingress/resend` | Verifies Svix signature. Maps `email.delivered` / `email.bounced` / `email.complained` events to `notification_deliveries` status updates and `owner_email_bounced` flag; **WS6** classifies `autonomy_suspended_notice` as owner-directed for hard-bounce suppression. |
| `unsubscribe.ts` | `POST` + `GET /ingress/unsubscribe/:token` | **(#644)** RFC 8058 one-click opt-out. `POST` redeems the token into a `scope='global'` suppression (`source='unsubscribe_one_click'`) and answers `200` **before** logging, so telemetry cannot turn a committed redemption into a `500`; `unknown_token` → `503` (never a success-shaped no-op, so a #630 mint race stays recoverable). `GET` always `302`s to `<APP_URL>/u/<token>` — including for a forged token, since `503`-ing there would be the one answer that distinguishes forged from real. No signature, no dedup row, no rate limit. Owns the 60s unknown-token aggregate (+ shutdown flush), a per-token single-flight, and `assertUnsubscribeIngressConfigured()`. |
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

### Reviews list — every review for the location, unanswered first (#678)

```
Owner navigates to /dashboard/reviews → "All Reviews" tab (no flag; renders always)
  → server component reads reviews LEFT JOIN responses (+ draft / orphan LATERALs)
  → grouped "Unanswered" then "Answered", newest-first within each, PAGE_SIZE 50
  → deriveAxes() per row: reply_state (none|posted|orphan) × draft_state
                          (none|generating|ready|held — server-internal, #727)
  → deriveRowAction(): the Action slot (row_action) from the 3×4 cross-product;
                       the wire carries reply_state + row_action only (ADR 0018)
  → provenanceBadge() per answered row (replaces the dead gap/historical split)
  → renders PastReplyCard rows
  → Generate  → InlineGeneratePanel → POST reviews/:id/generate (on_demand_generate)
                                    → GET  reviews/:id/draft-status (poll)
  → Regenerate → EditReplyDrawer → the past-replies edit routes  [EDIT_REPLIES_ENABLED]
  → Copilot and Autopilot receive the same paid history/edit entitlement
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
| `verify-stripe-price-parity.ts` | WS8 provider verifier for all six immutable Prices: exact cents, USD, monthly recurrence, active state, and Stripe-Tax-compatible behavior. Fails on missing/duplicate configuration. |
| `ws8-stripe-cutover-preflight.ts` | Dry-run-by-default provider-wide cutover blocker. Independently paginates every Stripe subscription and open Checkout Session/line item, reconciles local projections, and optionally expires old-Price Sessions with stable idempotency. Never writes the database or cancels subscriptions. |
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

All schema migrations live here, numbered `001` … `098` (repository/local-test
head — `098_solicitation_suppression_corrections.sql`, the #645 **Correction
path** audit sink: one immutable row per admin-removed suppression, written by
the same statement as the DELETE, RLS deny-all with zero policies, and **no
foreign keys** — `suppression_id`'s referent is gone by design. It **does**
snapshot the corrected row's `normalized_handle`, `account_id`,
`created_by_user_id` and `note` (D-A11) — the evidence the removed assertion was
legitimate — so it is account-linked and therefore **classified rather than
renamed to evade classification**: `retain_compliance_limited_pii` /
`allowed_limited_retention` in `table-disposition.ts`, the disposition its
siblings `solicitation_suppressions` and `solicitation_unsubscribe_tokens`
already carry; next is `099`). Supabase staging/production migrations remain a user-run
promotion step. WS8 uses `077_copilot_autopilot_expand.sql` only after provider
preflight reaches zero while traffic is quiesced, then deploys strict code and
smokes before `078_copilot_autopilot_contract.sql` installs the NULL-safe strict
two-tier checks. The only executable rollout is
`docs/runbooks/ws8-tier-cutover.md`; the full per-migration narrative and
deployment status remain in `.claude/reference/migrations-log.md`.

---

## Other top-level surfaces (not detailed here)

- `.claude/CLAUDE.md` — always-loaded project facts + the canonical architecture-invariants list + working rules + gotchas + a "where things live" index. Source of truth for architecture. (The former `.claude/rules/` files were retired 2026-08-03: the generic book distillations deleted, `repworth.md`'s unique contracts folded into CLAUDE.md's "Working rules".)
- `.claude/skills/` — patterns to follow, invoked on demand (cost-guard, approval-security, outbox-pattern, onboarding-demo-cost-guard).
- `.claude/reference/` — recall-when-needed inventories, read on demand (env-vars, migrations-log, lab-notes, review-ingestion).
- `docs/runbooks/` — operational + deployment runbooks, including
  `ws8-tier-cutover.md` as the single quiesced Stripe → 077 → strict code → 078
  tier rollout path, and `mfa-factor-reset.md` as the break-glass procedure for
  a user who has lost their authenticator (operator-side factor removal via
  the Supabase Admin Auth API).
- `docs/security/` — **(Wave 1)** RLS inventory, tenant-isolation model, vendor-risk + access registers, CSP rollout plan.
- `docs/finance/` — **(Wave 1)** pilot invoice-review template for the first multi-location accounts (`accounts.flags.is_pilot`).
- `docs/legal/` — legal source docs + external-gate status (`legal-review.md`, `insurance.md`); rendered pages come from `src/lib/legal/content.ts`, not these.
- `public/.well-known/security.txt` — **(Wave 1)** RFC 9116 disclosure pointer (contact `security@repworth.net`, links to `/security`).
- `src/app/fonts/` — the seven self-hosted `.woff2` files (six families; Fraunces has a second file for italic), loaded by `next/font/local` from `src/app/layout.tsx` and `src/app/(authenticated)/layout.tsx`. NOT a general asset dump — `next/font/google` is banned by `ci:static-policy` because Turbopack resolves it with a compile-time CDN fetch whose intermittent failure broke E2E and Vercel builds on unrelated commits. Provenance, the latin-only coverage limitation, and the refresh procedure are in `src/app/fonts/README.md`.
- `docs/superpowers/` — historical specs + plans for every feature, dated. The plan file at the head of each branch is the spec of record for that feature.
- `tests/` and per-module `__tests__/` directories — Vitest unit + integration tests; the WS6 LLM-eval lane and contract-test inventory are detailed above, and Playwright E2E lives in `tests/e2e/`.
