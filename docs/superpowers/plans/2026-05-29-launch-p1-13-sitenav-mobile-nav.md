# SiteNav Mobile Hamburger Nav — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Below 640px, expose the public nav links (and, when self-serve auth is enabled, Log in / Sign up) via a branded hamburger toggle + dropdown, so the public site has working navigation on phones.

**Architecture:** Convert `SiteNav` from a server component to a `'use client'` component with a `mobileOpen` toggle. Desktop (≥640px) layout is unchanged (`hidden sm:flex`). A `sm:hidden` hamburger button toggles a `motion/react` dropdown panel below the header row. Closes on link tap and `Escape`. Fold in the adjacent `focus-visible` accessibility gap on the same element.

**Tech Stack:** Next.js 16, React 19, Tailwind, `motion` (`motion/react`), Vitest + `@testing-library/react` + `@testing-library/user-event` (jsdom).

**Spec:** `docs/superpowers/specs/2026-05-29-launch-p1-13-sitenav-mobile-nav-design.md`

---

## File Structure

- **Modify:** `src/components/ui/SiteNav.tsx` — the one component under change. Becomes `'use client'`; gains the hamburger + dropdown panel + Escape handler. Single responsibility (public marketing nav) is unchanged; no split needed.
- **Modify:** `src/components/ui/__tests__/SiteNav.test.tsx` — preserve the 3 existing static-markup tests; add hamburger/interaction/accessibility tests. Whole file gains `// @vitest-environment jsdom` and a `next/link` mock.

No new files, no new dependencies, no prop/contract changes. Callers are untouched.

---

## Conventions for the implementer (read once)

- **Test environment:** the repo default is `node`. Interaction tests using `render`/`screen`/`userEvent` REQUIRE `// @vitest-environment jsdom` as the first line of the test file. `renderToStaticMarkup` works under jsdom too, so the whole file uses one directive.
- **jest-dom matchers** (`toBeInTheDocument`, `toHaveAttribute`) are globally available via `vitest.setup.ts` — no per-file import needed.
- **`next/link` in tests:** mock it to a plain `<a>` (matches `DemoStatusIsland.test.tsx`) so tests need no App Router context. The mock spreads `...props`, so the component's `onClick` still fires; clicking a mocked `<a href>` prints a harmless `Not implemented: navigation` console message in jsdom — expected, not a failure.
- **Assert on `aria-expanded`** of the toggle button (synchronous React state) for open/close, NOT on panel removal — `AnimatePresence` exit animation can leave the panel briefly mounted in jsdom.
- **Duplicate links:** the same labels render in BOTH the desktop cluster and the open mobile panel; jsdom ignores Tailwind so both are queryable. Always scope open-panel assertions with `within(panel)` (panel = `container.querySelector('#site-nav-mobile-menu')`).
- Run all commands from the worktree root: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/sitenav-mobile-nav`.

---

## Task 1: Hamburger toggle + branded dropdown panel

**Files:**
- Modify: `src/components/ui/SiteNav.tsx`
- Test: `src/components/ui/__tests__/SiteNav.test.tsx`

- [ ] **Step 1: Replace the test file with the preserved + new tests (failing)**

Overwrite `src/components/ui/__tests__/SiteNav.test.tsx` with:

```tsx
// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SiteNav } from '../SiteNav';

// Render Next's Link as a plain anchor so these tests don't need an App Router
// context (matches the pattern in DemoStatusIsland.test.tsx).
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) =>
    createElement('a', { href, ...props }, children),
}));

const MENU_ID = 'site-nav-mobile-menu';

