# Codex adversarial plan review — round 1 (2026-07-16)

Verdict: REVISE (10 findings). Session 019f6e2a-2dd0-7a41-8225-0b7afab0a599.
Round-1 run also independently surfaced the P1 unguarded-Sentry concern and
"3 attempts" hardcoding, fixed pre-verdict as plan revision R1.

| # | Finding (condensed) | Triage | Resolution (plan R2) |
|---|---|---|---|
| 1 | P1: coupled exception INSERT → admin-outbox INSERT sequence; crash-guard's best-effort markOutboxFailed can cut off watchdog recovery and lose the admin notify | ACCEPT | Handlers wrapped in `sql.begin` (atomic terminal bookkeeping, invariant #2); `coupledTerminalTxStarted` flag (publisher pattern) makes capture skip markOutboxFailed after a coupled-tx rollback |
| 2 | P2: tests never exercise caller-provided AbortSignal composition | ACCEPT | Added caller-abort test |
| 3 | P3: `CostInfraUnavailableError('upstash down')` won't typecheck (ctor takes `CostInfraTouchpoint`) | ACCEPT | Test uses `new CostInfraUnavailableError('reserveCost')` |
| 4 | P5: unthrottled Sentry capture per emitter error = alert storm during Redis outage (ioredis reconnect loops × ~46 emitters) | ACCEPT | Per-source 60s Sentry throttle in the helper; every event still structured-logged; throttle test added |
| 5 | P6: options-only unit test can pass with dead wiring | ACCEPT (partial) | Added real-instance assertions via `app.initialConfig` + injected oversized body → 413; full listen-path still covered by staging smoke |
| 6 | P7: grouping only by source hides which provider operation fails | ACCEPT | GROUP BY (source, event_type); finding key includes both |
| 7 | P7: row-queued mocks pass without the topic filter changing; SQL-text assertion must be mandatory | ACCEPT | SQL-text assertions made mandatory for both checks |
| 8 | P10: readPendingMarker already swallows to null — its degradation is console-only and allSettled wrapper never fires | ACCEPT (minor) | Route its catch through `reportCaughtError`; keep the wrapper as belt-and-braces |
| 9 | P10: aggregate service left fatal — plan narrowed the owner-approved spec ("both paths") | ACCEPT | Aggregate's own queries degrade via shared `widgetOrFallback`; locations-list query stays fatal (business-lookup analog) |
| 10 | P10: fatal business lookup inside allSettled delays rejection up to ~30s | ACCEPT | Business query awaited separately (fail-fast) alongside the allSettled of the 12 auxiliaries |

All 10 accepted; none rejected. Round 2 re-submission pending.

# Round 2 (same session)

Verdict: REVISE (5 findings). All accepted → plan R3:

| # | Finding (condensed) | Triage | Resolution (R3) |
|---|---|---|---|
| 1 | markOutboxFailed is a CAS returning boolean; coupled writes could commit without ownership on a stale attempt | ACCEPT | CAS runs FIRST inside each handler's tx; `false` → no writes (ownership contract from outbox.ts JSDoc) |
| 2 | Sentry throttled but logs still flood during reconnect storms | ACCEPT | Per-source window: first error logged+captured, rest count-and-suppress, suppressed count surfaced next window |
| 3 | Fastify test snippet missing `import Fastify from 'fastify'` | ACCEPT | Import added |
| 4 | widgetOrFallback hardcodes businessId — mislabels aggregate telemetry | ACCEPT | Helper takes explicit `context: Record<string,string>` |
| 5 | Aggregate per-location fallback underspecified (DTO non-nullable, current code returns null) | ACCEPT | Failed slice EXCLUDED but loudly reported (`locationSlice` context); 3 aggregate regression tests specified |

Consequential fix: Task 1's original test examples rewritten — coupled-tx crashes must NOT best-effort-fail the row (watchdog recovers); best-effort mark now tested on the non-coupled generic branch.

# Round 3 (final)

Verdict: APPROVED (5 one-line notes, all applied to the plan post-approval):
capture takes IngestFailedHookState; CAS-success-then-write-failure + stale-CAS
test coverage added; throttle test asserts log suppression + suppressed-count
propagation; Task 7 file/commit lists include aggregate-service.ts + tests;
requireFulfilled removed.
