# #680 — DROP the four legacy `zernio_backfill_runs` counters (migration 103)

**Branch:** `feat-680-drop-legacy-backfill-counters` · **Base:** `origin/main` @ `e447ee5b`
**Intake:** `docs/superpowers/plans/feat-680-drop-legacy-backfill-counters-intake.json`
**Classification:** RISK = high · SURFACE = backend · db_touching = true
**Ticket:** #680 (closing ticket of epic #667) · **Design of record:** ADR 0015 §4, spec
`docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §8a R4

## Precondition — DISCHARGED

`docs/runbooks/evidence/2026-08-08-consented-import-staging-proof.md` (commit `8cc09294`).
End-to-end consented-import run on staging head `e447ee5b`; both Supabase projects return **0 abort
rows** under the two-branch reconciliation preflight. The epic is proven on staging; 103 may proceed.

## Design analysis (deep-module review)

**No production TypeScript changes. No module, interface or seam is touched.**

- `worker/jobs/zernio/ZernioBackfillWorker.ts` already writes only `imported_count`,
  `skipped_count` and `oldest_skipped_create_time` (`:416-418`), and its header comment (`:23-24`)
  already records the legacy four as unwritten. There is no residual read to remove — the ticket's
  "sweep the worker" bullet is discharged by inspection.
- `scripts/ci/tenant-scope-allowlist.ts:2211` already carries the collapsed two-column UPDATE form;
  #675/#677 narrowed it. The ticket's third bullet is **already satisfied** — 0 diff (deviation D1).
- The one new file is a per-migration shape suite, an instance of the established pattern
  (074/076/077/078/088/091/100/102), not a new abstraction.
- **No `schema-ready.ts` entry.** `SchemaRequirement` models presence; a presence check cannot
  express "these four are gone". Precedent: 102 deliberately has no entry because a presence check
  there proves nothing. The new suite asserts absence directly against `information_schema` and
  reuses `MIGRATION_100_IMPORT_CONSENT` via `assertSchemaReady` to prove the DB is at/after 100.
- **No `live-db-suites-audit.ts` allowlist entry.** The new suite executes no DDL — introspection
  plus one rolled-back INSERT. It still takes `acquireLiveDbLock`, matching its sibling
  `migration-100-import-consent.integration.test.ts` exactly.

## Tasks

Serial: T1 → T2 → T3. No mutually independent pair (T3 needs T2's final migration text).

---

### T1 — EVAL: author the failing tests (the spec in executable form)

**Blocking edges:** none (first task).
**Files:** `src/lib/shared/__tests__/migration-103-drop-legacy-backfill-counters.integration.test.ts`
(new), `src/lib/shared/__tests__/migration-100-import-consent.integration.test.ts`,
`worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts`.
**Precedent to follow:** `migration-102-import-consent-analytics-events.integration.test.ts` for the
suite skeleton (`acquireLiveDbLock` + `assertSchemaReady` + text assertions over the migration file);
`migration-100-import-consent.integration.test.ts` for the `information_schema.columns` idiom.

New suite — four tests, titles VERBATIM from the intake:

1. `the four legacy gap_*/historical_* counters are absent from zernio_backfill_runs`
   — `information_schema.columns` filtered to the four names → expect length 0. **The failure
   message must name migration 103 and `pnpm test:db:setup`**, so a behind-head local DB reads as
   "DB behind head", not "expected 0 got 4" (intake E4).
2. `imported_count, skipped_count and oldest_skipped_create_time survive the drop with their 100-era shape`
   — the three survivors present; both counters `integer`, `is_nullable='NO'`, `column_default='0'`.
3. `a backfill run INSERT naming only the surviving columns succeeds and defaults both counters to 0`
   — inside `sql().begin` + deliberate rollback, INSERT naming none of the counters,
   `RETURNING imported_count, skipped_count` → both 0. Proves the DROP left the defaults intact.
4. `the header preflight is the two-branch predicate, not the naive collapsed = legacy sums form`
   — read `supabase/migrations/103_*.sql` as text; assert the header contains the post-#675 zero
   guard (`NOT (gap_processed_count = 0`) and the ABORT instruction. This pins the encoding: the
   naive form flags healthy rows and was the first thing to go wrong in this ticket's own recon
   (intake E1). Text assertion, no DDL, no DB.

Retarget in the migration-100 suite (its current `toHaveLength(7)` asserts the legacy four are
PRESENT and goes red the moment the local DB passes 103 — intake E6):

5. `zernio_backfill_runs.imported_count and skipped_count are NOT NULL DEFAULT 0 after the #680 drop of the legacy four`
   — same body, expectation moves 7 → 3, comment rewritten to point at 103 as the owner of absence.

In `ZernioBackfillWorker.test.ts` — delete `LEGACY_COUNTER_COLUMNS` (`:218-223`) and both assertion
loops (`:701`, `:1075`); the columns cannot exist, so a regression is a hard 42703 and the new suite
pins absence. Keep every positive assertion. Retitle:

6. `writes only imported_count and skipped_count on the counters UPDATE` (was `…; legacy counters
   stay at their defaults` — meaningless once they are gone)
7. `reactivation INSERT names only the surviving run columns` (was `…names no legacy counter column`)

**Expected state after T1:** tests 1–4 RED (no migration file, DB at 102), test 5 RED (columns still
present), tests 6–7 GREEN immediately — they are renames of already-passing assertions, not new
behaviour. That asymmetry is expected and is not a reason to split the task.

---

### T2 — IMPLEMENT: migration 103

**Blocking edges:** T1.
**Files:** `supabase/migrations/103_drop_legacy_backfill_counters.sql` (new).
**Precedent:** `100_import_consent_and_backfill_counters.sql` (header structure, `SET lock_timeout`,
explicit Rollback paragraph); `101_import_decision_three_valued_check.sql` (preflight-in-header).

Body: `SET lock_timeout = '5s';` then one `ALTER TABLE zernio_backfill_runs DROP COLUMN IF EXISTS ×4`.

Header must carry, each as a stated decision rather than a bare comment:

- The **two-branch preflight SQL** with the ABORT instruction, and why the naive form is wrong —
  post-#675 rows hold all four legacy counters at 0 while `imported_count` is non-zero, so the naive
  predicate flags healthy rows (observed: both staging rows flag under it, zero under two-branch).
- Why a pre-#675 row with real work but zero legacy counters **cannot exist** — the pre-#675 worker
  dual-wrote both sets in one UPDATE, so non-zero collapsed implies non-zero legacy (intake E3).
  Without this, the next reader has to re-derive that the disjunction is sound.
- **Point of no return** (intake E7): reverting this PR removes the migration file but does not
  un-drop applied columns. After 103, reverting a pre-#675 epic PR puts the old dual-writing worker
  against a schema without those columns (42703). This is where ADR 0015 §4's revert-only backout
  stops being sufficient — the whole reason the collapse was split in two.
- No down migration (099/100 precedent); no new relation → no RLS change, no retention-policy row.
- `lock_timeout` rationale: DROP COLUMN takes ACCESS EXCLUSIVE and can collide with an in-flight
  backfill; 5s makes that a fast failure rather than a queue behind a long transaction (intake E8).

Then `pnpm test:db:setup` to provision the local container to head, turning tests 1–3 and 5 green;
test 4 goes green on the header text.

---

### T3 — DOCS: migrations-log entry + audit ticks

**Blocking edges:** T2.
**Files:** `.claude/reference/migrations-log.md`, `docs/adr/0015-consented-import-unflagged-replacement.md`,
`docs/superpowers/specs/2026-08-05-consented-review-import-design.md`.

- migrations-log: head `102` → `103`, plus the entry in the house shape (what/why, the two-branch
  preflight and its per-environment result, the point-of-no-return note, shape-suite pointer, and
  the `APPLIED TO STAGING … / PRODUCTION …` lines — filled at apply time, verified by schema
  introspection and never the migration ledger, as that log's header demands).
- ADR 0015: the "epic owes a cleanup migration" consequence is deferred work **discharged** — record
  it as landed in 103, with the staging-proof evidence path. Do not rewrite the decision.
- Spec §8a R4: tick the DROP half as shipped.

Per the repo rule on ticking a checklist item: grep both filenames for cross-references and fix
every one in this same change.

## Verification

Standard gate (`scripts/verify-gate.sh`, then `--review` before step 7). `db_touching` → the gate
provisions the test DB serially itself. `TEST_DATABASE_POOL_URL` must be set so the changed
`*.integration.test.ts` suites actually RUN — a SKIP row here is not review-ready (the #520 class).
No extra `verification_commands`; `ci:tenant-scope`, `ci:rls-audit` and `ci:live-db-suites` are all
inside the enumerated `ci:*` set.

## Ship (RISK = high)

Staging first: apply 103 to `kubdiqdhqbhwmqfditeg` **after** re-running the two-branch preflight in
that same window, verify by introspection, then ride the branch on `staging`. Open the PR to `main`,
confirm CI green, PAUSE for merge approval, and apply to `udeyaqnvpojbwgoaxwdg` in lockstep at
promotion — preflight re-run there too, even though the table is empty (intake E5: a skipped
preflight is not a passed preflight).
