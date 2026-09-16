# Run D — independent spec/correctness review

Verdict: **APPROVED**. No actionable findings at or above 80% confidence.

Reviewed HEAD: `8b1c612b08d2b93208b4fbb7102f7d917ea9b9c2`.
Fork/merge base: `a95478037fb662cae6ce2e4cc1eb89671016b492`.
Reported full review gate: GREEN, fingerprint `7cc2dca733f1417ff888833d86ad14289a32e6484e9973d2f08f497a5cad65bb`.

The review used the supplied Run D brief/intake and committed source through `git show` and the pinned commit diff. Every line of the committed `docs/reviews/finding-checklists/spec-correctness.md` was checked for applicable defect classes. The final test-only addendum is included. No tests, provider calls, deployments, tracked-file edits, commits, or external mutations were performed by this reviewer. The gate result is supplied evidence, not a new gate execution.

## Contract assessment

- **CA1 ownership and atomicity:** `runOutboxDispatchFailure` obtains actual terminal CAS winners using stored ID and attempt, and reconciles only returned Operator rows inside the same transaction. `reconcileTurnForFailedOutbox` verifies topic, aggregate type, aggregate/payload turn ID, validated account UUID and conversation binding. An accepted turn, or a locked running turn with an expired lease, receives the durable `dispatch_exhausted` terminal transition with the same transaction timestamp. Malformed/foreign identities and existing terminal results cannot authorize a different turn failure.
- **Ambiguous dispatch and contention:** A matching live or contended nonterminal turn restores its outbox to `dispatched`, clears completion time and refreshes its recovery timestamp. The nonlocking identity read distinguishes a skipped lock from an absent turn. The watchdog revalidates expiry under the turn lock before terminalization, and excludes deferred rows from its failed count. The turn lock is nonblocking when the poller holds the outbox, avoiding the inverse-order wait against fenced completion.
- **CA4 fences and retry behavior:** `releaseTurnClaim` owns a transaction and requires both the exact stored outbox attempt/identity and current running turn token. It supports the legitimate `dispatching` handoff. Healthy predecessor waits alone refresh liveness; transient errors release without that refresh. A failed owned outbox is reconciled while yielding. The predecessor caller delays the same job only on `released`; the transient caller rethrows after both `released` and `lost`. Thus a Redis delay rejection after an already committed claim release remains a BullMQ error. The independent predecessor-age deadline remains unchanged.
- **User behavior and non-goals:** The closed failure vocabulary and durable transcript wording include `dispatch_exhausted`, with the existing new-conversation recovery action. No setting writer, Apply authorization, stored location target, model/cost seam, production flag, queue, migration, dependency, or generic watchdog window is changed. The source changes stay within the intake surface.

## Tests and evidence assessment

The committed tests exercise the production dispatch-failure/watchdog phases and public turn handler against isolated real PostgreSQL fixtures. They assert coupled timestamps and rollback, stale attempt rejection, account/aggregate/conversation mismatch exclusion, live and terminal preservation, post-crash expiry, contended completion, repeated healthy waits, missing or superseded handles, stolen tokens, delay rejection, and worker execution before dispatch acknowledgement. The intermediate dispatching timestamp assertion prevents acknowledgement from masking a missing heartbeat. The final sibling-proposal correction identifies each stored proposal by its distinct input tone and then checks the reply's exact IDs in model order, avoiding tied transaction timestamps as an ordering oracle.

The staging candidate `4b13d96621b156a47dbc4140995f45745bc8114d` has the same production `src`/`worker` code as reviewed HEAD; their only difference under those roots is the final integration-test correction. The committed T3 record binds an actual tone Apply before a new fictional review and worker-generated draft, with stable voice inputs and linked response/cost/run evidence. Prompt reconstruction is explicitly distinguished from a captured provider request. T4 records selector movement before worker claim and preserves the Cafe target. Browser recovery is explicitly a controlled production-domain fixture with zero model/transport calls; it is not presented as a real dispatch outage or alert-delivery drill. The blank mobile navigation capture is explicitly excluded from visual proof, with separate URL/composer observations retained.

The owner decision in `observation-owner-early-close.json` expressly ends observation early. The retained final snapshot covers **71,414.857381 seconds (19h50m14.857381s)** and includes **24 actual submissions and 24 completed turns**. Independently recomputing continuous percentiles from the retained completed-turn values gives **p50 6.838317s** and **p95 16.10373645s**, matching the report. `full_24_hours_elapsed=false` is explicit. The 238 health samples are described as periodic evidence, and unavailable per-turn model/initial queue timings are disclosed rather than inferred from mutable timestamps or unassigned costs. The unchanged 180-second lease, 1,200-second predecessor deadline and 10,000-ms wait retain their documented safety margins.

The cleanup record contains 15 captured-table readbacks and 54 ownership-scope readbacks with zero remaining counts, plus zero Auth/recovery residuals. The campaign verdict keeps final gate/review/shipping separate from staging acceptance. Review of browser and cleanup claims here is documentary; this reviewer did not re-exercise staging or independently inspect rendered screenshot pixels.

## Actionable findings

None.

## Uncertain advice

None promoted. The existing generic stale-dispatching recovery policy is explicitly preserved by the approved plan; this approval assesses Run D's named transitions and does not expand the campaign into a general Redis outage or alert-delivery certification.
