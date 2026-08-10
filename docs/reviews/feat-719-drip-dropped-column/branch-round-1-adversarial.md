# feat-719-drip-dropped-column — branch review round 1, **Adversarial approach**

**Axis:** chosen approach, design choices, assumptions. Line-level defects and style are owned by
the two sibling reviewers and are deliberately out of scope here except where a *design decision*
is the reason a defect exists.

**Base:** `bea12e68` · **Head:** `0ced136b` · 23 files, +3210/−130
**Dispatch path:** the `codex:adversarial-review` **skill** (plugin runtime), launched with
`--background --base bea12e68` and the three focus files. The runtime did **not** error — no fallback
to a direct `codex exec` was needed. The run completed (exit 0, thread
`019fe57c-20a4-77c0-ac71-db6ea5a1eba3`); its raw verdict is transcribed verbatim in §4.
My analysis (§2–§3) was written in parallel and is independent of it; where we converged I say so,
and where I adopted a Codex finding (A6) I verified it first and say that too.

---

## 1. Findings (≥80% confidence only)

| # | Severity | Design decision challenged | Concrete consequence if it is wrong |
|---|---|---|---|
| A1 | **High** | **#3 — staleness cap enforced at the producer only** ("the scheduler is the topic's sole producer, so a handler-side check would be defensive branching") | Nothing at the send site enforces the cap, so a months-late "Welcome to RepWorth!" still reaches an owner whenever a row arrives by any other route — a hand-inserted or operator-re-driven row, a future second producer, or a row that was minted just inside the boundary and dispatched days later. #679 rejected this exact reasoning and added a fail-closed worker chokepoint. |
| A2 | **High** | **D4 — reuse `isTerminalAttempt` as the sink's gate** rather than the event-context predicate | The sink is called from `worker.on('failed')`, the context the repo explicitly documents as needing the *other* predicate ("do not unify them", `worker/jobs/judge/failed-hook.ts:44-57`). Wrong in **both** directions: with the drip queue's `attempts: 3` it fires at 2/3 *and* 3/3 → duplicate issues plus a false "exhausted its retries" issue for a job that then succeeds; and an `UnrecoverableError` thrown on attempt 1 (`UpdateStripeOverageWorker.ts:186`) leaves `attemptsMade` below max, so a genuinely terminal billing failure raises **no issue at all** — the exact invisibility the sink exists to end. |
| A6 | **High** | **#6 — route every handler error to Sentry as the single record**, on the premise that "Sentry has its own scrubber" (`job-failure-sink.ts:26`) | `scrubSentryEvent` (`worker/sentry.ts:12`) scrubs `extra`, `request`, `transaction` and `breadcrumbs` — **not** `event.exception.values`. `captureException(err)` therefore ships the raw driver/provider message unredacted, from *every* queue including notification and solicitation lanes whose errors carry recipient addresses. The same PII contract that forced `boundedErrorClass` on the log line is unenforced on the channel the design elevated. Net effect: the branch removes the one treatment job-error text used to get (breadcrumb messages pass through `scrubBreadcrumb`) and adds an untreated path. |
| A3 | **Medium** | **#3 + #6 together** — a skipped drip is a permanent drop whose only trace is a `logger.warn` emitted by the scheduler | The `warn` fires only while the scheduler is running, but "the scheduler was not running" is the primary way drips go stale. After a >4-day scheduler/worker outage every affected owner permanently loses day_1/day_7/day_30 with **no** durable record (no `onboarding_drip_log` row, no outbox row, no Sentry, no metric). The pre-fix growing pile of `failed` rows is what made #719 findable; the fix removes that trail without replacing it. |
| A4 | **Low** | **#7 — delete the day_30 branch because "admins carry `account_id IS NULL`, so no rewrite could match"** | Migration 034 §5d backfills `users.account_id` from `users.business_id` **with no role filter**, so a business-scoped admin — exactly the population that branch served — carries a non-NULL `account_id`. The premise is unverified and contradicted by the migration; it is now written into a code comment as fact where a future reader may reuse it for something load-bearing. |
| A5 | **Low** | **#2 — repo-wide dropped-column audit declined as "its own epic-sized ticket"** | Measured exposure: **7** `DROP COLUMN` statements across 103 migrations; only `users.business_id` ever had a live reader. A migration-derived name list + grep is ~40 lines and passes green today. "Epic" overstates the cost, and without it the next drop (103 dropped four columns three weeks ago) has no forward guard — the same class recurs with the same three-month latency. |

