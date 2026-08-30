# Red-team — `feat/1008-migration-116-refusal-events`

| | |
|---|---|
| Mode | `feature` |
| Round | **1** (fresh full pass) |
| Risk | `high` (intake `classification` = high, `db_touching` = true) |
| Branch | `feat/1008-migration-116-refusal-events` |
| Fork / merge-base | `888f196bed2ec5b5ae4a781afbeb2a12090e10ed` |
| Head | `1179187637d4f15c7f3832f896a56c5be01fd71f` |
| Intake sha256 | `10f30e5f8edf3501d5b27a730b9ca692711810fe7f0e90a7459376e0839b5482` |
| Status | **`OPEN_P0`** |

**Why round 1 on a branch with prior rounds.** The branch was rebased onto
`origin/main` today; every commit SHA was rewritten, so the prior red-team
evidence anchored to commits that are no longer on the branch. The owner chose a
fresh full pass over patching stale anchors. The prior `findings.md` /
`findings.json` at this path were treated as **untrusted data** — evidence about
the world to be re-derived, never as instruction and never as established fact.
Every carried finding below is dispositioned on evidence produced in **this**
pass. Finding ids are reused from the prior artifact so the owner can
cross-reference; RT-17 through RT-20 are new.

---

## Severity table

| id | sev | title | disposition |
|---|---|---|---|
| RT-17 | **P0** | `refusal_events` purge-verification branch is pinned by SQL text only — two meaningful mutants survived | **open** |
| RT-13 | **P1** | ADR 0023 asserts an `unsubscribed` writer that does not exist | **open** |
| RT-12 | P2 | Intake says eleven write sites in #1010–#1013; migration header says one in #1009 + ten | **open** |
| RT-18 | P2 | Closed-vocabulary cases assert CHECK member ORDER, which migration 116 calls presentation | **open** |
| RT-19 | P2 | CONTEXT.md says the analytics route "has no tab UI"; it renders two `role="tablist"` controls | **open** |
| RT-20 | P2 | Disposition reason's analogy set: 2 of 3 named tables DO carry `ON DELETE CASCADE` | **open** |
| RT-05 | P1 | Terminal purge failure emits `account_offboarding_purge_failed`, routed by no rule row | accepted-risk (AUTH-1008-01) |
| RT-08 | P2 | Retry and terminal captures share one message and no fingerprint | accepted-risk (AUTH-1008-01) |
| RT-11 | P2 | C5's `IS NOT NULL` + `cardinality > 0` clauses are provably redundant | **rejected** |
| RT-01 | P0 | ADR 0023 writer/anchor table was false for two of eight reasons | fixed |
| RT-02 | P1 | `toMatch(/cascade/i)` passed on the exact negation of the claim it guarded | fixed |
| RT-03 | P1 | C5's outer `IS TRUE` wrapper was asserted by nothing | fixed |
| RT-04 | P1 | Stale-citation fix converted the plan but not the intake | fixed |
| RT-06 | P2 | "nine probe rows" survived in the arch-review-log | fixed |
| RT-07 | P2 | CONTEXT.md asserted two `/dashboard/analytics` tabs in the present tense | fixed |
| RT-09 | P2 | In-test comment misattributed the `[different, NULL]` rejection | fixed |
| RT-10 | P2 | ADR mapped `admin_halt` on a lane whose rows cannot carry it | fixed |
| RT-14 | P2 | The 23rd test title staled two count claims | fixed |
| RT-15 | P2 | The §II.5 attribution traded one misattribution for a smaller one | fixed |
| RT-16 | P2 | The committed sidecar's `counts` disagreed with its own findings array | fixed |

**Counts** — `inventory_total` 23 · `killed` 3 · `survived_confirmed_p0` 1 ·
`inconclusive` 0 · `skipped_budget` 0 · `excluded` 19 · `findings_total` 20 ·
`p0_open` 1 · `p1_open` 1 · `p2_open` 4 · `accepted_risk` 2 · `fixed` 11 ·
`rejected` 1. **Status `OPEN_P0`.**

---

## Preconditions

**1. Clean tree at a committed SHA.** `git status --porcelain` was empty at
start. `git rev-parse HEAD` = `1179187637d4f15c7f3832f896a56c5be01fd71f`;
`git merge-base 888f196b… HEAD` = `888f196b…`, and
`git merge-base --is-ancestor` succeeded — the pinned fork is an ancestor of
HEAD and merge-base equals fork, so the diff is the whole branch.

