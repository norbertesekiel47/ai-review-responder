# Run C — independent spec/correctness review

Candidate: `5f2c201769ba982f49b9ecbd82678b45e75b19b1`  
Fork / merge-base: `6b2eb580940480c6a9b304f3e69c0d7a3bb04f29`

## Verdict

No findings at or above 80% confidence. This is a code-review result for the immutable candidate, not a claim that staging deployment or the outstanding live user journey is complete.

## Findings

None.

## Review coverage and evidence

The provided reconstructed contract was used as the review brief. All source, test, and checked-in documentation inspection used `git show` at the candidate or `git diff` between the two immutable revisions. The untracked review brief was read directly. No production/test changes, test execution against the concurrent mutable checkout, commits, external calls, or delegation were performed.

Every entry in `docs/reviews/finding-checklists/spec-correctness.md` was read and assessed for applicability. Relevant recurring classes checked here included wording versus the actual query window, nullable state semantics, scope-specific counts, real caller coverage after extracting a shared writer, test titles versus their assertions, zero-result presentation, and evidence that belongs to browser/live execution rather than component tests.

Reviewed behavior:

- The seven operation inputs and catalog adapters preserve the three policy domains and existing four voice operations. Full-state preview creation follows the shared writer's manual-first new-row semantics, including the account default's stored veto/cap dials. Existing manual location overrides remain manual. Account scope is preserved through normalized nullable provider scope, preparation, rendering, Apply, and receipts.
- Policy Apply takes the account lock before the proposal, compares current/prepared/expected tokens, reparses the stored operation input, classifies exposure from current state, compares exact typed confirmation against the stored result, and maps a valid expansion to the existing writer's `standard` vocabulary. Archived contractions and repeated receipt reads follow their distinct paths. The extracted transaction entry retains the existing form wrapper and writer gates.
- Applied receipts use the actual persisted policy state, preserve frozen replay behavior, recompute both consequences over the same pre-write cohort, and sweep only dependent policy proposals. Location overrides survive account-default writes. Retained-veto counting uses the latest audit grant per relevant approved response and excludes other statuses and account-default overrides.
- Consequences use the received `detected_at` window, exclusive upper bound, UTC day keys, independent location/day caps, the shared threshold/default-cap functions, and explicit imported/unknown exclusions. Origin classification handles absent, inconsistent, unrecognized and duplicate initial markers without multiplying reviews. Both genuine-first-insert writers stamp origin atomically; conflicts and updates leave initial provenance alone.
- Console cards retain exact full state, account-versus-location labeling, created-row disclosure, typed expansion confirmation, readiness display, one-click contractions, eligibility wording, veto-delay/busiest-day additions, and stored receipt details. The Apply hook sends the typed value and reloads the transcript after success.
- The structured schema reaches OpenAI and Anthropic through `runLlmTask`. OpenAI's schema conversion and Anthropic's supported-keyword adaptation retain authoritative local Zod validation. Unstructured request behavior remains separate. Structured refusals and truncations retain usage and are rejected before parsing even if their text could otherwise parse.

The reconciled promise additions were inspected in actual test bodies, not accepted solely from the audit table:

- `src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:229`: four separate conversations, including inheriting and overridden locations, with policy staleness, unchanged voice status, preserved override value, and persistent footprint assertions.
- `src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:261`: an unknown review arrives after preparation; the persisted zero-included receipt recomputes exclusions, retains the shared window, and records the actual threshold change.
- `src/lib/agents/operator/__tests__/policy-apply.integration.test.ts:350`: a real second form writer blocks on the account while Apply is held before commit; after release, the final form state and frozen Apply receipt are checked independently.
- `src/lib/llm/__tests__/openai-provider.test.ts:313`: each registered structured task exercises the real task seam and both real adapters with mocked SDK transport, verifies derived schemas, and verifies billed primary refusal plus fallback truncation.

## Uncertain observations and verification limits

No separate suspected defect is being proposed for triage. Recorded keyed-provider success and prior browser evidence were treated as supplied evidence, not independently rerun measurements. The candidate staging deployment/provider turn and post-merge scope verification remain the release obligations identified in the brief. This review did not exercise Computer Use or certify responsive layout from source inspection.

## Independent correction draft reviews — 2026-09-13

