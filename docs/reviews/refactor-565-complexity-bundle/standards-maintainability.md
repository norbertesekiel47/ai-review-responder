# Review — `refactor-565-complexity-bundle` · Standards & Maintainability

Axis: design quality, repo standards, six-month ownability.
**Not** in scope here: correctness / spec fidelity (separate agent owns that axis).

Diff reviewed: `git diff origin/main...HEAD` — 7 production files (+522 / −361, net **+161**),
4 test files (+411 / −4), 3 docs.
Mechanical checks run locally on the worktree: `pnpm typecheck` **clean**,
`pnpm ci:db-imports` **passed (strict)**, `pnpm ci:static-policy` **passed (1029 files)**,
targeted vitest (5 files, 54 tests) **all green**.

## Verdict

**The refactor is real, not narration.** Every one of the six extractions survives the
deletion test: remove it and duplicated SQL, duplicated lock semantics, or a duplicated
route preamble reappears across two or more call sites. There is no `prepare/process/finalize`
shape, no `any`, no new file, no new dependency, no business logic pushed into a route handler,
and no silent catch. The single-ownership claims are verifiable by grep across the whole repo.

The findings below are all **low severity**: naming/vocabulary drift, one duplicated doc fact,
one guard that advertises more than it enforces, and some test-shape wear. None of them are
blockers; all are cheap to fix.

---

## 1. Depth, not just decomposition

Applied the deletion test to each new function.

