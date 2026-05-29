# Launch P1 #17 — MobileTabBar active state + save-bar width token — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the mobile "Needs Action" tab reflect its active state, and replace the save-bar's hardcoded `left: 240px` with a shared `--rw-sidebar-width` token.

**Architecture:** Two independent fixes in the Console (owner dashboard) surface. (1) M6: introduce one CSS custom property as the single source of truth for the sidebar width, referenced by both `.sidebar` (width) and `.save-bar` (left offset). (2) M8: track the URL hash inside `MobileTabBar` (mount read + `hashchange`/`popstate` listeners + optimistic `onClick`) so Home vs. Needs Action — which share the `/dashboard` route — light up by hash. No island treatment (brand skill exempts dashboard); Console blue accent unchanged.

**Tech Stack:** Next.js 16 App Router (`'use client'`, `usePathname`, `next/link`), React 19, plain CSS (`src/app/(authenticated)/_styles/*`), Vitest 4 + @testing-library/react + jsdom.

**Spec:** `docs/superpowers/specs/2026-05-29-launch-p1-17-tabbar-savebar-design.md`

**Workspace / verification note:** Work happens in the nested worktree at
`.claude/worktrees/fix+launch-p1-17-tabbar-savebar`. Per project CLAUDE.md, local
lint/test from a nested worktree is unreliable (module resolution leaks to the
parent). Targeted `pnpm test <file>` runs are used here for fast TDD red/green
feedback (verified working), but the **authoritative gate is CI** (`lint`,
`typecheck`, `test`, `build`) on the pushed PR.

> ⚠️ **Worktree path gotcha:** Write/Edit tools take absolute paths. Use the
> **worktree-absolute** base
> `/Users/norbertesekiel/Developer/startups/RepWorth/.claude/worktrees/fix+launch-p1-17-tabbar-savebar/…`
> — a parent-absolute path silently writes to `main`'s working tree instead.

---

## Task 1: M6 — Single-source `--rw-sidebar-width` token

Replace the two independent `240px` literals (sidebar width, save-bar left) with one
token. No rendered change today; this locks the coupling against future drift.

**Files:**
- Test (create): `src/__tests__/save-bar-sidebar-width.test.ts`
- Modify: `src/app/(authenticated)/_styles/tokens.css` (Console palette `:root` section)
- Modify: `src/app/(authenticated)/_styles/console.css:22-24` (`.sidebar`)
- Modify: `src/app/(authenticated)/_styles/settings.css:466-468` (`.save-bar`)

- [ ] **Step 1: Write the failing CSS-contract test**

Create `src/__tests__/save-bar-sidebar-width.test.ts` (default `node` environment —
no jsdom directive needed; it only reads files). Mirrors the existing
`src/__tests__/island-overflow.test.ts` pattern.

```ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// M6: the sticky save-bar's `left` offset must equal the sidebar width. That
// equality was previously enforced by two independent literal `240px` values
// (console.css `.sidebar`, settings.css `.save-bar`). This guard locks them to a
// single `--rw-sidebar-width` token so they can never drift.
const TOKENS = resolve(process.cwd(), 'src/app/(authenticated)/_styles/tokens.css');
const CONSOLE = resolve(process.cwd(), 'src/app/(authenticated)/_styles/console.css');
const SETTINGS = resolve(process.cwd(), 'src/app/(authenticated)/_styles/settings.css');

function read(path: string): string {
  return readFileSync(path, 'utf-8');
}

// Return the body of the FIRST `<selector> { ... }` rule (non-greedy to the first
// closing brace — these blocks have no nested braces). The negative lookahead
// stops `.sidebar` from matching `.sidebar-spacer` and `.save-bar` from matching
// `.save-bar-text`, and keeps us on the base rule rather than an @media override.
function ruleBlock(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}(?![\\w-])\\s*\\{([\\s\\S]*?)\\}`));
  if (!match || match[1] === undefined) {
    throw new Error(`${selector} rule block not found`);
  }
  return match[1];
}

