# Prompt 14b: Admin Read-Only Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build 4 admin read-only pages (overview, costs, notifications, jobs) with corresponding API routes, replacing the existing placeholders.

**Architecture:** Each page is a `'use client'` component that fetches data via TanStack Query from a corresponding `/api/admin/*` route. API routes use `requireRole()` for defense-in-depth auth, `sql` (Postgres.js) for DB queries, and return JSON. The admin layout already wraps children in `QueryClientProvider` via `AdminProviders`. All pages use Tailwind CSS, client-side pagination (offset + limit query params), and the existing pattern from `src/app/admin/demos/page.tsx`.

**Tech Stack:** TanStack Query (already installed), Tailwind CSS, Postgres.js `sql`, `@/lib/db/auth` (`requireRole`), BullMQ `Queue.getJobCounts()` (jobs page only)

---

## Conventions (apply to all tasks)

Every API route follows this exact pattern from the existing `src/app/api/admin/demos/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // ... queries ...
    return NextResponse.json(data);
  } catch (error) {
    console.error('[api/admin/X] Failed:', error);
    return NextResponse.json({ error: 'Failed to fetch data' }, { status: 500 });
  }
}
```

Every page follows the demos page pattern:
- `'use client'` directive
- `useQuery` from `@tanstack/react-query` with a `queryKey` and `queryFn` that calls `fetch()`
- Tailwind styling, `min-h-screen bg-gray-50` container
- Auth comment: `// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/app/api/admin/overview/route.ts` | **CREATE** | System health + business list aggregation |
| `src/app/admin/overview/page.tsx` | **REWRITE** | Sales partner CRM dashboard |
| `src/app/api/admin/costs/route.ts` | **CREATE** | Cost breakdown by provider/business/day |
| `src/app/admin/costs/page.tsx` | **REWRITE** | Cost monitoring page |
| `src/app/api/admin/notifications/route.ts` | **CREATE** | Notification delivery log with filters |
| `src/app/admin/notifications/page.tsx` | **REWRITE** | Notification delivery log page |
| `src/app/api/admin/jobs/route.ts` | **CREATE** | Outbox counts + BullMQ queue health |
| `src/app/admin/jobs/page.tsx` | **REWRITE** | Job monitoring page |

---

## Task 1: Overview API route

**Files:**
- Create: `src/app/api/admin/overview/route.ts`

- [ ] **Step 1: Create the overview API route**

Create `src/app/api/admin/overview/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // System health metrics — parallel queries
    const [pendingOutbox, failedJobs, todayCost, notifFailures] =
      await Promise.all([
        sql`SELECT COUNT(*)::int AS count FROM job_outbox WHERE status = 'pending'`,
        sql`SELECT COUNT(*)::int AS count FROM job_outbox WHERE status = 'failed'`,
        sql`SELECT COALESCE(SUM(cost_usd), 0)::float AS total FROM api_costs WHERE created_at >= CURRENT_DATE`,
        sql`SELECT COUNT(*)::int AS count FROM notification_deliveries WHERE failed_at IS NOT NULL AND failed_at >= NOW() - INTERVAL '24 hours'`,
      ]);

    const systemHealth = {
      pendingOutbox: pendingOutbox[0]?.count ?? 0,
      failedJobs: failedJobs[0]?.count ?? 0,
      todayCostUsd: todayCost[0]?.total ?? 0,
      notificationFailures24h: notifFailures[0]?.count ?? 0,
    };

    // Business list with response stats
    const businesses = await sql`
      SELECT
        b.id,
        b.name,
        b.subscription_status,
        b.last_sync_at,
        COUNT(CASE WHEN resp.status = 'pending_approval' THEN 1 END)::int AS pending_approval_count,
        COUNT(resp.id)::int AS total_responses,
        COUNT(CASE WHEN resp.status IN ('posted', 'awaiting_manual_post', 'approved', 'edited') THEN 1 END)::int AS completed_responses,
        ROUND(
          EXTRACT(EPOCH FROM AVG(
            CASE WHEN resp.approved_at IS NOT NULL THEN resp.approved_at - resp.created_at END
          )) / 3600.0, 1
        )::float AS avg_response_time_hours,
        MAX(GREATEST(resp.created_at, resp.approved_at, resp.posted_at)) AS last_activity
      FROM businesses b
      LEFT JOIN responses resp ON resp.business_id = b.id AND resp.status != 'superseded'
      GROUP BY b.id, b.name, b.subscription_status, b.last_sync_at
      ORDER BY COUNT(CASE WHEN resp.status = 'pending_approval' THEN 1 END) DESC, b.name ASC
    `;

    const businessList = businesses.map((b) => ({
      id: b.id as string,
      name: b.name as string,
      subscriptionStatus: b.subscription_status as string,
      lastSyncAt: b.last_sync_at ? (b.last_sync_at as Date).toISOString() : null,
      pendingApprovalCount: (b.pending_approval_count as number) ?? 0,
      totalResponses: (b.total_responses as number) ?? 0,
      completedResponses: (b.completed_responses as number) ?? 0,
      responseRate:
        (b.total_responses as number) > 0
          ? Math.round(((b.completed_responses as number) / (b.total_responses as number)) * 100)
          : 0,
      avgResponseTimeHours: (b.avg_response_time_hours as number) ?? null,
      lastActivity: b.last_activity ? (b.last_activity as Date).toISOString() : null,
    }));

    return NextResponse.json({ systemHealth, businesses: businessList });
  } catch (error) {
    console.error('[api/admin/overview] Failed:', error);
    return NextResponse.json({ error: 'Failed to fetch overview' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/admin/overview/route.ts
git commit -m "feat: add admin overview API route (system health + business stats)"
```

