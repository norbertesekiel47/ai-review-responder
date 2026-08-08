# Handoff — #680 DROP the legacy backfill counters (migration 103)

**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-680-drop-legacy-backfill-counters`
**Branch:** `feat-680-drop-legacy-backfill-counters` · base `origin/main` @ `e447ee5b`
**Current step:** 3 (PLAN) — codex adversarial round 1 in flight. NOT yet approved, NOT yet executing.

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
| planReviewRounds | 1 |
| last green gate | `48da529c` — **docs-only checkpoint**, NOT step-5 evidence |
| commits | `8cc09294` staging evidence · `48da529c` plan |

The green gate on record ran in `docs_only` mode: `test`, `build`, `promised-tests`, `reclassify`
and `diff-coverage` were all SKIPPED because the diff is docs-only. It unblocks the stop hook for a
mid-feature checkpoint and proves nothing about implementation. Step 5 requires a full gate with
`TEST_DATABASE_POOL_URL` set.

## Codex plan review round 1

Brief: `<scratchpad>/codex-plan-brief-680.md` · raw output: `<scratchpad>/codex-plan-review-680.jsonl`
(scratchpad = `/private/tmp/claude-501/-Users-norbertesekiel-Developer-startups-RepWorth/5b028bd8-6c58-4513-86fd-88aee023ee5e/scratchpad`)
Run as `codex exec --sandbox read-only --json`. **Verdict pending at time of writing** — if this file
still says pending, re-read the jsonl tail for `VERDICT: APPROVED` / `VERDICT: REVISE` before acting.

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
- Every plan citation was independently verified on disk.
- Staging has 2 backfill runs / 58 imported; prod has 0 rows, 0 businesses.

## Next actions

1. Read the codex verdict. On `REVISE`, revise the plan and re-submit ONLY the findings-and-fixes
   delta (rounds 2–3 are verification-only). After round 3, surface remaining disagreement to the owner.
2. On `APPROVED`: `bash scripts/feature-state.sh set-phase plan_approved`, update this file, then
   execute T1 → T2 → T3 **in this session** (owner decision: no per-task subagent dispatch; the
   tasks are serial and mechanical). Step 7 review agents ARE wanted.
3. Step 5 full gate with `TEST_DATABASE_POOL_URL` set — a SKIP row on the changed integration
   suites is not review-ready for DB-touching work (#520 class).
4. Ship high-risk lane: preflight → apply 103 to staging → ride `staging` → PR → owner merge
   approval → apply to prod in lockstep at promotion.

## Open item, NOT a blocker

Terry Business on staging carries ~24 `onboarding_drip` outbox rows in `failed`. Pre-existing,
unrelated to the import path, outside this surface. Recorded in the evidence doc; needs its own ticket.
