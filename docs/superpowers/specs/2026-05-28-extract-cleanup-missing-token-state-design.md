# Design: Extract & test `cleanupMissingTokenState` (callback consistency)

- **Issue:** [#39](https://github.com/RepWorth/ai-review-responder/issues/39) — Follow-up: extract & test `cleanupMissingTokenState`
- **Date:** 2026-05-28
- **Blocked by:** #37 (split connect callback route) — **merged 2026-05-21**, unblocked.
- **Scope decision:** Pure extraction + tests. Behavior-preserving only. No deduplication of the near-twin `cleanupAfterOauthDenial`.

## Problem

During the tier-1+2 modularization (#37), the Zernio connect **callback** route was decomposed into `_shared/callback/` modules. One cleanup helper — `cleanupMissingTokenState` — was left inline in `src/app/api/zernio/connect/callback/route.ts` (lines 69–136) to keep that PR's scope tight.

Two consequences flagged in review:

1. **Asymmetry.** Its sibling cleanup, `cleanupAfterOauthDenial`, is already extracted to `_shared/callback/oauth-denial.ts` with its own module test. `cleanupMissingTokenState` is the odd one out — a ~68-line, 5-branch function still sitting inline.
2. **Thin coverage.** It is exercised by exactly one happy-path route-level case (`callback/__tests__/route.test.ts:212`). Its failure and gate branches are untested.

## Non-goals

- **No deduplication.** `cleanupMissingTokenState` and `cleanupAfterOauthDenial` are *near*-twins, not identical. They differ in (a) **operation order** — missing-token deletes `profile_state` early and `deleteProfile` last; oauth-denial does `deleteProfile` first and `profile_state` last — and (b) **error-handling granularity** — missing-token uses per-call `.catch()` with rich contextual warn logs, oauth-denial uses a coarse try/catch. Merging them would change the behavior of the already-shipped oauth-denial path and risk the subtle ordering differences. Out of scope for this issue.
- **No change to the route's choreography, redirect codes, or the `missing_params` surface.**
- Leaving `cleanupOrphanedProfileBestEffort`, `stateFromProfileId`, and `connectTokenFromState` inline in `route.ts` — they are not part of this issue.

## Design

### Module boundary & file layout

Mirror the existing `oauth-denial.ts` twin. Both modules are named for the *trigger condition* that calls them.

| File | Change | Detail |
|---|---|---|
| `src/app/api/zernio/connect/_shared/callback/missing-token.ts` | **new** | Exports `cleanupMissingTokenState(state: string): Promise<void>`, moved verbatim from `route.ts:69-136`. Imports it currently uses: `getCacheRedis`, `pendingKey`, `stateKey`, `profileStateKey`, `luaDeletePendingByFlowIdAnyStatus`, and the `ConnectStateBlob` / `ConnectPendingMarker` types. |
| `src/app/api/zernio/connect/_shared/callback/__tests__/missing-token.test.ts` | **new** | Branch-point unit tests, structured exactly like `oauth-denial.test.ts`. |
| `src/app/api/zernio/connect/callback/route.ts` | **changed** | Add `import { cleanupMissingTokenState } from '../_shared/callback/missing-token';`. Delete the inline function (lines 69–136). Remove the now-unused imports it leaves behind. |

### Behavior preservation

The function body moves character-for-character:

- Same operation order: `getdel(stateKey)` → `del(profileStateKey)` early → `get(pendingKey)` → gate → `eval(luaDeletePendingByFlowIdAnyStatus)` → `deleteProfile` last.
- Same per-call `.catch()` logging with `state` / `business` / `profile` context.
- Same best-effort semantics: the function never throws; every Redis/Zernio call is individually guarded.
- The `missing_params` redirect and the `if (state) await cleanupMissingTokenState(state)` call site stay in `route.ts`, unchanged.

### Import cleanup in `route.ts`

After extraction, these imports are used *only* by the moved function and must be removed from `route.ts` (else `pnpm lint` fails on no-unused-vars):

- `pendingKey` — remove
- `stateKey` — remove
- `luaDeletePendingByFlowIdAnyStatus` — remove
- `ConnectStateBlob` (type) — remove
- `ConnectPendingMarker` (type) — remove

**Keep** (still referenced elsewhere in `route.ts`):

- `getCacheRedis` — used by `stateFromProfileId`
- `profileStateKey` — used by `stateFromProfileId`

ESLint is the authoritative guard that this list is correct.

## Test plan

### New module test — `missing-token.test.ts`

Reuse the `oauth-denial.test.ts` harness: `vi.hoisted` `redisData` `Map<string,string>`, a mocked `@/lib/db/redis-cache` (`getdel` / `get` / `del` / `eval`), a mocked `@/lib/zernio/client` (`deleteProfile`), and a `seed()` helper that plants `connect_state:{state}`, `connect_pending:{businessId}`, and `connect_profile_state:{profileId}`.

| # | Case | Expectation |
|---|---|---|
| 1 | Happy path: state blob + matching pending | `connect_profile_state` deleted, pending CAS-deleted (`eval` called with the flowId), `deleteProfile(profileId)` called |
| 2 | state `getdel` returns null (no blob) | early return; `deleteProfile` **not** called; `eval` **not** called |
| 3 | state `getdel` **rejects** | error swallowed → treated as no blob; no throw; no `deleteProfile` |
| 4 | malformed state blob (`JSON.parse` throws) | early return after `getdel`; no `deleteProfile`; no `eval` |
| 5 | pending gate: `state` or `profileId` **mismatch** | `eval` **not** called; `deleteProfile` still called |
| 6 | malformed pending blob | `eval` **not** called; `deleteProfile` still called |
| 7 | `eval` (CAS-delete) **rejects** | swallowed; `deleteProfile` still called; no throw |
| 8 | `deleteProfile` **rejects** | swallowed; `await expect(...).resolves.toBeUndefined()` |

### Existing route test — unchanged

`callback/__tests__/route.test.ts:212` ("cleans up the pending flow when callback has state but no connect token") stays **as-is**. After extraction it serves as the integration/wiring smoke: `GET` → calls `cleanupMissingTokenState` → redirects `error=missing_params` and the cleanup side effects occur. Branch depth now lives in the module test; no route test is deleted.

## Verification

- `pnpm lint` — confirms the `route.ts` import cleanup is complete and correct.
- `pnpm typecheck` — confirms the new module + import wiring type-check.
- `pnpm test` — runs the new `missing-token.test.ts` plus the untouched route test.

No DB/schema/tenant-scope surface is touched, so `ci:tenant-scope` / `ci:rls-audit` are not implicated by this change.

## Risks

- **Low.** Behavior-preserving move of a self-contained, side-effect-only function into a sibling file that already has an established pattern. The only failure mode is a missed/over-eager import edit in `route.ts`, caught by lint + typecheck before merge.
