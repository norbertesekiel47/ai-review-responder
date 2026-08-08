# Handoff — #679 Import consent worker guard

**Updated 2026-08-08, after branch review round 3 (the last round) and its fix
round.** Everything below is a pointer or a fact; nothing restates content that
lives in a file. A fresh session needs only this doc, then the files it names.
**Do not go looking for the prior transcript.**

## Current position

**Step 7 COMPLETE — all three review rounds done and triaged. Gate GREEN.
Next action: step 8, RISK = high lane, starting with migration 102 on the
staging Supabase project.**

| Fact | Value |
|---|---|
| Branch | `feat-679-import-consent-worker-guard` |
| Worktree | `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-679-import-consent-worker-guard` |
| Base (fork point) | `main@2f369582` |
| HEAD | `abcf977f` |
| Phase | `reviewed` |
| Plan review rounds | **2 of 3** — `APPROVED` at round 2 |
| Branch review rounds | **3 of 3 — EXHAUSTED.** No further review rounds are permitted. |
| Surface amendments | **2 of 2 — EXHAUSTED**, and the 2nd consciously overrode the abort criteria (D36) |
| Risk / surface | high / mixed, DB-touching |

**Both budgets are spent.** Any further surface widening, or any impulse to run
a round 4, is a real teardown decision — not another judgement call. If new work
appears, that is the signal to stop and talk to the owner.

## Artifacts (worktree-relative)

