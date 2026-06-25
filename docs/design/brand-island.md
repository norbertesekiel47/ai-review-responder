# RepWorth Brand Design System (Island)

> **In-repo source of truth for the Island (public / marketing) visual system.**
> The `repworth-brand-design` Claude skill mirrors this file. Color tokens are owned
> by [`src/app/globals.css`](../../src/app/globals.css) `:root`; this guide covers the
> island layout, components, motion, and anti-slop guardrails. Overview and the Console
> (authenticated dashboard) counterpart: [`README.md`](./README.md).

## Core Principle

Every RepWorth page is an **island**: a white `rounded-[3rem]` card floating on a sage green background, with glassmorphism elements drifting in the background. Never place content directly on the sage green without an island wrapper except for the admin and owner dashboard pages. Additionally use `src/components/ui/MarqueeBackground.tsx` as the background wherever necessary when implementing the island design.

---

## Anti-AI Design Guardrails

RepWorth pages must feel specific to RepWorth, not like a generic AI/SaaS template. Treat "AI influence" as any default visual, copy, or interaction pattern that looks generated rather than chosen: blue-purple gradients, neon glows, orb or blob backgrounds, black-glass dashboards, vague product mockups, synthetic chat bubbles, fake metrics, generic icons, oversized hero type, and decorative UI that does not explain the product.

This skill is intentionally anti-slop. Slop means plausible-looking output that is generic, unverifiable, over-decorated, inaccessible, or disconnected from the actual RepWorth product. The fix is not to add more polish; the fix is to make each choice more specific, truthful, useful, and restrained.

Before designing or finalizing any page, section, or component, check:

- **Specificity:** Use RepWorth-specific content, product language, customer context, and real interface states. Do not use generic placeholder narratives.
- **Restraint:** Keep hierarchy calm and intentional. Do not inflate type, spacing, shadows, gradients, or animation to make the page look more "AI."
- **Purpose:** Every visual element must either support navigation, explain the product, show a real state, or reinforce the RepWorth brand. Remove decorative filler.
- **Truthfulness:** Do not invent metrics, testimonials, logos, avatars, conversation snippets, customer names, dashboard data, or claims unless the user or product provides them.
- **Craft:** Replace template compositions with designed choices: strong alignment, intentional whitespace, readable density, consistent controls, and content that fits its container.
- **Accessibility:** Preserve contrast, keyboard-friendly controls, semantic labels, readable text sizes, and non-overlapping content on mobile and desktop.
- **Token discipline:** Use only the RepWorth color tokens below, and use accents sparingly so the page does not become a pastel or gradient showcase.

### Banned Generic AI Patterns

- No purple/blue AI gradients, neon cyan, random color glows, black-glass panels, orb/blob/bokeh backgrounds, atmospheric gradient fields, or decorative light leaks.
- No generic "AI startup" hero sections with oversized claims, abstract backgrounds, and vague dashboard cards.
- No fake chat bubbles, fake analytics widgets, fake avatars, fake testimonials, fake logos, fake customer names, or fake metrics unless supplied by the product context.
- No stock-like synthetic people, generic robot/brain/sparkle imagery, decorative network graphs, or meaningless "insight" panels.
- No placeholder hype copy such as "unlock insights," "supercharge," "seamless," "AI-powered," "next-generation," "revolutionize," "transform your workflow," "empower teams," "drive growth," or similar filler.
- No claims without evidence. If proof is missing, use neutral product-language placeholders like "Evidence summary" or omit the proof block.
- No new "AI product" font choices such as generic Inter/SF Pro-style defaults unless the existing app already uses that stack. Use the app's established font stack.
- No negative letter spacing or viewport-scaled type. Keep letter spacing normal except for the existing RepWorth wordmark and eyebrow styles.

### Anti-Slop Working Method

When the request leaves content unspecified, do not fill the page with invented proof. Use honest, clearly replaceable product labels and keep mock states minimal. Prefer one concrete RepWorth workflow over many vague feature cards.

