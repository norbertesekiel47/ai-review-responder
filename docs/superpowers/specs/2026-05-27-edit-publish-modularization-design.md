# edit-publish.ts modularization — design

_Date: 2026-05-27 · Status: approved, ready for plan · Branch:
`refactor/edit-publish-modularization`_

## Problem

`worker/jobs/publisher/edit-publish.ts` is 910 LOC. Per
[`docs/modular-requirement.md`](../../modular-requirement.md) it is Tier-1
modularization debt of shape "one giant function hiding several concerns on a
production failure path":

- `runEditPublishIfApplicable` ≈ **380 lines**; `handle409Disposition` ≈ **167
  lines** — two functions are ~60% of the file.
- The file bundles three concerns: publish **orchestration**, the §4.5 **409
  /error disposition** sub-system, and the raw **in-tx row mutations** they share.
- The DELETE-catch (~56 lines) and POST-catch (~96 lines) inside
  `runEditPublishIfApplicable` are exactly the >30-line error-handling branches
  CLAUDE.md **invariant #12** says to extract into named modules.
  `production.md` cares because conflict/terminal-failure logic buried in a
  380-line function obscures failure isolation.

This is a **behavior-preserving refactor**. No functional change. The public
surface and all external behavior stay byte-identical; the existing test suite
is the safety net.

## Goals / non-goals

**Goals**
- Split the file into an orchestrator + two cohesive sibling modules with a
  strictly acyclic dependency graph.
- Shrink `runEditPublishIfApplicable` from ~380 lines to a readable skeleton by
  extracting the DELETE-catch and POST-catch into named handlers.
- Keep the public surface (`runEditPublishIfApplicable`, `EditPublishContext`,
  `EditPublishDeps`, `EditPublishOutcome`) and the sole consumer
  (`ResponsePublisherWorker.ts`) untouched.

**Non-goals**
- No new test files (existing 64 tests across 3 suites are the safety net —
  invariant #12's "focused tests" is satisfied de facto by existing branch
  coverage).
- No change to the `outcomeRef` box pattern, the per-CATCH commit semantics, the
  lock ordering, or the §4.5 outcome table.
- No change to `publisher-error-handlers.ts`, `orphan-markers.ts`, or
  `activation.ts` beyond import wiring.

## Current public surface (must stay stable)

```ts
export interface EditPublishContext { ... }
export interface EditPublishDeps { ... }
export type EditPublishOutcome = ...
export async function runEditPublishIfApplicable(context, deps): Promise<EditPublishOutcome>
```

Sole consumer: `worker/jobs/publisher/ResponsePublisherWorker.ts:13`
(`import { runEditPublishIfApplicable } from './edit-publish'`).

Test imports: `edit-publish.test.ts` imports only `runEditPublishIfApplicable` +
`EditPublishContext`. Tests mock `../../../../src/lib/db/server` (`sql`,
`jsonb`), `../../../../src/lib/zernio/client`, `uuid`, `@sentry/node` by resolved
module id — so extraction is transparent as long as new files import those same
modules.

## Target architecture

Strictly acyclic, three files (one slimmed, two new):

```
edit-publish-tx.ts      (leaf: raw in-tx row mutations)
        ▲
        │
edit-publish-errors.ts  (error disposition; imports -tx)
        ▲
        │
edit-publish.ts         (orchestrator; imports -errors + -tx)
```

### `edit-publish-tx.ts` (new, ~180 LOC, leaf)

L1 in-tx row mutations — each a status-guarded `UPDATE` + affected-row
assertion. Moved verbatim from `edit-publish.ts`:

- `supersedeSibling(tx, siblingId)`
- `setOrphanMarker(tx, responseId, businessId)`
- `markCandidatePermanentFailedInTx(tx, args)`
- `applyAuthErrorTerminalInTx(tx, args)`

Imports: `postgres` (type), `db/server` (`jsonb`), `uuid` (`v7`),
`orphan-markers` (`PENDING_AFTER_DELETE`, `ZERNIO_AUTH_ERROR`,
`ZERNIO_AUTH_ERROR_AFTER_DELETE`, `postAfterDeleteFailedMarker`),
`publisher-error-handlers` (`redactSensitiveError`), `worker-types`
(`SendOwnerEmailPayload`), `logger` (`WorkerLogger` type). No imports from the
other two new files.

