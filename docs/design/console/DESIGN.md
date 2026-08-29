# RepWorth Console — Style Reference

> **Scope:** `.rw-console` · **Tokens:** [`src/app/(authenticated)/_styles/tokens.css`](../../../src/app/(authenticated)/_styles/tokens.css) — declared on `.rw-console`, never `:root` ·
> **Utilities:** [`src/app/(authenticated)/_styles/theme.css`](../../../src/app/(authenticated)/_styles/theme.css) ·
> **Guards:** [`design-token-single-source.test.ts`](../../../src/__tests__/design-token-single-source.test.ts) (Console purity + contrast floors) · [`design-doc-token-pin.test.ts`](../../../src/__tests__/design-doc-token-pin.test.ts) (this doc's tables ↔ the CSS)
> Which system am I in? → [`docs/design/README.md`](../README.md)

## Overview

**Creative North Star: "Harbor."** One bright, warm-white console floats on a
deep sea-teal field. The 2026-08 redesign replaced the Warm Editorial cream +
serif register with this floating-canvas system: light navigation ink ON the
field, flat white cards with generous radii, a peach-gradient reputation hero,
and a coral attention accent. Chosen so the Console is visibly RepWorth — the
sea-teal ties back to the public brand family — and never a generic blue SaaS
dashboard.

The Console is designed for owner-operators checking reputation work between
real-world tasks. It favors a two-second scan, plain status language, and one
interpreted sentence beside the data. Motion acknowledges state and continuity;
it never delays the work. Product truth, especially the approval gate and the
agent run spine, outranks decorative analytics.

**Key characteristics:**

- A deep sea-teal field with light sidebar ink; the work surface floats as one
  rounded warm-white canvas.
- Friendly geometric display type (Gabarito, variable) paired with compact,
  highly legible UI type (Figtree).
- Flat white cards — hairline border, 20px radius, cool diffused shadow. One
  gradient hero, one inverted deep panel; everything else stays quiet.
- One interpreted sentence beside the data — The Interpretation Rule: the hero
  states its conclusion as a sentence before the numbers.
- Semantic colors that always retain a text, icon, shape, or positional cue.
- Desktop information density with a touch-ready mobile and hybrid-device path.

**Token-name stability.** The redesign changed token VALUES, not NAMES. The
historical names (`--rw-sage-*`, `--rw-blush-*`, `--rw-tray`) now carry Harbor
roles: sage = the deep-teal action accent, blush = the coral attention family,
tray = the cool mist fill. Harbor-only names (`--rw-field-deep`,
`--rw-hero-grad`, `--rw-deep-panel`) are additive.

## Tokens — Colors

The palette is a cool harbor neutral set with warm accent moments. Deep teal
indicates action and positive state; coral carries attention; terracotta is
reserved for danger; violet identifies Insights provenance; gold belongs only
to review ratings. Every row is declared in
`src/app/(authenticated)/_styles/tokens.css`.

### Accents

| Name | Value | Token | Role |
|---|---|---|---|
| Harbor Teal (deep) | `#3E6B65` | `--rw-sage-deep` / `--rw-accent-600` | accessible action accent — active states, links, CTAs (6.01:1 on card) |
| Teal hover | `#325750` | `--rw-accent-700` | hover |
| Teal ring | `#7FA8A1` | `--rw-accent-500` | focus ring, accent border |
| Teal badge bg | `#DFEAE7` | `--rw-accent-100` | accent badge background |
| Teal badge text | `#2F4A46` | `--rw-accent-800` | accent badge text |
| Teal soft | `rgba(127, 168, 161, 0.16)` | `--rw-sage-soft` / `--rw-accent-50` | accent panel wash |
| Teal line | `rgba(127, 168, 161, 0.36)` | `--rw-sage-line` | accent hairline |
| Coral Peach | `#F1B79E` | `--rw-blush` | attention, owner intervention |
| Coral wash | `#FBE9DE` | `--rw-blush-soft` | coral surface |
| Coral deep | `#A64E28` | `--rw-blush-deep` | accessible on coral wash (4.76:1) |
| Coral (decorative) | `#E8875F` | `--rw-coral` | large shapes only — gauge sweep, nav badge fill; never text |
| Coral text | `#B0522A` | `--rw-coral-deep` | accessible coral for text/icons (5.14:1 on card) |
| Terracotta Warning | `#A64033` | `--rw-danger` | destructive / error — never pure red (5.11:1 on danger wash) |
| Danger wash | `#F7E6E2` | `--rw-danger-soft` | error surface |
| Insights Violet | `#6F579E` | `--rw-violet` | Insights provenance (5.94:1 on card) |
| Violet wash | `#EFEAF6` | `--rw-violet-soft` | Insights surface |
| Review Gold | `#9A691D` | `--rw-star` | review star glyph — accessible warm gold (4.76:1 on card) |

### Neutrals & surfaces

| Name | Value | Token | Role |
|---|---|---|---|
| Canvas | `#FBFAF7` | `--rw-app-bg` | the floating console canvas, warm white |
| Canvas wash | `radial-gradient(120% 100% at 15% -10%, #ffffff 0%, #fbfaf7 48%, #f3f2ec 100%)` | `--rw-app-field` | the canvas's radial wash |
| Card | `#FFFFFF` | `--rw-app-surface` / `--rw-card` | card surface |
| Mist | `#EFF3F2` | `--rw-tray` | quiet fills — gauge track, neutral chips |
| Recess | `#F4F6F4` | `--rw-recess` | inputs, draft panels, quiet inset regions |
| Harbor Ink | `#22343B` | `--rw-app-text` | primary text and the strongest Console action |
| Muted slate | `#5C6B72` | `--rw-app-text-muted` | secondary evidence and supporting copy |
| Soft slate | `#566771` | `--rw-app-text-soft` | secondary text, AA on Console surfaces |
| Ink hover | `#16252B` | `--rw-app-text-hover` | hovered ink |
| On accent | `#FFFFFF` | `--rw-on-accent` | light text on dark semantic fills |
| On dark muted | `#B6C9CD` | `--rw-on-dark-muted` | secondary text on harbor-ink / deep-panel fills |
| Opaque white | `#FFFFFF` | `--rw-white` | opaque white surface |
| Hairline | `rgba(34, 52, 59, 0.08)` | `--rw-hair` | cool translucent rule |
| Hairline strong | `rgba(34, 52, 59, 0.14)` | `--rw-hair-2` | stronger cool rule |
| Border | `rgba(34, 52, 59, 0.10)` | `--rw-app-border` | card border |
| Border soft | `rgba(34, 52, 59, 0.06)` | `--rw-app-border-soft` | quiet divider |
| Overlay | `rgba(20, 32, 38, 0.50)` | `--rw-overlay` | dialog scrim |
| Field glass | `rgba(251, 250, 247, 0.85)` | `--rw-field-glass` | blurred fixed/sticky chrome |
| Floating surface | `rgba(255, 255, 255, 0.95)` | `--rw-floating-surface` | detached floating panels |
| Control hover | `#EDF1EF` | `--rw-control-hover` | hovered quiet control |
| Control surface | `#F2F5F3` | `--rw-control-surface` | quiet control at rest |
| Focus | `#3E6B65` | `--rw-focus` | keyboard focus (6.01:1 on app surface) |
| Focus ring | `rgba(62, 107, 101, 0.22)` | `--rw-focus-ring` | 3px focus halo |

### Harbor shell

| Name | Value | Token | Role |
|---|---|---|---|
| Sea-teal field | `#46606A` | `--rw-field-deep` | the field behind the floating canvas |
| Field gradient | `linear-gradient(160deg, #4A6570 0%, #46606A 55%, #3E565F 100%)` | `--rw-field-deep-grad` | subtle depth across the field |
| Nav ink | `#F0F5F4` | `--rw-nav-ink` | primary text on the field (6.07:1) |
| Nav ink muted | `#CFD9DB` | `--rw-nav-ink-muted` | secondary text on the field (4.65:1) |
| Nav hover | `rgba(255, 255, 255, 0.08)` | `--rw-nav-hover` | hovered nav row |
| Nav active | `rgba(255, 255, 255, 0.14)` | `--rw-nav-active` | active nav pill |
| Canvas shadow | `0 30px 70px -38px rgba(10, 25, 30, 0.55)` | `--rw-canvas-shadow` | the canvas float |
| Deep panel | `#33505A` | `--rw-deep-panel` | the one inverted card (Needs attention) |
| Deep panel soft | `rgba(255, 255, 255, 0.12)` | `--rw-deep-panel-soft` | fills and rules on the deep panel |
| Hero gradient | `linear-gradient(118deg, #C6DAD4 0%, #EADFCC 55%, #F4D9C2 100%)` | `--rw-hero-grad` | the reputation hero wash |
| Hero ink | `#33534D` | `--rw-hero-ink` | primary text on the hero (6.26:1 on the lightest stop) |
| Hero ink soft | `#4E6660` | `--rw-hero-ink-soft` | secondary text on the hero (4.58:1) |
| Hero chip | `rgba(255, 255, 255, 0.55)` | `--rw-hero-chip` | pills and deltas on the hero |
| Hero line | `rgba(51, 83, 77, 0.18)` | `--rw-hero-line` | stat separators and foot rule on the hero |
| Hero line soft | `rgba(51, 83, 77, 0.14)` | `--rw-hero-line-soft` | mini-trend gridlines |

### Semantic states

| Name | Value | Token | Role |
|---|---|---|---|
| Approve | `#16A34A` | `--rw-green-600` | approve action |
| Approve hover | `#15803D` | `--rw-green-700` | approve hover |
| Posted badge bg | `#DCFCE7` | `--rw-green-100` | badge: posted |
| Posted badge text | `#166534` | `--rw-green-800` | badge: posted |
| Success surface | `#F0FDF4` | `--rw-success-bg` | success panel |
| Wait badge bg | `#FEF9C3` | `--rw-yellow-100` | badge: wait states (reply held, medium escalation) |
| Wait badge text | `#854D0E` | `--rw-yellow-800` | badge: wait states (reply held, medium escalation) |
| Warning surface | `#FFFBEB` | `--rw-warning-bg` | warning panel |
| Warning text | `#92400E` | `--rw-warning-fg` | warning copy |
| Info surface | `#EFF6FF` | `--rw-info-bg` | info panel |
| Info text | `#1E40AF` | `--rw-info-fg-soft` | info copy |
| Attention surface | `#FBE9DE` | `--rw-attn-bg` | coral wash — reconnect banner + awaiting_manual_post badge |
| Attention border | `#F1B79E` | `--rw-attn-border` | coral peach |
| Auto badge bg | `#EDE9FE` | `--rw-auto-bg` | auto-approved provenance badge |
| Auto badge text | `#5B21B6` | `--rw-auto-fg` | auto-approved provenance badge |

Ranking-chart series rotation is `--rw-chart-1` … `--rw-chart-6` (data-viz colors,
deliberately outside the harbor palette and exempt from the amber/orange ban by
`console-admin-palette.test.ts`).

### Named rules

**The Two Registers Rule.** Island owns public surfaces; Harbor owns
authenticated surfaces. Never mix them within one screen.

**The Actionable Color Rule.** Decorative coral (`--rw-coral`) and pale teal
never carry text, links, or button labels. Interactive color must meet contrast
in its actual state.

**The Evidence Color Rule.** Color never carries reputation status alone; pair
it with copy, shape, iconography, or position.

**The Interpretation Rule.** The dashboard's most prominent line is a sentence
that interprets the data (`computeHeroHeadline`, `repPulseNote`), derived
deterministically from real windowed values — never an adjective the data
cannot back.

## Tokens — Typography

### Families

| Role | Stack | Token | Declared by |
|---|---|---|---|
| Display | Gabarito, variable 400–900 (system sans fallback) | `--rw-font-display` | `(authenticated)/layout.tsx` — a `localFont` variable on the `.rw-console` element |
| Body / UI | Figtree, variable 300–900 (system sans fallback) | `--rw-font-body` | `(authenticated)/layout.tsx` (same mechanism); brand default in `globals.css` |
| Mono | `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace` | `--rw-font-mono` | `console.css` — a `.rw-console` override (brand default JetBrains Mono in `globals.css`) |

The font families are the one token group the Console does **not** own — they are
brand-wide, `globals.css` is their single owner, and it loads on every route (see root
[`DESIGN.md`](../../../DESIGN.md)). The Console's two overrides both live **inside its
scope**, never as a second `:root` declaration: display and body are `localFont`
variables bound on the element that carries `.rw-console`, and mono is a `.rw-console`
rule in `console.css` that keeps the Console on the system mono stack.

**Character:** Gabarito's rounded geometry makes the numbers and headings feel
friendly and product-y without drifting into toy territory. Figtree keeps dense
review, settings, and billing work direct and readable.

**How the display swap happens.** `globals.css` sets `--rw-font-display` to Plus Jakarta
Sans on every route. The authenticated layout mounts a self-hosted `localFont` whose
`variable` is `--rw-font-display` on the **same element** that carries `.rw-console`
(`src/app/(authenticated)/layout.tsx`), so the token resolves to Gabarito inside the
Console and to Plus Jakarta everywhere else. Gabarito and Figtree are self-hosted for
the same reason as the root-layout faces — any `next/font/google` import re-introduces
a compile-time fetch.

**And it reaches the composite roles, because of where they are declared.** A `var()`
inside a custom property is substituted where that property is **declared**, not where
it is used. The `--rw-app-h1…--rw-app-micro` shorthands below are declared on
`.rw-console` — the same element that carries the `localFont` variables — so
`var(--rw-font-display)` inside them resolves to Gabarito at declaration time.
`font: var(--rw-app-h1)` **alone** therefore renders Gabarito anywhere in the Console.

### Role tokens

Composite `font:` shorthands declared in `tokens.css` and consumed from `console.css`
(`.page-title`, section and card headings, `.stat` numerals, form labels):

| Role | Value | Token |
|---|---|---|
| Page title | `700 1.5rem/1.2 var(--rw-font-display)` | `--rw-app-h1` |
| Section | `600 1.125rem/1.3 var(--rw-font-display)` | `--rw-app-h2` |
| Card heading | `600 1rem/1.3 var(--rw-font-display)` | `--rw-app-h3` |
| Stat numeral | `700 1.875rem/1.1 var(--rw-font-display)` | `--rw-app-stat` |
| Form label | `500 0.875rem/1.3 var(--rw-font-body)` | `--rw-app-label` |
| Body | `400 0.875rem/1.5 var(--rw-font-body)` | `--rw-app-body` |
| Badge / micro | `500 0.75rem/1.3 var(--rw-font-body)` | `--rw-app-micro` |

### The shipped hierarchy

Component-level sizes measured off the live Console (they are written in
`console.css` and the components, not as tokens):

- **Display** (600–700, 22–26px, 1.2–1.3): page titles, the hero's interpretation line, and the largest reputation values.
- **Headline** (600, 18px, 1.3): card and section headings.
- **Title** (600, 16px, 1.3): functional subheads in Figtree when emphasis must remain operational.
- **Body** (400, 14px, 1.5): standard owner-console copy; explanatory text should stay within roughly 70 characters per line.
- **Label** (600, 12px, 0.04em): compact status and field context. Uppercase is reserved for short factual labels.

The steps are deliberately small (24 → 18 → 16 → 14 → 12): a dashboard scale,
not a landing-page scale.

### Named rules

**The Display Discipline Rule.** Gabarito is variable but the Console uses only
600/700 for display roles — never faux styles, never a 900 shout. Sub-heading
hierarchy comes from the Figtree functional scale (500/600/700).

## Tokens — Spacing & Shape

### Spacing scale

| Name | Value | Token |
|---|---|---|
| 1 | `0.25rem` | `--rw-sp-1` |
| 2 | `0.5rem` | `--rw-sp-2` |
| 3 | `0.75rem` | `--rw-sp-3` |
| 4 | `1rem` | `--rw-sp-4` |
| 6 | `1.5rem` | `--rw-sp-6` |
| 8 | `2rem` | `--rw-sp-8` |
| 12 | `3rem` | `--rw-sp-12` |
| 16 | `4rem` | `--rw-sp-16` |
| 20 | `5rem` | `--rw-sp-20` |

Spacing follows a 4px base rhythm, with 16–26px inside components and 22px
between major dashboard zones.

### Border radius

| Element | Value | Token |
|---|---|---|
| Chart bar corner | `0.25rem` (4px) | `--rw-radius-xs` |
| App button / input | `0.375rem` (6px) | `--rw-radius-sm` |
| App card (small) | `0.5rem` (8px) | `--rw-radius-md` |
| App stat tile | `0.75rem` (12px) | `--rw-radius-lg` |
| Inner panel | `0.875rem` (14px) | `--rw-radius-core` |
| Card | `1.25rem` (20px) | `--rw-radius-card` |
| Console canvas | `1.75rem` (28px) | `--rw-radius-canvas` |
| Pill | `9999px` | `--rw-radius-pill` |

Operational controls use gently curved 6–8px corners. Cards use the 20px Harbor
radius; the floating canvas itself uses 28px. Pills are reserved for compact
actions, filters, tabs, statuses, and small numeric badges. The 48px Island
corner belongs to public island containers and **never** appears inside the
Console shell.

### Shadows / elevation

| Name | Value | Token |
|---|---|---|
| Quiet Surface | `0 1px 2px rgba(20, 35, 40, 0.04), 0 8px 20px -16px rgba(20, 35, 40, 0.16)` | `--rw-shadow-sm` |
| Card at rest | `0 1px 2px rgba(20, 35, 40, 0.04), 0 14px 30px -22px rgba(20, 35, 40, 0.20)` | `--rw-shadow` |
| Raised Surface | `0 2px 4px rgba(20, 35, 40, 0.04), 0 24px 46px -30px rgba(20, 35, 40, 0.28)` | `--rw-shadow-lg` |
| Floating Surface | `0 18px 40px -18px rgba(20, 35, 40, 0.30)` | `--rw-shadow-pop` |
| Inset Highlight | `inset 0 1px 0 rgba(255, 255, 255, 0.7)` | `--rw-inset-hi` |

Shadows are cool, slate-tinted and diffused — **never harsh black**.

### Motion

| Name | Value | Token |
|---|---|---|
| Ease out | `cubic-bezier(0.25, 0.46, 0.45, 0.94)` | `--rw-ease` |
| Ease in-out | `cubic-bezier(0.42, 0, 0.58, 1)` | `--rw-ease-inout` |
| Decelerate (confident arrival, no overshoot) | `cubic-bezier(0.32, 0.72, 0, 1)` | `--rw-ease-decelerate` |
| Fast | `200ms` | `--rw-dur-fast` |
| Base | `500ms` | `--rw-dur-base` |
| Slow | `800ms` | `--rw-dur-slow` |

**`prefers-reduced-motion`:** every Console transition resolves to its final state with
no transition.

### Layout

| Concern | Value | Token |
|---|---|---|
| Desktop sidebar | `240px` | `--rw-sidebar-width` |

The authenticated shell paints the sea-teal field across the viewport. The
fixed 240px sidebar sits ON the field in light ink; `.main` floats beside it as
one rounded canvas (`--rw-radius-canvas`, `--rw-canvas-shadow`, 12px gutter,
`overflow: clip` so the sticky topbar keeps sticking). The dashboard content
container reaches 1140px; settings stop at 880px; focused wizards stop at
640px. The sticky save bar's `left` offset derives from `--rw-sidebar-width` so
the two can never drift.

Below the shell breakpoint (< 960px) the sidebar becomes a fixed bottom
navigation, the canvas goes edge-to-edge (margin 0, radius 0), content
collapses to one or two columns according to information density, the hero row
stacks, settings tabs scroll horizontally, and safe-area insets protect bottom
actions. The save bar offsets above the mobile tab bar so the two coexist.
Tables may scroll horizontally when preserving column relationships is more
useful than converting them to cards. All touch-capable devices, including
hybrids, receive at least 44px interactive targets.

**The Two-Second Glance Rule.** The dashboard overview contains only the
reputation state (hero + Rep Pulse), **the weekly recap**, the agent team, the
exception queue, and clear doorways to pending work and analytics.

*Amended 2026-08-28 (owner-approved).* The recap joined the list because the
screen answered "how are you doing" only at one time scale — right now — and
never "what did this week do". The rule's purpose is unchanged: it is a
whitelist, not a suggestion, and it exists so the overview cannot silently
accumulate charts. Two things it still forbids, and why:

- **No review content.** The reviews themselves are the Reviews page's object.
  The overview shows the shape of the week, not the week's rows.
- **No second copy of an Analytics chart.** The recap reads the *same* weekly
  series the Analytics trend plots, so the two can never disagree; it is not a
  second query, and it is not the same picture. Anything that would be the same
  picture belongs on Analytics.

## Components

Component primitives live in the app's existing CSS files (`_styles/console.css`,
`_styles/settings.css`) — **not** a new Tailwind utility sprawl. Keep the existing
class-based architecture.

