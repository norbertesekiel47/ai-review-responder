# Review round 2 — spec & correctness (verification only)

Branch `fix-694-live-db-ddl-detector`. Fix commits under review: `415c7d1c`,
`1301455f`, `d7671e53`. Pre-fix baseline `91873792`. Scope is strictly the five
round-1 findings plus defects a fix itself introduced — no new fronts against
unchanged code.

**Gates re-run at HEAD:**

| command | result |
|---|---|
| `pnpm vitest run scripts/ci/__tests__/live-db-suites-audit.test.ts` | 35 passed / 35 |
| `pnpm ci:live-db-suites` | `live-db-suites-audit: passed` |

---

## Per-finding verdicts

| id | verdict |
|---|---|
| F1 fail-closed hole (`TemplateExpression` read as safe) | **VERIFIED** — hole closed; precision held against 11 real sites. The tagged-template exclusion's *outcome* holds, but its *stated reason* is false → **R1** |
| F2 DDL verb in a SQL comment inside an executed template | **VERIFIED** — false positive gone, line numbers provably correct, pragma still works, bound documented |
| F3 plan Task 6 docs sweep | **VERIFIED** — both files updated; every named mechanism exists. One summary-level overclaim noted in the appendix |
| F4 repo-wide test's inverted rationale | **VERIFIED** — comment now accurate; both intake copies corrected, byte-identical, valid JSON |
| F5 `isUnsafeCall` receiver forms | **VERIFIED** — bracket form caught (string *and* template key); header's bound is honest and its `49` figure is exact |

**Defects introduced by a fix:** one (**R1**, Medium — a false premise, no
offending site today) plus one bookkeeping regression (**R2**, Low).

---

## F1 — fail-closed hole

### Fixtures run

Harness: `auditLiveDbSuite(file, LIVE_DB + body)` against
`src/lib/x/__tests__/x.integration.test.ts`, where `LIVE_DB` is a
`helpers/live-db-lock` import. Body always starts on source line 2.

```
F1a unsafe(`${ddl}`)                                       -> runtime-ddl    line 2
F1b unsafe(`SET x=1; ${ddl}`)                              -> runtime-ddl    line 2
F1c mid-statement (setConsent shape)                       -> (clean)
F1d head is only a SQL comment                             -> runtime-ddl    line 2
F1e head only whitespace/newline                           -> runtime-ddl    line 2
F1f opaque identifier arg                                  -> runtime-ddl    line 2
F1g 2nd subst after `;` in 2nd static span                 -> runtime-ddl    line 2
F1h subst carries the `;`                                  -> (clean)   <-- gap, see R1(b)
F1i trailing subst, no static separator                    -> (clean)   <-- same gap
F1j unsafe(str, args) 2-arg readable                       -> runtime-ddl    line 2
```

`F1a`–`F1g` and `F1j` confirm the hole is closed: the statement-start test fires
on an empty head, a whitespace-only head, a comment-only head (so
`blankSqlComments` inside `hidesStatementStart` is load-bearing), and on a
substitution that follows a `;` in a **later** static span, not just the head.

### Precision — checked against reality, not just one fixture

`hidesStatementStart` only earns its keep if it leaves real interpolation alone.
There are **11** `.unsafe()` call sites in the 78 marker-passing live-DB suites
whose argument is a `ts.TemplateExpression` — every one of them still reads
clean, which is why `pnpm ci:live-db-suites` passes:

```
src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts:65
src/lib/locations/__tests__/add-location-tx.integration.test.ts:92
src/lib/reviews/__tests__/import-consent.integration.test.ts:80, :160
src/lib/reviews/__tests__/import-offer-analytics.integration.test.ts:107
src/lib/reviews/__tests__/import-offer-view.integration.test.ts:60, :80, :99
src/lib/shared/__tests__/migration-091-send-mode-spine.integration.test.ts:1207
src/lib/solicitation/__tests__/outreach-render.integration.test.ts:355
worker/background/pollers/__tests__/NotificationFailoverPoller.integration.test.ts:101, :117
```

The named negative case is real and confirmed clean —
`src/lib/reviews/__tests__/import-consent.integration.test.ts:80`:

```ts
await sql().unsafe(
  `UPDATE businesses
      SET import_decision = '${decision}',
          import_decision_at = ${decided},
          import_offer_expires_at = ${expires}
```

Head is `UPDATE businesses\n SET import_decision = '` — non-empty, not
`;`-terminated — so the file stays readable and the whole suite audits clean.

### The tagged-template exclusion — asserted in round 1, now tested

The claim under test (`scripts/ci/live-db-suites-audit.ts:170-174`):

