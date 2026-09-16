# Evidence — the four open alerting gaps, closed

Runbook: [`beta-launch-alerting.md`](../beta-launch-alerting.md) §1 and §4 · prior record
[`2026-08-31-g3-alerting-acceptance-drills-evidence.md`](2026-08-31-g3-alerting-acceptance-drills-evidence.md)
(sessions 1–3, which left §4.7 BLOCKED and §4.8 a QUALIFIED FAIL).

Owner @norbertesekiel, 2026-09-16, 14:00Z → 15:10Z. Production reads only; every mutation was on
staging, on Sentry configuration, or on DNS. **Times below are UTC; PDT is UTC−7.**

---

## §4.8 — the stopped probe. PASS on production, organically.

The 2026-09-01 re-run concluded *"Sentry creates no issue for a missed check-in"* and named a
support ticket as the next step. **That conclusion was true for staging and false for production.**
Production's monitor has been creating issues and paging ever since.

| Link in the chain | Evidence |
|---|---|
| Worker misses check-ins | 4 organic misses on the production monitor `e891f020-…`: 2026-09-06T21:05Z, 09-10T15:25Z, 09-10T15:40Z, **09-13T05:20:00Z**. None coincides with a deploy |
| Sentry creates an issue | **`REPWORTH-PRODUCTION-3`**, `monitor_check_in_failure`, category **outage**, failure reason *"A missed check-in was detected"*, 4 occurrences |
| A rule can route it | `3925256` carries the `Issue category` = outage clause added by the 2026-09-01 D-14 fix |
| The rule fires | **`lastTriggered` 2026-09-13T05:20:49Z** — 49 s after the miss |
| Discord receives it | **Owner-confirmed screenshot**: "Cron failure: health-alert-poller … via Prod — four ops signals to Discord", 9/12/26 10:20 PM PDT |

**The dead-man switch for the `HealthAlertPoller` works in the environment it exists to protect.**

### Why staging still fails, and why the drill misled

Staging's monitor `e925e758-…` has produced **zero** cron issues (searched `issue.category:outage`
and `issue.category:crons`, 30 d, which covers the 2026-09-01 drill). The two monitors differ in
exactly one place — their config:

| Field | production | staging |
|---|---|---|
| `failure_issue_threshold` | **null** (Sentry default) | explicitly set |
| `max_runtime` | **null** | **5** |

So the environment whose config was hand-edited during the G.3 sessions is the one that stopped
creating issues, and the untouched one works. **Lesson, and it is the same shape as D-16: a drill
run against a monitor configured differently from production proves nothing about production.**
Not chased further — production is proven, staging is a test rig. Worth an hour if someone wants
staging parity: clear both fields and re-run.

## §4.7 — the killed worker. PASS, and the blocker is gone.

D-6 blocked this drill because Sentry refuses uptime monitors on `*.railway.app` and the staging
worker had no other hostname.

**Unblocked:** `worker.staging.repworth.net` added to the Railway staging service
(domain `8f8fe7d7-…`), two Cloudflare records added by the owner (CNAME → `d7psxfev.up.railway.app`,
TXT `_railway-verify.worker.staging`), certificate issued ~7 min later, `/ready` 200 at 14:20:52Z.

**Monitor:** `10354501` "Staging worker /ready" — created to **mirror production `8341697` exactly**
(GET, 300 s interval, 10 s timeout, downtime threshold 3, recovery threshold 1, response capture on),
because of the §4.8 lesson above.

