# RepWorth design systems — router

RepWorth ships **three visual systems under one brand**, one per surface family. Pick one
per surface; never mix them on the same screen. This file routes; it holds no hex values
and no component recipes so it can never drift from them.

| System | Scope | Style Reference | Token file (the "CSS variables" export) | `@theme` block (the "Tailwind v4" export) | Guard |
|---|---|---|---|---|---|
| **Landing** | `.rw-lp` | [`landing/DESIGN.md`](./landing/DESIGN.md) + [`landing/measurements.md`](./landing/measurements.md) | `src/components/sections/landing/landing-experience.css` (+ `hero/hero.css`) | none — Landing is plain CSS | [`design-scope-purity.test.ts`](../../src/__tests__/design-scope-purity.test.ts) — only `--rw-lp-*` may be declared |
| **Island** | `:root` | [`island/DESIGN.md`](./island/DESIGN.md) | `src/app/globals.css` `:root`; page CSS: [`src/app/(public)/_styles/*.css`](../../src/app/(public)/_styles), `@import`ed from `globals.css` in a fixed order | `globals.css` `@theme inline` — Island entries | [`design-token-single-source.test.ts`](../../src/__tests__/design-token-single-source.test.ts) + [`design-scope-purity.test.ts`](../../src/__tests__/design-scope-purity.test.ts) — the `@theme` block may name no Console token |
| **Console** ("Warm Editorial") | `.rw-console` | [`console/DESIGN.md`](./console/DESIGN.md) | `src/app/(authenticated)/_styles/tokens.css` (the `.rw-console` block) | [`_styles/theme.css`](../../src/app/(authenticated)/_styles/theme.css), `@import`ed from `globals.css` | the same single-source test (colors **and** font families) + `console-admin-palette` / `no-yellow-star-colors` / `save-bar-sidebar-width` |
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
   token file by [`design-doc-token-pin.test.ts`](../../src/__tests__/design-doc-token-pin.test.ts)
   — every `` `--rw-*` `` a table names must exist in that system's token file, and where the
   table has both a **Value** and a **Token** column the value must match the declaration.
   Everything else — recipes, prose — points at the file.
2. **One owner per token; no cross-scope declarations.** The Console token file must not
   re-declare an Island color or font token: that reintroduced the `--rw-sage` collision,
   where one name resolved to the Island sage on public pages but the Console sage inside
   the dashboard, decided only by CSS load order. `globals.css` loads on every route, so
   the other two systems inherit it by fall-through — they override, they do not restate.
   **An override belongs inside the scope** (`.rw-console` / `.rw-lp`), or on the scoped
   element itself: the Console's Young Serif and DM Sans are `localFont` variables bound
   on the `.rw-console` div, and its system-mono stack is a `.rw-console` rule in
   `console.css`. A second `:root` declaration is never the mechanism.
   `:root` belongs to the Island alone — the Console declares its whole palette on
   `.rw-console` (its token file opens no `:root` block, and the guard says so), so a
   stale chunk surviving a client navigation cannot leak Console values onto a public
   page. That scoping has a typographic consequence worth knowing: a `var()` inside a
   custom property is substituted where the property is **declared**, so the Console's
   composite `font:` roles pick up the `localFont` display family from the element they
   are declared on — `font: var(--rw-app-h1)` alone renders Young Serif inside the scope.
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

- **Tailwind v4 `@theme` migration is complete.** Verified 2026-08-16:
  `rg -l '\[#[0-9a-fA-F]{3,8}\]' src/components src/app --glob '*.tsx'` returns **0 files**
  — no component hardcodes an arbitrary-value hex. The Console `@theme` entries now live in
  their own file, and the v3-era `tailwind.config.mjs` + its `@config` line are gone (v4
  auto-detects content; the file's `theme`/`plugins` were empty and the built utility set
  is identical without it).
- **Both deferred items are now done**, each as its own PR and its own decision in the
  spec: the `globals.css` page-CSS extraction (PR 3b, #846) and the Console `:root` →
  `.rw-console` scoping after the portal audit (PR 3a, #845). Nothing from the original
  pass is still outstanding.
