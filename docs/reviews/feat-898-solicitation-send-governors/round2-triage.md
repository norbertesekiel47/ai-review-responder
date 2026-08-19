# Round 2 triage — verification-only

Two verification agents (spec+standards merged; adversarial). Round-1 fixes verified, plus
findings the fixes themselves introduced. All resolved on-branch.

## Round-1 fixes — verification verdicts

| Finding | Verdict |
|---|---|
| adv-1 / B2.1 recovery unreachable | FIXED, but INCOMPLETE — see R2-A1 below |
| adv-2 / B2.3 trip cancels in-flight batches | VERIFIED FIXED (runbook §8.5 + B14) |
| adv-3 / B1.1 edge-triggered paging | VERIFIED FIXED (dropped-event hole closed) |
| adv-4 / B1.2 seq scan | **PARTIALLY FIXED** — `WHERE` correct, but `EXPLAIN` on PG 16.14 still shows Seq Scan; 110's `sent_at` index genuinely cannot serve an OR-of-three. Follow-up B3.8. |
| adv-5 / B1.3 write in a "No writes" module | VERIFIED FIXED |
| adv-6 / B2.2 decision 2 unachievable | VERIFIED FIXED (amendment B14) |
| adv-10 / B2.4 LEAST vs §4.3 | VERIFIED FIXED (docs) |
| spec-1..8, std-3, std-9 | VERIFIED FIXED |
| spec-3 / B1.4 fail-closed bounce | VERIFIED FIXED — **both halves**, each test names the other |
| std-1 HealthFinding inversion | DEFERRED AS AGREED (follow-up, #900) |
| std-5 formatRate duplication | OPEN AS AGREED — dedup broke the build, reverted, reason documented in-place |

## Findings the fixes introduced — all fixed

| # | Sev | Finding | Resolution |
|---|---|---|---|
| R2-A1 | **high** | The reset bounded the DENOMINATOR only. A pre-reset send whose signal landed post-reset counted in the numerator against a fresh denominator — one trailing complaint = 1.00% vs 0.30% → re-trip after a legitimate recovery. The deviations file asserted the opposite twice; the accompanying test seeded `bouncedDaysAgo: 1` and could not catch it. | TWO floors: `signal_floor` (rolling 7d, dates the numerators, preserves locked decision 5) and `reset_floor` (bounds rows by `sent_at` on both sides). Six independent verifications + a regression test proven to fail against the old statement while 11 siblings stay green. |
| R2-1 | high | Reset semantics stale in 6-8 sites incl. shipped panel copy and `edge_cases[4]` | Rewritten; the panel now tells an operator the reset is a real recovery, that it zeroes the measurement, and to roll the cap down first |
| R2-2 | med | "pages once per trip" false in a LOCKED glossary term + runbook | Rewritten to level-triggered, with the reason |
| R2-3 | med | Promised admin-reset log line absent, no paper trail | Added in the route (actor + trip id + note PRESENCE only) |
| R2-4 | med | `formatRate` comment described the reverted state | Rewritten to the truth |
| R2-5 | med | Plan taught four superseded shapes | `⚠ CORRECTED` banner AND snippets fixed in place |
| R2-6/7 | low | Hardcoded "7 days"; test title overstated its test | Threshold used; rejection now lands on the INSERT |
| — | — | Orchestrator's hand-applied comment contained backticks INSIDE a tagged template literal — the file did not parse | Caught by the verification agent; removed, guard comment added |

## Follow-up tickets (not this branch)

B3.1 `HealthFinding` seam · B3.2 gate order unowned/untested · B3.3 cap concurrency vs
detected-not-enforced single replica · B3.4 `queued_at` burns cap slots for withheld children ·
B3.5 six non-send causes converge on `send_window_elapsed` · B3.6 no live Breaker-window read ·
B3.7 one-sided coincidence guard · **B3.8 breaker read model still seq-scans** ·
**B3.9 re-page rides a first-seen Sentry rule, so a multi-day halt notifies twice then goes quiet**
· **B3.10 `formatRate` duplication + the module-scope worker logger that blocks the obvious fix**

## Rejected

110's two new withhold members "have no writer" — that is the ticket's stated purpose (it holds
the migration slot so #899/#900 ship without one). Owner-decided.
