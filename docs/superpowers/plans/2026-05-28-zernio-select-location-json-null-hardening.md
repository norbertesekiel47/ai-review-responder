# Zernio select-location JSON-null hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two latent 500-bugs in the Zernio `select-location` finalize path (JSON `null` body / `"null"` pending marker) with regression tests, and document the benign backfill-predicate over-fire (issue #41).

**Architecture:** Two small post-parse type guards (`x === null || typeof x !== 'object'`) — one in `authorize.ts` (body), one in `pending-transition.ts` (pending marker) — each throwing the typed `ZernioRouteError` instead of letting a `TypeError` bubble to a 500. Item 3 is a documentation-only comment; the `needs_backfill` predicate SQL is intentionally NOT changed (a wrong fix risks suppressing a legitimate backfill; the redundant enqueue is provably idempotent at the worker).

**Tech Stack:** TypeScript (strict), Next.js route module, Vitest with hoisted mocks, pnpm.

**Spec:** `docs/superpowers/specs/2026-05-28-zernio-select-location-json-null-hardening-design.md`

---

## File Structure

- Modify: `src/app/api/zernio/connect/_shared/finalize/authorize.ts` — add object guard after body parse (~line 80).
- Modify: `src/app/api/zernio/connect/_shared/finalize/pending-transition.ts` — add object guard after marker parse (~line 35).
- Modify: `src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts` — append doc sentence to the predicate comment (~line 147). No code change.
- Test: `src/app/api/zernio/connect/_shared/finalize/__tests__/finalize-modules.test.ts` — extend two existing `describe` blocks (4 new cases). Existing baseline: 39 tests passing.

All edits live in the isolated sibling worktree `/Users/norbertesekiel/Developer/startups/RepWorth-issue41` on branch `fix/41-zernio-select-location-json-null-hardening`.

---

### Task 1: Fix 1 — `authorize.ts` null/scalar body guard

**Files:**
- Modify: `src/app/api/zernio/connect/_shared/finalize/authorize.ts` (after the body-parse `try/catch`, ~line 80)
- Test: `src/app/api/zernio/connect/_shared/finalize/__tests__/finalize-modules.test.ts` (`describe('authorizeSelectLocation')`)

- [ ] **Step 1: Write the failing tests**

In `finalize-modules.test.ts`, inside `describe('authorizeSelectLocation', ...)`, immediately AFTER the existing test `it('throws 400 invalid_body only for unparseable JSON', ...)` (ends ~line 370), add:

```ts
  it('throws 400 invalid_body for a literal null JSON body (not 500)', async () => {
    await expectRouteError(
      authorizeSelectLocation(makeRequest('null')),
      400,
      'invalid_body',
    );
  });

  it('throws 400 invalid_body for a scalar JSON body (normalized)', async () => {
    await expectRouteError(
      authorizeSelectLocation(makeRequest('42')),
      400,
      'invalid_body',
    );
  });
```

