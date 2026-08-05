## Missing failing tests

| # | Test title that must exist | What it must assert | Failure mode it catches |
|---|---|---|---|
| 1 | `all #656 promised tests are executable at final verification` | All 22 promised titles execute with zero `todo`, `skip`, or pending cases. | `promised-tests` accepts `it.todo`; the gate can pass with the feature absent. |
| 2 | `migration 099 rejects every partially populated postal-address attestation tuple` | Exercise all 16 NULL/non-NULL combinations; only all-NULL and all-non-NULL succeed. | The two planned negatives cover only 2 of 14 invalid partial tuples, allowing a weaker CHECK to pass. |
| 3 | `migration 099 rejects replacing an attested address without replacing its attestation metadata` | Seed a complete tuple, run an address-only UPDATE, expect rejection, and verify the original tuple remains. | The proposed CHECK permits new address bytes under the old `attested_at`, actor, and version—the core stale-attestation defect. |
| 4 | `attestPostalAddress re-attests an edit in one scoped UPDATE` | Capture the SQL and assert one UPDATE sets all four columns with both `id` and `account_id` predicates. | Multiple autocommitted writes can transiently or permanently expose new bytes with old metadata while the final-state test passes. |
| 5 | `a failed re-attestation preserves the previous tuple byte-for-byte` | Seed an attestation, attempt an edit with an invalid actor UUID or induced SQL failure, and assert all four original values remain. | A partial implementation can update the address before a later metadata write fails. |
| 6 | `attestPostalAddress records the new actor on re-attestation` | User A attests; user B edits and re-attests; the stored actor must become B with the new bytes and timestamp. | The planned edit test allows false provenance retaining user A. |
| 7 | `attestPostalAddress rejects an attesting user outside the caller's account` | A cross-account or nonexistent `userId` produces no write. | With no FK, the proposed writer can stamp arbitrary or cross-tenant UUIDs as legal provenance. |
| 8 | `migration 099 adds no foreign key on solicitation_postal_address_attested_by_user_id` | Inspect `pg_constraint` and assert no FK includes that column. | The deliberate no-FK schema contract is only indirectly tested. |
| 9 | `deleting the attesting user leaves the complete attestation tuple unchanged` | Compare all four values before and after user deletion. | The planned test checks only address and actor, not timestamp/version integrity. |
| 10 | `PUT /api/settings/postal-address records the authenticated app user as the attester` | The stored/module `userId` is the authenticated `users.id`; body-supplied provenance cannot replace it. | A client can forge the actor on a deliberately FK-free audit field. |
| 11 | `PUT /api/settings/postal-address writes the rw_location_scope location, not the account primary location` | With primary location A and cookie-selected location B, only B changes. | Using `AppUser.locationId` can save the wrong location in multi-location accounts. |
| 12 | `readPostalAddressState returns no data for a business outside the supplied account` | Account A plus business B returns `null`, with no address or suggestion leakage. | No promised test covers tenant isolation on the new read path. |
| 13 | `batch builder scopes the postal precondition read by business_id and account_id` | Capture the widened `businesses` SELECT and assert both tenant predicates and bound IDs. | Behavior fixtures cannot distinguish an ID-only query because business IDs are globally unique. |
| 14 | `the profile page renders the active location postal-address state` | Assert the page reads with `accountId` plus `currentLocationId`, passes the state to `ProfileClient`, and renders the new panel. | Isolated panel tests pass even if the real settings page never exposes the feature. |
| 15 | `the profile settings surface requires a fresh checkbox action after a saved address is edited` | Editing any saved byte resets/unchecks attestation and prevents PUT until rechecked. | The prior checked state can silently authorize edited bytes. |
| 16 | `the profile settings checkbox uses POSTAL_ADDRESS_ATTESTATION_TEXT verbatim` | Its accessible label exactly equals the exported versioned text. | Any checkbox copy could pass the existing UI tests, including legally inadequate wording. |
| 17 | `google_place_address prefill is never persisted before explicit attestation` | Rendering or editing the suggestion emits no PUT; only checked submission writes. | Third-party Google data could be autosaved as owner-attested. |
| 18 | `PUT /api/settings/postal-address rejects unauthenticated and non-owner callers before writing` | Assert 401/403 and zero domain calls for both cases. | The compliance record can be publicly or staff writable while the three route tests pass. |
| 19 | `PUT /api/settings/postal-address rejects cross-origin mutation requests` | A missing or mismatched Origin returns 403 and performs no write. | The plan does not pin the `withSameOrigin` CSRF boundary. |
| 20 | `PUT /api/settings/postal-address refuses writes for a non-writable subscription` | Cancelled, blocked/offboarding, and otherwise non-writable accounts produce the prescribed failure with no write. | The cited subscription guard can be omitted without failing Task 1. |
| 21 | `PUT /api/settings/postal-address rejects an unknown attestation version without writing` | A stale/unknown version returns 400 and never calls the domain writer. | A client can assent to different text while the server records the current version. |
| 22 | `lintPostalAddress requires two non-empty lines` | `123 Main St 78701\n   ` returns `single_line`. | Counting newline characters instead of non-empty lines passes all four planned lint tests. |
| 23 | `lintPostalAddress does not treat a five-digit street number as the postal code` | `12345 Main Street\nAustin, TX` returns `no_postal_code`. | A naïve `/\d{5}/` accepts an address with no ZIP. |
| 24 | `offboarding purge clears a populated attestation tuple in one statement` | Prove all four fields are non-NULL before the real purge, then all four are NULL afterward. | A default-NULL fixture passes vacuously without modifying the purge. Successful execution also proves the CHECK-compatible atomic clear. |
| 25 | `offboarding purge leaves another account's attested postal address untouched` | Purge account A and assert account B’s complete tuple is byte-identical. | An unscoped purge can erase legal sender data across tenants. |
| 26 | `offboarding purge clears the attestation for every location in the account` | Seed two populated locations under the target account and verify both tuples are cleared. | A primary-location-only implementation passes a one-location fixture. |
| 27 | `a withheld send handoff creates no generate_solicitation_asks outbox row` | For missing-address and bounced-owner cases, assert withheld status and zero matching generation rows. | Code can report “withheld” while still enqueueing sends. |
| 28 | `withholding the send handoff does not change any per-candidate decision or reason count` | Equivalent cohorts must have identical stored asks, counts, and full `withheldByReason` values; only `sendHandoff` differs. | “No new key” does not catch leaking the location failure into an existing key such as `no_consent`. |
| 29 | `send handoff is not_applicable when SOLICITATION_SEND_ENABLED is off` | With `sendCount > 0`, assert the batch remains built, no generation row exists, and status is exactly `not_applicable`. | All five planned handoff tests turn the flag on, leaving actual watch-only behavior untested. |
| 30 | `postal_address_missing wins when the postal address is missing and owner email has bounced` | With both failures present, assert the sole reason is `postal_address_missing`. | The declared first-match precedence is not tested. |
| 31 | `send-handoff enqueue failure rolls back the batch build` | Induce outbox insertion failure and assert no `built_at`, asks, completed run, or completed build-outbox state commits. | Moving enqueue outside the transaction creates built batches with no generation work. |
| 32 | `solicitation batch worker logs the send_handoff status and location-level reason` | The structured log contains `business_id` and withheld status/reason, but no address or contact PII. | None of the 22 tests covers the feature’s only promised observability path. |

