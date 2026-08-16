# RepWorth Island — Style Reference

> **Scope:** `:root` (loads on every route) · **Tokens:** [`src/app/globals.css`](../../../src/app/globals.css) `:root` ·
> **Utilities:** `src/app/globals.css` `@theme inline` (Island entries) · **Guard:** [`src/__tests__/design-token-single-source.test.ts`](../../../src/__tests__/design-token-single-source.test.ts)
> Which system am I in? → [`docs/design/README.md`](../README.md)

## Overview

Every RepWorth Island page is an **island**: a white `rounded-[3rem]` card floating
on a sage green background, with glassmorphism elements drifting behind it. Never
place content directly on the sage green without an island wrapper except for the
admin and owner dashboard pages. Additionally use
`src/components/ui/MarqueeBackground.tsx` as the background wherever necessary when
implementing the island design.

The Island is the default register for everything that is not the landing page (`/`)
and not the authenticated Console: public/marketing pages, auth, the approval page,
legal, and the (more utilitarian) admin tool. Its token file loads on every route, so
the other two systems inherit these values by fall-through wherever they do not
override them.

**Key characteristics:**

- A white island on a sage field — content never sits on the sage directly.
- Warm, tactile accents (peach, pink, beige) used sparingly, never as a pastel showcase.
- Plus Jakarta Sans display over DM Sans body; normal letter spacing everywhere except
  the RepWorth wordmark and eyebrow styles.
- Decorative atmosphere (parallax glass cards, marquee field) that is abstract and
  non-informational by rule.
- Anti-slop by construction: specificity, restraint, purpose, truthfulness, craft,
  accessibility, token discipline.

## Tokens — Colors

Every row is declared in `src/app/globals.css` `:root`. Utility names mirror the token
names 1:1 (`--rw-sage` → `bg-rw-sage` / `text-rw-sage` / `border-rw-sage`).

### Brand & accent

| Name | Value | Token | Role |
|---|---|---|---|
| Sage | `#D2E0D3` | `--rw-sage` | page background / secondary sage (`bg-rw-sage`) |
| Teal | `#97B3AE` | `--rw-teal` | primary decoration — large fills, dots, page accent, text-free bands |
| Teal strong | `#557069` | `--rw-teal-strong` | the **actionable** teal — text, links, button fills |
| Peach | `#F2C3B9` | `--rw-peach` | accent / blush |
| Pink | `#F0DDD6` | `--rw-pink` | soft accent wash |
| Beige | `#D6CBBF` | `--rw-beige` | warm beige / muted |
| Cream | `#F0EEEA` | `--rw-cream` | off-white background |
| Island surface | `#ffffff` | — (`bg-white`) | the island card itself |

### Neutrals

| Name | Value | Token | Role |
|---|---|---|---|
| Ink | `#2a2a2a` | `--rw-ink` | heading text (`text-rw-ink`) |
| Ink soft | `#6a6a6a` | `--rw-ink-soft` | body text (`text-rw-ink-soft`) |

### Semantic

| Name | Value | Token | Role |
|---|---|---|---|
| Error | `#b3261e` | `--rw-error` | AA body-text error, 6.47:1 on white |
| Success | `#1d6b4f` | `--rw-success` | AA body-text success, 5.10:1 on white |
| Alert red | `#DC2626` | `--rw-red-600` | error-glyph red (approval page + Console fall-through) |
| Alert red deep | `#B91C1C` | `--rw-red-700` | error-glyph red, darker |

### Extended tints (issue #373)

Tokenized at their exact prior `bg-[#hex]` values (zero pixel change) so onboarding,
auth, the approval page, and admin — none of which load the Console token file — can
consume them from the one Island owner.

