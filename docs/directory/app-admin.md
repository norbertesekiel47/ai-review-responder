## `src/app/`

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
| `layout.tsx` | Server layout: reads `loadAdminShellContext` (identity + live view-as session, display only, never redirects) and hands it to `AdminShellFrame`. |

---

_Index: [`docs/directory.md`](../directory.md)_
