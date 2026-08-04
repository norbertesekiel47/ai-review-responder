# Admin Console Phase 3 — Businesses + Growth Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the last seven admin pages (Businesses + Growth nav groups) to server-first fetching and the shared primitives, converge AdminPage chrome onto the server pages, and sweep the styles the three phases orphaned — so every admin page reads as one system and first paint arrives with data.

**Architecture:** Same as Phase 2. Each `page.tsx` is a server component: `requireAdminPage(sql, {from, aal2?})` → initial data via the owning `src/lib/admin/*` service → client component receives it as react-query `initialData`. Routes with inline SQL (businesses list, businesses/[id]/channels, offboardings, demos) get their queries extracted into services that route AND page both call; route responses stay byte-identical so existing route tests keep passing. The `<AdminPage>` chrome moves OUT of client components and INTO the server pages (including the five Phase 2 clients that still own theirs), so chrome renders in the RSC payload and never sits behind a loading state.

**Tech Stack:** Next.js 16 App Router (server components, `params` is a Promise), @tanstack/react-query `initialData`, Postgres.js via `@/lib/db/server` (composition roots only), Vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-07-30-admin-console-redesign-design.md` (§2 IA, §3 primitives, §4 data fetching, §5 workflow, §6 errors, §8 rollout phase 3)

**Working directory:** the `admin-console-phase3` worktree at `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/admin-console-phase3` — every path below is relative to that root. Never edit the parent checkout.

---

## Binding conventions for every task

These are the Phase 2 lessons. Violating any of them is a review failure, not a nit.

1. **Non-blanking errors.** Three-way split, copied from `src/app/admin/jobs/JobsClient.tsx:188-212`:
   `isLoading && !data` → `<TableSkeleton/>`; `isError && !data` → full `<ErrorState/>` naming the failed request; `isError && data` → the normal content **plus** a slim inline `<ErrorState title="Last refresh failed" detail="GET /api/... failed — showing the last loaded data."/>` above it. Never blank a page that still has cached data.

2. **TIMESTAMPTZ → `.toISOString()` in the service.** This is the highest-risk trap in this phase. A route that returns a raw `Date` is fine (`JSON.stringify` converts it); a **server page** passing the same object to a client component is NOT — the RSC serializer preserves `Date` instances, so a DTO field typed `string` arrives as a `Date` and `.slice()`/`.replace()` on it throws **only on first paint** (the react-query refetch then "fixes" it, which is why no test catches it). Every extracted service must convert every timestamp itself, and Task 3 explicitly audits the *pre-existing* `getBusinessDetail` mappers for this.

3. **Verbatim SQL extraction.** Move the query text unchanged, keep the route byte-compatible (its tests must pass **unmodified** — only mock import paths may change), and retarget the matching `scripts/ci/tenant-scope-allowlist.ts` entries to the new service path **in the same commit**. `ALLOWLIST_BASELINE` stays **416** — you are moving entries, never adding or removing them. The `sqlSnippet` text must not change; only `file:` does.

4. **One DTO owner, one PAGE_SIZE owner.** The service exports the DTO type; the client imports it and intersects for any route-echo fields (`limit`/`offset`). `PAGE_SIZE` is declared once per page — in the client, exported, and imported by the server page (the `jobs/` pattern).

5. **Palette.** Neutral grays; no `rw-*`, no amber/orange/stone; `yellow-*` for warnings; red for danger; green for success. Blue/indigo used decoratively (buttons, info cards, links) becomes neutral gray — blue is reserved for the shared `StatusBadge`'s `trialing`/`dispatching`. Add every new `*Client.tsx` to `SWEPT_FILES` in `src/__tests__/console-admin-palette.test.ts` **in the task that creates it**, or the rule is not enforced.

6. **`text-rw-teal` on star glyphs is protected, not orphaned.** `ReviewsList.tsx` and `ZernioConnectionPanel.tsx` render stars in `text-rw-teal`, and `src/__tests__/no-yellow-star-colors.test.ts:63-70` asserts exactly that. Do NOT neutralize those two spans during the palette sweep.

7. **Gate parity with the route.** A page's gate must match its API route's gate. `/api/admin/offboardings` uses `requireAdminWithAal2` → the offboardings page uses `requireAdminPage(sql, {from, aal2: true})`. The businesses list, businesses detail, channels, and demos routes use plain `requireRoleOr401(admin)` → plain page gate.

8. Full-suite runs use `REPWORTH_DISABLE_LIVE_DB_SUITES=1 pnpm test` (local :5432 not running — documented kill switch). Commit after every task; never push until the final task.

---

## Decision: the `STATUS_BADGE_STYLES` collision (carried forward from Phase 2)

`businesses/[id]/_components/ZernioConnectionPanel.tsx:19` and `ChannelsPanel.tsx:8` each declare a local `STATUS_BADGE_STYLES` with a vocabulary that does not match the shared `src/components/admin/ui/StatusBadge.tsx`:

| | keys | overlap with shared map |
|---|---|---|
| Zernio | `active`, `pending`, `disconnected`, `not_connected` | `active` (green, agrees), `pending` (shared = **yellow**, local = **gray**) — silent recolor |
| Channels | `verified`, `pending_verification`, `disabled`, `unsubscribed` | **none** — all four would fall through to the neutral gray default |

**Decision: keep them local, rename to distinct names.** `ZERNIO_CONNECTION_BADGE_STYLES` + `ZernioConnectionBadge`, `CHANNEL_ENROLLMENT_BADGE_STYLES` + `ChannelEnrollmentBadge`.

Rationale: these are per-domain vocabularies, not console statuses. `pending` means "connection handshake outstanding" here and "outbox row not yet dispatched" in the shared map — one key, two meanings, no correct single color. Both local badges also render friendly labels ("Not connected"), while the shared badge deliberately renders the raw status string. Extending the shared map would import four channel-enrollment keys plus a `disconnected`/`not_connected` pair into a map that no channel or Zernio code owns, and would force a `pending` collision to be resolved wrongly for one of the two domains. Renaming removes the shadowing trap (which was the actual hazard) without pretending these are the same concept. Spec §3's "pages never hand-pick badge colors" is satisfied for console-level statuses; domain-level vocabularies keep named owners.

---

## File structure

| File | Responsibility |
|---|---|
| `src/components/admin/ui/DataTable.tsx` (modify) | Extract + export `PaginationFooter` and `serverPaginationFooterState`; both DataTable modes consume them |
| `src/app/admin/flagged/FlaggedClient.tsx` (modify) | Drop the hand-rolled footer for the shared one; drop its `<AdminPage>` |
| `src/lib/admin/businesses-list-service.ts` (create) | `getAdminBusinessesList(sql, {limit, offset})` — GET SQL moved verbatim from the route |
| `src/lib/admin/business-channels-service.ts` (create) | `getBusinessChannelEnrollments(sql, businessId)` — channels GET moved verbatim |
| `src/lib/admin/offboardings-service.ts` (create) | `getAdminOffboardings(sql, {limit, offset})` — list + count + row mapper + error scrubber, moved verbatim |
| `src/lib/admin/demos-service.ts` (create) | `getAdminDemos(sql)` — moved verbatim |
| `src/app/api/admin/{businesses,businesses/[id]/channels,offboardings,demos}/route.ts` (modify) | Delegate to the services; responses unchanged |
| `src/app/admin/businesses/page.tsx` (rewrite) + `BusinessesClient.tsx` (create) | Server page + DataTable list |
| `src/app/admin/businesses/[id]/page.tsx` (rewrite) + `BusinessDetailClient.tsx` (create) | Server page (both queries) + client body |
| `src/app/admin/businesses/[id]/_hooks/useBusinessDetail.ts` (modify) | Accept `initialDetail` / `initialChannels` |
| `src/app/admin/businesses/[id]/_components/{ZernioConnectionPanel,ChannelsPanel}.tsx` (modify) | Renamed local badge maps |
| `src/app/admin/businesses/new/page.tsx` (rewrite) + `NewBusinessClient.tsx` (create) | Server chrome + client form |
| `src/app/admin/locations/csv-import/{page.tsx,CsvImportClient.tsx}` (modify) | Server chrome + neutral palette |
| `src/app/admin/offboardings/{page.tsx,OffboardingsClient.tsx}` (modify) | AAL2 server page + initialData |
| `src/app/admin/demos/page.tsx` (rewrite) + `DemosClient.tsx` (create) | Server page + client body |
| `src/app/admin/impersonate/{page.tsx,ImpersonationStartClient.tsx}` (modify) | AdminPage chrome + neutral palette |
| `src/app/admin/impersonate/[sessionId]/view/page.tsx` (modify) | AdminPage chrome + neutral palette (keeps its bespoke session gate) |
| `src/app/admin/{overview,jobs,costs,notifications,flagged}/page.tsx` (modify) + their clients | Chrome convergence: `<AdminPage>` moves to the server page |
| `scripts/ci/tenant-scope-allowlist.ts` (modify) | 9 entries retargeted to service paths; `ALLOWLIST_BASELINE` unchanged (416) |
| `src/__tests__/console-admin-palette.test.ts` (modify) | SWEPT_FILES updated per task |

---

### Task 1: Shared pagination footer (DataTable ⇄ FlaggedClient)

**Files:**
- Modify: `src/components/admin/ui/DataTable.tsx`
- Modify: `src/app/admin/flagged/FlaggedClient.tsx`
- Test: `src/components/admin/ui/__tests__/DataTable.test.tsx` (must stay green, unchanged), `src/app/admin/flagged/__tests__/FlaggedClient.test.tsx` (extend)

FlaggedClient hand-rolls a footer (`FlaggedClient.tsx:97-118`) whose visibility rule is `offset > 0 || rows.length === PAGE_SIZE` — a "there might be more" heuristic that ignores the `total` it already has. DataTable's server mode already computes this correctly, including the dead-end guard (`DataTable.tsx:87` — an empty page with `totalRows > 0` must still render the footer so Previous stays reachable). Make DataTable the single owner and have Flagged consume it.

- [ ] **Step 1: Read the current footer region** — `src/components/admin/ui/DataTable.tsx:55-95` and `:150-190`, and `src/app/admin/flagged/FlaggedClient.tsx:90-125`. Note the exact rendered strings the existing DataTable tests assert: `Showing 4–6 of 8` (en dash U+2013), `Page 2 of 2`, `No rows on this page (N total)`, and the button names `Previous` / `Next`. These must not change.

- [ ] **Step 2: Extend the FlaggedClient test first** (jsdom, QueryClientProvider). Two new cases against a fixture with `total: 120`, `PAGE_SIZE` rows:
  - footer renders `Showing 1–50 of 120` and `Next` is enabled;
  - rendered at a non-zero offset with an **empty** `flagged` array and `total: 120`, the footer still renders and `Previous` is enabled (the dead-end guard). Run it — the second case fails today.

- [ ] **Step 3: Extract the footer in `DataTable.tsx`** (no new file — DataTable owns the footer contract):

```tsx
export interface ServerPaginationFooterState {
  pageCount: number;
  label: string;
  show: boolean;
}