describe('save-bar / sidebar share one --rw-sidebar-width token (M6)', () => {
  it('tokens.css defines --rw-sidebar-width', () => {
    expect(read(TOKENS)).toMatch(/--rw-sidebar-width\s*:/);
  });

  it('.save-bar offsets left by the token, not a hardcoded 240px', () => {
    const block = ruleBlock(read(SETTINGS), '.save-bar');
    expect(block).toMatch(/left\s*:\s*var\(--rw-sidebar-width\)/);
    expect(block).not.toMatch(/left\s*:\s*240px/);
  });

  it('.sidebar derives its width and flex-basis from the token', () => {
    const block = ruleBlock(read(CONSOLE), '.sidebar');
    expect(block).toMatch(/width\s*:\s*var\(--rw-sidebar-width\)/);
    expect(block).toMatch(/flex\s*:\s*0\s+0\s+var\(--rw-sidebar-width\)/);
    expect(block).not.toMatch(/240px/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/__tests__/save-bar-sidebar-width.test.ts`
Expected: FAIL — `tokens.css defines --rw-sidebar-width` fails (token absent);
`.save-bar` fails (`left: 240px` present, no `var(...)`); `.sidebar` fails
(`240px` present).

- [ ] **Step 3: Add the token to `tokens.css`**

In `src/app/(authenticated)/_styles/tokens.css`, inside the `:root` block, in the
`/* ---------- App palette ("Console") ---------- */` section, add the token after
the text tokens. Replace:

```css
  --rw-app-text-soft:   #9CA3AF;  /* gray-400 */
```

with:

```css
  --rw-app-text-soft:   #9CA3AF;  /* gray-400 */

  /* App layout — sidebar width. The sticky save-bar's `left` offset derives
     from this token so the two can never drift (M6). */
  --rw-sidebar-width:   240px;
```

- [ ] **Step 4: Point `.sidebar` at the token in `console.css`**

In `src/app/(authenticated)/_styles/console.css`, replace:

```css
.sidebar {
  width: 240px;
  flex: 0 0 240px;
```

with:

```css
.sidebar {
  width: var(--rw-sidebar-width);
  flex: 0 0 var(--rw-sidebar-width);
```

- [ ] **Step 5: Point `.save-bar` at the token in `settings.css`**

In `src/app/(authenticated)/_styles/settings.css`, replace:

```css
.save-bar {
  position: fixed;
  left: 240px;
```

with:

```css
.save-bar {
  position: fixed;
  left: var(--rw-sidebar-width);
```

(Leave the `@media (max-width: 768px)` `.save-bar { left: 0; … }` override untouched.)

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm test src/__tests__/save-bar-sidebar-width.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/__tests__/save-bar-sidebar-width.test.ts \
  "src/app/(authenticated)/_styles/tokens.css" \
  "src/app/(authenticated)/_styles/console.css" \
  "src/app/(authenticated)/_styles/settings.css"
git commit -m "fix(console): single-source --rw-sidebar-width for sidebar + save-bar (M6, P1 #17)

The save-bar's left offset must equal the sidebar width; that equality was two
independent 240px literals. Introduce --rw-sidebar-width and reference it from
both .sidebar and .save-bar. No rendered change (both already flip at the 768px
breakpoint together) — removes the magic-number coupling. CSS-contract test locks it.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: M8 — Hash-aware `MobileTabBar` active state

Home (`/dashboard`) and Needs Action (`/dashboard#needs-action`) share one route;
`usePathname()` strips the hash, and the Needs Action `<Link>` has no active logic at
all. Track the hash in the component so exactly one of the two lights up.

**Files:**
- Test (create): `src/components/dashboard/__tests__/MobileTabBar.test.tsx`
- Modify: `src/components/dashboard/MobileTabBar.tsx`

- [ ] **Step 1: Write the failing component test**

Create `src/components/dashboard/__tests__/MobileTabBar.test.tsx`. Patterns copied
from `SettingsTabs.test.tsx` (next/link plain-anchor mock) and `Sidebar.test.tsx`
(jsdom + next/navigation mock). `usePathname` is made per-test-controllable via
`vi.hoisted`. `usePendingCount` needs no provider — its context default returns `0`.

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MobileTabBar } from '../MobileTabBar';

// Per-test control of the route. vi.hoisted runs before the hoisted vi.mock factory.
const { pathnameMock } = vi.hoisted(() => ({
  pathnameMock: vi.fn<() => string>(() => '/dashboard'),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameMock(),
}));

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

const linkByName = (name: RegExp) => screen.getByRole('link', { name });

afterEach(() => {
  pathnameMock.mockReturnValue('/dashboard');
  window.location.hash = '';
});

describe('MobileTabBar — active tab state (M8)', () => {
  it('marks Home active on bare /dashboard (no hash)', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<MobileTabBar pastRepliesEnabled />);
    expect(linkByName(/home/i)).toHaveClass('active');
    expect(linkByName(/needs action/i)).not.toHaveClass('active');
  });

  it('marks Needs Action active when the hash is #needs-action on mount', () => {
    pathnameMock.mockReturnValue('/dashboard');
    window.location.hash = '#needs-action';
    render(<MobileTabBar pastRepliesEnabled />);
    expect(linkByName(/needs action/i)).toHaveClass('active');
    expect(linkByName(/home/i)).not.toHaveClass('active');
  });

  it('activates Needs Action immediately on tap, without a hashchange event', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<MobileTabBar pastRepliesEnabled />);
    expect(linkByName(/home/i)).toHaveClass('active');
    act(() => {
      linkByName(/needs action/i).click();
    });
    expect(linkByName(/needs action/i)).toHaveClass('active');
    expect(linkByName(/home/i)).not.toHaveClass('active');
  });

  it('responds to hashchange events (browser back/forward)', () => {
    pathnameMock.mockReturnValue('/dashboard');
    render(<MobileTabBar pastRepliesEnabled />);
    expect(linkByName(/home/i)).toHaveClass('active');
    act(() => {
      window.location.hash = '#needs-action';
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(linkByName(/needs action/i)).toHaveClass('active');
    act(() => {
      window.location.hash = '';
      window.dispatchEvent(new Event('hashchange'));
    });
    expect(linkByName(/home/i)).toHaveClass('active');
  });

  it('marks History active on /dashboard/past-replies; not Home/Needs Action', () => {
    pathnameMock.mockReturnValue('/dashboard/past-replies');
    render(<MobileTabBar pastRepliesEnabled />);
    expect(linkByName(/history/i)).toHaveClass('active');
    expect(linkByName(/home/i)).not.toHaveClass('active');
    expect(linkByName(/needs action/i)).not.toHaveClass('active');
  });

  it('marks Settings active on /settings; not Home/Needs Action', () => {
    pathnameMock.mockReturnValue('/settings');
    render(<MobileTabBar pastRepliesEnabled />);
    expect(linkByName(/settings/i)).toHaveClass('active');
    expect(linkByName(/home/i)).not.toHaveClass('active');
    expect(linkByName(/needs action/i)).not.toHaveClass('active');
  });

  it('removes hashchange and popstate listeners on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<MobileTabBar pastRepliesEnabled />);
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('hashchange', expect.any(Function));
    expect(removeSpy).toHaveBeenCalledWith('popstate', expect.any(Function));
    removeSpy.mockRestore();
  });
});
```

> Note: clicking a mocked `<a href="/dashboard#needs-action">` in jsdom may log a
> benign "Not implemented: navigation" message. It does not throw and the test
> passes — the React `onClick` (our optimistic `setHash`) runs before the default
> action.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/components/dashboard/__tests__/MobileTabBar.test.tsx`
Expected: FAIL — "Needs Action active on mount", "activates immediately on tap",
"responds to hashchange", and "removes listeners on unmount" all fail against the
current component (it has no hash tracking and no active class on Needs Action).
The Home / History / Settings cases pass with the old code.

- [ ] **Step 3: Implement hash-aware active state**

Replace the entire body of `src/components/dashboard/MobileTabBar.tsx` with:

```tsx
'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { usePendingCount } from './PendingCountContext';

const NEEDS_ACTION_HASH = '#needs-action';

interface Props {
  pastRepliesEnabled: boolean;
  /** Server-authoritative — requires pastRepliesEnabled. Read at layout level. */
  editRepliesEnabled?: boolean;
}

export function MobileTabBar({ pastRepliesEnabled, editRepliesEnabled = false }: Props) {
  const pathname = usePathname() ?? '';
  const pendingCount = usePendingCount();

  // Home and "Needs Action" both live on /dashboard; the URL hash is the only
  // differentiator. usePathname() drops the hash and Next's <Link> pushState
  // navigation does not reliably emit `hashchange`, so we track the hash here:
  // a mount read seeds it, hashchange/popstate cover back/forward + deep links,
  // and an optimistic onClick gives instant tap feedback.
  const [hash, setHash] = useState('');
  useEffect(() => {
    const sync = () => setHash(window.location.hash);
    sync();
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  const onDashboard = pathname === '/dashboard';
  const isNeedsAction = onDashboard && hash === NEEDS_ACTION_HASH;
  const isHome = onDashboard && !isNeedsAction;
  const isHistory = pathname === '/dashboard/past-replies';
  const isSettings = pathname.startsWith('/settings');

  return (
    <nav className="mobile-tabbar">
      <Link
        href="/dashboard"
        className={`mtab ${isHome ? 'active' : ''}`}
        onClick={() => setHash('')}
      >
        <Icon name="home" size={22} /> Home
      </Link>
      <Link
        href={`/dashboard${NEEDS_ACTION_HASH}`}
        className={`mtab ${isNeedsAction ? 'active' : ''}`}
        onClick={() => setHash(NEEDS_ACTION_HASH)}
      >
        <Icon name="inbox" size={22} /> Needs Action
        {pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
      </Link>
      {pastRepliesEnabled && (
        <Link href="/dashboard/past-replies" className={`mtab ${isHistory ? 'active' : ''}`}>
          <Icon name="history" size={22} /> History
        </Link>
      )}
      <Link href="/settings" className={`mtab ${isSettings ? 'active' : ''}`}>
        <Icon name="cog" size={22} /> Settings
      </Link>
    </nav>
  );
}
```

Changes vs. the original: import `useEffect`/`useState`; add the `NEEDS_ACTION_HASH`
constant; track `hash` and derive `onDashboard`/`isNeedsAction`/`isHome`; add
`active` class + `onClick` to the Home and Needs Action links. History/Settings tabs
and the `editRepliesEnabled` prop are unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/components/dashboard/__tests__/MobileTabBar.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/dashboard/MobileTabBar.tsx \
  src/components/dashboard/__tests__/MobileTabBar.test.tsx
git commit -m "fix(dashboard): hash-aware active state for the Needs Action mobile tab (M8, P1 #17)

Home and Needs Action share /dashboard; the #needs-action hash is the only
differentiator and usePathname() strips it, so the tab could never highlight.
Track the hash in MobileTabBar (mount read + hashchange/popstate listeners +
optimistic onClick) and light Home vs. Needs Action by hash. Contained to the
component; Console blue accent and the scroll-on-navigation behavior unchanged.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Verify, push, and open the PR

The two fixes are independent and complete. Validate locally for a fast signal,
then defer to CI as the authoritative gate.

- [ ] **Step 1: Run both new test files together**

Run: `pnpm test src/__tests__/save-bar-sidebar-width.test.ts src/components/dashboard/__tests__/MobileTabBar.test.tsx`
Expected: PASS (10 tests total: 3 + 7).

- [ ] **Step 2: Sanity-check the two existing nav/CSS guards still pass**

Run: `pnpm test src/components/dashboard/__tests__/Sidebar.test.tsx src/__tests__/island-overflow.test.ts`
Expected: PASS (no regression in the sibling nav/island contracts).

- [ ] **Step 3: Confirm the diff is minimal and on-scope**

Run: `git diff --stat origin/main...HEAD`
Expected: only `tokens.css`, `console.css`, `settings.css`, `MobileTabBar.tsx`, the
two new test files, and the spec/plan docs. No other files touched.

- [ ] **Step 4: Push and open the PR**

Use the **superpowers:finishing-a-development-branch** skill to push the branch and
open a PR against `main`. PR body should reference launch-ready-part2.md #17 (M6 +
M8), note "no rendered change for M6 / behavior-only for M8", and request the 4 CI
checks (`lint`, `typecheck`, `test`, `build`) as the authoritative gate. Do **not**
mark #17 done in `launch-ready-part2.md` here — that doc edit lands on `main` via its
own follow-up commit after merge (matching the established PR-annotation cadence).

- [ ] **Step 5: Watch CI to green**

Read the runner on the PR (do not trust nested-worktree local lint/build). All four
checks must pass before the work is considered complete.

---

## Notes for the implementer

- **Out of scope** (do not expand): ARIA `role="tab"`/arrow-key nav and tap-target
  sizing (both P2 #27); the redundant mount-only hash `useEffect` in
  `DashboardContent`/`AggregateDashboardContent` (works today via Next's hash scroll
  + the `'needs'` default); the `.mtab.active` blue color (correct for Console).
- **Token discipline:** no amber/orange/stone; no island treatment on dashboard.
- **Do not** collapse the two same-route tabs or change the `/dashboard#needs-action`
  URL contract — `DashboardContent` reads `window.location.hash`.
