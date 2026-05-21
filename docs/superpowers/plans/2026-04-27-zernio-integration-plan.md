# Zernio Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual copy-paste posting with Zernio's GBP API as the auto-posting backend, behind `ZERNIO_PUBLISHING_ENABLED` flag, with full graceful-degradation when connections break and durable recovery when finalize outcomes are unknown.

**Architecture:** Three subsystems — (1) headless OAuth connect flow on Vercel + Redis state, (2) ResponsePublisher branches to Zernio reply API for connected businesses, falls through to `awaiting_owner_connect` otherwise, (3) Webhook ingress on Railway for `account.disconnected`. SerpAPI stays as the review ingestion source in v1; Zernio review events ignored but counted for Phase 3 readiness. All state machine details, error classification, race-condition handling, and recovery procedures live in the spec — this plan is the choreography.

**Tech Stack:** Next.js 14 App Router (Vercel API routes), Fastify (Railway ingress), Postgres.js (`postgres` package), ioredis, BullMQ, Sentry, native `fetch` + `AbortController` for Zernio HTTP, `node:crypto` for HMAC, `uuidv7` npm package for app-side UUIDs.

**Source of truth for all code-level details:** `docs/superpowers/specs/2026-04-27-zernio-integration-design.md` (2,490 lines, 17 review rounds applied + 4 round-final gap fixes).

---

## File Map

### NEW files (21)

| File | Responsibility |
|---|---|
| `supabase/migrations/026_zernio_publishing.sql` | Widen `responses.status` to TEXT, create `zernio_connections` + `zernio_finalize_incidents` tables, 4 partial unique indexes, pre-index dedup cleanup |
| `src/lib/zernio/types.ts` | `EndpointKind` union, connection state types, `SendOwnerEmailPayload`, `DrainOwnerConnectPayload`, Zernio API response shapes |
| `src/lib/zernio/errors.ts` | `ZernioAuthError`, `ZernioValidationError`, `ZernioTransientError`, `ZernioPermanentError`, `ZernioReviewNotFoundError`, `ZernioReplyAlreadyExistsError`, `ZernioRouteError(statusCode, code)` |
| `src/lib/zernio/client.ts` | HTTP `request()` primitive with AbortController timeouts, per-endpoint methods, `classifyAndParse` |
| `src/lib/zernio/connect-state.ts` | Redis CSRF state store + 6 shared Lua helpers (`luaCASToFinalizing`, `luaCASRevertToOauth`, `luaCASToFinalizeUnknown`, `luaDeletePendingByFlowIdAnyStatus`, `luaCASCancel`, `luaTokenCAS`) |
| `src/lib/publishing/zernio-publisher.ts` | `lookupZernioReviewId` + `applyTransientExhaustionFallback` |
| `src/lib/notifications/email/templates/owner-reconnect-required.ts` | HTML builder for per-response reconnect email |
| `src/lib/notifications/email/templates/owner-connection-lost.ts` | HTML builder for business-level connection-lost email |
| `src/components/dashboard/ConnectGoogleBanner.tsx` | Banner component reading `data.zernioConnection` from `useDashboardData()` |
| `src/app/(authenticated)/dashboard/connect/page.tsx` | Connect landing page (state-aware UI) |
| `src/app/(authenticated)/dashboard/connect/select-location/page.tsx` | Location picker shown after callback |
| `src/app/api/zernio/connect/start/route.ts` | POST: create Profile, plant pending marker, return authUrl |
| `src/app/api/zernio/connect/callback/route.ts` | GET: validate state, list locations, stash session |
| `src/app/api/zernio/connect/select-location/route.ts` | POST: finalize connection inside finalize-lock |
| `src/app/api/zernio/connect/cancel/route.ts` | POST: owner-initiated cancel of in-flight flow |
| `src/app/api/zernio/disconnect/route.ts` | POST: soft-disconnect an established connection |
| `worker/jobs/OwnerEmailWorker.ts` | Discriminated payload router for `reconnect_required` + `connection_lost` |
| `worker/jobs/DrainOwnerConnectWorker.ts` | Re-enqueue stuck `awaiting_owner_connect` responses |
| `worker/ingress/zernio.ts` | Fastify webhook handler |
| `worker/ingress/zernio-verify.ts` | HMAC-SHA256 signature verification utility |
| `docs/zernio-launch-runbook.md` | Operational runbook including `finalize_unknown` reconciliation procedure |

### MODIFIED files (12)

| File | Change |
|---|---|
| `src/lib/shared/queue-names.ts` | Add `DRAIN_OWNER_CONNECT` + `SEND_OWNER_EMAIL` constants |
| `src/lib/shared/worker-types.ts` | Add `SendOwnerEmailPayload` (discriminated) + `DrainOwnerConnectPayload` |
| `src/lib/shared/subscription-guard.ts` | Extend `WorkerType` union with `'owner_email'` + `'drain'` |
| `src/lib/dashboard/types.ts` | Add `zernioConnection` field to `DashboardDataActive` |
| `src/app/api/dashboard/route.ts` | Populate `zernioConnection` field in response |
| `worker/jobs/ResponsePublisherWorker.ts` | Replace Steps 4-8 with Zernio branch (Sec 4.2 of spec) |
| `worker/jobs/OutboxPoller.ts` | Extend `topicToQueue` map with 3 new entries (round-3 of spec) |
| `worker/queues.ts` | Register `drainOwnerConnect` + `sendOwnerEmail` Queue instances |
| `worker/index.ts` | Register 2 new Workers, attach `publisherWorker.on('failed')`, register `/ingress/zernio` route |
| `worker/startup-assert.ts` | Add Zernio env-var assertions when flag on |
| `worker/ingress/resend.ts` | Add 2 templates to `OWNER_DIRECTED_TEMPLATES` |
| `.claude/CLAUDE.md` | Update tech stack, env vars, status enum, directory tree |

---

## Phase Sequencing

Implementation flows in 6 phases. Each phase is independently shippable behind the flag (which stays `false` throughout). Phases don't strictly require completion of prior phases for COMPILATION — the flag-gate handles runtime safety — but the recommended order ensures each phase is testable in isolation.

| Phase | Tasks | Goal |
|---|---|---|
| **0a — Foundations** | 1–6 | Migration, types, error classes, queue names. Pure additive. |
| **0b — HTTP Client** | 7–11 | Zernio client + classification. Pure module work, fully unit-testable. |
| **0c — Worker Infrastructure** | 12–18 | New workers, OutboxPoller wiring, startup-assert, Resend bounce templates. |
| **0d — Publisher Branching** | 19–22 | ResponsePublisher branch + lookupZernioReviewId + onFailed handler. |
| **0e — Connect Flow** | 23–34 | Routes, pages, banner, dashboard API extension, admin panel. |
| **0f — Webhook + Ops** | 35–40 | Webhook ingress, runbook, CLAUDE.md updates, validation. |

---

# Phase 0a — Foundations

### Task 1: Apply migration 026 (user runs in Supabase SQL editor)

**Files:**
- Create: `supabase/migrations/026_zernio_publishing.sql`

Per CLAUDE.md `feedback_supabase_migrations.md`: write the SQL, hand to user. Do NOT run programmatically.

- [ ] **Step 1: Write migration file**

Copy the COMPLETE SQL from spec §2 (sections 2.1, 2.2, 2.3, 2.4, plus the `zernio_finalize_incidents` table from §2.1 round-15 addition AND the pre-index cleanup + `idx_jo_publish_response_inflight` from §3.3 round-9 addition). The migration must include in this exact order:

  1. `ALTER TABLE responses ALTER COLUMN status TYPE TEXT;` (round-15: widen first)
  2. `DROP INDEX IF EXISTS responses_one_non_terminal_per_review;` + recreate including `'awaiting_owner_connect'`
  3. `CREATE TABLE zernio_connections` with `gen_random_uuid()` default, status CHECK, partial unique index on (`business_id`) WHERE status IN ('pending','active'), and the two ops indexes
  4. `ALTER TABLE zernio_connections ENABLE ROW LEVEL SECURITY;`
  5. `CREATE TABLE zernio_finalize_incidents` with partial unique index WHERE `resolved_at IS NULL` + ops index + RLS
  6. `CREATE UNIQUE INDEX notification_deliveries_owner_reconnect_dedup ON notification_deliveries (response_id, template) WHERE response_id IS NOT NULL AND template = 'owner_reconnect_required';`
  7. `CREATE UNIQUE INDEX notification_deliveries_connection_lost_dedup ON notification_deliveries (business_id, template, (created_at::date)) WHERE template = 'owner_connection_lost';`
  8. Pre-index cleanup: `UPDATE job_outbox SET status='failed' ...` for any existing in-flight `publish_response` duplicates
  9. `CREATE UNIQUE INDEX idx_jo_publish_response_inflight ON job_outbox (topic, aggregate_id) WHERE topic='publish_response' AND status IN ('pending','dispatching','dispatched');`

Add `COMMENT ON INDEX/TABLE` lines from the spec. Header comment summarizing what the migration does.

- [ ] **Step 2: Verify migration syntax locally**

Run `cat supabase/migrations/026_zernio_publishing.sql | head -40` and visually confirm it matches the spec ordering. Look for any `uuidv7()` (raw SQL function, NOT supported — must be `gen_random_uuid()`).

- [ ] **Step 3: Tell the user to run the migration**

Output to user: "Migration 026 ready. Please run `supabase/migrations/026_zernio_publishing.sql` via the Supabase SQL editor. Confirm when done so I can proceed."

WAIT for user confirmation before proceeding to Task 2 (subsequent tasks reference these tables/columns).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/026_zernio_publishing.sql
git commit -m "feat(zernio): add migration 026 — connections + finalize incidents tables"
```

---

### Task 2: Add new queue name constants

**Files:**
- Modify: `src/lib/shared/queue-names.ts`

- [ ] **Step 1: Add 2 constants to QUEUE_NAMES**

Inside the `QUEUE_NAMES` const object (after `ONBOARDING_DRIP`), add:

```typescript
DRAIN_OWNER_CONNECT: 'drain_pending_owner_connect',
SEND_OWNER_EMAIL: 'send_owner_email',
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS (no new errors).

- [ ] **Step 3: Commit**

```bash
git add src/lib/shared/queue-names.ts
git commit -m "feat(zernio): register DRAIN_OWNER_CONNECT and SEND_OWNER_EMAIL queue names"
```

---

### Task 3: Add new payload types

**Files:**
- Modify: `src/lib/shared/worker-types.ts`

- [ ] **Step 1: Add `DrainOwnerConnectPayload` and `SendOwnerEmailPayload`**

Append to the file:

```typescript
export interface DrainOwnerConnectPayload extends BasePayload {
  business_id: string;
}

export type SendOwnerEmailPayload = BasePayload & (
  | { kind: 'reconnect_required'; response_id: string; business_id: string }
  | { kind: 'connection_lost'; business_id: string }
);
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/shared/worker-types.ts
git commit -m "feat(zernio): add DrainOwnerConnectPayload + discriminated SendOwnerEmailPayload"
```

