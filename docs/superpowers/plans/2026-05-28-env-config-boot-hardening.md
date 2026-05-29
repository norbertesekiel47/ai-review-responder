# Env-var Documentation & Boot-Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Document, assert, and harden four notification/observability env vars (`CONTACT_NOTIFY_TO`, `LIST_UNSUBSCRIBE_EMAIL`, `ADMIN_NOTIFICATION_EMAIL`, `SENTRY_DSN`) so misconfiguration fails loud at boot instead of degrading silently — implements launch-ready-part1.md point 5.

**Architecture:** A single Next.js helper (`resolveContactNotifyTo`) owns the contact-recipient rule and removes the triplicated personal-Gmail fallback. Worker boot gets a hard assert for `ADMIN_NOTIFICATION_EMAIL` (production-only) and a non-fatal `warnMissingProductionEnv` for `LIST_UNSUBSCRIBE_EMAIL` + `SENTRY_DSN`. Next.js boot warns when `SENTRY_DSN` is unset. All asserts/warnings are gated to `NODE_ENV==='production'` (and non-mock) so dev/CI/tests never break.

**Tech Stack:** TypeScript (strict), Next.js 16 App Router (Vercel routes), Fastify/BullMQ worker (Railway), Vitest, Resend, Sentry.

---

## Context the implementer needs

- **Two runtimes.** `CONTACT_NOTIFY_TO` + Next.js `SENTRY_DSN` live in Vercel routes/instrumentation. `LIST_UNSUBSCRIBE_EMAIL`, `ADMIN_NOTIFICATION_EMAIL`, worker `SENTRY_DSN` live in the Railway worker.
- **House pattern** (`worker/config/startup-assert.ts`): required-var asserts throw at boot but early-return when `NODE_ENV !== 'production'` and/or `MOCK_EXTERNAL_APIS === 'true'`. Follow it exactly.
- **`assertWorkerStartupEnv()`** is the unconditional boot-assert group; it runs at import via `worker/config/startup-side-effect-guard.ts`. `warnMissingProductionEnv()` is non-fatal, so it is called from `worker/index.ts` `main()` (entry point orchestrates).
- **Validation caveat (CLAUDE.md):** this worktree is nested under `.claude/worktrees/`. Full `pnpm lint`/`pnpm test` can be poisoned by parent module resolution. Targeted `pnpm exec vitest run <file>` is fine for the RED/GREEN unit loop; **CI (push + read runner) is the authoritative gate.**
- **Logging:** routes already use `console.log/console.error`; the helper uses `console.warn`. Recipient/ops email addresses are not secrets/PII — safe to log. Never log review/response text, tokens, or secrets (not relevant here).
- **Do NOT** change the 3 per-site runtime `ADMIN_NOTIFICATION_EMAIL` guards (`AdminExceptionWorker`, `NotificationFailoverPoller` ×2, `EngagementAlertWorker`). The boot assert is added on top; runtime guards stay as defense-in-depth (keeps their tests green).

### Prep (once, before Task 1)

- [ ] Ensure the worktree has its own toolchain so targeted vitest runs locally:

```bash
cd /Users/norbertesekiel/Developer/startups/RepWorth/.claude/worktrees/feat+env-boot-hardening
pnpm install
```

Expected: install completes (a local `node_modules` now exists in the worktree).

---

## Task 1: `contact-notify` helper + export `extractMailbox`

Single owner of the "where do public contact/demo/lead emails go?" rule. TDD.

**Files:**
- Modify: `src/lib/notifications/email/headers.ts:19` (export `extractMailbox`)
- Create: `src/lib/notifications/contact-notify.ts`
- Test: `src/lib/notifications/__tests__/contact-notify.test.ts`

- [ ] **Step 1: Export `extractMailbox`**

In `src/lib/notifications/email/headers.ts`, change the function declaration (currently line 19) from:

```ts
function extractMailbox(fromEmail: string | undefined): string | null {
```

to:

```ts
export function extractMailbox(fromEmail: string | undefined): string | null {
```