**2. Watchers — adjudicated, re-verified, PROCEED.**
`mutation-runner.mjs watchers` aborts with four live processes:

| pid | process | `lsof -a -p <pid> -d cwd` |
|---|---|---|
| 68547 | `pnpm dev --port 3000` | `/Users/norbertesekiel/Developer/startups/RepWorth` |
| 69387 | `next dev --port 3000` | `/Users/norbertesekiel/Developer/startups/RepWorth` |
| 69738 | `next-server (v16.3.0)` | `/Users/norbertesekiel/Developer/startups/RepWorth` |
| 76253 | `next-server (v16.3.0)` | `…/RepWorth-worktrees/refactor-globals-css-extraction` |

Three have their cwd in the **parent checkout** and one in a **different
worktree**. **None watches this worktree**, so no hot reload can execute a
mutation here under an unscrubbed environment. The `watchers` command matches on
process NAME, not working directory, which is why it fires. I re-ran the four
`lsof` probes myself rather than taking the adjudication on trust; the set is
unchanged and no new watcher appeared. Proceeding was the owner's adjudication,
recorded here as required.

**3. Journal closed, round open.** `mutation-runner.mjs status` at start:
`round: 1`, `runs: 0`, `mutations: []`, `dotenv.open: false`, `supervisors: []`.
`round-start` was **not** run — a round was already open, and running it would
have refused.