> Postgres.js parameterises a tagged template's substitutions, so a substitution
> there arrives as a bind value and cannot carry a statement.

**This is false.** `node_modules/postgres/src/types.js`:

```js
function stringifyValue(string, value, parameters, types, o) {
  return (
    value instanceof Builder ? value.build(string, parameters, types, o) :
    value instanceof Query   ? fragment(value, parameters, types, o) :
    value instanceof Identifier ? value.value :
    value && value[0] instanceof Query ? value.reduce(…) :
    handleValue(value, parameters, types, o)   // ← only THIS path binds
  )
}
```

A `Query` substitution — a nested `sql\`…\`` **or** a `sql.unsafe(…)` — takes the
`fragment()` path and is spliced in as raw SQL **text**. Proved live against
`TEST_DATABASE_POOL_URL`:

```
sql`${sql.unsafe("select 42 as n")}`   -> [{"n":42}]     // inlined as SQL text
sql`select ${sql`40 + 2`} as n`        -> [{"n":42}]     // inlined as SQL text
sql`select ${'40 + 2'} as n`           -> [{"n":"40 + 2"}] // bound, as the comment claims
```

A bind parameter cannot *be* a statement, so `[{"n":42}]` is decisive.

The **outcome** of the exclusion nevertheless holds today, for a different reason
than the one written down: a fragment can only be produced by a
`TaggedTemplateExpression`, a `.unsafe()` call, or a `sql(ident)` builder, and the
walk visits all of those independently — so the DDL is caught at the *producing*
node, not the interpolation site:

```
T1 nested sql.unsafe fragment inside tagged tpl   -> runtime-ddl    line 2
T2 nested tagged fragment carrying DDL            -> runtime-ddl    line 2
T5 tagged tpl, DDL in static text                 -> runtime-ddl    line 2
T3 tagged tpl, opaque fragment `sql`${frag}``     -> (clean)
T4 tagged tpl, cross-file helper fragment         -> (clean)
```

`T3`/`T4` are the residual gap, and it is not theoretical machinery: nested
fragments are live in-repo idiom (`src/lib/solicitation/__tests__/ingest.integration.test.ts:59`
builds `sql()\`NOW() - ${…}::interval\`` and interpolates it into the outer
`INSERT`), and `listTestFiles()` matches only `*.test.ts`/`*.test.tsx` — so the
**10** git-tracked `__tests__/helpers/*.ts` files are never scanned. That is
exactly where this feature's own `abort-injection.ts` lives. See **R1**.

**VERDICT F1: VERIFIED** (the hole is closed and precision holds); the exclusion
is sound in effect but not for the stated reason → **R1**.

---

## F2 — DDL verb in a SQL comment

```
F2a comment above real DDL                    -> runtime-ddl    line 5   (DDL is on line 5)
F2b block comment spanning 2 lines, then DDL  -> runtime-ddl    line 5   (DDL is on line 5)
F2c bound: `--` inside a string literal       -> (clean)                 (documented)
F2d pragma, `// -- live-db-ddl-ignore:` form   -> (clean)
F2e pragma, `// live-db-ddl-ignore:` form      -> (clean)
```

`F2a` body (line 1 is the `LIVE_DB` import):

```
2  await tx`
3    -- migration 083 added an ALTER TABLE reviews
4    /* also not a CREATE INDEX */
5    DROP TABLE job_outbox
6  `;
```

**Offset preservation is confirmed, and the test is decisive.** In `F2b` the
block comment spans lines 3–4; had `blankSqlComments` *deleted* the comment
instead of blanking it to equal-length whitespace, the two consumed newlines
would have made the report read line 3. It reads line 5 — the actual `TRUNCATE`
line — in both fixtures.

**Pragma still works.** Mutation proof on the real pragma'd file
`worker/background/schedulers/__tests__/migration-080-outbox-dedup.integration.test.ts`
(in-memory only, source untouched):

```
as shipped   -> []
pragmas gone -> runtime-ddl | line 81
```

So the three pragma sites are genuinely suppressing a live finding — the pragma
is load-bearing, not decorative, and `lineHasPragma` still sees the raw source
line after comment blanking.

The `F2c` bound reproduces exactly as documented at
`scripts/ci/live-db-suites-audit.ts:150-154` (`blankSqlComments`' own JSDoc,
which is where a reader chasing a false negative lands).

**VERDICT F2: VERIFIED.**

---

## F3 — docs sweep (plan Task 6)

Both files updated in `d7671e53`. Every mechanism the new prose names exists
with the name given:

| doc claim | code |
|---|---|
| detection is AST extraction of executed SQL | `extractExecutedSql` (`:230`) |
| migration-**shape** allowlist | `MIGRATION_SHAPE_SUITES` (`:79`) |
| **DDL-probe** allowlist | `DDL_PROBE_SUITES` (`:95`) |
| both lock-enforced | `SHARED_LOCK_MARKER` / `unlocked-ddl` rule (`:329-340`) |
| `-- live-db-ddl-ignore: <reason>` | `DDL_PRAGMA` (`:142`), 3 live sites in the 080 preflight |
| `helpers/abort-injection.ts` to force an abort | `src/lib/shared/__tests__/helpers/abort-injection.ts`, 2 callers |
| `assertSchemaReady` / `pnpm test:db:setup` | present, unchanged |

Lock enforcement mutation-proved on both allowlists (in-memory `acquireLiveDbLock`
→ `noLockHere`):

```
migration-088-solicitation-batch-executor.integration.test.ts -> unlocked-ddl
outreach-render.integration.test.ts                           -> unlocked-ddl
```

The lab-notes index bullet and the new `## 2026-08-08 — #694` section (five
entries) are consistent with the shipped code on every mechanism I checked,
including the `hidesStatementStart` rule and the equal-length-blanking lesson.
One summary-level overclaim is in the appendix (A3).