Native Codex reviewer: `/root/run_c_ui_mutation_prep`. The two reports below are preserved verbatim from scratch after the frozen second pass and root restoration. Root applied the exact six reviewed drafts; ordinary baseline and suite evidence is recorded separately in `evidence.md`.

# Run C correction draft review

**No actionable findings in the three reviewed drafts.** The proposed assertions address the exact faults described in the correction plan, preserve the existing test identities and assertions, and introduce no new incidental contract that needs correction before application.

This is an independent static review against candidate `4127714519b253e4a0560b9cf561a987af8cf70c` in `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-owner-operator-run-c`. The reported survivor/formatter outcomes are supplied context, not outcomes remeasured by this review. Production and test source were read through immutable `git show` objects. Each patch was reconstructed against those bytes in memory only; every hunk matched at its exact stated original line, and every `it`/`test`/`describe` declaration remained unchanged.

| Draft | Assessment of the exact fault |
|---|---|
| `/private/tmp/run-c-settings-test-correction.patch` | The added returned-state, simulated persisted-state, and audit assertions detect the I0228 writer-omission fault. The adjacent past-due success-leg hardening preserves its expired-grace refusal and original total audit-count assertion. |
| `/private/tmp/run-c-zernio-test-correction.patch` | Both I0394 and I0403 now inspect the response's actual bound review ID. Returning the minted ID instead of `RETURNING id` changes that binding and violates the new equality. |
| `/private/tmp/run-c-model-pinning-test-correction.patch` | I0592 retains schema reference identity while passing only a boolean into the matcher, avoiding traversal of the two schema objects when reporting an identity mismatch. |

## Assertion and contract trace

**Settings.** At the pin, `patchAutoApprovalSettingsInTransaction` in `src/lib/auto-approval/settings.ts` invokes `updatePolicyInTransaction`, then reloads settings with the locked account. The reported replacement with the account lock alone leaves `dbState.accountDefault` null: the test's `beforeEach` clears it, and the recording SQL implementation assigns that field only when handling the policy INSERT/UPDATE. It also never reaches `writeAudit`. Thus the old `readiness.canExpand` result can remain true while the proposed `exists: true`, `threshold: 5`, persisted threshold, and one-audit assertions fail on the omitted write. The added audit payload expectations match `writeAudit` in `src/lib/auto-approval/settings.ts`: caller account/actor IDs, `auto_approval_policy_changed`, `set_account_default`, expansion, and the new effective threshold. These are meaningful write/audit semantics rather than query-count or timestamp details. The original trialing fixture, confirmation, readiness assertion, and full test title are retained. The adjacent past-due test still clears the policy before its expired-grace request and still requires exactly one audit across its success/refusal legs.

**Zernio.** In `worker/jobs/zernio/zernio-ingest-shared.ts`, `insertImportedReview` reads the ID returned by the INSERT and returns that `reviewId` to its caller. `insertImportedResponse` uses its received `reviewId` for both version allocation and the response INSERT. In that INSERT, `id` is generated by the SQL literal `gen_random_uuid()`, making the first interpolation specifically `review_id`, not the response ID. Therefore `calls[2]!.values[0]` is the actual relationship binding the fault changes. Both retained fixtures return `new-review-uuid`, which differs from a minted UUID and legitimately represents the concurrent-conflict winner. The new comments explain that existing path without silently changing the fixture to the winning-insert provenance path. Existing assertions already identify `calls[2]` as `INSERT INTO responses` and prescribe the four-statement sequence; the draft adds a relationship assertion within that established recorder structure rather than introducing a new ordering or SQL-format expectation. Both cases retain their existing response/status, counter, and logging assertions. No version-allocator assertion is necessary to detect the exact returned-ID fault because its wrong ID reaches the response binding already asserted.

**Model schema.** The `LLM_TASKS.owner_operator` descriptor in `src/lib/llm/tasks.ts` stores the imported `OperatorModelOutputSchema` directly, and `getLlmTask` returns the descriptor without cloning it. For schema object references, the old identity matcher and `task.outputSchema === OperatorModelOutputSchema` express the same identity requirement. A detached schema makes the boolean false even if it accepts identical data. The new assertion therefore retains the canonical-instance contract while giving the mismatch formatter only `false` and `true`; neither Zod object becomes an expected or received assertion operand. The provider, task ID, model, token-limit, and temperature assertions remain unchanged.

## Limits and follow-through