| Name | Value | Token | Role |
|---|---|---|---|
| Warm gray | `#9a948a` | `--rw-warm-gray` | muted warm-gray text (placeholders, captions) |
| Warm gray soft | `#e3ddd3` | `--rw-warm-gray-soft` | light warm-gray surface — inactive step dots |
| Cream hover | `#e7e3dc` | `--rw-cream-hover` | cream secondary-button hover |
| Brown | `#6a4a44` | `--rw-brown` | brown badge text on peach (admin costs) |
| Teal hover | `#7e9b96` | `--rw-teal-hover` | hover shade for teal links/buttons |
| Sage muted | `#cdd9ce` | `--rw-sage-muted` | muted sage — inactive / empty states |
| Sage text | `#5e7d77` | `--rw-sage-text` | muted-sage badge text (approval location chip) |
| Teal deep | `#2a6a64` | `--rw-teal-deep` | deep teal badge text (admin costs) |
| Teal strong hover | `#46645d` | `--rw-teal-strong-hover` | darker teal-strong — button hover + CTA gradient end |
| Teal strong hover deep | `#46594f` | `--rw-teal-strong-hover-deep` | deeper teal-strong button hover (auth card) |
| Teal darkest | `#3f544f` | `--rw-teal-darkest` | darkest sage — approval confirm action |

**Never use:** amber, orange, stone, or any color not in the tables above.

## Tokens — Typography

### Families

| Role | Stack | Token |
|---|---|---|
| Display | Plus Jakarta Sans (variable, 100–900) | `--rw-font-display` |
| Body | DM Sans | `--rw-font-body` |
| Serif | Fraunces | `--rw-font-serif` |
| Mono | JetBrains Mono | `--rw-font-mono` |

The families are brand-wide: `globals.css` is their single owner and they load on every
route. The Console re-points `--rw-font-display` at Young Serif on its own wrapper; the
Island value is what every other surface resolves.

### Scale

The Island has no `--rw-*` type-role tokens — its scale is expressed as Tailwind
utilities, so the sizes live in the components:

| Element | Classes |
|---|---|
| Page h1 | `text-5xl md:text-6xl lg:text-7xl font-medium leading-tight text-rw-ink` |
| Section h2 | `text-4xl md:text-5xl font-medium text-rw-ink` |
| Card h3 | `text-xl md:text-2xl font-medium text-rw-ink` |
| Body | `text-lg text-rw-ink-soft leading-relaxed` |
| Eyebrow | `text-sm tracking-wider uppercase text-rw-teal-strong` |
| Caption / note | `text-sm text-rw-teal-strong italic` |

Eyebrows, captions, labels, and the wordmark are **text**, so they take the actionable
teal (`text-rw-teal-strong`) on white/cream — never the decorative `text-rw-teal`
(2.24:1, fails AA). Rationale and the per-background table:
[`docs/adr/0004-accessible-teal-token-split.md`](../../adr/0004-accessible-teal-token-split.md).

## Tokens — Spacing & Shape

The Island's shape and elevation are Tailwind utilities, not custom properties — there
is deliberately no Island radius/shadow token set to keep drifting apart from the
utility classes the components actually write.

### Border radius

| Element | Value | Utility |
|---|---|---|
| Island wrapper | 3rem | `rounded-[3rem]` |
| Parallax / glass card | 1.5rem | `rounded-3xl` |
| Feature card | 1rem | `rounded-2xl` |
| Floating accent card | 0.75rem | `rounded-xl` |
| Buttons, dot nav, pills | full | `rounded-full` |

### Shadows / elevation

| Name | Utility | Where |
|---|---|---|
| Island | `shadow-2xl` | the island wrapper |
| Card | `shadow-xl` | parallax cards, dot-nav rail |
| Feature | `shadow-lg` | feature/info cards, primary buttons |
| Icon chip | `shadow-md` | the icon circle inside a feature card |
| Card hover lift | `0 20px 40px rgba(0,0,0,0.1)` | `whileHover` on cards |
| Primary button hover | `0 20px 40px rgba(151,179,174,0.3)` | `whileHover` on primary buttons |

### Motion

