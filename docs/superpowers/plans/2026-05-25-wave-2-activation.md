# Wave 2 Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Wave 2 activation readiness: first-party activation analytics, onboarding/Zernio/CSV polish, past-due recovery with shared worker/UI grace math, MFA/AAL2 gates, support surfaces, and audited admin impersonation.

**Architecture:** Use one activation spine with independently reviewable slices. Vercel/client code records first-party facts only; Railway workers dispatch PostHog events and own long-running side effects. Past-due recovery uses one shared helper consumed by UI, route guards, and `subscription-guard.ts`; admin money/support powers require AAL2 before they ship.

**Tech Stack:** Next.js App Router, TypeScript, Postgres.js, Supabase Auth/MFA, BullMQ/Railway workers, PostHog server SDK, Upstash Redis cache, Vitest, Playwright where useful.

---

## Migration Order

- Migration `046`: `analytics_events` for first-party analytics enqueue/dispatch.
- Migration `047`: `impersonation_sessions` for admin-owned view-as sessions.
- If another migration lands before either slice, renumber the later file and update tests/docs in the same PR.

## File Structure

### Analytics

- Create `supabase/migrations/046_analytics_events.sql`: first-party analytics queue table.
- Create `src/lib/analytics/events.ts`: event-name allowlist, property schemas, event-key helpers.
- Create `src/lib/analytics/enqueue.ts`: DB insert helper for `analytics_events`.
- Create `src/app/api/analytics/enqueue/route.ts`: same-origin first-party enqueue route; no PostHog calls.
- Create `worker/background/pollers/AnalyticsDispatchPoller.ts`: Postgres-state-driven dispatcher that calls `captureAnalyticsEvent`.
- Modify `worker/index.ts`: start/stop `AnalyticsDispatchPoller`.
- Modify `src/lib/analytics/posthog.ts`: accept `$insert_id` in properties if not already supported by the generic `properties` bag.
- Test in `src/lib/shared/__tests__/migration-046-analytics-events.test.ts`, `src/lib/analytics/__tests__/events.test.ts`, `src/lib/analytics/__tests__/enqueue.test.ts`, `src/app/api/analytics/enqueue/__tests__/route.test.ts`, `worker/background/pollers/__tests__/AnalyticsDispatchPoller.test.ts`.

### Activation Instrumentation And Polish

- Modify `src/app/api/auth/signup/route.ts`: enqueue `signup_started` if not already captured from client entry.
- Modify `src/app/api/auth/verify-otp/route.ts`: enqueue `email_verified` after successful verification.
- Modify `src/app/onboarding/start/StartLocationClient.tsx`, `src/app/onboarding/demo/PaywallWithDemoClient.tsx`, and `src/components/auth/auth-island/SignupForm.tsx`: capture `sample_demo_started` / `sample_demo_to_signup` / `signup_started` through the first-party route.
- Modify `src/app/(authenticated)/dashboard/connect/page.tsx`: help link, redirect timeout/manual link, `gbp_connect_started` / `gbp_connect_failed`.
- Modify `src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts`: enqueue `gbp_connected` inside the active-connection transaction.
- Modify `src/app/api/zernio/connect/_shared/finalize/__tests__/finalize-modules.test.ts`: cover the enqueue alongside the connection upsert.
- Modify `worker/jobs/ResponseGeneratorWorker.ts`: enqueue `first_response_drafted` after response commit using deterministic event key.
- Create `docs/analytics/events.md`.
- Create `docs/help/connect-google-business.md`.
- Create `public/csv-templates/locations.csv` and `public/csv-templates/README.md`.
- Create `src/app/admin/locations/csv-import/page.tsx` and `src/app/admin/locations/csv-import/CsvImportClient.tsx`: CSV upload UI that posts to `src/app/api/admin/locations/csv-import/route.ts`.
- Modify `src/components/AdminNav.tsx` and `src/app/admin/businesses/page.tsx`: add clear entry points to the CSV import UI.

### Past-Due Recovery

- Create `src/lib/shared/past-due-recovery.ts`: single source of truth for deadlines, phases, extension parsing.
- Modify `src/lib/shared/subscription-guard.ts`: signature change from `(status, businessUpdatedAt, workerType)` to object input using `pastDueAt` and `accountFlags`; this is a latent bug fix because `businesses.updated_at` can shift the grace window on unrelated writes.
- Update all current `checkSubscription` callers:
  - `worker/jobs/zernio/ZernioBackfillWorker.ts`
  - `worker/jobs/summary-report-helpers.ts`
  - `worker/background/pollers/ZernioRecentReviewPoller.ts`
  - `worker/jobs/notification/eligibility.ts`
  - `worker/jobs/zernio/ZernioReviewIngestWorker.ts`
  - `worker/jobs/OwnerEmailWorker.ts`
  - `worker/jobs/ResponseGeneratorWorker.ts`
  - `worker/jobs/OnboardingDripWorker.ts`
  - `worker/jobs/EngagementAlertWorker.ts`
  - `worker/jobs/publisher/ResponsePublisherWorker.ts`
  - tests in `src/lib/shared/__tests__/security.test.ts`, `src/lib/shared/__tests__/subscription-guard.test.ts`, `src/lib/cross-area-flows/__tests__/cross-area-flows.test.ts`
- Modify dashboard data loading/types to include `past_due_at`.
- Modify `src/components/dashboard/SubscriptionStatusBanner.tsx` and `src/components/DashboardContent.tsx`.
- Add read-only route/action helper used by owner write routes.

### MFA And Grant Extension

- Create `src/lib/auth/mfa.ts`: Supabase MFA wrapper and AAL helpers.
- Create `src/app/(authenticated)/settings/security/page.tsx` and client component.
- Modify `src/components/dashboard/SettingsTabs.tsx` and `src/components/dashboard/settings/SettingsShell.tsx`: surface the Security tab.
- Create `src/app/mfa/challenge/page.tsx`.
- Modify billing/admin sensitive routes to call `requireAal2`.
- Extend `src/lib/shared/rate-limit.ts` callers for password reset, login failure, and MFA attempts.
- Create admin grant-extension route and UI after AAL2 helper exists. Prefer `accounts.flags.past_due_extension`; audit with `writeAccountAuditLog`.

### Support And Impersonation

- Create `docs/help/{connect-google-business,response-pending,brand-voice,billing-past-due,csv-import}.md`.
- Create `docs/support/macros/{past-due-extension,connect-google-business,response-pending,brand-voice,csv-import,security-report}.md`.
- Create `src/app/(public)/help/contact/page.tsx`.
- Create `supabase/migrations/047_impersonation_sessions.sql`.
- Create `src/lib/admin/impersonation/session.ts`: server-only session start/end/load helpers.
- Create `src/lib/admin/impersonation/cookie.ts`: signed httpOnly cookie helpers.
- Create `src/lib/admin/impersonation/guard.ts`: destructive-action allowlist.
- Create `src/app/admin/impersonate/page.tsx`, `src/app/admin/impersonate/[sessionId]/view/page.tsx`, and admin-prefixed impersonation APIs.

---

## Task 1: Analytics Events Schema And Core Helpers

**Files:**
- Create: `supabase/migrations/046_analytics_events.sql`
- Create: `src/lib/analytics/events.ts`
- Create: `src/lib/analytics/enqueue.ts`
- Test: `src/lib/shared/__tests__/migration-046-analytics-events.test.ts`
- Test: `src/lib/analytics/__tests__/events.test.ts`
- Test: `src/lib/analytics/__tests__/enqueue.test.ts`

- [ ] **Step 1: Write migration structure tests**

Create `src/lib/shared/__tests__/migration-046-analytics-events.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/046_analytics_events.sql'),
  'utf8',
);

describe('migration 046 - analytics_events', () => {
  it('creates analytics_events as a local first-party dispatch queue', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS analytics_events\s*\(/i);
    expect(sql).toMatch(/id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
    expect(sql).toMatch(/event_key TEXT NOT NULL UNIQUE/i);
    expect(sql).toMatch(/event_name TEXT NOT NULL/i);
    expect(sql).toMatch(/distinct_id TEXT NOT NULL/i);
    expect(sql).toMatch(/properties JSONB NOT NULL DEFAULT '\{\}'::jsonb/i);
    expect(sql).toMatch(/locked_at TIMESTAMPTZ/i);
    expect(sql).toMatch(/status TEXT NOT NULL DEFAULT 'pending'/i);
  });

  it('adds dispatch indexes for pending rows and account lookup', () => {
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_analytics_events_pending/i);
    expect(sql).toMatch(/WHERE status = 'pending'/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS idx_analytics_events_account/i);
  });

  it('does not add posthog-js or a browser SDK artifact', () => {
    expect(sql).not.toMatch(/posthog-js/i);
  });
});
```

