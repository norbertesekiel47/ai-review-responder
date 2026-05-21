# Sprint 5B Prompt 19c — Owner Settings + Dashboard Approval Actions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the owner settings page (business profile editing + notification preferences with weekly/monthly opt-out) and add session-authenticated approval actions to the owner dashboard, without modifying the existing token-based approval routes.

**Architecture:** The owner settings page is a standalone form at `/settings` that PUTs to `/api/settings`. Dashboard approval actions require refactoring `ApprovalService` to extract token-agnostic core mutations (`approveCore`, `editCore`, `regenerateCore`) and a new `insertAuditLogSession` function for owner-session auth. New dashboard API routes (`/api/dashboard/reviews/[reviewId]/approve|edit|regenerate`) call the core mutations after verifying owner auth + business ownership. The existing token-based routes remain untouched. The `WeeklySummaryScheduler` and `MonthlyImpactScheduler` are updated to respect the new `weekly_summary_enabled` and `monthly_impact_enabled` columns.

**Tech Stack:** Next.js App Router, Supabase Auth (via `@supabase/ssr`), Postgres.js (`sql`), Zod, react-hook-form, Vitest.

**Pre-requisite:** Migration `014_retention_expansion.sql` must be applied (adds `weekly_summary_enabled`, `monthly_impact_enabled` to businesses, `actor_user_id`/`auth_method` to `approval_audit_log`, drops NOT NULL on `token_hash`).

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/lib/approval/service.ts` | Extract core mutations + add session-audit helper |
| Create | `src/app/api/settings/route.ts` | PUT — owner settings update |
| Create | `src/app/api/settings/__tests__/route.test.ts` | Settings API tests |
| Create | `src/app/(authenticated)/settings/page.tsx` | Owner settings page (replace placeholder) |
| Create | `src/app/api/dashboard/reviews/[reviewId]/approve/route.ts` | POST — session-auth approve |
| Create | `src/app/api/dashboard/reviews/[reviewId]/edit/route.ts` | POST — session-auth edit |
| Create | `src/app/api/dashboard/reviews/[reviewId]/regenerate/route.ts` | POST — session-auth regenerate |
| Create | `src/app/api/dashboard/reviews/__tests__/actions.test.ts` | Dashboard approval action tests |
| Modify | `worker/jobs/WeeklySummaryScheduler.ts` | Respect `weekly_summary_enabled` |
| Modify | `worker/jobs/MonthlyImpactScheduler.ts` | Respect `monthly_impact_enabled` |
| Modify | `src/components/OwnerNav.tsx` | Add Settings link |
| Modify | `src/app/api/dashboard/route.ts` | Return notification prefs + opt-out flags |
| Modify | `src/middleware.ts` | Add `/api/settings` to owner protection |

---

## Task 1: Refactor ApprovalService — extract core mutations

**Files:**
- Modify: `src/lib/approval/service.ts`

The existing `approve()`, `edit()`, `regenerate()` methods are tightly coupled to `ApprovalLink` and `AuditContext` (which requires `tokenHash`). The dashboard actions have no token — they use session auth. We need to extract the core response mutation logic into token-agnostic helpers.

- [ ] **Step 1: Add SessionAuditContext interface**

At the top of `src/lib/approval/service.ts`, after the existing `AuditContext` interface, add:

```typescript
/** Audit context for session-authenticated dashboard actions (no token). */
export interface SessionAuditContext {
  actorUserId: string;
  ipAddress: string | null;
}
```

- [ ] **Step 2: Add insertAuditLogSession helper**

After the existing `insertAuditLog` function, add:

```typescript
async function insertAuditLogSession(
  tx: TxClient,
  responseId: string,
  businessId: string,
  action: string,
  audit: SessionAuditContext,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await tx`
    INSERT INTO approval_audit_log (id, response_id, business_id, token_hash, device_cookie_hash, action, ip_address, metadata, actor_user_id, auth_method)
    VALUES (
      ${uuidv7()},
      ${responseId},
      ${businessId},
      ${null},
      ${null},
      ${action},
      ${audit.ipAddress},
      ${JSON.stringify(metadata ?? {})}::jsonb,
      ${audit.actorUserId},
      'owner_session'
    )
  `;
}
```

- [ ] **Step 3: Add approveBySession export**

After the existing `approve()` function, add:

```typescript
/**
 * Session-authenticated approve. Called from dashboard routes after owner auth.
 * Uses the same core mutation logic but writes owner_session audit records.
 */
