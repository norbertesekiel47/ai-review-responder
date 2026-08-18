# Issues #665 and #662 — purge detector and suppression-console consistency

## Fixed point and contract

- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-fix-665-662-offboarding-suppressions`
- Base: `d89c112f` (`origin/main`)
- Intake: `docs/superpowers/plans/codex-fix-665-662-offboarding-suppressions-intake.json`
- Classification: `standard / high / mixed`; database-touching query changes, no migration
- Issues: #665 and #662

The risk is narrow but real: the `businesses` verification branch is part of the
fail-closed decision to stamp destructive purge complete, and the correction-actor
lookup is an intentional cross-tenant read of `users` behind the existing AAL2 admin
gate. The implementation does not change purge writes, Correction path writes,
authorization, schema, or external systems.

## Locked implementation decisions

1. The `businesses` residue predicate names all five Attested postal address columns.
   This deliberately does not collapse to one probe even though migration 099's current
   CHECK makes the tuple all-NULL or all-present; the detector remains honest if that
   constraint is relaxed later.
2. The postal detector test uses a recorder-backed live-database
   `verificationQuery('businesses', ...)` seam. It asserts that the executed predicate
   names each of the five columns, then runs the existing parent tombstone purge and
   proves zero violations, restores only a complete attestation tuple while keeping
   `google_place_address` NULL, and proves one violation. The SQL-shape assertion proves
   the five-column contract that migration 099's all-or-nothing CHECK makes impossible to
   distinguish from data outcomes alone; the live result isolates the new predicate from
   the pre-existing Google-address probe.
3. `lookupSuppressions` resolves correction actors in the existing capped corrections
   statement with `LEFT JOIN users u ON u.id = c.removed_by_user_id`. It returns one
   shallow caller-facing addition, `removedByUserLabel`, formatted as
   `Name (email@example.com)` when the user exists and as the durable raw UUID when it
   does not. The existing `removedByUserId` remains available.
4. Actor resolution stays one database round trip, uses the `users` primary key, and
   keeps the corrections filter on migration 098's
   `(channel, normalized_handle, created_at DESC)` index. No per-row lookup, schema,
   foreign key, RLS, or privilege change is introduced.
5. The existing correction-table tenant-scope exception is updated to the joined query's
   exact SQL. The audit proves `users` is structurally scoped by its primary-key equality,
   so adding the planned `users` exception would be unused and would weaken the audit;
   the baseline remains 381. This execution-time refinement was established by a red
   `pnpm ci:tenant-scope` run and its green rerun with the unnecessary exception removed.
6. `correction.onSuccess` calls `entry.reset()` before invalidating
   `['admin-suppressions']`. Both `corrected` and `already_removed` flow through this
   handler and clear stale manual-entry success/error receipts. A genuine correction
   failure never enters the handler and keeps the existing UI state. The jsdom coverage
   exercises both receipt branches: duplicate-entry success and failed-entry error.
7. The admin UI remains the existing utilitarian Island surface. This change only swaps
   the raw UUID cell for the server-owned label and clears contradictory state; it does
   not redesign or recolor the page.

## Tracer 1 — fail closed on surviving postal-attestation PII

- Observable behavior: a cleared Attested postal address tuple produces zero
  `businesses` violations; any surviving member produces a violation before purge can
  complete.
- Public test seam: `verificationQuery('businesses', input, sql)` against the live local
  database.
- Exact test: `the businesses purge verifier passes after clearing an attested postal address and fails when the tuple survives`.
- Red-first change: add the recorder-backed live-database case beside the existing #656
  postal fixtures; it must fail both the five-name SQL assertion and the restored-tuple
  result while `purge-verification.ts` omits the columns.
- Blocking edges: use the existing migration-099-compliant tuple seeder; explicitly NULL
  `google_place_address` before the failing arm so the count comes only from the new
  predicate.
- Precedent: the #656 postal purge tests in
  `worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts`
  and the write/read pairing documented in `purge-stages.ts`.
- Allowed files: `src/lib/account-offboarding/purge-verification.ts` and the existing
  offboarding lifecycle integration suite.
- Completion evidence: the exact live-database title proves all five SQL names and passes
  with zero then one violation.

## Tracer 2 — resolve Correction path actors without weakening durability

- Observable behavior: PRIOR CORRECTIONS receives a readable admin name/email when the
  user row exists and the raw UUID fallback when it does not.
- Public test seam: `lookupSuppressions(sql, rawEmail)` against real correction and users
  rows.
- Exact test: `lookupSuppressions resolves a correction actor to name and email and falls back to the raw UUID when the users row is gone`.
- Red-first change: extend the live-database suite with one correction attributed to the
  seeded user and one attributed to a non-existent UUID; both are returned in the same
  capped lookup.
- Blocking edges: preserve handle normalization, newest-first ordering, LIMIT 20, the
  account-less correction shape, and plain non-FK `removed_by_user_id` durability.
- Precedent: the existing account display-name `LEFT JOIN` in `lookupSuppressions` and
  `AdminSuppressionCorrectionRow` mapping.
- Allowed files: suppression service, its live-database suite, and the tenant-scope
  allowlist.
- Completion evidence: the focused integration title and `pnpm ci:tenant-scope` pass;
  allowlist count equals its explicit baseline.

## Tracer 3 — remove contradictory UI state after correction

- Observable behavior: after a successful correction, the current-state lookup is the
  only live suppression claim on screen, and the audit table renders the actor label.
- Public test seam: `SuppressionsClient` through public form controls and rendered query
  and mutation states in jsdom.
- Exact tests: `clears the stale manual-entry receipt after a successful correction` and
  `renders the correction actor name and email instead of a raw UUID`.
- Red-first change: reproduce both duplicate-entry success receipt and failed-entry error
  receipt → lookup → successful Correction path → invalidated re-read, asserting the
  receipt disappears in each case; separately supply a correction row whose label differs
  from its UUID.
- Blocking edges: Tracer 2 fixes the wire DTO first. Preserve current error semantics:
  correction failure leaves the live row visible; already-removed remains a successful
  outcome and re-reads current state.
- Precedent: the existing correction `onSuccess` invalidation and `LookupResults`
  DataTable column definitions.
- Allowed files: `SuppressionsClient.tsx` and its existing jsdom suite.
- Completion evidence: both exact promised titles pass, the adjacent error-receipt case
  passes, and the existing correction-framing and failure-state tests remain green.

## Verification, rollback, and observability

Run each tracer's focused test red then green. Run every intake command, followed by
`bash .agents/skills/feature/scripts/verified-gate.sh --review` and a fingerprint check.
The full gate includes lint, typecheck, tests, CI audits, promised-test discovery, and
build; database-touching validation also requires the tenant-scope and RLS rows to stay
green.

Rollback is one code revert: detector columns, actor join/label, allowlist query, and
client reset. There is no schema or data rollback. Operational success is visible as a
`businesses` purge-verification issue when PII survives and a readable-or-UUID actor in
the AAL2 admin audit table; silent failure is distinguished by those same two signals.
No push, staging deploy, merge, or issue closure is authorized by plan approval.
