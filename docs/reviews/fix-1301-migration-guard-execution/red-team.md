# Red team — `fix/1301-migration-guard-execution`

- **Mode** feature, round 1. **Risk** high (from the intake).
- **Fork / merge-base** `07738319cd5d7a78661ed1e3af07430bd84a8521`
- **Head** `a4becdc44e56030d10384fe7faec17493623b9ab`
- **Intake SHA-256** `d38a7dfe37076711433791c1e0385a1f0da08f2939deb5183d4a147ba5509280`
- **Status** `OPEN_P0` (one P0, eight open P1, eight open P2; six `inconclusive/oracle`
  rows that no valid mutation resolved, which also forces `INCOMPLETE_ORACLE`).
- **Budget** 79s of the 20-minute round clock, 40 of 400 launches.
- **Restoration** every one of the 27 mutated blobs was restored immediately after its
  measurement and re-verified with `git status --porcelain`; the dotenv swap is closed;
  the tracked tree is clean at `a4becdc44e`. The 27 journal entries remain `applied`
  with each target holding its ORIGINAL blob, which is the state the finalizer verifies
  and closes (the invoking agent owns `finalize`).

## Headline

**27 mutations run, 20 killed. Of the 21 mutations applied to the seven migration
files, 14 were CAUGHT by their suite.** Of the seven migration mutations that
survived, one is a proven equivalent (a lexical re-spelling), one survives only
because this worktree's container is not re-provisioned (and is provably caught in
CI), and five are genuine coverage gaps.

The central design claim holds where it was tested. Every weakening the brief named
that the suites claim to guard was caught, including the two the retired text guards
could not have distinguished — `REVOKE ALL` vs `REVOKE SELECT` (M13) and an
`ENABLE ROW LEVEL SECURITY` statement wrapped in a block comment so the file still
contains the exact string the old regex matched (M03). The oracle-A literals are not
decorative: M07 (a widened role allowlist) was caught **on this un-reprovisioned
container**, because the pinned literal is compared against the re-applied constraint
rather than against `before`. And the helper's own suite is real: making
`assertDegradeLanded` skip its survivor check, making `assertOnlyTablesMoved` always
return, and making `withRolledBackTransaction` swallow a callback error all failed
their tests (M25–M27).

What the pass disproves is narrower and specific: the change's own claim that
**nothing** lost a guard, and the reach of its off-target check.

## Findings

