# Zernio reconnect-queue admin actions (#23b) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins two reconnect-queue actions on the business-detail page — a business-level **force-drain** (re-attempt publishing for all parked responses) and a per-response **dismiss** (discard a stale parked draft) — behind one admin-only route.

**Architecture:** A new `POST /api/admin/businesses/[id]/zernio-queue` route guarded exactly like `/api/admin/billing/grant-extension` (same-origin → admin role → AAL2 → Zod → single `sql.begin` tx). `force_drain` reuses the existing `drain_pending_owner_connect` outbox topic → `DrainOwnerConnectWorker` (idempotent); `dismiss` transitions one `awaiting_owner_connect` response to `superseded`. Both write `account_audit_log` in the same tx. `ZernioConnectionPanel.tsx` gains the two action surfaces.

**Tech Stack:** Next.js 16 route handlers, Postgres.js (`sql`/`sql.begin`/`jsonb`), Zod, `writeAccountAuditLog`, Vitest + Testing Library.

---

## Context the implementer needs

- **Worktree:** all work happens in `.claude/worktrees/launch-yellow-23b-zernio-queue-actions/`. Paths below are repo-relative; when editing, prefix with that worktree path.
- **Do NOT run lint/test/typecheck locally in this nested worktree** (CLAUDE.md: module resolution leaks into the parent `node_modules`/eslintrc and poisons results). Write the code, commit per task, and rely on CI after push for the authoritative `lint`/`typecheck`/`test`/`build` + `pnpm ci:tenant-scope` (which runs in CI). The "Run the test" steps below describe the *expected* result for when CI runs them; do not execute them in the worktree.
- **Reference files to read before starting** (read-only, do not modify): `src/app/api/admin/billing/grant-extension/route.ts` (route template), its `__tests__/route.test.ts` (mock idiom), `worker/jobs/DrainOwnerConnectWorker.ts`, `src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts:115` (the drain outbox row shape), `src/lib/audit/log.ts` (`writeAccountAuditLog` signature), `src/app/admin/businesses/[id]/components/__tests__/PastDueExtensionPanel.test.tsx` (component-test idiom).
- **Status facts:** `responses.status` enum and `posting_error` column exist (migration 026/029). `awaiting_owner_connect` is set only by the publisher; `superseded` is the terminal "give up" status. Outbox topic `drain_pending_owner_connect` is already registered (`worker/queues.ts`, `src/lib/shared/queue-names.ts`).

---

## File Structure

- **Create:** `src/app/api/admin/businesses/[id]/zernio-queue/route.ts` — the admin action route (guards + `force_drain` + `dismiss`, ~150 lines).
- **Create:** `src/app/api/admin/businesses/[id]/zernio-queue/__tests__/route.test.ts` — route tests.
- **Modify:** `src/app/admin/businesses/[id]/components/ZernioConnectionPanel.tsx` — replace the `TODO(zernio)` block with the two action surfaces + per-action state.
- **Create:** `src/app/admin/businesses/[id]/components/__tests__/ZernioConnectionPanel.test.tsx` — component tests.
- **Modify:** `scripts/ci/tenant-scope-allowlist.ts` — allowlist the new cross-tenant SQL.
- **Modify:** `docs/launch-ready-part2.md` — tick #23b.

---

## Task 1: Route — guards + `force_drain`

**Files:**
- Create: `src/app/api/admin/businesses/[id]/zernio-queue/route.ts`
- Test: `src/app/api/admin/businesses/[id]/zernio-queue/__tests__/route.test.ts`

- [ ] **Step 1: Write the failing test** (`…/__tests__/route.test.ts`)

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

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

vi.mock('@/lib/db/auth', () => ({
  requireRole: mockRequireRole,
  AuthError: class AuthError extends Error {
    constructor(message: string, public readonly statusCode: number) {
      super(message);
    }
  },
}));
vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => ({ __jsonb: v }) }));
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn(() => ({ auth: { mfa: {} } })) }));
vi.mock('@/lib/auth/mfa', () => ({ requireCurrentAal2FromSupabase: mockRequireCurrentAal2FromSupabase }));
vi.mock('@/lib/audit/log', () => ({ writeAccountAuditLog: mockWriteAccountAuditLog }));

