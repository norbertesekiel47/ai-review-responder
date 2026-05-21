# Sprint 5A Prompt 19c — Read-Only Owner Dashboard

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an authenticated, read-only owner dashboard that proves ROI with real data — value summary, review velocity chart, conditional ranking chart, recent reviews, and latest intelligence brief.

**Architecture:** A single API route (`GET /api/dashboard`) returns all dashboard data scoped by the owner's `business_id`. The page is a Next.js server component shell with a client component body that fetches data on mount. Charts use `recharts`. The authenticated layout gets a minimal nav shell (Dashboard + business name + sign out). No approval actions — read-only in Sprint 5A.

**Tech Stack:** Next.js 14 App Router, recharts (new dependency), Supabase Auth, Tailwind CSS, Postgres.js

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Install | `recharts` | Bar/line chart library for review velocity + ranking charts |
| Create | `src/app/api/dashboard/route.ts` | Dashboard data API — all queries in one endpoint, scoped by owner's business_id |
| Create | `src/components/OwnerNav.tsx` | Owner nav bar (Dashboard + business name + Sign out) |
| Modify | `src/app/(authenticated)/layout.tsx` | Replace pass-through with nav shell using OwnerNav |
| Create | `src/components/DashboardContent.tsx` | Client component with all dashboard sections (value banner, charts, reviews, brief) |
| Modify | `src/app/(authenticated)/dashboard/page.tsx` | Server component shell that renders DashboardContent |
| Modify | `src/middleware.ts` | Add `/api/dashboard` to owner-protected matchers |

---

## Task 1: Install recharts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install recharts**

```bash
cd "C:\Users\norbe\Desktop\RepWorth" && pnpm add recharts
```

- [ ] **Step 2: Verify installation**

