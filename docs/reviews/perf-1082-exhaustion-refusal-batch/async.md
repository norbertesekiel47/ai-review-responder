# Async & transaction-semantics review — `perf/1082-exhaustion-refusal-batch`

- Merge-base: `b9fb96016cc025c151f17db4b39baf165cb80a13`
- HEAD reviewed: `4f39fbd26e51e46bea1a45d8e6069d576c756021`
- Diff: `git diff b9fb9601..HEAD` — 1 production file (`src/lib/solicitation/ask-generation.ts`), 2 test files, 4 docs.
- Axis: concurrency, transaction and connection semantics ONLY.

## Findings (>= 80% confidence)

| severity | file:line | finding |
|---|---|---|
| low | `docs/directory.md:986` | The live code map still says the render lane's THREE physical call sites "all three go through the private `recordOutreachWithheldRefusal`". After this branch only two do — `settleGenerationExhaustion` goes through `outreachWithheldRefusalInput` + `writeRefusalEvents`. |

Nothing on the production change itself survived the filter. The seven hunts
below all came back clean; the evidence is recorded so a later pass does not
re-derive it.

### F1 — `docs/directory.md:986` is false at HEAD

**What it says.** "…the `outreach_withheld` RENDER lane of the **Refusal**
ledger — FOUR writers (`persistChildRender`, `settleBudgetStop`,
`regenerateAsk`, `settleGenerationExhaustion`) through THREE physical call
sites, since `settleBudgetStop` settles via `persistChildRender`; **all three go
through the private `recordOutreachWithheldRefusal`**, on the deciding
transaction, never in a `try/catch`."

**What is true at HEAD.** `ask-generation.ts:695` keeps
`recordOutreachWithheldRefusal` for the `persistChildRender` and `regenerateAsk`
sites. The third site, `ask-generation.ts:1911`, calls
`writeRefusalEvents(tx, refusals)` directly with inputs built by the new
`outreachWithheldRefusalInput` (`:731`). "All three" is now "two of three".

