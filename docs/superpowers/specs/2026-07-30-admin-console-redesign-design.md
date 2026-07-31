# Admin Console Redesign — "Pro Tool" (design spec)

_Status: approved design, pending implementation plan · 2026-07-30_
_Owner: Norbert + Claude · Branch: `admin-console-redesign`_

## 1. Problem

The admin surface (`src/app/admin/*`, 19 pages) grew page-by-page and shows it:

- **Navigation**: an 11-item flat top nav (`src/components/admin/AdminNav.tsx`); `/admin/flagged` and `/admin/autonomy` are reachable only by typing the URL.
- **Visual inconsistency**: plain gray Tailwind applied ad hoc — five hand-rolled table styles, per-page badge colors, no shared page chrome. Admin is an unsystematized third look next to the Island (marketing) and Warm Editorial Console (owner dashboard) systems.
- **Performance**: every page is `'use client'` + react-query; each navigation renders an empty shell, then fetches, then paints — two round trips and a spinner every time.
- **Workflow friction**: queue work (flagged, failed jobs) is invisible until you visit the page; business IDs get copy-pasted between pages because rows don't link.

Decision (2026-07-30, mockup comparison): **Direction B — "Pro Tool"**. Admin becomes a dense, deliberately utilitarian internal console, visually distinct from the product, built from shared primitives. Full redesign appetite (shell + every page), shipped in phases.

## 2. Information architecture & shell

A fixed **dark sidebar** (`#111827`; drawer on mobile) replaces the top nav. Four labeled groups; every admin page is reachable; active state per page; live badge counts where a queue needs attention.

| Group | Pages |
|---|---|
| **Operate** | Overview, Jobs, Costs, Notifications, Runbook |
| **Businesses** | Businesses (list → detail, + New), Locations import, Offboardings |
| **Safety** | Flagged _(new to nav)_, Autonomy _(new to nav)_, Security |
| **Growth** | Demos, Support (impersonation) |

- Auth pages (login, forgot-password, reset-password) render outside the shell, as today.
- `/admin` continues to redirect to `/admin/overview` (handled in `src/proxy.ts`, unchanged).
- Locations import sits under **Businesses** (it operates on existing accounts), not Growth.
- **Badge counts**: flagged-pending and failed-jobs counts in the sidebar, served by one new endpoint `GET /api/admin/nav-counts` (two cheap `COUNT` queries), polled every 60s.
- `AdminNav.tsx` (top bar) is retired in the final phase.

## 3. Visual system & shared primitives

Neutral gray, dense, internal-tool aesthetic: existing app font, `text-sm` density, 6px radii, white cards with `#E5E7EB` borders on a `#F8F9FA` field, dark sidebar. **No new dependencies; inline SVG icons only** (repo tech rule — no icon libraries).

All pages are built from seven primitives in `src/components/admin/ui/`:

| Primitive | Responsibility |
|---|---|
| `AdminPage` | Page chrome: group breadcrumb, title, description, action slot; consistent max-width/padding |
| `StatTile` | KPI card; alert variant (red border) when a threshold is breached |
| `DataTable` | Sortable columns, sticky header, pagination, row-link affordance — replaces all hand-rolled tables |
| `FilterBar` | Search input + removable filter chips + row count |
| `StatusBadge` | Single status → color mapping, fed from the authoritative status constants (no string literals — repo rule) |
| `EmptyState` / `ErrorState` | Same two states everywhere; errors name the failed request and offer Retry |
| skeletons | Shared loading skeleton used by per-page `loading.tsx` |

Pages never hand-pick badge colors or table markup after migration.

## 4. Data fetching & performance

**Server-first, client for interactions:**

- Each `page.tsx` becomes a **server component** that fetches initial data directly through the existing `src/lib/admin/*` services (server pages are sanctioned composition roots per architecture invariant #15, importing `@/lib/db/server` and passing `sql` down), enforcing the same admin auth gate the API routes use.
- The server page passes data to its client component as react-query **`initialData`**. Pagination, filters, and refresh keep using the existing `/api/admin/*` routes, which stay untouched. The lib service remains the single owner of each query (server page and API route both call it).
- First paint arrives with data: one round trip, no spinner.
- react-query tuning: `staleTime` ≈ 30s on admin queries so tab-switching doesn't refetch everything.
- Explicitly **not** doing: caching layers, ISR, new data infrastructure. Admin data stays live; the win is killing the client-side waterfall.

## 5. Workflow improvements

- **Overview becomes a true landing page**: health strip plus a "needs attention" list deep-linking into the work (failed job → Jobs filtered to failed; flagged draft → Flagged; past-due account → that business's detail page).
- **Consistent cross-linking**: any business name anywhere links to its detail page; every table row carries the same "View →" affordance.
- Sidebar badge counts surface queue work without visiting each page.
- **Not building** (no earned complexity yet): command palette, saved views, bulk actions.

## 6. Error handling

- Shared `ErrorState` names the failed request and offers Retry.
- Existing root `src/app/admin/error.tsx` boundary stays as the catch-all.
- Server-page fetch failures render the same `ErrorState` — a dead DB must not white-screen admin.

## 7. Testing

- Unit tests for primitives with logic: `StatusBadge` (every status constant maps to a style, no fallthrough), `DataTable` sort/pagination, sidebar (every admin page present in nav; badge rendering).
- Auth-gate test for the server-page pattern (non-admin session → redirect), mirroring existing API-route auth tests.
- Existing page tests (`page-source.test.ts`, client component tests) updated as each page migrates.
- Gate per PR: `pnpm lint && pnpm typecheck && pnpm test`.

## 8. Rollout — three shippable phases

1. **Shell**: sidebar + groups + `nav-counts` endpoint + the seven primitives. Page internals untouched — they render inside the new shell immediately.
2. **Operate + Safety pages** migrate to server-first + primitives (daily-driver and queue pages — biggest felt win).
3. **Businesses + Growth pages** migrate; retire `AdminNav.tsx` and orphaned styles.

UI-only work (Next.js pages + one new admin API route): no worker, migration, webhook, or billing surface — normal PR lane to `main`, sanity-checked on the Vercel preview per PR.

## 9. Out of scope

- Owner dashboard, marketing pages, auth page redesign.
- New admin features (new data, new mutations) beyond the `nav-counts` endpoint.
- Warm Editorial adoption for admin (explicitly rejected in favor of Pro Tool).
- Command palette, saved views, bulk actions (revisit only on demonstrated need).

## 10. Constraints honored

- Invariant #1: no runtime imports of LLM/queue/`postgres` packages in `src/app/**`; DB access flows through `@/lib/db/server` in composition roots only.
- Invariant #15: server pages act as composition roots and pass `sql` into `src/lib/admin/*` services.
- Invariant #13: no `NEXT_PUBLIC_*` flags introduced.
- Repo rules: no string literals for subscription/job status (import constants); pnpm only; no new runtime deps; inline SVG icons.
