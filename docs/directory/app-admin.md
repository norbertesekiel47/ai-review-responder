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
> path around the route's step-up. Mutation handlers retain their own AAL2
> requirements independently of the page's read gate.

| Path | What it does |
|------|--------------|
| `layout.tsx` | Wraps everything in `AdminProviders` + `AdminShellFrame` (sidebar shell). |
| `providers.tsx` | React context providers wrapping the admin layout. |
| `loading.tsx` | Segment streaming fallback: title skeleton + shared `TableSkeleton`, at `AdminPage`'s measure. Owns no viewport height or background — the shell does. |
| `error.tsx` | Segment error boundary: reports to Sentry, focuses its heading, offers Try again / Back to support access. Rendered as a card inside the shell's main column, palette-matched to the shared `ErrorState`. |
| `login/page.tsx` | Admin login (never gated by `SELF_SERVE_SIGNUP_ENABLED`). Supplies the trusted `ADMIN_APP_URL` default; renders outside the shell (`ADMIN_AUTH_ROUTES`). |
| `forgot-password/page.tsx` | Admin forgot-password. Outside the shell. |
| `reset-password/page.tsx` | Admin reset-password. Outside the shell. |
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
| `demos/page.tsx` | **(Phase 3)** Server component: gate, `getAdminDemos`, `<AdminPage group="Growth" title="Demos">`. |
| `demos/DemosClient.tsx` | **(Phase 3)** Client island: generate form (measured `max-w-2xl`) + full-width demo list, polling at 5s only while a demo is `queued`/`running`. Owns `DEMO_STATUS_STYLES` (generation status has an `animate-pulse` running state the shared badge cannot express). |
| `impersonate/page.tsx` | **(Wave 2 / Phase 3)** Server component: gate + `<AdminPage group="Growth" title="Impersonation">`. |
| `impersonate/ImpersonationStartClient.tsx` | Client form that posts account/user/ticket/reason to `/api/admin/impersonation/start` and follows the returned view URL. |
| `impersonate/[sessionId]/view/page.tsx` | **(Wave 2 / Phase 3)** Admin-owned read-only impersonation shell on `<AdminPage>`. Keeps its bespoke gate — `resolveImpersonationViewSession` has four distinct redirect/notFound outcomes that `requireAdminPage` cannot express. Does not mount owner routes. |
| `impersonate/[sessionId]/view/ImpersonationLocationsTable.tsx` | **(Phase 3)** The account's locations as a `DataTable` (Name / Location ID / State); no `rowHref` — nothing is navigable inside a read-only session. |
| `layout.tsx` | Server layout: reads `loadAdminShellContext` (identity + live view-as session, display only, never redirects) and supplies it plus the trusted Admin home URL to `AdminShellFrame`. |

---

_Index: [`docs/directory.md`](../directory.md)_