For every screen, identify the real user job first: what is being reviewed, compared, approved, priced, reported, or configured? Let that job shape the layout. A RepWorth page should feel like it belongs to reputation, evidence, reporting, pricing, pilots, review management, or admin workflows - not to a generic AI dashboard template.

Before shipping, remove one decorative element, one vague phrase, and one unnecessary card unless each has a clear product purpose.

---

## Color Tokens

| Role | Hex | Tailwind equivalent |
|---|---|---|
| Page background | `#D2E0D3` | `bg-[#D2E0D3]` |
| Primary / CTA | `#97B3AE` | `bg-[#97B3AE]` |
| Accent / blush | `#F2C3B9` | `bg-[#F2C3B9]` |
| Secondary sage | `#D2E0D3` | same as bg |
| Warm beige / muted | `#D6CBBF` | `bg-[#D6CBBF]` |
| Off-white bg | `#F0EEEA` | `bg-[#F0EEEA]` |
| Island surface | `#ffffff` | `bg-white` |
| Heading text | `#2a2a2a` | `text-[#2a2a2a]` |
| Body text | `#6a6a6a` | `text-[#6a6a6a]` |

**Never use:** amber, orange, stone, or any color not in the table above.

---

## The Island Layout (REQUIRED on every page)

```tsx
// Page root — always this structure
<div className="min-h-screen bg-[#D2E0D3] relative">

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

---

## Parallax Background Cards

Four fixed glassmorphism placeholder cards drift at different scroll rates. Copy this exactly:

These cards are brand atmosphere only. They must not become generic AI dashboard filler: keep them abstract, muted, and non-informational unless the page has real product states to show.

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
        <div key={j} className="w-4 h-4 bg-[#F2C3B9]/60 rounded-full" />
      ))}
    </div>
    <div className="space-y-2">
      <div className="h-3 bg-[#2a2a2a]/20 rounded w-full" />
      <div className="h-3 bg-[#2a2a2a]/20 rounded w-5/6" />
      <div className="h-3 bg-[#2a2a2a]/20 rounded w-4/6" />
    </div>
  </motion.div>
))}
```

---

## Right-Side Dot Navigation (desktop only)

One dot per section. `position: fixed`, `z-50`, desktop only (`hidden lg:flex`):

```tsx
<div className="fixed right-8 top-1/2 -translate-y-1/2 z-50 hidden lg:flex flex-col gap-4 bg-white/80 backdrop-blur-md rounded-full py-6 px-3 shadow-xl border border-[#97B3AE]/20">
  {sections.map(({ ref, label }) => (
    <button
      key={label}
      onClick={() => ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
      aria-label={`Go to ${label}`}
      className="w-3 h-3 rounded-full bg-[#97B3AE]/30 hover:bg-[#97B3AE] transition-all hover:scale-125"
    />
  ))}
</div>
```

---

## Navigation Bar

Always the first child inside the island. Teal circle + "REPWORTH" uppercase wordmark on the right:

```tsx
<nav className="px-8 py-4 border-b border-[#97B3AE]/10 flex items-center justify-between">
  <div className="flex items-center gap-8">
    {/* scroll buttons + <a href="/pricing"> link */}
  </div>
  <div className="flex items-center gap-2">
    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80" />
    <span className="text-sm tracking-wider uppercase text-[#97B3AE]">RepWorth</span>
  </div>
</nav>
```

---

## Typography Scale

| Element | Classes |
|---|---|
| Page h1 | `text-5xl md:text-6xl lg:text-7xl font-medium leading-tight text-[#2a2a2a]` |
| Section h2 | `text-4xl md:text-5xl font-medium text-[#2a2a2a]` |
| Card h3 | `text-xl md:text-2xl font-medium text-[#2a2a2a]` |
| Body | `text-lg text-[#6a6a6a] leading-relaxed` |
| Eyebrow | `text-sm tracking-wider uppercase text-[#97B3AE]` |
| Caption / note | `text-sm text-[#97B3AE] italic` |

---

## Animation Patterns

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

---

## Button Styles

