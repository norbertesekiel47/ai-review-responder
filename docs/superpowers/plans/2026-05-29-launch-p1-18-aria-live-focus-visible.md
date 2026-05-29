# Launch P1 #18 — aria-live + focus-visible Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish launch-audit P1 #18 — give keyboard users a visible focus ring on the marketing controls and give screen-reader users spoken async feedback on three named Console surfaces, via one reusable `<LiveRegion>` primitive.

**Architecture:** A single deep `<LiveRegion message level>` `sr-only` component owns all `role`/`aria-live` mechanics; three Console surfaces (settings save, connect/reconnect, dashboard load/error) render it driven by state they already hold. Focus rings reuse the existing teal `outline: 2px solid var(--rw-teal); outline-offset: 2px` pattern. Every change is strictly additive — no visual rebrand (the `dashboard/connect` rebrand is the separate P0 #10).

**Tech Stack:** Next.js 16 / React 19, TypeScript (strict), Tailwind v4, Vitest + `@testing-library/react` (jsdom) + `react-dom/server` `renderToStaticMarkup`, `motion/react`.

**Spec:** `docs/superpowers/specs/2026-05-29-launch-p1-18-aria-live-focus-visible-design.md`

**Worktree:** Implement in `RepWorth-worktrees/launch-p1-18-aria-live-focus-visible` on branch `fix/launch-p1-18-aria-live-focus-visible`. All commands below run from that worktree root. (Nested-in-repo worktrees poison local lint/test per CLAUDE.md — this worktree is a sibling, outside the repo.)

**Commit trailer:** every commit message ends with:
```
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/components/ui/LiveRegion.tsx` | The reusable sr-only live-region primitive | Create |
| `src/components/ui/__tests__/LiveRegion.test.tsx` | Unit tests for the primitive | Create |
| `src/app/globals.css` | Add 3 `:focus-visible` rules (dot-nav, pricing toggle, FAQ) | Modify |
| `src/__tests__/focus-visible-marketing.test.ts` | CSS-contract test locking the 3 focus rules | Create |
| `src/components/ui/PageShell.tsx` | Add focus-ring utilities to the dot-nav button | Modify (`:65-71`) |
| `src/components/ui/__tests__/PageShell.test.tsx` | Assert the dot-nav focus ring | Modify |
| `src/components/ui/SiteNav.tsx` | Add focus-ring utilities to nav + auth links | Modify (`:33-59`) |
| `src/components/ui/__tests__/SiteNav.test.tsx` | Assert link focus rings | Modify |
| `src/components/dashboard/settings/SettingsShell.tsx` | Render success + error LiveRegions; add `saveError` prop | Modify (`:6-21`, `:73-76`) |
| `src/components/dashboard/settings/__tests__/SettingsShell.test.tsx` | Assert settings announcements | Create |
| `src/app/(authenticated)/settings/SettingsClient.tsx` | Pass `saveError` to SettingsShell | Modify (`:74-86`) |
| `src/app/(authenticated)/dashboard/connect/page.tsx` | Announce `error` + `actionError` | Modify (`:88-97`, `:214-216`) |
| `src/app/(authenticated)/dashboard/connect/__tests__/page.test.tsx` | Assert connect error announcement | Modify |
| `src/components/DashboardContent.tsx` | Announce `error` + `loading` | Modify (`:63-99`) |
| `src/components/__tests__/DashboardContent.test.tsx` | Assert dashboard announcements | Create |
| `docs/launch-ready-part2.md` | Mark #18 complete | Modify |

---

## Task 1: `<LiveRegion>` primitive

**Files:**
- Create: `src/components/ui/LiveRegion.tsx`
- Test: `src/components/ui/__tests__/LiveRegion.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/ui/__tests__/LiveRegion.test.tsx`:

```tsx
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LiveRegion } from '../LiveRegion';

describe('LiveRegion', () => {
  it('defaults to a polite status region carrying the message', () => {
    const html = renderToStaticMarkup(<LiveRegion message="Settings saved" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('class="sr-only"');
    expect(html).toContain('Settings saved');
  });

  it('renders an assertive alert region when level="assertive"', () => {
    const html = renderToStaticMarkup(
      <LiveRegion message="Could not save" level="assertive" />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('Could not save');
  });

  it('renders an empty but present region for an empty message', () => {
    const html = renderToStaticMarkup(<LiveRegion message="" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/ui/__tests__/LiveRegion.test.tsx`
Expected: FAIL — `Failed to resolve import "../LiveRegion"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/components/ui/LiveRegion.tsx`:

```tsx
interface LiveRegionProps {
  /** Current announcement. Empty string announces nothing. */
  message: string;
  /** 'polite' (default) → role=status; 'assertive' → role=alert (errors). */
  level?: 'polite' | 'assertive';
}

/**
 * Visually-hidden ARIA live region. Render it unconditionally and update
 * `message` — screen readers only announce changes to a region that already
 * exists in the DOM. Owns all role/aria-live mechanics so callers pass a
 * string and nothing else.
 */
export function LiveRegion({ message, level = 'polite' }: LiveRegionProps) {
  return (
    <div
      role={level === 'assertive' ? 'alert' : 'status'}
      aria-live={level}
      className="sr-only"
    >
      {message}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/ui/__tests__/LiveRegion.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/LiveRegion.tsx src/components/ui/__tests__/LiveRegion.test.tsx
git commit -m "feat(a11y): add reusable LiveRegion primitive (P1 #18)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `:focus-visible` rules in globals.css

**Files:**
- Modify: `src/app/globals.css` (after `:1030`, `:1951`, `:2309`)
- Test: `src/__tests__/focus-visible-marketing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/focus-visible-marketing.test.ts` (mirrors the `island-overflow.test.ts` CSS-contract convention):

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// P1 #18: keyboard users must get a visible focus ring on the marketing
// interactive controls. Lock the three CSS-class controls to the canonical
// teal outline treatment (the same one .pr-matrix already uses).
const CSS = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf-8');

const FOCUS_SELECTORS = [
  '.rw-dot-nav button:focus-visible',
  '.pr-toggle button:focus-visible',
  '.pr-faq-q:focus-visible',
];

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = CSS.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match || match[1] === undefined) {
    throw new Error(`focus-visible rule missing for ${selector}`);
  }
  return match[1];
}

describe('marketing controls declare a focus-visible outline (P1 #18)', () => {
  it.each(FOCUS_SELECTORS)('%s declares an outline', (selector) => {
    expect(ruleBody(selector)).toMatch(/outline\s*:\s*2px solid var\(--rw-teal\)/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/__tests__/focus-visible-marketing.test.ts`
Expected: FAIL — `focus-visible rule missing for .rw-dot-nav button:focus-visible`.

- [ ] **Step 3: Add the three CSS rules**

In `src/app/globals.css`, add each rule immediately after its base block.

After `.rw-dot-nav button.active { background: var(--rw-teal); }` (`:1030`):

```css
.rw-dot-nav button:focus-visible { outline: 2px solid var(--rw-teal); outline-offset: 2px; }
```

After `.pr-toggle button.is-active { color: var(--rw-ink); }` (`:1951`):

```css
.pr-toggle button:focus-visible { outline: 2px solid var(--rw-teal); outline-offset: 2px; }
```

After the `.pr-faq-q { ... }` block closes (`:2309`, the line `}` before `.pr-faq-icon`):

```css
.pr-faq-q:focus-visible { outline: 2px solid var(--rw-teal); outline-offset: 2px; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/__tests__/focus-visible-marketing.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/app/globals.css src/__tests__/focus-visible-marketing.test.ts
git commit -m "feat(a11y): focus-visible rings on marketing dot-nav, pricing toggle, FAQ (P1 #18)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `:focus-visible` on the PageShell dot-nav

**Files:**
- Modify: `src/components/ui/PageShell.tsx:65-71`
- Test: `src/components/ui/__tests__/PageShell.test.tsx`

- [ ] **Step 1: Add the failing test**

Append to the `describe('PageShell', ...)` block in `src/components/ui/__tests__/PageShell.test.tsx`:

```tsx
  it('gives dot-nav buttons a teal focus-visible ring', () => {
    const html = renderToStaticMarkup(
      <PageShell sections={[{ ref: { current: null }, label: 'Top' }]}>x</PageShell>,
    );
    expect(html).toContain('focus-visible:outline-[#97B3AE]');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/ui/__tests__/PageShell.test.tsx`
Expected: FAIL — last test, string not found.

- [ ] **Step 3: Add focus utilities to the dot-nav button**

In `src/components/ui/PageShell.tsx`, edit the dot-nav `<button>` className (`:70`). Replace:

```tsx
              className="w-3 h-3 rounded-full bg-[#97B3AE]/30 hover:bg-[#97B3AE] transition-all hover:scale-125"
```

with:

```tsx
              className="w-3 h-3 rounded-full bg-[#97B3AE]/30 hover:bg-[#97B3AE] transition-all hover:scale-125 focus-visible:outline-2 focus-visible:outline-[#97B3AE] focus-visible:outline-offset-2"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/ui/__tests__/PageShell.test.tsx`
Expected: PASS (4 tests — the existing `type="button"` test still passes, locking that done sub-part).

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/PageShell.tsx src/components/ui/__tests__/PageShell.test.tsx
git commit -m "feat(a11y): focus-visible ring on PageShell dot-nav (P1 #18)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `:focus-visible` on SiteNav links

**Files:**
- Modify: `src/components/ui/SiteNav.tsx:33-59`
- Test: `src/components/ui/__tests__/SiteNav.test.tsx`

- [ ] **Step 1: Add the failing test**

Append to the `describe('SiteNav', ...)` block in `src/components/ui/__tests__/SiteNav.test.tsx`:

```tsx
  it('gives nav links a teal focus-visible ring', () => {
    const html = renderToStaticMarkup(createElement(SiteNav));
    expect(html).toContain('focus-visible:outline-[#97B3AE]');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/ui/__tests__/SiteNav.test.tsx`
Expected: FAIL — string not found (the default render has no focus ring yet).

- [ ] **Step 3: Add focus utilities to the links**

In `src/components/ui/SiteNav.tsx`, add `rounded focus-visible:outline-2 focus-visible:outline-[#97B3AE] focus-visible:outline-offset-2` to each `<Link>` className.

Nav links (`:38`) — replace:

```tsx
            className="text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors"
```
with:
```tsx
            className="text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors rounded focus-visible:outline-2 focus-visible:outline-[#97B3AE] focus-visible:outline-offset-2"
```

Log in link (`:49`) — replace:

```tsx
            className="text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors"
```
with:
```tsx
            className="text-sm text-[#6a6a6a] hover:text-[#97B3AE] transition-colors rounded focus-visible:outline-2 focus-visible:outline-[#97B3AE] focus-visible:outline-offset-2"
```

Sign up link (`:55`) — replace:

```tsx
            className="text-sm bg-[#97B3AE] text-white px-4 py-2 rounded-full hover:bg-[#97B3AE]/90 transition-colors"
```
with:
```tsx
            className="text-sm bg-[#97B3AE] text-white px-4 py-2 rounded-full hover:bg-[#97B3AE]/90 transition-colors focus-visible:outline-2 focus-visible:outline-[#97B3AE] focus-visible:outline-offset-2"
```

Note: the two nav-link className strings are byte-identical to the Log-in string. Edit each `<Link>` individually (do not use a global replace that would also alter the Sign up link).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/ui/__tests__/SiteNav.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/SiteNav.tsx src/components/ui/__tests__/SiteNav.test.tsx
git commit -m "feat(a11y): focus-visible rings on SiteNav links (P1 #18)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Settings save announcements

**Files:**
- Modify: `src/components/dashboard/settings/SettingsShell.tsx`
- Modify: `src/app/(authenticated)/settings/SettingsClient.tsx:74-86`
- Test: `src/components/dashboard/settings/__tests__/SettingsShell.test.tsx`

- [ ] **Step 1: Write the failing test**

Target the live regions **by role** — the existing visual `saved-toast` always
contains the literal text "Settings saved" (only a CSS class toggles its
visibility), so a substring match on the rendered HTML would be a false
positive. Only the success `<LiveRegion>` carries `role="status"` and only the
error one carries `role="alert"`, so `getByRole` isolates them.

Create `src/components/dashboard/settings/__tests__/SettingsShell.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsShell } from '../SettingsShell';

describe('SettingsShell announcements (P1 #18)', () => {
  it('announces "Settings saved" in a polite status region when savedFlash is true', () => {
    render(<SettingsShell activeTab="general" savedFlash>body</SettingsShell>);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Settings saved');
  });

  it('keeps the polite status region empty when not flashing', () => {
    render(<SettingsShell activeTab="general">body</SettingsShell>);
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('announces a save error in an assertive alert region', () => {
    render(<SettingsShell activeTab="general" saveError="Network error">body</SettingsShell>);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(alert).toHaveTextContent('Network error');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/dashboard/settings/__tests__/SettingsShell.test.tsx`
Expected: FAIL — `Unable to find an accessible element with the role "status"` (no `<LiveRegion>` is rendered yet). All three tests drive/lock the change.

- [ ] **Step 3: Add `saveError` prop + render the LiveRegions**

In `src/components/dashboard/settings/SettingsShell.tsx`:

(a) Add the import at the top (after the existing imports, `:4`):

```tsx
import { LiveRegion } from '@/components/ui/LiveRegion';
```

(b) Add `saveError` to the `Props` interface (after `savedFlash?: boolean;`, `:16`):

```tsx
  /** Latest save-error message; announced assertively to screen readers. */
  saveError?: string;
```

(c) Add `saveError` to the destructured params (after `savedFlash,`, `:27`):

```tsx
  saveError,
```

(d) Replace the `saved-toast` block (`:74-76`) with the two always-mounted live regions plus the unchanged visual toast:

```tsx
      <LiveRegion message={savedFlash ? 'Settings saved' : ''} />
      <LiveRegion message={saveError ?? ''} level="assertive" />
      <div className={`saved-toast ${savedFlash ? 'visible' : ''}`}>
        <Icon name="check" size={14} /> Settings saved
      </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/dashboard/settings/__tests__/SettingsShell.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire `saveError` through SettingsClient**

In `src/app/(authenticated)/settings/SettingsClient.tsx`, the default single-location render (`:74-86`). Add `saveError={f.saveError}` to the `<SettingsShell>` props (after `savedFlash={f.savedFlash}`, `:78`):

```tsx
      savedFlash={f.savedFlash}
      saveError={f.saveError}
```

Leave the existing visual `{f.saveError && (<p .../>)}` block (`:99-101`) unchanged — the prop drives the announcement, the `<p>` drives the visual.

- [ ] **Step 6: Run typecheck + the settings test**

Run: `pnpm typecheck && pnpm vitest run src/components/dashboard/settings/__tests__/SettingsShell.test.tsx`
Expected: typecheck clean; 3 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/dashboard/settings/SettingsShell.tsx src/components/dashboard/settings/__tests__/SettingsShell.test.tsx "src/app/(authenticated)/settings/SettingsClient.tsx"
git commit -m "feat(a11y): announce settings save success/error to screen readers (P1 #18)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Connect/reconnect announcements

**Files:**
- Modify: `src/app/(authenticated)/dashboard/connect/page.tsx` (`:88-97`, `:214-216`)
- Test: `src/app/(authenticated)/dashboard/connect/__tests__/page.test.tsx`

Additive only — the existing red/gray error nodes keep their markup (the rebrand is the separate P0 #10). `role="alert"` is announced reliably even when inserted dynamically, which is why both connect announcements use `level="assertive"`.

- [ ] **Step 1: Add the failing test**

Append a new test to `src/app/(authenticated)/dashboard/connect/__tests__/page.test.tsx` (the file already mocks `useDashboardData`, `LocationContext`, and `next/navigation`):

```tsx
  it('announces a dashboard-data error to screen readers', () => {
    mockUseDashboardData.mockReturnValue({
      data: null,
      error: 'Could not load your connection status',
      refresh: vi.fn(),
    });

    render(<ConnectPage />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not load your connection status');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run "src/app/(authenticated)/dashboard/connect/__tests__/page.test.tsx"`
Expected: FAIL — `Unable to find an accessible element with the role "alert"` (the error branch renders an `<h2>`/`<p>`, no alert role).

- [ ] **Step 3: Announce the page error + actionError**

In `src/app/(authenticated)/dashboard/connect/page.tsx`:

(a) Add the import (with the other `@/` imports near the top of the file):

```tsx
import { LiveRegion } from '@/components/ui/LiveRegion';
```

(b) In the `error` early-return (`:88-97`), add the LiveRegion inside the returned wrapper, immediately after the opening `<div className="mx-auto max-w-2xl px-4 py-8">`:

```tsx
  if (error) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <LiveRegion message={error} level="assertive" />
        <div className="rounded-lg border border-red-300 bg-red-50 p-6">
          <h2 className="text-lg font-semibold text-red-800">Error</h2>
          <p className="mt-1 text-sm text-red-700">{error}</p>
        </div>
      </div>
    );
  }
```

(c) At the `actionError` render site (`:214-216`), add an always-mounted assertive region just before the existing conditional block. Locate:

```tsx
      {actionError && (
```
and insert immediately above it:

```tsx
      <LiveRegion message={actionError ?? ''} level="assertive" />
      {actionError && (
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run "src/app/(authenticated)/dashboard/connect/__tests__/page.test.tsx"`
Expected: PASS (all existing tests + the new announcement test).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(authenticated)/dashboard/connect/page.tsx" "src/app/(authenticated)/dashboard/connect/__tests__/page.test.tsx"
git commit -m "feat(a11y): announce connect errors to screen readers (P1 #18, additive to P0 #10)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Dashboard load/error announcements

**Files:**
- Modify: `src/components/DashboardContent.tsx` (`:63-99`)
- Test: `src/components/__tests__/DashboardContent.test.tsx`

The `error` and `loading` branches return before the heavy success children render, so the test only needs to mock the three pre-return hooks plus stub `TopBar`.

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/DashboardContent.test.tsx`:

```tsx
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const { mockUseDashboardData } = vi.hoisted(() => ({
  mockUseDashboardData: vi.fn(),
}));

vi.mock('@/hooks/useDashboardData', () => ({
  useDashboardData: (...args: unknown[]) => mockUseDashboardData(...args),
}));
vi.mock('@/contexts/LocationContext', () => ({
  useLocationScope: () => ({ currentScope: null, setLocationScope: vi.fn() }),
}));
vi.mock('@/components/dashboard/PendingCountContext', () => ({
  useSetPendingCount: () => vi.fn(),
}));
vi.mock('@/components/dashboard/TopBar', () => ({ TopBar: () => null }));

import { DashboardContent } from '../DashboardContent';

describe('DashboardContent announcements (P1 #18)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('announces a load error assertively', () => {
    mockUseDashboardData.mockReturnValue({
      data: null,
      error: 'Dashboard failed to load',
      loading: false,
      refresh: vi.fn(),
      scopeFallback: null,
    });

    render(<DashboardContent />);

    expect(screen.getByRole('alert')).toHaveTextContent('Dashboard failed to load');
  });

  it('announces the loading state politely', () => {
    mockUseDashboardData.mockReturnValue({
      data: null,
      error: null,
      loading: true,
      refresh: vi.fn(),
      scopeFallback: null,
    });

    render(<DashboardContent />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading your dashboard');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/__tests__/DashboardContent.test.tsx`
Expected: FAIL — no `alert`/`status` role found (the error/loading branches have none yet).

- [ ] **Step 3: Add the announcements**

In `src/components/DashboardContent.tsx`:

(a) Add the import (with the other `@/components` imports, near `:13`):

```tsx
import { LiveRegion } from '@/components/ui/LiveRegion';
```

(b) In the `error` branch (`:63-81`), add the assertive region just inside the `<div className="content">`:

```tsx
        <div className="content">
          <LiveRegion message={error} level="assertive" />
          <div className="card" style={{ borderColor: '#FCA5A5', background: '#FEF2F2' }}>
```

(c) In the `loading` branch (`:84`), add the polite region just inside the `<div className="content">`:

```tsx
        <div className="content">
          <LiveRegion message="Loading your dashboard…" />
          <div className="dashboard-skeleton">
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/__tests__/DashboardContent.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/DashboardContent.tsx src/components/__tests__/DashboardContent.test.tsx
git commit -m "feat(a11y): announce dashboard load/error to screen readers (P1 #18)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Update the launch audit doc + full verification

**Files:**
- Modify: `docs/launch-ready-part2.md`

- [ ] **Step 1: Mark item #18 done**

In `docs/launch-ready-part2.md`, update the prioritized fix-list item **#18** (`:153`) to reflect completion, keeping the existing tick-mark/PR-annotation convention. Replace the line beginning `18. Add **\`aria-live\`** regions…` with:

```markdown
18. ✅ Add **`aria-live`** regions + **`focus-visible`** styles + **`type="button"`** on dot-nav. — **DONE (this PR):** new reusable `<LiveRegion>` sr-only primitive (`src/components/ui/LiveRegion.tsx`) wired into the three named Console surfaces — settings save success/error (`SettingsShell`/`SettingsClient`), connect-page data + action errors (`dashboard/connect`, additive to P0 #10), and dashboard load/error (`DashboardContent`); teal `:focus-visible` rings on the marketing `.rw-dot-nav`/`.pr-toggle`/`.pr-faq-q`, the `PageShell` dot-nav, and `SiteNav` links (reusing the existing `.pr-matrix` outline pattern); `type="button"` was already in place and stays locked by the `PageShell` test. CSS-contract + component tests added.
```

- [ ] **Step 2: Update the Accessibility section bullets**

In the `♿ Accessibility (cross-cutting)` section, update the two relevant bullets (`:112`, `:113`):

- The `No aria-live/role="status"` bullet (`:112`): append to its existing `→ PARTIAL (PR #160)` note:
  ```markdown
   Settings save (success + error), connect data/action errors, and dashboard load/error now announce via the shared `<LiveRegion>` (this PR); remaining low-traffic surfaces still pending.
  ```
- The `No focus-visible styles` bullet (`:113`): prefix with `✅` and append:
  ```markdown
   → **DONE (this PR):** teal `:focus-visible` rings added to the dot navs, pricing toggle, FAQ accordions, and SiteNav links.
  ```

- [ ] **Step 3: Full verification gate**

Run, in order, and confirm each is green:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Expected: lint clean; typecheck clean; full Vitest suite passes (prior baseline was green; this adds ~5 new test files and extends 2). If any pre-existing unrelated failure appears, stop and report it rather than "fixing" out-of-scope code.

- [ ] **Step 4: Commit**

```bash
git add docs/launch-ready-part2.md
git commit -m "docs(launch-audit): mark P1 #18 (aria-live + focus-visible) complete

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- focus-visible on dot nav → Tasks 2 (`.rw-dot-nav`) + 3 (`PageShell`). ✓
- focus-visible on pricing toggle, FAQ → Task 2. ✓
- focus-visible on SiteNav links → Task 4. ✓
- `<LiveRegion>` primitive → Task 1. ✓
- Settings save success + error → Task 5. ✓
- Connect/reconnect (additive, P0 #10 boundary) → Task 6. ✓
- Dashboard load/error → Task 7. ✓
- `type="button"` already-done, locked by test → covered by existing PageShell test (verified Task 3 keeps it green). ✓
- Docs update → Task 8. ✓

**Placeholder scan:** No TBD/TODO; every code/CSS step shows the literal content; the dashboard loading text is the concrete string `Loading your dashboard…`. ✓

**Type consistency:** `LiveRegion` props (`message: string`, `level?: 'polite' | 'assertive'`) are referenced identically in Tasks 1, 5, 6, 7. `SettingsShell` gains `saveError?: string`, passed as `saveError={f.saveError}` (string | undefined → optional prop). ✓

**Out of scope (unchanged):** `dashboard/connect` visual rebrand (P0 #10); aria-live beyond the three named surfaces; ARIA tab semantics (P2 #27); tap-target sizing (P2); per-page metadata (#19).
```