(No other change to that function. It already handles `Display <addr>`, bare `addr`, and returns `null` otherwise.)

- [ ] **Step 2: Write the failing test**

Create `src/lib/notifications/__tests__/contact-notify.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveContactNotifyTo } from '../contact-notify';

describe('resolveContactNotifyTo', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = ['CONTACT_NOTIFY_TO', 'RESEND_FROM_EMAIL'];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (SNAP[k] === undefined) delete process.env[k]; else process.env[k] = SNAP[k];
    }
    warnSpy.mockRestore();
  });

  it('returns CONTACT_NOTIFY_TO when set, no warning', () => {
    process.env.CONTACT_NOTIFY_TO = 'leads@example.com';
    expect(resolveContactNotifyTo()).toEqual({ to: 'leads@example.com', source: 'env' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('trims CONTACT_NOTIFY_TO and ignores whitespace-only', () => {
    process.env.CONTACT_NOTIFY_TO = '  ops@example.com  ';
    expect(resolveContactNotifyTo()).toEqual({ to: 'ops@example.com', source: 'env' });
  });

  it('falls back to the RESEND_FROM_EMAIL mailbox (Display <addr> form) and warns', () => {
    process.env.RESEND_FROM_EMAIL = 'RepWorth <notifications@repworth.com>';
    expect(resolveContactNotifyTo()).toEqual({ to: 'notifications@repworth.com', source: 'from-email' });
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('falls back to the RESEND_FROM_EMAIL mailbox (bare addr form)', () => {
    process.env.RESEND_FROM_EMAIL = 'notifications@repworth.com';
    expect(resolveContactNotifyTo()).toEqual({ to: 'notifications@repworth.com', source: 'from-email' });
  });

  it('falls back to the default noreply mailbox when both unset, and warns', () => {
    expect(resolveContactNotifyTo()).toEqual({ to: 'noreply@repworth.com', source: 'default' });
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('uses the default when RESEND_FROM_EMAIL is unparseable', () => {
    process.env.RESEND_FROM_EMAIL = 'not-an-email';
    expect(resolveContactNotifyTo()).toEqual({ to: 'noreply@repworth.com', source: 'default' });
  });
});
```

- [ ] **Step 3: Run the test — expect FAIL**

Run: `pnpm exec vitest run src/lib/notifications/__tests__/contact-notify.test.ts`
Expected: FAIL — `Cannot find module '../contact-notify'`.

- [ ] **Step 4: Implement the helper**

Create `src/lib/notifications/contact-notify.ts`:

```ts
// src/lib/notifications/contact-notify.ts
//
// Single owner of the "where do public contact/demo/lead notification emails go?"
// rule. Replaces the personal-Gmail fallback that used to be duplicated across the
// contact, demo-request, and lead-intake routes.

import { extractMailbox } from './email/headers';

export type ContactNotifySource = 'env' | 'from-email' | 'default';

// Company sending-domain default. Matches the routes' RESEND_FROM_EMAIL `from`
// fallback so the notify recipient stays on an owned domain — never a personal
// inbox. Operators should set CONTACT_NOTIFY_TO in production.
const DEFAULT_NOTIFY_TO = 'noreply@repworth.com';

/**
 * Resolves the recipient for public contact/demo/lead notification emails.
 *
 * Order:
 *   1. CONTACT_NOTIFY_TO (explicit, trimmed, non-empty)
 *   2. mailbox parsed from RESEND_FROM_EMAIL (company sending domain)
 *   3. DEFAULT_NOTIFY_TO
 *
 * Emits one console.warn when falling back (source !== 'env') so a missing
 * CONTACT_NOTIFY_TO surfaces in production logs instead of silently mailing an
 * unintended address. Call volume is low (routes are rate-limited).
 */
export function resolveContactNotifyTo(): { to: string; source: ContactNotifySource } {
  const explicit = process.env.CONTACT_NOTIFY_TO?.trim();
  if (explicit) return { to: explicit, source: 'env' };

  const derived = extractMailbox(process.env.RESEND_FROM_EMAIL);
  const to = derived ?? DEFAULT_NOTIFY_TO;
  const source: ContactNotifySource = derived ? 'from-email' : 'default';

  console.warn(
    `[contact-notify] CONTACT_NOTIFY_TO is unset — falling back to ${
      source === 'from-email' ? 'the RESEND_FROM_EMAIL mailbox' : 'the default noreply mailbox'
    } (${to}). Set CONTACT_NOTIFY_TO so leads route to a monitored inbox.`,
  );
  return { to, source };
}
```

