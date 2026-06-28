# Plan — Issue #373: tokenize the ~13 rogue non-token colors (zero pixel change)

Date: 2026-06-28
Branch: `feat/373-tokenize-rogue-colors`

## Problem

The #371 literal→token migration left ~13 non-token hex colors as Tailwind
arbitrary-value literals (`bg-[#hex]`) because the tokens that existed would have
**changed** the rendered palette. They cluster in the onboarding funnel, the
approval page, the auth error/shell, and admin costs.

Issue grep (the authoritative scope):

```
grep -rnE '\[#(9a948a|7e9b96|3f544f|cdd9ce|6a4a44|dc2626|b91c1c|46645d|46594f|2a6a64|e3ddd3|e7e3dc|5e7d77)\]' src
```

## Locked decision policy (orchestrator)

ZERO pixel change. **Do NOT snap** any color to a near token (snapping changes
pixels). **Tokenize at the EXACT current hex** so the rendered output is
byte-identical. Same hex in = same pixels out.

## Mechanism (use the existing one — no parallel mechanism)

- `--rw-*` source tokens are declared in **`src/app/globals.css` `:root`** (loads
  on every route via the root layout).
- They become `rw-*` Tailwind utilities through the **`@theme inline`** block in
  the same file: `--color-rw-x: var(--rw-x)` → generates `bg-rw-x` / `text-rw-x` /
  `border-rw-x` / `ring-rw-x` etc. `@theme inline` emits the `var()` *reference*,
  so `:root` stays the single source.
- Opacity modifiers (`bg-rw-x/10`) compile to `color-mix(in oklab, var(--rw-x)
  10%, transparent)` — identical to `bg-[#hex]/10`'s `color-mix(in oklab, #hex
  10%, transparent)` when `var(--rw-x)` resolves to `#hex`. Proven already in
  use across the repo (`bg-rw-teal/15`, `border-rw-teal/40`, …).

### Surface analysis (which CSS file loads where)

- `globals.css` → root layout → **every route** (public, onboarding, auth,
  approval, admin).
- `tokens.css` / `console.css` / `wizard.css` → `src/app/(authenticated)/layout.tsx`
  → **authenticated routes only**.
- The admin layout (`src/app/admin/layout.tsx`) does **not** load `tokens.css` or
  apply `.rw-console`; `src/app/(public)/approve/` is public. So every one of the
  13 rogue colors lives on a globals-only surface → **all new tokens go in
  `globals.css`** (`:root` + `@theme inline`).

### Approval reds — reuse the canonical token, made global (DRY)

`--rw-red-600 (#DC2626)` / `--rw-red-700 (#B91C1C)` already exist, but only in the
Console `tokens.css`, even though `globals.css` already advertises the
`rw-red-600`/`rw-red-700` utilities in `@theme inline` (a latent gap: those
utilities resolve to an undefined var on public pages). The approval page is
public and needs exactly these two. DRY (one owner per color-fact) →
**move `--rw-red-600`/`--rw-red-700` from `tokens.css` to `globals.css` `:root`**
(identical values), leaving a pointer comment in `tokens.css`. Console keeps
resolving them via globals fall-through (globals loads everywhere) → zero pixel
change in the Console. `red-50/100/300/500` stay Console-only in `tokens.css`.

## Per-color decision table (token name + EXACT hex preserved)

