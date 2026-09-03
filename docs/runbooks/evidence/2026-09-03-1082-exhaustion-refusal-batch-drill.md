# #1082 — staging drill evidence

**Date:** 2026-09-03 · **Branch:** `perf/1082-exhaustion-refusal-batch` at
`ffa4b9c6` · **Environment:** staging (Railway worker + staging Supabase)

## Why this drill exists

The review wave's Codex axis raised a high finding: a normal staging ride
cannot reach `settleGenerationExhaustion`, so it would prove only that the
worker boots. Two things turned out to be true and one false.

**FALSE:** the finding assumed `SOLICITATION_SEND_ENABLED` was off everywhere.
It has been **`true` on staging since #633 (2026-08-24)** — `env-vars.md` says
so and the live worker confirms it. The changed path was reachable all along.

**TRUE:** a plain ride still proves nothing about the changed transaction, and
`SOLICITATION_PLATFORM_DAILY_CAP` was `50`, so the release lane could send real
email from staging. Both needed handling.

## Procedure

| # | Step | Result |
|---|---|---|
| 1 | Set `SOLICITATION_PLATFORM_DAILY_CAP=0` on the staging worker | 20:32:44Z — the documented emergency brake; `0` means no sends |
| 2 | Fast-forward `staging` to `ffa4b9c6` | `862a039d..ffa4b9c6`, no force needed |
| 3 | Worker redeploy | deploy `a008a91e`, **SUCCESS** at 20:35:50Z — boot proof |
| 4 | Schema parity, staging vs local test DB | **64/64 columns identical** across `refusal_events`, `solicitation_outreach`, `solicitation_asks` |
| 5 | Rehearse the drill locally | Passed after four fixture corrections — the reason it was rehearsed |
| 6 | Run the drill against staging | Below |
| 7 | Verify staging clean | 0 drill rows in every seeded table |
| 8 | Restore `SOLICITATION_PLATFORM_DAILY_CAP=50` | 20:50:24Z |

The drill script is `.feature/drill-1082.ts` (gitignored scratch). It seeds a
marked tenant, runs the real `settleGenerationExhaustion`, reads back, and
deletes everything it created. It sends nothing: the fills are
`withheld/render_failed`, which the release lane never picks up.

## Correctness — the question the tests already answered, re-asked on staging

```
holes: 25   fills: 25   refusals: 25
id_sets_equal: true
refusal_sources:    ["outreach_withheld"]
refusal_codes:      ["render_failed"]
refusal_categories: ["below_our_bar"]
subject_types:      ["solicitation_outreach"]
business_id_present: true
settled: { status: "settled", filled: 25, parentStatus: "failed",
           counts: { withheld: 25, withheldByReason: { render_failed: 25 } } }
```

The **id SETS** are equal, not merely the counts. Equal counts with wrong
subjects is the failure this change could have produced, and a count comparison
cannot see it.

## Throughput — the finding nobody had measured

Codex's second finding was that the branch never measured its own claim. Both
arms write the same 25 rows into `refusal_events` on the staging database and
both roll back. Median of three passes:

| Arm | Staging | Local Docker |
|---|---|---|
| 25 single-row `INSERT`s | **1754 ms** | 10 ms |
| 1 set `INSERT` (`jsonb_to_recordset`) | **141 ms** | 1 ms |
| **Saved** | **1613 ms** | 9 ms |

**The change removes ~1.6 seconds of lock-held time per settlement**, on a
transaction holding the per-Business advisory lock and the batch row lock.

**This corrects the branch's own framing.** The review concluded the saving was
"at most 24 round trips" and treated that as small. It is small in COUNT and
large in TIME: each round trip costs about 70 ms against Supabase through
PgBouncer, against roughly 0.4 ms on a local Docker Postgres. The local numbers
in the integration suite understate the production saving by two orders of
magnitude. **The bound correction (25, not 5,000) stands and was right; the
inference that 25 therefore made the ticket marginal was wrong.**

Full settlement wall time on staging was 3185 ms, of which the ledger write is
now 141 ms. The remainder is the 25 `insertOutreachRender` calls the ticket
deliberately left per-row — which is the filed follow-up, and this measurement
is the argument for it.

A concurrent same-Business writer observed a 271 ms lock wait. That probe
starts on a 15 ms timer, so it lands inside the window but not at its start;
treat it as a lower bound on contention, not as the window itself.

## What this drill does NOT prove

- It does not exercise the BullMQ dead-letter path that calls
  `settleGenerationExhaustion` in production. It calls the function directly
  against the staging database. The worker boot (step 3) is the only evidence
  that the deployed code is this code.
- It does not measure a batch at any size other than 25, which is the
  `BATCH_CAP` ceiling and therefore the worst case.
- The 1.6 s saving is a staging measurement. Production sits on a different
  Supabase project; the shape will hold, the constant may not.

## Incident recorded during this work

The staging `SOLICITATION_RESEND_API_KEY` was printed into a session transcript
by an over-broad `grep` over the worker's variables. It is the domain-scoped
Sending-identity key for `feedback.staging.repworth.net`, so the exposure is
limited to staging solicitation email — invariant #5 keeps approval email on a
separate key. **Rotation is outstanding and owner-scheduled.** The lesson is
narrower than "be careful": never pattern-match a whole variable prefix when
only two flags are wanted.
