# Run D second adversarial pass authorization

Date: 2026-09-14. Owner reply: **Go for it**.

The owner approved this exact question:

> May I make the Run D-only verifier change described in /private/tmp/run-d-next-pass-proposal.md and run its second adversarial pass, capped at 200 local test launches? This covers the 35 unmeasured cases, the recovery correction and verifier safeguards, includes only the named supporting paths, preserves earlier evidence, uses Codex only, and grants no third round.

The original round-1 report remains at `docs/reviews/red-team/codex-owner-operator-run-d-7749f8/`, with the exact approval appended as authorization `owner-run-d-second-pass-200`. Its226 discovered identities retain50 in-scope cases,15 measured kills and35 unmeasured cases;176 unrelated discovery cases remain explicitly excluded. The original inventory identity digest is `fa3b864a18eee4f2d9fbb7e64c630e53d6d54b90da8a410a88c0d128c6b1c032`.

The scoped grant applies only to branch `codex/owner-operator-run-d`, round2, the preserved committed report and the exact committed owner approval. It pins the corrected committed HEAD before launching and rejects later drift. It permits at most200 supervised local launches to finish original unmeasured coverage, verify D-A1 and directly affected callers, and test the grant's own safeguards. It does not authorize a third round, provider calls, another observation campaign, accepted risk, or a coverage waiver.

The third owner-authorized surface amendment adds only four existing paths: `.agents/skills/red-team/scripts/mutation-runner.mjs`, `.agents/skills/red-team/SKILL.md`, `.claude/skills/red-team/SKILL.md`, and `scripts/ci/__tests__/red-team-mutation-runner.test.ts`. The proposal mentioned an existing `.claude` script mirror, but inspection found none; no duplicate script is created. Existing D plan/review/evidence paths hold the audit records. The intake also names the two new D-A1 regression tests; no other contract field changes.

The120-second per-launch limit, at most two mutations per case, exact-one-test assertion, allowlisted local environment, dotenv isolation, mutation journal, root-owned finalizer, and honest incomplete statuses remain active. All other branches retain their existing budgets.
