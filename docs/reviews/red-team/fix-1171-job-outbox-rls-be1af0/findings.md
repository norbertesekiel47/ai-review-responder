# Red-team pass — `fix-1171-job-outbox-rls`

- **Mode:** feature · **Round:** 2 (final — `round-start` refuses a third) · **Risk:** high (from the signed-off intake)
- **fork / merge-base:** `602e98930810177230c0edbc0830063db5f75d43`
- **round-1 subject:** `3a7d0ca9930ae60c5ebbafb25cd962675d751e78`
- **HEAD (subject):** `90880ef7344661601462be941e09e0e548932b69`
- **intake sha256:** `e300e0c85fff819113f4fce4c3f92c505c7b6c2cc162d3be0cbc9076d10d02b8` (both intake copies re-verified byte-identical this round)
- **Scope:** the fix hunks `git diff 3a7d0ca9..90880ef7` and their direct callers. No new fronts against unchanged code; one unchanged-code observation is in the Appendix, untriaged.
- **Status:** `OPEN_P0`

> **Round-1 artifacts.** The checker resolves exactly one sidecar path per branch
> (`docs/reviews/red-team/<slug>/findings.{md,json}`) and excludes exactly those two
> paths from its tree-moved check, so round 2 must overwrite them. Round 1's report
> and sidecar are preserved unmodified in git at `815ade29`:
> `git show 815ade29:docs/reviews/red-team/fix-1171-job-outbox-rls-be1af0/findings.md`.

## Preconditions

| Check | Result |
|---|---|
| Tracked tree clean at HEAD | yes — `git status --porcelain` empty before the run |
| `mutation-runner.mjs watchers` | `none — no dev server, watch worker, or E2E server is serving this worktree` |
| `mutation-runner.mjs round-start` | `round 2 open, 30 mutation runs available` |
| Env isolation | `env --tmp-home <mktemp -d> --test-db postgresql://test:***@localhost:5499/<db>` — allowlist only, URL validated localhost. No dotenv swap needed. |
| Budget | 8 of 30 runs used. No candidate left `skipped-budget`. |

## Journal of side effects, and their restoration

1. **Files.** Five journaled mutations (`M9`, `M2`, `M5`, `M1`, `MP`), each applied
   through `mutate` (blob-OID journaled) and reverted by `finalize` in the same cycle.
   One additional mutant (`M2`, first attempt) was discarded before classification
   because shell escaping mangled its `$$` delimiters into `$`, making it
   non-compiling SQL — it was rebuilt through `python3`, verified to apply and to
   actually grant, and only then classified. Final `finalize`:
   `reap: every journaled process group is empty (7 recorded)` /
   `finalize: restored 0 mutated file(s) and 0 dotenv file(s); journal closed`.
   `git status --porcelain` empty afterwards; HEAD unmoved at `90880ef7`.
2. **Database.** No catalogue mutation touched the shared `test_ws4`. Two throwaway
   clones created and dropped — `test_rt1171_r2` and `test_rt1171_col`. Post-run
   `test_ws4`: `relrowsecurity=t`, `relforcerowsecurity=f`,
   `relacl={test=arwdDxt/test}`, `pg_policies` count `0` — identical to pre-run.
   `pnpm test:db:setup` was deliberately NOT run.
3. **Remote databases.** Production (`udeyaqnvpojbwgoaxwdg`) and staging
   (`kubdiqdhqbhwmqfditeg`) were read with two `SELECT`-only introspection queries
   each. No write, no DDL, no `apply_migration`.
4. **Gate.** `bash scripts/verify-gate.sh --review` ran at `90880ef7` after
   restoration and before a report byte existed. It wrote `.feature/state.json`
   (`phase=gate_green head=90880ef7`), untracked.

---

# JOB 1 — are the round-1 findings actually addressed?

Every verdict below was produced by measurement this round. None was taken from the
fix's own claims.

## RT-1 (P0) — CLOSED

Verified by mutation on a throwaway clone at HEAD:

```
mutation:  GRANT TRUNCATE ON job_outbox TO authenticated
relacl:    {test=arwdDxt/test,authenticated=D/test}
oracle:    authenticated|TRUNCATE|table
run:       assert-one-test: exactly one test executed
           6 total / 0 passed / 1 failed   <- the ACL case
```

The old `has_table_privilege` form returned `f,f` for the two verbs it named and
passed on the same state. The claim holds exactly as stated.

