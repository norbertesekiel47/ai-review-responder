# Launch P1 #13 — Mobile hamburger nav for `SiteNav`

**Date:** 2026-05-29
**Audit item:** `docs/launch-ready-part2.md` — Prioritized fix list, **P1 #13** ("Add a mobile nav (hamburger) to `SiteNav`"); mobile table row **M1** (`src/components/ui/SiteNav.tsx:33`).
**Branch / worktree:** `fix/launch-p1-13-sitenav-mobile-nav` (external worktree, own `node_modules`).

## Problem

`SiteNav` is the public marketing navigation, rendered on ~9 public pages
(landing, features, how-it-works, pricing, security, demo, help/contact,
book-a-demo, legal). Its primary nav links live inside a `hidden sm:flex`
container, so **below 640px the Features / How it works / Pricing links
disappear with no alternative way to reach them**. On a phone the public site
has no working primary navigation.

`AdminNav` already solves this for the internal console with a hamburger +
dropdown, but in the internal gray palette — it is not reusable for the
brand-styled public nav.

## Goals

- Below 640px, expose the existing nav links (and, when self-serve auth is
  enabled, Log in / Sign up) via a hamburger toggle + dropdown panel.
- Zero change to the desktop (≥640px) layout and appearance.
- Full RepWorth brand + accessibility compliance.
- Fold in the adjacent P1 accessibility gap on the same element: **no
  `focus-visible` styles on `SiteNav` links** (audit line 113).

## Non-goals (explicitly out of scope)

- Converting the `<img>` logo to `next/image` (audit P2 #24) — untouched.
- `aria-live` regions elsewhere in the app (audit #18) — separate pass.
- Changing `SiteNav`'s public props (`comingSoon`, `selfServeEnabled`) or any
  caller. No new files, no new dependencies.

## Approach (chosen)

**Branded dropdown panel**, mirroring `AdminNav`'s proven shape, re-skinned to
the sage/teal brand. Rejected alternatives: a slide-over drawer + scrim
(needs body-scroll-lock + focus-trap + backdrop for only 3 links — heavier than
the content warrants, and at odds with the brand's restraint guardrail); and a
CSS-only `<details>` hack (keeps it a server component but is harder to brand,
animate, and make accessible).

### Component shape

`SiteNav` becomes a **`'use client'`** component (a hamburger needs toggle
state). All current callers already render inside client trees, so this is a
safe change. State: `const [mobileOpen, setMobileOpen] = useState(false)`.

Structure (mirrors `AdminNav`):

```
<nav>                              // owns the border
  <div> header row </div>          // logo | desktop links | desktop auth | hamburger
  <AnimatePresence> panel </AnimatePresence>   // mobile dropdown
</nav>
```

### Behavior — breakpoint stays `sm` (640px)

- **Desktop (≥640px):** identical to today. Nav links `hidden sm:flex`. The
  auth cluster changes from always-`flex` to `hidden sm:flex` so it does not
  duplicate on mobile — no visual change at ≥640px.
- **Mobile (<640px):** header shows **logo + hamburger only**. The hamburger
  (`sm:hidden`) toggles a dropdown panel (`sm:hidden`) below the header
  containing the 3 nav links and — only when `showOwnerAuth`
  (`selfServeEnabled && !comingSoon`) — a divider + Log in / Sign up.
- The panel animates via `motion/react` `AnimatePresence`
  (`opacity` + `height: 0 → auto`, ~0.2s `easeOut`). The panel uses interior
  `overflow-hidden` for the height animation — this is on the panel, **not** a
  page root, so the iOS `.rw-island` `overflow:hidden` rule (audit #7) is
  unaffected.
- **Close triggers:** tapping any link (matches `AdminNav`) **and** pressing
  `Escape` (keyboard-disclosure nicety; this accessibility pass justifies it).

### Brand compliance (per `repworth-brand-design` skill)

- Tokens only: `#97B3AE` (primary/teal), `#6a6a6a` (body), `border-[#97B3AE]/10`.
  No amber/orange/stone, no AI gradients.
- Inline SVG hamburger ↔ X icon (the brand bans `lucide-react`/`heroicons`).
- `motion/react`, never `framer-motion`.
- Restraint: a simple dropdown for 3 links, no decorative filler.

### Accessibility

- Hamburger button: `type="button"`, dynamic `aria-label`
  ("Open menu" / "Close menu"), `aria-expanded={mobileOpen}`,
  `aria-controls="site-nav-mobile-menu"`. The panel carries
  `id="site-nav-mobile-menu"`.
- **Folded-in P1 (line 113):** `focus-visible:outline-none
  focus-visible:ring-2 focus-visible:ring-[#97B3AE]/50` (with offset where it
  reads cleanly) on every nav link, both auth links, and the hamburger.
- Decorative SVG marked `aria-hidden`.

## Testing (TDD)

`@testing-library/react`, `@testing-library/user-event`, and `jsdom` are
installed and used elsewhere — interaction tests are supported.

- **Preserve** the 3 existing `renderToStaticMarkup` tests (auth links still
  live in the always-present desktop cluster, so they keep passing).
- **Add (static markup):** hamburger present with `type="button"`,
  `aria-expanded="false"` by default, and `aria-controls` matching the panel
  `id`; panel closed by default.
- **Add (interaction, `@testing-library`):**
  - click hamburger → `aria-expanded` becomes `true`, panel reveals the 3 nav
    links;
  - with `selfServeEnabled`, the open panel also shows Log in / Sign up; with
    it disabled, it does not;
  - clicking a link inside the panel closes it;
  - pressing `Escape` while open closes it (`aria-expanded` back to `false`).

**Gate before "done":** `pnpm lint && pnpm typecheck && pnpm test` all green in
the worktree. Lint must show 0 errors (no new `no-img-element` etc.).

## Risks & mitigations

- **Server→client conversion** could in theory affect a caller that depends on
  server-only rendering. Mitigation: `SiteNav` has no server-only data
  dependencies (pure presentational `Link`s), and every caller is already a
  client component. No prop/contract change.
- **Animating `height: auto`** in `motion/react` is supported; if it proves
  janky, fall back to a static (un-animated) `mobileOpen && <div>` panel — the
  accessibility/behavior contract does not depend on the animation.

## Rollout

Single-file change (+ test) landed via PR to protected `main`; CI's
lint/typecheck/test/build gates must be green. Presentational-only; no
migration, no flag, no env var.