| Name | Value | Where |
|---|---|---|
| Island entry | 0.8s `easeOut` | island wrapper mount |
| Section entry | 0.6s, delay 0.2s, stagger +0.1 per element | mount |
| Scroll reveal | 0.6s, delay `i * 0.1` | `whileInView`, `viewport={{ once: true, margin: '-100px' }}` |
| Card hover lift | `y: -5` | `whileHover` |
| Button hover / tap | `scale: 1.05, y: -2` / `scale: 0.98` | `whileHover` / `whileTap` |

### Layout

- Island content column: `max-w-5xl`, centred, `py-20 px-4` around it.
- Nav bar: `px-8 py-4`, always the first child inside the island.
- Dot nav: `position: fixed`, `right-8`, `z-50`, desktop only (`hidden lg:flex`).
- Parallax cards: `position: fixed` behind everything, `pointer-events-none`.

## Components

### Island wrapper (REQUIRED on every page)

Role: the page. Everything else is a child of it or atmosphere behind it.

```tsx
// Page root — always this structure
<div className="min-h-screen bg-rw-sage relative">

  {/* Parallax background — see below */}
  <div className="fixed inset-0 pointer-events-none" aria-hidden="true">
    {/* 4 floating glassmorphism cards */}
  </div>

  {/* Right dot nav — see below */}

  {/* Island wrapper — REQUIRED */}
  <div className="relative z-10 min-h-screen py-20 px-4 flex items-center justify-center">
    <motion.div
      className="w-full max-w-5xl bg-white rounded-[3rem] shadow-2xl overflow-hidden"
      initial={{ opacity: 0, y: 40, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.8, ease: 'easeOut' }}
    >
      {/* Nav bar */}
      {/* Page sections */}
    </motion.div>
  </div>
</div>
```

**Never:** `overflow-hidden` on the root page container — it breaks iOS Safari fixed
element scroll.

### Parallax background cards

Role: brand atmosphere only. Four fixed glassmorphism placeholder cards drift at
different scroll rates. They must not become generic AI dashboard filler: keep them
abstract, muted, and non-informational unless the page has real product states to show.
Copy this exactly:

```tsx
const { scrollYProgress } = useScroll({ target: containerRef, offset: ['start start', 'end end'] });
const bgY1 = useTransform(scrollYProgress, [0, 1], [0, -300]);
const bgY2 = useTransform(scrollYProgress, [0, 1], [0, -500]);
const bgY3 = useTransform(scrollYProgress, [0, 1], [0, -200]);
const bgY4 = useTransform(scrollYProgress, [0, 1], [0, -400]);

// Inside the fixed background div:
{[
  { style: { y: bgY1 }, className: 'absolute top-20 left-10 w-64 h-80', dots: 5 },
  { style: { y: bgY2 }, className: 'absolute top-[500px] right-20 w-72 h-64', dots: 4 },
  { style: { y: bgY3 }, className: 'absolute top-[1000px] left-[15%] w-56 h-72', dots: 5 },
  { style: { y: bgY4 }, className: 'absolute top-[1400px] right-[10%] w-64 h-56', dots: 5 },
].map((card, i) => (
  <motion.div
    key={i}
    style={card.style}
    className={`${card.className} bg-white/40 backdrop-blur-md rounded-3xl shadow-xl p-6 border border-white/60`}
  >
    <div className="flex gap-1 mb-3">
      {Array.from({ length: card.dots }).map((_, j) => (
        <div key={j} className="w-4 h-4 bg-rw-peach/60 rounded-full" />
      ))}
    </div>
    <div className="space-y-2">
      <div className="h-3 bg-rw-ink/20 rounded w-full" />
      <div className="h-3 bg-rw-ink/20 rounded w-5/6" />
      <div className="h-3 bg-rw-ink/20 rounded w-4/6" />
    </div>
  </motion.div>
))}
```

**Never:** render these without `aria-hidden="true"` on their wrapper.

### Right-side dot navigation (desktop only)

