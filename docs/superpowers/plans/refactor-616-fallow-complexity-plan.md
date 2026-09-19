# Plan — refactor/616-fallow-complexity

Closes GitHub issue #616. Behavior-preserving decomposition of the two
functions fallow reports above threshold.

- Intake (locked): `docs/superpowers/plans/refactor-616-fallow-complexity-intake.json`
- Deviations: `docs/superpowers/plans/refactor-616-fallow-complexity-deviations.md`
- Handoff: `docs/superpowers/plans/refactor-616-fallow-complexity-handoff.md`
- Base: `origin/main` @ `2870e1097d09b6c05d95092b768e831f50b379c0`

**Revision 2** — rewritten after plan round 1 returned `VERDICT: REVISE` with
six findings, all accepted. See the review appendix at the foot of this file.

## What "done" means

`fallow health` reports **zero** findings for `src/lib/shared/logger.ts`,
`worker/jobs/OnboardingDemoWorker.ts` and every file under
`worker/jobs/onboarding-demo/`. Thresholds in force are fallow's defaults: a
finding fires **above cognitive 15**, **above cyclomatic 20**, and at
**CRAP 30 or more**.

Measured in the worktree at the base SHA. The worktree has no `coverage/`
directory, so fallow assumes 40% coverage; the main checkout's numbers differ
because its `coverage/coverage-final.json` is stale (2026-09-11).

| function | cyclomatic | cognitive | lines | exceeded | CRAP |
|---|---|---|---|---|---|
| `src/lib/shared/logger.ts:47` `emit` | 20 | 24 | 53 | `cognitive_crap` | 106.4 (critical) |
| `worker/jobs/OnboardingDemoWorker.ts:35` `handleOnboardingDemo` | 19 | 25 | 144 | `cognitive_crap` | 97 |

**The CRAP term is a trap.** At the 40% default, CRAP stays at or above 30
until cyclomatic reaches **9 or below**. The proof run therefore passes real
regenerated coverage (`--coverage coverage/coverage-final.json`) rather than
running bare, and the review gate regenerates that file first.

The baseline gate already proved the targeted assertion **fails** on the
unfixed tree, naming both findings. A check that cannot fail is not evidence.

## Test strategy — characterization first, not red-green

This is a **behavior-preserving refactor**, so the TDD red step does not apply
(`execution-lanes.md` § Tracer bullets and TDD).

T1 and T3 add tests that **pass on the unrefactored code**. That is the point:
they pin the contract the decomposition must not move. A characterization test
that fails on first run encodes a guess about behavior, not the behavior — fix
the test, not the code.

T2, T4 and T5 then restructure with those tests, and all pre-existing tests,
staying green. **No pre-existing test may be modified.** A pre-existing test
that turns red is the refactor being wrong, never the test being stale.

### No new test files

The package has exactly one test file,
`worker/jobs/onboarding-demo/__tests__/stages.test.ts` (371 lines), holding one
`describe` block per module. Revision 1 invented two new test files; that was
wrong — precedent over invention.

This forces a better interface. `stages.test.ts` tests the **real**
`failOnboardingDemoTerminal` in its own `describe`, so it cannot
`vi.mock('../terminal')` file-wide. Therefore
`guardOnboardingDemoSubscription` takes `failTerminal` as an **injected
parameter**, matching how `reservation.ts` injects `finalizeCost`.
`@sentry/node` appears nowhere in the package, so mocking it file-wide for the
cost-reconcile block is safe.

## Module design

**`src/lib/shared/logger.ts` — internal seams only.** The external interface
(`createWorkerLogger`, `toError`, `logUnhandledPollError`) does not change. The
five new helpers are **module-private and unexported**, proven through
`createWorkerLogger`, which stays the single test surface. Precedent: the
existing private `serializeError` / `serviceName` / `normalizeLoggerName`.