process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://supabase.example.com';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';

const BUSINESS_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const RESPONSE_ID = '44444444-4444-4444-8444-444444444444';

function req(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(
    `https://app.example.com/api/admin/businesses/${BUSINESS_ID}/zernio-queue`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://app.example.com', ...headers },
      body: JSON.stringify(body),
    },
  );
}
const ctx = { params: Promise.resolve({ id: BUSINESS_ID }) };

describe('POST /api/admin/businesses/[id]/zernio-queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    txCalls.length = 0;
    txResults.length = 0;
    process.env.ZERNIO_PUBLISHING_ENABLED = 'true';
    mockRequireRole.mockResolvedValue({
      id: ADMIN_ID, role: 'admin', email: 'admin@example.com', name: 'Admin',
      accountId: null, locationId: null,
    });
    mockRequireCurrentAal2FromSupabase.mockResolvedValue({ ok: true });
    mockWriteAccountAuditLog.mockResolvedValue(undefined);
  });

  it('rejects non-admin, missing AAL2, and bad bodies', async () => {
    const { AuthError } = await import('@/lib/db/auth');
    const { POST } = await import('../route');

    mockRequireRole.mockRejectedValueOnce(new AuthError('Forbidden', 403));
    expect((await POST(req({ action: 'force_drain' }), ctx)).status).toBe(403);

    mockRequireCurrentAal2FromSupabase.mockResolvedValueOnce({ ok: false, reason: 'mfa_required' });
    expect((await POST(req({ action: 'force_drain' }), ctx)).status).toBe(403);

    expect((await POST(req({ action: 'nonsense' }), ctx)).status).toBe(400);
  });

  it('returns 503 when ZERNIO_PUBLISHING_ENABLED is off (force_drain only)', async () => {
    process.env.ZERNIO_PUBLISHING_ENABLED = 'false';
    const { POST } = await import('../route');
    const res = await POST(req({ action: 'force_drain' }), ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'feature_disabled' });
  });

  it('409 connection_not_active when no active connection', async () => {
    txResults.push([]); // connection select → none
    const { POST } = await import('../route');
    const res = await POST(req({ action: 'force_drain' }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'connection_not_active' });
  });

  it('409 queue_empty when nothing is parked', async () => {
    txResults.push([{ status: 'active', account_id: ACCOUNT_ID }]); // connection
    txResults.push([{ stuck_count: 0 }]); // count
    const { POST } = await import('../route');
    const res = await POST(req({ action: 'force_drain' }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'queue_empty' });
  });

  it('force_drain enqueues a drain outbox row + audit, returns queued count', async () => {
    txResults.push([{ status: 'active', account_id: ACCOUNT_ID }]); // connection
    txResults.push([{ stuck_count: 2 }]); // count
    txResults.push(Object.assign([], { count: 1 })); // outbox insert
    const { POST } = await import('../route');
    const res = await POST(req({ action: 'force_drain' }), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: 'force_drain', queued: 2 });
    expect(txCalls.some((c) => /drain_pending_owner_connect/.test(c.text))).toBe(true);
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        actorUserId: ADMIN_ID,
        eventType: 'zernio_queue_force_drained',
        entityType: 'business',
        entityId: BUSINESS_ID,
        payload: { stuck_count: 2 },
      }),
      mockTx,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (CI / clean clone only): `pnpm test src/app/api/admin/businesses/[id]/zernio-queue`
Expected: FAIL — `Cannot find module '../route'`.

