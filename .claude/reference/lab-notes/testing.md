# Lab notes — Testing

## Summary

- **Testing** — vi.hoisted for shared mocks, NextRequest vs Request, relative imports under tsx, compat re-export must shield all consumers (mock-contract), memoized `getServerConfig()` ignores late `process.env` mutation (set env before first access or mock the accessor; `flags.ts` reads live on purpose), `AbortSignal.timeout` runs on Node's internal timers — vitest fake timers can't advance it (real timers + injectable small timeout, #508), module-scope `llmCircuitBreaker` singleton leaks state across suites that mock the SDKs but drive the real `runLlmTask` → `reset()` in `beforeEach` (#515), `app.inject()` NORMALISES the request target so an inject-only suite is structurally blind to anything about the raw request line (absolute-form targets, malformed targets) — a surviving mutant there means dead logic OR a harness blind spot, so reach for a real-socket `net.connect` test before deleting a security-adjacent branch (#644); before merging or reshaping a query, enumerate THREE categories of dependent assertion — tests that (i) count queries, (ii) dispatch on query text, and (iii) IDENTIFY a query by text then constrain its contents; (iii) is the one that bites, and never verify a type-level guarantee by grepping for the enclosing function name (TS anchors structural-assignability errors at the offending literal and names the TYPES — `TS2741` one missing property, `TS2739` several) (#731, 2026-08-09); when an eval task widens a shared DTO fixture, **grep the TYPE name, not the fixture helper's name** — a second `SendLaneView` construction site in another suite broke typecheck the instant the interface grew, and it also voided a deviation's worktree-overlap analysis; TypeScript's excess-property check (`TS2353`) reports only the FIRST offending key, so a plan prescribing one `@ts-expect-error` per added field is wrong — the second is `TS2578` unused-directive (#860, 2026-08-18); **a suite that says it "mirrors" another may mirror it at the WRONG LEVEL** — mocking `requireAdminWithAal2` instead of the auth PRIMITIVES the sibling mocks left six tests dead the moment the route called a different function in that module (ESM internal calls bypass a mocked export), and the sibling testing the same change passed untouched; treat a "mirrors X" comment as a claim to verify, and when behaviour MIGRATES into a dependency the test that owns it must follow rather than stub the new seam (#898, 2026-08-21); **the base-tier e2e auth harness (staging Auth + local docker DB) cannot sign an owner into ANY `/dashboard/*` page** — `readSelf()` and the auth callback resolve the `users` row through PostgREST against the Auth project's own database — so signed-in owner-page evidence is captured on a throwaway local Supabase stack and the owner-page specs self-skip under the base tier (#1273, 2026-09-13)

## Canonical entries

_None yet — the Summary bullet is the current rule; see History for the dated evidence._

## History

- history/2026-05.md § "`vi.mock` factory hoisting — use `vi.hoisted` for shared mock state"
- history/2026-05.md § "`new Request()` has no `.cookies` — use `NextRequest` in route tests"
- history/2026-05.md § "`tests/llm-eval/*` must use relative imports, not the `@/` alias"
- history/2026-05.md § "A `vi.mock` path is relative to the TEST file, not the module under test"
- history/2026-05.md § "A dynamic `await import('./x')` is still type-checked — it can't forward-reference a missing module"
- history/2026-05.md § "The queue-Proxy `sql` mock needs its call index reset on re-seed within a test"
- history/2026-06.md § "Mocking Postgres.js `sql` in a Vitest unit: `vi.mocked(sql)` keeps the typed tagged-template signature"
- history/2026-06.md § "A committed `tsx` launcher can't use top-level await (repo is CJS)"
- history/2026-06.md § "Running the real worker locally against isolated infra (mocks OFF) without touching shared services"
- history/2026-06.md § "Approving a draft headlessly (no browser/CSRF) → `approveBySession`"
- history/2026-07.md § "[2026-07-20] `AbortSignal.timeout` runs on Node's internal timer list — vitest fake timers cannot advance it → test with real timers + an injectable small timeout"
- history/2026-07.md § "[2026-07-21] A module-scope breaker singleton accumulates state across vitest cases that mock the SDKs but drive the real seam — reset it in `beforeEach`"
- history/2026-08-08.md § "[2026-08-08] #679 — a JS `throw` does not poison a Postgres transaction, so JS-thrown abort injections cannot test savepoint recovery"
- history/2026-08-08.md § "[2026-08-08] #694 — a `get`-only Proxy over a Postgres.js client must forward `begin`'s LEADING arguments"
- history/2026-08-09-to-12.md § "[2026-08-09] #730 — a composable SQL fragment's BUILD calls break every ordered-mock double downstream of it"
- history/2026-08-21-to-31.md § "[2026-08-22] A restraint-policy fixture with a hard-coded date is a time bomb, not a constant"
- history/2026-08-21-to-31.md § "[2026-08-22] Any fixture meaning "already happened today" must be pinned inside the UTC day"
