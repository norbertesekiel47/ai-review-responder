# Evidence — G.3 alerting acceptance drills

Runbook: [`docs/runbooks/beta-launch-alerting.md`](../beta-launch-alerting.md) **§4**
Protocol box: `docs/runbooks/beta-production-standup.md` → **Phase G, G3**

> **STAGING ONLY.** §4 is explicit and the stand-up repeats it: production gets safe
> synthetic canaries and **never** failure injection, worker stops, or cost-cap exhaustion.

---

## Environment

| Field | Value |
|---|---|
| Environment | **staging** |
| Supabase project | `kubdiqdhqbhwmqfditeg` (*RepWorth-staging*) |
| Production project | `udeyaqnvpojbwgoaxwdg` — **NEVER touched by this campaign** |
| Worker | `https://repworth-worker-staging.up.railway.app` |
| UI | `https://staging.repworth.net` |
| Railway | project `ad641d0e-dc01-4250-b71c-db1beedb9c8c`, service `repworth-worker`, env `staging` |
| Stripe mode | **test** (`acct_1TUcR7IhPBLaM6xA`) — not exercised by §4 except the cost-cap drill |
| Git SHA at start | **`589153f567f9d017723101f2e05f166fe83e9c01`** |
| UTC start | **2026-08-31T21:02:33Z** |
| Paging sink | Sentry `repworth-staging` → **Discord** channel `1517968864724385822` |

**Live-surface posture.** No Google Business Profile posting is exercised. The cost-cap
drill (§4.4) touches a paid provider through a draft generation and is scoped to staging
credentials only.

---

## Preflight

| # | Check | Result | UTC |
|---|---|---|---|
| P1 | Staging worker reachable | ✅ `/api/health` = `ok` | 21:02:33Z |
| P2 | `HealthAlertPoller` running at designed cadence | ✅ `interval_ms: 300000` (5 min) — §1b poller-resume already satisfied | 21:02Z |
| P3 | Staging Sentry project exists | ✅ `repworth-staging` | 21:02Z |
| P4 | **Staging alert rule routes to Discord** | ✅ rule **`3608329`**, action `Discord` integration `443670`, channel **`1517968864724385822`**, tag `repworth-staging`. Last triggered 2026-08-31T01:00:46Z | 21:03Z |
| P5 | Staging Discord channel is separate from production's | ✅ staging `1517968864724385822` vs production `1544045194264051842` — a drill cannot pollute the prod ops channel | 21:03Z |
| P6 | Alert-rule trigger set will catch drill findings | ✅ `First seen event` with `any-short` logic — each drill's new issue is first-seen. ⚠️ See **D-1** for the re-page drill (§4.5), which needs *repeat* notifications | 21:03Z |
| P7 | `job_outbox` baseline | ✅ `pending 0`, `failed 0`, total 49 | 21:01Z |
| P8 | `solicitation_send_breaker` baseline | ✅ `0` open (`reset_at IS NULL`) | 21:01Z |
| P9 | `solicitation_suppressions` baseline | ✅ **5 rows** — §4.6 adds exactly one more, permanently (no expiry, no ordinary delete path, by design) | 21:01Z |
| P10 | Burst-drill script present | ✅ `scripts/burst-drill-load.ts` | 21:02Z |
| P11 | Alert thresholds resolved from code, not assumed | ✅ `pendingAgeThresholdS` **900**, `failedThreshold` **0** / `failedWindowS` **3600**, `backlogDepthThreshold` **1500**, `zeroDeliveryWindowS` **3600** | 21:04Z |
| P12 | **§4.1 fixture is claimable by the OutboxPoller** | ❌ **BLOCKED — see D-1** | 21:05Z |

---

## Deviations log

### D-1 (2026-08-31T21:05Z) — §4.1 "Stuck outbox" CANNOT fire as written. Runbook defect.

**The drill says:** insert a `job_outbox` row with `status='pending'` and
`available_at = NOW() - INTERVAL '20 minutes'`; expect `outbox_pending_age`.

**Why it cannot fire.** The health check and the dispatcher use the **same predicate**:

| Reader | Predicate | Cadence |
|---|---|---|
| `checkOldestPendingOutbox` (`health-alert/checks.ts:114`) | `status = 'pending' AND available_at <= NOW()` | **300 s** |
| `OutboxPoller` claim (`OutboxPoller.ts:221`) | `status = 'pending' AND available_at <= NOW()` … `FOR UPDATE SKIP LOCKED` | **5 s** |

Any row the alert would flag, the dispatcher claims **~5 seconds** after insert — 60×
faster than the alert can read it. The row then either dispatches real work, or, for an
unregistered topic, is written to `status='failed'` with
`last_error = 'Unknown topic: …'` (`OutboxPoller.ts:239-257`). Either way it is no longer
`pending`, so `outbox_pending_age` never fires.

**This is not a flaky drill; it is unrunnable in isolation.** The alert exists to catch
"dispatch backed up **or the OutboxPoller has stalled**" — so the only honest fixture is one
where dispatch is actually stopped.

**Proposed runbook fix (not yet applied — needs owner sign-off on the reordering):** merge
§4.1 into the worker-stop drill. Stop the worker (§4.7), *then* insert the aged `pending`
row, then restart and confirm `outbox_pending_age` fired on the first cycle after the row
became visible to a running poller. That also makes §4.7 and §4.8 do double duty instead of
being three separate worker interruptions.

⚠️ **Do not "fix" this by raising `HEALTH_ALERT_PENDING_AGE_S` or lowering the OutboxPoller
cadence.** Neither changes the race — the dispatcher's predicate is identical, so it wins at
any threshold.

### D-2 (2026-08-31T21:20Z) — **A RECURRING OPS FINDING PAGES NOBODY. Confirmed in PRODUCTION.**

**This is the most important thing this campaign produced, and it is not about the drills.**

§4.2 and §4.3 both fired correctly and both reached Sentry. **Neither produced a page.** The
staging rule's `lastTriggered` stayed at `2026-08-31T01:00:46Z` — 20 hours old — across both
poller cycles.

**Mechanism: issue GROUPING, not priority or routing.** `emitHealthFindings` calls
`Sentry.captureMessage(finding.title, …)`, and Sentry groups messages by their template. The
drill's finding therefore joined a **pre-existing group from June**:

| Issue | Title | True first seen | Occurrences |
|---|---|---|---|
| `REPWORTH-STAGING-9` | *1 publish_response job(s) exhausted retries and failed in the last 3600s* | **2026-06-27T10:45:42Z** | **29** |
| `REPWORTH-STAGING-G` | *1 completed approval notification(s) produced zero deliveries…* | pre-existing | 2 in window |

Both alert rules trigger on **state changes only**:

> Conditions: **First seen event**; Issue resolved; Reappeared event; Regression event — logic `any-short`

An ongoing group is none of those. So occurrence 2 through ∞ of any health finding is
**silent**.

**PRODUCTION HAS THE IDENTICAL DEFECT.** Verified by reading rule `3925256`
("Prod — four ops signals to Discord", created 2026-08-31T18:18:55Z in G.1):

> Conditions: **First seen event**; Issue resolved trigger; Reappeared event; Regression event

Its four `Tagged event` action filters are correct, and its Discord action is correct. **The
triggers are the hole.** The first time a given ops finding ever fires, it pages. Every
repeat is silent until somebody manually resolves the issue in Sentry.