```bash
pnpm list recharts
```

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore(5a): add recharts for dashboard charts"
```

---

## Task 2: Dashboard Data API

**Files:**
- Create: `src/app/api/dashboard/route.ts`
- Modify: `src/middleware.ts`

This is the single API endpoint that returns all dashboard data. It must:
1. Call `requireRole(request, 'owner')` — defense-in-depth (middleware already guards)
2. Verify `user.businessId` is non-null
3. Run all queries scoped by that business_id
4. Return one JSON payload with all sections

- [ ] **Step 1: Add `/api/dashboard` to middleware matchers**

In `src/middleware.ts`, the middleware function already guards `/dashboard` paths for owner role. Add API protection for `/api/dashboard`:

After the block that checks `/api/admin` paths (around line 55), add:

```typescript
  // 6. Owner API routes
  if (pathname.startsWith('/api/dashboard')) {
    if (!authUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const { data } = await supabaseAdmin
      .from('users')
      .select('role, business_id')
      .eq('auth_id', authUser.id)
      .limit(1)
      .single();
    if (!data || data.role !== 'owner' || !data.business_id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
  }
```

Add to the `config.matcher` array:
```typescript
    '/api/dashboard/:path*',
```

- [ ] **Step 2: Create the dashboard API route**

Create `src/app/api/dashboard/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';

export const dynamic = 'force-dynamic';

export interface DashboardData {
  business: {
    name: string;
    createdAt: string;
  };
  valueSummary: {
    totalReviewsHandled: number;
    totalTimeSavedMinutes: number;
    currentResponseRate: number;
    baselineResponseRate: number | null;
  };
  reviewVelocity: Array<{
    weekStart: string;
    count: number;
  }>;
  ranking: Array<{
    keyword: string;
    snapshots: Array<{ date: string; position: number }>;
  }> | null;
  recentReviews: Array<{
    id: string;
    reviewerName: string;
    starRating: number;
    reviewText: string | null;
    reviewDate: string;
    status: string;
    responseText: string | null;
    responseStatus: string | null;
  }>;
  latestBrief: {
    text: string;
    type: 'monthly' | 'weekly';
    periodLabel: string;
  } | null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Defense-in-depth: middleware already guards, but route must also verify
  let user;
  try {
    user = await requireRole(request, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!user.businessId) {
    return NextResponse.json({ error: 'No business linked to this account' }, { status: 403 });
  }

  const businessId = user.businessId;

  try {
    const [
      businessRows,
      totalReviewsRows,
      respondedRows,
      velocityRows,
      rankingRows,
      recentReviewRows,
      monthlyBriefRows,
      weeklyBriefRows,
    ] = await Promise.all([
      // Business info + baseline
      sql<{
        name: string;
        created_at: Date;
        initial_review_count: number | null;
        initial_responded_count: number | null;
        baseline_captured_at: Date | null;
      }[]>`
        SELECT name, created_at, initial_review_count, initial_responded_count, baseline_captured_at
        FROM businesses WHERE id = ${businessId}
      `,

      // Total reviews handled (all time)
      sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count FROM reviews WHERE business_id = ${businessId}
      `,

      // Total responded (all time)
      sql<{ count: string }[]>`
        SELECT COUNT(DISTINCT r.id)::text AS count FROM reviews r
        JOIN responses resp ON resp.review_id = r.id
          AND resp.status IN ('posted', 'approved', 'edited', 'awaiting_manual_post')
        WHERE r.business_id = ${businessId}
      `,

      // Review velocity: last 8 weeks
      sql<{ week_start: string; count: string }[]>`
        SELECT
          DATE_TRUNC('week', detected_at)::date::text AS week_start,
          COUNT(*)::text AS count
        FROM reviews
        WHERE business_id = ${businessId}
          AND detected_at >= (CURRENT_DATE - INTERVAL '56 days')
        GROUP BY DATE_TRUNC('week', detected_at)
        ORDER BY week_start ASC
      `,

      // Ranking snapshots (all, for chart)
      sql<{ keyword: string; snapshot_date: string; rank_position: number }[]>`
        SELECT keyword, snapshot_date::text, rank_position
        FROM ranking_snapshots
        WHERE business_id = ${businessId}
          AND rank_position IS NOT NULL
        ORDER BY keyword, snapshot_date ASC
      `,

      // Recent reviews (last 10)
      sql<{
        id: string;
        reviewer_name: string;
        star_rating: number;
        review_text: string | null;
        review_date: Date | null;
        status: string;
        response_text: string | null;
        response_status: string | null;
      }[]>`
        SELECT
          r.id, r.reviewer_name, r.star_rating, r.review_text, r.review_date, r.status,
          resp.response_text, resp.status AS response_status
        FROM reviews r
        LEFT JOIN responses resp ON resp.review_id = r.id
          AND resp.status NOT IN ('superseded', 'failed')
        WHERE r.business_id = ${businessId}
        ORDER BY r.detected_at DESC
        LIMIT 10
      `,

      // Latest monthly brief
      sql<{ summary_text: string; month_start_date: string }[]>`
        SELECT summary_text, month_start_date::text
        FROM monthly_impact_emails
        WHERE business_id = ${businessId} AND summary_text IS NOT NULL AND sent_at IS NOT NULL
        ORDER BY month_start_date DESC LIMIT 1
      `,

      // Latest weekly brief
      sql<{ summary_text: string; week_start_date: string }[]>`
        SELECT summary_text, week_start_date::text
        FROM weekly_summaries
        WHERE business_id = ${businessId} AND summary_text IS NOT NULL AND sent_at IS NOT NULL
        ORDER BY week_start_date DESC LIMIT 1
      `,
    ]);

    const business = businessRows[0];
    if (!business) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    const totalReviews = parseInt(totalReviewsRows[0]?.count ?? '0', 10);
    const totalResponded = parseInt(respondedRows[0]?.count ?? '0', 10);
    const currentResponseRate = totalReviews > 0
      ? Math.round((totalResponded / totalReviews) * 100)
      : 0;

    let baselineResponseRate: number | null = null;
    if (
      business.baseline_captured_at &&
      business.initial_review_count !== null &&
      business.initial_review_count > 0 &&
      business.initial_responded_count !== null
    ) {
      baselineResponseRate = Math.round(
        (business.initial_responded_count / business.initial_review_count) * 100,
      );
    }

    // Group ranking snapshots by keyword
    const rankingMap = new Map<string, Array<{ date: string; position: number }>>();
    for (const row of rankingRows) {
      if (!rankingMap.has(row.keyword)) rankingMap.set(row.keyword, []);
      rankingMap.get(row.keyword)!.push({ date: row.snapshot_date, position: row.rank_position });
    }
    const ranking = rankingMap.size > 0
      ? Array.from(rankingMap.entries()).map(([keyword, snapshots]) => ({ keyword, snapshots }))
      : null;

    // Pick latest brief: prefer monthly, fall back to weekly
    let latestBrief: DashboardData['latestBrief'] = null;
    const monthlyBrief = monthlyBriefRows[0];
    const weeklyBrief = weeklyBriefRows[0];

    if (monthlyBrief?.summary_text) {
      const d = new Date(monthlyBrief.month_start_date + 'T00:00:00Z');
      latestBrief = {
        text: monthlyBrief.summary_text,
        type: 'monthly',
        periodLabel: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      };
    } else if (weeklyBrief?.summary_text) {
      latestBrief = {
        text: weeklyBrief.summary_text,
        type: 'weekly',
        periodLabel: `Week of ${weeklyBrief.week_start_date}`,
      };
    }

    const data: DashboardData = {
      business: {
        name: business.name,
        createdAt: business.created_at.toISOString(),
      },
      valueSummary: {
        totalReviewsHandled: totalResponded,
        totalTimeSavedMinutes: totalResponded * 7,
        currentResponseRate,
        baselineResponseRate,
      },
      reviewVelocity: velocityRows.map((r) => ({
        weekStart: r.week_start,
        count: parseInt(r.count, 10),
      })),
      ranking,
      recentReviews: recentReviewRows.map((r) => ({
        id: r.id,
        reviewerName: r.reviewer_name ?? 'Anonymous',
        starRating: r.star_rating,
        reviewText: r.review_text,
        reviewDate: r.review_date ? r.review_date.toISOString() : '',
        status: r.status,
        responseText: r.response_text,
        responseStatus: r.response_status,
      })),
      latestBrief,
    };

    return NextResponse.json(data);
  } catch (error) {
    console.error('[api/dashboard] Failed to fetch dashboard data:', error);
    return NextResponse.json({ error: 'Failed to load dashboard' }, { status: 500 });
  }
}
```

- [ ] **Step 3: Verify TypeScript compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/dashboard/route.ts src/middleware.ts
git commit -m "feat(5a): add GET /api/dashboard for owner dashboard data"
```

---

## Task 3: OwnerNav Component

**Files:**
- Create: `src/components/OwnerNav.tsx`

Follows the exact same pattern as `src/components/AdminNav.tsx` but for owner pages.

- [ ] **Step 1: Create OwnerNav**

Create `src/components/OwnerNav.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createBrowserSupabaseClient } from '@/lib/db/browser';

interface OwnerNavProps {
  businessName: string;
}

export function OwnerNav({ businessName }: OwnerNavProps) {
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    const supabase = createBrowserSupabaseClient();
    await supabase.auth.signOut();
    router.push('/admin/login');
  }

  return (
    <nav className="border-b border-gray-200 bg-white">
      <div className="mx-auto max-w-7xl px-4">
        <div className="flex h-14 items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/dashboard" className="text-lg font-bold text-gray-900">
              RepWorth
            </Link>
            <span className="hidden text-sm text-gray-500 sm:inline">{businessName}</span>
          </div>

          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            className="rounded-md px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 disabled:opacity-50"
          >
            {signingOut ? 'Signing out...' : 'Sign out'}
          </button>
        </div>
      </div>
    </nav>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/OwnerNav.tsx
git commit -m "feat(5a): add OwnerNav component for dashboard layout"
```

---

## Task 4: Authenticated Layout

**Files:**
- Modify: `src/app/(authenticated)/layout.tsx`

Replace the pass-through layout with a server component that reads the user session and renders OwnerNav.

- [ ] **Step 1: Rewrite the authenticated layout**

Replace `src/app/(authenticated)/layout.tsx`:

```tsx
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { redirect } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { OwnerNav } from '@/components/OwnerNav';

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Read Supabase session from cookies
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          // Layout can't set cookies — handled by middleware
        },
      },
    },
  );

  const { data: { user: authUser } } = await supabase.auth.getUser();
  if (!authUser) redirect('/admin/login');

  // Look up business name for nav
  const [appUser] = await sql<{ business_id: string | null }[]>`
    SELECT business_id FROM users WHERE auth_id = ${authUser.id} LIMIT 1
  `;

  let businessName = '';
  if (appUser?.business_id) {
    const [biz] = await sql<{ name: string }[]>`
      SELECT name FROM businesses WHERE id = ${appUser.business_id} LIMIT 1
    `;
    businessName = biz?.name ?? '';
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <OwnerNav businessName={businessName} />
      <main className="mx-auto max-w-4xl px-4 py-6">{children}</main>
    </div>
  );
}
```

- [ ] **Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/app/(authenticated)/layout.tsx
git commit -m "feat(5a): add authenticated layout with OwnerNav shell"
```

---

## Task 5: Dashboard Client Component

**Files:**
- Create: `src/components/DashboardContent.tsx`

This is the main client component rendering all dashboard sections. It fetches from `GET /api/dashboard` on mount.

- [ ] **Step 1: Create DashboardContent**

Create `src/components/DashboardContent.tsx` with:

**Section A — Value Summary Banner**: High-contrast card with "Since joining RepWorth" framing, total reviews handled, time saved, response rate before → now.

**Section B — Review Velocity Chart**: `recharts` BarChart, last 8 weeks, one bar per week.

**Section C — Google Maps Ranking Chart (conditional)**: `recharts` LineChart, Y-axis inverted (rank #1 at top), one line per keyword. Hidden when no data.

**Section D — Recent Reviews**: Last 10 reviews with color-coded status badges. Expandable response text. Pending reviews show "Check your email to approve." No action buttons.

**Section E — Latest Intelligence Brief**: Most recent monthly or weekly brief text.

The component should be a `'use client'` component that:
1. Uses `useState` + `useEffect` to fetch `/api/dashboard`
2. Handles loading and error states
3. Uses recharts `ResponsiveContainer`, `BarChart`, `Bar`, `XAxis`, `YAxis`, `Tooltip`, `LineChart`, `Line`
4. Status badge colors: new=gray, pending_approval=yellow, approved=blue, awaiting_manual_post=orange, posted=green, failed=red

```tsx
'use client';

import { useState, useEffect } from 'react';
import type { DashboardData } from '@/app/api/dashboard/route';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip,
  LineChart, Line, CartesianGrid,
} from 'recharts';

const STATUS_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  new: { bg: 'bg-gray-100', text: 'text-gray-700', label: 'New' },
  generating: { bg: 'bg-gray-100', text: 'text-gray-700', label: 'Generating' },
  pending_approval: { bg: 'bg-yellow-100', text: 'text-yellow-800', label: 'Pending' },
  approved: { bg: 'bg-blue-100', text: 'text-blue-800', label: 'Approved' },
  edited: { bg: 'bg-blue-100', text: 'text-blue-800', label: 'Edited' },
  awaiting_manual_post: { bg: 'bg-orange-100', text: 'text-orange-800', label: 'Posting' },
  posted: { bg: 'bg-green-100', text: 'text-green-800', label: 'Posted' },
  failed: { bg: 'bg-red-100', text: 'text-red-700', label: 'Failed' },
};

function StatusBadge({ status }: { status: string }) {
  const style = STATUS_COLORS[status] ?? STATUS_COLORS.new;
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${style.bg} ${style.text}`}>
      {style.label}
    </span>
  );
}