---

### Task 4: Extend `WorkerType` union in subscription-guard

**Files:**
- Modify: `src/lib/shared/subscription-guard.ts`

- [ ] **Step 1: Locate the `WorkerType` type definition**

Run: `grep -n "WorkerType" src/lib/shared/subscription-guard.ts`

Identify the union type. It currently includes things like `'publisher'`, `'notification'`, `'generator'`, etc.

- [ ] **Step 2: Add `'owner_email'` and `'drain'` to the union**

Both new types follow the SAME branch logic as `'publisher'`/`'notification'`: skip on `cancelled`, skip on `past_due` beyond grace, skip on `pending_payment`. No new switch cases needed unless the existing implementation uses workerType to differentiate behavior beyond the standard skip rules — verify.

- [ ] **Step 3: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/shared/subscription-guard.ts
git commit -m "feat(zernio): extend WorkerType union with owner_email + drain"
```

---

### Task 5: Create Zernio types module

**Files:**
- Create: `src/lib/zernio/types.ts`

- [ ] **Step 1: Define types**

Per spec §3.1 + §4.7:

```typescript
export type EndpointKind =
  | 'select_location'
  | 'publish_reply'
  | 'list_reviews'
  | 'list_locations'
  | 'create_profile'
  | 'delete_profile'
  | 'delete_account'
  | 'start_connect';

export type ZernioConnectionStatus = 'pending' | 'active' | 'disconnected';

export interface ZernioConnectionRow {
  id: string;
  business_id: string;
  zernio_profile_id: string;
  zernio_account_id: string;
  zernio_location_id: string;
  status: ZernioConnectionStatus;
  connected_at: Date | null;
  disconnected_at: Date | null;
  disconnect_reason: string | null;
  last_error: string | null;
  last_error_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ZernioReview {
  id: string;
  name: string;
  reviewer: { displayName: string; profilePhotoUrl: string | null; isAnonymous: boolean };
  rating: number;
  starRating: 'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE';
  comment: string | null;
  createTime: string;
  updateTime: string;
  reviewReply: { comment: string; updateTime: string } | null;
}

export interface ZernioLocationOption {
  id: string;
  name: string;
  address: string;
}

export interface ConnectPendingMarker {
  flowId: string;
  userId: string;
  started_at: number;
  status: 'starting' | 'oauth_in_progress' | 'finalizing' | 'finalize_unknown';
  profileId?: string;
  state?: string;
  finalize_unknown_at?: string;
}

export interface ConnectStateBlob {
  businessId: string;
  profileId: string;
  userId: string;
  createdAt: number;
}

export interface ConnectLocationsBlob {
  flowId: string;
  state: string;
  connect_token: string;
  profileId: string;
  businessId: string;
  userId: string;
  locations: ZernioLocationOption[];
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/zernio/types.ts
git commit -m "feat(zernio): add types module (EndpointKind, ConnectionRow, marker shapes)"
```

---

### Task 6: Create Zernio error classes

**Files:**
- Create: `src/lib/zernio/errors.ts`

Per spec §3.1 + §4.7. All error classes extend `Error` and follow the `AuthError` pattern from `src/lib/db/auth.ts:91`.

- [ ] **Step 1: Write error classes**

```typescript
export class ZernioAuthError extends Error {
  constructor(public readonly status: number, public readonly body: string) {
    super(`Zernio auth error (${status}): ${body.slice(0, 200)}`);
    this.name = 'ZernioAuthError';
  }
}

export class ZernioValidationError extends Error {
  constructor(public readonly code: string, public readonly body: unknown) {
    super(`Zernio validation: ${code}`);
    this.name = 'ZernioValidationError';
  }
}

export class ZernioTransientError extends Error {
  constructor(
    public readonly kind: string,  // 'request_timeout' | 'network_error' | 'malformed_response_body' | 'http_5xx' | 'unknown_4xx_unknown_outcome' | etc.
    public readonly meta: Record<string, unknown>,
  ) {
    super(`Zernio transient: ${kind}`);
    this.name = 'ZernioTransientError';
  }
}

export class ZernioPermanentError extends Error {
  constructor(
    public readonly kind: string,  // 'http_400' | 'unknown_4xx' etc.
    public readonly meta: Record<string, unknown>,
  ) {
    super(`Zernio permanent: ${kind}`);
    this.name = 'ZernioPermanentError';
  }
}

export class ZernioReviewNotFoundError extends Error {
  constructor(public readonly meta: Record<string, unknown>) {
    super('Zernio review not found');
    this.name = 'ZernioReviewNotFoundError';
  }
}

export class ZernioReplyAlreadyExistsError extends Error {
  constructor(public readonly body: unknown) {
    super('Zernio reply already exists');
    this.name = 'ZernioReplyAlreadyExistsError';
  }
}

export class ZernioRouteError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string) {
    super(`Zernio route error: ${statusCode} ${code}`);
    this.name = 'ZernioRouteError';
  }
}
```

- [ ] **Step 2: Write unit tests**

**Files:**
- Create: `src/lib/zernio/__tests__/errors.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import {
  ZernioAuthError, ZernioValidationError, ZernioTransientError,
  ZernioPermanentError, ZernioReviewNotFoundError,
  ZernioReplyAlreadyExistsError, ZernioRouteError,
} from '../errors';

describe('Zernio error classes', () => {
  it('ZernioAuthError carries status + body', () => {
    const err = new ZernioAuthError(401, 'unauthorized');
    expect(err.status).toBe(401);
    expect(err.body).toBe('unauthorized');
    expect(err.name).toBe('ZernioAuthError');
  });

  it('ZernioRouteError carries statusCode + code', () => {
    const err = new ZernioRouteError(409, 'finalize_unknown_admin_required');
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe('finalize_unknown_admin_required');
  });

  it('ZernioTransientError preserves kind discriminator', () => {
    const err = new ZernioTransientError('request_timeout', { path: '/x' });
    expect(err.kind).toBe('request_timeout');
    expect(err.meta).toEqual({ path: '/x' });
  });
});
```

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run src/lib/zernio/__tests__/errors.test.ts`
Expected: 3 passed.

- [ ] **Step 4: Commit**

```bash
git add src/lib/zernio/errors.ts src/lib/zernio/__tests__/errors.test.ts
git commit -m "feat(zernio): add error class hierarchy + unit tests"
```

---

# Phase 0b — HTTP Client

### Task 7: Write `classifyAndParse` with TDD

**Files:**
- Create: `src/lib/zernio/__tests__/client.test.ts`
- Create: `src/lib/zernio/client.ts`

Per spec §4.7. This is the trickiest classification logic — TDD it carefully.

- [ ] **Step 1: Write failing tests for classification**

In `src/lib/zernio/__tests__/client.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { classifyAndParse } from '../client';
import {
  ZernioAuthError, ZernioValidationError, ZernioTransientError,
  ZernioPermanentError, ZernioReviewNotFoundError, ZernioReplyAlreadyExistsError,
} from '../errors';

function mkRes(opts: { status: number; body?: unknown; ok?: boolean }): Response {
  const status = opts.status;
  const ok = opts.ok ?? (status >= 200 && status < 300);
  return new Response(opts.body !== undefined ? JSON.stringify(opts.body) : null, { status });
}

describe('classifyAndParse', () => {
  describe('success paths', () => {
    it('parses 200 JSON response', async () => {
      const res = mkRes({ status: 200, body: { foo: 'bar' } });
      const result = await classifyAndParse<{ foo: string }>(res, 'list_reviews');
      expect(result).toEqual({ foo: 'bar' });
    });

    it('returns undefined for 204 No Content', async () => {
      const res = mkRes({ status: 204 });
      const result = await classifyAndParse(res, 'delete_account');
      expect(result).toBeUndefined();
    });

    it('returns undefined for delete_account endpoint regardless of body', async () => {
      const res = mkRes({ status: 200 });
      const result = await classifyAndParse(res, 'delete_account');
      expect(result).toBeUndefined();
    });

    it('throws ZernioTransientError on malformed JSON in 200 response', async () => {
      const res = new Response('not json{', { status: 200 });
      await expect(classifyAndParse(res, 'list_reviews')).rejects.toBeInstanceOf(ZernioTransientError);
    });
  });

  describe('error classification', () => {
    it('401 → ZernioAuthError', async () => {
      const res = mkRes({ status: 401 });
      await expect(classifyAndParse(res, 'select_location')).rejects.toBeInstanceOf(ZernioAuthError);
    });

    it('403 → ZernioAuthError', async () => {
      const res = mkRes({ status: 403 });
      await expect(classifyAndParse(res, 'publish_reply')).rejects.toBeInstanceOf(ZernioAuthError);
    });

    it('409 on publish_reply → ZernioReplyAlreadyExistsError', async () => {
      const res = mkRes({ status: 409, body: { message: 'reply exists' } });
      await expect(classifyAndParse(res, 'publish_reply')).rejects.toBeInstanceOf(ZernioReplyAlreadyExistsError);
    });

    it('409 on non-publish_reply → ZernioTransientError', async () => {
      const res = mkRes({ status: 409, body: {} });
      await expect(classifyAndParse(res, 'select_location')).rejects.toBeInstanceOf(ZernioTransientError);
    });

    it('404 on publish_reply → ZernioReviewNotFoundError', async () => {
      const res = mkRes({ status: 404, body: {} });
      await expect(classifyAndParse(res, 'publish_reply')).rejects.toBeInstanceOf(ZernioReviewNotFoundError);
    });

    it('400 with allowlisted code on select_location → ZernioValidationError', async () => {
      const res = mkRes({ status: 400, body: { code: 'invalid_connect_token' } });
      await expect(classifyAndParse(res, 'select_location')).rejects.toBeInstanceOf(ZernioValidationError);
    });

    it('400 with non-allowlisted code on select_location → ZernioTransientError unknown_4xx_unknown_outcome', async () => {
      const res = mkRes({ status: 400, body: { code: 'random_other' } });
      await expect(classifyAndParse(res, 'select_location')).rejects.toMatchObject({
        name: 'ZernioTransientError',
        kind: 'unknown_4xx_unknown_outcome',
      });
    });

    it('400 on publish_reply → ZernioPermanentError (NOT ValidationError, even with allowlisted code)', async () => {
      const res = mkRes({ status: 400, body: { code: 'invalid_connect_token' } });
      await expect(classifyAndParse(res, 'publish_reply')).rejects.toBeInstanceOf(ZernioPermanentError);
    });

    it('500 → ZernioTransientError http_500', async () => {
      const res = mkRes({ status: 500 });
      await expect(classifyAndParse(res, 'select_location')).rejects.toMatchObject({
        name: 'ZernioTransientError',
        kind: 'http_500',
      });
    });

    it('429 → ZernioTransientError http_429', async () => {
      const res = mkRes({ status: 429 });
      await expect(classifyAndParse(res, 'publish_reply')).rejects.toMatchObject({
        name: 'ZernioTransientError',
        kind: 'http_429',
      });
    });
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `pnpm vitest run src/lib/zernio/__tests__/client.test.ts`
Expected: All FAIL with "classifyAndParse not exported".

- [ ] **Step 3: Implement `classifyAndParse` per spec §4.7**

In `src/lib/zernio/client.ts`, copy the EXACT pseudocode from spec §4.7 (the round-17-corrected version that handles 204/no-body endpoints, malformed JSON, endpoint-aware allowlist gating). Critical points:

  - `NO_BODY_ENDPOINTS = new Set<EndpointKind>(['delete_profile', 'delete_account'])`
  - For `res.ok`: 204 OR no-body-endpoint OR empty text → `return undefined as unknown as T`; else parse with try/catch
  - For 401/403: `ZernioAuthError`
  - For 409 + `endpointKind === 'publish_reply'`: `ZernioReplyAlreadyExistsError`
  - For 404 + `endpointKind === 'publish_reply'`: `ZernioReviewNotFoundError`
  - For 400 + `endpointKind === 'select_location'`: PRE_MUTATION_400_CODES → ValidationError; else TransientError(`unknown_4xx_unknown_outcome`)
  - For 400 on other endpoints: ALL → `ZernioPermanentError(http_400)`
  - For everything else (5xx, 429, other 4xx): `ZernioTransientError(http_${status})`

- [ ] **Step 4: Run tests — verify they pass**

Run: `pnpm vitest run src/lib/zernio/__tests__/client.test.ts`
Expected: All passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/zernio/client.ts src/lib/zernio/__tests__/client.test.ts
git commit -m "feat(zernio): classifyAndParse with endpoint-aware error mapping"
```