**Why G.1 did not catch this, and what G.1 did prove.** G.1 verified routing with a **Send
Test Notification** and by API readback. A test notification is, by construction, a
first-seen event — the one case this rule handles. So G.1's conclusion *"four signals reach
Discord"* is true for a signal's **first** occurrence and false for every one after it.

**Why it matters more than it looks.** Health findings are the recurring kind by nature. A
growing backlog re-emits the *same* message every 5 minutes. Under the current rules the
operator gets exactly one page at the start and then silence — which is indistinguishable
from the problem having gone away, and is the precise failure mode the §4.5 breaker drill
exists to close for one signal while every other signal has it unfixed.

**Fix (UI work — the Sentry MCP has no create/update tool for alert rules).** Add a
frequency trigger alongside first-seen on **both** rules — e.g. *"The issue is seen more than
0 times in one hour"* — and let the rule's own `frequencyMinutes` throttle repeats instead of
the trigger set. Do **not** simply drop the state-change triggers; first-seen is still the
fastest path for a genuinely new fault.

⚠️ **Do not close G.1 as fully done on the strength of the test notification.** Its routing
half is proven; its recurrence half is not, and is now known to be broken.

### D-2 RESOLVED, same session, and PROVEN by a controlled re-run

Both rules were edited in the Sentry UI (no MCP tool exists for alert rules) and verified by
API readback:

| Rule | Frequency | Triggers | Filters / Actions |
|---|---|---|---|
| `3608329` staging | `0` → **`60 min`** | 4 → **5** (`+ Every event`) | Email + Discord — **unchanged** |
| `3925256` **production** | `0` → **`60 min`** | 4 → **5** (`+ Every event`) | four `Tagged event` filters + Discord `1544045194264051842` — **unchanged** |

Staging updated `21:30:58Z`; production updated `21:34:53Z`. **Nothing was removed from
either rule.**

**Two notes on how the fix was built.** The trigger list offers no *"seen more than 0 times
in one hour"* option — the available equivalent is **"An event or issue activity is
captured"**, stored as `Every event`, which fires on every occurrence. That alone would page
every 5 minutes for as long as a fault persists, so **Action Throttle was set to 60
minutes** on both rules. Together they give the intended posture: repeats page, at most
hourly, per issue — and a genuinely new issue still pages immediately, because the throttle
is per-issue and a new issue has no prior notification.

**The regression test (T4–T6) is a controlled experiment.** Same fixture shapes, same
review, and critically the **same pre-existing Sentry issue groups** that stayed silent
earlier. The only variable changed was the trigger set.

| | Before the fix | After the fix |
|---|---|---|
| Poller cycles | 21:11:50Z, 21:16:50Z | 21:36:50Z |
| `Health alert findings` | `count: 2` | `count: 2` |
| Rule `lastTriggered` | **unchanged** — stuck at 2026-08-31T01:00:46Z | **2026-08-31T21:37:05.753Z** |

**A page 15 seconds after the poller cycle, on issue groups that had produced nothing an
hour earlier.** Nothing else in the system changed.

✅ **DELIVERY CONFIRMED BY THE OWNER, 2026-08-31T21:41Z.** The notification arrived in the
staging Discord channel `1517968864724385822`. This is the assertion §4 actually makes — *"must
produce a page on the Discord route"* — and it is the one link no API readback can prove:
`lastTriggered` shows Sentry **fired** the rule, not that Discord **received** it. Owner
confirmation closes the chain end to end:

> fixture → `HealthAlertPoller` (≤ 1 cycle) → `Sentry.captureMessage` → issue group →
> alert rule → Discord channel → **a human saw it**

---

## Drill results

| Drill | Finding fires | Reaches Sentry | **Pages Discord** | Verdict |
|---|---|---|---|---|
| **§4.1** Stuck outbox | — | — | — | **BLOCKED** (D-1) |
| **§4.2** Failed publish | ✅ `outbox_failed:publish_response` | ✅ `REPWORTH-STAGING-9` | ✅ **after the D-2 fix** | **PASS** |
| **§4.3** Zero-delivery | ✅ `zero_delivery_notifications` | ✅ `REPWORTH-STAGING-G` | ✅ **after the D-2 fix** | **PASS** |
| **§4.5** Send breaker re-page | ✅ `solicitation_send_breaker_tripped`, **13 emissions at exact 300 s cadence** | ✅ `REPWORTH-STAGING-11` — a group first seen **ten days earlier**, so no first-seen event was available | ✅ **TWICE — 22:32:07Z and 23:37:07Z, 65 min apart.** Both owner-confirmed; both footers name the issue and the rule | **PASS** |
| **§4.6** Unattributed suppression | — | — | — | **BLOCKED** (D-3 — rule 6 does not exist) |

> Both were a **QUALIFIED FAIL** on the first run at 21:11Z/21:16Z — the finding fired and
> reached Sentry, but no page was produced. They pass on the 21:36Z re-run, **after** D-2 was
> fixed and with the fixtures unchanged. That sequence is the evidence, not the pass on its
> own.

**Timeline.** Fixtures created 21:07:30–21:07:40Z. Poller cycles at **21:11:50Z** and
**21:16:50Z**, each logging `Health alert findings {"count":2}` — the two drills and nothing
else, matching a clean baseline. Sentry received 2 events per issue. `lastTriggered` on rule
`3608329` did not move.

**Predicates were verified against the database before the wait**, run verbatim from
`checks.ts`, both returning `1` against thresholds of `> 0` — so a non-firing poller would
have been distinguishable from a non-matching fixture.

---

---

# Session 2 — resume, 2026-08-31T22:23Z

**Git SHA at resume:** `566b8583a42ef7037d25a7eb8f0387d48ff948c0`
**Owner order:** §4.5 and §4.6 first — both assert repeat-notification *counts*, so both
re-test the D-2 fix from a second angle.

## Resume preflight

| # | Check | Result | UTC |
|---|---|---|---|
| P13 | Staging worker alive | ✅ `/api/health` `ok`, `uptime_seconds` 4900 — same process that ran session 1 (boot ≈ 21:01Z), never restarted | 22:23:21Z |
| P14 | `/ready` on the staging worker | ✅ `200` | 22:23Z |
| P15 | Session-1 teardown holds — baselines byte-identical to P7/P8/P9 | ✅ `job_outbox` pending **0** / failed **0** / total **49**; `solicitation_send_breaker` **0 open, 0 total**; `solicitation_suppressions` **5** | 22:23:03Z |
| P16 | `HealthAlertPoller` still cycling | ✅ worker log shows continuous poller cycles through 22:22:55Z; **no** `Health alert findings` line since teardown, which is the clean baseline stated positively | 22:10–22:23Z |
| P17 | Staging alert rule unchanged since the D-2 fix | ✅ rule `3608329`, `frequencyMinutes` **60**, triggers include **`Every event`**, `lastTriggered` **2026-08-31T21:37:05.753Z** | 22:24Z |
| P18 | **The §4.5 target Sentry group already exists** | ✅ `REPWORTH-STAGING-11` — *"Solicitation sending is STILL halted — the hard_bounce_rate breaker trip is open and has not been reset"*, 1 event, first seen 10 days ago. A **pre-existing** group, so a page can only come from `Every event`, never from first-seen — the same controlled shape as T4–T6 | 22:24Z |
| P19 | **Rules 5 and 6 exist in either Sentry project** | ❌ **BLOCKED — see D-3** | 22:25Z |