### Card

Role: every dashboard card. One flat, bright surface.

- Spec: `--rw-card` fill, `--rw-hair` border, `--rw-radius-card`, `--rw-shadow`
  at rest.
- States: `--rw-shadow-lg` only when interaction or layering requires it.
- **Never** stack extra borders, rings, or glows to manufacture depth — depth
  belongs to the canvas float and the shadow.

### The three special surfaces

Exactly three surfaces may break the flat white card, one instance each on the
dashboard:

1. **Hero** (`.rep-hero`): `--rw-hero-grad` wash, `--rw-hero-ink` text, the
   interpretation headline, and the real 8-week mini trend.
2. **Rep Pulse** (`.pulse-card`): the coined 0–100 score. Gauge sweep is
   `--rw-coral`; the formula is transparent (rating 70 / response 30,
   `src/lib/dashboard/rep-pulse.ts`) and a missing baseline shows a dash, never
   an invented number.

   **"What moved it" is answered in the card, not behind a link.**
   `.pulse-breakdown` decomposes the score into the inputs that produced it,
   each showing the value the owner already knows and the points it earned of
   the points it could have. The last contribution is derived by subtraction, so
   the parts always sum to the score on screen — independently rounded parts can
   miss the whole by a point, and numbers that do not add up read as a bug.

   **While ramping, the same slot names the inputs without measuring them**
   (`.pulse-preview`). The formula is published, so the owner can be told *what*
   will set the score. Values and points are withheld deliberately: showing the
   arithmetic would let the score be reconstructed, which is exactly what the
   ramping state exists to prevent.
