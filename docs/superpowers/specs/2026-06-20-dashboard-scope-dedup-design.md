# Dashboard Scope Layer — Dedup the Page Wrappers (fast-follow)

**Date:** 2026-06-20
**Status:** Design (approved by owner)
**Author:** Norbert + Claude

## Context

PRs #348/#350 shipped the glance-dashboard / Analytics / Reviews IA. In doing so
they crossed the rule of three on a duplicated pattern: **payload-shape logic for
the `/api/dashboard` response is now copy-pasted across three page wrappers** —
`DashboardContent`, `ReviewsContent`, `AnalyticsContent`. This is the #349-style
fast-follow that cleans it up. **Pure refactor — zero behavior change, expected
net-negative lines.**

### The duplication (today)

- `ReviewsContent.tsx` and `AnalyticsContent.tsx` contain **byte-identical** local
  copies of `isAggregate(data): data is AggregateDashboardData` and
  `perLocationActive(data): DashboardDataActive | null`.
- `DashboardContent.tsx` has the **same logic under different names**
  (`isAggregateData`, `computePendingCount`).
- The "push pending count to the nav badge" side effect — `const pending = …filter(
  pending_approval).length` + `useEffect(() => setPendingCount(pending), …)` — is
  **triplicated** across all three.
- Because `DashboardOrAggregate` is not a clean discriminated union, each guard
  resorts to `data as DashboardData` / `as DashboardDataActive` casts.

Adding a 4th data-driven page would paste the whole thing a 4th time. One owner
needed.

## Goals

- **One canonical owner** for "what shape is this payload?" and "what's the
  pending count?" — consumed by all three wrappers.
- **Delete** the duplicated guards and the triplicated pending-count effect.
- Tighten the type boundary so the `as` casts go away **if low-cost**.

## Non-goals

- No behavior change, no copy change, no visual change. Snapshots/DOM identical.
- No backend/API changes.
- Not required: collapsing `DashboardContent`'s non-active subscription state
  machine (it legitimately differs from the other two — see §Scope item 4).

## Scope

### 1. Canonical scope module — `src/lib/dashboard/scope.ts` (new)

Pure functions over the `DashboardOrAggregate` union (imported from
`@/lib/dashboard/types` / `@/hooks/useDashboardData`):

```ts
export function isAggregate(data: DashboardOrAggregate): data is AggregateDashboardData
export function selectActivePerLocation(data: DashboardOrAggregate): DashboardDataActive | null
export function selectPendingCount(data: DashboardOrAggregate | null): number
```

- `selectPendingCount` subsumes both the inline `pending` blocks (Reviews/Analytics)
  and `DashboardContent`'s `computePendingCount` — they compute the identical thing.
- Co-locate unit tests (`scope.test.ts`): aggregate vs per-location vs past_due vs
  non-active; pending count across each.

### 2. Pending-count hook — `src/hooks/useSyncPendingCount.ts` (new)

```ts
export function useSyncPendingCount(data: DashboardOrAggregate | null): void {
  const setPendingCount = useSetPendingCount();
  const count = selectPendingCount(data);
  useEffect(() => { setPendingCount(count); }, [count, setPendingCount]);
}
```

Replaces the triplicated `pending` + `useEffect(setPendingCount)` in all three
wrappers with a single `useSyncPendingCount(data)` call. (Mind `DashboardContent`'s
extra `blockedOffboarding → setPendingCount(0)` path — keep that; it's a distinct
concern, not the data-derived count.)

### 3. Refactor the three wrappers to consume #1/#2

- `ReviewsContent.tsx` / `AnalyticsContent.tsx` — delete the local `isAggregate` /
  `perLocationActive`; import from `scope.ts`. Replace the pending block with
  `useSyncPendingCount(data)`.
- `DashboardContent.tsx` — delete `isAggregateData` / `computePendingCount`; import
  the canonical guard + `selectPendingCount` (used by both the operational content
  and the offboarding-gate `computePendingCount` call site).

### 4. (Strongly consider) Shared shell for the Reviews/Analytics twins

`ReviewsContent` and `AnalyticsContent` are ~90% the same component: identical
loading / error / aggregate-dispatch / active-null-guard / "not available"
scaffold, differing only in title strings and the rendered body. Extract a
render-prop shell:

```tsx
// src/components/dashboard/shell/ScopedDashboardView.tsx
interface ScopedDashboardViewProps {
  title: string;
  loadingMessage: string;
  errorTitle: string;
  unavailableTitle: string;
  unavailableBody: React.ReactNode;
  renderAggregate: (data: AggregateDashboardData, refresh: () => void) => React.ReactNode;
  renderActive: (active: DashboardDataActive, refresh: () => void, readOnly: boolean) => React.ReactNode;
}
```

Reviews and Analytics collapse to their `renderAggregate` / `renderActive` bodies.

> **Do NOT fold `DashboardContent` into this shell.** It carries the offboarding
> gate + the full non-active subscription state machine (active_pending_business,
> pending_payment_admin_handoff, PENDING_PAYMENT, CANCELLED, past-due banners,
> connect-Google banner). It legitimately needs its own structure; only #1 and #2
> apply to it.

If the shell adds more indirection than it removes for only two callers, ship
#1–#3 and skip #4 — the guards + hook are the high-conviction win.

### 5. (Optional) Discriminated-union cleanup

If `DashboardOrAggregate` can be made a clean discriminated union (e.g. a `scope`
or `kind` tag on every variant) **at low cost**, do it so the `as DashboardData` /
`as DashboardDataActive` casts inside the guards disappear. If it ripples into many
call sites, defer — don't expand scope for it.

## Out of scope (separate tiny touch)

- The History route still titles its `TopBar` **"Past Replies"** while its tab says
  **"History"** — a copy decision, not part of this refactor. Handle separately.

## Testing / verification contract

- New `scope.test.ts` (guards + pending count) and `useSyncPendingCount` covered.
- Existing `DashboardContent` / `ReviewsContent` / `AnalyticsContent` /
  `AggregateDashboardContent` tests pass **unchanged** (behavior identical) — if any
  test needs editing beyond import paths, that's a signal the refactor changed
  behavior; stop and reconsider.
- Full gates: `pnpm lint && pnpm typecheck && pnpm test && pnpm build` + the four
  audits (`ci:static-policy`, `ci:analytics-events`, `ci:tenant-scope`,
  `ci:rls-audit`).
- Expect a **net-negative** line count.

## Branch / PR

`refactor/dashboard-scope-dedup` off `main`; land via PR; do not merge — stop and
report the diff (esp. the net line delta and that no behavior test changed) for
review.