**The `aclexplode` query, checked on each axis the round asked about** — all four
answers are measurements against the clone, not readings of the SQL.

| Axis | Result |
|---|---|
| Table arm fires | **Yes** — `GRANT TRUNCATE … TO authenticated` -> `authenticated\|TRUNCATE\|table` |
| Column arm fires | **Yes** — `GRANT SELECT (payload) ON job_outbox TO anon` -> `anon\|SELECT\|column`. Neither arm is vacuous; the column arm was never exercised in round 1. |
| `WITH GRANT OPTION` | **Caught** — writes `anon=r*/test` and `aclexplode` still emits `anon\|SELECT\|table` (grantability is a separate column, not a filter). |
| NULL `relacl` | **Safe by construction** — `aclexplode(NULL)` is strict and emits zero rows, and a NULL `relacl` *is* the owner-only default. Not a hole. |
| **Grantee 0 (PUBLIC)** | **NOT caught** -> RT-7 |
| **A role `anon` inherits** | **NOT caught** -> RT-7 |

## RT-2 (P1) — CLOSED

Round 1's exact escape, re-run as a journaled mutation:

```
M5:  REVOKE ALL ON job_outbox FROM anon, authenticated; SELECT 1; REVOKE ALL ON job_outbox FROM service_role;
     -> 5 passed / 1 failed  ("migration 119 revokes every anon and authenticated…")
```

### The parser attack — fifteen inputs

Each input was evaluated against the two assertions' verbatim logic; the decisive
ones were confirmed with journaled vitest runs. The two checks deliberately disagree
about what to mask, and that is what makes the pair work: check A (statement list)
masks dollar-quoted bodies and string literals; check B (raw-text counter) strips
only line comments and leaves both intact.

| # | Construct | Verdict | Killed by |
|---|---|---|---|
| M1 | `DO $tag$ … EXECUTE 'GRANT ALL … TO anon' … $tag$;` — a **tagged** dollar-quote the mask regex does not handle | **KILLED** (vitest: 1 failed) | B (`GRANT` token = 1) |
| M4 | plain `DO $$ … EXECUTE 'GRANT …' … $$;` | KILLED | B |
| M5 | second top-level revoke sharing a line | **KILLED** (vitest: 1 failed) | A (revokes=2) **and** B |
| M6 | `/* REVOKE ALL … FROM service_role; */` — a C-style block comment neither check strips | KILLED | B (revoke count 2) |
| M10 | `REVOKE` spelled across three lines, widened to `service_role` | KILLED | A (whitespace normalised, then exact-matched) |
| M11 | `--` inside a string literal **before** the revoke, unbalancing the quote | KILLED, and **fails CLOSED** (revokes=0, not a silent pass) | A |
| M12 | Cyrillic homoglyph in a role name | KILLED | A (exact match) |
| M13 | `SECURITY DEFINER` function whose `$fn$` body grants | KILLED | B |
| M14 | nested `$$…$$` inside a `$outer$…$outer$` block | KILLED | B |
| M15 | `ALTER DEFAULT PRIVILEGES … GRANT ALL ON TABLES TO anon` | KILLED | B |
| MP | `CREATE POLICY … USING (true)` appended | **KILLED** (vitest: 1 failed) | the policy case |
| M0 | unmutated | passes | — |
| **M9** | `ALTER TABLE job_outbox DISABLE ROW LEVEL SECURITY;` appended | **SURVIVED** — 6/6 green | -> RT-8 |
| **M2** | `DO $$ … EXECUTE 'GRA' \|\| 'NT ALL ON job_outbox TO anon' … $$;` | **SURVIVED** — 6/6 green | -> RT-9 |
| M3 | the same concatenation trick applied to `REVOKE` | SURVIVED (same class) | -> RT-9 |

Every construct that spells `GRANT` or `REVOKE` literally is caught by at least one
of the two checks. The two survivors do not spell the keyword (M2/M3) or do not use
it at all (M9). The `--`-inside-a-string hazard the fix's own comment flags as
"would fail loudly rather than silently" is confirmed to do exactly that.

## RT-3 (P1) — CLOSED

Re-resolved against the live catalogues, not against the diff.

```
prod    udeyaqnvpojbwgoaxwdg  PG 17.6  relrowsecurity=t  relforcerowsecurity=f  policies=0
                              relacl {postgres=arwdDxtm, anon=arwdDxtm, authenticated=arwdDxtm, service_role=arwdDxtm}
staging kubdiqdhqbhwmqfditeg  PG 17.6  relrowsecurity=f  relforcerowsecurity=f  policies=0  column ACLs=0
                              relacl identical to prod
```

