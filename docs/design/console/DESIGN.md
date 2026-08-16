# RepWorth Console — Style Reference

> **Scope:** `.rw-console` · **Tokens:** [`src/app/(authenticated)/_styles/tokens.css`](../../../src/app/(authenticated)/_styles/tokens.css) ·
> **Utilities:** `src/app/(authenticated)/_styles/theme.css` (created in PR 2; until then the block lives in `globals.css` `@theme inline`) ·
> **Guard:** [`src/__tests__/design-token-single-source.test.ts`](../../../src/__tests__/design-token-single-source.test.ts)
> Which system am I in? → [`docs/design/README.md`](../README.md)

## Overview

**Creative North Star: "The Warm Editorial Console."** Chosen to deliberately *not*
read as a typical blue SaaS dashboard. The authenticated owner surface is a calmer,
denser work surface built from cream paper, espresso ink, concentric trays, and
restrained semantic color.

The Console is designed for owner-operators checking reputation work between real-world
tasks. It favors a two-second scan, plain status language, and quiet evidence over
generic dashboard spectacle. Motion acknowledges state and continuity; it never delays
the work. Product truth, especially the approval gate and agent run spine, is more
important than decorative analytics.

**Key characteristics:**

- Warm paper surfaces with espresso text and rare sage action color.
- Editorial display type (Young Serif, single weight) paired with compact, highly
  legible UI type (DM Sans).
- Concentric tray-and-core cards that communicate structure without heavy chrome.
- Semantic colors that always retain a text, icon, shape, or positional cue.
- Desktop information density with a touch-ready mobile and hybrid-device path.

## Tokens — Colors

The palette is warm, low-chroma, and role-driven. Sage indicates action and positive
state; blush carries attention; terracotta is reserved for danger; violet identifies
Insights provenance; gold belongs only to review ratings. Every row is declared in
`src/app/(authenticated)/_styles/tokens.css`.

### Accents

| Name | Value | Token | Role |
|---|---|---|---|
| Guardian Sage (deep) | `#527069` | `--rw-sage-deep` / `--rw-accent-600` | accessible action accent — active nav, links, CTAs (5.33:1 on card) |
| Sage hover | `#527069` | `--rw-accent-700` | hover |
| Sage ring | `#97B3AE` | `--rw-accent-500` | focus ring, accent border |
| Sage badge bg | `#E4ECEA` | `--rw-accent-100` | accent badge background |
| Sage badge text | `#4A615C` | `--rw-accent-800` | accent badge text |
| Sage soft | `rgba(151, 179, 174, 0.16)` | `--rw-sage-soft` / `--rw-accent-50` | accent panel wash |
| Sage line | `rgba(151, 179, 174, 0.34)` | `--rw-sage-line` | accent hairline |
| Approval Blush | `#F2C3B9` | `--rw-blush` | attention, owner intervention |
| Blush wash | `#FBEDE9` | `--rw-blush-soft` | blush surface |
| Blush deep | `#934D3F` | `--rw-blush-deep` | accessible on blush wash (5.45:1) |
| Terracotta Warning | `#A64033` | `--rw-danger` | destructive / error — never pure red (5.11:1 on danger wash) |
| Danger wash | `#F7E6E2` | `--rw-danger-soft` | error surface |
| Insights Violet | `#6F579E` | `--rw-violet` | Insights provenance (5.85:1 on card) |
| Violet wash | `#EFEAF6` | `--rw-violet-soft` | Insights surface |
| Review Gold | `#9A691D` | `--rw-star` | review star glyph — accessible warm gold (4.68:1 on card) |

### Neutrals & surfaces

