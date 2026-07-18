# Standards & Maintainability Review — `perf/478-cache-kpi-dashboard`

Reviewer role: standards & maintainability (review-only, no edits).
Base: `main` · Review method: `thermo-nuclear-code-quality-review` skill, plus
`.claude/CLAUDE.md` + `.claude/rules/*.md` + codebase-design deep-module discipline
+ Fowler code-smell baseline.

## Scope reviewed

- `src/lib/kpi/service.ts` — 45s fail-open read cache added to `getLocationKpiSummary` + `getAccountKpiSummary`.
- `src/lib/dashboard/service.ts` — 45s fail-open read cache added to `getActiveDashboardData`; compute extracted to private `buildActiveDashboardData`.
- Tests: `src/lib/kpi/__tests__/service.cache.test.ts` (new), `service.test.ts`; `src/lib/dashboard/__tests__/service.cache.test.ts` (new), `service.feed-projection.test.ts`, `service.rating-breakdown.test.ts`; `src/app/api/dashboard/__tests__/route.test.ts`.
- Precedent compared against: `src/lib/dashboard/aggregate-service.ts` (the #487 fail-open cache block this PR mirrors).

## Overall verdict

Solid, low-risk change that faithfully follows the #487 aggregate-service
precedent. Interfaces are unchanged (public signatures identical — the cache is
fully information-hidden behind `getActiveDashboardData` / `get*KpiSummary`), the
`buildActiveDashboardData` extraction is a clean orchestration/compute split, and
the test coverage is genuinely good (HIT / MISS / GET-throws / SET-throws /
key-variation / 404-not-cached / JSON round-trip fidelity). No tenant-scope,
no-`any`, no string-literal-enum, no boundary (Vercel-UI-only) regressions.

One structural finding worth raising: the fail-open read-through cache block is
now duplicated a fourth time and the sites are structurally identical, so this is
the point where the codebase's own "extract on the second concrete use case" rule
argues for a deep helper rather than more copies. Details below.

---

## Findings

### MAJOR — Fail-open read-through cache block is now copy-pasted across 4 functions in 3 files (DRY / single-owner)

**Standard violated:** `engineering.md` — "Keep one authoritative representation
for each piece of system knowledge… choose one owner and derive the rest"; the
thermo-nuclear rule "Copy-pasted logic instead of extracted helpers"; and
`repworth.md` "Approval-and-modification posture" / "Never do → wait for the
**second** concrete use case before extracting" (we are now at the fourth).

The identical read→parse→fail-open-log / compute / write→fail-open-log skeleton
now lives in:

- `src/lib/dashboard/aggregate-service.ts:73-96` (`getAggregateDashboardData`, precedent)
- `src/lib/dashboard/service.ts:86-113` (`getActiveDashboardData`, new)
- `src/lib/kpi/service.ts:160-259` (`getLocationKpiSummary`, new)
- `src/lib/kpi/service.ts:267-372` (`getAccountKpiSummary`, new)

The four copies differ only in three parameterizable ways:

1. the log-prefix string (`[dashboard/aggregate]` / `[dashboard/service]` / `[kpi]`),
2. the compute call being wrapped,
3. aggregate's conditional-write predicate (`partialFailures.length === 0`).

Those are exactly the arguments a single helper would take, e.g.

```ts
async function cacheReadThrough<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
  opts?: { logPrefix?: string; shouldCache?: (value: T) => boolean },
): Promise<T>
```

**Why this clears the deep-module bar (not a thin wrapper):** the helper *hides*
real complexity — Redis `get`/`set`, JSON encode/decode, the fail-open try/catch
semantics, and TTL — behind a semantic interface. That is precisely the
"pull complexity downward" move `design.md` favors, not the identity/pass-through
wrapper the rules warn against. Inlining does **not** make the call site clearer
here (the `repworth.md` inlining test): the boilerplate obscures the single line
that actually differs (the compute call).

**Maintainability cost of leaving it:** the fail-open contract now has four
owners. Any future change to that contract — adding jitter, emitting a
cache-hit/miss metric, switching `console.error` to a structured logger, adding
stale-while-revalidate, or fixing a serialization edge case — must be found and
applied in four places, and a missed site is a silent divergence. This is the
classic change-amplification smell.

**The deliberate-inline defense, judged on merits:** the branch chose to inline
citing "3 non-identical sites + precedent bias." The sites are non-identical only
in the three parameters above, all of which a helper cleanly absorbs; the *shape*
is identical. And the codebase's own extraction threshold (second concrete
caller) is now exceeded twofold. So the defense is weak. This does not block
correctness, but a maintainability reviewer should push for the extraction now,
while all four callers are fresh, rather than after a fifth copy appears.

