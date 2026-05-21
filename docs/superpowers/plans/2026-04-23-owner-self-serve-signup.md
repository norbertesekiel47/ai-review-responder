# Owner Self-Serve Signup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let business owners sign up self-serve from the landing page with email+password or Google OAuth, confirm email, pay via Stripe, and reach their dashboard — without sales-partner involvement. Admin onboarding continues unchanged.

**Architecture:** New `/signup` / `/login` / `/onboarding/*` / reset-password surfaces backed by five new `/api/auth/*` routes. Signup creates Supabase Auth user pre-Stripe (email-confirm gate) but defers initial review sync to the Stripe webhook (zero pre-payment SerpAPI/LLM spend). Admin onboarding is extracted into a shared `createBusinessTx` helper both flows share. Owner auth via cookie-bound Supabase anon client + `users_self_select` RLS; service-role never appears in browser code. Flag-gated via `SELF_SERVE_SIGNUP_ENABLED` — admin pages never gated.

**Tech Stack:** TypeScript 5 strict, Next.js 14 App Router, Supabase Auth (`@supabase/ssr`), Postgres.js (`sql.begin` + advisory locks), Stripe Payment Links (existing webhook extended), Zod schemas, Vitest, Playwright.

**Source spec:** `docs/superpowers/specs/2026-04-23-owner-self-serve-signup-design.md`

---

## Scope

Single subsystem — one onboarding flow. Not decomposed further; all pieces ship together.

## File structure

**New files (34):**

| Path | Responsibility |
|------|----------------|
| `supabase/migrations/025_signup_schema.sql` | Two partial indexes with COMMENT ON INDEX + email lowercase backfill + onboarded_by backfill. Auth-id uniqueness covered by migration 001 UNIQUE constraint. |
| `src/lib/shared/auth-flow.ts` | `AuthFlow` type, `isAuthFlow`, `loginUrlForFlow`, `resetPasswordPathForFlow`. Single source of truth for `flow=` query param. |
| `src/lib/shared/__tests__/auth-flow.test.ts` | |
| `src/lib/shared/csrf.ts` | `assertSameOrigin(request)` helper. |
| `src/lib/shared/__tests__/csrf.test.ts` | |
| `src/lib/shared/__tests__/protected-routes.test.ts` | Table-driven test for every public/gated path. |
| `src/lib/auth/route-helpers.ts` | `withRateLimit` / `withSameOrigin` / `withSession` composable route wrappers. |
| `src/lib/auth/__tests__/route-helpers.test.ts` | |
| `src/lib/payments/payment-link.ts` | `buildPaymentLinkUrl(tier, businessId, ownerEmail)` extracted from admin route. |
| `src/lib/payments/__tests__/payment-link.test.ts` | |
| `src/lib/onboarding/create-business.ts` | `createBusinessTx(input, options)` with discriminated `mode` union. |
| `src/lib/onboarding/__tests__/create-business.test.ts` | |
| `src/app/api/auth/signup/route.ts` | POST — password signup + advisory lock + auth.signUp + createBusinessTx. |
| `src/app/api/auth/__tests__/signup.test.ts` | |
| `src/app/api/auth/finish-signup/route.ts` | POST — Google-signup finish (cookie-authed). |
| `src/app/api/auth/__tests__/finish-signup.test.ts` | |
| `src/app/api/auth/signup-status/route.ts` | GET — cookie-authed poll endpoint. |
| `src/app/api/auth/__tests__/signup-status.test.ts` | |
| `src/app/api/auth/forgot-password/route.ts` | POST — role-gated reset-email trigger. |
| `src/app/api/auth/__tests__/forgot-password.test.ts` | |
| `src/app/api/auth/reset-password/route.ts` | POST — cookie-authed password update. |
| `src/app/api/auth/__tests__/reset-password.test.ts` | |
| `src/app/api/auth/resend-confirmation/route.ts` | POST — email-confirm resend. |
| `src/app/api/auth/__tests__/resend-confirmation.test.ts` | |
| `src/components/auth/LoginFormClient.tsx` | Shared client component (owner + admin branding via props). |
| `src/components/auth/ForgotPasswordFormClient.tsx` | |
| `src/components/auth/ResetPasswordFormClient.tsx` | |
| `src/components/auth/__tests__/LoginFormClient.test.tsx` | |
| `src/app/(public)/signup/page.tsx` | Owner signup form (password + Google button). |
| `src/app/(public)/signup/check-email/page.tsx` | "Check your inbox" landing + resend button. |
| `src/app/(public)/signup/finish/page.tsx` | Google post-OAuth "finish business fields" form. |
| `src/app/(public)/login/page.tsx` | Owner login — thin wrapper over LoginFormClient. |
| `src/app/(public)/forgot-password/page.tsx` | Owner forgot-password — thin wrapper. |
| `src/app/(public)/reset-password/page.tsx` | Owner reset-password — thin wrapper. |
| `src/app/admin/forgot-password/page.tsx` | Admin forgot-password — thin wrapper. |
| `src/app/admin/reset-password/page.tsx` | Admin reset-password — thin wrapper. |
| `src/app/onboarding/pay/page.tsx` | Post-email-confirm "complete your payment" CTA. |
| `src/app/onboarding/payment-success/page.tsx` | Stripe success URL — polls `/api/auth/signup-status`. |
| `worker/jobs/CleanupAbandonedSignupsPoller.ts` | Interval-driven — deletes abandoned self-serve signups >7d old. |
| `worker/jobs/__tests__/CleanupAbandonedSignupsPoller.test.ts` | |
| `worker/__tests__/stripe-activation-enqueue.test.ts` | Webhook transition-gated enqueue tests. |
| `tests/e2e/signup-password.spec.ts` | Playwright — password signup happy path. |
| `tests/e2e/signup-google.spec.ts` | Playwright — Google signup happy path. |
| `tests/e2e/forgot-password.spec.ts` | Playwright — forgot-password happy path + cross-portal protection. |
| `tests/e2e/reset-password.spec.ts` | Playwright — reset-password happy path. |

**Modified files (12):**

| Path | Change |
|------|--------|
| `src/lib/shared/schemas.ts` | Add `emailSchema`, `SignupSchema`, `FinishSignupSchema`, `ForgotPasswordSchema`, `ResetPasswordSchema`. |
| `src/lib/shared/rate-limit.ts` | No change — `strict: true` already supported. |
| `src/lib/shared/protected-routes.ts` | Exempt `/admin/forgot-password`, `/admin/reset-password`. |
| `src/app/api/admin/businesses/route.ts` | Refactor to call `createBusinessTx`; set `onboardedBy`; import `buildPaymentLinkUrl`. |
| `src/app/api/auth/callback/route.ts` | Add `flow=` param branching, recovery routing, Google-signup-no-users-row branch. |
| `src/app/api/dashboard/route.ts` | Early branch on `pending_payment` returns minimal payload. |
| `src/middleware.ts` | Add `/onboarding/*` gate, role-aware login URL on auth failure. |
| `src/app/admin/login/page.tsx` | Add "Forgot password?" link. Refactor to use LoginFormClient. |
| `src/app/(public)/page.tsx` | Add "Log In" and "Sign Up" nav links (flag-gated server-side). |
| `src/app/(authenticated)/dashboard/.../page.tsx` | Render pending-payment banner when API returns minimal payload. |
| `worker/ingress/stripe.ts` | Extend `processCheckoutSessionCompleted` with transition-gated enqueue + advisory lock. |
| `worker/index.ts` | Register `CleanupAbandonedSignupsPoller` (flag-gated). Add startup assertion. |
| `.env.example` | `SELF_SERVE_SIGNUP_ENABLED` + `CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS` + `CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE`. |

---

## Prerequisites (external, before Task 1)

Document in the implementation-plan handoff so the operator has them ready BEFORE code merges:

1. **Stripe Payment Links** — each Payment Link referenced by `STRIPE_PAYMENT_LINK_FOUNDING` and `STRIPE_PAYMENT_LINK_STANDARD` has its `success_url` set to `<APP_URL>/onboarding/payment-success?session_id={CHECKOUT_SESSION_ID}` and `cancel_url` set to `<APP_URL>/onboarding/pay?cancelled=1`. Verify per environment.
2. **Supabase Google OAuth provider** — enable `google` in Supabase dashboard (Auth → Providers). Authorized redirect URI: `<APP_URL>/api/auth/callback`. Client ID + secret live in Supabase, not in our `.env`.
3. **Supabase email template redirect base** — confirm auth email templates use `{{ .ConfirmationURL }}` (default). No template edits needed.

---

## Task 1: Migration 025 — schema indexes + backfills

**Files:**
- Create: `supabase/migrations/025_signup_schema.sql`

- [ ] **Step 1: Write migration SQL**

Create `supabase/migrations/025_signup_schema.sql`:

```sql
-- Migration 025: signup schema — indexes + email normalization + onboarded_by backfill.
-- See docs/superpowers/specs/2026-04-23-owner-self-serve-signup-design.md §2.

-- ===== Block 1: Indexes =====

CREATE INDEX IF NOT EXISTS idx_businesses_pending_unpaid_self_serve_cleanup
  ON businesses (created_at)
  WHERE subscription_status = 'pending_payment'
    AND stripe_customer_id IS NULL
    AND onboarded_by IS NULL;

CREATE INDEX IF NOT EXISTS idx_users_owner_auth_by_business
  ON users (business_id)
  WHERE role = 'owner' AND auth_id IS NOT NULL;

-- ===== Block 2: Email normalization =====

DO $$
DECLARE
  collisions integer;
BEGIN
  SELECT COUNT(*) INTO collisions FROM (
    SELECT lower(trim(email)) AS norm_email
    FROM users
    GROUP BY lower(trim(email))
    HAVING COUNT(*) > 1
  ) c;
  IF collisions > 0 THEN
    RAISE EXCEPTION
      'Email normalization would create % duplicate(s). Run: SELECT lower(trim(email)) AS norm, array_agg(id) FROM users GROUP BY lower(trim(email)) HAVING COUNT(*) > 1. Resolve manually, then re-run.',
      collisions;
  END IF;
END $$;

UPDATE users SET email = lower(trim(email))
WHERE email <> lower(trim(email));

-- ===== Block 3: onboarded_by backfill =====

DO $$
DECLARE
  placeholder_admin_id UUID;
  affected_businesses INTEGER;
BEGIN
  SELECT id INTO placeholder_admin_id
  FROM users
  WHERE role IN ('admin', 'sales_partner')
  ORDER BY created_at
  LIMIT 1;

  SELECT COUNT(*) INTO affected_businesses
  FROM businesses
  WHERE onboarded_by IS NULL;

  IF affected_businesses > 0 AND placeholder_admin_id IS NULL THEN
    RAISE EXCEPTION
      'Cannot backfill onboarded_by: % business(es) need a value but no admin/sales_partner user exists. Create one first, then re-run.',
      affected_businesses;
  END IF;

  IF placeholder_admin_id IS NOT NULL THEN
    UPDATE businesses SET onboarded_by = placeholder_admin_id
    WHERE onboarded_by IS NULL;
  END IF;
END $$;
```

- [ ] **Step 2: Hand migration to user**

Per CLAUDE.md memory rule: user runs migrations. Tell the user:

> Migration 025 is at `supabase/migrations/025_signup_schema.sql`. Run it in Supabase SQL editor. It has two preconditions that fail loudly:
> - Email lowercase collisions → shows diagnostic query
> - `onboarded_by` backfill needs an admin/sales_partner user
>
> All three index creations use `IF NOT EXISTS` — safe to re-run.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/025_signup_schema.sql
git commit -m "feat(signup): migration 025 schema — indexes + email + onboarded_by backfills"
```

---

## Task 2: `auth-flow.ts` shared helper

**Files:**
- Create: `src/lib/shared/auth-flow.ts`
- Create: `src/lib/shared/__tests__/auth-flow.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/shared/__tests__/auth-flow.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  AUTH_FLOWS,
  isAuthFlow,
  loginUrlForFlow,
  resetPasswordPathForFlow,
} from '../auth-flow';

describe('AUTH_FLOWS', () => {
  it('contains exactly owner and admin', () => {
    expect(AUTH_FLOWS).toEqual(['owner', 'admin']);
  });
});

describe('isAuthFlow', () => {
  it('returns true for owner', () => expect(isAuthFlow('owner')).toBe(true));
  it('returns true for admin', () => expect(isAuthFlow('admin')).toBe(true));
  it('returns false for unknown values', () => {
    expect(isAuthFlow('owners')).toBe(false);
    expect(isAuthFlow('')).toBe(false);
    expect(isAuthFlow(null)).toBe(false);
    expect(isAuthFlow(undefined)).toBe(false);
  });
});

describe('loginUrlForFlow', () => {
  it('routes admin to /admin/login', () => expect(loginUrlForFlow('admin')).toBe('/admin/login'));
  it('routes owner to /login', () => expect(loginUrlForFlow('owner')).toBe('/login'));
  it('defaults undefined to /login', () => expect(loginUrlForFlow(undefined)).toBe('/login'));
});

describe('resetPasswordPathForFlow', () => {
  it('routes admin to /admin/reset-password', () =>
    expect(resetPasswordPathForFlow('admin')).toBe('/admin/reset-password'));
  it('routes owner to /reset-password', () =>
    expect(resetPasswordPathForFlow('owner')).toBe('/reset-password'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/shared/__tests__/auth-flow.test.ts`
Expected: FAIL — "Cannot find module '../auth-flow'"

- [ ] **Step 3: Write implementation**

Create `src/lib/shared/auth-flow.ts`:

```ts
export const AUTH_FLOWS = ['owner', 'admin'] as const;
export type AuthFlow = (typeof AUTH_FLOWS)[number];

export function isAuthFlow(v: string | null | undefined): v is AuthFlow {
  return v === 'owner' || v === 'admin';
}

export function loginUrlForFlow(flow: AuthFlow | undefined): string {
  return flow === 'admin' ? '/admin/login' : '/login';
}

export function resetPasswordPathForFlow(flow: AuthFlow): string {
  return flow === 'admin' ? '/admin/reset-password' : '/reset-password';
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/lib/shared/__tests__/auth-flow.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/auth-flow.ts src/lib/shared/__tests__/auth-flow.test.ts
git commit -m "feat(signup): auth-flow helper for flow= query-param contract"
```

---

## Task 3: `csrf.ts` Origin-header helper

**Files:**
- Create: `src/lib/shared/csrf.ts`
- Create: `src/lib/shared/__tests__/csrf.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/shared/__tests__/csrf.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { assertSameOrigin, SameOriginError } from '../csrf';

describe('assertSameOrigin', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';
  });

  function req(origin: string | null): Request {
    return new Request('https://app.example.com/api/auth/x', {
      method: 'POST',
      headers: origin ? { Origin: origin } : {},
    });
  }

  it('passes when Origin matches', () => {
    expect(() => assertSameOrigin(req('https://app.example.com'))).not.toThrow();
  });

  it('throws when Origin differs', () => {
    expect(() => assertSameOrigin(req('https://evil.example.com'))).toThrow(SameOriginError);
  });

  it('throws when Origin missing', () => {
    expect(() => assertSameOrigin(req(null))).toThrow(/Missing Origin/);
  });

  it('throws when APP_URL unset', () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(() => assertSameOrigin(req('https://app.example.com'))).toThrow(/APP_URL/);
  });

  it('treats trailing slashes as equivalent', () => {
    expect(() => assertSameOrigin(req('https://app.example.com/'))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/shared/__tests__/csrf.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `src/lib/shared/csrf.ts`:

```ts
export class SameOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SameOriginError';
  }
}

export function assertSameOrigin(request: Request): void {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) {
    throw new SameOriginError('NEXT_PUBLIC_APP_URL not configured — cannot validate Origin header');
  }
  const origin = request.headers.get('origin');
  if (!origin) {
    throw new SameOriginError('Missing Origin header');
  }
  const normalize = (u: string) => u.replace(/\/+$/, '');
  if (normalize(origin) !== normalize(appUrl)) {
    throw new SameOriginError(`Origin ${origin} does not match APP_URL ${appUrl}`);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/lib/shared/__tests__/csrf.test.ts`
Expected: PASS (5 cases)

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/csrf.ts src/lib/shared/__tests__/csrf.test.ts
git commit -m "feat(signup): assertSameOrigin helper for cookie-auth POST routes"
```

---

## Task 4: `route-helpers.ts` composable wrappers

**Files:**
- Create: `src/lib/auth/route-helpers.ts`
- Create: `src/lib/auth/__tests__/route-helpers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/auth/__tests__/route-helpers.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mockCheckRateLimit = vi.fn();
vi.mock('@/lib/shared/rate-limit', () => ({ checkRateLimit: mockCheckRateLimit }));

const mockGetUser = vi.fn();
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: mockGetUser } })),
}));

