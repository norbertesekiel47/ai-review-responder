# Refusal ledger — quality, performance & operational-safety audit

**Scope:** `supabase/migrations/116_refusal_events.sql`, `src/lib/refusals/{write,read,vocabulary}.ts`,
the eight write sites, `src/app/api/dashboard/refusals/route.ts`, the ArchivalPoller retention arm.
**Repo/HEAD:** `RepWorth/ai-review-responder`, `main`, `f797d250`.
**Axis:** quality / performance / operational safety. Spec conformance is a separate concurrent audit and
is *not* covered here — locked decisions are assumed followed; this report judges how well.

Query plans in this report are real `EXPLAIN` output from the local test container at migrations head
(`test_ws4`, port 5499), captured read-only. Row estimates are meaningless there (empty tables); the
**plan shapes** — which index, what is an Index Cond vs a Filter, where a Sort appears — are not, and
those are what is cited.

---

## Verdict

The ledger is a genuinely well-built piece of work. The single-writer discipline holds repo-wide (no
`INSERT INTO refusal_events` exists outside `write.ts`), invariant #15 is clean at all eight sites, the
kill switch returns before touching the transaction so no half-written state is reachable, the retention
sweep is correctly built against the index that was shipped for it, and the read path is strictly
sequential — the `ci:pool-fanout` *spirit* is honoured in `read.ts` even though the audit does not scan
that directory.

Three things are wrong enough to act on:

1. **The documented kill switch does not cover the hot path's most likely failure.**
   `resolvePolicyGateRefusal` throws *before* the flag is read, and its own docblock claims the opposite.
2. **One write site loops the single-row helper N times** — the exact failure the batch arm was written
   to prevent, inside a transaction holding two locks.
3. **The read's `total` query has no bound and no covering index**, and the archived-period query has no
   usable index at all — `EXPLAIN` confirms an unbounded backward scan of the account's whole audit log.

---

## 1. The hot path — `worker/jobs/response-generation/persist.ts`

### 1.1 What the ledger actually costs the persist transaction

The persist transaction (`persist.ts:116`) holds:

- `reviews` row `FOR UPDATE` as its first statement (`acquirePersistLocks`, `persist.ts:387-391`);
- for auto-approval candidates, the `businesses` row `FOR UPDATE` (`persist.ts:422-424`) — the
  serialization point for the daily cap, so **every concurrent persist for the same location queues
  behind it** — plus the tier entitlement lock (`persist.ts:427`).

Into that it adds ~11 top-level statements. The ledger contributes **at most one** more:

| Lane | Site | Guard | Frequency |
|---|---|---|---|
| `held_draft` | `persist.ts:877` | `flaggedHigh` (`:848`) | rare — high-severity moderation only |
| `policy_gate_held` | `persist.ts:750` | four early returns (`:743-748`) | common once `AUTO_APPROVAL_ENABLED` is on |

The two are mutually exclusive (`persist.ts:743` — `if (held) return;`), so the worst case is **+1 round
trip**, not +2. Both are the last statement of their helper, after the state change they record. That is
roughly a 9% increase in the number of round trips inside the transaction, and therefore in the hold time
of the `businesses` row lock for auto-approval candidates. **This is proportionate and correctly placed.**
There is no cheaper shape available that preserves the single-writer rule, and the insert itself is a
plain single-row `INSERT` against a UUIDv7 primary key with one partial-unique probe — no scan, no extra
lock, no FK contention beyond the two `accounts`/`businesses` `FOR KEY SHARE` grabs that the transaction
already holds via the `responses` insert.

**No finding on latency or lock time.** The design is sound.

### 1.2 The failure mode is NOT contained — and that is deliberate and documented

`write.ts` does not catch its insert (`write.ts:29-45`), and neither do seven of the eight call sites.
A migration-116 CHECK violation aborts the deciding transaction. The rationale is sound and is stated at
length: a catch would not save the transaction anyway (postgres.js records the `uncaughtError` per query
inside `scope()` and rethrows after the callback returns), so the only thing a catch buys is *hiding* the
writer bug from the helper's own caller.

`persist.ts` alone adds `withLedgerAttribution` (`persist.ts:788-807`), which captures to Sentry with
`subsystem: 'refusal_ledger'` and **rethrows unchanged**. Control flow is unaffected. That is the right
call and the right shape.

Two problems sit on top of it.

### FINDING H1 — the kill switch does not protect the hot path from the throw its own doc names

`worker/jobs/response-generation/persist.ts:747`

```ts
const refusal = resolvePolicyGateRefusal(autoDecision.blockReasons);   // :747  ← may THROW
if (!refusal) return;                                                   // :748
await withLedgerAttribution('policy_gate_held', responseId, () => writeRefusalEvent(tx, { … }));  // :750
```

`resolvePolicyGateRefusal` throws in two places — `unmapped_auto_approval_block_reason`
(`vocabulary.ts:645`) and `unranked_auto_approval_block_reason` (`vocabulary.ts:656`).
`REFUSAL_LEDGER_ENABLED` is read **inside `writeRefusalEvent`** (`write.ts:369`), which line 747 never
reaches. So:

- Setting `REFUSAL_LEDGER_ENABLED=false` **does not stop the throw** and **does not stop the persist from
  aborting**. The lever is inoperative for this class.
- `vocabulary.ts:619-621` states the opposite in so many words:
  > *"IT MAY THROW INSIDE A DECIDING TRANSACTION, and that is deliberate on the same terms as `write.ts`'s
  > uncaught INSERT: a writer bug aborts the decision, and the lever against it is
  > `REFUSAL_LEDGER_ENABLED`, not a silent default."*

  That sentence is false as written.
- The throw is also **outside** `withLedgerAttribution`, whose entire reason for existing
  (`persist.ts:769-777`) is that an operator could not otherwise find the lever. A resolver throw
  therefore surfaces as `attachJobFailureSink`'s generic `subsystem=worker_job` issue — precisely the
  blind spot that helper was built to close, on the one code path most likely to hit it.

