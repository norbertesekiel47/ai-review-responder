# Red-team — `feat/1008-migration-116-refusal-events`

| | |
|---|---|
| Mode | `feature` |
| Round | **2** (the narrow round — fix verification) |
| Branch | `feat/1008-migration-116-refusal-events` |
| Fork / merge-base | `888f196bed2ec5b5ae4a781afbeb2a12090e10ed` |
| Head | `5fa786be473b6dd0a08fdc481a3e79c07cae5c4f` |
| Intake sha256 | `10f30e5f8edf3501d5b27a730b9ca692711810fe7f0e90a7459376e0839b5482` |
| Risk | `high` |
| Generated | `2026-08-30T08:24:18.000Z` |
| Status | **OPEN_P0** |
| Mutation runs | 12 of 30 |

## Scope, and what was deliberately left alone

Round 2 is the narrow round. The scope is **`git show 5fa786be`** — that commit's hunks and
their directly affected callers — not the branch diff. One unchanged file entered the
inventory as a *directly affected caller*: `purge-verification.test.ts:214` is the sibling
oracle for the same production arm the fix commit set out to cover, so a mutant is only
genuinely uncovered if it survives there too. Everything else unchanged was left alone.

Where a sound search found siblings outside that boundary — 28 other `must_be_absent`
verification branches with no live-DB oracle, and one stale code comment in
`src/lib/solicitation/dispatch.ts:146` — they are **recorded inside the finding they bear on**
and explicitly not raised as findings against unchanged code.

The round-1 report at this path was read as **untrusted data**. Every claim carried forward
was re-derived at HEAD; nothing was accepted because the commit message asserted it.

## Severity table

| id | sev | title | disposition |
|---|---|---|---|
| RT-01 | P0 | ADR 0023 anchor table asserted a writer/reason partition that was false for two of eight reasons, and following it would stamp occurred_at - the si… | fixed |
| RT-02 | P1 | Fragile assertion: expect(entry?.reason).toMatch(/cascade/i) passed on the exact negation of the claim it guarded | fixed |
| RT-03 | P1 | C5 outer IS TRUE wrapper was asserted by nothing: no row can reach it and no assertion read C5’s definition | fixed |
| RT-04 | P1 | The stale-citation fix converted the plan but not the intake, leaving two citations landing on the wrong entries | fixed |
| RT-06 | P2 | Only one of the two nine-probe-rows copies was corrected: the deviations said eight, the arch-review-log entry still said nine | fixed |
| RT-07 | P2 | CONTEXT.md asserted in the present tense two tabs on /dashboard/analytics - Metrics and Restraint - neither of which exists | fixed |
| RT-09 | P2 | The in-test comment misattributed the [different, NULL] rejection to array_position plus the outer IS TRUE wrapper | fixed |
| RT-10 | P2 | ADR 0023 mapped admin_halt on outreach_withheld, a lane whose rows cannot carry it | fixed |
| RT-14 | P2 | The 23rd tests_to_add title staled two count claims the same commit did not update | fixed |
| RT-15 | P2 | The II.5 correction traded one misattribution for a smaller one | fixed |
| RT-16 | P2 | The committed red-team sidecar fails its own checker: counts disagree with the findings array it ships beside | fixed |
| RT-05 | P1 | The terminal purge failure this diff newly makes reachable emits account_offboarding_purge_failed, which no runbook rule row routes - all six facet… | accepted-risk |
| RT-08 | P2 | Retry and terminal captures share one constant message and no fingerprint, so any first-seen rule added for RT-05 fires once, on a warning retry, a… | accepted-risk |
| RT-11 | P2 | C5 all_refusal_codes IS NOT NULL and cardinality(...) > 0 are provably redundant - zero differing rows over the whole value space - so no row pins… | rejected |
| RT-13 | P1 | The ADR’s eighth anchor row asserts a writer for `unsubscribed` that does not exist - no production site writes solicitation_outreach.disposition_r… | fixed |
| RT-17 | P0 | The refusal_events purge-verification branch is pinned by SQL TEXT only - two semantically meaningful mutants survived, including one that makes th… | fixed |
| RT-18 | P2 | The closed-vocabulary cases assert the ORDER of the rendered CHECK members, which migration 116 itself calls presentation | fixed |
| RT-19 | P2 | The Restraint tab term says "the route today has no tab UI"; the route renders two role="tablist" controls today | fixed |
| RT-20 | P2 | The disposition reason’s analogy set is off: two of the three tables it names as needing an explicit DELETE for "the same reason" DO carry ON DELET… | fixed |
| RT-12 | P2 | The intake still puts all ELEVEN Refusal write sites in #1010-#1013 while migration 116’s header puts the first caller in #1009 and the other TEN i… | **open** |
| RT-21 | P0 | The refusal_events verification arm is still not pinned against a predicate change: two new semantically meaningful mutants survive BOTH covering c… | **open** |
| RT-22 | P1 | D16 is false on both of its evidentiary grounds: the split is 3-to-3 at HEAD, not 3-to-1, and the three agreeing copies are one commit plus one rev… | **open** |
| RT-23 | P2 | The rewritten `unsubscribed` row's exhaustiveness argument omits migration 111's `unknown` arm, which two production sites do write | **open** |
| RT-24 | P2 | The replacement wording inverts the control-type axis: the per-card controls are real tabs and the one page-level control is the toggle group, whic… | **open** |
| RT-25 | P2 | The three referential-action claims RT-20 added to the reason string are asserted by nothing: negating both of the new clauses leaves the covering… | **open** |

**Counts.** inventory 10 (killed 1, survived-confirmed-P0 2, inconclusive 1, skipped-budget 0, excluded 6); findings 25 (P0 open 1, P1 open 1, P2 open 4, accepted-risk 2, fixed 16, rejected 1).

**Status: OPEN_P0** — one open P0 (RT-21).

## Preconditions

1. **Worktree clean at a committed SHA.** `git status --porcelain` empty at
   `5fa786be473b6dd0a08fdc481a3e79c07cae5c4f`; `git merge-base --is-ancestor` confirms the
   pinned merge-base is an ancestor of HEAD. The intake hashes to the pinned
   `intake_sha256`.
