# ADR 0017 — Persist-boundary content-freshness gate for response generation

## Status

Accepted — 2026-08-09 (issue #724, decision ticket of map #710 item 2).
**Reverses** the deferral #678 recorded in its deviations D2. Implementation:
#728. Related: ADR-forbidden territory D-H (no second auto-approval guard) is
untouched by this decision.

## Context

Every `generate_response` worker reads the review text and
`review_content_hash` without locking
(`worker/jobs/response-generation/load-context.ts:101`), then spends
seconds-to-minutes in the LLM call. In that window a live-ingest content
change can take the review lock, update text + hash, and — because the
in-flight draft is not yet committed — enqueue its own replacement job at
`MAX(version)+1`, which equals the in-flight job's version
(`src/lib/reviews/process-review.ts:358`). Whichever worker persists first
wins; the loser no-ops on the `(review_id, version)` idempotency check
(`load-context.ts:158`). The surviving `pending_approval` draft can therefore
be a reply to review text the customer has since changed.

#678 deferred fixing this on the recorded premise that the partial unique
indexes bound the damage to *"a wasted LLM call, not corruption."* **That
premise is false.** Migration 029's partial index plus the
`(review_id, version)` unique constraint prove only that *one* row survives —
never that it matches current review content. The deferral was made on bad
information, which is the documented bar for an ADR-recorded reversal.

Three facts sharpen the blast radius:

- The Generate door (`on_demand_generate`) has **no feature-flag gate**;
  nothing holds the race back once there is traffic. Production is empty
  today, so this is pre-GA correctness work, not an incident.
- `regenerate` is also a non-auto lane and skips the same re-read — #678
  widened exposure but did not create the class.
- The hazard is **not even confined to non-auto lanes**: in the
  `live_ingest_new` auto lane a hash mismatch is only an auto-approval block
  reason (`worker/jobs/response-generation/auto-approval.ts:327`) — the stale
  draft still persists as `pending_approval` and notifies the owner, and the
  colliding fresh job then no-ops as `already_exists`. The existing hash gate
  protects invariant #3 (no auto-*posting* stale content), not the
  owner-facing draft.

## Decision

**Fix now (pre-GA), as a lane-independent content-freshness gate at the
persist boundary — skipping the INSERT on mismatch.** Concretely, in
`persistResponseAndNotify` (`worker/jobs/response-generation/persist.ts`):

1. Under the review `FOR UPDATE` lock the transaction already takes as its
   FIRST statement (`persist.ts:281` — the lock whose comment already notes it
   serializes the auto-lane hash re-read against content-changed ingest),
   re-read the current `review_content_hash`.
2. If `loadedReviewContentHash` and the current hash are **both non-null and
   differ**, do **not** insert the response row. The job completes with a
   queryable skip-reason token (one owner, following the
   `SKIP_REASON_ARCHIVED_LOCATION` precedent in
   `src/lib/shared/worker-types.ts`) and a structured log line — that line is
   #728's observability signal.
3. A `null` hash on **either side passes the gate.** It is a freshness check,
   not a provenance proof: legacy pre-hash reviews cannot be verified, and
   blocking them would brick their generation entirely. The auto lane's
   stricter null-blocks in `evaluateAutoApprovalCandidate` are unchanged.
4. The gate runs unconditionally, **before the lane split** — it covers
   `on_demand_generate`, `regenerate`, `backfill`, and both live-ingest
   lanes. `evaluateAutoApprovalCandidate` stays byte-identical (D-H: the
   auto-approval chain is neither duplicated nor touched; its hash gate
   remains as defense in depth and still owns the null-hash-blocking
   semantics for auto-posting).

### Why skip-the-INSERT is load-bearing, not a style choice

The colliding fresh job shares the in-flight job's version number. Persisting
the stale draft in any status — `failed`, `superseded`, anything — occupies
`(review_id, version)`, and the fresh job's idempotency check matches on
`(review_id, version)` **regardless of status**, so it would short-circuit and
no current-content draft would ever be generated. Skipping the INSERT leaves
the version slot free. Traced orderings all converge on a fresh draft:

- Stale worker reaches persist after the content change → gate fires, skips;
  fresh job persists the current-content draft at that version.
- Fresh worker persists first → stale worker's gate still fires (its loaded
  hash no longer matches) and skips cleanly instead of hitting the unique
  violation.
- Stale worker persists **before** the content change commits → no mismatch
  existed at persist time; live-ingest's existing committed-draft repair then
  fails the row with `review_content_changed` and enqueues version+1
  (`process-review.ts:377`).