| Name | Value | Token | Role |
|---|---|---|---|
| Paper Field | `#FDFBF7` | `--rw-app-bg` | page canvas, warm off-white |
| Porcelain Card | `#FFFDF9` | `--rw-app-surface` / `--rw-card` | card core, opaque floating surface |
| Tray | `#F4EEE4` | `--rw-tray` | double-bezel outer |
| Worktable Recess | `#F7F3EC` | `--rw-recess` | inputs, draft panels, quiet inset regions |
| Espresso Ink | `#2A2118` | `--rw-app-text` | primary text and the strongest Console action |
| Warm Muted Ink | `#6B5E50` | `--rw-app-text-muted` | secondary evidence and supporting copy |
| Soft ink | `#716457` | `--rw-app-text-soft` | secondary text, AA on Console surfaces |
| Ink hover | `#3D3122` | `--rw-app-text-hover` | hovered ink |
| On accent | `#FFFDF9` | `--rw-on-accent` | light text on dark semantic fills |
| On dark muted | `#D8CFC4` | `--rw-on-dark-muted` | secondary text on espresso overlays |
| Opaque white | `#FFFFFF` | `--rw-white` | opaque white surface |
| Hairline | `rgba(80, 60, 40, 0.08)` | `--rw-hair` | warm translucent rule |
| Hairline strong | `rgba(80, 60, 40, 0.14)` | `--rw-hair-2` | stronger warm rule |
| Border | `rgba(80, 60, 40, 0.10)` | `--rw-app-border` | card border |
| Border soft | `rgba(80, 60, 40, 0.06)` | `--rw-app-border-soft` | quiet divider |
| Overlay | `rgba(42, 33, 24, 0.48)` | `--rw-overlay` | dialog scrim |
| Field glass | `rgba(253, 251, 247, 0.82)` | `--rw-field-glass` | blurred fixed/sticky chrome |
| Floating surface | `rgba(255, 253, 249, 0.95)` | `--rw-floating-surface` | detached floating panels |
| Control hover | `#F3EFE8` | `--rw-control-hover` | hovered quiet control |
| Control surface | `#F8F4ED` | `--rw-control-surface` | quiet control at rest |
| Focus | `#557069` | `--rw-focus` | keyboard focus (5.29:1 on app surface) |
| Focus ring | `rgba(85, 112, 105, 0.20)` | `--rw-focus-ring` | 3px focus halo |
| Field wash | `radial-gradient(140% 120% at 12% -8%, #ffffff 0%, #fdfbf7 46%, #f6f1e9 100%)` | `--rw-app-field` | the page's radial paper wash |

### Semantic states

| Name | Value | Token | Role |
|---|---|---|---|
| Approve | `#16A34A` | `--rw-green-600` | approve action |
| Approve hover | `#15803D` | `--rw-green-700` | approve hover |
| Posted badge bg | `#DCFCE7` | `--rw-green-100` | badge: posted |
| Posted badge text | `#166534` | `--rw-green-800` | badge: posted |
| Success surface | `#F0FDF4` | `--rw-success-bg` | success panel |
| Pending badge bg | `#FEF9C3` | `--rw-yellow-100` | badge: pending_approval |
| Pending badge text | `#854D0E` | `--rw-yellow-800` | badge: pending_approval |
| Warning surface | `#FFFBEB` | `--rw-warning-bg` | warning panel |
| Warning text | `#92400E` | `--rw-warning-fg` | warning copy |
| Info surface | `#EFF6FF` | `--rw-info-bg` | info panel |
| Info text | `#1E40AF` | `--rw-info-fg-soft` | info copy |
| Attention surface | `#FBEDEA` | `--rw-attn-bg` | blush wash — reconnect banner + awaiting_manual_post badge |
| Attention border | `#F2C3B9` | `--rw-attn-border` | brand blush |
| Auto badge bg | `#EDE9FE` | `--rw-auto-bg` | auto-approved provenance badge |
| Auto badge text | `#5B21B6` | `--rw-auto-fg` | auto-approved provenance badge |

Ranking-chart series rotation is `--rw-chart-1` … `--rw-chart-6` (data-viz colors,
deliberately outside the warm palette and exempt from the amber/orange ban by
`console-admin-palette.test.ts`).

### Named rules

**The Two Registers Rule.** Island owns public surfaces; Warm Editorial owns
authenticated surfaces. Never mix them within one screen.

**The Actionable Color Rule.** Decorative pale teal never carries text, links, or button
labels. Interactive color must meet contrast in its actual state.

**The Evidence Color Rule.** Color never carries reputation status alone; pair it with
copy, shape, iconography, or position.

