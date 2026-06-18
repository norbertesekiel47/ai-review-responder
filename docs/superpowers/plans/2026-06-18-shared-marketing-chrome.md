# Shared Marketing Chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the marketing-site chrome (marquee + island + navbar + footer) into a single reusable `SiteShell` component (with a `SiteFooter`) used by all four marketing pages, so the footer appears everywhere and the island/nav can no longer drift.

**Architecture:** A new `SiteShell` composition component owns the exact current chrome structure: `<div className={scope}> <MarqueeBackground/> {overlay} <div rw-island-wrap> <Island rw-island> <SiteNav/> {children} <SiteFooter/> </Island> </div> </div>`. Each of the four content components drops its inline chrome and wraps its content in `SiteShell`, passing its page-scope class, nav flags, optional overlay (section dot-nav), and `islandAs="main"` for features. DOM output stays byte-for-byte identical per page except the three non-landing pages now also render the already-global `.rw-foot` footer.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript (strict), Vitest + `renderToStaticMarkup` for component tests (node env), pnpm.

**Spec:** `docs/superpowers/specs/2026-06-18-shared-marketing-chrome-design.md`

**Working directory:** Worktree `.claude/worktrees/shared-marketing-chrome` on branch `worktree-shared-marketing-chrome`. All paths below are repo-relative to that worktree root. Per project convention, nested worktrees are untrustworthy for full local CI — the **authoritative gate is pushed-branch GitHub CI** (`lint`, `typecheck`, `test`, `build`).

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/components/ui/SiteFooter.tsx` | The site-wide footer (© year + Privacy/Terms links). Renders global `.rw-foot`. | Create |
| `src/components/ui/SiteShell.tsx` | Single owner of marketing chrome: marquee + island + nav + footer; injects page content. | Create |
| `src/components/ui/__tests__/SiteFooter.test.tsx` | Locks footer markup/links. | Create |
| `src/components/ui/__tests__/SiteShell.test.tsx` | Locks shell structure (scope class, nav, footer, children, overlay, `islandAs`). | Create |
| `src/components/sections/landing/LandingContent.tsx` | Landing page content. | Modify (use `SiteShell`; remove inline chrome + footer) |
| `src/components/sections/how-it-works/HowItWorksContent.tsx` | How-it-works content. | Modify (use `SiteShell`; gains footer) |
| `src/components/sections/features/FeaturesContent.tsx` | Features content. | Modify (use `SiteShell` + `islandAs="main"`; gains footer) |
| `src/app/(public)/pricing/PricingContent.tsx` | Pricing content. | Modify (use `SiteShell`; gains footer) |
| `src/components/sections/how-it-works/__tests__/HowItWorksContent.test.tsx` | Add footer-present assertion. | Modify |
| `src/components/sections/features/__tests__/FeaturesContent.test.tsx` | Add footer-present assertion. | Modify |
| `src/app/(public)/pricing/__tests__/PricingContent.test.tsx` | New test: footer present + content sanity. | Create |

**Not touched:** `src/components/ui/PageShell.tsx` (an unrelated Tailwind/parallax island used elsewhere — different concern, no marquee/`.rw-island`/nav/footer), all `page.tsx` server files (flags still read and threaded unchanged), `globals.css` (zero CSS changes), auth pages (`auth-island.css`).

---

## Task 1: `SiteFooter` component

**Files:**
- Create: `src/components/ui/SiteFooter.tsx`
- Create test: `src/components/ui/__tests__/SiteFooter.test.tsx`

This footer is extracted verbatim from `LandingContent` (the current `<footer className="rw-foot">` block) so it renders identically and reuses the existing global `.rw-foot` CSS.

- [ ] **Step 1: Write the failing test**

Create `src/components/ui/__tests__/SiteFooter.test.tsx`:

```tsx
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteFooter } from '../SiteFooter';

