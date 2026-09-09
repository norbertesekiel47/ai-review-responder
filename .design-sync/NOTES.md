# design-sync notes — RepWorth

Repo-specific gotchas for `/design-sync`. Read this before a re-sync.

## Shape: this repo is an app, not a package

RepWorth is a private Next.js application. It has no `dist/`, no `main`/
`module`/`exports`, and no published `.d.ts` tree — so three inputs the
converter normally reads from a package are **generated** by
`node .design-sync/prepare.mjs`, which must run from the repo root before
`package-build.mjs`:

1. `.design-sync/entry.tsx` — a barrel of the brand surface
   (`src/components/ui` + `src/components/sections`), and the matching
   `cfg.componentSrcMap`.
2. `.design-sync/.cache/types/` — a declaration tree from
   `tsconfig.dts.json`, plus a generated `entry.d.ts`. This is the props
   contract the design agent reads.
3. `.design-sync/.cache/compiled.css` — Tailwind v4 is CSS-first, so
   `src/app/globals.css` is a SOURCE file. Nothing outside a Tailwind or Next
   build resolves `@import 'tailwindcss'`.

It also stages the design guidelines and inlines a few `public/` assets.

## `.design-sync/package.json` is load-bearing — do not delete it

Without it the converter anchors `PKG_DIR` at the repo root, `findTypesRoot`
falls through to the root, and `addSourceFilesAtPaths('<repo>/**/*.d.ts')`
walks the whole tree. That OOMs at 8 GB after ~6 minutes with no useful error.
The file makes `.design-sync/` the package dir and points `types` at the
generated tree. `pnpm-workspace.yaml` declares no `packages:` globs, so it is
not a workspace package.

Every `cfg` path is therefore **`.design-sync/`-relative**: `srcDir` and
`componentSrcMap` start `../`, `cssEntry`/`extraFonts`/`tsconfig` do not.

## `next/*` is shimmed, not bundled

`.design-sync/tsconfig.sync.json` maps `next/link`, `next/image` and
`next/navigation` to `.design-sync/shims/*`. `useRouter`/`usePathname` throw
outside an App Router, and `next/image` needs the Next runtime. The shims
render the same DOM the real components produce.

`cfg.provider` is `PreviewProviders` (`.design-sync/shims/preview-providers.tsx`)
— `LazyMotion features={domAnimation} strict` plus `AmbientMotionProvider`,
mirroring `LandingExperience.tsx`. Without it every landing component throws.

## `public/` assets cannot resolve — small ones are inlined

An absolute `/logo.svg` resolves against the SERVING origin, which is never
RepWorth for a preview card or a design the agent builds. `INLINE_ASSETS` in
`prepare.mjs` inlines the logo, the two hero/CTA posters and the six agent
avatar stills (~428 KB) as data URIs; the `next/image` shim reads that map and
falls back to `https://repworth.net` for anything else.

**Not inlined, by decision:** every `.mp4`. They total several MB. The
consequence is visible and accepted — `WatchdogsSection` and the hero/CTA video
beds render their layout and colour with an empty media area. `AgentFlipCard`
and `AmbientVideo` previews pass an inlined poster instead, which is also the
pre-buffer state in production.

## Fonts are restated, not harvested

`next/font/local` emits the `@font-face` rules at Next build time, so nothing
ships them here. `.design-sync/fonts.css` restates all seven faces under the
family names `globals.css` already falls back to (`Inter`, `Plus Jakarta Sans`,
`DM Sans`, `Fraunces`, `JetBrains Mono`, `Young Serif`), and `prepare.mjs`
appends the matching `--font-*` variables to the compiled stylesheet. Do not
move that `:root` block into `fonts.css` — `cfg.extraFonts` harvests
`@font-face` rules only, never declarations, and `[FONT_MISSING]` returns.

## Preview stories must be COMPONENTS

The card harness filters exports on `typeof === 'function'` and mounts with
`createElement(export)`. `export const Story = <JSX/>` silently yields an empty
card. Always `export const Story = () => (<JSX/>)`.

## PageShell capture race

`PageShell`'s island arrives on a 0.8s opacity/scale transition.
`package-capture.mjs` screenshots at `networkidle`, which fires before the
first animation frame — so its review sheet shows the parallax backdrop and
dot nav but no island. The CARD is correct. Reproduce:

    node .ds-sync/storybook/http-serve.mjs ./ds-bundle    # note the port
    # open components/general/PageShell/PageShell.html?story=WithContent
    # at 1100x560 — island is opacity 1, 1020x263 at top 173, with real text

There is no config knob for capture delay (`cfg.overrides` accepts only
`cardMode`, `primaryStory`, `viewport`, `skip`). Grade it from the served
render, not the sheet.

## Two `Reveal` components

`sections/landing/reveal.tsx` and (since 2026-08-22) `ui/Reveal.tsx` both
export `Reveal`. Both are scroll-motion wrappers with no visual identity, and
both are in `EXCLUDE` in `prepare.mjs` — which also still lists the pre-rename
path so the sync is stable against either revision. `prepare.mjs` hard-fails on
any other duplicate export name rather than shipping a silently-shadowed one.

## Guidelines flatten by PKG_DIR-relative path

`emitGuidelines` keeps the path relative to `PKG_DIR` for in-package files and
collapses to basename for anything outside it — so `docs/brand-asset-library/design-systems/island/DESIGN.md`
and `docs/brand-asset-library/design-systems/landing/DESIGN.md` would collide on `guidelines/DESIGN.md`.
`prepare.mjs` stages renamed copies into `.design-sync/design-docs/` and the
glob is `design-docs/*.md` (no `./` prefix — the glob is regex-matched against
a path that carries none, so `./x/*.md` matches nothing).

## Known render warns

- `[TOKENS_MISSING]` naming `--card-delay`, `--card-wash`, `--card-accent`,
  `--bi` — set by JS at runtime, expected absent from a static stylesheet.
- `[TOKENS_MISSING]` naming `--rw-app-bg`, `--rw-recess` — Console-system
  tokens from `src/app/(authenticated)/_styles/tokens.css`, which is outside
  this sync's scope and not imported by `globals.css`.
- `[RENDER_THIN]` on `FeatIntro` — appeared 2026-08-22 from an in-flight edit
  to `FeatIntro.tsx` (see Re-sync risks). Re-check it once that work lands.

## Re-sync risks

- **The 2026-08-22 sync ran against a dirty tree.** A parallel session was
  editing 18 files under `src/`, including 15 of the synced components
  (`Feat*`, `HowItWorksContent`, `JudgeArtifact`) and the `Reveal` rename. The
  cards for those capture a mid-edit state. Re-sync once that work lands on
  `main`; grades carry forward, so only changed components re-verify.
- `INLINE_ASSETS` inlines file CONTENT at prepare time. Replace `public/logo.svg`
  or an agent still and the bundle keeps the old bytes until `prepare.mjs`
  re-runs.
- The `next/*` shims track a Next 16 API surface. A Next major that changes
  `next/image` props needs them revisited.
- `https://repworth.net` is hard-coded as the public-asset fallback origin in
  `.design-sync/shims/next-image.tsx`. A domain change needs an edit there.
- The declaration build pins `rootDir: ../src`. A component moved outside
  `src/` drops out of the props contract without failing the build.
