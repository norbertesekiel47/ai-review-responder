# component-placement (dev tools)

One-off, **dev-only** utilities for the `src/` component LCA-placement convention
(see [`docs/src-structure-preferences.md`](../../docs/src-structure-preferences.md)).
Not part of the build or CI. Run with `node` directly.

## Status: parked at enforcement (2026-06-08)

The **enforcement** half of the convention shipped in PR #247 (the three
`no-restricted-imports` boundary zones in `eslint.config.mjs`). The **bulk
component-move** half was deliberately **not** run — see "Known limitation"
below. These scripts are kept for *opportunistic, per-feature* co-location when
someone is already working in an area, not a big-bang migration.

## The rule

A component lives at the **lowest route folder that contains all its consumers**
(their LCA in the route tree), resolved transitively through component→component
imports. `lib/<domain>` never moves (worker-owned).

## Scripts

| file | what it does |
|---|---|
| `lca.mjs` | pure placement logic (`aliasFromPath`, `routeLeafOf`, `computeDestination`, `transitiveDestination`). Unit-tested. |
| `lca.test.mjs` | `node --test scripts/component-placement/lca.test.mjs` (15 cases) |
| `propose.mjs` | `node propose.mjs <domain>` → read-only move-map JSON (importer graph via `git grep`) |
| `apply.mjs` | `node apply.mjs <map.json>` → executes a reviewed map (`git mv` + alias rewrite) |
| `normalize.mjs` | `node normalize.mjs [--write]` → convert src-internal relative imports to `@/` aliases (cross-tree `worker/`,`scripts/` skipped) |

Always **human-review** a `propose` map before `apply`; the tool proposes, it
does not decide.

## Known limitation (why the big migration was parked)

`propose`/`apply` understand **`@/` alias imports only**. The codebase also uses
**relative** sibling imports (`./Foo`, `../bar/Baz`) — a dry-run found **~990**
across **~498 files**. The alias-only mover therefore (a) mis-graphs components
imported relatively, and (b) doesn't rewrite relative imports when a file moves —
a real pilot on `dashboard` failed `tsc` for exactly this reason.

To run the full migration you must first either:
1. `node normalize.mjs --write` (rewrites all ~990 relative imports to aliases —
   a large, opinionated, whole-codebase diff), **or**
2. rebuild `apply` on a TS-aware codemod (e.g. `ts-morph`, runnable ephemerally
   via `npx -p ts-morph`) that recomputes relative + alias imports natively.

The cost/benefit of either, against an already-sub-foldered `components/` tree
with now-enforced boundaries, is why this was parked.
