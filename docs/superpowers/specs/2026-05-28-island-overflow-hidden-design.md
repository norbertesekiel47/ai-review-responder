# Remove `overflow:hidden` from island roots — Design

> **Date:** 2026-05-28
> **Status:** Approved (design); pending spec review
> **Source:** `docs/launch-ready-part2.md` → Prioritized fix list → P0 #7 (also M4)
> **Scope:** CSS-only. Two island root rules + one child rule + one regression test.

## Problem

`.rw-island` sets `overflow: hidden` in two places:

- `src/app/globals.css:126` — marketing islands (landing, features, how-it-works, pricing)
- `src/components/auth/auth-island/auth-island.css:67` — auth islands (login, signup)

The launch audit flags this as a P0 iOS Safari bug. On iOS Safari, an element
with `overflow:hidden` **and** `border-radius` **and** a `transform` triggers a
repaint bug: the rounded clip is lost during momentum scroll and `position:fixed`
siblings flicker/jump. Both `.rw-island` rules meet all three conditions:

- Marketing: `border-radius: 48px` + an animation (`rw-island-in`) that uses
  `both` fill, so the element **retains** `transform: translateY(0) scale(1)`
  after the animation — a non-`none` transform that persists.
- Auth: `border-radius: 48px` + `transform: translateY(30px) scale(0.97)`
  applied during the `rwIntro` intro animation.

The canonical brand component `src/components/ui/PageShell.tsx` (used by
book-a-demo, legal, security) already omits `overflow-hidden` on its island for
this reason, and the `repworth-brand-design` rubric forbids `overflow-hidden`
on island roots. The two CSS-class islands above predate that pattern.

### Correcting the audit's stated mechanism

The audit says `overflow:hidden` "clips the fixed dot-nav + parallax." That is
**not** literally true: in both implementations the fixed elements are
**siblings** of the island, not descendants —

- `LandingContent.tsx`: `.rw-dot-nav` (fixed) is a sibling of `.rw-island-wrap`.
- `AuthIslandClient.tsx`: `.rw-field` (fixed parallax) is a sibling of `.rw-page`.

So `overflow:hidden` never clipped those fixed elements. What it actually clips
is the island's **own children** to the `48px` corner radius. The real defect is
the iOS `overflow:hidden + border-radius + transform` repaint bug described
above. This distinction matters because it tells us exactly what we must not
break when we remove the property: **corner clipping of full-bleed children.**

## The fix

Remove `overflow:hidden` from both island roots, and ensure every full-bleed
child that meets a rounded island corner self-rounds that corner so nothing
pokes past the `48px` radius.

### Change 1 — `src/app/globals.css:126`

Remove `overflow: hidden;` from `.rw-island`.

**No corner regression** (verified by inspection):

- Bottom corners are colored full-bleed CTA sections that already self-round:
  `.rw-cta` has `border-radius: 0 0 48px 48px` (`globals.css:949`); the
  how-it-works and pricing CTAs have `border-radius: 0 0 3rem 3rem`
  (`globals.css:1815`, `:2331`). On landing the last child is `.rw-foot`, which
  has **no** background fill (transparent over the white island) → invisible
  corners.
- Top corners are the nav / hero, which have no full-bleed colored background
  → the white island surface shows through → clean rounded corners.

### Change 2 — `src/components/auth/auth-island/auth-island.css:67`

Remove `overflow: hidden;` from `.rw-island`.

### Change 3 — `src/components/auth/auth-island/auth-island.css:72` (`.rw-showcase`)

Add `border-radius: 48px 0 0 48px;` to `.rw-showcase`.

The showcase is the full-bleed left gradient pane; its left edge sits on the
island's left rounded corners. With the island no longer clipping, the showcase
must self-clip its left corners. Its existing `overflow:hidden` is **kept** (it
clips the floating `.rw-review-card`s within the pane and now also rounds the
gradient to the new radius). The right `.rw-form-pane` is white (= island
surface) so its corners are invisible and need no change. On mobile (`≤900px`)
`.rw-showcase` is `display:none` and the single white form pane fills the
island — corners clean.

### Change 4 — Regression guard (new test)

Add a Vitest test that reads both CSS files, isolates each `.rw-island` rule
block, and asserts neither declares `overflow: hidden`. This encodes the
rubric's "no `overflow-hidden` on island roots" contract so it cannot silently
regress. The test targets the `.rw-island` selector specifically — it must not
flag the intentional `overflow:hidden` on `.rw-showcase`, `.rw-cta`,
`.rw-submit`, `.rw-field`, etc.

Proposed location: `src/__tests__/island-overflow.test.ts` (or the nearest
existing CSS/contract test home discovered during planning).

## Verification

- **CI** (`lint`, `typecheck`, `test`, `build`) on push — the repo's `CLAUDE.md`
  warns that lint/test run from a nested worktree leak module resolution into
  the parent, so local full-suite runs are unreliable here. Validate on the
  runner.
- **Visual spot-check** on the running app at an iPhone viewport:
  - `/login` — showcase left corners follow the `48px` radius; no square gradient
    corners; the fixed parallax field scrolls without flicker.
  - `/` (landing) — island corners clean (top white, bottom CTA/footer); the
    fixed dot-nav stays put during momentum scroll.

## Out of scope (deliberately)

Other audit items are tracked separately and are **not** part of this fix:

- M9 — auth island `min-height:680px` clipping on iPhone SE (P1).
- M3 / P0 #8 — pricing matrix horizontal scroll (separate P0).
- Any branding / palette / accessibility items.

## Files touched

| File | Change |
|---|---|
| `src/app/globals.css` | Remove `overflow:hidden` from `.rw-island` |
| `src/components/auth/auth-island/auth-island.css` | Remove `overflow:hidden` from `.rw-island`; add `border-radius: 48px 0 0 48px` to `.rw-showcase` |
| `src/__tests__/island-overflow.test.ts` (new) | Assert island roots never set `overflow:hidden` |