**Concrete failure:** a 23rd `AutoApprovalBlockReason` is added and mapped in
`POLICY_GATE_HELD_REFUSAL_CATEGORIES` but omitted from `AUTO_APPROVAL_BLOCK_PRECEDENCE` (see H2 — this
compiles). Every auto-candidate draft that produces that reason aborts its persist. `generate_response`
burns its attempts, the operator finds a generic worker-job Sentry issue with no ledger attribution,
flips `REFUSAL_LEDGER_ENABLED=false` on the strength of `vocabulary.ts:621` — and **nothing changes.**

**Fix:** move the resolver call inside `withLedgerAttribution`, and either read the flag before it or
have `recordPolicyGateRefusal` return early when the flag is off. Correct `vocabulary.ts:619-621` either
way.

### FINDING H2 — `AUTO_APPROVAL_BLOCK_PRECEDENCE` has no compile-time totality guard

`src/lib/refusals/vocabulary.ts:555-577`

```ts
export const AUTO_APPROVAL_BLOCK_PRECEDENCE = [ … 15 members … ]
  as const satisfies readonly AutoApprovalBlockReason[];
```

`satisfies readonly AutoApprovalBlockReason[]` proves every **member is valid**. It does not prove the
list is **total over the non-`null` entries** of `POLICY_GATE_HELD_REFUSAL_CATEGORIES`. Adding a block
reason mapped to a category but not ranked compiles cleanly and throws
`unranked_auto_approval_block_reason` at run time (`vocabulary.ts:651-657`) — inside the persist
transaction, and (per H1) past the kill switch.

This is inconsistent with the file's own doctrine. `vocabulary.ts:631-638` explains that the *other*
direction was deliberately hardened into a compile error after a widened annotation "compiled and threw at
run time INSIDE the deciding transaction instead. (Branch review round 1, standards axis P1.)" The same
lesson is not applied here; the invariant is left to `vocabulary.test.ts`, i.e. to a test.

**Fix:** a type-level exhaustiveness assertion — e.g. a `never`-check that
`Exclude<NonNullableKeys<typeof POLICY_GATE_HELD_REFUSAL_CATEGORIES>, typeof AUTO_APPROVAL_BLOCK_PRECEDENCE[number]>`
is `never` — turns the omission into a compile error in the same change that introduces it.

### FINDING M1 — a ledger abort re-spends LLM and moderation budget, not just attempts

`worker/jobs/ResponseGeneratorWorker.ts:92` (`generateDraft` — the LLM call) and `:105`
(`moderateResponse` — the provider moderation call) both run **before** `persistResponseAndNotify`
(`:110`). A ledger throw aborts the persist, the BullMQ job fails, and the retry re-runs both paid calls
from the top.

`withLedgerAttribution`'s docblock (`persist.ts:773-777`) frames the blast radius as
*"`generate_response` burns its attempts in about 75 seconds"* — an availability cost. The spend cost is
not stated anywhere in the ledger surface. `withCostGuard`'s reservation model protects against a runaway
LLM loop, but nothing here distinguishes "this retry will fail again for the same deterministic reason"
from a genuine transient, so a deterministic writer bug pays for N generations per affected review across
the whole fleet until an operator intervenes.

This is a documentation-and-awareness finding rather than a design defect — the ordering is correct — but
it materially raises the priority of H1 (the lever must actually work) and H2 (the bug class must not
compile).

### 1.3 The kill switch itself — verified

`write.ts:369-374` (single arm) and `write.ts:512-515` (batch arm) both read the flag **before touching
`tx`** and `return` without issuing a statement. Each arm issues exactly **one** statement, so there is no
interleaving in which a flag flip could leave a partial write. `readFlagEnabledByDefault`
(`src/lib/config/flags.ts:25-30`) reads `process.env` live on every call with no memo, which is the right
choice here and matches `circuit-breaker.ts`. **No half-written state is reachable. Confirmed.**

One nit, appendix-level: the batch arm's `inputs.length === 0` check runs *before* the flag read
(`write.ts:508`), so a zero-row build never warns. That is deliberate and correctly reasoned
(`write.ts:488-492`).

---

## 2. The read — `src/lib/refusals/read.ts`

`getRefusalLog` issues **four strictly sequential queries** per call, in both scopes:

| # | Query | Lines | Scope | Skipped when? |
|---|---|---|---|---|
| 1 | coverage start (`accounts`/`businesses`) | `301-312` | both | never |
| 2 | entries (`refusal_events`) | `354-410` | both | never |
| 3a | archived-locations footnote | `421-433` | account only | location scope |
| 3b | archived-periods line | `440-456` | location only | account scope |
| 4 | `total` `COUNT(*)` | `467-497` | both | never |

**They are sequential, and that is correct** — no `Promise` combinator appears anywhere in the module.
`ci:pool-fanout` does not scan `src/lib/refusals/` (`scripts/ci/pool-fanout-audit.ts:141-142` limits
`SCAN_DIRS` to `src/lib/{admin,dashboard,locations}`), so nothing in CI enforces this; the module honours
the spirit unaided. Good.

**They are skipped by scope, but not by "cannot produce a row."** 3a runs for every account-scope render
including single-location accounts that have never archived anything; 3b runs for every location-scope
render even though the route has already proven the location is *active*
(`resolveDashboardLocation`, `route.ts:89-94`). Neither is skippable a priori without a query, so this is
acceptable — with the caveat in M3 below about what 3b actually costs.

There is no N+1 across the three #1005 surfaces. The `subject_review_id` correlated subquery
(`read.ts:357-362`, `:389-394`) is a SubPlan bounded by the `LIMIT 200`, resolving to a `responses_pkey`
probe — at most 200 cheap lookups, not a per-window fan-out.

### FINDING H3 — the `total` COUNT(*) is the one unbounded query on the owner path

`src/lib/refusals/read.ts:467-497`

`ENTRY_LIMIT = 200` bounds the entry array. It does not bound this query, which counts **every** row in
the account's window on every tab load. Real plan:

```
Aggregate
  ->  Index Scan using idx_refusal_events_account_window on refusal_events r
        Index Cond: ((account_id = …) AND (occurred_at >= …) AND (occurred_at <= …))
        Filter: ((business_id IS NULL) OR (hashed SubPlan 2))
        SubPlan 2
          ->  Index Scan using idx_businesses_account on businesses b
```

Two observations from the plan:

- Postgres **does** hash the `businesses` sublink (`hashed SubPlan 2`), so the archived-location filter is
  a hash probe per row, not an index lookup per row. Good — the `EXISTS`-not-`JOIN` choice
  (`read.ts:381-385`) costs nothing here.
