# Channel route unification — plan review, round 2 verification

## Verdict

**REVISE.** The revised plan closes the response, binding, error-mapping, and task-order findings.  Its new protocol coverage does not, however, prove that token minting happens outside the transaction, and its claimed strict SQL double is not strict.  The new admin binding suite also retains a lossy, under-counted queue, so the partial acceptance of High 4 leaves the original reachable regression in place.

## Round-1 finding verification

| Round-1 finding | Status | Verification note |
|---|---|---|
| High 1 — admin failure responses lacked no-store | ADDRESSED | T4 changes all three resolver-generated admin failures to `errorResponse(...)`; T2b invokes the Telegram start route for 400, 404, and 403 and checks `Cache-Control: no-store, private`. |
| High 2 — cache-label test only exercised dashboard | ADDRESSED | T2b calls the admin Telegram cancel binding and asserts `admin.telegram.cancel`; the pre-existing owner-side case supplies `dashboard.telegram.disable`. |
| High 3 — transaction protocol unpinned | NOT ADDRESSED | The tests pin one `begin`, lock nesting/first statement/key, and lock-before-helper. But the token-outside-transaction test only observes that argument 5 of `startMobileEnrollment` is a SHA-256 hash. The same assertion passes if `randomUUID()` and hashing move inside `sql.begin`; no test observes token generation relative to `begin`. |
| High 4 — lossy queue mock | NOT ADDRESSED | The stated compensation is not real: `mkSql` is not strict (it records every unexpected statement and resolves `[]`), while the five owner suites remain lossy. The runner tests inject `okActor`, so they cannot detect an added/reordered resolver query that shifts the owner route queues. See the new-defect table. |
| Medium 1 — bindings not proven | ADDRESSED | T2b exercises both admin start bindings for the strict 403, and all four cancel/disable bindings for the no-gate posture. The disable assertion is narrow but meaningful: an accidental full-access binding returns 403 before `disconnectChannel`. |
| Medium 2 — `blocked` pass-through | ADDRESSED | Parameterized runner tests cover both cancel and disable for the 402 and 403 blocked responses. |
| Medium 3 — gate ordering only for start | ADDRESSED | Parameterized tests cover flag-off and env-503 for all three runners with a throwing resolver sentinel and an empty SQL log. |
| Medium 4 — deep-link test never invoked a route | ADDRESSED | T2b invokes admin WhatsApp start with the formatted number and asserts the returned `wa.me` link. |
| Medium 5 — `EnrollmentDatabaseError` unpinned | ADDRESSED | The runner suite covers 500/no-store, 409/no-store, unrecognized-error rethrow, and checks the reporting context for neither UUID nor SHA-256 token material. |
| Medium 6 — T2 → T3 edge missing | ADDRESSED | The task graph and Task 3 now explicitly make T3 depend on T1, T2, and T2b. |

## New defects introduced by the fixes

| Severity | Artifact | Defect | Why it matters |
|---|---|---|---|
| High | `docs/superpowers/plans/2026-08-15-channel-route-unification.md:758-778` | `mkSql` is described as strict but has neither an expected-statement queue nor an over-consumption throw; `record` always resolves `[]`. Its tests also do not compare the complete statement list. | A newly added/reordered SQL statement after the advisory lock is accepted silently. This invalidates the asserted compensation for the remaining lossy owner suites and leaves the exact-statement/order claim untested. |
| High | `docs/superpowers/plans/2026-08-15-channel-route-unification.md:1080-1089,1116-1130` | The new admin binding fixtures undercount the real route SQL and use the same lossy consumer. Start performs account lookup, lock, `startMobileEnrollment`'s `SELECT ... FOR UPDATE`, then an INSERT/UPDATE; the fixture supplies three arrays. Disable performs account lookup plus the org-default update, override update, and (with the supplied `e1`) an audit insert; the fixture supplies two arrays. | Missing queries consume implicit `[]`, so a query-order regression can still return a non-403/200 response and make the new binding tests green while exercising the wrong statements. |

## Targeted implementation notes

- The `mkSql` tagged-template shape is compatible with the planned Postgres.js use: the lock is recorded through the template tag, and `begin` awaits and returns the callback value.
- `startMobileEnrollment(tx, channel, businessId, accountId, tokenHash, expiresAt)` makes index 4 (`const [, , , , tokenHash]`) correct.
- The `importOriginal` mobile-enrollment mock is safe for `MobileChannel`: it is imported type-only by the runner and therefore has no runtime export requirement.
- Vitest 4 accepts the `it.each` tuple with a function value; `%s` is populated from the first tuple field.

## Required revision

Make the protocol double genuinely strict by providing the exact expected statements (including transaction nesting) and failing on both mismatch and leftovers. To prove token timing, mock or inject token generation/hash creation and record it relative to `begin` (or expose a deliberately testable token factory); validating the resulting hash alone is insufficient. Make the admin binding SQL mock strict too, and seed the complete actual sequences. Alternatively, mock the lower-level enrollment/disable helpers in binding tests and reserve exact SQL assertions for the strict runner-level suite—but do not mix a lossy queue with hand-counted query fixtures.

## Appendix — not triaged this round

No unrelated plan sections were triaged in this verification-only review.

VERDICT: REVISE