- `supabase/migrations/119_job_outbox_rls.sql:44-50` now says the empirical half
  "covers the ALTER ONLY", that the client roles "hold `arwdDxtm` there today", and
  that "the post-119 posture has therefore run in NO environment". All three
  re-resolve TRUE against the catalogues above.
- `.claude/reference/migrations-log.md:2719-2720` carries the same scoping.
- `.claude/reference/arch-review-log.md:95` records the correction as history rather
  than repeating the claim. The only surviving occurrences of the phrase in the tree
  are inside that narration and inside the migration's own "an earlier draft
  claimed … it had not" note.

The sibling numeric edit in the same commit was also re-measured: **78** non-test
files under `src`/`worker` reference the identifier, **55** carry an explicit SQL
binding (`FROM|INTO|UPDATE|JOIN|ON job_outbox`), none of those 55 comment-only. Exact.

## RT-4 (P1) — CLOSED on its primary claim

| Environment | Pre-119 baseline (introspected) | Rollback as written | Verdict |
|---|---|---|---|
| production | RLS **ON**, 0 policies, client roles `arwdDxtm` | `GRANT ALL … TO anon, authenticated`, RLS left **ENABLED** | **Exact.** Both projects are PG 17.6, where `GRANT ALL` on a table yields precisely `arwdDxtm` — the eight privileges the plan names. Never drops below baseline. |
| staging | RLS **OFF**, 0 policies, client roles `arwdDxtm` | the same `GRANT ALL` **plus** `ALTER TABLE job_outbox DISABLE ROW LEVEL SECURITY` | **Exact.** |

The round-1 defect — a symmetric rollback that would have DISABLED RLS on production
and restored only 4 of 8 privileges — is gone.

Two round-1 sub-points recorded rather than re-charged:

- The plan still says "Apply staging first, as always". It is now qualified by "the
  staging ride is the detector", which makes staging-first coherent — the trigger is
  expected to fire on staging before production ever applies. Noted for the arbiter.
- The half-applied-lockstep gap is **disclosed rather than fixed**: the migration
  header now states "Introspection is also the ONLY detector of a half-applied
  lockstep: nothing automated notices one project left behind." An honest statement
  of a manual control, which is what round 1 asked for.

## RT-5 (P2) — CLOSED for the GRANT class

Two assertions now forbid a re-grant: no top-level statement may start with `GRANT`,
and the comment-stripped raw text must contain zero `GRANT` tokens with dollar-quoted
bodies intact. Round 1's F6 mutant and the tagged-body variant M1 are both killed.
The prohibition covers `GRANT` only — see **RT-8**.

## RT-6 (P2) — CONFIRMED accurately recorded, as scoped

`docs/superpowers/plans/fix-1171-job-outbox-rls-deviations.md:392` (D16) states the
count (19), names the families that matter (`auto_approval_policies` and the
run-spine tables), quotes `non_goals[3]` verbatim, gives the distinguishing fact
(`job_outbox` alone had RLS **off** on staging), and carries the list to the
follow-up issue. Nothing was fixed and nothing was claimed to be — exactly what
round 2 was asked to confirm.

---

# JOB 2 — defects the fixes introduced

## (a) The transaction, the guard, and the lock — clean, and the header's claims are proven

