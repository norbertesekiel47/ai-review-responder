# Handoff — #1183 Admin transport seam

A resumed session bootstraps from this file. It references everything BY PATH and
restates none of it.

## What this is

GitHub issue **#1183**, "Build the Admin transport seam and make
`requireAdminWithAal2` dual-mode", cut from decision #1161 on map **#1159** (the
admin split). Run as one `/feature` pipeline in a sibling worktree, dispatched by
the admin-split orchestrator session.

- Worktree: `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1183-admin-transport-seam`
- Branch `feat/1183-admin-transport-seam`, forked from `main` at `4aa132ba`
- Classification: **SIZE = standard, RISK = high, SURFACE = backend**, `db_touching: false`

## Read in this order

1. Intake (locked, armed): `docs/superpowers/plans/feat-1183-admin-transport-seam-intake.json`
   (audit copy) and `.feature/intake.json` (arming copy) — kept identical.
2. Plan: `docs/superpowers/plans/feat-1183-admin-transport-seam-plan.md`, including
   its **Review appendix** (the Codex plan-skeptic dispositions).
3. Deviations: `docs/superpowers/plans/feat-1183-admin-transport-seam-deviations.md`
4. Design of record: `docs/adr/0025-dual-mode-admin-gate.md` D1–D4, D9, D10; D7 is
   amended by `docs/adr/0026-admin-api-cors.md` D7. Also `docs/adr/0024-admin-app-split.md`.
5. Orchestrator handoff: `docs/superpowers/plans/2026-09-08-admin-split-orchestrator-handoff.md`
   §3 (L1 row) and §4.
6. Glossary: `docs/context/core-accounts-channels-admin.md` → **Admin transport**,
   **Verified admin**, **Channel actor**.
7. Research (facts, not design): `docs/research/admin-bearer-auth.md` on branch
   `research/admin-bearer-auth`, checked out at
   `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/research-admin-bearer-auth`
   — read-only, never edit it.

## Sign-off provenance

Intake sign-off is **INHERITED from the ticket body plus ADR 0025**, per the
orchestrator handoff §4 ("the ticket IS the locked intent — grill only deltas").
The owner is not reachable from this session. No owner sign-off was solicited and
none was assumed. Deltas were resolved from source and recorded in the intake's
`edge_cases` and the plan's contract sections; open owner questions, if any, go in
the final report rather than being decided here.

## Codex plan-skeptic session ids

- Round 1 (full, eval-first): `01a07ec1-2cea-75f3-bcb4-aac113e41fbb` — `VERDICT: REVISE`,
  11 substantive findings. Transcript `.feature/logs/codex-plan-round1-report.md`.
- Round 2 (verification-only): RESUMED from that same id
  (`codex exec --sandbox read-only --json --cd <root> resume <id> "<delta>"` — note
  the flag order; `resume` must follow the flags or the CLI rejects `--sandbox`).
  Transcript `.feature/logs/codex-plan-round2-report.md`.

A branch-review round in step 7 resumes the ADVERSARIAL axis's own session id, not
this one.

## Binding non-goals (from the ticket, restated here only because they gate the diff)

No route file changes (#1184) · no `src/proxy.ts` and no CSRF change (#1185) · no
CORS (#1186) · `requireRole` stays cookie-only · `MFA_ENFORCEMENT_ENABLED` is never
read in the seam or the gate · `scripts/ci/admin-aal2-audit.ts` untouched · no
migration, flag, env var, dependency, or production write.

## Surface amendments

**One**, recorded (`surfaceAmendments=1`): the 22 admin route suites that mock the
gate's current dependencies by name, plus `src/lib/db/__tests__/auth.test.ts`. Test
fixtures only — no `route.ts` and no audit changes. Rationale and the enumeration
command are in the plan, § "T5 is a surface amendment, not scope creep". **A second
amendment is a hard stop** — report to the orchestrator instead.

## Step 8 authority (granted in the orchestrator brief)

Ride staging from the shared worktree
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/staging-ride`
(`git pull --ff-only origin staging` → `git merge --no-ff feat/1183-admin-transport-seam`
→ `git push origin staging`; other tickets ride in parallel, so retry on rejection).
Smoke `https://staging.repworth.net`. Then `gh pr create --draft` → red-team-status
→ `gh pr ready` → `gh pr checks --watch` → **STOP**. Do NOT merge. Do NOT post the
ticket resolution comment (the orchestrator does that after merge); a progress
comment with the PR link and staging evidence is allowed.

## What the next runs need from this one

#1185 and #1186 import from this branch. The exported names they depend on:

- `src/lib/auth/admin-transport.ts` → `isBearerRequest(request)`,
  `readBearerToken(request)` — Edge-safe, no `node:` import, no DB.
- `src/lib/auth/verified-identity.ts` → `resolveCookieIdentity(request)`,
  `resolveDualModeIdentity(request)`, type `VerifiedIdentity`, type `AdminTransport`.

Recorded verbatim in the final report to the orchestrator.