3. **Deep panel** (`.needs-attention`): `--rw-deep-panel` fill with
   `--rw-nav-ink` / `--rw-on-dark-muted` text — the exception queue is the
   only inverted card, so what needs the owner is also the strongest mass.

### Buttons

- **Shape:** compact pills for dashboard actions and 8px corners inside settings workflows.
- **Primary** (`.btn-primary`): harbor-ink fill (`--rw-app-text`) for the strongest owner
  action; **`.btn-sage`** where selection or connection is the meaning.
- **Secondary / ghost / tertiary** (`.btn-ghost`, `.btn-quiet` — e.g. Regenerate):
  white or transparent surfaces with ink or muted text.
- **Destructive** (`.btn-danger`): terracotta only.
- **Button-in-button:** trailing arrow/check in its own nested circle (`.btn-icon`) that
  translates diagonally + scales on hover; the whole button goes `active:scale(.975)`.
- **Hover / focus:** short explicit color, border, shadow, or transform transitions; a
  visible teal focus ring. **Never** a broad transition of every property.

### Chips / badges

- **Style:** small pills with a semantic wash and an accessible foreground.
- **Variants:** `pending` (coral), `posted` (teal), `auto` (violet).
- **State:** selection changes fill, foreground, weight, and where useful a check or
  position — **not color alone**.