**VERDICT F3: VERIFIED.**

---

## F4 — repo-wide test rationale

Comment at `scripts/ci/__tests__/live-db-suites-audit.test.ts:291-303` now states
the correct direction: it catches precision regressions and newly-added offender
files, and "cannot catch reach going backwards … a detector that goes blind
produces no findings, `offenders` comes out empty, and this test PASSES".
Accurate — I confirmed the shape (`expect(offenders).toEqual([])`).

Both intake copies:

```
jq -r '.observability[1]' .feature/intake.json                                   -> corrected, jq exit 0
jq -r '.observability[1]' docs/superpowers/plans/…-intake.json                    -> corrected, jq exit 0
diff .feature/intake.json docs/superpowers/plans/…-intake.json                    -> FILES_IDENTICAL
```

Both parse as valid JSON and are byte-identical to each other.

**VERDICT F4: VERIFIED.**

---

## F5 — `isUnsafeCall` receiver forms

```
F5a bracket string key      sql['unsafe']('DROP TABLE …')  -> runtime-ddl    line 2
F5b bracket template key    sql[`unsafe`](`DROP TABLE …`)  -> runtime-ddl    line 2
F5c bracket key, opaque arg sql['unsafe'](migrationSql)    -> runtime-ddl    line 2  (fail-closed)
F5d destructured            const { unsafe } = sql          -> (clean)  documented bound
F5e .bind                   sql.unsafe.bind(sql)            -> (clean)  documented bound
F5f computed key            const k='unsafe'; sql[k](…)     -> (clean)  within the documented bound
```

`ts.isStringLiteralLike` picks up the template-literal key form for free — one
more shape than the test pins, and correct.

The header's factual claim at `:207` is **exact**: an AST census of the 78
marker-passing suites finds `unsafeForms = [["propertyAccess", 49]]` — 49 calls,
every one a property access, zero element-access / bare-identifier forms. The
module no longer claims "every `.unsafe()` call"; `:22-23` and `:203-210` name the
bound (`isUnsafeCall` states that bound) and `F5d`/`F5e` behave as documented.

**VERDICT F5: VERIFIED.**

---

## Defects introduced by a fix

### R1 — the tagged-template exclusion rests on a false premise, and its real bound is unnamed · Medium

`scripts/ci/live-db-suites-audit.ts:170-174` (and, same JSDoc block, `:165-167`)

**(a)** "Postgres.js parameterises a tagged template's substitutions, so a
substitution there arrives as a bind value and cannot carry a statement" is
false. `stringifyValue` routes a `Query` substitution through `fragment()` and a
`Builder` through `.build()` — both splice raw SQL text. Proved live:
`sql\`${sql.unsafe('select 42 as n')}\`` returns `[{"n":42}]` (see F1 above).

The exclusion is nonetheless safe **today** for a reason the comment does not
give: the walk visits the fragment-*producing* node. What that reason does not
cover — and what nothing in the file or the docs names — is a fragment produced
in a file the audit never opens. `listTestFiles()` globs `*.test.ts` /
`*.test.tsx`, so all 10 git-tracked `__tests__/helpers/*.ts` files are outside its
reach, and that is the very directory this feature moved its abort injection into.

Concrete failure scenario: a future `src/lib/x/__tests__/helpers/ddl.ts` exports
`export const addCheck = sql\`ALTER TABLE job_outbox ADD CONSTRAINT tmp_x CHECK (…)\``;
a live-DB suite writes `await sql\`${addCheck}\``. Postgres.js splices the ALTER
in verbatim, ACCESS EXCLUSIVE lands on `job_outbox`, `ci:live-db-suites` reports
`passed` — the #694 mode returning through a seam the comment declares
impossible. The next person to read `:170-174` has no reason to look.

