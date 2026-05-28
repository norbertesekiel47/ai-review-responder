# edit-publish.ts Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 910-LOC `worker/jobs/publisher/edit-publish.ts` into an orchestrator + two cohesive sibling modules without changing any behavior.

**Architecture:** Strictly acyclic three-file graph — `edit-publish-tx.ts` (leaf: in-tx row mutations) ← `edit-publish-errors.ts` (delete/post/409 error disposition) ← `edit-publish.ts` (orchestrator). The two big inline catch blocks inside `runEditPublishIfApplicable` become named handlers that return a discriminated outcome the orchestrator records and acts on. The public surface and the sole consumer (`ResponsePublisherWorker.ts`) are untouched.

**Tech Stack:** TypeScript (strict), Postgres.js (`sql` / `tx` tagged templates), Vitest, BullMQ worker code. Spec: [`docs/superpowers/specs/2026-05-27-edit-publish-modularization-design.md`](../specs/2026-05-27-edit-publish-modularization-design.md).

---

## This is a refactor-under-test, not feature TDD

There are **no new tests** (decided in brainstorming). The safety net is the existing suite. Every task ends by running it and confirming **64 passed**, then committing. The "test" step in each task is *running the existing net*, not writing a new failing test.

**Move convention:** functions moved *unchanged* are identified by **name + original line range** (e.g. "move `supersedeSibling`, lines 739–748, verbatim, add `export`") — the engineer cuts the existing body; do not re-transcribe it (transcription risks drift, and line numbers shift as earlier tasks edit the file, so the function *name* is the source of truth). Every piece of **genuinely new** code (the catch handlers, type definitions, import blocks, orchestrator catch replacements) is shown in full.

**Safety-net command (used verbatim in every task):**

```bash
pnpm vitest run \
  worker/jobs/publisher/__tests__/edit-publish.test.ts \
  worker/jobs/publisher/__tests__/integration-edit-existing-reply.test.ts \
  worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts
```

Expected after every task: `Test Files  3 passed (3)` / `Tests  64 passed (64)`.

**Branch:** `refactor/edit-publish-modularization` (already created; the design spec is already committed on it).

---

## File map

| File | Status | Responsibility |
|---|---|---|
| `worker/jobs/publisher/edit-publish-tx.ts` | **new** | L1 in-tx row mutations (leaf) |
| `worker/jobs/publisher/edit-publish-errors.ts` | **new** | delete/post/409 error disposition + outcome types |
| `worker/jobs/publisher/edit-publish.ts` | **modify** | orchestrator only (Phase A, tx skeleton, outcome dispatch) |

No other source file changes. `ResponsePublisherWorker.ts` and all tests stay byte-identical.

---

## Task 0: Confirm green baseline

**Files:** none.

- [ ] **Step 1: Run the safety net**

```bash
pnpm vitest run \
  worker/jobs/publisher/__tests__/edit-publish.test.ts \
  worker/jobs/publisher/__tests__/integration-edit-existing-reply.test.ts \
  worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts
```

Expected: `Tests  64 passed (64)`. If not green, STOP — do not refactor on a red baseline.

---

## Task 1: Extract L1 in-tx mutations into `edit-publish-tx.ts`

Move the four mutation helpers verbatim (bodies unchanged). They already take `tx` as a parameter, so they are pure leaf functions.

**Files:**
- Create: `worker/jobs/publisher/edit-publish-tx.ts`
- Modify: `worker/jobs/publisher/edit-publish.ts` (remove the four functions; import them instead)

- [ ] **Step 1: Create `edit-publish-tx.ts` with the four mutations**

Create the file with this header, then **move verbatim** (cut from `edit-publish.ts`) the bodies of `supersedeSibling` (current lines 739–748), `setOrphanMarker` (750–766), `markCandidatePermanentFailedInTx` (768–804), and `applyAuthErrorTerminalInTx` (806–910). Add `export` to each. Keep their existing doc-comments with them.