- It is an **`Index Scan`, not an `Index Only Scan`**, because `business_id` is not in
  `idx_refusal_events_account_window (account_id, occurred_at DESC)`. Every row in the window therefore
  costs a **heap fetch** to read `business_id` for the filter.

The volume that makes this bite is documented in this very file: `read.ts:123-129` states that one
solicitation batch build can propose `MAX_DATA_ROWS` (5,000) `ask_withheld` Refusals in a single
transaction, retention is 180 days and the widest window is 90. A busy multi-location account can
therefore hold five- to six-figure row counts in a 90-day window, and this query does a full index range
scan **plus a heap fetch per row** over all of them, on the shared Vercel pool, behind
`src/lib/db/admission.ts`, on every render of the Restraint tab.

Note that migration 116 and `read.ts` disagree about the volume. The index comment
(`116_refusal_events.sql:210-214`) declines a `business_id` index because *"a per-location read narrows by
account and window first, and an account's location count is small… Revisit if one account's window ever
holds enough rows that filtering locations in memory shows up in the tab's latency."* `read.ts:123-129`,
written in the same effort, states the volume that satisfies that "revisit if" trigger. The two comments
were never reconciled.

**Fix (cheapest first):** add `business_id` to the covering index —
`(account_id, occurred_at DESC) INCLUDE (business_id)` makes both the count and the entry filter
index-only. Failing that, cap the count (`SELECT COUNT(*) FROM (… LIMIT 1000) x`) and render
"1000+", which keeps the headline honest without an unbounded scan.

### FINDING H4 — the archived-period query has no usable index; `LIMIT` bounds output, not work

`src/lib/refusals/read.ts:442-450`

```sql
SELECT l.event_type, l.created_at FROM account_audit_log l
WHERE l.account_id = $1 AND l.location_id = $2
  AND l.event_type IN ('location_archived','location_reactivated')
ORDER BY l.created_at DESC LIMIT 200
```

`account_audit_log` carries only `idx_account_audit (account_id, created_at)` and
`idx_account_audit_event (event_type, created_at)` (`supabase/migrations/034_multi_location_schema.sql:75-79`).
Nothing covers `location_id`. Real plan:

```
Limit
  ->  Index Scan Backward using idx_account_audit on account_audit_log l
        Index Cond: (account_id = …)
        Filter: ((event_type = ANY ('{location_archived,location_reactivated}')) AND (location_id = …))
```

`account_id` is the **only** Index Cond. `location_id` and `event_type` are a post-scan `Filter`. The
`LIMIT 200` short-circuits only once 200 *matching* rows are found — and the common case produces **zero
or two**. So for the overwhelming majority of location-scope renders this **scans the account's entire
audit history backward and returns nothing.**

`read.ts:139-141` identifies the growth risk correctly — *"It selects from `account_audit_log`, a table
`ArchivalPoller` never sweeps, so its row set outlives the 180-day ledger retention and grows without
bound"* — and then bounds the wrong thing. `ARCHIVAL_EVENT_LIMIT` caps how many rows come back, not how
many are examined. Every operator archive/reactivate, plan change, offboarding step and channel change
this account has ever accumulated is on that scan path, forever.

**Fix:** a partial index —
`CREATE INDEX … ON account_audit_log (account_id, location_id, created_at DESC) WHERE event_type IN ('location_archived','location_reactivated')`
turns the whole predicate into an Index Cond and makes the `LIMIT` a real bound.

### FINDING M2 — the archival query is the one read in the module that does not bind both window ends

`src/lib/refusals/read.ts:442-450` has neither `created_at >= windowStart` nor `created_at <= windowEnd`,
while `read.ts:319-321` states the module's rule explicitly for every other query:

> *"BOTH ENDS ARE BOUND (I15). `occurred_at` is WRITER-supplied, not a database clock, so an unbounded
> upper edge admits a clock-skewed row dated after the very `windowEnd` the tab prints."*

`pairArchivedPeriods` does filter the *periods* to the window (`read.ts:266-270`), so nothing wrong is
rendered. The cost is that archival events **after** `windowEnd` consume slots in the newest-first
`LIMIT 200` slice and can push in-window events out of it. A lower bound genuinely cannot be applied (an
open period beginning before the window must survive), but `created_at <= windowEnd` can, and would make
the truncation behave the way the comment at `read.ts:147-151` claims it does.

### 2.1 The entry query — the index is chosen, but the sort is not free

```
Limit
  ->  Incremental Sort
        Sort Key: occurred_at DESC, id DESC
        Presorted Key: occurred_at
        ->  Index Scan using idx_refusal_events_account_window on refusal_events r
              Index Cond: ((account_id = …) AND (occurred_at >= …) AND (occurred_at <= …))
              Filter: ((business_id = …) OR (business_id IS NULL))
```

No seq scan on either owner path — the index is chosen in every arm. One note that does not rise to a
finding, and one that does.

The location arm's `business_id` predicate is a post-index **Filter**. For a multi-location account where
one location dominates the ledger, filling 200 rows for a quiet location requires scanning far past 200
index entries plus their heap tuples. Same root cause as H3, same fix.

The location arm's `EXISTS (SELECT 1 FROM businesses …)` (`read.ts:368-373`) references no outer column
and is hoisted to a one-time filter — it costs nothing per row. Enforcing I9 inside the read rather than
trusting the route (`read.ts:348-353`) is the right call.

### FINDING M3 — the `id DESC` tiebreak is not in the index, and the highest-volume lane makes ties 5,000 rows wide

`src/lib/refusals/read.ts:374`, `:408` — `ORDER BY r.occurred_at DESC, r.id DESC` — against
`idx_refusal_events_account_window (account_id, occurred_at DESC)`. `EXPLAIN` confirms the plan carries an
**Incremental Sort** with `Presorted Key: occurred_at`.

On its own that would be negligible: an Incremental Sort over singleton groups is nearly free, and
microsecond-resolution timestamps rarely tie. **They are not rare here.**
`src/lib/solicitation/batch-builder.ts:694` passes the same `Date` object to every row of a batch:

```ts
// The batch's OWN decision time, converted once and shared by every row
// — one build is one decision.
occurredAt: decidedAtInstant,
```

