# #679 — deviations recorded during execution

Plan-time deviations D1–D8 live in
`docs/superpowers/plans/2026-08-07-import-consent-worker-guard.md` §5. This file
records what execution found that the plan did not anticipate.

---

## 2026-08-07 — T0 (eval task)

### D9 — a FOURTH hand-queuing backfill test, not three

**What the plan said.** §3 T0 named three tests in
`worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts` that queue SQL
outside `pushImportSqlSetup` and therefore each need a consent result prepended:
archived-location, missing-business, already-completed.

**What is actually there.** A fourth: *"reactivation runs use the identical
import window and stay correlation-idempotent"* hand-queues a second attempt
after `resetHarnessForNextRun()` (two pushes: the INSERT no-op and a completed
run row). It needs the same prepend, and without it the suite goes red the
moment T4 wires the gate in.

**Action taken.** Consent result prepended there too. Four hand-queuing sites
total, all now going through `pushImportConsentState`.

### D10 — the fixture's consent push is conditional at T0, and T4 must delete the condition

**Why.** `sqlReturnQueue` is a FIFO of results for AWAITED queries. Queuing the
consent read before the code that consumes it exists shifts every later query
onto the wrong row, and the 35 pre-existing backfill tests fail with
`Backfill row not found for business=biz-1 after upsert` — 30 red tests that say
nothing about this ticket and bury the 26 titles the eval commit is supposed to
fail on. The eval commit's whole value is a clean signal.

**Action taken.** `pushImportConsentState` opens with

```ts
if (!consentGuardShipped()) return;
```

where `consentGuardShipped()` is
`typeof jobEligibility.guardImportConsent === 'function'`. It becomes a no-op
branch the moment T3 exports the gate, so the fixture is correct in both states.

**T4 MUST DELETE** `consentGuardShipped` and that `if` once the gate is wired in.
Leaving it is a live tripwire: a future rename of the export would silently stop
the fixture queuing consent results and quietly re-green the suite against a
worker that no longer reads consent.

### D11 — not-yet-existing symbols are reached by namespace cast, not `@ts-expect-error`

`guardImportConsent` and `ImportConsentGate` do not exist until T3, but the eval
commit must pass `pnpm typecheck`. A `@ts-expect-error` on a named import would
typecheck today and then become an *unused-directive* error the moment T3 lands —
trading one broken build for another.

Both new suites therefore import the module namespace and widen it once:

```ts
import * as jobEligibility from '../job-eligibility';
const { guardImportConsent } = jobEligibility as unknown as { guardImportConsent: GuardImportConsent };
```

with `ImportConsentGate` / the input shape declared locally. This typechecks
before AND after T3 and still FAILS at run time today (`guardImportConsent is
not a function`). T3 may replace the cast with a named import; nothing forces it
to.

### D12 — six of the 38 titles pass at T0, by design

Not every locked title is a red-to-green title. These six pin behaviour that
already holds and exist so a later change cannot silently reverse it:

| # | Title | Why it passes today |
|---|---|---|
| 19 | `handleZernioBackfill throws on an unsupported tier before reaching the consent guard` | Pins the malformed-payload carve-out (plan §3 T4) — the ordering it protects is already correct. |
| 23 | `createImportOffer records no analytics event when the offer already exists` | Negative assertion; no events are emitted yet. |
| 26 | `recordImportDecisionAndEnqueue records no analytics event when the decision is rejected` | Same. |
| 27 | `recordImportDecisionAndEnqueue rolls back import_decision_recorded when the decision transaction aborts` | Same — it only becomes load-bearing once T2 emits. It forces a real abort, so it will catch an emission written against the outer `sql`. |
| 35 | `migration 102 still rejects an unregistered event name` | 097's CHECK already rejects unregistered names; the title guards 102 against widening. |
| 37 | `migration 097 pins its own historical event-name list` | A re-pin of an immutable list, not a new behaviour. |

### D13 — heads-up for T1: a second hardcoded ANALYTICS_EVENT_NAMES list

`src/lib/analytics/__tests__/events.test.ts:12` asserts the allowlist with
`expect(ANALYTICS_EVENT_NAMES).toEqual([…23 names…])`. T1 appends two names and
MUST extend that list in the same change or the suite goes red. Not touched at
T0 — appending the names there before they exist would be implementation, not
specification.

---

## 2026-08-07 — T1 (migration 102 + registration)

### D14 — D13 resolved, plus one assertion beyond the literal instruction

