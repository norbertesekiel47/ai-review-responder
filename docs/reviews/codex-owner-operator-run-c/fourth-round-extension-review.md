# Run C prompt correction and fourth-round verifier review

This durable record consolidates the native Codex prompt and verifier-extension reviews before the authorized fourth-round measurement. The prompt correction follows real deployed failure at fb536c09711ec331262f5efc64ff42f066bec3ba. Root reproduced and fixed RC-PROMPT-P2; the same correctness reviewer verified it. The extension's first review wave accepted RC-FOURTH-HISTORY, corrected within the approved scope and verified APPROVED by the same independent reviewer. All168 focused guard tests and the full review gate pass. No fourth-round measurement is claimed here, and no previous failure is erased.

Full local gate passed before the later oracle/extension edits (fingerprint d20f81ecbb86113488cfe2981ccf88c51a21e7b68bf33ef5043b60f422f8d361); those later edits require renewed verification. The five owner-approved direct OpenAI probes passed on prompt2026-09-13.4 before the strengthened weekend assertion; they do not prove that later assertion or the deployed worker/Apply journey.

---

# Run C prompt correction — spec/correctness review

Scope: the supplied four-file correction against `fb536c09711ec331262f5efc64ff42f066bec3ba`, reviewed independently on 2026-09-13. The supplied full-gate fingerprint is `d20f81ecbb86113488cfe2981ccf88c51a21e7b68bf33ef5043b60f422f8d361`. Gate and direct-provider results were accepted as supplied, not rerun or represented as independent evidence.

## Actionable finding

### [P2] Weekend oracle accepts an unrelated unsupported capability

Confidence: 100% for evaluator acceptance; no claim that the corrected production model has emitted this response.