| Function | Interface | Hides | Deletion test | Verdict |
|---|---|---|---|---|
| `acquireCsvIngestLock` (exported) `ingest.ts:380` | `(tx, businessId) → void` | key string, `hashtext` wrapping, first-statement-of-tx rule | Deleting it puts the raw `pg_advisory_xact_lock(hashtext(...))` back in the failed-hook, where it already drifted once (#569/S1). | **Deep enough.** Exporting the *acquisition* instead of the key string (D2) is the right call — a key-only helper leaves two of the three facts with the caller. |
| `writeTerminalUploadState` `ingest.ts:404` | `(tx, {uploadId, businessId, status, report}) → void` | guarded UPDATE, `tx.json` encoding, `raw_csv = NULL`, `completed_at = NOW()`, the tolerated 0-row semantics | Deleting it restores a 3× copy-pasted 6-line UPDATE across two files. | **Deep.** Best single-owner win on the branch. |
| `evaluateBatchGate` `batch-builder.ts:135` | `(tx, {batchId, accountId}) → ClosedGateReason \| null` | accounts row lock, account read, missing-account throw, offboarding projection, reason precedence | Deleting it restores ~25 duplicated lines at both call sites, including the lock. | **Deep.** Also correctly resists the tempting-but-wrong "cache the gate result across the two transactions". |
| `deleteUnbuiltBatch` `batch-builder.ts:167` | `(tx, {batchId, accountId, businessId}) → void` | the 4-predicate DELETE, incl. the load-bearing `built_at IS NULL` | Deleting it restores a byte-identical DELETE twice. | **Shallow but justified** — it owns the *predicate set*, and the branch's own test pins the two call sites to byte-identical SQL. This is the weakest of the six; it earns its keep on the `built_at IS NULL` guard alone. |
| `loadCandidatePool` `batch-builder.ts:328` | `(tx, {accountId, businessId}) → {candidates, poolCount}` | a 55-line correlated-subquery window, the pool count, the prior-send `DISTINCT ON`, the row→DTO join, and a PII contract | Deleting it puts ~100 lines of SQL back inline in the executor. | **Deep.** The clearest complexity-hiding win. |
| `commitAskDecisions` `batch-builder.ts:474` | `(tx, {batch, parentRunId, decisions, decidedAt}) → void` | ask id + run id minting, the `jsonb_to_recordset` insert, child-run recording, the ask→run link, and three affected-row assertions as one atomicity unit | Deleting it puts ~95 lines back inline; more importantly the *"these three writes are one unit"* contract loses its home. | **Deep**, despite one caller. repworth.md's "don't extract for a single caller" is about wrappers; this is a stated atomicity invariant with a name — the justification is in its doc comment and holds. |
| `commitTerminalCheckpoint` `failed-hook.ts:51` | `(sql, handle, errorClass) → {ownsAttempt, parentTerminalized}` | the whole transaction incl. `sql.begin`, the CAS-first rule, the `FOR UPDATE OF batch, parent` active-parent lock, the fail-run write | Deleting it inlines ~45 lines with two `let` flags mutated from inside a closure. | **Deep, and the branch's best deviation.** Deviation 3 (owning `begin` rather than taking `tx`) genuinely converts a comment-enforced rule into a structural one. |

`recordCompletedChildRuns` was deliberately **not** decomposed (D4) — correct: two set-based
INSERTs each followed by a count assertion; splitting adds names without hiding anything.

**Verdict: no narration-shaped splits.** None of the six is a "do step N" function; each one
is nameable as a noun-phrase responsibility that a caller can reason about without opening it.

## 2. Temporal decomposition (design.md's explicit prohibition)

The plan's D5 claims the split is by stable responsibility, not execution phase. **The claim
holds**, on three tests:

1. **No phase objects.** No `prepare()`/`process()`/`finalize()` triple, no staged struct
   threaded between steps, no partially-initialized object escaping one call to be completed
   by the next. `loadCandidatePool` returns a value; `commitAskDecisions` consumes decisions.
   They do not share mutable state.
2. **Sequencing contracts stayed inline.** The ownership CAS, the batch `FOR UPDATE`, the
   advisory lock, and the `built_at` write are all still at the top level of `constructBatch`
   with their comments. That is exactly right: their *position* is the contract, so hiding
   them would hide the contract.
3. **The names are read/write responsibilities, not ordinals.** `loadCandidatePool` is "the
   Batch candidate window query"; `commitAskDecisions` is "the authoritative ask write". Both
   would be sensible names in a file that had never been decomposed.

One caveat, **inherited not introduced**: the top-level `prepareBatch` → `constructBatch` split
*is* temporal (it exists because they are two separate transactions, which is a legitimate
reason). It predates this branch and the branch does not deepen it.

The deviations doc's sentence "the executor now reads as CAS → lock → gate → load pool → decide
→ commit decisions → complete run → mark built" reads like a phase list, but it is describing
the *remaining inline* statement order, not the extraction axis. The prose is more incriminating
than the code.

## 3. Names and glossary vocabulary

Glossary terms in play (`CONTEXT.md` + the run-engine specs): **Solicitation batch**, **Ask**,
**Batch candidate window**, **Withhold reason**, **Logical fan-out**.

Used correctly: `commitAskDecisions` (Ask), `deleteUnbuiltBatch` / `evaluateBatchGate`
(Solicitation batch), `ClosedGateReason`, `withheld_reason` (Withhold reason).

Two names drift:

- **F4 — `loadCandidatePool` / `CandidatePool` blurs "Batch candidate window".** The glossary
  term for the truncated, `MAX_DATA_ROWS`-bounded, least-recently-evaluated-first set is
  **Batch candidate window** — and the function's own doc comment says so ("Sole owner of the
  **Batch candidate window**"). The *name* calls it a "pool". Meanwhile the same type's
  `poolCount` field means the **untruncated** contact pool. So inside one 15-line type, "pool"
  means both the window and the thing the window is a truncation of. `loadBatchCandidateWindow`
  returning `{candidates, contactPoolCount}` would carry the glossary term and remove the
  collision. design.md: *names reveal abstractions; a near-miss name is a reason to reconsider
  the boundary, not to accept it.*

- **F3 — `TerminalCheckpoint` / `commitTerminalCheckpoint` coins "checkpoint" for a concept the
  repo already names.** The function's own doc comment, the pre-existing inline comment, and
  `handleCsvIngestFailed`'s comments all call this "the coupled terminal transition". The
  returned value is an *outcome* (`ownsAttempt`, `parentTerminalized`), not a resumable
  checkpoint — "checkpoint" carries a restart/resume connotation this code does not have, which
  is an actively misleading metaphor in a retry-exhaustion terminalizer.
  `commitTerminalTransition` → `TerminalTransitionOutcome` would say what the doc comment
  already says.

No coined term *collides with* a defined glossary concept in a way that would corrupt the
domain language — both findings are local naming precision, not vocabulary forking.

## 4. Comments

Production net is +161 lines on a de-duplication, so this deserved scrutiny. Verdict: **most of
the added prose is load-bearing rationale**, with two specific redundancies.

Carrying genuine, non-obvious rationale a reader needs (keep):

- `writeTerminalUploadState` `ingest.ts:394-406` — the purge race. This is the single most
  valuable comment on the branch: it names `worker/jobs/account-offboarding/purge-stages.ts` as
  the reason the 0-row result is tolerated, and explicitly tells the next reader *not* to "fix"
  it into an assert. Exactly what design.md means by documenting a hidden design decision. It
  also encodes the round-1 review's reversal, so the reasoning cannot be re-litigated blind.
- `evaluateBatchGate` `batch-builder.ts:123-133` — the accounts-then-`agent_runs` lock order.
  Non-derivable from the code (the constraint lives in a *different* function), and pinned by a
  test. Keep.
- `commitTerminalCheckpoint` `failed-hook.ts:42-50` — "owning `sql.begin` here is part of the
  contract". Explains why the helper takes `sql` not `tx`, which is otherwise a smell.
- `constructBatch:610-611` — "Re-evaluated here on purpose: this is the load-bearing check".
  Pre-empts the obvious wrong cleanup.

Redundant or process-flavoured:

- **F2 — the lock contract is now documented twice in one file.** `ingest.ts:5-14` (module
  header) already owns the key expression, the `hashtext` wrapping, the FIRST-statement rule,
  and the fact that the failed-hook takes the same lock. `ingest.ts:374-379` restates all four
  in `acquireCsvIngestLock`'s doc. Two owners of one fact, 370 lines apart, in the same file —
  the exact thing engineering.md's "one authoritative representation" rule prohibits, and the
  header is now the copy that will go stale. The function-level doc should keep only what the
  header cannot own (that this function *is* the owner) and the header should point at it.
- `terminalizeUpload`'s surviving one-liner (`ingest.ts:423`) — "Writes the terminal report AND
  clears raw_csv in the surrounding tx (§3)" — now describes what `writeTerminalUploadState`
  owns and omits what `terminalizeUpload` actually adds (the watch-mode batch trigger + the
  failure log). Stale by omission after the extraction. (Appendix-level; noted, not tabled.)
- The `THE owner of…` / `THE single writer of…` / `Sole owner of…` opening formula appears five
  times. It is consistent and it does communicate intent, so it is not slop — but it is
  restating the branch's *plan* rather than the module's contract in two of the five cases
  (`acquireCsvIngestLock`, `deleteUnbuiltBatch`'s neighbours). Style note, not a finding.
- `(S4)` at `batch-builder.ts:322` propagates a review-artifact identifier from the pre-existing
  comment at `:52` into a second location. The identifier only resolves via
  `docs/reviews/feat-544-watch-mode-batch-ui/step7-triage.md`. Since `:52` already established
  it in this file, this is consistency rather than new debt — but it is now stated twice.

**No comment on the branch restates its code line-by-line, and none compensates for a bad
name.** The +161 is honestly spent.

## 5. Single ownership — verified beyond the diff

Grepped the whole repo (excluding `node_modules`), not just the changed files.

| Fact | Owner | Duplicates surviving |
|---|---|---|
| `csv_ingest_<businessId>` lock key + `hashtext` + first-statement rule | `acquireCsvIngestLock` (`src/lib/solicitation/ingest.ts:380`) | **None in source.** Only hits are the two tests that pin the value, the module header comment (F2), `batch-builder.ts:602`'s comment noting its *distinct* namespace, and historical plan docs. |
| `contact_csv_uploads` terminal write | `writeTerminalUploadState` (`ingest.ts:404`) | **None.** Exactly one `UPDATE contact_csv_uploads` and one `raw_csv = NULL` in all of `src/` + `worker/`. All three former call sites route through it. |
| Batch gate re-check (lock → account read → offboarding → reason) | `evaluateBatchGate` (`batch-builder.ts:135`) | **None.** The other 6 `lockAccountBeforeOffboardingProjection` callers (payments, tier-change, add-location, stripe ingress) are different flows with different consequences — correctly *not* collapsed. |
| Unbuilt-batch DELETE | `deleteUnbuiltBatch` | **None.** |
| `/api/settings/*` owner preamble | `requireSettingsOwner` (`src/lib/auth/route-helpers.ts:219`) | **None.** `account_id_not_allowed` now appears once in source. The other `/api/settings/*` routes (`channels/override`, `channels/overrides`, `voice`, `settings/route.ts`) never had this preamble, so there is no third clone left behind. |

One adjacent-but-different check is worth knowing about and is **correctly not merged**:
`src/lib/auto-approval/settings.ts:218` re-runs `isOperationalUIBlocked` *inside the write
transaction* under the account lock. That is a second, transactional enforcement of the same
policy — the route-level gate is a fast 403, the in-tx one is the real guard. Collapsing them
would be a security regression. Good judgement not to.

`requireSettingsOwner` also lands in the right place: `src/lib/auth/route-helpers.ts` next to
its two siblings, with `(sql, request)` matching `requireWritableOwner`'s existing signature
order, a `SettingsOwnerResult = OwnerAccountResult` alias matching `WritableOwnerResult`, and an
injected `Sql` that keeps invariant #15 intact (`ci:db-imports` passes strict). The doc comment
even explains the *difference* from `requireWritableOwner` (offboarding gate only, no
writable-subscription gate), which is the one thing a reader would otherwise have to diff.

## 6. Test quality

+411 lines. Split by kind:

**Behaviour through public contracts (good, the majority).**
`route-helpers.test.ts:378-437` tests `requireSettingsOwner` through its four documented
outcomes (400 / 403 offboarding / 401 pass-through / success), asserts the `no-store` header,
and asserts `getOffboardingState` was called with the resolved `accountId`. The two
"not called" assertions (`mockRequireRole` not called on the `?accountId` 400;
`mockGetOffboardingState` not called on the 401) look like call-order spying but are **the
contract itself** — the doc comment says "the order is the guard, not an optimization". Correct
to assert.

**Deliberate SQL-text pins (good, keep).**
- `ingest.test.ts:120` and `csv-ingest/index.test.ts:184,203` pin the lock key *value*
  `csv_ingest_business-1`. Nothing else in the system enforces that two writers agree on this
  string; a silent change breaks serialization with in-flight ingests holding the old key.
- `batch-builder.test.ts:301-322` asserts the construction and preparation account-read SQL and
  the two DELETEs are **byte-identical text with identical bind values**. This is the direct
  executable expression of "one owner" — text equality is the point, not incidental coupling.
- `batch-builder.test.ts:371-388` pins accounts-lock-before-`agent_runs`-lock via
  `invocationCallOrder`. Lock ordering is exactly the class of invariant that only an ordering
  assertion can protect, and D3 explicitly promised it.

**Nice touch:** `csv-ingest/index.test.ts:22-27` *spies* on the real `acquireCsvIngestLock`
(via `importOriginal` + `mockImplementation(real…)`) instead of stubbing it, so the worker test
still exercises the shared owner's actual SQL. That is a deliberate, well-commented choice.

**Wear:**
- **F1** — `ingest.test.ts:75-100`, the `laneFilesBuildingTheLockKey()` source scan. See finding.
- **F7** — `ingest.test.ts:146`, `expect(write.values).toEqual(['failed', report, 'upload-1',
  'business-1', 'pending'])`. The `'pending'` element is a deliberate pin of the guard predicate;
  the *positional equality of all five* is incidental and will break on any innocent `SET`-clause
  reorder. `toContain(UPLOAD_STATUSES.PENDING)` plus a `text` assertion would pin the contract
  without the ordering coupling. (Note the same test's neighbour at `:144` already asserts
  `text` contains `AND status = ?` — so the ordering assertion adds brittleness, not coverage.)
- **F6** — `batch-builder.test.ts:231-322` is one `it` containing two complete scenarios,
  separated by a mid-test `resetMockSql()` + `mockClear()`, with values captured in run 1
  (`preparationAccountRead`, `preparationDelete`) compared against run 2. It is clever and it
  does prove the cross-transaction single-owner claim, but ~90 lines with two arrange/act/assert
  cycles under one name means a failure does not localize, and the mid-test reset is a trap for
  anyone adding a third assertion.
- **Coverage gap worth naming:** the deviation with the largest design consequence
  (`commitTerminalCheckpoint` owning `sql.begin`) added **zero** new tests. The pre-existing
  `worker/jobs/solicitation-batch/__tests__/index.test.ts:200-202` does assert CAS-before-
  fail-run ordering, so the behaviour is netted — but nothing asserts the *new* structural claim
  ("no statement can be introduced above the CAS"), which is the whole justification for the
  deviation. Not a finding (the claim is structural, so arguably untestable), but the deviations
  doc overstates its evidence.

## 7. "Never do" sweep

| Rule | Result |
|---|---|
| No `any` | **Clean.** Zero `: any` / `as any` in all five touched source files. The pre-existing `tx.json(x as never)` casts moved verbatim; no new ones. |
| No string literals where a constant exists | **Clean in new TS.** `UPLOAD_STATUSES.FAILED/PENDING/COMPLETED` used throughout. Literals inside `loadCandidatePool`'s SQL (`'completed'`, `'send'`) are moved-verbatim SQL text, pre-existing. |
| No business logic in route handlers | **Improved.** Both settings routes shrank to parse → call → return; the gate logic moved to a module. |
| No silent catches | **Clean.** No new `catch`. The failed-hook's existing catch preserves its `reportCaughtError` + leave-outbox-dispatched posture verbatim. |
| No new abstraction for a single caller without justification | **Justified ×2** (`commitAskDecisions`, `commitTerminalCheckpoint`) — both hide ≥45 lines and a stated invariant, both document why. |
| No new file / directory / dependency | **Clean.** Zero. |
| `${JSON.stringify(x)}::jsonb` | **Clean.** `tx.json()` everywhere. |
| Invariant #15 (explicit DB client) | **Clean**, `ci:db-imports` strict passes. `requireSettingsOwner(sql, request)` correctly takes the client rather than importing `@/lib/db/server`. |
| Invariant #13 / #14 (server-authoritative flags, server-owned auto-approval policy) | **Clean**, `ci:static-policy` passes. |
| JSONB parse-site allowlist (CLAUDE.md gotcha) | **Unchanged** — no parse site added or moved; the allowlist needs no edit. |
| Docs obligations | **Met.** No new source file → no `docs/directory.md` change needed. Plan + deviations doc present and honest (the deviations doc *corrects its own plan's* framing, which is the right instinct). |

---

## Findings

| # | Severity | Location | Finding | Standard |
|---|---|---|---|---|
| F1 | Low | `src/lib/solicitation/__tests__/ingest.test.ts:77` | The single-owner guard matches only `'csv_ingest_${'` — a duplicate written as `'csv_ingest_' \|\| businessId` (the exact form in this file's own module header at `ingest.ts:6` and in the #541 plan) passes silently. The guard's failure mode is a false PASS on the most likely copy source. | engineering.md — assumptions must live in checks that actually hold; production.md — validate before trusting |
| F2 | Low | `src/lib/solicitation/ingest.ts:5-14` vs `:374-379` | Lock key, `hashtext` wrapping, first-statement rule and the failed-hook's participation are now documented in two places in one file. | engineering.md — one authoritative owner per fact |
| F3 | Low | `worker/jobs/solicitation-batch/failed-hook.ts:37,51` | `TerminalCheckpoint` / `commitTerminalCheckpoint` coin "checkpoint" for what the function's own doc comment calls "the coupled terminal transition"; the value is an outcome, not a resumable checkpoint. | design.md — names reveal abstractions; consistency is design information |
| F4 | Low | `src/lib/solicitation/batch-builder.ts:312,328` | `loadCandidatePool` / `CandidatePool` names the glossary concept **Batch candidate window** "pool", while `poolCount` in the same type means the *untruncated* pool — one word, two meanings. | design.md — precise names; glossary vocabulary |
| F5 | Low | `src/lib/solicitation/batch-builder.ts:137,169,330,458` | Four shapes for the same id triple in one file: `{batchId, accountId}`, `{batchId, accountId, businessId}`, `{accountId, businessId}`, and a named `BatchIdentity {id, accountId, businessId}`. | design.md — related operations share conventions |
| F6 | Low | `src/lib/solicitation/__tests__/batch-builder.test.ts:231` | One `it` runs two complete scenarios separated by a mid-test `resetMockSql()`, carrying run-1 captures into run-2 assertions; a failure does not localize. | engineering.md — shorten feedback loops, visible failures |
| F7 | Low | `src/lib/solicitation/__tests__/ingest.test.ts:146` | Full positional `toEqual` on bind values couples the test to `SET`-clause order; only the `'pending'` element is a deliberate pin, and `:144` already asserts the predicate via SQL text. | design.md — test public behaviour, not incidental structure |
| F8 | Low | `src/lib/solicitation/batch-builder.ts:143-158` | `evaluateBatchGate` contains the identical `account missing for batch` throw twice, three lines apart. Pre-existing duplication that the extraction made adjacent and did not collapse. | engineering.md — leave touched areas better; broken-windows rule |

## Appendix — low-confidence / stylistic (not in the findings table)

- `commitTerminalCheckpoint` mutates an outer `checkpoint` object from inside the `sql.begin`
  callback and returns it, rather than returning the value from the callback (postgres.js
  resolves `sql.begin` with the callback's return). The mutation form was inherited from the
  two `let` flags it replaced, so it is not a regression, and the early-return branches would
  each need an object literal. Judgement call, not a defect.
- `commitTerminalCheckpoint(sql, handle, errorClass)` splits `errorClass` out of `handle` even
  though it is part of the same failure description. Folding it in would give a one-object
  signature matching the file's other helpers.
- `evaluateBatchGate` takes `batchId` solely to interpolate the throw message. Defensible
  (the message is the diagnostic), but it makes the parameter look like a query key.
- `terminalizeUpload`'s one-line doc (`ingest.ts:423`) is now stale by omission — it describes
  the extracted write and not the batch trigger / failure log the function actually adds.
- `loadCandidatePool`'s SQL still uses the literal `'completed'` for `contact_csv_uploads.status`
  where `UPLOAD_STATUSES.COMPLETED` exists. Moved verbatim, not introduced here; flagging only
  because "leave touched areas better" would have made it a two-character change.
- `(S4)` now appears in two comments in `batch-builder.ts` (`:52`, `:322`). Review-artifact IDs
  in production comments resolve only via `docs/reviews/…`; the convention pre-exists in this
  file, so this is consistency rather than new debt.
- The `laneFilesBuildingTheLockKey()` scan does path normalization for Windows
  (`.split('\\').join('/')`) in a macOS/Linux-only repo. Harmless.
- Repo-scanning policy checks conventionally live in `scripts/ci/*` behind a `pnpm ci:*` entry
  (there is precedent for the test-file form in `src/__tests__/eslint-boundaries.test.ts`, so
  this is a defensible choice — but the `ci:` route would give it CI-visible naming and let the
  `lint` job own it).
- The deviations doc's "the executor now reads as CAS → lock → gate → load pool → decide →
  commit → complete → mark built" phrasing invites a temporal-decomposition reading that the
  code does not deserve. Worth rewording if the doc is kept.
