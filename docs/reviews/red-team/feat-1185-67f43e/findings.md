# Red-team verification — #1185

**Status: INCOMPLETE_BUDGET.** No confirmed P0 or P1 findings. Fourteen individual candidates killed their final semantic mutants; 439 individual candidates remain unexecuted. This is not a CLEAR pass.

| Severity | Open findings |
| --- | ---: |
| P0 | 0 |
| P1 | 0 |
| P2 | 0 |

## Provenance and scope

Feature mode, high risk, round 1. Branch: `feat/1185`. Fork and merge base: `07aef7a73c80f4d28d091316270325d5a584dbb9`. Reviewed HEAD: `0b374b6a9b76ac4eee3222d84b47eae3e359bf4d`. Intake SHA-256: `53824083cfd942ae4fad817c6d490608140d26276090525f1bcd4e6f42f50944`.

The complete two-direction inventory was constructed before any production mutation. Direction A includes every added or modified test and the test-file surfaces affected by changed helper imports. Direction B walks every tracked Vitest test file with the TypeScript parser, resolves relative and @/ import paths and literal import/mock references, and maps direct importers of all 25 changed production files (23 route modules, proxy and wrapper). This deliberately conservative inventory retains all individual tests in the 43 resulting files. Vitest list expanded parameterized cases under the scrubbed supervisor; all 453 names are recorded below. No changed tests were deleted. No changed fixtures, snapshots, migrations or Playwright/E2E cases were identified. No production module lacked an identified direct-import candidate.

## Re-derived evidence and isolation

The gate fingerprint was independently checked current before mutation: `8ab55944040a89c01e73559101d73eafb831cfe49dec3faa4d30dc7e58d613cf`. The existing gate test log reports 1,065 files / 14,643 tests passed and 99 files / 1,184 tests skipped; the gate reports unavailable live-DB suites rather than proving them. This pass separately established all 14 individual green baselines.

Watcher checks reported none. The runner opened round 1 on a clean committed tree. Both baseline and mutant runs used the same allowlisted environment, a temporary HOME, MOCK_EXTERNAL_APIS=true and REPWORTH_DISABLE_LIVE_DB_SUITES=1. The existing .env.local was swapped using the journaled protocol. No remote database was used and no credentials were emitted. Every Vitest execution used a regex-escaped, anchored individual full name and passed assert-one-test except the explicitly recorded non-compiling attempt.

Budget: 30 of 30 supervised launches: one discovery collection, 14 green baseline runs, and 15 mutant attempts. Fourteen final mutants were killed by assertion failures. Test RT row for the missing-Origin channel start case had one initial parse failure; that attempt was inconclusive and never counted as a kill. Its second permitted attempt compiled, executed exactly one test, and failed the expected status assertion. No other case received a second mutation. Full one-baseline/one-mutant coverage of this inventory would require at least 906 test launches plus discovery. No round 2 was opened solely to reset the quota.

## Mutation evidence