- No tests, compiler, mutation runs, database, environment inspection, browser, external model, source writes, or commits were used. Patch application was simulated in memory only. These drafts are statically suitable for root to apply after the frozen pass; this review does not establish a green corrected baseline or a mutation kill.
- The settings harness passes the same `mockSql` object as both the outer connection and transaction callback handle. Its audit assertion verifies the supplied mock argument and the omitted audit, but cannot distinguish a mistaken outer-connection audit from a transaction audit. The draft does not need to solve that separate concern to close the reported no-write oracle gap; do not present this unit assertion as new transaction-isolation proof.
- The Zernio draft verifies the persisted relationship binding, not an independent wrong-ID fault confined to the version allocator. That is sufficient for the specified mutation. The existing positional recording harness still carries its pre-existing SQL-order sensitivity; the draft does not broaden that sensitivity.
- The schema-identity change is expected by source reasoning to produce a primitive mismatch diagnostic. Its actual formatter behavior must still be measured. Keep I0592's existing attempt inconclusive/oracle until a valid authorized run produces new evidence.
- Preserve the current pass's individual measured dispositions. Applying these drafts changes the test tree; it does not retroactively turn I0228/I0394/I0403 into killed outcomes or I0592 into a usable kill. Further verification remains subject to root's authorized correction workflow.

## Reviewed draft fingerprints

SHA-256 of the exact scratch drafts reviewed:

- Settings: `17345a295c120e7c185c6746bc43335dc478370cd9e4c2c26c3ab224e99c4d0a`
- Zernio: `99fc0a288502c9dd08bc68054417b07c536dfe487f35344151c8b909a9e2aa38`
- Model pinning: `01fb2acaa546c591febc1c2762081899c35cfa4d3997b82139f11eab955829d4`

Exact original hunk starts validated in memory: settings 521 and 537; Zernio 421, 448, 764, and 779; model pinning 78. No missing context or altered test/describe title was found.
# Run C integration correction draft review

**No actionable findings in the three reviewed scratch drafts.** By static inspection, they supply the missing prerequisites for the six named individual cases without weakening their behavioral assertions, changing their identities, adding production scope, or breaking the existing suite cleanup paths.

Reviewed against immutable candidate `4127714519b253e4a0560b9cf561a987af8cf70c` in `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-owner-operator-run-c`. The six independently red baselines are supplied context; this review did not rerun or reclassify them. All repository source reads used pinned `git show` objects. Each draft was reconstructed in memory against those source bytes: every hunk matched exactly and all `it`/`test`/`describe`/`describeWithDb` declarations stayed unchanged. No source file was written.

| Draft | Cases | Static assessment |
|---|---|---|
| `/private/tmp/run-c-apply-integration-correction.patch` | I0677, I0679 | Capturing the actual initial tone makes the no-write/rollback oracle valid on both a fresh seeded location and the suite's reset location. |
| `/private/tmp/run-c-settings-integration-correction.patch` | I0685, I0686 | Explicitly establishes the account policy and required location override; preserves dial expectations, strengthens row-identity assertions, and cleans the scratch location. |
| `/private/tmp/run-c-import-integration-correction.patch` | I0704, I0706 | Performs the prerequisite import locally in each case while preserving whole-suite deduplication and all existing run/marker assertions. |

## Apply integration draft

In `src/lib/agents/operator/__tests__/apply.integration.test.ts`, the suite's `beforeAll` uses `seedLocation`, which omits voice columns and therefore receives their database defaults. Its `afterEach` explicitly resets those columns to null. An individually selected test consequently need not start with the same tone as a later test in the normal suite run.

Both corrections capture `readTone(locationId)` before preparing the turn/proposal or invoking the behavior under test. The archived-location case compares against that value after its existing `finally` unarchives the location. This continues to assert that rejection left the actual voice data unchanged, with the terminal refusal, absent receipt, and absent applied timestamp still checked separately. The rollback case compares the same before/after value after the injected Postgres failure and retains the pending status, absent receipt/timestamp, and successful retry assertions. The controlled initial values in the two execution modes—fresh database default or suite-reset null—are distinct from the requested `warm and brief` tone, so the correction does not conceal that requested write.

The new reads do not change the location's version token or write any fixture data. Existing archival recovery, `afterEach` operator/outbox cleanup, voice reset, tenant cleanup, connection shutdown, and live-database lock release remain intact. Test identities and injected failure mechanics are unchanged. Comparing state before and after is the relevant no-write contract; a hard-coded null was a fixture-state assumption.

