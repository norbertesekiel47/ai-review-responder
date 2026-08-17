# #651 Independent Branch Review Round 1 — Root Triage

**Fixed merge base:** `a6e38fe9b1fbc14da340947319976615eccebe5b`  
**Review lanes:** spec/correctness, maintainability, database/async operations  
**Root disposition:** all actionable findings accepted

## Finding 1 — rolling worker overlap was absent from Max-Clients arithmetic

**HIGH · ACCEPT.** The plan and ADR modeled one 24-slot Railway worker and
called 15 warm Vercel isolates safe. Zero-downtime deployments normally overlap
old and new worker processes, so deployment capacity must use
`48 + isolates×11 < 200`. The rollout-safe aggregate bound is 13
(`48 + 13×11 = 191`); fourteen reaches 202. Fifteen remains the valid
steady-state bound (`24 + 15×11 = 189`) but is not deployment headroom.

The owner approved adding `.claude/reference/env-vars.md` to the intake. The
intake, plan, ADR, source guidance, authoritative env reference, and deterministic
test now pin both bounds. The staging gate requires an actual rolling overlap and
aborts above 13 aggregate warm Vercel isolates or at 192 accepted clients.

## Finding 2 — three fast requests did not prove admission was exercised

**MEDIUM · ACCEPT.** Three concurrent HTTP calls can serialize naturally and
never occupy both slots together. The staging drill now locks two token rows in
direct transactions, starts two redemptions, identifies exactly two blocked
request backends through `pg_blocking_pids` without reading query text, then
starts a third and requires it to remain pending while the blocked backend count
stays at two. Locks are released before 15 seconds and all three requests must
complete with 200, positively proving two admitted plus one queued.

## Finding 3 — operational and in-code guidance described the old topology

**MEDIUM/P2 · ACCEPT.** The env reference and read-pool source comment retained
the pre-#651 isolate budget. The production single-flight preamble and its unit
test still said redemption used the shared pool and called a dedicated pool a
future follow-up. The client-factory JSDoc described only caller-owned poller
clients. All now describe `sqlUnsubscribe`, its mandatory admission gate, the
module-owned lifecycle, and the steady-state/rollout capacity distinction.

## Finding 4 — redundant unsubscribe-close test

**LOW/P3 · ACCEPT.** A standalone happy-path close test duplicated the required
combined promised test and the existing `sqlRead` lifecycle test. It was removed;
the exact promised-title test still proves `sqlUnsubscribe.end({timeout: 5})`
runs while a shared `sql.end()` rejection propagates, and the separate rejecting
unsubscribe-close test still proves shared shutdown is not skipped.

## No other findings

The reviewers found no other spec, correctness, maintainability, database, or
async-operations defects. In particular, the client remains lazy, fixed at two,
admission-gated at two, on the same pool URL; malformed-token zero-DB behavior,
commit-before-200, same-token single-flight, sanitized retryable failures, and
best-effort shutdown match the approved intake.
