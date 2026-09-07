# Red team — #1171 `job_outbox` deny-all RLS — independent pass

| | |
|---|---|
| Run | `standalone-1171-ce0f2d5-cf9458` (standalone, round 1 of its own loop) |
| Fork / merge-base | `602e98930810177230c0edbc0830063db5f75d43` |
| HEAD under test | `ce0f2d52b46aff65098853be8638ce6e885df9e6` |
| Intake | `.feature/intake.json`, sha256 `e300e0c8…d10d02b8`, risk **high** |
| Generated | 2026-09-07T09:50:29Z |
| Status | **OPEN_P0** |

This is a fresh, independent pass, not round 3 of the feature-lane loop
`fix-1171-job-outbox-rls-be1af0`. That run directory is untouched. Two prior
passes each found a P0 in the same artifact — the privilege guard in
`src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts` —
and the round-2 fix had been verified only by the root, using round 2's own
mutation. Budget went to the surfaces no pass has attacked: the two-arm guard's
new Arm B, the text guards as they stand after RT-8 and D17, the interaction
between the four fixes that landed separately, and every reproducible number in
the documents.

## Protocol deviations, stated

1. **New run identity.** The checker derives its report path from the checked-out
   branch, which would have resolved to the existing `…-be1af0` directory. To
   honour "new run id and slug, do not overwrite", this pass runs in
   **standalone** mode with the detached-HEAD identity `#1171@ce0f2d52…`, giving
   the slug `1171-ce0f2d5-cf9458`. Validating the sidecar with
   `red-team-status.mjs` therefore requires `--mode standalone --issue '#1171'
   --head ce0f2d52…` from a detached HEAD; run from the branch it will look for
   the `…-be1af0` path instead.
2. **Journal.** `.feature/red-team-journal.json` stood at round 2, so
   `round-start` would have refused round 3. A new run is a new loop: the journal
   was archived to `.feature/red-team-journal.rounds-1-2.bak.json` (gitignored)
   and reset to round 0 before `round-start` opened round 1. 19 of 30 runs used;
   nothing was skipped for budget.
3. **Migration mutation.** Step 2 excludes `supabase/migrations/` from mutation
   "because the database is provisioned before the run". That reasoning holds for
   the catalogue cases and NOT for titles 2 and 3, which read the migration's
   TEXT. Those two were mutated by file; the catalogue cases were mutated by
   database state on a throwaway clone.

## Database safety

All mutation ran against `rt3_clone` / `rt3_clone2`, `CREATE DATABASE … TEMPLATE
test_ws4` clones dropped at the end. Both Supabase projects were read-only —
`SELECT` and catalogue introspection only, no write of any kind.

Shared test database restored and verified byte-identical to its pre-run
fingerprint:

```
pre : t|f|{test=arwdDxt/test}|0|none
post: t|f|{test=arwdDxt/test}|0|none      (relrowsecurity | relforce | relacl | policies | column ACLs)
```

Cluster roles, role memberships and the database list all diff clean against
their pre-run snapshots. The one cluster-wide artefact created during the run,
role `rt_probe`, was dropped; `pg_roles` and `pg_auth_members` are identical to
pre-run.

## Findings

| Severity | file:line | Finding |
|---|---|---|
| **P0** | `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:271` | A COLUMN-level grant to a role `anon` inherits escapes BOTH arms — suite 6/6 green while `anon` can read `job_outbox.payload` |
| **P0** | `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:169` | A tagged dollar-quote holding a concatenated token defeats both text checks; in the REVOKE direction (`service_role`/owner) nothing else catches it, and the header claims title 3 does |
| **P0** | `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:187` | `/CREATE POLICY/i`, `/FORCE ROW LEVEL SECURITY/i`, `/DISABLE ROW LEVEL SECURITY/i` are whitespace-literal on raw text — a newline inside the phrase evades all three |
| P2 | `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:302` | Arm B fails OPEN if its derived privilege list is ever empty, and nothing asserts it is not |
| P2 | `docs/superpowers/plans/fix-1171-job-outbox-rls-deviations.md:392` | The sibling-table count is 20, not 19 |
| P2 | `.claude/reference/migrations-log.md:2745` | The 55/78 file counts reproduce only under a scope the documents never state |
| P2 | `src/lib/shared/__tests__/migration-119-job-outbox-rls.integration.test.ts:143` | The registry case asserts on prose (`/[Tt]ransactional outbox/`) rather than on membership |
| P2 | `src/lib/shared/__tests__/migration-117-admin-audit-log.integration.test.ts:81` | Duty 4: sibling suites repeat the whitespace-literal guard; migration 118 has no text guard at all |