**(b)** `:165-167` states an absolute — "A DDL verb can only begin a statement, so
that is the only position where a hidden substitution can carry one past the verb
match" — that my fixtures falsify, because a substitution's *value* can supply
the statement boundary:

```
F1h  db.unsafe(`SET x = 1 ${sep} ${ddl}`)   -> (clean)   // sep = ';'
F1i  db.unsafe(`SELECT ${a}${ddl}`)         -> (clean)   // a ends in ';'
```

Both are contrived (they need a substitution carrying `;`), and I would not raise
(b) alone. It matters here only because it is the same absolute-claim habit as
(a), in the same JSDoc, fixed by the same edit: state the bound instead of the
absolute — "safe because the producing node is visited in-file; a fragment built
outside the scanned globs, or a substitution supplying its own `;`, is out of
reach." One paragraph, no behaviour change. Both allowlists and the pragma stay
as they are.

Why Medium and not Low: no offending site exists today, but this feature's own
lab note is "a proxy holds only as long as the correlation does, and nothing
tested the correlation" — and (a) is a justification for *skipping a check* that
is wrong about the library. Round-1 F1 was the same shape (asserted, not proven)
and it did hide a real hole.

### R2 — the census figure is stale again · Low

`scripts/ci/live-db-suites-audit.ts:41`, `:225`, and
`scripts/ci/__tests__/live-db-suites-audit.test.ts:295` read **770 of 1469**.
At HEAD it is **771 of 1470**. Measured per commit (AST count of
`ts.isTaggedTemplateExpression` over the marker-passing `*.test.ts` files, and of
zero-arg `sql()` tags):

```
13212b55 (fork)   suites=78 taggedTemplates=1470  sql()=770
8b87c859          suites=78 taggedTemplates=1469  sql()=770   <- abort-injection.ts extraction
91873792 (pre-fix) suites=78 taggedTemplates=1469  sql()=770
415c7d1c          suites=78 taggedTemplates=1469  sql()=770   <- the round-1 correction, right here
1301455f          suites=78 taggedTemplates=1470  sql()=771   <- invalidated it one commit later
d7671e53 (HEAD)   suites=78 taggedTemplates=1470  sql()=771
```

Cause: `1301455f`'s S3 fix added the `jobOutboxConstraintCount()` helper — one
new `sql()` tagged template — to
`src/app/api/dashboard/import-offer/__tests__/route.integration.test.ts:103`.
This is the same class round-1 S8 corrected, re-introduced by a later fix in the
same round. The argument the number supports (`sql()` is the plurality, so a
tag-name allowlist cannot work) is unaffected. `docs/superpowers/plans/2026-08-08-live-db-ddl-detector.md`
(5 sites) and `…-deviations.md` D4 carry the same figure.

---

## Appendix — untriaged (out of this round's scope, no action claimed)

**A1 — helper files under `__tests__/helpers/` are never scanned.** `listTestFiles()`
globs `*.test.ts`/`*.test.tsx`; 10 git-tracked `__tests__/helpers/*.ts` files
execute suite SQL and are structurally invisible to every rule. Pre-existing (not
touched by any fix commit), and it is the reach half of **R1**'s residual gap.
Widening the glob is a scope decision, not a round-2 fix.

**A2 — `postgres`' own `sql.file(path)` executes SQL with no tagged template and no
`.unsafe()`.** Zero occurrences in any `*.test.ts` today (grepped), so it changes
no finding; noted only because it is a third route to executed SQL that
`extractExecutedSql` does not model. Unchanged code.

**A3 — `.claude/CLAUDE.md:192` says "every tagged template and `.unsafe()` call".**
That is the unqualified claim `415c7d1c` deliberately removed from the module
header under F5, relocated into the summary layer. CLAUDE.md is a pointer to the
module for mechanics and the bound is zero-occurrence, so I did not raise it; if
the R1 edit happens, "(see the module header for the bound)" costs four words.

**A4 — `CLAUDE.md:192` / lab-notes: "each must hold `acquireLiveDbLock`".** The
shipped code exempts `migration-074` via `OWN_APPLY_LOCK` /
`withMigration074ApplyLock`. Pre-existing wording, unchanged by this branch.

**A5 — "the 80 suites" (`:228`) counts the two `NOT_LIVE_DB` files** that
`auditLiveDbSuite` returns `[]` for; the template census that sits beside it is
over 78. Both readings were deliberate per round-1 S8, and both give 1470
templates, so this is a labelling nit only.
