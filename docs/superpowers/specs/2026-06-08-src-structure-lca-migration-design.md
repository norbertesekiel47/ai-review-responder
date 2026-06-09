# `src/` Structure — LCA Placement + Migration (Design)

- **Date:** 2026-06-08
- **Status:** **Partially shipped, then parked.** The *enforcement* half landed in
  PR #247 (the three `no-restricted-imports` boundary zones + alias cleanup + doc
  reconciliation). The *component-move* half (§2–§3) was **not** run: a `dashboard`
  pilot exposed ~990 relative imports across ~498 files that the alias-only mover
  can't handle, making the moves a whole-codebase restyle for a co-location purity
  gain — not worth it against an already-sub-foldered `components/` tree with
  now-enforced boundaries. Tools kept at `scripts/component-placement/` (see its
  README). This spec is retained as the design + decision record.
- **Supersedes (in part):** the "What we'd actually do (the plan)" and
  "placement by shared-ness (≥2 routes)" wording in
  [`docs/src-structure-preferences.md`](../../src-structure-preferences.md).
  That doc remains the living convention; this spec is the one-time design for
  the change that brings code + doc + enforcement into agreement.

---

## 1. Context & problem

The `src/` reorg the preferences doc prescribed is **already largely done**
(commit `d65c6e71`, PR #219): no loose files at `src/components/` root, the
once-29-file `components/dashboard/` is split into sub-feature folders, and the
`app/<area>/_components` co-location idiom is in use across ~10 areas.

Re-evaluating the convention for **growth** (we keep adding features → more
pages; currently 59 route leaves: 12 under `(authenticated)`, 18 under `admin`,
5 under `onboarding`), three real gaps remain — none structural:

1. **Enforcement isn't committed.** A verified ESLint boundary rule + a "Scaling"
   doc section sit uncommitted on `main`.
2. **`../../` parent-traversal imports the doc bans, with no lint rule.** 19
   statements across 18 files — but only **9 are aliasable within `src/`**
   (`app/api/**/_shared/*`); the other **10 cross out of `src/` into `worker/`
   (9) and `scripts/` (1)**, which have **no `@/` alias**, so they cannot be
   converted. The largest cross-tree case, `worker/jobs/publisher/orphan-markers`
   (6 src importers), is genuinely shared logic that *should* relocate to
   `src/lib` — but that is **worker-touching (staging-first) and a separate
   spec** (see §7). The `worker/ingress/*` test imports are irreducible
   (Invariant #6: ingress is worker-only).
3. **The doc contradicts itself** (a stale "plan" section vs the "decided"
   sections), so a reader can't tell what's true.

And one **diagnosis** the data surfaced: most of `components/<domain>` is used by
exactly one route, yet sits in the "shared" tier. Example — `components/dashboard/`
is **78 files** (`settings/` 19, `reviews/` 12, `kpi/` 7, …); the bulk are
single-route. The "shared" bucket is mislabeled, which is the "scattered" feeling.

**Hard constraint (shapes every option):** `src/lib/<domain>/` is co-owned by the
Next.js UI **and the Railway worker** — the worker imports `src/lib/` at **141
sites**. Logic therefore cannot move into any UI-feature folder. `lib/<domain>`
is **frozen** in this design.

**Chosen direction:** keep the current 3-layer model (split by shared-ness), but
apply route-co-location discipline to the mislabeled "shared" tier, and enforce
the result. ("Option C + Option A discipline" from the brainstorm; `features/`
and pure-maximal-co-location were considered and rejected — `features/` fights
App Router route-locality for a gain we mostly already have, at maximum churn.)

---

## 2. The placement rule (LCA)

The convention collapses to **one deterministic principle**, removing the
"is this shared?" judgment call:

> **A component lives at the lowest route folder that contains all of its
> consumers.** Find every file that imports it; place it at their lowest common
> ancestor (LCA) in the route tree. If consumers span more than one top-level
> area, it is genuinely shared → `components/<domain>/`.

| Consumers of the component | Home |
|---|---|
| One route leaf (e.g. only the settings page) | `app/<area>/<leaf>/_components/` |
| Several leaves under one area (e.g. dashboard home + settings) | their LCA route dir + `/_components/` (the common subtree, often area-level) |
| Consumers span 2+ top-level areas | `components/<domain>/` (mirrors `lib/<domain>`) |
| Domain-agnostic primitive | `components/ui/` |

**Naming map (locked):** `app/<area>` ↔ `components/<domain>` ↔ `lib/<domain>`
use the same domain word. `lib/kpi` folds to `lib/dashboard/kpi`, or is recorded
as an explicit 1→n exception in the preferences doc. **`lib/<domain>` never
moves** (worker owns it).

**Trade-off accepted:** when a component graduates from one-route to two-route
use, it moves up a level (`git mv` + import rewrite). The LCA rule makes *where*
unambiguous; the move cost is the price of not having a catch-all.

**Expected effect on the pilot:** `components/dashboard/` drops from ~78 files to
roughly `shell/` + any cross-area cards (~10–15); the rest co-locates next to the
page that uses it.

---

## 3. Migration mechanics

### Step 0 — prerequisite: alias-first (src-internal only)

Convert the **9 aliasable `../../` imports** (`app/api/**/_shared/*`) to `@/`
aliases before any move. Rationale: once src-internal imports are alias-based,
moving a file is a pure **string replace** of its alias path; relative imports
break unpredictably as depth changes.

The **10 cross-tree `../../` imports** (`src → worker/`, `src → scripts/`) have
no `@/` alias and are **left in place** — the `../../` ban (§4) exempts paths
into `worker/`/`scripts/` via negative lookahead. Eliminating the genuinely
shared one (`orphan-markers`) is deferred to a separate relocation spec (§7); it
does not block this migration (those imports live in `app/api`, `lib`, and tests,
not in `components/<domain>`).

### The move algorithm (deterministic, per component)

1. For `src/components/<domain>/X/Foo.tsx`, the import specifier is
   `@/components/<domain>/X/Foo`.
2. `rg` that specifier across `src/` **and** `worker/` (including dynamic
   `import(` forms) → the consumer set.
   *Expectation to verify:* `worker/` imports **zero** UI. Any hit is a finding,
   not a move.
3. Compute the **LCA** of consumer paths → destination per the §2 table.
4. Emit a **move map**: `Foo.tsx → <destination>`, with its consumer list.

### Automate the mechanical, human-judge the ambiguous

- A throwaway Node script (ripgrep + the **TypeScript compiler API already in the
  repo — no new dependency**) builds the importer graph and *proposes* the full
  move map.
- **A human reviews the map before anything moves** — catches what grep can't
  (components wired via dynamic/string imports; components used once today that
  should still be treated as shared).
- On approval, the script executes: `git mv` (preserves history) + replace the
  old alias string with the new one across all consumers, the moved file's own
  sibling imports, and its tests.

### Tests ride along

`__tests__/Foo.test.tsx` moves into the destination `_components/__tests__/`;
the central `components/dashboard/__tests__/` (12 files) is distributed to wherever
its targets land.

### Behavior-preserving invariant

No file *contents* change except import path strings. `git diff -M` shows
renames + import-line-only diffs — **zero logic changes**. Each slice must
satisfy this.

### PR slicing (not one diff)

| PR | Scope | Size |
|---|---|---|
| 0 | `../../`→`@/` cleanup + commit the already-built ESLint boundary rule + doc reconciliation (§4) | small |
| 1 | **Pilot: `dashboard`** — proves the script + gate end-to-end (78 → ~12 in `components/dashboard`) | medium |
| 2…n | One PR per remaining domain (`admin`, `auth`, `approval`, `places`, …) — most have <6 files | small each |
| last | Flip on full enforcement once the tree is clean | small |

Each PR is UI-only (`lib/` never moves) → normal **PR-to-`main`**, no
staging-first requirement.

---

## 4. Enforcement

Three **zero-dependency** `no-restricted-imports` rules, all already running via
the existing `eslint src` CI `lint` job (no new CI wiring):

1. **Already built & verified** (commit in PR 0): non-route code may not import
   `@/app/**` (routes are terminal); `components/ui/**` stays domain-agnostic
   (no `lib/<domain>`, no `app/**`, no domain components; `lib/ui` + `lib/shared`
   allowed via negative-lookahead regex).
2. **New — ban `../../` (src-internal only)**: a `no-restricted-imports` regex
   `^\.\./\.\.(?!.*/(worker|scripts)/)` bans two-or-more-level parent traversal
   **except** cross-tree imports into `worker/`/`scripts/` (which have no alias).
   One-level `../` and `./` are left alone (matches the doc's "only `../../`
   banned").

### Flat-config override semantics (must get this right)

`no-restricted-imports` does **not merge** across flat-config objects — for a
given file the **last matching object wins**. So the configs nest as supersets,
ordered least- to most-specific:

| Config (in array order) | `files` | Bans |
|---|---|---|
| G (base) | `src/**` | `../../` |
| Z1 (non-route) | `src/**`, ignores `src/app/**` | `../../` + `@/app/**` |
| Z2 (ui primitives) | `src/components/ui/**` | `../../` + `@/app/**` + `lib/<domain>` + domain-components |

Each more-specific config **restates** the bans of the ones it overrides. (Worked
out and verified in prior session; PR 0 pins the exact config.)

### What lint can NOT enforce (stated honestly)

- *"`_components` is private to its area"* (no cross-area reach) needs
  `eslint-plugin-import`'s `no-restricted-paths` or `eslint-plugin-boundaries` —
  a **new dev dependency**. **Out of scope; optional follow-up, user's call.**
- *"page-specific UI must live under `_components/`, not loose in the route
  folder"* is not expressible as a lint rule — enforced by the convention doc +
  code review.

---

## 5. Verification gate (run on EVERY slice)

| Check | Proves |
|---|---|
| `pnpm typecheck` | every moved import still resolves (strongest net for move-only changes) |
| `pnpm lint` | boundary rules + `../../` ban green |
| `pnpm test` (affected) | no behavior change |
| `pnpm build` | Next.js route graph still valid |
| `pnpm ci:static-policy` | path-sensitive client-access checks didn't trip (moves change paths) |
| `git diff -M` review | renames + import-line-only diffs — the behavior-preserving invariant; any non-import content change is a red flag |

---

## 6. Doc reconciliation (part of PR 0)

Rewrite the stale "What we'd actually do (the plan)" section of
`docs/src-structure-preferences.md` to record the reorg as **done**, and replace
the "placement by shared-ness (≥2 routes)" wording with the single **LCA rule**
from §2. One authoritative placement rule, no contradictions.

---

## 7. Out of scope (YAGNI)

- No `features/<domain>/` tree; no `services/`/`store/`; no new runtime deps
  (`axios`, `zustand`, `clsx`/`tailwind-merge`) — per the preferences doc.
- No change to `lib/<domain>` (worker-owned, frozen).
- No `eslint-plugin-import`/`boundaries` dependency unless separately approved
  (the cross-area-privacy rule above).
- No behavior/logic changes anywhere — moves + import-path rewrites only.
- **Cross-boundary shared-module relocation** (move `worker/jobs/publisher/orphan-markers`
  → `src/lib` so its 6 src importers + the worker share a `@/lib/...` alias) is a
  **separate spec** — it is worker-touching (rides `staging` first), was never
  designed here, can only reduce cross-tree imports from ~10 to ~3 (the
  `worker/ingress/*` test imports are irreducible per Invariant #6), and is
  **independent of** this migration. To be brainstormed on its own.

---

## 8. Open items for the implementation plan

- Confirm `worker/` imports zero `@/components/**` before relying on §3 step 2's
  expectation.
- Decide `lib/kpi` → `lib/dashboard/kpi` fold vs documented 1→n exception.
- Whether PR 1 (dashboard, ~78 files) needs sub-slicing by route (settings /
  kpi / reviews) to keep diffs reviewable.
