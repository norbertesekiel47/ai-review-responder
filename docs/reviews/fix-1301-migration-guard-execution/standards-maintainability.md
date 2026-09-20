# Review — Standards and Maintainability

**Axis:** standards and maintainability. Read-only review.
**Skill:** `thermo-nuclear-code-quality-review` — **invoked and followed**. Its
approval bar, escalation list and ambition rule ("look for the code-judo move
that deletes complexity rather than rearranging it") are the criteria applied
below. No fallback was needed.

**Fork (frozen):** merge-base `07738319cd5d7a78661ed1e3af07430bd84a8521` →
head `a4becdc44e56030d10384fe7faec17493623b9ab`.

**Why this axis ran at all.** The measured **production diff is 50 lines**
across four files — `scripts/ci/live-db-suites-audit.ts` (+44, seven allowlist
entries and their comments), `.github/workflows/ci.yml` (+2),
`.github/workflows/e2e.yml` (+2), `vitest.config.ts` (+2, one comment). That is
far below the threshold at which this axis normally runs. It ran because the
change is classified **RISK = high**: the ~4,600 lines of test diff are
security controls whose failure mode is a control that passes vacuously, so the
test code is judged as production code throughout.

**Scope read:** the helper (`migration-guard.ts`, 619 lines) and both of its
test files; all seven migration guard suites; the pattern they copy
(`migration-119-job-outbox-rls.integration.test.ts`); the audit script's DDL and
lock rules; plan §3–§5 and deviations D5, D9, D12.

---

## Verdict

**Do not approve as-is.** No structural regression, no file pushed past 1,000
lines (largest is 117 at 713), no spaghetti growth in existing flows, no `any`,
no silent catch, no production import of a test helper, no architecture-boundary
leak. The helper is a genuinely deep module.

Two findings block: a security control that four of seven suites can pass
vacuously because the same three-step proof was inlined four different ways
(**S-1**), and a nontrivial privilege-derivation helper copy-pasted between two
suites along with its own vacuity floor (**S-2**). Both are the predictable
residue of six parallel agents building from one plan, and both have a single
fix that also deletes code.

---

## Findings

Only findings held at 80%+ confidence. Speculative preferences are in the
appendix and are marked as such.

### S-1 — HIGH — the noninterference case omits the degrade-landed proof in four of seven suites, and the plan's one pattern shipped as three

**Where:**
- `src/lib/shared/__tests__/migration-049-analytics-events-rls.integration.test.ts:196-209`
- `src/lib/shared/__tests__/migration-053-users-role-constraint.integration.test.ts:439-452`
- `src/lib/shared/__tests__/migration-057-account-offboarding-tombstone-nullability.integration.test.ts:344-357`
- `src/lib/shared/__tests__/migration-117-admin-audit-log.integration.test.ts:595-609`

Each of these four cases runs the full oracle-B cycle — read BEFORE, degrade,
re-apply verbatim, read AFTER — and then asserts only
`assertOnlyTablesMoved(before, after, [TABLE])`. It never calls
`assertDegradeLanded`.

`assertOnlyTablesMoved` asserts that nothing *changed*. If the degrade stops
landing — the migration is edited so the object the degrade targets no longer
exists under that name, a `DROP INDEX` becomes a no-op, the RLS flip is already
in the state the degrade sets — then `before` and `after` are trivially equal
and the case passes while proving nothing. That is exactly contract 1 of the
three the module's own JSDoc records as rejected
(`helpers/migration-guard.ts:112-120`), reintroduced by omission in the second
case of four suites.

Three of the seven got this right, in three different ways:

| Suite | Shape |
|---|---|
| 048 | local `withDegradedAndReapplied(assertion)` — `migration-048…:149-172`; both `assertDegradeLanded` calls inside the helper, so neither case can omit them |
| 051 | local `degradeAndApply(assertion)` — same idea, different name |
| 118 | inlined, and correctly repeats `assertDegradeLanded` in the noninterference case (`migration-118…:496`) |
| 049, 053, 057, 117 | inlined, degrade-landed proof present in the restore case and **absent** in the noninterference case |

Plan §3 specifies one pattern. What shipped is three shapes and two names for
the same local helper. The maintenance cost is not stylistic: the guarantee now
depends on whether the suite's author happened to extract a helper, and the next
suite added to this family will copy whichever neighbour it opens first.

**The code-judo move.** Put the sequencing in the harness, keep the DDL in the
suite. `migration-guard.ts` gains one function:

```ts
export async function withDegradeCycle(
  db: Sql,
  spec: {
    degrade: (tx: TransactionSql) => Promise<void>;
    migrationFile: string;
    landed: readonly DegradeTarget[];   // required, non-empty
  },
  assertion: (before: PublicCatalogue, after: PublicCatalogue) => void,
): Promise<void>
```

The suite passes a closure whose body is its own `tx.unsafe('DROP INDEX …')`.
`assertDegradeLanded` then runs on every listed target on every call and cannot
be forgotten; the seven suites lose ~25 lines each plus two local helper
definitions, and the three shapes collapse to one.

**This is compatible with the audit, and I checked rather than assumed.**
`scripts/ci/live-db-suites-audit.ts:527` derives DDL findings from
`unpragmaedDdlLines(source)` — a TypeScript AST walk over **the file's own
text**. A `tx.unsafe('DROP INDEX …')` written inside a closure in the suite is
still a DDL line in the suite, so `MIGRATION_SHAPE_FILES` membership stays
necessary and the `SHARED_LOCK_MARKER` check (line 546, `text.includes`) stays
truthful. Plan §"Why the harness executes no DDL" is satisfied by this shape,
not violated by it: the harness still executes no DDL of its own.

By contrast, the `postgres()` / `acquireLiveDbLock` / `afterAll` lifecycle
**cannot** be extracted under the current audit — `SHARED_LOCK_MARKER` is the
literal string `acquireLiveDbLock` matched against the suite's own text
(`live-db-suites-audit.ts:242,546`), so moving the lock call into a helper would
make all seven suites report `unlocked-ddl`. That duplication is a constraint,
not a defect, and this review does not ask for it. (Note the blocks are not
actually identical anyway — 053, 057, 117 and 118 each add seeding.)

### S-2 — HIGH — `deriveTablePrivileges` and `clientGrantNames` are copy-pasted between 117 and 118, vacuity floor included

**Where:** `migration-117-admin-audit-log.integration.test.ts:188-222` and
`migration-118-poller-heartbeats.integration.test.ts:184-222`.

The two bodies are identical modulo comment wording (diffed). Both derive the
table-privilege set from `acldefault` rather than spelling it, because
PostgreSQL 16 defines seven and 17 defines eight, and both carry the same
"fails LOUD rather than open… Seven is the PostgreSQL 16 floor" guard — the
check that stops every downstream "grants none of them" assertion passing
vacuously on an empty list.

That guard is now duplicated. A future fix to one copy leaves the other
silently weaker, in a family of suites whose stated recurring failure mode is
precisely the vacuous pass. Both functions are pure reads plus one SELECT — they
sit squarely inside `migration-guard.ts`'s stated boundary (reads, compares,
wraps; no DDL, no lock) and belong there. `clientGrantNames` additionally needs
its `CLIENT_ROLES` constant to have one owner.

