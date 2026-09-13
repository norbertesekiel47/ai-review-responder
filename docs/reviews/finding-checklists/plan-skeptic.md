# Accepted findings — plan-skeptic

Defect classes a /feature review ACCEPTED on a real branch. Reviewers on
this axis receive this file and check the diff against every line. Lines
are appended by review-log.mjs triage; edit only to prune entries that no
longer apply.

- [medium] Exclude soft-deleted attributed reviews (src/lib/solicitation/attribution.ts:466) — Existing attribution read excludes REVIEW_STATUS.DELETED; plan now requires the same filter and both deletion tests. · codex/fix-1076-1077-1048 · 2026-09-06
- [high] Bind actual response-helper arguments and callbacks per call site (scripts/ci/admin-contract-types.ts) — Existing jsonResponse and channel callbacks erase response types; revised plan requires bounded specialization and negative fixtures. · feat/1190 · 2026-09-10
- [medium] Preserve successful JSON serialization uncertainty and nullable values (src/lib/admin/business-detail-types.ts:180) — Existing audit payload is unknown; revised plan separates original DTOs from conservative JSON wire projection. · feat/1190 · 2026-09-10
- [medium] Mark normalization limits in generated request schemas (src/app/api/admin/businesses/[id]/keywords/route.ts:15) — Trim before length validation disagrees with raw JSON Schema in both directions; revised plan requires metadata and witness tests. · feat/1190 · 2026-09-10
- [medium] Sibling invalidation must follow version-token domain (src/lib/agents/operator/proposals.ts:469) — Current location sweep would stale independent policy tokens; revision 2 adds token-domain invalidation and mixed-domain tests · codex/owner-operator-run-c · 2026-09-13
- [medium] Completion barrier does not prove lock before freshness reads (src/lib/auto-approval/__tests__/settings.test.ts:494) — A stale pre-lock read still blocks later; revision 2 requires explicit query-order assertions plus live blocking evidence · codex/owner-operator-run-c · 2026-09-13
- [medium] Worker candidate must ride staging before promotion (.claude/CLAUDE.md:35) — Provider schemas affect all structured tasks; revision 2 verifies reviewed staging worker before main and retains post-merge scope-card check · codex/owner-operator-run-c · 2026-09-13
