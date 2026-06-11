# Launch-Ready Remainders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every remaining code-side item from `docs/launch-ready-part1.md` + `docs/launch-ready-part2.md` (verified 2026-06-11 against `main@8e185e38`) without changing any behavior outside the audited gaps.

**Architecture:** Four independent PRs sliced by risk profile. PR1 rebrands the four off-brand public auth surfaces onto a new shared `AuthCardShell` (modeled on the MFA island precedent), switching on the existing `portal` prop so admin screens stay pixel-identical. PR2 is a low-risk sweep (2-line palette fix, one LiveRegion, stale-doc corrections). PR3 adds migration 064 (`accounts.onboarding_wizard_completed_at`), stamps it in the wizard's existing transaction, and replaces the timestamp proxy in `signup-status` — it rides `staging` first; **the user applies the migration to both Supabase projects**. PR4 adds the four missing test suites (pure tests, zero runtime risk).

**Tech Stack:** Next.js 16 / React, Tailwind, `motion/react` (LazyMotion + `m`), Vitest + @testing-library/react, Postgres.js, Supabase migrations.

**Locked decisions (from grilling session):**
- Scope OUT: demo view-counter Redis debounce (Sprint-4 TODO stands), un-skipping e2e specs (CI/infra project).
- Shell: one shared `AuthCardShell`; `portal="admin"` keeps current gray/blue exactly; owner gets sage/white/teal island. Minimal wordmark header (MFA/approval precedent), NOT SiteNav.
- Column: `accounts.onboarding_wizard_completed_at` (account-level milestone). Migration backfills via today's proxy predicate, then `signup-status` reads **column only** in the flag-ON branch; legacy `place_id_verified` branch untouched.
- Green fix: `HowItWorksContent.tsx` only — functional greens (charts, password strength, admin) stay.
- Login aria-live: **no change needed** — `LoginForm.tsx:107` already renders the error in `<p className="rw-alert" role="alert">`, which announces on insertion. Document, don't churn.
- Execution: PR1 subagent-driven TDD (invoke `repworth-brand-design` in each UI task); PR2–4 direct.

**Verification gate for every PR:** `pnpm lint && pnpm typecheck && pnpm test` green locally; PR via `gh pr create`; squash-merge after the 4 CI checks pass. Never push to `main`.

---

## PR1 — Auth island rebrand + auth aria-live (branch `feat/auth-island-card-rebrand`)

Closes part2 §B "All auth forms off-brand" (P0) and the forgot/reset/check-email slice of the aria-live remainder.

**Files:**
- Create: `src/components/auth/AuthCardShell.tsx`
- Create: `src/components/auth/__tests__/AuthCardShell.test.tsx`
- Modify: `src/components/auth/ForgotPasswordFormClient.tsx`
- Modify: `src/components/auth/ResetPasswordFormClient.tsx` (+ add `portal` prop)
- Modify: `src/app/(public)/reset-password/page.tsx`, `src/app/admin/reset-password/page.tsx` (pass `portal`)
- Modify: `src/components/auth/CheckEmailClient.tsx`
- Modify: `src/components/auth/FinishSignupClient.tsx`
- Modify: `docs/launch-ready-part2.md` (tick the auth-forms P0 + aria-live lines)
- Tests: extend `src/components/auth/__tests__/` (one file per client; check for existing files first and extend rather than duplicate)

**Hard constraints:**
- `LoginFormClient.tsx` (admin-only) — DO NOT TOUCH.
- All fetch/submit/error/redirect logic in every client is preserved **byte-for-byte**; this is a presentational-only change (same discipline as PR #165).
- No `overflow:hidden` anywhere (locked by `src/__tests__/island-overflow.test.ts`).
- All owner-variant inputs `text-base` (16px — iOS zoom rule M2).
- Invoke the `repworth-brand-design` skill before writing any JSX.

### Task 1.1: AuthCardShell

- [ ] **Step 1: Write the failing test** — `src/components/auth/__tests__/AuthCardShell.test.tsx`

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthCardShell, authFieldClass, authPrimaryButtonClass } from '../AuthCardShell';

describe('AuthCardShell', () => {
  it('renders children inside a sage page with a white rounded island and wordmark', () => {
    const { container } = render(
      <AuthCardShell>
        <p>card body</p>
      </AuthCardShell>,
    );
    expect(screen.getByText('card body')).toBeInTheDocument();
    expect(screen.getByText('RepWorth')).toBeInTheDocument();
    const main = container.querySelector('main');
    expect(main?.className).toContain('bg-[#D2E0D3]');
    expect(container.innerHTML).toContain('rounded-[3rem]');
  });

  it('defaults to max-w-md and supports width="sm"', () => {
    const { container, rerender } = render(<AuthCardShell>x</AuthCardShell>);
    expect(container.innerHTML).toContain('max-w-md');
    rerender(<AuthCardShell width="sm">x</AuthCardShell>);
    expect(container.innerHTML).toContain('max-w-sm');
  });

  it('exports 16px field styling (iOS zoom rule) and a teal primary button', () => {
    expect(authFieldClass).toContain('text-base');
    expect(authPrimaryButtonClass).toContain('#97B3AE');
  });
});
```

- [ ] **Step 2: Run it** — `pnpm vitest run src/components/auth/__tests__/AuthCardShell.test.tsx` → FAIL (module not found)

- [ ] **Step 3: Implement** — `src/components/auth/AuthCardShell.tsx`

```tsx
'use client';

import type { ReactNode } from 'react';
import { LazyMotion, domAnimation, m, useReducedMotion } from 'motion/react';

