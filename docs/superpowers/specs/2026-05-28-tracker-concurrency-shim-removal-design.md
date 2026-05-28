# Remove the `tracker.ts` concurrency re-export shim

**Date:** 2026-05-28
**Status:** Approved (design)
**Follow-up to:** PR #130 (concurrency-guard extraction), `docs/modular-requirement.md`

## Problem

PR #130 extracted the concurrency-slot sub-system from `src/lib/costs/tracker.ts`
into `src/lib/costs/concurrency-guard.ts`, but left a 4-line compat re-export in
`tracker.ts` so consumers resolved unchanged:

```ts
export {
  acquireConcurrencySlot,
  releaseConcurrencySlot,
  ConcurrencyLimitExceededError,
} from './concurrency-guard';
```

The shim means the three concurrency symbols have **two import paths**
(`tracker` and `concurrency-guard`). That is the smell `modular-requirement.md`
flags. The precondition for removal — the parallel `ResponseGeneratorWorker`
modularization (PR #128) — has landed, so the shim can be deleted.

## Goal & invariant

Make `concurrency-guard.ts` the **single authoritative source** for the three
concurrency symbols and delete the re-export from `tracker.ts`.

**Hard invariant: behavior must not change.** This is import-path surgery only.
No Lua scripts, Redis keys, function signatures, or control flow change.

**The trap (why the last attempt was BLOCKED, memory obs 2355 + lab-note 2437,
"compat re-export must shield ALL consumers"):** several test files mock the
*whole* `tracker` module — including the slot fns — to intercept calls made
**transitively** through `withCostGuard` (in `cost-guard.ts`). When `cost-guard`
stops importing the slot fns from `tracker`, those stubs go dead and the real
`concurrency-guard` → real Redis path runs. So **every** production repoint must
be paired with its test's mock-target move in the same change, including the
transitive tests whose subject never imports a concurrency symbol directly.

## Corrected consumer map

The follow-up note in `modular-requirement.md` was written before PR #128 and
under-counts consumers. The actual graph (verified 2026-05-28):

### Production source — repoint (2 files)

| File | Concurrency symbols it imports from `tracker` | Action |
|---|---|---|
| `src/lib/costs/cost-guard.ts` | `acquireConcurrencySlot`, `releaseConcurrencySlot` | split: slot fns ← `./concurrency-guard`; `reserveCost`/`finalizeCost`/`releaseCost` stay `./tracker` |
| `worker/jobs/response-generation/generate-draft.ts` | `ConcurrencyLimitExceededError` | split: error ← `…/concurrency-guard`; `CostLimitExceededError`/`GlobalCostLimitExceededError`/`RegenBudgetExceededError`/`checkRegenBudget`/`setCachedGeneration` stay `…/tracker` |

`src/lib/responses/generator.ts` imports **only** cache fns
(`checkIdempotentCache`/`clearCachedGeneration`/`setCachedGeneration`) from
`tracker` — those stay. **No source change**, but its test breaks (transitive).

### Test mocks — update (5 files)

Each adds a `vi.mock('…/concurrency-guard', …)` for the slot fns and/or
`ConcurrencyLimitExceededError`, and removes the now-dead concurrency stubs from
its `tracker` mock (the cost / cache / regen stubs stay).

| File | Why it mocks concurrency | Currently mocks via |
|---|---|---|
| `src/lib/costs/__tests__/cost-guard.test.ts` | direct subject (`withCostGuard`) | `tracker`: slot fns + `ConcurrencyLimitExceededError` |
| `src/lib/responses/__tests__/generator.test.ts` | transitive via `withCostGuard` | `tracker`: slot fns + `ConcurrencyLimitExceededError` |
| `src/lib/responses/__tests__/review-summary.test.ts` | transitive via `withCostGuard` | `tracker`: slot fns |
| `worker/jobs/__tests__/ResponseGeneratorWorker.test.ts` | transitive via `generate-draft` | `tracker`: `ConcurrencyLimitExceededError` |
| `worker/jobs/response-generation/__tests__/generate-draft.test.ts` | direct subject | `tracker`: `ConcurrencyLimitExceededError` + cost/regen |

The doc named only `cost-guard.test.ts`, `generator.test.ts`,
`review-summary.test.ts`. The two worker tests
(`ResponseGeneratorWorker.test.ts`, `generate-draft.test.ts`) are **additions**
this spec surfaces.

`src/lib/costs/__tests__/concurrency-guard.test.ts` already imports
`concurrency-guard` directly — **untouched**.

### Shim deletion

Remove the comment + 3-symbol re-export block from `src/lib/costs/tracker.ts`
(currently lines ~3–10). After this, `tracker.ts` exports only cost-reservation,
cache, and regen-budget symbols.

## Verification

`pnpm lint && pnpm typecheck && pnpm test` is the gate.

- The transitive tests (`generator`, `review-summary`) are the **canary**: a
  missed slot stub fails by attempting a real Redis call, not silently.
- A repo-wide grep must show **zero** concurrency-symbol imports from any
  `tracker` path after the change.
- No SQL/query text changes, so `ci:tenant-scope` / `ci:rls-audit` are not
  required (they will run in CI regardless — cheap, expected no-op).

**Authoritative gate is pushed CI**, not local runs. This work happens in a
worktree nested under `.claude/worktrees/`; per CLAUDE.md, nested-worktree
lint/test runs are unreliable (module resolution leaks into the parent
`node_modules`). Push the branch and read the GitHub runner.

## Workflow

Isolated git worktree on a branch cut fresh from `origin/main`; land via PR with
the 4 CI checks (lint, typecheck, test, build) green.

## Done-when

1. Two production files repointed; `generator.ts` unchanged.
2. Five test files mock `concurrency-guard` for the symbols they exercise; dead
   `tracker` concurrency stubs removed.
3. Re-export block deleted from `tracker.ts`.
4. Grep shows no concurrency-symbol imports from `tracker`.
5. CI green on the PR.
6. `docs/modular-requirement.md` updated to mark the follow-up done; lab-note
   added if any non-obvious snag surfaces.

## Out of scope

The full 13-export split of `tracker.ts` (cost-reservation and regen-budget
sub-systems stay together). `modular-requirement.md` explicitly cautions against
it; this spec removes only the single named seam's shim.
