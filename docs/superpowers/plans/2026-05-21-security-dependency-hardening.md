# Security and Dependency Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the approved security and dependency hardening sequence as six small, reviewable PRs without changing supported `owner` or `admin` behavior.

**Architecture:** This is a master plan split into six independent PR tasks. Each task starts from current `main`, makes one bounded change, adds focused tests first, validates, commits, and stops for review before the next task. The implementation favors existing helpers and route patterns over broad rewrites.

**Tech Stack:** Next.js App Router route handlers, Supabase Auth, PostgreSQL via `postgres`, Vitest, pnpm, Fastify worker, BullMQ, Stripe, Zernio.

---

## Scope Check

The approved spec covers six independent hardening PRs. Keep them as separate branches and PRs:

1. `hardening/remove-sales-partner-runtime-access`
2. `hardening/same-origin-mutations`
3. `hardening/public-response-sanitizer`
4. `hardening/worker-env-startup-safety`
5. `chore/runtime-metadata`
6. `chore/dependency-supply-chain`

Do not combine dependency upgrades with behavior changes.

## File Map

### PR 1: Remove `sales_partner` Runtime Access

- Modify: `src/middleware.ts`
- Modify: `src/app/admin/login/page.tsx`
- Modify: `src/app/api/auth/callback/route.ts`
- Modify: `src/components/auth/shared/mapLoginError.ts`
- Modify: `src/components/auth/__tests__/LoginFormClient.test.tsx`
- Modify: `src/components/auth/shared/__tests__/mapLoginError.test.ts`
- Modify: `src/app/api/auth/__tests__/callback.test.ts`
- Modify: `src/__tests__/middleware.test.ts`
- Modify admin route files that currently pass `sales_partner` to `requireRole`
- Modify admin page comments under `src/app/admin/**/page.tsx` and `src/app/admin/layout.tsx`
- Modify: `worker/jobs/OnboardingDripWorker.ts`
- Modify relevant tests under `worker/jobs/__tests__/`

### PR 2: Same-Origin Mutation Enforcement

- Modify: `src/lib/shared/csrf.ts`
- Modify: `src/lib/shared/__tests__/csrf.test.ts`
- Modify: `src/lib/auth/route-helpers.ts`
- Modify: `src/lib/auth/__tests__/route-helpers.test.ts`
- Modify representative owner/admin mutation routes and route-family tests:
  - `src/app/api/settings/route.ts`
  - `src/app/api/settings/voice/route.ts`
  - `src/app/api/settings/channels/override/route.ts`
  - `src/app/api/dashboard/reviews/[reviewId]/approve/route.ts`
  - `src/app/api/dashboard/reviews/[reviewId]/edit/route.ts`
  - `src/app/api/dashboard/reviews/[reviewId]/regenerate/route.ts`
  - `src/app/api/billing/checkout/route.ts`
  - `src/app/api/billing/portal/route.ts`
  - `src/app/api/billing/tier-change/route.ts`
  - `src/lib/locations/owner-route.ts`
  - mutation routes under `src/app/api/admin/**`

### PR 3: Public Response Text Sanitization

- Modify: `src/lib/shared/sanitize.ts`
- Modify: `src/lib/shared/__tests__/sanitize.test.ts`
- Modify: `src/app/api/approve/[token]/edit/route.ts`
- Modify: `src/app/api/dashboard/reviews/[reviewId]/edit/route.ts`
- Modify: `src/lib/approval/token-mode.ts`
- Modify: `src/lib/approval/session-mode.ts`
- Modify: `src/lib/approval/__tests__/service.test.ts`
- Modify: `src/app/api/dashboard/reviews/__tests__/actions.test.ts`

### PR 4: Worker Startup and Env Safety

- Modify: `worker/config/startup-assert.ts`
- Modify: `worker/config/__tests__/startup-assertion.test.ts`
- Modify: `worker/index.ts`

### PR 5a: Runtime Metadata

- Modify: `package.json`

### PR 5b: Dependency Supply Chain

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify only framework-fallout files required by validation.

---

## Task 0: Execution Setup

**Files:**
- Read: `docs/superpowers/specs/2026-05-21-security-dependency-hardening-design.md`
- Read: this plan

- [ ] **Step 1: Start from a clean main**

Run:

```bash
git status --short
git checkout main
git pull --ff-only
```

Expected: clean status or only user-owned unrelated files. Do not revert user-owned changes.

- [ ] **Step 2: Use one branch per PR**

Create the first branch:

```bash
git checkout -b hardening/remove-sales-partner-runtime-access
```

Expected: branch created from current `main`.

---

## Task 1: Remove `sales_partner` Runtime Access

**Files:**
- Modify: `src/middleware.ts`
- Modify: `src/app/admin/login/page.tsx`
- Modify: `src/app/api/auth/callback/route.ts`
- Modify: `src/components/auth/shared/mapLoginError.ts`
- Modify: `src/components/auth/__tests__/LoginFormClient.test.tsx`
- Modify: `src/components/auth/shared/__tests__/mapLoginError.test.ts`
- Modify: `src/app/api/auth/__tests__/callback.test.ts`
- Modify: `src/__tests__/middleware.test.ts`
- Modify all `src/app/api/admin/**/route.ts` files that currently call `requireRole(..., 'admin', 'sales_partner')`
- Modify: `worker/jobs/OnboardingDripWorker.ts`

- [ ] **Step 1: Write failing auth callback and login error tests**

In `src/app/api/auth/__tests__/callback.test.ts`, replace the current `sales_partner` success test with:

```ts
it('signs out and redirects sales_partner to /admin/login?error=unsupported_role', async () => {
  mockSingle.mockResolvedValueOnce({
    data: { role: 'sales_partner' },
    error: null,
  });

  const res = await GET(mkReq(buildUrl({ code: 'valid-code', flow: 'admin' })));

  expect(mockSignOut).toHaveBeenCalledOnce();
  expect(res.headers.get('Location')).toBe(
    'https://app.example.com/admin/login?error=unsupported_role',
  );
});
```

In `src/components/auth/shared/__tests__/mapLoginError.test.ts`, add:

```ts
it('maps unsupported_role', () => {
  expect(mapInitialQueryError('unsupported_role')).toMatch(/no longer supported/);
});
```

In `src/components/auth/__tests__/LoginFormClient.test.tsx`, change the admin render test prop from:

```ts
allowedRoles: ['admin', 'sales_partner'] as const,
```

to:

```ts
allowedRoles: ['admin'] as const,
```

- [ ] **Step 2: Run the auth tests and verify they fail**

Run:

```bash
pnpm exec vitest run src/app/api/auth/__tests__/callback.test.ts src/components/auth/shared/__tests__/mapLoginError.test.ts src/components/auth/__tests__/LoginFormClient.test.tsx
```

Expected: failures showing `sales_partner` still redirects to admin and `unsupported_role` is unmapped.

- [ ] **Step 3: Implement callback/login behavior**

In `src/components/auth/shared/mapLoginError.ts`, make the function:

```ts
export function mapInitialQueryError(errorParam: string | null | undefined): string {
  if (errorParam === 'account_incomplete') {
    return 'Your account is not set up yet. Contact your administrator.';
  }
  if (errorParam === 'unsupported_role') {
    return 'This account role is no longer supported. Contact your administrator.';
  }
  if (errorParam === 'auth_callback_failed') {
    return 'Sign-in failed. Please try again.';
  }
  return '';
}
```

In `src/app/admin/login/page.tsx`, change:

```tsx
allowedRoles={['admin', 'sales_partner']}
```

to:

```tsx
allowedRoles={['admin']}
```

In `src/app/api/auth/callback/route.ts`, replace:

```ts
} else if (role === 'admin' || role === 'sales_partner') {
  destination = nextIsAdmin ? requestedNext : '/admin/overview';
} else {
```

with:

```ts
} else if (role === 'admin') {
  destination = nextIsAdmin ? requestedNext : '/admin/overview';
} else if (role === 'sales_partner') {
  await supabase.auth.signOut();
  const unsupported = NextResponse.redirect(
    new URL(`${loginUrl}?error=unsupported_role`, origin),
  );
  for (const cookie of response.cookies.getAll()) {
    unsupported.cookies.set(cookie);
  }
  return unsupported;
} else {
```

- [ ] **Step 4: Write failing middleware tests**

In `src/__tests__/middleware.test.ts`, extend the Supabase mock so `from().select().eq().limit().single()` can return a self row. Use this shape:

```ts
const { getUser, single } = vi.hoisted(() => ({
  getUser: vi.fn(),
  single: vi.fn(),
}));

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser,
    },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      single,
    })),
  })),
}));
```

Add tests:

```ts
it('redirects sales_partner away from admin pages instead of treating them as admin', async () => {
  getUser.mockResolvedValue({ data: { user: { id: 'auth-sp' } } });
  single.mockResolvedValue({ data: { role: 'sales_partner', account_id: null } });

  const response = await middleware(request('https://repworth.net/admin/overview'));
  const location = response.headers.get('location');

  expect(location).not.toBeNull();
  const redirect = new URL(location!);
  expect(redirect.pathname).toBe('/admin/login');
  expect(redirect.searchParams.get('from')).toBe('/admin/overview');
});

it('returns 403 for sales_partner admin API requests', async () => {
  getUser.mockResolvedValue({ data: { user: { id: 'auth-sp' } } });
  single.mockResolvedValue({ data: { role: 'sales_partner', account_id: null } });

  const response = await middleware(request('https://repworth.net/api/admin/businesses'));

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'Forbidden' });
});

it('redirects sales_partner onboarding page requests to owner login, not admin overview', async () => {
  getUser.mockResolvedValue({ data: { user: { id: 'auth-sp' } } });
  single.mockResolvedValue({ data: { role: 'sales_partner', account_id: null } });

  const response = await middleware(request('https://repworth.net/onboarding/business'));
  const location = response.headers.get('location');

  expect(location).not.toBeNull();
  const redirect = new URL(location!);
  expect(redirect.pathname).toBe('/login');
  expect(redirect.searchParams.get('from')).toBe('/onboarding/business');
});
```

- [ ] **Step 5: Run middleware tests and verify they fail**

Run:

```bash
pnpm exec vitest run src/__tests__/middleware.test.ts
```

Expected: failures while middleware still treats `sales_partner` as admin-class.

- [ ] **Step 6: Implement middleware behavior**

In `src/middleware.ts`:

Replace both:

```ts
!['admin', 'sales_partner'].includes(self.role)
```

with:

```ts
self.role !== 'admin'
```

Replace the onboarding comment block so it describes only admin as admin-class:

```ts
//   b. Authenticated as admin -> admin home (they're already logged in
//      correctly, just on the wrong page; don't make them re-authenticate).
```

Replace:

```ts
if (self.role === 'admin' || self.role === 'sales_partner') {
```

with:

```ts
if (self.role === 'admin') {
```

- [ ] **Step 7: Remove `sales_partner` from admin API route authorization**

For each file returned by this command:

```bash
rg "requireRole\\([^\\n]+['\"]admin['\"], ['\"]sales_partner['\"]" src/app/api/admin -n
```

