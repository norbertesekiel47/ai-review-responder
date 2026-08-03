# Admin Console Phase 2 — Operate + Safety Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the eight Operate + Safety admin pages to server-first fetching and the shared Phase 1 primitives, so first paint arrives with data and every page reads as one system.

**Architecture:** Each `page.tsx` becomes a server component: `requireAdminPage(sql, …)` gate → initial data via the owning `src/lib/admin/*` service → client component receives it as react-query `initialData`. Routes with inline SQL (jobs, notifications, flagged GET) get their queries extracted into services that route AND page both call; route behavior stays byte-identical so existing route tests keep passing. DataTable gains a `serverPagination` mode (all data pages paginate server-side). Pages drop their own `min-h-screen bg-gray-50` wrappers (the Phase 1 shell owns that) and local badge/color maps (StatusBadge owns that).

**Tech Stack:** Next.js 16 App Router (server components + `next/headers` cookies), @tanstack/react-query `initialData`, Postgres.js via `@/lib/db/server` (composition roots only), Vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-07-30-admin-console-redesign-design.md` (§4 data fetching, §5 workflow, §6 errors, §8 rollout phase 2)

**Working directory:** the `admin-console-phase2` worktree at `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/admin-console-phase2` — every path below is relative to that root. Never edit the parent checkout.

**Carried forward from the Phase 1 final review** (addressed here): AdminPage `group` becomes a union derived from `ADMIN_NAV_GROUPS` (Task 2); overview's divergent local `STATUS_BADGE_CLASSES` map is deleted in favor of the shared `StatusBadge` (Task 5); Safety pages lose `bg-rw-cream` for the Pro Tool neutral palette (Tasks 9–10). Deferred, NOT in this plan: the `job_outbox(status='failed')` partial index (revisit if poll volume shows up in metrics); the `STATUS_BADGE_STYLES` name collision with local maps in `businesses/[id]/_components` (Phase 3 scope — those files are untouched here).

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/auth/page-gate.ts` (create) | `requireAdminPage(sql, {from, aal2?})` — server-component admin gate, returns the app user or redirects |
| `src/components/admin/ui/DataTable.tsx` (modify) | Add `serverPagination` mode (controlled page + total, "Showing a–b of N" footer) |
| `src/components/admin/ui/AdminPage.tsx` (modify) | `group` prop → `AdminNavGroupLabel` union |
| `src/components/admin/nav-config.ts` (modify) | `as const satisfies` + export `AdminNavGroupLabel` |
| `src/components/admin/ui/StatusBadge.tsx` (modify) | Add `delivered` key (green) for notification status |
| `src/lib/admin/jobs-service.ts` (create) | `getAdminJobsData(sql, {limit, offset})` — outbox summary + failed page + count (SQL moved verbatim from route) |
| `src/lib/admin/queue-health.ts` (create) | `fetchQueueHealth()` — worker internal call, moved verbatim from jobs route |
| `src/lib/admin/notifications-service.ts` (create) | `getAdminNotifications(sql, filters)` — moved verbatim from route |
| `src/lib/admin/flagged-service.ts` (create) | `listOpenFlaggedResponses(sql, {limit, offset})` — GET query moved verbatim from route (POST tx stays in route) |
| `src/app/api/admin/{jobs,notifications,flagged}/route.ts` (modify) | Delegate to the services; behavior unchanged |
| `src/app/admin/{overview,jobs,costs,notifications}/page.tsx` (rewrite) | Thin server pages: gate → service → client with initialData |
| `src/app/admin/{overview,jobs,costs,notifications}/*Client.tsx` (create) | The current page bodies, migrated onto the primitives |
| `src/app/admin/runbook/page.tsx` (modify) | Server component + AdminPage chrome (static content unchanged) |
| `src/app/admin/flagged/page.tsx` (rewrite) + `FlaggedClient.tsx` (create) | AAL2-gated server page + card list on primitives |
| `src/app/admin/autonomy/page.tsx` (modify) + `AutonomySuspensionsClient.tsx` (modify) | Server-fetch initialData; restyle cream → neutral; AdminPage chrome |
| `src/app/admin/security/page.tsx` (modify) | AdminPage chrome (no data change) |
| Tests | New: page-gate, DataTable server mode, per-page client tests. Updated: `console-admin-palette.test.ts` SWEPT_FILES, `runbook-empty-polish.test.ts`, autonomy/security `page-source.test.ts` if wrapper assertions change |

Binding conventions for every task:
- Pages are sanctioned composition roots (`ci:db-imports` treats any `src/app/**/page.tsx` as a root) — they import `@/lib/db/server` and pass `sql` down. Services/helpers NEVER import it.
- Client components keep their existing react-query keys, poll intervals, and mutation flows unless a step says otherwise. `initialData` is additive.
- Every migrated page: AdminPage chrome (correct `group`), shared `EmptyState`/`ErrorState` (errors name the failed request per spec §6), no local `min-h-screen bg-gray-50` wrapper, no local badge color maps, neutral gray palette (no `rw-*` tokens, no amber/orange/stone — the palette sweep test enforces part of this).
- Full-suite runs use `REPWORTH_DISABLE_LIVE_DB_SUITES=1 pnpm test` (local :5432 not running — documented kill switch).
- Commit after every task; never push until the final task.

---

### Task 1: `requireAdminPage` server-page gate

