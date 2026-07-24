# Step 7 triage verdicts — feat/competitor-snapshots-538 (2026-07-23)

Both agents' full reports sit in this directory. Verdicts (fixes in commit
following this file's addition):

- ACCEPTED (both agents) — stale fallow-ignore justification comment
  (RankingTrackingWorker.ts): rewritten to describe the #538 tx block honestly;
  suppression itself retained (handler complexity is inherited, not added).
- REJECTED (standards MEDIUM) — bulk `${tx(rows)}` insert: plan deliberately
  locked per-row INSERTs (template-tag test harness breaks on the helper-call
  form; ≤~20 rows weekly inside a short tx; upsert-first row lock bounds
  contention). Revisit only with measured evidence.
- ACCEPTED (standards LOW) — mock-pack synthesis extracted to private
  `synthesizeMockPack(business)` in the same file; resolver interface unchanged.
- ACCEPTED (standards LOW) — in-callback tx test wraps impl swap in
  try/finally so a failed assertion can't leak the poisoned mockSql impl.
- ACCEPTED (spec LOW) — added intake-promised assertion: rank upsert carries
  NULL rank_position when own business is absent from the pack (values index 4).
