# RepWorth design systems — router

RepWorth ships **three visual systems under one brand**, one per surface family. Pick one
per surface; never mix them on the same screen. This file routes; it holds no hex values
and no component recipes so it can never drift from them.

| System | Scope | Style Reference | Token file (the "CSS variables" export) | `@theme` block (the "Tailwind v4" export) | Guard |
|---|---|---|---|---|---|
| **Landing** | `.rw-lp` | [`landing/DESIGN.md`](./landing/DESIGN.md) + [`landing/measurements.md`](./landing/measurements.md) | `src/components/sections/landing/landing-experience.css` (+ `hero/hero.css`) | none — Landing is plain CSS | Landing scope guard (PR 2) |
| **Island** | `:root` | [`island/DESIGN.md`](./island/DESIGN.md) | `src/app/globals.css` `:root` | `globals.css` `@theme inline` — Island entries | [`design-token-single-source.test.ts`](../../src/__tests__/design-token-single-source.test.ts) |
| **Console** ("Warm Editorial") | `.rw-console` | [`console/DESIGN.md`](./console/DESIGN.md) | `src/app/(authenticated)/_styles/tokens.css` | `_styles/theme.css` (PR 2; today in `globals.css`) | the same test + `console-admin-palette` / `no-yellow-star-colors` / `save-bar-sidebar-width` |
| _Brand (shared)_ | — | this file + root [`DESIGN.md`](../../DESIGN.md) + [`brand-story.md`](./brand-story.md) | `--rw-font-*` families in `globals.css` | — | — |

## Which system am I in?

| The file I am editing | System |
|---|---|
| `src/components/sections/landing/**` | **Landing** |
| `src/app/(authenticated)/**`, `src/components/dashboard/**` | **Console** |
| everything else public / marketing / auth / approval / legal / **admin** | **Island** |

`/` is **deliberately unlocked** from the Island system (agreed 2026-08-03, recorded in
[`PRODUCT.md`](../../PRODUCT.md)). It establishes its own world; the rest of the site does
**not** follow it. Do not "restore" sage/teal/peach there.

Admin (`src/app/admin/**`) renders **outside** `.rw-console` and consumes **no** Console
tokens. It is an Island-palette surface — more utilitarian in layout, same palette — with
the amber/orange/stone ban locked by `console-admin-palette.test.ts`.

## The three cross-system rules

1. **Tokens live in code, not in a doc.** Each system's token file *is* its export. A
   Style Reference's Tokens tables restate the values for readability and are pinned to the
   token file by test; everything else — recipes, prose — points at the file.
2. **One owner per token; no cross-scope declarations.** The Console token file must not
   re-declare an Island color or font token: that reintroduced the `--rw-sage` collision,
   where one name resolved to the Island sage on public pages but the Console sage inside
   the dashboard, decided only by CSS load order. `globals.css` loads on every route, so
   the other two systems inherit it by fall-through — they override, they do not restate.
3. **The two teals.** The decorative Island teal fails WCAG AA for text. For links, button
   fills, and any text use the actionable teal token, which passes AA on white and cream
   (and neither on sage or teal — use ink there). Rationale:
   [`docs/adr/0004-accessible-teal-token-split.md`](../adr/0004-accessible-teal-token-split.md).

## How to overhaul one system

A redesign touches exactly one doc + one token file + one `@theme` block + the components
under one selector; CI proves the other two were not touched.

1. Rewrite that system's `DESIGN.md` — new thesis, new token tables, new component specs.
   (Running `/impeccable`? Point it at the system's paths and write its output **here**.)
2. Rewrite that system's token file (the values) and its `@theme` block (which tokens
   become utilities). Rename tokens freely — the doc↔code pin tells you which table rows
   are now stale.
3. Change the components under that system's selector.
4. `pnpm test` — the purity guards prove the other two systems' declarations are
   byte-identical to before, and their docs were never opened.

## The impeccable skill

Root [`DESIGN.md`](../../DESIGN.md) is a **thin brand-level index** — the one file
`impeccable`'s context loader resolves at the project root. It carries only brand-wide
facts and routes to these three. It is hand-curated: `/impeccable document` output goes
into the matching `docs/design/<system>/DESIGN.md`, never into the root file.

`brand-story.md` is the **narrative** layer (positioning, story arc, messaging
guardrails) — not a visual system. The `repworth-brand-design` skill is the agent-facing
router to all three Style References.

## Known follow-ups (not in this pass)

- **Tailwind v4 `@theme` migration is effectively complete.** Verified 2026-08-16:
  `rg -l '\[#[0-9a-fA-F]{3,8}\]' src/components src/app --glob '*.tsx'` returns **0 files**
  — no component hardcodes an arbitrary-value hex. What remains is PR 2's split of the
  Console `@theme` entries out of the Island file.
