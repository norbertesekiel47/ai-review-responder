# Launch-review follow-ups (#2–#7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the six actionable findings (#2–#7) from the PR #152–#158 review: surface unset `CONTACT_NOTIFY_TO`, document the worker boot prerequisite, harden two tests against false-green, route the three contact routes through the shared mailer, and trim `vercel.json`.

**Architecture:** Six independent changes landing as one PR. Notification routing is unified behind a single owner (`contact-notify.ts`) that delegates to the existing `sendInternalEmail()`. No DB/schema change.

**Tech Stack:** Next.js 16 (App Router routes), Vitest, Postgres.js, Resend, `@sentry/nextjs` (web) / `@sentry/node` (worker), pnpm.

**Spec:** `docs/superpowers/specs/2026-05-28-launch-review-followups-design.md`

> **Validation caveat (project CLAUDE.md):** This worktree is nested under `.claude/worktrees/`. Local lint/test can be poisoned by parent `node_modules`/eslintrc. Per-task `pnpm vitest run <file>` smoke checks usually work; the **authoritative gate is CI after push** (Task 8). CI on `main` is green (baseline).

---

### Task 1: #7 — Trim `vercel.json`

Removing `framework`/`buildCommand` (both Vercel auto-detects) eliminates the silent dashboard-override trap. Verified safe: `package.json` `"build": "next build"` (no pre/post/vercel-build), `pnpm-lock.yaml` present → Vercel auto-detects pnpm + `next build` = `pnpm build`. Nothing meaningful remains, so delete the file.

**Files:**
- Delete: `vercel.json`

- [ ] **Step 1: Confirm the build script is plain `next build`**

Run: `grep -n '"build"\|"prebuild"\|"postbuild"\|"vercel-build"' package.json`
Expected: only `"build": "next build"` (no other build hooks). If any other build hook exists, STOP — keep `vercel.json` with `buildCommand` and remove only `framework`; do not delete.

- [ ] **Step 2: Delete the file**

Run: `git rm vercel.json`

- [ ] **Step 3: Commit**

```bash
git commit -m "fix(deploy): remove vercel.json build override (#7)

framework + buildCommand are Vercel auto-detected defaults for a pnpm
Next.js project; the committed file silently overrode dashboard build
config. Nothing else remained, so the file is removed.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: #3 — Document the `ADMIN_NOTIFICATION_EMAIL` boot prerequisite

Docs only. The worker `process.exit(1)`s at boot if `ADMIN_NOTIFICATION_EMAIL` is unset in prod (`startup-assert.ts` via `startup-side-effect-guard`), and `railway.toml` `restartPolicyMaxRetries=10` won't self-heal a deterministic failure. The fail-fast is correct; only the runbook is missing the prerequisite.

**Files:**
- Modify: `docs/runbooks/rollback.md` (§3 Railway worker rollback)
- Modify: `railway.toml` (comment near restart policy)

- [ ] **Step 1: Add a boot-prerequisite note to rollback.md §3**

In `docs/runbooks/rollback.md`, after the "Notes:" bullet list in **## 3. Railway (worker) rollback** (after the line ending `…even if a downstream (Redis/Postgres) is briefly slow.`), insert:

```markdown

