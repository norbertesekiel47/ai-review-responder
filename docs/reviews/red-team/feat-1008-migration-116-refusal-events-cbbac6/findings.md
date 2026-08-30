# Red team — `feat/1008-migration-116-refusal-events`, round 1

| | |
|---|---|
| **Mode** | `feature` |
| **Risk** | `high` (from `.feature/intake.json`) |
| **Round** | 1 of a hard cap of 2 |
| **Fork** | `5ab6bfeeef9bce1d389cf9c75ec87eeeefad9d64` |
| **Merge base** | `5ab6bfeeef9bce1d389cf9c75ec87eeeefad9d64` (fork is an ancestor of HEAD; `git merge-base --is-ancestor` verified) |
| **HEAD** | `25a6430311a59120e01e85cbd8753c2eda1e8028` |
| **Intake SHA-256** | `11f75d1208a0d9ad28ab53bf59bb083ce1c5767a44f749c4d966406dba1548f5` |
| **Status** | `OPEN_P0` |
| **Test database** | `postgresql://localhost:5499/test_ws4`, PostgreSQL 16.14 — migration 116 applied |

**Everything below is evidence produced in this pass.** Every SHA, line number
and probe result was re-derived at HEAD; nothing was carried from the
implementer's claims. Where a citation names a file that this run had mutated,
the line was re-read from `git show <HEAD>:<path>` rather than from the working
tree — one of the docs findings changed by one line as a result.

---

## Severity table

| ID | Sev | Duty | Finding | At | Disposition |
|---|---|---|---|---|---|
| RT-01 | **P0** | 3 | ADR 0023's withheld writer/anchor table is false for 2 of 8 reasons; "the partition is exactly `RenderWithholdReason`" is false | `docs/adr/0023-refusal-log-owner-safe-projection.md:166` | open |
| RT-02 | **P1** | 2 | `expect(entry?.reason).toMatch(/cascade/i)` passes on the exact negation — the same defect class this PR already fixed once, in a sibling file | `src/lib/account-offboarding/__tests__/table-disposition.test.ts:183` | open |
| RT-03 | **P1** | 2 | C5's outer `IS TRUE` wrapper is asserted by nothing — behaviourally unreachable and structurally unread | `src/lib/shared/__tests__/migration-116-refusal-events.integration.test.ts:894` | open |
| RT-04 | **P1** | 3 | Three plan citations true at the merge base, stale at HEAD, staled by this change's own edits | `docs/superpowers/plans/…-deviations.md:234` | open |
| RT-05 | **P1** | 5 | The terminal purge failure this diff newly reaches emits a Sentry signal no runbook rule routes — all six facets MISSING | `docs/runbooks/beta-launch-alerting.md:184` | open |
| RT-06 | P2 | 3 | "nine probe rows" — the table lists eight | `docs/superpowers/plans/…-deviations.md:125` | open |
| RT-07 | P2 | 3 | `CONTEXT.md` asserts two `/dashboard/analytics` tabs in the present tense; neither exists | `CONTEXT.md:165` | open |
| RT-08 | P2 | 5 | Retry and terminal share one fingerprint, so a first-seen rule for RT-05 is dead on arrival | `worker/jobs/account-offboarding/PurgeWorker.ts:114` | open |
| RT-09 | P2 | 2 | In-test comment misattributes the `['different', NULL]` rejection to the outer `IS TRUE` | `…migration-116-refusal-events.integration.test.ts:913` | open |
| RT-10 | P2 | 3 | ADR maps `admin_halt` on a lane whose rows cannot carry it | `docs/adr/0023-…md:89` | open |
| RT-11 | P2 | 2 | Two C5 clauses are provably redundant, so no row can pin them | `supabase/migrations/116_refusal_events.sql:160` | open |
| RT-12 | P2 | 3 | Three minor doc inaccuracies (typo, mis-attributed runbook section, issue-number attribution) | `.claude/reference/migrations-log.md:2602` | open |

Counts: inventory 22 (4 killed, 18 excluded, 0 inconclusive, 0 skipped-budget);
findings 12 (1 P0, 4 P1, 7 P2), all `open`, none accepted-risk.

---

## Precondition deviations

**Precondition 2 (`watchers`) FAILED and was overridden on evidence.**
`mutation-runner.mjs watchers` aborts, naming four Node processes:

```
68547 pnpm dev --port 3000
69387 next dev --port 3000
69738 next-server (v16.3.0)
76253 next-server (v16.3.0)
```

Each process's working directory was resolved independently in this pass with
`lsof -a -p <pid> -d cwd -Fn`:

| PID | cwd |
|---|---|
| 68547 | `/Users/norbertesekiel/Developer/startups/RepWorth` |
| 69387 | `/Users/norbertesekiel/Developer/startups/RepWorth` |
| 69738 | `/Users/norbertesekiel/Developer/startups/RepWorth` |
| 76253 | `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/refactor-globals-css-extraction` |

None is in this worktree
(`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events`),
so no process can hot-reload a mutation here under an unscrubbed environment.
The `watchers` check is process-name-based and cannot see the cwd; the override
rests on the `lsof` table above.