```ts
// worker/jobs/publisher/edit-publish-tx.ts
//
// L1 in-tx row mutations for the edit-publisher DELETE-before-POST flow
// (spec docs/superpowers/specs/2026-05-01-edit-existing-replies-design.md §4.5).
// Each helper runs on an already-open transaction (`tx`), enforces the
// publishable-status guard, and asserts the affected-row count so a lost row
// fails loudly. Leaf module: no imports from edit-publish.ts / -errors.ts.

import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { jsonb } from '../../../src/lib/db/server';
import { redactSensitiveError } from './publisher-error-handlers';
import {
  PENDING_AFTER_DELETE,
  ZERNIO_AUTH_ERROR,
  ZERNIO_AUTH_ERROR_AFTER_DELETE,
  postAfterDeleteFailedMarker,
} from './orphan-markers';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import type { SendOwnerEmailPayload } from '../../../src/lib/shared/worker-types';

// --- moved verbatim from edit-publish.ts, each prefixed with `export` ---
// export async function supersedeSibling(...) { ... }            // was 739–748
// export async function setOrphanMarker(...) { ... }             // was 750–766
// export async function markCandidatePermanentFailedInTx(...) {} // was 768–804
// export async function applyAuthErrorTerminalInTx(...) { ... }  // was 806–910
```

The four function bodies are unchanged from the originals — copy them exactly, only adding the `export` keyword. `markCandidatePermanentFailedInTx` calls `supersedeSibling` (now same-file). `applyAuthErrorTerminalInTx` calls `supersedeSibling` (same-file) and `redactSensitiveError` (imported above).

- [ ] **Step 2: Update `edit-publish.ts` — delete the four functions, import them**

In `edit-publish.ts`, delete the four function definitions you just moved (the whole `// ── Shared in-tx mutation helpers ──` section through end of file, lines 737–910). Add an import near the other `./` imports:

```ts
import {
  applyAuthErrorTerminalInTx,
  markCandidatePermanentFailedInTx,
  setOrphanMarker,
  supersedeSibling,
} from './edit-publish-tx';
```

At this point `handle409Disposition` and the inline catch blocks still live in `edit-publish.ts` and now call the imported helpers. Do not change anything else yet.

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: no errors. (If TS complains about an unused import like `SendOwnerEmailPayload` or `jsonb` in `edit-publish.ts`, that import is now dead in the orchestrator and should be removed — but leave the final import sweep to Task 5 unless typecheck *fails*.)

- [ ] **Step 4: Run the safety net**

```bash
pnpm vitest run \
  worker/jobs/publisher/__tests__/edit-publish.test.ts \
  worker/jobs/publisher/__tests__/integration-edit-existing-reply.test.ts \
  worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts
```

Expected: `Tests  64 passed (64)`.

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/publisher/edit-publish-tx.ts worker/jobs/publisher/edit-publish.ts
git commit -m "refactor(publisher): extract edit-publish in-tx mutations into edit-publish-tx.ts

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Extract 409 disposition core into `edit-publish-errors.ts`

Move `handle409Disposition`, `indeterminateError`, `permanentErrorKind`, and the `Tx409Outcome` / args types into the new errors module. The orchestrator's inline POST-catch still calls them (imported).

**Files:**
- Create: `worker/jobs/publisher/edit-publish-errors.ts`
- Modify: `worker/jobs/publisher/edit-publish.ts`

- [ ] **Step 1: Create `edit-publish-errors.ts` with the disposition core**

Create the file. **Move verbatim** from `edit-publish.ts`: `permanentErrorKind` (current lines 126–128), the `Handle409Args` interface (526–538) **renamed to `EditPublishCatchArgs`**, the `Tx409Outcome` type (540–546), `handle409Disposition` (548–719), and `indeterminateError` (721–735). Add `export` to `handle409Disposition`, `permanentErrorKind`, `EditPublishCatchArgs`, and `Tx409Outcome`. Keep `indeterminateError` un-exported (private). Update the two `args: Handle409Args` annotations (in `handle409Disposition` and `indeterminateError`) to `args: EditPublishCatchArgs`.

