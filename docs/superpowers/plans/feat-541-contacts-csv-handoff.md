# Handoff — feat/541-contacts-csv (#541 Contacts/visits CSV ingestion + consent attestation)

Resume with `/feature-resume feat/541-contacts-csv` from the worktree
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-541-contacts-csv`.
Bootstrap ONLY from the files below — no prior transcript needed.

## Current step

**Step 8 (SHIP), RISK=high lane.** Phase: `reviewed` (`.feature/state.json`).
Everything before step 8 is DONE: all 9 plan tasks implemented + per-task
spec-reviewed; step 6.5 verdicts logged (no RE-PLAN); step 7 dual review
complete — 1 MAJOR + 1 MINOR (spec) and 5 standards findings, ALL fixed in
commit 5075c3b0; triage verdicts appended to both reports (committed).

## Gate status (deliberate, user-signed)

21/24 rows PASS. The three non-PASS rows are user-approved exceptions, all
documented in the deviations file: `reclassify` WARN (production code +~2.5k
within estimate; overage = tests+docs), `diff-coverage` FAIL (structural —
integration coverage unmergeable + UI-island no-test convention; gate
hardening filed as issue #563), `integration-suites` SKIP in the
env-stripped run (both suites green 4× when invoked directly with
TEST_DATABASE_POOL_URL from .env.local — do NOT export the var globally:
it wakes broken pre-existing WS8 suites inside `pnpm test`, see #563).

## Step 8 checklist (RISK=high)

1. Land the branch on `staging` (push → full stack auto-deploys).
   **Migration 086 applies to the staging Supabase project FIRST** — follow
   the `new-migration` skill's verification procedure; `.claude/reference/
   migrations-log.md` has the 086 entry (marked not-yet-applied).
2. Flag stays OFF everywhere (`SOLICITATION_WATCH_ENABLED` unset; #544 owns
   the flip). Smoke on staging = flag-off 404s + worker boots clean + (if
   flipping temporarily in staging for smoke, use the `flag-flip` skill and
   flip back): upload a small CSV, verify report + raw_csv NULLed +
   contacts/visits rows + hard delete.
3. Open PR to `main`; confirm ALL GitHub CI checks green; then PAUSE for the
   user's explicit merge approval. Apply 086 to prod Supabase in lockstep at
   promotion (standing exception note: migration 078 stays prod-absent — do
   not touch it).
4. After merge: `git pull --ff-only` on main; ff `staging` onto main;
   `bash scripts/feature-cleanup.sh` (dry-run then --apply); deviations
   promotion sweep (the file is RICH — at minimum promote: the
   "account-linked table ⇒ purge-stages + tenant-tables" lesson, the
   TEST_DATABASE_POOL_URL global-export gotcha, the enqueue-helper
   idempotency reality); `document-feature` skill; domain sweep
   (CONTEXT.md gained no new terms — verify); increment the merge counter in
   `.claude/reference/arch-review-log.md` (it was already at 5/5 —
   architecture pass is due; remind the user, do not start one).

## Authoritative artifacts

1. Intake (3 surface amendments + test-title swap, all user-approved):
   `docs/superpowers/plans/feat-541-contacts-csv-intake.json` (= `.feature/intake.json`)
2. Plan (codex-APPROVED, 3 rounds): `docs/superpowers/plans/2026-07-24-541-contacts-csv-ingestion.md`
3. Deviations + all verdicts: `docs/superpowers/plans/feat-541-contacts-csv-deviations.md`
4. Step 7 reports + triage: `docs/reviews/feat-541-contacts-csv/step7-*.md`, `blast-radius.md`
5. Contract spec: `docs/superpowers/specs/2026-07-23-contacts-csv-contract-design.md`
6. Glossary: `CONTEXT.md` § "Solicitation contacts & visits"

## Park protocol (stop-gate)

The stop gate blocks turn-ends while the gate is red (the three documented
rows keep it mechanically red). To end a turn: rename `.feature/intake.json`
→ `.feature/intake.parked.json`; rename back before the next repo edit.
Precedent throughout this run; entries in the deviations file.
