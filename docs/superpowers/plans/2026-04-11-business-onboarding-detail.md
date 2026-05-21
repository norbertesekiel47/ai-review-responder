# Prompt 14c: Business Onboarding + Detail Page Upgrade

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the business onboarding form, business list page, and upgrade the existing business detail page with a profile editor and review list.

**Architecture:** Three interconnected pages: (1) onboarding form (`/admin/businesses/new`) that creates a business + owner user + initial sync outbox entry in one transaction, (2) business list (`/admin/businesses`) with pagination, (3) upgraded business detail (`/admin/businesses/[id]`) that adds an editable profile section and review list above the existing manual-post section. All pages use TanStack Query and the established admin route pattern.

**Tech Stack:** react-hook-form, Zod, TanStack Query, Tailwind CSS, Postgres.js `sql`, `extractPlaceId()` from `@/lib/reviews/url-parser`

---

## Conventions

- All API routes follow the established pattern: `requireRole(request, 'admin', 'sales_partner')` try/catch, `export const dynamic = 'force-dynamic'`, `sql` from `@/lib/db/server`
- All page types are defined inline (NOT imported from route files — this causes bundler issues in dev mode)
- Pages are `'use client'` with `useQuery`/`useMutation` from `@tanstack/react-query`
- Auth comment: `// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/app/api/admin/businesses/route.ts` | **CREATE** | GET (list with pagination) + POST (onboarding — create business + owner + sync outbox) |
| `src/app/api/admin/businesses/[id]/route.ts` | **CREATE** | GET (business + reviews + responses) + PATCH (update business settings) |
| `src/app/admin/businesses/new/page.tsx` | **CREATE** | Onboarding form with react-hook-form + Zod |
| `src/app/admin/businesses/page.tsx` | **REWRITE** | Business list table with pagination |
| `src/app/admin/businesses/[id]/page.tsx` | **REWRITE** | Upgraded detail: profile editor + review list + existing manual-post section |
| `src/app/admin/businesses/[id]/manual-post-section.tsx` | **KEEP** | Unchanged — existing component |

---

## Task 1: Business list + onboarding API route

**Files:**
- Create: `src/app/api/admin/businesses/route.ts`

This single file handles both GET (list) and POST (onboard).

- [ ] **Step 1: Create the API route**

