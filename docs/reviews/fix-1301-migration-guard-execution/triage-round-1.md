# Review wave round 1 — triage and fix plan

Branch `fix/1301-migration-guard-execution`. Wave dispatched at
`a4becdc44e56030d10384fe7faec17493623b9ab`, fork `07738319c`.

Four axes, all four returned adverse: standards **do-not-approve**,
spec-correctness **8 findings**, red team **OPEN_P0**, adversarial **REVISE**.

Reports in this directory: `spec-correctness.md`,
`standards-maintainability.md`, `adversarial-approach.md`, `red-team.md`.
Red-team sidecar: `docs/reviews/red-team/fix-1301-migration-guard-execution-80b308/findings.{md,json}`.
Finalizer ran clean — 40 process groups reaped, 0 mutations left in the tree.

**Headline measurement: 21 migration mutations run, 14 caught.** Of the seven
survivors, one is a proven-equivalent re-spelling, one is caught by CI on a
re-provisioned container, and **five are genuine blind spots** (RT-2/3/4/5/12).

## One finding REJECTED, with evidence

**Spec-correctness appendix: "this worktree's `.env.local` has been replaced
with a scrubbed 3-line file setting `MOCK_EXTERNAL_APIS=true`; any full-suite
gate evidence from this worktree is unreliable."**

FALSE. Measured at the same HEAD: `.env.local` is 322 lines, 19,694 bytes,
carries every real key, and `TEST_DATABASE_POOL_URL` reads
`postgresql://test:***@localhost:5500/test_1301` — the correct container.
Gate evidence stands. The claim sat in a non-actionable appendix, which is the
only reason it did not land as a blocker.

Its companion claim — three failures in a full `--project integration` run —
is NOT disproved and must be checked on resume. It was not checked during the
wave because the red team was mutating migrations at the time and a concurrent
test run would have corrupted its baseline.

## One finding ALREADY FIXED in this commit

**F-D / provenance.** Nineteen oracle-A citations across seven suites named
`.feature/oracle-a-literals.txt` as the source of every pinned literal, and
`.feature/` is gitignored. After merge no reviewer could verify or regenerate
one. The file is now committed at
`docs/reviews/fix-1301-migration-guard-execution/oracle-a-literals.txt`.
**Remaining work:** update the 19 citations to the tracked path.

---

# Workstream 1 — THE P0. Do this first; it blocks the PR.

**RT-1 / F-A.** `weakened-checks-reasons.md:132` states "What no longer has a
guard anywhere: **Nothing**." That is false, and the head commit message
repeats it.

Proven by surviving mutations:

| Lost assertion | Source | Mutation |
|---|---|---|
| `expires_at TIMESTAMPTZ NOT NULL` | deleted 048 text guard | M17 survived 5/5 |
| `ticket_id TEXT NOT NULL` | deleted 048 text guard | — |
| `reason TEXT NOT NULL` | deleted 048 text guard | — |
| `id UUID PRIMARY KEY` | deleted 048 text guard | — |
| "does not drop or mutate data" | deleted 051 text guard | M18 survived 5/5 |

None appears in the three retired classes I named. The new 048 pins four index
definitions, three FK definitions, the `id` default and RLS — not the column
inventory. 051 and 117 DO pin full column inventories; 048 does not.

**Fix:** correct the document to state exactly what is unguarded, add the 048
column inventory to its oracle A (closing RT-2), and amend the claim in the
arch-review-log. Do not reword the falsehood — replace it with the list.

---

# Workstream 2 — the four catalogue blind spots

All four are gaps in `readPublicCatalogue`. Each was proven by a surviving
mutation, so each fix has a ready-made test.

### RT-5 · views are invisible — the most serious

`readPublicCatalogue` filters `relkind IN ('r','p')`. A migration can add a
view over a deny-all table and grant `SELECT` on it to `anon`. Independently
confirmed in psql at this HEAD:

```
table privilege for anon on analytics_events: false   ← what the guard checks
view privilege for anon on the leak view:      true   ← the real access path
catalogue sees the view (relkind r/p):         0
the view exists (any relkind):                 1
```

This re-opens precisely the boundary migration 049 exists to close.
**Fix:** include `relkind IN ('v','m')` in the catalogue, with their ACLs.
**Test:** `assertOnlyTablesMoved rejects a new view granting select to a client role`.

### RT-3 · off-target DML is invisible

`assertOnlyTablesMoved` compares the catalogue. The catalogue has no rows.
`UPDATE accounts SET display_name = …` appended to migration 051 survived 5/5.
**Fix:** a per-table row digest (count plus a checksum) for tables outside the
moved list, or at minimum a row count. Note the tension: the container is
nearly empty at head, so a count alone is weak — 051's own row-preservation
case seeds a real row for this reason.
**Test:** `assertOnlyTablesMoved rejects an off-target row update`.

