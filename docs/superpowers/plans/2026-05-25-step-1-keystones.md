# Step 1 Keystones Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the remaining Step 1 SaaS-readiness keystones: `accounts.past_due_at`, generalized account audit helper/metadata, and worker-side `activation_completed` capture.

**Architecture:** Keep this as one foundation slice. Add only additive schema, route touched subscription-status audit writes through a transaction-aware helper, and centralize activation analytics behind one publisher helper that every current `posted` transition calls after DB state is durable. PostHog is best-effort and no-ops without `POSTHOG_API_KEY`.

**Tech Stack:** Next.js 16, Railway worker with BullMQ, Supabase/Postgres via Postgres.js, Vitest, Stripe webhooks, PostHog Node SDK.

---

## File Map

- Create `supabase/migrations/043_step_1_keystones.sql`: additive DDL for `accounts.past_due_at` and `account_audit_log` metadata columns.
- Create `src/lib/shared/__tests__/migration-043-structure.test.ts`: structural migration assertions.
- Create `src/lib/audit/log.ts`: transaction-aware `account_audit_log` helper.
- Create `src/lib/audit/__tests__/log.test.ts`: helper tests for default SQL, tx injection, JSONB payloads, and optional metadata.
- Modify `worker/ingress/stripe/invoice-payment-failed.ts`: set `past_due_at` and call audit helper.
- Modify `worker/ingress/stripe/invoice-paid.ts`: clear `past_due_at` and call audit helper.
- Modify `worker/ingress/stripe/subscription-deleted.ts`: clear `past_due_at` and call audit helper.
- Modify `worker/ingress/__tests__/stripe-webhook-handlers.test.ts`: verify `past_due_at` SQL and helper calls.
- Modify `package.json` and `pnpm-lock.yaml`: add `posthog-node`.
- Modify `.env.example`: document optional `POSTHOG_API_KEY` and `POSTHOG_HOST`.
- Create `src/lib/analytics/posthog.ts`: lazy PostHog Node wrapper.
- Create `src/lib/analytics/__tests__/posthog.test.ts`: no-secret no-op and capture tests.
- Create `worker/jobs/publisher/activation.ts`: shared activation chokepoint.
- Create `worker/jobs/publisher/__tests__/activation.test.ts`: activation decision tests.
- Modify `worker/jobs/publisher/ResponsePublisherWorker.ts`: call activation chokepoint after the main posted update and after edit-publish completed outcomes.
- Modify `worker/jobs/publisher/edit-publish.ts`: return posted activation candidates for `success` and `409_matches`.
- Modify `worker/jobs/publisher/publisher-error-handlers.ts`: call activation chokepoint after idempotent 409 reconciliation marks posted.
- Modify publisher tests in `worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts`, `edit-publish.test.ts`, and `publisher-error-handlers.test.ts`.

## Task 1: Migration 043

**Files:**
- Create: `supabase/migrations/043_step_1_keystones.sql`
- Create: `src/lib/shared/__tests__/migration-043-structure.test.ts`

- [ ] **Step 1: Write the migration structure test**

Create `src/lib/shared/__tests__/migration-043-structure.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const MIGRATION_PATH = resolve(
  process.cwd(),
  'supabase/migrations/043_step_1_keystones.sql',
);

let sql: string;
beforeAll(() => {
  sql = readFileSync(MIGRATION_PATH, 'utf-8');
});

describe('migration 043 — accounts.past_due_at', () => {
  it('adds nullable accounts.past_due_at', () => {
    expect(sql).toMatch(
      /ALTER TABLE accounts\s+ADD COLUMN IF NOT EXISTS past_due_at TIMESTAMPTZ/i,
    );
  });

  it('documents past_due_at semantics', () => {
    expect(sql).toMatch(/COMMENT ON COLUMN accounts\.past_due_at/i);
    expect(sql).toMatch(/current past_due interval/i);
  });
});

describe('migration 043 — account_audit_log metadata', () => {
  it.each([
    'entity_type TEXT',
    'entity_id TEXT',
    'ip TEXT',
    'user_agent TEXT',
    'request_id TEXT',
  ])('adds nullable %s', (column) => {
    const [name, type] = column.split(' ');
    expect(sql).toMatch(
      new RegExp(
        `ALTER TABLE account_audit_log\\s+ADD COLUMN IF NOT EXISTS ${name} ${type}`,
        'i',
      ),
    );
  });

  it('does not create account_memberships in this slice', () => {
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS account_memberships/i);
  });

  it('does not create new audit indexes without a matching query', () => {
    expect(sql).not.toMatch(/CREATE INDEX IF NOT EXISTS .*account_audit.*entity/i);
    expect(sql).not.toMatch(/CREATE INDEX IF NOT EXISTS .*account_audit.*request/i);
  });
});

describe('migration 043 — additive and idempotent', () => {
  it('uses IF NOT EXISTS for every added column', () => {
    const additions = sql.match(/ADD COLUMN IF NOT EXISTS/gi) ?? [];
    expect(additions.length).toBeGreaterThanOrEqual(6);
  });

  it('does not drop tables, columns, or mutate data', () => {
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/^\s*UPDATE\s+/im);
    expect(sql).not.toMatch(/^\s*DELETE\s+/im);
    expect(sql).not.toMatch(/^\s*INSERT\s+/im);
  });
});
```

- [ ] **Step 2: Run the migration test to verify it fails**

Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/migration-043-structure.test.ts
```

Expected: FAIL because `supabase/migrations/043_step_1_keystones.sql` does not exist.

- [ ] **Step 3: Add migration 043**

Create `supabase/migrations/043_step_1_keystones.sql`:

```sql
-- ==============================================================================
-- Migration 043: Step 1 SaaS-readiness keystones
--
-- Adds the missing past_due countdown source and extends account_audit_log with
-- generic metadata columns used by the Step 1 audit helper.
--
-- Additive and idempotent. No runtime authorization behavior changes.
-- ==============================================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS past_due_at TIMESTAMPTZ;

