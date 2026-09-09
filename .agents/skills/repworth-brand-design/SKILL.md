---
name: repworth-brand-design
description: Use when designing or implementing any RepWorth UI page, section, or component - including new pages, feature screens, admin views, dashboard surfaces, or marketing sections. Routes to the right one of RepWorth's three visual systems (Landing / Island / Console) by path, gives each one's non-negotiable token and layout rules, and points at that system's Style Reference to read before building or finalizing.
---

# RepWorth design systems — router

RepWorth ships **three visual systems, one per surface family**. Pick one per surface;
never mix them on the same screen.

## 1. Which system am I in?

| The file I am editing | System | Style Reference |
|---|---|---|
| `src/components/sections/landing/**` | **Landing** (`.rw-lp`) | [`docs/brand-asset-library/design-systems/landing/DESIGN.md`](../../../docs/brand-asset-library/design-systems/landing/DESIGN.md) + [`measurements.md`](../../../docs/brand-asset-library/design-systems/landing/measurements.md) |
| `src/app/(authenticated)/**`, `src/components/dashboard/**` | **Console** (`.rw-console`) | [`docs/brand-asset-library/design-systems/console/DESIGN.md`](../../../docs/brand-asset-library/design-systems/console/DESIGN.md) |
| everything else public / marketing / auth / approval / legal / **admin** | **Island** (`:root`) | [`docs/brand-asset-library/design-systems/island/DESIGN.md`](../../../docs/brand-asset-library/design-systems/island/DESIGN.md) |

Admin renders **outside** `.rw-console` and consumes no Console tokens — it is an
Island-palette surface, just more utilitarian.

## 2. Non-negotiables per system (token names, never literals)

**Island**

- Every page is a white `rounded-[3rem]` island floating on the sage field; never place
  content directly on sage. No `overflow-hidden` on the root container (breaks iOS Safari).
- For text, links, and button fills use `rw-teal-strong` — **not** the decorative
  `rw-teal`, which fails AA for text. White text only on `rw-teal-strong` or darker.
- Inline SVG only (no lucide-react / heroicons); import motion from `motion/react`;
  decorative wrappers get `aria-hidden="true"`.
- Anti-slop: no purple/blue gradients, neon glows, orb/blob backgrounds, fake
  metrics / avatars / testimonials / logos, or hype copy ("unlock", "supercharge",
  "seamless").

**Console (Harbor)**

- Use `.rw-console` tokens only (`--rw-app-*`, `--rw-field-deep` / `--rw-nav-*`,
  `--rw-tray` / `--rw-card` / `--rw-recess`, `--rw-accent-*` / `--rw-sage-deep`,
  `--rw-blush*` / `--rw-coral*`, `--rw-danger`, `--rw-violet`, `--rw-star`,
  `--rw-hero-*` / `--rw-deep-panel*`). Never re-declare an Island color or font token here.
- Cards are **flat Harbor cards**: white fill + hairline + 20px radius + cool shadow.
  Exactly three special surfaces exist, one instance each — the gradient hero, the
  Rep Pulse gauge card, the inverted deep panel. Never add a second of any.
- Display is Gabarito (600/700 only), body is Figtree; hierarchy from the small-step
  scale (24→18→16→14→12), not from bigger type.
- Semantic color always keeps a text, icon, shape, or positional cue. `--rw-star` is for
  rating stars only; `--rw-coral` is decorative-only (never text). No fabricated
  trends — Rep Pulse shows a dash without a baseline.

**Landing (`/` only)**

- **Read `measurements.md` first.** Most values in that folder are measurements with a
  documented failure mode, not preferences.
- `--rw-lp-*` tokens only; translucent shades ride the channel tokens
  (`rgb(var(--rw-lp-*-rgb) / a)`). Focus rings use `--rw-lp-accent`, never the Island's
  `--rw-teal-strong` (invisible on this ink).
- Do **not** "restore" sage/teal/peach here — `/` is deliberately unlocked from the Island
  system (PRODUCT.md, agreed 2026-08-03).
- Keep the `.rw-lp-` prefix on every class; the gold/teal temperature split marks acting
  agents vs watchdogs and is load-bearing.

**All three**

- Tokens, never literals: `var(--rw-*)` or the `rw-*` Tailwind utilities, never a raw
  `bg-[#hex]`. Never amber, orange, or stone.

## 3. Read the Style Reference before building or finalizing

- **Landing:** [`docs/brand-asset-library/design-systems/landing/DESIGN.md`](../../../docs/brand-asset-library/design-systems/landing/DESIGN.md)
- **Island:** [`docs/brand-asset-library/design-systems/island/DESIGN.md`](../../../docs/brand-asset-library/design-systems/island/DESIGN.md)
- **Console:** [`docs/brand-asset-library/design-systems/console/DESIGN.md`](../../../docs/brand-asset-library/design-systems/console/DESIGN.md)

Each carries the full token tables, component anatomy, motion specs, do's/don'ts, and an
agent prompt guide. Router + cross-system rules:
[`docs/brand-asset-library/design-systems/README.md`](../../../docs/brand-asset-library/design-systems/README.md).