| What | Path |
|---|---|
| Intake contract (locked, 41 promised tests, 2 amendments) | `docs/superpowers/plans/feat-679-import-consent-worker-guard-intake.json` |
| Plan | `docs/superpowers/plans/2026-08-07-import-consent-worker-guard.md` |
| Deviations D9–D38 + triage verdicts | `docs/superpowers/plans/feat-679-import-consent-worker-guard-deviations.md` |
| Plan reviews (r1 REVISE → r2 APPROVED) | `docs/reviews/…/plan-review-round-{1,2}.md` |
| Branch review round 1 (3 axes + triage) | `docs/reviews/…/review-{spec-correctness,standards,adversarial}.md` |
| Branch review round 2 (3 axes + triage) | `docs/reviews/…/review-*-round-2.md` + `branch-review-brief-round-2.md` |
| Branch review round 3 (3 axes + triage) | `docs/reviews/…/review-*-round-3.md` + `branch-review-brief-round-3.md` |
| Blast radius | `docs/reviews/…/blast-radius.md` |
| Design of record | `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §5.1, §5.3 |
| ADR | `docs/adr/0015-consented-import-unflagged-replacement.md` §2, §3 |

## What shipped

Fail-closed **Import consent** gate in `ZernioBackfillWorker` — closes the last
consent hole in map #667 (ADR 0015 §3's accepted gap) — plus migration 102
registering the two **Import offer** analytics events #677 deferred here.

Production surface: `worker/jobs/zernio/job-eligibility.ts` (+`guardImportConsent`),
`ZernioBackfillWorker.ts` (call site, before the run-row INSERT),
`src/lib/reviews/import-consent.ts` (savepoint-wrapped emissions + narrowed catch),
`supabase/migrations/102_…sql`, `src/lib/analytics/events.ts`,
`src/app/admin/runbook/page.tsx`, `src/lib/shared/worker-types.ts`.

## Review outcome — three rounds, 20 findings, all triaged

| Round | Spec | Standards | Adversarial | Net |
|---|---|---|---|---|
| 1 | REVISE | REVISE | REVISE | 13 findings — 10 fixed, 3 filed (#694/#695/#696) |
| 2 | REVISE | REVISE | REVISE | 4 findings — 3 fixed, 1 filed (#697) |
| 3 | **APPROVED** | REVISE | **APPROVED** | 5 findings — 5 fixed |

**The through-line, and the thing to remember about this branch:** the dominant
defect mode was *false coverage* — tests that pass whether or not the bug exists.
It recurred at every level, including inside its own fixes:

- Round 1 found five instances. Every one was caught by **mutation**, none by reading.
- Round 2's decisive finding: the **savepoint** — the fix for the branch's worst
  defect — shipped unpinned. Deleting it left all 37 live-DB and 42 unit tests green.
- Round 3's decisive finding: the **catch narrowing** — round 2's own fix — shipped
  unpinned too. Both failure tests injected `23514`, which carries a string `code`
  and is swallowed either way, so deleting the guard left every suite green.

Each fix reproduced the defect it was fixing. Mutation is the only thing that
caught any of them.

## Facts worth not re-deriving

- **The narrowing is CORRECT and verified against driver source.** Every reachable
  error class carries a string `code` — `PostgresError`, `57014`, postgres.js
  `CONNECTION_*`, Node `ECONNREFUSED`/`EPIPE`/`ETIMEDOUT`. Nothing transient
  escapes, so it cannot resurrect the connect outage. `DOMException` has a numeric
  code, but postgres.js 3.4.9 does not produce them for query timeouts (its
  cancellation path is `57014`). Codex session `019fdfbb-e197-7f32-a4c0-5538f8c5c6bb`.
- **Do NOT change the narrowing to `instanceof postgres.PostgresError`.** The
  standards axis recommended it; the driver taxonomy shows it would rethrow a
  transient blip straight into `finalizeConnectionTx` and reintroduce the outage.
  A lost connection independently rejects the enclosing `begin`, so swallowing it
  locally cannot manufacture a quiet success. D38 records the resolution.
- **The race fix is load-bearing and mutation-verified.** `guardImportConsent` must
  keep `sql.begin` + `SELECT … FOR UPDATE` + `markOutboxCompleted(tx, …)`. Lock
  order is business-before-outbox, matching all four other writers; `OutboxPoller`
  takes only `job_outbox` with `SKIP LOCKED` and cannot deadlock against it.
- **A JS throw does not poison a Postgres transaction** — abort injections must be
  Postgres-side. **One deliberate exception**: D37's code-less test injects a JS
  `TypeError` on purpose, because it asserts the rethrow *propagates* rather than
  that the caller *survives*. Documented at the injection site; do not "fix" it back.
- **`add-location-tx.ts` is NOT a `createImportOffer` producer.** The three real
  ones are `finalize-tx.ts:208`, `worker/ingress/stripe/shared.ts:159`, and the GET
  self-heal in `src/app/api/dashboard/import-offer/route.ts`.
- **`TEST_DATABASE_POOL_URL` does not auto-resolve in an interactive shell** —
  export it from `.env.local` or live-DB suites silently skip. The gate resolves it.
- **Do not run `pnpm test:db:setup`** — it drops schema `public`. Migration 102 is
  already applied to the local `repworth-testdb` container.
- **`reclassify` WARN is expected**, re-checked four times (latest: prod 507, test
  2305 vs estimates 230/700). Step 0 re-run each time → **same lane**. Growth is
  review-driven hardening plus a metric that counts comment lines as production. Do
  not "fix" it by editing the estimate.
- **`.claude/CLAUDE.md` cites a nonexistent "ADR 0015 R2"** (the ADR has §§1–4;
  R2 is spec §8a:301). Post-merge sweep, not here.
- **Spec §5/§5.3 say three enqueue producers; source has four.** Out of surface —
  post-merge sweep (deviation D8).

## Filed, NOT fixed here — do not reopen on this branch

- **#694** — `ci:live-db-suites` R2 DDL detector keys on an incidental marker; misses 2 pre-existing sites. `scripts/**` out of surface.
- **#695** — enforce consent at the `job_outbox` insertion boundary instead of per-worker; give the guard a durable policy-block reason. Both challenge decisions locked at #670.
- **#696** — `verify-gate.sh:193` truncates row slugs to 40 chars; colliding rows share a status file and can report PASS for a failed suite. Worked around here by a rename (D30).
- **#697** — a swallowed analytics emission reaches no durable or paged sink. The savepoint traded a loud failure for a quiet one; this is the missing half.

## REMAINING WORK — step 8, RISK = high lane

1. Apply migration 102 to the **staging** Supabase project first.
2. Push branch to `staging`; full stack auto-deploys (Railway worker + Vercel staging).
3. Smoke: a hand-inserted `zernio_initial_backfill` row for a `pending` business
   no-op-completes with the block log line and mints **no** `zernio_backfill_runs`
   row; an `accepted` business still imports; both events land in `analytics_events`.
4. PR → `main`, all CI green, then **PAUSE for owner merge approval**.
5. Apply 102 to **prod** Supabase in lockstep at promotion, **before** the emitting
   code is live. The savepoint contains the blast radius; it does not make the
   ordering optional.
6. After merge: `git pull --ff-only` on `main`, fast-forward `staging`,
   `bash scripts/feature-cleanup.sh` (dry run first), `document-feature` sweep,
   domain sweep, entropy counter.

## Process lessons — promote to lab notes at step 8

1. **Mutation is the only reliable detector of false coverage.** Every one of the
   ~10 instances on this branch was caught by mutation; none by reading. A fix for
   an untested-guard finding must itself be mutation-pinned, or it reproduces the
   defect — which happened twice here, in consecutive rounds.
2. **Narrowing an over-wide `catch` is not a local change.** It converts every
   latent swallow into a live failure. Blast radius is "every mock standing in for
   the narrowed type", discoverable only by running the FULL suite. Budget a
   surface amendment per incomplete mock, or scope it as a type-level fix.
3. **A `file.ts:NNN` citation into a file the SAME commit edits is stale before it
   is committed.** Three stale-citation findings across three rounds. Cite by test
   title or symbol when the target moves with you.
4. **The `codex:codex-rescue` plugin path is unreliable** — the companion launched a
   job then recorded none, and the subagent is forward-only so it cannot poll or
   write up a result. Direct `codex exec -s read-only -C <worktree>` is the working
   lane. Also: **this repo's Stop hook fires INSIDE the codex session**, so
   `codex exec -o <file>` captures codex's reply to the hook, not its report —
   read the run log instead. (D35)
5. **Parallel subagents in ONE worktree make git hooks unusable** — lefthook operates
   on the whole tree while each agent owns only its staged subset.
6. **A concurrently-editing orchestrator is as much a sibling as another subagent.**
   Dispatching an agent with "no sibling is running" and then editing under it is
   the same hazard; one agent caught the drift itself and re-verified.
7. **A review agent whose mutation Edit is permission-denied is still worth running** —
   round 3's sharpest finding was a static inference the agent flagged as unverified,
   and it was correct. But the harness should grant review agents mutate-and-revert
   rights, or they will keep hedging findings they cannot execute.
8. **A subagent once tunnelled a classifier-blocked DDL command through a throwaway
   test file.** Payload benign, no repo residue, but the method is a permission
   bypass. Rejected as guidance; the underlying permission gap is an open question
   for the owner.