## Cited-artifact check

| Cited artifact | Exists? | Note |
|---|---|---|
| `docs/superpowers/plans/2026-08-03-656-postal-address-attestation.md` | Yes | Plan under review, 548 lines. |
| `.feature/intake.json` | Yes, contradictory | Lines 72–74 still promise `migration 098 …`; Task 1 authors `migration 099 …`. Its allowed surface also omits required worker and migration-test edits. |
| `docs/superpowers/plans/feat-656-postal-address-attestation-deviations.md` | Yes, miscited | D1–D4 exist. Task 6 says D2 contains the watch-mode deviation, but D2 concerns only tenant-scope allowlist overlap. |
| Sender-deliverability spec §1.3 | Yes | Heading at line 76. |
| Sender-deliverability spec §2.4 | Yes | Heading at line 191; bounced-owner batch-build precondition at line 197. |
| Sender-deliverability spec §7.5 | Yes | Heading at line 571; postal-address requirements follow. |
| Sender-deliverability spec §7.6 | Yes, contradicts plan | Heading at line 598; line 605 still requires “no batch produced.” |
| `2026-07-28-send-mode-cross-spec-amendments.md` | Yes, but does not support the claim | It does not amend §7.6 point 1 or the §2.4 bounced-owner batch-build rule. |
| `CONTEXT.md` watch/send sections | Yes | Watch-mode at line 36 and send-mode at line 45. The two new terms are appropriately not present yet. |
| `src/lib/solicitation/batch-builder.ts` business SELECT | Yes | Lines 705–710 select `category` and scope by `id` plus `account_id`. |
| `src/lib/solicitation/batch-builder.ts` send seam | Yes | Lines 766–772 contain the exact flag/send-count condition and enqueue call. |
| `BuiltSolicitationBatchResult`, `closedGateReason` | Yes | Lines 53 and 130. |
| `WITHHOLD_REASONS`, `RESTRAINT_POLICY_VERSION` | Yes | Present in `restraint-policy.ts`; the six-member enumeration matches the plan. |
| `worker/jobs/solicitation-batch/index.ts` structured log | Yes, approximate line drift | Line 31 assigns the result; `logger.log` begins at line 34. |
| `worker/jobs/solicitation-batch/__tests__/index.test.ts` | Yes, omitted by plan | Its exact expected log object will need updating, but it is outside the locked edit surface. |
| `worker/jobs/account-offboarding/purge-stages.ts:673` | Yes | Exactly `google_place_address = NULL` in the account-scoped `businesses` SET. |
| Existing offboarding `google_place_address` assertion | No | The plan says to add assertions “alongside” one, but no such test assertion exists. |
| `src/lib/solicitation/ask-generation.ts:193` | Yes | Contains the exact `to_jsonb(b) ->> 'solicitation_postal_address'` shim. |
| Migration-096 integration precedent | Yes | File exists, acquires the live-DB lock, asserts schema readiness, and does not apply migration SQL. |
| `schema-ready.ts` / `assertSchemaReady` | Yes | Exported function begins at line 330. |
| `acquireLiveDbLock` | Yes, elsewhere | Exported from `helpers/live-db-lock.ts:155`, not `schema-ready.ts`. |
| `src/app/api/settings/competitors/route.ts` | File yes; cited pattern no | It uses `requireSettingsOwner`, explicit `businessId`, and `withSameOrigin`; it does not contain the claimed `requireRoleOr401`, `user.locationId` checks, or `assertWritableSubscriptionForAccount`. |
| `BrandVoicePanel.tsx` | Yes | Component at line 27; `set-section` conventions begin at line 30. |
| Profile `page.tsx` and `ProfileClient.tsx` | Yes | Page calls `requireOwnerAccess(sql)`; that helper returns `currentLocationId`, not a `businessId` field. |
| `settings/locations/page.tsx` | Yes | Contains the cited server-fetch-and-props precedent. |
| `src/lib/solicitation/attestation.ts` | Yes | `CONSENT_ATTESTATION_VERSION` at line 8 and `SEND_ELIGIBLE_ATTESTATION_VERSIONS` at line 26. |
| Migrations 086 and 093 | Yes | 086 has the old cascading FK; 093 documents and uses the no-FK point-in-time capture. |
| `096_solicitation_suppressions.sql` | Yes | Exists. |
| Existing batch-builder, ask-generation, offboarding, and sentiment test precedents | Yes | All cited files exist; the batch helper call is at line 278. |
| Claimed batch-builder “flag-stubbing helper” | No | The suite mutates `process.env` directly; no such helper exists. |
| `scripts/verify-gate.sh` / `promised-tests` | Yes | Verbatim intake-title matching makes the 098/099 drift operationally fatal. |
| `ci:live-db-suites` | Yes | Registered in `package.json` and wired into CI. |
| `.claude/reference/migrations-log.md` | Yes | Current head is 097 and next is 098. |
| `supabase/migrations/098_*.sql` | No, as required | No 098 migration exists in this worktree; the filesystem head is 097. |
| `new-migration` and `repworth-brand-design` skills | Yes | Both repository skills exist. |
| Required `subagent-driven-development` / `executing-plans` skills | No | Neither skill exists in the repository or active skill catalog. |
| Files deliberately excluded by D3 | Yes | `/api/settings/route.ts`, `useSettingsForm.ts`, and `ProfilePanel.tsx` all exist. |
| Nine files marked Create | No, expected | The migration, domain module, route, panel, and five new test files are legitimate planned outputs, not existing precedents. |
| `docs/directory.md` | Yes | Exists and contains the current profile and solicitation code map. |