/** One owner for auth-card field styling. text-base = 16px (iOS zoom rule). */
export const authFieldClass =
  'w-full px-4 py-3 border border-[#2a2a2a]/15 rounded-xl text-base text-[#2a2a2a] placeholder:text-[#6a6a6a]/60 focus:outline-none focus:ring-2 focus:ring-[#97B3AE] focus:border-transparent';

export const authLabelClass = 'block text-sm font-medium text-[#2a2a2a] mb-1';

export const authPrimaryButtonClass =
  'w-full bg-[#97B3AE] text-white font-medium py-3 rounded-full hover:bg-[#86a39e] disabled:opacity-50 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#97B3AE]';

interface AuthCardShellProps {
  children: ReactNode;
  /** Island width — 'sm' for single-field forms, 'md' (default) otherwise. */
  width?: 'sm' | 'md';
}

/**
 * Sage page + centered white island card for single-card owner auth flows
 * (forgot/reset/check-email/finish-signup). Mirrors the MFA island
 * (MfaChallengeForm). No overflow:hidden (iOS Safari rule); motion respects
 * prefers-reduced-motion. Admin portals must NOT use this shell — they keep
 * the utilitarian internal style.
 */
export function AuthCardShell({ children, width = 'md' }: AuthCardShellProps) {
  const reduce = useReducedMotion();
  return (
    <LazyMotion features={domAnimation}>
      <main className="min-h-screen bg-[#D2E0D3] relative flex items-center justify-center px-4 py-16">
        <m.div
          className={`relative z-10 w-full ${width === 'sm' ? 'max-w-sm' : 'max-w-md'} bg-white rounded-[3rem] shadow-2xl p-8 sm:p-10`}
          initial={reduce ? false : { opacity: 0, y: 24, scale: 0.97 }}
          animate={reduce ? undefined : { opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        >
          <div className="flex items-center gap-2 mb-8">
            <div className="size-8 rounded-full bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80" />
            <span className="text-sm tracking-wider uppercase text-[#97B3AE]">RepWorth</span>
          </div>
          {children}
        </m.div>
      </main>
    </LazyMotion>
  );
}
```

Before committing, check the exact `motion/react` import names against `src/app/mfa/challenge/MfaChallengeForm.tsx` (lines 1–20) — match its import style exactly.

- [ ] **Step 4: Run tests** — same command → PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(auth): add shared AuthCardShell island for single-card owner auth flows"`

### Task 1.2: ForgotPasswordFormClient — owner island, admin untouched

- [ ] **Step 1: Failing tests** — create/extend `src/components/auth/__tests__/ForgotPasswordFormClient.test.tsx` (extend existing file if present):

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ForgotPasswordFormClient } from '../ForgotPasswordFormClient';

describe('ForgotPasswordFormClient portal variants', () => {
  it('owner portal renders the branded island (sage bg, no gray/blue)', () => {
    const { container } = render(
      <ForgotPasswordFormClient portal="owner" brandName="RepWorth" />,
    );
    expect(container.innerHTML).toContain('bg-[#D2E0D3]');
    expect(container.innerHTML).not.toContain('bg-gray-50');
    expect(container.innerHTML).not.toContain('bg-blue-600');
    // 16px inputs — iOS zoom rule
    expect(container.querySelector('input#forgot-email')?.className).toContain('text-base');
  });

  it('admin portal keeps the utilitarian gray/blue card exactly', () => {
    const { container } = render(
      <ForgotPasswordFormClient portal="admin" brandName="RepWorth Admin" />,
    );
    expect(container.innerHTML).toContain('bg-gray-50');
    expect(container.innerHTML).not.toContain('bg-[#D2E0D3]');
  });

  it('announces the sent confirmation via a polite live region (owner)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    render(<ForgotPasswordFormClient portal="owner" brandName="RepWorth" />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.co' } });
    fireEvent.submit(screen.getByRole('button', { name: /send reset link/i }).closest('form')!);
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/we.+sent a reset link/i);
    });
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run** → FAIL (owner renders gray)
- [ ] **Step 3: Implement** — rewrite `ForgotPasswordFormClient.tsx`. Keep `handleSubmit` and all state byte-for-byte. Structure:

```tsx
'use client';

import { useState } from 'react';
import type { AuthFlow } from '@/lib/shared/auth-flow';
import { LiveRegion } from '@/components/ui/LiveRegion';
import {
  AuthCardShell,
  authFieldClass,
  authLabelClass,
  authPrimaryButtonClass,
} from './AuthCardShell';

export interface ForgotPasswordFormProps {
  portal: AuthFlow;
  brandName: string;
}

const SENT_MESSAGE =
  "If an account exists for that email, we've sent a reset link. Check your inbox.";

export function ForgotPasswordFormClient({ portal, brandName }: ForgotPasswordFormProps) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    // ... EXACT current body, unchanged ...
  }

  if (portal === 'admin') {
    return <AdminForgotPassword {...{ brandName, email, setEmail, sent, loading, handleSubmit }} />;
  }

  return (
    <AuthCardShell width="sm">
      <LiveRegion message={sent ? SENT_MESSAGE : ''} />
      {sent ? (
        <p className="text-base text-[#2a2a2a] text-center">{SENT_MESSAGE}</p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <h1 className="text-2xl font-semibold text-[#2a2a2a]">Reset your password</h1>
          <div>
            <label htmlFor="forgot-email" className={authLabelClass}>Email</label>
            <input
              id="forgot-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={authFieldClass}
            />
          </div>
          <button type="submit" disabled={loading} className={authPrimaryButtonClass}>
            {loading ? 'Sending...' : 'Send reset link'}
          </button>
        </form>
      )}
    </AuthCardShell>
  );
}

/** Admin keeps the pre-rebrand utilitarian card — byte-for-byte the old JSX. */
function AdminForgotPassword(/* props as above */) {
  // EXACT old `if (sent)` block + old form JSX, with state/handlers from props.
  // (Copy the current file's JSX verbatim; only mechanical prop threading changes.)
}
```

