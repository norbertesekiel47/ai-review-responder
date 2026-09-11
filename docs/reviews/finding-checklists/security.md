# Accepted findings — security

Defect classes a /feature review ACCEPTED on a real branch. Reviewers on
this axis receive this file and check the diff against every line. Lines
are appended by review-log.mjs triage; edit only to prune entries that no
longer apply.

- [medium] Contract regeneration follows symlinked output ancestors (scripts/ci/admin-contract-audit.ts:208) — Isolated CLI regression log1190-symlink-regression-red proves --write succeeds through linked output root instead of refusing; validate docs and admin-api ancestors before generation, reads, cleanup or writes. · feat/1190 · 2026-09-11
