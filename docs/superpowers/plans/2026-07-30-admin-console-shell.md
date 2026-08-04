# Admin Console Shell (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat admin top-nav with a grouped dark sidebar (with live badge counts), and land the seven shared UI primitives every admin page will migrate onto in Phases 2–3.

**Architecture:** New client component `AdminSidebar` (nav config + 60s-polled badge counts from a new `GET /api/admin/nav-counts` route backed by `src/lib/admin/nav-counts-service.ts`) replaces `AdminNav` in `src/app/admin/layout.tsx`. Primitives live in `src/components/admin/ui/`. Page internals are untouched in this phase — they render inside the new shell as-is. Phases 2–3 (page migrations to server-first + primitives) get their own plans once this lands.

**Tech Stack:** Next.js 16 App Router, Tailwind, @tanstack/react-query (already the admin fetch layer), Postgres.js via `@/lib/db/server` (route/service only), Vitest + @testing-library/react (jsdom).

**Spec:** `docs/superpowers/specs/2026-07-30-admin-console-redesign-design.md`

**Working directory:** the `admin-console-redesign` worktree at `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/admin-console-redesign` — every path below is relative to that root. Never edit the parent checkout.

**Deviation from spec (deliberate):** the spec retires `AdminNav.tsx` in Phase 3, but the layout swap in Task 8 makes it dead code immediately — this plan deletes it in Task 8 instead of carrying a dead component for two phases.

---

## File structure

