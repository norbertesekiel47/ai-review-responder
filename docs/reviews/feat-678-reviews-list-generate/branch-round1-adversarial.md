# Ticket #678 — Branch Round 1 Adversarial Approach Review

Fork point reviewed: `13212b5588b96de2a5c8fcd0430cc95d70271e50`.

This review is limited to the chosen approach, its design boundaries, and the factual premises behind D-A through D-H and deferrals D2, D6, and D17. It does not duplicate spec-correctness or line-level standards review.

## Findings

| severity | file:line | finding |
|---|---|---|
| high | `src/app/api/dashboard/reviews/[reviewId]/generate/route.ts:100` | D-A's “one caller, keep it inline” premise selects an existing oversized route as precedent and leaves the entire locking/eligibility/version/outbox transaction in the HTTP entry point, despite the repository's explicit route-to-domain-module boundary; invariant-critical Generate behavior therefore has no named, independently testable domain seam. |
| high | `worker/jobs/response-generation/persist.ts:154` | D2's “wasted LLM call, not corruption” blast radius is false: an on-demand worker can load the old review, lose the review lock to content-change ingest, then persist its stale draft because non-auto lanes skip the content-hash re-read; the uniqueness constraints only decide which draft survives. |
| high | `src/lib/past-replies/replies-view.ts:107` | D-D collapses orthogonal facts into one discriminant and gives a posted response precedence over a moderation-held replacement draft; that composite row renders Regenerate, after which the legacy draft flow exposes the held text and offers Resume/Discard instead of the promised no-text/no-affordance held state. |
| medium | `docs/superpowers/plans/feat-678-reviews-list-generate-deviations.md:109` | D6's inventory is false: the open-flag-per-response predicate is hand-spelled in at least eight production query sites, not three, so #680 is not the stated consolidation of one owner plus two new reads. |

## Finding analysis

### 1. D-A has chosen the wrong boundary

The repository's architecture says entry points orchestrate while modules own failure behavior, and more specifically that a route parses input, calls one module function, and returns (`.claude/CLAUDE.md:70`, `.claude/CLAUDE.md:80`). The single-caller anti-abstraction default at `.claude/CLAUDE.md:85` does not make a transaction-level application operation “just an abstraction”: the Generate transaction is the domain operation.

The new route performs ownership projection, subscription and budget checks, then owns a 77-line transaction containing the review lock, posted-response exclusion, non-terminal exclusion, in-flight job exclusion, version allocation, origin-lane selection, atomic outbox enqueue, and HTTP-specific error responses (`src/app/api/dashboard/reviews/[reviewId]/generate/route.ts:59`, `src/app/api/dashboard/reviews/[reviewId]/generate/route.ts:100`). The named precedent does the same kind of work inline (`src/app/api/dashboard/past-replies/draft/route.ts:106`), but existing architectural debt is not evidence that this is the right boundary for a new invariant-adjacent door.

The plan's stated alternatives are also artificially narrow: the domain operation need not live under the out-of-surface `src/lib/responses/**`; a module in an allowed review/past-reply surface could receive `tx` explicitly, preserving the composition-root rule at `.claude/CLAUDE.md:76`. The plan should be revisited so the route owns HTTP authentication/rate/error mapping and one named module owns the atomic Generate transition. This is a design correction, not a request for a second posting guard.

### 2. D2's unique-index argument does not bound semantic corruption

The indexes do prove a narrower claim. Migration 029 permits only one response in `pending_approval`, `approved`, `edited`, or `awaiting_owner_connect` for a review (`supabase/migrations/029_drop_awaiting_manual_post.sql:27`), and the base schema separately enforces `(review_id, version)` uniqueness (`supabase/migrations/001_initial_schema.sql:233`). Two workers cannot commit two v1 pending drafts.

They do not prove that the committed draft matches the committed review content. A valid interleaving is:

1. Generate commits an on-demand v1 outbox row.
2. Its worker reads the old review text and `review_content_hash` without locking the review (`worker/jobs/response-generation/load-context.ts:101`, `worker/jobs/response-generation/load-context.ts:232`) and begins the LLM call.
3. Live ingest acquires the review lock, updates the text/hash, observes no response row yet, and enqueues its own v1 job (`src/lib/reviews/process-review.ts:306`, `src/lib/reviews/process-review.ts:352`).
4. The first worker later acquires the review lock and persists the response (`worker/jobs/response-generation/persist.ts:272`, `worker/jobs/response-generation/persist.ts:102`). Because `on_demand_generate` is structurally non-auto, it never enters the runtime-state/hash re-read at `worker/jobs/response-generation/persist.ts:154`; the loaded/current hash comparison exists only inside auto-approval evaluation (`worker/jobs/response-generation/auto-approval.ts:327`).
5. The second job either observes v1 through the pre-spend idempotency check (`worker/jobs/response-generation/load-context.ts:144`) or loses at a uniqueness constraint. Exactly one row survives, but it can be a response to obsolete review text.

