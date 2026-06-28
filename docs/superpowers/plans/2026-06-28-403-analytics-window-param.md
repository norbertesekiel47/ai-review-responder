# Plan — #403 Analytics time-range (window) param

Date: 2026-06-28
Branch: `feat/403-analytics-window-param`

## Problem

The analytics redesign omitted a time-range toggle because the data layer
can't back it: `/api/dashboard` returns a hardcoded 8-week trend and
`/api/dashboard/kpis` a hardcoded 30-day window. Wiring a toggle now would be a
fake control. Thread a validated `window` param end-to-end (service → routes →
cache key → toolbar UI), keeping today's behavior as the default.

## Decisions (self-resolved, autonomous)

1. **Canonical window set + default.** `7d | 30d | 90d | 12w`. Default (no
   param) = `30d`, which maps to the *current* behavior: **30-day KPI window +
   8-week trend**. Invalid / missing / unknown values clamp to `30d`.
2. **A window maps to two integers** — `windowDays` (rolling current-vs-prior
   bucket) and `trendWeeks` (weekly series length). One lookup table is the
   single source of truth (invariant: "one authoritative owner per fact"):

   | window | windowDays | trendWeeks |
   |--------|-----------|-----------|
   | `7d`   | 7  | 4  |
   | `30d`  | 30 (`KPI_WINDOW_DAYS`) | 8 (`SENTIMENT_TREND_WEEKS`) ← default |
   | `90d`  | 90 | 13 |
   | `12w`  | 84 | 12 |

   `30d` deliberately re-uses the existing `KPI_WINDOW_DAYS`/`SENTIMENT_TREND_WEEKS`
   constants so the default path is byte-identical in semantics to today.
   `reviewVolume` stays calendar-month (current vs prior month) regardless of
   window — unchanged, per the existing `KpiReviewVolume` contract.
3. **SQL safety.** Every interval becomes a *bound* value via
   `NOW() - make_interval(days => ${n})` / `make_interval(weeks => ${n})`, where
   `${n}` is a JS integer pulled from the fixed lookup table — never client text.
   This keeps `detected_at >= constant` sargable (no functional index needed) and
   makes injection structurally impossible (the only values that reach SQL are 4
   compile-time integers).
4. **Validation happens at the route boundary** via `resolveDashboardWindow()`
   before the value reaches any service / SQL. Services also default-guard so a
   direct service call is safe.
5. **Cache key = scope + window.** There is no server-side response cache for
   these endpoints (`Cache-Control: no-store, private`). The real cache is the
   client `useDashboardData` in-memory store, today keyed by `scope` only. Extend
   the key to `{ scope, window }` so two windows never collide, and append
   `?window=` to the fetch URL (omitted when default, so the default URL stays
   `/api/dashboard?scope=…` — keeps existing hook tests green and the browser
   cache distinct per window).
6. **Toolbar is lifted to `AnalyticsContent`** so the selection survives the
   loading/error/data branch swap and the control stays usable mid-refetch. It
   renders into a new `TopBar` `children` slot for every branch and both scopes
   (per-location + aggregate).

## Changes

- `src/lib/kpi/types.ts` — add `SENTIMENT_TREND_WEEKS`, `DashboardWindow`,
  `DASHBOARD_WINDOWS`, `DEFAULT_DASHBOARD_WINDOW`, `dashboardWindowParams()`,
  `resolveDashboardWindow()`.
- `src/lib/kpi/service.ts` — both summary fns take `window`; parameterize the
  30-day + 8-week intervals; report the real `windowDays`.
- `src/lib/dashboard/service.ts` — `getActiveDashboardData` opts gains `window`;
  velocity + reputation (current/prior/trend) intervals parameterized.
- `src/lib/dashboard/aggregate-service.ts` — `getAggregateDashboardData` takes
  `window`, forwards to each per-location call.
- `src/app/api/dashboard/route.ts` + `…/kpis/route.ts` — parse + clamp `window`,
  thread to services.
- `src/hooks/useDashboardData.ts` — `options.window`; URL + cache key + refetch.
- `src/components/dashboard/analytics/PeriodToolbar.tsx` (new) — segmented
  control (reuses `.tabs`/`.tab` Console styling, new `.period-*` classes).
- `src/components/dashboard/shell/TopBar.tsx` — `children` actions slot.
- `AnalyticsContent` / `AnalyticsPerLocationView` / `AnalyticsAggregateView` —
  lift `period` state, render toolbar, refetch on change.
- `src/app/(authenticated)/_styles/console.css` — `.period-toolbar` styles.

## Tests (TDD)

- `src/lib/kpi/__tests__/service.test.ts` — each window drives the right
  `windowDays` + parameterized `make_interval` (assert captured SQL + bound
  values); default unchanged.
- `src/lib/dashboard/__tests__/service.window.test.ts` (new) — velocity +
  reputation intervals parameterized by window.
- `src/app/api/dashboard/__tests__/route.test.ts` + `…/kpis/__tests__/route.test.ts`
  — default unchanged; each valid window passes through; invalid clamps to
  default; window forwarded to the service.
- `src/hooks/__tests__/useDashboardData.test.ts` — window in URL (omitted for
  default), cache key differs per window, refetch on window change.
- `src/components/dashboard/analytics/__tests__/PeriodToolbar.test.tsx` (new) —
  renders 4 options, marks active, fires `onChange`.

## Verify gate

`pnpm lint && pnpm typecheck && pnpm test` + `pnpm ci:tenant-scope` +
`pnpm ci:rls-audit` — all green. Commit on branch referencing #403; no push.