describe('SiteNav', () => {
  describe('owner auth links', () => {
    it('hides owner auth links by default', () => {
      const html = renderToStaticMarkup(createElement(SiteNav));
      expect(html).not.toContain('href="/login"');
      expect(html).not.toContain('href="/signup"');
      expect(html).not.toContain('Log in');
      expect(html).not.toContain('Sign up');
    });

    it('hides owner auth links when self-serve signup is disabled', () => {
      const html = renderToStaticMarkup(createElement(SiteNav, { selfServeEnabled: false }));
      expect(html).not.toContain('href="/login"');
      expect(html).not.toContain('href="/signup"');
      expect(html).not.toContain('Log in');
      expect(html).not.toContain('Sign up');
    });

    it('shows owner auth links when self-serve signup is enabled', () => {
      const html = renderToStaticMarkup(createElement(SiteNav, { selfServeEnabled: true }));
      expect(html).toContain('href="/login"');
      expect(html).toContain('href="/signup"');
      expect(html).toContain('Log in');
      expect(html).toContain('Sign up');
    });
  });

  describe('mobile hamburger', () => {
    it('renders a closed, accessible toggle button by default', () => {
      const html = renderToStaticMarkup(createElement(SiteNav));
      expect(html).toContain('type="button"');
      expect(html).toContain('aria-expanded="false"');
      expect(html).toContain(`aria-controls="${MENU_ID}"`);
      expect(html).toContain('aria-label="Open menu"');
      // Panel is not rendered while closed.
      expect(html).not.toContain(`id="${MENU_ID}"`);
    });

    it('opens the menu and reveals the nav links on click', async () => {
      const user = userEvent.setup();
      const { container } = render(createElement(SiteNav));

      const toggle = screen.getByRole('button', { name: 'Open menu' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      await user.click(toggle);

      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(toggle).toHaveAttribute('aria-label', 'Close menu');

      const panel = container.querySelector(`#${MENU_ID}`) as HTMLElement;
      expect(panel).not.toBeNull();
      const menu = within(panel);
      expect(menu.getByRole('link', { name: 'Features' })).toBeInTheDocument();
      expect(menu.getByRole('link', { name: 'How it works' })).toBeInTheDocument();
      expect(menu.getByRole('link', { name: 'Pricing' })).toBeInTheDocument();
    });

    it('includes auth links in the menu when self-serve is enabled', async () => {
      const user = userEvent.setup();
      const { container } = render(createElement(SiteNav, { selfServeEnabled: true }));

      await user.click(screen.getByRole('button', { name: 'Open menu' }));

      const panel = container.querySelector(`#${MENU_ID}`) as HTMLElement;
      expect(within(panel).getByRole('link', { name: 'Log in' })).toBeInTheDocument();
      expect(within(panel).getByRole('link', { name: 'Sign up' })).toBeInTheDocument();
    });

    it('omits auth links from the menu when self-serve is disabled', async () => {
      const user = userEvent.setup();
      const { container } = render(createElement(SiteNav, { selfServeEnabled: false }));

      await user.click(screen.getByRole('button', { name: 'Open menu' }));

      const panel = container.querySelector(`#${MENU_ID}`) as HTMLElement;
      expect(within(panel).queryByRole('link', { name: 'Log in' })).toBeNull();
      expect(within(panel).queryByRole('link', { name: 'Sign up' })).toBeNull();
    });

    it('closes the menu when a nav link is clicked', async () => {
      const user = userEvent.setup();
      const { container } = render(createElement(SiteNav));

      const toggle = screen.getByRole('button', { name: 'Open menu' });
      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');

      const panel = container.querySelector(`#${MENU_ID}`) as HTMLElement;
      await user.click(within(panel).getByRole('link', { name: 'Pricing' }));

      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    });

    it('closes the menu on Escape', async () => {
      const user = userEvent.setup();
      render(createElement(SiteNav));

      const toggle = screen.getByRole('button', { name: 'Open menu' });
      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');

      await user.keyboard('{Escape}');

      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/components/ui/__tests__/SiteNav.test.tsx`
Expected: the `mobile hamburger` tests FAIL (no toggle button / no `aria-controls` yet). The 3 `owner auth links` tests still PASS.

- [ ] **Step 3: Rewrite `SiteNav.tsx` with the client component + hamburger + panel (no focus-visible yet)**

Overwrite `src/components/ui/SiteNav.tsx` with:

```tsx
'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';

interface SiteNavProps {
  /** When true, the right-side Log in / Sign up cluster is hidden. */
  comingSoon?: boolean;
  /** Controls whether owner self-serve auth links are exposed. */
  selfServeEnabled?: boolean;
}

const NAV_LINKS = [
  { label: 'Features', href: '/features' },
  { label: 'How it works', href: '/how-it-works' },
  { label: 'Pricing', href: '/pricing' },
];

const MOBILE_MENU_ID = 'site-nav-mobile-menu';

export function SiteNav({ comingSoon = false, selfServeEnabled = false }: SiteNavProps) {
  const showOwnerAuth = selfServeEnabled && !comingSoon;
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!mobileOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mobileOpen]);

  const closeMenu = () => setMobileOpen(false);

  return (
    <nav className="border-b border-[#97B3AE]/10">
      <div className="px-8 py-4 flex items-center justify-between gap-4">
        <Link href="/" className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/Logo - SVG.svg"
            alt="RepWorth"
            width={32}
            height={32}
            className="w-8 h-8 object-contain"
          />
          <span className="text-sm tracking-wider uppercase text-[#97B3AE]">RepWorth</span>
        </Link>

        {/* Desktop nav links (unchanged at >=640px) */}
        <div className="hidden sm:flex items-center gap-6">
          {NAV_LINKS.map(({ label, href }) => (
            <Link
              key={label}
              href={href}
              className="text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors"
            >
              {label}
            </Link>
          ))}
        </div>

        {/* Desktop auth cluster (now sm-gated so it does not duplicate on mobile) */}
        {showOwnerAuth && (
          <div className="hidden sm:flex items-center gap-3">
            <Link
              href="/login"
              className="text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors"
            >
              Log in
            </Link>
            <Link
              href="/signup"
              className="text-sm bg-[#97B3AE] text-white px-4 py-2 rounded-full hover:bg-[#97B3AE]/90 transition-colors"
            >
              Sign up
            </Link>
          </div>
        )}

        {/* Mobile hamburger toggle */}
        <button
          type="button"
          onClick={() => setMobileOpen((open) => !open)}
          aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={mobileOpen}
          aria-controls={MOBILE_MENU_ID}
          className="sm:hidden inline-flex items-center justify-center rounded-md p-2 text-[#97B3AE] hover:bg-[#97B3AE]/10 transition-colors"
        >
          <svg
            className="w-6 h-6"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={2}
            stroke="currentColor"
            aria-hidden="true"
          >
            {mobileOpen ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"
              />
            )}
          </svg>
        </button>
      </div>

      {/* Mobile dropdown panel */}
      <AnimatePresence initial={false}>
        {mobileOpen && (
          <motion.div
            key="mobile-menu"
            id={MOBILE_MENU_ID}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="sm:hidden overflow-hidden border-t border-[#97B3AE]/10"
          >
            <div className="px-8 py-4 flex flex-col gap-1">
              {NAV_LINKS.map(({ label, href }) => (
                <Link
                  key={label}
                  href={href}
                  onClick={closeMenu}
                  className="py-2 text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors"
                >
                  {label}
                </Link>
              ))}

              {showOwnerAuth && (
                <>
                  <div className="my-2 border-t border-[#97B3AE]/10" aria-hidden="true" />
                  <Link
                    href="/login"
                    onClick={closeMenu}
                    className="py-2 text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors"
                  >
                    Log in
                  </Link>
                  <Link
                    href="/signup"
                    onClick={closeMenu}
                    className="mt-1 inline-flex w-full justify-center text-sm bg-[#97B3AE] text-white px-4 py-2 rounded-full hover:bg-[#97B3AE]/90 transition-colors"
                  >
                    Sign up
                  </Link>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </nav>
  );
}
```

> **Fallback (only if needed):** if `AnimatePresence`/`motion.div` causes the open-state panel children not to be found under jsdom, replace the `<AnimatePresence>...</AnimatePresence>` block with a plain conditional `{mobileOpen && (<div id={MOBILE_MENU_ID} className="sm:hidden border-t border-[#97B3AE]/10"> ...same inner content... </div>)}`. Behavior/accessibility contract is unchanged; only the reveal animation is dropped.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/components/ui/__tests__/SiteNav.test.tsx`
Expected: PASS (all `owner auth links` + `mobile hamburger` tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/SiteNav.tsx src/components/ui/__tests__/SiteNav.test.tsx
git commit -m "feat(sitenav): add branded mobile hamburger nav (P1 #13)

Converts SiteNav to a client component with a sm:hidden hamburger that
toggles a motion/react dropdown of the nav links (+ Log in / Sign up when
self-serve is enabled). Closes on link tap and Escape; aria-expanded/
aria-controls/aria-label wired. Desktop (>=640px) layout unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Fold in focus-visible styles (audit line 113)

**Files:**
- Modify: `src/components/ui/SiteNav.tsx`
- Test: `src/components/ui/__tests__/SiteNav.test.tsx`

- [ ] **Step 1: Add the failing accessibility test**

Append this `it` block inside the `describe('mobile hamburger', ...)` block (or add a new `describe('accessibility', ...)` sibling) in `src/components/ui/__tests__/SiteNav.test.tsx`:

```tsx
  it('applies focus-visible rings to all interactive elements', () => {
    const html = renderToStaticMarkup(createElement(SiteNav, { selfServeEnabled: true }));
    // logo + 3 desktop nav links + Log in + Sign up + hamburger = 7 controls.
    const occurrences = (html.match(/focus-visible:ring-2/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(6);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/components/ui/__tests__/SiteNav.test.tsx -t "focus-visible"`
Expected: FAIL — `0` occurrences (no focus styles yet).

- [ ] **Step 3: Add the focus-visible classes**

In `src/components/ui/SiteNav.tsx`, append `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE]/50` to the `className` of each interactive element. For the two text links and the logo, also ensure a rounded shape so the ring reads cleanly:

- Logo `<Link href="/">`: add `rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE]/50`.
- Each desktop nav `<Link>` and the mobile-panel nav `<Link>`: add `rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE]/50`.
- Desktop + panel `Log in` `<Link>`: add `rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE]/50`.
- Desktop + panel `Sign up` `<Link>` (already `rounded-full`): add `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE]/50`.
- Hamburger `<button>` (already `rounded-md`): add `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE]/50`.

For example, the desktop nav link becomes:

```tsx
            <Link
              key={label}
              href={href}
              className="text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE]/50"
            >
              {label}
            </Link>
```

and the hamburger button `className` becomes:

```tsx
          className="sm:hidden inline-flex items-center justify-center rounded-md p-2 text-[#97B3AE] hover:bg-[#97B3AE]/10 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE]/50"
```

Apply the same `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#97B3AE]/50` suffix to the remaining controls listed above.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/components/ui/__tests__/SiteNav.test.tsx`
Expected: PASS (all tests, including `focus-visible`).

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/SiteNav.tsx src/components/ui/__tests__/SiteNav.test.tsx
git commit -m "a11y(sitenav): add focus-visible rings to nav controls (audit line 113)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Full local quality gate

**Files:** none (verification only).

- [ ] **Step 1: Lint**

Run: `pnpm lint`
Expected: 0 errors (the logo keeps its existing `eslint-disable-next-line @next/next/no-img-element`; no new violations).

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: clean (0 errors). `aria-expanded={mobileOpen}` (boolean) and `aria-controls={string}` are valid; `motion/react` types resolve.

- [ ] **Step 3: Full test suite**

Run: `pnpm test`
Expected: all suites pass (baseline was green; this change is additive + presentational).

- [ ] **Step 4: Commit only if a fix was required**

If lint/typecheck/test surfaced a fix, commit it:

```bash
git add -A
git commit -m "chore(sitenav): satisfy lint/typecheck/test gate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

If all three passed with no changes, skip this commit.

---

## Finalization (after tasks complete — handled outside TDD loop)

1. **Update the audit doc** `docs/launch-ready-part2.md` to mark this work done (matching the prior `✅ … — DONE (PR #NNN)` style), once the PR number is known:
   - Row **M1** (line ~47): mark ✅ with a DONE note.
   - Prioritized fix **#13** (line ~148): mark ✅ with a DONE note.
   - Line ~113 / **#18** (line ~153): note `focus-visible` now also covers `SiteNav` controls (still partial elsewhere).
2. **Push** the branch and open a PR into protected `main`; ensure the 4 CI checks (lint/typecheck/test/build) are green.
3. **Manual visual check (recommended):** load a public page (e.g. `/pricing`) at ≤375px, confirm the hamburger toggles the panel, links navigate + close the menu, and `Escape` closes it. Confirm desktop (≥640px) is visually identical to before.

---

## Self-Review

**Spec coverage:**
- "Expose nav links < 640px via hamburger + dropdown" → Task 1.
- "Desktop unchanged" → Task 1 keeps `hidden sm:flex`; verified by preserved auth tests + visual check.
- "Auth inside menu when `showOwnerAuth`" → Task 1 (conditional panel block) + tests.
- "Close on link tap and Escape" → Task 1 (`closeMenu`, `useEffect` Escape) + tests.
- "aria-expanded / aria-controls / dynamic aria-label / type=button" → Task 1 + static test.
- "motion/react, inline SVG, brand tokens, restraint" → Task 1 implementation.
- "Fold in focus-visible (line 113)" → Task 2.
- "Preserve existing 3 tests + add static & interaction tests" → Task 1 Step 1.
- "Gate: lint && typecheck && test" → Task 3.
- Non-goals (logo→next/image, app-wide aria-live) → not touched. ✅

**Placeholder scan:** No TBD/TODO; every code/test step contains full content; commands have expected output. ✅

**Type/name consistency:** `MOBILE_MENU_ID` constant in component == `MENU_ID` literal value `"site-nav-mobile-menu"` in tests (both resolve to the same string; the test deliberately hardcodes the value it asserts against). `setMobileOpen`/`mobileOpen`/`closeMenu`/`showOwnerAuth` used consistently across tasks. ✅