- [ ] **Step 5: Run the test — expect PASS**

Run: `pnpm exec vitest run src/lib/notifications/__tests__/contact-notify.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/notifications/email/headers.ts src/lib/notifications/contact-notify.ts src/lib/notifications/__tests__/contact-notify.test.ts
git commit -m "feat(notifications): single-owner contact-notify recipient resolver"
```

---

## Task 2: Wire the 3 routes to the helper; update route tests

Remove the personal-Gmail fallback from all three routes; update the two tests that asserted it.

**Files:**
- Modify: `src/app/api/contact/route.ts`
- Modify: `src/app/api/demo-request/route.ts`
- Modify: `src/app/api/lead-intake/route.ts`
- Test: `src/app/api/contact/__tests__/route.test.ts`
- Test: `src/app/api/demo-request/__tests__/route.test.ts`

- [ ] **Step 1: Update the contact route**

In `src/app/api/contact/route.ts`:

Delete line 8:
```ts
const NOTIFY_TO = process.env.CONTACT_NOTIFY_TO ?? 'norbertesekiel@gmail.com';
```

Add this import after the existing imports (after the `checkRateLimit` import on line 3):
```ts
import { resolveContactNotifyTo } from '@/lib/notifications/contact-notify';
```

Inside the `if (process.env.RESEND_API_KEY) {` block, just before the `const { error } = await resend.emails.send({` call, add:
```ts
    const { to } = resolveContactNotifyTo();
```

Change `to: NOTIFY_TO,` (in the `resend.emails.send` call) to:
```ts
      to,
```

- [ ] **Step 2: Update the demo-request route**

In `src/app/api/demo-request/route.ts`:

Delete line 8:
```ts
const NOTIFY_TO = process.env.CONTACT_NOTIFY_TO ?? 'norbertesekiel@gmail.com';
```

Add this import after the `checkRateLimit` import (line 3):
```ts
import { resolveContactNotifyTo } from '@/lib/notifications/contact-notify';
```

Inside the `if (process.env.RESEND_API_KEY) {` block, just before the `const { error } = await resend.emails.send({` call, add:
```ts
    const { to } = resolveContactNotifyTo();
```

Change `to: NOTIFY_TO,` (in the `resend.emails.send` call) to:
```ts
      to,
```

- [ ] **Step 3: Update the lead-intake route**

In `src/app/api/lead-intake/route.ts`:

Add this import near the top with the other imports:
```ts
import { resolveContactNotifyTo } from '@/lib/notifications/contact-notify';
```

Replace line 145:
```ts
  const to = process.env.CONTACT_NOTIFY_TO ?? 'norbertesekiel@gmail.com';
```
with:
```ts
  const { to } = resolveContactNotifyTo();
```

- [ ] **Step 4: Update the contact route test**

In `src/app/api/contact/__tests__/route.test.ts`:

In the `beforeEach` (around line 42), add a line so the test never inherits a leaked env value:
```ts
    delete process.env.CONTACT_NOTIFY_TO;
```

Change line 107:
```ts
    expect(callArg.to).toBe('norbertesekiel@gmail.com');
```
to:
```ts
    expect(callArg.to).toBe('noreply@repworth.com');
```

