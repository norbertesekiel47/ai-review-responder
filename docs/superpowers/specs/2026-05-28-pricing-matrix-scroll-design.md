# Pricing matrix horizontal scroll (Launch-ready P0 #8 / audit M3)

**Date:** 2026-05-28
**Source:** `docs/launch-ready-part2.md` — P0 #8 ("Pricing matrix: wrap in `overflow-x:auto` + `min-width` so it scrolls on mobile") and mobile audit row M3.
**Scope chosen:** Scroll + accessibility (CSS scroll fix + keyboard-reachable, labeled scroll region).

## Problem

The pricing comparison matrix (`.pr-matrix-grid`, `src/app/globals.css:2231`) is a fixed
5-column CSS grid (`grid-template-columns: 1.6fr 1fr 1fr 1fr 1fr`). Its only responsive
handling is shrinking the font — 13px at `≤1100px`, 12px at `≤720px`. At a 375px viewport
the five columns squeeze into ~327px of content width and the matrix becomes illegible.
The grid never scrolls horizontally.

## Goal

On narrow viewports the matrix scrolls horizontally instead of crushing its columns, while
staying keyboard- and screen-reader-accessible. No change to the desktop/tablet appearance
above the legibility floor.

## Non-goals

- Not converting the grid to a semantic `<table>` (larger change; out of scope for a P0 quick fix).
- Not touching unrelated pricing copy (the "if implemented" string is P1 #21, already handled).
- Not adding a scroll-hint edge-fade affordance (deferred; can be a follow-up polish item).

## Design

### CSS — `src/app/globals.css`

1. **`.pr-matrix` becomes the scroll container** (currently `overflow: hidden` for rounded-corner
   clipping). Keep `overflow: hidden`, then add `overflow-x: auto`. Net computed value:
   `overflow-x: auto` (horizontal scroll when needed), `overflow-y: hidden` (rounded corners preserved).

2. **Focus indicator** for the now-focusable region:
   `.pr-matrix:focus-visible { outline: 2px solid var(--rw-teal); outline-offset: 2px; }`.
   Uses an existing brand token — no new color introduced. Satisfies the brand skill's focus-state rule.

3. **`.pr-matrix-grid` legibility floor:** add `min-width: 720px;`. Below ~720px of available
   width the container scrolls instead of compressing columns. Rationale: feature-label column
   ~200px + four plan columns ~120px ≈ 680px, rounded to 720 to match the existing breakpoint.

4. **Remove the illegible font crush:** delete the `.pr-matrix-grid { font-size: 12px; }`
   declaration from the `@media (max-width: 720px)` block. The 13px from the `≤1100px` rule
   still cascades, so the scrolled matrix stays legible on phones. The `≤1100px` tablet rule
   (13px + tighter cell padding) is retained — it is legible and sits above the min-width floor.

### JSX — `src/app/(public)/pricing/PricingContent.tsx` (~line 440)

Make `.pr-matrix` a labeled, keyboard-reachable scroll region:

```tsx
<div
  className="pr-matrix"
  role="group"
  aria-label="Plan comparison — scroll horizontally to compare all plans"
  tabIndex={0}
>
  <div className="pr-matrix-grid"> … </div>
</div>
```

- `role="group"` + `aria-label` gives the region an accessible name without adding a page landmark.
- `tabIndex={0}` makes the scroll region keyboard-reachable (it can be scrolled with arrow keys once focused).
- No inline styles added (respects the test guard `expect(html).not.toContain('left:')`).
- The `grid-column: 1 / -1` section-header rows are unaffected by the min-width grid.

### Test — `src/app/(public)/pricing/__tests__/PricingContent.test.tsx`

The CSS scroll behavior is not observable in jsdom; the testable contract is the a11y markup:

```ts
it('exposes the comparison matrix as a labeled, keyboard-scrollable region', () => {
  const html = renderToStaticMarkup(createElement(PricingContent));
  expect(html).toContain('aria-label="Plan comparison — scroll horizontally to compare all plans"');
  expect(html).toMatch(/class="pr-matrix"[^>]*tabindex="0"/);
});
```

## Verification

- `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- No DB changes → tenant-scope / RLS audits not required.
- Visual scroll behavior at 375px confirmed by inspection; the unit test locks the a11y semantics.
- Authoritative check is the 4 CI checks green on the PR (nested-worktree lab-note caveat: CI is the source of truth, not local runs).

## Files touched

| File | Change |
|---|---|
| `src/app/globals.css` | `.pr-matrix` scroll container + `:focus-visible`; `.pr-matrix-grid` `min-width`; drop 720px font crush |
| `src/app/(public)/pricing/PricingContent.tsx` | a11y attrs on `.pr-matrix` scroll region |
| `src/app/(public)/pricing/__tests__/PricingContent.test.tsx` | a11y contract assertion |