## Tokens — Typography

### Families

| Role | Stack | Token | Declared by |
|---|---|---|---|
| Display | Young Serif, single weight 400 (Georgia / `ui-serif` fallback) | `--rw-font-display` | `(authenticated)/layout.tsx` — a `localFont` variable on the `.rw-console` element |
| Body / UI | DM Sans (system sans fallback) | `--rw-font-body` | `(authenticated)/layout.tsx` (same mechanism); brand default in `globals.css` |
| Mono | `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace` | `--rw-font-mono` | `globals.css` (brand-wide) |

The font families are the one token group the Console does **not** own — they are
brand-wide (see root [`DESIGN.md`](../../../DESIGN.md)). `tokens.css` currently carries a
duplicate `:root` declaration of the Island values for `--rw-font-display` /
`--rw-font-body` / `--rw-font-mono`; that duplicate is deleted in PR 2 and is not the
source of the Console's Young Serif.

**Character:** Young Serif makes the owner console feel cared for without turning
operational UI into marketing. DM Sans keeps dense review, settings, and billing work
direct and readable.

**How the display swap happens.** `globals.css` sets `--rw-font-display` to Plus Jakarta
Sans on every route. The authenticated layout mounts a self-hosted `localFont` whose
`variable` is `--rw-font-display` on the **same element** that carries `.rw-console`
(`src/app/(authenticated)/layout.tsx`), so the token resolves to Young Serif inside the
Console and to Plus Jakarta everywhere else. Young Serif is self-hosted for the same
reason as the root-layout faces — any `next/font/google` import re-introduces a
compile-time fetch.

### Role tokens

Composite `font:` shorthands declared in `tokens.css` and consumed via `.rw-app`:

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

- **Display** (400, 24px, 1.2): page titles and the largest reputation values.
- **Headline** (400, 18px, 1.3): card and section headings.
- **Title** (600, 16px, 1.3): functional subheads in DM Sans when emphasis must remain operational.
- **Body** (400, 14px, 1.5): standard owner-console copy; explanatory text should stay within roughly 70 characters per line.
- **Label** (600, 12px, 0.04em): compact status and field context. Uppercase is reserved for short factual labels.

Because the display face is single-weight, **all weight/hierarchy below H-level headings
comes from DM Sans** (500/600/700).

### Named rules

**The Honest Weight Rule.** Young Serif ships at one weight. Never synthesize bold;
hierarchy comes from size, placement, and the DM Sans functional scale. (`.rw-console`
sets `font-synthesis-weight: none` so the browser cannot fake it either.)

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

Spacing follows a 4px base rhythm, with 16–24px inside components and about 30px between
major dashboard zones.

### Border radius

| Element | Value | Token |
|---|---|---|
| Chart bar corner | `0.25rem` (4px) | `--rw-radius-xs` |
| App button / input | `0.375rem` (6px) | `--rw-radius-sm` |
| App card | `0.5rem` (8px) | `--rw-radius-md` |
| App stat tile | `0.75rem` (12px) | `--rw-radius-lg` |
| Card core (inner) | `0.875rem` (14px) | `--rw-radius-core` |
| Card (outer tray) | `1.25rem` (20px) | `--rw-radius-card` |
| Pill | `9999px` | `--rw-radius-pill` |

Operational controls use gently curved 6–8px corners. Cards use 12–20px concentric radii
according to their tray depth. Pills are reserved for compact actions, filters, tabs,
statuses, and small numeric badges. The 48px Island corner belongs to public island
containers and **never** appears in the dense Console shell.

### Shadows / elevation

| Name | Value | Token |
|---|---|---|
| Quiet Surface | `0 1px 2px rgba(80, 60, 40, 0.05), 0 8px 20px -16px rgba(80, 60, 40, 0.18)` | `--rw-shadow-sm` |
| Card at rest | `0 1px 2px rgba(80, 60, 40, 0.05), 0 14px 30px -22px rgba(80, 60, 40, 0.22)` | `--rw-shadow` |
| Raised Surface | `0 1px 2px rgba(80, 60, 40, 0.05), 0 24px 46px -30px rgba(80, 60, 40, 0.30)` | `--rw-shadow-lg` |
| Floating Surface | `0 18px 40px -18px rgba(80, 60, 40, 0.34)` | `--rw-shadow-pop` |
| Inset Highlight | `inset 0 1px 0 rgba(255, 255, 255, 0.7)` | `--rw-inset-hi` |

