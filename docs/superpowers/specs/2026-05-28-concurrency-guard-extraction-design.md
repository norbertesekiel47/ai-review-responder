# Extract `concurrency-guard.ts` from `costs/tracker.ts`

_Date: 2026-05-28 · Tier-2 modularization candidate (`docs/modular-requirement.md` lines 83–90)_

## Problem

`src/lib/costs/tracker.ts` (355 LOC, **13 exports**) bundles three Redis-backed
cost-guard sub-systems, each with its own Lua script:

1. **Cost reservation** — `reserveCost` / `finalizeCost` / `releaseCost` + cache
   helpers. These share `ADJUST_COST_LUA`, `PESSIMISTIC_ESTIMATE_CENTS`, and the
   daily-budget keys; they are one coupled phase machine.
2. **Concurrency slots** — `acquireConcurrencySlot` / `releaseConcurrencySlot`.
   Self-contained: own error class, own Lua, own key helper, own constants.
   Shares **nothing** with the other two.
3. **Regen budget** — `checkRegenBudget`. Also self-contained.

The wide 13-export interface spanning three unrelated concerns is the smell.
`docs/modular-requirement.md` names exactly one clean seam: the concurrency-slot
logic.

## Scope (deliberately narrow)

Extract **only** the concurrency-slot sub-system. Cost-reservation and
regen-budget stay in `tracker.ts` — the spec flags them as borderline and
extracting them risks shallow modules with no consumer benefit. This is a pure
code-move plus a compatibility re-export: **no runtime behavior changes** (same
Lua, same Redis keys, same constants).

Out of scope: splitting regen-budget; migrating `ResponseGeneratorWorker.ts`'s
import (deferred — see Follow-up).

## Design

### New file — `src/lib/costs/concurrency-guard.ts`

A deep module: the per-business generation semaphore. Moved verbatim from
`tracker.ts`:

| Symbol | Visibility |
|---|---|
| `ConcurrencyLimitExceededError` | **exported** |
| `acquireConcurrencySlot(businessId)` | **exported** |
| `releaseConcurrencySlot(businessId)` | **exported** |
| `MAX_CONCURRENCY_PER_BUSINESS = 3` | private |
| `CONCURRENCY_TTL_SECONDS = 300` | private |
| `concurrencyKey(businessId)` | private |
| `ACQUIRE_CONCURRENCY_LUA` | private |

Imports `getCacheRedis` from `@/lib/db/redis-cache`. Public surface = **3
exports**; the key helper, Lua script, and tuning constants stay module-private
(narrow interface, hidden internals).

### `src/lib/costs/tracker.ts` (slimmed to reservation + regen)

- Remove the seven concurrency items above.
- Add one compatibility re-export line, commented as a temporary shim:

  ```ts
  // Compat shim: concurrency moved to ./concurrency-guard. Kept so external
  // consumers (ResponseGeneratorWorker) resolve unchanged. Follow-up: migrate
  // that import and drop this line once the parallel RGW work has landed.
  export {
    acquireConcurrencySlot,
    releaseConcurrencySlot,
    ConcurrencyLimitExceededError,
  } from './concurrency-guard';
  ```

`tracker.ts`'s **external** export surface is unchanged (still resolves all 13
names); internally it now owns only two concerns.

### `src/lib/costs/cost-guard.ts` (deferred — stays on the shim)

This design originally repointed `cost-guard.ts` to import the concurrency
functions directly from `./concurrency-guard`. **During execution that proved
to ripple into consumer tests and was reverted.** `withCostGuard`'s consumers
(`generator.ts`, `review-summary.ts`) have tests that mock only
`@/lib/costs/tracker`; once `cost-guard` sourced the concurrency fns elsewhere,
those tests hit the real `getCacheRedis()` (`"Connection is closed."`). The
compat re-export exists precisely to shield consumers, so `cost-guard` stays on
it like every other consumer. Repointing it — and updating all consumer test
mocks in one pass — is deferred to the follow-up.

### `worker/jobs/ResponseGeneratorWorker.ts` — untouched

It imports `ConcurrencyLimitExceededError` from `tracker`. That resolves through
the re-export, so the file is **not modified** — zero merge conflict with the
in-flight parallel work on that same file.

### Tests

- **New** `src/lib/costs/__tests__/concurrency-guard.test.ts`: move the
  `acquireConcurrencySlot` and `releaseConcurrencySlot` `describe` blocks out of
  `tracker.test.ts`, importing from `../concurrency-guard`. Include the minimal
  mock scaffolding the blocks need: the `ioredis` mock and the
  `REDIS_CACHE_URL` / `REDIS_CACHE_TOKEN` `beforeAll` env setup.
- `tracker.test.ts`: remove those two `describe` blocks. Everything else stays
  (the `reserveCost` / `finalizeCost` / `releaseCost` / `checkRegenBudget` /
  `checkIdempotentCache` blocks, plus the colocated `../audit` tests).

Behavior coverage is preserved; each module is now tested at its own source.

## Why a barrel re-export instead of a full migration

The concurrency symbols have these production consumers: `cost-guard.ts` (the
orchestrator) and `ResponseGeneratorWorker.ts` (being edited by a parallel agent
right now). Editing RGW's import would collide at integration. The re-export
keeps RGW's import valid and untouched, so the two branches don't conflict. As
execution showed (see the cost-guard section), the shim must also shield
`cost-guard.ts` itself — its downstream consumer tests mock only `tracker`. The
shim is explicitly temporary and reversible; all consumers migrate together in
the follow-up.

## Verification

Authoritative gate is the PR's CI runner (this worktree is nested under
`.claude/worktrees/`, where local lint/test module resolution can leak into the
parent — per CLAUDE.md). Local targeted vitest runs are best-effort signal only.

CI must pass all four checks: `lint`, `typecheck`, `test`, `build`. No
DB/schema/tenant-scope change, so `ci:tenant-scope` and `ci:rls-audit` are not
triggered.

## Risk & rollback

Pure code-move + compat shim. Identical Lua, Redis keys, and constants mean no
runtime behavior change. Fully reversible by inlining the symbols back into
`tracker.ts`.

## Follow-up (separate PR, after parallel RGW work lands)

Migrate every consumer off the `tracker.ts` compat re-export and delete it,
fully narrowing `tracker.ts`'s surface. In one pass: repoint `cost-guard.ts`
and `ResponseGeneratorWorker.ts` to import from `./concurrency-guard`, and
update the consumer test mocks (`cost-guard.test.ts`, `generator.test.ts`,
`review-summary.test.ts`) to mock `@/lib/costs/concurrency-guard` for the slot
functions.
