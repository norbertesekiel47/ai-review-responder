# Design: Close point-2 test gaps

**Date:** 2026-05-28
**Source:** `docs/launch-ready-part1.md` line 165 (Suggested order → "Do now" item 2):
> Close `OutboxPoller` + Resend-signature accept-path test gaps; harden the flaky `bounced-skip` test.

**Status:** approved (design); pending written-spec review.

## Goal

Close three pure-local test gaps. No production behavior changes except a single
`export` keyword. Each gap ships as its own PR.

## Confirmed decisions

| Decision | Choice |
|---|---|
| Delivery | **Three separate PRs**, one per sub-task |
| Flaky `bounced-skip` | **Reproduce first** (systematic-debugging), then harden; fall back to evidence-based hardening only if it provably won't reproduce locally |
| `OutboxPoller` test seam | **Export `pollOutbox`** for direct, deterministic testing |

## Orchestration & worktree strategy

- **Sibling worktrees, never nested.** Worktrees live beside the repo under
  `repworth-wt/<slug>` (the project's established convention, e.g.
  `repworth-wt/121-coverage`). Nested worktrees under `.claude/worktrees/` are
  disqualified: CLAUDE.md documents that they leak module resolution into the
  parent `node_modules`/eslintrc and poison `lint`+`test` — fatal for a task
  that exists to write and run tests. This overrides the worktree skill's
  "always use the native nesting tool" default (project instructions win).
- **Three branches off `main` HEAD (`09fcc1ed`).** The uncommitted
  `docs/legal/*` + `src/lib/legal/*` changes in the primary working tree stay
  behind untouched.
- **Sequential order:** (1) OutboxPoller → (2) Resend accept-path →
  (3) bounced-skip. P0 net-new coverage first; the open-ended reproduce-first
  task last.
- **Per PR:** branch → TDD → `pnpm lint && pnpm typecheck && pnpm test` green
  locally → push → PR with the 4 CI checks green. Not parallel agents —
  reproduction work needs focused attention and parallelism buys little for
  three small tasks.

## Conventions to follow (from existing tests)

- `vi.hoisted` + a shared `sqlReturnQueue` array for mocking `sql`
  (`src/lib/db/server`), with `mockSql.begin` running its callback against a
  `mockTx`. (This is the dominant pattern; PR 3 will revisit whether the
  order-dependent queue is itself the flakiness source.)
- Fastify request/reply test doubles as in
  `worker/ingress/__tests__/resend-webhook-bounce.test.ts` (`makeReq`/`makeReply`).
- Real-HMAC construction as in
  `worker/ingress/zernio/__tests__/zernio-verify.test.ts`.
- `vi.useFakeTimers()` + `vi.setSystemTime()` for time-dependent logic.
- Capture + restore `process.env` keys touched by a test.

---

## PR 1 — `OutboxPoller` tests

**Production change:** add `export` to `pollOutbox` in
`worker/background/pollers/OutboxPoller.ts`. Single keyword; no other change.

**New file:** `worker/background/pollers/__tests__/OutboxPoller.test.ts`.

**Mocks (`vi.hoisted`):**
- `sql` from `../../../src/lib/db/server` — tagged-template mock backed by a
  return queue; `sql.begin(cb)` runs `cb(mockTx)`, where `mockTx` is itself a
  return-queue-backed tagged-template mock (the watchdog phase issues three
  `tx` count queries).
- `topicToQueue` from `../../queues` — each known topic maps to
  `{ add: vi.fn() }`. (No existing poller test mocks the queue; this PR
  establishes the pattern.)
- `@sentry/node` — `OutboxPoller` imports this module **directly** (not
  `worker/sentry`): mock `captureMessage`, `addBreadcrumb`, `captureException`.

**Test cases** (the four behaviors the doc names + the real edges):
1. **Watchdog reset** — stale `dispatched` rows, `attempts < max_attempts`
   → UPDATE back to `pending` (assert the watchdog tx ran its reset query).
2. **Watchdog dead-letter** — stale `dispatched`, `attempts >= max_attempts`
   → marked `failed` with the stale-exceeded message.
3. **Stale `dispatching` recovery** — `dispatching` older than 2 min → `pending`.
4. **Dispatch happy path** — a claimed `pending` row dispatches:
   `queue.add(topic, {…payload, outbox_id, outbox_attempt}, {jobId})` is called
   with `jobId === \`${id}_${attempts}\``, then the row is updated to
   `dispatched`.
5. **Unknown topic** — `topicToQueue[topic]` is undefined → row `failed`,
   `Sentry.captureMessage` called once, **no** `queue.add`.
