# feat-728-content-freshness-gate — standards & maintainability review, round 1

- **Reviewer**: standards axis, thermo-nuclear-code-quality-review skill
- **Subject**: `git diff ae110dfd...HEAD` (commits `73c8c931..e712afb2`)
- **Inputs honored**: `feat-728-content-freshness-gate-deviations.md` read first — no
  ACCEPTed adaptation is re-flagged (gateInput rename, RowList `toMatchObject`,
  try/finally lock release, `agent_run_id` harness fix, token-owner relocation,
  autopilot-suite mechanical unwrap).

## Verdict

**APPROVE with two low-severity findings.** No structural regression, no
spaghetti growth, no file-size violation, no boundary leak. The gate is close to
the minimal correct shape: a glossary-named pure predicate + one early return
riding the transaction's existing first statement, surfaced through exactly the
planned discriminated union. The one real code-judo opportunity left on the
table is small (finding 1).

## Findings

### 1. LOW — `staleContentSkip` outer mutable flag instead of the canonical begin-returns-outcome pattern

`worker/jobs/response-generation/persist.ts:111` (set at :134, read at :285-287)

The tx callback smuggles its outcome out through a `let staleContentSkip`
declared before `sql.begin` and a post-tx ternary. The repo's canonical pattern
for "a transaction computes an outcome" is to return a typed value from the
`begin` callback:

- `worker/jobs/publisher/auto-policy-publish.ts:152` — `const initial = await sql.begin(async (tx): Promise<InitialPhaseOutcome> => …)`
- `worker/jobs/billing/UpdateStripeOverageWorker.ts:70` — `Promise<LockedOverageExecution>`
- `src/lib/payments/plan-activation.ts:302`

Typing the callback `Promise<PersistResponseOutcome>` and returning the outcome
at the skip site and the three existing `return;` sites deletes the outer
mutable and the trailing ternary, and makes the outcome flow one-directional.
Behavior-identical; the persist.test.ts harness (`mockSql.begin` returns the
callback result) already supports it. Standard: thermo-nuclear rules 2/6
(one-off flag threading an existing flow; prefer the canonical helper/pattern).
Not a blocker — the flag is assigned once and read once, adjacently — but this
function is the invariant-#3/#4 heart of the worker and should model the repo's
best pattern, not its second-best.

### 2. LOW — new outbox-completion assertion is looser than the file's house style

`worker/jobs/__tests__/ResponseGeneratorWorker.test.ts:303-305`

The gate-skip test asserts
`(expect.anything(), expect.any(String), OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT, undefined)`
where the sibling assertion three lines above (:289) pins the concrete handle:
`(mockSql, 'outbox-gen-1', undefined)`. `makeJob()` fixes `job.id` to
`'outbox-gen-1'` (:162), so the exact values are available. As written the test
cannot catch a handler that passes `reviewId`/`businessId` where the outbox id
belongs. Pin it:
`(mockSql, 'outbox-gen-1', OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT, undefined)`.
Standard: test-quality lens (fixture drift from house style; matcher without
discrimination).

## What was checked and passed

- **Deep-module discipline / invariant #12** — the gate deepens
  `persistResponseAndNotify` behind the unchanged seam. `PersistResponseInput`
  untouched; the only interface change is the planned discriminated
  `PersistResponseOutcome`. The handler addition
  (`ResponseGeneratorWorker.ts:125-133`) is a 7-line outcome→outbox mapping,
  mirroring the existing `loadGenerationContext 'skipped'` pattern the intake
  cites — orchestration only, no leaked logic. `acquirePersistLocks` widens
  from `void` to `{ currentReviewContentHash }` — the minimal honest boundary
  (the hash must ride the lock statement); no new abstraction with a single
  caller (`hasStaleReviewContent` has a production caller + the planned
  property test, and hosts the glossary doc comment).
- **Code-judo scan** — no dramatically simpler framing exists: the predicate
  rides the pre-existing FOR UPDATE SELECT (zero added statements), the skip is
  one early return before the lane split, no new branch enters any other flow.
  The alternative designs (typed throw; `string | null` return; persisting in a
  dead status) are all worse and the last is explicitly a non-goal.
