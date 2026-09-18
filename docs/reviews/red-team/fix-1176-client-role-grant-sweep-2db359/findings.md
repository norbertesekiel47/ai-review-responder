# Red team — fix-1176-client-role-grant-sweep (feature, round 3)

- Mode: feature · Risk: high · Issue #1176
- Fork `b73c6a001b7467b6ac3811fa5ddbc5e30e3bfb58` = merge-base · HEAD `8a944908ad0d0afc9664f76cbca6b1c005614a8d`
- Intake SHA-256 `13cc93ffdfcc6bc74bcb87d280b73e4b94332edaf485bfa48870a4400c4203b2` (`.feature/intake.json`, byte-identical to the committed copy at `docs/superpowers/plans/fix-1176-client-role-grant-sweep-intake.json`)
- Generated 2026-09-18T01:40Z
- **Status: CLEAR** — 12 inventory rows, all excluded with recorded reasons. Findings: 0 P0, 0 open P1, 3 open P2; 3 fixed.

## Scope

Round 3 is scoped by the owner's authorization to the delta
`git diff 2dd74a20fcf7cc761a46b183f7b88268768c9710 HEAD` — nine files: the two
apply READMEs, their four ACL snapshots, `migrations-log.md` entry 122, and the
round-2 sidecar pair. **No production or test code moved**, proven rather than
asserted: the three code surfaces the branch owns carry identical blobs at both
SHAs — migration `6f48261d359931c9ffae9a9f7207b35ae4b718be`, suite
`0aa2fe41eb04538c442a55ddf5925340d8e5bd4e`, audit script
`4a517b27d22458da1a6e06d4775b6770f8d7a6ef`.

## Preconditions

- Worktree clean at HEAD (`git status --porcelain` empty, tracked and untracked).
- `watchers`: none — no dev server, watch worker or E2E server serving this worktree.
- `round-start`: **round 3 open, 30 mutation runs available.** The runner accepted
  the committed authorization `owner-third-round-2026-09-17`, whose text names the
  third round. Journal: 0 mutations, 0 supervisors, dotenv closed, no `.env*`
  backups. Nothing was mutated, so nothing needed restoring; the finalizer is the
  orchestrator's to run.

## Inventory — why every row is excluded

There is no code delta, so Direction A (changed test surface) and Direction B
(changed production surface) both yield zero mutation candidates. This is not
silent sampling: every changed file, and every unchanged code surface that a
carried finding depends on, gets a row stating why no candidate exists and what
was checked instead.

| ID | Candidate | Outcome | Why |
|---|---|---|---|
| INV-1 | `supabase/migrations/122_client_role_grant_sweep.sql` | excluded | Blob identical across the delta; round 2 killed 10/10 against this exact blob. Mutating it would re-measure round 2. |
| INV-2 | `…/migration-122-client-role-grant-sweep.integration.test.ts` | excluded | Blob identical; no case added, modified or deleted; no imported helper/fixture changed. |
| INV-3 | `scripts/ci/live-db-suites-audit.ts` | excluded | Blob identical; round 1's kill MA1 carried by round 2. |
| INV-4 | `migrations-log.md` entry 122 | excluded | Documentation. Verified under duty 3 instead → RT-5. |
| INV-5 | `staging-apply/README.md` | excluded | Documentation. Every count and SHA re-derived (below). |
| INV-6 | `production-apply/README.md` | excluded | Documentation. Every count, SHA, deployment id and the Sentry claim re-derived. |
| INV-7 | `staging-apply/pre-apply-acl-snapshot.txt` | excluded | Captured evidence. Checked as data: 1080 rows, sha256 `14ecf474d519ef98`. |
| INV-8 | `staging-apply/post-apply-acl-snapshot.txt` | excluded | Captured evidence. 526 rows, sha256 `23738012b23727cd`, **byte-identical to a fresh live read**. |
| INV-9 | `production-apply/pre-apply-acl-snapshot.txt` | excluded | Captured evidence. 1080 rows, byte-identical to staging's. |
| INV-10 | `production-apply/post-apply-acl-snapshot.txt` | excluded | Captured evidence. 526 rows, **byte-identical to a fresh live read**. |
| INV-11 | `findings.json` authorizations entry | excluded | This pass's own artifact. Checked for consistency; `round-start` accepted it. |
| INV-12 | `findings.md` faithfulness | excluded | This pass's own artifact. Checked against the JSON before rewriting → RT-6. |

## Findings

