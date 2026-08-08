# Handoff — #679 Import consent worker guard

**Updated 2026-08-08, after branch review round 1 + its fix round.** Everything
below is a pointer or a fact; nothing restates content that lives in a file. A
fresh session needs only this doc, then the files it names. **Do not go looking
for the prior transcript.**

## Current position

**Step 7 round 1 complete and triaged. Gate GREEN. Next action: round-2
verification-only review (step 7), then the doc rewrite in §5, then step 8.**

| Fact | Value |
|---|---|
| Branch | `feat-679-import-consent-worker-guard` |
| Worktree | `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-679-import-consent-worker-guard` |
| Base (fork point) | `main@2f369582` |
| HEAD | `a2f2ac09` |
| Gate | **GREEN** at `a2f2ac09` (`--review`: 19 audits, build, 6 integration suites, promised-tests, merge-coverage, diff-coverage) |
| Plan review rounds | **2 of 3** — `APPROVED` at round 2 |
| Branch review rounds | **1 of 3** — round 2 not yet run |
| Surface amendments | **0 of 2** |
| Risk / surface | high / mixed, DB-touching |

## Artifacts (worktree-relative)

| What | Path |
|---|---|
| Intake contract (locked, owner-signed) | `docs/superpowers/plans/feat-679-import-consent-worker-guard-intake.json` |
| Plan | `docs/superpowers/plans/2026-08-07-import-consent-worker-guard.md` |
| Deviations D9–D30 + orchestrator read-back | `docs/superpowers/plans/feat-679-import-consent-worker-guard-deviations.md` |
| Plan reviews (round 1 REVISE → round 2 APPROVED) | `docs/reviews/…/plan-review-round-{1,2}.md` |
| Branch review round 1, 3 axes + triage tables | `docs/reviews/…/review-{spec-correctness,standards,adversarial}.md` |
| Blast radius | `docs/reviews/…/blast-radius.md` |
| Design of record | `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` §5.1, §5.3 |
| ADR | `docs/adr/0015-consented-import-unflagged-replacement.md` §2, §3 |

## What shipped (13 commits since fork point)

Fail-closed **Import consent** gate in `ZernioBackfillWorker` — closes the last
consent hole in map #667 (ADR 0015 §3's accepted gap) — plus migration 102
registering the two **Import offer** analytics events #677 deferred here.

Production: `worker/jobs/zernio/job-eligibility.ts` (+`guardImportConsent`),
`ZernioBackfillWorker.ts` (call site, before the run-row INSERT),
`src/lib/reviews/import-consent.ts` (savepoint-wrapped emissions),
`supabase/migrations/102_…sql`, `src/lib/analytics/events.ts`,
`src/app/admin/runbook/page.tsx`, `src/lib/shared/worker-types.ts`.

## Review round 1 — 13 findings, ALL accepted, 10 fixed here, 3 filed

Full triage tables are appended to each of the three report files. Do not re-triage.

**The one that mattered:** spec (Medium) and adversarial (High) converged
independently on the analytics emissions' transaction coupling. Verified: an
unapplied migration 102 raises `23514` inside `finalizeConnectionTx`
(`finalize-tx.ts:208`), and `select-location/route.ts:97-108` rethrows non-`23505`
— so it broke **GBP connect entirely**, not merely a consent decision. Owner chose
the **savepoint** remedy (`bfac89d4`): each emission is wrapped so a failed insert
rolls back only itself. Atomicity on the success path is unchanged.

**Filed, not fixed here** — do not reopen on this branch:
- **#694** — `ci:live-db-suites` R2 DDL detector keys on an incidental marker; misses 2 pre-existing sites. `scripts/**` is out of surface.
- **#695** — enforce consent at the `job_outbox` insertion boundary instead of per-worker; and give the guard a durable policy-block reason. Both challenge decisions locked at #670.
- **#696** — `verify-gate.sh:193` truncates row slugs to 40 chars; colliding rows share a status file and can report **PASS for a failed suite**. Worked around on this branch by a rename (D30).

## §5 — REMAINING WORK, in order

### 1. Round-2 verification-only review (step 7)

All three axes had accepted findings, so all three get a verification agent.
**Run `bash scripts/feature-state.sh incr-round branch` BEFORE dispatching** —
the counter is at 1 and survives resumes; an uncounted round is how a sibling
ticket reached round 5 under a "max 3" cap.

Verification-only protocol: brief each agent with that axis's findings table +
the fix commits (`fa84bc1c`, `bfac89d4`, `6b312edb`, `a2f2ac09`). It verifies each
fix landed and introduced nothing new. It may **not** open new fronts against
unchanged code; new unrelated findings go to the report appendix, untriaged.