- [ ] **Step 3: Write the route** (`…/zernio-queue/route.ts`)

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { z } from 'zod';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import { AuthError, requireRole } from '@/lib/db/auth';
import { writeAccountAuditLog } from '@/lib/audit/log';
import { requireCurrentAal2FromSupabase, type SupabaseMfaAalClient } from '@/lib/auth/mfa';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mfaClientForRequest(request: NextRequest): SupabaseMfaAalClient {
  return createServerClient(
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
}

const ActionSchema = z.object({ action: z.literal('force_drain') });

class QueueActionError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = 'QueueActionError';
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id: businessId } = await params;

  try {
    assertSameOrigin(request);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
    }
    return errorToResponse(err);
  }

  let admin;
  try {
    admin = await requireRole(request, 'admin');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode, headers: NO_STORE });
    }
    return errorToResponse(err);
  }

  const aal = await requireCurrentAal2FromSupabase(mfaClientForRequest(request));
  if (!aal.ok) {
    return NextResponse.json({ error: aal.reason }, { status: 403, headers: NO_STORE });
  }

  if (!UUID_RE.test(businessId)) {
    return NextResponse.json({ error: 'invalid_business_id' }, { status: 400, headers: NO_STORE });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
  }

  const parsed = ActionSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid_request' },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    if (process.env.ZERNIO_PUBLISHING_ENABLED !== 'true') {
      return NextResponse.json({ error: 'feature_disabled' }, { status: 503, headers: NO_STORE });
    }
    const queued = await forceDrain(businessId, admin.id);
    return NextResponse.json({ ok: true, action: 'force_drain', queued }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof QueueActionError) {
      return NextResponse.json({ error: err.code }, { status: err.status, headers: NO_STORE });
    }
    return errorToResponse(err);
  }
}

