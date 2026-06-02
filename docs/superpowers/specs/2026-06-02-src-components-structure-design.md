# `src/components/` Structure — Convention + Targeted Cleanup

**Status:** Design approved (brainstorm 2026-06-02). Ready for implementation plan.
**Owner of the living convention:** [`docs/src-structure-preferences.md`](../../src-structure-preferences.md)
**Authority:** [`.claude/CLAUDE.md`](../../../.claude/CLAUDE.md) wins on any conflict.

---

## 1. Problem

`docs/src-structure-preferences.md` correctly diagnosed that RepWorth's `src/`
scatter lives almost entirely in `src/components/`, and correctly rejected the
generic "features + services + store + barrels" SPA template. But it left one
decision open (component co-location convention **A** vs **B**) and stated four
rejections as settled. This brainstorm re-opened all of it against **real
evidence from the tree**, and the evidence reframed the problem:

- **The codebase is not greenfield on the A-vs-B question.** It already runs
  **both** conventions, split by area:
  - **`app/admin/**`** co-locates UI and hooks next to routes
    (`app/admin/businesses/[id]/components/`, `.../hooks/`) — convention **(B)**.
  - **`components/dashboard/`** (customer-facing) is a flat `components/<domain>`
    pile — convention **(A)**.
- **`@tanstack/react-query` is concentrated in `app/admin/**`** (12 of 13
  using files). The customer dashboard is server-first. The client-fetch
  "policy" the original doc left vague is **already a real, principled split** —
  it just was never written down.
- **The `cn()` rejection was the weakest call.** ~**274** manual
  className-juggling sites (170 template-literal interpolations + 104 ternaries),
  **zero** helper, nothing installed.
- **The 29 flat `components/dashboard/` files cluster cleanly** into sub-features
  that map to existing `lib/` domains; they have **0 direct page importers**
  (composed internally by container components), confirming they are cohesive
  shared feature UI, not route-only leaves.

This spec resolves the convention, kills the className pain with zero
dependencies, writes down the client-fetch boundary, and lands the mechanical
cleanup in one behavior-preserving PR.

---

## 2. Decisions (resolved in brainstorm)

| # | Decision | Resolution |
|---|---|---|
| D1 | Component co-location convention | **Codify the existing split with one shared-ness rule** (see §3). |
| D2 | `cn()` / className helper | **Local zero-dependency `cn()`** at `src/lib/ui/cn.ts`; adopt opportunistically (see §4). |
| D3 | Client-fetch / react-query policy | **Write down the existing boundary**: admin tooling + polling/approve = client-fetch OK; customer-facing = server-first (see §5). |
| D4 | "Lightweight feature co-location" | **Not a new idea** — it is convention (B), which admin already runs. Folded into D1. |
| D5 | Migration execution | **One atomic, behavior-preserving cleanup PR** (see §6). |

### Reaffirmed rejections (out of scope — invariant-locked)

These stay rejected; this spec does **not** reopen them:

- **No "Next.js routes are the backend" model** — Invariant #1 (Vercel = UI
  only). No `features → hooks → services → /api → BullMQ` flow.
- **No universal `services/http.ts` fetch layer** — server-first is the Next 16 /
  React 19 reality; client-fetch is the documented exception (§5), not the spine.
- **No mandatory per-feature barrel `index.ts`** — hurts tree-shaking and dev
  compile; fights React Doctor bundle discipline and `optimizePackageImports`.
- **No `store/` (Zustand/Jotai), no `axios`** — no second concrete use case yet.

---

## 3. The convention rule (D1)

**One rule, decided by shared-ness, applied identically in every area.**

A component or hook is placed by answering a single question. The unit is a
**route leaf** = a directory that owns a `page.tsx`.

> **Is this used by exactly one route leaf as page-specific glue, or is it
> reusable domain UI?**