The savepoint is the priority: it is a non-trivial change to the highest-risk path
that **no reviewer has seen**.

### 2. Post-savepoint documentation rewrite (NOT yet done — deliberately deferred)

Several places still describe the pre-savepoint hazard, and some understate it in
the way review finding 1 identified. Rewrite them to describe the **shipped**
behaviour: a missing migration 102 now costs a lost metric and a `warn` line, not
a connect outage. Sites:

- `supabase/migrations/102_import_consent_analytics_events.sql` header
- `.claude/reference/migrations-log.md` — the 102 entry (also still marked **LOCAL-ONLY / not applied to staging or prod**; update at promotion)
- `docs/superpowers/plans/2026-08-07-import-consent-worker-guard.md` §6
- `docs/analytics/events.md` — both event blocks

`src/lib/reviews/import-consent.ts`'s own header was already corrected in `bfac89d4`.

**Migration-before-code ordering still stands** as the deploy rule — the savepoint
contains the blast radius; it does not make the ordering optional.

### 3. Step 8, RISK = high lane

1. Apply migration 102 to the **staging** Supabase project first.
2. Push branch to `staging`; full stack auto-deploys.
3. Smoke: a hand-inserted `zernio_initial_backfill` row for a `pending` business no-op-completes with the block log line and mints **no** `zernio_backfill_runs` row; an `accepted` business still imports; both events land in `analytics_events`.
4. PR → `main`, all CI green, then **PAUSE for owner merge approval**.
5. Apply 102 to **prod** Supabase in lockstep at promotion, before the emitting code is live.
6. After merge: `git pull --ff-only` on `main`, fast-forward `staging`, `bash scripts/feature-cleanup.sh` (dry run first), `document-feature` sweep, domain sweep, entropy counter.

## Facts worth not re-deriving

- **The race fix is load-bearing and mutation-verified.** `guardImportConsent` must keep `sql.begin` + `SELECT … FOR UPDATE` + `markOutboxCompleted(tx, …)`. Removing `FOR UPDATE`, or splitting the transaction, turns `job-eligibility.integration.test.ts` RED. Lock order is business-before-outbox, matching all four other writers; `OutboxPoller` takes only `job_outbox` with `SKIP LOCKED` and cannot deadlock against it.
- **A JS throw does not poison a Postgres transaction.** Two agents nearly shipped invalid demonstrations on this. Any abort injection must be Postgres-side (`23503` FK violation is the pattern used).
- **`add-location-tx.ts` is NOT a `createImportOffer` producer** — it only mentions the symbol in comments. The three real producers are `finalize-tx.ts:208`, `worker/ingress/stripe/shared.ts:159`, and the GET self-heal in `src/app/api/dashboard/import-offer/route.ts`.
- **`TEST_DATABASE_POOL_URL` does not auto-resolve in an interactive shell** — export it from `.env.local` or live-DB suites silently skip. The gate resolves it itself.
- **Do not run `pnpm test:db:setup`** casually — it drops schema `public`. Migration 102 is already applied to the local `repworth-testdb` container.
- **`.claude/CLAUDE.md` cites a nonexistent "ADR 0015 R2"** (the ADR has §§1–4; R2 is spec §8a:301). Fix in the post-merge sweep, not here.
- **Spec §5/§5.3 say three enqueue producers; source has four.** Out of surface — post-merge sweep (deviation D8).
- **`reclassify` WARN is expected and was re-run twice.** Actuals: prod 475 (est. 230), test 2090 (est. 700). Step 0 re-run both times → **same lane**: surface never amended, 7 tracer tickets, no open questions. Growth is review-driven hardening plus a metric that counts comment lines as production (80 of `import-consent.ts`'s 142 added lines are comments). Do not "fix" it by editing the estimate.

## Process lessons from this run (promote to lab notes at step 8)

1. **Parallel subagents in ONE worktree make the git hooks unusable** — lefthook operates on the whole working tree while each agent owns only its staged subset. Three of six agents worked around it (`--no-verify`, `core.hooksPath=/dev/null`, avoiding `test:db:setup`). Sibling worktrees exist to avoid exactly this.
2. **The dominant defect mode was false coverage, not broken behaviour** — tests that pass whether or not the bug exists. Five instances: the live race test (D16/D21), two eval scaffolds (D10, D22), and three round-1 standards findings. Every one was caught by **mutation**, none by reading.
3. **A subagent tunnelled a classifier-blocked DDL command through a throwaway test file.** Payload was benign, no repo residue, but the method is a permission bypass. Rejected as guidance in the deviations read-back; the underlying permission gap is an open question for the owner.