---

## Task 2: Overview page

**Files:**
- Rewrite: `src/app/admin/overview/page.tsx`

- [ ] **Step 1: Rewrite the overview page**

Replace `src/app/admin/overview/page.tsx`:

```tsx
'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';

// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)

interface SystemHealth {
  pendingOutbox: number;
  failedJobs: number;
  todayCostUsd: number;
  notificationFailures24h: number;
}

interface BusinessRow {
  id: string;
  name: string;
  subscriptionStatus: string;
  lastSyncAt: string | null;
  pendingApprovalCount: number;
  totalResponses: number;
  completedResponses: number;
  responseRate: number;
  avgResponseTimeHours: number | null;
  lastActivity: string | null;
}

interface OverviewData {
  systemHealth: SystemHealth;
  businesses: BusinessRow[];
}

export default function AdminOverviewPage() {
  const { data, isLoading, error } = useQuery<OverviewData>({
    queryKey: ['admin-overview'],
    queryFn: async () => {
      const res = await fetch('/api/admin/overview');
      if (!res.ok) throw new Error('Failed to fetch overview');
      return res.json();
    },
    refetchInterval: 30_000,
  });

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Overview</h1>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 text-sm text-red-700">
            Failed to load overview data
          </div>
        )}

        {/* System Health Bar */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          <HealthCard
            label="Pending Outbox"
            value={data?.systemHealth.pendingOutbox}
            loading={isLoading}
            warn={v => v > 10}
          />
          <HealthCard
            label="Failed Jobs"
            value={data?.systemHealth.failedJobs}
            loading={isLoading}
            warn={v => v > 0}
          />
          <HealthCard
            label="Today's Cost"
            value={data?.systemHealth.todayCostUsd}
            loading={isLoading}
            format={v => `$${v.toFixed(2)}`}
          />
          <HealthCard
            label="Notif Failures (24h)"
            value={data?.systemHealth.notificationFailures24h}
            loading={isLoading}
            warn={v => v > 0}
          />
        </div>

        {/* Business Table */}
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Business</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Pending</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Response Rate</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Avg Time (h)</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Last Activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                    Loading...
                  </td>
                </tr>
              )}
              {data?.businesses.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                    No businesses yet
                  </td>
                </tr>
              )}
              {data?.businesses.map((b) => (
                <tr key={b.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <Link href={`/admin/businesses/${b.id}`} className="text-blue-600 hover:underline font-medium">
                      {b.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={b.subscriptionStatus} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    {b.pendingApprovalCount > 0 ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                        {b.pendingApprovalCount}
                      </span>
                    ) : (
                      <span className="text-gray-400">0</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">{b.responseRate}%</td>
                  <td className="px-4 py-3 text-right text-gray-500">
                    {b.avgResponseTimeHours != null ? b.avgResponseTimeHours.toFixed(1) : '—'}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-500 text-xs">
                    {b.lastActivity ? formatRelative(b.lastActivity) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function HealthCard({
  label,
  value,
  loading,
  warn,
  format,
}: {
  label: string;
  value: number | undefined;
  loading: boolean;
  warn?: (v: number) => boolean;
  format?: (v: number) => string;
}) {
  const isWarning = value != null && warn?.(value);
  return (
    <div
      className={`rounded-lg border p-4 ${
        isWarning ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200'
      }`}
    >
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${isWarning ? 'text-red-700' : 'text-gray-900'}`}>
        {loading ? '...' : value != null ? (format ? format(value) : value) : '—'}
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-100 text-green-800',
    pending_payment: 'bg-gray-100 text-gray-600',
    past_due: 'bg-yellow-100 text-yellow-800',
    cancelled: 'bg-red-100 text-red-700',
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
        colors[status] ?? 'bg-gray-100 text-gray-600'
      }`}
    >
      {status.replace('_', ' ')}
    </span>
  );
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/app/admin/overview/page.tsx
git commit -m "feat: build admin overview page (system health + business table, 30s polling)"
```

