# Fallow Architecture Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the Fallow-flagged architecture hotspots into clearer, tested modules without changing current runtime workflows.

**Architecture:** This is a phased architecture cleanup. Entry points remain stable and continue to orchestrate; new or sharpened modules own durable failure behavior, parsing, policy, and side effects behind focused seams. Each slice is independently shippable and must preserve route responses, redirects, cookies, Redis keys, database status transitions, and outbox semantics.

**Tech Stack:** Next.js 14 app router, TypeScript, Vitest, Playwright, BullMQ workers, Postgres.js, Supabase, Upstash Redis, Fallow.

---

## Scope Check

The approved spec spans multiple independent subsystems. This master plan is intentionally split into slice-level implementation tracks. Do not implement two runtime slices in the same commit. If a slice grows beyond the steps below, write the relevant child plan before touching code in that slice: `docs/superpowers/plans/2026-05-20-fallow-architecture-cleanup-zernio.md`, `docs/superpowers/plans/2026-05-20-fallow-architecture-cleanup-dashboard.md`, `docs/superpowers/plans/2026-05-20-fallow-architecture-cleanup-onboarding.md`, or `docs/superpowers/plans/2026-05-20-fallow-architecture-cleanup-worker-ingress.md`.

Approved design spec:

- `docs/superpowers/specs/2026-05-20-fallow-architecture-cleanup-design.md`

Architecture invariants to keep open while working:

- `.claude/CLAUDE.md`

Current unrelated/untracked files to leave untouched unless explicitly scoped:

- `.nvmrc`
- `pnpm-workspace.yaml`

## File Structure Map

### Baseline and Verification

- Create: `docs/superpowers/plans/2026-05-20-fallow-architecture-cleanup.md`
- Create: `docs/superpowers/baselines/2026-05-20-fallow-architecture-cleanup.md`
- Do not commit bulky Fallow JSON unless the team explicitly wants it tracked; keep raw JSON in `/private/tmp`.

### Zernio Connect and Publishing

- Create: `src/app/api/zernio/connect/_shared/preflight.ts`
- Create: `src/app/api/zernio/connect/_shared/pending-flow.ts`
- Create: `src/app/api/zernio/connect/_shared/__tests__/preflight.test.ts`
- Create: `src/app/api/zernio/connect/_shared/__tests__/pending-flow.test.ts`
- Create: `src/lib/zernio/client/transport.ts`
- Create: `src/lib/zernio/client/error-classifier.ts`
- Create: `src/lib/zernio/client/profiles.ts`
- Create: `src/lib/zernio/client/locations.ts`
- Create: `src/lib/zernio/client/replies.ts`
- Modify: `src/lib/zernio/client.ts`
- Modify one route at a time: `src/app/api/zernio/connect/start/route.ts`, `src/app/api/zernio/connect/callback/route.ts`, `src/app/api/zernio/connect/select-location/route.ts`, `src/app/api/zernio/connect/cancel/route.ts`
- Create: `worker/jobs/publisher/load-context.ts`
- Create: `worker/jobs/publisher/no-connection.ts`
- Create: `worker/jobs/publisher/review-lookup.ts`
- Create: `worker/jobs/publisher/post-reply.ts`
- Modify: `worker/jobs/publisher/ResponsePublisherWorker.ts`
- Preserve and sharpen: `worker/jobs/publisher/publisher-error-handlers.ts`

### Dashboard Route and Data

- Create: `src/app/api/dashboard/policy.ts`
- Create: `src/app/api/dashboard/__tests__/policy.test.ts`
- Create: `src/lib/dashboard/active-mappers.ts`
- Create: `src/lib/dashboard/zernio-banner.ts`
- Create: `src/lib/dashboard/__tests__/active-mappers.test.ts`
- Create: `src/lib/dashboard/__tests__/zernio-banner.test.ts`
- Modify: `src/app/api/dashboard/route.ts`
- Modify: `src/lib/dashboard/service.ts`
- Modify: `src/lib/dashboard/aggregate-service.ts` only after the active service extraction is passing.

### Onboarding and Demo

- Create: `src/app/onboarding/business/payload.ts`
- Create: `src/app/onboarding/business/__tests__/payload.test.ts`
- Create: `src/lib/onboarding/route-guards.ts`
- Create: `src/lib/onboarding/__tests__/route-guards.test.ts`
- Create: `worker/jobs/onboarding-demo/reservation.ts`
- Create: `worker/jobs/onboarding-demo/place-resolution.ts`
- Create: `worker/jobs/onboarding-demo/demo-source.ts`
- Create: `worker/jobs/onboarding-demo/terminal.ts`
- Modify: `src/app/onboarding/business/BusinessWizardClient.tsx`
- Modify: `src/app/api/onboarding/start/route.ts`
- Modify: `src/app/api/onboarding/business/route.ts`
- Modify: `worker/jobs/OnboardingDemoWorker.ts`

### Worker Notification and Ingress

- Create: `worker/jobs/notification/plan.ts`
- Create: `worker/jobs/notification/outcomes.ts`
- Create: `worker/jobs/notification/__tests__/plan.test.ts`
- Create: `worker/jobs/notification/__tests__/outcomes.test.ts`
- Create: `worker/ingress/twilio/parse-inbound.ts`
- Create: `worker/ingress/twilio/__tests__/parse-inbound.test.ts`
- Create: `worker/ingress/resend/event.ts`
- Create: `worker/ingress/__tests__/resend-event.test.ts`
- Create: `worker/ingress/zernio/event.ts`
- Create: `worker/ingress/zernio/__tests__/event.test.ts`
- Modify: `worker/jobs/notification/dispatch.ts`
- Modify: `worker/ingress/twilio/twilio-whatsapp-inbound.ts`
- Modify: `worker/ingress/resend.ts`
- Modify: `worker/ingress/zernio/zernio.ts`

### Final Hygiene