2. **Watchers — checked, not assumed.** `mutation-runner.mjs watchers` ABORTED with four live
   processes. Each was resolved independently with `lsof -a -p <pid> -d cwd`: PIDs 68547,
   69387 and 69738 have cwd `…/startups/RepWorth` (the parent checkout) and PID 76253 has cwd
   `…/RepWorth-worktrees/refactor-globals-css-extraction`. **None watches this worktree** —
   the command matches on process name, not directory. No new watcher appeared during the
   run. Proceeded, and recorded here.
3. **Journal closed, round open.** `round-start` was NOT run (round 2 was already open, and
   running it would have refused). `status` showed round 2, runs 0, no mutations, dotenv
   closed.
4. **Environment isolated.** `env --tmp-home <scratch> --test-db <localhost>` — the allowlist
   resolved `PATH`, a temporary `HOME`/`TMPDIR`, `NODE_ENV=test`, `CI=true`,
   `MOCK_EXTERNAL_APIS=true`, and `TEST_DATABASE_POOL_URL` + `DATABASE_POOL_URL` after
   localhost validation. `dotenv-swap` replaced `.env.local` with a scrubbed copy for every
   mutation phase. **One run was wasted** discovering that `--test-db` must be passed to
   `run` as well as to `env`: without it the allowlist omits the URL, the repo's own
   kill switch engages and the live-DB suites skip silently. That run is counted in the
   budget and produced no verdict.

## Duty 1 — hand-mutation

Twelve runs: four baselines, five mutant runs against production files, two against a test
file (disclosed below), and the one wasted run. Every baseline was green with
`assert-one-test` confirming exactly one executed test. Every mutation was restored and
verified before a report byte was written.

### INV-01 — `worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts:1415` → **survived-confirmed-P0**

> purge verification counts BOTH surviving refusal_events shapes, the account-wide row included

The case added by the fix commit. Baseline GREEN against the local test database, exactly one test executed. Two mutations of src/lib/account-offboarding/purge-verification.ts, BOTH SURVIVED. M1 appended "AND occurred_at >= NOW() - INTERVAL '30 days'" (fcdf7603a694 -> e97831a871bc): passed. M2 appended "OR account_id IS NOT NULL" (-> 076c7f293624): passed; refusal_events held COUNT(*) = 0 immediately before the run, so the widened predicate still counted exactly the two seeded rows. Two-mutation cap reached, so no KILL was produced for this case in this pass.

### INV-02 — `src/lib/account-offboarding/__tests__/purge-verification.test.ts:214` → **survived-confirmed-P0**

> purge verification counts refusal_events rows for the target account, including account-wide rows, and ignores another account

Directly affected caller: unchanged by the fix commit, but it is the sibling oracle for the same production arm, so a mutant is only genuinely uncovered if it survives here too. Baseline GREEN, exactly one test executed. The SAME two mutations were run against it and BOTH SURVIVED — its four guards (toContain('WHERE account_id = ?::uuid'), not.toContain('business_id'), not.toContain('account_businesses'), values deep-equal [accountId]) are all satisfied by an added conjunct that names no new column and binds no new parameter. Two-mutation cap reached.

### INV-03 — `src/lib/shared/__tests__/migration-116-refusal-events.integration.test.ts:1047` → **killed**

> the refusal_source, refusal_category and subject_type CHECKs admit exactly the seven lanes, eight categories and four subject types, and reject an unknown member

The three assertions the fix commit rewrote to sort both sides. Baseline GREEN against the live database, exactly one test executed. Two mutations, BOTH KILLED — both on the REFUSAL_SOURCES assertion, which is at line 1054 AT HEAD (each mutation shifts its own reported line by one, so the failures print :1053 and :1055; they are the same assertion). M3 removed a real member from the expected list (4c2d4d0ae033 -> 33f2255d7834): FAILED — 7 actual members against 6 expected, i.e. a vocabulary carrying an EXTRA member the expectation does not name still fails, which is the 'nothing extra is in it' direction the comment claims. M4 added a member the CHECK does not admit (-> 3bf72d6f7951): FAILED — 7 actual against 8 expected, the 'every member is present' direction. Sorting removed order sensitivity and nothing else. DISCLOSED PROTOCOL DEVIATION: these mutate the expected constants inside the test file rather than a production line, because this assertion's production counterpart is the database schema itself and supabase/migrations/ is outside mutation scope (the database is provisioned before the run). The measurement answers the only question the fix raises — whether sorting weakened the comparison — and the answer is no.

### INV-04 — `src/lib/account-offboarding/__tests__/table-disposition.test.ts:170` → **inconclusive** (`oracle`)

> classifies refusal_events as hard_delete by direct_account_id, verified must_be_absent

Covers the reason string the fix commit rewrote. Baseline GREEN, exactly one test executed. One mutation, M5, negated BOTH of the new referential-action clauses while leaving the polarised phrase intact (9c433a064ffc -> ff233eed44f8) — the case still PASSED. Classified inconclusive/oracle rather than survived-confirmed-P0 by deliberate, conservative arbiter judgement: the mutated clauses lie outside what this case asserts BY DESIGN (round 1 polarised only the load-bearing /NO CASCADE REACHES IT/ claim), and the clauses' facts were independently verified CORRECT at HEAD by pg_constraint catalogue query, so no defect exists to call a P0. The oracle gap itself is recorded as RT-25 (P2). Consequence recorded for the arbiter: this row forces INCOMPLETE_ORACLE if the open P0 is ever cleared.

### Excluded rows (6)