**`worker/jobs/onboarding-demo/` — two new modules in an existing package.**
Precedent: `reservation.ts` and `terminal.ts` — one exported async function per
file, a single `input: { … }` object parameter, collaborators injected, logger
typed structurally, and never an import of `src/lib/db/server` (invariant #15).

`failOnboardingDemoAndRelease` was considered and **dropped** — deviations D1.
`terminal.ts` is in-surface but is not touched.

## The key-order contract (the one thing that can silently break)

`emit` seeds `message: ''` when it builds the record, then overwrites it at the
end. Re-assigning an existing key does **not** move it in JSON output. Today's
key order:

```
timestamp, level, service, logger, message,
<CONTEXT_FIELDS present, in CONTEXT_FIELDS order>,
[correlation_id, only when the factory supplied it and context did not],
<error fields, in arrival order>,
[data, only when non-empty]
```

The decomposition collects error fields into a separate object during the arg
loop and merges them after. That reproduces the order **only if** the merge
happens before `record.message` is re-assigned and before `record.data` is set.

---

## T1 — Characterize `emit` (10 tests, no production change)

**Behavior:** the exact bytes `createWorkerLogger` writes, across every arg
class, both fail-open paths, and the accumulation semantics of repeated args.

**Owner:** `src/lib/shared/__tests__/logger.test.ts`, appended to the existing
`describe('createWorkerLogger (JSON)')`.

**Precedent:** the console-spy seam already in that file — spy, `JSON.parse`
the captured line, assert on the parsed object. Test 8 deliberately breaks that
precedent and asserts the raw string; see its note.

**Seam:** `createWorkerLogger(prefix, correlationId)`. Do **not** import or
assert on any private helper.

**Test titles (exact, all must PASS on unrefactored code):**

1. `keeps the JSON key order: base fields, then context, then error fields, then data last`
   — assert `Object.keys(parsed)`, driven by a bound context, a factory
   correlation id, a string, an `Error` and an object arg in one call. Pin the
   lane (`delete RAILWAY_ENVIRONMENT_NAME`, `NODE_ENV=development`) so
   `error_stack` is present deterministically.
2. `lets a bound context correlation_id win over the factory correlationId`
3. `keeps false and 0 in the message instead of dropping them`
   — `message === 'flags false 0'`. Guards `typeof`-not-truthiness.
4. `drops null and undefined args without adding a data key`
5. `omits the data key when an object arg sanitizes to nothing`
   — use real blocked keys (`access_token`, `api_key`) from
   `src/lib/analytics/events.ts:38-63`, never a fabricated one.
6. `writes the fallback line when the whole record is unserializable`
   — **not** an object arg: `sanitizeAnalyticsProperties` copies only
   `string | number | boolean | null`, so a BigInt is dropped before it reaches
   the record. Use an `Error` whose `message` is a BigInt
   (`Object.defineProperty(err, 'message', { value: 10n })`). Expect exactly
   `{ message: 'failed', unserializable: true }` and **no** throw.
7. `lets the last Error arg overwrite the earlier error fields`
8. `writes exactly one byte-identical compact JSON line to the selected console sink`
   **[finding F5]** — the only raw-string test. Freeze time
   (`vi.useFakeTimers()` + `vi.setSystemTime`), and pin the lane to
   `NODE_ENV=production` so `error_stack` is suppressed and the string is
   deterministic. Assert the exact literal, `toHaveBeenCalledTimes(1)` on the
   chosen sink, and `not.toHaveBeenCalled()` on the other two. Parsed-value
   assertions cannot catch pretty-printing or a duplicate write; this one can.
9. `merges every object arg into data, keeping earlier keys across a sanitizer failure`
   **[finding F6]** — object, then a circular object, then another object, with
   one colliding key. Assert the complete `data` object **and** its key order.
   Replacing accumulation with "last object wins" passes every other test here.
10. `keeps the earlier error_stack when a later Error supplies none`
    **[finding F6]** — on a development lane, a first `Error` contributes
    `error_stack`; a second whose `stack` is deleted contributes only name and
    message, because `serializeError` guards on `err.stack`. The earlier stack
    must survive.

**Blocking edges:** none. **Allowed files:**
`src/lib/shared/__tests__/logger.test.ts`.

**Completion evidence:** that suite green with **21** tests (11 pre-existing +
10 new), and `git diff` in this commit touching only that file.

---

## T2 — Decompose `emit`

**Behavior:** identical bytes to T1's pinned records. Code moves only.

**Owner:** `src/lib/shared/logger.ts`.

**Target shape** — five unexported helpers, `emit` reduced to assembly:

```ts
function buildBaseRecord(level: LogLevel, prefix: string, correlationId: string | undefined): Record<string, unknown>
function mergeObjectArg(data: Record<string, unknown> | undefined, arg: Record<string, unknown>): Record<string, unknown>
function collectLogArgs(args: unknown[]): {
  message: string;
  errorFields: Record<string, unknown>;
  data: Record<string, unknown> | undefined;
}
function stringifyRecord(record: Record<string, unknown>): string
function writeLine(level: LogLevel, line: string): void
```

`mergeObjectArg` exists to pull the sanitizer try/catch out of the arg loop.
Without it `collectLogArgs` lands near the cognitive threshold instead of
comfortably under it.

`emit` becomes: build the base record, collect the args, `Object.assign` the
error fields, re-assign `message`, set `data` when defined, then
`writeLine(level, stringifyRecord(record))`. **That statement order is the
key-order contract.**

**Move verbatim, do not rewrite:** both fail-open comments, the `typeof`-based
arg classification and its branch order, the accumulation spreads
(`{ ...(data ?? {}), ...sanitized }` — accumulate, never replace), and the
`Object.keys(data).length > 0` emptiness test, relocated into
`collectLogArgs`'s return where `undefined` now means "empty".

**Invariants:** every invariant T1 pinned, the logging contract from
`.claude/CLAUDE.md`, and the `#611` stack-suppression rule in `serializeError`,
which is not touched.

**Test titles:** none added. The deterministic check is that T1's 10 tests and
the 11 pre-existing tests stay green **with no edit to the test file**.

**Blocking edges:** T1. **Allowed files:** `src/lib/shared/logger.ts`.

**Completion evidence:**
1. That suite green, 21 tests.
2. `git diff --stat` shows the test file unchanged in this commit.
3. The targeted fallow assertion reports no finding for `logger.ts`, and no new
   helper introduces one.

---

## T3 — Characterize the worker root (5 tests, no production change)

**Behavior:** the four root paths no test reaches today. The success path is
the important one: it is where T5 rewires two calls, and
`finalizeOnboardingDemoCost` is **not idempotent**
(`src/lib/costs/onboarding-demo-cost-guard.ts:86` applies
`delta = actualCostCents - RESERVATION_CENTS` on every call), so a duplicate
or misordered finalize corrupts the daily counter.

**Owner:** `worker/jobs/__tests__/OnboardingDemoWorker.test.ts`, appended to
the existing `describe`.

**Precedent:** the `vi.hoisted` mock bundle and `importWorker()` helper already
in that file. Every collaborator is already mocked.

**Seam:** `handleOnboardingDemo(job)` via `importWorker()`.

**Test titles (exact, all must PASS on unrefactored code):**

1. `completes the demo, then finalizes rounded actual cents once, reports thresholds and logs completion`
   **[finding F1]** — the success path end to end with the real ordering.
   Use a **fractional** `totalCostUsd` (e.g. `0.0342` → 3 cents) and a
   `cost_reservation_date` **different from today**, so a helper that
   substitutes today's date or drops the rounding fails. Assert: the exact
   `completeDemo` payload (`reviews`, `responses`, `source`);
   `mockFinalizeCost` called **exactly once** with `('2026-05-20', 3)`;
   `mockCheckCostThreshold` called once; the exact completion log string; and
   **no** terminal failure and **no** release.
   **Pin the awaited boundary, not just call order** (round 2, F1): make
   `mockCompleteDemo` return a promise this test resolves by hand. Before
   resolving it, assert `mockFinalizeCost`, `mockCheckCostThreshold` and
   `logger.log` have **not** been called; then resolve, await the handler, and
   assert the rest. `mock.invocationCallOrder` proves the order of invocation
   but not that `completeDemo` RESOLVED first — dropping its `await`
   (`OnboardingDemoWorker.ts:123`) satisfies an order assertion while writing
   the cost counter before the demo row.
   **Two mechanics this test must get right** (round 3 carry-forward): wait for
   the handler to actually reach `mockCompleteDemo` before evaluating the
   negative assertions — use `await vi.waitFor(() => expect(mockCompleteDemo)
   .toHaveBeenCalled())`, never a bare tick, or the negatives pass vacuously.
   And resolve the promise and await the handler in a `finally`, so a failing
   assertion cannot leave the handler pending and the suite with unsettled
   async work.
2. `completes the outbox and releases exactly once for each terminal claim outcome`
   **[finding F4]** — parameterized over `not_found`, `already_terminal` and
   `race_lost`, which share one branch. Assert `markOutboxCompleted` and
   `releaseOnboardingDemoReservation` each called **exactly once**, and no
   throw. "Called with" is not enough; a double release passes it.
3. `throws without releasing the reservation when the claim resets a stale running demo`
   — `reset_to_queued`. Expect a rejection matching `/reset from stale running/`
   **and** `expect(mockReleaseOnboardingDemoReservation).not.toHaveBeenCalled()`.
   The negative assertion is the load-bearing half.
4. `propagates a pre-work rejection without a terminal write or a release`
   **[finding F4]** — the subscription SELECT (`:67`), `claimDemo` (`:92`) and
   `markOutboxCompleted` (`:99`) all sit **outside** the outer try, so a
   rejection there escapes with no terminal write and no release. That is
   existing behavior. Pin it so the refactor cannot widen the catch and
   silently change budget accounting and retry behavior.
   **Parameterize over all three boundaries** (round 2, F4) — "at least
   `claimDemo`" would let two of the three go untested, and they are three
   separate lines that a widened catch would capture independently. For each:
   assert the rejection propagates, and that the terminal write and the
   release were **not** called.
5. `keeps the demo completed when Sentry capture throws, and skips the remaining captures`
   **[finding F2]** — one `try` wraps both `checkCostThreshold` and the whole
   capture loop (`OnboardingDemoWorker.ts:143-157`). With `crossed: [50, 90]`
   and `captureMessage` throwing on the first call, assert: exactly one capture
   attempt, **no** terminal failure, **no** release, and the demo still
   completed. Moving the loop outside its catch would propagate into the
   terminal path after completion; moving the catch inside the loop would
   change which alerts fire. Both pass today's tests.
   **Assert the exact diagnostic** (round 2, F2), not merely that logging
   happened: `logger.error` called **once** with exactly
   `` `Threshold check / Sentry capture failed for demo demo_123: <err.message>` ``
   (`OnboardingDemoWorker.ts:154-156`). A test that only checks "an error was
   logged" passes an altered or truncated diagnostic.
6. `releases exactly once when the generic terminal write fails`
   **[finding F4]** — the pre-existing test
   `releases reservation when generic failure recording throws` asserts
   `toHaveBeenCalledWith`, which a double release also satisfies. This appended
   test asserts `toHaveBeenCalledTimes(1)` on the release for the generic
   terminal path (`OnboardingDemoWorker.ts:162-177`). The pre-existing test is
   **not** modified.

**Blocking edges:** none. **Allowed files:**
`worker/jobs/__tests__/OnboardingDemoWorker.test.ts`.

**Harness note.** T4 test 7 (below) needs a numeric `outboxAttempt`, but the
file-level mock returns `attempt: undefined` unconditionally
(`OnboardingDemoWorker.test.ts:52-56`). T3 converts `extractOutboxHandle` into a
`vi.fn()` whose **default implementation is byte-identical to today's**, so
every existing test keeps its exact behavior, and a single test can override it
with `mockReturnValueOnce`. This changes the shared harness, not any test body.
Recorded as deviation D6.

**Completion evidence:** that suite green with **10** tests (4 pre-existing + 6
new), all 4 pre-existing ones unmodified, and the harness default proven by
those 4 still passing.

---

## T4 — Extract the subscription guard

**Behavior:** read the demo's account status; when it is no longer
`pending_payment`, warn, record a terminal `subscription_state_changed`
failure, release the reservation, and tell the caller the job is handled.

**Owner:** `worker/jobs/onboarding-demo/subscription-guard.ts` (new).

**Why a new file:** `OnboardingDemoWorker.ts` is the file this branch must
shrink, so the code cannot stay there. `worker/jobs/onboarding-demo/` is the
existing package for exactly this, with four precedents. No existing file fits:
`terminal.ts` owns the failure write, `reservation.ts` owns the release,
neither owns the read-and-decide.

**Interface** — `failTerminal` is injected, not imported, so the package's
single test file can keep testing the real `failOnboardingDemoTerminal`:

```ts
export async function guardOnboardingDemoSubscription(input: {
  sql: Sql;
  demoId: string;
  outboxId: string;
  outboxAttempt: number | undefined;
  logger: { warn(message: string): void; error(message: string): void };
  releaseReservation: () => Promise<void>;
  failTerminal: typeof failOnboardingDemoTerminal;
}): Promise<boolean>; // true = handled, caller returns
```

**Move verbatim:** the `onboarding_demos ⋈ businesses ⋈ accounts` SELECT with
its `WHERE od.id = ${demoId}` predicate; the
`SubscriptionStatus.PENDING_PAYMENT` comparison (never a string literal); the
warn text `Demo ${demoId} account status=${status}, marking failed`;
`failureKind: 'subscription_state_changed'`; and the `try { … } finally { … }`
that releases before the re-throw propagates.

**Security contract:** the actor is the worker, not an owner. The query is
scoped by `demoId`, a primary key, and joins to `accounts` only to read status.
It must stay exactly as written — widening the join would cross accounts.
Untrusted input: none (`demoId` comes from the outbox payload the worker wrote).
Side effects: one terminal demo failure and one reservation release. Failure:
`failTerminal` re-throws, the job retries, and the reservation must already be
released.

**Authority note.** `failDemo` (`src/lib/demos/lifecycle.ts:191`) branches on
`typeof outboxAttempt === 'number'`: a number adds `AND attempts = ${attempt}`,
`undefined` drops it. Dropping `outboxAttempt` in the extraction would let a
stale worker mark a newer dispatch failed. The worker test's outbox mock always
returns `attempt: undefined`, so today nothing would catch that — test 6 below
exists solely to close it.

**Invariants:** #15 (takes `sql`, never imports `src/lib/db/server`); the
narrowed reservation contract; the re-throw contract; no string literal for
subscription status.

**Seam:** a new `describe('guardOnboardingDemoSubscription')` in
`worker/jobs/onboarding-demo/__tests__/stages.test.ts`. The `sql` fake is a
tagged-template function that **captures its template strings and bound
values** and returns a rows array — not one that returns a fixture regardless
of the query, which could not detect a dropped predicate.

**Test titles (exact):**

1. `guardOnboardingDemoSubscription reports not handled when the account is still pending_payment`
2. `guardOnboardingDemoSubscription reports not handled when the demo row is missing`
   — the query resolves `[]`; returns `false`; no terminal write; no release.
   A missing row must not read as "the account changed".
3. `guardOnboardingDemoSubscription fails the demo and releases the reservation when the account has paid`
4. `guardOnboardingDemoSubscription releases the reservation and re-throws when the terminal write fails`
   — assert the release happened **exactly once** and the rejection propagates.
5. `guardOnboardingDemoSubscription reads status only through the demo's own business and account`
   **[finding F3]** — assert on the captured query text that it joins
   `od.business_id → b.id` and `b.account_id → a.id` and filters
   `od.id`, and that the bound value is the supplied `demoId`.
6. `guardOnboardingDemoSubscription forwards the sql client, outbox id and numeric attempt to the terminal write`
   **[finding F3]** — distinct demo and outbox ids and a **nonzero numeric**
   attempt; assert the full `failTerminal` input object.
7. `forwards the extracted outbox id and numeric attempt through the subscription guard to the terminal write`
   **[finding F3, round 2]** — lives in
   `worker/jobs/__tests__/OnboardingDemoWorker.test.ts`, **not** in
   `stages.test.ts`, and runs the **real** guard (the worker test mocks
   `../onboarding-demo/terminal` but must NOT mock
   `../onboarding-demo/subscription-guard`). Test 6 begins on the helper's own
   parameters, which is *after* the boundary the rewire creates; this one
   covers the root→helper hop itself. Override `extractOutboxHandle` once to
   return a distinct outbox id and a nonzero numeric attempt, then assert the
   mocked `failOnboardingDemoTerminal` receives both unchanged. Without it, a
   rewire that forgets `outboxAttempt` is undetectable, and
   `failDemo` (`src/lib/demos/lifecycle.ts:191`) then drops its
   `AND attempts = …` predicate and lets a stale worker fail a newer dispatch.

**Root rewire in the same commit:** `handleOnboardingDemo` replaces its
subscription block with
`if (await guardOnboardingDemoSubscription({ … })) return;`, passing
`failOnboardingDemoTerminal` through.

**Blocking edges:** T3.

**Allowed files:** `worker/jobs/onboarding-demo/subscription-guard.ts`,
`worker/jobs/onboarding-demo/__tests__/stages.test.ts`,
`worker/jobs/OnboardingDemoWorker.ts`,
`worker/jobs/__tests__/OnboardingDemoWorker.test.ts`.

**Completion evidence:** `stages.test.ts` green with 22 tests (16 pre-existing +
6 new), and `OnboardingDemoWorker.test.ts` green with 11 (4 pre-existing + 6
from T3 + 1 here), the 4 pre-existing ones **unmodified** — including
`releases reservation when subscription-state failure recording throws`, which
now exercises the extracted module through the root.

---

## T5 — Extract cost reconciliation, finish the root, ship the docs rows

**Behavior:** the two best-effort blocks after `completeDemo` — finalize actual
spend against the 20¢ reserve, and report crossed cost thresholds to Sentry.
Neither may ever propagate, because the outer catch would flip a completed demo
row to failed.

**Owner:** `worker/jobs/onboarding-demo/cost-reconcile.ts` (new). **One file,
two exports** — one seam (cost reconciliation for this lane).

**Interface:**

```ts
export async function finalizeOnboardingDemoSpend(input: {
  reservationDate: string | undefined;
  totalCostUsd: number;
  logger: { error(message: string): void };
  finalizeCost: (date: string, actualCents: number) => Promise<void>;
}): Promise<void>;

export async function reportOnboardingDemoCostThresholds(input: {
  demoId: string;
  logger: { error(message: string): void };
  checkThreshold: (lane: string, date: string, thresholds: number[]) => Promise<{ crossed: number[] }>;
}): Promise<void>;
```

`finalizeCost` and `checkThreshold` are injected, matching `reservation.ts`.
`@sentry/node` is imported directly, matching `terminal.ts`'s direct import of
`failDemo` — a sink, not a decision.

**Move verbatim:** `Math.round(result.metadata.totalCostUsd * 100)`; the
`new Date().toISOString().slice(0, 10)` date; the `[50, 90, 100]` threshold
set; the lane string `'onboarding-demo'`; the level ladder
`t === 100 ? 'error' : t >= 90 ? 'warning' : 'info'`; the message
`onboarding_demo_cost_threshold_${t}`; the tags
`{ lane: 'onboarding-demo', threshold: String(t) }`; and both catch messages,
including their `err instanceof Error ? err.message : err` ternaries.

**One try per block, exactly as today.** `reportOnboardingDemoCostThresholds`
keeps a single `try` around **both** the lookup and the whole capture loop.
Moving the catch inside the loop changes which alerts fire; moving the loop out
lets a Sentry exception reach the root's terminal path.

**Invariants:** the best-effort contract; the cost-guard arithmetic is
untouched; `finalizeOnboardingDemoSpend` is a no-op without a reservation date;
`finalizeOnboardingDemoCost` is not idempotent, so exactly one call.

**Seam:** two new `describe` blocks in
`worker/jobs/onboarding-demo/__tests__/stages.test.ts`, plus a file-level
`vi.mock('@sentry/node', () => ({ captureMessage: vi.fn() }))`. Safe because
Sentry appears nowhere else in this package.

**Test titles (exact):**

1. `finalizeOnboardingDemoSpend does nothing without a reservation date`
2. `finalizeOnboardingDemoSpend swallows and logs a finalize failure`
   — assert the call resolves. Drive it **twice**, once with an `Error`
   rejection and once with a non-`Error` value, so the diagnostic ternary is
   covered both ways, and assert the **exact** string each time (round 2, F2):
   `` `Failed to finalize cost reservation: ${err.message}` `` for the `Error`
   case and `` `Failed to finalize cost reservation: ${value}` `` for the
   other (`OnboardingDemoWorker.ts:136`). Running both branches without
   checking their output does not preserve that output.
3. `reportOnboardingDemoCostThresholds checks the current UTC day with the exact lane and thresholds`
   **[finding F2]** — assert `checkThreshold` called with exactly
   `('onboarding-demo', <today as YYYY-MM-DD>, [50, 90, 100])`. Freeze time so
   the date is deterministic.
4. `reportOnboardingDemoCostThresholds captures one Sentry message per crossed threshold`
   — `crossed: [50, 90, 100]`; three `captureMessage` calls with messages
   `onboarding_demo_cost_threshold_50/90/100`, levels `info`/`warning`/`error`,
   and the exact `lane` and `threshold` tags on each.
5. `reportOnboardingDemoCostThresholds swallows and logs a threshold-check failure`
   — `checkThreshold` rejects; the call resolves; `logger.error` called
   **once** with the **exact** string
   `` `Threshold check / Sentry capture failed for demo ${demoId}: ${err.message}` ``
   (round 2, F2 — `OnboardingDemoWorker.ts:154-156`).

**Root rewire in the same commit:** the success path calls the two new
functions. Final target for the root: **cognitive ≤ 15** (projected ~11),
**cyclomatic ≤ 9** (so CRAP clears even at the 40% default). **Measured
outcome: cognitive 7, cyclomatic 8, and 112 lines — NOT the "roughly 45 lines"
this plan first predicted.** The red-team caught that overstatement: the
extraction replaced dense inline blocks with multi-line, named-argument call
sites, so line count fell only 144 → 112. That is fine on its own terms —
fallow's line count is informational and never drove the #616 finding — but
the prediction was wrong and is corrected here rather than quietly dropped.
The function is orchestration only — invariant #12.

**Docs rows in the same commit** (`ci:directory-map` requires one per new
production file under `worker/`):

- `docs/directory/worker-jobs-c.md` — one row each for `subscription-guard.ts`
  and `cost-reconcile.ts` in the existing `worker/jobs/onboarding-demo/` table,
  matching the voice of the `reservation.ts` and `terminal.ts` rows.
- `docs/directory/worker-jobs-a.md` — update the `OnboardingDemoWorker.ts` row
  to describe the decomposed root.
- `docs/directory/lib-db-config-shared.md` — correct the `logger.ts` row, whose
  stated signature `createWorkerLogger(correlationId)` is wrong (deviation D2).

**Blocking edges:** T4.

**Allowed files:** `worker/jobs/onboarding-demo/cost-reconcile.ts`,
`worker/jobs/onboarding-demo/__tests__/stages.test.ts`,
`worker/jobs/OnboardingDemoWorker.ts`, `docs/directory/worker-jobs-c.md`,
`docs/directory/worker-jobs-a.md`, `docs/directory/lib-db-config-shared.md`.

**Completion evidence:**
1. `stages.test.ts` green with 27 tests (16 pre-existing + 11 new).
2. `OnboardingDemoWorker.test.ts` green with 11, its 4 pre-existing tests still
   unmodified across T3→T5.
3. `pnpm ci:directory-map` passes.
4. `pnpm ci:feature-surface` passes — both new files now exist, clearing the
   baseline gate's `feature-surface` row.
5. The targeted fallow assertion reports **no** finding for `logger.ts`,
   `OnboardingDemoWorker.ts` or anything under `worker/jobs/onboarding-demo/`,
   run against coverage regenerated by `verify-gate.sh --review`.

---

## Tracer summary

| id | title | blocks on | tests | files |
|---|---|---|---|---|
| T1 | characterize emit | — | +10 | 1 test file |
| T2 | decompose emit | T1 | 0 | 1 prod file |
| T3 | characterize the worker root | — | +6 | 1 test file (+ harness mock, D6) |
| T4 | extract subscription guard | T3 | +7 | 1 new prod, 2 test files, root |
| T5 | extract cost reconcile, finish root, docs | T4 | +5 | 1 new prod, 1 test, root, 3 docs |

Total: **28 new tests**, no new test file, no pre-existing test body modified.
Final counts: `logger.test.ts` 21, `OnboardingDemoWorker.test.ts` 11,
`stages.test.ts` 27.
Baseline counts verified by `grep -cE '^\s*it\('`: 11 / 4 / 16.

Run serially. RISK = high at SIZE = small means implementation happens in the
orchestrator session with **no subagent dispatch**.

## Plan self-review

1. **Intake coverage** — all 28 `tests_to_add` titles map to a tracer: 10 → T1,
   6 → T3, 7 → T4, 5 → T5. The single `user_visible_behavior` entry is the
   completion evidence of T2, T4 and T5. Every `edge_cases` entry is pinned by
   a named test except the four fallow/tooling entries, covered by the
   verification commands, and `reservationDate is undefined`, covered by T5
   test 1.
2. **Placeholder scan** — no `TBD`, no `TODO`, no "handle edge cases", no
   "similar to Task N". Every type and signature a tracer consumes is spelled
   out in the tracer that defines it.
3. **Security coverage** — T4 is the only tracer near a trust boundary. It
   carries a security contract, an authority note, and two negative tests:
   `…when the demo row is missing` (stale/missing input) and
   `…reads status only through the demo's own business and account` (scope).
   T1, T2, T3 and T5 cross no trust boundary: no new query, no new
   authorization, no owner-facing surface.
4. **Name consistency** — `guardOnboardingDemoSubscription`,
   `finalizeOnboardingDemoSpend`, `reportOnboardingDemoCostThresholds`,
   `buildBaseRecord`, `mergeObjectArg`, `collectLogArgs`, `stringifyRecord` and
   `writeLine` are spelled identically in their defining tracer, their
   consuming tracer, and the intake's `tests_to_add`.

---

## Review appendix — plan round 1

**Round 1.** Axis: plan skeptic. Runtime: `codex exec -m gpt-6-astra`. The
session id lives in the handoff doc's "Review sessions" table — it is not
repeated here, because its hex segments read as commit SHAs to
`prevalidate-plan.py` and produce two false "stale commit" issues.
`VERDICT: REVISE`, six findings.

All six **ACCEPTED**. Each was restated and checked against source before
acceptance; the two load-bearing citations were verified by hand.

| # | sev | finding | verdict | where fixed |
|---|---|---|---|---|
| F1 | P1 | Success path and cost reconciliation never characterized through the worker root | ACCEPT | T3 test 1 |
| F2 | P1 | Sentry failure containment and the exact lookup/alert contract can regress undetected | ACCEPT | T3 test 5, T5 tests 3–4 |
| F3 | P1 | Guard's DB scope and `outboxAttempt` authority unprotected by its tests | ACCEPT | T4 tests 5–6, T4 authority note |
| F4 | P1 | Reservation tests lack exact counts and omit the pre-work rejection boundaries | ACCEPT | T3 tests 2 and 4; intake invariant narrowed |
| F5 | P2 | Parsed-record assertions cannot prove byte-identical single-line output | ACCEPT | T1 test 8 |
| F6 | P2 | Stateful arg and error-field accumulation uncharacterized | ACCEPT | T1 tests 9–10 |

**Verified citations.** `src/lib/demos/lifecycle.ts:191` — `failDemo` does
branch on `typeof outboxAttempt === 'number'`, and
`OnboardingDemoWorker.test.ts:52` does always mock `attempt: undefined`, so F3's
gap is real. `src/lib/costs/onboarding-demo-cost-guard.ts:86` —
`finalizeOnboardingDemoCost` does apply `delta = actual - RESERVATION_CENTS` on
every call, so it is not idempotent and F1's double-finalize scenario is real.

**F4 exposed a false statement in the locked intake.** The invariant read
"EVERY path that does not complete the demo releases the 20c reserve exactly
once". That is not the code: a rejection from the subscription SELECT, from
`claimDemo`, or from `markOutboxCompleted` releases nothing, because those
calls sit outside the outer try. The invariant is narrowed to the as-built
behavior in both intake copies, and T3 test 4 pins it. Changing that policy
would be a behavior change and is explicitly out of scope.

**Two corrections found independently of the round**, from reading source
during the wait; both are folded in above:

- `sanitizeAnalyticsProperties` copies only `string | number | boolean | null`,
  so a BigInt in an object arg is dropped. Revision 1's T1 test 6 named an
  unreachable trigger. The reachable one is an `Error` with a non-serializable
  `message`.
- The package has one test file, not one per module. Revision 1 invented two.
  Following the precedent forces `failTerminal` to be injected rather than
  imported.

**Round conduct note** (also deviations D5). The session drifted out of
read-only near the end: it
ran `verified-gate.sh --review` after a hook prompt, having itself observed the
gate is not read-only. It wrote only `.feature/` state, which is always
re-derived here, never reused. It also attributed the handoff document to that
gate run; the orchestrator wrote it. Neither affects the findings, which stand
on their own evidence.

**Cost-estimate impact.** `estimated_test_lines` rises from 280 to 470 (1.7× —
under the 2× re-classification trigger, recorded honestly rather than left
stale). `estimated_prod_lines` is unchanged at 240.

---

## Review appendix — plan round 2 (verification-only)

**Round 2.** Same axis, same session **resumed** rather than started cold, so
it checked its own findings with its own context: 3 shell commands against
round 1's 13. It respected the read-only constraint this time and declined a
hook's request to run the gate, writing "the orchestrator owns gate evidence".

Result: **F5 and F6 ADDRESSED. F1–F4 substantially improved but each retained
a residual gap.** It opened no new fronts and confirmed no defect introduced by
a fix. It also independently validated both orchestrator-found corrections —
the `Error`-with-BigInt-`message` trigger, and injecting `failTerminal` so
`stages.test.ts` keeps testing the real terminal helper.

All four residuals **ACCEPTED**. Revision 3 changes:

| # | residual | fix |
|---|---|---|
| F1 | `invocationCallOrder` proves invocation order, not awaited resolution — dropping the `await` on `completeDemo` still passes | T3 test 1 now drives a hand-resolved `mockCompleteDemo` promise and asserts nothing downstream ran before it resolved |
| F2 | "logger.error fired" leaves the diagnostic text unpinned, including both newly exercised ternary branches | T3 test 5 and T5 tests 2 and 5 now assert the exact strings from `OnboardingDemoWorker.ts:136` and `:154-156` |
| F3 | T4 test 6 begins **after** the root→helper boundary; the root mock returns `attempt: undefined` unconditionally | new T4 test 7 in the worker test file, running the **real** guard with an overridden numeric attempt |
| F4 | "at least the `claimDemo` rejection" permits skipping two of three boundaries; the generic terminal path lacks exactly-once | T3 test 4 is parameterized over all three boundaries; new T3 test 6 asserts exactly-one release on the generic path |

**Why these are worth the round.** Each is a mutation that survives the
Revision 2 suite: drop an `await`, truncate a diagnostic, forget one argument
in the rewire, widen a catch. Those are precisely the mutations a decomposition
makes by accident, which is the whole risk this branch carries.

Round 2 raised the title count 26 → 28 and required one harness change,
recorded as deviation D6.

---

## Review appendix — plan round 3 (final verification)

**Round 3.** Same session resumed again. **Zero shell commands** — the resumed
context was sufficient, which is the whole argument for resuming a verification
round instead of starting one cold.

**`VERDICT: APPROVED`.** F1–F4 confirmed ADDRESSED, joining F5 and F6 from
round 2. All six original findings are closed at plan level. "Defects
introduced by these four fixes: none confirmed." D6's configurable mock was
checked against the existing tests and found compatible.

The reviewer was explicit about what the approval does **not** mean: it
approves the plan, it does not claim the unimplemented refactor is verified.

**Two carry-forward checks** the reviewer routed to the step 7 branch review
rather than treating as blockers, both about T3 test 1's deferred promise.
Folded into that test's text so the implementation honors them:

1. The test must let the handler actually reach `mockCompleteDemo` before
   evaluating the negative assertions — `await vi.waitFor(...)`, never a bare
   tick, or the negatives pass vacuously.
2. It must resolve the promise and await the handler in a `finally`, so a
   failing assertion cannot strand the handler and leave unsettled async work.

**The plan-review budget is now spent: 3 rounds of 3.** Nothing is carried to
the owner as unresolved disagreement, because nothing is unresolved.