All values written byte-for-byte equal to the original literal (CSS hex is
case-insensitive; reds keep the existing token's uppercase form). No snapping.

| # | Literal | Occ | Decision → token | Exact hex | Role |
|---|---------|-----|------------------|-----------|------|
| 1 | `#9a948a` | 8 | tokenize `--rw-warm-gray` | `#9a948a` | muted warm-gray text (onboarding placeholders/captions) |
| 2 | `#7e9b96` | 7 | tokenize `--rw-teal-hover` | `#7e9b96` | hover shade for teal links/buttons |
| 3 | `#3f544f` | 4 | tokenize `--rw-teal-darkest` | `#3f544f` | darkest sage — approval confirm action |
| 4 | `#cdd9ce` | 3 | tokenize `--rw-sage-muted` | `#cdd9ce` | muted sage — inactive/empty (dots, empty stars) |
| 5 | `#6a4a44` | 3 | tokenize `--rw-brown` | `#6a4a44` | brown badge text on peach (admin costs) |
| 6 | `#dc2626` | 4 | reuse `--rw-red-600` (moved to globals) | `#DC2626` | error glyph/border (approval) |
| 7 | `#e3ddd3` | 2 | tokenize `--rw-warm-gray-soft` | `#e3ddd3` | light warm-gray surface — inactive step dots |
| 8 | `#46645d` | 2 (+CTA grad) | tokenize `--rw-teal-strong-hover` | `#46645d` | darker teal-strong: button hover + CTA gradient end |
| 9 | `#b91c1c` | 1 | reuse `--rw-red-700` (moved to globals) | `#B91C1C` | error text (approval); pair of #6 |
| 10 | `#46594f` | 1 | tokenize `--rw-teal-strong-hover-deep` | `#46594f` | deeper teal-strong button hover (auth card) |
| 11 | `#2a6a64` | 1 | tokenize `--rw-teal-deep` | `#2a6a64` | deep teal badge text (admin costs); pair of #5 |
| 12 | `#e7e3dc` | 1 | tokenize `--rw-cream-hover` | `#e7e3dc` | cream secondary-button hover (plan picker) |
| 13 | `#5e7d77` | 1 | tokenize `--rw-sage-text` | `#5e7d77` | muted-sage badge text (approval location chip) |

Notes on the four single-use members (#10/#11/#12/#13): the orchestrator's locked
policy classified `#46594f`/`#5e7d77`/`#e7e3dc` as sage/warm-gray family siblings
(tokenize, don't leave as one-offs), and `#2a6a64` pairs with the tokenized
`#6a4a44` in the same admin cost-badge component, so it reads as reusable too.
Each is named as a semantic family member (not a bespoke one-off name), so the
result is a deliberate extended palette rather than over-tokenization. **No rogue
literal is left behind** — final grep returns clean.

Name-collision check: none of the new names match the Island tokens guarded by
`design-token-single-source.test.ts` (`--rw-sage`/`--rw-sage-deep`/`--rw-sage-soft`
must NOT appear in globals.css — they don't; `--rw-sage-muted`/`--rw-sage-text`
are distinct strings the `^\s*--rw-sage\s*:` regex does not match) and none are
re-declared in `tokens.css`.

## Proof of zero pixel change

For every swapped occurrence the new utility resolves to `var(--rw-<name>)`, whose
`:root` value is the **same hex string** as the original literal (table above).
Direct fills/text → identical color; opacity variants → identical `color-mix`
inputs → identical computed color. Moving the red tokens preserves their values
(`#DC2626`/`#B91C1C`) and keeps Console `var(--rw-red-600/700)` resolving via
globals fall-through. CTA gradient `#46645d` → `var(--rw-teal-strong-hover)` =
`#46645d`. Therefore rendered output is byte-identical.

## Files

- `src/app/globals.css` — add 11 new `:root` tokens + 2 moved red tokens; add 11
  `@theme inline` utility mappings (red mappings already present); unify the CTA
  gradient literal `#46645d` → `var(--rw-teal-strong-hover)`.
- `src/app/(authenticated)/_styles/tokens.css` — remove `--rw-red-600/700`
  declarations, leave a pointer comment (now owned by globals.css).
- 13 component files — swap the listed `[#hex]` literals for the `rw-*` utilities.

## Verification

- Re-run the issue grep → only intentional/out-of-scope literals remain (none of
  the 13).
- `pnpm lint && pnpm typecheck && pnpm test` (incl. `design-token-single-source`,
  `public-pages-teal-contrast`, `console-admin-palette`).
- `pnpm ci:static-policy` (no new `NEXT_PUBLIC_*`).