- Modify: `src/components/dashboard/ValueKpiGrid.tsx`
- Keep out of this plan: shared test harness modules for repeated route mocks.

---

## Task 1: Capture Baseline and Tripwire Commands

**Files:**
- Create: `docs/superpowers/baselines/2026-05-20-fallow-architecture-cleanup.md`

- [ ] **Step 1: Confirm clean execution scope**

Run:

```bash
git status --short --branch
```

Expected:

```text
## main...origin/main
?? .nvmrc
?? pnpm-workspace.yaml
```

If main is ahead because the spec/plan commits are local, note that and continue. Do not stage `.nvmrc` or `pnpm-workspace.yaml`.

- [ ] **Step 2: Capture raw Fallow baselines in `/private/tmp`**

Run:

```bash
fallow health --format json --explain > /private/tmp/repworth-fallow-health-before.json
fallow health --production --format json --explain > /private/tmp/repworth-fallow-health-production-before.json
fallow health --targets --format json --explain > /private/tmp/repworth-fallow-targets-before.json
fallow dupes --production --format json > /private/tmp/repworth-fallow-dupes-production-before.json
```

Expected:

```text
The health commands may exit 1 because findings exist. JSON files are still written.
```

- [ ] **Step 3: Write a small tracked baseline summary**

Create `docs/superpowers/baselines/2026-05-20-fallow-architecture-cleanup.md` with this content, replacing only the metric values if the command output differs:

```markdown
# Fallow Architecture Cleanup Baseline

Captured before implementation of `docs/superpowers/specs/2026-05-20-fallow-architecture-cleanup-design.md`.

Raw JSON was written to `/private/tmp` and is intentionally not committed.

## Baseline Metrics

- Normal health: 67.9 C
- Production health: 70.8 B
- Normal maintainability: 91.8
- Production maintainability: 91.5
- Normal duplication: 16.2%
- Production duplication: 11.0%
- Normal high-priority targets: 26
- Production high-priority targets: 38

## Primary Runtime Targets

- `src/lib/dashboard/service.ts`: `getActiveDashboardData`
- `src/app/api/zernio/connect/select-location/route.ts`: `POST`
- `src/app/api/zernio/connect/callback/route.ts`: `GET`
- `worker/jobs/publisher/ResponsePublisherWorker.ts`: `handlePublishResponse`
```

- [ ] **Step 4: Commit the baseline**

Run:

```bash
git add -f docs/superpowers/baselines/2026-05-20-fallow-architecture-cleanup.md
git commit -m "docs: capture fallow architecture baseline"
```

Expected:

```text
One documentation commit. No runtime files changed.
```

---

## Task 2: Zernio Route Preflight Module

**Files:**
- Create: `src/app/api/zernio/connect/_shared/preflight.ts`
- Create: `src/app/api/zernio/connect/_shared/__tests__/preflight.test.ts`
- Modify in this task: `src/app/api/zernio/connect/start/route.ts`
- Leave for the subsequent Zernio child plan: `src/app/api/zernio/connect/cancel/route.ts`
- Leave for the subsequent Zernio child plan: `src/app/api/zernio/connect/select-location/route.ts`

- [ ] **Step 1: Write failing tests for requested location parsing and invalid UUID rejection**

Create `src/app/api/zernio/connect/_shared/__tests__/preflight.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseRequestedLocationId } from '../preflight';

describe('parseRequestedLocationId', () => {
  it('returns null when body has no locationId', () => {
    expect(parseRequestedLocationId({})).toBeNull();
  });

  it('trims a valid locationId', () => {
    expect(
      parseRequestedLocationId({
        locationId: '  018f6a77-2c2a-7000-8000-000000000001  ',
      }),
    ).toBe('018f6a77-2c2a-7000-8000-000000000001');
  });

  it('throws invalid_body for malformed locationId', () => {
    expect(() => parseRequestedLocationId({ locationId: 'not-a-uuid' })).toThrow(
      'invalid_body',
    );
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm exec vitest run src/app/api/zernio/connect/_shared/__tests__/preflight.test.ts
```

Expected:

```text
FAIL because ../preflight does not exist.
```

- [ ] **Step 3: Implement the minimal route preflight helper**

Create `src/app/api/zernio/connect/_shared/preflight.ts`:

```ts
import { NextResponse } from 'next/server';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export class ZernioPreflightError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

export function preflightErrorResponse(error: unknown): NextResponse {
  if (error instanceof ZernioPreflightError) {
    return NextResponse.json(
      { error: error.code },
      { status: error.status, headers: NO_STORE },
    );
  }
  throw error;
}

export function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export function parseRequestedLocationId(body: { locationId?: unknown }): string | null {
  const requestedLocationId =
    typeof body.locationId === 'string' && body.locationId.trim().length > 0
      ? body.locationId.trim()
      : null;

  if (requestedLocationId && !isValidUuid(requestedLocationId)) {
    throw new ZernioPreflightError(400, 'invalid_body');
  }

  return requestedLocationId;
}

export function assertActiveSubscription(status: string): void {
  if (status !== SubscriptionStatus.ACTIVE) {
    throw new ZernioPreflightError(403, 'subscription_required');
  }
}
```

- [ ] **Step 4: Run the new helper test**

Run:

```bash
pnpm exec vitest run src/app/api/zernio/connect/_shared/__tests__/preflight.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 5: Replace duplicate parsing in `start/route.ts` only**

Modify `src/app/api/zernio/connect/start/route.ts` so the body parsing block uses `parseRequestedLocationId(body)` and catches `ZernioPreflightError` through `preflightErrorResponse`.

Keep the route response for malformed `locationId` exactly:

```ts
return NextResponse.json({ error: 'invalid_body' }, { status: 400, headers: NO_STORE });
```

The imported helper may produce the same response; do not change the payload or status.

- [ ] **Step 6: Run the start route tests**

Run:

```bash
pnpm exec vitest run src/app/api/zernio/connect/start/__tests__/route.test.ts src/app/api/zernio/connect/_shared/__tests__/preflight.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 7: Commit the first Zernio preflight extraction**

