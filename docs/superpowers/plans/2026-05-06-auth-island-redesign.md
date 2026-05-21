# Auth Island Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the gray `/login` and `/signup` pages with a brand-aligned "auth island" — a tabbed Sign in / Create account experience on a sage parallax field — without breaking any existing auth behavior or `/admin/login`.

**Architecture:** Both `/login` and `/signup` render the same new `AuthIslandClient`, differing only by `initialMode`. All auth logic moves out of the existing `LoginFormClient` / `SignupFormClient` into pure helpers (testable with vitest in node env) and small hooks (`useLoginSubmit`, `useSignupSubmit`, `useGoogleOAuth`). `LoginFormClient` is refactored to consume the same hooks so `/admin/login` keeps working. `SignupFormClient` is deleted.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript strict, `motion/react` (already installed), vitest 4.x in node env, `renderToStaticMarkup` for component tests, Supabase JS via `@/lib/db/browser`. No new npm packages.

**Spec:** `docs/superpowers/specs/2026-05-06-auth-island-redesign.md`

---

## File structure

### New (organized so each file owns one responsibility)

```
src/components/auth/
  hooks/
    useGoogleOAuth.ts          # wraps signInWithOAuth
    useLoginSubmit.ts          # password sign-in + post-login routing
    useSignupSubmit.ts         # POST /api/auth/signup + error mapping
  shared/
    strength.ts                # strengthOf() + STRENGTH_LABELS (pure)
    mapSignupError.ts          # signup HTTP error → user message (pure)
    mapLoginError.ts           # query-param + Supabase error → user message (pure)
    loginDestination.ts        # post-login route decision (pure)
    pathForMode.ts             # mode ↔ pathname (pure)
  auth-island/
    AuthIslandClient.tsx       # entry component, owns prefilledEmail state
    auth-island.css            # all auth-island scoped styles
    ParallaxField.tsx          # decorative blobs, pcards, chips
    Showcase.tsx               # left pane (brand, copy, preview cards, robot)
    Tabs.tsx                   # pill tab toggle
    LoginForm.tsx              # right pane: login visual
    SignupForm.tsx             # right pane: signup visual
    Field.tsx                  # input row with icon + optional show/hide
    Icons.tsx                  # inline-SVG set
    Robot.tsx                  # inline-SVG mascot
    fireConfetti.ts            # DOM helper, reduced-motion-aware
  __tests__/                   # plus per-file __tests__ folders for hooks/shared
    AuthIslandClient.test.tsx
    LoginFormClient.test.tsx   # admin-login regression
```

### Modified

- `src/app/(public)/login/page.tsx`
- `src/app/(public)/signup/page.tsx`
- `src/app/(public)/login/error.tsx`
- `src/app/(public)/signup/error.tsx`
- `src/components/auth/LoginFormClient.tsx` (refactor only — admin still uses it)

### Deleted

- `src/components/auth/SignupFormClient.tsx`

### Untouched

- `src/app/admin/login/page.tsx`
- `src/app/api/auth/signup/route.ts` (and all routes under `src/app/api/auth/`)
- `src/lib/shared/auth-flow.ts`, `auth-responses.ts`, `schemas.ts`
- `src/components/auth/{ForgotPasswordFormClient,ResetPasswordFormClient,CheckEmailClient,FinishSignupClient}.tsx`

---

## Testing strategy (matches existing codebase)

This codebase runs vitest in **node env** (`vitest.config.ts`) and asserts component output with `renderToStaticMarkup` (see `src/components/sections/lead-intake/__tests__/LeadIntakeForm.test.tsx`). `@testing-library/react` is **not** installed and we are **not** introducing it. Implications:

- Pure helpers (`strength`, `mapSignupError`, `mapLoginError`, `loginDestination`, `pathForMode`) are fully unit-tested with vitest.
- Hooks are tested via `vi.mock('@/lib/db/browser', ...)` for the Supabase client and `vi.spyOn(globalThis, 'fetch')` for HTTP — exercising the hook by calling its returned `submit()` directly inside a minimal harness component rendered with `createElement` + invoking `submit` from a ref. (Hooks will be tested through the pure submit functions they wrap, which is the simplest path.)
- Components are tested with `renderToStaticMarkup` for static-markup assertions: heading, attributes, conditional copy, presence of expected elements.

---

## Task 1: Pure helper — `strength.ts`

**Files:**
- Create: `src/components/auth/shared/strength.ts`
- Test: `src/components/auth/shared/__tests__/strength.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/components/auth/shared/__tests__/strength.test.ts
import { describe, expect, it } from 'vitest';
import { strengthOf, STRENGTH_LABELS } from '../strength';

describe('strengthOf', () => {
  it('returns 0 for empty input', () => {
    expect(strengthOf('')).toBe(0);
  });
  it('returns 1 once length reaches 8', () => {
    expect(strengthOf('abcdefgh')).toBe(1);
  });
  it('returns 2 with mixed case at length 8', () => {
    expect(strengthOf('Abcdefgh')).toBe(2);
  });
  it('returns 3 with mixed case + digit at length 8', () => {
    expect(strengthOf('Abcdefg1')).toBe(3);
  });
  it('returns 4 with mixed case + digit + symbol at length 10', () => {
    expect(strengthOf('Abcdefg1!_')).toBe(4);
  });
  it('does not award the symbol bar below length 10', () => {
    expect(strengthOf('Abcdefg1!')).toBe(3);
  });
});

describe('STRENGTH_LABELS', () => {
  it('has five entries (indices 0-4)', () => {
    expect(STRENGTH_LABELS).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `pnpm vitest src/components/auth/shared/__tests__/strength.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/components/auth/shared/strength.ts
export const STRENGTH_LABELS = [
  'Too short',
  'Getting there',
  'Decent',
  'Strong',
  'Excellent',
] as const;

export function strengthOf(pwd: string): number {
  if (!pwd) return 0;
  let s = 0;
  if (pwd.length >= 8) s++;
  if (/[A-Z]/.test(pwd) && /[a-z]/.test(pwd)) s++;
  if (/\d/.test(pwd)) s++;
  if (/[^A-Za-z0-9]/.test(pwd) && pwd.length >= 10) s++;
  return s;
}
```

- [ ] **Step 4: Run test, verify PASS**

Run: `pnpm vitest src/components/auth/shared/__tests__/strength.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/auth/shared/strength.ts src/components/auth/shared/__tests__/strength.test.ts
git commit -m "feat(auth): add password strengthOf helper for auth island"
```

---

## Task 2: Pure helper — `mapSignupError.ts`

**Files:**
- Create: `src/components/auth/shared/mapSignupError.ts`
- Test: `src/components/auth/shared/__tests__/mapSignupError.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/components/auth/shared/__tests__/mapSignupError.test.ts
import { describe, expect, it } from 'vitest';
import { mapSignupError } from '../mapSignupError';

