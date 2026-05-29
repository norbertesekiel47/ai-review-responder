# Launch P1 #17 — MobileTabBar active state + save-bar width coupling

**Status:** Design approved · **Date:** 2026-05-29 · **Branch:** `worktree-fix+launch-p1-17-tabbar-savebar`

Resolves the two sub-items of prioritized fix #17 in `docs/launch-ready-part2.md`
(P1 — "Noticeable, fix before/at launch"):

- **M8** (`MobileTabBar.tsx:26`) — the "Needs Action" mobile tab can never show its
  active state.
- **M6** (`settings.css:468`) — the sticky save-bar's `left: 240px` is a hardcoded
  duplicate of the sidebar width.

Both surfaces are in the **Console** (owner dashboard). The RepWorth brand skill
exempts admin/owner-dashboard pages from the marketing "island" treatment, so this
work preserves the existing Console gray/white/**blue** vocabulary. No island.

---

## M8 — Hash-aware "Needs Action" tab active state

### Problem

`MobileTabBar` renders four tabs: Home (`/dashboard`), Needs Action
(`/dashboard#needs-action`), History (`/dashboard/past-replies`), Settings
(`/settings`). Active state is derived from `usePathname()`:

```tsx
const isHome = pathname === '/dashboard';
// ...
<Link href="/dashboard#needs-action" className="mtab">  // no active logic at all
```

Two facts make the "Needs Action" tab permanently dim:

1. The `<Link>` for "Needs Action" has **no** conditional `active` class.
2. Even if it did, `usePathname()` **strips the hash** — so the page cannot tell
   "Home" (`/dashboard`) from "Needs Action" (`/dashboard#needs-action`). They are
   the **same route**; the hash is the only differentiator.

Nothing else about the tab is broken: `ReviewsCard` already defaults
`initialTab = 'needs'`, and Next's router scrolls to the `#needs-action` anchor on
hash navigation. The defect is purely the tab-bar highlight.

### Behavior

On the dashboard route, exactly one of Home / Needs Action is active, decided by the
URL hash:

```
onDashboard   = pathname === '/dashboard'
isNeedsAction = onDashboard && hash === '#needs-action'
isHome        = onDashboard && !isNeedsAction
```

- Bare `/dashboard` (or any non-matching hash) → **Home** active.
- `/dashboard#needs-action` → **Needs Action** active, Home not.
- `/dashboard/past-replies` → **History** active; Home/Needs Action inactive.
- `/settings…` → **Settings** active; Home/Needs Action inactive.

### Mechanism (chosen: onClick + listener)

`usePathname()` does not re-render on hash-only changes, and Next's `<Link>`
pushState navigation does not reliably emit a `hashchange` event. So the component
tracks the hash itself, using two complementary signals:

- **Optimistic `onClick`** on the two same-route tabs (`setHash('#needs-action')` /
  `setHash('')`) — gives instant, reliable highlight on tap regardless of Next
  internals.
- **`hashchange` + `popstate` listeners** (added in a `useEffect`, read
  `window.location.hash`, cleaned up on unmount) — cover browser back/forward and
  deep links.
- **Mount read** of `window.location.hash` seeds initial state. On the server / first
  paint `hash` is `''`, so Home is the default-active tab; a deep link to
  `#needs-action` corrects on mount (acceptable: this is a `'use client'`,
  mobile-only component).

This is contained entirely to `MobileTabBar.tsx`. It does **not** depend on any
undocumented Next.js behavior, which is why it is preferred over a listener-only
approach. It also avoids changing the URL contract (a query-param approach would
have forced edits to `DashboardContent` + `AggregateDashboardContent`, which read
`window.location.hash`, plus introduce a server-visible query param).

### Tests (`MobileTabBar.test.tsx`)

React Testing Library + jsdom; mock `usePathname` and the `usePendingCount` context.

1. Bare `/dashboard` → Home tab has `.active`, Needs Action does not.
2. `/dashboard` with `window.location.hash === '#needs-action'` → Needs Action
   `.active`, Home not.
3. Clicking "Needs Action" applies `.active` **immediately** (no `hashchange`
   dispatched) — proves the optimistic path.
4. Dispatching a `hashchange` event (hash set to `#needs-action`, then cleared)
   flips the active tab — proves the listener path / back-forward.
5. `/dashboard/past-replies` → History active; Home + Needs Action inactive.
6. `/settings` → Settings active; Home + Needs Action inactive.
7. Listeners are removed on unmount (no leaked `hashchange`/`popstate` handlers).

---

## M6 — Single source of truth for the sidebar width

### Problem

```css
/* console.css */
.sidebar { width: 240px; flex: 0 0 240px; }   /* :22-24 */

/* settings.css */
.save-bar { left: 240px; }                     /* :468 */
```

The save-bar's `left` offset must equal the sidebar's width so the bar aligns with
the content column. That equality is enforced only by two independent literal
`240px` values — change the sidebar width and the save-bar silently misaligns.

**Verified:** the audit's "breaks at 769–800px before the 768px breakpoint" claim
does **not** reproduce. The sidebar (`display:none`) and the save-bar (`left:0`)
both flip at the **same** `@media (max-width: 768px)` breakpoint, so they are aligned
at every viewport today. This is a DRY / coupling fix, not a live visual-bug fix —
zero rendered change expected.

### Change

Introduce one token and reference it from both rules:

```css
/* tokens.css — Console palette section, on :root */
--rw-sidebar-width: 240px;

/* console.css */
.sidebar { width: var(--rw-sidebar-width); flex: 0 0 var(--rw-sidebar-width); }

/* settings.css */
.save-bar { left: var(--rw-sidebar-width); }
```

Defined on `:root`, the custom property cascades to `.save-bar` even though it is
`position: fixed` — the bar is still a DOM descendant of `.rw-console`. The existing
`@media (max-width: 768px)` override (`.save-bar { left: 0 }`) is untouched.

### Test (CSS contract, mirrors `src/__tests__/island-overflow.test.ts`)

Read the CSS files and assert the single-source invariant so it cannot regress:

1. `tokens.css` defines `--rw-sidebar-width`.
2. `settings.css` `.save-bar` sets `left: var(--rw-sidebar-width)` and contains no
   hardcoded `left: 240px`.
3. `console.css` `.sidebar` references `var(--rw-sidebar-width)` for both `width`
   and `flex-basis`.

---

## Out of scope (explicit)

- ARIA `role="tab"`/`role="tablist"`/`aria-selected` + arrow-key nav on the tab bar
  — separate P2 item #27.
- Tap-target sizing (dot nav / tab bar < 44×44px) — separate P2 item #27.
- The redundant mount-only hash `useEffect` in `DashboardContent` /
  `AggregateDashboardContent` — works today via Next's hash scroll + the `'needs'`
  default; not touched.
- The Console `.mtab.active { color: var(--rw-blue-600) }` accent — correct for the
  Console palette; unchanged.

## Verification

Per project CLAUDE.md, nested-worktree local lint/test is unreliable (module
resolution leaks to the parent). Local Vitest runs are used for fast TDD red/green
feedback only; **CI (`lint`, `typecheck`, `test`, `build`) on the pushed PR is the
authoritative gate.**
