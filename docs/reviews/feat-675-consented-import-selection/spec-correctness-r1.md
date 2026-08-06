# Spec & correctness review — `feat-675-consented-import-selection` (r1)

Reviewer: spec-correctness agent · Date: 2026-08-05 · Fork point: `ccc4b9ec` · HEAD: `125605c9`

## Scope reviewed

- Full diff `ccc4b9ec..HEAD` (16 files, +2267/−458) and the 10-commit sequence.
- Contract inputs read field-by-field: `.feature/intake.json` (locked intake, 30 promised
  test titles), `docs/superpowers/plans/feat-675-consented-import-selection-deviations.md`
  (D1–D13, all ACCEPT), `docs/reviews/feat-675-consented-import-selection/blast-radius.md`,
  plan `docs/superpowers/plans/2026-08-05-feat-675-consented-import-selection.md`.
- Line-by-line reads: `worker/jobs/zernio/ZernioBackfillWorker.ts` (full rewrite +
  `selectImportWindow`), `worker/jobs/zernio/zernio-ingest-shared.ts` (`liveIngestCutoff` +
  reconcile changes), `worker/background/pollers/ZernioRecentReviewPoller.ts` (delegation),
  `src/lib/reviews/process-review.ts` (doc-comment-only), `src/lib/config/worker.ts`,
  `scripts/ci/tenant-scope-allowlist.ts`; old worker at fork point read for comparison.
- Evidence runs (all green): the three touched suites — 78/78 pass
  (`ZernioBackfillWorker.test.ts`, `zernio-ingest-shared.test.ts`,
  `ZernioRecentReviewPoller.test.ts`); `ci:tenant-scope` (420 entries, no drift),
  `ci:outbox-seam`, `ci:static-policy`.

## Per-invariant verdicts