### Stars

Warm gold (`--rw-star`) is the filled glyph on white surfaces; on the hero
gradient the star run uses `--rw-hero-ink` and the adjacent numeral carries the
value. Rating stars carry an accessible label. Gold belongs only to review
ratings — it must not become a warning or CTA color.

### Deltas

`.rep-delta` up/down/flat: a pill with an arrow; teal register = good, coral =
bad. Honest and unit-carrying (rating points / points / hrs). Hidden while
ramping.

### Form controls

- **Style:** recessed field (`--rw-recess`), 8px radius, readable 14px text, and
  sufficient mobile focus sizing.
- **Focus:** deep teal border (`--rw-focus`) with a three-pixel translucent halo
  (`--rw-focus-ring`).
- **Error / disabled:** terracotta copy on an accessible wash for errors; muted ink and a
  recessed surface for disabled controls.
- **Members:** `.textarea` / `.input`, `.tone-chips` / `.chip` (teal selected),
  `.list-editor` (rows + delete + "Add another").

### Save bar

Sticky pill, blurred, "N unsaved changes · Discard / Save". Its `left` offset derives
from `--rw-sidebar-width`; on mobile it offsets above the tab bar.

### Navigation

Desktop navigation is a light-ink rail ON the sea-teal field: icon, label, and a
translucent active pill (`--rw-nav-active`). Mobile navigation is a fixed
bottom bar with safe-area padding. Both use `aria-current`, persistent text
labels, and the same information architecture. Icons are ultra-light line
inline SVGs (`src/components/dashboard/shell/Icon.tsx`). The pending-count
badge is the one `--rw-coral` fill in the rail.