Location: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-owner-operator-run-c/tests/llm-eval/structured-runner.ts:258`.

The new weekend case requires one unsupported entry but never verifies which capability that entry classifies. For the exact current request `Stop replying on weekends`, the following schema-valid response passes the actual exported case checker with `failures: []`:

```json
{"segments":[{"type":"text","text":"RepWorth cannot turn automatic replies off yet."}],"proposals":[],"unsupported":[{"request":"Turn automatic replies off","context":"Automatic policy changes are unavailable."}]}
```

This output repeats the central incorrect capability classification from the reported defect: ordinary policy-off is supported, while the current request's scheduling constraint is what is unsupported. The oracle nevertheless records success. The production validator does not bind unsupported prose to owner intent, so calling it does not close this gap. I confirmed this by importing `STRUCTURED_CASES` with `pnpm exec tsx -e`, running only `schema.safeParse` and `case.check` on synthetic objects; there were no provider calls, mutations, or source changes.

Smallest correction: add a bounded semantic assertion that the sole unsupported request identifies weekday/weekend scheduling (accept reasonable scheduling paraphrases rather than exact full-sentence equality), and add this wrong-capability object as a negative case in the existing oracle tests. Preserve the existing no-proposal/no-chooser checks. This follows the checklist's accepted classes concerning guards that assert counts without establishing the requested content or binding.

## Checks that passed on this axis

- The prompt explicitly maps all-locations/account-wide/account-default wording to `scope.locationId: null`, states that only inheriting locations are affected, and does not promise to overwrite overrides.
- Off wording explicitly maps to `set_auto_reply_scope` with `threshold: null`, including blocked expansion readiness and no pending reviews. The account-off oracles require exactly that operation, input value, account scope, proposal reference, empty unsupported list, and no chooser/question. Catalog input validation rejects unrelated extra policy fields, while the single-proposal check prevents separate veto/cap changes.
- The named Cafe request requires a sole Cafe scope chooser, no proposal, and no unsupported item in both prompt and evaluator. Snapshot location presence alone is expressly insufficient to create a chooser.
- Weekday/weekend scheduling is explicitly unsupported in the prompt. Its evaluator rejects proposals and chooser/reference substitutions, subject to the wrong-capability gap above.
- Current owner request priority is stated under the existing untrusted-envelope rules. No schema, provider, writer, or Apply behavior changed in the supplied production delta.
- I read the applicable AGENTS/CLAUDE working rules, context-layout guide, agentic-platform rule, Owner Operator glossary, and all lines of `docs/reviews/finding-checklists/spec-correctness.md`. The relevant checklist classes concern assertion specificity, actual-path oracle coverage, precise scope/value binding, and evidence claims. CSS/layout, migration, DB-baseline, and static-analysis implementation classes have no matching mechanism in this bounded delta.

## Uncertainty appendix — non-actionable

- Fresh-conversation fixtures do not demonstrate resilience to prior mistaken chooser/unsupported turns. The new prompt addresses that history explicitly, but the supplied single-attempt probes do not establish repeated-sampling or multi-turn reliability. This is a coverage limit, not a demonstrated production defect.
- The weekend oracle also accepts a question segment asking whether to disable all automatic replies alongside an otherwise correctly classified scheduling unsupported entry. The supplied narrow contract principally forbids actual proposal/chooser substitutions; I have not elevated this prose behavior into a second finding.
- This review did not perform browser, worker, Apply, DB, or provider verification. The reported 5/5 provider results remain one attempt per case. No criticism above depends on treating unit-test mocks as model-compliance evidence.

## Verification appendix — RC-PROMPT-P2 resolved

Verification-only follow-up on 2026-09-13 inspected the existing weekend checker and its existing test. The checker now binds `unsupported[0].request` to weekday/weekend, Saturday/Sunday, or day-of-week vocabulary while preserving all existing cardinality, proposal, and chooser exclusions. The test includes the exact wrong-policy-off counterexample and accepts two distinct scheduling paraphrases; it does not require exact generic prose wording.

I independently imported the actual exported case and invoked only schema validation and `case.check`. The original counterexample remains schema-valid and now returns `unsupported request does not identify weekday or weekend scheduling`. The request paraphrases `Pause replies on Saturdays and Sundays` and `Schedule automatic replies by day of the week` each remain schema-valid and return no failures. This closes the reported wrong-capability binding defect. The supplied green log also records 21 passing focused tests across two files; I read that log rather than rerunning the suite.

No provider/network calls or source edits were made by this reviewer. The production prompt is outside this verification-only follow-up's change scope. The earlier 5/5 live probe is not represented as proof that its responses satisfy the newly strengthened assertion. No actionable findings remain on the reviewed spec/correctness axis; the non-actionable uncertainty appendix still applies.

VERDICT APPROVED

---

# Run C prompt correction — standards and maintainability review

Scope: the four-file correction against pinned candidate `fb536c09711ec331262f5efc64ff42f066bec3ba`, limited to locality, abstractions, duplication, coupling, and test maintainability. This does not re-review the preceding Run C implementation.

Reviewed the supplied correction diff, current implementations and their nearest existing evaluator/prompt-test patterns, worktree `AGENTS.md`, `.claude/CLAUDE.md`, context layout, applicable agentic-platform rule, Owner Operator glossary, and `docs/reviews/finding-checklists/standards-maintainability.md`.

## Actionable findings

None at or above 80% confidence. No concrete maintainability defect in this correction warrants revision.

- The production change remains in the existing pure prompt builder and advances its recorded version. It introduces no new execution path, module, dependency, provider seam, or alternate owner for schema/Apply behavior.
- The account-off example follows the existing inline wire-shape pattern. Its unit test parses the actual example through the production schema and checks the account scope, null threshold, proposal reference, and empty unsupported array. The duplicated response shape serves as a model example and has a schema drift check.
- The new evaluator cases reuse `defineCase`, `buildOperatorPrompt`, `modelVisibleOperations`, and `validateModelOutput`. `checkOperatorSemantics` has multiple callers and retains the existing reason-prefix reporting convention. The two account-off requests share their assertion body without introducing a configurable assertion framework.
- The regression tests exercise the real semantic oracle with independently supplied correct and observed incorrect outputs. Provider/task mocks remain within the existing unit-test boundary. The additions do not make a self-comparison stand in for semantic validation.
- The blocked snapshot extends the nearest existing synthetic snapshot and explicitly states the distinguishing policy, readiness, and location facts. The regression tests independently pin the salient inherited conditions, including an empty turn history and zero pending reviews.

## Evidence boundaries

The parent supplied a green full gate for fingerprint `d20f81ecbb86113488cfe2981ccf88c51a21e7b68bf33ef5043b60f422f8d361`, 15,869 passing and 11 skipped full-suite tests, 21 passing focused tests, and a 5/5 direct OpenAI probe. Those are supplied evidence, not checks rerun by this reviewer. No provider calls, source edits, commits, or execution/mutation experiments were performed. The only write is this review artifact. Mocked evaluator tests establish harness/oracle behavior; they do not establish actual model compliance, repeated-sampling reliability, or worker/Apply completion.

## Non-actionable appendix

`tests/llm-eval/__tests__/structured-runner.test.ts:51` selects mock responses using exact owner-message strings plus the `Turn auto` prefix. `src/lib/agents/operator/__tests__/prompt.test.ts:48` locates the example by its serialized JSON prefix. These are small, local fixture-format dependencies. A future rewording or additional example could require updating these tests, but the present cases are explicit regression utterances and the existing real oracles reject a mismatched response. No demonstrated silent acceptance or current contract violation supports requesting a new fixture abstraction in this bounded correction.

VERDICT: APPROVED

---

# Run C bounded prompt correction — safety review

Reviewed the four-file uncommitted correction against prior candidate `fb536c09711ec331262f5efc64ff42f066bec3ba`, using `/private/tmp/run-c-prompt-review-brief.md`. Read the checkout's AGENTS/CLAUDE instructions, context layout, agentic-platform rules, Owner Operator glossary, and `docs/reviews/finding-checklists/security.md`. The checklist's symlinked contract-output finding does not apply: this correction introduces no filesystem traversal or output writer.

## Actionable findings

None at or above 80% confidence. No concrete safety regression attributable to this bounded correction was established.

## Evidence

- **Current request and injection boundary:** `src/lib/agents/operator/prompt.ts:44–46` retains the JSON envelope's untrusted-data rule and explicitly places interpretation of `ownerMessage` under those rules. The new instruction changes which request is current; it does not elevate embedded instructions above the system policy. The unchanged builder at lines 97–103 serializes the envelope with `JSON.stringify`. Tenant and target checks remain independent of model obedience in `src/lib/agents/operator/render.ts:212–235`: another account, another individual location, and an account target for a location-only operation are rejected. Scope choosers are limited to another location in the snapshot at lines 186–209.
- **Account default and overrides:** `prompt.ts:64` explicitly says account-wide/all-locations requests select the default and leave overrides intact, matching the supplied contract. The example at lines 73–74 names the account default in its rationale and contains neither a receipt nor a completion claim. `src/lib/agents/operator/catalog.ts:344–350` maps null threshold to the account/location manual operation; `src/lib/auto-approval/settings.ts:672–674` performs the account-default upsert. The existing card at `src/app/(authenticated)/dashboard/operator/ProposalCard.tsx:111–114` labels the scope “Account default” and explicitly states that locations with their own rule keep it. `src/lib/agents/operator/policy-state.ts:407–419` likewise preserves override states in account consequences.
- **Readiness and confirmation:** `prompt.ts:66–69` preserves the expansion block and card-owned confirmation rules while making supported contractions explicit. `src/lib/agents/operator/apply.ts:336–347` reparses the stored operation and classifies exposure from current locked state. Lines 376–396 retain archived-target checks and gate expansions on current readiness and the exact stored-state-derived confirmation phrase. The shared writer runs again at lines 409–433. Thus a model-generated expansion cannot obtain a write by calling itself a contraction or inventing a confirmation.
- **Apply and public effects:** The prompt still forbids completion claims at `prompt.ts:55`; its example produces only a proposal reference. The model schema remains strict and has no approval, confirmation, or receipt field (`src/lib/agents/operator/schema.ts:135–140`). `src/app/api/operator/proposals/[id]/apply/route.ts:44–67` obtains the authenticated owner account independently of request/model content before invoking Apply; its same-origin wrapper remains at line 113. `src/lib/agents/operator/apply.ts:292–326` retains account-scoped proposal locking and actor revalidation. `ProposalCard.tsx:225–247` retains the user-triggered Apply button and server-derived expansion phrase. The correction adds no execution operation or posting path.

## Validation limits and non-actionable appendix

This was a read-only source review, apart from writing this report. No tests, browser session, provider calls, state mutations, or commits were performed by this reviewer. The supplied full local gate result (fingerprint `d20f81ecbb86113488cfe2981ccf88c51a21e7b68bf33ef5043b60f422f8d361`), 15,869 passing / 11 skipped DB-suite result, 21 focused passes, and five successful single-attempt direct OpenAI probes are parent-provided evidence, not independently rerun evidence. Mocked runner tests demonstrate fixture/oracle wiring, not provider compliance. This review does not claim worker/Apply/browser verification of the new prompt.

The new regression fixtures intentionally start with empty previous turns. Multi-turn carryover and adversarial owner/snapshot strings remain useful future robustness probes for the new current-request instruction. Their absence alone does not establish a security defect: the changed instruction preserves the system boundary, and the independent validator/Apply gates remain intact. No additional blocking fix is requested.

VERDICT: APPROVED

## Fourth-round verifier extension — independent review wave

The initial extension passed the full review gate:15,906 tests passed,11 skipped; build, lint, typecheck, E2E and all audit rows passed. Fingerprint973a6655ce4ad4f38464414dc54d1d23568d27b195d322bbdb096c0dd8991a78. Root accepted RC-FOURTH-HISTORY and requested its correction before any fourth-round launch. The reports below describe that initial extension; verification of the correction follows separately.

# Independent correctness review — Run C fourth-round extension

Reviewer: `/root/run_c_fourth_correctness` (fresh independent Codex reviewer; not the implementation agent).
Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-owner-operator-run-c`.
Fixed baseline: `fb536c09711ec331262f5efc64ff42f066bec3ba`.
Scope: the approved admission/final-report contract and six-file extension diff supplied in `/private/tmp/run-c-fourth-review-brief.md`.
Supplied gate evidence: `/private/tmp/run-c-fourth-extension-gate.log`, GREEN, fingerprint `973a6655ce4ad4f38464414dc54d1d23568d27b195d322bbdb096c0dd8991a78`, full suite 15,906 passed / 11 skipped. Those results are root-supplied, not rerun by this reviewer.

