# feat-898 solicitation send governors — adversarial approach review, round 1

Scope: the **chosen approach, design choices and assumptions**. Correctness and
standards are owned by sibling agents and are not duplicated here. Read-only on
production code.

Inputs read: `git diff main...HEAD` (34 files), `.feature/intake.json`,
`docs/superpowers/plans/2026-08-19-solicitation-send-governors.md`,
`…-deviations.md`, `docs/superpowers/specs/2026-07-28-sender-deliverability-design.md`
§3.2/§4, `…-send-mode-cross-spec-amendments.md`, `gh issue view 898/899/900`,
plus the surrounding code the design depends on
(`worker/background/pollers/HealthAlertPoller.ts`,
`worker/background/pollers/health-alert/checks.ts`,
`src/lib/solicitation/outreach.ts`, `src/lib/agents/read.ts`,
`src/lib/shared/subscription-status.ts`, `src/lib/solicitation/batch-builder.ts`,
`worker/ingress/resend/solicitation-lane.ts`).

---

## Findings

| # | Severity | Area | Finding |
|---|---|---|---|
| 1 | high | Decision 5 / breaker recovery | Breaker recovery is arithmetically unreachable — no operator action can clear a breach, and runbook §8.3's documented procedure cannot work |
| 2 | high | Decision 3 + 72h send window | One trip almost certainly cancels every in-flight approved batch platform-wide; neither spec, plan nor runbook §8 says so |
| 3 | high | Decision 6 / paging | The breaker pages exactly once per trip and has no other live signal — one dropped Sentry message is a silent, permanent, platform-wide halt |
| 4 | high | Breaker read model | `readBreakerWindow` has no `WHERE`, so it seq-scans all of `solicitation_outreach` every 5 min; `idx_solicitation_outreach_sent_at` cannot serve it and migration 110's rationale is wrong |
| 5 | high | Decision 6 / poller shape | The breaker is the only WRITE in a module contracted "No writes", placed last in a shared-fate sequential chain — a breaker write failure discards every other health finding for that cycle |
| 6 | high | Decision 2 | "The row stays `rendered`" is not achievable: #900 CASes `rendered → queued` before #899's Dispatch gate runs, so a subscription deferral strands a `queued` row that the release predicate can never see again |
| 7 | medium | Decisions 2 + 6 / diagnosability | Every governor withholds invisibly and all of them converge on `send_window_elapsed`, so "why did this batch not send" is unanswerable and a billing-caused non-send is misreported to the owner |
| 8 | medium | Account cap counting basis | Counting `queued_at` means children withheld at the Dispatch gate burn cap slots without spending any reputation — 10 suppressed contacts can consume an account's whole day |
| 9 | medium | Decision 7 / admin surface | The panel shows only the frozen trip snapshot; there is no live-window read, so the operator has no instrument before or below a trip and the reset becomes the only probe |
| 10 | medium | Account cap resolver | `LEAST(configured, 10)` deletes spec §4.3's stated escape valve ("an admin can raise it without a deploy") while the 1..50 schema CHECK still advertises it |
| 11 | medium | Unwired increment | The locked gate ORDER (breaker → ceiling → cap → per-child) is listed as an invariant but has no code owner and no test — three loose functions, ordering left to #900's prose |
| 12 | medium | Cap concurrency | The caps' only concurrency defense is the single-replica invariant, which CLAUDE.md states is **detected, not enforced**; the counters offer no reservation |

---

## Detail

### 1 — HIGH — Breaker recovery is arithmetically unreachable (Decision 5)

**The claim under attack.** `send-breaker.ts` and runbook §8.4 both assert that
resetting a still-breached window is "permitted and correct", because "the
operator may have just rolled the platform ceiling down", and §8.3 makes that a
numbered procedure: *step 3 roll `SOLICITATION_PLATFORM_DAILY_CAP` down one
stage → step 4 only then reset*, with the gloss "A reset with the ceiling
untouched is a reset that will re-trip."

