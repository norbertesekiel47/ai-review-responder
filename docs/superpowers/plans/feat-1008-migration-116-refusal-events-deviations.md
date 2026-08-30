# Deviations — feat/1008-migration-116-refusal-events

Every entry is something the ticket or the plan did not anticipate. Step 6
reads this file end to end and logs an ACCEPT / RE-PLAN verdict per entry.

## Step 6 triage — re-read 2026-08-30 post-rebase, gate GREEN 28/28

**Sixteen entries. Sixteen ACCEPT, zero RE-PLAN.** No deviation invalidates a
locked intake decision, so the abort criteria are not met on that arm. Two
entries reversed a stated step of ticket #1008 (D6, D10a) and both were
surfaced to the owner rather than absorbed; one spent the second surface
amendment (D13) and carries explicit owner sign-off.

| # | What it was | Verdict | Why, in one line |
|---|---|---|---|
| D1 | The ticket's "nothing that names the table in code" cannot hold | **ACCEPT** | Forced by a migration-file parser, not by scope creep; owner approved both purge arms during grilling, and the gate is green with them. |
| D2 | The four LOCKED terms and ADR 0023 live only on the parked branch | **ACCEPT** | Owner approved carrying them; all three stale claims corrected in place and flagged as corrections. |
| D3 | "Sixteen columns" is wrong; the table has twelve | **ACCEPT** | The locked DDL block declares twelve, and test title 2 now pins the twelve-column contract exactly — an extra column fails. |
| D4 | The LOCKED C5 expression admits the row it exists to forbid | **ACCEPT** | Strengthens the lock's stated intent rather than changing it; reproduced against a live database, and titles 12 and 13 pin both directions. |
| D5 | C1's `IS TRUE` wrapper is not provable by inserting a row | **ACCEPT** | The column CHECK rejects an unmapped lane first, so the assertion had to be structural; title 7 reads `pg_get_constraintdef`. |
| D6 | Merge-before-promotion terminally fails purges | **ACCEPT** | Verified in `PurgeWorker.ts`; superseded in part by D10a, and the final order is in the plan's Step 8. |
| D7 | `TENANT_TABLES` membership forces an `rls-inventory.md` row | **ACCEPT** | Auto-approved surface amendment 1 (≤2 files inside a covered tree); `rls-audit` now passes. |
| D8 | `tenant-tables.ts:158` was a stale citation | **ACCEPT** | Corrected — and then RE-staled by this very change (see D14). Now cited by symbol, not by line. |
| D9 | The project bash-write guard blocks read-only `sed -n` | **ACCEPT** | Real, and outside this feature's surface; cost accuracy rather than a round. **Promote at step 8.** |
| D10 | Round 2 found four defects introduced by my own round-1 fixes | **ACCEPT** (all four) | Each verified against the code before fixing: the runbook for D10a, the inventory parser for D10b, the surface for D10c. |
| D11 | `TENANT_TABLES` is two structures, and editing one is silently wrong | **ACCEPT** | Typecheck stayed clean while the completeness test stayed red. **Promote at step 8.** |
| D12 | The C1 test asserted the absence of something Postgres adds | **ACCEPT** | A test defect, not a migration defect; the fix asserts the deparsed NULL is PRESENT, which is the stronger claim. **Promote at step 8.** |
| D13 | Surface amendment 2 tripped the abort criterion | **ACCEPT** | Surfaced to the owner, who chose amend-and-continue; all three added paths are forced registry rows, and the gate was otherwise green when it fired. |
| D14 | The citation-fixing deviation staled its own citation | **ACCEPT** | A line citation edited by the same commit that moved the line; now cited by symbol. |
| D15 | The fix for D14 reproduced D14, five times | **ACCEPT** | The meta-pattern: a fact stated in two artifacts, corrected in only one — five times over. A doc fix here is a SWEEP. |
| D16 | The write-site split point is unsettled, and two attempts to settle it were wrong | **ACCEPT** | 3-to-3, not 3-to-1; resolved by DECLINING to resolve it — #1009's PR is what knows. |

**Five lessons queued for step 8 promotion** (D9, D11, D12, D13's
generalisable half — the four-registry chain a new tenant table forces — and
**D15**, the strongest: in this repo a documentation fix is a SWEEP, never an
edit, because the artifacts duplicate facts deliberately.)

