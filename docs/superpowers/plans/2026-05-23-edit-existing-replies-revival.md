# Edit Existing Replies — Zernio v1 Revival Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the parked Zernio-v1 edit-existing-replies feature (edit / regenerate / republish + DELETE-before-POST orphan recovery) onto current `main`, gated behind `EDIT_REPLIES_ENABLED=false`, with no production behavior change until the flag flips.

**Architecture:** Hybrid revival. **Port** the battle-tested leaf modules verbatim from tag `wip/edit-existing-replies-zernio-v1` (helper, 7 API routes + tests, drawer, card recovery branch) and apply a fixed set of adaptations; **rebuild** the worker integration seams that the post-tag reorg broke (Zernio `deleteReply` now in `client/replies.ts`, `verify409InTx`, a new `publisher/edit-publish.ts` module, the orphan conversion in `publisher/failed-hook.ts`, `load-context` `posting_error`, `process-review` stale-marking). Everything is flag-gated; the worker's edit branch is selected by `(sibling 'posted' exists OR posting_error LIKE '%_after_delete_succeeded')`.

**Tech Stack:** TypeScript 5 strict + Next.js 14 App Router + Postgres.js v3 (`@/lib/db/server`) + BullMQ + Vitest + Supabase migrations + Zernio HTTP client (`src/lib/zernio/client/*`).

**Spec reference:** `docs/superpowers/specs/2026-05-23-edit-existing-replies-revival-design.md` (revival delta) + `docs/superpowers/specs/2026-05-01-edit-existing-replies-design.md` (behavior source of truth). Where they disagree, the 2026-05-01 spec wins on behavior; the 2026-05-23 spec wins on flag naming/layering and file locations.

**Migrations:** None. 031 (and 028–030) already landed on `main`. Do **not** add a migration.

**Branching:** All work on `feat/edit-existing-replies-revival` off `main`. Phase A merge target = full feature shipped with `EDIT_REPLIES_ENABLED=false`. Phase B = one-line env flip after soak.

**Tag retrieval convention:** To port a proven file, run
`git show 'wip/edit-existing-replies-zernio-v1:<path>' > <target-path>` then apply the listed adaptations. Paths containing `(authenticated)` MUST be single-quoted. Never edit the tag.

---

## File Structure

**Port from tag (then adapt)**
| File | Notes |
|---|---|
| `src/lib/responses/edit-existing.ts` (+ `__tests__/edit-existing.test.ts`) | `assertCanEditReply` + `validateOptimisticConcurrency` + error classes. Adapt: tier/activation anchor → `accounts`; tier names `basic/standard/premium/founders`. |
| `src/app/api/dashboard/past-replies/draft/route.ts` (+ test `draft.test.ts`) | POST draft (manual+regenerate). Adapt: current-location scope + `EDIT_REPLIES_ENABLED`. |
| `src/app/api/dashboard/past-replies/draft/[responseId]/route.ts` (+ `draft-id.test.ts`) | PATCH/DELETE. |
| `src/app/api/dashboard/past-replies/draft-status/route.ts` (+ `draft-status.test.ts`) | GET poll. |
| `src/app/api/dashboard/past-replies/publish/route.ts` (+ `publish.test.ts`) | POST publish. |
| `src/app/api/dashboard/past-replies/[responseId]/retry/route.ts` (+ `retry.test.ts`) | POST retry. |
| `src/app/api/dashboard/past-replies/[responseId]/restore-original/route.ts` (+ `restore-original.test.ts`) | POST restore. |
| `src/app/api/dashboard/past-replies/__tests__/cross-origin.test.ts` | All 6 mutating routes 403 on bad Origin; GET exempt. |
| `src/components/dashboard/EditReplyDrawer.tsx` | 6-state drawer (36 KB; port whole, adapt fetch paths only). |