Role: one dot per section. `position: fixed`, `z-50`, desktop only (`hidden lg:flex`).

```tsx
<div className="fixed right-8 top-1/2 -translate-y-1/2 z-50 hidden lg:flex flex-col gap-4 bg-white/80 backdrop-blur-md rounded-full py-6 px-3 shadow-xl border border-rw-teal/20">
  {sections.map(({ ref, label }) => (
    <button
      key={label}
      onClick={() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
      aria-label={`Go to ${label}`}
      className="w-3 h-3 rounded-full bg-rw-teal/30 hover:bg-rw-teal transition-all hover:scale-125"
    />
  ))}
</div>
```

**Never:** ship an icon-only control without an accessible name.

### Navigation bar

Role: always the first child inside the island. Teal circle + "REPWORTH" uppercase
wordmark on the right.

```tsx
<nav className="px-8 py-4 border-b border-rw-teal/10 flex items-center justify-between">
  <div className="flex items-center gap-8">
    {/* scroll buttons + <a href="/pricing"> link */}
  </div>
  <div className="flex items-center gap-2">
    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-rw-teal to-rw-teal/80" />
    <span className="text-sm tracking-wider uppercase text-rw-teal-strong">RepWorth</span>
  </div>
</nav>
```

### Buttons

| Type | Classes |
|---|---|
| Primary (teal-strong pill, on the white island) | `px-8 py-4 bg-rw-teal-strong text-white rounded-full shadow-lg` |
| Primary on a teal CTA band | white pill: `px-8 py-4 bg-white text-rw-teal-strong rounded-full shadow-lg` |
| Secondary (outline) | `px-8 py-4 bg-white text-rw-teal-strong rounded-full border border-rw-teal/20` |
| Ghost | `px-8 py-4 bg-rw-cream text-rw-ink rounded-full border border-rw-teal/10` |

States: always wrap clickable buttons in `motion.button` with the hover/tap variants in
**Tokens — Spacing & Shape → Motion**.

**Never:** put white text on `--rw-teal`. White text only ever sits on
`--rw-teal-strong` or darker (ADR 0004 — white on `#97B3AE` is 2.24:1). The
pre-ADR recipe `bg-rw-teal text-white` still survives in a handful of files
(`not-found.tsx`, onboarding step dots); it is a known violation, not a pattern to copy.

### Feature / info cards

```tsx
<motion.div
  className="bg-white rounded-2xl p-6 border border-rw-teal/10 shadow-lg"
  whileHover={{ y: -5, boxShadow: '0 20px 40px rgba(0,0,0,0.1)' }}
>
  {/* Icon circle */}
  <div
    className="w-12 h-12 rounded-full flex items-center justify-center mb-4 shadow-md"
    style={{ background: 'linear-gradient(135deg, var(--rw-teal), var(--rw-teal-strong))' }}
  >
    {/* Inline SVG — never use lucide-react or heroicons */}
    <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="..." />
    </svg>
  </div>
  <h3 className="text-xl mb-2 text-rw-ink font-medium">{title}</h3>
  <p className="text-rw-ink-soft">{description}</p>
</motion.div>
```

Icon circle color per card: primary `rw-teal` (`#97B3AE`), accent `rw-peach`
(`#F2C3B9`), muted `rw-beige` (`#D6CBBF`) — rotate through for visual variety.

**Never:** an external icon library. Inline SVG only.

### Floating accent cards (dashboard mockups, stats)

Role: small cards that appear rotated, overlapping a main card. Use these **only** when
they support a real RepWorth product idea or supplied metric. Do not invent
impressive-looking stats, charts, or labels just to fill space.

```tsx
<motion.div
  className="absolute -top-6 -right-6 w-32 h-24 bg-gradient-to-br from-rw-peach/40 to-rw-peach/20 rounded-xl backdrop-blur-sm border border-white/60 shadow-lg p-3"
  initial={{ opacity: 0, scale: 0.8, rotate: -5 }}
  whileInView={{ opacity: 1, scale: 1, rotate: 5 }}
  viewport={{ once: true }}
  transition={{ duration: 0.6, delay: 0.5 }}
>
  <div className="text-xs text-rw-ink-soft mb-1">Label</div>
  <div className="text-xl text-rw-ink">Value</div>
</motion.div>
```