**D14, D15 and D16 were added after the red-team passes and are triaged in the
rows above. Full findings:
`docs/reviews/red-team/feat-1008-migration-116-refusal-events-cbbac6/`.**

**This table has itself been a D15 casualty twice** — it claimed "Thirteen
entries" while D14 and D15 sat below it untriaged, and the count went stale
again when D16 landed. A new deviation adds a ROW here, not just a section.

---

## D14 — the citation-fixing deviation staled its own citation

**When:** step 7.5, red-team Duty 3 (RT-04).

D8 exists because `tenant-tables.ts:158` was a stale line citation; it was
corrected to 154. Then **this change's own `refusal_events` entry shifted that
line**: `solicitation_batches` moved 154 → 160, `solicitation_suppressions`
158 → 164, and the disposition row 361 → 368. So the deviation whose entire
purpose was to fix a stale line number left a stale line number, in the same
commit that created the staleness.

The lesson is not "check line numbers again". It is that **a line citation
into a file the same change edits cannot be correct at both ends of the
change**, so the form is wrong rather than the value. Every such citation in
the plan and this file now names the SYMBOL — the map key, the `case` label,
the array entry — which the edit cannot move.

A third lesson for step 8 promotion, alongside D9, D11 and D12.

**Verdict:** ACCEPT, fixed.

---

## D15 — the fix for D14 reproduced D14, five times

**When:** step 7.5, red-team round 2 (RT-04, RT-06, RT-12, RT-13, RT-14,
RT-15).

D14's whole content is: *a fact stated in two artifacts, corrected in one.*
The commit that wrote D14 then did exactly that, five more times:

| Fact | Corrected in | Left stale in |
|---|---|---|
| line citations → symbol citations | the plan | the **intake** — while D14 claimed both were done |
| "nine probe rows" → eight | the deviations file | `arch-review-log.md` |
| "22 promised tests" → 23 | nowhere | `arch-review-log.md`, and `plan.md`'s "twenty-two" |
| the §II.5 over-attribution | `migrations-log.md` | `arch-review-log.md` |
| the ADR's writer table | rewritten | dropped `unsubscribed`, its eighth member |

**Why it kept happening, and it is not carelessness.** Each correction was
made where the finding POINTED — a reviewer cites one `file:line`, and fixing
that line reads as done. The artifacts here duplicate deliberately (the
migrations log, the arch-review log, the plan, the intake and the ADR each
restate the same decisions for a different reader), so every duplicated fact
is a place a single-site fix leaves a contradiction.

**The method that actually works, applied for round 2's fixes:** for each
finding, grep every artifact for the FACT, not the cited line, and fix all
hits in one pass. That is how these six were closed, and re-running those
greps is how the next reader should check them.

**Queued for step 8 promotion** as the fourth lesson: in this repo a
documentation fix is a *sweep*, never an edit.

**Verdict:** ACCEPT, fixed.

---

## D1 — the ticket's "nothing that names the table in code" cannot hold

**When:** grilling, before setup.

`accountLinkedTablesFromMigrations()`
(`src/lib/account-offboarding/__tests__/table-disposition.test.ts`) parses
migration SQL for `account_id … REFERENCES accounts(id)`. The moment
`116_refusal_events.sql` lands, the inventory test fails unless
`refusal_events` is classified. The classification then forces two SQL sites:

1. `verificationQuery` in `purge-verification.ts` — without a branch,
   `verifyAccountOffboardingPurge` throws
   `missing_purge_verification_sql:refusal_events` on every purge.
2. `runContentPurgeStage` in `purge-stages.ts` — `refusal_events` has no
   cascade path (its FKs are to `accounts` and `businesses`, both
   `retain_deidentified` and never deleted), so a `hard_delete` /
   `must_be_absent` classification with no `DELETE` is a classification the
   purge cannot honor.

**Resolution:** owner-approved, both arms land in this slice.

**Verdict:** see the triage table at the top of this file.

---

## D2 — the four LOCKED terms and ADR 0023 are not on `main`

**When:** grilling, before setup.

`CONTEXT.md`'s `## Refusal Log` block and
`docs/adr/0023-refusal-log-owner-safe-projection.md` exist only on branch
`feat/refusal-log`, and are stale in three ways: six lanes (now seven), seven
categories (now eight), and "adds no migration".

**Resolution:** owner-approved, both carried here, corrected.

**Verdict:** see the triage table at the top of this file.

