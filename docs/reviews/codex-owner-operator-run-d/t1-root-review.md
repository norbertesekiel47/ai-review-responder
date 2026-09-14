# Run D T1 root review

Reviewed the complete uncommitted T1 source and test diff after formal plan round 3. T1 is complete locally; this is not the final independent review wave or staging acceptance.

The dispatch and watchdog transactions use actual outbox CAS winners. Stored account UUID validation precedes typed tenant predicates, with textual comparison of the other payload identities. Outbox-first/nonblocking-turn locking avoids the reverse completion lock order. Live and contended nonterminal turns retain a dispatched outbox; accepted and expired current claims terminalize atomically. Terminal results and stale attempts survive. Exact failed-outbox reconciliation on yield preserves the existing transient retry behavior. The durable failure vocabulary renders an owner recovery action in the existing Console.

Evidence:

- `/private/tmp/run-d-t1-crash-red.log`: three assertion failures and four passes before the crash correction. The failures show a live/locked turn beside a failed outbox.
- `/private/tmp/run-d-t1-crash-green.log`: 49 tests pass across dispatch-phase integration, watchdog integration, poller unit wiring and actual worker integration. These include PostgreSQL rollback, live-lease deferral, expired-lease failure, lock contention and unchanged attempt counts.
- `/private/tmp/run-d-t1-yield-green.log`: 46 tests pass across the yield/UI/worker/failed-hook suites, including durable recovery wording and late-hook reason preservation.
- `/private/tmp/run-d-t1-crash-static.log`: TypeScript, tenant scope (380 unchanged entries), outbox status and DB imports pass. No checker exception added.

The initial global-poller fixture harness refused before mutation because ten unrelated billing rows were pending. The production dispatch-failure phase now accepts an explicit DB client, following the existing watchdog seam; unit tests verify transport wiring. This evidence does not claim real Redis delivery. Full build, final gate, independent implementation reviews and staging evidence remain pending.