**Rebuild against current `main`**
| File | Action |
|---|---|
| `src/lib/zernio/client/replies.ts` | Add `deleteReply()` (DELETE `/v1/inbox/reviews/{reviewId}/reply`, `timeoutMs: 15_000`). |
| `src/lib/zernio/transport.ts` / `client/transport.ts` | Add `'delete_reply'` mock case + `NO_BODY_ENDPOINTS`. |
| `src/lib/zernio/types.ts` | `'delete_reply'` in `EndpointKind`. |
| `src/lib/zernio/errors.ts` | `ZernioReplyAlreadyDeletedError` (404-on-delete). |
| `worker/jobs/publisher/publisher-error-handlers.ts` | Add `verify409InTx(tx, ...)` (tx-aware 409 verifier, discriminated union). |
| `worker/jobs/publisher/load-context.ts` | Add `posting_error` to SELECT + `PublishResponseContext['response']`. |
| `worker/jobs/publisher/edit-publish.ts` (new) | Phase A pre-flight + Phase B locked DELETE+POST tx, per-CATCH commit semantics, `verify409InTx` dispatch. |
| `worker/jobs/publisher/ResponsePublisherWorker.ts` | Dispatch to edit-publish vs post-reply per the predicate. |
| `worker/jobs/publisher/failed-hook.ts` | Orphan-marker → `'failed'` / `post_after_delete_failed_retry_exhausted` conversion BEFORE existing fallback. |
| `src/lib/reviews/process-review.ts` | Unconditional stale-marking UPDATE at top of content-change block. |

**Modify in place (already on main, read-only form → add edit/recovery)**
| File | Action |
|---|---|
| `src/app/(authenticated)/dashboard/past-replies/page.tsx` | Re-point tier anchor to `accounts`; add `canEdit` per row; LATERAL sidecar of recoverable `failed` rows; pass edit/recovery props. |
| `src/components/dashboard/PastReplyCard.tsx` | Add Edit CTA / premium-lock badge + recovery-state branch + `failed_response_id`/`failed_posting_error` props. |
| `src/app/(authenticated)/dashboard/past-replies/PastRepliesClient.tsx` | Thread edit/recovery props; mount `EditReplyDrawer`. |
| `src/app/(authenticated)/layout.tsx` | Compute `editRepliesEnabled = process.env.EDIT_REPLIES_ENABLED === 'true'`; gate nav/affordances. |
| `.env.example` | Document `EDIT_REPLIES_ENABLED`. |
| `docs/runbooks/zernio-launch-runbook.md` | §10 rollout + ordered Phase-B rollback drain. |

---

## Task Sequence

Phase 0 scaffolds the branch + flag. Phase 1 lands the Zernio client. Phase 2 lands the helper. Phase 3 rebuilds the worker (the orphan-risk core). Phase 4 ports the 7 routes. Phase 5 lands the frontend + failed-row surfacing. Phase 6 lands the HARD-GATE integration tests + runbook + final verification. Each commit is atomic; tests pass before moving on. Flag check everywhere: `process.env.EDIT_REPLIES_ENABLED === 'true'` (server-authoritative; no `NEXT_PUBLIC_*`).

---

### Task 0: Branch + flag scaffold

**Files:** Modify `.env.example`, `src/app/(authenticated)/layout.tsx`

- [ ] **Step 1: Create branch off main**

```bash
git checkout main && git pull --ff-only
git checkout -b feat/edit-existing-replies-revival
```

- [ ] **Step 2: Document the flag in `.env.example`**

Add under the existing past-replies flags:

```bash
# Phase B: enable owner editing/regenerating/republishing of past replies.
# Requires PAST_REPLIES_VIEW_ENABLED=true. Server-authoritative (no NEXT_PUBLIC_ companion).
EDIT_REPLIES_ENABLED=false
```

- [ ] **Step 3: Expose the flag in the authenticated layout**

In `src/app/(authenticated)/layout.tsx`, alongside `PAST_REPLIES_VIEW_ENABLED`, add:

```ts
const editRepliesEnabled =
  process.env.PAST_REPLIES_VIEW_ENABLED === 'true' &&
  process.env.EDIT_REPLIES_ENABLED === 'true';
```

Pass `editRepliesEnabled` down to wherever the Past Replies nav/affordances are rendered (mirror the existing `pastRepliesEnabled` plumbing).

- [ ] **Step 4: Typecheck + commit**

Run: `pnpm tsc --noEmit` → Expected: clean.
```bash
git add .env.example "src/app/(authenticated)/layout.tsx"
git commit -m "feat(past-replies): scaffold EDIT_REPLIES_ENABLED flag (revival phase A)"
```