### `edit-publish-errors.ts` (new, ~360 LOC, imports `-tx`)

All error-disposition policy + its outcome vocabulary.

Types (owner of the cross-module outcome contract for error paths):
- `TxCatchOutcome` — union of every kind a catch handler can produce:
  `auth_completed | permanent_failed | rollback_then_throw | commit_then_throw |
  409_matches | 409_mismatch_after_delete | 409_mismatch_no_delete`.
- `Tx409Outcome` — the subset returned by `handle409Disposition`.
- `EditPublishCatchArgs` — the shared args interface (today's `Handle409Args`
  fields), consumed by `handlePostError` and `handle409Disposition`.

Functions:
- `permanentErrorKind(err)` (pure; moved from orchestrator — used only here).
- `indeterminateError(disp, args)` (moved verbatim).
- `handle409Disposition(tx, disp, args): Promise<Tx409Outcome>` (moved verbatim;
  calls the `-tx` mutations).
- `handleDeleteError(tx, err, args): Promise<TxCatchOutcome>` — the DELETE-catch
  body extracted (auth / transient / permanent; DELETE-permanent keeps its own
  inline `UPDATE` with `deleteFailedMarker(kind)`). Unknown error → `throw err`.
- `handlePostError(tx, err, args, verify409InTx): Promise<TxCatchOutcome>` — the
  POST-catch body extracted (409 → `verify409InTx` then `handle409Disposition`;
  auth / transient / permanent | validation). Unknown error → `throw err`.

Imports: `postgres` (type), `db/server` (`jsonb`), `uuid` (`v7`),
`zernio/errors` (the `Zernio*` classes), `publisher-error-handlers`
(`PublisherTransientWithContext`, `ZernioReplyVerificationIndeterminateError`,
`Verify409Disposition` type, `verify409InTx` type), `orphan-markers`
(`deleteFailedMarker`), `worker-types`, `logger` (type), `edit-publish-tx` (the
four mutations). Redaction is encapsulated inside `applyAuthErrorTerminalInTx`
(in `-tx`), so `-errors` never imports `redactSensitiveError`.

### `edit-publish.ts` (slimmed, ~300 LOC, imports `-errors` + `-tx`)

Pure orchestration. Keeps:
- Public types `EditPublishContext`, `EditPublishDeps`, `EditPublishOutcome`.
- L0 pure helpers `isDeleteAlreadyGone`, `postedResponseActivationInput`.
- `type TxOutcome = TxCatchOutcome | { kind: 'continue_to_fresh' } |
  { kind: 'idempotent_completed' } | { kind: 'review_id_drift' } |
  { kind: 'orphan_response_review' } | { kind: 'success' }` — the orchestrator
  owns the happy/early-path kinds and unions in the imported `TxCatchOutcome`.
- `runEditPublishIfApplicable` — Phase A preflight, the `sql.begin` skeleton
  (lock review → lock candidate → sibling detection → DELETE → POST → success),
  the `outcomeRef` box, the outer rollback catch, and the post-commit dispatch
  `switch`.

Imports drop `uuid`, `jsonb`, the `Zernio*` error classes used only by catch
bodies, and `permanentErrorKind`; gains imports of `handleDeleteError`,
`handlePostError` (from `-errors`), `supersedeSibling` (from `-tx`, success
path), and the `TxCatchOutcome` type.

## Behavior-preservation contract (the only control-flow change)

The orchestrator calls the extracted handlers identically at both sites:

```ts
// DELETE site — isDeleteAlreadyGone stays INLINE (it continues to POST,
// it is not a terminal outcome).
try {
  await zernioClient.deleteReply(zernioAccountId, zernioReviewId);
  deleteSucceeded = true;
} catch (err) {
  if (isDeleteAlreadyGone(err)) {
    deleteSucceeded = true;
  } else {
    const outcome = await handleDeleteError(tx, err, { responseId, businessId,
      zernioAccountId, zernioLocationId, logger });
    outcomeRef.value = outcome;
    if (outcome.kind === 'rollback_then_throw') throw outcome.error;
    return;
  }
}

// POST site
try {
  await zernioClient.postReply(zernioAccountId, zernioReviewId, { comment: approvedText });
} catch (err) {
  const outcome = await handlePostError(tx, err, { /* EditPublishCatchArgs */ }, verify409InTx);
  outcomeRef.value = outcome;
  if (outcome.kind === 'rollback_then_throw') throw outcome.error;
  return;
}
```

