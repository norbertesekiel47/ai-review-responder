# #858 — case-safe Settled batch closure

## Fixed point

- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/codex-858-close-batch-case`
- Base: `2aa9c4fe` (`origin/main`, including #629, #651, and #629's post-merge documentation sweep)
- Intake: `docs/superpowers/plans/codex-858-close-batch-case-intake.json`
- Risk: high because this changes durable Send batch parent terminalization.

## Caller audit

`closeBatchIfSettled` has seven production callers. `approveBatch` and
`haltBatch` receive HTTP-origin ids but already canonicalize at their verb
entry points. Four ask-generation paths read the batch id from PostgreSQL. The
generation-exhaustion path receives a queue payload originally minted from a
database batch id. The callee nevertheless owns defensive consistency for all
current and future callers, including #630's planned releaser backstop.

## Tracer 1 — pin the public failure

- Observable behavior: a mixed-case valid batch UUID closes the batch and its
  Send batch parent exactly as its lowercase representation does.
- Test seam: call `closeBatchIfSettled` inside the existing live-database
  integration harness.
- Exact test: `closes the Send batch parent when the batch id uses mixed case`.
- Blocking edges: local test database must be at migration head; no production
  edit precedes the red assertion.
- Precedent: existing exhausted-close case in
  `src/lib/solicitation/__tests__/outreach-close.integration.test.ts`.
- Allowed files: the integration test only.
- Completion evidence: the new test fails on `no_send_parent` before the fix.

## Tracer 2 — canonicalize once at the lifecycle owner

- Observable behavior: every statement and diagnostic inside
  `closeBatchIfSettled` uses one canonical batch-id representation.
- Test seam: Tracer 1 plus the existing close integration suite.
- Deterministic check: `pnpm exec vitest run src/lib/solicitation/__tests__/outreach-close.integration.test.ts`.
- Blocking edges: Tracer 1 red; preserve malformed UUID rejection and the
  winning-CAS-only receipt/parent writes.
- Precedent: canonical-once boundary handling in
  `src/lib/solicitation/approval.ts`.
- Allowed files: `src/lib/solicitation/outreach.ts` and the test from Tracer 1.
- Completion evidence: focused suite green; canonical callers unchanged.

## Verification and rollback

Run the intake commands, then
`.agents/skills/feature/scripts/verified-gate.sh --review`. A rollback reverts
the callee-local canonicalization and its test; no schema, data, flag, or
remote-operation rollback exists. Success remains observable through the
existing `send_batch_closed` step, `send_closed_at`, and terminal parent run.
