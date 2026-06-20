# ADR 0004: Accessible teal token split for public UI contrast

## Status

Proposed — 2026-06-18 (draft; pending sign-off, not yet committed)

## Context

The RepWorth brand system (`repworth-brand-design` skill) defines a single
primary/CTA color, `--rw-teal: #97B3AE`, and uses it for buttons, links,
eyebrows, the wordmark, stars, and assorted labels across every public page.

Measured against WCAG 2.1 AA, `#97B3AE` fails as a **text/affordance** color
everywhere it is used:

| Pairing | Ratio | AA needs | Verdict |
|---|---|---|---|
| `#97B3AE` text on white | 2.24:1 | 4.5:1 | fail |
| white text on `#97B3AE` (every primary button, incl. "Approve & post to Google") | 2.24:1 | 4.5:1 | fail |
| `#97B3AE` on off-white `#F0EEEA` | 1.93:1 | 4.5:1 | fail |

This is the single most pervasive accessibility defect in the public surface.
The root cause is a category error in the brand system: `#97B3AE` is a *surface /
decoration* tone being used as a *foreground text* tone. Simply darkening the one
token would change the page-background accent and the CTA *band* color too, which
are fine as-is.

## Decision

Split teal into two roles instead of one.

1. **`--rw-teal: #97B3AE` stays the decorative teal.** Page-background accent,
   large fills, dots, dividers, and any **genuinely text-free** decoration. It is
   never again used as a text color or to carry white text. (A teal *band that
   carries copy* is explicitly NOT in this list — see the CTA-band rule below.)

   For bands that contain headings/body copy, see the canonical CTA band rule
   below.

2. **New `--rw-teal-strong: #557069` is the actionable teal**, used for:
   - **text/links/eyebrows/labels** (replaces every `#97B3AE`-as-text) — but
     only on white/cream backgrounds (see context rules below);
   - **primary buttons on white islands** — solid `#557069` pill with a white
     label (the visual choice locked during the grill: "Row 1 → Option B");
   - **secondary/outline buttons** — `#557069` text + border.

3. **On the teal CTA band**, the primary action is a **white pill with
   `#557069` text** (grill choice "Row 2 → Option A"), not white-on-teal.

### Context rules — `#557069` is NOT background-agnostic

Measured ratios force a per-background rule:

| `#557069` on… | ratio | use as text? |
|---|---|---|
| white | 5.37:1 | yes |
| cream `#F0EEEA` | 4.64:1 | yes |
| sage `#D2E0D3` | 3.93:1 | **no** (body) — use ink `#2a2a2a` |
| `#97B3AE` | 2.40:1 | **no** — use ink/white-pill |

So: strong-teal text only on white/cream; on sage or teal, text is ink `#2a2a2a`
(or a white pill).

### CTA band rule (canonical — exactly three cases)

1. A `#97B3AE` band **may** carry **dark ink `#2a2a2a`** copy plus **white-pill**
   actions (dark ink on `#97B3AE` is 6.41:1).
2. A band that must carry **white** copy **darkens to `#557069` or darker** (white
   on `#97B3AE` is only 2.24:1).
3. **Text-free** teal decoration may stay `#97B3AE`.

### Stars stay decorative

Star glyphs remain `#97B3AE` **with an `aria-label` rating** rather than being
recolored — recoloring would conflict with `no-yellow-star-colors.test.ts`
(which requires `#97B3AE` stars across public + authenticated + admin) and would
reach out-of-scope authenticated/admin surfaces.

Net rule: **white text only ever sits on `#557069` or darker; never on
`#97B3AE`.** The enforceable regression guard is an **in-repo computed-contrast
test**, not the personal `repworth-brand-design` skill (which is not
source-controlled / CI-visible).

This makes the change additive (a new token) rather than a redefinition, so the
brand's signature sage page background is untouched. (CTA *bands* are governed by
the canonical three-case rule above — not "untouched".)

## Consequences

- The global `repworth-brand-design` skill must be amended so future UI work does
  not reintroduce `#97B3AE`-as-text. Without this, the bug class returns.
- Surface-scoped palette tests that assert the approved set
  (`src/__tests__/how-it-works-palette.test.ts`,
  `src/__tests__/console-admin-palette.test.ts`) must be updated to allow
  `--rw-teal-strong`.
- A small set of non-token colors used as error/success states
  (`#dc2626`/`#b91c1c` reds, `#16a34a` green, `#EAB308` amber confetti,
  `#e0a089`/`#D97757`/`#E8A394` terracotta) are out of the approved palette and
  have no token home. This ADR adds approved **error** and **success** tokens so
  those can be purged in the same sweep.
- Reversible in principle (delete the token, revert call sites), but it touches
  `globals.css`, `auth-island.css`, many components, the brand skill, and the
  palette tests — so it is recorded here.

## Alternatives considered

- **Dark ink on the existing `#97B3AE` fill** (6.41:1) for buttons — rejected for
  primary buttons on white islands per the grill visual call, but remains the
  pattern wherever a teal *fill* must keep its exact hue.
- **Redefine `--rw-teal` darker** — rejected: it would shift the page background
  accent, which is accessible and intentional as decoration. (CTA bands are
  handled by the canonical three-case rule, not by redefining the token.)
- **Leave it / accept the AA miss** — rejected: it fails the brand skill's own
  accessibility guardrail and affects the highest-stakes control in the product.
