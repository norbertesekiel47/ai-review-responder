# Run D T2 root review

Reviewed the complete T2 source and test delta locally. The only behavior change is a predecessor-only `refreshLiveness` option on the existing fenced claim-release transaction. Both ownership locks precede every write; a failed outbox reconciles before heartbeat logic. Transient releases omit the option. Delay scheduling errors still reject after a second release loses its already-cleared token.

The existing topic dispatch phase now takes its DB explicitly, following the watchdog and dispatch-failure seams. Production passes its singleton; all failure and acknowledgement paths use the supplied client. The fake transport invokes the actual worker with the production-prepared payload/job ID before acknowledging delivery. Its intermediate timestamp assertion proves heartbeat execution while the row is still dispatching. This avoids global claims against unrelated local fixtures and does not claim real Redis transport.

Evidence:

- `/private/tmp/run-d-t2-red.log`: two heartbeat assertions fail before implementation; three ownership/crash/retry cases already pass.
- `/private/tmp/run-d-t2-handoff-red.log`: actual worker-before-acknowledgement case fails because its intermediate timestamp did not refresh.
- `/private/tmp/run-d-t2-green.log`: 65 tests pass across six worker/poller suites.
- `/private/tmp/run-d-t2-final-targeted.log`: 42 tests pass across the final worker integration and Console component suites, including the additional held-turn-lock and transient-no-heartbeat assertions.
- `/private/tmp/run-d-t2-static-build.log`: TypeScript, tenant scope, outbox status, DB imports and full `pnpm build` pass. Directory-map audit also passes after updating the existing owner pages.

The tests drive repeated healthy waits across the watchdog age, unchanged turn/outbox/BullMQ attempt budgets, independent predecessor-stall ageing, stale/missing/mismatched handles, turn-lock contention, a real PostgreSQL aborted transaction, crash recovery and failed delay scheduling. Constants remain 180/1200/10000; the 24-hour staging measurement has not started. Full gate and final independent review remain pending.