| Severity | Location | Finding | Disposition |
|---|---|---|---|
| P1 | `supabase/migrations/122_client_role_grant_sweep.sql:110` | RT-1: PG17 MAINTAIN branch and `lock_timeout` backstop had no executable covering test | fixed |
| P2 | `docs/superpowers/plans/fix-1176-client-role-grant-sweep-handoff.md:4` | RT-2: handoff and D6 stale after the #1302 merge | fixed |
| P2 | `src/lib/shared/__tests__/migration-122-client-role-grant-sweep.integration.test.ts:323` | RT-3: suite restore ignored RLS/FORCE flags | fixed |
| P2 | `.github/workflows/ci.yml:252` | RT-4: CI runs the 122 suite on PostgreSQL 16 only | open |
| P2 | `.claude/reference/migrations-log.md:2942` | RT-5: the mandatory-preflight paragraph still ends "production's defaults were not read", which the entry's new header (`:2879`) contradicts | open |
| P2 | `docs/reviews/red-team/…-2db359/findings.md:56` | RT-6: round-2 Markdown rendered "Authorizations: None." while the JSON already carried the third-round grant | open |

Arbiter reasoning for each is recorded verbatim in `findings.json`.

## Duty 3 — docs vs reality (the whole job this round)

`prevalidate-plan.py` ran on all three changed Markdown files. Citations: 0
unresolved in each. Fixtures: 21 checked in `migrations-log.md`, 0 gitignored.
The single "stale commit" hit in each file is `441aac16c3ffe63d` — that is the
migration file's **sha256 prefix**, not a commit; `shasum -a 256` on
`122_client_role_grant_sweep.sql` returns
`441aac16c3ffe63d9a6af901d04e9d3f53bbca96ecf769fe54fdc49a2ea72faf`, so the hit is
a false positive of the same class as rounds 1 and 2. The staging README's other
SHA, `92bf95797`, resolves (the round-2 report commit), is an ancestor of HEAD,
and its copy of the migration hashes to the same digest.

### Snapshot claims — re-derived from the files

