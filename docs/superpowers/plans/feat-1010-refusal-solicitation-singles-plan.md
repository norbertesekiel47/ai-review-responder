# Plan — #1010, the three solicitation single-site lanes

Slice 3 of 7 on map #994. Three lanes, three files, one new statement in the
ledger helper. Intake:
`docs/superpowers/plans/feat-1010-refusal-solicitation-singles-intake.json`.

## §0 What is already decided, and what this plan may not re-open

| Decision | Owner |
|---|---|
| `ask_withheld`'s `occurredAt` is the app-supplied `decidedAt` | ticket #1010 |
| `batch_halted` is ONE Refusal per batch, never one per cancelled outreach | #998 |
| `platform_halt` writes no audit row, and that asymmetry is invisible here | #994, cleared without a ticket |
| One MODULE owns the whole `refusal_events` statement | #1001 |
| The three lane maps | #994 harvest, landed by PR #1034 |

**Two decisions the owner took during this run's grill. Both supersede the
ticket body, and the second contradicts it outright.**

### D-A: `ask_withheld` writes a SET, not a loop

The ticket says "each is a single call into an existing transaction and none is
high-volume". **That is false for `ask_withheld`**, and the number is not
marginal. `loadCandidateWindow` bounds the evaluated cohort at
`MAX_DATA_ROWS` = 5000 (`src/lib/solicitation/contacts-csv.ts`).

**The ceiling is 5,000, and round 1 corrected how to get there.** An earlier
draft said ~4,975, reasoning that `BATCH_CAP` = 25 counts only `send` decisions
so the rest are withheld. That case is the all-ELIGIBLE one — and there the
withheld rows are `velocity_banked`, which maps to `null` and writes NOTHING. The
real maximum is **5,000 mapped Refusals, reached when every candidate fails an
individual gate** that maps to a category: `over_contacted`, `already_reviewed`,
`stale_visit`, `no_consent`, `suppressed`. That is also the steady state, because
a rebuild re-evaluates the whole accumulated pool. This is the highest-volume
lane in the slice, not the lowest.

Looping the single-row helper would put up to ~5,000 sequential round trips
inside the transaction that holds the per-Business advisory lock AND the batch
row lock, behind the `src/lib/db/admission.ts` chokepoint.

**So `src/lib/refusals/write.ts` gains a SET-BASED arm** beside its single-row
one. Rules, and they are not negotiable:

* It lives in `write.ts`. No lane module ever spells `INSERT INTO refusal_events`.
* Its `ON CONFLICT (refusal_source, subject_id) WHERE subject_id IS NOT NULL`
  clause is re-spelled BYTE-FOR-BYTE from the single-row arm. Postgres cannot
  infer a partial index without its predicate, and a bind parameter inside
  `ON CONFLICT … WHERE` defeats inference outright (invariant #2). **A test
  asserts the two clauses are byte-identical** — that is the compensating control
  for the second spelling #1001 warned about.
* It uses `jsonb_to_recordset`, following `commitAskDecisions`'s own set-insert
  in `src/lib/solicitation/batch-builder.ts` — the `INSERT` at `:599`,
  `jsonb_to_recordset` at `:614`.
* **It does NOT copy that function's affected-row-count assertion** (`:627-630`).
  Round 1 caught this: `commitAskDecisions` has no `ON CONFLICT`, so
  `count === input.length` holds there. Here a subject already stored by an
  EARLIER call legitimately produces a lower count, and the assertion would throw
  inside a decision transaction — the ledger breaking the thing it records.
* It reads the SAME kill switch, per call, inside the body.
* **An empty input set issues NO statement.** An `INSERT` of zero rows is not a
  decision, and `jsonb_to_recordset` over `[]` is a pointless round trip.

### D-B: the dispatch lane stamps the GATE's clock

The ticket says `occurredAt` here is "writer-supplied and cannot be derived",
and it is right that no column holds it. It does not say which value to use.

**Use the `now` that `runDispatchTx` already builds**
(`src/lib/solicitation/dispatch.ts:1619`) and that `applyDispatchGate` judges
against (`:1631`). Thread it into `commitWithhold` as an explicit parameter.

Not the `'transaction_time'` sentinel. `NOW()` in Postgres is
`transaction_timestamp()` — transaction START — and this transaction acquires the
per-Business advisory lock BEFORE the gate runs. Under contention that lock can
block for seconds, so the sentinel would stamp a decision measurably before it
was made. The gate's `now` is the clock the verdict was computed against and is
immune to the wait.

## §0.1 Precedent — read these before the first edit

* `src/lib/auto-approval/suspension.ts` — the #1009 call-site precedent, and the
  only Refusal write site on `main`. Copy its SHAPE.
* `src/lib/refusals/write.ts` — the single-row arm this slice extends. Read the
  header in full, especially what it says about `ON CONFLICT`, the kill switch,
  and why nothing is caught.
* `src/lib/solicitation/batch-builder.ts` — `commitAskDecisions`, whose
  `jsonb_to_recordset` insert the new arm follows.
* `src/lib/refusals/vocabulary.ts` — the three maps. `ask_withheld` and
  `batch_halted` carry `null` members; the dispatch map does not.

## §1 T1 — the eval (RED phase, first task)

**Every** `tests_to_add` title as a FAILING test, VERBATIM. No `.todo`, no
`.skip`, no `.fails`.

**`.feature/intake.json` is the authority for that list and this plan never
restates its length.** An earlier draft said "twenty-one"; round 2 grew it to
thirty-one, and a stale number here is exactly how an implementer stops ten
tests early. Count the array; do not trust prose.

Seams, all existing files:

* `src/lib/refusals/__tests__/write.test.ts` and `write.integration.test.ts` —
  the set-based arm.
* `src/lib/solicitation/__tests__/batch-builder.{test,integration.test}.ts`.
* `src/lib/solicitation/__tests__/dispatch.{test,integration.test}.ts`.
* `src/lib/solicitation/__tests__/approval.{test,integration.test}.ts` and
  `approval-system-halt.integration.test.ts`.

Evidence: every title in `tests_to_add` present and RED — the gate's
`promised-tests` row is what checks this, and it reads the intake, not this plan.

**Tracer-to-title mapping for round 1's additions.** The one-INSERT-statement,
already-exists-commits and caller-rollback titles go to **T2**; the
full-precision ask equality, the exact-ask-row subject and the 5000-row case to
**T3**; the dispatch failure-atomicity title to **T4**; the halt full-precision
equality and the halt ordering title to **T5**; the exhaustive
every-reason/every-null title spans **T3, T4 and T5** and closes with them.

## §2 T2 — the set-based arm in the ledger helper

**Behavior:** the ledger can record N Refusals in one statement, with the same
guarantees as one.

* **Test seam:** `src/lib/refusals/write.ts`'s new export.
* **Turns green:** `the set-based arm re-spells the refusal_events_subject_uniq
  predicate byte-for-byte, identically to the single-row arm` · `the set-based
  arm writes one row per input and leaves one row when the same subject appears
  twice in one call` · `the set-based arm issues no statement for an empty input
  set` · `the set-based arm writes nothing when REFUSAL_LEDGER_ENABLED is the
  literal string false`.
* **Blocking edges:** T1. Blocks T3.
* **Evidence:** the byte-for-byte case reads BOTH `ON CONFLICT` clauses out of
  the module source and compares them as text. Asserting each against a
  hand-typed literal would create the second authority the test exists to
  prevent.
* **Trap:** `ON CONFLICT DO NOTHING` handles duplicates proposed within ONE
  statement, which `DO UPDATE` does not. The duplicate-subject case must put both
  rows in the SAME call, not in two calls.

## §3 T3 — `ask_withheld`, in one statement

**Behavior:** a batch build records one Refusal per withheld ask whose reason
maps to a category, inside the transaction that inserts the asks.

`commitAskDecisions` already mints the ask ids (`askIds`) and holds `decidedAt`.
Build the input array from the withheld decisions whose
`ASK_WITHHELD_REFUSAL_CATEGORIES[reason]` is non-null, and pass it to the
set-based arm. `decidedAt` is an ISO STRING here — the helper takes a `Date`, so
convert once and pass the same instance for every row.

* **Turns green:** `a batch build writes one refusal_events row per withheld ask
  and none for a send decision` · `a batch build writes no refusal_events row for
  a velocity_banked withhold` · `a batch build stamps every ask Refusal with the
  batch's decidedAt, never with insert time` · `a batch build that withholds
  nothing writes no refusal_events row` · `two builds evaluating the same contact
  write two refusal_events rows, one per decision`.
* **Blocking edges:** T2.
* **Evidence:** the two-builds case is the one that proves the subject is the ASK
  and not the contact — ask ids are minted per build, so the partial unique index
  does not collapse them. Seed a real second build; do not simulate it.

## §4 T4 — `outreach_withheld` at dispatch

**Behavior:** a withheld send records one Refusal against the outreach, stamped
with the gate's own clock.

Thread `now` from `runDispatchTx` into `commitWithhold`. `scope` already carries
the account, location and outreach id.

* **Turns green:** `a dispatch withhold writes one refusal_events row against the
  outreach id` · `a dispatch withhold stamps occurred_at with the gate's decision
  clock, not with transaction start` · `a dispatch defer writes no refusal_events
  row`.
* **Blocking edges:** T1. Independent of T2/T3 — different file, different
  transaction.
* **Evidence:** the clock case must DISCRIMINATE the two candidate values. Assert
  `occurred_at` equals the gate's `now` and is strictly greater than the
  transaction's `NOW()`; an assertion that only checks "close to now" passes under
  both and measures nothing.

## §5 T5 — `batch_halted`, one row per batch

**Behavior:** a batch WE halted is recorded once. A batch the owner halted, or
one a deadline closed, is not.

`latchHalt` is the single body all three arms reach. Guard on a non-null
category, which is what excludes `owner_veto`, `owner_halt`,
`send_window_elapsed` and `batch_expired`.

**POSITION, not merely "after the CAS" (round 1, R1-6).** `latchHalt`'s five
steps are an ordered contract, and its header says so. The ledger write goes
**after step 3 (the audit row) and before step 4 (the spine step)**. Putting it
immediately after the CAS would place its failure BEFORE the cancellations and
the audit row, which makes the rollback test pass vacuously — those writes never
happened — while breaking both the documented step order and the
advisory-lock → batch-row → `agent_runs` lock order. A second halt of an
already-latched batch still returns at the CAS, before any of this.

`occurredAt` is the `'transaction_time'` sentinel. The CAS writes
`halted_at = NOW()` and `NOW()` is `transaction_timestamp()` — stable across every
statement in the transaction — so the sentinel produces the identical value to
the microsecond. **Do not add `halted_at` to the CAS's `RETURNING` and pass it
back:** postgres.js truncates microseconds on decode (#520) and the equality dies.

* **Turns green:** `an admin halt writes exactly one refusal_events row against
  the batch id, never one per cancelled outreach` · `a platform halt writes a
  refusal_events row even though it writes no account_audit_log row` · `an owner
  halt writes no refusal_events row` · `a second halt of an already-halted batch
  writes no second refusal_events row` · `a halt Refusal carries occurred_at equal
  to the solicitation_batches halted_at written by the same transaction`.
* **Blocking edges:** T1. Independent of T2/T3/T4.
* **Evidence:** the "never one per cancelled outreach" case seeds a batch with
  SEVERAL cancellable outreach rows and asserts exactly one Refusal. This is the
  parent effort's fan-out defect at batch granularity, and a single-outreach
  fixture cannot see it.

## §6 T6 — the cross-lane guarantees

**Turns green:** `every refusal_events row these three lanes write carries the
account and location already in the lane's scope` · `a ledger failure in the ask
lane rolls back the whole batch build` · `a ledger failure in the halt lane rolls
back the latch, the cancellations and the audit row together` · `all three lanes
complete their decisions unchanged when REFUSAL_LEDGER_ENABLED is false`.

* **Blocking edges:** T3, T4, T5.
* **Evidence:** force both failures through real constraint violations, never
  mocked rejections. **Precedent:
  `src/lib/auto-approval/__tests__/suspension.integration.test.ts`** — its forced
  constraint-violation rollback case AND the success-then-rollback twin beside
  it, which is the only case that proves a SUCCESSFUL ledger row shares the
  caller's transaction. (Round 1 caught an earlier citation of
  `src/lib/refusals/__tests__/write.integration.test.ts`, which carries no such
  case.)

## §7 T7 — the documentation sweep

`docs/directory.md` rows for `batch-builder.ts`, `dispatch.ts`, `approval.ts` and
`src/lib/refusals/write.ts` gain their write sites and the set-based arm.

**Also owed here, inherited from the prerequisite's deviations D4/S5:** nothing.
That comment was already corrected by PR #1034. Do not re-fix it.

## §8 What this plan deliberately does not do

* No touch to the four render writers in `ask-generation.ts` — #1011's sites,
  same `refusal_source`, different enum.
* No `try/catch` at any call site.
* No change to which candidates are withheld, which sends are refused, or which
  batches halt.
* No new file, and no new module for the set-based arm.
* No `LatchHaltReason` export. It is private by design and `approval.test.ts`
  pins the non-export; the vocabulary already re-composes it.

## §9 Review appendix — round 1 (plan-skeptic, codex, read-only)

**VERDICT: REVISE.** Ten findings, six HIGH. All accepted. The skeptic
independently confirmed the dispatch ordering claim (advisory lock and both row
locks precede `now`), that all three lanes execute inside their real deciding
transactions with no intervening commit, and that the second `ON CONFLICT`
spelling IS adequately controlled — because `write.test.ts` already anchors the
single-row generated SQL to migration 116, so comparing the new clause to that
arm inherits the anchor.

### R1-1 HIGH — the set-based arm could be a LOOP and pass everything

The sharpest finding on this plan. Every promised title — all rows written,
duplicates handled, empty input, flag off — is satisfied by an export that
loops the single-row helper. The 5,000 sequential statements this arm exists to
prevent would still happen, and the eval would be green.

**Added:** `the set-based arm issues exactly one INSERT statement for every non-empty input set`

### R1-2 HIGH — the dispatch lane had no failure-atomicity test

Only the ask and halt lanes had one. A dispatch ledger error could be caught, or
moved outside tx1, with every dispatch test still green.

**Added:** `a ledger failure in the dispatch lane rolls back the outreach withhold, child run, receipt step, outbox completion and batch close together`

### R1-3 HIGH — nothing proves the set arm uses the CALLER's transaction

Existing tests prove it for the single-row helper. The new arm could open its own
connection: its failure would still reject the outer callback, but a SUCCESSFUL
insert would survive a later caller rollback. Invariant #15 escaping the eval,
the same class the #1012 round found.

**Added:** `a set-based ledger write does not survive its caller's deciding transaction rolling back after the insert succeeds`

### R1-4 HIGH — a call site could hard-code a valid code and category

Counts and timestamps stay green while every reason but the fixture's is filed
wrong. The promised titles also never require RUNTIME absence for all four
null-mapped halt reasons — only for `owner_halt`.

**Added:** `every solicitation refusal reason writes its verbatim code and mapped category, and every null-mapped reason writes nothing`

### R1-5 HIGH — decoded `Date` comparison hides sub-millisecond inequality

Both equality claims were exposed. An ask lane using transaction time could equal
`decidedAt` after truncation; a halt lane round-tripping `halted_at` through JS
loses the microseconds that carry the claim. The comparison must happen INSIDE
Postgres at full precision.

**Added:** `an ask Refusal's occurred_at equals solicitation_asks.decided_at inside PostgreSQL at full microsecond precision`
**Added:** `a halt Refusal's occurred_at equals solicitation_batches.halted_at inside PostgreSQL at full microsecond precision`

### R1-6 HIGH — "after the CAS" is not a position

Placing the ledger write immediately after the CAS puts its failure BEFORE the
cancellations and the audit row. The rollback test then passes vacuously — those
writes never happened — while breaking `latchHalt`'s ordered five-step contract
and the run-spine-last lock order this file's header describes.

**Added:** `a halt writes its Refusal after cancelling outreach and writing any audit row, but before the run-spine step and settlement join`

**§5 is amended accordingly:** the write goes after step 3 (the audit row) and
before step 4 (the spine step), not merely "after the CAS".

### R1-7 MEDIUM — the affected-count assertion is WRONG for this arm

`commitAskDecisions` asserts `inserted.count === input.length`. Copying that into
an `ON CONFLICT DO NOTHING` insert is a bug: a subject already stored by an
EARLIER call produces a lower count and the assertion would throw inside a
decision transaction. De-duplicating within the call hides it; a cross-call
duplicate does not.

**§2 is amended: the set arm does NOT assert an affected-row count.**

**Added:** `the set-based arm commits when an input subject already exists from an earlier call`

### R1-8 MEDIUM — two builds do not prove the subject is the ask

Minting an unrelated fresh UUID per event also produces two rows that dodge the
unique index.

**Added:** `every ask_withheld refusal points to the exact solicitation_ask row whose decision it records`

### R1-9 MEDIUM — the volume arithmetic in §0 D-A was wrong

The ceiling is right and the arm is justified, but the derivation was not. **The
~4,975 figure describes the all-ELIGIBLE case — and in that case the withheld
rows are `velocity_banked`, which maps to `null` and writes NOTHING.** The real
maximum is **5,000**, reached when every candidate fails an individual gate that
maps to a category. §0 D-A is corrected.

**Added:** `a 5000-candidate batch of mapped withholds writes 5000 refusal_events rows in one INSERT`

### R1-10 LOW — a citation resolved to the wrong line

`batch-builder.ts:573` is the `commitAskDecisions` DECLARATION. The INSERT starts
at `:599`, `jsonb_to_recordset` is at `:614`, and the count assertion is
`:627-630`. Corrected in §0.1.

### Correction the skeptic did not raise, found while applying its findings

§6's forced-failure precedent cited
`src/lib/refusals/__tests__/write.integration.test.ts`, which carries no forced
`23514` case. **The real precedent is
`src/lib/auto-approval/__tests__/suspension.integration.test.ts`.** Corrected,
and carried to the other two slices, which cited the same wrong file.