COMMENT ON COLUMN accounts.past_due_at IS
  'Set when an account enters the current past_due interval. Preserved across repeated failed invoices while still past_due; cleared on recovery or cancellation.';

ALTER TABLE account_audit_log
  ADD COLUMN IF NOT EXISTS entity_type TEXT;

ALTER TABLE account_audit_log
  ADD COLUMN IF NOT EXISTS entity_id TEXT;

ALTER TABLE account_audit_log
  ADD COLUMN IF NOT EXISTS ip TEXT;

ALTER TABLE account_audit_log
  ADD COLUMN IF NOT EXISTS user_agent TEXT;

ALTER TABLE account_audit_log
  ADD COLUMN IF NOT EXISTS request_id TEXT;

COMMENT ON COLUMN account_audit_log.entity_type IS
  'Optional audited entity type, such as account, business, response, membership, or provider_event.';

COMMENT ON COLUMN account_audit_log.entity_id IS
  'Optional audited entity identifier. Stored as text so internal UUIDs and provider IDs can both be represented.';

COMMENT ON COLUMN account_audit_log.ip IS
  'Optional request IP captured by application code. Text avoids audit-write failures on unusual proxy values.';

COMMENT ON COLUMN account_audit_log.user_agent IS
  'Optional request user-agent captured by application code.';

COMMENT ON COLUMN account_audit_log.request_id IS
  'Optional request or correlation identifier captured by application code.';
```

- [ ] **Step 4: Run the migration test to verify it passes**

Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/migration-043-structure.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add supabase/migrations/043_step_1_keystones.sql src/lib/shared/__tests__/migration-043-structure.test.ts
git commit -m "feat: add step 1 keystone migration"
```

## Task 2: Account Audit Helper

**Files:**
- Create: `src/lib/audit/log.ts`
- Create: `src/lib/audit/__tests__/log.test.ts`

- [ ] **Step 1: Write failing audit helper tests**

Create `src/lib/audit/__tests__/log.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, mockTx, sqlCalls, txCalls } = vi.hoisted(() => {
  const sqlCalls: { text: string; values: unknown[] }[] = [];
  const txCalls: { text: string; values: unknown[] }[] = [];

  const makeTag = (calls: { text: string; values: unknown[] }[]) =>
    vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return Promise.resolve(Object.assign([], { count: 1 }));
    });

  return {
    mockSql: makeTag(sqlCalls),
    mockTx: makeTag(txCalls),
    sqlCalls,
    txCalls,
  };
});

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (value: unknown) => ({ __jsonb: value }),
}));

vi.mock('uuid', () => ({
  v7: vi.fn(() => '019dc366-29ce-7000-a000-000000000043'),
}));

describe('writeAccountAuditLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlCalls.length = 0;
    txCalls.length = 0;
  });

  it('writes required fields with default sql client', async () => {
    const { writeAccountAuditLog } = await import('../log');

    await writeAccountAuditLog({
      accountId: 'acct-1',
      eventType: 'subscription_status_changed',
      payload: { fromStatus: 'active', toStatus: 'past_due' },
    });

    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0]!.text).toMatch(/INSERT INTO account_audit_log/i);
    expect(sqlCalls[0]!.text).toMatch(/event_type/i);
    expect(sqlCalls[0]!.values).toContain('acct-1');
    expect(sqlCalls[0]!.values).toContain('subscription_status_changed');
    expect(sqlCalls[0]!.values).toContainEqual({
      __jsonb: { fromStatus: 'active', toStatus: 'past_due' },
    });
  });

  it('uses an injected transaction client', async () => {
    const { writeAccountAuditLog } = await import('../log');

    await writeAccountAuditLog(
      {
        accountId: 'acct-1',
        eventType: 'subscription_status_changed',
        payload: { fromStatus: 'past_due', toStatus: 'active' },
      },
      mockTx as never,
    );

    expect(sqlCalls).toHaveLength(0);
    expect(txCalls).toHaveLength(1);
  });

  it('writes optional metadata fields', async () => {
    const { writeAccountAuditLog } = await import('../log');

    await writeAccountAuditLog({
      accountId: 'acct-1',
      locationId: 'biz-1',
      actorUserId: 'user-1',
      eventType: 'csv_bulk_import',
      entityType: 'business',
      entityId: 'biz-1',
      ip: '203.0.113.10',
      userAgent: 'Vitest',
      requestId: 'req-123',
      payload: { created: 3 },
    });

    const values = sqlCalls[0]!.values;
    expect(values).toContain('biz-1');
    expect(values).toContain('user-1');
    expect(values).toContain('business');
    expect(values).toContain('203.0.113.10');
    expect(values).toContain('Vitest');
    expect(values).toContain('req-123');
  });
});
```

- [ ] **Step 2: Run audit helper tests to verify they fail**

Run:

```bash
pnpm exec vitest run src/lib/audit/__tests__/log.test.ts
```

Expected: FAIL because `src/lib/audit/log.ts` does not exist.

- [ ] **Step 3: Add the audit helper**

Create `src/lib/audit/log.ts`:

```ts
import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { jsonb, sql } from '@/lib/db/server';

type SqlExecutor = typeof sql | postgres.TransactionSql;

export interface WriteAccountAuditLogInput {
  accountId: string;
  locationId?: string | null;
  actorUserId?: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  entityType?: string | null;
  entityId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export async function writeAccountAuditLog(
  input: WriteAccountAuditLogInput,
  db: SqlExecutor = sql,
): Promise<void> {
  await db`
    INSERT INTO account_audit_log (
      id,
      account_id,
      location_id,
      event_type,
      actor_user_id,
      payload,
      entity_type,
      entity_id,
      ip,
      user_agent,
      request_id
    ) VALUES (
      ${uuidv7()}::uuid,
      ${input.accountId}::uuid,
      ${input.locationId ?? null}::uuid,
      ${input.eventType},
      ${input.actorUserId ?? null}::uuid,
      ${jsonb(input.payload)},
      ${input.entityType ?? null},
      ${input.entityId ?? null},
      ${input.ip ?? null},
      ${input.userAgent ?? null},
      ${input.requestId ?? null}
    )
  `;
}
```

- [ ] **Step 4: Run audit helper tests to verify they pass**

Run:

```bash
pnpm exec vitest run src/lib/audit/__tests__/log.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/lib/audit/log.ts src/lib/audit/__tests__/log.test.ts
git commit -m "feat: add account audit helper"
```

## Task 3: Billing Webhook past_due_at and Audit Helper Wiring

**Files:**
- Modify: `worker/ingress/stripe/invoice-payment-failed.ts`
- Modify: `worker/ingress/stripe/invoice-paid.ts`
- Modify: `worker/ingress/stripe/subscription-deleted.ts`
- Modify: `worker/ingress/__tests__/stripe-webhook-handlers.test.ts`

- [ ] **Step 1: Update webhook tests before implementation**

In `worker/ingress/__tests__/stripe-webhook-handlers.test.ts`, extend the hoisted destructuring to include `mockWriteAccountAuditLog`:

```ts
const {
  mockSql,
  sqlReturnQueue,
  sqlCalls,
  mockClaimInboundEvent,
  mockConstructEvent,
  mockWriteAccountAuditLog,
} = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const sqlCalls: { text: string; values: unknown[] }[] = [];

  const mockSql: any = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    const text = Array.from(_s).join('?');
    sqlCalls.push({ text, values: _v });
    const queued = sqlReturnQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    const empty: unknown[] & { count: number } = Object.assign([], { count: 0 });
    return Promise.resolve(empty);
  });

  mockSql.begin = vi.fn(async (callback: (tx: any) => Promise<any>) => {
    return callback(mockSql);
  });

  return {
    mockSql,
    sqlReturnQueue,
    sqlCalls,
    mockClaimInboundEvent: vi.fn(),
    mockConstructEvent: vi.fn(),
    mockWriteAccountAuditLog: vi.fn().mockResolvedValue(undefined),
  };
});
```

Add this mock near the existing `@/lib/db/server` mock:

```ts
vi.mock('../../../src/lib/audit/log', () => ({
  writeAccountAuditLog: mockWriteAccountAuditLog,
}));
```

In `beforeEach`, clear it:

```ts
mockWriteAccountAuditLog.mockClear();
mockWriteAccountAuditLog.mockResolvedValue(undefined);
```

Replace the three queue helpers with versions that do not enqueue audit insert results, because the mocked helper no longer consumes SQL queue entries:

```ts
function queueInvoicePaymentFailed(opts: {
  status?: string;
  updateAccount?: boolean;
} = {}) {
  const status = opts.status ?? 'active';
  sqlReturnQueue.push([{ id: TEST_ACCOUNT_ID, subscription_status: status }]);
  sqlReturnQueue.push([]);
  if (status === 'active') {
    const r1: any = []; r1.count = 1;
    sqlReturnQueue.push(r1);
    const r2: any = []; r2.count = 1;
    sqlReturnQueue.push(r2);
  }
}

function queueInvoicePaid(opts: {
  status?: string;
} = {}) {
  const status = opts.status ?? 'past_due';
  sqlReturnQueue.push([{ id: TEST_ACCOUNT_ID, subscription_status: status }]);
  if (status === 'past_due') {
    sqlReturnQueue.push([]);
    const r1: any = []; r1.count = 1;
    sqlReturnQueue.push(r1);
    const r2: any = []; r2.count = 1;
    sqlReturnQueue.push(r2);
    sqlReturnQueue.push([{ id: '019dc366-29ce-7000-a000-000000000099' }]);
    sqlReturnQueue.push([]);
  }
}

function queueSubscriptionDeleted(opts: {
  status?: string;
} = {}) {
  const status = opts.status ?? 'active';
  sqlReturnQueue.push([{ id: TEST_ACCOUNT_ID, subscription_status: status }]);
  sqlReturnQueue.push([]);
  if (status !== 'cancelled') {
    const r1: any = []; r1.count = 1;
    sqlReturnQueue.push(r1);
    const r2: any = []; r2.count = 1;
    sqlReturnQueue.push(r2);
  }
}
```

Keep audit queue rows for checkout/subscription-updated paths until those are intentionally migrated.

Add or update assertions:

```ts
expect(updateAcct!.text).toMatch(/past_due_at\s*=\s*NOW\(\)/i);
expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
  expect.objectContaining({
    accountId: TEST_ACCOUNT_ID,
    eventType: 'subscription_status_changed',
    entityType: 'account',
    entityId: TEST_ACCOUNT_ID,
    payload: { fromStatus: 'active', toStatus: 'past_due' },
  }),
  mockSql,
);
```

For `invoice.paid` recovery:

```ts
expect(updateAcct!.text).toMatch(/past_due_at\s*=\s*NULL/i);
expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
  expect.objectContaining({
    accountId: TEST_ACCOUNT_ID,
    eventType: 'subscription_status_changed',
    entityType: 'account',
    entityId: TEST_ACCOUNT_ID,
    payload: { fromStatus: 'past_due', toStatus: 'active' },
  }),
  mockSql,
);
```

For cancellation:

```ts
expect(updateAcct!.text).toMatch(/cancelled_at\s*=\s*NOW\(\)/i);
expect(updateAcct!.text).toMatch(/past_due_at\s*=\s*NULL/i);
expect(mockWriteAccountAuditLog).toHaveBeenCalledWith(
  expect.objectContaining({
    accountId: TEST_ACCOUNT_ID,
    eventType: 'subscription_status_changed',
    entityType: 'account',
    entityId: TEST_ACCOUNT_ID,
    payload: { fromStatus: 'active', toStatus: 'cancelled' },
  }),
  mockSql,
);
```

For the already-past-due no-op test, assert:

```ts
expect(mockWriteAccountAuditLog).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run webhook tests to verify they fail**

Run:

```bash
pnpm exec vitest run worker/ingress/__tests__/stripe-webhook-handlers.test.ts
```

Expected: FAIL because handlers do not set/clear `past_due_at` and still write raw audit inserts.

- [ ] **Step 3: Update `invoice-payment-failed.ts`**

Replace the `uuid`/`jsonb` imports and raw audit insert with the helper:

```ts
import Stripe from 'stripe';
import { sql } from '../../../src/lib/db/server';
import { writeAccountAuditLog } from '../../../src/lib/audit/log';
import { LOG_PREFIX, extractCustomerId } from './shared';
```

Use this update and helper call inside the active-to-past-due branch:

```ts
await tx`
  UPDATE accounts
  SET subscription_status = 'past_due',
      past_due_at = NOW(),
      updated_at = NOW()
  WHERE id = ${acctRow.id}::uuid
`;

await writeAccountAuditLog(
  {
    accountId: acctRow.id,
    eventType: 'subscription_status_changed',
    entityType: 'account',
    entityId: acctRow.id,
    payload: { fromStatus: 'active', toStatus: 'past_due' },
  },
  tx,
);
```

- [ ] **Step 4: Update `invoice-paid.ts`**

Replace the `uuid`/`jsonb` imports and raw audit insert with `writeAccountAuditLog`. Use this recovery update:

```ts
await tx`
  UPDATE accounts
  SET subscription_status = 'active',
      past_due_at = NULL,
      updated_at = NOW()
  WHERE id = ${acct.id}::uuid
`;

await writeAccountAuditLog(
  {
    accountId: acct.id,
    eventType: 'subscription_status_changed',
    entityType: 'account',
    entityId: acct.id,
    payload: { fromStatus: 'past_due', toStatus: 'active' },
  },
  tx,
);
```

- [ ] **Step 5: Update `subscription-deleted.ts`**

Replace the `uuid`/`jsonb` imports and raw audit insert with `writeAccountAuditLog`. Use this cancellation update:

```ts
await tx`
  UPDATE accounts
  SET subscription_status = 'cancelled',
      cancelled_at = NOW(),
      past_due_at = NULL,
      updated_at = NOW()
  WHERE id = ${acctRow.id}::uuid
`;

await writeAccountAuditLog(
  {
    accountId: acctRow.id,
    eventType: 'subscription_status_changed',
    entityType: 'account',
    entityId: acctRow.id,
    payload: { fromStatus: oldStatus, toStatus: 'cancelled' },
  },
  tx,
);
```

- [ ] **Step 6: Run webhook tests to verify they pass**

Run:

```bash
pnpm exec vitest run worker/ingress/__tests__/stripe-webhook-handlers.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add worker/ingress/stripe/invoice-payment-failed.ts worker/ingress/stripe/invoice-paid.ts worker/ingress/stripe/subscription-deleted.ts worker/ingress/__tests__/stripe-webhook-handlers.test.ts
git commit -m "feat: track past due timestamp"
```

## Task 4: PostHog Node Wrapper

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.env.example`
- Create: `src/lib/analytics/posthog.ts`
- Create: `src/lib/analytics/__tests__/posthog.test.ts`

- [ ] **Step 1: Install the PostHog Node SDK**

Run:

```bash
pnpm add posthog-node
```

Expected: `package.json` and `pnpm-lock.yaml` include `posthog-node`.

- [ ] **Step 2: Add env template entries**

Add this block to `.env.example` near Sentry/App URLs:

```dotenv
# --- Product analytics (PostHog Cloud) ---
# Optional. Worker analytics no-op when unset.
POSTHOG_API_KEY=
POSTHOG_HOST=https://us.i.posthog.com
```

- [ ] **Step 3: Write failing PostHog wrapper tests**