**The rail reads top to bottom as identity → work → utility → brand:**

1. **Identity, not a logo.** The most convenient spot in the shell carries the
   account control (`AccountMenu`: avatar, owner name, `chevron-updown`) and,
   under it, the location the numbers describe. Two identities, because the
   owner switches between both. A logo in this slot spends the best real estate
   on something the owner already knows.
2. **The work group** — Dashboard, Reviews, Requests, Analytics — with status in
   the right-hand room of the row (the pending badge).
3. **Nested children** (`.nav-child`) appear under a parent only while that
   section is active, indented against a rule rather than given a second icon
   set. This is how `/dashboard/reviews/history` became reachable from the nav.
4. **The utility dock** — Settings, Help — held at the base by
   `.nav-section--utility`, separated by a rule, because they are rarely used.
5. **The wordmark** sits quietly at the foot (`.sidebar-brand`).

Below the shell breakpoint the sidebar is hidden entirely, so the account
control is mirrored into the top bar as `.acct--compact` (avatar only). It is
the only route to sign out on mobile; removing it strands the owner.

The promo/upsell slot at the base of the rail is deliberately **empty**. Nothing
honest fits there yet — a trial-status card is the natural occupant once
`trialEndsAt` reaches the layout, and a pending-work card would duplicate the
badge two rows above it.