Preconditions 1 (clean tree at a committed SHA) and 3 (journal closed, round 1
open, 30 runs available) held.

**Per-file mutation budget was structurally capped at one, not by the run
budget.** `restoreMutations` in `mutation-runner.mjs` iterates journal entries
forward and, for each, restores only when the working blob equals that entry's
`originalOid` or `mutantOid`. A second entry on the same path therefore makes
`finalize` either abort ("holds neither") or silently restore the file to the
*first* mutant. Both were traced through the code before any second mutation was
attempted. Since the finalizer is the invoking agent's to run, this pass used
exactly one journal entry per production path — 4 mutations, not the 8 the
"2 per test" allowance would permit — and compensated for the migration (which
is out of mutation scope anyway) with the SQL clause-probe matrix below, which
is a stronger instrument than mutation for a `CHECK` constraint.

**Mutations are STILL APPLIED at the time this report was written.** Per the
invoking agent's explicit instruction not to run `finalize`. Four files hold
their journaled mutant and every one was verified restorable:

| Path | original | mutant | working | verdict |
|---|---|---|---|---|
| `scripts/ci/tenant-tables.ts` | `4fbdb3237593` | `bfe7cf969165` | `bfe7cf969165` | restorable |
| `src/lib/account-offboarding/table-disposition.ts` | `060c260bd434` | `80e2b5f396f2` | `80e2b5f396f2` | restorable |
| `src/lib/account-offboarding/purge-verification.ts` | `fcdf7603a694` | `369be0d63cbc` | `369be0d63cbc` | restorable |
| `worker/jobs/account-offboarding/purge-stages.ts` | `c3a230ef3285` | `5a57be29b391` | `5a57be29b391` | restorable |

The dotenv swap is also still open (`.env.local` → `.env.local.red-team-backup`).
`node .agents/skills/red-team/scripts/mutation-runner.mjs finalize` **must run
before** `red-team-status.mjs`, which fails while any dotenv backup or open
journal entry exists.

---

## Environment

```
node .agents/skills/red-team/scripts/mutation-runner.mjs env \
  --tmp-home <mktemp -d> --test-db postgresql://…@localhost:5499/test_ws4
node .agents/skills/red-team/scripts/mutation-runner.mjs dotenv-swap --test-db <same>
```

Allowlist only: `PATH`, temporary `HOME`, `TMPDIR`, `NODE_ENV=test`, `CI=true`,
`MOCK_EXTERNAL_APIS=true`, `TEST_DATABASE_POOL_URL` + `DATABASE_POOL_URL` (both
validated `localhost`). The database URL was read from `.env.local` into a shell
variable and passed as a variable, never as a literal argument.

`--test-db` was passed only for the one live-DB suite (INV-22). The three
non-DB suites ran without it, so `REPWORTH_DISABLE_LIVE_DB_SUITES=1` was set for
them — identically for baseline and mutant in every pair, which is the property
the skill requires. Eight of thirty budgeted runs were used.

---

## Duty 1 — hand-mutation

Every baseline was green and every mutant run reported exactly one executed test
(`assert-one-test`). **All four mutations were killed; there are no survivors and
no P0-candidates from this duty.**

### INV-02 — `scripts/ci/tenant-tables.ts`

- Baseline: `migration 116 refusal_events (no database required) › TENANT_TABLES scopes refusal_events by account_id and business_id` — 1 passed.
- Mutation: delete `'refusal_events',` from `TENANT_TABLES` (`4fbdb3237593 → bfe7cf969165`).
- Result: **killed** (0 passed, 1 failed).

The second axis — `TENANT_SCOPE_COLUMNS.refusal_events` → `['account_id']` — was
not executed (one journal entry per path, above). It is pinned by a direct
`toEqual(['account_id', 'business_id'])` on the literal value at
`…migration-116-refusal-events.integration.test.ts:499`, which cannot pass on a
different value; no mutation could add information.

### INV-20 — `src/lib/account-offboarding/table-disposition.ts`

- Baseline: `account offboarding table disposition inventory › classifies refusal_events as hard_delete by direct_account_id, verified must_be_absent` — 1 passed.
- Mutation: `scopeEvidence: 'direct_account_id'` → `'via_business'` — the exact defect
  the row's own `reason` warns about (`business_id IS NULL` on the account-wide
  lane would leave every suspension Refusal behind).
- Result: **killed**.

### INV-21 — `src/lib/account-offboarding/purge-verification.ts`

- Baseline: `purge verification › purge verification counts refusal_events rows for the target account, including account-wide rows, and ignores another account` — 1 passed.
- Mutation: re-scope the count through `businesses` —
  `WHERE business_id IN (SELECT id FROM businesses WHERE account_id = $1)`.
- Result: **killed**, by
  `expected '\n SELECT COUNT(*) AS violatio…' not to contain 'business_id'`
  at `purge-verification.test.ts:249`.

Worth recording because it cuts against a default suspicion: the
`not.toContain('business_id')` assertion is an *absence* assertion, and absence
assertions are the shape Duty 2 exists to distrust. Here it is the assertion
that caught the real defect, and it sits beside a positive
`toContain('WHERE account_id = ?::uuid')` plus an exact `values` equality. Not a
finding.

