# Red team — `fix/1301-migration-guard-execution`, round 2

**Status: CLEAR.** 13 mutations, 13 killed. 3 rows excluded with a recorded
reason. 19 findings, all disposed `fixed`, none open.

| | |
|---|---|
| Mode | feature |
| Risk | high |
| Round | 2 of 2 |
| Fork | `07738319cd5d7a78661ed1e3af07430bd84a8521` |
| Head | `9b4d1e864dab7c376d205f9cdc6a8ff65ff653c7` |
| Gate | GREEN at `476145667`, 45 of 45 rows |
| Budget | well inside the round's 20 minutes of measured test time |

Round 1 was the full pass and returned `OPEN_P0`. This round verifies the
fixes for all seventeen of its findings and reports two new ones **inside the
fix hunks** — which is what a round-2 pass is for. It opened no front against
unchanged code.

---

## What was mutated, and what happened

Every mutation targets `src/lib/shared/__tests__/helpers/migration-guard.ts`,
the module the seven suites are built on. Each was applied alone, measured
against exactly one named test, and restored before the next.

| # | Mutation | Target case | Outcome |
|---|---|---|---|
| R2-M01 | `rowDigest` → `NULL` for every relation | off-target row write | **killed** |
| R2-M02 | `pg_default_acl` query → `WHERE false` | view + default ACLs | **killed** |
| R2-M03 | relations query → `relkind IN ('r','p')` | view + default ACLs | **killed** |
| R2-M04 | `readLeakSentinel` → a constant | commit-leak detection | **killed** |
| R2-M05 | `schemaDefaultAcls: 'changed'` throw disabled | 'changed' proves the widening | **killed** |
| R2-M06 | `assertTableRemoved` loses its already-absent half | deliberate table removal | **killed** |
| R2-M07 | `schemaOnly` returns the whole table | 053 idempotence | **killed** |
| R2-M08 | `renderEntry` drops the definition | same-name policy change | **killed** |
| R2-M09 | `deriveColumnPrivileges` keeps non-column privileges | 117 client grants | **killed** (weak — see below) |
| R2-M11 | `schemaDefaultAcls: 'unchanged'` throw disabled | widened default ACL | **killed** |
| R2-M12 | entries CTE → `relkind IN ('r','p')` | view + default ACLs | **killed** |
| R2-M13 | columns rendering always `NOT NULL` | 048 column inventory | **killed** |
| R2-M14 | `deriveColumnPrivileges` narrows to `SELECT` | 117 client grants | **SURVIVED → fixed → killed** |

**R2-M09 is a weak kill and is recorded as one.** The mutant makes the SQL
itself invalid (`unrecognized privilege type: "DELETE"`), so the query fails
before any assertion reads the list. It proves the list reaches the database;
it does not prove the assertion inspects it. R2-M14 is the mutation that does,
and it is why R2-M09 was not left to stand alone.

**Three rows excluded, each with its reason.** The oracle-A literal pins this
fix pass added — 048's column inventory and primary key, the 048/051/117 table
comments, 053's behavioural `23514` probe — have the migration file as their
covering production surface, and `supabase/migrations/` is out of scope by this
skill's own rule: the database is provisioned before the run, so mutating a
migration changes nothing under test. They were verified live outside the
mutation protocol instead, by flipping one pinned literal in each of 048 and
117 and watching the case fail. Both were restored. The two corrected comments
in `live-db-suites-audit.ts` have no behaviour to mutate and were checked under
Duty 3.

---

## Findings

### RT2-1 — P1, Duty 1, **fixed**

Deriving the column-privilege set closed RT-7's growth blind spot and opened a
shrink blind spot.

`deriveColumnPrivileges` narrowed to return `SELECT` alone left **every caller
passing**. Each asserts only that the client roles hold none of whatever the
function returns, so a probe that returns less simply checks less. The call
sites' own guard was `expect(columnPrivileges.length).toBeGreaterThan(0)`,
which the mutant satisfies. A migration granting `INSERT (actor_user_id)` to
`anon` would have passed.

Arbiter: the mutation is semantically meaningful for the tested behaviour, is
not equivalent, and is not on a branch the test never executes.