| UTC | PDT | Event |
|---|---|---|
| 14:24:42 | 7:24:42 AM | Baseline check **success**, HTTP 200 |
| 14:27:19.884 | 7:27:19 AM | Staging deployment `039cd19e` **REMOVED** — worker down |
| 14:29:42 | 7:29:42 AM | Failed check 1 — HTTP 404 |
| 14:34:42 | 7:34:42 AM | Failed check 2 — HTTP 404 |
| 14:39:42 | 7:39:42 AM | Failed check 3 — HTTP 404 |
| **14:39:44.479** | **7:39:44 AM** | **`REPWORTH-STAGING-1E`** created — `uptime_domain_failure`, category outage |
| ~14:40 | 7:40 AM | **Discord message, owner-confirmed**: "Downtime detected for https://worker.staging.repworth.net/ready — failure - Got non 2xx status: 404 Not Found" |
| 14:48:33 | 7:48:33 AM | Restore issued, **`--from-source`** (D-18) |
| 14:50:02 | 7:50:02 AM | `/ready` 200; deployment `d55a00aa` at **`35b7e8c7f`**, the `staging` tip — commit verified, not assumed |
| 14:54:42 | 7:54:42 AM | Check success → issue **auto-resolved** |

**Detection budget, measured: 13 minutes from stop to page**, set by 3 checks × 5 min. Production
runs the identical configuration, so production's number is the same. Lowering the interval to 60 s
would make it ~3 min; not changed, because it is a cost/noise decision for the owner.

The prediction (issue at ~14:39:42, page right after) was written **before** the third check and
held to 2 seconds.

## `endpoint:admin-mfa-gate` → Discord (#1212). DONE.

Created through the Sentry UI (the MCP can read alert rules but not create them), then **verified by
API readback, not by the screen**:

```
Prod — admin-mfa-gate 500 → discord   id 3999385   enabled   project repworth-production
WHEN  any: First seen · Resolved · Reappeared · Regression · Every event
IF    all: Tagged event  endpoint == admin-mfa-gate
THEN  Discord integration 443670 → channel 1544045194264051842, tags repworth-prod
Throttle 60 minutes
```

### Deviation D-19 — the runbook's "more than 5 events in 10 minutes" was NOT applied

The builder's only frequency filter for this shape reads *"The issue has happened at least N times"*
with **no interval** — a cumulative counter, which is exactly the instrument the owner rejected on
2026-09-01 (rule 6's occurrence filter: *"a detector for an open blocker must not be silent on its
first N occurrences … the 60-minute throttle is the correct volume control"*). Applying it would
have made the first four admin-gate 500s page nobody, forever.

**Resolution: no frequency filter; the 60-minute action throttle is the volume control**, matching
every sibling rule (`3925256`, `3927261`, `3946648`, `3984518`). §1's threshold sentence is corrected
in the runbook in the same change as this file.

## U1's server half — accepted, not proven (owner decision, 2026-09-16)

No server-side error has ever reached production Sentry from `repworth.net`, because the server has
not thrown one; a search over 90 d finds only the browser probe and one event from a laptop (D-9).
The owner chose to accept rather than add a permanent throw-only endpoint:

- the browser event reached the project **and paged** (below),
- server and browser DSNs name the **same project** `4512002871001088`,
- the worker's `@sentry/node` SDK delivers to that project continuously — every cron check-in.

What stays unproven is one line, `onRequestError = Sentry.captureRequestError`
(`src/instrumentation.ts:9`). Recorded as accepted risk.

### Correction to the 2026-09-14 record

Resume 2 → R10 states the U1 probe *"matched no Discord rule, so nothing paged."* **That is wrong.**
Rule `3920752` ("Send a notification for high priority issues", unfiltered) fired at
2026-09-14T09:43:14.964Z, and the owner's Discord shows the message at 9/14/26 2:43 AM PDT. The
probe DID page. Corrected in that file in the same change.

## State after this session

| Item | Before | After |
|---|---|---|
| §4.7 killed worker | BLOCKED (D-6) | **PASS**, with a permanent staging uptime monitor |
| §4.8 stopped probe | QUALIFIED FAIL | **PASS on production**, organically; staging discrepancy documented |
| `admin-mfa-gate` rule | missing | **`3999385`, verified** |
| U1 server half | open | **accepted**, with the paging correction |
| G.3 drill tally | 8 of 10 | **10 of 10** |

Teardown: staging worker restored and verified; no fixture left behind. The uptime monitor and the
custom domain are deliberate keepers, not fixtures.
