# #652 — Module-owned unsubscribe redemption transaction

**Branch:** `feat/unsubscribe-transaction-boundary`  
**Classification:** standard · high risk · backend · database touching  
**Intake:** `docs/superpowers/plans/feat-unsubscribe-transaction-boundary-intake.json`  
**Base:** `fd0b48f342c573741ba4fd79633756b8348ee647` (#651 landed)

## Locked behavior

`redeemUnsubscribeToken` accepts an explicitly injected `Sql` client and opens its
own plain `sql.begin()` transaction after the stateless admission gate succeeds.
The transaction covers exactly the existing claim-first redemption algorithm:
claim an unredeemed token, record a global suppression from the claim's returned
provenance, or distinguish a mint race from an already-spent token through a
fresh read and live-suppression check.

This defines away two invalid caller states: a non-READ-COMMITTED redemption
transaction and a caller holding the token row lock around remote work. The
function resolves only after commit, so the Vercel receipt and RFC 8058 success
response remain after the durable outcome.

## Non-goals and boundaries

- Do not alter token validation, outcomes, receipt semantics, HTTP mapping,
  single-flight behavior, token/suppression schema, or pool configuration.
- Do not import the database singleton into the domain module; invariant #15
  remains satisfied by the injected `Sql` client.
- No remote migration, deployment, commit beyond the already-authorized intake
  audit commit, push, or pull request.

## Coordination

The original plan expected #652 to land before #651. The user-approved merge
order changed while implementation was paused: #651 landed first, then #652
rebased onto it. #652 preserves #651's dedicated `sqlUnsubscribe` client and
changes only the redemption interface: the ingress passes that client into the
module-owned transaction. Client construction and pool policy remain #651-owned.

## Intake amendment

Round-2 validation corrected two stale follow-up records that live outside the
original `allowed_edit_surface`. `docs/currents.md` and `docs/progresstracking.md`
were added to that surface with explicit user sign-off, and the amendment is
recorded in `feat-unsubscribe-transaction-boundary-review-triage.md` round 2. No
other surface widened.

## Tracer bullets

### T1 — Move the transaction boundary into the redemption domain module

- **Behavior:** valid tokens run the unchanged algorithm inside an internally
  created plain transaction; malformed tokens still return `unknown_token`
  without touching the database client.
- **Test seam:** `redeemUnsubscribeToken(Sql, input)` in
  `src/lib/solicitation/__tests__/unsubscribe.test.ts`.
- **Exact evidence:** `redeemUnsubscribeToken opens its own transaction only
  after the token admission gate passes`.
- **Precedent:** existing stateless gate and claim-first transaction body in
  `src/lib/solicitation/unsubscribe.ts`.
- **Allowed files:** `src/lib/solicitation/unsubscribe.ts`,
  `src/lib/solicitation/__tests__/unsubscribe.test.ts`.
- **Blocking edges:** none; this establishes the interface for both adapters.

### T2 — Update both adapters without moving post-commit work

- **Behavior:** Vercel receives the outcome after commit before minting a
  receipt; the ingress single-flight shares the committed outcome before its
  200 response.
- **Test seams:** Vercel POST landing test and Fastify ingress mock seam.
- **Exact evidence:** `POST mints a receipt only after module-owned redemption
  commits`; `single-flight redemption shares the module-owned committed outcome`.
- **Precedent:** `src/app/api/u/[token]/route.ts` and
  `worker/ingress/unsubscribe.ts` current post-commit comments.
- **Allowed files:** `src/app/api/u/[token]/route.ts`,
  `src/app/__tests__/unsubscribe-landing.test.tsx`,
  `worker/ingress/unsubscribe.ts`, `worker/ingress/__tests__/unsubscribe.test.ts`.
- **Blocking edges:** T1; coordinate with #651 by keeping the ingress change to
  the invocation only.

### T3 — Preserve concurrency and provenance behavior through the new seam

- **Behavior:** overlapping redemptions block on the first transaction and
  retain exactly one suppression plus the original `redeemed_at`; mint races
  and purge-scrub races retain their current outcomes/provenance.
- **Test seam:** live database redemption helper in
  `src/lib/solicitation/__tests__/unsubscribe.integration.test.ts`. The
  deterministic mint-race case replaces its current `TransactionSql` injection
  with a test-only `Sql.begin` wrapper/proxy that passes
  `commitBetweenStatements(tx, ...)` into the module callback; production code
  remains unaware of that interposition.
- **Exact evidence:** existing `two overlapping redemptions write exactly one
  ledger row and one redeemed_at`, updated so the module owns each transaction;
  the existing mint-race outcome and retry assertions remain intact.
- **Precedent:** the existing integration suite's lock-wait probes.
- **Allowed files:** `src/lib/solicitation/__tests__/unsubscribe.integration.test.ts`.
- **Blocking edges:** T1; requires the local test database at migrations head.

## Verification

1. Focused unit, ingress, landing, and live-DB suites declared in the intake.
2. `pnpm ci:db-imports`, `pnpm ci:tenant-scope`, and `pnpm ci:rls-audit`.
3. `pnpm build`.
4. The feature `verified-gate.sh` followed by review mode and a current
   fingerprint.

## Rollback and observability

Rollback is a code revert; no schema or data action is involved. Existing
ingress outcome telemetry still distinguishes failed redemption attempts from
committed outcomes. The focused concurrency tests are the release evidence that
the internal transaction neither changes the claim-first state machine nor
allows success before commit.