describe('SiteFooter', () => {
  it('renders the rw-foot footer with privacy and terms links', () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));

    expect(html).toContain('class="rw-foot"');
    expect(html).toContain('RepWorth. All rights reserved.');
    expect(html).toContain('href="/legal/privacy"');
    expect(html).toContain('href="/legal/terms"');
    expect(html).toContain('Privacy');
    expect(html).toContain('Terms &amp; Conditions');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/ui/__tests__/SiteFooter.test.tsx`
Expected: FAIL — cannot resolve `../SiteFooter` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/components/ui/SiteFooter.tsx`:

```tsx
import Link from 'next/link';

/**
 * Site-wide marketing footer. Rendered by SiteShell as the last child of the
 * island on every marketing page. Uses the global `.rw-foot` styles.
 */
export function SiteFooter() {
  return (
    <footer className="rw-foot">
      <span suppressHydrationWarning>© {new Date().getFullYear()} RepWorth. All rights reserved.</span>
      <span>
        <Link href="/legal/privacy">Privacy</Link>
        <Link href="/legal/terms">Terms &amp; Conditions</Link>
      </span>
    </footer>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/ui/__tests__/SiteFooter.test.tsx`
Expected: PASS (2 assertions block, 1 test).

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/SiteFooter.tsx src/components/ui/__tests__/SiteFooter.test.tsx
git commit -m "feat: add SiteFooter component (extracted from landing footer)"
```

---

## Task 2: `SiteShell` component

**Files:**
- Create: `src/components/ui/SiteShell.tsx`
- Create test: `src/components/ui/__tests__/SiteShell.test.tsx`

Depends on Task 1 (`SiteFooter`). `SiteNav` and `MarqueeBackground` already exist.

- [ ] **Step 1: Write the failing test**

Create `src/components/ui/__tests__/SiteShell.test.tsx`:

```tsx
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SiteShell } from '../SiteShell';