- [ ] **Step 2: Run migration test and verify it fails**

Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/migration-046-analytics-events.test.ts
```

Expected: FAIL because `supabase/migrations/046_analytics_events.sql` does not exist.

- [ ] **Step 3: Add migration 046**

Create `supabase/migrations/046_analytics_events.sql`:

```sql
-- Migration 046: first-party analytics dispatch queue
--
-- Vercel/client code records first-party facts here. Railway workers dispatch
-- to PostHog asynchronously so no browser or Next.js route calls PostHog.

CREATE TABLE IF NOT EXISTS analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key TEXT NOT NULL UNIQUE,
  event_name TEXT NOT NULL,
  distinct_id TEXT NOT NULL,
  anonymous_id TEXT,
  account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dispatched_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE analytics_events IS
  'First-party analytics queue. Next.js/client code writes rows; Railway dispatches to PostHog.';

COMMENT ON COLUMN analytics_events.id IS
  'Application code should pass UUIDv7. gen_random_uuid() is a database fallback only.';

CREATE INDEX IF NOT EXISTS idx_analytics_events_pending
  ON analytics_events (available_at, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_analytics_events_account
  ON analytics_events (account_id, occurred_at DESC)
  WHERE account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_analytics_events_status
  ON analytics_events (status, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_events_locked
  ON analytics_events (locked_at)
  WHERE status = 'dispatching';
```

- [ ] **Step 4: Add event allowlist tests**

Create `src/lib/analytics/__tests__/events.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_EVENT_NAMES,
  isAnalyticsEventName,
  makeAnalyticsEventKey,
  sanitizeAnalyticsProperties,
} from '../events';

describe('analytics events', () => {
  it('contains the Wave 2 activation event names', () => {
    expect(ANALYTICS_EVENT_NAMES).toEqual(expect.arrayContaining([
      'signup_started',
      'email_verified',
      'sample_demo_started',
      'sample_demo_to_signup',
      'gbp_connect_started',
      'gbp_connect_failed',
      'gbp_connected',
      'first_review_ingested',
      'first_response_drafted',
      'activation_completed',
    ]));
  });

  it('rejects unknown event names', () => {
    expect(isAnalyticsEventName('signup_started')).toBe(true);
    expect(isAnalyticsEventName('freeform_event')).toBe(false);
  });

  it('creates deterministic idempotency keys', () => {
    expect(makeAnalyticsEventKey('first_response_drafted', ['acct-1'])).toBe('first_response_drafted:acct-1');
  });

  it('drops sensitive properties', () => {
    const result = sanitizeAnalyticsProperties({
      account_id: 'acct-1',
      response_text: 'secret response',
      approval_token: 'raw-token',
      nested: { user_agent: 'ok', review_text: 'secret review' },
    });
    expect(result).toEqual({
      account_id: 'acct-1',
      nested: { user_agent: 'ok' },
    });
  });
});
```

- [ ] **Step 5: Implement event allowlist**

Create `src/lib/analytics/events.ts`:

```ts
export const ANALYTICS_EVENT_NAMES = [
  'signup_started',
  'email_verified',
  'sample_demo_started',
  'sample_demo_to_signup',
  'gbp_connect_started',
  'gbp_connect_failed',
  'gbp_connected',
  'first_review_ingested',
  'first_response_drafted',
  'activation_completed',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

const EVENT_NAME_SET = new Set<string>(ANALYTICS_EVENT_NAMES);

const BLOCKED_PROPERTY_KEYS = new Set([
  'approval_token',
  'approval_token_hash',
  'raw_token',
  'connect_token',
  'response_text',
  'review_text',
  'raw_review',
  'secret',
  'api_key',
]);

export function isAnalyticsEventName(value: string): value is AnalyticsEventName {
  return EVENT_NAME_SET.has(value);
}

export function makeAnalyticsEventKey(eventName: AnalyticsEventName, parts: Array<string | number | null | undefined>): string {
  const suffix = parts
    .filter((part): part is string | number => part !== null && part !== undefined && part !== '')
    .map((part) => String(part).replace(/:/g, '_'))
    .join(':');
  return `${eventName}:${suffix}`;
}

export function sanitizeAnalyticsProperties(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (BLOCKED_PROPERTY_KEYS.has(key.toLowerCase())) {
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = sanitizeAnalyticsProperties(value as Record<string, unknown>);
      if (Object.keys(nested).length > 0) {
        output[key] = nested;
      }
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      output[key] = value;
    }
  }
  return output;
}
```

- [ ] **Step 6: Add enqueue tests**

Create `src/lib/analytics/__tests__/enqueue.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSql = vi.fn();

vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (value: unknown) => ({ __jsonb: value }),
}));

vi.mock('uuid', () => ({
  v7: () => '018f0000-0000-7000-8000-000000000001',
}));

import { enqueueAnalyticsEvent } from '../enqueue';

describe('enqueueAnalyticsEvent', () => {
  beforeEach(() => {
    mockSql.mockReset();
  });

  it('inserts analytics_events with sanitized properties and deterministic key', async () => {
    await enqueueAnalyticsEvent({
      eventName: 'first_response_drafted',
      eventKey: 'first_response_drafted:acct-1',
      distinctId: 'acct-1',
      accountId: 'acct-1',
      properties: { account_id: 'acct-1', response_text: 'drop me' },
    });

    const text = mockSql.mock.calls[0]![0].join(' ');
    expect(text).toContain('INSERT INTO analytics_events');
    expect(text).toContain('ON CONFLICT (event_key) DO NOTHING');
    expect(mockSql.mock.calls[0]).toContain('018f0000-0000-7000-8000-000000000001');
    expect(JSON.stringify(mockSql.mock.calls[0])).not.toContain('drop me');
  });
});
```

- [ ] **Step 7: Implement enqueue helper**

Create `src/lib/analytics/enqueue.ts`:

```ts
import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import type { AnalyticsEventName } from './events';
import { sanitizeAnalyticsProperties } from './events';

type SqlExecutor = typeof sql | postgres.TransactionSql;

export interface EnqueueAnalyticsEventInput {
  eventName: AnalyticsEventName;
  eventKey: string;
  distinctId: string;
  anonymousId?: string | null;
  accountId?: string | null;
  userId?: string | null;
  businessId?: string | null;
  properties?: Record<string, unknown>;
  occurredAt?: Date;
}

export async function enqueueAnalyticsEvent(
  input: EnqueueAnalyticsEventInput,
  db: SqlExecutor = sql,
): Promise<void> {
  const properties = sanitizeAnalyticsProperties(input.properties ?? {});
  await db`
    INSERT INTO analytics_events (
      id,
      event_key,
      event_name,
      distinct_id,
      anonymous_id,
      account_id,
      user_id,
      business_id,
      properties,
      occurred_at
    ) VALUES (
      ${uuidv7()}::uuid,
      ${input.eventKey},
      ${input.eventName},
      ${input.distinctId},
      ${input.anonymousId ?? null},
      ${input.accountId ?? null}::uuid,
      ${input.userId ?? null}::uuid,
      ${input.businessId ?? null}::uuid,
      ${jsonb(properties)},
      ${input.occurredAt ?? new Date()}
    )
    ON CONFLICT (event_key) DO NOTHING
  `;
}
```

- [ ] **Step 8: Run tests**

Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/migration-046-analytics-events.test.ts src/lib/analytics/__tests__/events.test.ts src/lib/analytics/__tests__/enqueue.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/046_analytics_events.sql src/lib/analytics/events.ts src/lib/analytics/enqueue.ts src/lib/shared/__tests__/migration-046-analytics-events.test.ts src/lib/analytics/__tests__/events.test.ts src/lib/analytics/__tests__/enqueue.test.ts
git commit -m "feat: add first-party analytics queue"
```

---

## Task 2: Analytics Enqueue Route And Railway Dispatcher Poller

**Files:**
- Create: `src/app/api/analytics/enqueue/route.ts`
- Create: `src/app/api/analytics/enqueue/__tests__/route.test.ts`
- Create: `worker/background/pollers/AnalyticsDispatchPoller.ts`
- Create: `worker/background/pollers/__tests__/AnalyticsDispatchPoller.test.ts`
- Modify: `worker/index.ts`

- [ ] **Step 1: Write route tests**