| Candidate | Production mutation | Oracle |
| --- | --- | --- |
| Admin API bearer transport > passes a well-formed bearer without reading the cookie session | src/proxy.ts: && !isImpersonation && isBearerRequest(request) → && !isImpersonation && false | One green baseline; one final assertion failure |
| Admin API bearer transport > rejects malformed Authorization without cookie fallback | src/proxy.ts: if (readBearerToken(request) === null) → if (false) | One green baseline; one final assertion failure |
| Admin API bearer transport > keeps impersonation on the cookie path | src/proxy.ts: && !isImpersonation && isBearerRequest(request) → && isBearerRequest(request) | One green baseline; one final assertion failure |
| Admin API bearer transport > refuses a disallowed Origin before bearer pass-through | src/proxy.ts: if (rawOrigin !== null && (candidate === null \|\| !isAllowedAdminOrigin(candidate, allowlist))) → if (false) | One green baseline; one final assertion failure |
| Admin API bearer transport > retains cookie refusals and does not admit owner routes or admin pages by bearer | src/proxy.ts: isAdminApiRoute(routePath) && !isImpersonation && isBearerRequest(request) → !isImpersonation && isBearerRequest(request) | One green baseline; one final assertion failure |
| withSameOriginUnlessBearer > allows bearer with forged Origin at the wrapper seam | src/lib/auth/route-helpers.ts: if (!isBearerRequest(req)) return cookieHandler(req, ...args); → if (true) return cookieHandler(req, ...args); | One green baseline; one final assertion failure |
| withSameOriginUnlessBearer > preserves cookie CSRF and owner wrapper behavior | src/lib/auth/route-helpers.ts: if (!isBearerRequest(req)) return cookieHandler(req, ...args); → if (!isBearerRequest(req)) return handler(req, ...args); | One green baseline; one final assertion failure |
| withSameOriginUnlessBearer > refuses malformed bearer before the handler despite a valid cookie | src/lib/auth/route-helpers.ts: if (readBearerToken(req) === null) → if (false) | One green baseline; one final assertion failure |
| withSameOriginUnlessBearer > forwards route arguments and propagates handler errors | src/lib/auth/route-helpers.ts: return handler(req, ...args);     };   }; }  /** JSON → return handler(req, ...([] as unknown as TArgs));     };   }; }  /** JSON | One green baseline; one final assertion failure |
| admin bearer mutation binding > admin mutation exports reach the canonical gate with a bearer | src/app/api/admin/channels/telegram/start/route.ts: export const POST = withSameOriginUnlessBearer() → export const POST = withSameOrigin() | One green baseline; one final assertion failure |
| POST /api/admin/channels/telegram/start > returns 403 when Origin header is absent | src/app/api/admin/channels/telegram/start/route.ts: withSameOriginUnlessBearer()((req → ((handler: (req: NextRequest) => Promise<Response>) => handler)((req | One green baseline; one final assertion failure |
| POST /api/admin/channels/telegram/start > returns 403 when Origin does not match the app origin | src/app/api/admin/channels/telegram/start/route.ts: withSameOriginUnlessBearer()((req → ((handler: (req: NextRequest) => Promise<Response>) => handler)((req | One green baseline; one final assertion failure |
| admin suppression routes > enforces same-origin on both admin suppression mutations | src/app/api/admin/suppressions/route.ts: withSameOriginUnlessBearer()(recordEntry) → recordEntry | One green baseline; one final assertion failure |
| admin suppression routes > enforces same-origin on the admin suppression lookup | src/app/api/admin/suppressions/lookup/route.ts: withSameOriginUnlessBearer()(lookup) → lookup | One green baseline; one final assertion failure |

The CORS mutant removes the origin refusal in the same changed proxy module to measure the new CORS-before-bearer interaction test. The channel binding test iterates six real exports within one declared test; it was still executed as one individual Vitest test and was never split or counted as six kills. Removing the CSRF wrappers on suppression routes caused the handler to execute and return 500 instead of the required 403; these are actual status assertion failures with a green baseline, not import/setup failures.

## Fragile assertions

Read every added test body. No absence-of-tag proxy, rendered-output string count or unsupported ordering assertion was found. Mock call counts here express no-cookie-fallback, no-handler-on-refusal and one-mutation-per-request behavior. The channel route test explicitly mocks the canonical gate; it proves transport delivery and gate refusal propagation, not live identity or AAL2 verification.

## Documentation versus HEAD

Ran the installed prevalidate-plan.py on the changed plan, deviations, plan-skeptic and lib-platform directory documents; all returned PASS. The plan and skeptic each resolved their pinned commit. Manually resolved the introduced and amended module/API claims against HEAD, including the shared predicate/parser imports, no-store malformed-header refusals, original downstream-request builder, unchanged owner CSRF functions and unchanged impersonation routes. The newly prepended architecture entry carries no path:line citation. Earlier architecture-ledger entries are historical material and were excluded from new-claim verification. Historical untouched descriptions elsewhere were not promoted into new findings against unrelated unchanged code.

## Sibling search

Search scope: all src/app/api/admin route.ts files, the shared auth wrapper/parser, proxy and the explicitly preserved impersonation paths. Exact search expressions: `withSameOrigin|export const (POST|PUT|PATCH|DELETE)` and `Bearer|Authorization|withSameOriginUnlessBearer|withSameOrigin`; git diff used only the immutable base and head above. Results: all 23 changed admin mutation exports use withSameOriginUnlessBearer; the only remaining cookie-only admin mutation wrappers are impersonation/start and impersonation/end, both intentional and unchanged. The header-presence and token-shape helpers and assertSameOrigin are unchanged. Owner routes, page gates and identity verification implementations were excluded from expansion because the contract keeps them intact.

## Operational completeness

The diff adds direct request refusals and transport delegation. It adds no operator-actionable terminal or swallowed background failure, Sentry signal, retry exhaustion or alert-rule change. A six-facet alert pairing therefore has no new signal/rule row to compare. Staging delivery and browser journeys remain invoking-workflow acceptance work; no browser, staging or live-database verification is claimed by this pass.

## Restoration and handoff

All mutation edits were individually reversed and production paths compared clean to pinned HEAD. The invoking lead then ran the required finalizer: all 30 process groups empty, zero mutated files still needing restoration, one dotenv file restored, journal closed, and git status fully clean. The lead explicitly confirmed finalization before either report artifact was written. The report leaves HEAD and round unchanged. No commit, push, deployment or external write occurred. The remaining 439 skipped-budget rows block the reviewed transition; owner approval of report paths supplies no budget waiver.

## Authorizations

`owner-1185-budget-continuation` (2026-09-09; finding IDs: `RT-BUDGET-1185`):

> Question: Approve the ticket-scoped verifier change needed to finish those 439 cases—at least 878 additional test runs? The red-team skill limits verification to “30 mutation runs per round,” which is the remaining blocker.
> Owner: I approve

This records approval to complete the remaining coverage using the bounded ticket-scoped verifier change, not a waiver or a new round. The original measurements, HEAD and incomplete status above remain unchanged pending actual continuation evidence. D3 records the chosen 1,400-total-launch bound and exact authorized surface.

`RT-BUDGET-1185` is a fixed P2 operational verifier-capacity finding: the journal's 30 launches measured 14 final kills and left 439 explicitly unexecuted rows. The approved mechanism resolves that capacity limit only. The remaining unmeasured rows continue to force INCOMPLETE_BUDGET. This is not an authentication defect.

## Production-to-candidate map

| Changed production file | Identified direct-import test files |
| --- | --- |
| src/app/api/admin/autonomy/unsuspend/route.ts | src/app/api/admin/autonomy/__tests__/routes.test.ts |
| src/app/api/admin/billing/grant-extension/route.ts | src/app/api/admin/billing/grant-extension/__tests__/route.test.ts |
| src/app/api/admin/businesses/[id]/keywords/route.ts | src/app/api/admin/businesses/[id]/keywords/__tests__/route.test.ts |
| src/app/api/admin/businesses/[id]/ranking/route.ts | src/app/api/admin/businesses/[id]/ranking/__tests__/route.test.ts |
| src/app/api/admin/businesses/[id]/resend-invite/route.ts | src/app/api/admin/businesses/[id]/resend-invite/__tests__/route.test.ts |
| src/app/api/admin/businesses/[id]/route.ts | src/app/api/admin/businesses/[id]/__tests__/route.test.ts |
| src/app/api/admin/businesses/[id]/zernio-queue/route.ts | src/app/api/admin/businesses/[id]/zernio-queue/__tests__/route.test.ts |
| src/app/api/admin/businesses/route.ts | src/app/api/admin/businesses/__tests__/route.test.ts |
| src/app/api/admin/channels/telegram/cancel/route.ts | src/app/api/admin/channels/__tests__/bindings.test.ts<br>src/app/api/admin/channels/telegram/__tests__/cancel.test.ts |
| src/app/api/admin/channels/telegram/disable/route.ts | src/app/api/admin/channels/__tests__/bindings.test.ts<br>src/app/api/admin/channels/telegram/__tests__/disable.test.ts |
| src/app/api/admin/channels/telegram/start/route.ts | src/app/api/admin/channels/__tests__/bindings.test.ts<br>src/app/api/admin/channels/telegram/__tests__/start.test.ts |
| src/app/api/admin/channels/whatsapp/cancel/route.ts | src/app/api/admin/channels/__tests__/bindings.test.ts<br>src/app/api/admin/channels/whatsapp/__tests__/cancel.test.ts |
| src/app/api/admin/channels/whatsapp/disable/route.ts | src/app/api/admin/channels/__tests__/bindings.test.ts<br>src/app/api/admin/channels/whatsapp/__tests__/disable.test.ts |
| src/app/api/admin/channels/whatsapp/start/route.ts | src/app/api/admin/channels/__tests__/bindings.test.ts<br>src/app/api/admin/channels/whatsapp/__tests__/start.test.ts |
| src/app/api/admin/demos/generate/route.ts | src/app/api/admin/demos/generate/__tests__/route.test.ts |
| src/app/api/admin/flagged/route.ts | src/app/api/admin/flagged/__tests__/route.test.ts |
| src/app/api/admin/locations/csv-import/route.ts | src/app/api/admin/locations/csv-import/__tests__/route.test.ts |
| src/app/api/admin/offboardings/[offboardingId]/provider-disposition/route.ts | src/app/api/admin/offboardings/__tests__/route.test.ts |
| src/app/api/admin/solicitation/batch/halt/route.ts | src/app/api/admin/solicitation/batch/__tests__/routes.test.ts |
| src/app/api/admin/solicitation/breaker/reset/route.ts | src/app/api/admin/solicitation/breaker/__tests__/reset-route.test.ts |
| src/app/api/admin/suppressions/correct/route.ts | src/app/api/admin/suppressions/__tests__/route.test.ts |
| src/app/api/admin/suppressions/lookup/route.ts | src/app/api/admin/suppressions/__tests__/route.test.ts |
| src/app/api/admin/suppressions/route.ts | src/app/api/admin/suppressions/__tests__/route.test.ts |
| src/lib/auth/route-helpers.ts | src/app/api/account/offboarding/__tests__/confirm.test.ts<br>src/app/api/account/offboarding/__tests__/fresh-auth.test.ts<br>src/app/api/account/offboarding/__tests__/keep-my-data.test.ts<br>src/app/api/account/settings/__tests__/route-plan-presentation.test.ts<br>src/app/api/dashboard/agent-team/__tests__/route.test.ts<br>src/app/api/dashboard/channels/telegram/__tests__/cancel.test.ts<br>src/app/api/dashboard/channels/telegram/__tests__/disable.test.ts<br>src/app/api/dashboard/channels/telegram/__tests__/start.test.ts<br>src/app/api/dashboard/channels/whatsapp/__tests__/cancel.test.ts<br>src/app/api/dashboard/channels/whatsapp/__tests__/disable.test.ts<br>src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts<br>src/app/api/dashboard/contacts/__tests__/flag-404.test.ts<br>src/app/api/dashboard/contacts/__tests__/suppression-route.test.ts<br>src/app/api/dashboard/escalations/__tests__/route.test.ts<br>src/app/api/dashboard/reviews/__tests__/pending-route.test.ts<br>src/app/api/dashboard/solicitation/attributed/__tests__/route.test.ts<br>src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts<br>src/lib/account-offboarding/__tests__/destructive-auth.test.ts<br>src/lib/auth/__tests__/admin-transport-seam.test.ts<br>src/lib/auth/__tests__/route-helpers.test.ts |
| src/proxy.ts | src/__tests__/proxy.test.ts |

## Complete individual inventory

| ID | Test file | Individual test | Outcome |
| --- | --- | --- | --- |
| RT-001 | src/app/api/admin/channels/telegram/__tests__/start.test.ts | POST /api/admin/channels/telegram/start > returns 403 when Origin header is absent | killed |
| RT-002 | src/app/api/admin/channels/telegram/__tests__/start.test.ts | POST /api/admin/channels/telegram/start > returns 403 when Origin does not match the app origin | killed |
| RT-003 | src/app/api/admin/channels/telegram/__tests__/start.test.ts | POST /api/admin/channels/telegram/start > returns 403 when MFA step-up is not satisfied (AAL2) | skipped-budget |
| RT-004 | src/app/api/admin/channels/telegram/__tests__/start.test.ts | POST /api/admin/channels/telegram/start > returns 404 when flag is off | skipped-budget |
| RT-005 | src/app/api/admin/channels/telegram/__tests__/start.test.ts | POST /api/admin/channels/telegram/start > returns 503 when flag on but env missing (and not in mock mode) | skipped-budget |
| RT-006 | src/app/api/admin/channels/telegram/__tests__/start.test.ts | POST /api/admin/channels/telegram/start > happy path: inserts pending enrollment and returns deepLink + qrDataUrl + expiresAt | skipped-budget |
| RT-007 | src/app/api/admin/channels/telegram/__tests__/start.test.ts | POST /api/admin/channels/telegram/start > returns 409 when enrollment is already verified | skipped-budget |
| RT-008 | src/app/api/admin/channels/telegram/__tests__/start.test.ts | POST /api/admin/channels/telegram/start > falls back to RepWorthBot when TELEGRAM_BOT_USERNAME is blank | skipped-budget |
| RT-009 | src/app/api/admin/channels/telegram/__tests__/start.test.ts | POST /api/admin/channels/telegram/start > falls back to RepWorthBot when TELEGRAM_BOT_USERNAME is whitespace only | skipped-budget |
| RT-010 | src/app/api/admin/channels/telegram/__tests__/start.test.ts | POST /api/admin/channels/telegram/start > falls back to RepWorthBot when TELEGRAM_BOT_USERNAME is unset | skipped-budget |
| RT-011 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > returns 403 for non-admin (owner) users | skipped-budget |
| RT-012 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > returns 401 for unauthenticated users | skipped-budget |
| RT-013 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > returns 403 when MFA step-up is not satisfied (AAL2) | skipped-budget |
| RT-014 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > rejects files larger than 5MB with 413 | skipped-budget |
| RT-015 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > rejects CSVs with more than 100 rows with 400 | skipped-budget |
| RT-016 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > rejects rows missing name with validation error | skipped-budget |
| RT-017 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > rejects rows missing placeId with validation error | skipped-budget |
| RT-018 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > rejects rows missing both name and placeId | skipped-budget |
| RT-019 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > creates 3 locations from valid 3-row CSV | skipped-budget |
| RT-020 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > processes each row through assertCanAddLocation | skipped-budget |
| RT-021 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > processes each valid row through addLocationTransaction | skipped-budget |
| RT-022 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > suppresses per-row Stripe overage jobs and enqueues one aggregate job after successful rows | skipped-budget |
| RT-023 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > returns partial-success report with X created, Y failed with reasons | skipped-budget |
| RT-024 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > processes valid rows even when some rows fail validation | skipped-budget |
| RT-025 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > returns 400 when no file is provided | skipped-budget |
| RT-026 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > returns 400 when no accountId is provided | skipped-budget |
| RT-027 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > returns 400 when CSV has no header row | skipped-budget |
| RT-028 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > returns 400 when CSV is missing name column | skipped-budget |
| RT-029 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > returns 400 when CSV is missing placeId column | skipped-budget |
| RT-030 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > writes csv_bulk_import audit log entry with row counts | skipped-budget |
| RT-031 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > writes csv_bulk_import audit log even when aggregate billing enqueue fails | skipped-budget |
| RT-032 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > passes voice config columns from CSV to addLocationTransaction | skipped-budget |
| RT-033 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > returns 404 when accountId does not match any account | skipped-budget |
| RT-034 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > returns 200 with 0 created, 0 failed for header-only CSV | skipped-budget |
| RT-035 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > returns 200 with 0 created and all failures when all rows invalid | skipped-budget |
| RT-036 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > reports subscription_inactive when assertCanAddLocation rejects a row | skipped-budget |
| RT-037 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > rejects the later occurrence of an in-file duplicate placeId without processing it | skipped-budget |
| RT-038 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > imports a later row whose placeId matched an earlier VALIDATION-FAILED row | skipped-budget |
| RT-039 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > attempts a later identical row when the first occurrence failed inside processRow | skipped-budget |
| RT-040 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > reports a DB-level duplicate row as duplicate_location | skipped-budget |
| RT-041 | src/app/api/admin/locations/csv-import/__tests__/route.test.ts | POST /api/admin/locations/csv-import > continues processing when addLocationTransaction throws for one row | skipped-budget |
| RT-042 | src/app/api/admin/solicitation/batch/__tests__/routes.test.ts | admin solicitation batch halt route > the admin halt route refuses a caller without AAL2 step-up and writes nothing | skipped-budget |
| RT-043 | src/app/api/admin/solicitation/batch/__tests__/routes.test.ts | admin solicitation batch halt route > the admin halt route refuses a non-admin caller even with an AAL2 session and writes nothing | skipped-budget |
| RT-044 | src/app/api/admin/solicitation/batch/__tests__/routes.test.ts | admin solicitation batch halt route > the admin halt route rejects reason, haltReason and halt_reason as unknown fields and never calls adminHaltBatch | skipped-budget |
| RT-045 | src/app/api/admin/solicitation/batch/__tests__/routes.test.ts | admin solicitation batch halt route > the admin halt route rejects a missing, empty or over-long note and writes nothing | skipped-budget |
| RT-046 | src/app/api/admin/solicitation/batch/__tests__/routes.test.ts | admin solicitation batch halt route > the admin halt route rejects a cross-origin POST before calling adminHaltBatch | skipped-budget |
| RT-047 | src/app/api/admin/solicitation/batch/__tests__/routes.test.ts | admin solicitation batch halt route > the admin halt route maps halted and already_halted to 200, not_haltable to 409 and not_found to 404 | skipped-budget |
| RT-048 | src/app/api/admin/solicitation/batch/__tests__/routes.test.ts | admin solicitation batch halt route > the admin halt reports closed: false when the close wrote nothing (no_send_parent) — #891 | skipped-budget |
| RT-049 | src/app/api/admin/solicitation/batch/__tests__/routes.test.ts | admin solicitation batch halt route > the admin halt route has no SOLICITATION_SEND_ENABLED gate — it halts with the send lane flag off | skipped-budget |
| RT-050 | src/app/api/admin/businesses/[id]/zernio-queue/__tests__/route.test.ts | POST /api/admin/businesses/[id]/zernio-queue > rejects non-admin, missing AAL2, and bad bodies | skipped-budget |
| RT-051 | src/app/api/admin/businesses/[id]/zernio-queue/__tests__/route.test.ts | POST /api/admin/businesses/[id]/zernio-queue > returns 503 when ZERNIO_PUBLISHING_ENABLED is off (force_drain only) | skipped-budget |
| RT-052 | src/app/api/admin/businesses/[id]/zernio-queue/__tests__/route.test.ts | POST /api/admin/businesses/[id]/zernio-queue > 409 connection_not_active when no active connection | skipped-budget |
| RT-053 | src/app/api/admin/businesses/[id]/zernio-queue/__tests__/route.test.ts | POST /api/admin/businesses/[id]/zernio-queue > 409 connection_not_active when the connection is pending (not active) | skipped-budget |
| RT-054 | src/app/api/admin/businesses/[id]/zernio-queue/__tests__/route.test.ts | POST /api/admin/businesses/[id]/zernio-queue > 409 queue_empty when nothing is parked | skipped-budget |
| RT-055 | src/app/api/admin/businesses/[id]/zernio-queue/__tests__/route.test.ts | POST /api/admin/businesses/[id]/zernio-queue > force_drain enqueues a drain outbox row + audit, returns queued count | skipped-budget |
| RT-056 | src/app/api/admin/businesses/[id]/zernio-queue/__tests__/route.test.ts | POST /api/admin/businesses/[id]/zernio-queue > dismiss supersedes a parked response + audit | skipped-budget |
| RT-057 | src/app/api/admin/businesses/[id]/zernio-queue/__tests__/route.test.ts | POST /api/admin/businesses/[id]/zernio-queue > 409 not_awaiting when the response is not parked / wrong business | skipped-budget |
| RT-058 | src/app/api/admin/businesses/[id]/zernio-queue/__tests__/route.test.ts | POST /api/admin/businesses/[id]/zernio-queue > dismiss is NOT gated by ZERNIO_PUBLISHING_ENABLED | skipped-budget |
| RT-059 | src/app/api/admin/businesses/[id]/zernio-queue/__tests__/route.test.ts | POST /api/admin/businesses/[id]/zernio-queue > 400 when dismiss is missing responseId | skipped-budget |
| RT-060 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/confirm > returns 404 and does not auth or start work when the feature flag is off | skipped-budget |
| RT-061 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/confirm > keeps delete_data disabled when the server flag is off | skipped-budget |
| RT-062 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/confirm > returns 403 for cross-origin requests before auth | skipped-budget |
| RT-063 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/confirm > returns 401 when unauthenticated | skipped-budget |
| RT-064 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/confirm > allows a past_due owner to confirm cancel_only via the read-level gate, not requireWritableOwner | skipped-budget |
| RT-065 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/confirm > returns 400 when the idempotency key is missing | skipped-budget |
| RT-066 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/confirm > returns 400 when the idempotency key is too long | skipped-budget |
| RT-067 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/confirm > returns 400 for invalid delete_data confirmation text before destructive auth | skipped-budget |
| RT-068 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/confirm > requires delete_data reason code and rejects free-text feedback fields | skipped-budget |
| RT-069 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/confirm > uses the destructive auth guard for delete_data and does not use the writable-owner guard | skipped-budget |
| RT-070 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/confirm > returns the destructive-auth failure before delete_data service work | skipped-budget |
| RT-071 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/confirm > returns a delete_data idempotent retry as an existing success | skipped-budget |
| RT-072 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/confirm > returns 400 for an unsupported offboarding mode | skipped-budget |
| RT-073 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/confirm > rejects free-text feedback fields | skipped-budget |
| RT-074 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/confirm > returns 409 when another active offboarding exists for a different idempotency key | skipped-budget |
| RT-075 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/confirm > returns the existing active row for an idempotent retry | skipped-budget |
| RT-076 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/confirm > returns a support-oriented error when snapshot capture fails | skipped-budget |
| RT-077 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/confirm > passes only cancel_only mode, optional reason code, and the normalized idempotency key to the service | skipped-budget |
| RT-078 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/reactivate > returns 404 and does not auth or reactivate when the feature flag is off | skipped-budget |
| RT-079 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/reactivate > returns 403 for cross-origin requests before auth | skipped-budget |
| RT-080 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/reactivate > uses the read-only owner guard and enqueues reactivation instead of calling Stripe on Vercel | skipped-budget |
| RT-081 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/reactivate > returns 400 when the reactivation idempotency key is missing | skipped-budget |
| RT-082 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/reactivate > returns 400 when the reactivation idempotency key is too long | skipped-budget |
| RT-083 | src/app/api/account/offboarding/__tests__/confirm.test.ts | POST /api/account/offboarding/reactivate > returns 409 when there is no scheduled cancel-only row to reactivate | skipped-budget |
| RT-084 | src/app/api/account/offboarding/__tests__/confirm.test.ts | GET /api/account/offboarding/status > uses the read-only owner guard for status | skipped-budget |
| RT-085 | src/app/api/account/offboarding/__tests__/confirm.test.ts | GET /api/account/offboarding/status > does not require an Origin header for the read-only status route | skipped-budget |
| RT-086 | src/app/api/account/offboarding/__tests__/confirm.test.ts | GET /api/account/offboarding/status > returns only safe active offboarding status fields | skipped-budget |
| RT-087 | src/app/api/admin/offboardings/__tests__/route.test.ts | GET /api/admin/offboardings > requires admin role and returns active or failed offboardings with scrubbed operational fields | skipped-budget |
| RT-088 | src/app/api/admin/offboardings/__tests__/route.test.ts | GET /api/admin/offboardings > returns auth rejection before querying | skipped-budget |
| RT-089 | src/app/api/admin/offboardings/__tests__/route.test.ts | POST /api/admin/offboardings/[offboardingId]/provider-disposition > requires same-origin admin AAL2 before recording a concrete provider disposition | skipped-budget |
| RT-090 | src/app/api/admin/offboardings/__tests__/route.test.ts | POST /api/admin/offboardings/[offboardingId]/provider-disposition > validates required concrete fields and passes actor/request metadata to the helper | skipped-budget |
| RT-091 | src/app/api/admin/autonomy/__tests__/routes.test.ts | admin autonomy routes > GET rejects non-admins before the cross-account list query | skipped-budget |
| RT-092 | src/app/api/admin/autonomy/__tests__/routes.test.ts | admin autonomy routes > GET returns the bounded list shape after admin AAL2 | skipped-budget |
| RT-093 | src/app/api/admin/autonomy/__tests__/routes.test.ts | admin autonomy routes > POST requires same-origin admin AAL2 and a trimmed nonempty note | skipped-budget |
| RT-094 | src/app/api/admin/autonomy/__tests__/routes.test.ts | admin autonomy routes > POST uses the canonical writer and audit in one transaction, then reports armed state | skipped-budget |
| RT-095 | src/app/api/admin/autonomy/__tests__/routes.test.ts | admin autonomy routes > POST returns 409 when the account default is not suspended | skipped-budget |
| RT-096 | src/app/api/admin/autonomy/__tests__/routes.test.ts | admin autonomy routes > POST maps a nonexistent account to the same idempotent 409 | skipped-budget |
| RT-097 | src/app/api/admin/suppressions/__tests__/route.test.ts | admin suppression routes > requires admin AAL2 on every suppression admin route | skipped-budget |
| RT-098 | src/app/api/admin/suppressions/__tests__/route.test.ts | admin suppression routes > uses the authenticated admin id for entry and correction and rejects client-supplied actor fields | skipped-budget |
| RT-099 | src/app/api/admin/suppressions/__tests__/route.test.ts | admin suppression routes > rejects blank entry notes blank correction reasons malformed suppression ids and unknown fields before any write | skipped-budget |
| RT-100 | src/app/api/admin/suppressions/__tests__/route.test.ts | admin suppression routes > enforces same-origin on both admin suppression mutations | killed |
| RT-101 | src/app/api/admin/suppressions/__tests__/route.test.ts | admin suppression routes > enforces same-origin on the admin suppression lookup | killed |
| RT-102 | src/app/api/admin/suppressions/__tests__/route.test.ts | admin suppression routes > carries the looked-up address in the request body and never in the URL | skipped-budget |
| RT-103 | src/app/api/admin/suppressions/__tests__/route.test.ts | admin suppression routes > maps the lookup service result to an explicit response body rather than serialising the union | skipped-budget |
| RT-104 | src/app/api/admin/suppressions/__tests__/route.test.ts | admin suppression routes > rejects a malformed or unknown-field lookup body before reading any tenant | skipped-budget |
| RT-105 | src/app/api/account/offboarding/__tests__/keep-my-data.test.ts | POST /api/account/offboarding/keep-my-data > returns 404 and does not auth or mutate when the feature flag is off | skipped-budget |
| RT-106 | src/app/api/account/offboarding/__tests__/keep-my-data.test.ts | POST /api/account/offboarding/keep-my-data > uses the read-only owner guard for the authenticated keep-my-data path | skipped-budget |
| RT-107 | src/app/api/account/offboarding/__tests__/keep-my-data.test.ts | POST /api/account/offboarding/keep-my-data > requires an idempotency key on the authenticated path | skipped-budget |
| RT-108 | src/app/api/account/offboarding/__tests__/keep-my-data.test.ts | POST /api/account/offboarding/keep-my-data > accepts a raw keep-my-data token from JSON without requiring owner auth | skipped-budget |
| RT-109 | src/app/api/account/offboarding/__tests__/keep-my-data.test.ts | POST /api/account/offboarding/keep-my-data > accepts a raw keep-my-data token from the same-origin email form | skipped-budget |
| RT-110 | src/app/api/account/offboarding/__tests__/keep-my-data.test.ts | POST /api/account/offboarding/keep-my-data > rejects cross-origin token posts before auth or service work | skipped-budget |
| RT-111 | src/app/api/account/offboarding/__tests__/keep-my-data.test.ts | POST /api/account/offboarding/keep-my-data > rejects a strict token body with an extra field before auth or mutation | skipped-budget |
| RT-112 | src/app/api/account/offboarding/__tests__/keep-my-data.test.ts | POST /api/account/offboarding/keep-my-data > rejects a strict authenticated body with unexpected data before auth or mutation | skipped-budget |
| RT-113 | src/app/api/account/offboarding/__tests__/keep-my-data.test.ts | POST /api/account/offboarding/keep-my-data > maps unavailable and token lifecycle failures without leaking implementation details | skipped-budget |
| RT-114 | src/app/api/account/offboarding/__tests__/keep-my-data.test.ts | GET /api/account/offboarding/keep-my-data > renders a read-only same-origin confirmation form without consuming the token | skipped-budget |
| RT-115 | src/app/api/admin/solicitation/breaker/__tests__/reset-route.test.ts | admin send-breaker reset route > the breaker reset route rejects a request without AAL2 | skipped-budget |
| RT-116 | src/app/api/admin/solicitation/breaker/__tests__/reset-route.test.ts | admin send-breaker reset route > the breaker reset route fixes the actor from the session and ignores any actor in the body | skipped-budget |
| RT-117 | src/app/api/admin/solicitation/breaker/__tests__/reset-route.test.ts | admin send-breaker reset route > the breaker reset route returns 409 when no trip is open | skipped-budget |
| RT-118 | src/app/api/admin/solicitation/breaker/__tests__/reset-route.test.ts | admin send-breaker reset route > the breaker reset route logs the actor and the trip id, and never the note text | skipped-budget |
| RT-119 | src/app/api/admin/solicitation/breaker/__tests__/reset-route.test.ts | admin send-breaker reset route > the breaker reset route logs the no-op arm with a null trip id | skipped-budget |
| RT-120 | src/app/api/admin/solicitation/breaker/__tests__/reset-route.test.ts | admin send-breaker reset route > the breaker reset route requires a non-empty note | skipped-budget |
| RT-121 | src/app/api/dashboard/channels/telegram/__tests__/disable.test.ts | POST /api/dashboard/channels/telegram/disable > 404 when flag off | skipped-budget |
| RT-122 | src/app/api/dashboard/channels/telegram/__tests__/disable.test.ts | POST /api/dashboard/channels/telegram/disable > 404 when no verified row to disable | skipped-budget |
| RT-123 | src/app/api/dashboard/channels/telegram/__tests__/disable.test.ts | POST /api/dashboard/channels/telegram/disable > 200 ok when a verified row is disabled | skipped-budget |
| RT-124 | src/app/api/dashboard/channels/telegram/__tests__/disable.test.ts | POST /api/dashboard/channels/telegram/disable > disables by account_id + location_id IS NULL, NOT by locationId (cross-location regression) | skipped-budget |
| RT-125 | src/app/api/dashboard/channels/telegram/__tests__/disable.test.ts | POST /api/dashboard/channels/telegram/disable > owner telegram disable returns 404 not_found when the location has no billing account | skipped-budget |
| RT-126 | src/app/api/dashboard/channels/telegram/__tests__/disable.test.ts | POST /api/dashboard/channels/telegram/disable > the channel cache label keeps the admin and dashboard surfaces distinct | skipped-budget |
| RT-127 | src/app/api/dashboard/channels/telegram/__tests__/disable.test.ts | POST /api/dashboard/channels/telegram/disable > runChannelStart returns the flag-off 404 without reading the database | skipped-budget |
| RT-128 | src/__tests__/proxy.test.ts | Admin API bearer transport > passes a well-formed bearer without reading the cookie session | killed |
| RT-129 | src/__tests__/proxy.test.ts | Admin API bearer transport > rejects malformed Authorization without cookie fallback | killed |
| RT-130 | src/__tests__/proxy.test.ts | Admin API bearer transport > keeps impersonation on the cookie path | killed |
| RT-131 | src/__tests__/proxy.test.ts | Admin API bearer transport > refuses a disallowed Origin before bearer pass-through | killed |
| RT-132 | src/__tests__/proxy.test.ts | Admin API bearer transport > retains cookie refusals and does not admit owner routes or admin pages by bearer | killed |
| RT-133 | src/__tests__/proxy.test.ts | proxy public launch host behavior > does not inject coming-soon headers for repworth.net public pages | skipped-budget |
| RT-134 | src/__tests__/proxy.test.ts | proxy public launch host behavior > allows repworth.net owner login to pass through as a public route | skipped-budget |
| RT-135 | src/__tests__/proxy.test.ts | proxy public launch host behavior > uses normal admin auth redirect behavior on repworth.net protected pages | skipped-budget |
| RT-136 | src/__tests__/proxy.test.ts | proxy public launch host behavior > returns 401 for unauthenticated billing API requests | skipped-budget |
| RT-137 | src/__tests__/proxy.test.ts | proxy public launch host behavior > returns 401 for unauthenticated location API requests | skipped-budget |
| RT-138 | src/__tests__/proxy.test.ts | proxy public launch host behavior > redirects sales_partner away from protected admin pages | skipped-budget |
| RT-139 | src/__tests__/proxy.test.ts | proxy public launch host behavior > returns 403 for sales_partner admin API requests | skipped-budget |
| RT-140 | src/__tests__/proxy.test.ts | proxy public launch host behavior > redirects sales_partner away from protected onboarding pages | skipped-budget |
| RT-141 | src/__tests__/proxy.test.ts | proxy public launch host behavior > redirects unauthenticated MFA challenge requests to owner login | skipped-budget |
| RT-142 | src/__tests__/proxy.test.ts | proxy public launch host behavior > redirects unauthenticated account status page requests to owner login | skipped-budget |
| RT-143 | src/__tests__/proxy.test.ts | proxy public launch host behavior > allows authenticated owners through the account status page | skipped-budget |
| RT-144 | src/__tests__/proxy.test.ts | proxy public launch host behavior > forwards refreshed Supabase cookies and the pathname header downstream on pass-through owner pages | skipped-budget |
| RT-145 | src/__tests__/proxy.test.ts | proxy public launch host behavior > redirects enrolled admin AAL1 sessions to MFA challenge when enforcement is enabled | skipped-budget |
| RT-146 | src/__tests__/proxy.test.ts | proxy public launch host behavior > preserves refreshed Supabase cookies on MFA redirects | skipped-budget |
| RT-147 | src/__tests__/proxy.test.ts | proxy public launch host behavior > returns mfa_required for enrolled owner AAL1 sessions on protected Zernio APIs | skipped-budget |
| RT-148 | src/__tests__/proxy.test.ts | proxy public launch host behavior > allows admins through the mixed-role Zernio disconnect API | skipped-budget |
| RT-149 | src/__tests__/proxy.test.ts | proxy public launch host behavior > requires MFA for admins on the mixed-role Zernio disconnect API | skipped-budget |
| RT-150 | src/__tests__/proxy.test.ts | admin API CORS > echoes Access-Control-Allow-Origin for an allowlisted admin origin | skipped-budget |
| RT-151 | src/__tests__/proxy.test.ts | admin API CORS > sends no Access-Control-Allow-Origin for a disallowed origin | skipped-budget |
| RT-152 | src/__tests__/proxy.test.ts | admin API CORS > answers an OPTIONS preflight from an allowlisted origin with 204 and the full header set, never reaching branch 4 | skipped-budget |
| RT-153 | src/__tests__/proxy.test.ts | admin API CORS > refuses an OPTIONS preflight from a disallowed origin with 403 origin | skipped-budget |
| RT-154 | src/__tests__/proxy.test.ts | admin API CORS > sets Vary: Origin on both the allowed and the refused preflight | skipped-budget |
| RT-155 | src/__tests__/proxy.test.ts | admin API CORS > refuses a non-OPTIONS admin API request from a disallowed origin with 403 before any Supabase call | skipped-budget |
| RT-156 | src/__tests__/proxy.test.ts | admin API CORS > lets a same-origin POST from this app's own origin past the CORS block | skipped-budget |
| RT-157 | src/__tests__/proxy.test.ts | admin API CORS > leaves an admin API request with no Origin header to the existing auth branch | skipped-budget |
| RT-158 | src/__tests__/proxy.test.ts | admin API CORS > admits a loopback origin on an arbitrary port outside the production lane | skipped-budget |
| RT-159 | src/__tests__/proxy.test.ts | admin API CORS > refuses a loopback origin inside the production lane | skipped-budget |
| RT-160 | src/__tests__/proxy.test.ts | admin API CORS > sets Vary: Origin on every admin API response, including a branch 4 refusal | skipped-budget |
| RT-161 | src/__tests__/proxy.test.ts | admin API CORS > writes no Access-Control header on a non-admin route | skipped-budget |
| RT-162 | src/__tests__/proxy.test.ts | admin API CORS > validates the entire allowlist before the self-origin, loopback and missing-Origin shortcuts | skipped-budget |
| RT-163 | src/__tests__/proxy.test.ts | admin API CORS > does not read ADMIN_APP_ORIGINS on a non-admin request | skipped-budget |
| RT-164 | src/__tests__/proxy.test.ts | admin API CORS > refuses empty, literal null, malformed and multi-valued Origin headers without throwing or constructing Supabase | skipped-budget |
| RT-165 | src/__tests__/proxy.test.ts | admin API CORS > refuses a disallowed origin on every method, and with cookies, Authorization or same-site fetch metadata present | skipped-budget |
| RT-166 | src/__tests__/proxy.test.ts | admin API CORS > returns the fixed preflight contract regardless of the requested method and headers | skipped-budget |
| RT-167 | src/__tests__/proxy.test.ts | admin API CORS > never sends Allow-Credentials or Expose-Headers, and sends no Access-Control header on a refusal | skipped-budget |
| RT-168 | src/__tests__/proxy.test.ts | admin API CORS > lets an OPTIONS request with no Origin reach the existing auth branch and adds only Vary | skipped-budget |
| RT-169 | src/__tests__/proxy.test.ts | admin API CORS > preserves every branch 4 outcome and refreshed Supabase cookies while stamping CORS headers | skipped-budget |
| RT-170 | src/__tests__/proxy.test.ts | admin API CORS > matches bare and normalized admin API paths and excludes admin lookalike paths | skipped-budget |
| RT-171 | src/__tests__/proxy.test.ts | admin API CORS > adds Origin to an existing Vary header without dropping or duplicating a token | skipped-budget |
| RT-172 | src/__tests__/proxy.test.ts | admin API CORS > echoes the normalized allowed origin, never the raw Origin header | skipped-budget |
| RT-173 | src/lib/auth/__tests__/admin-transport-seam.test.ts | requireAdminWithAal2 — dual-mode > cookie ok | skipped-budget |
| RT-174 | src/lib/auth/__tests__/admin-transport-seam.test.ts | requireAdminWithAal2 — dual-mode > bearer ok | skipped-budget |
| RT-175 | src/lib/auth/__tests__/admin-transport-seam.test.ts | requireAdminWithAal2 — dual-mode > the bearer client is built with persistSession and autoRefreshToken off | skipped-budget |
| RT-176 | src/lib/auth/__tests__/admin-transport-seam.test.ts | requireAdminWithAal2 — role and assurance refusals > bearer aal1 | skipped-budget |
| RT-177 | src/lib/auth/__tests__/admin-transport-seam.test.ts | requireAdminWithAal2 — role and assurance refusals > cookie aal1 remains forbidden without an enrolled factor | skipped-budget |
| RT-178 | src/lib/auth/__tests__/admin-transport-seam.test.ts | requireAdminWithAal2 — role and assurance refusals > unreadable AAL returns mfa_check_failed on both transports | skipped-budget |
| RT-179 | src/lib/auth/__tests__/admin-transport-seam.test.ts | requireAdminWithAal2 — role and assurance refusals > bearer non-admin | skipped-budget |
| RT-180 | src/lib/auth/__tests__/admin-transport-seam.test.ts | requireAdminWithAal2 — role and assurance refusals > bearer with no users row | skipped-budget |
| RT-181 | src/lib/auth/__tests__/admin-transport-seam.test.ts | requireAdminWithAal2 — role and assurance refusals > verified cookie without an application user is Forbidden | skipped-budget |
| RT-182 | src/lib/auth/__tests__/admin-transport-seam.test.ts | requireAdminWithAal2 — bearer verification > bearer expired | skipped-budget |
| RT-183 | src/lib/auth/__tests__/admin-transport-seam.test.ts | requireAdminWithAal2 — bearer verification > bearer with a forged signature | skipped-budget |
| RT-184 | src/lib/auth/__tests__/admin-transport-seam.test.ts | requireAdminWithAal2 — bearer verification > bearer revoked (the getUser arm) | skipped-budget |
| RT-185 | src/lib/auth/__tests__/admin-transport-seam.test.ts | requireAdminWithAal2 — bearer verification > a returned 4xx AuthApiError stays Unauthorized | skipped-budget |
| RT-186 | src/lib/auth/__tests__/admin-transport-seam.test.ts | requireAdminWithAal2 — bearer verification > a Supabase transport fault is internal_error, not Unauthorized | skipped-budget |
| RT-187 | src/lib/auth/__tests__/admin-transport-seam.test.ts | requireAdminWithAal2 — bearer verification > malformed JWT JSON and header shapes remain Unauthorized | skipped-budget |
| RT-188 | src/lib/auth/__tests__/admin-transport-seam.test.ts | requireAdminWithAal2 — cookie refusals > cookie authentication failures preserve the refusal contract | skipped-budget |
| RT-189 | src/lib/auth/__tests__/admin-transport-seam.test.ts | requireAdminWithAal2 — cookie refusals > a cookie-path Supabase fault keeps its pre-ticket answer, not the bearer 500 | skipped-budget |
| RT-190 | src/lib/auth/__tests__/admin-transport-seam.test.ts | refusal precedence > answers Forbidden when the caller is BOTH a non-admin and unreadable-AAL | skipped-budget |
| RT-191 | src/lib/auth/__tests__/admin-transport-seam.test.ts | refusal precedence > answers Unauthorized when the credential is bad AND the user is a non-admin | skipped-budget |
| RT-192 | src/lib/auth/__tests__/admin-transport-seam.test.ts | Admin transport precedence > a malformed Authorization header does not fall back to the cookie | skipped-budget |
| RT-193 | src/lib/auth/__tests__/admin-transport-seam.test.ts | Admin transport precedence > cookie + cross-origin still 403 | skipped-budget |
| RT-194 | src/lib/auth/__tests__/admin-transport-seam.test.ts | requireRole stays cookie-only > an owner route rejects a bearer | skipped-budget |
| RT-195 | src/lib/auth/__tests__/admin-transport-seam.test.ts | requireRole stays cookie-only > requireRole remains cookie-only for admin and mixed roles | skipped-budget |
| RT-196 | src/app/api/admin/billing/grant-extension/__tests__/route.test.ts | POST /api/admin/billing/grant-extension > requires admin role, AAL2, ticket id, and reason | skipped-budget |
| RT-197 | src/app/api/admin/billing/grant-extension/__tests__/route.test.ts | POST /api/admin/billing/grant-extension > updates accounts.flags.past_due_extension and writes account_audit_log in one transaction | skipped-budget |
| RT-198 | src/app/api/admin/billing/grant-extension/__tests__/route.test.ts | POST /api/admin/billing/grant-extension > grants real added time for an already-locked-out account (>7 days past due) | skipped-budget |
| RT-199 | src/app/api/admin/billing/grant-extension/__tests__/route.test.ts | POST /api/admin/billing/grant-extension > a max 7-day grant on a fresh past_due account yields ~14 days total (deep-scan §6.3 additive ceiling) | skipped-budget |
| RT-200 | src/app/api/admin/billing/grant-extension/__tests__/route.test.ts | POST /api/admin/billing/grant-extension > rejects accounts missing past_due_at because the extension would not be honored | skipped-budget |
| RT-201 | src/app/api/admin/billing/grant-extension/__tests__/route.test.ts | POST /api/admin/billing/grant-extension > rejects extension over 7 days by default | skipped-budget |
| RT-202 | src/app/api/admin/flagged/__tests__/route.test.ts | GET /api/admin/flagged > returns 403 for non-admins | skipped-budget |
| RT-203 | src/app/api/admin/flagged/__tests__/route.test.ts | GET /api/admin/flagged > returns 403 without a current AAL2 session | skipped-budget |
| RT-204 | src/app/api/admin/flagged/__tests__/route.test.ts | GET /api/admin/flagged > returns the total open-flag count alongside the page | skipped-budget |
| RT-205 | src/app/api/admin/flagged/__tests__/route.test.ts | GET /api/admin/flagged > lists open flags mapped to the display shape | skipped-budget |
| RT-206 | src/app/api/admin/flagged/__tests__/route.test.ts | POST /api/admin/flagged (disposition) > rejects a non-same-origin request with 403 | skipped-budget |
| RT-207 | src/app/api/admin/flagged/__tests__/route.test.ts | POST /api/admin/flagged (disposition) > requires AAL2 | skipped-budget |
| RT-208 | src/app/api/admin/flagged/__tests__/route.test.ts | POST /api/admin/flagged (disposition) > rejects an unknown action with 400 | skipped-budget |
| RT-209 | src/app/api/admin/flagged/__tests__/route.test.ts | POST /api/admin/flagged (disposition) > approve: updates status and enqueues send_notification, returns ok | skipped-budget |
| RT-210 | src/app/api/admin/flagged/__tests__/route.test.ts | POST /api/admin/flagged (disposition) > dismiss: updates status, does NOT enqueue a notification | skipped-budget |
| RT-211 | src/app/api/admin/flagged/__tests__/route.test.ts | POST /api/admin/flagged (disposition) > approve: rejects with 409 archived_location when the location is archived (flag stays open) | skipped-budget |
| RT-212 | src/app/api/admin/flagged/__tests__/route.test.ts | POST /api/admin/flagged (disposition) > dismiss: succeeds for an archived location (deliberately ungated — flags must be closable) | skipped-budget |
| RT-213 | src/app/api/admin/flagged/__tests__/route.test.ts | POST /api/admin/flagged (disposition) > requires_regeneration: supersedes the held draft and enqueues generate_response, no notification | skipped-budget |
| RT-214 | src/app/api/admin/flagged/__tests__/route.test.ts | POST /api/admin/flagged (disposition) > returns 409 when the flag is not open (already dispositioned) | skipped-budget |
| RT-215 | src/app/api/admin/flagged/__tests__/route.test.ts | POST /api/admin/flagged (disposition) > requires_regeneration: rejects an archived location with 409 archived_location and supersedes nothing | skipped-budget |
| RT-216 | src/app/api/admin/channels/whatsapp/__tests__/start.test.ts | POST /api/admin/channels/whatsapp/start > returns 404 when flag is off | skipped-budget |
| RT-217 | src/app/api/admin/channels/whatsapp/__tests__/start.test.ts | POST /api/admin/channels/whatsapp/start > returns 503 when flag on but env missing (and not in mock mode) | skipped-budget |
| RT-218 | src/app/api/admin/channels/whatsapp/__tests__/start.test.ts | POST /api/admin/channels/whatsapp/start > returns 403 when MFA step-up is not satisfied (AAL2) | skipped-budget |
| RT-219 | src/app/api/admin/channels/whatsapp/__tests__/start.test.ts | POST /api/admin/channels/whatsapp/start > returns 401 when auth fails | skipped-budget |
| RT-220 | src/app/api/admin/channels/whatsapp/__tests__/start.test.ts | POST /api/admin/channels/whatsapp/start > returns 400 when businessId is missing | skipped-budget |
| RT-221 | src/app/api/admin/channels/whatsapp/__tests__/start.test.ts | POST /api/admin/channels/whatsapp/start > returns 404 when business does not exist | skipped-budget |
| RT-222 | src/app/api/admin/channels/whatsapp/__tests__/start.test.ts | POST /api/admin/channels/whatsapp/start > returns 403 when subscription is not active | skipped-budget |
| RT-223 | src/app/api/admin/channels/whatsapp/__tests__/start.test.ts | POST /api/admin/channels/whatsapp/start > happy path: inserts pending enrollment and returns deepLink + qrDataUrl + expiresAt | skipped-budget |
| RT-224 | src/app/api/admin/channels/whatsapp/__tests__/start.test.ts | POST /api/admin/channels/whatsapp/start > deep link uses digits only (no + or whatsapp: prefix) | skipped-budget |
| RT-225 | src/app/api/admin/channels/whatsapp/__tests__/start.test.ts | POST /api/admin/channels/whatsapp/start > returns Cache-Control: no-store, private on success | skipped-budget |
| RT-226 | src/app/api/admin/channels/whatsapp/__tests__/start.test.ts | POST /api/admin/channels/whatsapp/start > returns 409 when enrollment is already verified | skipped-budget |
| RT-227 | src/app/api/admin/demos/generate/__tests__/route.test.ts | POST /api/admin/demos/generate > returns 403 when MFA step-up is not satisfied (AAL2) | skipped-budget |
| RT-228 | src/app/api/admin/demos/generate/__tests__/route.test.ts | POST /api/admin/demos/generate > returns 403 for non-admin callers | skipped-budget |
| RT-229 | src/app/api/admin/demos/generate/__tests__/route.test.ts | POST /api/admin/demos/generate > returns 503 when REDIS_CACHE_URL is not set | skipped-budget |
| RT-230 | src/app/api/admin/demos/generate/__tests__/route.test.ts | POST /api/admin/demos/generate > returns 429 when the daily rate limit is exhausted | skipped-budget |
| RT-231 | src/app/api/admin/demos/generate/__tests__/route.test.ts | POST /api/admin/demos/generate > returns 429 when the per-admin daily quota is exhausted (F-20) | skipped-budget |
| RT-232 | src/app/api/admin/demos/generate/__tests__/route.test.ts | POST /api/admin/demos/generate > returns 429 when the per-IP minute rate limit is exhausted | skipped-budget |
| RT-233 | src/app/api/admin/demos/generate/__tests__/route.test.ts | POST /api/admin/demos/generate > uses strict (fail-closed) mode on every demo-generation rate-limit check | skipped-budget |
| RT-234 | src/app/api/admin/demos/generate/__tests__/route.test.ts | POST /api/admin/demos/generate > returns 503 (not uncapped) when a Redis runtime error propagates from the limiter | skipped-budget |
| RT-235 | src/app/api/admin/demos/generate/__tests__/route.test.ts | POST /api/admin/demos/generate > returns 400 for missing required fields | skipped-budget |
| RT-236 | src/app/api/admin/demos/generate/__tests__/route.test.ts | POST /api/admin/demos/generate > returns 201 and enqueues a generate_demo outbox job on success | skipped-budget |
| RT-237 | src/app/api/admin/businesses/__tests__/route.test.ts | POST /api/admin/businesses — channel enrollment insert > returns 403 when MFA step-up is not satisfied (AAL2) | skipped-budget |
| RT-238 | src/app/api/admin/businesses/__tests__/route.test.ts | POST /api/admin/businesses — channel enrollment insert > inserts business + email enrollment inside a single sql.begin transaction | skipped-budget |
| RT-239 | src/app/api/admin/businesses/__tests__/route.test.ts | POST /api/admin/businesses — channel enrollment insert > returns 201 with the business id and nothing else | skipped-budget |
| RT-240 | src/app/api/admin/businesses/__tests__/route.test.ts | POST /api/admin/businesses — channel enrollment insert > admin onboarding accepts only owner email, owner name and business name | skipped-budget |
| RT-241 | src/app/api/admin/businesses/__tests__/route.test.ts | POST /api/admin/businesses — channel enrollment insert > admin onboarding rejects a payload carrying place, voice or tier fields | skipped-budget |
| RT-242 | src/app/api/admin/businesses/__tests__/route.test.ts | POST /api/admin/businesses — channel enrollment insert > admin onboarding creates the business on the copilot default tier | skipped-budget |
| RT-243 | src/app/api/admin/businesses/__tests__/route.test.ts | POST /api/admin/businesses — channel enrollment insert > admin onboarding enqueues no validate_place_id row | skipped-budget |
| RT-244 | src/app/api/admin/businesses/__tests__/route.test.ts | POST /api/admin/businesses — channel enrollment insert > returns 401 when requireRole rejects | skipped-budget |
| RT-245 | src/app/api/admin/businesses/__tests__/route.test.ts | POST /api/admin/businesses — channel enrollment insert > returns 400 for missing required fields | skipped-budget |
| RT-246 | src/app/api/admin/businesses/__tests__/route.test.ts | POST /api/admin/businesses — channel enrollment insert > returns 400 for a malformed owner email | skipped-budget |
| RT-247 | src/app/api/admin/businesses/__tests__/route.test.ts | POST /api/admin/businesses — channel enrollment insert > a closed Autopilot launch no longer blocks admin creation | skipped-budget |
| RT-248 | src/app/api/admin/businesses/__tests__/route.test.ts | POST /api/admin/businesses — channel enrollment insert > enrollment insert uses same ownerEmail as business insert | skipped-budget |
| RT-249 | src/app/api/admin/businesses/__tests__/route.test.ts | POST /api/admin/businesses — channel enrollment insert > calls inviteUserByEmail with lowercased email + redirectTo /reset-password | skipped-budget |
| RT-250 | src/app/api/admin/businesses/__tests__/route.test.ts | POST /api/admin/businesses — channel enrollment insert > returns 500 + does NOT mention business id when invite fails (compensating delete fires) | skipped-budget |
| RT-251 | src/app/api/admin/businesses/__tests__/route.test.ts | POST /api/admin/businesses — channel enrollment insert > returns 403 when NEXT_PUBLIC_APP_URL is missing | skipped-budget |
| RT-252 | src/app/api/admin/businesses/__tests__/route.test.ts | POST /api/admin/businesses — channel enrollment insert > UPDATE auth_id matches 0 rows → 500 + auth.admin.deleteUser + tx-wrapped DB rollback | skipped-budget |
| RT-253 | src/app/api/admin/businesses/__tests__/route.test.ts | POST /api/admin/businesses — channel enrollment insert > UPDATE auth_id throws → same 500 + rollback path (defensive coverage) | skipped-budget |
| RT-254 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > gates on the admin role and returns 401 without querying | skipped-budget |
| RT-255 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > returns 403 when the caller is authenticated but not an admin | skipped-budget |
| RT-256 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > requires the "admin" role specifically (not owner) | skipped-budget |
| RT-257 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > returns the service payload plus the echoed limit/offset — and nothing else | skipped-budget |
| RT-258 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > defaults to limit=20 offset=0 when no query params are supplied | skipped-budget |
| RT-259 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > passes through in-range limit/offset | skipped-budget |
| RT-260 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > limit ?limit=500 → 100 (clamps above the 100 ceiling) | skipped-budget |
| RT-261 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > limit ?limit=-5 → 1 (clamps negatives to the floor of 1) | skipped-budget |
| RT-262 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > limit ?limit=abc → 20 (NaN falls back to the 20 default) | skipped-budget |
| RT-263 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > limit ?limit= → 20 (empty string falls back to the 20 default) | skipped-budget |
| RT-264 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > limit=0 resolves to 20, not 1 — parseInt yields 0 which is falsy | skipped-budget |
| RT-265 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > offset ?offset=-10 → 0 (clamps negatives to 0) | skipped-budget |
| RT-266 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > offset ?offset=abc → 0 (NaN falls back to 0) | skipped-budget |
| RT-267 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > offset ?offset=250 → 250 (has no upper bound) | skipped-budget |
| RT-268 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > forwards a trimmed name search as `search` | skipped-budget |
| RT-269 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > caps the name search at 100 characters | skipped-budget |
| RT-270 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > forwards a canonical subscription status and drops anything else | skipped-budget |
| RT-271 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > forwards a churn level as `health` and drops an unknown one | skipped-budget |
| RT-272 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > does not echo the filters in the envelope | skipped-budget |
| RT-273 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > echoes the CLAMPED values, not the raw query params | skipped-budget |
| RT-274 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > maps a service throw to a 500 without leaking the error message | skipped-budget |
| RT-275 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses > serialises an empty result set without special-casing | skipped-budget |
| RT-276 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses — the admin MFA gate (#1184) > GET /api/admin/businesses — an aal2 admin is served | skipped-budget |
| RT-277 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses — the admin MFA gate (#1184) > GET /api/admin/businesses — an aal1 admin is refused 403 mfa_required | skipped-budget |
| RT-278 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses — the admin MFA gate (#1184) > GET /api/admin/businesses — a non-admin is refused 403 Forbidden | skipped-budget |
| RT-279 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses — the admin MFA gate (#1184) > GET /api/admin/businesses — an unauthenticated caller is refused 401 Unauthorized | skipped-budget |
| RT-280 | src/app/api/admin/businesses/__tests__/route.test.ts | GET /api/admin/businesses — the admin MFA gate (#1184) > GET /api/admin/businesses — a bearer-transport aal2 admin is served | skipped-budget |
| RT-281 | src/lib/account-offboarding/__tests__/destructive-auth.test.ts | requireDeleteDataDestructiveAuth > rejects cross-origin delete-data attempts before owner auth | skipped-budget |
| RT-282 | src/lib/account-offboarding/__tests__/destructive-auth.test.ts | requireDeleteDataDestructiveAuth > returns the owner auth failure when no session is present | skipped-budget |
| RT-283 | src/lib/account-offboarding/__tests__/destructive-auth.test.ts | requireDeleteDataDestructiveAuth > rejects stale fresh-auth stamps without consulting MFA state | skipped-budget |
| RT-284 | src/lib/account-offboarding/__tests__/destructive-auth.test.ts | requireDeleteDataDestructiveAuth > rejects signed fresh-auth stamps bound to another account | skipped-budget |
| RT-285 | src/lib/account-offboarding/__tests__/destructive-auth.test.ts | requireDeleteDataDestructiveAuth > rejects enrolled MFA accounts when the current session is still AAL1 | skipped-budget |
| RT-286 | src/lib/account-offboarding/__tests__/destructive-auth.test.ts | requireDeleteDataDestructiveAuth > fails closed when Supabase cannot report the current MFA assurance level | skipped-budget |
| RT-287 | src/lib/account-offboarding/__tests__/destructive-auth.test.ts | requireDeleteDataDestructiveAuth > allows a same-origin owner with fresh auth and current AAL2 | skipped-budget |
| RT-288 | src/lib/auth/__tests__/route-helpers.test.ts | withSameOrigin > calls handler when Origin matches APP_URL | skipped-budget |
| RT-289 | src/lib/auth/__tests__/route-helpers.test.ts | withSameOrigin > calls handler when Sec-Fetch-Site is same-origin and Origin matches APP_URL | skipped-budget |
| RT-290 | src/lib/auth/__tests__/route-helpers.test.ts | withSameOrigin > returns 403 when Sec-Fetch-Site is cross-site | skipped-budget |
| RT-291 | src/lib/auth/__tests__/route-helpers.test.ts | withSameOrigin > returns 403 when Origin does not match | skipped-budget |
| RT-292 | src/lib/auth/__tests__/route-helpers.test.ts | withSameOrigin > returns 403 when Origin header is absent | skipped-budget |
| RT-293 | src/lib/auth/__tests__/route-helpers.test.ts | withSameOrigin > returns 403 when NEXT_PUBLIC_APP_URL is unset | skipped-budget |
| RT-294 | src/lib/auth/__tests__/route-helpers.test.ts | withSameOrigin > accepts trailing-slash variant of APP_URL | skipped-budget |
| RT-295 | src/lib/auth/__tests__/route-helpers.test.ts | withSameOriginUnlessBearer > allows bearer with forged Origin at the wrapper seam | killed |
| RT-296 | src/lib/auth/__tests__/route-helpers.test.ts | withSameOriginUnlessBearer > preserves cookie CSRF and owner wrapper behavior | killed |
| RT-297 | src/lib/auth/__tests__/route-helpers.test.ts | withSameOriginUnlessBearer > refuses malformed bearer before the handler despite a valid cookie | killed |
| RT-298 | src/lib/auth/__tests__/route-helpers.test.ts | withSameOriginUnlessBearer > forwards route arguments and propagates handler errors | killed |
| RT-299 | src/lib/auth/__tests__/route-helpers.test.ts | requireRoleOr401 > returns { ok: true, user } and forwards the role to requireRole | skipped-budget |
| RT-300 | src/lib/auth/__tests__/route-helpers.test.ts | requireRoleOr401 > forwards the admin role through to requireRole | skipped-budget |
| RT-301 | src/lib/auth/__tests__/route-helpers.test.ts | requireRoleOr401 > maps AuthError(401) to a no-store 401 JSON response | skipped-budget |
| RT-302 | src/lib/auth/__tests__/route-helpers.test.ts | requireRoleOr401 > maps AuthError(403) to a 403 JSON response carrying the message | skipped-budget |
| RT-303 | src/lib/auth/__tests__/route-helpers.test.ts | requireRoleOr401 > THROWS on an unexpected non-AuthError failure (no 401-mask → real 5xx) | skipped-budget |
| RT-304 | src/lib/auth/__tests__/route-helpers.test.ts | requireOwnerWithAccount > returns { ok: true, user, accountId } when an owner with an account resolves | skipped-budget |
| RT-305 | src/lib/auth/__tests__/route-helpers.test.ts | requireOwnerWithAccount > returns 403 no-account (no-store) when the owner has no accountId | skipped-budget |
| RT-306 | src/lib/auth/__tests__/route-helpers.test.ts | requireOwnerWithAccount > forwards the AuthError response (401) when auth fails | skipped-budget |
| RT-307 | src/lib/auth/__tests__/route-helpers.test.ts | requireSettingsOwner > requireSettingsOwner rejects an accountId query parameter with 400 | skipped-budget |
| RT-308 | src/lib/auth/__tests__/route-helpers.test.ts | requireSettingsOwner > requireSettingsOwner returns 403 when offboarding blocks the operational UI | skipped-budget |
| RT-309 | src/lib/auth/__tests__/route-helpers.test.ts | requireSettingsOwner > requireSettingsOwner forwards the owner when the account is not offboarding | skipped-budget |
| RT-310 | src/lib/auth/__tests__/route-helpers.test.ts | requireSettingsOwner > forwards the AuthError response (401) without touching the offboarding gate | skipped-budget |
| RT-311 | src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts | GET/POST /api/dashboard/solicitation/batch > returns 404 before auth when SOLICITATION_WATCH_ENABLED is off | skipped-budget |
| RT-312 | src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts | GET/POST /api/dashboard/solicitation/batch > rejects aggregate location scope with 400 | skipped-budget |
| RT-313 | src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts | GET/POST /api/dashboard/solicitation/batch > returns uniform 404 for a location owned by another account | skipped-budget |
| RT-314 | src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts | GET/POST /api/dashboard/solicitation/batch > reads the location named by the scope param, not the owner default | skipped-budget |
| RT-315 | src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts | GET/POST /api/dashboard/solicitation/batch > does not write reviewed_at on the read path | skipped-budget |
| RT-316 | src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts | GET/POST /api/dashboard/solicitation/batch > records reviewed_at against the scoped location and answers 204 | skipped-budget |
| RT-317 | src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts | GET/POST /api/dashboard/solicitation/batch > records reviewed_at with SOLICITATION_SEND_ENABLED off | skipped-budget |
| RT-318 | src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts | GET/POST /api/dashboard/solicitation/batch > logs the reviewed row count so a zero-row update is diagnosable | skipped-budget |
| RT-319 | src/app/api/dashboard/solicitation/batch/__tests__/route.test.ts | GET/POST /api/dashboard/solicitation/batch > maps a malformed batchId onto the uniform 404 | skipped-budget |
| RT-320 | src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts | POST /api/dashboard/channels/whatsapp/start > returns 404 when flag is off | skipped-budget |
| RT-321 | src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts | POST /api/dashboard/channels/whatsapp/start > returns 503 when env is not ready (flag on, MOCK_EXTERNAL_APIS unset, required vars absent) | skipped-budget |
| RT-322 | src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts | POST /api/dashboard/channels/whatsapp/start > returns 401 when requireRole throws AuthError | skipped-budget |
| RT-323 | src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts | POST /api/dashboard/channels/whatsapp/start > returns 403 when subscription is cancelled | skipped-budget |
| RT-324 | src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts | POST /api/dashboard/channels/whatsapp/start > returns 402 when past-due recovery is read-only | skipped-budget |
| RT-325 | src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts | POST /api/dashboard/channels/whatsapp/start > returns 409 multiple_mobile_channels when startMobileEnrollment throws MultipleMobileChannelsError | skipped-budget |
| RT-326 | src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts | POST /api/dashboard/channels/whatsapp/start > returns deepLink + qrDataUrl on success | skipped-budget |
| RT-327 | src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts | POST /api/dashboard/channels/whatsapp/start > returns 409 already_verified when a verified row exists | skipped-budget |
| RT-328 | src/app/api/dashboard/channels/whatsapp/__tests__/start.test.ts | POST /api/dashboard/channels/whatsapp/start > strips internal formatting from TWILIO_WHATSAPP_NUMBER (digits only in wa.me link) | skipped-budget |
| RT-329 | src/app/api/admin/businesses/[id]/resend-invite/__tests__/route.test.ts | POST /api/admin/businesses/[id]/resend-invite > resend-invite requires admin AAL2 | skipped-budget |
| RT-330 | src/app/api/admin/businesses/[id]/resend-invite/__tests__/route.test.ts | POST /api/admin/businesses/[id]/resend-invite > rejects a non-admin caller before any provider work | skipped-budget |
| RT-331 | src/app/api/admin/businesses/[id]/resend-invite/__tests__/route.test.ts | POST /api/admin/businesses/[id]/resend-invite > rejects a cross-origin POST | skipped-budget |
| RT-332 | src/app/api/admin/businesses/[id]/resend-invite/__tests__/route.test.ts | POST /api/admin/businesses/[id]/resend-invite > resend-invite resends for an owner who has never signed in | skipped-budget |
| RT-333 | src/app/api/admin/businesses/[id]/resend-invite/__tests__/route.test.ts | POST /api/admin/businesses/[id]/resend-invite > resend-invite rejects an owner who has already signed in | skipped-budget |
| RT-334 | src/app/api/admin/businesses/[id]/resend-invite/__tests__/route.test.ts | POST /api/admin/businesses/[id]/resend-invite > resend-invite maps an unknown provider error to 502 | skipped-budget |
| RT-335 | src/app/api/admin/businesses/[id]/resend-invite/__tests__/route.test.ts | POST /api/admin/businesses/[id]/resend-invite > maps a provider rate-limit error to 429 | skipped-budget |
| RT-336 | src/app/api/admin/businesses/[id]/resend-invite/__tests__/route.test.ts | POST /api/admin/businesses/[id]/resend-invite > 404s an unknown business | skipped-budget |
| RT-337 | src/app/api/admin/businesses/[id]/resend-invite/__tests__/route.test.ts | POST /api/admin/businesses/[id]/resend-invite > 409s an account that is no longer pending_payment | skipped-budget |
| RT-338 | src/app/api/admin/businesses/[id]/resend-invite/__tests__/route.test.ts | POST /api/admin/businesses/[id]/resend-invite > 502s when the provider sign-in lookup fails (never read as "never signed in") | skipped-budget |
| RT-339 | src/app/api/admin/businesses/[id]/resend-invite/__tests__/route.test.ts | POST /api/admin/businesses/[id]/resend-invite > 429s when the per-business resend cap is exhausted, without calling the provider | skipped-budget |
| RT-340 | src/app/api/admin/businesses/[id]/resend-invite/__tests__/route.test.ts | POST /api/admin/businesses/[id]/resend-invite > 503s when the strict rate limiter is unavailable (fail-closed) | skipped-budget |
| RT-341 | src/app/api/account/offboarding/__tests__/fresh-auth.test.ts | POST /api/account/offboarding/fresh-auth > returns 404 and does not auth when account offboarding is disabled | skipped-budget |
| RT-342 | src/app/api/account/offboarding/__tests__/fresh-auth.test.ts | POST /api/account/offboarding/fresh-auth > rejects cross-origin requests before owner auth | skipped-budget |
| RT-343 | src/app/api/account/offboarding/__tests__/fresh-auth.test.ts | POST /api/account/offboarding/fresh-auth > returns the owner auth failure when no session is present | skipped-budget |
| RT-344 | src/app/api/account/offboarding/__tests__/fresh-auth.test.ts | POST /api/account/offboarding/fresh-auth > requires a password body before calling Supabase | skipped-budget |
| RT-345 | src/app/api/account/offboarding/__tests__/fresh-auth.test.ts | POST /api/account/offboarding/fresh-auth > rate-limits password reauth per owner and IP before checking the password | skipped-budget |
| RT-346 | src/app/api/account/offboarding/__tests__/fresh-auth.test.ts | POST /api/account/offboarding/fresh-auth > returns invalid credentials without stamping fresh auth when the password is wrong | skipped-budget |
| RT-347 | src/app/api/account/offboarding/__tests__/fresh-auth.test.ts | POST /api/account/offboarding/fresh-auth > verifies the password for the current owner email and sets a server-owned fresh-auth stamp | skipped-budget |
| RT-348 | src/app/api/admin/businesses/[id]/__tests__/route.test.ts | PATCH /api/admin/businesses/[id] — ownerEmail enrollment sync > returns 403 when MFA step-up is not satisfied (AAL2) | skipped-budget |
| RT-349 | src/app/api/admin/businesses/[id]/__tests__/route.test.ts | PATCH /api/admin/businesses/[id] — ownerEmail enrollment sync > PATCH with ownerEmail upserts channel_enrollments inside same txn | skipped-budget |
| RT-350 | src/app/api/admin/businesses/[id]/__tests__/route.test.ts | PATCH /api/admin/businesses/[id] — ownerEmail enrollment sync > PATCH with ownerEmail delegates cache invalidation to safe helper | skipped-budget |
| RT-351 | src/app/api/admin/businesses/[id]/__tests__/route.test.ts | PATCH /api/admin/businesses/[id] — ownerEmail enrollment sync > PATCH without ownerEmail does NOT touch channel_enrollments | skipped-budget |
| RT-352 | src/app/api/admin/businesses/[id]/__tests__/route.test.ts | PATCH /api/admin/businesses/[id] — ownerEmail enrollment sync > PATCH on unknown id returns 404 and rolls back (no enrollment upsert) | skipped-budget |
| RT-353 | src/app/api/admin/businesses/[id]/__tests__/route.test.ts | GET /api/admin/businesses/[id] — the admin MFA gate (#1184) > GET /api/admin/businesses/[id] — an aal2 admin is served | skipped-budget |
| RT-354 | src/app/api/admin/businesses/[id]/__tests__/route.test.ts | GET /api/admin/businesses/[id] — the admin MFA gate (#1184) > GET /api/admin/businesses/[id] — an aal1 admin is refused 403 mfa_required | skipped-budget |
| RT-355 | src/app/api/admin/businesses/[id]/__tests__/route.test.ts | GET /api/admin/businesses/[id] — the admin MFA gate (#1184) > GET /api/admin/businesses/[id] — a non-admin is refused 403 Forbidden | skipped-budget |
| RT-356 | src/app/api/admin/businesses/[id]/__tests__/route.test.ts | GET /api/admin/businesses/[id] — the admin MFA gate (#1184) > GET /api/admin/businesses/[id] — an unauthenticated caller is refused 401 Unauthorized | skipped-budget |
| RT-357 | src/app/api/admin/businesses/[id]/__tests__/route.test.ts | GET /api/admin/businesses/[id] — the admin MFA gate (#1184) > GET /api/admin/businesses/[id] — a bearer-transport aal2 admin is served | skipped-budget |
| RT-358 | src/app/api/admin/channels/__tests__/bindings.test.ts | admin bearer mutation binding > admin mutation exports reach the canonical gate with a bearer | killed |
| RT-359 | src/app/api/admin/channels/__tests__/bindings.test.ts | admin start binds the strict subscription gate (§4.2) > POST /api/admin/channels/telegram/start returns 403 subscription_not_active for a cancelled account | skipped-budget |
| RT-360 | src/app/api/admin/channels/__tests__/bindings.test.ts | admin start binds the strict subscription gate (§4.2) > POST /api/admin/channels/whatsapp/start returns 403 subscription_not_active for a cancelled account | skipped-budget |
| RT-361 | src/app/api/admin/channels/__tests__/bindings.test.ts | admin cancel and disable bind NO subscription gate (§4.2) > admin telegram cancel succeeds on a cancelled account | skipped-budget |
| RT-362 | src/app/api/admin/channels/__tests__/bindings.test.ts | admin cancel and disable bind NO subscription gate (§4.2) > admin whatsapp cancel succeeds on a cancelled account | skipped-budget |
| RT-363 | src/app/api/admin/channels/__tests__/bindings.test.ts | admin cancel and disable bind NO subscription gate (§4.2) > admin telegram disable reaches the disconnect on a cancelled account | skipped-budget |
| RT-364 | src/app/api/admin/channels/__tests__/bindings.test.ts | admin cancel and disable bind NO subscription gate (§4.2) > admin whatsapp disable reaches the disconnect on a cancelled account | skipped-budget |
| RT-365 | src/app/api/admin/channels/__tests__/bindings.test.ts | admin routes resolve the admin surface > the channel cache label keeps the admin and dashboard surfaces distinct | skipped-budget |
| RT-366 | src/app/api/admin/channels/__tests__/bindings.test.ts | admin routes resolve the admin surface > admin disable forwards surface admin to disconnectChannel | skipped-budget |
| RT-367 | src/app/api/admin/channels/__tests__/bindings.test.ts | admin routes issue exactly one query before their mutation > admin telegram start resolves the actor with a single accounts join | skipped-budget |
| RT-368 | src/app/api/admin/channels/__tests__/bindings.test.ts | admin routes issue exactly one query before their mutation > admin telegram cancel resolves the actor with a single accounts join | skipped-budget |
| RT-369 | src/app/api/admin/channels/__tests__/bindings.test.ts | admin routes issue exactly one query before their mutation > admin telegram disable resolves the actor with a single accounts join | skipped-budget |
| RT-370 | src/app/api/admin/channels/__tests__/bindings.test.ts | admin start failure responses carry the no-store headers > admin telegram start missing businessId response sets Cache-Control: no-store, private | skipped-budget |
| RT-371 | src/app/api/admin/channels/__tests__/bindings.test.ts | admin start failure responses carry the no-store headers > admin telegram start unknown business response sets Cache-Control: no-store, private | skipped-budget |
| RT-372 | src/app/api/admin/channels/__tests__/bindings.test.ts | admin start failure responses carry the no-store headers > admin telegram start inactive subscription response sets Cache-Control: no-store, private | skipped-budget |
| RT-373 | src/app/api/admin/channels/__tests__/bindings.test.ts | admin whatsapp start uses the shared deep-link builder > the wa.me deep link strips every non-digit from TWILIO_WHATSAPP_NUMBER | skipped-budget |
| RT-374 | src/app/api/dashboard/solicitation/attributed/__tests__/route.test.ts | GET attributed > GET attributed: gates on the flag before auth and passes account, location scope and send state to the read model | skipped-budget |
| RT-375 | src/app/api/dashboard/contacts/__tests__/suppression-route.test.ts | owner contact suppression route > returns a uniform 404 for a contact belonging to another account | skipped-budget |
| RT-376 | src/app/api/dashboard/contacts/__tests__/suppression-route.test.ts | owner contact suppression route > refuses to clear a global row through the owner path | skipped-budget |
| RT-377 | src/app/api/dashboard/contacts/__tests__/suppression-route.test.ts | owner contact suppression route > derives account business contact and actor ids only from authenticated scope and route params | skipped-budget |
| RT-378 | src/app/api/dashboard/contacts/__tests__/suppression-route.test.ts | owner contact suppression route same-origin wrapper > enforces same-origin on both owner suppression mutations | skipped-budget |
| RT-379 | src/app/api/dashboard/channels/telegram/__tests__/start.test.ts | POST /api/dashboard/channels/telegram/start > returns 404 when flag is off | skipped-budget |
| RT-380 | src/app/api/dashboard/channels/telegram/__tests__/start.test.ts | POST /api/dashboard/channels/telegram/start > returns 401 when requireRole throws AuthError | skipped-budget |
| RT-381 | src/app/api/dashboard/channels/telegram/__tests__/start.test.ts | POST /api/dashboard/channels/telegram/start > returns 409 multiple_mobile_channels when startMobileEnrollment throws MultipleMobileChannelsError | skipped-budget |
| RT-382 | src/app/api/dashboard/channels/telegram/__tests__/start.test.ts | POST /api/dashboard/channels/telegram/start > uses the configured TELEGRAM_BOT_USERNAME in the t.me deep link | skipped-budget |
| RT-383 | src/app/api/dashboard/channels/telegram/__tests__/start.test.ts | POST /api/dashboard/channels/telegram/start > falls back to RepWorthBot when TELEGRAM_BOT_USERNAME is blank/whitespace | skipped-budget |
| RT-384 | src/app/api/dashboard/channels/telegram/__tests__/start.test.ts | POST /api/dashboard/channels/telegram/start > falls back to RepWorthBot when TELEGRAM_BOT_USERNAME is unset | skipped-budget |
| RT-385 | src/app/api/dashboard/agent-team/__tests__/route.test.ts | GET /api/dashboard/agent-team > returns the location-scoped agent summary using the default dashboard window | skipped-budget |
| RT-386 | src/app/api/dashboard/agent-team/__tests__/route.test.ts | GET /api/dashboard/agent-team > returns the canonical 401 owner-auth response without reading data | skipped-budget |
| RT-387 | src/app/api/dashboard/agent-team/__tests__/route.test.ts | GET /api/dashboard/agent-team > returns the canonical 403 owner-auth response without reading data | skipped-budget |
| RT-388 | src/app/api/dashboard/agent-team/__tests__/route.test.ts | GET /api/dashboard/agent-team > clamps an invalid window to 30d before it reaches the read module | skipped-budget |
| RT-389 | src/app/api/dashboard/agent-team/__tests__/route.test.ts | GET /api/dashboard/agent-team > accepts the canonical 7d dashboard window | skipped-budget |
| RT-390 | src/app/api/dashboard/agent-team/__tests__/route.test.ts | GET /api/dashboard/agent-team > accepts the canonical 30d dashboard window | skipped-budget |
| RT-391 | src/app/api/dashboard/agent-team/__tests__/route.test.ts | GET /api/dashboard/agent-team > accepts the canonical 90d dashboard window | skipped-budget |
| RT-392 | src/app/api/dashboard/agent-team/__tests__/route.test.ts | GET /api/dashboard/agent-team > accepts the canonical 12w dashboard window | skipped-budget |
| RT-393 | src/app/api/dashboard/agent-team/__tests__/route.test.ts | GET /api/dashboard/agent-team > returns an account-wide summary for aggregate scope and preserves a valid window | skipped-budget |
| RT-394 | src/app/api/dashboard/agent-team/__tests__/route.test.ts | GET /api/dashboard/agent-team > returns 404 without reading outcomes when a requested location belongs to another account | skipped-budget |
| RT-395 | src/app/api/dashboard/agent-team/__tests__/route.test.ts | GET /api/dashboard/agent-team > returns the uniform 404 without reading outcomes when the location does not exist | skipped-budget |
| RT-396 | src/app/api/dashboard/agent-team/__tests__/route.test.ts | GET /api/dashboard/agent-team > returns the uniform 404 without reading outcomes when the location is archived | skipped-budget |
| RT-397 | src/app/api/dashboard/agent-team/__tests__/route.test.ts | GET /api/dashboard/agent-team > rejects a malformed location scope before the location or outcomes reads | skipped-budget |
| RT-398 | src/app/api/admin/businesses/[id]/ranking/__tests__/route.test.ts | POST /api/admin/businesses/[id]/ranking > returns 403 when MFA step-up is not satisfied (AAL2) | skipped-budget |
| RT-399 | src/app/api/admin/businesses/[id]/ranking/__tests__/route.test.ts | POST /api/admin/businesses/[id]/ranking > returns 400 for missing keyword | skipped-budget |
| RT-400 | src/app/api/admin/businesses/[id]/ranking/__tests__/route.test.ts | POST /api/admin/businesses/[id]/ranking > returns 400 for rank_position out of range (0) | skipped-budget |
| RT-401 | src/app/api/admin/businesses/[id]/ranking/__tests__/route.test.ts | POST /api/admin/businesses/[id]/ranking > returns 200 for valid input | skipped-budget |
| RT-402 | src/app/api/admin/businesses/[id]/ranking/__tests__/route.test.ts | POST /api/admin/businesses/[id]/ranking > returns 200 when date is omitted (defaults to today) | skipped-budget |
| RT-403 | src/app/api/admin/businesses/[id]/ranking/__tests__/route.test.ts | POST /api/admin/businesses/[id]/ranking > returns 200 when rankPosition is null | skipped-budget |
| RT-404 | src/app/api/admin/businesses/[id]/ranking/__tests__/route.test.ts | POST /api/admin/businesses/[id]/ranking > returns 400 for invalid calendar date (2026-99-99) | skipped-budget |
| RT-405 | src/app/api/admin/businesses/[id]/ranking/__tests__/route.test.ts | POST /api/admin/businesses/[id]/ranking > returns 400 for whitespace-only keyword | skipped-budget |
| RT-406 | src/app/api/dashboard/reviews/__tests__/pending-route.test.ts | GET /api/dashboard/reviews/pending > reads the session location by default with offset 0 | skipped-budget |
| RT-407 | src/app/api/dashboard/reviews/__tests__/pending-route.test.ts | GET /api/dashboard/reviews/pending > reads the account scope for ?scope=all and forwards the offset | skipped-budget |
| RT-408 | src/app/api/dashboard/reviews/__tests__/pending-route.test.ts | GET /api/dashboard/reviews/pending > refuses a location that belongs to another account | skipped-budget |
| RT-409 | src/app/api/dashboard/reviews/__tests__/pending-route.test.ts | GET /api/dashboard/reviews/pending > rejects a malformed scope before touching the DB | skipped-budget |
| RT-410 | src/app/api/dashboard/reviews/__tests__/pending-route.test.ts | GET /api/dashboard/reviews/pending > clamps a garbage offset to 0 | skipped-budget |
| RT-411 | src/app/api/dashboard/reviews/__tests__/pending-route.test.ts | GET /api/dashboard/reviews/pending > returns the auth failure untouched | skipped-budget |
| RT-412 | src/app/api/dashboard/channels/telegram/__tests__/cancel.test.ts | POST /api/dashboard/channels/telegram/cancel > POST /api/dashboard/channels/telegram/cancel returns 404 when the flag is off | skipped-budget |
| RT-413 | src/app/api/dashboard/channels/telegram/__tests__/cancel.test.ts | POST /api/dashboard/channels/telegram/cancel > POST /api/dashboard/channels/telegram/cancel cancels a pending enrollment for an active subscription | skipped-budget |
| RT-414 | src/app/api/dashboard/channels/telegram/__tests__/cancel.test.ts | POST /api/dashboard/channels/telegram/cancel > owner telegram cancel returns 404 not_found when the location has no billing account | skipped-budget |
| RT-415 | src/app/api/admin/channels/whatsapp/__tests__/disable.test.ts | POST /api/admin/channels/whatsapp/disable > returns 404 when flag is off | skipped-budget |
| RT-416 | src/app/api/admin/channels/whatsapp/__tests__/disable.test.ts | POST /api/admin/channels/whatsapp/disable > returns 403 when MFA step-up is not satisfied (AAL2) | skipped-budget |
| RT-417 | src/app/api/admin/channels/whatsapp/__tests__/disable.test.ts | POST /api/admin/channels/whatsapp/disable > flips verified → disabled (account-scoped) and returns 200 | skipped-budget |
| RT-418 | src/app/api/admin/channels/whatsapp/__tests__/disable.test.ts | POST /api/admin/channels/whatsapp/disable > returns 404 when no verified row and no live override matches | skipped-budget |
| RT-419 | src/app/api/admin/channels/whatsapp/__tests__/disable.test.ts | POST /api/admin/channels/whatsapp/disable > returns 404 when the business does not exist | skipped-budget |
| RT-420 | src/app/api/admin/businesses/[id]/keywords/__tests__/route.test.ts | PUT /api/admin/businesses/[id]/keywords > returns 403 when MFA step-up is not satisfied (AAL2) | skipped-budget |
| RT-421 | src/app/api/admin/businesses/[id]/keywords/__tests__/route.test.ts | PUT /api/admin/businesses/[id]/keywords > returns 400 for non-array keywords | skipped-budget |
| RT-422 | src/app/api/admin/businesses/[id]/keywords/__tests__/route.test.ts | PUT /api/admin/businesses/[id]/keywords > returns 400 for more than 5 keywords | skipped-budget |
| RT-423 | src/app/api/admin/businesses/[id]/keywords/__tests__/route.test.ts | PUT /api/admin/businesses/[id]/keywords > returns 200 for valid input | skipped-budget |
| RT-424 | src/app/api/admin/businesses/[id]/keywords/__tests__/route.test.ts | PUT /api/admin/businesses/[id]/keywords > returns 200 for empty array (clearing keywords) | skipped-budget |
| RT-425 | src/app/api/admin/businesses/[id]/keywords/__tests__/route.test.ts | PUT /api/admin/businesses/[id]/keywords > returns 404 when business not found | skipped-budget |
| RT-426 | src/app/api/admin/businesses/[id]/keywords/__tests__/route.test.ts | PUT /api/admin/businesses/[id]/keywords > returns 400 for whitespace-only keywords | skipped-budget |
| RT-427 | src/app/api/admin/channels/telegram/__tests__/disable.test.ts | POST /api/admin/channels/telegram/disable > returns 404 when flag is off | skipped-budget |
| RT-428 | src/app/api/admin/channels/telegram/__tests__/disable.test.ts | POST /api/admin/channels/telegram/disable > returns 403 when MFA step-up is not satisfied (AAL2) | skipped-budget |
| RT-429 | src/app/api/admin/channels/telegram/__tests__/disable.test.ts | POST /api/admin/channels/telegram/disable > flips verified → disabled and returns 200 | skipped-budget |
| RT-430 | src/app/api/admin/channels/telegram/__tests__/disable.test.ts | POST /api/admin/channels/telegram/disable > returns 404 when no verified row and no live override matches | skipped-budget |
| RT-431 | src/app/api/admin/channels/telegram/__tests__/disable.test.ts | POST /api/admin/channels/telegram/disable > returns 404 when the business does not exist | skipped-budget |
| RT-432 | src/app/api/admin/channels/whatsapp/__tests__/cancel.test.ts | POST /api/admin/channels/whatsapp/cancel > returns 404 when flag is off | skipped-budget |
| RT-433 | src/app/api/admin/channels/whatsapp/__tests__/cancel.test.ts | POST /api/admin/channels/whatsapp/cancel > returns 403 when MFA step-up is not satisfied (AAL2) | skipped-budget |
| RT-434 | src/app/api/admin/channels/whatsapp/__tests__/cancel.test.ts | POST /api/admin/channels/whatsapp/cancel > clears verification hash + expiry on pending row and returns 200 | skipped-budget |
| RT-435 | src/app/api/dashboard/escalations/__tests__/route.test.ts | GET /api/dashboard/escalations > returns the canonical 401 owner-auth response without listing data | skipped-budget |
| RT-436 | src/app/api/dashboard/escalations/__tests__/route.test.ts | GET /api/dashboard/escalations > returns the canonical 403 owner-auth response without listing data | skipped-budget |
| RT-437 | src/app/api/dashboard/escalations/__tests__/route.test.ts | GET /api/dashboard/escalations > returns the account-scoped open-escalation list unchanged | skipped-budget |
| RT-438 | src/app/api/dashboard/escalations/__tests__/route.test.ts | GET /api/dashboard/escalations > maps an unexpected listing failure to the shared 500 dashboard-read boundary | skipped-budget |
| RT-439 | src/app/api/dashboard/escalations/__tests__/route.test.ts | GET /api/dashboard/escalations > preserves requireOwnerWithAccount rethrows outside the 500 boundary | skipped-budget |
| RT-440 | src/app/api/account/settings/__tests__/route-plan-presentation.test.ts | GET /api/account/settings plan presentation > returns stored current cents plus founding targets and closed Autopilot | skipped-budget |
| RT-441 | src/app/api/account/settings/__tests__/route-plan-presentation.test.ts | GET /api/account/settings plan presentation > fails closed before pricing reads when the stored variant is invalid | skipped-budget |
| RT-442 | src/app/api/account/settings/__tests__/route-plan-presentation.test.ts | GET /api/account/settings plan presentation > fails closed before pricing reads when the stored tier is unsupported | skipped-budget |
| RT-443 | src/app/api/dashboard/channels/whatsapp/__tests__/cancel.test.ts | POST /api/dashboard/channels/whatsapp/cancel > 404 when flag off | skipped-budget |
| RT-444 | src/app/api/dashboard/channels/whatsapp/__tests__/cancel.test.ts | POST /api/dashboard/channels/whatsapp/cancel > 200 ok on cancel of active subscription | skipped-budget |
| RT-445 | src/app/api/dashboard/channels/whatsapp/__tests__/cancel.test.ts | POST /api/dashboard/channels/whatsapp/cancel > owner whatsapp cancel returns 404 not_found when the location has no billing account | skipped-budget |
| RT-446 | src/app/api/dashboard/channels/whatsapp/__tests__/disable.test.ts | POST /api/dashboard/channels/whatsapp/disable > 404 when flag off | skipped-budget |
| RT-447 | src/app/api/dashboard/channels/whatsapp/__tests__/disable.test.ts | POST /api/dashboard/channels/whatsapp/disable > 404 when no verified row to disable | skipped-budget |
| RT-448 | src/app/api/dashboard/channels/whatsapp/__tests__/disable.test.ts | POST /api/dashboard/channels/whatsapp/disable > 200 ok when a verified row is disabled | skipped-budget |
| RT-449 | src/app/api/dashboard/channels/whatsapp/__tests__/disable.test.ts | POST /api/dashboard/channels/whatsapp/disable > owner whatsapp disable returns 404 not_found when the location has no billing account | skipped-budget |
| RT-450 | src/app/api/dashboard/contacts/__tests__/flag-404.test.ts | SOLICITATION_WATCH_ENABLED route gate > contacts API routes return 404 when SOLICITATION_WATCH_ENABLED is off | skipped-budget |
| RT-451 | src/app/api/admin/channels/telegram/__tests__/cancel.test.ts | POST /api/admin/channels/telegram/cancel > returns 404 when flag is off | skipped-budget |
| RT-452 | src/app/api/admin/channels/telegram/__tests__/cancel.test.ts | POST /api/admin/channels/telegram/cancel > returns 403 when MFA step-up is not satisfied (AAL2) | skipped-budget |
| RT-453 | src/app/api/admin/channels/telegram/__tests__/cancel.test.ts | POST /api/admin/channels/telegram/cancel > clears verification hash + expiry on pending row and returns 200 | skipped-budget |

Full mutation descriptions, reasons, counts and evidence hashes are in the strict JSON sidecar. Every unexecuted candidate is explicitly skipped-budget; no inference of test strength is made for those cases.