### S-3 — MEDIUM — the registry case is seven identical copies with seven independently-worded comments

**Where:** `migration-048…:177-194`, `049:91-106`, `051:124-139`,
`053:287-301`, `057:213-228`, `117:234-260`, `118:246-261`.

Every copy is the same two lines:

```ts
const ownSourceText = readFileSync(join(process.cwd(), SUITE_FILE), 'utf8');
expect(auditLiveDbFile(SUITE_FILE, ownSourceText)).toEqual([]);
```

wrapped in a 9–25-line comment that explains the same thing seven times in
seven different phrasings. One exported `expectLiveDbAuditClean(suiteFile)` in
`migration-guard.ts` (a read and a compare — inside the boundary) deletes about
12 lines per suite and gives the explanation one home. This is the single
cheapest duplication removal in the branch.

### S-4 — MEDIUM — three paragraphs of rationale are restated eight to ten times, against this project's own one-owner rule

Measured header sizes (lines before the first `import`) and comment ratios:

| Suite | Header | Total | Comment lines |
|---|---|---|---|
| 049 | 51 | 211 | 93 (44%) |
| 048 | 61 | 283 | 91 |
| 051 | 69 | 403 | 126 |
| 057 | 92 | 360 | 147 |
| 118 | 113 | 621 | 253 (41%) |
| 053 | 118 | 644 | 226 |
| 117 | 125 | 713 | 236 |

629 header lines across seven files; ~36% of the suite diff is comment. Long
headers are a deliberate convention here (119 is the precedent) and most of each
header **does** earn its length: the per-migration history, what that
migration's degrade may and may not touch, and the stated limits are facts with
exactly one home.

Three paragraphs do not, and these are the specific ones:

1. **The #1171 red-team narrative** — "five red-team passes… `CREATE\nPOLICY`
   split across a newline, then `DISABLE/**/ROW LEVEL SECURITY`, then `--`
   inside a string literal, then a comment standing in as evidence… PostgreSQL
   is the parser now." Present in **all eight** suite headers **and** in
   `helpers/migration-guard.ts:5-12`. Nine copies of one paragraph. The helper
   header is its correct owner; each suite needs a one-line pointer.
2. **"A migration may harden the one table it names while doing arbitrary damage
   elsewhere (119's `GRANT ALL ON admin_audit_log TO anon`)"** — ten occurrences
   across seven suites, plus `assertOnlyTablesMoved`'s JSDoc
   (`migration-guard.ts:541-547`), which already states it. Every one of these
   sits immediately above a call to that function, so the JSDoc is already on
   screen in any editor.
3. **The boolean-variant explanation** ("`rowSecurity` is a BOOLEAN property, no
   `absent`/`present` list applies, the value comparison IS the proof") — five
   copies, plus `DegradeTarget`'s JSDoc (`migration-guard.ts:104-109`), which
   again already states it. `049:179-183` and `049:39-42` say it twice inside
   one file.

CLAUDE.md's lab-notes rule is explicit: *one authoritative owner per fact*. Nine
copies of a paragraph is nine places to update when the story changes, and the
branch already demonstrates the cost — deviation D12 records a sweep of *three*
suite headers that still documented the retired `absent: []` convention after
the type had made it a compile error. That is this finding's failure mode,
already realized once during execution.

### S-5 — MEDIUM — one invariant, three guards, two of them unreachable and one untested

**Where:** `helpers/migration-guard.ts:137-146` (`nonEmptyNames` throw),
`:470-476` (`selectors.length === 0`), `:499-507` (`namedEntries` returns null).

The non-empty selector invariant is enforced by the `NamedObjects` tuple type
*and* by two runtime throws. The type-level half is well tested — the
`@ts-expect-error` case at `helpers/migration-guard.test.ts:209-235` is a good
assertion and I would keep it exactly as written.

The third guard at `:499-507` is different. `DegradeTarget`'s list variants are
typed `property: CatalogueListProperty`, which `Exclude`s `table`, `comment`,
`rowSecurity` and `forceRowSecurity` (`:84-87`) — every scalar. So
`namedEntries` can never return null on that path, the 9-line error message
about "a scalar property cannot be selected on by name" is unreachable, and
`migration-guard.test.ts` has no case for it (16 cases; none covers it). It is
dead code that will sit permanently uncovered in the coverage report that
`ci:fallow:coverage` consumes.

**The move that deletes it.** `renderValue` (`:411-419`) and `namedEntries`
(`:422-425`) both discriminate the property *kind* by sniffing the runtime type
of the value (`typeof === 'boolean'`, `=== null`, `typeof === 'string'`), even
though the kind is statically determined by the key. The skill's own escalation
list calls this out: a generic mechanism hiding a simple data-shape assumption.
Replace `TABLE_PROPERTY_SET` (`:159-172`) with a kind descriptor —

```ts
const TABLE_PROPERTIES = {
  table: 'scalar', comment: 'scalar',
  rowSecurity: 'flag', forceRowSecurity: 'flag',
  notNullColumns: 'names',
  policies: 'entries', columns: 'entries', columnDefaults: 'entries',
  columnComments: 'entries', indexes: 'entries', constraints: 'entries',
  grants: 'entries',
} as const satisfies Record<keyof CataloguedTable, PropertyKind>;
```

— and both functions dispatch on the declared kind, the `satisfies`
exhaustiveness guarantee is preserved, the `:499-507` branch disappears, and
`renderValue`'s sentinel collisions (appendix A-3) go with it.

### S-6 — MEDIUM — `presence` is not a property of the table; it is the table, and smuggling it into `property` costs a union variant and a branch

**Where:** `helpers/migration-guard.ts:122-126` (variant 1) and `:445-459` (the
early-return branch).

Question 4 asked whether `DegradeTarget`'s four variants are the right shape.
Three of them are: `presence`, selector-free booleans, `absent`, `present`.
Variants 2–4 are minimal and D9's reasoning for splitting the booleans out is
correct — collapsing them would reintroduce the `absent: []` placeholder that
made the weak contract writable, and D12 proves that hole was real (`TS2578`
before the tightening, consumed after).

Variant 1 is the odd one. `'presence'` is not a member of
`keyof CataloguedTable`; it is a synthetic value in the `property` slot standing
for "the table itself". It buys a 15-line branch inside `assertDegradeLanded`
that returns before any of the function's actual work, and it has exactly one
caller (118, three call sites). A separate
`assertTableRemoved(before, after, table)` deletes the union variant *and* the
branch, and reads better at the call site than
`{ table: TABLE, property: 'presence' }`. The remaining union is three variants
with one uniform meaning: "this named property moved, and here is every object
that moved in it."

**Answer to question 4: the shape has not accreted variants — it has one
variant that is not a property.** Extract it and the union is right.

### S-7 — MEDIUM — D12's acceptance is right for 117 and wrong for 048

Question 6 asked whether the two runtime-checked sites should be typed non-empty
at their definitions. They should be judged separately, which D12 does not do.

- **117 — keep the runtime check.** `clientGrantNames(privileges)`
  (`117:217-219`) maps over `privileges`, which comes from
  `deriveTablePrivileges`, a live read of `acldefault` off the connected server
  (`117:194`). The length is genuinely unknown until runtime — seven on
  PostgreSQL 16, eight on 17. No static tuple can express it, and
  `nonEmptyNames` is the correct tool. D12's acceptance is right here.
- **048 — type it statically.** `GUARDED_INDEXES` is
  `Object.keys(GUARDED_INDEX_DEFINITIONS)` (`048:110`) over a four-entry object
  literal declared six lines above it (`048:99-109`). `Object.keys` throws the
  literal type away and `nonEmptyNames` (`048:163`) buys it back at runtime.
  Declaring the names as an `as const` tuple and typing the definitions map as
  `Record<(typeof GUARDED_INDEXES)[number], string>` makes the list statically
  non-empty with no duplicated name list, and turns a runtime check into a
  compile-time one. That is the direction every other decision in this branch
  went; D12 stopped one site short.

One knock-on: after that change `nonEmptyNames` has a single caller. It is still
worth keeping as an exported checked narrowing — it is the documented seam for
the genuinely-runtime case and the next 117-shaped suite will need it — but it
is worth noting against the project's "no abstractions for a single caller"
rule, and the module JSDoc should say that 117's shape is the reason it exists.

### S-8 — LOW — the production diff ships a comment describing a degrade the suite does not perform

**Where:** `scripts/ci/live-db-suites-audit.ts:176-177`.

The added allowlist comment reads *"118 degrades poller_heartbeats: deny-all RLS
off and the client-role privileges the migration revokes granted back."* The
suite's actual degrade (`migration-118…:225-231`) is
`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon,
authenticated;` followed by `DROP TABLE poller_heartbeats;`, and the assertion
is `{ table: TABLE, property: 'presence' }` — the total-removal form that plan
§3 singles out as 118's distinguishing feature. It never disables RLS. This is
one of only 44 added production lines and it describes the wrong mechanism, in
the file whose comments are the allowlist's justification of record.

### S-9 — LOW — off-by-one in the 057 allowlist comment, contradicted by the suite's own case title

**Where:** `scripts/ci/live-db-suites-audit.ts:169`.

*"057 degrades the four columns the OTHER way"*, and then names five:
`account_offboardings.zernio_account_ids`, `zernio_profile_ids`,
`approval_audit_log.response_id`, `impersonation_sessions.account_id`,
`impersonated_user_id`. Plan §3's table lists five and the suite's own case
title is *"the five tombstone columns are nullable at head"*
(`migration-057…:272`). Production comment, wrong count.

### S-10 — LOW — an identity `.filter` with an always-true type predicate, dressed as a check

**Where:** `helpers/migration-guard.ts:174-176`.

```ts
const TABLE_PROPERTIES: readonly (keyof CataloguedTable)[] = Object.keys(
  TABLE_PROPERTY_SET,
).filter((key): key is keyof CataloguedTable => key in TABLE_PROPERTY_SET);
```

`key in TABLE_PROPERTY_SET` is true for every key `Object.keys` just returned,
so the filter removes nothing. It is a cast wearing a guard's clothes, and a
reader has to prove it is a no-op before they can move on. The descriptor
refactor in S-5 removes it; failing that, one honest
`as readonly (keyof CataloguedTable)[]` with a one-line comment is more direct
and no less safe.

### S-11 — LOW — `withRolledBackTransaction<T>` declares a type parameter it discards

**Where:** `helpers/migration-guard.ts:594-597`. `T` appears only in the
callback's return type and the function returns `Promise<void>`, so
`fn: (tx: TransactionSql) => Promise<unknown>` is the identical contract with
one less moving part. The phantom generic invites a caller to expect the
callback's value back; it is silently dropped.

### S-12 — LOW — naming drift between suites built in parallel

- `SUITE_PATH` (`048:88`) vs `SUITE_FILE` (the other six).
- `describe('migration 048 registry')` (`048:177`) vs `'… registries'` in the
  other six — six of them plural for a single case.
- `withDegradedAndReapplied` (048) vs `degradeAndApply` (051) for the same
  local abstraction (subsumed by S-1's fix).

Individually trivial; together they are the tell that seven files were written
in parallel without a final convergence pass, and each one costs a grep that
returns six of seven hits.

---

## Answers to the questions put to this axis

**1. Is `migration-guard.ts` deep or shallow?** **Deep**, and it passes the
deletion test clearly. Delete it and `readPublicCatalogue`'s two-query,
~115-line catalogue join (`:237-405`) reappears in seven files;
`assertOnlyTablesMoved`'s cross-table diff reappears in seven;
`withRolledBackTransaction`'s sentinel protocol — the one whose failure mode is
"every failing case becomes a pass" — reappears in seven. Nine exports for a
619-line module behind which sits real machinery is a good ratio. Two exports
are thin: `readMigrationSql` (6 lines) earns its place because the path
convention needs one owner, and `nonEmptyNames` is the one genuinely shallow
export (see S-7). The module is not carrying enough: S-1, S-2 and S-3 all want
more moved *into* it, which is the opposite of the usual complaint.

**2. Duplication.** Each suite's own degrade SQL, pinned literals and
per-migration history are legitimately its own and this review does not touch
them. The lock/`postgres()` lifecycle is duplication the audit *requires* (see
S-1). What should have been shared: the oracle-B sequencing (S-1), the privilege
derivation (S-2), the registry case (S-3). Nothing shared should have stayed
separate — the one boundary I checked hardest, the plan's refusal to merge
`live-db-lock.ts` into the harness, is correct: different responsibility, no
shared logic.

**3. Header volume.** Most of it earns its length. Three specific paragraphs do
not, named and counted in S-4.

**4. `DegradeTarget`.** Three of four variants are right and D9's split is
justified by evidence. The fourth is not a property. See S-6.

**5. Project rules.** Clean. No `any` in any new file (the only `: any` hit in
the diff is the English word "any" inside a comment,
`migration-118…:146`). No silent catch — the one catch
(`migration-guard.ts:603-606`) exists to re-throw everything that is not the
sentinel, and that behaviour has its own test. No bare string literals for
subscription status, tier IDs, job names or review status anywhere in the diff.
No production module imports the helper (`grep` over `src`, `worker`, `scripts`
excluding `__tests__/`: zero hits), and the helper's own header states the
convention. Invariant 15 is not engaged — the helper takes its handle as a
parameter and resolves none. No file crosses 1,000 lines; 117's growth from 296
to 713 is the largest and its mixed migration-shape / `writeAdminAuditLog`
concerns pre-date this branch, so that is not a regression here.

**6. `nonEmptyNames`.** Split verdict — see S-7. Right for 117, wrong for 048.

**7. Naming and readability.** An engineer who knows this codebase but not this
branch will understand every suite from its header and case titles. Titles are
descriptive and consistently name the migration, the mechanism and the
direction; the "oracle A / oracle B" section banners are genuinely helpful
navigation. The readability cost is not comprehension, it is the seven-way
paraphrase (S-4) and the divergent shapes (S-1), both of which make the reader
re-derive per file what should be one fact and one pattern.

---

## Appendix — low confidence, preference not finding

**A-1.** The restore case and the noninterference case run two separate
degrade/re-apply transactions per suite that differ only in the closing
assertion (e.g. `049:169-194` and `049:196-209`). Merging them would halve the
DDL cost of this family on the shared container. I am not confident the saving
is worth losing per-assertion failure attribution, and S-1's `withDegradeCycle`
makes the duplication cheap enough that it may not matter.

**A-2.** `readMigrationSql` (`migration-guard.ts:613-618`) resolves against
`process.cwd()` and stats the file twice (`existsSync` then `readFileSync`).
Catching `ENOENT` from a single `readFileSync` and re-throwing with the path
would be one call and the same message. Cosmetic unless vitest is ever invoked
from a subdirectory.

**A-3.** `renderValue` (`:411-419`) renders `null` as the sentinel string
`'(null)'`, so a table whose `comment` is the literal text `(null)` diffs equal
to a table with no comment. Real but vanishingly unlikely; the S-5 descriptor
refactor removes the ambiguity for free, which is the only reason to mention it.

**A-4.** `ROLLBACK_SENTINEL` (`:584`) is a single module-level `Error` instance,
so its captured stack is from module load rather than the throw site. Identity
comparison is what makes the protocol work and that is correct; if the sentinel
ever escapes to a reporter the stack will be useless. Not worth changing today.