| Type | Classes |
|---|---|
| Primary (teal pill) | `px-8 py-4 bg-[#97B3AE] text-white rounded-full shadow-lg` |
| Secondary (outline) | `px-8 py-4 bg-white text-[#97B3AE] rounded-full border border-[#97B3AE]/20` |
| Ghost | `px-8 py-4 bg-[#F0EEEA] text-[#2a2a2a] rounded-full border border-[#97B3AE]/10` |

Always wrap clickable buttons in `motion.button` with hover/tap variants above.

---

## Section Backgrounds (inside the island)

Alternate between these to create visual rhythm:

| Section type | Background |
|---|---|
| Default | `bg-white` |
| Tinted | `bg-gradient-to-b from-white to-[#F0EEEA]/30` |
| CTA (last section) | `bg-gradient-to-br from-[#97B3AE] to-[#97B3AE]/80 text-white rounded-b-[3rem]` |

---

## Feature / Info Cards

```tsx
<motion.div
  className="bg-white rounded-2xl p-6 border border-[#97B3AE]/10 shadow-lg"
  whileHover={{ y: -5, boxShadow: '0 20px 40px rgba(0,0,0,0.1)' }}
>
  {/* Icon circle */}
  <div
    className="w-12 h-12 rounded-full flex items-center justify-center mb-4 shadow-md"
    style={{ background: `linear-gradient(135deg, #97B3AE, #97B3AE cc)` }}
  >
    {/* Inline SVG — never use lucide-react or heroicons */}
    <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="..." />
    </svg>
  </div>
  <h3 className="text-xl mb-2 text-[#2a2a2a] font-medium">{title}</h3>
  <p className="text-[#6a6a6a]">{description}</p>
</motion.div>
```

Icon circle color per card: primary `#97B3AE`, accent `#F2C3B9`, muted `#D6CBBF` — rotate through for visual variety.

---

## Floating Accent Cards (dashboard mockups, stats)

Small cards that appear rotated, overlapping a main card:

Use these only when they support a real RepWorth product idea or supplied metric. Do not invent impressive-looking stats, charts, or labels just to fill space.

```tsx
<motion.div
  className="absolute -top-6 -right-6 w-32 h-24 bg-gradient-to-br from-[#F2C3B9]/40 to-[#F2C3B9]/20 rounded-xl backdrop-blur-sm border border-white/60 shadow-lg p-3"
  initial={{ opacity: 0, scale: 0.8, rotate: -5 }}
  whileInView={{ opacity: 1, scale: 1, rotate: 5 }}
  viewport={{ once: true }}
  transition={{ duration: 0.6, delay: 0.5 }}
>
  <div className="text-xs text-[#6a6a6a] mb-1">Label</div>
  <div className="text-xl text-[#2a2a2a]">Value</div>
</motion.div>
```

---

## Rules

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

---

## Anti-Slop Final Pass

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

If a section only exists to look impressive, delete it or replace it with one concrete RepWorth workflow/state.

---

## Common Mistakes

| Mistake | Fix |
|---|---|
| Cards directly on `#D2E0D3` without island | Wrap all content in `max-w-5xl bg-white rounded-[3rem]` island |
| `import { Check } from 'lucide-react'` | Inline SVG only |
| `import { motion } from 'framer-motion'` | `import { motion } from 'motion/react'` |
| `overflow-hidden` on root div | Remove it — clips nothing useful, breaks iOS |
| Amber/stone colors anywhere | Replace with sage green palette above |
| Generic AI hero with abstract claims | Use RepWorth-specific product language and one real workflow |
| Fake metrics, logos, avatars, or testimonials | Remove them unless supplied by the user/product |
| Decorative dashboard cards with no job | Replace with a plausible RepWorth state or keep it abstract |
| Hype copy like "unlock insights" or "supercharge" | Rewrite as concrete user action or outcome |
| Icon-only controls without labels | Add accessible names/tooltips and clear intent |
| `custom={direction}` on AnimatePresence with object animations | Remove — dead prop |
| `motion.div` without `whileInView` on scroll sections | Add scroll reveal pattern |