Notes for implementer: `brandName` in the owner variant is replaced by the shell's wordmark — keep the heading copy "Reset your password". The old `h1 {brandName}` survives only in the admin variant. The sent-state in owner uses the SAME `SENT_MESSAGE` string as the LiveRegion (one owner for the copy).

- [ ] **Step 4: Run task tests + the whole auth test dir** — `pnpm vitest run src/components/auth` → PASS
- [ ] **Step 5: Commit** — `feat(auth): brand owner forgot-password on AuthCardShell; admin unchanged`

### Task 1.3: ResetPasswordFormClient — add `portal` prop, owner island

- [ ] **Step 1: Failing tests** — `src/components/auth/__tests__/ResetPasswordFormClient.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ResetPasswordFormClient } from '../ResetPasswordFormClient';

// next/navigation mock — match the pattern used by existing auth tests.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe('ResetPasswordFormClient portal variants', () => {
  it('owner portal renders the branded island with 16px inputs', () => {
    const { container } = render(
      <ResetPasswordFormClient portal="owner" brandName="RepWorth" />,
    );
    expect(container.innerHTML).toContain('bg-[#D2E0D3]');
    expect(container.innerHTML).not.toContain('bg-blue-600');
    expect(container.querySelector('input#new-password')?.className).toContain('text-base');
  });

  it('admin portal keeps gray/blue exactly', () => {
    const { container } = render(
      <ResetPasswordFormClient portal="admin" brandName="RepWorth Admin" />,
    );
    expect(container.innerHTML).toContain('bg-gray-50');
  });

  it('announces validation errors assertively (owner)', async () => {
    render(<ResetPasswordFormClient portal="owner" brandName="RepWorth" />);
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: 'short' } });
    fireEvent.submit(screen.getByRole('button', { name: /update password/i }).closest('form')!);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Password must be at least 8 characters');
    });
  });
});
```

- [ ] **Step 2: Run** → FAIL (no `portal` prop)
- [ ] **Step 3: Implement** — same split pattern as Task 1.2: add `portal: AuthFlow` to `ResetPasswordFormProps`; `handleSubmit` byte-for-byte; owner variant = `AuthCardShell width="sm"` + heading "Set a new password" + two labeled password fields (`authFieldClass`/`authLabelClass`) + visible `<p className="text-sm text-red-600">{error}</p>` retained + `<LiveRegion level="assertive" message={error} />` + teal button; admin variant = current JSX verbatim in a local `AdminResetPassword` function.
- [ ] **Step 4: Update both pages:**
  - `src/app/(public)/reset-password/page.tsx`: `<ResetPasswordFormClient portal="owner" brandName="RepWorth" />`
  - `src/app/admin/reset-password/page.tsx`: `<ResetPasswordFormClient portal="admin" brandName="RepWorth Admin" />`
- [ ] **Step 5: Run** — `pnpm vitest run src/components/auth` + `pnpm typecheck` → PASS (typecheck catches any other `<ResetPasswordFormClient>` call sites missing `portal`)
- [ ] **Step 6: Commit** — `feat(auth): brand owner reset-password on AuthCardShell via new portal prop`

### Task 1.4: CheckEmailClient — owner-only rebrand + live regions

- [ ] **Step 1: Failing tests** — extend the existing CheckEmail test file if present (`ls src/components/auth/__tests__/` first), else create `CheckEmailClient.test.tsx`:

```tsx
// Mock useSearchParams to supply ?email= — match the existing test file's
// next/navigation mock if one exists.
it('renders the branded island, not gray', () => {
  const { container } = render(<CheckEmailClient />);
  expect(container.innerHTML).toContain('bg-[#D2E0D3]');
  expect(container.innerHTML).not.toContain('bg-gray-50');
  expect(container.innerHTML).not.toContain('bg-blue-600');
});

it('announces verify errors via role=alert live region', async () => {
  // submit with empty email param → guard error path (no fetch needed)
  render(<CheckEmailClient />); // searchParams mocked WITHOUT email
  fireEvent.submit(screen.getByRole('button', { name: /verify and continue/i }).closest('form')!);
  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent(/no email on this page/i);
  });
});
```

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** — `CheckEmailClient.tsx`. Preserve verbatim: the reducer, both handlers, the no-email guards, `redirectAfterServerSessionCookie`, the OTP-length contract comments, and the input's `minLength/maxLength/pattern/title/placeholder/inputMode/autoComplete` attributes. Changes only:
  - Suspense fallback: `<div className="min-h-screen bg-[#D2E0D3]" />`
  - Outer wrapper → `<AuthCardShell>` (default `md` width).
  - Headings/body → ink `text-[#2a2a2a]` / soft-ink `text-[#6a6a6a]`; code input keeps `text-base text-center tracking-[0.5em] font-mono` but adopts `authFieldClass` border/focus colors (merge: `className={`${authFieldClass} text-center tracking-[0.5em] font-mono`}`).
  - Verify button → `authPrimaryButtonClass`; "Resend code" link-button → `text-sm text-[#97B3AE] hover:underline disabled:opacity-50 disabled:cursor-not-allowed`; back-link → `text-sm text-[#6a6a6a] hover:text-[#2a2a2a] hover:underline`.
  - Resend success copy `text-green-700` → `text-[#2a2a2a]` (decorative success — brand rule).
  - Add live regions after the form (visible error `<p>`s stay):
    ```tsx
    <LiveRegion level="assertive" message={verifyError || resendError} />
    <LiveRegion message={resendSent ? 'A new code is on its way.' : ''} />
    ```
