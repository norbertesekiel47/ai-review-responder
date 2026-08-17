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

- `sections/landing/**` — the landing page, rewritten 2026-08 (replacing the #436 scroll-morph stage). `LandingExperience.tsx` is a composition root owning only the chrome — nav, the single `<main id="main-content">` landmark, the footer — plus a numbered section map; each narrative section is its own module under `sections/landing/<section>/` with colocated CSS and a `*-copy.ts` carrying its shipped-vs-roadmap accuracy contract. Shared: `agent-flip-card.tsx` (sections 3–4), `reveal.tsx` (the one arrival motion — opacity, ≤200ms), `ambient-motion.tsx` (the WCAG 2.2.2 pause control, rendered in the footer's bottom bar, plus the `AmbientVideo` that every looping background clip must use so none can escape it). The page scrolls natively since the 2026-08-16 Linear pass — the former `scroll/` folder (Lenis smooth scroll + snap, chapter rail, chapter markers, section transitions) was deleted. **This page is deliberately unlocked from the Island system** — read its Style Reference [`docs/design/landing/DESIGN.md`](./design/landing/DESIGN.md) and its engineering companion [`docs/design/landing/measurements.md`](./design/landing/measurements.md) before changing anything in it; most of the values in that folder are measurements with a documented failure mode, not preferences.
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

The console migration (spec `docs/superpowers/specs/2026-07-30-admin-console-redesign-design.md`)
landed the same shape on every page: `page.tsx` is a **server component** —
`requireAdminPage(sql, {from, aal2?})` gate → read via the owning
`src/lib/admin/*` service → `<AdminPage>` chrome → client island seeded with
that read as react-query `initialData`. Phase 3 finished the set and moved
`<AdminPage>` out of the five Phase 2 clients onto their server pages, so page
chrome renders in the RSC payload rather than behind a loading state. `PAGE_SIZE`
is declared once, in the client, and imported by the server page.

> **`ci:admin-aal2` — the AAL2 gate audit** (moved here from the CLAUDE.md
> channel-routes row on 2026-08-16). It is an **AST** audit: it resolves each
> exported mutation handler (`POST`/`PUT`/`PATCH`/`DELETE`) separately —
> following `withSameOrigin()(inner)` to `inner` — and requires a gate reachable
> from THAT handler, either a CALL to `requireAdminWithAal2` or a
> `resolveAdminActor` binding, each credited only when imported from its
> canonical module. So a gated `GET` no longer clears an ungated `POST`, an
> unused import earns nothing, and a comment or string naming a resolver is
> invisible. It is **fail-closed** — an unrecognized gate shape is a finding —
> which is what closes the renaming re-export (`export { resolveOwnerActor as
> … }` in a second file) without cross-file resolution; the old "an aliased
> import would still clear it" was wrong anyway, since a same-file alias leaves
> the literal `resolveOwnerActor` and trips the deny rule. It also covers
> `src/app/admin/**/page.tsx`: every admin page must call a gate (pre-auth
> exemptions derived from `src/proxy.ts`), and a page whose sibling route gates
> `GET` with `requireAdminWithAal2` must pass `{ aal2: true }` — **read-gate
> parity**, because the page reads the DB directly and is otherwise a parallel
> path around the route's step-up. Deliberately NOT "a page rendering a mutation
> surface needs AAL2" (`/admin/businesses/[id]` correctly hosts AAL2-gated
> mutations while gating plain).

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

> **Channel-route rules the code does not make obvious** (moved here from the
> CLAUDE.md routing row on 2026-08-16; `CONTEXT.md` → **Channel actor** + spec
> `docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md` §4 —
> PR 2 of 3; the spec is fully shipped: §3/PR 1 as #827, §4/PR 2 as #831,
> §5/PR 3 as #833). The 12 routes
> (`{admin,dashboard}/channels/{telegram,whatsapp}/{start,cancel,disable}`) are
> thin shims — name a channel, bind a resolver, call a runner
> (`start.ts`/`action.ts` here); put behaviour in the runner or the resolver,
> never back in a route. `resolve-actor.ts` holds the two portal resolvers,
> which must stay TWO functions: `resolveAdminActor` reads `businessId` from the
> request BODY behind `requireAdminWithAal2`, `resolveOwnerActor` reads
> `locationId` from the SESSION behind `requireRoleOr401` and never from the
> body — that asymmetry is a tenant-isolation boundary, and each resolver also
> owns its portal's subscription gate (admin `start` requires full access; admin
> `cancel`/`disable` deliberately require none; owner applies
> `resolveWritableAccountForLocation` on all three). `ChannelRouteConfig` is 4
> fields on purpose — **a fifth means the seam is wrong; re-plan rather than
> widen**. Deep links have ONE owner
> (`src/lib/notifications/channels/deep-links.ts`), as do the flag/env modules
> beside it (they are read by a server-component page, which is why they are in
> `src/lib` and not under `api/`). **The admin MFA gate is now configuration, not
> structure** — the runners call `config.resolveActor`, so `tsc` cannot reject a
> mis-binding and `ci:admin-aal2` is the compensating check (its mechanics: the
> `### admin/` section of `src/app/` above).

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
| `business/route.ts` | POST: persists step-by-step business profile data from the 3-step wizard (`/onboarding/business`). Validates step input via `shared/schemas.ts` and updates the existing `businesses` row created at signup. |
| `select-plan/route.ts` | POST: validates the owner's explicit Copilot/Autopilot selection, persists the complete tier/variant snapshot under billing serialization, and returns a Stripe Checkout Session URL. No tier default or Payment Link remains. |

#### `signup/place-prefill/route.ts`

GET: hits SerpAPI for a Place ID during the onboarding location step to prefill business name, address, and category. **(2026-08-14)** No longer gated by `SELF_SERVE_SIGNUP_ENABLED` — the flag now means only "strangers may mint accounts", and this endpoint is reached by admin-invited owners with the flag off. Because removing the gate from an otherwise-**unauthenticated**, SerpAPI-billed endpoint would have made it permanently public, it gained a real boundary in the same change: authenticated session + `role = 'owner'` + a pre-activation account state, plus a new per-auth-id 10/min strict limit alongside the existing strict per-IP one (75/day global unchanged).

#### `zernio/connect/`

Handles the Zernio OAuth connect flow for GBP auto-posting. All routes gated by `ZERNIO_PUBLISHING_ENABLED`.

| Route | What it does |
|-------|--------------|
| `start/route.ts` | Initiates the Zernio OAuth flow; creates a Zernio profile, sets a signed connect-session cookie, and redirects the owner to Zernio. |
| `callback/route.ts` | Receives the OAuth callback from Zernio: claims the single-use connect state (Redis GETDEL), calls `zernioClient.listLocations` (ADR 0001 sanctioned sync call), stashes the locations in Redis for 15 min, sets the signed connect-session cookie and 302s to `select-location`. Writes NO DB row — `zernio_connections` first exists inside `finalizeConnectionTx`. |
| `select-location/route.ts` | POST: finalises the connection — `zernioClient.selectLocation` → `accountId`, then `finalizeConnectionTx` (one `sql.begin`: `zernio_connections` upsert to `active`, `drain_pending_owner_connect` outbox row, `gbp_connected` analytics event, and — only on `import_decision='accepted'` — `enqueueInitialImport`). |
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