Create `src/lib/analytics/__tests__/posthog.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCapture, mockShutdown, posthogCtor } = vi.hoisted(() => {
  const mockCapture = vi.fn();
  const mockShutdown = vi.fn().mockResolvedValue(undefined);
  return {
    mockCapture,
    mockShutdown,
    posthogCtor: vi.fn().mockImplementation(() => ({
      capture: mockCapture,
      shutdown: mockShutdown,
    })),
  };
});

vi.mock('posthog-node', () => ({
  PostHog: posthogCtor,
}));

const originalApiKey = process.env.POSTHOG_API_KEY;
const originalHost = process.env.POSTHOG_HOST;

async function loadModule() {
  vi.resetModules();
  return import('../posthog');
}

describe('captureAnalyticsEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.POSTHOG_API_KEY;
    delete process.env.POSTHOG_HOST;
  });

  afterEach(async () => {
    const mod = await loadModule();
    await mod.shutdownAnalytics();
    if (originalApiKey === undefined) delete process.env.POSTHOG_API_KEY;
    else process.env.POSTHOG_API_KEY = originalApiKey;
    if (originalHost === undefined) delete process.env.POSTHOG_HOST;
    else process.env.POSTHOG_HOST = originalHost;
  });

  it('no-ops when POSTHOG_API_KEY is unset', async () => {
    const { captureAnalyticsEvent } = await loadModule();

    const captured = captureAnalyticsEvent({
      event: 'activation_completed',
      distinctId: 'acct-1',
      properties: { business_id: 'biz-1' },
    });

    expect(captured).toBe(false);
    expect(posthogCtor).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('captures with distinctId, event, and properties when configured', async () => {
    process.env.POSTHOG_API_KEY = 'phc_test';
    process.env.POSTHOG_HOST = 'https://posthog.test';
    const { captureAnalyticsEvent } = await loadModule();

    const captured = captureAnalyticsEvent({
      event: 'activation_completed',
      distinctId: 'acct-1',
      properties: { business_id: 'biz-1' },
    });

    expect(captured).toBe(true);
    expect(posthogCtor).toHaveBeenCalledWith('phc_test', {
      host: 'https://posthog.test',
    });
    expect(mockCapture).toHaveBeenCalledWith({
      event: 'activation_completed',
      distinctId: 'acct-1',
      properties: { business_id: 'biz-1' },
    });
  });

  it('shutdownAnalytics flushes the client and resets lazy state', async () => {
    process.env.POSTHOG_API_KEY = 'phc_test';
    const { captureAnalyticsEvent, shutdownAnalytics } = await loadModule();

    captureAnalyticsEvent({ event: 'first', distinctId: 'acct-1' });
    await shutdownAnalytics();
    captureAnalyticsEvent({ event: 'second', distinctId: 'acct-1' });

    expect(mockShutdown).toHaveBeenCalledTimes(1);
    expect(posthogCtor).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 4: Run wrapper tests to verify they fail**

Run:

```bash
pnpm exec vitest run src/lib/analytics/__tests__/posthog.test.ts
```

Expected: FAIL because `src/lib/analytics/posthog.ts` does not exist.

- [ ] **Step 5: Add the PostHog wrapper**

Create `src/lib/analytics/posthog.ts`:

```ts
import { PostHog } from 'posthog-node';

interface CaptureAnalyticsEventInput {
  event: string;
  distinctId: string;
  properties?: Record<string, unknown>;
}

type PostHogClient = Pick<PostHog, 'capture' | 'shutdown'>;

let client: PostHogClient | null | undefined;

function getPostHogClient(): PostHogClient | null {
  if (client !== undefined) return client;

  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey) {
    client = null;
    return client;
  }

  client = new PostHog(apiKey, {
    host: process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com',
  });
  return client;
}

export function captureAnalyticsEvent(
  input: CaptureAnalyticsEventInput,
): boolean {
  const posthog = getPostHogClient();
  if (!posthog) return false;

  posthog.capture({
    event: input.event,
    distinctId: input.distinctId,
    properties: input.properties,
  });
  return true;
}

export async function shutdownAnalytics(): Promise<void> {
  const posthog = client;
  client = undefined;
  if (posthog) {
    await posthog.shutdown();
  }
}
```

- [ ] **Step 6: Run wrapper tests to verify they pass**

Run:

```bash
pnpm exec vitest run src/lib/analytics/__tests__/posthog.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add package.json pnpm-lock.yaml .env.example src/lib/analytics/posthog.ts src/lib/analytics/__tests__/posthog.test.ts
git commit -m "feat: add worker analytics client"
```

## Task 5: Publisher Activation Chokepoint

**Files:**
- Create: `worker/jobs/publisher/activation.ts`
- Create: `worker/jobs/publisher/__tests__/activation.test.ts`

- [ ] **Step 1: Write failing activation helper tests**

Create `worker/jobs/publisher/__tests__/activation.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSql, sqlReturnQueue, mockCaptureAnalyticsEvent } = vi.hoisted(() => {
  const sqlReturnQueue: unknown[] = [];
  const mockSql = vi.fn((_s: TemplateStringsArray, ..._v: unknown[]) => {
    return Promise.resolve(sqlReturnQueue.shift() ?? []);
  });
  return {
    mockSql,
    sqlReturnQueue,
    mockCaptureAnalyticsEvent: vi.fn(),
  };
});

vi.mock('../../../../src/lib/db/server', () => ({
  sql: mockSql,
}));

vi.mock('../../../../src/lib/analytics/posthog', () => ({
  captureAnalyticsEvent: mockCaptureAnalyticsEvent,
}));

function activationRow(overrides: Record<string, unknown> = {}) {
  return {
    account_id: 'acct-1',
    account_created_at: new Date('2026-05-01T00:00:00Z'),
    response_id: 'resp-1',
    business_id: 'biz-1',
    review_id: 'rev-1',
    posted_at: new Date('2026-05-03T12:00:00Z'),
    first_response_id: 'resp-1',
    ...overrides,
  };
}