describe('SiteShell', () => {
  it('wraps children in the scoped island with nav, footer and marquee', () => {
    const html = renderToStaticMarkup(
      createElement(
        SiteShell,
        { scope: 'rw-test-scope' },
        createElement('p', null, 'INNER_CONTENT'),
      ),
    );

    // page-scope class on the outer wrapper
    expect(html).toContain('class="rw-test-scope"');
    // marquee background present
    expect(html).toContain('rw-marquee');
    // island present, default element is a <div>
    expect(html).toContain('<div class="rw-island">');
    // navbar present (SiteNav renders a <nav>)
    expect(html).toContain('<nav');
    // children rendered
    expect(html).toContain('INNER_CONTENT');
    // footer present on every page
    expect(html).toContain('class="rw-foot"');
  });

  it('renders the island as <main> when islandAs="main"', () => {
    const html = renderToStaticMarkup(
      createElement(
        SiteShell,
        { scope: 'rw-test-scope', islandAs: 'main' },
        createElement('p', null, 'INNER_CONTENT'),
      ),
    );

    expect(html).toContain('<main class="rw-island">');
  });

  it('renders the overlay between the marquee and the island', () => {
    const html = renderToStaticMarkup(
      createElement(
        SiteShell,
        { scope: 'rw-test-scope', overlay: createElement('nav', { className: 'test-overlay' }) },
        createElement('p', null, 'INNER_CONTENT'),
      ),
    );

    expect(html).toContain('class="test-overlay"');
    // overlay appears before the island wrapper in source order
    expect(html.indexOf('test-overlay')).toBeLessThan(html.indexOf('rw-island-wrap'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/ui/__tests__/SiteShell.test.tsx`
Expected: FAIL — cannot resolve `../SiteShell`.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/ui/SiteShell.tsx`:

```tsx
import type { ReactNode } from 'react';
import { MarqueeBackground } from '@/components/ui/MarqueeBackground';
import { SiteNav } from '@/components/ui/SiteNav';
import { SiteFooter } from '@/components/ui/SiteFooter';

interface SiteShellProps {
  /**
   * Page-scope class applied to the outer wrapper (e.g. 'rw-landing',
   * 'hiw-page'). Page-specific CSS in globals.css targets descendants of this
   * class, so every page must pass its own scope.
   */
  scope: string;
  /** Forwarded to SiteNav. */
  selfServeEnabled?: boolean;
  /** Forwarded to SiteNav. */
  comingSoon?: boolean;
  /**
   * Optional node rendered between the marquee and the island wrap — used for a
   * page's section dot-nav (landing `rw-dot-nav`, how-it-works `hiw-dotnav`,
   * features `<DotNav>`). Omitted on pages without one (pricing).
   */
  overlay?: ReactNode;
  /**
   * Island root element. Defaults to 'div'; features passes 'main' to keep the
   * page's single <main> landmark.
   */
  islandAs?: 'main' | 'div';
  children: ReactNode;
}

/**
 * Single owner of the RepWorth marketing chrome: drifting-reviews marquee,
 * the white island, the navbar and the footer. Marketing pages compose this and
 * inject their content as children. Distinct from `PageShell` (an unrelated
 * Tailwind/parallax island used by other surfaces).
 */
export function SiteShell({
  scope,
  selfServeEnabled = false,
  comingSoon = false,
  overlay,
  islandAs = 'div',
  children,
}: SiteShellProps) {
  const Island = islandAs;
  return (
    <div className={scope}>
      <MarqueeBackground />
      {overlay}
      <div className="rw-island-wrap">
        <Island className="rw-island">
          <SiteNav comingSoon={comingSoon} selfServeEnabled={selfServeEnabled} />
          {children}
          <SiteFooter />
        </Island>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/ui/__tests__/SiteShell.test.tsx`
Expected: PASS (3 tests).

If the marquee assertion fails, inspect the rendered class names with a temporary `console.log(html)` and adjust the `'rw-marquee'` substring to match `MarqueeBackground`'s actual root class (it uses `rw-marquee-field` / `rw-marquee-row`). Do not change the component to satisfy the test.

- [ ] **Step 5: Typecheck (verifies the dynamic `islandAs` tag)**

Run: `pnpm typecheck`
Expected: PASS. (Confirms `const Island = islandAs; <Island className="rw-island">` typechecks. If TS rejects the dynamic intrinsic tag, replace the island block with an explicit conditional — `islandAs === 'main' ? <main className="rw-island">{navFooterChildren}</main> : <div className="rw-island">{navFooterChildren}</div>` — extracting the nav+children+footer into a local `const islandBody = (<>...</>)` so it is not duplicated.)

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/SiteShell.tsx src/components/ui/__tests__/SiteShell.test.tsx
git commit -m "feat: add SiteShell component owning marketing chrome"
```

---

## Task 3: Adopt `SiteShell` in `LandingContent`

**Files:**
- Modify: `src/components/sections/landing/LandingContent.tsx`

Landing already renders the footer, so its existing test stays green — this is a pure refactor. `Link` is used only by the footer here, so its import is removed.

- [ ] **Step 1: Confirm the existing landing test currently passes (baseline)**

Run: `pnpm vitest run src/components/sections/landing/__tests__/LandingContent.test.tsx`
Expected: PASS (asserts `href="/legal/privacy"`, `href="/legal/terms"`, CTA strings).

- [ ] **Step 2: Update imports**

Replace this block (lines ~3–6):

```tsx
import Link from 'next/link';
import { useRef, useSyncExternalStore } from 'react';
import { MarqueeBackground } from '@/components/ui/MarqueeBackground';
import { SiteNav } from '@/components/ui/SiteNav';
```

with:

```tsx
import { useRef, useSyncExternalStore } from 'react';
import { SiteShell } from '@/components/ui/SiteShell';
```

- [ ] **Step 3: Replace the chrome opening (wrapper + marquee + dot-nav + island + nav)**

Replace this block:

```tsx
    <div className="rw-landing">
      <MarqueeBackground />

      <div className="rw-dot-nav" aria-label="Section navigation">
        {SECTIONS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            className={active === id ? 'active' : ''}
            onClick={() => scrollToSection(id)}
            aria-label={label}
            title={label}
          />
        ))}
      </div>

      <div className="rw-island-wrap">
        <div className="rw-island">
          <SiteNav comingSoon={comingSoon} selfServeEnabled={selfServeEnabled} />
```

with:

```tsx
    <SiteShell
      scope="rw-landing"
      comingSoon={comingSoon}
      selfServeEnabled={selfServeEnabled}
      overlay={
        <div className="rw-dot-nav" aria-label="Section navigation">
          {SECTIONS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={active === id ? 'active' : ''}
              onClick={() => scrollToSection(id)}
              aria-label={label}
              title={label}
            />
          ))}
        </div>
      }
    >
```

- [ ] **Step 4: Replace the inline footer + closing tags**

Replace this block (inline footer + the three closing `</div>`s):

```tsx

          <footer className="rw-foot">
            <span suppressHydrationWarning>© {new Date().getFullYear()} RepWorth. All rights reserved.</span>
            <span>
              <Link href="/legal/privacy">Privacy</Link>
              <Link href="/legal/terms">Terms &amp; Conditions</Link>
            </span>
          </footer>
        </div>
      </div>
    </div>
```

with:

```tsx
    </SiteShell>
```

- [ ] **Step 5: Run the landing test + typecheck**

Run: `pnpm vitest run src/components/sections/landing/__tests__/LandingContent.test.tsx && pnpm typecheck`
Expected: PASS. The footer links now come from `SiteFooter` (inside `SiteShell`); typecheck confirms no unused `Link`/`MarqueeBackground`/`SiteNav` and that `SiteShell` props are satisfied.

- [ ] **Step 6: Commit**

```bash
git add src/components/sections/landing/LandingContent.tsx
git commit -m "refactor: render LandingContent chrome via SiteShell"
```

---

## Task 4: Adopt `SiteShell` in `HowItWorksContent` (adds footer)

**Files:**
- Modify test: `src/components/sections/how-it-works/__tests__/HowItWorksContent.test.tsx`
- Modify: `src/components/sections/how-it-works/HowItWorksContent.tsx`

This page gains the footer, so we assert it (RED before refactor, GREEN after). `Link` stays (used by the in-content "See pricing" link).

- [ ] **Step 1: Add the failing footer assertion to the existing test**

In `src/components/sections/how-it-works/__tests__/HowItWorksContent.test.tsx`, add two assertions inside the existing `it(...)` block, after the `value="waitlist"` line:

```tsx
    expect(html).toContain('class="rw-foot"');
    expect(html).toContain('href="/legal/privacy"');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/sections/how-it-works/__tests__/HowItWorksContent.test.tsx`
Expected: FAIL — `rw-foot` / `/legal/privacy` not present (no footer yet).

- [ ] **Step 3: Update imports**

Replace this block (lines ~10–11):

```tsx
import { MarqueeBackground } from '@/components/ui/MarqueeBackground';
import { SiteNav } from '@/components/ui/SiteNav';
```

with:

```tsx
import { SiteShell } from '@/components/ui/SiteShell';
```

- [ ] **Step 4: Replace the chrome opening (wrapper + marquee + hiw-dotnav + island + nav)**

Replace this block:

```tsx
    <div className="hiw-page">
      <MarqueeBackground />

      <nav className="hiw-dotnav" aria-label="Section navigation">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => jumpTo(s.id)}
            aria-label={s.label}
            title={s.label}
            className={`hiw-dotnav-btn ${active === s.id ? 'is-active' : ''}`}
          />
        ))}
      </nav>

      <div className="rw-island-wrap">
        <div className="rw-island">
          <SiteNav comingSoon={comingSoon} selfServeEnabled={selfServeEnabled} />