Findings are numbered F1-F8 in `findings.json`. Severity note: the protocol's
inventory taxonomy has no non-blocking outcome for a confirmed, executed,
provably non-equivalent survivor — the reasoning round 2 recorded verbatim when
it re-graded RT-7 from P1 to P0 ("likelihood is not the axis; the guard either
holds or it does not"). F2 and F3 are graded on that rule, with each finding's
mitigation stated so the root can weigh it.

### F1 (P0) — the column ∩ membership intersection

Round 2 closed RT-7's two legs separately: Arm A gained `acl.grantee = 0` for
PUBLIC, Arm B gained `has_table_privilege` for grants arriving through role
membership. Neither covers their intersection.

Mutation on the clone at HEAD:

```sql
CREATE ROLE rt_probe NOLOGIN;
GRANT SELECT (payload) ON job_outbox TO rt_probe;
GRANT rt_probe TO anon;
```

Measured:

| | |
|---|---|
| `relacl` | `{test=arwdDxt/test}` — Arm A table half: nothing |
| `attacl` | `payload={rt_probe=r/test}` — Arm A column half filters `grantee = 0 OR grantee::regrole::text IN ('anon','authenticated')`; `rt_probe` is neither |
| `has_table_privilege('anon','public.job_outbox','SELECT')` | **f** — Arm B asks a TABLE-level question a column grant does not answer |
| `has_column_privilege('anon','public.job_outbox','payload','SELECT')` | **t** |
| `pg_has_role('anon','rt_probe','USAGE')` | **t** |
| suite | **passed** |

The inheritance leg is live everywhere: `anon` and `authenticated` carry
`rolinherit = true` on the local container (PostgreSQL 16.14) and on **both**
Supabase projects (17.0006, introspected read-only 2026-09-07).

Closure shape: give Arm B a `has_column_privilege` leg over `pg_attribute`, or
resolve membership in Arm A's column half with
`pg_has_role(<client role>, acl.grantee, 'USAGE')` instead of a name/0 filter.

### F2 (P0) — the tagged dollar-quote, in both directions

```sql
DO $fix$
BEGIN
  EXECUTE 'REVO' || 'KE ALL ON job_outbox FROM service_role';
END $fix$;
```

Appended to the migration, title 2 stayed green. Three reasons, and they compose:
the statement parser's `/\$\$[\s\S]*?\$\$/` mask does not handle a **tagged**
dollar-quote, so the block splits at its inner semicolon into fragments starting
`DO` and `END`; D17's belt counts `\bREVOKE\b`, and `'REVO' || 'KE` carries no
such token, so the count stays 1; `\bGRANT\b` stays null.

The mirror image, `EXECUTE 'GRA' || 'NT SELECT, INSERT ON job_outbox TO anon'`,
survives identically (MUT-03) but IS backstopped by Arm A once the migration is
applied — MUT-09 proves it — which is RT-9's accepted disposition. The REVOKE
direction has no second line of defence at all. `grep` of the
suite returns **zero** non-comment assertions naming `service_role` or the owner
— lines 61-70 record that omission deliberately and then claim it is covered:

> "Neither property can be established from a catalogue read here, so both are
> guarded by title 3's exact-match statement assertion instead of by an
> assertion that could only be true by accident."

MUT-02 falsifies that sentence. D17/RT-9 closed the GRANT direction by pointing
at Arm B — "only the catalogue bounds what it DOES" — and that argument cannot
transfer to a role the catalogue arm deliberately never asks about.

### F3 (P0) — whitespace-literal forbidden forms

`ALTER TABLE job_outbox\n  DISABLE ROW LEVEL\n  SECURITY;` and
`CREATE\n  POLICY job_outbox_client_read ON job_outbox FOR SELECT TO anon USING
(true);` are both valid PostgreSQL and both left title 3 green. The statement
list already collapses whitespace at line 114; the three raw-text checks give up
exactly the normalisation that would close this, and the comment at 176-178
argues for raw text without noticing the cost.

This is the D9 / RT-8 interaction defect the pass was sent to look for: the
statement parser (D9) normalises whitespace, the raw-text guards (RT-8) do not,
and the two fixes landed separately, so between them they gave up the one
normalisation that would have closed this. RT-8 appended the same DISABLE on one
line and was closed with a literal regex; it is re-opened in a new spelling.

Mitigation, measured rather than assumed: MUT-06 shows title 1 kills a DISABLE
once the file is applied and MUT-07 shows title 1 kills an added policy, so a
container at head does catch both consequences. But lines 47-49 call the text
case "the ONLY environment-independent guard", and it is not one.

## What was attacked and HELD

Recorded because a sound search that finds nothing is a result.

| Attack | Result |
|---|---|
| `GRANT SELECT, INSERT ON job_outbox TO PUBLIC` (round 2's own RT-7 mutation) | **KILLED** by Arm A, role rendered `-` — RT-7's fix genuinely holds for this shape |
| Table-level grant through role membership (`GRANT SELECT … TO rt_probe; GRANT rt_probe TO anon`) | caught — `has_table_privilege('anon',…)` = t, Arm A 0 rows. Arm B is load-bearing and works |
| `GRANT pg_read_all_data TO anon` | caught by Arm B (`has_table_privilege` = t) |
| `GRANT SELECT … TO anon WITH GRANT OPTION` | caught by Arm A (1 ACL row) |
| Column grant DIRECT to PUBLIC, or to `anon`/`authenticated` | caught by Arm A's column half |
| `ALTER TABLE job_outbox OWNER TO anon` | caught by both arms (owner change rewrites `relacl`) |
| `acldefault('r', relowner)` privilege derivation | 7 types on the local PostgreSQL 16.14 container, **8 incl. `MAINTAIN`** on both Supabase projects (17.0006). The 16-vs-17 claim is exact |
| Arm B under a changed `relowner` | sound — the CTE takes `DISTINCT privilege_type`, so the owner OID is irrelevant to the derivation |
| Arm B under `acldefault(…) = NULL` | fails open, but unreachable — the `::regclass` cast raises first. Recorded as F5 |
| `ALTER DEFAULT PRIVILEGES` re-granting on a later object | not an escape — it cannot affect an already-existing relation |

## Duty 3 — documents re-resolved against HEAD

`prevalidate-plan.py` was not used; every claim below was hand-checked and the
command is recorded.

| Claim | Where | Verdict |
|---|---|---|
| "the ONLY table of the 54 in schema `public` whose RLS state differed" | migration header, migrations-log, arch-review-log | **TRUE.** Both projects: 54 tables. Prod 54/54 RLS-on; staging 53/54, `job_outbox` the one |
| prod `relrowsecurity` true / staging FALSE, zero policies on both, `anon`+`authenticated` hold `arwdDxtm` on both | migration header | **TRUE** as of 2026-09-07 — the migration has not yet been applied anywhere |
| "no `.rpc(`, view, function, trigger, publication or Edge Function over the table, zero column ACLs" | migration header, migrations-log | **TRUE** on both projects: 0 triggers, 0 publication rels, 0 dependent rewrite rules, 0 functions with `job_outbox` in `prosrc`, 0 column ACLs |
| "`rg` for `from('job_outbox')` in `src` + `worker`: zero matches" | migrations-log | **TRUE** — 0 matches |
| "109 and 114 are the precedent (both wrap; 10 of the 11 `SET LOCAL` migrations do). 088 is the sole unwrapped file" | migration header, migrations-log | **TRUE.** 11 pre-119 files carry a real `SET LOCAL` statement; 088 alone lacks a top-level `BEGIN;`. (A naive `rg -l 'SET LOCAL'` returns 13 and is wrong — 103's hits are prose in a comment) |
| "guarded file 64 ms; unconditional ALTER dies at `lock_timeout` after 5090 ms" | round-2 findings, deviations:501 | **REPRODUCED** independently: under a concurrent `AccessShareLock` holder, guarded **53 ms**, unconditional **5066 ms** ending `ERROR: canceling statement due to lock timeout` |
| "`ATExecSetRowSecurity` has no early-out and `AT_EnableRowSecurity` takes ACCESS EXCLUSIVE" | migration header | consistent with the measurement above — the unconditional form blocked and timed out on a table whose flag was already set |
| "19 sibling tables on both projects" | deviations:392, RT-6 | **FALSE — it is 20.** See F6 |
| "55 production files BIND it in SQL (78 reference the identifier at all)" | migration:68, test:138, migrations-log:2745 | reproducible under exactly one unstated scope. See F7 |
| local container is PostgreSQL 16, both projects 17 | test:292-295, deviations | **TRUE** — 16.14 and 17.0006 |

## Duty 4 — sibling search

Patterns searched, scope and exclusions:

- `rg -n -i 'ENABLE ROW LEVEL SECURITY' supabase/migrations/*.sql` cross-checked
  against `rg -n -i 'REVOKE' supabase/migrations/*.sql` — 55 tables get
  ENABLE-RLS; **18** have zero `CREATE POLICY` and no revoke of any kind, i.e.
  the exact pre-119 shape. Only four migrations use the full deny-all form
  `REVOKE ALL … FROM anon, authenticated`: 056, 117, 118, 119.
- Live introspection of both projects for `relrowsecurity AND 0 policies AND a
  client ACL entry` — **20** siblings (F6). Spot-checked `flagged_responses`,
  `auto_approval_policies` and `agent_runs`: all three grant `SELECT`, `INSERT`
  and **`TRUNCATE`** to `anon` and `authenticated`.
- `rg -n 'supabase/migrations' src` for sibling text-guard suites — the
  whitespace-literal shape recurs in 117, 048, 049, 051, 053 and 057 (F9), and
  no suite anywhere reads `118_poller_heartbeats.sql`.

Everything in this section is unchanged code and explicitly excluded by intake
`non_goals[3]`. It is recorded, not proposed as work for this branch.

## Duty 5 — operational completeness

The diff adds no runtime code path: one migration, one test file, and
documentation. No new Sentry signal, no new terminal or swallowed failure path,
and no rule row is owed in `docs/runbooks/beta-launch-alerting.md`. Both halves
of the alert path are absent together, which is not a finding under the rule.

Noted without severity: the migration header states that a half-applied lockstep
has no automated detector and that introspection is the only one. This change
adds none, consistent with the intake.

## Gate

`bash scripts/verify-gate.sh --review` re-run independently at
`ce0f2d52b46aff65098853be8638ce6e885df9e6` after the finalizer restored every
target: **GREEN across all 31 rows**, including
`integration-src-lib-shared---tests---migration-119-j-aade22`, `rls-audit`,
`tenant-scope` and `db-provision`.

## Finalizer

```
reap: every journaled process group is empty (19 recorded)
finalize: restored 0 mutated file(s) and 1 dotenv file(s); journal closed
```

`git status --porcelain` is empty apart from this run's two artifacts. `.env.local`
is the real file, no `.red-team-backup` remains, the journal is closed with every
entry `restored` and no active supervisor.

## Authorizations

None.