**None of these require revisiting the plan (step 3).** A1 is a ~6-line addition inside a file already
on the edit surface; A2 is a predicate swap plus two tests; A6 is a bounded-error capture in the sink
it already owns; A3 and A4 are follow-ups or a one-query verification; A5 is a separate ticket. I
explicitly do **not** recommend a re-plan — but A1, A2 and A6 should land before this rides.

Codex, run independently, reached `needs-attention` and converged on A1 and A2 unprompted, and is
the origin of A6 (I verified it before adopting it — see §2.4). It raised a fourth blocker on
**drip send idempotency** (`sendInternalEmail` called without its deterministic `idempotencyKey`;
`sent_at` and `notification_deliveries` committed outside one transaction) which is pre-existing
line-level behaviour rather than a decision this branch made — **referred to the sibling
spec/correctness reviewer**, not claimed here.

---

## 2. Analysis — the questions, answered

### 2.1 Is producer-only enforcement of the staleness cap safe? (→ A1)

The claim rests on "the scheduler is the topic's sole producer." That is true *today* — the only
`INSERT … job_outbox … ONBOARDING_DRIP` in the tree is `OnboardingDripScheduler.ts:144`. But the
invariant being protected is not "only the scheduler produces rows." It is **"no owner receives a
drip more than 3 days late."** Those are different statements, and the second one is enforced
nowhere near the act that can violate it.

Four ways the gap opens, in descending likelihood:

1. **Incident response.** The natural operator reaction to 93 terminal rows is to re-drive them. A
   hand-inserted or status-reset row goes straight through `handleOnboardingDrip`, which reads
   `subscription_activated_at` (line 51) and never compares it to anything. Every one of those 93
   staging pairs is months overdue.
2. **Consumer lag inside the boundary.** A row minted at `activated + 3d 59m` is legitimate at mint
   time. It can then be re-pended by the watchdog (`status='dispatched'`, `attempts < max_attempts`)
   or reset to `pending` by the poller's dispatch-error path — repeatedly. The cap is therefore
   *approximate*, and the plan states it as absolute ("never queued and never sent, permanently",
   CONTEXT.md).
3. **A future second producer.** An admin "resend onboarding" button, a backfill script, a
   Solicitation-era re-engagement flow. The guard lives in a scheduler nobody will think to read.
4. **The `NOT EXISTS` interaction.** While a row is `pending`, re-minting is blocked, so the
   producer-side cap cannot re-evaluate the pair at all. The one component that *could* notice the
   boundary was crossed is structurally excluded from doing so.

**Why the #679 comparison is decisive.** #679 faced the identical shape — a consent predicate
enforced at four producers — and concluded producer-side enforcement was insufficient, adding
`guardImportConsent` in `ZernioBackfillWorker` as a fail-closed pre-flight so "a hand-inserted
`zernio_initial_backfill` row no-op-completes with a logged reason instead of importing." That is
the same sentence with two nouns changed. The plan (line 671) and CONTEXT.md do not mention #679,
the chokepoint pattern, or why the reasoning that was rejected there is accepted here. Searching the
plan for `679|chokepoint|producer|consumer` returns only the producer-only assertion itself.