| # | Invariant (intake) | Verdict | Evidence |
|---|---|---|---|
| 1 | Disjoint lane ownership — import selects only `createTime < connected_at − grace`, exact complement of `isRecentForConnection` | **PASS** | Poller: `reviewMs >= cutoff.getTime()` (`ZernioRecentReviewPoller.ts:105`). Import: `if (t >= opts.upperCutoffMs) return false` (`ZernioBackfillWorker.ts:86`) — `≥` owned by live lane, `<` by import, boundary exact at the same `liveIngestCutoff` value (single owner, `zernio-ingest-shared.ts:50-57`). Boundary tests on both halves: worker test "excludes reviews at or after connected_at minus grace…" (at-cutoff excluded, cutoff−1ms imported, under configured 120s grace) and poller test "processes a review at the live-ingest cutoff and skips one below it under configured grace" (at-cutoff processed, cutoff−1ms skipped). `selectImportWindow` unit tests pin floor-inclusive / cutoff-exclusive. |
| 2 | Nothing the import stores can reach Google — `importReview` writes no `job_outbox` row | **PASS** | `importReview` (`process-review.ts:518-547`) writes reviews row + run spine + `analytics_events` (via `enqueueAnalyticsEvent` → `INSERT INTO analytics_events`, NOT job_outbox) only. Worker never calls `processReview` for imports; the only job_outbox INSERT reachable from the import path is `openPhiReviewException`'s `NOTIFY_ADMIN` row (admin notification — cannot reach Google; sanctioned "PHI exception row as today"). Deep assertion pre-exists: `import-review.integration.test.ts:181` "importReview writes no job_outbox row against the live database". |
| 3 | Import is insert-only for live-lane-owned rows; branch-3 supersession stores the external reply in the same transaction | **PASS** | Selection excludes everything ≥ cutoff, so reconcile only ever touches import-window reviews. `insertNewReviewRow` and `insertImportedReview` are ON CONFLICT insert-or-no-op. Branch-3 consented insert (`zernio-ingest-shared.ts:381-401`) runs inside the same `sql.begin` as the supersede UPDATE; D9 `protectedIds.size === 0` guard present; test (d) asserts supersede + `INSERT INTO responses ('posted')` + counter bump in one tx call sequence. (PHI-flagged review text aborts the response insert after supersession — the pre-approved PHI carve-out, see appendix A1.) |
| 4 | New runs write ONLY imported_count/skipped_count (+ oldest_skipped_create_time); legacy four frozen at DEFAULT 0; external_reply_ingested_count legitimate | **PASS** | Counts UPDATE (`ZernioBackfillWorker.ts:377-384`) names only the collapsed set; reactivation INSERT names no counter column at all (DEFAULT 0 confirmed in migrations 028 + 100 — all four legacy columns `NOT NULL DEFAULT 0`). No remaining production reader of the legacy four (grep clean outside tests/allowlist). `bumpExternalReplyIngestedCount` still increments on answered imports (D4 accepted). Test "writes only imported_count and skipped_count…" asserts no statement in the whole run touches a legacy column. |
| 5 | Retryability — completed_at NULL sentinel; cap exhaustion terminal via markOutboxFailed with completed_at left NULL | **PASS** | Cap path (`ZernioBackfillWorker.ts:301-319`): `markOutboxFailed(sql, outboxId, `${err.name}: ${err.message}`, attempt)` — signature verified against `src/lib/shared/outbox.ts:152` (error third, D8 landed); Sentry.captureException; return before any completed_at write. No-connection, eligibility-skip, and reconcile-failure paths all leave completed_at NULL. Tests 7, 13, and "reconcile failure: counts written but completed_at not set" assert `findCompletedAtUpdates()` empty. |
| 6 | Defensive re-sort kept; dirty ordering disables BOTH early stops | **PASS** | `selectImportWindow` always re-sorts (`:89-91`). `orderingClean` guards both `selected.length >= IMPORT_TARGET_COUNT` and `pageOldestMs < floorMs` breaks (`:283-284`); warning logged once at first inversion. Test 8 proves the floor stop stays disabled (2 pages fetched past a below-floor row); test 9 proves the target stop stays disabled AND that the correct newest-100 is selected when newer reviews sit on page 2 (p2-0..19 in, p1-80..99 displaced). Dirty cap-out with ≥100 candidates proceeds best-effort (`:301` requires `< IMPORT_TARGET_COUNT` to fail). |
| 7 | Consented lane imports answered reviews unconditionally; flag governs only live lane | **PASS** | `importAllowed = FLAG_ON() \|\| opts?.consentedImport === true` on both flag-gated branches; branch-3 tail gated on `consentedImport === true` only. Live-lane callers (poller `:153`, `ZernioReviewIngestWorker.ts:213`, `scripts/zernio-backfill-external-replies.ts:74`) pass no opts → byte-identical prior behavior; regression test (c) pins it. Worker test 4 runs with the flag unset. |
| 8 | Outbox discipline unchanged; markOutboxCompleted only after the run's terminal write | **PASS** | Order: counts UPDATE → throw-on-reconcile-failures → completed_at UPDATE → log → `markOutboxCompleted` (`:377-406`). Test 16 rejects the completed_at UPDATE and asserts markOutboxCompleted never fires. Skip-as-success paths (already-completed, eligibility, no-connection) complete the outbox without a terminal run write — explicitly sanctioned by the intake edge cases. |

## Per-edge-case verdicts

