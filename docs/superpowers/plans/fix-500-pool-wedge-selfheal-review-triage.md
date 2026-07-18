# #500 — Step 6 adversarial review triage (Codex)

Codex verdict: **needs-attention**. Full output preserved below; triage verdicts inline.

## Findings + verdicts

### F1 [high] Transient startup outage permanently disables the reaper — ACCEPTED
`PoolWedgeReaperPoller.initPoolWedgeReaper` swallowed any verification error into
`verified=false`, which fed `disableWithAlert` (process-lifetime `disabled`).
A brief DB/network blip during boot verification thus permanently removed the
backstop until process restart — the exact degraded-dependency case the reaper
exists to survive. **Real.** Fix: three-way verify outcome; permanent disable
only on a *confirmed* pooler echo (or absent config, which is env-immutable);
transient transport/timeout errors stay fail-closed and RETRY on the next poll.

### F2 [medium] Recycled reaper clients bypass direct-route verification — ACCEPTED
`recycleReaperClient` assigned a freshly-built client into `reaperSql` without
re-running the app_name-echo check, so a post-recycle route change (DNS/failover/
topology) could run sweeps through Supavisor — violating the runtime-verified-
direct invariant. **Real.** Fix: recycle only ends+nulls the client; the next
tick re-acquires through the SAME verify path, so no unverified client is ever
swept on.

## Fix (unified — both findings, one root cause)
Root cause: verification ran exactly once at boot and conflated transient errors
with definitive negatives. Change:
- `acquireVerifiedClient(logger)` → discriminated `{status:'verified',client}` |
  `{status:'pooler'}` | `{status:'transient'}`. A query that RETURNS a row whose
  `application_name` ≠ `rw-wedge-reaper` is a *definitive* non-direct route
  (`pooler`); a thrown/timed-out verify is *indeterminate* (`transient`).
- `initPoolWedgeReaper`: absent URL → permanent disable (env immutable). Else
  acquire: `verified` → set client + schedule; `pooler` → permanent disable +
  alert; `transient` → schedule the loop anyway (defer; retry next tick), do NOT
  set `disabled`.
- `pollPoolWedgeReaper`: if `!reaperSql`, acquire first — `pooler` → disable,
  `transient` → skip this tick (retry next), `verified` → sweep. Single-flight
  (`isPolling`) unchanged.
- `recycleReaperClient`: end+null only; next tick re-acquires-and-verifies.
- Retry backoff = the poll cadence (60s). No separate jittered retry loop — the
  loop IS the retry, matching the poller precedent (design.md: fewer moving
  parts). Documented as a deliberate choice.

Invariant strengthened: **the reaper only ever sweeps on a verified-direct
connection at every point in its lifecycle** (not just at boot).

## Codex output (verbatim)
Target: working tree diff · Verdict: needs-attention
No-ship: the branch’s automated gate is green, but the reaper can be permanently
lost after a transient boot failure and can later run on an unverified
replacement connection. The required staging termination tracer is also pending.
- [high] A transient startup outage permanently disables the reaper
  (PoolWedgeReaperPoller.ts:185-194)
- [medium] Recycled reaper clients bypass direct-route verification
  (PoolWedgeReaperPoller.ts:141-145)
Next steps: fix+test both verification-lifecycle failures; then run the staging
active+ClientRead tracer (direct routing, actual termination, reconnect, shared-
pool isolation) before shipping.
