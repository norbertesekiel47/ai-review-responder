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