| id | file | why |
|---|---|---|
| INV-05 | `supabase/migrations/116_refusal_events.sql:10-19` | Out of mutation scope on two independent grounds: supabase/migrations/ is excluded by skill Step 2 (the database is provisioned to head before the run, so mutating the file changes nothing under test), and the hunk is a COMMENT — it has no runtime behaviour to mutate. |
| INV-06 | `CONTEXT.md:165` | Documentation hunk: verified under Duty 3 by resolving the claim against the actual components (AnalyticsContent, AnalyticsAggregateView, AnalyticsPerLocationView, CardViewTabs, PeriodToolbar) rather than by mutation. |
| INV-07 | `docs/adr/0023-refusal-log-owner-safe-projection.md:184` | Documentation hunk: verified under Duty 3 by re-resolving all four citations at HEAD and by enumerating every production disposition_reason write site, rather than by mutation. |
| INV-08 | `.claude/reference/arch-review-log.md:1421` | Documentation hunk, verified under Duty 3 by counting rather than by mutation, and it holds: exactly three commits have ever written docs/reviews/red-team/ on this branch — 30833b15 (added), 92ddb172 (modified), 5fa786be (modified) — and the row's own sentence describes them as round 1, round 2 and a third post-rebase pass, which matches. |
| INV-09 | `docs/superpowers/plans/feat-1008-migration-116-refusal-events-deviations.md:8` | Documentation hunk, verified under Duty 3 by counting. |
| INV-10 | `docs/reviews/red-team/feat-1008-migration-116-refusal-events-cbbac6/findings.json` | The round-1 artifacts this pass overwrites. |

## Duty 2 — fragile assertions

The fix commit added one test case and rewrote three assertions. Both were checked against
the skill's three shapes.

- **Order assertions where no ordering contract exists** — this is what round 1 raised as
  RT-18, and the fix is the right one. The three vocabulary assertions now sort both sides,
  which removes order sensitivity and nothing else; `toEqual` still compares arrays
  element-wise, so a membership difference in either direction changes the length and fails.
  **Proven by measurement, not by reading** — see INV-03, both directions killed.
- **Absence-of-tag proxies** — the sibling mock case at `purge-verification.test.ts:241-253`
  carries two: `not.toContain('business_id')` and `not.toContain('account_businesses')`.
  They are unchanged by this commit, and round 1 already recorded them. They are named here
  only because they are *why* both of this round's mutants survive that case: an added
  conjunct that names no new column trips neither guard.
- **Exact string counts on rendered output** — none in this diff.

The new live-DB case's own assertion (`toContainEqual` on an exact `violationCount`) is a
behavioural assertion, not a fragile one. Its weakness is the **fixture**, not the assertion
shape — RT-21.

## Duty 3 — docs vs reality

`prevalidate-plan.py` was not used; every citation was hand-resolved against HEAD and each
resolution is recorded in the finding it supports.

| claim | verdict |
|---|---|
| ADR 0023:184 — `unsubscribed` has no writer today | **TRUE.** All four citations resolve, no line moved; re-derived by enumerating all 9 production `disposition_reason` write sites. RT-13 fixed. |
| ADR 0023:184 — "one of the arms above or a cancelled/failed arm" | **Incomplete.** Migration 111 has five arms; two production sites write the `unknown` arm. RT-23 (P2). |
| CONTEXT.md:165 — no Metrics/Restraint page-level tabs | **TRUE.** No such route, no such literal, no tablist in either analytics view. RT-19 fixed. |
| CONTEXT.md:165 — "per-card view toggles, which are a different control" | **Inverted.** The per-card controls are `role="tablist"` tabs; the page-level `PeriodToolbar` is the `aria-pressed` toggle group. RT-24 (P2). |
| `table-disposition.ts:330` — four referential-action claims | **All four TRUE**, verified by `pg_constraint` catalogue query. RT-20 fixed. Nothing asserts them — RT-25 (P2). |
| deviations:8 — "Sixteen entries" | **TRUE.** 16 rows (D1–D16, no gaps/dupes), 16 `## D` sections, same id set. |
| deviations:469 — "a 3-to-1 split across artifacts written at different times" | **FALSE on both halves.** RT-22 (P1). |
| arch-review-log:1421 — "Then THREE red-team passes" | **TRUE.** Exactly three commits have written `docs/reviews/red-team/` on this branch. |
| migration 116 header — the write-site split | Direction is now defensible, but two tracked copies of the superseded phrasing remain. RT-12 stays open (P2). |

### The catalogue query behind RT-20

Joined `pg_constraint` to `pg_class` for `contype = 'f'` over the four named tables and read
`confdeltype`/`confupdtype` from the local test database. Twelve foreign keys returned:

| child | parent | ON DELETE |
|---|---|---|
| `refusal_events` | `accounts`, `businesses` | `a` (NO ACTION), both |
| `review_escalations` | `accounts`, `businesses` | `a` (NO ACTION), both |
| `contact_csv_uploads` | `accounts`, `businesses` | `c` (CASCADE), both |
| `agent_outcomes` | `accounts`, `businesses` | `c` (CASCADE), both |

`refusal_events` has **exactly** those two foreign keys. `review_escalations` also carries
`review_id → reviews` (`a`) and `agent_run_id → agent_runs` (`n`, SET NULL) — neither is a
delete cascade, so "no cascade reaches it" holds for it too. And the sub-claim that the
`contact_csv_uploads`/`agent_outcomes` cascade is *inert* checks out: `accounts`,
`businesses` and `users` are all `retain_deidentified` in `TABLE_DISPOSITIONS` (:74, :81,
:88), so a purge deletes no parent.

## Duty 4 — missed sibling cases

**Pattern A — a copy of the disputed write-site claim the D16 sweep missed.**
Searched `rg --no-ignore --hidden` across the whole worktree for `#1009|#1010|#1011|#1012|`
`#1013|#1014`, then for `eleven|ten|write site|write sites|first caller|insert helper|`
`kill switch|ArchivalPoller|Restraint tab`, then a per-file sweep of every file mentioning
"refusal", then `git grep` on the parked `feat/refusal-log` branch. Excluded: `node_modules`,
lockfiles, `tsconfig.tsbuildinfo`. **Two copies found**, both tracked and both still stating
the superseded reading — see RT-12. The plain `rg` the author used honours `.gitignore`,
which hides `.feature/`; but the two misses are in `docs/`, which it does not.