| Severity | file:line | Finding | Mutation result |
|---|---|---|---|
| **P0** | `docs/reviews/fix-1301-migration-guard-execution/weakened-checks-reasons.md:132` | RT-1 — "What no longer has a guard anywhere: **Nothing**" is false. At least four assertions from the deleted suites have neither a successor case nor a retired-class entry. The head commit message repeats it. | M17, M18 survived |
| P1 | `src/lib/shared/__tests__/migration-048-impersonation-sessions.integration.test.ts:98` | RT-2 — lost coverage: nothing asserts `impersonation_sessions` column nullability, so loosening `expires_at NOT NULL` passes every gate. 051 and 117 pin full column inventories; 048 does not. | M17 survived 5/5 |
| P1 | `src/lib/shared/__tests__/helpers/migration-guard.ts:548` | RT-3 — lost coverage: off-target DML. `assertOnlyTablesMoved` compares the catalogue only; an unrelated `UPDATE`/`DELETE` appended to any of the seven passes. | M18 survived 5/5 |
| P1 | `src/lib/shared/__tests__/helpers/migration-guard.ts:245` | RT-4 — blind spot: `pg_default_acl` is never read, so appending `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO anon, authenticated` passes — the same statement 118's own degrade uses. | M19 survived 4/4 |
| P1 | `src/lib/shared/__tests__/helpers/migration-guard.ts:254` | RT-5 — blind spot: `relkind IN ('r','p')` excludes views. A view over a deny-all table plus a client GRANT re-opens the RLS boundary with every suite green; the bypass is measured. | M20 survived 4/4 |
| P1 | `scripts/ci/live-db-suites-audit.ts:148` | RT-6 — production comment describes 118's degrade as "deny-all RLS off and the client-role privileges … granted back". It is neither, and it hides the one degrade that touches a schema-level object. | static |
| P1 | `src/lib/shared/__tests__/migration-117-admin-audit-log.integration.test.ts:470` | RT-7 — `expect(columnPrivileges).toHaveLength(4)` restates its own hardcoded literal; the comment claims it fails if PostgreSQL adds a fifth privilege. Same pair at `migration-118-…:406`. Both new in this change. | static |
| P1 | `docs/superpowers/plans/fix-1301-migration-guard-execution-plan.md:915` | RT-8 — three inconsistent promised-title counts: intake 60, §6 prose 58, §6 breakdown sums to 59. (All 60 titles ARE present verbatim, once each.) | measured |
| P1 | `docs/superpowers/plans/fix-1301-migration-guard-execution-deviations.md:265` | RT-9 — D8 says "at least fourteen" and lists twelve; the measured remainder is twenty, and the eight it missed include `migration-035-rls-policies`. Repeated into `arch-review-log.md`. | measured |
| P2 | `scripts/ci/live-db-suites-audit.ts:142` | RT-10 — says 057 degrades "the four columns" and lists five. | static |
| P2 | `src/lib/shared/__tests__/migration-048-impersonation-sessions.integration.test.ts:241` | RT-11 — a weakened migration fails with "run pnpm test:db:setup". The `BEHIND_HEAD` remediation string is attached to oracle-A comparisons inside the oracle-B executing case. | observed on M01 |
| P2 | `src/lib/shared/__tests__/migration-117-admin-audit-log.integration.test.ts:371` | RT-12 — missed sibling: 118 pins its comments with an explicit rationale; 048, 051 and 117 pin none. | M21 survived 13/13 |
| P2 | `src/lib/shared/__tests__/migration-118-poller-heartbeats.integration.test.ts:574` | RT-13 — 118's challenged-REVOKE case lacks the before/after grants equality 117's twin carries; `not.toEqual([])` is an absence-of-structure proxy. | static |
| P2 | `src/lib/shared/__tests__/migration-053-users-role-constraint.integration.test.ts:360` | RT-14 — "no stray legacy row survives at head" counts rows in a table the same suite states is empty on a fresh container. | static |
| P2 | `src/lib/shared/__tests__/migration-118-poller-heartbeats.integration.test.ts:498` | RT-15 — title 6 claims its off-target check also proves `ALTER DEFAULT PRIVILEGES` perturbs nothing; with no degrade-landed assertion for that statement it passes identically if the statement did nothing. | static |
| P2 | `docs/superpowers/plans/fix-1176-client-role-grant-sweep-plan.md:130` | RT-16 — D4's staleness sweep covered five `.ts` files and no docs; a plan still states as current that ci.yml pins `postgres:16`. The live 122 suite header WAS fixed. | static |
| P2 | `src/lib/shared/__tests__/helpers/migration-guard.ts:150` | RT-17 — the separator JSDoc claims U+0000 and U+0001 "cannot occur"; U+0001 can appear in a PostgreSQL text comment. | static |

Full arbiter reasoning per finding is in `findings.json`.

## Duty 1 — hand mutation

### The migrations (21 mutations, 14 caught)

The red-team skill normally EXCLUDES `supabase/migrations/` from the inventory
because "the database is provisioned before the run, so mutating a migration changes
nothing under test". This change is what invalidates that exclusion, and the seven
suites are the first in the repo where a migration mutation is a live measurement.
All 21 were journaled, measured and restored.

Caught (14): M01 048 partial predicate · M02 049 ENABLE RLS deleted · M03 049 ENABLE
RLS block-commented · M05 051 partial predicate · M07 053 allowlist widened to
`sales_partner` · M08 053 `UPDATE` deleted · M09 053 `n.nspname` filter dropped ·
M10 053 `t.relname` filter dropped · M11 057 one `ALTER COLUMN` clause deleted ·
M12 057 sixth clause loosening `actor_user_id` added · M13 117 `REVOKE ALL` →
`REVOKE SELECT` · M14 118 `REVOKE` deleted · M15 118 `COMMENT ON COLUMN` deleted ·
M16 118 `DEFAULT NOW()` deleted.

Not caught (7):

- **M04** — `ENABLE/**/ROW\n LEVEL\n SECURITY`. Proven `equivalent`: a block comment
  and newlines are whitespace to the SQL lexer, the statement parses identically, and
  the suite's own catalogue diff measured the result as equal. Passing this is the
  point — lexical form no longer decides anything.
- **M06** — 051's inline `status` CHECK deleted. `inconclusive/oracle`. The
  `CREATE TABLE IF NOT EXISTS` body is skipped at head, which 051's stated-limits
  header declares. I was instructed not to re-provision the shared container, so I
  measured the equivalent inside a rolled-back transaction: `DROP TABLE
  flagged_responses CASCADE` then applying the mutant leaves only the `source` and
  `severity` CHECKs, so the oracle-A literal at `migration-051-…:251-254` resolves to
  `undefined` and title 2 fails. CI re-provisions (`.github/actions/test-db` →
  `scripts/test-db-setup.sh`), so the mutant dies there. Recorded as inconclusive
  rather than killed because no vitest launch in this environment killed it.