---

## D3 — "sixteen columns" is wrong; the table has twelve

**When:** grilling.

Issues #1008 and #1001 both say sixteen. The locked DDL block in #1001
declares twelve. The DDL block is code-shaped and complete, so it wins.

**Verdict:** see the triage table at the top of this file.

---

## D4 — plan review round 1 found a real defect in the LOCKED C5 expression

**When:** step 3, codex plan review round 1, `VERDICT: REVISE`.

**Not a plan defect — a schema defect in the locked DDL.** #1001's C5 reads:

```sql
(refusal_source = 'policy_gate_held'
   AND all_refusal_codes IS NOT NULL
   AND cardinality(all_refusal_codes) > 0
   AND refusal_code = ANY(all_refusal_codes))
OR (refusal_source <> 'policy_gate_held' AND all_refusal_codes IS NULL)
```

Take `refusal_source='policy_gate_held'`, `refusal_code='winner'`,
`all_refusal_codes=ARRAY['different', NULL]`. `'winner' = ANY(…)` finds no
TRUE and at least one NULL, so it returns **NULL**. The first arm collapses to
NULL, the second is FALSE, and `NULL OR FALSE` is NULL. **A CHECK is satisfied
by NULL, so Postgres accepts the row.** C5 admits the exact row it exists to
forbid — a `policy_gate_held` row lying about its own precedence.

This is the same NULL-fall-through class C1 already guards with `IS TRUE`, in
a constraint that did not get the wrapper.

**Correction, two clauses:**

1. Wrap the whole C5 disjunction in `IS TRUE`, matching C1 and migration 111's
   idiom. NULL then evaluates FALSE and the row is rejected.
2. Add `array_position(all_refusal_codes, NULL) IS NULL` to the
   `policy_gate_held` arm. A NULL array member is a writer bug, and #1001's own
   standard is to make an invalid combination unrepresentable rather than
   merely unlikely.

This **strengthens** C5 in the direction the lock intended and invalidates no
locked decision, so it is a correction, not an amendment. Recorded here and
surfaced to the owner.

**Proven against real Postgres, not reasoned about.** Two `TEMP` tables in the
local test container, one carrying #1001's locked C5 and one carrying the
corrected C5, then eight probe rows:

| Row | Locked C5 | Corrected C5 | Correct? |
|---|---|---|---|
| `policy_gate_held`, code `winner`, codes `['different', NULL]` | **ACCEPTED — the bug** | rejected | ✅ |
| `policy_gate_held`, code `winner`, codes `['winner', NULL]` | — | rejected | ✅ |
| `policy_gate_held`, code `winner`, codes `['winner','other']` | — | accepted | ✅ |
| `policy_gate_held`, code `winner`, codes `[]` | — | rejected | ✅ |
| `policy_gate_held`, code `NULL`, codes `['winner']` | — | rejected | ✅ |
| `batch_halted`, code `admin_halt`, codes `NULL` | — | accepted | ✅ |
| `batch_halted`, code `admin_halt`, codes `['x']` | — | rejected | ✅ |
| `policy_gate_held`, code `winner`, codes `['winner','a_future_code']` | — | accepted | ✅ |

All five rejections cite the constraint by name. The unknown-member row is
admitted, which is the point: the array's member vocabulary is owned by
TypeScript, never by a database CHECK.

C1–C4 were checked for the same NULL class and are clean. C1 already carries
the `IS TRUE` wrapper. C2, C3 and C4 compare two expressions that are each
never NULL (`refusal_source` is `NOT NULL`, and `IS NULL` never yields NULL).

**Verdict:** see the triage table at the top of this file.

---

## D5 — C1's `IS TRUE` wrapper is not provable by inserting a row

**When:** step 3, codex plan review round 1.

The plan's Task 0 promised a behavioural C1 fall-through test. It cannot
exist: the standalone `refusal_source` CHECK rejects every unmapped lane
before C1 is evaluated, so no reachable row exercises the fall-through. A C1
shipped with the correct seven arms and **no** `IS TRUE` wrapper would pass
every behavioural test.

**Correction:** the wrapper is asserted **structurally**, by reading
`pg_get_constraintdef` and matching the `IS TRUE` wrapper, not behaviourally.
Test title 7 in the amended `tests_to_add`.

**Verdict:** see the triage table at the top of this file.

---

## D6 — the merge-before-promotion window is not self-healing