| # | Edge case (intake) | Verdict | Evidence |
|---|---|---|---|
| 1 | connected_at NULL → no upper cutoff | **PASS** | `liveIngestCutoff(null) → null` → `upperCutoffMs = null` → filter skips upper bound. Worker test 14 + `selectImportWindow` unit test; poller null-handling unchanged (owns nothing). |
| 2 | No active connection → skip-as-success, completed_at NULL | **PASS** | `:225-229`; test 13. |
| 3 | <100 in window → import what exists; zero → success with imported_count 0 | **PASS** | Tests 3 (`[0,0,null]` counts + completed) and 19 (37 imported, no cap error). |
| 4 | Ordering violation → warning + both stops disabled; dirty cap-out ≥100 best-effort | **PASS** | Tests 8, 9; code `:270-284`, `:301`. |
| 5 | Cap exhausted, token set, target unmet → TERMINAL markOutboxFailed + Sentry, completed_at NULL | **PASS** | Test 7 asserts error-class name in the failed-row message, `cap=2`, Sentry call, no completed_at, no markOutboxCompleted, handler resolves (not thrown). |
| 6 | Cross-page duplicates deduped by review id | **PASS** | `fetchedById` first-wins map `:279`; test 27 (`[3,0,null]` counts). |
| 7 | PHI/malformed unanswered skipped + counted; answered PHI via reconcile, counts imported | **PASS** | Tests 11 (`[1,2,null]` — real PHI scanner + real normalization thrower) and 12 (`[1,0,null]`, no worker-side pre-screen). |
| 8 | Already-ingested → 'unchanged' → counted imported | **PASS** | `:370-373`; test 11. |
| 9 | Answered import-owned review with stale draft → superseded AND reply stored same tx (consented only) | **PASS** | Shared tests (d) and (f) (D9 mixed protected+stale: supersede stale, protected kept, NO duplicate imported row). |
| 10 | Reconcile failure → collect and throw at end; partial counts written first | **PASS** | `:323-392`; test "reconcile failure…" asserts counts `[1,0,null]` written before the throw. |
| 11 | Retry days later → floor recomputed from runtime now | **PASS** | Floor derived from `new Date()` per attempt `:232-234`; test 22 advances fake time 48h and the aged-out row leaves the selection. |
| 12 | Reactivation runs identical selection; correlation-idempotent | **PASS** | Same code path for both run reasons; test 24 (boundary rows identical + attempt-2 sentinel skip via same correlation_id) and test 25 (INSERT names no legacy counter column). |

## Contract compliance

- **30/30 promised test titles present verbatim** (scripted exact-string check across the
  three suites). Bodies read for all 30; each asserts the behavior its title claims —
  no title-only compliance found. Highest-value spot-checks: cap exhaustion (7), boundary
  complementarity (2 + 30, both under configured non-default grace against the REAL
  `liveIngestCutoff` via `vi.importActual`, per D7/D10), dirty ordering (8, 9), counters
  (10, 26 — the lexicographic-vs-epoch trap `'…00.5Z'` is genuinely exercised, D6),
  outbox-ordering (16), property partition-completeness (15).
- **Deviations D1–D13**: all described fixes verified landed. D1 (terminal markOutboxFailed,
  not thrown) ✓; D2 (both stops disabled) ✓; D3+D9 (branch-3 consented insert with
  `protectedIds.size === 0` guard) ✓; D6 (epoch reduce) ✓; D7 (mock.calls assertions +
  importActual re-export) ✓ in both suites; D8 (arg order + class-name prefix) ✓;
  D10 (grace complementarity in BOTH suites) ✓; D11 (fixture reuse in `arbReview`) ✓;
  D12 (allowlist snippet swap, byte-identical to the deviation record; `ci:tenant-scope`
  passes with no baseline change) ✓; D13 (doc-comment precedent line) ✓.