### D-3 (2026-08-31T22:25Z) — **RULES 5 AND 6 DO NOT EXIST. §4.6 cannot pass, and production has a live gap.**

**§4.5 and §4.6 assert the behaviour of runbook rules 5 and 6 (§1a-do). Neither rule
exists, in staging or in production.** Read back from the Sentry API:

| Project | Rules that exist | Action filters |
|---|---|---|
| `repworth-staging` | **one** — `3608329` *"Send a notification for high priority issues"* | **none.** No tag filter at all; actions are Email + Discord `1517968864724385822` |
| `repworth-production` | `3925256` *"Prod — four ops signals to Discord"* | four `Tagged event`: `subsystem=health_alert`, `cost_event=limit_exceeded`, `feature=stripe_reconciliation`, `subsystem=import_consent_analytics` |
| `repworth-production` | `3920752` *"Send a notification for high priority issues"* | none; triggers are **New/Existing high priority issue** only, `frequencyMinutes` **0** |

The runbook §1a-do specifies **six** rules. Rule 5 (`finding = solicitation_send_breaker_tripped`)
and rule 6 (`feature = solicitation_lane`) are in **neither** project.

**Consequence for §4.5 — runnable, because the signal is covered by a different route.**
`emitHealthFindings` tags every finding `subsystem:health_alert`, so the breaker finding is
caught by staging's unfiltered `3608329` and by production's `3925256`. What rule 5 was
specified to add — the *repeat* — is now supplied by the `Every event` trigger the D-2 fix
added. **The drill can run; it is exercising the catch-all, not rule 5.** Recorded so the
pass is not misread as "rule 5 verified".

**Consequence for §4.6 — the drill's core assertion is falsified by construction.**
§4.6 requires that **fewer than four POSTs produce nothing**, which needs a
frequency-conditioned rule. Staging's only rule has **no filter and an `Every event`
trigger**, so the **first** POST pages. The target group already exists
(`REPWORTH-STAGING-12`, `solicitation_suppression_without_attribution`, 2 events, first seen
5 days ago), so first-seen is not even required — `Every event` alone fires it, and the
60-minute throttle then swallows POSTs 2–4. The observable outcome is **one page, caused by
POST #1** — the precise thing the drill exists to prove does *not* happen.
**§4.6 is BLOCKED until rule 6 exists and the catch-all is scoped.**

**And the part that is not about the drills — production rule 6 is missing.**
`reportUnattributedSuppression` emits at `level: 'warning'` tagged `feature:solicitation_lane`.
In production that matches **none** of `3925256`'s four filters, and CONFIG-1 already
established that a `warning` `captureMessage` does not reliably classify as high priority, so
`3920752` does not catch it either. **The capture reaches Sentry and pages nobody** — which is
verbatim the failure the runbook §1 predicts: *"Until rule 6 exists the capture lands in
Sentry and pages nobody."* It is not yet live-harmful (solicitation sending is off in
production), and it becomes harmful the moment sending is enabled.

**This is D-2's shape a second time.** G.1 shipped **four** signals and was verified by a test
notification; the runbook specifies **six**. The two it omits are exactly the two whose
triggers are *frequency*, not *first-seen* — the same class of condition D-2 turned out to
have got wrong.

**Owner decisions, 2026-08-31T22:33Z.** (a) Create **rule 6** in both projects **and** scope
staging's catch-all `3608329` with the same four `Tagged event` filters production `3925256`
carries. (b) **Do not** build rule 5 — the `Every event` trigger the D-2 fix added already
supplies the repeat it was specified for, on `subsystem:health_alert`, which the breaker
finding carries; a separate rule would only duplicate every breaker page.

**What scoping `3608329` costs, stated before it is done.** Staging currently pages on
**every** issue, because the rule has no filter. After scoping, these stop reaching staging
Discord:

| Issue | Signal | Disposition |
|---|---|---|
| `REPWORTH-STAGING-16` | *REFUSAL_LEDGER_ENABLED=false — the Refusal ledger is not recording decisions* | `subsystem:refusal_ledger` — **an open §1 box in BOTH projects.** Needs its own rule; §1 already says a `warning` `captureMessage` will not classify as high priority, and that raising the level is the wrong fix here because a flipped kill switch is a deliberate operator state |
| `REPWORTH-STAGING-E` | *autonomy suspended* | `subsystem:autonomy_governor` — **an open §1 box in BOTH projects.** A `captureException`, so `error` level, so today it reaches issue owners by **email** — which §1's own premise rules out as an acceptable route |
| 8 application errors | `PostgresError` on four `/admin/*` routes, two `CONNECT_TIMEOUT`, a Server Components render error, a Stripe `allow_promotion_codes` conflict | Not ops signals. They page staging Discord today **by accident**, purely because the rule is unfiltered |
| `REPWORTH-STAGING-12` | `solicitation_suppression_without_attribution` | Covered by the new **rule 6** |

**Net:** scoping is right — it makes staging match production instead of paging on everything
— but it converts two accidental coverages into the honest gaps they already are in
production. Recorded here so neither is later read as a regression this change introduced.

### D-4 (2026-08-31T22:26Z) — §4.5's stated duration contradicts the runbook's own §3 note

§4.5 says *"leave it open across at least three `HEALTH_ALERT_POLL_INTERVAL_MS` intervals"*
(≈ 15 min) and *"confirm Discord receives more than the opening two notifications"*.

Those cannot both hold. §1's own rule-5 paragraph states the cadence correctly:

> *"Expect one Discord message when the trip opens and roughly one per hour after that —
> Sentry's default action interval is 60 minutes per issue, so a 5-minute poll interval does
> not mean a 5-minute page."*

Three poll intervals is 15 minutes against a **60-minute** Action Throttle, so 15 minutes can
only ever yield **one** page. "More than two" needs **>2 hours**. The phrase *"the opening
two"* also does not map onto a hand-inserted fixture: it counts the trip finding **and** the
open-trip re-page finding as two constant titles, but inserting the row directly means
`evaluateSendBreaker` never runs its breach arm, so only the re-page title is ever emitted.

**Corrected assertion, used for this run:** *an open breaker trip must produce **more than
one** Discord notification while it stands, at the rule's Action Throttle cadence (60 min),
not at the poll cadence.* Two pages ~60 minutes apart refute silence, which is the failure
rule 5 exists to close. The finding's **level-triggered** half is proven separately and more
cheaply, by the Sentry issue's event count rising once per 5-minute cycle.

## §4.5 — Send breaker re-page (#907). Assertion as corrected by D-4.

**What is under test.** An open `solicitation_send_breaker` trip must keep paging while it
stands. `evaluateSendBreaker` is **level-triggered**: it probes for an open trip before it
measures anything and returns `openTripFinding` on **every** poller tick. The failure this
drill exists to refute is *"one page, then silence"* — indistinguishable from the halt having
cleared, on a condition that **never self-clears**.

**Fixture.** T7 — one row, `reset_at IS NULL`, `trip_reason='hard_bounce_rate'`, breaching
metrics (`hardBounceRate` 0.0452 against the 0.02 bar, 420 sends against the 100 floor).
Inserted directly, so `evaluateSendBreaker` never runs its breach arm and only the
**re-page** title is ever emitted — which is the point: that title's group
(`REPWORTH-STAGING-11`) **already existed**, first seen 2026-08-21T16:19:05Z with **1**
occurrence. A page on it therefore cannot come from `First seen event`. **`Every event` is
the only trigger that can fire, so a page proves the D-2 fix and nothing else could** — the
same controlled shape as T4–T6, from a second angle.

