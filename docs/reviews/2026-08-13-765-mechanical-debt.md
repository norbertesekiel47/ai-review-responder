# Issue #765 final review triage

Fixed merge-base: `795bb5cb2c2da131a4800fb25138ad3d4b4b8b93`

## Independent verdicts

- Spec/correctness: **APPROVED** — no finding at or above 80% confidence.
- Security/authorization, database/tenancy, and async/operations: **APPROVED** — no finding at or above 80% confidence.
- Initial standards/maintainability: **REVISE** — three findings accepted and corrected below.
- Landing-fix spec/correctness re-review: **APPROVED** — the independent
  verifier's blockers are resolved without behavior drift.
- Landing-fix maintainability re-review: **REVISE** — two findings accepted:
  enforce the version allocator's transaction precondition in its type and
  replace the stale React Doctor note below.

## Root triage

1. **ACCEPT — P2 SQL-fragment composition assertions were too weak.**
   The two producer tests proved that `initialRunJoinSql` was evaluated but not
   that its result was interpolated into the completed-run `LEFT JOIN`. They now
   return a unique fragment sentinel and require that sentinel in the specific
   guard query's bound values. Verified by the two focused producer suites.
2. **ACCEPT — P3 exported fragment had an implicit alias contract.**
   `initialRunJoinSql` requires `zernio_backfill_runs AS br`; its JSDoc now states
   that contract explicitly.
3. **ACCEPT — P3 new PHI test used `as any`.**
   The casts violated the repository no-`any` rule. The test now uses typed
   `postgres.Sql` and `WorkerLogger` doubles. Verified by typecheck and the
   focused Zernio shared suite.
4. **ACCEPT — independent verification found the edit-reply hook objective incomplete.**
   Polling and HTTP error mapping now live behind focused helpers. The original
   self-rescheduling timeout chain is retained: one 60-second budget, one mutable
   timer handle, no state write/render per 1.5-second tick, and cleanup clears the
   currently scheduled timer. The incident-derived API, orphan-close, terminal
   failure, unknown-shape, conflict-status, restore, and reset rationale is also
   retained. Retry and Restore remain explicit because their terminal contracts
   differ; a line-scoped Fallow acknowledgement replaces the rejected flag-driven
   generic action. The exported hook is 307 lines versus 496 at the fixed base;
   Fallow no longer reports the former giant-function or clone finding.
5. **ACCEPT — the extracted version/cache contracts lost load-bearing rationale.**
   `nextResponseVersion` now documents the review-row lock plus immediate-insert
   or durable-outbox-reservation precondition. `withTtlCache` now documents that
   compute failures (including `BusinessNotFoundError`) propagate uncached while
   resolved degraded payloads are intentionally cacheable.
6. **ACCEPT — P2 the version allocator's lock contract was prose-only.**
   `nextResponseVersion` now requires `postgres.TransactionSql`, so a future
   plain-connection call fails typecheck. Its JSDoc distinguishes immediate
   response inserts from the generate paths that reserve the version in outbox.
7. **NO CHANGE — removing two `business_id` binds is safe and intentional.**
   Review ids are globally unique, and every caller first proves and locks the
   owner-scoped review. The helper remains tenant-identity-free by design; the
   caller queries retain the authorization boundary.
8. **ACCEPT IN PART — minor follow-up observations.**
   The `edit-reply-request.ts` module header now names all four shared request
   seams. The SQL predicates remain unparenthesized because every current
   composition is an `AND` chain and changing the fragment rendering would add
   no present behavior or safety benefit.
9. **ACCEPT — P3 safe parsing changed malformed-success behavior.**
   Regenerate, new manual draft, and Restore parsed successful JSON strictly at
   the fixed base; the first extraction routed them through `readJsonSafe` and
   replaced parser errors with missing-id copy. `postJsonRequired` now preserves
   strict 2xx parsing while retaining best-effort error-body parsing. Publish and
   Retry continue to tolerate optional/malformed success bodies as before. Three
   hook tests pin the strict-success behavior.
10. **ACCEPT — P2 unmount coverage stopped before an in-flight poll.**
    The original cleanup test proved an armed timeout was cleared but not that a
    response resolving after unmount could neither settle state nor re-arm the
    recursive chain. A deferred-fetch test now fires one poll, unmounts while it
    is pending, resolves `generating`, and proves the timer count remains zero
    and no third fetch occurs.
11. **ACCEPT — P3 the Zernio complexity rationale was stale.**
    The suppression comment no longer claims #765 only swaps eligibility guards
    or cites an unlocatable fast-follow. It now names the shared owned-outbox
    lifecycle and the exact PHI decision extraction performed here.
12. **ACCEPT — P3 the edit-error module header omitted its second seam.**
    The header now names both mapper families, all five owned domain errors, and
    their shared null-on-unhandled contract.

## React Doctor follow-up

React Doctor reports `effect-needs-cleanup` for the self-rescheduling timer, but
the effect does clean up: it marks the chain cancelled and clears the currently
scheduled timeout. Rewriting it as one const-bound timer per effect run made
every poll update React state and re-render the drawer, so that rewrite was
reverted as a false-positive fix. Recursive polling, unmount cleanup, and the
single-jump 62-second timeout remain covered by the hook suite.

## Actual PR Fallow coverage gate

The second independent verifier correctly found that the guarded feature gate
did not run `pnpm ci:fallow:coverage`, the repository's coverage-informed PR
gate. Reproducing it surfaced changed-file findings that the earlier triage had
misattributed to the hook:

- `readImportOfferView` and `classifyRejection` were covered only by DB-gated
  integration suites, which the local coverage run skips without
  `TEST_DATABASE_POOL_URL`. A focused non-DB unit suite now covers every banner
  outcome and every rejection class.
- The Zernio reconciliation transaction is an already-tested, pre-existing
  168-line lock/protection unit. A declaration-scoped complexity acknowledgement
  records why #765 leaves it unified while extracting only PHI/version mechanics.
- Three clone groups swept in by mechanical touches were resolved without
  unifying binding specializations: the row poller uses an explicit status
  switch, the generate route uses the existing standard error responder, and
  the two remaining intentional route/recovery parallels carry line-scoped,
  rationale-backed acknowledgements.

After regenerating full V8 coverage, `pnpm ci:fallow:coverage` is green with no
issues across the 63 changed files. The workflow gap remains: the feature gate
and the PR Fallow gate are separate commands, so this run records both rather
than claiming one subsumes the other.