- [ ] **Step 4: Run** — `pnpm vitest run src/components/auth` → PASS
- [ ] **Step 5: Commit** — `feat(auth): brand signup check-email on AuthCardShell + live regions`

### Task 1.5: FinishSignupClient — owner-only rebrand

- [ ] **Step 1: Failing test** — extend existing FinishSignup test (one exists — it got visible labels in PR #183; find it first):

```tsx
it('renders the branded island, not gray/blue', () => {
  const { container } = render(
    <FinishSignupClient defaultEmail="a@b.co" defaultName="Ada" />,
  );
  expect(container.innerHTML).toContain('bg-[#D2E0D3]');
  expect(container.innerHTML).not.toContain('bg-blue-600');
  expect(container.querySelector('input#finish-name')?.className).toContain('text-base');
});
```

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** — preserve handlers + LiveRegion + disabled-email rationale comment verbatim. Wrap in `<AuthCardShell width="sm">`; heading "Almost there, just your name" → `text-2xl font-semibold text-[#2a2a2a]`; subcopy → `text-[#6a6a6a]`; labels → `authLabelClass`; the two editable inputs → `authFieldClass`; the disabled email input → `authFieldClass` + ` bg-[#F0EEEA] text-[#6a6a6a]` (brand's neutral panel tone); button → `authPrimaryButtonClass`.
- [ ] **Step 4: Run** — `pnpm vitest run src/components/auth` → PASS
- [ ] **Step 5: Commit** — `feat(auth): brand finish-signup on AuthCardShell`

### Task 1.6: PR1 wrap-up

- [ ] **Step 1:** Update `docs/launch-ready-part2.md`:
  - §B line "All auth forms off-brand …" → `✅ **DONE (this PR):** forgot/reset/check-email/finish rebuilt on a shared AuthCardShell (sage/white/teal island, 16px inputs, motion + reduced-motion); Login/Signup were already on the AuthIsland (the audit overcounted); admin portals intentionally keep the utilitarian style.`
  - ♿ aria-live line: replace "login/forgot/reset + add-location wizard remain pending" → `login already announces via role="alert" (rw-alert); forgot/reset/check-email announce via LiveRegion (this PR); add-location wizard remains (PR2).`
  - "Effort framing" closing paragraph: note auth forms done.
- [ ] **Step 2:** Full gate — `pnpm lint && pnpm typecheck && pnpm test` → all green. Also `pnpm vitest run src/__tests__/island-overflow.test.ts src/__tests__/page-metadata.test.ts` explicitly.
- [ ] **Step 3:** `gh pr create` with summary listing the four rebranded surfaces + admin-untouched guarantee; merge after CI.

---

## PR2 — How-it-works green + add-location LiveRegion + stale-doc corrections (branch `chore/launch-audit-residuals`)

**Files:**
- Modify: `src/components/sections/how-it-works/HowItWorksContent.tsx:240,320`
- Modify: `src/app/(authenticated)/dashboard/add-location/AddLocationWizard.tsx`
- Modify: `docs/launch-ready-part1.md`, `docs/launch-ready-part2.md`
- Test: extend `src/__tests__/` palette guard

### Task 2.1: Replace #16A34A in HowItWorksContent

- [ ] **Step 1: Failing guard test** — add to a new `src/__tests__/how-it-works-palette.test.ts` (mirror the style of `console-admin-palette.test.ts`):

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('how-it-works palette', () => {
  it('contains no off-palette green (#16A34A) — success states use brand teal', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/components/sections/how-it-works/HowItWorksContent.tsx'),
      'utf8',
    );
    expect(src.toLowerCase()).not.toContain('#16a34a');
  });
});
```

- [ ] **Step 2: Run** → FAIL (two occurrences)
- [ ] **Step 3: Implement** — in `HowItWorksContent.tsx`:
  - Line 240: `style={{ background: '#16A34A' }}` → `style={{ background: '#97B3AE' }}` (approved-state button; check `.hiw-btn-approve`'s base background in `globals.css` first — if it is already `#97B3AE`, delete the inline `style` prop instead of restating it).
  - Line 320: `background: '#16A34A'` → `background: '#97B3AE'` (posted-status dot).
- [ ] **Step 4: Run** — guard test + `pnpm vitest run src/__tests__` → PASS
- [ ] **Step 5: Commit** — `fix(marketing): how-it-works success states off green-600 → brand teal`

### Task 2.2: AddLocationWizard LiveRegion

- [ ] **Step 1: Failing test** — extend the wizard's existing test file (find via `ls src/app/\(authenticated\)/dashboard/add-location/__tests__/` or colocated):

```tsx
it('announces wizard errors via an assertive live region', () => {
  // Render the wizard in a state with submitError set (drive via the same
  // harness the existing tests use — reducer initial state or fetch mock).
  // Assert: screen.getByRole('alert') contains the error text.
});
```

Concrete assertion once the harness is identified: `expect(screen.getByRole('alert')).toHaveTextContent(<the error>)`. All three error fields are `string | null` (`wizard/reducer.ts:24,25,31`).

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** — in `AddLocationWizard.tsx` add:

```tsx
import { LiveRegion } from '@/components/ui/LiveRegion';
// inside the root JSX, once, near the top:
<LiveRegion
  level="assertive"
  message={wiz.submitError ?? wiz.displayLabelError ?? wiz.placeIdDuplicateError ?? ''}
/>
```

(Visible inline errors stay where they are — the region is additive.)

- [ ] **Step 4: Run** wizard tests → PASS
- [ ] **Step 5: Commit** — `a11y(locations): announce add-location wizard errors via LiveRegion`