---

### Task 8: Implement `request()` primitive with timeouts

**Files:**
- Modify: `src/lib/zernio/client.ts`

Per spec §4.6.

- [ ] **Step 1: Write tests for timeout behavior**

Append to `src/lib/zernio/__tests__/client.test.ts`:

```typescript
describe('request() timeout handling', () => {
  it('AbortError → ZernioTransientError with kind=request_timeout', async () => {
    // Stub global.fetch to throw AbortError
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    try {
      const { request } = await import('../client');
      await expect(request({
        method: 'GET',
        path: '/v1/test',
        endpointKind: 'list_reviews',
        timeoutMs: 100,
      })).rejects.toMatchObject({ name: 'ZernioTransientError', kind: 'request_timeout' });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('TypeError (DNS/socket failure) → ZernioTransientError with kind=network_error', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    try {
      const { request } = await import('../client');
      await expect(request({
        method: 'GET',
        path: '/v1/test',
        endpointKind: 'list_reviews',
      })).rejects.toMatchObject({ name: 'ZernioTransientError', kind: 'network_error' });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('preserves already-classified Zernio errors (no double-wrap)', async () => {
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    try {
      const { request } = await import('../client');
      await expect(request({
        method: 'GET',
        path: '/v1/test',
        endpointKind: 'select_location',
      })).rejects.toMatchObject({ name: 'ZernioAuthError' });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
```

(Add `import { vi } from 'vitest'` at top of the file.)

- [ ] **Step 2: Implement `request()` per spec §4.6 with round-16 fixes**