```

with:

```tsx
    <SiteShell
      scope="hiw-page"
      comingSoon={comingSoon}
      selfServeEnabled={selfServeEnabled}
      overlay={
        <nav className="hiw-dotnav" aria-label="Section navigation">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => jumpTo(s.id)}
              aria-label={s.label}
              title={s.label}
              className={`hiw-dotnav-btn ${active === s.id ? 'is-active' : ''}`}
            />
          ))}
        </nav>
      }
    >
```

- [ ] **Step 5: Replace the closing tags (end of component)**

Replace this block (the final section close + three closing `</div>`s + `);` + `}`):

```tsx
          </section>
        </div>
      </div>
    </div>
  );
}
```

with:

```tsx
          </section>
    </SiteShell>
  );
}
```

- [ ] **Step 6: Run test + typecheck**

Run: `pnpm vitest run src/components/sections/how-it-works/__tests__/HowItWorksContent.test.tsx && pnpm typecheck`
Expected: PASS — footer now present; no unused imports.

- [ ] **Step 7: Commit**

```bash
git add src/components/sections/how-it-works/HowItWorksContent.tsx src/components/sections/how-it-works/__tests__/HowItWorksContent.test.tsx
git commit -m "refactor: render HowItWorksContent chrome via SiteShell (adds footer)"
```

---

## Task 5: Adopt `SiteShell` in `FeaturesContent` (adds footer, island is `<main>`)

**Files:**
- Modify test: `src/components/sections/features/__tests__/FeaturesContent.test.tsx`
- Modify: `src/components/sections/features/FeaturesContent.tsx`

Features uses `<main className="rw-island">` → pass `islandAs="main"`. Its overlay is the in-file `<DotNav>` component. `Link` and `DotNav` stay.

- [ ] **Step 1: Add the failing footer assertion to the existing test**

In `src/components/sections/features/__tests__/FeaturesContent.test.tsx`, add to the first `it('renders the final CTA ...')` block, after the `value="waitlist"` line:

```tsx
    expect(html).toContain('class="rw-foot"');
    expect(html).toContain('href="/legal/privacy"');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/sections/features/__tests__/FeaturesContent.test.tsx`
Expected: FAIL — footer not present yet.

- [ ] **Step 3: Update imports**

Replace this block (lines ~16–17):

```tsx
import { MarqueeBackground } from '@/components/ui/MarqueeBackground';
import { SiteNav } from '@/components/ui/SiteNav';
```

with:

```tsx
import { SiteShell } from '@/components/ui/SiteShell';
```

- [ ] **Step 4: Replace the chrome opening (wrapper + marquee + DotNav + island + nav)**

Replace this block:

```tsx
    <div className="rw-feat-page">
      <MarqueeBackground />

      <DotNav activeSection={activeSection} onJump={scrollTo} />

      {/* Island */}
      <div className="rw-island-wrap">
        <main className="rw-island">
          <SiteNav comingSoon={comingSoon} selfServeEnabled={selfServeEnabled} />