So one solicitation batch build writes up to `MAX_DATA_ROWS` (5,000) `ask_withheld` rows with a
**byte-identical `occurred_at`**. An Incremental Sort must read and sort an entire presorted group before
it can emit the first row of it — so returning the newest 200 entries means materialising and sorting all
5,000 rows of that group, each with the heap fetch H3 describes. The `LIMIT 200` does not help: it applies
above the sort.

`ask_withheld` is, per `read.ts:123-129`, the ledger's highest-volume lane. The one query the tab cannot
avoid is therefore also the one the dominant write pattern is worst for.

**Fix:** extend the index to `(account_id, occurred_at DESC, id DESC)`. That removes the sort node
entirely and — if combined with H3's `INCLUDE (business_id)` — makes both the entry query and the count
index-only. One migration closes H3, M3 and the location-arm filter cost together.

---

## 3. `writeRefusalEvents` — the batch arm

**The batch arm is a real set-based insert.** `write.ts:542-583` is a single
`INSERT … SELECT … FROM jsonb_to_recordset(…)` with the partial-index `ON CONFLICT` re-spelled
byte-for-byte. It correctly declines `commitAskDecisions`' affected-row assertion (`write.ts:493-500`) —
under `ON CONFLICT DO NOTHING` a legitimately-deduplicated subject lowers the count, and the throw would
land inside a decision transaction. `DO NOTHING` also resolves a self-conflict within the statement, which
`DO UPDATE` cannot (21000). This is correct and well reasoned.

Its one caller uses it correctly: `src/lib/solicitation/batch-builder.ts:670` passes the whole
`.flatMap` result in one call.

### FINDING H5 — `ask-generation.ts` loops the single-row arm N times, holding two locks

`src/lib/solicitation/ask-generation.ts:1824-1858`

```ts
for (const hole of holes) {                                    // :1824
  const outreachId = await insertOutreachRender(tx, { … });     // :1827
  await recordOutreachWithheldRefusal(                          // :1851  → writeRefusalEvent (:698)
    tx, { accountId, businessId: input.businessId }, outreachId, 'render_failed', decidedAt,
  );
}
```

`holes` (`ask-generation.ts:1791-1809`) has **no `LIMIT`**: it is every `status = 'send'` ask in the batch
with no non-cancelled outreach row, which under `MAX_DATA_ROWS` can be the entire 5,000-row cohort. The
enclosing transaction (`:1763`) already holds `acquireSolicitationBatchLock` (`:1774`) and the
`solicitation_batches` row `FOR UPDATE` (`:1775-1781`).

That is **2N sequential round trips** — up to 10,000 — inside a doubly-locked transaction behind the
admission chokepoint. It is verbatim the failure the batch arm's own docblock says it exists to prevent
(`write.ts:474-478`):

> *"Looping `writeRefusalEvent` would put 5,000 sequential round trips inside a transaction already
> holding the per-Business advisory lock AND the batch row lock, behind the `src/lib/db/admission.ts`
> chokepoint."*

`writeRefusalEvents` is not imported in `ask-generation.ts`. The loop's own comment (`:1848-1850` — *"ONE
Refusal PER HOLE, inside the loop"*) argues correctly about **cardinality**, which the batch arm preserves;
it is not an argument about statement count.

Half the cost is `insertOutreachRender`, which is outside this audit's surface — but the ledger half is
avoidable today with an import that already exists, and fixing only the ledger half halves the round
trips.

**On `ci:pool-fanout`'s spirit:** the audit bans `Promise` combinators over ≥2 DB-issuing elements in
three directories it does not scan here. Nothing in the ledger surface uses a combinator, so the letter is
clean everywhere. The *spirit* — do not multiply statements against the shared pool — is honoured in
`read.ts` and in `batch-builder.ts`, and broken at `ask-generation.ts:1851`.

---

## 4. Deep-module discipline

`write.ts` is 603 lines of which roughly **140 are executable** and ~460 are commentary. Its interface is
two functions, one input type, and two constants. By the `codebase-design` measure that is a genuinely
**deep module**: the caller states a lane and gets C1–C5 checked at compile time, the partial-index
predicate, the sentinel resolution, the kill switch and the warning transport all handled behind it. The
`RefusalLaneShapes` mapped type (`write.ts:184-207`) is the best thing in the file — an eighth lane added
to `REFUSAL_SOURCES` without a shape is `TS2536` on the indexed-access line rather than a `23514` in
production.

It has accumulated in exactly one place.

### FINDING M4 — the cooldown mechanism services a branch the module says cannot occur

`src/lib/refusals/write.ts:89` (`WARN_RETRY_COOLDOWN_MS`), `:229` (`nextWarnAttemptAt`), `:315-320`
(the catch that sets it), plus half of `resetRefusalLedgerWarningForTests` (`:237-240`) and ~25 lines of
docblock (`:221-229`, `:281-284`).

`nextWarnAttemptAt` is set in exactly one place: the `catch` around `Sentry.captureMessage`
(`write.ts:315-320`). The module's own docblock explains why that catch is unreachable in practice
(`write.ts:269-284`):

> *"`@sentry/node` 10.55.0's `captureMessage` returns an event id immediately — it returns one even with
> no client configured — buffers the event, sends the envelope asynchronously, and catches a failed
> transport send INTERNALLY rather than throwing back."*

and then:

> *"WHAT THE COOLDOWN ACTUALLY BUYS, stated accurately: it rate-limits the retry of a capture call that
> threw SYNCHRONOUSLY — an unusual SDK or programming failure. It does NOT retry delivery, because a
> delivery failure never reaches this catch. It is kept because it is cheap and because it recovers."*

Apply the deletion test. Delete `nextWarnAttemptAt`, `WARN_RETRY_COOLDOWN_MS` and the assignment in the
catch, and behaviour is **identical in every scenario the module says is reachable**. `warnedThisEpisode`
alone already delivers the stated bound ("one warning per disabled episode"). What is lost is a
recovery path for a failure mode the same file argues does not occur. The cost of keeping it is one
exported constant, one module-level mutable, half of a test-only export, and ~25 lines of the docblock
that a future reader must work through to understand a nine-line function. That is accumulation, not
depth.