6. **Attempt-guard on dispatch failure** — `queue.add` throws:
   `attempts >= max_attempts` → `failed`; otherwise → `pending` with
   `last_error` set.
7. **JSONB-as-string guard** — push the row `payload` as a JSON **string**;
   assert a parsed **object** (not the string) reaches `queue.add`.
8. **Empty batch** — zero pending rows → returns without dispatch or error.

**Determinism:** every case is `await pollOutbox()` directly. No timers, no
fire-and-forget. The `isPolling` re-entrancy guard resets in `finally`, so each
call is independent.

**Acceptance:** new test file green; full `pnpm test`, `lint`, `typecheck`,
`build` green; no change to any existing test.

---

## PR 2 — Resend signature accept-path tests

**Test-only.** **New file:** `worker/ingress/__tests__/resend-webhook-signature.test.ts`
(the existing `resend-webhook-bounce.test.ts` stays untouched; it deliberately
bypasses signatures via `MOCK_EXTERNAL_APIS=true`).

**Real-HMAC helper** (mirrors `zernio-verify.test.ts`):
`sig = base64( HMAC-SHA256( base64decode(secret without 'whsec_'), \`${svixId}.${svixTimestamp}.${rawBody}\` ) )`,
placed in the `svix-signature` header as `v1,${sig}`.

**Env / time:** set `RESEND_WEBHOOK_SECRET='whsec_<base64>'`; ensure
`MOCK_EXTERNAL_APIS` is unset/false; capture + restore both. Use
`vi.useFakeTimers()` + `setSystemTime()` so the ±timestamp window is
deterministic. `rawBody` set on the request double = `JSON.stringify(body)`.

**Test cases:**
1. **Valid signature + fresh timestamp** → accepted → reaches dedup INSERT →
   `200 { received: true }`. (Mock `sql`: INSERT returns `count: 1`, then the
   processed UPDATE.)
2. **Stale timestamp** (`age > 300s`) → `401 invalid_signature`; **no `sql`**.
3. **Future timestamp** (`age < -60s`) → `401`; no `sql`.
4. **Tampered body** (signature computed over a different body) → `401`.
5. **Missing svix headers** → `401`.
6. **Missing secret, non-mock mode** → `401` (fail-closed).
7. **Multiple space-separated signatures**, one valid → accepted.

**Acceptance:** new file green; reject paths assert **zero `sql` calls** (the
signature gate runs first); full CI green; bounce test unchanged.

---

## PR 3 — `bounced-skip` flakiness hardening

**Symptoms (from the doc, line 47):** under full-suite parallel load,
`worker/jobs/notification/__tests__/bounced-skip.test.ts` reported (a) one
5000ms timeout and (b) one fixture-ordering assertion
(`Response resp-1 belongs to business undefined, not biz-1`). Passes 4/4 in
isolation; CI on `main` is green. → flakiness, not a correctness bug.

**Step 1 — reproduce (systematic-debugging, before any edit):**
run the full suite repeatedly / under parallel load to trigger the failure.
Confirm root cause with evidence. If it provably will not reproduce locally,
state that explicitly and fall back to evidence-based hardening rather than
guessing.

**Hypotheses to verify (not assume):**
- Shared **module-level `sqlReturnQueue`** + per-test dynamic
  `await import()` of four different workers: if any worker issues an
  unanticipated `sql` call, the order-dependent `shift()` returns the wrong
  fixture → the "belongs to business undefined" assertion.
- Module-state bleed between the four dynamic imports (no `vi.resetModules()`).
- A genuine fixed-timeout / slow-import hang producing the 5000ms timeout.

**Step 2 — harden (final set decided by what reproduction shows):**
- Make the `sql` mock **content-aware** (return fixtures keyed by query
  shape/table) **or** give each test a freshly-scoped queue +
  `vi.resetModules()` between imports, so call-order drift cannot misfire.
- Replace any fixed-timeout wait with event-based waiting; if the 5000ms is
  slow dynamic import under load, hoist the imports or set an explicit timeout.
- **Assertions stay byte-for-byte identical** — only the scaffolding hardens;
  behavior under test is unchanged.

**Acceptance:** full suite stable across several back-to-back / parallel runs;
CI green; the four behavioral assertions unchanged.

---

## Cross-cutting guarantees

- **No production behavior change** except the one `export` in PR 1.
- Each PR independently green on `lint`, `typecheck`, `test`, `build`.
- No existing test modified except `bounced-skip.test.ts` scaffolding in PR 3
  (assertions preserved).
- No new runtime dependencies; no new top-level directories.