**Why the reasoning does not hold.** The breaker window is a pure function of
*history*. Rolling the ceiling down changes only *future* volume. While the
breaker is open **there are no future sends at all** (#900 halts on
`readSendBreaker`), so nothing an operator does can move the measured ratio.

Worse, the asymmetry the design chose makes the ratio monotonically *worse*
while sending is halted. Let `T0` be the trip. At `T0 + Δ` the window is
`[T0+Δ-7d, T0+Δ]`:

- the denominator is the suffix of the original send set whose `sent_at` still
  falls in the window;
- the numerator is the suffix of the bounce/complaint set whose `bounced_at` /
  `complained_at` still falls in it.

Because signals lag their sends (the explicit justification for signal-dating),
truncating the left edge removes proportionally **more sends than signals**. So
`rate(Δ) ≥ rate(0)` for all Δ, until the denominator drops under
`BREAKER_MIN_SENDS` and the floor suppresses the trip entirely.

**Consequence.** An operator who follows §8.3 verbatim gets a re-trip within one
`HEALTH_ALERT_POLL_INTERVAL_MS` (≤5 min), *every time*, and is told by §8.4 to
read that as "the window has not recovered yet" — which it never will, because
the only thing that could dilute the ratio is new sends and the breaker forbids
those. §8.4's stated escape ("if you need sending stopped while you work, use
`SOLICITATION_PLATFORM_DAILY_CAP=0` or `SOLICITATION_SEND_ENABLED=false`") is
circular: those are ways to *keep* sending stopped, which is already the state.

The real recovery paths are only two, and neither is documented:

1. wait roughly `BREAKER_WINDOW_DAYS` for the breaching signals to age out; or
2. wait until the denominator falls below 100, at which point the breaker
   becomes structurally unable to trip and sending resumes with **zero**
   reputation governance until 100 new sends accumulate.

Path 2 is the ugly one: the design's safety floor becomes a blind restart
window immediately after the worst incident it exists to catch.

**What is missing conceptually.** A circuit breaker normally has a *half-open*
state — a bounded probe that lets a small volume through so the metric can
recover. §3.2B's "never self-clears" ruled out auto-recovery, which is
defensible; but nothing replaced the probe, so the manual reset inherited a job
it cannot do. Candidate shapes worth an owner decision (not a preference — the
point is that *some* escape must exist): a reset that stamps a `measure_from`
watermark so the post-reset window only counts post-reset sends; an operator
supplying an explicit "probe ceiling" with the reset; or a documented,
honest "the breaker cannot clear before <date>, here is the calculation" on the
admin page. Today the design has no answer and the runbook asserts one that is
false.

*Confidence: very high. This is arithmetic over code I read, plus the runbook's
own words.*

---

### 2 — HIGH — A trip probably destroys every in-flight approved batch

`BATCH_SEND_WINDOW_HOURS = 72` (`src/lib/solicitation/outreach.ts`), anchored on
`approved_at`. #900 §6 owns the `send_window_elapsed` latch: "applied to what is
overdue past the 72h send window."

Combine with finding 1: an open trip realistically lasts days, not hours.
Every batch approved in the 72 hours before the trip — across **every account**
— either:

- **(a)** hits the releaser's expiry arm while the breaker is open (that arm is
  a separate tick duty in #900 §6, not part of the §4 release decision, so it
  most likely still runs) and terminalizes `cancelled / send_window_elapsed`,
  every remaining ask dead, every owner told "Send window elapsed"; or
- **(b)** #900 suppresses expiry while tripped, in which case the batches blow
  past the "≤10 days by construction" bound that
  `STALLED_THRESHOLD_SEND_BATCH_DAYS = 11` is derived from, and the
  `solicitation_send_batch_stalled` alert fires for every one of them — the
  alert whose entire justification is "11 days is past a bound that *cannot be
  reached*".