| Question | Measurement | Verdict |
|---|---|---|
| Does the guarded ALTER **run** when `relrowsecurity` is false? | Clone reset to pre-119 (`relrowsecurity=f`, `relacl` carrying `anon=arwdDxt` and `authenticated=arwdDxt`). Apply -> `relrowsecurity=t`, `relacl={test=arwdDxt/test}`. | **Yes** |
| Does it **skip** when true? | Re-apply -> no change; guard predicate `NOT (SELECT relrowsecurity …)` = `f`. | **Yes** |
| Does `IF NOT (SELECT …)` mishandle a NULL result? | `SELECT relrowsecurity FROM pg_class WHERE oid='public.<missing>'::regclass` **ERRORS** at the cast; it never yields NULL. The predicate is total. | **No hazard** |
| Does `BEGIN`/`COMMIT` break the psql path (`scripts/test-db-setup.sh`)? | `psql -f` applied the file cleanly twice; the script's per-migration `RESET ALL;` sits outside the block, and its session-level `pg_advisory_lock` is unaffected by a nested transaction. | **No** |
| Nested-transaction hazard if the applier already opened one? | Reproduced: `BEGIN; INSERT …; \i 119; ROLLBACK;` emits `WARNING: there is already a transaction in progress`, 119's `COMMIT` ends the **applier's** transaction, and the applier's later `ROLLBACK` is a no-op — the pre-migration `INSERT` survived. **Repo-wide precedent, not a 119 defect:** 14 other migrations wrap in `BEGIN;`/`COMMIT;`, including 116 (the immediately preceding one) and 104/105/108/109/110/111/114. | **Not a finding** |
| Does `SET LOCAL` bound the ALTER's lock acquisition? | Under a concurrent holder of `AccessShareLock` on `job_outbox`: the **guarded** file completes in **64 ms** (ALTER skipped), while the identical ALTER issued **unconditionally** blocks and dies with `ERROR: canceling statement due to lock timeout` after **5090 ms**. | **Yes — proving both halves of the header's locking claim** |

That last row is the strongest single piece of evidence in this round. It confirms
independently that `ATExecSetRowSecurity` has no early-out and takes ACCESS EXCLUSIVE
even when the flag is already set, and that the guard converts production from an
up-to-5-second write stall on the busiest table in the schema into a 64 ms no-op.

## (b) `assertSchemaReady` removed — safe, and the message is actionable

- **Nothing requires it.** `scripts/ci/live-db-suites-audit.ts` mentions
  `assertSchemaReady` only as suggested remediation for its R2 (no-runtime-DDL) rule;
  no rule requires a suite to call it, and the suite executes no DDL.
- **The precedent is real, not invented.** `src/lib/shared/__tests__/helpers/schema-ready.ts:314-317`
  says of migration 097, verbatim, that it "gets no requirement of its own: it adds no
  relation, column or index … Its suite inspects the migration SQL text instead". 119
  is the same shape; the suite header's citation resolves exactly.
- **A behind-head container fails with the intended message, first.** Clone reset to
  the pre-119 posture, whole suite:

```
6 total / 4 passed / 2 failed
FAIL  migration 119 enables row level security …
      AssertionError: job_outbox RLS posture is not at migration head — run pnpm test:db:setup:
      expected false to be true
FAIL  migration 119 leaves no anon or authenticated privilege …
      AssertionError: expected [ { role: 'anon', …(2) }, …(13) ] to deeply equal []
```

  The actionable message is the first failure. The second carries no message but its
  diff names `role: 'anon'` in the first element — intelligible rather than confusing.
- **One residual, below finding threshold:** on a container so far behind that
  `job_outbox` does not exist, the `::regclass` cast raises a raw
  `relation "public.job_outbox" does not exist` before any message. That state is "no
  schema at all", in which every live-DB suite in the repo fails the same way.

---

# Findings

| id | severity | at | duty | disposition | title |
|---|---|---|---|---|---|
| RT-1 | P0 | `…migration-119-job-outbox-rls.integration.test.ts:238` | 1 | **fixed** | Owner-privilege arms cannot fail (superuser `has_table_privilege`) |
| RT-2 | P1 | `…:117` | 2 | **fixed** | The one-REVOKE guard anchored on line starts |
| RT-3 | P1 | `supabase/migrations/119_job_outbox_rls.sql:39` | 3 | **fixed** | "this exact posture for five months" was false |
| RT-4 | P1 | `docs/superpowers/plans/fix-1171-job-outbox-rls-intake.json:73` | 5 | **fixed** | The rollback plan over-reverted production |
| RT-5 | P2 | `…:110` | 2 | **fixed** | The DB-free guard forbade no subsequent GRANT |
| RT-6 | P2 | `docs/superpowers/plans/fix-1171-job-outbox-rls-deviations.md:392` | 4 | open | 19 sibling tables — recorded non-goal, confirmed accurate |
| **RT-7** | **P0** | `…migration-119-job-outbox-rls.integration.test.ts:250` | 1 | **open** | The new ACL guard filters on grantee NAME: a grant via PUBLIC, or via a role `anon` inherits, leaves the suite green while `anon` holds INSERT on the dispatch spine |
| RT-8 | P2 | `…:163` | 2 | open | The file-text guard forbids GRANT but not a subsequent `DISABLE ROW LEVEL SECURITY` |
| RT-9 | P2 | `…:156` | 2 | open | A GRANT assembled by string concatenation inside the DO block evades both text checks |