```ts
// worker/jobs/publisher/edit-publish-errors.ts
//
// Error-disposition policy for the edit-publisher DELETE-before-POST flow
// (spec §4.5 outcome table). Given an error from the external DELETE/POST call,
// decides the per-CATCH commit semantics: which rows to mutate (via the -tx
// helpers) and which TxCatchOutcome to hand back to the orchestrator. Imports
// the -tx leaf; never imports edit-publish.ts (keeps the graph acyclic).

import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import { jsonb } from '../../../src/lib/db/server';
import {
  ZernioPermanentError,
  ZernioValidationError,
} from '../../../src/lib/zernio/errors';
import {
  PublisherTransientWithContext,
  ZernioReplyVerificationIndeterminateError,
  type Verify409Disposition,
} from './publisher-error-handlers';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import {
  applyAuthErrorTerminalInTx,
  markCandidatePermanentFailedInTx,
  setOrphanMarker,
  supersedeSibling,
} from './edit-publish-tx';

export interface EditPublishCatchArgs {
  responseId: string;
  businessId: string;
  reviewId: string;
  approvedText: string;
  zernioAccountId: string;
  zernioLocationId: string;
  zernioReviewId: string;
  existingPosted: { id: string } | undefined;
  postDeleteCommitted: boolean;
  lockedIsOrphanRetry: boolean;
  logger: WorkerLogger;
}

export type Tx409Outcome =
  | { kind: '409_matches' }
  | { kind: '409_mismatch_after_delete' }
  | { kind: '409_mismatch_no_delete' }
  | { kind: 'permanent_failed' }
  | { kind: 'auth_completed' }
  | { kind: 'commit_then_throw'; error: Error };

export function permanentErrorKind(
  err: ZernioPermanentError | ZernioValidationError,
): string {
  return err instanceof ZernioPermanentError ? err.kind ?? 'unknown' : 'validation';
}

// export async function handle409Disposition(tx, disp, args: EditPublishCatchArgs): Promise<Tx409Outcome>
//   ... moved verbatim from edit-publish.ts 548–719 (body unchanged; only the
//   args type annotation becomes EditPublishCatchArgs) ...

// function indeterminateError(disp, args: EditPublishCatchArgs): ZernioReplyVerificationIndeterminateError
//   ... moved verbatim from edit-publish.ts 721–735 (private) ...
```

`handle409Disposition`'s body is unchanged: it calls `supersedeSibling`, `setOrphanMarker`, `markCandidatePermanentFailedInTx`, `applyAuthErrorTerminalInTx` (all imported from `-tx`), `permanentErrorKind` and `indeterminateError` (same file), `uuidv7` + `jsonb` (the `review_exceptions` insert), and reads `disp: Verify409Disposition`.

- [ ] **Step 2: Update `edit-publish.ts` — delete moved code, import it**

In `edit-publish.ts`: delete `permanentErrorKind` (126–128), the `Handle409Args` interface (526–538), `Tx409Outcome` (540–546), `handle409Disposition` (548–719), `indeterminateError` (721–735), and the `// ── 409 disposition handling ──` section banner. Add:

```ts
import { handle409Disposition, permanentErrorKind } from './edit-publish-errors';
```

The orchestrator's inline POST-catch still references `handle409Disposition` and `permanentErrorKind` — both now imported. The call site that builds the args object literal for `handle409Disposition` is unchanged (object literals are structurally compatible with `EditPublishCatchArgs`).

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4: Run the safety net**

```bash
pnpm vitest run \
  worker/jobs/publisher/__tests__/edit-publish.test.ts \
  worker/jobs/publisher/__tests__/integration-edit-existing-reply.test.ts \
  worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts
```

Expected: `Tests  64 passed (64)`.

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/publisher/edit-publish-errors.ts worker/jobs/publisher/edit-publish.ts
git commit -m "refactor(publisher): extract 409 disposition into edit-publish-errors.ts

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Extract the DELETE-catch into `handleDeleteError`