| File | Responsibility |
|---|---|
| `src/components/admin/ui/StatusBadge.tsx` (create) | Single status→color mapping for subscription + outbox statuses |
| `src/components/admin/ui/StatTile.tsx` (create) | KPI tile, `alert` variant |
| `src/components/admin/ui/states.tsx` (create) | `EmptyState`, `ErrorState`, `TableSkeleton` (change together, one file) |
| `src/components/admin/ui/AdminPage.tsx` (create) | Page chrome: breadcrumb group, title, description, actions slot |
| `src/components/admin/ui/DataTable.tsx` (create) | Generic sortable/paginated table with row-link affordance |
| `src/components/admin/ui/FilterBar.tsx` (create) | Search input + filter chips + row count |
| `src/components/admin/nav-config.ts` (create) | `ADMIN_NAV_GROUPS`, `ADMIN_AUTH_ROUTES` — nav structure as data |
| `src/components/admin/AdminSidebar.tsx` (create) | Dark sidebar, mobile drawer, active state, badge polling |
| `src/lib/admin/nav-counts-service.ts` (create) | `getAdminNavCounts(sql)` — the two COUNT queries |
| `src/app/api/admin/nav-counts/route.ts` (create) | Thin admin-gated GET orchestrator (invariant #12) |
| `src/app/admin/layout.tsx` (modify) | Render sidebar + `<main>` instead of `AdminNav` |
| `src/components/admin/AdminNav.tsx` (delete) | Dead after layout swap |
| `scripts/ci/tenant-scope-allowlist.ts` (modify, only if audit flags) | Allowlist the two admin COUNT queries + baseline bump |

Notes that bind every task:
- Icons: **inline SVG only** (repo rule — no lucide/heroicons).
- No new dependencies.
- Status strings: import from `src/lib/shared/subscription-status.ts` (`SubscriptionStatus`) and `src/lib/shared/job-outbox-status.ts` (`OUTBOX_IN_FLIGHT_STATUSES`). The outbox terminal statuses `completed`/`failed` have no exported constant owner (the jobs route spells them inline); StatusBadge defines them as map keys, matching existing practice.
- Component tests need the `// @vitest-environment jsdom` pragma (repo convention, see `src/app/admin/autonomy/__tests__/AutonomySuspensionsClient.test.tsx`).

---

### Task 1: StatusBadge

**Files:**
- Create: `src/components/admin/ui/StatusBadge.tsx`
- Test: `src/components/admin/ui/__tests__/StatusBadge.test.tsx`

- [x] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { OUTBOX_IN_FLIGHT_STATUSES } from '@/lib/shared/job-outbox-status';
import { StatusBadge, STATUS_BADGE_STYLES } from '../StatusBadge';

describe('StatusBadge', () => {
  it('has an explicit style for every subscription status (no fallthrough)', () => {
    for (const status of Object.values(SubscriptionStatus)) {
      expect(STATUS_BADGE_STYLES[status], `missing style for ${status}`).toBeDefined();
    }
  });

  it('has an explicit style for every outbox status (no fallthrough)', () => {
    for (const status of [...OUTBOX_IN_FLIGHT_STATUSES, 'completed', 'failed']) {
      expect(STATUS_BADGE_STYLES[status], `missing style for ${status}`).toBeDefined();
    }
  });

  it('renders the status text', () => {
    render(<StatusBadge status={SubscriptionStatus.PAST_DUE} />);
    expect(screen.getByText('past_due')).toBeInTheDocument();
  });

  it('renders unknown statuses with the neutral style instead of crashing', () => {
    render(<StatusBadge status="some_future_status" />);
    const badge = screen.getByText('some_future_status');
    expect(badge.className).toContain('bg-gray-100');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/admin/ui/__tests__/StatusBadge.test.tsx`
Expected: FAIL — cannot resolve `../StatusBadge`.

- [x] **Step 3: Write the implementation**

```tsx
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

// One authoritative status → style mapping for the admin console. Pages never
// hand-pick badge colors (spec §3). Subscription keys come from the const enum;
// outbox terminal statuses have no exported constant owner (the jobs route
// spells them inline), so they are literal keys here, matching that practice.
export const STATUS_BADGE_STYLES: Record<string, string> = {
  [SubscriptionStatus.ACTIVE]: 'bg-green-100 text-green-800',
  [SubscriptionStatus.TRIALING]: 'bg-blue-100 text-blue-800',
  [SubscriptionStatus.PAST_DUE]: 'bg-red-100 text-red-800',
  [SubscriptionStatus.CANCELLED]: 'bg-gray-100 text-gray-700',
  [SubscriptionStatus.PENDING_PAYMENT]: 'bg-amber-100 text-amber-800',
  pending: 'bg-amber-100 text-amber-800',
  dispatching: 'bg-blue-100 text-blue-800',
  dispatched: 'bg-blue-100 text-blue-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
};

const NEUTRAL = 'bg-gray-100 text-gray-700';

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_BADGE_STYLES[status] ?? NEUTRAL;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${style}`}
    >
      {status}
    </span>
  );
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/admin/ui/__tests__/StatusBadge.test.tsx`
Expected: PASS (4 tests).

- [x] **Step 5: Commit**

```bash
git add src/components/admin/ui/StatusBadge.tsx src/components/admin/ui/__tests__/StatusBadge.test.tsx
git commit -m "feat(admin): StatusBadge primitive — single status→color owner"
```

---

### Task 2: StatTile + states (EmptyState, ErrorState, TableSkeleton)

**Files:**
- Create: `src/components/admin/ui/StatTile.tsx`
- Create: `src/components/admin/ui/states.tsx`
- Test: `src/components/admin/ui/__tests__/StatTile.test.tsx`

These are presentational; one focused test covers the conditional logic (alert variant, retry callback).

- [x] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { StatTile } from '../StatTile';
import { ErrorState } from '../states';

describe('StatTile', () => {
  it('renders label, value, and sub text', () => {
    render(<StatTile label="Today" value="$4.12" sub="vs yesterday" />);
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByText('$4.12')).toBeInTheDocument();
    expect(screen.getByText('vs yesterday')).toBeInTheDocument();
  });

  it('applies the alert variant border', () => {
    const { container } = render(<StatTile label="At risk" value={2} alert />);
    expect(container.firstElementChild?.className).toContain('border-red-300');
  });
});

describe('ErrorState', () => {
  it('names the failed request and wires Retry', async () => {
    const onRetry = vi.fn();
    render(<ErrorState title="Couldn't load jobs" detail="GET /api/admin/jobs failed (500)" onRetry={onRetry} />);
    expect(screen.getByText("Couldn't load jobs")).toBeInTheDocument();
    expect(screen.getByText('GET /api/admin/jobs failed (500)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/admin/ui/__tests__/StatTile.test.tsx`
Expected: FAIL — modules not found.

- [x] **Step 3: Write `StatTile.tsx`**

```tsx
import type { ReactNode } from 'react';

interface StatTileProps {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** Red-border variant for breached thresholds (spec §3). */
  alert?: boolean;
}

export function StatTile({ label, value, sub, alert = false }: StatTileProps) {
  return (
    <div
      className={`rounded-md border bg-white px-3 py-2 ${
        alert ? 'border-red-300 bg-red-50' : 'border-gray-200'
      }`}
    >
      <div className={`text-[10px] font-medium uppercase tracking-wide ${alert ? 'text-red-700' : 'text-gray-500'}`}>
        {label}
      </div>
      <div className={`text-lg font-bold ${alert ? 'text-red-700' : 'text-gray-900'}`}>{value}</div>
      {sub != null && <div className={`text-xs ${alert ? 'text-red-600' : 'text-gray-500'}`}>{sub}</div>}
    </div>
  );
}
```

- [x] **Step 4: Write `states.tsx`**

```tsx
interface EmptyStateProps {
  title: string;
  detail?: string;
}

export function EmptyState({ title, detail }: EmptyStateProps) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-8 text-center">
      <div className="text-sm font-semibold text-gray-900">{title}</div>
      {detail && <div className="mt-1 text-sm text-gray-500">{detail}</div>}
    </div>
  );
}

interface ErrorStateProps {
  title: string;
  /** Name the failed request, e.g. "GET /api/admin/jobs failed (500)" (spec §6). */
  detail: string;
  onRetry?: () => void;
}

export function ErrorState({ title, detail, onRetry }: ErrorStateProps) {
  return (
    <div className="rounded-md border border-red-300 bg-red-50 p-4">
      <div className="text-sm font-semibold text-red-800">{title}</div>
      <div className="mt-0.5 text-sm text-red-700">{detail}</div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 rounded-md border border-red-300 bg-white px-3 py-1 text-sm font-medium text-red-700 hover:bg-red-100"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="animate-pulse rounded-md border border-gray-200 bg-white p-4" aria-hidden="true">
      <div className="mb-3 h-3 w-2/5 rounded bg-gray-200" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="mb-2 h-3 w-full rounded bg-gray-100" />
      ))}
    </div>
  );
}
```

- [x] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/components/admin/ui/__tests__/StatTile.test.tsx`
Expected: PASS (3 tests).

- [x] **Step 6: Commit**

```bash
git add src/components/admin/ui/StatTile.tsx src/components/admin/ui/states.tsx src/components/admin/ui/__tests__/StatTile.test.tsx
git commit -m "feat(admin): StatTile + EmptyState/ErrorState/TableSkeleton primitives"
```

---

### Task 3: AdminPage chrome

**Files:**
- Create: `src/components/admin/ui/AdminPage.tsx`
- Test: `src/components/admin/ui/__tests__/AdminPage.test.tsx`

- [x] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AdminPage } from '../AdminPage';

describe('AdminPage', () => {
  it('renders group, title, description, actions, and children', () => {
    render(
      <AdminPage group="Operate" title="Costs" description="LLM + API spend" actions={<button>Export</button>}>
        <div>page body</div>
      </AdminPage>,
    );
    expect(screen.getByText('Operate')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Costs' })).toBeInTheDocument();
    expect(screen.getByText('LLM + API spend')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByText('page body')).toBeInTheDocument();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/admin/ui/__tests__/AdminPage.test.tsx`
Expected: FAIL — module not found.

- [x] **Step 3: Write the implementation**

```tsx
import type { ReactNode } from 'react';

interface AdminPageProps {
  /** Sidebar group name, shown as breadcrumb (Operate · Businesses · Safety · Growth). */
  group: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function AdminPage({ group, title, description, actions, children }: AdminPageProps) {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <div className="text-xs text-gray-500">{group}</div>
          <h1 className="text-xl font-bold text-gray-900">{title}</h1>
          {description && <p className="mt-0.5 text-sm text-gray-500">{description}</p>}
        </div>
        {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/admin/ui/__tests__/AdminPage.test.tsx`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/components/admin/ui/AdminPage.tsx src/components/admin/ui/__tests__/AdminPage.test.tsx
git commit -m "feat(admin): AdminPage chrome primitive"
```

---

### Task 4: DataTable

**Files:**
- Create: `src/components/admin/ui/DataTable.tsx`
- Test: `src/components/admin/ui/__tests__/DataTable.test.tsx`

Client-side sort + pagination (Phase 1 scope). Pages with server-side pagination keep their own fetch params and can pass a single page of rows; extending DataTable to controlled mode is a Phase 2 decision if needed.

- [x] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { DataTable, type DataTableColumn } from '../DataTable';
import { EmptyState } from '../states';

interface Row { id: string; name: string; spend: number }

const columns: DataTableColumn<Row>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name, sortValue: (r) => r.name },
  { key: 'spend', header: 'Spend', render: (r) => `$${r.spend}`, sortValue: (r) => r.spend },
];

const rows: Row[] = [
  { id: '1', name: 'Bravo', spend: 30 },
  { id: '2', name: 'Alpha', spend: 10 },
  { id: '3', name: 'Charlie', spend: 20 },
];

function names(): string[] {
  // First cell of each body row.
  return screen.getAllByRole('row').slice(1).map((row) => row.cells[0].textContent ?? '');
}

describe('DataTable', () => {
  it('renders rows in given order by default', () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} emptyState={<EmptyState title="none" />} />);
    expect(names()).toEqual(['Bravo', 'Alpha', 'Charlie']);
  });

  it('sorts by column on header click, toggling direction', async () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} emptyState={<EmptyState title="none" />} />);
    await userEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(names()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    await userEvent.click(screen.getByRole('button', { name: /Name/ }));
    expect(names()).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('paginates and navigates pages', async () => {
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} pageSize={2} emptyState={<EmptyState title="none" />} />);
    expect(names()).toEqual(['Bravo', 'Alpha']);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(names()).toEqual(['Charlie']);
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  });

  it('renders the empty state when there are no rows', () => {
    render(<DataTable columns={columns} rows={[]} rowKey={(r) => r.id} emptyState={<EmptyState title="No rows yet" />} />);
    expect(screen.getByText('No rows yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders a View link per row when rowHref is provided', () => {
    render(
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} rowHref={(r) => `/admin/businesses/${r.id}`} emptyState={<EmptyState title="none" />} />,
    );
    const links = screen.getAllByRole('link', { name: 'View →' });
    expect(links).toHaveLength(3);
    expect(links[0]).toHaveAttribute('href', '/admin/businesses/1');
  });
});
```

Note: `row.cells` needs the `HTMLTableRowElement` type — if TS complains in the helper, cast: `(row as HTMLTableRowElement).cells`.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/admin/ui/__tests__/DataTable.test.tsx`
Expected: FAIL — module not found.

- [x] **Step 3: Write the implementation**

```tsx
'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  /** Provide to make the column sortable. */
  sortValue?: (row: T) => string | number;
  /** Extra cell classes, e.g. 'text-right'. */
  className?: string;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** When set, each row gets a trailing "View →" link column. */
  rowHref?: (row: T) => string;
  pageSize?: number;
  emptyState: ReactNode;
}

interface SortState {
  key: string;
  dir: 'asc' | 'desc';
}

export function DataTable<T>({ columns, rows, rowKey, rowHref, pageSize = 20, emptyState }: DataTableProps<T>) {
  const [sort, setSort] = useState<SortState | null>(null);
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const sortValue = columns.find((col) => col.key === sort.key)?.sortValue;
    if (!sortValue) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const aValue = sortValue(a);
      const bValue = sortValue(b);
      if (aValue === bValue) return 0;
      return aValue < bValue ? -dir : dir;
    });
  }, [rows, sort, columns]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = sorted.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  function toggleSort(key: string) {
    setPage(0);
    setSort((prev) =>
      prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  }

  if (rows.length === 0) return <>{emptyState}</>;

  return (
    <div className="overflow-hidden rounded-md border border-gray-200 bg-white">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              {columns.map((col) => (
                <th key={col.key} className={`px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-gray-500 ${col.className ?? ''}`}>
                  {col.sortValue ? (
                    <button type="button" onClick={() => toggleSort(col.key)} className="inline-flex items-center gap-1 hover:text-gray-900">
                      {col.header}
                      {sort?.key === col.key && <span aria-hidden="true">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              ))}
              {rowHref && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={rowKey(row)} className="border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                {columns.map((col) => (
                  <td key={col.key} className={`px-3 py-2 text-gray-900 ${col.className ?? ''}`}>
                    {col.render(row)}
                  </td>
                ))}
                {rowHref && (
                  <td className="px-3 py-2 text-right">
                    <Link href={rowHref(row)} className="text-xs text-gray-500 hover:text-gray-900">
                      View →
                    </Link>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && (
        <div className="flex items-center justify-between border-t border-gray-200 px-3 py-2 text-xs text-gray-500">
          <span>{`Page ${currentPage + 1} of ${pageCount}`}</span>
          <div className="flex gap-1">
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
              className="rounded border border-gray-200 px-2 py-1 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage(currentPage + 1)}
              className="rounded border border-gray-200 px-2 py-1 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/admin/ui/__tests__/DataTable.test.tsx`
Expected: PASS (5 tests).

- [x] **Step 5: Commit**

```bash
git add src/components/admin/ui/DataTable.tsx src/components/admin/ui/__tests__/DataTable.test.tsx
git commit -m "feat(admin): DataTable primitive — sortable, paginated, row-link affordance"
```

---

### Task 5: FilterBar

**Files:**
- Create: `src/components/admin/ui/FilterBar.tsx`
- Test: `src/components/admin/ui/__tests__/FilterBar.test.tsx`

- [x] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FilterBar } from '../FilterBar';

describe('FilterBar', () => {
  it('wires the search input and shows the row count', async () => {
    const onSearchChange = vi.fn();
    render(<FilterBar search="" onSearchChange={onSearchChange} rowCount={41} />);
    await userEvent.type(screen.getByPlaceholderText('Filter…'), 'a');
    expect(onSearchChange).toHaveBeenCalledWith('a');
    expect(screen.getByText('41 rows')).toBeInTheDocument();
  });

  it('renders removable chips', async () => {
    const onRemove = vi.fn();
    render(
      <FilterBar
        search=""
        onSearchChange={() => {}}
        rowCount={1}
        chips={[{ id: 'days', label: '30 days', onRemove }]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove filter 30 days' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/admin/ui/__tests__/FilterBar.test.tsx`
Expected: FAIL — module not found.

- [x] **Step 3: Write the implementation**

```tsx
'use client';

export interface FilterChip {
  id: string;
  label: string;
  onRemove: () => void;
}

interface FilterBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  rowCount: number;
  chips?: FilterChip[];
  searchPlaceholder?: string;
}

export function FilterBar({ search, onSearchChange, rowCount, chips = [], searchPlaceholder = 'Filter…' }: FilterBarProps) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <input
        type="search"
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        placeholder={searchPlaceholder}
        className="rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-400 focus:outline-none"
      />
      {chips.map((chip) => (
        <span key={chip.id} className="inline-flex items-center gap-1 rounded-full bg-gray-200 px-2.5 py-1 text-xs font-medium text-gray-900">
          {chip.label}
          <button type="button" onClick={chip.onRemove} aria-label={`Remove filter ${chip.label}`} className="hover:text-gray-600">
            <svg viewBox="0 0 20 20" fill="currentColor" className="size-3" aria-hidden="true">
              <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
            </svg>
          </button>
        </span>
      ))}
      <span className="ml-auto text-xs text-gray-500">{`${rowCount} rows`}</span>
    </div>
  );
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/admin/ui/__tests__/FilterBar.test.tsx`
Expected: PASS (2 tests).

- [x] **Step 5: Commit**

```bash
git add src/components/admin/ui/FilterBar.tsx src/components/admin/ui/__tests__/FilterBar.test.tsx
git commit -m "feat(admin): FilterBar primitive"
```

---

### Task 6: nav-counts service + API route

**Files:**
- Create: `src/lib/admin/nav-counts-service.ts`
- Create: `src/app/api/admin/nav-counts/route.ts`
- Test: `src/lib/admin/__tests__/nav-counts-service.test.ts`
- Test: `src/app/api/admin/nav-counts/__tests__/route.test.ts`

Auth: `requireRoleOr401(request, 'admin')` — same gate as `/api/admin/overview`. (The flagged route's AAL2 step-up is for reading flagged *content*; two aggregate counts expose no tenant content, so the plain admin gate is correct.)

- [x] **Step 1: Write the failing service test**

```ts
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';

const { mockSql, sqlReturnQueue, sqlCalls, resetMockSql } = await vi.hoisted(async () => {
  const { createMockSql } = await import('../../../../worker/__tests__/helpers/mock-sql');
  return { ...createMockSql() };
});

import { getAdminNavCounts } from '../nav-counts-service';

describe('getAdminNavCounts', () => {
  it('returns both counts from the two COUNT queries', async () => {
    resetMockSql();
    sqlReturnQueue.push([{ total: 3 }]);
    sqlReturnQueue.push([{ total: 1 }]);

    const counts = await getAdminNavCounts(mockSql as unknown as Sql);

    expect(counts).toEqual({ flaggedOpen: 3, failedJobs: 1 });
    expect(sqlCalls[0].text).toContain('flagged_responses');
    expect(sqlCalls[0].text).toContain("status = 'open'");
    expect(sqlCalls[1].text).toContain('job_outbox');
    expect(sqlCalls[1].text).toContain("status = 'failed'");
  });

  it('returns zeros for empty results', async () => {
    resetMockSql();
    sqlReturnQueue.push([]);
    sqlReturnQueue.push([]);

    const counts = await getAdminNavCounts(mockSql as unknown as Sql);

    expect(counts).toEqual({ flaggedOpen: 0, failedJobs: 0 });
  });
});
```

(If the mock-sql harness API differs from this sketch — e.g. queue helper names — mirror the exact usage in `src/app/api/admin/autonomy/__tests__/routes.test.ts`, which consumes the same helper.)

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/admin/__tests__/nav-counts-service.test.ts`
Expected: FAIL — `../nav-counts-service` not found.

- [x] **Step 3: Write the service**

```ts
import type { Sql } from 'postgres';

export interface AdminNavCounts {
  /** flagged_responses awaiting admin disposition (status = 'open'). */
  flaggedOpen: number;
  /** job_outbox rows in terminal failure (status = 'failed'). */
  failedJobs: number;
}

interface CountRow {
  total: number;
}

/**
 * Sidebar badge counts (spec §2). Two intentionally cross-tenant aggregate
 * COUNTs — admin-only, behind requireRoleOr401(admin) at the route.
 */
export async function getAdminNavCounts(sql: Sql): Promise<AdminNavCounts> {
  const [flaggedRows, failedRows] = await Promise.all([
    sql<CountRow[]>`SELECT COUNT(*)::int AS total FROM flagged_responses WHERE status = 'open'`,
    sql<CountRow[]>`SELECT COUNT(*)::int AS total FROM job_outbox WHERE status = 'failed'`,
  ]);
  return {
    flaggedOpen: flaggedRows[0]?.total ?? 0,
    failedJobs: failedRows[0]?.total ?? 0,
  };
}
```

- [x] **Step 4: Run service test to verify it passes**

Run: `pnpm vitest run src/lib/admin/__tests__/nav-counts-service.test.ts`
Expected: PASS (2 tests).

- [x] **Step 5: Write the failing route test**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockRequireRoleOr401, mockGetAdminNavCounts } = vi.hoisted(() => ({
  mockRequireRoleOr401: vi.fn(),
  mockGetAdminNavCounts: vi.fn(),
}));

vi.mock('@/lib/db/server', () => ({ sql: vi.fn() }));
vi.mock('@/lib/auth/route-helpers', () => ({ requireRoleOr401: mockRequireRoleOr401 }));
vi.mock('@/lib/admin/nav-counts-service', () => ({ getAdminNavCounts: mockGetAdminNavCounts }));

import { GET } from '../route';

function request(): NextRequest {
  return new NextRequest('http://localhost/api/admin/nav-counts');
}

describe('GET /api/admin/nav-counts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when the admin gate rejects', async () => {
    mockRequireRoleOr401.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: 'unauthorized' }, { status: 401 }),
    });

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mockGetAdminNavCounts).not.toHaveBeenCalled();
  });

  it('returns the counts with no-store caching', async () => {
    mockRequireRoleOr401.mockResolvedValue({ ok: true, user: { id: 'admin-1' } });
    mockGetAdminNavCounts.mockResolvedValue({ flaggedOpen: 3, failedJobs: 1 });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ flaggedOpen: 3, failedJobs: 1 });
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
  });

  it('returns 500 when the service throws', async () => {
    mockRequireRoleOr401.mockResolvedValue({ ok: true, user: { id: 'admin-1' } });
    mockGetAdminNavCounts.mockRejectedValue(new Error('db down'));

    const response = await GET(request());

    expect(response.status).toBe(500);
  });
});
```

(Match the exact `requireRoleOr401` mock return shape used by `src/app/api/admin/businesses/__tests__` if it differs — mirror an existing passing route test rather than inventing a shape.)

- [x] **Step 6: Run route test to verify it fails**

Run: `pnpm vitest run src/app/api/admin/nav-counts/__tests__/route.test.ts`
Expected: FAIL — `../route` not found.

- [x] **Step 7: Write the route**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRoleOr401 } from '@/lib/auth/route-helpers';
import { reportCaughtError } from '@/lib/shared/report-caught-error';
import { getAdminNavCounts } from '@/lib/admin/nav-counts-service';

export const dynamic = 'force-dynamic';

// Thin orchestrator (auth → call service → return; invariant #12). Polled every
// 60s by the admin sidebar for badge counts.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireRoleOr401(request, 'admin');
  if (!auth.ok) return auth.response;

  try {
    const data = await getAdminNavCounts(sql);
    return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store, private' } });
  } catch (error) {
    reportCaughtError('api/admin/nav-counts', error);
    return NextResponse.json({ error: 'Failed to fetch nav counts' }, { status: 500 });
  }
}
```

- [x] **Step 8: Run route test to verify it passes**

Run: `pnpm vitest run src/app/api/admin/nav-counts/__tests__/route.test.ts`
Expected: PASS (3 tests).

- [x] **Step 9: Run the tenant-scope audit; allowlist only what it flags**

Run: `pnpm ci:tenant-scope`

If the two new COUNT queries are flagged, add entries to `scripts/ci/tenant-scope-allowlist.ts` in the shape the file already uses:

```ts
{
  file: 'src/lib/admin/nav-counts-service.ts',
  table: 'flagged_responses',
  sqlSnippet: "SELECT COUNT(*)::int AS total FROM flagged_responses WHERE status = 'open'",
  category: 'admin-after-require-role',
  reason: 'Admin sidebar badge count; aggregate only, behind requireRoleOr401(admin).',
},
```

(and the analogous `job_outbox` entry if flagged), then bump `ALLOWLIST_BASELINE` by exactly the number of entries added. Re-run `pnpm ci:tenant-scope` until green. Also run `pnpm ci:rls-audit` (expected: green, no schema change).

- [x] **Step 10: Commit**

```bash
git add src/lib/admin/nav-counts-service.ts src/lib/admin/__tests__/nav-counts-service.test.ts src/app/api/admin/nav-counts scripts/ci/tenant-scope-allowlist.ts
git commit -m "feat(admin): nav-counts endpoint for sidebar badges"
```

---

### Task 7: Nav config + AdminSidebar

**Files:**
- Create: `src/components/admin/nav-config.ts`
- Create: `src/components/admin/AdminSidebar.tsx`
- Test: `src/components/admin/__tests__/AdminSidebar.test.tsx`

- [x] **Step 1: Write `nav-config.ts`** (pure data, no test of its own — the sidebar test asserts it)

```ts
export interface AdminNavItem {
  href: string;
  label: string;
  /** Which nav-counts field renders as a badge on this item. */
  badge?: 'flaggedOpen' | 'failedJobs';
}

export interface AdminNavGroup {
  label: string;
  items: AdminNavItem[];
}

/** Grouped admin IA (spec §2). Every admin page must appear exactly once. */
export const ADMIN_NAV_GROUPS: AdminNavGroup[] = [
  {
    label: 'Operate',
    items: [
      { href: '/admin/overview', label: 'Overview' },
      { href: '/admin/jobs', label: 'Jobs', badge: 'failedJobs' },
      { href: '/admin/costs', label: 'Costs' },
      { href: '/admin/notifications', label: 'Notifications' },
      { href: '/admin/runbook', label: 'Runbook' },
    ],
  },
  {
    label: 'Businesses',
    items: [
      { href: '/admin/businesses', label: 'All businesses' },
      { href: '/admin/locations/csv-import', label: 'Locations import' },
      { href: '/admin/offboardings', label: 'Offboardings' },
    ],
  },
  {
    label: 'Safety',
    items: [
      { href: '/admin/flagged', label: 'Flagged', badge: 'flaggedOpen' },
      { href: '/admin/autonomy', label: 'Autonomy' },
      { href: '/admin/security', label: 'Security' },
    ],
  },
  {
    label: 'Growth',
    items: [
      { href: '/admin/demos', label: 'Demos' },
      { href: '/admin/impersonate', label: 'Support' },
    ],
  },
];

/** Auth pages render outside the shell — the sidebar hides itself here. */
export const ADMIN_AUTH_ROUTES = ['/admin/login', '/admin/forgot-password', '/admin/reset-password'];
```

- [x] **Step 2: Write the failing sidebar test**

```tsx
// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminSidebar } from '../AdminSidebar';
import { ADMIN_NAV_GROUPS } from '../nav-config';

const { mockUsePathname } = vi.hoisted(() => ({ mockUsePathname: vi.fn() }));
vi.mock('next/navigation', () => ({ usePathname: mockUsePathname }));

function renderSidebar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminSidebar />
    </QueryClientProvider>,
  );
}

describe('AdminSidebar', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockUsePathname.mockReturnValue('/admin/overview');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ flaggedOpen: 3, failedJobs: 1 }), { status: 200 }),
    ));
  });

  it('renders every nav item from every group', () => {
    renderSidebar();
    for (const group of ADMIN_NAV_GROUPS) {
      expect(screen.getByText(group.label)).toBeInTheDocument();
      for (const item of group.items) {
        expect(screen.getByRole('link', { name: new RegExp(item.label) })).toHaveAttribute('href', item.href);
      }
    }
  });

  it('marks the current page active, including sub-routes', () => {
    mockUsePathname.mockReturnValue('/admin/businesses/abc-123');
    renderSidebar();
    expect(screen.getByRole('link', { name: /All businesses/ })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: /Overview/ })).not.toHaveAttribute('aria-current');
  });

  it('shows badge counts from nav-counts', async () => {
    renderSidebar();
    await waitFor(() => {
      expect(screen.getByText('3')).toBeInTheDocument(); // flagged
      expect(screen.getByText('1')).toBeInTheDocument(); // failed jobs
    });
  });

  it('renders nothing on auth pages', () => {
    mockUsePathname.mockReturnValue('/admin/login');
    const { container } = renderSidebar();
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [x] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/components/admin/__tests__/AdminSidebar.test.tsx`
Expected: FAIL — `../AdminSidebar` not found.

- [x] **Step 4: Write `AdminSidebar.tsx`**

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ADMIN_AUTH_ROUTES, ADMIN_NAV_GROUPS, type AdminNavItem } from './nav-config';

interface NavCounts {
  flaggedOpen: number;
  failedJobs: number;
}

async function fetchNavCounts(): Promise<NavCounts> {
  const response = await fetch('/api/admin/nav-counts');
  if (!response.ok) throw new Error(`nav-counts failed (${response.status})`);
  return response.json();
}

function isActive(pathname: string | null, href: string): boolean {
  return pathname === href || Boolean(pathname?.startsWith(`${href}/`));
}

function NavLink({ item, pathname, counts, onNavigate }: {
  item: AdminNavItem;
  pathname: string | null;
  counts: NavCounts | undefined;
  onNavigate?: () => void;
}) {
  const active = isActive(pathname, item.href);
  const count = item.badge && counts ? counts[item.badge] : 0;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center justify-between rounded-md px-2.5 py-1.5 text-sm transition-colors ${
        active ? 'bg-gray-700 font-medium text-white' : 'text-gray-400 hover:bg-gray-800 hover:text-white'
      }`}
    >
      {item.label}
      {count > 0 && (
        <span className="rounded-full bg-red-400 px-1.5 text-xs font-semibold text-gray-900">{count}</span>
      )}
    </Link>
  );
}

function NavGroups({ pathname, counts, onNavigate }: {
  pathname: string | null;
  counts: NavCounts | undefined;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex-1 space-y-4 overflow-y-auto px-2 pb-4">
      {ADMIN_NAV_GROUPS.map((group) => (
        <div key={group.label}>
          <div className="px-2.5 pb-1 text-[10px] font-medium uppercase tracking-widest text-gray-500">
            {group.label}
          </div>
          <div className="space-y-0.5">
            {group.items.map((item) => (
              <NavLink key={item.href} item={item} pathname={pathname} counts={counts} onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

export function AdminSidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  const { data: counts } = useQuery({
    queryKey: ['admin', 'nav-counts'],
    queryFn: fetchNavCounts,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  if (pathname !== null && ADMIN_AUTH_ROUTES.includes(pathname)) {
    return null;
  }

  const brand = (
    <Link href="/admin/overview" className="block px-4 py-4 text-base font-bold text-white">
      RepWorth <span className="align-top text-[10px] font-semibold text-red-400">ADMIN</span>
    </Link>
  );

  return (
    <>
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col bg-gray-900 md:flex">
        {brand}
        <NavGroups pathname={pathname} counts={counts} />
      </aside>

      {/* Mobile top bar + drawer */}
      <div className="fixed inset-x-0 top-0 z-40 flex h-12 items-center justify-between bg-gray-900 px-3 md:hidden">
        <Link href="/admin/overview" className="text-sm font-bold text-white">
          RepWorth <span className="align-top text-[10px] font-semibold text-red-400">ADMIN</span>
        </Link>
        <button
          type="button"
          onClick={() => setMobileOpen((open) => !open)}
          aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'}
          className="rounded-md p-2 text-gray-300 hover:bg-gray-800"
        >
          <svg className="size-5" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" aria-hidden="true">
            {mobileOpen ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
            )}
          </svg>
        </button>
      </div>
      {mobileOpen && (
        <div className="fixed inset-0 top-12 z-40 flex flex-col bg-gray-900 pt-2 md:hidden">
          <NavGroups pathname={pathname} counts={counts} onNavigate={() => setMobileOpen(false)} />
        </div>
      )}
      {/* Spacer so page content clears the fixed mobile top bar */}
      <div className="h-12 md:hidden" />
    </>
  );
}
```

- [x] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/components/admin/__tests__/AdminSidebar.test.tsx`
Expected: PASS (4 tests). If the "renders every nav item" test finds duplicate matches (desktop + mobile trees both mounted), scope queries with `within(screen.getByRole('complementary'))` — the `<aside>` — instead of the whole screen.

- [x] **Step 6: Commit**

```bash
git add src/components/admin/nav-config.ts src/components/admin/AdminSidebar.tsx src/components/admin/__tests__/AdminSidebar.test.tsx
git commit -m "feat(admin): grouped AdminSidebar with live badge counts"
```

---

### Task 8: Layout swap + retire AdminNav

**Files:**
- Modify: `src/app/admin/layout.tsx`
- Delete: `src/components/admin/AdminNav.tsx`

- [x] **Step 1: Check for other AdminNav references**

Run: `rg -l "AdminNav" src/`
Expected: only `src/app/admin/layout.tsx` and `src/components/admin/AdminNav.tsx`. If anything else appears (a test, a story), update or delete it in this task and mention it in the commit.

- [x] **Step 2: Rewrite `src/app/admin/layout.tsx`**

```tsx
import { AdminProviders } from './providers';
import { AdminSidebar } from '@/components/admin/AdminSidebar';

// Auth: Supabase session checked by src/proxy.ts (admin role required)

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AdminProviders>
      <div className="flex min-h-screen bg-gray-50">
        <AdminSidebar />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </AdminProviders>
  );
}
```

(On auth routes the sidebar renders `null`, so login/reset pages get a full-width `<main>` — same behavior as today's nav-hides-on-login.)

- [x] **Step 3: Delete the old nav**

```bash
git rm src/components/admin/AdminNav.tsx
```

- [x] **Step 4: Verify the app compiles and admin renders**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

Run: `pnpm dev` and load `http://localhost:3000/admin/overview` (admin session required), spot-check: sidebar present with four groups, active state follows navigation, every link resolves (no 404), `/admin/login` has no sidebar, mobile viewport shows the top bar + drawer. Then stop the dev server.

- [x] **Step 5: Run the full test suite**

Run: `pnpm test`
Expected: green. Pages were not modified, but their tests exercise the layout indirectly — any failure here is a regression in this task, not "unrelated".

- [x] **Step 6: Commit**

```bash
git add src/app/admin/layout.tsx
git commit -m "feat(admin): swap top nav for grouped sidebar shell, retire AdminNav"
```

---

### Task 9: Full gates + PR

- [x] **Step 1: Run the full local gate**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: all green.

- [x] **Step 2: Run the DB-adjacent audits** (new SQL sites in this branch)

Run: `pnpm ci:tenant-scope && pnpm ci:rls-audit`
Expected: green (Task 6 already reconciled the allowlist).

- [x] **Step 3: Push and open the PR**

```bash
git push -u origin admin-console-redesign
gh pr create --title "feat(admin): console shell — grouped sidebar, badge counts, UI primitives (Phase 1)" --body "$(cat <<'EOF'
Phase 1 of the admin console redesign (spec: docs/superpowers/specs/2026-07-30-admin-console-redesign-design.md).

- Grouped dark sidebar (Operate · Businesses · Safety · Growth) replaces the flat top nav; Flagged and Autonomy are finally reachable from the nav
- Live badge counts (flagged open, failed jobs) via new GET /api/admin/nav-counts, polled every 60s
- Seven shared UI primitives in src/components/admin/ui/ (AdminPage, StatTile, DataTable, FilterBar, StatusBadge, Empty/Error states, TableSkeleton) — pages migrate onto them in Phases 2–3
- Page internals untouched in this phase

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01DN2QcHgMCGcHXrKU66gxK3
EOF
)"
```

- [ ] **Step 4: Verify the Vercel preview**

On the PR's preview deployment, spot-check `/admin/overview` (sidebar, groups, badges) and `/admin/login` (no sidebar). CI must be green before merge.

---

## Phase 2/3 pointer (not in this plan)

After this PR merges: Phase 2 migrates Operate + Safety pages to server-first fetching + these primitives; Phase 3 migrates Businesses + Growth and sweeps orphaned styles. Each gets its own plan (same spec, §4 + §8), written against the then-current code.