**Files:**
- Create: `src/lib/auth/page-gate.ts`
- Test: `src/lib/auth/__tests__/page-gate.test.ts`

The helper mirrors the ONE existing server-page auth pattern — read `src/app/admin/impersonate/[sessionId]/view/page.tsx` first and reuse its exact Supabase client construction and MFA imports (`requireCurrentAal2FromSupabase`, `mfaChallengePath` from `src/lib/auth/mfa.ts`). The proxy already gates `/admin/*`; this is defense-in-depth plus "give the page the user".

- [x] **Step 1: Read the reference pattern**

Read `src/app/admin/impersonate/[sessionId]/view/page.tsx` and note: how it builds the cookie-store-backed `createServerClient` (env var names, `getAll`/no-op `setAll`), how it calls `requireCurrentAal2FromSupabase`, and the exact redirect targets (`/admin/login`, `mfaChallengePath(...)`).

- [x] **Step 2: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const { mockCookies, mockRedirect, mockGetUser, mockAal2, mockSql, sqlReturnQueue, resetMockSql } =
  await vi.hoisted(async () => {
    const { createMockSql } = await import('../../../../worker/__tests__/helpers/mock-sql');
    return {
      mockCookies: vi.fn(),
      mockRedirect: vi.fn((url: string) => {
        throw new Error(`REDIRECT:${url}`);
      }),
      mockGetUser: vi.fn(),
      mockAal2: vi.fn(),
      ...createMockSql(),
    };
  });

vi.mock('next/headers', () => ({ cookies: mockCookies }));
vi.mock('next/navigation', () => ({ redirect: mockRedirect }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: mockGetUser } })),
}));
vi.mock('@/lib/auth/mfa', () => ({
  requireCurrentAal2FromSupabase: mockAal2,
  mfaChallengePath: (from: string) => `/admin/mfa-challenge?from=${encodeURIComponent(from)}`,
}));

import { requireAdminPage } from '../page-gate';

const sql = mockSql as unknown as Sql;

describe('requireAdminPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMockSql();
    mockCookies.mockResolvedValue({ getAll: () => [] });
  });

  it('redirects to /admin/login when there is no session', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });

    await expect(requireAdminPage(sql, { from: '/admin/jobs' })).rejects.toThrow(
      'REDIRECT:/admin/login?from=%2Fadmin%2Fjobs',
    );
  });

  it('redirects to /admin/login when the user is not an admin', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
    sqlReturnQueue.push([{ id: 'user-1', role: 'owner' }]);

    await expect(requireAdminPage(sql, { from: '/admin/jobs' })).rejects.toThrow(
      'REDIRECT:/admin/login?from=%2Fadmin%2Fjobs',
    );
  });

  it('returns the admin user when the session is valid', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
    sqlReturnQueue.push([{ id: 'user-1', role: 'admin' }]);

    const user = await requireAdminPage(sql, { from: '/admin/jobs' });

    expect(user).toEqual({ id: 'user-1', role: 'admin' });
    expect(mockAal2).not.toHaveBeenCalled();
  });

  it('enforces AAL2 when requested and redirects to the MFA challenge on mfa_required', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
    sqlReturnQueue.push([{ id: 'user-1', role: 'admin' }]);
    mockAal2.mockResolvedValue({ ok: false, reason: 'mfa_required' });

    await expect(requireAdminPage(sql, { from: '/admin/flagged', aal2: true })).rejects.toThrow(
      'REDIRECT:/admin/mfa-challenge?from=%2Fadmin%2Fflagged',
    );
  });

  it('passes AAL2 when the check returns ok', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null });
    sqlReturnQueue.push([{ id: 'user-1', role: 'admin' }]);
    mockAal2.mockResolvedValue({ ok: true });

    const user = await requireAdminPage(sql, { from: '/admin/flagged', aal2: true });

    expect(user.role).toBe('admin');
  });
});
```

IMPORTANT: before finalizing the test, check the REAL return shape of `requireCurrentAal2FromSupabase` in `src/lib/auth/mfa.ts` and the REAL signature of `mfaChallengePath`, and adjust the mock + assertions to match them exactly (the shapes above are a sketch). Same for the env var names the Supabase client needs — set them via `vi.stubEnv` if the module reads them at call time.

- [x] **Step 3: Run it, expect failure** (`../page-gate` not found):
`pnpm vitest run src/lib/auth/__tests__/page-gate.test.ts`

- [x] **Step 4: Write the implementation**

```ts
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createServerClient } from '@supabase/ssr';
import type { Sql } from 'postgres';
import { mfaChallengePath, requireCurrentAal2FromSupabase } from '@/lib/auth/mfa';

export interface AdminPageUser {
  id: string;
  role: string;
}

interface RequireAdminPageOptions {
  /** The current page path, used as the ?from= redirect target. */
  from: string;
  /** Require an AAL2 (MFA step-up) session — Safety pages reading sensitive content. */
  aal2?: boolean;
}

/**
 * Server-component admin gate (spec §4). Defense-in-depth behind src/proxy.ts's
 * /admin gate — its real job is giving the page the authenticated admin user.
 * Takes `sql` explicitly (invariant #15); pages are the composition roots.
 */
