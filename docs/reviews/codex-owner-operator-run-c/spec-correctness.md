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