Create `src/app/api/analytics/enqueue/__tests__/route.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mockEnqueueAnalyticsEvent = vi.fn();

vi.mock('@/lib/analytics/enqueue', () => ({
  enqueueAnalyticsEvent: (...args: unknown[]) => mockEnqueueAnalyticsEvent(...args),
}));

vi.mock('@/lib/shared/rate-limit', () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 4 })),
}));

const APP_URL = 'https://app.example.com';

function req(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${APP_URL}/api/analytics/enqueue`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: APP_URL,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/analytics/enqueue', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = APP_URL;
    mockEnqueueAnalyticsEvent.mockReset();
  });

  it('rejects cross-origin requests before enqueue', async () => {
    const { POST } = await import('../route');
    const res = await POST(req({ eventName: 'signup_started' }, { origin: 'https://evil.example.com' }));
    expect(res.status).toBe(403);
    expect(mockEnqueueAnalyticsEvent).not.toHaveBeenCalled();
  });

  it('rejects unknown event names', async () => {
    const { POST } = await import('../route');
    const res = await POST(req({ eventName: 'freeform_event', clientEventId: 'c1' }));
    expect(res.status).toBe(400);
  });

  it('enqueues allowed pre-account event with anonymous id', async () => {
    const { POST } = await import('../route');
    const res = await POST(req({
      eventName: 'signup_started',
      clientEventId: 'client-1',
      properties: { signup_source: 'homepage' },
    }));
    expect(res.status).toBe(202);
    expect(mockEnqueueAnalyticsEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventName: 'signup_started',
      eventKey: expect.stringMatching(/^signup_started:/),
      properties: { signup_source: 'homepage' },
    }));
  });
});
```

- [ ] **Step 2: Implement enqueue route**

Create `src/app/api/analytics/enqueue/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { v7 as uuidv7 } from 'uuid';
import { enqueueAnalyticsEvent } from '@/lib/analytics/enqueue';
import { isAnalyticsEventName, makeAnalyticsEventKey } from '@/lib/analytics/events';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { checkRateLimit } from '@/lib/shared/rate-limit';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, private' } as const;
const ANON_COOKIE = 'rw_analytics_id';

interface Body {
  eventName?: unknown;
  clientEventId?: unknown;
  properties?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE });
    }
    throw err;
  }

  let body: Body;
  try {
    body = await req.json() as Body;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
  }

  if (typeof body.eventName !== 'string' || !isAnalyticsEventName(body.eventName)) {
    return NextResponse.json({ error: 'invalid_event' }, { status: 400, headers: NO_STORE });
  }

  const cookieStore = await cookies();
  let anonymousId = cookieStore.get(ANON_COOKIE)?.value;
  if (!anonymousId) {
    anonymousId = uuidv7();
  }

  const rate = await checkRateLimit(`analytics:${anonymousId}`, 120, 60, { strict: false });
  if (!rate.allowed) {
    return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { ...NO_STORE, 'Retry-After': '60' } });
  }

  const clientEventId = typeof body.clientEventId === 'string' && body.clientEventId.length <= 80
    ? body.clientEventId
    : uuidv7();
  const eventKey = makeAnalyticsEventKey(body.eventName, [anonymousId, clientEventId]);
  const properties = body.properties && typeof body.properties === 'object' && !Array.isArray(body.properties)
    ? body.properties as Record<string, unknown>
    : {};

  await enqueueAnalyticsEvent({
    eventName: body.eventName,
    eventKey,
    distinctId: anonymousId,
    anonymousId,
    properties,
  });

  const res = NextResponse.json({ ok: true }, { status: 202, headers: NO_STORE });
  res.cookies.set(ANON_COOKIE, anonymousId, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
```

- [ ] **Step 3: Write dispatcher poller tests**

Create `worker/background/pollers/__tests__/AnalyticsDispatchPoller.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSql = vi.fn();
const mockCaptureAnalyticsEvent = vi.fn();

vi.mock('../../../../src/lib/db/server', () => ({ sql: mockSql }));
vi.mock('../../../../src/lib/analytics/posthog', () => ({
  captureAnalyticsEvent: (...args: unknown[]) => mockCaptureAnalyticsEvent(...args),
}));

import { runAnalyticsDispatchOnce } from '../AnalyticsDispatchPoller';

describe('AnalyticsDispatchPoller', () => {
  beforeEach(() => {
    mockSql.mockReset();
    mockCaptureAnalyticsEvent.mockReset();
  });

  it('dispatches pending analytics events and marks them completed', async () => {
    mockSql
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 'evt-1',
        event_key: 'first_response_drafted:acct-1',
        event_name: 'first_response_drafted',
        distinct_id: 'acct-1',
        properties: { account_id: 'acct-1' },
        attempts: 1,
        max_attempts: 5,
      }])
      .mockResolvedValueOnce([]);

    await runAnalyticsDispatchOnce();

    expect(mockCaptureAnalyticsEvent).toHaveBeenCalledWith({
      event: 'first_response_drafted',
      distinctId: 'acct-1',
      properties: {
        account_id: 'acct-1',
        $insert_id: 'first_response_drafted:acct-1',
      },
    });
    expect(mockSql.mock.calls[2]![0].join(' ')).toContain("SET status = 'completed'");
  });
});
```

- [ ] **Step 4: Implement dispatcher poller**

Create `worker/background/pollers/AnalyticsDispatchPoller.ts`:

```ts
import { sql } from '../../../src/lib/db/server';
import { captureAnalyticsEvent } from '../../../src/lib/analytics/posthog';

interface AnalyticsEventRow {
  id: string;
  event_key: string;
  event_name: string;
  distinct_id: string;
  properties: Record<string, unknown> | string;
  attempts: number;
  max_attempts: number;
}

const POLL_INTERVAL_MS = parseInt(process.env.ANALYTICS_DISPATCH_POLL_INTERVAL_MS || '30000', 10);
const BATCH_SIZE = Math.max(1, Math.min(parseInt(process.env.ANALYTICS_DISPATCH_BATCH_SIZE || '50', 10), 250));

let interval: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function runAnalyticsDispatchOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await sql`
      UPDATE analytics_events
      SET status = 'pending',
          locked_at = NULL,
          available_at = NOW()
      WHERE status = 'dispatching'
        AND locked_at < NOW() - INTERVAL '10 minutes'
    `;

    const rows = await sql<AnalyticsEventRow[]>`
      UPDATE analytics_events
      SET status = 'dispatching',
          locked_at = NOW(),
          attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM analytics_events
        WHERE status = 'pending'
          AND available_at <= NOW()
        ORDER BY available_at, created_at
        LIMIT ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, event_key, event_name, distinct_id, properties, attempts, max_attempts
    `;

    for (const row of rows) {
      const properties = typeof row.properties === 'string'
        ? JSON.parse(row.properties) as Record<string, unknown>
        : row.properties;
      try {
        captureAnalyticsEvent({
          event: row.event_name,
          distinctId: row.distinct_id,
          properties: { ...properties, $insert_id: row.event_key },
        });
        await sql`
          UPDATE analytics_events
          SET status = 'completed',
              dispatched_at = NOW(),
              locked_at = NULL,
              last_error = NULL
          WHERE id = ${row.id}::uuid
        `;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await sql`
          UPDATE analytics_events
          SET status = ${row.attempts >= row.max_attempts ? 'failed' : 'pending'},
              locked_at = NULL,
              last_error = ${message},
              available_at = NOW() + INTERVAL '5 minutes'
          WHERE id = ${row.id}::uuid
        `;
      }
    }
  } finally {
    running = false;
  }
}

export function startAnalyticsDispatchPoller(): void {
  console.log(`[AnalyticsDispatchPoller] Starting (interval=${POLL_INTERVAL_MS}ms, batch=${BATCH_SIZE})`);
  runAnalyticsDispatchOnce().catch(console.error);
  interval = setInterval(() => {
    runAnalyticsDispatchOnce().catch(console.error);
  }, POLL_INTERVAL_MS);
}

export function stopAnalyticsDispatchPoller(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
    console.log('[AnalyticsDispatchPoller] Stopped');
  }
}
```

- [ ] **Step 5: Register poller in worker**

Modify `worker/index.ts`:

```ts
import { startAnalyticsDispatchPoller, stopAnalyticsDispatchPoller } from './background/pollers/AnalyticsDispatchPoller';
```

Start near the other pollers:

```ts
  startAnalyticsDispatchPoller();
```

Stop during shutdown:

```ts
  stopAnalyticsDispatchPoller();
