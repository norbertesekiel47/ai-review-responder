# Brand the Conversion Funnel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin all five onboarding funnel pages into the RepWorth island design system (sage bg + white island + teal CTAs + motion + a shared cross-page step thread), changing presentation only — no funnel logic touched.

**Architecture:** One new shared module `src/app/onboarding/_shared/` provides an `OnboardingFunnelShell` (island wrapper), a `FunnelStepThread` (4-milestone progress), and `field-styles.ts` (one owner for branded form-control classes). Each funnel client component drops its `bg-gray-50` wrapper, wraps its content in the shell, and swaps gray/blue/amber/yellow for approved brand tokens.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript (strict), Tailwind CSS v4, `motion/react`, Vitest + Testing Library (jsdom), pnpm.

**Spec:** `docs/superpowers/specs/2026-05-28-onboarding-funnel-brand-design.md`

**Brand tokens (the only colors allowed):**
| Use | Token |
|---|---|
| Page bg | `#D2E0D3` · Island `#ffffff` · CTA `#97B3AE` (hover `#7e9b96`) |
| Tinted/AI box `#F0EEEA` · Accent blush `#F2C3B9` |
| Heading `#2a2a2a` · Body `#6a6a6a` · Muted `#9a948a` · Todo/empty `#e3ddd3`/`#cdd9ce` |
No amber / orange / stone / yellow / blue anywhere.

**Working directory:** `/private/tmp/repworth-onboarding-funnel` (branch `fix/launch-p0-onboarding-funnel`). All commands run from there.

**Global rules for every task:**
- Import motion as `import { motion } from 'motion/react'` — never `framer-motion`.
- Do NOT modify `src/components/ui/PageShell.tsx`.
- Do NOT modify `src/components/PlaceAutocomplete.tsx` (shared with admin/dashboard).
- Touch only the `return (...)` / JSX and styling. Leave every hook, effect, handler, fetch, and redirect byte-for-byte unchanged unless a step explicitly says otherwise.

---

## Task 1: Shared branded form-control styles (`field-styles.ts`)

**Files:**
- Create: `src/app/onboarding/_shared/field-styles.ts`

This is pure string/constant content (one authoritative owner for funnel field styling) — no unit test.

- [ ] **Step 1: Create the file**

```ts
// Branded styling for onboarding funnel form controls + CTAs.
// Single authoritative owner so every funnel input/label/banner/button
// derives from one place. Inputs use text-base (16px) to prevent iOS Safari
// auto-zoom on focus (audit M2).

export const fieldClass =
  'w-full px-4 py-3 rounded-xl border border-[#97B3AE]/30 bg-white text-base text-[#2a2a2a] ' +
  'placeholder:text-[#9a948a] focus:outline-none focus:border-[#97B3AE] focus:ring-2 ' +
  'focus:ring-[#97B3AE]/30 transition';

export const textareaClass = `${fieldClass} resize-y min-h-[64px]`;

export const labelClass = 'block text-sm font-medium text-[#2a2a2a] mb-1.5';

export const errorBannerClass =
  'rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700';

export const infoBannerClass =
  'rounded-xl border border-[#97B3AE]/20 bg-[#F0EEEA] p-4 text-sm text-[#6a6a6a]';

export const primaryButtonClass =
  'px-8 py-3 bg-[#97B3AE] text-white rounded-full font-medium shadow-lg ' +
  'hover:bg-[#7e9b96] disabled:opacity-50 disabled:cursor-not-allowed transition';

export const ghostButtonClass =
  'px-6 py-3 text-[#6a6a6a] font-medium rounded-full hover:text-[#2a2a2a] ' +
  'disabled:opacity-50 transition';

// Brand hover/tap for motion.button / motion.a CTAs.
export const buttonMotion = {
  whileHover: { scale: 1.05, y: -2 },
  whileTap: { scale: 0.98 },
} as const;
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no references yet; file compiles).

- [ ] **Step 3: Commit**

```bash
git add src/app/onboarding/_shared/field-styles.ts
git commit -m "feat(onboarding): shared branded form-control styles for funnel"
```

---

## Task 2: `FunnelStepThread` component (TDD)

**Files:**
- Create: `src/app/onboarding/_shared/FunnelStepThread.tsx`
- Test: `src/app/onboarding/_shared/__tests__/FunnelStepThread.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/app/onboarding/_shared/__tests__/FunnelStepThread.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FunnelStepThread } from '../FunnelStepThread';

