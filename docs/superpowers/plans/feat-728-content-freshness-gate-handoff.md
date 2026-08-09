# feat-728-content-freshness-gate — handoff

**Current step:** 8 (SHIP, high lane) — implementation + review complete at
`451f85cf`, phase `reviewed`, gate GREEN (--review mode). Remaining: staging
ride → PR to main → CI green → **owner merge approval (mandatory pause)** →
post-merge chores (incl. the promotion obligations below).

**Step 7 outcome (2 rounds, counter-enforced):** spec CLEAN; standards
resolved (final LOW closed by compiler-verified `satisfies` link); adversarial
**APPROVED** after its round-1 CRITICAL — the same-version generation cache
served stale drafts past the gate — was fixed via cache provenance
(`CachedGeneration.reviewContentHash`, strict-equality accept, owner-approved
surface amendment #2 = Option A, explicit abort-trigger override). All verdicts
+ evidence: `docs/reviews/feat-728-content-freshness-gate/`.

**Step 8 promotion obligations (from deviations):** lab-notes entries for
(a) the verify-gate `DATABASE_POOL_URL` env gap + follow-up ticket for
`scripts/verify-gate.sh`, (b) the cache-provenance lesson (cache identity must
bind to content when a replacement job shares the key); ADR 0017 addendum
noting the cache vector; post-merge docs sweep via `document-feature`.

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
