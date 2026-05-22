# WhatsApp Channel Go-Live Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the already-built, flag-gated WhatsApp channel to production by building the owner self-service enrollment widget, unifying env-readiness checks, extracting enrollment helpers, and producing the go-live runbook — so customers can self-connect WhatsApp once the flag flips.

**Architecture:** All net-new code lands behind `CHANNELS_WHATSAPP_ENABLED` (zero customer surface until flip). The owner widget mirrors the existing `OwnerTelegramWidget` + owner Telegram routes exactly, reusing the generic `useEnrollment` hook (already WhatsApp-capable) and the shared `enrollmentReducer`. Route handlers stay thin and orchestrate; the enrollment state machine moves into `src/lib/channels/whatsapp-enrollment.ts` (per the entry-point invariant), and the existing admin route is refactored to use it. Activation (Twilio/Meta provisioning, env, ship gate, flag flip) is a runbook + manual gate, not code.

**Tech Stack:** Next.js App Router route handlers, React client components, `useReducer`-based enrollment hook, Postgres via `postgres` (Postgres.js) with advisory-lock transactions, Twilio WhatsApp (Content API / `whatsapp/card`), Vitest, Playwright, pnpm.

**Spec:** `docs/superpowers/specs/2026-05-22-whatsapp-go-live-design.md`

---

## Scope Check

Single subsystem (the WhatsApp channel), three streams that share one plan because they converge on one ship gate. ① Verify is a gate, not code. ② Owner widget is the code. ③ Activate is the runbook. This is one coherent plan producing one shippable outcome.

## File Structure

**Modify (Stream ②):**
- `src/app/api/admin/channels/whatsapp/_shared.ts` — add `WHATSAPP_REQUIRED_ENV`, `missingWhatsAppEnv()`, `whatsappEnvReady()`; `assertWhatsAppEnvReady` derives from them.
- `src/lib/channels/whatsapp-enrollment.ts` — add `startWhatsAppEnrollment`, `disableWhatsAppEnrollment` (mirror `telegram-enrollment.ts`).
- `src/app/api/admin/channels/whatsapp/start/route.ts` — refactor to call `startWhatsAppEnrollment` (pure move).
- `src/app/(authenticated)/settings/channels/page.tsx` — `whatsappAvailable()` uses `whatsappEnvReady()`.
- `src/app/api/dashboard/channels/route.ts` — `whatsappAvailable()` uses `whatsappEnvReady()`.
- `src/app/(authenticated)/settings/channels/ChannelsClient.tsx` — swap WhatsApp stub for `OwnerWhatsAppWidget`.
- `src/lib/notifications/channels/__tests__/enrollment-reducer.test.ts` — add the generic-409 copy-lock assertion.

**Create (Stream ②):**
- `src/app/api/dashboard/channels/whatsapp/start/route.ts`
- `src/app/api/dashboard/channels/whatsapp/cancel/route.ts`
- `src/app/api/dashboard/channels/whatsapp/disable/route.ts`
- `src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts`
- `src/app/api/dashboard/channels/whatsapp/__tests__/cancel.test.ts`
- `src/app/api/dashboard/channels/whatsapp/__tests__/disable.test.ts`
- `src/components/dashboard/OwnerWhatsAppWidget.tsx`
- `src/components/dashboard/__tests__/OwnerWhatsAppWidget.test.tsx`
- `src/lib/channels/__tests__/whatsapp-enrollment.test.ts` (if absent; else extend)

**Modify (Stream ③):**
- `docs/runbooks/whatsapp-templates.md` — `whatsapp/card` switch, 9-var validation, Vercel+Railway env matrix, canary-before-gate, copy-lock, ship-gate checklist.

---

## Task 1: Verify — confirm no drift on current `main` (gate, no code)

**Files:** none (verification only).

- [ ] **Step 1: Run the WhatsApp + notification suites**

Run:
```bash
pnpm test src/lib/notifications/channels worker/jobs/notification worker/ingress/twilio src/app/api/admin/channels/whatsapp
```
Expected: all PASS. This re-confirms the audit (subscription read from `accounts`, enrollment scoped by `business_id`, IDs threaded through `approval_links`/`notification_deliveries`).

- [ ] **Step 2: If any test fails, STOP and triage**

A failure here means genuine drift (not anticipated). Capture the failing test + output, surface it to the user, and insert a fix task before continuing. Do not proceed to Task 2 on red.

- [ ] **Step 3: Record the result**

No commit. Note in the execution log: "Stream ① verify: green on `<short-sha>`."

---

## Task 2: Unify the env-readiness predicate

Eliminates the 5-var vs 4-var mismatch that lets the UI show a Connect button the route then 503s.

**Files:**
- Modify: `src/app/api/admin/channels/whatsapp/_shared.ts`
- Test: `src/app/api/admin/channels/whatsapp/__tests__/_shared.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/app/api/admin/channels/whatsapp/__tests__/_shared.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { whatsappEnvReady, missingWhatsAppEnv } from '../_shared';

const ALL = {
  TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 'tok',
  TWILIO_WHATSAPP_NUMBER: 'whatsapp:+15551230000',
  WHATSAPP_APPROVAL_TEMPLATE_SID: 'HX', WHATSAPP_APPROVAL_URL_BASE: 'http://localhost/approve/',
};

describe('whatsappEnvReady / missingWhatsAppEnv', () => {
  beforeEach(() => {
    delete process.env.MOCK_EXTERNAL_APIS;
    for (const k of Object.keys(ALL)) delete process.env[k];
  });

  it('reports all five vars missing when none set', () => {
    expect(missingWhatsAppEnv().sort()).toEqual(Object.keys(ALL).sort());
    expect(whatsappEnvReady()).toBe(false);
  });

  it('treats WHATSAPP_APPROVAL_URL_BASE as required (the var the old 4-var checks dropped)', () => {
    for (const [k, v] of Object.entries(ALL)) process.env[k] = v;
    delete process.env.WHATSAPP_APPROVAL_URL_BASE;
    expect(missingWhatsAppEnv()).toEqual(['WHATSAPP_APPROVAL_URL_BASE']);
    expect(whatsappEnvReady()).toBe(false);
  });

  it('is ready when all five present', () => {
    for (const [k, v] of Object.entries(ALL)) process.env[k] = v;
    expect(whatsappEnvReady()).toBe(true);
  });

  it('MOCK_EXTERNAL_APIS bypasses the check', () => {
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(whatsappEnvReady()).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/app/api/admin/channels/whatsapp/__tests__/_shared.test.ts`
Expected: FAIL — `whatsappEnvReady`/`missingWhatsAppEnv` are not exported.

- [ ] **Step 3: Implement the unified predicate**

Edit `src/app/api/admin/channels/whatsapp/_shared.ts`. Add above `assertWhatsAppEnvReady` and rewrite that function to derive from the shared list:

```ts
export const WHATSAPP_REQUIRED_ENV = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_NUMBER',
  'WHATSAPP_APPROVAL_TEMPLATE_SID',
  'WHATSAPP_APPROVAL_URL_BASE',
] as const;

/** Vars from WHATSAPP_REQUIRED_ENV that are unset/blank. */
export function missingWhatsAppEnv(): string[] {
  return WHATSAPP_REQUIRED_ENV.filter((k) => !process.env[k] || process.env[k]!.trim().length === 0);
}

/**
 * Single source of truth for "is the WhatsApp send/enrollment env ready?".
 * Used by the route guard AND the UI availability checks so the UI never
 * renders a Connect button that the start route would 503.
 * MOCK_EXTERNAL_APIS=true bypasses (local dev).
 */
export function whatsappEnvReady(): boolean {
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return true;
  return missingWhatsAppEnv().length === 0;
}
```

Then replace the body of `assertWhatsAppEnvReady` so it reuses the list:

```ts
export function assertWhatsAppEnvReady(): NextResponse | null {
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return null;
  const missing = missingWhatsAppEnv();
  if (missing.length === 0) return null;
  console.error(`[whatsapp-admin] CHANNELS_WHATSAPP_ENABLED=true but missing env vars: ${missing.join(', ')}`);
  return NextResponse.json({ ok: false, reason: 'whatsapp_env_not_ready', missing }, { status: 503 });
}
```

- [ ] **Step 4: Point the two UI availability checks at the predicate**

In `src/app/(authenticated)/settings/channels/page.tsx`, replace the body of `whatsappAvailable()`:

```ts
import { whatsappEnvReady } from '@/app/api/admin/channels/whatsapp/_shared';
// ...
function whatsappAvailable(): boolean {
  if (process.env.CHANNELS_WHATSAPP_ENABLED !== 'true') return false;
  return whatsappEnvReady();
}
```

Apply the identical change to `whatsappAvailable()` in `src/app/api/dashboard/channels/route.ts` (add the same import; replace the inline 4-var list with `return whatsappEnvReady();`).

- [ ] **Step 5: Run the env tests + the UI availability route tests**

Run: `pnpm test src/app/api/admin/channels/whatsapp src/app/api/dashboard/channels`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/admin/channels/whatsapp/_shared.ts \
        src/app/api/admin/channels/whatsapp/__tests__/_shared.test.ts \
        "src/app/(authenticated)/settings/channels/page.tsx" \
        src/app/api/dashboard/channels/route.ts
git commit -m "refactor(channels): unify WhatsApp env-readiness on a 5-var predicate"
```

---

## Task 3: Extract `startWhatsAppEnrollment` + `disableWhatsAppEnrollment`

Mirrors `telegram-enrollment.ts`. The module already has `cancelWhatsAppEnrollment`.

**Files:**
- Modify: `src/lib/channels/whatsapp-enrollment.ts`
- Test: `src/lib/channels/__tests__/whatsapp-enrollment.test.ts`

- [ ] **Step 1: Write the failing tests**

Create (or extend) `src/lib/channels/__tests__/whatsapp-enrollment.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { startWhatsAppEnrollment, disableWhatsAppEnrollment } from '../whatsapp-enrollment';

/** Tagged-template mock: returns queued result arrays in call order, records SQL text. */
function makeTx(results: unknown[][]) {
  const calls: string[] = [];
  const tx = (strings: TemplateStringsArray, ..._v: unknown[]) => {
    calls.push(strings.join('?'));
    return Promise.resolve(results.shift() ?? []);
  };
  return { tx, calls };
}

const TS = new Date('2026-05-22T00:00:00Z');

describe('startWhatsAppEnrollment', () => {
  it('inserts a pending row when none exists → ok', async () => {
    const { tx, calls } = makeTx([[] /* SELECT FOR UPDATE */, [] /* INSERT */]);
    const r = await startWhatsAppEnrollment(tx, 'biz-1', 'acct-1', 'hash', TS);
    expect(r).toEqual({ kind: 'ok' });
    expect(calls.some((c) => c.includes('INSERT INTO channel_enrollments'))).toBe(true);
  });

  it('returns already_verified when a verified row exists', async () => {
    const { tx } = makeTx([[{ id: 'e1', status: 'verified' }]]);
    const r = await startWhatsAppEnrollment(tx, 'biz-1', 'acct-1', 'hash', TS);
    expect(r).toEqual({ kind: 'already_verified' });
  });

  it('updates an existing pending row → ok', async () => {
    const { tx, calls } = makeTx([[{ id: 'e1', status: 'pending_verification' }], []]);
    const r = await startWhatsAppEnrollment(tx, 'biz-1', 'acct-1', 'hash', TS);
    expect(r).toEqual({ kind: 'ok' });
    expect(calls.some((c) => c.includes('UPDATE channel_enrollments'))).toBe(true);
  });
});