**Predicate verified against the DB before the wait**, run verbatim from `readSendBreaker`
(`src/lib/solicitation/send-breaker.ts:181-184`):

```sql
SELECT id, tripped_at, trip_reason, metrics
  FROM solicitation_send_breaker
 WHERE reset_at IS NULL;
```

→ exactly **1** row, `01a05a00-0000-7000-9000-000000000045`. A non-firing poller is therefore
distinguishable from a non-matching fixture.

### Cycle 1

| Step | Evidence | UTC |
|---|---|---|
| Fixture created | breaker row `…045`, `tripped_at 22:29:01.805662+00`, `reset_at NULL` | 22:29:01.805Z |
| Predicate verbatim | returns 1 row | 22:29Z |
| **Poller cycle** | `HealthAlertPoller` → `Health alert findings {"count":1}` at `level:error`. **Count is 1**, matching a clean baseline plus this one fixture | 22:31:50.228Z |
| **Sentry** | `REPWORTH-STAGING-11` occurrences **1 → 2**, last seen 22:31:50Z. Event `4634ca134e7a4b1c868d614b2b88c40c` carries `trip_id: "01a05a00-0000-7000-9000-000000000045"` and `tripped_at: "2026-08-31T22:29:01.805Z"` — **attribution to this fixture is exact, not inferred** | 22:31:50.227Z |
| **Rule fired** | `3608329` `lastTriggered` **21:37:05.753Z → 22:32:07.769Z**, 17 s after the cycle | 22:32:07.769Z |
| **Discord** | ✅ **CONFIRMED BY THE OWNER.** Message delivered **22:32Z / 3:32 PM PDT**, title the exact `openTripFinding` string. Its footer reads **`REPWORTH-STAGING-11 via Send a notification for high priority issues • Today at 3:31PM`** | 22:32Z |

**An unplanned second proof, worth keeping.** On the same cycle `SolicitationReleasePoller`
flipped `releasePhaseStoppedBy` from `null` — its value on every cycle from 22:10Z to
22:26Z — to **`"breaker_open"`**. That is the breaker's **gate** half (`readSendBreaker` on
the send loop) observed independently of its **alert** half (`evaluateSendBreaker` on the
health poller). The drill was scoped to the alert; it evidenced both.

**The Discord footer is better evidence than `lastTriggered`, and it was not asked for.**
It names the **issue** (`REPWORTH-STAGING-11`) *and* the **rule**
(*"Send a notification for high priority issues"* = `3608329`) *and* the originating event
time (3:31 PM, the 22:31:50Z cycle). `lastTriggered` proves only that *some* issue fired
*this* rule; the footer proves **which** issue fired it. For page 1 that retires the
rule-level confound described below entirely — no cross-check against other issues is needed.

**What page 1 does and does not settle.** It closes the chain
`fixture → HealthAlertPoller → captureMessage → issue group → alert rule → Discord → a human
saw it`. It does **not** close the drill: a first-seen-only rule would also have produced
exactly one page. The drill's assertion is about the **second**.

### Cycles 2..n — the level-triggered half, proven cheaply

| Cycle | UTC | `REPWORTH-STAGING-11` occurrences | Rule `3608329` `lastTriggered` |
|---|---|---|---|
| 1 | 22:31:50.227Z | 1 → **2** | 21:37:05.753Z → **22:32:07.769Z** — ✅ fired |
| 2 | 22:36:50.257Z | 2 → **3** | **22:32:07.769Z** — unmoved |

**Occurrences rise on every 5-minute cycle; the page does not repeat.** That is byte-for-byte
the pattern D-2 recorded, and it now means the opposite thing. Before the fix it meant *the
trigger set cannot see a repeat*. After the fix it means *the 60-minute Action Throttle is
holding the page* — the intended posture, and the reason the fix pairs `Every event` with a
throttle rather than shipping `Every event` alone.

Both events carry `trip_id: "01a05a00-0000-7000-9000-000000000045"` and
`tripped_at: "2026-08-31T22:29:01.805Z"` in `extra`, so each is attributable to **this**
fixture rather than to any prior breaker state.

### The level-triggered half, closed at 23:16:50Z — ten emissions, one page

Sentry event search on `finding:solicitation_send_breaker_tripped`, staging, 24 h window:

```
22:31:50  22:36:50  22:41:50  22:46:50  22:51:50
22:56:50  23:01:50  23:06:50  23:11:50  23:16:50
```

**Ten events, every 300 s, no gap.** Across the whole span rule `3608329`'s `lastTriggered`
moved **once**, at 22:32:07.769Z.

That single table settles both halves of what §4.5 is really asking:

- **The finding is level-triggered, not edge-triggered.** `evaluateSendBreaker` probes for an
  open trip before it measures anything and returns `openTripFinding` on every tick. Ten
  consecutive cycles emitted; none was skipped. A single dropped Sentry event therefore
  cannot leave sending halted platform-wide in silence — which is the reason #907 made this
  check level-triggered in the first place.
- **The page is held by the Action Throttle, not by the trigger set.** One page per ten
  emissions is 60 minutes per issue, exactly as configured. Before the D-2 fix this same
  shape meant *the rule cannot see a repeat*; now it means *the rule sees every repeat and
  deliberately pages hourly*. The observation is identical and the diagnosis is opposite —
  which is why the configuration has to be read alongside the measurement.

The fixture stayed intact throughout: `solicitation_send_breaker` still one row,
`reset_at IS NULL`.

### Cycle 13 — PAGE 2. §4.5 PASSES.

| Guard signal (recorded BEFORE the observation) | Result |
|---|---|
| 1. `lastTriggered` moves to within ~20 s of a breaker cycle | 22:32:07.769Z → **23:37:07.061Z** — **17 s** after the 23:36:50Z cycle ✅ |
| 2. No other staging issue took an event in the window | Sentry event search, `timestamp:>2026-08-31T22:32:07Z`: **13 events, every one `REPWORTH-STAGING-11`** (`issue.id 7685097414`). Nothing else fired at all — the rule-level confound is excluded by data, not by argument ✅ |
| 3. **Owner confirms the Discord message and its TITLE** | ✅ **CONFIRMED 2026-08-31T23:37Z / 4:37 PM PDT.** Title is the exact `openTripFinding` string. Footer: **`REPWORTH-STAGING-11 via Send a notification for high priority issues • Today at 4:36PM`** ✅ |

**Two pages — 22:32:07Z and 23:37:07Z, 65 minutes apart — across 13 emissions of the same
finding, on an issue group whose first-seen was ten days earlier.**

That is the whole assertion. A rule triggering only on first-seen produces **one** page and
then silence for as long as the halt stands; this produced a second, at the Action Throttle
cadence, on a group that could not supply a first-seen event. The drill fails on a count, and
the count is 2 where the broken configuration could only ever reach 1.

**Both Discord footers name the rule and the issue.** That is better evidence than
`lastTriggered`, which is a rule-level field and cannot say *which* issue fired it — the
confound §4.5's guard was written to survive. Here the footer settles it directly, and
signal 2 settles it independently.

**Verdict: §4.5 PASS.** The D-2 fix is now proven from two independent angles — the T4–T6
regression re-run (identical fixtures, same groups, trigger set the only changed variable)
and this drill (a level-triggered finding paging twice across a throttle window).