function renderStars(rating: number) {
  return '★'.repeat(rating) + '☆'.repeat(5 - rating);
}

export function DashboardContent() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedReview, setExpandedReview] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/dashboard')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load dashboard');
        return res.json();
      })
      .then(setData)
      .catch((err) => setError(err.message));
  }, []);

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center text-red-700">
        {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        Loading dashboard...
      </div>
    );
  }

  const { valueSummary, reviewVelocity, ranking, recentReviews, latestBrief } = data;
  const timeSavedHours = (valueSummary.totalTimeSavedMinutes / 60).toFixed(1);

  return (
    <div className="space-y-6">
      {/* Section A: Value Summary Banner */}
      <div className="rounded-lg bg-gradient-to-r from-blue-600 to-blue-700 p-6 text-white shadow">
        <p className="mb-4 text-sm font-medium uppercase tracking-wider opacity-80">
          Since joining RepWorth
        </p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <p className="text-3xl font-bold">{valueSummary.totalReviewsHandled}</p>
            <p className="text-sm opacity-80">Reviews handled</p>
          </div>
          <div>
            <p className="text-3xl font-bold">{timeSavedHours}h</p>
            <p className="text-sm opacity-80">Time saved</p>
          </div>
          <div>
            <p className="text-3xl font-bold">{valueSummary.currentResponseRate}%</p>
            <p className="text-sm opacity-80">
              Response rate
              {valueSummary.baselineResponseRate !== null && (
                <span className="ml-1 opacity-70">
                  (was {valueSummary.baselineResponseRate}%)
                </span>
              )}
            </p>
          </div>
        </div>
      </div>

      {/* Section B: Review Velocity Chart */}
      {reviewVelocity.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-500">
            Review Velocity (last 8 weeks)
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={reviewVelocity}>
              <XAxis
                dataKey="weekStart"
                tick={{ fontSize: 11 }}
                tickFormatter={(v: string) => {
                  const d = new Date(v + 'T00:00:00Z');
                  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
                }}
              />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip
                labelFormatter={(v: string) => `Week of ${v}`}
                formatter={(value: number) => [value, 'Reviews']}
              />
              <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Section C: Google Maps Ranking Chart (conditional) */}
      {ranking && ranking.length > 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-500">
            Google Maps Ranking
          </h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                type="category"
                allowDuplicatedCategory={false}
                tick={{ fontSize: 11 }}
                tickFormatter={(v: string) => {
                  const d = new Date(v + 'T00:00:00Z');
                  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
                }}
              />
              <YAxis reversed domain={[1, 'auto']} tick={{ fontSize: 11 }} label={{ value: 'Rank', angle: -90, position: 'insideLeft', style: { fontSize: 11 } }} />
              <Tooltip formatter={(value: number, name: string) => [`#${value}`, name]} />
              {ranking.map((r, i) => (
                <Line
                  key={r.keyword}
                  data={r.snapshots}
                  dataKey="position"
                  name={r.keyword}
                  stroke={['#3b82f6', '#10b981', '#f59e0b'][i % 3]}
                  strokeWidth={2}
                  dot={{ r: 3 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Section D: Recent Reviews */}
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-wider text-gray-500">
          Recent Reviews
        </h3>
        {recentReviews.length === 0 ? (
          <p className="text-center text-sm text-gray-400">No reviews yet</p>
        ) : (
          <div className="divide-y divide-gray-100">
            {recentReviews.map((review) => (
              <div key={review.id} className="py-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-lg tracking-wider">{renderStars(review.starRating)}</span>
                    <span className="text-sm font-medium text-gray-700">{review.reviewerName}</span>
                  </div>
                  <StatusBadge status={review.responseStatus ?? review.status} />
                </div>
                {review.reviewText && (
                  <p className="mt-1 text-sm text-gray-600">{review.reviewText}</p>
                )}
                {review.status === 'pending_approval' && (
                  <p className="mt-1 text-xs text-amber-600">Check your email to approve this response.</p>
                )}
                {review.responseText && (
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => setExpandedReview(expandedReview === review.id ? null : review.id)}
                      className="text-xs font-medium text-blue-600 hover:text-blue-800"
                    >
                      {expandedReview === review.id ? 'Hide response' : 'Show response'}
                    </button>
                    {expandedReview === review.id && (
                      <p className="mt-1 rounded-md bg-green-50 p-3 text-sm text-green-800">
                        {review.responseText}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Section E: Latest Intelligence Brief */}
      {latestBrief && (
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <h3 className="mb-1 text-sm font-semibold uppercase tracking-wider text-gray-500">
            {latestBrief.type === 'monthly' ? 'Monthly' : 'Weekly'} Intelligence Brief
          </h3>
          <p className="mb-3 text-xs text-gray-400">{latestBrief.periodLabel}</p>
          <div className="rounded-md border-l-4 border-blue-500 bg-blue-50 p-4">
            <p className="text-sm leading-relaxed text-gray-700">{latestBrief.text}</p>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/DashboardContent.tsx
git commit -m "feat(5a): add DashboardContent client component with charts and reviews"
```

---

## Task 6: Dashboard Page

**Files:**
- Modify: `src/app/(authenticated)/dashboard/page.tsx`

Replace the placeholder with a server component shell that renders the client component.

- [ ] **Step 1: Rewrite dashboard page**

Replace `src/app/(authenticated)/dashboard/page.tsx`:

```tsx
import { DashboardContent } from '@/components/DashboardContent';

export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  return <DashboardContent />;
}
```

- [ ] **Step 2: Verify the dev server starts without errors**

```bash
pnpm dev
```

Visit `http://localhost:3000/dashboard` — should redirect to login (no auth session). This confirms the page renders and middleware works.

- [ ] **Step 3: Verify TypeScript compilation**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Run full test suite**

```bash
pnpm test
```

Expected: All 312 tests still pass (no test regressions from UI changes)

- [ ] **Step 5: Commit**

```bash
git add src/app/(authenticated)/dashboard/page.tsx
git commit -m "feat(5a): replace dashboard placeholder with DashboardContent"
```

---

## Task 7: Update CLAUDE.md + progresstracking.md

**Files:**
- Modify: `.claude/CLAUDE.md`
- Modify: `docs/progresstracking.md`

- [ ] **Step 1: Update CLAUDE.md Sprint 5 status**

Add Prompt 19c entry under Sprint 5 IN PROGRESS section.

- [ ] **Step 2: Update progresstracking.md**

Add Phase 5A.2 entry with detailed list of what was built.

- [ ] **Step 3: Commit**

```bash
git add .claude/CLAUDE.md docs/progresstracking.md
git commit -m "docs: update status with Sprint 5A Prompt 19c (owner dashboard)"
```
