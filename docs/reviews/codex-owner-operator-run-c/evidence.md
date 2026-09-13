# Run C evidence

## Round 2 corrections — 2026-09-13 14:23 UTC

The completed second pass is preserved in report-only commit `14c24897`, measured against `4127714519b253e4a0560b9cf561a987af8cf70c`. It used 766 of 1,500 supervised launches. Its 785-row inventory records 379 kills, 396 evidence-backed exclusions, three confirmed survivors across two P0 findings, and seven inconclusive oracle rows across two P1 findings. No scoped case remains unmeasured or budget-skipped. Root's finalizer confirmed every recorded process group empty and all source/dotenv state restored before either report was written. The report remains OPEN_P0; corrections do not retroactively change those measurements.

Root accepted all four findings in review round 10. Six existing test files now assert trial/grace policy persistence, the trial audit, the returned review-ID relationship in both answered-import cases, and canonical schema identity through a boolean assertion. Six integration cases now establish their own tone/policy/import prerequisites while preserving their original behavioral assertions and cleanup. No production file or test identity changed. The independent Codex draft reviews are preserved in [spec-correctness.md](spec-correctness.md).

All eleven affected cases passed individually with exactly one executed test per invocation. The six complete affected suites then passed all 146 tests, with no skips. Evidence: `/private/tmp/run-c-corrected-baselines.json`, its eleven referenced JSON reports/logs, and `/private/tmp/run-c-corrected-six-suites.log`. Both database variables were pinned to the disposable localhost:5499/test_ws4 database; Sentry upload/DSN values were empty. These runs establish corrected baselines and normal suite behavior, not new mutation kills. A new committed full review gate is next.

Surface amendment 5 records the omitted existing `src/lib/responses/__tests__/model-pinning.test.ts` path under the owner's explicit earlier approval for supporting LLM tests. Only that path was added to the identical active/durable intake copies. Historical intake hashes in the frozen reports remain unchanged. No verifier code or product scope changed.

A further mutation pass needs explicit owner authorization naming the third round. The existing runner supports that exception with its ordinary 30-launch limit; the proposed correction-only scope is eleven cases, requiring at least 22 baseline/mutant launches. No third round has opened. Staging Rule 12 configuration still awaits the requested Sentry login; candidate worker/provider proof, PR/merge, post-merge scope-card proof and closeout remain outstanding. D/E are unstarted. Development and review remain Codex only.

## Verifier extension review — 2026-09-13

Candidate `5c3c19568dd65ca7dd672ff3d95b8540742c7d7f` passed the full wrapper review gate, including build, E2E, all 72 verifier regression tests and 15,861 full-suite tests (11 skipped). Log: `/private/tmp/run-c-budget-extension-gate.log`. The existing reclassification warning remains visible; the feature retains its high-risk classification and eight tracers.

The [independent Codex review](budget-extension-review.md) found BC-F1/P2: before the first round-2 launch, an invalid Run C grant could fall back to the ordinary 30-run budget. Root accepted the finding and recorded it in review round 8 and the spec/correctness checklist. The original rejection tests started at 30 launches and therefore missed the startup case. Three zero-launch regressions reproduced the gap before correction (`/private/tmp/run-c-budget-startup-red.log`). The corrected guard requires a valid grant from the first Run C round-2 launch; all 75 regression tests now pass, including ordinary branch/round startup and their unchanged cap (`/private/tmp/run-c-budget-startup-fix-tests.log`). The gate above predates this correction; a new committed gate and focused review are still owed. Round 2 has not opened, and no mutation ran while this gap was present.

Original inventory identities remain intact. Independent scope tracing established that many conservative whole-file entries do not execute changed code; any exclusion must retain its exact mock or control-flow proof on the original row. This is inventory correction, not evidence of a successful mutation or permission to omit an in-scope case.

Current coding and review delegates are Codex. GitHub's `Claude Code Review` workflow was read back as `disabled_manually` on 2026-09-13; no workflow setting was changed. The Sentry browser is still signed out, and staging alert configuration awaits the requested owner login while local work proceeds.

## Review checkpoint — 2026-09-13 12:24 UTC

Run C is implemented but unmerged. The full review gate passed at `5f2c201769ba982f49b9ecbd82678b45e75b19b1`; its explicit full-suite command recorded 15,842 passing tests and 11 skipped, while the base test row separately skips the broad live-database lane and runs the six declared integration suites. Independent spec/correctness and security/tenancy reviews reported no findings. The maintainability review found one misleading inheritance-owner comment. Reports were committed in `8ffb8ee1`.

