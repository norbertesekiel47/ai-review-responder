# Step-7 triage verdicts — feat-726-legacy-hold-gates (round 1)

Axes: spec-correctness.md · standards.md · adversarial-codex.md (this file
holds all verdicts; a resumed session reads triage state here).

## Spec & correctness agent (2 findings)

- LOW draft-status.test.ts:521-523 — SQL-shape test omitted the correlation
  predicate. **ACCEPT — FIXED**: assertion now requires
  `f.response_id = responses.id` and the flag-qualified
  `f.status = 'open'` (commit in this review round).
- LOW useEditReplyDraft.ts:188-196 — stale comment ("failed ⇒ no response
  row exists"). **REJECT/DEFER to #727**: real but out-of-surface; burning
  surface amendment #2 (the abort trigger) on a comment whose behavior
  remains safe is a bad trade. #727 rewrites this client's states; noted for
  its intake. Recorded in the PR description.

## Standards agent

- NO FINDINGS. Nothing to triage.

## Codex adversarial agent (verdict needs-attention, 3 findings — all REJECTED, both positions recorded)

- HIGH "held misrepresented as terminal failure; needs first-class held
  state". **REJECT — re-litigates a locked owner decision**: the named-held
  poll state was explicitly offered at grilling and declined; the intake
  locked `{status:'failed', error:'held_for_review'}`, and map #710 assigns
  the affordance half to #727 by design ("the remodel ticket closes the
  other half"). Factual correction to the finding: a "Try again" retry 409s
  at the held gate before any outbox enqueue — it consumes per-owner
  rate-limit headroom only, never LLM spend, never text. Disagreement will
  be surfaced verbatim at the step-8 merge-approval pause.
- MEDIUM "enforcement opt-in per route; build a shared domain seam".
  **REJECT — out of scope by explicit map sequencing**: #730 owns
  owner-facing predicate/seam consolidation, deliberately AFTER this ticket
  ("close the hole first, tidy second" — ticket text). The shared-domain-
  operation recommendation is preserved here as design input for #730.
- MEDIUM "live-DB concurrency tests; flip db_touching". **REJECT — third
  appearance of the live-DB ask**, rejected at plan round 1 (deviations D1)
  and verified REJECTION-RECORDED at plan round 2. The gate's lock shape is
  identical to the shipped publish gate; the residual admin-disposition race
  is fail-safe (worst case: refuse a just-released draft) per the plan's
  Serialization note; flags only ever open at generation persist, before any
  owner surfacing.

## Round accounting

branchReviewRounds=1 consumed. One accepted finding → one-line test fix.
Round 2 = verification-only on the spec axis (the only axis with an
accepted finding).