Create `src/app/api/admin/businesses/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { extractPlaceId } from '@/lib/reviews/url-parser';
import type { SyncReviewsPayload } from '@/lib/shared/worker-types';

export const dynamic = 'force-dynamic';

// ── GET: Business list with pagination ──────────────────────────────

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
    const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') ?? '20', 10) || 20, 100);
    const offset = Math.max(parseInt(request.nextUrl.searchParams.get('offset') ?? '0', 10) || 0, 0);

    const [rows, countRows] = await Promise.all([
      sql`
        SELECT
          b.id, b.name, b.category, b.subscription_status, b.last_sync_at,
          COUNT(CASE WHEN resp.status = 'pending_approval' THEN 1 END)::int AS pending_count
        FROM businesses b
        LEFT JOIN responses resp ON resp.business_id = b.id AND resp.status != 'superseded'
        GROUP BY b.id
        ORDER BY b.name ASC
        LIMIT ${limit} OFFSET ${offset}
      `,
      sql`SELECT COUNT(*)::int AS total FROM businesses`,
    ]);

    return NextResponse.json({
      businesses: rows.map((r) => ({
        id: r.id as string,
        name: r.name as string,
        category: r.category as string | null,
        subscriptionStatus: r.subscription_status as string,
        lastSyncAt: r.last_sync_at ? (r.last_sync_at as Date).toISOString() : null,
        pendingCount: (r.pending_count as number) ?? 0,
      })),
      total: countRows[0]?.total ?? 0,
      limit,
      offset,
    });
  } catch (error) {
    console.error('[api/admin/businesses] GET failed:', error);
    return NextResponse.json({ error: 'Failed to fetch businesses' }, { status: 500 });
  }
}

// ── POST: Onboard a new business ────────────────────────────────────

const OnboardSchema = z.object({
  name: z.string().min(1).max(255),
  category: z.string().max(100).optional(),
  googleMapsUrl: z.string().min(1),
  ownerName: z.string().min(1).max(255),
  ownerEmail: z.string().email().max(255),
  ownerPhone: z.string().max(20).optional(),
  notificationPreference: z.enum(['email', 'sms', 'both']).default('email'),
  tone: z.string().max(100).default('professional and friendly'),
  productsServices: z.string().max(5000).optional(),
  staffNames: z.string().max(2000).optional(),
  highlightFacts: z.string().max(2000).optional(),
  avoidFacts: z.string().max(2000).optional(),
  sampleResponses: z.string().max(5000).optional(),
  subscriptionTier: z.enum(['founding', 'standard']).default('standard'),
});

function splitLines(text: string | undefined): string[] {
  if (!text?.trim()) return [];
  return text.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = OnboardSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  const data = parsed.data;
  const placeId = extractPlaceId(data.googleMapsUrl);
  if (!placeId) {
    return NextResponse.json(
      { error: 'Could not extract Google Place ID from URL' },
      { status: 400 },
    );
  }

  const businessId = uuidv7();
  const userId = uuidv7();
  const outboxId = uuidv7();

  const staffNames = splitLines(data.staffNames);
  const highlightFacts = splitLines(data.highlightFacts);
  const avoidFacts = splitLines(data.avoidFacts);
  const sampleResponses = splitLines(data.sampleResponses);

  try {
    await sql.begin(async (tx) => {
      // a. Create businesses row
      await tx`
        INSERT INTO businesses (
          id, name, category, google_place_id,
          tone, products_services, staff_names, highlight_facts, avoid_facts, sample_responses,
          notification_preference, owner_name, owner_email, owner_phone,
          subscription_tier, subscription_status
        ) VALUES (
          ${businessId}, ${data.name}, ${data.category ?? null}, ${placeId},
          ${data.tone}, ${data.productsServices ?? null},
          ${staffNames}, ${highlightFacts}, ${avoidFacts}, ${sampleResponses},
          ${data.notificationPreference}, ${data.ownerName}, ${data.ownerEmail}, ${data.ownerPhone ?? null},
          ${data.subscriptionTier}, 'pending_payment'
        )
      `;

      // b. Create owner user row (auth_id=NULL — no Auth invite in MVP)
      await tx`
        INSERT INTO users (id, name, email, phone, role, business_id)
        VALUES (${userId}, ${data.ownerName}, ${data.ownerEmail}, ${data.ownerPhone ?? null}, 'owner', ${businessId})
      `;

      // c. Queue initial sync (allowed before payment for sales demo)
      const payload: SyncReviewsPayload = {
        business_id: businessId,
        google_place_id: placeId,
      };
      await tx`
        INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
        VALUES (${outboxId}, 'sync_reviews', 'business', ${businessId}, ${JSON.stringify(payload)}::jsonb, 'pending')
      `;
    });

    return NextResponse.json({ id: businessId }, { status: 201 });
  } catch (error) {
    console.error('[api/admin/businesses] POST failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    // Duplicate email
    if (message.includes('unique') || message.includes('23505')) {
      return NextResponse.json({ error: 'A user with this email already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: 'Failed to create business' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/admin/businesses/route.ts
git commit -m "feat: add business list GET + onboarding POST API route"
```

---

## Task 2: Business detail + update API route

**Files:**
- Create: `src/app/api/admin/businesses/[id]/route.ts`

- [ ] **Step 1: Create the detail/update API route**