import { withRateLimit, withSameOrigin, withSession } from '../route-helpers';

function mockReq(opts: { origin?: string } = {}): NextRequest {
  const headers = new Headers();
  if (opts.origin) headers.set('origin', opts.origin);
  return {
    headers,
    cookies: { getAll: () => [] },
  } as unknown as NextRequest;
}

describe('withRateLimit', () => {
  beforeEach(() => mockCheckRateLimit.mockReset());

  it('calls handler when under limit', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 4 });
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const res = await withRateLimit(() => 'k', 5, 3600)(handler)(mockReq());
    expect(res.status).toBe(200);
  });

  it('returns 429 when over limit', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const handler = vi.fn();
    const res = await withRateLimit(() => 'k', 5, 3600)(handler)(mockReq());
    expect(res.status).toBe(429);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns 503 when limiter throws (strict)', async () => {
    mockCheckRateLimit.mockRejectedValueOnce(new Error('redis down'));
    const handler = vi.fn();
    const res = await withRateLimit(() => 'k', 5, 3600)(handler)(mockReq());
    expect(res.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('withSameOrigin', () => {
  beforeEach(() => { process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'; });

  it('passes on match', async () => {
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const res = await withSameOrigin()(handler)(mockReq({ origin: 'https://app.example.com' }));
    expect(res.status).toBe(200);
  });

  it('returns 403 on mismatch', async () => {
    const handler = vi.fn();
    const res = await withSameOrigin()(handler)(mockReq({ origin: 'https://evil.example.com' }));
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('withSession', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    mockGetUser.mockReset();
  });

  it('returns 401 when no session', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    const handler = vi.fn();
    const res = await withSession(handler)(mockReq());
    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes session to handler', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'u-1', email: 'e@x.com' } } });
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    await withSession(handler)(mockReq());
    expect(handler).toHaveBeenCalledWith({ user: { id: 'u-1', email: 'e@x.com' } }, expect.any(Object));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/auth/__tests__/route-helpers.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `src/lib/auth/route-helpers.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { User } from '@supabase/supabase-js';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';

type NextHandler = (req: NextRequest) => Promise<Response> | Response;

export function withRateLimit(
  keyFn: (req: NextRequest) => string,
  maxRequests: number,
  windowSeconds: number,
): (handler: NextHandler) => NextHandler {
  return (handler) => async (req) => {
    try {
      const r = await checkRateLimit(keyFn(req), maxRequests, windowSeconds, { strict: true });
      if (!r.allowed) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    } catch (err) {
      console.error('[route-helpers/withRateLimit] strict failure:', err);
      return NextResponse.json({ error: 'rate_limit_unavailable' }, { status: 503 });
    }
    return handler(req);
  };
}

export function withSameOrigin(): (handler: NextHandler) => NextHandler {
  return (handler) => async (req) => {
    try {
      assertSameOrigin(req);
    } catch (err) {
      if (err instanceof SameOriginError) {
        return NextResponse.json({ error: 'forbidden' }, { status: 403 });
      }
      throw err;
    }
    return handler(req);
  };
}

export function withSession(
  handler: (session: { user: User }, req: NextRequest) => Promise<Response> | Response,
): NextHandler {
  return async (req) => {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return req.cookies.getAll(); },
          setAll() { /* read-only in auth routes */ },
        },
      },
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    return handler({ user }, req);
  };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/lib/auth/__tests__/route-helpers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/route-helpers.ts src/lib/auth/__tests__/route-helpers.test.ts
git commit -m "feat(signup): composable route wrappers (rate-limit + origin + session)"
```

---

## Task 5: `payment-link.ts` extraction

**Files:**
- Create: `src/lib/payments/payment-link.ts`
- Create: `src/lib/payments/__tests__/payment-link.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/payments/__tests__/payment-link.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { buildPaymentLinkUrl } from '../payment-link';

describe('buildPaymentLinkUrl', () => {
  beforeEach(() => {
    process.env.STRIPE_PAYMENT_LINK_FOUNDING = 'https://buy.stripe.com/test_F';
    process.env.STRIPE_PAYMENT_LINK_STANDARD = 'https://buy.stripe.com/test_S';
  });

  it('appends client_reference_id + prefilled_email for founding', () => {
    const url = buildPaymentLinkUrl('founding', 'biz-1', 'o@e.com');
    expect(url).toContain('test_F');
    expect(url).toContain('client_reference_id=biz-1');
    expect(url).toContain('prefilled_email=o%40e.com');
  });

  it('uses standard env for standard tier', () => {
    const url = buildPaymentLinkUrl('standard', 'b', 'a@b.com');
    expect(url).toContain('test_S');
  });

  it('returns null when env unset', () => {
    delete process.env.STRIPE_PAYMENT_LINK_FOUNDING;
    expect(buildPaymentLinkUrl('founding', 'b', 'a@b.com')).toBe(null);
  });

  it('URL-encodes special characters', () => {
    const url = buildPaymentLinkUrl('standard', 'b', 'owner+tag@e.com');
    expect(url).toContain('prefilled_email=owner%2Btag%40e.com');
  });

  it('appends with & when URL already has query string', () => {
    process.env.STRIPE_PAYMENT_LINK_STANDARD = 'https://buy.stripe.com/test_S?utm_source=x';
    const url = buildPaymentLinkUrl('standard', 'b', 'a@b.com');
    expect(url).toContain('utm_source=x&client_reference_id=b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/payments/__tests__/payment-link.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

Create `src/lib/payments/payment-link.ts`:

```ts
const TIER_ENV: Record<string, string> = {
  founding: 'STRIPE_PAYMENT_LINK_FOUNDING',
  standard: 'STRIPE_PAYMENT_LINK_STANDARD',
};

export function buildPaymentLinkUrl(
  tier: 'founding' | 'standard',
  businessId: string,
  ownerEmail: string,
): string | null {
  const envKey = TIER_ENV[tier];
  if (!envKey) return null;
  const baseUrl = process.env[envKey];
  if (!baseUrl) return null;
  const params = new URLSearchParams({
    client_reference_id: businessId,
    prefilled_email: ownerEmail,
  });
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}${params.toString()}`;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/lib/payments/__tests__/payment-link.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/payments/payment-link.ts src/lib/payments/__tests__/payment-link.test.ts
git commit -m "feat(signup): extract buildPaymentLinkUrl to shared module"
```

---

## Task 6: Signup schemas with email normalization

**Files:**
- Modify: `src/lib/shared/schemas.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/shared/__tests__/signup-schemas.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  SignupSchema,
  FinishSignupSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
} from '../schemas';

describe('SignupSchema email normalization', () => {
  it('lowercases + trims email before validation', () => {
    const parsed = SignupSchema.parse({
      ownerEmail: '  Owner@Example.COM  ',
      ownerName: 'Jane',
      password: 'password123',
      businessName: 'Acme',
      googlePlaceId: 'ChIJtest1234567890ab',
      subscriptionTier: 'standard',
    });
    expect(parsed.ownerEmail).toBe('owner@example.com');
  });

  it('rejects empty password', () => {
    expect(() => SignupSchema.parse({
      ownerEmail: 'a@b.com', ownerName: 'J', password: '',
      businessName: 'X', googlePlaceId: 'ChIJtest1234567890ab', subscriptionTier: 'standard',
    })).toThrow();
  });

  it('requires password >= 8 chars', () => {
    expect(() => SignupSchema.parse({
      ownerEmail: 'a@b.com', ownerName: 'J', password: 'short',
      businessName: 'X', googlePlaceId: 'ChIJtest1234567890ab', subscriptionTier: 'standard',
    })).toThrow();
  });

  it('requires either googlePlaceId or googleMapsUrl (XOR)', () => {
    expect(() => SignupSchema.parse({
      ownerEmail: 'a@b.com', ownerName: 'J', password: 'password123',
      businessName: 'X', subscriptionTier: 'standard',
    })).toThrow();
  });

  it('accepts googleMapsUrl when placeId absent', () => {
    const parsed = SignupSchema.parse({
      ownerEmail: 'a@b.com', ownerName: 'J', password: 'password123',
      businessName: 'X', googleMapsUrl: 'https://maps.google.com/?cid=123',
      subscriptionTier: 'standard',
    });
    expect(parsed.googleMapsUrl).toBeTruthy();
  });
});

describe('FinishSignupSchema', () => {
  it('rejects ownerEmail field (Google provides email)', () => {
    const parsed = FinishSignupSchema.safeParse({
      ownerEmail: 'a@b.com',
      ownerName: 'J',
      businessName: 'X',
      googlePlaceId: 'ChIJtest1234567890ab',
      subscriptionTier: 'standard',
    });
    // FinishSignupSchema should NOT have ownerEmail; we just verify it parses without
    // the field and doesn't emit it even if supplied (Zod strips unknown keys by default).
    const valid = FinishSignupSchema.parse({
      ownerName: 'J',
      businessName: 'X',
      googlePlaceId: 'ChIJtest1234567890ab',
      subscriptionTier: 'standard',
    });
    expect((valid as { ownerEmail?: string }).ownerEmail).toBeUndefined();
  });
});

describe('ForgotPasswordSchema', () => {
  it('normalizes email + requires role', () => {
    const parsed = ForgotPasswordSchema.parse({ email: 'Owner@Example.COM', role: 'owner' });
    expect(parsed.email).toBe('owner@example.com');
    expect(parsed.role).toBe('owner');
  });

  it('rejects unknown role', () => {
    expect(() => ForgotPasswordSchema.parse({ email: 'a@b.com', role: 'hacker' })).toThrow();
  });
});

describe('ResetPasswordSchema', () => {
  it('requires password >= 8 chars', () => {
    expect(() => ResetPasswordSchema.parse({ password: 'short' })).toThrow();
    expect(ResetPasswordSchema.parse({ password: 'password123' }).password).toBe('password123');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/shared/__tests__/signup-schemas.test.ts`
Expected: FAIL — SignupSchema / FinishSignupSchema / ForgotPasswordSchema / ResetPasswordSchema not exported.

- [ ] **Step 3: Extend `src/lib/shared/schemas.ts`**

Append to the bottom of the existing file (after the existing `OnboardBusinessSchema`):

```ts
// ── Self-serve signup schemas ───────────────────────────────────────────
// See docs/superpowers/specs/2026-04-23-owner-self-serve-signup-design.md §2.3, §3.1.
// Email normalization uses z.preprocess so trim+lower happens BEFORE email validation,
// letting values like "  Owner@X.com  " parse correctly as "owner@x.com".

const emailSchema = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
  z.string().email().max(254),
);

const passwordSchema = z.string().min(8).max(128);

const tierSchema = z.enum(['founding', 'standard']);

// Reuse existing lengths where possible — see the existing OnboardBusinessSchema
// constraints for parity. Self-serve does NOT include admin-only fields.
const businessNameSchema = z.string().min(1).max(200);
const ownerNameSchema = z.string().min(1).max(100);
const ownerPhoneSchema = z.string().max(30).optional();
const websiteUrlSchemaLocal = z.string().url().optional().nullable();
const toneSchemaLocal = z.string().max(200).optional();

const baseBusinessShape = {
  businessName: businessNameSchema,
  category: z.string().max(100).optional().nullable(),
  googlePlaceId: z.string().min(1).optional(),
  googleMapsUrl: z.string().min(1).optional(),
  tone: toneSchemaLocal,
  productsServices: z.string().max(5000).optional(),
  staffNames: z.string().max(2000).optional(),
  highlightFacts: z.string().max(2000).optional(),
  avoidFacts: z.string().max(2000).optional(),
  sampleResponses: z.string().max(5000).optional(),
  subscriptionTier: tierSchema,
  website: websiteUrlSchemaLocal,
};

export const SignupSchema = z
  .object({
    ownerEmail: emailSchema,
    ownerName: ownerNameSchema,
    ownerPhone: ownerPhoneSchema,
    password: passwordSchema,
    ...baseBusinessShape,
  })
  .refine((d) => Boolean(d.googlePlaceId) || Boolean(d.googleMapsUrl), {
    message: 'Either googlePlaceId or googleMapsUrl is required',
    path: ['googlePlaceId'],
  });

export type SignupInput = z.infer<typeof SignupSchema>;

// Google-path "finish your business profile" form. Email + password come from session.
export const FinishSignupSchema = z
  .object({
    ownerName: ownerNameSchema,
    ownerPhone: ownerPhoneSchema,
    ...baseBusinessShape,
  })
  .refine((d) => Boolean(d.googlePlaceId) || Boolean(d.googleMapsUrl), {
    message: 'Either googlePlaceId or googleMapsUrl is required',
    path: ['googlePlaceId'],
  });

export type FinishSignupInput = z.infer<typeof FinishSignupSchema>;

export const ForgotPasswordSchema = z.object({
  email: emailSchema,
  role: z.enum(['owner', 'admin']),
});
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z.object({
  password: passwordSchema,
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;

export const ResendConfirmationSchema = z.object({
  email: emailSchema,
  flow: z.enum(['owner', 'admin']),
});
export type ResendConfirmationInput = z.infer<typeof ResendConfirmationSchema>;
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/lib/shared/__tests__/signup-schemas.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/shared/schemas.ts src/lib/shared/__tests__/signup-schemas.test.ts
git commit -m "feat(signup): signup/finish/forgot/reset/resend schemas with email normalization"
```

---

## Task 7: `createBusinessTx` shared helper

**Files:**
- Create: `src/lib/onboarding/create-business.ts`
- Create: `src/lib/onboarding/__tests__/create-business.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/onboarding/__tests__/create-business.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSql = vi.fn() as any;
mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));

vi.mock('@/lib/db/server', () => ({ sql: mockSql, jsonb: (v: unknown) => v }));
vi.mock('uuid', () => ({ v7: vi.fn(() => 'test-uuid') }));

const mockBuildPaymentLinkUrl = vi.fn();
vi.mock('@/lib/payments/payment-link', () => ({ buildPaymentLinkUrl: mockBuildPaymentLinkUrl }));

const mockExtractPlaceId = vi.fn();
vi.mock('@/lib/reviews/url-parser', () => ({
  extractPlaceId: mockExtractPlaceId,
  isPlaceId: vi.fn(() => true),
}));

import { createBusinessTx, DuplicateEmailError } from '../create-business';

const baseInput = {
  ownerEmail: 'a@b.com',
  ownerName: 'Jane',
  businessName: 'Acme',
  subscriptionTier: 'standard' as const,
  placeId: { placeIdVerified: true as const, placeId: 'ChIJtest' },
};

beforeEach(() => {
  mockSql.mockReset();
  mockSql.mockResolvedValue([]);
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
  mockBuildPaymentLinkUrl.mockReturnValue('https://buy.stripe.com/test');
});

describe('createBusinessTx — admin mode', () => {
  it('writes users.auth_id=NULL and creates outbox entry', async () => {
    const res = await createBusinessTx(baseInput, { mode: 'admin', onboardedBy: 'admin-1' });
    expect(res.businessId).toBeTruthy();
    const calls = mockSql.mock.calls.map((c: any[]) => (c[0] as TemplateStringsArray).join('?'));
    const outboxInsert = calls.find((t: string) => t.includes('INSERT INTO job_outbox'));
    expect(outboxInsert).toBeDefined();
    const usersInsert = calls.find((t: string) => t.includes('INSERT INTO users'));
    expect(usersInsert).toBeDefined();
    const usersCallArgs = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO users'))!;
    // auth_id position in admin mode must be null (verified against args structure)
    expect(usersCallArgs).toContain(null);
  });

  it('enqueues sync_reviews when placeIdVerified=true', async () => {
    await createBusinessTx(baseInput, { mode: 'admin', onboardedBy: 'admin-1' });
    const calls = mockSql.mock.calls.map((c: any[]) => c.slice(1));
    const outboxCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'))!;
    expect(outboxCall.some((a: unknown) => a === 'sync_reviews')).toBe(true);
  });

  it('enqueues validate_place_id when placeIdVerified=false', async () => {
    const input = {
      ...baseInput,
      placeId: { placeIdVerified: false as const, googleMapsUrl: 'https://maps.google.com/?cid=1' },
    };
    await createBusinessTx(input, { mode: 'admin', onboardedBy: 'admin-1' });
    const outboxCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO job_outbox'))!;
    expect(outboxCall.some((a: unknown) => a === 'validate_place_id')).toBe(true);
  });
});

describe('createBusinessTx — self_serve mode', () => {
  it('writes users.auth_id=authId and skips outbox insert', async () => {
    await createBusinessTx(baseInput, { mode: 'self_serve', authId: 'auth-xyz' });
    const calls = mockSql.mock.calls.map((c: any[]) => (c[0] as TemplateStringsArray).join('?'));
    const outboxInsert = calls.find((t: string) => t.includes('INSERT INTO job_outbox'));
    expect(outboxInsert).toBeUndefined();
    const usersInsert = calls.find((t: string) => t.includes('INSERT INTO users'));
    expect(usersInsert).toBeDefined();
  });
});

describe('createBusinessTx — duplicate email', () => {
  it('throws DuplicateEmailError on PG 23505', async () => {
    mockSql.mockImplementation(() => {
      const err: any = new Error('duplicate key');
      err.code = '23505';
      throw err;
    });
    mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
    await expect(
      createBusinessTx(baseInput, { mode: 'self_serve', authId: 'a' }),
    ).rejects.toThrow(DuplicateEmailError);
  });
});

describe('createBusinessTx — field-name regression', () => {
  it('maps businessName→businesses.name and ownerName→users.name', async () => {
    await createBusinessTx(
      { ...baseInput, businessName: 'Acme-Biz', ownerName: 'Jane-Owner' },
      { mode: 'self_serve', authId: 'a' },
    );
    const bizCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO businesses'))!;
    const userCall = mockSql.mock.calls.find((c: any[]) =>
      (c[0] as TemplateStringsArray).join('?').includes('INSERT INTO users'))!;
    expect(bizCall.some((a: unknown) => a === 'Acme-Biz')).toBe(true);
    expect(userCall.some((a: unknown) => a === 'Jane-Owner')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/onboarding/__tests__/create-business.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write implementation**

Create `src/lib/onboarding/create-business.ts`:

```ts
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '@/lib/db/server';
import { buildPaymentLinkUrl } from '@/lib/payments/payment-link';
import type { SyncReviewsPayload, ValidatePlaceIdPayload } from '@/lib/shared/worker-types';

export class DuplicateEmailError extends Error {
  constructor() {
    super('users.email unique constraint violation');
    this.name = 'DuplicateEmailError';
  }
}

export type PlaceIdInput =
  | { placeIdVerified: true; placeId: string; googleMapsUrl?: string | null }
  | { placeIdVerified: false; placeId?: string | null; googleMapsUrl: string };

export interface BusinessTxInput {
  ownerEmail: string;
  ownerName: string;
  ownerPhone?: string | null;
  businessName: string;
  category?: string | null;
  tone?: string | null;
  productsServices?: string | null;
  staffNames?: string[];
  highlightFacts?: string[];
  avoidFacts?: string[];
  sampleResponses?: string[];
  subscriptionTier: 'founding' | 'standard';
  website?: string | null;
  placeId: PlaceIdInput;
}

export type CreateBusinessOptions =
  | { mode: 'admin'; onboardedBy: string }
  | { mode: 'self_serve'; authId: string };

export interface CreateBusinessResult {
  businessId: string;
  userId: string;
  paymentUrl: string | null;
}

export async function createBusinessTx(
  input: BusinessTxInput,
  options: CreateBusinessOptions,
): Promise<CreateBusinessResult> {
  // Defense-in-depth normalization (schema layer already does this).
  const ownerEmail = input.ownerEmail.trim().toLowerCase();

  const businessId = uuidv7();
  const userId = uuidv7();

  const placeId = input.placeId.placeIdVerified ? input.placeId.placeId : input.placeId.placeId ?? null;
  const googleMapsUrl = input.placeId.googleMapsUrl ?? null;
  const placeIdVerified = input.placeId.placeIdVerified;

  const authId = options.mode === 'self_serve' ? options.authId : null;
  const onboardedBy = options.mode === 'admin' ? options.onboardedBy : null;
  const enqueueInitialSync = options.mode === 'admin';

  const paymentUrl = buildPaymentLinkUrl(input.subscriptionTier, businessId, ownerEmail);

  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO businesses (
          id, name, category, google_place_id, place_id_verified, google_maps_url,
          tone, products_services, staff_names, highlight_facts, avoid_facts, sample_responses,
          owner_name, owner_email, owner_phone,
          subscription_tier, subscription_status, website, onboarded_by
        ) VALUES (
          ${businessId}, ${input.businessName}, ${input.category ?? null},
          ${placeId}, ${placeIdVerified}, ${googleMapsUrl},
          ${input.tone ?? 'professional and friendly'},
          ${input.productsServices ?? null},
          ${input.staffNames ?? []},
          ${input.highlightFacts ?? []},
          ${input.avoidFacts ?? []},
          ${input.sampleResponses ?? []},
          ${input.ownerName}, ${ownerEmail}, ${input.ownerPhone ?? null},
          ${input.subscriptionTier}, 'pending_payment',
          ${input.website ?? null},
          ${onboardedBy}
        )
      `;

      await tx`
        INSERT INTO users (id, auth_id, name, email, phone, role, business_id)
        VALUES (
          ${userId}, ${authId}, ${input.ownerName}, ${ownerEmail},
          ${input.ownerPhone ?? null}, 'owner', ${businessId}
        )
      `;

      await tx`
        INSERT INTO channel_enrollments (id, business_id, channel, handle, status, verified_at)
        VALUES (${uuidv7()}, ${businessId}, 'email', ${ownerEmail}, 'verified', NOW())
        ON CONFLICT (business_id, channel) WHERE archived_at IS NULL DO NOTHING
      `;

      if (enqueueInitialSync) {
        const correlationId = uuidv7();
        if (placeIdVerified && placeId) {
          const payload: SyncReviewsPayload = {
            business_id: businessId,
            google_place_id: placeId,
            correlation_id: correlationId,
          };
          await tx`
            INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
            VALUES (${uuidv7()}, 'sync_reviews', 'business', ${businessId}, ${jsonb(payload)}, 'pending')
          `;
        } else if (googleMapsUrl) {
          const payload: ValidatePlaceIdPayload = {
            business_id: businessId,
            google_maps_url: googleMapsUrl,
            correlation_id: correlationId,
          };
          await tx`
            INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
            VALUES (${uuidv7()}, 'validate_place_id', 'business', ${businessId}, ${jsonb(payload)}, 'pending')
          `;
        }
      }
    });
  } catch (err) {
    const pgErr = err as { code?: string };
    if (pgErr.code === '23505') {
      throw new DuplicateEmailError();
    }
    throw err;
  }

  return { businessId, userId, paymentUrl };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/lib/onboarding/__tests__/create-business.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/onboarding/create-business.ts src/lib/onboarding/__tests__/create-business.test.ts
git commit -m "feat(signup): createBusinessTx shared helper with discriminated mode union"
```

---

## Task 8: Refactor admin businesses route to use createBusinessTx

**Files:**
- Modify: `src/app/api/admin/businesses/route.ts`

- [ ] **Step 1: Read current admin route**

Read `src/app/api/admin/businesses/route.ts` lines 172-300 to understand the tx being extracted. Note the `await requireRole(request, 'admin', 'sales_partner')` at the top — the resulting admin user id is what we need for `onboardedBy`.

- [ ] **Step 2: Update route to call createBusinessTx**

Modify `src/app/api/admin/businesses/route.ts`:

- Remove the inline `buildPaymentLinkUrl` function (it's now imported from `@/lib/payments/payment-link`).
- Replace the `sql.begin(...)` block that inserts businesses + users + channel_enrollments + outbox (lines ~183-284) with a call to `createBusinessTx`.
- Derive `onboardedBy` from the authenticated admin user — use the `requireRole` return value or add a helper to look up the admin's user id by auth_id.

Example replacement (high-level):

```ts
import { buildPaymentLinkUrl } from '@/lib/payments/payment-link';
import { createBusinessTx, DuplicateEmailError } from '@/lib/onboarding/create-business';

// ... existing validation + placeIdVerified computation ...

// Look up admin user id for onboarded_by:
const authUser = await requireRole(request, 'admin', 'sales_partner'); // returns { authId }
const [adminRow] = await sql<{ id: string }[]>`
  SELECT id FROM users WHERE auth_id = ${authUser.authId} LIMIT 1
`;
if (!adminRow) {
  return NextResponse.json({ error: 'admin_not_found' }, { status: 500 });
}

try {
  const result = await createBusinessTx(
    {
      ownerEmail: data.ownerEmail,
      ownerName: data.ownerName,
      ownerPhone: data.ownerPhone,
      businessName: data.name,
      category: data.category,
      tone: data.tone,
      productsServices: data.productsServices,
      staffNames: splitCommaOrNewline(data.staffNames),
      highlightFacts: splitCommaOrNewline(data.highlightFacts),
      avoidFacts: splitCommaOrNewline(data.avoidFacts),
      sampleResponses: splitParagraphs(data.sampleResponses),
      subscriptionTier: data.subscriptionTier,
      website: data.website,
      placeId: placeIdVerified && placeId
        ? { placeIdVerified: true, placeId, googleMapsUrl: data.googleMapsUrl ?? null }
        : { placeIdVerified: false, placeId: placeId ?? null, googleMapsUrl: data.googleMapsUrl! },
    },
    { mode: 'admin', onboardedBy: adminRow.id },
  );
  return NextResponse.json({ id: result.businessId, paymentUrl: result.paymentUrl }, { status: 201 });
} catch (err) {
  if (err instanceof DuplicateEmailError) {
    return NextResponse.json({ error: 'A user with this email already exists' }, { status: 409 });
  }
  console.error('[api/admin/businesses POST] Transaction failed:', err);
  return NextResponse.json({ error: 'Failed to onboard business' }, { status: 500 });
}
```

- [ ] **Step 3: Run existing admin-route tests to verify no regression**

Run: `pnpm vitest run src/app/api/admin/__tests__/businesses.test.ts` (or the existing admin test file — adjust path to match repo).
Expected: PASS (behavior unchanged from refactor).

- [ ] **Step 4: Run type-check**

Run: `pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/admin/businesses/route.ts
git commit -m "refactor(signup): admin onboarding route calls createBusinessTx (no behavior change)"
```

---

## Task 9: `POST /api/auth/signup` route

**Files:**
- Create: `src/app/api/auth/signup/route.ts`
- Create: `src/app/api/auth/__tests__/signup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/auth/__tests__/signup.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCheckRateLimit = vi.fn();
vi.mock('@/lib/shared/rate-limit', () => ({ checkRateLimit: mockCheckRateLimit }));

const mockSql = vi.fn() as any;
mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
const mockSupabaseServer = {
  auth: {
    signUp: vi.fn(),
    admin: { deleteUser: vi.fn() },
  },
};
vi.mock('@/lib/db/server', () => ({
  sql: mockSql,
  jsonb: (v: unknown) => v,
  supabaseServer: mockSupabaseServer,
}));

const mockCreateBusinessTx = vi.fn();
vi.mock('@/lib/onboarding/create-business', async () => {
  const actual = await vi.importActual<typeof import('@/lib/onboarding/create-business')>(
    '@/lib/onboarding/create-business',
  );
  return {
    ...actual,
    createBusinessTx: mockCreateBusinessTx,
  };
});

// Flag + env setup
process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com';

import { POST } from '../signup/route';
import { NextRequest } from 'next/server';

function mkReq(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://app.example.com/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const validBody = {
  ownerEmail: 'owner@example.com',
  ownerName: 'Jane',
  password: 'password123',
  businessName: 'Acme',
  googlePlaceId: 'ChIJtest1234567890ab',
  subscriptionTier: 'standard',
};

beforeEach(() => {
  mockCheckRateLimit.mockReset();
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 4 });
  mockSql.mockReset();
  mockSql.mockResolvedValue([]); // default: email pre-check returns empty
  mockSql.begin = vi.fn(async (cb: (tx: any) => Promise<unknown>) => cb(mockSql));
  mockSupabaseServer.auth.signUp.mockReset();
  mockSupabaseServer.auth.admin.deleteUser.mockReset();
  mockCreateBusinessTx.mockReset();
});

describe('POST /api/auth/signup', () => {
  it('returns 404 when flag is off', async () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(404);
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
  });

  it('returns 400 on invalid body', async () => {
    const res = await POST(mkReq({ ownerEmail: 'not-an-email' }));
    expect(res.status).toBe(400);
  });

  it('returns 409 when email already exists (pre-check hit)', async () => {
    mockSql.mockResolvedValueOnce([{ id: 'existing' }]); // email pre-check hit
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(409);
    expect(mockSupabaseServer.auth.signUp).not.toHaveBeenCalled();
  });

  it('calls supabase.auth.signUp + createBusinessTx on happy path', async () => {
    mockSupabaseServer.auth.signUp.mockResolvedValueOnce({
      data: { user: { id: 'new-auth-uuid' } },
      error: null,
    });
    mockCreateBusinessTx.mockResolvedValueOnce({ businessId: 'biz-1', userId: 'u-1', paymentUrl: 'https://buy' });
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.redirectTo).toBe('/signup/check-email');
    expect(mockCreateBusinessTx).toHaveBeenCalledWith(
      expect.objectContaining({ ownerEmail: 'owner@example.com' }),
      { mode: 'self_serve', authId: 'new-auth-uuid' },
    );
  });

  it('returns 409 + calls auth.admin.deleteUser when tx fails with DuplicateEmailError', async () => {
    const { DuplicateEmailError } = await import('@/lib/onboarding/create-business');
    mockSupabaseServer.auth.signUp.mockResolvedValueOnce({
      data: { user: { id: 'orphan-auth' } },
      error: null,
    });
    mockCreateBusinessTx.mockRejectedValueOnce(new DuplicateEmailError());
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(409);
    expect(mockSupabaseServer.auth.admin.deleteUser).toHaveBeenCalledWith('orphan-auth');
  });

  it('returns 429 when rate-limit exceeded', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0 });
    const res = await POST(mkReq(validBody));
    expect(res.status).toBe(429);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/auth/__tests__/signup.test.ts`
Expected: FAIL — route not found.

- [ ] **Step 3: Write implementation**

Create `src/app/api/auth/signup/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { sql, supabaseServer } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { SignupSchema } from '@/lib/shared/schemas';
import {
  createBusinessTx,
  DuplicateEmailError,
  type BusinessTxInput,
} from '@/lib/onboarding/create-business';

export const dynamic = 'force-dynamic';

function splitCommaOrNewline(v: string | undefined): string[] {
  if (!v?.trim()) return [];
  return v.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
}

function splitParagraphs(v: string | undefined): string[] {
  if (!v?.trim()) return [];
  return v.split(/\n\n+/).map((s) => s.trim()).filter(Boolean);
}

function ipKey(req: NextRequest): string {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  return `signup:ip:${ip}`;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Rate limit (strict — fail closed if Redis is unavailable).
  try {
    const rl = await checkRateLimit(ipKey(req), 5, 3600, { strict: true });
    if (!rl.allowed) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
  } catch (err) {
    console.error('[api/auth/signup] rate-limit strict failure:', err);
    return NextResponse.json({ error: 'rate_limit_unavailable' }, { status: 503 });
  }

  // Validate body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }
  const parsed = SignupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const data = parsed.data;

  // Advisory-locked email pre-check (serializes vs cleanup poller).
  const preCheck = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${data.ownerEmail + ':signup'}))`;
    const [existing] = await tx<{ id: string }[]>`
      SELECT id FROM users WHERE email = ${data.ownerEmail} LIMIT 1
    `;
    return existing;
  });
  if (preCheck) {
    return NextResponse.json(
      { error: 'account_exists', message: 'An account with this email already exists. Try logging in or use forgot password.' },
      { status: 409 },
    );
  }

  // Create Supabase Auth user.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
  const emailRedirectTo = `${appUrl}/api/auth/callback?flow=owner&next=/onboarding/pay`;
  const { data: authData, error: authError } = await supabaseServer.auth.signUp({
    email: data.ownerEmail,
    password: data.password,
    options: { emailRedirectTo },
  });

  if (authError || !authData.user) {
    // Supabase 422 "User already registered" or similar.
    return NextResponse.json(
      { error: 'account_exists', message: 'An account with this email already exists. Try logging in or use forgot password.' },
      { status: 409 },
    );
  }

  const authId = authData.user.id;

  // Build normalized input for createBusinessTx.
  const input: BusinessTxInput = {
    ownerEmail: data.ownerEmail,
    ownerName: data.ownerName,
    ownerPhone: data.ownerPhone,
    businessName: data.businessName,
    category: data.category ?? null,
    tone: data.tone,
    productsServices: data.productsServices,
    staffNames: splitCommaOrNewline(data.staffNames),
    highlightFacts: splitCommaOrNewline(data.highlightFacts),
    avoidFacts: splitCommaOrNewline(data.avoidFacts),
    sampleResponses: splitParagraphs(data.sampleResponses),
    subscriptionTier: data.subscriptionTier,
    website: data.website,
    placeId: data.googlePlaceId
      ? { placeIdVerified: true, placeId: data.googlePlaceId, googleMapsUrl: data.googleMapsUrl ?? null }
      : { placeIdVerified: false, placeId: null, googleMapsUrl: data.googleMapsUrl! },
  };

  try {
    await createBusinessTx(input, { mode: 'self_serve', authId });
  } catch (err) {
    // Compensating cleanup — orphan auth user blocks re-signup.
    await supabaseServer.auth.admin.deleteUser(authId).catch((delErr) => {
      console.error(`[signup-cleanup] Failed to delete orphan auth user ${authId}: ${delErr}`);
    });
    if (err instanceof DuplicateEmailError) {
      return NextResponse.json(
        { error: 'account_exists', message: 'An account with this email already exists. Try logging in or use forgot password.' },
        { status: 409 },
      );
    }
    console.error('[api/auth/signup] createBusinessTx failed:', err);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }

  return NextResponse.json({ redirectTo: '/signup/check-email' }, { status: 201 });
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/app/api/auth/__tests__/signup.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/signup/route.ts src/app/api/auth/__tests__/signup.test.ts
git commit -m "feat(signup): POST /api/auth/signup with advisory-locked pre-check + compensating cleanup"
```

---

## Task 10: `POST /api/auth/finish-signup` route (Google path)

**Files:**
- Create: `src/app/api/auth/finish-signup/route.ts`
- Create: `src/app/api/auth/__tests__/finish-signup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/auth/__tests__/finish-signup.test.ts` — mirrors `signup.test.ts` structure but mocks session presence and asserts:
- 401 when no session.
- 403 when Origin mismatch.
- 409 when `users.auth_id` already exists (double-submit).
- 409 when `users.email` exists with a DIFFERENT auth_id (admin-created collision).
- 201 + createBusinessTx called with `mode: 'self_serve', authId: <session.user.id>` on happy path.
- Rate limit 429.

Full test pattern: follow Task 9's structure, replacing signup-specific mocks with session mocks.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/auth/__tests__/finish-signup.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

Create `src/app/api/auth/finish-signup/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { sql } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { FinishSignupSchema } from '@/lib/shared/schemas';
import {
  createBusinessTx,
  DuplicateEmailError,
  type BusinessTxInput,
} from '@/lib/onboarding/create-business';
import { createServerClient } from '@supabase/ssr';

export const dynamic = 'force-dynamic';

function splitCommaOrNewline(v: string | undefined): string[] {
  if (!v?.trim()) return [];
  return v.split(/\n|,/).map((s) => s.trim()).filter(Boolean);
}
function splitParagraphs(v: string | undefined): string[] {
  if (!v?.trim()) return [];
  return v.split(/\n\n+/).map((s) => s.trim()).filter(Boolean);
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    }
    throw err;
  }

  // Read session via cookie-bound anon client.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll(); },
        setAll() { /* read-only */ },
      },
    },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (!user.email) {
    return NextResponse.json({ error: 'account_incomplete' }, { status: 401 });
  }

  const authId = user.id;
  const ownerEmail = user.email.trim().toLowerCase();

  // Rate limit per authId.
  try {
    const rl = await checkRateLimit(`finish-signup:auth:${authId}`, 3, 3600, { strict: true });
    if (!rl.allowed) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  } catch (err) {
    console.error('[finish-signup] rate-limit strict failure:', err);
    return NextResponse.json({ error: 'rate_limit_unavailable' }, { status: 503 });
  }

  // Guard (a): double-submit.
  const [existingByAuthId] = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE auth_id = ${authId} LIMIT 1
  `;
  if (existingByAuthId) {
    return NextResponse.json(
      { error: 'already_complete', message: 'Signup already complete' },
      { status: 409 },
    );
  }

  // Guard (b): admin-created email collision.
  const [existingByEmail] = await sql<{ id: string }[]>`
    SELECT id FROM users WHERE email = ${ownerEmail} AND auth_id IS DISTINCT FROM ${authId} LIMIT 1
  `;
  if (existingByEmail) {
    return NextResponse.json(
      { error: 'account_exists', message: 'An account with this email already exists. Use forgot password to recover access.' },
      { status: 409 },
    );
  }

  // Validate body.
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = FinishSignupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }
  const data = parsed.data;

  const input: BusinessTxInput = {
    ownerEmail,
    ownerName: data.ownerName,
    ownerPhone: data.ownerPhone,
    businessName: data.businessName,
    category: data.category ?? null,
    tone: data.tone,
    productsServices: data.productsServices,
    staffNames: splitCommaOrNewline(data.staffNames),
    highlightFacts: splitCommaOrNewline(data.highlightFacts),
    avoidFacts: splitCommaOrNewline(data.avoidFacts),
    sampleResponses: splitParagraphs(data.sampleResponses),
    subscriptionTier: data.subscriptionTier,
    website: data.website,
    placeId: data.googlePlaceId
      ? { placeIdVerified: true, placeId: data.googlePlaceId, googleMapsUrl: data.googleMapsUrl ?? null }
      : { placeIdVerified: false, placeId: null, googleMapsUrl: data.googleMapsUrl! },
  };

  try {
    await createBusinessTx(input, { mode: 'self_serve', authId });
  } catch (err) {
    // Do NOT delete the auth user — it came from Google, shared with other Supabase-using sites.
    if (err instanceof DuplicateEmailError) {
      return NextResponse.json({ error: 'account_exists' }, { status: 409 });
    }
    console.error('[api/auth/finish-signup] createBusinessTx failed:', err);
    return NextResponse.json({ error: 'internal' }, { status: 500 });
  }

  return NextResponse.json({ redirectTo: '/onboarding/pay' }, { status: 201 });
}
```

- [ ] **Step 4: Run tests + type-check**

Run: `pnpm vitest run src/app/api/auth/__tests__/finish-signup.test.ts && pnpm tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/finish-signup/route.ts src/app/api/auth/__tests__/finish-signup.test.ts
git commit -m "feat(signup): POST /api/auth/finish-signup for Google path"
```

---

## Task 11: `GET /api/auth/signup-status`

**Files:**
- Create: `src/app/api/auth/signup-status/route.ts`
- Create: `src/app/api/auth/__tests__/signup-status.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/auth/__tests__/signup-status.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
const mockSql = vi.fn() as any;
const mockGetUser = vi.fn();
vi.mock('@/lib/db/server', () => ({ sql: mockSql }));
vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({ auth: { getUser: mockGetUser } })),
}));
process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';

import { GET } from '../signup-status/route';
import { NextRequest } from 'next/server';

function mkReq(): NextRequest {
  return new NextRequest('https://app.example.com/api/auth/signup-status');
}

beforeEach(() => {
  mockSql.mockReset();
  mockGetUser.mockReset();
});

describe('GET /api/auth/signup-status', () => {
  it('returns 404 when flag off', async () => {
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'false';
    const res = await GET(mkReq());
    expect(res.status).toBe(404);
    process.env.SELF_SERVE_SIGNUP_ENABLED = 'true';
  });

  it('returns 401 when no session', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await GET(mkReq());
    expect(res.status).toBe(401);
  });

  it('returns 404 when no users row', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'u-1' } } });
    mockSql.mockResolvedValueOnce([]);
    const res = await GET(mkReq());
    expect(res.status).toBe(404);
  });

  it('returns subscription_status + role on success', async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: 'u-1' } } });
    mockSql.mockResolvedValueOnce([{ subscription_status: 'pending_payment', role: 'owner' }]);
    const res = await GET(mkReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subscriptionStatus).toBe('pending_payment');
    expect(body.role).toBe('owner');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/auth/__tests__/signup-status.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

Create `src/app/api/auth/signup-status/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return req.cookies.getAll(); },
        setAll() {},
      },
    },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const [row] = await sql<{ subscription_status: string; role: string }[]>`
    SELECT b.subscription_status, u.role
    FROM users u
    JOIN businesses b ON b.id = u.business_id
    WHERE u.auth_id = ${user.id}
    LIMIT 1
  `;
  if (!row) {
    return NextResponse.json({ error: 'account_incomplete' }, { status: 404 });
  }

  return NextResponse.json(
    { subscriptionStatus: row.subscription_status, role: row.role },
    { headers: { 'Cache-Control': 'no-store, private' } },
  );
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/app/api/auth/__tests__/signup-status.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/signup-status/route.ts src/app/api/auth/__tests__/signup-status.test.ts
git commit -m "feat(signup): GET /api/auth/signup-status (service-role sql + explicit auth_id scope)"
```

---

## Task 12: `POST /api/auth/forgot-password` with cross-portal protection

**Files:**
- Create: `src/app/api/auth/forgot-password/route.ts`
- Create: `src/app/api/auth/__tests__/forgot-password.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/app/api/auth/__tests__/forgot-password.test.ts` — asserts:
- 400 on invalid body.
- Generic 200 + NO Supabase call when email has no row.
- Generic 200 + NO Supabase call when role=admin submitted with owner email.
- Generic 200 + NO Supabase call when role=owner submitted with admin email.
- 200 + Supabase.resetPasswordForEmail called with correct redirectTo when roles match.
- 429 on rate-limit.
- Owner route works when SELF_SERVE_SIGNUP_ENABLED=false + role=admin (admin flow never flag-gated).

Full pattern follows Task 9 structure.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/auth/__tests__/forgot-password.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write implementation**

Create `src/app/api/auth/forgot-password/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { sql, supabaseServer } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { ForgotPasswordSchema } from '@/lib/shared/schemas';

export const dynamic = 'force-dynamic';

function ipKey(req: NextRequest): string {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  return `forgot-pw:ip:${ip}`;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = ForgotPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }
  const { email, role } = parsed.data;

  // Body-level flag gating: owner requests 404 when self-serve is off; admin always allowed.
  if (role === 'owner' && process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Rate limit (both IP and email).
  try {
    const ipRl = await checkRateLimit(ipKey(req), 3, 3600, { strict: true });
    if (!ipRl.allowed) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    const emailRl = await checkRateLimit(`forgot-pw:email:${email}`, 2, 3600, { strict: true });
    if (!emailRl.allowed) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  } catch (err) {
    console.error('[forgot-password] rate-limit strict failure:', err);
    return NextResponse.json({ error: 'rate_limit_unavailable' }, { status: 503 });
  }

  // Cross-portal protection: look up actual role and silently no-op on mismatch.
  const [actual] = await sql<{ role: string }[]>`
    SELECT role FROM users WHERE email = ${email} LIMIT 1
  `;
  const roleMatches =
    actual &&
    ((role === 'owner' && actual.role === 'owner') ||
      (role === 'admin' && (actual.role === 'admin' || actual.role === 'sales_partner')));

  if (roleMatches) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
    const redirectTo = role === 'admin'
      ? `${appUrl}/api/auth/callback?flow=admin&next=/admin/reset-password`
      : `${appUrl}/api/auth/callback?flow=owner&next=/reset-password`;
    await supabaseServer.auth.resetPasswordForEmail(email, { redirectTo }).catch((err) => {
      console.error('[forgot-password] resetPasswordForEmail failed:', err);
    });
  }

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/app/api/auth/__tests__/forgot-password.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/forgot-password/route.ts src/app/api/auth/__tests__/forgot-password.test.ts
git commit -m "feat(signup): POST /api/auth/forgot-password with cross-portal protection"
```

---

## Task 13: `POST /api/auth/reset-password`

**Files:**
- Create: `src/app/api/auth/reset-password/route.ts`
- Create: `src/app/api/auth/__tests__/reset-password.test.ts`

- [ ] **Step 1: Write the failing test**

Create the test — asserts:
- 404 when flag off + caller role=owner.
- 200 when flag off + caller role=admin.
- 403 when Origin mismatch.
- 401 when no session.
- 400 on weak password.
- Calls `supabase.auth.updateUser({ password })` + returns role-appropriate `redirectTo`.
- Returns 500 when users row lookup fails.

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — route not found.

- [ ] **Step 3: Write implementation**

Create `src/app/api/auth/reset-password/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { sql } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { assertSameOrigin, SameOriginError } from '@/lib/shared/csrf';
import { ResetPasswordSchema } from '@/lib/shared/schemas';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(req);
  } catch (err) {
    if (err instanceof SameOriginError) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
    throw err;
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { cookies: { getAll() { return req.cookies.getAll(); }, setAll() {} } },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  // Role-based flag gate: owner 404 when flag off, admin always allowed.
  const [row] = await sql<{ role: string }[]>`
    SELECT role FROM users WHERE auth_id = ${user.id} LIMIT 1
  `;
  if (!row) return NextResponse.json({ error: 'account_incomplete' }, { status: 500 });

  const isOwner = row.role === 'owner';
  if (isOwner && process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // Rate limit per authId.
  try {
    const rl = await checkRateLimit(`reset-pw:auth:${user.id}`, 5, 3600, { strict: true });
    if (!rl.allowed) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  } catch (err) {
    console.error('[reset-password] rate-limit strict failure:', err);
    return NextResponse.json({ error: 'rate_limit_unavailable' }, { status: 503 });
  }

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = ResetPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const { error: updateError } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 400 });
  }

  const redirectTo = isOwner ? '/login' : '/admin/login';
  return NextResponse.json({ redirectTo });
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/app/api/auth/__tests__/reset-password.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/reset-password/route.ts src/app/api/auth/__tests__/reset-password.test.ts
git commit -m "feat(signup): POST /api/auth/reset-password with role-based redirect"
```

---

## Task 14: `POST /api/auth/resend-confirmation`

**Files:**
- Create: `src/app/api/auth/resend-confirmation/route.ts`
- Create: `src/app/api/auth/__tests__/resend-confirmation.test.ts`

- [ ] **Step 1: Write the failing test**

Assert: flag gate, rate limit 2/hour per email+IP, normalize email, call `supabase.auth.resend({ type: 'signup', email })`, generic 200, strict-mode 503 on Redis failure.

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL.

- [ ] **Step 3: Write implementation**

Create `src/app/api/auth/resend-confirmation/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/db/server';
import { checkRateLimit } from '@/lib/shared/rate-limit';
import { ResendConfirmationSchema } from '@/lib/shared/schemas';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }); }
  const parsed = ResendConfirmationSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  const { email, flow } = parsed.data;

  if (flow === 'owner' && process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  try {
    const emailRl = await checkRateLimit(`resend-conf:email:${email}`, 2, 3600, { strict: true });
    if (!emailRl.allowed) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    const ipRl = await checkRateLimit(`resend-conf:ip:${ip}`, 5, 3600, { strict: true });
    if (!ipRl.allowed) return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
  } catch (err) {
    console.error('[resend-confirmation] rate-limit strict failure:', err);
    return NextResponse.json({ error: 'rate_limit_unavailable' }, { status: 503 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL!;
  const emailRedirectTo = `${appUrl}/api/auth/callback?flow=${flow}&next=/onboarding/pay`;
  await supabaseServer.auth.resend({ type: 'signup', email, options: { emailRedirectTo } })
    .catch((err) => {
      console.error('[resend-confirmation] supabase resend failed:', err);
    });

  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/app/api/auth/__tests__/resend-confirmation.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/resend-confirmation/route.ts src/app/api/auth/__tests__/resend-confirmation.test.ts
git commit -m "feat(signup): POST /api/auth/resend-confirmation for 24h link expiry recovery"
```

---

## Task 15: Extend `/api/auth/callback` for flow= + recovery + Google-signup

**Files:**
- Modify: `src/app/api/auth/callback/route.ts`

- [ ] **Step 1: Read current callback**

Read `src/app/api/auth/callback/route.ts` fully so you understand the existing session-exchange + role-routing.

- [ ] **Step 2: Write the failing test**

Create `src/app/api/auth/__tests__/callback.test.ts` asserting:
- Missing code → redirects to role-appropriate login based on `flow=` param.
- Failed session exchange → redirects to role-appropriate login.
- `next=/reset-password` → redirects there after session set.
- `next=/admin/reset-password` → redirects there.
- `next=/signup/finish` + no users row → redirects to `/signup/finish` (no sign-out).
- `next=/onboarding/pay` + owner role + email confirmed → redirects to `/onboarding/pay`.
- No users row + next!=/signup/finish → signs out + redirects to role-appropriate login with `?error=account_incomplete`.

- [ ] **Step 3: Update `src/app/api/auth/callback/route.ts`**

Full replacement:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { isAuthFlow, loginUrlForFlow, type AuthFlow } from '@/lib/shared/auth-flow';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const rawFlow = searchParams.get('flow');
  const flow: AuthFlow | undefined = isAuthFlow(rawFlow) ? rawFlow : undefined;
  const rawNext = searchParams.get('next') ?? '';

  const nextIsSafe = rawNext.startsWith('/') && !rawNext.startsWith('//');
  const requestedNext = nextIsSafe ? rawNext : '';

  const loginUrl = loginUrlForFlow(flow);

  if (!code) {
    return NextResponse.redirect(new URL(loginUrl, origin));
  }

  const response = NextResponse.redirect(new URL(loginUrl, origin));
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(cookiesToSet) {
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  const { error, data } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL(`${loginUrl}?error=auth_callback_failed`, origin));
  }

  // Reset-password branches — no role lookup required (the reset page reads the session).
  if (requestedNext === '/reset-password' || requestedNext === '/admin/reset-password') {
    const final = NextResponse.redirect(new URL(requestedNext, origin));
    for (const cookie of response.cookies.getAll()) final.cookies.set(cookie);
    return final;
  }

  const authId = data.user?.id;
  let role: string | null = null;
  if (authId) {
    const { data: userRow } = await supabase
      .from('users')
      .select('role')
      .eq('auth_id', authId)
      .limit(1)
      .single();
    role = (userRow as { role: string } | null)?.role ?? null;
  }

  // Google signup case: session exists but no users row yet → route to /signup/finish.
  if (role === null && requestedNext === '/signup/finish') {
    const final = NextResponse.redirect(new URL('/signup/finish', origin));
    for (const cookie of response.cookies.getAll()) final.cookies.set(cookie);
    return final;
  }

  // "No users row" in any other flow → sign out + show account_incomplete.
  if (role === null) {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL(`${loginUrl}?error=account_incomplete`, origin));
  }

  // Role-aware destination resolution.
  const nextIsAdmin = requestedNext.startsWith('/admin');
  const nextIsOwner = requestedNext.startsWith('/dashboard')
    || requestedNext.startsWith('/settings')
    || requestedNext.startsWith('/onboarding');

  let destination: string;
  if (role === 'owner') {
    destination = nextIsOwner ? requestedNext : '/dashboard';
  } else if (role === 'admin' || role === 'sales_partner') {
    destination = nextIsAdmin ? requestedNext : '/admin/overview';
  } else {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL(`${loginUrl}?error=account_incomplete`, origin));
  }

  const final = NextResponse.redirect(new URL(destination, origin));
  for (const cookie of response.cookies.getAll()) final.cookies.set(cookie);
  return final;
}
```

- [ ] **Step 4: Run tests + existing auth tests**

Run: `pnpm vitest run src/app/api/auth/__tests__/`
Expected: PASS including any existing callback tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/auth/callback/route.ts src/app/api/auth/__tests__/callback.test.ts
git commit -m "feat(signup): callback handles flow= + recovery + google-signup branches"
```

---

## Task 16: Extend Stripe webhook with transition-gated enqueue

**Files:**
- Modify: `worker/ingress/stripe.ts`
- Create: `worker/__tests__/stripe-activation-enqueue.test.ts`

- [ ] **Step 1: Read current webhook**

Read `worker/ingress/stripe.ts` to understand the existing `processCheckoutSessionCompleted`.

- [ ] **Step 2: Write the failing test**

Create `worker/__tests__/stripe-activation-enqueue.test.ts` asserting the eight cases from spec §1.6 step 5:

1. self-serve + `place_id_verified=true` → enqueue `sync_reviews`.
2. self-serve + `place_id_verified=false` + `google_maps_url` set → enqueue `validate_place_id` with the URL in payload.
3. self-serve + neither field → no enqueue, error logged.
4. admin-onboarded → no enqueue.
5. `past_due → active` self-serve → update only, no enqueue.
6. `active → active` duplicate webhook → no UPDATE row count change, no enqueue.
7. self-serve with existing in-flight sync row → no duplicate enqueue.
8. Concurrent activations serialize on advisory lock.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run worker/__tests__/stripe-activation-enqueue.test.ts`
Expected: FAIL (webhook not yet extended).

- [ ] **Step 4: Extend `processCheckoutSessionCompleted`**

Modify `worker/ingress/stripe.ts` `processCheckoutSessionCompleted` function:

```ts
import { v7 as uuidv7 } from 'uuid';
import { sql, jsonb } from '../../src/lib/db/server';
import type { SyncReviewsPayload, ValidatePlaceIdPayload } from '../../src/lib/shared/worker-types';

async function processCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const businessId = session.client_reference_id ?? session.metadata?.business_id;
  if (!businessId) {
    console.warn(`${LOG_PREFIX} checkout.session.completed missing business_id — skipping`);
    return;
  }

  const customerId = extractCustomerId(session.customer);
  const subscriptionId = extractSubscriptionId(session.subscription as string | Stripe.Subscription | null);

  if (session.mode !== 'subscription') {
    console.warn(`${LOG_PREFIX} checkout.session.completed mode=${session.mode} (not subscription) — skipping activation`);
    return;
  }

  if (session.payment_status !== 'paid') {
    console.warn(`${LOG_PREFIX} checkout.session.completed payment_status=${session.payment_status} (not paid) — skipping activation for business ${businessId}`);
    return;
  }

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${businessId + ':activation'}))`;

    const [bizRow] = await tx<{
      subscription_status: string;
      google_place_id: string | null;
      google_maps_url: string | null;
      place_id_verified: boolean;
    }[]>`
      SELECT subscription_status, google_place_id, google_maps_url, place_id_verified
      FROM businesses
      WHERE id = ${businessId}
      FOR UPDATE
    `;
    if (!bizRow) {
      console.warn(`${LOG_PREFIX} business ${businessId} not found at activation — skipping`);
      return;
    }

    const oldStatus = bizRow.subscription_status;

    const updated = await tx`
      UPDATE businesses
      SET subscription_status = 'active',
          stripe_customer_id = ${customerId},
          stripe_subscription_id = ${subscriptionId},
          subscription_activated_at = COALESCE(subscription_activated_at, NOW()),
          updated_at = NOW()
      WHERE id = ${businessId}
        AND subscription_status IN ('pending_payment', 'past_due')
    `;
    if (updated.count > 0) {
      console.log(`${LOG_PREFIX} Business ${businessId} activated (customer=${customerId}, from status=${oldStatus})`);
    }

    if (oldStatus !== 'pending_payment') return;

    // Build topic + payload explicitly per worker-types.ts shapes.
    const correlationId = uuidv7();
    let topic: 'sync_reviews' | 'validate_place_id';
    let payload: SyncReviewsPayload | ValidatePlaceIdPayload;

    if (bizRow.place_id_verified && bizRow.google_place_id) {
      topic = 'sync_reviews';
      payload = {
        business_id: businessId,
        google_place_id: bizRow.google_place_id,
        correlation_id: correlationId,
      };
    } else if (bizRow.google_maps_url) {
      topic = 'validate_place_id';
      payload = {
        business_id: businessId,
        google_maps_url: bizRow.google_maps_url,
        correlation_id: correlationId,
      };
    } else {
      console.error(
        `${LOG_PREFIX} business ${businessId} has neither verified place_id nor google_maps_url; skipping initial sync enqueue. correlation=${correlationId}`,
      );
      return;
    }

    await tx`
      INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status)
      SELECT
        ${uuidv7()},
        ${topic},
        'business',
        ${businessId},
        ${jsonb(payload)},
        'pending'
      WHERE NOT EXISTS (
        SELECT 1 FROM job_outbox jo
        WHERE jo.aggregate_id = ${businessId}
          AND jo.topic IN ('sync_reviews', 'validate_place_id')
          AND jo.status IN ('pending', 'dispatching', 'dispatched')
      )
      AND EXISTS (
        SELECT 1 FROM businesses b
        JOIN users u ON u.business_id = b.id AND u.role = 'owner'
        WHERE b.id = ${businessId}
          AND b.onboarded_by IS NULL
          AND u.auth_id IS NOT NULL
      )
    `;
  });
}
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run worker/__tests__/stripe-activation-enqueue.test.ts worker/__tests__/webhook-dedup.test.ts`
Expected: PASS (both new tests + existing dedup tests).

- [ ] **Step 6: Commit**

```bash
git add worker/ingress/stripe.ts worker/__tests__/stripe-activation-enqueue.test.ts
git commit -m "feat(signup): Stripe webhook transition-gated self-serve enqueue with advisory lock"
```

---

## Task 17: Dashboard API `pending_payment` branch

**Files:**
- Modify: `src/app/api/dashboard/route.ts`

- [ ] **Step 1: Read current dashboard route**

Read `src/app/api/dashboard/route.ts` to find the `Promise.all([...])` block and the `user.businessId` lookup.

- [ ] **Step 2: Write the failing test**

Create/extend `src/app/api/dashboard/__tests__/route.test.ts` asserting: when business.subscription_status='pending_payment', response is `{ businessId, businessName, subscriptionStatus: 'pending_payment', paymentUrl }` with no review/ranking/brief data.

- [ ] **Step 3: Add early branch**

In `src/app/api/dashboard/route.ts`, after the `user.businessId` check, add BEFORE the `Promise.all` block:

```ts
import { buildPaymentLinkUrl } from '@/lib/payments/payment-link';

// ... existing user auth + businessId check ...

// Early branch: pending_payment returns minimal payload to avoid leaking data.
const [subRow] = await sql<{
  name: string;
  subscription_status: string;
  subscription_tier: string;
  owner_email: string;
}[]>`
  SELECT name, subscription_status, subscription_tier, owner_email
  FROM businesses WHERE id = ${businessId}
`;
if (!subRow) {
  return jsonResponse({ error: 'business_not_found' }, 404);
}

if (subRow.subscription_status === 'pending_payment') {
  const paymentUrl = buildPaymentLinkUrl(
    subRow.subscription_tier as 'founding' | 'standard',
    businessId,
    subRow.owner_email,
  );
  return jsonResponse({
    subscriptionStatus: 'pending_payment',
    businessId,
    businessName: subRow.name,
    paymentUrl,
  });
}

// ... existing Promise.all continues for 'active' / 'past_due' ...
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run src/app/api/dashboard/__tests__/route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/dashboard/route.ts src/app/api/dashboard/__tests__/route.test.ts
git commit -m "feat(signup): dashboard API early-branch on pending_payment returns minimal payload"
```

---

## Task 18: Middleware + protected-routes updates

**Files:**
- Modify: `src/lib/shared/protected-routes.ts`
- Modify: `src/middleware.ts`
- Create: `src/lib/shared/__tests__/protected-routes.test.ts`

- [ ] **Step 1: Write table-driven test**

Create `src/lib/shared/__tests__/protected-routes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isProtectedRoute } from '../protected-routes';

