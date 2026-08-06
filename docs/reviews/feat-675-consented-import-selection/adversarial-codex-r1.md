# Adversarial approach review (codex) — round 1

Codex thread `019fd593-e2b7-7982-9178-863c39f4447c`, 2026-08-05. Target: branch diff vs `ccc4b9ec`.
Verdict returned: **needs-attention** — "No ship: the worker imports without consent enforcement, reconnects can reclassify live reviews into the non-drafting lane, and dirty pagination can permanently commit the wrong 100 reviews."

## Findings (verbatim) + owner-side triage

### 1. [high] Existing backfill events import reviews without accepted consent (ZernioBackfillWorker.ts:206-230)

> The focused intake explicitly defers both the worker's accepted-only preflight and all three enqueue gates to #679/#676. This handler therefore proceeds directly from subscription eligibility to fetching and importing, while existing connect, activation, reactivation, and manually inserted outbox events remain valid. Deploying this branch independently can persist up to 100 reviews for a pending, declined, or expired location—the exact silent import the design's trust boundary is intended to prevent.
> Recommendation: Do not deploy this change before or separately from an authoritative, fail-closed `import_decision = 'accepted'` worker preflight. Land the three enqueue gates in the same release, while retaining the worker check for stale or manually inserted jobs.

**TRIAGE: REJECT as a code finding; ACCEPT as a release-sequencing note.** The consent pre-flight is a locked intake non-goal (owned by #679; enqueue gates by #676) per the #667 map decomposition — re-litigating it is a map-level question, not a branch defect. The behavior this branch replaces is strictly more dangerous: the old backfill AUTO-DRAFTED replies for the same unconsented locations; the new one stores list rows only and writes no `job_outbox` row, so nothing can reach Google (invariant #3). Production has zero customers (ADR 0015 R1) and the branch rides staging first. Sequencing note recorded in the PR description: **#679 (fail-closed accepted-only worker pre-flight) must land before real customers**.

### 2. [high] Reconnects move the cutoff and revive the lost-draft hazard (ZernioBackfillWorker.ts:217-234)

> The import derives ownership from the current active connection's mutable `connected_at`. The connect finalizer resets that timestamp to `NOW()` on reconnect. If an initial run remains incomplete and is retried after reconnect, reviews created after the original connection but before the new cutoff are reclassified from live-owned into import-owned; this worker stores those unanswered reviews through `importReview`, which intentionally creates no draft. Thus the claimed disjoint ownership is not stable across reconnects and new reviews can silently lose automatic handling.
> Recommendation: Base lane ownership on an immutable first-connect/import cutoff persisted with the location or run, rather than the latest connection row. Add a retry-after-reconnect test proving reviews owned by the original live lane still receive generation.

**TRIAGE: REJECT.** The invariant is disjointness at every instant, not temporal stability of the boundary. Both lanes read the SAME `liveIngestCutoff(connected_at)` of the current active connection, so no review is ever dual-owned at any moment — which is what makes a lost draft structurally impossible. A row the live lane already stored/drafted cannot be harmed by a later import: `importReview` is insert-only and returns `'unchanged'` for existing rows (glossary, Review import). Reviews arriving during a disconnect gap were never owed a draft by the post-reconnect live lane (webhook ingest no-ops on inactive connections — deliberate, tested behavior); after reconnect they land as undrafted inventory, which is exactly the D2 product change (#678 adds per-row Generate). "New reviews keep getting automatic drafts" (intake `user_visible_behavior`) is scoped to reviews at or after connect of the live connection — that holds under reconnect.

### 3. [high] Dirty cap exhaustion can finalize an unknowable top 100 (ZernioBackfillWorker.ts:299-318)

> When pagination reaches its cap with another page available, the worker fails only if fewer than 100 candidates were collected. After any observed ordering inversion, however, unseen pages may contain newer reviews; having 100 candidates does not prove they are the global newest 100. The worker nevertheless imports them and later sets `completed_at`, making the omitted newer reviews unrecoverable through normal retry. A warning is not sufficient protection against this silent, permanent truncation.
> Recommendation: If ordering became dirty, treat any cap exhaustion with `nextPageToken` present as terminal and retryable regardless of candidate count. Complete the run only after reaching feed end, or after an ordering guarantee makes the top-100 boundary provable.

**TRIAGE: REJECT (locked decision; both positions recorded for owner read at merge approval).** The exact carve-out is a locked intake edge case — "a dirty cap-out with ≥100 candidates proceeds best-effort" — decided in plan-review r1 (deviations D2). Rationale: Zernio ordering inversion has never been observed (the check is a tripwire for an undocumented contract change); the ordering warning is the ops signal; failing terminally would brick the one-shot import on a hypothetical provider quirk, trading total unavailability for exactness of an inventory selection whose worst case is "some of the 100 imported are not the globally newest" — list rows only, nothing drafted, nothing posted. Codex's position (terminal-fail all dirty cap-outs) is preserved here verbatim; if the owner prefers it at merge review, it is a small, isolated change to the cap-exhaustion condition.

## Next steps (codex, verbatim)

- Land the consent preflight and enqueue gates before deployment. → sequencing note, PR description (#679/#676).
- Persist a stable lane-ownership cutoff and test reconnect/retry behavior. → rejected (see 2).
- Fail dirty-order cap exhaustion instead of completing best-effort. → rejected, owner-visible at merge (see 3).
