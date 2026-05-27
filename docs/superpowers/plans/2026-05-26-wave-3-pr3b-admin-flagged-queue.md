# Wave 3 PR 3b — Admin Flagged Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins a read-only queue of held (flagged) drafts and three disposition actions — release the draft to the owner (`approved_for_owner_review`, which enqueues the normal notification via the transactional outbox), `dismissed_false_positive`, and `requires_regeneration` — so PR 3a's held drafts can be acted on.

**Architecture:** A guarded admin API (`/api/admin/flagged`) with `GET` (list open flags joined to response/review/business for display) and `POST` (disposition). `GET` is admin-only and read-only; `POST` mirrors the established sensitive-admin-mutation pattern from `grant-extension` (same-origin CSRF check → `requireRole('admin')` → AAL2 → zod → single transaction). On `approved_for_owner_review` the transaction sets the flag status AND inserts a `send_notification` `job_outbox` row (transactional outbox); all three actions write an `account_audit_log` row in-tx. The `/admin/flagged` page mirrors `/admin/jobs` (react-query list + action buttons).

**Tech Stack:** Next.js 16 App Router route handlers, Postgres.js transactions + transactional outbox, Zod, `@supabase/ssr` + AAL2, React + @tanstack/react-query, Vitest.

**Branch:** `wave-3-pr3b-admin-flagged-queue` stacked on `wave-3-pr3a-moderation-backend` (PR #95). PR targets that branch; GitHub auto-retargets as the stack merges down. Depends on PR 3a's `flagged_responses` table (migration 051).

---

## Scope decisions baked into this plan

1. **Disposition semantics (strict to spec):** only `approved_for_owner_review` enqueues the owner `send_notification`. `dismissed_false_positive` and `requires_regeneration` are terminal status-only dispositions — no notification, **no auto-regeneration** (manual/founder follow-up; auto-regen is a later enhancement). So the founder uses **Approve** to release a draft they deem fine, **Dismiss** to close a noisy flag without sending, **Regenerate** to mark a genuinely-bad draft.
2. **Only `open` flags can be dispositioned.** The transaction guards on `status = 'open'` with `FOR UPDATE`; a second disposition (or a race) gets `409`.
3. **GET is read-only admin** (`requireRole('admin')` only, like `/admin/jobs`). **POST is AAL2-gated** (sensitive: releasing a held unsafe draft), matching `grant-extension`.
4. **Cross-tenant admin read uses the tenant-scope allowlist.** The list query joins `responses`/`reviews`/`businesses` unscoped (admin sees all tenants) — exactly like the admin cost-report queries, which are allowlisted. `flagged_responses` is not in the tenant-table inventory, so it isn't scanned.

---

## File Structure

| File | Responsibility | Create / Modify |
|---|---|---|
| `src/app/api/admin/flagged/route.ts` | `GET` (list open flags) + `POST` (disposition) | Create |
| `src/app/api/admin/flagged/__tests__/route.test.ts` | Route tests (GET list, POST 3 actions, guards) | Create |
| `scripts/ci/tenant-scope-allowlist.ts` | Allowlist the cross-tenant admin list query (responses/reviews/businesses) | Modify |
| `src/app/admin/flagged/page.tsx` | Admin flagged-queue UI (list + disposition buttons) | Create |
| `.claude/CLAUDE.md` | Note the admin flagged queue + disposition release path | Modify (controller may apply if subagent is blocked) |

---

## Task 1: List API — `GET /api/admin/flagged`

**Files:**
- Create: `src/app/api/admin/flagged/route.ts`
- Modify: `scripts/ci/tenant-scope-allowlist.ts`
- Test: `src/app/api/admin/flagged/__tests__/route.test.ts`

- [ ] **Step 1: Write the failing GET test**

Create `src/app/api/admin/flagged/__tests__/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireRole, mockSql } = vi.hoisted(() => {
  const mockSql: any = vi.fn(() => Promise.resolve([]));
  return { mockRequireRole: vi.fn(), mockSql };
});

vi.mock('@/lib/db/auth', () => ({
  requireRole: mockRequireRole,
  AuthError: class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
    }
  },
}));

vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => ({ __jsonb: v }) }));

import { GET } from '../route';

function getReq(): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/flagged?limit=20&offset=0');
}

describe('GET /api/admin/flagged', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue({ id: 'admin-1', role: 'admin' });
  });

  it('returns 403 for non-admins', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));
    const res = await GET(getReq());
    expect(res.status).toBe(403);
  });

  it('lists open flags mapped to the display shape', async () => {
    mockSql.mockResolvedValueOnce([
      {
        id: 'flag-1', response_id: 'resp-1', business_id: 'biz-1', account_id: 'acct-1',
        review_id: 'rev-1', source: 'local_regex', reason: 'refund_discount', severity: 'high',
        status: 'open', created_at: '2026-05-26T00:00:00.000Z', response_text: 'Here is a full refund.',
        version: 1, reviewer_name: 'Jane', star_rating: 2, business_name: 'Bella Italia',
      },
    ]);

    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { flagged: Array<Record<string, unknown>> };
    expect(body.flagged).toHaveLength(1);
    expect(body.flagged[0]).toMatchObject({
      id: 'flag-1',
      responseId: 'resp-1',
      businessName: 'Bella Italia',
      severity: 'high',
      reason: 'refund_discount',
      responseText: 'Here is a full refund.',
      reviewerName: 'Jane',
      starRating: 2,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/admin/flagged/__tests__/route.test.ts`
Expected: FAIL — cannot resolve `../route`.

- [ ] **Step 3: Write the route with the GET handler**

Create `src/app/api/admin/flagged/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { AuthError, requireRole } from '@/lib/db/auth';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;

interface FlaggedRow {
  id: string;
  response_id: string;
  business_id: string;
  account_id: string;
  review_id: string;
  source: string;
  reason: string | null;
  severity: string;
  status: string;
  created_at: string;
  response_text: string;
  version: number;
  reviewer_name: string;
  star_rating: number;
  business_name: string;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireRole(request, 'admin');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode, headers: NO_STORE });
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE });
  }

  const rawLimit = request.nextUrl.searchParams.get('limit');
  const rawOffset = request.nextUrl.searchParams.get('offset');
  const limit = Math.min(Math.max(parseInt(rawLimit ?? '20', 10) || 20, 1), 100);
  const offset = Math.max(parseInt(rawOffset ?? '0', 10) || 0, 0);

  // Admin cross-tenant read of the OPEN flagged queue. The joins to tenant
  // tables (responses/reviews/businesses) are intentionally unscoped (admin
  // sees every tenant) and are covered by tenant-scope-allowlist.ts entries.
  const rows = await sql<FlaggedRow[]>`
    SELECT fr.id, fr.response_id, fr.business_id, fr.account_id, fr.review_id,
           fr.source, fr.reason, fr.severity, fr.status, fr.created_at,
           r.response_text, r.version,
           rev.reviewer_name, rev.star_rating,
           b.name AS business_name
    FROM flagged_responses fr
    JOIN responses r ON r.id = fr.response_id
    JOIN reviews rev ON rev.id = fr.review_id
    JOIN businesses b ON b.id = fr.business_id
    WHERE fr.status = 'open'
    ORDER BY fr.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const flagged = rows.map((row) => ({
    id: row.id,
    responseId: row.response_id,
    businessId: row.business_id,
    accountId: row.account_id,
    reviewId: row.review_id,
    source: row.source,
    reason: row.reason,
    severity: row.severity,
    status: row.status,
    createdAt: row.created_at,
    responseText: row.response_text,
    version: row.version,
    reviewerName: row.reviewer_name,
    starRating: row.star_rating,
    businessName: row.business_name,
  }));

  return NextResponse.json({ flagged, limit, offset }, { headers: NO_STORE });
}
```

- [ ] **Step 4: Run the GET test**

Run: `pnpm vitest run src/app/api/admin/flagged/__tests__/route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the tenant-scope allowlist entries for the list query**