Shadows are warm and diffused — **never harsh black**.

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

The authenticated shell uses a fixed 240px desktop sidebar and a fluid main canvas capped
by content-specific maximum widths. The dashboard content container reaches 1140px;
settings stop at 880px; focused wizards stop at 640px. The sticky save bar's `left`
offset derives from `--rw-sidebar-width` so the two can never drift.

Below the shell breakpoint (< 960px) the sidebar becomes a fixed bottom navigation,
content collapses to one or two columns according to information density, the bento grid
becomes a single column, settings tabs scroll horizontally, and safe-area insets protect
bottom actions. The save bar offsets above the mobile tab bar so the two coexist. Tables
may scroll horizontally when preserving column relationships is more useful than
converting them to cards. All touch-capable devices, including hybrids, receive at least
44px interactive targets.

**The Two-Second Glance Rule.** The dashboard overview contains only the reputation
state, the intelligence brief, and clear doorways to pending work and analytics.

## Components

Component primitives live in the app's existing CSS files (`_styles/console.css`,
`_styles/settings.css`) — **not** a new Tailwind utility sprawl. Keep the existing
class-based architecture.

### Double-bezel card

Role: every major dashboard card. Outer tray + inner core + inset highlight
(`.bezel` > `.core`).

- Spec: `--rw-tray` outer at `--rw-radius-card`, `--rw-card` core at `--rw-radius-core`,
  `--rw-hair` border, `--rw-inset-hi` highlight, `--rw-shadow` at rest.
- Concentric by construction: core radius = card radius − padding.
- States: `--rw-shadow-lg` only when interaction or layering requires it.
- **Never** stack an unrelated border, shadow, and glow to manufacture depth.

### Buttons

- **Shape:** compact pills for dashboard actions and 8px corners inside settings workflows.
- **Primary** (`.btn-primary`): espresso fill (`--rw-app-text`) for the strongest owner
  action; **`.btn-sage`** where selection or connection is the meaning.
- **Secondary / ghost / tertiary** (`.btn-ghost`, `.btn-quiet` — e.g. Regenerate):
  porcelain or transparent surfaces with espresso or muted text.
- **Destructive** (`.btn-danger`): terracotta only.
- **Button-in-button:** trailing arrow/check in its own nested circle (`.btn-icon`) that
  translates diagonally + scales on hover; the whole button goes `active:scale(.975)`.
- **Hover / focus:** short explicit color, border, shadow, or transform transitions; a
  visible sage focus ring. **Never** a broad transition of every property.

### Chips / badges

- **Style:** small pills with a semantic wash and an accessible foreground.
- **Variants:** `pending` (blush), `posted` (sage), `auto` (violet).
- **State:** selection changes fill, foreground, weight, and where useful a check or
  position — **not color alone**.

### Stars

Warm gold (`--rw-star`) is the filled glyph; `.stars` sets it once and the unfilled
glyphs are the same run in the muted register. Rating stars carry an accessible label.
Gold belongs only to review ratings — it must not become a warning or CTA color.

### Deltas

`.delta` up/down/flat: a pill with an arrow; sage = good, blush = bad. Honest and
unit-carrying (rating points / points / hrs). Hidden while ramping.

### Form controls

- **Style:** recessed warm field (`--rw-recess`), 8px radius, readable 14px text, and
  sufficient mobile focus sizing.
- **Focus:** dark sage border (`--rw-focus`) with a three-pixel translucent halo
  (`--rw-focus-ring`).
- **Error / disabled:** terracotta copy on an accessible wash for errors; muted ink and a
  recessed surface for disabled controls.
- **Members:** `.textarea` / `.input`, `.tone-chips` / `.chip` (sage selected),
  `.list-editor` (rows + delete + "Add another").

### Save bar