## Finding C4-C1 — P1: historical Markdown narratives can be discarded while admission and final status still succeed

Confidence: 99% from complete control-flow inspection and read-only comparison of the baseline report artifacts.

Primary location: `.agents/skills/red-team/scripts/mutation-runner.mjs:150` (the historical evidence comparison through line 161 reads only `findings.json`), and the final proof at line 192. The checker calls that proof at `.agents/skills/feature/scripts/red-team-status.mjs:693`; its only content-independent Markdown requirement is file existence at line 680.

Violated contract: approved admission clause 4 explicitly requires preserving “findings/attempts/authorizations and historical all-duty narratives, not only that identity hash.” The approved sequence also requires the final canonical report to preserve rounds 1–3 history. The skill mirrors repeat complete historical evidence preservation. These are broader than preserving the JSON inventory/findings arrays.

The original Markdown contains historical evidence absent from the JSON. Read-only `git show` of both artifacts at the fixed baseline established that each of these phrases occurs in Markdown and not JSON:

- `Sibling search used` — the round-3 sibling-search pattern and scope reasoning at `findings.md:103`.
- `I0463 proves only fixture/enumeration equality` — an explicit limit on what that assertion establishes at `findings.md:567`.
- `Rule12 explicitly remains not configured or delivery-proven by this change` — outstanding operational evidence at `findings.md:571`.
- `No staging delivery was inferred from local tests` — the same operational-duty limitation.

