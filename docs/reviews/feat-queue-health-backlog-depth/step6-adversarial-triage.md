# Step 6 — Adversarial review triage (Codex)

Branch: `feat-queue-health-backlog-depth` · Verdict from Codex: **needs-attention**
Reviewer framing: challenge the approach — the observability read can amplify DB degradation; its failure can suppress more critical alerts.

| # | Sev | Finding | Verdict | Resolution |
|---|-----|---------|---------|------------|
| 1 | high | Timed-out backlog reads keep consuming the shared worker DB pool (withTimeout bounds the wait, not the query → detached query holds a pooled connection to the 30s statement_timeout; concurrent endpoint hits can starve outbox/webhooks) | **ACCEPT** | Bound the DB op itself: `queryBacklogDepth` runs in `sql.begin()` with `SET LOCAL statement_timeout = 4000`, so Postgres cancels a slow count at ~4s and frees the connection. Belt-and-suspenders with the handler's 4000ms `withTimeout`. New regression test asserts the statement-timeout is set. |
| 2 | medium | A backlog-count failure suppresses every existing health finding (`runHealthChecks` `Promise.all` fails fast) | **ACCEPT (minimal scope)** | Isolate MY check only: wrap `checkBacklogDepth` so its rejection can't reject the batch; on failure emit a `warning` diagnostic (`health_check_error:backlog_depth`). The other 5 checks still emit. New test: backlog check throws + another check returns a finding → the other finding still emits + the diagnostic appears. |

## Rejected / deferred
- Codex's broader recommendation for #2 (`Promise.allSettled` over ALL six checks) is **deferred, not applied.** The all-or-nothing shared fate of the *existing* 5 checks is pre-existing behavior outside ticket #480's scope, and switching it changes existing `recordProbeCheckIn('error')` paging semantics. Tracked as a follow-up: "Harden runHealthChecks to per-check isolation (allSettled) so any single check failure can't blank the cycle."

## Next-steps (from Codex, accepted)
- After #500 resumes the staging poller: run the over-threshold alert drill + the 1000-event burst/drain drill before promotion (already documented in `beta-launch-alerting.md` §4).
