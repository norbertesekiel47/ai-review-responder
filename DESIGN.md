---
name: RepWorth
description: Trusted autonomy expressed through three registers — an unlocked landing world, warm tactile public islands, and a calm editorial owner console.
typography:
  display:
    fontFamily: "Plus Jakarta Sans, ui-sans-serif, system-ui, sans-serif"
  body:
    fontFamily: "DM Sans, ui-sans-serif, system-ui, sans-serif"
  serif:
    fontFamily: "Fraunces, ui-serif, Georgia, serif"
  mono:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
---

<!-- Hand-curated brand-level index. `/impeccable document` output goes into the matching
     docs/design/<system>/DESIGN.md — never here. This file carries only what is true of
     ALL THREE RepWorth visual systems; per-system tokens, components and rules live in
     docs/design/{landing,island,console}/DESIGN.md, and their normative values live in
     code. The frontmatter therefore carries only the brand-wide font families — the
     `colors` / `rounded` / `spacing` / `components` groups moved to the three per-system
     Style References, because there is no brand-wide value for them to hold. -->

# Design System: RepWorth

## Overview

RepWorth has **three deliberate visual registers under one brand**, one per surface
family. Pick one register per surface and never mix their component grammar on the same
screen. This file is the brand-level index; the authoritative Style Reference for each
register is its own `DESIGN.md`, and the normative token values live in that register's
stylesheet, not here.

| Register | Scope | Authoritative Style Reference |
|---|---|---|
| **Landing** — the unlocked world of `/`: green-black ink, one gold, one cooler teal for the watchdog tier | `.rw-lp` | [`docs/design/landing/DESIGN.md`](docs/design/landing/DESIGN.md) (+ [`measurements.md`](docs/design/landing/measurements.md)) |
| **Island** — generous white content fields floating on sage, with warm tactile accents | `:root` | [`docs/design/island/DESIGN.md`](docs/design/island/DESIGN.md) |
| **Console** ("Warm Editorial") — cream paper, espresso ink, concentric trays, restrained semantic color | `.rw-console` | [`docs/design/console/DESIGN.md`](docs/design/console/DESIGN.md) |

**Which register am I in?** — by path:

- `src/components/sections/landing/**` → **Landing**
- `src/app/(authenticated)/**`, `src/components/dashboard/**` → **Console**
- everything else public / marketing / auth / approval / legal / admin → **Island**

Running `/impeccable` with a `--target` under one of those paths? Read the matching Style
Reference, and write any documentation output into it.

Routing table, the cross-system rules, and how to overhaul one register without touching
the other two: [`docs/design/README.md`](docs/design/README.md). The **narrative** layer —
positioning, story arc, messaging guardrails — is
[`docs/design/brand-story.md`](docs/design/brand-story.md).

## Typography

**Display:** Plus Jakarta Sans (`--rw-font-display`)
**Body / UI:** DM Sans (`--rw-font-body`)
**Serif:** Fraunces (`--rw-font-serif`)
**Mono:** JetBrains Mono (`--rw-font-mono`)

The four families are the one genuinely brand-wide token group. `src/app/globals.css` is
their single owner and it loads on every route. The Console re-points
`--rw-font-display` at Young Serif on its own `.rw-console` wrapper — a single-weight
editorial display face — so the Console reads as the Console without a second font stack.
Landing adds the 200/300 weights of Plus Jakarta for its light editorial register.

All faces are **self-hosted** (`localFont`). A `next/font/google` import anywhere
re-introduces a compile-time fetch and breaks the build.

**The Wordmark Rule.** "REPWORTH" is set uppercase with wider tracking. Letter spacing
stays normal everywhere else — the wordmark and the eyebrow styles are the only
exceptions, in every register. The landing footer's oversized wordmark is decorative
(`aria-hidden`) and its geometry is measured; the brand name always exists as a real link
beside it.

## Do's and Don'ts

Brand-wide commitments. Everything register-specific lives in that register's Style
Reference.

### Do:

- **Do** keep each register's tokens single-sourced in its owning stylesheet, and never
  re-declare another register's token name.
- **Do** clear WCAG AA in the state the element actually ships in: ≥4.5:1 for text, ≥3:1
  for large text and UI. Where a value sits over a wash, a gradient, or video, measure it
  composited over that ground — not over the nominal page color.
- **Do** give every interactive element a visible focus ring in its register's accent.
- **Do** keep interactive targets ≥44px on touch-capable devices, and ≥24px everywhere.
- **Do** resolve `prefers-reduced-motion` directly to the final visual state while
  preserving immediate feedback.
- **Do** pair color with copy, shape, icon, or position — color never carries state alone.
- **Do** use inline SVG for every icon, and give decorative wrappers `aria-hidden="true"`.
- **Do** import motion from `motion/react`.

### Don't:

- **Don't** use amber, orange, or stone anywhere. They are the old palette, fully
  replaced, and the ban is locked by `console-admin-palette.test.ts`. The single exemption
  is the Console's ranking-chart **series** rotation.
- **Don't** fabricate metrics, testimonials, logos, avatars, customer names, agent
  activity, or trends. If proof is missing, omit the block.
- **Don't** introduce purple-blue AI gradients, neon glows, black-glass panels,
  orb/blob/bokeh backgrounds, or generic chatbot imagery.
- **Don't** write a literal hex in a component. Use the register's tokens.
- **Don't** import an external icon library (lucide-react, heroicons, …), and don't
  substitute emoji or Unicode symbols for the inline SVG icon system.
- **Don't** animate layout-driving properties or leave a broad `transition: all` in
  production UI.
- **Don't** mix two registers on one screen.