## Do's and Don'ts

### The anti-AI design guardrails

RepWorth pages must feel specific to RepWorth, not like a generic AI/SaaS template.
Treat "AI influence" as any default visual, copy, or interaction pattern that looks
generated rather than chosen: blue-purple gradients, neon glows, orb or blob
backgrounds, black-glass dashboards, vague product mockups, synthetic chat bubbles,
fake metrics, generic icons, oversized hero type, and decorative UI that does not
explain the product.

This system is intentionally anti-slop. Slop means plausible-looking output that is
generic, unverifiable, over-decorated, inaccessible, or disconnected from the actual
RepWorth product. The fix is not to add more polish; the fix is to make each choice more
specific, truthful, useful, and restrained.

Before designing or finalizing any page, section, or component, check:

- **Specificity:** Use RepWorth-specific content, product language, customer context, and real interface states. Do not use generic placeholder narratives.
- **Restraint:** Keep hierarchy calm and intentional. Do not inflate type, spacing, shadows, gradients, or animation to make the page look more "AI."
- **Purpose:** Every visual element must either support navigation, explain the product, show a real state, or reinforce the RepWorth brand. Remove decorative filler.
- **Truthfulness:** Do not invent metrics, testimonials, logos, avatars, conversation snippets, customer names, dashboard data, or claims unless the user or product provides them.
- **Craft:** Replace template compositions with designed choices: strong alignment, intentional whitespace, readable density, consistent controls, and content that fits its container.
- **Accessibility:** Preserve contrast, keyboard-friendly controls, semantic labels, readable text sizes, and non-overlapping content on mobile and desktop.
- **Token discipline:** Use only the RepWorth color tokens above, and use accents sparingly so the page does not become a pastel or gradient showcase.

### Banned generic AI patterns

- No purple/blue AI gradients, neon cyan, random color glows, black-glass panels, orb/blob/bokeh backgrounds, atmospheric gradient fields, or decorative light leaks.
- No generic "AI startup" hero sections with oversized claims, abstract backgrounds, and vague dashboard cards.
- No fake chat bubbles, fake analytics widgets, fake avatars, fake testimonials, fake logos, fake customer names, or fake metrics unless supplied by the product context.
- No stock-like synthetic people, generic robot/brain/sparkle imagery, decorative network graphs, or meaningless "insight" panels.
- No placeholder hype copy such as "unlock insights," "supercharge," "seamless," "AI-powered," "next-generation," "revolutionize," "transform your workflow," "empower teams," "drive growth," or similar filler.
- No claims without evidence. If proof is missing, use neutral product-language placeholders like "Evidence summary" or omit the proof block.
- No new "AI product" font choices such as generic Inter/SF Pro-style defaults unless the existing app already uses that stack. Use the app's established font stack.
- No negative letter spacing or viewport-scaled type. Keep letter spacing normal except for the existing RepWorth wordmark and eyebrow styles.

### The anti-slop working method

When the request leaves content unspecified, do not fill the page with invented proof.
Use honest, clearly replaceable product labels and keep mock states minimal. Prefer one
concrete RepWorth workflow over many vague feature cards.

For every screen, identify the real user job first: what is being reviewed, compared,
approved, priced, reported, or configured? Let that job shape the layout. A RepWorth
page should feel like it belongs to reputation, evidence, reporting, pricing, pilots,
review management, or admin workflows - not to a generic AI dashboard template.

Before shipping, remove one decorative element, one vague phrase, and one unnecessary
card unless each has a clear product purpose.

### Rules

