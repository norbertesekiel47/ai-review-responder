# Codex Adversarial Review

Target: branch diff against c5e94e6ca7e3c4187854a67129b1651a8f80566e
Verdict: needs-attention

Do not ship: the design has conflicting ownership clocks, unstable proposal references, and an unsafe Run B freshness token. The hard-delete purge ordering itself appears coherent. VERDICT: REVISE

Findings:
- [high] Outbox ownership and turn ownership can disagree permanently (src/lib/agents/operator/turns.ts:368-415)
  Completion mutates the turn and inserts its dependent rows before calling `markOutboxCompletedIfOwned`, then ignores a false result. A superseded BullMQ delivery can therefore acquire a fresh turn token and commit despite no longer owning the outbox attempt. Conversely, five Redis dispatch failures terminalize the outbox without ever invoking this worker, leaving the turn `accepted` indefinitely. Later turns then wait or fail behind a predecessor that has no recovery owner.
  Recommendation: Make both fences one contract: lock/CAS the exact outbox attempt first, abort all domain writes when it fails, and atomically fail nonterminal turns when dispatch/watchdog exhaustion terminalizes an `agent_turn` outbox row.
- [high] Proposal references can resolve to the wrong operation (src/lib/agents/operator/proposals.ts:124-147)
  Stored replies retain `proposal_ref.index`, but reads reconstruct that index using `ORDER BY created_at` alone. All proposals inserted during one completion share PostgreSQL transaction-time `NOW()`, so their order is undefined. A two-proposal reply can consequently bind a segment to the wrong proposal ID; Run B could present an Apply action for a different setting than the surrounding response describes.
  Recommendation: At fenced completion, replace each positional reference with its generated proposal ID, as status references are materialized. Alternatively persist a per-turn ordinal with a uniqueness constraint and order by it.
- [high] The Run B freshness token discards database precision (src/lib/responses/voice-settings.ts:39-76)
  `readVoiceConfig` converts `businesses.updated_at` through JavaScript `Date` and `toISOString()`, truncating PostgreSQL microseconds to milliseconds. Two settings writes within the same millisecond can therefore produce equal prepared/current tokens. Run B's stale check would pass after an intervening change and could overwrite newer owner configuration.
  Recommendation: Use a monotonic revision column for voice settings, or select and return `updated_at::text` without any JavaScript Date round trip; store and compare that exact value end to end.
- [medium] Intentional predecessor waits are misclassified as crashed work (worker/jobs/agent-turn/AgentTurnWorker.ts:126-140)
  The worker moves the BullMQ job to delayed but leaves its outbox row `dispatched`. A valid predecessor wait may last 1,200 seconds, while the outbox watchdog reclaims dispatched rows after 900 seconds by default and permits configuration as low as 60 seconds. A slow predecessor therefore creates duplicate deliveries under normal defaults; at the minimum watchdog setting the outbox can exhaust all five attempts before the intended predecessor-stall cutoff.
  Recommendation: Represent predecessor waiting durably in PostgreSQL—such as a pending outbox row with future `available_at`—or introduce an explicit waiting state excluded from stale-dispatch recovery. Sequence-aware outbox dispatch would also remove this competing clock.
- [medium] The branch bypasses ADR 0005's semaphore trigger (worker/config/startup-assert.ts:142-167)
  The guard now explicitly permits an all-flags-on envelope of 12 while the same code states that exceeding roughly 10 requires the global Redis semaphore. Single-replica deployment only makes the count accurate; it does not make 12 safe. With Judge, solicitation generation, and Operator enabled together, twelve provider calls can run concurrently, and the Operator lane explicitly declines the per-business concurrency guard. Provider throttling can produce retry storms and block Judge-dependent publishing.
  Recommendation: Build the global semaphore before permitting 12 slots, keep the enforced envelope at 10 or below, or enforce and document mutual exclusion among flag-gated lanes.

Next steps:
- Unify outbox and turn terminalization before enabling the route.
- Replace positional proposal references and the millisecond timestamp token before Run B builds on them.
- Resolve the predecessor/watchdog clock conflict and re-open ADR 0005's concurrency decision.

[exited with code 0]