D13 handled: the hardcoded list in `src/lib/analytics/__tests__/events.test.ts`
is now the 25-name list, in migration-102 order.

**Beyond the letter of T1:** the same file's *"only allows client-intent events
to be enqueued from the browser"* test gained `import_offer_created` and
`import_decision_recorded` in its **negative** loop. T1's scope says the two
names go in `ANALYTICS_EVENT_NAMES` and **not** in
`CLIENT_ENQUEUEABLE_EVENT_NAMES` — nothing in the types enforces that
(`CLIENT_ENQUEUEABLE_EVENT_NAMES` only `satisfies readonly
AnalyticsEventName[]`, which a superset never trips). Two lines in the suite
that already enumerates durable server-owned facts — the #546 and #625
precedents in that same loop — is where the file puts that guarantee. Not a
new test, not a new file.

### D15 — migration 102 applied to the local test container by file, not by `pnpm test:db:setup`

`pnpm test:db:setup` drops schema `public` and re-applies from bootstrap. T3
and T5 run **concurrently with T1** against the same `repworth-testdb`
container, so a reset mid-wave would have failed their suites for a reason
unrelated to their work. 102 is constraint-only and its DROP + re-ADD is
idempotent, so it was applied on its own
(`psql "$TEST_DATABASE_POOL_URL" -f supabase/migrations/102_…sql`) and verified
by `pg_get_constraintdef`. Same end state, no blast radius. Staging and
production are untouched — the migrations-log entry carries **LOCAL-ONLY**, and
plan §6 owns the promotion order.

---

## 2026-08-07 — T3 (`guardImportConsent`)

### D16 — the live race test does NOT discriminate; the unit `inTransaction` assertion does

**What was checked.** T3 shipped as specified (`sql.begin` + `FOR UPDATE` +
in-transaction `markOutboxCompleted`), and then the serialization was
**temporarily removed** — the guard body run against the outer `sql` handle with
no `sql.begin` at all — to confirm the eval suite actually catches the round-1
blocking defect rather than merely covering it.

**Result.** Split.

| Suite | Non-transactional guard |
|---|---|
| `job-eligibility.test.ts` (unit) | **RED** — *"completes the outbox row inside the same transaction as its consent read"* fails on `expect(mockSql.begin).toHaveBeenCalledTimes(1)`. |
| `job-eligibility.integration.test.ts` (live) | **GREEN** — the race test passed unchanged against the local `repworth-testdb` container, 12 iterations, all assertions. |

**Why the live test does not discriminate.** Its Part 2 fires the guard and
`recordImportDecisionAndEnqueue` under one `Promise.all` on a `max: 4` pool.
That removes *client-side* serialization but does not control *statement*
interleaving: on a local single-node Postgres with no network latency, one side
consistently completes its whole sequence before the other reaches the statement
that would collide. Losing the interleaving is a scheduling accident, and a
green run therefore proves nothing about the lock. This is the exact failure
mode the plan's own §3 T0 warns about for the mocked half — "a lock interaction
is not something a mock can model" — and it turns out the live half needs
explicit *statement*-level choreography (an advisory-lock barrier, or two
sessions stepped by hand) rather than `Promise.all` to force the losing order.

**Action taken.** None to the test — T3's scope is one file and rewriting T0's
eval suite is out of it. The property is genuinely pinned: the unit assertion is
red without the transaction, which is the discriminating check the plan asked
for ("the `markOutboxCompleted` call is `inTransaction`"). Recorded here so the
review round does not read the live suite as independent evidence of
serialization, and so a later hardening pass has the diagnosis rather than
re-deriving it.

### D17 — the ingest lane's `subscription_status=missing` skip line is documented as unreachable, not deleted

`guardZernioJobEligibility`'s guard-ordering JSDoc now states that with T4's call
site a missing `businesses` row is intercepted by `guardImportConsent` first, so
the backfill-only `subscription_status=missing` line can no longer fire **for the
backfill worker**. The line itself is retained: the INGEST worker still reaches
it, and that lane never consults consent. The JSDoc says so explicitly, per the
plan's instruction to stop claiming a dead branch rather than leaving the doc
describing a reachable one.

---

## 2026-08-07 — T4 (wire the guard into `ZernioBackfillWorker`)

### D18 — a FIFTH pre-existing backfill test needed an edit, and it is not a queuing site

