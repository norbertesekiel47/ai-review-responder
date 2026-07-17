# Deviations — #476

- **Step 4 execution done in-session (not via fresh subagents).** Rationale: byte-identical
  parity depends on exact reuse of existing dashboard mappers (`buildValueSummary`,
  `buildRanking`, `buildRatingBreakdown`, brief-picking). A context-poor subagent is more
  likely to reinvent these and silently break parity than an orchestrator holding the full
  call-graph context. Implemented directly with red-green TDD, one commit per tracer ticket.
  Fresh-agent independent review is retained at step 7 (unchanged). User was in "proceed, I
  self-enforce" mode.
- **Enforcement:** edit-surface guard is mechanically armed (file-anchored). Stop-gate is
  disarmed in this harness (anchors on the main checkout, not the sibling worktree — see ARM
  CHECK probe 2a). Self-enforcing the verify gate: no completion claim without a green
  `.feature/gate-status.json` from `scripts/verify-gate.sh`.
- **Windowed account rate folded into the set-based wave.** `getTotalReviewsForAccount`/
  `getTotalRespondedForAccount` deleted rather than windowed-in-place; the windowed account
  rate derives from the sum of per-location windowed counts (equal because locations partition
  reviews by `business_id`). Satisfies the intake goal with fewer queries; flagged for the PR.