```

- [ ] **Step 6: Run tests**

Run:

```bash
pnpm exec vitest run src/app/api/analytics/enqueue/__tests__/route.test.ts worker/background/pollers/__tests__/AnalyticsDispatchPoller.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/analytics/enqueue worker/background/pollers/AnalyticsDispatchPoller.ts worker/background/pollers/__tests__/AnalyticsDispatchPoller.test.ts worker/index.ts
git commit -m "feat: dispatch analytics from worker"
```

---

## Task 3: Activation Instrumentation And Docs

**Files:**
- Create: `docs/analytics/events.md`
- Modify: `src/app/api/auth/signup/route.ts`
- Modify: `src/app/api/auth/verify-otp/route.ts`
- Modify: `worker/jobs/ResponseGeneratorWorker.ts`
- Modify: `src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts`
- Modify tests: `src/app/api/zernio/connect/_shared/finalize/__tests__/finalize-modules.test.ts`
- Test: focused tests for the touched routes/workers

- [ ] **Step 1: Add analytics event docs**

Create `docs/analytics/events.md` with the Wave 2 taxonomy:

```md
# Analytics Events

RepWorth does not use `posthog-js` and Next.js routes do not call PostHog directly. Client and Vercel-owned events are written to `analytics_events`; Railway dispatches them to PostHog.

| Event | Distinct ID | Event key | Durable owner |
|---|---|---|---|
| `signup_started` | anonymous ID | `signup_started:<anonymous_id>:<client_event_id>` | first-party enqueue route |
| `email_verified` | account ID | `email_verified:<user_id>` | verify OTP route |
| `sample_demo_started` | anonymous ID or account ID | `sample_demo_started:<id>:<client_event_id>` | first-party enqueue route |
| `sample_demo_to_signup` | anonymous ID or account ID | `sample_demo_to_signup:<id>:<client_event_id>` | first-party enqueue route |
| `gbp_connect_started` | account ID | `gbp_connect_started:<business_id>:<client_event_id>` | first-party enqueue route |
| `gbp_connect_failed` | account ID | `gbp_connect_failed:<business_id>:<stage>:<client_event_id>` | connect UI/API |
| `gbp_connected` | account ID | `gbp_connected:<business_id>` | Zernio finalize/select-location transaction |
| `first_review_ingested` | account ID | `first_review_ingested:<account_id>` | Zernio ingest worker |
| `first_response_drafted` | account ID | `first_response_drafted:<account_id>` | response generator worker |
| `activation_completed` | account ID | existing Step 1 key | publisher worker |

Never include review text, response text, raw approval tokens, Zernio tokens, MFA codes, provider secrets, or raw CSV content.
```

- [ ] **Step 2: Add first-response-drafted failing test**

Extend `worker/jobs/__tests__/ResponseGeneratorWorker.test.ts` with a test that expects `enqueueAnalyticsEvent` after a first account-level draft commit. Mock `enqueueAnalyticsEvent`:

```ts
vi.mock('../../src/lib/analytics/enqueue', () => ({
  enqueueAnalyticsEvent: vi.fn(),
}));
```

Test behavior:

```ts
it('enqueues first_response_drafted once with deterministic event key', async () => {
  // Existing worker test setup should be reused. Arrange the response commit
  // path, then arrange the first-draft lookup to return no earlier response.
  // Assert enqueueAnalyticsEvent receives:
  expect(enqueueAnalyticsEvent).toHaveBeenCalledWith(expect.objectContaining({
    eventName: 'first_response_drafted',
    eventKey: 'first_response_drafted:acct-1',
    distinctId: 'acct-1',
    accountId: 'acct-1',
    businessId: 'biz-1',
  }));
});
```

Expected before implementation: FAIL because worker does not enqueue `first_response_drafted`.

- [ ] **Step 3: Implement response-generator enqueue**

In `worker/jobs/ResponseGeneratorWorker.ts`, after the response row commit succeeds and before the worker completes the outbox entry, add a helper:

```ts
async function maybeEnqueueFirstResponseDrafted(input: {
  accountId: string;
  businessId: string;
  responseId: string;
  reviewId: string;
  logger?: Pick<Console, 'warn'>;
}): Promise<void> {
  try {
    const [row] = await sql<{ earlier_exists: boolean; email_verified_at: Date | null }[]>`
      SELECT
        EXISTS (
          SELECT 1
          FROM responses r2
          JOIN businesses b2 ON b2.id = r2.business_id
          WHERE b2.account_id = ${input.accountId}::uuid
            AND r2.id <> ${input.responseId}::uuid
            AND r2.created_at IS NOT NULL
          LIMIT 1
        ) AS earlier_exists,
        (
          SELECT occurred_at
          FROM analytics_events
          WHERE event_name = 'email_verified'
            AND account_id = ${input.accountId}::uuid
          ORDER BY occurred_at ASC
          LIMIT 1
        ) AS email_verified_at
    `;
    if (row?.earlier_exists) return;

    const minutesToFirstDraft = row?.email_verified_at
      ? Math.max(0, (Date.now() - new Date(row.email_verified_at).getTime()) / 60_000)
      : null;

    await enqueueAnalyticsEvent({
      eventName: 'first_response_drafted',
      eventKey: `first_response_drafted:${input.accountId}`,
      distinctId: input.accountId,
      accountId: input.accountId,
      businessId: input.businessId,
      properties: {
        account_id: input.accountId,
        business_id: input.businessId,
        response_id: input.responseId,
        review_id: input.reviewId,
        minutes_to_first_draft: minutesToFirstDraft === null ? null : Number(minutesToFirstDraft.toFixed(2)),
      },
    });
  } catch (err) {
    input.logger?.warn(`first_response_drafted enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

Use the actual worker's available response/account variables. If account ID is not currently loaded, extend the worker's context query to include `accounts.id`.

- [ ] **Step 4: Add auth route enqueue**

In `src/app/api/auth/verify-otp/route.ts`, after the successful verification/provisioning transaction has an account/user row, enqueue:

```ts
await enqueueAnalyticsEvent({
  eventName: 'email_verified',
  eventKey: makeAnalyticsEventKey('email_verified', [appUser.id]),
  distinctId: appUser.accountId,
  accountId: appUser.accountId,
  userId: appUser.id,
  properties: {
    account_id: appUser.accountId,
    user_id: appUser.id,
    signup_source: 'self_serve',
  },
});
```

If this route does not have `appUser` as a variable, use the route's actual provisioned `users.id` and `account_id`. Keep it after success only. Do not call PostHog.

- [ ] **Step 5: Add Zernio connected enqueue**

At the transaction point that transitions `zernio_connections.status` to `active`, enqueue an analytics row in the same transaction when practical:

```ts
await enqueueAnalyticsEvent({
  eventName: 'gbp_connected',
  eventKey: makeAnalyticsEventKey('gbp_connected', [businessId]),
  distinctId: accountId,
  accountId,
  businessId,
  properties: {
    account_id: accountId,
    business_id: businessId,
    location_count: locationCount,
  },
}, tx);
```

If the finalize module currently lacks `accountId`, fetch it through `businesses.account_id` in the same transaction. Do not place this in dashboard render code.

- [ ] **Step 6: Add first-review-ingested enqueue**

In `worker/jobs/zernio/zernio-ingest-shared.ts` or the shared point after `processReview` persists a review, enqueue `first_review_ingested:<account_id>` only if no earlier review exists for the account. Use the same idempotent `analytics_events` insert pattern.

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm exec vitest run worker/jobs/__tests__/ResponseGeneratorWorker.test.ts src/app/api/auth/__tests__/verify-otp.test.ts src/app/api/zernio/connect
```

Expected: PASS or existing unrelated skipped DB-gated tests. Fix changed tests in the touched files before continuing.

- [ ] **Step 8: Commit**

```bash
git add docs/analytics/events.md src/app/api/auth/verify-otp/route.ts worker/jobs/ResponseGeneratorWorker.ts worker/jobs/zernio src/app/api/zernio/connect
git commit -m "feat: instrument activation funnel"
```

---

## Task 4: Zernio Connect Help, Demo Entry, And CSV Polish

**Files:**
- Create: `docs/help/connect-google-business.md`
- Create: `public/csv-templates/locations.csv`
- Create: `public/csv-templates/README.md`
- Modify: `src/app/(authenticated)/dashboard/connect/page.tsx`
- Modify: `src/app/onboarding/demo/PaywallWithDemoClient.tsx`
- Modify: `src/app/onboarding/start/StartLocationClient.tsx`
- Modify: `src/components/auth/auth-island/SignupForm.tsx`
- Create: `src/app/admin/locations/csv-import/page.tsx`
- Create: `src/app/admin/locations/csv-import/CsvImportClient.tsx`
- Modify: `src/components/AdminNav.tsx`
- Modify: `src/app/admin/businesses/page.tsx`

- [ ] **Step 1: Add help and CSV template files**

Create `docs/help/connect-google-business.md`:

```md
# Connect Google Business Profile

RepWorth connects through Zernio. You will start in RepWorth, continue through the Zernio/Google consent screen, then return to RepWorth to pick the location if your account has more than one.

Before starting:

- Use a Google account that manages the location.
- Confirm the location is verified in Google Business Profile.
- Keep pop-up blockers from blocking the redirect.

If the redirect does not open, return to RepWorth and use the manual retry link.
```

Create `public/csv-templates/locations.csv`:

```csv
name,placeId
Example Dental,ChIJN1t_tDeuEmsRUsoyG83frY4
Example Cafe,ChIJrTLr-GyuEmsRBfy61i59si0
```

Create `public/csv-templates/README.md`:

```md
# Location CSV Template

Required columns:

- `name`: display name for the location.
- `placeId`: Google Place ID.

Limits:

- Maximum 100 data rows.
- Maximum file size 5 MB.
- Keep one location per row.
```

- [ ] **Step 2: Update connect UI**

In `src/app/(authenticated)/dashboard/connect/page.tsx`, add:

- Help link to `/help/contact` with `docs/help/connect-google-business.md` as the support source copy.
- `redirectPendingUrl` state set when `/api/zernio/connect/start` returns `authUrl`.
- A timeout fallback if `window.location.href = authUrl` does not navigate quickly.

Use this client pattern inside `handleConnect`:

```ts
setRedirectUrl(body.authUrl);
window.setTimeout(() => {
  setActionError('If the connection window did not open, use the manual link below.');
}, 2500);
window.location.href = body.authUrl;
```

Render when `redirectUrl` is present:

```tsx
{redirectUrl ? (
  <a className="text-sm text-blue-600 hover:underline" href={redirectUrl}>
    Open connection manually
  </a>
) : null}
```

Post `gbp_connect_started` and redirect failures to `/api/analytics/enqueue`; do not import PostHog.

- [ ] **Step 3: Add tests for connect fallback**

Extend `src/app/(authenticated)/dashboard/connect/__tests__/page.test.tsx`:

```ts
it('shows manual connection link when redirect is started', async () => {
  // Mock /api/zernio/connect/start to return { authUrl: 'https://zernio.example/connect' }.
  // Click "Connect Google Business".
  // Assert "Open connection manually" link points to the authUrl.
});
```

Run:

```bash
pnpm exec vitest run src/app/\\(authenticated\\)/dashboard/connect/__tests__/page.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Add demo-to-signup capture**

In `src/app/onboarding/demo/PaywallWithDemoClient.tsx`, wrap the plan CTA click with first-party analytics:

```tsx
async function captureDemoToSignup() {
  await fetch('/api/analytics/enqueue', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventName: 'sample_demo_to_signup',
      clientEventId: crypto.randomUUID(),
      properties: { source: 'onboarding_demo' },
    }),
  }).catch(() => undefined);
}
```

Attach to the CTA:

```tsx
<a href="/onboarding/pay" onClick={() => { void captureDemoToSignup(); }}>
  Choose a plan →