describe('maybeCaptureActivationCompleted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sqlReturnQueue.length = 0;
  });

  it('captures activation for the first posted response within 7 days', async () => {
    sqlReturnQueue.push([activationRow()]);
    const { maybeCaptureActivationCompleted } = await import('../activation');

    await maybeCaptureActivationCompleted({
      responseId: 'resp-1',
      businessId: 'biz-1',
      reviewId: 'rev-1',
      logger: { warn: vi.fn() },
    });

    expect(mockCaptureAnalyticsEvent).toHaveBeenCalledWith({
      event: 'activation_completed',
      distinctId: 'acct-1',
      properties: {
        account_id: 'acct-1',
        business_id: 'biz-1',
        response_id: 'resp-1',
        review_id: 'rev-1',
        days_to_activation: 2.5,
      },
    });
  });

  it('skips when the posted response is not the account first', async () => {
    sqlReturnQueue.push([activationRow({ first_response_id: 'resp-older' })]);
    const { maybeCaptureActivationCompleted } = await import('../activation');

    await maybeCaptureActivationCompleted({ responseId: 'resp-1', businessId: 'biz-1', reviewId: 'rev-1' });

    expect(mockCaptureAnalyticsEvent).not.toHaveBeenCalled();
  });

  it('skips when first post is outside the 7-day activation window', async () => {
    sqlReturnQueue.push([
      activationRow({
        account_created_at: new Date('2026-05-01T00:00:00Z'),
        posted_at: new Date('2026-05-09T00:00:01Z'),
      }),
    ]);
    const { maybeCaptureActivationCompleted } = await import('../activation');

    await maybeCaptureActivationCompleted({ responseId: 'resp-1', businessId: 'biz-1', reviewId: 'rev-1' });

    expect(mockCaptureAnalyticsEvent).not.toHaveBeenCalled();
  });

  it('logs and suppresses analytics capture errors', async () => {
    sqlReturnQueue.push([activationRow()]);
    mockCaptureAnalyticsEvent.mockImplementationOnce(() => {
      throw new Error('posthog unavailable');
    });
    const logger = { warn: vi.fn() };
    const { maybeCaptureActivationCompleted } = await import('../activation');

    await expect(
      maybeCaptureActivationCompleted({ responseId: 'resp-1', businessId: 'biz-1', reviewId: 'rev-1', logger }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('activation_completed capture failed'),
    );
  });
});
```

- [ ] **Step 2: Run activation tests to verify they fail**

Run:

```bash
pnpm exec vitest run worker/jobs/publisher/__tests__/activation.test.ts
```

Expected: FAIL because `worker/jobs/publisher/activation.ts` does not exist.

- [ ] **Step 3: Add activation helper**

Create `worker/jobs/publisher/activation.ts`:

```ts
import { sql } from '../../../src/lib/db/server';
import { captureAnalyticsEvent } from '../../../src/lib/analytics/posthog';

const ACTIVATION_WINDOW_DAYS = 7;
const MS_PER_DAY = 86_400_000;

interface ActivationLogger {
  warn(message: string): void;
}

export interface PostedResponseActivationInput {
  responseId: string;
  businessId: string;
  reviewId: string;
  logger?: ActivationLogger;
}

interface ActivationRow {
  account_id: string;
  account_created_at: Date;
  response_id: string;
  business_id: string;
  review_id: string;
  posted_at: Date;
  first_response_id: string;
}