Both horns are bad and neither is discussed anywhere in the branch.

Note the design *already* reasoned about this shape for a narrower case: #900 §5
says that if the Judge never returns, "the 72h send window expires and the batch
terminalizes cancelled with `send_window_elapsed`. Fail-closed, never a silent
send." That is an accepted trade for a transient, per-account condition. It was
not carried across to a platform-wide halt whose expected duration is measured
in days.

**The gap to close is a statement, at minimum.** Runbook §8 currently describes
the breaker as "halts all solicitation sending". The honest description is
"halts all solicitation sending, and cancels every approved batch that does not
resume within 72 hours of its approval; owners must rebuild". If that is not
acceptable, the breaker needs a companion decision — e.g. the halt pausing the
send-window clock, or the trip latching batches with a distinct reason so the
cause survives.

*Confidence: high. Depends on #900's unbuilt expiry arm, but both branches of
that choice produce a documented problem.*

---

### 3 — HIGH — One page per trip, one sink, no liveness signal

`evaluateSendBreaker` returns `null` when the `ON CONFLICT … DO NOTHING` finds a
trip already open. That is deliberate ("it pages ONCE, not every five minutes"),
and it is the right call *against alert fatigue*. But it leaves the system with
exactly one alert-shaped event for a condition that stops the entire product
line and never self-clears.

The failure chain that has no defense:

1. `emitHealthFindings` calls `Sentry.captureMessage` once. Sentry is down /
   rate-limited / over quota / the routing rule is misconfigured. The message is
   lost. `emitHealthFindings` has no delivery confirmation — the finding was
   already inserted as a trip row before the emit.
2. No subsequent tick re-emits, by design.
3. #900 halts every send, silently — no repeated finding, no per-batch record,
   nothing in `job_outbox`, nothing in `account_audit_log`.
4. Batches begin expiring at 72h (finding 2).
5. Nobody learns until an owner complains or someone opens `/admin/solicitation`
   — a page with no reason to be visited when nothing has paged.

Note the alerting runbook's own first bullet warns about exactly this class:
Sentry issue-alert rules that "fire exactly once, ever, and then stay silent
through the very repetition that is the actionable signal." The breaker check
was inventoried under that rule while being the one finding that *deliberately*
fires once.