</a>
```

- [ ] **Step 5: Implement CSV client validation and partial-success UI**

Create `src/app/admin/locations/csv-import/page.tsx` as a server wrapper and `src/app/admin/locations/csv-import/CsvImportClient.tsx` as the client upload form. Add a `Locations Import` nav item in `src/components/AdminNav.tsx` and a secondary link in the `src/app/admin/businesses/page.tsx` header. The form posts multipart data to `/api/admin/locations/csv-import`.

Use this validation shape:

```ts
export interface ClientCsvValidationError {
  row: number;
  reason: string;
}

export function validateLocationsCsvClient(rows: Array<Record<string, string>>): ClientCsvValidationError[] {
  const failures: ClientCsvValidationError[] = [];
  if (rows.length > 100) {
    failures.push({ row: 0, reason: 'CSV contains more than 100 data rows.' });
  }
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    if (!row.name?.trim()) failures.push({ row: rowNumber, reason: 'Missing name.' });
    if (!row.placeId?.trim()) failures.push({ row: rowNumber, reason: 'Missing placeId.' });
  });
  return failures;
}
```

When the API returns `CsvImportReport`, render:

```tsx
<p>{report.created} of {report.created + report.failedCount} imported</p>
{report.failed.map((failure) => (
  <li key={`${failure.row}:${failure.reason}`}>Row {failure.row}: {failure.reason}</li>
))}
```

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
pnpm exec vitest run src/app/\\(authenticated\\)/dashboard/connect src/app/api/admin/locations/csv-import
```

Expected: PASS.

Commit:

```bash
git add docs/help/connect-google-business.md public/csv-templates src/app/\\(authenticated\\)/dashboard/connect src/app/onboarding/demo src/app/admin
git commit -m "feat: polish activation onboarding"
```

---

## Task 5: Past-Due Recovery Helper And Subscription Guard Signature Migration

**Files:**
- Create: `src/lib/shared/past-due-recovery.ts`
- Test: `src/lib/shared/__tests__/past-due-recovery.test.ts`
- Modify: `src/lib/shared/subscription-guard.ts`
- Modify every `checkSubscription` caller listed in File Structure
- Test: `src/lib/shared/__tests__/subscription-guard.test.ts`, `src/lib/shared/__tests__/security.test.ts`, `src/lib/cross-area-flows/__tests__/cross-area-flows.test.ts`

- [ ] **Step 1: Write recovery helper tests**

Create `src/lib/shared/__tests__/past-due-recovery.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computePastDueRecoveryState } from '../past-due-recovery';

const NOW = new Date('2026-05-25T12:00:00.000Z');

describe('computePastDueRecoveryState', () => {
  it('uses past_due_at as the grace clock', () => {
    const state = computePastDueRecoveryState({
      subscriptionStatus: 'past_due',
      pastDueAt: new Date('2026-05-24T12:00:00.000Z'),
      accountFlags: {},
      now: NOW,
    });
    expect(state.isPastDue).toBe(true);
    expect(state.isReadOnly).toBe(false);
    expect(state.daysRemaining).toBe(6);
  });

  it('marks read-only after seven days without extension', () => {
    const state = computePastDueRecoveryState({
      subscriptionStatus: 'past_due',
      pastDueAt: new Date('2026-05-17T12:00:00.000Z'),
      accountFlags: {},
      now: NOW,
    });
    expect(state.isReadOnly).toBe(true);
  });

  it('extends the cutoff with active past_due_extension flag', () => {
    const state = computePastDueRecoveryState({
      subscriptionStatus: 'past_due',
      pastDueAt: new Date('2026-05-17T12:00:00.000Z'),
      accountFlags: {
        past_due_extension: {
          days: 7,
          expires_at: '2026-06-01T12:00:00.000Z',
          reason: 'card replacement',
        },
      },
      now: NOW,
    });
    expect(state.isReadOnly).toBe(false);
    expect(state.extension?.days).toBe(7);
  });
});
```

- [ ] **Step 2: Implement recovery helper**

Create `src/lib/shared/past-due-recovery.ts`:

```ts
import { SubscriptionStatus } from './subscription-status';

const GRACE_MS = 7 * 86_400_000;

export interface PastDueExtension {
  days: number;
  expires_at: string;
  reason?: string;
  granted_at?: string;
  granted_by_user_id?: string;
}

export interface ComputePastDueRecoveryInput {
  subscriptionStatus: string;
  pastDueAt: Date | string | null | undefined;
  accountFlags?: Record<string, unknown> | null;
  now?: Date;
}

export interface PastDueRecoveryState {
  isPastDue: boolean;
  pastDueAt: Date | null;
  deadline: Date | null;
  daysRemaining: number | null;
  isReadOnly: boolean;
  extension: PastDueExtension | null;
}

function parseExtension(flags: Record<string, unknown> | null | undefined, now: Date): PastDueExtension | null {
  const raw = flags?.past_due_extension;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const ext = raw as Partial<PastDueExtension>;
  if (typeof ext.days !== 'number' || ext.days <= 0 || ext.days > 30) return null;
  if (typeof ext.expires_at !== 'string') return null;
  const expiresAt = new Date(ext.expires_at);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) return null;
  return {
    days: ext.days,
    expires_at: ext.expires_at,
    reason: typeof ext.reason === 'string' ? ext.reason : undefined,
    granted_at: typeof ext.granted_at === 'string' ? ext.granted_at : undefined,
    granted_by_user_id: typeof ext.granted_by_user_id === 'string' ? ext.granted_by_user_id : undefined,
  };
}

export function computePastDueRecoveryState(input: ComputePastDueRecoveryInput): PastDueRecoveryState {
  const now = input.now ?? new Date();
  const isPastDue = input.subscriptionStatus === SubscriptionStatus.PAST_DUE;
  const pastDueAt = input.pastDueAt ? new Date(input.pastDueAt) : null;
  if (!isPastDue || !pastDueAt || !Number.isFinite(pastDueAt.getTime())) {
    return { isPastDue, pastDueAt: null, deadline: null, daysRemaining: null, isReadOnly: false, extension: null };
  }

  const extension = parseExtension(input.accountFlags, now);
  const extensionMs = extension ? extension.days * 86_400_000 : 0;
  const deadline = new Date(pastDueAt.getTime() + GRACE_MS + extensionMs);
  const remainingMs = deadline.getTime() - now.getTime();
  return {
    isPastDue: true,
    pastDueAt,
    deadline,
    daysRemaining: Math.max(0, Math.ceil(remainingMs / 86_400_000)),
    isReadOnly: remainingMs <= 0,
    extension,
  };
}
```

- [ ] **Step 3: Write subscription guard failing tests**

Update `src/lib/shared/__tests__/subscription-guard.test.ts` to use object input:

```ts
expect(checkSubscription({
  status: 'past_due',
  pastDueAt: eightDaysAgo,
  accountFlags: {
    past_due_extension: { days: 7, expires_at: '2026-06-01T00:00:00.000Z' },
  },
  workerType: 'publisher',
  now: NOW,
})).toEqual({ allowed: true });
```

Add a regression test:

```ts
it('does not use unrelated business updated_at as the past-due clock', () => {
  const result = checkSubscription({
    status: 'past_due',
    pastDueAt: new Date(NOW.getTime() - 8 * 86_400_000),
    businessUpdatedAt: NOW,
    accountFlags: {},
    workerType: 'publisher',
    now: NOW,
  });
  expect(result).toEqual({ allowed: false, reason: 'past_due_expired' });
});
```

- [ ] **Step 4: Change subscription guard signature**

Modify `src/lib/shared/subscription-guard.ts`:

```ts
export interface SubscriptionGuardInput {
  status: string;
  workerType: WorkerType;
  pastDueAt?: Date | string | null;
  accountFlags?: Record<string, unknown> | null;
  now?: Date;
  businessUpdatedAt?: Date;
}

export function checkSubscription(input: SubscriptionGuardInput): SubscriptionCheckResult {
  switch (input.status) {
    case SubscriptionStatus.ACTIVE:
      return { allowed: true };
    case SubscriptionStatus.CANCELLED:
      return { allowed: false, reason: 'cancelled' };
    case SubscriptionStatus.PAST_DUE: {
      const recovery = computePastDueRecoveryState({
        subscriptionStatus: input.status,
        pastDueAt: input.pastDueAt,
        accountFlags: input.accountFlags,
        now: input.now,
      });
      return recovery.isReadOnly ? { allowed: false, reason: 'past_due_expired' } : { allowed: true };
    }
    case SubscriptionStatus.PENDING_PAYMENT:
      return input.workerType === 'generator'
        ? { allowed: true }
        : { allowed: false, reason: 'pending_payment' };
    default:
      return { allowed: false, reason: `unknown_status:${input.status}` };
  }
}
```

Import `computePastDueRecoveryState`. Keep `businessUpdatedAt` only as a deprecated test parameter in this task if needed to prove it is ignored; remove it before finalizing if no caller needs it.

- [ ] **Step 5: Update all callers**

For every `checkSubscription(` hit, change account queries to select `accounts.past_due_at` and `accounts.flags` as `account_flags` when not already available.

Example replacement:

```ts
const subCheck = checkSubscription({
  status: acct.subscription_status,
  pastDueAt: acct.past_due_at,
  accountFlags: acct.account_flags ?? acct.flags ?? {},
  workerType: 'publisher',
});
```

This is one explicit migration task, not a mechanical body-only edit. The current signature accepts `businessUpdatedAt`, so every caller and test must be updated in the same PR.

- [ ] **Step 6: Run guard tests**

Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/past-due-recovery.test.ts src/lib/shared/__tests__/subscription-guard.test.ts src/lib/shared/__tests__/security.test.ts src/lib/cross-area-flows/__tests__/cross-area-flows.test.ts
```

Expected: PASS. If worker tests fail because query fixtures lack `past_due_at` / `account_flags`, update fixtures with `past_due_at: null` and `account_flags: {}`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/shared/past-due-recovery.ts src/lib/shared/subscription-guard.ts src/lib/shared/__tests__/past-due-recovery.test.ts src/lib/shared/__tests__/subscription-guard.test.ts src/lib/shared/__tests__/security.test.ts src/lib/cross-area-flows/__tests__/cross-area-flows.test.ts worker src
git commit -m "fix: use account past due clock in subscription guard"
```

---

## Task 6: Past-Due Dashboard, Modal, And Read-Only Route Guards

**Files:**
- Modify: dashboard data types and route modules
- Modify: `src/components/dashboard/SubscriptionStatusBanner.tsx`
- Modify: `src/components/DashboardContent.tsx`
- Create: route/action read-only guard under `src/lib/shared` or `src/lib/auth`
- Modify owner write routes that approve/publish/regenerate/change sends

- [ ] **Step 1: Extend dashboard past-due type tests**

Update existing dashboard API tests to expect `past_due_at` in `DashboardDataPastDue`. If the type test does not exist, add one around the dashboard data mapper:

```ts
expect(data).toMatchObject({
  subscriptionStatus: 'past_due',
  pastDueAt: '2026-05-20T12:00:00.000Z',
});
```

- [ ] **Step 2: Pass past_due_at through dashboard data**

In the dashboard data loader, select `accounts.past_due_at` and `accounts.flags`, then compute:

```ts
const recovery = computePastDueRecoveryState({
  subscriptionStatus: account.subscription_status,
  pastDueAt: account.past_due_at,
  accountFlags: account.flags,
});
```

Expose `pastDueAt`, `pastDueDeadline`, `daysRemaining`, and `isReadOnly`.

- [ ] **Step 3: Update banner component**

Change `PastDueBannerProps`:

```ts
interface PastDueBannerProps {
  billingPortalUrl: string | null;
  pastDueAt: string | null;
  deadline: string | null;
  daysRemaining: number | null;
  isReadOnly: boolean;
  navigate?: (url: string) => void;
}
```

Render variants for day 1, day 3, day 5, and read-only. Use absolute date copy:

```tsx
const deadlineCopy = deadline
  ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(deadline))
  : null;
```

- [ ] **Step 4: Add day-5 modal**

Create a small client component, for example `src/components/dashboard/PastDueModal.tsx`, that stores local dismissal under:

```ts
const key = `rw:past_due_modal:${accountId}:${new Date().toISOString().slice(0, 10)}`;
```

Show only when `daysRemaining !== null && daysRemaining <= 2 && !isReadOnly`.

- [ ] **Step 5: Add read-only guard helper**

Create a route/action helper:

```ts
export function assertWritableSubscription(recovery: PastDueRecoveryState): { ok: true } | { ok: false; status: 402; error: string } {
  if (recovery.isReadOnly) {
    return { ok: false, status: 402, error: 'past_due_read_only' };
  }
  return { ok: true };
}
```

Use it in owner write routes that enqueue generation/publish/send-affecting actions. Do not block billing portal, help/contact, or Settings -> Security.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm exec vitest run src/components/dashboard/__tests__/SubscriptionStatusBanner.test.tsx src/app/api/dashboard/__tests__/route.test.ts src/lib/shared/__tests__/past-due-recovery.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/dashboard src/components/DashboardContent.tsx src/app/api/dashboard src/lib/shared
git commit -m "feat: add past-due recovery UX"
```

---

## Task 7: Supabase MFA, AAL2 Helpers, Settings Security, And Rate Limits

**Files:**
- Create: `src/lib/auth/mfa.ts`
- Create: `src/app/(authenticated)/settings/security/page.tsx`
- Create: `src/app/(authenticated)/settings/security/SecurityClient.tsx`
- Create: `src/app/mfa/challenge/page.tsx`
- Modify: `src/components/dashboard/SettingsTabs.tsx`
- Modify: `src/components/auth/hooks/useLoginSubmit.ts`
- Modify: `src/app/api/auth/callback/route.ts`
- Modify: `src/app/api/auth/forgot-password/route.ts`
- Modify: `src/app/api/auth/reset-password/route.ts`
- Modify: `src/app/api/auth/verify-otp/route.ts`
- Modify: password reset/login/MFA attempt rate-limit callers

- [ ] **Step 1: Add MFA helper tests**

Create `src/lib/auth/__tests__/mfa.test.ts` with mocked Supabase client:

```ts
import { describe, expect, it, vi } from 'vitest';
import { requireAal2FromSupabase } from '../mfa';