- **No generic AI visual language** - avoid purple/blue gradients, neon glows, black-glass dashboards, orb/blob/bokeh backgrounds, atmospheric gradients, and vague generated mockups
- **No invented proof** - do not fabricate metrics, testimonials, logos, avatars, chat snippets, dashboard data, customer names, or customer claims
- **No AI hype copy** - replace generic claims with concrete RepWorth product language and user outcomes
- **No slop density** - do not add repeated cards, filler grids, duplicate CTAs, or extra sections just to make the page feel larger
- **No ungrounded mockups** - dashboard, report, pricing, and admin UI must reflect a plausible RepWorth workflow or stay abstract
- **No unlabeled icon-only controls** - provide accessible names and clear intent for interactive elements
- **Use the existing font stack** - do not introduce trendy AI/SaaS fonts unless already established in the app
- **No external icon libraries** (no lucide-react, heroicons, etc.) - use inline SVGs only
- **No amber, orange, or stone** colors - those are the old palette, fully replaced
- **No `overflow-hidden` on the root page container** - breaks iOS Safari fixed element scroll
- **Always `'use client'`** on pages using `useRef`, `useScroll`, `useTransform`
- **Import from `motion/react`** - not `framer-motion`
- **No `custom` prop on `AnimatePresence`** when using inline animation objects (only for variant functions)
- **Decorative background elements** get `aria-hidden="true"` on their wrapper
- **Never place page content directly on sage green** - always inside the island
- **Tokens, never literals** - use `var(--rw-*)` or the `rw-*` Tailwind utilities, never a raw `bg-[#hex]`
- **The two teals** - `--rw-teal` is decoration only and fails WCAG AA for text; text, links, and button fills use `--rw-teal-strong`, which passes AA on white and cream but **not** on sage or teal (use `--rw-ink` there). Rationale: [`docs/adr/0004-accessible-teal-token-split.md`](../../adr/0004-accessible-teal-token-split.md)

### Anti-slop final pass

Before finalizing RepWorth UI, run this pass and revise anything that fails:

| Check | Pass condition |
|---|---|
| Brand specificity | The page could not be mistaken for a generic AI/SaaS template |
| Truthfulness | Every metric, quote, logo, avatar, and customer claim is supplied or clearly omitted |
| Copy quality | No hype phrases, vague benefits, or filler labels remain |
| Visual purpose | Every card, background element, icon, and mockup explains or supports the product |
| Accessibility | Text contrast, labels, focus states, and mobile layout are usable |
| Layout craft | No overlapping text, cramped controls, unstable sizing, or viewport-scaled type |
| Token discipline | Only approved RepWorth colors appear, with accents used sparingly |

If a section only exists to look impressive, delete it or replace it with one concrete
RepWorth workflow/state.

### Common mistakes

| Mistake | Fix |
|---|---|
| Cards directly on the sage field (`bg-rw-sage`) without island | Wrap all content in `max-w-5xl bg-white rounded-[3rem]` island |
| `import { Check } from 'lucide-react'` | Inline SVG only |
| `import { motion } from 'framer-motion'` | `import { motion } from 'motion/react'` |
| `overflow-hidden` on root div | Remove it — clips nothing useful, breaks iOS |
| Amber/stone colors anywhere | Replace with the sage green palette above |
| Generic AI hero with abstract claims | Use RepWorth-specific product language and one real workflow |
| Fake metrics, logos, avatars, or testimonials | Remove them unless supplied by the user/product |
| Decorative dashboard cards with no job | Replace with a plausible RepWorth state or keep it abstract |
| Hype copy like "unlock insights" or "supercharge" | Rewrite as concrete user action or outcome |
| Icon-only controls without labels | Add accessible names/tooltips and clear intent |
| `custom={direction}` on AnimatePresence with object animations | Remove — dead prop |
| `motion.div` without `whileInView` on scroll sections | Add scroll reveal pattern |

## Surfaces & Elevation

Depth is a short stack: the sage field, the drifting glass atmosphere behind it, the
white island, and cards inside the island. Nothing else.

