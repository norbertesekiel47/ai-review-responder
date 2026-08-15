# Handoff — `admin-invite-funnel`

**Read this first, then the files it names. Do not re-read any prior transcript.**

Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/admin-invite-funnel`
Branch: `admin-invite-funnel` · PR **#821** → `main` · also deployed to `staging`

## Where we are

Implementation is **complete and proven on staging**. All 12 plan steps shipped. The full **Admin invite** journey was walked end to end by the owner: 3-field admin form → invite → password → place capture → AI demo → **$0 checkout with a card collected** → wizard → dashboard, with the **Account** `active`.

| Thing | State |
|---|---|
| Local verify gate | GREEN (`scripts/verify-gate.sh`) |
| PR #821 CI | was green before the last 2 commits — **re-check** |
| Staging deploy | READY at branch HEAD |
| Migrations 105 + 106 | applied to staging Supabase, verified |
| Phase F smoke | **PASS** — evidence in `docs/runbooks/evidence/2026-08-14-admin-invite-funnel-staging.md` |
| Deviations D-1..D-16 | all triaged; **D-11 owner-APPROVED** |

## What remains — in order

### 1. Step 7 review (owner asked for this explicitly)
Not yet run. Given this branch produced 3 CI failures and 1 live staging bug, it is worth the round. Run per `/feature` step 7:

- `bash scripts/blast-radius.sh` first → writes `docs/reviews/admin-invite-funnel/blast-radius.md`
- `bash scripts/feature-state.sh incr-round branch` **before** dispatching
- Three parallel agents (RISK=high): spec & correctness · standards/maintainability (`/thermo-nuclear-code-quality-review`, fall back to `/code-review` high) · adversarial approach (`/codex:adversarial-review --background --base <fork-point>`)
- Every agent gets `.feature/intake.json` **and** the triaged deviations file. The spec agent also gets `blast-radius.md`.
- Full reports to `docs/reviews/admin-invite-funnel/`; only findings tables come back. **Commit the reports.**
- Triage, fix, re-run the gate, then `bash scripts/feature-state.sh set-phase reviewed`

**Point the reviewers at D-16 specifically.** It is the highest-signal defect on the branch: a plan claim that was false, survived four adversarial rounds, and was asserted-as-correct by a unit test. Ask whether anything else on the branch rests on a similarly unverified provider-contract assumption.

### 2. Resend-invite verification (D-13) — still a guess
`INVITE_ERROR_CODE_MAP` in `src/lib/onboarding/resend-invite.ts` was written **without** a real Supabase response; its header says `CONTRACT NOT YET VERIFIED — staging-verify before prod`. On staging: create an **Admin invite**, resend before acceptance (expect success), then resend after acceptance (expect a clean refusal, not a duplicate email). Correct the map to match, or confirm it.

### 3. Merge PR #821, then re-align `staging` to `main`
Per `deployment-guide.md` §"Re-sync staging": after a squash merge the branches have diverged, so `git reset --hard origin/main` + `--force-with-lease`. **Do not sync-merge** (that is the #719 drift).

### 4. Post-merge sweep
- Promote D-15 and D-16 lessons into `.claude/reference/lab-notes.md` / CLAUDE.md gotchas (see "Lessons to promote" in each entry)
- `document-feature` skill; domain sweep into `CONTEXT.md`
- `bash scripts/feature-cleanup.sh` (dry run first)
- Increment the merge counter in `.claude/reference/arch-review-log.md`

## Do NOT do

- ~~**Do not apply migration 105 to production.**~~ **Resolved 2026-08-14 (#825): 105 IS applied in prod.** The instruction rested on 077 being absent there; the migration lockstep audit found 077 already applied, so 105's only blocker was gone and it was applied to restore lockstep. **Do not apply migration 078** — that is now the sole migration held for the WS8 cutover (`docs/runbooks/ws8-tier-cutover.md` §7).
- Do not set production env vars, do not create the live-mode Stripe coupon (this session had no live-mode access anyway), do not flip `ONBOARDING_DEMO_ENABLED` in prod. All are deliberate, owner-timed steps.

## Context the files do not carry

- **Vercel env values are `type: sensitive`** on this project — write-only. The API returns `''` for every read, so a flag flip can only be confirmed **behaviourally** (e.g. `/onboarding/start` 404 = demo off, 307→/login = demo on). Budget for that; do not chase "empty" readings.
- **`vercel env add` silently stored empty values** on CLI 54.6.1 for the custom `staging` environment. Values were set via the Vercel REST API instead. Always verify after writing.
- **`ONBOARDING_DEMO_ENABLED` is Vercel-only** — 15 read sites under `src/**`, zero under `worker/**`. A Railway flip does nothing.
- 4 integration suites fail **locally** (`demos/lifecycle`, `migration-056-account-offboarding`, `response-status-sql`, `autopilot-entitlement-concurrency`) with `ECONNREFUSED :5432`. They resolve a different DB than the local container and **pass in CI**. Not regressions.
- The local gate only runs live-DB suites for **changed** integration files. A migration that alters a table's column set must run the full sweep: `pnpm vitest run --project integration` with `TEST_DATABASE_POOL_URL` set. This is how D-15 escaped locally.

## Key files

| Purpose | Path |
|---|---|
| Intake contract (the drift detector) | `docs/superpowers/plans/admin-invite-funnel-intake.json` |
| Plan of record + ticket decomposition | `docs/superpowers/plans/2026-08-14-admin-invite-funnel.md` |
| Why each decision is what it is (4 rounds) | `docs/superpowers/plans/2026-08-14-admin-invite-funnel-review-log.md` |
| Flag-gate inventory (per-site replacement guards) | `docs/superpowers/plans/2026-08-14-admin-invite-funnel-flag-inventory.md` |
| **Deviations D-1..D-16, all triaged** | `docs/superpowers/plans/admin-invite-funnel-deviations.md` |
| Staging proof | `docs/runbooks/evidence/2026-08-14-admin-invite-funnel-staging.md` |
