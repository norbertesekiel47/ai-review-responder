# Red team — #1010, the three solicitation Refusal lanes

| | |
|---|---|
| Mode | `feature` (dispatched inside `/feature` step 7's review wave) |
| Run id | `feature-feat-1010-refusal-solicitation-singles-bb4cba` |
| Branch | `feat/1010-refusal-solicitation-singles` |
| Fork / merge-base | `06a163f0b4b102c88687c95862999e38a1c3f517` |
| Head | `e9a6a50b21710d28209ebed7023704a21159a53a` |
| Intake SHA-256 | `b6badf4fd9244c9bf2e64eb8cf3008db762fcc2f3afacc2856c4c584379a4ca9` |
| Risk | high (from the intake) |
| Round | 1 of a hard cap of 2 |
| Generated | 2026-08-31T06:32:24Z |
| Status | **INCOMPLETE_BUDGET** — 21 in-scope candidates could not be executed inside the 30-run round budget |

Mutation tally: **21 mutants planted · 19 killed · 1 survived (arbiter-reclassified
equivalent) · 1 non-compiling (superseded)**, across 27 of the round's 30 runs
(5 green baselines + 22 mutation runs). Every mutation was reverted before this
file was created; all four production files are at their HEAD blob and
`git status --porcelain --untracked-files=no` is empty.

---

## 1. Preconditions

| Precondition | Result |
|---|---|
| Worktree clean at a committed SHA | PASS — `git status --porcelain --untracked-files=no` empty at `e9a6a50b` |
| No process serving or watching this worktree | **RESOLVED, not clean.** `mutation-runner.mjs watchers` ABORTED on four processes (`pnpm dev`, `next dev`, two `next-server`). Their working directories were then read with `lsof -a -p <pid> -d cwd`: three are `…/RepWorth` (the parent checkout), one is `…/RepWorth-worktrees/refactor-globals-css-extraction`. **None has a working directory inside this worktree**, so no hot-reload process can execute a mutation here. The runner's check is a repo-agnostic `ps` pattern with no path scoping; the skill's precondition ("no process is serving or watching **this worktree**") holds. |
| Journal closed, round open | PASS — `round-start` opened round 1 with 30 runs available |
| Environment isolated | PASS — `env --tmp-home <mktemp -d> --test-db postgres://…@localhost:5499/test_1010`, plus `dotenv-swap` so `.env.local` was a scrubbed replacement for the whole mutation phase. Test database `test_1010` is this pass's alone. |

**Recorded deviation from the skill's letter.** The skill says "run the INDIVIDUAL
test at HEAD" for each baseline. Five baselines were run instead — one per suite,
filtered by a `-t` alternation covering every candidate that suite contributes —
because each baseline consumes a run from the same 30-run budget as a mutant, and
per-candidate baselines would have left no budget for mutations at all. Every
candidate mutated below was observed **green at HEAD inside one of those five
runs**, which is the guarantee the rule exists for. Baselines: `write.test.ts`
(11/11), `approval.integration` "Refusal ledger" (10/10), `batch-builder.integration`
ledger filter (12/12), `dispatch.integration` "Refusal ledger" (7/7),
`approval-system-halt.integration` (5/5).

---

## 2. Duty 1 — hand-mutation

### 2.1 What was killed

| # | Mutation | Target test | Result |
|---|---|---|---|
| M1 | `writeRefusalEvents` set INSERT replaced by a `for` loop over `writeRefusalEvent` | *the set-based arm issues exactly one INSERT statement for every non-empty input set* | **killed** |
| M2 | set arm's `ON CONFLICT … WHERE subject_id IS NOT NULL` predicate dropped | *…re-spells the refusal_events_subject_uniq predicate byte-for-byte…* | **killed** |
| M3 | `if (inputs.length === 0) return;` deleted | *…issues no statement for an empty input set* | **killed** |
| M4 | kill-switch early return deleted from the set arm | *…writes nothing when REFUSAL_LEDGER_ENABLED is the literal string false* | **killed** |
| M5 | halt lane `occurredAt: 'transaction_time'` → `new Date()` | *a halt Refusal's occurred_at equals solicitation_batches.halted_at … at full microsecond precision* | **killed** |
| M6 | halt ledger write moved from between the audit row and the spine step to immediately after the CAS | *a halt writes its Refusal after cancelling outreach and writing any audit row, but before the run-spine step…* | **killed** |
| M7 | `send_window_elapsed` + `batch_expired` given a non-null category | *every solicitation refusal reason … and every null-mapped reason writes nothing* (HALT) | **killed** |
| M8 | `owner_veto` + `owner_halt` given a non-null category | *an owner halt writes no refusal_events row* | **killed** |
| M9 | ask lane `occurredAt: decidedAtInstant` → `'transaction_time'` | *an ask Refusal's occurred_at equals solicitation_asks.decided_at … at full microsecond precision* | **killed** (`…04.960276+00 !== …04.969+00` — a 9 ms gap the microsecond comparison caught) |
| M10 | `ASK_WITHHELD_REFUSAL_CATEGORIES[reason] ?? 'wrong_moment'` (so `velocity_banked` writes) | *a batch build writes no refusal_events row for a velocity_banked withhold* | **killed** |
| M11 | `subjectId: askIds[index]!` → a fresh `uuidv7()` | *every ask_withheld refusal points to the exact solicitation_ask row…* | **killed** |
| M12 | `if (decision.decision !== 'withhold') return [];` deleted | *…one refusal_events row per withheld ask and none for a send decision* | **killed** (via a `refusal_category` NOT NULL violation — a send decision carries no `reason`) |
| M13 | `refusalCode: decision.reason` → the literal `'no_consent'` | *every solicitation refusal reason…* (ASK) | **killed** |
| M14 | dispatch `occurredAt: input.decidedAt` → `'transaction_time'` | *a dispatch withhold stamps occurred_at with the gate's decision clock…* | **killed** (skew 0, threshold 0.3 s) |
| M15 | dispatch `subjectId: scope.outreachId` → `input.askId` | *a dispatch withhold writes one refusal_events row against the outreach id* | **killed** |
| M17 | dispatch ledger write deleted outright | *a ledger failure in the dispatch lane rolls back…* | **killed** |
| M18 | halt ledger write made conditional on `input.audit !== null` | *a platform halt writes a refusal_events row even though it writes no account_audit_log row* | **killed** |
| M19 | halt ledger write turned into a loop over the cancelled Outreach rows | *a halt writes its Refusal after cancelling outreach…* | **killed** (2 statements, expected 1 — the per-row fan-out is caught at the STATEMENT level, which matters because `ON CONFLICT DO NOTHING` on the batch subject would have kept the row COUNT at 1) |
| M20b | `commitAskDecisions` call site converted to a loop over `writeRefusalEvent` | *a 5000-candidate batch of mapped withholds writes 5000 refusal_events rows in one INSERT* | **killed** (5000 statements, expected 1) |

The four questions the brief named as most likely to be hollow are all answered
"real":

* **The single-statement claim is measured, not asserted, at BOTH levels.** M1
  (loop inside the helper) and M20b (loop at the call site) both die — the unit
  case counts awaited queries through the mock, and the integration case counts
  `INSERT INTO refusal_events` statements through a recording `Sql` proxy.
* **The three clocks are distinguishable.** Each of the three swaps (M5, M9, M14)
  dies, and each dies on a comparison that survives postgres.js's microsecond
  truncation: two are computed inside PostgreSQL (`occurred_at = ask.decided_at`,
  `occurred_at = batch.halted_at`), and the third measures skew against
  `created_at` under a deliberately held advisory lock. The ask-lane swap failed
  by 9 ms — under a millisecond-resolution JS comparison it could have compared
  equal.
* **The `ON CONFLICT` predicate's second spelling is pinned.** M2 dies on a
  source-text comparison of the two clauses against each other AND against the
  predicate parsed out of migration 116, so a matched pair of wrong clauses is
  caught too.
* **All five null-mapped reasons are pinned by RUNTIME absence, not by a map
  assertion.** M7 (the two deadline reasons), M8 (the two owner reasons) and M10
  (`velocity_banked`) each die. The halt lane's exhaustive case really drives all
  six reasons through three different entry points.

Every early-return guard removed (M3, M4, M12) died, and the halt write's
position died (M6).

### 2.2 The one survivor, and why it is recorded as a P1 rather than a P0

**M16 — the dispatch lane's ledger write moved from the END of `commitWithhold`
to its START — SURVIVED the targeted rollback case and then survived the ENTIRE
`dispatch.integration.test.ts` suite (33/33 passing).**

Arbiter reasoning, recorded verbatim as the skill requires:

> The mutation executes on exactly the branch the test drives, so it is not an
> unexecuted-branch survivor. It IS, however, an **equivalent mutant** under the
> standard definition: no observable output of `dispatchOutreach` differs. On the
> success path the same row lands on the same transaction with the same
> `occurred_at` (which is `input.decidedAt`, computed before either position). On
> the failure path the transaction aborts wholly either way and rethrows the same
> `PostgresError`. Per the skill's own rule — "a survivor you judge plausibly
> equivalent … is reclassified" — it is not scored `survived-confirmed-P0`, and
> the inventory row for that candidate is resolved to `killed` by M17, a
> non-equivalent mutation of the same production hunk.
>
> What the survivor DOES prove is an oracle gap, and that is finding RT-1: the
> production comment at `dispatch.ts:1440-1449` and the row in `docs/directory.md`
> both declare the LAST position load-bearing ("a write placed earlier would leave
> the later ones untested by the rollback case that pins exactly that"), and
> nothing enforces it. The halt lane's identical concern IS enforced — M6, the
> same reorder in `latchHalt`, dies on a dedicated position case. The asymmetry is
> the evidence: the authors judged this worth a test in one lane and did not write
> it in the other.

M20 (the first build of the call-site loop) was a **non-compiling mutation** —
a trailing comma inside a parenthesized expression — and is recorded as such
rather than as a kill or a survivor; M20b is its valid replacement and killed.

### 2.3 Budget

21 of 39 in-scope candidates were not executed. The 30-run round budget covers
at most ~25 mutations once baselines are paid for, and the changed test surface is
39 cases across seven files, five of them live-DB. Where a skipped candidate's
production line is covered by an executed sibling, the inventory row says so
(e.g. i11's `decidedAt` line is the one i12 killed the `transaction_time` swap on;
i13's empty-set guard is the one i02 killed at the unit level). The rest are
genuinely unmeasured. **This forces `INCOMPLETE_BUDGET`; a partial run can never
report CLEAR.**

---

## 3. Duty 2 — fragile assertions

One finding (**RT-5**, P2). `write.integration.test.ts` sorts its expected rows
with `String.prototype.localeCompare` and compares the result against
`readAskRefusals()`, whose query is `ORDER BY subject_id` on a `uuid` column.
Postgres orders `uuid` by its 16-byte binary value; `localeCompare` applies an
ICU collation to the hyphenated hex text. The two agree for lowercase
hyphenated UUIDs today because the hyphens sit at identical positions and hex
digits sort before letters in both, but the comparator is locale-sensitive and is
not the ordering the query establishes. **Behavioural replacement:** either sort
with a plain `<`/`>` byte comparison, or drop the ordering claim entirely and
compare as a set — the case's actual claim is "three inputs, two subjects, two
rows", not an ordering contract.

Nothing else in the changed tests matched the skill's named shapes:

* **Absence-of-tag proxies** — the one `not.toContain('velocity_banked')` is
  paired with `expect(joins).toHaveLength(4)` and `expect(result.withholdCount).toBe(5)`,
  and the dedicated `velocity_banked` case asserts `readRefusals()` is `[]`. Not
  a bare proxy.
* **Exact string counts on rendered output** — none; the only string-shaped
  assertions are the two `ON CONFLICT` clauses read out of the module and compared
  against each other and against migration 116.
* **Order assertions with no ordering contract** — the order assertions
  (`ledgerIndex > auditIndex > cancelIndex`, `invocationCallOrder`) are against
  `latchHalt`'s documented five-step order, which is a real contract; M6 and M19
  prove they bite.

The two timing thresholds (`skew > 0.3 s` against a 0.5 s advisory-lock hold, in
both the ask and dispatch clock cases) were examined and are **not** reported: the
`created_at` side is stamped at transaction START, before the block, so load
increases the measured skew rather than shrinking it. The direction of error is
away from a false pass.

---

## 4. Duty 3 — docs vs reality, re-resolved against HEAD

`prevalidate-plan.py` was available and run against both changed plan documents:
`feat-1010-refusal-solicitation-singles-plan.md` — 2 citations checked, 0
unresolved, 3 fixtures, PASS; the deviations file — 0 citations, PASS. The
following claims were then hand-checked against `e9a6a50b`:

| Claim | Source | Verdict |
|---|---|---|
| `MAX_DATA_ROWS` is 5,000 and bounds the candidate window | intake invariants, `write.ts` docblock | TRUE — `contacts-csv.ts:22`, `batch-builder.ts:490` |
| `commitAskDecisions` asserts `inserted.count === input.length` (the assertion the set arm deliberately does NOT copy) | `write.ts` docblock, R1-7 | TRUE — `batch-builder.ts:633-636` |
| `refusal_events_subject_uniq`'s predicate is `WHERE subject_id IS NOT NULL` | both arms' comments | TRUE — `116_refusal_events.sql:227` |
| `src/lib/refusals/write.ts` is the only module spelling `INSERT INTO refusal_events` | invariant | TRUE — production hits are `write.ts:389` and `write.ts:537`, nothing else |
| `latchHalt` order: CAS → cancel → audit → **Refusal** → spine step → settlement join; one row per BATCH; unconditional on `audit`; four null-mapped reasons; `'transaction_time'` sentinel | `docs/directory.md` `approval.ts` row | TRUE on every clause; M6/M18/M7/M8/M5 each prove one of them |
| `commitWithhold` writes one row against the OUTREACH, LAST, and a defer writes nothing | `docs/directory.md` `dispatch.ts` row | TRUE at HEAD (the causal half of the "LAST" sentence is the unenforced one — RT-1) |
| `toCandidate` hard-codes `matchedReview: null`, so `already_reviewed` is unreachable | deviations D2 | TRUE — `batch-builder.ts:368` |
| "for as long as this file is ahead of them, five exported constants have no production caller" | `src/lib/refusals/vocabulary.ts` header | **FALSE at HEAD** — see RT-3 |

**RT-3** is the only false claim found. It is in an unchanged production file that
sits outside this branch's `allowed_edit_surface`, and the branch found it itself
and recorded it as deviation D3 — including the correct observation that "whichever
of #1011/#1012 lands last should fix it" does not work, because `vocabulary.ts` is
outside all three swarm branches' surfaces. It is carried here as an open P1 so it
cannot be lost with that file: the sentence is false *now*, and a reader who trusts
it could delete a live export.

---

## 5. Duty 4 — missed sibling cases

Patterns searched, with scope and exclusions recorded so the negative results are
readable as evidence:

| Pattern searched | Scope | Exclusions | Result |
|---|---|---|---|
| `INSERT INTO refusal_events` | whole repo | `supabase/migrations/**`, `docs/**`, `.feature/**` | Production: only `src/lib/refusals/write.ts` (2). Everything else is a test fixture or an assertion. **Zero siblings.** |
| `writeRefusalEvents?\(` | `src/`, `worker/` | `**/__tests__/**` | Four call sites: `batch-builder.ts:661` (set), `dispatch.ts:1467`, `approval.ts:637`, `auto-approval/suspension.ts:331` (#1009's, unchanged). **No fifth site this slice missed.** |
| `subject_id IS NOT NULL` | `src/`, `worker/`, `supabase/` | — | Two production spellings, both inside `write.ts`, plus migration 116. **No third authority.** |
| `latchHalt(` | `src/`, `worker/` | `**/__tests__/**` | One definition, three callers (`haltBatch`, `adminHaltBatch`, `latchSystemHalt`) — the single-site claim holds. |
| `commitWithhold(` / `commitAskDecisions(` | `src/` | `**/__tests__/**` | One caller each. Single-site claims hold. |
| `delivery_status = 'withheld'` (write sites) | `src/`, `worker/` | `**/__tests__/**` | `dispatch.ts:1389` (this lane) and `ask-generation.ts` (the RENDER lane's four writers, an explicit intake non-goal owned by #1011). **Not a missed sibling.** |

**A sound search that found nothing is recorded as that.** The only observation
that came out of it is RT-6 (P2): `evaluateAsk`'s `already_reviewed` gate is live
code with no producer, so that one member of `WithholdReason` and its Refusal
mapping cannot be exercised end-to-end. It is pre-existing, out of this slice's
scope by the intake's own non-goals, and the branch already escalated it in
deviation D2; it is repeated here as independent confirmation, not as a new front.

---

## 6. Duty 5 — operational completeness

Scope: operator-actionable terminal or swallowed failure paths this diff adds.
The diff adds exactly one class — a `refusal_events` CHECK violation from a
mis-mapped category, which by design aborts the deciding transaction at each of
the three lanes. Four hosts reach that abort; the intake's `observability` section
names three of them.

| Host | Reached by | Surfacing route | Verdict |
|---|---|---|---|
| `solicitation_batch` BullMQ worker | ask lane | `attachJobFailureSink` raises a Sentry issue on the terminal attempt | complete |
| `solicitation_send` BullMQ worker | dispatch lane | same | complete |
| Admin route | `adminHaltBatch` | failed HTTP request | complete |
| **`SolicitationReleasePoller`** | `latchSystemHalt` → `platform_halt`, the one system halt reason that maps to a category | **`createGuardedPoll`'s catch calls `logger.error` and nothing else — no `Sentry.captureException`, no `captureMessage`. A poller is not a BullMQ worker, so `attachJobFailureSink` never sees it.** | **GAP — RT-2** |

Both halves of the alert path are missing for that fourth host: no emitted Sentry
signal, and no rule row in `docs/runbooks/beta-launch-alerting.md`. It is the same
class the runbook already records as an open gap for `AutonomyGovernorScheduler`,
and the runbook says so in those words ("that scheduler is **not** a BullMQ
worker, so `attachJobFailureSink` never sees it"). The infrastructure gap is
pre-existing; what this diff adds is a new terminal failure path into it — a
mis-mapped category would make every platform halt fail, leaving batches with
their `queued` rows, and the only trace would be one `logger.error` line per
minute-tick. Comparison of the six facets was static, as the skill requires; no
staging delivery drill was performed.

The disabled-ledger warning path (the diff's other operator-facing signal) was
compared facet by facet and is **intact**: `writeRefusalEvents` emits through the
same `warnLedgerDisabled()` as `writeRefusalEvent`, so signal identity
(`REFUSAL_LEDGER_ENABLED=false — the Refusal ledger is not recording decisions`),
filter (`subsystem:refusal_ledger`), level (`warning`), grouping title,
cadence (one per disabled episode — the latch is module-level and shared by both
arms) and destination action are all unchanged. Only the runbook's *attribution*
of the emitter is now partial: **RT-4** (P2).

One nuance worth stating because it is easy to misread as a gap and is not:
`writeRefusalEvents` returns for an empty input set **before** reading the kill
switch, so an all-eligible batch build emits no warning. That is deliberate and
documented — a build that withheld nothing has no ledger gap to warn about.

---

## 7. Findings

| id | Severity | Duty | Location | Finding | Disposition |
|---|---|---|---|---|---|
| RT-1 | **P1** | 1 | `src/lib/solicitation/dispatch.ts:1467` | The dispatch lane's ledger-write POSITION is unpinned. Moving the write to the top of `commitWithhold` leaves the targeted rollback case AND all 33 cases of `dispatch.integration.test.ts` green, which makes that case vacuous under any future reorder — the exact vacuity the halt lane pins with a dedicated position case (M6 dies there). **Replacement:** the dispatch sibling of *a halt writes its Refusal after cancelling outreach…*, asserting the `INSERT INTO refusal_events` statement index falls after the outreach `UPDATE`, the receipt step and the outbox completion, using the `recordingExecutor` shape already in these suites. | open |
| RT-2 | **P1** | 5 | `worker/background/guarded-poll.ts:108` | The SYSTEM halt lane's ledger-failure path has neither half of an alert path. `latchSystemHalt` (`approval.ts:906`) is reached only from `runReleaseCycle` (`release.ts:797`) under `SolicitationReleasePoller`, and `createGuardedPoll` catches the cycle error into `logger.error` alone — no Sentry signal, and no rule row in `docs/runbooks/beta-launch-alerting.md`. `platform_halt` is one of the two mapped halt reasons, so this diff routes a new terminal failure into that log-only lane. The intake's `observability` bullet enumerates the ask, dispatch and admin-halt routes and omits this fourth one. | open |
| RT-3 | **P1** | 3 | `src/lib/refusals/vocabulary.ts:44` | The module header is FALSE at HEAD as a direct result of this diff: "for as long as this file is ahead of them, five exported constants have no production caller" — three of the five (`ASK_WITHHELD_…`, `OUTREACH_WITHHELD_DISPATCH_…`, `BATCH_HALTED_…`) now have production callers. Already found and disclosed by the branch as deviation D3, which also correctly notes the file is outside all three swarm branches' edit surfaces, so the fix is owed to the orchestrator after the three merge. | open |
| RT-4 | P2 | 5 | `docs/runbooks/beta-launch-alerting.md:55` | The disabled-ledger rule row attributes the warning to `writeRefusalEvent` alone; `writeRefusalEvents` now emits the identical signal through the same `warnLedgerDisabled()`. Every alerting facet is unchanged, so the path is intact — only the emitter attribution is partial. | open |
| RT-5 | P2 | 2 | `src/lib/refusals/__tests__/write.integration.test.ts:184` | Expected rows are sorted with `localeCompare` and compared against a Postgres `ORDER BY subject_id` on a `uuid` column — a different collation from the one the query establishes. Latent flake, not a live failure. | open |
| RT-6 | P2 | 4 | `src/lib/solicitation/batch-builder.ts:368` | `evaluateAsk`'s `already_reviewed` gate has no producer (`toCandidate` hard-codes `matchedReview: null`), so one of the six `WithholdReason` members and its Refusal mapping are unreachable end-to-end. Pre-existing; already escalated by the branch as deviation D2. | open |

**No P0.** No test in this change was proven fake, no changed doc carries a false
`path:line` claim, and no correctness defect was found in the three lanes.

## 8. Authorizations

None. No finding on this run carries an `accepted-risk` disposition.

## 9. What blocks, and what does not

* `INCOMPLETE_BUDGET` blocks the `reviewed` transition on its own: 21 of 39
  candidates are unmeasured because the round budget is 30 runs. Round 2, if
  opened, should spend its budget on the 21 skipped rows rather than on new
  fronts.
* The run is **high risk** by the intake, so the checker will additionally refuse
  each of the three open P1s until it is fixed or a recorded user authorization
  moves it to `accepted-risk`. RT-1 and RT-2 are the two that change artefacts;
  RT-3 is a one-sentence correction owed to whoever can edit `vocabulary.ts`.
* The three P2s are recorded and block nothing.
