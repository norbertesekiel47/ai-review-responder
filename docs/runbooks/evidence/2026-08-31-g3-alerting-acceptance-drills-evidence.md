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

---

## Drill results

| Drill | Finding fires | Reaches Sentry | **Pages Discord** | Verdict |
|---|---|---|---|---|
| **§4.1** Stuck outbox | — | — | — | **BLOCKED** (D-1) |
| **§4.2** Failed publish | ✅ `outbox_failed:publish_response` | ✅ `REPWORTH-STAGING-9` | ✅ **after the D-2 fix** | **PASS** |
| **§4.3** Zero-delivery | ✅ `zero_delivery_notifications` | ✅ `REPWORTH-STAGING-G` | ✅ **after the D-2 fix** | **PASS** |

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
| §4.5 Send breaker re-page | open | **Now runnable.** It asserts *more than the opening two* notifications — impossible before D-2 was fixed, possible now |
| §4.6 Unattributed suppression | open | **Now runnable**, same reason. Leaves one permanent ledger row — read the teardown note first |
| §4.7 Killed worker | open | Pairs with §4.1 under D-1's reordering |
| §4.8 Probe stopped | open | Cron-monitor path — was never affected by D-2 |
| §4.9 Backlog over threshold | open | Not attempted |
| §4.10 Capacity burst headroom | open | Not attempted |

**2 of 10 pass. 7 remain unattempted, 1 blocked.** G.3 is **not** complete.

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
