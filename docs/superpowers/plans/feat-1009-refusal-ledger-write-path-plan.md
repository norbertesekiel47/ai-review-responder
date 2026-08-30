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
`'transaction_time'` sentinel resolution, the flag read, the once-per-process
Sentry latch.

**Deletion test.** Delete this module and all five reappear at eleven call
sites. That is exactly #1001's stated reason for mandating one helper.

**No seam, deliberately.** One adapter means a hypothetical seam. There is no
`RefusalLedger` interface, no `getRefusalLedger()` factory, no injected writer.
`ReviewPublisher` earned its factory because a second adapter (direct Google
Business Profile) is planned; nothing varies here. `writeAccountAuditLog` — the
precedent this helper is modelled on and the single audit writer for the whole
codebase — is a bare exported function for the same reason.

**Rejected: a seven-arm discriminated union on `refusalSource`.** It would make
C1–C5 unrepresentable in TypeScript, which is attractive. It is rejected because
six of the seven arms would have no caller in this slice, and because #1001
already decided where those invariants live: *"the five CHECKs each name a bug
rather than a preference"*. The database owns them. A TypeScript copy would be
a second authority over the same five facts — the precise defect #1001 cites
when it declines to CHECK the 22 `AutoApprovalBlockReason` members. The lever
against a writer bug is the kill switch, which the ticket says in those words.

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

**It does not validate its input against C1–C5.** §1 states why.

**It does not read.** The read path is #1014.

---

## 4. Tasks — tracer bullets

Nineteen promised tests. Every title below is VERBATIM from
`.feature/intake.json`; the gate's `promised-tests` row matches on exact text.

### T1 — the eval task (runs ALONE; enforcement spot check)

**Blocking edges:** none. Blocks everything.

Author all nineteen tests as **failing** tests, in five files, and commit before
any implementation task. Slices not yet buildable use `.todo`.

| File | Tests |
|---|---|
| `src/lib/refusals/__tests__/vocabulary.test.ts` | 1–5 |
| `src/lib/refusals/__tests__/write.test.ts` | 6–8 |
| `src/lib/refusals/__tests__/write.integration.test.ts` | 9–12 |
| `src/lib/auto-approval/__tests__/suspension-refusal.integration.test.ts` | 13–16 |
| `worker/background/pollers/__tests__/ArchivalPoller.integration.test.ts` (extend) | 17–19 |

**Live-DB naming is load-bearing.** A live-DB suite is named
`*.integration.test.ts` so vitest's serialized `integration` project picks it up,
and **no live-DB file executes DDL at run time** — run-time DDL deadlocks across
concurrent suites (`ci:live-db-suites`, #573). Seed with `INSERT`, never with
`CREATE`/`ALTER`.

**The eval's own adversarial question — can it pass while the feature is wrong?**
Three tests exist to close specific holes:

- Test 8 asserts SQL **text**. On its own that is the fake-coverage pattern
  #1008's third red-team pass killed in `purge-verification.test.ts`. It is
  paired with test 9, which proves against a **real database** that the helper's
  own clause infers `refusal_events_subject_uniq`. Text alone would pass with a
  clause that reads right and infers nothing.
- Test 14 is the only thing holding the #1006 suspension join together. It fails
  the day the site switches to a JS `Date`. Both columns are read `::text`.
- Test 13 asserts **one row per account**, not "at least one". The parent
  effort's defect was a fan-out that multiplied by location count; a
  `toBeGreaterThan` assertion would pass on the bug.

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
**Turns green:** tests 6–12.

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

Kill switch and warn-once latch per §2.3. The latch is a module-level boolean;
export a test-only reset on `circuit-breaker.ts`'s `reset()` precedent.

**Invariant #15:** takes `tx` as an explicit parameter, never imports
`@/lib/db/server`.

### T4 — the first write site

**Blocking edges:** T3.
**Turns green:** tests 13–16.

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
(test 16). Before or after `writeAccountAuditLog` is immaterial to the
timestamp — both take the transaction's `NOW()` — but it goes **after**, so the
audit row the join targets exists first.

`business_id` is NULL and the read is **once per account, never once per
location**. This is the parent effort's defect; test 13 is its regression test,
not a comment.

`refusalCode` is the trigger verbatim. C4 requires a non-NULL code for every
lane except `held_draft`.

### T5 — the `ArchivalPoller` arm (parallel with T2, T7)

**Blocking edges:** T1. **Blocks:** T6.
**Turns green:** tests 17–19.

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

3. Wire the count into `refusalEventsCount`, `totalArchived`, the `Archived`
   log object (`refusal_events:`) and the `saturated` list.
4. Add the `scripts/ci/tenant-scope-allowlist.ts` entry, copying the shape of
   the existing `solicitation_outreach` retention entries, with reason:
   *"Global archival poller enforces the 180-day Refusal ledger retention
   independent of tenant request scope; a retention sweep is deliberately
   cross-tenant."* **The `sqlSnippet` must match the emitted SQL exactly** or
   `ci:tenant-scope` fails.

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
is appended to #1008's D16 section; four artifacts are left untouched.

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
| 5 | **T6** | Needs T3's flag name and T5's constant to exist before it documents them |

Any surface violation by a wave-2 task stops the whole fan-out.

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
migration 117**. Rows already written are retired by the 180-day sweep; #1002
forbids any backfill that would re-create them.
