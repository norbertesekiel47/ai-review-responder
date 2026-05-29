# MFA Page Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `src/app/mfa/challenge/page.tsx` in the RepWorth island brand, fix the iOS input-zoom (≥16px) and missing `pattern="[0-9]*"` defects, and finish the touched area (branded Suspense fallback, `aria-live`, support recovery link) — without changing any auth logic or shared CSS.

**Architecture:** Self-contained Tailwind + `motion/react` island built directly in `page.tsx` (the `repworth-brand-design` idiom). Reuses the same `#D2E0D3`/`#97B3AE` tokens and font stack as `/login` so the two pages read as one family, but does NOT reuse the two-pane `AuthIslandClient`. All existing logic (`normalizeFactor(s)`, `safeNext`, `ensureChallenge`, `verify`, state, Supabase/fetch flow) is preserved verbatim; only markup/classes change. The inner form is exported as `MfaChallengeForm` so it can be unit-tested directly (mirroring `LoginFormInner`).

**Tech Stack:** Next.js 16 App Router, React 19, `motion` (import from `motion/react`), Tailwind, Vitest + jsdom + `@testing-library/react`, Supabase auth (browser client).

**Spec:** `docs/superpowers/specs/2026-05-28-mfa-page-branding-design.md`

---

## File Structure

- **Modify:** `src/app/mfa/challenge/page.tsx` — full presentation rebuild. Adds `export` to the inner form (`MfaChallengeForm`), a `MfaShell` brand wrapper, a `BrandBackground` atmosphere component, and a `MfaFallback`. Logic functions copied unchanged.
- **Create:** `src/app/mfa/challenge/__tests__/page.test.tsx` — jsdom component test guarding the behavioral regressions (numeric+pattern+16px input, dual recovery links, alert region).

No other files change. `auth-island.css`, `/login`, `/signup`, the MFA API route, and `src/lib/auth/mfa.ts` are untouched.

---

## Task 1: Failing component test (RED)

**Files:**
- Create: `src/app/mfa/challenge/__tests__/page.test.tsx`

This test imports `{ MfaChallengeForm }` from `../page`, which is not exported yet, and asserts behaviors the current page lacks (`pattern="[0-9]*"`, 16px input, a contact-support link, an alert region). It must fail before Task 2.

- [ ] **Step 1: Write the failing test**

Create `src/app/mfa/challenge/__tests__/page.test.tsx`:

```tsx
// @vitest-environment jsdom
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { mockListFactors, routerPush } = vi.hoisted(() => ({
  mockListFactors: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: routerPush,
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: () => {},
  }),
}));

vi.mock('@/lib/db/browser', () => ({
  createBrowserSupabaseClient: () => ({
    auth: { mfa: { listFactors: mockListFactors } },
  }),
}));

// Imported after vi.mock so the mocks are in place when the module loads.
const { MfaChallengeForm } = await import('../page');

describe('MfaChallengeForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // motion/react's useReducedMotion reads window.matchMedia, which jsdom
    // does not implement. Stub it so the brand shell renders deterministically.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
  });

  it('renders a numeric, [0-9]*-patterned, 16px code input for a verified factor', async () => {
    mockListFactors.mockResolvedValue({
      data: {
        totp: [{ id: 'f1', status: 'verified', friendly_name: 'Authy' }],
        all: [],
      },
      error: null,
    });

    render(createElement(MfaChallengeForm));

    const input = await screen.findByLabelText('Authenticator code');
    expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(input).toHaveAttribute('pattern', '[0-9]*');
    // text-base == 16px in Tailwind; below 16px iOS auto-zooms on focus.
    expect(input.className).toContain('text-base');
  });

  it('offers return-to-login AND contact-support recovery when no factor exists', async () => {
    mockListFactors.mockResolvedValue({ data: { totp: [], all: [] }, error: null });

    render(createElement(MfaChallengeForm));

    const loginLink = await screen.findByRole('link', { name: /return to login/i });
    expect(loginLink).toHaveAttribute('href', '/login');

    const supportLink = screen.getByRole('link', { name: /contact support/i });
    expect(supportLink).toHaveAttribute('href', 'mailto:support@repworth.com');
  });

  it('announces a factor-load failure through an alert region', async () => {
    mockListFactors.mockResolvedValue({ data: null, error: { message: 'boom' } });

    render(createElement(MfaChallengeForm));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /tmp/repworth-mfa-brand && pnpm test -- src/app/mfa/challenge/__tests__/page.test.tsx`

Expected: FAIL. `MfaChallengeForm` is `undefined` (not yet exported), so `createElement(undefined)` throws "Element type is invalid" on the first test, and the others fail on the missing `pattern`/support-link/alert behaviors.

---