- **One-owner vocabulary** — `OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT`
  is the only spelling of the value in code and in both unit-test files
  (persist.test.ts:41, ResponseGeneratorWorker.test.ts:151); raw
  `'stale_review_content'` appears only in test titles and docs. The log's
  `reason` field imports the constant (persist.ts:128). The union kinds
  (`'persisted'`/`'skipped_stale_content'`) are compiler-checked discriminants,
  same as `loadGenerationContext`'s — consistent with house practice.
- **Glossary conformance** — "content-freshness gate", "skip-the-INSERT",
  "stale_review_content", "freshness check, not a provenance proof",
  "stale-content direction" all verbatim across persist.ts,
  ResponseGeneratorWorker.ts, outbox-completion-reason.ts, CONTEXT.md, and the
  integration suite header. Grep found no paraphrase ("staleness check" etc.).
- **Comment idiom** — the new persist.ts comments carry the same
  rationale-dense style as the file (lock-ordering note extended in place, ADR
  citation, why-not-persist-any-status). The extended lock comment
  (persist.ts:310-322) is long but each clause is load-bearing.
- **Structured-log hygiene** — gate log carries ids + version + lane + reason
  only; no review text, no hashes; enforced by a test that JSON-stringifies the
  fields and asserts both hash values absent.
- **No `any`, no new deps** — the only `any`s in touched test files pre-exist
  in the hoisted mock harness.
- **File sizes** — persist.ts 654, persist.test.ts 915, worker test 886,
  integration suite 266: nothing crosses 1k lines.
- **Test quality** — the gate describe block reuses the file's fixtures via
  delegation (`gateInput` → `baseInput`), its `beforeEach` mirrors the file's
  per-describe reset idiom, env handling matches the file's
  `process.env` + finally/afterEach style, and the lanes test's per-lane
  statement-count assertion is genuinely discriminating (a lane-conditional
  gate fails it). The zero-writes test guards both the tx handle and the
  top-level handle. The integration suite executes no run-time DDL, is
  correctly named `*.integration.test.ts`, mirrors its cited harness
  (two clients, seedTenantAccount, distinct review per test), and its
  lock-serialization test fails safe in both directions (a pre-lock hash read
  is caught by the final outcome assertion, not the timing race).
- **Seed literals** (`'pending'`, `'active'`, `'zernio'`) match the sibling
  autopilot suite's seed style — not flagged.

## Appendix — low-confidence / speculative observations (not findings)

- **persist.test.ts:251 `['hash mismatch', …]`** — this pre-existing
  manual-fallback case now models a production-impossible state: in production
  the lock-row hash and the runtime-state hash are the same row read in the
  same tx under FOR UPDATE, so a current-hash mismatch fires the gate before
  the evaluator ever runs. The case still exercises the evaluator only because
  the default mock lock row omits `review_content_hash` (gate side reads
  null → passes). A one-line comment on the case would stop a future
  maintainer from "completing" the fixture and silently retiring the
  defense-in-depth coverage.
- **content-freshness-gate.integration.test.ts:141-143** — the
  `input`/`input2`/`input3` one-line aliases add little over calling
  `makeInput(reviewIdN, …)` at the three call sites; harmless sugar.
- **Property test oracle** (persist.test.ts:905-914) restates the predicate's
  boolean expression. For a three-term predicate whose truth table is locked by
  ADR 0017 this is acceptable spec-pinning (and was planned in
  `tests_to_add`), but it adds no discrimination beyond the four example
  tests other than input breadth. The house-style citation names
  `sentiment.test.ts` while the intake named `on-demand-lane.property.test.ts`
  — both exist and match the style; cosmetic.
- **No `assertSchemaReady` call in the new integration suite** — matches the
  mirrored harness (the autopilot and daily-cap suites don't call it either),
  and a behind-head DB fails loudly on the missing column regardless; noted
  only because CLAUDE.md's dev-commands text mentions the helper as the
  live-DB convention.