| Case | Home |
|---|---|
| Page-specific glue for **exactly one** route leaf (forms, per-entity panels, page-only layouts — admin's `businesses/[id]` panels are the model) | **Co-locate**: `app/<area>/_components/` (+ route-only hooks in `app/<area>/_hooks/`). |
| Reusable domain UI — feature cards, widgets, charts, and shell chrome that form a domain's vocabulary, **or** anything rendered by a shared `layout.tsx` / composed via a shared container | **Shared**: `components/<domain>/`, mirroring `lib/<domain>/`. |
| Domain-agnostic primitive (used anywhere, knows no domain) | `components/ui/` (unchanged). |

**Disambiguation (resolves the dashboard case):** a component rendered by a
shared `layout.tsx` (e.g. the authenticated shell — `Sidebar`/`TopBar`) or
composed into a page through a shared container (e.g. `DashboardContent`) counts
as **shared**, because the layout/container is itself reused across the route
group. Consequence, by design and matching the low-churn intent: the **customer
dashboard stays in `components/dashboard/`** (sub-foldered, §6.2); `_components/`
is reserved for page-specific glue that has no domain home.

**Graduation rule:** a file lives in `_components/` until a *second* route leaf
needs it; at that point it graduates to `components/<domain>/`. Movement is
one-directional and triggered by a real second consumer — never speculatively.

**Folder naming — the `_` private-folder idiom is canonical.** Co-located
folders use the Next.js underscore-prefixed *private folder* convention
(`_components/`, `_hooks/`) so they can never be mistaken for a route segment.
Admin's current bare `components/`/`hooks/` folders are renamed to match
(see §6.5).

**Why this rule:** it *blesses the split that already exists* (admin = co-located,
customer = `components/<domain>`) instead of forcing a large migration in either
direction, and it gives the previously-accidental boundary a single owning test.

---

## 4. `cn()` helper (D2)

Add **`src/lib/ui/cn.ts`** — a small, **zero-dependency** className composer:

```ts
type ClassValue = string | number | false | null | undefined;

/** Join truthy class values into a single className string. */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ');
}
```

- **No `clsx`, no `tailwind-merge`, no `classnames`.** The 274 concrete sites are
  *conditional composition* (clsx's job), not *Tailwind conflict-merging*
  (tailwind-merge's job). A naive filter-and-join covers them and respects the
  "no runtime dependency without a second concrete use case" rule.
- **Adoption is opportunistic, not a big-bang codemod.** Introduce the helper;
  convert call sites as files are touched (leave-it-better). A 274-site mechanical
  rewrite in one PR is too noisy and risky to review honestly.
- **`tailwind-merge` is explicitly deferred** until a shared primitive needs to
  merge a caller-supplied `className` that can *conflict* with internal classes.
  With only 7 files in `components/ui/`, that case is not yet real.
- **Lives in `src/lib/ui/`** (alongside the existing `lib/ui` area) rather than a
  new top-level dir — no new top-level directory is introduced.

---

## 5. Client-fetch convention (D3)

Document the boundary that already exists; introduce no new machinery:

- **`app/admin/**` internal tooling** is client-fetch by design — `@tanstack/
  react-query` for server state, route-co-located hooks for orchestration. This
  is appropriate: admin dashboards are interactive, low-traffic internal tools.
- **The few customer-facing client-fetch spots** — status polling and the
  approve page — use `@tanstack/react-query` deliberately. This is the
  *exception list*, not the default.
- **All other customer-facing reads stay server-first**: Server Component /
  server action → props. No `useQuery` for data a Server Component can fetch.
- **This is a naming exercise, not a code change.** It records the existing
  boundary in `src-structure-preferences.md` so future code stops treating
  client-fetch as an accidental free-for-all.

---

## 6. Mechanical cleanup (D5 — one atomic, behavior-preserving PR)

All moves below are **file relocations + import fixups only** — no behavior
changes. Guarded by the verification gate in §7.

### 6.1 Flatten the 3 loose root files

| File | New home | Rationale |
|---|---|---|
| `components/AdminNav.tsx` | `components/admin/` | Admin-shared chrome. |
| `components/DashboardContent.tsx` | `components/dashboard/` (shell or container) | Customer dashboard container. |
| `components/PlaceAutocomplete.tsx` | onboarding home (per its sole consumer; apply §3 test) | If one route → that route's `_components/`; if shared → `components/onboarding/`. |

### 6.2 Break up `components/dashboard/` (29 flat files) into sub-feature folders

Files have 0 direct page importers (composed internally) → they are **shared
feature UI** and stay **inside `components/dashboard/`** as sub-feature folders
mirroring `lib/` domains. Proposed clustering (each file re-checked against §3
before moving; any file imported by exactly one route subtree goes to that
route's `_components/` instead):

- **`shell/`** — `Sidebar`, `TopBar`, `MobileTabBar`, `SettingsTabs`,
  `AuthenticatedProviders`, `Icon`
- **`kpi/`** — `KpiCards`, `ValueKpiGrid`, `Sparkline`, `VelocityCard`,
  `RankingCard`, `RankingChart`, `IntelligenceBriefCard`
- **`reviews/`** — `ReviewsCard`, `ReviewActions`, `PastReplyCard`,
  `EditReplyDrawer` (reconcile with existing `edit-reply/` subfolder)
- **`account-state/`** — `AccountStateScreens`, `SubscriptionStatusBanner`,
  `HistoricalUpgradeBanner`, `ConnectGoogleBanner`, `PastDueModal`,
  `PendingPaymentScreen`, `PendingAdminHandoffScreen`
- **`channels/`** — `OwnerTelegramWidget`, `OwnerWhatsAppWidget`,
  `ComingSoonChannelRow`
- **`location/`** — `LocationPicker`

Continue the pattern already started (`aggregate/`, `edit-reply/`, `settings/`).
**Target:** no folder is a 20+ flat dump.

### 6.3 Relocate the two stray contexts

`PendingCountContext.tsx` and `AuthenticatedProviders.tsx` are React
context/provider code living under `components/dashboard/`. Move to:
- `contexts/` if shared across the authenticated subtree (matches
  `contexts/LocationContext.tsx`), **or**
- `components/dashboard/shell/` if they are dashboard-shell-only.

Decide each against §3 (does a second subtree consume it?).

### 6.4 Mop up `../../` imports → `@/` aliases

20 remaining relative-parent imports in `src/` → `@/`, `@/lib/*`, `@/types/*`.
Pure mechanical fixup.

### 6.5 Standardize admin co-located folders

Rename `app/admin/**/components/` → `_components/` and
`app/admin/**/hooks/` → `_hooks/`, with import fixups, so §3's rule reads
identically in admin and elsewhere.

### Sequencing (preserved from the original doc)

1. **Write the conventions first** — §3 (rule), §4 (cn), §5 (client-fetch) into
   `docs/src-structure-preferences.md`; one-line pointer into
   `docs/directory.md`. *Structure gets a single owner before files move.*
2. **Then the moves** — §6.1 → §6.5.

---

## 7. Verification gate (behavior-preserving guarantee)

The cleanup PR is correct iff it changes *only* file locations and import paths.
Before claiming done:

- `pnpm lint && pnpm typecheck && pnpm test` — all green.
- **React Doctor regression check** — score must not drop (bundle/a11y/arch).
- `pnpm ci:tenant-scope` — only if any moved file touches tenant-scoped queries
  (none expected; run as a cheap guard).
- **Import-graph diff** is the review lens: every changed import should resolve
  to the same module at a new path. No new top-level directory. No new runtime
  dependency. No barrel `index.ts` added.

---

## 8. Where each decision is recorded (single owner — no duplication)

| Knowledge | Single owner |
|---|---|
| The convention rule (§3), cn policy (§4), client-fetch boundary (§5) | `docs/src-structure-preferences.md` (resolve its open checkbox there) |
| Migration plan + decision rationale (this brainstorm) | **this file** |
| One-line "where component UI lives" pointer | `docs/directory.md` |

---

## 9. Out of scope

- Reopening Invariant #1 or any architecture invariant.
- Introducing `features/`, `services/`, `store/`, `axios`, `clsx`,
  `tailwind-merge`, or barrel files.
- A 274-site `cn()` codemod (adoption is opportunistic).
- Any behavior change, prop change, or refactor beyond file relocation +
  import fixups + the `cn()` helper addition.