## Task 2: Rebuild the page in the island brand (GREEN)

**Files:**
- Modify: `src/app/mfa/challenge/page.tsx`

Replace the entire file. The logic block (`ChallengeFactor`, `normalizeFactor`, `normalizeFactors`, `safeNext`, and the body of `MfaChallengeForm` from `useRouter` through `verify`) is unchanged from the original — only the JSX it returns, the new brand sub-components, the `export` keyword on `MfaChallengeForm`, and the branded Suspense fallback are new.

- [ ] **Step 1: Write the implementation**

Replace the full contents of `src/app/mfa/challenge/page.tsx` with:

```tsx
'use client';

import {
  Suspense,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { motion, useReducedMotion } from 'motion/react';
import { createBrowserSupabaseClient } from '@/lib/db/browser';

const SUPPORT_EMAIL = 'support@repworth.com';

interface ChallengeFactor {
  id: string;
  label: string;
}

function normalizeFactor(raw: unknown): ChallengeFactor | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string') return null;
  if (record.status !== 'verified') return null;
  const label =
    typeof record.friendly_name === 'string'
      ? record.friendly_name
      : typeof record.friendlyName === 'string'
        ? record.friendlyName
        : 'Authenticator app';
  return { id: record.id, label };
}

function normalizeFactors(data: unknown): ChallengeFactor[] {
  if (!data || typeof data !== 'object') return [];
  const record = data as Record<string, unknown>;
  const candidates = [
    ...(Array.isArray(record.totp) ? record.totp : []),
    ...(Array.isArray(record.all) ? record.all : []),
  ];
  const unique = new Map<string, ChallengeFactor>();
  for (const candidate of candidates) {
    const factor = normalizeFactor(candidate);
    if (factor) unique.set(factor.id, factor);
  }
  return [...unique.values()];
}

function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return '/dashboard';
  if (
    raw === '/login' ||
    raw === '/admin/login' ||
    raw.startsWith('/forgot-password') ||
    raw.startsWith('/admin/forgot-password')
  ) {
    return '/dashboard';
  }
  return raw;
}

// Muted glassmorphism atmosphere — brand only, non-informational, desktop-only.
function BrandBackground() {
  return (
    <div
      className="fixed inset-0 pointer-events-none hidden lg:block"
      aria-hidden="true"
    >
      <div className="absolute top-24 left-12 w-56 h-64 bg-white/40 backdrop-blur-md rounded-3xl shadow-xl border border-white/60 p-6">
        <div className="flex gap-1 mb-3">
          {Array.from({ length: 4 }).map((_, j) => (
            <div key={j} className="w-3.5 h-3.5 bg-[#F2C3B9]/60 rounded-full" />
          ))}
        </div>
        <div className="space-y-2">
          <div className="h-3 bg-[#2a2a2a]/15 rounded w-full" />
          <div className="h-3 bg-[#2a2a2a]/15 rounded w-5/6" />
          <div className="h-3 bg-[#2a2a2a]/15 rounded w-4/6" />
        </div>
      </div>
      <div className="absolute bottom-24 right-16 w-60 h-56 bg-white/40 backdrop-blur-md rounded-3xl shadow-xl border border-white/60 p-6">
        <div className="flex gap-1 mb-3">
          {Array.from({ length: 5 }).map((_, j) => (
            <div key={j} className="w-3.5 h-3.5 bg-[#97B3AE]/50 rounded-full" />
          ))}
        </div>
        <div className="space-y-2">
          <div className="h-3 bg-[#2a2a2a]/15 rounded w-full" />
          <div className="h-3 bg-[#2a2a2a]/15 rounded w-3/4" />
        </div>
      </div>
    </div>
  );
}

// Sage page + centered white island card. No overflow-hidden (iOS Safari rule).
function MfaShell({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <main className="min-h-screen bg-[#D2E0D3] relative flex items-center justify-center px-4 py-16">
      <BrandBackground />
      <motion.div
        className="relative z-10 w-full max-w-md bg-white rounded-[3rem] shadow-2xl p-8 sm:p-10"
        initial={reduce ? false : { opacity: 0, y: 24, scale: 0.97 }}
        animate={reduce ? undefined : { opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
      >
        <div className="flex items-center gap-2 mb-8">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80" />
          <span className="text-sm tracking-wider uppercase text-[#97B3AE]">
            RepWorth
          </span>
        </div>
        {children}
      </motion.div>
    </main>
  );
}

export function MfaChallengeForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get('next'));
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const reduce = useReducedMotion();
  const [factors, setFactors] = useState<ChallengeFactor[]>([]);
  const [selectedFactorId, setSelectedFactorId] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadFactors() {
      setLoading(true);
      setError(null);
      const { data, error: listError } = await supabase.auth.mfa.listFactors();
      if (cancelled) return;
      if (listError) {
        setError('Could not load MFA factors.');
        setLoading(false);
        return;
      }
      const nextFactors = normalizeFactors(data);
      setFactors(nextFactors);
      setSelectedFactorId(nextFactors[0]?.id ?? '');
      setLoading(false);
    }
    void loadFactors();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  async function ensureChallenge(factorId: string): Promise<string | null> {
    if (challengeId) return challengeId;
    const res = await fetch('/api/auth/mfa/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'challenge', factorId }),
    });
    if (res.status === 429) {
      setError('Too many MFA attempts. Try again in a few minutes.');
      return null;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || typeof data.challengeId !== 'string') {
      setError('Could not start MFA challenge.');
      return null;
    }
    setChallengeId(data.challengeId);
    return data.challengeId;
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFactorId) return;
    setBusy(true);
    setError(null);
    try {
      const nextChallengeId = await ensureChallenge(selectedFactorId);
      if (!nextChallengeId) return;
      const res = await fetch('/api/auth/mfa/challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'verify',
          factorId: selectedFactorId,
          challengeId: nextChallengeId,
          code,
        }),
      });
      if (res.status === 429) {
        setError('Too many MFA attempts. Try again in a few minutes.');
        setChallengeId(null);
        return;
      }
      if (!res.ok) {
        setError('The verification code was not accepted.');
        setChallengeId(null);
        return;
      }
      router.push(next);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <MfaShell>
      <h1 className="text-2xl sm:text-3xl font-medium text-[#2a2a2a] mb-2">
        Verify it&apos;s you
      </h1>
      <p className="text-[#6a6a6a] mb-6 leading-relaxed">
        Enter the 6-digit code from your authenticator app to finish signing in.
      </p>

      {error ? (
        <p
          role="alert"
          aria-live="assertive"
          className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {error}
        </p>
      ) : null}

      {loading ? (
        <p aria-live="polite" className="text-[#6a6a6a]">
          Loading your security options…
        </p>
      ) : factors.length === 0 ? (
        <div className="space-y-4">
          <p className="text-[#6a6a6a] leading-relaxed">
            No verified authenticator is available for this account.
          </p>
          <div className="flex flex-col gap-2 text-sm">
            <Link
              className="text-[#97B3AE] font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE] rounded"
              href="/login"
            >
              Return to login
            </Link>
            <a
              className="text-[#97B3AE] font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE] rounded"
              href={`mailto:${SUPPORT_EMAIL}`}
            >
              Trouble signing in? Contact support
            </a>
          </div>
        </div>
      ) : (
        <form className="space-y-5" onSubmit={(event) => void verify(event)}>
          {busy ? (
            <span role="status" className="sr-only">
              Verifying your code…
            </span>
          ) : null}
          {factors.length > 1 ? (
            <div>
              <label
                className="block text-sm font-medium text-[#2a2a2a] mb-1.5"
                htmlFor="mfa-factor"
              >
                Authenticator
              </label>
              <select
                id="mfa-factor"
                className="w-full rounded-xl border border-[#97B3AE]/30 bg-white px-4 py-3 text-base text-[#2a2a2a] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE]"
                value={selectedFactorId}
                onChange={(event) => {
                  setSelectedFactorId(event.target.value);
                  setChallengeId(null);
                }}
              >
                {factors.map((factor) => (
                  <option key={factor.id} value={factor.id}>
                    {factor.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div>
            <label
              className="block text-sm font-medium text-[#2a2a2a] mb-1.5"
              htmlFor="mfa-code"
            >
              Authenticator code
            </label>
            <input
              id="mfa-code"
              className="w-full rounded-xl border border-[#97B3AE]/30 bg-white px-4 py-3 text-base text-[#2a2a2a] tracking-[0.3em] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE]"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              autoFocus
              required
            />
          </div>
          <motion.button
            type="submit"
            className="w-full rounded-full bg-[#97B3AE] px-8 py-4 font-medium text-white shadow-lg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE] focus-visible:ring-offset-2"
            whileHover={reduce ? undefined : { scale: 1.03, y: -2 }}
            whileTap={reduce ? undefined : { scale: 0.98 }}
            disabled={busy || code.trim().length === 0}
          >
            {busy ? 'Verifying…' : 'Verify'}
          </motion.button>
          <a
            className="block text-center text-sm text-[#97B3AE] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE] rounded"
            href={`mailto:${SUPPORT_EMAIL}`}
          >
            Trouble signing in? Contact support
          </a>
        </form>
      )}
    </MfaShell>
  );
}

// useSearchParams requires a Suspense boundary during prerender/CSR bailout.
export default function MfaChallengePage() {
  return (
    <Suspense
      fallback={
        <MfaShell>
          <h1 className="text-2xl sm:text-3xl font-medium text-[#2a2a2a] mb-2">
            Verify it&apos;s you
          </h1>
          <p aria-live="polite" className="text-[#6a6a6a]">
            Loading…
          </p>
        </MfaShell>
      }
    >
      <MfaChallengeForm />
    </Suspense>
  );
}
```

