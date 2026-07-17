# Spec & Correctness Review — perf/478-cache-kpi-dashboard

Branch: `perf/478-cache-kpi-dashboard` · base `main`
Scope: 45s fail-open Upstash read cache on KPI summaries + per-location dashboard payload, mirroring the #487 aggregate cache.

**Verdict: PASS.** No blocker/major/minor correctness or spec findings at ≥80% confidence. One informational staleness-amplification note (freshness, not correctness) and low-confidence appendix items only.

All affected tests pass locally (67 tests across the 7 touched/adjacent files, incl. the two new cache suites and both route tests).

---

## Per-question findings (yes/no + evidence)

### 1. Faithful to intake goal + both tracer tickets? YES
- **T1 (KPI read cache)** — `src/lib/kpi/service.ts:160-171` (location GET), `:247-260` (location SET), `:267-278` (account GET), `:360-372` (account SET). Both `getLocationKpiSummary` / `getAccountKpiSummary` keep their exact signatures; cache is hidden inside. `KPI_CACHE_TTL_SECONDS = 45` (`:29`).
- **T2 (per-location dashboard read cache)** — `src/lib/dashboard/service.ts:84-114` wraps `getActiveDashboardData`; body extracted verbatim into `buildActiveDashboardData` (`:116+`). `DASHBOARD_LOCATION_CACHE_TTL_SECONDS = 45` (`:45`).
- Fail-open block matches `aggregate-service.ts` (get→JSON.parse; compute; set EX 45; `console.error` on both). Interfaces + callers untouched, as the plan locked.

### 2. Tenant isolation — every key namespaced by tenant + window (+rep)? YES
- Keys:
  - `kpi:location:${businessId}:${window}` (`kpi/service.ts:32`)
  - `kpi:account:${accountId}:${window}` (`kpi/service.ts:36`)
  - `dashboard:location:${businessId}:${window}:${rep|norep}` (`dashboard/service.ts:64`)
- **No collision is reachable.** `businessId`/`accountId` are UUIDs (no `:`), `window` is the fixed enum `7d|30d|90d|12w` (`kpi/types.ts:61`), and the four namespaces (`kpi:location`, `kpi:account`, `dashboard:location`, `dashboard:aggregate`) differ by literal prefix and segment count. Location vs account KPI cannot collide even when a `businessId` equals an `accountId` because of the `location`/`account` segment. Test: `service.cache.test.ts` "cache key distinctness" + "two different windows" (kpi) and "key varies by window / rep" (dashboard).

### 3. Fail-open on GET and SET? YES
- KPI location GET try/catch `:160-171`; SET try/catch `:255-259`. Account GET `:267-278`; SET `:367-371`.
- Dashboard GET `:87-94`; SET `:102-112`.
- Each GET failure logs and falls through to fresh compute; each SET failure logs and returns the already-computed fresh result. Shape identical to `aggregate-service.ts:73-90`. Tests: "GET throws → fails open", "SET throws → returns fresh" in both suites (passing).

### 4. BusinessNotFoundError never cached? YES
- `getActiveDashboardData` calls `buildActiveDashboardData` (`service.ts:99`), which throws `BusinessNotFoundError` at `:331` — *before* the wrapper's `set` at `:103`. The throw propagates out of the wrapper, so `set` is never reached. Test `service.cache.test.ts` "BusinessNotFoundError: never caches the 404 signal" asserts `setMock` not called (passing).

### 5. Cache-miss parity / JSON round-trip (Date fields)? YES (with the expected single-field nuance)
- The **only** DTO field that differs between fresh (Date) and cached (string) is `autoPostScheduledAt` — `active-mappers.ts:43` passes `row.auto_post_scheduled_at` through raw as `Date | string | null`.
- Every other timestamp is already string-normalized before caching: `business.createdAt` is `input.business.created_at.toISOString()` (`service-mappers.ts:225`); `trialEndsAt` typed `string | null`; ranking/velocity dates are strings from SQL. So no *other* field diverges.
- **No server-side consumer does Date math on `autoPostScheduledAt`.** The only non-route consumer of `getActiveDashboardData` is the aggregate fan-out (`aggregate-service.ts`), which reads per-location `recentReviews` only via `.length` (`aggregate-service.ts` locationKpis map) — never the item's `autoPostScheduledAt`. The route returns the payload straight to `jsonResponse`, which serializes Date and string identically.
- Round-trip is locked by `service.cache.test.ts` "JSON round-trip fidelity" (Date-valued `auto_post_scheduled_at` → store → HIT → re-read; asserts `JSON.stringify(cached) === JSON.stringify(fresh)`, passing).

### 6. Key correctness for getActiveDashboardData — includes window + includeReputationMetrics, excludes opts.business? YES
- `locationCacheKey` (`service.ts:61-65`) reads `opts?.window ?? DEFAULT_DASHBOARD_WINDOW` and `opts?.includeReputationMetrics ?? false`; `opts.business` is deliberately absent (documented `service.ts:56-60` as a query-skip only).
- **Key default agrees with compute default**, so no rep/norep mismatch: the key uses `?? false` and the compute uses `opts?.includeReputationMetrics ? fetchReputationRows(...) : Promise.resolve(null)` (`service.ts:324-326`) — both treat `undefined` as norep, and `reputationSummary` is `undefined` exactly when the flag is falsy (`service.ts:337-341`). A rep request (`:rep`) can never be served a norep payload or vice-versa.
- The aggregate fan-out calls `getActiveDashboardData(sql, loc.id, { window })` (norep → `:norep` key); the single-location landing passes `includeReputationMetrics: true` (`:rep` key). Distinct keys → no cross-serving of a reputation-bearing vs reputation-stripped payload. Test "key varies by includeReputationMetrics … but never by opts.business" (passing).

