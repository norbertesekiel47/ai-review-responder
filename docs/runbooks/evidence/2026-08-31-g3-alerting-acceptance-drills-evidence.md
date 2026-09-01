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
| **§4.4** Cost-cap hit | ✅ terminal failure, `Global daily cost limit exceeded`, **1 of 5 attempts**, zero provider spend | ✅ `REPWORTH-STAGING-17`, tag `cost_event:limit_exceeded` | ✅ rule fired 03:58:40Z, 19 s after the event — ⏳ owner confirmation owed | **PASS (pending Discord)** |
| **§4.1** Stuck outbox | ✅ `Oldest claimable outbox row is **1961s** old (> 900s)` — **runnable after all, see D-7** | ✅ `REPWORTH-STAGING-1A` | ✅ rule fired 04:07:54Z — ⏳ owner confirmation owed | **PASS (pending Discord)** |
| **§4.9** Backlog over threshold | ✅ `backlog depth **2350** (> 1500)`, **and clears** — next cycle 3 findings → 1 | ✅ `REPWORTH-STAGING-19` | ✅ same rule fire — ⏳ owner confirmation owed | **PASS (pending Discord)** |
| **§4.7** Killed worker | — | — | — | **BLOCKED** (D-6 — no monitorable staging domain) |
| **§4.8** Probe stopped | ✅ **2 missed check-ins**, monitor `ok` → `error` | ❌ **no issue created** | ❌ **nothing to page on** | **QUALIFIED FAIL** |

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

### §4.8 — QUALIFIED FAIL. The dead-man switch detects the outage and pages nobody.

**Fixture (T11):** staging worker stopped at **04:14:10Z** (`railway down`), confirmed by
`/ready` and `/api/health` both returning **404** and the deployment reading `REMOVED`.

**The dead-man switch detects the outage.** Read from the monitor itself:

```
Status: error          Last check-in: 2026-09-01T04:12:36Z    Next expected: 04:20:00Z
Recent: 04:21:29.396Z  missed, staging
        04:12:39.253Z  ok        04:07:39.593Z  ok        04:02:41.876Z  ok
Stats 04:00 hour: ok=3, missed=1
```

Before the stop the monitor had run clean for nine straight hours — `ok=12`/`13` per hour,
`missed=0` throughout. So the miss is attributable to the stop and nothing else.

**But no Sentry ISSUE exists for it**, and therefore no alert rule can fire on it. Checked two
ways: a text search over issues first seen in the last hour (four results, all this campaign's
own drills), and the monitor-scoped query the API itself recommends,
`monitor.slug:health-alert-poller` — **no issues found**. Rule `3608329`'s `lastTriggered`
stayed at 04:07:54Z.

⚠️ **This is NOT yet recorded as a defect, and the distinction matters.** Sentry cron monitors
raise an issue only after crossing a **failure threshold**, and exactly **one** miss has
occurred. Declaring "the dead-man switch pages nobody" on a single data point would be the same
mistake D-6 nearly produced — reading one observation as a conclusion when the mechanism has a
documented threshold. The worker is being held down through two further expected check-ins
(04:25, 04:30) to find the actual threshold empirically.


### §4.8 result — two misses, monitor red, no issue, no page

**Observation window: 04:14:10Z → 04:28:57Z** (worker down ~15 min).

```
04:34:09.057Z  ok       <- recovered
04:29:07.934Z  ok       <- recovered
04:25:53.447Z  MISSED
04:21:29.396Z  MISSED
04:12:39.253Z  ok       <- last check-in before the stop
Stats, 04:00 hour: ok=5, missed=2
```

Nine consecutive clean hours precede it (`ok=12`/`13`, `missed=0` every hour), so both misses
are attributable to the stop.