- **M17, M18, M19, M20, M21** — confirmed survivors, each with its finding above.
  Recorded as `inconclusive/oracle` rather than `survived-confirmed-P0` because the
  sidecar schema reserves that outcome for a P0 finding, and each of these is a claim
  about a MISSING ORACLE rather than about a fake test.

### The changed production surface (4 rows, 3 mutations, 3 caught)

`ci.yml` reverted to `postgres:16` (M22) fails both new wiring cases;
`e2e-local-setup.md` reverted (M23) fails the local-setup case; removing the 049 entry
from `MIGRATION_SHAPE_FILES` (M24) fails that suite's registry case, which confirms
the registry cases really measure the audit's effect rather than reading the private
Set. `vitest.config.ts` is `excluded` — comment-only.

### The changed test surface (3 mutations, 3 caught)

A helper change can neutralise every assertion without touching a test body, so the
three load-bearing functions in `migration-guard.ts` were mutated directly. Disabling
the `absent` survivor check (M25), making `assertOnlyTablesMoved` always return (M26)
and making `withRolledBackTransaction` swallow a non-sentinel callback error (M27) each
failed. The third matters most: the helper's own header calls that re-throw
load-bearing because a swallowing wrapper "would turn every failing executing case in
six suites into a pass". That claim is now measured.

## Duty 2 — the vacuous pass and fragile assertions

**Selector-list completeness — no gap found.** All thirteen `assertDegradeLanded` call
sites were checked against the SQL their degrade actually runs. Every list names every
object the degrade removes or adds: 048 names all four indexes (`nonEmptyNames`
narrowing `Object.keys`) plus the boolean `rowSecurity`; 051 names both indexes plus
`rowSecurity`; 053 names `users_role_check`, and its decoy cases additionally name the
planted constraint with reversed polarity; 057 makes three `present` calls covering all
five reinstated columns; 117 names both indexes, `rowSecurity`, and all sixteen derived
client grants; 118 uses the table-removal `presence` form, the only form that survives
a total degrade. `assertDegradeLanded` cannot be satisfied while a guarded object
survives: names are matched exactly, both directions are checked, and the
property-differs check runs first.