> **Boot prerequisite — set before deploying.** The worker asserts required env
> at boot and `process.exit(1)`s if any are missing in production
> (`worker/config/startup-assert.ts`). Because `railway.toml` caps restarts at
> `restartPolicyMaxRetries = 10`, a *missing* var is a deterministic failure
> Railway will **not** self-heal — the service exhausts its restarts and stays
> down, and the outbox stops draining. Confirm these are set in Railway **before**
> a deploy or rollback that ships this code:
> - `ADMIN_NOTIFICATION_EMAIL` — recipient for admin exception/failover/engagement
>   alerts (hard-required in prod).
> - Any channel/Stripe/self-serve var whose feature flag is ON (see
>   `worker/config/startup-assert.ts` and `.claude/reference/env-vars.md`).
> A missing *optional* var (`LIST_UNSUBSCRIBE_EMAIL`, `SENTRY_DSN`) only warns and
> does not block boot.
```

- [ ] **Step 2: Add a cross-ref comment in railway.toml**

In `railway.toml`, change the restart-policy block to add a comment line above `restartPolicyType`:

```toml
# Supervised crash recovery (matches Railway's default), not an infinite loop.
# NOTE: a missing required env var (e.g. ADMIN_NOTIFICATION_EMAIL) is a
# deterministic boot failure that exhausts these retries and stays down —
# see docs/runbooks/rollback.md §3 "Boot prerequisite".
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10
```

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/rollback.md railway.toml
git commit -m "docs(rollback): flag ADMIN_NOTIFICATION_EMAIL as a worker boot prerequisite (#3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: #2 — Surface unset `CONTACT_NOTIFY_TO` via Sentry (keep delivering)

When `CONTACT_NOTIFY_TO` is unset in prod, leads fall back to the no-reply mailbox. Make that loud: a tracked Sentry error in addition to the (easy-to-miss) `console.warn`. Delivery unchanged.

**Files:**
- Modify: `src/lib/notifications/contact-notify.ts`
- Test: `src/lib/notifications/__tests__/contact-notify.test.ts`
- Modify: `.claude/reference/env-vars.md` (line 57 — reflect Sentry)

- [ ] **Step 1: Add the failing Sentry assertions to the test**

At the TOP of `src/lib/notifications/__tests__/contact-notify.test.ts`, after the existing `import` lines, add the mock:

```typescript
const { mockCaptureMessage } = vi.hoisted(() => ({ mockCaptureMessage: vi.fn() }));
vi.mock('@sentry/nextjs', () => ({ captureMessage: mockCaptureMessage }));
```

In the `beforeEach`, after `warnSpy = vi.spyOn(...)`, add:

```typescript
    mockCaptureMessage.mockClear();
```

Then update three existing assertions:

In `it('returns CONTACT_NOTIFY_TO when set, no warning', ...)`, after the `expect(warnSpy).not.toHaveBeenCalled();` line add:
```typescript
    expect(mockCaptureMessage).not.toHaveBeenCalled();
```

In `it('falls back to the default noreply mailbox when both unset, and warns', ...)`, after `expect(warnSpy).toHaveBeenCalledOnce();` add:
```typescript
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'contact_notify_to_unset',
      expect.objectContaining({ level: 'error', extra: { resolvedTo: 'noreply@repworth.com', source: 'default' } }),
    );
```

In `it('resolves the fallback but does NOT warn outside production', ...)`, after `expect(warnSpy).not.toHaveBeenCalled();` add:
```typescript
    expect(mockCaptureMessage).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm vitest run src/lib/notifications/__tests__/contact-notify.test.ts`
Expected: FAIL — `mockCaptureMessage` was not called (captureMessage not yet wired).

- [ ] **Step 3: Wire Sentry into the fallback branch**

In `src/lib/notifications/contact-notify.ts`, add the import after the existing `import { extractMailbox } from './email/headers';`:

```typescript
import * as Sentry from '@sentry/nextjs';
```

Replace the `if (process.env.NODE_ENV === 'production') { console.warn(...) }` block with:

```typescript
  if (process.env.NODE_ENV === 'production') {
    Sentry.captureMessage('contact_notify_to_unset', {
      level: 'error',
      tags: { subsystem: 'contact-notify' },
      extra: { resolvedTo: to, source },
    });
    console.warn(
      `[contact-notify] CONTACT_NOTIFY_TO is unset — falling back to ${
        source === 'from-email' ? 'the RESEND_FROM_EMAIL mailbox' : 'the default noreply mailbox'
      } (${to}). Set CONTACT_NOTIFY_TO so leads route to a monitored inbox.`,
    );
  }
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm vitest run src/lib/notifications/__tests__/contact-notify.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Update env-vars.md to reflect Sentry**

In `.claude/reference/env-vars.md` line 57, change the trailing `…with a `console.warn` on fallback.` to:
`…with a Sentry error (`contact_notify_to_unset`) **and** `console.warn` on fallback.`