Root accepted all four review findings and made the scoped corrections: the context comment now identifies the separate snapshot reader, the UI test checks each state's labeled Daily limit, current plan references use module/function names, and alerting rule 12 describes the actual retained-veto invariant emitter and paging contract. The focused card/context suites passed all16 tests. Rule12 is explicitly not configured or delivery-proven; it must be configured on staging before the candidate deployment and on production before any eventual Owner Operator enablement. No production flag action is authorized here.

The [red-team report](../red-team/codex-owner-operator-run-c-14b9e1/findings.md) remains an immutable round-1 record: 683 in-scope candidates, 15 killed mutants, 668 skipped by the hard budget, and 27 explicitly excluded inventory rows. All30 supervised launches were used. Every mutation and dotenv swap was restored by the root finalizer; no mutation process remains. The three original P1 dispositions and old HEAD in that report have not been relabeled as verified fixes. A further pass must verify the fixes and remaining inventory before `reviewed` can pass.

**Approved continuation:** the owner approved the Run C-only next-pass ceiling of 1,500 supervised local test launches. The verbatim approval is recorded in the canonical sidecar, and deviation D1 bounds the remaining original inventory, accepted corrections and directly affected verifier tests. The extension requires the exact branch, original 710-row inventory identities, committed approval, corrected product baseline `72cc51abd5d45b10cd7abf3c993f9039c5e63f65` and a pinned next-pass HEAD. Other branches retain their existing limits. The 120-second launch timeout, two mutations per test, complete inventory, local-only scrubbed environment, root restoration and fail-closed results remain required. No third round or accepted risk is authorized.

All 72 runner regression tests passed, including the 1,500/1,501 boundary, invalid or uncommitted approval, changed inventory, candidate drift and journaled mutation restoration (`/private/tmp/run-c-budget-runner-tests.log`). The full review gate passed over the accepted corrections at `72cc51ab` (`/private/tmp/run-c-post-review-gate.log`); that fingerprint predates the budget extension. A new commit and full gate are required before opening round 2. No second-round mutation has run at this checkpoint.

Development and review agents now use Codex only, following the owner's instruction against external Opus delegates. The saved synthetic app-provider test report includes OpenAI and Anthropic attempts; it is product integration evidence, not a development delegation. Do not infer the instruction/test chronology from this checkpoint. The resumed review and correction work made no external LLM calls.

Remaining release work: a fresh final gate over the corrections, completed red-team verification, staging alert setup and candidate worker/provider journey, PR/merge, post-merge scope-card verification, and the closeout docs PR. Runs D and E remain unstarted and must follow C's merge and closeout.

## Earlier verification checkpoint — 2026-09-13 11:56 UTC

Implementation is complete for the Run C backend and Console cards; independent final review, deployed staging-worker evidence, merge and closeout remain outstanding. The sections below this checkpoint are dated implementation history, including failures that have since been resolved.

- Full local database coverage run: 1,177 files passed, 15,838 tests passed, one file/11 tests skipped; statements83.8%, branches80.48%, functions85.27%, lines85.08%. Log `/private/tmp/run-c-full-coverage-final.log`. Both database URLs were constrained to localhost:5499/test_ws4.
- Coverage-informed fallow passed with zero new dead-code, complexity or duplication findings across90 changed files. Log `/private/tmp/run-c-fallow-final.log`. Existing advisory CSS duplication is not a blocker.
- The acceptance audit then added real tests for reverse form/Apply contention, cross-conversation policy invalidation and zero-included-review receipt persistence. All13 policy integration tests passed; UI assertions now cover zero counts, windows/exclusions, expansion order, no Apply-all and eligible wording (38 UI tests passed). These test-only additions will run again in the final gate.
- Typecheck, scoped ESLint, all228 affected Operator tests and the candidate build passed during integration. The final review gate must rerun build/typecheck against the completed tree; prior green commands are not a current gate fingerprint.
- The exact tenant-checker entry was owner-approved and applied; the audit passes at380 entries/baseline380. Root reviewed the existing LLM and run-spine caller guards before adding only the new named eval/ingestion callers. No guard logic or lock-order exception was weakened.
- [Browser campaign](evidence/browser-campaign.md): scope, veto, cap, contractions, confirmation mismatch, readiness refusal, stale response and replay verified against local candidate UI with staging Auth/database at actual390/1440 CSS widths. Four saved changes produced four audits, zero responses and zero LLM costs. Every synthetic account/user/location/review/Operator/policy/run row and Auth session was removed; local dev process stopped.
- [Promise audit](evidence/promise-audit.md) preserves the63 original obligations and maps them to actual behavior tests. All72 reconciled source titles are present; live eval and browser obligations remain separate explicit evidence requirements, never placeholder unit tests.
- Owner decision now routes implementation and review through Codex only. No additional private source is sent to external Opus delegates. The prior keyed provider eval remains8/8 successful calls over synthetic cases.