The added race test covers only the reverse direction—Generate arriving after an in-flight live-ingest outbox already exists—and asserts zero additional inserts (`src/app/api/dashboard/reviews/[reviewId]/generate/__tests__/route.test.ts:436`). It does not exercise a worker that has already loaded old content. D2 therefore cannot be deferred on the recorded “spend only” premise; the plan must account for content freshness at the persist boundary or otherwise serialize generation identity with the content version.

### 3. D-D models a cross-product as mutually exclusive states

The list query independently left-joins a posted response and the latest non-terminal response (`src/lib/past-replies/load-replies.ts:197`, `src/lib/past-replies/load-replies.ts:234`). That is intentional in the edit-existing-reply workflow: a live Google reply remains posted while a replacement is generated or edited (`src/app/api/dashboard/past-replies/draft/route.ts:119`, `src/app/api/dashboard/past-replies/draft/route.ts:198`). A moderation-held regenerated replacement is therefore allowed to coexist with `response_id !== null` and `draft_held === true`.

`deriveRowState` nevertheless returns `regenerate` as soon as a posted response exists, before considering the held draft (`src/lib/past-replies/replies-view.ts:106`). The state test suite exercises each member against a mutually exclusive base fixture but never supplies both facts (`src/lib/past-replies/__tests__/reviews-list.test.ts:445`). The card then renders the ordinary Regenerate control (`src/components/dashboard/reviews/PastReplyCard.tsx:193`, `src/components/dashboard/reviews/PastReplyCard.tsx:404`).

That is not merely a mislabeled button. Opening the drawer calls the legacy draft route, whose existing-draft branch returns the non-terminal response text without a hold check (`src/app/api/dashboard/past-replies/draft/route.ts:119`). The client stores that text (`src/components/dashboard/reviews/edit-reply/useEditReplyDraft.ts:242`) and renders it with Resume and Discard actions (`src/components/dashboard/reviews/edit-reply/DraftConflictPanel.tsx:97`). The discard route can supersede any pending draft without checking its open flag (`src/app/api/dashboard/past-replies/draft/[responseId]/route.ts:220`). Thus D-D's state factoring defeats the very “held means no text and no affordance” configuration D9 added.

The plan should represent the answered/unanswered presentation axis separately from the replacement-workflow axis, or at minimum make the held workflow dominate a posted sibling. Merely adding a seventh mutually exclusive label would not address the underlying cross-product mistake.

### 4. D6 undercounts the existing semantic duplication

The three cited sites are genuinely equivalent spellings of “an open flag exists for this response”: the transactional owner (`src/lib/moderation/held-draft.ts:34`) and the two new positive `EXISTS` reads (`src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts:68`, `src/lib/past-replies/load-replies.ts:237`). But they are not the complete production inventory.

The same response-correlated open-flag predicate is already hand-spelled as `NOT EXISTS` in both dashboard loaders (`src/lib/dashboard/aggregate-service.ts:404`, `src/lib/dashboard/service.ts:253`), twice in the pending-count module (`src/lib/dashboard/pending-count.ts:17`, `src/lib/dashboard/pending-count.ts:45`), and as a null-filtered left join in the agent read path (`src/lib/agents/read.ts:325`). That is at least eight query sites with the same relational fact, before counting callers that reuse `hasOpenFlag`.

This does not prove those existing sites are behaviorally wrong, and it need not force a broad refactor into #678. It does mean the recorded “three spellings” premise and the implied scope of #680 are false. The follow-up must inventory all consumers and decide whether it needs a composable SQL predicate, higher-level read helpers, or both.

## Design-decision verdicts

### D-A — REVISIT

The route location, owner authentication, same-origin wrapper, and atomic outbox transaction are appropriate. Keeping the application transaction inline is not. The one-caller rule is being applied against the repository's more specific entrypoint boundary, and the cited route is precedent for debt rather than the right new seam.