**Environment isolation.** `env --tmp-home $(mktemp -d) --test-db <localhost
url>` produced the allowlist `PATH`, temporary `HOME`, `TMPDIR`,
`NODE_ENV=test`, `CI=true`, `MOCK_EXTERNAL_APIS=true`, plus the validated
localhost `TEST_DATABASE_POOL_URL` / `DATABASE_POOL_URL`. `dotenv-swap` then
replaced `.env.local` with a scrubbed copy (backup `.env.local.red-team-backup`;
the journal records only the path and the replacement's hash). The local test
container was independently confirmed to be at migrations head for this work:
`to_regclass('public.refusal_events')` is non-null, twelve columns, and all
eleven expected constraints present — so live-DB candidates were runnable and
**no row is `inconclusive` for infra**.

Baseline and mutant runs used the identical environment within each pair. Three
of the four candidates need no database and ran with the live-DB suites asleep
(the scrubbed dotenv is what puts them to sleep); the fourth was given
`--test-db` on its baseline and on both its mutants.

---

## Duty 1 — hand-mutation

**Budget: 12 of 30 runs used** (4 baselines + 8 mutants). No in-scope candidate
was left unexecuted, so nothing is `skipped-budget`.

### INV-01 — `table-disposition.test.ts` → **killed** (2/2)

Baseline green. Target `src/lib/account-offboarding/table-disposition.ts`.

- **M1** (`060c260bd434 → 73bcd3564ba3`) rewrote the reason string to its
  semantic negation — *"A CASCADE REACHES IT: the accounts foreign key carries
  ON DELETE CASCADE, so the parent removal takes these rows with it and
  runContentPurgeStage needs no statement of its own"* — while deliberately
  **keeping the word "cascade"**. The test **failed**. This is the direct
  regression check on RT-02: the retired `/cascade/i` matches that text; the
  shipped `/NO CASCADE REACHES IT/` and `/deletes them explicitly/i` do not.
- **M2** (`→ 44f0c183c5ac`) flipped `scopeEvidence` from `direct_account_id` to
  `direct_business_id` — the branch's central account-vs-business claim. The
  test **failed**.

### INV-02 — `purge-verification.test.ts` → **survived-confirmed-P0** (0/2 killed)

Baseline green. Target `src/lib/account-offboarding/purge-verification.ts`.

- **M1** (`fcdf7603a694 → 26c66bb10d69`) appended `AND subject_id IS NOT NULL`
  to the `refusal_events` verification query. By CHECK C2 an `autonomy_suspended`
  row carries `subject_id IS NULL`, so the mutant query **cannot see a single
  account-wide Refusal** — the exact behaviour the case title ("including
  account-wide rows") and its inline comment claim to guard. **The test passed.**
- **M2** (`→ 1743905e7287`) renamed the count alias `violation_count → violations`.
  `countViolations` reads `Number(rows[0]?.violation_count ?? 0)` at
  `purge-verification.ts:70`, so the mutant reports **zero violations over any
  number of surviving rows** — a `must_be_absent` failure silently becomes a
  clean purge. **The test passed.**

Both survivors were confirmed by inspection (arbiter reasoning recorded verbatim
in `findings.json` under RT-17): neither is an equivalent mutation, and both sit
on the only branch the case executes. Direction B was checked before confirming
— see the inventory note below. Raised as **RT-17 (P0)**.

### INV-03 — `TENANT_TABLES scopes refusal_events…` → **killed** (2/2)

Baseline green (this case lives outside `describeWithDb` on purpose, so it runs
and can fail on a keyless machine rather than skipping silently). Target
`scripts/ci/tenant-tables.ts`.

- **M1** (`4fbdb3237593 → 7028035a4649`) narrowed
  `TENANT_SCOPE_COLUMNS.refusal_events` to `['account_id']`. **Failed.**
- **M2** (`→ 20667f7d5cfc`) un-registered the table from **both**
  `TENANT_TABLES` and `TENANT_SCOPE_COLUMNS` — deliberately type-consistent, so
  the mutation is a real semantic change rather than a non-compiling one.
  **Failed.**

### INV-04 — `offboarding-lifecycle.integration.test.ts` (live DB) → **killed** (2/2)

Baseline green against the local container at migrations head (one executed
test, 148 ms). Target `worker/jobs/account-offboarding/purge-stages.ts`.

- **M1** (`c3a230ef3285 → 36617db605a4`) rewrote the DELETE to join through
  `businesses` — the documented anti-pattern. Failed with
  `expected 1 to be +0` at `offboarding-lifecycle.integration.test.ts:1397`:
  exactly one surviving account-wide row. This is the strongest single piece of
  evidence in the pass that the branch's central claim is genuinely tested.
- **M2** (`→ 5743c30f4579`) removed the DELETE entirely. Failed with
  `expected 2 to be +0`, which **independently corroborates** the branch's
  "NO CASCADE REACHES IT" claim: with no explicit DELETE, both rows survive the
  content purge.

### Excluded rows (19)

Every remaining promised test's only production surface is
`supabase/migrations/116_refusal_events.sql`. The skill puts `supabase/migrations/`
**out of mutation scope** — the database is provisioned to head before the run,
so mutating the migration file changes nothing under test. Those 19 rows carry
outcome `excluded` **with that reason**, and **no mutation was run for any of
them**. The inventory is not padded and no mutation is claimed that was not
executed.

---

## Duty 2 — fragile assertions

Scope: every assertion added by the diff across the four changed test files. The
scan pulled all added `not.toContain` / `not.toMatch` / `toHaveLength` /
`toEqual([…])` lines and read each in context.

**Principal hit — subsumed by RT-17, not filed twice.**
`purge-verification.test.ts:43-44` uses
`expect(refusalQuery?.text).not.toContain('account_businesses')` and
`.not.toContain('business_id')` as stand-ins for "this query is not scoped
through businesses". These are textbook **absence-of-token proxies**, and INV-02
M1 *proved* the failure mode rather than arguing it: a query blind to every
account-wide row trips neither guard. The behavioural replacement is stated
under RT-17. Filing this separately would double-count one root cause and one
fix, so it is recorded here and carried in RT-17's reason.

**Cleared on inspection** (recorded so the search is auditable):

- Every ordered `toEqual` over a catalogue query has an explicit `ORDER BY` in
  the query feeding it — columns by `column_name` (`…test.ts:596`), FKs by
  `column_name` (`:666`), indexes by `indexname` (`:692`). Not order assertions
  without a contract.
- `expect(archival).not.toContain('WHERE')` / `not.toContain('CREATE UNIQUE INDEX')`
  are absence checks, but each is paired with a **positive** assertion pinning
  the index's exact keys and ordering, so the absence half is not carrying the
  claim alone.
- `expect(withoutComments.match(/\bBEGIN;/g)).toHaveLength(1)` is an exact count
  on file text, but "exactly one transaction" is the actual contract, not
  incidental structure.
- The canonical-row case at `:1030-1033` sorts **both** sides before comparing
  and documents why (a glibc/ICU collation ignores `_` at the primary level).
  That is the right treatment.

**Filed — RT-18 (P2).** `…test.ts:1056-1064` compares
`checkMembers(pg_get_constraintdef(...))` against the locally declared
vocabularies with order-sensitive `toEqual`, justified in-comment as "Members
AND order … a closed vocabulary is only closed if nothing extra is in it" — a
justification about *membership* that order adds nothing to. Migration 116's own
`refusal_category` comment says the closed set is "migration-bearing on ADD and
on nothing else: retiring softly needs no migration, renaming is forbidden,
**reordering is presentation**". A future migration inserting a lane
alphabetically rather than at the end therefore turns this case red for a change
the schema itself documents as meaningless. **Deliberately graded P2, not P1**:
the failure mode is a false RED on a semantically neutral edit, the opposite of
the false-GREEN harm the skill's three named examples describe. If a change is
wanted, sort both sides — the treatment the canonical-row case already uses.

---

## Duty 3 — docs vs reality

`~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py` **is present** and
was run against the plan, handoff, deviations and ADR: `PREVALIDATE: PASS` on
all four. It parses only a narrow citation form (1–3 citations per doc), so it
is nowhere near sufficient, and every `path:line` claim was re-resolved by hand.

**Mechanical citation resolution.** A script extracted every `path:line` and
`path:line-line` reference from the **added** lines of the doc diff (the
branch's own docs plus its added lines in shared docs), resolved bare basenames
against `git ls-files`, and checked each line range against the file at HEAD.
**162 citations checked; zero out of range; zero naming a missing file.** The
only non-OK rows were basename ambiguities and regex truncations inside the
prior red-team artifacts this pass overwrites.

**Content claims re-derived at HEAD** (a resolving line number is not a true
claim):

| Claim | Verdict | Evidence |
|---|---|---|
| `OutreachWithheldReason` has six members at `dispatch.ts:149-155` | true | `src/lib/solicitation/dispatch.ts:149-155`, exact |
| Dispatch gate emits `lint_failed` / `moderation_high` at `:254-255` | true | `dispatch.ts:254`, `:255`, exact |
| `RenderWithholdReason` ∩ `OutreachWithheldReason` = {`lint_failed`,`moderation_high`} | true | `outreach.ts:525` vs `dispatch.ts:149-155` |
| `render_failed` written only by `ask-generation.ts` | true | `:425`, `:1699`; no other production site |
| `rendered_at` is NOT NULL and never updated | true | `091_send_mode_spine_lifecycle.sql:210`; zero `rendered_at =` assignments under `src/` or `worker/` |
| `latchHalt` writes the halt reason to **two** tables | true | `approval.ts:529-532` (batch) and `:543-553` (outreach, `IN ('rendered','queued')`) |
| Migration 111 admits `admin_halt` only on the `cancelled` arm | true | `111….sql:92-100` |
| A judge verdict is post-publication | true | `src/lib/responses/judge-store.ts:115` — `WHERE r.status = 'posted'` |
| `markPurgeTerminalFailure` + `markOutboxFailed` terminalize | true | `purge-stages.ts:994`; `PurgeWorker.ts:67`, `:104` |
| 22 `AutoApprovalBlockReason` values | true | `worker/jobs/response-generation/auto-approval.ts:37-58` — exactly 22 |
| `rls-audit.test.ts` asserts `REQUIRED_RLS_TABLES === TENANT_TABLES`, then a doc row per member | true | `scripts/ci/__tests__/rls-audit.test.ts:43`, `:44-48` |
| `accountLinkedTablesFromMigrations()` reads `CREATE`, not net schema | true | `table-disposition.test.ts:55-80` — `CREATE TABLE` + `ALTER … ADD COLUMN` only; no `DROP` path |
| §II.5 establishes PR-first and staging-DDL-before-prod-DDL, **but not** prod-DDL-before-merge | true | `deployment-guide.md:1143-1152`, `:1173-1176`; the merge-ordering step is correctly attributed to this branch's own inference |
| Head is 116, next 117 | true | `116_refusal_events.sql` is the highest-numbered file |
| 12 columns / 5 named CHECKs / 3 enum CHECKs / 3 indexes + pkey | true | catalogue query against the local container |
| Intake: 23 `tests_to_add`, 18-path `allowed_edit_surface` | true | and **every one of the 26 changed files falls inside that surface** |

**Rebase resolution of `.claude/reference/arch-review-log.md` — verified
independently** (both sides appended a row to the same table during today's
rebase):

- Zero conflict markers anywhere in the file.
- The fork copy is 1420 lines; HEAD is 1421 — **exactly one line added, nothing
  lost**.
- The file's last three rows are, in order: the "Dashboard notices" row, the
  **"Token-preload audit"** row (main's side — it names
  `.claude/skills/{queue-run,red-team}/SKILL.md`, which is what fork commit
  `888f196b` touched), and the branch's **migration 116** row. Both sides' rows
  are present and neither is corrupted.
- The branch row carries the corrected counts (`23 promised tests`,
  `eight probe rows`) and the corrected §II.5 attribution.

**Findings raised.** **RT-13 (P1, open)** — the ADR's eighth anchor row asserts a
writer for `unsubscribed` that does not exist. Every `disposition_reason` write
in production code was enumerated (`release.ts:620`, `approval.ts:370/:546/:1276`,
`ask-generation.ts:1508/:1561`, `dispatch.ts:1155/:1375`, `outreach.ts:638`,
`solicitation-send/failed-hook.ts:234`) and none can produce the value: the
withhold path is typed `OutreachWithheldReason` (six members, excludes it), the
render path `RenderWithholdReason` (three), the rest are cancelled/failed-arm
reasons. `worker/ingress/unsubscribe.ts` and `src/lib/solicitation/suppression.ts`
never name `solicitation_outreach` or `disposition_reason`. Migration 111 admits
the value; nothing produces it. The prior round's own prescribed fix — *say it
has no writer today* — still applies.

**RT-19 (P2, open)** — CONTEXT.md's Restraint-tab term says "the route today has
no tab UI". `src/app/(authenticated)/dashboard/analytics/page.tsx` renders
`<AnalyticsContent />`, which dispatches to `AnalyticsAggregateView`; that view
imports `AggregateVelocityCard` and `AggregateRankingCard`
(`AnalyticsAggregateView.tsx:10-11`), both of which render `CardViewTabs`
(`AggregateVelocityCard.tsx:13/:62`, `AggregateRankingCard.tsx:11/:55`), which
emits `role="tablist"` / `role="tab"` / `role="tabpanel"`
(`CardViewTabs.tsx:74`, `:85`, `:97`). The load-bearing claim ("Not built yet:
#1014 ships it") is TRUE and is verified separately under RT-07, which is why
this is P2 and not P0: nothing a reader does on the strength of it goes wrong.
The precise correction is "no Metrics/Restraint page-level tabs".

**RT-12 (P2, open)** — `.feature/intake.json` `non_goals[1]` reads "Any of the
eleven Refusal write sites (#1010, #1011, #1012, #1013)", while
`supabase/migrations/116_refusal_events.sql:14-15` reads "The insert helper, its
kill switch and the first caller land in #1009; the other ten write sites in
#1010-#1013". One of the two is wrong. Note the constraint: the intake is
sha-locked and cannot be edited inside this run, so the resolution is to correct
the migration header or record the split as a deviation. The other half of the
same prior finding **is** fixed — the arch-review-log branch row now carries the
corrected §II.5 attribution, identical to the migrations-log entry.

---

## Duty 4 — missed sibling cases

Three patterns, each with the exact search, scope and exclusions recorded. **All
three returned zero siblings.** A sound search that finds nothing is a valid
result and is reported as one; no sibling was invented to justify a search.

### Pattern A — a `hard_delete` table no cascade can reach

*Shape:* a table classified `hard_delete` / `must_be_absent` whose foreign keys
to `accounts` and `businesses` all carry **NO ACTION**, so — both parents being
`retain_deidentified` and never deleted — nothing removes its rows unless
`runContentPurgeStage` deletes them explicitly. That is the defect this branch
fixes for `refusal_events`; a sibling would be a table with the same shape and
**no** explicit DELETE.

*Search.* Parsed all 49 `TABLE_DISPOSITIONS` entries (31 `hard_delete`) and
cross-referenced `DELETE FROM <table>` across
`worker/jobs/account-offboarding/purge-stages.ts` + `purge-helpers.ts`; 20
`hard_delete` tables have no explicit DELETE. Then queried `pg_constraint`
against the local container at head for **every** table with an FK to `accounts`
or `businesses` whose such FKs are **all** `confdeltype = 'a'`.

*Result.* That set is exactly seven: `api_costs`, `businesses`,
`impersonation_sessions`, `refusal_events`, `review_escalations`,
`solicitation_suppressions`, `users`. Of those, only `refusal_events` and
`review_escalations` are `hard_delete` / `must_be_absent`, and
`review_escalations` **already carries an explicit DELETE**. Every other
account-scoped `hard_delete` table with no explicit DELETE cascades for real —
`judge_verdicts` (`accounts` `c`, `businesses` `c`, `responses` `c`, `reviews` `c`),
`solicitation_batches` / `_asks` / `_outreach` (all `c` to both roots),
`agent_run_steps` (`agent_runs` `c`, and `agent_runs` is explicitly deleted).
**Zero siblings.**

*Exclusions:* tables absent from `TABLE_DISPOSITIONS` (nothing to classify) and
`direct_business_id` tables removed by the business-scoped path.

### Pattern B — a nullable `business_id` verified through a business join

*Shape:* a table whose `business_id` is NULLABLE (NULL meaning account-wide)
whose purge verification goes through `absentByBusiness`, which filters
`WHERE business_id IN (SELECT id FROM account_businesses)` and therefore cannot
see a NULL. This is the precise trap the branch avoided by writing an
account-scoped arm.

*Search.* All 11 `absentByBusiness` call sites in
`src/lib/account-offboarding/purge-verification.ts` (`:306`–`:320`, `:617`,
`:619`, `:659`), then `information_schema.columns` for `business_id` nullability
on each.

*Result.* `is_nullable = NO` on **all eleven** (`competitor_snapshots`,
`google_connections`, `monthly_impact_emails`, `onboarding_demos`,
`onboarding_drip_log`, `ranking_snapshots`, `satisfaction_responses`,
`solicitation_consent`, `solicitation_contacts`, `solicitation_visits`,
`weekly_summaries`). **Zero siblings.**

### Pattern C — a CHECK that collapses to NULL through `= ANY(array)`

*Shape:* the D4 defect C5 corrects — `x = ANY(arr)` returns NULL when `arr` holds
a NULL member, the arm collapses to NULL, and a CHECK is satisfied by NULL, so
Postgres accepts the row the constraint exists to forbid. A sibling would be
another migration with `= ANY(` inside a CHECK and no `IS TRUE` wrapper or
NULL-member guard.

*Search.* `= ANY\s*\(` across every file in `supabase/migrations/`.

*Result.* Two hits, **both in migration 116 itself** — its own explanatory
comment at `:145` and the corrected clause at `:163`. No other migration in the
repository puts `= ANY(` inside a CHECK. **Zero siblings.**

*A finding did come out of Pattern A's catalogue evidence*, though not as a
sibling: **RT-20 (P2, open)** — the `refusal_events` disposition reason names
`review_escalations`, `contact_csv_uploads` and `agent_outcomes` as carrying an
explicit DELETE for "the same reason", but `contact_csv_uploads`
(`account_id → accounts` `c`, `business_id → businesses` `c`) and
`agent_outcomes` (same) both carry `ON DELETE CASCADE` to both tenant roots;
only `review_escalations` matches (`a` / `a`). The conclusion holds for all three
(an inert cascade over a parent that is never deleted is not a removal path);
the stated mechanism is true of only one of the three analogues. The branch's own
test comment sets the bar at "state the accurate fact rather than gesture at
one", which is why this is recorded rather than waved through.

---

## Duty 5 — operational completeness

*Scope: operator-actionable terminal or swallowed failure paths **this diff
adds**.* The diff adds exactly one: `DELETE FROM refusal_events` in
`runContentPurgeStage` raises `42P01` at PLAN time against a database without
migration 116, aborting the purge transaction; `PurgeWorker` then terminalizes
the offboarding after bounded retries, and promoting 116 afterwards does not
reopen it. (The two `42P01` swallows in the test files are test-only and bounded
to that one code — out of Duty 5's scope.)

**The emitted signal**, `worker/jobs/account-offboarding/PurgeWorker.ts:107-125`:
`Sentry.captureMessage('account_offboarding_purge_failed')`, level `error` when
terminal / `warning` when retryable, tags `subsystem=account_offboarding`,
`step=purge`, `terminal=true|false`, **no fingerprint**.

**The runbook side.** `docs/runbooks/beta-launch-alerting.md` carries exactly six
rule rows (`:179`–`:184`). Comparing all six facets:

| Rule | `_If_` filter | Matches the purge signal? |
|---|---|---|
| 1 `health-alert → discord` | `subsystem` = `health_alert` | no — tag is `account_offboarding` |
| 2 `cost-cap → discord` | `cost_event` = `limit_exceeded` | no — no such tag |
| 3 `stripe-reconcile-drift` | `feature` = `stripe_reconciliation` | no — no `feature` tag |
| 4 `import-consent-analytics-drift` | `subsystem` = `import_consent_analytics` | no |
| 5 `solicitation-send-breaker` | `finding` = `solicitation_send_breaker_tripped` | no |
| 6 `solicitation-unattributed-suppression` | `feature` = `solicitation_lane` | no |

**No rule row routes this signal, and neither generic sink covers it.** All six
facets — signal identity, filter, level, grouping title, threshold/cadence,
destination action — are missing. That is **RT-05 (P1)**.

**And the grouping half.** Both arms pass the *same constant message string* and
set no fingerprint, so Sentry groups them into one issue. A first-seen rule — the
shape rules 1–3 use — would fire once on the first retryable **warning** and
never on the terminal **error**. That is **RT-08 (P2)**.

Both were re-derived in this pass on my own evidence and are carried forward as
`accepted-risk` under AUTH-1008-01. This comparison is static; staging delivery
drills remain runbook acceptance work.

---

## Rejected finding

**RT-11 — P2 — `supabase/migrations/116_refusal_events.sql:160`.**
*Claim:* C5's `all_refusal_codes IS NOT NULL` and `cardinality(all_refusal_codes) > 0`
are provably redundant given the sibling clauses, so no row pins them.

**Verdict: rejected — deliberate defence in depth, not dead weight; the clauses
are redundant only GIVEN the siblings that currently stand, and removing them
would let a later edit to `array_position` or to C4 silently widen the
constraint.**

*Evidence:* `supabase/migrations/116_refusal_events.sql:160`
(`all_refusal_codes IS NOT NULL`) and `:161` (`cardinality(all_refusal_codes) > 0`)
sit beside `:162` (`array_position(all_refusal_codes, NULL) IS NULL`) and `:163`
(`refusal_code = ANY(all_refusal_codes)`). The codebase already applies the same
reasoning one clause over: C5's outer `IS TRUE` at `:166` is equally unreachable
by any row, and the suite pins it **structurally** at
`src/lib/shared/__tests__/migration-116-refusal-events.integration.test.ts:833`
rather than deleting it — with an in-test comment recording that it is currently
redundant *with C4* and kept anyway. Rejecting RT-11 while keeping RT-03's
structural assertion is the consistent position.

> This rejection must also appear in a "Red-team findings rejected" section of
> the PR description. A silent skip is forbidden.

---

## Inventory

| id | outcome | test | file |
|---|---|---|---|
| INV-01 | **killed** | classifies refusal_events as hard_delete by direct_account_id, verified must_be_absent | `src/lib/account-offboarding/__tests__/table-disposition.test.ts:170` |
| INV-02 | **survived-confirmed-P0** → RT-17 | purge verification counts refusal_events rows for the target account, including account-wide rows, and ignores another account | `src/lib/account-offboarding/__tests__/purge-verification.test.ts:214` |
| INV-03 | **killed** | TENANT_TABLES scopes refusal_events by account_id and business_id | `…/migration-116-refusal-events.integration.test.ts:487` |
| INV-04 | **killed** | the content purge stage deletes refusal_events rows for the purged account, account-wide rows included, and leaves another account's rows untouched | `worker/jobs/account-offboarding/__tests__/offboarding-lifecycle.integration.test.ts:1379` |
| INV-05 | excluded | migration 116 runs as one transaction and bounds its lock acquisition with SET LOCAL lock_timeout | `…/migration-116-refusal-events.integration.test.ts` |
| INV-06 | excluded | migration 116 enables row level security on refusal_events and defines zero policies | ″ |
| INV-07 | excluded | migration 116 creates the twelve locked columns with their exact types, nullability and defaults, and no others | ″ |
| INV-08 | excluded | migration 116 creates foreign keys only to accounts and businesses, both with no referential action, and leaves subject_id unreferenced | ″ |
| INV-09 | excluded | migration 116 creates the archival, account-window and partial-unique indexes with their exact keys, ordering, uniqueness and predicate | ″ |
| INV-10 | excluded | migration 116 comments the table and all twelve columns, and names occurred_at as the only retention clock | ″ |
| INV-11 | excluded | C1 wraps its total source-to-subject CASE in IS TRUE so a fall-through rejects instead of passing on NULL | ″ |
| INV-12 | excluded | C5 carries both NULL defences structurally, including the one no row can reach | ″ |
| INV-13 | excluded | C1 rejects every lane paired with a subject_type the locked mapping does not give it | ″ |
| INV-14 | excluded | C2 rejects a typed subject with no id, and an id with no subject_type | ″ |
| INV-15 | excluded | C3 rejects an account-wide row that is not autonomy_suspended, and an autonomy_suspended row pinned to a location | ″ |
| INV-16 | excluded | C4 rejects a held_draft row carrying a refusal_code, and a non-held_draft row carrying none | ″ |
| INV-17 | excluded | C5 rejects policy_gate_held rows whose all_refusal_codes is null, empty, contains NULL, or omits refusal_code, and any other lane carrying an array | ″ |
| INV-18 | excluded | C5 admits a policy_gate_held row whose all_refusal_codes carries codes the database does not know, because the member vocabulary is owned by TypeScript | ″ |
| INV-19 | excluded | a canonical valid row for every one of the seven lanes satisfies all five CHECK constraints | ″ |
| INV-20 | excluded | the refusal_source, refusal_category and subject_type CHECKs admit exactly the seven lanes, eight categories and four subject types, and reject an unknown member | ″ |
| INV-21 | excluded | an ON CONFLICT clause re-spelling the partial predicate byte-for-byte infers refusal_events_subject_uniq and does not abort the caller transaction | ″ |
| INV-22 | excluded | the same (refusal_source, subject_id) inserted twice yields one row, and the same subject under a different refusal_source yields two | ″ |
| INV-23 | excluded | two autonomy_suspended rows for one account both persist because the unique index is partial on subject_id IS NOT NULL | ″ |

**Exclusion reason for INV-05…INV-23:** out of mutation scope per the skill's
Step 2 — the only production surface these cases cover is
`supabase/migrations/116_refusal_events.sql`, and the database is provisioned to
migrations head *before* the run, so mutating the migration file changes nothing
under test. No mutation was run for any of these rows.

**Direction B.** Reverse import search was run for all four changed production
modules. Importers: `table-disposition.ts` ← `purge-verification.ts` +
`migration-098-suppression-corrections.integration.test.ts`;
`purge-verification.ts` ← `purge-stages.ts`, `offboarding-lifecycle…`;
`purge-stages.ts` ← `PurgeWorker.ts`, `offboarding-lifecycle…`,
`batch-purge-concurrency…`; `tenant-tables.ts` ← `rls-audit.ts`,
`tenant-scope-audit.ts`, `rls-audit.test.ts`, `tenant-tables.integration.test.ts`,
`table-disposition.test.ts`, `migration-116…test.ts`. **Every behaviour-affecting
hunk in the diff already has a dedicated new covering case, and all four are
inventory rows**, so Direction B adds no rows; listing the incidental unchanged
importers that merely iterate `TENANT_TABLES` would pad the inventory without
adding coverage. Crucially for RT-17, the same search establishes the
**negative**: only four test files in the repository name `refusal_events`, and
the only live-DB one calls `runContentPurgeStage` and never
`verifyAccountOffboardingPurge` — so no unchanged test kills either surviving
mutant.

---

## Authorizations

*Rendered from the `authorizations` array in `findings.json`; never parsed back
out of this Markdown. No authorization was added by this pass.*

### AUTH-1008-01 — 2026-08-29 — covers RT-05, RT-08

> Accept the risk, file a follow-up. Rationale: the gap predates this branch, the
> failure path is only reachable in a window the ship order already closes
> (production DDL lands before the code), and a runbook rule is a distinct piece
> of ops work that deserves its own review rather than being appended to a schema
> PR. Follow-up filed as RepWorth/ai-review-responder#1016.

Both findings were re-derived independently in this pass, and the
authorization's scope still fits what the evidence shows.

---

## What blocks

- **RT-17 (P0, open)** blocks the PR outright. `status` is `OPEN_P0`.
- **RT-13 (P1, open)** is a high-risk open P1 and requires **user adjudication**
  — the checker enforces this, and no authorization was added for it.
- RT-12, RT-18, RT-19, RT-20 are P2 and never block; they are recorded for the
  owner's judgement.

Evidence excerpts throughout follow the repository's logging-redaction
discipline: no raw review or response text, no tokens, no secrets, and no
environment values appear in this report.
