# Plan — #1009 the Refusal ledger's write path

**Ticket:** [#1009](https://github.com/RepWorth/ai-review-responder/issues/1009) ·
**Map:** [#994](https://github.com/RepWorth/ai-review-responder/issues/994) ·
**Slice:** 2 of 7 ·
**Intake:** `.feature/intake.json` (audit copy:
`docs/superpowers/plans/feat-1009-refusal-ledger-write-path-intake.json`)

**Blocked by:** #1008 and its PROMOTION. **Both are satisfied** — migration 116
is applied to staging and production, and `bf869ab0` removed the LOCAL-ONLY
marker and re-armed `migration-immutability-guard.sh`.

**RISK = high** (worker + a write inside the auto-approval suspension
transaction). Rides `staging` before `main`.

---

## 0. What this slice decides that no earlier slice could — deviation D16

#1008 recorded deviation **D16** and resolved it by declining to resolve it:
where the FIRST Refusal write site lands was stated two ways across its
artifacts, the count was 3-to-3, and #1008 was not the change that knew.
It named #1009's PR as the change that settles it.

**SETTLED: the first Refusal write site lands in #1009.** `autonomy_suspended`,
one site, inside `suspendAccountAutonomy`. Ten sites remain across #1010–#1013.

**The evidence is not an artifact count, which is what both of #1008's failed
attempts used.** It is two locked decisions that predate every artifact in the
dispute:

1. **#1004 locked the slice order verbatim:** *migration 116 alone → **helper +
   kill switch + `autonomy_suspended`** → {solicitation singles ×3 ‖ outreach
   render ×4 ‖ `auto_post_revoked`} → `held_draft` + `policy_gate_held` →
   Restraint tab.* Slice 2 is this ticket, and it names the lane.
2. **#1009's own ticket body, §5,** is headed *"First caller —
   `autonomy_suspended` (1 site)"* and cites `suspension.ts`.

**Why the opposing reading exists, and why it is not a contradiction.** The
"#1010–#1013" phrasing comes from #1008's intake `non_goals`, which was
enumerating what **#1008** excluded. Every Refusal write site is outside
#1008's surface, so listing the four later tickets was true about #1008 and
silent about #1009. It was never a claim that #1009 writes nothing — it was a
sentence about a different subject that reads like one about this one.

**A third, independent ground:** a helper shipping with zero callers is dead
code, which this repo gates on. #1008's own D16 names this ground and calls it
"sound, independent of any count". It points the same way.

### The sweep — task T7

D16's own lesson is *run the sweep BEFORE choosing the edit direction*. The
sweep was run first. Here is the complete inventory of copies at
`origin/main` = `0494297a`, and the disposition of each.

| File | Symbol to find | Action |
|---|---|---|
| `.claude/reference/arch-review-log.md` | the 2026-08-29 migration-116 row, phrase "left unsettled on purpose (D16)" | **EDIT** — state the settlement |
| `.claude/reference/migrations-log.md` | the `**116**` entry, phrase "See that branch's deviations D16" | **EDIT** — state the settlement |
| `.claude/reference/lab-notes.md` | phrase "the change that actually knows resolve it (#1008 deviation D16)" | **EDIT** — state the settlement |
| `docs/currents.md` | phrase "unsettled — see #1008's deviation D16" | **EDIT** — state the settlement |
| `docs/progresstracking.md` | phrase "is left unsettled by deviation D16" | **EDIT** — state the settlement |
| `docs/superpowers/plans/feat-1008-…-deviations.md` | `## D16` section | **APPEND ONE CLOSING LINE** — a reader following any pointer above lands here and must find the answer |
| `supabase/migrations/116_refusal_events.sql` | header, "NOT SETTLED HERE" | **DO NOT TOUCH** — see below |
| `docs/superpowers/plans/feat-1008-…-intake.json` | `non_goals[1]` | **DO NOT TOUCH** — sha-locked contract mirror |
| `docs/superpowers/plans/feat-1008-…-plan.md` | "## Not in this PR" | **DO NOT TOUCH** — closed run's record |
| `docs/reviews/red-team/feat-1008-…/findings.{md,json}` | RT-12, RT-22 | **DO NOT TOUCH** — historical findings |
| `docs/reviews/feat-1008-…/standards.md` | the finding that told `arch-review-log.md` to match the other two | **DO NOT TOUCH** — historical review record |
| `docs/reviews/feat-1008-…/triage.md` | that finding's disposition | **DO NOT TOUCH** — historical review record |
| `docs/reviews/feat-1008-…/spec-correctness.md` | "when #1009's insert helper and #1010–13's write sites land" | **DO NOT TOUCH** — historical review record (found by T7) |
| `src/lib/refusals/vocabulary.ts` | its file-header docblock | **NO EDIT NEEDED** — T2 wrote it already agreeing with the settlement (found by T7) |

**This table was short THREE times, and that is the finding, not the fix.** Round
1 added two rows. T7's own pre-edit sweep then found two more — a *third* #1008
review record, and a living copy in code that this very branch created while the
table was being written.

**That is D16's own failure mode recurring inside D16's own sweep**, and the
irony is instructive rather than embarrassing: D16's lesson is *count every copy
before choosing the edit direction*, and counting is not a thing you do once. A
branch that is itself writing new copies has a moving target, so the count has
to be re-run at the moment of editing — which is exactly what T7 did, and why it
caught what the plan had not.

**The last two rows were added after plan review round 1 (finding 10).** The
first version of this table listed eight artifacts and implicitly claimed to be
complete. It was not: the #1008 standards report and its triage also reproduce
the disputed claim. They stay untouched — a review report records what a
reviewer said, and editing one falsifies the record — but a table that claims
completeness must list them. This is D16's own lesson applied to D16's own
sweep: **count every copy first, then choose the edit direction.**

**Why migration 116 is untouchable, and why it does not need touching.** It is
applied to production and guarded by `migration-immutability-guard.sh`. It is
also **already correct**: its header says the split "IS NOT SETTLED **HERE**"
and that "#1009's PR is what settles it". Both sentences stay true forever. A
migration header records what its own change knew, and this one recorded that
accurately.

**Owner decision, 2026-08-30:** all three of the above (settle as #1009; harvest
the closed axes only; sweep the living docs plus one closing line on D16) were
put to the owner as the intake's three forks and ratified before setup.

---

## 1. Design — the seams

Applying `codebase-design`.

### `src/lib/refusals/write.ts` — NEW MODULE, deep

**Interface** — one exported function and one exported input type. Everything a
caller must know:

```ts
export type RefusalOccurredAt = Date | 'transaction_time';

export interface WriteRefusalEventInput {
  accountId: string;
  /** NULL for autonomy_suspended and ONLY for it — CHECK C3 is biconditional. */
  businessId: string | null;
  refusalSource: RefusalSource;
  /** NULL exactly for held_draft — CHECK C4. */
  refusalCode: string | null;
  /** Non-empty, NULL-member-free, and containing refusalCode, for
   *  policy_gate_held only; NULL for every other lane — CHECK C5. */
  allRefusalCodes: readonly string[] | null;
  refusalCategory: RefusalCategory;
  /** NULL together, or both present — CHECK C2. The lane decides which — C1. */
  subjectType: RefusalSubjectType | null;
  subjectId: string | null;
  /** REQUIRED, never optional. See §2. */
  occurredAt: RefusalOccurredAt;
}

export async function writeRefusalEvent(
  tx: TransactionSql,
  input: WriteRefusalEventInput,
): Promise<void>;
```

Plus four facts that are part of the interface and not of the type signature:

1. It runs **inside the caller's deciding transaction**. It opens none of its own.
2. It **never raises on a duplicate subject**. `ON CONFLICT … DO NOTHING`.
3. It **may return without writing** — the kill switch. The caller cannot detect
   this and must not try to.
4. It **does raise on a CHECK violation**, which is a writer bug. It is not
   caught. See §3.

**Implementation hidden behind that interface** — the twelve-column INSERT, the
byte-for-byte `ON CONFLICT` predicate, the `uuidv7()` mint, the
`'transaction_time'` sentinel resolution, the flag read, the per-episode
Sentry latch.

**Deletion test.** Delete this module and all five reappear at eleven call
sites. That is exactly #1001's stated reason for mandating one helper.

**No seam, deliberately.** One adapter means a hypothetical seam. There is no
`RefusalLedger` interface, no `getRefusalLedger()` factory, no injected writer.
`ReviewPublisher` earned its factory because a second adapter (direct Google
Business Profile) is planned; nothing varies here. `writeAccountAuditLog` — the
precedent this helper is modelled on and the single audit writer for the whole
codebase — is a bare exported function for the same reason.

**The input IS a per-lane union — and this REVERSES the plan's original
decision.** Branch review round 1 found the original reasoning wrong, at `high`,
on two axes independently (adversarial A-01 and standards S3), and the owner
ratified the reversal on 2026-08-30.

The original text rejected a seven-arm union on the ground that #1001 puts those
invariants in the database, so a TypeScript copy would be *"a second authority
over the same five facts"*. **That conflates two different things.** Migration
116 must stay the STORAGE authority and must keep all five CHECKs — TypeScript
cannot protect SQL written by another process or by an operational query. None
of that requires the TypeScript API to *accept states already known to be
illegal*.

A union is not a competing authority; it is a **compile-time projection** of the
same one, and it cannot drift silently: adding a lane to `REFUSAL_SOURCES`
without an arm is a compile error. The implementation is a mapped type over
`RefusalSource`, so that totality is enforced by the language rather than by
review.

What the original reasoning got right, and what is kept: the union transcribes
**C1–C4 only**. `refusalCategory` stays `RefusalCategory` in every arm, because
#1001 explicitly declined to CHECK `held_draft`'s fixed category — pinning a
lane's category would make a future re-map migration-bearing, and that decision
stands.

The cost of being wrong here is what moved it from "nice" to `high`: this module
deliberately does not catch, so a mis-paired lane raises `23514` and **aborts the
deciding transaction**. Eleven callers are planned; the type now makes the
mistake unspellable at all eleven.

### `src/lib/refusals/vocabulary.ts` — NEW MODULE, deliberately shallow

Three closed `as const` arrays with unions derived from them, one frozen version
literal, one lane map. No DB handle, no clock read, no flag read — every input
is a literal, so the whole file is table-testable.

**Shallow on purpose.** A vocabulary is read by humans as often as it is called.
An interface smaller than its content would hide the thing callers need to see.
Depth is the wrong goal for this module. Precedent: `WITHHOLD_REASONS` in
`src/lib/solicitation/restraint-policy.ts`.

**Harvested from `feat/refusal-log`, corrected, never copied.** That branch is
PARKED and never merges (deviation D1). Read it with
`git show feat/refusal-log:src/lib/refusals/vocabulary.ts`.

### `worker/background/pollers/ArchivalPoller.ts` — DEEPENED

Interface grows by exactly one exported constant
(`REFUSAL_LEDGER_RETENTION_DAYS`). `runArchival(logger)` is unchanged.
Implementation grows by one arm.

**Rejected: extracting a per-arm abstraction.** Ten arms exist with none, and
the file's own comment says the length *is* the retention vocabulary, one block
per table. Abstracting on the eleventh use is not "the second use" — it is a
rewrite of nine working arms inside a slice whose surface must stay tight.

### `src/lib/auto-approval/suspension.ts` — CALL SITE

One added statement inside the existing transaction. `suspendAccountAutonomy`'s
own interface does not change.

---

## 2. The three rules that decide the implementation

### 2.1 The `ON CONFLICT` predicate is re-spelled byte-for-byte

Migration 116:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS refusal_events_subject_uniq
  ON refusal_events (refusal_source, subject_id)
  WHERE subject_id IS NOT NULL;
```

The helper's clause, byte-identical in its predicate:

```sql
ON CONFLICT (refusal_source, subject_id) WHERE subject_id IS NOT NULL
DO NOTHING
```

Postgres cannot infer a partial index without the predicate. The predicate may
not be parameterised — a bind parameter inside `ON CONFLICT … WHERE` defeats
partial-index inference (`.claude/CLAUDE.md` invariant #2, and the same failure
the ArchivalPoller's arm 10 comment documents for its literal status list).

**`DO NOTHING` is required, not optional.** A bare unique index raises on a
duplicate and aborts the transaction it sits in, and that transaction is the
decision. The ledger must never break the thing it records.

### 2.2 `occurredAt: Date | 'transaction_time'` — required, never optional

An **optional** field lets a lane drift into the transaction stamp silently.
`outreach_withheld`/render decides during the LLM round trip and persists
afterwards, so an omission there records persist time, seconds late, compiling
and passing every test. Required plus a sentinel makes that a type error.

`'transaction_time'` emits an unparameterised `NOW()`. In Postgres `NOW()` **is**
`transaction_timestamp()`, and `account_audit_log.created_at` is
`DEFAULT NOW()` (migration 034), so a Refusal and the audit row written in one
transaction carry identical timestamps to the microsecond. That equality is the
substitute join #1006 accepted in place of a `suspension_event_id` column.

**A site may not read `transaction_timestamp()` and pass it back as a `Date`** —
postgres.js truncates microseconds on decode (#520), and the equality dies.
Every test asserting the equality reads both columns `::text`.

#### 2.2b The migration's `NOW()` prohibition, and why the sentinel supersedes it

**Plan review round 1, finding 7.** Migration 116 says two things this plan
appears to contradict, and an earlier draft of §0 called the migration "already
correct" without qualification. That was an overclaim, and it is corrected here.

The migration's header says *"No writer may pass `NOW()` for `occurred_at`"*,
and the `occurred_at` column comment says *"Never `NOW()` inside the insert"*.
T3 emits exactly an unparameterised `NOW()`.

**Both statements are right about what they were written to prevent, and the
sentinel is a narrower sanctioned exception the migration could not yet name.**

- What the migration forbids is a writer that **has** a decision time and passes
  `NOW()` instead, out of convenience. Its own reason names the divergence: *"a
  retried job, a long transaction"*. That writer records a write timestamp under
  a decision timestamp's name.
- What #1006 locked is a lane whose decision time **is** the transaction. In
  Postgres `NOW()` is `transaction_timestamp()` — transaction start, not
  statement time — so for `autonomy_suspended`, which decides inside the very
  transaction that stamps it, `NOW()` *is* the decision time. That is precisely
  why #1006 could decline a `suspension_event_id` column and take an exact
  equality join against `account_audit_log.created_at` instead: both take the
  same transaction's `NOW()`.
- The sentinel makes the exception **explicit and per-lane**. A lane must SAY
  `'transaction_time'`. It cannot arrive there by omission — that is the whole
  reason `occurredAt` is required rather than optional (§2.2).

**This was MEASURED against a live Postgres, not asserted from memory**, because
the whole #1006 equality join rests on it. One transaction, two statements
separated by `pg_sleep(0.25)`:

| Fact | Result |
|---|---|
| `NOW()` = `transaction_timestamp()`, statement 1 | **true** |
| `NOW()` = `transaction_timestamp()`, statement 2 | **true** |
| `NOW()` stable across both statements | **true** |
| `statement_timestamp()` moved between them | true |
| `clock_timestamp()` moved between them | true |
| `NOW()` carries six-digit microseconds | true — `…32.061377+00` |

So `NOW()` is the transaction's clock, not the statement's, and the ledger row
and the audit row written in one transaction are equal to the microsecond. The
last row is the same measurement that makes #520 fatal here: those six digits
are what a JS `Date` round trip destroys.

**Migration 116 is still not edited.** It is applied to production and
immutability-guarded, and the correction is not to its SQL. The record is
corrected where records are corrected: T7 carries one sentence into
`.claude/reference/migrations-log.md`'s **116** entry stating that the
`'transaction_time'` sentinel is the sanctioned exception, why it holds, and
that it is per-lane and never a default.

### 2.3 `REFUSAL_LEDGER_ENABLED` — default ON, checked inside the helper

`readFlagEnabledByDefault('REFUSAL_LEDGER_ENABLED')` from
`src/lib/config/flags.ts`. The `LLM_CIRCUIT_BREAKER_ENABLED` /
`DB_ADMISSION_ENABLED` shape: only the literal `'false'` disables.

Read **live per call**, never cached at module construction, so a mid-process
toggle takes effect at once (`circuit-breaker.ts`'s stated rule, and
`ci:process-env`'s).

When off: return before touching the deciding transaction, and emit **one**
`Sentry.captureMessage(..., { level: 'warning' })` per process. Once per
process, because a suspended fleet would otherwise emit one per decision. The
warning exists because **the ledger structurally cannot show its own gap** — an
absent row and a row that was never decided look identical at read time.

**The warning is emitted inside its own `try/catch` and the catch swallows.**
Plan review round 1, finding 9. If `captureMessage` throws, an unguarded
emission rejects before the helper returns, and a suspension fails **because the
ledger was turned off** — the exact opposite of what the kill switch promises.
The named precedent already does this (`circuit-breaker.ts` guards its own
capture), and it is the repo's standing rule: best-effort work must never poison
the path it observes.

**The latch is BOUNDED-RETRY, not set-before-emit.** Round 2, defect 3 killed
the first version of this rule. Setting the latch before the capture does stop
spam, but a *single transient* capture failure then suppresses the warning for
the entire process life — and this warning is the **only** evidence a ledger gap
exists. One network blip would buy permanent silence about the thing the ledger
structurally cannot show.

**A lifetime attempt ceiling was tried and rejected — round 3, defect 2.** The
first version of this rule bounded attempts at `MAX_WARN_ATTEMPTS = 3`. Three
consecutive transient failures then exhaust the counter forever, and if Sentry
recovers while the kill switch is still off, the warning is permanently
silent — reproducing the very failure the fix was written to remove, just
further along. A ceiling counted in *attempts* cannot distinguish "Sentry is
broken" from "Sentry was briefly broken".

#### The design above was ALSO wrong, and branch review round 1 found out why

**Adversarial finding A-02, `high` — and it is the strongest finding of this
whole run.** Rounds 1, 2 and 3 each argued about this five-line path. None of us
checked whether the SDK call underneath has the semantics the design assumed.

It does not. The reviewer read the installed `@sentry/node` 10.55.0:
`captureMessage` returns an event id **immediately** — it returns one even with
no client configured — buffers the event, sends the envelope asynchronously, and
**catches transport failures internally rather than throwing back**.

So every version of the rule above was built on a false premise:

- "capture succeeded" actually meant "capture was **queued**".
- The `try/catch` fires only on unusual *synchronous* SDK errors. It never sees
  the DSN/network delivery failure the whole cooldown was designed to survive.
- A real Sentry outage therefore latched the flag with the warning never
  delivered — the exact permanent silence rounds 2 and 3 were chasing, reached
  by a route none of them examined.

**The shipped design, which is honest about what each transport can promise:**

1. **The structured log line is the PRIMARY, durable signal.** It is emitted
   FIRST, in its own guard, OUTSIDE the Sentry `try`. No Sentry behaviour can
   lose it, and a throwing console cannot reject the helper.
2. **The rate limit is per DISABLED EPISODE, not per process.** The latch clears
   when the helper next observes the flag ENABLED, so a `false → true → false`
   sequence warns twice. Under the old rule a second outage in the same process
   was silent.
3. **Sentry is a best-effort SECOND transport**, still inside its own swallowing
   guard. **No `flush()` and no `await` on delivery** — that would put network
   latency on the deciding transaction's path, which is worse than the problem.
4. **The cooldown survives only for the synchronous-throw case** and is
   described as exactly that. Every claim that it retries *delivery* is deleted.

| Sentry behaviour | Result |
|---|---|
| delivers | one log line + one Sentry warning per disabled episode |
| queues, then fails in transport | one log line per disabled episode. **The log line is the signal** — Sentry never promised more, and the code no longer pretends it did |
| throws synchronously | one log line; the Sentry attempt retries after the cooldown |
| console throws too | the helper still returns cleanly; the suspension is unaffected |

Test 28 runs four consecutive capture failures against a settable clock, asserts
the durable line landed on every attempt, then recovery, then the episode reset.
Test 8 pins two warnings across a flag toggle. Test 10 covers the throwing
console.

**The lesson, and it outranks the bug:** three adversarial rounds reasoned very
carefully about a mechanism, and not one of them read the library. Verify the
primitive before designing on top of its assumed behaviour.

`REFUSAL_LEDGER_RETENTION_DAYS = 180` is a **code constant, not an env var**
(#996). No registry rows. It lives beside `AGENT_SPINE_RETENTION_DAYS` and
`BODY_RETENTION_DAYS` in `ArchivalPoller.ts`, which is where this repo keeps
retention windows.

---

## 3. What the helper does NOT do

**It does not catch CHECK violations.** `ON CONFLICT` covers duplicate keys.
The five CHECKs each abort the decision transaction, and that is accepted:

- Catching would hide a writer bug in the one place the ledger cannot report it.
- The ticket names the lever explicitly: *"This is the lever that is not a revert
  deploy"* — the kill switch, not a `try/catch`.
- The `.claude/CLAUDE.md` gotcha about best-effort work needing its own
  `try/catch` is about work **after** a primary side effect. The ledger write is
  **inside** the deciding transaction by design. It is not best-effort.

**Two `try/catch` decisions that look contradictory and are not.** The ledger
INSERT is NOT caught — it is part of the decision. The Sentry warning around it
IS caught (§2.3) — it is telemetry about the decision. The line is: *does this
statement carry the fact, or observe it?* Facts propagate; observations
swallow.

**Failure atomicity is a tested claim, not an assumed one.** Plan review round 1,
finding 8: every earlier planned test used valid ledger input, so a
catch-and-swallow helper — or one that opened its own connection instead of
using `tx` — passed all of them. Test 20 forces a rejection and asserts that the
policy row, the audit row and the notice outbox rows are all absent afterwards
and that the caller rejects.

**A rejection here does not reach Sentry by the same route from both callers,
and that asymmetry is why this slice touches a scheduler.** See T4b.

**It does not validate its input against C1–C5.** §1 states why.

**It does not read.** The read path is #1014.

---

## 4. Tasks — tracer bullets

**Twenty-eight** promised tests. Every title below is VERBATIM from
`.feature/intake.json`; the gate's `promised-tests` row matches on exact text.

### T1 — the eval task (runs ALONE; enforcement spot check)

**Blocking edges:** none. Blocks everything.

Author all twenty-eight tests as **failing** tests, in **seven** files, and
commit before any implementation task.

**NO `.todo`, NO `.skip`, NO `.fails`. This is a hard rule for this run, and it
reverses the plan's first draft.** Plan review round 1, finding 1 (the only
`high`): `scripts/verify-gate.sh`'s `promised-tests` row greps for the TITLE
and nothing else. A file full of `it.todo(...)` satisfies every promised title
while executing zero assertions, so the whole eval can be inert and the gate
still green. The repo has hit this before —
`src/lib/kpi/__tests__/fragments.test.ts` records a surviving todo as
review-blocking.

Nothing here needs a marker: every one of the seven subjects is buildable inside
this run. Test 26 is the mechanical guard.

**Test 26 cannot fully certify itself, and the plan says so rather than
pretending otherwise** (round 2, defect 1). If test 26 were written
`it.todo(...)`, its title still satisfies `promised-tests` and nothing runs. Two
things close that, and neither is test 26:

1. **Test 26's scan set includes its OWN file.** All seven files, not the other
   six. It asserts each file contains at least one active `it(`/`test(` call and
   zero `.todo`/`.skip`/`.fails` markers.
2. **The scan runs at MODULE SCOPE and throws, not inside the `it()` body.**
   This is what actually closes the self-certification hole, and it is the fix
   round 3's `high` forced. A `.todo` test never runs — but vitest still
   **loads the module**, so a module-scope check executes and fails collection
   whether or not test 26 itself is marked. The `it()` body then re-asserts the
   same computed result, so the failure is legible as a test rather than only as
   a collection error.

**A false claim was removed here, and it is worth recording why it was
tempting.** An earlier draft named `verify-gate.sh --review`'s `diff-coverage`
row as the independent guard. **That claim is false**, and round 3 graded it
`high` because a rejection rested on it. `scripts/diff-coverage.ts` excludes
`__tests__` and `.test.*` files and measures only ADDED PRODUCTION lines, so:

- at T1, before any production line exists, it passes with nothing to cover; and
- later, if tests 1–25 and 27–28 are active and cover the production lines, it
  passes **while test 26 alone is `.todo`** — which is the exact hole.

What `diff-coverage` really catches is a *wholly* inert eval, never a *single*
inert test. That is a useful backstop and it is not a guard on test 26. It is
described that way now.

**Still rejected: a new syntax-aware `ci:*` audit script.** A new entry must be
added to `package.json`, `ci.yml`'s lint job and `lefthook.yml` together, and
`src/__tests__/ci-audit-wiring.test.ts` fails when those three drift — a
permanent repo-wide obligation. The module-scope check above is independent of
whether test 26 runs, which is the property the audit script was wanted for, at
none of that cost. **This substitution is the one disagreement carried out of
plan review; see §5d.**

| File | Tests | New? |
|---|---|---|
| `src/lib/refusals/__tests__/vocabulary.test.ts` | 1–5 | new |
| `src/lib/refusals/__tests__/write.test.ts` | 6–11, 28 | new |
| `src/lib/refusals/__tests__/write.integration.test.ts` | 12–15 | new (live-DB) |
| `src/lib/auto-approval/__tests__/suspension.integration.test.ts` | 16–20 | **EXTEND** |
| `worker/background/schedulers/__tests__/AutonomyGovernorScheduler.test.ts` | 21, 27 | **EXTEND** |
| `worker/background/pollers/__tests__/ArchivalPoller.integration.test.ts` | 22–25 | **EXTEND** |
| `src/lib/refusals/__tests__/eval-completeness.test.ts` | 26 | new |

**Seven rows, seven distinct files, twenty-eight titles each claimed exactly
once.** No gaps, no duplicates, and no file listed twice — the row count and the
file count must agree, because round 2's defect 1 was exactly this drifting
apart.

**Three files are EXTENDED rather than created** — the repo's default is "no new
file". `suspension.integration.test.ts` (388 lines) already stands up the
accounts, businesses and policy rows tests 16–20 need, so a sibling
`suspension-refusal.integration.test.ts` would duplicate that fixture and split
one lane's coverage across two files.

**`eval-completeness.test.ts` is the one new test file that needs a
justification.** Test 26 asserts a property of the seven test files *as a set*,
including its own. Putting that assertion inside one of the other six would make
it partial; putting it at module scope in its own file is what makes it
self-inclusive. The natural home for a repo-wide meta test is
`src/__tests__/` (`ci-audit-wiring.test.ts`, `claude-md-shape.test.ts`), but
that path is outside `allowed_edit_surface` and widening to reach it would spend
the last amendment on a test file. This branch's own directory is the correct
second choice.

Test 6 is a **compile-time** assertion (`@ts-expect-error` against an omitted
`occurredAt`), not a runtime one — finding 3. Tests 12–15 and 16–20 are live-DB.

**Test 26 is the one test T1 turns green itself**, not a later task: it is true
the moment T1 obeys the no-marker rule, and it stays true only if every later
task does too. That is the point of it.

**Live-DB naming is load-bearing.** A live-DB suite is named
`*.integration.test.ts` so vitest's serialized `integration` project picks it up,
and **no live-DB file executes DDL at run time** — run-time DDL deadlocks across
concurrent suites (`ci:live-db-suites`, #573). Seed with `INSERT`, never with
`CREATE`/`ALTER`.

**The eval's own adversarial question — can it pass while the feature is wrong?**
Every test below exists because a specific wrong implementation would otherwise
pass. Round 1 found seven more and round 2 another two; all nine are in the list.

| Wrong implementation | Killed by |
|---|---|
| A clause that reads byte-for-byte right but infers no index | 11 **paired with** 12. Text alone is the fake-coverage pattern #1008's third red-team pass killed in `purge-verification.test.ts`; 12 runs it against a real database. |
| `occurredAt?: …` optional, defaulting to `NOW()` | **6** — a compile-time assertion. Every runtime test supplies the field, so only the type system can catch this (finding 3). |
| The flag read cached at module construction | **8** — false→true→false inside ONE process. Test 7 alone passes on a cached read (finding 4). |
| A throwing `captureMessage` aborting the disabled path | **10** (finding 9). |
| A fan-out writing one row per location | **16** — asserts *exactly one*, never "at least one". A `toBeGreaterThan` passes on the parent effort's actual defect. |
| A JS `Date` round trip breaking the #1006 join | **17** — both columns read `::text`. This is the only thing holding that join together. |
| A helper that catches the insert error, or opens its own connection | **20** — forced rejection, assert full rollback (finding 8). |
| A Governor-path failure that never pages | **21** (finding 2). |
| A sweep keyed on `created_at` instead of `occurred_at` | **23** — CROSSED clocks. Fixtures that age both timestamps together return the same answer under either clock, so test 22 alone cannot kill this (finding 5). |
| A `.todo`-filled eval that executes nothing | **26**, plus `diff-coverage` as the independent guard (finding 1, round-2 defect 1). |
| `REFUSAL_SOURCES` / `REFUSAL_CATEGORIES` drifting from the CHECK members | **1–3** — they parse migration 116 rather than restating it. |
| Telemetry inside the Governor `catch` breaking the containment it observes | **27** (round-2 defect 2). |
| One transient Sentry failure permanently silencing the ledger-gap warning | **28** (round-2 defect 3). |

**Not in this net, deliberately.** The `tenant-scope-allowlist.ts` `sqlSnippet`
drifting from the emitted SQL is finding 6, and it is **rejected as a test**:
`ci:tenant-scope` is in the gate's enumerated `ci:*` set and runs on every PR
forever, so it already owns that fact. A dedicated test would be a second owner
of one fact — the defect #1001 cites when it declines to CHECK the 22
`AutoApprovalBlockReason` members.

**Deliberately NOT re-tested.** #1008's
`src/lib/shared/__tests__/migration-116-refusal-events.integration.test.ts`
already proves the five CHECKs, C1's fall-through via `pg_get_constraintdef`,
both partial-index idempotency cases, and that a hand-written byte-for-byte
`ON CONFLICT` infers the index. #1009 proves the same properties **through the
helper**, which is the untested claim. Re-writing the schema tests would be
duplicate coverage the intake names as a non-goal.

**After T1 completes:** diff `git status --porcelain` against
`allowed_edit_surface`. An out-of-surface path means enforcement did not bind
for subagent tool calls — STOP, do not dispatch further tasks.

### T2 — `vocabulary.ts` (parallel with T5, T7)

**Blocking edges:** T1. **Blocks:** T3, T6.
**Turns green:** tests 1–5.

Harvest `git show feat/refusal-log:src/lib/refusals/vocabulary.ts` and correct
it. Ship ONLY:

- `REFUSAL_SOURCES` — **seven** lanes, in migration 116's order:
  `held_draft`, `auto_post_revoked`, `autonomy_suspended`, `ask_withheld`,
  `outreach_withheld`, `batch_halted`, `policy_gate_held`.
  The parked file has **six** — `policy_gate_held` joined in #1003.
- `REFUSAL_CATEGORIES` — **eight**, in migration 116's order:
  `unsafe_content`, `watchdog_unavailable`, `below_our_bar`, `no_permission`,
  `wrong_moment`, `autonomy_paused`, `missing_information`,
  `owner_review_required`.
  The parked file has **seven** — `owner_review_required` was coined in #998.
- `REFUSAL_SUBJECT_TYPES` — the four: `response`, `solicitation_ask`,
  `solicitation_outreach`, `solicitation_batch`. Not in the parked file at all.
- `REFUSAL_VOCABULARY_VERSION = 'refusal_vocab_2026-08-30.1'` — a frozen
  literal on the `RESTRAINT_POLICY_VERSION` shape
  (`<name>_<date>.<rev>`), dated the day map #994 closed. Never derived.
- `AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES` — carried unchanged from the parked
  file; all four `AutonomySuspensionTrigger` members map to `autonomy_paused`.
  `satisfies Record<AutonomySuspensionTrigger, RefusalCategory>`.

**Do NOT ship** (intake non-goals): `RENDER_WITHHOLD_REASONS` (deleted — it
existed only for `read.ts`'s timestamp partition and #1002 killed `read.ts`),
the other five lane maps, `refusalCategoryFor`, `UnknownRefusalCodeError`,
`REFUSAL_CATEGORY_META`, `BATCH_HALT_REASONS`, `OUTREACH_WITHHELD_REASONS`,
`OUTREACH_NON_REFUSAL_*`.

**Import discipline, carried from the parked header and still binding:** every
import in this file is `import type`. A `'use client'` component will need this
module's labels at #1014, and one value import whose graph reaches a `node:`
builtin drags it into the browser bundle silently — invariant #1's ESLint ban
covers `src/app/**` and `src/components/**`, not this file.

**Tests 1–3 parse `supabase/migrations/116_refusal_events.sql`** and compare
against the arrays, on the parked `vocabulary.test.ts`'s precedent (which parses
migration 111 for the same reason). This is what keeps the TypeScript unions
from becoming a second authority that drifts.

### T3 — `write.ts`, the helper and its kill switch

**Blocking edges:** T2. **Blocks:** T4, T6.
**Turns green:** tests 6–15 and 28.

Precedent to follow, named: `src/lib/audit/log.ts`.

Column order follows migration 116 exactly: `id, account_id, business_id,
refusal_source, refusal_code, all_refusal_codes, refusal_category,
vocabulary_version, subject_type, subject_id, occurred_at`. `created_at` is
`DEFAULT NOW()` and is not written.

- `id`: `${uuidv7()}::uuid` — the writer mints it inside the deciding
  transaction (the column has no DB default, deliberately).
- `vocabulary_version`: `REFUSAL_VOCABULARY_VERSION`, never a parameter.
- `all_refusal_codes`: a `TEXT[]`, or SQL `NULL`. NULL and `'{}'` are different
  facts (#1001) — NULL means "this lane has no code axis".
- `occurred_at`: `NOW()` unparameterised for `'transaction_time'`; a bound
  `${date}::timestamptz` for a `Date`. Two SQL fragments, one statement.

Kill switch and warn-once latch per §2.3, including its guarded emission and its
**cooldown retry** — the latch is set on a SUCCESSFUL capture, never before the
attempt, and a failure sets `nextAttemptAt` rather than consuming a lifetime
budget. Both are module-level; export a test-only reset that clears both, on
`circuit-breaker.ts`'s `reset()` precedent.

The flag is read **inside the function body on every call**, never at module
scope. A `const enabled = readFlagEnabledByDefault(...)` at module level passes
test 7 and fails test 8.

`occurredAt` is **required** in `WriteRefusalEventInput` — no `?`, no default.
Test 6 asserts this at compile time.

**Invariant #15:** takes `tx` as an explicit parameter, never imports
`@/lib/db/server`.

### T4 — the first write site

**Blocking edges:** T3. **Blocks:** T4b.
**Turns green:** tests 16–20.

In `suspendAccountAutonomy` (`src/lib/auto-approval/suspension.ts`), **after**
the `if (!policy) return { newlySuspended: false };` guard and inside the same
transaction:

```ts
await writeRefusalEvent(tx, {
  accountId: input.accountId,
  businessId: null,              // account-wide — CHECK C3
  refusalSource: 'autonomy_suspended',
  refusalCode: input.trigger,    // verbatim, never normalised
  allRefusalCodes: null,         // this lane has no code axis — CHECK C5
  refusalCategory: AUTONOMY_SUSPENDED_REFUSAL_CATEGORIES[input.trigger],
  subjectType: null,             // this lane points at nothing — CHECK C1
  subjectId: null,               // CHECK C2
  occurredAt: 'transaction_time',
});
```

**Placement is load-bearing.** After the `!policy` guard, because an
already-suspended account made no decision and a Refusal records a decision
(test 19). Before or after `writeAccountAuditLog` is immaterial to the
timestamp — both take the transaction's `NOW()` — but it goes **after**, so the
audit row the join targets exists first.

`business_id` is NULL and the read is **once per account, never once per
location**. This is the parent effort's defect; test 16 is its regression test,
not a comment.

`refusalCode` is the trigger verbatim. C4 requires a non-NULL code for every
lane except `held_draft`.

### T4b — the Governor cycle's Sentry sink (SURFACE AMENDMENT 1 of 2)

**Blocking edges:** T4. **Turns green:** tests 21 and 27.

**Why this task exists.** Plan review round 1, finding 2. `suspendAccountAutonomy`
has two production callers and they reach Sentry by different routes:

| Caller | Kind | On failure |
|---|---|---|
| `JudgeWorker` | BullMQ worker | `attachJobFailureSink` raises a Sentry issue on the terminal attempt — **covered** |
| `AutonomyGovernorScheduler` | guarded poll, **not** a BullMQ worker | its per-candidate `catch` emitted `logger.error` alone — **not covered** |

Before this slice, that gap was latent. This slice makes a ledger CHECK
violation a new way to reach it, and the failure mode is bad: the transaction
rolls back, the account **stays un-suspended**, the cycle advances its cursor,
and the same thing happens silently every fifteen minutes. The intake's
`observability` field claimed coverage that did not exist, so either the code or
the claim had to change.

**Owner decision, 2026-08-30:** change the code. Recorded mechanically as
surface amendment 1 of 2 (`feature-state.sh incr-amendment`), because
`worker/background/schedulers/` sits outside any tree the original surface
covered.

**The change is additive and narrow.** Inside the EXISTING `catch` in
`runAutonomyGovernorCycle`, beside the existing `logger.error`, add a
`Sentry.captureException` carrying the account id and the error class. Follow
`worker/job-failure-sink.ts`'s issue shape.

**The capture gets its OWN nested `try/catch` that swallows.** Round 2, defect
2 — and it is my own §2.3 lesson, not applied to the code that §2.3's fix
created. This `catch` block exists to CONTAIN a failure to one candidate. An
unguarded `captureException` that throws would propagate out of the containment
handler, abort `runAutonomyGovernorCycle` mid-loop, and skip every remaining
candidate — the precise outcome the containment was written to prevent, now
caused by the telemetry added to observe it. `logger.error` runs FIRST, so the
structured line survives even when Sentry does not.

Test 27 pins it: a throwing Sentry mock, and the cycle still reaches the next
candidate.

**Do not change the containment.** The `catch`, the pre-evaluation cursor
advance and the loop stay exactly as they are — one poison account must still
not starve the batch, and the comment saying so stays. Do not widen the logged
error text either: DB error text can echo bound values, which is why the
existing line logs the error CLASS only.

**This fixes the gap for every failure already swallowed there**, not only for
the ledger. That is a side effect of the narrow fix, not a scope expansion.

### T5 — the `ArchivalPoller` arm (parallel with T2, T7)

**Blocking edges:** T1. **Blocks:** T6.
**Turns green:** tests 22–25.

1. Export `REFUSAL_LEDGER_RETENTION_DAYS = 180` beside its two siblings, with a
   comment stating it matches `AGENT_SPINE_RETENTION_DAYS` so one number governs
   the whole agentic domain (#996), and that 180 is **shorter** than five of the
   six source tables — an accepted trade, not an oversight.
2. Add arm 11 after arm 10, on arm 7's shape:

```sql
WITH candidates AS (
  SELECT id FROM refusal_events
  WHERE occurred_at < NOW() - make_interval(days => ${REFUSAL_LEDGER_RETENTION_DAYS})
  ORDER BY occurred_at, id
  LIMIT 5000
  FOR UPDATE SKIP LOCKED
),
deleted AS (
  DELETE FROM refusal_events WHERE id IN (SELECT id FROM candidates)
  RETURNING id
)
SELECT COUNT(*)::text AS count FROM deleted
```

`ORDER BY occurred_at, id` matches `idx_refusal_events_archival`
`(occurred_at, id)`. Without a matching order the sweep is unbounded — arms 9
and 10 state the rule.

**`occurred_at` and nothing else.** `created_at` is the insert stamp and is
explicitly not a retention candidate (its own column comment says so).

**Test 23 seeds CROSSED clocks, and this is not optional.** Plan review round 1,
finding 5: a plain old-row/fresh-row fixture pair ages both timestamps together,
so it returns the identical answer under an `occurred_at` sweep and a
`created_at` sweep — test 22 alone cannot kill the wrong clock. Test 23 seeds
two rows whose clocks disagree:

| Row | `occurred_at` | `created_at` | Must |
|---|---|---|---|
| A | 200 days ago | today | be **deleted** |
| B | today | 200 days ago | **survive** |

`created_at` is `DEFAULT NOW()`, so the fixture writes it explicitly. This is an
`INSERT` with explicit columns — never DDL, per `ci:live-db-suites`.

3. Wire the count into `refusalEventsCount`, `totalArchived`, the `Archived`
   log object (`refusal_events:`) and the `saturated` list.
4. Add the `scripts/ci/tenant-scope-allowlist.ts` entry, copying the shape of
   the existing `solicitation_outreach` retention entries, with reason:
   *"Global archival poller enforces the 180-day Refusal ledger retention
   independent of tenant request scope; a retention sweep is deliberately
   cross-tenant."* **The `sqlSnippet` must match the emitted SQL exactly** or
   `ci:tenant-scope` fails. That audit is in the gate's enumerated `ci:*` set
   and is the single CI-enforced owner of this coupling — round 1's finding 6
   asked for a dedicated test as well, and it is rejected for that reason
   (§4 T1, "Not in this net").

**The arm shares the ten existing arms' single `try/catch`** — that is why this
arm could not ride slice 1, and why #1009 is gated on 116's PROMOTION rather
than its merge (#1004's second correction to #1001).

### T6 — registries and the code map

**Blocking edges:** T3, T5.

1. `docs/eservices-variables.md` — one row for `REFUSAL_LEDGER_ENABLED`, on the
   `DB_ADMISSION_ENABLED` row's shape. Without it `ci:env-registry` fails.
2. `.claude/reference/env-vars.md` — one entry on the
   `LLM_CIRCUIT_BREAKER_ENABLED` entry's shape: default ON, only literal
   `'false'` disables, what off means, server-only with no `NEXT_PUBLIC`
   companion, read live per call. **The flag needs BOTH rows.**
3. `docs/directory.md` — a new `### \`refusals/\`` section under `## \`src/lib/\``
   with one row per production file (`vocabulary.ts`, `write.ts`).
   `ci:directory-map` fails on a production file under `src/lib/` with no row.
4. `CONTEXT.md` — no new term. The four Refusal terms are already LOCKED and
   already carry the seven-lane and eight-category corrections. Touch it only
   if implementation coins something, which it should not.

**No `.env.example` row.** `LLM_CIRCUIT_BREAKER_ENABLED` has none either — a
default-ON optional flag is absent, not blank.

### T7 — the D16 sweep (parallel with T2, T5)

**Blocking edges:** T1. Docs only; no code dependency.

Execute §0's table. Five living documents get the settlement; one closing line
is appended to #1008's D16 section; six artifacts are left untouched.

**Second sentence, into `.claude/reference/migrations-log.md`'s 116 entry only**
(§2.2b, round 1 finding 7): the `'transaction_time'` sentinel is the sanctioned
exception to the migration's *"no writer may pass `NOW()`"* rule, it holds
because `NOW()` is `transaction_timestamp()` and this lane decides inside that
transaction, and it is per-lane and never a default. The migration file itself
is not edited.

**Method, which is D16's own lesson:** grep every artifact for the FACT, not for
a cited line. Cite SYMBOLS, never line numbers — D14 proved a line citation into
a file the same change edits cannot be correct at both ends.

**`merge-ledger-audit` will fire.** Editing `.claude/reference/*` governance
files requires an `arch-review-log.md` entry in the same change. T7 writes that
entry, which is also one of the five sweep targets.

---

## 5. Execution waves

| Wave | Tasks | Why |
|---|---|---|
| 1 | **T1** alone | First task always runs alone — proves the guard binds for subagent tool calls |
| 2 | **T2 ‖ T5 ‖ T7** | No blocking edges between them; disjoint file sets (`src/lib/refusals/vocabulary*`, `worker/…/ArchivalPoller*`+`scripts/ci/*`, `docs/*`+`.claude/reference/*`) |
| 3 | **T3** | Needs T2's types |
| 4 | **T4** | Needs T3's helper |
| 5 | **T4b ‖ T6** | T4b needs T4's call site; T6 needs T3's flag name and T5's constant to exist before it documents them. Disjoint file sets. |

Any surface violation by a wave-2 task stops the whole fan-out.

---

## 5b. Plan review round 1 — triage

Full report: `docs/reviews/feat-1009-refusal-ledger-write-path/plan-review-r1.md`.
Reviewer: `codex exec`, read-only. The codex thread id is recorded in that
report's header and in the handoff doc, not here — the plan pre-validator reads
a bare UUID as a commit SHA and reports it stale forever.
**VERDICT: REVISE.** Ten findings, one `high`, eight `medium`, one `low`, zero
low-confidence. Nine accepted, one rejected.

| # | Sev | Verdict | Where it landed |
|---|---|---|---|
| 1 | high | ACCEPT | §4 T1 — `.todo`/`.skip`/`.fails` banned; test 26 is the guard |
| 2 | med | ACCEPT (owner-approved amendment) | §4 T4b — new task; intake `observability` corrected |
| 3 | med | ACCEPT | test 6 — compile-time; §4 T3 |
| 4 | med | ACCEPT | test 8 — false→true→false; §4 T3 |
| 5 | med | ACCEPT | test 23 — crossed clocks; §4 T5 |
| 6 | med | **REJECT** | §4 T1 "Not in this net" — `ci:tenant-scope` already owns it |
| 7 | med | ACCEPT | §2.2b + §4 T7's second sentence |
| 8 | med | ACCEPT | test 20 — forced rejection; §3 |
| 9 | med | ACCEPT | §2.3 — guarded emission; test 10 |
| 10 | low | ACCEPT | §0 — two DO NOT TOUCH rows added |

**What the round independently VERIFIED, and this matters more than the
findings.** The reviewer introspected both Supabase projects live and confirmed
`refusal_events`, its five named constraints, `idx_refusal_events_archival` and
`refusal_events_subject_uniq` with the exact predicate exist in **production and
staging** — so this slice's blocking edge is genuinely clear. It confirmed
migration 034's `DEFAULT NOW()`, every named precedent symbol at HEAD, and that
#1008's shipped suite really does cover the five CHECKs, C1's fall-through and
both idempotency cases — which is what licenses this plan NOT to re-write them.
It also confirmed D16's settlement is supported by #1004 and #1009 §5.

**Why #6 is rejected and not deferred.** `ci:tenant-scope` runs in the gate's
enumerated `ci:*` set and on every PR forever. A dedicated test would make two
owners of one fact. #1001 declines to CHECK the 22 `AutoApprovalBlockReason`
members for exactly this reason: a second authority drifts.

---

## 5c. Plan review round 2 — verification-only, and it found four defects the
## round-1 FIXES introduced

Full report:
`docs/reviews/feat-1009-refusal-ledger-write-path/plan-review-r2.md`.
**VERDICT: REVISE.** Under review: commit `eaa0545d`.

**Verification of round 1: eight ADDRESSED, two PARTIAL, and the rejection of
#6 was confirmed SOUND** — the reviewer checked that `ci:tenant-scope`
normalizes and exact-matches allowlist snippets and rejects stale entries, which
is the reason the rejection was made. It also independently confirmed against
the PostgreSQL documentation that `NOW()` is transaction-start time and equal to
`transaction_timestamp()` — the same fact §2.2b measured.

**The four fix-introduced defects, all accepted:**

| # | Sev | The defect my fix created | Where the correction landed |
|---|---|---|---|
| 1 | med | Finding 1's fix said "six files" over a seven-row map, and test 26 can certify itself with `it.todo` | §4 T1 — seven files; test 26 scans its OWN file. The first correction also named `diff-coverage` as the independent guard, which round 3 disproved; see §5d |
| 2 | med | Finding 2's fix put an UNGUARDED `captureException` inside the very `catch` whose job is containment — a throwing Sentry would abort the cycle and skip every later candidate | §4 T4b — nested swallowing guard, `logger.error` first; **test 27** |
| 3 | med | Finding 9's fix set the warn-once latch BEFORE the capture, so one transient failure permanently silences the only evidence a ledger gap exists | §2.3 — bounded retry, latch on SUCCESS, `MAX_WARN_ATTEMPTS = 3`; **test 28** |
| 4 | low | D3 said "six" wrong implementations over a seven-row table and omitted finding 2 | deviations D3 |

**Defects 2 and 3 are the same mistake, twice: I applied a lesson to the code
that prompted it and not to the code my fix wrote.** Round 1 finding 9 says
telemetry must never poison the path it observes. Fix 2 then added unguarded
telemetry inside a containment handler, and fix 9's own guard bought permanent
silence in exchange for safety. This is #1008's D15 — *a fix is a sweep, never
an edit* — recurring in code rather than prose. Queued for step 8 promotion.

`tests_to_add` 26 → 28.

---

## 5d. Plan review round 3 — the last round, and the one open disagreement

Full report:
`docs/reviews/feat-1009-refusal-ledger-write-path/plan-review-r3.md`.
**VERDICT: REVISE.** Under review: commit `5dbe8efa`. Round 3 is the protocol's
cap; there is no round 4.

**Verification of round 2: two ADDRESSED, two PARTIAL.** Three new defects, all
accepted.

| # | Sev | The defect | Correction |
|---|---|---|---|
| 1 | **high** | The `diff-coverage` claim justifying a rejection is **false** | §4 T1 — claim removed and replaced with what is true; the guard is now a MODULE-SCOPE check |
| 2 | med | `MAX_WARN_ATTEMPTS = 3` is a LIFETIME ceiling — throw ×3 then recover is permanently silent | §2.3 — cooldown, not a ceiling |
| 3 | low | The seven-row map carried two stacked Markdown headers | §4 T1 — fixed |

**Defect 1 is the strongest finding of all three rounds, and it is a finding
against my reasoning rather than my design.** I rejected a proposed CI audit on
the ground that `diff-coverage` already caught an inert eval. It does not:
`scripts/diff-coverage.ts` excludes `__tests__` and `.test.*` and measures only
added PRODUCTION lines. So it passes at T1 with nothing to cover, and passes
later from the other twenty-seven tests' coverage while test 26 alone is
`.todo`. The claim was plausible, load-bearing, and wrong — which is why the
round graded it `high` rather than `medium`.

**Defect 2 is the third consecutive round to find the same class of error in
this one warning path**, and that is worth naming. Round 1: unguarded emission
can abort the decision. Round 2: latch-before-emit buys permanent silence.
Round 3: an attempt ceiling buys permanent silence three failures later. Each
fix was correct about the failure it addressed and introduced the next one. The
cooldown ends it because it is counted in **time**, and time always recovers,
whereas a lifetime counter cannot tell a broken Sentry from a briefly broken
one.

### The one disagreement carried to the owner

Round 3's proposed correction for defect 1 is *"add an independent syntax-aware
gate outside the seven-file test set"* — a new `ci:*` audit script.

**Reviewer's position.** Only a guard outside the test files can prove the test
files are active. Test 26 living among the files it checks is inherently
circular.

**My position, and what the plan implements.** A **module-scope** check in test
26's own file has the property the audit script was wanted for, at none of its
cost. A `.todo` test does not run, but vitest still **loads the module** — so a
module-scope check executes and fails collection whether or not test 26 itself
is marked. It is therefore already independent of test 26 running. Against
that, a new `ci:*` entry must be added to `package.json`, `ci.yml`'s lint job
and `lefthook.yml` together, with `src/__tests__/ci-audit-wiring.test.ts`
failing whenever those three drift — a permanent repo-wide obligation bought for
one branch's eval hygiene.

**OWNER DECISION, 2026-08-30: the module-scope check.** Both positions were put
to the owner with their costs. No `ci:*` audit script is added. Per the round-3
stop rule this call substitutes for `APPROVED`, and **the plan is LOCKED**.

The general problem the reviewer identified is real and outlives this branch —
`promised-tests` greps titles for EVERY `/feature` run, so any run's eval can be
satisfied by `it.todo`. It is recorded as a step-8 promotion item rather than
built here (deviations D5).

---

## 6. Not in this PR

- The remaining **ten** write sites — #1010, #1011, #1012, #1013.
- The `policy_gate_held` lane's 22-member `AutoApprovalBlockReason` map, its
  precedence order and its veto set — #1013.
- The five lane maps this slice does not write, `refusalCategoryFor`,
  `UnknownRefusalCodeError` and `REFUSAL_CATEGORY_META`.
- The **Restraint tab** and every read over `refusal_events` — #1014.
- Any migration. 116 is applied to staging and production; 117 is not created.
- Any backfill — #1002 ruled none, ever.

---

## 7. Ship order (RISK = high)

1. CI green on the draft PR.
2. Land on `staging`; the full stack auto-deploys.
3. Smoke the touched path on staging: trigger an autonomy suspension, confirm
   exactly one `refusal_events` row with `business_id IS NULL`, and confirm its
   `occurred_at` equals the `account_audit_log` row's `created_at` when both are
   read `::text`.
4. Flip `REFUSAL_LEDGER_ENABLED=false` on staging, suspend again, confirm the
   suspension still lands, no ledger row appears and one Sentry warning fires.
   Flip it back. Invoke the `flag-flip` skill for both.
5. Open the PR to `main`, confirm every check green, then PAUSE for owner merge
   approval.
6. **No migration applies at promotion.** 116 is already in both projects.
7. After merge: `git pull --ff-only`, re-sync `staging` per
   `deployment-guide.md` §"Re-sync staging", run `feature-cleanup.sh`.

## 8. Rollback

Per the intake: flag flip first (no deploy), PR revert second, and **no
migration 117**. Rows already written are **NOT** deleted by a rollback, and the
PR revert **removes the very sweep that would have retired them** — the
`ArchivalPoller`'s `refusal_events` arm reverts with the PR, so surviving rows
have no writer, no reader and no pruner until a later slice restores the arm.
That is acceptable (deny-all RLS; UUIDs, enum strings and timestamps only; the
offboarding purge is unaffected; and #1002 forbids any backfill that would
re-create them) but it **must not be described as self-cleaning**, which an
earlier draft of this section wrongly did. If retiring the rows matters, delete
them explicitly at revert time — do not wait for a sweep the revert just took
away.