No Run C PR, deployment or merge is claimed here. No Run D or E implementation has started.

## T1 — transaction-aware policy writer

Base `6b2eb580940480c6a9b304f3e69c0d7a3bb04f29`. The root integrated an Opus-authored patch restricted to `settings.ts` and the existing settings unit/integration suites. The form route remains unchanged. The new export runs the existing lock, gates, mutation, audit and settings reload on the caller's transaction; both entry points reject impersonation independently.

- Red-first: added tests before the export; 14 failed and 97 passed across three files. Failures detected the missing transaction seam, including the live caller-rollback and blocking cases.
- Green: 111 tests passed across settings unit, settings integration and the existing auto-approval route suite. The nine integration tests executed against the disposable localhost database; neither DB variable pointed at a remote target.
- `pnpm typecheck`: passed.
- ESLint on the three changed TypeScript files: passed.
- `pnpm build`: passed with both DB variables constrained to the local test database.
- Root review: no private gate, confirmation type, archived-policy rule or form contract changed. New tests prove policy+audit rollback, first-override seeding, untouched-field preservation, independent impersonation rejection and explicit account-before-policy query ordering.

The live lock test uses two connections and observes `pg_blocking_pids` while the holder changes the account default. The waiting writer must seed the newly committed value. The holder also probes activity, so it calls `pg_stat_clear_snapshot()` before each observation: transaction-cached activity otherwise hid the writer's new lock wait. This was a test-observation correction, not a production locking change. [PostgreSQL statistics snapshot documentation](https://www.postgresql.org/docs/16/monitoring-stats.html).

Browser verification belongs to the complete Run C journey in T7. This internal export introduces no separate visible form behavior; the existing route suite passed. No Run C end-to-end or staging completion is claimed yet.

## T4 — pure consequence simulator

The root reviewed and integrated the Opus-authored simulator and hand-counted fixtures. `simulateRule` calls the publisher's `starMeetsThreshold` and `resolveDailyCap`, excludes imports before looking up dials, and counts cap slots independently for each business/day. The caller supplies SQL day buckets and canonical UTC timestamp text; the simulator has no database, clock, or local-time dependency. Server reads and persisted proposal/receipt counts remain T5 work.

- Red-first: the new suite failed to import the missing simulator before production code was added.
- Green: all 12 unit tests passed, including the nine non-imported reviews in the hand-counted table (3 eligible; 3 below threshold, 1 cap-held, 2 manual), cap reset across days/businesses, shared-predicate spies, default cap, immutable input, and imported-only businesses.
- TypeScript, scoped ESLint, and the directory-map audit passed. The build passed with both database variables pointing at the disposable localhost database.
- Local build process only: `SENTRY_AUTH_TOKEN`, `SENTRY_DSN`, and `NEXT_PUBLIC_SENTRY_DSN` were explicitly empty, following the documented local configuration. Automatic approval review rejected the initial build command's potential source-map upload; the revised command removed that egress and was approved. No source configuration or remote setting changed.

This is an internal calculation checkpoint. Browser and staging evidence will exercise the integrated cards in T7.

## T2 — provider integration in progress

Root reviewed the Opus provider artifact against the installed OpenAI 6.39.1 and Anthropic 0.100.1 helpers. The request now carries the registered Zod schema to both adapters. Structured refusals and truncations retain their billed usage; the existing unstructured request contract is preserved. The initial red-first suite had 23 failures and 32 passes. After source integration, 54 of 55 tests passed; the remaining Operator case depends on the finite catalog schema and is not yet claimed green. TypeScript passed for this provider checkpoint.