`warnedThisEpisode` and `endDisabledEpisode` are a different matter and should stay — the
episode-not-process rate-limit unit (`write.ts:213-218`) is a real insight, and the reasoning that a
process-lifetime latch makes every outage after the first silent is correct.

### FINDING M5 — two exports exist only for tests

`src/lib/refusals/write.ts:89` and `:237`. `WARN_RETRY_COOLDOWN_MS` and
`resetRefusalLedgerWarningForTests` have **zero production importers** repo-wide; the only consumer is
`src/lib/refusals/__tests__/write.test.ts:31-32`.

Module-level mutable state plus a test-only reset is a recognised smell, and the file names it as such by
citing `circuit-breaker.ts`'s `reset()` as precedent. The precedent is real and the repo is consistent, so
this is not a violation — but it is the smell in its textbook form, and M3 removes half of it for free
(deleting the cooldown deletes `WARN_RETRY_COOLDOWN_MS` and half of the reset's body). If the remaining
`warnedThisEpisode` latch is worth keeping — it is — a cleaner shape is to hoist the whole warning
concern into a tiny module that owns its own state and exposes `warn()` + `reset()`, so `write.ts`'s
interface is two functions and nothing else.

### FINDING L1 — an export with a suppression comment and no external importer

`src/lib/refusals/vocabulary.ts:551-555`. `AUTO_APPROVAL_BLOCK_PRECEDENCE` is exported with a
`// fallow-ignore-next-line unused-export` suppression and a comment stating
*"Exported with no external importer… `resolvePolicyGateRefusal` is its only runtime consumer."*
Its consumer is in the same file (`vocabulary.ts:650`) and its test asserts the order. A suppression
comment carried to keep an unnecessary export alive is worth one line of cleanup — either drop the
export or move the order assertion to an in-module test that reaches it without one.

---

## 5. Repo standards

| Standard | Result | Evidence |
|---|---|---|
| Invariant #12 — entry points orchestrate | **PASS** | `src/app/api/dashboard/refusals/route.ts` is 49 lines of body: parse, two flag reads, one module call per arm, `jsonResponse`. No query, no mapping, no filtering. `persist.ts` extracts every error branch into named helpers (`withLedgerAttribution`, `recordPolicyGateRefusal`, `recordModerationAndHold`), none over ~30 lines. |
| Invariant #15 — explicit `sql` | **PASS** | No `@/lib/db/server` import in any of `write.ts`, `read.ts`, `vocabulary.ts`, or any of the eight write sites. `route.ts:5` imports the singleton as the composition root, correctly. |
| No `any` | **PASS** | Zero `any` in the ledger surface. Two `as never` casts (`write.ts:568`, `persist.ts:838`) are the established postgres.js `tx.json()` serializer idiom, not the `any` carve-out. |
| No silent catches | **PASS** | Four catches total. `write.ts:298`, `:315` and `persist.ts:802` are documented log-and-swallow around observability only; `persist.ts:805` rethrows. Nothing swallows a fact. |
| No string literals where a constant exists | **PASS** | Every `refusalCategory` at every site comes from an imported `vocabulary.ts` map. `refusalSource`/`subjectType` are inline literals, but they are narrowed by the `WriteRefusalEventInput` discriminated union and `vocabulary.ts` exports no per-source constant to import — an inline literal is the correct spelling here. |
| `REFUSAL_LEDGER_ENABLED` in `docs/eservices-variables.md` | **PASS** | `docs/eservices-variables.md:213` |
| `REFUSAL_LEDGER_ENABLED` in `.claude/reference/env-vars.md` | **PASS** | `.claude/reference/env-vars.md:563` |
| `docs/directory.md` rows (`ci:directory-map`) | **PASS** | `read.ts` `:899`, `vocabulary.ts` `:900`, `write.ts` `:901`, route `:344` |
| `.claude/reference/migrations-log.md` entry for 116 | **PASS** | `:2533`, promoted to staging + production 2026-08-30 (`:2663-2666`), LOCAL-ONLY marker removed (`:2672-2673`), head pointer current (`:4`) |
| Single-writer invariant | **PASS** | No `INSERT INTO refusal_events` exists anywhere outside `write.ts:395` and `write.ts:543` (excluding migrations and tests). Verified repo-wide across `.ts/.tsx/.sql/.js`. |

### FINDING L2 — the "both rows" rule is enforced asymmetrically

`scripts/ci/env-registry-audit.ts:748-761`. `docs/eservices-variables.md` is required for **every**
declared var; `.claude/reference/env-vars.md` is required only for names that reach `flagNames`, and a
name reaches `flagNames` only if a `readFlag`/`readFlagEnabledByDefault` call site spells it as a string
literal or a same-file const (`resolveArg`, `:285-303`). Both rows exist today, so nothing is broken. The
hazard is that a future reader of `route.ts:76` "tidies" the literal into the imported
`REFUSAL_LEDGER_FLAG` and the flag silently drops out of the `env-vars.md` lane. That risk is currently
held off by a hand-written comment (`route.ts:70-75`) and a route test — adequate, but worth knowing it
rests on prose rather than the audit.

---

## 6. Operational safety — retention and purge

Both arms exist and are correctly built.

- **Retention.** `worker/background/pollers/ArchivalPoller.ts:380-393`. Sweeps on `occurred_at` and
  nothing else (correct — `created_at` is deliberately not a retention candidate),
  `ORDER BY occurred_at, id` matches `idx_refusal_events_archival (occurred_at, id)` exactly,
  `FOR UPDATE SKIP LOCKED LIMIT 5000`, counted and saturation-warned (`:450`).
  `REFUSAL_LEDGER_RETENTION_DAYS = 180` is a code constant, not an env var (`:46`).
  The clause-order coupling to `scripts/ci/tenant-scope-allowlist.ts:1010` is documented at `:365-374`.
- **Purge.** `worker/jobs/account-offboarding/purge-stages.ts:445` issues the `DELETE`, with
  `src/lib/account-offboarding/{purge-verification,table-disposition}.ts` carrying the verification and
  disposition rows. Migration 116's ordering warning (`:23-34`) is honoured — the migration reached both
  Supabase projects on 2026-08-30, ahead of the merge.
- **Access control.** `refusal_events` is deny-all RLS with no policies (`\d` on the live schema confirms
  `Policies (row security enabled): (none)`), and the read runs through the RLS-bypassing `postgres`
  role — so application redaction *is* the access control. `read.ts` selects neither `refusal_code` nor
  `all_refusal_codes` in any of its five statements. Verified; ADR 0023 holds.
- **Schema.** The live test-container schema matches migration 116 exactly: three indexes, five named
  CHECKs, three column enum CHECKs, two FKs with no referential action, RLS on with no policies.

---

## 7. Test quality

**Headline: the tests are genuinely good, and the specific defect this effort has a history of is fixed.**
139 `it(`/`it.each(` declarations across nine files; **zero** contain no `expect(`. Zero `it.skip`,
`describe.skip`, `it.todo`, `it.only` or `if (!process.env.X) return` early-returns. No test mocks the
thing it is testing (the two `vi.mock('@/lib/refusals/write')` sites are lane tests, and one is a
pass-through with deliberate fault injection).

| File | blocks | zero-`expect` blocks |
|---|---:|---:|
| `src/lib/refusals/__tests__/write.test.ts` | 11 | 0 |
| `src/lib/refusals/__tests__/write.integration.test.ts` | 7 | 0 |
| `src/lib/refusals/__tests__/read.test.ts` | 5 | 0 |
| `src/lib/refusals/__tests__/read.integration.test.ts` | 30 | 0 |
| `src/lib/refusals/__tests__/vocabulary.test.ts` | 23 | 0 |
| `src/lib/refusals/__tests__/eval-completeness.test.ts` | 1 | 0 |
| `src/components/dashboard/restraint/__tests__/RestraintReport.test.tsx` | 31 | 0 |
| `src/components/dashboard/restraint/__tests__/RestraintContent.test.tsx` | 20 (58 runtime cases) | 0 |
| `src/app/api/dashboard/__tests__/refusals-route.test.ts` | 11 | 0 |

*(The path `src/app/api/dashboard/refusals/__tests__/` does not exist — the route eval lives one level up.)*

**The historical defect is genuinely fixed.** `RestraintReport.test.tsx:121` is now titled
*"groups rows under one owner sentence per category across categories with several rows each"* and its
fixture is 3 `unsafe_content` + 2 `wrong_moment` rows, asserting `getAllByText(sentence)` has length **1**
per category plus per-group counts `'3 times'` / `'2 times'`. It can now tell per-category from
per-entry. Several other self-referential-fixture traps were caught by an earlier red-team pass and
compensated deliberately — `read.test.ts:28` exists solely to pin `ENTRY_LIMIT`/`ARCHIVAL_EVENT_LIMIT`
magnitudes because *"setting either to 5 left every case green (red team F30)."* That is exactly the right
instinct, and it is why the remaining gaps below are narrow rather than systemic.

The kill-switch tests are also clean and worth naming: `harness.sqlCalls` is populated only inside the
fragment's `then()` (`worker/__tests__/helpers/mock-sql.ts:133-134`), so it records **awaited queries
only** — a length assertion on it is a real "no statement reached Postgres" proof, not a "the function
resolved" proof. `write.test.ts:311-328` carries its own control (a first enabled write, so a helper that
never writes anything cannot satisfy the title) and a `'FALSE'` arm proving only the exact literal
disables. The batch arm's equivalent (`:609-631`) has the same shape.