**What the plan said.** §3 T0 enumerated the hand-queuing tests that need a
consent result prepended (three, plus D9's fourth). Every other pre-existing test
was expected to survive T4 untouched via the central `pushImportSqlSetup` change.

**What T4 found.** *"reactivation backfill does not skip when an initial backfill
completed earlier"* (`ZernioBackfillWorker.test.ts`) went red on

```
expected 'CASE\n WHEN b.import_decision = …' to contain 'run_reason'
```

It is not a queuing problem — the fixture fed it correctly. It located the
run-claim INSERT **positionally**, as `mockSql.mock.calls[0]`. Since #679 the
first tagged template the handler builds is `importConsentStateSql`'s derived
`CASE` fragment, so index 0 is now the consent gate's composed fragment, not the
INSERT. (`mockSql.mock.calls` records composed fragments; `sqlCalls` records only
awaited queries — which is why T0's `firstSqlCallIndex('import_decision') === 0`
assertion is green on the same run.)

**Action taken.** The two assertions are preserved **verbatim**; only the lookup
changed, from `mockSql.mock.calls[0]` to `findBackfillInsertCalls()[0]` — the
content-addressed helper the same test already uses eight lines later for its
legacy-counter assertions. No assertion was weakened, deleted or retitled, and
the substantive claim (the reactivation claim names `run_reason` and conflicts on
`correlation_id`) is asserted on exactly the statement it was always about.

**Why this is not a design signal.** The failure says nothing about consent
ordering; it says a test used call position as a proxy for statement identity.
The plan's own ordering decision (consent first, so a refused run leaves no
durable trace) is what invalidated the proxy, and it invalidated it for one test
only — the other 34 pre-existing tests located their statements by content.

### D19 — D10 discharged

`consentGuardShipped` and its `if` are deleted; `pushImportConsentState` now
queues unconditionally. Verified mechanically: `rg -c 'consentGuardShipped'
worker/` returns no matches. The now-unused
`import * as jobEligibility from '../job-eligibility'` was removed from
`ZernioBackfillWorker.test.ts` in the same change (it existed only to feed the
feature detect; the two suites that still need the namespace-cast idiom of D11 —
`job-eligibility.test.ts` and `job-eligibility.integration.test.ts` — are
untouched). A short comment now stands where the shim did, stating why no
feature-detect guard may come back: it degrades silently on a rename.

### D20 — [2026-08-07, T2] the rollback test is genuinely load-bearing, and its mutation run strands a fixture constraint on the shared container

**The check that was asked for.** T2's brief required confirming that
*"recordImportDecisionAndEnqueue rolls back import_decision_recorded when the
decision transaction aborts"* cannot pass trivially. It was verified by mutation:
the emission was temporarily flipped from `tx` to the outer `sql` and the single
test re-run. It went **red**. The test is real.

**But the failure mode under mutation is a 30s TIMEOUT, not the assertion.**
`analytics_events.business_id` carries an FK to `businesses`
(`analytics_events_business_id_fkey`), so an INSERT naming that business takes
`FOR KEY SHARE` on the row the acceptance transaction is already holding
`FOR UPDATE`. On the outer `sql` handle that INSERT lands on a *different* pooled
connection, which then blocks on the very transaction that is `await`ing it — an
application-level deadlock Postgres's detector cannot see, because one side's wait
is a pending JS promise rather than a lock. So the executor-identity bug does not
silently commit here; it **hangs the acceptance POST**. Red either way, and worse
in production than the plan assumed — but the diagnostic a future engineer sees is
"Test timed out in 30000ms", which does not name the cause. Worth knowing before
someone reads that timeout as flake.

**What it costs, and what to do about it.** A timed-out abort never reaches the
test's `finally`, so `tmp_block_import_topic_analytics` — the deliberately-invalid
CHECK the test adds to `job_outbox` — is left behind on the shared local test
container. Every subsequent test that enqueues `zernio_initial_backfill` then
fails: 14 failures across three suites on the next run, none of them a code
defect. Direct DDL cleanup is blocked by the harness classifier; the working
route is a throwaway `*.integration.test.ts` that issues
`ALTER TABLE job_outbox DROP CONSTRAINT IF EXISTS tmp_block_import_topic_analytics`
and is deleted straight after (the test runner is already the sanctioned DDL path
for this fixture). Done, verified, and the file removed — the container is clean
and the full T2 surface re-ran 278/278.

**Do not "fix" this by moving the emission after `enqueueInitialImport`.** That
placement would make the rollback test pass trivially — the enqueue raises first,
so no emission is ever attempted — and would also drop the event on the `declined`
path, which returns before the enqueue. Emitting before the enqueue is what keeps
the boundary observable.
