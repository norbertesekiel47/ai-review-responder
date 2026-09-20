# Plan — issue #1361: owner gates re-throw a server fault instead of masking it as 401

- Branch: `fix/1361-locations-route-fault-status`
- Intake: `docs/superpowers/plans/fix-1361-locations-route-fault-status-intake.json`
- Issue: <https://github.com/RepWorth/ai-review-responder/issues/1361>
- Lane: SIZE small · RISK high · SURFACE backend. The small/high lane builds in
  the orchestrator session with no subagent dispatch, so no codex plan-skeptic
  round runs at this size; the step 7 review wave is the adversarial gate.

## Module seam

No new seam. Two existing owner gates each own one catch block today, and the
change deepens neither interface — it removes a branch. The target shape already
exists twice in the codebase (`requireRoleOr401`, and this same file's
`assertSameOrigin` catch), so the fix is a convergence, not a new pattern.

## Decision of record

`requireRole` fails two ways. An `AuthError` is a refusal and keeps its own
status. Anything else is a server fault and must not be answered as 401.
The locked decision is **re-throw**, not catch-and-return-500:

1. It matches `src/lib/auth/route-helpers.ts:119-124` (`requireRoleOr401`).
2. It matches the same file's `assertSameOrigin` catch (`owner-route.ts:43-54`).
3. `onRequestError` in `src/instrumentation.ts` captures an escaped route error
   into Sentry for free; a caught-and-returned 500 would need its own report call.

The rejected alternative (return `{ error: 'internal_error' }` at 500) is the
shape `requireAdminWithAal2` uses. `route-helpers.ts:99-106` documents that
asymmetry as deliberate and scoped to the admin control plane. This change does
not touch it.

## T1 — locations owner gate re-throws

- Modify: `src/lib/locations/owner-route.ts`
- Test: `src/lib/locations/__tests__/owner-route.test.ts`

**Behavior contract.** `readOwnerForMultiLocationRoute` catches a `requireRole`
rejection. When the rejection `instanceof AuthError`, it returns the existing
no-store JSON refusal at `err.statusCode` — unchanged. For any other rejection
value it re-throws that value unchanged, so the error escapes the route handler
and Next.js answers 5xx.

**Negative cases.** A thrown non-`Error` value (a string) must propagate as the
same value, not be wrapped or coerced. The `AuthError` 401 and 403 bodies must
stay byte-identical, including the `Cache-Control: no-store, private` header.

**Security contract.** This path is an auth gate. The change must not widen who
passes it: the success path, the `!user.accountId` 403, and the
writable-subscription gate are untouched. Masking a fault as 401 is the defect;
answering a fault as 200 would be a far worse one, so the re-throw must sit on
the failure branch only.

**Seam.** `mockRequireRole` in the existing test file rejects; the helper is
called directly with a sentinel `sql` and a same-origin `NextRequest`.

**Test titles.**
- `re-throws when requireRole rejects with a non-AuthError`
  (replaces the existing `falls back to 401 when auth rejects with a non-AuthError`
  at `:157`, which pins the defect)
- `re-throws a non-Error rejection value unchanged`

**Precedent.** `src/lib/auth/route-helpers.ts:119-124`; `owner-route.ts:43-54`.

## T2 — approval dashboard owner gate re-throws

- Modify: `src/lib/approval/http-routes.ts`
- Test: `src/lib/approval/__tests__/http-routes.test.ts`

**Behavior contract.** `requireDashboardReviewOwner` has the identical defect at
`:151`. Same change: `AuthError` keeps its mapped status and no-store headers;
any other rejection re-throws unchanged.

**Negative cases.** The `AuthError(403)` case and the
`No account associated with this user` 403 case must stay unchanged; both are
already asserted in `describe('requireDashboardReviewOwner')` at `:415-432`.

**Security contract.** Same as T1. Eight routes consume this gate
(`/api/dashboard/reviews/[reviewId]/{approve,edit,generate,regenerate,draft-status,timeline}`
plus `/api/dashboard/escalations/[escalationId]/{acknowledge,resolve}` via
`runEscalationTransitionRoute`). None wraps the gate call in a `try` block, so a
re-thrown error escapes each handler. Verified before planning.

**Seam.** `mockRequireRole` in the existing test file; the helper is called
directly with a `NextRequest`.

**Test title.**
- `re-throws a non-AuthError rejection instead of masking it as 401`

**Precedent.** T1's change, landed first; `route-helpers.ts:119-124`.

## Blocking edges

T1 and T2 touch disjoint files and share no state. T1 lands first only so its
diff is the precedent T2 copies.

## Out of scope

The twelve consuming routes, every other auth gate, and the deliberate
`requireAdminWithAal2` asymmetry. See the intake's `non_goals`.