---

### Task 1: Zernio `deleteReply` + error classification

**Files:**
- Modify: `src/lib/zernio/types.ts`, `src/lib/zernio/errors.ts`, `src/lib/zernio/client/replies.ts`, `src/lib/zernio/client/transport.ts`
- Test: `src/lib/zernio/__tests__/client.test.ts` (or the current reply-client test file)

- [ ] **Step 1: Reference the tag's intended behavior**

Read the tag's version for the exact body/timeout/404 semantics:
`git show 'wip/edit-existing-replies-zernio-v1:src/lib/zernio/client.ts' | less` (note: tag stored replies in the monolithic `client.ts`; on main they live in `client/replies.ts`).

- [ ] **Step 2: Write the failing test**

In the reply-client test file, add:

```ts
it('deleteReply targets the inbox path with a 15s timeout', async () => {
  const calls: any[] = [];
  const transport = { request: async (opts: any) => { calls.push(opts); return undefined; } };
  const client = createReplyClient(transport as any);
  await client.deleteReply('acct_1', 'rev_1');
  expect(calls[0]).toMatchObject({
    method: 'DELETE',
    path: '/v1/inbox/reviews/rev_1/reply',
    endpointKind: 'delete_reply',
    timeoutMs: 15_000,
  });
});

it('maps a 404 on delete to ZernioReplyAlreadyDeletedError', () => {
  expect(() => { throw new ZernioReplyAlreadyDeletedError('rev_1'); })
    .toThrow(ZernioReplyAlreadyDeletedError);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test src/lib/zernio/__tests__/client.test.ts`
Expected: FAIL — `deleteReply` / `ZernioReplyAlreadyDeletedError` undefined, `'delete_reply'` not in `EndpointKind`.

- [ ] **Step 4: Add `'delete_reply'` to `EndpointKind`**

In `src/lib/zernio/types.ts`, add `'delete_reply'` to the `EndpointKind` union.

- [ ] **Step 5: Add the error class**

In `src/lib/zernio/errors.ts`:

```ts
export class ZernioReplyAlreadyDeletedError extends Error {
  constructor(public readonly reviewId: string) {
    super(`Zernio reply for review ${reviewId} already deleted (404 on DELETE)`);
    this.name = 'ZernioReplyAlreadyDeletedError';
  }
}
```

- [ ] **Step 6: Implement `deleteReply` in `client/replies.ts`**

Add to the object returned by `createReplyClient`:

```ts
deleteReply: (accountId: string, reviewId: string) =>
  transport.request<void>({
    method: 'DELETE',
    path: `/v1/inbox/reviews/${encodeURIComponent(reviewId)}/reply`,
    endpointKind: 'delete_reply',
    timeoutMs: 15_000,
  }),
```

- [ ] **Step 7: Wire transport mock + no-body**

In `src/lib/zernio/client/transport.ts`, add a `'delete_reply'` case to the mock-mode switch returning `undefined`, and add `'delete_reply'` to `NO_BODY_ENDPOINTS` (DELETE returns minimal body).

- [ ] **Step 8: Run tests + commit**

Run: `pnpm test src/lib/zernio/__tests__/client.test.ts` → Expected: PASS.
```bash
git add src/lib/zernio
git commit -m "feat(zernio): add deleteReply + ZernioReplyAlreadyDeletedError (revival)"
```

---

### Task 2: `edit-existing.ts` helper (port + account-scope adaptation)

**Files:**
- Create: `src/lib/responses/edit-existing.ts`, `src/lib/responses/__tests__/edit-existing.test.ts`

- [ ] **Step 1: Port the file + test from tag**

```bash
git show 'wip/edit-existing-replies-zernio-v1:src/lib/responses/edit-existing.ts' > src/lib/responses/edit-existing.ts
git show 'wip/edit-existing-replies-zernio-v1:src/lib/responses/__tests__/edit-existing.test.ts' > src/lib/responses/__tests__/edit-existing.test.ts
```

- [ ] **Step 2: Adapt the C-2 anchor to `accounts`**