Create `src/app/api/admin/businesses/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';

export const dynamic = 'force-dynamic';

// ── GET: Business detail + reviews + responses ──────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: businessId } = await params;

  try {
    const [businessRows] = await Promise.all([
      sql`SELECT * FROM businesses WHERE id = ${businessId}`,
    ]);

    const business = businessRows[0];
    if (!business) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    // Reviews with their latest non-superseded response status
    const reviews = await sql`
      SELECT
        r.id, r.reviewer_name, r.star_rating, r.review_text, r.review_date,
        r.detected_language, r.status AS review_status, r.detected_at,
        resp.id AS response_id, resp.status AS response_status,
        resp.response_text, resp.approved_text, resp.version
      FROM reviews r
      LEFT JOIN LATERAL (
        SELECT id, status, response_text, approved_text, version
        FROM responses
        WHERE review_id = r.id AND status != 'superseded'
        ORDER BY version DESC
        LIMIT 1
      ) resp ON true
      WHERE r.business_id = ${businessId}
      ORDER BY r.detected_at DESC
    `;

    // Parse JSONB arrays (PgBouncer returns strings)
    const parseArray = (val: unknown): string[] => {
      if (Array.isArray(val)) return val;
      if (typeof val === 'string') {
        try { return JSON.parse(val); } catch { return []; }
      }
      return [];
    };

    return NextResponse.json({
      business: {
        id: business.id as string,
        name: business.name as string,
        category: business.category as string | null,
        googlePlaceId: business.google_place_id as string | null,
        tone: business.tone as string,
        productsServices: business.products_services as string | null,
        staffNames: parseArray(business.staff_names),
        highlightFacts: parseArray(business.highlight_facts),
        avoidFacts: parseArray(business.avoid_facts),
        sampleResponses: parseArray(business.sample_responses),
        subscriptionStatus: business.subscription_status as string,
        subscriptionTier: business.subscription_tier as string,
        ownerName: business.owner_name as string,
        ownerEmail: business.owner_email as string,
        lastSyncAt: business.last_sync_at ? (business.last_sync_at as Date).toISOString() : null,
      },
      reviews: reviews.map((r) => ({
        id: r.id as string,
        reviewerName: r.reviewer_name as string,
        starRating: r.star_rating as number,
        reviewText: r.review_text as string | null,
        reviewDate: r.review_date ? (r.review_date as Date).toISOString() : null,
        detectedLanguage: r.detected_language as string | null,
        detectedAt: (r.detected_at as Date).toISOString(),
        responseId: r.response_id as string | null,
        responseStatus: r.response_status as string | null,
        responseText: r.response_text as string | null,
        approvedText: r.approved_text as string | null,
        responseVersion: r.version as number | null,
      })),
    });
  } catch (error) {
    console.error('[api/admin/businesses/[id]] GET failed:', error);
    return NextResponse.json({ error: 'Failed to fetch business' }, { status: 500 });
  }
}

// ── PATCH: Update business settings ─────────────────────────────────

const UpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  category: z.string().max(100).optional(),
  tone: z.string().max(100).optional(),
  productsServices: z.string().max(5000).optional(),
  staffNames: z.array(z.string()).optional(),
  highlightFacts: z.array(z.string()).optional(),
  avoidFacts: z.array(z.string()).optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: 'At least one field must be provided',
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin', 'sales_partner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: businessId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
      { status: 400 },
    );
  }

  const updates = parsed.data;

  try {
    // Build SET clause dynamically from provided fields
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 2; // $1 is businessId

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIdx++}`);
      values.push(updates.name);
    }
    if (updates.category !== undefined) {
      setClauses.push(`category = $${paramIdx++}`);
      values.push(updates.category);
    }
    if (updates.tone !== undefined) {
      setClauses.push(`tone = $${paramIdx++}`);
      values.push(updates.tone);
    }
    if (updates.productsServices !== undefined) {
      setClauses.push(`products_services = $${paramIdx++}`);
      values.push(updates.productsServices);
    }
    if (updates.staffNames !== undefined) {
      setClauses.push(`staff_names = $${paramIdx++}`);
      values.push(updates.staffNames);
    }
    if (updates.highlightFacts !== undefined) {
      setClauses.push(`highlight_facts = $${paramIdx++}`);
      values.push(updates.highlightFacts);
    }
    if (updates.avoidFacts !== undefined) {
      setClauses.push(`avoid_facts = $${paramIdx++}`);
      values.push(updates.avoidFacts);
    }

    setClauses.push(`updated_at = NOW()`);

    const result = await sql.unsafe(
      `UPDATE businesses SET ${setClauses.join(', ')} WHERE id = $1`,
      [businessId, ...values],
    );

    if (result.count === 0) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[api/admin/businesses/[id]] PATCH failed:', error);
    return NextResponse.json({ error: 'Failed to update business' }, { status: 500 });
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/admin/businesses/[id]/route.ts"
git commit -m "feat: add business detail GET + settings PATCH API route"
```

---

## Task 3: Business onboarding form page

**Files:**
- Create: `src/app/admin/businesses/new/page.tsx`

- [ ] **Step 1: Create the onboarding page**

Create the directory and file `src/app/admin/businesses/new/page.tsx`:

```tsx
'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)

