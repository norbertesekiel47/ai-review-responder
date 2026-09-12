## `src/app/`

### `admin/` — Legacy auth and impersonation

After #1193, five pages remain: the three bare auth pages and the two
server-gated impersonation pages. The layout supplies identity and the live
session banner to a minimal header with one plain Open Admin app link.
Other admin pages live in `RepWorth/admin-app` and read through the bearer
fetch seam. The shared `AdminPage`, table, states and format primitives remain
for impersonation; `nav-counts` remains an API consumed by the separate app.

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
| `providers.tsx` | React context providers wrapping the admin layout. |
| `loading.tsx` | Segment streaming fallback: title skeleton + shared `TableSkeleton`, at `AdminPage`'s measure. Owns no viewport height or background — the shell does. |
| `error.tsx` | Segment error boundary: reports to Sentry, focuses its heading, offers Try again / Back to support access. Rendered as a card inside the shell's main column, palette-matched to the shared `ErrorState`. |
| `login/page.tsx` | Admin login (never gated by `SELF_SERVE_SIGNUP_ENABLED`). Supplies the trusted `ADMIN_APP_URL` default; renders outside the shell (`ADMIN_AUTH_ROUTES`). |
| `forgot-password/page.tsx` | Admin forgot-password. Outside the shell. |
| `reset-password/page.tsx` | Admin reset-password. Outside the shell. |
| `api/admin/suppressions/_guard.ts` | **(#645)** `parseJsonBody(request, schema, schemaError?)` — the JSON-body read + `safeParse` the three admin suppressions routes share, returning a discriminated `ParsedBody`. `schemaError` defaults to zod's first issue; `lookup` passes `opaqueBodyError` so a rejection never describes a body whose only field IS the recipient address (§9.5). Deliberately does **NOT** wrap the AAL2 gate: the `ci:admin-aal2` AST audit must reach the canonical gate from each exported mutation handler; body validation earns no authentication credit. |
| `impersonate/page.tsx` | **(Wave 2 / Phase 3)** Server component: gate + `<AdminPage group="Growth" title="Impersonation">`. |
| `impersonate/ImpersonationStartClient.tsx` | Client form that posts account/user/ticket/reason to `/api/admin/impersonation/start` and follows the returned view URL. |
| `impersonate/[sessionId]/view/page.tsx` | **(Wave 2 / Phase 3)** Admin-owned read-only impersonation shell on `<AdminPage>`. Keeps its bespoke gate — `resolveImpersonationViewSession` has four distinct redirect/notFound outcomes that `requireAdminPage` cannot express. Does not mount owner routes. |
| `impersonate/[sessionId]/view/ImpersonationLocationsTable.tsx` | **(Phase 3)** The account's locations as a `DataTable` (Name / Location ID / State); no `rowHref` — nothing is navigable inside a read-only session. |
| `layout.tsx` | Server layout: wraps children in `AdminProviders`, reads `loadAdminShellContext` (identity + live view-as session, display only, never redirects) and supplies it plus the trusted Admin home URL to `AdminShellFrame`. |

---

_Index: [`docs/directory.md`](../directory.md)_