### D-C — ACCEPT

The second endpoint represents a different resource and interface: the old poller is attempt-keyed by `outbox_id`, current-location scoped, and edit-flag gated (`src/app/api/dashboard/past-replies/draft-status/route.ts:40`, `src/app/api/dashboard/past-replies/draft-status/route.ts:56`); the new endpoint is review-keyed, account scoped, refresh-resumable, and independent of edit-reply enablement (`src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts:3`, `src/app/api/dashboard/reviews/[reviewId]/draft-status/route.ts:31`). Adapting the old route would conflate attempt status with current review workflow state. A shared helper is not yet justified because the response shapes and resolution rules differ materially.

### D-D — REJECT / REMODEL

Server derivation is the correct ownership direction, but the six-way union is the wrong factoring. Posted status and replacement workflow status can coexist, and the current precedence hides a moderation hold. Model the orthogonal axes or define a composite-safe dominance rule before treating the discriminant as the rendering contract.

### D-F — ACCEPT

Fail-open is correct for this read because it is advisory presentation, not the spend authority. The batch read returns an empty map on Redis failure (`src/lib/costs/tracker.ts:389`, `src/lib/costs/tracker.ts:402`), while answered-row generation reaches the worker-side Lua `INCR`/cap before the LLM call (`src/lib/costs/tracker.ts:266`, `worker/jobs/response-generation/generate-draft.ts:106`). An over-limit counter fails the generation; a Redis transport error propagates and prevents the LLM call. Disabling all Regenerate actions when the advisory store is unavailable would turn an observability outage into a customer-facing denial without improving spend safety.

### D-H — ACCEPT

The structural claim holds, although the protection is the whole typed chain rather than the enum declaration in isolation. Fresh producers must supply a `GenerateResponseOriginLane` (`src/lib/shared/worker-types.ts:44`), the shared enqueue helper serializes it (`src/lib/shared/job-outbox-helpers.ts:222`), and missing or unknown runtime values normalize fail-closed to `null` (`src/lib/shared/job-outbox-helpers.ts:180`). The Generate route supplies `on_demand_generate` (`src/app/api/dashboard/reviews/[reviewId]/generate/route.ts:157`), while the only structural auto-candidate predicate is an exact `live_ingest_new` match plus v1 and notification eligibility (`worker/jobs/response-generation/persist.ts:81`). The on-demand-lane persistence test also isolates the lane with every other conjunct favorable and observes no auto-policy update or publish outbox (`worker/jobs/response-generation/__tests__/on-demand-lane.property.test.ts:155`).

Posting remains behind an explicit owner transition: the dashboard approve route requires the owner and calls the approval service (`src/app/api/dashboard/reviews/[reviewId]/approve/route.ts:12`), which stamps `approval_method='owner'` and only then enqueues `publish_response` (`src/lib/approval/session-mode.ts:70`). A second Generate-specific guard would duplicate policy and could drift; the existing exact-match discriminator is sufficient structural protection for invariant #3.

## Deferral verdicts

### D2 — REJECT

The uniqueness proof establishes one committed response row, not content freshness. Because a non-auto worker can persist text generated from a pre-update snapshot after content-change ingest commits, the deferred race can produce a user-visible stale draft, not merely an extra cost record. The recorded blast-radius premise is false and the approach must be revisited before accepting deferral.

### D6 — REVISE

The individual SQL predicates are equivalent, but the inventory is at least eight production query sites rather than three. Consolidation may still be deferred, but #680 must be rescoped around the real consumer set. Separately, D-D shows that an equivalent held predicate can still be applied incorrectly through precedence; consolidation alone would not fix that model error.

### D17 — ACCEPT

The surviving reference is inert. It occurs in a test-only integration suite as captured/set/restored environment state and an outdated comment (`worker/jobs/publisher/__tests__/edit-existing-reply.integration.test.ts:40`, `worker/jobs/publisher/__tests__/edit-existing-reply.integration.test.ts:318`). The suite also enables the live `EDIT_REPLIES_ENABLED` flag, and production's sole accessor reads only that flag (`src/lib/past-replies/flags.ts:18`). No production behavior consumes the retired variable.

## Low-confidence appendix

- **D-C divergence hypothesis (<80%):** the two route-local status mappers could drift if response or outbox terminal states evolve. The current keys, authorization scopes, flag gates, and response semantics are different enough that this is not a main finding and does not justify sharing a helper on this branch.

