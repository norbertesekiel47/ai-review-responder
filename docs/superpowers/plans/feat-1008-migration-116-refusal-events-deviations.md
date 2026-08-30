# Deviations — feat/1008-migration-116-refusal-events

Every entry is something the ticket or the plan did not anticipate. Step 6
reads this file end to end and logs an ACCEPT / RE-PLAN verdict per entry.

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

**Verdict:** _pending step 6._

---

## D2 — the four LOCKED terms and ADR 0023 are not on `main`

**When:** grilling, before setup.

`CONTEXT.md`'s `## Refusal Log` block and
`docs/adr/0023-refusal-log-owner-safe-projection.md` exist only on branch
`feat/refusal-log`, and are stale in three ways: six lanes (now seven), seven
categories (now eight), and "adds no migration".

**Resolution:** owner-approved, both carried here, corrected.

**Verdict:** _pending step 6._

---

## D3 — "sixteen columns" is wrong; the table has twelve

**When:** grilling.

Issues #1008 and #1001 both say sixteen. The locked DDL block in #1001
declares twelve. The DDL block is code-shaped and complete, so it wins.

**Verdict:** _pending step 6._

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
corrected C5, then nine probe rows:

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

**Verdict:** _pending step 6._

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

**Verdict:** _pending step 6._

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

**Verdict:** _pending step 6._

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

**Verdict:** _pending step 6._

---

## D8 — `tenant-tables.ts:158` was a stale citation

**When:** step 3, codex plan review round 1.

`solicitation_batches` is at **line 154**; line 158 is
`solicitation_suppressions`. The 158 figure came from `.claude/CLAUDE.md` and
issue #1001 and was carried forward without checking. Plan corrected.

**Verdict:** _pending step 6._

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

**Verdict:** _pending step 6._

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
`tenant-tables.ts:158`. Round 1 corrected only the plan's copy. Now 154 in
both.

**Verdict:** _pending step 6._