| Link in the chain | Result |
|---|---|
| Worker stops | ✅ `/ready` and `/api/health` both **404**; deployment `REMOVED` |
| Cron monitor detects | ✅ **2 missed check-ins**, environment status `ok` → **`error`** |
| An issue is created | ❌ **none** — checked by text search over issues first-seen in the last hour (4 results, all this campaign's own drills) **and** by the monitor-scoped query the API itself recommends, `monitor.slug:health-alert-poller` |
| An alert rule fires | ❌ `3608329` `lastTriggered` unmoved at **04:07:54Z** |
| **Pages Discord** | ❌ **nothing to page on** |

**Stated precisely, because the distinction is the whole finding.** What is proven is that
**two** consecutive missed check-ins, on a monitor with a 5-minute margin, produced no Sentry
issue. What is **not** proven is the configured threshold: Sentry cron monitors raise an issue
only after crossing a `failure_issue_threshold`, and **the MCP does not expose that field** —
it is UI-only, the same surface as rules 5 and 6. So the correct claim is *"two misses were not
enough"*, not *"the monitor can never page"*.

**Why this matters more than any other drill in §4.** The cron monitor is the **dead-man switch
for the entire health-alert system**. Every other finding in this campaign — the breaker, the
cost cap, the backlog, the stuck outbox — is emitted *by* the `HealthAlertPoller`. If that
poller dies, all of them stop silently, and this monitor is the only thing that would say so.
An unpaged dead-man switch is the one failure that hides every other failure.

**And production runs the identical monitor** (`e891f020`, same `*/5 * * * *`, same 5-minute
margin), so the same question applies there and has the same UI-only answer.

**Owner action (Sentry UI, alongside rule 6):** open
`https://repworth-nv.sentry.io/crons/repworth-staging/health-alert-poller/`, read the failure
threshold and the notification target, and set them so a missed check-in raises an issue that
rule `3608329` can route. Repeat on `repworth-production`. **Then re-run this drill** — it is
cheap now that the fixture is understood.

> **The recovery was not mine, and that is worth recording.** The worker came back at 04:28:57Z
> because **another session pushed to the `staging` branch** — deployment `7f82a1a4`, commit
> `5358bd82` *"docs(#1013): red-team sidecar final stamp"*. Staging auto-deploys on push. The
> drill's observation window was already complete, so nothing was lost, but a concurrent push
> can silently end a worker-stop drill. **Check for concurrent staging work before the next
> one.** That deploy also carried the restored `GLOBAL_DAILY_COST_LIMIT_CENTS=200`, completing
> T8 — confirmed at runtime.

## The Sentry configuration work — rule 6 built, `3608329` scoped, two of my own claims corrected

**Done in the Sentry UI via the browser, 2026-09-01T05:05–05:35Z.** The MCP has read tools for
alert rules (`find_alert_rules`, `get_alert_rule`) and **no create or update tool** — re-tested
against the catalog, not assumed from the earlier note. Every change below is verified by
**API readback**, never by the UI's own confirmation.

### Rule 6 now exists in BOTH projects

| | Staging | Production |
|---|---|---|
| Rule | **`3927243`** `solicitation-unattributed-suppression → discord` | **`3927261`** `Prod — solicitation-unattributed-suppression → discord` |
| Triggers | `Every event` — **the only one** | `Every event` — **the only one** |
| Filters (logic **`all`**) | `Issue occurrences ≥ 4` **AND** `Tagged event feature eq solicitation_lane` | identical |
| Action | Discord `443670` → `1517968864724385822` | Discord `443670` → `1544045194264051842` |
| Throttle | 60 min | 60 min |

**This is §4.6's assertion expressed as configuration.** POSTs 1–3 fire the trigger and fail
the `≥ 4` filter, so nothing pages; POST 4 passes both. The four default state-change triggers
were **deliberately removed** — leaving `First seen event` would have paged on POST #1 and
made the drill unpassable regardless of the frequency filter.

**D-3's production half is closed**, and closed *before* solicitation sending is ever enabled
in production, which is the right order.

### `3608329` scoped

```
Triggers      : First seen · Reappeared · Resolved · Regression · Every event   (all 5 intact)
Action Filters: logic ANY
                subsystem  eq  health_alert
                cost_event eq  limit_exceeded
                feature    eq  stripe_reconciliation
                subsystem  eq  import_consent_analytics
Actions       : Email + Discord 1517968864724385822                             (unchanged)
```

Nothing was removed. D-2's `Every event` trigger survives; what went is the `Any event`
catch-all **filter** that made the rule page on every issue in the project. Staging now
matches production's posture. The costs recorded in advance under D-3 are now live:
`subsystem:refusal_ledger` and `subsystem:autonomy_governor` no longer page on staging, and
still have no rule in either project.

### D-8 — CORRECTION. The frequency capability exists. I said it did not.

**What I claimed mid-session:** that Sentry's trigger list offers no frequency condition, that
the whole class was gone, and therefore that **rule 6 was unbuildable** and §4.6 permanently
unsatisfiable.

**That was wrong.** The capability moved from the **trigger** section to the **filter**
section. It is listed as **"Issue frequency"** under *Filter by issue attributes* and stores
as `Issue occurrences`. I opened the trigger dropdown, did not find it, and generalised from
one place to the whole product.

**D-2's account carries the same gap and should be read with this correction.** D-2 concluded
there was *"no 'seen more than 0 times in one hour' option"* and settled for `Every event` plus
a throttle. That fix is **not wrong** — repeats do now page, which was its purpose — but the
reason given for it is incomplete, and left unchallenged it would have written off rules 4 and
5 the same way. **Rules 4 and 5 are buildable.** Rule 5 stays superseded on its own merits
(the owner's decision, because `Every event` already supplies the repeat on
`subsystem:health_alert`), not because Sentry cannot express it.

General lesson: **a capability that has moved looks exactly like a capability that has been
removed, from inside the place it used to be.** Before concluding a product cannot do
something, check the adjacent surface.

### D-9 — CORRECTION to §4.8's evidence. My query was wrong; the finding is stronger.

**What I reported:** two missed check-ins produced no Sentry issue, established by
`search_issues` with `monitor.slug:health-alert-poller`, which returned nothing.

**The query was invalid.** `search_issues` defaults to `is:unresolved`. A cron-failure issue
for this monitor **does exist** — *"Cron failure: health-alert-poller: Your monitor is failing:
A missed check-in was detected"* — and is **`resolved`**, last seen two months ago. It was
invisible to my query by construction.

**Re-checked properly and the finding survives, on better evidence:**

- The monitor's own detail panel states the thresholds outright: **"Detect: One failed
  check-in. Resolve: One successful check-in."** So **one** miss should raise an issue. There
  were **two**.
- `detector:7655183` over 24 h **with no status filter at all** returns **"No issues match your
  search"**. Nothing was created, and the resolved issue did not regress.
- Nine consecutive clean hours precede the stop (`ok=12`/`13`, `missed=0` every hour), so both
  misses are attributable to it.

So §4.8's verdict is unchanged — **the dead-man switch detects and pages nobody** — and the
earlier caveat *"two misses may simply be below the threshold"* is now **retired**: the
threshold is documented in the UI as one.

General lesson, and it is the same shape as D-5: **a search tool's default filter is part of
the query.** `is:unresolved` is applied silently, and an absence it produces is not evidence of
absence.

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
| **T8** | **§4.4 FLAG FLIP** — `GLOBAL_DAILY_COST_LIMIT_CENTS` on the **Railway staging worker** | pre-flip value **`200`**, flipped to **`1`** | Restore to **`200`**, then `railway deployment redeploy --from-source --service repworth-worker --environment staging --yes`. **A flag flip is a fixture** — this row exists because the pre-flip value is not recoverable from anywhere else once overwritten | ✅ **restored to `200` and CONFIRMED LIVE at runtime 04:35Z**, via deployment `7f82a1a4` |
| **T9** | **§4.4** — one `generate_response` outbox row on the **`on_demand_generate`** lane, to trigger a draft against a 1-cent cap | `01a05b00-0000-7000-9000-000000000046` (review `01a05acf-fdef-7579-b350-9f843f345fc3`) | `DELETE FROM job_outbox WHERE id = '01a05b00-0000-7000-9000-000000000046'`. **Lane chosen for safety:** `on_demand_generate` is excluded from auto-approval **twice** over — by the lane itself and by `suppress_notification=true` — through `isAutoApprovalCandidate` (invariant #3), so the fixture cannot post publicly under any flag state. `live_ingest_new` was deliberately NOT used | ✅ **removed 04:14Z, verified 0 rows** |
| **T10** | **§4.9 + §4.1 (merged per D-7)** — bulk `job_outbox` backlog: past-dated, claimable, above the 1500 depth threshold | payload marker `__drill = "G3-4.1-4.9"` | `pnpm tsx scripts/burst-drill-load.ts release --drill-tag G3-4.1-4.9 --confirm-staging kubdiqdhqbhwmqfditeg`, or `DELETE FROM job_outbox WHERE payload->>'__drill' = 'G3-4.1-4.9'`. Rows use the script's own conventions — topic `stripe_subscription_mirror_sync`, `aggregate_type` `account`, a random non-existent `account_id` — so the handler self-completes with **no LLM or external spend** and never lands in `failed`, tripping none of the other health checks | ✅ **removed 04:14Z, verified 0 rows** |
| **T11** | **§4.8** — staging worker STOPPED to starve the `health-alert-poller` cron check-ins | deployment `09b7e0a5-a1ae-445e-9a6c-6671ccb315d5` | `railway deployment redeploy --from-source --service repworth-worker --environment staging --project ad641d0e-… --yes`. **This restore also completes T8** — the `200` cost-cap value was written with `skipDeploys`, so the running process held `1` until a deploy landed | ✅ **worker restored 04:28:57Z**; see the note on the concurrent push |

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

**6 of 10 pass, all Discord-confirmed.** **1 qualified fail** (§4.8 — detects, does not page). **1 unblocked tonight and not yet run** (§4.6). **1 blocked** (§4.7, D-6). **1 unattempted** (§4.10). G.3 is **not** complete.

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

---

# Session 2 verdict — 2026-09-01T05:47Z

**PARTIAL PASS, and the campaign's value is again the deviations rather than the drill count.**

## Drill state: 6 of 10 pass

| Drill | Verdict |
|---|---|
| §4.2 Failed publish | ✅ PASS (session 1) |
| §4.3 Zero-delivery | ✅ PASS (session 1) |
| §4.5 Send-breaker re-page | ✅ **PASS** — 2 pages 65 min apart across 13 emissions, Discord-confirmed |
| §4.4 Cost-cap | ✅ **PASS** — terminal at 1/5 attempts, zero provider spend, Discord-confirmed 8:58 PM |
| §4.1 Stuck outbox | ✅ **PASS** — `1961s old (> 900s)`, Discord-confirmed 9:08 PM. **Declared unrunnable by D-1; it was not** |
| §4.9 Backlog depth | ✅ **PASS** — `2350 (> 1500)`, fires **and clears**, Discord-confirmed 9:07 PM |
| §4.8 Probe stopped | ⚠️ **QUALIFIED FAIL** — detects, pages nobody (D-9) |
| §4.6 Unattributed suppression | 🔓 **UNBLOCKED tonight** — rule 6 now exists in both projects. Not yet run |
| §4.7 Killed worker | ❌ **BLOCKED** — D-6, infrastructural |
| §4.10 Capacity headroom | ⏳ not attempted |

## Deviations D-5 … D-9

| # | Finding |
|---|---|
| **D-5** | Staging sat behind a Vercel SSO wall. A `302` was read as a login redirect without following it — pass and fail shared a status code |
| **D-6** | §4.7 cannot run on staging: Sentry refuses `*.railway.app` (platform cap, 1000 monitors). Production is monitorable only via its custom domain |
| **D-7** | D-1's own remedy was wrong. It compared the loops' *cadences*; the deciding fact was their *phase* |
| **D-8** | **My correction.** The frequency capability exists — it moved from trigger to filter. Rule 6 was buildable all along |
| **D-9** | **My correction.** `search_issues` defaults to `is:unresolved`; my §4.8 query was invalid. The finding survives on better evidence |

**Three of five are corrections to this campaign's own earlier conclusions**, two of them to
claims I made in this session. That is the honest headline: the drills mostly passed, and the
reasoning around them needed more repair than the system did.

## Production changes made tonight

1. **Rule 6 created** (`3927261`) — closes D-3's live gap before solicitation sending is enabled.
2. Nothing else. No production flag, schema, data or deploy change.

## Staging changes

Rule 6 (`3927243`), `3608329` scoped, and **teardown complete**: T7–T11 all closed and verified
by query. `job_outbox` back to the demo's own 5 rows, zero failed, zero pending, breaker closed,
`GLOBAL_DAILY_COST_LIMIT_CENTS` restored to `200` and confirmed at runtime.

## Owed, carried forward

- **§4.6** — runnable now. Probe script written; the four POSTs leave one permanent
  `solicitation_suppressions` row by design.
- **§4.10** — 30-minute headroom drill, unattempted.
- **§4.7** — needs `worker-staging.repworth.net` before it can ever run.
- **§4.8** — re-run after the cron monitor's notification target is set.
- **Two §1 signals still have no rule in either project**: `subsystem:refusal_ledger`,
  `subsystem:autonomy_governor`.
- **Runbook**: §1a-do should record that "Issue frequency" is a **filter**, so rules 4 and 5 are
  not written off as unbuildable.

**UTC end (session 2): 2026-09-01T05:47Z.**

---

# Session 3 — resume, 2026-09-01T06:00Z

**Scope, in the owner's order:** §4.6, then §4.10, then §4.8's re-run after the cron
monitor is fixed. Then the PITR restore drill, then the secret rotation, then Phase H.

**Resumed from** `docs/superpowers/plans/2026-09-01-g3-remainder-handoff.md`. Teardown
ledger read first: T1–T6 and T8–T11 closed, T7 closed at `/admin/solicitation` per its own
row's instruction. Staging is clean.

## Resume preflight

| # | Check | Result | UTC |
|---|---|---|---|
| P1 | Open PRs merged before new work | ✅ PR #1053 already merged at `ff34b34d`. Only #646 remains open — CONFLICTING and obsolete, recommended for closure, not merged | 06:00Z |
| P2 | `main` up to date | ✅ `git pull --ff-only` → "Already up to date" at `ff34b34d` | 06:00Z |
| P3 | No concurrent staging work | ✅ Latest staging deploy `7f82a1a4` SUCCESS 04:28:57Z at `5358bd82`, which **is** `origin/staging`'s tip. Nothing queued or building | 06:02Z |
| P4 | Staging worker domain | ✅ `repworth-worker-staging.up.railway.app`, the only service domain; no custom domain (which is D-6's blocker for §4.7) | 06:03Z |
| P5 | Rule 6 staging config, by API readback | ✅ `3927243` — trigger `Every event` **only**; filter logic `all`, `Issue occurrences value:4` AND `Tagged event feature eq solicitation_lane`; action Discord `1517968864724385822`; frequency 60 min | 06:01Z |
| P6 | Rule 6 production config, by API readback | ✅ `3927261` — byte-identical conditions, Discord `1544045194264051842` | 06:01Z |
| P7 | Suppression-ledger baseline | ⚠️ **0 rows**, not the 5 recorded in session 2 — see **D-12** | 06:04Z |
| P8 | Target Sentry group baseline | ⚠️ `REPWORTH-STAGING-12` exists with **2 occurrences** (2026-08-26). This changes the drill's arithmetic — see **D-11** | 06:03Z |

### D-10 (2026-09-01T06:05Z) — the session-2 probe script would have failed every POST with 401

**Found by reading the ingress before running it, not by running it.**

Session 2 wrote the §4.6 probe during the §4.5 throttle wait and recorded it as "ready to
run". It signs with

```js
createHmac('sha256', secret)          // the RAW secret string as the key
```

`worker/ingress/resend.ts:62-66` verifies with

```js
const secretBytes = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
createHmac('sha256', secretBytes)     // the DECODED bytes as the key
```

Svix secrets are `whsec_` + base64. Keying the HMAC with the printable string instead of
the bytes it encodes produces a different digest for every payload, so **all four POSTs
would have returned `401 invalid_signature`** and the drill would have recorded "no page"
for POSTs 1–3 — which is the *expected* result — and then "no page" on POST 4 as well, and
concluded rule 6 was broken. A wrong probe that produces the right answer three times out
of four is the worst shape of fixture defect: it looks like it is working.

**Corrected** in the session-3 probe. The key derivation is now copied from the ingress and
the line says so.

**General lesson, same family as D-7:** the session-2 note said the signature scheme was
"resolved from code and config, not assumed". It was resolved from the *comment* above
`verifySignature`, which states the scheme correctly and says nothing about the key
derivation six lines below it. Reading the doc comment is not reading the code.

### D-11 (2026-09-01T06:05Z) — rule 6's frequency filter is LIFETIME, not hourly. The drill's arithmetic changes.

**§4.6 and §1a-do both describe rule 6 as "more than 3 in one hour".** That is not what is
built, in either project.

The API readback shows the filter as `Issue occurrences (comparison: value: 4)` — a bare
value with **no interval**. That is Sentry's
`sentry.rules.filters.issue_occurrences.IssueOccurrencesFilter`: *"the issue has happened at
least N times"*, evaluated against the group's cumulative `times_seen`. The interval-scoped
form (`EventFrequencyCondition`, *"seen more than N times in <interval>"*) carries an
`interval` parameter and this rule has none.

**Consequence for the drill.** `REPWORTH-STAGING-12` already stands at **2 occurrences**
from the #967 smoke of 2026-08-26. So the count the filter reads does not start at zero:

| POST | Group `times_seen` after | `≥ 4`? | Expected Discord |
|---|---|---|---|
| 1 | 3 | no | **silent** |
| 2 | 4 | **yes** | **PAGE** |
| 3 | 5 | yes | silent — 60-min action throttle |
| 4 | 6 | yes | silent — 60-min action throttle |

The runbook's "POSTs 1–3 silent, only the 4th pages" is therefore **not** the assertion this
configuration can produce. The assertion that survives, and that still proves everything
§4.6 exists to prove, is: **a sub-threshold POST is silent, and the threshold-crossing POST
pages.** POST 2 is also the *discriminator* between the two readings — if it pages the
filter is lifetime, if it stays silent the filter is hourly after all and the run continues
to POST 4.

**Consequence for production, which is the part that outranks the drill.** Production's rule
6 has the same lifetime filter and production's group does not exist yet, so:

1. **The first three unattributed suppressions in production will page nobody.** This alert
   is #965's detector and #965 is an open prod-flip blocker. Three silent occurrences is a
   real gap, not a tuning preference.
2. **From the fourth onward every occurrence pages**, bounded only by the 60-minute throttle
   — the count never resets, so the rule ratchets permanently from "quiet" to "page hourly".

Neither behaviour is what the runbook describes. Recorded here; the disposition is an owner
decision, taken after the drill proves the mechanics.

### D-12 (2026-09-01T06:04Z) — the recorded suppression baseline was stale

Session 2 recorded "Baseline suppressions = **5**, one of which is that smoke's
`probe-967-20260826@example.test` row". At 06:04Z:

```sql
SELECT (SELECT count(*) FROM solicitation_suppressions) AS suppressions,
       (SELECT count(*) FROM solicitation_outreach)     AS outreach,
       (SELECT count(*) FROM solicitation_contacts)     AS contacts,
       (SELECT count(*) FROM job_outbox)                AS outbox_rows;
-- suppressions 0 | outreach 0 | contacts 0 | outbox_rows 5
```

All three solicitation tables are **empty**. `job_outbox` is at the demo's own 5 rows, which
matches session 2's teardown exactly — so the outbox number was right and the suppression
number was not. The likeliest explanation is that "5" was read off `job_outbox` rather than
`solicitation_suppressions`; it cannot be re-derived now.

Consequences, both favourable: the drill's row is the ledger's **only** row, so a post-POST
count of 1 is unambiguous evidence; and the #967 smoke's `probe-967-20260826@example.test`
row is gone, so it is not evidence of anything and should not be cited again.

**Carried forward as a rule:** a baseline is only evidence if it is re-taken in the session
that uses it. This one was four hours old and wrong.

## Teardown ledger — session 3

| # | Fixture | Identifier | How to remove | State |
|---|---|---|---|---|
| **T12** | **§4.6** — one PERMANENT `solicitation_suppressions` row, global scope, channel `email`, source `complaint`, `account_id NULL`, minted from the signed payload by `suppressWithoutAttribution` | normalized handle `g3-drill-46-fictional@example.test` | **DO NOT REMOVE.** The Suppression ledger has no expiry and no ordinary delete path by design, and the admin **Correction path** is a compliance surface, not a cleanup tool. The recipient is fictional (RFC 2606 `.test`, can never resolve) and the row is account-less, so it blocks nothing real. **Left in place as its own record**, exactly as the §4.5 breaker row is | ⏳ **open — row created by POST #1** |

> Recorded **before** the first POST, per the contract. No other fixture: the drill writes no
> outbox row, flips no flag, and stops no worker.

| **T13** | **§4.10 headroom arm** — 1000 synthetic `stripe_subscription_mirror_sync` `job_outbox` rows, immediately claimable, injected over 10 min | payload marker `__drill = "G3-4.10"` | **`release` does NOT clean this arm — see D-15.** It is scoped `status = 'pending'`, and headroom-arm rows self-complete, so it deleted 0. Removed instead with the same scoped predicate on the completed rows: `DELETE FROM job_outbox WHERE topic = 'stripe_subscription_mirror_sync' AND payload->>'__drill' = 'G3-4.10' AND status = 'completed'`. No LLM or external spend; the topic never lands in `failed`, so it trips no other health check | ✅ **removed 06:23Z — verified `job_outbox` = 5 completed rows, 0 drill rows** |

> Recorded **before** injection, per the contract.

---

## §4.6 — Unattributed suppression (#967, rule 6). Findings PASS; Discord confirmation owed.

**Four svix-signed `email.complained` POSTs to `https://repworth-worker-staging.up.railway.app/ingress/resend`,
one recipient reused, four distinct `email_id`s and four distinct `svix-id`s.** Run under
`railway run --service repworth-worker --environment staging` so `RESEND_WEBHOOK_SECRET`
never transits the transcript. Probe source: session-3 scratchpad `g3-46-probe.mjs`,
corrected per **D-10**.

### Transport — all four accepted

| POST | UTC | `email_id` | HTTP |
|---|---|---|---|
| 1 | 06:05:59.339Z | `g3_46_s3_probe_1788242758687_1` | **200** `{"received":true}` |
| 2 | 06:06:38.697Z | `g3_46_s3_probe_1788242798286_1` | **200** |
| 3 | 06:07:36.602Z | `g3_46_s3_probe_1788242856179_1` | **200** |
| 4 | 06:07:36.963Z | `g3_46_s3_probe_1788242856603_2` | **200** |

A `200` on POST 1 is itself the proof that **D-10's correction was the right one** — the
session-2 key derivation would have returned `401 invalid_signature` here.

### The ledger — one row, from four POSTs

Baseline at 06:04:07Z: `solicitation_suppressions` = **0 rows** (D-12). After POST 1:

```sql
SELECT id, scope, channel, normalized_handle, account_id, source, created_at
  FROM solicitation_suppressions ORDER BY created_at DESC;
-- 01a05b93-0df6-77b6-b7e5-b423156d2b9b | global | email |
--   g3-drill-46-fictional@example.test | account_id NULL | complaint |
--   2026-09-01 06:05:59.071427+00
```

After all four POSTs: **still exactly 1 row.** First-write-wins holds across the run, which
is the property the drill's "reuse ONE fake recipient" instruction exists to demonstrate.
`account_id` is `NULL` — forced, not chosen: the fallback has no account context, and the
purge contract requires a post-purge global row not to re-introduce account provenance.

### The worker log — the write happened, and said so once

```json
{"level":"warn","logger":"ingress/resend/solicitation","timestamp":"2026-09-01T06:05:59.296Z",
 "msg":"solicitation webhook matched no outreach row — global opt-out written from the signed payload",
 "event":"email.complained","provider_message_id":"g3_46_s3_probe_1788242758687_1",
 "source":"complaint","ledger_row_written":true}
```

`ledger_row_written: true` on POST 1 and **`false`** on POST 2 (read off the Sentry event's
extra data) — the lane distinguishes "wrote a row" from "an equal-or-earlier opt-out already
won", exactly as `recordSuppression` documents. No recipient address appears in any log line.

### Sentry — the group advanced one occurrence per POST

`REPWORTH-STAGING-12`, `solicitation_suppression_without_attribution`, culprit
`POST /ingress/resend`, tags `feature: solicitation_lane`, `event: email.complained`,
`source: complaint`, `environment: staging`,
`release: 5358bd822564869492bdbb7cbc134cf74f2ecc71` (= `origin/staging` tip, so the process
under test is the branch tip).

| Moment | Occurrences | Rule fired? (`lastTriggered`, API) |
|---|---|---|
| baseline 06:03Z | 2 | — |
| after POST 1 (06:05:59Z) | **3** | no |
| after POST 2 (06:06:38Z) | **4** | **no** — see **D-13** |
| after POSTs 3–4 (06:07:36Z) | **6** | **YES, once, at 06:07:44.526Z** |

`search_events` over 24 h returns `count() = 2` for the message, confirming exactly the two
events this session added and no others.

### The assertion, as D-11 requires it to be stated

**Both halves are proven from the API and the database:**

1. **The negative** — POST 1 raised the group to 3 and the `all` filter's first clause was
   false, so no action could run. This is the half §4.6 exists for: *"a notification on the
   first is a first-seen rule wearing a frequency label."* One silent POST already disproves
   that, because a `First seen event` trigger would have fired on POST 1 regardless of count.
2. **The positive** — POST 2 raised the group to 4, satisfying both filter clauses at once.

**What only the owner can close:** whether Discord actually received the message. Sentry's
own record says the rule fired **once**, at **06:07:44.526Z** — read from
`find_alert_rules`' `lastTriggered` on rule `3927243`, which was `null`/absent before this
run. `lastTriggered` proves Sentry fired; only a human proves Discord received.

### D-13 (2026-09-01T06:11Z) — CORRECTION to D-11. `Issue occurrences: 4` fires on the FIFTH occurrence, not the fourth.

D-11 predicted, from the filter's stated meaning (*"the issue has happened at least N
times"*), that POST 2 would page — it took the group to exactly 4. **It did not.** The rule's
`lastTriggered` is `2026-09-01T06:07:44.526Z`, roughly 8 s after POSTs 3 and 4 and roughly
66 s after POST 2. A throttled rule does not update `lastTriggered` — the frequency check
runs before the fire is recorded — so this is one fire, and it is not POST 2's.

**The behaviour, stated only as far as the evidence supports it:** configured with
`value: 4`, the filter admits an event only once the group has **more than** 4 occurrences.
The fire lands on occurrence **5 or 6** (POSTs 3 and 4 are 0.36 s apart and the 60-minute
throttle admits only one of them, so this run cannot separate them). Whether the
implementation is "post-increment `> 4`" or "pre-increment `≥ 4`" is not distinguishable
here, and both describe the same predicate: **the Nth configured value pages on occurrence
N+1.**

**D-11's core finding stands and its arithmetic moves by one.** The filter is still
cumulative and still has no interval. For **production**, where the group does not yet
exist:

- The first **four** unattributed suppressions page nobody — not the first three.
- From the fifth onward every occurrence pages, bounded only by the 60-minute throttle. The
  count never resets, so the rule ratchets permanently from silent to hourly.

This alert is #965's detector and #965 is an open prod-flip blocker, so four silent
occurrences is the number that matters. **Owner decision owed:** leave `4` (pages from the
5th), or set the value to `0` so the rule pages on every occurrence and relies on the
60-minute throttle for volume control. The runbook's "more than 3 in one hour" describes
neither, and is corrected in §4.6 and §1a-do in this session.

**General lesson, and it is the third of its kind in this campaign:** D-11 read the filter's
documented meaning and predicted from it; the documented meaning was off by one. The
prediction was written down *before* the run, which is the only reason the discrepancy was
visible at all — an unrecorded prediction would have been silently rewritten to match the
result.

### D-14 (2026-09-01T06:14Z) — §4.8 has a SECOND break, downstream of the first, and last night's scoping created it

**Found while preparing §4.8's re-run, by reading the routing rules rather than the monitor.**

§4.8's recorded finding is that the cron monitor detects an outage and creates no issue, so
no rule can fire. That is one break. There is a second, and fixing the monitor alone will
not make the drill pass.

**Staging, rule `3608329` as it stands at 05:35:20Z (API readback):**

```
Action Filters — logic: any-short
  Tagged event  subsystem  eq  health_alert
  Tagged event  cost_event eq  limit_exceeded
  Tagged event  feature    eq  stripe_reconciliation
  Tagged event  subsystem  eq  import_consent_analytics
Actions — Email(issue_owners) + Discord 1517968864724385822
```

A Sentry cron-monitor issue — *"Your monitor is failing: A missed check-in was detected"* —
is generated by Sentry, not by our SDK. It carries **none** of `subsystem`, `cost_event` or
`feature`. With `any-short` logic over four tag equalities, it matches **nothing**, so the
rule cannot route it. **`3608329` is now the only Discord rule in the staging project that a
cron issue could have used, and it can no longer take one.**

**This is a consequence of last night's scoping, and it was not among the consequences
recorded.** Session 2 recorded in advance that scoping `3608329` would stop
`subsystem:refusal_ledger` and `subsystem:autonomy_governor` from paging. It did not record
that the same change cut the cron-monitor path — because at the time §4.8 had already run
(04:07–04:28Z) and the scoping landed at 05:35Z, so nothing re-tested the path afterwards.

**Production is NOT in the same state, and the difference matters.** `repworth-production`
carries an **unfiltered** rule that staging does not:

| Rule | Project | Triggers | Action filters | Discord |
|---|---|---|---|---|
| `3920752` | production | New high priority issue; Existing high priority issue | **none** | `repworth-prod` |
| `3925256` | production | five state + Every event | the same four tag equalities | `repworth-prod` |
| `3608329` | staging | five state + Every event | the same four tag equalities | `repworth-staging` |

So a production cron issue has a candidate path through `3920752` — **contingent on Sentry
classifying it high priority**, which is unverified and cannot be verified without an issue
to inspect. Staging has no path at all.

**§4.8's re-run therefore needs TWO fixes, in this order:**

1. **Make the monitor create an issue** — UI only, both projects (below).
2. **Give staging a rule that can route it.** Either add a fifth filter condition to
   `3608329` that a cron issue satisfies, or — preferred, because it keeps `3608329`'s
   scoping intact and mirrors how rule 6 was built — create a **dedicated rule 7** for the
   cron monitor in each project.

**Until both are done, re-running §4.8 can only reproduce the same qualified fail**, and
would waste a worker stop doing it. This is why the drill's precondition box now says to
verify the monitor in the UI *before* running.

---

## §4.10 — Capacity-burst headroom arm (#474, ticket #480). PASS.

### Execution gate, verified before injecting

| Gate | Result | UTC |
|---|---|---|
| A recorded **#507 PASS/closure**, not merely a closed 24h window | ✅ issue #507 CLOSED 2026-07-20T19:10:04Z with a PASS comment: *"zero health-alert timeouts and zero errors across the entire window since the poller resumed … (~36h, exceeding the 24h bar by 12h)"* | 06:08Z |
| Clean `HealthAlertPoller` baseline — no `health-alert-checks timed out`, no standing `backlog_depth` | ✅ `{"logger":"HealthAlertPoller","msg":"Idle heartbeat","idle_min":30}` at 06:04:00Z; no finding emitted since 04:12:36Z | 06:08Z |
| `HEALTH_ALERT_POLL_INTERVAL_MS` removed → 5-minute cadence | ✅ absent from the staging worker's `variableNames` (read via `get-service-config`, which returns names only — `list-variables` returns plaintext VALUES and was not called) | 06:07Z |
| Backlog at baseline | ✅ `job_outbox` = 5 rows, all `completed`; **0 pending** | 06:07Z |
| No concurrent staging push | ✅ deploy `7f82a1a4` (04:28:57Z) is still current and matches `origin/staging` | 06:02Z |

### The run

```
railway run --service repworth-worker --environment staging --project ad641d0e-… -- \
  pnpm tsx scripts/burst-drill-load.ts inject \
    --events 1000 --duration-min 10 --drill-tag G3-4.10 --confirm-staging kubdiqdhqbhwmqfditeg
```

Started **06:09Z**, exit 0. `--available-in-min` left at its default `0` — the headroom arm.

### Assertion 1 — the backlog climbs and drains, well inside the target

The script's own per-batch reading held at **`backlog_depth.job_outbox(pending)=50`** on all
20 batches — that is the count immediately after inserting a 50-row batch, before the
5-second `OutboxPoller` claims it.

**Independent samples taken against the database between batches read `pending = 0` every
time** (06:10Z, 06:13Z, 06:16Z, 06:19Z). Drain outpaces injection so completely that the
queue never holds a backlog between batches:

| UTC | pending | dispatching | completed | failed |
|---|---|---|---|---|
| 06:10Z | 0 | 0 | 55 | 0 |
| 06:13Z | 0 | 0 | 101 | 0 |
| 06:16Z | 0 | 3 | 252 | 0 |
| 06:19Z | 0 | 31 | 974 | 0 |
| **06:22Z** | **0** | **0** | **1005** | **0** |

**Peak pending observed: 50** against a threshold of **1500** — 3.3% of it. Drain complete at
06:22Z, **13 minutes** after the burst started, against a 30-minute target. **Zero rows in
`failed`**, so the burst tripped no other health check either.

### Assertion 2 — no false alarm, proven by completed cycles rather than by silence

The §4.9 definition is explicit that absence of an alert is not enough: it must be a
**completed** poller cycle that checked in clean. Three did, spanning the whole drill:

```
2026-09-01T06:19:08.081Z: ok, staging
2026-09-01T06:14:12.047Z: ok, staging
2026-09-01T06:09:13.058Z: ok, staging
```

And no health finding of any kind was emitted in the window. Queried with an explicit tag
filter and no `is:` term, per **D-9**:

```
search_events dataset=errors project=repworth-staging query='subsystem:health_alert' period=24h
→ newest finding is `outbox_failed:generate_response` at 2026-09-01T04:12:36Z.
   Nothing after it. No `backlog_depth:job_outbox`.
```

Rule `3608329`'s `lastTriggered` is **unchanged at `2026-09-01T04:07:54.047Z`** — session 2's
§4.1/§4.9 fire — so nothing routed to Discord during this drill either. Both halves agree.

**§4.10 PASSES.** Dispatch-drain and `backlog_depth` observability hold under the #474 design
burst, with no false alarm. Honest scope, unchanged from the runbook: this proves
**outbox dispatch-drain**, not full ingest→draft→notification pipeline throughput.

### D-15 (2026-09-01T06:23Z) — `release` cannot clean the headroom arm, and the runbook says the wrong thing about it

`scripts/burst-drill-load.ts release` is scoped `status = 'pending'`:

```
[burst-drill] release tag=G3-4.10 scoped DELETE WHERE topic = 'stripe_subscription_mirror_sync'
  AND payload->>'__drill' = 'G3-4.10' AND status = 'pending' AND created_at >= NOW() - make_interval(hours => 24)
[burst-drill] deleted 0 pending drill row(s).
[burst-drill] inventory clean — 0 PENDING row(s) tagged 'G3-4.10' remain.
```

That is correct for the **over-threshold** arm, whose rows are future-dated and never
claimed. Headroom-arm rows **self-complete**, so `release` deletes nothing and reports
"inventory clean" — which is true of pending rows and misleading about the run.

The runbook's headroom-arm step 5 says *"no manual cleanup is needed for this arm"*. That is
defensible — completed rows are inert and no health check counts them — but it leaves
`job_outbox` at **1005** rows where session 2's teardown deliberately restored it to **5**,
and every later drill and Phase H sanity check reads that table. Removed with the same
scoped predicate on `status = 'completed'`; verified back to 5 rows, 0 drill rows.

**Runbook fixed in this session:** the headroom arm now names the completed-row DELETE
instead of saying no cleanup is needed, and says why `release` does not cover it.

---

# Session 3 verdict — 2026-09-01T06:25Z

**PARTIAL PASS. G.3 moves from 6 of 10 to 8 of 10, and — for the third session running — the
deviations are worth more than the drill count.**

## Drill state: 8 of 10 pass

| Drill | Verdict |
|---|---|
| §4.2 Failed publish | ✅ PASS (session 1) |
| §4.3 Zero-delivery | ✅ PASS (session 1) |
| §4.5 Send-breaker re-page | ✅ PASS (session 2) |
| §4.4 Cost-cap | ✅ PASS (session 2) |
| §4.1 Stuck outbox | ✅ PASS (session 2) |
| §4.9 Backlog depth | ✅ PASS (session 2) |
| **§4.6 Unattributed suppression** | ✅ **PASS** — 4 POSTs, 1 permanent ledger row, rule fired once at 06:07:44.526Z. Discord confirmation owed |
| **§4.10 Capacity headroom** | ✅ **PASS** — peak pending 50/1500, drained in 13 min of a 30-min target, zero `failed`, no false alarm |
| §4.8 Probe stopped | ⚠️ **QUALIFIED FAIL** — and **two** breaks now, not one (D-14) |
| §4.7 Killed worker | ❌ **BLOCKED** — D-6, infrastructural |

## Deviations D-10 … D-15

| # | Finding |
|---|---|
| **D-10** | The §4.6 probe session 2 recorded as "ready to run" would have returned `401` on **every** POST — raw secret string as the HMAC key where the ingress uses the decoded bytes |
| **D-11** | Rule 6's frequency filter is **cumulative with no interval**, not "in one hour" — the runbook describes a rule Sentry cannot express this way |
| **D-12** | The recorded suppression baseline of 5 was stale; all three solicitation tables were empty |
| **D-13** | **Correction to D-11.** `Issue occurrences: N` fires on occurrence **N+1**. Predicted a page at 4; it came at 5/6 |
| **D-14** | **§4.8 has a second break.** A cron issue carries no application tags, so staging's newly-scoped `3608329` cannot route it — and it is staging's only Discord rule. Created by last night's scoping, after the drill ran |
| **D-15** | `release` cannot clean the §4.10 headroom arm — scoped `status='pending'` — and prints "inventory clean" regardless |

**Four of six correct a claim that was standing when the session began**, two of them written
by session 2 hours earlier, and one (D-13) correcting a prediction this session made itself.
The pattern across all three sessions is now unambiguous: **the reasoning around this
campaign needs more repair than the system does.**

## What made the difference this session

**Every one of D-10, D-11 and D-14 was found by reading before running, not by running.** The
probe defect, the filter semantics and the routing gap would all have surfaced as drill
failures, and two of the three would have been misread — a `401` reads as a broken rule, and
a §4.8 re-run would have reproduced the same qualified fail and spent a worker stop doing it.

**And D-13 was only visible because D-11's prediction was written down before the run.** An
unrecorded prediction gets silently rewritten to match the result.

## Changes made

**Production:** none. No flag, schema, data, deploy or rule change.

**Staging:** one permanent `solicitation_suppressions` row for a fictional `.test` recipient
(T12, left in place by design). Nothing else — T13 removed and verified, `job_outbox` back to
its 5 demo rows.

**Documentation:** `beta-launch-alerting.md` §1a-do (frequency-filter semantics corrected),
§4.6 (ticked, plus the D-10 signing trap and the D-11/D-13 arithmetic), §4.8 (D-14
precondition), §4.10 (ticked); `pool-wedge-burst-drill.md` headroom-arm cleanup (D-15);
`beta-production-standup.md` G3; `lab-notes.md`; this file; the session-2 handoff.

## Owed, carried forward

- **§4.6 Discord** — owner confirmation of one message at ~06:07:44Z, and of **silence** at
  06:05:59Z and 06:06:38Z. The silence is the half that matters.
- **§4.8** — the monitor fix **and** a dedicated cron routing rule, in both projects.
- **§4.7** — needs `worker-staging.repworth.net` before it can ever run.
- **An owner decision on rule 6's threshold** in production: leave `4` (silent for the first
  four, then hourly forever) or set `0` (every occurrence, throttled hourly).
- **Two §1 signals still have no rule in either project**: `subsystem:refusal_ledger`,
  `subsystem:autonomy_governor`.

**UTC end (session 3): 2026-09-01T06:25Z.**

---

## §4.6 — Discord CONFIRMED by the owner. Drill closes PASS on both halves.

**Owner screenshot, 2026-09-01:** exactly **one** Sentry message —
*`solicitation_suppression_without_attribution` · REPWORTH-STAGING-12 via
solicitation-unattributed-suppression → discord* — at **11:07 PM local (= 06:07Z)**, matching
rule `3927243`'s `lastTriggered` of `06:07:44.526Z`.

**The negative half is confirmed by the same screenshot**, and the reasoning is worth writing
down because it is not obvious: Discord collapses consecutive messages from one app under a
single header stamped with the **first** message in the group. The header reads **11:07 PM**.
A page at 11:05:59 PM or 11:06:38 PM would have opened the group earlier and carried the
header. It did not. So POSTs 1 and 2 produced **no** Discord message — which is the assertion
§4.6 exists for: *"a notification on the first is a first-seen rule wearing a frequency
label."*

**§4.6: PASS.** Transport, ledger, log, Sentry group, rule fire and Discord delivery all
verified.

### D-16 (2026-09-01T06:40Z) — §4.8's remedy was wrong. The monitor's threshold is already 1, and the API can be made to prove it.

**The handoff and the runbook both said to open the monitor and "set an issue-creating
failure threshold". That instruction cannot help: it is already set correctly.**

The value is not exposed by the monitor endpoint, which is why two sessions treated it as
UI-only. It **is** exposed — as a snapshot embedded in any cron issue the monitor has
produced. `REPWORTH-STAGING-8` carries it:

```
monitor.config: {
  "checkin_margin": 5,
  "failure_issue_threshold": 1,     ← one failed check-in creates an issue
  "recovery_threshold": 1,
  "max_runtime": 5,
  "schedule": "*/5 * * * *",
  "schedule_type": 1,
  "timezone": "UTC"
}
```

This agrees with the panel's *"Detect: One failed check-in"* that session 2 read. Two
independent sources, one conclusion: **the threshold is 1, two check-ins were missed, and no
issue was created.** The finding is not "misconfigured tolerance".

**Three further facts this issue settles, each of which had been an assumption:**

1. **The monitor CAN create issues, and has.** `REPWORTH-STAGING-8` — *"Cron failure:
   health-alert-poller"*, issue type `monitor_check_in_failure`, category **`outage`**, failure
   reason *"A missed check-in was detected"*, **225 occurrences** across 2026-06-26. So a
   **missed** check-in does count toward `failure_issue_threshold`; the missed/failed
   distinction is not the blocker either.
2. **D-14 is confirmed by direct evidence rather than by inference.** The issue's complete tag
   set is `environment`, `interface_type`, `level`, `monitor.id`, `monitor.incident`,
   `monitor.slug`. **No `subsystem`, no `cost_event`, no `feature`** — so `3608329` and
   `3925256` genuinely cannot route it.
3. **`monitor.slug` IS a tag**, so `Tagged event: monitor.slug eq health-alert-poller` is a
   viable filter for the dedicated rule, rather than a hoped-for one.

**And one lead that is now the best hypothesis for the real cause.** The only cron issue this
monitor has ever produced is tagged **`environment: production`** — on a project whose
check-ins are all `staging`. That is the stale `production` environment §2a exists to clean
up (#610). The monitor today lists exactly one environment, `staging`, which has **never**
produced a cron issue. Production's own monitor has never produced one either
(`search_issues` `monitor.slug:health-alert-poller` over 90 d against `repworth-production`,
no `is:` term → zero results).

**Why the notification target is still the thing to check, and now for a code-grounded
reason.** The monitor is auto-created by `recordProbeCheckIn`
(`worker/background/pollers/health-alert/emit.ts`), whose `monitorConfig` upsert passes only
`schedule`, `checkinMargin` and `timezone`. It passes **no owner and no alert rule** — and
those are not fields an SDK check-in upsert can set. `find_monitors` reports `owner: null` on
**both** monitors, consistent with that. So the gap is where session 2 said it was; the
*reason* is that nothing in our code has ever been able to set it.

**Revised §4.8 remedy — VERIFY, do not set:**

1. Confirm `failure_issue_threshold` reads **1** in the UI. Do not change it.
2. Attach a **notification target / owner** to the monitor — the field the SDK upsert cannot
   reach.
3. Check the monitor's **environment list** for a stale `production` entry, and whether the
   `staging` environment has any incident history at all.
4. Create the **dedicated routing rule** (below), because even a created issue has nowhere to
   go today.

Only then spend a worker stop on the re-run.

## Decision — rule 6's threshold. Delegated to best practice by the owner, 2026-09-01.

**Remove the `Issue occurrences` filter from rule 6 in BOTH projects.** Keep the `Every event`
trigger, keep `Tagged event feature eq solicitation_lane`, keep the 60-minute throttle.

**Three reasons, in order of weight:**

1. **A detector for an open blocker must not be silent on its first occurrences.** D-13
   measured that `value: 4` means the first four page nobody. This alert is #965's detector,
   #965 is unexplained staging Outreach loss, and it is a prod-flip blocker. A rule that
   guarantees four silent occurrences of exactly the thing you are hunting is the wrong
   trade — and unattributed suppression is not routine traffic by construction: it happens
   only via the seconds-wide #630 commit race, an account purge, or a send whose terminal CAS
   lost.
2. **The filter is the wrong instrument, not a mistuned one.** The intent — *"more than 3 in
   one hour"* — is a **rate**. `IssueOccurrencesFilter` is a lifetime count with no interval.
   Tuning a cumulative counter cannot approximate a rate: four singles spread over a year
   trip it exactly as four in a minute do, and after that it never resets.
3. **Volume control already exists and is the right kind.** The 60-minute Action Throttle caps
   this at one page per hour per issue regardless of event rate — which is the standard way to
   damp a noisy detector without ever making it blind.

**If it proves noisy, the correct fix is a Sentry METRIC alert** on `count()` of
`feature:solicitation_lane` over a 1-hour window. That is the alert type that actually
expresses "N in an interval". Do not reach back for the occurrence filter.

**Rule 6's shape after the change:**

| Section | Value |
|---|---|
| **WHEN** | `An event or issue activity is captured` — the only trigger |
| **IF** | `Tagged event` · `feature` `eq` `solicitation_lane` — the only filter |
| **THEN** | Discord → `1517968864724385822` (staging) / `1544045194264051842` (production) |
| Throttle | 60 minutes |

**This does not invalidate §4.6's PASS.** The drill proved the trigger set, the filter
mechanics, the tag match and Discord delivery. Widening the rule strictly increases what it
catches; it removes no assertion the drill made.

## Decision — §4.8's routing. Delegated to best practice by the owner, 2026-09-01.

**A dedicated cron rule per project, not a widening of `3608329` / `3925256`.**

The catch-all rules were deliberately scoped last night to four subsystem/feature tags.
Widening them to admit cron issues would either re-open the noise that scoping closed, or
require an `any-short` clause so broad it silently re-admits everything else too. A separate
rule keeps each concern independently tunable and independently readable — which is the whole
reason rule 6 was built as its own rule rather than folded into `3608329`.

Filter on `monitor.slug`, now verified as a real tag on `REPWORTH-STAGING-8`.

> **Caveat, recorded rather than assumed:** cron issues are category `outage` / type
> `monitor_check_in_failure`, not `error`. Whether Sentry's issue-alert pipeline evaluates
> this rule for an `outage`-category issue is **unverified** — there is no cron issue to test
> against, which is D-16's whole point. The rule is the correct first step and the §4.8
> re-run is what proves it. **If the re-run creates an issue and the rule still does not
> fire, the answer is the monitor's own notification configuration, not the rule.**

---

## Sentry configuration executed by browser, 2026-09-01T18:00–18:20Z

### DONE — rule 6's occurrence filter removed in BOTH projects

Confirmed by API readback after the edit, not from the form:

| | Staging `3927243` | Production `3927261` |
|---|---|---|
| Trigger | `Every event` — the only one | identical |
| Filter (`all`) | `Tagged event feature eq solicitation_lane` — **the only one** | identical |
| Discord | `1517968864724385822` | `1544045194264051842` |
| Throttle | 60 minutes | 60 minutes |
| `dateUpdated` | `2026-09-01T18:08:43.821Z` | `2026-09-01T18:09:17.120Z` |

`3927243` keeps `lastTriggered 2026-09-01T06:07:44.526Z`, so §4.6's evidence is intact. Its
detail page independently corroborates the drill: **Total Triggers 1** over 14 days, the single
entry being `Sep 1, 6:07 AM UTC` against issue `solicitation_suppression_without_attribution`.

### D-16 CONFIRMED IN THE UI, and the vocabulary matters

The staging monitor's edit form reads:

- **Failure Tolerance = 1** — *"Create a new issue when this many consecutive **missed or error**
  check-ins are processed."* So a **missed** check-in counts, in Sentry's own words, and the
  threshold is already correct. Every "set the threshold" instruction in the handoffs is retired.
- **Recovery Tolerance = 1**, Grace Period 5, Max Runtime 5.
- **Issue Ownership → Assign: unset.**
- A banner: *"This monitor is managed in code and updates automatically with each check-in.
  Changes made here may be overwritten!"* — consistent with `recordProbeCheckIn`'s upsert.

**And the actual gap, found in the UI and not visible from the API:** section **6. Alert** —
*"Configure alerting on this Monitor to get notified on issues"* — is **EMPTY**. No alert is
connected to the monitor. Beneath it: *"Alerts configured for all Issues in the project
`repworth-staging` will also apply to this Monitor"* — which is precisely the path D-14 showed
is closed, because `3608329`'s four tag equalities cannot match a cron issue.

**So §4.8's chain is now fully mapped:** the monitor detects correctly, its thresholds are
correct, it has **no connected alert**, and the one project-wide rule that would otherwise apply
filters on tags a cron issue does not carry.

### D-17 (2026-09-01T18:20Z) — BLOCKED. Sentry's monitor-alert UI cannot create a working rule.

**Three distinct paths were tried. All three fail, and two of them fail while appearing to
succeed.**

| # | Path | Result |
|---|---|---|
| 1 | Monitor edit → **Create New Alert** → fill form → Create | Page goes **blank** (React crash). A rule **IS** created — but with **no project and no monitor**. Repeated once, producing a second orphan |
| 2 | Rule edit → Source **"Alert on specific monitors"** → Connect Monitors → `health-alert-poller` → Save | Form shows the monitor connected. Save appears to run (`Last modified` advances). **The connection does not persist** |
| 3 | Monitor edit → **Connect Existing Alerts** → Connect | Section 6 immediately re-renders as *"6. Connected Alerts"* listing the rule. Closing the drawer goes **blank**. **The connection does not persist** |

Sentry states the outcome itself, on the rule's own page:

> ⚠️ **"This alert is not connected to a project or monitor and will not trigger."**

**Two orphan rules exist and MUST NOT be mistaken for working alerting** — they are exactly the
"looks configured, pages nobody" shape this whole campaign is about:

| Rule | Name | State |
|---|---|---|
| `3930310` | `cron-health-alert-poller to discord` | Project `—`, Monitor `—`, will not trigger |
| (sibling) | `cron-health-alert-poller -> discord` | Project `—`, Monitor `—`, will not trigger |

Neither appears in `find_alert_rules(projectSlug='repworth-staging')`, because neither belongs
to a project — the API and the UI agree that they are orphans.

**Assessment:** this is a defect in Sentry's new alert UI, not a configuration mistake. The
create call omits the project, and both connect paths crash before committing. **§4.8 stays
BLOCKED**, now on a vendor defect rather than on our own configuration — which is a different
disposition from D-14 and should be recorded as such.

**Options, for the owner:**

1. **Sentry support ticket**, quoting D-17's three paths. The orphan rules are reproducible
   evidence.
2. **Create the rule through the Sentry API** (`POST /api/0/projects/repworth-nv/repworth-staging/rules/`)
   with a PAT, bypassing the UI entirely. This needs a token the session does not hold.
3. **Widen `3608329`** with a fifth `Tagged event monitor.slug eq health-alert-poller` clause —
   its `any-short` logic makes this additive, so it re-opens the cron path without touching the
   four existing clauses. **This contradicts the "dedicated rule" decision above**, and is the
   pragmatic fallback if 1 and 2 are unavailable.

**Also observed, and separately worth a line:** the staging monitor's page carries a red banner
*"Errors were encountered while ingesting check-ins for this monitor"* — **`3x Rate limited`**,
*"A sent check-in was dropped due to being rate limited."* Dropped check-ins on a dead-man
switch are a false-positive source. Not investigated; recorded.
