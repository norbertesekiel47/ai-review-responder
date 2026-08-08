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
- **No generic `SchemaRequirement` entry in `schema-ready.ts`.** `SchemaRequirement` models
  presence; a presence check cannot express "these four are gone". (Correction, plan review F7: 102
  is *not* an example of "no entry" — `schema-ready.ts:437-470` holds a specialized
  `MIGRATION_102_IMPORT_CONSENT_EVENTS` requirement with its own definition-aware assertion. The
  accurate statement is that no *generic* requirement fits absence.) The new suite asserts absence
  directly against `information_schema` and reuses `MIGRATION_100_IMPORT_CONSENT` via
  `assertSchemaReady` to prove the DB is at/after 100.
- **Precedent split (correction, plan review F5/F8).** The suites are not one uniform pattern:
  074/076/077/078/088 sit in `MIGRATION_SHAPE_SUITES` and 091 in `DDL_PROBE_SUITES` — all DDL
  allowlists. Only **100** (live introspection with `acquireLiveDbLock` + `assertSchemaReady`) and
  **094/102** (text-only over the migration file via a local
  `const executableSql = sql.replace(/--.*$/gm, '')`) model what this suite does. Follow those two,
  not the allowlisted five.
- **`live-db-suites-audit.ts` allowlist:** the suite's introspection and rolled-back INSERT execute
  no DDL, but the preflight-branch tests create a `pg_temp` replica of the pre-103 shape. That is
  the documented sanctioned escape — it takes `acquireLiveDbLock` and a per-line
  `-- live-db-ddl-ignore: <reason>`, because a `CREATE TABLE` on `pg_temp` reads exactly like one on
  the shared table.

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

New suite — seven tests, titles VERBATIM from the intake.

**A. Statement-level assertions over the migration text** (no DB; 094/102 idiom — local
`const executableSql = sql.replace(/--.*$/gm, '')` so header prose is never mistaken for a statement):

1. `migration 103 executable SQL is exactly a bounded lock, the preflight guard, and the four legacy-column DROPs`
   — **the plan-review BLOCKER (F1).** Split `executableSql` on `;`, trim, drop empties, and assert
   the resulting statement list is exactly: one `SET lock_timeout`, one `DO $$ … $$` guard, one
   `ALTER TABLE zernio_backfill_runs` naming all four `DROP COLUMN IF EXISTS` and nothing else.
   Assert NO `UPDATE`, `DELETE`, `TRUNCATE`, or `CASCADE` anywhere. Final-state introspection alone
   cannot catch a migration that drops the columns *and* erases surviving counter values, nor
   distinguish 103 from a hand-dropped database.
2. `migration 103 sets a lock_timeout before the ACCESS EXCLUSIVE drop`
   — the bound exists AND precedes the `ALTER` in statement order (intake E8).

**B. Preflight guard behaviour — BOTH branches** (live DB; `acquireLiveDbLock`;
`-- live-db-ddl-ignore` for the `pg_temp` fixture). Extract the `DO` block from the migration file
and execute **the migration's own text**, against a `pg_temp.zernio_backfill_runs` replica of the
pre-103 shape shadowing the real table via `SET LOCAL search_path = pg_temp, public`, all inside a
transaction that always rolls back:

3. `migration 103 preflight raises when a legacy-work row disagrees with its collapsed counters`
   — seed one row with nonzero legacy counters whose sums differ from the collapsed values; the
   guard must RAISE. **This is the only test that can prove the guard works at all**: on clean data
   a broken guard and a working guard both report zero abort rows, and both environments are
   currently clean, so apply-time evidence cannot distinguish them.
4. `migration 103 preflight passes matching pre-#675 rows and post-#675 zero-legacy rows`
   — seed a reconciling pre-#675 row (collapsed = legacy sums) and a post-#675 row (all four legacy
   at 0, `imported_count` nonzero); the guard must NOT raise. Pins the disjunction against a
   regression to the naive form, which flags the second row (observed live: both staging rows).

**C. Final-state introspection** (live DB, the migration-100 idiom):

5. `the four legacy gap_*/historical_* counters are absent from zernio_backfill_runs`
   — `information_schema.columns` filtered to the four names → expect length 0. **The failure
   message must name migration 103 and `pnpm test:db:setup`**, so a behind-head local DB reads as
   "DB behind head", not "expected 0 got 4" (intake E4).
6. `imported_count, skipped_count and oldest_skipped_create_time survive the drop with their 100-era shape`
   — the three survivors present; both counters `integer`, `is_nullable='NO'`, `column_default='0'`.
7. `a backfill run INSERT naming only the surviving columns succeeds and defaults both counters to 0`
   — inside `sql().begin` + deliberate rollback, INSERT naming none of the counters,
   `RETURNING imported_count, skipped_count` → both 0. Proves the DROP left the defaults intact.