### A confound in the page-2 measurement, and the guard against it

`lastTriggered` is a **rule-level** field, not a per-issue one. The Action Throttle, by
contrast, is **per issue**. So if any *other* staging issue fires rule `3608329` between now
and 23:37Z — an application error, a new `PostgresError`, anything — `lastTriggered` moves for
**that** issue and would read exactly like page 2 for the breaker.

**Guard, applied to this run:** page 2 is accepted only on **three** agreeing signals, not on
`lastTriggered` alone.

1. `lastTriggered` moves to a time within ~20 s of a breaker poller cycle (`…:x1:50Z` /
   `…:x6:50Z`).
2. No other staging issue received an event in the intervening window — checked by listing
   events across the project for the period, not just this issue's.
3. **The owner reports the Discord message's TITLE**, and it is the open-trip string
   *"Solicitation sending is STILL halted — the hard_bounce_rate breaker trip is open and has
   not been reset"*. This is the decisive one: a title is unambiguous where a timestamp is
   not.

Recorded before the observation rather than after, so the criterion cannot be fitted to
whatever arrives.

### Cycle 2 — the assertion that actually distinguishes pass from fail

Page 1 alone does not close this drill: a first-seen rule would also have produced one page.
**The drill passes on a second page, at the rule's Action Throttle cadence.** The throttle is
**60 minutes per issue**, so the next notification for `REPWORTH-STAGING-11` is due on the
first poller cycle after **23:32:07Z** — i.e. the **23:36:50Z** cycle.

Between the two, the finding's **level-triggered** half is proven separately and more
cheaply: the issue's occurrence count must rise by one on **every** 5-minute cycle
(22:36:50Z, 22:41:50Z, … ) while the page stays throttled. Rising occurrences with a static
`lastTriggered` is exactly the shape D-2 described; the difference now is that the throttle,
not the trigger set, is what holds it.

## Prepared during the §4.5 throttle wait — resolved from code and config, not assumed

**§4.5 serializes the campaign.** Nothing else can run alongside it: §4.4 needs a variable
change (redeploy → worker restart), §4.9/§4.10 inject outbox rows that would break §4.5's
`count:1` cleanliness, and §4.1/§4.7/§4.8 all stop the worker. The ~60-minute throttle wait
was therefore spent resolving the next drills' preconditions from source.

### §4.6 — ready to run the moment rule 6 exists

- Probe script written, reading `RESEND_WEBHOOK_SECRET` **from the environment** and never as
  a shell argument. Run it under `railway run --service repworth-worker --environment staging`
  so the value never transits a transcript.
- `RESEND_WEBHOOK_SECRET` **is** set on Railway staging (confirmed from `variableNames`, which
  returns names only — `list-variables` returns plaintext VALUES for every variable and must
  not be called).
- Signature: `HMAC-SHA256` over `${svix-id}.${svix-timestamp}.${rawBody}`, base64, header
  `v1,<sig>`; the ingress rejects a timestamp older than 300 s.
- Lane discriminant is `data.tags.lane === 'solicitation'`; `readTag` accepts `tags` as an
  object **or** an array of `{name,value}`.
- Recipient must be **exactly one** address or `extractSoleRecipient` throws — a global row
  blocks that person for every tenant, so the lane refuses to guess.
- Target group `REPWORTH-STAGING-12` already exists (2 events, 2026-08-26, from the #967
  staging smoke). Baseline suppressions = **5**, one of which is that smoke's
  `probe-967-20260826@example.test` row, left in place for the same reason ours will be.

### §4.4 — the expected signal, resolved from the emit site

`worker/jobs/response-generation/generate-draft.ts:76-85` emits:

```
Sentry.captureMessage(`Cost cap exhausted — draft dropped for business ${businessId}`, {
  level: 'warning',
  tags: { cost_event: 'limit_exceeded', cost_scope: 'global' | 'business', business_id },
})
```

Three consequences worth knowing **before** running it:

1. **The title carries `businessId`, so it is NOT a constant string.** Unlike every health
   finding, each business gets its **own** Sentry group — so `First seen event` fires and this
   drill does not depend on the D-2 fix at all. It is the one §4 drill whose original
   first-seen assumption was always correct.
2. It is tagged `cost_event:limit_exceeded`, which **is** one of the four filters the owner is
   adding to `3608329`. It routes after the scoping, not before it by accident.
3. **The drill spends nothing at the provider.** The cost guard's 15¢ pessimistic reserve is
   taken *before* the LLM call, so a 1-cent cap makes the reservation fail and throw
   `GlobalCostLimitExceededError` — terminal, and no completion is ever requested.

`GLOBAL_DAILY_COST_LIMIT_CENTS` **is** set on Railway staging, so this is a Railway variable
change, not a vault write. **Read the pre-flip value without dumping every secret:**

```
railway run --service repworth-worker --environment staging \
  -- node -e "console.log(process.env.GLOBAL_DAILY_COST_LIMIT_CENTS)"
```

That prints one non-secret number. `railway variables` and the MCP's `list-variables` both
return **plaintext values for every variable** and must not be used here.

### Staging deploy config, confirmed healthy for the worker-stop drills

`startCommand: pnpm worker` · `healthcheckPath: /ready` · source branch `staging` ·
`numReplicas: 1`. The Sentry `release` tag on the running worker is
`e511a725e5bd0bf7a8b7f4eebf03deab7cbea6b3`, matching the local `staging` worktree — so the
process under test is the branch tip, not a stale deploy.

### D-5 (2026-08-31T23:38Z) — staging's UI was behind a Vercel SSO wall, and a 302 read as "normal"

**Not a G.3 finding — found while verifying staging for a demo — but it belongs here, because
it is the same failure shape as D-2 and D-3 and it invalidated one of this session's own
checks.**

`https://staging.repworth.net` returned **302 to `vercel.com/sso-api`** on *every* path,
including `/`, `/login`, `/admin`, `/dashboard` and `/api/health`. Production returned 200.
Project setting, read back from the Vercel API:

```
ssoProtection: { enabled: true, deploymentType: "all_except_custom_domains" }
```

That exemption covers **production** custom domains only. `staging.repworth.net` sits on a
preview-type Custom Environment, so the wall applied to it.

**How it was nearly missed.** An earlier check in this session ran
`curl -o /dev/null -w "%{http_code}"` against the staging root, got `302`, and recorded it as
"normal — a redirect to `/login`". The status code alone was consistent with both the benign
reading and the real one; **only the `location` header distinguishes them**, and it was not
requested. A second, independent verification pass caught it by following the redirect.

CORRECT → when a check's PASS and FAIL states share a status code, the status code is not the
check. Assert on the discriminating field — here, `location`.

**Resolved 2026-08-31T23:40Z, owner-directed:** `ssoProtection.enabled` set to `false`;
readback confirms it, and `/` and `/login` both return **200**. ⚠️ **Staging and every preview
deployment are publicly reachable by URL until this is re-enabled.**

**A second lesson, from trying to work around it.** With the wall down, an unauthenticated
probe of `/api/account/offboarding/status` was used to infer whether
`ACCOUNT_OFFBOARDING_ENABLED` is set on the **Vercel** surface — the route checks the flag
*before* auth and returns `200 {enabled:false}` when it is off, so a `401` should have proven
the flag on. It returned 401 on staging **and** on production, where the flag is known off.
Cause: `src/proxy.ts` matches `/((?!_next/static|_next/image|favicon.ico).*)` and returns 401
**before the route runs**, so the inference was invalid in both directions. The flag's
Vercel-side value remains **unverified by API**; the ten-second definitive check is to load
`/settings/billing` and see whether the Cancel section renders.

