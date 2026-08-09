# feat-728-content-freshness-gate — handoff

**Current step:** 4 (EXECUTE). Plan approved 2026-08-09 after 3 codex review
rounds (round cap; final nit resolved in-plan — see round-3 report tail).

## Read in this order (never the prior transcript)

1. `.feature/state.json` — machine-readable phase.
2. Intake (locked + amendment #1): `docs/superpowers/plans/feat-728-content-freshness-gate-intake.json`
3. Plan (rev 3, LOCKED): `docs/superpowers/plans/2026-08-09-feat-728-content-freshness-gate.md`
4. Deviations (token-locus correction, surface amendment, test-title additions, one rejected finding): `docs/superpowers/plans/feat-728-content-freshness-gate-deviations.md`
5. Plan-review reports r1–r3: `docs/reviews/feat-728-content-freshness-gate/plan-review-round{1,2,3}.md`
6. Decision record: `docs/adr/0017-persist-boundary-freshness-gate.md` (ticket #728, decision ticket #724, map #710 item 2)

## Facts a resumed session needs

- RISK = high (worker + concurrency) → staging ride before `main`, owner merge
  approval at step 8. SURFACE = backend. Amendment budget used: **1 of 2**.
- Codex session artifacts: reviews ran via direct `codex exec` (read-only),
  output-last-message into the report files above; logs in the session
  scratchpad (`codex-plan-review-round{1,2,3}.log`).
- Plan-review round counter: 3 (exhausted). Branch-review counter: 0.
- Glossary terms (use verbatim): **content-freshness gate**,
  **stale_review_content** (`OUTBOX_COMPLETION_REASON.STALE_REVIEW_CONTENT` —
  NOT worker-types; see deviations), **skip-the-INSERT**.
- Task order: 1 (eval, ALONE — enforcement spot check follows it) → 2 → 3 → 4
  serial; 5 (CONTEXT.md) parallel-safe after 1.
- Live-DB runs need `TEST_DATABASE_POOL_URL`; the integration suite is
  `worker/jobs/response-generation/__tests__/content-freshness-gate.integration.test.ts`
  (new file, sanctioned by intake).