The `WARN_RETRY_COOLDOWN_MS` boundary test (`write.test.ts:446-500`) is one of the better tests in the
effort: it advances a stubbed `Date.now` to `cooldown - 1` and asserts **no** re-attempt, then one more
millisecond and asserts the next iteration attempts, across four consecutive failures and a recovery.
That genuinely discriminates a time-based cooldown from a lifetime attempt ceiling.

Six gaps survived.

### FINDING T1 — the `ORDER BY … , r.id DESC` tiebreak is asserted by nothing, and the highest-volume lane manufactures ties

`src/lib/refusals/__tests__/read.integration.test.ts:519-539`

Every ordering fixture in the suite gives each row a **distinct** `occurred_at`: `base - 3*60_000 /
-60_000 / -2*60_000` here, `Date.now() - i * 1000` at the cap probe (`:748-752`), `-2min`/`-1min` at the
link-authority case (`:611`). No fixture anywhere creates two rows sharing an `occurred_at`.

**Regression that still passes:** delete `, r.id DESC` from `read.ts:374` and `:408`. All 139 blocks stay
green. Yet `batch-builder.ts:694` shares one `Date` object across every row of a batch — up to 5,000
`ask_withheld` rows with a byte-identical `occurred_at` — so the tab's page order becomes
non-deterministic between refreshes and the `LIMIT 200` slice becomes arbitrary. The tie is not
hypothetical; the set-based writer creates it by design, and the suite's own fixtures
(`ASK_DECIDED_AT`, `write.test.ts:101`) document that every row of a batch shares one instant.

This is the same missing guarantee as M3, from the other side: the index does not cover the tiebreak and
no test proves the tiebreak is there.

### FINDING T2 — `truncated: false` is never asserted against the real read

`src/lib/refusals/__tests__/read.integration.test.ts:761`, `:776` — the only two assertions on the field
anywhere in the effort, and both are `.toBe(true)`. Verified by grep across all nine files. The
empty-window case (`:542`) asserts `total`, `entries` and `coverageStart` but not `truncated`. Component
and route fixtures set `truncated: false` by hand and never exercise `read.ts`.

**Regression that still passes:** replace `truncated: total > entries.length` (`read.ts:520`) with
`truncated: true`. Every owner on every window then reads *"Showing the 3 most recent of 3."*

### FINDING T3 — `windowEnd` is never asserted as a value

`grep -n "windowEnd" src/lib/refusals/__tests__/read.integration.test.ts | grep expect` returns **nothing**.
`log.windowEnd` is read once in the whole suite, and only as an arithmetic operand inside a
`toBeGreaterThan` on `windowStart` (`:955-957`).

**Regression that still passes:** change `read.ts:507` to `new Date(windowEndMs + 86_400_000)` while
leaving the query bounds untouched. The tab prints a range one day wider than the one it queried — on the
one surface whose entire value is being exact about the window it covers.

### FINDING T4 — the "byte-for-byte" `ON CONFLICT` test pins the predicate against the migration but the column list against a hand-typed literal