The distinction one *could* draw is severity: #679 protects a legal/consent boundary, #719 protects
an embarrassment boundary. That is a real difference and I would accept it as an argument — but it
has to be made. As written, the justification given ("defensive branching around a state the
producer excludes") is precisely the argument #679 found wrong, restated without engaging it.

**Cost of closing it:** ~6 lines before the claim in `handleOnboardingDrip` — compare
`business.subscription_activated_at` against the drip offset + grace and
`markOutboxCompleted(…, 'too_late')`. The drip already has four skip-and-complete branches with the
same shape (lines 64, 76, 85, 136). This is cheaper than the comment explaining why it is absent.

### 2.2 Does the churn cap create a permanent-silence failure mode? (→ A3, partly)

**Not by itself.** The window is rolling and the count decays, so a pair capped at hour 3 recovers a
mint slot at hour 24; steady state is ~3 mints/24h, and within day_1's 3-day eligibility window that
is ~9 attempts (each of which is itself up to `attempts: 3` BullMQ invocations plus watchdog
re-pends). Rolling over lifetime was the right call and I would not change it.

**Permanent silence comes from the staleness cap, not the churn cap** — and it is real. Any
continuous failure longer than `days + 3` (4 days for day_1) drops the drip forever. That is
deliberate and signed off, and I do not challenge the drop itself: a 3-week-late welcome email is
worse than no welcome email. What I challenge is that **the drop leaves nothing behind** (A3).

Compare the two error paths this branch creates:

| Path | Durable record | Alert |
|---|---|---|
| Handler throws on the terminal attempt | none in Postgres (by design, decision #6) | Sentry issue |
| Producer skips a pair as too-late | **none anywhere** | **none** — one `logger.warn`, and only if the scheduler is running |

The second row is strictly weaker than the first, and it is the path that loses customer-visible
work. The plan's mitigation — "reported for exactly one day (so the skip is observable)" — is
conditional on the scheduler running continuously through that day, which is exactly the condition
that fails in the outage that created the skips. A 5-day scheduler outage produces zero `tooLate`
log lines and total silent loss, because every affected pair ages past the `GRACE + 1` outer window
while the scheduler is down and is never selected again.

There is a second-order cost worth naming plainly: **the 93-row pile is what made #719 findable.**
Nobody detected the 42703 for three months; what surfaced it was a growing row count. The branch
removes that growth (correctly — it was noise) and replaces it, for the *handler-error* path, with
Sentry. For the *never-queued* path it replaces it with nothing. The cheapest fix is an
`onboarding_drip_log` row with `sent_at IS NULL` and a skip reason, or a `HealthAlertPoller` check —
the poller already owns exactly this shape (`checks.ts:97-131`, `287-309`).

### 2.3 Is `asOf` a real seam or a test affordance?

**A real seam, and correctly built.** It is used consistently in all five time comparisons in one
query, so the boundaries are internally coherent — separate `NOW()` evaluations genuinely cannot pin
an equality, and titles 12/15 (send *at* the boundary; 24h exactly outside the window) cannot be
written any other way. Production passes `new Date()` once per cycle; nothing branches on it.

The divergence that does exist is not `asOf`'s fault and is worth stating because it is the
mechanism behind A1: **the producer is now time-injectable and the consumer is not.**
`handleOnboardingDrip` uses `NOW()` throughout and has no time parameter, so a test can pin the
boundary only on the side that does not enforce it at send time. The seam makes the *tested* surface
and the *effective* surface diverge — which is a mild argument for putting the guard where the
sending happens, not against `asOf`.

Two smaller notes, neither ≥80%: a JS `Date` carries 0 µs while `subscription_activated_at` carries
microseconds (the documented postgres.js truncation gotcha), so an exact-boundary test can be green
on a value production never produces — harmless here because every comparison is a half-open range,
not an equality. And the `asOf`-shifted intervals are computed in Postgres from a JS-supplied
instant, so DST/timezone behaviour is Postgres's `interval` arithmetic in UTC; the `::timestamptz`
casts keep that unambiguous.

### 2.4 Is "the diagnosis lives only in Sentry" acceptable? (→ A2)

**The reasoning behind decision #6 is sound; the execution weakens it.**

I verified the premise directly. `OutboxPoller.ts:137-149` terminalizes with
`last_error = 'Stale dispatched entry exceeded max_attempts'` **unconditionally**, and that is the
path a throwing handler actually takes (it never reaches `markOutboxFailed`). So a sink write really
would be destroyed by the generic text it exists to replace. D3's four reasons are individually
correct, and cutting scope the owner never signed off is the right call.

But the framing "don't write" vs "fix the watchdog" was resolved on *surface-amendment cost*, not on
merit. The merit answer is small: `last_error = COALESCE(last_error, 'Stale dispatched entry
exceeded max_attempts')`, or `WHERE … AND last_error IS NULL`. Two tokens. The follow-up is the
right vehicle **only if it exists** — D3 says "The `OutboxPoller.ts` follow-up is filed", and
`gh search issues --repo RepWorth/ai-review-responder "last_error"` / `"watchdog"` returns #719,
#413, #355, #500, #475, #414 and nothing matching. If it was filed under a title that mentions
neither term, fine; if not, the cost accepted in D3 has no owner. **Worth one check before merge.**

The sharper problem is A2. Decision #6 makes Sentry the sole record, which raises the bar on that
channel's precision — and the gate chosen for it is wrong for its call site. The repo already wrote
the answer down:

```
// Terminal-attempt check for the BullMQ 'failed' EVENT context: the Worker
// emits 'failed' only after job.moveToFailed() has incremented attemptsMade
// to include the failing attempt, so with attempts=3 only 3/3 is terminal
// (2/3 still has a retry). The shared isTerminalAttempt
// (src/lib/shared/outbox.ts) answers the same question INSIDE a processor
// catch block, where attemptsMade has NOT yet been incremented — hence its
// `attemptsMade + 1 >= maxAttempts`. Both are correct in their own call
// context; do not unify them.
        — worker/jobs/judge/failed-hook.ts:44-57
```

`attachJobFailureSink` binds `worker.on('failed', …)`, so the sink is unambiguously in the event
context, and `worker/queues.ts:39,65` gives the drip queue `attempts: 3`. Result: capture at
`attemptsMade = 2` (2/3, a retry remains) **and** at 3/3. Two consequences, both landing on the
channel decision #6 elevated: duplicate issues per exhausted job, and a "job exhausted its retries"
issue for a job that succeeds on its final attempt — which the intake lists as an edge case the
sink must not hit ("A BullMQ job that fails on an intermediate attempt and succeeds on retry — the
sink must capture nothing and write nothing").

The sink's own suite cannot catch it: its cases are `{attemptsMade: 5, attempts: 5}`,
`{attemptsMade: 3, attempts: 3}` (both correct by coincidence, since `attemptsMade === attempts`)
and `{attemptsMade: 1, attempts: 5}`. The failing case — `{attemptsMade: 2, attempts: 3}`, the drip
queue's actual configuration — is not tested.

The predicate is also wrong in the **opposite** direction, which matters more given decision #6.
`UpdateStripeOverageWorker.ts:186` throws `UnrecoverableError` to stop BullMQ re-running a
deterministic failure. BullMQ moves such a job straight to `failed` with `attemptsMade = 1` against
`attempts: 3`, so `isTerminalAttempt` returns **false** and the sink captures nothing. A terminal,
deterministic billing failure therefore produces no Sentry issue — precisely the invisibility class
#719 exists to close, reproduced in the mechanism built to close it.

I raise this on the **approach** axis because the cause is D4's decision ("two existing helpers were
about to be reinvented" → reuse rather than write). Reuse was right in spirit; what it imported was
a predicate whose contract is explicitly context-bound and annotated *do not unify*. The sibling
line-level reviewer will likely surface the same code from the other direction.

Secondary, lower confidence: the sink now fires alongside six per-domain `'failed'` hooks. That is
mostly good (durable state from the hook, issue from the sink), but for the judge queue the two
disagree on *when* terminal is, so a judge job produces a sink issue at 2/3 and the domain hook's
handling at 3/3. Fixing A2 resolves this too.

**And the channel it elevates does not honour the PII contract it cites (A6).** The sink's own
comment reads: *"a driver message may embed contact handles, and string logger arguments bypass the
object sanitizer. The full error still reaches Sentry, which has its own scrubber."* The first two
clauses are right; the third is not, for this repo:

- `worker/sentry.ts:12` wires `beforeSend → scrubSentryEvent(event, { scrubRequestData: true })`.
- `scrubSentryEvent` (`sentry-scrub.ts:269-281`) walks `event.extra`, `event.request`,
  `event.transaction` and `event.breadcrumbs`. It never touches `event.exception.values`.
- `captureException(err)` puts the raw message in exactly that untouched field.

Two aggravating factors. First, `attachJobFailureSink` is attached to **every** queue, so this is a
new cross-queue egress path — `sendNotification`, `sendOwnerEmail`, `solicitationBatch` are the
queues whose provider and driver errors most reliably quote a recipient address. Second, the
breadcrumb this replaced *was* passed through `scrubBreadcrumb`, which redacts sensitive paths and
query strings in `breadcrumb.message`. So on this specific axis the branch is a net regression: it
removes the only treatment job-error text received and substitutes none.

Server-side Sentry data-scrubbing may catch some of it, but that is a dashboard setting, not a
code-level contract, and the repo elsewhere refuses to rely on it (which is why
`scrubSentryEvent` exists at all). The fix is small and stays inside the sink: capture a bounded
diagnostic error (name + a redacted message, or `redactSensitivePathsAndQueries` applied to the
message) with allowlisted structured metadata, and add email / token / provider-body / nested-cause
cases to the sink's suite.

### 2.5 Deleting rather than porting the day_30 admin branch (→ A4)

The deleted branch was:

```sql
SELECT name FROM users WHERE role = 'admin' AND business_id = ${business.id} LIMIT 1
```

Its post-034 rewrite would be `u.account_id = b.account_id AND u.role = 'admin'`. The justification
is "admins carry `account_id IS NULL`, so no rewrite could match." I checked that against the data
model rather than accepting it, and it does not hold as stated:

- `users.account_id` was added nullable by 034 and is **not** `NOT NULL` (`039` reverted the
  problematic NOT NULLs).
- 034 §5d backfills it *from the column being dropped*, with **no role filter**:
  `UPDATE users u SET account_id = b.account_id FROM businesses b WHERE u.business_id = b.id AND u.account_id IS NULL`.

So any admin row that had `business_id` set — precisely the rows the deleted branch selected —
received a non-NULL `account_id` during 034. Whether such rows exist in prod is a data question the
branch never asks; a single `SELECT count(*) FROM users WHERE role='admin' AND account_id IS NOT NULL`
settles it.

Mitigating, and why this is Low rather than Medium: the branch has been *dead* since 034 (the
42703 killed the whole day_30 email), so deleting it cannot regress observed behaviour; the fallback
chain still yields `onboarded_by` or `null`; and the field is a cosmetic sign-off name. The cost is
that a factually wrong data-model claim is now enshrined in a code comment, in CONTEXT.md-adjacent
prose, and in a test title — and "admins have no account" is exactly the kind of claim that gets
reused later for something that *is* load-bearing, like an access-control scope.

### 2.6 Was the repo-wide column audit correctly declined? (→ A5)

**The decision is defensible; the stated cost is not.** I measured the exposure rather than
asserting it. Every `DROP COLUMN` in the tree:

| Migration | Columns dropped | Live (non-test) readers today |
|---|---|---|
| `022_sms_channel_infra` | `businesses.notification_preference` | none (one migration-shape test) |
| `034_multi_location_schema` | `users.business_id` | **3 — the subject of this ticket, now fixed** |
| `103_drop_legacy_backfill_counters` | 4 backfill counters on the zernio job table | none (migration-shape + assertion-list tests) |

So after this branch the 42703 class is **empty** across the repo. A per-feature live-DB suite is a
proportionate answer to the *current* exposure, and I would not block on this.

What the decision leaves open is the *forward* guard. 103 dropped four columns three weeks ago; the
pattern is active, and nothing prevents the next one repeating a three-month invisible outage in a
worker that has no live-DB suite (most of them). The audit that was declined is: extract
`DROP COLUMN` names from `supabase/migrations/`, grep `src/` + `worker/` for each, allowlist the
migration-shape tests. That is ~40 lines and green today — it would have caught #719 on the day 034
landed. Calling it "epic-sized" is the part I dispute, not the deferral itself.

### 2.7 The parts of the approach I checked and found sound

Stating these because an empty finding is a useful result, and several of the locked decisions
survive scrutiny cleanly:

- **Defect A's fix is the right shape.** Collapsing `ownerHasDashboardAuth` + `buildDashboardUrl`
  into one `resolveDashboardUrl` removes a two-call protocol where the caller had to remember to
  combine them, and the `!appUrl` early return is a genuine simplification (the old pair always ran
  the query then discarded it). Both `u.role = 'owner'` and the account join are load-bearing and
  correctly justified. I found **no** remaining `users.business_id` reader anywhere in `src/`,
  `worker/`, `scripts/` or `e2e/` — the three-site claim holds.
- **Rolling over lifetime (decision #4)** is right on the merits, independent of the 93-row
  rationale: a lifetime cap converts a provider blip into permanent loss, which is the failure mode
  the ticket exists to avoid.
- **`COALESCE(completed_at, dispatched_at, created_at)`** is correct and non-obvious — I confirmed
  both writers disagree as documented (`OutboxPoller.ts:137-149` stamps `completed_at`; the
  dispatch-error path at `:287-299` does not, and the claim UPDATE refreshes `dispatched_at`). The
  three-way COALESCE with a test (title 17) pinning the middle term is good work.
- **The `db`-not-`exec` parameter naming (D11)** is a real trap correctly identified: renaming the
  tag would have made a deliberate cross-tenant sweep invisible to `ci:tenant-scope` and turned its
  allowlist entries into apparent dead code.
- **Global-count contamination discipline in the scheduler suite** (assert deltas, never absolutes,
  hold `acquireLiveDbLock`) is the correct pattern for a subject that sweeps shared tables.
- **Cutting the `last_error` write (D3)** returned scope to what was signed off rather than removing
  signed-off scope; the four supporting reasons are each verifiable and correct.

---

## 3. Recommended dispositions

| Finding | Disposition |
|---|---|
| A1 | Add a fail-closed staleness pre-flight in `handleOnboardingDrip` before the drip-log claim, `markOutboxCompleted` with a logged reason. In-scope, ~6 lines. If the owner prefers to accept the gap, record *why* #719 differs from #679 in CONTEXT.md's **Drip staleness cap** entry — right now it reads as if the question was never asked. |
| A2 | Use an event-context terminal predicate in the sink — `judge/failed-hook.ts`'s `attemptsMade >= maxAttempts`, plus an `UnrecoverableError` / `finishedOn` arm so early-terminal jobs are not missed. Add the `{attemptsMade: 2, attempts: 3}` and first-attempt-`UnrecoverableError` cases. Do **not** unify the two helpers — the processor-catch one is correct where it is. |
| A6 | Capture a bounded diagnostic error rather than the raw `Error`, or extend `scrubSentryEvent` to walk `event.exception.values`. Either way, correct the sink's comment: this repo's scrubber does not cover exception values. Tests: email in message, token in message, nested `cause`. |
| A3 | Either a durable skip record (`onboarding_drip_log` row with `sent_at IS NULL` + reason) or a `HealthAlertPoller` check on the too-late count. Follow-up is acceptable **if filed**; silent is not. |
| A4 | One query against staging/prod to settle whether business-scoped admins carry an `account_id`; correct the comment either way. |
| A5 | Keep the deferral, drop the "epic-sized" framing, and record the measured exposure (three drops, one reader, now zero) so the next reader can re-decide on numbers. |
| — | Verify the `OutboxPoller.ts` follow-up issue D3 says is filed actually exists; I could not find it via `gh search issues`. |

---

## 4. Codex raw verdict

Dispatched via the `codex:adversarial-review` skill (background), base `bea12e68`, focus files
`.feature/intake.json`, the deviations doc and the plan.

Reproduced verbatim.

```
# Codex Adversarial Review

Target: branch diff against bea12e68
Verdict: needs-attention

No ship: the drip path can send late or duplicate emails, while the new global failure sink
misidentifies terminal attempts and can export raw customer data to Sentry.

Findings:
- [high] Failed-event sink uses a pre-failure attempt predicate (worker/job-failure-sink.ts:32-44)
  BullMQ increments attemptsMade before emitting the Worker 'failed' event, but this listener calls
  isTerminalAttempt, whose attemptsMade + 1 branch is intended for processor catch blocks. A default
  3-attempt job is therefore reported as exhausted on attempt 2 even though it will retry; if
  attempt 3 succeeds, Sentry retains a false terminal incident. Conversely, an UnrecoverableError
  that terminates early can be missed because attemptsMade remains below the configured maximum.
  Recommendation: Use a failed-event-specific terminal predicate based on BullMQ's post-transition
  state, such as finishedOn or an awaited state check. Add tests for 2/3, 3/3, successful final
  retry, and first-attempt UnrecoverableError.
- [high] Global sink sends unsanitized exception values to Sentry (worker/job-failure-sink.ts:36-44)
  The sink captures the original Error object. The repository explicitly notes that database error
  messages can contain contact handles, while scrubSentryEvent only sanitizes extra, request,
  transaction, and breadcrumb fields—not event.exception.values. Attaching this to every worker
  therefore creates a new cross-queue path for customer PII or tokens embedded in exception messages
  to leave the application.
  Recommendation: Capture a bounded diagnostic error and allowlisted structured metadata instead of
  the raw exception, or implement and test exception-value redaction before globally enabling this
  sink. Include email, token-path, provider-body, and nested-cause cases.
- [high] Staleness is checked only when enqueueing, not when sending
  (worker/background/schedulers/OnboardingDripScheduler.ts:107-125)
  The scheduler excludes work that is already stale, but an eligible row can remain pending or
  dispatched through a Redis, worker, or provider outage. On recovery, OnboardingDripWorker never
  rechecks the deadline and sends it regardless of its current age. This directly violates the
  focused intake's promise that a drip past the grace window is never sent and still permits the
  late-email burst this change is intended to prevent.
  Recommendation: Carry or derive an authoritative max_send_at and revalidate it against the
  database clock immediately before the provider side effect. Complete expired work with an
  observable reason and add a delayed-execution integration test.
- [high] Drip delivery is not idempotent across ambiguous sends or DB failure
  (worker/jobs/OnboardingDripWorker.ts:168-192)
  sendInternalEmail supports a deterministic provider idempotencyKey specifically for timeout/retry
  ambiguity, but this call omits it. If Resend accepts the email and the request times out, or a
  post-send DB write fails, the same outbox retry can retake its claim and send again. Separately,
  sent_at can commit before notification_deliveries fails; the retry then observes the drip as sent
  and completes without restoring the missing delivery audit.
  Recommendation: Pass a stable logical key such as onboarding_drip:<businessId>:<dripType>, and
  commit sent_at, notification delivery, and attempt-guarded outbox completion in one transaction
  after provider success. Test accepted-but-timeout and failure after each bookkeeping write.

Next steps:
- Fix the four blockers and add the missing retry, delayed-execution, terminal-boundary, and PII
  tests.
- Per deviations D13, let #729 land first, then rebase, recompute the tenant-scope baseline, and
  rerun the full review gate and staging ride.
```

**How I treated it.** Codex's blockers 1 and 3 are A2 and A1, reached independently — I had written
both before its report landed, from the `judge/failed-hook.ts` "do not unify them" comment and the
#679 chokepoint precedent respectively. Blocker 2 is **new to me**; I verified it against
`worker/sentry.ts:12` and `sentry-scrub.ts:269-281` before adopting it as A6, and the "the branch
removes the breadcrumb scrub and adds nothing" framing is mine. Blocker 4 (send idempotency) is
pre-existing behaviour on a code path this branch touched but did not decide — I have **not** taken
it into my table; it belongs to the sibling spec/correctness reviewer, and its "Recommendation"
would materially expand this branch's surface if adopted here.

Its `pnpm vitest run worker/__tests__/job-failure-sink.test.ts` exit-1 is unexplained in the log and
may be environmental; the sibling reviewers own whether it is real. Its closing "let #729 land
first" is D13's already-recorded sequencing, not a new finding.

---

## Appendix — below the confidence bar

Recorded for completeness; **not** findings, and I would not act on any of these without more
evidence.

1. **Decision #5's evidence proves only half the fix.** The 93 staging rows belong to locations whose
   drips are months overdue, so post-fix they are excluded by the *staleness* cap before the churn
   cap is ever consulted. The "after" state therefore demonstrates the staleness cap and says nothing
   about the churn cap, which ships unexercised by the data that motivated it. Correspondingly, the
   stated rationale for rolling-over-lifetime ("so the existing 93 rows would not block the ride") is
   redundant — staleness already excludes them. Rolling is still the right choice for other reasons
   (§2.2). Held back because I cannot query staging from here to confirm the activation dates.
2. **Decision #1, bundling A+B+C.** A is a production hotfix for a three-month customer-visible
   outage (three workers, drip emails + dashboard links); B and C are hardening. Bundling put the
   hotfix behind a 3,210-line branch, 13 deviations, two surface amendments and a high-RISK dual
   review — and if any round forces a re-plan on B or C, A rides along. Against that: A had already
   been broken for three months, and B/C touch the same file and the same incident, so the review
   cost is largely shared. Genuinely arguable both ways; I do not stake a position.
3. **Sentry as a third party.** Retention, quota and outage characteristics now bound the *only*
   record of a handler error. Worth a sentence in the runbook, but `SENTRY_DSN` is already a boot
   gate (`assertAlertSinkEnv`) and `captureException` is not trace-sampled, so this is posture, not
   a defect.
4. **Sink tags.** The intake specifies `{queue, topic}`; the sink emits `{subsystem, queue}`. Almost
   certainly the line-level reviewer's, and the topic is derivable from the queue.
5. **µs truncation on `asOf`.** `subscription_activated_at` carries microseconds; a JS `Date` does
   not, so a boundary fixture is a value production never produces. Harmless because every
   comparison is a half-open range rather than an equality — but it is the documented #520 class and
   worth a glance if an equality is ever introduced here.
6. **Recurrence guard breadth.** The suite covers `resolveDashboardUrl` (shared by all three
   workers) and the three `handleOnboardingDrip` branches. `WeeklySummaryWorker` and
   `MonthlyImpactWorker`'s *own* queries remain unit-tested against a mocked `sql`. Correct per the
   locked scope; noted so nobody later reads the guard as covering those workers.