const TONE_OPTIONS = [
  'warm and casual',
  'professional and friendly',
  'professional and reassuring',
  'professional and gracious',
  'warm and personal',
  'professional and caring',
] as const;

const FormSchema = z.object({
  name: z.string().min(1, 'Business name is required').max(255),
  category: z.string().max(100).optional(),
  googleMapsUrl: z.string().min(1, 'Google Maps URL is required'),
  ownerName: z.string().min(1, 'Owner name is required').max(255),
  ownerEmail: z.string().email('Valid email is required').max(255),
  ownerPhone: z.string().max(20).optional(),
  notificationPreference: z.enum(['email', 'sms', 'both']),
  tone: z.string().max(100),
  productsServices: z.string().max(5000).optional(),
  staffNames: z.string().max(2000).optional(),
  highlightFacts: z.string().max(2000).optional(),
  avoidFacts: z.string().max(2000).optional(),
  sampleResponses: z.string().max(5000).optional(),
  subscriptionTier: z.enum(['founding', 'standard']),
});

type FormData = z.infer<typeof FormSchema>;

export default function NewBusinessPage() {
  const router = useRouter();
  const [serverError, setServerError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      notificationPreference: 'email',
      tone: 'professional and friendly',
      subscriptionTier: 'founding',
    },
  });

  async function onSubmit(data: FormData) {
    setServerError('');
    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/businesses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setServerError(body.error ?? `Failed (${res.status})`);
        return;
      }
      const { id } = await res.json();
      router.push(`/admin/businesses/${id}`);
    } catch {
      setServerError('Connection failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-2xl mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Onboard New Business</h1>

        {serverError && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 text-sm text-red-700">
            {serverError}
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
          {/* Business Info */}
          <section className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Business Info</h2>
            <Field label="Business Name" error={errors.name?.message}>
              <input {...register('name')} className={inputCls} placeholder="Bella Italia" />
            </Field>
            <Field label="Category" error={errors.category?.message}>
              <input {...register('category')} className={inputCls} placeholder="Restaurant, Salon, Dentist..." />
            </Field>
            <Field label="Google Maps URL" error={errors.googleMapsUrl?.message}>
              <input {...register('googleMapsUrl')} className={inputCls} placeholder="https://www.google.com/maps/place/..." />
            </Field>
          </section>

          {/* Owner Info */}
          <section className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Owner Info</h2>
            <Field label="Owner Name" error={errors.ownerName?.message}>
              <input {...register('ownerName')} className={inputCls} placeholder="John Smith" />
            </Field>
            <Field label="Email" error={errors.ownerEmail?.message}>
              <input {...register('ownerEmail')} type="email" className={inputCls} placeholder="owner@business.com" />
            </Field>
            <Field label="Phone (optional)" error={errors.ownerPhone?.message}>
              <input {...register('ownerPhone')} type="tel" className={inputCls} placeholder="+1 555-000-0000" />
            </Field>
            <Field label="Notification Preference">
              <select {...register('notificationPreference')} className={inputCls}>
                <option value="email">Email</option>
                <option value="sms">SMS</option>
                <option value="both">Both</option>
              </select>
            </Field>
          </section>

          {/* Voice & Context */}
          <section className="bg-white rounded-lg border border-gray-200 p-5 space-y-4">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Voice & Context</h2>
            <Field label="Tone">
              <select {...register('tone')} className={inputCls}>
                {TONE_OPTIONS.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </Field>
            <Field label="Products / Services (optional)">
              <textarea {...register('productsServices')} className={inputCls} rows={3} placeholder="Our famous al pastor tacos, fresh horchata..." />
            </Field>
            <Field label="Staff Names (comma-separated, optional)">
              <input {...register('staffNames')} className={inputCls} placeholder="Maria, Carlos, Chef Diego" />
            </Field>
            <Field label="Highlight Facts (one per line, optional)">
              <textarea {...register('highlightFacts')} className={inputCls} rows={3} placeholder="Family-owned since 1985&#10;Fresh ingredients daily" />
            </Field>
            <Field label="Avoid Facts (one per line, optional)">
              <textarea {...register('avoidFacts')} className={inputCls} rows={2} placeholder="Do not mention competitor names&#10;Do not offer discounts" />
            </Field>
            <Field label="Sample Responses (optional)">
              <textarea {...register('sampleResponses')} className={inputCls} rows={4} placeholder="Paste 2-3 example responses the owner has written..." />
            </Field>
          </section>

          {/* Subscription */}
          <section className="bg-white rounded-lg border border-gray-200 p-5 space-y-3">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Subscription Tier</h2>
            <label className="flex items-center gap-3 cursor-pointer">
              <input {...register('subscriptionTier')} type="radio" value="founding" className="text-blue-600" />
              <span className="text-sm"><span className="font-medium">Founding Member</span> — $99/mo (rate locked for life)</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input {...register('subscriptionTier')} type="radio" value="standard" className="text-blue-600" />
              <span className="text-sm"><span className="font-medium">Standard</span> — $149/mo</span>
            </label>
          </section>

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-blue-600 text-white font-medium py-2.5 rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Creating...' : 'Create Business & Start Initial Sync'}
          </button>
        </form>
      </div>
    </div>
  );
}

const inputCls =
  'w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent';

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
```

**Note:** This requires `@hookform/resolvers` for the Zod resolver. Install it:

```bash
pnpm add @hookform/resolvers
```

- [ ] **Step 2: Install @hookform/resolvers**

```bash
pnpm add @hookform/resolvers
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/app/admin/businesses/new/page.tsx package.json pnpm-lock.yaml
git commit -m "feat: build business onboarding form page (react-hook-form + Zod)"
```

---

## Task 4: Business list page

**Files:**
- Rewrite: `src/app/admin/businesses/page.tsx`

- [ ] **Step 1: Rewrite the business list page**

Replace `src/app/admin/businesses/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';

// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)

const PAGE_SIZE = 20;

interface BusinessListData {
  businesses: {
    id: string;
    name: string;
    category: string | null;
    subscriptionStatus: string;
    lastSyncAt: string | null;
    pendingCount: number;
  }[];
  total: number;
  limit: number;
  offset: number;
}

export default function BusinessListPage() {
  const router = useRouter();
  const [page, setPage] = useState(0);

  const { data, isLoading, error } = useQuery<BusinessListData>({
    queryKey: ['admin-businesses', page],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(page * PAGE_SIZE),
      });
      const res = await fetch(`/api/admin/businesses?${params}`);
      if (!res.ok) throw new Error('Failed to fetch businesses');
      return res.json();
    },
  });

  const totalPages = data ? Math.ceil(data.total / PAGE_SIZE) : 0;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Businesses</h1>
          <Link
            href="/admin/businesses/new"
            className="bg-blue-600 text-white font-medium px-4 py-2 rounded-lg text-sm hover:bg-blue-700 transition-colors"
          >
            Add Business
          </Link>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6 text-sm text-red-700">
            Failed to load businesses
          </div>
        )}

        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Name</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Category</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-gray-600">Last Sync</th>
                <th className="text-right px-4 py-3 font-medium text-gray-600">Pending</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">Loading...</td></tr>
              )}
              {data?.businesses.length === 0 && !isLoading && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">No businesses yet</td></tr>
              )}
              {data?.businesses.map((b) => (
                <tr
                  key={b.id}
                  className="hover:bg-gray-50 cursor-pointer"
                  onClick={() => router.push(`/admin/businesses/${b.id}`)}
                >
                  <td className="px-4 py-3 font-medium text-blue-600">{b.name}</td>
                  <td className="px-4 py-3 text-gray-500">{b.category ?? '—'}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={b.subscriptionStatus} />
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">
                    {b.lastSyncAt ? new Date(b.lastSyncAt).toLocaleString() : 'Never'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {b.pendingCount > 0 ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                        {b.pendingCount}
                      </span>
                    ) : (
                      <span className="text-gray-400">0</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <p className="text-sm text-gray-500">
              Showing {(data?.offset ?? 0) + 1}–{Math.min((data?.offset ?? 0) + PAGE_SIZE, data?.total ?? 0)} of {data?.total ?? 0}
            </p>
            <div className="flex gap-2">
              <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="px-3 py-1 rounded border border-gray-300 text-sm disabled:opacity-40">Prev</button>
              <button onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages - 1} className="px-3 py-1 rounded border border-gray-300 text-sm disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>
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
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/app/admin/businesses/page.tsx
git commit -m "feat: build business list page with pagination + Add Business button"
```

---

## Task 5: Upgrade business detail page

**Files:**
- Rewrite: `src/app/admin/businesses/[id]/page.tsx`
- Keep: `src/app/admin/businesses/[id]/manual-post-section.tsx` (unchanged)

The existing page is a server component that queries the DB directly. We need to convert it to a client component that fetches via the new GET API, adds a profile editor and review list, and keeps the existing ManualPostSection.

- [ ] **Step 1: Rewrite the business detail page**

Replace `src/app/admin/businesses/[id]/page.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import ManualPostSection from './manual-post-section';

// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)

interface BusinessDetail {
  id: string;
  name: string;
  category: string | null;
  googlePlaceId: string | null;
  tone: string;
  productsServices: string | null;
  staffNames: string[];
  highlightFacts: string[];
  avoidFacts: string[];
  sampleResponses: string[];
  subscriptionStatus: string;
  subscriptionTier: string;
  ownerName: string;
  ownerEmail: string;
  lastSyncAt: string | null;
}

interface ReviewRow {
  id: string;
  reviewerName: string;
  starRating: number;
  reviewText: string | null;
  reviewDate: string | null;
  detectedLanguage: string | null;
  detectedAt: string;
  responseId: string | null;
  responseStatus: string | null;
  responseText: string | null;
  approvedText: string | null;
  responseVersion: number | null;
}

interface DetailData {
  business: BusinessDetail;
  reviews: ReviewRow[];
}

export default function BusinessDetailPage() {
  const params = useParams<{ id: string }>();
  const businessId = params.id;
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery<DetailData>({
    queryKey: ['admin-business', businessId],
    queryFn: async () => {
      const res = await fetch(`/api/admin/businesses/${businessId}`);
      if (!res.ok) throw new Error('Failed to fetch business');
      return res.json();
    },
  });

  if (isLoading) {
    return <div className="min-h-screen bg-gray-50"><div className="max-w-4xl mx-auto px-4 py-8 text-gray-400">Loading...</div></div>;
  }
  if (error || !data) {
    return <div className="min-h-screen bg-gray-50"><div className="max-w-4xl mx-auto px-4 py-8 text-red-600">Failed to load business</div></div>;
  }

  const { business, reviews } = data;
  const awaitingManualPost = reviews.filter((r) => r.responseStatus === 'awaiting_manual_post');

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto px-4 py-8 space-y-8">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{business.name}</h1>
          <div className="mt-2 flex flex-wrap gap-2 text-sm">
            <StatusBadge status={business.subscriptionStatus} />
            <span className="text-gray-500">{business.subscriptionTier}</span>
            {business.category && <span className="text-gray-500">{business.category}</span>}
            {business.googlePlaceId && (
              <a
                href={`https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(business.googlePlaceId)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline"
              >
                Google Maps
              </a>
            )}
          </div>
        </div>

        {/* Profile Editor */}
        <ProfileEditor business={business} businessId={businessId} onSaved={() => queryClient.invalidateQueries({ queryKey: ['admin-business', businessId] })} />

        {/* Review List */}
        <section>
          <h2 className="text-lg font-semibold text-gray-800 mb-4">Reviews ({reviews.length})</h2>
          {reviews.length === 0 ? (
            <p className="text-sm text-gray-400">No reviews synced yet</p>
          ) : (
            <div className="space-y-3">
              {reviews.map((r) => (
                <div key={r.id} className="bg-white rounded-lg border border-gray-200 p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-yellow-500">{'\u2605'.repeat(r.starRating)}{'\u2606'.repeat(5 - r.starRating)}</span>
                      <span className="font-medium text-gray-700">{r.reviewerName}</span>
                      {r.detectedLanguage && r.detectedLanguage !== 'en' && (
                        <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 text-xs">{r.detectedLanguage}</span>
                      )}
                    </div>
                    {r.responseStatus && <ResponseBadge status={r.responseStatus} />}
                  </div>
                  {r.reviewText && <p className="mt-2 text-sm text-gray-600">{r.reviewText}</p>}
                  {r.responseText && (
                    <div className="mt-2 rounded bg-blue-50 p-3">
                      <p className="text-xs font-medium text-blue-700 mb-1">AI Response (v{r.responseVersion})</p>
                      <p className="text-sm text-gray-800">{r.approvedText ?? r.responseText}</p>
                    </div>
                  )}
                  <p className="mt-2 text-xs text-gray-400">{r.reviewDate ? new Date(r.reviewDate).toLocaleDateString() : 'Unknown date'}</p>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Awaiting Manual Post (existing section) */}
        <section>
          <h2 className="text-lg font-semibold text-gray-800 mb-4">
            Awaiting Manual Post ({awaitingManualPost.length})
          </h2>
          {awaitingManualPost.length === 0 ? (
            <p className="text-sm text-gray-400">No responses awaiting manual posting.</p>
          ) : (
            <div className="space-y-4">
              {awaitingManualPost.map((r) => (
                <ManualPostSection
                  key={r.responseId!}
                  responseId={r.responseId!}
                  businessId={businessId}
                  reviewerName={r.reviewerName}
                  starRating={r.starRating}
                  reviewText={r.reviewText}
                  approvedText={r.approvedText!}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ── Profile Editor ──────────────────────────────────────────────────

function ProfileEditor({
  business,
  businessId,
  onSaved,
}: {
  business: BusinessDetail;
  businessId: string;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: business.name,
    category: business.category ?? '',
    tone: business.tone,
    productsServices: business.productsServices ?? '',
    staffNames: business.staffNames.join(', '),
    highlightFacts: business.highlightFacts.join('\n'),
    avoidFacts: business.avoidFacts.join('\n'),
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/admin/businesses/${businessId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name,
          category: form.category || undefined,
          tone: form.tone,
          productsServices: form.productsServices || undefined,
          staffNames: form.staffNames.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
          highlightFacts: form.highlightFacts.split('\n').map((s) => s.trim()).filter(Boolean),
          avoidFacts: form.avoidFacts.split('\n').map((s) => s.trim()).filter(Boolean),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Failed to save');
      }
    },
    onSuccess: () => {
      setEditing(false);
      onSaved();
    },
  });

  const inputCls = 'w-full px-3 py-1.5 border border-gray-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent';

  if (!editing) {
    return (
      <section className="bg-white rounded-lg border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-gray-800">Business Profile</h2>
          <button onClick={() => setEditing(true)} className="text-sm text-blue-600 hover:underline">Edit</button>
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <Dl label="Name" value={business.name} />
          <Dl label="Category" value={business.category} />
          <Dl label="Tone" value={business.tone} />
          <Dl label="Owner" value={`${business.ownerName} (${business.ownerEmail})`} />
          <Dl label="Staff" value={business.staffNames.join(', ')} />
          <Dl label="Products/Services" value={business.productsServices} />
          <Dl label="Highlight Facts" value={business.highlightFacts.join(', ')} />
          <Dl label="Avoid Facts" value={business.avoidFacts.join(', ')} />
        </dl>
      </section>
    );
  }

  return (
    <section className="bg-white rounded-lg border border-blue-200 p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-800">Edit Profile</h2>
        <button onClick={() => setEditing(false)} className="text-sm text-gray-500 hover:underline">Cancel</button>
      </div>
      <div className="space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Name</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Category</label>
          <input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Tone</label>
          <input value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })} className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Products / Services</label>
          <textarea value={form.productsServices} onChange={(e) => setForm({ ...form, productsServices: e.target.value })} className={inputCls} rows={2} />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Staff Names (comma-separated)</label>
          <input value={form.staffNames} onChange={(e) => setForm({ ...form, staffNames: e.target.value })} className={inputCls} />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Highlight Facts (one per line)</label>
          <textarea value={form.highlightFacts} onChange={(e) => setForm({ ...form, highlightFacts: e.target.value })} className={inputCls} rows={2} />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">Avoid Facts (one per line)</label>
          <textarea value={form.avoidFacts} onChange={(e) => setForm({ ...form, avoidFacts: e.target.value })} className={inputCls} rows={2} />
        </div>
        {mutation.error && <p className="text-sm text-red-600">{mutation.error.message}</p>}
        <button
          onClick={() => mutation.mutate()}
          disabled={mutation.isPending}
          className="bg-blue-600 text-white font-medium px-4 py-1.5 rounded text-sm hover:bg-blue-700 disabled:opacity-50"
        >
          {mutation.isPending ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </section>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function Dl({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-gray-500 text-xs font-medium">{label}</dt>
      <dd className="text-gray-900">{value || '—'}</dd>
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
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function ResponseBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    new: 'bg-gray-100 text-gray-600',
    pending_approval: 'bg-yellow-100 text-yellow-800',
    approved: 'bg-blue-100 text-blue-800',
    edited: 'bg-blue-100 text-blue-800',
    awaiting_manual_post: 'bg-orange-100 text-orange-800',
    posted: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-700',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? 'bg-gray-100 text-gray-600'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add "src/app/admin/businesses/[id]/page.tsx"
git commit -m "feat: upgrade business detail page with profile editor + review list"
```

---

## Task 6: Build + test verification

- [ ] **Step 1: Run TypeScript check**

```bash
npx tsc --noEmit
```

- [ ] **Step 2: Run tests**

```bash
pnpm test
```

Expected: 189/189 tests pass.

- [ ] **Step 3: Run build**

```bash
pnpm build
```

Expected: all pages compile, including new `/admin/businesses/new` route.

- [ ] **Step 4: Commit any build fixes**

```bash
git add -A && git commit -m "fix: build fixes for business onboarding + detail pages"
```

---

## Verification Checklist

- [ ] `/admin/businesses` shows business list table with pagination
- [ ] "Add Business" button navigates to `/admin/businesses/new`
- [ ] Onboarding form validates all fields (try submitting empty)
- [ ] Submitting the form creates a business (visible in list) + triggers initial sync (visible in worker logs)
- [ ] Business redirects to detail page after creation
- [ ] Detail page shows business profile in read mode
- [ ] Clicking "Edit" shows inline form, "Save Changes" persists via PATCH
- [ ] Review list shows all reviews with color-coded response status badges
- [ ] Awaiting Manual Post section still works (copy + mark as posted)
- [ ] Clicking a row in business list navigates to detail page
- [ ] `pnpm build` succeeds
- [ ] `pnpm test` — 189/189 tests pass