## RT-7 — the ACL guard sees only DIRECT grants (P0, open)

`src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:250,256`

```sql
AND acl.grantee::regrole::text IN ('anon', 'authenticated')
```

**Mutation, on the clone at HEAD.**

```
GRANT SELECT, INSERT ON job_outbox TO PUBLIC;
relacl:  {test=arwdDxt/test,=r/test}          -- grantee OID 0; regrole::text is a bare '-'
oracle:  []                                    -- matches neither name
suite:   6 total / 6 passed / 0 failed
has_table_privilege('anon','public.job_outbox','SELECT')          = t
has_table_privilege('authenticated','public.job_outbox','INSERT') = t
```

Second path, same result:

```
CREATE ROLE rt_mid NOLOGIN; GRANT rt_mid TO anon; GRANT SELECT, INSERT ON job_outbox TO rt_mid;
oracle:  []
has_table_privilege('anon','public.job_outbox','SELECT') = t
```

**Arbiter confirmation.** Not equivalent: the grant is real, and the resulting state
is precisely the exposure the migration's own header names as its reason for
existing — "`anon` holds INSERT, and `OutboxPoller` dispatches whatever rows it finds
to BullMQ without asking who wrote them." Not an unexecuted branch: the same
assertion issues the same query on every run and **failed** under the RT-1
verification mutant. The oracle, not the mutant, is what let it through.

**What actually happened.** The P0 fix traded one blindness for another.
`has_table_privilege` was blind to superusers but reported the **effective**
privilege, which includes PUBLIC and role inheritance. The `aclexplode` grantee-name
filter is superuser-proof and covers every privilege type, but sees only **direct**
grants. Neither oracle is complete alone; they are blind in opposite directions.

**Why it is graded P0, and how large it actually is.** Two limbs force the grade.
First, the protocol's taxonomy: a confirmed, executed, provably non-equivalent
survivor has no non-blocking classification — `equivalent` requires a proof of
behaviour preservation (false here) and `inconclusive` requires a judgement of
plausible equivalence (also false). Second, a false doc claim of the same shape round
1 charged in RT-1: the case's own header at lines 30-33 states that "A future
migration's GRANT is applied by `pnpm test:db:setup` on every container, so this case
genuinely fails on that regression" — measured FALSE for a `GRANT … TO PUBLIC`.

The arbiter should nonetheless size the real-world exposure as **bounded**:

- the realistic regression — a named grant to `anon` or `authenticated`, the only
  form Supabase's own tooling emits — is measurably caught;
- neither project carries a PUBLIC table ACL entry today (introspected read-only
  2026-09-07; both `relacl`s are `{postgres, anon, authenticated, service_role}`);
- no migration in this repo emits a PUBLIC table grant or a role-membership grant;
- the branch's own model suite, 117, keeps the complementary `has_table_privilege`
  form, so the house already owns the other half.

**Behavioural replacement (two clauses, no restructuring).** Either widen the grantee
predicate to admit `acl.grantee = 0` (PUBLIC) and
`pg_has_role('anon', acl.grantee, 'USAGE')` /
`pg_has_role('authenticated', acl.grantee, 'USAGE')`; **or** keep the ACL read and add
a `has_table_privilege` arm for the two client roles beside it. The pair is what makes
the case complete — and the second option restores the coverage the P0 fix removed
without reintroducing the superuser blindness, because the client roles are not
superusers.

## RT-8 — nothing forbids a subsequent `DISABLE ROW LEVEL SECURITY` (P2, open)

Journaled mutation M9 appends `ALTER TABLE job_outbox DISABLE ROW LEVEL SECURITY;`
immediately before `COMMIT`. **Suite: 6 passed / 0 failed.** The case at line 163
asserts the `ENABLE` statement is present and forbids `CREATE POLICY` and `FORCE`,
but not a later `DISABLE`; the statement parser never sees it either, because the
statement begins with `ALTER`.

Not equivalent — applied, the file leaves `relrowsecurity` false, exactly the staging
state the branch exists to remove. P2 rather than P1 because the catalogue case does
kill it once the container is re-provisioned (measured as the behind-head run above,
where that case failed first with the `BEHIND_HEAD` message), and CI provisions the
database fresh on every run. Same class round 1 filed as RT-5; the fix closed the
`GRANT` half and left the `DISABLE` half.

