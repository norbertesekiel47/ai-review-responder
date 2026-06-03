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

## What we'd actually do (the plan)

Keep `app/`, `lib/` (already domain-sliced), `hooks/`, `contexts/`, `types/`.
Do **not** add `features/`, `services/`, or `store/`. Targeted cleanup only:

1. **Flatten the loose root files** into their domain folder
   (`AdminNav → components/admin/`; `DashboardContent` / `PlaceAutocomplete` into
   the dashboard/onboarding folder where they belong).

2. **Break up the ~29-file `components/dashboard/`** by sub-feature — continue
   the pattern already started (`aggregate/`, `edit-reply/`, `settings/`) until
   no folder is a 20+ flat dump.

3. **Mop up the remaining `../../` imports** to `@/` aliases — cheap, mechanical.

4. **Pick one component co-location convention and write it down here.** Either:
   - **(A)** Keep shared `components/<domain>/` mirroring `lib/<domain>/` (fine —
     just enforce it consistently), **or**
   - **(B)** Co-locate route-only UI under its `app/(...)/_components/` and
     reserve `components/` for genuinely shared UI.

   Pick one. The inconsistency is the smell, not the layout. **Decide (A) vs (B)
   before moving files** so we don't re-scatter in a month.

> Sequencing note: write the convention (step 4 decision) **first**, then do the
> mechanical moves (steps 1–3). Otherwise the structure has no single owner and
> will drift again.

---

## Component placement rule (decided 2026-06-02)

Placement is decided by **shared-ness**. Unit = a route leaf (a dir owning a `page.tsx`).

- **Page-specific glue for exactly one route leaf** (forms, per-entity panels,
  page-only layouts) → co-locate: `app/<area>/_components/` (+ route-only hooks in
  `app/<area>/_hooks/`).
- **Reusable domain UI** — feature cards, widgets, charts, shell chrome, or
  anything rendered by a shared `layout.tsx` / composed via a shared container →
  `components/<domain>/`, mirroring `lib/<domain>/`.
- **Domain-agnostic primitive** → `components/ui/`.

Co-located folders use the Next.js `_`-prefixed private-folder idiom
(`_components/`, `_hooks/`). A file graduates from `_components/` to
`components/<domain>/` only when a second route leaf consumes it.

**Imports:** use `@/` path aliases throughout, **including same-folder siblings**
(`@/components/dashboard/kpi/Sparkline`, not `./Sparkline`). The only banned form is
`../../` parent-traversal. This keeps every module reference uniform and move-stable.

**`cn()`:** use `@/lib/ui/cn` (zero-dep className joiner). No `clsx`/`tailwind-merge`.

**react-query:** scoped to `app/admin/**` + the few polling/approve spots. Customer
-facing prefers server-first; existing plain client fetches (e.g. `useDashboardData`)
are fine. react-query is NOT the default data layer.