(`makeRequest(body: string | object)` passes a string body verbatim, so `'null'` → JSON body `null`, `'42'` → JSON body `42`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/app/api/zernio/connect/_shared/finalize/__tests__/finalize-modules.test.ts -t "JSON body"`
Expected: BOTH FAIL. The `null` case rejects with a raw `TypeError` (no `statusCode`/`code` → `toMatchObject` mismatch). The scalar `'42'` case rejects with `ZernioRouteError(400, 'invalid_location_id')` (code mismatch vs expected `invalid_body`).

- [ ] **Step 3: Add the guard**

In `authorize.ts`, the current code reads:

```ts
  // 3. Parse body.
  let body: SelectLocationBody;
  try {
    body = (await req.json()) as SelectLocationBody;
  } catch {
    throw new ZernioRouteError(400, 'invalid_body');
  }
  const locationId =
```

Insert the guard between the `catch` block and `const locationId`:

```ts
  // 3. Parse body.
  let body: SelectLocationBody;
  try {
    body = (await req.json()) as SelectLocationBody;
  } catch {
    throw new ZernioRouteError(400, 'invalid_body');
  }
  // A literal `null` (or any non-object) JSON body parses successfully; reading
  // `body.locationId` off it would throw a TypeError → 500. Reject as 400 here.
  if (body === null || typeof body !== 'object') {
    throw new ZernioRouteError(400, 'invalid_body');
  }
  const locationId =
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/app/api/zernio/connect/_shared/finalize/__tests__/finalize-modules.test.ts -t "JSON body"`
Expected: BOTH PASS.

- [ ] **Step 5: Verify HEAD, then commit (explicit paths only — never `-A`/`.`)**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "fix/41-zernio-select-location-json-null-hardening" || { echo "WRONG BRANCH"; exit 1; }
git add src/app/api/zernio/connect/_shared/finalize/authorize.ts \
        src/app/api/zernio/connect/_shared/finalize/__tests__/finalize-modules.test.ts
git commit -m "fix(zernio): null/non-object select-location body → 400 not 500 (#41)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Fix 2 — `pending-transition.ts` null/scalar marker guard

**Files:**
- Modify: `src/app/api/zernio/connect/_shared/finalize/pending-transition.ts` (after the marker-parse `try/catch`, ~line 35)
- Test: `src/app/api/zernio/connect/_shared/finalize/__tests__/finalize-modules.test.ts` (`describe('transitionPendingToFinalizing')`)

- [ ] **Step 1: Write the failing tests**

In `finalize-modules.test.ts`, inside `describe('transitionPendingToFinalizing', ...)`, immediately AFTER the existing test `it('throws 409 malformed_pending_marker when the marker is unparseable', ...)` (ends ~line 475), add (`const redis` is already defined at the top of this `describe`):

```ts
  it('throws 409 malformed_pending_marker for a "null" marker (not 500)', async () => {
    mockRedis.get.mockResolvedValue('null');
    await expectRouteError(
      transitionPendingToFinalizing(redis, STORED),
      409,
      'malformed_pending_marker',
    );
  });

  it('throws 409 malformed_pending_marker for a scalar marker (normalized)', async () => {
    mockRedis.get.mockResolvedValue('42');
    await expectRouteError(
      transitionPendingToFinalizing(redis, STORED),
      409,
      'malformed_pending_marker',
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/app/api/zernio/connect/_shared/finalize/__tests__/finalize-modules.test.ts -t "marker"`
Expected: the two NEW cases FAIL. The `'null'` case rejects with a raw `TypeError` (`null.flowId`). The scalar `'42'` case rejects with `ZernioRouteError(410, 'flow_changed')` (`(42).flowId` is `undefined` ≠ `stored.flowId`). (Existing `marker`-matching tests still pass.)

- [ ] **Step 3: Add the guard**

In `pending-transition.ts`, the current code reads:

```ts
  let parsedPending: { flowId?: string; status?: string } | null;
  try {
    parsedPending = JSON.parse(pendingRaw) as {
      flowId?: string;
      status?: string;
    };
  } catch {
    throw new ZernioRouteError(409, 'malformed_pending_marker');
  }
  if (parsedPending.flowId !== stored.flowId) {
```

Insert the guard between the `catch` block and the `flowId` check:

```ts
  let parsedPending: { flowId?: string; status?: string } | null;
  try {
    parsedPending = JSON.parse(pendingRaw) as {
      flowId?: string;
      status?: string;
    };
  } catch {
    throw new ZernioRouteError(409, 'malformed_pending_marker');
  }
  // A stored `"null"` (or any JSON scalar) parses fine; reading `.flowId` off it
  // would throw a TypeError → 500. Treat a non-object marker as malformed (409).
  if (parsedPending === null || typeof parsedPending !== 'object') {
    throw new ZernioRouteError(409, 'malformed_pending_marker');
  }
  if (parsedPending.flowId !== stored.flowId) {
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/app/api/zernio/connect/_shared/finalize/__tests__/finalize-modules.test.ts -t "marker"`
Expected: ALL `marker`-matching cases PASS (the 2 new + the existing one).

- [ ] **Step 5: Verify HEAD, then commit (explicit paths only)**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "fix/41-zernio-select-location-json-null-hardening" || { echo "WRONG BRANCH"; exit 1; }
git add src/app/api/zernio/connect/_shared/finalize/pending-transition.ts \
        src/app/api/zernio/connect/_shared/finalize/__tests__/finalize-modules.test.ts
git commit -m "fix(zernio): null/non-object pending marker → 409 not 500 (#41)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Item 3 — document the backfill-predicate over-fire (no code change)

**Files:**
- Modify: `src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts` (comment block ~lines 142-147)

- [ ] **Step 1: Append the doc sentence to the existing comment**

In `finalize-tx.ts`, the current comment reads:

```ts
    // Backfill-needed predicate (spec §6.8 round-final M2). Fires when
    // EITHER (a) no prior connect existed for this business OR
    // (b) prior connections existed but no backfill has ever COMPLETED
    // (handles the case where a prior backfill auth-failed mid-flight).
    // The worker's ON CONFLICT (business_id) DO NOTHING on
    // zernio_backfill_runs is the second-line guard.
```

Replace it with:

```ts
    // Backfill-needed predicate (spec §6.8 round-final M2). Fires when
    // EITHER (a) no prior connect existed for this business OR
    // (b) prior connections existed but no backfill has ever COMPLETED
    // (handles the case where a prior backfill auth-failed mid-flight).
    // The worker's ON CONFLICT (business_id) DO NOTHING on
    // zernio_backfill_runs is the second-line guard.
    //
    // KNOWN over-fire (issue #41 item 3, intentionally NOT fixed): on a
    // single-row reconnect, clause (a)'s `id != connectionId AND connected_at
    // IS NOT NULL` is always false (the only row is the one just updated,
    // excluded by id), so the predicate returns true and re-enqueues backfill
    // even when one already completed. This is benign — the ON CONFLICT guard
    // above makes the re-enqueue idempotent. A fix would gate clause (a) on the
    // PRE-update connected_at, but (a)/(b) are entangled and a wrong gate could
    // suppress the legitimate auth-failed-mid-flight re-fire, so we leave it.
```

- [ ] **Step 2: Verify it still type-checks (comment-only change must not break the file)**

Run: `pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Verify HEAD, then commit (explicit path only)**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "fix/41-zernio-select-location-json-null-hardening" || { echo "WRONG BRANCH"; exit 1; }
git add src/app/api/zernio/connect/_shared/finalize/finalize-tx.ts
git commit -m "docs(zernio): document benign backfill-predicate over-fire (#41)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Full verification + open PR

**Files:** none (validation + delivery only)

- [ ] **Step 1: Run the full local gate**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: lint clean; typecheck clean; all tests pass including the 4 new cases (finalize-modules now 43 tests). No DB/schema touched → tenant-scope/RLS audits not required.

- [ ] **Step 2: Verify HEAD + clean tree, then push the branch**

```bash
test "$(git rev-parse --abbrev-ref HEAD)" = "fix/41-zernio-select-location-json-null-hardening" || { echo "WRONG BRANCH"; exit 1; }
git status --short   # expect empty
git push -u origin fix/41-zernio-select-location-json-null-hardening
```

- [ ] **Step 3: Open the PR (CI on the pushed branch is the authoritative signal per CLAUDE.md)**

```bash
gh pr create --repo RepWorth/ai-review-responder \
  --base main \
  --title "fix(zernio): harden select-location JSON-null edge cases (#41)" \
  --body "Closes #41 (items 1 & 2; item 3 documented as intentionally deferred).

## Items 1 & 2 — correctness fixes (500 → typed error)
- \`authorize.ts\`: a literal \`null\` (or non-object) JSON body parsed to \`null\`, then \`null.locationId\` threw a TypeError → 500. Now a post-parse object guard throws **400 \`invalid_body\`**.
- \`pending-transition.ts\`: a stored \`\"null\"\` (or scalar) pending marker parsed to \`null\`, then \`null.flowId\` threw → 500. Now a post-parse object guard throws **409 \`malformed_pending_marker\`** (matches the catch-branch code).
- Both guards also normalize scalar non-null inputs (\`42\`/\`\"x\"\`/\`true\`) to the typed error — a deliberate, tested wire-behavior change for pathological inputs.

## Item 3 — documented, intentionally NOT fixed
The \`needs_backfill\` predicate over-fires on single-row reconnect, but the re-enqueue is idempotent (worker \`ON CONFLICT (business_id) DO NOTHING\`). A predicate change risks suppressing the legitimate auth-failed-mid-flight backfill re-fire, so the behavior is documented in-code instead.

## Tests
4 new cases in \`finalize-modules.test.ts\` (null + scalar, for body and marker). Full \`lint && typecheck && test\` green locally.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: PR URL printed. Then wait for the 4 CI checks (lint, typecheck, test, build) to go green before requesting merge.

---

## Notes for the implementer

- **Worktree discipline (lab notes):** this is a sibling worktree OUTSIDE the main repo, so local lint/test are reliable here — but CI on the pushed branch remains the authoritative signal. Re-verify `git rev-parse --abbrev-ref HEAD` before every commit (each commit step does this) and `git add` by explicit path so concurrent churn in sibling worktrees can't ride along.
- **Do not** swap the permissive `locationId` parser for preflight's UUID validator (`authorize.ts:34-37` documents why).
- **Do not** modify the `needs_backfill` predicate SQL — item 3 is documentation only.
