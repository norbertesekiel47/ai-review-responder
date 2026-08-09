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

## Round 2 verification

- **Reviewer**: standards axis, round 2 (verification-only)
- **Subjects**: fix commit `c13011e1` (this axis's two round-1 LOW findings) +
  fix commit `70d56c89` (cache-provenance fix — new code, standards lens)
- **Evidence run**: `pnpm typecheck` clean, `pnpm lint` clean, targeted vitest
  over persist.test.ts, ResponseGeneratorWorker.test.ts, generator.test.ts,
  generate-draft.test.ts, generate-draft-cache-provenance.test.ts — 5 files,
  122 tests, all pass.

### Finding 1 — RESOLVED

`persist.ts:111` is now `return sql.begin(async (tx): Promise<PersistResponseOutcome> => …)`
— the exact `auto-policy-publish.ts:152` idiom (typed callback outcome). The
outer `let staleContentSkip` and the trailing post-tx ternary are deleted. All
four exit sites return typed outcomes: the gate skip returns
`{ kind: 'skipped_stale_content' }` (:133, comment preserved), and the three
former bare `return;` sites (auto-approved :267, suppress/held :273, notify
fallthrough :281) each return `{ kind: 'persisted', responseId }` — semantics
identical to the old post-tx ternary, since every non-skip path previously
mapped to `persisted` with the same closure-scoped `responseId`. No bare
`return` remains inside the callback (the remaining `return;` at :507/:520
belong to helper functions). persist.test.ts needed no change and passes, as
predicted in round 1.

### Finding 2 — RESOLVED

`ResponseGeneratorWorker.test.ts:304` now asserts
`(mockSql, 'outbox-gen-1', OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT, undefined)`
— exactly the pin requested, matching the sibling assertion at :289 and
`makeJob()`'s fixed `id: 'outbox-gen-1'` (:162).

### No stray edits in c13011e1

The commit touches only the two files named by the findings; net delta is the
callback-typing refactor plus the one-matcher pin. Nothing else changed.

### Standards lens over 70d56c89 (cache provenance — new code)

Checked and passed:

- **One-owner vocabulary** — the threaded option is `loadedReviewContentHash`
  end-to-end (load-context → generate-draft ids/opts → `GenerationOptions`),
  matching persist.ts's spelling for the same fact; the cache-payload stamp is
  a distinct fact with a distinct name (`reviewContentHash`, doc-commented on
  `CachedGeneration`). No competing spellings introduced.
- **Glossary conformance** — "content-freshness gate" verbatim in the accept
  comment (generator.ts:135); no paraphrase ("staleness check" etc.) anywhere
  in the three production files. `stale_review_content` not needed in this
  surface and correctly absent.
- **Comment idiom** — accept-rule comment (generator.ts:131-140) and the
  overwrite-stamp comment (generate-draft.ts:264-268) are rationale-dense in
  the file's house style, each clause load-bearing (H1/H2 failure narrative,
  null-vs-undefined semantics, the re-spend consequence).
- **No `any`** — none in any of the six touched files; test doubles use the
  sibling files' `as unknown as Sql` idiom.
- **Best-effort idiom** — the mismatch-clear
  (`clearCachedGeneration(…).catch(() => { /* best effort */ })`,
  generator.ts:155) byte-mirrors the pre-existing corrupt-payload branch
  (:245); the overwrite's try/catch swallow pre-exists.
- **Coverage of writers/readers is complete** — production `setCachedGeneration`
  call sites are exactly `tryWriteCache` and the guardrail overwrite (both
  stamped); production `generateResponse` callers are exactly the two
  generate-draft sites (both thread the hash) plus the demo lane (demo mode,
  cache-free). The inert `retryOpts` thread is explicitly commented as inert.
- **Test-fixture house style** — generator.test.ts additions reuse the file's
  dynamic-import + `vi.mocked` + JSON fixture idiom; the pre-existing cache-hit
  test's fixture gains `reviewContentHash: null` preserving its subject
  (sanctioned by the deviations entry). The new
  `generate-draft-cache-provenance.test.ts` mirrors generate-draft.test.ts's
  fixtures (`asLocationId`, `mockSql`, IDS shape), documents in its header why
  it cannot live in that file (module-scope `generateResponse` mock), resets
  the live breaker singleton, and its Map-backed store round-trips the REAL
  accept/write code. New-file justification is recorded in the deviations doc.
- **No stray edits** — six files, all inside the amendment-#2 surface; the
  deviations entry documents the three mechanical adaptations.

One new low-severity finding:

### 3. LOW — cache-payload shape now has two hand-synchronized writers with no compile-time link

`worker/jobs/response-generation/generate-draft.ts:270-278`

The guardrail overwrite serializes an untyped object literal that must stay
field-for-field identical to `CachedGeneration` (typed at generator.ts:258),
and the fix stamps `reviewContentHash` into both by hand. The duplication
pre-existed, but this commit is itself the proof of the drift cost: its own
comment (and deviations entry) explains that a payload written without the
stamp is rejected by every later read — silent re-spend, no test failure at
the writing site. Export `CachedGeneration` (type-only) from generator.ts and
type the literal (`const overwritePayload: CachedGeneration = { … }` or
`satisfies CachedGeneration`) so the next field added to the shape fails
typecheck here instead of silently drifting. Standard: one-owner shape
vocabulary (cf. the outbox-status byte-for-byte contract ethos); no new
abstraction needed — a type annotation suffices.

### Appendix — low-confidence observations (not findings)

- `CachedGeneration.reviewContentHash` is declared `string | null` but legacy
  entries deserialize with the field `undefined` (the parse is a cast); the
  accept rule handles it correctly via strict equality and says so in the
  comment. Declaring the field optional would surface that to the compiler but
  weaken the write-side guarantee; the current trade (required on write, comment
  on read) is defensible as long as finding 3's type-link lands.
- The fire-and-forget `clearCachedGeneration` on mismatch (generator.ts:155)
  is dispatched before the LLM call and could in principle resolve after the
  fresh `tryWriteCache` (deleting the new entry). Window is milliseconds vs.
  a multi-second LLM call, and the worst case is one extra regeneration on a
  later retry (economy, not correctness — the persist-side gate still guards).
  Not worth serializing.

### Round 2 verdict

Both round-1 findings RESOLVED, no regression introduced by either fix commit;
one new LOW finding (3) on the new cache-provenance code.

| Severity | Location | Finding |
|---|---|---|
| LOW | `worker/jobs/response-generation/generate-draft.ts:270-278` | Guardrail cache-overwrite literal is an untyped second copy of the `CachedGeneration` shape; the new `reviewContentHash` stamp is hand-synchronized across two writers — add a type annotation/`satisfies` link so shape drift fails typecheck instead of silently re-spending |

### Round-2 finding close-out (orchestrator)

The LOW finding (untyped second copy of the CachedGeneration shape at the
guardrail cache-overwrite) is fixed exactly as recommended: `CachedGeneration`
exported type-only from generator.ts, `satisfies CachedGeneration` on the
literal in generate-draft.ts. Verification is mechanical — the finding was
precisely the absence of a compile-time link, so `pnpm typecheck` (green in
the gate run recorded in .feature/gate-status.json) IS the verification; no
round-3 agent dispatched. All three axes now: spec CLEAN, adversarial
APPROVED, standards resolved-by-compiler.
