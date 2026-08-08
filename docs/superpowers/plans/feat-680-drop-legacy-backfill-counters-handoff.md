# Handoff — #680 DROP the legacy backfill counters (migration 103)

**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-680-drop-legacy-backfill-counters`
**Branch:** `feat-680-drop-legacy-backfill-counters` · base `origin/main` @ `431126e9` (rebased 2026-08-08)
**Current step:** 3 (PLAN) — codex round 2 **re-submitted**. NOT approved, NOT executing.

## Read these, in order — never the prior transcript

1. Intake (locked, signed off): `docs/superpowers/plans/feat-680-drop-legacy-backfill-counters-intake.json`
2. Plan: `docs/superpowers/plans/2026-08-08-feat-680-drop-legacy-backfill-counters.md`
3. Staging precondition evidence: `docs/runbooks/evidence/2026-08-08-consented-import-staging-proof.md`
4. Ticket: `gh issue view 680` — read the COMMENT too, it carries the reconciliation-preflight constraint
5. ADR `docs/adr/0015-consented-import-unflagged-replacement.md` §4 + Consequences

## State

| item | value |
|---|---|
| phase | `worktree_ready` (plan not yet approved — do not skip to executing) |
| planReviewRounds | 2 |
| last green gate | `d3af3932` — **stale** (pre-rebase) AND **docs-only**. Not step-5 evidence. |
| commits | `8cc09294`→ staging evidence · plan · round-1 triage · handoff · `eed47342` round-2 defect fixes |

The green gate on record ran in `docs_only` mode: `test`, `build`, `promised-tests`, `reclassify`
and `diff-coverage` were all SKIPPED because the diff is docs-only. It also predates the rebase, so
its SHA no longer matches HEAD. Step 5 requires a full gate with `TEST_DATABASE_POOL_URL` set.

## Rebase — 2026-08-08

Branch was 1 behind `origin/main`. `431126e9` (#695) touched **two of this feature's own target
files**, so this was not cosmetic:

- `worker/jobs/zernio/__tests__/ZernioBackfillWorker.test.ts` → `LEGACY_COUNTER_COLUMNS` citations
  moved `:218`/`:701`/`:1075` → **`:226`/`:716`/`:1090`** (plan updated).
- `docs/superpowers/specs/2026-08-05-consented-review-import-design.md` → T3's §8a R4 tick target;
  anchor re-verified at `:477` post-rebase.

ADR 0015's cleanup-migration consequence re-verified at `:131`.

## Codex plan review

scratchpad (THIS session) = `/private/tmp/claude-501/-Users-norbertesekiel-Developer-startups-RepWorth/b2dde277-c4e9-4567-96f3-aaa588cb2e70/scratchpad`
scratchpad (round 1 + killed round 2) = `…/5b028bd8-6c58-4513-86fd-88aee023ee5e/scratchpad`

**Round 1: `VERDICT: REVISE`** — 1 BLOCKER, 4 MAJOR, 5 MINOR. **All ten ACCEPTED, none rejected**,
each verified against disk. Full triage: `docs/reviews/feat-680-drop-legacy-backfill-counters/plan-review-round-1.md`.

**Round 2 (first attempt): KILLED, no verdict.** Its transcript
(`<5b028bd8>/codex-plan-review-680-r2.jsonl`) ends mid-`command_execution` with no `VERDICT:` line.
The background task that reported "completed" wrote only state bookkeeping — it contains **no review
content**. Do not mistake it for a verdict.

**Round 2 (re-submission): IN FLIGHT.** Brief `<b2dde277>/codex-plan-brief-680-r2b.md` ·
transcript `<b2dde277>/codex-plan-review-680-r2b.jsonl`. Owner decision 2026-08-08: an aborted run
that never produced a verdict does not consume a round, so **the counter stays at 2** and round 3
remains available as the last permitted round.

## Two defects fixed before re-submission (commit `eed47342`)

Both were introduced by the round-1 FIXES; the killed round-2 run had begun surfacing both.

**1. BLOCKER — the guard could not follow the `pg_temp` shadow.** The preflight's existence check
hardcoded `information_schema.columns … WHERE table_schema = 'public'`. Temp tables report their own
`pg_temp_N` schema, never `public`, so the literal made T1 **self-contradictory on one database**:
test 5 requires `public` to be post-103 (four columns absent), while test 3 requires the guard to
find `gap_processed_count` present or it early-`RETURN`s and never raises. Test 3 is the *only* test
that can prove the guard fires at all. **Fix (owner-approved):** resolve through
`to_regclass` + `pg_attribute` (`AND NOT attisdropped`) so it hits `public` in a real apply and the
replica under `SET LOCAL search_path = pg_temp, public` — tests 3–4 keep executing the migration's
own verbatim text, which is the property the F2 reversal was bought for.

**2. Test 1's statement split is now dollar-quote aware.** A naive `split(';')` shatters the
`DO $$ … $$` guard into six statements. Now: excise the guard with `/DO \$\$[\s\S]*?\$\$\s*;/` and
assert exactly one block; split the remainder into exactly two statements; run the
destructive-keyword assertions over the WHOLE `executableSql`, guard body included.

## Facts already established — do not re-derive

- **The naive preflight predicate is WRONG.** `collapsed <> legacy sums` on every row false-positives
  on healthy post-#675 rows (all four legacy counters 0, `imported_count` non-zero). Both staging
  rows flag under it. The correct gate is the two-branch disjunction in the plan and evidence doc;
  it returns **0 on staging and 0 on prod**.
- All six counter columns are `integer NOT NULL DEFAULT 0` on BOTH projects (verified live), so no
  three-valued-logic hole can hide a row from the abort count.
- **Zero production TypeScript changes.** `ZernioBackfillWorker.ts:416-418` writes only the three
  survivors; its header `:23-24` already names #680 as the dropper. Offboarding/purge treats the
  table as `scrub_in_place` touching only `zernio_account_id`/`zernio_location_id` — no counter read.
  No `SELECT *` on the table in production code.
- **Two of the ticket's four scope bullets are already discharged** (deviations, not work):
  D1 `scripts/ci/tenant-scope-allowlist.ts:2211` already holds the collapsed two-column UPDATE form
  (#675/#677 narrowed it) — 0 diff. D2 the worker sweep found no residual read.
- Staging has 2 backfill runs / 58 imported; prod has 0 rows, 0 businesses.
- T3 anchors re-verified post-rebase: spec §8a R4 `:477`, ADR 0015 `:131`, stale runbook query
  `:355-357` + comments `:359-362` + §5.2 bullets `:376-377`.

## Next actions

1. Read the round-2 verdict from `<b2dde277>/codex-plan-review-680-r2b.jsonl` (last `agent_message`).
2. On `REVISE`: revise and re-submit ONLY the findings-and-fixes delta as **round 3 — the last
   permitted round**. After it, surface remaining disagreement to the owner rather than looping.
3. On `APPROVED`: `bash scripts/feature-state.sh set-phase plan_approved`, update this file, then
   execute T1 → T2 → T3 **in this session** (owner decision: no per-task subagent dispatch; the
   tasks are serial and mechanical). Step 7 review agents ARE wanted.
4. Step 5 full gate with `TEST_DATABASE_POOL_URL` set — a SKIP row on the changed integration
   suites is not review-ready for DB-touching work (#520 class).
5. Ship high-risk lane: preflight → apply 103 to staging → ride `staging` → PR → owner merge
   approval → apply to prod in lockstep at promotion.

## Open item, NOT a blocker

Terry Business on staging carries ~24 `onboarding_drip` outbox rows in `failed`. Pre-existing,
unrelated to the import path, outside this surface. Recorded in the evidence doc; needs its own ticket.