CORRECT → before inferring a flag from a status code, confirm the response actually came from
the handler you reasoned about. A middleware/proxy matcher that catches everything makes every
such inference worthless.

### D-6 (2026-09-01T04:05Z) — §4.7 cannot run on staging: the worker has no monitorable domain

**§4.7 says:** stop the worker process; expect the external `/ready` check to page.

**There is no such check on staging.** Every uptime monitor in the org, read back from the API:

| Monitor | Project | Target | Interval |
|---|---|---|---|
| `7669160` | `repworth-staging` | `https://staging.repworth.net` — **the Vercel UI** | 60 s |
| `8341697` | `repworth-production` | `https://worker.repworth.net/ready` | 300 s |
| `8341701` | `repworth-production` | `https://repworth.net/api/health` | 300 s |

Stopping the staging **worker** does not touch `staging.repworth.net`, which is served by Vercel.
So the drill's assertion has nothing to assert against.

**Attempting to create the missing monitor produced the root cause**, which is better than the
symptom. Sentry rejected it outright:

> `The domain *.railway.app has already been used in 1000 uptime monitoring alerts, which is
> the limit. You cannot create any additional alerts for this domain.`

That is a **platform-wide cap on the shared Railway domain**, across all Sentry customers — not
a quota on this account. Production is monitorable only because its worker sits behind the
**custom domain** `worker.repworth.net` (added in Phase A). The staging worker has only
`repworth-worker-staging.up.railway.app`.

**So the gap is infrastructural, not an oversight**, and it has a precise remedy: give the
staging worker a custom domain (e.g. `worker-staging.repworth.net`), then create the monitor.
That is DNS work and outward-facing; it is recorded as owed rather than done inside a drill.

**Disposition: §4.7 BLOCKED on staging.** Note what is and is not proven:

- The **production** worker `/ready` monitor exists and is `active`/`ok` (`8341697`), so the
  capability the drill exists to verify is in place where it actually matters.
- What stays unproven is the **staging** rehearsal of it. §4 forbids stopping the production
  worker, so this drill has no environment in which it is both runnable and permitted.

⚠️ **A second observation, recorded because it weakens the one staging monitor that does
exist.** `7669160` targets `https://staging.repworth.net`, which — with Vercel Authentication
re-enabled — answers **302 to `vercel.com/sso-api`**. The monitor reported `uptimeStatus: ok`
in that state. A monitor that treats an auth-wall redirect as success cannot distinguish "the
app is healthy" from "the app is unreachable behind a redirect". Worth an assertion on status
code or body before it is trusted as a staging liveness signal.

### D-7 (2026-09-01T04:08Z) — D-1's own remedy does not work either. §4.1 belongs with §4.9, not §4.7.

D-1 proposed folding §4.1 into the worker-stop drill: stop the worker, insert the aged
`pending` row, restart, and catch `outbox_pending_age` on the first cycle. **Checked against
the boot logs before running it, and it fails for the same reason the original did.**

| Loop | When it first runs after boot | Cadence |
|---|---|---|
| `OutboxPoller` | **immediately** — `Starting` at boot +~1 s, first claim within 5 s | 5 s |
| `HealthAlertPoller` | **one full interval later** — boot 21:01:44Z, first cycle **21:06:50Z** | 300 s |

The health poller does **not** run a cycle at boot. So on restart the dispatcher claims the
aged row roughly **five minutes** before the alert can read it — a wider margin than the
original race, not a narrower one. Stopping the worker changes *when* the row is claimed, not
*who* claims it first.

**CORRECT → the only honest `outbox_pending_age` fixture is a backlog the dispatcher cannot
drain.** The alert reads the OLDEST pending row against a 900 s threshold; with a single row,
any running dispatcher removes it. With a backlog large enough that the 50-row batch at 5 s
cannot keep pace, the oldest row keeps ageing while the poller works, and crosses 900 s with
the system fully healthy — which is also the honest meaning of the alert: *dispatch is backed
up*.

**Disposition: §4.1 folds into §4.9 (backlog), NOT §4.7 (worker stop).** This supersedes D-1's
reordering, which was proposed in good faith on a plausible reading of the cadences and is
wrong. The runbook edit made earlier in this campaign — which put the stuck-outbox fixture
inside the killed-worker drill — must be re-corrected.

**General lesson, and it is the same one twice.** D-1 diagnosed a race by comparing two
*cadences* (5 s vs 300 s). The remedy failed because the deciding fact was not the cadence but
the **phase** — whether each loop runs at boot or waits an interval. When a fix turns on
timing, check the start-up behaviour, not only the steady-state period.

## §4.4 — Cost-cap hit. PASS on the finding; Discord confirmation owed.

**Flag flip (T8), recorded before it was made:** `GLOBAL_DAILY_COST_LIMIT_CENTS` on the Railway
**staging** worker, pre-flip **`200`** → **`1`**. Read back at runtime, never from config, and
without dumping any other variable:

```
railway run --service repworth-worker --environment staging \
  -- node -e "console.log('GLOBAL_DAILY_COST_LIMIT_CENTS=' + process.env.GLOBAL_DAILY_COST_LIMIT_CENTS)"
```