**When:** step 3, codex plan review round 1.

The intake claimed a 42P01 from `runContentPurgeStage` "surfaces as a
retryable purge failure … and clears the moment 116 is promoted". **False.**
`worker/jobs/account-offboarding/PurgeWorker.ts:96-105` retries a bounded
number of times, then calls `markPurgeTerminalFailure` **and**
`markOutboxFailed`. Promoting 116 afterwards does not reopen that offboarding;
it needs a manual re-drive.

**Correction — the ship ordering changes.** Issue #1008's "two-step life"
(merge, then promote) was written on the assumption that no deployed code
names the table. D1 broke that assumption. This slice therefore uses the
repository's standard RISK = high lane instead, in which the migration
**precedes** the code in every environment:

1. Apply 116 to the **staging** Supabase project.
2. Push the branch to `staging`; the staging worker deploys against a database
   that already has the table.
3. Apply 116 to the **production** Supabase project.
4. Merge the PR to `main`; production deploys against a database that already
   has the table.
5. Land the promotion change removing the LOCAL-ONLY marker and recording both
   promotion lines.

The window closes to zero. #1009 was gated on "promotion, not merely merge";
under this ordering the two coincide, so #1009 unblocks at merge.

**This reverses a stated step of ticket #1008.** Surfaced to the owner as a
map-level correction.

**Superseded in part by D10.** Revision 2's ordering put production DDL ahead
of the PR, which fixed the 42P01 window by creating a worse one. The final
order is in the plan's Step 8: CI green first, then staging DDL, then the
staging ride, then owner approval, then production DDL, then merge.

**Verdict:** see the triage table at the top of this file.

---

## D7 — `TENANT_TABLES` membership forces an `rls-inventory.md` row

**When:** step 3, codex plan review round 1.

`scripts/ci/__tests__/rls-audit.test.ts:42-49` asserts
`REQUIRED_RLS_TABLES === TENANT_TABLES` and then requires
``| `<table>` |`` to appear in `docs/security/rls-inventory.md` for every
member. Task 2's registry entry therefore forces a row in a file the intake
did not list.

**Surface amendment 1 of 2.** Two paths added:
`docs/security/rls-inventory.md` and
`worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts` (the latter
mocks `sql` for the purge stages and may need the new `DELETE`). Both sit
inside directory trees the surface already covers, so this is auto-approved
under step 2's amendment rule. Both intake copies updated.

**Verdict:** see the triage table at the top of this file.

---

## D8 — `tenant-tables.ts:158` was a stale citation

**When:** step 3, codex plan review round 1.

`solicitation_batches` is at **line 154**; line 158 is
`solicitation_suppressions`. The 158 figure came from `.claude/CLAUDE.md` and
issue #1001 and was carried forward without checking. Plan corrected.

**Verdict:** see the triage table at the top of this file.

---

## D9 — the project bash-write guard blocks read-only `sed -n` from codex

**When:** step 3, codex plan review round 1.

`.claude/hooks/bash-write-guard.sh` blocked several of codex's commands with
`BLOCKED: Bash write to repository source during a /feature run — sed -i
against '.claude/CLAUDE.md'` when the actual command was
`sed -n '1,260p' .claude/CLAUDE.md` — a read. The guard's parser sees `sed`
plus a repo path and does not distinguish `-n … p` from `-i`. Codex worked
around it and still produced a complete review, so this cost accuracy, not
the round.

Not fixed here: the guard is outside this feature's edit surface. Recorded so
the lesson can be promoted at step 8.

**Verdict:** see the triage table at the top of this file.

---

## D10 — plan review round 2: my own fixes introduced four defects

**When:** step 3, codex plan review round 2 (verification-only),
`VERDICT: REVISE`. Six of round 1's seven findings verified fixed; R1-C3
partial. Report:
`docs/reviews/feat-1008-migration-116-refusal-events/plan-review-r2.md`.

**D10a — CRITICAL. Revision 2's ship order put production DDL ahead of CI.**
D6 fixed the 42P01 window by applying the migration first in every
environment — and put unreviewed, CI-ungated SQL on the production database
to do it. `docs/runbooks/deployment-guide.md` §II.5 opens the PR first for
exactly this reason. Two properties must hold together: the migration
precedes the code, AND no SQL reaches production before CI is green and the
owner has approved. The plan's Step 8 now carries the only order giving both.