describe('FunnelStepThread', () => {
  it('marks exactly one milestone with aria-current="step" and shows its number', () => {
    const { container } = render(<FunnelStepThread step="plan" />);
    const current = container.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('3'); // Plan is the 3rd milestone
  });

  it('renders earlier milestones as done (✓) and keeps later ones numbered', () => {
    const { queryAllByText, getByText } = render(<FunnelStepThread step="plan" />);
    expect(queryAllByText('✓')).toHaveLength(2); // Find business + Preview
    expect(getByText('4')).toBeInTheDocument(); // Set up still numbered (todo)
    expect(getByText('Set up')).toBeInTheDocument();
  });

  it('marks the first milestone current and shows no checks when step="find"', () => {
    const { container, queryAllByText } = render(<FunnelStepThread step="find" />);
    const current = container.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('1');
    expect(queryAllByText('✓')).toHaveLength(0);
  });

  it('marks every prior milestone done when step="setup"', () => {
    const { queryAllByText } = render(<FunnelStepThread step="setup" />);
    expect(queryAllByText('✓')).toHaveLength(3); // Find + Preview + Plan
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/app/onboarding/_shared/__tests__/FunnelStepThread.test.tsx`
Expected: FAIL — `Failed to resolve import "../FunnelStepThread"`.

- [ ] **Step 3: Implement the component**

Create `src/app/onboarding/_shared/FunnelStepThread.tsx`:

```tsx
'use client';

export type FunnelStep = 'find' | 'preview' | 'plan' | 'setup';

const MILESTONES: { key: FunnelStep; label: string }[] = [
  { key: 'find', label: 'Find business' },
  { key: 'preview', label: 'Preview' },
  { key: 'plan', label: 'Plan' },
  { key: 'setup', label: 'Set up' },
];

export function FunnelStepThread({ step }: { step: FunnelStep }) {
  const currentIndex = MILESTONES.findIndex((m) => m.key === step);

  return (
    <ol
      className="flex items-start justify-center gap-1 mb-2"
      aria-label="Onboarding progress"
    >
      {MILESTONES.map((m, i) => {
        const state =
          i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'todo';
        return (
          <li key={m.key} className="flex items-start gap-1">
            <div className="flex flex-col items-center gap-1.5 min-w-[58px]">
              <span
                aria-current={state === 'current' ? 'step' : undefined}
                className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-medium ${
                  state === 'todo'
                    ? 'bg-[#e3ddd3] text-[#9a948a]'
                    : state === 'current'
                      ? 'bg-[#97B3AE] text-white ring-4 ring-[#97B3AE]/25'
                      : 'bg-[#97B3AE] text-white'
                }`}
              >
                {state === 'done' ? '✓' : i + 1}
              </span>
              <span
                className={`text-[11px] text-center leading-tight ${
                  state === 'current'
                    ? 'font-medium text-[#2a2a2a]'
                    : 'text-[#6a6a6a]'
                }`}
              >
                {m.label}
              </span>
            </div>
            {i < MILESTONES.length - 1 && (
              <span
                className={`h-px w-5 sm:w-8 mt-3.5 ${
                  i < currentIndex ? 'bg-[#97B3AE]' : 'bg-[#cdd9ce]'
                }`}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/app/onboarding/_shared/__tests__/FunnelStepThread.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/onboarding/_shared/FunnelStepThread.tsx src/app/onboarding/_shared/__tests__/FunnelStepThread.test.tsx
git commit -m "feat(onboarding): FunnelStepThread milestone progress component"
```

---

## Task 3: `OnboardingFunnelShell` component (TDD)

**Files:**
- Create: `src/app/onboarding/_shared/OnboardingFunnelShell.tsx`
- Test: `src/app/onboarding/_shared/__tests__/OnboardingFunnelShell.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/app/onboarding/_shared/__tests__/OnboardingFunnelShell.test.tsx`:

```tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { OnboardingFunnelShell } from '../OnboardingFunnelShell';

describe('OnboardingFunnelShell', () => {
  it('renders children and the RepWorth wordmark', () => {
    render(
      <OnboardingFunnelShell step="find">
        <p>hello funnel</p>
      </OnboardingFunnelShell>,
    );
    expect(screen.getByText('hello funnel')).toBeInTheDocument();
    expect(screen.getByText('RepWorth')).toBeInTheDocument();
  });

  it('shows the step thread when a step is provided', () => {
    render(
      <OnboardingFunnelShell step="plan">
        <p>x</p>
      </OnboardingFunnelShell>,
    );
    expect(
      screen.getByRole('list', { name: 'Onboarding progress' }),
    ).toBeInTheDocument();
  });

  it('hides the thread when showThread is false', () => {
    render(
      <OnboardingFunnelShell step="setup" showThread={false}>
        <p>x</p>
      </OnboardingFunnelShell>,
    );
    expect(
      screen.queryByRole('list', { name: 'Onboarding progress' }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/app/onboarding/_shared/__tests__/OnboardingFunnelShell.test.tsx`
Expected: FAIL — cannot resolve `../OnboardingFunnelShell`.

- [ ] **Step 3: Implement the component**

Create `src/app/onboarding/_shared/OnboardingFunnelShell.tsx`:

```tsx
'use client';

import type { ReactNode } from 'react';
import { motion } from 'motion/react';

import { FunnelStepThread, type FunnelStep } from './FunnelStepThread';

interface OnboardingFunnelShellProps {
  /** Current top-level milestone. Drives the step thread. */
  step?: FunnelStep;
  /** Default true; only the legacy (admin-created) wizard passes false. */
  showThread?: boolean;
  /** '2xl' for forms (default); '6xl' for the plan picker grid. */
  maxWidth?: '2xl' | '6xl';
  children: ReactNode;
}

const MAX_WIDTH: Record<'2xl' | '6xl', string> = {
  '2xl': 'max-w-2xl',
  '6xl': 'max-w-6xl',
};

// Static brand atmosphere — funnel pages are short centered forms that don't
// scroll, so (unlike PageShell) there is no scroll-parallax coupling.
const ATMOSPHERE = [
  { className: 'absolute top-24 left-8 w-56 h-72', dots: 5 },
  { className: 'absolute top-[42%] right-12 w-64 h-56', dots: 4 },
  { className: 'absolute bottom-28 left-[12%] w-52 h-64', dots: 5 },
  { className: 'absolute bottom-12 right-[8%] w-56 h-48', dots: 5 },
];

export function OnboardingFunnelShell({
  step,
  showThread = true,
  maxWidth = '2xl',
  children,
}: OnboardingFunnelShellProps) {
  return (
    <div className="min-h-screen bg-[#D2E0D3] relative">
      <div className="fixed inset-0 pointer-events-none" aria-hidden="true">
        {ATMOSPHERE.map((card, i) => (
          <div
            key={i}
            className={`${card.className} bg-white/40 backdrop-blur-md rounded-3xl shadow-xl p-6 border border-white/60`}
          >
            <div className="flex gap-1 mb-3">
              {Array.from({ length: card.dots }).map((_, j) => (
                <div key={j} className="w-4 h-4 bg-[#F2C3B9]/60 rounded-full" />
              ))}
            </div>
            <div className="space-y-2">
              <div className="h-3 bg-[#2a2a2a]/20 rounded w-full" />
              <div className="h-3 bg-[#2a2a2a]/20 rounded w-5/6" />
              <div className="h-3 bg-[#2a2a2a]/20 rounded w-4/6" />
            </div>
          </div>
        ))}
      </div>

      <div className="relative z-10 min-h-screen py-12 sm:py-20 px-4 flex items-center justify-center">
        <motion.div
          className={`w-full ${MAX_WIDTH[maxWidth]} bg-white rounded-[3rem] shadow-2xl`}
          initial={{ opacity: 0, y: 40, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
        >
          <nav className="px-6 sm:px-8 py-4 border-b border-[#97B3AE]/10 flex items-center justify-end">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80" />
              <span className="text-sm tracking-wider uppercase text-[#97B3AE]">
                RepWorth
              </span>
            </div>
          </nav>

          {showThread && step && (
            <div className="px-4 sm:px-8 pt-6">
              <FunnelStepThread step={step} />
            </div>
          )}

          <div className="px-6 sm:px-10 py-8 sm:py-10">{children}</div>
        </motion.div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/app/onboarding/_shared/__tests__/OnboardingFunnelShell.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/onboarding/_shared/OnboardingFunnelShell.tsx src/app/onboarding/_shared/__tests__/OnboardingFunnelShell.test.tsx
git commit -m "feat(onboarding): OnboardingFunnelShell island wrapper"
```

---

## Task 4: Reteal `ProgressDots` (colors only)

**Files:**
- Modify: `src/app/onboarding/business/ProgressDots.tsx`

Behavior and API unchanged — swap blue/gray tokens for brand tokens. There is no existing test for this file; verification is typecheck + the wizard render later.

- [ ] **Step 1: Replace the `return` block**

Replace the entire `return (...)` in `ProgressDots.tsx` (currently lines 32-65) with:

```tsx
  return (
    <div className="flex items-center justify-center gap-2 mb-8">
      {visible.map((s, i) => (
        <div key={s.n} className="flex items-center gap-2">
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-medium ${
              s.n < current
                ? 'bg-[#97B3AE] text-white'
                : s.n === current
                  ? 'bg-[#97B3AE] text-white ring-4 ring-[#97B3AE]/25'
                  : 'bg-[#e3ddd3] text-[#9a948a]'
            }`}
            aria-current={s.n === current ? 'step' : undefined}
          >
            {s.n < current ? '✓' : s.n}
          </div>
          <span
            className={`text-sm ${
              s.n === current ? 'font-medium text-[#2a2a2a]' : 'text-[#9a948a]'
            }`}
          >
            {s.label}
          </span>
          {i < visible.length - 1 && (
            <div
              className={`mx-2 h-px w-8 ${
                s.n < current ? 'bg-[#97B3AE]' : 'bg-[#cdd9ce]'
              }`}
            />
          )}
        </div>
      ))}
    </div>
  );
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/onboarding/business/ProgressDots.tsx
git commit -m "style(onboarding): reteal ProgressDots to brand palette"
```

---

## Task 5: Brand the `start` page (`StartLocationClient`)

**Files:**
- Modify: `src/app/onboarding/start/StartLocationClient.tsx`

All hooks/handlers (`triggerPrefill`, `cancelPrefill`, `submit`, `canSubmit`) and the two helper functions at the bottom of the file stay unchanged. Change only imports + the `return` block.

- [ ] **Step 1: Add imports**

After the existing `import { PlaceAutocomplete } ...` line (line 5), add:

```tsx
import { motion } from 'motion/react';
import { OnboardingFunnelShell } from '../_shared/OnboardingFunnelShell';
import {
  fieldClass,
  labelClass,
  errorBannerClass,
  primaryButtonClass,
  buttonMotion,
} from '../_shared/field-styles';
```

- [ ] **Step 2: Replace the `return` block**

Replace the entire `return (...)` (currently lines 95-174) with:

```tsx
  return (
    <OnboardingFunnelShell step="find">
      <h1 className="text-3xl md:text-4xl font-medium text-center text-[#2a2a2a] mb-2">
        Find your business
      </h1>
      <p className="text-center text-[#6a6a6a] mb-8">
        We&apos;ll generate a live demo of AI responses for your actual reviews.
      </p>

      {error && <div className={`${errorBannerClass} mb-4`}>{error}</div>}

      <div className="space-y-4">
        <div>
          <label htmlFor="biz-name-start" className={labelClass}>
            Business name
          </label>
          <input
            id="biz-name-start"
            type="text"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="Your business name"
            className={fieldClass}
            maxLength={80}
          />
        </div>

        {inputMode === 'autocomplete' ? (
          <PlaceAutocomplete
            onPlaceSelect={(sel) => {
              setGooglePlaceId(sel.placeId);
              setGooglePlaceAddress(sel.formattedAddress);
              triggerPrefill(sel.placeId);
            }}
            onClear={() => {
              cancelPrefill();
              setGooglePlaceId('');
              setGooglePlaceAddress('');
            }}
          />
        ) : (
          <input
            type="text"
            value={googleMapsUrl}
            onChange={(e) => setGoogleMapsUrl(e.target.value)}
            placeholder="https://maps.google.com/..."
            className={fieldClass}
          />
        )}

        <button
          type="button"
          onClick={() => {
            cancelPrefill();
            if (inputMode === 'autocomplete') {
              setGooglePlaceId('');
              setGooglePlaceAddress('');
              setInputMode('url');
            } else {
              setGoogleMapsUrl('');
              setInputMode('autocomplete');
            }
          }}
          className="text-xs text-[#97B3AE] hover:text-[#7e9b96]"
        >
          {inputMode === 'autocomplete'
            ? 'Or paste a Google Maps URL'
            : 'Use search instead'}
        </button>

        <div className="flex justify-end pt-4">
          <motion.button
            type="button"
            onClick={submit}
            disabled={!canSubmit || submitting}
            {...buttonMotion}
            className={primaryButtonClass}
          >
            {submitting ? 'Generating demo...' : 'Generate my demo'}
          </motion.button>
        </div>
      </div>
    </OnboardingFunnelShell>
  );
```

- [ ] **Step 3: Typecheck + existing guard test**

Run: `pnpm typecheck && pnpm exec vitest run src/app/onboarding/start`
Expected: PASS (typecheck clean; 2 guard tests pass — they mock this client so they are unaffected).

- [ ] **Step 4: Commit**

```bash
git add src/app/onboarding/start/StartLocationClient.tsx
git commit -m "style(onboarding): brand the start page into the funnel island"
```

---

## Task 6: Brand the `business` wizard (4 Step components + `BusinessWizardClient`)

**Files:**
- Modify: `src/app/onboarding/business/StepLocation.tsx`
- Modify: `src/app/onboarding/business/StepProfile.tsx`
- Modify: `src/app/onboarding/business/StepVoice.tsx`
- Modify: `src/app/onboarding/business/StepConnect.tsx`
- Modify: `src/app/onboarding/business/BusinessWizardClient.tsx`

Each step currently wraps itself in `bg-white rounded-lg border border-gray-200 p-6` — that becomes a card-on-white once inside the island, so the outer wrapper flattens to `space-y-4` / `space-y-5`. All prefill logic, dirty-ref handling, and handlers stay unchanged.

- [ ] **Step 1: `StepProfile` — imports + return**

In `StepProfile.tsx`, add after the existing `import type { WizardFormData }` line:

```tsx
import { motion } from 'motion/react';
import {
  fieldClass,
  labelClass,
  primaryButtonClass,
  ghostButtonClass,
  buttonMotion,
} from '../_shared/field-styles';
```

Delete the local `const inputClass = ...` (lines 21-22). Replace the `return (...)` block with:

```tsx
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-medium text-[#2a2a2a]">Business profile</h2>
      <p className="text-sm text-[#6a6a6a]">
        We may have pre-filled some of these from Google Maps — feel free to
        edit.
      </p>

      <div>
        <label htmlFor="biz-name" className={labelClass}>
          Business name <span className="text-red-500">*</span>
        </label>
        <input
          id="biz-name"
          type="text"
          required
          autoComplete="organization"
          value={data.businessName}
          onChange={(e) => update({ businessName: e.target.value })}
          placeholder="Bella Vista Restaurant"
          className={fieldClass}
        />
      </div>

      <div>
        <label htmlFor="biz-category" className={labelClass}>
          Category
        </label>
        <input
          id="biz-category"
          type="text"
          value={data.category}
          onChange={(e) => {
            if (dirtyRef.current) dirtyRef.current.category = true;
            update({ category: e.target.value });
          }}
          placeholder="Restaurant, Salon, Dentist…"
          className={fieldClass}
        />
      </div>

      <div>
        <label htmlFor="biz-website" className={labelClass}>
          Website
        </label>
        <input
          id="biz-website"
          type="url"
          value={data.website}
          onChange={(e) => {
            if (dirtyRef.current) dirtyRef.current.website = true;
            update({ website: e.target.value });
          }}
          placeholder="https://yourbusiness.com"
          className={fieldClass}
        />
      </div>

      <div className="flex justify-between items-center pt-4">
        <button type="button" onClick={onBack} className={ghostButtonClass}>
          ← Back
        </button>
        <motion.button
          type="button"
          onClick={onNext}
          disabled={!canContinue}
          {...buttonMotion}
          className={primaryButtonClass}
        >
          Continue →
        </motion.button>
      </div>
    </div>
  );
```

- [ ] **Step 2: `StepVoice` — imports + return**

In `StepVoice.tsx`, add after `import type { WizardFormData }`:

```tsx
import { motion } from 'motion/react';
import {
  fieldClass,
  textareaClass,
  labelClass,
  primaryButtonClass,
  ghostButtonClass,
  buttonMotion,
} from '../_shared/field-styles';
```

Delete the local `const inputClass = ...` and `const textareaClass = ...` (lines 22-24). Replace the `return (...)` block with:

```tsx
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-medium text-[#2a2a2a]">Voice &amp; context</h2>
          <p className="text-sm text-[#6a6a6a]">
            Help us write responses that sound like you. All optional — you can
            set this up later in Settings.
          </p>
        </div>
        <button
          type="button"
          onClick={onSkip}
          disabled={submitting}
          className="text-sm text-[#97B3AE] hover:text-[#7e9b96] underline whitespace-nowrap disabled:opacity-50"
        >
          Skip for now
        </button>
      </div>

      <div>
        <label htmlFor="biz-tone" className={labelClass}>Tone</label>
        <input
          id="biz-tone"
          type="text"
          value={data.tone}
          onChange={(e) => update({ tone: e.target.value })}
          className={fieldClass}
        />
      </div>

      <div>
        <label htmlFor="biz-products" className={labelClass}>Products / services</label>
        <textarea
          id="biz-products"
          value={data.productsServices}
          onChange={(e) => update({ productsServices: e.target.value })}
          placeholder="Pizza, pasta, weekend brunch…"
          rows={2}
          className={textareaClass}
        />
      </div>

      <div>
        <label htmlFor="biz-staff" className={labelClass}>Staff names</label>
        <textarea
          id="biz-staff"
          value={data.staffNames}
          onChange={(e) => update({ staffNames: e.target.value })}
          placeholder="One per line, or comma-separated"
          rows={2}
          className={textareaClass}
        />
      </div>

      <div>
        <label htmlFor="biz-highlight" className={labelClass}>Highlight facts</label>
        <textarea
          id="biz-highlight"
          value={data.highlightFacts}
          onChange={(e) => update({ highlightFacts: e.target.value })}
          placeholder="e.g. opened 2010, family-owned, locally-sourced"
          rows={2}
          className={textareaClass}
        />
      </div>

      <div>
        <label htmlFor="biz-avoid" className={labelClass}>Avoid facts</label>
        <textarea
          id="biz-avoid"
          value={data.avoidFacts}
          onChange={(e) => update({ avoidFacts: e.target.value })}
          placeholder="Things responses should NOT mention"
          rows={2}
          className={textareaClass}
        />
      </div>

      <div>
        <label htmlFor="biz-samples" className={labelClass}>Sample responses</label>
        <textarea
          id="biz-samples"
          value={data.sampleResponses}
          onChange={(e) => update({ sampleResponses: e.target.value })}
          placeholder="Paste 1-2 previous replies that sound like you (separate with a blank line)"
          rows={3}
          className={textareaClass}
        />
      </div>

      <div className="flex justify-between items-center pt-4">
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className={ghostButtonClass}
        >
          ← Back
        </button>
        <motion.button
          type="button"
          onClick={onSubmit}
          disabled={submitting}
          {...buttonMotion}
          className={primaryButtonClass}
        >
          {submitting ? 'Setting up…' : 'Finish setup'}
        </motion.button>
      </div>
    </div>
  );
```

- [ ] **Step 3: `StepConnect` — imports + return**

In `StepConnect.tsx`, add after `import { useState } from 'react';`:

```tsx
import { motion } from 'motion/react';
import {
  errorBannerClass,
  primaryButtonClass,
  ghostButtonClass,
  buttonMotion,
} from '../_shared/field-styles';
```

Replace the `return (...)` block with (note: green checks → teal, gray card → flat, blue CTA → teal motion button):

```tsx
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-medium text-[#2a2a2a]">
          Connect your Google Business Profile
        </h2>
        <p className="mt-1 text-sm text-[#6a6a6a]">
          We use Zernio to securely read your reviews and post your approved
          replies on Google. You&apos;ll be redirected to Google to grant
          access — only you ever see review content, and we never auto-post
          without your explicit approval.
        </p>
      </div>

      <ul className="space-y-2 text-sm text-[#6a6a6a]">
        <li className="flex items-start gap-2">
          <span className="text-[#97B3AE] mt-0.5">✓</span>
          <span>Pulls in every review on the location you pick.</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="text-[#97B3AE] mt-0.5">✓</span>
          <span>Drafts a reply for each new review using your voice.</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="text-[#97B3AE] mt-0.5">✓</span>
          <span>You approve each reply before it goes live.</span>
        </li>
      </ul>

      {error && <div className={errorBannerClass}>{error}</div>}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2">
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className={ghostButtonClass}
        >
          ← Back
        </button>

        <div className="flex flex-col sm:flex-row gap-3">
          <button
            type="button"
            onClick={handleSkip}
            disabled={submitting}
            className={ghostButtonClass}
          >
            Skip for now
          </button>
          <motion.button
            type="button"
            onClick={handleConnect}
            disabled={submitting}
            {...buttonMotion}
            className={primaryButtonClass}
          >
            {submitting ? 'Connecting…' : 'Connect Google Business Profile'}
          </motion.button>
        </div>
      </div>
    </div>
  );
```

- [ ] **Step 4: `StepLocation` — imports + return**

In `StepLocation.tsx`, add after `import { PlaceAutocomplete } ...`:

```tsx
import { motion } from 'motion/react';
import {
  fieldClass,
  primaryButtonClass,
  buttonMotion,
} from '../_shared/field-styles';
```

Replace the `return (...)` block (currently lines 153-230) with (flatten card, brand inputs/links/button; all prefill handlers in the JSX stay identical):

```tsx
  return (
    <div className="space-y-4">
      <h2 className="text-xl font-medium text-[#2a2a2a]">Find your business</h2>
      <p className="text-sm text-[#6a6a6a]">
        Search Google Maps for your business or paste its Google Maps URL.
      </p>

      {data.inputMode === 'autocomplete' ? (
        <PlaceAutocomplete
          onPlaceSelect={(sel) => {
            update({
              googlePlaceId: sel.placeId,
              googlePlaceAddress: sel.formattedAddress,
            });
            triggerPrefill(sel.placeId);
          }}
          onClear={() => {
            cancelPrefill();
            update({ googlePlaceId: '', googlePlaceAddress: '' });
            const reset: Partial<WizardFormData> = {};
            if (!dirtyRef.current?.category) reset.category = '';
            if (!dirtyRef.current?.website) reset.website = '';
            if (Object.keys(reset).length > 0) update(reset);
          }}
        />
      ) : (
        <input
          type="text"
          value={data.googleMapsUrl}
          onChange={(e) => update({ googleMapsUrl: e.target.value })}
          placeholder="https://maps.google.com/..."
          className={fieldClass}
          autoComplete="url"
        />
      )}

      <button
        type="button"
        onClick={() => {
          if (data.inputMode === 'autocomplete') {
            cancelPrefill();
            update({
              inputMode: 'url',
              googlePlaceId: '',
              googlePlaceAddress: '',
            });
          } else {
            update({ inputMode: 'autocomplete', googleMapsUrl: '' });
          }
        }}
        className="text-xs text-[#97B3AE] hover:text-[#7e9b96]"
      >
        {data.inputMode === 'autocomplete'
          ? 'Or paste a Google Maps URL'
          : 'Use search instead'}
      </button>

      {prefilling && (
        <p className="text-xs text-[#9a948a]">
          Fetching business details from Google Maps…
        </p>
      )}

      <div className="flex justify-end pt-4">
        <motion.button
          type="button"
          onClick={onNext}
          disabled={!canContinue}
          {...buttonMotion}
          className={primaryButtonClass}
        >
          Continue →
        </motion.button>
      </div>
    </div>
  );
```

- [ ] **Step 5: `BusinessWizardClient` — imports + return wrapper**

In `BusinessWizardClient.tsx`, add after the existing `import { buildBusinessWizardPayload } from './payload';` line:

```tsx
import { OnboardingFunnelShell } from '../_shared/OnboardingFunnelShell';
import { errorBannerClass } from '../_shared/field-styles';
```

Replace the `return (...)` block (currently lines 178-265) with (wrap in shell; the demo/legacy step-switching is identical, only the surrounding chrome changes):

```tsx
  return (
    <OnboardingFunnelShell step="setup" showThread={demoFlowEnabled}>
      {demoFlowEnabled && (
        <p className="text-center text-[#97B3AE] text-sm mb-2">
          You&apos;re in. A few quick steps to make responses sound like you and
          connect your reviews, then we go live.
        </p>
      )}
      <h1 className="text-3xl md:text-4xl font-medium text-center text-[#2a2a2a] mb-2">
        Set up your business
      </h1>
      <p className="text-center text-[#6a6a6a] mb-8">
        A few quick details so we can start fetching your reviews.
      </p>

      <ProgressDots current={step} total={totalSteps} demoFlow={demoFlowEnabled} />

      {error && <div className={`${errorBannerClass} mb-4`}>{error}</div>}

      {demoFlowEnabled ? (
        <>
          {step === 1 && (
            <StepProfile
              data={data}
              update={update}
              dirtyRef={dirtyRef}
              onBack={() => {
                /* no back from first step */
              }}
              onNext={() => setStep(2)}
            />
          )}
          {step === 2 && (
            <StepVoice
              data={data}
              update={update}
              onBack={() => setStep(1)}
              onSubmit={() => advanceToConnect()}
              onSkip={() => advanceToConnect({ skipVoice: true })}
              submitting={submitting}
            />
          )}
          {step === 3 && (
            <StepConnect
              onBack={() => setStep(2)}
              onConnect={handleConnectZernio}
              onSkip={handleSkipConnect}
              submitting={submitting}
            />
          )}
        </>
      ) : (
        <>
          {step === 1 && (
            <StepLocation
              data={data}
              update={update}
              dirtyRef={dirtyRef}
              onNext={() => setStep(2)}
            />
          )}
          {step === 2 && (
            <StepProfile
              data={data}
              update={update}
              dirtyRef={dirtyRef}
              onBack={() => setStep(1)}
              onNext={() => setStep(3)}
            />
          )}
          {step === 3 && (
            <StepVoice
              data={data}
              update={update}
              onBack={() => setStep(2)}
              onSubmit={() => legacySubmit()}
              onSkip={() => legacySubmit({ skipVoice: true })}
              submitting={submitting}
            />
          )}
        </>
      )}
    </OnboardingFunnelShell>
  );
```

- [ ] **Step 6: Typecheck + existing tests**

Run: `pnpm typecheck && pnpm exec vitest run src/app/onboarding/business`
Expected: PASS (typecheck clean; `guard.test.ts` + `payload.test.ts` unaffected — they test pure functions, not rendering).

- [ ] **Step 7: Commit**

```bash
git add src/app/onboarding/business/StepLocation.tsx src/app/onboarding/business/StepProfile.tsx src/app/onboarding/business/StepVoice.tsx src/app/onboarding/business/StepConnect.tsx src/app/onboarding/business/BusinessWizardClient.tsx
git commit -m "style(onboarding): brand the business wizard into the funnel island"
```

---

## Task 7: Brand the `demo` paywall (`PaywallWithDemoClient`)

**Files:**
- Modify: `src/app/onboarding/demo/PaywallWithDemoClient.tsx`

All polling/regenerate logic (`poll`, the two `useEffect`s, `handleRegenerate`, the derived `isLoading`/`isFailed`/… booleans, and JSONB-guard parsing) stays unchanged. Change imports, the main `return`, and the `Stars` + `ReviewCard` helpers. Removes amber banner (`:103`), yellow stars (`:231`), blue spinner (`:116`), blue AI box (`:267`).

- [ ] **Step 1: Add imports**

After `import type { GenerationResult } from '@/lib/responses/types';` add:

```tsx
import { motion } from 'motion/react';
import { OnboardingFunnelShell } from '../_shared/OnboardingFunnelShell';
import { infoBannerClass, primaryButtonClass, buttonMotion } from '../_shared/field-styles';
```

- [ ] **Step 2: Replace the main `return` block**

Replace the entire `return (...)` (currently lines 92-204) with:

```tsx
  return (
    <OnboardingFunnelShell step="preview">
      <h1 className="text-3xl md:text-4xl font-medium text-center text-[#2a2a2a] mb-2">
        Your AI-powered review responses
      </h1>
      <p className="text-center text-[#6a6a6a] mb-8">
        Here&apos;s what RepWorth would write for {demo.business_name}
      </p>

      {isFallback && (
        <div className={`${infoBannerClass} mb-6`}>
          Sample reviews shown — connect your account after signup to see your
          real ones.
        </div>
      )}

      {isStale && isCompleted && demo.completed_at && (
        <div className="bg-[#F0EEEA] rounded-xl p-3 mb-6 text-sm text-[#6a6a6a] text-center">
          Last updated{' '}
          {Math.floor(
            (Date.now() - new Date(demo.completed_at).getTime()) /
              (24 * 60 * 60 * 1000),
          )}{' '}
          days ago
        </div>
      )}

      {isLoading && (
        <div className="text-center py-12">
          <div className="inline-block w-12 h-12 border-4 border-[#97B3AE]/25 border-t-[#97B3AE] rounded-full animate-spin mb-6" />
          <p className="text-[#6a6a6a]">Generating your demo...</p>
          {pollCount >= MAX_POLLS && (
            <p className="text-sm text-[#9a948a] mt-2">
              Still working — refresh in a minute.
            </p>
          )}
        </div>
      )}

      {(isFailed || isSkipped) && (
        <div className="space-y-6">
          <div className="text-center py-8">
            {isFailed ? (
              <>
                <div
                  className="w-12 h-12 mx-auto mb-4 rounded-full bg-[#F2C3B9]/40 flex items-center justify-center"
                  role="img"
                  aria-label="warning"
                >
                  <svg
                    className="w-6 h-6 text-[#2a2a2a]"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 9v4m0 4h.01M10.29 3.86l-8.48 14.7A1 1 0 002.67 20h18.66a1 1 0 00.86-1.44l-8.48-14.7a1 1 0 00-1.74 0z"
                    />
                  </svg>
                </div>
                <p className="text-[#6a6a6a] mb-4">
                  We couldn&apos;t generate a sample demo this time.
                </p>
                <button
                  onClick={handleRegenerate}
                  className="bg-white border border-[#97B3AE]/30 text-[#2a2a2a] font-medium py-2 px-6 rounded-full hover:bg-[#F0EEEA] mb-2 transition"
                >
                  Try the demo again
                </button>
              </>
            ) : (
              <p className="text-[#6a6a6a]">
                Your live demo is on the way after signup — for now, you can
                still subscribe.
              </p>
            )}
          </div>

          {/* Paywall stays available even when the demo isn't — never block payment on a transient generation issue. */}
          <div className="bg-[#F0EEEA] rounded-2xl border border-[#97B3AE]/15 p-6 sm:p-8 text-center">
            <h2 className="text-xl font-medium text-[#2a2a2a] mb-2">
              Choose your RepWorth plan
            </h2>
            <p className="text-[#6a6a6a] mb-6 max-w-md mx-auto">
              Subscribe to start automatically generating responses for every
              review.
            </p>
            <motion.a
              href="/onboarding/pay"
              onClick={() => {
                void captureDemoToSignup();
              }}
              {...buttonMotion}
              className={`inline-block ${primaryButtonClass}`}
            >
              Choose a plan →
            </motion.a>
          </div>
        </div>
      )}

      {isCompleted && (
        <div className="space-y-6">
          {reviews.map((review, index) => (
            <ReviewCard
              key={index}
              review={review}
              response={responses[index] ?? null}
            />
          ))}

          <div className="bg-[#F0EEEA] rounded-2xl border border-[#97B3AE]/15 p-6 sm:p-8 text-center mt-8">
            <h2 className="text-xl font-medium text-[#2a2a2a] mb-2">
              Want this for every review?
            </h2>
            <p className="text-[#6a6a6a] mb-6 max-w-md mx-auto">
              Subscribe to RepWorth and we&apos;ll automatically generate
              responses for all your reviews.
            </p>
            <motion.a
              href="/onboarding/pay"
              onClick={() => {
                void captureDemoToSignup();
              }}
              {...buttonMotion}
              className={`inline-block ${primaryButtonClass}`}
            >
              Choose a plan →
            </motion.a>
          </div>

          <div className="text-center">
            <button
              onClick={handleRegenerate}
              className="text-sm text-[#97B3AE] hover:text-[#7e9b96] underline"
            >
              Regenerate demo
            </button>
          </div>
        </div>
      )}
    </OnboardingFunnelShell>
  );
```

- [ ] **Step 3: Replace the `Stars` helper (teal stars)**

Replace the `Stars` function (currently lines 227-237) with:

```tsx
function Stars({ rating }: { rating: number }) {
  return (
    <span className="inline-flex gap-0.5" aria-label={`${rating} out of 5 stars`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={i < rating ? 'text-[#97B3AE]' : 'text-[#cdd9ce]'}>
          ★
        </span>
      ))}
    </span>
  );
}
```

- [ ] **Step 4: Replace the `ReviewCard` helper (branded card + AI box)**

Replace the `ReviewCard` function (currently lines 239-274) with:

```tsx
function ReviewCard({
  review,
  response,
}: {
  review: NormalizedReview;
  response: GenerationResult | null;
}) {
  const formattedDate = new Date(review.reviewDate).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <div className="bg-white rounded-2xl border border-[#97B3AE]/15 shadow-sm overflow-hidden">
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between mb-2">
          <div>
            <span className="font-semibold text-[#2a2a2a]">
              {review.reviewerName}
            </span>
            <span className="text-sm text-[#9a948a] ml-2">{formattedDate}</span>
          </div>
        </div>
        <Stars rating={review.starRating} />
        {review.reviewText ? (
          <p className="mt-2 text-[#6a6a6a] text-sm leading-relaxed">
            {review.reviewText}
          </p>
        ) : (
          <p className="mt-2 text-[#9a948a] text-sm italic">
            Rating only — no written review
          </p>
        )}
      </div>
      {response && (
        <div className="bg-[#F0EEEA] border-t border-[#97B3AE]/15 p-4 sm:p-5">
          <p className="text-xs font-semibold text-[#97B3AE] uppercase tracking-wider mb-2">
            RepWorth draft response
          </p>
          <p className="text-[#6a6a6a] text-sm leading-relaxed">
            {response.responseText}
          </p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Typecheck + existing guard test**

Run: `pnpm typecheck && pnpm exec vitest run src/app/onboarding/demo`
Expected: PASS (typecheck clean; 2 guard tests mock this client, unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/app/onboarding/demo/PaywallWithDemoClient.tsx
git commit -m "style(onboarding): brand the demo paywall, teal stars, drop amber/blue"
```

---

## Task 8: Brand the `pay` page (`pay/page.tsx` + `PlanPickerClient`)

**Files:**
- Modify: `src/app/onboarding/pay/page.tsx`
- Modify: `src/app/onboarding/pay/PlanPickerClient.tsx`

`PlanPickerClient` is already mostly teal. Changes: drop its own `max-w-6xl` (the shell owns width now), fix the lone `text-amber-700`, wrap plan CTAs in `motion.button`, add per-card horizontal breathing room. The existing `PlanPickerClient.test.tsx` asserts on headings/prices/button-name/`role="alert"` — all preserved.

- [ ] **Step 1: `pay/page.tsx` — wrap in shell**

Add this import after `import { PlanPickerClient } from './PlanPickerClient';`:

```tsx
import { OnboardingFunnelShell } from '../_shared/OnboardingFunnelShell';
```

Replace the final `return (...)` (currently lines 87-91) with:

```tsx
  return (
    <OnboardingFunnelShell step="plan" maxWidth="6xl">
      <PlanPickerClient cancelled={Boolean(cancelled)} />
    </OnboardingFunnelShell>
  );
```

- [ ] **Step 2: `PlanPickerClient` — imports**

After `import { useState } from 'react';` add:

```tsx
import { motion } from 'motion/react';
import { buttonMotion } from '../_shared/field-styles';
```

- [ ] **Step 3: `PlanPickerClient` — fix outer wrapper + amber line**

Change the opening wrapper (line 58) from:

```tsx
    <div className="w-full max-w-6xl">
```
to:
```tsx
    <div className="w-full">
```

Change the cancelled notice (lines 59-63) from `text-amber-700` to brand body color:

```tsx
      {cancelled && (
        <p className="text-sm text-[#6a6a6a] mb-4 text-center">
          No worries — pick a plan when you&apos;re ready.
        </p>
      )}
```

- [ ] **Step 4: `PlanPickerClient` — card padding + motion CTA**

Change the card wrapper `className` (line 78) to add mobile horizontal margin so cards don't hug the screen edge (audit M11) — replace:

```tsx
              className={`relative rounded-2xl p-7 border shadow-lg flex flex-col bg-white ${
```
with:
```tsx
              className={`relative rounded-2xl p-7 mx-1 sm:mx-0 border shadow-lg flex flex-col bg-white ${
```

Convert the plan CTA `<button>` (lines 102-113) to a `motion.button`:

```tsx
              <motion.button
                type="button"
                onClick={() => handlePick(plan.tier)}
                disabled={isLoading || isOtherLoading}
                {...buttonMotion}
                className={`block w-full text-center py-3 rounded-full font-medium text-sm mb-6 transition disabled:opacity-50 disabled:cursor-not-allowed ${
                  plan.highlight
                    ? 'bg-[#97B3AE] text-white shadow-lg hover:bg-[#7e9b96]'
                    : 'bg-[#F0EEEA] text-[#2a2a2a] border border-[#97B3AE]/10 hover:bg-[#e7e3dc]'
                }`}
              >
                {isLoading ? 'Redirecting to checkout…' : plan.cta}
              </motion.button>
```

- [ ] **Step 5: Typecheck + the PlanPickerClient render test**

Run: `pnpm typecheck && pnpm exec vitest run src/app/onboarding/pay`
Expected: PASS (typecheck clean; `PlanPickerClient.test.tsx` 2 tests + `plan-options.test.ts` pass — accessible names and `role="alert"` unchanged).

- [ ] **Step 6: Commit**

```bash
git add src/app/onboarding/pay/page.tsx src/app/onboarding/pay/PlanPickerClient.tsx
git commit -m "style(onboarding): brand the pay page island + motion plan CTAs"
```

---

## Task 9: Brand the `payment-success` page (`PaymentSuccessClient`)

**Files:**
- Modify: `src/app/onboarding/payment-success/PaymentSuccessClient.tsx`

The entire `useEffect` polling block (lines 21-117) and `MAX_POLL_DURATION_MS` stay byte-for-byte unchanged. Change only imports + the final `return`. All three states branded; the "Welcome" state gets a restrained teal check-circle with a scale-in entry.

- [ ] **Step 1: Add imports**

After `import { useRouter } from 'next/navigation';` add:

```tsx
import { motion } from 'motion/react';
import { OnboardingFunnelShell } from '../_shared/OnboardingFunnelShell';
import { primaryButtonClass, buttonMotion } from '../_shared/field-styles';
```

- [ ] **Step 2: Replace the final `return` block**

Replace the entire `return (...)` (currently lines 119-151) with:

```tsx
  return (
    <OnboardingFunnelShell step="setup">
      <div className="max-w-md mx-auto text-center py-6">
        {active ? (
          <>
            <motion.div
              className="w-16 h-16 mx-auto mb-6 rounded-full bg-[#97B3AE] flex items-center justify-center shadow-lg"
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.5, ease: 'easeOut', delay: 0.1 }}
            >
              <svg
                className="w-8 h-8 text-white"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2.5}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </motion.div>
            <h1 className="text-3xl font-medium text-[#2a2a2a] mb-3">
              Welcome to RepWorth!
            </h1>
            <p className="text-[#6a6a6a] mb-8">Your subscription is active.</p>
            <motion.button
              onClick={() => router.push('/dashboard')}
              {...buttonMotion}
              className={primaryButtonClass}
            >
              Go to dashboard
            </motion.button>
          </>
        ) : elapsed > MAX_POLL_DURATION_MS ? (
          <>
            <h1 className="text-2xl font-medium text-[#2a2a2a] mb-3">
              Still processing...
            </h1>
            <p className="text-[#6a6a6a]">
              This is taking longer than usual. Please contact support if it
              persists.
            </p>
          </>
        ) : (
          <>
            <div className="inline-block w-12 h-12 border-4 border-[#97B3AE]/25 border-t-[#97B3AE] rounded-full animate-spin mb-6" />
            <h1 className="text-2xl font-medium text-[#2a2a2a] mb-3">
              Processing your payment...
            </h1>
            <p className="text-[#6a6a6a]">This usually takes a few seconds.</p>
          </>
        )}
      </div>
    </OnboardingFunnelShell>
  );
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no test exists for this client).

- [ ] **Step 4: Commit**

```bash
git add src/app/onboarding/payment-success/PaymentSuccessClient.tsx
git commit -m "style(onboarding): brand payment-success states + celebration"
```

---

## Task 10: Full verification gate + manual visual check

**Files:** none (verification only).

- [ ] **Step 1: Lint**

Run: `pnpm lint`
Expected: PASS, 0 errors. (Watch for: `framer-motion` import slips, unused imports, `<img>` rules — none expected.)

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: PASS — all prior tests green PLUS the new `FunnelStepThread` (4) and `OnboardingFunnelShell` (3) tests. No funnel logic test regressions.

- [ ] **Step 4: Grep for leftover off-brand tokens in the funnel**

Run:
```bash
grep -rnE 'bg-gray-50|bg-blue-6|text-blue-6|ring-blue|amber|text-yellow|border-blue' src/app/onboarding --include='*.tsx' | grep -v '__tests__'
```
Expected: no output (every off-brand token replaced). If any line prints, fix it and re-run Steps 1-3.

- [ ] **Step 5: Manual visual check (dev server)**

Run: `pnpm dev` and visit each page with `MOCK_EXTERNAL_APIS=true` and the relevant flags (`SELF_SERVE_SIGNUP_ENABLED=true`, `ONBOARDING_DEMO_ENABLED=true`) in `.env.local`:
- `/onboarding/start` — island, thread on "Find business", teal "Generate my demo".
- `/onboarding/demo` — island, thread on "Preview", teal stars, `#F0EEEA` AI box, no amber.
- `/onboarding/pay` — wide island, 4 cards inside, thread on "Plan", motion CTAs.
- `/onboarding/payment-success` — island, thread on "Set up", teal spinner / welcome check-circle.
- `/onboarding/business` — island, reteal ProgressDots, branded inputs, thread visible only when demo flow on.

Confirm on a 375px viewport: thread fits, inputs don't zoom on focus (16px), plan cards don't hug edges.

- [ ] **Step 6: Final no-op commit guard**

Run: `git status` — expect a clean tree (everything committed across Tasks 1-9). If anything is uncommitted from the manual pass, commit it:

```bash
git add -A && git commit -m "style(onboarding): visual-pass tweaks for funnel branding"
```

---

## Self-review notes (author)

- **Spec coverage:** D1 shell → Task 3; D3 thread → Task 2; D2 presentational-only → enforced per-task (logic untouched); D4 teal stars → Task 7 Step 3. All five pages → Tasks 5-9. ProgressDots reteal → Task 4. `field-styles` one-owner → Task 1. iOS ≥16px → `fieldClass` `text-base` (Task 1). M11 card padding → Task 8 Step 4. amber/yellow removal → Tasks 7-8. Out-of-scope items (PlaceAutocomplete internals, behavioral fixes) intentionally absent.
- **Type consistency:** `FunnelStep` type + `step` prop names match across Tasks 2/3/5-9; `buttonMotion`, `fieldClass`, `primaryButtonClass`, `ghostButtonClass`, `infoBannerClass`, `errorBannerClass`, `textareaClass`, `labelClass` defined once in Task 1 and referenced identically thereafter.
- **No placeholders:** every modify step shows the full new code block.
