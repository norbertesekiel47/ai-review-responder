# Branch review round 1 — adversarial approach axis (codex)

Codex ran in a read-only sandbox and could not write this file itself; the
review below is its verbatim output (from the companion run log), followed by
the orchestrator's triage verdicts.

## Codex output (verbatim)

Target: branch diff against 76b40b7b
Verdict: needs-attention

NO-SHIP: the consolidation API can silently misclassify held drafts, and its
guard cannot detect future owner-facing spellings. The requested Markdown
artifact could not be written because the workspace is read-only.

Findings:

- [high] The fragment API permits silent alias capture
  (src/lib/moderation/held-draft.ts:45-65)
  The helper accepts arbitrary caller SQL while introducing the common inner
  alias `fr`. An outer response also aliased `fr` expands to
  `fr.response_id = fr.id`; PostgreSQL resolves both references to the inner
  table, normally producing false. Projected reads then report `held=false`,
  while filtered reads admit the held draft, violating invariant #4. Current
  tests protect only today's aliases.
  Recommendation: Prefer a one-argument SQL function behind the TypeScript
  wrapper, with an EXPLAIN regression proving partial-index use. At minimum
  use a collision-resistant reserved alias and add a regression composing an
  outer `fr` reference plus mechanical alias enforcement.

- [high] The source-scan guard does not cover future owner-facing reads
  (src/lib/moderation/__tests__/held-draft.test.ts:70-90)
  `OWNER_FACING` is a fixed seven-file inventory. It proves those files still
  call the helper but never discovers a new route or service. An eighth
  owner-facing read can inline or drift the open-flag predicate while this
  supposedly universal guard stays green. The deviations log explicitly
  records this bypass. Because the predicate prevents unsafe drafts and
  affordances reaching owners, deferring the ratchet leaves the
  consolidation's original failure mode open.
  Recommendation: Add a repository-wide production-SQL audit for
  `flagged_responses`. Explicitly allowlist the deliberately distinct admin,
  health, offboarding, and producer sites; require every other open-status
  read to compose the owner helper so every new file forces classification.

- [medium] Seven test suites duplicate a fragile Postgres.js model
  (src/app/api/dashboard/past-replies/__tests__/draft-id.test.ts:39-53)
  Seven suites now repeat a verb-prefix classifier and return plain
  `{ fragmentText, values }` objects for fragments. The deviations record two
  waves of unexpected fallout — nine failures in three suites, then twelve in
  two more — showing this was shotgun test surgery rather than a contained
  seam. A future composable fragment beginning `SELECT` or `WITH` will again
  be mistaken for an executed statement and consume result queues.
  Recommendation: Promote one neutral fragment-aware SQL test client using
  lazy execution and recursive flattening, then adapt the seven suites
  through suite-specific result seeders.

- [medium] The code-only divergence sink leaves contradictory domain guidance
  (src/lib/moderation/held-draft.ts:12-30)
  The owner module explains that dismissal closes/releases heldness and
  regeneration closes the flag while superseding the draft. The existing
  `CONTEXT.md` Moderation hold entry instead says only
  `approved_for_owner_review` releases it. Actual disposition code changes
  status for every action while only approval sends a notification. Future
  cross-module work therefore encounters conflicting authoritative
  descriptions of invariant #4, and may never discover the code-local
  divergence block.
  Recommendation: Amend the existing Moderation hold glossary entry — without
  adding a new term — to distinguish closing heldness, owner notification,
  dismissal, and regeneration, and link it to the semantic-owner module and
  deliberately distinct consumer categories.

## Triage verdicts (orchestrator, round 1 — fixes in commit 203a3b9d)

- **[high] alias capture — PARTIAL ACCEPT.** The hazard mechanism is real
  (independently identified by the T2 quality review, which added the
  doc-comment reservation). The structural remedies (SQL function; alias
  rename) are REJECTED for this branch: all 8 call sites are verified clean,
  the alias is now load-bearing in locked, owner-approved test assertions and
  6 regenerated allowlist snippets, and codex's own timing point applies —
  the cheap moment for a rename was pre-T7. ACCEPTED instead: mechanical
  enforcement — a new scan test asserting no owner-facing call passes a ref
  qualified by `fr.` (held-draft.test.ts, commit 203a3b9d). SQL-function
  shape recorded as a fast-follow option in the deviations log.
- **[high] enumerative guard — ACCEPT (scoped).** New additive owner-tree
  sweep: every production `.ts` under the four owner-facing trees must not
  spell `FROM|JOIN flagged_responses` (comment-stripped; the deliberately
  distinct consumers live outside those trees by design, so no allowlist
  needed). Also closes the spec axis's JOIN-form gap. A literally repo-wide
  audit script remains a fast-follow (new CI surface, out of intake scope).
- **[medium] test-double duplication — REJECT for this branch, ACCEPT as
  fast-follow.** Consistent with the standards axis: extraction is warranted
  at the next consumer (rule-of-three is at its boundary); doing it now means
  re-touching 7 green suites during review close. Both positions recorded
  per the round protocol.
- **[medium] glossary contradiction — ACCEPT.** The draft "Moderation hold"
  entry conflated flag-release with re-notification. Amended in place (no
  new term — intake non-goal respected), linking the owner module and its
  divergence inventory (commit 203a3b9d).

Overall: codex's NO-SHIP rested on the two high findings; both are now
mechanically enforced (ref-alias scan + owner-tree sweep). The remaining
recommendations are recorded fast-follows.