describe('requireAal2FromSupabase', () => {
  it('allows current aal2 sessions', async () => {
    const supabase = {
      auth: {
        mfa: {
          getAuthenticatorAssuranceLevel: vi.fn(async () => ({
            data: { currentLevel: 'aal2', nextLevel: 'aal2' },
            error: null,
          })),
        },
      },
    } as never;
    await expect(requireAal2FromSupabase(supabase)).resolves.toEqual({ ok: true });
  });

  it('requires challenge for aal1 sessions with aal2 next level', async () => {
    const supabase = {
      auth: {
        mfa: {
          getAuthenticatorAssuranceLevel: vi.fn(async () => ({
            data: { currentLevel: 'aal1', nextLevel: 'aal2' },
            error: null,
          })),
        },
      },
    } as never;
    await expect(requireAal2FromSupabase(supabase)).resolves.toEqual({ ok: false, reason: 'mfa_required' });
  });
});
```

- [ ] **Step 2: Implement MFA helper**

Create `src/lib/auth/mfa.ts`:

```ts
export type Aal2Result = { ok: true } | { ok: false; reason: 'mfa_required' | 'mfa_check_failed' };

export async function requireAal2FromSupabase(supabase: {
  auth: {
    mfa: {
      getAuthenticatorAssuranceLevel: () => Promise<{
        data: { currentLevel: string | null; nextLevel: string | null } | null;
        error: unknown;
      }>;
    };
  };
}): Promise<Aal2Result> {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) return { ok: false, reason: 'mfa_check_failed' };
  if (data.nextLevel === 'aal2' && data.currentLevel !== 'aal2') {
    return { ok: false, reason: 'mfa_required' };
  }
  return { ok: true };
}
```

- [ ] **Step 3: Add Settings Security UI**

Create a server page that renders a client component. The client uses Supabase browser client MFA methods:

```ts
await supabase.auth.mfa.enroll({ factorType: 'totp' });
await supabase.auth.mfa.challenge({ factorId });
await supabase.auth.mfa.verify({ factorId, challengeId, code });
await supabase.auth.mfa.listFactors();
await supabase.auth.mfa.unenroll({ factorId });
```

Do not implement custom recovery codes. Copy should say: "Add a second factor as a backup."

- [ ] **Step 4: Add Security tab**

Modify `src/components/dashboard/SettingsTabs.tsx` tab arrays to include:

```ts
{ id: 'security', label: 'Security', href: '/settings/security', icon: 'shield' }
```

Add/adjust tests in `src/components/dashboard/__tests__/SettingsTabs.test.tsx`.

- [ ] **Step 5: Add AAL2 route gate**

For billing-sensitive routes and future admin support routes, use the helper after auth:

```ts
const aal = await requireAal2FromSupabase(supabase);
if (!aal.ok) {
  return NextResponse.json({ error: aal.reason }, { status: 403, headers: NO_STORE });
}
```

Apply first to routes needed by Wave 2 grant extension and impersonation. Do not block all dashboard reads.

- [ ] **Step 6: Extend rate limits**

Use existing `checkRateLimit`:

```ts
const limit = await checkRateLimit(`mfa_challenge:${userId}`, 5, 15 * 60, { strict: true });
if (!limit.allowed) {
  return NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '900' } });
}
```

Add similar callers for password reset and login failure paths without account enumeration.

- [ ] **Step 7: Run tests and commit**

Run:

```bash
pnpm exec vitest run src/lib/auth/__tests__/mfa.test.ts src/components/dashboard/__tests__/SettingsTabs.test.tsx src/lib/shared/__tests__/rate-limit.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/lib/auth src/app/\\(authenticated\\)/settings/security src/app/mfa src/components/dashboard src/app/api/auth
git commit -m "feat: add MFA security settings"
```

---

## Task 8: AAL2-Gated Past-Due Grant Extension

**Files:**
- Create: `src/app/api/admin/billing/grant-extension/route.ts`
- Create: `src/app/api/admin/billing/grant-extension/__tests__/route.test.ts`
- Modify: admin account/business detail UI to expose the action
- Create: `docs/support/macros/past-due-extension.md`
- Create: `docs/runbooks/support-extension.md`

- [ ] **Step 1: Write route tests**

Test requirements:

```ts
it('requires admin role, AAL2, ticket id, and reason');
it('updates accounts.flags.past_due_extension and writes account_audit_log in one transaction');
it('rejects extension over 7 days by default');
```

Mock `requireRole`, `requireAal2FromSupabase`, and `writeAccountAuditLog`.

- [ ] **Step 2: Implement route**

Route behavior:

```ts
const extension = {
  granted_at: new Date().toISOString(),
  granted_by_user_id: admin.id,
  days,
  reason,
  ticket_id: ticketId,
  expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
};

await sql.begin(async (tx) => {
  await tx`
    UPDATE accounts
    SET flags = jsonb_set(COALESCE(flags, '{}'::jsonb), '{past_due_extension}', ${jsonb(extension)}, true)
    WHERE id = ${accountId}::uuid
      AND subscription_status = 'past_due'
  `;
  await writeAccountAuditLog({
    accountId,
    actorUserId: admin.id,
    eventType: 'past_due_extension_granted',
    entityType: 'account',
    entityId: accountId,
    payload: { days, reason, ticket_id: ticketId, expires_at: extension.expires_at },
  }, tx);
});
```

Use `assertSameOrigin` before body parsing and state changes.

- [ ] **Step 3: Add docs**

Create `docs/support/macros/past-due-extension.md` and `docs/runbooks/support-extension.md` with the approved support copy and internal checklist.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
pnpm exec vitest run src/app/api/admin/billing/grant-extension/__tests__/route.test.ts src/lib/shared/__tests__/past-due-recovery.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/app/api/admin/billing/grant-extension docs/support/macros/past-due-extension.md docs/runbooks/support-extension.md
git commit -m "feat: add past-due extension action"
```

---

## Task 9: Help Contact Page, KB Docs, And Support Macros

**Files:**
- Create: `src/app/(public)/help/contact/page.tsx`
- Create: `docs/help/response-pending.md`
- Create: `docs/help/brand-voice.md`
- Create: `docs/help/billing-past-due.md`
- Create: `docs/help/csv-import.md`
- Create remaining support macros under `docs/support/macros/`
- Link from connect/past-due/CSV/error states as touched

- [ ] **Step 1: Create help contact page**

Create `src/app/(public)/help/contact/page.tsx`:

```tsx
import Link from 'next/link';

export default function HelpContactPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-3xl font-semibold text-gray-900">Contact support</h1>
      <p className="mt-3 text-gray-600">For account help, email support@repworth.net. Billing questions go to billing@repworth.net. Security reports go to security@repworth.net.</p>
      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900">Response targets</h2>
        <ul className="mt-3 list-disc pl-5 text-gray-700">
          <li>Basic and Founders: 24 business hours.</li>
          <li>Standard: 8 business hours.</li>
          <li>Premium: 2 business hours.</li>
        </ul>
      </section>
      <section className="mt-8">
        <h2 className="text-xl font-semibold text-gray-900">Common help</h2>
        <ul className="mt-3 space-y-2">
          <li><Link className="text-blue-600 hover:underline" href="/help/contact">Connect Google Business Profile</Link></li>
          <li><Link className="text-blue-600 hover:underline" href="/help/contact">Billing and past-due recovery</Link></li>
          <li><Link className="text-blue-600 hover:underline" href="/help/contact">CSV import</Link></li>
        </ul>
      </section>
    </main>
  );
}
```

Because the route group is `(public)`, the URL remains `/help/contact`.

- [ ] **Step 2: Add docs and macros**

Create the Markdown files listed in File Structure. Each macro must include:

```md
# Macro Name

## When to use

## Customer reply

## Internal checks

## Escalation
```

- [ ] **Step 3: Link from stuck states**

Add `/help/contact` links to:

- Zernio connect failure/fallback.
- Past-due banner/modal.
- CSV partial failure UI.
- Dashboard error state.
- Settings Security lost-factor copy.

- [ ] **Step 4: Commit**

```bash
git add src/app/\\(public\\)/help/contact docs/help docs/support/macros src/components src/app
git commit -m "docs: add activation support surfaces"
```

---

## Task 10: Admin-Owned Impersonation Sessions

**Files:**
- Create: `supabase/migrations/047_impersonation_sessions.sql`
- Create: `src/lib/shared/__tests__/migration-047-impersonation-sessions.test.ts`
- Create: `src/lib/admin/impersonation/session.ts`
- Create: `src/lib/admin/impersonation/cookie.ts`
- Create: `src/lib/admin/impersonation/guard.ts`
- Create: `src/app/admin/impersonate/page.tsx`
- Create: `src/app/admin/impersonate/[sessionId]/view/page.tsx`
- Create: admin-prefixed impersonation APIs

- [ ] **Step 1: Add migration test**

Create `src/lib/shared/__tests__/migration-047-impersonation-sessions.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/047_impersonation_sessions.sql'),
  'utf8',
);

describe('migration 047 - impersonation_sessions', () => {
  it('creates impersonation_sessions with UUID fallback and audit fields', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS impersonation_sessions/i);
    expect(sql).toMatch(/id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
    expect(sql).toMatch(/actor_user_id UUID NOT NULL REFERENCES users\(id\)/i);
    expect(sql).toMatch(/impersonated_user_id UUID NOT NULL REFERENCES users\(id\)/i);
    expect(sql).toMatch(/ticket_id TEXT NOT NULL/i);
    expect(sql).toMatch(/reason TEXT NOT NULL/i);
    expect(sql).toMatch(/expires_at TIMESTAMPTZ NOT NULL/i);
  });
});
```

- [ ] **Step 2: Add migration 047**

Create `supabase/migrations/047_impersonation_sessions.sql`:

```sql
-- Migration 047: admin impersonation session state

CREATE TABLE IF NOT EXISTS impersonation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID NOT NULL REFERENCES users(id),
  impersonated_user_id UUID NOT NULL REFERENCES users(id),
  account_id UUID NOT NULL REFERENCES accounts(id),
  ticket_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE impersonation_sessions IS
  'Admin-owned, time-boxed view-as sessions. Application code should pass UUIDv7 ids.';

CREATE INDEX IF NOT EXISTS idx_impersonation_actor_started
  ON impersonation_sessions (actor_user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_impersonation_impersonated_started
  ON impersonation_sessions (impersonated_user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_impersonation_account_started
  ON impersonation_sessions (account_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_impersonation_active_actor
  ON impersonation_sessions (actor_user_id, expires_at)
  WHERE ended_at IS NULL;
```

- [ ] **Step 3: Implement signed cookie helper**

Create `src/lib/admin/impersonation/cookie.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'rw_impersonation';

function secret(): string {
  const value = process.env.IMPERSONATION_COOKIE_SECRET;
  if (!value) throw new Error('IMPERSONATION_COOKIE_SECRET not configured');
  return value;
}

export function signImpersonationSession(sessionId: string): string {
  const sig = createHmac('sha256', secret()).update(sessionId).digest('hex');
  return `${sessionId}.${sig}`;
}

export function verifyImpersonationSession(value: string): string | null {
  const [sessionId, sig] = value.split('.');
  if (!sessionId || !sig) return null;
  const expected = createHmac('sha256', secret()).update(sessionId).digest('hex');
  if (expected.length !== sig.length) return null;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(sig)) ? sessionId : null;
}

export { COOKIE_NAME as IMPERSONATION_COOKIE_NAME };
```

- [ ] **Step 4: Implement session start/end helpers**

Create `src/lib/admin/impersonation/session.ts` with server-only helpers:

```ts
import { v7 as uuidv7 } from 'uuid';
import { sql } from '@/lib/db/server';
import { writeAccountAuditLog } from '@/lib/audit/log';

export async function startImpersonationSession(input: {
  actorUserId: string;
  impersonatedUserId: string;
  accountId: string;
  ticketId: string;
  reason: string;
}): Promise<{ sessionId: string; expiresAt: Date }> {
  const sessionId = uuidv7();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO impersonation_sessions (
        id, actor_user_id, impersonated_user_id, account_id, ticket_id, reason, expires_at
      ) VALUES (
        ${sessionId}::uuid,
        ${input.actorUserId}::uuid,
        ${input.impersonatedUserId}::uuid,
        ${input.accountId}::uuid,
        ${input.ticketId},
        ${input.reason},
        ${expiresAt}
      )
    `;
    await writeAccountAuditLog({
      accountId: input.accountId,
      actorUserId: input.actorUserId,
      eventType: 'impersonation_started',
      entityType: 'user',
      entityId: input.impersonatedUserId,
      payload: { ticket_id: input.ticketId, reason: input.reason, expires_at: expiresAt.toISOString() },
    }, tx);
  });
  return { sessionId, expiresAt };
}
```

Add `endImpersonationSession` and `loadActiveImpersonationSession` in the same file.

- [ ] **Step 5: Implement destructive-action guard**

Create `src/lib/admin/impersonation/guard.ts`:

```ts
const ALLOWED_ACTIONS = new Set([
  'view_dashboard',
  'view_settings',
  'view_billing_state',
]);

export function assertImpersonatedActionAllowed(action: string): { ok: true } | { ok: false; error: 'impersonated_action_blocked' } {
  return ALLOWED_ACTIONS.has(action)
    ? { ok: true }
    : { ok: false, error: 'impersonated_action_blocked' };
}
```

- [ ] **Step 6: Add admin UI and route APIs**

Implement:

- `src/app/admin/impersonate/page.tsx`: form for account/user, ticket ID, reason.
- `src/app/api/admin/impersonation/start/route.ts`: admin + AAL2 + same-origin; starts session and sets signed cookie.
- `src/app/api/admin/impersonation/end/route.ts`: marks ended and clears cookie.
- `src/app/admin/impersonate/[sessionId]/view/page.tsx`: admin-owned view shell with visible banner.

Do not reuse owner `/dashboard` or `/settings` routes by swapping Supabase Auth. Data loaders in the view route must be server-only and scoped by `account_id`.

- [ ] **Step 7: Run tests and commit**

Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/migration-047-impersonation-sessions.test.ts src/lib/admin/impersonation
```

Expected: PASS.

Commit:

```bash
git add supabase/migrations/047_impersonation_sessions.sql src/lib/shared/__tests__/migration-047-impersonation-sessions.test.ts src/lib/admin/impersonation src/app/admin/impersonate src/app/api/admin/impersonation
git commit -m "feat: add audited admin impersonation"
```

---

## Task 11: Final Verification And Readiness Spec Updates

**Files:**
- Modify: `docs/sass_ready/06-onboarding-activation.md`
- Modify: `docs/sass_ready/05-billing-subscription.md`
- Modify: `docs/sass_ready/29-repworth-specific-gaps.md`
- Modify: `docs/sass_ready/04-auth-identity.md`
- Modify: `docs/sass_ready/13-customer-support.md`
- Modify: `docs/directory.md` if new files need mapping

- [ ] **Step 1: Run narrow suites**

Run the suites touched by prior tasks:

```bash
pnpm exec vitest run src/lib/analytics src/app/api/analytics worker/background/pollers src/lib/shared src/lib/auth src/app/api/admin
```

Expected: PASS. If DB-gated tests skip without `TEST_DATABASE_POOL_URL`, record the skip in the PR notes.

- [ ] **Step 2: Run build**

Run:

```bash
pnpm build
```

Expected: PASS.

- [ ] **Step 3: Update readiness docs**

Mark only shipped acceptance criteria complete. Do not mark external Help Scout account setup complete unless actually configured.

Specific updates:

- Spec 06: analytics queue, TTFV, Zernio help/retry, demo event, CSV template/UI.
- Spec 05: day-aware past-due UX and shared worker guard.
- Spec 29: Gap 5 and Gap 6.
- Spec 04: MFA/AAL2 shipped scope.
- Spec 13: help/contact, macros, impersonation shipped scope.

- [ ] **Step 4: Commit**

```bash
git add docs/sass_ready docs/directory.md
git commit -m "docs: mark wave 2 activation progress"
```

- [ ] **Step 5: Final status**

Report:

- Tests run and pass/fail/skip status.
- Migrations added.
- Any external setup still pending, such as Help Scout inbox configuration.
- Whether `pnpm build` passed.