After the existing `it('sends email via Resend when RESEND_API_KEY is set', ...)` test, add a new test for the configured path:
```ts
  it('routes to CONTACT_NOTIFY_TO when it is set', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    process.env.RESEND_FROM_EMAIL = 'noreply@repworth.com';
    process.env.CONTACT_NOTIFY_TO = 'ops@repworth.com';
    mockResendSend.mockResolvedValue({ data: { id: 'msg-2' }, error: null });

    const { POST } = await import('../route');
    const req = makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const callArg = mockResendSend.mock.calls[0]?.[0] as Parameters<typeof mockResendSend>[0];
    expect(callArg.to).toBe('ops@repworth.com');
    delete process.env.CONTACT_NOTIFY_TO;
  });
```

- [ ] **Step 5: Update the demo-request test**

In `src/app/api/demo-request/__tests__/route.test.ts`, change line 76:
```ts
    expect(callArg.to).toBe('norbertesekiel@gmail.com');
```
to:
```ts
    expect(callArg.to).toBe('noreply@repworth.com');
```

(The `beforeEach` already deletes `CONTACT_NOTIFY_TO` and `RESEND_FROM_EMAIL`; the test sets `RESEND_FROM_EMAIL = 'noreply@repworth.com'`, so the resolver returns that mailbox.)

- [ ] **Step 6: Run the route + helper tests — expect PASS**

Run:
```bash
pnpm exec vitest run src/app/api/contact/__tests__/route.test.ts src/app/api/demo-request/__tests__/route.test.ts src/app/api/lead-intake/__tests__/route.test.ts
```
Expected: PASS (all three suites; contact suite has one new test).

- [ ] **Step 7: Confirm the personal Gmail is gone from runtime code**

Run: `rg -n "norbertesekiel@gmail.com" src/app`
Expected: no matches (only the unrelated docstring example in `src/lib/onboarding/admin-onboarding-service.ts` remains elsewhere — do not touch it).

- [ ] **Step 8: Commit**

```bash
git add src/app/api/contact src/app/api/demo-request src/app/api/lead-intake
git commit -m "fix(notifications): drop personal-Gmail fallback; route via contact-notify resolver"
```

---

## Task 3: Worker hard-assert for `ADMIN_NOTIFICATION_EMAIL`

Production boot fails fast when unset. TDD via the existing startup-assert test file.

**Files:**
- Modify: `worker/config/startup-assert.ts`
- Test: `worker/config/__tests__/startup-assertion.test.ts`

- [ ] **Step 1: Write the failing tests**

In `worker/config/__tests__/startup-assertion.test.ts`:

(a) Add `assertAdminNotificationEmail` to the top import block (currently lines 2–8):
```ts
import {
  assertAdminNotificationEmail,
  assertChannelsSmsEnv,
  assertProductionMockModeEnv,
  assertSelfServeSignupEnv,
  assertStripeWorkerEnv,
  assertWorkerStartupEnv,
} from '../startup-assert';
```

(b) Add a new describe block (place it right after the `assertStripeWorkerEnv` describe, before the `assertWorkerStartupEnv` describe):
```ts
describe('assertAdminNotificationEmail', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = ['NODE_ENV', 'MOCK_EXTERNAL_APIS', 'ADMIN_NOTIFICATION_EMAIL'];

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    restoreEnv(SNAP);
  });

  it('throws in production non-mock mode when unset', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    expect(() => assertAdminNotificationEmail()).toThrow(/ADMIN_NOTIFICATION_EMAIL/);
  });

  it('treats whitespace-only as missing in production', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    process.env.ADMIN_NOTIFICATION_EMAIL = '   ';
    expect(() => assertAdminNotificationEmail()).toThrow(/ADMIN_NOTIFICATION_EMAIL/);
  });

  it('passes in production when set', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@repworth.com';
    expect(() => assertAdminNotificationEmail()).not.toThrow();
  });

  it('is a no-op outside production even when unset', () => {
    setEnv('NODE_ENV', 'test');
    expect(() => assertAdminNotificationEmail()).not.toThrow();
  });

  it('is a no-op in production mock mode even when unset', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertAdminNotificationEmail()).not.toThrow();
  });
});
```

