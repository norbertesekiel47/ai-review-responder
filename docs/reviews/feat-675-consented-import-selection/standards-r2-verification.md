# Standards Review r2 — Verification of Round-1 Fixes (feat-675-consented-import-selection)

- **Branch**: `feat-675-consented-import-selection`
- **Fix commit under verification**: `7bbc0224` ("fix(#675): review r1 — shared importExternalReplyOntoRow, wrapper deleted, parse clamp harmonized, comment hygiene")
- **Scope**: VERIFICATION ONLY — each accepted r1 finding's fix, plus commit-surface and green-suite confirmation. No new fronts against unchanged code (out-of-scope observations in the appendix, untriaged).
- **Round-1 context**: `docs/reviews/feat-675-consented-import-selection/standards-r1.md` (findings + orchestrator triage).

## Overall verdict

**CLEAN** — all 5 accepted fixes VERIFIED; the fix commit introduced no new defect; commit surface is exactly the 4 source/test files + 2 report files; suites pass and typecheck is clean.

## Per-fix verification

### F1 — shared `importExternalReplyOntoRow` helper: **VERIFIED**

- Helper exists as a **non-exported** `async function importExternalReplyOntoRow(tx, businessId, reviewRowId, reviewLanguage, externalReply, logger, messages)` at `worker/jobs/zernio/zernio-ingest-shared.ts:526-554`, with a doc comment stating the counter bumps ONLY on an actual insert and that each caller keeps its exact wording.
- **Branch 2** (matched row, no active responses) calls it at `zernio-ingest-shared.ts:320-324` with messages byte-identical to the pre-fix inline block: inserted = `Imported external reply onto existing review row ${targetReviewRowId}`; notBumped = `External reply for review row ${targetReviewRowId} already imported (ON CONFLICT) — counter not bumped`.
- **Branch-3 consented tail** (active responses superseded, none protected) calls it at `zernio-ingest-shared.ts:393-397`: inserted message preserved verbatim (`… after superseding active draft(s)`); the previously-missing ON CONFLICT/not-bumped log is now present (`… counter not bumped after superseding active draft(s)`) — this is the restored log and the only behavior change (r1's F1 log-drift defect closed).
- **PHI gates stayed per-branch** and were not folded into the helper; all three `openPhiReviewException` sites retain `source: 'external_reply_import'` (`zernio-ingest-shared.ts:261, 313, 386`) — untouched by the fix diff.
- **No exported signature changed**: the fix diff for this file touches only the `reconcileExternallyAnsweredReview` body and appends the private helper; exports remain `liveIngestCutoff`, `IngestErrorContext`, `handleZernioIngestError`, `openPhiReviewException`, `reconcileExternallyAnsweredReview` with unchanged signatures.
- Branch 1 (previously-unseen review) keeps its inline tail (`:268-274`) — correctly outside F1's stated scope (different target-row semantics and log wording).
- Types used by the helper pre-exist in the file: `TxClient` (`:34`), `WorkerLogger` import (`:28`).

### L2 — `connectionCutoff` wrapper deleted: **VERIFIED**

- Wrapper gone from `worker/background/pollers/ZernioRecentReviewPoller.ts`; `grep -rn connectionCutoff worker/ src/` → zero hits repo-wide.
- Sole former call site now calls the seam directly: `const cutoff = liveIngestCutoff(connection.connected_at)` at `ZernioRecentReviewPoller.ts:192` (inside `tombstoneMissingSourceReviews`); the import at `:21` and the pre-existing `isRecentForConnection` usage at `:102` are unchanged.
- The full fix diff for this file is exactly the 4-line wrapper deletion + the 1-line call-site swap — nothing else in the poller changed.

### L3 — `maxPages` positive-int-or-default(6) parse: **VERIFIED**

- `worker/jobs/zernio/ZernioBackfillWorker.ts:242-243`:
  `const parsedMaxPages = parseInt(getWorkerConfig().ZERNIO_IMPORT_MAX_PAGES ?? '', 10);`
  `const maxPages = Number.isFinite(parsedMaxPages) && parsedMaxPages > 0 ? parsedMaxPages : 6;`
- Semantics executed under node: `'0'` → 6, `'-3'` → 6, `'garbage'` → 6, unset → 6, `''` → 6; positive ints respected (`'3'` → 3, `'12'` → 12). (`'2.7'` → 2 via parseInt truncation — same semantics as the `liveIngestCutoff` pattern it was harmonized to, `zernio-ingest-shared.ts:54-55`.)
- This closes r1 F6's inconsistency (old clamp: `'0'` → 6 but `'-3'` → 1). No shared cross-file util introduced — matches the triage's "ACCEPT (minimal)". No other change in the surrounding pagination block.

### L4a/L4b — comment hygiene: **VERIFIED**

- **L4a**: `ZernioBackfillWorker.ts:315` now reads only `// Prefix with err.name so the failed row carries the class.` — the "Signature verified (r2): … error THIRD" narration is gone, the err.name rationale kept, directly above the `markOutboxFailed(sql, outboxId, ...)` call at `:316`.
- **L4b**: the shared-suite describe header at `worker/jobs/zernio/__tests__/zernio-ingest-shared.test.ts:823` is now `// ── #675 consented import seams ───` (was "#675 consented import — spec stubs (Tasks 2 & 4 flip these)"). Grep confirms no "stub"/"Tasks 2" narration remains in the test file.
- The r1-blessed citations survive as intended (e.g. `ZernioBackfillWorker.ts:303` "(r1 HIGH-2)" anchoring the terminal-not-thrown shape) — r1 F7 explicitly kept those.

### L5/F5 (triage L1) — test-helper consolidation: **VERIFIED**

- Module-scope `mkTaggedResult` / `mkRecordingTx` / `mkReview` (+ `RecordedCall` type) hoisted at `zernio-ingest-shared.test.ts:649-684`, with a comment naming the two #675 describe blocks they serve.
- Both #675 describes use them: "consentedImport option (#675)" tests (a)–(c), (e), (f) at `:709-:820` and "consented import seams (#675)" test (d) at `:827-:838` — all via `mkRecordingTx([...])` / `mkReview()`; test (d)'s hand-rolled inline `mkTaggedResult`, tx closure, and `ZernioReview` literal are gone.
- **Pre-existing pre-#675 helpers untouched**: the five describe-scoped copies at fork point `ccc4b9ec` (lines 184/197/307/320/329) map 1:1 to HEAD lines 186/199/309/322/331 — the fix diff touches nothing before line 641 of the file. They shadow the module-scope helpers inside their own describes; no semantic interaction.
- **No assertion weakened** — the fix diff replaces only harness plumbing; assertion blocks are unchanged context:
  - Test (d) (`:841-:847`) still asserts 5 tx calls, `calls[2]` `UPDATE responses` (supersession), `calls[3]` `INSERT INTO responses` containing `'posted'`, `calls[4]` `UPDATE zernio_backfill_runs`, plus both log assertions.
  - Test (f) (`:813-:819`, untouched by the fix commit) still asserts 3 calls, stale-only supersession (`toContainEqual(['resp-stale'])`), **no** `INSERT INTO responses`, **no** counter bump, and the Protected-1 log.

## Commit surface

`git show 7bbc0224 --stat` — exactly 6 files:

| File | Role |
|---|---|
| `worker/jobs/zernio/zernio-ingest-shared.ts` | F1 |
| `worker/background/pollers/ZernioRecentReviewPoller.ts` | L2 |
| `worker/jobs/zernio/ZernioBackfillWorker.ts` | L3, L4a |
| `worker/jobs/zernio/__tests__/zernio-ingest-shared.test.ts` | L4b, L5 |
| `docs/reviews/feat-675-consented-import-selection/standards-r1.md` | report |
| `docs/reviews/feat-675-consented-import-selection/spec-correctness-r1.md` | report |

No other file touched. ✔

## Suites & typecheck

- `pnpm vitest run worker/jobs/zernio worker/background/pollers` → **34 passed | 2 skipped (36 files); 487 passed | 20 skipped (507 tests)**. Skips are the DB-gated integration suites (`TEST_DATABASE_POOL_URL` unset — expected per repo convention; the fix commit changes no live-DB-suite-covered behavior: helper extraction, wrapper deletion, config parse, comments, and unit-test scaffolding only).
- `pnpm typecheck` (`tsc --noEmit`) → **clean, zero errors**.

## Defects introduced by the fixes (in scope)

**None found.**

## Appendix — out-of-scope observations (untriaged; NOT findings)

1. **Partial consolidation is by design but leaves 3 `mkTaggedResult` definitions in the test file** (module scope `:651` + pre-#675 describe-scoped `:199`/`:322`, likewise 2 `mkReview` shadows and 1 pre-#675 `mkRecordingTx` at `:331`). Repointing the pre-#675 describes at the module-scope helpers was correctly left out of this fix (they predate the branch and r1's appendix classed them pre-existing); a candidate for the already-recorded post-merge test-file sweep (F3 follow-up).
2. **`zernio-ingest-shared.ts:377` cites "(r2 fix-defect on the mixed protected+stale case)"** — a review-round citation that predates the fix commit and anchors a surviving constraint (`protectedIds.size === 0` gate), i.e. the category r1 F7 explicitly kept. Listed only because L4's theme was round-citation hygiene.
3. **Tooling**: the `bash-write-guard.sh` PreToolUse hook blocked a read-only `sed -n 1,60p <file>` as a "sed -i" write during this review. False positive on the guard's sed pattern; worth a regex tweak someday.
4. The 20 skipped DB-gated tests mean the governor/publisher-adjacent integration files did not run in this verification; per the CLAUDE.md gotcha they only matter when touching governor/judge/publisher paths, which this fix commit does not.