export async function requireAdminPage(
  sql: Sql,
  { from, aal2 = false }: RequireAdminPageOptions,
): Promise<AdminPageUser> {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: () => {
          /* server components cannot write cookies; proxy owns session refresh */
        },
      },
    },
  );

  const loginRedirect = `/admin/login?from=${encodeURIComponent(from)}`;

  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) redirect(loginRedirect);

  const rows = await sql<AdminPageUser[]>`
    SELECT id, role FROM users WHERE auth_id = ${authUser.id} LIMIT 1
  `;
  const appUser = rows[0];
  if (!appUser || appUser.role !== 'admin') redirect(loginRedirect);

  if (aal2) {
    const aal = await requireCurrentAal2FromSupabase(supabase);
    if (!aal.ok) redirect(mfaChallengePath(from));
  }

  return appUser;
}
```

Adjust the exact `createServerClient` construction, env var names, and the AAL2 result handling to mirror `impersonate/[sessionId]/view/page.tsx` — that file is the authority; if it differs from this sketch, follow it and keep the test in sync.

- [x] **Step 5: Run the test, expect PASS (5 tests).** Also run `pnpm typecheck` and `pnpm ci:db-imports` (the helper must NOT trip it — it takes `sql` as a param and imports nothing from `@/lib/db/server`).

- [x] **Step 6: Commit**

```bash
git add src/lib/auth/page-gate.ts src/lib/auth/__tests__/page-gate.test.ts
git commit -m "feat(admin): requireAdminPage server-component gate"
```

---

### Task 2: Primitive extensions — DataTable server pagination, AdminPage group union, StatusBadge `delivered`

**Files:**
- Modify: `src/components/admin/ui/DataTable.tsx`
- Modify: `src/components/admin/ui/AdminPage.tsx`
- Modify: `src/components/admin/nav-config.ts`
- Modify: `src/components/admin/ui/StatusBadge.tsx`
- Test: `src/components/admin/ui/__tests__/DataTable.test.tsx` (extend), `src/components/admin/ui/__tests__/StatusBadge.test.tsx` (extend)

- [x] **Step 1: Write the failing DataTable tests** (append to the existing describe block):

```tsx
  it('server pagination: renders given rows as-is with Showing footer and controlled navigation', async () => {
    const onPageChange = vi.fn();
    render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        emptyState={<EmptyState title="none" />}
        serverPagination={{ page: 1, pageSize: 3, totalRows: 8, onPageChange }}
      />,
    );
    expect(names()).toEqual(['Bravo', 'Alpha', 'Charlie']);
    expect(screen.getByText('Showing 4–6 of 8')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onPageChange).toHaveBeenCalledWith(0);
  });

  it('server pagination: disables Previous on first page and Next on last page', () => {
    const { rerender } = render(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        emptyState={<EmptyState title="none" />}
        serverPagination={{ page: 0, pageSize: 3, totalRows: 8, onPageChange: () => {} }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    rerender(
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        emptyState={<EmptyState title="none" />}
        serverPagination={{ page: 2, pageSize: 3, totalRows: 8, onPageChange: () => {} }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });
```

New StatusBadge assertion (append inside the outbox describe): extend the coverage list with `'delivered'`:

```tsx
  it('has an explicit style for the notification delivered status', () => {
    expect(STATUS_BADGE_STYLES['delivered']).toBeDefined();
  });
```

- [x] **Step 2: Run both test files, expect the new cases to FAIL.**

- [x] **Step 3: Implement DataTable `serverPagination`**

Add to the props:

```tsx
interface ServerPagination {
  page: number;
  pageSize: number;
  totalRows: number;
  onPageChange: (page: number) => void;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowHref?: (row: T) => string;
  pageSize?: number;
  emptyState: ReactNode;
  /** Controlled mode: rows are ONE server page; the caller owns fetching. Client-side sort stays within the page. */
  serverPagination?: ServerPagination;
}
```

Behavior changes inside the component (keep the uncontrolled path byte-identical):
- When `serverPagination` is set: skip slicing (`visible = sorted`), compute `pageCount = Math.max(1, Math.ceil(totalRows / serverPagination.pageSize))` and `currentPage = serverPagination.page`; footer renders `Showing ${start}–${end} of ${totalRows}` where `start = currentPage * pageSize + 1`, `end = Math.min(start + rows.length - 1, totalRows)`; Previous/Next call `onPageChange(currentPage ∓ 1)` with the same disabled logic; `toggleSort` does NOT reset the page (sort is within the current server page).
- Footer visibility: in server mode render the footer whenever `totalRows > rows.length || pageCount > 1` (so "Showing 1–8 of 8" single-page case stays hidden, same as uncontrolled).

- [x] **Step 4: Implement the AdminPage group union**

`src/components/admin/nav-config.ts`: change the array declaration to

```ts
export const ADMIN_NAV_GROUPS = [
  /* …existing groups unchanged… */
] as const satisfies readonly AdminNavGroup[];

export type AdminNavGroupLabel = (typeof ADMIN_NAV_GROUPS)[number]['label'];
```

(`AdminNavItem`/`AdminNavGroup` interfaces need `readonly items: readonly AdminNavItem[]` — adjust so `satisfies` compiles; `AdminSidebar` consumes it read-only so no call-site changes.)

`src/components/admin/ui/AdminPage.tsx`:

```tsx
import type { AdminNavGroupLabel } from '../nav-config';
// group: AdminNavGroupLabel  (was string)
```

- [x] **Step 5: Add StatusBadge `delivered`** — one entry in `STATUS_BADGE_STYLES`: `delivered: 'bg-green-100 text-green-800',` placed with the other literal keys, comment updated to mention the notification-delivery derived statuses (`delivered` literal; `pending`/`failed` already exist).

- [x] **Step 6: Run all ui tests + typecheck + lint; expect green** (`pnpm vitest run src/components/admin`).

- [x] **Step 7: Commit**

```bash
git add src/components/admin
git commit -m "feat(admin): DataTable server pagination, AdminPage group union, StatusBadge delivered"
```

---

### Task 3: Jobs service extraction (route unchanged in behavior)

**Files:**
- Create: `src/lib/admin/jobs-service.ts`
- Create: `src/lib/admin/queue-health.ts`
- Modify: `src/app/api/admin/jobs/route.ts`
- Test: `src/lib/admin/__tests__/jobs-service.test.ts` (new); `src/app/api/admin/jobs/__tests__/route.test.ts` (must stay green, updated mocks only if import paths change)

- [x] **Step 1: Move `fetchQueueHealth` verbatim** from `route.ts` into `src/lib/admin/queue-health.ts` (exported), including `QUEUE_HEALTH_TIMEOUT_MS`, the `PoolWaitPayload` mirror type, and every degrade branch (missing secret → no fetch, bad URL, non-200, missing `queues`, throw/timeout → `{ queueHealth: { unavailable: true }, pool: null }`). No logic changes — the 11 existing route tests define its contract.

- [x] **Step 2: Create `jobs-service.ts`** — move the route's three SQL queries verbatim:

```ts
import type { Sql } from 'postgres';

export interface AdminJobsData {
  outbox: { pending: number; dispatching: number; dispatched: number; failed: number; completedToday: number };
  failedJobs: { id: string; topic: string; lastError: string | null; attempts: number; maxAttempts: number; createdAt: string }[];
  failedTotal: number;
}

export async function getAdminJobsData(sql: Sql, { limit, offset }: { limit: number; offset: number }): Promise<AdminJobsData> {
  /* the route's outbox-summary query, failed-jobs page query, and failed-count
     query, moved VERBATIM (same SQL text, same Promise.all structure), with the
     same row→DTO mapping the route does today. */
}
```

Match the exact field names the route currently returns (read the route's response shaping first — the interface above must be corrected to whatever the route actually sends, because the client page consumes it).

- [x] **Step 3: Refactor `route.ts`** to: auth → parse limit/offset (unchanged clamping) → `Promise.all([getAdminJobsData(sql, {limit, offset}), fetchQueueHealth()])` → assemble the identical JSON shape. Delete the moved code. The route response must be byte-compatible.

- [x] **Step 4: Write `jobs-service.test.ts`** with the mock-sql harness (same pattern as `nav-counts-service.test.ts`): one test pushing three result sets and asserting the DTO shape + that the three queries hit `job_outbox` with the expected predicates; one empty-results test.

- [x] **Step 5: Run** `pnpm vitest run src/lib/admin/__tests__/jobs-service.test.ts src/app/api/admin/jobs/__tests__/route.test.ts` — service tests green AND all 11 existing route tests green (update only their mock import paths if `fetchQueueHealth` moved out; the behavioral assertions must not change).

- [x] **Step 6: Commit** — `git add src/lib/admin src/app/api/admin/jobs && git commit -m "refactor(admin): extract jobs + queue-health services from route"`

---

### Task 4: Jobs page migration (the exemplar)

**Files:**
- Rewrite: `src/app/admin/jobs/page.tsx` (server)
- Create: `src/app/admin/jobs/JobsClient.tsx`
- Test: `src/app/admin/jobs/__tests__/JobsClient.test.tsx` (new)

- [x] **Step 1: Write the server page** (complete file):

```tsx
import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { getAdminJobsData } from '@/lib/admin/jobs-service';
import { fetchQueueHealth } from '@/lib/admin/queue-health';
import { JobsClient } from './JobsClient';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

export default async function AdminJobsPage() {
  await requireAdminPage(sql, { from: '/admin/jobs' });

  const [jobs, health] = await Promise.all([
    getAdminJobsData(sql, { limit: PAGE_SIZE, offset: 0 }),
    fetchQueueHealth(),
  ]);

  return <JobsClient initialData={{ ...jobs, ...health }} />;
}
```

(Adjust the spread to build EXACTLY the shape `GET /api/admin/jobs` returns — the client's `initialData` must be assignable to the query's data type.)

- [x] **Step 2: Write `JobsClient.tsx`** — move the current page body, with these changes and nothing else:
  - `'use client'`; props `{ initialData: JobsData }`; `useQuery({ queryKey: ['admin-jobs', page], queryFn, refetchInterval: 30_000, staleTime: 30_000, initialData: page === 0 ? initialData : undefined })`.
  - Wrap everything in `<AdminPage group="Operate" title="Jobs" description="Outbox, queue depth, and failed jobs">` and DELETE the old header + `min-h-screen bg-gray-50` + `mx-auto max-w-*` wrappers (AdminPage owns chrome).
  - The 5 outbox tiles become `StatTile`s: Pending (`alert` when > 10), Dispatching, Dispatched, Failed (`alert` when > 0), Completed Today — delete the local `COLOR_CLASSES` map.
  - Failed-jobs table becomes `DataTable` with `serverPagination={{ page, pageSize: 20, totalRows: failedTotal, onPageChange: setPage }}` and columns (complete):

```tsx
const columns: DataTableColumn<FailedJob>[] = [
  { key: 'topic', header: 'Topic', render: (j) => <span className="font-mono text-xs">{j.topic}</span> },
  { key: 'error', header: 'Error', render: (j) => <span className="block max-w-md truncate" title={j.lastError ?? ''}>{j.lastError ?? '—'}</span> },
  { key: 'attempts', header: 'Attempts', render: (j) => `${j.attempts}/${j.maxAttempts}` },
  { key: 'created', header: 'Created', render: (j) => new Date(j.createdAt).toLocaleString() },
];
```

  - `emptyState={<EmptyState title="No failed jobs" detail="Nothing is stuck right now." />}`; loading (only when no data) → `<TableSkeleton />`. Error is non-blanking: full-screen `ErrorState` only when there's no cached data yet (`isError && !data`) — `<ErrorState title="Couldn't load jobs" detail="GET /api/admin/jobs failed" onRetry={() => refetch()} />`; when a background refetch fails but cached data is still on screen (`isError && data`), do NOT blank the page — render the normal content with a slim inline notice above it, reusing the same component: `<ErrorState title="Last refresh failed" detail="GET /api/admin/jobs failed — showing the last loaded data." onRetry={() => refetch()} />`. This three-way split (skeleton / full-screen error / inline "last refresh failed" + content) is the pattern every later Operate/Safety page copies — see Tasks 5–7.
  - Per-queue depth cards and the pool-wait pill keep their existing markup (they are not DataTable-shaped) but swap the `STATE_STYLES` color literals for neutral grays + the red/yellow they already use — no `rw-*`, no amber (use `yellow` classes already present).

- [x] **Step 3: Write `JobsClient.test.tsx`** (jsdom, QueryClientProvider, stub fetch): render with a fixture `initialData` and assert — the five StatTile labels render with their values; the failed-jobs table shows a row's topic and `Showing 1–1 of 1`-style footer math is NOT shown for a single short page; the empty fixture renders "No failed jobs". (3 tests.)

- [x] **Step 4: Run** the new test + `pnpm typecheck && pnpm lint`. Then delete nothing else — confirm `git status` shows only the three files.

- [x] **Step 5: Commit** — `git commit -m "feat(admin): jobs page server-first on shared primitives"`

---

### Task 5: Overview page migration + needs-attention strip

**Files:**
- Rewrite: `src/app/admin/overview/page.tsx` (server)
- Create: `src/app/admin/overview/OverviewClient.tsx`
- Modify: `src/__tests__/console-admin-palette.test.ts` (SWEPT_FILES: replace `overview/page.tsx` with `overview/OverviewClient.tsx`)
- Test: `src/app/admin/overview/__tests__/OverviewClient.test.tsx` (new)

- [x] **Step 1: Server page** (complete):

```tsx
import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { getAdminOverview } from '@/lib/admin/overview-service';
import { getAdminNavCounts } from '@/lib/admin/nav-counts-service';
import { OverviewClient } from './OverviewClient';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

export default async function AdminOverviewPage() {
  await requireAdminPage(sql, { from: '/admin/overview' });

  const [overview, navCounts] = await Promise.all([
    getAdminOverview(sql, { limit: PAGE_SIZE, offset: 0 }),
    getAdminNavCounts(sql),
  ]);

  return <OverviewClient initialData={overview} flaggedOpen={navCounts.flaggedOpen} />;
}
```

- [x] **Step 2: `OverviewClient.tsx`** — move the body; changes:
  - Props `{ initialData: OverviewData; flaggedOpen: number }`; `useQuery(['admin-overview', page], …, initialData: page === 0 ? initialData : undefined)`, keep `refetchInterval: 30_000`.
  - `<AdminPage group="Operate" title="Overview" description="System health and every business at a glance" actions={…existing header links as small buttons…}>`.
  - DELETE the local `StatusBadge`, `STATUS_BADGE_CLASSES`, `STATUS_BADGE_LABELS` — use the shared `StatusBadge` (`<StatusBadge status={b.subscriptionStatus} />`). The label styling differences die here deliberately (single owner).
  - Health tiles → `StatTile`s: Pending Outbox (`alert` >10), Failed Jobs (`alert` >0), Today's API Cost, Notif Failures 24h (`alert` >0). The email-health card keeps its custom two-line body inside a `StatTile` `sub` (alert when `redState`).
  - **Needs-attention strip (spec §5)** — directly under the tiles, render at most one compact card listing only the true conditions, each a plain link:

```tsx
const attention = [
  systemHealth.failedJobs > 0 && { href: '/admin/jobs', label: `${systemHealth.failedJobs} failed job(s)` },
  flaggedOpen > 0 && { href: '/admin/flagged', label: `${flaggedOpen} flagged response(s) awaiting review` },
  systemHealth.pendingOutbox > 10 && { href: '/admin/jobs', label: `${systemHealth.pendingOutbox} outbox rows pending` },
  (systemHealth.notificationFailures24h > 0 || systemHealth.emailHealth.redState) && { href: '/admin/notifications', label: 'notification delivery needs a look' },
].filter(Boolean) as { href: string; label: string }[];
```

Render nothing when empty (calm default), else a white card titled "Needs attention" with each item as `<Link>` rows.
  - Businesses table → `DataTable` with `serverPagination` (totalRows from `totalBusinesses`), `rowHref={(b) => \`/admin/businesses/${b.id}\`}` replacing BOTH the row-level `router.push` hack and the inline name `<Link>` (name column renders plain text now — the View → column is the affordance, spec §5). Columns: complete the 8 existing columns, e.g.:

```tsx
const columns: DataTableColumn<BusinessRow>[] = [
  { key: 'name', header: 'Name', render: (b) => <span className="font-medium">{b.name}</span>, sortValue: (b) => b.name },
  { key: 'status', header: 'Status', render: (b) => <StatusBadge status={b.subscriptionStatus} /> },
  { key: 'pending', header: 'Pending', render: (b) => b.pendingCount, sortValue: (b) => b.pendingCount },
  { key: 'reconnect', header: 'Reconnect', render: (b) => /* keep existing cell content */ },
  { key: 'responseRate', header: `Response rate (${windowDays}d)`, render: (b) => /* keep */ },
  { key: 'avgTime', header: `Avg time (${windowDays}d)`, render: (b) => /* keep */ },
  { key: 'lastActivity', header: 'Last activity', render: (b) => /* keep formatRelative cell */ },
  { key: 'health', header: 'Health', render: (b) => /* keep HealthBadge */ },
];
```

(“keep” cells: move the existing JSX for that cell into the render function unchanged — the explorer map lists them; do not redesign cell content.)
  - Shared states: `EmptyState` ("No businesses found"); `TableSkeleton` while loading with no data; error follows the Task 4 non-blanking pattern — full-screen `ErrorState` naming `GET /api/admin/overview` only when `isError && !data`, otherwise an inline "Last refresh failed" `ErrorState` above the still-rendered content.
  - Palette: neutral grays only (the palette sweep test now targets this file — no amber/orange/stone).

- [x] **Step 3: Update `console-admin-palette.test.ts`** SWEPT_FILES entry to the new client path. Run it.

- [x] **Step 4: `OverviewClient.test.tsx`** (3 tests): tiles render from fixture; needs-attention shows the failed-jobs link when `failedJobs > 0` and is absent when all clear; businesses table renders a row with shared StatusBadge text.

- [x] **Step 5: Run** new tests + palette test + `pnpm typecheck && pnpm lint`.

- [x] **Step 6: Commit** — `git commit -m "feat(admin): overview server-first landing with needs-attention strip"`

---

### Task 6: Costs page migration

**Files:**
- Rewrite: `src/app/admin/costs/page.tsx` (server); Create: `src/app/admin/costs/CostsClient.tsx`
- Test: `src/app/admin/costs/__tests__/CostsClient.test.tsx` (new)

- [x] **Step 1: Server page** — same pattern as Task 4/5, calling the existing services with the page's defaults:

```tsx
import { sql } from '@/lib/db/server';
import { requireAdminPage } from '@/lib/auth/page-gate';
import { parseCostQuery, getCostReport } from '@/lib/admin/cost-report-service';
import { getMarginReport } from '@/lib/admin/margin-service';
import { CostsClient } from './CostsClient';

export const dynamic = 'force-dynamic';

export default async function AdminCostsPage() {
  await requireAdminPage(sql, { from: '/admin/costs' });

  const query = parseCostQuery(new URLSearchParams('days=30&limit=20&offset=0'));
  const [report, margin] = await Promise.all([
    getCostReport(sql, query),
    getMarginReport(sql, { limit: 20 }).catch(() => null),
  ]);

  return <CostsClient initialData={{ ...report, margin }} />;
}
```

(Check `parseCostQuery`'s actual parameter type first — if it takes the route's `searchParams` object rather than `URLSearchParams`, build what it expects. The default `days` must match the client's initial state — 30.)

- [x] **Step 2: `CostsClient.tsx`** — move the body; changes:
  - Props/useQuery wiring as in Task 4 (`initialData` only when `days === 30 && page === 0`).
  - `<AdminPage group="Operate" title="Costs" description="LLM + API spend and margin by account">`.
  - Day-range pills stay (they are a filter, not FilterBar's search — keep the existing pill markup, restyled neutral).
  - Global spend bar, By Provider and By Day mini-tables: keep custom markup (3-col minis, not worth DataTable) but strip `rw-*` tokens → neutral grays; red states stay red.
  - By Business table → `DataTable` with `serverPagination`; columns complete (7 existing: Business/Tier/Period Total/Calls/Today/Daily Limit/% of Limit with the red-badge ≥80% rendered inside the render function as today).
  - Margin section: keep structure; `RiskBadge` stays (risk levels aren't shared statuses); platform KPI numbers become three `StatTile`s; Top Accounts table keeps custom markup (9 cols with row tinting — move unchanged, neutralize palette).
  - Shared Empty/Error/Skeleton states follow the Task 4 non-blanking error pattern (full-screen `ErrorState` only when `isError && !data`; otherwise an inline "Last refresh failed" notice above the still-rendered content) — unlike Task 4, the `ErrorState` detail interpolates the active query params instead of a static string, e.g. `` `GET /api/admin/costs?days=${days} failed` ``.

- [x] **Step 3: `CostsClient.test.tsx`** (2 tests): renders period totals + a business row from fixture; `margin: null` fixture renders the page without the margin section (no crash).

- [x] **Step 4: Run** new tests + the costs route tests (`pnpm vitest run src/app/api/admin/costs/__tests__/route.test.ts` — untouched, must stay green) + typecheck + lint.

- [x] **Step 5: Commit** — `git commit -m "feat(admin): costs page server-first on shared primitives"`

---

### Task 7: Notifications service extraction + page migration

**Files:**
- Create: `src/lib/admin/notifications-service.ts`; Modify: `src/app/api/admin/notifications/route.ts`
- Rewrite: `src/app/admin/notifications/page.tsx`; Create: `src/app/admin/notifications/NotificationsClient.tsx`
- Test: `src/lib/admin/__tests__/notifications-service.test.ts`, `src/app/admin/notifications/__tests__/NotificationsClient.test.tsx` (new)

- [x] **Step 1: Extract the service** — move the route's dynamic-WHERE data query, count query, and businesses-dropdown query verbatim into `getAdminNotifications(sql, filters)` where `filters = { limit, offset, businessId?, accountId?, channel?, status? }`, returning the route's exact current JSON shape. Route becomes auth → parse → service → JSON. Keep `sql.unsafe` usage as-is (it is parameterized — do not rewrite the query builder).

- [x] **Step 2: Service test** (mock-sql harness): filters produce WHERE fragments (assert `sqlCalls` text contains `business_id` when businessId passed); empty results → `{ deliveries: [], total: 0, businesses: [] }`-shaped zeros (match real field names from the route).

- [x] **Step 3: Server page** — pattern as before; initial fetch with `{ limit: 20, offset: 0 }`, no filters.

- [x] **Step 4: `NotificationsClient.tsx`** — move the body; changes: AdminPage chrome (`group="Operate"`, title "Notifications", description "Delivery log across channels"); keep the three `<select>` filters + Reset in a toolbar row above the table (FilterBar's search box doesn't fit selects — do NOT force it); table → `DataTable` with `serverPagination`; the status pill derives a string then uses the shared badge:

```tsx
function deliveryStatus(d: Delivery): 'delivered' | 'failed' | 'pending' {
  if (d.deliveredAt) return 'delivered';
  if (d.failedAt) return 'failed';
  return 'pending';
}
// column: { key: 'status', header: 'Status', render: (d) => <span title={d.failureReason ?? undefined}><StatusBadge status={deliveryStatus(d)} /></span> }
```

Columns complete: Business / Channel / Recipient (mono) / Template / Sent / Status. Shared Empty/Error/Skeleton states follow the Task 4 non-blanking error pattern (full-screen `ErrorState` only when `isError && !data`; otherwise an inline "Last refresh failed" notice above the still-rendered content), error naming `GET /api/admin/notifications`.

- [x] **Step 5: Client test** (2 tests): a delivered row renders the `delivered` badge; a failed row's status cell carries `title` = failureReason.

- [x] **Step 6: Run** all new tests + typecheck + lint. **Step 7: Commit** — `git commit -m "feat(admin): notifications server-first with extracted service"`

---

### Task 8: Runbook → server component with chrome

**Files:**
- Modify: `src/app/admin/runbook/page.tsx`
- Modify: `src/__tests__/runbook-empty-polish.test.ts`

- [x] **Step 1:** Remove `'use client'` (the page has zero hooks). Wrap content in `<AdminPage group="Operate" title="Runbook" description="First-response playbook for support scenarios">`; delete the old header + `min-h-screen` wrapper. Keep `SCENARIOS`, the table markup, the `DocRef` URL guard, and the callout card unchanged. Turn the plain-text `/admin/notifications` and `/admin/jobs` references in the prose into `<Link>`s (spec §5 cross-linking).
- [x] **Step 2:** Update `runbook-empty-polish.test.ts` — it asserts the root wrapper carries `min-h-screen`, which the shell now owns. Change the assertion to what the polish rule actually protects: the page renders inside `AdminPage` (assert the source contains `<AdminPage` and does NOT contain `min-h-screen`). Keep the file's other assertions.
- [x] **Step 3:** Run that test + typecheck + lint. **Step 4: Commit** — `git commit -m "feat(admin): runbook server component with shared chrome"`

---

### Task 9: Flagged service extraction + page migration (AAL2)

**Files:**
- Create: `src/lib/admin/flagged-service.ts`; Modify: `src/app/api/admin/flagged/route.ts` (GET only)
- Rewrite: `src/app/admin/flagged/page.tsx`; Create: `src/app/admin/flagged/FlaggedClient.tsx`
- Test: `src/lib/admin/__tests__/flagged-service.test.ts` (new); `src/app/api/admin/flagged/__tests__/route.test.ts` must stay green

- [x] **Step 1: Extract GET query** — `listOpenFlaggedResponses(sql, { limit, offset })` moves the join + count verbatim, returning the route's display shape. The POST disposition transaction STAYS in the route (it is a mutation orchestrator; nothing else calls it). Route GET delegates; all existing route tests stay green (update mocks' import paths only).

- [x] **Step 2: Server page** — `await requireAdminPage(sql, { from: '/admin/flagged', aal2: true })` (flagged content is the AAL2-gated surface — the page gate must match the route gate), then initial fetch `{ limit: 50, offset: 0 }`, render `<FlaggedClient initialData={…} />`.

- [x] **Step 3: `FlaggedClient.tsx`** — move the body; changes: AdminPage chrome (`group="Safety"`, title "Flagged responses", description "Held drafts awaiting your disposition"); KEEP the card list layout, the three-action mutation flow, `LiveRegion`, and the offset pagination exactly as they are (swap the footer buttons' styling to match DataTable's footer buttons for consistency); severity pill stays local (severity is not a shared status); shared `EmptyState` ("No open flagged responses", detail "Every held draft has been dispositioned.") + `ErrorState` naming `GET /api/admin/flagged` + `TableSkeleton`; neutral palette sweep.

- [x] **Step 4: Service test** (mock-sql): asserts `status = 'open'` predicate + limit/offset binding; empty → `{ flagged: [], total: 0 }` (match real field names).

- [x] **Step 5: Run** service test + all flagged route tests + typecheck + lint. **Step 6: Commit** — `git commit -m "feat(admin): flagged queue server-first (AAL2 page gate) with extracted read service"`

---

### Task 10: Autonomy migration (server initialData + neutral restyle)

**Files:**
- Modify: `src/app/admin/autonomy/page.tsx`, `src/app/admin/autonomy/AutonomySuspensionsClient.tsx`
- Tests that must stay green (update only styling assertions if they break): `page-source.test.ts`, `AutonomySuspensionsClient.test.tsx`

- [x] **Step 1: Server page** — already a server component. Add: `await requireAdminPage(sql, { from: '/admin/autonomy', aal2: true })`; fetch `listSuspendedPolicies(sql)` (already a service in `src/lib/auto-approval/suspension.ts`); replace the page's own header block with `<AdminPage group="Safety" title="Autonomy suspensions" description="Accounts the Governor has pulled out of Autopilot">` wrapping `<AutonomySuspensionsClient initialData={suspensions} />`. Page keeps zero `'use client'` (page-source test).
- [x] **Step 2: Client** — accept `initialData`, wire into the existing `useQuery(['admin-autonomy-suspensions'])` (`initialData`, keep `refetchInterval: 30_000`). Restyle: every `rw-cream`/`rw-teal-strong`/`rw-sage`/`rw-blush`/`rw-danger` class → the neutral Pro Tool equivalents used by the other migrated pages (white cards, gray borders, red for danger, green for success). Keep ALL behavior the existing client test asserts: trimmed-note POST, `role="status"` toast, disabled-until-nonempty button, exact aria-labels/names. Empty state → shared `EmptyState`; error banner → shared `ErrorState`.
- [x] **Step 3: Run** `pnpm vitest run src/app/admin/autonomy` — all green (fix styling-only assertion breaks by updating the test to the new classes; behavioral assertions must not change). Typecheck + lint.
- [x] **Step 4: Commit** — `git commit -m "feat(admin): autonomy page server initialData + pro-tool restyle"`

---

### Task 11: Security page chrome

**Files:**
- Modify: `src/app/admin/security/page.tsx`
- Test: `src/app/admin/security/__tests__/page-source.test.ts` must stay green

- [x] **Step 1:** Wrap `<AdminSecurityClient />` in `<AdminPage group="Safety" title="Security" description="Your admin account's MFA enrollment">`, replacing the page's own header block. No auth-gate addition (the page renders only the caller's own MFA state via the Supabase client — nothing to server-fetch), no client changes. Page stays server, no gradients/hex (page-source test).
- [x] **Step 2:** Run the page-source test + typecheck + lint. **Step 3: Commit** — `git commit -m "feat(admin): security page shared chrome"`

---

### Task 12: Full gates + final review + PR

- [x] **Step 1:** `pnpm lint && pnpm typecheck && REPWORTH_DISABLE_LIVE_DB_SUITES=1 pnpm test` — all green; investigate any failure against the branch diff (no "unrelated" dismissals without evidence).
- [x] **Step 2:** `pnpm ci:tenant-scope && pnpm ci:rls-audit && pnpm ci:db-imports && pnpm ci:fallow` — the three extracted services contain moved (not new) cross-tenant admin queries; if `ci:tenant-scope` flags the moved sites (file paths changed!), move/adjust the existing allowlist entries for those queries to the new service paths — entry COUNT must stay identical (baseline unchanged) unless a genuinely new query appeared (there should be none).
- [x] **Step 3:** `pnpm build` — must succeed (server pages + client splits are new build surface).
- [x] **Step 4:** Final whole-branch review (controller dispatches it — integration concerns: initialData shape mismatches between server pages and clients; gate parity between page and route on Safety pages; palette consistency; anything the per-task reviews missed).
- [ ] **Step 5:** Push + PR to `main` titled `feat(admin): console Phase 2 — Operate + Safety pages server-first on shared primitives`, body summarizing per-page changes, gates, and the deferred items (partial index, Phase 3 Businesses/Growth + the STATUS_BADGE_STYLES collision note). Tick this plan's remaining checkboxes in the same push.
- [ ] **Step 6:** Verify the Vercel preview: `/admin/overview` (tiles + needs-attention + table), `/admin/jobs`, `/admin/flagged` (AAL2 → MFA challenge if not stepped up), `/admin/autonomy` (neutral restyle), mobile viewport spot-check.

---

## Phase 3 pointer (not in this plan)

Businesses (list/detail/new — including the `STATUS_BADGE_STYLES` local-map collision in `businesses/[id]/_components`), Locations import, Offboardings, Demos, Support/impersonation, plus orphaned-style sweep. Plan it after this PR merges.