### INV-22 — `worker/jobs/account-offboarding/purge-stages.ts` (live DB)

- Baseline: `owner offboarding — DB-backed lifecycle (integration) › the content purge stage deletes refusal_events rows for the purged account, account-wide rows included, and leaves another account's rows untouched` — 1 passed.
- Mutation: re-scope the `DELETE` through `businesses`.
- Result: **killed** — `AssertionError: expected 1 to be +0` at
  `offboarding-lifecycle.integration.test.ts:1397`. Exactly one row survived: the
  account-wide `autonomy_suspended` row. The test's two-tenants/two-rows fixture
  design is doing precisely the work it was built for.

---

## Duty 2 — fragile assertions, and the constraint-clause hunt

### Method

`supabase/migrations/116_refusal_events.sql` cannot be mutated (the database is
provisioned before the run). It was audited instead by building, in the live
test database, `TEMP` tables carrying the full shipped constraint set with **one
clause deleted at a time**, then replaying every row the suite exercises through
each variant and diffing the accept/reject verdict against the unmutated
baseline. 15 variants x 32 rows = 480 probes. A `plpgsql` helper captured
`GET STACKED DIAGNOSTICS CONSTRAINT_NAME`, so the comparison is by *which
constraint rejected*, not merely that something threw — matching what
`expectRejectedBy` asserts.

Variants that change the verdict on **zero** rows are the coverage gaps.

### Result: the five whole-constraint variants are all pinned

| Variant | Rows whose verdict changes | Which |
|---|---|---|
| `c1_gone` | 7 | all of title 9's mismatches flip to ACCEPTED |
| `c2_gone` | 2 | both of title 10's rows |
| `c3_gone` | 2 | both of title 11's rows |
| `c4_gone` | 2 | both of title 12's rows |
| `c5_gone` | 6 | all of title 13's rows |

### Result: five of C5's eight clauses are pinned, each by exactly one row

| Clause | Pinned by |
|---|---|
| `refusal_source = 'policy_gate_held'` (arm 1 guard) | the `ask_withheld` + array row |
| `array_position(all_refusal_codes, NULL) IS NULL` | `['winner', NULL]` — the row added after round 1 |
| `refusal_code = ANY(all_refusal_codes)` | `['different']` with code `winner` |
| `refusal_source <> 'policy_gate_held'` (arm 2 guard) | `policy_gate_held` with `all_refusal_codes` NULL |
| `all_refusal_codes IS NULL` (arm 2) | the `ask_withheld` + array row |

Round 1's first fix is confirmed sound: without the `['winner', NULL]` case,
`c5_no_d` changes no verdict at all. The suite's own comment at `…:924-930`
states this and it is true.

### RT-03 (P1) — C5's outer `IS TRUE` is pinned by nothing

`c5_nowrap` — the shipped C5 with the trailing `IS TRUE` removed — changes the
verdict on **zero** of the 32 probe rows.

Exhaustive brute force over `refusal_source` (7) x `refusal_code`
(`NULL`, `'a'`, `'b'`) x `all_refusal_codes` (`NULL`, `{}`, `{a}`, `{b}`,
`{a,NULL}`, `{NULL}`, `{b,NULL}`, `{a,b}`) — 168 combinations, a space closed
under the only operations C5 performs (membership, NULL-ness, cardinality) —
finds exactly **3** rows where the wrapper matters, and all three require
`refusal_source = 'policy_gate_held'` **with `refusal_code IS NULL`**, which C4
makes unrepresentable. Restricted to C4-satisfying rows: **0** differing rows.

So no INSERT can ever pin it. That leaves the structural route — and the suite
does not take it:

- `constraintDefinition()` is called at `:773` (C1) and `:1024/:1027/:1030`
  (the three enum CHECKs). **C5's definition is never read.**
- `assertSchemaReady` checks constraint **names** only
  (`helpers/schema-ready.ts:127` matches on `conname`).
- Title 8 pins C1's *identical* wrapper structurally at `:812`
  (`expect(definition).toMatch(/END\)?\s*IS TRUE/)`) and explains at `:775-778`
  precisely why a wrapper on an unreachable branch must be asserted on the
  definition or not at all. The same reasoning applies verbatim to C5 and was
  not applied.
- The precedent this PR names in its own `existing_patterns_to_follow` does it:
  `src/lib/shared/__tests__/migration-114-solicitation-attribution.integration.test.ts:420`
  — `expect(checkDef).toContain('IS TRUE')`, under the comment "A CHECK is
  SATISFIED by NULL, so without the `IS TRUE` wrapper a row…".

The migration's own header calls the wrapper load-bearing twice
(`116_refusal_events.sql:153`, `:166`). Delete it today and every one of the 19
cases stays green. Its whole purpose is to survive a *future* edit — a relaxed
C4, an eighth lane, #1009's insert helper — which is exactly the class
behavioural tests cannot cover.

**Behavioural replacement:** one line, in title 8 or title 13 —

```ts
expect(await constraintDefinition(C5_ALL_CODES_PAIRING)).toMatch(/\)\s*IS TRUE$/);
```

### RT-02 (P1) — `toMatch(/cascade/i)` cannot fail on the opposite claim