**Cheap mitigations that preserve the anti-fatigue intent** (owner's call):
re-emit a `warning`-level `solicitation_send_breaker_open` finding on a decayed
cadence (hourly, or once per N ticks) while a trip is open; or make it a Sentry
Cron-style dead-man ("breaker open" as a persistent state rather than an event).
The distinguishing property to preserve: an open breaker is a *state*, and this
design models it as an *event*.

---

### 4 — HIGH — The breaker's read model seq-scans the whole table; the new index cannot help

```sql
SELECT
  COUNT(*) FILTER (WHERE sent_at      >= NOW() - …) ::int AS sends,
  COUNT(*) FILTER (WHERE bounce_kind = 'hard' AND bounced_at >= NOW() - …)::int AS hard_bounces,
  COUNT(*) FILTER (WHERE complained_at >= NOW() - …)::int AS complaints
FROM solicitation_outreach
```

There is **no `WHERE` clause**. Aggregate `FILTER` predicates do not restrict the
scan — Postgres must read every row `solicitation_outreach` has ever held, then
apply the filters. `idx_solicitation_outreach_sent_at` is unusable for this
query; it can serve no other reader in the branch either.

Migration 110's own comment gets this backwards on both counts:

> "Serves the breaker denominator, which is the only unbounded count in the
> 7-day window. The `bounced_at` / `complained_at` numerators are DELIBERATELY
> unindexed: at the top ramp stage … the window holds ~35k rows … so a bitmap
> scan is cheaper than two more indexes."

No bitmap scan is reachable here, and the relevant row count is not the 35k in
the window — it is the whole append-only outreach history (`solicitation_outreach`
is retained, per the migrations-log retention rows). At stage 5 that is ~1.8M
rows/year, seq-scanned ~105,000 times a year, forever growing.

This is not merely a perf nit: it compounds finding 5. The check is the last one
in a sequential chain bounded by `HEALTH_CHECK_TIMEOUT_MS = 30_000`, so it is
the check that starves first, and starving it silently disables the breaker
(finding 5's fail-open direction) while `readSendBreaker` keeps failing closed.

**Shape of the fix** (design-level, not a patch): give the statement a real
`WHERE` — `sent_at >= … OR bounced_at >= … OR complained_at >= …` — which makes
the partial `sent_at` index meaningful and lets the two "deliberately unindexed"
numerators become a real trade rather than a moot one. Then re-derive the
comment's cost argument from the restricted plan.

---

### 5 — HIGH — A write inside a "No writes" shared-fate poller, un-isolated, last in line

`worker/background/pollers/health-alert/checks.ts` opens with:

> "Read-only health checks … Each check issues ONE query against confirmed
> schema and compares to an env-tunable threshold, returning HealthFinding(s) or
> null. **No writes.**"

`checkSolicitationSendBreaker` breaks that contract — it is the only check that
mutates state, and the mutation is the platform's biggest kill switch.

Three consequences of that placement:

**(a) A breaker write failure suppresses every other alert.** `runHealthChecks`
accumulates into a local `findings` array and *rethrows*; the array is lost. A
`23505`, a lock wait, a constraint-name drift, an `ON CONFLICT` inference error —
any of these takes down the whole cycle, and with it the outbox-failed,
zero-delivery, stale-dispatching, owner-unreachable and flagged-backlog signals.
The comment two lines below the breaker call records that a *prior* adversarial
round forced `checkBacklogDepth` into its own `try/catch` for precisely this
reason. The riskiest check in the file — the only writer — was then added
outside that protection.

**(b) The evaluation path fails OPEN while the read path fails CLOSED.** The
branch is emphatic that `readSendBreaker` must throw rather than report an
unknown verdict. But the *tripper* is best-effort: a 30s cycle timeout, a
recycled client, an ordinary DB error, a dead poller — all mean "no trip this
cycle" while `readSendBreaker` continues to answer `open: false` happily and
#900 continues to send. The fail-closed guarantee only covers the cheaper half
of the mechanism. The Sentry Cron dead-man switch catches a *dead poller*, but
not a cycle that throws before reaching check #10.

**(c) Ordering.** The breaker is called tenth, after nine other queries, inside
the 30s bound. Given finding 4 it is also the slowest and the one most likely to
be cut. If the breaker is genuinely the platform's most important governor, it
should not be the last thing a degraded cycle gets to.

**Deeper question for the owner (Decision 6).** The trip write does not belong
to the alerting subsystem at all — alerting is a *consumer* of a domain fact.
Two shapes are worth weighing: (i) keep the poller as tripper but isolate it in
its own `try/catch` and hoist it near the front, accepting that a failed trip is
now visible as a `health_check_error:send_breaker` finding rather than silent;
or (ii) make evaluation its own small loop/duty with its own error handling, and
leave `checks.ts` genuinely read-only. Either preserves the "expensive aggregate
off the send loop" property the decision was actually protecting. What is not
defensible is the current arrangement, where the only writer is also the only
un-isolated check and the file says it does not write.

---

### 6 — HIGH — Decision 2's mechanics: the row cannot stay `rendered`

Three places assert the same mechanic — `.feature/intake.json` non-goals,
migration 110's header comment, and the migrations-log 110 entry:

> "a lapsed subscription defers at the child gate; **the row stays `rendered`**
> and `send_window_elapsed` terminalizes."

The sibling issues contradict it:

- **#900 §2** — the release transaction is
  `UPDATE solicitation_outreach SET delivery_status='queued' WHERE id=$1 AND delivery_status='rendered'` **plus** `enqueueSolicitationSend(...)`, in one transaction.
- **#899 §3/§5** — the Dispatch gate (item 3 = `subscriptionGrantsFullAccess`) is
  evaluated **inside tx1**, and tx1's shape is
  `lock batch row → evaluate the Dispatch gate → mint token → CAS queued → sending`.
  §3 item 7 confirms the row is already stamped: "the gate only asserts the
  release stamped `queued_at`."

So by the time item 3 runs, the row is `queued`, not `rendered`. A deferral has
only three possible implementations, and the design has picked none of them:

1. **Leave it `queued` and complete the outbox row.** #900's release predicate
   selects `delivery_status = 'rendered'`, so the row is invisible to every
   subsequent tick — it can never be retried even if the subscription recovers
   inside the window, and its only exit is `send_window_elapsed`. That defeats
   the entire stated rationale ("a lapsed subscription is recoverable inside the
   send window").
2. **CAS `queued → rendered`** — a backwards transition on a lifecycle the branch
   elsewhere treats as monotone, and one 091's lifecycle constraints were not
   designed for. It also un-stamps or double-stamps `queued_at`, which is the
   cap counting basis (finding 8).
3. **Throw and let BullMQ retry.** Retries are bounded; exhaustion lands on the
   failed-hook and writes `delivery_status='failed' / send_exhausted`, reporting a
   billing condition as a send failure — and burning the retry budget on a
   condition that resolves on a human timescale.

Decision 2's *policy* (defer rather than terminalize) may well be right. Its
*mechanics* are specified against a state the gate never sees. This needs
resolving before #899 starts, because it decides whether 110's CHECK really
needed no new member — option 1 and option 3 both argue it did.

---

### 7 — MEDIUM — Every governor withholds invisibly, and they all end in one reason

Enumerating what a non-send looks like in the database after this family lands:

| Cause | Row artifact | Terminal reason eventually written |
|---|---|---|
| Breaker open | none | `send_window_elapsed` |
| Platform ceiling reached | none | `send_window_elapsed` |
| Account daily cap reached | none | `send_window_elapsed` |
| Judge unhealthy mid-drip (#900 §5) | none | `send_window_elapsed` |
| Subscription lapsed (Decision 2) | none (see finding 6) | `send_window_elapsed` |
| Genuine releaser bug / poller dead | none | `send_window_elapsed` |

Six distinct causes, one indistinguishable outcome, and no intermediate record
for any of them. "Why did this owner's batch not send" is unanswerable from the
database, and support has no path other than correlating timestamps against the
worker log and the env-var history.

Two specific sharp edges:

- **Owner-facing misattribution.** `ApprovalPanel.tsx` renders copy per
  `halt_reason`; a batch killed by a billing lapse or a platform breaker shows
  the owner "the send window elapsed". That is factually wrong about cause and
  it is the only thing the owner is told.
- **The lane already owns the right vocabulary.** `closedGateReason` in
  `batch-builder.ts` returns `subscription_inactive` at the batch gate, using
  the *same* `subscriptionGrantsFullAccess` predicate. Decision 2 declines to
  reuse that name at dispatch. The same cause therefore produces a named,
  diagnosable outcome at one gate and a misattributed one at the other — inside
  one lane.

The withhold vocabulary was widened by exactly two members in this migration.
Adding "the reason a governor withheld" to *something* (a counter, a run-spine
step, a `disposition_reason`, an outbox note) is the cheapest possible fix and
the one that makes the other findings above debuggable at 3am.

---

### 8 — MEDIUM — `queued_at` counting lets non-sends burn cap slots

The counting basis is defended as: "a bounce still spent reputation, so #619
D9's `sent_at` counting is superseded." That argument covers rows that reached
the provider. It does not cover rows that never did.

A child stamped `queued_at` by the releaser can still be withheld by *any* of
#899's Dispatch gate items 1, 2, 4, 5, 6, 8, 9 — suppression, missing/expired
consent, `no_postal_address`, `postal_address_mismatch`, lint failure, moderation
failure. None of those spends a byte of reputation, and all of them consume a
cap slot for the UTC day.

With `DEFAULT_DAILY_SEND_CAP_ACCOUNT = 10`, ten suppressed or consent-lapsed
contacts at the head of a batch consume an account's entire day and produce zero
sends — and, per finding 7, no visible reason. Across a 25-ask batch and a 72h
send window this can plausibly consume the whole window without ever sending.

The counting basis is a locked amendment (B3) and the "release is the single
choke point" property depends on the count being cheap and pre-decision. Worth
stating explicitly as an accepted cost, or refining to "queued rows minus rows
that reached a terminal withheld disposition today" — the latter is one extra
predicate on a query that already exists.

---

### 9 — MEDIUM — The admin surface is a post-mortem, not an instrument (Decision 7)

`SendBreakerClient.tsx` renders `MetricsSnapshot` from `trip.metrics` only —
the JSONB frozen at trip time. When `open === false` there is no metrics block
at all.

Three consequences:

- **No early warning.** An operator cannot see that the platform is at 1.9% hard
  bounce and climbing. The only notification the design offers is the trip
  itself, which by findings 1 and 2 is an expensive, days-long, batch-destroying
  event. A `warning`-level finding at, say, 75% of each threshold would convert
  most trips into a human-paced ramp rollback — which is precisely what §5's ramp
  table already asks a human to do manually before each stage.
- **No pre-reset read.** §8.3 tells the operator to decide whether to reset, but
  gives them nothing to decide *with* except a snapshot that is by construction
  stale. The reset becomes the probe — and each probe re-trips and re-pages
  (finding 1).
- **Nothing to check after "is it safe yet?"** There is no way to answer that
  question short of a DB session, and the runbook does not provide the query.

The page already server-renders from `sql` and already imports the module that
owns the read model. Surfacing a live `readBreakerWindow` alongside the frozen
snapshot is a small addition that closes all three. (`evaluateSendBreaker`
cannot be reused for that — it writes.)

Related interface point: `evaluateSendBreaker` returns `null` for *both*
"healthy" and "breached but a trip is already open". Any future caller — an
admin "re-evaluate" button, a #900 diagnostic, a lower-cadence re-page for
finding 3 — cannot distinguish them. The verdict and the paging concern are
fused in one return type.

---

### 10 — MEDIUM — `LEAST(configured, 10)` removes the spec's escape valve while the schema advertises it

Spec §4.3, on the account cap:

> "**Nullable per-account override** resolved through a
> `resolveSolicitationDailyCap()` twin of the existing `resolveDailyCap()`, **so
> an admin can raise it without a deploy**."

`resolveAccountDailySendCap` implements `Math.min(configured, 10)` — "the dial
moves toward restraint only" — and `auto_approval_policies.daily_send_cap` keeps
migration 091's `CHECK (… >= 1 AND … <= 50)`.

Net effect: the 11–50 range of a live schema constraint is now dead. An admin can
store 25 and nothing happens, nothing warns, and nothing records that the value
was clamped. Raising any account's cap now requires editing
`DEFAULT_DAILY_SEND_CAP_ACCOUNT` and deploying — the exact property §4.3 named as
the reason for the override to exist.

There is no UI writing the column today, so this is not a live UX defect; it is a
capability the spec designed for and this branch quietly removed. Either the
schema CHECK should narrow to 1..10 so the database stops advertising a range
the code ignores, or the clamp needs an explicit "yes, we gave this up and here
is what replaces it" record. (The docstring argues the clamp's *safety*, which is
not in dispute; it does not address the capability it costs.)

---

### 11 — MEDIUM — The locked gate ORDER has no code owner and no test

`.feature/intake.json` lists as an invariant:

> "Gate order is fixed: breaker then platform ceiling then account cap then
> per-child (#622 §4.3)."

Nothing in the branch encodes it. #898 ships four independent exported functions
plus a fifth in a different module; the ordering lives only as prose in three
documents (#622 §4.3, the intake, #900 §4). In a repo whose standing doctrine is
"one authoritative owner per fact" and which enforces byte-for-byte contracts
via `ci:outbox-status` and `ci:outbox-seam`, an invariant with no owner and no
test is the drift risk.

This is the concrete answer to "is shipping three modules with no production
caller the right increment?" — the increment is fine (the semantics are pinned
by tests and the spec is locked), but the *composition* was left out, and the
composition is where the invariant lives. A single
`evaluateSendGovernors(sql, accountId, platformCapRaw)` returning a discriminated
withhold verdict would give the order one owner, give #900 one call site instead
of three, and give finding 7's missing diagnosability a natural home (the verdict
names which governor withheld). It would also be a *deeper* module than three
shallow counters — the shape `codebase-design` would ask for.

Secondary drift signal already visible: `resolveAccountDailySendCap` takes
`{ dailySendCap: number | null }`, a shape no query in the repo produces. The
read that feeds it is #900's to invent.

---

### 12 — MEDIUM — The caps' only concurrency defense is a detected-not-enforced invariant

`countAccountDispatchAttemptsToday` / `countPlatformDispatchAttemptsToday` are
bare `COUNT(*)`s with no reservation, no advisory lock, and no atomic
check-and-increment. Amendment B3 replaces reservation machinery with "a single
loop on the single-replica worker, serialized by construction", and #900's P2
backlog entry carries the condition ("if the releaser is ever parallelized, the
single-choke-point cap resolution must be revisited").

The gap is that CLAUDE.md is explicit: *"The worker is single-replica by
invariant — **DETECTED, not enforced**."* Replicas register in Redis and
`HealthAlertPoller` pages when >1 is live — the same 5-minute poller, with the
same failure modes as finding 5. A Railway scale-up, a deploy overlap, or a
stuck old container therefore overshoots both the account cap and the platform
ceiling by up to the replica factor, and the only backstop is a page that may
arrive minutes later.

That is an acceptable posture for most of the worker. It is a weaker posture for
the two governors whose entire purpose is to be the blast-radius bound on real
email to real customers, and it is worth an explicit owner acknowledgement rather
than a doc note on a backlog file. The cheap hardening is a transactional
advisory lock around the release decision (`pg_advisory_xact_lock` on a fixed
key), which costs nothing on one replica and makes the cap true on two.

---

## Answers to the questions posed

**"Does Decision 2 wedge anything?"** — Not the things you named, but for a
reason worth writing down. `BATCH_SEND_WINDOW_HOURS = 72` + the 7-day approval
window bound a batch at 10 days by construction, and
`STALLED_THRESHOLD_SEND_BATCH_DAYS = 11` was chosen against exactly that bound —
so a deferred row cannot reach the stalled-run alert, and `closeBatchIfSettled`
correctly keeps the batch open because a `rendered`/`queued` row is non-terminal.
The one-live-per-ask index holds the ask's slot for up to 72h, blocking
regeneration for that ask, which is correct behaviour rather than a wedge. **No
wedge — but see finding 6: the state it defers into is not the one the design
says, and see finding 7: it is not distinguishable from a genuinely stuck row.**

**"Is a poller-driven breaker the right shape?"** — The 5-minute *trip* latency
is not the interesting risk; ~17 sends at stage 5 is a rounding error against a
2%-of-100 threshold. The real problems with Decision 6 are the ones latency
hides: the trip is best-effort while the read is fail-closed (finding 5b), a
write sits in a read-only shared-fate chain (finding 5a), and the aggregate the
poller runs is unbounded (finding 4). Fix those three and 5 minutes is fine. A
read at release time would not help — the releaser is already a pure reader of
the latch, and moving the aggregate onto the send loop is the thing the decision
correctly avoided.

**"Can a ratio > 1.0 break anything downstream?"** — Not mechanically. It is a
JS `number` into JSONB, `formatRate` renders "312.00%", the `alert` styling
predicate is a `>` comparison, and no consumer divides by it. **The consequence
is not a ratio > 1.0 — it is finding 1**, which is the same asymmetry seen from
the recovery side rather than the detection side.

**"Is fail-closed under a DB outage right, and can the throw be swallowed?"** —
The posture is right, and `readSendBreaker` is written so the throw cannot be
swallowed *by the module*. Two caveats: the admin GET route catches it and maps
to 500, which is correct but means the panel says "error" when the honest
statement is "sending is halted because we cannot measure"; and the throw only
governs the read half — the *trip* half fails open under the same outage
(finding 5b). Fail-closed-on-read plus fail-open-on-trip is a weaker guarantee
than the branch believes it has.

**"Is shipping unwired modules the right increment?"** — Yes for the modules; no
for what was left out. See finding 11: the increment omitted the one artifact
that owns the locked invariant.

**"What did the owner not think about?"** — Findings 1, 2, 3 and 4 are the ones
I would put in front of the owner first. Multi-region is a non-issue (one Railway
worker, one Postgres); clock skew is a non-issue (every boundary is DB `NOW()`);
the seed-inbox gate is structurally below `BREAKER_MIN_SENDS` so the breaker
cannot protect it — intentional, but state it; migration 110 is correctly marked
LOCAL-ONLY with promotion on step 8 and touches no table the 078 prod exception
covers; and the per-account **Governor** (autonomy suspension) and the **Judge**
do not collide with the send breaker — but all three, plus the caps, now share
the property in finding 7 of stopping work without leaving a trace.

---

## Low-confidence appendix (below the 80% bar — recorded, not asserted)

- **`bounce_kind` COALESCE could pin `'soft'`.** If Resend can emit a transient
  `email.bounced` and later a permanent one for the same `email_id`, the
  `COALESCE(bounce_kind, …)` write keeps `'soft'` and the breaker under-counts a
  real hard bounce — the fail-open direction the column exists to close. The
  COALESCE is defended as redelivery-idempotence, which is a different case from
  a genuine escalation. I did not verify Resend's event sequencing, so this is
  below the bar; it is worth 10 minutes against the provider docs.
- **`metrics` JSONB is persisted camelCase** (`hardBounceRate`) while the
  `HealthFinding.detail` beside it is snake_case (`hard_bounce_rate`). Persisted
  JSONB keys are a schema decision that is expensive to change later, and any
  future SQL reader (`metrics->>'hardBounceRate'`) will be the odd one out
  against the rest of the database.
- **`HealthFinding` imported from `worker/` into `src/lib/`** — dependency
  direction inverted, `src/lib` has never depended on `worker/` before. Already
  triaged in the deviations log (entry at line 432, ACCEPT WITH FLAG) and
  explicitly referred to the standards agent; not re-raised here. The
  design-level residue is folded into finding 9's last paragraph
  (`evaluateSendBreaker` fuses verdict and paging).
- **Reset has no rate limit beyond AAL2.** An admin can reset in a loop; each
  reset appends a row and each subsequent tick appends another trip and pages.
  Bounded by the poll interval and by an admin's patience, so probably not worth
  a control — but it is the natural consequence of finding 1, since the operator
  is being told to do something that cannot work.
- **Migration 110 takes ACCESS EXCLUSIVE for the CHECK swap and a non-CONCURRENT
  `CREATE INDEX`.** Harmless at today's volume with `lock_timeout = '10s'`;
  worth a note for whoever writes the next `solicitation_outreach` migration at
  ramp stage 5.
