# Stage 3 BATCH — Zernio transport config migration

_Branch `refactor/audit-stage3-zernio-transport`. Migrates the Zernio HTTP
transport's raw `process.env.*` config reads onto the Stage-2 typed config
accessor (`src/lib/config/server.ts`), following the conventions established by
the email pilot (`2026-06-25-audit-stage3-pilot-email-config.md`) and the
src-lib / worker-pollers / worker-jobs / worker-ingress / serpapi-redis batches.
The serpapi-redis plan listed `zernio/client/transport.ts` as deferred ("Zernio
transport + mock knob") — this is that follow-up._

**Hard rule (campaign-wide): ZERO PRODUCTION behavior change.** Every default,
fallback, truthy check, parse, and throw is preserved byte-for-byte. Every
existing behavior **assertion** is preserved; a test's env-setup *mechanism* is
refactored only where the memoized accessor requires it (convention #6).

## Scope — one file, two reads

`src/lib/zernio/client/transport.ts` reads `process.env` at three sites:

| Line | Read | Decision |
|---|---|---|
| L53 | `if (process.env.MOCK_EXTERNAL_APIS === 'true')` | **EXEMPT (#2)** — env indicator, stays a direct per-call read so mock-mode toggling works. |
| L64 | `options.baseUrl ?? process.env.ZERNIO_API_BASE ?? 'https://zernio.com/api'` | **MIGRATE** → `getServerConfig().ZERNIO_API_BASE`. |
| L65 | `options.apiKey ?? process.env.ZERNIO_API_KEY ?? ''` | **MIGRATE** → `getServerConfig().ZERNIO_API_KEY`. |
| L126 | `Number(process.env.MOCK_ZERNIO_LOCATION_COUNT ?? 1)` in `mockLocations()` | **EXEMPT (mock-fixture knob)** — see below. |

## Lane decision + WHY — dual-runtime → `getServerConfig()` (#4)

The Zernio transport (via the zernio client surface: replies / locations /
profiles) is reached from **BOTH** runtimes:

- **Next routes** — `src/app/api/zernio/connect/*` (the ADR-0001 OAuth-handshake
  exception, which makes short user-blocking Zernio connect/select-location calls
  to set cookies / return a redirect synchronously).
- **The Railway worker** — `worker/jobs/zernio/*` (ingest), `worker/jobs/publisher/*`
  (reply publishing), and account-offboarding teardown.

A shared dual-runtime `src/lib/**` module reads config through
`getServerConfig()` (convention #4). It works in both lanes: `process.env` is
populated at call time in the worker after `worker/env.ts` loads dotenv at boot,
and `serverSchema` covers the two vars.

**Runtime-invocation constraint (#4).** `getServerConfig()` does NOT self-load
dotenv (only `getWorkerConfig()` does). So the read MUST happen at runtime inside
a function, never at module import. The transport already reads these inside
`requestWithOptions` (called per request/job, always after worker boot dotenv),
so the constraint is satisfied. The read is placed **AFTER** the
`MOCK_EXTERNAL_APIS` short-circuit so a pure-mock call still does zero config work.

## The MOCK_ZERNIO_LOCATION_COUNT exemption (final decision: EXEMPT)

`MOCK_ZERNIO_LOCATION_COUNT` (L126) is **not** migrated and the audit must **not**
count it. It is a MOCK-mode fixture knob: read only inside `mockLocations()`,
which is reachable ONLY when `MOCK_EXTERNAL_APIS==='true'` (the transport
short-circuits to its mock branch at L53 before any real call) and is **never
read in production**. It is a sibling to `MOCK_EXTERNAL_APIS` — a local fixture
dial, not subsystem config. Routing it through the production config schema would
add a never-used-in-prod field carrying mock-specific clamp logic (the
`Number.isInteger && >= 1 ? Math.min(raw, MAX) : 1` ceiling) — wrong altitude.

So it stays a direct `process.env` read, and `scripts/ci/process-env-audit.ts`
`isExemptIndicatorName` gains an **EXACT-NAME** match for it (NOT a broad `MOCK_*`
prefix — that would be too wide and would silently exempt genuine config that
merely shares the prefix). A unit test locks the exact-name semantics (a
different `MOCK_*` var still counts).

## Per-line before → after

| Site | Before → After / why |
|---|---|
| import | + `import { getServerConfig } from '@/lib/config/server';` |
| L64 | `options.baseUrl ?? process.env.ZERNIO_API_BASE ?? 'https://zernio.com/api'` → `const cfg = getServerConfig(); … options.baseUrl ?? cfg.ZERNIO_API_BASE ?? 'https://zernio.com/api'`. `options.X` precedence and the `'https://zernio.com/api'` fallback preserved EXACTLY. |
| L65 | `options.apiKey ?? process.env.ZERNIO_API_KEY ?? ''` → `options.apiKey ?? cfg.ZERNIO_API_KEY ?? ''`. The `?? ''` fallback preserved EXACTLY. |
| L62–63 comment | Updated so it stays accurate: MOCK_EXTERNAL_APIS is still read per-call directly (exempt indicator) so toggling works; ZERNIO_API_BASE/ZERNIO_API_KEY now come from the memoized `getServerConfig()` (env immutable in prod → memoized == per-call; per-test overrides reset the memo, #6). |
| L53 | UNCHANGED — direct `process.env.MOCK_EXTERNAL_APIS === 'true'` read (exempt #2). |
| L126 | UNCHANGED — direct `process.env.MOCK_ZERNIO_LOCATION_COUNT ?? 1` read (mock-fixture knob; exempted in the audit). |

## Schema changes (`src/lib/config/server.ts`)

Two NEW fields (not in any schema before this batch), placed near the other
migrated zernio/optional secrets, after `WORKER_PUBLIC_URL`:

- `ZERNIO_API_BASE: rawOpt`
- `ZERNIO_API_KEY: rawOpt`

`rawOptionalVar` (#7) preserves `''` / `'   '` / unset byte-for-byte, so the
`?? 'https://zernio.com/api'` and `?? ''` fallbacks stay behavior-identical to
the old raw `process.env` reads (the collapsing `optionalVar` would map a
whitespace `'   '` to `undefined` and FLIP to the fallback). No asserting
accessor is added — both reads tolerate absence via their own fallbacks (#5). No
new REQUIRED var → `CORE_APP_REQUIRED_VARS`/`SERVER_DB_REQUIRED_VARS` unchanged →
`ci:config-coverage` (audits REQUIRED declarations only) unaffected.

## Test conversions (convention #6 — every assertion preserved; only env-setup changes)

| Test file | Conversion |
|---|---|
| `src/lib/zernio/__tests__/client.test.ts` | The `zernioClient connect contract` describe sets `ZERNIO_API_BASE='https://zernio.test/api'` + `ZERNIO_API_KEY='test-key'` in `beforeEach` and asserts fetch is called with that base URL + `Bearer test-key`. Import `resetServerConfigForTests` from `@/lib/config/server`; call it at the END of `beforeEach` (after the env mutations) and at the END of `afterEach` (after restore) so the next `getServerConfig()` re-parses. Every assertion identical. The `createZernioTransport` and `request() timeout` describes inject options / assert only error kinds, so they are config-independent and untouched; the two `mock mode` describes short-circuit at L53 before the config read. |
| `src/lib/zernio/client/__tests__/transport-mock-location-count.test.ts` | UNCHANGED. It runs in `MOCK_EXTERNAL_APIS='true'` mode (mock short-circuit at L53 before the config read) and never sets `ZERNIO_API_BASE`/`ZERNIO_API_KEY`. `MOCK_ZERNIO_LOCATION_COUNT` stays a DIRECT read, so no memo reset is needed. |
| `e2e/fixtures/__tests__/zernio-fixture-server.test.ts` | UNCHANGED. Runs the non-mock path BUT injects `baseUrl`+`apiKey` via `createZernioTransport({ baseUrl: server.url, apiKey: 'fixture-key' })`, so `options.X` wins and the migrated `cfg.X` read is unused; it saves/restores `ZERNIO_API_BASE` but never sets it to drive config. Stays green with no conversion. (Included in `pnpm test` via the `e2e/**/__tests__/**/*.test.ts` glob — verified.) |

### Added behavior-lock tests (TDD)
- `scripts/ci/__tests__/process-env-audit.test.ts` — `MOCK_ZERNIO_LOCATION_COUNT`
  is NOT counted (exempt), and a different `MOCK_*` var (`MOCK_OTHER_THING`) STILL
  counts (exact-name, not a prefix). Existing cases kept.
- `src/lib/config/__tests__/server.test.ts` — `ZERNIO_API_BASE`/`ZERNIO_API_KEY`
  present-when-set, undefined-when-unset (tolerate-absent, no throw), and
  whitespace-only `'   '` survives verbatim (rawOpt #7 — RED under the collapsing
  `optionalVar`, GREEN under `rawOptionalVar`).

## Baseline (`scripts/ci/process-env-baseline.ts`): 39 → 38 (−1)
**Removed (fully migrated, no remaining counted read):**
`src/lib/zernio/client/transport.ts`. Its only remaining `process.env` reads are
the two exempt indicators (`MOCK_EXTERNAL_APIS` #2, `MOCK_ZERNIO_LOCATION_COUNT`
mock-fixture knob), so the audit no longer counts it. No import-time reader → not
allowlisted. The baseline is regenerated from the audit's own live scan;
`pnpm ci:process-env` confirms the live scan matches the committed baseline (38).

## Conventions applied (full text in the pilot plan)
- **#2** env indicators (`MOCK_EXTERNAL_APIS`) stay direct + uncounted; this batch
  EXTENDS the audit's exempt set with the `MOCK_ZERNIO_LOCATION_COUNT`
  mock-fixture knob (exact-name).
- **#4** lane: dual-runtime shared `src/lib` module → `getServerConfig()`, read
  at RUNTIME inside `requestWithOptions` (after the mock short-circuit).
- **#5** tolerate-absent vars → optional schema fields + the call site's own
  fallbacks; no asserting accessor introduced.
- **#6** test-isolation: `resetServerConfigForTests()` after the connect-contract
  block's env mutations; every assertion preserved.
- **#7** migrated RAW reads use `rawOptionalVar` (faithful `''`/`'   '`/unset
  passthrough) so the `?? <fallback>` chains stay byte-for-byte.

## Deferred (unchanged — still in baseline)
- `costs/tracker.ts` — CRITICAL cost guard, dynamic-key `*_CENTS` reads.
- the `*_ENABLED` flag homes (Stage 4): the 4 pollers, 2 ingress, 4 job files.

## Verify gate
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm ci:tenant-scope &&
pnpm ci:rls-audit && pnpm ci:static-policy && pnpm ci:config-coverage &&
pnpm ci:process-env && pnpm ci:fallow` — all must pass; `pnpm ci:process-env`
reports baseline 38 and the live scan matches.

## Open risks
- The only structural change is moving the two reads onto `cfg = getServerConfig()`
  inside `requestWithOptions`; it is behavior-faithful because env is immutable in
  prod (memoized snapshot == per-call read) and `options.X` precedence + the two
  fallbacks are preserved byte-for-byte. The mock short-circuit still runs FIRST,
  so a pure-mock call does zero config work.