`src/lib/refusals/__tests__/write.test.ts:161-170`, `:414-432`, `:543-565`

`migrationSubjectUniqPredicate()` parses migration 116 with
`/CREATE UNIQUE INDEX[^;]*refusal_events_subject_uniq[^;]*?(WHERE[^;]*);/` — it captures **only** the
`WHERE` clause. The index's column list `(refusal_source, subject_id)` on `116_refusal_events.sql:226` is
never read. The column list is instead pinned by `write.test.ts:431`:

```ts
expect(statement).toContain(
  'ON CONFLICT (refusal_source, subject_id) WHERE subject_id IS NOT NULL DO NOTHING',
);
```

— a hand-typed literal in the test, i.e. the second authority the file's own docblock (`:157-159`,
*"a hand-copied expectation only ever proves the copy"*) says it exists to prevent. The set arm
(`:554`) compares its clause to the single-row arm's — module-vs-module — and to the predicate only.

**Regression that still passes:** change migration 116's index to
`(refusal_source, subject_id, account_id)`. Both unit cases stay green while Postgres raises
`42P10 — there is no unique or exclusion constraint matching the ON CONFLICT specification` on the first
real write, aborting the deciding transaction.

**Compensating control is real:** `write.integration.test.ts:243` and `:374` both read *inside* the
transaction after a duplicate insert, so a failed inference poisons the transaction and they fail. The
live-DB lane catches it. The unit test's title nonetheless claims more than it proves, and per
CLAUDE.md the live suites skip silently without `TEST_DATABASE_POOL_URL`.

### FINDING T5 — the eval-completeness guard scans 42 of the effort's 139 blocks

`src/lib/refusals/__tests__/eval-completeness.test.ts:58-68` lists nine files and pins the length at `:146`.
`read.test.ts`, `read.integration.test.ts`, `RestraintReport.test.tsx`, `RestraintContent.test.tsx` and
`refusals-route.test.ts` — **97 of 139 blocks**, i.e. the whole read/UI half — are outside the scan. The
length pin stops the set silently shrinking but nothing makes it grow.

**Regression that still passes:** add `it.skip` to any of those 97 blocks; the guard built specifically to
catch a markered-out case reports nothing. (No such marker exists at HEAD — the hole is latent.)

### FINDING T6 — two titles claim more than their block tests

- `read.integration.test.ts:519` — *"orders newest first **within each category**"*. The fixture is three
  rows all of `category: 'unsafe_content'` (`:522-533`), and `read.ts` orders **globally**
  (`ORDER BY r.occurred_at DESC`) — per-category ordering lives in `RestraintReport.groupByCategory`, and
  is correctly tested elsewhere (`RestraintReport.test.tsx:140`, with deliberately unsorted input). The
  title describes behaviour the module under test does not have, with a fixture that could not observe it.
- `RestraintContent.test.tsx:141` — *"…and **hand-rolls no** keying, staleness or abort"*. The block's two
  assertions (`:155-156`) are positive-presence checks for `useQuery` and the query key; nothing asserts
  an absence. The absence pins were deliberately deleted as unsound (red team F23) and replaced by a
  behavioural test at `:159` — a good trade, but the title was not updated with it.

### Smaller notes (not findings)

- `read.integration.test.ts:513` — `expect(second).toBeDefined()` on a string returned by a seed helper.
  Dead weight; the real oracle is `expect(log.total).toBe(1)` on the next line. The only instance of this
  shape in the nine files.
- `write.test.ts:219` — the `@ts-expect-error` block's five runtime assertions restate object literals
  declared six lines above and cannot fail under `vitest run`. This is stated in the file (`:228-229`) and
  is correct — `tsc --noEmit` is where it fires. Worth knowing that a green `pnpm test` is **zero**
  evidence about it; the `lint` job is.
- `WARN_RETRY_COOLDOWN_MS`'s **magnitude** is pinned by nothing. Setting it to `1` leaves the boundary
  test green while making the cooldown useless. `read.test.ts:28` exists for exactly this reason for the
  other two constants; the equivalent case was never written, even though `write.ts:85-87` says the
  export exists *because* "a test that hard-coded five minutes would pass while measuring nothing."
  (M4 recommends deleting the constant, which resolves this too.)
- `read.integration.test.ts:5-7` claims *"Four remain `it.todo`"*. There are zero `.todo` markers in the
  file; all 30 blocks are active. Stale header comment.
- `read.ts:501` (`totalRow?.total ?? entries.length`) and `:433` (`?? { refusal_count: 0, … }`) are
  unreachable — `COUNT(*)` always returns one row. Not a test defect, but coverage over-reports here.
- `pairArchivedPeriods`' two-archives-in-a-row branch (`read.ts:248`, `openedAt ??=`) has no test, and no
  case exercises more than one period in a single input.

---

## Findings — confidence ≥80%

Ordered by severity, then by file. Every row is reproducible from the cited line.