Invariants that make this byte-identical to today:

1. **Unknown / programming errors**: `handleDeleteError` / `handlePostError`
   `throw err` (do not return). The throw bubbles past the orchestrator catch
   with `outcomeRef` untouched → the outer catch returns
   `{ outcome: 'throw', error: err }` — exactly today's path for the
   `else { throw err }` branches.
2. **`rollback_then_throw`**: handler returns it; orchestrator records it then
   throws `outcome.error` to force ROLLBACK. Outer catch sees
   `captured.kind === 'rollback_then_throw'` → returns
   `{ outcome: 'throw', error: captured.error }`. Same wrapped error as today.
3. **`commit_then_throw`**: handler returns it; orchestrator records and
   `return`s (COMMIT). The re-throw happens only later in the post-commit
   dispatch `switch`. Unchanged.
4. **`verify409InTx` injection seam**: resolved in the orchestrator
   (`deps.verify409InTx ?? defaultVerify409InTx`) and passed into
   `handlePostError`. Tests' injected mock still flows through.
5. **Lock ordering, status guards, affected-row assertions, Sentry messages,
   §4.5 outcome table, orphan-marker strings**: unchanged — code moves verbatim.
6. **Comments move with their code.** The §4.5 per-CATCH rationale relocates to
   `-errors`; the in-tx auth-terminal docstring relocates to `-tx`. Nothing is
   deleted.

## Implementation order (TDD refactor-under-test)

Run the safety-net suites green after **each** step:

```
pnpm vitest run worker/jobs/publisher/__tests__/edit-publish.test.ts \
  worker/jobs/publisher/__tests__/integration-edit-existing-reply.test.ts \
  worker/jobs/publisher/__tests__/ResponsePublisherWorker.test.ts
```

1. **Baseline** — confirm 64/64 green (done at design time).
2. **Create `edit-publish-tx.ts`** — move the four L1 mutations verbatim; export
   them; update `edit-publish.ts` to import them. Run suites.
3. **Create `edit-publish-errors.ts`** — move `permanentErrorKind`,
   `indeterminateError`, `handle409Disposition`, the outcome/args types; import
   `-tx`. Update `edit-publish.ts` to import `handle409Disposition`. Run suites.
4. **Extract `handleDeleteError` + `handlePostError`** into `-errors`; replace
   the two inline catch bodies in `runEditPublishIfApplicable` with the
   contract above; move `TxCatchOutcome` ownership to `-errors` and redefine
   `TxOutcome` in the orchestrator as the union. Run suites.
5. **Tidy** `edit-publish.ts` imports (drop now-unused `uuid`, `jsonb`,
   `Zernio*` classes, `permanentErrorKind`); relocate comments.
6. **Full gate**: `pnpm lint && pnpm typecheck && pnpm test`. (No DB schema
   change, so tenant-scope / RLS audits are not required, but cheap to run.)

## Risks & mitigations

- **Control-flow drift in catch extraction** (step 4) — mitigated by the exact
  contract above + running the 64-test net after the step; the DELETE/POST
  branch matrix (auth, transient, permanent, 409 ×5 dispositions, post-delete
  vs no-delete vs orphan-retry) is already covered.
- **Circular import** — avoided by design: `-tx` is a pure leaf; `TxCatchOutcome`
  is owned by `-errors` (not the orchestrator), so the orchestrator imports the
  type downward and no upward type edge exists. ESLint `import/no-cycle` should
  stay clean.
- **Test mock resolution** — new files import the same `db/server` / `uuid` /
  `zernio/client` module ids the tests already mock; vitest mocks by resolved id,
  so the mocks apply unchanged.

## Done criteria

- `edit-publish.ts`, `edit-publish-tx.ts`, `edit-publish-errors.ts` exist with
  the responsibilities above; dependency graph acyclic.
- `runEditPublishIfApplicable` is a skeleton (~150 lines); no error-handling
  branch >30 lines remains inline.
- Public surface + `ResponsePublisherWorker.ts` import unchanged.
- `pnpm lint && pnpm typecheck && pnpm test` green; the 64 publisher tests green.