The list query reads three tenant tables unscoped (admin view). Run `pnpm ci:tenant-scope` first to confirm it fails with findings for `worker`... no — for `src/app/api/admin/flagged/route.ts` on tables `responses`, `reviews`, `businesses`.

Then, in `scripts/ci/tenant-scope-allowlist.ts`, add three entries (same `sqlSnippet`, one per table). Append them to the array (next to other admin cross-tenant entries is fine; the array order doesn't matter). The `sqlSnippet` MUST equal the query's whitespace-normalized form. Add:

```ts
  {
    file: "src/app/api/admin/flagged/route.ts",
    table: "responses",
    sqlSnippet: "SELECT fr.id, fr.response_id, fr.business_id, fr.account_id, fr.review_id, fr.source, fr.reason, fr.severity, fr.status, fr.created_at, r.response_text, r.version, rev.reviewer_name, rev.star_rating, b.name AS business_name FROM flagged_responses fr JOIN responses r ON r.id = fr.response_id JOIN reviews rev ON rev.id = fr.review_id JOIN businesses b ON b.id = fr.business_id WHERE fr.status = 'open' ORDER BY fr.created_at DESC LIMIT ${limit} OFFSET ${offset}",
    reason: "Admin-only cross-tenant read of the open flagged-response queue (deny-all RLS table joined to its parent rows); the route is gated by requireRole('admin') and proxy /api/admin protection.",
  },
  {
    file: "src/app/api/admin/flagged/route.ts",
    table: "reviews",
    sqlSnippet: "SELECT fr.id, fr.response_id, fr.business_id, fr.account_id, fr.review_id, fr.source, fr.reason, fr.severity, fr.status, fr.created_at, r.response_text, r.version, rev.reviewer_name, rev.star_rating, b.name AS business_name FROM flagged_responses fr JOIN responses r ON r.id = fr.response_id JOIN reviews rev ON rev.id = fr.review_id JOIN businesses b ON b.id = fr.business_id WHERE fr.status = 'open' ORDER BY fr.created_at DESC LIMIT ${limit} OFFSET ${offset}",
    reason: "Admin-only cross-tenant read of the open flagged-response queue (deny-all RLS table joined to its parent rows); the route is gated by requireRole('admin') and proxy /api/admin protection.",
  },
  {
    file: "src/app/api/admin/flagged/route.ts",
    table: "businesses",
    sqlSnippet: "SELECT fr.id, fr.response_id, fr.business_id, fr.account_id, fr.review_id, fr.source, fr.reason, fr.severity, fr.status, fr.created_at, r.response_text, r.version, rev.reviewer_name, rev.star_rating, b.name AS business_name FROM flagged_responses fr JOIN responses r ON r.id = fr.response_id JOIN reviews rev ON rev.id = fr.review_id JOIN businesses b ON b.id = fr.business_id WHERE fr.status = 'open' ORDER BY fr.created_at DESC LIMIT ${limit} OFFSET ${offset}",
    reason: "Admin-only cross-tenant read of the open flagged-response queue (deny-all RLS table joined to its parent rows); the route is gated by requireRole('admin') and proxy /api/admin protection.",
  },
```

- [ ] **Step 6: Verify the audit passes**

Run: `pnpm ci:tenant-scope`
Expected: `tenant-scope-audit: passed`. If it still fails for one of these tables, the `sqlSnippet` does not byte-match the normalized query — copy the exact failing statement's normalized form (collapse all whitespace runs to single spaces, strip comments) and align the snippet. If it reports an UNUSED allowlist entry, the query text drifted from the snippet — align them. Do NOT add account_id/business_id scoping to the query (the admin view is intentionally cross-tenant).

- [ ] **Step 7: Commit**

```bash
git add src/app/api/admin/flagged/route.ts src/app/api/admin/flagged/__tests__/route.test.ts scripts/ci/tenant-scope-allowlist.ts
git commit -m "feat(trust-safety): admin flagged-queue list API

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Disposition API — `POST /api/admin/flagged`

**Files:**
- Modify: `src/app/api/admin/flagged/route.ts`
- Modify: `src/app/api/admin/flagged/__tests__/route.test.ts`

- [ ] **Step 1: Add the POST tests first**

In `src/app/api/admin/flagged/__tests__/route.test.ts`:

(1a) Extend the hoisted mocks. Replace the `vi.hoisted(...)` block at the top with:
```ts
const {
  mockRequireRole,
  mockRequireCurrentAal2FromSupabase,
  mockWriteAccountAuditLog,
  mockSql,
  mockTx,
  txResults,
  txCalls,
} = vi.hoisted(() => {
  const txCalls: { text: string; values: unknown[] }[] = [];
  const txResults: unknown[] = [];
  const mockTx = vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
    txCalls.push({ text: strings.join('?'), values });
    return Promise.resolve(txResults.shift() ?? Object.assign([], { count: 1 }));
  });
  const mockSql: any = vi.fn(() => Promise.resolve([]));
  mockSql.begin = vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx));
  return {
    mockRequireRole: vi.fn(),
    mockRequireCurrentAal2FromSupabase: vi.fn(),
    mockWriteAccountAuditLog: vi.fn(),
    mockSql,
    mockTx,
    txResults,
    txCalls,
  };
});
```

(1b) Add these mocks next to the existing ones:
```ts
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { mfa: {} } })),
}));
vi.mock('@/lib/auth/mfa', () => ({
  requireCurrentAal2FromSupabase: mockRequireCurrentAal2FromSupabase,
}));
vi.mock('@/lib/audit/log', () => ({
  writeAccountAuditLog: mockWriteAccountAuditLog,
}));
```
And set the env + import `POST`:
```ts
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
```
Change the route import line to also import `POST`:
```ts
import { GET, POST } from '../route';
```

(1c) Add a `postReq` helper and a POST describe block at the end of the file:
```ts
function postReq(body: unknown): NextRequest {
  return new NextRequest('https://app.example.com/api/admin/flagged', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://app.example.com' },
    body: JSON.stringify(body),
  });
}