`enqueueGenerateResponse` performs no helper-level dedup (deliberate — see the
comment above `enqueuePublishResponse` in
`src/lib/shared/job-outbox-helpers.ts`), so the replacement job always exists
as its own outbox row; the skip can never strand a review with no draft on
the colliding-job paths.

### Accepted costs

- The generation's `api_costs` rows keep no `response_id` linkage on a
  skipped persist. The spend already happened and is finalized; this is
  inherent to losing the race, not to the fix shape.
- One residual lane can skip with **no** replacement job: the legacy
  past-replies edit draft (`REGENERATE` over a *posted* sibling, behind
  `EDIT_REPLIES_ENABLED`, off in production). Live-ingest takes the
  `review_edited_after_post` exception path for posted rows and enqueues
  nothing — so the owner's edit draft quietly evaporates. The exception row +
  admin notification already exist for exactly that situation, and an edit
  draft written against superseded review text is precisely what the gate
  exists to refuse. Accepted; revisit only if the legacy lane's flag flips
  with real traffic (#726/#727 territory).
- The auto lane's `review_content_hash_mismatch` block reason becomes mostly
  unreachable (the gate fires first); it remains reachable for null-hash
  cases and stays as structural defense in depth.

## Alternatives considered

- **(b) Bind generation identity to content at enqueue time** (hash in the
  job payload, void on mismatch). Rejected: the worker loads content *after*
  enqueue, so an enqueue-time hash voids jobs whose output is genuinely
  fresh; and a real content-version serialization needs a counter column —
  map #710 rules out schema changes, and no schema is needed at the persist
  boundary.
- **Hold the review lock across generation.** Rejected outright:
  a seconds-to-minutes row lock against live-ingest, plus the documented
  PgBouncer transaction-pooling lock gotchas.
- **Persist the stale draft as `failed`/`superseded` for audit.** Rejected —
  starves the colliding fresh job (see above). Reworking the idempotency
  check to look through statuses would trade a one-line gate for a change to
  the generation pipeline's core idempotency contract.
- **Scope to `on_demand_generate` only (or non-auto lanes only).** Rejected:
  the chokepoint is lane-independent, so narrowing the scope is *more* code
  (a lane branch) for less coverage, and leaves `regenerate` — and the auto
  lane's stale-fallback hole — shipping the same defect.

## Consequences for #728 (implementation)

- Eval must cover the **stale-content direction** — a worker that already
  loaded old content persisting after the review changed. #678's existing
  race test covers only the reverse interleaving
  (`'Generate racing live-ingest regeneration …'`,
  `src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/route.test.ts:507`
  as of #729's extraction — cite the title, the line drifts).
- The skip-reason token + structured log line are the intake's observability
  answer.
- `CONTEXT.md` gains the **content-freshness gate** term when the behavior
  ships (glossary describes shipped behavior; this ADR is the decision
  record).

## Addendum (2026-08-09, #728 implementation)

Two corrections recorded at implementation time. The body above is the
decision record and is left as written; this addendum is what actually
shipped where the letter of the body drifted.

- **The convergence claim implicitly assumed the replacement job
  regenerates.** "Why skip-the-INSERT is load-bearing" traces every ordering
  to a fresh draft on the premise that the colliding job, finding its
  `(review_id, version)` slot free, generates against current content. The
  `(reviewId, version)` idempotent-generation cache violated that premise
  until #728: the replacement job legitimately shares the in-flight job's
  cache key, so the cache served it the stale worker's draft, and its own
  gate then compared the current hash against itself — the gate passed and
  the stale text persisted as fresh. Found by #728's adversarial branch
  review (NO-SHIP verdict); fixed in the same PR by binding cache identity
  to `review_content_hash` provenance — `CachedGeneration.reviewContentHash`
  (`src/lib/responses/generator.ts`), strict-equality accept against the
  current attempt's loaded hash, `null===null` for legacy entries,
  provenance-less or mismatched entries rejected + cleared. The convergence
  argument holds as written only with that binding in place.
- **Skip-reason token locus.** Decision step 2 cites the
  `SKIP_REASON_ARCHIVED_LOCATION` precedent in
  `src/lib/shared/worker-types.ts`; that precedent is for log-only skip
  reasons. This value is written to `job_outbox.completion_reason`, whose
  one owner is `OUTBOX_COMPLETION_REASON`
  (`src/lib/shared/outbox-completion-reason.ts` — `markOutboxCompletedWithReason`
  is typed against it, so the cited shape could not typecheck). The token
  shipped there as `STALE_REVIEW_CONTENT` (spelling `stale_review_content`
  unchanged). Locus correction, not a decision reversal; recorded in
  `docs/superpowers/plans/feat-728-content-freshness-gate-deviations.md`.