Fixed by `COLUMN_PRIVILEGE_FLOOR = 4` inside the helper, which throws below it,
so both call sites inherit it and neither can forget it. Re-measured at this
HEAD: killed, with the floor naming what the probe returned. Recorded as
deviation **D16**.

The general shape is worth keeping: **a literal cannot grow; a derivation can
shrink.** Swapping one for the other trades a known blind spot for a new one
unless a floor comes with it.

### RT2-2 — P1, Duty 3, **fixed**

The handoff document described the run as stopped at round 1 with all seven fix
workstreams pending, after all seven had landed and the gate was green.

`prevalidate-plan` PASSED on the file — no citation was stale. The false claim
was the *state description*, which no citation checker can see. A resumed
session bootstraps from this file first and would have re-done finished work.

### Round 1's seventeen findings — all `fixed`

Each carries its round-2 verification in `findings.json`. In brief: the P0
(RT-1) is replaced with a measured list; the four catalogue blind spots
(RT-2..RT-5) are closed and each has a killing mutation; the false or stale
documentation claims (RT-6, RT-8, RT-9, RT-10, RT-16) are corrected against
measurement rather than restatement; and the self-confirming or vacuous
assertions (RT-7, RT-11..RT-15, RT-17) are replaced with assertions that can
fail.

---

## Duty 3 — docs vs reality

`prevalidate-plan.py` PASS on the plan, the deviations, the handoff and
`weakened-checks-reasons.md`. 10 citations and 27 fixtures resolved, 2 commit
references current, 0 stale. RT2-2 is the finding a citation checker cannot
produce.

## Duty 4 — missed sibling cases

Searched, with scope and exclusions recorded:

| Pattern fixed | Search | Result |
|---|---|---|
| `expect(<literal>).toHaveLength(<its own length>)` | every `*.test.ts(x)` under `src/`, `scripts/`, `worker/`, matching a local literal against its own asserted length | **0 remaining** — the two fixed were the only instances |
| `not.toEqual([])` as an absence proxy | same scope | 3 live instances. One is 117's, which also carries the real equality, so the proxy is a redundant message rather than the contract. Two are outside this branch's surface (`agents/operator/__tests__/schema.test.ts`, `demos/__tests__/select-qualifying.test.ts`) and are unchanged code — out of scope for a round-2 pass, recorded for whoever touches them |
| `BEHIND_HEAD` on a post-re-apply assertion | the seven suites | **0 remaining** |
| a comment claiming a character "cannot occur" | the changed surface | **0 remaining**; the two hits are the retraction itself and a comment about vacuity |
| a count on a table the suite states is empty | the seven suites | 1 sibling class, 057's `assertNoNullsBeforeDegrade`. Judged NOT vacuous: it is a precondition guarding the degrade, not an assertion of behaviour, and the degrade's landing is proven separately |

## Duty 5 — operational completeness

No operator-actionable terminal or swallowed failure path is added by this
diff. The new throws (`deriveColumnPrivileges`, `deriveTablePrivileges`,
`readLeakSentinel`, `assertTableRemoved`) are test-harness failures surfaced to
a developer through a failing suite, not production signals, so no
`beta-launch-alerting.md` rule row is owed.

---

## Method notes, recorded rather than left unsaid

**The journal was hand-resolved once.** Restoring between same-file mutations
by re-applying the original through `mutate` writes a REVERSE journal entry, so
each subsequent entry's "original" is the previous mutant. `finalize` then
walks that chain, restores one mutant into the working tree and aborts on the
rest — and every further `finalize` call restores one more. The tree was
restored with `git checkout -- <path>`, verified byte-identical to HEAD's blob
(`33e36cd8d8ee`), and the satisfied entries were closed with that verification
recorded on each. Later mutations restored by `git checkout` instead, which
leaves the journal chain intact. Anyone driving this runner over several
mutations of ONE file should do the same.

**Restoration is verified, not asserted.** After the final `finalize`:
`git status --porcelain` empty outside this run's two artifacts, 43 journaled
process groups reaped, dotenv closed and `.env.local` back at its 322 lines,
and the container carrying 0 stray probe or leak relations, 0 `pg_default_acl`
rows and 0 views in `public`.

**Baselines.** Every target case was green at the measured HEAD before its
mutation: the nine live-DB files pass 64 of 64 and the harness unit file 20 of
20, re-confirmed at each of the three HEADs this round touched.