```

with:

```tsx
    <SiteShell
      scope="rw-feat-page"
      islandAs="main"
      comingSoon={comingSoon}
      selfServeEnabled={selfServeEnabled}
      overlay={<DotNav activeSection={activeSection} onJump={scrollTo} />}
    >
```

- [ ] **Step 5: Replace the closing tags (end of the main component)**

Replace this block (final section close + `</main>` + two `</div>`s + `);` + `}`):

```tsx
          </section>
        </main>
      </div>
    </div>
  );
}
```

with:

```tsx
          </section>
    </SiteShell>
  );
}
```

- [ ] **Step 6: Run test + typecheck**

Run: `pnpm vitest run src/components/sections/features/__tests__/FeaturesContent.test.tsx && pnpm typecheck`
Expected: PASS — footer present; `<main class="rw-island">` preserved via `islandAs`; no unused imports.

- [ ] **Step 7: Commit**

```bash
git add src/components/sections/features/FeaturesContent.tsx src/components/sections/features/__tests__/FeaturesContent.test.tsx
git commit -m "refactor: render FeaturesContent chrome via SiteShell (adds footer)"
```

---

## Task 6: Adopt `SiteShell` in `PricingContent` (adds footer)

**Files:**
- Create test: `src/app/(public)/pricing/__tests__/PricingContent.test.tsx`
- Modify: `src/app/(public)/pricing/PricingContent.tsx`

Pricing has no existing content test and no overlay. We add a small test that fails before the refactor (footer absent) and passes after.

- [ ] **Step 1: Write the failing test**

Create `src/app/(public)/pricing/__tests__/PricingContent.test.tsx`:

```tsx
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PricingContent } from '../PricingContent';