describe('mapSignupError', () => {
  it('prefers the server-provided message when present', () => {
    const result = mapSignupError({ error: 'rate_limited', message: 'Custom message.' }, 429);
    expect(result.message).toBe('Custom message.');
    expect(result.kind).toBe('rate_limited');
  });
  it('falls back to the KNOWN_MESSAGES copy when message is absent', () => {
    const result = mapSignupError({ error: 'rate_limited' }, 429);
    expect(result.message).toMatch(/Too many signup attempts from your network/);
  });
  it('maps account_exists with email-aware copy', () => {
    const result = mapSignupError({ error: 'account_exists' }, 409);
    expect(result.kind).toBe('account_exists');
    expect(result.message).toMatch(/already exists/);
  });
  it('maps unknown error codes to the generic copy', () => {
    const result = mapSignupError({ error: 'mystery' }, 500);
    expect(result.message).toMatch(/Something went wrong/);
    expect(result.kind).toBe('unknown');
  });
  it('handles a body with no error code', () => {
    const result = mapSignupError({}, 500);
    expect(result.message).toMatch(/Signup failed|Something went wrong/);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `pnpm vitest src/components/auth/shared/__tests__/mapSignupError.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/components/auth/shared/mapSignupError.ts
export type SignupErrorKind =
  | 'rate_limited'
  | 'rate_limit_unavailable'
  | 'email_rate_limited'
  | 'account_exists'
  | 'invalid_json'
  | 'invalid_body'
  | 'internal'
  | 'unknown';

export interface MappedSignupError {
  kind: SignupErrorKind;
  message: string;
}

const KNOWN_MESSAGES: Record<Exclude<SignupErrorKind, 'unknown'>, string> = {
  rate_limited:
    'Too many signup attempts from your network. Please wait a few minutes and try again.',
  rate_limit_unavailable:
    'Signup is temporarily unavailable. Please try again in a moment.',
  email_rate_limited:
    'Too many signup attempts for this email recently. Please wait a few minutes and try again.',
  account_exists:
    'An account with that email already exists. Try signing in.',
  invalid_json:
    'Could not read your submission. Please try again.',
  invalid_body:
    "Some details don't look right. Please review and resubmit.",
  internal:
    'Something went wrong on our side. Please try again shortly.',
};

export function mapSignupError(
  body: { error?: unknown; message?: unknown },
  _status: number,
): MappedSignupError {
  const code = typeof body?.error === 'string' ? body.error : undefined;
  const serverMessage = typeof body?.message === 'string' ? body.message : undefined;
  const kind: SignupErrorKind =
    code && code in KNOWN_MESSAGES ? (code as SignupErrorKind) : 'unknown';
  const fallback = kind === 'unknown' ? KNOWN_MESSAGES.internal : KNOWN_MESSAGES[kind];
  return { kind, message: serverMessage ?? fallback };
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/components/auth/shared/mapSignupError.ts src/components/auth/shared/__tests__/mapSignupError.test.ts
git commit -m "feat(auth): add mapSignupError pure helper"
```

---

## Task 3: Pure helper — `mapLoginError.ts`

**Files:**
- Create: `src/components/auth/shared/mapLoginError.ts`
- Test: `src/components/auth/shared/__tests__/mapLoginError.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/components/auth/shared/__tests__/mapLoginError.test.ts
import { describe, expect, it } from 'vitest';
import { mapInitialQueryError, mapSupabaseAuthError, isEmailNotConfirmedError } from '../mapLoginError';

describe('mapInitialQueryError', () => {
  it('maps account_incomplete', () => {
    expect(mapInitialQueryError('account_incomplete')).toMatch(/not set up yet/);
  });
  it('maps auth_callback_failed', () => {
    expect(mapInitialQueryError('auth_callback_failed')).toMatch(/Sign-in failed/);
  });
  it('returns empty for null/unknown', () => {
    expect(mapInitialQueryError(null)).toBe('');
    expect(mapInitialQueryError('mystery')).toBe('');
  });
});

describe('mapSupabaseAuthError', () => {
  it('maps invalid credentials', () => {
    expect(mapSupabaseAuthError('Invalid login credentials')).toMatch(/Email or password is incorrect/);
  });
  it('passes through other messages verbatim (Supabase is the source of truth)', () => {
    expect(mapSupabaseAuthError('Something else')).toBe('Something else');
  });
});

describe('isEmailNotConfirmedError', () => {
  it('matches case-insensitively', () => {
    expect(isEmailNotConfirmedError('Email not confirmed')).toBe(true);
    expect(isEmailNotConfirmedError('email NOT confirmed')).toBe(true);
  });
  it('does not match other messages', () => {
    expect(isEmailNotConfirmedError('Invalid login credentials')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement**

```ts
// src/components/auth/shared/mapLoginError.ts
export function mapInitialQueryError(errorParam: string | null | undefined): string {
  if (errorParam === 'account_incomplete') {
    return 'Your account is not set up yet. Contact your administrator.';
  }
  if (errorParam === 'auth_callback_failed') {
    return 'Sign-in failed. Please try again.';
  }
  return '';
}

export function mapSupabaseAuthError(message: string): string {
  if (message === 'Invalid login credentials') {
    return 'Email or password is incorrect.';
  }
  return message;
}

export function isEmailNotConfirmedError(message: string): boolean {
  return message.toLowerCase().includes('email not confirmed');
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/components/auth/shared/mapLoginError.ts src/components/auth/shared/__tests__/mapLoginError.test.ts
git commit -m "feat(auth): add mapLoginError pure helpers"
```

---

## Task 4: Pure helper — `loginDestination.ts`

**Files:**
- Create: `src/components/auth/shared/loginDestination.ts`
- Test: `src/components/auth/shared/__tests__/loginDestination.test.ts`

This consolidates the post-login routing rules from `LoginFormClient.tsx` lines 24–48 (allow-listed `from` prefix sanitization) and lines 152–176 (subscription / business-onboarded guard).

- [ ] **Step 1: Write the failing test**

```ts
// src/components/auth/shared/__tests__/loginDestination.test.ts
import { describe, expect, it } from 'vitest';
import { resolvePostLoginDestination, applySubscriptionGuard } from '../loginDestination';

describe('resolvePostLoginDestination (owner)', () => {
  it('returns from when it is an allowed owner prefix', () => {
    expect(
      resolvePostLoginDestination('owner', '/dashboard/x', '/dashboard'),
    ).toBe('/dashboard/x');
  });
  it('falls back to defaultRoute when from is not allow-listed', () => {
    expect(
      resolvePostLoginDestination('owner', '/admin/overview', '/dashboard'),
    ).toBe('/dashboard');
  });
  it('rejects protocol-relative URLs', () => {
    expect(
      resolvePostLoginDestination('owner', '//evil.com', '/dashboard'),
    ).toBe('/dashboard');
  });
  it('rejects non-absolute paths', () => {
    expect(
      resolvePostLoginDestination('owner', 'dashboard', '/dashboard'),
    ).toBe('/dashboard');
  });
});

describe('resolvePostLoginDestination (admin)', () => {
  it('accepts /admin paths that are not auth pages', () => {
    expect(
      resolvePostLoginDestination('admin', '/admin/overview', '/admin/overview'),
    ).toBe('/admin/overview');
  });
  it('rejects admin auth pages to avoid login loops', () => {
    expect(
      resolvePostLoginDestination('admin', '/admin/login', '/admin/overview'),
    ).toBe('/admin/overview');
    expect(
      resolvePostLoginDestination('admin', '/admin/forgot-password', '/admin/overview'),
    ).toBe('/admin/overview');
  });
  it('rejects non-/admin paths', () => {
    expect(
      resolvePostLoginDestination('admin', '/dashboard', '/admin/overview'),
    ).toBe('/admin/overview');
  });
});

describe('applySubscriptionGuard', () => {
  it('returns null for admin portal', () => {
    expect(
      applySubscriptionGuard('admin', { subscriptionStatus: 'pending_payment' }),
    ).toBeNull();
  });
  it('returns /onboarding/pay for pending_payment owners', () => {
    expect(
      applySubscriptionGuard('owner', { subscriptionStatus: 'pending_payment' }),
    ).toBe('/onboarding/pay');
  });
  it('returns /onboarding/business for active+!businessOnboarded owners', () => {
    expect(
      applySubscriptionGuard('owner', {
        subscriptionStatus: 'active',
        businessOnboarded: false,
      }),
    ).toBe('/onboarding/business');
  });
  it('returns null when active and businessOnboarded', () => {
    expect(
      applySubscriptionGuard('owner', {
        subscriptionStatus: 'active',
        businessOnboarded: true,
      }),
    ).toBeNull();
  });
  it('returns null when status is past_due or cancelled (banner handles it)', () => {
    expect(applySubscriptionGuard('owner', { subscriptionStatus: 'past_due' })).toBeNull();
    expect(applySubscriptionGuard('owner', { subscriptionStatus: 'cancelled' })).toBeNull();
  });
  it('returns null for an undefined status payload', () => {
    expect(applySubscriptionGuard('owner', undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement**

```ts
// src/components/auth/shared/loginDestination.ts
import type { AuthFlow } from '@/lib/shared/auth-flow';

const OWNER_ALLOWED_PREFIXES = ['/dashboard', '/settings', '/onboarding'] as const;
const ADMIN_AUTH_PAGES = ['/admin/login', '/admin/forgot-password', '/admin/reset-password'] as const;

export function resolvePostLoginDestination(
  portal: AuthFlow,
  from: string,
  defaultRoute: string,
): string {
  if (!from.startsWith('/') || from.startsWith('//')) {
    return defaultRoute;
  }
  if (portal === 'owner') {
    const allowed = OWNER_ALLOWED_PREFIXES.some((prefix) => from.startsWith(prefix));
    return allowed ? from : defaultRoute;
  }
  if (!from.startsWith('/admin')) {
    return defaultRoute;
  }
  const isAuthPage = ADMIN_AUTH_PAGES.some(
    (page) => from === page || from.startsWith(`${page}/`),
  );
  return isAuthPage ? defaultRoute : from;
}

export interface SignupStatusPayload {
  subscriptionStatus?: string;
  businessOnboarded?: boolean;
}

export function applySubscriptionGuard(
  portal: AuthFlow,
  status: SignupStatusPayload | undefined,
): string | null {
  if (portal !== 'owner' || !status) return null;
  if (status.subscriptionStatus === 'pending_payment') return '/onboarding/pay';
  if (status.subscriptionStatus === 'active' && status.businessOnboarded === false) {
    return '/onboarding/business';
  }
  return null;
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/components/auth/shared/loginDestination.ts src/components/auth/shared/__tests__/loginDestination.test.ts
git commit -m "feat(auth): extract resolvePostLoginDestination + applySubscriptionGuard"
```

---

## Task 5: Pure helper — `pathForMode.ts`

**Files:**
- Create: `src/components/auth/shared/pathForMode.ts`
- Test: `src/components/auth/shared/__tests__/pathForMode.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/components/auth/shared/__tests__/pathForMode.test.ts
import { describe, expect, it } from 'vitest';
import { pathForMode, modeForPath } from '../pathForMode';

describe('pathForMode', () => {
  it('login → /login', () => expect(pathForMode('login')).toBe('/login'));
  it('signup → /signup', () => expect(pathForMode('signup')).toBe('/signup'));
});

describe('modeForPath', () => {
  it('/login → login', () => expect(modeForPath('/login')).toBe('login'));
  it('/signup → signup', () => expect(modeForPath('/signup')).toBe('signup'));
  it('falls back to login for unknown paths', () => {
    expect(modeForPath('/anything-else')).toBe('login');
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement**

```ts
// src/components/auth/shared/pathForMode.ts
export type AuthMode = 'login' | 'signup';

export function pathForMode(mode: AuthMode): '/login' | '/signup' {
  return mode === 'signup' ? '/signup' : '/login';
}

export function modeForPath(pathname: string | null | undefined): AuthMode {
  return pathname === '/signup' ? 'signup' : 'login';
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/components/auth/shared/pathForMode.ts src/components/auth/shared/__tests__/pathForMode.test.ts
git commit -m "feat(auth): add pathForMode/modeForPath helpers"
```

---

## Task 6: Hook — `useGoogleOAuth`

**Files:**
- Create: `src/components/auth/hooks/useGoogleOAuth.ts`

This wraps `supabase.auth.signInWithOAuth`. No new tests beyond the integration tests in Task 9 — the existing `LoginFormClient` admin regression test will exercise this through the refactored client.

- [ ] **Step 1: Implement**

```ts
// src/components/auth/hooks/useGoogleOAuth.ts
'use client';

import { useState } from 'react';
import { createBrowserSupabaseClient } from '@/lib/db/browser';
import type { AuthFlow } from '@/lib/shared/auth-flow';

export interface UseGoogleOAuthInput {
  flow: AuthFlow;
  next: string;
}

export interface UseGoogleOAuthReturn {
  start: () => Promise<void>;
  loading: boolean;
  error: string;
}

export function useGoogleOAuth({ flow, next }: UseGoogleOAuthInput): UseGoogleOAuthReturn {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function start() {
    if (loading) return;
    setError('');
    setLoading(true);
    try {
      const supabase = createBrowserSupabaseClient();
      const redirectTo = `${window.location.origin}/api/auth/callback?flow=${flow}&next=${next}`;
      const { error: signInError } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo },
      });
      if (signInError) {
        setError(
          'Could not start Google sign-in. Please try again or use the email form below.',
        );
        setLoading(false);
      }
      // Success path: browser navigates away; do not clear loading to avoid flicker.
    } catch {
      setError(
        'Could not start Google sign-in. Please try again or use the email form below.',
      );
      setLoading(false);
    }
  }

  return { start, loading, error };
}
```

- [ ] **Step 2: Sanity-check it compiles**

Run: `pnpm tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/auth/hooks/useGoogleOAuth.ts
git commit -m "feat(auth): extract useGoogleOAuth hook"
```

---

## Task 7: Hook — `useLoginSubmit`

**Files:**
- Create: `src/components/auth/hooks/useLoginSubmit.ts`

Wraps the existing `LoginFormClient.handleSubmit` logic, calling the pure helpers from Tasks 3 and 4.

- [ ] **Step 1: Implement**

```ts
// src/components/auth/hooks/useLoginSubmit.ts
'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createBrowserSupabaseClient } from '@/lib/db/browser';
import type { AuthFlow } from '@/lib/shared/auth-flow';
import {
  isEmailNotConfirmedError,
  mapSupabaseAuthError,
} from '@/components/auth/shared/mapLoginError';
import {
  applySubscriptionGuard,
  resolvePostLoginDestination,
  type SignupStatusPayload,
} from '@/components/auth/shared/loginDestination';

export interface UseLoginSubmitInput {
  portal: AuthFlow;
  allowedRoles: readonly string[];
  defaultRoute: string;
}

export interface UseLoginSubmitReturn {
  submit: (email: string, password: string) => Promise<void>;
  loading: boolean;
  error: string;
  setError: (e: string) => void;
}

export function useLoginSubmit({
  portal,
  allowedRoles,
  defaultRoute,
}: UseLoginSubmitInput): UseLoginSubmitReturn {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();
  const searchParams = useSearchParams();

  async function submit(rawEmail: string, password: string) {
    const email = rawEmail.trim().toLowerCase();
    setError('');
    setLoading(true);
    try {
      const supabase = createBrowserSupabaseClient();
      const { error: authError, data } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (authError) {
        if (isEmailNotConfirmedError(authError.message)) {
          router.push(`/signup/check-email?from=login&email=${encodeURIComponent(email)}`);
          return;
        }
        setError(mapSupabaseAuthError(authError.message));
        return;
      }

      const authId = data?.user?.id;
      if (!authId) {
        await supabase.auth.signOut();
        setError('Sign-in succeeded but no auth user was returned. Please try again.');
        return;
      }

      const { data: userRow, error: lookupErr } = await supabase
        .from('users')
        .select('role')
        .eq('auth_id', authId)
        .limit(1)
        .maybeSingle();

      if (lookupErr) {
        await supabase.auth.signOut();
        setError('Could not load your account details. Please try again.');
        return;
      }
      if (!userRow) {
        await supabase.auth.signOut();
        setError('Your account is not fully set up. Contact your administrator.');
        return;
      }

      const role = (userRow as { role: string }).role;
      if (!allowedRoles.includes(role)) {
        await supabase.auth.signOut();
        setError(
          portal === 'owner'
            ? 'That account is for the admin portal. Use /admin/login instead.'
            : 'That account is for the owner portal. Use /login instead.',
        );
        return;
      }

      let destinationOverride: string | null = null;
      if (portal === 'owner') {
        try {
          const statusRes = await fetch('/api/auth/signup-status');
          if (statusRes.ok) {
            const status = (await statusRes.json()) as SignupStatusPayload;
            destinationOverride = applySubscriptionGuard(portal, status);
          }
        } catch {
          // Soft-fail; downstream guards will catch this on next nav.
        }
      }

      const from = searchParams.get('from') ?? '';
      const destination =
        destinationOverride ??
        resolvePostLoginDestination(portal, from, defaultRoute);
      router.push(destination);
      router.refresh();
    } catch {
      setError('Connection failed');
    } finally {
      setLoading(false);
    }
  }

  return { submit, loading, error, setError };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/auth/hooks/useLoginSubmit.ts
git commit -m "feat(auth): extract useLoginSubmit hook"
```

---

## Task 8: Hook — `useSignupSubmit`

**Files:**
- Create: `src/components/auth/hooks/useSignupSubmit.ts`

- [ ] **Step 1: Implement**

```ts
// src/components/auth/hooks/useSignupSubmit.ts
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { mapSignupError, type MappedSignupError } from '@/components/auth/shared/mapSignupError';

export interface UseSignupSubmitReturn {
  submit: (input: SignupInput) => Promise<void>;
  loading: boolean;
  error: string;
  errorKind: MappedSignupError['kind'] | null;
  setError: (e: string) => void;
}

export interface SignupInput {
  ownerEmail: string;
  ownerName: string;
  ownerPhone: string; // empty string ok; will be omitted from payload
  password: string;
}

export function useSignupSubmit(): UseSignupSubmitReturn {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [errorKind, setErrorKind] = useState<MappedSignupError['kind'] | null>(null);
  const router = useRouter();

  async function submit(input: SignupInput) {
    setError('');
    setErrorKind(null);
    setLoading(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ownerEmail: input.ownerEmail.trim().toLowerCase(),
          ownerName: input.ownerName.trim(),
          ownerPhone: input.ownerPhone.trim() || undefined,
          password: input.password,
        }),
      });
      const body = (await res.json()) as { error?: unknown; message?: unknown; redirectTo?: unknown };
      if (!res.ok) {
        const mapped = mapSignupError(body, res.status);
        setError(mapped.message);
        setErrorKind(mapped.kind);
        return;
      }
      const redirectTo =
        typeof body.redirectTo === 'string' ? body.redirectTo : '/signup/check-email';
      router.push(redirectTo);
    } catch {
      setError('Connection failed');
      setErrorKind('unknown');
    } finally {
      setLoading(false);
    }
  }

  return { submit, loading, error, errorKind, setError };
}
```

- [ ] **Step 2: Typecheck**

- [ ] **Step 3: Commit**

```bash
git add src/components/auth/hooks/useSignupSubmit.ts
git commit -m "feat(auth): extract useSignupSubmit hook"
```

---

## Task 9: Refactor `LoginFormClient` to use the new hooks

**Files:**
- Modify: `src/components/auth/LoginFormClient.tsx`
- Create: `src/components/auth/__tests__/LoginFormClient.test.tsx`

The visual stays gray-utility (admin uses it). Internals delegate to `useLoginSubmit` and `useGoogleOAuth`. Behavior must remain identical.

- [ ] **Step 1: Write a regression test for the admin shape**

```tsx
// src/components/auth/__tests__/LoginFormClient.test.tsx
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LoginFormClient } from '../LoginFormClient';

describe('LoginFormClient (admin)', () => {
  it('does not render the Google button when showGoogleButton is false', () => {
    const html = renderToStaticMarkup(
      createElement(LoginFormClient, {
        portal: 'admin',
        brandName: 'RepWorth Admin',
        showGoogleButton: false,
        defaultRoute: '/admin/overview',
        allowedRoles: ['admin', 'sales_partner'] as const,
      }),
    );
    expect(html).toContain('RepWorth Admin');
    expect(html).not.toContain('Continue with Google');
  });

  it('renders the Google button when showGoogleButton is true', () => {
    const html = renderToStaticMarkup(
      createElement(LoginFormClient, {
        portal: 'owner',
        brandName: 'RepWorth',
        showGoogleButton: true,
        defaultRoute: '/dashboard',
        allowedRoles: ['owner'] as const,
      }),
    );
    expect(html).toContain('Continue with Google');
  });
});
```

- [ ] **Step 2: Run test, expect PASS against the existing LoginFormClient (baseline)**

Run: `pnpm vitest src/components/auth/__tests__/LoginFormClient.test.tsx`
Expected: PASS — captures current behavior so we can verify no regression after refactor.

- [ ] **Step 3: Refactor `LoginFormClient.tsx`**

```tsx
// src/components/auth/LoginFormClient.tsx
'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { AuthFlow } from '@/lib/shared/auth-flow';
import { useLoginSubmit } from '@/components/auth/hooks/useLoginSubmit';
import { useGoogleOAuth } from '@/components/auth/hooks/useGoogleOAuth';
import { mapInitialQueryError } from '@/components/auth/shared/mapLoginError';

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

function LoginFormInner({
  portal,
  brandName,
  showGoogleButton,
  defaultRoute,
  allowedRoles,
}: LoginFormProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const searchParams = useSearchParams();
  const { submit, loading, error, setError } = useLoginSubmit({
    portal,
    allowedRoles,
    defaultRoute,
  });
  const oauth = useGoogleOAuth({ flow: portal, next: defaultRoute });

  // Initial error from URL query string (account_incomplete, auth_callback_failed).
  // setError is local to the hook, but we want it visible on first render —
  // applying once via useState initializer would deviate from the pre-refactor
  // behavior, so we mirror the original here: read on each render and prefer
  // the hook's error when set.
  const initialQueryError = mapInitialQueryError(searchParams.get('error'));
  const displayError = error || initialQueryError || oauth.error;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    await submit(email, password);
  }

  const forgotPath = portal === 'owner' ? '/forgot-password' : '/admin/forgot-password';

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-gray-900 text-center mb-8">{brandName}</h1>
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-lg border border-gray-200 p-6 space-y-4"
        >
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          {displayError && <p className="text-sm text-red-600">{displayError}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white font-medium py-2 rounded-md text-sm hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
          {showGoogleButton && (
            <button
              type="button"
              onClick={() => void oauth.start()}
              className="w-full bg-white border border-gray-300 text-gray-700 font-medium py-2 rounded-md text-sm hover:bg-gray-50 transition-colors"
            >
              Continue with Google
            </button>
          )}
          <p className="text-xs text-gray-500 text-center">
            <a href={forgotPath} className="hover:underline">
              Forgot password?
            </a>
          </p>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Re-run regression test, verify PASS**

Run: `pnpm vitest src/components/auth/__tests__/LoginFormClient.test.tsx`
Expected: PASS, both cases.

- [ ] **Step 5: Commit**

```bash
git add src/components/auth/LoginFormClient.tsx src/components/auth/__tests__/LoginFormClient.test.tsx
git commit -m "refactor(auth): extract LoginFormClient internals to hooks"
```

---

## Task 10: `auth-island.css`

**Files:**
- Create: `src/components/auth/auth-island/auth-island.css`

This is a near-verbatim port of the design's `styles.css` (referenced from the design bundle), scoped under the `.rw-auth` root class so we don't leak globals. CSS variables come from `colors_and_type.css` in the design bundle, which match the marketing palette already in use.

- [ ] **Step 1: Create the file**

```css
/* src/components/auth/auth-island/auth-island.css
 * Auth Island — sage parallax field, white rounded island, two-pane layout.
 * Tokens align with the marketing palette in src/app/(public)/. */

.rw-auth {
  --rw-sage: #d2e0d3;
  --rw-teal: #97b3ae;
  --rw-peach: #f2c3b9;
  --rw-pink: #f0ddd6;
  --rw-beige: #d6cbbf;
  --rw-cream: #f0eeea;
  --rw-ink: #2a2a2a;
  --rw-ink-soft: #6a6a6a;
  --rw-font-display: var(--font-plus-jakarta), ui-sans-serif, system-ui, sans-serif;
  --rw-font-body: var(--font-dm-sans), ui-sans-serif, system-ui, sans-serif;

  font-family: var(--rw-font-body);
  background: var(--rw-sage);
  color: var(--rw-ink);
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
  position: relative;
  overflow-x: hidden;
}

.rw-auth * { box-sizing: border-box; }

/* Parallax field */
.rw-field { position: fixed; inset: 0; pointer-events: none; z-index: 0; overflow: hidden; }
.rw-field-wash { position: absolute; inset: 0; background: rgba(210, 224, 211, 0.65); backdrop-filter: blur(2px); }

.rw-blob { position: absolute; border-radius: 9999px; filter: blur(60px); opacity: 0.55; }
.rw-blob.b1 { width: 520px; height: 520px; background: var(--rw-peach); top: -160px; left: -120px; animation: blobDrift1 22s ease-in-out infinite; }
.rw-blob.b2 { width: 460px; height: 460px; background: var(--rw-teal); bottom: -180px; right: -140px; animation: blobDrift2 26s ease-in-out infinite; }
.rw-blob.b3 { width: 360px; height: 360px; background: var(--rw-pink); top: 40%; right: 8%; animation: blobDrift3 30s ease-in-out infinite; opacity: 0.4; }
.rw-blob.b4 { width: 300px; height: 300px; background: var(--rw-beige); bottom: 10%; left: 6%; animation: blobDrift1 28s ease-in-out infinite reverse; opacity: 0.4; }
@keyframes blobDrift1 { 0%, 100% { transform: translate(0,0) scale(1); } 33% { transform: translate(60px,40px) scale(1.08); } 66% { transform: translate(-30px,80px) scale(0.95); } }
@keyframes blobDrift2 { 0%, 100% { transform: translate(0,0) scale(1); } 33% { transform: translate(-50px,-40px) scale(1.05); } 66% { transform: translate(40px,-60px) scale(0.92); } }
@keyframes blobDrift3 { 0%, 100% { transform: translate(0,0); } 50% { transform: translate(-40px,30px); } }

/* Parallax frosted preview cards */
.rw-pcard { position: absolute; background: rgba(255,255,255,0.42); backdrop-filter: blur(14px); border-radius: 24px; border: 1px solid rgba(255,255,255,0.6); padding: 22px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.08); width: 240px; }
.rw-pcard.p1 { top: 8%; left: 4%; transform: rotate(-6deg); animation: floatA 9s ease-in-out infinite; }
.rw-pcard.p2 { top: 12%; right: 5%; transform: rotate(5deg); animation: floatB 11s ease-in-out infinite; }
.rw-pcard.p3 { bottom: 8%; left: 6%; transform: rotate(4deg); animation: floatB 13s ease-in-out infinite; }
.rw-pcard.p4 { bottom: 14%; right: 4%; transform: rotate(-7deg); animation: floatA 10s ease-in-out infinite; }
@media (max-width: 1100px) { .rw-pcard { display: none; } }
@keyframes floatA { 0%, 100% { translate: 0 0; } 50% { translate: 0 -18px; } }
@keyframes floatB { 0%, 100% { translate: 0 0; } 50% { translate: 0 -14px; } }

.rw-pcard-stars { display: flex; gap: 2px; margin-bottom: 10px; color: #eab308; font-size: 14px; }
.rw-pcard-bar { height: 8px; border-radius: 4px; background: rgba(42,42,42,0.18); margin-bottom: 6px; }
.rw-pcard-bar.short { width: 60%; }
.rw-pcard-bar.tealish { background: rgba(151,179,174,0.4); }
.rw-pcard-reply { margin-top: 12px; padding-left: 10px; border-left: 2px solid rgba(151,179,174,0.45); }

/* Live-status chips */
.rw-chip { position: absolute; background: rgba(255,255,255,0.7); backdrop-filter: blur(10px); border-radius: 14px; border: 1px solid rgba(255,255,255,0.7); box-shadow: 0 12px 24px -8px rgba(0,0,0,0.12); padding: 10px 14px; display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--rw-ink); }
.rw-chip .dot { width: 8px; height: 8px; border-radius: 9999px; background: #16a34a; box-shadow: 0 0 0 4px rgba(22,163,74,0.18); animation: pulse 2.4s ease-in-out infinite; }
.rw-chip.c1 { top: 18%; left: 12%; animation: floatA 8s ease-in-out infinite; }
.rw-chip.c2 { bottom: 22%; right: 12%; animation: floatB 10s ease-in-out infinite; }
@media (max-width: 1100px) { .rw-chip { display: none; } }
@keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(22,163,74,0.4); } 50% { box-shadow: 0 0 0 6px rgba(22,163,74,0); } }

/* Page wrap + Island */
.rw-page { position: relative; z-index: 10; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 40px 20px; }
.rw-island { width: 100%; max-width: 1080px; background: #fff; border-radius: 48px; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); overflow: hidden; display: grid; grid-template-columns: 1.05fr 1fr; min-height: 680px; opacity: 0; transform: translateY(30px) scale(0.97); animation: rwIntro 0.8s cubic-bezier(0.25,0.46,0.45,0.94) forwards; }
@keyframes rwIntro { to { opacity: 1; transform: none; } }
@media (max-width: 900px) { .rw-island { grid-template-columns: 1fr; } }

/* Showcase pane */
.rw-showcase { position: relative; padding: 56px 52px; background: radial-gradient(ellipse at 20% 0%, rgba(242,195,185,0.55) 0%, transparent 55%), radial-gradient(ellipse at 100% 100%, rgba(151,179,174,0.55) 0%, transparent 55%), linear-gradient(160deg, #f0eeea 0%, #ffffff 60%, #f0ddd6 100%); display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; }
@media (max-width: 900px) { .rw-showcase { display: none; } }

.rw-brand { display: flex; align-items: center; gap: 10px; }
.rw-brand-logo { width: 40px; height: 40px; display: block; filter: drop-shadow(0 4px 10px rgba(151,179,174,0.35)); }
.rw-brand-word { font-size: 14px; letter-spacing: 0.16em; text-transform: uppercase; color: var(--rw-teal); font-weight: 600; }
.rw-showcase-eyebrow { font-size: 13px; font-weight: 500; text-transform: uppercase; letter-spacing: 0.14em; color: var(--rw-teal); margin: 40px 0 16px; }
.rw-showcase-h { font-family: var(--rw-font-display); font-weight: 600; font-size: 44px; line-height: 1.08; letter-spacing: -0.015em; color: var(--rw-ink); margin: 0 0 20px; }
.rw-showcase-h em { font-style: normal; font-weight: 600; color: var(--rw-teal); position: relative; }
.rw-showcase-h em::after { content: ''; position: absolute; left: 0; right: 0; bottom: 4px; height: 8px; background: rgba(242,195,185,0.55); z-index: -1; border-radius: 4px; }
.rw-showcase-lead { font-size: 16px; color: var(--rw-ink-soft); line-height: 1.6; margin: 0 0 28px; max-width: 360px; }

.rw-preview { position: relative; margin: 8px 0 24px; min-height: 240px; }
.rw-review-card { position: absolute; left: 0; right: 30px; background: #fff; border-radius: 18px; padding: 18px 20px; box-shadow: 0 18px 36px -10px rgba(0,0,0,0.12); border: 1px solid rgba(151,179,174,0.12); animation: cardFloat 5s ease-in-out infinite; }
.rw-review-card.r1 { top: 0; transform: rotate(-2deg); animation-delay: 0s; z-index: 2; }
.rw-review-card.r2 { top: 90px; left: 30px; right: 0; transform: rotate(2deg); animation-delay: 1.5s; z-index: 1; }
@keyframes cardFloat { 0%, 100% { translate: 0 0; } 50% { translate: 0 -6px; } }
.rw-review-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.rw-avatar { width: 32px; height: 32px; border-radius: 9999px; background: linear-gradient(135deg, var(--rw-peach), var(--rw-pink)); flex-shrink: 0; }
.rw-avatar.t { background: linear-gradient(135deg, var(--rw-teal), rgba(151,179,174,0.6)); }
.rw-review-name { font-size: 13px; font-weight: 600; color: var(--rw-ink); }
.rw-review-stars { color: #eab308; font-size: 12px; letter-spacing: 1px; }
.rw-review-body { font-size: 13px; color: var(--rw-ink-soft); line-height: 1.5; margin: 0 0 10px; }
.rw-review-reply { background: rgba(151,179,174,0.1); border-left: 2px solid var(--rw-teal); padding: 8px 10px; border-radius: 0 8px 8px 0; font-size: 12px; color: var(--rw-ink); }
.rw-review-reply .badge { display: inline-block; font-size: 10px; font-weight: 600; color: var(--rw-teal); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 4px; }

.rw-stats { display: grid; grid-template-columns: repeat(3,1fr); gap: 10px; }
.rw-stat { background: rgba(255,255,255,0.6); backdrop-filter: blur(8px); border: 1px solid rgba(151,179,174,0.15); border-radius: 14px; padding: 12px 14px; }
.rw-stat-val { font-family: var(--rw-font-display); font-weight: 700; font-size: 22px; color: var(--rw-ink); letter-spacing: -0.02em; }
.rw-stat-lbl { font-size: 11px; color: var(--rw-ink-soft); margin-top: 2px; }

/* Form pane */
.rw-form-pane { padding: 56px 64px; display: flex; flex-direction: column; justify-content: center; position: relative; }
@media (max-width: 900px) { .rw-form-pane { padding: 40px 28px; } }

.rw-tabs { display: inline-flex; background: rgba(151,179,174,0.1); border-radius: 9999px; padding: 4px; margin-bottom: 32px; align-self: flex-start; position: relative; }
.rw-tab { position: relative; z-index: 2; padding: 10px 24px; border: 0; background: transparent; font: 500 14px var(--rw-font-body); color: var(--rw-ink-soft); border-radius: 9999px; cursor: pointer; transition: color 0.3s; white-space: nowrap; }
.rw-tab.is-active { color: var(--rw-ink); }
.rw-tab-pill { position: absolute; top: 4px; bottom: 4px; background: #fff; border-radius: 9999px; box-shadow: 0 4px 10px rgba(0,0,0,0.08); transition: left 0.4s cubic-bezier(0.34,1.56,0.64,1), width 0.4s cubic-bezier(0.34,1.56,0.64,1); z-index: 1; }

.rw-form-h { font-family: var(--rw-font-display); font-weight: 700; font-size: 32px; line-height: 1.15; color: var(--rw-ink); margin: 0 0 8px; letter-spacing: -0.01em; }
.rw-form-sub { font-size: 15px; color: var(--rw-ink-soft); margin: 0 0 28px; }

.rw-stagger > * { opacity: 0; transform: translateY(10px); animation: rise 0.5s cubic-bezier(0.25,0.46,0.45,0.94) forwards; }
.rw-stagger > *:nth-child(1) { animation-delay: 0.05s; }
.rw-stagger > *:nth-child(2) { animation-delay: 0.10s; }
.rw-stagger > *:nth-child(3) { animation-delay: 0.15s; }
.rw-stagger > *:nth-child(4) { animation-delay: 0.20s; }
.rw-stagger > *:nth-child(5) { animation-delay: 0.25s; }
.rw-stagger > *:nth-child(6) { animation-delay: 0.30s; }
.rw-stagger > *:nth-child(7) { animation-delay: 0.35s; }
.rw-stagger > *:nth-child(8) { animation-delay: 0.40s; }
@keyframes rise { to { opacity: 1; transform: none; } }

/* Google button */
.rw-google-btn { width: 100%; display: flex; align-items: center; justify-content: center; gap: 12px; padding: 13px 18px; background: #fff; border: 1px solid rgba(151,179,174,0.25); border-radius: 12px; font: 500 14.5px var(--rw-font-body); color: var(--rw-ink); cursor: pointer; transition: all 0.25s; box-shadow: 0 1px 2px rgba(0,0,0,0.04); }
.rw-google-btn:hover:not(:disabled) { border-color: var(--rw-teal); transform: translateY(-1px); box-shadow: 0 8px 20px rgba(151,179,174,0.18); }
.rw-google-btn:disabled { opacity: 0.6; cursor: not-allowed; }
.rw-google-btn svg { width: 18px; height: 18px; }
.rw-divider { display: flex; align-items: center; gap: 12px; margin: 22px 0; color: var(--rw-ink-soft); font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; }
.rw-divider::before, .rw-divider::after { content: ''; flex: 1; height: 1px; background: rgba(151,179,174,0.2); }

/* Inputs */
.rw-field-row { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
.rw-field-row .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.rw-label { font: 500 13px var(--rw-font-body); color: var(--rw-ink); letter-spacing: 0.01em; }
.rw-input-wrap { position: relative; }
.rw-input { width: 100%; padding: 13px 14px 13px 42px; border: 1px solid rgba(151,179,174,0.25); border-radius: 12px; font: 400 14.5px var(--rw-font-body); color: var(--rw-ink); background: #fff; transition: all 0.2s; }
.rw-input::placeholder { color: rgba(106,106,106,0.55); }
.rw-input:hover { border-color: rgba(151,179,174,0.45); }
.rw-input:focus { outline: none; border-color: var(--rw-teal); box-shadow: 0 0 0 4px rgba(151,179,174,0.15); }
.rw-input.has-error { border-color: #dc2626; box-shadow: 0 0 0 4px rgba(220,38,38,0.1); animation: shake 0.4s; }
@keyframes shake { 0%, 100% { transform: translateX(0); } 25% { transform: translateX(-6px); } 75% { transform: translateX(6px); } }
.rw-input-icon { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); color: var(--rw-ink-soft); pointer-events: none; }
.rw-input-icon svg { width: 18px; height: 18px; display: block; }
.rw-input:focus ~ .rw-input-icon, .rw-input-wrap:focus-within .rw-input-icon { color: var(--rw-teal); }
.rw-toggle-pwd { position: absolute; right: 12px; top: 50%; transform: translateY(-50%); background: transparent; border: 0; cursor: pointer; color: var(--rw-ink-soft); padding: 6px; border-radius: 6px; transition: color 0.2s; }
.rw-toggle-pwd:hover { color: var(--rw-teal); }
.rw-toggle-pwd svg { width: 18px; height: 18px; display: block; }

/* Strength meter */
.rw-strength { display: flex; gap: 4px; margin-top: 8px; }
.rw-strength-bar { flex: 1; height: 4px; border-radius: 9999px; background: rgba(151,179,174,0.2); transition: background 0.4s; }
.rw-strength-bar.lit-1 { background: #f2c3b9; }
.rw-strength-bar.lit-2 { background: #e0a089; }
.rw-strength-bar.lit-3 { background: #97b3ae; }
.rw-strength-bar.lit-4 { background: #16a34a; }
.rw-strength-label { font-size: 11.5px; color: var(--rw-ink-soft); margin-top: 6px; letter-spacing: 0.02em; }

/* Row helpers */
.rw-row-between { display: flex; align-items: center; justify-content: space-between; margin: 4px 0 22px; }
.rw-check { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; font-size: 13px; color: var(--rw-ink-soft); }
.rw-check input { position: absolute; opacity: 0; pointer-events: none; }
.rw-check .box { width: 18px; height: 18px; border-radius: 5px; border: 1.5px solid rgba(151,179,174,0.4); background: #fff; display: inline-flex; align-items: center; justify-content: center; transition: all 0.2s; flex-shrink: 0; }
.rw-check input:checked ~ .box { background: var(--rw-teal); border-color: var(--rw-teal); }
.rw-check .box svg { width: 12px; height: 12px; color: #fff; opacity: 0; transform: scale(0.5); transition: all 0.2s cubic-bezier(0.34,1.56,0.64,1); }
.rw-check input:checked ~ .box svg { opacity: 1; transform: scale(1); }
.rw-link { color: var(--rw-teal); font-size: 13px; text-decoration: none; font-weight: 500; transition: color 0.2s; }
.rw-link:hover { color: #6f8d88; text-decoration: underline; }

/* Submit */
.rw-submit { position: relative; width: 100%; padding: 15px 24px; background: var(--rw-teal); color: #fff; border: 0; border-radius: 12px; font: 600 15px var(--rw-font-body); cursor: pointer; transition: all 0.25s; box-shadow: 0 8px 18px -4px rgba(151,179,174,0.45); overflow: hidden; }
.rw-submit:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 14px 28px -4px rgba(151,179,174,0.55); }
.rw-submit:active:not(:disabled) { transform: translateY(0) scale(0.99); }
.rw-submit::before { content: ''; position: absolute; inset: 0; background: linear-gradient(120deg, transparent 30%, rgba(255,255,255,0.35) 50%, transparent 70%); transform: translateX(-100%); transition: transform 0.6s; }
.rw-submit:hover::before { transform: translateX(100%); }
.rw-submit.is-loading { pointer-events: none; }
.rw-submit:disabled { opacity: 0.6; cursor: not-allowed; }
.rw-submit .label { display: inline-flex; align-items: center; gap: 10px; }
.rw-submit .arrow { transition: transform 0.3s; }
.rw-submit:hover .arrow { transform: translateX(4px); }
.rw-spinner { width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.4); border-top-color: #fff; border-radius: 9999px; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* Alerts */
.rw-alert { background: #fef2f2; border: 1px solid rgba(220,38,38,0.3); color: #b91c1c; border-radius: 10px; padding: 10px 12px; font-size: 13px; line-height: 1.4; margin: 4px 0 14px; }
.rw-alert .rw-link { color: #b91c1c; text-decoration: underline; font-weight: 600; margin-left: 6px; }

.rw-foot { text-align: center; font-size: 13px; color: var(--rw-ink-soft); margin: 24px 0 0; }
.rw-foot .rw-link { font-weight: 600; }

/* Confetti */
.rw-confetti { position: fixed; inset: 0; pointer-events: none; z-index: 100; }
.rw-confetti span { position: absolute; width: 10px; height: 14px; opacity: 0; animation: confetti 1.6s cubic-bezier(0.2,0.6,0.4,1) forwards; }
@keyframes confetti {
  0% { opacity: 0; transform: translate3d(0,0,0) rotate(0deg) scale(0.6); }
  10% { opacity: 1; }
  100% { opacity: 0; transform: var(--end) rotate(720deg) scale(1); }
}

/* Walking robot */
.rw-robot-track { position: relative; height: 70px; margin-top: 18px; pointer-events: none; }
.rw-robot { position: absolute; bottom: 0; left: 0; width: 56px; animation: robotWalk 12s linear infinite; }
.rw-robot-shadow { position: absolute; bottom: 4px; left: 14px; width: 30px; height: 6px; border-radius: 9999px; background: radial-gradient(ellipse at center, rgba(42,42,42,0.22), transparent 70%); animation: shadowPulse 0.5s ease-in-out infinite alternate; }
.rw-robot svg { width: 100%; height: auto; display: block; animation: robotBob 0.5s ease-in-out infinite alternate; }
@keyframes robotWalk {
  0%   { transform: translateX(-80px) scaleX(1); }
  45%  { transform: translateX(calc(100% + 20px)) scaleX(1); }
  50%  { transform: translateX(calc(100% + 20px)) scaleX(-1); }
  95%  { transform: translateX(-80px) scaleX(-1); }
  100% { transform: translateX(-80px) scaleX(1); }
}
@keyframes shadowPulse { from { transform: scale(1); opacity: 0.9; } to { transform: scale(0.85); opacity: 0.6; } }
@keyframes robotBob { from { transform: translateY(0); } to { transform: translateY(-3px); } }
.rw-robot-arm-l { transform-origin: 15px 52px; animation: armSwingL 0.5s ease-in-out infinite alternate; }
.rw-robot-arm-r { transform-origin: 65px 52px; animation: armSwingR 0.5s ease-in-out infinite alternate; }
@keyframes armSwingL { from { transform: rotate(-12deg); } to { transform: rotate(14deg); } }
@keyframes armSwingR { from { transform: rotate(14deg); } to { transform: rotate(-12deg); } }
.rw-robot-leg-l { transform-origin: 32px 74px; animation: legL 0.5s ease-in-out infinite alternate; }
.rw-robot-leg-r { transform-origin: 48px 74px; animation: legR 0.5s ease-in-out infinite alternate; }
@keyframes legL { from { transform: rotate(-10deg); } to { transform: rotate(12deg); } }
@keyframes legR { from { transform: rotate(12deg); } to { transform: rotate(-10deg); } }
.rw-robot-eyes { animation: blink 4.5s steps(1, end) infinite; transform-origin: 40px 30px; }
@keyframes blink { 0%, 92%, 100% { transform: scaleY(1); } 94%, 96% { transform: scaleY(0.1); } }
.rw-robot-bubble { position: absolute; left: 56px; bottom: 56px; background: #fff; border: 1px solid rgba(151,179,174,0.2); border-radius: 12px; padding: 5px 10px; font-size: 11px; font-weight: 600; color: var(--rw-ink); white-space: nowrap; box-shadow: 0 6px 14px rgba(0,0,0,0.08); opacity: 0; animation: robotSpeak 12s linear infinite; }
.rw-robot-bubble::after { content: ''; position: absolute; left: 10px; bottom: -5px; width: 8px; height: 8px; background: #fff; border-right: 1px solid rgba(151,179,174,0.2); border-bottom: 1px solid rgba(151,179,174,0.2); transform: rotate(45deg); }
@keyframes robotSpeak {
  0%, 18% { opacity: 0; transform: translateY(4px) scale(0.9); }
  22%, 38% { opacity: 1; transform: translateY(0) scale(1); }
  42%, 100% { opacity: 0; transform: translateY(4px) scale(0.9); }
}

/* Reduced motion — collapse decorative animations */
@media (prefers-reduced-motion: reduce) {
  .rw-auth *,
  .rw-auth *::before,
  .rw-auth *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
  }
  .rw-robot { animation: none !important; }
  .rw-blob { animation: none !important; }
  .rw-pcard { animation: none !important; }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/auth/auth-island/auth-island.css
git commit -m "feat(auth): add auth-island stylesheet"
```

---

## Task 11: `Icons.tsx` (inline SVG set)

**Files:**
- Create: `src/components/auth/auth-island/Icons.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/auth/auth-island/Icons.tsx
import type { SVGProps } from 'react';

const stroke = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function MailIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...stroke} {...p}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </svg>
  );
}
export function LockIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...stroke} {...p}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}
export function UserIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...stroke} {...p}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  );
}
export function PhoneIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...stroke} {...p}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.37 1.9.72 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.35 1.85.59 2.81.72a2 2 0 0 1 1.72 2.01z" />
    </svg>
  );
}
export function EyeIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...stroke} {...p}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
export function EyeOffIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...stroke} {...p}>
      <path d="M3 3l18 18" />
      <path d="M10.5 6.2A11 11 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 4M6.6 6.6C3.6 8.4 2 12 2 12s3.5 7 10 7c1.7 0 3.2-.4 4.5-1" />
      <path d="M14.1 14.1A3 3 0 0 1 9.9 9.9" />
    </svg>
  );
}
export function CheckIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...stroke} strokeWidth={3} {...p}>
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}
export function ArrowIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...stroke} {...p}>
      <path d="M5 12h14M13 5l7 7-7 7" />
    </svg>
  );
}
export function SparkleIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg {...stroke} {...p}>
      <path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7z" />
      <path d="M19 17l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </svg>
  );
}
export function GoogleIcon(p: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...p}>
      <path fill="#4285F4" d="M22.5 12.27c0-.79-.07-1.54-.2-2.27H12v4.3h5.92a5.07 5.07 0 0 1-2.2 3.32v2.77h3.56c2.08-1.92 3.22-4.74 3.22-8.12Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.77c-.99.66-2.25 1.06-3.72 1.06-2.86 0-5.28-1.93-6.15-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.85 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.35-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.94l3.67-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.07.56 4.21 1.65l3.16-3.16C17.45 2.1 14.97 1 12 1A11 11 0 0 0 2.18 7.06l3.67 2.84C6.72 7.31 9.14 5.38 12 5.38Z" />
    </svg>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm tsc --noEmit`

- [ ] **Step 3: Commit**

```bash
git add src/components/auth/auth-island/Icons.tsx
git commit -m "feat(auth): add inline SVG icon set for auth island"
```

---

## Task 12: `Robot.tsx` (mascot SVG)

**Files:**
- Create: `src/components/auth/auth-island/Robot.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/auth/auth-island/Robot.tsx
export function Robot() {
  return (
    <div className="rw-robot-track" aria-hidden="true">
      <div className="rw-robot">
        <div className="rw-robot-shadow" />
        <svg viewBox="0 0 80 90" xmlns="http://www.w3.org/2000/svg">
          <line x1="40" y1="6" x2="40" y2="14" stroke="#6a6a6a" strokeWidth="2" strokeLinecap="round" />
          <circle cx="40" cy="5" r="3" fill="#F2C3B9" />
          <rect x="18" y="14" width="44" height="34" rx="10" fill="#fff" stroke="#97B3AE" strokeWidth="2" />
          <rect x="24" y="20" width="32" height="20" rx="6" fill="#F0EEEA" />
          <g className="rw-robot-eyes">
            <circle cx="33" cy="30" r="2.6" fill="#2a2a2a" />
            <circle cx="47" cy="30" r="2.6" fill="#2a2a2a" />
          </g>
          <path d="M33 35 Q40 39 47 35" stroke="#97B3AE" strokeWidth="1.6" fill="none" strokeLinecap="round" />
          <rect x="22" y="48" width="36" height="26" rx="8" fill="#97B3AE" />
          <rect x="28" y="54" width="24" height="3" rx="1.5" fill="rgba(255,255,255,0.5)" />
          <circle cx="32" cy="64" r="2" fill="#F2C3B9" />
          <circle cx="40" cy="64" r="2" fill="#F0DDD6" />
          <circle cx="48" cy="64" r="2" fill="#fff" />
          <g className="rw-robot-arm-l"><rect x="12" y="50" width="6" height="16" rx="3" fill="#97B3AE" /></g>
          <g className="rw-robot-arm-r"><rect x="62" y="50" width="6" height="16" rx="3" fill="#97B3AE" /></g>
          <g className="rw-robot-leg-l"><rect x="28" y="74" width="8" height="10" rx="2" fill="#6a6a6a" /></g>
          <g className="rw-robot-leg-r"><rect x="44" y="74" width="8" height="10" rx="2" fill="#6a6a6a" /></g>
        </svg>
        <div className="rw-robot-bubble">★★★★★ replied!</div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/auth/auth-island/Robot.tsx
git commit -m "feat(auth): add walking robot mascot"
```

---

## Task 13: `ParallaxField.tsx`

**Files:**
- Create: `src/components/auth/auth-island/ParallaxField.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/auth/auth-island/ParallaxField.tsx
export function ParallaxField() {
  return (
    <div className="rw-field" aria-hidden="true">
      <div className="rw-field-wash" />
      <div className="rw-blob b1" />
      <div className="rw-blob b2" />
      <div className="rw-blob b3" />
      <div className="rw-blob b4" />

      <div className="rw-pcard p1">
        <div className="rw-pcard-stars">★★★★★</div>
        <div className="rw-pcard-bar" />
        <div className="rw-pcard-bar short" />
        <div className="rw-pcard-reply">
          <div className="rw-pcard-bar tealish" />
          <div className="rw-pcard-bar tealish short" />
        </div>
      </div>
      <div className="rw-pcard p2">
        <div className="rw-pcard-stars">★★★★☆</div>
        <div className="rw-pcard-bar" />
        <div className="rw-pcard-bar" />
        <div className="rw-pcard-bar short" />
      </div>
      <div className="rw-pcard p3">
        <div className="rw-pcard-stars">★★★★★</div>
        <div className="rw-pcard-bar" />
        <div className="rw-pcard-bar short" />
      </div>
      <div className="rw-pcard p4">
        <div className="rw-pcard-stars">★★★★★</div>
        <div className="rw-pcard-bar" />
        <div className="rw-pcard-bar short" />
        <div className="rw-pcard-reply">
          <div className="rw-pcard-bar tealish" />
        </div>
      </div>

      <div className="rw-chip c1"><span className="dot" /> New 5★ from Marisol B.</div>
      <div className="rw-chip c2"><span className="dot" /> Reply posted to Google</div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/auth/auth-island/ParallaxField.tsx
git commit -m "feat(auth): add ParallaxField decorative component"
```

---

## Task 14: `Showcase.tsx`

**Files:**
- Create: `src/components/auth/auth-island/Showcase.tsx`
- Test: `src/components/auth/auth-island/__tests__/Showcase.test.tsx`

The mode-aware copy is the key behavior to test.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/auth/auth-island/__tests__/Showcase.test.tsx
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Showcase } from '../Showcase';

describe('Showcase', () => {
  it('renders signup copy when mode is signup', () => {
    const html = renderToStaticMarkup(createElement(Showcase, { mode: 'signup' }));
    expect(html).toContain('Get started in 90 seconds');
    expect(html).toContain('reply it deserves');
  });
  it('renders login copy when mode is login', () => {
    const html = renderToStaticMarkup(createElement(Showcase, { mode: 'login' }));
    expect(html).toContain('Welcome home');
    expect(html).toContain('inbox is quiet');
  });
  it('renders the three stat tiles', () => {
    const html = renderToStaticMarkup(createElement(Showcase, { mode: 'signup' }));
    expect(html).toContain('15h');
    expect(html).toContain('96%');
    expect(html).toContain('60s');
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// src/components/auth/auth-island/Showcase.tsx
import type { AuthMode } from '@/components/auth/shared/pathForMode';
import { Robot } from './Robot';

export interface ShowcaseProps {
  mode: AuthMode;
}

export function Showcase({ mode }: ShowcaseProps) {
  const heading =
    mode === 'signup' ? (
      <>
        Every review gets the <em>reply it deserves</em>.
      </>
    ) : (
      <>
        Welcome back. Your <em>inbox is quiet</em>.
      </>
    );
  const lead =
    mode === 'signup'
      ? 'Join the local businesses saving 15 hours every week with personalised, on-brand replies.'
      : '127 reviews answered while you slept. Three are waiting for your one-tap approval.';
  const eyebrow = mode === 'signup' ? 'Get started in 90 seconds' : 'Welcome home';

  return (
    <div className="rw-showcase">
      <div className="rw-brand">
        {/* Wordmark only — keep markup self-contained; no asset dependency. */}
        <span className="rw-brand-word">RepWorth</span>
      </div>

      <div>
        <div className="rw-showcase-eyebrow">{eyebrow}</div>
        <h2 className="rw-showcase-h">{heading}</h2>
        <p className="rw-showcase-lead">{lead}</p>

        <div className="rw-preview">
          <div className="rw-review-card r1">
            <div className="rw-review-head">
              <div className="rw-avatar" />
              <div style={{ flex: 1 }}>
                <div className="rw-review-name">Marisol B.</div>
                <div className="rw-review-stars">★★★★★</div>
              </div>
            </div>
            <p className="rw-review-body">
              &ldquo;Best haircut I&apos;ve had in years. Sofia really listened.&rdquo;
            </p>
            <div className="rw-review-reply">
              <div className="badge">Drafted · 12s ago</div>
              Marisol — thank you so much! Sofia will be thrilled. We&apos;d love to see you again soon.
            </div>
          </div>
          <div className="rw-review-card r2">
            <div className="rw-review-head">
              <div className="rw-avatar t" />
              <div style={{ flex: 1 }}>
                <div className="rw-review-name">Daniel K.</div>
                <div className="rw-review-stars">★★★★☆</div>
              </div>
            </div>
            <p className="rw-review-body">
              &ldquo;Friendly staff, great vibe. Coffee a little slow today.&rdquo;
            </p>
          </div>
        </div>
      </div>

      <div className="rw-stats">
        <div className="rw-stat">
          <div className="rw-stat-val">15h</div>
          <div className="rw-stat-lbl">saved per week</div>
        </div>
        <div className="rw-stat">
          <div className="rw-stat-val">96%</div>
          <div className="rw-stat-lbl">response rate</div>
        </div>
        <div className="rw-stat">
          <div className="rw-stat-val">60s</div>
          <div className="rw-stat-lbl">poll cadence</div>
        </div>
      </div>

      <Robot />
    </div>
  );
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/components/auth/auth-island/Showcase.tsx src/components/auth/auth-island/__tests__/Showcase.test.tsx
git commit -m "feat(auth): add Showcase pane with mode-aware copy"
```

---

## Task 15: `Field.tsx`

**Files:**
- Create: `src/components/auth/auth-island/Field.tsx`
- Test: `src/components/auth/auth-island/__tests__/Field.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/auth/auth-island/__tests__/Field.test.tsx
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Field } from '../Field';
import { MailIcon, LockIcon } from '../Icons';

describe('Field', () => {
  it('renders a labelled input with leading icon', () => {
    const html = renderToStaticMarkup(
      createElement(Field, {
        label: 'Email',
        name: 'email',
        type: 'email',
        value: '',
        onChange: () => {},
        icon: createElement(MailIcon),
        autoComplete: 'email',
      }),
    );
    expect(html).toContain('Email');
    expect(html).toContain('id="email"');
    expect(html).toContain('autocomplete="email"');
    expect(html).toContain('class="rw-input-icon"');
  });
  it('renders a Show password toggle when type is password', () => {
    const html = renderToStaticMarkup(
      createElement(Field, {
        label: 'Password',
        name: 'password',
        type: 'password',
        value: '',
        onChange: () => {},
        icon: createElement(LockIcon),
        autoComplete: 'current-password',
      }),
    );
    expect(html).toContain('aria-label="Show password"');
    expect(html).toContain('class="rw-toggle-pwd"');
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// src/components/auth/auth-island/Field.tsx
'use client';

import { useId, useState, type ChangeEvent, type ReactNode } from 'react';
import { EyeIcon, EyeOffIcon } from './Icons';

export interface FieldProps {
  label: string;
  name: string;
  type?: string;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  icon: ReactNode;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  describedById?: string;
  invalid?: boolean;
}

export function Field({
  label,
  name,
  type = 'text',
  value,
  onChange,
  icon,
  placeholder,
  autoComplete,
  required,
  minLength,
  describedById,
  invalid,
}: FieldProps) {
  const [show, setShow] = useState(false);
  const isPwd = type === 'password';
  const realType = isPwd && show ? 'text' : type;
  const fallbackId = useId();
  const id = name || fallbackId;

  return (
    <div className="rw-field-row">
      <label className="rw-label" htmlFor={id}>
        {label}
      </label>
      <div className="rw-input-wrap">
        <input
          id={id}
          name={name}
          type={realType}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          autoComplete={autoComplete}
          required={required}
          minLength={minLength}
          aria-invalid={invalid || undefined}
          aria-describedby={describedById}
          className={`rw-input ${invalid ? 'has-error' : ''}`}
        />
        <span className="rw-input-icon">{icon}</span>
        {isPwd && (
          <button
            type="button"
            className="rw-toggle-pwd"
            onClick={() => setShow((s) => !s)}
            aria-label={show ? 'Hide password' : 'Show password'}
          >
            {show ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/components/auth/auth-island/Field.tsx src/components/auth/auth-island/__tests__/Field.test.tsx
git commit -m "feat(auth): add Field input component with show/hide password toggle"
```

---

## Task 16: `Tabs.tsx`

**Files:**
- Create: `src/components/auth/auth-island/Tabs.tsx`

- [ ] **Step 1: Implement**

```tsx
// src/components/auth/auth-island/Tabs.tsx
'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { pathForMode, type AuthMode } from '@/components/auth/shared/pathForMode';

export interface TabsProps {
  mode: AuthMode;
  onChange?: () => void;
}

export function Tabs({ mode, onChange }: TabsProps) {
  const router = useRouter();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pill, setPill] = useState({ left: 4, width: 0 });

  useLayoutEffect(() => {
    if (!wrapRef.current) return;
    const recompute = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const active = wrap.querySelector<HTMLElement>('.rw-tab.is-active');
      if (!active) return;
      const r = active.getBoundingClientRect();
      const w = wrap.getBoundingClientRect();
      setPill({ left: r.left - w.left, width: r.width });
    };
    recompute();
    const ro = new ResizeObserver(recompute);
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [mode]);

  function go(next: AuthMode) {
    if (next === mode) return;
    onChange?.();
    router.replace(pathForMode(next));
  }

  return (
    <div className="rw-tabs" ref={wrapRef} role="tablist" aria-label="Authentication mode">
      <div className="rw-tab-pill" style={{ left: pill.left, width: pill.width }} aria-hidden="true" />
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'login'}
        className={`rw-tab ${mode === 'login' ? 'is-active' : ''}`}
        onClick={() => go('login')}
      >
        Sign in
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={mode === 'signup'}
        className={`rw-tab ${mode === 'signup' ? 'is-active' : ''}`}
        onClick={() => go('signup')}
      >
        Create account
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

- [ ] **Step 3: Commit**

```bash
git add src/components/auth/auth-island/Tabs.tsx
git commit -m "feat(auth): add Tabs component with measured pill animation"
```

---

## Task 17: `fireConfetti.ts` with reduced-motion gate

**Files:**
- Create: `src/components/auth/auth-island/fireConfetti.ts`
- Test: `src/components/auth/auth-island/__tests__/fireConfetti.test.ts`

This helper must be a no-op when `prefers-reduced-motion: reduce` is set. The vitest env is `node`, so `window` is undefined unless we set up a minimal stub.

- [ ] **Step 1: Write the failing test**

```ts
// src/components/auth/auth-island/__tests__/fireConfetti.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('fireConfetti', () => {
  let appended: number;
  let removeCalled: boolean;

  beforeEach(() => {
    appended = 0;
    removeCalled = false;
    const stubLayer = {
      className: '',
      appendChild: () => {
        appended++;
      },
      remove: () => {
        removeCalled = true;
      },
    } as unknown as HTMLElement;
    const stubSpan = (() => {
      const el: Record<string, unknown> = {
        style: { setProperty: () => {} },
      };
      return el as unknown as HTMLElement;
    })();
    (globalThis as unknown as { document: Document }).document = {
      createElement: (tag: string) => (tag === 'div' ? stubLayer : stubSpan) as HTMLElement,
      body: { appendChild: () => {} } as unknown as HTMLElement,
    } as unknown as Document;
    (globalThis as unknown as { window: Window }).window = {
      matchMedia: () => ({ matches: false } as MediaQueryList),
    } as unknown as Window;
  });

  afterEach(() => {
    delete (globalThis as { document?: Document }).document;
    delete (globalThis as { window?: Window }).window;
    vi.useRealTimers();
  });

  it('appends 60 particles to a layer when reduced-motion is off', async () => {
    vi.useFakeTimers();
    const { fireConfetti } = await import('../fireConfetti');
    fireConfetti();
    expect(appended).toBe(60);
    vi.advanceTimersByTime(2300);
    expect(removeCalled).toBe(true);
  });

  it('is a no-op when prefers-reduced-motion is reduce', async () => {
    (globalThis as unknown as { window: Window }).window = {
      matchMedia: () => ({ matches: true } as MediaQueryList),
    } as unknown as Window;
    const { fireConfetti } = await import('../fireConfetti');
    fireConfetti();
    expect(appended).toBe(0);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement**

```ts
// src/components/auth/auth-island/fireConfetti.ts
const COLORS = ['#97B3AE', '#F2C3B9', '#F0DDD6', '#D6CBBF', '#EAB308'];

export function fireConfetti(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  const layer = document.createElement('div');
  layer.className = 'rw-confetti';
  document.body.appendChild(layer);

  for (let i = 0; i < 60; i++) {
    const s = document.createElement('span');
    const angle = (Math.random() - 0.5) * Math.PI;
    const dist = 220 + Math.random() * 220;
    const dx = Math.sin(angle) * dist + (Math.random() - 0.5) * 120;
    const dy = -Math.cos(angle) * dist - 80 + Math.random() * 80;
    s.style.setProperty('--end', `translate3d(${dx}px, ${dy}px, 0)`);
    s.style.left = `${50 + (Math.random() - 0.5) * 8}%`;
    s.style.top = '60%';
    s.style.background = COLORS[i % COLORS.length];
    s.style.borderRadius = i % 3 === 0 ? '9999px' : '2px';
    s.style.animationDelay = `${Math.random() * 0.15}s`;
    layer.appendChild(s);
  }
  setTimeout(() => layer.remove(), 2200);
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/components/auth/auth-island/fireConfetti.ts src/components/auth/auth-island/__tests__/fireConfetti.test.ts
git commit -m "feat(auth): add fireConfetti helper with reduced-motion gate"
```

---

## Task 18: `LoginForm.tsx` (visual)

**Files:**
- Create: `src/components/auth/auth-island/LoginForm.tsx`
- Test: `src/components/auth/auth-island/__tests__/LoginForm.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/auth/auth-island/__tests__/LoginForm.test.tsx
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LoginForm } from '../LoginForm';

describe('LoginForm', () => {
  it('renders email + password fields and Continue with Google', () => {
    const html = renderToStaticMarkup(
      createElement(LoginForm, { initialEmail: '' }),
    );
    expect(html).toContain('autocomplete="email"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('Continue with Google');
    expect(html).toContain('Forgot password?');
    expect(html).toContain('Keep me signed in');
  });
  it('pre-fills the email input from initialEmail', () => {
    const html = renderToStaticMarkup(
      createElement(LoginForm, { initialEmail: 'a@b.co' }),
    );
    expect(html).toContain('value="a@b.co"');
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// src/components/auth/auth-island/LoginForm.tsx
'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLoginSubmit } from '@/components/auth/hooks/useLoginSubmit';
import { useGoogleOAuth } from '@/components/auth/hooks/useGoogleOAuth';
import { mapInitialQueryError } from '@/components/auth/shared/mapLoginError';
import { Field } from './Field';
import { ArrowIcon, CheckIcon, GoogleIcon, LockIcon, MailIcon } from './Icons';

export interface LoginFormProps {
  initialEmail: string;
}

export function LoginForm({ initialEmail }: LoginFormProps) {
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const searchParams = useSearchParams();

  useEffect(() => {
    if (initialEmail) setEmail(initialEmail);
  }, [initialEmail]);

  const { submit, loading, error, setError } = useLoginSubmit({
    portal: 'owner',
    allowedRoles: ['owner'],
    defaultRoute: '/dashboard',
  });
  const oauth = useGoogleOAuth({ flow: 'owner', next: '/dashboard' });

  const initialQueryError = mapInitialQueryError(searchParams.get('error'));
  const displayError = error || oauth.error || initialQueryError;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    await submit(email, password);
  }

  return (
    <form onSubmit={handleSubmit} className="rw-stagger" autoComplete="on">
      <button
        type="button"
        className="rw-google-btn"
        onClick={() => void oauth.start()}
        disabled={oauth.loading || loading}
      >
        <GoogleIcon /> {oauth.loading ? 'Redirecting to Google…' : 'Continue with Google'}
      </button>
      <div className="rw-divider">or with email</div>

      <Field
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@yourshop.com"
        icon={<MailIcon />}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="current-password"
        placeholder="••••••••"
        icon={<LockIcon />}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />

      {displayError && (
        <p className="rw-alert" role="alert">
          {displayError}
        </p>
      )}

      <div className="rw-row-between">
        <label className="rw-check">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span className="box">
            <CheckIcon />
          </span>
          Keep me signed in
        </label>
        <a className="rw-link" href="/forgot-password">
          Forgot password?
        </a>
      </div>

      <button
        type="submit"
        className={`rw-submit ${loading ? 'is-loading' : ''}`}
        disabled={loading}
      >
        <span className="label">
          {loading ? (
            <>
              <span className="rw-spinner" /> Signing in…
            </>
          ) : (
            <>
              Sign in{' '}
              <span className="arrow">
                <ArrowIcon />
              </span>
            </>
          )}
        </span>
      </button>
    </form>
  );
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/components/auth/auth-island/LoginForm.tsx src/components/auth/auth-island/__tests__/LoginForm.test.tsx
git commit -m "feat(auth): add LoginForm visual for auth island"
```

---

## Task 19: `SignupForm.tsx` (visual + strength meter + Terms checkbox)

**Files:**
- Create: `src/components/auth/auth-island/SignupForm.tsx`
- Test: `src/components/auth/auth-island/__tests__/SignupForm.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/auth/auth-island/__tests__/SignupForm.test.tsx
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SignupForm } from '../SignupForm';

describe('SignupForm', () => {
  it('renders the four required fields and Terms link', () => {
    const html = renderToStaticMarkup(
      createElement(SignupForm, { onAccountExists: () => {} }),
    );
    expect(html).toContain('Your name');
    expect(html).toContain('Phone (optional)');
    expect(html).toContain('Work email');
    expect(html).toContain('Create a password');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('Sign up with Google');
  });
  it('disables the submit CTA on first render (Terms unchecked)', () => {
    const html = renderToStaticMarkup(
      createElement(SignupForm, { onAccountExists: () => {} }),
    );
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });
  it('renders the four strength bars', () => {
    const html = renderToStaticMarkup(
      createElement(SignupForm, { onAccountExists: () => {} }),
    );
    const matches = html.match(/rw-strength-bar/g) ?? [];
    expect(matches).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// src/components/auth/auth-island/SignupForm.tsx
'use client';

import { useMemo, useState } from 'react';
import { useSignupSubmit } from '@/components/auth/hooks/useSignupSubmit';
import { useGoogleOAuth } from '@/components/auth/hooks/useGoogleOAuth';
import { strengthOf, STRENGTH_LABELS } from '@/components/auth/shared/strength';
import { fireConfetti } from './fireConfetti';
import { Field } from './Field';
import { ArrowIcon, CheckIcon, GoogleIcon, LockIcon, MailIcon, PhoneIcon, SparkleIcon, UserIcon } from './Icons';

export interface SignupFormProps {
  onAccountExists: (email: string) => void;
}

export function SignupForm({ onAccountExists }: SignupFormProps) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [pwd, setPwd] = useState('');
  const [agree, setAgree] = useState(false);

  const { submit, loading, error, errorKind } = useSignupSubmit();
  const oauth = useGoogleOAuth({ flow: 'owner', next: '/signup/finish' });

  const strength = useMemo(() => strengthOf(pwd), [pwd]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!agree || loading) return;
    await submit({ ownerEmail: email, ownerName: name, ownerPhone: phone, password: pwd });
    if (errorKind == null) {
      // The submit either redirected (success) or set an error. If it redirected
      // we've already navigated. If it errored, no confetti.
      // Confetti is fired only on the rare client-side success that does not
      // navigate (e.g., MOCK_EXTERNAL_APIS); fire defensively.
      fireConfetti();
    }
  }

  const showAccountExists = errorKind === 'account_exists';

  return (
    <form onSubmit={handleSubmit} className="rw-stagger" autoComplete="on">
      <button
        type="button"
        className="rw-google-btn"
        onClick={() => void oauth.start()}
        disabled={oauth.loading || loading}
      >
        <GoogleIcon /> {oauth.loading ? 'Redirecting to Google…' : 'Sign up with Google'}
      </button>
      <div className="rw-divider">or with email</div>

      <div className="rw-field-row">
        <div className="row">
          <Field
            label="Your name"
            name="name"
            type="text"
            autoComplete="name"
            placeholder="Sofia Reyes"
            icon={<UserIcon />}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <Field
            label="Phone (optional)"
            name="phone"
            type="tel"
            autoComplete="tel"
            placeholder="+1 555 0136"
            icon={<PhoneIcon />}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
      </div>

      <Field
        label="Work email"
        name="email"
        type="email"
        autoComplete="email"
        placeholder="you@yourshop.com"
        icon={<MailIcon />}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />

      <Field
        label="Create a password"
        name="password"
        type="password"
        autoComplete="new-password"
        placeholder="At least 8 characters"
        icon={<LockIcon />}
        value={pwd}
        onChange={(e) => setPwd(e.target.value)}
        required
        minLength={8}
      />

      <div className="rw-strength" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className={`rw-strength-bar ${strength >= i ? `lit-${Math.min(strength, 4)}` : ''}`}
          />
        ))}
      </div>
      <div className="rw-strength-label" aria-live="polite">
        {pwd ? STRENGTH_LABELS[Math.min(strength, 4)] : 'Pick something memorable but tough.'}
      </div>

      {error && (
        <p className="rw-alert" role="alert">
          {error}
          {showAccountExists && (
            <>
              {' '}
              <a
                className="rw-link"
                href="/login"
                onClick={(e) => {
                  e.preventDefault();
                  onAccountExists(email.trim().toLowerCase());
                }}
              >
                Sign in
              </a>
            </>
          )}
        </p>
      )}

      <div className="rw-row-between" style={{ marginTop: 18, marginBottom: 18 }}>
        <label className="rw-check">
          <input
            type="checkbox"
            checked={agree}
            onChange={(e) => setAgree(e.target.checked)}
          />
          <span className="box">
            <CheckIcon />
          </span>
          I agree to the{' '}
          <a className="rw-link" style={{ marginLeft: 4 }} href="/terms">
            Terms
          </a>
          &nbsp;&amp;&nbsp;
          <a className="rw-link" href="/privacy">
            Privacy
          </a>
        </label>
      </div>

      <button
        type="submit"
        className={`rw-submit ${loading ? 'is-loading' : ''}`}
        disabled={loading || !agree}
      >
        <span className="label">
          {loading ? (
            <>
              <span className="rw-spinner" /> Creating your account…
            </>
          ) : (
            <>
              <SparkleIcon width={18} height={18} /> Start saving 15 hours{' '}
              <span className="arrow">
                <ArrowIcon />
              </span>
            </>
          )}
        </span>
      </button>
    </form>
  );
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/components/auth/auth-island/SignupForm.tsx src/components/auth/auth-island/__tests__/SignupForm.test.tsx
git commit -m "feat(auth): add SignupForm visual with strength meter + Terms gate"
```

---

## Task 20: `AuthIslandClient.tsx` (orchestrator)

**Files:**
- Create: `src/components/auth/auth-island/AuthIslandClient.tsx`
- Test: `src/components/auth/__tests__/AuthIslandClient.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/auth/__tests__/AuthIslandClient.test.tsx
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AuthIslandClient } from '../auth-island/AuthIslandClient';

describe('AuthIslandClient', () => {
  it('renders Sign in heading when initialMode is login', () => {
    const html = renderToStaticMarkup(
      createElement(AuthIslandClient, { initialMode: 'login' }),
    );
    expect(html).toContain('Sign in to RepWorth');
    expect(html).toContain('Pick up where you left off.');
  });
  it('renders Create account heading when initialMode is signup', () => {
    const html = renderToStaticMarkup(
      createElement(AuthIslandClient, { initialMode: 'signup' }),
    );
    expect(html).toContain('Create your account');
    expect(html).toContain('Free for 14 days. No credit card required.');
  });
});
```

- [ ] **Step 2: Run test, verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// src/components/auth/auth-island/AuthIslandClient.tsx
'use client';

import { Suspense, useState } from 'react';
import type { AuthMode } from '@/components/auth/shared/pathForMode';
import './auth-island.css';
import { ParallaxField } from './ParallaxField';
import { Showcase } from './Showcase';
import { Tabs } from './Tabs';
import { LoginForm } from './LoginForm';
import { SignupForm } from './SignupForm';

export interface AuthIslandClientProps {
  initialMode: AuthMode;
}

export function AuthIslandClient(props: AuthIslandClientProps) {
  return (
    <Suspense fallback={<div className="rw-auth" aria-hidden="true" />}>
      <AuthIslandInner {...props} />
    </Suspense>
  );
}

function AuthIslandInner({ initialMode }: AuthIslandClientProps) {
  const [prefilledEmail, setPrefilledEmail] = useState('');

  return (
    <div className="rw-auth">
      <ParallaxField />
      <div className="rw-page">
        <div className="rw-island">
          <Showcase mode={initialMode} />
          <div className="rw-form-pane">
            <Tabs mode={initialMode} onChange={() => setPrefilledEmail('')} />
            {initialMode === 'signup' ? (
              <>
                <h1 className="rw-form-h">Create your account</h1>
                <p className="rw-form-sub">Free for 14 days. No credit card required.</p>
                <SignupForm onAccountExists={(email) => setPrefilledEmail(email)} />
                <p className="rw-foot">
                  Already have an account?{' '}
                  <a className="rw-link" href="/login">
                    Sign in
                  </a>
                </p>
              </>
            ) : (
              <>
                <h1 className="rw-form-h">Sign in to RepWorth</h1>
                <p className="rw-form-sub">Pick up where you left off.</p>
                <LoginForm initialEmail={prefilledEmail} />
                <p className="rw-foot">
                  New to RepWorth?{' '}
                  <a className="rw-link" href="/signup">
                    Create an account
                  </a>
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test, verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/components/auth/auth-island/AuthIslandClient.tsx src/components/auth/__tests__/AuthIslandClient.test.tsx
git commit -m "feat(auth): add AuthIslandClient orchestrator"
```

---

## Task 21: Wire `/login` and `/signup` pages, delete `SignupFormClient`

**Files:**
- Modify: `src/app/(public)/login/page.tsx`
- Modify: `src/app/(public)/signup/page.tsx`
- Delete: `src/components/auth/SignupFormClient.tsx`

- [ ] **Step 1: Update `/login` page**

```tsx
// src/app/(public)/login/page.tsx
import { notFound } from 'next/navigation';
import { AuthIslandClient } from '@/components/auth/auth-island/AuthIslandClient';

export default function OwnerLoginPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();
  return <AuthIslandClient initialMode="login" />;
}
```

- [ ] **Step 2: Update `/signup` page**

```tsx
// src/app/(public)/signup/page.tsx
import { notFound } from 'next/navigation';
import { AuthIslandClient } from '@/components/auth/auth-island/AuthIslandClient';

export default function SignupPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();
  return <AuthIslandClient initialMode="signup" />;
}
```

- [ ] **Step 3: Delete `SignupFormClient.tsx`**

```bash
git rm src/components/auth/SignupFormClient.tsx
```

- [ ] **Step 4: Verify nothing else imported it**

Run: `grep -r "SignupFormClient" src/ --include="*.ts" --include="*.tsx"` (use Grep tool)
Expected: only doc comments remain in `src/app/api/auth/signup/route.ts` and `src/app/api/auth/__tests__/signup.test.ts`. No imports.

- [ ] **Step 5: Run the full test suite**

Run: `pnpm test`
Expected: green (no test imported SignupFormClient).

- [ ] **Step 6: Commit**

```bash
git add src/app/(public)/login/page.tsx src/app/(public)/signup/page.tsx
git commit -m "feat(auth): wire /login and /signup to AuthIslandClient and remove old SignupFormClient"
```

---

## Task 22: Re-skin `error.tsx` boundaries

**Files:**
- Modify: `src/app/(public)/login/error.tsx`
- Modify: `src/app/(public)/signup/error.tsx`

Same retry + support-email behavior, sage-island palette.

- [ ] **Step 1: Update `/login/error.tsx`**

```tsx
// src/app/(public)/login/error.tsx
'use client';

export default function LoginError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="min-h-screen bg-[#D2E0D3] flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-3xl shadow-2xl border border-[#97B3AE]/15 p-8 text-center">
        <h1 className="text-xl font-bold mb-4 text-[#2a2a2a]">Something went wrong</h1>
        <p className="text-[#6a6a6a] mb-6">
          We couldn&apos;t load the sign-in page. Please try again.
        </p>
        <button
          onClick={reset}
          className="bg-[#97B3AE] text-white px-6 py-2 rounded-full hover:bg-[#7ea098] transition-colors"
        >
          Retry
        </button>
        <p className="text-sm text-[#6a6a6a] mt-4">
          Still having trouble?{' '}
          <a href="mailto:support@repworth.com" className="text-[#97B3AE] underline">
            Contact support
          </a>
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Update `/signup/error.tsx`**

```tsx
// src/app/(public)/signup/error.tsx
'use client';

export default function SignupError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="min-h-screen bg-[#D2E0D3] flex items-center justify-center px-4">
      <div className="max-w-md w-full bg-white rounded-3xl shadow-2xl border border-[#97B3AE]/15 p-8 text-center">
        <h1 className="text-xl font-bold mb-4 text-[#2a2a2a]">Something went wrong</h1>
        <p className="text-[#6a6a6a] mb-6">
          We couldn&apos;t load the signup page. Please try again.
        </p>
        <button
          onClick={reset}
          className="bg-[#97B3AE] text-white px-6 py-2 rounded-full hover:bg-[#7ea098] transition-colors"
        >
          Retry
        </button>
        <p className="text-sm text-[#6a6a6a] mt-4">
          Still having trouble?{' '}
          <a href="mailto:support@repworth.com" className="text-[#97B3AE] underline">
            Contact support
          </a>
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/(public)/login/error.tsx src/app/(public)/signup/error.tsx
git commit -m "feat(auth): re-skin login/signup error boundaries to island palette"
```

---

## Task 23: Verification — lint, test, manual smoke

- [ ] **Step 1: Lint**

Run: `pnpm lint`
Expected: clean. If new files trigger rules (e.g., react/no-unescaped-entities), fix inline.

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: green. New tests added in this plan: 7 (strength) + 5 (mapSignupError) + 7 (mapLoginError) + 13 (loginDestination) + 5 (pathForMode) + 2 (LoginFormClient regression) + 3 (Showcase) + 2 (Field) + 2 (fireConfetti) + 2 (LoginForm) + 3 (SignupForm) + 2 (AuthIslandClient) = **53 new tests**.

- [ ] **Step 4: Manual dev smoke (`pnpm dev`)**

Set `SELF_SERVE_SIGNUP_ENABLED=true` and `MOCK_EXTERNAL_APIS=true` in `.env.local` if not already. Then verify:

- `http://localhost:3000/login` — Sign in tab active, island renders, parallax animates, robot walks, brand fonts loaded.
- `http://localhost:3000/signup` — Create account tab active, strength meter responds to typing.
- Click the opposite tab — URL changes between `/login` and `/signup` without a full page reload.
- `http://localhost:3000/login?error=auth_callback_failed` — red alert renders.
- `http://localhost:3000/login?from=/dashboard/x` — submit a valid login → lands on `/dashboard/x`.
- `http://localhost:3000/login?from=//evil.com` — submit a valid login → lands on `/dashboard` (sanitized).
- `http://localhost:3000/admin/login` — unchanged gray utility form, no Google button.
- DevTools mobile emulation at 375px — showcase pane hidden, form usable.
- DevTools `prefers-reduced-motion: reduce` — no confetti, no robot walk, blobs static.
- Submit signup with an existing email → red alert with inline "Sign in" link → click it → tab switches, email pre-filled.

- [ ] **Step 5: Final commit + PR**

If any fix-ups were needed during verification, commit them. Then push:

```bash
git push -u origin auth-island-redesign
```

Open a PR titled "Auth island redesign — /login & /signup" with body summarizing the new combined surface, the preserved `/admin/login`, and the unchanged API contract. Link the spec at `docs/superpowers/specs/2026-05-06-auth-island-redesign.md`.

---

## Self-review

**Spec coverage:**
- §3.1 Routing → Tasks 5, 21
- §3.2 Sign-in form → Tasks 7, 9, 18
- §3.3 Create-account form → Tasks 8, 19
- §3.4 Tab toggle + prefilledEmail → Tasks 16, 19, 20
- §3.5 Decorative animations → Tasks 10, 12, 13, 17
- §3.6 Responsive → Task 10 (CSS media queries)
- §3.7 A11y (role=tab, aria-label show/hide, aria-live, role=alert, aria-hidden decoratives) → Tasks 13, 15, 16, 18, 19
- §4.1 New files → Tasks 1–20 (all listed)
- §4.2 Modified files → Tasks 9, 21, 22
- §4.3 Untouched files → never opened by any task
- §5 Failure-mode mapping → Tasks 2, 3, 7, 8, 18, 19 (alert slot)
- §6.1 Component tests → Tasks 14, 15, 18, 19, 20
- §6.2 Admin regression → Task 9
- §6.3 Manual smoke → Task 23
- §6.4 Lint + typecheck → Task 23

**Placeholder scan:** None found.

**Type consistency check:**
- `AuthMode` from `pathForMode.ts` — used by Tasks 14, 16, 20 ✓
- `MappedSignupError.kind` — used by Task 8 (`useSignupSubmit`) and Task 19 (`SignupForm`) ✓
- `SignupStatusPayload` — exported from `loginDestination.ts` (Task 4), used by Task 7 ✓
- `UseLoginSubmitInput` / `UseLoginSubmitReturn` — defined in Task 7, consumed by Tasks 9 and 18 ✓
- `UseGoogleOAuthInput` / `UseGoogleOAuthReturn` — defined in Task 6, consumed by Tasks 9, 18, 19 ✓
- `FieldProps.icon` is `ReactNode` — passed via `<MailIcon />` JSX in Tasks 18, 19 ✓
- All hooks return `error: string` (not `string | null`) — consistent across Tasks 6, 7, 8 ✓

No drift detected.
