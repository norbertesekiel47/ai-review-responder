# `src/` Structure Preferences

How RepWorth's frontend (`src/`) should be organized, and why we do **not**
adopt the generic "Next.js frontend best practices / features+services+store"
template wholesale. Authoritative architecture stays in
[`.claude/CLAUDE.md`](../.claude/CLAUDE.md); this doc only owns the **frontend
file-layout convention**. If anything here disagrees with CLAUDE.md, CLAUDE.md
wins.

> **TL;DR** — The top-level `src/` layout is fine. The scatter people feel is
> almost entirely in `src/components/`. Fix that one layer; do **not** introduce
> `features/`, `services/`, a client `store/`, or per-feature barrel files.

---

## Context: why this doc exists

A circulating "Scalable `src/` Architecture" doc recommends a
`features/ + services/ + store/ + barrel index.ts` structure with React Query as
the universal data layer and `services/http.ts` as the single backend seam. It
is written for a **client-fetching SPA where Next.js is the backend**. That model
contradicts RepWorth's #1 architecture invariant, so we adopt its *principles*
where we already follow them and reject its *machinery*.

---

## What we already do right (keep doing)

| Principle | RepWorth status |
|---|---|
| Thin pages; route handlers orchestrate, modules own logic | ✅ Hard rule — handlers parse input, call one module, return output |
| Domain-sliced modules | ✅ `src/lib/` is already split into ~30 domain folders (`accounts`, `approval`, `reviews`, `responses`, `zernio`, `kpi`, …) |
| Path aliases, no `../../` | ✅ `@/*`, `@/lib/*`, `@/types/*` configured; only a handful of `../../` stragglers remain |
| `components/ui/` is domain-agnostic | ✅ Holds |
| One-way dependency flow | ✅ Roughly holds |

The "features/" idea is **not new to us** — we already have it, named `lib/` and
separated from the UI.

---

## What we explicitly reject (and why)

1. **No "Next.js routes are the backend" model.** The generic doc routes
   `components → hooks → services → /api → Supabase/BullMQ/SerpAPI`. That is the
   architecture we deliberately rejected. **Invariant #1: Vercel = UI only;
   LLM/external/long-running work runs on Railway workers, never in Next.js
   routes.** BullMQ runs on the worker, not in `/api`.

2. **No universal `services/` HTTP layer + "components never fetch."** We are on
   **Next.js 16 + React 19 App Router** (server-first). The idiomatic read path
   is Server Component / server action → props, not a global
   `services/http.ts` + `useQuery` for everything. `@tanstack/react-query` is
   installed and correct for the *few* cases that need it (status polling, the
   approve page) — it is **not** the default data layer.

3. **No new client state/util dependencies on spec.** `store/` (Zustand/Jotai),
   `axios`, and `clsx`+`tailwind-merge` (`cn()`) are **not installed** and stay
   that way until a second concrete use case justifies each — per our "don't add
   a runtime dependency without a second concrete use case" rule.

4. **No mandatory per-feature barrel `index.ts`.** Barrels hurt tree-shaking and
   slow dev compile (Next ships `optimizePackageImports` to fight them). They
   work against our React Doctor bundle-size discipline.

---

## The actual problem: the `components/` layer

The top-level `src/` (`app/` + `lib/` + `hooks/` + `contexts/` + `types/`) is
reasonable. The "all over the place" feeling comes from `src/components/`:

- **Loose files dumped at the component root** — `AdminNav.tsx`,
  `DashboardContent.tsx`, `PlaceAutocomplete.tsx` sit at `src/components/` top
  level instead of in a domain folder.
- **~29 flat `.tsx` files** in `src/components/dashboard/` with only a few
  subfolders carved out (`aggregate/`, `edit-reply/`, `settings/`).
- **Split-by-layer, not by feature.** One "dashboard" feature is smeared across
  `app/(authenticated)/dashboard/` + `components/dashboard/` + `lib/dashboard/` +
  `lib/kpi/` + `hooks/`. Logic is domain-sliced in `lib/`, but UI is
  type-then-domain in `components/`, so the two halves never sit together — that
  mismatch is the smell, not the overall layout.

---

## What we did (status: completed)