async function forceDrain(businessId: string, adminId: string): Promise<number> {
  return sql.begin(async (tx) => {
    const connRows = await tx<{ status: string; account_id: string }[]>`
      SELECT zc.status, b.account_id
      FROM zernio_connections zc
      JOIN businesses b ON b.id = zc.business_id
      WHERE zc.business_id = ${businessId}
      ORDER BY zc.created_at DESC
      LIMIT 1
      FOR UPDATE OF zc
    `;
    const conn = connRows[0];
    if (!conn || conn.status !== 'active') {
      throw new QueueActionError(409, 'connection_not_active');
    }

    const countRows = await tx<{ stuck_count: number }[]>`
      SELECT COUNT(*)::int AS stuck_count
      FROM responses
      WHERE business_id = ${businessId} AND status = 'awaiting_owner_connect'
    `;
    const stuckCount = countRows[0]?.stuck_count ?? 0;
    if (stuckCount === 0) {
      throw new QueueActionError(409, 'queue_empty');
    }

    // Re-run the SAME drain the reconnect flow fires (finalize-tx.ts). The
    // DrainOwnerConnectWorker is idempotent, so repeat clicks are harmless.
    const payload = { business_id: businessId, kind: 'drain', source: 'admin_force_drain' };
    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts)
      VALUES (${uuidv7()}, 'drain_pending_owner_connect', 'business', ${businessId}, ${jsonb(payload)}, 0, 5)
    `;

    await writeAccountAuditLog(
      {
        accountId: conn.account_id,
        actorUserId: adminId,
        eventType: 'zernio_queue_force_drained',
        entityType: 'business',
        entityId: businessId,
        payload: { stuck_count: stuckCount },
      },
      tx,
    );

    return stuckCount;
  });
}

function errorToResponse(error: unknown): NextResponse {
  console.error('[api/admin/businesses/[id]/zernio-queue] failed:', error);
  return NextResponse.json({ error: 'internal_error' }, { status: 500, headers: NO_STORE });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run (CI / clean clone only): `pnpm test src/app/api/admin/businesses/[id]/zernio-queue`
Expected: PASS — all Task 1 cases green.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/admin/businesses/[id]/zernio-queue/"
git commit -m "feat(admin-zernio): force-drain reconnect queue via admin route"
```

---

## Task 2: Route — `dismiss`

**Files:**
- Modify: `src/app/api/admin/businesses/[id]/zernio-queue/route.ts`
- Test: `src/app/api/admin/businesses/[id]/zernio-queue/__tests__/route.test.ts` (add cases)

- [ ] **Step 1: Add the failing tests** (append inside the `describe` block)

```ts
  it('dismiss supersedes a parked response + audit', async () => {
    txResults.push([{ id: RESPONSE_ID, account_id: ACCOUNT_ID }]); // select FOR UPDATE
    txResults.push(Object.assign([], { count: 1 })); // update
    const { POST } = await import('../route');
    const res = await POST(req({ action: 'dismiss', responseId: RESPONSE_ID }), ctx);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, action: 'dismiss' });
    expect(txCalls.some((c) => /SET status = 'superseded'/.test(c.text))).toBe(true);
    expect(txCalls.some((c) => /admin_dismissed_awaiting_connect/.test(c.values.join(' ') + c.text))).toBe(
      true,
    );
    expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        actorUserId: ADMIN_ID,
        eventType: 'zernio_queue_response_dismissed',
        entityType: 'response',
        entityId: RESPONSE_ID,
        payload: { response_id: RESPONSE_ID },
      }),
      mockTx,
    );
  });

  it('409 not_awaiting when the response is not parked / wrong business', async () => {
    txResults.push([]); // select FOR UPDATE → none
    const { POST } = await import('../route');
    const res = await POST(req({ action: 'dismiss', responseId: RESPONSE_ID }), ctx);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_awaiting' });
  });

  it('dismiss is NOT gated by ZERNIO_PUBLISHING_ENABLED', async () => {
    process.env.ZERNIO_PUBLISHING_ENABLED = 'false';
    txResults.push([{ id: RESPONSE_ID, account_id: ACCOUNT_ID }]);
    txResults.push(Object.assign([], { count: 1 }));
    const { POST } = await import('../route');
    const res = await POST(req({ action: 'dismiss', responseId: RESPONSE_ID }), ctx);
    expect(res.status).toBe(200);
  });

  it('400 when dismiss is missing responseId', async () => {
    const { POST } = await import('../route');
    expect((await POST(req({ action: 'dismiss' }), ctx)).status).toBe(400);
  });
```

- [ ] **Step 2: Run to verify the new cases fail**

Run (CI / clean clone only): `pnpm test src/app/api/admin/businesses/[id]/zernio-queue`
Expected: FAIL — `dismiss` is rejected by the current `force_drain`-only schema (400), so the dismiss cases fail.

- [ ] **Step 3: Extend the schema + add the dismiss branch**

In `route.ts`, replace the schema:

```ts
const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('force_drain') }),
  z.object({ action: z.literal('dismiss'), responseId: z.string().uuid() }),
]);
```

Replace the dispatch block inside the final `try` with:

```ts
  try {
    if (parsed.data.action === 'force_drain') {
      if (process.env.ZERNIO_PUBLISHING_ENABLED !== 'true') {
        return NextResponse.json({ error: 'feature_disabled' }, { status: 503, headers: NO_STORE });
      }
      const queued = await forceDrain(businessId, admin.id);
      return NextResponse.json({ ok: true, action: 'force_drain', queued }, { headers: NO_STORE });
    }

    await dismiss(businessId, parsed.data.responseId, admin.id);
    return NextResponse.json({ ok: true, action: 'dismiss' }, { headers: NO_STORE });
  } catch (err) {
    if (err instanceof QueueActionError) {
      return NextResponse.json({ error: err.code }, { status: err.status, headers: NO_STORE });
    }
    return errorToResponse(err);
  }
```

Add the `dismiss` helper (next to `forceDrain`):

```ts
async function dismiss(businessId: string, responseId: string, adminId: string): Promise<void> {
  await sql.begin(async (tx) => {
    const rows = await tx<{ id: string; account_id: string }[]>`
      SELECT r.id, b.account_id
      FROM responses r
      JOIN businesses b ON b.id = r.business_id
      WHERE r.id = ${responseId}
        AND r.business_id = ${businessId}
        AND r.status = 'awaiting_owner_connect'
      FOR UPDATE OF r
    `;
    const row = rows[0];
    if (!row) {
      throw new QueueActionError(409, 'not_awaiting');
    }

    // Terminal 'give up on this parked draft' transition — the same status +
    // posting_error pattern process-review.ts uses for parked responses.
    await tx`
      UPDATE responses
      SET status = 'superseded',
          posting_error = 'admin_dismissed_awaiting_connect',
          updated_at = NOW()
      WHERE id = ${responseId} AND status = 'awaiting_owner_connect'
    `;

    await writeAccountAuditLog(
      {
        accountId: row.account_id,
        actorUserId: adminId,
        eventType: 'zernio_queue_response_dismissed',
        entityType: 'response',
        entityId: responseId,
        payload: { response_id: responseId },
      },
      tx,
    );
  });
}
```

- [ ] **Step 4: Run to verify all route tests pass**

Run (CI / clean clone only): `pnpm test src/app/api/admin/businesses/[id]/zernio-queue`
Expected: PASS — Task 1 + Task 2 cases all green.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/admin/businesses/[id]/zernio-queue/"
git commit -m "feat(admin-zernio): dismiss parked response (supersede) via admin route"
```

---

## Task 3: Tenant-scope allowlist

The route's SQL is intentionally cross-tenant (admin acts on any business). `pnpm ci:tenant-scope` runs in CI and will fail until the new statements are allowlisted.

**Files:**
- Modify: `scripts/ci/tenant-scope-allowlist.ts`

- [ ] **Step 1: Add allowlist entries**

Append these objects to the `tenantScopeAllowlist` array (before the closing `];`). The `sqlSnippet` must match the audit's normalized output for each statement; if `pnpm ci:tenant-scope` later reports a mismatch, replace the snippet text with the exact string the audit prints.

```ts
  {
    file: "src/app/api/admin/businesses/[id]/zernio-queue/route.ts",
    table: "zernio_connections",
    sqlSnippet: "SELECT zc.status, b.account_id FROM zernio_connections zc JOIN businesses b ON b.id = zc.business_id WHERE zc.business_id = ${businessId} ORDER BY zc.created_at DESC LIMIT 1 FOR UPDATE OF zc",
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/app/api/admin/businesses/[id]/zernio-queue/route.ts",
    table: "responses",
    sqlSnippet: "SELECT COUNT(*)::int AS stuck_count FROM responses WHERE business_id = ${businessId} AND status = 'awaiting_owner_connect'",
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/app/api/admin/businesses/[id]/zernio-queue/route.ts",
    table: "responses",
    sqlSnippet: "SELECT r.id, b.account_id FROM responses r JOIN businesses b ON b.id = r.business_id WHERE r.id = ${responseId} AND r.business_id = ${businessId} AND r.status = 'awaiting_owner_connect' FOR UPDATE OF r",
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
  {
    file: "src/app/api/admin/businesses/[id]/zernio-queue/route.ts",
    table: "responses",
    sqlSnippet: "UPDATE responses SET status = 'superseded', posting_error = 'admin_dismissed_awaiting_connect', updated_at = NOW() WHERE id = ${responseId} AND status = 'awaiting_owner_connect'",
    reason: "Admin-only route or service intentionally performs this statement after requireRole(admin).",
  },
```

> Note: the `drain_pending_owner_connect` INSERT targets `job_outbox` (not a tenant table) and matches the existing engagement/finalize INSERT pattern; if the audit flags it, add an analogous entry with `table: "job_outbox"` and the same admin reason.

- [ ] **Step 2: Verify (CI / clean clone)**

Run: `pnpm ci:tenant-scope`
Expected: PASS (`0 violations`). If it lists an unallowlisted snippet for this file, copy that exact normalized snippet into a new entry and re-run.

- [ ] **Step 3: Commit**

```bash
git add scripts/ci/tenant-scope-allowlist.ts
git commit -m "chore(ci): allowlist admin zernio-queue route cross-tenant SQL"
```

---

## Task 4: Panel UI — force-drain button + hint

**Files:**
- Modify: `src/app/admin/businesses/[id]/components/ZernioConnectionPanel.tsx`
- Test: `src/app/admin/businesses/[id]/components/__tests__/ZernioConnectionPanel.test.tsx`

- [ ] **Step 1: Write the failing test** (`…/__tests__/ZernioConnectionPanel.test.tsx`)

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZernioConnectionPanel } from '../ZernioConnectionPanel';
import type { ZernioPanelData } from '../../types';

const BUSINESS_ID = '33333333-3333-4333-8333-333333333333';
const RESPONSE_ID = '44444444-4444-4444-8444-444444444444';

function panelData(overrides: Partial<ZernioPanelData> = {}): ZernioPanelData {
  return {
    connection: {
      status: 'active',
      connectedAt: '2026-05-01T00:00:00.000Z',
      disconnectedAt: null,
      disconnectReason: null,
      lastError: null,
      lastErrorAt: null,
      zernioAccountId: 'zacct_1',
      zernioLocationId: 'zloc_1',
    },
    awaitingOwnerConnect: [
      {
        responseId: RESPONSE_ID,
        createdAt: '2026-05-20T00:00:00.000Z',
        draftText: 'Thanks for the kind words!',
        reviewerName: 'Jane D.',
        reviewText: 'Great service',
        starRating: 5,
      },
    ],
    unresolvedIncidents: [],
    ...overrides,
  };
}

describe('ZernioConnectionPanel — reconnect-queue actions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('force-drains the queue when the connection is active', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, action: 'force_drain', queued: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    const onChanged = vi.fn();

    render(<ZernioConnectionPanel businessId={BUSINESS_ID} zernio={panelData()} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Force drain queue' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(`/api/admin/businesses/${BUSINESS_ID}/zernio-queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'force_drain' }),
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('hides the force-drain button and shows a hint when not active', () => {
    render(
      <ZernioConnectionPanel
        businessId={BUSINESS_ID}
        zernio={panelData({
          connection: { ...panelData().connection!, status: 'disconnected' },
        })}
        onChanged={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Force drain queue' })).toBeNull();
    expect(screen.getByText(/Drain becomes available once the owner reconnects/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (CI / clean clone only): `pnpm test src/app/admin/businesses/[id]/components/__tests__/ZernioConnectionPanel`
Expected: FAIL — no "Force drain queue" button exists yet.

- [ ] **Step 3: Implement the force-drain UI**

In `ZernioConnectionPanel.tsx`, add state + handler inside the component (after the existing `error`/`disconnecting` state, near line 65):

```tsx
  const [draining, setDraining] = useState(false);
  const [dismissingId, setDismissingId] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);

  const handleForceDrain = useCallback(async () => {
    setDraining(true);
    setQueueError(null);
    try {
      const res = await fetch(`/api/admin/businesses/${businessId}/zernio-queue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'force_drain' }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onChanged();
    } catch (err) {
      setQueueError(err instanceof Error ? err.message : 'Failed to drain queue');
    } finally {
      setDraining(false);
    }
  }, [businessId, onChanged]);
```

Replace the awaiting-list header + the `TODO(zernio)` comment block (lines ~226–239) with:

```tsx
      {awaitingOwnerConnect.length > 0 && (
        <div className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-gray-800">
              Responses queued for reconnect ({awaitingOwnerConnect.length})
            </h3>
            {status === 'active' ? (
              <button
                type="button"
                onClick={() => {
                  void handleForceDrain();
                }}
                disabled={draining}
                className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {draining ? 'Draining…' : 'Force drain queue'}
              </button>
            ) : (
              <span className="text-xs text-gray-400">
                Drain becomes available once the owner reconnects Zernio.
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-gray-500">
            These approved responses cannot publish until the owner reconnects Zernio. After
            reconnect, the worker drains them automatically.
          </p>
          {queueError && (
            <p className="mt-2 rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              {queueError}
            </p>
          )}
          <ul className="mt-3 space-y-2">
```

(The existing `{awaitingOwnerConnect.map(...)}` list items and the closing `</ul></div>)}` stay; Task 5 adds the per-row Dismiss button.)

- [ ] **Step 4: Run to verify it passes**

Run (CI / clean clone only): `pnpm test src/app/admin/businesses/[id]/components/__tests__/ZernioConnectionPanel`
Expected: PASS — both Task 4 cases green.

- [ ] **Step 5: Commit**

```bash
git add "src/app/admin/businesses/[id]/components/ZernioConnectionPanel.tsx" "src/app/admin/businesses/[id]/components/__tests__/ZernioConnectionPanel.test.tsx"
git commit -m "feat(admin-zernio): force-drain button on reconnect-queue panel"
```

---

## Task 5: Panel UI — per-response dismiss

**Files:**
- Modify: `src/app/admin/businesses/[id]/components/ZernioConnectionPanel.tsx`
- Test: `src/app/admin/businesses/[id]/components/__tests__/ZernioConnectionPanel.test.tsx` (add cases)

- [ ] **Step 1: Add the failing tests** (inside the existing `describe`)

```tsx
  it('dismisses a queued response after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ ok: true, action: 'dismiss' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    const onChanged = vi.fn();

    render(<ZernioConnectionPanel businessId={BUSINESS_ID} zernio={panelData()} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(`/api/admin/businesses/${BUSINESS_ID}/zernio-queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss', responseId: RESPONSE_ID }),
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it('does not call the API when dismiss is cancelled', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    render(<ZernioConnectionPanel businessId={BUSINESS_ID} zernio={panelData()} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders an inline error and does not refetch on failure', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'not_awaiting' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const onChanged = vi.fn();
    render(<ZernioConnectionPanel businessId={BUSINESS_ID} zernio={panelData()} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.getByText('not_awaiting')).toBeInTheDocument());
    expect(onChanged).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run (CI / clean clone only): `pnpm test src/app/admin/businesses/[id]/components/__tests__/ZernioConnectionPanel`
Expected: FAIL — no "Dismiss" button yet.

- [ ] **Step 3: Implement the dismiss handler + per-row button**

Add the handler next to `handleForceDrain`:

```tsx
  const handleDismiss = useCallback(
    async (responseId: string) => {
      if (!confirm('Permanently discard this queued reply? It will not post to Google.')) return;
      setDismissingId(responseId);
      setQueueError(null);
      try {
        const res = await fetch(`/api/admin/businesses/${businessId}/zernio-queue`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'dismiss', responseId }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        onChanged();
      } catch (err) {
        setQueueError(err instanceof Error ? err.message : 'Failed to dismiss');
      } finally {
        setDismissingId(null);
      }
    },
    [businessId, onChanged],
  );
```

In the awaiting `<li>` (after the reviewer/stars row, before the closing `</li>`), add a Dismiss button. Change the top row to a flex that pushes the button to the right — replace the opening of the `<div className="flex flex-wrap items-center gap-2">` row so it ends with a right-aligned button:

```tsx
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[#97B3AE]">{renderStars(r.starRating)}</span>
                  <span className="font-medium text-gray-700">{r.reviewerName}</span>
                  <span className="text-xs text-gray-400">
                    Queued {formatTimestamp(r.createdAt)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      void handleDismiss(r.responseId);
                    }}
                    disabled={dismissingId === r.responseId}
                    className="ml-auto rounded border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {dismissingId === r.responseId ? 'Dismissing…' : 'Dismiss'}
                  </button>
                </div>
```

- [ ] **Step 4: Run to verify it passes**

Run (CI / clean clone only): `pnpm test src/app/admin/businesses/[id]/components/__tests__/ZernioConnectionPanel`
Expected: PASS — all panel cases green.

- [ ] **Step 5: Commit**

```bash
git add "src/app/admin/businesses/[id]/components/ZernioConnectionPanel.tsx" "src/app/admin/businesses/[id]/components/__tests__/ZernioConnectionPanel.test.tsx"
git commit -m "feat(admin-zernio): per-response dismiss on reconnect-queue panel"
```

---

## Task 6: Tick the launch doc

**Files:**
- Modify: `docs/launch-ready-part2.md`

- [ ] **Step 1: Update line 158** — change the `🟡` marker for #23 to `✅` and replace the `#23b … DEFERRED` clause with a DONE note.

Replace the existing item-23 line with:

```markdown
23. ✅ Admin: add **Zernio reconnect-queue actions**; fix **admin payment-success polling cleanup**. *(**#23a DONE (PR #180).** **#23b DONE (this PR):** new admin-only `POST /api/admin/businesses/[id]/zernio-queue` (same-origin → admin → AAL2 → Zod → one tx) exposes **force-drain** — re-fires the existing `drain_pending_owner_connect` → `DrainOwnerConnectWorker` for all parked responses, gated on `ZERNIO_PUBLISHING_ENABLED` and an active connection — and per-response **dismiss** → `superseded`; both write `account_audit_log` in the same tx. `ZernioConnectionPanel.tsx` gains a "Force drain queue" button (active-only) + per-row "Dismiss"; the `TODO(zernio)` is removed. Cross-tenant SQL allowlisted; route + component tests added.)*
```

- [ ] **Step 2: Commit**

```bash
git add docs/launch-ready-part2.md
git commit -m "docs(launch-23b): tick #23b — Zernio reconnect-queue actions done"
```

---

## Task 7: Push, open PR, get CI green

- [ ] **Step 1: Push the branch**

```bash
git push -u origin worktree-launch-yellow-23b-zernio-queue-actions
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "feat(launch-23b): Zernio reconnect-queue admin actions (force-drain + dismiss)" --body "$(cat <<'EOF'
Closes the deferred half of launch-ready-part2 #23 (#23a shipped in PR #180).

Adds an admin-only `POST /api/admin/businesses/[id]/zernio-queue`:
- **force_drain** (business-scoped) — re-fires the existing `drain_pending_owner_connect` → `DrainOwnerConnectWorker` for every `awaiting_owner_connect` response; gated on `ZERNIO_PUBLISHING_ENABLED` + active connection; idempotent.
- **dismiss** (per-response) — transitions one parked draft to `superseded`.

Both run same-origin → admin → AAL2 → Zod → one `sql.begin` tx with `writeAccountAuditLog`. `ZernioConnectionPanel` gains a "Force drain queue" button (active-only) + per-row "Dismiss"; `TODO(zernio)` removed. Invariant #3 preserved (these are post-approval drafts). Cross-tenant SQL allowlisted; route + component tests added.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Watch CI** — confirm `lint`, `typecheck`, `test`, `build`, and `ci:tenant-scope` (+ `ci:rls-audit` if present) are green. If `ci:tenant-scope` fails on a snippet mismatch, copy the exact reported snippet into `scripts/ci/tenant-scope-allowlist.ts`, commit, and push.

- [ ] **Step 4: Enable auto-merge (squash)** once checks pass and review is satisfied:

```bash
gh pr merge --squash --auto
```

---

## Self-review notes

- **Spec coverage:** route + guards (T1), force_drain incl. feature gate / connection_not_active / queue_empty (T1), dismiss incl. not_awaiting / no-flag-gate (T2), tenant-scope allowlist (T3), force-drain UI + active-only gate (T4), dismiss UI + confirm + error (T5), doc tick + TODO removal (T4/T5/T6). All spec sections map to a task.
- **Type consistency:** `forceDrain`/`dismiss` helper names, `QueueActionError`, `ActionSchema`, the route path `/api/admin/businesses/${businessId}/zernio-queue`, and the event types (`zernio_queue_force_drained`, `zernio_queue_response_dismissed`) are used identically across tasks. `ZernioPanelData` fields (`connection.status`, `awaitingOwnerConnect[].responseId`) match `types.ts`.
- **No placeholders:** every code/test step shows complete content; the only deferred detail is the tenant-scope snippet text, which is intentionally reconciled against the audit's own normalized output in T3.