Reproducible scenario and precise acceptance proof (no live checkout mutation or round opening performed):

1. Start with the positive Run C admission fixture and exact committed approval. Commit an empty `docs/reviews/red-team/codex-owner-operator-run-c-14b9e1/findings.md`, preserving the historical JSON and exact appended grant. This modifies an explicitly permitted documentary path; the branch, ancestry, historical JSON blob, and clean tracked tree remain valid.
2. `cmdRoundStart` still reaches the same successful branch: `runCFourthProof` checks branch/ancestry, then the finite path set (which includes Markdown), then parses only the two JSON blobs. No operation reads the historical or admission Markdown. `onlyJournaledChanges` sees no uncommitted changes. The grant is therefore non-null and round 4 opens. The existing positive runner fixture at `red-team-mutation-runner.test.ts:148–188` already seeds only the JSON report; it does not need historical Markdown to pass.
3. Alternatively, begin with the existing positive final-report fixture (`red-team-status.test.ts:289`) and replace its committed Markdown with an empty file in a later report-only commit. Keep sidecar and journal unchanged. `validRunCFourthReport` still returns true: the measurement commit remains an ancestor, its admission JSON is unchanged, the grant matches, and all final JSON prefixes/identity fields match.
4. Every remaining checker input is identical except current HEAD and Markdown bytes. The recomputed merge-base is unchanged. The staleness diff explicitly excludes this run's Markdown and JSON (`red-team-status.mjs`, staleness section). The working tree is clean, and the Markdown file still exists, satisfying line 680. Thus the existing successful final checker result stays exit 0 / CLEAR, although the earlier duty narratives are gone from the canonical report.