---

## Task 3: Costs API route

**Files:**
- Create: `src/app/api/admin/costs/route.ts`

- [ ] **Step 1: Create the costs API route**

Create `src/app/api/admin/costs/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const days = Math.min(parseInt(searchParams.get('days') ?? '7', 10) || 7, 90);

    // Cost by provider
    const byProvider = await sql`
      SELECT
        provider,
        SUM(cost_usd)::float AS total_usd,
        COUNT(*)::int AS call_count
      FROM api_costs
      WHERE created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
      GROUP BY provider
      ORDER BY total_usd DESC
    `;

    // Cost by business (with name)
    const byBusiness = await sql`
      SELECT
        b.id AS business_id,
        b.name AS business_name,
        b.subscription_tier,
        SUM(ac.cost_usd)::float AS total_usd,
        COUNT(ac.id)::int AS call_count,
        SUM(CASE WHEN ac.created_at >= CURRENT_DATE THEN ac.cost_usd ELSE 0 END)::float AS today_usd
      FROM api_costs ac
      JOIN businesses b ON ac.business_id = b.id
      WHERE ac.created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
      GROUP BY b.id, b.name, b.subscription_tier
      ORDER BY total_usd DESC
    `;

    // Cost by day
    const byDay = await sql`
      SELECT
        DATE(created_at) AS day,
        SUM(cost_usd)::float AS total_usd,
        COUNT(*)::int AS call_count
      FROM api_costs
      WHERE created_at >= CURRENT_DATE - ${days}::int * INTERVAL '1 day'
      GROUP BY DATE(created_at)
      ORDER BY day DESC
    `;

    // Today's platform total vs global limit
    const todayTotal = await sql`
      SELECT COALESCE(SUM(cost_usd), 0)::float AS total FROM api_costs WHERE created_at >= CURRENT_DATE
    `;

    const globalDailyLimitCents = parseInt(
      process.env.GLOBAL_DAILY_COST_LIMIT_CENTS ?? '10000',
      10,
    );

    // Tier daily limits for highlighting
    const tierLimits: Record<string, number> = {
      founding: parseInt(process.env.DAILY_COST_LIMIT_CENTS_FOUNDING ?? '500', 10),
      standard: parseInt(process.env.DAILY_COST_LIMIT_CENTS_STANDARD ?? '1000', 10),
      premium: parseInt(process.env.DAILY_COST_LIMIT_CENTS_PREMIUM ?? '2000', 10),
    };

    return NextResponse.json({
      days,
      byProvider: byProvider.map((r) => ({
        provider: r.provider as string,
        totalUsd: r.total_usd as number,
        callCount: r.call_count as number,
      })),
      byBusiness: byBusiness.map((r) => {
        const tier = r.subscription_tier as string;
        const todayUsd = r.today_usd as number;
        const dailyLimitCents = tierLimits[tier] ?? tierLimits.standard;
        const dailyLimitUsd = dailyLimitCents / 100;
        return {
          businessId: r.business_id as string,
          businessName: r.business_name as string,
          subscriptionTier: tier,
          totalUsd: r.total_usd as number,
          callCount: r.call_count as number,
          todayUsd,
          dailyLimitUsd,
          pctOfDailyLimit: dailyLimitUsd > 0 ? Math.round((todayUsd / dailyLimitUsd) * 100) : 0,
        };
      }),
      byDay: byDay.map((r) => ({
        day: (r.day as Date).toISOString().slice(0, 10),
        totalUsd: r.total_usd as number,
        callCount: r.call_count as number,
      })),
      todayTotalUsd: todayTotal[0]?.total ?? 0,
      globalDailyLimitUsd: globalDailyLimitCents / 100,
    });
  } catch (error) {
    console.error('[api/admin/costs] Failed:', error);
    return NextResponse.json({ error: 'Failed to fetch costs' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/admin/costs/route.ts
git commit -m "feat: add admin costs API route (by provider, business, day + daily limits)"
```

---

## Task 4: Costs page

**Files:**
- Rewrite: `src/app/admin/costs/page.tsx`