Replace the inline DELETE catch body with a named handler that returns a `TxCatchOutcome`. `isDeleteAlreadyGone` stays inline in the orchestrator (it continues to POST — not a terminal outcome).

**Files:**
- Modify: `worker/jobs/publisher/edit-publish-errors.ts` (add `TxCatchOutcome`, `DeleteErrorArgs`, `handleDeleteError`)
- Modify: `worker/jobs/publisher/edit-publish.ts` (replace DELETE catch body)

- [ ] **Step 1: Add `TxCatchOutcome`, `DeleteErrorArgs`, `handleDeleteError` to `edit-publish-errors.ts`**

Extend the `zernio/errors` import to add `ZernioAuthError` and `ZernioTransientError`, and the `orphan-markers` import for `deleteFailedMarker`:

```ts
import {
  ZernioAuthError,
  ZernioPermanentError,
  ZernioTransientError,
  ZernioValidationError,
} from '../../../src/lib/zernio/errors';
import { deleteFailedMarker } from './orphan-markers';
```

Add the superset outcome type (place it near `Tx409Outcome`):

```ts
/** Every outcome a DELETE/POST catch handler can produce. Superset of Tx409Outcome. */
export type TxCatchOutcome =
  | { kind: 'auth_completed' }
  | { kind: 'permanent_failed' }
  | { kind: '409_matches' }
  | { kind: '409_mismatch_after_delete' }
  | { kind: '409_mismatch_no_delete' }
  | { kind: 'commit_then_throw'; error: Error }
  | { kind: 'rollback_then_throw'; error: Error };
```

Add the handler:

```ts
export interface DeleteErrorArgs {
  responseId: string;
  businessId: string;
  zernioAccountId: string;
  zernioLocationId: string;
  logger: WorkerLogger;
}

/**
 * Disposition for an error thrown by the DELETE call. The orchestrator handles
 * the 404-as-success case (isDeleteAlreadyGone) inline BEFORE calling this, so
 * here the DELETE genuinely failed and the sibling 'posted' row is UNCHANGED on
 * Google. Returns the outcome the orchestrator records; programming/unknown
 * errors are re-thrown to bubble to the outer catch.
 */
export async function handleDeleteError(
  tx: postgres.TransactionSql,
  err: unknown,
  args: DeleteErrorArgs,
): Promise<TxCatchOutcome> {
  const { responseId, businessId, zernioAccountId, zernioLocationId, logger } = args;

  if (err instanceof ZernioAuthError) {
    // True 401/403 on DELETE. DELETE did not succeed externally — plain
    // 'zernio_auth_error' (no orphan suffix), sibling untouched.
    await applyAuthErrorTerminalInTx(tx, {
      responseId,
      businessId,
      accountId: zernioAccountId,
      locationId: zernioLocationId,
      errorBody: err.body ? String(err.body).slice(0, 500) : err.message,
      postDeleteCommitted: false,
      existingPosted: null,
      logger,
    });
    return { kind: 'auth_completed' };
  }

  if (err instanceof ZernioTransientError) {
    // Nothing externally committed → orchestrator throws to ROLLBACK + retry.
    return {
      kind: 'rollback_then_throw',
      error: new PublisherTransientWithContext(err, {
        response_id: responseId,
        business_id: businessId,
        account_id: zernioAccountId,
        location_id: zernioLocationId,
      }),
    };
  }

  if (err instanceof ZernioPermanentError) {
    // DELETE permanent failure (incl. inbox_addon_required). Sibling unchanged.
    const kind = err.kind ?? 'unknown';
    const updated = await tx`
      UPDATE responses
      SET status = 'failed',
          posting_error = ${deleteFailedMarker(kind)},
          updated_at = NOW()
      WHERE id = ${responseId}
        AND business_id = ${businessId}
        AND status IN ('approved', 'edited', 'awaiting_owner_connect')
      RETURNING 1
    `;
    if (updated.count !== 1) {
      throw new Error(
        `delete-permanent: candidate UPDATE expected 1 row, got ${updated.count}`,
      );
    }
    return { kind: 'permanent_failed' };
  }

  // Programming bug / unknown error → bubble to the outer catch.
  throw err;
}
```

