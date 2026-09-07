# Red team — #1171 `job_outbox` deny-all RLS — FOURTH independent pass

- **Mode / run id**: standalone / `standalone-1171-929c53d-375c50`
- **Fork / merge-base**: `602e98930810177230c0edbc0830063db5f75d43`
- **HEAD**: `929c53dd2078f5132ddcb62d5147b7f012956cd2`
- **Risk**: high (migration) · **Round**: 2 · **Status**: `OPEN_P0`
- **Gate at HEAD before this pass**: green, 31 rows (root's evidence, not re-derived here)
- **Suite baseline at HEAD, this pass**: 6/6 green with the live container attached

## The question this pass was authorised to answer

Three passes, three sets of P0s, all in the same artifact — the privilege and
text guards inside
`src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts` —
and none in the migration. The owner asked whether the guard is now sound or
whether the approach is wrong.

**Answer: the approach is wrong.** Six more surviving mutants, three more P0s,
all in the same artifact, and once again nothing in the migration. The detail
that settles it: every P0 this pass found is a *new instance of a defect class a
previous pass already closed*. Pass 3 fixed "the phrase guards are
whitespace-literal"; this pass evades them with `/**/`, a token separator that
is not whitespace. Pass 3 fixed "collapsing whitespace before stripping `--`
deletes the file"; this pass exploits the surviving ordering — `--` stripped
before strings are masked — to hide a live statement from *both* text helpers at
once, in the exact place the code comment claims they "cannot share a hiding
place". Pass 3 added `normalizedSql()` so the phrase guards see past newlines;
this pass uses the fact that `normalizedSql()` retains comments to satisfy the
suite's only *positive* assertion with a comment while the migration stops
enabling RLS at all.

The pattern is not "the guard needs one more arm". A hand-written regex
approximation of a SQL lexer is being asked to prove a security property about a
file, and each round it is defeated by the next lexical construct nobody
enumerated: tagged dollar quotes, string concatenation, `EXECUTE`, newlines,
`--` inside strings, `/* */`, comments-as-evidence. That enumeration has no end.
The environment-independent guard should be a real parse or a real apply — apply
the checked-in `119_job_outbox_rls.sql` to a scratch database inside the suite
and assert the resulting catalogue — not a text approximation of one.

## Findings

| Severity | file:line | Finding |
|---|---|---|
| **P0** | `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:108-119,145-149,195-202` | A `--` inside a single-quoted string, on the same line as a hostile statement, blinds **both** text helpers at once — each strips `--[^\n]*` *before* any string masking. In-tree vitest mutation: the migration widened to `REVOKE ALL ON job_outbox FROM service_role` runs, and the suite is **6/6 green**. No arm of this suite can see it. |
| **P0** | `…:219-237` (with `normalizedSql`, `:133-135`) | Block comments are PostgreSQL token separators and neither helper strips them. `DISABLE/**/ROW LEVEL SECURITY`, `CREATE/**/POLICY` and `FORCE/**/ROW LEVEL SECURITY` all apply cleanly and all three phrase guards stay green. |
| **P0** | `…:224` (with `normalizedSql`, `:133-135`) | `normalizedSql()` retains comments, so the suite's only positive assertion is satisfiable by a **line comment**. Proven: migration 119 stops enabling RLS (`rls=false` on a clone) with every text guard green. |
| **P1** | `…:399-403` | False coverage claim on Arm C: "the assertion on the count means a PostgreSQL that ever adds a fifth fails loudly here". The only count assertion is `>= 7` on the **table** privilege list (already 8 on PG17); a fifth *column* privilege would not fail it. `columnPrivileges` carries no assertion at all. |
| **P2** | `…:404-430` | The one cell no arm covers: membership granted `WITH INHERIT FALSE, SET TRUE` (PG16+). Measured A=0 B=0 C=0 for both table and column grants. Needs an unusual future GRANT plus a `SET ROLE` vector. |
| **P2** | `.claude/reference/migrations-log.md:2748` | "591 tracked files" is **593** at this HEAD — the commit that wrote 591 added the two `docs/reviews/red-team/1171-ce0f2d5-cf9458/findings.*` files, which themselves contain the identifier. 55 and 78 reproduce exactly. |

---

### RT4-F1 (P0) — the two text checks DO share a hiding place

`topLevelStatements()` and `executableSql()` both begin by stripping
`--[^\n]*`. `topLevelStatements()` masks strings only afterwards;
`executableSql()` never masks them. PostgreSQL does **not** treat `--` inside a
single-quoted string as a comment. So any statement placed after a string
containing `--`, on the same physical line, is invisible to both.

The comment at lines 195-199 asserts the opposite in as many words — *"Counted
on comment-stripped, whitespace-normalised text with the bodies left intact, so
the two checks cannot share a hiding place."* The helper's own doc-comment at
lines 104-106 names this exact hazard and dismisses it — *"The inverse hazard, a
`--` inside a string literal, does not exist in this file and would fail loudly
rather than silently."* It fails **silently**.

**Measured, in-tree, under vitest with the live container attached**
(mutation-runner journal `3e91120603e6 -> b819c212cd11`, run 3 of round 2):

    COMMENT ON TABLE job_outbox IS 'note -- x'; REVOKE ALL ON job_outbox FROM service_role;

appended in place of the file's own `COMMENT ON TABLE` →
`total 6 passed 6 failed 0`.

Applied to a throwaway clone, that statement moves `service_role` from
`INSERT,SELECT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER` to `none`.

**Arbiter confirmation.** Not an equivalent mutant and not an unexecuted branch.
The suite header (lines 61-70) states that it asserts *nothing* about the
owner's or `service_role`'s privileges, and names title 3's exact-match
statement assertion as the sole guard for both — *"guarded by title 3's
exact-match statement assertion instead of by an assertion that could only be
true by accident."* Arms A, B and C all filter to `anon` and `authenticated`, so
**no catalogue arm can ever detect this mutant**, on any container, in any
environment. It is the one survivor this pass found that the whole suite is
blind to.

The same vector also re-grants. All four text guards green for:

    COMMENT ON TABLE job_outbox IS 'note -- see #1171'; GRANT ALL ON job_outbox TO anon;

On a clone this restores `anon` to
`DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE` on `job_outbox` — the
exact posture migration 119 exists to remove. Arm A would catch that one on a
re-provisioned container; it is recorded because it defeats the guard the suite
calls "the ONLY environment-independent guard".

**Behavioural replacement.** Mask strings and dollar-quoted bodies *before*
stripping `--`, and mask `/* */` as well — or stop parsing and apply the file.

---

### RT4-F2 (P0) — `/* */` is a token separator, and no helper strips it

`normalizedSql()` collapses `\s+`. A block comment is not whitespace, and
PostgreSQL accepts it anywhere a token separator is legal. Each line below
applies cleanly on a clone and leaves every text guard green (baseline: the
unmodified file returns zero guard failures; the plain-spelling controls all
fail as designed):

| mutant appended to 119 | clone result | guards |
|---|---|---|
| `ALTER TABLE job_outbox DISABLE/**/ROW LEVEL SECURITY;` | `rls=false` | green |
| `CREATE/**/POLICY p_open ON job_outbox FOR SELECT TO anon USING (true);` | `policies=1` | green |
| `ALTER TABLE job_outbox FORCE/**/ROW LEVEL SECURITY;` | `force=true` | green |
| *control* `ALTER TABLE job_outbox DISABLE ROW LEVEL SECURITY;` | — | **caught** |
| *control* `GRANT ALL ON job_outbox TO anon;` | — | **caught** |
| *control* `REVOKE ALL ON job_outbox FROM service_role;` | — | **caught** |

The third is the one the migration header calls *"the one statement in this file
that could take the platform down"*. The comment at lines 233-236 claims the
DISABLE case is closed — *"Red team appended exactly that and passed every other
case"* — and it is closed only for the spelling that pass tried.

**Arbiter confirmation.** Semantically meaningful and executed: each mutant
changes the catalogue on a real PostgreSQL 16.14 container. The catalogue arms
(titles 1 and 2) would catch all three on a re-provisioned container — but the
DB lane skips silently without `TEST_DATABASE_POOL_URL` (observed in this pass:
`3 passed, 3 skipped, exit 0`), which is the exact configuration the text guard
exists to cover.

---

### RT4-F3 (P0) — the positive assertion is satisfiable by a comment

Title 4's only positive assertion,
`expect(text).toMatch(/ALTER TABLE job_outbox ENABLE ROW LEVEL SECURITY;/)`,
reads `normalizedSql()`, which retains comments. The split the file documents as
load-bearing — comments **kept** for the phrase guards, **stripped** for the
counts — is precisely what creates this: the one guard that must prove a
statement *exists* reads the text where comments still live.

Replacing the ALTER inside the guarded DO block with

        PERFORM 1; -- ALTER TABLE job_outbox ENABLE ROW LEVEL SECURITY;

applies cleanly, leaves `rls=false` on a clone that started with the client
grants live, and returns **zero** guard failures across all four text guards.
`DO $` still counts 1, `REVOKE` still counts 1, `GRANT` is still null, no
`EXECUTE`.

**Arbiter confirmation.** Not equivalent — the mutant removes the migration's
entire reason to exist. Not an unexecuted branch — the assertion runs on every
invocation of title 4.

**Behavioural replacement.** Positive assertions must read `executableSql()` (or
the statement list), never the comment-bearing text.

---

### RT4-F4 (P1) — Arm C's stated fail-loud protection does not exist

Lines 399-403: *"The four below are fixed by the SQL standard while the TABLE
set is not, and the assertion on the count means a PostgreSQL that ever adds a
fifth fails loudly here instead of quietly under-covering."*

The only count assertion in the file is
`expect(Number(derived?.privilege_count)).toBeGreaterThanOrEqual(7)`, which
counts the **table** privilege list from `acldefault('r', …)`. Measured: 7 on
the PG16.14 container, **8** on the PG17.6 Supabase projects. A PostgreSQL that
added a fifth *column* privilege would take that count to 9 and `>= 7` would
still pass. `columnPrivileges` itself carries no assertion of any kind, so the
under-covering would be exactly as silent as the comment says it is not.

**What is correct, and verified rather than assumed:** the four-element
intersection is right today on both server versions.
`has_column_privilege(…, 'MAINTAIN')` raises `unrecognized privilege type` on
PG17.6 as it does on PG16.14, and `acldefault('c', <owner>)` has length 0 on
both — so the set genuinely cannot be derived and hard-coding it is the right
call. The `>= 7` assertion *does* do its actual job: it is Arm B's guard against
an empty `server_privileges` CROSS JOIN, and that is sound.

**Behavioural replacement.** Assert `columnPrivileges.length === 4`, or derive
the set by probing `has_column_privilege` against candidate names and failing on
any newly-accepted one.

---

### RT4-F5 (P2) — the fourth intersection: non-inherited membership

Arms A, B and C were each added to close a cell the previous arm left. The
deliberate enumeration, measured on a throwaway clone with the three arm queries
replicated verbatim against a stand-in role (`rt4_anon`, `NOLOGIN INHERIT`, same
shape as `anon`):

| grant shape | Arm A | Arm B | Arm C |
|---|---|---|---|
| table x direct | yes | yes | yes |
| table x PUBLIC | yes | yes | yes |
| table x inherited (1 level) | no | yes | yes |
| table x nested inherited (2 levels) | no | yes | yes |
| table x predefined role `pg_read_all_data` | no | yes | yes |
| table x predefined role `pg_write_all_data` | no | yes | yes |
| table x direct WITH GRANT OPTION | yes | yes | yes |
| column x direct | yes | no | yes |
| column x PUBLIC | yes | no | yes |
| column x inherited (1 level) | no | no | yes |
| column x nested inherited (2 levels) | no | no | yes |
| **table x membership `WITH INHERIT FALSE, SET TRUE`** | **no** | **no** | **no** |
| **column x membership `WITH INHERIT FALSE, SET TRUE`** | **no** | **no** | **no** |

Every cell the brief named is covered. The one that is not is PostgreSQL 16's
non-inherited membership: `GRANT r TO anon WITH INHERIT FALSE, SET TRUE` lets
`anon` reach `r`'s privileges via `SET ROLE`, and the `has_*_privilege` functions
use `USAGE` (inherit) semantics, so all three arms return zero. Recorded rather
than raised: it needs both an unusual future GRANT form and a `SET ROLE` vector
through PostgREST.

Also closed, no finding: Arm C's `NOT att.attisdropped` is correct — a dropped
column keeps a `pg_attribute` row with a live `attacl` (measured) but is
unreachable, and Arm A, which does not filter it, still reports the residue. A
re-added column starts with an empty ACL. And `REVOKE ALL ON <table>` **does**
remove column-level grants (measured), so migration 119's revoke is complete.

---

### RT4-F6 (P2) — one stale count

`.claude/reference/migrations-log.md:2748` says the identifier appears
"repo-wide, including tests and docs, … in 591 tracked files". At `929c53dd` it
is **593**: the same commit that wrote 591 added
`docs/reviews/red-team/1171-ce0f2d5-cf9458/findings.md` and `findings.json`,
both of which contain `job_outbox`. Self-referential, off by exactly two.

---

## Duty 3 — doc claims re-resolved against HEAD

`prevalidate-plan.py` is not present at `~/.claude/skills/grill-me-codex/scripts/`;
every claim below was hand-checked and the method is stated for each.

| Claim | Source | Verdict |
|---|---|---|
| 54 tables in schema `public`, both projects | migration header / arch-review-log | reproduced — 54 on both `udeyaqnvpojbwgoaxwdg` and `kubdiqdhqbhwmqfditeg` |
| prod `job_outbox` RLS on, staging off, 0 policies both, client grants live both | migration header | reproduced — prod `rls=true` with 16 `anon`/`authenticated` ACL rows (8 privileges x 2 roles on PG17); staging `rls=false` |
| **20** sibling tables, RLS on + 0 policies + client grants, all granting TRUNCATE to `anon` | D16 / D19 P2-b | reproduced — staging returns exactly 20, all 20 with `anon TRUNCATE`; prod returns 21 because `job_outbox` itself qualifies there, i.e. 20 siblings |
| **55** files under `src/`+`worker/` excluding `__tests__/` BIND it in SQL | migrations-log / arch-review-log | reproduced exactly (55) |
| **78** reference the identifier under that same scope | migrations-log | reproduced exactly (78) |
| **591** tracked files repo-wide | migrations-log | **FALSE — 593 at this HEAD (RT4-F6)** |
| PG16 = 7 privilege types, PG17 = 8 with `MAINTAIN` | test header / D19 | reproduced — 7 on the container, 8 on staging; `MAINTAIN` is table-only on both |
| `acldefault('c', …)` is empty, so the column set cannot be derived | test `:400-402` | reproduced — length 0 on PG16.14 and PG17.6 |
| `anon`/`authenticated` are `rolinherit = true` on the container and both projects | test `:395-396` | reproduced |
| "the assertion on the count means a PostgreSQL that ever adds a fifth fails loudly" | test `:401-403` | **FALSE (RT4-F4)** |
| "the two checks cannot share a hiding place" | test `:198-199` | **FALSE (RT4-F1)** |
| "a `--` inside a string literal … would fail loudly rather than silently" | test `:105-106` | **FALSE (RT4-F1)** |
| "Red team appended exactly that [a self-cancelling DISABLE] and passed every other case" | test `:234-236` | **INCOMPLETE — closed for one spelling only (RT4-F2)** |

## Duty 4 — sibling search

**Patterns searched** (scope `src/`, `worker/`, `scripts/`; tracked files only;
no exclusions beyond that):

- `replace(/--` — comment-stripping regex: **25 files**. All 24 others strip
  `--` from prose or from a SQL fragment they wrote themselves, never as a step
  in a lexer over a checked-in migration.
- `STRING_LITERAL` — string masking: **2 files** — the suite under review and
  `scripts/ci/outbox-seam-audit.ts`.
- `DOLLAR_QUOTED_BODY` — dollar-quote masking: **1 file** — the suite under review.
- `split(';')` over migration text: **2 files** — the suite under review and
  `migration-100-import-consent.integration.test.ts`.

**Result.** RT4-F1, RT4-F2 and RT4-F3 have **no siblings by construction** —
migration 119's suite is the only place in the repository that builds a
statement parser over a migration file. `scripts/ci/outbox-seam-audit.ts` is the
one other string-masking site and is a live CI gate for invariant #2; it is
unchanged code and out of this branch's scope, but worth one look for the same
`--`-before-string-mask ordering. The broader "phrase guards are
whitespace-literal" family in six other migration suites is already recorded as
D19 P2-e and rejected to a follow-up issue; nothing here changes that
disposition.

## Duty 5 — operational completeness

The diff adds one migration, one test file, and documentation. No production
TypeScript, no worker path, no new terminal or swallowed failure path, no Sentry
signal, no feature flag. No rule row in
`docs/runbooks/beta-launch-alerting.md` is owed and none is orphaned. **No
finding.**

## The migration itself — fourth confirmation

`supabase/migrations/119_job_outbox_rls.sql` is byte-identical to the file
passes 1-3 reviewed (blob `3e91120603e6…`; it does not appear in
`git diff ce0f2d52..929c53dd`). Re-read whole at this HEAD and applied to a
throwaway clone that started with all seven privileges granted to `anon` and
`authenticated`:

    rls=true  force=false  policies=0  anon_acl=none  authenticated_acl=none  service_role_acl=unchanged

`BEGIN` / `SET LOCAL lock_timeout` / guarded `DO` / `REVOKE` / `COMMENT` /
`COMMIT`. The guard on `relrowsecurity` makes it a true no-op where RLS is
already on. `REVOKE ALL ON <table>` removes column-level grants too (measured),
so the revoke is complete. FORCE is correctly left off. **The migration is
correct. That is now four independent confirmations, and it has never been the
problem.**

## Inventory

| id | candidate | outcome |
|---|---|---|
| RT4-01 | registries: `REVIEWED_NOT_TENANT_SCOPED` membership | skipped-budget |
| RT4-02 | title 3 revoke exact-match vs in-string `--` hiding `REVOKE … FROM service_role` | survived-confirmed-P0 → RT4-F1 |
| RT4-03 | title 3 GRANT-free assertion vs in-string `--` hiding `GRANT ALL … TO anon` | survived-confirmed-P0 → RT4-F1 |
| RT4-04 | title 4 `DISABLE ROW LEVEL SECURITY` guard vs `DISABLE/**/ROW LEVEL SECURITY` | survived-confirmed-P0 → RT4-F2 |
| RT4-05 | title 4 `CREATE POLICY` guard vs `CREATE/**/POLICY` | survived-confirmed-P0 → RT4-F2 |
| RT4-06 | title 4 `FORCE ROW LEVEL SECURITY` guard vs `FORCE/**/ROW LEVEL SECURITY` | survived-confirmed-P0 → RT4-F2 |
| RT4-07 | title 4 positive `ALTER … ENABLE` assertion vs a line comment | survived-confirmed-P0 → RT4-F3 |
| RT4-08 | three plain-spelling controls (DISABLE / GRANT / widened REVOKE) | killed |
| RT4-09 | title 5 Arms A+B+C vs the 13-cell privilege-shape matrix | killed (12 of 13; the 13th is RT4-F5) |
| RT4-10 | title 2 catalogue `relforcerowsecurity` | excluded |
| RT4-11 | title 1 catalogue `relrowsecurity` + `policy_count` | excluded |

## Environment and safety

- Round opened with `round-start` (round 2, 30 runs); 3 runs used.
- Environment allowlisted via `mutation-runner env --tmp-home` + `dotenv-swap`;
  `.env.local` swapped for a scrubbed copy for the mutation phase and restored
  by the finalizer.
- The only tracked-file mutation was
  `supabase/migrations/119_job_outbox_rls.sql` (`3e91120603e6 -> b819c212cd11`),
  journaled and restored. The other five mutants were evaluated against a
  verbatim offline replica of the four guards plus a throwaway database, which
  is stronger evidence than a vitest run: a migration edit cannot move a
  pre-provisioned container, so vitest would have reported green for reasons
  unrelated to the guard.
- **DB safety.** All DDL ran in a throwaway database `rt4_probe`, dropped at the
  end; the three stand-in roles `rt4_anon`/`rt4_mid`/`rt4_leaf` were dropped.
  Both Supabase projects were read with `SELECT` and catalogue introspection
  only — no write, no DDL, no migration applied.
- **Shared test database restored and verified**: `rt4_probe` gone, no `rt4_*`
  roles remain, `test_ws4.public.job_outbox` reads
  `rls=true force=false policies=0` with zero `anon`/`authenticated`/PUBLIC ACL
  rows, and zero client grants on any other `public` table.
- `git status --porcelain` empty after `finalize`; HEAD unmoved at `929c53dd`;
  migration blob back to `3e91120603e6875ccf9406201b719c1a44920d22`; journal
  closed, no dotenv backup outstanding.

## Authorizations

None.
