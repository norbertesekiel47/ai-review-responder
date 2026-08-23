# Paste-ready prompt — the top three items

Verified against `main` @ `9b58f770` on 2026-08-23. Theme A confirmed clean.
Source: `04-handoff-prompts.md` ranks 1–3.

```
Repo: RepWorth. Branch from `main` (protected — land via PR, never push direct).
Open PRs with `gh pr create --draft`, then `gh pr ready` — draft PRs run no CI.

Read first, in this order:
  docs/reviews/PATHFINDER-2026-08-22/06-guard-integrity.md   (the mutation results)
  docs/reviews/PATHFINDER-2026-08-22/04-handoff-prompts.md   (H8 and H9, full detail)
  docs/reviews/PATHFINDER-2026-08-22/02-duplication-report.md X18

These came from an architecture pass on 2026-08-22. Every claim below was
measured, not inferred. Line numbers verified at HEAD 9b58f770.

Do these as THREE SEPARATE PRs, in this order. Do not combine them.

════════════════════════════════════════════════════════════════════════
PR 1 — Three integrity tests for the solicitation send lane
════════════════════════════════════════════════════════════════════════

Three guards in src/lib/solicitation/dispatch.ts were measured UNPINNED by
mutation: each was deleted, the whole lane ran (46-52 files, 713-812 tests),
and everything stayed GREEN. A whole-repo grep of src + worker returns ZERO
test-file references for their outcome discriminants. These three failure
modes are silent in production.

TEST 1 — the bytes-identity check (dispatch.ts:1520-1529). HIGHEST VALUE.
  Let gatherSlowGateEvidence compute its verdict, then
  UPDATE solicitation_outreach SET rendered_body = <different>
  before the locked re-read inside runDispatchTx.
  Assert: dispatchOutreach returns { kind: 'bytes_changed_under_gate' };
  the messaging adapter is NEVER called; delivery_status stays 'queued';
  only the outbox attempt is completed.
  It is a DEFER, not a withhold.
  Why: this is the only mechanical check that the bytes moderated are the
  bytes sent. Without it the lane can moderate one artifact and send another.

TEST 2 — the terminal CAS (dispatch.ts:1126, `AND delivery_status = 'sending'`).
  Terminalize the row to 'failed' between tx1 and commitSendTerminal.
  Assert the four consequences the docstring at :1131-1139 already states and
  none of which is asserted anywhere: delivery_status still 'failed';
  provider_message_id still NULL; NO agent_outcomes 'solicitation_sent' row;
  no 'completed' child step.

TEST 3 — the queued CAS (dispatch.ts:1723, `AND delivery_status = 'queued'`).
  Open a dispatch transaction against a row already in 'sending'.
  Assert { kind: 'in_flight_elsewhere', detector: 'cas_lost' }; no provider
  send; no sending_at write.

ANTI-PATTERN GUARDS
  - Assert the OBSERVABLE OUTCOME, never the SQL text. A query-shape pin
    passes with the predicate deleted — that is the exact failure being fixed.
  - Do NOT merge tests 2 and 3. They guard opposite transitions (into
    'sending' vs out of it) and have different discriminants.
  - Live-DB file => name it *.integration.test.ts and execute NO run-time DDL,
    or ci:live-db-suites fails.

ENVIRONMENT — the suites SKIP SILENTLY without these and you will report a
false pass:
  export TEST_DATABASE_POOL_URL=postgresql://test@localhost:5499/test_ws4
  export DATABASE_POOL_URL=$TEST_DATABASE_POOL_URL
  Container `repworth-testdb`. Confirm it is at migrations head (111) first;
  run `pnpm test:db:setup` if it is behind.

VERIFY BEFORE YOU OPEN THE PR: for each test, apply the mutation from
06-guard-integrity.md, confirm YOUR test goes RED, then restore the file and
confirm `git diff --stat` no longer lists it. A test that does not go red
under the mutation it was written for is not a test.

════════════════════════════════════════════════════════════════════════
PR 2 — Canonicalise the batch id in ask-generation.ts
════════════════════════════════════════════════════════════════════════

THE DEFECT. `agent_runs.subject_id` is TEXT (migration 071), so comparing it
is case-SENSITIVE, while every `::uuid` cast normalises.

`settleGenerationExhaustion` (src/lib/solicitation/ask-generation.ts:1570)
binds the same input.batchId two ways inside ONE transaction:
  WHERE id = ${input.batchId}::uuid   -> cast, case-insensitive: batch FOUND, locked
  :1632  AND subject_id = ${input.batchId}  -> raw TEXT: send parent MISSED
It then writes `agentRunId: parent?.id ?? null` on every filled hole and skips
the generation steps. Silently. Forty lines later closeBatchIfSettled
lowercases internally (outreach.ts:334) and DOES find the parent — two readers
of one key, in one transaction, disagreeing.

THIS ALREADY SHIPPED ONCE. Read src/lib/solicitation/approval.ts:135-152.
`canonicalBatchId` exists because of this exact bug: approveBatch threw a 500
and haltBatch silently dropped its batch_halted step. It is currently NOT
exported (approval.ts:151).

ask-generation.ts contains ZERO canonicalBatchId calls and zero .toLowerCase().

DO
  1. Export canonicalBatchId from a leaf both files can import. Do not leave it
     module-private in approval.ts and do not duplicate it.
  2. Call it at the entry point of settleGenerationExhaustion (:1570).
  3. Call it at the entry point of regenerateAsk (:1299) too. Its binding at
     :1434 uses ctx.batchId, which loadBatchContext:176 makes canonical by
     round-tripping through Postgres (`batchId: row.id`). That is SAFE BY
     ACCIDENT, not by guard. Make it structural.

ANTI-PATTERN GUARDS
  - Do NOT lowercase at the SQL sites. Canonicalise ONCE at the entry point.
    approval.ts:140-146 says why; per-site lowercasing is how this recurs.
  - Do NOT unify the send-parent QUERY. run-spine.ts:486 asks "is there an
    ACTIVE parent" (status='running'); the others ask "the LATEST parent"
    (ORDER BY started_at DESC LIMIT 1). Different questions. This is in the
    DO-NOT-UNIFY register in 02-duplication-report.md.
  - Moving canonicalBatchId to a new file => a docs/directory.md row in the
    same PR (ci:directory-map).

TEST: an integration case that calls settleGenerationExhaustion with an
UPPERCASED batch id and asserts the generation steps land on the send parent.
Today it writes agentRunId: null and passes silently.

════════════════════════════════════════════════════════════════════════
PR 3 — Issue #896: ci:merge-ledger, and stop the Stop hook eating a mutation
════════════════════════════════════════════════════════════════════════

Run `gh issue view 896` for the full body. Two parts; PART 2 IS ~10 LINES AND
SHOULD NOT WAIT FOR PART 1 — split into two PRs if that is faster.

PART 2 first (the safety hole). `.claude/hooks/typecheck-on-stop.sh:53-62`
blocks the turn on any non-zero eslint over changed files. When an agent
deliberately deletes a guard to measure it, the orphaned-import error is
reported and the mechanically obvious remedy — delete the unused import —
PERMANENTLY REMOVES A POSTING PRECONDITION (invariant #3).
  - The issue names only .claude/hooks/. There is a SECOND, structurally
    identical copy at .codex/hooks/typecheck-on-stop.sh:40-45. Fix BOTH or the
    Codex lane keeps the hole.
  - Cheapest fix: a mutation sentinel file the hook skips on.

PART 1 (ci:merge-ledger). Correct the issue body first — its numbers are stale:
  - The counter no longer reads 8. It was hand-corrected to 7 in #929 and reset
    to 0 by the 2026-08-22 pass.
  - The issue says "third consecutive pass". It is the FOURTH.
  - The governance path set it names was re-verified on 2026-08-22: every path
    still exists and NEEDS NO REVISION.
  - Four merges were missed in the last window alone (#901, #905, #925, #926).
    #905 is 51 production files and left no row in the log at all.

ANTI-PATTERN GUARD: a new ci:* script must be wired into ci.yml's `lint` job
AND lefthook.yml, or src/__tests__/ci-audit-wiring.test.ts fails — which is
correct and is the point.

════════════════════════════════════════════════════════════════════════
BEFORE YOU START
════════════════════════════════════════════════════════════════════════
- `git status` and check the tree. A concurrent session was editing marketing
  files on 2026-08-22 and landed #930. If src/components/sections/** or
  src/app/(public)/** is dirty, that is not yours — do not revert it, and do
  not include it in your PRs.
- Verify: `pnpm lint && pnpm typecheck && pnpm test` before claiming done.
- Do not touch docs/reviews/PATHFINDER-2026-08-22/ except to tick an item.
```