change calls like:

```ts
await requireRole(request, 'admin', 'sales_partner');
await requireRole(req, 'admin', 'sales_partner');
authUser = await requireRole(request, 'admin', 'sales_partner');
user = await requireRole(request, 'admin', 'sales_partner');
```

to:

```ts
await requireRole(request, 'admin');
await requireRole(req, 'admin');
authUser = await requireRole(request, 'admin');
user = await requireRole(request, 'admin');
```

Known current targets:

```text
src/app/api/admin/businesses/route.ts
src/app/api/admin/businesses/[id]/route.ts
src/app/api/admin/businesses/[id]/channels/route.ts
src/app/api/admin/businesses/[id]/keywords/route.ts
src/app/api/admin/businesses/[id]/ranking/route.ts
src/app/api/admin/businesses/prefill/route.ts
src/app/api/admin/channels/telegram/start/route.ts
src/app/api/admin/channels/telegram/disable/route.ts
src/app/api/admin/channels/telegram/cancel/route.ts
src/app/api/admin/channels/whatsapp/start/route.ts
src/app/api/admin/channels/whatsapp/disable/route.ts
src/app/api/admin/channels/whatsapp/cancel/route.ts
src/app/api/admin/costs/route.ts
src/app/api/admin/demos/route.ts
src/app/api/admin/demos/generate/route.ts
src/app/api/admin/jobs/route.ts
src/app/api/admin/locations/csv-import/route.ts
src/app/api/admin/notifications/route.ts
src/app/api/admin/overview/route.ts
src/app/api/admin/payment-success/route.ts
```

- [ ] **Step 8: Remove worker recipient treatment**

In `worker/jobs/OnboardingDripWorker.ts`, replace role filters:

```sql
WHERE role IN ('admin', 'sales_partner') AND business_id = ${business.id}
```

with:

```sql
WHERE role = 'admin' AND business_id = ${business.id}
```

Replace:

```sql
WHERE b.id = ${business.id} AND u.role IN ('admin', 'sales_partner')
```

with:

```sql
WHERE b.id = ${business.id} AND u.role = 'admin'
```

Update nearby comments to say `admin`, not `admin/sales_partner`.

- [ ] **Step 9: Update source comments and tests that encode admin-equivalent `sales_partner`**

Change admin page comments under `src/app/admin/**` from:

```ts
// Auth: Supabase session checked by src/middleware.ts (admin/sales_partner role required)
```

to:

```ts
// Auth: Supabase session checked by src/middleware.ts (admin role required)
```

Update auth reset/forgot password tests and implementation if they still allow `sales_partner` in the admin bucket:

```bash
rg "sales_partner" src/app/api/auth src/components/auth src/app/admin src/middleware.ts worker/jobs/OnboardingDripWorker.ts -n
```

Allowed remaining code hits after this PR:

```text
docs/superpowers/specs/2026-05-21-security-dependency-hardening-design.md
historical docs and plans
tests that assert sales_partner is rejected
```

- [ ] **Step 10: Run focused validation**

Run:

```bash
pnpm exec vitest run src/app/api/auth/__tests__/callback.test.ts src/components/auth/shared/__tests__/mapLoginError.test.ts src/components/auth/__tests__/LoginFormClient.test.tsx src/__tests__/middleware.test.ts
pnpm exec vitest run src/app/api/admin
pnpm exec vitest run worker/jobs/__tests__/OnboardingDripWorker.test.ts
pnpm typecheck
pnpm build
```

Expected: all pass.

- [ ] **Step 11: Commit PR 1**

Run:

```bash
git status --short
git add src worker/jobs/OnboardingDripWorker.ts
git commit -m "fix(auth): remove sales partner runtime access"
```

Expected: one commit on `hardening/remove-sales-partner-runtime-access`.

---

## Task 2: Enforce Same-Origin On Cookie-Authenticated Mutations

**Files:**
- Modify: `src/lib/shared/csrf.ts`
- Modify: `src/lib/shared/__tests__/csrf.test.ts`
- Modify: `src/lib/auth/route-helpers.ts`
- Modify: `src/lib/auth/__tests__/route-helpers.test.ts`
- Modify representative mutation routes and tests listed in the File Map.

- [ ] **Step 1: Create branch from updated main**

Run:

```bash
git checkout main
git pull --ff-only
git checkout -b hardening/same-origin-mutations
```

Expected: new branch from current `main` after PR 1 is merged.

- [ ] **Step 2: Write failing fetch-metadata tests**

In `src/lib/shared/__tests__/csrf.test.ts`, add:

```ts
it('rejects Sec-Fetch-Site: cross-site even when Origin matches', () => {
  const req = new Request('https://app.example.com/api/test', {
    method: 'POST',
    headers: {
      Origin: APP_URL,
      'Sec-Fetch-Site': 'cross-site',
    },
  });
  expect(() => assertSameOrigin(req)).toThrow(SameOriginError);
  expect(() => assertSameOrigin(req)).toThrow(/cross-site/);
});

it('allows same-origin fetch metadata with matching Origin', () => {
  const req = new Request('https://app.example.com/api/test', {
    method: 'POST',
    headers: {
      Origin: APP_URL,
      'Sec-Fetch-Site': 'same-origin',
    },
  });
  expect(() => assertSameOrigin(req)).not.toThrow();
});
```

In `src/lib/auth/__tests__/route-helpers.test.ts`, add:

```ts
it('returns 403 when Sec-Fetch-Site is cross-site', async () => {
  const wrapped = withSameOrigin()(okHandler);
  const req = new NextRequest('https://app.example.com/api/test', {
    method: 'POST',
    headers: {
      Origin: APP_URL,
      'Sec-Fetch-Site': 'cross-site',
    },
  });

  const res = await wrapped(req);

  expect(res.status).toBe(403);
  expect(okHandler).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run helper tests and verify they fail**

Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/csrf.test.ts src/lib/auth/__tests__/route-helpers.test.ts
```

Expected: the new cross-site tests fail.

- [ ] **Step 4: Implement fetch metadata defense-in-depth**

In `src/lib/shared/csrf.ts`, add this near the top of `assertSameOrigin` after the `NEXT_PUBLIC_APP_URL` check:

```ts
const secFetchSite = request.headers.get('sec-fetch-site');
if (secFetchSite === 'cross-site') {
  throw new SameOriginError('Sec-Fetch-Site cross-site requests are not allowed');
}
```

Do not weaken the existing required `Origin` behavior.

- [ ] **Step 5: Add representative route tests for missing/mismatched Origin**

Use existing route-family tests rather than duplicating every route. Add tests in:

`src/app/api/settings/__tests__/route.test.ts`:

```ts
it('returns 403 when Origin is missing', async () => {
  mockRequireRole.mockResolvedValue(ownerUser());

  const res = await PUT(makeRequest({ tone: 'professional' }));

  expect(res.status).toBe(403);
  expect(mockRequireRole).not.toHaveBeenCalled();
});

it('returns 403 when Origin is cross-site', async () => {
  mockRequireRole.mockResolvedValue(ownerUser());
  const req = new NextRequest('http://localhost:3000/api/settings', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://evil.example.com',
    },
    body: JSON.stringify({ tone: 'professional' }),
  });

  const res = await PUT(req);

  expect(res.status).toBe(403);
  expect(mockRequireRole).not.toHaveBeenCalled();
});
```

Then update that file's `makeRequest` helper to include same-origin by default:

```ts
function makeRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/settings', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost:3000',
    },
    body: JSON.stringify(body),
  });
}
```

Set the app URL in `beforeEach`:

```ts
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost:3000';
```

Add the same pattern to `src/app/api/dashboard/reviews/__tests__/actions.test.ts` for the approve route:

```ts
it('returns 403 when Origin is missing', async () => {
  mockRequireRole.mockResolvedValue(ownerUser());

  const req = new NextRequest(`http://localhost:3000/api/dashboard/reviews/${REVIEW_ID}/approve`, {
    method: 'POST',
  });

  const { POST } = await import('../[reviewId]/approve/route');
  const res = await POST(req, makeParams(REVIEW_ID));

  expect(res.status).toBe(403);
  expect(mockRequireRole).not.toHaveBeenCalled();
});
```

Add one admin route-family test, for example in `src/app/api/admin/channels/telegram/__tests__/start.test.ts`:

```ts
it('returns 403 when Origin is missing', async () => {
  process.env.CHANNELS_TELEGRAM_ENABLED = 'true';

  const res = await POST(new Request('http://localhost/api/admin/channels/telegram/start', {
    method: 'POST',
    body: JSON.stringify({ businessId: 'biz-1' }),
    headers: { 'Content-Type': 'application/json' },
  }) as any);

  expect(res.status).toBe(403);
});
```

Update that file's `mkReq` helper to include same-origin by default:

```ts
function mkReq(body: unknown) {
  return new Request('http://localhost/api/admin/channels/telegram/start', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://localhost',
    },
  });
}
```

Set:

```ts
process.env.NEXT_PUBLIC_APP_URL = 'http://localhost';
```

in the test `beforeEach`.

- [ ] **Step 6: Run route tests and verify they fail**

Run:

```bash
pnpm exec vitest run src/app/api/settings/__tests__/route.test.ts src/app/api/dashboard/reviews/__tests__/actions.test.ts src/app/api/admin/channels/telegram/__tests__/start.test.ts
```

Expected: missing/mismatched origin tests fail until route code enforces same-origin.

- [ ] **Step 7: Implement route enforcement**

For routes with direct handlers, add:

```ts
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
```

Then add as the first statement in the handler:

```ts
try {
  assertSameOrigin(request);
} catch (err) {
  if (err instanceof SameOriginError) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: NO_STORE_HEADERS });
  }
  throw err;
}
```

Use `req` instead of `request` where the parameter is named `req`. Use the route's local no-store header constant when present.

Apply to these current route families:

```text
src/app/api/settings/route.ts
src/app/api/settings/voice/route.ts
src/app/api/settings/channels/override/route.ts
src/app/api/dashboard/reviews/[reviewId]/approve/route.ts
src/app/api/dashboard/reviews/[reviewId]/edit/route.ts
src/app/api/dashboard/reviews/[reviewId]/regenerate/route.ts
src/app/api/billing/checkout/route.ts
src/app/api/billing/portal/route.ts
src/app/api/billing/tier-change/route.ts
src/app/api/admin/businesses/route.ts
src/app/api/admin/businesses/[id]/route.ts
src/app/api/admin/businesses/[id]/keywords/route.ts
src/app/api/admin/businesses/[id]/ranking/route.ts
src/app/api/admin/channels/telegram/start/route.ts
src/app/api/admin/channels/telegram/disable/route.ts
src/app/api/admin/channels/telegram/cancel/route.ts
src/app/api/admin/channels/whatsapp/start/route.ts
src/app/api/admin/channels/whatsapp/disable/route.ts
src/app/api/admin/channels/whatsapp/cancel/route.ts
src/app/api/admin/channels/sms/confirm/route.ts
src/app/api/admin/channels/sms/cancel/route.ts
src/app/api/admin/channels/sms/delete/route.ts
src/app/api/admin/channels/sms/disable/route.ts
src/app/api/admin/channels/sms/verify/route.ts
src/app/api/admin/demos/generate/route.ts
src/app/api/admin/locations/csv-import/route.ts
```

Do not add same-origin to:

```text
GET-only admin/dashboard/settings/account routes
third-party webhook routes
public token approval routes under src/app/api/approve/[token]/**
public contact/demo/lead-intake routes
auth routes already using assertSameOrigin unless a test proves a gap
```

- [ ] **Step 8: Cover multi-location owner mutations centrally**

In `src/lib/locations/owner-route.ts`, import:

```ts
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
```

At the top of `readOwnerForMultiLocationRoute`, after the feature-flag check, add:

```ts
try {
  assertSameOrigin(req);
} catch (err) {
  if (err instanceof SameOriginError) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'forbidden' },
        { status: 403, headers: LOCATION_ROUTE_NO_STORE },
      ),
    };
  }
  throw err;
}
```

Update `src/lib/locations/__tests__/owner-route.test.ts` request helpers to include `Origin: http://localhost:3000` by default and add one missing-origin test.

- [ ] **Step 9: Run focused validation**

Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/csrf.test.ts src/lib/auth/__tests__/route-helpers.test.ts
pnpm exec vitest run src/app/api/settings/__tests__ src/app/api/dashboard/reviews/__tests__/actions.test.ts src/app/api/admin/channels/telegram/__tests__/start.test.ts src/lib/locations/__tests__/owner-route.test.ts
pnpm typecheck
pnpm build
```

Expected: all pass.

- [ ] **Step 10: Commit PR 2**

Run:

```bash
git status --short
git add src
git commit -m "fix(security): require same origin for session mutations"
```

Expected: one commit on `hardening/same-origin-mutations`.

---

## Task 3: Sanitize Owner-Edited Public Response Text

**Files:**
- Modify: `src/lib/shared/sanitize.ts`
- Modify: `src/lib/shared/__tests__/sanitize.test.ts`
- Modify: `src/app/api/approve/[token]/edit/route.ts`
- Modify: `src/app/api/dashboard/reviews/[reviewId]/edit/route.ts`
- Modify: `src/lib/approval/token-mode.ts`
- Modify: `src/lib/approval/session-mode.ts`
- Modify: `src/lib/approval/__tests__/service.test.ts`
- Modify: `src/app/api/dashboard/reviews/__tests__/actions.test.ts`

- [ ] **Step 1: Create branch from updated main**

Run:

```bash
git checkout main
git pull --ff-only
git checkout -b hardening/public-response-sanitizer
```

Expected: new branch from current `main` after PR 2 is merged.

- [ ] **Step 2: Write failing sanitizer tests**

In `src/lib/shared/__tests__/sanitize.test.ts`, extend the import:

```ts
import { sanitizePublicResponseText, sanitizeText } from '../sanitize';
```

Add:

```ts
describe('sanitizePublicResponseText', () => {
  it('strips null bytes and control characters', () => {
    expect(sanitizePublicResponseText('Hi\x00 there\x01 friend\x7F')).toBe('Hi there friend');
  });

  it('strips zero-width and bidi control characters', () => {
    expect(sanitizePublicResponseText('ab\u200Bcd\u202Eef\u2066gh\u2069')).toBe('abcdefgh');
  });

  it('preserves paragraph breaks while normalizing spaces within lines', () => {
    expect(
      sanitizePublicResponseText('  First   paragraph.\n\nSecond\t\tparagraph.  '),
    ).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('caps excessive blank lines at one blank line', () => {
    expect(sanitizePublicResponseText('A\n\n\n\nB')).toBe('A\n\nB');
  });

  it('preserves visible unicode content', () => {
    expect(sanitizePublicResponseText('Gracias, José! 🌮')).toBe('Gracias, José! 🌮');
  });

  it('returns empty when only stripped characters remain', () => {
    expect(sanitizePublicResponseText('\u200B\u202E\x00')).toBe('');
  });

  it('is idempotent', () => {
    const input = '  Hello   world.\n\n\nThanks!\u200B  ';
    const once = sanitizePublicResponseText(input);
    expect(sanitizePublicResponseText(once)).toBe(once);
  });
});
```

- [ ] **Step 3: Run sanitizer tests and verify they fail**

Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/sanitize.test.ts
```

Expected: `sanitizePublicResponseText` export is missing.

- [ ] **Step 4: Implement sanitizer**

In `src/lib/shared/sanitize.ts`, add:

```ts
/**
 * Sanitizes owner-approved public response text before persistence.
 *
 * Unlike sanitizeText(), this preserves paragraph breaks because edited
 * review replies may intentionally contain multiple paragraphs.
 */