- [ ] **Step 6: Commit**

```bash
git add src/lib/notifications/contact-notify.ts src/lib/notifications/__tests__/contact-notify.test.ts .claude/reference/env-vars.md
git commit -m "fix(contact): raise a Sentry error when CONTACT_NOTIFY_TO is unset (#2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: #6a — Add the `notifyContactSubmission` wrapper

Single owner for sending public contact/demo/lead notifications through the shared `sendInternalEmail()` (mock-mode aware, lazy client, category headers). Owns the skip-when-unconfigured policy so a missing email config never 500s the public form.

**Files:**
- Modify: `src/lib/notifications/contact-notify.ts`
- Test: `src/lib/notifications/__tests__/contact-notify.test.ts`

- [ ] **Step 1: Write the failing wrapper tests**

In `src/lib/notifications/__tests__/contact-notify.test.ts`, add module mocks at the top (after the `@sentry/nextjs` mock from Task 3):

```typescript
const { mockSendInternalEmail, mockIsMockMode } = vi.hoisted(() => ({
  mockSendInternalEmail: vi.fn(),
  mockIsMockMode: vi.fn(() => false),
}));
vi.mock('../email/templates/internal', () => ({ sendInternalEmail: mockSendInternalEmail }));
vi.mock('@/lib/shared/mock-mode', () => ({ isMockMode: mockIsMockMode }));
```

Update the static import line to also pull in the new function:
```typescript
import { resolveContactNotifyTo, notifyContactSubmission } from '../contact-notify';
```

Add a new describe block at the end of the file:

```typescript
describe('notifyContactSubmission', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = ['NODE_ENV', 'CONTACT_NOTIFY_TO', 'RESEND_FROM_EMAIL', 'RESEND_API_KEY'];

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
    process.env.NODE_ENV = 'test';
    process.env.CONTACT_NOTIFY_TO = 'ops@example.com';
    mockSendInternalEmail.mockReset().mockResolvedValue({ messageId: 'ok' });
    mockIsMockMode.mockReset().mockReturnValue(false);
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (SNAP[k] === undefined) delete process.env[k]; else process.env[k] = SNAP[k];
    }
  });

  it('skips (sent:false) and does not send when RESEND_FROM_EMAIL is unset', async () => {
    process.env.RESEND_API_KEY = 'k';
    const r = await notifyContactSubmission({ subject: 'S', lines: ['a'] });
    expect(r).toEqual({ sent: false });
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('skips (sent:false) when not in mock mode and RESEND_API_KEY is unset', async () => {
    process.env.RESEND_FROM_EMAIL = 'notifications@repworth.com';
    const r = await notifyContactSubmission({ subject: 'S', lines: ['a'] });
    expect(r).toEqual({ sent: false });
    expect(mockSendInternalEmail).not.toHaveBeenCalled();
  });

  it('sends in mock mode without a real API key', async () => {
    process.env.RESEND_FROM_EMAIL = 'notifications@repworth.com';
    mockIsMockMode.mockReturnValue(true);
    const r = await notifyContactSubmission({ subject: 'S', lines: ['a'] });
    expect(r).toEqual({ sent: true });
    expect(mockSendInternalEmail).toHaveBeenCalledOnce();
  });

  it('delegates to sendInternalEmail with resolved recipient, internal category, escaped HTML body', async () => {
    process.env.RESEND_API_KEY = 'k';
    process.env.RESEND_FROM_EMAIL = 'notifications@repworth.com';
    await notifyContactSubmission({ subject: 'New lead', lines: ['Name: <Al & Co>', 'Email: a@b.com'] });
    expect(mockSendInternalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ops@example.com', subject: 'New lead', category: 'internal' }),
    );
    const arg = mockSendInternalEmail.mock.calls[0]![0] as { bodyHtml: string };
    expect(arg.bodyHtml).toContain('Name: &lt;Al &amp; Co&gt;');
    expect(arg.bodyHtml).toContain('Email: a@b.com');
  });

  it('propagates a send error so the caller can surface a 500', async () => {
    process.env.RESEND_API_KEY = 'k';
    process.env.RESEND_FROM_EMAIL = 'notifications@repworth.com';
    mockSendInternalEmail.mockRejectedValueOnce(new Error('resend down'));
    await expect(notifyContactSubmission({ subject: 'S', lines: ['a'] })).rejects.toThrow('resend down');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `pnpm vitest run src/lib/notifications/__tests__/contact-notify.test.ts`
Expected: FAIL — `notifyContactSubmission` is not exported.

- [ ] **Step 3: Implement the wrapper**

In `src/lib/notifications/contact-notify.ts`, add imports after the Sentry import:

```typescript
import { isMockMode } from '@/lib/shared/mock-mode';
import { sendInternalEmail } from './email/templates/internal';
```

At the end of the file, add:

```typescript
// Escapes the HTML metacharacters so user-supplied submission fields render
// literally in the notification email body.
function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// True when the notification email can actually be sent. sendInternalEmail
// throws without RESEND_FROM_EMAIL; outside mock mode it also needs a real
// RESEND_API_KEY. Mirrors the routes' previous best-effort guard (no key →
// skip, still 200) so a missing email config never 500s the public form.
function emailConfigured(): boolean {
  if (!process.env.RESEND_FROM_EMAIL) return false;
  return isMockMode() || Boolean(process.env.RESEND_API_KEY);
}

/**
 * Sends a public contact/demo/lead notification through the shared
 * sendInternalEmail path (mock-mode aware, lazy client, category headers).
 * Best-effort: returns { sent: false } when email isn't configured (no throw);
 * propagates a real send error so the caller can surface a 500.
 */
export async function notifyContactSubmission(params: {
  subject: string;
  lines: string[];
}): Promise<{ sent: boolean }> {
  if (!emailConfigured()) return { sent: false };
  const { to } = resolveContactNotifyTo();
  const bodyHtml = params.lines.map(escapeHtml).join('<br>\n');
  await sendInternalEmail({ to, subject: params.subject, bodyHtml, category: 'internal' });
  return { sent: true };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `pnpm vitest run src/lib/notifications/__tests__/contact-notify.test.ts`
Expected: PASS (resolveContactNotifyTo + notifyContactSubmission suites).

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/contact-notify.ts src/lib/notifications/__tests__/contact-notify.test.ts
git commit -m "feat(notifications): add notifyContactSubmission over sendInternalEmail (#6)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: #6b — Route the three contact routes through the wrapper

Remove raw `new Resend(...)` + the duplicated `from` literal from all three routes; call `notifyContactSubmission`. Map a thrown send error to 500. Update the three route tests to mock the wrapper instead of `resend`.

**Files:**
- Modify: `src/app/api/contact/route.ts`
- Modify: `src/app/api/demo-request/route.ts`
- Modify: `src/app/api/lead-intake/route.ts`
- Test: `src/app/api/contact/__tests__/route.test.ts`
- Test: `src/app/api/demo-request/__tests__/route.test.ts`
- Test: `src/app/api/lead-intake/__tests__/route.test.ts`

- [ ] **Step 1: Refactor `contact/route.ts`**

Replace lines 1–4 (imports) with:
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { notifyContactSubmission } from '@/lib/notifications/contact-notify';
```

Replace the whole `if (process.env.RESEND_API_KEY) { … }` block (and keep the final return) with:
```typescript
  try {
    await notifyContactSubmission({
      subject: 'New Demo Request — RepWorth',
      lines: [
        'New demo request — RepWorth',
        '',
        `Name:          ${submission.name}`,
        `Email:         ${submission.email}`,
        `Business:      ${submission.businessName}`,
        `Submitted at:  ${submission.timestamp}`,
      ],
    });
  } catch (err) {
    console.error('[contact] notification failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Failed to send notification' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
```

- [ ] **Step 2: Refactor `demo-request/route.ts`**

Replace lines 1–4 (imports) with:
```typescript
import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { notifyContactSubmission } from '@/lib/notifications/contact-notify';
```

Replace the whole `if (process.env.RESEND_API_KEY) { … }` block with:
```typescript
  try {
    await notifyContactSubmission({
      subject: 'New Demo Request — RepWorth',
      lines: [
        'New demo request — RepWorth',
        '',
        `Name:           ${submission.name}`,
        `Email:          ${submission.email}`,
        `Business:       ${submission.businessName}`,
        `Google Maps:    ${submission.googleMapsUrl || '(not provided)'}`,
        `Submitted at:   ${submission.timestamp}`,
      ],
    });
  } catch (err) {
    console.error('[demo-request] notification failed:', err instanceof Error ? err.message : err);
    return NextResponse.json({ error: 'Failed to send notification' }, { status: 500 });
  }

  return NextResponse.json({ success: true });
```

- [ ] **Step 3: Refactor `lead-intake/route.ts`**

Remove `import { Resend } from 'resend';` and `import { resolveContactNotifyTo } from '@/lib/notifications/contact-notify';`. Add:
```typescript
import { notifyContactSubmission } from '@/lib/notifications/contact-notify';
```

Replace the entire `sendLeadNotification` function with:
```typescript
// Best-effort founder notification. notifyContactSubmission skips (no throw)
// when email is unconfigured; a real send failure is surfaced as 500.
async function sendLeadNotification(lead: ValidatedLead, submittedAt: string): Promise<NextResponse> {
  try {
    await notifyContactSubmission({
      subject: `New owner lead - ${lead.intent} - RepWorth`,
      lines: [
        `Name: ${lead.name}`,
        `Email: ${lead.email}`,
        `Business: ${lead.businessName}`,
        `Intent: ${lead.intent}`,
        `Source: ${lead.source}`,
        `Google Maps: ${lead.googleMapsUrl || '(not provided)'}`,
        `Submitted at: ${submittedAt}`,
      ],
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[lead-intake] notification failed:', error instanceof Error ? error.message : error);
    return jsonError('Failed to send notification', 500);
  }
}
```

- [ ] **Step 4: Rewrite `contact/__tests__/route.test.ts` send-path tests**

Replace the `vi.hoisted` + `vi.mock('resend', …)` block (lines 6–15) with:
```typescript
const { mockNotify, mockCheckRateLimit } = vi.hoisted(() => ({
  mockNotify: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock('@/lib/notifications/contact-notify', () => ({
  notifyContactSubmission: mockNotify,
}));
```

In `beforeEach`, replace the `delete process.env.*` + `mockCheckRateLimit.mockResolvedValue(...)` body with:
```typescript
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9 });
    mockNotify.mockResolvedValue({ sent: true });
```

Delete the three tests `returns 200 without sending email when RESEND_API_KEY is unset`, `sends email via Resend when RESEND_API_KEY is set`, and `routes to CONTACT_NOTIFY_TO when it is set`. Replace them with:
```typescript
  it('calls notifyContactSubmission with the submission and returns 200', async () => {
    const { POST } = await import('../route');
    const req = makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme' });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(mockNotify).toHaveBeenCalledOnce();
    const arg = mockNotify.mock.calls[0]![0] as { subject: string; lines: string[] };
    expect(arg.subject).toContain('Demo Request');
    const body = arg.lines.join('\n');
    expect(body).toContain('Alice');
    expect(body).toContain('a@b.com');
    expect(body).toContain('Acme');
  });
```

Replace the body of `returns 500 when Resend throws` with:
```typescript
    mockNotify.mockRejectedValueOnce(new Error('send failed'));
    const { POST } = await import('../route');
    const req = makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme' });
    const res = await POST(req);
    expect(res.status).toBe(500);
```

- [ ] **Step 5: Rewrite `demo-request/__tests__/route.test.ts` send-path tests**

Replace the `vi.hoisted` + `vi.mock('resend', …)` block (lines 4–13) with:
```typescript
const { mockNotify, mockCheckRateLimit } = vi.hoisted(() => ({
  mockNotify: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock('@/lib/notifications/contact-notify', () => ({
  notifyContactSubmission: mockNotify,
}));
```

In `beforeEach`, replace its body with:
```typescript
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
    mockNotify.mockResolvedValue({ sent: true });
```

Delete `returns 200 without email when RESEND_API_KEY is unset` and `sends email with googleMapsUrl when RESEND_API_KEY is set`. Replace with:
```typescript
  it('notifies with the submission incl. googleMapsUrl and returns 200', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({
      name: 'Alice', email: 'a@b.com', businessName: 'Acme',
      googleMapsUrl: 'https://maps.google.com/?cid=123',
    }));
    expect(res.status).toBe(200);
    expect(mockNotify).toHaveBeenCalledOnce();
    const arg = mockNotify.mock.calls[0]![0] as { subject: string; lines: string[] };
    expect(arg.subject).toContain('Demo Request');
    const body = arg.lines.join('\n');
    expect(body).toContain('Alice');
    expect(body).toContain('https://maps.google.com/?cid=123');
  });
```

Replace the body of `returns 500 when Resend returns error` with:
```typescript
    mockNotify.mockRejectedValueOnce(new Error('send failed'));
    const { POST } = await import('../route');
    const res = await POST(makeRequest({ name: 'Alice', email: 'a@b.com', businessName: 'Acme', googleMapsUrl: '' }));
    expect(res.status).toBe(500);
```

(The validation/429/https tests stay unchanged — `notifyContactSubmission` is never reached on those paths.)

- [ ] **Step 6: Rewrite `lead-intake/__tests__/route.test.ts` email tests**

Remove `mockResendSend` from the `vi.hoisted(...)` object and delete the `vi.mock('resend', …)` block (lines 47–51). Add after the `@/lib/db/server` mock:
```typescript
const { mockNotify } = vi.hoisted(() => ({ mockNotify: vi.fn() }));
vi.mock('@/lib/notifications/contact-notify', () => ({ notifyContactSubmission: mockNotify }));
```
(Add `mockNotify` is declared separately above; leave `mockResendSend` out of the hoisted destructure entirely.)

In `beforeEach`, remove the `mockResendSend.mockResolvedValue(...)` line and add:
```typescript
    mockNotify.mockResolvedValue({ sent: true });
```

Replace `it('sends a Resend email after persistence and uses CONTACT_NOTIFY_TO', …)` with:
```typescript
  it('notifies after persistence with the lead details', async () => {
    const { POST } = await import('../route');
    const res = await POST(makeRequest({
      name: 'Alice Owner',
      email: 'owner@example.com',
      businessName: 'Alice Bakery',
      googleMapsUrl: 'https://maps.google.com/?cid=123',
      source: 'landing',
    }));

    expect(res.status).toBe(200);
    expect(dbState.calls).toHaveLength(1);
    expect(mockNotify).toHaveBeenCalledOnce();
    expect(firstInvocationOrder(mockNotify)).toBeGreaterThan(firstInvocationOrder(mockSql));

    const arg = mockNotify.mock.calls[0]![0] as { subject: string; lines: string[] };
    expect(arg.subject).toBe('New owner lead - waitlist - RepWorth');
    const body = arg.lines.join('\n');
    expect(body).toContain('Name: Alice Owner');
    expect(body).toContain('Email: owner@example.com');
    expect(body).toContain('Business: Alice Bakery');
    expect(body).toContain('Intent: waitlist');
    expect(body).toContain('Source: landing');
    expect(body).toContain('Google Maps: https://maps.google.com/?cid=123');
    expect(body).toContain('Submitted at:');
  });
```

In `it('returns 500 on database failure and skips email', …)` replace the final email assertion `expect(mockResendSend).not.toHaveBeenCalled();` with:
```typescript
    expect(mockNotify).not.toHaveBeenCalled();
```

Delete `it('returns 500 when Resend returns an error after persistence', …)` and replace `it('returns 500 when Resend rejects after persistence', …)` with:
```typescript
  it('returns 500 when notification fails after persistence', async () => {
    mockNotify.mockRejectedValueOnce(new Error('send failed'));

    const { POST } = await import('../route');
    const res = await POST(makeRequest({
      name: 'Alice Owner',
      email: 'owner@example.com',
      businessName: 'Alice Bakery',
    }));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to send notification');
    expect(dbState.calls).toHaveLength(1);
    expect(mockNotify).toHaveBeenCalledOnce();
  });
```

- [ ] **Step 7: Run all affected tests, verify they pass**

Run:
```bash
pnpm vitest run \
  src/app/api/contact/__tests__/route.test.ts \
  src/app/api/demo-request/__tests__/route.test.ts \
  src/app/api/lead-intake/__tests__/route.test.ts \
  src/lib/notifications/__tests__/contact-notify.test.ts
```
Expected: PASS, all four files.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/contact src/app/api/demo-request src/app/api/lead-intake
git commit -m "refactor(contact): route contact/demo/lead through notifyContactSubmission (#6)

Removes raw Resend usage + duplicated from-fallback; honors MOCK_EXTERNAL_APIS.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: #4 — Harden the `bounced-skip` test against a false skip

For the three summary workers, a fragment-drift `[]` business-load takes the business-not-found early return — which also sends no email + completes the outbox — so the assertions pass green without exercising the bounce branch. Add a positive assertion that the business-load query (with its fragment) was actually issued, proving the fixture was returned and the bounce branch ran.

**Files:**
- Test: `worker/jobs/notification/__tests__/bounced-skip.test.ts`

- [ ] **Step 1: Add a `queryIssued` helper**

In `worker/jobs/notification/__tests__/bounced-skip.test.ts`, after the `function resetFixtures()` definition, add:

```typescript
// True if any sql() call's normalized text contained the fragment — i.e. the
// worker's business-load SELECT still matches the content-addressed fixture and
// returned the bounced business (so the bounce branch ran, not business-not-found).
function queryIssued(fragment: string): boolean {
  return mockSql.mock.calls.some((c: unknown[]) => {
    const t = (((c[0] as TemplateStringsArray) ?? []).join(' ')).replace(/\s+/g, ' ').trim();
    return t.includes(fragment);
  });
}
```

- [ ] **Step 2: Add the positive assertion to each case**

In the NotificationWorker test, after `expect(mockMarkOutboxCompleted).toHaveBeenCalledWith('out-1', undefined);`, add:
```typescript
    expect(queryIssued(Q_NOTIFICATION_BUSINESS)).toBe(true);
```

In the WeeklySummaryWorker test, after the `markOutboxCompleted` assertion, add:
```typescript
    expect(queryIssued(Q_SUMMARY_BUSINESS)).toBe(true);
```

In the MonthlyImpactWorker test, after the `markOutboxCompleted` assertion, add:
```typescript
    expect(queryIssued(Q_SUMMARY_BUSINESS)).toBe(true);
```

In the OnboardingDripWorker test, after the `markOutboxCompleted` assertion, add:
```typescript
    expect(queryIssued(Q_DRIP_BUSINESS)).toBe(true);
```

- [ ] **Step 3: Run the test, verify it passes against current (correct) code**

Run: `pnpm vitest run worker/jobs/notification/__tests__/bounced-skip.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 4: Prove the assertion bites (mutation check, then revert)**

Temporarily edit `Q_SUMMARY_BUSINESS` to a string that won't match (e.g. append `_XX`). Run the test.
Expected: the Weekly + Monthly tests now FAIL on `queryIssued(...) === true` (proving drift is now caught loudly).
Then revert the edit and re-run — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/notification/__tests__/bounced-skip.test.ts
git commit -m "test(notification): assert bounce branch is reached, not a silent not-found skip (#4)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: #5 — Pin the `OutboxPoller` optimistic-lock guard in tests

The dispatched-update assertion only matched `status = 'dispatched'`, so dropping the `WHERE status='dispatching' AND attempts=…` optimistic lock would still pass. The attempt-guard tests didn't assert absence of the opposite branch.

**Files:**
- Test: `worker/background/pollers/__tests__/OutboxPoller.test.ts`

- [ ] **Step 1: Strengthen the dispatched-update assertion**

In `worker/background/pollers/__tests__/OutboxPoller.test.ts`, in `it('dispatches a claimed pending row to its queue and marks it dispatched', …)`, replace:
```typescript
    const dispatchedUpdate = findSql(mockSql.mock.calls, "status = 'dispatched'");
    expect(dispatchedUpdate).toBeDefined();
```
with:
```typescript
    // Pin the optimistic-lock guard: the dispatched update must scope to the
    // claimed row's dispatching state + attempt, not blindly set 'dispatched'.
    const dispatchedUpdate = findSql(
      mockSql.mock.calls,
      "status = 'dispatched'",
      "status = 'dispatching'",
      'attempts =',
    );
    expect(dispatchedUpdate).toBeDefined();
```

- [ ] **Step 2: Add mutual-exclusion to the attempt-guard tests**

In `it('resets the row to pending when enqueue fails and attempts remain', …)`, after `expect(pendingReset).toBeDefined();` add:
```typescript
    // …and must NOT also dead-letter the row.
    expect(findSql(mockSql.mock.calls, "status = 'failed'", 'last_error')).toBeUndefined();
```

In `it('dead-letters the row to failed when enqueue fails and attempts are exhausted', …)`, after `expect(failedUpdate).toBeDefined();` add:
```typescript
    // …and must NOT also reset the row to pending.
    expect(findSql(mockSql.mock.calls, "status = 'pending'", 'last_error')).toBeUndefined();
```

- [ ] **Step 3: Run the test, verify it passes against current (correct) code**

Run: `pnpm vitest run worker/background/pollers/__tests__/OutboxPoller.test.ts`
Expected: PASS (all tests).

- [ ] **Step 4: Prove it bites (mutation check, then revert)**

Temporarily edit `OutboxPoller.ts` line ~176 to drop the dispatched update's `AND status = 'dispatching'\n AND attempts = ${entry.attempts}` guard. Run the test.
Expected: the `marks it dispatched` test now FAILS. Revert and re-run — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/background/pollers/__tests__/OutboxPoller.test.ts
git commit -m "test(outbox): assert dispatch optimistic-lock guard + attempt-guard exclusivity (#5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Full verification & PR

- [ ] **Step 1: Push the branch and let CI run the authoritative gate**

```bash
git push -u origin worktree-fix+launch-review-followups
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --title "fix: launch-review follow-ups (#2–#7)" --body "$(cat <<'EOF'
Implements findings #2–#7 from the PR #152–#158 review (spec:
docs/superpowers/specs/2026-05-28-launch-review-followups-design.md).

- #2 Sentry error when CONTACT_NOTIFY_TO is unset (keeps delivering)
- #3 document ADMIN_NOTIFICATION_EMAIL worker boot prerequisite (rollback.md + railway.toml)
- #4 bounced-skip test asserts the bounce branch was reached
- #5 OutboxPoller test pins the dispatch optimistic-lock guard + attempt-guard exclusivity
- #6 contact/demo/lead routes go through notifyContactSubmission (mock-mode aware, single from-owner)
- #7 remove vercel.json build override (auto-detected defaults)

Finding #1 (founders base_price_cents) was already merged as #157 — out of scope.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Confirm all four CI checks (lint, typecheck, test, build) are green**

Run: `gh pr checks --watch`
Expected: lint / typecheck / test / build all pass. If lint/test surface module-resolution oddities that don't reproduce in CI, trust CI (nested-worktree caveat). Fix any real failures and re-push.

---

## Self-Review

**Spec coverage:** #2 → Task 3; #3 → Task 2; #4 → Task 6; #5 → Task 7; #6 → Tasks 4–5; #7 → Task 1. All six covered. Out-of-scope items (#1, minor bundle) excluded as specified.

**Placeholder scan:** No TBD/TODO. Every code step shows full code; the two "mutation check" steps describe a concrete temporary edit + revert.

**Type consistency:** `notifyContactSubmission({ subject, lines })` signature and `{ sent: boolean }` return are consistent across Task 4 (def), Task 5 (callers), and tests. `sendInternalEmail` param shape (`{ to, subject, bodyHtml, category }`) matches `internal.ts`. `queryIssued`/`findSql` helper names consistent within their test files.