**Why it matters concretely.** `.claude/CLAUDE.md` § Working rules makes this
map the mandated first stop ("Default is 'no new file' — check `docs/directory.md`
first"), and `ci:directory-map` checks only that a row EXISTS for each
production file, never that its prose is true — so nothing else catches this.
The realistic defect: the next ticket that has to change the lane's Refusal
shape (a new `RenderWithholdReason`, a subject-axis change, a `try/catch`
decision) reads "all three go through `recordOutreachWithheldRefusal`",
edits that one function, and ships a change that silently misses the batching
writer. The two remaining traps in the same row — (c) "ONE Refusal per withheld
OUTREACH … `settleGenerationExhaustion` settles several rows per call" and the
`renderedAt`/`occurred_at` trap (a) — are still true and are unaffected.

**Scope note.** `docs/directory.md` is NOT in the intake's
`allowed_edit_surface` (which is `ask-generation.ts`, the two test files, and
`arch-review-log.md`). Fixing it needs a surface amendment with the owner's
recorded reason, so this is RAISED rather than taken — the same disposition the
async axis took for `src/lib/refusals/read.ts:45` on `fix/1079`. The dated
`arch-review-log.md:1495` row for #1011 says the same thing but is a historical
ledger entry and is correctly left alone.

---

## The seven hunts, with evidence

### 1. Does the single statement provably run on the SAME `tx` handle?

**Yes, and there is no path to a pooled connection.**

- `settleGenerationExhaustion` (`ask-generation.ts:1776`) opens
  `sql.begin(async (tx) => …)` at `:1797`. `tx` is the callback parameter; every write in
  the body binds it.
- `writeRefusalEvents(tx, refusals)` at `ask-generation.ts:1911` passes that
  same binding. Its signature is
  `writeRefusalEvents(tx: TransactionSql, inputs: readonly WriteRefusalEventInput[])`
  (`src/lib/refusals/write.ts:584-587`), so the outer `Sql` is not even
  assignable — the compiler forecloses the pooled-connection path.
- `src/lib/refusals/write.ts` imports `@sentry/node`, `postgres` (types only),
  `uuid`, `@/lib/config/flags`, `@/lib/shared/logger`, `./vocabulary`. No
  `@/lib/db/server`, so the helper cannot reach the singleton internally
  (invariant #15; `ci:db-imports` is strict with the baseline deleted).
  `ask-generation.ts` likewise has no runtime `@/lib/db/server` import — the
  only occurrence of that string in the file is inside a docblock at `:675`.
- `src/lib/db/admission.ts` is not bypassed and is not implicated: per its own
  contract (`admission.ts` § `transactionSlot`), queries on the `tx` handle are
  "ungated by construction — postgres.js hands the callback a separate scoped
  `Sql` with its own handler, which never reaches this module". The transaction
  holds exactly ONE slot for its whole duration, before and after this change.
  `reentrantBypasses` would only tick if code inside the callback reached the
  outer `sql`; nothing here does.
- The new live-DB case at
  `src/lib/solicitation/__tests__/ask-generation.integration.test.ts:1493`
  pins this behaviourally: `abortingExecutor` poisons the transaction with a
  real `SELECT 1 / 0` (22012) after the callback returns, and BOTH
  `readOutreachRows()` and `readRefusalRows()` must come back empty. A helper on
  its own connection would already have committed and the ledger read would be
  non-empty. (The pre-existing `abortAfterLedgerWrite` case at `ask-generation.integration.test.ts:1682` covers
  the same property for this writer from the other direction and is generic over
  the arm — it counts `refusal_events` on the caller's `tx` — so it did not need
  editing.)

### 2. postgres.js at N = 5,000 — parameter size, pipelining, `statement_timeout`

**No new hazard; every dimension improves.**

*The ceiling is real.* `holes` is bounded by the batch's `status = 'send'` asks.
`solicitation_asks` has exactly ONE insert site
(`batch-builder.ts:615`), fed by `decisions` derived from a single
`loadCandidateWindow` call whose window is `LIMIT ${MAX_DATA_ROWS}`
(`batch-builder.ts:499`, `MAX_DATA_ROWS = 5000` in `contacts-csv.ts:22`), and a
batch is built once (`deleteUnbuiltBatch` / `built_at IS NULL`). So the branch's
comment at `ask-generation.ts:1862` is accurate.

*Parameter size.* The set arm sends ONE bind parameter: `tx.json(rows)`
(`write.ts:648`). Each row is ~430-450 bytes of JSON (three uuids, five short
enum strings, a null, a version literal, an ISO instant), so N = 5,000 is
~2.2 MB in a single Bind message. The protocol length field is int32 and a
`jsonb` value may be up to 1 GB; 2.2 MB is nowhere near either. The prior shape
sent 5,000 messages of ~11 small parameters each — more total bytes on the wire,
not fewer.

*Pipelining.* Unchanged. Both shapes `await` sequentially inside the `sql.begin`
callback, so at most one query is in flight on the transaction's connection at
any time. Nothing here creates a `Promise` combinator over DB-issuing elements
(and `src/lib/solicitation/` is outside `ci:pool-fanout`'s scope by intake
decision anyway).

*`statement_timeout`.* The write client sets
`connection: { statement_timeout: DEFAULT_STATEMENT_TIMEOUT_MS }` = 30 s
(`src/lib/db/server.ts:66`), which overrides Supabase PgBouncer's ~8 s default
for this session — that is exactly what the CLAUDE.md gotcha prescribes. The
change does move work from "5,000 statements each individually timed" to "one
statement timed", which is a genuine new shape; but a single
`INSERT … SELECT FROM jsonb_to_recordset` of 5,000 narrow rows with one partial
unique index is tens of milliseconds of server work, two-to-three orders of
magnitude under the 30 s budget, while the shape it replaces was 5,000 network
round trips (at a 0.3-1 ms RTT, 1.5-5 s of pure latency inside the lock window).
I could not construct a plausible input where the batched statement times out
and the loop did not.

*Memory.* The `refusals` array now holds up to 5,000 small objects for the
duration of the loop instead of one transient object per iteration — ~2-3 MB on
the single-replica worker. Noted, not a finding.

### 3. Lock-window reasoning — is the "the window shrinks" claim honest?

**Yes, and the branch already states the honest number.** Both locks are
transaction-scoped: `acquireSolicitationBatchLock` is
`pg_advisory_xact_lock(hashtext('solicitation_batch_' || businessId))`
(`batch-builder.ts:226`), released only at COMMIT/ROLLBACK, and the
`solicitation_batches` `FOR UPDATE` row lock likewise. So the window IS the
transaction.

- Before: `2N` sequential round trips inside the window (`insertOutreachRender`
  + `writeRefusalEvent`, per hole), plus the fixed 5.
- After: `N + 1` (`insertOutreachRender` per hole, one `writeRefusalEvents`).

That is a ~2x reduction, not an order of magnitude, because
`insertOutreachRender` deliberately stays per hole (intake non-goal 1). The
branch does not overstate it: `arch-review-log.md:1513` clause (e) says in those
words "the win is 2N → N+1 round trips, not 2", and the plan's "What stays out"
section names the residual and files it as a follow-up. The intake's
`user_visible_behavior` wording ("removes up to 4,999 sequential round trips
from the advisory-lock window") is literally true — it removes 4,999 of the
10,000 — and does not claim the window became O(1). No correction needed.

### 4. Error semantics — where the abort now lands

**No downstream behaviour changes.**

The abort point moved only WITHIN the loop region: from "after hole *i*'s
insert" to "after hole *N*'s insert". Everything the prompt names sits AFTER the
ledger write in both shapes, so all four are unreached either way:

| step | old | new |
|---|---|---|
| `markOutboxFailed` CAS (`:1800`) | ran, then rolled back with the tx | identical |
| `recordGenerationSteps` (`:1917`) | never reached | never reached |
| `readRenderTally` (`:1925`) | never reached | never reached |
| `closeBatchIfSettled` (`:1930`) | never reached | never reached |

`markOutboxFailed` is a plain `UPDATE … WHERE status='dispatched' AND attempt=$`
on `tx` (`src/lib/shared/outbox.ts:166-175`), so on a rollback the row stays
`dispatched` and `generate-failed-hook.ts`'s bounded in-hook retry (or the
watchdog re-drive) still owns it — before and after. The error the caller sees
is the same class (`23514` from migration 116's CHECKs), naming the first
violating row in both shapes. The only real delta is wasted work: the old shape
aborted after *i* `solicitation_outreach` inserts, the new one after *N*. All
roll back.

`writeRefusalEvents` is not wrapped in `try/catch` at this call site, matching
`batch-builder.ts:670` and the helper's own contract ("It DOES raise on a CHECK
violation, which is a writer bug. Not caught.", `write.ts:27`). Correct: this
write is INSIDE the decision, not best-effort work beside it, so the CLAUDE.md
"best-effort work needs its own try/catch" rule does not apply.

The live-DB regression net for this is intact and unedited: the third leg of
`'a ledger failure at each of persistChildRender, regenerateAsk, and
settleGenerationExhaustion rolls back the outreach insert it accompanies'`
(`ask-generation.integration.test.ts:1663`) bends the category map via
`withBentCategory('render_failed', …)`. Because the branch routes BOTH arms
through `outreachWithheldRefusalInput`, which reads
`OUTREACH_WITHHELD_RENDER_REFUSAL_CATEGORIES` at call time, that fixture still
reaches the set arm and still produces `CHECK_VIOLATION`.

### 5. Can two rows in the same set collide with EACH OTHER?

**Unreachable here, and harmless if it were.**

*Unreachable.* Every `subject_id` in the set is the return value of a distinct
`insertOutreachRender` call, and that function mints `const outreachId = uuidv7()`
per invocation with no `ON CONFLICT … RETURNING` fallback
(`src/lib/solicitation/outreach.ts:589-614`), so it can never hand back a
pre-existing id. The `holes` query `GROUP BY ask.id, ask.contact_id`
(`ask-generation.ts:1825-1846`), so it cannot yield the same ask twice either.
No fixture — including a mid-loop 23505 from a racing live insert — can put two
equal `subject_id`s into one array; that race aborts the transaction instead.

*Harmless anyway.* The 21000 error "ON CONFLICT DO UPDATE command cannot affect
row a second time" is specific to `DO UPDATE`. Under `DO NOTHING`, Postgres's
speculative-insertion arbiter check runs against a dirty snapshot that sees the
tuple the same command inserted, so the later duplicate is skipped and the
command commits with one row. `write.ts:673-676` already states this correctly
and it is pre-existing, unmodified code.

*Related but unreachable intake claim.* `edge_cases[4]` says "A duplicate
subject from an earlier settlement: absorbed by `ON CONFLICT DO NOTHING`." That
case cannot arise for the same reason — a re-settlement mints new outreach ids,
so it proposes new subjects, never a repeat. The `DO NOTHING` clause is still
required (the arm is shared with `ask_withheld`, whose subject is a
`solicitation_asks` id that CAN repeat across rebuilds); the edge case is simply
vacuous for this lane. Vacuous, not wrong.

### 6. Idempotency across BullMQ retries

**Still safe, and safe in the same way.** The idempotency guard is unchanged and
is the outbox CAS, not the ledger:

1. A retry that carries a stale attempt loses `markOutboxFailed`'s CAS
   (`dispatchedRow` requires `status='dispatched'` AND the attempt), returns
   `{ status: 'stale' }` before the hole query, and reaches NEITHER arm. Pinned
   by the renamed unit case at `ask-generation.test.ts:1565`, which now asserts
   both arms via `expectNoRefusalWrite()`.
2. A retry after a COMMITTED settlement recomputes `holes`. The prior fills are
   `delivery_status = 'withheld'`, which is non-cancelled, so the
   `HAVING COUNT(*) FILTER (WHERE o.delivery_status <> 'cancelled') = 0` clause
   excludes those asks. `holes` is empty, `refusals` is `[]`, and
   `writeRefusalEvents` returns before issuing a statement (`write.ts:588`).
3. A retry after a ROLLED-BACK settlement re-runs the whole thing from a clean
   state; the CAS is available again because it rolled back with everything else.

The disabled-ledger warning budget is also unchanged. With
`REFUSAL_LEDGER_ENABLED=false` and N holes, the old shape made N calls of which
the `warnedThisEpisode` latch (`write.ts:296`) let exactly one warn; the new
shape makes one call that warns once. With zero holes, both shapes warn zero
times — the old one because it never called, the new one because the empty check
precedes the flag read. `endDisabledEpisode()` is two unconditional assignments,
so going from N invocations to one changes nothing.

### 7. Comment claims about locks, connections and timing

Every load-bearing claim the branch adds was checked. All true except the one
already noted at `docs/directory.md` (which the branch did not write but did
falsify):

- `ask-generation.ts:1858-1866` (W4) — "`holes` is bounded only by the batch,
  `loadCandidateWindow` bounds a batch at MAX_DATA_ROWS (5,000) … a write per
  iteration is that many sequential round trips with both locks held": TRUE, see
  hunt 2 and hunt 3.
- `ask-generation.ts:1903-1906` — "`writeRefusalEvents` issues no statement for
  an empty input and returns before it even reads the kill switch": TRUE,
  `write.ts:588` returns on `inputs.length === 0` before
  `isRefusalLedgerEnabled()`. Pinned by the new unit case at `ask-generation.test.ts:1608`.
- `ask-generation.ts:1907-1910` — "INSIDE THE TRANSACTION, after the last fill
  and before the run-spine receipt: a rollback must take the fills and their
  Refusals together": TRUE and now pinned by `:1493`.
- `ask-generation.ts:721-724` — "IT IS PURE … no `tx`, no clock read, no flag
  read": TRUE, and correct against `vocabulary.ts`'s in-area definition of PURE
  (which is "no DB handle, no clock, no flag read"). This is NOT the
  `fix/1079` defect where "PURE" was applied to a function whose whole body was
  a flag read — `outreachWithheldRefusalInput` reads nothing.
- `ask-generation.ts:725-731` — "`NOW()` is `transaction_timestamp()` — it
  freezes at transaction START, and every transaction in this lane waits on the
  per-Business advisory lock before it decides anything, so the sentinel would
  record neither the decision nor the write": TRUE. `decidedAt = new Date()` at
  `:1796` is read before `sql.begin`; `BEGIN` is later; the advisory lock wait is
  later still; the write is last. `transaction_timestamp()` falls strictly
  between the decision and the write, so it is neither.
- `arch-review-log.md:1513` clauses (a)-(e): checked; each is true, including
  the honest "2N → N+1, not 2" in (e) and the `invocationCallOrder` mechanism in
  (d) (vitest's `MockContext.invocationCallOrder` is a global monotonic counter
  shared across mocks, so the sort does restore real chronology).

---

## Low-confidence appendix

Observations that did not meet the 80%/concrete-failure bar. None of these is a
recommendation to change code.

**A1 — "behind the `src/lib/db/admission.ts` chokepoint" is ambiguous
(`ask-generation.ts:1865-1866`).** `admission.ts` explicitly documents that
queries on the `tx` handle are ungated and never reach the module, so under a
strict reading the per-hole ledger writes were NOT "behind the chokepoint" —
the TRANSACTION is, holding one slot for its duration. Under the looser reading
(the whole transaction sits downstream of the gate, occupying a slot while it
runs) the sentence is true, and that reading is also the operationally
significant one — a longer transaction starves other callers at the gate. The
phrasing is copied from `write.ts:554-556`, which is pre-existing and outside
this branch's edit surface. Because the charitable reading is both true and the
one that matters, I do not stake 80% on calling it false. Worth tightening to
"holding an admission slot for the whole window" if the file is touched again;
the class it belongs to — one rationale duplicated into a second location — is
exactly the mechanism the `fix/1079` async findings named.

**A2 — the silent-loss blast radius changed shape, though not probability.**
The intake's `observability` names the failure as "fewer Refusal rows than
withheld fills, with no error and no log line", and correctly notes nothing in
production emits it. Post-change, a single mis-built array loses ALL N rows in
one go rather than needing N-1 independent failures. The probability is not
higher (there is one array construction either way, and it is the same `map`
that already served `batch-builder`), and the live-DB set-comparison at
`ask-generation.integration.test.ts:1486-1490` is the guard. Recorded because
`writeRefusalEvents` deliberately asserts no affected-row count (R1-7), so the
runtime has no counter-check on either side of the change.

**A3 — `occurred_at` serialization differs between the two arms, to no
observable effect.** The single-row arm binds the `Date` (`${occurredAt}::timestamptz`,
`write.ts:427`); the set arm sends `occurredAt.toISOString()` inside the JSONB
payload (`write.ts:619`). Both are UTC at millisecond precision, which is all a
JS `Date` carries, and postgres.js's own `timestamptz` serializer is
`toISOString()` too — so the stored values are byte-identical. This was the one
column where the arm switch could plausibly have drifted, and it is pinned in a
LIVE database, per-lane, by `'a generation exhaustion never stamps occurred_at
from the settlement transaction, so a slow lock does not move the decision time'`
(`ask-generation.integration.test.ts:1360`), which asserts
`r.occurred_at = o.rendered_at` in SQL. Verified, no action.

**A4 — the new abort case at `:1493` partly overlaps `:1682`.** The pre-existing
`'a refusal written by each render writer does not survive a later rollback of
its outreach transaction'` already drives `settleGenerationExhaustion` through
`abortAfterLedgerWrite` (`ask-generation.integration.test.ts:1682`) and asserts `countRefusalRows() === 0`. The new case adds
a genuinely different mechanism — a REAL Postgres error (22012) that puts the
backend in aborted state, versus a JS throw that only triggers postgres.js's
`ROLLBACK` — so it is not redundant, but the marginal coverage is smaller than
`arch-review-log.md` clause (e) implies. Test-design nuance, not a defect.

**A5 — environment note, not a branch defect.** My first run of
`src/lib/solicitation/__tests__/ask-generation.test.ts` reported the two new
cases failing with `writeRefusalEvent` called 3 times and `writeRefusalEvents`
0 times — i.e. the fork-point behaviour. That is the signature of a stale
vitest transform cache for `ask-generation.ts` in the worktree's
`node_modules/.vite`. Nine subsequent runs (six via the local binary, two via
`npx`, one filtered) were 51/51 green and the filtered single-test run passed in
isolation. Recorded so a later pass does not chase it: it reproduces once, on a
cold worktree cache, and never again.

## Verdict for this axis

The production change is transaction-correct. It runs on the caller's `tx` by
construction and by type, it is inside the same `sql.begin` and therefore the
same rollback unit as the fills it records, it preserves the outbox-CAS
idempotency contract unchanged, it cannot self-conflict, and it strictly reduces
the work done under the per-Business advisory lock and the `solicitation_batches`
row lock. One stale cross-reference in a file the branch may not edit is the only
thing I would raise.