**Recommended remedy:** introduce one `cacheReadThrough` helper (natural home:
`src/lib/db/redis-cache.ts`, which already owns the cache client) and reduce all
four call sites to `return cacheReadThrough(key, TTL, () => build…(…), opts)`.
Net deletion of ~40-50 lines and a single owner for the fail-open semantics.

---

### MINOR — `[kpi]` log prefix breaks the `dir/file` convention of the sibling cached modules

**Standard weighed:** log-prefix consistency with the aggregate-service precedent
(explicitly called out in the review brief).

`aggregate-service.ts` and `dashboard/service.ts` use path-style prefixes
(`[dashboard/aggregate]`, `[dashboard/service]`). The new `kpi/service.ts` cache
logs use `[kpi]` (module dir only) at lines 168, 256, 275, 369. For a file that
is literally `src/lib/kpi/service.ts`, the convention-consistent prefix is
`[kpi/service]`, which also keeps grep-by-prefix uniform across the three cached
services.

This is genuinely low-severity and internally consistent (all four kpi logs agree
with each other), and `[kpi]` is unambiguous today, so it is defensible — but it
is a small, free consistency win while the code is being touched. Left out of the
high-confidence table on severity grounds.

---

## Checks that passed (no finding)

- **Deep-module / interface stability:** public signatures of all three cached
  functions are unchanged; the cache leaks nothing to callers. Good information
  hiding. The `buildActiveDashboardData` extraction is a clean compute/orchestration
  separation, not a temporal-coupling `prepare/process` split.
- **Cache-key correctness:** `dashboard:location:<biz>:<window>:<rep|norep>` correctly
  excludes `opts.business` (a query-skip optimization, not an output-varying input),
  with a comment and a dedicated test asserting the key never varies by it. KPI keys
  are correctly namespaced by scope (`kpi:location:` vs `kpi:account:`).
- **Tenant safety:** payloads are location/account-scoped, not user-scoped; the
  route authorizes the `businessId`/`accountId` before calling, so the shared cache
  entry cannot become a cross-tenant vector. The intentional cross-owner sharing is
  documented.
- **404 not cached:** `BusinessNotFoundError` throws inside the compute before the
  `set`, so the not-found signal is never pinned — verified by test.
- **No-`any`:** `JSON.parse(cached) as T` matches the sanctioned precedent; the
  round-trip fidelity test guards the `Date | string` union field
  (`autoPostScheduledAt`). No new `any`.
- **Fail-open error handling:** every `get`/`set` is wrapped; the catch logs and
  continues — this is the intended pattern here, not a silent swallow (the error
  object is logged with context).
- **TTL constant naming:** `KPI_CACHE_TTL_SECONDS` / `DASHBOARD_LOCATION_CACHE_TTL_SECONDS`
  mirror `AGGREGATE_CACHE_TTL_SECONDS` — consistent.
- **File size:** both files remain well under 1k lines (kpi 373, dashboard 525).
- **No boundary regression:** no `openai`/`bullmq`/`postgres`-singleton imports added;
  `sql: Sql` still passed in (invariant #15 respected).

---

## Low-confidence appendix (speculative "might be nicer", < 80%)

- **No write-path invalidation (accepted staleness).** These are pure-TTL caches
  with no bust on the events that change the numbers (a new review, an approval
  changing response-rate/TTR). Owners can see up-to-45s-stale KPI/dashboard values.
  This is inherited from and consistent with the aggregate precedent and is
  explicitly a product-accepted tradeoff in the comments — noting only for
  completeness, not as a defect.
- **`Date` → `string` drift on cache HIT.** `autoPostScheduledAt` may be a `Date`
  on a fresh compute and a `string` on a cached read. The type is already
  `Date | string | null`, so the contract is not violated and consumers already
  handle both; the round-trip test locks the serialization. No action needed, but
  a downstream consumer that ever does `instanceof Date` would behave differently
  cache-hot vs cache-cold — worth a grep if that field grows consumers.
- **Two `getCacheRedis().get` calls per MISS.** On a dashboard MISS the redis
  client is hit twice (payload key + the `readPendingMarker` inside the compute).
  Harmless (different key namespaces), just noted since the test comment flags it.