This is a control-flow proof of acceptance, not a claim of a newly executed regression. The historical Git objects remain recoverable, but the approved contract requires their evidence to be retained in the admission/final report; merely leaving it somewhere in Git history does not satisfy that contract.

Smallest correction: pin the baseline Markdown blob alongside the JSON blob, and require the committed admission Markdown to be byte-identical to it. At final checking, require the historical Markdown to be an exact prefix of the current canonical Markdown, allowing fresh round-4 sections to append. No new schema, general module, or narrative-truth evaluator is required. Add negative fixtures that truncate/change one historical duty paragraph before admission and after measurement, plus a positive fixture that appends fresh round-4 sections. Existing unchanged-JSON negatives do not cover this.

## Remaining contract review

The reviewed code enforces the exact branch/canonical JSON identity, committed exact grant, immutable baseline ancestry and finite changed-path set; preserves the full historical JSON at admission and the historical array prefixes at completion; validates the grant from launch zero; pins the grant/head/count before supervisor release; rejects grant/head drift on later launches; permits run 150 and rejects run 151; and rejects a fifth round. Final status corroborates a committed admission ancestor and matching journal grant while retaining the existing current-tree, intake-hash, restoration, count, and disposition checks. I found no second correctness defect at the required confidence threshold within this bounded review.

All entries in `docs/reviews/finding-checklists/spec-correctness.md` were considered against the six-file scope. Applicable classes were preservation of real evidence rather than structural proxies, incomplete guard enumeration, stale provenance, and the historical first-launch fallback. CSS/layout/accessibility, database binding, billing, provider semantics, and application operational-emitter entries do not introduce additional applicable findings in this verifier-only extension. Maintainability/style analysis was intentionally left to the separate reviewer.

No tests were rerun, no provider or database was contacted, no mutation or round was opened, and no source/journal/committed artifact was edited by this reviewer. Only this assigned ignored report was written. Browser verification does not apply to a read-only governance correctness review.

VERDICT REVISE


# Run C fourth-round extension — independent standards/maintainability review

Reviewed 2026-09-13 against fixed baseline `fb536c09711ec331262f5efc64ff42f066bec3ba`, using the approved contract and six-file diff supplied in `/private/tmp/run-c-fourth-review-brief.md`. Scope: module boundaries, import safety, locality, fixture isolation, authorization ownership, and mirrored skill rules. Grant/provenance correctness is the separate review axis.

No actionable findings at or above 80% confidence.

The runner owns the exact authorization predicate and committed-proof implementation; the checker imports its two public verification helpers (`.agents/skills/feature/scripts/red-team-status.mjs:41`). The added helpers remain beside the existing ticket-scoped budget mechanisms (`.agents/skills/red-team/scripts/mutation-runner.mjs:89`), use native Node modules, and introduce neither a general-purpose module nor runtime/provider dependencies. Both CLI entry points are protected by `import.meta.url` checks; the runner's module-level initialization consists of constants and function definitions, so importing its helpers does not open a round, execute a command, or write a journal (`mutation-runner.mjs:1072`). The null/false denial paths have explicit refusal callers and do not create a second authorization owner.

The fixtures continue using isolated temporary repositories and GIT_FREE_ENV for every relevant Git/CLI child (`scripts/ci/__tests__/red-team-mutation-runner.test.ts:25`, `scripts/ci/__tests__/red-team-status.test.ts:28`). Pin replacement affects private copies only (`red-team-mutation-runner.test.ts:165`, `red-team-status.test.ts:259`); the checker fixture's import is redirected to its private runner, and beforeEach resets the selected script. Production receives no argument/environment pin override. Reading the immutable historical identity prefix from the checked-in report supplies the fixture without creating repository writes or a second identity algorithm.

The two red-team skill files are byte-identical (read-only cmp succeeded). Their exception text at line 233 keeps the branch, fourth round, 150-launch limit, historical evidence requirement, and retained safeguards explicit. Exact approval matching remains in code rather than a newly widened global prose regex.