## Settings integration draft

For I0685, the draft calls the existing `resetAccountDefault` helper with the exact dials its assertions require. The helper inserts or updates the Reply/posting account policy, preserves an existing row ID on conflict, and clears suspension state. Reading back that ID establishes the expected account-row identity before the public writer is invoked. A fresh location from `seedScratchLocation` then receives its own Reply/posting policy with threshold 5, veto window 30, and cap 5. The two manual operations are contractions from explicit threshold-5 rows and therefore do not acquire a missing expansion-confirmation prerequisite.

The existing dial-preservation assertions remain. Adding the captured account policy ID and seeded override ID strengthens the title's claim that threshold upserts affect the same rows; these expectations do not depend on a generated ID spelling. Setup uses the real policy table and constants already owned by the suite, leaving the actual manual upserts under test in `patchAutoApprovalSettings` unchanged.

The fresh location and override replace dependence on the earlier location-upsert test. The existing `cleanupScratchLocation` helper runs in `finally`, deleting the scratch policies and location-scoped audits before deleting the location. The account-default policy and account-level audit remain within the suite tenant and are covered by its existing `afterAll` cleanup. In the normal full-suite sequence, the earlier primary-location override already has the manual threshold and expected dials; leaving it untouched preserves the state later tests previously received. The account default finishes I0685 with the same manual threshold and 30/25 dials as before. Later account-default-dependent cases either reset their prerequisite or explicitly set their own state.

For I0686, the new `resetAccountDefault` call guarantees that the subsequent suspension UPDATE has a row to suspend, even when no earlier case ran. The test still proves that a suspended clear preserves the row, nulls the threshold, retains its dials and suspension reason, and that lifting suspension makes a later clear delete the row. Starting with threshold 5 makes the first clear's threshold change observable rather than relying on an already-manual row. Its existing deletion/count assertions and suite cleanup remain unchanged.

## Import integration draft

Both corrected cases use the existing `makeMonitored` fixture and its stable per-suite provider review identity. Under isolated execution, the added call to `importReview` creates the review and its run before the terminal-run query in I0704 or the second import in I0706. The following existing assertions establish the required effects: a completed run with a non-null end timestamp and an imported ingestion marker, or an unchanged repeat result with exactly one review, one run, and one imported marker.

In the normal full-suite sequence, an earlier case has already imported the same review. The production `importReview` conflict arm returns `unchanged` before starting another run or recording another marker. The added prerequisite calls therefore do not add rows, alter correlation IDs on existing runs, or invalidate the later single-run/single-marker checks. Not asserting that these prerequisite calls return `new` is appropriate here: either a local first insertion or the existing suite insertion provides the state, and the behavioral assertions still check the result under test. The correction does not change review identity to evade deduplication or skip any assertion.

No new tenant, business, or review identity is introduced. Existing `afterAll` cleanup still covers analytics events, run steps, runs, the review, its business, and the tenant. All case titles and original assertions remain unchanged.

## Limits

- This is static review only. No test, compiler, mutation, database, environment inspection, browser, external model, source edit, or commit was executed. Exact patch applicability was checked in memory, not by applying patches to the working tree.
- Root must apply these drafts only after the frozen round-2 pass ends and its restoration requirements are satisfied. Corrected individual baselines and relevant full suites still need authorized runtime verification; none is claimed green here.
- The review covers the six named baseline defects and their interactions with the existing normal suite sequence. It does not certify every untouched sibling case as independently runnable or promise arbitrary randomized ordering of suites that share fixtures.
- Existing red-baseline outcomes remain historical inconclusive results until new evidence is produced. A fixture correction does not itself establish a mutation kill or justify rewriting the frozen pass's evidence.

## Exact reviewed draft fingerprints

SHA-256:

- `/private/tmp/run-c-apply-integration-correction.patch`: `c6539579df0c59fb5d39688fbdaf297e67cd20b7de791894110f3d97941db73e`
- `/private/tmp/run-c-settings-integration-correction.patch`: `562a05cdaf297912c2718cf184b6d755864fef8f6c27987ce23f40014b69ab29`
- `/private/tmp/run-c-import-integration-correction.patch`: `c70a7ee983c58d82924467a411a5134a7a1bba1c345d7bfc12f7d3f1605eb0d3`

All exact-context reconstructions succeeded, and no test or suite declaration changed.