### Task 2.3: Stale-doc corrections (already-true drifts only)

- [ ] **Step 1:** `docs/launch-ready-part1.md`:
  - Line ~76: drop "`DAILY_COST_LIMIT_CENTS_PREMIUM` is still missing from the example" → it is documented at `.env.example:177` (verified 2026-06-11).
  - Line ~65 (`CONTACT_NOTIFY_TO`): correct "documented + boot-hardened" → "documented in `.env.example`; NOT boot-asserted (no entry in `startup-assert.ts`) — value remains ops".
  - Line ~86: `builder = "NIXPACKS"` → `builder = "RAILPACK"` (changed post-audit; see lab notes).
  - Line ~146 (Admin Zernio panel "no force-drain/dismiss buttons … Still outstanding"): → `✅ DONE — POST /api/admin/businesses/[id]/zernio-queue (force-drain + per-row dismiss) + panel buttons shipped; TODO removed.`
- [ ] **Step 2:** `docs/launch-ready-part2.md`:
  - Line ~104 (§E `ZernioConnectionPanel` "DEFERRED (#23b)"): → DONE, pointing at line 158's #23b entry (the two lines currently contradict).
  - Lines ~100/137/155: `support@repworth.com` → `support@repworth.net` (PR #183 unified domains; code already `.net`).
  - "How-it-works — uses #16A34A" line: tick → DONE (this PR).
- [ ] **Step 3:** Verify rendered diff (`git diff docs/`), then commit — `docs: correct stale launch-audit ticks to match verified code state`
- [ ] **Step 4:** Full gate `pnpm lint && pnpm typecheck && pnpm test` → green; `gh pr create`; merge after CI.

---

## PR3 — `accounts.onboarding_wizard_completed_at` (branch `feat/onboarding-wizard-completed-at`) — RIDES STAGING

**Files:**
- Create: `supabase/migrations/064_accounts_onboarding_wizard_completed_at.sql`
- Modify: `src/app/api/onboarding/business/route.ts`
- Modify: `src/app/api/auth/signup-status/route.ts`
- Modify: `src/app/api/auth/__tests__/signup-status.test.ts`, `src/app/api/onboarding/__tests__/business.test.ts`
- Modify: `.claude/reference/migrations-log.md`, `docs/launch-ready-part1.md`

**Process gates (do not skip):**
1. Land the branch; merge it into `staging` and push (auto-deploys full staging stack).
2. **Hand the user the migration file path + ask them to apply 064 to the STAGING Supabase project.** Wait for confirmation.
3. Verify on staging: `GET /api/auth/signup-status` returns `businessOnboarded:false` for a fresh active account, flips true after wizard submit.
4. Open the PR to `main`; after CI green and **the user confirms 064 is applied to PROD**, merge. Then `git checkout staging && git merge --ff-only main && git push`.

### Task 3.1: Migration 064

- [ ] **Step 1:** Re-read `.claude/reference/migrations-log.md` head (confirmed: head 063, next 064; UUIDv7 convention irrelevant here — column only).
- [ ] **Step 2:** Write `supabase/migrations/064_accounts_onboarding_wizard_completed_at.sql`:

```sql
-- 064: explicit post-pay wizard completion stamp (replaces the
-- updated_at > subscription_activated_at + 2s proxy in /api/auth/signup-status).
-- Audit ref: launch-ready-part1 "Signup wizard-complete signal is a timestamp proxy".

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS onboarding_wizard_completed_at TIMESTAMPTZ;

-- Backfill using the exact proxy predicate the route used until now, so
-- pre-migration accounts keep their current businessOnboarded answer.
UPDATE accounts a
SET onboarding_wizard_completed_at = b.updated_at
FROM businesses b
WHERE b.account_id = a.id
  AND b.is_primary = TRUE
  AND a.subscription_activated_at IS NOT NULL
  AND b.updated_at > a.subscription_activated_at + INTERVAL '2 seconds'
  AND a.onboarding_wizard_completed_at IS NULL;
```

- [ ] **Step 3:** Append the 064 entry to `.claude/reference/migrations-log.md` (one paragraph: column, backfill predicate, consumer). Update "Current head" → 064, next 065.
- [ ] **Step 4: Commit** — `feat(db): 064 accounts.onboarding_wizard_completed_at + proxy-predicate backfill`

### Task 3.2: Stamp in the wizard transaction

- [ ] **Step 1: Failing test** — in `src/app/api/onboarding/__tests__/business.test.ts` (read its mock harness first; it mocks `sql.begin` with a tx capture). Add:

```ts
it('stamps accounts.onboarding_wizard_completed_at in the wizard transaction (post-pay)', async () => {
  // Arrange exactly like the existing happy-path post-pay test, then:
  // collect all tx tagged-template calls and assert one UPDATE targets
  // accounts with onboarding_wizard_completed_at and COALESCE semantics.
  const accountStamp = txCalls.find(
    (c) => c.text.includes('onboarding_wizard_completed_at'),
  );
  expect(accountStamp).toBeDefined();
  expect(accountStamp!.text).toContain('COALESCE(onboarding_wizard_completed_at, NOW())');
});
```

(Adapt `txCalls` to the file's existing capture helper — same approach as its current assertions on the businesses UPDATE.)

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** — in `src/app/api/onboarding/business/route.ts`, immediately AFTER the `if (demoFlowEnabled) { UPDATE businesses … } else { UPDATE businesses … }` block and BEFORE the `display_name` update (both branches reach it; the early-return race no-ops above correctly skip it):

```ts
      // Explicit wizard-completion stamp — the one authoritative "wizard ran"
      // signal read by /api/auth/signup-status. COALESCE: first completion
      // wins; resubmits don't move the timestamp. Stamped in BOTH flow
      // branches (legacy + post-pay): the legacy read path doesn't use it
      // today, but the stamp is true in both flows and survives flag flips.
      await tx`
        UPDATE accounts
        SET onboarding_wizard_completed_at = COALESCE(onboarding_wizard_completed_at, NOW()),
            updated_at = NOW()
        WHERE id = ${bizRow.account_id}::uuid
      `;
```

- [ ] **Step 4: Run** — `pnpm vitest run src/app/api/onboarding` → PASS
- [ ] **Step 5: Commit** — `feat(onboarding): stamp onboarding_wizard_completed_at in the wizard tx`

### Task 3.3: signup-status reads the column

- [ ] **Step 1: Failing tests** — in `src/app/api/auth/__tests__/signup-status.test.ts`, update the row fixtures: replace `subscription_activated_at`/`updated_at` with `onboarding_wizard_completed_at`, and add/adjust:

```ts
it('demo flow: businessOnboarded=false when the wizard stamp is NULL', async () => {
  // row: subscription_status 'active', onboarding_wizard_completed_at: null
  // expect body.businessOnboarded === false
});

it('demo flow: businessOnboarded=true when the wizard stamp is set', async () => {
  // row: subscription_status 'active', onboarding_wizard_completed_at: new Date()
  // expect body.businessOnboarded === true
});
```

- [ ] **Step 2: Run** → FAIL
- [ ] **Step 3: Implement** — in `src/app/api/auth/signup-status/route.ts`:
  - `SignupStatusRow`: remove `subscription_activated_at` and `updated_at`; add `onboarding_wizard_completed_at: Date | null`.
  - SELECT: drop `a.subscription_activated_at, b.updated_at`; add `a.onboarding_wizard_completed_at`.
  - Delete the proxy paragraph of the comment block (keep the legacy-flow paragraph; replace the PR-#2 proxy explanation with: "PR #2 (flag ON): the post-pay wizard stamps `accounts.onboarding_wizard_completed_at` in its own transaction (migration 064) — read it directly.").
  - Remove `const subscriptionActivatedAt = …` and its uses.
  - Computation:

```ts
  const businessOnboarded = demoFlowEnabled
    ? subscriptionStatus === SubscriptionStatus.ACTIVE
      && row.onboarding_wizard_completed_at !== null
    : row.place_id_verified || row.google_maps_url !== null;
```

- [ ] **Step 4: Run** — `pnpm vitest run src/app/api/auth` → PASS; `pnpm typecheck` → clean.
- [ ] **Step 5:** Tick the part1 "Signup wizard-complete signal" line (📋 inventory) → DONE (this PR, migration 064). Also remove the `Phase 2 follow-up` comment reference if any remains (grep `business_profile_completed_at` → 0 hits).
- [ ] **Step 6: Commit** — `feat(auth): signup-status reads onboarding_wizard_completed_at; proxy deleted`
- [ ] **Step 7:** Full gate + tenant/RLS audits (DB-touching): `pnpm lint && pnpm typecheck && pnpm test && pnpm ci:tenant-scope && pnpm ci:rls-audit`
- [ ] **Step 8:** Execute the staging process gates at the top of PR3 (user applies migration; verify; then PR → main; user applies prod; merge; ff staging).

---

## PR4 — Test gaps (branch `test/launch-audit-gaps`)

**Files:**
- Create: `src/lib/moderation/__tests__/held-draft.test.ts`
- Modify: `worker/jobs/notification/__tests__/NotificationWorker.test.ts`
- Create: `src/lib/approval/__tests__/token-mode.test.ts`
- Create: `src/lib/approval/__tests__/session-mode.test.ts`
- Modify: `docs/launch-ready-part1.md` (tick the three coverage lines)

### Task 4.1: hasOpenFlag direct unit test

- [ ] **Step 1:** Write `src/lib/moderation/__tests__/held-draft.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { hasOpenFlag, HeldForReviewError } from '../held-draft';

type TxCall = { text: string; values: unknown[] };

/** Minimal tagged-template tx double — enough for hasOpenFlag's single query. */
function mkTx(rows: unknown[]) {
  const calls: TxCall[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.raw.join('$'), values });
    return Promise.resolve(rows);
  }) as never;
  return { tx, calls };
}

const RESPONSE_ID = '01890a5d-ac96-774b-bcce-b302099a8057';

describe('hasOpenFlag', () => {
  it('returns true when an open flag row exists', async () => {
    const { tx } = mkTx([{ one: 1 }]);
    await expect(hasOpenFlag(tx, RESPONSE_ID)).resolves.toBe(true);
  });

  it('returns false when no open flag exists', async () => {
    const { tx } = mkTx([]);
    await expect(hasOpenFlag(tx, RESPONSE_ID)).resolves.toBe(false);
  });

  it("filters on status = 'open' and the response id — the predicate that makes the hold binding", async () => {
    const { tx, calls } = mkTx([]);
    await hasOpenFlag(tx, RESPONSE_ID);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("status = 'open'");
    expect(calls[0].text).toContain('FROM flagged_responses');
    expect(calls[0].values).toContain(RESPONSE_ID);
  });

  it('HeldForReviewError carries the held_for_review message', () => {
    const err = new HeldForReviewError();
    expect(err.message).toBe('held_for_review');
    expect(err.name).toBe('HeldForReviewError');
  });
});
```

- [ ] **Step 2: Run** — `pnpm vitest run src/lib/moderation/__tests__/held-draft.test.ts` → PASS first try (testing existing code; if an assertion fails, the TEST is wrong — fix the test, not `held-draft.ts`).
- [ ] **Step 3: Commit** — `test(moderation): direct unit coverage for hasOpenFlag open-status predicate`

### Task 4.2: past_due worker-path in NotificationWorker

- [ ] **Step 1:** Read `worker/jobs/notification/__tests__/NotificationWorker.test.ts:230-300` (the `pending_payment` test at :262 is the template) AND `src/lib/shared/subscription-guard.ts` (grace semantics: `past_due` within 7 days of `past_due_at` → proceed; beyond → skip).
- [ ] **Step 2:** Add two tests mirroring the :262 pattern exactly (same `mockBusinessRow` helper + skip assertion):

```ts
it('skips notification for past_due beyond the 7-day grace window', async () => {
  // mockBusinessRow({ subscription_status: 'past_due',
  //   account_past_due_at: new Date(Date.now() - 8 * 24 * 3600 * 1000) })
  // → same "skipped" assertions as the pending_payment test
});

it('sends notification for past_due within the 7-day grace window', async () => {
  // account_past_due_at: new Date(Date.now() - 2 * 24 * 3600 * 1000)
  // → same assertions as the happy-path send test
});
```

Verify the exact row-field name the worker reads (`account_past_due_at` per `ResponsePublisherWorker.ts:102`; confirm NotificationWorker uses the same alias) and the guard's exact boundary before finalizing assertions.

- [ ] **Step 3: Run** — `pnpm vitest run worker/jobs/notification` → PASS. If the within-grace case fails, read the guard's actual `past_due` decision for the notification workerType and align the expectation to the GUARD (the guard's unit tests in `src/lib/shared/__tests__/` are the contract) — never change worker behavior in this PR.
- [ ] **Step 4: Commit** — `test(notification): exercise past_due grace window through the worker path`

### Task 4.3: token-mode direct tests

- [ ] **Step 1:** Write `src/lib/approval/__tests__/token-mode.test.ts`. Mock the collaborators, not the SQL:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockVerifyDevice, mockLockPendingResponse, mockConsumeLink, mockRevokeSiblings } =
  vi.hoisted(() => ({
    mockVerifyDevice: vi.fn(),
    mockLockPendingResponse: vi.fn(),
    mockConsumeLink: vi.fn(),
    mockRevokeSiblings: vi.fn(),
  }));
const { mockInsertAuditLog } = vi.hoisted(() => ({ mockInsertAuditLog: vi.fn() }));
const { mockEnqueuePublish, mockEnqueueGenerate } = vi.hoisted(() => ({
  mockEnqueuePublish: vi.fn(),
  mockEnqueueGenerate: vi.fn(),
}));

vi.mock('../locks', () => ({
  verifyDevice: mockVerifyDevice,
  lockPendingResponse: mockLockPendingResponse,
  consumeLink: mockConsumeLink,
  revokeSiblings: mockRevokeSiblings,
}));
vi.mock('../audit', () => ({ insertAuditLog: mockInsertAuditLog }));
vi.mock('@/lib/shared/job-outbox-helpers', () => ({
  enqueuePublishResponse: mockEnqueuePublish,
  enqueueGenerateResponse: mockEnqueueGenerate,
}));

import { approve, edit, regenerate } from '../token-mode';
import { EmptyEditedResponseError } from '../errors';

type TxCall = { text: string; values: unknown[] };
function mkTx() {
  const calls: TxCall[] = [];
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.raw.join('$'), values });
    return Promise.resolve([]);
  }) as never;
  return { tx, calls };
}