- [ ] **Step 2: Run the component test to verify it passes**

Run: `cd /tmp/repworth-mfa-brand && pnpm test -- src/app/mfa/challenge/__tests__/page.test.tsx`

Expected: PASS (3 tests).

- [ ] **Step 3: Grep-verify no off-brand tokens remain**

Run: `cd /tmp/repworth-mfa-brand && grep -nE "bg-gray-50|bg-blue-|text-blue-|focus:ring-blue|amber|orange|stone|text-sm\"[^>]*(input|select)" src/app/mfa/challenge/page.tsx || echo "CLEAN — no off-brand tokens"`

Expected: `CLEAN — no off-brand tokens`. (The only `text-sm` uses left are on labels/links/wordmark, never on the `<input>`/`<select>`, which use `text-base`.)

---

## Task 3: Full verification gate + commit

**Files:** none (verification only)

- [ ] **Step 1: Lint**

Run: `cd /tmp/repworth-mfa-brand && pnpm lint`
Expected: no errors. (Note: this is a `/tmp` sibling worktree, not nested in the repo, so module resolution is clean.)

- [ ] **Step 2: Typecheck**

Run: `cd /tmp/repworth-mfa-brand && pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Full test suite**

Run: `cd /tmp/repworth-mfa-brand && pnpm test`
Expected: all tests pass, including the new `src/app/mfa/challenge/__tests__/page.test.tsx`.

- [ ] **Step 4: Build**

Run: `cd /tmp/repworth-mfa-brand && pnpm build`
Expected: build succeeds; `/mfa/challenge` compiles.

- [ ] **Step 5: Commit**

```bash
cd /tmp/repworth-mfa-brand && git add src/app/mfa/challenge/page.tsx src/app/mfa/challenge/__tests__/page.test.tsx && git commit -m "$(cat <<'EOF'
feat(mfa): brand the MFA challenge page + fix iOS input zoom & pattern (P0 #4)

Rebuild mfa/challenge in the RepWorth island brand (sage bg, white island,
teal pill CTA, motion/react entry). Fix iOS input zoom by moving the code
input and factor select to text-base (16px), and add pattern="[0-9]*" so
iOS Safari shows the numeric keypad. Brand the Suspense fallback, add
aria-live on loading/error, role="alert" on errors, and a contact-support
recovery link on the no-factor and error dead-ends. Export MfaChallengeForm
for unit testing. No shared auth-island.css / login / signup changes; auth
logic preserved verbatim.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- Layout (sage root, no overflow-hidden, bg cards aria-hidden, centered island, motion entry, wordmark) → Task 2 (`MfaShell` + `BrandBackground`). ✓
- Preserved logic (normalize*, safeNext, ensureChallenge, verify, state, Supabase/fetch) → Task 2 (copied verbatim). ✓
- Brand visuals (teal pill `motion.button`, `#2a2a2a`/`#6a6a6a`, red error only) → Task 2. ✓
- iOS zoom: input + select `text-base` (16px) → Task 2; guarded by Task 1 test + Task 2 Step 3 grep. ✓
- `pattern="[0-9]*"` → Task 2; guarded by Task 1 test. ✓
- Branded Suspense fallback → Task 2 (`MfaChallengePage` fallback uses `MfaShell`). ✓
- aria-live (assertive error / polite loading + verifying status) → Task 2. ✓
- Recovery link `mailto:support@repworth.com` on no-factor AND error states → Task 2; guarded by Task 1 test. ✓
- prefers-reduced-motion via `useReducedMotion` → Task 2. ✓
- focus-visible rings → Task 2. ✓
- Tests (numeric+pattern+16px, dual recovery links, alert region) → Task 1. ✓
- Non-goals (no `robots`, no shared CSS / login / signup, no API/logic) → respected; only `page.tsx` + new test touched. ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to". Full file content and full test content are inlined. ✓

**3. Type consistency:** `MfaChallengeForm` (exported, no props) is referenced identically in the test (`import { MfaChallengeForm }`, `createElement(MfaChallengeForm)`) and the page (`export function MfaChallengeForm()`, `<MfaChallengeForm />`). `MfaShell` takes `{ children: ReactNode }`. `ChallengeFactor` shape unchanged. `SUPPORT_EMAIL = 'support@repworth.com'` matches the test's `mailto:support@repworth.com` assertion. ✓
