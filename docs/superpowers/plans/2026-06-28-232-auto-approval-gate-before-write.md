# Plan — #232 reframe `settings.ts` policy mutation to gate-before-write

Branch: `refactor/232-auto-approval-gate-before-write`
Type: behavior-preserving structural refactor (NOT a bug). Safety-sensitive path
(auto-approval policy mutation). Invariants in play: CLAUDE.md #3 (no unapproved
posting / approval-method authority), #4 (high-severity hold), #14 (auto-approval
policy access is server-owned).

## Decision (self-resolved, no human)

Adopt the issue's gate-before-write reframe exactly. The after-state is a pure
function of (before-state, operation) per the issue's operation→after-state table,
so we derive it instead of applying-then-re-reading. The mutation stays inside the
existing `sql.begin()` (lock + writes still transactional); the ONLY change is that
all reject gates run **before** `applyMutation`, so "blocked ⇒ nothing written" is
structural rather than a rollback side effect.

### Target structure (inside the existing `sql.begin`)

```
updatePolicyInTransaction(tx, input):
  lockAccount(tx, accountId)                       // SELECT … FOR UPDATE (unchanged)
  before  = readBeforeState(tx, input)             // reads (was captureBefore)
  newId   = uuidv7()                               // we control the insert id
  after   = computeAfterState(before, input, newId)// PURE, no DB (was captureAfter)
  ctx     = assertMutationAllowed(tx, input,       // gates throw BEFORE any write
                                  before, after)    //   (was buildAuditContext)
  applyMutation(tx, input, newId)                  // upsert/delete (unchanged SQL)
  writeAudit(tx, input, before, after, ctx)        // (was writePolicyChangeAudit)
```

### Types — two clean immutable snapshots (kills the half-populated `MutationBeforeAfter`)

```
PolicySnapshot          { row: AutoApprovalPolicyApiState; effective: EffectiveAutoApprovalPolicy }
PolicyMutationBefore    { snapshot; scope; locationId; locationArchived;
                          affectedActiveLocationCount; accountDefault }
PolicyMutationAfter     { snapshot }
PolicyChangeAuditContext (unchanged: beforeRank, afterRank, expansion,
                          requiredConfirmationLevel, readiness)
```

`scope`, `locationId`, `affectedActiveLocationCount` are invariant before→after
(a policy op never changes which locations have overrides, nor which scope/location
is targeted), so they live on `before` and the audit reads them from there — same
values the old code read from `after`.

### `policyId` truthfulness (mirror ON CONFLICT semantics)

`computeAfterState` derives `afterRow.policyId`:
- before row existed → reuse `before.snapshot.row.policyId` (ON CONFLICT DO UPDATE keeps the id)
- before row absent  → the freshly-generated `newId`, which is ALSO threaded into
  `applyMutation`'s INSERT so the persisted row id equals the derived id.

This is exactly what the old `captureAfter` re-read returned in production
(update keeps old id; insert gets the new uuid), so `afterRow` stays truthful.

### Unify the archived-location rules (the headline simplification)

Two rules, previously split, both meaning "you can't expand a location's policy
while it's archived", move into the single pre-write `assertMutationAllowed`:
1. `set_location_override` on an archived location → `location_inactive` 409
   (was in `captureBefore`, unconditional for that op).
2. any op that EXPANDS an archived location's effective policy
   (e.g. `delete_location_override` exposing a higher account default) →
   `location_inactive` 409 (was the 17fd4933/#229 gate in `buildAuditContext`).

Unified, gate order preserved (archived → confirmation → readiness):
```
if (before.scope === 'location_override' && before.locationArchived) {
  if (input.operation === 'set_location_override' || expansion) throw location_inactive(409);
}
```
`location_not_found` (404) stays in `readBeforeState` — it's a read precondition,
not a policy gate (you can't snapshot a location that doesn't exist).

## Behavior preservation argument

- Same audit payload, field-by-field: `scope`/`locationId`/`affectedActiveLocationCount`/
  `futureDefaultApplies` are before==after, so sourcing them from `before` is identical.
- Same error types/messages/order for every blocked case (account_not_found,
  location_not_found, location_inactive ×2, confirmation_required, expansion_blocked).
- Same SQL text; INSERT value positions unchanged (only the id source flips from an
  inline `uuidv7()` to a threaded param at the same `${}` slot).
- Behavior lock = the existing `settings.test.ts` suite stays green.

## TDD

1. RED: add `performs no policy write when an expansion is blocked` — drive an
   expansion into a not-ready readiness (`AUTO_APPROVAL_ENABLED=false`), assert
   `AutoApprovalExpansionBlockedError` AND that `sqlCalls` contains no
   `INSERT/DELETE … auto_approval_policies` AND `writeAccountAuditLog` was not
   called. Fails on old code (applyMutation ran before the gate → INSERT logged).
2. GREEN: implement the reframe.
3. Keep the whole existing suite green throughout.

## Verify gate (end)

`pnpm lint && pnpm typecheck && pnpm test` plus DB-touching audits
`pnpm ci:tenant-scope && pnpm ci:rls-audit`. Commit on the branch, ref #232. No push.

## Files

- `src/lib/auto-approval/settings.ts` — the refactor.
- `src/lib/auto-approval/__tests__/settings.test.ts` — +1 structural no-write test.
- This plan.