Fragile or self-satisfying assertions found: RT-7 (a literal asserting its own length,
with a comment claiming otherwise), RT-13 (`not.toEqual([])` as a proxy for "the
owner's grants survive"), RT-14 (a count over a table the suite states is empty),
RT-15 (an off-target check credited with proving a statement it never challenges),
RT-17 (a stated impossibility that is not impossible).

**Deparse coupling is already dispositioned.** The pinned literals are
`pg_get_indexdef` / `pg_get_constraintdef` output, so a PostgreSQL major that changes
deparse breaks them for a reason unrelated to the guarded property. Deviation D7
accepts this deliberately; no new finding.

## Duty 3 — docs vs reality

`prevalidate-plan.py` was available and run against all four changed docs: plan,
deviations and `weakened-checks-reasons.md` are **PASS**. The handoff reports two
"stale commits" — `01a0bda7` and `298827ad35d0` — which are fragments of the Codex
session UUID `01a0bda7-0982-7773-8164-298827ad35d0`; a false positive, not a finding.

Claims re-derived against HEAD:

| Claim | Verdict |
|---|---|
| 201 tests pass together | **TRUE.** 201/201 across the eleven changed test files (the seven suites, 122, both helper suites, `ci-audit-wiring`). The seven suites alone are 48. |
| 60 promised titles present verbatim | **TRUE.** All 60 intake `tests_to_add` entries found exactly once across 1204 test files. |
| Production diff 50 lines | **TRUE.** 45 insertions, 5 deletions across `ci.yml`, `e2e.yml`, `live-db-suites-audit.ts`, `vitest.config.ts`. |
| `ci:weakened-checks` passes with 10 REVIEW rows | **TRUE**, re-run at HEAD. |
| Run recorded at `5dbda4d56` | Resolves, and is HEAD's parent. The head commit adds only docs, the intake and 053's header paragraph, so the evidence is not materially stale. |
| Weakened-checks: "Nothing" no longer has a guard | **FALSE — RT-1.** |
| Plan §6: 58 promised titles | **FALSE — RT-8.** |
| D8 / arch-review-log: fourteen further suites | **UNDERSTATED AND SELF-INCONSISTENT — RT-9.** |
| 118's degrade per the CI audit comment | **FALSE — RT-6.** |
| 057 degrades "the four columns" | **FALSE — RT-10.** |
| Container byte-identical afterwards; no stray default ACLs, rows or schema | **TRUE**, independently verified — see Duty 5. |
| "118 had no suite at all" | **TRUE.** No 118 test file exists at the merge-base. |
| The helper runs no DDL and holds no lock | **TRUE.** Only `SELECT`s and one `db.begin`; `helpers/migration-guard.integration.test.ts` executes no DDL either. |
| 117: seven pre-#1301 cases preserved unchanged | **TRUE.** The merge-base file had 8 cases; the one retired text case is documented, 7 remain, 6 are new, 13 total. |

## Duty 4 and 6 — missed sibling cases

Searched: every `.test.ts` that reads a `supabase/migrations` path and text-matches
(43 files), and the seven suites against each other, property by property. Exclusions
recorded: Playwright/E2E specs, and suites whose migrations are outside #1301's list
except where D8 already names them.

- **RT-2** — 048 is the only `CREATE TABLE` suite of the three that does not pin its
  column inventory.
- **RT-12** — 118 is the only suite that pins its comments, with a rationale that
  applies verbatim to 048, 051 and 117.
- **RT-13** — 117's challenged-REVOKE case ends with a grants equality; 118's does not.
- **RT-9** — twenty text-guard migration suites remain, eight of them unnamed by D8,
  including a second RLS-policy suite.
- **No sibling gap found** for: the `presence` degrade form, the `nonEmptyNames`
  narrowing, the `max: 1` pooling rationale, the `SET CONSTRAINTS ALL IMMEDIATE`
  deferred-FK handling, or the registry case shape — all seven are consistent.
- `migration-117-…:516-519` uses `toContain` on index definitions where 048, 051 and
  118 pin exact `pg_get_indexdef` strings. Not filed: 117's degrade drops both indexes,
  so oracle B's whole-table equality covers the definitions on a re-apply, and M13
  confirms that path is live.

## Duty 5 — operational completeness

No Sentry signal, alert rule or runbook row is in this diff — it is test code plus four
CI-config lines — so the alert-path comparison is out of scope, recorded rather than
skipped.

**Attack on 118's `ALTER DEFAULT PRIVILEGES` degrade: no leak.** This was the
highest-risk statement in the change and it is clean.

- `pg_default_acl` read OUTSIDE any transaction, before and after the whole pass —
  including 4 launches that executed the statement and 3 that failed mid-transaction
  under a mutated 118 — returns **0 rows** every time.
- 0 tables in `public` carry `anon` or `authenticated` in `relacl`; 0 views; 0 `decoy_%`
  schemas; 0 stray `users` rows from 053's fixtures; the `flagged_responses` status
  CHECK is intact.
- 118's title 7 asserts the rollback on every run rather than trusting one measurement
  (`readDefaultTableAcl` before and after, outside the transaction).
- The permissive window cannot be observed by a concurrent `CREATE TABLE`:
  `vitest.config.ts:104` sets `fileParallelism: false` on the `integration` project,
  and `groupOrder` keeps the `parallel` project from overlapping it.
- All nine live-DB migration suites, 119 and 122 included, are green at the end of the
  pass (61/61).

**Behind-head actionability — partly true, and RT-11 is the inverse failure.** 053, 057
and 118 call `assertSchemaReady`, which names `pnpm test:db:setup`. 048, 049, 051 and
117 do not, by design; their oracle-A cases carry the `BEHIND_HEAD` message, so a
behind-head container does produce at least one named, actionable failure per file
rather than only an undefined-object crash — though their oracle-B cases would
additionally crash with a bare `42704 index does not exist`. The real defect runs the
other way: RT-11, where a weakened migration file produces a message telling the
operator to re-provision.

## Authorizations

None. No finding is `accepted-risk`.

## What blocks

RT-1 is a P0 and blocks the PR: the document written specifically to answer
`ci:weakened-checks`'s "where did its coverage go?" closes by saying nothing lost a
guard, and two mutations prove otherwise. It is cheap to fix honestly — either name
the four unaccounted assertions under the retired-classes section with a reason, or
add the two missing oracle-A pins (048's column inventory, and a no-DML ban or a row
assertion for the off-target class).

Eight P1s are open on a high-risk run, so the checker requires user adjudication
rather than the invoking agent's. RT-4 and RT-5 are the two I would not defer: they
are the off-target class that #1171 was about, they are both cheap to close
(`readPublicCatalogue` already has a `readDefaultTableAcl` sibling in the 118 suite,
and widening `relkind` is one array literal), and RT-5 is measured to re-open the
exact boundary migration 049 exists to establish.