### 7. tests_to_add coverage — every promised test present and meaningful? YES
| Promised | Present | Evidence |
|---|---|---|
| KPI HIT zero-SQL | ✅ | `service.cache.test.ts` HIT asserts `sqlCalls` length 0 (location+account) |
| KPI MISS writes key+TTL | ✅ | asserts `setMock('kpi:location:biz-1:30d', …, 'EX', 45)` (+account) |
| KPI GET fail-open | ✅ | "GET throws" |
| KPI SET fail-open | ✅ | "SET throws" |
| KPI key distinctness (scope, window) | ✅ | "cache key distinctness" + "two different windows" |
| Dashboard HIT/MISS/read+write fail-open | ✅ | `service.cache.test.ts` 4 cases |
| Dashboard key varies by window AND rep flag | ✅ | 2 cases |
| BusinessNotFoundError not cached | ✅ | present |
| JSON round-trip fidelity | ✅ | present, exercises real Date field |
- Tenant-isolation via distinct ids: covered by window/scope distinctness + distinct businessId/accountId keys. Meaningful (each drives real key assertions, not smoke).
- The "shared read-through helper" test row is N/A — the plan deliberately did not extract a helper (inline idiom), so `redis-cache.ts` is untouched. Consistent with the plan.

### 8. Drift? NONE
- Every changed file is inside `allowed_edit_surface`: `kpi/service.ts`, `kpi/__tests__/**`, `dashboard/service.ts`, `dashboard/__tests__/**`, `.feature/**`, plus the explicitly-signed-off `src/app/api/dashboard/__tests__/route.test.ts` — **the amendment IS present in `intake.json` `allowed_edit_surface`.**
- `redis-cache.ts` NOT edited (non-goal respected). No SQL text changed — `service.ts` only lifted the existing body into `buildActiveDashboardData`; `kpi/service.ts` only wrapped `assembleSummary`. No write-path invalidation, no dogpile lock, no `force-dynamic`/route-cache change, no other surface cached.
- No behavior added beyond `user_visible_behavior` (cache HIT reuse, ≤45s staleness, cold-cache/unreachable no-op).
- `route.test.ts` change is sound: the key-aware mock routes `dashboard:`-prefixed reads to null and everything else to `mockRedisGet`. Verified the pending-marker key is `connect_pending:${businessId}` (`zernio/connect-state.ts:92`) — does **not** start with `dashboard:`, so the pending-marker tests still drive `mockRedisGet`. (Passing, 29 tests.)

### 9. Staleness correctness (aggregate 45s over per-location 45s)? Freshness only — no correctness issue
- The #487 aggregate cache is unchanged (non-goal). On an aggregate cache MISS, the fan-out now calls the per-location `getActiveDashboardData`, which may itself return data cached up to 45s earlier, and the recomputed aggregate is then cached for another 45s. **Worst-case observed staleness for the aggregate path is therefore ~90s, not 45s.**
- This is a *freshness* amplification, not a correctness defect: no invariant is violated, tenant isolation holds (norep per-location key is a correct input for the aggregate), and the intake explicitly locks "pure TTL" and "leave #487 intact". The `user_visible_behavior` "up to 45s stale" is per-surface; the layered aggregate path can exceed it. Flagged as informational so it is a conscious acceptance, not a silent one. (See low-confidence appendix for the only mitigation that wouldn't touch #487.)

---

## Low-confidence appendix (speculative / nice-to-have)

- **[minor, freshness] Aggregate staleness ~2×TTL.** As in Q9. If ≤45s end-to-end staleness on `scope=all` is ever a hard requirement, the per-location cache would need a shorter TTL than the aggregate, or the fan-out would need to bypass the per-location read cache — both touch the #487 posture and are out of scope here. Recommend leaving as-is and documenting the ~90s bound. Confidence this is *worth changing now*: low.
- **[nit] Log-line prefixes.** KPI uses `[kpi]`; dashboard uses `[dashboard/service]`; aggregate uses `[dashboard/aggregate]`. Consistent-enough with the mixed existing convention; no action.
- **[nit] `console.error` vs structured logger.** The feature faithfully mirrors #487's `console.error` (the intake pins "exact try/catch + console.error shape from aggregate-service.ts"), so this is correct per contract even though CLAUDE.md prefers `createWorkerLogger`. Not a finding — the contract explicitly requires the mirror. Worth a future sweep across all three sites together, not in this PR.
- **[observation] `scope-route.test.ts:72`** mocks `getCacheRedis` with `get` only (no `set`) and was not updated. Not a defect: that test stubs both `getActiveDashboardData` and `getAggregateDashboardData`, so the real `.set` path never executes there. Verified passing (12 tests). If those service mocks are ever removed, this test would exercise a fail-open `.set` TypeError (swallowed) — harmless but noisy; adding `set: async () => 'OK'` there would future-proof it.
