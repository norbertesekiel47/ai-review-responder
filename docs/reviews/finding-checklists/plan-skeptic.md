# Accepted findings — plan-skeptic

Defect classes a /feature review ACCEPTED on a real branch. Reviewers on
this axis receive this file and check the diff against every line. Lines
are appended by review-log.mjs triage; edit only to prune entries that no
longer apply.

- [medium] Exclude soft-deleted attributed reviews (src/lib/solicitation/attribution.ts:466) — Existing attribution read excludes REVIEW_STATUS.DELETED; plan now requires the same filter and both deletion tests. · codex/fix-1076-1077-1048 · 2026-09-06