const LINK = {
  id: 'link-1',
  response_id: 'resp-1',
  business_id: 'biz-1',
} as never; // extend with whatever ApprovalLink fields the type requires
const AUDIT = { ip: '1.2.3.4', userAgent: 'vitest' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockLockPendingResponse.mockResolvedValue({
    response_text: 'draft text',
    original_draft_text: 'draft text',
    review_id: 'rev-1',
    version: 1,
  });
});

describe('token-mode approve', () => {
  it('verifies device, locks BEFORE consuming, marks approved, revokes siblings, enqueues publish, audits', async () => {
    const { tx, calls } = mkTx();
    await approve(tx, LINK, 'device-hash', AUDIT, 'corr-1');

    expect(mockVerifyDevice).toHaveBeenCalledWith(LINK, 'device-hash');
    // lock-before-consume ordering (rollback safety: no consumed link on a non-pending response)
    expect(mockLockPendingResponse.mock.invocationCallOrder[0]).toBeLessThan(
      mockConsumeLink.mock.invocationCallOrder[0],
    );
    const update = calls.find((c) => c.text.includes("status = 'approved'"));
    expect(update).toBeDefined();
    expect(update!.values).toContain('resp-1');
    expect(mockRevokeSiblings).toHaveBeenCalledWith(tx, 'resp-1', 'link-1');
    expect(mockEnqueuePublish).toHaveBeenCalledWith(tx, {
      responseId: 'resp-1', businessId: 'biz-1', correlationId: 'corr-1',
    });
    expect(mockInsertAuditLog).toHaveBeenCalled();
  });

  it('propagates lock failure WITHOUT consuming the link', async () => {
    mockLockPendingResponse.mockRejectedValueOnce(new Error('not pending'));
    const { tx } = mkTx();
    await expect(approve(tx, LINK, 'h', AUDIT)).rejects.toThrow('not pending');
    expect(mockConsumeLink).not.toHaveBeenCalled();
    expect(mockEnqueuePublish).not.toHaveBeenCalled();
  });
});