export function sanitizePublicResponseText(input: string): string {
  return input
    .replace(/\0/g, '')
    .replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/[\x7F-\x9F]/g, '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
```

- [ ] **Step 5: Write failing approval persistence tests**

In `src/lib/approval/__tests__/service.test.ts`, in the `describe('edit')` block, add:

```ts
it('sanitizes edited text before storing and computing edit distance', async () => {
  const link = validLink({ device_cookie_hash: 'device-hash-abc' });
  const editedText = '  Thanks\u200B   again.\n\n\nWe appreciate it.\u202E  ';

  const tx = createMockTx([
    [{ status: 'pending_approval', original_draft_text: 'Thanks again.', version: 1, review_id: 'rev-1' }],
    [],
    [],
    [],
    [],
    [{ account_id: 'acc-1' }],
    [],
  ]);

  await edit(tx, link, editedText, 'device-hash-abc', AUDIT, 'test-correlation-xyz');

  const allStringArgs = tx.mock.calls.flat().filter((arg: unknown): arg is string => typeof arg === 'string');
  expect(allStringArgs).toContain('Thanks again.\n\nWe appreciate it.');
  expect(allStringArgs).not.toContain(editedText);
});
```

Add a parallel test for `editBySession` in the same file:

```ts
it('sanitizes session edited text before storing', async () => {
  const editedText = '  Owner\u200B   edit.\n\n\nSecond line.\u202E  ';
  const tx = createMockTx([
    [{ status: 'pending_approval', original_draft_text: 'Owner edit.', version: 1, review_id: 'rev-1' }],
    [],
    [],
    [],
    [{ account_id: 'acc-1' }],
    [],
  ]);

  await editBySession(
    tx,
    'resp-1',
    'biz-1',
    editedText,
    { userId: 'user-1', ipAddress: '127.0.0.1' },
    'test-correlation-xyz',
  );

  const allStringArgs = tx.mock.calls.flat().filter((arg: unknown): arg is string => typeof arg === 'string');
  expect(allStringArgs).toContain('Owner edit.\n\nSecond line.');
  expect(allStringArgs).not.toContain(editedText);
});
```

Update the import from `../service` to include `editBySession` if it is not already imported.

- [ ] **Step 6: Run approval service tests and verify they fail**

Run:

```bash
pnpm exec vitest run src/lib/approval/__tests__/service.test.ts
```

Expected: new tests fail because raw edited text is stored.

- [ ] **Step 7: Apply sanitizer at persistence boundary**

In `src/lib/approval/token-mode.ts`, import:

```ts
import { sanitizePublicResponseText } from '@/lib/shared/sanitize';
```

Inside `edit`, replace:

```ts
const editDist = distance(resp.original_draft_text, editedText);
```

with:

```ts
const sanitizedEditedText = sanitizePublicResponseText(editedText);
if (sanitizedEditedText.length === 0) {
  throw new Error('edited_text_empty_after_sanitization');
}
const editDist = distance(resp.original_draft_text, sanitizedEditedText);
```

Replace both SQL bindings of `editedText` with `sanitizedEditedText`.

In `src/lib/approval/session-mode.ts`, make the same change inside `editBySession`.

- [ ] **Step 8: Sanitize before route validation rejects empty-after-sanitization**

In `src/app/api/approve/[token]/edit/route.ts`, import:

```ts
import { sanitizePublicResponseText } from '@/lib/shared/sanitize';
```

In `prepare`, after type and length checks, return sanitized text:

```ts
const sanitized = sanitizePublicResponseText(editedText);
if (sanitized.length === 0) {
  return NextResponse.json({ error: 'editedText is required' }, { status: 400, headers: NO_STORE_HEADERS });
}

return sanitized;
```

Then change the action call from:

```ts
edit(tx, link, prepared.trim(), deviceCookieHash, audit, correlationId)
```

to:

```ts
edit(tx, link, prepared, deviceCookieHash, audit, correlationId)
```

In `src/app/api/dashboard/reviews/[reviewId]/edit/route.ts`, import the sanitizer and change the schema to transform:

```ts
const editSchema = z.object({
  editedText: z.string().max(2000).transform((value) => sanitizePublicResponseText(value)).pipe(z.string().min(1)),
});
```

- [ ] **Step 9: Add dashboard route sanitizer test**

In `src/app/api/dashboard/reviews/__tests__/actions.test.ts`, in the edit describe block, add:

```ts
it('passes sanitized edited text to session approval service', async () => {
  mockRequireRole.mockResolvedValue(ownerUser());
  setResponseLookup([{ id: RESPONSE_ID, business_id: BUSINESS_ID, status: 'pending_approval' }]);
  mockSqlResults.push([{ correlation_id: 'upstream-corr-abc' }]);
  mockEditBySession.mockResolvedValue(undefined);

  const { POST } = await import('../[reviewId]/edit/route');
  const res = await POST(
    makeRequest(`/api/dashboard/reviews/${REVIEW_ID}/edit`, {
      editedText: '  Thanks\u200B   again.\n\n\nSecond line.\u202E  ',
    }),
    makeParams(REVIEW_ID),
  );

  expect(res.status).toBe(200);
  expect(mockEditBySession.mock.calls[0]?.[3]).toBe('Thanks again.\n\nSecond line.');
});
```

- [ ] **Step 10: Run focused validation**

Run:

```bash
pnpm exec vitest run src/lib/shared/__tests__/sanitize.test.ts src/lib/approval/__tests__/service.test.ts src/app/api/dashboard/reviews/__tests__/actions.test.ts
pnpm typecheck
pnpm build
```

Expected: all pass.

- [ ] **Step 11: Commit PR 3**

Run:

```bash
git status --short
git add src/lib/shared/sanitize.ts src/lib/shared/__tests__/sanitize.test.ts src/lib/approval src/app/api/approve src/app/api/dashboard/reviews
git commit -m "fix(approval): sanitize public response edits"
```

Expected: one commit on `hardening/public-response-sanitizer`.

---

## Task 4: Add Worker Mock-Mode and Stripe Startup Safety

**Files:**
- Modify: `worker/config/startup-assert.ts`
- Modify: `worker/config/__tests__/startup-assertion.test.ts`
- Modify: `worker/index.ts`

- [ ] **Step 1: Create branch from updated main**

Run:

```bash
git checkout main
git pull --ff-only
git checkout -b hardening/worker-env-startup-safety
```

Expected: new branch from current `main` after PR 3 is merged.

- [ ] **Step 2: Write failing startup assertion tests**

In `worker/config/__tests__/startup-assertion.test.ts`, update the import to include:

```ts
import {
  assertChannelsSmsEnv,
  assertProductionEnvSafety,
  assertSelfServeSignupEnv,
  assertStripeEnv,
} from '../startup-assert';
```

Add:

```ts
describe('assertProductionEnvSafety', () => {
  const SNAP: Record<string, string | undefined> = {};
  const KEYS = ['NODE_ENV', 'MOCK_EXTERNAL_APIS'];

  beforeEach(() => {
    for (const k of KEYS) { SNAP[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (SNAP[k] === undefined) delete process.env[k]; else process.env[k] = SNAP[k];
    }
  });

  it('throws when production has MOCK_EXTERNAL_APIS=true', () => {
    process.env.NODE_ENV = 'production';
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertProductionEnvSafety()).toThrow(/MOCK_EXTERNAL_APIS/);
  });

  it('allows mock mode outside production', () => {
    process.env.NODE_ENV = 'test';
    process.env.MOCK_EXTERNAL_APIS = 'true';
    expect(() => assertProductionEnvSafety()).not.toThrow();
  });
});

describe('assertStripeEnv', () => {
  const REQUIRED_STRIPE_VARS = [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_PRICE_BASIC',
    'STRIPE_PRICE_FOUNDING',
    'STRIPE_PRICE_STANDARD',
    'STRIPE_PRICE_PREMIUM',
    'STRIPE_PRICE_STANDARD_OVERAGE',
    'STRIPE_PRICE_PREMIUM_OVERAGE',
    'STRIPE_PRICE_FOUNDERS_OVERAGE',
  ];
  const SNAP: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of REQUIRED_STRIPE_VARS) { SNAP[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of REQUIRED_STRIPE_VARS) {
      if (SNAP[k] === undefined) delete process.env[k]; else process.env[k] = SNAP[k];
    }
  });

  it('throws listing missing Stripe env vars', () => {
    expect(() => assertStripeEnv()).toThrow(/STRIPE_SECRET_KEY/);
    expect(() => assertStripeEnv()).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });

  it('treats whitespace-only vars as missing', () => {
    for (const k of REQUIRED_STRIPE_VARS) process.env[k] = 'x';
    process.env.STRIPE_SECRET_KEY = '   ';
    expect(() => assertStripeEnv()).toThrow(/STRIPE_SECRET_KEY/);
  });

  it('passes when all required vars are present', () => {
    for (const k of REQUIRED_STRIPE_VARS) process.env[k] = 'x';
    expect(() => assertStripeEnv()).not.toThrow();
  });
});
```

- [ ] **Step 3: Run startup assertion tests and verify they fail**

Run:

```bash
pnpm exec vitest run worker/config/__tests__/startup-assertion.test.ts
```

Expected: missing exports fail.

- [ ] **Step 4: Implement startup assertions**

In `worker/config/startup-assert.ts`, add:

```ts
const STRIPE_REQUIRED_ENV_VARS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_BASIC',
  'STRIPE_PRICE_FOUNDING',
  'STRIPE_PRICE_STANDARD',
  'STRIPE_PRICE_PREMIUM',
  'STRIPE_PRICE_STANDARD_OVERAGE',
  'STRIPE_PRICE_PREMIUM_OVERAGE',
  'STRIPE_PRICE_FOUNDERS_OVERAGE',
] as const;