**D10b — MAJOR. The rollback could not remove the disposition row.**
`accountLinkedTablesFromMigrations()` parses migration files for
`account_id … REFERENCES accounts(id)`. It reads CREATE statements, not net
schema, so a migration 117 `DROP` does **not** release the row. Removing the
row while 116 is checked in fails CI; keeping it while the table is dropped
leaves purge code naming a missing relation. The rollback is therefore a **PR
revert**, never a down migration — the revert removes the migration file and
every dependent row together. An empty table with no reader, writer or
registry entry is inert, so leaving `refusal_events` in the database is the
default; dropping it is optional and happens out of band, after the revert
has deployed. `rollback_plan` rewritten.

**D10c — MAJOR. Title 19 had no authorized home.** The plan sent it to
`scripts/ci/__tests__/tenant-tables.integration.test.ts`, which is not in
`allowed_edit_surface`. Widening for one assertion would have spent the
second and last amendment of the abort budget. **Rehomed instead**: the
assertion imports `TENANT_TABLES` and reads one key, needs no database, and
belongs beside the schema it describes — the migration-116 suite. A rehome is
a deviations entry, not an amendment, so the budget still stands at 1 of 2.

**D10d — MINOR ×2.** Title 1 had no assertion style (it is structural —
`pg_class.relrowsecurity` plus `pg_policies`); and "promotion and merge
coincide" was ambiguous. Both fixed; Step 8 now names step 7 as the exact
point #1009 unblocks.

**Appendix finding, accepted anyway:** the intake still cited
`tenant-tables.ts:158`. Round 1 corrected only the plan's copy. Both now cite
the `solicitation_batches` KEY rather than a line number — see D14 for why the
line-number form could not survive this change.

**Verdict:** see the triage table at the top of this file.

---

## D11 — `TENANT_TABLES` is two structures, and editing one is silently wrong

**When:** Task 2.

`scripts/ci/tenant-tables.ts` exports the `TENANT_TABLES` **array** of table
names and, separately, a **scope-column map**. The first edit added only the
map entry. Everything typechecked, and the live-DB completeness test stayed
red with `expected [ … 43 tables ] to include 'refusal_events'`.

Both structures need the entry. The plan said "add to `TENANT_TABLES`" and
cited the map's line, which is exactly the ambiguity that produced the miss.

**Verdict:** see the triage table at the top of this file.

---

## D12 — the C1 wrapper test asserted the absence of something Postgres adds

**When:** Task 1, first run of the eval against the real migration.

Task 0 authored title 7 as `expect(definition).not.toContain('ELSE')`, on the
reasoning that the migration writes no `ELSE` and the fall-through is what
`IS TRUE` defends. The migration indeed writes none — but **Postgres
normalises the `CASE` and deparses the implicit fall-through as
`ELSE NULL::boolean`**, so `pg_get_constraintdef` always contains it.

Asserting its ABSENCE tests pg's deparser rather than this constraint.
Asserting its PRESENCE is the stronger claim, because it names the exact
value the wrapper exists to defeat. Changed to
`expect(definition).toContain('ELSE NULL::boolean')`, keeping the
`END … IS TRUE` assertion beside it. The two together are the proof.

A test defect, not a migration defect — and one that only a real database
could have surfaced.

**Verdict:** see the triage table at the top of this file.

---

## D13 — surface amendment 2, and the abort criterion firing as a false positive

**When:** the first full green-path gate run, after Tasks 1–4.

`ci:merge-ledger` requires any PR touching production or governance files to
add a line to `.claude/reference/arch-review-log.md`. That file was outside
`allowed_edit_surface`, so the edit-surface guard blocked the edit and
demanded sign-off.