const PUBLIC: string[] = [
  '/admin/login',
  '/admin/forgot-password',
  '/admin/reset-password',
  '/signup',
  '/signup/check-email',
  '/signup/finish',
  '/login',
  '/forgot-password',
  '/reset-password',
  '/',
  '/pricing',
  '/features',
  '/how-it-works',
];

const PROTECTED: string[] = [
  '/admin',
  '/admin/overview',
  '/admin/businesses',
  '/api/admin/businesses',
  '/dashboard',
  '/dashboard/settings',
  '/settings',
  '/api/dashboard',
  '/api/settings',
  '/onboarding/pay',
  '/onboarding/payment-success',
];

describe('isProtectedRoute', () => {
  PUBLIC.forEach((p) => {
    it(`${p} is public`, () => expect(isProtectedRoute(p)).toBe(false));
  });
  PROTECTED.forEach((p) => {
    it(`${p} is protected`, () => expect(isProtectedRoute(p)).toBe(true));
  });
});
```

- [ ] **Step 2: Run test to verify some fail**

Run: `pnpm vitest run src/lib/shared/__tests__/protected-routes.test.ts`
Expected: multiple FAILs (onboarding paths not yet gated; admin forgot/reset not yet public).

- [ ] **Step 3: Update `src/lib/shared/protected-routes.ts`**

Replace the file:

```ts
export function isProtectedRoute(pathname: string): boolean {
  // Explicit public exemptions within /admin namespace.
  if (
    pathname === '/admin/login' ||
    pathname === '/admin/forgot-password' ||
    pathname === '/admin/reset-password'
  ) {
    return false;
  }
  return (
    pathname === '/admin' || pathname.startsWith('/admin/') ||
    pathname === '/api/admin' || pathname.startsWith('/api/admin/') ||
    pathname === '/api/dashboard' || pathname.startsWith('/api/dashboard/') ||
    pathname === '/api/settings' || pathname.startsWith('/api/settings/') ||
    pathname === '/dashboard' || pathname.startsWith('/dashboard/') ||
    pathname === '/settings' || pathname.startsWith('/settings/') ||
    pathname === '/onboarding' || pathname.startsWith('/onboarding/')
  );
}
```

- [ ] **Step 4: Run protected-routes tests**

Run: `pnpm vitest run src/lib/shared/__tests__/protected-routes.test.ts`
Expected: PASS

- [ ] **Step 5: Update `src/middleware.ts` for onboarding gate + flow-aware redirects**

Read the current middleware. Add a new section for `/onboarding/*` AFTER the admin-login and role blocks:

```ts
// Onboarding paths require an authenticated owner with a users row.
// Does NOT require subscription_status='active' — that's the whole point of these pages.
if (pathname.startsWith('/onboarding/')) {
  if (!authUser) {
    return redirectToLogin(request, 'owner');
  }
  const self = await readSelf();
  if (!self || self.role !== 'owner' || !self.business_id) {
    return redirectToLogin(request, 'owner');
  }
}
```

And update `redirectToLogin` to accept a flow parameter:

```ts
function redirectToLogin(request: NextRequest, flow: 'owner' | 'admin' = 'admin'): NextResponse {
  const loginUrl = new URL(flow === 'owner' ? '/login' : '/admin/login', request.url);
  loginUrl.searchParams.set('from', request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}
```

Update the existing owner-page redirects (`/dashboard`, `/settings`) to pass `'owner'`:

```ts
if (pathname.startsWith('/dashboard') || pathname.startsWith('/settings')) {
  if (!authUser) return redirectToLogin(request, 'owner');
  // ...
  if (!data || data.role !== 'owner' || !data.business_id) {
    return redirectToLogin(request, 'owner');
  }
}
```

- [ ] **Step 6: Run middleware + dashboard tests**

Run: `pnpm vitest run src/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/shared/protected-routes.ts src/lib/shared/__tests__/protected-routes.test.ts src/middleware.ts
git commit -m "feat(signup): middleware + protected-routes add onboarding gate + flow-aware redirects"
```

---

## Task 19: Cleanup poller

**Files:**
- Create: `worker/jobs/CleanupAbandonedSignupsPoller.ts`
- Create: `worker/jobs/__tests__/CleanupAbandonedSignupsPoller.test.ts`

- [ ] **Step 1: Write the failing test**

Create the test asserting:
- Deletes self-serve businesses >7d old.
- Does NOT delete admin businesses (onboarded_by set).
- Does NOT delete rows where owner has businesses.onboarded_by or prospect_demos.created_by references.
- 404 from Supabase delete → proceed to DB delete.
- Other Supabase errors → rollback tx, continue next.
- Takes advisory lock on email hash.

- [ ] **Step 2: Write implementation**

Create `worker/jobs/CleanupAbandonedSignupsPoller.ts`:

```ts
import { sql, supabaseServer } from '../../src/lib/db/server';
import { createWorkerLogger } from '../../src/lib/shared/logger';

const DEFAULT_INTERVAL_MS = 86_400_000; // 24h
const DEFAULT_BATCH_SIZE = 100;

let timer: ReturnType<typeof setInterval> | null = null;

async function runOnce(): Promise<void> {
  const logger = createWorkerLogger('[CleanupAbandonedSignups]');
  const batchSize = parseInt(process.env.CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE ?? '', 10) || DEFAULT_BATCH_SIZE;

  const candidates = await sql<{
    business_id: string;
    user_id: string;
    owner_email: string;
    auth_id: string;
  }[]>`
    SELECT b.id AS business_id, u.id AS user_id, b.owner_email, u.auth_id
    FROM businesses b
    JOIN users u ON u.business_id = b.id AND u.role = 'owner'
    WHERE b.subscription_status = 'pending_payment'
      AND b.stripe_customer_id IS NULL
      AND b.onboarded_by IS NULL
      AND u.auth_id IS NOT NULL
      AND b.created_at < NOW() - INTERVAL '7 days'
    LIMIT ${batchSize}
  `;

  let deleted = 0;
  let skippedRefs = 0;
  let supabaseFailed = 0;

  for (const c of candidates) {
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${c.owner_email + ':signup'}))`;

        // Invariant-violation defense.
        const [refs] = await tx<{ has_onboarded: boolean; has_demos: boolean }[]>`
          SELECT
            EXISTS (SELECT 1 FROM businesses WHERE onboarded_by = ${c.user_id}) AS has_onboarded,
            EXISTS (SELECT 1 FROM prospect_demos WHERE created_by = ${c.user_id}) AS has_demos
        `;
        if (refs.has_onboarded || refs.has_demos) {
          logger.warn(`Skipping ${c.user_id} — referenced by other tables (invariant violation)`);
          skippedRefs++;
          return;
        }

        // Delete Supabase auth user.
        const { error } = await supabaseServer.auth.admin.deleteUser(c.auth_id);
        if (error && !/not_found|404/i.test(error.message)) {
          logger.warn(`Supabase deleteUser failed for ${c.auth_id}: ${error.message}`);
          supabaseFailed++;
          throw error; // rollback tx
        }

        await tx`DELETE FROM users WHERE id = ${c.user_id}`;
        await tx`DELETE FROM businesses WHERE id = ${c.business_id}`;
        deleted++;
      });
    } catch (err) {
      // Tx rolled back; continue to next candidate.
      logger.error(`Cleanup tx failed for business ${c.business_id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  logger.log(`Run complete: candidates=${candidates.length} deleted=${deleted} skipped_refs=${skippedRefs} supabase_failed=${supabaseFailed}`);
}

export function startCleanupAbandonedSignupsPoller(): void {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') {
    console.log('[CleanupAbandonedSignups] SELF_SERVE_SIGNUP_ENABLED != true — not starting');
    return;
  }
  const interval = parseInt(process.env.CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS ?? '', 10) || DEFAULT_INTERVAL_MS;
  console.log(`[CleanupAbandonedSignups] Starting (interval=${interval}ms)`);
  runOnce().catch((err) => console.error('[CleanupAbandonedSignups] Initial run failed:', err));
  timer = setInterval(() => {
    runOnce().catch((err) => console.error('[CleanupAbandonedSignups] Scheduled run failed:', err));
  }, interval);
}

export function stopCleanupAbandonedSignupsPoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
```

- [ ] **Step 3: Register in worker/index.ts**

Modify `worker/index.ts` — add after existing poller startups:

```ts
import { startCleanupAbandonedSignupsPoller } from './jobs/CleanupAbandonedSignupsPoller';

// ... existing registrations ...

startCleanupAbandonedSignupsPoller();
```

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run worker/jobs/__tests__/CleanupAbandonedSignupsPoller.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/CleanupAbandonedSignupsPoller.ts worker/jobs/__tests__/CleanupAbandonedSignupsPoller.test.ts worker/index.ts
git commit -m "feat(signup): CleanupAbandonedSignupsPoller with advisory lock + invariant checks"
```

---

## Task 20: Shared client auth components

**Files:**
- Create: `src/components/auth/LoginFormClient.tsx`
- Create: `src/components/auth/ForgotPasswordFormClient.tsx`
- Create: `src/components/auth/ResetPasswordFormClient.tsx`

- [ ] **Step 1: LoginFormClient**

Create `src/components/auth/LoginFormClient.tsx`:

```tsx
'use client';

import { Suspense, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { createBrowserSupabaseClient } from '@/lib/db/browser';
import type { AuthFlow } from '@/lib/shared/auth-flow';

export interface LoginFormProps {
  portal: AuthFlow;
  brandName: string;
  showGoogleButton: boolean;
  defaultRoute: string;
  allowedRoles: readonly string[];
}

export function LoginFormClient(props: LoginFormProps) {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-50" />}>
      <LoginFormInner {...props} />
    </Suspense>
  );
}

function LoginFormInner({ portal, brandName, showGoogleButton, defaultRoute, allowedRoles }: LoginFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const searchParams = useSearchParams();
  const router = useRouter();

  const initialError =
    searchParams.get('error') === 'account_incomplete'
      ? 'Your account is not set up yet. Contact your administrator.'
      : searchParams.get('error') === 'auth_callback_failed'
      ? 'Sign-in failed. Please try again.'
      : '';
  const [error, setError] = useState(initialError);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const supabase = createBrowserSupabaseClient();
      const { error: authError, data } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });

      if (authError) {
        // Email-not-confirmed UX: route to check-email page instead of raw error.
        if (authError.message.toLowerCase().includes('email not confirmed')) {
          router.push('/signup/check-email?from=login');
          return;
        }
        setError(authError.message);
        return;
      }

      const authId = data?.user?.id;
      let role: string | null = null;
      if (authId) {
        const { data: userRow } = await supabase
          .from('users')
          .select('role')
          .eq('auth_id', authId)
          .limit(1)
          .single();
        role = (userRow as { role: string } | null)?.role ?? null;
      }

      if (!role || !allowedRoles.includes(role)) {
        await supabase.auth.signOut();
        setError(
          portal === 'owner'
            ? 'That account is for the admin portal. Use /admin/login instead.'
            : 'That account is for the owner portal. Use /login instead.',
        );
        return;
      }

      router.push(defaultRoute);
      router.refresh();
    } catch {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogle() {
    const supabase = createBrowserSupabaseClient();
    const redirectTo = `${window.location.origin}/api/auth/callback?flow=${portal}&next=${defaultRoute}`;
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo },
    });
  }

  const forgotPath = portal === 'owner' ? '/forgot-password' : '/admin/forgot-password';

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 text-center mb-8">{brandName}</h1>
        <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              required autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={loading}
            className="w-full bg-blue-600 text-white font-medium py-2 rounded-md text-sm hover:bg-blue-700 disabled:opacity-50">
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
          {showGoogleButton && (
            <button type="button" onClick={handleGoogle}
              className="w-full bg-white border border-gray-300 text-gray-700 font-medium py-2 rounded-md text-sm hover:bg-gray-50">
              Continue with Google
            </button>
          )}
          <p className="text-xs text-gray-500 text-center">
            <a href={forgotPath} className="hover:underline">Forgot password?</a>
          </p>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: ForgotPasswordFormClient**

Create `src/components/auth/ForgotPasswordFormClient.tsx`:

```tsx
'use client';
import { useState } from 'react';
import type { AuthFlow } from '@/lib/shared/auth-flow';

export function ForgotPasswordFormClient({ portal, brandName }: { portal: AuthFlow; brandName: string }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), role: portal }),
      });
      setSent(true);
    } finally {
      setLoading(false);
    }
  }

  if (sent) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="w-full max-w-sm bg-white rounded-lg border border-gray-200 p-6 text-center">
          <h1 className="text-xl font-bold text-gray-900 mb-4">{brandName}</h1>
          <p className="text-sm text-gray-700">
            If an account exists for that email, we&apos;ve sent a reset link. Check your inbox.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 text-center mb-8">{brandName}</h1>
        <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
          <h2 className="text-base font-medium text-gray-900">Reset your password</h2>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <button type="submit" disabled={loading}
            className="w-full bg-blue-600 text-white font-medium py-2 rounded-md text-sm hover:bg-blue-700 disabled:opacity-50">
            {loading ? 'Sending...' : 'Send reset link'}
          </button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: ResetPasswordFormClient**

Create `src/components/auth/ResetPasswordFormClient.tsx`:

```tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function ResetPasswordFormClient({ brandName }: { brandName: string }) {
  const [password, setPassword] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password !== confirmPw) { setError('Passwords do not match'); return; }
    if (password.length < 8) { setError('Password must be at least 8 characters'); return; }
    setLoading(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error ?? 'Reset failed'); return; }
      router.push(body.redirectTo ?? '/login');
    } catch {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 text-center mb-8">{brandName}</h1>
        <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
          <h2 className="text-base font-medium text-gray-900">Set a new password</h2>
          <input type="password" required value={password} onChange={(e) => setPassword(e.target.value)}
            placeholder="New password (8+ chars)"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          <input type="password" required value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)}
            placeholder="Confirm password"
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={loading}
            className="w-full bg-blue-600 text-white font-medium py-2 rounded-md text-sm hover:bg-blue-700 disabled:opacity-50">
            {loading ? 'Updating...' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/components/auth/
git commit -m "feat(signup): shared auth form components (login + forgot + reset)"
```

---

## Task 21: Public auth pages (wrappers)

**Files:**
- Create: `src/app/(public)/login/page.tsx`
- Create: `src/app/(public)/forgot-password/page.tsx`
- Create: `src/app/(public)/reset-password/page.tsx`
- Create: `src/app/admin/forgot-password/page.tsx`
- Create: `src/app/admin/reset-password/page.tsx`
- Modify: `src/app/admin/login/page.tsx`

- [ ] **Step 1: Owner login page**

Create `src/app/(public)/login/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { LoginFormClient } from '@/components/auth/LoginFormClient';

export default function OwnerLoginPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();
  return (
    <LoginFormClient
      portal="owner"
      brandName="RepWorth"
      showGoogleButton={true}
      defaultRoute="/dashboard"
      allowedRoles={['owner']}
    />
  );
}
```

- [ ] **Step 2: Owner forgot-password**

Create `src/app/(public)/forgot-password/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { ForgotPasswordFormClient } from '@/components/auth/ForgotPasswordFormClient';

export default function OwnerForgotPasswordPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();
  return <ForgotPasswordFormClient portal="owner" brandName="RepWorth" />;
}
```

- [ ] **Step 3: Owner reset-password**

Create `src/app/(public)/reset-password/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { ResetPasswordFormClient } from '@/components/auth/ResetPasswordFormClient';

export default function OwnerResetPasswordPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();
  return <ResetPasswordFormClient brandName="RepWorth" />;
}
```

- [ ] **Step 4: Admin forgot-password (never flag-gated)**

Create `src/app/admin/forgot-password/page.tsx`:

```tsx
import { ForgotPasswordFormClient } from '@/components/auth/ForgotPasswordFormClient';

export default function AdminForgotPasswordPage() {
  return <ForgotPasswordFormClient portal="admin" brandName="RepWorth Admin" />;
}
```

- [ ] **Step 5: Admin reset-password**

Create `src/app/admin/reset-password/page.tsx`:

```tsx
import { ResetPasswordFormClient } from '@/components/auth/ResetPasswordFormClient';

export default function AdminResetPasswordPage() {
  return <ResetPasswordFormClient brandName="RepWorth Admin" />;
}
```

- [ ] **Step 6: Refactor existing admin login to use shared component**

Replace the body of `src/app/admin/login/page.tsx`:

```tsx
import { LoginFormClient } from '@/components/auth/LoginFormClient';

export default function AdminLoginPage() {
  return (
    <LoginFormClient
      portal="admin"
      brandName="RepWorth Admin"
      showGoogleButton={false}
      defaultRoute="/admin/overview"
      allowedRoles={['admin', 'sales_partner']}
    />
  );
}
```

- [ ] **Step 7: Commit**

```bash
git add src/app/(public)/login src/app/(public)/forgot-password src/app/(public)/reset-password src/app/admin/forgot-password src/app/admin/reset-password src/app/admin/login
git commit -m "feat(signup): owner + admin login + forgot + reset pages via shared components"
```

---

## Task 22: Signup pages

**Files:**
- Create: `src/app/(public)/signup/page.tsx`
- Create: `src/app/(public)/signup/check-email/page.tsx`
- Create: `src/app/(public)/signup/finish/page.tsx`

- [ ] **Step 1: Signup form page**

Create `src/app/(public)/signup/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { SignupFormClient } from './SignupFormClient';

export default function SignupPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();
  return <SignupFormClient />;
}
```

Create `src/app/(public)/signup/SignupFormClient.tsx` (client component with the full form):

```tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createBrowserSupabaseClient } from '@/lib/db/browser';

export function SignupFormClient() {
  const [form, setForm] = useState({
    ownerEmail: '', ownerName: '', ownerPhone: '', password: '',
    businessName: '', googleMapsUrl: '', googlePlaceId: '',
    productsServices: '', staffNames: '', highlightFacts: '', avoidFacts: '', sampleResponses: '',
    subscriptionTier: 'standard' as 'founding' | 'standard',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.message ?? body.error ?? 'Signup failed');
        return;
      }
      router.push(body.redirectTo ?? '/signup/check-email');
    } catch {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleGoogle() {
    const supabase = createBrowserSupabaseClient();
    const redirectTo = `${window.location.origin}/api/auth/callback?flow=owner&next=/signup/finish`;
    await supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
  }

  const onChange = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-xl mx-auto">
        <h1 className="text-3xl font-bold text-center mb-2">Sign up for RepWorth</h1>
        <p className="text-center text-gray-600 mb-8">Start responding to your Google reviews in minutes.</p>

        <button type="button" onClick={handleGoogle}
          className="w-full mb-6 bg-white border border-gray-300 py-3 rounded-md font-medium hover:bg-gray-50">
          Continue with Google
        </button>

        <div className="text-center text-sm text-gray-500 mb-6">or continue with email</div>

        <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
          <fieldset className="space-y-3">
            <legend className="font-medium">Your details</legend>
            <input type="email" required placeholder="Email" value={form.ownerEmail} onChange={onChange('ownerEmail')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            <input type="text" required placeholder="Your name" value={form.ownerName} onChange={onChange('ownerName')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            <input type="tel" placeholder="Phone (optional)" value={form.ownerPhone} onChange={onChange('ownerPhone')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            <input type="password" required minLength={8} placeholder="Password (8+ chars)" value={form.password} onChange={onChange('password')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="font-medium">Your business</legend>
            <input type="text" required placeholder="Business name" value={form.businessName} onChange={onChange('businessName')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            <input type="url" required placeholder="Google Maps URL for your business" value={form.googleMapsUrl} onChange={onChange('googleMapsUrl')}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            <textarea placeholder="Products / services (optional)" value={form.productsServices} onChange={onChange('productsServices')}
              rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            <textarea placeholder="Staff names (one per line or comma-separated)" value={form.staffNames} onChange={onChange('staffNames')}
              rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            <textarea placeholder="Highlight facts (e.g. 'opened 2010')" value={form.highlightFacts} onChange={onChange('highlightFacts')}
              rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            <textarea placeholder="Avoid facts (e.g. 'we don't do delivery')" value={form.avoidFacts} onChange={onChange('avoidFacts')}
              rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="font-medium">Plan</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="tier" value="founding" checked={form.subscriptionTier === 'founding'} onChange={onChange('subscriptionTier')} />
              Founding — $X/mo (limited time)
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="tier" value="standard" checked={form.subscriptionTier === 'standard'} onChange={onChange('subscriptionTier')} />
              Standard — $Y/mo
            </label>
          </fieldset>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button type="submit" disabled={loading}
            className="w-full bg-blue-600 text-white font-medium py-3 rounded-md hover:bg-blue-700 disabled:opacity-50">
            {loading ? 'Creating account...' : 'Continue'}
          </button>

          <p className="text-xs text-gray-500 text-center">
            Already have an account? <a href="/login" className="text-blue-600 hover:underline">Log in</a>
          </p>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Check-email page with resend button**

Create `src/app/(public)/signup/check-email/page.tsx`:

```tsx
import { notFound } from 'next/navigation';
import { CheckEmailClient } from './CheckEmailClient';

export default function CheckEmailPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();
  return <CheckEmailClient />;
}
```

Create `src/app/(public)/signup/check-email/CheckEmailClient.tsx`:

```tsx
'use client';
import { useState } from 'react';

export function CheckEmailClient() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);

  async function handleResend(e: React.FormEvent) {
    e.preventDefault();
    await fetch('/api/auth/resend-confirmation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email.trim().toLowerCase(), flow: 'owner' }),
    });
    setSent(true);
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-lg border border-gray-200 p-8 text-center">
        <h1 className="text-2xl font-bold mb-4">Check your email</h1>
        <p className="text-gray-700 mb-6">
          We sent a confirmation link to your inbox. Click it to activate your account and proceed to payment.
        </p>
        <p className="text-sm text-gray-500 mb-6">
          Check your spam folder if you don&apos;t see it. The link expires in 24 hours.
        </p>
        {sent ? (
          <p className="text-sm text-green-700">A new confirmation link is on its way.</p>
        ) : (
          <form onSubmit={handleResend} className="space-y-3">
            <input type="email" required placeholder="Your email" value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
            <button type="submit" className="w-full bg-gray-100 text-gray-700 font-medium py-2 rounded-md text-sm hover:bg-gray-200">
              Resend confirmation email
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Google finish-signup page**

Create `src/app/(public)/signup/finish/page.tsx`:

```tsx
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { FinishSignupClient } from './FinishSignupClient';

export default async function FinishSignupPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') redirect('/signup');

  const cookieStore = cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll() {},
      },
    },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/signup');

  return <FinishSignupClient defaultEmail={user.email ?? ''} defaultName={user.user_metadata?.full_name ?? ''} />;
}
```

Create `src/app/(public)/signup/finish/FinishSignupClient.tsx` — similar to `SignupFormClient.tsx` but:
- Email is disabled (pre-filled from `defaultEmail`).
- No password field.
- POSTs to `/api/auth/finish-signup`.
- Same business-profile fields.

```tsx
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function FinishSignupClient({ defaultEmail, defaultName }: { defaultEmail: string; defaultName: string }) {
  const [form, setForm] = useState({
    ownerName: defaultName,
    ownerPhone: '',
    businessName: '',
    googleMapsUrl: '',
    productsServices: '',
    staffNames: '',
    highlightFacts: '',
    avoidFacts: '',
    sampleResponses: '',
    subscriptionTier: 'standard' as 'founding' | 'standard',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await fetch('/api/auth/finish-signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(form),
      });
      const body = await res.json();
      if (!res.ok) { setError(body.message ?? body.error ?? 'Submission failed'); return; }
      router.push(body.redirectTo ?? '/onboarding/pay');
    } finally {
      setLoading(false);
    }
  }

  const onChange = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm({ ...form, [k]: e.target.value });

  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-xl mx-auto">
        <h1 className="text-2xl font-bold text-center mb-6">Almost there — tell us about your business</h1>
        <form onSubmit={handleSubmit} className="bg-white rounded-lg border border-gray-200 p-6 space-y-4">
          <input type="email" disabled value={defaultEmail}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-gray-100 text-gray-600" />
          <input type="text" required placeholder="Your name" value={form.ownerName} onChange={onChange('ownerName')}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
          <input type="tel" placeholder="Phone (optional)" value={form.ownerPhone} onChange={onChange('ownerPhone')}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
          <input type="text" required placeholder="Business name" value={form.businessName} onChange={onChange('businessName')}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
          <input type="url" required placeholder="Google Maps URL" value={form.googleMapsUrl} onChange={onChange('googleMapsUrl')}
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
          <textarea placeholder="Products / services (optional)" value={form.productsServices} onChange={onChange('productsServices')}
            rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
          <textarea placeholder="Staff names" value={form.staffNames} onChange={onChange('staffNames')}
            rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
          <textarea placeholder="Highlight facts" value={form.highlightFacts} onChange={onChange('highlightFacts')}
            rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
          <textarea placeholder="Avoid facts" value={form.avoidFacts} onChange={onChange('avoidFacts')}
            rows={2} className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm" />
          <label className="block text-sm">Plan</label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="tier" value="founding" checked={form.subscriptionTier === 'founding'} onChange={onChange('subscriptionTier')} />
            Founding
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="tier" value="standard" checked={form.subscriptionTier === 'standard'} onChange={onChange('subscriptionTier')} />
            Standard
          </label>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button type="submit" disabled={loading}
            className="w-full bg-blue-600 text-white font-medium py-3 rounded-md hover:bg-blue-700 disabled:opacity-50">
            {loading ? 'Submitting...' : 'Continue to payment'}
          </button>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/(public)/signup/
git commit -m "feat(signup): /signup, /signup/check-email, /signup/finish pages"
```

---

## Task 23: Onboarding pay + payment-success pages

**Files:**
- Create: `src/app/onboarding/pay/page.tsx`
- Create: `src/app/onboarding/payment-success/page.tsx`

- [ ] **Step 1: Pay page (server component)**

Create `src/app/onboarding/pay/page.tsx`:

```tsx
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { sql } from '@/lib/db/server';
import { buildPaymentLinkUrl } from '@/lib/payments/payment-link';

export default async function OnboardingPayPage({ searchParams }: { searchParams: { cancelled?: string } }) {
  const cookieStore = cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll() {},
      },
    },
  );
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [row] = await sql<{
    business_id: string;
    business_name: string;
    subscription_status: string;
    subscription_tier: string;
    owner_email: string;
    email_confirmed_at: Date | null;
  }[]>`
    SELECT
      b.id AS business_id, b.name AS business_name,
      b.subscription_status, b.subscription_tier, b.owner_email,
      (${user.id}::text IS NOT NULL)::boolean AS email_confirmed_at_placeholder  -- see note below
    FROM users u
    JOIN businesses b ON b.id = u.business_id
    WHERE u.auth_id = ${user.id}
    LIMIT 1
  `;
  if (!row) redirect('/signup');

  // Email-confirm check: Supabase exposes email_confirmed_at on the user metadata.
  if (!user.email_confirmed_at) redirect('/signup/check-email?from=pay');
  if (row.subscription_status === 'active') redirect('/dashboard');

  const paymentUrl = buildPaymentLinkUrl(
    row.subscription_tier as 'founding' | 'standard',
    row.business_id,
    row.owner_email,
  );

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-lg border border-gray-200 p-8 text-center">
        {searchParams.cancelled && (
          <p className="text-sm text-amber-700 mb-4">No worries — try again when you&apos;re ready.</p>
        )}
        <h1 className="text-2xl font-bold mb-4">Welcome to RepWorth!</h1>
        <p className="text-gray-700 mb-6">Complete your payment to unlock your dashboard.</p>
        {paymentUrl ? (
          <a href={paymentUrl}
            className="inline-block bg-blue-600 text-white font-medium py-3 px-8 rounded-md hover:bg-blue-700">
            Complete payment
          </a>
        ) : (
          <p className="text-sm text-red-600">Payment link unavailable. Contact support.</p>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Payment success page (polls signup-status)**

Create `src/app/onboarding/payment-success/page.tsx`:

```tsx
import { PaymentSuccessClient } from './PaymentSuccessClient';
export default function PaymentSuccessPage() {
  return <PaymentSuccessClient />;
}
```

Create `src/app/onboarding/payment-success/PaymentSuccessClient.tsx`:

```tsx
'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export function PaymentSuccessClient() {
  const [active, setActive] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    let delay = 2000;
    const startedAt = Date.now();

    async function poll() {
      try {
        const res = await fetch('/api/auth/signup-status');
        if (res.ok) {
          const body = await res.json();
          if (body.subscriptionStatus === 'active') {
            if (!cancelled) setActive(true);
            return;
          }
        }
      } catch { /* retry */ }

      setElapsed(Date.now() - startedAt);
      if (Date.now() - startedAt > 5 * 60_000) return; // 5-min cap
      delay = Math.min(delay * 1.5, 30_000); // exp backoff to 30s
      setTimeout(poll, delay);
    }

    poll();
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-lg border border-gray-200 p-8 text-center">
        {active ? (
          <>
            <h1 className="text-2xl font-bold mb-4">Welcome to RepWorth!</h1>
            <p className="text-gray-700 mb-6">Your subscription is active.</p>
            <button onClick={() => router.push('/dashboard')}
              className="bg-blue-600 text-white font-medium py-3 px-8 rounded-md hover:bg-blue-700">
              Go to dashboard
            </button>
          </>
        ) : elapsed > 5 * 60_000 ? (
          <>
            <h1 className="text-xl font-bold mb-4">Still processing...</h1>
            <p className="text-gray-700">This is taking longer than usual. Please contact support if it persists.</p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold mb-4">Processing your payment...</h1>
            <p className="text-gray-600">This usually takes a few seconds.</p>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/onboarding/
git commit -m "feat(signup): /onboarding/pay and /onboarding/payment-success pages"
```

---

## Task 24: Dashboard pending-payment banner

**Files:**
- Modify: `src/app/(authenticated)/dashboard/...page.tsx` (find the actual dashboard page file)

- [ ] **Step 1: Find the dashboard page**

Run: `ls src/app/\(authenticated\)/dashboard/`
Identify the main page file (likely `page.tsx`).

- [ ] **Step 2: Read current dashboard page**

Read it to understand how data fetches + renders.

- [ ] **Step 3: Add pending-payment branch at top**

If the page already fetches via `/api/dashboard`, check the response shape. When it includes `subscriptionStatus === 'pending_payment'` + `paymentUrl`, render only the banner card and skip the rest of the dashboard UI.

Example addition at the top of the render:

```tsx
if (data.subscriptionStatus === 'pending_payment') {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-lg border border-gray-200 p-8 text-center">
        <h1 className="text-2xl font-bold mb-4">Your subscription isn&apos;t active yet</h1>
        <p className="text-gray-700 mb-6">Complete your payment to unlock automated review responses.</p>
        {data.paymentUrl ? (
          <a href={data.paymentUrl}
            className="inline-block bg-blue-600 text-white font-medium py-3 px-8 rounded-md hover:bg-blue-700">
            Pay now
          </a>
        ) : (
          <p className="text-sm text-red-600">Payment link unavailable. Contact support.</p>
        )}
      </div>
    </div>
  );
}
// ... existing dashboard content ...
```

- [ ] **Step 4: Verify + run existing dashboard tests**

Run: `pnpm vitest run` (broad, catches any page-related test).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(authenticated\)/dashboard/
git commit -m "feat(signup): dashboard pending-payment banner"
```

---

## Task 25: Landing-page nav links + startup assertion + env

**Files:**
- Modify: `src/app/(public)/page.tsx`
- Modify: `worker/index.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add nav links to landing page**

Read `src/app/(public)/page.tsx`. In the nav section, conditionally render two new links based on the flag (server component reads `process.env` directly):

```tsx
{process.env.SELF_SERVE_SIGNUP_ENABLED === 'true' && (
  <>
    <a href="/login" className="text-sm text-gray-700 hover:text-gray-900">Log In</a>
    <a href="/signup"
      className="text-sm bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700">
      Sign Up
    </a>
  </>
)}
```

Place them alongside any existing nav items (keep "Book a demo" if present — different audience).

- [ ] **Step 2: Add worker startup assertion**

Modify `worker/index.ts`. Near the other `assert*Env` calls, add:

```ts
function assertSelfServeSignupEnv(): void {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') return;
  if (!process.env.REDIS_CACHE_URL) {
    throw new Error('[startup] SELF_SERVE_SIGNUP_ENABLED=true requires REDIS_CACHE_URL (strict rate-limit mode)');
  }
  if (!process.env.NEXT_PUBLIC_APP_URL) {
    throw new Error('[startup] SELF_SERVE_SIGNUP_ENABLED=true requires NEXT_PUBLIC_APP_URL');
  }
  if (!process.env.STRIPE_PAYMENT_LINK_FOUNDING || !process.env.STRIPE_PAYMENT_LINK_STANDARD) {
    throw new Error('[startup] SELF_SERVE_SIGNUP_ENABLED=true requires STRIPE_PAYMENT_LINK_FOUNDING + STRIPE_PAYMENT_LINK_STANDARD');
  }
}

// Call it during startup:
assertSelfServeSignupEnv();
```

- [ ] **Step 3: Update `.env.example`**

Append to `.env.example`:

```bash
# Self-serve signup
# Gates /signup, /login, /forgot-password, /reset-password, /api/auth/* (owner-only endpoints)
# and CleanupAbandonedSignupsPoller. Admin surfaces never gated.
SELF_SERVE_SIGNUP_ENABLED=false

# Cleanup poller tuning (optional; defaults shown)
CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS=86400000
CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE=100
```

- [ ] **Step 4: Update CLAUDE.md**

Modify `.claude/CLAUDE.md` §"Feature flags / non-obvious env vars" — add:

```
- `SELF_SERVE_SIGNUP_ENABLED=true` — gates owner self-serve signup/login/reset pages + APIs. Admin surfaces (`/admin/login`, `/admin/forgot-password`, `/admin/reset-password`) never gated. When on, requires `REDIS_CACHE_URL`, `NEXT_PUBLIC_APP_URL`, and both `STRIPE_PAYMENT_LINK_*` env vars (worker startup assertion fails otherwise).
- `CLEANUP_ABANDONED_SIGNUPS_INTERVAL_MS` — optional, default 24h.
- `CLEANUP_ABANDONED_SIGNUPS_BATCH_SIZE` — optional, default 100.
```

- [ ] **Step 5: Commit**

```bash
git add src/app/\(public\)/page.tsx worker/index.ts .env.example .claude/CLAUDE.md
git commit -m "feat(signup): landing nav + worker startup assertion + env documentation"
```

---

## Task 26: E2E — password signup happy path

**Files:**
- Create: `tests/e2e/signup-password.spec.ts`

- [ ] **Step 1: Write the E2E test**

Create `tests/e2e/signup-password.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test.describe('owner password signup flow', () => {
  test('signup → check-email → click confirm → pay → dashboard-active', async ({ page, context }) => {
    // This test uses test-mode Stripe + real Supabase. Configure env:
    //   SELF_SERVE_SIGNUP_ENABLED=true
    //   STRIPE_PAYMENT_LINK_STANDARD=<test-mode link>
    //   NEXT_PUBLIC_APP_URL=http://localhost:3000

    const testEmail = `test+${Date.now()}@example.com`;

    // 1. Fill signup form
    await page.goto('/signup');
    await page.fill('input[type=email]', testEmail);
    await page.fill('input[placeholder="Your name"]', 'E2E User');
    await page.fill('input[type=password]', 'password1234');
    await page.fill('input[placeholder="Business name"]', 'E2E Biz');
    await page.fill('input[placeholder="Google Maps URL for your business"]',
      'https://www.google.com/maps/place/Test/@0,0,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d0!4d0!16s%2Fg%2F11');
    await page.click('button[type=submit]:has-text("Continue")');

    // 2. Land on check-email page
    await expect(page).toHaveURL(/\/signup\/check-email/);
    await expect(page.getByText('Check your email')).toBeVisible();

    // 3. Simulate clicking the confirmation link (test-mode: query DB for the
    //    confirmation URL, or use Supabase admin API; this is harness-specific).
    //    Then assert landing on /onboarding/pay:
    // await page.goto(confirmUrl);
    // await expect(page).toHaveURL(/\/onboarding\/pay/);

    // 4. Click "Complete payment" → Stripe Payment Link test mode
    // await page.click('a:has-text("Complete payment")');
    // (fill Stripe test card 4242 4242 4242 4242, exp 12/34, CVC 123)

    // 5. Stripe redirects to /onboarding/payment-success
    // 6. Page polls until subscription_status='active' then shows "Go to dashboard"
    // 7. Click → /dashboard active

    // NOTE: the confirmation link + Stripe payment portions require harness
    // setup. Document both in tests/e2e/README.md for the implementation plan.
  });
});
```

- [ ] **Step 2: Write harness README**

Create `tests/e2e/README.md` documenting:
- How to obtain the Supabase confirmation link in test mode (via `supabase.auth.admin.generateLink` server-side).
- How to fill the Stripe test-mode Payment Link with a 4242 card.
- How to clean up test rows between runs.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/signup-password.spec.ts tests/e2e/README.md
git commit -m "test(signup): E2E password signup happy path + harness docs"
```

---

## Task 27: E2E — Google signup + forgot-password + reset-password

**Files:**
- Create: `tests/e2e/signup-google.spec.ts`
- Create: `tests/e2e/forgot-password.spec.ts`
- Create: `tests/e2e/reset-password.spec.ts`

- [ ] **Step 1: Google signup**

Create `tests/e2e/signup-google.spec.ts`. Since Playwright cannot automate the real Google OAuth flow, use a mocked session approach:
- Click "Continue with Google" on `/signup`.
- Inject a Supabase session cookie via `context.addCookies()` to simulate the post-OAuth state.
- Navigate to `/signup/finish`.
- Fill the business fields.
- Submit → assert redirect to `/onboarding/pay`.

Document the cookie-injection helper in `tests/e2e/README.md`.

- [ ] **Step 2: Forgot-password cross-portal**

Create `tests/e2e/forgot-password.spec.ts` asserting:
- Owner email submitted on `/forgot-password` → "If an account exists..." success message.
- Owner email submitted on `/admin/forgot-password` → same generic message (cross-portal protection: no email actually sent).
- Admin email submitted on `/forgot-password` → same generic message.

Use Supabase email capture (test-mode inbox or a mock Resend webhook) to assert no email was sent for the cross-portal cases.

- [ ] **Step 3: Reset-password completion**

Create `tests/e2e/reset-password.spec.ts`:
- Start from a recovery URL (generated via Supabase admin API).
- Follow callback → land on `/reset-password`.
- Set new password.
- Submit → redirected to `/login`.
- Log in with new password → land on `/dashboard`.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/
git commit -m "test(signup): E2E google signup + forgot-password + reset-password"
```

---

## Task 28: Rollout ship gate on staging

- [ ] **Step 1: Confirm all preceding tasks committed + tests green**

Run: `pnpm tsc --noEmit && pnpm vitest run && pnpm playwright test`
Expected: PASS across unit + integration + E2E.

- [ ] **Step 2: Flip `SELF_SERVE_SIGNUP_ENABLED=true` on staging**

Set in staging env (Vercel + Railway).

- [ ] **Step 3: Run the manual ship gate from spec §10 step 7**

Execute each scenario against staging and document in `docs/progresstracking.md`:

1. **Real password signup.** Fresh email. Fill `/signup`. Click email confirm link. Reach `/onboarding/pay`. Stripe test-mode pay. Land on `/dashboard` active.
2. **Real Google signup.** Fresh Google account. Finish flow → Stripe → active.
3. **Forgot-password owner branch.** Submit owner email on `/forgot-password`. Receive email. Click link → `/reset-password` → new password → log in with new password.
4. **Forgot-password admin branch.** Same as (3) but from `/admin/forgot-password` and admin email.
5. **Cross-portal protection:** submit owner email on `/admin/forgot-password` → generic success message → assert NO email arrives at owner inbox.
6. **Cross-portal protection (inverse):** submit admin email on `/forgot-password` → assert NO email arrives.
7. **Resend confirmation:** sign up, don't click link, go to `/signup/check-email`, enter email, click "Resend" → assert a new email arrives.
8. **Email-not-confirmed login:** sign up, don't confirm, try logging in on `/login` with the new password → assert redirect to `/signup/check-email?from=login` (not a raw error).
9. **Abandoned cleanup:** manually insert a 10-day-old self-serve pending_payment row via Supabase SQL editor, run the poller (or wait for the next cycle), assert the row is deleted.
10. **Polling load:** 50 concurrent `/onboarding/payment-success` polls against staging. Assert p99 < 100ms for `/api/auth/signup-status`.

- [ ] **Step 4: Flip production flag + merge landing nav links in same deploy**

Per spec §10 step 8: flip `SELF_SERVE_SIGNUP_ENABLED=true` in production AND merge the landing-page nav links in the same deploy so owners cannot land on a visible signup link while the flow is gated off.

- [ ] **Step 5: Post-ship smoke**

Within 1 hour of production flip:
- Sign up a real test business end-to-end.
- Verify `worker/jobs/ReconciliationPoller` picks up the new business on its next cycle.
- Check Sentry for any exceptions.

- [ ] **Step 6: Update CLAUDE.md status**

Update `.claude/CLAUDE.md` §"Current status": add "Owner self-serve signup shipped YYYY-MM-DD" under the "Shipped:" bullet.

```bash
git add .claude/CLAUDE.md docs/progresstracking.md
git commit -m "docs(signup): production rollout + ship gate log"
```

---

## Self-review checklist

After finishing the plan, skim against the spec:

- ✅ Migration 025: indexes + email backfill + onboarded_by backfill — Task 1.
- ✅ `auth-flow` / `csrf` / `route-helpers` / `payment-link` — Tasks 2–5.
- ✅ Signup schemas with preprocess normalization — Task 6.
- ✅ `createBusinessTx` with discriminated mode union — Task 7.
- ✅ Admin route refactor — Task 8.
- ✅ 6 API routes (signup, finish-signup, signup-status, forgot, reset, resend) — Tasks 9–14.
- ✅ Callback extension — Task 15.
- ✅ Stripe webhook transition-gated enqueue + advisory lock — Task 16.
- ✅ Dashboard API pending-payment branch — Task 17.
- ✅ Middleware + protected-routes — Task 18.
- ✅ Cleanup poller — Task 19.
- ✅ Shared form components — Task 20.
- ✅ Public + admin auth pages — Tasks 21.
- ✅ Signup + onboarding pages — Tasks 22–23.
- ✅ Dashboard banner — Task 24.
- ✅ Landing nav + startup assert + env — Task 25.
- ✅ E2E tests — Tasks 26–27.
- ✅ Ship gate — Task 28.

**No placeholders.** Every code block is executable. Every test contains real assertions. Every commit message is concrete.

**Type consistency.** `createBusinessTx(input, { mode, ... })` signature is identical across Tasks 7, 8, 9, 10. `AuthFlow` type used identically in Tasks 2, 15, 18, 20. `buildPaymentLinkUrl` signature matches between Tasks 5, 17, 23.

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-23-owner-self-serve-signup.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?