| # | Severity | Location | Finding |
|---|---|---|---|
| H1 | HIGH | `worker/jobs/response-generation/persist.ts:747` | `resolvePolicyGateRefusal` throws before `writeRefusalEvent` reads the flag, so `REFUSAL_LEDGER_ENABLED=false` cannot stop it aborting the persist — and it sits outside `withLedgerAttribution`, so it is not even attributed. `vocabulary.ts:619-621` claims the lever works. |
| H2 | HIGH | `src/lib/refusals/vocabulary.ts:555-577` | `satisfies readonly AutoApprovalBlockReason[]` proves membership, not totality — a mapped-but-unranked reason compiles and throws `unranked_auto_approval_block_reason` (`:656`) inside the persist transaction. The file hardens the opposite direction with a type at `:631-638`. |
| H3 | HIGH | `src/lib/refusals/read.ts:467-497` | The `total` `COUNT(*)` has no bound and no covering index; `EXPLAIN` shows `Index Scan` (not Index Only), so every row in the account's 90-day window costs a heap fetch, on every tab render, on the shared Vercel pool. |
| H4 | HIGH | `src/lib/refusals/read.ts:442-450` | `account_audit_log` has no `location_id` index (`034_multi_location_schema.sql:75-79`); `EXPLAIN` shows `Index Cond: (account_id = …)` with `location_id`/`event_type` as a post-scan `Filter`, so `LIMIT 200` bounds output, not work — an unbounded backward scan of a table nothing ever sweeps. |
| H5 | HIGH | `src/lib/solicitation/ask-generation.ts:1851` | Single-row `writeRefusalEvent` called once per unbounded `holes` row inside `for` (`:1824`), in a transaction holding the batch advisory lock and the batch row lock — verbatim the failure `writeRefusalEvents` was written to prevent (`write.ts:474-478`). The batch arm is not imported in the file. |
| M1 | MEDIUM | `worker/jobs/ResponseGeneratorWorker.ts:92,105,110` | A ledger abort re-spends the LLM draft and the provider moderation call on every retry; `persist.ts:773-777` frames the blast radius as burnt attempts only. |
| M2 | MEDIUM | `src/lib/refusals/read.ts:442-450` | The only query in the module with no `created_at <= windowEnd` bound, against the rule the module states at `read.ts:319-321`; post-window events consume the `ARCHIVAL_EVENT_LIMIT` slice. |
| M3 | MEDIUM | `src/lib/refusals/read.ts:374,408` | `ORDER BY … , r.id DESC` is not covered by `idx_refusal_events_account_window`, so the plan carries an Incremental Sort — and `batch-builder.ts:694` shares one `Date` across up to 5,000 rows, making the presorted group 5,000 wide to return 200. |
| M4 | MEDIUM | `src/lib/refusals/write.ts:89,229,315-320` | The `WARN_RETRY_COOLDOWN_MS`/`nextWarnAttemptAt` cooldown services a synchronous-throw branch the same file argues cannot occur with the installed SDK (`:269-284`). Deleting it changes nothing reachable — the deletion test fails. |
| M5 | MEDIUM | `src/lib/refusals/write.ts:89,237` | `WARN_RETRY_COOLDOWN_MS` and `resetRefusalLedgerWarningForTests` have zero production importers repo-wide — test-only exports on a module whose whole claim is a small interface. |
| M6 | MEDIUM | `worker/jobs/response-generation/persist.ts:788` vs six other sites | Only the response-generation lane attributes ledger failures to `subsystem: 'refusal_ledger'`; the other six surface as generic transaction aborts, though `persist.ts:769-777`'s argument applies equally to all seven. |
| T1 | MEDIUM | `src/lib/refusals/__tests__/read.integration.test.ts:519-539` | No fixture in the suite gives two rows the same `occurred_at`, so deleting `, r.id DESC` from `read.ts:374,408` leaves all 139 blocks green — while `batch-builder.ts:694` makes 5,000-row ties by design. |
| T2 | MEDIUM | `src/lib/refusals/__tests__/read.integration.test.ts:761,776` | The only two assertions on `truncated` anywhere are both `.toBe(true)`; hard-coding `truncated: true` at `read.ts:520` passes the whole suite. |
| T3 | MEDIUM | `src/lib/refusals/__tests__/read.integration.test.ts` (absent) | `windowEnd` has zero `expect` assertions; widening it by a day at `read.ts:507` without touching the query bounds passes — the tab prints a range it did not query. |
| T4 | MEDIUM | `src/lib/refusals/__tests__/write.test.ts:163,431` | The "byte-for-byte" test's migration parser captures only the `WHERE` clause; the index column list is pinned by a hand-typed literal. Changing 116's index columns keeps both unit cases green and raises `42P10` in production. |
| T5 | MEDIUM | `src/lib/refusals/__tests__/eval-completeness.test.ts:58-68` | The completeness guard lists nine files covering 42 of the effort's 139 blocks; the entire read/UI half (97 blocks) is outside the scan, so an `it.skip` there is invisible to the guard built to catch exactly that. |
| T6 | LOW | `read.integration.test.ts:519`, `RestraintContent.test.tsx:141` | Two titles claim more than their block tests: "within each category" over a single-category fixture against a module that orders globally; "hand-rolls no keying, staleness or abort" backed only by two positive-presence assertions. |
| L1 | LOW | `src/lib/refusals/vocabulary.ts:551-555` | `AUTO_APPROVAL_BLOCK_PRECEDENCE` carries a `fallow-ignore unused-export` suppression despite having only an in-file consumer (`:650`). |
| L2 | LOW | `scripts/ci/env-registry-audit.ts:748-761` | "A flag needs BOTH rows" is enforced by two different predicates; the `env-vars.md` half requires the flag name to be a string literal at a call site, held off today only by the comment at `route.ts:70-75`. |

---

## Appendix — low confidence / preference

These did not meet the ≥80% bar and are recorded only so they are not re-discovered.

*(The Incremental Sort note that sat here was promoted to finding M3 once `batch-builder.ts:694` was
found sharing one `Date` across up to 5,000 rows — the presorted group is not narrow, so the sort is not
negligible.)*

- **`entries` and `total` run on different pool connections at different instants** (`read.ts:347`,
  `:467`), so a row whose writer-supplied `occurred_at` lands inside the window between the two
  statements can make `truncated` true with a short `entries` array. Self-healing on refresh; wrapping
  both in a read transaction would cost more than the inconsistency does.
- **`readFlagEnabledByDefault` reads `process.env` per call** (`flags.ts:25-30`), so two ledger writes in
  one transaction could in principle disagree about the flag. Not reachable on Railway, where an env
  change redeploys the service.
- **The "not a revert deploy" framing of the kill switch** (`write.ts:370-372`) is slightly generous on
  Railway: changing the variable triggers a service redeploy. Still much faster than a code revert, and
  the framing is directionally right.
- **`groupByCategory` is O(categories × entries)** (`RestraintReport.tsx:253-262`) — 8 × 200. Fine.
- **The `subject_review_id` correlated subquery** (`read.ts:357-362`, `:389-394`) is a SubPlan evaluated
  per output row. Bounded by `LIMIT 200` and each execution is a `responses_pkey` probe. Fine as is.
- **`ci:pool-fanout` does not scan `src/lib/refusals/`, `src/lib/solicitation/` or `worker/`**
  (`scripts/ci/pool-fanout-audit.ts:141-142`). This is deliberate and documented (`:99-104`), but it is
  why H5 was not caught mechanically. Widening `SCAN_DIRS` is a one-line change and a separate review.