The targeted cleanup is **done**: loose root files moved into domain folders,
`components/dashboard/` split into sub-feature folders, and the
`app/<area>/_components` co-location idiom adopted (PR #219). Remaining
placement work — moving single-route UI out of `components/<domain>` to its
route's `_components/` per the LCA rule below — is tracked by the migration
spec: `docs/superpowers/specs/2026-06-08-src-structure-lca-migration-design.md`.
We do **not** add `features/`, `services/`, or `store/`; `app/`, `lib/`
(domain-sliced), `hooks/`, `contexts/`, `types/` stay.

---

## Component placement rule (LCA)

A component lives at the **lowest route folder that contains all of its
consumers** — their lowest common ancestor (LCA) in the route tree. Find every
file that imports it; place it at:

- **One route leaf** → `app/<area>/<leaf>/_components/` (+ route-only hooks in
  `app/<area>/<leaf>/_hooks/`).
- **Several leaves under one area** → their LCA route dir + `/_components/` (the
  common subtree, often area-level).
- **Consumers span 2+ top-level areas** → `components/<domain>/` (mirrors
  `lib/<domain>/`).
- **Domain-agnostic primitive** → `components/ui/`.

`lib/<domain>` never moves (worker-owned — 141 import sites). Co-located folders
use the Next.js `_`-prefixed private-folder idiom (`_components/`, `_hooks/`).
The boundaries are enforced by `eslint.config.mjs` (`no-restricted-imports`
zones), not left to discipline.

**Imports:** use `@/` path aliases throughout, **including same-folder siblings**
(`@/components/dashboard/kpi/Sparkline`, not `./Sparkline`). The only banned form is
`../../` parent-traversal. This keeps every module reference uniform and move-stable.

**`cn()`:** use `@/lib/ui/cn` (zero-dep className joiner). No `clsx`/`tailwind-merge`.

**react-query:** scoped to `app/admin/**` + the few polling/approve spots. Customer
-facing prefers server-first; existing plain client fetches (e.g. `useDashboardData`)
are fine. react-query is NOT the default data layer.

---

## Scaling to many more pages (added 2026-06-08)

We will keep adding features → more route leaves (already **59 `page.tsx`** and
growing). Two things make that scale; both are cheap to adopt now and expensive
to retrofit later.

### Why NOT a `features/` vertical slice (the decisive constraint)

The generic answer to "many pages" is `features/<domain>/{components,hooks,logic}`.
**We can't use it.** `src/lib/<domain>/` is co-owned by the Next.js UI **and the
Railway worker** — the worker imports from `src/lib/` at **141 sites**. A
`features/reviews/` that swallowed the logic would force a backend job to
`import from "@/features/reviews/logic"`: wrong owner, wrong direction. So the
three-layer split below is **required by our topology**, not a stylistic pick:

| Layer | Owner | Scales by |
|---|---|---|
| `app/<area>/_components`, `_hooks` | one route leaf | per-route co-location — each page brings its own folder |
| `components/<domain>` | shared UI (≥2 routes) | promotion-on-second-use keeps it lean |
| `lib/<domain>` | UI **+ worker** | domain slicing (already ~30 folders) |

### 1. Route groups are the page-organization tool

`(authenticated)` and `(public)` already exist. As features multiply, group **by
concern** with route groups rather than nesting deeper — groups reorganize the
tree without changing URLs. Candidates as the app grows: fold `mfa/` into the
authenticated group; give `admin/` its own `(admin)` group; keep marketing pages
under `(public)`. Slice `app/admin/**` (the densest area, ~13 sub-routes) into
per-area `_components/` first.

### 2. The boundary is **lint-enforced**, not trusted to discipline

A documented convention drifts once dozens of pages and multiple editors (humans
+ agents) touch it. Three `no-restricted-imports` zones in the ESLint flat config
(`eslint.config.mjs`) enforce the rules below, so violations fail `pnpm lint` / CI:

- **Non-route code may not import `@/app/**`** — static *or* dynamic `import()`.
  Route leaves are terminal. Exempt: `app/**` itself (co-located siblings import
  each other) and **test files** (they legitimately import route handlers under
  test).
- **`components/ui/**` stays domain-agnostic** — no `@/app/**`, no domain
  components, and no `@/lib/<domain>`; the domain-agnostic `@/lib/ui` and
  `@/lib/shared` utilities (e.g. `cn()`) *are* allowed.
- **No src-internal `../..` parent-traversal** — use `@/` aliases. Cross-tree
  imports into `worker/`/`scripts/` (no alias exists) are exempt.

Not yet lint-enforced (would need `eslint-plugin-import`/`boundaries`, deferred) —
these stay doc + code-review conventions: "`_components` is private to its area"
(no cross-area reach) and "page-specific UI lives under `_components/`".

> When you add a layer or rename an area, update **both** this doc and the lint
> rule in the same change — the doc explains *why*, the rule is the *gate*.