- **Drift**: every changed path is inside `allowed_edit_surface` (including the amended
  `scripts/ci/tenant-scope-allowlist.ts`). Both intake copies byte-identical
  (`.feature/intake.json` ≡ `docs/superpowers/plans/…-intake.json`). No behavior outside
  `user_visible_behavior`. Non-goals respected: no consent gate in the worker (#679), no
  enqueue-site changes (#676), no schema change, `ZernioReviewIngestWorker.ts` and
  `processReview`'s live lane untouched (poller refactor verified semantically identical
  to the old inline grace math, including null/non-finite handling and the
  parse-positive-int rule). `worker/index.ts:219` stale comment deliberately left
  (deviations standing note).
- **Blast radius**: all callers of changed exports checked. `reconcileExternallyAnsweredReview`
  — three no-opts callers keep prior behavior (regression test (c)); the new branch-3 tail is
  consented-only. `liveIngestCutoff` — poller delegation is a pure extraction. `importReview`
  — new worker caller respects the documented screen-before-call contract (PHI + normalization
  screens precede it). `handleZernioBackfill` — signature unchanged for `worker/index.ts`.
  `listAllReviews` removal from this worker leaves other users (publisher, script) untouched.
  New config key `ZERNIO_IMPORT_MAX_PAGES` is additive (`rawOpt`), documented in env-vars.md,
  inert when unset (default 6).

## Findings (≥80% confidence)

**None.** No finding met the confidence bar.

## Low-confidence appendix (not findings; observations only)

- **A1 — Branch-3 PHI carve-out vs invariant letter.** When the matched review's TEXT is
  PHI-flagged, the consented branch-3 path supersedes the stale draft and then returns
  WITHOUT storing the posted reply (`zernio-ingest-shared.ts:382-395`) — the invariant
  sentence "stores the external posted reply in the same transaction" is not satisfied in
  this sub-case. This mirrors branch 2's pre-existing PHI posture, is codified by test (e),
  and is pre-approved by the standing plan note ("reconcile owns PHI on its import
  branches; the exception row is the audit trail") — but note the review row already exists
  locally with its PHI text, so the gate here withholds only the response row. Deliberate
  design tension worth a line in #678's list-surface thinking (an imported answered PHI
  review renders reply-less).
- **A2 — `setMonth` leap-day narrowing.** `floor.setMonth(getMonth() − 12)` on Feb 29 rolls
  to Mar 1 of the prior year (JS date overflow), narrowing the window by ≤1 day once every
  four years. Deterministic and immaterial; noted because the intake says "12-calendar-month
  floor" without pinning the leap semantics.
- **A3 — Unparseable `createTime` rows vanish from both counters.** `selectImportWindow`
  excludes them outright (documented in the code comment) — they are neither imported nor
  counted skipped, a minor accounting asymmetry with the malformed-review path (which counts
  skipped). No test exercises an unparseable createTime through the handler.
- **A4 — Worker-level job_outbox assertion is partially delegated.** Test 5's
  `sqlTexts()` scan cannot see inside the mocked `importReview`; the deep claim rests on
  the pre-existing `import-review.integration.test.ts:181` live-DB test. Combined coverage
  is adequate; flagged only because the worker test alone would not catch a future
  job_outbox write added inside `importReview`.
- **A5 — Ordering detection and floor-stop scan pre-filter reviews.** The inversion check and
  `pageOldestMs` run over all page reviews before the location filter. `listReviews` is
  location-scoped server-side so this is theoretical; a foreign-location row could at worst
  disable early stops (conservative: more paging, never wrong selection).

## Verdict

**PASS.** The locked intake is implemented faithfully: boundary comparisons are the exact
complement across lanes, the pagination loop's token/cap/early-stop/dedupe logic is correct
under both clean and dirty ordering, counter accounting matches the collapsed-counter
contract with the legacy four safely frozen (DEFAULT-owned, zero remaining readers), the
terminal cap-exhaustion path is loud and claimable, and every accepted deviation's fix
landed. 78/78 touched-suite tests pass; tenant-scope/outbox-seam/static-policy audits pass.

## Orchestrator triage (round 1, 2026-08-05)

No findings ≥80% — nothing to triage. Low-confidence appendix reviewed: the branch-3 answered-PHI reply-less outcome is pre-decided (deviations D3/standing note — PHI exception row is the audit trail); unparseable-createTime exclusion is documented `selectImportWindow` behavior (normalization would reject those rows anyway). No action.