describe('PricingContent', () => {
  it('renders the pricing page with the site-wide footer', () => {
    const html = renderToStaticMarkup(createElement(PricingContent));

    // page content sanity
    expect(html).toContain('value="pricing"');
    // site-wide footer now present
    expect(html).toContain('class="rw-foot"');
    expect(html).toContain('href="/legal/privacy"');
    expect(html).toContain('href="/legal/terms"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run "src/app/(public)/pricing/__tests__/PricingContent.test.tsx"`
Expected: FAIL — `rw-foot` / `/legal/privacy` not present (no footer yet). (`value="pricing"` already passes — it comes from the existing `LeadIntakeForm`.)

- [ ] **Step 3: Update imports**

Replace this block (lines ~6–7):

```tsx
import { MarqueeBackground } from '@/components/ui/MarqueeBackground';
import { SiteNav } from '@/components/ui/SiteNav';
```

with:

```tsx
import { SiteShell } from '@/components/ui/SiteShell';
```

- [ ] **Step 4: Replace the chrome opening (wrapper + marquee + island + nav)**

Replace this block:

```tsx
    <div className="pr-page">
      <MarqueeBackground />

      <div className="rw-island-wrap">
        <div className="rw-island">
          <SiteNav selfServeEnabled={selfServeEnabled} />
```

with:

```tsx
    <SiteShell scope="pr-page" selfServeEnabled={selfServeEnabled}>
```

- [ ] **Step 5: Replace the closing tags (end of the main component)**

Replace this block (anchored on the unique `source="pricing"` CTA through the closing tags):

```tsx
            <div className="w-full max-w-md">
              <LeadIntakeForm intent="waitlist" source="pricing" tone="onTeal" />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
```

with:

```tsx
            <div className="w-full max-w-md">
              <LeadIntakeForm intent="waitlist" source="pricing" tone="onTeal" />
            </div>
          </section>
    </SiteShell>
  );
}
```

- [ ] **Step 6: Run test + typecheck**

Run: `pnpm vitest run "src/app/(public)/pricing/__tests__/PricingContent.test.tsx" && pnpm typecheck`
Expected: PASS — footer present; no unused imports.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(public)/pricing/PricingContent.tsx" "src/app/(public)/pricing/__tests__/PricingContent.test.tsx"
git commit -m "refactor: render PricingContent chrome via SiteShell (adds footer)"
```

---

## Task 7: Full verification + push (authoritative CI gate)

**Files:** none (verification only).

- [ ] **Step 1: Run the full local check suite**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: PASS. (Per project convention these run in a nested worktree and are indicative, not authoritative.) Pay attention that the four content-component tests and the two new `ui` tests all pass.

- [ ] **Step 2: Build**

Run: `pnpm build`
Expected: PASS — no type or import errors from the refactor.

- [ ] **Step 3: Visual confirmation (the actual behavior change)**

Start the dev server (`pnpm dev`) and load each page; or use chrome-devtools MCP to snapshot. Confirm:
- Footer (`© … RepWorth … Privacy · Terms`) now appears at the bottom of **/how-it-works**, **/features**, and **/pricing** (and still on **/**).
- Island width, radius, navbar, marquee, and each page's section dot-nav are unchanged on all four pages.

If a page's footer or dot-nav looks misplaced, verify the `overlay` was routed correctly and the page-scope class matches the original (`rw-landing` / `hiw-page` / `rw-feat-page` / `pr-page`).

- [ ] **Step 4: Push and let GitHub CI decide**

```bash
git push -u origin worktree-shared-marketing-chrome
```

Then open a PR and confirm the four CI checks (`lint`, `typecheck`, `test`, `build`) are green before merge. This is the authoritative gate.

```bash
gh pr create --fill --base main
```

---

## Self-Review

**Spec coverage:**
- "One component owns marquee + island + nav + footer" → Task 2 (`SiteShell`). ✅
- "Footer appears on all four pages" → Tasks 3–6 (landing keeps it; how-it-works/features/pricing gain it, each asserted by a test). ✅
- "Footer extracted as its own component" → Task 1 (`SiteFooter`). ✅
- "Future page reuses the island by composing one component" → satisfied by `SiteShell`'s public API (Task 2); documented in spec. ✅
- "Zero visual change except added footer" → preserved via per-page `scope`, `islandAs`, and `overlay` (Tasks 3–6); no `globals.css` edits. ✅
- "Auth/other public pages untouched" → File Structure "Not touched" list; only the 4 named content components modified. ✅

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N" — every code and command step is concrete. ✅

**Type consistency:** Component is `SiteShell` with props `scope`, `selfServeEnabled?`, `comingSoon?`, `overlay?`, `islandAs?: 'main' | 'div'`, `children` everywhere it's referenced (Tasks 2–6). `SiteFooter` takes no props everywhere. Import path `@/components/ui/SiteShell` and `@/components/ui/SiteFooter` consistent across all tasks. ✅

**Edge cases handled:** `Link` import removed only from landing (footer-only there) and kept in how-it-works/features/pricing (used by in-content links); `islandAs="main"` only for features; `overlay` for landing/how-it-works/features, omitted for pricing; dynamic `islandAs` tag has an explicit typecheck step with a documented fallback. ✅