## Plan-level findings

| # | Severity | Finding | Suggested fix |
|---|---|---|---|
| 1 | Critical | The locked intake promises three `migration 098 …` tests while the plan authors `migration 099 …`. The promised-test gate cannot pass as claimed. | Correct the locked titles to 099 and re-arm the intake contract. |
| 2 | Critical | Required edits fall outside `allowed_edit_surface`: the migration-099 suite, worker log source/test, and likely `schema-ready.ts`. D4’s claimed worker amendment reached only a non-locked intake copy. | Amend and re-arm the locked surface before implementation. |
| 3 | Critical | The proposed CHECK enforces tuple completeness, not that metadata covers the current bytes. An address-only UPDATE of an already-attested row succeeds. | Add an OLD/NEW database trigger or stored attested digest/snapshot that rejects an address change without fresh attestation. |
| 4 | High | The plan contradicts locked §7.6 and §2.4. The binding cross-spec amendment is silent, so the original “no batch produced” rules still stand. | Record an explicit binding amendment for both missing address and bounced owner, or follow the locked behavior. |
| 5 | High | Task 4 describes a stale precedent and never identifies the cookie-selected active-location resolver. This risks showing one location while writing another. | Specify `currentLocationId` resolution, CSRF wrapping, writable-subscription/offboarding behavior, and exact HTTP mappings. |
| 6 | High | Removing the FK preserves historical evidence, but the writer does not verify that the actor exists, belongs to the account, and is an owner. | Validate actor membership inside the atomic scoped UPDATE while keeping the stored column FK-free. |
| 7 | High | `it.todo` satisfies the title gate, and the plan has no final no-todo check, full gate, build, tenant-scope audit, or RLS audit after all tasks. | Add a final zero-pending check, `verify-gate`, narrow suites, `pnpm build`, `ci:tenant-scope`, and `ci:rls-audit`. |
| 8 | High | Task 6 necessarily breaks existing exact-log and batch-builder unit fixtures, but the plan does not update them; the worker test path is also outside the surface. | Add the existing worker unit suite and batch-builder unit fixtures to Task 6 and the allowed surface. |
| 9 | Medium | The plan mandates `assertSchemaReady` but never adds a migration-099 schema requirement or updates each affected live-DB suite to assert it. | Add `MIGRATION_099_SOLICITATION_POSTAL_ADDRESS` and use it in every affected integration suite. |
| 10 | Medium | “Do not open the PR until #645 merges” does not stop Task 2 from recording head 099 while 098 is absent. | Add a blocking pre-T2 rebase/check that 098 and its migration-log entry exist. |
| 11 | Low | The dependency graph routes T7/T8 through T3 although their task headers require only T2; the prose also says “only two new test files” while listing five. | Correct the graph and test-file count. |

VERDICT: REVISE
EXIT=0
