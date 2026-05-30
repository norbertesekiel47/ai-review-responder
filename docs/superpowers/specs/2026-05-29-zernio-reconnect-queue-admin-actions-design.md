# Design — Zernio reconnect-queue admin actions (#23b)

> **Source:** `docs/launch-ready-part2.md` → "Prioritized fix list" → P1 item **#23b**
> (the deferred half of #23; #23a — admin payment-success polling cleanup — shipped in PR #180).
> **Branch/worktree:** `worktree-launch-yellow-23b-zernio-queue-actions` (branched fresh from `origin/main`).
> **Predecessor specs that deferred this:** `2026-05-29-launch-p1-polish-19-23-design.md` (§ "Explicitly deferred"),
> `2026-05-29-launch-yellow-polish-design.md` (§ "Scope decision").

## Problem

The admin business-detail page renders `ZernioConnectionPanel.tsx`, which lists responses parked at
`awaiting_owner_connect` (owner-**approved** drafts that cannot publish because the business's Zernio
connection is missing/disconnected) and unresolved finalize incidents. The queue is **read-only** — the
only mutation on the panel is the business-level "Manually disconnect" button.

A `TODO(zernio)` at `ZernioConnectionPanel.tsx:236` marks the gap: admins have no way to (a) re-attempt
publishing for a business whose connection is healthy again but whose queue is still stuck, or (b) discard
a stale parked draft that will never publish. Both are real ops escape hatches; neither has a backend today.

## Scope

**In scope**

- One new admin-only route exposing two actions: **`force_drain`** (business-scoped) and **`dismiss`** (per-response).
- Wiring two action surfaces into `ZernioConnectionPanel.tsx` (replacing the `TODO(zernio)` comment).
- Tenant-scope allowlist entries for the new cross-tenant SQL.
- Route + component tests.

**Out of scope**

- No schema migration — `awaiting_owner_connect`, `superseded`, and the `drain_pending_owner_connect`
  outbox topic all already exist.
- No restyle of the admin panel to the marketing island. The admin Console is internal tooling; new
  controls match the existing plain-Tailwind button style already on the panel
  (`rounded border border-gray-300 bg-white px-3 py-1.5 …`).
- No changes to the auto-drain-on-reconnect path (`finalize-tx.ts`) or `DrainOwnerConnectWorker` — they
  are reused as-is.
- No per-response "retry publish" (decided against: it duplicates the worker's re-enqueue logic and adds a
  second code path that can drift from the auto-drain; business-level force-drain covers the need).

## Background — the mechanisms being reused

- **Park:** `src/lib/publishing/zernio-publisher.ts` sets a response to `awaiting_owner_connect` when a publish
  attempt hits a Zernio auth/connection failure. This is the only writer of that status.
- **Auto-drain on reconnect:** when an owner (re)connects, `src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts`
  inserts one `drain_pending_owner_connect` outbox row (`payload: { business_id, kind: 'drain' }`) in the same tx
  as the connection flip. `DrainOwnerConnectWorker` then bulk re-enqueues a `publish_response` outbox row for
  **every** `awaiting_owner_connect` response of that business, guarded by an application `NOT EXISTS` check and a
  DB partial-unique `ON CONFLICT DO NOTHING` (migration 026). Repeat drains are therefore idempotent.
- **Supersede a parked draft:** `src/lib/reviews/process-review.ts` already transitions a parked response to
  `superseded` (with a `posting_error` marker) when the underlying review changes. `superseded` is the
  established terminal "give up on this draft" status (`src/lib/shared/response-status.ts`).
- **Admin-mutation template:** `/api/admin/billing/grant-extension` and `/api/admin/flagged` (POST) establish the
  canonical chain — `assertSameOrigin` → `requireRole('admin')` → AAL2 step-up (`requireCurrentAal2FromSupabase`)
  → Zod parse → single `sql.begin` tx that does `SELECT … FOR UPDATE` → mutate → enqueue outbox → `writeAccountAuditLog`,
  all atomic.

## Architecture

### Route

`POST /api/admin/businesses/[id]/zernio-queue/route.ts` — a sibling of the existing
`/api/admin/businesses/[id]` GET/PATCH, so `businessId` arrives as the path param `[id]`.

Request body (discriminated on `action`, validated by Zod):

```ts
{ action: "force_drain" }
{ action: "dismiss", responseId: <uuid> }
```

Guard chain (identical order to `grant-extension`/`flagged`):

1. `assertSameOrigin(request)` → `403 forbidden` on `SameOriginError`.
2. `requireRole(request, 'admin')` → `AuthError` → `{401|403}`.
3. `requireCurrentAal2FromSupabase(mfaClientForRequest(request))` → `403` if not stepped-up. **Both actions
   require AAL2** — it is the established bar for admin state-mutations (grant-extension requires it for a pure
   write), and these actions touch customer publishing state.
4. `request.json()` → `400 invalid_body` on parse failure; Zod `safeParse` → `400` with the first issue.
5. Dispatch on `action` inside one `sql.begin` tx (below).

Responses: `200 { ok: true, action, … }` on success; typed `4xx` codes per failure; `500 internal_error` on
unexpected error (logged via `console.error('[api/admin/businesses/[id]/zernio-queue] …')`). All responses carry
`Cache-Control: no-store, private`.

### `force_drain` (business-scoped)

**Feature-flag gate:** allowed only when `ZERNIO_PUBLISHING_ENABLED === 'true'` (it triggers publishing).
Else `503 feature_disabled` — matching `/api/zernio/disconnect`.

Inside the tx:

1. `SELECT status FROM zernio_connections WHERE business_id = ${businessId} ORDER BY created_at DESC LIMIT 1 FOR UPDATE`.
   - No row, or `status !== 'active'` → throw `409 connection_not_active`. Draining a dead connection only re-parks
     everything (the publisher would fail again), so we fail fast and tell the admin to wait for the owner reconnect.
2. `SELECT COUNT(*)::int FROM responses WHERE business_id = ${businessId} AND status = 'awaiting_owner_connect'`.
   - `0` → throw `409 queue_empty` (nothing to drain).
3. `INSERT` one `drain_pending_owner_connect` outbox row — **identical shape to `finalize-tx.ts`**, with
   `payload: { business_id, kind: 'drain', source: 'admin_force_drain', correlation_id }`. No dedup on this row:
   `DrainOwnerConnectWorker` is idempotent, so duplicate clicks are harmless.
4. `writeAccountAuditLog({ accountId, actorUserId: admin.id, eventType: 'zernio_queue_force_drained',
   entityType: 'business', entityId: businessId, payload: { stuck_count } }, tx)`. `accountId` is resolved from
   `businesses` inside the tx.

Returns `200 { ok: true, action: 'force_drain', queued: stuck_count }`.

**Invariant #3 (no auto-posting) is preserved:** `awaiting_owner_connect` is a *post-approval* status — the owner
already approved these drafts; they are parked only on the publish side. Force-drain unsticks publishing; it never
creates a path from generation to Google that skips approval. The downstream `ResponsePublisherWorker` also keeps its
own subscription guard (invariant #11), so a `past_due`/`pending_payment` account still won't post.

### `dismiss` (per-response, terminal)

Not flag-gated — discarding a stale draft is valid cleanup even if publishing is disabled.

Inside the tx:

1. `SELECT id, account_id … FOR UPDATE WHERE id = ${responseId}::uuid AND business_id = ${businessId} AND status = 'awaiting_owner_connect'`
   (account_id resolved via join to `businesses`, or a separate lookup).
   - No row → throw `409 not_awaiting`. This single guard covers wrong-business, already-posted, already-superseded,
     and unknown-id, without leaking which.
2. `UPDATE responses SET status = 'superseded', posting_error = 'admin_dismissed_awaiting_connect', updated_at = NOW()
   WHERE id = ${responseId}::uuid AND status = 'awaiting_owner_connect'` — same terminal transition `process-review.ts`
   uses for parked drafts. The response drops out of the drain (worker only selects `awaiting_owner_connect`), the
   panel queue, and the "handled" KPI set.
3. `writeAccountAuditLog({ accountId, actorUserId: admin.id, eventType: 'zernio_queue_response_dismissed',
   entityType: 'response', entityId: responseId, payload: { response_id: responseId } }, tx)`.

Returns `200 { ok: true, action: 'dismiss' }`.

### UI — `ZernioConnectionPanel.tsx`

Replaces the `TODO(zernio)` comment block. Styling matches the existing panel buttons (plain Tailwind, not the
marketing island).

- **Queue section header:** a **"Force drain queue"** button, rendered only when `connection.status === 'active'`.
  When not active, render a one-line muted hint instead ("Drain becomes available once the owner reconnects Zernio.").
  On click: `POST … { action: 'force_drain' }`; on success call `onChanged()` (→ `invalidate` refetch).
- **Each queued row:** a small **"Dismiss"** button. On click: `window.confirm("Permanently discard this queued
  reply? It will not post to Google.")`, then `POST … { action: 'dismiss', responseId }`; on success `onChanged()`.
- Per-action pending state (disable the in-flight button + label change) and an inline error line reusing the panel's
  existing red error treatment. A failed action surfaces the server `error` code as a human-readable message.

The panel already receives `businessId`, `zernio`, and `onChanged`; no prop changes needed. The `connection.status`
union in `types.ts` (`'pending' | 'active' | 'disconnected'`) already carries what the gate needs.

## Cross-cutting concerns

- **Tenant-scope allowlist (`scripts/ci/tenant-scope-allowlist.ts`):** the new route's SQL is intentionally
  cross-tenant (an admin acts on any business). Add allowlist entries for: the connection-status `SELECT`, the
  stuck-count `SELECT`, the `account_id` lookup, the `dismiss` `UPDATE`, and the `drain_pending_owner_connect`
  `INSERT`. Verify with `pnpm ci:tenant-scope`. (Existing entries at lines ~1002/1224 already allowlist similar
  `awaiting_owner_connect` admin reads and the drain CTE — these are the pattern to follow.)
- **RLS audit (`pnpm ci:rls-audit`):** no new tables; should be unaffected. Run to confirm.
- **Logging:** route uses `console.error` with the route prefix on the 500 path (Next.js route, not a worker —
  matches sibling admin routes). No raw review/response text is logged.
- **Idempotency:** `force_drain` relies on `DrainOwnerConnectWorker`'s existing triple-guard; `dismiss` is naturally
  idempotent via the `status = 'awaiting_owner_connect'` predicate (a second dismiss hits `409 not_awaiting`).

## Failure-mode table

| Action | Condition | Result |
|---|---|---|
| any | not same-origin | `403 forbidden` |
| any | not admin | `401 unauthorized` / `403 forbidden` |
| any | not AAL2 | `403` (`aal.reason`) |
| any | bad/missing body or bad action | `400 invalid_body` / `400 invalid_request` |
| force_drain | `ZERNIO_PUBLISHING_ENABLED !== 'true'` | `503 feature_disabled` |
| force_drain | no active connection | `409 connection_not_active` |
| force_drain | empty queue | `409 queue_empty` |
| force_drain | success | `200 { ok, action, queued }` + outbox row + audit |
| dismiss | response not parked / wrong business / unknown | `409 not_awaiting` |
| dismiss | success | `200 { ok, action }` + `superseded` + audit |

## Testing

**Route (`…/zernio-queue/__tests__/route.test.ts`)** — Vitest, mocked `sql`/auth like sibling admin route tests:

- Guards: non-same-origin `403`; non-admin `401/403`; missing-AAL2 `403`; invalid body `400`; unknown action `400`.
- `force_drain`: feature-disabled `503`; `connection_not_active` `409`; `queue_empty` `409`; happy path inserts a
  `drain_pending_owner_connect` outbox row **and** writes `zernio_queue_force_drained` audit in the same tx, returns
  `queued` count; repeat invocation is safe (no throw).
- `dismiss`: happy path flips status to `superseded` with the `posting_error` marker **and** writes
  `zernio_queue_response_dismissed` audit; `not_awaiting` when the row is wrong-business / already-posted /
  already-superseded.

**Component (`…/components/__tests__/ZernioConnectionPanel.test.tsx`)** — Testing Library:

- "Force drain queue" shows only when `status === 'active'`; the hint shows otherwise.
- Force-drain click POSTs `{ action: 'force_drain' }` and calls `onChanged` on success.
- Dismiss click (confirm mocked true) POSTs `{ action: 'dismiss', responseId }` and calls `onChanged`; confirm-false
  cancels.
- Error response renders the inline error and does not call `onChanged`.

## Validation & delivery

- Per CLAUDE.md, do **not** run lint/test in this nested worktree (module resolution leaks into the parent and
  poisons results). Develop here; push the branch and read CI (`lint`, `typecheck`, `test`, `build`) for the
  authoritative baseline + final validation. Also run `pnpm ci:tenant-scope` and `pnpm ci:rls-audit` (DB-touching).
- Land via PR into protected `main` with the four CI checks green; tick #23 (#23b) in `docs/launch-ready-part2.md`
  and remove the `TODO(zernio)` comment.

## Files touched

- **new** `src/app/api/admin/businesses/[id]/zernio-queue/route.ts`
- **new** `src/app/api/admin/businesses/[id]/zernio-queue/__tests__/route.test.ts`
- **edit** `src/app/admin/businesses/[id]/components/ZernioConnectionPanel.tsx` (remove TODO, add the two action surfaces)
- **new** `src/app/admin/businesses/[id]/components/__tests__/ZernioConnectionPanel.test.tsx`
- **edit** `scripts/ci/tenant-scope-allowlist.ts` (allowlist new cross-tenant SQL)
- **edit** `docs/launch-ready-part2.md` (tick #23b, drop the deferral note)