**Pattern B — a `must_be_absent` verification branch whose only oracle is the SQL-text mock.**
Enumerated every `purgeVerification: 'must_be_absent'` entry in `table-disposition.ts` (31
tables) and every `verifyAccountOffboardingPurge` call site in a test (`rg` over `*.test.ts`).
Only three live-DB arms exist — `offboarding-lifecycle.integration.test.ts:1428` (the new
`refusal_events` one) and `:1472`/`:1510` (the #643 suppression pair). The remaining ~28
branches are covered by the mock alone, and this round's two mutants would survive there
too. **Recorded, not raised**: unchanged code, outside the round-2 boundary. It is noted
inside RT-21 because it bears on how the arm should be strengthened.

**Pattern C — a stale premise in the code the ADR row leans on.**
`src/lib/solicitation/dispatch.ts:146` says `unsubscribed` is "written by other lanes", which
the enumeration behind RT-13 proves false at HEAD. Unchanged code; recorded inside RT-23,
not raised as a front.

## Duty 5 — operational completeness

**No new finding.** The fix commit adds one test case and five documentation edits; it
introduces no new operator-actionable terminal or swallowed failure path, no new Sentry
signal, and no new runbook row. The alerting gap on this branch — `account_offboarding_`
`purge_failed` reaching no rule row, and the retry/terminal captures sharing one message —
is round 1's RT-05 and RT-08, both accepted under AUTH-1008-01 with follow-up
`RepWorth/ai-review-responder#1016`. Re-checked at HEAD: still six rule rows in
`docs/runbooks/beta-launch-alerting.md`, none matching, and this commit changes neither side.

## Rejected finding

### RT-11 — C5 all_refusal_codes IS NOT NULL and cardinality(...) > 0 are provably redundant - zero differing rows over the whole value space - so no row pins them

**At** `supabase/migrations/116_refusal_events.sql:160`

REJECTED: deliberate defence in depth, not dead weight - the two clauses are redundant only GIVEN the sibling clauses that currently stand, and removing them would let a later edit to array_position or to C4 silently widen the constraint. Evidence: supabase/migrations/116_refusal_events.sql:160 (all_refusal_codes IS NOT NULL) and :161 (cardinality(all_refusal_codes) > 0) sit beside :162 (array_position(..., NULL) IS NULL) and :163 (refusal_code = ANY(all_refusal_codes)); the same reasoning is applied in the codebase to C5’s outer IS TRUE at :166, which the suite pins STRUCTURALLY at src/lib/shared/__tests__/migration-116-refusal-events.integration.test.ts:833 rather than deleting, and whose own comment records that it is currently redundant WITH C4 and kept anyway.

Carried from round 1 unchanged. This round did not re-litigate it.

## Findings

### Raised this round

#### RT-21 — P0 — The refusal_events verification arm is still not pinned against a predicate change: two new semantically meaningful mutants survive BOTH covering cases, one of them reporting a CLEAN purge over surviving tenant rows

**At** `src/lib/account-offboarding/purge-verification.ts:630` · **Duty 1** · disposition **open**

**Arbiter confirmation.** Both survivors were inspected before confirmation, and each was measured against BOTH covering cases rather than one. M1 appended `AND occurred_at >= NOW() - INTERVAL '30 days'` to the refusal_events arm (fcdf7603a694 -> e97831a871bc). NOT equivalent: `occurred_at` is this table's single retention clock (migration 116), so the mutant stops counting every Refusal older than the window while those rows survive — a must_be_absent table reporting a CLEAN purge over surviving account decision history, which is the exact failure class RT-17 named. Not on an unexecuted branch either: the arm is the only statement either case runs for this table, and the baseline for both cases was green with exactly one test executed. It survived the new live-DB case because seedRefusalEvent hard-codes NOW() for occurred_at (offboarding-lifecycle.integration.test.ts:658), so both fixture rows sit inside any plausible window; it survived the mock case because that case's four guards are toContain('WHERE account_id = ?::uuid'), not.toContain('business_id'), not.toContain('account_businesses') and values deep-equal [accountId] — an added conjunct that names no new column and binds no new parameter trips none of them. M2 appended `OR account_id IS NOT NULL` (-> 076c7f293624). Also not equivalent: it widens the count to every tenant's rows, so verification can never pass once any other account holds a Refusal and finalizePurgeInTransaction would terminalize every offboarding. It survived the live case because the table held exactly the two rows the case seeds — confirmed COUNT(*) = 0 immediately before the run — and survived the mock case for the same text-shape reason. THE ROOT CAUSE IS THE FIXTURE, NOT THE ARM: the new case seeds exactly two rows, both fresh and both in-tenant, and asserts exactly their count, so any predicate BOTH rows satisfy is invisible to it; and it never purges the account, so it cannot distinguish 'counts rows that exist' from 'detects rows that survived a purge'. BUDGET DISCLOSURE: T1's two-mutation cap was reached with M1 and M2, so this pass produced no KILL for the new case and therefore did not itself demonstrate that the case can fail; that RT-17's two original mutants are killed is established analytically in RT-21's remediation and in RT-17's disposition, not by a run in this pass.

Behavioural replacement, and it is fixture rather than a new case: the arm needs at least one row a predicate change can lose. Seed a THIRD Refusal whose occurred_at is far outside any plausible retention window (NOW() - INTERVAL '400 days', written explicitly rather than defaulted) and a FOURTH under a bystander account — the file already has that bystander pattern at offboarding-lifecycle.integration.test.ts:1379-1402 — then assert violationCount is exactly 3 for the target account. That one change kills both survivors: M1 reports 2 and M2 reports 4. seedRefusalEvent currently hard-codes NOW() at :658 and needs an optional occurredAt to allow it; the standards review already flagged that literal as A3. SCOPE, recorded rather than opened as a front: 31 tables carry purgeVerification 'must_be_absent' and only three live-DB verifyAccountOffboardingPurge arms exist (offboarding-lifecycle.integration.test.ts:1428, :1472, :1510), so the other must_be_absent branches are covered by the SQL-text mock alone and the same two mutants would survive there too. Those branches are unchanged code and out of round-2 scope; they are noted only because they bear on how this arm should be strengthened.

#### RT-22 — P1 — D16 is false on both of its evidentiary grounds: the split is 3-to-3 at HEAD, not 3-to-1, and the three agreeing copies are one commit plus one review-directed conversion, not independent artifacts written at different times

**At** `docs/superpowers/plans/feat-1008-migration-116-refusal-events-deviations.md:469` · **Duty 3** · disposition **open**

D16:468-471 justifies overriding the sha-locked intake with 'a 3-to-1 split across artifacts written at different times is better explained by one imprecise phrase than by three independent errors'. Both halves are false at HEAD, re-derived by git archaeology and by search. THE COUNT IS 3-to-3, NOT 3-to-1: besides `.feature/intake.json`, the (A) reading stands in two more TRACKED files — docs/superpowers/plans/feat-1008-migration-116-refusal-events-intake.json:8 (byte-identical mirror, same sha256, outside the sha lock) and docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:434-436 (independently worded, unmodified, no supersession marker). THE THREE (B) COPIES ARE NOT INDEPENDENT: `git log -S` shows the migration header and .claude/reference/migrations-log.md BOTH received the #1009-split wording in the SAME commit 341f1cb96de5831237108dccde8e72333f61f4aa — one author act, two copies; and the third, .claude/reference/arch-review-log.md:1421, was CREATED at 7378e68a9edcd08edf2566e562bec0771050bc54 saying (A) verbatim ('the insert helper is #1009, the eleven writers #1010–#1013') and was converted to (B) 36 minutes later at 5b1975eb9ee3ae2d424776385c449de2777b15f7, in direct response to a review finding that told it to match the other two (docs/reviews/feat-1008-migration-116-refusal-events/standards.md:214, triage disposition at triage.md:44). The wording exists nowhere in `git log --all` before 341f1cb9. So (B) is one source plus one derivative edit, while (A) was written across three separate commits. D16's first ground is also wrong as applied: the sha lock covers only .feature/intake.json (red-team-status.mjs:638), so the tracked mirror was editable inside this run. NOT P0, and deliberately so: D16's SECOND ground — a helper shipping with zero callers is dead code this repo gates on — is sound, independent of any count, and on its own supports the verdict, so the ACCEPT is probably right while the record of WHY is wrong. P1 because the deviations file is the durable record of a decision to override a locked contract, and it currently cites two facts that do not hold.

#### RT-23 — P2 — The rewritten `unsubscribed` row's exhaustiveness argument omits migration 111's `unknown` arm, which two production sites do write

**At** `docs/adr/0023-refusal-log-owner-safe-projection.md:184` · **Duty 3** · disposition **open**

The row asserts 'Every production `disposition_reason` write is one of the arms above or a cancelled/failed arm'. Migration 111's CHECK has FIVE arms, not four (supabase/migrations/111_platform_halt_reason.sql:87-107), and two production writes land in the fifth: src/lib/solicitation/release.ts:618-620 sets delivery_status='unknown' with disposition_reason='send_indeterminate', and worker/jobs/solicitation-send/failed-hook.ts:232-234 writes the same pair through TERMINAL_BY_ARRIVAL's `sending` entry (:75-81). Neither is 'one of the arms above' (those are withheld reasons) nor cancelled nor failed. P2 rather than P1 or P0: the row's LOAD-BEARING claim — that no production site emits `unsubscribed` — is independently verified true (see RT-13), and every omitted write emits the literal 'send_indeterminate', so no reader can be led to a wrong action by the gap. Recorded because this anchor table has now produced a false enumeration in three consecutive passes (RT-01 P0, RT-10 P2, and this), which makes the pattern rather than the instance the thing worth naming. Fix is three words: 'a cancelled/failed/unknown arm'. Out-of-scope context, NOT a finding against unchanged code: the code comment this row's supporting prose leans on, src/lib/solicitation/dispatch.ts:146, still says `unsubscribed` is 'written by other lanes', which the row now correctly contradicts.

#### RT-24 — P2 — The replacement wording inverts the control-type axis: the per-card controls are real tabs and the one page-level control is the toggle group, which is the opposite of what the sentence says

**At** `CONTEXT.md:165` · **Duty 3** · disposition **open**

The new clause reads '...its cards carry their own per-card view toggles, which are a different control'. The component it describes documents itself as the opposite: src/components/dashboard/charts/CardViewTabs.tsx:8-13 says 'These are real tabs, not toggle buttons', carries role="tablist"/role="tab"/role="tabpanel" and aria-selected (:74, :85, :87, :97), and records that these cards PREVIOUSLY announced as a pair of independent aria-pressed buttons — 'which says two toggles, not one of these two' — and were deliberately converted away from that framing. Meanwhile the one genuinely page-level control on /dashboard/analytics, src/components/dashboard/analytics/PeriodToolbar.tsx:29-45, IS a toggle group: role="group" with aria-pressed buttons, styled with the Console .tabs/.tab pill classes (:24-26, console.css:527-551). So the axis is inverted in both directions. The sentence's other distinction — page-level versus per-card — is correct and is the one CardViewTabs.tsx:15-17 itself draws ('Route-level switches are NOT this component'), so the fix is to delete 'which are a different control' rather than to rewrite the clause. Second, smaller imprecision: 'its cards' is 2 of roughly 8 cards on the route (AggregateVelocityCard, AggregateRankingCard — the only two importers of CardViewTabs) and only in the all-locations scope; an owner viewing a single location sees none. P2: the load-bearing claim the round-1 finding was about is now true (see RT-19), and this term is explicitly flagged 'Not built yet'.

#### RT-25 — P2 — The three referential-action claims RT-20 added to the reason string are asserted by nothing: negating both of the new clauses leaves the covering case green

**At** `src/lib/account-offboarding/table-disposition.ts:330` · **Duty 1** · disposition **open**

Measured, not inferred. M5 rewrote the new sentence to its factual opposite — 'contact_csv_uploads and agent_outcomes are the same case: they carry NO referential action to either root either' — while leaving the polarised phrase intact (9c433a064ffc -> ff233eed44f8). src/lib/account-offboarding/__tests__/table-disposition.test.ts:170 STILL PASSED. Its assertions on this string are /NO CASCADE REACHES IT/ and /deletes them explicitly/i, the polarised replacements round 1 introduced for RT-02; both match the negation because the negation only touches the clauses that follow them. Neither the mock nor the live purge-verification case asserts `reason` at all — both use objectContaining over table, disposition, purgeVerification and violationCount. NO DEFECT EXISTS TODAY: all four referential actions were verified correct at HEAD by pg_constraint catalogue query (see RT-20). The finding is that RT-20's class of error — this exact sentence asserting the wrong referential action — can recur silently, in an operator-facing string that surfaces in PurgeVerificationIssue.reason. P2: prose, no runtime behaviour, and the load-bearing claim IS polarised. If adjudicated worth closing, the cheap form is one more regex pinning the direction of the cascade clause, the same shape RT-02's fix used. INVENTORY NOTE: the corresponding row is recorded `inconclusive`/`oracle` rather than `survived-confirmed-P0`, because the surviving mutation lies outside what that case asserts by design and the `survived-confirmed-P0` label would overstate a prose clause whose facts are verified correct.

### Re-adjudicated this round

#### RT-13 — P1 — fixed

*The ADR’s eighth anchor row asserts a writer for `unsubscribed` that does not exist - no production site writes solicitation_outreach.disposition_reason = ‘unsubscribed’*

**At** `docs/adr/0023-refusal-log-owner-safe-projection.md:184`

FIXED — verified independently at HEAD 5fa786be, not accepted on the commit message. The rewritten row is docs/adr/0023-refusal-log-owner-safe-projection.md:184. All four citations re-resolve and NO cited line has moved: `dispatch.ts` is src/lib/solicitation/dispatch.ts and :149-155 is exactly the `OutreachWithheldReason` union, six members, `unsubscribed` absent; worker/ingress/unsubscribe.ts exists and contains no SQL at all (zero hits for solicitation_outreach, disposition_reason, INSERT or UPDATE); src/lib/solicitation/suppression.ts writes only solicitation_suppressions (:242, :254); and migration 111 admits the value in its withheld arm at supabase/migrations/111_platform_halt_reason.sql:94. The row's claim was then re-derived rather than trusted: all nine production `disposition_reason` write sites were enumerated (outreach.ts:609 and :638, dispatch.ts:1155 and :1375, approval.ts:370 :546 :1276, worker/jobs/solicitation-send/failed-hook.ts:234, release.ts:620) and not one can emit `unsubscribed` — five write a literal and four are typed by closed unions that exclude it. Every literal 'unsubscribed' elsewhere in the tree is either channel_enrollments.status (a different table and vocabulary), a migration CHECK, a doc, or one test fixture. The row is TRUE. One incomplete sub-clause found while verifying is raised separately as RT-23.

#### RT-17 — P0 — fixed

*The refusal_events purge-verification branch is pinned by SQL TEXT only - two semantically meaningful mutants survived, including one that makes the verification blind to exactly the account-wide rows the case is named for*

**At** `src/lib/account-offboarding/purge-verification.ts:626`

FIXED — the categorical defect is closed. The branch now has a live-DB oracle: worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts:1415 seeds one per-location and one account-wide Refusal, calls verifyAccountOffboardingPurge against a real database and asserts the exact count, replacing a mock that fabricated [{violation_count: 2}] for any query naming the table. This pass confirmed the case executes the arm against a real database (baseline green, exactly one test executed) and that its assertion is the exact violationCount rather than a text match. RT-17's two named mutants are killed by construction: `AND subject_id IS NOT NULL` reports 1 because seedRefusalEvent writes subject_id NULL for the account-wide row (:668, C2 forces it), and renaming the alias makes countViolations read `undefined ?? 0` at purge-verification.ts:70 and report no issue at all. DISCLOSURE: this pass did not re-run those two mutants — T1's two-mutation cap was spent on two NEW mutants, both of which survived — so RT-17's `fixed` disposition rests on that analytic proof plus the invoking agent's prior measurement, an input this pass did not reproduce. The residual gap the two new survivors expose is raised as RT-21, which is a different finding: RT-17 was 'the oracle is a mock', RT-21 is 'the live oracle's fixture cannot discriminate a predicate change'.

#### RT-18 — P2 — fixed

*The closed-vocabulary cases assert the ORDER of the rendered CHECK members, which migration 116 itself calls presentation*

**At** `src/lib/shared/__tests__/migration-116-refusal-events.integration.test.ts:1056`

FIXED — and proven by measurement rather than by reading the diff. The three assertions at src/lib/shared/__tests__/migration-116-refusal-events.integration.test.ts:1054-1062 now sort both sides, which removes ORDER sensitivity only; `toEqual` on arrays still compares element-wise after the sort, so a membership difference in either direction changes the length and fails. Both directions were measured against the live database. M3 dropped `policy_gate_held` from the expected REFUSAL_SOURCES list (blob 4c2d4d0ae033 -> 33f2255d7834): KILLED at :1053 — 'expected [ …(6) ] to deeply equal [ …(5) ]', i.e. the DB carrying an EXTRA member still fails, which is the 'a closed vocabulary is only closed if nothing extra is in it' direction the comment claims. M4 added a member the CHECK does not admit (-> 3bf72d6f7951): KILLED at :1055 — 'expected [ …(6) ] to deeply equal [ …(7) ]', the 'every member is present' direction. Sorting did not make the assertions pass on a set they should reject.

#### RT-19 — P2 — fixed

*The Restraint tab term says "the route today has no tab UI"; the route renders two role="tablist" controls today*

**At** `CONTEXT.md:165`

FIXED — the false claim is gone and the replacement's load-bearing clause is true. CONTEXT.md:165 no longer says 'the route today has no tab UI'; it says there are no Metrics/Restraint PAGE-LEVEL tabs, which is verified: `rg` for 'Restraint' across src/ returns only src/lib/solicitation/restraint-policy.ts (an unrelated solicitation surface), `find src/app -iname '*restraint*'` is empty, src/app/(authenticated)/dashboard/analytics/ holds exactly one file, and neither AnalyticsAggregateView nor AnalyticsPerLocationView renders a tablist or nav. The per-card control the new sentence points at is real: src/components/dashboard/charts/CardViewTabs.tsx carries role="tablist" (:74), role="tab" (:85) and role="tabpanel" (:97). Two residual inaccuracies in the replacement wording are raised separately as RT-24; they do not restore the original false claim.

#### RT-20 — P2 — fixed

*The disposition reason’s analogy set is off: two of the three tables it names as needing an explicit DELETE for "the same reason" DO carry ON DELETE CASCADE to both tenant roots*

**At** `src/lib/account-offboarding/table-disposition.ts:330`

FIXED — every one of the four referential-action claims in the rewritten reason string (src/lib/account-offboarding/table-disposition.ts:330) was verified by pg_constraint catalogue query against the local test database, not by reading the diff. Query joined pg_constraint to pg_class for contype='f' over the four tables and read confdeltype/confupdtype. Results: refusal_events has EXACTLY two foreign keys, to accounts and to businesses, both confdeltype='a' (NO ACTION) — 'its only foreign keys are to accounts and businesses, neither carrying a referential action' is exact. review_escalations is likewise 'a' to BOTH roots (it also has review_id->reviews 'a' and agent_run_id->agent_runs 'n' SET NULL, neither of which is a delete cascade), so 'the same mechanism review_escalations relies on, which is likewise NO ACTION to both roots' is exact. contact_csv_uploads is confdeltype='c' (CASCADE) to BOTH accounts and businesses, and agent_outcomes is 'c' to BOTH — so 'they DO carry ON DELETE CASCADE to both roots' is exact, and the round-1 defect (claiming they share the NO ACTION mechanism) is corrected in the right direction. The supporting sub-claim was checked too: accounts, businesses and users are all `retain_deidentified` in TABLE_DISPOSITIONS (:74, :81, :88), so no parent is deleted and the cascade is genuinely inert. Separately, nothing ASSERTS these clauses — see RT-25.

#### RT-12 — P2 — **open**

*The intake still puts all ELEVEN Refusal write sites in #1010-#1013 while migration 116’s header puts the first caller in #1009 and the other TEN in #1010-#1013*

**At** `docs/superpowers/plans/feat-1008-migration-116-refusal-events-intake.json:8`

STILL OPEN at HEAD, and the reversal direction is not what keeps it open — the sweep is. 5fa786be reversed the round-1 edit and recorded D16, but the superseded phrasing survives in TWO tracked files the sweep did not reach. (1) docs/superpowers/plans/feat-1008-migration-116-refusal-events-intake.json:8 is a git-TRACKED, byte-identical mirror of the sha-locked .feature/intake.json — `cmp` reports identical and both hash to the digest this sidecar records as intake_sha256 — and it still reads 'Any of the eleven Refusal write sites (#1010, #1011, #1012, #1013).' The sha lock does not reach it: .agents/skills/feature/scripts/red-team-status.mjs:638 hashes join(root, '.feature', 'intake.json') and nothing else, and .gitignore:177 keeps the .feature/ copy off the branch — so the TRACKED mirror is the copy a reader on main actually finds, and it was editable throughout. (2) docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md:434-436 states the same reading in its own words under '## Not in this PR' ('All eleven write sites (#1010–#1013).') and carries no supersession marker at all. The migration header's new footnote points a reader at D16; neither of these two does. Severity unchanged at P2 for the reason D16 itself gives — no code in this diff reads it.

### Carried unchanged

| id | sev | disposition | carried from |
|---|---|---|---|
| RT-01 | P0 | fixed | round 1, evidence unchanged |
| RT-02 | P1 | fixed | round 1, evidence unchanged |
| RT-03 | P1 | fixed | round 1, evidence unchanged |
| RT-04 | P1 | fixed | round 1, evidence unchanged |
| RT-06 | P2 | fixed | round 1, evidence unchanged |
| RT-07 | P2 | fixed | round 1, evidence unchanged |
| RT-09 | P2 | fixed | round 1, evidence unchanged |
| RT-10 | P2 | fixed | round 1, evidence unchanged |
| RT-14 | P2 | fixed | round 1, evidence unchanged |
| RT-15 | P2 | fixed | round 1, evidence unchanged |
| RT-16 | P2 | fixed | round 1, evidence unchanged |
| RT-05 | P1 | accepted-risk | round 1, evidence unchanged |
| RT-08 | P2 | accepted-risk | round 1, evidence unchanged |
| RT-11 | P2 | rejected | round 1, evidence unchanged |

Their dispositions and evidence are carried byte-faithfully in `findings.json`. This round
re-derived nothing about them beyond confirming, for RT-05/RT-08, that the alerting surface
they describe is untouched by the fix commit.

## Inventory

| id | outcome | file | test |
|---|---|---|---|
| INV-01 | `survived-confirmed-P0` | `worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts:1415` | purge verification counts BOTH surviving refusal_events shapes, the account-wide row in… |
| INV-02 | `survived-confirmed-P0` | `src/lib/account-offboarding/__tests__/purge-verification.test.ts:214` | purge verification counts refusal_events rows for the target account, including account… |
| INV-03 | `killed` | `src/lib/shared/__tests__/migration-116-refusal-events.integration.test.ts:1047` | the refusal_source, refusal_category and subject_type CHECKs admit exactly the seven la… |
| INV-04 | `inconclusive` | `src/lib/account-offboarding/__tests__/table-disposition.test.ts:170` | classifies refusal_events as hard_delete by direct_account_id, verified must_be_absent |
| INV-05 | `excluded` | `supabase/migrations/116_refusal_events.sql:10-19` | migration 116 header comment — the write-site split and its D16 footnote |
| INV-06 | `excluded` | `CONTEXT.md:165` | CONTEXT.md — the Restraint tab term, "no Metrics/Restraint page-level tabs" |
| INV-07 | `excluded` | `docs/adr/0023-refusal-log-owner-safe-projection.md:184` | ADR 0023 — the rewritten `unsubscribed` anchor row |
| INV-08 | `excluded` | `.claude/reference/arch-review-log.md:1421` | arch-review-log branch row — "Then THREE red-team passes" |
| INV-09 | `excluded` | `docs/superpowers/plans/feat-1008-migration-116-refusal-events-deviations.md:8` | deviations triage table and the new D16 section |
| INV-10 | `excluded` | `docs/reviews/red-team/feat-1008-migration-116-refusal-events-cbbac6/findings.json` | this pass's own two report artifacts |

## Authorizations

Rendered from `findings.json`. **This round added none.**

### AUTH-1008-01 — 2026-08-29 — covers RT-05, RT-08

> Accept the risk, file a follow-up. Rationale: the gap predates this branch, the failure path is only reachable in a window the ship order already closes (production DDL lands before the code), and a runbook rule is a distinct piece of ops work that deserves its own review rather than being appended to a schema PR. Follow-up filed as RepWorth/ai-review-responder#1016.

## What blocks

**RT-21 (P0, open) blocks the PR.** The `refusal_events` purge-verification arm is now
covered by a live database, which is a categorical improvement over the fabricating mock —
but its fixture seeds two rows that are both fresh and both in-tenant and asserts exactly
their count, so any predicate change both rows satisfy is invisible. Two such mutants were
measured and both survived **every** covering case. One of them — a retention-window
conjunct on `occurred_at` — makes a `must_be_absent` table report a CLEAN purge over
surviving account decision history, which is the same failure class round 1 named. The
remediation is a two-row fixture change, not a redesign.

**RT-22 (P1, open) needs user adjudication** — this is a high-risk run, so the checker
blocks an open P1 without an authorization. The substance is narrow: D16's *verdict* is
probably right (its dead-code-gate argument stands on its own), but the two evidentiary
facts it records to justify overriding a sha-locked contract are both false. Adjudicating it
is a choice between correcting D16's reasoning, authorizing the risk, or rejecting the
finding with a one-line verdict.

**Four P2s are recorded and block nothing**: RT-12 (two tracked copies of the superseded
write-site phrasing), RT-23 (the ADR's enumeration omits the `unknown` arm), RT-24 (the
CONTEXT.md control-type axis is inverted), RT-25 (the new referential-action clauses are
asserted by nothing).

**Round cap reached.** This is round 2 of a hard cap of 2. Anything left open after this
goes to the arbiter, and on a high-risk branch that means the user.

## Restoration

`finalize` ran between every mutant and once at the end: 12 process groups reaped, every
mutated file restored from its journaled original blob and verified by OID, and the dotenv
files restored. `git status --porcelain` is empty apart from these two report artifacts, and
HEAD is unmoved at `5fa786be473b6dd0a08fdc481a3e79c07cae5c4f`.

---

## Post-round remediation — measured by the invoking agent, not by round 2

**Read this before trusting the dispositions above.** Round 2 ended `OPEN_P0`
with six open findings. Those six are now `fixed`, and three inventory rows
changed outcome. The measurements behind that were made by the INVOKING agent
at `2765377e`, after round 2 finalized — not by the round-2 subagent.

**Why it is recorded here rather than in a round 3.** The skill's cap is two
rounds and `mutation-runner.mjs` enforces it. The owner was woken, as the cap
rule requires, and chose a measured remediation by the invoking agent over a
third cap override. The skill's own escape is what makes the inventory rows
legitimate: "any in-scope `inconclusive` row forces its incomplete status
**unless a later valid mutation resolves that row**." These are those
mutations. Every one followed the same discipline the runner enforces: apply
one semantic mutation, run the individual covering test, classify, restore,
and verify the file byte-identical to HEAD before the next.

**The eight mutants, and why these eight.** Round 2's lesson was that the
fixture is the oracle, and a fixture holding a dimension constant cannot catch
a predicate that narrows on it. So the matrix covers every dimension this
arm's `WHERE` clause can narrow on, not only the two that had already escaped.

| # | Mutation | Dimension | Result |
|---|---|---|---|
| M1 | `AND occurred_at >= NOW() - INTERVAL '30 days'` | time | KILLED |
| M2 | `OR account_id IS NOT NULL` | tenant (widening) | KILLED |
| M3 | `AND subject_id IS NOT NULL` | subject | KILLED |
| M4 | alias `violation_count` → `violations` | row shape | KILLED |
| M5 | `AND business_id IS NOT NULL` | location | KILLED |
| M6 | `AND refusal_source <> 'held_draft'` | lane | KILLED |
| M7 | negate the cascade-direction clause | prose | KILLED |
| M8 | negate the `review_escalations` clause | prose | KILLED |

M1 and M2 are the two this round found surviving both covering cases. M3 and
M4 are RT-17's originals, re-measured against the rebuilt fixture. M5, M6 and
M8 were added by the invoking agent because they were not proposed by any
round — they are the dimensions the fixture had not been proven against.

**What the remediation changed.** `seedRefusalEvent` gained an optional `age`
interval, which is what makes the temporal axis expressible at all; it
hard-coded `NOW()`. The live-DB arm now seeds four rows — per-location,
account-wide, 400 days old, and one under a bystander account — and asserts
`violationCount` is exactly 3 plus that the bystander retains its own row.

**Two limits, stated rather than buried.**

1. **This is the author measuring the author's own fix.** An independent
   verifier is the point of the red-team role, and that property is absent for
   these eight measurements. What replaces it is that the mutants, the runs and
   the restores are all reproducible from this table, and that the matrix is
   wider than a round's 2-mutations-per-test budget would have allowed.
2. **RT-21's wider scope is untouched.** 31 tables carry
   `purgeVerification: 'must_be_absent'` and only three live-DB
   `verifyAccountOffboardingPurge` arms exist, so the other branches are
   covered by the SQL-text mock alone and M1-style mutants would survive there
   too. That is unchanged code, out of scope for this branch, and recorded here
   so the next change to that file starts from it.