describe('token-mode edit', () => {
  it('rejects empty edited text before any lock or consume', async () => {
    const { tx } = mkTx();
    await expect(edit(tx, LINK, '   ', 'h', AUDIT)).rejects.toThrow(EmptyEditedResponseError);
    expect(mockLockPendingResponse).not.toHaveBeenCalled();
    expect(mockConsumeLink).not.toHaveBeenCalled();
  });

  it('stores edited text with edit distance and enqueues publish', async () => {
    const { tx, calls } = mkTx();
    await edit(tx, LINK, 'better text', 'h', AUDIT, 'corr-2');
    const update = calls.find((c) => c.text.includes("status = 'edited'"));
    expect(update).toBeDefined();
    expect(update!.text).toContain('edit_distance');
    expect(mockEnqueuePublish).toHaveBeenCalled();
  });
});

describe('token-mode regenerate', () => {
  it('supersedes and enqueues generate_response with version+1 (no publish)', async () => {
    const { tx, calls } = mkTx();
    await regenerate(tx, LINK, 'h', AUDIT, 'corr-3');
    expect(calls.some((c) => c.text.includes("status = 'superseded'"))).toBe(true);
    expect(mockEnqueueGenerate).toHaveBeenCalledWith(tx, expect.objectContaining({
      reviewId: 'rev-1', businessId: 'biz-1', version: 2,
    }));
    expect(mockEnqueuePublish).not.toHaveBeenCalled();
  });
});
```

NOTE: check `../locks` exports before finalizing — the mock must export EVERY name token-mode imports (`verifyDevice`, `lockPendingResponse`, `consumeLink`, `revokeSiblings`). `sanitizePublicResponseText` and `fastest-levenshtein` are NOT mocked (pure functions — use them real).

- [ ] **Step 2: Run** — `pnpm vitest run src/lib/approval/__tests__/token-mode.test.ts` → PASS (existing code; align test, never the module).
- [ ] **Step 3: Commit** — `test(approval): direct unit coverage for token-mode approve/edit/regenerate`

### Task 4.4: session-mode direct tests

- [ ] **Step 1:** Write `src/lib/approval/__tests__/session-mode.test.ts` — same harness shape as 4.3 but mocking `lockPendingResponse` + `revokeOpenLinksForResponse` from `../locks` and `insertAuditLog` + `insertAuditLogSession` from `../audit`:

```ts
describe('approveBySession', () => {
  it('locks, revokes open links, marks approved, enqueues publish, writes session audit', async () => {
    const { tx, calls } = mkTx();
    await approveBySession(tx, 'resp-1', 'biz-1', SESSION_AUDIT, 'corr-1');
    expect(mockRevokeOpenLinks).toHaveBeenCalledWith(tx, 'resp-1');
    expect(calls.some((c) => c.text.includes("status = 'approved'"))).toBe(true);
    expect(mockEnqueuePublish).toHaveBeenCalledWith(tx, {
      responseId: 'resp-1', businessId: 'biz-1', correlationId: 'corr-1',
    });
    expect(mockInsertAuditLogSession).toHaveBeenCalled();
  });
});