### RT-4 · `pg_default_acl` is never read

Appending `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO
anon, authenticated` survived 4/4. This is the **same statement 118's own
degrade uses** — the suite performs it deliberately and cannot detect a
migration performing it.
**Fix:** read `pg_default_acl` into the catalogue.
**Test:** `assertOnlyTablesMoved rejects a widened schema default ACL`.

### RT-2 · no suite pins `impersonation_sessions` column nullability

Covered by workstream 1's fix.

---

# Workstream 3 — the adversarial P1: the rollback licence has a hole

A future migration carrying its own `BEGIN … COMMIT` would **commit** 118's
permissive default ACLs and its table replacement before the rollback sentinel
fires. The plan's §2 "Fact 1" already records that migration **119 carries its
own `BEGIN`/`COMMIT`** — so this is one migration away, not hypothetical.

**Fix options, for the resumed session to weigh:**
1. Refuse to execute a migration whose text contains a transaction-control
   statement, with a named error. Cheap, and `readMigrationSql` is the
   chokepoint — but it is a text check, and text checks are what this branch
   exists to replace.
2. Assert after the rolled-back transaction that the catalogue matches the
   pre-transaction reading. Detects the leak rather than preventing it, and
   costs one extra catalogue read per case.
3. Both.

Option 2 is the honest one: it detects the actual condition rather than
predicting it from the text. Recommend 2, with 1 as a fast pre-check.

---

# Workstream 4 — the vacuity-guard inconsistency

**S-1 / F-F / RT-15.** Four of the seven "moves no other table in public"
cases run the degrade/re-apply cycle without calling `assertDegradeLanded`
(049:196, 053:439, 057:344, 117:595). Three do call it. One plan, three shapes.

**Severity downgraded from HIGH to MEDIUM, with reasoning.** That case's
purpose is detecting off-target damage, which occurs when the migration runs
regardless of whether the degrade landed. The target table's restoration is
guarded by the sibling case, which does call `assertDegradeLanded`. So the
degrade is setup here, not load-bearing.

It is still worth fixing: seven suites should not have three shapes, and a
reader cannot tell a deliberate omission from an oversight.

**Fix:** the standards axis proposed `withDegradeCycle(db, {degrade,
migrationFile, landed}, assertion)` in the harness, taking the DDL as a
suite-written closure. It verified that this stays audit-compatible, because
`unpragmaedDdlLines` is an AST walk over the suite's own text
(`scripts/ci/live-db-suites-audit.ts:527`). That single helper also resolves
S-3's sevenfold registry duplication.

---

# Workstream 5 — harness quality (standards axis)

