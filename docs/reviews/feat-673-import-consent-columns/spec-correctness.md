# SPEC & CORRECTNESS review — feat-673-import-consent-columns

Reviewed: `git diff 44e5a62f...HEAD` (6 commits, 11 files) in
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-673-import-consent-columns`.
Inputs read in full: `.feature/intake.json`, the triaged deviations file (D1–D6, all
verdicts recorded), the blast-radius file, and the plan. Verification actually run
during review (not taken on trust): `pnpm ci:tenant-scope` (passed, 420/420),
`pnpm ci:rls-audit` (passed), `pnpm ci:live-db-suites` (passed), `pnpm typecheck`
(clean), eslint on all five changed code files (clean), the worker unit suite +
shape suite with DB asleep (15 passed / 3 skipped), and the shape suite against the
live provisioned test DB (4/4 passed) followed by a leak probe — 0 rows for the
fixture business, 0 `za-shape` backfill rows, 0 non-`pending` `import_decision`
rows left behind.

## Findings table (≥80% confidence)

| severity | file:line | finding |
|---|---|---|
| — | — | NO FINDINGS ≥80% |

## 1. Intake conformance — field by field

**goal** — delivered exactly: migration 100 adds the three `businesses` consent
columns + the two collapsed counters; the worker dual-writes; the allowlist is
re-pinned. Nothing more.

**non_goals** — all six respected. No DROP of the legacy four (migration adds only;
shape test 3 asserts all 7 counter-adjacent columns PRESENT). No consent
readers/writers anywhere in the diff (`import_decision` appears only in the
migration, schema-ready entry, shape suite, and migrations-log). No backfill/
backdating clause (additive-only allowlist test proves the executable SQL contains
only SET/ADD COLUMN/named-CHECK pair/COMMENT). No cross-column CHECK (introspection
probe `pg_constraint ... LIKE '%import_decision_at%'` → 0 rows, verified live). No
index (`indexes: []` in the schema-ready entry; no CREATE INDEX survives the
allowlist). No feature flag.

**user_visible_behavior ("None")** — holds. No `src/app/**`, `src/components/**`,
or API-route file changes; the only production code change is 8 lines inside
`handleZernioBackfill` (`worker/jobs/zernio/ZernioBackfillWorker.ts:255-273`).

**invariants** — all six hold:
1. *Additive-only / 42703 revert-safety*: migration keeps the legacy four; a
   `git revert` of the PR restores the legacy-only UPDATE against columns that
   still exist. Verified the migration contains no DROP COLUMN/ALTER COLUMN.
2. *`import_decision` NOT NULL DEFAULT 'pending' + four-state CHECK*:
   migration lines 47-55; pinned three ways — catalog default `'pending'::text`,
   full-equality `pg_get_constraintdef` literal, and behavioural 23514/23502
   probes (shape suite lines 124-191, all green live).
3. *Dual-write in the SAME statement*: `ZernioBackfillWorker.ts:260-273` —
   `importedCount = gapProcessed + historicalProcessed`,
   `skippedCount = gapSkipped + historicalSkipped`, both interpolated into the
   one counts UPDATE. These are exactly the right variables: `gapProcessed`/
   `historicalProcessed` are the per-bucket success counters incremented in
   `processUnansweredReview` (lines 241-245); `gapSkipped`/`historicalSkipped`
   are the over-cap remainders (lines 201-202).
4. *`oldest_skipped_create_time` untouched*: computation (lines 203-205) and its
   UPDATE position are byte-identical to the pre-diff code; migration does not
   reference it except in a COMMENT literal and the shape suite's presence list.
5. *Immutability bookkeeping*: migrations-log head bumped 099→100 / next 101,
   the 100 entry carries **LOCAL-ONLY**, and every claim in the entry (named
   CHECK, lock_timeout, no RLS/retention change, shape-suite + schema-ready
   names) matches the actual files.
6. *Lockstep promotion*: a process invariant — correctly documented in the log
   entry and the rollback plan; nothing in the diff can violate it pre-promotion.

**edge_cases** — all four handled:
- INSERT branches untouched: worker diff adds zero lines to either branch; the
  worker test asserts INSERT-template absence of `imported_count` (both branches)
  and standalone `skipped_count` (reactivation, D5 regex form); the shape suite's
  rolled-back INSERT probe reads both counters back as 0 from DEFAULT.
- Retry consistency: sums derive from the same in-memory counters in the same
  statement; the reconcile-failure test pins the full dual-write template on the
  path that precedes the throw.
- Tenant-scope byte-match: `pnpm ci:tenant-scope` passes, which is the
  programmatic byte-match proof (audit compares `normalizeSql(stripSqlComments())`
  of snippet vs. call site; `tenant-scope-allowlist.ts:2223` snippet interpolation
  names `${importedCount}`/`${skippedCount}` matching the worker locals exactly).
- CHECK-passes-NULL: paired NOT NULL, and the suite asserts NULL → 23502
  specifically (not 23514).

**tests_to_add** — all five exist and their bodies assert what the titles claim:
1. `businesses.import_decision defaults to 'pending' and rejects values outside the four-state enum` — shape suite:124. Catalog default + full CHECK-def equality + fixture default read + 4 legal (rolled back) + 4 illegal (23514) + NULL (23502).
2. `import_decision_at and import_offer_expires_at are nullable timestamptz with no cross-column constraint` — shape suite:193. Catalog types + constraint-absence introspection + rolled-back behavioural corroboration.
3. `zernio_backfill_runs.imported_count and skipped_count are NOT NULL DEFAULT 0 alongside the four legacy counters` — shape suite:229. 7-column presence pin (legacy PRESENT = §8a R4) + integer/NOT NULL/`0` default + rolled-back INSERT probe.
4. `migration 100 executable SQL is additive-only — no data rewrite, no DROP COLUMN, no ALTER COLUMN, no CREATE INDEX` — shape suite:282, deliberately outside the DB gate. Allowlist-not-denylist over every `;`-split executable statement with exact table→column pinning; fails red when the file is absent (`length > 0` guard).
5. `counters UPDATE dual-writes imported_count and skipped_count as sums of the gap and historical counters` — worker test it.each (two asymmetric fixtures 28/52 and 27/51 → [25,50,3,2,75,5] / [25,50,2,1,75,3], both arithmetic-consistent with GAP_CAP=25/HISTORICAL_CAP=50), plus exactly-one-UPDATE + full-template equality + INSERT-absence loop. Title carries the it.each `(gap=$gapTotal hist=$histTotal)` suffix — see appendix note A1.

**allowed_edit_surface** — zero drift. Changed files: the seven surface entries
(incl. `schema-ready.ts` per accepted D1) plus `docs/superpowers/plans/*` (exempt).
`.feature/intake.json` is byte-identical to the committed docs copy (verified with
`diff`), so D1's "applied to BOTH intake copies" claim holds.

**rollback_plan / observability** — consistent with the shipped code: legacy
columns survive #673, columns are inert without writers (defaults need none), no
down migration (099 precedent). The dual-write proof query in observability matches
the shipped mapping.

## 2. Deviations cross-check (treated as sanctioned amendments)

- **D1/D2** — schema-ready entry + 099-suite template used as stated; no 076-style
  run-time DDL anywhere in the suite.
- **D3** — every strengthening it lists is present (catalog default, full
  constraint-def equality, `pg_constraint` absence probe, integer data_type,
  25/50/3/2 asymmetric fixture, template-structure + INSERT-absence, reconcile-
  failure dual-write assertion).
- **D5** — implemented exactly as triaged: `not.toMatch(/(?<![A-Za-z0-9_])skipped_count/)`
  on the reactivation INSERT (worker test:250) — the regex correctly passes on
  `gap_skipped_count`/`historical_skipped_count` (preceded by `_`) and fails on a
  bare `skipped_count`; the initial-branch checks keep plain `not.toContain` since
  that branch names no counter columns (verified at `ZernioBackfillWorker.ts:82-91`).
- **D6** — the `skipped_count` COMMENT uses the em dash; grep confirms no semicolon
  inside any COMMENT literal, so the `;`-split in shape test 4 is sound (a future
  violation fails safe: the dangling fragment fails the allowlist).

## 3. Migration correctness (100_import_consent_and_backfill_counters.sql)

- `SET lock_timeout = '5s'` — present, 099 precedent (099:49 identical).
- CHECK + NOT NULL pairing — correct, and the checklist trap is documented in the
  header and asserted (23502 probe).
- `DROP CONSTRAINT IF EXISTS` → `ADD CONSTRAINT` idempotency pair — 099's exact
  pattern (099:72,110); makes re-runs safe; both statements are in the shape
  test's allowlist scoped to `businesses` and the exact constraint name.
- Additive-only — only ADD COLUMN IF NOT EXISTS / the named CHECK pair / COMMENTs;
  no index, no backfill UPDATE, no CONCURRENTLY. `NOT NULL DEFAULT` on `businesses`
  is safe: both envs hold zero rows (§8a R3, restated in the header), and on PG11+
  it is a non-rewriting metadata change regardless.
- COMMENT statements target exactly the five new columns.
- migrations-log entry claims are accurate against the file (checked line by line);
  head/next bumped; LOCAL-ONLY marker present; entry placed above 099.

## 4. Worker correctness + blast radius

- Statement order matches the test's positional assertions: legacy four →
  `imported_count` → `skipped_count` → `oldest_skipped_create_time` → `updated_at`
  → `WHERE id`. The updated pinned assertion `[0, 3, 0, 0, 3, 0, null, 'run-1']`
  is consistent (0+3=3, 0+0=0).
- `DUAL_WRITE_TEMPLATE` (8 placeholders) normalizes to exactly the worker's
  template; a reorder, added column, or second counts UPDATE fails the
  `toHaveLength(1)` + equality pin.
- Blast radius: `worker/index.ts:224` registers `(job) => handleZernioBackfill(sql, job)`
  — signature, return type, throw/skip semantics all unchanged; the dual-write is
  invisible to the registration seam. The only other importer is the test file
  itself. No caller reads the counts UPDATE's shape except the tenant-scope audit,
  which passes.

## 5. Test-quality sweep (can-it-fail / state-leak)

- Shape suite: every behavioural write is either inside `sql().begin` with a
  forced `rollback` throw (re-thrown if the error is anything else — a failing
  INSERT/UPDATE inside the tx still fails the test) or a single statement expected
  to be rejected. Live-DB run + post-run probes confirm zero residue. Suite is
  `*.integration.test.ts`, holds `acquireLiveDbLock`, applies no migration SQL,
  and `ci:live-db-suites` passes.
- Additive-only test runs outside the DB gate and fails red without the file —
  confirmed by construction (`expect(executableSql.length).toBeGreaterThan(0)`).
- Worker it.each fixtures are asymmetric and non-zero in all six positions, so a
  swapped sum (`imported` ↔ `skipped`), a legacy-value copy, or a transposed
  positional cannot pass.

## Low-confidence appendix (not findings)

- **A1 — tests_to_add title #5 verbatim-ness.** The it.each name appends
  `(gap=$gapTotal hist=$histTotal)` to the intake's title. The intake string is a
  strict prefix and the parametrized fixture is D3-sanctioned; reading "exists
  verbatim" as "exact-equal" would flag this, but that reading would also forbid
  it.each entirely. Cosmetic at most.
- **A2 — reconcile-failure sum assertions are value-trivial.** In that fixture all
  four counters are 0, so `v[4] === v[0]+v[1]` passes vacuously on values. The
  substantive pin on that path is the `DUAL_WRITE_TEMPLATE` equality (which alone
  proves the failure path uses the dual-writing statement), and the non-zero
  arithmetic is covered by the it.each cases against the same single statement —
  so the invariant is pinned, just not by the arithmetic lines themselves.
- **A3 — `SET lock_timeout` is session-scoped, not `SET LOCAL`.** Identical to
  099's sanctioned form; within Supabase's per-migration execution this is the
  established precedent, noted only for completeness.

## VERDICT

**PASS** — the diff faithfully implements the intake as amended by the six triaged
deviations; no invariant violated, no surface drift, no bug found at ≥80%
confidence in migration, worker, allowlist, or tests.
