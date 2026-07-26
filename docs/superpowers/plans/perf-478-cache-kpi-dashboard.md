# Plan — #478 remaining: cache KPI service + per-location dashboard payload

Ticket #478 (wayfinder map #472), remaining scope after #487. Intake:
`.feature/intake.json`. RISK=normal · SURFACE=backend · db_touching=false.

## Design summary (codebase-design)

- **Deepen existing modules; do not add a seam.** `getLocationKpiSummary`,
  `getAccountKpiSummary`, and `getActiveDashboardData` keep their **exact
  interfaces** — callers (`/api/dashboard/kpis`, `/api/dashboard`,
  `aggregate-service` fan-out) are untouched. The read-through cache is hidden
  *inside* each implementation (complexity pulled downward: same small
  interface, more behaviour).
- **Inline the #487 fail-open block; do NOT extract a helper.** The block is a
  ~10-line stable idiom, and the three sites are not identical (aggregate has a
  `partialFailures` conditional write, so a plain helper can't own all three).
  Extracting would add a module + intake-surface amendment + ESM intra-module
  mock friction for no real locality win at 3 sites. Mirror
  `src/lib/dashboard/aggregate-service.ts` exactly. **`redis-cache.ts` is NOT
  edited** (stays in allowed surface only as a safety margin).
- **Test idiom precedent**: `aggregate-service.test.ts` lines 24–33 —
  `vi.mock('@/lib/db/redis-cache', () => ({ getCacheRedis: () => ({ get: async()=>null, set: async()=>'OK' }) }))`.

## Invariants in play

- **Tenant isolation via key namespacing** — every key carries the tenant id +
  window (+ rep flag for the dashboard). No cross-tenant/scope/window collision.
- **Fail-open** — Redis read OR write failure → fresh DB result, never surfaced.
- **Cache-miss parity / JSON round-trip** — `autoPostScheduledAt` is typed
  `Date | string | null` (`dashboard/types.ts:86`); a Date round-trips to an ISO
  string. Safe end-to-end (only consumer is `jsonResponse` which serialises both
  identically; no server consumer does Date math on it) — but locked with a
  round-trip fidelity test.
- **`BusinessNotFoundError` never cached** (thrown before any `set`).
- **No SQL text change** → tenant-scope + RLS audits stay green, no allowlist edits.

## Tracer tickets

### T1 — KPI read cache  ·  blocking edges: none
Tracer: a KPI request for the same tenant+window within 45s is served from Upstash.

- `src/lib/kpi/service.ts`:
  - `const KPI_CACHE_TTL_SECONDS = 45;`
  - key helpers: `kpi:location:${businessId}:${window}` /
    `kpi:account:${accountId}:${window}`.
  - Wrap both `getLocationKpiSummary` / `getAccountKpiSummary` bodies: try
    `getCacheRedis().get(key)` → `JSON.parse` return on hit (catch→log→fall
    through); compute the existing summary; try
    `set(key, JSON.stringify(summary), 'EX', KPI_CACHE_TTL_SECONDS)`
    (catch→log); return. Same `console.error` shape as aggregate-service.
- `src/lib/kpi/__tests__/service.test.ts`: add the always-miss `redis-cache`
  stub so existing tests keep exercising fresh compute.
- `src/lib/kpi/__tests__/service.cache.test.ts` (new): HIT returns cached
  summary with **zero** SQL issued; MISS computes + writes with the right
  key+TTL; GET throws → fail-open compute; SET throws → returns fresh; keys
  distinct across (location vs account) and across windows.

### T2 — Per-location dashboard read cache  ·  blocking edges: none
Tracer: a per-location dashboard request for the same tenant+window+rep-flag
within 45s is served from Upstash.

- `src/lib/dashboard/service.ts`:
  - `const DASHBOARD_LOCATION_CACHE_TTL_SECONDS = 45;`
  - key: `dashboard:location:${businessId}:${window}:${includeReputationMetrics ? 'rep' : 'norep'}`
    (window defaults to `DEFAULT_DASHBOARD_WINDOW`; `opts.business` pre-fetch is
    a query-skip only → NOT in key).
  - Wrap `getActiveDashboardData`: cache `get`/`JSON.parse` at the top
    (fail-open); on miss run the existing 14-query assembly; `set` on success
    (fail-open). `BusinessNotFoundError` throws inside the compute, before any
    `set` → never cached.
- Add the always-miss `redis-cache` stub to `service.feed-projection.test.ts`
  and `service.rating-breakdown.test.ts` (they call the real function; without
  the stub they'd attempt a real Redis connect).
- `src/lib/dashboard/__tests__/service.cache.test.ts` (new): HIT returns cached
  payload with zero SQL; MISS computes + writes with right key+TTL; GET/SET
  throw → fail-open; key varies by window AND by `includeReputationMetrics`;
  `BusinessNotFoundError` propagates and nothing is cached; **JSON round-trip
  fidelity** — a payload whose `autoPostScheduledAt` is a Date, cached then
  re-read, serialises identically to the fresh payload.

## Verify gate (step 5)
Standard: `scripts/verify-gate.sh` (lint, typecheck, test, all `ci:*` except
fallow). No `pnpm build` (backend surface). Expect tenant-scope + RLS audits
green with zero allowlist edits (no SQL changed).

## Non-goals (drift guards)
#476 set-based fan-out; write-path invalidation; dogpile lock; touching #487's
aggregate cache; dropping force-dynamic; any `redis-cache.ts` edit.
