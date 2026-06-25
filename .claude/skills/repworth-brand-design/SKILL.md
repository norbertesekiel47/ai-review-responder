---
name: repworth-brand-design
description: Use when designing or implementing any RepWorth UI page, section, or component - including new pages, feature screens, admin views, or marketing sections. Provides the exact RepWorth color tokens, island layout pattern, animation conventions, component rules, and anti-AI-slop guardrails that all RepWorth pages must follow.
---

# RepWorth Brand Design System (Island)

**Full playbook — source of truth: [`docs/design/brand-island.md`](../../../docs/design/brand-island.md).**
Read it before building or finalizing any Island (public / marketing) page. It has the
complete color table, island/parallax/nav code, typography scale, animation patterns,
button & card recipes, and the anti-slop final pass.

- **Console (authenticated dashboard)** work uses
  [`docs/design/dashboard-redesign/design-spec.md`](../../../docs/design/dashboard-redesign/design-spec.md)
  instead — that surface is the Warm Editorial Console, **not** the island.
- Overview of both systems + which-palette-when:
  [`docs/design/README.md`](../../../docs/design/README.md).

## Always applies (the non-negotiables, even before opening the playbook)

- **Island layout.** Every public page is a white `rounded-[3rem]` card floating on the
  sage field (`#D2E0D3`); never place content directly on sage. Dashboard/admin are the
  Console system, not the island.
- **Tokens, never literals.** Use the RepWorth design tokens — `var(--rw-*)` and the
  `rw-*` Tailwind utilities (`bg-rw-sage`, `text-rw-ink`; owned by `src/app/globals.css`) —
  never raw `bg-[#hex]`. For text, links, and button fills use `rw-teal-strong` (`#557069`,
  AA-compliant), **not** the decorative `rw-teal` (`#97B3AE`). Never amber / orange / stone.
- **No AI slop.** No purple/blue gradients, neon glows, orb/blob/bokeh backgrounds, fake
  metrics / avatars / testimonials / logos, or hype copy ("unlock", "supercharge", "seamless").
- **Tech rules.** Inline SVG only (no lucide-react / heroicons); import motion from
  `motion/react`; never `overflow-hidden` on the root page container (breaks iOS Safari);
  decorative wrappers get `aria-hidden="true"`.

Everything else — the full token table, component anatomy, motion specs, button/card markup,
and the anti-slop checklist — lives in
[`docs/design/brand-island.md`](../../../docs/design/brand-island.md).