Add to `src/lib/zernio/client.ts`. Key points:
  - `const timeoutMs = opts.timeoutMs ?? 10_000` BEFORE setTimeout (round-16 fix)
  - AbortController + setTimeout(controller.abort, timeoutMs)
  - In catch: preserve all Zernio* error classes (don't re-wrap), AbortError → `request_timeout`, everything else → `network_error`
  - Return `await classifyAndParse<T>(res, opts.endpointKind)`

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run src/lib/zernio/__tests__/client.test.ts`
Expected: All passed.

- [ ] **Step 4: Commit**

```bash
git add src/lib/zernio/client.ts src/lib/zernio/__tests__/client.test.ts
git commit -m "feat(zernio): request() primitive with AbortController + network error wrapping"
```

---

### Task 9: Implement per-endpoint client methods

**Files:**
- Modify: `src/lib/zernio/client.ts`

- [ ] **Step 1: Add per-endpoint methods**

Each method calls `request()` with the appropriate `endpointKind` and timeout (per spec §4.6 timeout budget table). Methods to implement:

```typescript
export const zernioClient = {
  createProfile: (input: { name: string }) => request<{ profileId: string }>({
    method: 'POST', path: '/v1/profiles', endpointKind: 'create_profile',
    body: input, timeoutMs: 10_000,
  }),
  startConnect: (input: { profileId: string; state: string; redirectUrl: string }) =>
    request<{ authUrl: string }>({
      method: 'GET',
      path: `/v1/connect/google-business?profileId=${input.profileId}&headless=true&redirectUrl=${encodeURIComponent(input.redirectUrl)}&state=${input.state}`,
      endpointKind: 'start_connect', timeoutMs: 10_000,
    }),
  listLocations: (input: { connectToken: string }) =>
    request<{ locations: ZernioLocationOption[] }>({
      method: 'GET', path: '/v1/connect/google-business/list-locations',
      endpointKind: 'list_locations', timeoutMs: 10_000,
      headers: { 'X-Connect-Token': input.connectToken },
    }),
  selectLocation: (input: { connectToken: string; locationId: string }) =>
    request<{ accountId: string }>({
      method: 'POST', path: '/v1/connect/google-business/select-location',
      endpointKind: 'select_location', timeoutMs: 15_000,
      headers: { 'X-Connect-Token': input.connectToken },
      body: { locationId: input.locationId },
    }),
  listReviews: (accountId: string, input: { pageSize?: number; pageToken?: string }) =>
    request<{ reviews: ZernioReview[]; nextPageToken?: string }>({
      method: 'GET',
      path: `/v1/accounts/${accountId}/gmb-reviews?pageSize=${input.pageSize ?? 50}${input.pageToken ? `&pageToken=${input.pageToken}` : ''}`,
      endpointKind: 'list_reviews', timeoutMs: 15_000,
    }),
  listAllReviews: async (accountId: string, opts: { pageSize: number; maxPages: number }) => {
    const all: ZernioReview[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < opts.maxPages; i++) {
      const page = await zernioClient.listReviews(accountId, { pageSize: opts.pageSize, pageToken });
      all.push(...page.reviews);
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }
    return all;
  },
  postReply: (accountId: string, reviewId: string, input: { comment: string }) =>
    request<{ comment: string; updateTime: string }>({
      method: 'POST', path: `/v1/accounts/${accountId}/gmb-reviews/${reviewId}/reply`,
      endpointKind: 'publish_reply', timeoutMs: 15_000,
      body: { comment: input.comment },
    }),
  deleteAccount: (accountId: string) => request<void>({
    method: 'DELETE', path: `/v1/accounts/${accountId}`,
    endpointKind: 'delete_account', timeoutMs: 10_000,
  }),
  deleteProfile: (profileId: string) => request<void>({
    method: 'DELETE', path: `/v1/profiles/${profileId}`,
    endpointKind: 'delete_profile', timeoutMs: 10_000,
  }),
};
```

The `request()` private helper reads `process.env.ZERNIO_API_KEY` and `ZERNIO_API_BASE` (defaults to `'https://zernio.com/api'`) on each call (NOT module-level — this is critical for mock mode).

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/zernio/client.ts
git commit -m "feat(zernio): per-endpoint client methods with timeout budgets"
```

---

### Task 10: Mock mode bypass

**Files:**
- Modify: `src/lib/zernio/client.ts`

Per spec §6.5 (Testing approach — mock mode short-circuits all Zernio calls).

- [ ] **Step 1: Add mock-mode short-circuit at top of `request()`**

```typescript
async function request<T>(opts: { ...same as before... }): Promise<T> {
  if (process.env.MOCK_EXTERNAL_APIS === 'true') {
    return await mockResponse<T>(opts);
  }
  // ...existing implementation
}

async function mockResponse<T>(opts: {
  endpointKind: EndpointKind;
  // ...
}): Promise<T> {
  switch (opts.endpointKind) {
    case 'create_profile':
      return { profileId: `mock-profile-${Date.now()}` } as unknown as T;
    case 'start_connect':
      return { authUrl: 'http://localhost:3000/__mock_oauth_complete' } as unknown as T;
    case 'list_locations':
      return { locations: [{ id: 'mock-loc-1', name: 'Mock Location', address: '123 Mock St' }] } as unknown as T;
    case 'select_location':
      return { accountId: `mock-account-${Date.now()}` } as unknown as T;
    case 'list_reviews':
      return { reviews: [], nextPageToken: undefined } as unknown as T;
    case 'publish_reply':
      return { comment: 'mock reply', updateTime: new Date().toISOString() } as unknown as T;
    case 'delete_account':
    case 'delete_profile':
      return undefined as unknown as T;
  }
}
```

- [ ] **Step 2: Add a mock-mode test**

Append to `src/lib/zernio/__tests__/client.test.ts`:

```typescript
describe('mock mode', () => {
  beforeEach(() => { process.env.MOCK_EXTERNAL_APIS = 'true'; });
  afterEach(() => { delete process.env.MOCK_EXTERNAL_APIS; });

  it('createProfile returns a fake profileId without hitting fetch', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const result = await zernioClient.createProfile({ name: 'test' });
    expect(result.profileId).toMatch(/^mock-profile-/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

(Add `import { beforeEach, afterEach } from 'vitest'` if not present.)

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run src/lib/zernio/__tests__/client.test.ts`
Expected: All passed.

- [ ] **Step 4: Commit**

```bash
git add src/lib/zernio/client.ts src/lib/zernio/__tests__/client.test.ts
git commit -m "feat(zernio): mock mode bypass for local dev without sandbox creds"
```

---

### Task 11: Create `connect-state.ts` with shared Lua helpers

**Files:**
- Create: `src/lib/zernio/connect-state.ts`

Per spec §3.1 round-final note + §3.2 step 3.

- [ ] **Step 1: Write the module**

```typescript
import { getCacheRedis } from '@/lib/db/redis';
import { randomBytes } from 'node:crypto';
import type { ConnectPendingMarker, ConnectStateBlob, ConnectLocationsBlob } from './types';

// ─── Shared Lua scripts ─────────────────────────────────────────────────

export const luaTokenCAS = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end`;

export const luaCASToFinalizing = `
  local raw = redis.call("get", KEYS[1])
  if not raw then return -1 end
  local ok, p = pcall(cjson.decode, raw)
  if not ok then return -2 end
  if p.flowId ~= ARGV[1] then return 0 end
  if p.status ~= "oauth_in_progress" then return -3 end
  p.status = "finalizing"
  return redis.call("set", KEYS[1], cjson.encode(p), "EX", ARGV[2])
`;

export const luaCASRevertToOauth = `
  local raw = redis.call("get", KEYS[1])
  if not raw then return -1 end
  local ok, p = pcall(cjson.decode, raw)
  if not ok then return -2 end
  if p.flowId ~= ARGV[1] then return 0 end
  if p.status ~= "finalizing" then return -3 end
  p.status = "oauth_in_progress"
  return redis.call("set", KEYS[1], cjson.encode(p), "EX", ARGV[2])
`;

export const luaCASToFinalizeUnknown = `
  local raw = redis.call("get", KEYS[1])
  if not raw then return -1 end
  local ok, p = pcall(cjson.decode, raw)
  if not ok then return -2 end
  if p.flowId ~= ARGV[1] then return 0 end
  if p.status ~= "finalizing" then return -3 end
  p.status = "finalize_unknown"
  p.finalize_unknown_at = ARGV[3]
  return redis.call("set", KEYS[1], cjson.encode(p), "EX", ARGV[2])
`;

export const luaDeletePendingByFlowIdAnyStatus = `
  local raw = redis.call("get", KEYS[1])
  if not raw then return 0 end
  local ok, p = pcall(cjson.decode, raw)
  if not ok then return 0 end
  if p.flowId == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

export const luaCASCancel = `
  local raw = redis.call("get", KEYS[1])
  if not raw then return 0 end
  local ok, p = pcall(cjson.decode, raw)
  if not ok then return 0 end
  if p.flowId ~= ARGV[1] then return 0 end
  if p.status == "finalizing" then return -1 end
  if p.status == "finalize_unknown" then return -2 end
  return redis.call("del", KEYS[1])
`;

// ─── Key helpers ────────────────────────────────────────────────────────

export const pendingKey = (businessId: string) => `connect_pending:${businessId}`;
export const stateKey = (state: string) => `connect_state:${state}`;
export const locationsKey = (sessionId: string) => `connect_locations:${sessionId}`;
export const lockKey = (businessId: string) => `connect_lock:${businessId}`;
export const finalizeLockKey = (sessionId: string) => `connect_finalize:${sessionId}`;

export const generateFlowId = () => randomBytes(16).toString('hex');
export const generateState = () => randomBytes(32).toString('hex');
export const generateLockToken = () => randomBytes(16).toString('hex');
export const generateSessionId = () => randomBytes(16).toString('hex');
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/zernio/connect-state.ts
git commit -m "feat(zernio): shared Lua helpers + key generators for connect flow"
```

---

# Phase 0c — Worker Infrastructure

### Task 12: Register new queues in `worker/queues.ts`

**Files:**
- Modify: `worker/queues.ts`

- [ ] **Step 1: Add 2 queue instances**

Inside the `queues` object:

```typescript
drainOwnerConnect: new Queue(QUEUE_NAMES.DRAIN_OWNER_CONNECT, { connection: opts, defaultJobOptions }),
sendOwnerEmail: new Queue(QUEUE_NAMES.SEND_OWNER_EMAIL, { connection: opts, defaultJobOptions }),
```

- [ ] **Step 2: Update `topicToQueue` map with 3 entries**

Per spec §2.4 round-3 correction. Inside `topicToQueue`:

```typescript
[QUEUE_NAMES.DRAIN_OWNER_CONNECT]: queues.drainOwnerConnect,
// Topic strings aliased to the OwnerEmail queue (round-3 correction):
['notify_owner_reconnect']: queues.sendOwnerEmail,
['notify_owner_connection_lost']: queues.sendOwnerEmail,
```

- [ ] **Step 3: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add worker/queues.ts
git commit -m "feat(zernio): register DRAIN_OWNER_CONNECT + SEND_OWNER_EMAIL queues"
```

---

### Task 13: Create email templates

**Files:**
- Create: `src/lib/notifications/email/templates/owner-reconnect-required.ts`
- Create: `src/lib/notifications/email/templates/owner-connection-lost.ts`

Mirror `templates/owner-nudge.ts` shape.

- [ ] **Step 1: Write `owner-reconnect-required.ts`**

```typescript
import { escapeHtml } from '@/lib/shared/html';

interface Input {
  businessName: string;
  reviewerName: string;
  dashboardConnectUrl: string;
}

export function buildOwnerReconnectRequiredEmailHtml(input: Input): string {
  const { businessName, reviewerName, dashboardConnectUrl } = input;
  return `
<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="color:#111">Your reply to ${escapeHtml(reviewerName)} is ready to publish</h2>
  <p>You approved a response for ${escapeHtml(businessName)}, but your Google Business connection isn't currently linked.</p>
  <p>Reconnect to publish this reply (and any others queued behind it).</p>
  <p style="margin-top:32px">
    <a href="${escapeHtml(dashboardConnectUrl)}" style="background:#2563eb;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Reconnect Google Business</a>
  </p>
</body></html>`;
}
```

- [ ] **Step 2: Write `owner-connection-lost.ts`**

```typescript
import { escapeHtml } from '@/lib/shared/html';

interface Input {
  businessName: string;
  queuedCount: number;
  dashboardConnectUrl: string;
}

export function buildOwnerConnectionLostEmailHtml(input: Input): string {
  const { businessName, queuedCount, dashboardConnectUrl } = input;
  const queuedNote = queuedCount > 0
    ? `<p>You currently have ${queuedCount} approved ${queuedCount === 1 ? 'reply' : 'replies'} waiting to publish.</p>`
    : '';
  return `
<!DOCTYPE html>
<html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;">
  <h2 style="color:#111">Google Business connection paused for ${escapeHtml(businessName)}</h2>
  <p>We noticed your Google Business connection is no longer active. New replies will queue until you reconnect.</p>
  ${queuedNote}
  <p style="margin-top:32px">
    <a href="${escapeHtml(dashboardConnectUrl)}" style="background:#2563eb;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block">Reconnect Google Business</a>
  </p>
</body></html>`;
}
```

- [ ] **Step 3: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/notifications/email/templates/owner-reconnect-required.ts src/lib/notifications/email/templates/owner-connection-lost.ts
git commit -m "feat(zernio): owner reconnect/connection-lost email templates"
```

---

### Task 14: Create `OwnerEmailWorker`

**Files:**
- Create: `worker/jobs/OwnerEmailWorker.ts`

Per spec §2.4 (OwnerEmailWorker behavior — both handlers MUST honor `owner_email_bounced`).

- [ ] **Step 1: Write the worker**

```typescript
import type { Job } from 'bullmq';
import { v7 as uuidv7 } from 'uuid';
import { sql } from '../../src/lib/db/server';
import { checkSubscription } from '../../src/lib/shared/subscription-guard';
import { markOutboxCompleted, markOutboxFailed, extractOutboxHandle } from '../../src/lib/shared/outbox';
import { sendInternalEmail } from '../../src/lib/notifications/email';
import { buildOwnerReconnectRequiredEmailHtml } from '../../src/lib/notifications/email/templates/owner-reconnect-required';
import { buildOwnerConnectionLostEmailHtml } from '../../src/lib/notifications/email/templates/owner-connection-lost';
import type { SendOwnerEmailPayload } from '../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../src/lib/shared/logger';

export async function handleOwnerEmail(job: Job<SendOwnerEmailPayload>): Promise<void> {
  const logger = createWorkerLogger('[OwnerEmailWorker]', job.data.correlation_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // Both kinds: load business, subscription guard, owner_email_bounced check.
  const [business] = await sql<{
    id: string; name: string; owner_email: string;
    owner_email_bounced: boolean;
    subscription_status: string; updated_at: Date;
  }[]>`
    SELECT id, name, owner_email, owner_email_bounced, subscription_status, updated_at
    FROM businesses WHERE id = ${job.data.business_id}
  `;
  if (!business) {
    await markOutboxFailed(outboxId, 'business_not_found', outboxAttempt);
    return;
  }

  const sub = checkSubscription(business.subscription_status, new Date(business.updated_at), 'owner_email');
  if (!sub.allowed) {
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  if (business.owner_email_bounced) {
    logger.log(`Business ${business.id} owner email bounced — skipping`);
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  if (job.data.kind === 'reconnect_required') {
    await sendReconnectRequired(job.data, business, outboxId, outboxAttempt, logger);
  } else {
    await sendConnectionLost(job.data, business, outboxId, outboxAttempt, logger);
  }
}

async function sendReconnectRequired(
  payload: Extract<SendOwnerEmailPayload, { kind: 'reconnect_required' }>,
  business: { id: string; name: string; owner_email: string },
  outboxId: string,
  outboxAttempt: number,
  logger: ReturnType<typeof createWorkerLogger>,
) {
  // Load response, check status — must still be awaiting_owner_connect.
  const [response] = await sql<{ status: string; review_id: string }[]>`
    SELECT status, review_id FROM responses
    WHERE id = ${payload.response_id} AND business_id = ${payload.business_id}
  `;
  if (!response || response.status !== 'awaiting_owner_connect') {
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  const [review] = await sql<{ reviewer_name: string }[]>`
    SELECT reviewer_name FROM reviews WHERE id = ${response.review_id}
  `;

  // Claim-before-send (uses migration 026's notification_deliveries_owner_reconnect_dedup index).
  const deliveryId = uuidv7();
  const claimed = await sql<{ id: string }[]>`
    INSERT INTO notification_deliveries
      (id, business_id, response_id, channel, recipient, template)
    VALUES
      (${deliveryId}, ${business.id}, ${payload.response_id}, 'email',
       ${business.owner_email}, 'owner_reconnect_required')
    ON CONFLICT (response_id, template)
      WHERE response_id IS NOT NULL AND template = 'owner_reconnect_required'
      DO NOTHING
    RETURNING id
  `;
  if (claimed.length === 0) {
    await markOutboxCompleted(outboxId, outboxAttempt);
    return;
  }

  const dashboardConnectUrl = `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/connect`;
  const bodyHtml = buildOwnerReconnectRequiredEmailHtml({
    businessName: business.name,
    reviewerName: review?.reviewer_name ?? 'a reviewer',
    dashboardConnectUrl,
  });

  let messageId: string;
  try {
    const result = await sendInternalEmail({
      to: business.owner_email,
      subject: `Your reply for ${business.name} is ready to publish`,
      bodyHtml,
      category: 'owner',
    });
    messageId = result.messageId;
  } catch (err) {
    await sql`DELETE FROM notification_deliveries WHERE id = ${deliveryId} AND external_message_id IS NULL`.catch(() => {});
    throw err;
  }
  await sql`UPDATE notification_deliveries SET external_message_id = ${messageId}, sent_at = NOW() WHERE id = ${deliveryId}`;
  await markOutboxCompleted(outboxId, outboxAttempt);
}

async function sendConnectionLost(/* same shape, business-scoped, no response */) {
  // Same claim-before-send pattern using template='owner_connection_lost'
  // and the per-day dedup index. Implementation details mirror sendReconnectRequired.
  // ... (omitted here for brevity; copy the structure from sendReconnectRequired)
}
```

- [ ] **Step 2: Implement `sendConnectionLost` analogously**

Same claim pattern but:
  - Query `awaiting_owner_connect` count for queuedCount
  - INSERT with `template = 'owner_connection_lost'` (note: dedup index is on `(business_id, template, created_at::date)`, so multiple sends per day are blocked by the partial unique index)
  - Subject: `Google Business connection paused for ${business.name}`
  - Body: `buildOwnerConnectionLostEmailHtml({ businessName, queuedCount, dashboardConnectUrl })`

- [ ] **Step 3: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add worker/jobs/OwnerEmailWorker.ts
git commit -m "feat(zernio): OwnerEmailWorker for reconnect_required + connection_lost templates"
```

---

### Task 15: Create `DrainOwnerConnectWorker`

**Files:**
- Create: `worker/jobs/DrainOwnerConnectWorker.ts`

Per spec §3.3.

- [ ] **Step 1: Write the worker**

```typescript
import type { Job } from 'bullmq';
import { sql } from '../../src/lib/db/server';
import { markOutboxCompleted, extractOutboxHandle } from '../../src/lib/shared/outbox';
import type { DrainOwnerConnectPayload } from '../../src/lib/shared/worker-types';
import { createWorkerLogger } from '../../src/lib/shared/logger';

export async function handleDrainOwnerConnect(job: Job<DrainOwnerConnectPayload>): Promise<void> {
  const logger = createWorkerLogger('[DrainOwnerConnectWorker]', job.data.correlation_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  // Bulk insert with NOT EXISTS guard + ON CONFLICT DO NOTHING (round-7 + round-8 fixes).
  // Uses gen_random_uuid() inline (per-row DB-side UUID — round-12 fix).
  const result = await sql`
    WITH stuck AS (
      SELECT id, business_id FROM responses
      WHERE business_id = ${job.data.business_id} AND status = 'awaiting_owner_connect'
    )
    INSERT INTO job_outbox (
      id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
    )
    SELECT gen_random_uuid(), 'publish_response', 'response', stuck.id,
      jsonb_build_object('response_id', stuck.id, 'business_id', stuck.business_id),
      0, 5
    FROM stuck
    WHERE NOT EXISTS (
      SELECT 1 FROM job_outbox jo
      WHERE jo.topic = 'publish_response'
        AND jo.aggregate_id = stuck.id
        AND jo.status IN ('pending', 'dispatching', 'dispatched')
    )
    ON CONFLICT (topic, aggregate_id)
      WHERE topic = 'publish_response'
        AND status IN ('pending', 'dispatching', 'dispatched')
    DO NOTHING
  `;

  logger.log(`Drained business ${job.data.business_id}: ${result.count} new publish_response rows`);
  await markOutboxCompleted(outboxId, outboxAttempt);
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add worker/jobs/DrainOwnerConnectWorker.ts
git commit -m "feat(zernio): DrainOwnerConnectWorker — re-enqueue stuck publish_response rows"
```

---

### Task 16: Register new workers in `worker/index.ts`

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Import handlers + register Worker instances**

After the existing Worker construction lines (e.g. after `onboardingDripWorker`):

```typescript
import { handleOwnerEmail } from './jobs/OwnerEmailWorker';
import { handleDrainOwnerConnect } from './jobs/DrainOwnerConnectWorker';

const ownerEmailWorker = new Worker(QUEUE_NAMES.SEND_OWNER_EMAIL, handleOwnerEmail, workerOpts);
const drainOwnerConnectWorker = new Worker(QUEUE_NAMES.DRAIN_OWNER_CONNECT, handleDrainOwnerConnect, workerOpts);
```

- [ ] **Step 2: Add to graceful shutdown if applicable**

If the existing pattern adds workers to a `workersToClose` array or similar shutdown handler, add the two new ones.

- [ ] **Step 3: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add worker/index.ts
git commit -m "feat(zernio): register OwnerEmailWorker + DrainOwnerConnectWorker in worker/index.ts"
```

---

### Task 17: Add Zernio env-var assertions to `worker/startup-assert.ts`

**Files:**
- Modify: `worker/startup-assert.ts`

Per spec §5.6.

- [ ] **Step 1: Add assertion block**

Mirror the `CHANNELS_*_ENABLED` pattern from existing channel asserts:

```typescript
if (process.env.ZERNIO_PUBLISHING_ENABLED === 'true' && process.env.MOCK_EXTERNAL_APIS !== 'true') {
  assertEnvVar('ZERNIO_API_KEY');
  assertEnvVar('ZERNIO_WEBHOOK_SECRET');
  assertEnvVar('WORKER_PUBLIC_URL');
  assertEnvVar('NEXT_PUBLIC_APP_URL');
  // ZERNIO_PROFILE_ID_PREFIX is optional, defaults to 'repworth-prod-'
}
```

(`assertEnvVar` is whatever helper the existing code uses — match the pattern.)

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add worker/startup-assert.ts
git commit -m "feat(zernio): startup assert for ZERNIO_API_KEY + ZERNIO_WEBHOOK_SECRET"
```

---

### Task 18: Extend Resend bounce handler `OWNER_DIRECTED_TEMPLATES`

**Files:**
- Modify: `worker/ingress/resend.ts`

Per spec §5.5 round-1 correction.

- [ ] **Step 1: Add 2 templates to the set**

Around line 127, the `OWNER_DIRECTED_TEMPLATES` Set. Add:

```typescript
'owner_reconnect_required',
'owner_connection_lost',
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add worker/ingress/resend.ts
git commit -m "feat(zernio): mark new owner email templates as owner-directed for bounce handling"
```

---

# Phase 0d — Publisher Branching

### Task 19: Implement `lookupZernioReviewId`

**Files:**
- Create: `src/lib/publishing/zernio-publisher.ts`
- Create: `src/lib/publishing/__tests__/zernio-publisher.test.ts`

Per spec §4.3 + round-final note about edited reviews.

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { lookupZernioReviewId } from '../zernio-publisher';

vi.mock('@/lib/db/redis');
vi.mock('@/lib/db/server');
vi.mock('@/lib/zernio/client');

describe('lookupZernioReviewId', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns cached value on hit', async () => {
    const { getCacheRedis } = await import('@/lib/db/redis');
    (getCacheRedis as any).mockReturnValue({ get: vi.fn().mockResolvedValue('cached-zernio-id') });
    const result = await lookupZernioReviewId('biz1', 'our1', 'acct1');
    expect(result).toBe('cached-zernio-id');
  });

  it('throws ZernioReviewNotFoundError when our review is missing', async () => {
    const { getCacheRedis } = await import('@/lib/db/redis');
    const { sql } = await import('@/lib/db/server');
    (getCacheRedis as any).mockReturnValue({ get: vi.fn().mockResolvedValue(null) });
    (sql as any).mockResolvedValue([]);
    await expect(lookupZernioReviewId('biz1', 'our1', 'acct1')).rejects.toMatchObject({ name: 'ZernioReviewNotFoundError' });
  });

  it('matches by displayName + rating + comment + createTime±24h', async () => {
    // Mock our review + Zernio reviews + verify the match.
    // (Test details — set up sql/zernio mocks appropriately and assert returned id.)
  });
});
```

- [ ] **Step 2: Implement per spec §4.3 (post-round-11 destructure pattern + round-final edited-reviews note as a comment)**

```typescript
import { getCacheRedis } from '@/lib/db/redis';
import { sql } from '@/lib/db/server';
import { zernioClient } from '@/lib/zernio/client';
import { ZernioReviewNotFoundError } from '@/lib/zernio/errors';

export async function lookupZernioReviewId(
  businessId: string,
  ourReviewId: string,
  accountId: string,
): Promise<string> {
  const redis = getCacheRedis();
  const cacheKey = `zernio_review_map:${businessId}:${ourReviewId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return cached;

  const [ourReview] = await sql<{
    reviewer_name: string;
    review_date: Date;
    review_text: string | null;
    star_rating: number;
  }[]>`
    SELECT reviewer_name, review_date, review_text, star_rating
    FROM reviews
    WHERE id = ${ourReviewId} AND business_id = ${businessId}
    LIMIT 1
  `;
  if (!ourReview) {
    throw new ZernioReviewNotFoundError({ ourReviewId, accountId, reason: 'review_not_found_or_wrong_business' });
  }

  const zernioReviews = await zernioClient.listAllReviews(accountId, { pageSize: 50, maxPages: 4 });

  const ourComment = (ourReview.review_text ?? '').trim();
  const match = zernioReviews.find(z =>
    z.reviewer.displayName === ourReview.reviewer_name &&
    z.rating === ourReview.star_rating &&
    (z.comment ?? '').trim() === ourComment &&
    Math.abs(new Date(z.createTime).getTime() - ourReview.review_date.getTime()) < 86400000
  );

  if (!match) {
    throw new ZernioReviewNotFoundError({
      ourReviewId, accountId,
      candidatesChecked: zernioReviews.length, reason: 'no_field_match',
    });
  }

  await redis.setex(cacheKey, 86400, match.id);
  return match.id;
}
```

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run src/lib/publishing/__tests__/zernio-publisher.test.ts`
Expected: All passed.

- [ ] **Step 4: Commit**

```bash
git add src/lib/publishing/zernio-publisher.ts src/lib/publishing/__tests__/zernio-publisher.test.ts
git commit -m "feat(zernio): lookupZernioReviewId with Redis cache + 4-page pagination"
```

---

### Task 20: Implement `applyTransientExhaustionFallback`

**Files:**
- Modify: `src/lib/publishing/zernio-publisher.ts`

Per spec §4.4 (BullMQ exhaustion handling).

- [ ] **Step 1: Add the helper**

Single-tx mutation block matching the in-worker auth-error path (Section 4.2):

```typescript
import type { PublishResponsePayload } from '@/lib/shared/worker-types';

export async function applyTransientExhaustionFallback(payload: PublishResponsePayload): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE zernio_connections
      SET status='disconnected', disconnected_at=NOW(),
          disconnect_reason='transient_max_attempts',
          last_error='BullMQ retries exhausted', last_error_at=NOW()
      WHERE business_id = ${payload.business_id} AND status='active'
    `;
    const updated = await tx`
      UPDATE responses SET status='awaiting_owner_connect', updated_at=NOW()
      WHERE id = ${payload.response_id} AND business_id = ${payload.business_id}
        AND status IN ('approved','edited','awaiting_owner_connect')
      RETURNING 1
    `;
    if (updated.count === 0) return;
    // Both notify outbox rows (per spec §4.2 round-13 fix)
    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts)
      VALUES
        (${uuidv7()}, 'notify_owner_reconnect', 'response', ${payload.response_id},
         ${jsonb({ kind: 'reconnect_required', response_id: payload.response_id, business_id: payload.business_id })}, 0, 5),
        (${uuidv7()}, 'notify_owner_connection_lost', 'business', ${payload.business_id},
         ${jsonb({ kind: 'connection_lost', business_id: payload.business_id })}, 0, 5)
    `;
  });
}
```

(Use the existing `jsonb()` helper from `@/lib/db/server` per CLAUDE.md lab note 2026-04-18.)

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/publishing/zernio-publisher.ts
git commit -m "feat(zernio): applyTransientExhaustionFallback for BullMQ exhaustion"
```

---

### Task 21: Replace `ResponsePublisherWorker` Steps 4-8 with Zernio branch

**Files:**
- Modify: `worker/jobs/ResponsePublisherWorker.ts`

Per spec §4.2. **Most complex single change in the plan.** Implement EXACTLY per the spec's pseudocode — every status guard, every CONFLICT clause, every error branch is load-bearing.

- [ ] **Step 1: Read the spec section thoroughly**

Open `docs/superpowers/specs/2026-04-27-zernio-integration-design.md` and read all of §4 (sections 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7). All five branches (200 OK, 409, ZernioAuthError, ZernioTransientError, ZernioReviewNotFoundError, ZernioPermanentError) plus the no-connection branch are needed.

- [ ] **Step 2: Preserve Steps 1-3 unchanged**

The existing Steps 1-3 (load response/business, idempotency check on `status='posted'`, subscription guard via `checkSubscription`) stay EXACTLY as they are. Only the remainder is replaced.

- [ ] **Step 3: Add Step 4 — load Zernio connection**

```typescript
const [zernio] = await sql<{ zernio_account_id: string; zernio_location_id: string }[]>`
  SELECT zernio_account_id, zernio_location_id
  FROM zernio_connections
  WHERE business_id = ${business_id} AND status = 'active'
  LIMIT 1
`;
```

- [ ] **Step 4: Add Step 5 — branch on connection presence**

If no `zernio` row, run the no-connection branch from spec §4.2 (status guard + outbox enqueue). If present, run the connection-active branch with all 6 sub-cases. Use `lookupZernioReviewId` for the Zernio review id.

- [ ] **Step 5: Wire up the new error classes**

Import: `ZernioAuthError`, `ZernioTransientError`, `ZernioReviewNotFoundError`, `ZernioReplyAlreadyExistsError`, `ZernioPermanentError`. Each branch handles its specific error class per the pseudocode.

- [ ] **Step 6: Confirm the legacy `awaiting_manual_post` path is preserved**

The retired-by-default `awaiting_manual_post` write still happens ONLY when triggered via the admin "Manually post" action (not from this worker's normal flow). Verify by reading the worker top-to-bottom that the new branch never falls through to the old `awaiting_manual_post` SET.

- [ ] **Step 7: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add worker/jobs/ResponsePublisherWorker.ts
git commit -m "feat(zernio): branch ResponsePublisher to Zernio when connection active"
```

---

### Task 22: Attach `publisherWorker.on('failed')` handler in `worker/index.ts`

**Files:**
- Modify: `worker/index.ts`

Per spec §4.4 round-12 + round-13 final form.

- [ ] **Step 1: Add the handler immediately after `publisherWorker = new Worker(...)`**

```typescript
import { ZernioTransientError } from '@/lib/zernio/errors';
import { applyTransientExhaustionFallback } from '@/lib/publishing/zernio-publisher';
import { extractOutboxHandle, markOutboxFailed } from '@/lib/shared/outbox';

publisherWorker.on('failed', async (job, err) => {
  if (!job) return;
  if (job.attemptsMade < (job.opts.attempts ?? 1)) return;
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);
  const isZernioTransient = err instanceof ZernioTransientError;
  if (isZernioTransient) {
    await applyTransientExhaustionFallback(job.data);
    await markOutboxFailed(outboxId, 'zernio_transient_max_attempts', outboxAttempt);
  } else {
    const reason = err instanceof Error ? err.message : String(err);
    await markOutboxFailed(outboxId, reason, outboxAttempt);
  }
});
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add worker/index.ts
git commit -m "feat(zernio): publisherWorker.on('failed') graceful degradation on transient exhaustion"
```

---

# Phase 0e — Connect Flow

### Task 23: POST `/api/zernio/connect/start`

**Files:**
- Create: `src/app/api/zernio/connect/start/route.ts`

Per spec §3.2 step 1. **Most complex route** — implements the two-layer concurrency defense, DB idempotency check, placeholder pending marker, full start work, and Step F failure cleanup.

- [ ] **Step 1: Implement the route**

Read spec §3.2 step 1 in full and implement exactly. Key landmarks:
  - `assertSameOrigin(request)` first (round-7)
  - `requireRole(request, 'owner')` from `@/lib/db/auth` (round-9 declares `userId = user.id` + `businessId = user.businessId` with null-guard)
  - `checkSubscription(...)` early-exit
  - Pending marker check (Step A): `redis.get(pendingKey(businessId))` — return 409 `connect_pending` if exists
  - Lock acquire (Step B): `redis.set(lockKey(businessId), lockToken, 'EX', 30, 'NX')` — return 429 `connect_in_progress` if not
  - DB idempotency (Step B-bis): SELECT on `zernio_connections` — return 409 `already_connected` if exists
  - DB incident block (Step B-tris): SELECT on `zernio_finalize_incidents WHERE resolved_at IS NULL` — return 409 `finalize_unknown_admin_required` if exists
  - Placeholder marker (Step C): `redis.set(pendingKey, placeholderRaw, 'EX', 900)` (round-12 ioredis positional)
  - Start work (Step D): `zernioClient.createProfile`, generate state, `redis.setex(stateKey, 900, ...)`, `zernioClient.startConnect`
  - Update marker (Step E): Lua CAS via `luaCASToFinalizing`-style — but here it's `placeholderRaw → fullMarker` so use a SEPARATE Lua script; spec round-13 has the actual code (`luaCASUpdate` style — define inline since it's only used here)
  - Failure cleanup (Step F): catch → CAS-delete placeholder, delete state, deleteProfile best-effort
  - Lock release (finally): `luaTokenCAS` from connect-state module
  - Return `{ authUrl }`

- [ ] **Step 2: Wrap in try/catch that converts ZernioRouteError to NextResponse**

Mirror `src/lib/auth/route-helpers.ts` pattern.

- [ ] **Step 3: Manual smoke test (mock mode)**

```bash
MOCK_EXTERNAL_APIS=true pnpm dev
# In another shell:
curl -X POST http://localhost:3000/api/zernio/connect/start \
  -H "Origin: http://localhost:3000" \
  -H "Cookie: <valid-owner-session-cookie>" \
  -H "Content-Type: application/json"
```
Expected: `{ "authUrl": "http://localhost:3000/__mock_oauth_complete" }`

- [ ] **Step 4: Commit**

```bash
git add src/app/api/zernio/connect/start/route.ts
git commit -m "feat(zernio): POST /api/zernio/connect/start with two-layer concurrency defense"
```

---

### Task 24: GET `/api/zernio/connect/callback`

**Files:**
- Create: `src/app/api/zernio/connect/callback/route.ts`

Per spec §3.2 step 2 (round-11 + round-13 atomic GETDEL + round-13 second pending re-read).

- [ ] **Step 1: Implement the route**

Key landmarks:
  - `redis.getdel(stateKey(state))` — atomic claim, returns null if expired
  - JSON.parse with try/catch (round-13)
  - First pending verification: GET `connect_pending`, parse, validate `state`/`profileId`/`status === 'oauth_in_progress'`
  - Re-auth: confirm Supabase session userId matches stored.userId
  - `zernioClient.listLocations({ connectToken: token })`
  - **Round-11 second pending re-check** AFTER listLocations, before connect_locations write
  - Stash `connect_locations:{newSessionId}` with `flowId`, `state`, `connect_token`, `profileId`, `businessId`, `userId`, `locations`
  - Set HttpOnly signed cookie `zernio_connect_session = newSessionId`, **Path=/** (round-2)
  - 302 → `/dashboard/connect/select-location`
  - Catch block: round-13 callback failure cleanup (read pending, byte-match-via-Lua-CAS, delete only if it's still our flow, best-effort deleteProfile)

- [ ] **Step 2: Commit**

```bash
git add src/app/api/zernio/connect/callback/route.ts
git commit -m "feat(zernio): GET /api/zernio/connect/callback with atomic GETDEL + pending re-verify"
```

---

### Task 25: POST `/api/zernio/connect/select-location`

**Files:**
- Create: `src/app/api/zernio/connect/select-location/route.ts`

Per spec §3.2 step 3 (the LARGEST single route — finalize lock + finalizing CAS + Zernio call + DB tx + post-accountId recovery + pending CAS-delete by flowId).

- [ ] **Step 1: Implement the route**

Read spec §3.2 step 3 IN FULL — this is the most fragile route in the plan. Key landmarks:
  - `assertSameOrigin(request)` first
  - `requireRole(request, 'owner')` with `businessId` null-guard
  - Read cookie → `sessionId`
  - GET `connect_locations:{sessionId}` from Redis → JSON.parse
  - Auth-scope verify: `stored.userId === user.id` AND `stored.businessId === user.businessId`
  - Validate `locationId` in `stored.locations`
  - **finalize lock acquire** (`finalizeKey(sessionId)`, 60s TTL) — token-stamped
  - **inside lock**:
    - GET pending, parse, verify `flowId === stored.flowId`
    - Lua `luaCASToFinalizing` — only allow `oauth_in_progress → finalizing` (round-13: NOT `finalizing → finalizing`)
    - Branch on Lua result codes (`-1` → 410, `0` → 410, `-3` → 409 `finalize_in_progress`, `-2` → 409 `malformed_pending_marker`)
    - try: `zernioClient.selectLocation(...)` → assign `accountId`
    - catch (Zernio error): outcome-known vs outcome-unknown branch (round-14)
      - outcome-known: `luaCASRevertToOauth` (revert finalizing → oauth_in_progress), throw original
      - outcome-unknown: round-15 + round-16 + round-17 sequence — Redis CAS to `finalize_unknown` FIRST (with returned-value check, round-17), then DB INSERT into `zernio_finalize_incidents` (with 23505-or-throw + Sentry), then Sentry alert, then `throw new ZernioRouteError(409, 'finalize_unknown_admin_required')`
    - try (DB tx): INSERT `zernio_connections` + INSERT `job_outbox(drain_pending_owner_connect)` (with `${uuidv7()}` per round-15)
    - catch (DB error): post-accountId recovery — `zernioClient.deleteAccount(accountId)` best-effort + `luaDeletePendingByFlowIdAnyStatus` (round-13), throw 409 `already_connected_by_parallel_flow` if 23505 else original
    - On full success: `luaDeletePendingByFlowIdAnyStatus` (round-13: NOT luaCASCancel which would refuse finalizing), `redis.del(connect_locations:{sessionId})`, clear cookie, return 200
  - finally: `luaTokenCAS` to release finalize lock

- [ ] **Step 2: Commit**

```bash
git add src/app/api/zernio/connect/select-location/route.ts
git commit -m "feat(zernio): POST /api/zernio/connect/select-location with finalize lock + recovery paths"
```

---

### Task 26: POST `/api/zernio/connect/cancel`

**Files:**
- Create: `src/app/api/zernio/connect/cancel/route.ts`

Per spec §3.2 step 4 (round-13 JSON.parse try/catch + round-14 finalize_unknown refusal + round-11 cancelled flag).

- [ ] **Step 1: Implement the route**

  - `assertSameOrigin(request)` first
  - `requireRole(request, 'owner')` with `businessId` null-guard
  - GET `connect_pending:{businessId}` — return 200 `{ cancelled: false, reason: 'no_in_flight_flow' }` if missing
  - JSON.parse with try/catch → 409 `malformed_pending_marker` (round-13)
  - userId match check → 403
  - `redis.eval(luaCASCancel, ...)` with `parsed.flowId` — branch on result:
    - `-1` → 409 `finalize_in_progress`
    - `-2` → 409 `finalize_unknown_admin_required` (round-14)
    - `0` → 200 `{ cancelled: false, reason: 'flow_changed_during_cancel' }`
    - `1` → cleanup state + cookie + Zernio profile (best-effort) → 200 `{ cancelled: true, reason: 'flow_cancelled' }`

- [ ] **Step 2: Commit**

```bash
git add src/app/api/zernio/connect/cancel/route.ts
git commit -m "feat(zernio): POST /api/zernio/connect/cancel with flowId CAS + finalize-state refusal"
```

---

### Task 27: POST `/api/zernio/disconnect`

**Files:**
- Create: `src/app/api/zernio/disconnect/route.ts`

Per spec §3.2 step 5 (round-12 admin-only with sales_partner exclusion).

- [ ] **Step 1: Implement the route**

  - `assertSameOrigin(request)` first
  - Auth: owner OR admin (NOT sales_partner per round-12 to avoid amplifying the documented latent issue)
  - Resolve `businessId` (owner = own; admin = body.businessId with 400 if missing)
  - SELECT `zernio_account_id` from `zernio_connections` WHERE `status='active'` LIMIT 1 — return 404 if none
  - Begin tx: UPDATE `zernio_connections SET status='disconnected', disconnected_at=NOW(), disconnect_reason='manual_owner'/'manual_admin'`
  - Best-effort: `zernioClient.deleteAccount(accountId)` (failure logged to Sentry, doesn't fail request)
  - Return 200

- [ ] **Step 2: Commit**

```bash
git add src/app/api/zernio/disconnect/route.ts
git commit -m "feat(zernio): POST /api/zernio/disconnect (owner + admin, sales_partner excluded)"
```

---

### Task 28: Extend dashboard API with `zernioConnection` field

**Files:**
- Modify: `src/lib/dashboard/types.ts`
- Modify: `src/app/api/dashboard/route.ts` (or wherever the dashboard data API lives)

Per round-final gap-1 fix.

- [ ] **Step 1: Locate the dashboard data API**

Run: `grep -rn "useDashboardData" src/hooks/ src/app/api/ | head -5`

Identify the API route that backs `useDashboardData()`.

- [ ] **Step 2: Extend the response shape in `types.ts`**

Add to `DashboardDataActive`:

```typescript
zernioConnection: {
  status: 'none' | 'pending' | 'active' | 'disconnected' | 'finalize_unknown';
  queuedReconnectCount: number;
  hasUnresolvedIncident: boolean;
  lastDisconnectReason?: string;
};
```

- [ ] **Step 3: Populate the field in the API route**

```typescript
const [conn] = await sql<{ status: string; disconnect_reason: string | null }[]>`
  SELECT status, disconnect_reason FROM zernio_connections
  WHERE business_id = ${businessId}
  ORDER BY created_at DESC LIMIT 1
`;
const [{ count: queuedReconnectCount }] = await sql<{ count: string }[]>`
  SELECT COUNT(*)::text AS count FROM responses
  WHERE business_id = ${businessId} AND status = 'awaiting_owner_connect'
`;
const [{ count: incidentCount }] = await sql<{ count: string }[]>`
  SELECT COUNT(*)::text AS count FROM zernio_finalize_incidents
  WHERE business_id = ${businessId} AND resolved_at IS NULL
`;
const zernioConnection = {
  status: incidentCount !== '0' ? 'finalize_unknown' as const
        : conn?.status ?? 'none',
  queuedReconnectCount: Number(queuedReconnectCount),
  hasUnresolvedIncident: incidentCount !== '0',
  lastDisconnectReason: conn?.disconnect_reason ?? undefined,
};
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/dashboard/types.ts src/app/api/dashboard/route.ts
git commit -m "feat(zernio): extend dashboard API with zernioConnection field"
```

---

### Task 29: Create `ConnectGoogleBanner` component

**Files:**
- Create: `src/components/dashboard/ConnectGoogleBanner.tsx`

Per round-final gap-1 (correct location). Uses `repworth-brand-design` skill colors.

- [ ] **Step 1: Write the component**

```typescript
import type { DashboardDataActive } from '@/lib/dashboard/types';

interface Props {
  zernio: DashboardDataActive['zernioConnection'];
}

export function ConnectGoogleBanner({ zernio }: Props) {
  if (zernio.status === 'active') return null;

  // Per spec §3.4 banner state matrix:
  if (zernio.status === 'finalize_unknown') {
    return (
      <div className="rounded-lg border border-yellow-300 bg-yellow-50 p-4 mb-6">
        <p className="font-semibold text-yellow-900">Connection requires manual review</p>
        <p className="text-sm text-yellow-800 mt-1">
          We've notified our support team — they'll have this resolved within 24 hours. You don't need to do anything.
        </p>
      </div>
    );
  }

  if (zernio.status === 'none') {
    return (
      <div className="rounded-lg border border-blue-300 bg-blue-50 p-4 mb-6 flex items-center justify-between">
        <p className="text-sm text-blue-900">Connect Google Business to start auto-posting your approved responses.</p>
        <a href="/dashboard/connect" className="bg-blue-600 text-white px-4 py-2 rounded text-sm hover:bg-blue-700">Connect</a>
      </div>
    );
  }

  // status='disconnected' or 'pending'
  const headline = zernio.queuedReconnectCount > 0
    ? `${zernio.queuedReconnectCount} approved ${zernio.queuedReconnectCount === 1 ? 'response is' : 'responses are'} waiting to publish.`
    : 'Auto-posting is currently disconnected.';
  return (
    <div className="rounded-lg border border-orange-300 bg-orange-50 p-4 mb-6 flex items-center justify-between">
      <div>
        <p className="font-semibold text-orange-900">{headline}</p>
        <p className="text-sm text-orange-800">Reconnect Google Business to resume publishing.</p>
      </div>
      <a href="/dashboard/connect" className="bg-orange-600 text-white px-4 py-2 rounded text-sm hover:bg-orange-700">Reconnect</a>
    </div>
  );
}
```

- [ ] **Step 2: Wire into `DashboardContent.tsx`**

Add `<ConnectGoogleBanner zernio={data.zernioConnection} />` near the top of the rendered dashboard when `data.subscriptionStatus === 'active'`.

- [ ] **Step 3: Commit**

```bash
git add src/components/dashboard/ConnectGoogleBanner.tsx src/components/DashboardContent.tsx
git commit -m "feat(zernio): ConnectGoogleBanner component on dashboard"
```

---

### Task 30: Create `/dashboard/connect` page

**Files:**
- Create: `src/app/(authenticated)/dashboard/connect/page.tsx`

Per round-final gap-4 (§3.3.5 UI states).

- [ ] **Step 1: Implement state-aware page**

Server component that reads pending marker via the dashboard API or its own SSR fetch. Renders one of 6 states per the §3.3.5 table:
  - No marker + no active connection → "Connect Google Business" button
  - `oauth_in_progress` → spinner + cancel button
  - `finalizing` → spinner, no cancel, auto-refresh every 2s for up to 30s
  - `finalize_unknown` → yellow alert, no buttons
  - active → SSR redirect to `/dashboard`
  - disconnected → "Reconnect" button

The "Connect Google Business" button POSTs `/api/zernio/connect/start`, then `window.location = response.authUrl`.

The "Cancel & restart" button POSTs `/api/zernio/connect/cancel`, then refreshes the page.

- [ ] **Step 2: Commit**

```bash
git add src/app/(authenticated)/dashboard/connect/page.tsx
git commit -m "feat(zernio): /dashboard/connect page with state-aware UI"
```

---

### Task 31: Create `/dashboard/connect/select-location` page

**Files:**
- Create: `src/app/(authenticated)/dashboard/connect/select-location/page.tsx`

- [ ] **Step 1: Implement location picker**

Reads cookie, fetches `connect_locations:{sessionId}` from Redis SSR. Renders the location list as a single-select form. On submit, POSTs `/api/zernio/connect/select-location` with `{ locationId }`. On success, redirects to `/dashboard`. Handles 410/409 errors with friendly messages.

- [ ] **Step 2: Commit**

```bash
git add src/app/(authenticated)/dashboard/connect/select-location/page.tsx
git commit -m "feat(zernio): /dashboard/connect/select-location page"
```

---

### Task 32: Add admin business detail Zernio panel

**Files:**
- Modify: `src/app/admin/businesses/[id]/page.tsx` (or its child component)

Per spec §3.5.

- [ ] **Step 1: Add Zernio connection panel**

Show: current state (active/disconnected/not connected) with timestamps, `disconnect_reason` if applicable, last_error preview, "Manually disconnect" button, and per-`awaiting_owner_connect`-response: "Manually post" button (triggers existing `awaiting_manual_post` escape hatch).

- [ ] **Step 2: Commit**

```bash
git add src/app/admin/businesses/[id]/page.tsx
git commit -m "feat(zernio): admin business detail Zernio connection panel"
```

---

### Task 33: Add "Pending owner reconnect" column to admin overview

**Files:**
- Modify: `src/app/admin/overview/page.tsx`

- [ ] **Step 1: Extend the businesses table**

Add a new column showing count of `awaiting_owner_connect` responses per business. Sort hint: businesses with high counts need a manual nudge.

- [ ] **Step 2: Commit**

```bash
git add src/app/admin/overview/page.tsx
git commit -m "feat(zernio): admin overview column for pending owner-reconnect count"
```

---

### Task 34: E2E happy-path test (mock mode)

**Files:**
- Create: `tests/e2e/zernio-connect.spec.ts`

- [ ] **Step 1: Write Playwright test**

```typescript
import { test, expect } from '@playwright/test';

test.skip(!process.env.TEST_DATABASE_POOL_URL, 'no test DB');

test('owner can connect Google Business in mock mode', async ({ page }) => {
  // Setup: seed an active business + owner login
  // Visit /dashboard
  // Expect ConnectGoogleBanner with "Connect" button
  // Click → POST start → mock returns authUrl
  // Mock the OAuth callback inline
  // Visit /dashboard/connect/select-location
  // Pick first location, submit
  // Verify zernio_connections row exists with status='active'
  // Verify banner gone from /dashboard
});
```

- [ ] **Step 2: Run test**

Run: `pnpm test:e2e tests/e2e/zernio-connect.spec.ts`
Expected: PASS (skipped if no test DB).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/zernio-connect.spec.ts
git commit -m "test(zernio): E2E connect happy-path in mock mode"
```

---

# Phase 0f — Webhook Ingress

### Task 35: Create HMAC verification helper

**Files:**
- Create: `worker/ingress/zernio-verify.ts`
- Create: `worker/ingress/__tests__/zernio-verify.test.ts`

Per spec §5.3 round-7 (HEX_64 regex check + length-safe timingSafeEqual).

- [ ] **Step 1: Write tests**

```typescript
import { describe, it, expect } from 'vitest';
import { verifyZernioSignature } from '../zernio-verify';

const SECRET = 'test-secret-32-bytes-minimum-zzz';

describe('verifyZernioSignature', () => {
  it('accepts valid hex signature', () => {
    const body = '{"event":"webhook.test"}';
    const expected = require('crypto').createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyZernioSignature(body, expected, SECRET)).toBe(true);
  });

  it('rejects bad signature', () => {
    expect(verifyZernioSignature('{}', '0'.repeat(64), SECRET)).toBe(false);
  });

  it('rejects non-hex signature', () => {
    expect(verifyZernioSignature('{}', 'not-hex-but-64-chars-this-string-is-deliberately-non-hex-formatted', SECRET)).toBe(false);
  });

  it('rejects wrong-length signature', () => {
    expect(verifyZernioSignature('{}', 'abc', SECRET)).toBe(false);
  });
});
```

- [ ] **Step 2: Implement**

Mirror `src/lib/shared/feedback-hmac.ts:22-30` pattern.

- [ ] **Step 3: Run tests**

Run: `pnpm vitest run worker/ingress/__tests__/zernio-verify.test.ts`
Expected: 4 passed.

- [ ] **Step 4: Commit**

```bash
git add worker/ingress/zernio-verify.ts worker/ingress/__tests__/zernio-verify.test.ts
git commit -m "feat(zernio): HMAC-SHA256 webhook signature verification"
```

---

### Task 36: Create webhook ingress handler

**Files:**
- Create: `worker/ingress/zernio.ts`

Per spec §5.3, §5.4.

- [ ] **Step 1: Implement handler**

Mirror `worker/ingress/stripe.ts:198`. Key points:
  - Flag check: `ZERNIO_PUBLISHING_ENABLED !== 'true'` → 503
  - Read raw body via `fastify-raw-body`
  - `verifyZernioSignature` → 401 on mismatch
  - Extract eventId from `x-zernio-event-id` header OR body.id → 400 if missing
  - `claimInboundEvent('zernio', eventId, body.event, body)` → 200 duplicate if already processed
  - Switch on `body.event`:
    - `account.disconnected` → §5.4 multi-row UPDATE pattern (round-14 WITH disconnected AS ... INSERT FROM disconnected)
    - `account.connected` → log only (defensive)
    - `review.new` / `review.updated` → INCRBY Redis counter `zernio_event_seen:{type}:{date}` (Phase 3 readiness)
    - `webhook.test` → log + 200
    - default → log + 200
  - UPDATE `inbound_events SET status='processed'` on success; SET 'failed' + 500 on tx exception (Zernio retries)

- [ ] **Step 2: Commit**

```bash
git add worker/ingress/zernio.ts
git commit -m "feat(zernio): /ingress/zernio webhook handler with account.disconnected flow"
```

---

### Task 37: Register webhook route in `worker/index.ts`

**Files:**
- Modify: `worker/index.ts`

- [ ] **Step 1: Add Fastify route**

Mirror the existing Stripe registration (with `rawBody: true`):

```typescript
import { handleZernioWebhook } from './ingress/zernio';

fastify.post('/ingress/zernio', { config: { rawBody: true } }, handleZernioWebhook);
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm tsc --noEmit
git add worker/index.ts
git commit -m "feat(zernio): register POST /ingress/zernio Fastify route"
```

---

### Task 38: Update CLAUDE.md

**Files:**
- Modify: `.claude/CLAUDE.md`

Per spec §8.

- [ ] **Step 1: Apply updates**

  - Tech stack: add "Zernio: GBP auto-posting (Phase 0+)"
  - Status enum line: add `'awaiting_owner_connect'`
  - Feature flags section: add `ZERNIO_PUBLISHING_ENABLED`, `ZERNIO_API_KEY`, `ZERNIO_WEBHOOK_SECRET`, `ZERNIO_PROFILE_ID_PREFIX`
  - Directory tree: add new `src/lib/zernio/`, `src/components/dashboard/ConnectGoogleBanner.tsx`, `src/app/(authenticated)/dashboard/connect/`, `src/lib/publishing/zernio-publisher.ts`, `worker/ingress/zernio.ts`, `worker/jobs/OwnerEmailWorker.ts`, `worker/jobs/DrainOwnerConnectWorker.ts`
  - Migrations section: add migration 026 entry

- [ ] **Step 2: Commit**

```bash
git add .claude/CLAUDE.md
git commit -m "docs(zernio): update CLAUDE.md with new env vars, status enum, directory tree"
```

---

### Task 39: Write `zernio-launch-runbook.md`

**Files:**
- Create: `docs/zernio-launch-runbook.md`

Per spec §8 (round-13 + round-14 + round-15 + round-16 reconciliation procedure).

- [ ] **Step 1: Write the runbook**

Mirror `docs/signup-test-runbook.md` style. Required sections:

  1. **Pre-flight checklist** (matches spec §6.3): Zernio TOS confirmation, Accelerate plan + Inbox add-on activated, API key generated, webhook secret generated, webhook URL configured, subscribed events, test webhook fired.
  2. **Phase 1 pilot scenarios**: customer #1 connects, generates a review, approves, watches for posting; admin runbook for monitoring `awaiting_owner_connect` count.
  3. **Common errors and their causes**: signature failures, ZernioReviewNotFoundError patterns, finalize_unknown alerts.
  4. **`finalize_unknown` reconciliation procedure** (round-15 + round-16 final form): full procedure with Branch A sub-cases A-1/A-2/A-3 and Branch B, including the SQL template with `INSERT ... RETURNING` + conditional drain/resolve.
  5. **Rollback procedure**: soft (flag flip) + hard (revert PR).

- [ ] **Step 2: Commit**

```bash
git add docs/zernio-launch-runbook.md
git commit -m "docs(zernio): launch runbook with finalize_unknown reconciliation procedure"
```

---

### Task 40: Final verification — full test sweep

**Files:** none (verification only)

- [ ] **Step 1: Run all tests**

```bash
pnpm tsc --noEmit
pnpm lint
pnpm test
```
Expected: all pass.

- [ ] **Step 2: Run E2E (if test DB available)**

```bash
pnpm test:e2e
```
Expected: PASS (or graceful skip).

- [ ] **Step 3: Smoke-test the worker boot**

```bash
MOCK_EXTERNAL_APIS=true ZERNIO_PUBLISHING_ENABLED=true pnpm worker
```
Expected: boots cleanly with no env-var assertion failures (mock mode bypasses Zernio creds), all workers register, registers `/ingress/zernio` route.

- [ ] **Step 4: Smoke-test the Next.js app boot**

```bash
MOCK_EXTERNAL_APIS=true pnpm dev
```
Expected: boots, dashboard loads, `/dashboard/connect` page renders.

- [ ] **Step 5: Final integration check**

Verify by code reading:
  - `OutboxPoller.topicToQueue` includes 3 new entries (`drain_pending_owner_connect`, `notify_owner_reconnect`, `notify_owner_connection_lost`)
  - `worker/index.ts` registers 2 new Workers AND `publisherWorker.on('failed')` AND the `/ingress/zernio` route
  - `worker/startup-assert.ts` gates Zernio env vars behind the flag + mock mode bypass
  - Migration 026 has been applied (re-confirm with user)

- [ ] **Step 6: Final commit**

```bash
git commit --allow-empty -m "feat(zernio): integration complete behind ZERNIO_PUBLISHING_ENABLED flag (Phase 0)"
```

---

## Phase 1 Pilot — handoff to runbook

Phase 0 ends here. Phase 1 (single-customer pilot) is operational, not code:

1. Set `ZERNIO_API_KEY` + `ZERNIO_WEBHOOK_SECRET` in prod env
2. Configure webhook in Zernio dashboard pointing at `${WORKER_PUBLIC_URL}/ingress/zernio`
3. Flip `ZERNIO_PUBLISHING_ENABLED=true` in prod
4. Onboard customer #1, watch for 1–2 weeks per spec §6.2

All Phase 1 procedures live in `docs/zernio-launch-runbook.md` (Task 39).

---

## Self-Review Checklist (run before handoff)

- [ ] **Spec coverage**: every section of the spec maps to at least one task above. Specifically: §2 (Schema) → Task 1; §3.1–3.5 → Tasks 23–33; §4 (Publisher) → Tasks 19–22; §5 (Webhook) → Tasks 35–37; §6 (Phased rollout) → Phase 1 handoff; §7 (Testing) → Tasks 7, 8, 19, 34, 35; §8 (Docs) → Tasks 38, 39; §9 (Scope) → covered by file map.
- [ ] **No placeholders**: every step contains exact code or exact spec section reference.
- [ ] **Type consistency**: error class names, queue name constants, payload type names, and Lua helper names match across tasks.
- [ ] **Migration ordering correct**: Task 1's migration applies BEFORE any code that references the new tables/columns.
- [ ] **Flag-gating preserved**: every new code path is reachable only when `ZERNIO_PUBLISHING_ENABLED=true`. Worker startup assertions, route 503s, and ResponsePublisher branch presence all gate on it.

---

## Total scope (40 tasks across 6 phases)

- **Foundations (1–6)**: 6 tasks. Migration + types + queues + errors.
- **HTTP Client (7–11)**: 5 tasks. Pure module work, fully unit-testable.
- **Worker Infrastructure (12–18)**: 7 tasks. New workers + queue wiring + bounce templates.
- **Publisher Branching (19–22)**: 4 tasks. The most fragile DB+API integration.
- **Connect Flow (23–34)**: 12 tasks. Routes + pages + dashboard extension + admin panel + E2E.
- **Webhook + Ops (35–40)**: 6 tasks. Webhook + runbook + CLAUDE.md + final verification.

Estimated implementation time: 5–8 working days at the spec's level of rigor (most tasks are 30–90 minutes; Tasks 23, 25, and 21 are the high-complexity outliers at 2–3 hours each).