- [ ] **Step 2: Replace the DELETE catch in `edit-publish.ts`**

Find the DELETE branch in `runEditPublishIfApplicable` (current lines 286–348). Replace the `try { await zernioClient.deleteReply(...) ... } catch (err) { ... }` block with:

```ts
      let deleteSucceeded = false;
      if (existingPosted) {
        try {
          await zernioClient.deleteReply(zernioAccountId, zernioReviewId);
          deleteSucceeded = true;
        } catch (err) {
          if (isDeleteAlreadyGone(err)) {
            // 404 → reply already gone. Treat as DELETE success; proceed to POST.
            deleteSucceeded = true;
          } else {
            const outcome = await handleDeleteError(tx, err, {
              responseId,
              businessId,
              zernioAccountId,
              zernioLocationId,
              logger,
            });
            outcomeRef.value = outcome;
            if (outcome.kind === 'rollback_then_throw') throw outcome.error;
            return;
          }
        }
      }
```

Add `handleDeleteError` to the `./edit-publish-errors` import:

```ts
import { handle409Disposition, handleDeleteError, permanentErrorKind } from './edit-publish-errors';
```

Leave `isDeleteAlreadyGone` defined in `edit-publish.ts` (unchanged). The orchestrator's `outcomeRef` is still typed by the existing inline `TxOutcome` union; `TxCatchOutcome` values are structurally assignable to it, so no type change is needed in this task.

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: no errors.

- [ ] **Step 4: Run the safety net**

```bash
pnpm vitest run \
  worker/jobs/publisher/__tests__/edit-publish.test.ts \
  worker/jobs/publisher/__tests__/integration-edit-existing-reply.test.ts \
  worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts
```

Expected: `Tests  64 passed (64)`. (The DELETE auth / transient / permanent / already-gone branches are covered by `edit-publish.test.ts`.)

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/publisher/edit-publish-errors.ts worker/jobs/publisher/edit-publish.ts
git commit -m "refactor(publisher): extract DELETE-catch into handleDeleteError

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Extract the POST-catch into `handlePostError`

Replace the inline POST catch body with a named handler. This is the largest extraction (auth / transient ×3 sub-cases / permanent / 409). It reuses `EditPublishCatchArgs` and receives the resolved `verify409InTx` dep.

**Files:**
- Modify: `worker/jobs/publisher/edit-publish-errors.ts` (add `handlePostError`)
- Modify: `worker/jobs/publisher/edit-publish.ts` (replace POST catch body; redefine `TxOutcome`)

- [ ] **Step 1: Add `handlePostError` to `edit-publish-errors.ts`**

Extend the `zernio/errors` import to add `ZernioReplyAlreadyExistsError`, and import the default verify fn (for its type and as the param):

```ts
import {
  ZernioAuthError,
  ZernioPermanentError,
  ZernioReplyAlreadyExistsError,
  ZernioTransientError,
  ZernioValidationError,
} from '../../../src/lib/zernio/errors';
import {
  PublisherTransientWithContext,
  ZernioReplyVerificationIndeterminateError,
  verify409InTx as defaultVerify409InTx,
  type Verify409Disposition,
} from './publisher-error-handlers';
```

Add the handler (body is the current POST catch, lines 360–456, re-expressed to `return` outcomes instead of mutating `outcomeRef` / throwing inline):