/**
 * Server-pagination footer math, shared by DataTable's controlled mode and by
 * card-list pages (FlaggedClient) that paginate server-side without a table.
 * Single owner so the "Showing a–b of N" string and the empty-page-with-rows-
 * behind-you guard cannot drift between call sites.
 */
export function serverPaginationFooterState({
  page, pageSize, rowsOnPage, totalRows,
}: { page: number; pageSize: number; rowsOnPage: number; totalRows: number }): ServerPaginationFooterState { /* … */ }

export function PaginationFooter({
  page, pageCount, label, onPageChange,
}: { page: number; pageCount: number; label: string; onPageChange: (page: number) => void }) { /* … */ }
```

`serverPaginationFooterState` reproduces today's behavior exactly: `pageCount = Math.max(1, Math.ceil(totalRows / pageSize))`; `label` = `Showing ${start}–${end} of ${totalRows}` when `rowsOnPage > 0` (with `start = page * pageSize + 1`, `end = Math.min(start + rowsOnPage - 1, totalRows)`), else `No rows on this page (${totalRows} total)`; `show = totalRows > rowsOnPage || pageCount > 1`. `PaginationFooter` is the existing footer JSX verbatim, with `label` in the span, `Previous` disabled at `page === 0` and `Next` disabled at `page >= pageCount - 1`.

- [ ] **Step 4: Rewire both DataTable modes** through `PaginationFooter` — server mode via `serverPaginationFooterState`, uncontrolled mode with `label={\`Page ${currentPage + 1} of ${pageCount}\`}` and `show = pageCount > 1`. The uncontrolled path must stay byte-identical.

- [ ] **Step 5: Rewire FlaggedClient's footer** — convert `offset` ⇄ `page` at the boundary (`page = Math.floor(offset / PAGE_SIZE)`, `onPageChange={(p) => onOffsetChange(p * PAGE_SIZE)}`), delete the hand-rolled markup. Keep `offset` as the client's state shape and the query key (the route is offset-based — do not change the fetch).

- [ ] **Step 6: Run** `pnpm vitest run src/components/admin/ui src/app/admin/flagged` — all DataTable tests green **unchanged**, both new Flagged cases green. `pnpm typecheck && pnpm lint`.

- [ ] **Step 7: Commit** — `git commit -m "refactor(admin): single-owner pagination footer shared by DataTable and FlaggedClient"`

---

### Task 2: Businesses list — service extraction + server page

**Files:**
- Create: `src/lib/admin/businesses-list-service.ts`, `src/lib/admin/__tests__/businesses-list-service.test.ts`
- Modify: `src/app/api/admin/businesses/route.ts` (GET only), `scripts/ci/tenant-scope-allowlist.ts`, `src/__tests__/console-admin-palette.test.ts`
- Rewrite: `src/app/admin/businesses/page.tsx`; Create: `src/app/admin/businesses/BusinessesClient.tsx`, `src/app/admin/businesses/__tests__/BusinessesClient.test.tsx`

- [ ] **Step 1: Extract the service.** Move the GET handler's two queries (`src/app/api/admin/businesses/route.ts:41-58`) and the row→DTO mapping (`:61-70`) verbatim into:

```ts
export interface AdminBusinessListItem {
  id: string;
  name: string;
  category: string | null;
  subscriptionStatus: string;
  /** ISO-8601. Postgres returns Date; converted here so the RSC path is safe. */
  lastSyncAt: string | null;
  pendingCount: number;
}
export interface AdminBusinessesList { businesses: AdminBusinessListItem[]; total: number; }
export async function getAdminBusinessesList(sql: Sql, { limit, offset }: { limit: number; offset: number }): Promise<AdminBusinessesList>
```

The `limit`/`offset` **clamping stays in the route** (it parses query params); the service takes already-clamped numbers. The route becomes auth → parse/clamp → service → `NextResponse.json({ ...data, limit, offset })` — byte-identical to today.

- [ ] **Step 2: Retarget the allowlist.** Four entries currently keyed to `src/app/api/admin/businesses/route.ts` (lines 198, 920, 927, 934) cover the GET COUNT and the three-table list join. Change only their `file:` to `src/lib/admin/businesses-list-service.ts`; leave `sqlSnippet`, `table`, `category`, `reason` untouched and `ALLOWLIST_BASELINE` at 416. Verify the POST path keeps no entries pointing at the route (the POST delegates to `onboardBusinessAsAdmin` — if any of the four turn out to belong to POST, leave that one alone and say so in the commit body). Run `pnpm ci:tenant-scope`.

- [ ] **Step 3: Service test** (mock-sql harness, same pattern as `src/lib/admin/__tests__/jobs-service.test.ts`): one test pushing a list row with a real `Date` for `last_sync_at` plus a count row, asserting the DTO (**including that `lastSyncAt` is a `string`, not a `Date`** — this is the trap guard) and that the queries hit `businesses`/`accounts`/`responses` with the expected predicates; one empty-results test → `{ businesses: [], total: 0 }`.

- [ ] **Step 4: Run the existing route tests** — `pnpm vitest run src/app/api/admin/businesses` — green with **no assertion changes**.

- [ ] **Step 5: Server page** (complete file):

```tsx
import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { getAdminBusinessesList } from '@/lib/admin/businesses-list-service';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { BusinessesClient, PAGE_SIZE } from './BusinessesClient';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function AdminBusinessesPage() {
  await requireAdminPage(sql, { from: '/admin/businesses' });
  const data = await getAdminBusinessesList(sql, { limit: PAGE_SIZE, offset: 0 });

  return (
    <AdminPage
      group="Businesses"
      title="Businesses"
      description="Every location, its subscription state, and pending drafts"
      actions={/* Import CSV → /admin/locations/csv-import; + Add Business → /admin/businesses/new, styled like OverviewClient's actions (neutral border / gray-900 primary) */}
    >
      <BusinessesClient initialData={{ ...data, limit: PAGE_SIZE, offset: 0 }} />
    </AdminPage>
  );
}
```

- [ ] **Step 6: `BusinessesClient.tsx`** — the current page body, with these changes and nothing else:
  - `'use client'`; `export const PAGE_SIZE = 20 as const;`; props `{ initialData: BusinessListData }` where `BusinessListData = AdminBusinessesList & { limit: number; offset: number }`; `useQuery({ queryKey: ['admin-businesses', page], …, staleTime: 30_000, initialData: page === 0 ? initialData : undefined })`.
  - No `<AdminPage>` here (the server page owns chrome), no `min-h-screen bg-gray-50`, no `mx-auto max-w-5xl` wrapper.
  - **Delete the local `STATUS_STYLES` + `StatusBadge`** — use the shared `StatusBadge`. Note this changes the rendered label from `past due` to `past_due` (the shared badge renders the raw status); that is the deliberate single-owner tradeoff Phase 2 made on Overview.
  - Table → `DataTable` with `serverPagination={{ page, pageSize: PAGE_SIZE, totalRows: total, onPageChange: setPage }}` and `rowHref={(b) => \`/admin/businesses/${b.id}\`}` — this replaces the row-level `router.push` hack (delete the `useRouter` import) and the blue name cell (name renders plain; "View →" is the affordance, spec §5). Columns: Name (sortable), Category, Status (shared badge), Last Sync (keep `formatDate`), Pending (keep the yellow pill when `> 0`).
  - `emptyState={<EmptyState title="No businesses found" detail="Add one with + Add Business." />}`; the three-way error/loading split from convention #1, naming `GET /api/admin/businesses`.

- [ ] **Step 7: Add `src/app/admin/businesses/BusinessesClient.tsx` to SWEPT_FILES** and run the palette test.

- [ ] **Step 8: Client test** (3 tests): a fixture row renders its name + shared status badge text; the DataTable footer renders `Showing 1–20 of N` for a multi-page fixture; an empty fixture renders "No businesses found".

- [ ] **Step 9: Run** the new tests + `pnpm typecheck && pnpm lint && pnpm ci:db-imports && pnpm ci:tenant-scope`. **Step 10: Commit** — `git commit -m "feat(admin): businesses list server-first on shared primitives"`

---

### Task 3: Businesses detail — channels service + server page (both queries)

The heaviest page. Split into two commits so the risky part is isolated.

**Files:**
- Create: `src/lib/admin/business-channels-service.ts`, `src/lib/admin/__tests__/business-channels-service.test.ts`
- Modify: `src/app/api/admin/businesses/[id]/channels/route.ts`, `scripts/ci/tenant-scope-allowlist.ts`
- Rewrite: `src/app/admin/businesses/[id]/page.tsx`; Create: `src/app/admin/businesses/[id]/BusinessDetailClient.tsx`
- Modify: `src/app/admin/businesses/[id]/_hooks/useBusinessDetail.ts`, `_components/ZernioConnectionPanel.tsx`, `_components/ChannelsPanel.tsx`
- Modify: `src/__tests__/console-admin-palette.test.ts`
- Test: `src/app/admin/businesses/[id]/__tests__/BusinessDetailClient.test.tsx` (new); `_components/__tests__/ZernioConnectionPanel.test.tsx` (must stay green)

- [ ] **Step 1: AUDIT `getBusinessDetail` for the Date trap.** This is the single highest-risk step in Phase 3 and it must happen **before** the server page exists. Read `src/lib/admin/business-detail/mappers.ts` end to end alongside `src/lib/admin/business-detail-types.ts`. For **every** field typed `string` (or `string | null`) in `BusinessDetailResponse` that is sourced from a `timestamptz` column, confirm the mapper calls `.toISOString()`. Today the route's `JSON.stringify` hides any miss; a server page passing the same object over the RSC boundary does not. Fix each miss in the mapper (not at the call site), and add/extend a mapper test that feeds a real `Date` and asserts `typeof result.<field> === 'string'` for each one you touched. Record in the commit body which fields were converted. If the audit finds none, say so explicitly — "no misses found" is a valid, reviewable outcome.

- [ ] **Step 2: Extract the channels service.** Move the channels GET body (`src/app/api/admin/businesses/[id]/channels/route.ts` — the account resolution, the enrollment query, the per-channel dedup, and `maskChannelHandle`) verbatim into `getBusinessChannelEnrollments(sql, businessId: LocationId): Promise<{ enrollments: ChannelEnrollmentRow[] }>`. Convert every timestamp field to ISO in the service (`verified_at`, `disabled_at`, `unsubscribed_at`, `expires_at`, `last_activity_at` — check the actual set) and make the returned type match the client's `ChannelEnrollmentRow` in `src/app/admin/businesses/[id]/types.ts` exactly. Route becomes auth → `asLocationId` → service → JSON. Retarget the one allowlist entry at line 2124 to the service path (baseline unchanged). Service test: masking is applied, per-location override beats org-default, timestamps come out as strings.

- [ ] **Step 3: Run** `pnpm vitest run src/app/api/admin/businesses` + `pnpm ci:tenant-scope`. **Commit** — `git commit -m "refactor(admin): extract business-channels read service; ISO-convert detail timestamps"`

- [ ] **Step 4: Server page** (complete):

```tsx
import { notFound } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { asLocationId } from '@/lib/shared/ids';
import { getBusinessDetail } from '@/lib/admin/business-detail-service';
import { getBusinessChannelEnrollments } from '@/lib/admin/business-channels-service';
import { AdminPage } from '@/components/admin/ui/AdminPage';
import { BusinessDetailClient } from './BusinessDetailClient';

export const dynamic = 'force-dynamic';

export default async function AdminBusinessDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const businessId = asLocationId(id);
  await requireAdminPage(sql, { from: `/admin/businesses/${id}` });

  const [detail, channels] = await Promise.all([
    getBusinessDetail(sql, businessId),
    getBusinessChannelEnrollments(sql, businessId),
  ]);
  if (!detail) notFound();

  return (
    <AdminPage group="Businesses" title={detail.business.name} description={/* category + tier, or omit */}>
      <BusinessDetailClient businessId={id} initialDetail={detail} initialChannels={channels.enrollments} />
    </AdminPage>
  );
}
```

Note the two behavior improvements this buys, both intended: a missing business now renders the Next.js 404 instead of a full-screen "Failed to load business", and `Promise.all` keeps the two reads concurrent (do not serialize them).

- [ ] **Step 5: `useBusinessDetail` accepts initial data** — add an options param `{ initialDetail, initialChannels }` and pass each through as the respective `useQuery`'s `initialData`. Keep both query keys, the `invalidate()` fan-out, and `clearBounceFlag` exactly as they are. `channelsLoading`/`channelsError` stay exported (ChannelsPanel reads them).

- [ ] **Step 6: `BusinessDetailClient.tsx`** — the current page body moved over, with these changes and nothing else:
  - `'use client'`; props `{ businessId: string; initialDetail: BusinessDetailResponse; initialChannels: ChannelEnrollmentRow[] }`. Delete `useParams` (the id is a prop now).
  - Delete the `min-h-screen bg-gray-50` + `max-w-4xl` wrappers and the `<h1>` header block — `AdminPage` owns them. Keep the health badge, subscription/tier pills, category, and Maps link, moved into a compact meta row at the top of the body.
  - Replace "Back to Overview" with a back link to **`/admin/businesses`** (the list is now a first-class nav page; spec §5).
  - The two audit-log tables (Approval Audit Log, Account Audit Log) → `DataTable` with client-side pagination (they are already sliced to 10; pass the full array and let DataTable page it, dropping the `.slice(0, 10)`). Columns as today: Event / Actor / Date and Event / Location / Date. `emptyState` is unreachable (both are conditionally rendered on `length > 0`) — keep the guard and pass an `EmptyState` anyway for type completeness.
  - Error/loading follow convention #1, naming `GET /api/admin/businesses/${businessId}`. With `initialDetail` present the full-screen branch is effectively unreachable on first paint, which is the point — keep it for the refetch-failure-after-cache-eviction case.
  - Palette: the account-context card's `blue-50/blue-200/blue-600/blue-700` and the tier pill's `indigo-100/indigo-700` become neutral (`bg-gray-50 border-gray-200`, `bg-gray-100 text-gray-700`); the active-location chip becomes `bg-gray-900 text-white`. The bounce-flag banner stays red, the churn bars stay red/yellow/green, and the "primary" chip stays `yellow-*`. **Do not touch `text-rw-teal` in ReviewsList/ZernioConnectionPanel** (convention #6).

- [ ] **Step 7: Rename the colliding badge maps** per the decision above — `ZERNIO_CONNECTION_BADGE_STYLES` / `ZernioConnectionBadge` in `ZernioConnectionPanel.tsx`, `CHANNEL_ENROLLMENT_BADGE_STYLES` / `ChannelEnrollmentBadge` in `ChannelsPanel.tsx`. Add a one-line comment above each explaining why it is deliberately NOT the shared `StatusBadge` (vocabulary + labels differ; `pending` collides). Behavior and rendered classes stay identical — `ZernioConnectionPanel.test.tsx` must pass unmodified.

- [ ] **Step 8: SWEPT_FILES** — replace `src/app/admin/businesses/[id]/page.tsx` with `src/app/admin/businesses/[id]/BusinessDetailClient.tsx`, and add `_components/ChannelsPanel.tsx`, `_components/AutoApprovalDiagnosticsPanel.tsx`, `_components/ManualRankingSection.tsx`, `_components/TrackedKeywordsSection.tsx`, `_components/ProfileEditor.tsx` (all touched or adjacent to the neutral sweep). Run the palette test and neutralize whatever it flags.

- [ ] **Step 9: Client test** (4 tests): renders the business name and health badge from a fixture; the multi-location account card renders one chip per location with the current one marked; an approval-audit-log fixture renders a row through DataTable; the bounce-flag banner renders only when `ownerEmailBounced`.

- [ ] **Step 10: Run** `pnpm vitest run src/app/admin/businesses src/lib/admin` + `pnpm typecheck && pnpm lint && pnpm ci:db-imports`. **Step 11: Commit** — `git commit -m "feat(admin): business detail server-first, both queries; rename colliding badge maps"`

---

### Task 4: Businesses/new — server chrome + neutral form palette

**Files:**
- Rewrite: `src/app/admin/businesses/new/page.tsx`; Create: `src/app/admin/businesses/new/NewBusinessClient.tsx`
- Modify: `src/app/admin/businesses/new/_components/*.tsx`, `src/__tests__/console-admin-palette.test.ts`

No read data — this is a form. "Server-first" means chrome only.

- [ ] **Step 1:** `page.tsx` becomes a server component: `await requireAdminPage(sql, { from: '/admin/businesses/new' })` then `<AdminPage group="Businesses" title="Onboard new business" description="Create a location, its owner, and the initial sync"><NewBusinessClient /></AdminPage>`.
- [ ] **Step 2:** `NewBusinessClient.tsx` is the current page body verbatim minus the `min-h-screen bg-gray-50 py-10` / `mx-auto max-w-2xl` wrappers and the `<h1>`. Every hook, the `useForm` wiring, the `inputMode` payload branch, and the Stripe `window.location.href` escape (with its eslint-disable comment) move unchanged.
- [ ] **Step 3:** Neutralize the palette across the form: the submit button `bg-indigo-600/700 ring-indigo-*` → `bg-gray-900 hover:bg-gray-700 focus:ring-gray-500`; `focus:ring-blue-500` on inputs in `_components/*.tsx` and `_shared.tsx` → `focus:ring-gray-400`; keep the red error banner. Read all five `_components` files before editing — do not change field names, `register` bindings, or validation.
- [ ] **Step 4:** Add `src/app/admin/businesses/new/NewBusinessClient.tsx` and the four `_components/*.tsx` to SWEPT_FILES; run the palette test.
- [ ] **Step 5: Run** `pnpm typecheck && pnpm lint && REPWORTH_DISABLE_LIVE_DB_SUITES=1 pnpm vitest run src/app/admin`. **Step 6: Commit** — `git commit -m "feat(admin): new-business form on shared chrome, neutral palette"`

---

### Task 5: Locations CSV import — server chrome

**Files:** Modify `src/app/admin/locations/csv-import/page.tsx`, `CsvImportClient.tsx`, `src/__tests__/console-admin-palette.test.ts`; `__tests__/CsvImportClient.test.tsx` must stay green.

- [ ] **Step 1:** `page.tsx` gains the gate + chrome: `await requireAdminPage(sql, { from: '/admin/locations/csv-import' })` then `<AdminPage group="Businesses" title="Locations import" description="Bulk-add locations to an existing account from a CSV">`. Title matches the sidebar label in `nav-config.ts` — check it and use that exact wording.
- [ ] **Step 2:** `CsvImportClient.tsx` drops its `min-h-screen bg-gray-50` / `mx-auto max-w-3xl` wrapper and its `<h1>` (lines ~134-140). Everything else — the upload flow, `csv-validation` wiring, the preview table, the result summary — stays. Neutralize decorative blue; keep red/yellow/green validation states. If the preview/result table is a plain `<table>`, leave it: it is a transient validation preview, not a data page, and DataTable's sort/paginate semantics do not fit. Say so in the commit body.
- [ ] **Step 3:** Add `CsvImportClient.tsx` to SWEPT_FILES; run the palette test + `pnpm vitest run src/app/admin/locations`.
- [ ] **Step 4: Commit** — `git commit -m "feat(admin): csv-import page on shared chrome"`

---

### Task 6: Offboardings — service extraction + AAL2 server page

**Files:**
- Create: `src/lib/admin/offboardings-service.ts`, `src/lib/admin/__tests__/offboardings-service.test.ts`
- Modify: `src/app/api/admin/offboardings/route.ts`, `scripts/ci/tenant-scope-allowlist.ts`, `src/__tests__/console-admin-palette.test.ts`
- Rewrite: `src/app/admin/offboardings/page.tsx`; Modify: `src/app/admin/offboardings/OffboardingsClient.tsx`
- Test: `src/app/admin/offboardings/__tests__/OffboardingsClient.test.tsx` (new)

- [ ] **Step 1: Extract the service.** Move the list query, the count query, `mapOffboardingRow`, `formatTimestamp`, and `scrubAdminLastError` verbatim into `getAdminOffboardings(sql, { limit, offset })`. `scrubAdminLastError` is a security-relevant redactor — move it byte-for-byte, do not "improve" the regexes. Export the DTO types (`AdminOffboarding`, `AdminProviderDisposition`) from the service and delete the client's hand-copied duplicates in favor of importing them. Clamping stays in the route; the `NO_STORE` header and `internalError` mapping stay in the route.
- [ ] **Step 2: Retarget three allowlist entries** (lines 2382, 2389, 2396) to `src/lib/admin/offboardings-service.ts`. Baseline unchanged. Run `pnpm ci:tenant-scope`.
- [ ] **Step 3: Service test** (mock-sql): a row with `Date` timestamps maps to ISO strings; `is_stuck` passes through; `scrubAdminLastError` redacts a `Bearer` token and an `api_key=` pair and truncates at 500 chars; empty results → `{ offboardings: [], total: 0 }`.
- [ ] **Step 4: Run the existing route tests** (if any) — green unmodified.
- [ ] **Step 5: Server page** — `await requireAdminPage(sql, { from: '/admin/offboardings', aal2: true })` (gate parity, convention #7 — the route uses `requireAdminWithAal2`), then `getAdminOffboardings(sql, { limit: PAGE_SIZE, offset: 0 })`, wrapped in `<AdminPage group="Businesses" title="Offboardings" description="Active, failed, and stuck account offboarding lifecycles">`.
- [ ] **Step 6: `OffboardingsClient.tsx`** — accept `initialData`, wire it into the existing `useQuery(['admin-offboardings', offset])` (`initialData: offset === 0 ? initialData : undefined`, keep `refetchInterval: 30_000`); export `PAGE_SIZE`. Drop the `min-h-screen` wrapper and the header block. Keep the card layout, the disposition mutation, and all form behavior. Rename its local `StatusBadge` to **`ToneBadge`** — it is a tone-keyed presentational badge (`neutral`/`warning`/`danger`), not a status→color map, and the name currently shadows the shared primitive; the rename is the same trap-removal as Task 3. Footer → `PaginationFooter` from Task 1 (this is the second card-list consumer, and it fixes the same `visibleCount < PAGE_SIZE` dead-end heuristic). `EmptyState` for "No active offboardings"; error/loading per convention #1 naming `GET /api/admin/offboardings`; neutralize the blue submit button.
- [ ] **Step 7:** Add `OffboardingsClient.tsx` to SWEPT_FILES. Client test (3 tests): a fixture card renders account name + status tones; a `failed` item renders the danger badge and its `lastError`; the footer renders `Showing 1–50 of N`.
- [ ] **Step 8: Run** the new tests + `pnpm typecheck && pnpm lint && pnpm ci:db-imports && pnpm ci:tenant-scope && pnpm ci:admin-aal2`. **Step 9: Commit** — `git commit -m "feat(admin): offboardings server-first (AAL2 page gate) with extracted service"`

---

### Task 7: Demos — service extraction + server page

**Files:**
- Create: `src/lib/admin/demos-service.ts`, `src/lib/admin/__tests__/demos-service.test.ts`
- Modify: `src/app/api/admin/demos/route.ts`, `scripts/ci/tenant-scope-allowlist.ts`, `src/__tests__/console-admin-palette.test.ts`
- Rewrite: `src/app/admin/demos/page.tsx`; Create: `src/app/admin/demos/DemosClient.tsx`, `__tests__/DemosClient.test.tsx`

- [ ] **Step 1: Extract** `getAdminDemos(sql): Promise<DemoListItem[]>` — the single query + mapping moved verbatim (it already `.toISOString()`s both timestamps; keep that). Route becomes auth → service → JSON. Retarget the one allowlist entry (line 2827) to the service path; baseline unchanged.
- [ ] **Step 2: Service test** (mock-sql): rows map to `DemoListItem` with ISO strings; empty → `[]`.
- [ ] **Step 3: Server page** — gate `{ from: '/admin/demos' }`, fetch, `<AdminPage group="Growth" title="Demos" description="Generate and share prospect demo pages"><DemosClient initialData={demos} /></AdminPage>`.
- [ ] **Step 4: `DemosClient.tsx`** — the whole current page body (GenerateForm + DemoList + DemoRow) moves into one client file, minus the `min-h-screen` wrapper and `<h1>`. `useQuery(['demos'], …, { initialData })` — **keep the conditional `refetchInterval` exactly as written** (it polls at 5s only while a demo is `queued`/`running`; do not replace it with a fixed interval). Two fixes while here: `DemoRow` reads `window.location.origin` during render — move it into the `handleCopy` handler so the component is SSR-safe now that the tree renders on the server; and the `setTimeout` that clears `copied` must be cleared on unmount. Keep the local `STATUS_STYLES` for generation status but rename to `DEMO_STATUS_STYLES` (fourth shadowing site) — generation status is a demo-domain vocabulary with an `animate-pulse` running state the shared badge cannot express. Neutralize the blue buttons/links; `EmptyState` for "No demos generated yet"; error/loading per convention #1 naming `GET /api/admin/demos`.
- [ ] **Step 5:** Add `DemosClient.tsx` to SWEPT_FILES. Client test (3 tests): a completed demo renders its `/demo/<slug>` link and Copy Link; a failed demo renders its `generationError`; an empty fixture renders the empty state.
- [ ] **Step 6: Run** the new tests + `pnpm typecheck && pnpm lint && pnpm ci:tenant-scope`. **Step 7: Commit** — `git commit -m "feat(admin): demos page server-first with extracted service"`

---

### Task 8: Impersonation (start + view) — shared chrome

**Files:** Modify `src/app/admin/impersonate/page.tsx`, `ImpersonationStartClient.tsx`, `[sessionId]/view/page.tsx`; `__tests__/ImpersonationStartClient.test.tsx` and `[sessionId]/view/__tests__/EndImpersonationButton.test.tsx` must stay green.

- [ ] **Step 1: Start page** — already a server component. Add `await requireAdminPage(sql, { from: '/admin/impersonate' })` and replace the hand-rolled header + wrappers with `<AdminPage group="Growth" title="Impersonation" description="Start a scoped, read-only support session tied to a ticket and audit log">`.
- [ ] **Step 2: `ImpersonationStartClient.tsx`** — neutralize: the blue info card → `border-gray-200 bg-gray-50` with gray text; input focus rings `blue-500/blue-200` → `gray-400`; submit `bg-blue-600/700` → `bg-gray-900/gray-700`. Keep the reducer, the POST, the `router.push(viewUrl)`, and the error paragraph exactly as they are (the existing test asserts them).
- [ ] **Step 3: View page** — **do NOT swap its gate.** It resolves an impersonation session via `resolveImpersonationViewSession` with its own AAL2 + signed-cookie logic and four distinct redirect/notFound outcomes; `requireAdminPage` cannot express that. Leave the resolution block byte-for-byte. Only replace the `min-h-screen bg-gray-50` / `mx-auto max-w-5xl` wrappers and the "Account" eyebrow + `<h1>` with `<AdminPage group="Growth" title={session.accountDisplayName ?? session.accountId} description="Read-only support context">`, keep the session banner as the first child, and convert the Locations `<table>` to `DataTable` (columns Name / Location ID / State; `emptyState={<EmptyState title="No locations found for this account." />}`; no `rowHref` — nothing to link to inside a read-only session). Neutralize the blue banner to `border-gray-300 bg-gray-100`, keeping the "Admin view-as session" heading prominent.
- [ ] **Step 4:** Both files are already in SWEPT_FILES — run the palette test plus `pnpm vitest run src/app/admin/impersonate` and `pnpm typecheck && pnpm lint`.
- [ ] **Step 5: Commit** — `git commit -m "feat(admin): impersonation start + view on shared chrome"`

---

### Task 9: AdminPage chrome convergence (the five Phase 2 clients)

**Files:** Modify `src/app/admin/{overview,jobs,costs,notifications,flagged}/page.tsx` and their `*Client.tsx`; their existing client tests must stay green (they may need a wrapper adjustment — see Step 3).

Phase 2 left `<AdminPage>` inside the client component on these five, so page chrome renders only after hydration and every page owns its own copy of the group/title strings. Move it to the server page, matching the Phase 3 pages.

- [ ] **Step 1: For each of the five** — lift the `<AdminPage …>` element (group, title, description, and for Overview its three `actions` links, which are static `<Link>`s with no client state) out of the client's return and into the server page, wrapping `<XClient …/>`. The client's return becomes the fragment that was `AdminPage`'s children — loading/error/content states all stay inside, so the three-way split of convention #1 is untouched.
- [ ] **Step 2: Overview's `actions`** move to the server page verbatim. Confirm no `actions` node on any of the five reads client state before moving it; if one does (it should not), leave that page's chrome in the client and note why in the commit body.
- [ ] **Step 3: Fix the tests, minimally.** Client tests that assert on the page title or the group breadcrumb are now asserting on something the client no longer renders. Prefer moving those assertions to a new `__tests__/page-source.test.ts` per page (source-level: the server page contains `<AdminPage`, the right `group=`, and the right `title=`) over deleting them. Behavioral assertions must not change.
- [ ] **Step 4: Run** `REPWORTH_DISABLE_LIVE_DB_SUITES=1 pnpm vitest run src/app/admin` + `pnpm typecheck && pnpm lint`. **Step 5: Commit** — `git commit -m "refactor(admin): converge AdminPage chrome onto the server pages"`

---

### Task 10: Orphaned-style sweep

**Files:** discovered by the sweep; expect `src/app/admin/loading.tsx`, `src/app/admin/error.tsx`, `src/components/admin/*`, and stale test assertions.

- [ ] **Step 1: Find dead code.** Run `pnpm ci:fallow` **unpiped** (piping through `tail`/`head` masks its exit code and produced a false green in Phase 1 — run it bare and read the whole output). Cross-check with `rg` for: components under `src/components/admin/` with no importer; exported helpers in the migrated pages that lost their last caller; `min-h-screen bg-gray-50` still present anywhere under `src/app/admin/` (only `layout.tsx` should own it now); any remaining local `StatusBadge` declaration under `src/app/admin/` (after Tasks 2/3/6/7 the only survivors should be the four deliberately-renamed domain badges).
- [ ] **Step 2: Check the shared chrome files** — `src/app/admin/loading.tsx` and `error.tsx` were written for the pre-sidebar layout. Verify they still render sensibly inside the shell (no doubled `min-h-screen`, no full-viewport centering that fights the sidebar) and align `loading.tsx` with `TableSkeleton` if it hand-rolls one.
- [ ] **Step 3: Verify nav completeness** — every page under `src/app/admin/` (excluding the three auth routes) appears exactly once in `ADMIN_NAV_GROUPS`, and every nav `href` resolves to a real page. The `AdminSidebar` test asserts the second half; add the first-half assertion (filesystem → nav) if it is missing, since Phase 3 is the last chance for the IA to drift silently.
- [ ] **Step 4: Delete what is dead**, fix what is stale, and grep every deleted filename for cross-references (repo rule). Do not delete anything whose only "unused" evidence is a fallow heuristic — confirm with `rg` first.
- [ ] **Step 5: Run** the full local gate. **Step 6: Commit** — `git commit -m "chore(admin): sweep styles and components orphaned by the console redesign"`

---

### Task 11: Full gates + whole-branch review + PR

- [ ] **Step 1:** `pnpm lint && pnpm typecheck && REPWORTH_DISABLE_LIVE_DB_SUITES=1 pnpm test` — all green. Investigate every failure against the branch diff; no "unrelated" dismissals without evidence.
- [ ] **Step 2:** `pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:db-imports && pnpm ci:static-policy && pnpm ci:admin-aal2 && pnpm ci:live-db-suites`. `ALLOWLIST_BASELINE` must still read **416** with all 9 entries retargeted to `src/lib/admin/*` paths — verify by diffing the allowlist file and counting.
- [ ] **Step 3:** `pnpm ci:fallow` — **unpiped**. Read the exit code.
- [ ] **Step 4:** `pnpm build` — must succeed (seven new server/client splits).
- [ ] **Step 5: Whole-branch review** (controller dispatches). Integration concerns beyond what per-task reviews cover: `initialData` shape parity between every server page and its client's query type; **every timestamp crossing the RSC boundary is a string** (the Task 3 audit generalized to all seven pages); gate parity page↔route on offboardings; no page renders two `<AdminPage>`s or zero after Task 9; the four renamed domain badge maps have no remaining shadow of the shared name; SWEPT_FILES covers every new client; DataTable/PaginationFooter behavior identical across its four consumers.
- [ ] **Step 6: Push + PR** to `main`, titled `feat(admin): console Phase 3 — Businesses + Growth server-first, chrome convergence, orphan sweep`. Body: per-page changes, the badge-collision decision and its rationale, the 9 retargeted allowlist entries with the unchanged baseline, the Task 3 timestamp audit findings, and the gates run. Tick this plan's checkboxes in the same push.
- [ ] **Step 7:** Verify the Vercel preview: `/admin/businesses` (table + pagination + View →), a detail page (both panels populated on first paint, no spinner), `/admin/businesses/new`, `/admin/offboardings` (AAL2 → MFA challenge if not stepped up), `/admin/demos`, `/admin/impersonate`, `/admin/locations/csv-import`, and one Phase 2 page to confirm the chrome move (`/admin/jobs`). Mobile viewport spot-check on the two widest tables.
