# Shared Marketing Chrome — `SiteShell` + `SiteFooter`

- **Date:** 2026-06-18
- **Status:** Approved (design); ready for implementation plan
- **Scope:** Public marketing pages — landing, how-it-works, features, pricing
- **Author:** brainstormed with the owner

## Problem

The marketing-site "chrome" — the white **island** container, the **navbar**
(`SiteNav`), and the **footer** — is re-declared inline in each page's content
component. Three consequences:

1. **Footer drift / gap.** The footer is rendered only on the landing page. It
   is absent on how-it-works, features, and pricing.
2. **Island/nav duplication.** The `rw-island-wrap > rw-island` markup and the
   `<SiteNav>` element are copy-pasted into all four content components. They are
   visually identical today, but nothing prevents them from drifting apart.
3. **No single owner.** Changing the island radius/width or the footer links
   means editing four files.

The marquee background (`MarqueeBackground`) is already common across the four
pages, so it is in scope only as part of the shared shell.

## Goals

- One authoritative component that owns the marketing chrome (marquee + island +
  navbar + footer), used by all four marketing pages.
- The footer appears on **all four** pages.
- Adding a future marketing page reuses the same island by composing one
  component — no chrome duplication.
- **Zero visual change** to the existing pages, other than the three pages
  gaining the (already-styled) footer.

## Non-goals

- **Auth pages** (login, signup, forgot/reset-password) keep their separate
  island. `auth-island.css` defines its own `.rw-island` (1080px, two-column
  grid) for the split login layout; converging it is explicitly out of scope.
- **Other public pages** (security, book-a-demo, legal/\*) are unchanged. The
  shell is reusable by them later, but this change does not touch them.
- No CSS refactor. Page-scope classes and global island/footer CSS stay as-is.

## Current state (verified)

All four pages share this structure inside their content component. `SiteNav` is
the **first child of the island**; the footer (landing only) is the **last
child**:

```
<div className="{page-scope}">        // rw-landing | hiw-page | rw-feat-page | pr-page
  <MarqueeBackground />               // already common
  {overlay}                          // landing only: <div className="rw-dot-nav">
  <div className="rw-island-wrap">
    <IslandTag className="rw-island"> // <main> on features, <div> elsewhere
      <SiteNav comingSoon? selfServeEnabled />
      {page content}
      <footer className="rw-foot">    // LANDING ONLY today
    </IslandTag>
  </div>
</div>
```

Verified facts that make this low-risk:

- `.rw-island`, `.rw-island-wrap`, and `.rw-foot` are **global** CSS (not scoped
  under `.rw-landing`), so reusing the footer on other pages needs **zero CSS
  changes**.
- The page-scope class (`rw-landing`, `hiw-page`, `rw-feat-page`, `pr-page`) is
  the **outermost** wrapper; page-specific CSS depends on the island remaining a
  descendant of it. The shared component therefore keeps the scope class on the
  page-controlled wrapper.
- Footer links target `/legal/privacy` and `/legal/terms`, which are valid
  routes (with redirects from `/privacy` and `/terms` in `next.config.mjs`).
- Island dimensions are already identical across the four pages
  (`max-width: 1200px`, `border-radius: 48px`, shared `.rw-island`). The
  perceived "different lengths" is natural content-height variation, not island
  sizing.

## Design

### New components (both under `src/components/ui/`, matching `SiteNav.tsx`)

#### `SiteFooter.tsx`

Extracted verbatim from `LandingContent` (the current `<footer className="rw-foot">`
block). No props.

- Renders `© {year} RepWorth. All rights reserved.` with `suppressHydrationWarning`
  on the year span (preserves current SSR behavior).
- Privacy + Terms links via `next/link` to `/legal/privacy` and `/legal/terms`.
- Relies on the existing global `.rw-foot` CSS — no new styles.

#### `SiteShell.tsx`

The single owner of the marketing chrome. A plain composition component (no
hooks → no `'use client'` directive needed; safe to import from the existing
client content components).

Props:

| Prop | Type | Notes |
|---|---|---|
| `scope` | `string` | Page-scope class applied to the outer wrapper (e.g. `'hiw-page'`). |
| `selfServeEnabled` | `boolean \| undefined` | Forwarded to `SiteNav`. |
| `comingSoon` | `boolean \| undefined` | Forwarded to `SiteNav`. Optional — pricing omits it today, preserving current behavior. |
| `overlay` | `ReactNode \| undefined` | Rendered between the marquee and the island wrap. Used for landing's `rw-dot-nav`; omitted elsewhere. |
| `islandAs` | `'main' \| 'div'` | Defaults to `'div'`. Features passes `'main'` to preserve its `<main>` landmark exactly. |
| `children` | `ReactNode` | Page content, rendered between nav and footer inside the island. |

Rendered structure (identical to current DOM per page):

```tsx
<div className={scope}>
  <MarqueeBackground />
  {overlay}
  <div className="rw-island-wrap">
    <IslandTag className="rw-island">  {/* IslandTag = islandAs */}
      <SiteNav comingSoon={comingSoon} selfServeEnabled={selfServeEnabled} />
      {children}
      <SiteFooter />
    </IslandTag>
  </div>
</div>
```

### Per-page edits (4 content components)

Each page drops its inline chrome (outer scope `<div>`, `MarqueeBackground`,
island wrap, `SiteNav`, and — on landing — the inline `<footer>`) and wraps its
content in `SiteShell`. Flags are still read in each `page.tsx` and threaded
through unchanged.

| File | Change |
|---|---|
| `src/components/sections/landing/LandingContent.tsx` | Wrap in `<SiteShell scope="rw-landing" comingSoon={comingSoon} selfServeEnabled={selfServeEnabled} overlay={<dot-nav/>}>`. Remove inline marquee, island wrap, `<SiteNav>`, and inline `<footer>`. The `rw-dot-nav` (with its `useSyncExternalStore` scroll state) stays in `LandingContent` and is passed as `overlay`. |
| `src/components/sections/how-it-works/HowItWorksContent.tsx` | Wrap content in `<SiteShell scope="hiw-page" comingSoon={comingSoon} selfServeEnabled={selfServeEnabled}>`. Remove inline marquee/island/nav. **Gains footer.** |
| `src/components/sections/features/FeaturesContent.tsx` | Same, `scope="rw-feat-page"` + `islandAs="main"` (preserves the `<main>` element). **Gains footer.** |
| `src/app/(public)/pricing/PricingContent.tsx` | Same, `scope="pr-page"`, passing only `selfServeEnabled` (no `comingSoon`, preserving today's nav behavior). **Gains footer.** |

> During implementation, confirm how-it-works and features have no element
> between marquee and island other than the landing dot-nav; if they do, route it
> through the `overlay` prop.

### Extensibility (future pages)

A new marketing page composes the shell and inherits all chrome:

```tsx
<SiteShell scope="rw-whatever" selfServeEnabled={selfServeEnabled}>
  {/* page content only — island, nav, footer, marquee all handled */}
</SiteShell>
```

It only supplies a `scope` class (if it has page-specific CSS) and flags (if its
nav depends on them). Island/nav/footer/marquee are inherited. Changing the
island or footer in one file updates every page at once.

## Risk

DOM output per page is byte-for-byte identical to today — same scope class, same
island element (via `islandAs`), same nav, same overlay — **except** the three
non-landing pages now also render the already-global `.rw-foot` footer, which is
the requested change. No CSS is added or modified.

## Verification

1. `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
2. Visually confirm (dev server / chrome-devtools) that the footer now appears on
   how-it-works, features, and pricing, and that the island + navbar are
   unchanged on all four pages.
3. Since this runs in a nested worktree (untrustworthy for full local CI per
   project convention), treat the **pushed-branch GitHub CI** (`lint`,
   `typecheck`, `test`, `build`) as the authoritative gate before merge.

## Testing

- Optional `SiteShell` Vitest component test (if the repo has a React Testing
  Library setup): asserts the navbar, footer, and `children` render and that the
  `scope` class is applied to the outer wrapper. This guards the "footer appears
  on every page" invariant against future regression.
- If no component-test harness exists, rely on build + visual verification above.