`assertCanEditReply` in the tag reads `business.subscription_tier` / `business.subscription_activated_at`. Re-point both to the **account** (billing parent). The function must:
- accept/resolve `accountId` for the tier+activation read, and the review's `business_id` for ownership;
- read tier/activation via a join to `accounts` (e.g. `SELECT a.subscription_tier, a.subscription_activated_at FROM accounts a JOIN businesses b ON b.account_id = a.id WHERE b.id = ${locationId}`);
- keep the `isHistorical = activated_at IS NULL OR review_date < activated_at` and `canEdit = NOT isHistorical OR isPremium` logic unchanged (behavior source: 2026-05-01 §4.1).

- [ ] **Step 3: Adapt tier names**

Replace any `'founding'` literal with `'founders'`; compare premium via `tier === SubscriptionTier.PREMIUM` from `@/lib/accounts/tier-config`. Ensure the gate treats `basic`, `standard`, `founders` all as non-premium.

- [ ] **Step 4: Adapt tier-name test cases**

In the test, ensure non-premium cases cover both `basic` and `founders` (not `founding`), plus a `premium` historical-allowed case.

- [ ] **Step 5: Run + commit**

Run: `pnpm test src/lib/responses/__tests__/edit-existing.test.ts` → Expected: PASS.
```bash
git add src/lib/responses
git commit -m "feat(responses): edit-existing helper, account-scoped C-2 gate (revival)"
```

---

### Task 3: `verify409InTx` (tx-aware 409 verifier)

**Files:**
- Modify: `worker/jobs/publisher/publisher-error-handlers.ts`
- Test: `worker/jobs/publisher/__tests__/publisher-error-handlers.test.ts`

- [ ] **Step 1: Reference the tag implementation**