Run:

```bash
git add src/app/api/zernio/connect/_shared/preflight.ts src/app/api/zernio/connect/_shared/__tests__/preflight.test.ts src/app/api/zernio/connect/start/route.ts
git commit -m "refactor: extract zernio connect preflight parsing"
```

Expected:

```text
One focused commit. Only start-route parsing changed.
```

---

## Task 3: Zernio Pending Flow Module

**Files:**
- Create: `src/app/api/zernio/connect/_shared/pending-flow.ts`
- Create: `src/app/api/zernio/connect/_shared/__tests__/pending-flow.test.ts`
- Modify in this task: `src/app/api/zernio/connect/start/route.ts`
- Leave for subsequent Zernio child plans: `callback/route.ts`, `cancel/route.ts`, `select-location/route.ts`

- [ ] **Step 1: Write failing tests for marker parsing**

Create `src/app/api/zernio/connect/_shared/__tests__/pending-flow.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseConnectPendingMarker } from '../pending-flow';

describe('parseConnectPendingMarker', () => {
  it('parses a valid pending marker', () => {
    expect(
      parseConnectPendingMarker(
        JSON.stringify({
          flowId: 'flow_123',
          userId: 'user_123',
          started_at: 1_700_000_000_000,
          status: 'oauth_in_progress',
          profileId: 'profile_123',
          state: 'state_123',
        }),
      ),
    ).toMatchObject({
      flowId: 'flow_123',
      status: 'oauth_in_progress',
      profileId: 'profile_123',
      state: 'state_123',
    });
  });

  it('returns null for malformed JSON', () => {
    expect(parseConnectPendingMarker('{bad json')).toBeNull();
  });

  it('returns null when required shape is missing', () => {
    expect(parseConnectPendingMarker(JSON.stringify({ status: 'starting' }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
pnpm exec vitest run src/app/api/zernio/connect/_shared/__tests__/pending-flow.test.ts
```

Expected:

```text
FAIL because ../pending-flow does not exist.
```

- [ ] **Step 3: Implement marker parsing without changing Redis keys**

Create `src/app/api/zernio/connect/_shared/pending-flow.ts`:

```ts
export type ConnectPendingStatus =
  | 'starting'
  | 'oauth_in_progress'
  | 'finalize_unknown';

export interface ConnectPendingMarkerShape {
  flowId: string;
  userId: string;
  started_at: number;
  status: ConnectPendingStatus;
  profileId?: string;
  state?: string;
}

export function parseConnectPendingMarker(raw: string): ConnectPendingMarkerShape | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ConnectPendingMarkerShape>;
    if (
      !parsed ||
      typeof parsed.flowId !== 'string' ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.started_at !== 'number' ||
      typeof parsed.status !== 'string'
    ) {
      return null;
    }

    if (
      parsed.status !== 'starting' &&
      parsed.status !== 'oauth_in_progress' &&
      parsed.status !== 'finalize_unknown'
    ) {
      return null;
    }

    return {
      flowId: parsed.flowId,
      userId: parsed.userId,
      started_at: parsed.started_at,
      status: parsed.status,
      profileId: typeof parsed.profileId === 'string' ? parsed.profileId : undefined,
      state: typeof parsed.state === 'string' ? parsed.state : undefined,
    };
  } catch {
    return null;
  }
}

export function isFreshPendingMarker(marker: { started_at: number }, ttlSeconds: number): boolean {
  return Date.now() - marker.started_at <= ttlSeconds * 1000;
}
```

- [ ] **Step 4: Run the pending-flow tests**

Run:

```bash
pnpm exec vitest run src/app/api/zernio/connect/_shared/__tests__/pending-flow.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 5: Refactor only one pending marker parse site**

Start with `src/app/api/zernio/connect/start/route.ts`. Replace the local `JSON.parse(existingPending)` block with `parseConnectPendingMarker(existingPending)`.

Preserve these behaviors exactly:

```ts
{ error: 'malformed_pending_marker' } with status 409
{ error: 'finalize_unknown_admin_required' } with status 409
{ error: 'connect_pending', status: parsed.status } with status 409
```

- [ ] **Step 6: Run the Zernio start route tests**

Run:

```bash
pnpm exec vitest run src/app/api/zernio/connect/start/__tests__/route.test.ts src/app/api/zernio/connect/_shared/__tests__/pending-flow.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 7: Commit the pending-flow extraction**

Run:

```bash
git add src/app/api/zernio/connect/_shared/pending-flow.ts src/app/api/zernio/connect/_shared/__tests__/pending-flow.test.ts src/app/api/zernio/connect/start/route.ts
git commit -m "refactor: extract zernio pending marker parsing"
```

Expected:

```text
One focused commit. Route behavior unchanged.
```

---

## Task 4: Zernio Client Internal Split

**Files:**
- Create: `src/lib/zernio/client/transport.ts`
- Create: `src/lib/zernio/client/error-classifier.ts`
- Create: `src/lib/zernio/client/profiles.ts`
- Create: `src/lib/zernio/client/locations.ts`
- Create: `src/lib/zernio/client/replies.ts`
- Modify: `src/lib/zernio/client.ts`
- Test: `src/lib/zernio/__tests__/client.test.ts`

- [ ] **Step 1: Run existing client tests before moving code**

Run:

```bash
pnpm exec vitest run src/lib/zernio/__tests__/client.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 2: Move transport without changing public imports**

Create `src/lib/zernio/client/transport.ts` with the low-level request function currently embedded in `src/lib/zernio/client.ts`. Keep this exported shape and copy the current request implementation exactly, including headers, auth handling, timeout behavior, and error classes:

```ts
export interface ZernioTransportOptions {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}