Two tiny synthetic keyed compatibility probes ran against `gpt-4o-mini-2024-07-18` on 2026-09-13. A strict object with `minLength: 1` and `maxLength: 10` succeeded (46 prompt tokens, 8 completion tokens). A nested disjoint `oneOf` was rejected before completion with HTTP 400, identifying `oneOf` as unsupported. Root therefore removed the draft's length-bound stripping and retained the disjoint-union conversion to `anyOf`. No customer data was used. This is compatibility evidence, not the required four-task keyed evaluation. The [official structured-output guide](https://developers.openai.com/api/docs/guides/structured-outputs) documents nested `anyOf` and required object fields; the probes settle support for the project's pinned model.

After catalog integration, all 97 tests across the six catalog/input/schema/render/prompt/context suites and the three provider suites passed. Root used `z.union` for the seven strict proposal variants so the installed OpenAI helper traverses their nullable optional scope field. The source retains server semantic validation, account/location checks and operation-specific inputs. The prompt assertion now checks that confirmation fields are absent; ordinary star-scope wording is legitimate model context and is not itself a confirmation field.

The full TypeScript check currently reports three expected integration gaps: Apply still assumes `writerFields` on every operation, proposal construction still calls the voice-only preview signature, and its stored-token view is still voice-only. These belong to T3/T5. No build, complete T2 verification, browser journey or deployment is claimed for this intermediate tree.

## T3 — token sub-slice

The Opus token patch was reviewed and integrated. The original voice shape remains unchanged. Strict account and location policy tokens distinguish absent rows, include the parent row for every location, and compare opaque timestamp text without normalization. Six new tests failed before implementation while four passed; all ten tests passed afterwards. Root kept scope-specific schema helpers private and retained only the shared token schemas/types needed by consumers. Apply integration remains outstanding.

## Map decision approved

T5's assumed durable import provenance did not exist for unanswered imports. See `map-gap.md` for source evidence. On 2026-09-13 the owner approved recording origins, counting only confirmed live reviews, and labeling unknown exclusions. Root recorded surface amendment 1 and integrated the Opus-authored intake/plan amendment. Independent Codex verification round 3 approved it, retaining PC1–PC3. Work resumed; the following pause-time gate remains historical evidence of the unfinished tree at that point.

## Pause-time review gate — RED

The Stop hook requested `bash .agents/skills/feature/scripts/verified-gate.sh --review`. Root ran it against the preserved, unfinished tree on 2026-09-13 with both database variables constrained to localhost and all three Sentry variables explicitly empty. It exited 1; `.feature/gate-status.json` records `passed: false`, mode `full`, with 31 passing and eight failing rows. This is diagnostic evidence, not review approval or Run C completion.

- The main test suite, lint, targeted settings integration, offline LLM eval, database provisioning, security/static audits, and merge/diff coverage passed.
- Typecheck and build failed on the three Apply/proposal integration errors described above. The intake's combined lint/typecheck/test row also stopped at those type errors.
- Directory-map and its duplicate intake row failed because `operation-inputs.ts` has no directory entry yet. Merge-ledger failed because the Run C architecture-log entry remains outstanding.
- E2E reported 16 failed, 30 passed, and 120 skipped. The failures were admin runtime journeys whose server rejected the missing/invalid `ADMIN_APP_URL` origin configuration. This does not verify the Operator journey or replace the authorized Chrome DevTools verification.
- The promised-tests row failed because the full Run C acceptance set is unfinished.

Full output is retained at `/private/tmp/owner-operator-run-c-review-gate.log`; row logs are in this worktree's `.feature/logs/`. No further implementation was made to force a green gate while the owner map decision remained pending.

## T5.0 — ingestion-origin writers integrated

Root reviewed the Opus artifact and integrated the two insertion paths. The initial `review_ingested` step now records `live`, `imported`, or `unknown` in existing JSONB, atomically with a winning review insert. Duplicates, updates and reappearing reviews never relabel their origin. Answered imports distinguish a new row by comparing the returned ID with the UUID minted for the attempted insert; only the winner creates and completes an imported run under the billing account resolved from `businesses`.

- Red-first: 16 failures and 79 passes across four unit/integration files before the source patch.
- Green: all 95 tests passed, including the live Postgres same-identity race, duplicate preservation, actual stored JSONB marker, billing-account identity and forced transaction rollback. Both database variables pointed at the disposable localhost database.
- Root removed new `any` casts from the artifact's mocked seam and omitted a legacy business subscription field from its new fixture.