**Behavioural replacement.** One line beside the two absence assertions already there:
`expect(text).not.toMatch(/DISABLE ROW LEVEL SECURITY/i)`.

## RT-9 — a concatenated keyword evades both text checks (P2, open)

Journaled mutation M2 appends a `DO $$ … $$` block whose `EXECUTE` assembles the
keyword from two fragments. Verified valid SQL with a real effect **before**
classification — applied to the clone it writes `relacl
{test=arwdDxt/test,anon=arwdDxt/test}`. **Suite: 6 passed / 0 failed.** It defeats
check A because the dollar-quoted body is masked and check B because the keyword is
never spelled.

Recorded rather than charged: an adversarial-author construct, not an authoring
accident, and a migration-text guard's threat model is a future developer widening the
file. The catalogue case kills it on the next provision. No behavioural replacement is
proposed — a text guard cannot close this class. The honest fix is to scope the header
sentence at line 35 ("proves what migration 119 ITSELF may contain") to
literal-keyword constructs.

---

# Duty 4 — sibling search for the FIX's own patterns

**Patterns searched**, scope `src worker scripts`, exclusions: `node_modules`.

1. **`has_table_privilege` used as a privilege oracle** (the superuser-blind shape
   RT-1 removed). Hits: `migration-117-admin-audit-log.integration.test.ts:156-163`
   and `migration-076-judge-verdicts-governor.integration.test.ts:462-464`.
   **Neither carries the RT-1 defect** — read at
   `migration-117-admin-audit-log.integration.test.ts:148-180`, 117 asserts *only*
   `anon`/`authenticated` arms and no owner arm, and `has_table_privilege` is accurate
   for a non-superuser role. Zero siblings of the defect. (117 does, by the same
   token, catch the PUBLIC path RT-7 misses — the evidence that the house already owns
   the missing half.)
2. **`aclexplode` with a grantee-name filter** (the shape that produces RT-7). Hits:
   migration 119's suite only. **Zero siblings** — the pattern is new to this branch.
3. **A migration-text statement parser.** `topLevelStatements` is defined once and
   referenced once, both inside 119's suite; no shared helper, no importer. Fifty-five
   other files read migration text, none with a statement splitter. **Zero siblings.**

Three sound searches; two found nothing, and the one that found candidates cleared
them by reading the code. Nothing invented.

# Duty 5 — operational completeness

Unchanged from round 1 and re-checked against the fix hunks: the diff adds no
TypeScript, no worker code, no new terminal or swallowed failure path, and therefore
owes no rule row in `docs/runbooks/beta-launch-alerting.md`. The six-facet comparison
has no new signal to compare. A sound negative.

One apply-time failure mode is now *better* than round 1 recorded: because the
migration is wrapped and the ALTER is guarded, a lock-timeout under contention aborts
the whole transaction and leaves the pre-119 state intact rather than tearing between
the ALTER and the REVOKE. Measured — the H2 probe produced
`ERROR: canceling statement due to lock timeout` and no partial state.

# Not findings — verified and clean this round

- The migration is **idempotent and correct on both apply paths**. Applied twice to a
  pre-119 clone: first run enables RLS and strips the client ACL entries, second run
  is a true no-op.
- **`BEGIN`/`COMMIT` is house style, not a novelty** — 14 other migrations wrap,
  including 116, the one immediately before this.
- **Both intake copies are byte-identical** (SHA-256 recomputed this round).
- **The `78 -> 55` correction is exact**, re-measured independently.
- **The gate is GREEN at `90880ef7`** — `bash scripts/verify-gate.sh --review`, 31
  checks, all PASS, run after restoration and before this report existed.

# Authorizations

None. No finding on this run is `accepted-risk`.

# Appendix — out of scope, untriaged

Recorded because the scope rules require it to go somewhere, and deliberately **not**
in the findings table: this concerns unchanged code and this round was forbidden from
opening fronts against it.

- `src/lib/shared/__tests__/migration-076-judge-verdicts-governor.integration.test.ts:462-464`
  asserts `has_table_privilege('authenticated', 'public.judge_verdicts', …)` for three
  verbs only. Like 117 it is sound against the superuser problem, but like 117 it
  enumerates verbs rather than asserting the ACL, so a `GRANT TRUNCATE`-shaped
  widening would pass. The same trade-off RT-7 describes, pointing the other way.
  Untriaged; belongs to whoever picks up the RT-6 follow-up issue, which already owns
  the sibling-table sweep.