function missingEnvVars(keys: readonly string[]): string[] {
  return keys.filter((k) => !process.env[k] || process.env[k]!.trim().length === 0);
}

export function assertProductionEnvSafety(): void {
  if (process.env.NODE_ENV === 'production' && process.env.MOCK_EXTERNAL_APIS === 'true') {
    throw new Error('[startup] MOCK_EXTERNAL_APIS must not be true in production');
  }
}

export function assertStripeEnv(): void {
  const missing = missingEnvVars(STRIPE_REQUIRED_ENV_VARS);
  if (missing.length > 0) {
    throw new Error(`[startup] Stripe env missing required vars: ${missing.join(', ')}`);
  }
}
```

Optionally reuse `missingEnvVars` in existing assertions, but do not refactor unrelated behavior.

- [ ] **Step 5: Call assertions before worker construction accepts work**

In `worker/index.ts`, update the import:

```ts
import {
  assertChannelsSmsEnv,
  assertChannelsTelegramEnv,
  assertChannelsWhatsAppEnv,
  assertProductionEnvSafety,
  assertSelfServeSignupEnv,
  assertStripeEnv,
  assertZernioPublishingEnv,
} from './config/startup-assert';
```

Immediately after constants/imports and before `new Worker(...)` construction, add:

```ts
try {
  assertProductionEnvSafety();
  assertStripeEnv();
} catch (err) {
  console.error(`[worker] Startup assertion failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
```

In `main()`, keep the existing feature-flag assertions and add the two assertions there too only if tests require it. Prefer the top-level guard because this file currently constructs BullMQ workers before `main()`.

Update the export block:

```ts
export {
  assertChannelsSmsEnv,
  assertChannelsTelegramEnv,
  assertChannelsWhatsAppEnv,
  assertProductionEnvSafety,
  assertSelfServeSignupEnv,
  assertStripeEnv,
  assertZernioPublishingEnv,
} from './config/startup-assert';
```

- [ ] **Step 6: Run focused validation**

Run:

```bash
pnpm exec vitest run worker/config/__tests__/startup-assertion.test.ts worker/ingress/__tests__/stripe.test.ts worker/ingress/__tests__/stripe-webhook-handlers.test.ts worker/jobs/billing/__tests__/UpdateStripeOverageWorker.test.ts
pnpm typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit PR 4**

Run:

```bash
git status --short
git add worker/config/startup-assert.ts worker/config/__tests__/startup-assertion.test.ts worker/index.ts
git commit -m "fix(worker): fail fast on unsafe production env"
```

Expected: one commit on `hardening/worker-env-startup-safety`.

---

## Task 5: Add Runtime Metadata

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Create branch from updated main**

Run:

```bash
git checkout main
git pull --ff-only
git checkout -b chore/runtime-metadata
```

Expected: new branch from current `main` after PR 4 is merged.

- [ ] **Step 2: Verify runtime versions**

Run:

```bash
cat .nvmrc
pnpm --version
```

Expected:

```text
v24.15.0
11.0.9
```

- [ ] **Step 3: Update `package.json`**

Add top-level fields after `"private": true`:

```json
  "private": true,
  "packageManager": "pnpm@11.0.9",
  "engines": {
    "node": "24.15.0"
  },
```

- [ ] **Step 4: Validate metadata**

Run:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
```

Expected: install does not change lockfile; typecheck passes.

- [ ] **Step 5: Commit PR 5a**

Run:

```bash
git status --short
git add package.json
git commit -m "chore: declare node and pnpm runtime"
```

Expected: one commit on `chore/runtime-metadata`.

---

## Task 6: Upgrade Dependency Supply Chain

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify framework fallout files only when validation proves they are required.

- [ ] **Step 1: Create branch from updated main**

Run:

```bash
git checkout main
git pull --ff-only
git checkout -b chore/dependency-supply-chain
```

Expected: new branch from current `main` after PR 5a is merged.

- [ ] **Step 2: Capture current audit and outdated state**

Run:

```bash
pnpm audit --audit-level low
pnpm outdated
```

Expected: audit currently reports vulnerabilities in packages including Next/Fastify/transitive tooling. Save the command output in the PR description, not in a repo file.

- [ ] **Step 3: Upgrade narrow non-framework packages first**

Run:

```bash
pnpm update fastify @sentry/nextjs @sentry/node @supabase/supabase-js @supabase/ssr openai
```

Expected: `package.json` and `pnpm-lock.yaml` update. If this does not resolve transitive `ws`, `fast-uri`, `glob`, or `brace-expansion` advisories, continue to Step 4.

- [ ] **Step 4: Upgrade Next as a deliberate framework change**

Run:

```bash
pnpm add next@latest eslint-config-next@latest
```

Expected: Next and eslint-config-next move to the current patched stable release. Review release notes for any required config changes before editing app code.

- [ ] **Step 5: Run validation and fix only proven fallout**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm audit --audit-level low
```

Expected: all pass, or failures identify exact framework fallout.

If `next lint` is removed or deprecated by the upgraded Next version, update the lint script in `package.json` to the supported command used by the upgraded framework. Keep the change in this PR because it is upgrade fallout.

- [ ] **Step 6: Run focused smoke tests**

Run:

```bash
pnpm exec vitest run src/app/api/auth/__tests__ src/app/api/admin src/app/api/dashboard src/app/api/billing
pnpm exec vitest run src/app/api/zernio/connect/callback/__tests__/route.test.ts src/app/api/zernio/connect/select-location/__tests__/route.test.ts
```

Expected: auth, admin, dashboard, billing, and Zernio route tests pass after framework upgrades.

- [ ] **Step 7: Manual smoke if build or tests touched framework behavior**

Start the app:

```bash
pnpm dev
```

Smoke these flows in a browser:

```text
/login
/admin/login
/dashboard
/settings
/admin/overview
billing checkout route through the UI
Zernio connect start/callback route path in a non-production test account
```

Expected: pages render, auth redirects make sense, no console/server errors from the framework upgrade.

- [ ] **Step 8: Commit PR 5b**

Run:

```bash
git status --short
git add package.json pnpm-lock.yaml
git commit -m "chore: upgrade vulnerable dependencies"
```

Before committing, review `git diff --stat`. If validation required framework-fallout edits outside `package.json` and `pnpm-lock.yaml`, stage each concrete file by path after reviewing it:

```bash
git add next.config.mjs
git add src/app/layout.tsx
```

The `next.config.mjs` and `src/app/layout.tsx` commands demonstrate the staging pattern for reviewed fallout files. Do not run them unless those exact files changed for the dependency upgrade.

Expected: one commit on `chore/dependency-supply-chain` containing only dependency and validated framework-fallout changes.

---

## Final Sequence Validation

After all six PRs merge, run from `main`:

```bash
git pull --ff-only
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm audit --audit-level low
rg "requireRole\\([^\\n]+['\"]admin['\"], ['\"]sales_partner['\"]" src worker
rg "role IN \\('admin', 'sales_partner'\\)|role = 'sales_partner'|role === 'sales_partner'" src worker
```

Expected:

```text
lint/typecheck/test/build pass
audit passes or has documented accepted exceptions
no runtime authorization accepts sales_partner
only rejection tests or historical docs mention sales_partner
```

## Self-Review

- Spec coverage: each approved PR has a task, files, tests, validation, and commit boundary.
- Placeholder scan: the plan uses explicit paths and commands; dependency versions are intentionally derived from `pnpm audit` and `pnpm outdated` at execution time because advisories can change.
- Type consistency: the plan uses existing names from current code: `assertSameOrigin`, `SameOriginError`, `NO_STORE_HEADERS`, `edit`, `editBySession`, `assertChannelsSmsEnv`, and `assertSelfServeSignupEnv`.