Reader, policy Apply, cards and complete-tracer build verification remain separate work; these tests do not establish Run C completion.

## T7 — structured provider evaluation

The reviewed Opus harness is integrated at `tests/llm-eval/structured-runner.ts`, behind `pnpm eval:llm --live --structured-only`. Its four synthetic cases exercise both the actual OpenAI task seam and the registered Anthropic fallback directly. Root corrected the draft's tone fixture to the required `set_auto_reply_scope` expansion case, using an eligible synthetic account and asking to show the proposal card. No customer data is used. Schema-valid output still must pass the case assertions and Operator semantic validator.

The initial live run passed three tasks and exposed an Anthropic HTTP 400: the compiled Operator grammar was too large. Requiring optional fields, restoring scalar literals, and combining those changes did not fix it. Removing only UUID-format compilation did. The provider now keeps UUID guidance in descriptions; the unchanged registered Zod schema still validates UUID syntax before tenant checks or persistence. This follows the SDK's description treatment for other constraints; [Anthropic documents interacting schema-complexity limits](https://platform.claude.com/docs/en/build-with-claude/structured-outputs#schema-complexity-limits). Both new regression tests failed before the fix and passed afterwards, also preserving application properties named `type` and `format`.

The live case also exposed missing card references and numeric policy prose. Prompt version `2026-09-13.3` adds the concrete single-card reference shape and directs policy numbers into operation inputs, where the server renders them. The final run at `2026-09-13T10:49:04.771Z` passed all four cases through both providers (eight calls), including the correct scope proposal and semantic checks. Sanitized provider/model/usage/latency results are retained at `evidence/live-structured.json`. This is keyed provider-contract evidence, not a browser or staging-worker verification claim.

After integration, 117 tests across eleven catalog/provider/prompt/eval suites passed. Scoped ESLint and the directory-map audit passed. Typecheck still reports only the three unfinished policy Apply/proposal consumer errors previously recorded; the provenance and eval additions introduce no further type errors.

## T5 — policy and consequence reader

Root reviewed and integrated the Opus reader with its two test suites. One SQL statement captures policy values, opaque version stamps, the received-review window and provenance-filtered cohort. Account simulation preserves whole-row overrides; location simulation applies the target dials. The retained-veto statement counts approved auto-policy responses from their latest immutable audit grant and locks only those audit rows.

- Red-first: both new suites failed to import the missing reader. Green: nine tests passed against the disposable local database, including the hand count, independent location caps, duplicate/conflicting/missing markers, tenant and target mismatches, microsecond tokens and UTC day boundaries, archived scopes and missing-grant invariant failures.
- Independent read-only audit by `/root/run_c_veto_lock_audit` found no tenant or lock defect. Root accepted its test gap: a foreign-account run now deliberately shares the target review's business and subject, independently protecting the account predicate. The nine tests passed again after this fixture and the explicit review-to-business join were added. Log: `/private/tmp/run-c-policy-reader-verified.log`.
- Scoped ESLint passed. Directory-map passed with 621 production files. Typecheck still reports only the three pending Apply/proposal integration errors.
- Tenant-scope audit reports one unproven binding: `agent_run_steps` has no tenant column. The joined parent run is directly account-scoped and matches both business and review. The independent audit confirmed the exact-query exception precedent in `src/lib/agents/read.ts`. A one-entry exception is drafted at `/private/tmp/run-c-tenant-allowlist-proposed.patch`; permission to add its CI file to the edit surface is pending. The checker has not been weakened or marked passing.

This remains an implementation checkpoint. Complete Apply, card, browser, staging and full-gate verification are still outstanding.

## Local E2E configuration correction

The earlier admin failures were reproduced in the pause-time gate with no valid `ADMIN_APP_URL`. Supplying `http://localhost:3000` only to the local child process resolved that configuration error. All 32 cases across `admin-14b-runtime.spec.ts` and `admin-14c-runtime.spec.ts` passed in desktop and mobile projects (8.6 seconds), including login rendering, unauthenticated redirects and API refusals. Log: `/private/tmp/run-c-admin-e2e-config.log`.

Playwright booted this worktree on localhost; both database URLs were constrained to the disposable test database and all three Sentry variables were empty. No source configuration or remote setting changed. Carry the local admin origin into the final full gate. These admin checks do not constitute Operator browser evidence.