Sticky pill, blurred, "N unsaved changes · Discard / Save". Its `left` offset derives
from `--rw-sidebar-width`; on mobile it offsets above the tab bar.

### Navigation

Desktop navigation is a quiet left rail with icon, label, and a slim active marker.
Mobile navigation is a fixed bottom bar with safe-area padding. Both use `aria-current`,
persistent text labels, and the same information architecture. Icons are ultra-light
line inline SVGs (`src/components/dashboard/shell/Icon.tsx`).

### Reputation evidence (charts)

Charts provide a textual summary or data table, not just graphical marks, and carry
`role="img"` plus a label. **Synthetic trends are forbidden:** when historical data does
not exist, show the value without a fabricated sparkline. Keep charts hand-rolled SVG —
no charting library.

### Dialogs

Use native modal dialogs for consequential settings actions. The dialog owns its
full-viewport dismissal surface, Escape behavior, focus containment, and accessible
name. Every destructive modal states the consequence and presents explicit cancel and
confirm actions.

### States

| State | Owner | Notes |
|---|---|---|
| Connect-Google banner | `ConnectGoogleBanner.tsx` | blush, above hero |
| Past-due banner | `SubscriptionStatusBanner.tsx` / `PastDueBanner` | terracotta, 7-day grace (invariant #11) |
| All caught up | `PendingApprovalsStrip` (calm) | sage, no CTA, pending = 0 |
| Ramping hero | `ReputationHeroBand` (compact) | current values, **no delta arrows**, baseline copy |
| Regenerate limit reached | `ReviewActions.tsx` (`kind:'limit'`) | gold "heads up" + Back link, replaces the action row — **not** a red error |
| Loading / error | skeleton + error card in `DashboardContent.tsx` | warm tokens |

## Do's and Don'ts

### Do:

- **Do** make the owner's current reputation state and next action obvious within seconds.
- **Do** use named RepWorth roles—Reply, Guardian, Insights, Judge, Governor—and preserve their actual capabilities.
- **Do** resolve reduced-motion experiences directly to the final visual state while preserving immediate feedback.
- **Do** use `any-pointer: coarse` when adapting targets for devices that can accept touch.
- **Do** keep public Island and authenticated Console tokens single-sourced in their owning stylesheets.
- **Do** put a visible sage focus ring on every interactive element; settings tabs keep roving-tabindex + arrow-key nav.
- **Do** preserve the existing `LiveRegion` announcements (dashboard load, settings saved / save-error).
- **Do** keep touch targets ≥44px on mobile.

### Don't:

- **Don't** fabricate trends, metrics, testimonials, customers, or agent activity.
- **Don't** use pale decorative teal for text or controls.
- **Don't** introduce purple-blue AI gradients, black glass, orbital decoration, or generic chatbot imagery.
- **Don't** use a colored side border as generic card decoration; borders may distinguish a real comparison or system state only when the structure requires it.
- **Don't** animate layout-driving properties or leave broad `transition: all` declarations in production UI.
- **Don't** use emoji or Unicode symbols as substitutes for the established inline SVG icon system.
- **Don't** use amber, orange, or stone — locked by [`console-admin-palette.test.ts`](../../../src/__tests__/console-admin-palette.test.ts). The only exemption is the chart **series** rotation.
- **Don't** write a literal hex in a component; use `var(--rw-*)` or the `rw-*` Tailwind utilities.
- **Don't** re-declare an Island color or font token in the Console token file — that reintroduces the `--rw-sage` collision.

### Anti-slop hygiene

- No over-used faces (Inter / Roboto / Fraunces / Geist / Plus Jakarta / Space Grotesk / Instrument Serif) as the Console display face.
- No numbered section markers (`01/02/03`); no eyebrow-chip on every card.
- Em-dash discipline in body copy (≤2; prefer periods/commas).
- Motion only via `transform` / `opacity` / `filter` (GPU-safe); `backdrop-blur` only on fixed/sticky elements.

### Contrast

Espresso ink `#2A2118` on cream is ~13:1 (AAA). Target ≥4.5:1 for text and ≥3:1 for
large/UI on every semantic pair. The floors that matter are asserted, not assumed —
`design-token-single-source.test.ts` computes the ratio for soft ink, sage-deep, blush,
danger, violet, star, on-accent, info, warning, success, and the focus indicator, and
fails the build if a value drifts under.

## Surfaces & Elevation

Depth is primarily **structural**: a warm tray surrounds an inner card core, with
hairline borders and a subtle inset highlight. Shadows are warm, diffuse, and
progressively stronger only for floating controls, dialogs, or an intentional hover
response. Fixed top bars and save bars may use bounded backdrop blur because they reveal
content passing beneath them.

### Shadow vocabulary

- **Quiet Surface** (`--rw-shadow-sm` / `--rw-shadow`): a small warm ambient shadow for cards at rest.
- **Raised Surface** (`--rw-shadow-lg`): a longer diffuse shadow for hovered or layered cards.
- **Floating Surface** (`--rw-shadow-pop`): the strongest warm shadow for dialogs and detached controls.
- **Inset Highlight** (`--rw-inset-hi`): a one-pixel inner light that completes the double-bezel material.

### The field

The page canvas is `--rw-app-bg` (warm off-white `#FDFBF7`) carrying the `--rw-app-field`
radial wash and a fixed whisper grain overlay (opacity ~0.045).

### Named rules

**The Concentric Depth Rule.** Major cards use the tray-and-core relationship; do not
stack an unrelated border, shadow, and glow to manufacture depth.

## Imagery & Motion

- **Entry:** `reveal` → fade-up + de-blur (`translateY(18px)`, `blur(6px)` → 0) over
  ~800ms with confident deceleration (`--rw-ease-decelerate`), staggered ~80ms within a
  group. Maps to the `.section-enter` convention in `DashboardContent.tsx`.
- **Velocity bars** grow via `transform: scaleY()` (bottom origin) — **not** height.
- **Trend line** draws via `stroke-dashoffset`.
- **Button-in-button** hover physics; `active:scale(.975)`.
- **Live pill** pulse (sage ring) — a distinct opacity-only keyframe
  (`rw-live-pulse`) from the loading skeleton's (`rw-skeleton-pulse`).
- **`prefers-reduced-motion`:** all of the above resolve to the final state, no
  transition.
- **Imagery:** inline SVG only, ultra-light line icons. No emoji or Unicode symbols as
  substitutes. Charts carry text equivalents.

## Agent prompt guide

- **"Build a primary button on this surface"** → `.btn-primary`: espresso fill
  (`--rw-app-text`) on porcelain text (`--rw-on-accent`), `--rw-radius-pill`, ~36px tall,
  9px/17px padding, sage focus ring. Use `.btn-sage` instead when the meaning is
  selection or connection.
- **"Build a card"** → the double-bezel: `--rw-tray` outer at `--rw-radius-card`,
  `--rw-card` core at `--rw-radius-core`, `--rw-hair` border, `--rw-inset-hi`,
  `--rw-shadow` at rest. Never a fourth decorative layer.
- **"Show a status"** → a semantic chip: wash + accessible foreground + a word.
  `pending` = blush, `posted` = sage, `auto` = violet. Never color alone.
- **"Show a trend"** → only if the history exists. `--rw-star` is for rating stars only;
  a missing series means show the value with no sparkline.
- **"Add a settings field"** → `.input` / `.textarea` on `--rw-recess`,
  `--rw-radius-md`, 14px DM Sans, `--rw-focus` border + `--rw-focus-ring` halo, and the
  sticky save bar for the commit.

## Exports

- **CSS variables:** [`src/app/(authenticated)/_styles/tokens.css`](../../../src/app/(authenticated)/_styles/tokens.css)
  — the `:root` block IS the export; do not copy it here.
- **Tailwind v4:** `src/app/(authenticated)/_styles/theme.css` — created in PR 2 of the
  three-tier design-system change. Until then the Console `@theme inline` entries live in
  [`src/app/globals.css`](../../../src/app/globals.css).
- **Scope:** `.rw-console` is applied in `src/app/(authenticated)/layout.tsx`;
  `_styles/console.css` owns the scoped element styles.
