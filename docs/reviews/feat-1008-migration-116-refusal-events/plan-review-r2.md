I’m using the repository’s `verify-spec` workflow because this is a constrained plan re-review. I’ll keep the audit read-only, trace only the round-1 findings and claimed fixes, and separate unrelated observations into the appendix.

The verification skill normally keeps an incremental `/tmp` findings file, but your “read-only, do not edit any file” constraint overrides that, so I will not create it. I’m checking the worktree state first, then I’ll read the revised artifacts, the round-1 report, and only the code/runbook evidence needed for the challenged findings.

The worktree is dirty in exactly the review artifacts under audit: the revised plan and deviations are untracked, and the intake is modified. I’m therefore evaluating the on-disk revisions the user named—not claiming they are committed at HEAD. The skill’s >15-item rule also applies to the 22-title completeness check, so I’ve split that bounded check from the SQL NULL analysis and deploy-order consistency while I independently inspect the source documents.

The corrected SQL is internally sound for the requested NULL cases, and the deploy-before-code principle closes the original `42P01` window. I’ve also confirmed issue #1008 really did prescribe merge-then-promote; the deviations file explicitly records and justifies reversing that assumption. I’m now resolving two narrower completeness questions in Task 0 and checking the exact deployment-runbook sequencing before fixing the verdict.

## FIX VERIFICATION:

| Finding ID | Addressed | Evidence |
|---|---|---|
| R1-C1 | Yes | Title 7 is structural and reads `pg_get_constraintdef`; the plan correctly explains why behavioral proof is unreachable. [Plan:72](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:72) |
| R1-C2 | Yes | C5 includes both required clauses and is sound for all requested rows. C1–C4 have no equivalent NULL fall-through. [Plan:173](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:173), [Plan:201](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:201) |
| R1-C3 | Partial | Migration-before-code closes the staging and production `42P01` windows, and code-before-DROP is the correct rollback dependency direction. However, the rewritten deploy and rollback procedures contain material defects below. [Plan:385](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:385), [Intake:100](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-intake.json:100) |
| R1-M4 | Yes | Task 2 names `docs/security/rls-inventory.md`, which is now authorized by `allowed_edit_surface`. [Plan:258](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:258), [Intake:67](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-intake.json:67) |
| R1-M5 | Yes | Task 1 supplies all twelve columns, the closed vocabularies, C1–C5, both real FKs, and all three exact indexes. Together with its transaction/comments/RLS instructions, it is implementable without issue #1001. [Plan:120](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:120) |
| R1-M6 | Yes | Task 3 correctly states that the only FKs are to `accounts` and `businesses`, both retained and neither cascading. [Plan:295](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:295) |
| R1-m7 | Yes | The plan cites line 154, and HEAD has `solicitation_batches` at exactly line 154. [Plan:268](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:268), [tenant-tables.ts:154](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/scripts/ci/tenant-tables.ts:154) |

C5 row walk:

| Row | Result | Correct? | Reason |
|---|---|---|---|
| a | Reject | Yes | NULL-member clause fails. |
| b | Reject | Yes | NULL members remain forbidden even when the winner is present. |
| c | Accept | Yes | Nonempty, NULL-free, and contains the winner. |
| d | Reject | Yes | Cardinality is zero. |
| e | Reject | Yes | C4 rejects it; C5 also cannot evaluate `IS TRUE` with a NULL winner. |
| f | Accept | Yes | A non-policy lane correctly carries a NULL array. |
| g | Reject | Yes | A non-policy lane may not carry an array. |

C1’s wrapper totalizes nullable comparisons; C2 compares two `IS NULL` booleans; C3 and C4 combine total NULL predicates with the `NOT NULL` `refusal_source`. None can pass through SQL NULL.

## FIX-INTRODUCED DEFECTS:

| Severity | Location | Finding |
|---|---|---|
| CRITICAL | [Plan:389](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:389) | Step 8 applies both staging and production DDL before opening the PR or confirming CI. This contradicts the repository workflow—open PR first, then stage and verify, then merge—and exposes production to unreviewed, CI-ungated SQL. [Deployment guide:1144](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/runbooks/deployment-guide.md:1144) |
| MAJOR | [Intake:100](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-intake.json:100) | The rollback cannot remove the disposition row as claimed. The inventory test permanently discovers `refusal_events` from migration 116’s `CREATE TABLE` and does not account for a later migration 117 `DROP`; removing the row fails CI. Retaining it leaves verification/purge code referring to a dropped table. The rollback needs an explicit inventory/parser strategy. [Inventory test:46](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/src/lib/account-offboarding/__tests__/table-disposition.test.ts:46) |
| MAJOR | [Plan:87](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:87) | The intake has 22 unique titles, but title 19 is assigned to `tenant-tables.integration.test.ts` “or a unit peer,” and neither option is authorized by `allowed_edit_surface`. Task 0 therefore cannot author all 22 promised tests within the intake’s surface. [Intake:53](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-intake.json:53) |
| MINOR | [Plan:72](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:72) | The assertion-style table says every title uses a mapped style, but covers only titles 2–18; title 1 has no assertion-style assignment. |
| MINOR | [Plan:42](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:42) | The plan and D6 say promotion and merge “coincide,” but Step 8 separates production schema application, merge, and the later LOCAL-ONLY promotion bookkeeping. This leaves #1009’s actual unblock point ambiguous. |

## APPENDIX (untriaged):

The revised intake still cites `tenant-tables.ts:158` for `solicitation_batches`; HEAD line 158 is `solicitation_suppressions`. Round 1 challenged the plan citation specifically, so this did not independently affect the verdict. [Intake:46](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/docs/superpowers/plans/feat-1008-migration-116-refusal-events-intake.json:46)

The review used the named on-disk revisions, which remain uncommitted. No files were modified and no mutation-capable test suite was run.

VERDICT: REVISE

The stop hook is reporting a repository workflow failure, not a change to the review verdict. I’ll inspect the read-only feature-surface gate evidence to identify which reviewed artifact is outside the declared surface; I will not edit anything or rerun a gate that may write artifacts.

The stop hook is RED because `feature-surface` rejects two planned new-file paths that do not exist yet:

- `supabase/migrations/116_refusal_events.sql`
- `src/lib/shared/__tests__/migration-116-refusal-events.integration.test.ts`

Evidence: [.feature/logs/feature-surface.log](/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events/.feature/logs/feature-surface.log:1).

Resolving this requires editing the intake or creating implementation files, both prohibited by this verification-only request. No files were changed. The review remains `VERDICT: REVISE`.