export async function approveBySession(
  tx: TxClient,
  responseId: string,
  businessId: string,
  audit: SessionAuditContext,
): Promise<void> {
  await lockPendingResponse(tx, responseId);

  await tx`
    UPDATE responses
    SET status = 'approved', approved_at = NOW(), approved_text = response_text
    WHERE id = ${responseId}
  `;

  const payload: PublishResponsePayload = { response_id: responseId, business_id: businessId };
  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (${uuidv7()}, 'publish_response', 'response', ${responseId}, ${JSON.stringify(payload)}::jsonb, 'pending')
  `;

  await insertAuditLogSession(tx, responseId, businessId, 'approve', audit);
}
```

- [ ] **Step 4: Add editBySession export**

```typescript
/**
 * Session-authenticated edit + approve.
 */
export async function editBySession(
  tx: TxClient,
  responseId: string,
  businessId: string,
  editedText: string,
  audit: SessionAuditContext,
): Promise<void> {
  const resp = await lockPendingResponse(tx, responseId);
  const editDist = distance(resp.original_draft_text, editedText);

  await tx`
    UPDATE responses
    SET status = 'edited', approved_at = NOW(), edited_text = ${editedText},
        approved_text = ${editedText}, edit_distance = ${editDist}
    WHERE id = ${responseId}
  `;

  const payload: PublishResponsePayload = { response_id: responseId, business_id: businessId };
  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (${uuidv7()}, 'publish_response', 'response', ${responseId}, ${JSON.stringify(payload)}::jsonb, 'pending')
  `;

  await insertAuditLogSession(tx, responseId, businessId, 'edit', audit, { edit_distance: editDist });
}
```

- [ ] **Step 5: Add regenerateBySession export**

```typescript
/**
 * Session-authenticated regenerate.
 */
export async function regenerateBySession(
  tx: TxClient,
  responseId: string,
  businessId: string,
  audit: SessionAuditContext,
): Promise<void> {
  const resp = await lockPendingResponse(tx, responseId);

  await tx`
    UPDATE responses SET status = 'superseded' WHERE id = ${responseId}
  `;

  const payload: GenerateResponsePayload = {
    review_id: resp.review_id,
    business_id: businessId,
    version: resp.version + 1,
  };
  await tx`
    INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
    VALUES (${uuidv7()}, 'generate_response', 'review', ${resp.review_id}, ${JSON.stringify(payload)}::jsonb, 'pending')
  `;

  await insertAuditLogSession(tx, responseId, businessId, 'regenerate', audit);
}
```

- [ ] **Step 6: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Run existing approval tests to verify no regressions**

Run: `npx vitest run src/lib/approval/`
Expected: all existing tests PASS (the token-based functions are untouched)

- [ ] **Step 8: Commit**

```bash
git add src/lib/approval/service.ts
git commit -m "feat(19c-5b): extract session-authenticated approval methods from ApprovalService"
```

---

## Task 2: Dashboard approval API routes

**Files:**
- Create: `src/app/api/dashboard/reviews/[reviewId]/approve/route.ts`
- Create: `src/app/api/dashboard/reviews/[reviewId]/edit/route.ts`
- Create: `src/app/api/dashboard/reviews/[reviewId]/regenerate/route.ts`
- Create: `src/app/api/dashboard/reviews/__tests__/actions.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/app/api/dashboard/reviews/__tests__/actions.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireRole, mockSql, mockApproveBySession, mockEditBySession, mockRegenerateBySession } = vi.hoisted(() => {
  const mockSql: any = Object.assign(
    vi.fn().mockResolvedValue([]),
    { begin: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockSql)) },
  );
  return {
    mockRequireRole: vi.fn(),
    mockSql,
    mockApproveBySession: vi.fn().mockResolvedValue(undefined),
    mockEditBySession: vi.fn().mockResolvedValue(undefined),
    mockRegenerateBySession: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
    }
  }
  return { requireRole: (...args: unknown[]) => mockRequireRole(...args), AuthError };
});

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));

vi.mock('@/lib/approval/service', () => ({
  approveBySession: (...args: unknown[]) => mockApproveBySession(...args),
  editBySession: (...args: unknown[]) => mockEditBySession(...args),
  regenerateBySession: (...args: unknown[]) => mockRegenerateBySession(...args),
  ResponseNotPendingError: class extends Error { constructor(s: string) { super(s); } },
}));