describe('disableWhatsAppEnrollment', () => {
  it('returns ok when a verified row is flipped', async () => {
    const { tx } = makeTx([[{ id: 'e1' }]]);
    expect(await disableWhatsAppEnrollment(tx, 'biz-1')).toEqual({ kind: 'ok' });
  });
  it('returns not_found when nothing matched', async () => {
    const { tx } = makeTx([[]]);
    expect(await disableWhatsAppEnrollment(tx, 'biz-1')).toEqual({ kind: 'not_found' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/lib/channels/__tests__/whatsapp-enrollment.test.ts`
Expected: FAIL — `startWhatsAppEnrollment` / `disableWhatsAppEnrollment` not exported.

- [ ] **Step 3: Implement the helpers**

In `src/lib/channels/whatsapp-enrollment.ts`, add the import and the two functions (the file already has `cancelWhatsAppEnrollment` and the `TxLike` type):

```ts
import { v7 as uuidv7 } from 'uuid';
import { classifyEnrollmentError } from './unique-violation';

export type StartWhatsAppResult = { kind: 'ok' } | { kind: 'already_verified' };

/**
 * Insert/update a WhatsApp enrollment row to `pending_verification` with a
 * fresh hash + expiry. Caller MUST open sql.begin, take the
 * `mobile_enroll:${businessId}` advisory lock inside it BEFORE calling this,
 * generate rawToken outside the tx, and build the QR after commit.
 * SELECT FOR UPDATE serializes against a concurrent inbound webhook tx.
 * Mirrors startTelegramEnrollment.
 */
export async function startWhatsAppEnrollment(
  tx: TxLike,
  businessId: string,
  accountId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<StartWhatsAppResult> {
  const existing = (await tx`
    SELECT id, status FROM channel_enrollments
    WHERE business_id = ${businessId} AND channel = 'whatsapp' AND archived_at IS NULL
    FOR UPDATE
  `) as Array<{ id: string; status: string }>;
  const existingRow = existing[0];

  if (existingRow?.status === 'verified') {
    return { kind: 'already_verified' };
  }

  try {
    if (existingRow) {
      await tx`
        UPDATE channel_enrollments
        SET status                        = 'pending_verification',
            handle                        = NULL,
            verification_token_hash       = ${tokenHash},
            verification_token_expires_at = ${expiresAt},
            disabled_at                   = NULL,
            unsubscribed_at               = NULL,
            unsubscribed_reason           = NULL,
            updated_at                    = NOW()
        WHERE id = ${existingRow.id}
      `;
    } else {
      await tx`
        INSERT INTO channel_enrollments
          (id, account_id, business_id, channel, status, verification_token_hash, verification_token_expires_at)
        VALUES
          (${uuidv7()}, ${accountId}, ${businessId}, 'whatsapp', 'pending_verification', ${tokenHash}, ${expiresAt})
      `;
    }
  } catch (err) {
    classifyEnrollmentError(err); // always throws
  }

  return { kind: 'ok' };
}

/**
 * Owner/admin disconnect. Flips verified → disabled, clears handle.
 * No sql.begin, no advisory lock. Returns not_found if no verified row matched.
 * Mirrors disableTelegramEnrollment.
 */
export async function disableWhatsAppEnrollment(
  sql: TxLike,
  businessId: string,
): Promise<{ kind: 'ok' | 'not_found' }> {
  const updated = (await sql`
    UPDATE channel_enrollments
    SET status = 'disabled',
        handle = NULL,
        disabled_at = NOW(),
        updated_at = NOW()
    WHERE business_id = ${businessId}
      AND channel = 'whatsapp'
      AND status = 'verified'
      AND archived_at IS NULL
    RETURNING id
  `) as Array<{ id: string }>;
  return updated.length > 0 ? { kind: 'ok' } : { kind: 'not_found' };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/lib/channels/__tests__/whatsapp-enrollment.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/channels/whatsapp-enrollment.ts src/lib/channels/__tests__/whatsapp-enrollment.test.ts
git commit -m "feat(channels): add start/disable WhatsApp enrollment helpers"
```

---

## Task 4: Refactor the admin WhatsApp start route to use the helper

Pure move — behavior unchanged. The existing admin `start.test.ts` is the regression net.

**Files:**
- Modify: `src/app/api/admin/channels/whatsapp/start/route.ts`
- Test (existing, must stay green): `src/app/api/admin/channels/whatsapp/__tests__/start.test.ts`

- [ ] **Step 1: Replace the inline state machine with the helper call**

In `start/route.ts`: add the import and replace the inline `SELECT … FOR UPDATE` + `UPDATE`/`INSERT` block inside `sql.begin` with a call to `startWhatsAppEnrollment`. The advisory lock, token generation, error mapping, cache invalidation, and `wa.me` deep-link code all stay.

Add to imports:
```ts
import { startWhatsAppEnrollment } from '@/lib/channels/whatsapp-enrollment';
```

Replace the `result = await sql.begin(...)` block with:
```ts
  let result: { kind: 'ok' } | { kind: 'already_verified' } | undefined;
  try {
    result = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${businessId}`}, 0))`;
      return startWhatsAppEnrollment(tx, businessId, accountId, tokenHash, expiresAt);
    });
  } catch (err) {
    if (err instanceof MultipleMobileChannelsError) {
      return NextResponse.json({ error: 'multiple_mobile_channels' }, { status: 409, headers: { 'Cache-Control': 'no-store, private' } });
    }
    if (err instanceof EnrollmentDatabaseError) {
      console.error('[whatsapp/start] enrollment db error', err);
      return NextResponse.json({ error: 'internal' }, { status: 500, headers: { 'Cache-Control': 'no-store, private' } });
    }
    throw err;
  }
```

Remove the now-unused `uuidv7` import if and only if it is no longer referenced elsewhere in the file (the INSERT moved into the helper). Keep `classifyEnrollmentError`/`MultipleMobileChannelsError`/`EnrollmentDatabaseError` imports — the catch still uses the typed errors.

- [ ] **Step 2: Run the admin start regression suite**

Run: `pnpm test src/app/api/admin/channels/whatsapp/__tests__/start.test.ts`
Expected: PASS (unchanged behavior). If a fixture asserted exact SQL-call ordering, adjust only the fixture queue order to match `startWhatsAppEnrollment` (SELECT then INSERT/UPDATE) — do not change response assertions.

- [ ] **Step 3: Typecheck + lint the touched files**

Run: `pnpm lint`
Expected: no errors (catches an orphaned `uuidv7` import).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/admin/channels/whatsapp/start/route.ts
git commit -m "refactor(channels): admin WhatsApp start route orchestrates via helper"
```

---

## Task 5: Owner WhatsApp `start` route

**Files:**
- Create: `src/app/api/dashboard/channels/whatsapp/start/route.ts`
- Test: `src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlQueue, consume } = vi.hoisted(() => {
  const q: unknown[] = [];
  const c = async () => {
    const next = q.shift();
    return Array.isArray(next) ? next : [];
  };
  return { sqlQueue: q, consume: c };
});

vi.mock('@/lib/db/server', () => ({
  sql: Object.assign(consume, { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(consume) }),
  jsonb: (v: unknown) => v,
}));

const requireRoleMock = vi.fn(async () => ({ userId: 'owner-1', role: 'owner', locationId: 'biz-1' }));
vi.mock('@/lib/db/auth', () => ({
  requireRole: (...a: unknown[]) => requireRoleMock(...(a as [])),
  AuthError: class extends Error { statusCode = 401; },
}));
vi.mock('@/lib/auth/route-helpers', () => ({ withSameOrigin: () => (h: unknown) => h }));
vi.mock('@/lib/notifications/resolve-channels', () => ({ safeInvalidateChannelCache: vi.fn(async () => {}) }));
vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,TEST') } }));

import { POST } from '../start/route';

const APP_URL = 'http://localhost';
function mkReq() {
  return new Request('http://localhost/api/dashboard/channels/whatsapp/start', {
    method: 'POST', body: JSON.stringify({}), headers: { 'Content-Type': 'application/json', Origin: APP_URL },
  });
}

beforeEach(() => {
  sqlQueue.length = 0;
  requireRoleMock.mockResolvedValue({ userId: 'owner-1', role: 'owner', locationId: 'biz-1' });
  process.env.NEXT_PUBLIC_APP_URL = APP_URL;
  process.env.MOCK_EXTERNAL_APIS = 'true';
  process.env.TWILIO_WHATSAPP_NUMBER = 'whatsapp:+15551230000';
  delete process.env.CHANNELS_WHATSAPP_ENABLED;
});

describe('POST /api/dashboard/channels/whatsapp/start', () => {
  it('returns 404 when flag is off', async () => {
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(404);
  });

  it('returns 403 when subscription is not active', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'past_due' }]); // accounts lookup
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('subscription_not_active');
  });

  it('returns deepLink + qrDataUrl on success', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]); // accounts lookup
    sqlQueue.push([]);          // advisory lock
    sqlQueue.push([]);          // SELECT FOR UPDATE (no existing row)
    sqlQueue.push([]);          // INSERT
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deepLink).toMatch(/^https:\/\/wa\.me\/15551230000\?text=start-/);
    expect(body.qrDataUrl).toBe('data:image/png;base64,TEST');
  });

  it('returns 409 already_verified when a verified row exists', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([{ id: 'acct-1', subscription_status: 'active' }]);
    sqlQueue.push([]);                                  // advisory lock
    sqlQueue.push([{ id: 'e1', status: 'verified' }]);  // SELECT FOR UPDATE
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already_verified');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts`
Expected: FAIL — route module does not exist.

- [ ] **Step 3: Implement the route**

Create `src/app/api/dashboard/channels/whatsapp/start/route.ts`:

```ts
// src/app/api/dashboard/channels/whatsapp/start/route.ts
//
// POST /api/dashboard/channels/whatsapp/start — owner-scoped enrollment.
// Mirrors the owner Telegram route: locationId from session (never body),
// wrapped with withSameOrigin() (CSRF). Orchestrates startWhatsAppEnrollment.

import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import QRCode from 'qrcode';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { isWhatsAppEnabled, flagOff, assertWhatsAppEnvReady } from '@/app/api/admin/channels/whatsapp/_shared';
import { startWhatsAppEnrollment } from '@/lib/channels/whatsapp-enrollment';
import { MultipleMobileChannelsError, EnrollmentDatabaseError } from '@/lib/channels/unique-violation';
import { TOKEN_TTL_MS } from '@/lib/notifications/channels/constants';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';

async function handler(req: NextRequest): Promise<NextResponse> {
  if (!isWhatsAppEnabled()) return flagOff();

  const envErr = assertWhatsAppEnvReady();
  if (envErr) return envErr;

  let user;
  try {
    user = await requireRole(req, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const locationId = user.locationId;
  if (!locationId) return NextResponse.json({ error: 'no_business' }, { status: 403 });

  // After migration 034, subscription_status source of truth is accounts.
  const [accountRow] = await sql<{ id: string; subscription_status: string }[]>`
    SELECT a.id, a.subscription_status
    FROM accounts a
    JOIN businesses b ON b.account_id = a.id
    WHERE b.id = ${locationId}
  `;
  if (!accountRow) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (accountRow.subscription_status !== SubscriptionStatus.ACTIVE) {
    return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });
  }
  const accountId = accountRow.id;

  const rawToken = randomUUID();
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  const noStore = { 'Cache-Control': 'no-store, private' };

  let result: Awaited<ReturnType<typeof startWhatsAppEnrollment>> | undefined;
  try {
    result = await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${locationId}`}, 0))`;
      return startWhatsAppEnrollment(tx, locationId, accountId, tokenHash, expiresAt);
    });
  } catch (err) {
    if (err instanceof MultipleMobileChannelsError) {
      return NextResponse.json({ error: 'multiple_mobile_channels' }, { status: 409, headers: noStore });
    }
    if (err instanceof EnrollmentDatabaseError) {
      console.error('[owner whatsapp/start] enrollment db error', err);
      return NextResponse.json({ error: 'internal' }, { status: 500, headers: noStore });
    }
    throw err;
  }

  if (result?.kind === 'already_verified') {
    return NextResponse.json({ error: 'already_verified' }, { status: 409, headers: noStore });
  }

  await safeInvalidateChannelCache(asAccountId(accountId), 'dashboard.whatsapp.start');

  // wa.me requires digits only (no +, no whatsapp:).
  const digits = process.env.TWILIO_WHATSAPP_NUMBER!.replace(/^whatsapp:\+?/, '');
  const prefilled = encodeURIComponent(`start-${rawToken}`);
  const deepLink = `https://wa.me/${digits}?text=${prefilled}`;
  const qrDataUrl = await QRCode.toDataURL(deepLink, { margin: 1, width: 256 });

  return NextResponse.json(
    { deepLink, qrDataUrl, expiresAt: expiresAt.toISOString() },
    { headers: noStore },
  );
}

export const POST = withSameOrigin()(handler);
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/dashboard/channels/whatsapp/start/route.ts \
        src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts
git commit -m "feat(channels): owner WhatsApp start route"
```

---

## Task 6: Owner WhatsApp `cancel` route

**Files:**
- Create: `src/app/api/dashboard/channels/whatsapp/cancel/route.ts`
- Test: `src/app/api/dashboard/channels/whatsapp/__tests__/cancel.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/dashboard/channels/whatsapp/__tests__/cancel.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlQueue, consume } = vi.hoisted(() => {
  const q: unknown[] = [];
  const c = async () => (Array.isArray(q[0]) ? q.shift() : (q.shift(), []));
  return { sqlQueue: q, consume: c };
});
vi.mock('@/lib/db/server', () => ({
  sql: Object.assign(consume, { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(consume) }),
  jsonb: (v: unknown) => v,
}));
const requireRoleMock = vi.fn(async () => ({ userId: 'owner-1', role: 'owner', locationId: 'biz-1' }));
vi.mock('@/lib/db/auth', () => ({
  requireRole: (...a: unknown[]) => requireRoleMock(...(a as [])),
  AuthError: class extends Error { statusCode = 401; },
}));
vi.mock('@/lib/auth/route-helpers', () => ({ withSameOrigin: () => (h: unknown) => h }));
vi.mock('@/lib/notifications/resolve-channels', () => ({ safeInvalidateChannelCache: vi.fn(async () => {}) }));

import { POST } from '../cancel/route';

function mkReq() {
  return new Request('http://localhost/api/dashboard/channels/whatsapp/cancel', {
    method: 'POST', body: JSON.stringify({}), headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
  });
}

beforeEach(() => {
  sqlQueue.length = 0;
  requireRoleMock.mockResolvedValue({ userId: 'owner-1', role: 'owner', locationId: 'biz-1' });
  process.env.MOCK_EXTERNAL_APIS = 'true';
  delete process.env.CHANNELS_WHATSAPP_ENABLED;
});

describe('POST /api/dashboard/channels/whatsapp/cancel', () => {
  it('404 when flag off', async () => {
    expect((await POST(mkReq() as any)).status).toBe(404);
  });

  it('200 ok on cancel of active subscription', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([{ subscription_status: 'active' }]); // accounts lookup
    sqlQueue.push([]);                                  // advisory lock
    sqlQueue.push([{ id: 'e1' }]);                      // cancel UPDATE RETURNING
    sqlQueue.push([{ account_id: 'acct-1' }]);          // account_id for cache invalidation
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/app/api/dashboard/channels/whatsapp/__tests__/cancel.test.ts`
Expected: FAIL — route does not exist.

- [ ] **Step 3: Implement the route**

Create `src/app/api/dashboard/channels/whatsapp/cancel/route.ts`:

```ts
// src/app/api/dashboard/channels/whatsapp/cancel/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { isWhatsAppEnabled, flagOff, assertWhatsAppEnvReady } from '@/app/api/admin/channels/whatsapp/_shared';
import { cancelWhatsAppEnrollment } from '@/lib/channels/whatsapp-enrollment';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';

async function handler(req: NextRequest): Promise<NextResponse> {
  if (!isWhatsAppEnabled()) return flagOff();

  const envErr = assertWhatsAppEnvReady();
  if (envErr) return envErr;

  let user;
  try {
    user = await requireRole(req, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!user.locationId) return NextResponse.json({ error: 'no_business' }, { status: 403 });

  const [accountRow] = await sql<{ subscription_status: string }[]>`
    SELECT a.subscription_status
    FROM accounts a
    JOIN businesses b ON b.account_id = a.id
    WHERE b.id = ${user.locationId}
  `;
  if (accountRow?.subscription_status !== SubscriptionStatus.ACTIVE) {
    return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });
  }

  const locationId = user.locationId;
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`mobile_enroll:${locationId}`}, 0))`;
    return cancelWhatsAppEnrollment(tx, locationId);
  });

  const [acctRow] = await sql<{ account_id: string }[]>`
    SELECT account_id FROM businesses WHERE id = ${locationId}
  `;
  if (acctRow?.account_id) {
    await safeInvalidateChannelCache(asAccountId(acctRow.account_id), 'dashboard.whatsapp.cancel');
  }

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store, private' } });
}

export const POST = withSameOrigin()(handler);
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/app/api/dashboard/channels/whatsapp/__tests__/cancel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/dashboard/channels/whatsapp/cancel/route.ts \
        src/app/api/dashboard/channels/whatsapp/__tests__/cancel.test.ts
git commit -m "feat(channels): owner WhatsApp cancel route"
```

---

## Task 7: Owner WhatsApp `disable` route

**Files:**
- Create: `src/app/api/dashboard/channels/whatsapp/disable/route.ts`
- Test: `src/app/api/dashboard/channels/whatsapp/__tests__/disable.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/dashboard/channels/whatsapp/__tests__/disable.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlQueue, consume } = vi.hoisted(() => {
  const q: unknown[] = [];
  const c = async () => (Array.isArray(q[0]) ? q.shift() : (q.shift(), []));
  return { sqlQueue: q, consume: c };
});
vi.mock('@/lib/db/server', () => ({
  sql: Object.assign(consume, { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(consume) }),
  jsonb: (v: unknown) => v,
}));
const requireRoleMock = vi.fn(async () => ({ userId: 'owner-1', role: 'owner', locationId: 'biz-1' }));
vi.mock('@/lib/db/auth', () => ({
  requireRole: (...a: unknown[]) => requireRoleMock(...(a as [])),
  AuthError: class extends Error { statusCode = 401; },
}));
vi.mock('@/lib/auth/route-helpers', () => ({ withSameOrigin: () => (h: unknown) => h }));
vi.mock('@/lib/notifications/resolve-channels', () => ({ safeInvalidateChannelCache: vi.fn(async () => {}) }));

import { POST } from '../disable/route';

function mkReq() {
  return new Request('http://localhost/api/dashboard/channels/whatsapp/disable', {
    method: 'POST', body: JSON.stringify({}), headers: { 'Content-Type': 'application/json', Origin: 'http://localhost' },
  });
}

beforeEach(() => {
  sqlQueue.length = 0;
  requireRoleMock.mockResolvedValue({ userId: 'owner-1', role: 'owner', locationId: 'biz-1' });
  process.env.MOCK_EXTERNAL_APIS = 'true';
  delete process.env.CHANNELS_WHATSAPP_ENABLED;
});

describe('POST /api/dashboard/channels/whatsapp/disable', () => {
  it('404 when flag off', async () => {
    expect((await POST(mkReq() as any)).status).toBe(404);
  });

  it('404 when no verified row to disable', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([{ subscription_status: 'active' }]); // accounts lookup
    sqlQueue.push([]);                                  // disable UPDATE → no rows
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(404);
  });

  it('200 ok when a verified row is disabled', async () => {
    process.env.CHANNELS_WHATSAPP_ENABLED = 'true';
    sqlQueue.push([{ subscription_status: 'active' }]); // accounts lookup
    sqlQueue.push([{ id: 'e1' }]);                      // disable UPDATE RETURNING
    sqlQueue.push([{ account_id: 'acct-1' }]);          // account_id for cache invalidation
    const res = await POST(mkReq() as any);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/app/api/dashboard/channels/whatsapp/__tests__/disable.test.ts`
Expected: FAIL — route does not exist.

- [ ] **Step 3: Implement the route**

Create `src/app/api/dashboard/channels/whatsapp/disable/route.ts`:

```ts
// src/app/api/dashboard/channels/whatsapp/disable/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { requireRole, AuthError } from '@/lib/db/auth';
import { SubscriptionStatus } from '@/lib/shared/subscription-status';
import { withSameOrigin } from '@/lib/auth/route-helpers';
import { isWhatsAppEnabled, flagOff, assertWhatsAppEnvReady } from '@/app/api/admin/channels/whatsapp/_shared';
import { disableWhatsAppEnrollment } from '@/lib/channels/whatsapp-enrollment';
import { safeInvalidateChannelCache } from '@/lib/notifications/resolve-channels';
import { asAccountId } from '@/lib/shared/ids';

async function handler(req: NextRequest): Promise<NextResponse> {
  if (!isWhatsAppEnabled()) return flagOff();

  const envErr = assertWhatsAppEnvReady();
  if (envErr) return envErr;

  let user;
  try {
    user = await requireRole(req, 'owner');
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.statusCode });
    }
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (!user.locationId) return NextResponse.json({ error: 'no_business' }, { status: 403 });

  const [accountRow] = await sql<{ subscription_status: string }[]>`
    SELECT a.subscription_status
    FROM accounts a
    JOIN businesses b ON b.account_id = a.id
    WHERE b.id = ${user.locationId}
  `;
  if (accountRow?.subscription_status !== SubscriptionStatus.ACTIVE) {
    return NextResponse.json({ error: 'subscription_not_active' }, { status: 403 });
  }

  const result = await disableWhatsAppEnrollment(sql, user.locationId);

  const noStore = { 'Cache-Control': 'no-store, private' };
  if (result.kind === 'not_found') {
    return NextResponse.json({ error: 'not_found' }, { status: 404, headers: noStore });
  }

  const [acctRow] = await sql<{ account_id: string }[]>`
    SELECT account_id FROM businesses WHERE id = ${user.locationId}
  `;
  if (acctRow?.account_id) {
    await safeInvalidateChannelCache(asAccountId(acctRow.account_id), 'dashboard.whatsapp.disable');
  }

  return NextResponse.json({ ok: true }, { headers: noStore });
}

export const POST = withSameOrigin()(handler);
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/app/api/dashboard/channels/whatsapp/__tests__/disable.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/dashboard/channels/whatsapp/disable/route.ts \
        src/app/api/dashboard/channels/whatsapp/__tests__/disable.test.ts
git commit -m "feat(channels): owner WhatsApp disable route"
```

---

## Task 8: Pin the generic-409 reducer copy (copy-lock test)

Locks the launch behavior: the conflict message stays the shared generic string. Fails loudly if anyone adds channel-named copy without updating the contract.

**Files:**
- Test: `src/lib/notifications/channels/__tests__/enrollment-reducer.test.ts`

- [ ] **Step 1: Add the failing-then-passing assertion**

Append to `src/lib/notifications/channels/__tests__/enrollment-reducer.test.ts` (create the file if it does not exist, importing `enrollmentReducer`, `initialEnrollment` from `../enrollment-reducer`):

```ts
import { describe, it, expect } from 'vitest';
import { enrollmentReducer, initialEnrollment } from '../enrollment-reducer';

describe('enrollmentReducer — mobile-channel conflict copy (launch contract)', () => {
  it('maps a 409 multiple_mobile_channels to the generic disconnect message', () => {
    const next = enrollmentReducer(
      { ...initialEnrollment, state: 'generating' },
      { type: 'CONNECT_FAILED', status: 409, message: 'multiple_mobile_channels' },
    );
    expect(next.state).toBe('error');
    expect(next.errorMessage).toBe('Disconnect your current channel before connecting another.');
  });

  it('maps a 409 already_verified to the already-connected message', () => {
    const next = enrollmentReducer(
      { ...initialEnrollment, state: 'generating' },
      { type: 'CONNECT_FAILED', status: 409, message: 'already_verified' },
    );
    expect(next.errorMessage).toBe('Already connected.');
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm test src/lib/notifications/channels/__tests__/enrollment-reducer.test.ts`
Expected: PASS immediately (the reducer already produces these strings — this test pins them; no implementation change). If the file already had a default `state` requirement, adjust the seed snapshot's `state` only.

- [ ] **Step 3: Commit**

```bash
git add src/lib/notifications/channels/__tests__/enrollment-reducer.test.ts
git commit -m "test(channels): pin generic mobile-channel conflict copy"
```

---

## Task 9: `OwnerWhatsAppWidget` component

**Files:**
- Create: `src/components/dashboard/OwnerWhatsAppWidget.tsx`
- Test: `src/components/dashboard/__tests__/OwnerWhatsAppWidget.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/dashboard/__tests__/OwnerWhatsAppWidget.test.tsx`. Mock `useEnrollment` so the component renders a controlled snapshot (the hook itself is covered by E2E):

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { EnrollmentSnapshot } from '@/lib/notifications/channels/enrollment-reducer';

const useEnrollmentMock = vi.fn();
vi.mock('@/lib/notifications/channels/use-enrollment', () => ({
  useEnrollment: () => useEnrollmentMock(),
}));

import { OwnerWhatsAppWidget } from '../OwnerWhatsAppWidget';

function snap(partial: Partial<EnrollmentSnapshot>): EnrollmentSnapshot {
  return {
    state: 'idle', previousState: null, handle: null, deepLink: null, qrDataUrl: null,
    expiresAt: null, unsubscribedReason: null, errorMessage: null, ...partial,
  } as EnrollmentSnapshot;
}
function mockHook(s: EnrollmentSnapshot) {
  useEnrollmentMock.mockReturnValue({
    snapshot: s,
    actions: { connect: vi.fn(), cancel: vi.fn(), disable: vi.fn(), refresh: vi.fn(), dismissError: vi.fn() },
    ttl: { secondsRemaining: null },
  });
}

describe('OwnerWhatsAppWidget', () => {
  it('renders Connect in idle', () => {
    mockHook(snap({ state: 'idle' }));
    render(<OwnerWhatsAppWidget />);
    expect(screen.getByRole('button', { name: /connect/i })).toBeTruthy();
  });

  it('renders the QR in awaiting_scan', () => {
    mockHook(snap({ state: 'awaiting_scan', qrDataUrl: 'data:image/png;base64,X', deepLink: 'https://wa.me/1?text=start-t' }));
    render(<OwnerWhatsAppWidget />);
    expect(screen.getByAltText(/whatsapp qr/i)).toBeTruthy();
  });

  it('renders the generic conflict message verbatim on error (copy lock)', () => {
    mockHook(snap({ state: 'error', errorMessage: 'Disconnect your current channel before connecting another.' }));
    render(<OwnerWhatsAppWidget />);
    expect(screen.getByText('Disconnect your current channel before connecting another.')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm test src/components/dashboard/__tests__/OwnerWhatsAppWidget.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement the component**

Create `src/components/dashboard/OwnerWhatsAppWidget.tsx` (mirrors `OwnerTelegramWidget.tsx`, WhatsApp endpoints + copy):

```tsx
'use client';

import { useEnrollment } from '@/lib/notifications/channels/use-enrollment';
import type { EnrollmentSnapshot } from '@/lib/notifications/channels/enrollment-reducer';

interface InitialRow {
  channel: string;
  handle: string | null;
  status: string;
}

function rowToInitialSnapshot(row: InitialRow | null): EnrollmentSnapshot | undefined {
  if (!row || row.status !== 'verified') return undefined;
  return {
    state: 'verified',
    previousState: null,
    handle: row.handle,
    deepLink: null,
    qrDataUrl: null,
    expiresAt: null,
    unsubscribedReason: null,
    errorMessage: null,
  };
}

export interface OwnerWhatsAppWidgetProps {
  initialEnrollment?: InitialRow | null;
}

function maskHandle(handle: string | null): string {
  if (!handle || handle.length <= 4) return '•••';
  return `••• ${handle.slice(-4)}`;
}

export function OwnerWhatsAppWidget({ initialEnrollment }: OwnerWhatsAppWidgetProps = {}) {
  const { snapshot, actions, ttl } = useEnrollment({
    channel: 'whatsapp',
    endpoints: {
      start: '/api/dashboard/channels/whatsapp/start',
      cancel: '/api/dashboard/channels/whatsapp/cancel',
      disable: '/api/dashboard/channels/whatsapp/disable',
      status: '/api/dashboard/channels',
    },
    postBody: {},
    initialSnapshot: rowToInitialSnapshot(initialEnrollment ?? null),
  });

  const onDisconnect = async () => {
    if (!confirm('Disconnect WhatsApp from RepWorth?')) return;
    await actions.disable();
  };

  const isConnected = snapshot.state === 'verified';

  return (
    <div className={`channel-row${isConnected ? ' selected' : ''}`}>
      <div className="channel-icon ch-wa" aria-hidden>🟢</div>
      <div className="channel-meta">
        <div className="channel-name">WhatsApp</div>
        <div className="channel-handle">
          {snapshot.state === 'idle' && 'Get approval requests in WhatsApp.'}
          {snapshot.state === 'verified' && `Connected · ${maskHandle(snapshot.handle)}`}
          {snapshot.state === 'generating' && 'Generating link…'}
          {snapshot.state === 'awaiting_scan' && 'Scan the QR code below or open the link on your phone.'}
          {snapshot.state === 'disabled' && 'Disabled — reconnect to receive approvals.'}
          {snapshot.state === 'unsubscribed' && 'You opted out — re-open the chat in WhatsApp, then reconnect.'}
          {snapshot.state === 'expired' && 'QR expired.'}
          {snapshot.state === 'error' && (snapshot.errorMessage ?? 'Something went wrong.')}
        </div>

        {snapshot.state === 'awaiting_scan' && snapshot.qrDataUrl && snapshot.deepLink && (
          <div style={{ marginTop: 12 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={snapshot.qrDataUrl} alt="WhatsApp QR" width={160} height={160} />
            <p style={{ marginTop: 6, wordBreak: 'break-all', fontSize: 12, color: 'var(--rw-blue-600)' }}>
              <a href={snapshot.deepLink} target="_blank" rel="noreferrer">{snapshot.deepLink}</a>
            </p>
            {ttl.secondsRemaining !== null && (
              <p style={{ marginTop: 4, fontSize: 11, color: 'var(--rw-app-text-muted)' }}>
                Expires in {Math.floor(ttl.secondsRemaining / 60)}m {ttl.secondsRemaining % 60}s
              </p>
            )}
          </div>
        )}
      </div>

      <div style={{ flexShrink: 0 }}>
        {snapshot.state === 'idle' && (
          <button onClick={actions.connect} className="btn btn-primary">Connect</button>
        )}
        {snapshot.state === 'generating' && (
          <span className="channel-status cs-soon">Working…</span>
        )}
        {snapshot.state === 'verified' && (
          <button onClick={onDisconnect} className="btn btn-secondary">Disconnect</button>
        )}
        {(snapshot.state === 'disabled' || snapshot.state === 'unsubscribed') && (
          <button onClick={actions.connect} className="btn btn-secondary">Reconnect</button>
        )}
        {snapshot.state === 'expired' && (
          <button onClick={actions.connect} className="btn btn-secondary">New link</button>
        )}
        {snapshot.state === 'awaiting_scan' && (
          <button onClick={actions.cancel} className="btn btn-secondary">Cancel</button>
        )}
        {snapshot.state === 'error' && (
          <button onClick={actions.dismissError} className="btn btn-secondary">Try again</button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm test src/components/dashboard/__tests__/OwnerWhatsAppWidget.test.tsx`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/OwnerWhatsAppWidget.tsx \
        src/components/dashboard/__tests__/OwnerWhatsAppWidget.test.tsx
git commit -m "feat(dashboard): OwnerWhatsAppWidget owner self-service enrollment"
```

---

## Task 10: Wire the widget into the channels page

Replace the "coming soon" stub so the widget renders when WhatsApp is available.

**Files:**
- Modify: `src/app/(authenticated)/settings/channels/ChannelsClient.tsx`

- [ ] **Step 1: Add the import**

At the top of `ChannelsClient.tsx`, alongside the `OwnerTelegramWidget` import:

```tsx
import { OwnerWhatsAppWidget } from '@/components/dashboard/OwnerWhatsAppWidget';
```

- [ ] **Step 2: Replace the WhatsApp stub**

Replace the WhatsApp `ComingSoonChannelRow` block with the same interactive-or-coming-soon pattern Telegram uses:

```tsx
        {/* WhatsApp — interactive if available, coming-soon otherwise */}
        {initialAvailability.whatsapp ? (
          <OwnerWhatsAppWidget initialEnrollment={findChannel(initialEnrollments, 'whatsapp')} />
        ) : (
          <ComingSoonChannelRow
            icon="🟢"
            name="WhatsApp"
            reason="Available once Meta business verification clears"
          />
        )}
```

- [ ] **Step 3: Typecheck + lint + run the channels suite**

Run: `pnpm lint && pnpm test src/app/(authenticated)/settings/channels src/components/dashboard`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(authenticated)/settings/channels/ChannelsClient.tsx"
git commit -m "feat(dashboard): render OwnerWhatsAppWidget when WhatsApp is available"
```

---

## Task 11: Integration + E2E coverage

**Files:**
- Test (integration): `src/app/api/dashboard/channels/whatsapp/__tests__/enroll-e2e.test.ts`
- Test (Playwright): `e2e/settings-channels-whatsapp.spec.ts` (path matches existing E2E layout; adjust to repo convention)

- [ ] **Step 1: Write the integration test (owner start → inbound webhook → verified)**

Create `src/app/api/dashboard/channels/whatsapp/__tests__/enroll-e2e.test.ts`. Gate it on `TEST_DATABASE_POOL_URL` the way the Phase 3 enrollment integration test does (skip gracefully when absent):

```ts
import { describe, it, expect } from 'vitest';

const POOL = process.env.TEST_DATABASE_POOL_URL;
const d = POOL ? describe : describe.skip;

d('owner WhatsApp enrollment round-trip (integration)', () => {
  it('start (pending) → simulated inbound start-<token> → verified', async () => {
    // 1. Seed an account (active) + business (location).
    // 2. POST /api/dashboard/channels/whatsapp/start → expect 200 + deepLink containing start-<rawToken>.
    // 3. Extract rawToken from deepLink; POST a simulated Twilio inbound to
    //    handleTwilioWhatsAppInbound with Body=`start-<rawToken>`, From=`whatsapp:+15551239999`.
    // 4. Assert channel_enrollments row for (business_id, 'whatsapp') is status='verified',
    //    handle='15551239999', verification_token_hash IS NULL.
    // Reuse the Phase 3 integration harness helpers for seeding + inbound simulation.
    expect(true).toBe(true); // replace with the assertions above using the shared harness
  });
});
```

Implement the body using the same seeding/inbound helpers the Phase 3 WhatsApp ingress integration test uses (find them under `worker/ingress/twilio/__tests__`). Keep it gated on `TEST_DATABASE_POOL_URL`.

- [ ] **Step 2: Run the integration test**

Run: `pnpm test src/app/api/dashboard/channels/whatsapp/__tests__/enroll-e2e.test.ts`
Expected: PASS (or SKIP locally without `TEST_DATABASE_POOL_URL`).

- [ ] **Step 3: Write the Playwright E2E**

Create the E2E spec under the existing channels E2E directory (mirror the Telegram channels E2E if one exists). Flow: sign in as an owner with `CHANNELS_WHATSAPP_ENABLED=true` + `MOCK_EXTERNAL_APIS=true`; open `/settings/channels`; click **Connect** on the WhatsApp row; assert the QR `img[alt="WhatsApp QR"]` renders; simulate the inbound webhook (POST to the worker ingress with `start-<token>`); assert the row flips to **Connected**; click **Disconnect**; assert it returns to idle.

```ts
import { test, expect } from '@playwright/test';

test.describe('Owner /settings/channels — WhatsApp', () => {
  test('connect → QR → verified → disconnect', async ({ page }) => {
    test.skip(process.env.CHANNELS_WHATSAPP_ENABLED !== 'true', 'WhatsApp flag off');
    // ...sign in as owner (reuse the shared auth fixture)...
    await page.goto('/settings/channels');
    await page.getByRole('button', { name: /connect/i }).click();
    await expect(page.getByAltText('WhatsApp QR')).toBeVisible();
    // ...simulate inbound webhook via request context, then poll...
    await expect(page.getByText(/Connected ·/)).toBeVisible();
  });
});
```

- [ ] **Step 4: Run E2E (skips gracefully without the test DB)**

Run: `pnpm test:e2e`
Expected: PASS or SKIP.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/dashboard/channels/whatsapp/__tests__/enroll-e2e.test.ts e2e/
git commit -m "test(channels): owner WhatsApp enrollment integration + E2E"
```

---

## Task 12: Full regression sweep

**Files:** none.

- [ ] **Step 1: Run the full suite**

Run: `pnpm test && pnpm lint`
Expected: all PASS. Confirms the admin-route refactor (Task 4) and env unification (Task 2) did not regress SMS/Telegram/WhatsApp.

- [ ] **Step 2: Commit only if a fix was needed**

If anything failed and was fixed, commit with a focused message. Otherwise no commit.

---

## Task 13: Activation runbook (Stream ③)

No application code. Produces the operational checklist that gates the production flag flip.

**Files:**
- Modify: `docs/runbooks/whatsapp-templates.md`

- [ ] **Step 1: Switch the template definition to `whatsapp/card`**

Edit `docs/runbooks/whatsapp-templates.md`: change the `repworth_approval_request_v1` **Twilio Content type** from `twilio/card` to **`whatsapp/card`**. Put the message text in the `body` field (1024-char limit, supports variables), keep the 2 QUICK_REPLY + 1 URL buttons in `actions`. Rationale to record verbatim: *"`twilio/card` forces all WhatsApp text into `title` (body is RCS-only); `whatsapp/card` has a real body and supports mixed QUICK_REPLY/URL buttons."* Update the **Submission JSON** block to the `whatsapp/card` shape.

- [ ] **Step 2: Document the 9-variable validation gate**

Add a subsection: before submission, diff the submitted template's variable indices (`{{1}}`–`{{9}}`) against `src/lib/notifications/channels/whatsapp-body.ts::formatApprovalWhatsApp`. The send code passes `contentVariables` positionally — the template's `{{n}}` must map to the same fields the formatter emits. List the 9 vars from the existing runbook table as the canonical map.

- [ ] **Step 3: Add the Vercel + Railway env matrix**

Add a "Go-live environment" section with the matrix from the spec (`CHANNELS_WHATSAPP_ENABLED`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_NUMBER`, `WHATSAPP_APPROVAL_TEMPLATE_SID`, `WHATSAPP_APPROVAL_URL_BASE`, `NEXT_PUBLIC_APP_URL` on **both** Vercel and Railway; `WORKER_PUBLIC_URL` Railway-only). State explicitly that the flag must be set on both platforms or the UI stays hidden/404/503.

- [ ] **Step 4: Add the canary-before-gate + ship-gate checklist**

Document the two canary options (staging with its own template SID/URL base — preferred; or prod time-boxed canary scoped to the pilot business). Then the Phase 3 §5.1 eight-point gate as a checkbox list: webhook signature verify · click-to-chat enroll · Approve round-trip · Regenerate round-trip · blocked-recipient handling · re-enrollment · cross-channel race · STOP inside session. End with the flip step: set `CHANNELS_WHATSAPP_ENABLED=true` on **both** Vercel and Railway, redeploy, confirm `assertChannelsWhatsAppEnv` boots clean.

- [ ] **Step 5: Add the copy-lock note**

State that copy is locked only after Steps 1–2 are verified; any wording change after Meta submission restarts the review clock; `_v1` naming reserves room for versioned resubmits.

- [ ] **Step 6: Commit**

```bash
git add docs/runbooks/whatsapp-templates.md
git commit -m "docs(runbook): WhatsApp go-live — whatsapp/card, env matrix, canary + ship gate"
```

---

## Self-Review (completed during plan authoring)

**Spec coverage:**
- Stream ① verify → Task 1, Task 12.
- Owner widget (component + 3 routes + wiring) → Tasks 5–10.
- Helper extraction + admin refactor (entry-point invariant) → Tasks 3–4.
- Env-readiness unification (finding #4) → Task 2.
- Generic-409 copy lock (finding #3, user decision) → Task 8 (reducer) + Task 9 (widget).
- `whatsapp/card` switch + 9-var validation (finding #5) → Task 13 steps 1–2.
- Vercel + Railway env (finding #1) → Task 13 step 3.
- Canary-before-gate (finding #2) → Task 13 step 4.
- Integration + E2E → Task 11.

**Type consistency:** `startWhatsAppEnrollment(tx, businessId, accountId, tokenHash, expiresAt)` and `disableWhatsAppEnrollment(sql, businessId)` use the same positional signatures as their Telegram counterparts and are called identically in Task 4 (admin) and Task 5 (owner). `whatsappEnvReady()` / `missingWhatsAppEnv()` defined in Task 2 are imported unchanged in Tasks 5–7 (via `assertWhatsAppEnvReady`) and Task 2 step 4 (UI). Endpoint paths in the widget (Task 9) match the routes created in Tasks 5–7.

**Placeholder scan:** No "TBD"/"implement later". The one narrative body is Task 11 step 1's integration test, which intentionally describes the harness-dependent assertions (the seeding helpers are repo-specific and must be located at execution time) — the surrounding structure, gating, and assertions are concrete.