### Reputation evidence (charts)

Charts provide a textual summary or data table, not just graphical marks, and carry
`role="img"` plus a label. **Synthetic trends are forbidden:** when historical data does
not exist, show the value without a fabricated sparkline — the hero mini trend and the
Rep Pulse gauge both render their empty state instead. Keep charts hand-rolled SVG —
no charting library.

### The weekly recap

Role: the second time scale. The hero says how you are doing now; `.recap` says
what this week did. A **flat Harbor card** — the hero above it is the screen's
one gradient and the exception queue below is its one inverted panel, so the
recap earns no third special surface.

- **Conclusion first.** `.recap-headline` states a count as a sentence
  (`computeWeeklyRecap`), never an adjective the data cannot back. "3 new
  reviews this week", not "a strong week".
- **The "why" line** (`.recap-why`) is the in-place answer to the question the
  sparkline provokes. It is one deterministic observation about weeks the owner
  can see in that same sparkline — a gap, a last-arrival, a peak — chosen by a
  fixed ladder. Never a rating comparison, which the ramping state withholds.
- **Weekly counts are bars, not a line.** A line between weekly totals implies
  values between the weeks, and there are none. Bars grow via `scaleY`, and a
  zero week keeps a visible track so the run reads at its true length.
- **The Insights brief is optional enrichment**, capped at three bullets. The
  card must be complete without it, because a new account has none.
- The covered week is the last bucket, which is always the week still running,
  so the range carries "so far".

### Tabs

Two kinds of tab, and they are not interchangeable:

- **Route tabs** (`ReviewsTabs`, the settings rail) navigate between pages. They
  are a `<nav>` with `aria-current="page"` — never `role="tab"`.
- **View tabs** (`CardViewTabs`) swap a panel inside one card without leaving
  the page. They are a real `role="tablist"` / `role="tab"` / `role="tabpanel"`
  set with `aria-selected`, one tab in the tab order, and arrow/Home/End
  movement where selection follows focus. A mutually exclusive pair rendered as
  two `aria-pressed` buttons announces "two toggles" instead of "one of these
  two", which is what the aggregate velocity and ranking cards used to do.

Shape: the `.card-view-tabs` pill container is recessed (`--rw-recess`) because
it sits ON a card, where `.tabs` sits on the canvas and is raised.

### Action surfaces

Which surface a context earns, by how much it interrupts:

| Surface | Use when | Blocking |
|---|---|---|
| Popover menu | The context is simple and dismissible with no consequence | No |
| Modal `<dialog>` | The context is complex but belongs to this page | Yes |
| New page | The context is permanent or large — and it owes a back link or breadcrumb | n/a |
| Toast | Reporting the RESULT of an action, without taking the screen | No |

**Popover menus** (`useMenuPopover`) are the single owner of menu behavior:
outside-click dismissal, Escape with focus restored to the trigger, Tab to
close, and roving Arrow/Home/End over anything with a `menuitem` role. Two
callers — the location switcher and the account menu. A menu that reimplements
any of this is a bug, not a variant.

### Toasts

The Console's one confirmation surface, bottom-centred above the mobile tab bar
and the settings save bar.

- **Both arms ship together.** A blocking action reports success *and* failure.
  The failure arm is the one that gets skipped, so it is not optional.