**Vercel deliberately NOT flipped.** The variable is read by `src/lib/costs/tracker.ts` (the
worker's enforcement path) and by `src/lib/admin/cost-report-service.ts` (an admin display).
Only the worker path is under test; flipping Vercel would have changed an admin figure and
tested nothing.

**Trap 2 earned its keep, visibly.** Two deployments landed minutes apart:

| Deployment | Created | Status | Carries the flip? |
|---|---|---|---|
| `f373c530` | 03:52:58Z | SUCCESS 03:54:52Z | **No** — an auto-deploy from the `staging` branch re-sync to `main` (`914a797a`), landing *before* the variable write |
| `09b7e0a5` | 03:55:49Z | SUCCESS 03:57:35Z | **Yes** — the explicit `redeploy --from-source` |

Had the drill trusted the first deploy — which reported healthy, with a fresh uptime — it would
have run against the **old** 200-cent cap and drawn a false conclusion from a real-looking
result. Boot confirmed as the worker, not the UI: all pollers `Starting`, `readiness cure
complete`, and a poller cycle in the same log.

**Fixture (T9).** One `generate_response` row on the **`on_demand_generate`** lane — chosen
because that lane and `suppress_notification=true` **independently** exclude the draft from
auto-approval (invariant #3), so the fixture cannot post publicly under any flag state.

**Result, from the outbox row itself:**

```
status: failed   attempts: 1 / 5   completion_reason: null
last_error: "Global daily cost limit exceeded"
dispatched 03:58:20.811Z → failed 03:58:21.281Z   (470 ms)
```

| Assertion | Evidence |
|---|---|
| The cap fires on the **global** scope | `last_error` is the global message, not the per-account one |
| It is **terminal**, not retried | `attempts: 1` of `max_attempts: 5`. Budget-exceeded is TERMINAL by design; a retry here would burn the cap again for nothing |
| **No provider spend** | The 15¢ pessimistic reserve is taken *before* the LLM call, so the completion was never requested. The drill costs nothing |
| Reaches Sentry | `REPWORTH-STAGING-17`, `Cost cap exhausted — draft dropped for business 01a05ac6-…`, tagged `cost_event:limit_exceeded`, 03:58:21Z |
| Rule fires | `3608329` `lastTriggered` 23:37:07Z → **03:58:40.761Z**, 19 s after the event |
| **Pages Discord** | ⏳ owner confirmation owed |

**Attribution is unambiguous.** Between §4.5's page 2 at 23:37:07Z and this event, the only
Sentry activity was four more breaker events (23:41:50–23:56:50, all throttled, no page — an
incidental re-confirmation that the 60-minute throttle holds), then nothing until 03:58:21Z.

**This drill never depended on the D-2 fix, and that was predicted in advance.** Its title
carries the `businessId`, so unlike every health finding it is **not** a constant string —
each business mints its own Sentry group and `First seen event` fires. It is the one §4 drill
whose original first-seen assumption was always correct.

**Flag restored to `200`** immediately after the observation.

## §4.1 + §4.9 — one fixture, both drills. PASS on the findings; Discord confirmation owed.

Per **D-7**, §4.1 folds into §4.9, not §4.7. The fixture is a backlog the dispatcher cannot
drain within one poller interval: **4000 rows, past-dated 30 minutes, claimable**, using the
burst script's own conventions (topic `stripe_subscription_mirror_sync`, `aggregate_type`
`account`, random non-existent `account_id`) so the handler self-completes with no spend and
never lands in `failed`.

**Both predicates verified verbatim before the wait**, so a non-firing poller stayed
distinguishable from a non-matching fixture:

```sql
-- checkOldestPendingOutbox (checks.ts:114-118)
SELECT EXTRACT(EPOCH FROM (NOW() - MIN(available_at)))::int AS age
FROM job_outbox WHERE status = 'pending' AND available_at <= NOW();   -- 1807  (> 900)
```

**One cycle, three findings** — `Health alert findings {"count":3}` at **04:07:36.481Z**:

| Issue | Title | Drill |
|---|---|---|
| `REPWORTH-STAGING-1A` | *Oldest claimable outbox row is **1961s** old (> 900s) — dispatch backed up or stalled* | **§4.1 FIRES** |
| `REPWORTH-STAGING-19` | *job_outbox backlog depth is **2350** pending rows (> 1500)* | **§4.9 FIRES** |
| `REPWORTH-STAGING-18` | *1 `generate_response` job(s) exhausted retries and failed in the last 3600s* | unplanned — see below |

Rule `3608329` `lastTriggered` 03:58:40Z → **04:07:54.047Z**, 18 s after the cycle.

**The third finding is a free cross-validation of §4.2 on a new topic.** §4.4's fixture failed
terminally, and `checkFailedOutboxByTopic` caught it — the same check §4.2 exercised on
`publish_response`, now demonstrated on `generate_response`. Not planned, and worth more than
a planned repeat would have been: it shows the check is topic-general rather than fitted to
the one topic it was first tested against.

**§4.9's second half — that it CLEARS — is satisfied by the drain itself.** No `release` was
needed: the dispatcher drained 4000 rows in roughly seven minutes (~540/min, matching the
script's ~600/min estimate), and by 04:12Z the state was `claimable_pending 0`,
`oldest_age −1` (no rows at all), `dispatching 0`. Both predicates return null, so the
following cycle emits neither finding.

> **§4.1 was called "unrunnable" by D-1 and is now demonstrated.** The original diagnosis was
> right that a *single* aged row cannot survive the dispatcher. It was wrong to conclude the
> alert could not be exercised at all: the alert reads `MIN(available_at)` over *all* claimable
> pending rows, so a backlog large enough to outlast one 300 s interval fires it with the system
> otherwise healthy — which is also precisely what the alert means.

## Teardown ledger

**Three fixtures, all created 2026-08-31T21:08Z for §4.2 and §4.3.** Rows written to this
ledger BEFORE the fixtures existed, per the contract.

| # | Fixture | Identifier | How to remove | State |
|---|---|---|---|---|
| T1 | `job_outbox` row — §4.2 synthetic failed publish | `01a059a5-5966-7b92-92f3-caf6593dfd75` | `DELETE FROM job_outbox WHERE id = '01a059a5-5966-7b92-92f3-caf6593dfd75'` | ✅ **removed 21:21Z, verified 0 rows** |
| T2 | `responses` row — §4.3 fresh `pending_approval` draft | `01a059a5-5966-79ac-bd27-f77f2ccf2387` (review `01a03996-2b54-725b-a04e-df183805c3c1`) | `DELETE FROM responses WHERE id = '01a059a5-5966-79ac-bd27-f77f2ccf2387'` — **delete T3 first** (no FK, but the check joins them) | ✅ **removed 21:21Z, verified 0 rows** |
| T3 | `job_outbox` row — §4.3 completed `send_notification` | `01a059a5-5966-75b4-8fa6-0b55d75e2cd3` | `DELETE FROM job_outbox WHERE id = '01a059a5-5966-75b4-8fa6-0b55d75e2cd3'` | ✅ **removed 21:21Z, verified 0 rows** |
| **T4** | **REGRESSION run** — `job_outbox` §4.2 failed publish | `01a059c9-0000-7000-9000-000000000042` | `DELETE FROM job_outbox WHERE id = '01a059c9-0000-7000-9000-000000000042'` | ✅ **removed 21:38Z, verified 0 rows** |
| **T5** | **REGRESSION run** — `responses` fresh `pending_approval` | `01a059c9-0000-7000-9000-000000000043` | `DELETE FROM responses WHERE id = '01a059c9-0000-7000-9000-000000000043'` | ✅ **removed 21:38Z, verified 0 rows** |
| **T6** | **REGRESSION run** — `job_outbox` completed `send_notification` | `01a059c9-0000-7000-9000-000000000044` | `DELETE FROM job_outbox WHERE id = '01a059c9-0000-7000-9000-000000000044'` | ✅ **removed 21:38Z, verified 0 rows** |
| **T7** | **§4.5** — one OPEN `solicitation_send_breaker` trip (`reset_at IS NULL`, `trip_reason='hard_bounce_rate'`) | `01a05a00-0000-7000-9000-000000000045` | **Clear it at `/admin/solicitation`, NOT by SQL** — the breaker never self-clears and `resetSendBreaker` is the only sanctioned arm (it writes `reset_at`, `reset_by`, a mandatory `reset_note`, and migration 110's `reset_consistency` CHECK enforces the note). The drill row is then a normal closed trip and is **left in place** as its own record | ⏳ **OPEN — created 2026-08-31T22:29:01Z** |
| **T8** | **§4.4 FLAG FLIP** — `GLOBAL_DAILY_COST_LIMIT_CENTS` on the **Railway staging worker** | pre-flip value **`200`**, flipped to **`1`** | Restore to **`200`**, then `railway deployment redeploy --from-source --service repworth-worker --environment staging --yes`. **A flag flip is a fixture** — this row exists because the pre-flip value is not recoverable from anywhere else once overwritten | ⏳ **OPEN — flipped 2026-09-01T03:55Z** |
| **T9** | **§4.4** — one `generate_response` outbox row on the **`on_demand_generate`** lane, to trigger a draft against a 1-cent cap | `01a05b00-0000-7000-9000-000000000046` (review `01a05acf-fdef-7579-b350-9f843f345fc3`) | `DELETE FROM job_outbox WHERE id = '01a05b00-0000-7000-9000-000000000046'`. **Lane chosen for safety:** `on_demand_generate` is excluded from auto-approval **twice** over — by the lane itself and by `suppress_notification=true` — through `isAutoApprovalCandidate` (invariant #3), so the fixture cannot post publicly under any flag state. `live_ingest_new` was deliberately NOT used | ✅ **removed 04:14Z, verified 0 rows** |
| **T10** | **§4.9 + §4.1 (merged per D-7)** — bulk `job_outbox` backlog: past-dated, claimable, above the 1500 depth threshold | payload marker `__drill = "G3-4.1-4.9"` | `pnpm tsx scripts/burst-drill-load.ts release --drill-tag G3-4.1-4.9 --confirm-staging kubdiqdhqbhwmqfditeg`, or `DELETE FROM job_outbox WHERE payload->>'__drill' = 'G3-4.1-4.9'`. Rows use the script's own conventions — topic `stripe_subscription_mirror_sync`, `aggregate_type` `account`, a random non-existent `account_id` — so the handler self-completes with **no LLM or external spend** and never lands in `failed`, tripping none of the other health checks | ✅ **removed 04:14Z, verified 0 rows** |
| **T11** | **§4.8** — staging worker STOPPED to starve the `health-alert-poller` cron check-ins | deployment `09b7e0a5-a1ae-445e-9a6c-6671ccb315d5` | `railway deployment redeploy --from-source --service repworth-worker --environment staging --project ad641d0e-… --yes`. **This restore also completes T8** — the `200` cost-cap value was written with `skipDeploys`, so the running process still holds `1` until this deploy lands | ⏳ **OPEN** |

**T4–T6 are the D-2 regression test**, created 21:36Z after both alert rules gained the
`Every event` trigger and a 60-minute throttle. Same shapes as T1–T3, same review
(`01a03996-2b54-…`, still zero responses), same design notes. The assertion is different:
these findings join the **same pre-existing Sentry groups** that stayed silent at 21:11Z and
21:16Z, so a page now proves the fix and nothing else could.

**Fixture design notes, recorded at creation time:**

- **All three carry `payload->>'drill'`** (`G3-4.2` / `G3-4.3`) so they are identifiable
  without relying on this file.
- **T1 is inert.** A hand-inserted `status='failed'` row is never swept: the outbox watchdog
  reclaims `'dispatching'`, and failed-hooks fire on the BullMQ `'failed'` **event**, not on a
  DB row. Nothing will retry or dispatch it.
- **T2 is created fresh (`created_at = NOW()`) on purpose.** `NotificationFailoverPoller`
  sweeps `pending_approval` drafts **older than 4 h** that have had a send attempted. Reusing
  an existing old draft would have put the fixture inside that sweep and could have sent a
  real failover notification. A brand-new row is outside it.
- **T2's review was chosen for the partial unique index**
  `responses_one_non_terminal_per_review` — unique on `review_id` where status is
  `pending_approval|approved|edited|awaiting_owner_connect`. Review
  `01a03996-2b54-725b-a04e-df183805c3c1` has **zero** responses, so the insert cannot collide
  with a live draft.
- **T3 sets `completion_reason = NULL`**, deliberately. `checkZeroDeliveryNotifications`
  excludes `owner_unreachable`, and `checkOwnerUnreachable` requires it — NULL keeps the
  fixture in the drill's own check and out of the other one, so the two signals are not
  conflated.

> **Contract reminder for whoever resumes.** Every fixture gets a row here **at creation
> time**, before it exists. Flag flips count as fixtures — record the pre-flip value. The
> two that leave lasting state are called out in advance:
>
> - **§4.5 send-breaker** — `solicitation_send_breaker` never self-clears. Clear it through
>   `/admin/solicitation`, not SQL.
> - **§4.6 unattributed suppression** — writes **one** permanent `solicitation_suppressions`
>   row (first-write-wins across the four POSTs). The ledger has **no expiry and no ordinary
>   delete path** by design, and the admin **Correction path** is a compliance surface, not a
>   cleanup tool. Use an obviously fictional recipient and **leave the row**.

---

## Unproven paths

| Drill | State | Disposition |
|---|---|---|
| §4.1 Stuck outbox | **BLOCKED** | D-1 — unrunnable as written; fold into the §4.7 worker-stop drill |
| §4.2 Failed publish | ✅ **PASS** | Fires, reaches Sentry, **pages** |
| §4.3 Zero-delivery | ✅ **PASS** | Fires, reaches Sentry, **pages** |
| §4.4 Cost-cap hit | open | Not attempted |
| §4.5 Send breaker re-page | ✅ **PASS** | Two pages 65 min apart across 13 emissions; owner-confirmed in Discord. Original note kept: **Now runnable.** It asserts *more than the opening two* notifications — impossible before D-2 was fixed, possible now |
| §4.6 Unattributed suppression | open | **Now runnable**, same reason. Leaves one permanent ledger row — read the teardown note first |
| §4.7 Killed worker | open | Pairs with §4.1 under D-1's reordering |
| §4.8 Probe stopped | open | Cron-monitor path — was never affected by D-2 |
| §4.9 Backlog over threshold | open | Not attempted |
| §4.10 Capacity burst headroom | open | Not attempted |

**3 of 10 pass. 5 remain unattempted, 2 blocked (§4.1 by D-1, §4.6 by D-3).** G.3 is **not** complete.

---

## Runbook feedback (contract step 7)

1. **§4.1 is unrunnable in isolation** (D-1) — not yet applied; fold it into §4.7.
2. **§4 assumed a repeat finding pages** (D-2) — the assumption was false when this campaign
   started. §4.5 and §4.6 are both written as *count* assertions and could not have passed on
   any code, however correct. **§4 now needs a stated precondition**: the alert rules must
   carry the `Every event` trigger, or the campaign silently tests the application and exempts
   the alerting. Both fixes want owner sign-off before being written into the runbook.

---

## Verdict

**PARTIAL PASS — and the campaign's value is D-2, not the two drills.**

- **§4.2 and §4.3 PASS**, on the re-run, after fixing a production defect they exposed.
- **D-2 found and fixed in-session**, on **both** rules, verified by API readback, and proven
  by a controlled re-run whose only changed variable was the trigger set.
- **D-1 open** — a runbook defect, not a product defect.
- **Teardown: COMPLETE.** All six fixtures (T1–T6) removed and verified by query. Baselines
  byte-identical to preflight: outbox `pending 0 / failed 0 / total 49`, suppressions `5`,
  breaker `0` open. **Staging is in its pre-campaign state.**
- **No flags were flipped.**
- **Production change:** one alert rule's triggers and throttle, deliberate and owner-directed.
  No application, schema, or data change.

**What this cost and what it bought.** Two of ten drills, and they found that production's
ops alerting paged only on a signal's **first ever** occurrence. G.1 had verified that
routing with a **Send Test Notification** — which is, by construction, a first-seen event, so
it exercised the one path that worked and generalised to all of them. The gap would have
surfaced as silence during a real incident.

**Next:** §4.5 and §4.6 are now genuinely runnable and should go first — they are the two
drills that directly assert repeat-notification behaviour, so they re-test D-2 from a second
angle. Then §4.4, §4.9, §4.10, and §4.1+§4.7 as a merged pair.

**UTC end (this session's portion): 2026-08-31T21:39Z.**
