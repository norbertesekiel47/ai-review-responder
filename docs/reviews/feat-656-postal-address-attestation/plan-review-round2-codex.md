# Plan review round 2 — codex report (#656, verification-only)

Reviewer: `codex exec` --sandbox read-only. Brief: verification-only against the
round-1 findings table. Raw transcript trimmed to the final report.

## Round-1 finding verification

| # | Status | Evidence |
|---|---|---|
| 1 | ADDRESSED | Mechanical comparison found 46/46 intake titles quoted verbatim in the plan and zero `098` titles. See `.feature/intake.json:82-128` and plan `:145-320`. |
| 2 | ADDRESSED | All planned production, test, documentation, and conditional allowlist paths in plan `:64-104` match the 20 globs at `.feature/intake.json:60-80`. Generated `.feature/**` state is guard-exempt per `.codex/hooks/edit-surface-guard.sh:84-87`; no amendment is needed. |
| 3 | PARTIALLY ADDRESSED | The five-column completeness CHECK and digest CHECK at plan `:366-405` compose correctly for NULL completeness and reject an address-only update. `attestPostalAddress` writes all five fields at `:514-529`; purge clears all five at `:791-801`. However, changing the address and recomputing only the digest passes both CHECKs while retaining the old timestamp, actor, and version, contradicting plan `:34` (“no writer … leaving an older attestation”). Also, `/opt/homebrew/opt/postgresql@16/share/postgresql@16/postgres.bki:1152` marks `convert_to` STABLE, not IMMUTABLE; `encode` and `sha256` are immutable at `:1732` and `:2186`. |
| 4 | ADDRESSED | T9 specifies the exact §7.6.1 and §2.4 overrides, shared-builder/send-handoff behavior, unchanged Spoilage report, enum rationale, and provenance at plan `:812-823`. The target declares itself binding at `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md:3-11` and is covered by `.feature/intake.json:76`. |
| 5 | PARTIALLY ADDRESSED | `resolveOwnerScope` correctly returns cookie-resolved location and `users.id`, and enforces subscription state (`src/lib/auth/resolve-owner-scope.ts:53-74,94-144`); `withSameOrigin` exists at `src/lib/auth/route-helpers.ts:50-70`; the page correctly uses `currentLocationId` at plan `:643-657`. But the offboarding argument at plan `:51` is false: `delete_data/pending` is operationally blocked (`src/lib/account-offboarding/gate.ts:212-224`) while confirmation leaves an active subscription unchanged (`src/lib/account-offboarding/confirm.ts:187-260`). Bare `resolveOwnerScope` therefore permits a write that `requireSettingsOwner` would block. |
| 6 | ADDRESSED | The single UPDATE scopes the business by `id` and `account_id` and validates actor membership with `EXISTS users(id, account_id)` at plan `:514-529`. The result union and required tests distinguish `actor_not_in_account` from `business_not_found` at `:225-239`, and the route maps them to 403 versus 404 at `:624`. |
| 7 | ADDRESSED | Five Creates plus six Extends are enumerated at plan `:85-100`; T1 fixes the scan to those eleven files and rejects `todo`/`skip` at `:145-153`. Because the guard itself is a named test in one fixed file, missing files cannot produce a vacuous pass. T11 reruns it and `verify-gate.sh --review` at `:848-875`. |
| 8 | PARTIALLY ADDRESSED | T6 identifies the worker exact-log assertion and the three unit business-row mocks at plan `:744-751`; those sites exist at `worker/jobs/solicitation-batch/__tests__/index.test.ts:100-118` and `src/lib/solicitation/__tests__/batch-builder.test.ts:426,594,773`. It misses a third broken fixture: `batch-builder.integration.test.ts:508-545` enables sending and requires a generation row, but its business fixture at `:365-374` has no attested address, so the new gate withholds it. |
| 9 | ADDRESSED | `MIGRATION_099_SOLICITATION_POSTAL_ADDRESS` lists all five columns at plan `:412-428`, and `:431` names all five affected live-DB suites: migration shape, postal-address, batch-builder, ask-generation, and offboarding. |
| 10 | NOT ADDRESSED | The “blocking” command at plan `:350-356` uses `… && echo OK \|\| echo "STOP…"`. Its failure branch exits 0 because `echo` succeeds, so it reports failure without blocking execution. |
| 11 | ADDRESSED | The graph and prose at plan `:108-125` match every task header: T7/T8 depend on T2, T9 on T1, T10 on T2–T9, and T11 on T10. Counts are consistent: five Creates, six Extends, 46 titles (`:85-100`). |

## Miscitation re-check