| Claim | Result |
|---|---|
| Pre-apply snapshots byte-identical across projects | **TRUE** — both `14ecf474d519ef98…` |
| Post-apply snapshots byte-identical across projects | **TRUE** — both `23738012b23727cd…` |
| 766 table / 12 column / 300 default rows | **TRUE** — plus 1 `identity` and 1 `owners` row = 1080 |
| 98 TRUNCATE entries = 49 tables × 2 roles | **TRUE** |
| 1080 → 526 rows | **TRUE** (526 = 220 table + 12 column + 292 default + 2) |
| post = pre minus exactly (twenty deny-all tables' client entries, the four rights everywhere, the `postgres`/`public`/tables default entries for those rights) | **TRUE, exactly** |

The set difference is 554 lines removed and **0 added**. It decomposes as: 8
`default` rows — precisely `postgres|public|r|{anon,authenticated}|{TRUNCATE,
REFERENCES, TRIGGER, MAINTAIN}`; 392 `table` rows — the four rights × 98 (49
tables × 2 roles); and 154 `table` rows of SELECT/INSERT/UPDATE/DELETE belonging
to exactly 20 distinct tables, which are exactly the twenty the intake and the
log entry name, none of which retains a single client row afterwards. No grant
option was lost (all 554 removed rows carry `false`). The 12 `column` rows —
the migration-040 `businesses` / `channel_enrollments` grants — are **identical**
before and after, which is the "does not revoke a column-level privilege" edge
case holding in measured data. `postgres` and `service_role` default entries are
untouched, as are the 180 `supabase_admin` and 24 `supabase_auth_admin` rows.

The "zero global `pg_default_acl` rows" preflight is corroborated inside the
snapshots themselves: all 300 default rows sit in a **named** schema (auth 24,
extensions 12, graphql 48, graphql_public 48, public 96, realtime 24, storage
48). There is no unnamespaced row to subtract, which is exactly what makes the
schema-level revoke sufficient.

### Live re-derivation (read-only), the load-bearing check

Both projects were read with `BEGIN READ ONLY … COMMIT`, through the session
pooler / direct host on port 5432, never the transaction pooler, with no
session-level `SET`, no write and no DDL. The snapshot query was reconstructed
from the committed files' shape; that reconstruction is itself validated by the
result:

- **Staging live snapshot is BYTE-IDENTICAL to `staging-apply/post-apply-acl-snapshot.txt`** — 526 lines, same order.
- **Production live snapshot is BYTE-IDENTICAL to `production-apply/post-apply-acl-snapshot.txt`**, and identical to the staging live snapshot.

Independent checks, identical on both projects: 58 tables in `public`, 0 views /
matviews / foreign tables / partitioned tables, 0 with RLS off, **0** effective
`(anon, authenticated) × (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN)` grants, 29
deny-all tables of which **0** grant any client privilege, `authenticated` SELECT
on `users` **true**, and **0** `pg_default_acl` rows with `defaclnamespace = 0`.
Both report `server_version_num` 170006 as `postgres`.

So the entry's strongest claim — **lockstep is CLOSED, proven by byte comparison
rather than assertion** — is true, and true when re-derived from the live
catalogues rather than from the committed evidence. That satisfies CLAUDE.md's
standing rule never to re-derive lockstep from a sentence.

### Other claims checked

- Migration statement sequence `BEGIN, SET, DO, REVOKE, REVOKE, ALTER DEFAULT PRIVILEGES, DO, COMMIT` matches the file (`:68, :70, :76, :88, :92, :103, :109, :116`). The "What it does" paragraph describes it accurately, including the `>= 170000` gate on both MAINTAIN statements.
- "62 minutes after staging" — 13:06:16Z → 14:07:59Z is 61 m 43 s. True.
- Railway deployment ids resolve and were the live deployments at the stated times: staging `4f51871b…` (SUCCESS, created 2026-09-17T04:22Z) and production `07d2a2f4…` (SUCCESS, created 2026-09-17T12:49Z, still current).
- "Sentry recorded no issue in either environment" — a `lastSeen:-24h` search across the org returns **no issues**; the eight issues in the last 14 days were all last seen more than 24 h ago, i.e. before the applies. None is a permission or read-only error, which also supports the production README's remark about the 2026-09-16 pooler `SET`.
- "again ~11 h later" — the production README records the second introspection at 2026-09-18T01:10Z; the staging README records no second read. The log entry's "Both verified … again ~11 h later" is therefore ahead of the staging evidence file, but it is **true as re-derived here**: this pass read staging live at ~01:13Z, ~12 h after its apply, and it matched. Recorded here rather than as a separate finding.
- **Not re-derived:** the PostgREST anon-key probes (`401 / 42501` on the three deny-all tables, `200` on `users` and `reviews`). The outbound HTTP call was refused by this session's tool policy as a production read. The privilege layer underneath those probes was re-derived directly and agrees: the client roles hold nothing on those three tables and keep SELECT on `users` and `reviews`.

## Duty 4 — missed sibling cases

- **Pattern:** any other document still describing migration 122 as LOCAL-ONLY, pending, or not yet applied. **Scope:** every `*.md` in the repo excluding `node_modules`, via `rg -i "local-only|not yet applied|not yet been applied|apply staging first"` and `rg -l "122_client_role_grant_sweep|migration 122|\*\*122\*\*"`. **Result: 0 siblings.** The LOCAL-ONLY hits belong to migrations 100, 109 and older evidence files; the twelve files naming 122 are this branch's own plan, handoff, deviations, review reports and the two apply READMEs, none of which asserts an application status that the delta contradicts. The handoff's only apply-related line (`:38`) says remote migration needs explicit approval at step 8 — which both READMEs record as granted.
- **Pattern:** the migrations-log head/next marker. `Current head: **122** — next migration is **123**` (`:4`). Correct and unchanged.
- **Exclusions:** the rollback-inverse and version-guard paragraphs of entry 122 are written in standing-instruction tense and were not treated as stale claims; sequences, functions and `supabase_admin` defaults remain intake non-goals (#1300).

## Duty 5 — operational completeness

The delta adds no runtime code path, no terminal or swallowed failure branch, no
Sentry signal and no tag, so there is no alert-path half to compare against
`docs/runbooks/beta-launch-alerting.md`. Nothing found, and nothing invented.

## Duty 2 — fragile assertions

No test file changed in the delta, so there is no changed assertion to scan.
Round 2's scan of the seven cases stands against identical blobs.

## Restoration

No mutation was applied and no dotenv file was swapped, so there is nothing to
restore. The journal is `round 3, runs 0, mutations [], supervisors [], dotenv
closed`; there are no `.env*.red-team-backup` files. `git status --porcelain` is
empty except this run's own two artifacts. The finalizer was deliberately NOT
run — the orchestrator owns it.

## Authorizations

- **`owner-third-round-2026-09-17`** (2026-09-17), covering RT-4:

  > Owner, 2026-09-17, answering a message whose step 2 read: 'After the production evidence commit, authorize one scoped red-team round 3 that covers only those docs commits.' Owner reply, verbatim: 'Yes proceed with the remaining steps please.' This authorizes the third round, scoped to the staging and production evidence commits (docs and migrations-log only; no production or test code changed since round 2's head 2dd74a20fcf7cc761a46b183f7b88268768c9710). It does not accept RT-4's risk; RT-4's disposition stays open.

  This grant opens the round; it waives nothing. RT-4 remains open at P2.