Applied `.claude/rules/ci-tooling.md`, project working rules, and every entry in `docs/reviews/finding-checklists/standards-maintainability.md:8–36`. Relevant classes included duplicated policy ownership (22, 34), ineffective/circular fixture oracles (13, 18, 28, 35), misleading evidence claims (10–17, 20, 36), and ordered inventory identity preservation (33). No new instance was substantiated; UI-specific entries have no surface in this extension.

Validation evidence: inspected `/private/tmp/run-c-fourth-extension-gate.log`, which reports GATE: GREEN and matching fingerprint `973a6655ce4ad4f38464414dc54d1d23568d27b195d322bbdb096c0dd8991a78`. The parent supplied 15,906 passing tests and 11 skips; focused guard evidence is recorded in the brief as 163/163. No test, mutation, provider call, round transition, source edit, or commit was executed for this review. Browser verification does not apply to these governance-only changes and this approval does not establish the prompt correction's outstanding deployed acceptance.

Uncertain observations: none requiring follow-up on this review axis.

VERDICT APPROVED


# Run C fourth-round extension — independent security review

Reviewed the six-file verifier extension against fixed baseline `fb536c09711ec331262f5efc64ff42f066bec3ba`, the supplied owner-approved contract, and `docs/reviews/finding-checklists/security.md`. Scope: authorization admission, command and artifact boundaries, grant replay/denial, accepted-risk linkage, and preservation of isolation/restoration. No source edits, mutation launches, provider calls, or runtime tests were performed.

## Findings

No actionable security finding at or above 80% confidence in the changed hunks.

## Boundary checks

- `.agents/skills/red-team/scripts/mutation-runner.mjs:115`: The authorization matcher requires the canonical feature/branch identity, original 785 ordered inventory identities, exactly one grant with the exact ID/date/text/key set, and an empty `finding_ids` array. Missing entries, duplicated grant IDs, foreign identities, altered prose, and expanded risk scope fail the matcher.
- `.agents/skills/red-team/scripts/mutation-runner.mjs:143`: Permission comes from the canonical report at a committed admission HEAD. The actual branch, baseline ancestry, finite changed-path set, immutable historical blob, historical report contents, and prior authorization prefix are checked. A matching report supplied elsewhere, uncommitted prose, or a final report that first introduces the approval cannot establish this proof. Git receives argument arrays; report fields are not interpolated into a shell command.
- `.agents/skills/red-team/scripts/mutation-runner.mjs:171` and `:762`: Round 4 revalidates proof before launch, including at zero launches, and refuses rather than falling back to the ordinary budget. A changed pinned HEAD, hash, grant ID, maximum, or first-run marker denies subsequent use. Noninteger/negative run counts and a missing grant after recorded launches deny the fourth-round path. The existing supervisor remains paused until the incremented count, grant, and process identity have been durably journaled; launch 151 remains denied by the existing cap check.
- `.agents/skills/red-team/scripts/mutation-runner.mjs:660`: Fourth-round admission follows the existing unresolved-mutation, open-dotenv, and active-supervisor checks. It requires the same committed proof and clean tracked state; fifth-round requests cannot obtain a grant. The extension introduces no CLI or environment option that changes its pins or budget.
- `.agents/skills/red-team/scripts/mutation-runner.mjs:186` and `.agents/skills/feature/scripts/red-team-status.mjs:693`: Final acceptance corroborates the measured admission commit and matching journal grant, enforces the 1–150 count, and preserves inventory/findings/authorization prefixes. Existing checkout identity, intake, freshness, tracked-restoration, journal-finalization, and recomputed-status checks still run afterward.
- `.agents/skills/feature/scripts/red-team-status.mjs:381`: The empty-list exception applies only to the exact fourth-round grant object. `validateAuthorizationLinks` still requires an accepted-risk finding to be named in its referenced authorization. This grant names none; adding a finding to it invalidates the exact matcher. Thus this newly introduced exception does not grant risk acceptance.
- `.agents/skills/red-team/scripts/mutation-runner.mjs:1072`: Importing the shared predicates into the status checker does not invoke the runner CLI. Child argv handling, environment construction, process-group cleanup, dotenv handling, and mutation restoration are unchanged. The checklist's symlink-output defect does not have a newly introduced analogous writer here: the new authorization evidence is read through committed Git objects, and the extension adds no caller-selected output path.