- **Tone carries urgency, not just colour:** `success` and `info` are
  `role="status"` / polite; `error` is `role="alert"` / assertive and stays up
  twice as long, because it usually asks the owner to do something. Each tone
  also carries an icon, so the outcome survives without colour.
- A toast announces its own text. Do **not** pair one with a `LiveRegion`
  carrying the same words — that reads it twice.
- It renders inside `.rw-console` with no portal, so the scoped tokens resolve.

### Dialogs

Use native modal dialogs for consequential settings actions. The dialog owns its
full-viewport dismissal surface, Escape behavior, focus containment, and accessible
name. Every destructive modal states the consequence and presents explicit cancel and
confirm actions.

### States

| State | Owner | Notes |
|---|---|---|
| Connect-Google banner | `ConnectGoogleBanner.tsx` | coral, above hero |
| Past-due banner | `SubscriptionStatusBanner.tsx` / `PastDueBanner` | terracotta, 7-day grace (invariant #11) |
| All caught up | `PendingApprovalsStrip` (calm) | teal, no CTA, pending = 0 |
| Ramping hero | `ReputationHeroBand` (compact) | current values, **no delta arrows**, baseline copy |
| Ramping Rep Pulse | `RepPulseCard` | a dash + "appears after your first weeks" + `.pulse-preview`, never a fake score |
| Quiet recap week | `WeeklyRecapCard` | "No new reviews yet this week" + when the last one arrived |
| Quiet recap run | `WeeklyRecapCard` | "No reviews in the last N weeks" — content, not an absence |

**The ramping state hides two of the three special surfaces.** An account under
`RAMPING_AGE_DAYS` (21) gets no hero mini trend and no Rep Pulse score, so a new
owner's first three weeks look markedly emptier than the design implies. That is
correct — neither number is trustworthy yet — but it means the empty states
below are what a new owner actually sees, and they carry more weight than their
frequency in a mature account suggests. Design them first, not last.
| Regenerate limit reached | `ReviewActions.tsx` (`kind:'limit'`) | gold "heads up" + Back link, replaces the action row — **not** a red error |
| Loading / error | skeleton + error card in `DashboardContent.tsx` | harbor tokens |
| Settings saved | `SettingsShell` → success toast | rising edge of `savedFlash`, not a value read |
| Sign out failed | `AccountMenu` → error toast | the owner stays signed in; the menu reopens focus on the trigger |

## Do's and Don'ts

### Do:

- **Do** make the owner's current reputation state and next action obvious within seconds.
- **Do** state the conclusion as a sentence beside the data (The Interpretation Rule) — deterministically, from real values.
- **Do** use named RepWorth roles—Reply, Guardian, Insights, Judge, Governor—and preserve their actual capabilities.
- **Do** resolve reduced-motion experiences directly to the final visual state while preserving immediate feedback.
- **Do** use `any-pointer: coarse` when adapting targets for devices that can accept touch.
- **Do** keep public Island and authenticated Console tokens single-sourced in their owning stylesheets.
- **Do** put a visible teal focus ring on every interactive element; settings tabs keep roving-tabindex + arrow-key nav.
- **Do** preserve the existing `LiveRegion` announcements (dashboard load, settings save-error). The settings save CONFIRMATION is announced by its toast instead — one announcer per message, never both.
- **Do** keep touch targets ≥44px on mobile.

### Don't:

- **Don't** fabricate trends, metrics, testimonials, customers, or agent activity — Rep Pulse included: no baseline, no score.
- **Don't** use decorative coral (`--rw-coral`) or pale teal for text or controls.
- **Don't** introduce purple-blue AI gradients, black glass, orbital decoration, or generic chatbot imagery.
- **Don't** add a second gradient card or a second inverted panel to a screen — the hero and the deep panel earn their contrast by being alone.
- **Don't** use a colored side border as generic card decoration; borders may distinguish a real comparison or system state only when the structure requires it.
- **Don't** animate layout-driving properties or leave broad `transition: all` declarations in production UI.
- **Don't** use emoji or Unicode symbols as substitutes for the established inline SVG icon system.
- **Don't** use amber, orange, or stone — locked by [`console-admin-palette.test.ts`](../../../src/__tests__/console-admin-palette.test.ts) (class-name level). The coral family is declared as hex tokens and stays inside the roles above. The only class-level exemption is the chart **series** rotation.
- **Don't** write a literal hex in a component; use `var(--rw-*)` or the `rw-*` Tailwind utilities.
- **Don't** re-declare an Island color or font token in the Console token file — that reintroduces the `--rw-sage` collision.

### Anti-slop hygiene

- No over-used faces (Inter / Roboto / Fraunces / Geist / Plus Jakarta / Space Grotesk / Instrument Serif) as the Console display face.
- No numbered section markers (`01/02/03`); no eyebrow-chip on every card.
- Em-dash discipline in body copy (≤2; prefer periods/commas).
- Motion only via `transform` / `opacity` / `filter` (GPU-safe; SVG line/gauge
  draws via `stroke-dashoffset` are the sanctioned chart exception);
  `backdrop-blur` only on fixed/sticky elements.

### Contrast

Harbor ink `#22343B` on white is ~12.9:1 (AAA). Target ≥4.5:1 for text and ≥3:1 for
large/UI on every semantic pair. The floors that matter are asserted, not assumed —
`design-token-single-source.test.ts` computes the ratio for soft slate, harbor teal,
coral-deep, danger, violet, star, on-accent, info, warning, success, on-dark-muted,
and the focus indicator, and fails the build if a value drifts under. The shell pairs
(nav ink on field, hero ink on gradient, on-dark-muted on deep panel) were computed at
design time and are restated in the tables above.

## Surfaces & Elevation

Depth is **environmental**: the canvas floats on the deep field under one large
cool shadow, and cards sit flat on the canvas with hairline borders and quiet
shadows. Shadows grow progressively stronger only for floating controls,
dialogs, or an intentional hover response. Fixed top bars and save bars may use
bounded backdrop blur because they reveal content passing beneath them.

### Shadow vocabulary

- **Quiet Surface** (`--rw-shadow-sm` / `--rw-shadow`): a small cool ambient shadow for cards at rest.
- **Raised Surface** (`--rw-shadow-lg`): a longer diffuse shadow for hovered or layered cards.
- **Floating Surface** (`--rw-shadow-pop`): the strongest shadow for dialogs and detached controls.
- **Canvas Float** (`--rw-canvas-shadow`): reserved for `.main` — the one shadow that sells the harbor metaphor.

### The field

The viewport ground is `--rw-field-deep` carrying `--rw-field-deep-grad`; the
canvas is `--rw-app-bg` with the `--rw-app-field` radial wash and a fixed
whisper grain overlay (opacity ~0.04).

### Named rules

**The One Card Rule.** A card is one surface: fill + hairline + shadow. Do not
stack rings, inner glows, or a second border to manufacture depth — that was
the old system's double-bezel, and it is gone.

## Imagery & Motion

- **Entry:** `.section-enter` fade-up over ~520ms, staggered per dashboard zone.
- **Hero mini trend + Rep Pulse gauge** draw once on entry via
  `stroke-dashoffset` (`rw-trend-draw`, `rw-gauge-sweep`), ~1.2–1.4s with
  confident deceleration (`--rw-ease-decelerate`).
- **Velocity bars** grow via `transform: scaleY()` (bottom origin) — **not** height.
- **Button-in-button** hover physics; `active:scale(.975)`.
- **Card hover** on stat tiles and agent cards: `translateY(-2px)` + shadow, 200ms.
- **Live pill** pulse (green ring) — a distinct opacity-only keyframe
  (`rw-live-pulse`) from the loading skeleton's (`rw-skeleton-pulse`).
- **`prefers-reduced-motion`:** all of the above resolve to the final state, no
  transition.
- **Imagery:** inline SVG only, ultra-light line icons. No emoji or Unicode symbols as
  substitutes. Charts carry text equivalents.

## Agent prompt guide

- **"Build a primary button on this surface"** → `.btn-primary`: harbor-ink fill
  (`--rw-app-text`) with white text (`--rw-on-accent`), `--rw-radius-pill`, ~36px tall,
  9px/17px padding, teal focus ring. Use `.btn-sage` instead when the meaning is
  selection or connection.
- **"Build a card"** → the Harbor card: `--rw-card` fill, `--rw-hair` border,
  `--rw-radius-card`, `--rw-shadow`. Never a second border, ring, or glow.
- **"Show a status"** → a semantic chip: wash + accessible foreground + a word.
  `pending` = coral, `posted` = teal, `auto` = violet. Never color alone.
- **"Show a trend"** → only if the history exists. `--rw-star` is for rating stars only;
  a missing series means show the value with no sparkline.
- **"Add a settings field"** → `.input` / `.textarea` on `--rw-recess`,
  `--rw-radius-md`, 14px Figtree, `--rw-focus` border + `--rw-focus-ring` halo, and the
  sticky save bar for the commit.
- **"Touch the hero, the gauge, or the deep panel"** → read "The three special
  surfaces" first; each exists exactly once.

## Exports

- **CSS variables:** [`src/app/(authenticated)/_styles/tokens.css`](../../../src/app/(authenticated)/_styles/tokens.css)
  — the `.rw-console` block IS the export; do not copy it here. The file opens no
  `:root` block, so nothing it declares can reach a surface outside the Console even
  if the chunk survives a client navigation
  ([`design-token-single-source.test.ts`](../../../src/__tests__/design-token-single-source.test.ts)
  fails if one comes back).
- **Tailwind v4:** [`src/app/(authenticated)/_styles/theme.css`](../../../src/app/(authenticated)/_styles/theme.css)
  — the `@theme inline` block IS the export. It is `@import`ed from
  [`src/app/globals.css`](../../../src/app/globals.css) (Tailwind v4 bundles local
  `@import`s and reads `@theme` across them), so a Console overhaul never opens the
  Island file. `inline` means each utility emits `var(--rw-*)` — a reference, not a
  copied hex — so `tokens.css` stays the single source of values.
- **Scope:** `.rw-console` is applied in `src/app/(authenticated)/layout.tsx`;
  `_styles/console.css` owns the scoped element styles.