### Section backgrounds (inside the island)

Alternate between these to create visual rhythm:

| Section type | Background |
|---|---|
| Default | `bg-white` |
| Tinted | `bg-gradient-to-b from-white to-rw-cream/30` |
| CTA (last section) | `bg-gradient-to-br from-rw-teal-strong to-rw-teal-strong/90 text-white rounded-b-[3rem]` |

A CTA band follows ADR 0004's three cases exactly: a `--rw-teal` band may carry **ink**
copy plus white-pill actions; a band that must carry **white** copy darkens to
`--rw-teal-strong` or darker (the recipe above — what `book-a-demo`, `demo/[slug]`, and
`help/contact` ship); text-free teal decoration may stay `--rw-teal`.

### The marquee field

`src/components/ui/MarqueeBackground.tsx` (`.rw-marquee-field` in `globals.css`) is the
reusable atmosphere layer: four rows of translucent review cards drifting at different
speeds under a radial sage vignette, with an `animation: none` branch under
`prefers-reduced-motion`.

## Imagery & Motion

### Section entry (mount)

```tsx
initial={{ opacity: 0, y: 20 }}
animate={{ opacity: 1, y: 0 }}
transition={{ duration: 0.6, delay: 0.2 }} // stagger: +0.1 per element
```

### Scroll reveal

```tsx
initial={{ opacity: 0, y: 20 }}
whileInView={{ opacity: 1, y: 0 }}
viewport={{ once: true, margin: '-100px' }}
transition={{ duration: 0.6, delay: i * 0.1 }} // stagger via index
```

### Card hover lift

```tsx
whileHover={{ y: -5, boxShadow: '0 20px 40px rgba(0,0,0,0.1)' }}
```

### Primary button hover

```tsx
whileHover={{ scale: 1.05, y: -2, boxShadow: '0 20px 40px rgba(151,179,174,0.3)' }}
whileTap={{ scale: 0.98 }}
```

### AnimatePresence (e.g. carousels)

- Use `mode="wait"`, `initial={false}`
- Do NOT pass `custom` prop when using inline object animations (only for variant functions)

### Imagery

Inline SVG only — no external icon library, no stock-like synthetic people, no generic
robot/brain/sparkle imagery, no decorative network graphs. Decorative wrappers carry
`aria-hidden="true"`.

## Agent prompt guide

- **"Build a primary button on this surface"** → `motion.button` with
  `px-8 py-4 bg-rw-teal-strong text-white rounded-full shadow-lg`, plus the
  primary-button hover/tap variants. On a teal CTA band it flips to a white pill with
  `text-rw-teal-strong`. Never `bg-rw-teal text-white`, never `text-rw-teal` as a label.
- **"Add a new public page"** → sage root (`min-h-screen bg-rw-sage relative`, no
  `overflow-hidden`), fixed `aria-hidden` parallax layer, dot nav, then the
  `max-w-5xl bg-white rounded-[3rem] shadow-2xl` island with the nav bar as its first child.
- **"Add a feature card grid"** → the feature-card recipe above; rotate the icon-circle
  color through `rw-teal` → `rw-peach` → `rw-beige`; inline SVG icons only.
- **"Add an icon"** → paste the SVG path inline with
  `fill="none" viewBox="0 0 24 24" stroke="currentColor"`. Never import `lucide-react`
  or `heroicons`.
- **"Show a metric / testimonial / logo"** → only if the product supplied it. Otherwise
  omit the block or use a neutral product-language placeholder.

## Exports

- **CSS variables:** [`src/app/globals.css`](../../../src/app/globals.css) — the `:root`
  block IS the export; do not copy it here.
- **Tailwind v4:** [`src/app/globals.css`](../../../src/app/globals.css) `@theme inline`,
  Island entries — the block IS the export. `@theme inline` means each utility emits
  `var(--rw-*)` (a reference, not a copied hex), so the `:root` declarations stay the
  single source of truth.