## Evidence and limits

The supplied gate evidence is `/private/tmp/run-c-fourth-extension-gate.log`, fingerprint `973a6655ce4ad4f38464414dc54d1d23568d27b195d322bbdb096c0dd8991a78`, with 15,906 passing and 11 skipped tests. I inspected the added denial/budget/accepted-risk fixtures and followed the unchanged launch, journal, and status paths that consume the new grant. This is a static security review, not an independent execution of that gate or authorization to begin verification.

The pre-existing local journal remains the runner's mutable accounting record; this change does not create a tamper-proof ledger or make arbitrary local child commands a security sandbox. Those existing trust assumptions were not reclassified as new vulnerabilities in this narrowly scoped extension. No uncertain observation warrants expanding this change or blocking its approved use.

VERDICT APPROVED

## Verification addendum — RC-FOURTH-HISTORY / C4-C1 resolved

Verified by the same independent reviewer, `/root/run_c_fourth_correctness`, on 2026-09-13. This addendum preserves the original finding and supersedes its verdict for the corrected tree. Scope was limited to the historical Markdown preservation correction in `/private/tmp/run-c-fourth-history-verification.md`; no new review axis or product scope was opened.

The correction resolves the finding:

- The constant at `.agents/skills/red-team/scripts/mutation-runner.mjs:91` pins Markdown blob `caae5b4d877e254033485a73f38f56b074c8910e`. Independent read-only `git rev-parse` against baseline `fb536c09711ec331262f5efc64ff42f066bec3ba` confirmed that exact object ID. The historical blob is 557,236 bytes and ends with a newline.
- `runCFourthProof` at lines 153–154 requires both the fixed baseline and committed admission Markdown to resolve to that exact blob. Deletion fails closed through the existing catch; replacement, truncation, or newline changes produce a different blob and fail the comparison. The historical bytes are then read using `git cat-file blob` without an encoding or trimming helper (lines 157–159), yielding a Buffer. This check runs on admission and every authorized launch, and is also used to corroborate the final report's admission commit.
- `validRunCFourthReport` at lines 202–206 reads current Markdown as a Buffer and compares its first historical-length bytes with the historical Buffer. A short file, any changed historical byte, and a missing file all fail. The trailing newline participates in the exact comparison. Additional bytes after the intact historical prefix remain allowed, so legitimate appended round-4 evidence succeeds.
- The actual runner fixtures now commit historical Markdown and replace only the private fixture's immutable blob pin. The two added cases at `scripts/ci/__tests__/red-team-mutation-runner.test.ts:195` delete or replace the committed admission Markdown and require refusal while preserving round 3 / 22 launches.
- The actual checker fixture at `scripts/ci/__tests__/red-team-status.test.ts:284` appends a real round-4 Markdown section after the intact historical prefix, then commits both artifacts; its positive CLI assertion remains at line 294. The three negative cases at line 307 delete the final Markdown, replace it, or write the historical text with `trimEnd()`, and require exit 1. The fixture history at line 231 ends in a newline, so the last case exercises actual byte loss. Final deletion was already rejected before the correction; replacement and newline loss were the previously accepted paths.
- The two red-team skill mirrors are byte-identical and now state exact committed admission preservation and final raw-byte-prefix preservation, including trailing newlines.

Evidence inspected: `/private/tmp/run-c-round4-markdown-red.log` records the two admission cases and the final replacement/newline cases failing their refusal assertions before the fix (4 failed, 1 passed); `/private/tmp/run-c-round4-markdown-green.log` records both suites passing all 168 cases afterward. `/private/tmp/run-c-fourth-history-low-load-gate.log` records GREEN with matching written/current fingerprint `2f10dbd978b60ff9120d947df5b0477be41a9c5acef5d70ab7c1576d634a692b`. Root reports 15,911 passed / 11 skipped for that complete run using `MAX_PARALLEL=2 VITEST_WORKERS=2`, following two unchanged admin CLI 5-second timeouts at default concurrency and a successful isolated run of those seven admin cases. This reviewer inspected the correction, actual fixtures, baseline object/bytes, focused red/green logs, and gate result; no test rerun or broader timeout diagnosis was needed for this finding.

No remaining defect was identified within the assigned preservation correction. No source changes, live rounds, journal changes, providers, commits, or test launches were performed during this verification; only this report addendum was written.

VERDICT APPROVED