`src/lib/account-offboarding/__tests__/table-disposition.test.ts:183`:

```ts
expect(entry?.reason).toMatch(/cascade/i);
```

guarded by the comment "The reason must state the accurate fact rather than
gesture at one: … neither cascading, so nothing removes these rows unless the
purge deletes them explicitly."

Probe run in this pass:

| String | `/cascade/i` | `/no cascade reaches it/i` |
|---|---|---|
| the shipped reason ("NO CASCADE REACHES IT: …") | passes | passes |
| the exact negation ("… is removed by the accounts FK cascade during content purge, so `runContentPurgeStage` needs no explicit DELETE.") | **passes** | fails |

This is the same defect the branch already fixed once. Round 1 replaced
`expect(createdAt).toMatch(/retention/i)` with polarised phrases at
`…migration-116-refusal-events.integration.test.ts:764-769`, and the suite wrote
the rule down at `:758-762` ("Each assertion must be able to FAIL on the
opposite claim"). The rule was applied in one file of this change and not in the
other. **Replacement:** a polarised phrase such as `/no cascade reaches it/i`,
proved above to fail on the negation.

### RT-09 (P2) — an in-test comment misattributes a rejection

`…:913-914` says of the `['different', NULL]` row that
"`array_position(all_refusal_codes, NULL) IS NULL` **plus the outer `IS TRUE`
wrapper** are what make this a rejection." With `array_position` present, arm 1
for that row evaluates to **FALSE**, not NULL, so the wrapper contributes
nothing: `c5_nowrap` leaves the row rejected. The wrapper would matter for that
row only in the counterfactual where `array_position` is *also* absent. The
assertion is correct; only the reader's guide to which clause it pins is not.

### RT-11 (P2) — two C5 clauses no row can pin

`all_refusal_codes IS NOT NULL` (`:160`) and `cardinality(all_refusal_codes) > 0`
(`:161`) are logically redundant given the rest of the expression:
`cardinality(NULL::text[])` is NULL, and `x = ANY('{}')` is FALSE. Brute force
over the full 168-combination space finds **0** rows where deleting either
changes the verdict — `c5_no_b` and `c5_no_c` are equivalent mutations, not
coverage gaps.

Recorded rather than raised, for one reason: the two suite cases whose titles
suggest they pin these clauses (`allRefusalCodes: null` and `allRefusalCodes: []`)
in fact reject through arm 2's lane guard and through `= ANY` respectively. A
future reader deleting a "redundant" clause would be right about the semantics
and would get no signal either way. If the team wants each clause pinned, only
the structural read in RT-03 can do it.

### Assertions checked and found sound

- **Index properties** — every one is pinned. `pg_indexes` set-equality at
  `:696-701` (exactly 4, PK included, so a fourth index fails); exact
  `USING btree (…)` substrings for keys, column order and `DESC`;
  `not.toContain('CREATE UNIQUE INDEX')` on both non-unique indexes;
  `not.toContain('WHERE')` on both non-partial indexes; and
  `toContain('WHERE (subject_id IS NOT NULL)')` on the partial unique index.
  The index-name list is an order assertion, but the query supplies the
  ordering contract itself (`ORDER BY indexname`), so it is not the Duty-2 shape.
- **Column shape** — 12 columns with type / nullability / default flags, plus the
  `created_at` default pinned to its **expression** (`/^now\(\)$/i`), not merely
  to its presence. The comment at `:638-642` gives the reason and the assertion
  matches it.
- **Comment assertions** — the two timestamp comments use polarised phrases that
  fail on the negation; the other ten are asserted non-empty, which matches what
  the title claims and no more.
- `expect(rows.every(r => r.created_at instanceof Date)).toBe(true)` at `:1018`
  adds nothing the INSERT does not already prove (`created_at` is NOT NULL and
  omitted from the column list, so a missing default fails the insert). Weak,
  not fake. Not a finding.
- **No deleted or renamed test** anywhere in the diff
  (`git diff --diff-filter=DR --name-status` is empty), so no lost-coverage P1.
  The single deletion in the whole change is
  `.claude/reference/migrations-log.md`'s "Current head: **115**" line.

---

## Duty 3 — docs vs reality

`python3 ~/.claude/skills/grill-me-codex/scripts/prevalidate-plan.py` **exists**
and was run against all 13 changed markdown documents. Verdicts: `PASS` for
every file except `.claude/reference/arch-review-log.md`, whose 2 issues
(`pricing/page.tsx:17`, commit `01a0399f`) are at lines 1404 and 1410 and are
**pre-existing** — the line this change adds is 1420 and contains neither.

**The script does not validate line content, only file existence.** Every `PASS`
above conceals RT-04. Hand re-resolution found four stale citations the script
reported clean.

### RT-01 (P0) — ADR 0023's withheld writer/anchor table is false

`docs/adr/0023-refusal-log-owner-safe-projection.md:164-169` (a **new file in
this diff**) states:

| Reason | Writer | Anchor |
|---|---|---|
| `moderation_high`, `render_failed`, `lint_failed` | `ask-generation.ts` inserts the row already withheld | `rendered_at` — `NOT NULL`, never updated |
| the other five | `dispatch.ts` `commitWithhold`, which sets `agent_run_id` atomically | `COALESCE(agent_runs.started_at, updated_at)` |

> The partition is exactly `RenderWithholdReason`, so the split is the shape of
> the data rather than a special case.

Re-resolved against HEAD in this pass:

- `src/lib/solicitation/outreach.ts:525` —
  `RenderWithholdReason = 'moderation_high' | 'render_failed' | 'lint_failed'` (3).
- `src/lib/solicitation/dispatch.ts:149-155` — `OutreachWithheldReason` has
  **six** members and **includes `lint_failed` and `moderation_high`**.
- `src/lib/solicitation/dispatch.ts:254-255` —
  `if (!slow.lintPassed) return withhold('lint', 'lint_failed');`
  `if (!slow.moderationClean) return withhold('moderation', 'moderation_high');`
- Both verdicts reach `commitWithhold` (`dispatch.ts:1365`, called at `:1660`),
  which writes `disposition_reason = ${input.reason}` and sets `agent_run_id`
  (`:1374-1376`).
- `supabase/migrations/111_platform_halt_reason.sql:92-96` — the withheld arm has
  **eight** members, not "three + five". Dispatch owns exactly **four**
  exclusively (`suppressed`, `no_consent`, `no_postal_address`,
  `postal_address_mismatch`); the eighth, `unsubscribed`, is written by neither
  of the two writers the table names — `dispatch.ts:144-146` says so in as many
  words ("`render_failed` and `unsubscribed` are written by other lanes").

So the two writers' reason sets **intersect**; there is no partition, and the
sentence asserting one is false. The `moderationClean` arm is not hypothetical:
`dispatch.ts:160-161` records that it is `false` whenever
`OPENAI_MODERATION_ENABLED` is off ("this lane inverts the reply lane's
fail-open").

**Why P0 rather than P1.** This table is not commentary. The ADR's own
"Correction 3" (`:173-177`) makes it the operative rule — "each of the two
writers stamps the anchor that is correct for it" — for choosing
`refusal_events.occurred_at` on the `outreach_withheld` lane in #1012. Followed
literally, a dispatch-time `moderation_high` or `lint_failed` refusal is stamped
with `rendered_at`: the *render* time, arbitrarily earlier than the decision.
That is verbatim the defect `116_refusal_events.sql:39-46` forbids ("a write
timestamp wearing a decision timestamp's name"), and `occurred_at` is the single
retention clock, so a wrong anchor also mis-ages the row. `disposition_reason`
alone cannot select the anchor; the real discriminator is writer-side state —
`agent_run_id`, which only `commitWithhold` sets.

### RT-04 (P1) — three citations staled by this change's own edits

All re-derived from `git show <sha>:<path>`, because two of these files were
mutated in this run.

| Doc | Claim | At merge base | At HEAD |
|---|---|---|---|
| `…-intake.json:46` | "`scripts/ci/tenant-tables.ts:154` — `solicitation_batches`' two-column entry shape" | **true** — `:154` was `solicitation_batches: ['account_id', 'business_id'],` | `:154` is `zernio_connections: ['business_id'],`; `solicitation_batches` is at **160** |
| `…-intake.json` (`existing_patterns_to_follow`) | "`src/lib/account-offboarding/table-disposition.ts:361-366` — `solicitation_batches`' row shape" | true | `:361-366` is `solicitation_visits`' row; `solicitation_batches` starts at **368** |
| `…-deviations.md:234` (D8) | "`solicitation_batches` is at **line 154**; line 158 is `solicitation_suppressions`" | true | `:154` = `zernio_connections`; `:158` = `solicitation_contacts`. True lines: **160** and **164** |

The same stale `tenant-tables.ts:154` / `:158` figures are mirrored in
`docs/reviews/feat-1008-migration-116-refusal-events/{plan-review-r1,plan-review-r2,spec-correctness}.md`.

The substance is right in every case — only the numbers drifted, which is why
this is P1 and not P0. The cause is this change's own `@@ -98,6 +98,12 @@` hunk
in `tenant-tables.ts` shifting everything below it. The irony is worth stating:
**D8 exists because `:158` had gone stale, and the fix to `:154` was invalidated
by the same commit that recorded it.**

`…-intake.json`'s third citation, `purge-verification.ts:620-633`, still resolves
correctly at HEAD (`:620` is `case 'solicitation_batches':`); only the tail of
that range now covers the new `refusal_events` block.

### RT-06, RT-07, RT-10, RT-12 (P2)

- **RT-06** — `…-deviations.md:125` says "then **nine** probe rows", and
  `.claude/reference/arch-review-log.md:1420` repeats "all nine now correct". The
  table immediately below lists **eight** (5 rejections + 3 acceptances, which is
  also what the following sentence's "All five rejections" implies). The C5
  correction itself is real; I reproduced it independently against PostgreSQL
  16.14 in this pass. Only the count is wrong.
- **RT-07** — `CONTEXT.md:165` describes the **Restraint tab** as "the second of
  the two tabs on `/dashboard/analytics` — `Metrics` and `Restraint`", present
  tense. `src/app/(authenticated)/dashboard/analytics/page.tsx` is 7 lines
  rendering `<AnalyticsContent />`; there is no tab UI and no `Metrics` label in
  `src/components/dashboard/analytics/`. `CONTEXT.md` legitimately locks terms
  ahead of code and the intake lists the tab as a #1014 non-goal, which is why
  this is P2 — but a reader is told a `Metrics` tab exists today. "will be the
  second of two tabs" fixes it.
- **RT-10** — `docs/adr/0023-…md:89` says the `latchHalt` copies map
  "on `outreach_withheld` … to `null`". Those copies land on rows with
  `delivery_status = 'cancelled'` (`src/lib/solicitation/approval.ts:544`), and
  `111_platform_halt_reason.sql:92-101` permits `admin_halt` only under
  `cancelled`, never `withheld`. The resulting mapping is right either way; the
  lane label is loose.
- **RT-12** — (a) `.claude/reference/migrations-log.md:2602` has "108'**S**";
  (b) `arch-review-log.md:1420` attributes a rule to `deployment-guide.md` §II.5,
  which is titled "Ongoing workflow (the Option-1 loop)" and requires
  staging-Supabase-first for migrations but never states the attributed rule — a
  reasonable inference, not a quotation;
  (c) `…-intake.json` `non_goals[1]` attributes "**eleven** Refusal write sites"
  to "#1010, #1011, #1012, #1013", while `116_refusal_events.sql:13-14` and
  `migrations-log.md:2500-2501` put the *first* caller in **#1009** and the
  other ten in #1010-#1013. The arithmetic is consistent; the issue attribution
  is not.

### Checked and sound — recorded so the zero-finding areas are not mistaken for skipped

Every one of the following was opened and confirmed against HEAD, most against
the live database as well:

- **The migration against the database.** All 12 columns (name/type/nullability/
  default), all five named CHECK expressions, all three enum CHECKs, all three
  index definitions, both FK referential actions (`confdeltype = 'a'`),
  `relrowsecurity = true`, `relforcerowsecurity = false`, zero rows in
  `pg_policies`, `COMMENT ON TABLE` plus all twelve column comments.
- **Every count claim**: twelve columns, five CHECKs, three enum CHECKs, three
  indexes, seven lanes, eight categories, four subject types, and the 22
  `AutoApprovalBlockReason` values at
  `worker/jobs/response-generation/auto-approval.ts:37-58`. All correct.
- **The C5 defect narrative** in D4 — independently reproduced: the locked
  expression evaluates to `NULL` on `('winner', ARRAY['different', NULL])`, the
  corrected one rejects it, `array_position(ARRAY['winner',NULL], NULL) = 2`.
  Real, not reconstructed.
- **The forced-consequence chain**: `accountLinkedTablesFromMigrations()` (which
  does parse `CREATE` statements, not net schema — so the rollback reasoning
  about a hypothetical 117 `DROP` holds) → `TABLE_DISPOSITIONS` →
  `verificationQuery` arm → `runContentPurgeStage` DELETE → both `TENANT_TABLES`
  structures → `rls-inventory.md`. Every link confirmed, and no cascade reaches
  the table.
- **Every precedent citation**: 096 G4 (account-leading index), 105, 108, 110,
  111 (the `IS TRUE` idiom), 112 (plain `CREATE INDEX` on a zero-row table), 114
  (one transaction + `SET LOCAL lock_timeout '10s'`), ArchivalPoller arms 9/10.
- **`migrations-log.md` head bump and the LOCAL-ONLY convention** — 116 is
  genuinely head; the marker matches
  `.claude/hooks/migration-immutability-guard.sh:45,63`; no pre-existing true
  statement in that file is made false by the edit.
- **`docs/directory.md` correctly needs no row** —
  `scripts/ci/directory-map-audit.ts:13,71` excludes `__tests__/` and `*.test.*`,
  and the only other new file is under `supabase/migrations/`, outside the
  covered roots. `pnpm ci:directory-map` passes (582 files).
- **`CONTEXT.md` names no non-existent TypeScript owner.** `src/lib/refusals/vocabulary.ts`
  is a declared non-goal and is never cited as if it exists; the entry says only
  "the code→category MAP lives in TypeScript", with no path.
- **The 116 suite's absence from `MIGRATION_SHAPE_FILES` is correct, not a gap.**
  `scripts/ci/live-db-suites-audit.ts:475` reads
  `if (!MIGRATION_SHAPE_FILES.has(file) && !DDL_PROBE_FILES.has(file))` —
  membership is an **escape**, never a requirement.
- **All 22 promised test titles are present verbatim**, and every remaining
  `path:line` citation across the 13 changed documents resolves to the content
  claimed.

---

## Duty 4 — missed sibling cases

Patterns, scope and exclusions, exactly as searched.

**S1 — unpolarised prose/comment regex assertions, scope: the four changed test
files.** `grep -n "toMatch(/"`. Eleven hits. Ten are either polarised prose
(`:764-769`), structural patterns (`/^now\(\)$/i`, `/END\)?\s*IS TRUE/`,
`/^[a-f0-9]{64}$/`, `/WHERE\s+account_id\s*=/i`) or absence assertions on
migration SQL (`/\bROLLBACK\b/`, `/\bCONCURRENTLY\b/`). One is not:
`table-disposition.test.ts:183` → **RT-02**.

**S2 — the same shape repo-wide.**
`rg "\.reason\)\.toMatch|\.reason\)\.toContain|reason\?\.\w*\)\.toMatch"` over
`src`, `worker`, `scripts`, excluding `node_modules`. 24 hits.
`table-disposition.test.ts:183` is the **only** `.reason).toMatch(…)` prose
assertion in the repository, and it is inside this diff. *Exclusion recorded:*
the other 23 are `.reason).toContain(<discriminant token>)` on runtime failure
reasons (`csv-import`, `generate-draft`, `tenant-scope-audit`, the CSV-import
route) — those assert that an error string carries a discriminant, which is a
different boundary from asserting the polarity of a prose rationale.

**S3 — suites asserting column or table COMMENT text.**
`rg -l "col_description|obj_description"` over `src`, `worker`, `scripts`.
**Exactly one file**: the new 116 suite. The `/retention/i` fix therefore has no
siblings elsewhere. **Sound zero result.**

**S4/S5 — migrations carrying an `IS TRUE`-wrapped CHECK, and whether their
suites pin the wrapper structurally.** `rg -l "IS TRUE" supabase/migrations/`
→ 091, 092, 108, 109, 110, 111, 114, 116. 111 has no shape suite at all. 114's
suite **does** pin it
(`migration-114-solicitation-attribution.integration.test.ts:420`). 116 pins C1's
and not C5's → **RT-03**, and the asymmetry is against the branch's own declared
pattern, not an outside standard.

**S6 — registries a new deny-all tenant table must join.** Scope: every non-test,
non-migration site naming `judge_verdicts` (migration 076, the previous deny-all
tenant table), then checked for a matching `refusal_events` arm.

| Registry | `refusal_events` arm | Verdict |
|---|---|---|
| `scripts/ci/tenant-tables.ts` (both structures) | present | ok |
| `src/lib/account-offboarding/table-disposition.ts` | present | ok |
| `src/lib/account-offboarding/purge-verification.ts` | present | ok |
| `worker/jobs/account-offboarding/purge-stages.ts` | present (and required — no cascade reaches it, unlike `judge_verdicts`) | ok |
| `docs/security/rls-inventory.md` | present | ok |
| `.claude/reference/migrations-log.md` | present | ok |
| `scripts/ci/tenant-scope-allowlist.ts` | absent | correct — `judge_verdicts` appears there only because it has query sites; `refusal_events` has none, and the retention-sweep exemption is a declared #1009 non-goal |

**Sound zero result: no missed registry arm.**

---

## Duty 5 — operational completeness

Scope: the one operator-actionable terminal failure path this diff adds —
`runContentPurgeStage`'s `DELETE FROM refusal_events` raising `42P01` against a
database without migration 116. Static comparison only.

**Emitted signal** (`worker/jobs/account-offboarding/PurgeWorker.ts:109-127`):
`Sentry.captureMessage('account_offboarding_purge_failed')`, tags
`subsystem=account_offboarding`, `step=purge`, `terminal="true"|"false"`, level
`warning` on retries and `error` on the terminal attempt. No `fingerprint` is
set anywhere; `worker/sentry.ts` sets none either.

**Runbook rule row: none.** The only alert-rule table is
`docs/runbooks/beta-launch-alerting.md:177-184`, six rows, filtering on
`subsystem=health_alert`, `cost_event`, `feature=stripe_reconciliation`,
`subsystem=import_consent_analytics`, `finding=solicitation_send_breaker_tripped`
and `feature=solicitation_lane`. None keys on `subsystem=account_offboarding`,
`step=purge`, or `terminal`. The whole 430-line file mentions "purge" once, in
passing, as a benign cause of an unrelated finding.

Neither generic sink catches it either:

- `worker/job-failure-sink.ts:41-45` returns early unless
  `attemptsMade >= opts.attempts`; on the terminal attempt `PurgeWorker` swallows
  the error and returns (`:106`), so BullMQ marks the job **completed** and the
  `'failed'` event never fires.
- `worker/background/pollers/health-alert/checks.ts:81-104` —
  `checkFailedOutboxByTopic` is a **closed allowlist** of six topics;
  `ACCOUNT_OFFBOARDING_PURGE` is not one, so the `job_outbox` row
  `markOutboxFailed` sets to `failed` produces no `outbox_failed:*` finding and
  never reaches rule 1. That file's own comment names this exact failure class.

### Six-facet comparison

| Facet | Runbook says | Code emits | Verdict |
|---|---|---|---|
| Signal identity | — | `captureMessage('account_offboarding_purge_failed')` | **MISSING** |
| Filter | — | `subsystem=account_offboarding`, `step=purge`, `terminal` | **MISSING** |
| Level | — | `warning` retries / `error` terminal | **MISSING** |
| Grouping title | — | one issue, `account_offboarding_purge_failed`, no fingerprint | **MISSING** |
| Threshold / cadence | — | n/a; see RT-08 | **MISSING** |
| Destination action | — | none; a half-purged account needs a manual re-drive nothing documents | **MISSING** |

### RT-05 (P1) and RT-08 (P2)

**RT-05.** The state left behind is not benign: stages 1-3
(`PurgeWorker.ts:77-79`) each commit their own transaction *before*
`runContentPurgeStage` (`:80`), so a `42P01` leaves the Supabase auth user
deleted and audit/cost/payload columns scrubbed while reviews, responses, the
consent ledger and `refusal_events` all survive — a half-purged account against a
deletion promise. And nothing reclaims it:
`AccountOffboardingPurgePoller.ts:89,99` requires
`status='purge_scheduled' AND purge_started_at IS NULL`;
`AccountOffboardingTeardownRetryPoller.ts:91-92` claims only
`failed_step='teardown'`; `retry-billing.ts:58,79` only `failed_step='billing'`.
*Remedy:* a rule row at `beta-launch-alerting.md:184` filtering
`subsystem equals account_offboarding`, frequency-based (see RT-08), levels
`error` + `warning`, plus a §4 acceptance drill and a named re-drive procedure.

**Scope caveat, stated plainly:** `alertPurgeFailure` and this routing gap are
**pre-existing** and apply to every purge failure mode; this diff adds a new way
to reach them, not the gap itself. Two things blunt it further — the branch's own
deploy plan (deviations D6/D10) sequences migration-before-code in every
environment so the `42P01` window is zero, and `/admin/offboardings` flags the
row as `is_stuck` (`src/lib/admin/offboardings-service.ts:133-136`), which is a
dashboard someone must open rather than a page. It is reported P1 because it
meets the skill's criterion verbatim ("an emitted signal with no rule row"); the
arbiter may reasonably reject it as pre-existing, under the rejection protocol.

**RT-08.** Both branches call the same constant `captureMessage` with no
fingerprint, and level is not part of Sentry's default fingerprint — so retries
and the terminal error group into **one** issue whose first-seen event is a
`warning`. A first-seen rule copied from rows 1-3 fires once ever, on a retry;
an `error`-level or `terminal:true` first-seen rule fires never. This is the
exact trap `beta-launch-alerting.md:189-196` documents three times for rules
4/5/6. *Remedy:* make the RT-05 rule frequency-based, or give the terminal branch
its own message so it becomes its own issue.

### The intake's four operational claims — all TRUE

| Claim | Verdict | Evidence |
|---|---|---|
| "`PurgeWorker` calls `markPurgeTerminalFailure` plus `markOutboxFailed` on the terminal attempt" | TRUE | `PurgeWorker.ts:104-105`, guarded by `isTerminalAttempt(job)` at `:99` |
| "BullMQ retries are bounded" | TRUE — **3 attempts** | `worker/queues.ts:38-40` (`attempts: 3`), applied at `:76`; `OutboxPoller.ts:280-284` adds no override. With `isTerminalAttempt` (`src/lib/shared/outbox.ts:211-216`) the terminal branch fires at `attemptsMade === 2`: 2 warnings then 1 error |
| "promoting 116 afterwards does NOT reopen that offboarding" | TRUE | no poller or retry path claims `status='failed' AND failed_step='purge'`; a manual re-drive must reset both `status` and `purge_started_at`, and no code does |
| "level `warning` on each retry and `error` with `terminal=true` on the last" | TRUE | `PurgeWorker.ts:115,119` — message and all three tag keys match the intake verbatim |

---

## Inventory

22 candidates. Direction A is every added test case in the four changed test
files; Direction B is the four behaviour-affecting production files, each of
which reverse-import search maps onto one of those cases — so no production hunk
is uncovered and there is no `oracle`-class inconclusive row.

| # | Test | Outcome |
|---|---|---|
| INV-02 | `TENANT_TABLES scopes refusal_events by account_id and business_id` | **killed** |
| INV-20 | `classifies refusal_events as hard_delete by direct_account_id, verified must_be_absent` | **killed** |
| INV-21 | `purge verification counts refusal_events rows for the target account…` | **killed** |
| INV-22 | `the content purge stage deletes refusal_events rows for the purged account…` | **killed** |
| INV-01, 03-19 | the other 18 cases of the 116 suite | **excluded** — their covering production hunk is `supabase/migrations/116_refusal_events.sql`, which the skill places out of mutation scope (the database is provisioned before the run, so mutating the migration changes nothing under test). Audited instead by the clause-probe matrix above. |

The machine-readable rows, with per-row reasons, are in `findings.json`.

---

## Authorizations

None. No finding in this report is `accepted-risk`.

---

## What round 2 would verify

RT-02, RT-03 and RT-09 are one-line test/comment changes and are verifiable by
re-running the clause probe and the polarity probe recorded above. RT-01 is a
correction to ADR 0023's table and its "partition" sentence, and re-verification
means re-reading `dispatch.ts:149-155,254-255` and
`111_platform_halt_reason.sql:92-96` against whatever the corrected table
claims. RT-04, RT-06, RT-07, RT-10 and RT-12 are doc edits. RT-05 and RT-08 are
adjudication calls for the user, not fixes this lane can make unilaterally:
this is a high-risk run, so every open P1 needs user adjudication or an
authorization, and the checker enforces that.
