# Red team — `feat/1012-refusal-auto-post-revoked`, round 1

| | |
|---|---|
| Mode | `feature` (dispatched inside `/feature` step 7's review wave) |
| Run id | `feature-feat-1012-refusal-auto-post-revoked-b3e501` |
| Fork / merge-base | `06a163f0b4b102c88687c95862999e38a1c3f517` |
| Head | `7c9bd9cdf80004d8f610e3fd27cccf56cc7b6580` |
| Intake sha256 | `ddee04e0d647f248b7b2a578d8e31b237e9e130a3cf5f2c50bafd90a5e724293` |
| Risk | `high` (from the intake) |
| Status | **`OPEN_P0`** |
| Mutation tally | 24 planted · 23 killed · 1 survived (arbiter-reclassified equivalent; its row resolved by a second valid mutation) |
| Budget | 26 of 30 runs used this round (2 baselines, 24 mutant measurements) |

Everything below is evidence produced in this pass. Two duties found nothing and
are recorded as such rather than padded.

---

## Preconditions — one deviation, disproved rather than waived

1. **Clean worktree at a committed SHA.** `git status --porcelain --untracked-files=no`
   was empty at the start of the pass and after every mutation. The one untracked
   path, `docs/reviews/feat-1012-refusal-auto-post-revoked/blast-radius.md`, is a
   sibling review axis's staging file; it predates this pass and is invisible to
   the checker's porcelain read.

2. **`mutation-runner.mjs watchers` returned ABORT — and the abort is a false
   positive, disproved with evidence before proceeding.** The check greps
   machine-wide `ps` output and is documented in the runner itself as deliberately
   over-broad ("a false positive here refuses a run, which is the safe direction").
   The four matched processes were resolved individually:

   | pid | cwd | open handles under this worktree |
   |---|---|---|
   | 68547 (`pnpm dev`) | `…/startups/RepWorth` (parent repo) | 0 |
   | 69387 (`next dev`) | `…/startups/RepWorth` (parent repo) | 0 |
   | 69738 (`next-server`) | `…/startups/RepWorth` (parent repo) | 0 |
   | 76253 (`next-server`) | `…/RepWorth-worktrees/refactor-globals-css-extraction` | 0 |

   `lsof` shows zero file handles under
   `…/RepWorth-worktrees/feat-1012-refusal-auto-post-revoked` from any of them,
   and no `vitest`, `tsx watch`, `nodemon`, `fswatch` or Playwright process was
   running anywhere on the box. The parent repo path is a string prefix of the
   worktrees path, which is what the substring grep tripped on. The precondition
   as written — *no process is serving or watching **this** worktree* — is
   therefore true, and the pass proceeded. Recorded here because a deviation that
   is argued rather than announced is the thing this section exists to prevent.

3. **Journal.** `round-start` opened round 1 cleanly.

4. **Environment isolation.** `dotenv-swap --test-db <localhost:5499/test_1012>`
   was applied for the whole mutation phase; every baseline and every mutant ran
   under the identical allowlisted environment built by `mutation-runner.mjs run`
   (`--tmp-home`, `--test-db`), never an ad-hoc shell env. The database is
   `test_1012` on localhost, validated by the runner's own local-host guard;
   `refusal_events` and all three of its indexes, including
   `refusal_events_subject_uniq`, were confirmed present before any run.

**Restoration.** Every mutation was reverted immediately after its run with
`git checkout -- <named path>`, and the driver asserted
`git status --porcelain --untracked-files=no` empty on each one before moving on
(`restoredClean=yes`, 24/24). The tracked tree at the time of writing is
byte-identical to `7c9bd9cd`. The journal (25 entries, each of whose working blob
now equals the recorded original) and the dotenv swap remain **open by design** —
per this run's dispatch the ORCHESTRATOR runs `mutation-runner.mjs finalize`, and
`.env.local` is currently the scrubbed stub with the real file at
`.env.local.red-team-backup`. **The finalizer must run before the checker.**

---

## Baselines and contract re-derivation

Both suites were run at HEAD before any mutation, and both were green:

- `worker/jobs/publisher/__tests__/auto-policy-downgrade.test.ts` — **8/8 passed**
- `worker/jobs/publisher/__tests__/auto-policy-downgrade.integration.test.ts` — **14/14 passed** (live `test_1012`, `integration` project)

All **19** titles in `.feature/intake.json` `tests_to_add` are present verbatim
and active. `rg` for `it.skip` / `it.todo` / `it.fails` / `describe.skip` /
`.only` across both changed test files returns nothing. The claim that the
19 titles are present and active is **re-derived and TRUE**.

The gate's own claim ("29 rows, 0 FAIL, 0 WARN, review mode") was **not**
re-derived here — the final gate re-runs as the last serialized step outside this
pass.

---

## Duty 1 — hand-mutation

24 measurements from 14 distinct mutants. Baseline for each candidate was
established by the two full-suite green runs above; each mutant run then executed
**exactly one** test, verified by `assert-one-test` (24/24 reported exactly one
executed test).

### The seven claimed-inert titles — all seven kill their planted defect

The implementer's claim was that seven of the nineteen assert the *absence* of a
Refusal row and were green before and after the change. That claim is **TRUE**
(they are green at the merge base by construction), and the follow-on question —
whether they are therefore inert — is **answered NO for all seven**. For each,
the defect it exists to forbid was planted and the test died.

| # | Title (abbreviated) | Planted defect | Result |
|---|---|---|---|
| 1 | no-op on a response that is not downgradeable | Refusal hoisted above the `!isDowngradeable` guard | **killed** at `integration:460` (`readRefusalRows()` non-empty) |
| 2 | loses the outbox attempt CAS | same mutant | **killed** at `integration:479` |
| 3 | guarded response `UPDATE` matches no row | Refusal hoisted above `if (!downgraded)` **only**, ladder otherwise untouched | **killed** at `unit:288` (`refusalInserts()` length 1) |
| 4 | no review anchor | unlocked `businesses` read + Refusal hoisted above the `!reviewId` guard | **killed** at `integration:500` |
| 5 | missing business | Refusal hoisted above the `!lockedBusiness` guard (optional-chained account key) | **killed** at `unit:271` |
| 6 | `REFUSAL_LEDGER_ENABLED=false` | call site replaced with a raw `INSERT INTO refusal_events`, bypassing the helper's kill switch | **killed** at `integration:744` |
| 7 | each production gate routes its reason verbatim | `judge-gate.ts` collapses one `judge_unhealthy` site onto `judge_disabled` | **killed** at `unit:309` |

A first attempt at #3 used the coarser "hoisted above three guards" mutant; it
killed the test, but the failure landed on a shifted-ladder assertion rather than
the refusal count, so a **sharper** mutant that moves the write above the
`!downgraded` guard *and nothing else* was run in its place. Both are recorded;
the sharper one is what the row rests on.

### The orchestrator's other named targets

| Target | Mutation | Result |
|---|---|---|
| **The caller's transaction** (invariant #15) | the write moved onto its own `postgres()` connection and its own `begin` | **killed** — see RT-3 for how, and why the kill is not the mechanism the test's comment claims |
| **`occurred_at` = `approval_audit_log.created_at`** | `occurredAt: new Date()` instead of the `'transaction_time'` sentinel | **killed** — `'2026-08-31 06:19:21.431+00'` vs `'…21.426838+00'`, exactly the #520 microsecond loss the test is built to catch |
| **`refusal_code` verbatim** | `refusalCode: marker` (the audit marker `judge_disabled` and `judge_unhealthy` share) | **killed** twice — the two-codes test at `integration:432`, and the one-row test at `integration:333` |
| **the category axis** | `refusalCategory` pinned to one constant | **killed** at `unit:236` |
| **the account key** | widening kept, account resolved by a **second** `SELECT account_id FROM businesses` with a safe fallback — i.e. exactly the design the owner rejected | **killed** at the full-ladder equality `unit:171` (11 rungs vs 10). A first, unguarded variant of this mutant died on a `TypeError` from the exhausted mock queue and was superseded rather than counted |
| **first-write-wins** | `ON CONFLICT … DO UPDATE SET refusal_code, refusal_category` in `src/lib/refusals/write.ts` | **killed** at `integration:563` — the two-different-reasons case really does discriminate `DO NOTHING` from `DO UPDATE` |
| **the partial index is actually reached** | `ON CONFLICT` clause deleted entirely | **killed** with a genuine `duplicate key` error at `integration:528`. This settles the scaffolding question: `reArmForSecondDowngrade` does what it claims — the second downgrade reaches `refusal_events_subject_uniq` |
| **the outbox-attempt rollback** | the write deleted | **killed** at `integration:699` (`rejects` resolved instead). See RT-2 for the sharper probe that survived |
| the subject | `subjectId: randomUUID()` (a well-formed uuid that is not the response) | **killed** at `integration:373` |
| both arms | the write deleted | **killed** at `integration:596` |
| the two pre-existing unit cases the diff touched | write deleted / hoisted | **killed** at `unit:110` and `unit:90` |

### The one survivor

Wrapping `writeRefusalEvent` in a `try { … } catch {}` at the call site
**survived** the outbox-rollback test. Arbiter verdict: **equivalent mutation**,
reclassified from P0-candidate, and the row was then resolved by a second valid
mutation (the deletion). Reasoning, and it is measured rather than reasoned from
the docstring: postgres.js records an `uncaughtError` per query inside the
transaction scope and rethrows it after the callback returns, so a call-site
catch does not save the transaction — the run confirms this directly, because the
test's `rejects.toMatchObject({ code: '23514' })` still matched under the mutant.
Every database-observable consequence is identical. It is still worth recording
that no test pins the "never caught here" invariant; see RT-2 (P2).

---

## Duty 2 — fragile assertions

No P1. Four P2s, each with the behavioural form named.

- **RT-4** — `unit:198-201`: `refusal!.values[1]` / `values[2]`, and the
  ten-element positional `toEqual` at `unit:236`, index into the bound-parameter
  array of an INSERT whose column order lives in `src/lib/refusals/write.ts`, a
  file this diff does not own. A behaviour-preserving column reorder there turns
  these red. Behavioural replacement: none is available under a mocked `sql`, and
  the integration suite already reads the same fields **by name**, so this is
  acceptable duplication rather than a defect — recorded, not blocking.
- **RT-5** — `unit:251`: `expect(refusal!.text).toContain('NOW()')` is a
  substring proxy for "the transaction-time sentinel". It would pass on any
  statement that happened to contain `NOW()` anywhere. The behavioural form
  exists and is strong (the microsecond equality, mutation-killed above), so this
  is a cheap secondary.
- **RT-6** — `unit:300-320`: the gate test scrapes **two hard-coded file paths**
  with source regexes. A third gate file routing a normalised reason would be
  invisible to it while `expect([...new Set(...)]).toEqual(Object.keys(...))`
  still passed. Verified: at HEAD there are exactly two, so the assertion is
  complete today. Separately, two of the four `judge-gate.ts` sites it counts sit
  in `applyJudgeGate`, which has **no production importer** at HEAD (only
  `applyJudgeGateInTx` is imported, by `auto-policy-publish.ts:35`) — every reason
  still reaches the write site through a live path, so the substance holds.
- **RT-3** — `integration:602`: the comment claims a second-transaction write
  site "passes every count assertion… What it cannot do is die with the
  decision". Measured, that is not the mechanism: `refusal_events.business_id`
  carries an FK to `businesses`, and the caller already holds that row
  `FOR UPDATE`, so an independent transaction's insert needs `FOR KEY SHARE` on a
  row it can never get. The mutant did not produce a surviving row — it blocked
  and the test died on its 40 s timeout. The test **is** live and the invariant
  **is** protected; the recorded rationale overstates how.

No absence-of-tag proxy, no exact string count on rendered output, and the one
order assertion (the full ordered statement ladder) rests on a real ordering
contract — the reviews → businesses → responses lock ladder and the
CAS-before-mutation ordering — so it is justified, not fragile. Its only cost is
that the ladder is duplicated near-verbatim in two unit tests, which disagree
cosmetically on how they match the fourth rung (`'FOR UPDATE'` vs
`'FROM responses'`) while asserting the same statement.

---

## Duty 3 — docs vs reality

`prevalidate-plan.py` was available and was run against both changed plan docs:

```
docs/superpowers/plans/feat-1012-refusal-auto-post-revoked-plan.md
  CITATIONS: 1 checked, 0 unresolved · FIXTURES: 3 checked, 0 gitignored · PREVALIDATE: PASS
docs/superpowers/plans/feat-1012-refusal-auto-post-revoked-deviations.md
  CITATIONS: 0 checked · PREVALIDATE: PASS
```

Every substantive claim in the two changed reference docs was then re-resolved by
hand against HEAD. All of these are **TRUE**:

- `docs/directory.md:1548` — the `businesses` lock selects `id, account_id`; the
  Refusal is written after the guarded `UPDATE`, beside `insertAuditLogAutoPolicy`,
  on the same transaction; `refusal_code` is the reason verbatim; the subject is
  the response; the write is not caught. Verified line by line against
  `auto-policy-downgrade.ts:107-212`.
- `docs/directory.md:2011` — the new live-DB suite is named in the test-inventory
  row, and D5's claim that `ci:directory-map` is unaffected is true:
  `scripts/ci/directory-map-audit.ts:71` excludes `__tests__` and `*.test.*`.
- The production comment's load-bearing claim that `businesses.account_id` is
  `NOT NULL` with an FK to `accounts` — verified against the live schema
  (`is_nullable = NO`, `fk_businesses_account → accounts`).
- D2's correction — the ladder already held a second `businesses` read from
  `insertAuditLogAutoPolicy` — verified: it is rung 6 of the emitted ladder.
- D3's argument that the missing-business exit is unreachable against live
  Postgres — verified: `responses_business_id_fkey` exists and
  `anchorReviewLockOrder` reads by `(id, business_id)` first.

One claim is **FALSE**, and it is in two artifacts. See **RT-1** below.

---

## Duty 4 — missed sibling cases

**Searched, found nothing in scope.** Recorded in full so the search is
checkable.

- **Patterns searched:** `downgradeAutoApprovedResponseForManualReview(InTx)?\(`
  (whole repo); `AUTO_POLICY_REVOKED` (all five audit-action constants);
  `approval_method = NULL` (every site that revokes an approval on `responses`).
- **Scope:** `src/` and `worker/`, excluding `**/__tests__/**` and `docs/**`.
- **Result:** two other sites revoke an auto-policy approval on `responses` —
  `src/lib/approval/veto.ts:93-96` (the owner's veto-window veto) and
  `worker/jobs/publisher/auto-policy-publish.ts:935-938` (the supersede path) —
  and neither writes a Refusal.
- **Why neither is a missed sibling:** `src/lib/refusals/vocabulary.ts:341-354`
  scopes `auto_post_revoked` to "why the publisher took back an auto-approved
  reply", written by this function, with exactly the six `AutoPolicyDowngradeReason`
  members. Neither an owner veto nor a supersede is one of those six codes, and
  the locked vocabulary states the governing principle for the adjacent lane in
  the same file (`batch_halted` — "a batch WE halted, never one the owner
  halted"). An owner's act is not a Refusal. The remaining lanes are explicit
  intake non-goals owned by #1010/#1011/#1013.
- **Exclusions:** `supabase/migrations/` (provisioned before the run) and E2E
  specs (none touch this path).

---

## Duty 5 — operational completeness

**Searched, found nothing.** The diff adds exactly one operator-actionable
terminal path — a `refusal_events` CHECK violation aborting the downgrade — and
adds no swallowed path at all (the write is deliberately uncaught). Both halves
of the alert path already exist:

- `docs/runbooks/beta-launch-alerting.md:54-65` carries the
  **Refusal ledger disabled** rule row (`subsystem:refusal_ledger`, `warning`,
  once per disabled episode), emitted by `writeRefusalEvent`. Signal identity,
  filter, level, grouping, cadence and destination all match what the helper
  emits; this slice changes none of them.
- `docs/runbooks/beta-launch-alerting.md:45-50` covers the terminal path: "the
  publisher failed-hook and crash net already `captureException` with tags". Both
  caller lanes reach this write site inside `ResponsePublisherWorker`
  (`ResponsePublisherWorker.ts:64,112 → auto-policy-publish.ts → judge-gate.ts:47,55`),
  so a ledger abort becomes a terminal BullMQ failure that `attachJobFailureSink`
  raises. No new rule row is owed.

One operational risk was checked specifically because the diff could plausibly
have introduced it, and is **absent**: the Refusal insert takes `FOR KEY SHARE`
on the `accounts` row through `refusal_events.account_id`, which would be a new
lock edge inside the publisher's downgrade transaction and a deadlock candidate
against the Governor's `accounts FOR UPDATE`. It is not new —
`approval_audit_log` already carries `fk_approval_audit_log_account → accounts`
and `insertAuditLogAutoPolicy` runs one statement earlier in the same
transaction, so that lock is already held when the Refusal insert arrives.

---

## Findings

### RT-1 — P0 — the "13 of 19 red→green" arithmetic is false, in two artifacts

**At** `docs/superpowers/plans/feat-1012-refusal-auto-post-revoked-deviations.md:8`
(mirrored at `:26` and `:35`, and propagated into
`.claude/reference/arch-review-log.md:1444`).

The intake locks **19** titles. D1 lists **7** negative-space titles by name and
claims "Thirteen were" RED. 13 + 7 = 20. The correct count is **12**.

The measured line at `:26` makes the same error concretely and is checkable
against the suite: *"the unit suite was 3 RED / 3 pre-existing green / 3 of
these"* describes **nine** tests in a file that contains **eight**. Re-derived
against the diff: the unit suite has 3 pre-existing cases, 5 added, of which the
3 D1 itself names as negative-space (`missing business`, `guarded UPDATE matches
no row`, `each production gate routes…`) leave **2** genuinely RED — the
`account_id` case and the every-reason case — not 3. The live-DB half of that
same sentence ("10 RED / 4 of these") is correct and reconciles to 14. So the
total is 10 + 2 = **12 of 19**, and `:35`'s "13 of 19 genuinely red→green is the
honest number and it is recorded here rather than rounded up" is off by one in
the sentence that asserts its own honesty.

This is a false factual claim, not a stale line number, and it has already been
copied into the durable governance record. Severity is P0 on Duty 3's rule; it is
worth being explicit that no code, safety or behavioural claim is affected, and
that the **substantive** claim underneath — seven negative-space titles, all
non-inert regression pins that go red against a wrong implementation — is
independently **TRUE**: this pass planted the defect each of the seven forbids
and all seven died (Duty 1 table above). The fix is two numbers in two files.

**Disposition:** open.

### RT-2 — P2 — nothing pins "the ledger write is never caught at the call site"

**At** `worker/jobs/publisher/auto-policy-downgrade.ts:182`.

The production comment and the intake both state the invariant that the write is
deliberately not wrapped in `try/catch`. Wrapping it in one survived the
outbox-rollback test, and by inspection would survive every other test in both
suites. Arbiter verdict: **equivalent mutation** — postgres.js rethrows the
scope's `uncaughtError` after the callback returns, which the run confirms
directly (the `23514` still propagated out of `sql.begin` under the mutant), so
every database-observable consequence is identical. Recorded rather than raised:
the invariant is real as documentation, but it has no oracle, and a future
refactor could add a catch with nothing turning red. Non-blocking.

**Disposition:** open.

### RT-3 — P2 — the invariant-#15 test's stated mechanism is not the one that fires

**At** `worker/jobs/publisher/__tests__/auto-policy-downgrade.integration.test.ts:602`.
Detailed under Duty 2. The test is live and kills the mutant; the comment's
account of *how* is wrong, and a reader trusting it would mis-model the schema.

**Disposition:** open.

### RT-4 — P2 — positional bound-value indices couple to a file this diff does not own

**At** `worker/jobs/publisher/__tests__/auto-policy-downgrade.test.ts:198`
(and `:236`). Detailed under Duty 2.

**Disposition:** open.

### RT-5 — P2 — `toContain('NOW()')` is a substring proxy for the sentinel

**At** `worker/jobs/publisher/__tests__/auto-policy-downgrade.test.ts:251`.
Detailed under Duty 2.

**Disposition:** open.

### RT-6 — P2 — the gate scrape hard-codes two files, and two of its four sites are unreachable

**At** `worker/jobs/publisher/__tests__/auto-policy-downgrade.test.ts:300`.
Detailed under Duty 2.

**Disposition:** open.

---

## Authorizations

None. No finding on this run is dispositioned `accepted-risk`.

---

## Inventory

Every candidate, executed or not. Direction A is the changed test surface (both
changed test files in full); Direction B is the changed production surface — the
two behaviour-affecting hunks in `auto-policy-downgrade.ts` (the widened
`businesses` lock and the `writeRefusalEvent` call), both of which reach the
inventory through the rows below and neither of which is uncovered. No test was
deleted by this diff. `supabase/migrations/` and the three changed docs are out
of scope for mutation and were handled under Duty 3.

| id | test | file | outcome | mutant that decided it |
|---|---|---|---|---|
| RT-INV-01 | does no durable work when a newer outbox attempt owns the response | unit | killed | write hoisted above three guards |
| RT-INV-02 | claims the dispatched attempt before mutating the response and writing follow-ups | unit | killed | write deleted |
| RT-INV-03 | uses a distinct bounded marker and reason for Autopilot entitlement loss | unit | excluded | modified only by the shared mock fixture; every assertion targets pre-existing audit-marker behaviour this diff does not change, and the reason axis it shares is covered by RT-INV-05 |
| RT-INV-04 | a downgrade's refusal_events row carries the account_id read by the transaction's existing business lock | unit | killed | second `SELECT account_id` (the rejected design) |
| RT-INV-05 | every AutoPolicyDowngradeReason maps to a Refusal category and the downgrade writes it | unit | killed | category pinned to one constant |
| RT-INV-06 | a no-op downgrade on a missing business writes no refusal_events row | unit | killed | write hoisted above the `!lockedBusiness` guard |
| RT-INV-07 | a downgrade whose guarded response UPDATE matches no row writes no refusal_events row | unit | killed | write hoisted above `if (!downgraded)` only |
| RT-INV-08 | each production gate routes every AutoPolicyDowngradeReason verbatim to the shared downgrade | unit | killed | `judge-gate.ts` collapses one reason |
| RT-INV-09 | a downgrade writes exactly one refusal_events row against the response id | integration | killed | `refusalCode: marker` |
| RT-INV-10 | a downgrade's refusal_events row carries subject_type response, never the approval audit row id | integration | killed | `subjectId: randomUUID()` |
| RT-INV-11 | a downgrade's refusal_events row carries occurred_at equal to the approval_audit_log created_at written by the same transaction | integration | killed | `occurredAt: new Date()` |
| RT-INV-12 | a downgrade records the AutoPolicyDowngradeReason verbatim, so judge_disabled and judge_unhealthy stay two codes | integration | killed | `refusalCode: marker` |
| RT-INV-13 | a no-op downgrade on a response that is not downgradeable writes no refusal_events row | integration | killed | write hoisted above three guards |
| RT-INV-14 | a downgrade that loses the outbox attempt CAS writes no refusal_events row | integration | killed | write hoisted above three guards |
| RT-INV-15 | a no-op downgrade with no review anchor writes no refusal_events row | integration | killed | business read + write hoisted above the `!reviewId` guard |
| RT-INV-16 | downgrading the same response twice leaves one refusal_events row and lets the second transaction commit | integration | killed | `ON CONFLICT` removed |
| RT-INV-17 | downgrading the same response for two different reasons keeps the first refusal code and category | integration | killed | `ON CONFLICT … DO UPDATE` |
| RT-INV-18 | the standalone wrapper and the in-transaction caller each write exactly one refusal_events row | integration | killed | write deleted |
| RT-INV-19 | the in-transaction downgrade writes the refusal on the caller transaction and an outer rollback removes it | integration | killed | write moved onto its own connection and transaction |
| RT-INV-20 | a ledger failure rolls back the downgrade, the approval audit row and the notification enqueue together | integration | killed | write deleted |
| RT-INV-21 | a ledger failure rolls back completion of the claimed outbox attempt so the publisher can retry | integration | killed | write deleted (the call-site `try/catch` probe survived and was arbiter-reclassified equivalent — RT-2) |
| RT-INV-22 | REFUSAL_LEDGER_ENABLED=false changes only the refusal row and preserves the response downgrade, approval audit, notification enqueue, and outbox completion | integration | killed | raw INSERT bypassing the kill switch |

`unit` = `worker/jobs/publisher/__tests__/auto-policy-downgrade.test.ts` ·
`integration` = `worker/jobs/publisher/__tests__/auto-policy-downgrade.integration.test.ts`

---

# Round 2 — scoped to round 1's fix hunks

`git diff 7c9bd9cd..c9f2f6bb`. Round 2 is the cap; nothing follows it.

**Written by the ORCHESTRATOR, not by the pass.** The harness blocked the
round-2 subagent from writing report files, so it recorded its evidence verbatim
in `findings.json`'s `arbiter_reasoning`. Round 1's text above is untouched —
overwriting it would falsify what round 1 said. Every claim below is the pass's
recorded evidence or a measurement re-run by the orchestrator and named as such.

**Mutations: 5 of 30 runs** — 1 baseline, 3 mutants, 1 control. All journaled,
all restored, no dotenv swap.

## RT2-1 · P0 · `auto-policy-downgrade.ts:108` · FIXED

**The round-1 fix reintroduced the defect it fixed.** Round 1 found a rationale
comment containing the literal `FROM businesses`, which made
`auto-policy-downgrade-lock-order.test.ts` resolve its business rung to the
COMMENT rather than the query. The fix added a prohibition that itself read
`NO COMMENT ABOVE THIS STATEMENT MAY CONTAIN THE LITERAL FROM businesses` —
**containing the phrase it forbids**, so the rung still resolved to a comment,
now the prohibition at `:108` instead of the query at `:116`.

Evidence: M2 (business rung stops locking `businesses`) **SURVIVED**; the
identical mutant with the six prohibition lines deleted was **killed**
(`expected -1 to be greater than 1143`), proving the comment was the mask. At
fork point `06a163f0` resolution was correct — the branch introduced this twice.

**Severity bound, recorded by the pass rather than left implied:** the same
mutant IS killed by `auto-policy-downgrade.test.ts:171`, a runtime-SQL oracle
unaffected by comments, so **no production correctness defect escaped.** The P0
is a proven-fake rung plus a rule that broke itself.

**Fix, re-measured at HEAD by running the test's own `indexOf` chain** — all six
rungs now resolve to statements: `anchor` :86 · `businessLock` :122 ·
`responseLock` :133 · `attemptClaim` :142 · `responseMutation` :152 ·
`auditWrite` :170.

## RT2-2 · P1 · `arch-review-log.md` · FIXED

Per-round counts named no artifact: rounds 2 and 3 existed only in the intake and
in conversation. Fixed at the source — the plan's appendix now carries Round 2
(REVISE, four findings, all amendment drift) and Round 3 (APPROVED, the cap).

## RT2-3 · P2 · `.feature/progress.json` · FIXED

A THIRD arithmetic variant survived in gitignored state `/feature-resume` reads
back. Corrected to 12/7/19. The finding's point is kept: a count corrected only
in tracked artifacts leaves a live variant where the next session looks first.

## Verified TRUE — no finding

The 12/7/19 counts, re-counted independently; the `<=` restatement of the staging
reconciliation query; the lock-wait explanation; the date correction; the other
ladder rungs; a duty-4 sibling scan of 8 comment hits with 7 cleared by
measurement.

## Tooling defects, neither a branch defect

1. **`red-team-status.mjs` mis-slices porcelain paths** — it `.trim()`s the
   output, so an unstaged report file loses its leading space and `slice(3)` cuts
   into the path, falsely reporting an unrestored mutation. Clears once staged.
2. **The `watchers` precondition false-positives on every swarm run** — its
   machine-wide scan matches `…/RepWorth` as a prefix of
   `…/RepWorth-worktrees/…`. Resolved by `lsof` and documented, not waived, in
   both rounds and on both sibling branches.
