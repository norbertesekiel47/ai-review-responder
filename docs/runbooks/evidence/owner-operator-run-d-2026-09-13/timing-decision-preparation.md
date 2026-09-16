# Timing decision: final observation with owner-approved early close

Status: final observation and constants decision recorded. Candidate: `4b13d96621b156a47dbc4140995f45745bc8114d`. Run D's browser recovery check and scoped teardown are complete. Final verification, independent review, adversarial verification and shipping remain required.

**Retain all three deployed constants:** the 180-second claim lease, 1,200-second predecessor stall limit and 10,000-millisecond predecessor recheck delay in `worker/jobs/agent-turn/constants.ts`.

## Observation closed by the owner

The owner instructed: “Hm actually everything looks good so far, you can stop the observability and proceed, go ahead”. The [retained decision](observation-owner-early-close.json) ends the scheduled observation and cancels slots 20–24. It supersedes the original September 14 21:46:17Z earliest finish. **`full_24_hours_elapsed=false` remains explicit; this is not a 24-hour PASS.**

The [final database capture](measurement-final.json) covers `2026-09-13T21:46:17Z` through `2026-09-14T17:36:31.857381Z`: **19 hours, 50 minutes, 14.857381 seconds**. All 24 UI submissions matched one durable turn and all 24 completed. All 19 fully elapsed hourly bins contain an accepted turn. There were zero failed or nonterminal turns, unmatched or ambiguous submissions, missing or multiple outbox rows, tenant or outbox identity mismatches, or observed outbox redispatch claims. The separate [binding audit](binding-audit-final.json) returned no anomaly rows.

| Completed-turn measure | Result |
|---|---:|
| Denominator | 24 completed / 24 submitted |
| p50 accepted-to-completed latency | 6.838317 seconds |
| p95 accepted-to-completed latency | 16.10373645 seconds |
| Minimum / maximum | 4.294278 / 17.778091 seconds |

Percentiles use PostgreSQL `percentile_cont` over unrounded accepted-to-completed seconds. The [cost audit](cost-audit-final.json) separately records 24 valid audit-row latencies (p50 1,936.5 ms, p95 2,306.4 ms). Those rows have no durable turn link: their distribution is unassigned account/location evidence, not per-turn or per-provider-call attribution. Neither latest claim time nor the outbox's latest dispatch/heartbeat timestamp identifies every intermediate wait. The unsolicited no-op Proposal in slot 00 was never applied and remains a quality limitation in the observation record.

The [health record](observation-health-final.json) contains 238 successful readiness samples across two retained recorder segments, ending at `2026-09-14T17:31:48.015205Z`; the largest sample gap is 300.010209 seconds. These are periodic checks, not a continuous availability proof or a health sample at the later database cutoff. The [final deployment readback and history](observation-deployments-final.json) identify the same candidate on the staging Vercel alias and Railway worker, with no new staging deployment recorded during the observation.

## Lease reasoning

`src/lib/llm/client-options.ts` sets each provider request to a 30-second timeout and disables SDK retries. `src/lib/llm/run-task.ts` can call the primary and then the fallback once per seam execution. `src/lib/agents/operator/model-call.ts` permits two validation attempts, and each may call that seam. Consequently the configured provider timeout allowance for a validation retry path can reach four calls times 30 seconds, or 120 seconds, before accounting for surrounding work. This is a configured provider allowance, not a measured latency or a hard deadline on every database/cost-guard operation.

The constants file's detailed lease comment acknowledges two providers times two validation attempts. Its historical five-turn summary uses a two-provider 60-second floor; that expression does not bound the full validation retry path. The observed p95 times 1.5 is about 24.16 seconds, well below the 120-second configured provider allowance. Retain the 180-second lease for headroom above that allowance; surrounding database and cost-guard work is not globally bounded, and this small sample does not justify reducing the margin.

## Predecessor reasoning

`worker/background/pollers/OutboxPoller.ts` defaults the watchdog stale window to 900,000 milliseconds. Retain the 1,200-second predecessor limit above that recovery window. A small successful sample does not establish safe behavior for an arbitrarily changed recovery window.

The [named runtime readback](timing-runtime-readback.json) at `2026-09-14T07:14:19.652Z` confirms the watchdog override is absent on the pinned staging service, so that service uses the 900,000-millisecond source default at the time of inspection. The dispatch timeout override is also absent. No environment values were changed.

Retain the 10-second recheck delay. It delays the same BullMQ job without spending a failed attempt. Both the [slot-08 worker logs](observation-pair-08-worker-logs.json) and [slot-16 worker logs](observation-pair-16-worker-logs.json) record actual predecessor waits. The corresponding [slot-08 job records](observation-pair-08-jobs.json) and [slot-16 job records](observation-pair-16-jobs.json) show each successor completed with two starts and `attemptsMade=1`. The first slot-08 A/B pair did not overlap; its retained record is not used as proof of a wait. The replacement C/D pair and slot-16 pair supply that evidence. Lowering the delay would add wakeups without a demonstrated need in this sample.

## Acceptance and remaining work

Acceptance item §12.1.10 is satisfied under the owner's explicit duration amendment: latency and outcome evidence are final for the actual interval above. The original full-day requirement and interim evidence remain historical records. No constants, flags or production settings changed for this decision. Browser recovery and scoped fixture cleanup are complete; see the [recovery result](recovery-check-result.json) and [Run D evidence](../2026-09-13-owner-operator-run-d-evidence.md). The final gate, independent review, adversarial verification and D's feature/documentation merges remain required. Run E stays paused until D closes out.

This documentation update performed no provider calls, tests or runtime writes. The linked runtime readback inspected only the three named nonsecret timing keys.