| File | What it does |
|------|--------------|
| `seo.ts` | `noindexRobots` — the shared Next `Metadata['robots']` value (`index: false, follow: false`) for auth/account surfaces that must never be crawled or cached (login, signup, password reset, MFA). Single owner so the directive cannot drift across the ~7 pages that need it (launch audit #19). |
| `client-response.ts` | Browser-fetch JSON helpers. `readJsonObject(response)` best-effort decodes a body into a `JsonObject` and returns `{}` when the content-type is not JSON, the body is not an object, or parsing throws (proxy/upstream error pages are often HTML or empty). `apiErrorMessage(body, fallback, status?)` picks `detail`, then `error`, then the fallback (suffixed with the status when given). |

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
| `auth.ts` | `requireRole(req, role)` — throws `AuthError` if the session lacks the required role. |
| `redis-cache.ts` | `getCacheRedis()` — Redis client for application caching (separate Redis instance from BullMQ); `withTtlCache()` owns fail-open JSON read/compute/`EX` write mechanics while callers provide their log source and TTL policy. |
| `account-guard.ts` | Account-level subscription guard — workers and SSR routes check entitlement here, never `businesses.subscription_status` (deprecated, VAL-SCHEMA-036). `isAccountActive(sql, accountId)` reads `accounts.subscription_status` through `subscriptionGrantsFullAccess` and returns `{active}` or `{active:false, reason}`. `getLocationContext` / `getLocationContextForAccount` return the joined account+location context; archived locations read as missing, and a cross-account mismatch returns `{kind:'account_mismatch', owningAccountId}` (VAL-LOC-077). |
| `transient-error.ts` | The db-infra transient-error vocabulary, kept orthogonal to the Stripe network-code set in `payments/stripe-error-inspect.ts`. `isTransientPostgresError(err)` matches postgres.js connection-lifecycle codes, `57014`/`57P01–03` and any SQLSTATE class-08 code by `err.code` (code-less errors are never transient) — `UpdateStripeOverageWorker` retries on it. `isCrashNetRecoverableDbError(err)` is the strictly narrower explicit allowlist the `worker/index.ts` crash-net may survive (no `08000`/`08007`/`08P01`, no prefix match). |

### `config/`

The three env-config lanes (client / server / worker) plus their shared Zod helpers, the deployment-lane reader, and the single sanctioned boolean-flag reader.

| File | What it does |
|------|--------------|
| `client.ts` | CLIENT lane — Zod schema of the build-inlined `NEXT_PUBLIC_*` vars (Supabase URL/anon key and app URL required; Maps key, Sentry DSN, docs URL optional). `getClientConfig()` is a lazy memoized parse; `assertClientConfig()` throws naming the missing vars and runs in the prebuild step; `CLIENT_REQUIRED_VARS` is the declared list. |
| `deployment-lane.ts` | The authoritative "which deployment lane is this?" reader — `NODE_ENV` cannot answer it (staging sets `NODE_ENV=production`, production leaves it unset — #610/#611). `deploymentLane()` resolves by PRECEDENCE (`RAILWAY_ENVIRONMENT_NAME`, then `NODE_ENV`, else `development`); `requiresProductionConfig()` is the UNION (any Railway lane OR `NODE_ENV=production`) — two rules, never collapse them; `deploymentLaneFields()` adds `lane_source` for logs. Rationale: ADR 0013. |
| `dotenv-load.ts` | `ensureWorkerDotenvLoaded()` — idempotent `.env.local` loader for the worker config lane, called by `config/worker.ts` before its first parse so a worker module imported outside `worker/index.ts` (unit test, one-off script) does not parse an empty env. No-op when the file is missing. |
| `flags.ts` | The single sanctioned env reader for boolean `*_ENABLED`/`*_DISABLED` flags, runtime-agnostic and deliberately NOT routed through `getServerConfig`/`getWorkerConfig`: `readFlag(name)` (true iff the literal `'true'`), `readFlagEnabledByDefault(name)` (default-ON kill switches such as `LLM_CIRCUIT_BREAKER_ENABLED`), and `isPreviewEnvironment()` (`VERCEL_TARGET_ENV === 'preview'`, not `VERCEL_ENV`). Not memoized. Invariant #13. |
| `schema-helpers.ts` | Shared Zod field builders so all three lanes treat presence identically: `requiredVar` (non-empty after trim), `optionalVar` (empty/whitespace collapses to undefined), `rawOptionalVar` (faithful `process.env.X` passthrough for MIGRATED reads — convention #7), plus `requirePresentIn(snapshot, vars, subsystem)` / `requirePresent(vars, subsystem)` — the "required-ness at the accessor" throw. |
| `server.ts` | SERVER lane — Next.js server-process env. The root Zod schema is SHAPE-ONLY (every field optional) so `getServerConfig()` (lazy, memoized) never throws in a UI-only preview or from worker-run shared code; required-ness lives in `assertCoreAppConfig()` (the three `NEXT_PUBLIC_*` core vars, static refs) and the per-subsystem accessors (`getServerDbConfig`, `getStripeConfig`, `getResendConfig`, `getSerpapiConfig`, `getOpenAiConfig`, `getGoogleMapsConfig`). `resetServerConfigForTests()` clears the memo. |
| `stripe-shape.ts` | Shared Stripe env shape for both lanes: `STRIPE_REQUIRED_VARS` (secret key, webhook secret, the `STRIPE_PRICE_ENV_VARS` price IDs), the `StripeEnvConfig` type, and `narrowStripeConfig(env, subsystem)` — asserts presence via `requirePresentIn` against the same snapshot it narrows, so `server.ts` and `worker.ts` do not each duplicate the list. |
| `worker.ts` | WORKER lane — Railway worker-process env. `getWorkerConfig()` self-loads `.env.local` (`ensureWorkerDotenvLoaded`) then lazily parses a shape-only schema (`DATABASE_POOL_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `REDIS_QUEUE_URL` required; subsystem secrets optional). `assertWorkerConfig()` mirrors `startup-assert.ts`'s core-infra list, skipping only in mock mode on a non-production lane; per-subsystem `assertWorker*Config`/`getWorker*Config` (Stripe, Resend, SerpAPI, OpenAI, Anthropic); `resetWorkerConfigForTests()`. |


### `dashboard/`

Dashboard query layer.

| File | What it does |
|------|--------------|
| `service.ts` | `getActiveDashboardData(sql, businessId, opts?)` — queries reviews, responses, weekly metrics, and Zernio connection state. Returns `DashboardDataActive`. Used by `GET /api/dashboard`. |
| `types.ts` | `DashboardData` discriminated union (`DashboardDataActive | DashboardDataPendingPayment | ...`), `ZernioConnectionState`. |
| `active-mappers.ts` | Row→DTO mappers for the per-location payload: `mapReviewVelocity`, `mapRecentReviews`, and `toIsoWeekStart`, which normalizes a Postgres `date` week bucket to an ISO `YYYY-MM-DD` key so a week series re-sorted in JS orders correctly **(#791)**. Shared by `service.ts` and `aggregate-queries.ts`. |
| `aggregate-queries.ts` | `fetchPerLocationAggregateSlices(sql, accountId, window)` — the set-based per-account wave: a fixed number of `GROUP BY business_id` queries (independent of location count), run sequentially via `settledInOrder` **(#505)** and fed through the same per-location mappers `service.ts` uses. The baseline read is fatal; every other read degrades per-widget via `widgetOrFallback`. Composed by `aggregate-service.ts`. |
| `aggregate-service.ts` | `getAggregateDashboardData(sql, accountId, window)` — builds `AggregateDashboardData` for the All-Locations view (`/api/dashboard?scope=all`): fetches active locations, runs `fetchPerLocationAggregateSlices`, sums across locations, and builds the per-location KPI/velocity/ranking/review/brief breakdowns. Replaced the per-location fan-out **(#476)**; payload cached 45s via `withTtlCache`; the locations-list read is fatal, the billing read degrades. |
| `constants.ts` | `MINUTES_SAVED_PER_RESPONSE = 7` — the single "time saved" heuristic; both the lifetime figure (`buildValueSummary`) and the windowed reputation-summary figure derive from it so they cannot drift. |
| `pending-count.ts` | `getPendingApprovalCount(sql, businessId)` and its set-based sibling `getPendingApprovalCountsForAccount(sql, accountId)` — the single authoritative count of owner drafts awaiting approval (`pending_approval` with no open `flagged_responses` row). Feeds `reputationSummary.pendingApprovalCount`, the layout's `PendingCountProvider` seed, and the aggregate wave. |
| `rating-breakdown.ts` | Single owner of the 1–5★ bucketing shape **(#405)**: `buildRatingBreakdown(rows)` from `GROUP BY star_rating` rows (zero-fill, 5★→1★ order, total, out-of-range stars dropped) and `sumRatingBreakdowns(breakdowns)` for the account-wide rollup. |
| `reputation-summary.ts` | Pure mapper `buildReputationSummary(input)` from windowed SQL rows to `ReputationSummary` — average star, response rate, and time saved with current/prior deltas, sentiment trend as star-equivalents, `pendingApprovalCount`, `isRamping`. No DB; exports the row types and `RAMPING_AGE_DAYS` (21). The SQL that produces the rows lives in `service.ts`. |
| `scope.ts` | Payload narrowing for the cached `/api/dashboard` response: the `DashboardPayload` union, `isAggregate`, `perLocationActive` (active or `past_due` only), and `authoritativePendingCount` — derived from SQL-backed fields, never the capped `recentReviews` slice (#346). |
| `service-mappers.ts` | Row→`DashboardDataActive` builders: `buildValueSummary`, `buildRanking`, `selectLatestBrief`, `parsePendingFlow` (validates the `connect_pending` marker against `CONNECT_PENDING_STATUSES`), `buildDashboardSettings`, and `buildActiveDashboardResponse`, plus the `DashboardBusinessRow` / `DashboardRankingRow` / `DashboardBriefRow` / `DashboardZernioConnectionRow` row types. Used by `service.ts` and `aggregate-queries.ts`. |
| `zernio-banner.ts` | `resolveZernioConnectionState(input)` — the Zernio banner precedence: unresolved finalize incident or `finalize_unknown` marker → `finalize_unknown`; `active` connection beats stale pending markers; then `pending`; then the connection status; else `none`. Returns `DashboardDataActive['zernioConnection']`. |

### `locations/`

Location (= `businesses` row) lifecycle and read helpers for the multi-location subsystem — add / archive / reactivate / promote transactions, the location repo, and the shared owner-route preamble. Files cite the `VAL-LOC-*` validation contract; DB-touching modules take `sql`/`tx` as an explicit parameter (invariant #15).

| File | What it does |
|------|--------------|
| `add-location-tx.ts` | `addLocationTransaction(sql, input)` — atomic add in one `sql.begin()`: lifecycle advisory lock, offboarding gate, `businesses` INSERT (`is_primary = FALSE`, voice config cloned from the primary unless the wizard overrides it), Import consent inherited from an archived sibling **(#677)**, `location_created` audit row, then `enqueueValidatePlaceId` / `enqueueStripeOverageRecompute`. Maps 23505 to `duplicate_location`. |
| `archive-location-tx.ts` | Archive lifecycle: `assertCanArchiveLocation` (not found / not owned / already archived / `last_active_location` / `promote_first`), `archiveLocationTransaction` (UPDATE + `location_archived` audit + Stripe overage decrement in one tx), `archiveLocationForAccountOffboardingTeardownTransaction`, and `reactivateLocationTransaction` — owner-reachable, consent-gated backfill enqueue **(#677)**, self-promotes to primary on a zero-primary account. |
| `display-label.ts` | Client-safe `getDisplayLabel(location)` — the canonical `display_label ?? name` fallback every surface (switcher, notifications, approval chips, dashboard) must use, plus the `HasDisplayLabel` / `HasDisplayLabelCamelCase` shapes. The server-side writer lives in `update-display-label.ts`. |
| `duplicate-location.ts` | Single owner of the active-duplicate `google_place_id` predicate (migration 062's `businesses_account_place_uniq`): `isDuplicateLocationViolation`, `rethrowAsDuplicateLocation` (23505 → the typed `DUPLICATE_LOCATION` error the routes map to 409), and `ownerFacingLocationError` (denial code → owner copy). |
| `flags.ts` | `multiLocationEnabled()` — the single `MULTI_LOCATION_ENABLED` accessor over `readFlag`. Server-authoritative (invariant #13). |
| `multi-location-mode.ts` | The three DISTINCT multi-location checks named in invariant #9b: `shouldUseMultiLocationSettings` (mode: flag AND active count > 1), `shouldShowLocationsSettings` (visibility: flag only), `canAddLocationForAccount` (eligibility: flag + `subscriptionGrantsFullAccess` + tier `multiLocAllowed`); plus `resolveAddLocationState` → `'enabled' \| 'inactive'` for the Locations settings page. |
| `owner-route.ts` | Shared preamble for the owner location routes: `readOwnerForMultiLocationRoute` (flag → same-origin → `requireRole('owner')` → account → writable-subscription gate), `readLocationActionRequest` (adds body parse and `accountId` match), `readLocationRouteJson`, and `LOCATION_DENIAL_STATUS` / `locationDenialResponse` — the single denial-code → HTTP-status map for archive / promote-primary / reactivate. |
| `promote-primary-tx.ts` | `promotePrimaryTransaction(sql, input)` — canonical owner of the one-primary invariant: under the lifecycle lock, demotes the current primary (tolerating 0 rows so a zero-primary account can be repaired), promotes the new one, and writes a `primary_promoted` audit row. Throws `LOCATION_DENIAL_STATUS` code strings. |
| `repo.ts` | Data access for location (`businesses`) reads: `getActiveLocationCount`, `getLocationsForAccount` (active, primary first), `getArchivedLocationsForAccount`, `getAllLocationsForAccount`, `getLocationById` (does not filter archived); `LocationRow` type. All location SQL goes through here — no ad-hoc queries elsewhere. |
| `settings-view.ts` | `loadLocationsSettingsView(sql, accountId)` — data loader for the owner Settings → Locations tab (active + archived entries, Zernio status, per-location pending-approval counts, validated WS8 tier/status). Queries run SEQUENTIALLY on the pool-3 `sql` singleton — do not reintroduce `Promise.all` **(#505)**. Invariant #15 domain module. |
| `update-display-label.ts` | Server-side `updateDisplayLabel(sql, locationId, accountId, newLabel, actorUserId?)` — account-scoped UPDATE of `businesses.display_label` plus a `display_label_updated` audit row in one tx. Kept out of `display-label.ts` so that module stays client-safe. |

### `accounts/`

Billing-parent (`accounts` row) modules — tier vocabulary, stored billing snapshot, quota, advisory locks, and tier change (invariant #9: `accounts` = billing parent, `businesses` = location; existing-account billing reads use the STORED snapshot columns, never live `TIER_CONFIG`).

| File | What it does |
|------|--------------|
| `billing-locks.ts` | Account-scoped `pg_advisory_xact_lock` helpers with a fixed acquisition order: `acquireTierEntitlementLock`, `acquireBillingLock` (overage sync), `acquireLocationLifecycleLock` (add/archive/reactivate/promote — taken before any business-row lock, kept separate from entitlement to avoid the account→business→entitlement→account deadlock), `acquireTierAndBillingLocks`, and `acquireTierBillingActivationLocks` (signup activation adds the legacy activation lock last). |
| `quota.ts` | `computeOverageQuantity(count, included)`; `currentBillingSnapshot(sql, accountId)` — `BillingSnapshot` from the STORED `base_price_cents` / `locations_included` / `locations_overage_price_cents` (point-in-time, grandfathered per invariant #9a) plus the active-location count; `assertCanAddLocation(sql, accountId)` — the single chokepoint for add-location quota checks (full-access status, tier `multiLocAllowed`, overage preview; no hard cap). |
| `repo.ts` | Data access for `accounts` reads: `getAccountById` (`AccountRow`), `getAccountOwnerUserId`, `getAccountOwnerUser` (joins `users` for id/name/email). All account SQL goes through here — no ad-hoc queries elsewhere. |
| `tier-change.ts` | Tier-change preview and execution. `validateTierChange(sql, accountId, newTier)` returns a `TierChangeValidation` with a `BillingSnapshot` preview; `applyTierChange(sql, input)` revalidates under `acquireTierAndBillingLocks`, mutates the Stripe base + overage items keyed by `operationKey`, writes the snapshot via `writeResolvedTierSnapshot`, audits, then runs `synchronizeBusinessTierMirror` after commit. Returns `TierChangeOutcome`. |
| `tier-config.ts` | Single owner of the tier vocabulary: `SubscriptionTier` (`copilot` / `autopilot`), `SubscriptionTierValue`, `PriceVariant` (`list` / `founding`), `isSubscriptionTier`, `isPriceVariant`, `tierGrantsAutopilot` (the only autopilot-entitlement predicate — distinct from purchasability), `TIER_CONFIG` (base by variant, included, overage cents, `multiLocAllowed`), `resolveTierSnapshot` (write-time only; existing accounts read their stored snapshot), `getTierConfig`, `lookupTierConfig`. |
| `tier-snapshot.ts` | `writeTierSnapshot` / `writeResolvedTierSnapshot(tx, input)` — the complete point-in-time `accounts` billing snapshot writer (tier, base, overage, included, `locations_paid`), change-only via `ROW(...) IS DISTINCT FROM`, with `writeAccountAuditLog` on change; `synchronizeBusinessTierMirror(sql, accountId)` converges the deprecated `businesses.subscription_tier` mirror in a separate tx after commit (locks businesses before entitlement to avoid the publisher deadlock). |



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
| `activation-event.ts` | `buildActivationCompletedEvent(input)` — single owner of the activation rule and the `activation_completed` event shape: returns the `CaptureAnalyticsEventInput` for an account's first posted response, or `null` when `postedAt − accountCreatedAt` falls outside 0–7 days. Both the live publisher path and the historical backfill call it; the caller decides "is-first" in SQL and sets `timestamp`; `uuid = responseId` lets PostHog dedupe re-emits. |
| `trial-events.ts` | Durable server-side trial lifecycle facts — `enqueueTrialStarted` / `enqueueTrialConverted` / `enqueueTrialPaymentFailed` / `enqueueTrialCancelled(db, input)` call `enqueueAnalyticsEvent` in the SAME transaction as the subscription-status projection write. Deterministic keys make replays idempotent: `trial_started` is keyed by `accountId` alone; the other three by `(accountId, stripeSubscriptionId)` so a re-trial on a new subscription emits a fresh fact. |

### `audit/`

Account audit-log writer.

| File | What it does |
|------|--------------|
| `log.ts` | `writeAccountAuditLog(db, input)` — the ONLY sanctioned writer of `account_audit_log` (never a raw `INSERT`). Inserts a UUIDv7 row with `account_id`, `event_type`, a JSON `payload` and optional location/actor/entity/ip/user-agent/request-id columns. Accepts the base `Sql` client (standalone best-effort writes, e.g. the MFA challenge route) or a `TransactionSql` — account-status writes must use the SAME transaction as the state change. |

### `competitors/`

Competitor Delta (Named rival) resolution for the weekly digest and the owner-facing rival picker.

| File | What it does |
|------|--------------|
| `named-rival.ts` | Single owner of Competitor Delta resolution **(#546; map #528, semantics #532)**. `resolveNamedRival(db, businessId)` reads the primary-keyword local-pack lane in ONE statement (RankingTrackingWorker replaces packs wholesale) and returns a `CompetitorDelta` (`teaser`/`rival`/`dropout`/`null`) from the Auto-default rival or the owner's stored pick. `loadRivalPickerView(s)` load picker state; `setNamedRivalPick` stores/clears the pick in a tx and enqueues `competitor_rival_picked` (retry-safe key). Roots: WeeklySummaryWorker, settings route. |

### `google/`

Google Sheets service-account append for owner leads.

| File | What it does |
|------|--------------|
| `owner-leads-sheet.ts` | `appendOwnerLeadToSheet(row)` — appends an `OwnerLeadSheetRow` to the owner-leads Google Sheet using a service-account JWT (RS256 via `createSign`, exchanged at the OAuth token endpoint). No-op when `OWNER_LEADS_GOOGLE_SHEET_ID` is unset; throws when only partially configured (`GOOGLE_SHEETS_CLIENT_EMAIL` / `GOOGLE_SHEETS_PRIVATE_KEY`); range defaults to `Sheet1!A:K`. Both fetches carry a 5s `AbortSignal.timeout` because it runs on the user-facing `/api/lead-intake` path, whose caller try/catches this enrichment. |

### `ranking/`

Ranking-tracking feature flag.

| File | What it does |
|------|--------------|
| `flags.ts` | `rankingTrackingEnabled()` — single owner of the `RANKING_TRACKING_ENABLED` flag (the recurring paid SerpAPI ranking-tracking scheduler), a one-line wrapper over `readFlag` in the `<feature>/flags.ts` convention. Server-authoritative (invariant #13) — no `NEXT_PUBLIC_*` companion; the browser learns the state via API responses/props. |





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
| `backlog-depth.ts` | Single owner of dispatch-queue "backlog depth" — `queryBacklogDepth(sql)` counts TOTAL `status='pending'` rows in `job_outbox` and `analytics_events` (`BACKLOG_DEPTH_TABLES`) in one round-trip inside a transaction with `SET LOCAL statement_timeout = 4000`, so Postgres itself cancels a slow count and frees the pooled connection. Shared by the internal queue-health endpoint and `HealthAlertPoller`; takes `sql` as a parameter (invariant #15). |
| `dashboard-regen-rate-limit.ts` | The per-owner regenerate limiter shared by both authenticated "regenerate an AI draft" entrypoints. `enforceDashboardRegenRateLimit(accountId)` — two fixed-window layers on distinct Redis keys (10/60s burst, raised at #672; 30/hour spend bound), returning a 429 `rate_limited` or null; `enforceRegenBudgetForReview(reviewId)` — read-only `peekRegenBudgetBatch`, 429 `regen_limit_reached` when the per-review daily cap is used (#335). Both FAIL OPEN; the worker's cost reserve is the authoritative gate. |
| `ids.ts` | Branded ID types — `AccountId` (an `accounts` row), `LocationId` (a `businesses` row) and the backward-compatible alias `BusinessId = LocationId` — so a bare string or the wrong ID cannot be passed where the other is expected. Casts `asAccountId`/`asLocationId`/`asBusinessId` and `isValidUuid()` (v4-shaped check). |
| `job-outbox-status.ts` | Canonical `job_outbox.status` vocabulary, standalone (no postgres import) so `ci:outbox-status` can import it: `OUTBOX_IN_FLIGHT_STATUSES = ['pending','dispatching','dispatched']` — a byte-for-byte contract call sites re-spell by hand because a bind parameter defeats `ON CONFLICT … WHERE` partial-index inference; `classifyOutboxStatus()` (`in_flight`/`completed`/`terminal`); `OUTBOX_DISTINCTIVE_STATUSES` (`dispatching`, `dispatched` — never `pending`, which other tables share). |
| `log-context.ts` | Per-request / per-job log context via `AsyncLocalStorage`: the `LogContext` shape (`request_id`, `correlation_id`, `account_id`, `business_id`, `review_id`, `response_id`, `worker_job_id`, `outbox_id`), `withLogContext(context, fn)` (child keys win, empty values stripped), `getLogContext()`, `mergeLogContext()` (adds IDs to the current scope) and `createRequestId()`. |
| `pool-wait.ts` | Single owner of the shared-pool "pool-wait" saturation probe: `probePoolWait(sql, {timeoutMs, saturatingThresholdMs, max})` times `sql.reserve()` and releases immediately, single-flighted so repeated hits share ONE outstanding reservation. Returns `{waitMs, timedOut, saturating, max}` (a timeout is a censored lower bound). Since #773 `waitMs` includes admission-gate wait. Defaults `DEFAULT_POOL_WAIT_TIMEOUT_MS` 1000 / `DEFAULT_POOL_SATURATING_MS` 50 (ADR 0009). |
| `primary-tracked-keyword-sql.ts` | `primaryTrackedKeywordSql(exec)` — single owner of "which tracked keyword is this location's primary": a Postgres.js fragment (alias pinned to `b`) returning the first `tracked_keywords` element that is a non-blank JSON string, untrimmed, else NULL. SQL rather than TS because all four readers need it resolved inside their statement. **(#572)** fixed the `->>0` vs tracker-filter divergence that silently dropped digest lines. |
| `readiness.ts` | `runReadinessProbes(probes, timeoutMs?)` — runs each `DependencyProbe` (`{name, probe}`) under `withTimeout` (default 2s), mapping any rejection or synchronous throw to `'failed'`, and returns `{ready, checks}`. Backs the readiness endpoints (Postgres reachable, Redis PING) that return 503; `/api/health` stays liveness-only. |
| `report-caught-error.ts` | `reportCaughtError(endpoint, err, context?)` — for errors a handler caught and HANDLED: Next's `onRequestError` forwards only uncaught route errors to Sentry, so this calls `captureException` (tagged `endpoint`) and emits one structured log line carrying only the error name/message. Works in web and worker (same `@sentry/node` instance); Node runtime only, never edge middleware. |
| `request-path-header.ts` | Two constants: `REQUEST_PATHNAME_HEADER` (`x-repworth-pathname`) and `ACCOUNT_OFFBOARDING_STATUS_PATH` (`/account/offboarding/status`). |
| `response-status-sql.ts` | `statusArraySql(db, statuses)` — binds a response-status group as a `text[]` fragment for `status = ANY(...)` read predicates, reproducing the `${[...] as string[]}::text[]` convention (never an `IN (...)` list). Takes the caller's `sql`/`tx` explicitly so `response-status.ts` stays a zero-dependency pure module. |
| `sentry-scrub.ts` | The Sentry / ingress-log scrubber. `scrubSentryEvent(event, {scrubRequestData})` is the `beforeSend` for both Sentry inits — key-based redaction of `extra`/headers/data plus URL scrubbing of `transaction`, breadcrumbs, exception messages and `message`. `redactSensitivePathsAndQueries(url)` masks `/approve/<token>`, unsubscribe token paths (#644, invariant #5) and sensitive query values; `redactSensitiveTokenPaths(text)` is the PROSE-safe path-only half for the Fastify pino censor. Both pure and total. |
| `session-cookie-secret.ts` | `getSessionCookieSecret()` — single authoritative reader of `SESSION_COOKIE_SECRET` (via `getServerConfig()`) for every HMAC consumer (approval device cookies, Zernio connect cookies, offboarding keep-my-data tokens, destructive fresh-auth); throws if unset or shorter than 32 bytes. |
| `settled-in-order.ts` | `settledInOrder(thunks)` — sequential analog of `Promise.allSettled` returning the same per-member tuple of settled results. Exists because a concurrent wave wider than a postgres.js pool pipelines onto busy connections and, over the Supavisor transaction pooler, wedges them permanently (`ClientRead`); members are thunks so nothing starts early. **(#505)**; ADRs 0008/0009. |
| `subscription-status.ts` | `SubscriptionStatus` const enum (`pending_payment`, `active`, `trialing`, `past_due`, `cancelled`) matching `accounts.subscription_status`, `SubscriptionStatusValue`, `isSubscriptionStatus()`, and the entitlement predicates `subscriptionGrantsFullAccess()` (single owner of "`trialing` is treated like `active`"; `past_due` is NOT full access) and `subscriptionAllowsDashboardRead()` (full access plus `past_due`). Never use bare status literals. |
| `unique-sibling-key.ts` | `uniqueSiblingKey(seen, base)` — returns `"<occurrence>:<base>"`, incrementing a per-base counter in the caller's `Map`, so repeated sibling values get distinct keys. |
| `with-timeout.ts` | `withTimeout(work, ms, label?)` races a promise against a timer and rejects with `TimeoutError`; the timer is always cleared. A timeout does NOT cancel `work` — callers holding a lock or claimed row must plan for it settling later. Used by the readiness probes and the OutboxPoller dispatch loop. |
| `worker-public-url.ts` | `getWorkerPublicUrl()` — single authoritative reader of `WORKER_PUBLIC_URL` (via `getServerConfig()`), normalized to the URL origin (no path, query, fragment, trailing slash or userinfo) so callers can append a path safely (Twilio signature verification, status callbacks). Throws if unset. |

### `auth/`

| File | What it does |
|------|--------------|
| `route-helpers.ts` | Route wrappers for rate limiting, same-origin checks, and Supabase session reads. |
| `mfa.ts` | **(Wave 2)** Supabase AAL helper functions used by proxy and sensitive routes. |
| `require-owner-access.ts` | Server-component guard for owner-only pages. Resolves auth user → `users` row → validates role + subscription_status; redirects on failure. Returns `{ authId, businessId, email }` when all checks pass. |
| `page-gate.ts` | **(Phase 2)** `requireAdminPage(sql, {from, aal2})` — server-component admin gate. Resolves auth user → `users` row → admin role, optional AAL2 step-up; redirects to login/MFA-challenge on failure (fail-closed even if the AAL2 check itself throws). Defense-in-depth behind `src/proxy.ts`'s `/admin` gate; every migrated admin `page.tsx` calls it. |
| `admin-mfa-gate.ts` | `requireAdminWithAal2(request)` — the admin control-plane preamble: `requireRole('admin')` then AAL2 step-up via `requireCurrentAal2FromSupabase` on a cookie-backed client; returns `{ ok, admin }` or a no-store JSON response (AuthError status / 403 `mfa_required`|`mfa_check_failed` / 500 `internal_error`). CSRF is deliberately NOT here — routes wrap with `withSameOrigin()`. Also `internalError(label, err)`, the shared 500 shape for admin mutation routes. Credited by `ci:admin-aal2`. |
| `flags.ts` | `selfServeSignupEnabled()` — `SELF_SERVE_SIGNUP_ENABLED` over `readFlag`; means exactly "strangers may mint accounts" (gates `/signup`, the signup/finish-signup/resend-confirmation/verify-otp routes, `isTrialEligible`, marketing CTA copy — NOT `/login`, `/forgot-password`, `/reset-password` or the authenticated onboarding funnel; per-site inventory in `docs/superpowers/plans/2026-08-14-admin-invite-funnel-flag-inventory.md`). Plus `mfaEnforcementEnabled()` (`MFA_ENFORCEMENT_ENABLED`, proxy gate). Invariant #13. |
| `get-request-scope.ts` | `getRequestScope(sql, accountId, cookieLocationId)` — SSR scope resolution: loads the account's `businesses` (primary first), validates the `rw_location_scope` cookie value belongs to the account and is not archived, else falls back to the primary (or first active) location; throws when the account has no active location. Returns `{ accountId, currentLocationId, activeLocations }` so the authenticated layout need not re-query the location list. |
| `provision-auth-user.ts` | `provisionAuthUser(sql, supabase, { ownerEmail, password, emailRedirectTo })` — self-serve signup identity provisioning extracted from `POST /api/auth/signup`: advisory-locked `users.email` pre-check → `supabase.auth.signUp` → `auth.users` timestamp recovery for the hosted `{error:null,user:null}` shape → anti-enumeration disambiguation of `identities: []` via `admin.getUserById` → `account_exists` vs `email_rate_limited` triage. `deleteProvisionedAuthUser` is the compensating cleanup when business creation fails. |
| `reset-password-error.ts` | `mapUpdateUserError(error)` — pure mapper from a Supabase `auth.updateUser` failure to the response `POST /api/auth/reset-password` returns: `insufficient_aal` → 403 `mfa_required` (matched on `code`, not message); other errors keep their real status (clamped to 400–599, else 400) and an unmapped 401 / unusable status carries a `report` payload for the caller's `reportCaughtError`. |
| `resolve-owner-scope.ts` | `resolveOwnerScope(sql, request, { allowReadOnly? })` — owner API preamble: `requireRole('owner')`, account presence, subscription gate (`subscriptionGrantsFullAccess`; `past_due` writable only inside the recovery window, else 402 `past_due_read_only`), and `rw_location_scope` cookie → `getRequestScope`, run concurrently with `allSettled` so the gate's error wins. Returns `{ accountId, locationId, userId }` or throws `ScopeError(statusCode)`. No CSRF check — callers wrap with `withSameOrigin`. |

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
| `policy.ts` | Pure policy math shared by the worker evaluator, the settings service and the admin mappers: `resolveEffectivePolicy(accountDefault, locationOverride)` (override wins the threshold; account-level `suspended_at` still applies), `starMeetsThreshold`, `exposureRank`, `resolveDailyCap` (`DEFAULT_DAILY_AUTO_POST_CAP` 10), `DEFAULT_VETO_WINDOW_MINUTES` 15, and the **(WS8)** exposure classifiers (`classifyThresholdExposure`, `classifyVetoWindowExposure`, `classifyDailyCapExposure` — removing a cap is always an expansion — combined by `classifyPolicyExposure`, any expansion wins; `completeDisable` is never an expansion). |
| `readiness.ts` | `buildAutoApprovalReadiness(input)` — folds `runtimeEnabled`, `autopilotAvailable`, provider-moderation enabled/validated, `accountWritable`, `policySuspended`, `previewEnvironment` and `impersonated` into an `AutoApprovalReadiness` (`canExpand` + ordered `blockReasons`). Suspension blocks expansion only; contractions stay allowed. Consumed by `settings.ts` and the admin business-detail mappers. |
| `settings.ts` | Server-owned read/write of `auto_approval_policies` (invariant #14 — browser code never touches the table): `getAutoApprovalSettings(db, { accountId, impersonated })` and `patchAutoApprovalSettings(sql, input)` behind `GET`/`PATCH /api/settings/auto-approval`. PATCH runs in one tx: account row `FOR UPDATE`, offboarding gate, before-state read, pure after-state, then archived-location → `standard` confirmation → readiness gates BEFORE any write, upsert/delete, `auto_approval_policy_changed` audit. Throws `AutoApprovalConfirmationRequiredError` / `AutoApprovalExpansionBlockedError` / `AutoApprovalSettingsError`. |
| `types.ts` | Auto-approval vocabulary and API contract: `AutoApprovalThreshold` (4 | 5 — positive quadrant only, WS4 §2.2), `VetoWindowMinutes` (15 | 30), daily-cap schema (1..50 or null), `APPROVAL_METHOD` (`owner` / `auto_policy`), `POLICY_PERSONA_REPLY` / `POLICY_ACTION_POSTING`, `PolicyRowState`, `EffectiveAutoApprovalPolicy`, `AutoApprovalReadiness` + block reasons, the settings response DTOs, `autoApprovalThresholdLabel`, and `AutoApprovalPatchSchema` (zod discriminated union — the single source of the `PATCH /api/settings/auto-approval` contract, incl. **(WS8)** dial ops). |

### `reviews/`

Everything about fetching and normalising Google reviews.

> **Review import consent — rules the code does not make obvious** (moved here
> from the CLAUDE.md routing row on 2026-08-16; spec
> `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` — §2
> decision table D1–D10 is **locked**; ADR
> `docs/adr/0015-consented-import-unflagged-replacement.md`; ADR
> `docs/adr/0016-import-consent-enforcement-locus.md` — enforcement locus, why
> not a `job_outbox` trigger; `CONTEXT.md` → **Review import**, **Import
> consent**, **Import offer**, **Import window**, **Live-ingest cutoff**).
> `import-consent.ts` is the SINGLE owner of the predicate and of every consent
> write — including `enqueueInitialImport`, which all four producers delegate
> to; do not re-spell its guard. Enforcement is at the four producers **and,
> since #679, at the chokepoint**: `guardImportConsent`
> (`worker/jobs/zernio/job-eligibility.ts`) is a fail-closed pre-flight in
> `ZernioBackfillWorker` that proceeds only on `accepted` — so a hand-inserted
> `zernio_initial_backfill` row no-op-completes with a logged reason instead of
> importing. It is deliberately a SEPARATE function from
> `guardZernioJobEligibility` (a merged guard would have two callers, one of
> which must never reach consent code), and its whole body must stay inside
> `sql.begin` with `SELECT … FOR UPDATE` + `markOutboxCompletedWithReason(tx, …)`
> — without that serialization an owner's accept races the guard into silent
> permanent data loss. Enqueue-path inventory:
> `.claude/reference/review-ingestion.md`.

| File | What it does |
|------|--------------|
| `types.ts` | `NormalizedReview` DTO, `ReviewSource` interface, `MonitoredReview`. |
| `serpapi-source.ts` | `SerpApiSource` — implements `ReviewSource`. Calls SerpAPI to fetch reviews for a Place ID. |
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
| `mock-source.ts` | Canned data used when `MOCK_EXTERNAL_APIS=true`. |
| `on-demand-generate.ts` | **(#729)** `onDemandGenerateTx(tx, {reviewId, businessId})` — the Generate transaction for a never-replied review: review `FOR UPDATE`, in-tx writable re-check, posted / non-terminal / orphan sibling exclusions, `pendingGenerateExists`, `nextResponseVersion`, then `enqueueGenerateResponse` pinned to `ON_DEMAND_GENERATE` + `suppressNotification: true` (excluded from auto-approval twice over). Callers run it inside `sql.begin`. |
| `zernio-field-match.ts` | Canonical field-match for "is this Zernio review the same as a local `serpapi_poll` row": `fromZernioReview` → `ZernioFieldMatchTarget` (name, rating, trimmed text, epoch ms) and `matchesLocalRow` (±24h `MATCH_WINDOW_MS`). Must stay in sync with the SQL fragment in `zernio-ingest-shared.ts`; a unit test runs both on one corpus. |
| `zernio-normalize.ts` | Zernio → `NormalizedReview` / `MonitoredReview`: `zernioReviewToNormalized` (per-review `ZernioReviewNormalizationError`), `buildZernioMonitoredReview` (identity `zernio_id`), `zernioProviderReviewName` / `zernioProviderLocationName` — the ONLY spelling of the synthetic `zernio://` names (**#764**) — `extractLocationFromReviewName` (null = fail closed), `normalizeGoogleReviewName`. |

**Connection:** live ingestion is Zernio-only — `worker/ingress/zernio/zernio.ts` fans out one `ingest_zernio_review` outbox row per active connection and `worker/jobs/zernio/ZernioReviewIngestWorker.ts` calls `process-review.ts` per review, which enqueues `generate_response`; `ZernioRecentReviewPoller` is the second entry into `process-review.ts` (in-process, no outbox row). `SerpApiSource` serves only the demo/prefill lane (`src/lib/demos/fetch-reviews.ts`, `serpapi-prefill.ts`); the legacy `ReviewSyncWorker`/`SerpApiMonitor` path was deleted.

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
| `http-routes.ts` | `runEscalationTransitionRoute(sql, request, params, transition, invalidTransitionMessage)` — shared runner for the owner-facing acknowledge/resolve routes, following the `approval/http-routes.ts` precedent so each `route.ts` stays a thin composition root. Owner guard (`requireDashboardReviewOwner`) → `assertWritableSubscriptionForAccount` → the passed `transitions.ts` function → HTTP mapping: `not_found` → uniform 404, `invalid_transition` → 409 with the supplied message, success → `{success, status}`, all with `NO_STORE_HEADERS`. |

**Connection:** `persistTriage` (`reviews/triage.ts`) calls `raiseEscalation()` in the same tx as the triage write → OutboxPoller dispatches `escalation_notice` → `EscalationNoticeWorker` sends. The dashboard escalation routes call `transitions.ts`.

### `solicitation/`

Phase 2 Solicitation agent (watch-mode first).

> **Solicitation consent & suppression — rules the code does not make obvious**
> (moved here from the CLAUDE.md routing row on 2026-08-16; spec
> `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md`;
> `CONTEXT.md` → "Solicitation suppression & unsubscribe" — **eight** locked
> terms, incl. **attestation never overrides suppression**; global wins a double
> match; the ledger is solicitation-only — DR2). **Redemption (#644) spans both
> surfaces** — `unsubscribe.ts` here owns the token gate, the claim-first
> ordering and the Success receipt; `worker/ingress/unsubscribe.ts` is the RFC
> 8058 one-click route; `src/app/(public)/u/**` + `src/app/api/u/**` are the
> recipient landing path. A page may claim "you are unsubscribed" **only** from
> a ledger read taken during that render — a receipt is necessary, never
> sufficient. **Manual paths (#645)**: the **Correction path** is the
> admin-only, audited removal of a factually-wrong row — error correction, NEVER
> re-subscribe — sunk to `solicitation_suppression_corrections` (migration 098),
> NOT `account_audit_log`, and written by ONE data-modifying CTE so the DELETE
> cannot commit without its record. §7.6 **owner clearing** is a different act
> with a different sink (`account_audit_log`); an owner may never clear a
> `global` row, and the UI must not present the two as the same control. Daily
> servicing ritual: `docs/runbooks/channels-rollout.md` §6.

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
| `ask-compliance-lint.ts` | Pure ask compliance lint (ask-generation design §1.2/§2): `assessNoteAdmissibility` (inadmissible note ⇒ omitted, never a block) and `lintAsk` — the seven-class fail-closed content lint (`ASK_BLOCK_REASONS`; `moderation_high` is vocabulary only). `ASK_LINT_VERSION` is stored on every render; the rule table is golden-filed. Deliberately does NOT reuse `moderation/output-filter.ts` (§2.7). |
| `ask-generation.ts` | **(#628)** Deep module behind `generate_solicitation_asks`: `generateAsksForBatch` (sequential per-child pipeline — interpolation → cost guard at `SOLICITATION_ASK_ESTIMATE_CENTS` = 1 → LLM → footer → lint → moderation → one `solicitation_outreach` row; DB-based idempotency; finale tx CASes the owned outbox attempt first), `regenerateAsk` (no tx spans the LLM call), `settleGenerationExhaustion` (fills `render_failed` rows, closes via `closeBatchIfSettled`). Injected `Sql` (invariant #15). |
| `ask-prompt-policy.ts` | Versioned system prompt for the `solicitation_ask` task: `SOLICITATION_ASK_PROMPT_BASE` + `SOLICITATION_ASK_PROMPT_VERSION` + memoized `solicitationAskPromptHash()`, `daysSinceVisitBucket` (the §1.1 temporal vocabulary), and `buildAskPrompt` over the five allowlisted interpolation fields. Deliberately independent of the reply-side `SYSTEM_PROMPT_BASE`. Pure. |
| `ask-render.ts` | Pure `assembleAskBody(llmBody, footer)` — the byte-for-byte stored/sent ask body: review-link CTA, `FOOTER_SEPARATOR`, sender line, owner-attested postal address verbatim, unsubscribe line; returns null without a postal address (fail-closed). Owns `REVIEW_LINK_PLACEHOLDER` / `UNSUBSCRIBE_URL_PLACEHOLDER` (substituted at dispatch, #630) and the footer prefixes lint class 7 asserts against. |
| `ask-schema.ts` | `SolicitationAskOutputSchema` — zod `strictObject({subject, body})`, shape only (spec §4.2); length bounds live in lint class 5 so an oversize draft becomes a legible `blocked` render, not a terminal `LLMStructuredOutputError`. |
| `upload-status.ts` | **(#541)** `UPLOAD_STATUSES` (`pending` / `completed` / `failed`) + `ContactUploadStatus` / `TerminalUploadStatus` — the single owner of the `contact_csv_uploads.status` enum, in lockstep with migration 086's CHECK. Dependency-free so the client island can import it. |

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
| `circuit-breaker.ts` | `LlmCircuitBreaker` + the `llmCircuitBreaker` singleton — in-process per-provider breaker: trips after 5 consecutive transient failures, opens 30s, admits one half-open probe. `shouldAttempt(provider)` returns an epoch-stamped `Admission` (or null); `recordAttempt(admission, error?)` ignores stale-epoch outcomes. Kill switch `LLM_CIRCUIT_BREAKER_ENABLED`, read live per call. Correct only single-replica (ADR 0005). |
| `flags.ts` | `llmCircuitBreakerEnabled()` — `LLM_CIRCUIT_BREAKER_ENABLED` accessor over `readFlagEnabledByDefault` (default ON; only the literal `'false'` disables). |

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
| `edit-existing.ts` | Two primitives shared by the Past Replies routes (spec §4.1/§4.6): `assertCanEditReply` (account ownership + location match + writable subscription + known tier, fail-closed) and `validateOptimisticConcurrency` (in-tx review-hash + posted-version check; caller must hold the review lock). Throws `NotFoundError` / `ForbiddenError` / `ReviewChangedError` / `ResponseChangedError` / `SubscriptionReadOnlyError`. |
| `prompt-policy.ts` | Owns the prompt policy: `SYSTEM_PROMPT_BASE` (the versioned safety base prepended to every production system prompt), `PROMPT_VERSION`, and the memoized `systemPromptHash()` (SHA-256) recorded on `api_costs`. Dynamic business details are assembled in `prompt-builder.ts`; only this base is versioned and hashed. |
| `voice-report-card.ts` | `deriveVoiceReportCard(examples)` — deterministic register-trait derivation for `/settings/voice` (greeting, length, sign-off, point of view, critical reviews) over the same `VoiceExample` pairs the prompt few-shots from (#540). A trait renders only on a strict majority AND ≥2 conforming pairs; critical reviews detects at ≥1 substantive negative rewrite. |

**Connection:** `ResponseGeneratorWorker` calls `generateResponse()`. `DemoGenerationWorker` calls it in `demo` mode.

### `moderation/`

Output moderation for generated drafts — the always-on local regex filter, the optional OpenAI Moderation call, and the held-draft gate that makes a high-severity flag binding (invariant #4).

| File | What it does |
|------|--------------|
| `flags.ts` | `openaiModerationEnabled()` — `OPENAI_MODERATION_ENABLED` accessor over `readFlag` for the inline moderation path. Auto-approval's `providerModerationEnabled()` reads the same flag for a different gate; two named accessors over one flag is intentional. |
| `held-draft.ts` | The held-draft gate: `openFlagExistsSql(db, ref)` — the one composable spelling of "response has an OPEN `flagged_responses` row" (`'open'` is a literal, matching migration 051's partial index byte-for-byte) — `hasOpenFlag(tx, responseId)` (in-tx, post-lock), and `HeldForReviewError`. Every owner-facing release path must call it; admin, health-alert, purge and producer consumers stay deliberately separate (#725). |
| `moderate.ts` | Worker-only `moderateResponse(text)` — always runs the local filter; when `OPENAI_MODERATION_ENABLED` also calls `omni-moderation-latest` (10s timeout) and merges (provider flag → `high`). Never throws: a provider outage falls back to the local decision with `providerStatus: 'error'`. |
| `output-filter.ts` | `runOutputFilter(text)` — the local regex filter: word-boundaried rule table (refund/discount, legal fault, injection compliance, profanity → `high`; competitor, advice → `medium`) producing a `ModerationDecision` (`flagged`, `severity`, `reason`, `categories`, `score`, `source`, `providerStatus`). Also owns `SEVERITY_RANK`. |


### `notifications/`

Sending approval notifications to business owners.

| File | What it does |
|------|--------------|
| `email.ts` | Barrel re-export of the modularized email layer. New code should import directly from `email/client`, `email/headers`, or `email/templates/<family>`. |
| `email/client.ts` | `getResend()` — lazy Resend client (constructed on first use). |
| `email/headers.ts` | Shared email header helpers (List-Unsubscribe, etc.). |
| `email/templates/approval.ts` | HTML template for the approval request email. |
| `email/templates/internal.ts` | HTML template for internal admin notification emails. |
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
| `channels/availability.ts` | `telegramAvailable()` / `whatsappAvailable()` — "can an owner enrol in this channel right now?": the AND of the channel's feature flag (`flags.ts`) and its transport env being complete (`assertTelegramEnvReady() === null` / `whatsappEnvReady()`). Single owner of that conjunction for the owner Channels page and `GET /api/dashboard/channels`. Server-only (`process.env` reads, invariant #13). |
| `channels/constants.ts` | Shared enrollment-flow constants read by both `use-enrollment.ts` and the start/cancel/disable routes so client and server cannot drift: `TOKEN_TTL_MS` (1h verification-token TTL), `STATUS_POLL_INTERVAL_MS` (3s), `TTL_TICK_INTERVAL_MS` (1s). |
| `channels/enroll-email-owner.ts` | `enrollOwnerEmailChannel(sql, { accountId, businessId, ownerEmail })` — the single-sourced idempotent INSERT that marks the owner's email a `verified` channel enrollment once the address is proven; called by both self-serve entry points (`finish-signup`, `verify-otp`) because `createBusinessTx` deliberately skips it for self-serve. `ON CONFLICT` predicate matches migration 034's partial unique index byte-for-byte. |
| `channels/flags.ts` | Single owner of the notification-channel flags over `readFlag`: `channelsTelegramEnabled()` (`CHANNELS_TELEGRAM_ENABLED`), `channelsWhatsappEnabled()` (`CHANNELS_WHATSAPP_ENABLED`), `emailChannelReconcileDisabled()` (`EMAIL_CHANNEL_RECONCILE_DISABLED` kill-switch for the reconcile poller), and the exhaustive `Record<ChannelId, …>` map `channelNotificationEnabled(channel)` (email always on). Server-authoritative, no `NEXT_PUBLIC_*` companion (invariant #13). |
| `channels/template-prefix.ts` | `sanitizeLocationLabelForPrefix(label)` — makes a location label safe inside the `[{label}]` notification prefix: `[`/`]` → `(`/`)`, truncate to 30 chars with ellipsis, colons preserved (VAL-NOTIF-019). Used by the email templates and `telegram-body.ts`. |
| `channels/transient-send-error.ts` | `isTransientChannelSendError(err)` — the ONE definition of which provider send errors are transient (retry-worthy): `WhatsAppRateLimitError`, `WhatsAppTimeoutError`, `TelegramRateLimitError`, and `TelegramApiError` with `errorCode === 0` (timeout/network); everything else is terminal. Read by the auto-post, escalation, pending-post and autonomy-suspended notice dispatchers' `errors.ts` (two copies had already drifted before this). |
| `contact-form.ts` | `parseContactCoreFields(req)` — shared JSON-body parsing for `POST /api/contact` and `/api/demo-request`: requires non-empty `name`, a valid `email`, non-empty `businessName`; returns trimmed fields plus the raw body (route-specific extras), or an inline 400 `NextResponse` so the two routes cannot drift on validation shape or error strings. |
| `contact-notify.ts` | **(#167)** Single owner of "where do public contact/demo/lead notification emails go": `resolveContactNotifyTo()` (`CONTACT_NOTIFY_TO` → mailbox of `RESEND_FROM_EMAIL` → `noreply@repworth.net`, Sentry message + `console.warn` in production when falling back) and `notifyContactSubmission({ subject, lines })`, best-effort via `sendInternalEmail` — `{ sent: false }` only when no `RESEND_API_KEY` and not mock mode. Callers: contact, demo-request, lead-intake routes. |
| `email/send-email.ts` | `sendEmail(payload, { timeoutMs?, idempotencyKey? })` — the single sanctioned Resend send path: `Promise.race` against `EMAIL_SEND_TIMEOUT_MS` (default 10s; throws `EmailSendTimeoutError` → BullMQ retry) so a hung request cannot head-of-line-block the concurrency-1 notification worker, and passes a stable idempotency key so a timeout-retry or failover re-send dedupes at Resend. Every email template's send goes through it. |
| `email/templates/auto-post-notice.ts` | `sendAutoPostNoticeEmail(params)` — transactional FYI sent AFTER an auto-policy reply is posted; no approval affordance. `[label] ✅` subject via `sanitizeLocationLabelForPrefix`; optional "View on Google" CTA through the `/r/google/<responseId>` redirect, omitted when `googleMapsUrl` is null; no List-Unsubscribe; per-response `idempotencyKey`; mock-mode short-circuit. Delivery template `auto_post_notice` (Resend ingress treats it as owner-directed for bounce flagging). |
| `flags.ts` | `notificationFailoverDisabled()` — the sole `NOTIFICATION_FAILOVER_DISABLED` accessor over `readFlag` (true ⇒ the failover poller does not run). Server-authoritative, no `NEXT_PUBLIC_*` companion (invariant #13). |
| `mask-handle.ts` | `maskChannelHandle(channel, handle)` — channel-aware masking for API responses: email passes through (owner's own login identity), whatsapp shows first 3 + last 4, telegram shows `••• ` + last 4, and any unknown/stale channel value is masked like a phone number, never returned raw. Read by `GET /api/dashboard/channels`, the admin business-channels service and the conversational-seam ingress. |
| `resolve-channels.ts` | `resolveChannels(sql, accountId, locationId)` — the ONE chokepoint for notification-dispatch channel resolution (never query `channel_enrollments` directly for dispatch): archived location → `[]`; verified, non-archived, non-unsubscribed rows for `location_id = $loc OR IS NULL`, one per channel with the per-location override beating the org-default; Upstash cache 5-min TTL keyed `(account_id, location_id)`. `invalidateChannelCache(accountId)` / best-effort `safeInvalidateChannelCache(accountId, context)` on every enrollment write, after commit. |
| `email/templates/account-offboarding.ts` | `buildAccountOffboardingEmailHtml(params)` — one builder for the seven offboarding owner emails, switched on `emailType`: cancel_only confirmation (default) / access-end / reactivation confirmation, delete_data confirmation (requires `keepMyDataUrl`, shows `purgeAfter`), purge reminder, keep-my-data confirmation, and the purge receipt, whose retention sentence renders only when `retainedSuppressionCount > 0` **(#643)**. |

**Connection:** `NotificationWorker` calls `getVerifiedEnrollments()` then iterates, calling `getChannel(id).send(...)` for each. Delivery is recorded with `recordNotificationDelivery()`.

### `channels/`

Owner-side channel-enrollment domain module for `channel_enrollments`: mobile (Telegram/WhatsApp) start/cancel/disconnect helpers, per-location overrides, and the two read models behind Settings → Notifications. Every function takes `sql`/`tx` as a parameter (invariant #15). The 12 mobile-channel enrollment routes reach it through the shared runners (`src/app/api/_shared/channels/{start,action}.ts`); the override/overrides routes and the SSR channels page call it directly. Org-default lookups are ACCOUNT-scoped (`account_id` + `channel` + `location_id IS NULL`); `business_id` is a legacy NOT-NULL FK written on INSERT and never used for lookup.

| File | What it does |
|------|--------------|
| `disable-enrollment.ts` | `disconnectChannel(sql, …)` — owner/admin disconnect of a mobile channel: runs `disableChannelEnrollment(tx, …)` in its own tx, then `safeInvalidateChannelCache` after commit. The cascade disables the verified org-default row (`location_id IS NULL`) AND every live per-location override, writing a `channel_disabled` / `channel_override_disabled` audit row per change; `not_found` only when nothing changed. Reconnect never re-enables overrides. |
| `mobile-enrollment.ts` | Shared tx helpers for Telegram/WhatsApp enrollment used by both portals' routes: `startMobileEnrollment(tx, channel, businessId, accountId, tokenHash, expiresAt)` (org-default row `SELECT … FOR UPDATE` → INSERT/UPDATE to `pending_verification`; `already_verified` short-circuit; 23505 mapped via `classifyEnrollmentError`) and idempotent `cancelMobileEnrollment` (pending → `disabled`, token fields cleared). Caller owns `sql.begin`, the `mobile_enroll:${accountId}` advisory lock, raw-token generation and QR. Exports `MobileChannel`, `TxLike`. |
| `org-default-enrollments.ts` | `getOrgDefaultChannelEnrollments(sql, accountId)` — the ONE query for an account's live org-default rows (`account_id` + `location_id IS NULL` + `archived_at IS NULL`, `channel IN CHANNEL_IDS`), shared by the SSR Settings page and `GET /api/dashboard/channels` so the two cannot disagree. Returns raw rows; deliberately excludes `verification_token_hash` (only the expiry) and never selects or filters on `business_id`. |
| `override.ts` | Per-location channel overrides, each in its own tx with the audit row and post-commit cache invalidation: `createOrReviveOverride(sql, input)` (in-tx eligibility via `shouldUseMultiLocationSettings` + active-location check, clones the VERIFIED org-default's handle/status, revives a cascade-disabled row instead of duplicating; `not_eligible` / `location_not_found` / `no_org_default` / `conflict` on 23505) and `removeOverride` (soft-delete via `archived_at`, `channel_override_removed` audit). |
| `overrides-view.ts` | `getChannelOverridesView(sql, accountId)` — the single read model for the override surfaces (SSR channels page and `GET /api/settings/channels/overrides`): per-location override DTOs with resolved display labels (`getDisplayLabel`, raw-UUID fallback, `archived` flag, ISO `verified_at`), the account's full active+archived location list, and `verifiedOrgChannels` (org-default channels with a live verified row, in `CHANNEL_IDS` order). |
| `unique-violation.ts` | Typed errors + Postgres 23505 classifier for the enrollment surface: `classifyEnrollmentError(err)` (always throws) maps a unique violation on `channel_enrollments_one_mobile_per_biz` (migration 027) or `channel_enrollments_one_mobile_per_scope` (migration 034) to `MultipleMobileChannelsError` (routes → 409) and any other 23505 to the generic `EnrollmentDatabaseError` (→ 500, never echoes `constraint_name`); anything else is re-thrown. Also `isMultipleMobileChannelsError`. |


### `costs/`

LLM cost tracking and enforcement.

| File | What it does |
|------|--------------|
| `tracker.ts` | `reserveCost()` / `finalizeCost()` / `refundCost()` — Redis INCRBY/DECRBY for pessimistic reservation before LLM calls. Enforces per-business and global daily ceilings. |
| `audit.ts` | `recordApiCost()` — writes completed costs to the `api_costs` table (audit trail, reconciled hourly by `ReconciliationPoller`). |
| `concurrency-guard.ts` | Per-business generation concurrency semaphore on a Redis counter (`gen:active:<businessId>`, max 3, 5-min TTL safety net). `acquireConcurrencySlot` runs INCR + limit check + EXPIRE in one Lua script — a Redis transport failure throws `CostInfraUnavailableError`, a full slot throws `ConcurrencyLimitExceededError`; `releaseConcurrencySlot` DECRs and clamps at zero. |
| `cost-guard.ts` | `withCostGuard(opts, fn)` — the two-phase Redis reserve → finalize wrapper around every paid LLM call: `reserveCost` (task-scoped `estimateCents`, threaded unchanged through reserve/finalize/release), optional concurrency slot, then `finalizeCost` from actual cents or `releaseCost` on failure. `onFinalizeError` chooses `propagate` vs `log-and-return-value`; malformed cents throw before touching Redis. |
| `errors.ts` | Leaf module for `CostInfraUnavailableError` + `CostInfraTouchpoint` (`reserveCost` / `checkIdempotentCache` / `acquireConcurrencySlot` / `checkAskRegenBudget`): a pre-LLM cost-guard Redis TRANSPORT failure, re-thrown by the generation worker so BullMQ retries — never a budget decision, which stays terminal. |
| `onboarding-demo-cost-guard.ts` | Pre-pay onboarding-demo lane budget: `reserveOnboardingDemoBudget` (20¢ INCRBY against a global daily ceiling — Redis override → `ONBOARDING_DEMO_DAILY_CENTS` → $10 default — throws `CostCeilingExceeded`), `finalizeOnboardingDemoCost`, `checkCostThreshold` (fires each %-of-ceiling threshold once per day via SADD), and the `withOnboardingDemoCostGuard` wrapper. Distinct from `cost-guard.ts`. |
| `tier-cost-limits.ts` | Per-tier daily cost ceiling env vars (`DAILY_COST_LIMIT_CENTS_COPILOT` / `_AUTOPILOT`): `tierDailyCostLimitCents(tier)`, `parseRequiredPositiveCostLimitCents`, `assertTierDailyCostLimitsConfigured` (boot-time check), and `optionalNonnegativeCostLimitCents` for the optional global ceiling with fallback. |

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
| `checkout-attempt.ts` | `CheckoutAttemptLeaseColumns` — the shared projection of the `accounts.checkout_attempt_*` lease columns — plus `CheckoutCouponDecisionReason` (`applied` / `not_invited` / `env_unset`) and `checkoutCouponDecisionLabel` for the beta comp coupon decision log (admin-invite-funnel step 11); `env_unset` is the one that means an invited tester is about to be charged. |
| `flags.ts` | Payments flag accessors over `readFlag`: `trialEnabled()`, `stripeTaxEnabled()`, `stripeLocationsReconcileDisabled()`, plus `betaCompCouponId()` — the trimmed `BETA_COMP_COUPON_ID` via `getServerConfig()` or null (unset = comp off); sole consumer is `resolveCheckoutCreateShape` in `plan-activation.ts`. |
| `stripe-error-inspect.ts` | Single owner of the Stripe error-inspection vocabulary: `RETRYABLE_STRIPE_ERROR_TYPES`, `PERMANENT_STRIPE_ERROR_TYPES`, `RETRYABLE_NETWORK_ERROR_CODES`, `errorStringProperty` / `errorNumberProperty`, and `isStripeCouponError` (classifier only — `param` → `code` → `message`). Retry POLICY stays with the two consumers (`account-offboarding/stripe-invoices.ts`, `worker/jobs/billing/stripe-overage-error.ts`). |

### `admin/` *(Wave 2 additions)*

Admin-side domain helpers.

> **Admin business query — rules the code does not make obvious** (moved here
> from the CLAUDE.md routing row on 2026-08-16; `CONTEXT.md` → **Business
> summary** + **At-risk list**, two LOCKED terms; spec
> `docs/superpowers/specs/2026-08-15-portal-audit-remediation-design.md` §5).
> `business-summary.ts` is the SINGLE owner of the base query, the conditional
> COUNT, the metrics follow-up and `buildBusinessSummary`; it exports ONE
> function, `getBusinessSummaries(sql, opts?)` — Overview calls it unpaginated
> and ranks, Businesses calls it with a page. Do not re-spell that query in a
> second module (it was spelled twice until #833). (a) The at-risk list is
> **filtered THEN capped** — eligibility `churnScore.level !== 'healthy'`, then
> top `OVERVIEW_AT_RISK_LIMIT`; capping first surfaces healthy rows and is the
> bug the tests exist to catch. (b) Ranking is **TypeScript and must never become
> `ORDER BY … LIMIT`** — account age makes every business score non-zero, so no
> SQL predicate is a provable superset of "at risk", and Overview reading every
> row is a RECORDED limitation (§5.1) with a named rejected alternative, not an
> oversight. (c) Businesses fetches metrics for the **current page's ids only**
> (LIMIT/OFFSET first, then metrics) — a pinned test guards that bound. (d)
> `OVERVIEW_AT_RISK_LIMIT` lives in `overview-service.ts`, NOT `page-sizes.ts`
> as §5.1 asks, because `src/lib/**` may not import `@/app/**`
> (`APP_LEAF_IMPORT_BAN`) and nothing app-side reads it. Health presentation has
> ONE owner, `src/components/admin/ui/HealthBadge.tsx` — all three surfaces
> import it now, including the business DETAIL page, which carried a private
> `Record<string, string>` copy (an unrecognised level rendered silently green)
> until it was deleted; and churn DERIVATION has one owner too, which is
> `business-summary.ts` and NOT a third module — it exports
> `churnMetricsQuery(sql, businessIds)` + `churnScoreFromMetrics(row)`, and
> `business-detail/{queries,mappers}.ts` call them, the detail page passing a
> one-element id array instead of re-spelling the CTE.

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

> **Admin invite funnel — rules the code does not make obvious** (moved here from
> the CLAUDE.md routing row on 2026-08-16; plan
> `docs/superpowers/plans/2026-08-14-admin-invite-funnel.md`, `CONTEXT.md` →
> **Admin invite**, **Checkout attempt**, **Funnel entry**, **Beta comp coupon** —
> four LOCKED terms; staging proof
> `docs/runbooks/evidence/2026-08-14-admin-invite-funnel-staging.md`; step-7
> reviews `docs/reviews/admin-invite-funnel/`).
> (a) **Every** Stripe Session parameter is built from the durable
> `accounts.checkout_attempt_*` snapshot, never a live env read — the coupon
> joined that snapshot precisely so an ops flip between an owner's first click
> and their retry cannot change the price under a key Stripe treats as
> identical. (b) `resolveFunnelEntry` (`funnel-entry.ts`) is **pure** — it takes
> `onboardingDemoEnabled()` as an argument and reads no flag, env or DB, which
> is what keeps flag state server-side (invariant #13) and the whole matrix
> table-testable; the deleted `paymentUrl` must not come back. (c) `onboarded_by`
> on the PRIMARY business is the comp's only eligibility marker and already
> carries three unrelated meanings — before reusing or widening it read the
> rejected-finding record in
> `docs/reviews/admin-invite-funnel/adversarial-approach-codex.md` (migration
> 025 backfilled it on every pre-025 row, and NULLing those rows would grant
> trial eligibility and strip a `CleanupAbandonedSignupsPoller` guard).
> **Migration 105 cannot be applied where 077 has not been** — a real
> dependency, but no longer a prod gate: both 077 and 105 are applied in prod as
> of 2026-08-14 (see the standing exception in CLAUDE.md § Environments).

| File | What it does |
|------|--------------|
| `create-business.ts` | `createBusinessTx(sql, params)` — atomic transaction that inserts `users` + `businesses` + `channel_enrollments` (email) rows. Used by both admin and self-serve signup. Dual mode (`admin` / `self_serve`). |
| `admin-onboarding-service.ts` | `onboardBusinessAsAdmin(sql, supabase, input)` — validates admin onboarding input, calls `createBusinessTx` in `admin` mode, handles `DuplicateEmailError`, and invites the owner via Supabase `inviteUserByEmail`. `rollbackProvisionedBusiness(sql, createdResult)` runs the shared FK-ordered 4-DELETE compensating rollback used by both failure paths. Used by `POST /api/admin/businesses`. **(2026-08-14)** Input is now only owner email, owner name and business name; it resolves no Place ID, writes no voice fields, asserts no tier (the row is created on the `copilot` default and the owner picks their real tier at `/onboarding/pay`), and enqueues no `validate_place_id` — `/api/onboarding/start` does that once the owner captures a place, exactly as it does for self-serve. |
| `funnel-entry.ts` | **(2026-08-14)** `resolveFunnelEntry(state)` — the single owner of "where in the funnel does this owner belong?", returning one of `/onboarding/{start,demo,pay,business}` or `/dashboard`. **Pure**: no DB handle, no `process.env`, no flag read (the caller passes `onboardingDemoEnabled()` in), so the whole matrix is table-testable and flag state stays server-side (invariant #13). Its output is the `funnelUrl` field on `GET /api/auth/signup-status`, `GET /api/dashboard` and `GET /api/settings`, consumed by `loginDestination` and `PendingPaymentScreen`. Replaced three disagreeing branches — `loginDestination`'s demo-blind `pending_payment → /onboarding/pay`, `verify-otp`'s private start-vs-pay branch, and the dashboard's hardcoded `paymentUrl` (that field is **gone**, not renamed). |
| `resend-invite.ts` | **(2026-08-14)** The re-invite decision + Supabase provider-error mapping behind `POST /api/admin/businesses/[id]/resend-invite`. Gates on account `pending_payment` AND the provider reporting `last_sign_in_at IS NULL`. ⚠️ **The error mapping is deliberately staging-unverified** — the module header carries a "staging-verify before prod" marker, an unknown provider error answers `502` with the raw provider code logged and is never auto-retried, and verifying the real Supabase re-invite error shapes on staging is an open ops step (`docs/runbooks/beta-onboarding-cofounder-guide.md` → Part 12). |
| `flags.ts` | `onboardingDemoEnabled()` — single owner of the `ONBOARDING_DEMO_ENABLED` flag (the pre-pay onboarding demo lane: start/business/demo pages + their routes), a one-line wrapper over `readFlag` in the `<feature>/flags.ts` convention. Server-authoritative (invariant #13) — no `NEXT_PUBLIC_*` companion; the browser learns the state via API responses/props. |

### `account-offboarding/`

Owner offboarding domain (`cancel_only` / `delete_data` / purge) — the confirm, gate, keep-my-data, reactivation, disposition and purge-verification modules behind `/api/account/offboarding/*`, the admin disposition route, and the `worker/jobs/account-offboarding/` workers; design of record per CLAUDE.md is `docs/superpowers/specs/2026-06-05-owner-offboarding-design.md`. All modules take an injected `sql`/`tx` (invariant #15) and enqueue only via `outbox.ts`.

| File | What it does |
|------|--------------|
| `analytics.ts` | Four typed wrappers over `enqueueAnalyticsEvent` for the offboarding lifecycle: `enqueueOffboardingStarted`, `enqueueOffboardingReactivated`, `enqueueOffboardingTeardownCompleted`, `enqueueOffboardingPurged`. Event keys derive from the offboarding id; the purged event keys and identifies by a SHA-256 hash of that id and carries no account/user id. Take the caller's `sql`/`tx`. |
| `confirm.ts` | `confirmCancelOnlyOffboarding` / `confirmDeleteDataOffboarding` — the owner-confirm transactions. Each hashes the idempotency key, resolves an existing active row (idempotent replay or `duplicate_active`), captures the snapshot, inserts `account_offboardings` as `pending` (delete_data adds `purge_after = NOW() + 30 days` and disconnects every live Zernio connection on the account), writes audit + analytics, and enqueues billing-schedule (cancel_only) or teardown + confirmation email (delete_data) — one tx. |
| `destructive-auth.ts` | `requireDeleteDataDestructiveAuth(request)` — the delete_data route gate: same-origin, `requireOwnerWithAccount`, an HMAC-signed 10-minute fresh-auth cookie (`FRESH_AUTH_COOKIE_NAME`; `signFreshAuthStamp` / `setFreshAuthCookie` / `clearFreshAuthCookie`, keyed on the session-cookie secret + user + account), then AAL2 via `requireAal2FromSupabase`. Failures return 403 with `forbidden`, `fresh_auth_required`, `mfa_check_failed` or the AAL reason. |
| `email-dedup.ts` | `accountOffboardingDeliveryId(offboardingId, emailType)` — deterministic UUIDv5-shaped `notification_deliveries` id (SHA-256 of namespace + offboarding id + email type) — and `accountOffboardingEmailSendIdempotencyKey(deliveryId)` for the Resend send. `AccountOffboardingEmailDeliveryType` adds `purge_receipt` to the payload's email types. |
| `flags.ts` | `accountOffboardingEnabled()` — reads `ACCOUNT_OFFBOARDING_ENABLED` via `readFlag`. |
| `gate.ts` | Offboarding-aware access gate. `getOffboardingState(accountId, db)` loads the latest non-terminal `account_offboardings` row; `activeOffboardingStateFromProjection` maps a joined `offboarding_*` projection; `createOffboardingGate(db)` memoizes per request. `isOffboardingIntentBlocked(state, intent)` over `OFFBOARDING_INTENTS` plus per-intent `is*Blocked` helpers: delete_data / tearing_down / purge_scheduled / most `failed` rows block everything; a cancel_only pre-teardown `scheduled` or billing-failure row freezes only checkout + billing-expanding mutations. `lockAccountBeforeOffboardingProjection` pins the account row first. |
| `keep-my-data.ts` | Cancels a scheduled delete_data purge. `keepMyDataForAccount` (owner session + idempotency key) and `keepMyDataWithToken` (raw emailed token, hashed and consumed under `FOR UPDATE`; rejects invalid / expired / consumed / revoked). Both run `applyKeepMyData`: stamps `purge_cancelled_at`, flips a teardown-completed row to `churned` + terminal, revokes remaining keep-my-data tokens, writes `account_offboarding_keep_my_data` audit and enqueues `keep_my_data_confirmation` — one tx. |
| `outbox.ts` | Transactional-outbox enqueue cluster for the five `account_offboarding_*` topics: `enqueueAccountOffboardingBillingSchedule`, `…Email`, `…Reactivation`, `…Teardown`, `…Purge`. Every function takes the caller's `tx` and binds JSONB via `tx.json` (no `@/lib/db/server` import). Email and reactivation ids are deterministic (SHA-256 namespace + parts) with `ON CONFLICT (id) DO NOTHING`; the purge-receipt email carries recipient / `purged_at` / `retained_suppression_count` in the payload because the row is scrubbed by then **(#643)**. |
| `provider-disposition.ts` | Admin manual resolution of a provider resource teardown could not reach. `ProviderDispositionInputSchema` (zod); `buildAdminProviderDispositionRecord` scrubs text and hashes the resource reference; `recordProviderDisposition(input, db)` appends to `provider_dispositions` under `FOR UPDATE`, writes the audit row, and — only when a `failed`/`teardown` row's every applicable provider step is now covered — transitions it to `purge_scheduled`. `unresolvedApplicableTeardownProviders` derives applicability from the snapshot, never the step column. |
| `purge-verification.ts` | `verifyAccountOffboardingPurge(input, exec)` — post-purge read-side check run inside the finalize tx: one `verificationQuery` per `PURGE_VERIFICATION_TABLES` entry counting surviving or unscrubbed rows for the account (tombstone shape, absent rows, scrubbed payloads, `distinct_id` residue). Fail-closed: an inventoried table without a branch throws `missing_purge_verification_sql`. `absentByBusiness` is the allowlisted by-business COUNT twin of the purge's `deleteByBusiness`. |
| `reactivate.ts` | `reactivateCancelOnlyOffboarding(sql, input)` — reverses a `scheduled` cancel_only row. Claims via `reactivation_claimed_at` / `reactivation_claim_token` (migration 060; a stale >5-min claim can be taken over), calls Stripe `subscriptions.update({cancel_at_period_end:false})` under a deterministic idempotency key, then `finalizeReactivation` sets `reactivated` + terminal, audit, analytics and confirmation email in one tx. Retryable Stripe errors keep the claim and throw; other failures compensate and clear it; stranded claims fall to the reactivation-reset poller. |
| `reactivation-request.ts` | `requestCancelOnlyReactivation(sql, input)` — the route-side half: locks the latest reactivatable `scheduled` cancel_only row (`FOR UPDATE`), requires a `stripe_subscription_id`, and enqueues `account_offboarding_reactivation` with the hashed idempotency key. Returns `queued` or `not_reactivatable`; the Stripe call happens in `ReactivationWorker`. |
| `retry-billing.ts` | `retryCancelOnlyBillingSchedule(sql, input)` — self-service recovery for a cancel_only row stuck at `failed` / `failed_step='billing'` (BullMQ retries exhausted, subscription never cancelled — a non-terminal row that blocks a fresh offboarding). Locks account + row, resets to `pending` (`stripe_step='not_applicable'`, `retry_count+1`), writes `account_offboarding_billing_retry` audit and re-enqueues the billing-schedule job in one tx. |
| `scrub-error.ts` | `scrubOffboardingErrorForStorage(message)` — single owner of the string-side redaction applied before an offboarding error is persisted (`last_error`, Sentry `extra`, rethrown messages): emails, phone numbers, Bearer/Basic credentials, `token=` / `"secret":`-style pairs, truncated to 500 chars. Object payloads use `shared/sentry-scrub.ts` instead. |
| `snapshot.ts` | `captureAccountOffboardingSnapshot(tx, input)` — locks the account row (`FOR UPDATE`) and captures the immutable teardown snapshot: Stripe customer/subscription ids, live Zernio account/profile ids, ordered `location_ids` (optionally including archived — delete_data uses this), owner `auth_id` + email. Returns `{ok:false, missingFields}` when a required field is absent; `requireStripeCustomerId` / `requireStripeSubscriptionId` relax the Stripe fields. |
| `status.ts` | `getAccountOffboardingStatus(accountId, db)` — owner-facing read model: the active offboarding (id, mode, status, failed step, access-end / teardown / purge timestamps) plus `operationalUIBlocked` from `gate.ts`, or `activeOffboarding: null`. |
| `stripe-invoices.ts` | `cleanupSubscriptionInvoices({stripe, subscriptionId, …})` — pages a subscription's invoices (bounded `maxPages`, ≤100/page): drafts are finalized (`auto_advance:false`) then voided, `open`/`uncollectible` voided, `paid`/`void` retained, other-subscription invoices skipped; deterministic idempotency key per mutation. Throws `StripeInvoiceCleanupError` (`retryable`, `operation`, `code`) — retry policy is local, the error vocabulary comes from `payments/stripe-error-inspect.ts`. Takes an injected `StripeInvoiceCleanupClient` shape. |
| `table-disposition.ts` | The per-table purge inventory: `TABLE_DISPOSITIONS` (48 tables), each with a disposition (`hard_delete`, `scrub_in_place`, `retain_deidentified`, `retain_compliance_limited_pii`, `not_applicable`), scope evidence, purge-verification mode and reason; `ALLOWED_PURGE_VERIFICATION_BY_DISPOSITION` pins which modes a disposition may use. Evidence + verification input only — the executable purge SQL lives in `worker/jobs/account-offboarding/purge-stages.ts`. Derives `ACCOUNT_OFFBOARDING_TABLES` and `PURGE_VERIFICATION_TABLES`. |
| `tokens.ts` | Keep-my-data token primitives: `createKeepMyDataRawToken({accountOffboardingId, deliveryId})` — deterministic HMAC-SHA256 under the session-cookie secret, base64url; the file records why no per-token salt is an accepted, bounded design — `hashAccountOffboardingToken` (SHA-256; only the hash is persisted, invariant #5) and `assertKeepMyDataTokenSecretConfigured`. |
| `types.ts` | Type-only vocabulary: `AccountOffboardingMode` (`cancel_only` / `delete_data`), `AccountOffboardingStatus` (8 values) split into terminal (`purged` / `churned` / `reactivated`) and active subsets, `AccountOffboardingFailedStep` (`billing` / `teardown` / `purge`), `AccountOffboardingStepOutcome` (`success` / `failed` / `not_applicable`), and the `ActiveOffboardingState` shape `gate.ts` returns. |


### `demos/`

| File | What it does |
|------|--------------|
| `generator.ts` | `generateDemoResponses(reviews, context)` — calls `generateResponse` in `demo` mode for each review. |
| `types.ts` | Demo-specific types (`DemoRequest`, `DemoResult`). |
| `fallback-content.ts` | `getFallbackDemo(category)` — curated fallback reviews + responses for the demo when live content is unusable; normalizes a free-text category to a canonical key, every key currently sharing the general-business fixture (`__fixtures__/fallback-source-reviews`). |
| `fetch-reviews.ts` | `fetchSerpApiReviews(placeId)` — up to 15 reviews via `SerpApiSource`, or `MockReviewSource` when `MOCK_EXTERNAL_APIS=true`; fails fast at module load if `SERPAPI_API_KEY` is missing outside mock mode. Extracted from `generator.ts` so the worker does not choose the source. |
| `generate-responses.ts` | `generateResponsesForReviews(sql, reviews, businessContext)` — `Promise.allSettled` over `generateResponse` in `demo` mode (or `generateMockResponse`), mapping a failed review to `null` and returning success/failure/cost/duration metadata. Extracted from `generator.ts`. |
| `lifecycle.ts` | Demo-row state machine over `onboarding_demos` / `prospect_demos`: `claimDemo` (queued → running CAS, >5-min stale-running reset; returns `claimed` / `already_terminal` / `not_found` / `reset_to_queued` / `race_lost`), `completeDemo` (row + outbox in one tx; the 23505 race-loser archives itself and closes its outbox), `failDemo`. Called by `DemoGenerationWorker`. |
| `select-qualifying.ts` | `selectQualifyingReviews(reviews, opts)` — picks ≤3 demo reviews: `newest` (first three) or `positive-with-moderate-tail` (rating ≥3; a substantive 5-star anchor, up to two 4-stars, one trailing 3-star; returns `[]` when no ≥4 anchor so the caller falls back to curated content). |

### `publishing/`

GBP reply publishing logic.

| File | What it does |
|------|--------------|
| `zernio-publisher.ts` | `resolveZernioReviewId()` + `publishViaZernio()` — resolves our internal SerpAPI review ID to Zernio's canonical review ID via a Redis-cached field match (displayName + rating + comment + createTime ±24h), then posts the reply via `zernioClient.publishReply()`. Falls back on transient errors. |
| `flags.ts` | Zernio publishing flag accessors over `readFlag`: `zernioPublishingEnabled()` (`ZERNIO_PUBLISHING_ENABLED`), `externalReplyImportEnabled()` (`EXTERNAL_REPLY_IMPORT_ENABLED`), `zernioRecentReviewPollDisabled()` (the `ZERNIO_RECENT_REVIEW_POLL_DISABLED` kill-switch). |
| `orphan-markers.ts` | Single source of truth for the edit-publisher DELETE-before-POST recovery markers on `posting_error` (spec §4.5/§4.7): `PENDING_AFTER_DELETE`, `ZERNIO_AUTH_ERROR[_AFTER_DELETE]`, `deleteFailedMarker` / `postAfterDeleteFailedMarker`, `POST_AFTER_DELETE_FAILED_RETRY_EXHAUSTED`, `STALE_AFTER_REVIEW_CHANGED`, plus `isRecoverableFailedPostingError` (the `/retry` allowlist) and `isOrphanMarker`. Dependency-free. |
| `review-publisher.ts` | The `ReviewPublisher` seam (transport-only, locked 2026-06-26): `resolveTarget` / `publishReply` / `deleteReply` / `findReply` over neutral `ReviewRef` / `ReviewLocator` / `ResolveTargetResult` / `FindReplyResult` types. `getReviewPublisher(sql)` is the lazy singleton adapter selector; `getTransactionalReviewPublisher(tx)` the uncached, connection-locking variant for the auto-policy outcome lane. Error-taxonomy neutralization is deferred until a GBP adapter exists. |
| `zernio-review-publisher.ts` | `ZernioReviewPublisher` — the first adapter behind the seam. Owns the active `zernio_connections` lookup (optionally `FOR UPDATE`), review-id resolution + Redis page cache via `lookupZernioReviewId`, and the bounded verify walk (`MAX_VERIFY_PAGES` = 4); delegates transport to `zernioClient.postReply` / `deleteReply` / `listAllReviews` and reports raw publish failures to Sentry before rethrowing. |

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
| `auth-error-fallback.ts` | `applyTransientExhaustionFallback()` — single Postgres tx that flips `zernio_connections.status='disconnected'`, transitions the response to `awaiting_owner_connect`, and enqueues `send_owner_email` (connection_lost). Triggered when Zernio auth/transient errors exhaust retries. |
| `types.ts` | `EndpointKind`, `ZernioConnectionStatus`, `ZernioConnectionRow`, `ZernioReview`, `ZernioLocationOption`, `ConnectPendingMarker`. |
| `client/diagnostics.ts` | `summarizeShape(raw)` — JSON-safe key/type summary of an unknown response (never values) for `UNRECOGNIZED RESPONSE SHAPE` logs, so OAuth/connect tokens and account IDs cannot leak into worker logs. |
| `client/error-classifier.ts` | `classifyAndParse(res, endpointKind)` — maps a Zernio HTTP response to the typed errors: 401/403 → `ZernioAuthError`; `publish_reply` 409 → `ZernioReplyAlreadyExistsError` only for allowlisted codes (unknown 409 → transient), 404 → `ZernioReviewNotFoundError`; `select_location` 400 → `ZernioValidationError` only for `PRE_MUTATION_400_CODES`; other 4xx permanent (408/429 transient); 5xx transient. Handles the no-body endpoint set. |
| `client/locations.ts` | `createLocationClient(transport)` — `startConnect`, `listLocations` (shape-tolerant `normalizeLocations`), `selectLocation`, `listReviews` (forces an omitted `reviewReply` to `null`), `listAllReviews` (bounded pagination), `deleteAccount`. |
| `client/profiles.ts` | `createProfileClient(transport)` — `createProfile` (extracts the MongoDB-shaped `profile._id`, throws on an unrecognized shape) and `deleteProfile`. |
| `client/replies.ts` | `createReplyClient(transport)` — `postReply` and `deleteReply`; the delete endpoint requires `accountId` in the JSON body (**#355**). |
| `client/transport.ts` | `createZernioTransport(options)` / `request(opts)` — the fetch layer composed into `zernioClient` by `client.ts`: Bearer auth from `getServerConfig()`, per-call `AbortController` timeout (default 10s → `ZernioTransientError('request_timeout')`), network errors → `network_error`, already-classified errors preserved. `MOCK_EXTERNAL_APIS=true` short-circuits to a per-endpoint mock (`MOCK_ZERNIO_LOCATION_COUNT` locations, capped at 50). |

### `security/` *(Wave 1)*

| File | What it does |
|------|--------------|
| `phi-scanner.ts` | `detectLikelyPhi(text)` — conservative likely-PHI detector. Matches well-scoped MRN / insurance-identifier patterns (identifier + digits) and a co-occurrence rule (self-reference like `my`/`we` AND a medical-context term) to avoid quarantining ordinary reviews. `redactPhiForLog()` returns a placeholder so raw text never reaches logs. Used by every Zernio ingest path to block before persistence. |
| `botid-routes.ts` | `BOTID_PROTECTED_ROUTES` — single source of truth for the Vercel BotID-protected POST routes and their `checkLevel` (`deepAnalysis` on `/api/auth/signup`, `/api/onboarding/start`; `basic` on `/api/auth/login-attempt`, `/api/lead-intake`). Both `initBotId` in `src/instrumentation-client.ts` and the server gate derive from it — BotID requires identical client/server levels. `botIdOptionsForPath(path)` returns the `checkBotId()` options and throws for an unregistered path. Isomorphic (no server-only imports); `/api/contact` and `/api/demo-request` deliberately excluded. |
| `botid.ts` | Server-only. `botIdBlockResponse(path)` — the Vercel BotID gate: runs `checkBotId` with `botIdOptionsForPath(path)` and returns a 403 `NextResponse` when `isBot`, else `null`. Call it after the cheap deterministic guards (flag 404s, same-origin) and before rate limits or DB work. An unregistered path throws (not caught); a platform-check error is logged and **fails open**, matching the app-wide rate-limits-fail-open posture. |

### `legal/` *(Wave 1)*

| File | What it does |
|------|--------------|
| `content.ts` | Typed legal content module — the single source of truth for every `/legal/*` page (`legalDocs` keyed by slug; each `LegalDoc` has `version`, `effectiveDate`, and ordered `sections`). Includes the reconciled sub-processor table. No MDX/markdown runtime dependency. |

### `ui/` *(Wave 1)*

| File | What it does |
|------|--------------|
| `disclosures.ts` | Shared user-facing copy. Exports `AI_DRAFT_DISCLOSURE` ("Draft generated by AI. Review carefully before approving.") so the public approval page and the in-app edit drawer render one identical string. |
| `cn.ts` | `cn(...values)` — joins truthy class values into one className string for the `cn('base', cond && 'active')` conditional-composition pattern; drops `false` / `null` / `undefined` so there are no empty or duplicate-space segments. |

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

### `worker/` — root modules (boot, lifecycle, sinks)

Side-effect-free helpers that `worker/index.ts` wires at boot — Redis options, Sentry init, the two error sinks, log-context wrapping, the shutdown handler, and the transient-rejection governor. `env.ts`, `index.ts` and `queues.ts` keep their own headings above.

| File | What it does |
|------|--------------|
| `emitter-errors.ts` | `attachEmitterErrorLogger(emitter, source)` — non-fatal `'error'` sink for BullMQ Workers/Queues and raw ioredis clients (an unlistened emitter `'error'` becomes a fatal `uncaughtException`). Logs a structured warning plus a Sentry `worker_emitter_error` message; a per-source 60s window reports the first error, counts and suppresses the rest, and surfaces the suppressed count when the next window opens. The listener never throws. |
| `job-failure-sink.ts` | `attachJobFailureSink(worker, queueName)` / `reportJobFailure()` — on a BullMQ `'failed'` event whose `attemptsMade >= attempts`, raises a real Sentry issue tagged `{subsystem, queue, topic}` and logs a bounded error class. Keeps its own `'failed'`-EVENT terminal test (deliberately not `isTerminalAttempt`) and never writes `job_outbox`. **(#719)** |
| `job-log-context.ts` | `extractJobLogContext(job)` reads `worker_job_id`, `correlation_id`, `account_id`, `business_id`, `review_id`, `response_id` from a BullMQ payload plus a fresh `request_id`; `withJobLogContext(handler)` wraps a processor in `withLogContext` so every log line during the job carries them. Applied at registration in `worker/index.ts`; handlers add `account_id` later via `mergeLogContext`. |
| `redis-connection.ts` | `getRedisOptions()` builds the BullMQ ioredis options from `REDIS_QUEUE_URL`/`REDIS_QUEUE_TOKEN` — local `redis://`, Railway private-net `?family=0` (IPv6-only), `rediss://` TLS, or an Upstash REST URL; `parseRedisFamily()` accepts only the literals `0`/`4`/`6`. Side-effect-free: importing it opens no connection, so it is unit-testable without `worker/queues.ts`. |
| `sentry.ts` | Side-effect module: `Sentry.init` with `SENTRY_DSN`, `tracesSampleRate 0.1`, `environment: deploymentLane()` (not `NODE_ENV` — #610) and `scrubSentryEvent` as `beforeSend`; then tags every event with `replicaIdentityFields(readReplicaIdentity())` so a second replica shows up as a second `replica_id` under one `deployment_id` **(#567)**. Re-exports `Sentry`. |
| `shutdown.ts` | `createGracefulShutdown(deps)` — the SIGTERM/SIGINT handler with every dependency injected (`GracefulShutdownDeps`). Idempotent across repeated signals, bails if the fatal-exit crash net is already running, arms a force-exit watchdog first, aborts the boot coordinator **(#505)**, stops loops, drains and flushes analytics + Sentry BEFORE the blocking `closeWorkers()`, then closes queues, server, analytics and DB. Every step is log-and-swallow. |
| `transient-rejection-governor.ts` | `createTransientRejectionGovernor({sustainedMs, idleResetMs})` — pure, clock-injected governor deciding when recovered transient-DB `unhandledRejection`s stop being transient. `record(nowMs)` returns true once an uninterrupted storm has lasted `sustainedMs` (default 10 min); a quiet gap of `idleResetMs` (default 5 min) resets it, so a boot fan-out burst never escalates to a fatal exit. |

### `worker/config/` — boot-time configuration modules

Ingress-server options and Railway/env readers consumed at boot; `startup-assert.ts` keeps its own heading above.

| File | What it does |
|------|--------------|
| `content-type-parsers.ts` | `registerIngressContentTypeParsers(app)` — registers an `application/x-www-form-urlencoded` parser (`parseAs: 'string'`, body passed through untouched) so Fastify accepts Twilio WhatsApp inbound and status-callback POSTs instead of rejecting them with 415 before the handler runs; the Twilio handlers parse `request.rawBody` themselves. |
| `fastify-options.ts` | `buildFastifyOptions(productionConfigRequired)` — the ingress server's `FastifyServerOptions`: 30s request / 60s keep-alive / 10s connect timeouts, 5 MB body limit, log level `warn` on production lanes, and URL redaction for the whole server — `serializers.req` runs `redactSensitivePathsAndQueries` on `req.url`, pino `redact` runs `redactSensitiveTokenPaths` over `msg`/`err.message`/`err.stack` (invariant #5). Reads no `process.env`; the caller resolves the lane. |
| `replica-identity.ts` | `readReplicaIdentity(env?)` reads the Railway system variables (`RAILWAY_REPLICA_ID`, `RAILWAY_DEPLOYMENT_ID`, region, service, environment) into a `ReplicaIdentity` with `onRailway`; `replicaIdentityFields()` turns it into log/tag fields (defined values only). Detection surface for the single-replica invariant — a second `replica_id` under one `deployment_id` means the service was scaled **(#567)**. |
| `startup-side-effect-guard.ts` | Side-effect module: calls `assertWorkerStartupEnv()` from `startup-assert.ts` at import time and, on failure, prints `[worker] Startup assertion failed: …` and `process.exit(1)`. Exports nothing. |



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
| `zernio/ZernioReviewIngestWorker.ts` | `ingest_zernio_review` | Zernio webhook → outbox → this handler. Per-location `listReviews` call, runs `guardZernioJobEligibility` + the PHI gate, then `processReview` — dedup on `(provider, provider_review_name)`, INSERT `reviews`, start the run spine, enqueue `generate_response` via outbox (the `responses` row is created later by `ResponseGeneratorWorker`). Migration 030's partial unique index on `(business_id, zernio_review_id)` keeps in-flight rows from duplicating during webhook retries. Maps `ZernioReviewNotFoundError` to a `review_exceptions` row + admin alert. |
| `zernio/ZernioBackfillWorker.ts` | `zernio_initial_backfill` | **(#675)** Consented Review import executor — NOT an answering backfill. Pure `selectImportWindow`: newest 100 reviews with `createTime ∈ [now − 12 months, live-ingest cutoff)` (CONTEXT.md glossary; upper bound keeps lane ownership disjoint from the live lane). Pages `listReviews` up to `ZERNIO_IMPORT_MAX_PAGES` (default 6); cap-out with target unmet is TERMINAL (`ZernioImportPaginationCapExhaustedError`, failed outbox row + Sentry, `completed_at` NULL for ops re-enqueue); non-descending pages disable both early stops (best-effort to feed end). **(#679)** Runs `guardImportConsent` FIRST — before `guardZernioJobEligibility` and before the run-row INSERT — so a job for a non-`accepted` business no-op-completes and mints no run row. Unanswered → `importReview` (zero `job_outbox` writes); answered → `reconcileExternallyAnsweredReview({consentedImport:true})`. Writes ONLY collapsed `imported_count`/`skipped_count` on `zernio_backfill_runs` — the four legacy gap/historical counters freeze at DEFAULT 0, DROP at #680 after a reconciliation preflight. Concurrency 1 (heavy). Subscription-guarded. |
| `ResponseGeneratorWorker.ts` | `generate_response` | Loads review + business context, calls `generateResponse()`, saves draft, enqueues notification via outbox. **(WS5)** terminal draft failures close the matching outbox attempt and complete the active review run as failed in one reviews-first transaction. **(#728, ADR 0017)** `persistResponseAndNotify` (`response-generation/persist.ts`) runs the lane-independent **content-freshness gate** before the lane split: under the review `FOR UPDATE` lock (the tx's first statement) it re-reads `review_content_hash`; both hashes non-null and different → skip-the-INSERT, and the handler completes the job with `markOutboxCompletedWithReason(…, STALE_REVIEW_CONTENT, …)` — nothing written, the `(review_id, version)` slot stays free for the colliding fresh job. Null on either side passes. |
| `notification/NotificationWorker.ts` | `send_notification` | Orchestrates the notification send loop. Delegates context loading to `notification/context.ts`, eligibility filtering to `notification/eligibility.ts`, and per-channel dispatch to `notification/dispatch.ts`. Skips `pending_payment` and `cancelled`. |
| `escalation-notice/EscalationNoticeWorker.ts` | `escalation_notice` | **(WS3)** Sends the Guardian escalation notice to the owner's channels. Re-checks `ESCALATION_ENABLED` at SEND time (kill switch stops outbound notices without hiding raised escalations), reuses the approval worker's eligibility primitive, then hands off to `escalation-notice/dispatch.ts`. Afterwards records the `escalation_sent` step BEST-EFFORT (log-and-swallow — `notification_deliveries` is the authoritative per-channel record). |
| `auto-post-notice/AutoPostNoticeWorker.ts` | `auto_post_notice` | Sends the auto-approved post FYI ("your reply was posted") to the owner's channels after an `auto_policy` publish. Reuses the approval worker's eligibility primitive, then hands off to `auto-post-notice/dispatch.ts`. NEVER mutates the already-posted response — a send failure retries on this job alone. |
| `pending-post-notice/PendingPostNoticeWorker.ts` | `pending_post_notice` | **(WS4)** Sends the veto-window "your reply will post automatically" notice. Re-checks `AUTO_APPROVAL_ENABLED` at SEND time (spec §2.12; flag off ⇒ complete without sending — the publisher's downgrade backstop owns the record), loads the still-scheduled `auto_policy` response via `pending-post-notice/context.ts` freshness guards, reuses the approval worker's eligibility primitive, then hands off to `pending-post-notice/dispatch.ts`. NEVER mutates the response; the delayed publish outbox row is independent and fires at the deadline regardless. |
| `AutonomyAdminAlertWorker.ts` | `autonomy_admin_alert` | **(WS6)** Renders an internal account-suspension alert from bounded trigger/evidence facts, sends it to `ADMIN_NOTIFICATION_EMAIL`, then independently attempts Sentry warning telemetry so observability cannot poison a successful email path. |
| `billing/StripeSubscriptionMirrorSyncWorker.ts` | `stripe_subscription_mirror_sync` | **(WS8)** Converges deprecated business subscription status/activation from canonical account state. Locks business rows in id order, then entitlement, reads the account without a row lock, updates the mirror, and completes the originating outbox entry in one transaction. |
| `publisher/ResponsePublisherWorker.ts` | `publish_response` | POST-only flow. Checks `zernio_connections` for the business. **WS6:** every unposted `auto_policy` response first passes the judge flag/health gate; disabled or unhealthy downgrades to owner review under a durable audit action, while query failures retry. Active Zernio → resolves review ID + posts via `zernio-publisher.ts`, marking `posted`. Connection required but absent → transitions to `awaiting_owner_connect` + enqueues `send_owner_email` (reconnect_required). Uses `publisher-error-handlers.ts` for error classification. The DELETE+POST edit branch (`runEditPublisherIfApplicable`) is parked on tag `wip/edit-existing-replies-zernio-v1` pending direct GBP API. |
| `DrainOwnerConnectWorker.ts` | `drain_pending_owner_connect` | Re-enqueues stuck `publish_response` outbox rows when an owner (re)connects Zernio. Inserts fresh outbox entries for all `awaiting_owner_connect` responses, with three layers of idempotency (partial unique index, NOT EXISTS guard, ResponsePublisher early-exit). |
| `OwnerEmailWorker.ts` | `send_owner_email` | Discriminated payload router for owner-directed Zernio emails. `reconnect_required` → owner needs to reconnect Zernio so the queued reply can be published. `connection_lost` → Zernio reported GBP connection went offline. Both handlers apply subscription guard + bounce check + claim-before-send deduplication. |
| `AdminExceptionWorker.ts` | `notify_admin_review_exception` | Sends an internal alert email when a review processing failure requires human review. |
| `WeeklySummaryWorker.ts` | `weekly_summary` | Queries 7-day metrics and sends the Insights-labeled weekly report via Resend. **(WS5)** a newly claimed send first records and completes a `weekly_insights` run with a `digest_sent` step/outcome in the same transaction as the `sent_at` flip; replayed claims emit neither spine rows nor email. |
| `PlaceIdValidationWorker.ts` | `validate_place_id` | Verifies a Place ID is still accessible via SerpAPI; updates `place_id_verified` flag. |
| `MonthlyImpactWorker.ts` | `send_monthly_impact` | Generates monthly impact report email. |
| `EngagementAlertWorker.ts` | `engagement_alert` | Checks engagement thresholds, sends alert if below floor. |
| `RankingTrackingWorker.ts` | `track_ranking` | Calls SerpAPI for each keyword, saves ranking snapshots. |
| `OnboardingDripWorker.ts` | `onboarding_drip` | Sends onboarding email at the configured step (day 1 / 7 / 30). |
| `DemoGenerationWorker.ts` | `generate_demo` | Fetches SerpAPI reviews for a prospect, calls `generateResponse()` in `demo` mode, saves to `prospect_demos`. |
| `csv-ingest/index.ts` | `csv_ingest` | **(#541)** Contacts/visits CSV ingest (`handleCsvIngest`). Subscription gate derived from the upload row's business→account join (`subscriptionGrantsFullAccess`, invariant #11 — gated accounts leave the upload `pending`); delegates all match/merge/upsert + report behavior to `src/lib/solicitation/ingest.ts`. PII contract: logs counts/ids only — never names, handles, notes, or raw CSV. |
| `live-draft-guard.ts` | — (helper) | **(WS5)** `hasLiveOwnerActionableResponse(tx, reviewId)` — shared by `ResponseGeneratorWorker` and `publisher/failed-hook` terminal checkpoints; a run is never completed `failed` while an owner-actionable draft (non-terminal status) exists for the review. |
| `OnboardingDemoWorker.ts` | `onboarding_demo_response` | `handleOnboardingDemo` — pre-pay onboarding demo. Mock-leak guard on production-config lanes **(#611)**, inverted subscription guard (account no longer `pending_payment` → `failDemo`), `claimDemo` → resolve place → build source (SerpAPI or curated fallback) → `completeDemo`. Reconciles the 20¢ cost-guard reservation via `finalizeOnboardingDemoCost`; threshold check + Sentry are best-effort. Helpers in `onboarding-demo/`. |
| `summary-report-helpers.ts` | — (helper) | Shared by `WeeklySummaryWorker`, `MonthlyImpactWorker`, `OnboardingDripWorker`. `prepareSummaryReport` loads the business⋈account row and applies the skip gates (`completeOrFailSkippedSummaryReport`: not found → failed; archived / subscription-denied / bounced email → completed); `sendSummaryReportEmail` marks the outbox failed on send error; `loadLatestRankingSummary`, `resolveDashboardUrl` (post-034 owner join, **#719**), `calculateBaselineResponseRate`, `mapSummaryReviews`. |

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
| `outcomes.ts` | `DispatchOutcome` — the `{ attempted, succeeded }` counters `dispatch.ts` returns. |
| `plan.ts` | Canonical channel dispatch order (`NOTIFICATION_DISPATCH_CHANNEL_ORDER = CHANNEL_IDS`). `buildNotificationDispatchPlan` filters it by eligibility; `orderNotificationDispatchEnrollments` sorts enrollments into that order and drops unknown/stale channel rows (e.g. `'sms'`) instead of crashing. Used by `dispatch.ts`. |

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
| `activation.ts` | `maybeCaptureActivationCompleted(sql, …)` — best-effort, never-throwing analytics capture after a post: one query finds the account's first posted response (within an 8-day superset window); if this response is it, builds `activation_completed` via `buildActivationCompletedEvent` and calls `captureAnalyticsEvent`. reviewId mismatch is logged and skipped. |
| `auto-policy-publish.ts` | `publishAutoPolicyResponse` — the auto-policy provider lane as a durable three-phase protocol: (1) lock + revalidate every gate, persist marker `armed`; (2) resolve target, persist `possible` with its locator; (3) CAS-complete, post/verify, mutate state. A `possible` marker on retry reconciles provider truth before any local decision (WS6 suspension recheck under the entitlement lock). `hasAutoPolicyProviderAttemptMarker` reads the payload marker. |
| `edit-publish-errors.ts` | Error-disposition policy for the DELETE-before-POST edit flow (spec §4.5 outcome table). `handleDeleteError` / `handlePostError` map Zernio errors to a `TxCatchOutcome` (`auth_completed`, `permanent_failed`, three 409 sub-cases, `commit_then_throw`, `rollback_then_throw`) using the `-tx` leaf and `mark-posted`; never imports `edit-publish.ts`. |
| `edit-publish-tx.ts` | Leaf in-tx row mutations for the edit-publisher: `supersedeSibling`, `setOrphanMarker`, `markCandidateOrThrow`, `markCandidatePermanentFailedInTx`, `applyAuthErrorTerminalInTx`. Each enforces the publishable-status guard and asserts the affected-row count (`candidate_lost_during_publish` / `sibling_lost_during_publish`) so a lost row fails loudly. |
| `edit-publish.ts` | `runEditPublishIfApplicable` — orchestrator for the DELETE-before-POST edit flow. Phase A: non-locking pre-flight (sibling `posted` row or orphan marker, else `continue_to_fresh`). Phase B: one tx holding `reviews`/`responses` FOR UPDATE across DELETE then POST; a DELETE 404 counts as success. Returns an `EditPublishOutcome` — the dispatcher owns the outbox lifecycle. |
| `held-flag-gate.ts` | `isHeldForModerationReview` / `…InTx` — belt-and-suspenders publish gate: true when an OPEN moderation flag exists for the response (`hasOpenFlag`), so a flagged draft can never be posted even if advanced to an approved status. The non-tx form takes the business-scoped response FOR UPDATE lock first. |
| `load-context.ts` | `loadPublishResponseContext` — parallel pool reads of the response row and the business⋈account⋈active-offboarding projection; response not found / `business_id` mismatch / business not found → `markOutboxFailed` and `'terminal'`. Returns `PublishResponseContext`. |
| `mark-posted.ts` | `markPostedAndMaybeEnqueueAutoPostNotice` — the single "mark posted" transition every success path calls INSIDE one tx: status flip + `auto_post_notice` FYI enqueue only when exactly one row transitions AND `approval_method='auto_policy'` (owner posts get no FYI); also the run spine's terminal checkpoint (`reply_posted` step/outcome, `completeRun`). `recoverAutoPolicyProviderTruth` repairs local state after a confirmed provider reply. |
| `no-connection.ts` | `parkResponseForOwnerReconnect` / `…InTx` — flips a publishable response to `awaiting_owner_connect` and inserts a `notify_owner_reconnect` outbox row (`reconnect_required`) in the same tx; already-terminal rows skip the notify. The non-tx form completes the outbox row. |
| `post-reply.ts` | `postReplyAndHandleTerminalOutcomes` — fresh-lane `publishReply` through the `ReviewPublisher` seam, then `verifyOwnReplyAttached` before returning `'posted'`. 409 → `verify409AndDispose`; auth / permanent → the terminal handlers in `publisher-error-handlers.ts` (`'completed'`); transient → `PublisherTransientWithContext` for BullMQ retry. |
| `review-lookup.ts` | `resolvePublishTarget` — resolves the target through `getReviewPublisher(sql).resolveTarget` and dispositions non-success: `no_connection` → park for reconnect; `review_not_found` → `openReviewNotFoundExceptionInTx` (response `failed` + `zernio_review_id_mismatch` `review_exceptions` upsert + `NOTIFY_ADMIN` outbox row); transient → rethrow with context. |
| `verify-posted.ts` | `verifyOwnReplyAttached` — post-publish verification after a 2xx: re-fetches via `publisher.findReply` and compares canonicalized reply text. Absent review / null reply / text mismatch → `ZernioReplyVerificationIndeterminateError` (landed by the failed-hook); a failing LIST call → `PublisherTransientWithContext` so the next attempt 409s into `verify409AndDispose`. |
| `veto-window-gate.ts` | `enforceElapsedVetoWindow` / `…InTx` — spec §2.11 gate for `auto_policy` publishes: a FULL veto window (from the `auto_approved_by_policy` audit row's `veto_window_minutes`) must have elapsed since the FIRST delivered `pending_post_notice`. Outcomes: `proceed`, `downgrade` (zero notices delivered), `completed` (deadline pushed once to `first_sent + window` and a fresh delayed publish row enqueued). |

#### `worker/jobs/response-generation/` — ResponseGeneratorWorker helpers

Phases of `ResponseGeneratorWorker.ts`, each returning a discriminated outcome the worker maps to an outbox effect.

| File | What it does |
|------|--------------|
| `analytics.ts` | `maybeEnqueueFirstResponseDrafted` — best-effort `first_response_drafted` analytics enqueue, run AFTER the response commits so it can detect the account's first draft against committed rows; `event_key` + `ON CONFLICT` keep retries from double-counting; failures are logged and swallowed. |
| `auto-approval.ts` | Auto-approval decision logic. `loadAutoApprovalRuntimeState(tx, …)` re-reads current-state facts (hash, rating, tier, active location/connection, triage, today's grant count) under the lock; `isAutoApprovalCandidate` / `structurallyBlockedDecision` decide from env + job inputs alone (no DB read); `evaluateAutoApprovalCandidate` applies every gate and returns `AutoApprovalDecision` with typed `AutoApprovalBlockReason`s. |
| `generate-draft.ts` | `generateDraft` — voice-learning fetch → regen-budget check → LLM generation (mock or real) → avoid-facts guardrail. Owns failure classification: transient (`TransientLLMError`, `CostInfraUnavailableError`, `ConcurrencyLimitExceededError`) re-throws for BullMQ retry; cost-cap exhaustion is terminal with a Sentry alert. Returns `DraftOutcome`. |
| `load-context.ts` | `loadGenerationContext` — pre-generation gate: reads review + business rows, builds `NormalizedReview` / `BusinessContext`, runs the subscription and offboarding guards, and performs the idempotency check. Returns `LoadOutcome` (`ready` / `review_not_found` / `business_not_found` / `skipped` / `already_exists`); merges `account_id` into the log context. No outbox writes. |
| `persist.ts` | `persistResponseAndNotify` — the invariant #4 transactional boundary: content-freshness gate (ADR 0017, `hasStaleReviewContent` → `skipped_stale_content`, zero writes), response INSERT + `api_costs` links, moderation record and high-severity HOLD (`flagged_responses`, no notification), run-spine draft checkpoints, then the auto-approval decision — approve + audit log + delayed `publish_response` + `pending_post_notice`, or `send_notification` — all in ONE tx. |
| `triage.ts` | **(WS2)** `runTriagePhase` — flag gate → non-positive-sentiment lane only → `triage_content_hash` idempotency check (fallback and out-of-mode mock rows are re-attempted) → cost-guarded `classifyReviewTriage` → `persistTriage` in a tx stamping the LOADED content hash. Returns the severity for tone guidance (null = not triaged). |


#### `worker/jobs/zernio/` — Zernio ingestion helpers

| File | What it does |
|------|--------------|
| `job-eligibility.ts` | Shared pre-flight gate for both Zernio job workers. `guardZernioJobEligibility()` — one `businesses ⋈ accounts` row, then the project's archived-before-subscription guard order; every skip is skip-as-success (outbox row COMPLETED, never failed or retried). **(#679)** `guardImportConsent()` — the fail-closed **Import consent** gate the BACKFILL worker runs first. Proceeds only on `accepted`; `pending`/`declined`/derived `expired`/missing row all log a structured `reason` and complete. Deliberately a SEPARATE export, not a `jobKind` branch, so the ingest worker never learns the interface. Its whole body runs in `sql.begin` with `SELECT … FOR UPDATE` + `markOutboxCompletedWithReason(tx, …)` — both load-bearing against the accept-races-guard data-loss window — and derives expiry through the imported `importConsentStateSql` fragment, which is why its query MUST alias `businesses` as `b`. **(#695)** That completion stamps `job_outbox.completion_reason = 'import_consent_blocked'` (`OUTBOX_COMPLETION_REASON`; column from migration 083), so a policy refusal is separable by SQL from a genuine completed import for the 7-day archival window — an operational signal, not an audit record, and nothing reads it in code (ADR 0016). `guardZernioJobEligibility`'s three skips deliberately keep using plain `markOutboxCompleted`, leaving `completion_reason` NULL. |
| `zernio-ingest-shared.ts` | Shared helpers for `ZernioReviewIngestWorker` and `ZernioBackfillWorker` — webhook fan-out (insert one outbox row per active Zernio connection), pagination state, `processReview()` deduplication, and outbox claim helpers. **(#675)** `liveIngestCutoff()` — single owner of the Live-ingest cutoff (`connected_at − grace`), consumed by `ZernioRecentReviewPoller` (≥ cutoff) and the consented import (< cutoff). Also `reconcileExternallyAnsweredReview()` (PHI-gates before each import branch; `consentedImport` option imports answered rows flag-independently, incl. the branch-3 consented tail via `phiGateAndImportExternalReply`) and **(Wave 1)** `openPhiReviewException()` — opens a `zernio_likely_phi_review` exception + admin-notify outbox row in one **caller-owned** transaction (`sql.begin`), idempotent via `ON CONFLICT DO NOTHING`, Sentry only on a newly-created row. |
| `ingest-failed-hook.ts` | `handleIngestFailed` — retry-exhaustion hook for `ZernioReviewIngestWorker`. Escalates the worker's typed errors (`ZernioIngestReviewNotFoundError`, `ZernioIngestPaginationCapExhaustedError`, `ZernioIngestUnparseableLocationError`) to `review_exceptions` inside a CAS-first coupled tx (`markOutboxFailed` owns the terminal transition; stale attempts write nothing); admin notify skipped for review-not-found, pagination cap is a Sentry trend signal only. Top-level guard: never throws out of a bare `'failed'` listener. |

#### `worker/jobs/onboarding-demo/` — OnboardingDemoWorker helpers

Small dependency-injected pieces of `OnboardingDemoWorker.ts`; each takes its collaborators as arguments.

| File | What it does |
|------|--------------|
| `demo-source.ts` | `buildOnboardingDemoSource(sql, …)` — fetches SerpAPI reviews, selects qualifying ones (`positive-with-moderate-tail`), and generates responses; a SerpAPI failure or no ≥4-star anchor degrades to `getFallbackDemo` curated content (`source: 'curated_fallback'`, zero cost) instead of failing the demo. |
| `place-resolution.ts` | `resolveOnboardingDemoPlaceId` — returns the payload Place ID when already valid; in mock mode any non-empty string passes; otherwise parses `googleMapsUrl` and resolves via `resolvePlaceId`; throws when neither is usable. |
| `reservation.ts` | `releaseOnboardingDemoReservation` — calls the injected `finalizeCost(date, 0)` to release the pessimistic reserve on every no-work path; no-op without a reservation date; logs and swallows failures. |
| `terminal.ts` | `failOnboardingDemoTerminal` — wraps `failDemo('onboarding_demos', …)`; logs a `subscription_state_changed`-specific or generic message when the failure record itself cannot be written, then re-throws. |

#### `worker/jobs/solicitation-batch/` — solicitation batch package

Composition roots for the two solicitation queues plus their exhaustion hooks; domain behavior lives in `src/lib/solicitation/`.

| File | What it does |
|------|--------------|
| `index.ts` | `handleSolicitationBatch` — success-path root for `build_solicitation_batch`: requires an exact `outbox_attempt`, calls `buildSolicitationBatch`, then emits one PII-free structured log line per outcome (`built` with counts + `send_handoff` **(#656)**, `gate_closed`, or skip); logging is try/catch-swallowed so it never turns a completed job into a retry. |
| `generate.ts` | **(#628)** `handleGenerateSolicitationAsks` — success-path root for `generate_solicitation_asks`: routes `ask_id` payloads to `regenerateAsk`, otherwise `generateAsksForBatch`. The domain completes the owned outbox attempt on every non-transient path, so this handler never touches the outbox row; transient errors propagate for BullMQ retry. |
| `failed-hook.ts` | `handleSolicitationBatchFailed` — exhaustion terminalizer for `build_solicitation_batch`: one tx with the outbox `markOutboxFailed` CAS as its FIRST statement, then (winner only) `failSolicitationBatchRun` on the matching running parent. The unbuilt batch stays with `built_at` NULL. A failed coupled tx leaves the row dispatched for the watchdog. |
| `generate-failed-hook.ts` | `handleGenerateSolicitationAsksFailed` — exhaustion handler for `generate_solicitation_asks`. Retryable classes (`TransientLLMError`, `CostInfraUnavailableError`) with watchdog budget left stay `dispatched`; whole-batch terminal failures run `settleGenerationExhaustion` (CAS + domain settlement) with bounded in-hook retries and a `grantSettlementRedrive` handoff to the watchdog; regeneration jobs get the bare attempt-guarded CAS. |
| `failed-hook-shared.ts` | The mechanics both hooks share, owned once (clone caught on **#628**): `isExhaustedJob` (BullMQ attempt arithmetic), `boundedErrorClass` (log-safe constructor name), `makeFailureLogger` (log-and-swallow reporter). Deliberately not generalized to other lanes. |

#### `worker/jobs/billing/` — billing workers + helpers

Stripe-facing billing handlers and their helpers (`billing/StripeSubscriptionMirrorSyncWorker.ts` keeps its row in the main table above).

| File | What it does |
|------|--------------|
| `StripeCheckoutReconcileWorker.ts` | Queue `stripe_checkout_session_reconcile` (`handleStripeCheckoutReconcile`) — retrieves the Checkout Session, fails the outbox row on a `client_reference_id`/account mismatch, otherwise re-runs `processCheckoutSessionCompleted` from `worker/ingress/stripe/checkout-completed.ts` and marks the outbox row completed; any throw marks it failed and rethrows. |
| `UpdateStripeOverageWorker.ts` | Queue `update_stripe_overage_quantity` (`handleUpdateStripeOverage`) — under `acquireBillingLock` + `accounts FOR UPDATE` re-checks offboarding state, Stripe subscription, `subscriptionGrantsFullAccess`, tier/variant, then counts unarchived locations → `computeOverageQuantity` → `syncStripeOverageItem`. Maps the outcome onto ONE outbox effect: transient Postgres/Stripe errors leave the row `dispatched` (`recordOutboxTransientError`); terminal → `markOutboxFailed` + `UnrecoverableError`; `ambiguous` also pages Sentry. Concurrency 1. |
| `overage-sync.ts` | `syncStripeOverageItem(stripe, input, logger)` — the Stripe interaction for one overage recompute: retrieve subscription → `resolveOverageItem` (confidence-graded) → exactly one mutation (delete/update/create). Returns `OverageSyncOutcome` (`applied | noop | policy_blocked | ambiguous`), honours `mutationPolicy: 'contractions_only'` during offboarding, throws raw Stripe errors for the caller to classify. Idempotency keys are per-outbox (`operationScope`) on purpose — a stable per-subscription key would 400 on delete→re-add. |
| `stripe-overage-error.ts` | `classifyStripeOverageError(err)` → `transient | terminal`, the retry policy for `UpdateStripeOverageWorker`. Vocabulary comes from `src/lib/payments/stripe-error-inspect.ts`; the policy delta here: a 409 in-flight idempotency conflict is TRANSIENT (offboarding treats all idempotency errors as permanent), 400 `idempotency_error` terminal, 429/5xx/network codes transient, other 4xx and unknown terminal. |

#### `worker/jobs/account-offboarding/` — offboarding workers

Five BullMQ handlers for the `account_offboarding_*` topics enqueued by `src/lib/account-offboarding/outbox.ts`, plus the teardown step modules and purge stages they orchestrate. Every handler loads its `account_offboardings` row, skips already-terminal rows, rethrows on non-terminal attempts and marks `failed` + `failed_step` only on the terminal attempt; error text is redacted via `scrubOffboardingErrorForStorage`.

| File | What it does |
|------|--------------|
| `AccountOffboardingEmailWorker.ts` | Queue `account_offboarding_email`. `handleAccountOffboardingEmail`: `EMAIL_DESCRIPTORS` (one entry per row-backed email type — template, subject, validation, body) drives load → validate → claim a deterministic `notification_deliveries` row → `sendInternalEmail` under a deterministic Resend idempotency key; `delete_data_confirmation` mints/reuses the keep-my-data token. Terminal-row emails null `recipient_email` after send (best-effort). `purge_receipt` is row-less: recipient comes from the payload, and outbox completion + payload scrub are one UPDATE. |
| `BillingScheduleWorker.ts` | Queue `account_offboarding_billing_schedule`. `handleAccountOffboardingBillingSchedule`: for a `pending` cancel_only row, Stripe `subscriptions.update({cancel_at_period_end:true})` under a deterministic idempotency key, reads `current_period_end` (subscription item first, then the legacy top-level field), then in one tx sets `scheduled` + `access_ends_at` + `stripe_step='success'`, enqueues the confirmation email and completes the outbox. Terminal attempt marks `failed` / `failed_step='billing'` (recoverable via `retry-billing.ts`); Sentry `account_offboarding_billing_schedule_failed`. |
| `PurgeWorker.ts` | Queue `account_offboarding_purge`. `handleAccountOffboardingPurge(sql, supabaseServer, job)`: `validatePurgeableOffboarding`, then the strictly ordered `purge-stages.ts` stages (auth binding → dependent refs → raw payloads → content → analytics → provider identifiers → audit/cost payloads → parent tombstone) and `finalizePurgeInTransaction`. Stale outbox attempts exit silently; retryable failures stamp `last_error` and rethrow; the terminal attempt marks `failed` / `failed_step='purge'`. Sentry `account_offboarding_purge_failed`. |
| `ReactivationWorker.ts` | Queue `account_offboarding_reactivation`. Thin: calls `reactivateCancelOnlyOffboarding` with the payload's actor + idempotency-key hash, completes the outbox on success, otherwise fails it with `account_offboarding_stripe_reversal_unavailable` or `account_offboarding_reactivation_<reason>`. |
| `TeardownWorker.ts` | Queue `account_offboarding_teardown`. `handleAccountOffboardingTeardown` for both modes: cancel_only first requires `access_ends_at` passed and Stripe reporting `canceled`; marks `tearing_down`, then runs `teardown-stripe` → `teardown-zernio` → `teardown-locations` → `teardown-outbox`, each idempotent on its `*_step` column. `finalizeTeardown` derives the terminal status from the LIVE `purge_cancelled_at` (delete_data → `purge_scheduled`, or `churned` if keep-my-data landed mid-flight; cancel_only → `churned` + `cancel_only_access_end` email). Terminal failures set `failed` / `failed_step='teardown'` plus the failing step column. |
| `purge-helpers.ts` | Pure leaf helpers for the purge: `jobOutboxScrubScopeRecord` / `impersonationSessionScrubScopeRecord` (the scope records appended to `provider_dispositions`: id + SHA-256), `safeSupabaseError` / `isSupabaseAuthNotFound`, and `deleteByBusiness(tx, table, accountId)` — the allowlisted (`DELETABLE_BY_BUSINESS`) by-business DELETE so the dynamic table identifier is never untrusted. |
| `purge-stages.ts` | The eight `run*PurgeStage` bodies, each its own `sql.begin` (auth binding = Supabase `deleteUser` then detach `users.auth_id`; content stage takes the csv-ingest + solicitation-batch advisory locks first **(#582, #624)**; raw-payload stage scrubs `inbound_events` / `job_outbox` by identifier scope), plus `finalizePurgeInTransaction` — locks the current outbox attempt, scrubs the row, runs `verifyAccountOffboardingPurge`, sets `purged` + terminal, enqueues the durable `purge_receipt` email **(#643)**. `validatePurgeableOffboarding` guards force-transitioned rows. |
| `teardown-locations.ts` | `runLocationTeardown(sql, row)` — archives each snapshotted location sequentially via `archiveLocationForAccountOffboardingTeardownTransaction` (one tx per location under the account lifecycle lock), then stamps `location_archival_step='success'`; empty snapshot → `not_applicable`; already-`success` returns early. |
| `teardown-outbox.ts` | `runOutboxTerminalization(sql, row, currentOutboxId)` — completes still-`pending` `job_outbox` rows the account no longer needs: `generate-response` / `send-notification` / `publish-response` / `auto_post_notice` rows for the snapshotted locations, and sibling `account_offboarding_{billing_schedule,reactivation,teardown}` rows for this offboarding (never the running job); then stamps `job_terminalization_step='success'`. |
| `teardown-stripe.ts` | `runStripeTeardown(sql, row)`: delete_data cancels the subscription now (`invoice_now:false, prorate:false`, deterministic idempotency key; already-canceled / missing tolerated after a status re-check), then both modes run `cleanupSubscriptionInvoices`; stamps `stripe_step`. `verifyCancelOnlyNaturalCancellation` throws unless Stripe reports `canceled` — the cancel_only precondition (Stripe cancels at period end; teardown never cancels it). |
| `teardown-zernio.ts` | `runZernioTeardown(sql, row)` — sequentially `zernioClient.deleteAccount` for each snapshotted Zernio account id, then `deleteProfile` for each profile id, stamping `zernio_accounts_step` / `zernio_profiles_step` (`not_applicable` when empty). `ZernioPermanentError` `http_404` / `http_410` counts as already gone; every other error propagates. |





### `worker/background/` — Background Loops (Pollers & Schedulers)

These are not BullMQ job handlers — they run as standalone loops inside the worker process. Split into two subfolders by trigger model: `pollers/` react to Postgres state, `schedulers/` fire on time-based cadences.

#### `worker/background/` — shared loop primitives

Root-level helpers every poller/scheduler composes; none is a loop itself. Wired from `worker/index.ts`.

| File | What it does |
|------|--------------|
| `boot-stagger.ts` | **(#505)** Boot-storm hardening: spreads the DB-backed loops' first cycles across a bounded, jittered window instead of firing ~24 loops on one tick. Pure `computeBootSchedule` + thin shells `staggerBoot` (cancel/abort skips un-fired starts), fail-open `awaitQueueReadiness` (bounded Redis readiness wait — never hangs boot), and `runBootCoordinator` (readiness → stagger → resume workers; a coordinator failure fails OPEN to synchronous start so the worker cannot zombie). `isBootStaggerEnabled` reads `BOOT_STAGGER_ENABLED`; only the literal `"false"` disables. |
| `guarded-poll.ts` | `createGuardedPoll(runCycle, opts)` — the shared loop scaffolding: single-flight flag, per-cycle `withTimeout` deadline, interval timer (number or runtime-resolved function), initial run, error containment, idempotent `start`/`stop`. Exists because a hung cycle wedged the in-flight flag and killed a loop silently **(#414, root cause #413)**; the deadline must sit between the cycle's legitimate maximum and the interval. Four pre-existing guards keep bespoke variants. |
| `poller-heartbeat.ts` | Idle-cycle log suppression with a liveness heartbeat, shared by the account-offboarding pollers (and `HealthAlertPoller`): `notePollerActivity(key)` records a real work line; `maybeLogPollerHeartbeat(logger, key)` emits one `Idle heartbeat` at most every 30 min of continuous idle, so an alive-but-idle loop stays observable and a dead one shows as a missing heartbeat. Per-process state; `__resetPollerHeartbeatState` is test-only. |

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
| `HealthAlertPoller.ts` | Beta-launch gate: every `HEALTH_ALERT_POLL_INTERVAL_MS` (default 5 min) runs the read-only `health-alert/checks.ts` set on a dedicated max:2 bulkhead client (**#500**; `healthBulkheadSql()` also serves the queue-health endpoint), then the Redis replica-cardinality check (**#587**, own try/catch + timeout so a cache outage never fails the cycle). Findings go to Sentry via `emit.ts`; every cycle records a Sentry Cron check-in (dead-man switch); a `TimeoutError` recycles the bulkhead client. Single-flight. |
| `AccountOffboardingAccessEndPoller.ts` | Every 60s (`ACCOUNT_OFFBOARDING_ACCESS_END_INTERVAL_MS`; batch ≤100): claims `scheduled` cancel_only rows whose `access_ends_at` has passed and that hold no reactivation claim (`FOR UPDATE SKIP LOCKED`, one tx per row), sets `tearing_down` + `teardown_started_at`, writes `account_offboarding_teardown_started` audit and enqueues `account_offboarding_teardown`. Gated by `ACCOUNT_OFFBOARDING_ENABLED`; 45s cycle deadline **(#414)**. |
| `AccountOffboardingPurgePoller.ts` | Every 60s: claims delete_data `purge_scheduled` rows past `purge_after` (not cancelled / not started) that either completed teardown or carry a concrete `admin_provider_disposition`; stamps `purge_started_at`, revokes open keep-my-data tokens, writes `account_offboarding_purge_started` audit and enqueues `account_offboarding_purge` — one tx per row. `getAccountOffboardingPurgeWindowOverrideMs` shortens the window for non-production dry-runs (capped at 3 days). Flag-gated; 45s deadline **(#414)**. |
| `AccountOffboardingPurgeReminderPoller.ts` | Every 60s: for delete_data `purge_scheduled` rows within `REMINDER_LEAD_DAYS` (3) of `purge_after` with `purge_reminder_sent_at` unset, stamps it, writes `account_offboarding_purge_reminder_sent` audit and enqueues the `delete_data_purge_reminder` email in one tx. Flag-gated; 45s deadline **(#414)**. |
| `AccountOffboardingReactivationResetPoller.ts` | Every 60s: finds cancel_only `scheduled` rows whose `reactivation_claimed_at` is >5 min old (the originating reactivation died mid-reversal), idempotently re-applies Stripe `cancel_at_period_end:true` under the same compensation key `reactivate.ts` uses, then releases the claim guarded by the observed token and writes `account_offboarding_reactivation_claim_reset` audit. Retryable Stripe errors defer; permanent ones release anyway. Flag-gated; 45s deadline **(#414)**. |
| `AccountOffboardingTeardownRetryPoller.ts` | Every 60s: re-drives rows at `failed` / `failed_step='teardown'` (both modes) after a per-row cooldown (`ACCOUNT_OFFBOARDING_TEARDOWN_RETRY_COOLDOWN_MS`, default 5 min) and under `ACCOUNT_OFFBOARDING_TEARDOWN_MAX_RETRIES` (default 12, counted by `retry_count`): sets `tearing_down`, writes `account_offboarding_teardown_retry_scheduled` audit, enqueues `account_offboarding_teardown`. Teardown steps early-return on `success`, so only the failed step reruns. Flag-gated; 45s deadline **(#414)**. |
| `CancellationGracePoller.ts` | Every 24h (`CANCELLATION_GRACE_INTERVAL_MS`): for `cancelled` accounts with `cancelled_at` older than 30 days and no `account_offboardings` row, soft-archives every remaining active location (`archived_at = NOW()`) under `acquireLocationLifecycleLock` + row locks and inserts a `location_soft_archived_grace_expired` row per location directly into `account_audit_log` (VAL-BILLING-048/049). Not flag-gated; 30-min cycle deadline **(#414)**. |

#### `worker/background/pollers/billing-reconciliation/` — StripeLocationsReconcilePoller modules

Focused modules for `StripeLocationsReconcilePoller` *(Wave 1)* — the poller stays the single registered entry point and passes its `sql` down (invariant #15).

| File | What it does |
|------|--------------|
| `account-flags.ts` | `parseAccountFlags` — narrows `accounts.flags` JSONB (which Postgres.js + PgBouncer may return as a string) to a plain object, `{}` on anything else — and `isPilotAccount` (`is_pilot`/`pilot === true`), used for drift-alert metadata. |
| `constants.ts` | Shared constants: `LOG_PREFIX` (`[StripeLocationsReconcilePoller]`), `POLLER_NAME` (`stripe_locations_reconcile`, the `poller_cursors` row key — migration 081), `CURSOR_SAVE_TIMEOUT_MS`/`CURSOR_LOAD_TIMEOUT_MS` (10s bounds; the load is lazily kicked on the first tick, after the boot storm), and `TRUNCATION_ALERT_THRESHOLD` (3 consecutive truncated cycles page — ADR 0006, **#479**). |
| `cursor-store.ts` | Durable keyset resume cursor (`poller_cursors`, migration 081). `loadCursor(sql, pollerName)` returns `{cursor:null, writeSeq:0}` when no row; `saveCursor(sql, pollerName, cursor, writeSeq)` UPSERTs under a write-sequence CAS (`WHERE EXCLUDED.write_seq > poller_cursors.write_seq`, ADR 0006) so a stale/detached save from the non-cancelling `withTimeout` is a DB no-op. Takes `sql` explicitly. |
| `drift-alert.ts` | Drift alert sink: `emitDriftAlert(accountId, payload)` — Sentry `captureMessage` (tag `feature:stripe_reconciliation`) when `SENTRY_DSN` is set, else a structured log line. Owns `DriftAlertPayload`. Level by type (CONFIG-1): only `locations_paid_mirror` is benign (`warning`); every other and any unknown drift type pages at `error`. |
| `drift.ts` | Pure drift helpers: `isExpectedStatusWindow` (Stripe `past_due`/`unpaid` is tolerated while the account is inside its extension-aware grace window, via `computePastDueRecoveryState`), `compareUpcomingInvoice` (±1 cent tolerance → `upcoming_invoice_mismatch`), and `recurringSubscriptionLineTotalCents` (sums undiscounted, non-proration subscription lines of a preview invoice across Stripe API-version shapes). |
| `expected-invoice.ts` | `expectedInvoiceForAccount(account)` — DB-expected base + overage from the STORED `base_price_cents`/`locations_overage_price_cents`/`locations_included` (invariant #9a; never the live tier registry) via `computeOverageQuantity`; throws on an unknown tier. |
| `reconcile-account.ts` | `reconcileAccount(sql, stripe, account)` — reconciles ONE account: missing/duplicate subscription, status (after the expected-status window), price, quantity, `locations_paid` mirror and upcoming-invoice drift; returns `{accountsChecked, drifts, errors}` for the poller to emit and tally. The ONE auto-correction: a DB-`trialing` row whose Stripe status moved is re-applied through `applyStripeSubscriptionStateUnderEntitlementLock` in a tx. Stripe reads bounded at 20s. |
| `reconcile-progress.ts` | Pure cursor/progress helpers, no I/O: `nextCursor` (last claimed id on a partial cycle, `null` on a drain), the `ReconcileProgress` snapshot, `classifyCycle(progress, outcome)` → `drained | truncated | stalled` (an `error` outcome is a stall, never a truncation), and `evaluateTruncation` (consecutive-truncation counter that alerts exactly once when the threshold is first reached; any non-truncation resets it). |
| `stripe-overage.ts` | Pure Stripe-object helpers, no I/O: `extractStripeCustomerId`, `isMissingStripeSubscriptionError` (`resource_missing` / 404 / "no such subscription"), `activeStripeSubscriptions` (filters `active|trialing|past_due|unpaid`). The overage-item predicate deliberately lives in `@/lib/payments/overage-item`, not here. |
| `truncation-alert.ts` | Sustained-truncation sink (ADR 0006, **#479**): `emitTruncationAlert` — Sentry `warning` when `SENTRY_DSN` is set, else `logger.warn`. Fired once by the poller's `runOnce.finally` when the sweep hit its cycle deadline `TRUNCATION_ALERT_THRESHOLD` cycles in a row; a capacity signal, not a billing anomaly, and best-effort off the state-mutating path. |
| `types.ts` | Shared shapes: `AccountWithLocations` (the poller's account query row), `BillingReconciliationAccount` (parsed flags), `ExpectedInvoice`, `DriftSeverity`, and the `DriftFinding` union of eight drift types (`missing_subscription` … `locations_paid_mirror`). |

#### `worker/background/pollers/health-alert/` — HealthAlertPoller modules

`HealthAlertPoller` sub-modules — the read-only check set, the Sentry sinks, the bulkhead client lifecycle, and the replica registry.

| File | What it does |
|------|--------------|
| `checks.ts` | Read-only checks, one query each against env-tunable `HEALTH_ALERT_*` thresholds (`resolveHealthAlertConfig`), returning `HealthFinding`s. `runHealthChecks(sql)` runs them SEQUENTIALLY (a `Promise.all` on the max:2 client wedged every cycle, **#505**): `checkWedgedClientRead` first (**#773** — `pg_stat_activity` sessions in `active`/`ClientRead` older than 10s; alerts on age, never presence), then outbox failed/pending-age/stale-dispatching, open flagged, zero-delivery, owner-unreachable, failed inbound events, stalled send batches; a `checkBacklogDepth` failure degrades to a warning finding. |
| `emit.ts` | Sentry sinks for the poller: `emitHealthFindings` (`captureMessage` per finding, tags `subsystem:health_alert` + `finding:<key>` — the non-email paging route) and `recordProbeCheckIn(status, intervalMs)` (Sentry Cron `captureCheckIn` on monitor `HEALTH_ALERT_MONITOR_SLUG`, default `health-alert-poller`, with an upserted `*/N * * * *` crontab schedule mirroring the poll interval — the dead-man switch). |
| `health-db.ts` | Dedicated postgres.js client lifecycle — the **#500** bulkhead so a wedged health-check connection can only starve this tiny pool, never the shared `sql`. `getHealthSql(buildClient)` builds lazily; `recycleHealthSql(buildClient, logger)` ends (bounded) and UNCONDITIONALLY rebuilds after a timeout; `closeHealthSql()` ends without rebuilding at shutdown. Receives the builder from `HealthAlertPoller` (invariant #15) — no db/server import here. |
| `replica-cardinality.ts` | **(#587)** Single-replica invariant detection: `checkReplicaCardinality(redis, identity, pollIntervalMs)` heartbeats this replica into Redis under a TTL (2× interval), SCANs the live set, and returns a `replica_cardinality` finding via pure `evaluateReplicaCardinality` — `scale_out` (shared deployment id) pages immediately, `deploy_overlap_stuck` only after 4 grace cycles (`nextCrossDeploymentCycles`). A registry, deliberately NOT a boot-gating lease; off-platform → null. |



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
| `zernio/zernio.ts` | `POST /ingress/zernio` | Zernio event webhook handler. HMAC-SHA256 verification (via `zernio-verify.ts`). Routes: `account.disconnected` → marks `zernio_connections` disconnected + enqueues `send_owner_email` (connection_lost). Reads nested `body.account.id` per spec §5.4. |
| `zernio/zernio-verify.ts` | *(utility)* | `verifyZernioSignature()` — HMAC-SHA256 verification using `ZERNIO_WEBHOOK_SECRET`. |
| `conversational-seam.ts` | *(utility)* | Future-agent seam (ADR 0003) — deliberately a NO-OP today: `handleConversationalMessage({channel, senderHandle})` logs an acknowledgement and sends no reply. `isAuthorizedConversationalSender` is the auth boundary any future reply must sit behind: a `verified`, non-archived `channel_enrollments` row on an account `checkSubscription` still allows (past_due honours the grace window). Called by `telegram.ts` and `twilio-whatsapp-inbound.ts` for free text. |
| `rate-limit.ts` | *(`onRequest` hook on every `/ingress/*`)* | Best-effort per-IP backstop (120/min via `checkRateLimit`, fails open). `registerIngressRateLimitHook(app)` runs before body parsing and signature verify, matching on BOTH `routeOptions.url` (absolute-form request lines) AND the percent-DECODED raw path (unmatched 404s, `/%69ngress/`); routes opt out only via resolved config `skipIngressRateLimit` (unsubscribe, §9.2). `ingressClientIp` reads the XFF first hop — spoofable by design; signatures are the real gate. |
| `twilio/parse-inbound.ts` | *(utility)* | `parseTwilioWhatsAppInbound(params)` → typed `{from, body, messageSid}` from raw Twilio form params (empty strings when absent); used by `twilio-whatsapp-inbound.ts`. |
| `twilio/twilio-delivery-status.ts` | *(called by twilio-whatsapp-status.ts)* | `handleTwilioDeliveryStatus(request, reply, options)` — the shared Twilio delivery-status state machine: signature verify (401) → dedup claim on `${MessageSid}:${MessageStatus}` → non-terminal statuses just mark processed → terminal (`delivered|undelivered|failed`) first-wins update of `notification_deliveries` (`delivered_at` / `failed_at` + `twilio:<ErrorCode>`); no delivery row yet → `markInboundEventFailed` + 503 for retry. Optional `redactPayload` scrubs the audit copy only. |

#### `worker/ingress/stripe/` — per-event Stripe handlers

Per-event handlers `stripe.ts` dispatches to after signature verification and dedup; every status change routes through the single applier.

| File | What it does |
|------|--------------|
| `apply-subscription-state.ts` | The SINGLE applier of `accounts.subscription_status` — Stripe is the source of truth. `mapStripeStatus`, the monotonic `ALLOWED_TRANSITION_SOURCES` table (`cancelled` terminal; stale/out-of-order → `changed:false`), `applyStripeSubscriptionState(tx, ref, stripeSub)` (resolves by account id or customer+subscription, takes the entitlement lock) and `applyStripeSubscriptionStateUnderEntitlementLock` for callers already holding it. Inside the caller's tx it writes status/`trial_ends_at`/`subscription_activated_at`, the audit row, the overage-recompute + mirror-sync enqueues and trial analytics facts. Also called by the reconcile poller. |
| `checkout-completed.ts` | `processCheckoutSessionCompleted(session)` — validates the ref id (UUID; account or legacy business), `mode=subscription`, paid/`no_payment_required`, then `projectCheckoutSubscription`: under `acquireTierBillingActivationLocks` provider-reads the Session (+line items) and subscription and requires the account's `checkout_attempt_*` lease, the line items and the provider subscription to agree before the status applier + tier-snapshot write; a mismatch cancels the unexpected subscription (`CheckoutRemediationRequiredError`), marks the attempt remediated and pages. Post-commit: `synchronizeBusinessTierMirror` when needed, `resumePrimaryBusinessBackfill` on activation. |
| `invoice-paid.ts` | `processInvoicePaid(invoice)` — resolves the account by `stripe_customer_id` + the invoice's subscription id, then in one tx takes the entitlement lock, retrieves the provider-current subscription (20s timeout) and runs the applier. A no-op where DB and provider both still read `past_due` THROWS so Stripe redelivers (stale-read suspect); an activating transition resumes the primary business backfill. |
| `invoice-payment-action-required.ts` | `processInvoicePaymentActionRequired(invoice)` — SCA/3DS pending at a charge is entitlement-equivalent to a payment failure, so it delegates straight to `processInvoicePaymentFailed`. |
| `invoice-payment-failed.ts` | `processInvoicePaymentFailed(invoice)` — resolves the account by customer AND the failed invoice's subscription (one customer can map to several accounts), then under the entitlement lock retrieves the provider-current subscription and runs the applier (→ `past_due`, 7-day grace). On an `active→past_due` transition within 3 days of `trial_converted`, enqueues `trial_payment_failed` so net conversions stay accurate. |
| `shared.ts` | Utilities for the Stripe handlers: `LOG_PREFIX`, re-exported `getStripe`, `extractCustomerId`/`extractSubscriptionId`/`invoiceSubscriptionId` (across API-version shapes), `UUID_RE`, and `AccountNotProvisionedYetError` (thrown when a subscription.* event precedes its checkout — the wrapper answers 500 so Stripe redelivers). `resumePrimaryBusinessBackfill(businessId)` is the ONE post-commit "activation → resume Zernio import" hook (**#266**): best-effort; in one tx holding the `businesses` row lock it creates the Import offer and, if `zernioPublishingEnabled()` and consent is `accepted`, calls `enqueueInitialImport`. |
| `subscription-deleted.ts` | `processSubscriptionDeleted(sub)` — loads every account under the customer; none → throws `AccountNotProvisionedYetError` (retry); acts on the one whose CURRENT `stripe_subscription_id` matches, skipping a subscription that only matches an active offboarding snapshot; then under the entitlement lock runs the applier (→ `cancelled`). |
| `subscription-updated.ts` | `processSubscriptionUpdated(eventSnapshot)` → `SubscriptionUpdatedOutcome` (`updated | variant_mismatch | status_only | ignored`). Resolves the account by customer + subscription (stale/offboarding-snapshot subscriptions ignored; none → `AccountNotProvisionedYetError`), then in one tx under `acquireTierAndBillingLocks` retrieves the provider-current subscription, runs the status applier (a resolved no-op still enqueues mirror sync), resolves base/overage items via `resolveSubscriptionBilling` and writes the tier snapshot + `locations_paid`. Post-commit `synchronizeBusinessTierMirror`; alerts (unmapped price, variant mismatch, untrusted overage, Autopilot-while-unavailable) → Sentry. |


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