describe('establishApprovalSession', () => {
  it('binds the device cookie on first visit', async () => {
    // tx returns [{ device_cookie_hash: null, response_id: 'resp-1', business_id: 'biz-1' }]
    // → expect an UPDATE approval_links call with the new hash + session_bind audit
  });
  it('no-ops when the same device returns', async () => {
    // device_cookie_hash === provided hash → no UPDATE call (only the SELECT)
  });
  it('throws DeviceConflictError for a different device', async () => {
    // device_cookie_hash differs → rejects.toThrow(DeviceConflictError)
  });
  it('throws InvalidTokenError when the link is gone', async () => {
    // tx returns [] → rejects.toThrow(InvalidTokenError)
  });
});

describe('editBySession', () => {
  it('rejects empty edited text with EmptyEditedResponseError', async () => { /* as 4.3 */ });
});

describe('regenerateBySession', () => {
  it('supersedes + enqueues generate with version+1', async () => { /* as 4.3 */ });
});
```

For `establishApprovalSession` the tx double needs per-call return values — use a queue: `mkTx(returnQueue: unknown[][])` shifting one result per tagged-template call (same idea as the project's `sqlReturnQueue` pattern, but LOCAL to this file — the bounced-skip flake taught us never to share it module-level).

- [ ] **Step 2: Run** → PASS
- [ ] **Step 3:** Tick part1 test-gap lines: `hasOpenFlag` (P1) → DONE; `past_due` half of the subscription-guard line → DONE; `session-mode/token-mode` (P2) → DONE. Leave the e2e-skip and CI-wiring lines untouched (out of scope).
- [ ] **Step 4: Commit** — `test(approval): direct unit coverage for session-mode + establishApprovalSession`
- [ ] **Step 5:** Full gate `pnpm lint && pnpm typecheck && pnpm test` → green; `gh pr create`; merge after CI.

---

## Execution order

1. **PR2** first (smallest, unblocks doc truth), then **PR4** (pure tests), then **PR1** (subagent-driven, biggest), then **PR3** last (needs user migration applies; staging ride).
2. PR3's staging merge happens only after PR1/PR2/PR4 are on `main` (staging stays a strict superset; ff-sync staging after each main merge per repo convention).
3. After ALL four merge: re-run the verification sweep against both launch-ready docs and confirm every in-scope line is ticked.

## Out-of-scope register (explicitly NOT in this plan)

- Demo view-counter Redis INCR debounce — TODO stands (`demo/[slug]/page.tsx:17`).
- e2e un-skip (forgot/reset/signup-google) + `TEST_DATABASE_POOL_URL` CI wiring — separate infra effort.
- All P0 ops/config items (secrets, prod URLs, Stripe live, DNS/DKIM, legal review, drills).
- `RankingTrackingWorker` 1-keyword cap, PostHog dashboards, GBP API application.