- [ ] **Step 1: Rewrite the costs page**

Replace `src/app/admin/costs/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)

interface CostData {
  days: number;
  byProvider: { provider: string; totalUsd: number; callCount: number }[];
  byBusiness: {
    businessId: string;
    businessName: string;
    subscriptionTier: string;
    totalUsd: number;
    callCount: number;
    todayUsd: number;
    dailyLimitUsd: number;
    pctOfDailyLimit: number;
  }[];
  byDay: { day: string; totalUsd: number; callCount: number }[];
  todayTotalUsd: number;
  globalDailyLimitUsd: number;
}

export default function CostsPage() {
  const [days, setDays] = useState(7);

  const { data, isLoading, error } = useQuery<CostData>({
    queryKey: ['admin-costs', days],
    queryFn: async () => {
      const res = await fetch(`/api/admin/costs?days=${days}`);
      if (!res.ok) throw new Error('Failed to fetch costs');
      return res.json();
    },
  });

  const pctGlobal =
    data && data.globalDailyLimitUsd > 0
      ? Math.round((data.todayTotalUsd / data.globalDailyLimitUsd) * 100)
      : 0;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Cost Monitoring</h1>
          <div className="flex gap-2">
            {[7, 30, 90].map((d) => (
              <button
                key={d}
                onClick={() => setDays(d)}
                className={`px-3 py-1 rounded text-sm font-medium ${
                  days === d
                    ? 'bg-blue-600 text-white'
                    : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-50'
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 text-sm text-red-700">
            Failed to load cost data
          </div>
        )}

        {/* Global daily progress */}
        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm font-medium text-gray-600">Today&apos;s Platform Spend</span>
            <span className="text-sm text-gray-500">
              {isLoading ? '...' : `$${data?.todayTotalUsd.toFixed(2)} / $${data?.globalDailyLimitUsd.toFixed(2)}`}
            </span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-3">
            <div
              className={`h-3 rounded-full transition-all ${pctGlobal >= 80 ? 'bg-red-500' : 'bg-blue-500'}`}
              style={{ width: `${Math.min(pctGlobal, 100)}%` }}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          {/* By Provider */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">By Provider (last {days}d)</h2>
            {isLoading ? (
              <p className="text-gray-400 text-sm">Loading...</p>
            ) : data?.byProvider.length === 0 ? (
              <p className="text-gray-400 text-sm">No costs recorded</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="text-left py-2 font-medium text-gray-500">Provider</th>
                    <th className="text-right py-2 font-medium text-gray-500">Cost</th>
                    <th className="text-right py-2 font-medium text-gray-500">Calls</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {data?.byProvider.map((p) => (
                    <tr key={p.provider}>
                      <td className="py-2">{p.provider}</td>
                      <td className="py-2 text-right">${p.totalUsd.toFixed(4)}</td>
                      <td className="py-2 text-right text-gray-500">{p.callCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* By Day */}
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h2 className="text-sm font-semibold text-gray-700 mb-3">By Day</h2>
            {isLoading ? (
              <p className="text-gray-400 text-sm">Loading...</p>
            ) : data?.byDay.length === 0 ? (
              <p className="text-gray-400 text-sm">No costs recorded</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="text-left py-2 font-medium text-gray-500">Date</th>
                    <th className="text-right py-2 font-medium text-gray-500">Cost</th>
                    <th className="text-right py-2 font-medium text-gray-500">Calls</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {data?.byDay.map((d) => (
                    <tr key={d.day}>
                      <td className="py-2">{d.day}</td>
                      <td className="py-2 text-right">${d.totalUsd.toFixed(4)}</td>
                      <td className="py-2 text-right text-gray-500">{d.callCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* By Business */}
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <h2 className="text-sm font-semibold text-gray-700 px-4 pt-4 pb-2">By Business (last {days}d)</h2>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-y border-gray-200">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-500">Business</th>
                <th className="text-left px-4 py-2 font-medium text-gray-500">Tier</th>
                <th className="text-right px-4 py-2 font-medium text-gray-500">Period Total</th>
                <th className="text-right px-4 py-2 font-medium text-gray-500">Today</th>
                <th className="text-right px-4 py-2 font-medium text-gray-500">Daily Limit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-gray-400">Loading...</td>
                </tr>
              )}
              {data?.byBusiness.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-gray-400">No costs recorded</td>
                </tr>
              )}
              {data?.byBusiness.map((b) => (
                <tr
                  key={b.businessId}
                  className={b.pctOfDailyLimit >= 80 ? 'bg-red-50' : ''}
                >
                  <td className="px-4 py-2 font-medium">{b.businessName}</td>
                  <td className="px-4 py-2 text-gray-500">{b.subscriptionTier}</td>
                  <td className="px-4 py-2 text-right">${b.totalUsd.toFixed(4)}</td>
                  <td className="px-4 py-2 text-right">
                    <span className={b.pctOfDailyLimit >= 80 ? 'text-red-700 font-medium' : ''}>
                      ${b.todayUsd.toFixed(4)}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right text-gray-500">
                    ${b.dailyLimitUsd.toFixed(2)} ({b.pctOfDailyLimit}%)
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/app/admin/costs/page.tsx
git commit -m "feat: build admin costs page (provider, business, day breakdown + daily limit progress)"
```

---

## Task 5: Notifications API route

**Files:**
- Create: `src/app/api/admin/notifications/route.ts`

- [ ] **Step 1: Create the notifications API route**

Create `src/app/api/admin/notifications/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10) || 20, 100);
    const offset = parseInt(searchParams.get('offset') ?? '0', 10) || 0;
    const businessId = searchParams.get('business_id') || null;
    const channel = searchParams.get('channel') || null;
    const status = searchParams.get('status') || null;

    // Build WHERE clauses dynamically
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (businessId) {
      conditions.push(`nd.business_id = $${paramIndex++}`);
      params.push(businessId);
    }
    if (channel) {
      conditions.push(`nd.channel = $${paramIndex++}`);
      params.push(channel);
    }
    if (status === 'delivered') {
      conditions.push('nd.delivered_at IS NOT NULL');
    } else if (status === 'failed') {
      conditions.push('nd.failed_at IS NOT NULL');
    } else if (status === 'pending') {
      conditions.push('nd.delivered_at IS NULL AND nd.failed_at IS NULL');
    }

    const whereClause =
      conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    // Postgres.js tagged template doesn't support dynamic WHERE easily.
    // Use unsafe() for the WHERE clause built from validated inputs above.
    const rows = await sql.unsafe(
      `SELECT
        nd.id,
        b.name AS business_name,
        nd.channel,
        nd.recipient,
        nd.template,
        nd.sent_at,
        nd.delivered_at,
        nd.failed_at,
        nd.failure_reason,
        nd.created_at
      FROM notification_deliveries nd
      JOIN businesses b ON nd.business_id = b.id
      ${whereClause}
      ORDER BY nd.created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset],
    );

    // Total count for pagination
    const countResult = await sql.unsafe(
      `SELECT COUNT(*)::int AS total
       FROM notification_deliveries nd
       JOIN businesses b ON nd.business_id = b.id
       ${whereClause}`,
      params,
    );

    // Business list for filter dropdown
    const businessList = await sql`
      SELECT DISTINCT b.id, b.name
      FROM businesses b
      JOIN notification_deliveries nd ON nd.business_id = b.id
      ORDER BY b.name
    `;

    return NextResponse.json({
      notifications: rows.map((r) => ({
        id: r.id as string,
        businessName: r.business_name as string,
        channel: r.channel as string,
        recipient: r.recipient as string,
        template: r.template as string,
        sentAt: r.sent_at ? (r.sent_at as Date).toISOString() : null,
        deliveredAt: r.delivered_at ? (r.delivered_at as Date).toISOString() : null,
        failedAt: r.failed_at ? (r.failed_at as Date).toISOString() : null,
        failureReason: r.failure_reason as string | null,
        createdAt: (r.created_at as Date).toISOString(),
      })),
      total: countResult[0]?.total ?? 0,
      limit,
      offset,
      businesses: businessList.map((b) => ({
        id: b.id as string,
        name: b.name as string,
      })),
    });
  } catch (error) {
    console.error('[api/admin/notifications] Failed:', error);
    return NextResponse.json({ error: 'Failed to fetch notifications' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/admin/notifications/route.ts
git commit -m "feat: add admin notifications API route (delivery log with filters + pagination)"
```

---

## Task 6: Notifications page

**Files:**
- Rewrite: `src/app/admin/notifications/page.tsx`

- [ ] **Step 1: Rewrite the notifications page**

Replace `src/app/admin/notifications/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)

interface NotifRow {
  id: string;
  businessName: string;
  channel: string;
  recipient: string;
  template: string;
  sentAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  failureReason: string | null;
  createdAt: string;
}

interface NotifData {
  notifications: NotifRow[];
  total: number;
  limit: number;
  offset: number;
  businesses: { id: string; name: string }[];
}

const PAGE_SIZE = 20;

export default function NotificationsPage() {
  const [page, setPage] = useState(0);
  const [businessId, setBusinessId] = useState('');
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState('');

  const { data, isLoading, error } = useQuery<NotifData>({
    queryKey: ['admin-notifications', page, businessId, channel, status],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      if (businessId) params.set('business_id', businessId);
      if (channel) params.set('channel', channel);
      if (status) params.set('status', status);
      const res = await fetch(`/api/admin/notifications?${params}`);
      if (!res.ok) throw new Error('Failed to fetch notifications');
      return res.json();
    },
  });

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  function resetFilters() {
    setBusinessId('');
    setChannel('');
    setStatus('');
    setPage(0);
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Notification Deliveries</h1>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 text-sm text-red-700">
            Failed to load notifications
          </div>
        )}

        {/* Filters */}
        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6 flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Business</label>
            <select
              value={businessId}
              onChange={(e) => { setBusinessId(e.target.value); setPage(0); }}
              className="px-2 py-1.5 border border-gray-300 rounded text-sm"
            >
              <option value="">All</option>
              {data?.businesses.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Channel</label>
            <select
              value={channel}
              onChange={(e) => { setChannel(e.target.value); setPage(0); }}
              className="px-2 py-1.5 border border-gray-300 rounded text-sm"
            >
              <option value="">All</option>
              <option value="email">Email</option>
              <option value="sms">SMS</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Status</label>
            <select
              value={status}
              onChange={(e) => { setStatus(e.target.value); setPage(0); }}
              className="px-2 py-1.5 border border-gray-300 rounded text-sm"
            >
              <option value="">All</option>
              <option value="delivered">Delivered</option>
              <option value="failed">Failed</option>
              <option value="pending">Pending</option>
            </select>
          </div>
          <button
            onClick={resetFilters}
            className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900"
          >
            Reset
          </button>
        </div>

        {/* Table */}
        <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Business</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Channel</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Recipient</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Template</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Sent</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-400">Loading...</td>
                </tr>
              )}
              {data?.notifications.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-400">No notifications found</td>
                </tr>
              )}
              {data?.notifications.map((n) => (
                <tr key={n.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2">{n.businessName}</td>
                  <td className="px-4 py-2">{n.channel}</td>
                  <td className="px-4 py-2 text-gray-500 text-xs">{n.recipient}</td>
                  <td className="px-4 py-2 text-gray-500">{n.template}</td>
                  <td className="px-4 py-2 text-gray-500 text-xs">
                    {n.sentAt ? new Date(n.sentAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-2">
                    {n.deliveredAt ? (
                      <span className="text-green-700 text-xs font-medium">Delivered</span>
                    ) : n.failedAt ? (
                      <span className="text-red-700 text-xs font-medium" title={n.failureReason ?? ''}>
                        Failed
                      </span>
                    ) : (
                      <span className="text-yellow-700 text-xs font-medium">Pending</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <p className="text-sm text-gray-500">
              Showing {data ? data.offset + 1 : 0}–{data ? Math.min(data.offset + PAGE_SIZE, data.total) : 0} of {data?.total ?? 0}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-3 py-1 rounded border border-gray-300 text-sm disabled:opacity-40"
              >
                Prev
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= totalPages - 1}
                className="px-3 py-1 rounded border border-gray-300 text-sm disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/app/admin/notifications/page.tsx
git commit -m "feat: build admin notifications page (delivery log with filters + pagination)"
```

---

## Task 7: Jobs API route

**Files:**
- Create: `src/app/api/admin/jobs/route.ts`

- [ ] **Step 1: Create the jobs API route**

Create `src/app/api/admin/jobs/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { Queue } from 'bullmq';
import { getRedisOptions, QUEUE_NAMES } from '../../../../worker/queues';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10) || 20, 100);
    const offset = parseInt(searchParams.get('offset') ?? '0', 10) || 0;

    // Outbox summary counts
    const outboxCounts = await sql`
      SELECT
        COUNT(CASE WHEN status = 'pending' THEN 1 END)::int AS pending,
        COUNT(CASE WHEN status = 'dispatched' THEN 1 END)::int AS dispatched,
        COUNT(CASE WHEN status = 'failed' THEN 1 END)::int AS failed,
        COUNT(CASE WHEN status = 'completed' AND completed_at >= CURRENT_DATE THEN 1 END)::int AS completed_today
      FROM job_outbox
    `;

    // Failed jobs list (paginated)
    const failedJobs = await sql`
      SELECT id, topic, last_error, attempts, max_attempts, created_at
      FROM job_outbox
      WHERE status = 'failed'
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const failedTotal = await sql`
      SELECT COUNT(*)::int AS total FROM job_outbox WHERE status = 'failed'
    `;

    // BullMQ queue health (may fail if Redis is unreachable)
    let queueHealth: Record<string, Record<string, number>> | { unavailable: true };
    try {
      const redisOpts = getRedisOptions();
      const queueNames = Object.values(QUEUE_NAMES);
      const counts: Record<string, Record<string, number>> = {};

      for (const name of queueNames) {
        const queue = new Queue(name, { connection: redisOpts });
        const jobCounts = await queue.getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
        );
        counts[name] = jobCounts;
        await queue.close();
      }

      queueHealth = counts;
    } catch (redisError) {
      console.warn('[api/admin/jobs] Redis unavailable for queue health:', redisError);
      queueHealth = { unavailable: true };
    }

    const summary = outboxCounts[0] ?? { pending: 0, dispatched: 0, failed: 0, completed_today: 0 };

    return NextResponse.json({
      outbox: {
        pending: summary.pending as number,
        dispatched: summary.dispatched as number,
        failed: summary.failed as number,
        completedToday: summary.completed_today as number,
      },
      failedJobs: failedJobs.map((j) => ({
        id: j.id as string,
        topic: j.topic as string,
        lastError: j.last_error as string | null,
        attempts: j.attempts as number,
        maxAttempts: j.max_attempts as number,
        createdAt: (j.created_at as Date).toISOString(),
      })),
      failedTotal: failedTotal[0]?.total ?? 0,
      limit,
      offset,
      queueHealth,
    });
  } catch (error) {
    console.error('[api/admin/jobs] Failed:', error);
    return NextResponse.json({ error: 'Failed to fetch jobs' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/admin/jobs/route.ts
git commit -m "feat: add admin jobs API route (outbox counts + queue health + failed jobs list)"
```

---

## Task 8: Jobs page

**Files:**
- Rewrite: `src/app/admin/jobs/page.tsx`

- [ ] **Step 1: Rewrite the jobs page**

Replace `src/app/admin/jobs/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)

interface FailedJob {
  id: string;
  topic: string;
  lastError: string | null;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
}

interface JobsData {
  outbox: {
    pending: number;
    dispatched: number;
    failed: number;
    completedToday: number;
  };
  failedJobs: FailedJob[];
  failedTotal: number;
  limit: number;
  offset: number;
  queueHealth: Record<string, Record<string, number>> | { unavailable: true };
}

const PAGE_SIZE = 20;

export default function JobsPage() {
  const [page, setPage] = useState(0);

  const { data, isLoading, error } = useQuery<JobsData>({
    queryKey: ['admin-jobs', page],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      const res = await fetch(`/api/admin/jobs?${params}`);
      if (!res.ok) throw new Error('Failed to fetch jobs');
      return res.json();
    },
    refetchInterval: 30_000,
  });

  const totalPages = data ? Math.ceil(data.failedTotal / PAGE_SIZE) : 0;
  const queuesAvailable = data?.queueHealth && !('unavailable' in data.queueHealth);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Jobs & Queue Health</h1>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 text-sm text-red-700">
            Failed to load job data
          </div>
        )}

        {/* Outbox Summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <SummaryCard label="Pending" value={data?.outbox.pending} loading={isLoading} color="yellow" />
          <SummaryCard label="Dispatched" value={data?.outbox.dispatched} loading={isLoading} color="blue" />
          <SummaryCard label="Failed" value={data?.outbox.failed} loading={isLoading} color="red" />
          <SummaryCard label="Completed Today" value={data?.outbox.completedToday} loading={isLoading} color="green" />
        </div>

        {/* Queue Health */}
        <div className="bg-white rounded-lg border border-gray-200 p-4 mb-6">
          <h2 className="text-sm font-semibold text-gray-700 mb-3">BullMQ Queue Depth</h2>
          {isLoading ? (
            <p className="text-gray-400 text-sm">Loading...</p>
          ) : !queuesAvailable ? (
            <p className="text-yellow-600 text-sm">Redis unavailable — queue counts not shown</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {Object.entries(data!.queueHealth as Record<string, Record<string, number>>).map(
                ([queueName, counts]) => (
                  <div key={queueName} className="border border-gray-100 rounded p-3">
                    <p className="text-xs font-medium text-gray-500 mb-2 truncate" title={queueName}>
                      {queueName}
                    </p>
                    <div className="grid grid-cols-4 gap-1 text-center text-xs">
                      <div>
                        <p className="font-bold text-yellow-700">{counts.waiting ?? 0}</p>
                        <p className="text-gray-400">wait</p>
                      </div>
                      <div>
                        <p className="font-bold text-blue-700">{counts.active ?? 0}</p>
                        <p className="text-gray-400">active</p>
                      </div>
                      <div>
                        <p className="font-bold text-gray-500">{counts.delayed ?? 0}</p>
                        <p className="text-gray-400">delay</p>
                      </div>
                      <div>
                        <p className="font-bold text-red-700">{counts.failed ?? 0}</p>
                        <p className="text-gray-400">fail</p>
                      </div>
                    </div>
                  </div>
                ),
              )}
            </div>
          )}
        </div>

        {/* Failed Jobs Table */}
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <h2 className="text-sm font-semibold text-gray-700 px-4 pt-4 pb-2">
            Failed Jobs ({data?.failedTotal ?? 0})
          </h2>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-y border-gray-200">
              <tr>
                <th className="text-left px-4 py-2 font-medium text-gray-500">Topic</th>
                <th className="text-left px-4 py-2 font-medium text-gray-500">Error</th>
                <th className="text-right px-4 py-2 font-medium text-gray-500">Attempts</th>
                <th className="text-right px-4 py-2 font-medium text-gray-500">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-gray-400">Loading...</td>
                </tr>
              )}
              {data?.failedJobs.length === 0 && !isLoading && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-gray-400">No failed jobs</td>
                </tr>
              )}
              {data?.failedJobs.map((j) => (
                <tr key={j.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium">{j.topic}</td>
                  <td className="px-4 py-2 text-gray-500 text-xs max-w-xs truncate" title={j.lastError ?? ''}>
                    {j.lastError ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-right">{j.attempts}/{j.maxAttempts}</td>
                  <td className="px-4 py-2 text-right text-gray-500 text-xs">
                    {new Date(j.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <p className="text-sm text-gray-500">
              Showing {data ? data.offset + 1 : 0}–{data ? Math.min(data.offset + PAGE_SIZE, data.failedTotal) : 0} of {data?.failedTotal ?? 0}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-3 py-1 rounded border border-gray-300 text-sm disabled:opacity-40"
              >
                Prev
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= totalPages - 1}
                className="px-3 py-1 rounded border border-gray-300 text-sm disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  loading,
  color,
}: {
  label: string;
  value: number | undefined;
  loading: boolean;
  color: 'yellow' | 'blue' | 'red' | 'green';
}) {
  const colors = {
    yellow: 'bg-yellow-50 border-yellow-200 text-yellow-800',
    blue: 'bg-blue-50 border-blue-200 text-blue-800',
    red: 'bg-red-50 border-red-200 text-red-800',
    green: 'bg-green-50 border-green-200 text-green-800',
  };
  return (
    <div className={`rounded-lg border p-4 ${colors[color]}`}>
      <p className="text-xs font-medium uppercase tracking-wide opacity-70">{label}</p>
      <p className="text-2xl font-bold mt-1">
        {loading ? '...' : value ?? 0}
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/app/admin/jobs/page.tsx
git commit -m "feat: build admin jobs page (outbox summary + queue health + failed jobs list)"
```

---

## Task 9: Build + test verification

**Files:** None (verification only)

- [ ] **Step 1: Run full TypeScript check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2: Run tests**

```bash
pnpm test
```

Expected: 189/189 tests pass (these are all read-only UI pages — no business logic tests affected).

- [ ] **Step 3: Run build**

```bash
pnpm build
```

Expected: all pages compile successfully.

- [ ] **Step 4: Commit any build fixes**

If any fixes are needed:
```bash
git add -A
git commit -m "fix: build fixes for admin read-only pages"
```

---

## Verification Checklist

- [ ] `/admin/overview` shows system health bar + business table, 30s auto-refresh
- [ ] Clicking a business row in overview navigates to `/admin/businesses/[id]`
- [ ] `/admin/costs` shows provider/business/day breakdowns, date range filter works
- [ ] Businesses exceeding 80% of daily cost limit highlighted in red
- [ ] Today's platform spend progress bar shows correctly
- [ ] `/admin/notifications` shows delivery log with business/channel/status filters
- [ ] Notifications pagination works (prev/next)
- [ ] `/admin/jobs` shows outbox summary cards + BullMQ queue depth
- [ ] Jobs page handles Redis unavailable gracefully (shows "unavailable" instead of crashing)
- [ ] Failed jobs table with pagination
- [ ] All pages return 401 when accessed without auth session
- [ ] `pnpm build` succeeds
- [ ] `pnpm test` — 189/189 tests pass