**This is surface amendment 2, which trips the workflow's abort criterion**
("a 2nd amendment of `allowed_edit_surface` → stop patching, post-mortem,
tear the branch down, restart at step 1").

**Surfaced to the owner rather than routed around, and the owner chose to
amend and continue.** The reasoning recorded for audit: the abort rule exists
to catch a feature whose scope was mis-declared. This is not that. All three
added paths — `docs/security/rls-inventory.md`,
`worker/jobs/account-offboarding/__tests__/PurgeWorker.test.ts` and
`.claude/reference/arch-review-log.md` — are forced consequences of the one
decision the owner approved during grilling (add the table), each surfaced by
a CI audit rather than by scope creep, and each is a registry row rather than
behaviour. The gate was otherwise fully green at the moment it fired.

**The generalisable lesson, for promotion at step 8:** a new tenant table in
this repo forces a chain of four registry files, and the chain is not
discoverable from any one document. `TENANT_TABLES` (two structures) →
`docs/security/rls-inventory.md` → `TABLE_DISPOSITIONS` → a
`verificationQuery` arm and a `runContentPurgeStage` DELETE, plus
`arch-review-log.md` for the merge itself. An intake that declares a new
table should list all of them up front.

**Verdict:** see the triage table at the top of this file.


## D16 — the write-site split point is unsettled, and my first two attempts to settle it were both wrong

**Found by:** red-team round 1 (RT-12, P2). **Corrected twice** — round 2's
RT-22 (P1) disproved the correction, on its own evidence.

Eleven Refusal write sites in total. Where the FIRST one lands is stated two
ways across this branch's artifacts, and **they split 3-to-3**:

| Says #1010–#1013 (all eleven) | Says #1009 + ten |
|---|---|
| `.feature/intake.json` `non_goals[1]` | `supabase/migrations/116_refusal_events.sql` header |
| `docs/superpowers/plans/…-intake.json:8` (tracked mirror) | `.claude/reference/migrations-log.md:2500` |
| `docs/superpowers/plans/…-plan.md:435` | `.claude/reference/arch-review-log.md:1421` |

**Two wrong attempts, recorded because the method failed twice, not once.**

1. The first fix edited the migration header to match the intake, treating the
   sha-locked contract as authoritative. It did not check for other copies.
   Two existed.
2. The second reversed that, and justified it as "3-to-1 across artifacts
   written at different times, so one imprecise phrase beats three independent
   errors". **Both halves of that justification are false.** It is 3-to-3, not
   3-to-1 — the tracked intake mirror and the plan carry the same reading, and
   `red-team-status.mjs:638` hashes only `.feature/intake.json`, so the mirror
   is a copy the lock does not cover. And the three are not independent:
   `git log -S` shows the migration header and `migrations-log.md` were written
   by the SAME commit `341f1cb9`, and `arch-review-log.md` was created stating
   the other reading at `7378e68a` and converted 36 minutes later at `5b1975eb`
   because a review told it to match. One author act plus one conversion.

**Verdict: ACCEPT — by declining to resolve it.** This is forward sequencing
inside a declared non-goal. No code in this diff reads it, which is why the
pass graded it P2 both times. #1008 is not the change that knows the answer;
#1009's PR is. So every artifact this branch may edit now states the total
(eleven) and marks the split point unsettled with a pointer here. **The two
intake copies are left exactly as written** — the contract is locked, and
editing the tracked mirror would diverge it from `.feature/intake.json`, which
the resume protocol treats as a red flag requiring owner reconciliation.

**The lesson, and it is not D15's.** D15 says a doc fix is a sweep. This says
something narrower and sharper: **run the sweep BEFORE choosing the edit
direction, not after.** Both wrong attempts here came from picking a winner
from an incomplete count of the copies. Counting first would have shown 3-to-3
and that no winner was available.

**CLOSED by #1009 — the first Refusal write site lands there.**
`autonomy_suspended`, one site, inside `suspendAccountAutonomy`, shipped with
the insert helper; the other ten across #1010–#1013. The count above did not
break the tie and could not: a 3-to-3 split is the signal that the deciding
evidence sits OUTSIDE the artifacts being counted. Two locked decisions predate
every row of the table above — **#1004 fixed the slice order verbatim**
(*migration 116 alone → helper + kill switch + `autonomy_suspended` → …*), and
**#1009's ticket body §5 is headed "First caller — `autonomy_suspended`
(1 site)"**. The left-hand column is not wrong so much as about a different
subject: "#1010–#1013" originates in this branch's intake `non_goals`, which
was enumerating what **#1008** excluded, and every write site is outside #1008's
surface — true about #1008 and silent about #1009. The third ground stated
above, that a helper with zero callers is dead code this repo gates on, points
the same way. **Nothing in the table above is edited, and neither is
`116_refusal_events.sql`**: each records what its own change knew when it was
written, and the migration header's "NOT SETTLED **HERE** … #1009's PR is what
settles it" stays true forever. This paragraph is the only addition, so that a
reader arriving on any pointer to D16 finds the answer at the end of it.