(c) Update the existing `assertWorkerStartupEnv` describe block so the new assert is satisfied:

Change its `KEYS` line (currently line 119) from:
```ts
  const KEYS = ['NODE_ENV', 'MOCK_EXTERNAL_APIS', ...STRIPE_WORKER_REQUIRED];
```
to:
```ts
  const KEYS = ['NODE_ENV', 'MOCK_EXTERNAL_APIS', 'ADMIN_NOTIFICATION_EMAIL', ...STRIPE_WORKER_REQUIRED];
```

In its `it('passes when production mock mode is off and Stripe env vars are present', ...)` test (currently lines 141–146), add the admin email before the assertion:
```ts
  it('passes when production mock mode is off and Stripe env vars are present', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    for (const k of STRIPE_WORKER_REQUIRED) process.env[k] = 'x';
    process.env.ADMIN_NOTIFICATION_EMAIL = 'admin@repworth.com';
    expect(() => assertWorkerStartupEnv()).not.toThrow();
  });
```

- [ ] **Step 2: Run the tests — expect FAIL**

Run: `pnpm exec vitest run worker/config/__tests__/startup-assertion.test.ts`
Expected: FAIL — `assertAdminNotificationEmail` is not exported (and the updated `assertWorkerStartupEnv` "passes" test fails until the function exists/wires in).

- [ ] **Step 3: Implement `assertAdminNotificationEmail` and wire it in**

In `worker/config/startup-assert.ts`, add this function (place it after `assertStripeWorkerEnv`, before `assertWorkerStartupEnv`):
```ts
/**
 * Boot-time assertion. ADMIN_NOTIFICATION_EMAIL is the recipient for every admin
 * exception / failover / engagement alert. When unset these alerts silently drop
 * (AdminExceptionWorker completes the outbox; NotificationFailoverPoller warns and
 * continues) — unacceptable in production. Fail fast at boot.
 *
 * Gated identically to assertProductionMockModeEnv: throws ONLY in production and
 * non-mock, so dev / CI / tests are unaffected. The per-site runtime guards remain
 * as defense-in-depth.
 */
export function assertAdminNotificationEmail(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return;
  const value = process.env.ADMIN_NOTIFICATION_EMAIL;
  if (!value || value.trim().length === 0) {
    throw new Error(
      '[startup] Worker requires ADMIN_NOTIFICATION_EMAIL in production (admin/failover/engagement alerts route here)',
    );
  }
}
```

Then add the call to `assertWorkerStartupEnv` (currently lines 39–42):
```ts
export function assertWorkerStartupEnv(): void {
  assertProductionMockModeEnv();
  assertStripeWorkerEnv();
  assertAdminNotificationEmail();
}
```

- [ ] **Step 4: Run the tests — expect PASS**

Run: `pnpm exec vitest run worker/config/__tests__/startup-assertion.test.ts`
Expected: PASS (existing suites + 5 new `assertAdminNotificationEmail` tests).

- [ ] **Step 5: Commit**

```bash
git add worker/config/startup-assert.ts worker/config/__tests__/startup-assertion.test.ts
git commit -m "feat(worker): hard-assert ADMIN_NOTIFICATION_EMAIL at boot in production"
```

---

## Task 4: Worker `warnMissingProductionEnv` (LIST_UNSUBSCRIBE_EMAIL + SENTRY_DSN)

Non-fatal boot warnings, wired into the entry point. TDD.

**Files:**
- Modify: `worker/config/startup-assert.ts`
- Modify: `worker/index.ts`
- Test: `worker/config/__tests__/startup-assertion.test.ts`

- [ ] **Step 1: Write the failing tests**

In `worker/config/__tests__/startup-assertion.test.ts`:

(a) Add `vi` to the vitest import on line 1:
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
```

(b) Add `warnMissingProductionEnv` to the top import block:
```ts
import {
  assertAdminNotificationEmail,
  assertChannelsSmsEnv,
  assertProductionMockModeEnv,
  assertSelfServeSignupEnv,
  assertStripeWorkerEnv,
  assertWorkerStartupEnv,
  warnMissingProductionEnv,
} from '../startup-assert';
```

(c) Add a new describe block (place it after the `assertAdminNotificationEmail` describe):
```ts
describe('warnMissingProductionEnv', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = ['NODE_ENV', 'MOCK_EXTERNAL_APIS', 'LIST_UNSUBSCRIBE_EMAIL', 'SENTRY_DSN'];
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    restoreEnv(SNAP);
    warnSpy.mockRestore();
  });

  it('warns for each unset var in production non-mock mode', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    warnMissingProductionEnv();
    const messages = warnSpy.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes('LIST_UNSUBSCRIBE_EMAIL'))).toBe(true);
    expect(messages.some((m) => m.includes('SENTRY_DSN'))).toBe(true);
  });

  it('is silent outside production', () => {
    setEnv('NODE_ENV', 'test');
    warnMissingProductionEnv();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('is silent in production mock mode', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'true';
    warnMissingProductionEnv();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does not warn for vars that are set', () => {
    setEnv('NODE_ENV', 'production');
    process.env.MOCK_EXTERNAL_APIS = 'false';
    process.env.LIST_UNSUBSCRIBE_EMAIL = 'unsubscribe@repworth.com';
    process.env.SENTRY_DSN = 'https://x@sentry.io/1';
    warnMissingProductionEnv();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests — expect FAIL**

Run: `pnpm exec vitest run worker/config/__tests__/startup-assertion.test.ts`
Expected: FAIL — `warnMissingProductionEnv` is not exported.

- [ ] **Step 3: Implement `warnMissingProductionEnv`**

In `worker/config/startup-assert.ts`, add (place it after `assertAdminNotificationEmail`):
```ts
/**
 * Boot-time warnings (non-fatal) for vars that degrade silently in production but
 * are not strictly required to boot:
 *   - LIST_UNSUBSCRIBE_EMAIL: marketing emails fall back to a non-functional
 *     mailbox and may fail Gmail/Outlook bulk-sender compliance.
 *   - SENTRY_DSN: Sentry no-ops, so production errors go untracked.
 *
 * Only warns in production (and non-mock) so dev / CI / tests stay quiet.
 */
export function warnMissingProductionEnv(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (process.env.MOCK_EXTERNAL_APIS === 'true') return;
  const checks: Array<{ key: string; message: string }> = [
    {
      key: 'LIST_UNSUBSCRIBE_EMAIL',
      message:
        'marketing emails will use a non-functional unsubscribe mailbox and may fail Gmail/Outlook bulk-sender compliance',
    },
    {
      key: 'SENTRY_DSN',
      message: 'Sentry is inert — production errors will not be tracked',
    },
  ];
  for (const { key, message } of checks) {
    const value = process.env[key];
    if (!value || value.trim().length === 0) {
      console.warn(`[startup] ${key} is unset — ${message}`);
    }
  }
}
```

- [ ] **Step 4: Run the tests — expect PASS**

Run: `pnpm exec vitest run worker/config/__tests__/startup-assertion.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the warning into the worker entry point**

In `worker/index.ts`:

Add `warnMissingProductionEnv` to the import from `./config/startup-assert` (currently line 33):
```ts
import { assertChannelsSmsEnv, assertChannelsTelegramEnv, assertChannelsWhatsAppEnv, assertSelfServeSignupEnv, assertZernioPublishingEnv, warnMissingProductionEnv } from './config/startup-assert';
```

In `main()`, inside the existing `try { ... }` startup block, add the call after `assertZernioPublishingEnv();` and before the `console.log(\`[worker] Feature flags: ...\`)` line:
```ts
    assertZernioPublishingEnv();
    warnMissingProductionEnv();
```

- [ ] **Step 6: Typecheck the worker entry point**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no new errors. (If the full typecheck is poisoned by the nested worktree, defer to CI — note it and continue.)

- [ ] **Step 7: Commit**

```bash
git add worker/config/startup-assert.ts worker/config/__tests__/startup-assertion.test.ts worker/index.ts
git commit -m "feat(worker): boot-warn on unset LIST_UNSUBSCRIBE_EMAIL / SENTRY_DSN in production"
```

---

## Task 5: Next.js `SENTRY_DSN`-unset boot warning

**Files:**
- Modify: `src/instrumentation.ts`

- [ ] **Step 1: Add the warning to `register()`**

In `src/instrumentation.ts`, inside the `if (process.env.NEXT_RUNTIME === 'nodejs') {` block, add the warning **before** the `Sentry.init({ ... })` call:
```ts
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    if (
      process.env.NODE_ENV === 'production' &&
      (!process.env.SENTRY_DSN || process.env.SENTRY_DSN.trim().length === 0)
    ) {
      console.warn(
        '[instrumentation] SENTRY_DSN is unset — Sentry is inert; production errors will not be tracked.',
      );
    }
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0.1,
      beforeSend(event) {
        return scrubSentryEvent(event, { scrubRequestData: true });
      },
    });
  }
```

(Leave the `edge` runtime block unchanged.)

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no new errors. (Defer to CI if poisoned.)

- [ ] **Step 3: Commit**

```bash
git add src/instrumentation.ts
git commit -m "feat(observability): warn at Next.js boot when SENTRY_DSN is unset in production"
```

---

## Task 6: Documentation & `.env.example`

Make the env vars documented and discoverable. One authoritative owner per fact.

**Files:**
- Modify: `.env.example`
- Modify: `.claude/reference/env-vars.md`
- Modify: `docs/launch-ready-part1.md`

- [ ] **Step 1: `.env.example` — add the two missing vars**

In `.env.example`, in the `# --- Notifications ---` section, immediately after the `ADMIN_NOTIFICATION_EMAIL=your-admin@email.com` line (line 40), insert:
```dotenv
# Recipient for public contact / demo-request / lead-intake notification emails.
# Falls back to the RESEND_FROM_EMAIL mailbox, then noreply@repworth.com, with a
# loud warning — set this in prod (Vercel) so leads reach a monitored inbox.
CONTACT_NOTIFY_TO=
# Mailbox advertised in the List-Unsubscribe header on marketing emails.
# Unset → falls back to the RESEND_FROM_EMAIL mailbox; if that is also unparseable,
# marketing emails fail Gmail/Outlook bulk-sender compliance. Set in prod (Railway).
LIST_UNSUBSCRIBE_EMAIL=
```

- [ ] **Step 2: `.claude/reference/env-vars.md` — remove the stale CONTACT_NOTIFY_TO row**

In `.claude/reference/env-vars.md`, in the `## Development / Testing` table, delete this row (currently line 50):
```markdown
| `CONTACT_NOTIFY_TO` | `norbertesekiel@gmail.com` | Overrides notification email for `/api/contact` submissions. |
```

- [ ] **Step 3: `.claude/reference/env-vars.md` — add a Notifications & Observability section**

Insert this new section immediately after the `## Development / Testing` table (before `## Feature Flags`):
```markdown
---

## Notifications, Deliverability & Observability

| Var | Platform | Required? | Notes |
|---|---|---|---|
| `CONTACT_NOTIFY_TO` | Vercel | Recommended (prod) | Recipient for `/api/contact`, `/api/demo-request`, `/api/lead-intake` notification emails. No personal default: resolves via `resolveContactNotifyTo()` (`src/lib/notifications/contact-notify.ts`) → `CONTACT_NOTIFY_TO` → `RESEND_FROM_EMAIL` mailbox → `noreply@repworth.com`, with a `console.warn` on fallback. |
| `ADMIN_NOTIFICATION_EMAIL` | Railway | **Yes (prod)** | Recipient for admin exception / failover / engagement alerts. Worker boot **hard-asserts** this in production (`assertAdminNotificationEmail` in `worker/config/startup-assert.ts`); the worker refuses to start without it. Per-site runtime guards remain as defense-in-depth. |
| `LIST_UNSUBSCRIBE_EMAIL` | Railway | Recommended (prod) | Mailbox in the marketing `List-Unsubscribe` header (`src/lib/notifications/email/headers.ts`). Unset → falls back to the `RESEND_FROM_EMAIL` mailbox; worker boot warns in production (`warnMissingProductionEnv`). Without a working mailbox, marketing emails fail Gmail/Outlook bulk-sender compliance. |
| `SENTRY_DSN` | Vercel + Railway | Recommended (prod) | Server-side Sentry DSN (`src/instrumentation.ts`, `worker/sentry.ts`). Unset → Sentry silently no-ops; both boots warn in production (`warnMissingProductionEnv` on the worker, `register()` on Next.js). |
| `NEXT_PUBLIC_SENTRY_DSN` | Vercel | Recommended (prod) | Browser-side Sentry DSN (same value as `SENTRY_DSN`). Intentionally public. |
```

- [ ] **Step 4: `docs/launch-ready-part1.md` — mark point 5 done**

In `docs/launch-ready-part1.md`, change line 170 from:
```markdown
5. Document + assert `CONTACT_NOTIFY_TO` and `LIST_UNSUBSCRIBE_EMAIL`; harden the `ADMIN_NOTIFICATION_EMAIL` silent-drop; add the `SENTRY_DSN`-unset boot warning.
```
to:
```markdown
5. ✅ **(done 2026-05-28, branch `feat/env-boot-hardening`)** Document + assert `CONTACT_NOTIFY_TO` and `LIST_UNSUBSCRIBE_EMAIL`; harden the `ADMIN_NOTIFICATION_EMAIL` silent-drop; add the `SENTRY_DSN`-unset boot warning. *Code/docs landed; production values still set at deploy.*
```

- [ ] **Step 5: Commit**

```bash
git add .env.example .claude/reference/env-vars.md docs/launch-ready-part1.md
git commit -m "docs(env): document CONTACT_NOTIFY_TO, LIST_UNSUBSCRIBE_EMAIL, ADMIN_NOTIFICATION_EMAIL, SENTRY_DSN"
```

---

## Task 7: Validate via CI (authoritative gate)

The nested worktree makes local full lint/test unreliable; CI is the source of truth.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin worktree-feat+env-boot-hardening
```

- [ ] **Step 2: Open a PR** (use `superpowers:finishing-a-development-branch` to drive this) targeting `main`. Direct pushes to `main` are blocked; CI runs `lint` / `typecheck` / `test` / `build`.

- [ ] **Step 3: Read the runner — expect all 4 checks green**

```bash
gh pr checks --watch
```
Expected: `lint`, `typecheck`, `test`, `build` all pass.

- [ ] **Step 4: If any check fails**, read the log (`gh run view --log-failed`), fix in the worktree, commit, push, re-check. Treat CI output as the verification of completion (per `superpowers:verification-before-completion`).

---

## Self-review notes (spec coverage)

- `CONTACT_NOTIFY_TO` documented (Task 6) + fallback hardened, personal Gmail removed (Tasks 1–2). ✓
- `LIST_UNSUBSCRIBE_EMAIL` documented (Task 6) + boot warn (Task 4). ✓
- `ADMIN_NOTIFICATION_EMAIL` silent-drop hardened via prod hard-assert (Task 3) + documented (Task 6); runtime guards untouched. ✓
- `SENTRY_DSN`-unset boot warning on worker (Task 4) + Next.js (Task 5) + documented (Task 6). ✓
- `.env.example` gains the two missing vars (Task 6). ✓
- Existing tests preserved: the only behavioral test changes are the two personal-Gmail assertions (Task 2) and the `assertWorkerStartupEnv` "passes" test (Task 3, now also sets `ADMIN_NOTIFICATION_EMAIL`). ✓
- Naming consistency: `resolveContactNotifyTo`, `ContactNotifySource`, `assertAdminNotificationEmail`, `warnMissingProductionEnv`, `extractMailbox` used identically across tasks. ✓