const FLAG_ID = '33333333-3333-4333-8333-333333333333';

describe('POST /api/admin/flagged (disposition)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txCalls.length = 0;
    txResults.length = 0;
    mockRequireRole.mockResolvedValue({ id: 'admin-1', role: 'admin' });
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
  });

  it('rejects a non-same-origin request with 403', async () => {
    const bad = new NextRequest('https://app.example.com/api/admin/flagged', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example.com' },
      body: JSON.stringify({ flaggedId: FLAG_ID, action: 'approved_for_owner_review' }),
    });
    const res = await POST(bad);
    expect(res.status).toBe(403);
  });

  it('requires AAL2', async () => {
    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({ ok: false, reason: 'aal2_required' });
    const res = await POST(postReq({ flaggedId: FLAG_ID, action: 'approved_for_owner_review' }));
    expect(res.status).toBe(403);
  });

  it('rejects an unknown action with 400', async () => {
    const res = await POST(postReq({ flaggedId: FLAG_ID, action: 'banana' }));
    expect(res.status).toBe(400);
  });

  it('approve: updates status and enqueues send_notification, returns ok', async () => {
    // First tx call (SELECT ... FOR UPDATE) returns the open flag row.
    txResults.push([{ id: FLAG_ID, response_id: 'resp-1', business_id: 'biz-1', account_id: 'acct-1' }]);
    const res = await POST(postReq({ flaggedId: FLAG_ID, action: 'approved_for_owner_review' }));
    expect(res.status).toBe(200);

    // A send_notification outbox payload was inserted in-tx.
    const notifyPayloads = txCalls
      .flatMap((c) => c.values)
      .filter(
        (v): v is { __jsonb: Record<string, unknown> } =>
          !!v && typeof v === 'object' && '__jsonb' in (v as Record<string, unknown>),
      )
      .map((v) => v.__jsonb)
      .filter((p) => 'response_id' in p && 'business_id' in p);
    expect(notifyPayloads).toHaveLength(1);
    expect(notifyPayloads[0]).toMatchObject({ response_id: 'resp-1', business_id: 'biz-1' });
    expect(mockWriteAccountAuditLog).toHaveBeenCalledOnce();
  });

  it('dismiss: updates status, does NOT enqueue a notification', async () => {
    txResults.push([{ id: FLAG_ID, response_id: 'resp-1', business_id: 'biz-1', account_id: 'acct-1' }]);
    const res = await POST(postReq({ flaggedId: FLAG_ID, action: 'dismissed_false_positive' }));
    expect(res.status).toBe(200);
    const notifyPayloads = txCalls
      .flatMap((c) => c.values)
      .filter(
        (v): v is { __jsonb: Record<string, unknown> } =>
          !!v && typeof v === 'object' && '__jsonb' in (v as Record<string, unknown>),
      )
      .map((v) => v.__jsonb)
      .filter((p) => 'response_id' in p && 'business_id' in p);
    expect(notifyPayloads).toHaveLength(0);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledOnce();
  });

  it('returns 409 when the flag is not open (already dispositioned)', async () => {
    txResults.push([]); // SELECT ... FOR UPDATE finds no open row
    const res = await POST(postReq({ flaggedId: FLAG_ID, action: 'approved_for_owner_review' }));
    expect(res.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run to verify the POST tests fail**

Run: `pnpm vitest run src/app/api/admin/flagged/__tests__/route.test.ts`
Expected: the POST tests FAIL (`POST` is not exported yet).

- [ ] **Step 3: Add the POST handler to the route**

In `src/app/api/admin/flagged/route.ts`, add these imports to the existing import block at the top:
```ts
import { createServerClient } from '@supabase/ssr';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { jsonb } from '@/lib/db/server';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { requireCurrentAal2FromSupabase, type SupabaseMfaAalClient } from '@/lib/auth/mfa';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import type { SendNotificationPayload } from '@/lib/shared/worker-types';
```
(Keep the existing `import { sql } from '@/lib/db/server';` — or merge it into `import { sql, jsonb } from '@/lib/db/server';` to avoid a duplicate import.)

Then append the POST handler + helpers to the end of the file:
```ts
const DispositionSchema = z.object({
  flaggedId: z.string().uuid(),
  action: z.enum([
    'approved_for_owner_review',
    'dismissed_false_positive',
    'requires_regeneration',
  ]),
});

class DispositionError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
    this.name = 'DispositionError';
  }
}

interface OpenFlagRow {
  id: string;
  response_id: string;
  business_id: string;
  account_id: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
    }
    return dispositionErrorResponse(err);
  }

  let admin;
  try {
    admin = await requireRole(request, 'admin');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode, headers: NO_STORE });
    }
    return dispositionErrorResponse(err);
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll() {
          // Route handlers cannot mutate request cookies; proxy handles refresh.
        },
      },
    },
  ) as SupabaseMfaAalClient;

  const aal = await requireCurrentAal2FromSupabase(supabase);
  if (!aal.ok) {
    return NextResponse.json({ error: aal.reason }, { status: 403, headers: NO_STORE });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
  }

  const parsed = DispositionSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid_request' },
      { status: 400, headers: NO_STORE },
    );
  }

  const { flaggedId, action } = parsed.data;

  try {
    await sql.begin(async (tx) => {
      const rows = await tx<OpenFlagRow[]>`
        SELECT id, response_id, business_id, account_id
        FROM flagged_responses
        WHERE id = ${flaggedId}::uuid AND status = 'open'
        FOR UPDATE
      `;
      const flag = rows[0];
      if (!flag) {
        throw new DispositionError(409, 'not_open');
      }

      await tx`
        UPDATE flagged_responses
        SET status = ${action},
            reviewed_by_user_id = ${admin.id}::uuid,
            reviewed_at = NOW(),
            updated_at = NOW()
        WHERE id = ${flaggedId}::uuid AND status = 'open'
      `;

      // Only an explicit approval releases the held draft to the owner — via the
      // transactional outbox, atomic with the status change. Dismiss / regenerate
      // are terminal status-only dispositions (no notification).
      if (action === 'approved_for_owner_review') {
        const payload: SendNotificationPayload = {
          response_id: flag.response_id,
          business_id: flag.business_id,
        };
        await tx`
          INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
          VALUES (
            ${uuidv7()}, 'send_notification', 'response', ${flag.response_id},
            ${jsonb(payload)}, 'pending'
          )
        `;
      }

      await writeAccountAuditLog(
        {
          accountId: flag.account_id,
          actorUserId: admin.id,
          eventType: 'flagged_response_dispositioned',
          entityType: 'flagged_response',
          entityId: flaggedId,
          payload: { action, response_id: flag.response_id },
        },
        tx,
      );
    });
  } catch (err) {
    if (err instanceof DispositionError) {
      return NextResponse.json({ error: err.code }, { status: err.status, headers: NO_STORE });
    }
    return dispositionErrorResponse(err);
  }

  return NextResponse.json({ ok: true, action }, { headers: NO_STORE });
}

function dispositionErrorResponse(error: unknown): NextResponse {
  console.error('[api/admin/flagged] disposition failed:', error);
  return NextResponse.json({ error: 'internal_error' }, { status: 500, headers: NO_STORE });
}
```

- [ ] **Step 4: Run the route tests + typecheck**

Run: `pnpm vitest run src/app/api/admin/flagged/__tests__/route.test.ts && pnpm typecheck`
Expected: PASS (all GET + POST tests). Typecheck clean.
(If typecheck errors only on a stale `.next/types/validator.ts` health-route reference, `rm -rf .next` and re-run.)

- [ ] **Step 5: Run the tenant-scope audit again**

Run: `pnpm ci:tenant-scope`
Expected: `tenant-scope-audit: passed`. (The disposition statements touch `flagged_responses` — not in the tenant-table inventory — and `job_outbox` (INSERT, not scanned), so no new allowlist entry is needed beyond Task 1's.)

- [ ] **Step 6: Commit**

```bash
git add src/app/api/admin/flagged/route.ts src/app/api/admin/flagged/__tests__/route.test.ts
git commit -m "feat(trust-safety): admin flagged-response disposition (approve releases via outbox)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Admin flagged-queue page

**Files:**
- Create: `src/app/admin/flagged/page.tsx`

> `/admin/*` is admin-gated by `src/proxy.ts`. This mirrors `/admin/jobs/page.tsx` (react-query list + actions). No test (consistent with the existing admin pages, which have no page-level tests); verified by `pnpm build` + typecheck.

- [ ] **Step 1: Create the page**

Create `src/app/admin/flagged/page.tsx`:

```tsx
'use client';

// Auth: Supabase session checked by src/proxy.ts (admin role required).

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

interface FlaggedItem {
  id: string;
  responseId: string;
  businessId: string;
  accountId: string;
  reviewId: string;
  source: string;
  reason: string | null;
  severity: string;
  status: string;
  createdAt: string;
  responseText: string;
  version: number;
  reviewerName: string;
  starRating: number;
  businessName: string;
}

type DispositionAction =
  | 'approved_for_owner_review'
  | 'dismissed_false_positive'
  | 'requires_regeneration';

const ACTION_LABELS: Record<DispositionAction, string> = {
  approved_for_owner_review: 'Approve (notify owner)',
  dismissed_false_positive: 'Dismiss (false positive)',
  requires_regeneration: 'Needs regeneration',
};

export default function FlaggedQueuePage() {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery<{ flagged: FlaggedItem[] }>({
    queryKey: ['admin-flagged'],
    queryFn: async () => {
      const res = await fetch('/api/admin/flagged?limit=50&offset=0');
      if (!res.ok) throw new Error(`Failed to fetch flagged queue: ${res.status}`);
      return res.json() as Promise<{ flagged: FlaggedItem[] }>;
    },
    refetchInterval: 30_000,
  });

  const disposition = useMutation({
    mutationFn: async (vars: { flaggedId: string; action: DispositionAction }) => {
      const res = await fetch('/api/admin/flagged', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(vars),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Disposition failed: ${res.status}`);
      }
      return res.json() as Promise<{ ok: true }>;
    },
    onSuccess: () => {
      setActionError(null);
      void queryClient.invalidateQueries({ queryKey: ['admin-flagged'] });
    },
    onError: (err: unknown) => {
      setActionError(err instanceof Error ? err.message : 'Disposition failed');
    },
  });

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900">Flagged Responses</h1>
        <p className="mt-1 text-sm text-gray-500">
          High-confidence unsafe drafts held out of the owner approval path. Approve to release
          to the owner, dismiss a false positive, or mark for regeneration.
        </p>

        {actionError && (
          <p className="mt-4 rounded border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {actionError}
          </p>
        )}

        {isLoading && <p className="mt-6 text-gray-500">Loading...</p>}
        {isError && <p className="mt-6 text-red-600">Failed to load flagged queue.</p>}

        {data && data.flagged.length === 0 && (
          <p className="mt-6 rounded-lg border border-gray-200 bg-white px-4 py-8 text-center text-gray-400">
            No open flagged responses.
          </p>
        )}

        <div className="mt-6 space-y-4">
          {data?.flagged.map((item) => (
            <div key={item.id} className="rounded-lg border border-gray-200 bg-white p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded px-2 py-0.5 text-xs font-semibold ${
                    item.severity === 'high'
                      ? 'bg-red-100 text-red-800'
                      : 'bg-yellow-100 text-yellow-800'
                  }`}
                >
                  {item.severity}
                </span>
                <span className="text-sm font-medium text-gray-800">{item.businessName}</span>
                <span className="text-sm text-gray-500">
                  {item.starRating}★ from {item.reviewerName}
                </span>
                <span className="ml-auto text-xs text-gray-400">
                  {new Date(item.createdAt).toLocaleString()}
                </span>
              </div>

              <p className="mt-2 text-xs text-gray-500">
                Reason: <span className="font-medium text-gray-700">{item.reason ?? '—'}</span>{' '}
                · Source: {item.source} · Draft v{item.version}
              </p>

              <p className="mt-3 whitespace-pre-wrap rounded bg-gray-50 p-3 text-sm text-gray-800">
                {item.responseText}
              </p>

              <div className="mt-4 flex flex-wrap gap-2">
                {(Object.keys(ACTION_LABELS) as DispositionAction[]).map((action) => (
                  <button
                    key={action}
                    onClick={() => disposition.mutate({ flaggedId: item.id, action })}
                    disabled={disposition.isPending}
                    className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {ACTION_LABELS[action]}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + build**

Run: `pnpm typecheck`
Expected: clean. (No page-level unit test — consistent with other `/admin/*` pages; the build in Task 4 compiles it.)

- [ ] **Step 3: Commit**

```bash
git add src/app/admin/flagged/page.tsx
git commit -m "feat(trust-safety): admin flagged-queue page with disposition actions

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Docs + full verification

**Files:**
- Modify: `.claude/CLAUDE.md`

> If the subagent is blocked editing `.claude/CLAUDE.md` (self-modification guard), report it and the controller will apply the edit; still run the gate.

- [ ] **Step 1: Extend the moderation-hold note in `.claude/CLAUDE.md`**

Find the bullet that begins `- **High-confidence unsafe drafts are held, not notified.**` (added in PR 3a) and, within it, find the sentence ending `until an admin dispositions it`. Update that clause to reference the now-built admin queue. Specifically, replace:
```
  `pending_approval` — no owner notification until an admin dispositions it
  (PR 3b). Moderation metadata is recorded on `api_costs` (`moderation_*`,
```
with:
```
  `pending_approval` — no owner notification until an admin dispositions it at
  `/admin/flagged` (`approved_for_owner_review` re-enqueues the owner
  notification via the transactional outbox; dismiss/regenerate are terminal).
  Moderation metadata is recorded on `api_costs` (`moderation_*`,
```

- [ ] **Step 2: Run the full quality gate**

```bash
pnpm vitest run src/app/api/admin/flagged/__tests__/route.test.ts
pnpm ci:tenant-scope
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expectations:
- The flagged route suite passes.
- `pnpm ci:tenant-scope` passes (the three list-query allowlist entries from Task 1 cover the only tenant-table reads).
- `pnpm lint` clean except the known pre-existing `<img>` warning in `SecurityClient.tsx`.
- `pnpm typecheck` clean.
- `pnpm test` full unit suite green.
- `pnpm build` succeeds (compiles the new page + route).

If any command genuinely fails, report the actual output and whether it stems from this PR.

- [ ] **Step 3: Commit**

```bash
git add .claude/CLAUDE.md
git commit -m "docs(trust-safety): note admin flagged queue + disposition release path

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage (Sub-Spec 10, PR 3b slice):**

| Spec item | Task |
|---|---|
| `/admin/flagged` page | Task 3 |
| Show response excerpt, review metadata, business/account, reason, severity, model/prompt version, created time | Task 1 (GET joins) + Task 3 (renders severity, business, reviewer, stars, reason, source, version, draft text, created) |
| Disposition actions `approved_for_owner_review` / `dismissed_false_positive` / `requires_regeneration` | Task 2 |
| `approved_for_owner_review` enqueues the owner notification via the transactional outbox after disposition recorded | Task 2 (in-tx `job_outbox` insert) |
| Actions write audit rows where practical | Task 2 (`writeAccountAuditLog` in-tx, all actions) |
| Admin-only; owners don't see the queue | Task 1/2 (`requireRole('admin')` + proxy gate; `flagged_responses` deny-all RLS from PR 3a) |

**Deferred (honored):** owner-facing override/appeal (spec marks it later); auto-regeneration on `requires_regeneration` (status-only this slice); model/prompt-version columns shown are limited to what the list query selects (version + reason/source) — model/prompt_version live on `api_costs` and can be added to the join later if the founder wants them surfaced.

**2. Placeholder scan:** Every code step has complete code; commands list expected output. The allowlist `sqlSnippet` is given in full normalized form, with an explicit "align if it doesn't byte-match" instruction (Step 6) — not a placeholder, a known-fragile exact-match the audit verifies.

**3. Type consistency:** `FlaggedRow` (route GET) → mapped `flagged` items consumed by the page's `FlaggedItem` (same camelCase fields). `DispositionAction` enum identical in the route's `DispositionSchema` (Task 2) and the page (Task 3). `SendNotificationPayload` ({response_id, business_id}) matches the worker-types definition and the outbox consumer. The disposition `status` values written match the migration 051 `status` CHECK set. `writeAccountAuditLog` input matches `src/lib/audit/log.ts`.
</content>
</invoke>