export async function maybeCaptureActivationCompleted(
  input: PostedResponseActivationInput,
): Promise<void> {
  try {
    const [row] = await sql<ActivationRow[]>`
      SELECT
        a.id AS account_id,
        a.created_at AS account_created_at,
        r.id AS response_id,
        r.business_id,
        r.review_id,
        r.posted_at,
        first_post.id AS first_response_id
      FROM responses r
      JOIN businesses b ON b.id = r.business_id
      JOIN accounts a ON a.id = b.account_id
      JOIN LATERAL (
        SELECT r2.id, r2.posted_at
        FROM responses r2
        JOIN businesses b2 ON b2.id = r2.business_id
        WHERE b2.account_id = a.id
          AND r2.status = 'posted'
          AND r2.posted_at IS NOT NULL
        ORDER BY r2.posted_at ASC, r2.id ASC
        LIMIT 1
      ) first_post ON TRUE
      WHERE r.id = ${input.responseId}::uuid
        AND r.business_id = ${input.businessId}::uuid
        AND r.status = 'posted'
        AND r.posted_at IS NOT NULL
      LIMIT 1
    `;

    if (!row) return;
    if (row.first_response_id !== row.response_id) return;

    const daysToActivation =
      (new Date(row.posted_at).getTime() -
        new Date(row.account_created_at).getTime()) /
      MS_PER_DAY;

    if (daysToActivation < 0 || daysToActivation > ACTIVATION_WINDOW_DAYS) {
      return;
    }

    captureAnalyticsEvent({
      event: 'activation_completed',
      distinctId: row.account_id,
      properties: {
        account_id: row.account_id,
        business_id: row.business_id,
        response_id: row.response_id,
        review_id: row.review_id,
        days_to_activation: Number(daysToActivation.toFixed(4)),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    input.logger?.warn(`activation_completed capture failed for response=${input.responseId}: ${message}`);
  }
}
```

This deterministic earliest-post query handles near-simultaneous first posts better than "count prior posts": after both commits, only the earliest `posted_at, id` row emits. If one worker queries before the other commits, it emits for itself; the later worker then sees a first response and skips.

- [ ] **Step 4: Run activation tests to verify they pass**

Run:

```bash
pnpm exec vitest run worker/jobs/publisher/__tests__/activation.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add worker/jobs/publisher/activation.ts worker/jobs/publisher/__tests__/activation.test.ts
git commit -m "feat: add activation analytics chokepoint"
```

## Task 6: Wire Activation into Main Publish Path

**Files:**
- Modify: `worker/jobs/publisher/ResponsePublisherWorker.ts`
- Modify: `worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts`

- [ ] **Step 1: Add failing worker test for main publish success**

In `ResponsePublisherWorker.test.ts`, add `mockMaybeCaptureActivationCompleted` to the hoisted block and mock:

```ts
mockMaybeCaptureActivationCompleted: vi.fn().mockResolvedValue(undefined),
```

```ts
vi.mock('../activation', () => ({
  maybeCaptureActivationCompleted: mockMaybeCaptureActivationCompleted,
}));
```

Clear it in `beforeEach`.

Extend `posts via Zernio and marks response posted on success`:

```ts
expect(mockMaybeCaptureActivationCompleted).toHaveBeenCalledWith({
  responseId: 'resp-1',
  businessId: 'biz-1',
  reviewId: 'rev-1',
  logger: expect.any(Object),
});
```

Add a best-effort regression test:

```ts
it('still completes outbox when activation capture fails on main success', async () => {
  pushZernioSuccessSequence();
  mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
  mockPostReply.mockResolvedValueOnce({
    comment: 'Thank you for your kind review!',
    updateTime: '2026-04-27T00:00:00Z',
  });
  mockMaybeCaptureActivationCompleted.mockRejectedValueOnce(new Error('analytics down'));

  await handlePublishResponse(makeJob());

  expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1', undefined);
});
```

- [ ] **Step 2: Run worker test to verify it fails**

Run:

```bash
pnpm exec vitest run worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts
```

Expected: FAIL because `ResponsePublisherWorker.ts` does not call the activation helper.

- [ ] **Step 3: Wire helper after main posted update**

In `ResponsePublisherWorker.ts`, import:

```ts
import { maybeCaptureActivationCompleted } from './activation';
```

After the main `UPDATE responses SET status = 'posted'` and before `markOutboxCompleted`, add:

```ts
await maybeCaptureActivationCompleted({
  responseId: response_id,
  businessId,
  reviewId: response.review_id,
  logger,
});
```

This call is safe even if the guarded update affected 0 rows because the helper re-reads `status = 'posted'`; it will no-op if the response is not posted.

- [ ] **Step 4: Run worker test to verify it passes**

Run:

```bash
pnpm exec vitest run worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add worker/jobs/publisher/ResponsePublisherWorker.ts worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts
git commit -m "feat: capture activation on publish success"
```

## Task 7: Wire Activation into Edit-Publish Posted Outcomes

**Files:**
- Modify: `worker/jobs/publisher/edit-publish.ts`
- Modify: `worker/jobs/publisher/ResponsePublisherWorker.ts`
- Modify: `worker/jobs/publisher/__tests__/edit-publish.test.ts`
- Modify: `worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts`

- [ ] **Step 1: Update edit-publish tests for posted candidates**

In `edit-publish.test.ts`, update success expectations:

```ts
expect(result).toEqual({
  outcome: 'completed',
  postedResponse: {
    responseId: 'resp-1',
    businessId: 'biz-1',
    reviewId: 'rev-1',
  },
});
```

Apply that assertion to:

- `DELETE success + POST success → sibling superseded, candidate posted, marker cleared`
- `409 matches_our_text → sibling superseded, candidate posted, marker cleared`
- `orphan retry + POST success → candidate posted, marker cleared, no sibling supersede`

For `409 mismatch after DELETE success → sibling + candidate superseded, exception inserted`, add:

```ts
expect(result).toEqual({ outcome: 'failed', reason: 'edit_publish_409_mismatch_after_delete' });
const callTexts = callTextsWithValues();
expect(callTexts.some((t) => /SET\s+status = 'posted'/.test(t))).toBe(false);
```

This explicitly verifies the review note: `409_mismatch_after_delete` does not write `posted` through a hidden path today.

- [ ] **Step 2: Update ResponsePublisherWorker edit-dispatch tests**

In `ResponsePublisherWorker.test.ts`, add a test:

```ts
it('captures activation when edit-publish returns a posted response', async () => {
  process.env.EDIT_REPLIES_ENABLED = 'true';
  sqlReturnQueue.push([mockResponseRow({ status: 'edited' })]);
  sqlReturnQueue.push([mockBusinessRow()]);
  sqlReturnQueue.push([mockZernioConnectionRow()]);
  sqlReturnQueue.push([{ id: 'resp-posted-sibling' }]);
  mockLookupZernioReviewId.mockResolvedValueOnce('zernio-rev-id-1');
  mockRunEditPublishIfApplicable.mockResolvedValueOnce({
    outcome: 'completed',
    postedResponse: { responseId: 'resp-1', businessId: 'biz-1', reviewId: 'rev-1' },
  });

  await handlePublishResponse(makeJob());

  expect(mockMaybeCaptureActivationCompleted).toHaveBeenCalledWith({
    responseId: 'resp-1',
    businessId: 'biz-1',
    reviewId: 'rev-1',
    logger: expect.any(Object),
  });
  expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('outbox-pub-1', undefined);
});
```

- [ ] **Step 3: Run edit and worker tests to verify they fail**

Run:

```bash
pnpm exec vitest run worker/jobs/publisher/__tests__/edit-publish.test.ts worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts
```

Expected: FAIL because edit-publish does not return posted candidates and the worker does not handle them.

- [ ] **Step 4: Extend edit-publish outcome type**

In `edit-publish.ts`, import the activation input type:

```ts
import type { PostedResponseActivationInput } from './activation';
```

Change the completed outcome type:

```ts
export type EditPublishOutcome =
  | { outcome: 'completed'; postedResponse?: PostedResponseActivationInput }
  | { outcome: 'failed'; reason: string }
  | { outcome: 'throw'; error: unknown }
  | { outcome: 'continue_to_fresh' };
```

Add a helper inside `edit-publish.ts`:

```ts
function postedResponseActivationInput(args: {
  responseId: string;
  businessId: string;
  reviewId: string;
  logger: WorkerLogger;
}): PostedResponseActivationInput {
  return {
    responseId: args.responseId,
    businessId: args.businessId,
    reviewId: args.reviewId,
    logger: args.logger,
  };
}
```

In the final outcome switch, return candidates for `success` and `409_matches`:

```ts
case '409_matches':
case 'success':
  return {
    outcome: 'completed',
    postedResponse: postedResponseActivationInput({ responseId, businessId, reviewId, logger }),
  };
```

Leave `409_mismatch_after_delete` as failed with no posted candidate.

- [ ] **Step 5: Handle edit-publish candidate in worker**

In `ResponsePublisherWorker.ts`, in the `case 'completed'` branch for `runEditPublishIfApplicable`, add:

```ts
if (result.postedResponse) {
  await maybeCaptureActivationCompleted(result.postedResponse);
}
await markOutboxCompleted(outboxId, outboxAttempt);
return;
```

- [ ] **Step 6: Run edit and worker tests to verify they pass**

Run:

```bash
pnpm exec vitest run worker/jobs/publisher/__tests__/edit-publish.test.ts worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 7**

```bash
git add worker/jobs/publisher/edit-publish.ts worker/jobs/publisher/ResponsePublisherWorker.ts worker/jobs/publisher/__tests__/edit-publish.test.ts worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts
git commit -m "feat: capture activation on edit publish"
```

## Task 8: Wire Activation into Idempotent 409 Reconciliation

**Files:**
- Modify: `worker/jobs/publisher/publisher-error-handlers.ts`
- Modify: `worker/jobs/publisher/__tests__/publisher-error-handlers.test.ts`

- [ ] **Step 1: Add failing 409 reconciliation activation test**

In `publisher-error-handlers.test.ts`, add a mock:

```ts
vi.mock('../activation', () => ({
  maybeCaptureActivationCompleted: vi.fn().mockResolvedValue(undefined),
}));
```

Import the mock in the test body where needed:

```ts
const { maybeCaptureActivationCompleted } = await import('../activation');
```

In the `verify409AndDispose` text-match test, assert:

```ts
expect(maybeCaptureActivationCompleted).toHaveBeenCalledWith({
  responseId: 'R',
  businessId: 'B',
  reviewId: 'rev',
  logger: expect.any(Object),
});
```

Add a best-effort test:

```ts
it('409 text match still marks outbox complete when activation capture fails', async () => {
  const { zernioClient } = await import('@/lib/zernio/client');
  const { sql } = await import('@/lib/db/server');
  const { markOutboxCompleted } = await import('@/lib/shared/outbox');
  const { maybeCaptureActivationCompleted } = await import('../activation');

  (zernioClient.listAllReviews as any).mockResolvedValueOnce([
    {
      id: 'zr',
      reviewReply: { comment: 'Thanks!', updateTime: '2026-05-01T00:00:00Z' },
    },
  ]);
  (sql as any).mockResolvedValueOnce(Object.assign([], { count: 1 }));
  (maybeCaptureActivationCompleted as any).mockRejectedValueOnce(new Error('analytics down'));

  await expect(
    verify409AndDispose({
      response_id: 'R',
      business_id: 'B',
      review_id: 'rev',
      account_id: 'A',
      location_id: 'L',
      zernio_review_id: 'zr',
      approved_text: 'Thanks!',
      outboxId: 'outbox-1',
      outboxAttempt: 1,
      logger: mkLogger() as any,
    }),
  ).resolves.toEqual({ outcome: 'posted' });
  expect(markOutboxCompleted).toHaveBeenCalledWith('outbox-1', 1);
});
```

- [ ] **Step 2: Run publisher error-handler tests to verify they fail**

Run:

```bash
pnpm exec vitest run worker/jobs/publisher/__tests__/publisher-error-handlers.test.ts
```

Expected: FAIL because `verify409AndDispose` does not call the activation helper.

- [ ] **Step 3: Wire helper after text-match posted update**

In `publisher-error-handlers.ts`, import:

```ts
import { maybeCaptureActivationCompleted } from './activation';
```

After the text-match `UPDATE responses SET status = 'posted'` and before `markOutboxCompleted`, add:

```ts
await maybeCaptureActivationCompleted({
  responseId: response_id,
  businessId: business_id,
  reviewId: review_id,
  logger,
});
```

The activation helper catches and logs analytics failures; this path still marks the outbox complete.

- [ ] **Step 4: Run publisher error-handler tests to verify they pass**

Run:

```bash
pnpm exec vitest run worker/jobs/publisher/__tests__/publisher-error-handlers.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 8**

```bash
git add worker/jobs/publisher/publisher-error-handlers.ts worker/jobs/publisher/__tests__/publisher-error-handlers.test.ts
git commit -m "feat: capture activation on 409 reconciliation"
```

## Task 9: Final Verification

**Files:**
- Verify all files changed in Tasks 1-8.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/migration-043-structure.test.ts src/lib/audit/__tests__/log.test.ts worker/ingress/__tests__/stripe-webhook-handlers.test.ts src/lib/analytics/__tests__/posthog.test.ts worker/jobs/publisher/__tests__/activation.test.ts worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts worker/jobs/publisher/__tests__/edit-publish.test.ts worker/jobs/publisher/__tests__/publisher-error-handlers.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 4: Inspect changed SQL for migration safety**

Run:

```bash
sed -n '1,140p' supabase/migrations/043_step_1_keystones.sql
```

Expected: only additive nullable columns and comments; no `DROP`, `UPDATE`, `DELETE`, or `INSERT`.

- [ ] **Step 5: Inspect publisher posted transitions**

Run:

```bash
rg -n "SET status = 'posted'|SET status = 'posted',|status = 'posted'" worker/jobs/publisher
```

Expected: every code path that writes `responses.status = 'posted'` either calls `maybeCaptureActivationCompleted` after commit/update or returns a `postedResponse` handled by `ResponsePublisherWorker`. Confirm `409_mismatch_after_delete` has no posted update.

## Self-Review Notes

- Spec coverage: migration, `past_due_at` set/clear/cancel behavior, helper-backed billing audit writes, PostHog no-op wrapper, shared activation chokepoint, all current posted transitions, and verification are covered.
- Placeholder scan: no `TBD`, `TODO`, or "write tests for the above" placeholders.
- Concurrency note resolved: activation helper uses deterministic earliest posted response by `posted_at, id`, not a fragile prior-count check.
- 409 mismatch note resolved: implementation plan includes a direct test/grep confirmation that `409_mismatch_after_delete` does not write `posted`.