| Miscitation | Corrected? | Note |
|---|---|---|
| Watch-mode/send-handoff decision | Yes | Plan cites ticket #656, map #617, and T9 at `:303,682,812-823`; it no longer attributes the decision to deviation D2. |
| Existing offboarding `google_place_address` assertion | Yes | Plan explicitly says no such assertion exists at `:320`; the current offboarding lifecycle suite contains none. |
| Flag-stubbing helper | Yes | Plan `:143` accurately describes `process.env` mutation in the integration suite and `mocks.solicitationSendEnabled` in the unit suite. |
| `acquireLiveDbLock` location | Yes | Plan `:102,138` cites `helpers/live-db-lock.ts`; the export is at `src/lib/shared/__tests__/helpers/live-db-lock.ts:155`. |

## Cited-artifact check (new citations)

| Cited artifact | Exists? | Note |
|---|---|---|
| `src/lib/auth/resolve-owner-scope.ts` | Yes | Exports `ScopeError` at `:28` and `resolveOwnerScope` at `:94`; returns `{accountId, locationId, userId}` at `:144`. |
| `src/lib/auth/route-helpers.ts` | Yes | `withSameOrigin` is at `:57`; `requireSettingsOwner` at `:221`. Its comment confirms it skips writable-subscription enforcement at `:217-219`, but it does enforce offboarding at `:232-235`. |
| `src/lib/auth/require-owner-access.ts` | Yes | `OwnerAccess.currentLocationId` is declared at `:32-35` and returned at `:92-96`. |
| `src/app/api/dashboard/past-replies/draft/[responseId]/route.ts` | Yes | Uses `resolveOwnerScope`/`ScopeError` at `:35,74-80`; notably adds a separate offboarding check at `:103-106`. |
| `src/lib/shared/__tests__/helpers/live-db-lock.ts` | Yes | `acquireLiveDbLock` export at `:155`. |
| `src/lib/shared/__tests__/helpers/schema-ready.ts` | Yes | `MIGRATION_098_SUPPRESSION_CORRECTIONS` shape template at `:335-344`. |
| `src/lib/solicitation/batch-builder.ts` | Yes | `closedGateReason` `:130-138`; `summarize` `:515-535`; scoped SELECT `:705-710`; send seam `:762-772`. |
| `src/lib/solicitation/__tests__/batch-builder.test.ts` | Yes | `pushConstructionPreamble` at `:584-596`; all three `{ category: 'automotive' }` sites exist at `:426,594,773`, although only `:594` is inside that helper. |
| `worker/jobs/solicitation-batch/__tests__/index.test.ts` | Yes | Exact structured-log assertion at `:100-118`. |
| `worker/jobs/account-offboarding/purge-stages.ts` | Yes | Existing account-scoped `UPDATE businesses` spans `:655-682`; `google_place_address = NULL` at `:673`. |
| `src/lib/solicitation/ask-generation.ts` | Yes | `to_jsonb(b)` compatibility shim at `:188-204`, projection at `:193`. |
| Migration 098 and migration log | Yes | `supabase/migrations/098_solicitation_suppression_corrections.sql:1` exists; `.claude/reference/migrations-log.md:4` records head 098 and next 099. |

## Defects introduced by a fix

| # | Severity | Defect | Which fix introduced it | Suggested correction |
|---|---|---|---|---|
| 1 | Critical | Updating address plus digest preserves stale `attested_at`, actor, and version while satisfying both CHECKs. The claimed every-writer protection is therefore incomplete. | Fix #3 | Keep the digest CHECK, but add an OLD/NEW enforcement boundary requiring an address change to refresh attestation metadata; add an address-plus-digest-only rejection to the fix-required migration suite. |
| 2 | High | Bare `resolveOwnerScope` drops the operational offboarding block. An active/trialing account in `delete_data/pending` can mutate its address during teardown. | Fix #5 | After resolving scope, explicitly apply `getOffboardingState` plus `isOperationalUIBlocked`, matching the cited draft route. Extend the already-required blocked-write test with active subscription plus `delete_data/pending`. |
| 3 | High | The existing send-enabled batch-builder integration fixture has no attested address, so the new handoff gate breaks its required enqueue assertion. | Fix #8 | Attest that fixture before the flag-on build and reset all five attestation fields plus `owner_email_bounced` between cases. |
| 4 | Low | The migration comment says all three digest functions are IMMUTABLE, but PostgreSQL catalogs `convert_to` as STABLE. | Fix #3 | Correct the volatility claim and document why fixed-UTF8 `convert_to` is acceptable in this CHECK, or choose an immutable expression. |

VERDICT: REVISE