```ts
/**
 * Disposition for an error thrown by the POST call. Applies the §4.5 per-CATCH
 * commit semantics: returns commit_then_throw for the indeterminate/transient
 * sub-cases that committed a sibling supersede, rollback_then_throw for the
 * no-external-commit cases, and terminal outcomes otherwise. The 409 path
 * verifies the live reply (verify409InTx) then defers to handle409Disposition.
 * Programming/unknown errors are re-thrown to bubble to the outer catch.
 */
export async function handlePostError(
  tx: postgres.TransactionSql,
  err: unknown,
  args: EditPublishCatchArgs,
  verify409InTx: typeof defaultVerify409InTx,
): Promise<TxCatchOutcome> {
  const {
    responseId,
    businessId,
    approvedText,
    zernioAccountId,
    zernioLocationId,
    zernioReviewId,
    existingPosted,
    postDeleteCommitted,
    lockedIsOrphanRetry,
    logger,
  } = args;

  if (err instanceof ZernioReplyAlreadyExistsError) {
    const disp = await verify409InTx({
      tx,
      account_id: zernioAccountId,
      location_id: zernioLocationId,
      zernio_review_id: zernioReviewId,
      approved_text: approvedText,
      logger,
    });
    return handle409Disposition(tx, disp, args);
  }

  if (err instanceof ZernioAuthError) {
    await applyAuthErrorTerminalInTx(tx, {
      responseId,
      businessId,
      accountId: zernioAccountId,
      locationId: zernioLocationId,
      errorBody: err.body ? String(err.body).slice(0, 500) : err.message,
      postDeleteCommitted,
      existingPosted: postDeleteCommitted && existingPosted ? { id: existingPosted.id } : null,
      logger,
    });
    return { kind: 'auth_completed' };
  }

  if (err instanceof ZernioTransientError) {
    if (postDeleteCommitted && existingPosted) {
      // DELETE succeeded externally — commit the sibling supersede + orphan
      // marker so the retry's no-DELETE path keeps post-DELETE semantics.
      await supersedeSibling(tx, existingPosted.id);
      await setOrphanMarker(tx, responseId, businessId);
      return {
        kind: 'commit_then_throw',
        error: new PublisherTransientWithContext(err, {
          response_id: responseId,
          business_id: businessId,
          account_id: zernioAccountId,
          location_id: zernioLocationId,
        }),
      };
    }
    if (lockedIsOrphanRetry) {
      // Already orphan; posting_error stays. Commit (nothing changed) + retry.
      return {
        kind: 'commit_then_throw',
        error: new PublisherTransientWithContext(err, {
          response_id: responseId,
          business_id: businessId,
          account_id: zernioAccountId,
          location_id: zernioLocationId,
        }),
      };
    }
    // No external commit → ROLLBACK + retry.
    return {
      kind: 'rollback_then_throw',
      error: new PublisherTransientWithContext(err, {
        response_id: responseId,
        business_id: businessId,
        account_id: zernioAccountId,
        location_id: zernioLocationId,
      }),
    };
  }

  if (err instanceof ZernioPermanentError || err instanceof ZernioValidationError) {
    await markCandidatePermanentFailedInTx(tx, {
      responseId,
      businessId,
      postDeleteCommitted,
      existingPosted,
      kind: permanentErrorKind(err),
    });
    return { kind: 'permanent_failed' };
  }

  // Unknown error — bubble to the outer catch.
  throw err;
}
```

Note: `ZernioReplyVerificationIndeterminateError` stays imported because `indeterminateError` (called by `handle409Disposition`) uses it.

- [ ] **Step 2: Replace the POST catch in `edit-publish.ts` and redefine `TxOutcome`**

Replace the POST branch (current lines 356–456) `try { await zernioClient.postReply(...) } catch (err) { ... }` with:

```ts
      // 6. POST branch.
      try {
        await zernioClient.postReply(zernioAccountId, zernioReviewId, {
          comment: approvedText,
        });
      } catch (err) {
        const outcome = await handlePostError(
          tx,
          err,
          {
            responseId,
            businessId,
            reviewId,
            approvedText,
            zernioAccountId,
            zernioLocationId,
            zernioReviewId,
            existingPosted,
            postDeleteCommitted,
            lockedIsOrphanRetry,
            logger,
          },
          verify409InTx,
        );
        outcomeRef.value = outcome;
        if (outcome.kind === 'rollback_then_throw') throw outcome.error;
        return;
      }
```

Replace the inline `TxOutcome` union (current lines 192–204) with one built on the imported `TxCatchOutcome`:

```ts
    type TxOutcome =
      | TxCatchOutcome
      | { kind: 'continue_to_fresh' }
      | { kind: 'idempotent_completed' }
      | { kind: 'review_id_drift' }
      | { kind: 'orphan_response_review' }
      | { kind: 'success' };
```

Update the import to add the types:

```ts
import {
  handle409Disposition,
  handleDeleteError,
  handlePostError,
  permanentErrorKind,
  type TxCatchOutcome,
} from './edit-publish-errors';
```

The post-commit dispatch `switch` (current lines 494–521) is unchanged — it already enumerates every kind, including the `commit_then_throw` / `rollback_then_throw` / 409 cases.

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: no errors. The `switch` must remain exhaustive over the new `TxOutcome`; if TS reports a non-exhaustive switch, you changed a `kind` name — revert to the exact strings above.

- [ ] **Step 4: Run the safety net**

```bash
pnpm vitest run \
  worker/jobs/publisher/__tests__/edit-publish.test.ts \
  worker/jobs/publisher/__tests__/integration-edit-existing-reply.test.ts \
  worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts
```

Expected: `Tests  64 passed (64)`. (POST auth / transient ×3 / permanent / validation / 409 ×5 dispositions are all covered.)

- [ ] **Step 5: Commit**

```bash
git add worker/jobs/publisher/edit-publish-errors.ts worker/jobs/publisher/edit-publish.ts
git commit -m "refactor(publisher): extract POST-catch into handlePostError; slim orchestrator

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Tidy imports, relocate header comments, un-export private helper, final gate

**Files:**
- Modify: `worker/jobs/publisher/edit-publish.ts`
- Modify: `worker/jobs/publisher/edit-publish-errors.ts`

- [ ] **Step 1: Remove dead imports from `edit-publish.ts`**

After Task 4, the orchestrator no longer uses several imports. The orchestrator now uses ONLY: `Sentry` (captureMessage for `orphan_response_review` / `review_id_drift`), `sql` (Phase A + `sql.begin`), `defaultZernioClient`, `ZernioPermanentError` + `ZernioReplyAlreadyDeletedError` (for `isDeleteAlreadyGone`), `defaultVerify409InTx` + `EditPublishDeps`'s use of its type, `isOrphanMarker`, `WorkerLogger` type, `PostedResponseActivationInput` type, `supersedeSibling` (success path), and the `-errors` handlers/types. The orchestrator's final import block should be:

```ts
import * as Sentry from '@sentry/node';
import { sql } from '../../../src/lib/db/server';
import { zernioClient as defaultZernioClient } from '../../../src/lib/zernio/client';
import {
  ZernioPermanentError,
  ZernioReplyAlreadyDeletedError,
} from '../../../src/lib/zernio/errors';
import { verify409InTx as defaultVerify409InTx } from './publisher-error-handlers';
import type { WorkerLogger } from '../../../src/lib/shared/logger';
import type { PostedResponseActivationInput } from './activation';
import { isOrphanMarker } from './orphan-markers';
import {
  handle409Disposition,
  handleDeleteError,
  handlePostError,
  permanentErrorKind,
  type TxCatchOutcome,
} from './edit-publish-errors';
import { supersedeSibling } from './edit-publish-tx';
```

Then remove anything no longer referenced. After this sweep, `permanentErrorKind` and `handle409Disposition` are NOT used directly by the orchestrator (only by `handlePostError` inside `-errors`) — drop them from the `-errors` import, leaving:

```ts
import {
  handleDeleteError,
  handlePostError,
  type TxCatchOutcome,
} from './edit-publish-errors';
```

Confirm by searching the file:

```bash
grep -nE 'permanentErrorKind|handle409Disposition|jsonb|uuidv7|SendOwnerEmailPayload|PublisherTransientWithContext|ZernioAuthError|ZernioTransientError|ZernioValidationError|ZernioReplyAlreadyExistsError|redactSensitiveError|Verify409Disposition' worker/jobs/publisher/edit-publish.ts
```

Expected: **no matches** (none of these should remain referenced in the orchestrator). If any match, it is a leftover usage — investigate before deleting the import.

- [ ] **Step 2: Un-export `handle409Disposition` in `edit-publish-errors.ts`**

`handle409Disposition` is now called only by `handlePostError` (same file). Remove its `export` keyword so it is private, matching the spec ("private sub-routine of handlePostError"). Leave `Tx409Outcome` exported only if still referenced externally; if `grep -rn 'Tx409Outcome' worker/jobs/publisher --include='*.ts' | grep -v edit-publish-errors.ts` returns nothing, remove its `export` too (keep the type, drop the keyword).

- [ ] **Step 3: Relocate the file header comment**

The current `edit-publish.ts` header (lines 1–28) describes the whole flow. Trim it to the orchestration concern and add one line pointing readers to the two new modules. Keep the architectural rationale that still applies to the orchestrator (Phase A pre-flight, per-CATCH commit semantics overview, the one-open-tx locking note). Add near the top:

```ts
// Error disposition (per-CATCH §4.5 commit semantics) lives in
// `./edit-publish-errors`; the in-tx row mutations live in `./edit-publish-tx`.
```

No behavior change — comment edits only.

- [ ] **Step 4: Typecheck + lint**

```bash
pnpm typecheck && pnpm lint
```

Expected: both pass with no errors. (Lint will catch any remaining unused import or `import/no-cycle` violation — there should be none.)

- [ ] **Step 5: Full test suite**

```bash
pnpm test
```

Expected: full suite green (includes the 64 publisher tests). If `pnpm test` is too broad for a quick loop, the targeted safety-net command must still be green:

```bash
pnpm vitest run \
  worker/jobs/publisher/__tests__/edit-publish.test.ts \
  worker/jobs/publisher/__tests__/integration-edit-existing-reply.test.ts \
  worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts
```

Expected: `Tests  64 passed (64)`.

- [ ] **Step 6: Verify final shape**

```bash
wc -l worker/jobs/publisher/edit-publish.ts \
      worker/jobs/publisher/edit-publish-tx.ts \
      worker/jobs/publisher/edit-publish-errors.ts
```

Expected: `edit-publish.ts` ≈ 300 (down from 910); `-tx` ≈ 180; `-errors` ≈ 360. Confirm `runEditPublishIfApplicable` no longer contains an inline error-handling branch over ~30 lines:

```bash
grep -nE 'instanceof Zernio' worker/jobs/publisher/edit-publish.ts
```

Expected: only the two lines inside `isDeleteAlreadyGone` (the `ZernioReplyAlreadyDeletedError` / `ZernioPermanentError` checks). No `instanceof ZernioAuthError|ZernioTransientError|ZernioValidationError|ZernioReplyAlreadyExistsError` should remain in the orchestrator.

- [ ] **Step 7: Commit**

```bash
git add worker/jobs/publisher/edit-publish.ts worker/jobs/publisher/edit-publish-errors.ts
git commit -m "refactor(publisher): tidy edit-publish imports, privatize handle409Disposition, relocate header

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Done criteria (verify before opening PR)

- [ ] Three files exist; dependency graph acyclic (`edit-publish` → `edit-publish-errors` → `edit-publish-tx`; `edit-publish` → `edit-publish-tx` for `supersedeSibling`).
- [ ] Public surface unchanged: `runEditPublishIfApplicable` + `EditPublishContext` / `EditPublishDeps` / `EditPublishOutcome` exported from `edit-publish.ts`; `ResponsePublisherWorker.ts` import untouched.
- [ ] `runEditPublishIfApplicable` is a skeleton (~150 lines); no inline error-handling branch >30 lines.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` green; the 64 publisher tests green at every task boundary.
- [ ] No new test files; no change to `publisher-error-handlers.ts`, `orphan-markers.ts`, `activation.ts` beyond nothing (they are not modified).

## PR

Open a PR to `main` (protected — direct push rejected). The 4 CI checks (lint, typecheck, test, build) must be green. Title:

```
refactor(publisher): modularize edit-publish.ts (910 → orchestrator + tx + errors)
```