const ownerUser = { id: 'user-1', name: 'Owner', email: 'o@test.com', role: 'owner', businessId: 'biz-1' };

function makeRequest(url: string, body?: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { 'Content-Type': 'application/json' } : {},
  });
}

const makeParams = (reviewId: string) => Promise.resolve({ reviewId });

describe('Dashboard approval actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ownerUser);
    // Mock: response belongs to owner's business
    mockSql.mockResolvedValue([{ id: 'resp-1', business_id: 'biz-1', status: 'pending_approval' }]);
  });

  describe('POST /api/dashboard/reviews/[reviewId]/approve', () => {
    it('approves when owner owns the review', async () => {
      const { POST } = await import('../[reviewId]/approve/route');
      const res = await POST(makeRequest('http://localhost/api/dashboard/reviews/rev-1/approve'), { params: makeParams('rev-1') });
      expect(res.status).toBe(200);
      expect(mockApproveBySession).toHaveBeenCalled();
    });

    it('returns 404 when response not found', async () => {
      mockSql.mockResolvedValueOnce([]); // no response
      const { POST } = await import('../[reviewId]/approve/route');
      const res = await POST(makeRequest('http://localhost/api/dashboard/reviews/rev-1/approve'), { params: makeParams('rev-1') });
      expect(res.status).toBe(404);
    });

    it('returns 403 when response belongs to different business', async () => {
      mockSql.mockResolvedValueOnce([{ id: 'resp-1', business_id: 'biz-other', status: 'pending_approval' }]);
      const { POST } = await import('../[reviewId]/approve/route');
      const res = await POST(makeRequest('http://localhost/api/dashboard/reviews/rev-1/approve'), { params: makeParams('rev-1') });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/dashboard/reviews/[reviewId]/edit', () => {
    it('edits when valid text provided', async () => {
      const { POST } = await import('../[reviewId]/edit/route');
      const res = await POST(makeRequest('http://localhost/api/dashboard/reviews/rev-1/edit', { editedText: 'Thanks!' }), { params: makeParams('rev-1') });
      expect(res.status).toBe(200);
      expect(mockEditBySession).toHaveBeenCalledWith(expect.anything(), 'resp-1', 'biz-1', 'Thanks!', expect.objectContaining({ actorUserId: 'user-1' }));
    });

    it('returns 400 when editedText is empty', async () => {
      const { POST } = await import('../[reviewId]/edit/route');
      const res = await POST(makeRequest('http://localhost/api/dashboard/reviews/rev-1/edit', { editedText: '' }), { params: makeParams('rev-1') });
      expect(res.status).toBe(400);
    });

    it('returns 400 when editedText exceeds 2000 chars', async () => {
      const { POST } = await import('../[reviewId]/edit/route');
      const res = await POST(makeRequest('http://localhost/api/dashboard/reviews/rev-1/edit', { editedText: 'x'.repeat(2001) }), { params: makeParams('rev-1') });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/dashboard/reviews/[reviewId]/regenerate', () => {
    it('regenerates response', async () => {
      const { POST } = await import('../[reviewId]/regenerate/route');
      const res = await POST(makeRequest('http://localhost/api/dashboard/reviews/rev-1/regenerate'), { params: makeParams('rev-1') });
      expect(res.status).toBe(200);
      expect(mockRegenerateBySession).toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/api/dashboard/reviews/__tests__/actions.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Create the approve route**

Create `src/app/api/dashboard/reviews/[reviewId]/approve/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { approveBySession, ResponseNotPendingError } from '@/lib/approval/service';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireRole(request, 'owner');
    const { reviewId } = await params;

    if (!user.businessId) {
      return NextResponse.json({ error: 'No business linked' }, { status: 403, headers: NO_STORE_HEADERS });
    }

    // Find the latest non-superseded response for this review
    const [response] = await sql<{ id: string; business_id: string; status: string }[]>`
      SELECT r.id, r.business_id, r.status
      FROM responses r
      JOIN reviews rv ON rv.id = r.review_id
      WHERE rv.id = ${reviewId} AND r.status NOT IN ('superseded', 'failed')
      ORDER BY r.version DESC LIMIT 1
    `;

    if (!response) {
      return NextResponse.json({ error: 'Response not found' }, { status: 404, headers: NO_STORE_HEADERS });
    }

    if (response.business_id !== user.businessId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: NO_STORE_HEADERS });
    }

    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

    await sql.begin(async (tx) => {
      await approveBySession(tx, response.id, response.business_id, {
        actorUserId: user.id,
        ipAddress: ip,
      });
    });

    return NextResponse.json(
      { success: true, message: "Response approved! We'll post it to Google shortly." },
      { headers: NO_STORE_HEADERS },
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode, headers: NO_STORE_HEADERS });
    }
    if (err instanceof ResponseNotPendingError) {
      return NextResponse.json({ error: 'Response is no longer pending approval' }, { status: 409, headers: NO_STORE_HEADERS });
    }
    console.error('[dashboard/approve] Failed:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
```

- [ ] **Step 4: Create the edit route**

Create `src/app/api/dashboard/reviews/[reviewId]/edit/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { editBySession, ResponseNotPendingError } from '@/lib/approval/service';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

const MAX_EDIT_LENGTH = 2000;

const EditSchema = z.object({
  editedText: z.string().trim().min(1, 'Response text cannot be empty').max(MAX_EDIT_LENGTH, `Response text cannot exceed ${MAX_EDIT_LENGTH} characters`),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireRole(request, 'owner');
    const { reviewId } = await params;

    if (!user.businessId) {
      return NextResponse.json({ error: 'No business linked' }, { status: 403, headers: NO_STORE_HEADERS });
    }

    const body = await request.json();
    const parsed = EditSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const [response] = await sql<{ id: string; business_id: string; status: string }[]>`
      SELECT r.id, r.business_id, r.status
      FROM responses r
      JOIN reviews rv ON rv.id = r.review_id
      WHERE rv.id = ${reviewId} AND r.status NOT IN ('superseded', 'failed')
      ORDER BY r.version DESC LIMIT 1
    `;

    if (!response) {
      return NextResponse.json({ error: 'Response not found' }, { status: 404, headers: NO_STORE_HEADERS });
    }

    if (response.business_id !== user.businessId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: NO_STORE_HEADERS });
    }

    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

    await sql.begin(async (tx) => {
      await editBySession(tx, response.id, response.business_id, parsed.data.editedText, {
        actorUserId: user.id,
        ipAddress: ip,
      });
    });

    return NextResponse.json(
      { success: true, message: "Response approved with your edits! We'll post it to Google shortly." },
      { headers: NO_STORE_HEADERS },
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode, headers: NO_STORE_HEADERS });
    }
    if (err instanceof ResponseNotPendingError) {
      return NextResponse.json({ error: 'Response is no longer pending approval' }, { status: 409, headers: NO_STORE_HEADERS });
    }
    console.error('[dashboard/edit] Failed:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
```

- [ ] **Step 5: Create the regenerate route**

Create `src/app/api/dashboard/reviews/[reviewId]/regenerate/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { regenerateBySession, ResponseNotPendingError } from '@/lib/approval/service';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ reviewId: string }> },
): Promise<NextResponse> {
  try {
    const user = await requireRole(request, 'owner');
    const { reviewId } = await params;

    if (!user.businessId) {
      return NextResponse.json({ error: 'No business linked' }, { status: 403, headers: NO_STORE_HEADERS });
    }

    const [response] = await sql<{ id: string; business_id: string; status: string }[]>`
      SELECT r.id, r.business_id, r.status
      FROM responses r
      JOIN reviews rv ON rv.id = r.review_id
      WHERE rv.id = ${reviewId} AND r.status NOT IN ('superseded', 'failed')
      ORDER BY r.version DESC LIMIT 1
    `;

    if (!response) {
      return NextResponse.json({ error: 'Response not found' }, { status: 404, headers: NO_STORE_HEADERS });
    }

    if (response.business_id !== user.businessId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: NO_STORE_HEADERS });
    }

    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

    await sql.begin(async (tx) => {
      await regenerateBySession(tx, response.id, response.business_id, {
        actorUserId: user.id,
        ipAddress: ip,
      });
    });

    return NextResponse.json(
      { success: true, message: 'Generating a new response — check your email in a few minutes.' },
      { headers: NO_STORE_HEADERS },
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode, headers: NO_STORE_HEADERS });
    }
    if (err instanceof ResponseNotPendingError) {
      return NextResponse.json({ error: 'Response is no longer pending approval' }, { status: 409, headers: NO_STORE_HEADERS });
    }
    console.error('[dashboard/regenerate] Failed:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run src/app/api/dashboard/reviews/__tests__/actions.test.ts`
Expected: all tests PASS

- [ ] **Step 7: Commit**

```bash
git add src/app/api/dashboard/reviews/
git commit -m "feat(19c-5b): dashboard approval actions — approve, edit, regenerate with owner session auth"
```

---

## Task 3: Owner settings API route

**Files:**
- Create: `src/app/api/settings/route.ts`
- Create: `src/app/api/settings/__tests__/route.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/app/api/settings/__tests__/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { mockRequireRole, mockSql } = vi.hoisted(() => {
  const mockSql: any = Object.assign(
    vi.fn().mockResolvedValue([]),
    { begin: vi.fn() },
  );
  return {
    mockRequireRole: vi.fn(),
    mockSql,
  };
});

vi.mock('@/lib/db/auth', () => {
  class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
    }
  }
  return { requireRole: (...args: unknown[]) => mockRequireRole(...args), AuthError };
});

vi.mock('@/lib/db/server', () => ({ sql: mockSql }));

const ownerUser = { id: 'user-1', name: 'Owner', email: 'o@test.com', role: 'owner', businessId: 'biz-1' };

function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/settings', {
    method: 'PUT',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('PUT /api/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireRole.mockResolvedValue(ownerUser);
    mockSql.mockResolvedValue([{ id: 'biz-1' }]);
  });

  it('returns 403 when user has no businessId', async () => {
    mockRequireRole.mockResolvedValue({ ...ownerUser, businessId: null });
    const { PUT } = await import('../route');
    const res = await PUT(makeRequest({ tone: 'warm' }));
    expect(res.status).toBe(403);
  });

  it('returns 400 for empty body', async () => {
    const { PUT } = await import('../route');
    const res = await PUT(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it('updates tone successfully', async () => {
    const { PUT } = await import('../route');
    const res = await PUT(makeRequest({ tone: 'casual and friendly' }));
    expect(res.status).toBe(200);
  });

  it('updates notification preferences', async () => {
    const { PUT } = await import('../route');
    const res = await PUT(makeRequest({ notificationPreference: 'sms', ownerPhone: '+15551234567' }));
    expect(res.status).toBe(200);
  });

  it('updates weekly_summary_enabled toggle', async () => {
    const { PUT } = await import('../route');
    const res = await PUT(makeRequest({ weeklySummaryEnabled: false }));
    expect(res.status).toBe(200);
  });

  it('updates monthly_impact_enabled toggle', async () => {
    const { PUT } = await import('../route');
    const res = await PUT(makeRequest({ monthlyImpactEnabled: false }));
    expect(res.status).toBe(200);
  });

  it('rejects invalid notification preference', async () => {
    const { PUT } = await import('../route');
    const res = await PUT(makeRequest({ notificationPreference: 'carrier_pigeon' }));
    expect(res.status).toBe(400);
  });

  it('never accepts business_id in body', async () => {
    const { PUT } = await import('../route');
    // Even if body contains business_id, the route uses user.businessId
    const res = await PUT(makeRequest({ tone: 'warm', business_id: 'biz-hacked' }));
    expect(res.status).toBe(200);
    // Verify sql was called with user's businessId, not the body's
    const sqlCall = mockSql.mock.calls[0];
    // The sql tagged template call will have businessId in its interpolated values
    expect(JSON.stringify(sqlCall)).toContain('biz-1');
    expect(JSON.stringify(sqlCall)).not.toContain('biz-hacked');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/api/settings/__tests__/route.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the settings route**

Create `src/app/api/settings/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { NO_STORE_HEADERS } from '@/lib/shared/constants';

export const dynamic = 'force-dynamic';

const SettingsSchema = z.object({
  tone: z.string().max(100).optional(),
  productsServices: z.string().max(2000).nullable().optional(),
  avoidFacts: z.array(z.string().max(500)).optional(),
  sampleResponses: z.array(z.string().max(2000)).optional(),
  notificationPreference: z.enum(['email', 'sms', 'both']).optional(),
  ownerPhone: z.string().max(20).nullable().optional(),
  weeklySummaryEnabled: z.boolean().optional(),
  monthlyImpactEnabled: z.boolean().optional(),
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one field must be provided' },
);

const FIELD_TO_COLUMN: Record<string, string> = {
  tone: 'tone',
  productsServices: 'products_services',
  avoidFacts: 'avoid_facts',
  sampleResponses: 'sample_responses',
  notificationPreference: 'notification_preference',
  ownerPhone: 'owner_phone',
  weeklySummaryEnabled: 'weekly_summary_enabled',
  monthlyImpactEnabled: 'monthly_impact_enabled',
};

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await requireRole(request, 'owner');

    if (!user.businessId) {
      return NextResponse.json({ error: 'No business linked to account' }, { status: 403, headers: NO_STORE_HEADERS });
    }

    const body = await request.json();
    const parsed = SettingsSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? 'Invalid input' },
        { status: 400, headers: NO_STORE_HEADERS },
      );
    }

    const data = parsed.data;
    const fields = Object.keys(data) as (keyof typeof data)[];
    const setClauses: string[] = [];
    const values: unknown[] = [user.businessId]; // $1 = businessId

    for (const field of fields) {
      const column = FIELD_TO_COLUMN[field];
      if (!column) continue;
      const value = data[field] ?? null;
      values.push(value);
      setClauses.push(`${column} = $${values.length}`);
    }

    if (setClauses.length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400, headers: NO_STORE_HEADERS });
    }

    setClauses.push('updated_at = NOW()');
    const query = `UPDATE businesses SET ${setClauses.join(', ')} WHERE id = $1 RETURNING id`;

    const result = await sql.unsafe(query, values);

    if (result.count === 0) {
      return NextResponse.json({ error: 'Business not found' }, { status: 404, headers: NO_STORE_HEADERS });
    }

    return NextResponse.json({ success: true }, { headers: NO_STORE_HEADERS });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode, headers: NO_STORE_HEADERS });
    }
    console.error('[api/settings] Failed:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: NO_STORE_HEADERS });
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/app/api/settings/__tests__/route.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Add `/api/settings` to middleware owner protection**

In `src/middleware.ts`, find the section that protects `/api/dashboard/*` and add `/api/settings` to the same block. The middleware already checks for `role='owner' AND business_id IS NOT NULL` for `/api/dashboard/*` — extend the path match to also cover `/api/settings`.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/settings/ src/middleware.ts
git commit -m "feat(19c-5b): PUT /api/settings — owner settings with notification opt-out toggles"
```

---

## Task 4: Update schedulers to respect opt-out flags

**Files:**
- Modify: `worker/jobs/WeeklySummaryScheduler.ts`
- Modify: `worker/jobs/MonthlyImpactScheduler.ts`

- [ ] **Step 1: Update WeeklySummaryScheduler business query**

In `worker/jobs/WeeklySummaryScheduler.ts`, modify the business query (the `SELECT b.id FROM businesses b WHERE ...` query) to add:

```sql
AND (b.weekly_summary_enabled IS NULL OR b.weekly_summary_enabled = TRUE)
```

This uses `IS NULL OR = TRUE` instead of just `= TRUE` to handle businesses created before the migration that don't yet have the column backfilled (it defaults to TRUE, but defensive SQL is correct here).

- [ ] **Step 2: Update MonthlyImpactScheduler business query**

In `worker/jobs/MonthlyImpactScheduler.ts`, modify the business query to add:

```sql
AND (b.monthly_impact_enabled IS NULL OR b.monthly_impact_enabled = TRUE)
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Run existing scheduler tests**

Run: `npx vitest run worker/`
Expected: all existing tests PASS

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/WeeklySummaryScheduler.ts worker/jobs/MonthlyImpactScheduler.ts
git commit -m "feat(19c-5b): schedulers respect weekly_summary_enabled and monthly_impact_enabled opt-out"
```

---

## Task 5: Build owner settings page

**Files:**
- Modify: `src/app/(authenticated)/settings/page.tsx` (replace placeholder)
- Modify: `src/components/OwnerNav.tsx` (add Settings link)
- Modify: `src/app/api/dashboard/route.ts` (return notification prefs + opt-out flags)

- [ ] **Step 1: Extend dashboard API to return settings data**

In `src/app/api/dashboard/route.ts`, add to the business query:

```sql
b.tone, b.products_services, b.avoid_facts, b.sample_responses,
b.notification_preference, b.owner_phone, b.owner_email,
b.weekly_summary_enabled, b.monthly_impact_enabled,
b.category, b.google_place_id
```

Add these fields to the response under a new `settings` key:

```typescript
settings: {
  tone: business.tone,
  productsServices: business.products_services,
  avoidFacts: parseArray(business.avoid_facts),
  sampleResponses: parseArray(business.sample_responses),
  notificationPreference: business.notification_preference ?? 'email',
  ownerPhone: business.owner_phone,
  ownerEmail: business.owner_email,
  weeklySummaryEnabled: business.weekly_summary_enabled ?? true,
  monthlyImpactEnabled: business.monthly_impact_enabled ?? true,
  category: business.category,
  googlePlaceId: business.google_place_id,
},
```

Where `parseArray` handles the PgBouncer JSONB-as-string pattern (same utility as used in admin routes — if not already imported, add a local helper).

- [ ] **Step 2: Add Settings link to OwnerNav**

In `src/components/OwnerNav.tsx`, add a Settings link next to the Dashboard link:

```tsx
<Link href="/settings" className="... text styling matching existing Dashboard link ...">
  Settings
</Link>
```

- [ ] **Step 3: Build the settings page**

Replace the placeholder in `src/app/(authenticated)/settings/page.tsx` with a full `'use client'` page that:

- Fetches `/api/dashboard` on mount (reuses the same endpoint that now includes `settings`)
- Displays Section A: Business Profile (read-only: name, category, google_place_id; editable: tone textarea, products_services textarea, avoid_facts as line-separated textarea, sample_responses as line-separated textarea)
- Displays Section B: Notification Preferences (notification_preference radio: email/sms/both, ownerPhone input shown only when sms/both selected, weekly_summary_enabled toggle, monthly_impact_enabled toggle)
- Single "Save Changes" button that PUTs only changed fields to `/api/settings`
- Success toast (green banner at top, auto-dismiss after 3 seconds)
- Error display (red text below save button)
- Loading skeleton while fetching
- Mobile-first layout, same Tailwind patterns as dashboard

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Start dev server and test**

Run: `pnpm dev`

Navigate to `/settings` as an owner. Verify:
- Business profile section shows read-only fields + editable fields
- Notification preferences section shows channel toggle + opt-out toggles
- Saving changes works and shows success toast
- Toggling weekly/monthly off and saving updates the DB

- [ ] **Step 6: Commit**

```bash
git add src/app/(authenticated)/settings/page.tsx src/components/OwnerNav.tsx src/app/api/dashboard/route.ts
git commit -m "feat(19c-5b): owner settings page with notification opt-out toggles"
```

---

## Task 6: Add dashboard approval UI

**Files:**
- Modify: `src/components/DashboardContent.tsx`

- [ ] **Step 1: Read the existing DashboardContent component**

Read `src/components/DashboardContent.tsx` to understand the current recent reviews section and how it displays pending reviews with status badges.

- [ ] **Step 2: Add approval action buttons to pending reviews**

In the recent reviews section, for reviews with `status === 'pending_approval'`, add three action buttons:

- **Approve** button — POSTs to `/api/dashboard/reviews/${reviewId}/approve`
- **Edit** button — opens inline text editor, then POSTs to `/api/dashboard/reviews/${reviewId}/edit` with `{ editedText }`
- **Regenerate** button — POSTs to `/api/dashboard/reviews/${reviewId}/regenerate`

Each button should:
- Show a loading spinner while the request is in flight
- Show success message on 200
- Show error message on non-200
- Refresh the dashboard data after success (invalidate query)

The edit flow: clicking "Edit" shows a textarea pre-filled with the response text. The owner modifies it and clicks "Save & Approve". The textarea has a max length of 2000 characters.

- [ ] **Step 3: Verify types compile and test in browser**

Run: `npx tsc --noEmit`

Start dev server and test:
- Navigate to `/dashboard` as owner with pending reviews
- Click Approve → success, status changes
- Click Edit → textarea appears → modify → Save & Approve → success
- Click Regenerate → success message → status changes to superseded

- [ ] **Step 4: Commit**

```bash
git add src/components/DashboardContent.tsx
git commit -m "feat(19c-5b): dashboard approval actions — approve, edit, regenerate buttons on pending reviews"
```

---

## Task 7: Run full test suite and verify

**Files:** None (verification only)

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: all existing + new tests PASS

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Final commit if any fixups needed**

```bash
git add -A
git commit -m "fix(19c-5b): test fixups after settings + dashboard actions integration"
```
