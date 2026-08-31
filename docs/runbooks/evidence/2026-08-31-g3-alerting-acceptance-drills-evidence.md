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

---

## Drill results

| Drill | Finding fires | Reaches Sentry | **Pages Discord** | Verdict |
|---|---|---|---|---|
| **§4.1** Stuck outbox | — | — | — | **BLOCKED** (D-1) |
| **§4.2** Failed publish | ✅ `outbox_failed:publish_response` | ✅ `REPWORTH-STAGING-9`, 2 events | ❌ | **QUALIFIED FAIL** — the drill worked, the alert route did not (D-2) |
| **§4.3** Zero-delivery | ✅ `zero_delivery_notifications` | ✅ `REPWORTH-STAGING-G`, 2 events | ❌ | **QUALIFIED FAIL** — same cause (D-2) |

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
| §4.1 Stuck outbox | **BLOCKED** | D-1 — unrunnable as written; needs reordering behind a worker stop |
| §4.2 Failed publish | fires + reaches Sentry; **does not page** | D-2 — reopen once the trigger set is fixed |
| §4.3 Zero-delivery | fires + reaches Sentry; **does not page** | D-2 — reopen once the trigger set is fixed |
| §4.4 Cost-cap hit | open | Not attempted |
| §4.5 Send breaker re-page | open | **Blocked in substance by D-2** — this drill asserts *more than the opening two* notifications, and the current trigger set cannot produce repeats at all |
| §4.6 Unattributed suppression | open | Not attempted. Asserts one notification on the 4th event — also a repeat-suppression case, so re-read D-2 before running it |
| §4.7 Killed worker | open | Not attempted. Pairs with §4.1 under D-1's proposed reordering |
| §4.8 Probe stopped | open | Not attempted. Cron-monitor path — **unaffected by D-2**, since a missed check-in is a different mechanism |
| §4.9 Backlog over threshold | open | Not attempted |
| §4.10 Capacity burst headroom | open | Not attempted |

**Eight of ten drills remain unattempted, and the two that ran did not fully pass.** No path
is being recorded as proven on partial evidence.

---

## Runbook feedback (contract step 7)

Two defects in `beta-launch-alerting.md` §4, neither yet applied — both change drill
*ordering* and want owner sign-off first:

1. **§4.1 is unrunnable in isolation** (D-1). Fold it into the §4.7 worker-stop drill.
2. **§4 assumes a repeat finding pages** (D-2). §4.5 and §4.6 are both written as
   *count* assertions ("more than the opening two", "one notification once the fourth
   crosses"). Under the current Sentry trigger set neither can pass, no matter how correct
   the application code is. §4 needs a stated precondition that the alert rules carry a
   frequency trigger — otherwise it tests the application and silently exempts the alerting.

---

## Verdict

**FAIL — and the failure is the point.**

- **Teardown: COMPLETE.** All three fixtures removed 21:21Z and verified gone by query. Every
  baseline matches preflight exactly: outbox `pending 0 / failed 0 / total 49`, suppressions
  `5`, breaker `0` open. **Staging is in its pre-campaign state.**
- **No flags were flipped**, so no flag baseline needed restoring.
- **Production was never touched** by this campaign. The production finding in D-2 came from
  reading an alert rule, not from exercising anything.
- **Deviations:** D-1 (runbook defect, §4.1 unrunnable), D-2 (**production alerting defect** —
  recurring ops findings do not page).
- **Unproven paths:** 8 unattempted, 2 qualified. G.3 is **not** complete.

**What this campaign is worth.** It ran two of ten drills and found that the alerting those
drills exist to validate has a hole in production. The application side works — findings
compute correctly and reach Sentry within one poll interval, exactly as designed. The paging
side only works for a signal's **first ever** occurrence.

**Recommended next action, before any further drill:** fix the trigger set on both rules
(`3608329` staging, `3925256` production), then re-run §4.2 and §4.3 — they are now cheap,
scripted and proven-correct fixtures, so they double as the regression test for the fix.

**UTC end (this session's portion): 2026-08-31T21:22Z.**