| ID | Finding | Verdict |
|---|---|---|
| S-2 | `deriveTablePrivileges` + `clientGrantNames` duplicated byte-for-byte in 117 and 118, **including the PG16 privilege-floor vacuity guard**. Two owners of one anti-vacuity check, in the suite family whose failure mode is the vacuous pass. Both are pure reads. | ACCEPT — move to `migration-guard.ts` |
| S-5 | `migration-guard.ts:499-507` is unreachable AND untested: `CatalogueListProperty` excludes every scalar, so `namedEntries` cannot return null there. Will sit permanently uncovered in the report `ci:fallow:coverage` consumes. Root cause: runtime type-sniffing to discriminate a property kind that is statically known from the key. | ACCEPT — replace `TABLE_PROPERTY_SET` with a `satisfies Record<keyof CataloguedTable, PropertyKind>` descriptor; also deletes S-10 |
| S-6 | `'presence'` is not in `keyof CataloguedTable` — it is the table smuggled into the `property` slot, buying a 15-line branch for one caller. | ACCEPT — extract `assertTableRemoved(before, after, table)`; the remaining three variants are minimal |
| S-7 | D12 accepted two `nonEmptyNames` sites together, but they differ: 117's `privileges` is a live `acldefault` read (genuinely runtime, correct); 048's `GUARDED_INDEXES` is `Object.keys` over a four-entry literal six lines above (should be an `as const` tuple). | ACCEPT — fix 048, keep 117, and name 117 in the JSDoc as the reason the seam exists |
| S-4 | Three rationale paragraphs restated 9, 10 and 5 times against "one authoritative owner per fact". 629 header lines, ~36% comment ratio. Failure already realised once (D12's sweep of three stale headers). | ACCEPT — one owner each; the rest of the header volume earns its length |
| S-11 | `withRolledBackTransaction<T>` declares `T`, uses it only in the callback's return type, returns `Promise<void>`. | ACCEPT — `fn: (tx) => Promise<unknown>` |
| S-12 | Naming drift from the parallel build: `SUITE_PATH` vs `SUITE_FILE` (6 others), `withDegradedAndReapplied` vs `degradeAndApply` for one abstraction. | ACCEPT — each costs a grep returning 6 of 7 hits |

---

# Workstream 6 — fragile and self-confirming assertions

| ID | Finding | Verdict |
|---|---|---|
| RT-7 | `expect(columnPrivileges).toHaveLength(4)` restates its own hardcoded literal while its comment claims it "fails loudly" if PostgreSQL adds a fifth. Same pair at `118:406`. Both NEW in this change. | ACCEPT — derive the expected length or drop the claim |
| RT-13 | 118 lacks the before/after grants equality its twin 117 has (`117:652`); `not.toEqual([])` is an absence-of-structure proxy. | ACCEPT |
| RT-14 | 053's "no stray legacy row at head" counts rows in a table the same suite states is empty on a fresh container (`053:591`). | ACCEPT — vacuous as written |
| RT-11 | A weakened migration fails with "run pnpm test:db:setup" because `BEHIND_HEAD` is attached to oracle-A comparisons inside the oracle-B case. Misleading: the container is at head; the migration is wrong. | ACCEPT — separate the two messages |
| RT-12 | 048/051/117 pin no comments; 117's `COMMENT ON TABLE` deletion survived 13/13. 118 pins its comments with an explicit rationale. | ACCEPT — missed sibling case |
| F-B | 118 is nondeterministic: 2 of 8 cases failed once in 21 runs of the shared integration set (~1/46). The `columnComments` literal failed while `columnDefaults` two lines above passed. | ACCEPT — **investigate before merge**; a flaky security guard is not cosmetic |
| RT-17 | Separator JSDoc claims U+0000/U+0001 "cannot occur"; U+0001 can appear in a PostgreSQL comment. | ACCEPT — narrow the claim or pick a safer separator |

---

# Workstream 7 — false and stale documentation claims

Every one is mine.

| ID | Claim | Truth |
|---|---|---|
| RT-8 / F-G | Plan §6 prose says "58 promised titles"; the §6 breakdown sums to 59 | Intake has **60**, all verified present verbatim and once each |
| RT-9 | D8 says "at least fourteen" further text-guard suites and lists twelve | Measured remainder is **twenty**, and the eight missed include `migration-035-rls-policies` — the same RLS class D8 highlights. Repeated into the arch-review-log |
| F-C | Arch-review-log says "201 tests pass together sharing one advisory lock" | Matches no measurement at head: 48 (seven suites), 50 (eight integration files), 236 (all eleven touched files) |
| RT-6 / S-8 | `live-db-suites-audit.ts:148` says 118's degrade is "deny-all RLS off and the client-role privileges granted back" | It is `ALTER DEFAULT PRIVILEGES … GRANT ALL` + `DROP TABLE`, and never disables RLS. Hides the one degrade reaching a schema-level object |
| RT-10 / S-9 | `live-db-suites-audit.ts:142` says "057 degrades the four columns", then lists five | Five. The suite's own title says five |
| F-H | 118's header says "None … every object 118 declares is produced by the executing cases" | The `CREATE TABLE` body is proven there only by the `after == before` comparison the same header calls circular. The independent literals live in `helpers/migration-guard.integration.test.ts:200-261` |
| RT-16 | `docs/superpowers/plans/fix-1176-client-role-grant-sweep-plan.md:130` still states as current that ci.yml pins `postgres:16` | D4's staleness sweep covered five `.ts` files and no plan docs. The live 122 suite header WAS fixed |
| F-E | `schema-ready.ts` adds `MIGRATION_117_ADMIN_AUDIT_LOG` as a third, non-identical definition of a fact already defined identically in two `scripts/ci/__tests__` files | Unrecorded drift, and the 117 suite cites "one authoritative owner per fact" as its reason for the new export. Also: `MIGRATION_051_FLAGGED_RESPONSES` has zero consumers; `MIGRATION_048_…` is used only by the 053 suite, so plan T2's behind-head rationale is delivered for neither |

## What the wave confirmed as sound — do not undo these

- No oracle-A drift: all 19 `readMigrationSql` uses are `tx.unsafe(...)`.
- All 21 `assertDegradeLanded` sites are per-object with full object coverage.
- **No rollback leak**, verified independently outside any transaction across
  40 launches including three that failed mid-transaction under a mutated 118:
  `pg_default_acl` 0 rows throughout, 0 client grants, 0 views, 0 decoy
  schemas, 0 stray rows.
- The seven suites pass as a set, serially, under one shared advisory lock.
- `REVOKE ALL` vs `REVOKE SELECT` caught. A **block-commented** `ENABLE ROW
  LEVEL SECURITY` caught — the evasion class that defeated #1171's regex.
  A widened role allowlist caught by oracle A even without re-provisioning.
- Non-goals honoured: `git diff -- supabase/` empty; nothing under `worker/`;
  every changed file inside the declared surface.
- `migration-guard.ts` passes the deletion test as a deep module. The standards
  axis's complaint is that S-1/S-2/S-3 all want more moved INTO it.
