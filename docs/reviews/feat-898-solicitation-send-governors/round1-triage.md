# Round 1 triage — feat-898-solicitation-send-governors

3 axes, 23 findings. Verified-correct by the spec axis: asymmetric window implemented as
specified, `ON CONFLICT` inference works, migration 110's untouched CHECK arms are
byte-identical to 109's, 37/37 promised tests present, no edit-surface drift, nothing sends.

## Bucket 1 — FIX ON THIS BRANCH (mechanical; no locked decision touched)

| # | Source | Finding | Verdict |
|---|---|---|---|
| B1.1 | adv-3 / std-2 | Paging is EDGE-triggered: one dropped Sentry event = silent permanent platform-wide halt | ACCEPT |
| B1.2 | adv-4 | `readBreakerWindow` has no `WHERE`; seq-scans all of `solicitation_outreach` every 5 min, and 110's index rationale is wrong | ACCEPT |
| B1.3 | adv-5 / spec-1 | The trip is the only WRITE in a module contracted "No writes", un-isolated in a shared-fate chain | ACCEPT |
| B1.4 | spec-3 | Unrecognised `bounce.type` -> `soft` -> excluded from the numerator: fail-OPEN on a fail-closed governor | ACCEPT |
| B1.5 | spec-2 | No test asserts `resetSendBreaker` receives `gate.admin.id` (only the rejection half) | ACCEPT |
| B1.6 | spec-4 | UTC fixture uses the SHORT form, so it cannot catch removal of the trailing conversion | ACCEPT |
| B1.7 | spec-5 | Both `observability` log lines the intake promises are absent | ACCEPT |
| B1.8 | spec-6 | Rollback plan omits `idx_solicitation_outreach_sent_at` + two named constraints | ACCEPT |
| B1.9 | spec-8 | Plan + intake still carry the SHORT UTC form -> a resumed session re-introduces the bug | ACCEPT |
| B1.10 | std-3 | `page.tsx` has no try/catch where the sibling GET route does | ACCEPT |
| B1.11 | std-5 | `formatRate` duplicated byte-for-byte | ACCEPT |
| B1.12 | std-9 | `CONTEXT.md` has no **Dispatch gate** entry though two files bold it as a LOCKED term | ACCEPT |

## Bucket 2 — OWNER DECISION (design; touches locked decisions)

| # | Source | Finding | Why it is not mine to settle |
|---|---|---|---|
| B2.1 | adv-1 | **Breaker recovery is arithmetically unreachable by the documented procedure.** Halting stops sends, so the denominator drains faster than the numerator and the ratio worsens. Recovery actually requires waiting ~7 days for the window to fall under `BREAKER_MIN_SENDS`. Runbook §8.3's "roll the ceiling down, then reset" re-trips within one poll interval, every time. **This one is #898's own, not #900's.** | The fix is a design change (reset epoch / post-reset-only counting) or an honest runbook rewrite. Changes locked decision 5's consequences. |
| B2.2 | adv-6 | Locked decision 2 ("the row stays `rendered`") is unachievable: #900 CASes `rendered -> queued` BEFORE #899's Dispatch gate runs, so a subscription deferral strands a `queued` row the release predicate can never see again | Directly invalidates a decision locked in grilling |
| B2.3 | adv-2 | One trip likely cancels every in-flight approved batch platform-wide (72h send window vs a multi-day halt), or blows the 10-day bound into the stalled alert | Consequence of locked decision 3; undocumented in spec, plan and runbook |
| B2.4 | adv-10 | `LEAST(configured, 10)` deletes spec §4.3's stated escape valve while 091's 1..50 CHECK still advertises 11-50 as live | Amendment B3 locked the LEAST resolver; the spec text now contradicts it |

## Bucket 3 — FOLLOW-UP TICKETS (not this branch)

| # | Source | Finding |
|---|---|---|
| B3.1 | std-1 | `HealthFinding` import direction inverted; `checkSolicitationSendBreaker` is a pass-through -> seam one layer too deep. Standards verdict: follow-up for #900 |
| B3.2 | adv-11 | The locked gate ORDER has no code owner and no test — three loose functions, composition deferred to #900's prose |
| B3.3 | adv-12 | Cap concurrency rests on the single-replica invariant, which CLAUDE.md says is DETECTED, not enforced |
| B3.4 | adv-8 | Counting `queued_at` lets Dispatch-gate-withheld children burn cap slots without spending reputation |
| B3.5 | adv-7 | Six distinct non-send causes all converge on `send_window_elapsed`; a billing lapse is misreported to the owner |
| B3.6 | adv-9 / spec-7 | No live Breaker-window read anywhere, so the intake's own failure-detection story is unobservable |
| B3.7 | std-6 | The deliberate-coincidence guard is one-sided (`policy.ts` is outside surface; budget exhausted) |

## Rejected

| Source | Finding | Reason |
|---|---|---|
| std-8 | 110's two new withhold members have no writer -> "speculative generality" | REJECT. That is the ticket's explicit purpose: it holds the migration slot so #899/#900 ship without one. Owner-decided, recorded on the issue. |