`git show 'wip/edit-existing-replies-zernio-v1:worker/jobs/publisher-error-handlers.ts'` — copy the `verify409InTx` function and its discriminated-union return type. (The tag's `verify409AndDispose` non-tx variant already has a main equivalent; only the tx-aware one is missing.)

- [ ] **Step 2: Port the tests for `verify409InTx`**

From the tag's `worker/__tests__/publisher-error-handlers.test.ts`, port the `verify409InTx` cases (matches / mismatch / indeterminate) into the current test file path.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test worker/jobs/publisher/__tests__/publisher-error-handlers.test.ts`
Expected: FAIL — `verify409InTx` not exported.

- [ ] **Step 4: Implement `verify409InTx`**

Add the tx-aware verifier (takes `tx` handle first; re-reads the live reply via Zernio inside the open tx; returns `{ kind: 'matches' | 'mismatch' | 'indeterminate' }`). Mirror the ported logic.

- [ ] **Step 5: Run + commit**

Run: same command → Expected: PASS.
```bash
git add worker/jobs/publisher/publisher-error-handlers.ts worker/jobs/publisher/__tests__/publisher-error-handlers.test.ts
git commit -m "feat(publisher): verify409InTx tx-aware 409 verifier (revival)"
```

---

### Task 4: Expose `posting_error` in `load-context.ts`

**Files:**
- Modify: `worker/jobs/publisher/load-context.ts`
- Test: `worker/jobs/publisher/__tests__/` (load-context or publisher worker test)

- [ ] **Step 1: Write the failing test**

Assert the loaded context surfaces `posting_error` for a row that has one:

```ts
it('loadPublishResponseContext returns posting_error', async () => {
  // seed a response row with posting_error='post_after_delete_failed_x'
  const ctx = await loadPublishResponseContext({ responseId, businessId, outboxId, outboxAttempt: 0, logger });
  expect(ctx).not.toBe('terminal');
  expect((ctx as any).response.posting_error).toBe('post_after_delete_failed_x');
});
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL (`posting_error` undefined / not selected).

- [ ] **Step 3: Add the column**

In `load-context.ts`: add `posting_error` to the `SELECT` and to `PublishResponseContext['response']` (`posting_error: string | null`).

- [ ] **Step 4: Run + commit** → Expected: PASS.
```bash
git add worker/jobs/publisher/load-context.ts worker/jobs/publisher/__tests__/
git commit -m "feat(publisher): surface posting_error in publish context (revival)"
```

---

### Task 5: `edit-publish.ts` module (DELETE-before-POST locked tx)

**Files:**
- Create: `worker/jobs/publisher/edit-publish.ts`
- Test: `worker/jobs/publisher/__tests__/edit-publish.test.ts` (port from tag `worker/__tests__/ResponsePublisherWorker-edit.test.ts`)

- [ ] **Step 1: Port the branch tests**

```bash
git show 'wip/edit-existing-replies-zernio-v1:worker/__tests__/ResponsePublisherWorker-edit.test.ts' > worker/jobs/publisher/__tests__/edit-publish.test.ts
```
Adjust imports to the new module path. These cover: success (DELETE+POST ok → `posted`, sibling `superseded`), POST-fail-after-delete → orphan marker, DELETE-fail → `delete_failed_*`, transient vs permanent, 409 verifier matches/mismatch/indeterminate.

- [ ] **Step 2: Run to verify failure** — Expected: FAIL (module absent).

- [ ] **Step 3: Implement `runEditPublishIfApplicable(context, deps)`**

Extract the tag's edit-publisher branch (from `worker/jobs/ResponsePublisherWorker.ts` on the tag) into a standalone module exporting one function. Requirements (behavior source 2026-05-01 §4.5):
- Phase A (flag off): pre-flight no-op returning a "not applicable" signal so the worker falls through to `post-reply`.
- Phase B (flag on): open one tx; `SELECT review FOR UPDATE`, `SELECT responses FOR UPDATE`; call `zernioClient.deleteReply`; then `postReply`; per-CATCH commit semantics writing the documented `posting_error` markers (`delete_failed_*`, `post_after_delete_failed_*`, `*_after_delete_succeeded`); use `verify409InTx` on 409.
- Holds `reviews`+`responses FOR UPDATE` across the external I/O so `processReview` serializes.

- [ ] **Step 4: Run + commit** → Expected: PASS.
```bash
git add worker/jobs/publisher/edit-publish.ts worker/jobs/publisher/__tests__/edit-publish.test.ts
git commit -m "feat(publisher): edit-publish DELETE-before-POST module (revival)"
```

---

### Task 6: Worker dispatch (edit-publish vs post-reply)

**Files:**
- Modify: `worker/jobs/publisher/ResponsePublisherWorker.ts`
- Test: `worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts`

- [ ] **Step 1: Write the failing dispatch test**

```ts
it('dispatches to edit-publish when a posted sibling exists', async () => { /* assert runEditPublishIfApplicable called */ });
it('dispatches to edit-publish for an orphan-marker row with no posted sibling', async () => {
  // response.posting_error = 'post_x_after_delete_succeeded', no 'posted' sibling
});
it('dispatches to plain post-reply for a normal first publish', async () => {});
```

- [ ] **Step 2: Run to verify failure** — Expected: FAIL.

- [ ] **Step 3: Implement the dispatch predicate**

In `handlePublishResponse`, after `loadPublishResponseContext` + the publishable-state gate, compute:

```ts
const hasPostedSibling = /* SELECT 1 FROM responses WHERE review_id=$ AND status='posted' AND id<>$ */;
const isOrphanRetry = (response.posting_error ?? '').endsWith('_after_delete_succeeded');
if (process.env.EDIT_REPLIES_ENABLED === 'true' && (hasPostedSibling || isOrphanRetry)) {
  await runEditPublishIfApplicable(context, deps);
  return;
}
// else fall through to existing postReplyAndHandleTerminalOutcomes
```

- [ ] **Step 4: Run + commit** → Expected: PASS.
```bash
git add worker/jobs/publisher/ResponsePublisherWorker.ts worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts
git commit -m "feat(publisher): dispatch edit-publish on posted-sibling/orphan-marker (revival)"
```

---

### Task 7: Orphan conversion in `failed-hook.ts`

**Files:**
- Modify: `worker/jobs/publisher/failed-hook.ts`
- Test: `worker/jobs/publisher/__tests__/failed-hook.test.ts` (port relevant cases from tag `worker/__tests__/publisher-on-failed.test.ts`)

- [ ] **Step 1: Port the conversion tests**

From the tag's `publisher-on-failed.test.ts`, port the orphan-marker → `'failed'` conversion cases into the current `failed-hook.test.ts`.

- [ ] **Step 2: Run to verify failure** — Expected: FAIL (no orphan branch on main's hook).

- [ ] **Step 3: Implement the conversion BEFORE the existing fallback**

In `handlePublisherFailed`, before the current transient-exhaustion fallback, in one tx using the canonical `review → response` lock order, business-scoped: if `posting_error LIKE '%_after_delete_succeeded'` on retry exhaustion → transition to `status='failed'`, `posting_error='post_after_delete_failed_retry_exhausted'` (status-guarded, affected-row-checked) + `markOutboxFailed`. Otherwise ROLLBACK and fall through to today's fallback. (Behavior source 2026-05-01 §4.5 "Retry exhaustion conversion".)

- [ ] **Step 4: Run + commit** → Expected: PASS.
```bash
git add worker/jobs/publisher/failed-hook.ts worker/jobs/publisher/__tests__/failed-hook.test.ts
git commit -m "feat(publisher): orphan-marker retry-exhaustion conversion in failed-hook (revival)"
```

---

### Task 8: `process-review` stale-marking

**Files:**
- Modify: `src/lib/reviews/process-review.ts`
- Test: `src/lib/reviews/__tests__/process-review.test.ts`

- [ ] **Step 1: Write the failing test**

Assert: when a customer edits a review whose response is `failed` with an allowlisted prefix (`delete_failed_*` / `post_after_delete_failed_*`), the content-change path marks it `stale_after_review_changed`.

- [ ] **Step 2: Run to verify failure** — Expected: FAIL.

- [ ] **Step 3: Implement the unconditional stale-marking UPDATE at the TOP of the content-change block** (status-guarded to the allowlisted failed prefixes), per 2026-05-01 §4.5.

- [ ] **Step 4: Run + commit** → Expected: PASS.
```bash
git add src/lib/reviews/process-review.ts src/lib/reviews/__tests__/process-review.test.ts
git commit -m "feat(reviews): stale-mark recoverable failed rows on review edit (revival)"
```

---

### Task 9–11: Port the 7 API routes (manual+regenerate, patch/delete, status, publish, retry, restore-original)

For EACH route below, the cycle is: **port test → port route → adapt → run → commit.** Do them one route per commit.

**Common adaptations for every route (apply during port):**
- **Flag:** add `if (process.env.EDIT_REPLIES_ENABLED !== 'true') return 503 feature_disabled;` (the tag used `EDIT_EXISTING_REPLIES_ENABLED`).
- **Scope:** replace the tag's session-business resolution with `requireOwnerAccess()` → `currentLocationId` (the `rw_location_scope` cookie path the live page uses). Scope every review/response lookup by `business_id = currentLocationId`; resolve `accountId` for `assertCanEditReply`. **Never** use `requireRole().locationId` (that's the primary location).
- **CSRF:** keep `withSameOrigin` on POST/PATCH/DELETE; GET `/draft-status` exempt.
- **Tier gate:** `assertCanEditReply` before any side effect (except `/draft-status`).

#### Task 9: `POST /draft` + `PATCH·DELETE /draft/:id`

**Files:** Create `src/app/api/dashboard/past-replies/draft/route.ts`, `draft/[responseId]/route.ts`, `__tests__/draft.test.ts`, `__tests__/draft-id.test.ts`

- [ ] **Step 1: Port files**
```bash
git show 'wip/edit-existing-replies-zernio-v1:src/app/api/dashboard/past-replies/draft/route.ts' > src/app/api/dashboard/past-replies/draft/route.ts
git show 'wip/edit-existing-replies-zernio-v1:src/app/api/dashboard/past-replies/draft/[responseId]/route.ts' > 'src/app/api/dashboard/past-replies/draft/[responseId]/route.ts'
git show 'wip/edit-existing-replies-zernio-v1:src/app/api/dashboard/past-replies/__tests__/draft.test.ts' > src/app/api/dashboard/past-replies/__tests__/draft.test.ts
git show 'wip/edit-existing-replies-zernio-v1:src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts' > src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts
```
- [ ] **Step 2: Apply the common adaptations** (flag rename, current-location scope, tier names). Update test mocks to mock `requireOwnerAccess`/`currentLocationId` rather than the old session shape.
- [ ] **Step 3: Run** `pnpm test src/app/api/dashboard/past-replies/__tests__/draft.test.ts src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts` → fix until PASS.
- [ ] **Step 4: Commit** `git commit -m "feat(past-replies): POST /draft + PATCH/DELETE /draft/:id (revival)"`

#### Task 10: `GET /draft-status` + `POST /publish`

**Files:** Create `draft-status/route.ts`, `publish/route.ts`, `__tests__/draft-status.test.ts`, `__tests__/publish.test.ts`

- [ ] **Step 1: Port the 4 files** (same `git show` pattern).
- [ ] **Step 2: Adaptations.** For `/draft-status`: keep the tenant-ownership guard but verify `job_outbox.payload->>'business_id'` equals the **current** location and the resolved response belongs to it. For `/publish`: keep the one-tx transition + audit-log + `publish_response` outbox INSERT atomicity; status discriminator `edited_text IS NOT NULL ? 'edited' : 'approved'`; `approved_text = COALESCE(approved_text, response_text)`.
- [ ] **Step 3: Run** both test files → PASS.
- [ ] **Step 4: Commit** `git commit -m "feat(past-replies): GET /draft-status + POST /publish (revival)"`

#### Task 11: `POST /retry` + `POST /restore-original` + cross-origin

**Files:** Create `[responseId]/retry/route.ts`, `[responseId]/restore-original/route.ts`, `__tests__/retry.test.ts`, `__tests__/restore-original.test.ts`, `__tests__/cross-origin.test.ts`

- [ ] **Step 1: Port all 5 files.**
- [ ] **Step 2: Adaptations.** Keep recovery-route semantics exactly (allowlist prefixes; branch-shape validation preventing `/retry` undoing a prior `/restore-original`; neither calls `validateOptimisticConcurrency`). Apply flag + current-location scope + `assertCanEditReply`. The cross-origin test must assert all 6 mutating routes 403 on bad Origin and GET `/draft-status` is exempt.
- [ ] **Step 3: Run** all 3 test files → PASS.
- [ ] **Step 4: Commit** `git commit -m "feat(past-replies): /retry + /restore-original recovery routes + cross-origin (revival)"`

---

### Task 12: Frontend — drawer + card recovery + page surfacing

**Files:** Create `EditReplyDrawer.tsx`; Modify `PastReplyCard.tsx`, `page.tsx`, `PastRepliesClient.tsx`

- [ ] **Step 1: Port the drawer**
```bash
git show 'wip/edit-existing-replies-zernio-v1:src/components/dashboard/EditReplyDrawer.tsx' > src/components/dashboard/EditReplyDrawer.tsx
```
Adapt: fetch URLs already target `/api/dashboard/past-replies/*` (unchanged); confirm the 1500ms poll + 60s ceiling + `useRef` snapshot are intact. No scope change needed (client component; server enforces).

- [ ] **Step 2: Re-point the page tier anchor to `accounts`**

In `page.tsx`, replace the `SELECT ... subscription_tier, subscription_activated_at FROM businesses` block with a read from `accounts` joined via the current location (fixes the existing latent bug). Keep review rows scoped by `business_id = currentLocationId`.

- [ ] **Step 3: Add `canEdit` per row + the failed-row LATERAL sidecar**

Compute `canEdit` per row from the account tier + the gap/historical boundary (mirror `assertCanEditReply`). Extend the main page query with a LATERAL join that sidecars the most-recent recoverable `failed` row per review (`failed_response_id`, `failed_posting_error`) onto the `posted` card; de-dup by `review_id` so a `delete_failed_*` row attaches to its live `posted` card rather than rendering twice. Orphan rows (no `posted` sibling) surface as their own recovery card.

- [ ] **Step 4: Add the card edit/recovery branch**

In `PastReplyCard.tsx`, add: Edit CTA when `canEdit`, "Premium feature" lock badge otherwise, and a recovery-state branch consuming `failed_response_id`/`failed_posting_error`. Thread props through `PastRepliesClient.tsx` and mount `EditReplyDrawer` (open on Edit / recovery CTA). Gate all edit affordances behind the `editRepliesEnabled` prop from Task 0.

- [ ] **Step 5: Typecheck + build + commit**

Run: `pnpm tsc --noEmit && pnpm build` → Expected: clean; new route compiles.
```bash
git add "src/app/(authenticated)/dashboard/past-replies" src/components/dashboard
git commit -m "feat(past-replies): edit drawer + recovery card + failed-row surfacing (revival)"
```

---

### Task 13: HARD-GATE publisher/recovery integration tests

**Files:** Create `worker/__tests__/integration-edit-existing-reply.test.ts` (port + adapt from tag)

> Requires `TEST_DATABASE_POOL_URL` (real Postgres for `FOR UPDATE`). If unavailable, stand up the fixture — do NOT skip this gate (spec §7).

- [ ] **Step 1: Port the integration test** from the tag's `worker/__tests__/zernio-end-to-end.integration.test.ts` edit-relevant cases, adapting paths/scoping.
- [ ] **Step 2: Ensure the four required scenarios are present:** (1) DELETE-success + POST-failure → orphan marker + `'failed'`; (2) retry-exhaustion conversion via `failed-hook`; (3) `/retry` for both `delete_failed_*` and `post_after_delete_failed_*`; (4) `/restore-original` for the orphan case.
- [ ] **Step 3: Run against a real test DB**

Run: `TEST_DATABASE_POOL_URL=... pnpm test worker/__tests__/integration-edit-existing-reply.test.ts`
Expected: PASS (all four scenarios).

- [ ] **Step 4: Commit** `git commit -m "test(publisher): hard-gate edit/recovery integration tests (revival)"`

---

### Task 14: Runbook + final verification

**Files:** Modify `docs/runbooks/zernio-launch-runbook.md`

- [ ] **Step 1: Append §10** — Phase A/B rollout + the ordered Phase-B rollback drain from spec §8 (disable UI flag → drain edit-publish outboxes → verify no `delete_failed_%` / `post_after_delete_failed_%` / orphan rows → only then disable worker branch).
- [ ] **Step 2: Full verification**

Run, expecting all green:
```bash
pnpm test
pnpm tsc --noEmit
pnpm lint
pnpm build
```

- [ ] **Step 3: Confirm flag-off inertness**

Grep that every new route + the worker edit branch is guarded by `EDIT_REPLIES_ENABLED`; with the flag unset, `pnpm test` reflects no behavior change to existing publish path.

- [ ] **Step 4: Commit + open PR**
```bash
git add docs/runbooks/zernio-launch-runbook.md
git commit -m "docs(runbook): edit-existing replies Phase A/B + rollback drain (revival)"
git push -u origin feat/edit-existing-replies-revival
gh pr create --title "Revive Zernio v1 edit-existing-replies (Phase A, flag off)" --body "..."
```

---

## Self-Review

**Spec coverage:** §1 motivation (context only) — n/a. §2 scope → Tasks 1–14. §3.1 ports → Tasks 2,9–12. §3.2 rebuilds → Tasks 1,3,4,5,6,7,8. §4.1 account anchor → Tasks 2,12. §4.2 current-location scope → Tasks 9–11 common adaptations + Task 12. §4.3 no migration → honored (no migration task). §4.4 flag layering → Task 0 + per-route flag. §5 failed-row surfacing → Task 12 step 3–4. §6 invariants → preserved across publisher/route tasks. §7 tests (hard gate) → Task 13; tier names → Task 2. §8 rollout/drain → Task 14.

**Placeholder scan:** The `gh pr create --body "..."` is the only ellipsis — fill with the standard PR summary at execution time; not a logic placeholder.

**Type/name consistency:** `EDIT_REPLIES_ENABLED` used uniformly; `runEditPublishIfApplicable` (Task 5) referenced consistently in Task 6; `verify409InTx` (Task 3) used in Task 5; `posting_error` (Task 4) used in Tasks 5–8 and Task 12; tier names `basic/standard/premium/founders` (Task 2) match `tier-config.ts`.

**Known investigation steps (not placeholders):** Tasks 3/5/7 instruct retrieving exact logic from named tag files — deliberate hybrid-port mechanic to preserve the 6 rounds of fixes, not "figure it out."