In `ZernioBackfillWorker.test.ts` — **KEEP** `LEGACY_COUNTER_COLUMNS` (`:218-223`) and both assertion
loops (`:701`, `:1075`), retitled to name 103 as the reason the columns cannot exist. **This reverses
the grilling decision to delete them** (owner-approved 2026-08-08 after plan-review F3/F4). The
suite is mock-`sql` based, so a reintroduced legacy column name is invisible to every other check
and would surface only as a production 42703 — "it would be a hard 42703" is the argument *for* the
guard, not against it, because failing in CI beats failing in production.

9. `ZernioBackfillWorker counters UPDATE never names a migration-103-dropped legacy counter`
10. `ZernioBackfillWorker reactivation INSERT never names a migration-103-dropped legacy counter`

Retarget in the migration-100 suite (correction F6 — its `toHaveLength(7)` asserts the legacy four
are PRESENT and goes red the moment the local DB passes 103; intake E6):

8. `zernio_backfill_runs.imported_count and skipped_count are NOT NULL DEFAULT 0 after the #680 drop of the legacy four`
   — same body, expectation moves 7 → 3, comment rewritten to point at 103 as the owner of absence.

**Expected state after T1** (corrected per F6 — the original claim that tests 1–4 would all be red
was wrong): RED are 1, 2, 3, 4 (no migration file yet), 5 and 8 (columns still present at 102).
Already GREEN are 6 and 7 (the three survivors exist with that shape from migration 100) and 9–10
(retitles of assertions that already pass). That asymmetry is expected and is not a reason to split
the task.

---

### T2 — IMPLEMENT: migration 103

**Blocking edges:** T1.
**Files:** `supabase/migrations/103_drop_legacy_backfill_counters.sql` (new).
**Precedent:** `100_import_consent_and_backfill_counters.sql` (header structure, `SET lock_timeout`,
explicit Rollback paragraph); `101_import_decision_three_valued_check.sql` (preflight-in-header).

Body — exactly three statements, in this order (test 1 pins the list):

1. `SET lock_timeout = '5s';`
2. An **executable fail-closed preflight guard** (`DO $$ … $$`) — owner-approved 2026-08-08 after
   plan-review F2, replacing the originally-locked "manual query documented in the header". It is
   existence-guarded on `gap_processed_count` so the migration stays re-runnable after the DROP, and
   RAISEs with the offending row count when the two-branch predicate finds anything:

   ```sql
   DO $$
   DECLARE unreconciled BIGINT;
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'zernio_backfill_runs'
                      AND column_name = 'gap_processed_count')
     THEN RETURN;                       -- already dropped: nothing to reconcile
     END IF;
     SELECT count(*) INTO unreconciled FROM zernio_backfill_runs
     WHERE NOT (gap_processed_count = 0 AND historical_processed_count = 0
                AND gap_skipped_count = 0 AND historical_skipped_count = 0)
       AND (imported_count <> gap_processed_count + historical_processed_count
         OR skipped_count  <> gap_skipped_count  + historical_skipped_count);
     IF unreconciled > 0 THEN
       RAISE EXCEPTION 'migration 103 preflight: % unreconciled backfill run(s)', unreconciled;
     END IF;
   END $$;
   ```

   **Why executable rather than documented:** a guard that never fires is indistinguishable from a
   working guard on clean data — both report zero abort rows, and both environments are clean today.
   Making it a migration statement removes the operator-must-remember failure mode *and* makes the
   failing branch testable (T1 tests 3–4). The migration cannot apply against unreconciled data.
3. One `ALTER TABLE zernio_backfill_runs` with four `DROP COLUMN IF EXISTS`.

Header must carry, each as a stated decision rather than a bare comment:

- Why the **naive predicate is wrong** — post-#675 rows hold all four legacy counters at 0 while
  `imported_count` is non-zero, so it flags healthy rows (observed: both staging rows flag under it,
  zero under two-branch).
- The soundness argument, **narrowed per plan-review F9**: what is guaranteed is that a *nonzero
  collapsed* value implies nonzero legacy counters, because the pre-#675 worker dual-wrote both sets
  in one UPDATE. The broader "a pre-#675 row with real work but zero legacy counters cannot exist"
  is false — a run interrupted after its review writes but before the final counter UPDATE leaves
  all six counters at 0. Such a row is harmless: `imported_count = 0` means there is nothing to
  reconcile, and it satisfies both branches. State the narrow claim, not the broad one.
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
`docs/superpowers/specs/2026-08-05-consented-review-import-design.md`,
`docs/runbooks/completed_runbooks/zernio-ingestion-test-runbook.md` (surface amendment A1).

- The completed runbook's operator query at `:355-377` selects all four dropped columns and its
  `:361`/`:377` notes explain them; reused after 103 it raises 42703 (plan-review F10). It is a
  *completed* runbook, so do not rewrite its history — annotate the query as superseded by 103 and
  point at `imported_count`/`skipped_count`. This is the repo's own cross-reference rule: ticking a
  checklist item means grepping the filename and fixing every reference in the same change.

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