export interface ZernioTransport {
  request<T>(path: string, init?: RequestInit): Promise<T>;
}

export function createZernioTransport(options: ZernioTransportOptions): ZernioTransport {
  return {
    request<T>(path, init) {
      return request<T>(options, path, init);
    },
  };
}
```

- [ ] **Step 3: Move error classification into `error-classifier.ts`**

Create `src/lib/zernio/client/error-classifier.ts` and move the existing `classifyAndParse` logic into it.

Required outward shape:

```ts
export async function classifyAndParse(response: Response): Promise<unknown>;
```

Keep all existing error classes in their current public module.

- [ ] **Step 4: Move resource methods behind concrete modules**

Create modules with these functions, moving existing method bodies from `client.ts`:

```ts
// src/lib/zernio/client/profiles.ts
import type { ZernioTransport } from './transport';

export function createProfileClient(transport: ZernioTransport) {
  return {
    createProfile(input: { name: string }) {
      return transport.request<{ profileId: string }>('/profiles', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    },
    deleteProfile(profileId: string) {
      return transport.request<void>(`/profiles/${profileId}`, { method: 'DELETE' });
    },
  };
}
```

The exact paths and payloads must match the existing implementation from `src/lib/zernio/client.ts`.

- [ ] **Step 5: Keep `src/lib/zernio/client.ts` as the stable facade**

Modify `src/lib/zernio/client.ts` so existing imports still work:

```ts
export const zernioClient = {
  createProfile,
  deleteProfile,
  startConnect,
  listLocations,
  selectLocation,
  postReply,
};
```

Use the moved modules internally. Do not change public method names or return shapes.

- [ ] **Step 6: Run client and Zernio route tests**

Run:

```bash
pnpm exec vitest run src/lib/zernio/__tests__/client.test.ts src/app/api/zernio/connect/start/__tests__/route.test.ts src/app/api/zernio/connect/callback/__tests__/route.test.ts src/app/api/zernio/connect/select-location/__tests__/route.test.ts src/app/api/zernio/connect/cancel/__tests__/route.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 7: Commit the client split**

Run:

```bash
git add src/lib/zernio/client.ts src/lib/zernio/client
git commit -m "refactor: split zernio client internals"
```

Expected:

```text
One commit. Existing `@/lib/zernio/client` imports still compile.
```

---

## Task 5: Response Publisher Stages

**Files:**
- Create: `worker/jobs/publisher/load-context.ts`
- Create: `worker/jobs/publisher/no-connection.ts`
- Create: `worker/jobs/publisher/review-lookup.ts`
- Create: `worker/jobs/publisher/post-reply.ts`
- Modify: `worker/jobs/publisher/ResponsePublisherWorker.ts`
- Preserve: `worker/jobs/publisher/publisher-error-handlers.ts`
- Test: `worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts`

- [ ] **Step 1: Run publisher tests before refactor**

Run:

```bash
pnpm exec vitest run worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts worker/jobs/publisher/__tests__/publisher-error-handlers.test.ts worker/jobs/publisher/__tests__/failed-hook.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 2: Extract load context without changing SQL**

Create `worker/jobs/publisher/load-context.ts`:

```ts
export interface PublishResponseContext {
  response: {
    id: string;
    review_id: string;
    business_id: string;
    approved_text: string | null;
    status: string;
  };
  business: {
    id: string;
    name: string;
    subscription_status: string;
    account_updated_at: Date;
    archived_at: Date | null;
  };
}

export async function loadPublishResponseContext(input: {
  responseId: string;
  businessId: string;
  outboxId: string;
  outboxAttempt: number;
  logger: { error(message: string): void };
}): Promise<PublishResponseContext | 'completed'>;
```

The implementation is the existing response/business SQL and early terminal behavior from `ResponsePublisherWorker.ts`. Keep `markOutboxFailed` and `markOutboxCompleted` calls exactly where the current behavior requires them.

- [ ] **Step 3: Extract no-connection branch**

Create `worker/jobs/publisher/no-connection.ts`:

```ts
export async function parkResponseForOwnerReconnect(input: {
  responseId: string;
  businessId: string;
  outboxId: string;
  outboxAttempt: number;
  logger: { log(message: string): void };
}): Promise<void>;
```

Move the transaction that updates `responses` and inserts `notify_owner_reconnect`. Preserve the transactional outbox invariant.

- [ ] **Step 4: Extract review lookup wrapper**

Create `worker/jobs/publisher/review-lookup.ts`:

```ts
import type { ZernioConnectionRow } from './types';

export async function resolvePublishableZernioReviewId(input: {
  responseId: string;
  businessId: string;
  reviewId: string;
  zernioConnection: ZernioConnectionRow;
  outboxId: string;
  outboxAttempt: number;
  logger: { log(message: string): void; warn(message: string): void; error(message: string): void };
}): Promise<string | 'completed'>;
```

If `ZernioConnectionRow` is local to `ResponsePublisherWorker.ts`, extract it to `worker/jobs/publisher/types.ts` first.

- [ ] **Step 5: Extract post-reply and terminal outcome branch**

Create `worker/jobs/publisher/post-reply.ts`:

```ts
export async function postReplyAndHandleTerminalOutcomes(input: {
  responseId: string;
  businessId: string;
  reviewId: string;
  zernioReviewId: string;
  approvedText: string;
  outboxId: string;
  outboxAttempt: number;
  correlationId?: string;
  logger: {
    log(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  };
}): Promise<'posted' | 'completed'>;
```

Use existing `publisher-error-handlers.ts` functions. Do not duplicate them.

- [ ] **Step 6: Reduce `handlePublishResponse` to orchestration**

Modify `worker/jobs/publisher/ResponsePublisherWorker.ts` so `handlePublishResponse` follows this shape:

```ts
export async function handlePublishResponse(job: Job<PublishResponsePayload>): Promise<void> {
  const logger = createWorkerLogger('[ResponsePublisherWorker]', job.data.correlation_id);
  const { response_id } = job.data;
  const businessId = asLocationId(job.data.business_id);
  const { outboxId, attempt: outboxAttempt } = extractOutboxHandle(job.data, job.id!);

  const context = await loadPublishResponseContext({
    responseId: response_id,
    businessId,
    outboxId,
    outboxAttempt,
    logger,
  });
  if (context === 'completed') return;

  // Existing subscription guard, zernio connection load, no-connection branch,
  // lookup, post, success update, and outbox completion remain in the same order.
}
```

Do not change publishable statuses, subscription behavior, terminal error classification, or success update predicates.

- [ ] **Step 7: Run publisher tests**

Run:

```bash
pnpm exec vitest run worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts worker/jobs/publisher/__tests__/publisher-error-handlers.test.ts worker/jobs/publisher/__tests__/failed-hook.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 8: Commit publisher extraction**

Run:

```bash
git add worker/jobs/publisher
git commit -m "refactor: split response publisher stages"
```

Expected:

```text
One commit. `handlePublishResponse` is shorter and existing publisher tests pass.
```

---

## Task 6: Dashboard Policy and Active Data Mappers

**Files:**
- Create: `src/app/api/dashboard/policy.ts`
- Create: `src/app/api/dashboard/__tests__/policy.test.ts`
- Create: `src/lib/dashboard/active-mappers.ts`
- Create: `src/lib/dashboard/zernio-banner.ts`
- Create: `src/lib/dashboard/__tests__/active-mappers.test.ts`
- Create: `src/lib/dashboard/__tests__/zernio-banner.test.ts`
- Modify: `src/app/api/dashboard/route.ts`
- Modify: `src/lib/dashboard/service.ts`

- [ ] **Step 1: Write table tests for Zernio banner precedence**

Create `src/lib/dashboard/__tests__/zernio-banner.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveZernioConnectionState } from '../zernio-banner';

describe('resolveZernioConnectionState', () => {
  it('prefers unresolved incidents over active connection', () => {
    expect(
      resolveZernioConnectionState({
        hasUnresolvedIncident: true,
        connectionStatus: 'active',
        pendingFlow: undefined,
        queuedReconnectCount: 2,
        lastDisconnectReason: null,
      }).status,
    ).toBe('finalize_unknown');
  });

  it('prefers active DB connection over stale non-finalize pending flow', () => {
    expect(
      resolveZernioConnectionState({
        hasUnresolvedIncident: false,
        connectionStatus: 'active',
        pendingFlow: { status: 'oauth_in_progress', started_at: 1 },
        queuedReconnectCount: 0,
        lastDisconnectReason: null,
      }).pendingFlow,
    ).toBeUndefined();
  });

  it('surfaces pending flow when no active connection exists', () => {
    expect(
      resolveZernioConnectionState({
        hasUnresolvedIncident: false,
        connectionStatus: undefined,
        pendingFlow: { status: 'oauth_in_progress', started_at: 1 },
        queuedReconnectCount: 0,
        lastDisconnectReason: null,
      }).status,
    ).toBe('pending');
  });
});
```

- [ ] **Step 2: Run the failing banner test**

Run:

```bash
pnpm exec vitest run src/lib/dashboard/__tests__/zernio-banner.test.ts
```

Expected:

```text
FAIL because ../zernio-banner does not exist.
```

- [ ] **Step 3: Implement `zernio-banner.ts` by moving current precedence logic**

Create `src/lib/dashboard/zernio-banner.ts`:

```ts
import type { DashboardDataActive } from './types';

export interface ResolveZernioConnectionInput {
  hasUnresolvedIncident: boolean;
  connectionStatus?: 'pending' | 'active' | 'disconnected';
  pendingFlow?: { status: 'starting' | 'oauth_in_progress' | 'finalize_unknown'; started_at: number };
  queuedReconnectCount: number;
  lastDisconnectReason?: string | null;
}

export function resolveZernioConnectionState(
  input: ResolveZernioConnectionInput,
): DashboardDataActive['zernioConnection'] {
  let status: DashboardDataActive['zernioConnection']['status'];
  let surfacedPendingFlow: ResolveZernioConnectionInput['pendingFlow'];

  if (input.hasUnresolvedIncident || input.pendingFlow?.status === 'finalize_unknown') {
    status = 'finalize_unknown';
    surfacedPendingFlow =
      input.pendingFlow?.status === 'finalize_unknown' ? input.pendingFlow : undefined;
  } else if (input.connectionStatus === 'active') {
    status = 'active';
    surfacedPendingFlow = undefined;
  } else if (input.pendingFlow) {
    status = 'pending';
    surfacedPendingFlow = input.pendingFlow;
  } else if (input.connectionStatus) {
    status = input.connectionStatus;
    surfacedPendingFlow = undefined;
  } else {
    status = 'none';
    surfacedPendingFlow = undefined;
  }

  return {
    status,
    pendingFlow: surfacedPendingFlow,
    queuedReconnectCount: input.queuedReconnectCount,
    hasUnresolvedIncident: input.hasUnresolvedIncident,
    lastDisconnectReason: input.lastDisconnectReason ?? undefined,
  };
}
```

- [ ] **Step 4: Replace inline banner logic in `service.ts`**

Modify `src/lib/dashboard/service.ts` to call `resolveZernioConnectionState`. Keep pending marker parsing behavior and console messages unchanged.

- [ ] **Step 5: Run dashboard service and route tests**

Run:

```bash
pnpm exec vitest run src/lib/dashboard/__tests__/zernio-banner.test.ts src/app/api/dashboard/__tests__/route.test.ts src/app/api/dashboard/__tests__/scope-route.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 6: Extract active dashboard mappers**

Create `src/lib/dashboard/active-mappers.ts` with pure mapper functions:

```ts
import type { DashboardDataActive } from './types';

export function mapReviewVelocity(rows: Array<{ week_start: unknown; count: unknown }>): DashboardDataActive['reviewVelocity'] {
  return rows.map((row) => ({
    weekStart: String(row.week_start),
    count: row.count as number,
  }));
}

export function mapRecentReviews(rows: Array<Record<string, unknown>>): DashboardDataActive['recentReviews'] {
  return rows.map((row) => ({
    id: row.id as string,
    reviewerName: (row.reviewer_name as string) ?? 'Anonymous',
    starRating: (row.star_rating as number) ?? null,
    reviewText: (row.review_text as string) ?? null,
    reviewDate: row.review_date ? (row.review_date as Date).toISOString() : '',
    status: row.status as string,
    responseText: (row.response_text as string) ?? null,
    responseStatus: (row.response_status as string) ?? null,
  }));
}
```

Add mapper tests for null reviewer name, null response text, and date conversion before wiring into `service.ts`.

- [ ] **Step 7: Run dashboard tests again**

Run:

```bash
pnpm exec vitest run src/lib/dashboard/__tests__/active-mappers.test.ts src/lib/dashboard/__tests__/zernio-banner.test.ts src/app/api/dashboard/__tests__/route.test.ts src/app/api/dashboard/__tests__/scope-route.test.ts src/hooks/__tests__/useDashboardData.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 8: Commit dashboard extraction**

Run:

```bash
git add src/lib/dashboard src/app/api/dashboard
git commit -m "refactor: split dashboard state mapping"
```

Expected:

```text
One commit. `getActiveDashboardData` delegates banner and mapping logic.
```

---

## Task 7: Onboarding Payload and Demo Worker Stages

**Files:**
- Create: `src/app/onboarding/business/payload.ts`
- Create: `src/app/onboarding/business/__tests__/payload.test.ts`
- Create: `worker/jobs/onboarding-demo/reservation.ts`
- Create: `worker/jobs/onboarding-demo/place-resolution.ts`
- Create: `worker/jobs/onboarding-demo/demo-source.ts`
- Create: `worker/jobs/onboarding-demo/terminal.ts`
- Modify: `src/app/onboarding/business/BusinessWizardClient.tsx`
- Modify: `worker/jobs/OnboardingDemoWorker.ts`

- [ ] **Step 1: Write payload tests for demo vs legacy flow**

Create `src/app/onboarding/business/__tests__/payload.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildBusinessWizardPayload } from '../payload';

const baseData = {
  inputMode: 'autocomplete' as const,
  googlePlaceId: 'place_123',
  googlePlaceAddress: '1 Main St',
  googleMapsUrl: '',
  businessName: 'RepWorth Cafe',
  category: 'Cafe',
  website: 'https://example.com',
  tone: 'warm',
  productsServices: 'Coffee',
  staffNames: 'Nora',
  highlightFacts: 'Fast service',
  avoidFacts: 'No discounts',
  sampleResponses: 'Thanks!',
};

describe('buildBusinessWizardPayload', () => {
  it('excludes location fields in demo flow', () => {
    expect(buildBusinessWizardPayload(baseData, { demoFlowEnabled: true })).not.toHaveProperty(
      'googlePlaceId',
    );
  });

  it('includes autocomplete location fields in legacy flow', () => {
    expect(buildBusinessWizardPayload(baseData, { demoFlowEnabled: false })).toMatchObject({
      businessName: 'RepWorth Cafe',
      googlePlaceId: 'place_123',
      googlePlaceAddress: '1 Main St',
    });
  });

  it('omits voice fields when skipVoice is true', () => {
    expect(
      buildBusinessWizardPayload(baseData, {
        demoFlowEnabled: false,
        skipVoice: true,
      }),
    ).not.toHaveProperty('productsServices');
  });
});
```

- [ ] **Step 2: Run the failing payload test**

Run:

```bash
pnpm exec vitest run src/app/onboarding/business/__tests__/payload.test.ts
```

Expected:

```text
FAIL because ../payload does not exist.
```

- [ ] **Step 3: Implement payload builder**

Create `src/app/onboarding/business/payload.ts` and move the existing payload construction from `BusinessWizardClient.tsx` into:

```ts
export interface BusinessWizardPayloadData {
  inputMode: 'autocomplete' | 'url';
  googlePlaceId: string;
  googlePlaceAddress: string;
  googleMapsUrl: string;
  businessName: string;
  category: string;
  website: string;
  tone: string;
  productsServices: string;
  staffNames: string;
  highlightFacts: string;
  avoidFacts: string;
  sampleResponses: string;
}

export function buildBusinessWizardPayload(
  data: BusinessWizardPayloadData,
  opts: { demoFlowEnabled: boolean; skipVoice?: boolean },
): Record<string, unknown> {
  const voiceFields = opts.skipVoice
    ? {}
    : {
        productsServices: data.productsServices || undefined,
        staffNames: data.staffNames || undefined,
        highlightFacts: data.highlightFacts || undefined,
        avoidFacts: data.avoidFacts || undefined,
        sampleResponses: data.sampleResponses || undefined,
      };

  if (opts.demoFlowEnabled) {
    return {
      businessName: data.businessName || undefined,
      category: data.category || undefined,
      tone: data.tone || undefined,
      website: data.website || undefined,
      ...voiceFields,
    };
  }

  return {
    businessName: data.businessName,
    category: data.category || undefined,
    googlePlaceId: data.inputMode === 'autocomplete' ? data.googlePlaceId || undefined : undefined,
    googlePlaceAddress:
      data.inputMode === 'autocomplete' ? data.googlePlaceAddress || undefined : undefined,
    googleMapsUrl: data.inputMode === 'url' ? data.googleMapsUrl || undefined : undefined,
    tone: data.tone || undefined,
    website: data.website || undefined,
    ...voiceFields,
  };
}
```

- [ ] **Step 4: Wire `BusinessWizardClient` to the payload builder**

Modify `src/app/onboarding/business/BusinessWizardClient.tsx` so `saveProfileAndVoice` calls:

```ts
const payload = buildBusinessWizardPayload(data, {
  demoFlowEnabled,
  skipVoice: opts.skipVoice,
});
```

Do not change navigation or fetch behavior.

- [ ] **Step 5: Run onboarding payload and wizard tests**

Run:

```bash
pnpm exec vitest run src/app/onboarding/business/__tests__/payload.test.ts src/app/onboarding/business/__tests__/guard.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 6: Extract demo worker reservation helper**

Create `worker/jobs/onboarding-demo/reservation.ts`:

```ts
export async function releaseOnboardingDemoReservation(input: {
  reservationDate: string | undefined;
  logger: { error(message: string): void };
  finalizeCost: (date: string, actualCents: number) => Promise<void>;
}): Promise<void> {
  if (!input.reservationDate) return;
  try {
    await input.finalizeCost(input.reservationDate, 0);
  } catch (err) {
    input.logger.error(
      `Failed to release cost reservation: ${err instanceof Error ? err.message : err}`,
    );
  }
}
```

Replace the inline `releaseReservation` closure in `worker/jobs/OnboardingDemoWorker.ts` with this helper.

- [ ] **Step 7: Run onboarding demo worker tests**

Run:

```bash
pnpm exec vitest run worker/jobs/__tests__/OnboardingDemoWorker.test.ts src/lib/demos/__tests__/lifecycle.test.ts src/lib/demos/__tests__/fallback-content.test.ts src/lib/demos/__tests__/generate-responses.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 8: Commit onboarding extraction**

Run:

```bash
git add src/app/onboarding/business worker/jobs/onboarding-demo worker/jobs/OnboardingDemoWorker.ts
git commit -m "refactor: split onboarding payload and demo reservation"
```

Expected:

```text
One commit. Client payload construction and demo reservation release are separately testable.
```

---

## Task 8: Notification Dispatch and Ingress Parsing

**Files:**
- Create: `worker/jobs/notification/plan.ts`
- Create: `worker/jobs/notification/outcomes.ts`
- Create: `worker/jobs/notification/__tests__/plan.test.ts`
- Create: `worker/ingress/twilio/parse-inbound.ts`
- Create: `worker/ingress/twilio/__tests__/parse-inbound.test.ts`
- Modify: `worker/jobs/notification/dispatch.ts`
- Modify: `worker/ingress/twilio/twilio-whatsapp-inbound.ts`

- [ ] **Step 1: Write notification plan tests**

Create `worker/jobs/notification/__tests__/plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildNotificationDispatchPlan } from '../plan';

describe('buildNotificationDispatchPlan', () => {
  it('returns enabled channels in deterministic order', () => {
    expect(
      buildNotificationDispatchPlan({
        email: { enabled: true },
        sms: { enabled: true },
        telegram: { enabled: false },
        whatsapp: { enabled: true },
      }),
    ).toEqual(['email', 'sms', 'whatsapp']);
  });

  it('returns an empty plan when every channel is disabled', () => {
    expect(
      buildNotificationDispatchPlan({
        email: { enabled: false },
        sms: { enabled: false },
        telegram: { enabled: false },
        whatsapp: { enabled: false },
      }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement notification plan helper**

Create `worker/jobs/notification/plan.ts`:

```ts
export type NotificationChannelName = 'email' | 'sms' | 'telegram' | 'whatsapp';

export type NotificationChannelEligibility = Record<
  NotificationChannelName,
  { enabled: boolean }
>;

export function buildNotificationDispatchPlan(
  eligibility: NotificationChannelEligibility,
): NotificationChannelName[] {
  return (['email', 'sms', 'telegram', 'whatsapp'] as const).filter(
    (channel) => eligibility[channel].enabled,
  );
}
```

- [ ] **Step 3: Run notification plan tests**

Run:

```bash
pnpm exec vitest run worker/jobs/notification/__tests__/plan.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 4: Extract one parser from Twilio WhatsApp inbound**

Create `worker/ingress/twilio/parse-inbound.ts`:

```ts
export interface TwilioWhatsAppInboundEvent {
  from: string;
  body: string;
  messageSid: string;
}

export function parseTwilioWhatsAppInbound(input: Record<string, unknown>): TwilioWhatsAppInboundEvent {
  const from = typeof input.From === 'string' ? input.From : '';
  const body = typeof input.Body === 'string' ? input.Body : '';
  const messageSid = typeof input.MessageSid === 'string' ? input.MessageSid : '';

  return { from, body, messageSid };
}
```

Write tests in `worker/ingress/twilio/__tests__/parse-inbound.test.ts` for present and missing fields.

- [ ] **Step 5: Wire Twilio inbound handler to the parser**

Modify `worker/ingress/twilio/twilio-whatsapp-inbound.ts` so the first parsing branch delegates to `parseTwilioWhatsAppInbound`. Preserve signature verification, response status codes, audit logging, and downstream behavior.

- [ ] **Step 6: Run notification and Twilio tests**

Run:

```bash
pnpm exec vitest run worker/jobs/notification/__tests__/plan.test.ts worker/jobs/notification/__tests__/NotificationWorker.test.ts worker/jobs/notification/__tests__/NotificationWorker-sms.test.ts worker/jobs/notification/__tests__/NotificationWorker-telegram.test.ts worker/jobs/notification/__tests__/NotificationWorker.whatsapp.test.ts worker/ingress/twilio/__tests__/parse-inbound.test.ts worker/ingress/twilio/__tests__/twilio-whatsapp.test.ts worker/ingress/twilio/__tests__/twilio-inbound.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 7: Commit notification/ingress extraction**

Run:

```bash
git add worker/jobs/notification worker/ingress/twilio
git commit -m "refactor: split notification planning and twilio parsing"
```

Expected:

```text
One commit. Worker ingress behavior unchanged.
```

---

## Task 9: Final Hygiene and Fallow Recheck

**Files:**
- Modify: `src/components/dashboard/ValueKpiGrid.tsx`
- Modify only if justified: `.fallowrc.json`

- [ ] **Step 1: Downgrade `synthesizeSpark` export only**

Modify `src/components/dashboard/ValueKpiGrid.tsx`:

```ts
function synthesizeSpark(total: number, n: number): number[] {
  if (total <= 0) return Array(n).fill(0);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const progress = (i + 1) / n;
    out.push(Math.round(total * progress * (0.4 + 0.6 * progress)));
  }
  return out;
}
```

Only remove the `export` keyword. Do not delete the function; it is used locally by `ValueKpiGrid`.

- [ ] **Step 2: Run the narrow check for dashboard component import safety**

Run:

```bash
pnpm exec vitest run src/components/dashboard/__tests__/KpiCards.test.tsx src/components/dashboard/__tests__/ReviewsCard.test.tsx
```

Expected:

```text
PASS
```

- [ ] **Step 3: Run full relevant slice tests**

Run:

```bash
pnpm exec vitest run src/app/api/zernio/connect/start/__tests__/route.test.ts src/app/api/zernio/connect/callback/__tests__/route.test.ts src/app/api/zernio/connect/select-location/__tests__/route.test.ts src/app/api/zernio/connect/cancel/__tests__/route.test.ts src/lib/zernio/__tests__/client.test.ts worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts src/app/api/dashboard/__tests__/route.test.ts src/app/api/dashboard/__tests__/scope-route.test.ts worker/jobs/__tests__/OnboardingDemoWorker.test.ts worker/jobs/notification/__tests__/NotificationWorker.test.ts worker/ingress/twilio/__tests__/twilio-whatsapp.test.ts
```

Expected:

```text
PASS
```

- [ ] **Step 4: Run Fallow after cleanup**

Run:

```bash
fallow health --format json --explain > /private/tmp/repworth-fallow-health-after.json
fallow health --production --format json --explain > /private/tmp/repworth-fallow-health-production-after.json
fallow health --targets --format json --explain > /private/tmp/repworth-fallow-targets-after.json
fallow dupes --production --format json > /private/tmp/repworth-fallow-dupes-production-after.json
```

Expected:

```text
Commands may exit 1 while findings remain. JSON files are written.
```

- [ ] **Step 5: Run build**

Run:

```bash
pnpm build
```

Expected:

```text
PASS
```

- [ ] **Step 6: Commit final hygiene**

Run:

```bash
git add src/components/dashboard/ValueKpiGrid.tsx
git commit -m "chore: clean fallow export surface"
```

Expected:

```text
One small hygiene commit.
```

---

## Task 10: Final Report

**Files:**
- Create: `docs/superpowers/baselines/2026-05-20-fallow-architecture-cleanup-after.md`

- [ ] **Step 1: Write the final comparison report**

Create `docs/superpowers/baselines/2026-05-20-fallow-architecture-cleanup-after.md` with actual values from `/private/tmp/repworth-fallow-health-after.json`, `/private/tmp/repworth-fallow-health-production-after.json`, and `/private/tmp/repworth-fallow-targets-after.json`.

The committed report must include these sections and must not contain empty metric bullets:

```markdown
# Fallow Architecture Cleanup After Report

## Verification

- Zernio route/client/publisher tests passed.
- Dashboard route/service tests passed.
- Onboarding/demo tests passed.
- Notification/ingress tests passed.
- `pnpm build` passed.

## Fallow After Metrics

- Normal health is recorded from `/private/tmp/repworth-fallow-health-after.json`.
- Production health is recorded from `/private/tmp/repworth-fallow-health-production-after.json`.
- Normal maintainability is recorded from `/private/tmp/repworth-fallow-health-after.json`.
- Production maintainability is recorded from `/private/tmp/repworth-fallow-health-production-after.json`.
- Normal duplication is recorded from `/private/tmp/repworth-fallow-health-after.json`.
- Production duplication is recorded from `/private/tmp/repworth-fallow-health-production-after.json`.
- Normal high-priority targets are recorded from `/private/tmp/repworth-fallow-targets-after.json`.

## Primary Runtime Targets

- `getActiveDashboardData` outcome is recorded.
- Zernio `select-location` `POST` outcome is recorded.
- Zernio callback `GET` outcome is recorded.
- `handlePublishResponse` outcome is recorded.

## Deferred Runtime Targets

- None.
```

- [ ] **Step 2: Commit the report**

Run:

```bash
git add -f docs/superpowers/baselines/2026-05-20-fallow-architecture-cleanup-after.md
git commit -m "docs: report fallow architecture cleanup results"
```

Expected:

```text
Final documentation commit with the verification evidence.
```

---

## Final Verification Gate

Before claiming the cleanup complete, run:

```bash
pnpm build
fallow health
fallow health --production
git status --short --branch
```

Expected:

```text
Build passes.
Fallow output is captured and summarized.
Only intentional files are changed.
Pre-existing .nvmrc and pnpm-workspace.yaml remain untracked unless separately scoped.
```

## Execution Notes

- Use TDD for each extraction: failing focused test, minimal move, passing focused test, then route/worker suite.
- Do not introduce broad provider abstractions. Concrete modules are enough unless two real adapters exist.
- Do not move third-party ingress from Railway worker code to Next.js.
- Do not change Redis keys, TTLs, cookie names, redirect URLs, response payloads, SQL predicates, outbox topics, or status names unless a failing test proves the current behavior is wrong and the user approves the behavior change.
- If a refactor requires behavior changes to pass, stop and report the discovered bug before continuing.
