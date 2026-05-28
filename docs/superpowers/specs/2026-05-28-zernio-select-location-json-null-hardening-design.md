# Zernio select-location: harden JSON-null edge cases + document backfill predicate

**Issue:** [#41](https://github.com/RepWorth/ai-review-responder/issues/41)
**Date:** 2026-05-28
**Branch:** `fix/41-zernio-select-location-json-null-hardening`

## Problem

Three latent items in the Zernio `select-location` finalize path, surfaced
during the PR #38 review. All three are verbatim pre-existing behaviors,
intentionally deferred out of the behavior-preserving split (#38) and logged for
a dedicated PR with tests.

1. **`authorize.ts` — JSON `null` body → 500 instead of 400.** `body = await
   req.json()` then `body.locationId` is read outside the parse `try/catch`. A
   literal `null` request body parses to `null`, so `null.locationId` throws a
   `TypeError` that bubbles to the route's outer catch → **500 `internal_error`**
   instead of a 400. (Scalar non-null bodies like `42`/`"x"`/`true` already
   return 400 today, under code `invalid_location_id` — only `null` 500s.)

2. **`pending-transition.ts` — scalar pending marker → 500 instead of 409.** Same
   shape: `parsedPending = JSON.parse(pendingRaw)` inside the `try`, but
   `parsedPending.flowId` is read outside it. A stored marker of `"null"` parses
   fine, then `null.flowId` throws → outer catch → **500** instead of `409
   malformed_pending_marker`. (Scalar non-null markers currently yield `410
   flow_changed`.) `parsedPending` is already typed `| null`, so the code reads a
   nullable value without the matching null check.

3. **`finalize-tx.ts` — backfill predicate over-fires on reconnect (benign).** The
   `needs_backfill` predicate's clause A (`id != connectionId AND connected_at IS
   NOT NULL`) is always false on a single-row reconnect (the only row is excluded
   by `id != connectionId`), so the predicate fires `true` regardless. The
   re-enqueue is idempotent via the worker's `ON CONFLICT (business_id) DO
   NOTHING` on `zernio_backfill_runs`.

## Decisions

- **Items 1 & 2 — full object guard** (per the issue's proposal, not the minimal
  null-only guard). Routes ALL non-objects to the typed error. Side effect:
  scalar non-null bodies/markers normalize from `invalid_location_id` /
  `flow_changed` to the typed error — arguably more correct, and an acceptable
  wire-behavior change for pathological inputs.
- **Item 3 — document, do not change.** The cost/risk asymmetry favors leaving
  the predicate alone: the bug's blast radius is one redundant outbox row + one
  worker no-op (provably idempotent), whereas a wrong predicate change risks
  **suppressing a legitimate backfill** (silent loss of a customer's review
  history). Clause B intentionally re-fires backfill when "a prior backfill
  auth-failed mid-flight" (`finalize-tx.ts:142-147`); clauses A and B are
  entangled and a gate on pre-update `connected_at` could break that case.
  Additionally, the unit harness mocks `needs_backfill`, so a real fix would
  require a DB-backed integration test — disproportionate effort for a benign
  redundancy.

## Changes

### Fix 1 — `src/app/api/zernio/connect/_shared/finalize/authorize.ts`

After `body = (await req.json()) as SelectLocationBody;` (inside step 3, after the
parse `try/catch`, before reading `body.locationId`):

```ts
if (body === null || typeof body !== 'object') {
  throw new ZernioRouteError(400, 'invalid_body');
}
```

Effect: literal `null` body 500 → **400 `invalid_body`**. Arrays pass the guard
(`typeof [] === 'object'`) and fall through to `invalid_location_id` as today.

### Fix 2 — `src/app/api/zernio/connect/_shared/finalize/pending-transition.ts`

After the `JSON.parse` `try/catch`, before reading `parsedPending.flowId`:

```ts
if (parsedPending === null || typeof parsedPending !== 'object') {
  throw new ZernioRouteError(409, 'malformed_pending_marker');
}
```

Effect: stored `"null"` marker 500 → **409 `malformed_pending_marker`** (matches
the catch-branch code). Also satisfies the already-declared `| null` type so TS
narrowing improves.

### Item 3 — `src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts`

Append one sentence to the existing comment block (lines 142-147) making the
over-fire explicit: clause A intentionally fires on single-row reconnect, and the
worker's `ON CONFLICT (business_id) DO NOTHING` on `zernio_backfill_runs` makes
the redundant enqueue idempotent — reference issue #41. **No predicate change.**

## Tests

Extend `src/app/api/zernio/connect/_shared/finalize/__tests__/finalize-modules.test.ts`
(the existing 39-test unit harness; uses hoisted mocks, `makeRequest(string)`,
and `mockRedis.get.mockResolvedValue(...)`).

- `authorizeSelectLocation`:
  - literal `null` JSON body → 400 `invalid_body` (was 500). Regression guard for item 1.
  - a scalar body (e.g. `'42'`) → 400 `invalid_body` (documents the normalized behavior).
- `transitionPendingToFinalizing`:
  - pending marker `'null'` → 409 `malformed_pending_marker` (was 500). Regression guard for item 2.
  - a scalar marker (e.g. `'42'`) → 409 `malformed_pending_marker`.
- Item 3: no new test. The predicate is mocked in this harness; the doc comment
  is the deliverable. During implementation, grep
  `select-location/__tests__/route.test.ts` to confirm no existing test asserts
  the old `null` → 500 surface that the fix would break.

## Verification

- `pnpm lint && pnpm typecheck && pnpm test` (CI authoritative per CLAUDE.md;
  the worktree is a sibling outside the repo, so local runs are reliable here,
  but CI on the pushed branch remains the source of truth).
- No DB/schema touch → tenant-scope / RLS audits not required.
- Land via PR (`main` is protected; direct pushes rejected).

## Out of scope

- Any change to the `needs_backfill` predicate SQL (item 3 is documentation only).
- Preflight's UUID validation / `invalid_body` parser — the select-location
  locationId parser is intentionally permissive (`authorize.ts:34-37`); not touched.
