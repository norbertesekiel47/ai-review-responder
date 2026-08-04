# Handoff — feat-645-manual-suppression-paths

Ticket **#645** (wayfinder map #617): manual suppression paths — admin entry,
audited correction, owner do-not-contact. **RISK = high · SURFACE = mixed ·
db_touching = true.**

A resumed session bootstraps from THIS file. It never needs the prior
transcript. Everything below is a path, not a restatement.

## Where state lives

| What | Path |
|---|---|
| Machine phase record | `.feature/state.json` (read this FIRST) |
| Locked intake contract | `.feature/intake.json` (arming copy) · `docs/superpowers/plans/feat-645-manual-suppression-paths-intake.json` (committed audit copy) |
| Implementation plan | `docs/superpowers/plans/2026-08-03-645-manual-suppression-paths.md` |
| Deviations + triage verdicts | `docs/superpowers/plans/feat-645-manual-suppression-paths-deviations.md` |
| Review reports | `docs/reviews/feat-645-manual-suppression-paths/` |
| Gate status | `.feature/gate-status.json`, logs in `.feature/logs/` |

## Source documents (read the slice, not the whole file)

| What | Path |
|---|---|
| Design of record, §7 manual paths + §8 no-re-subscribe | `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md` (lines 570–690) |
| Glossary — the eight locked terms | `CONTEXT.md` → "Solicitation suppression & unsubscribe — locked 2026-07-28 (ticket #621)" |
| Ledger core being deepened | `src/lib/solicitation/suppression.ts` |
| Ledger schema | `supabase/migrations/096_solicitation_suppressions.sql` |
| Ticket body | `gh issue view 645` |

Use glossary terms **verbatim** in every artifact: Suppression ledger ·
Suppression scope · Normalized handle · Correction path · Consent ledger ·
Attestation never overrides suppression.

## The one decision that overrides the ticket

The ticket's non-goals say "No migration." That is amended, with owner sign-off
(2026-08-03): the §8.2 audit record has **no existing sink that accepts an
account-less row** — `account_audit_log.account_id` is
`NOT NULL REFERENCES accounts(id) ON DELETE CASCADE`, and the two cases §8.2
names as its reason to exist (an admin typo on a mailbox reply, a
`provider_suppressed` mirror from the transactional side) both carry
`account_id = NULL`. Migration **098** adds
`solicitation_suppression_corrections`. The other seven locked decisions are in
the plan's "Decisions this plan locks" table (D-1 … D-8).

## Task graph

`T1 (eval) → {T2 migration, T3 display seam} → {T4 admin, T5 owner} → {T6 admin UI, T7 owner UI} → T8 docs`

Mutually independent, parallel-dispatchable: (T2, T3), then (T4, T5), then
(T6, T7). T1 always runs alone — its completion is the enforcement spot check
(diff `git status --porcelain` against `allowed_edit_surface`; an out-of-surface
path means the guard did not bind for subagent tool calls → STOP).

## Review ledger — COMPLETE

| Round | Kind | Verdict | Report |
|---|---|---|---|
| plan 1 | Codex adversarial, eval-first + cited-artifact check | **REVISE** → triaged + applied in `711575f4` | `plan-review-round1.md` (triage table appended) |
| plan 2 | Verification-only | **stopped before output** — closed by owner call; the three design-changing fixes were instead verified directly (schema introspection, the real detector regexes, live-Postgres execution of the CTE) | — |
| branch 1 | spec · standards · adversarial, parallel | 11 accepted, 3 rejected | `branch-review-{spec,standards}.md`, `codex-adversarial-approach-review.md` |
| branch 2 | verification-only, per axis | spec + standards clean; adversarial **REVISE** on one residual, fixed in `0aead24b` | `branch-review-{spec,standards}-round2.md`, `branch-review-adversarial-round2.md` |

**Triage verdicts for every finding: `docs/reviews/feat-645-manual-suppression-paths/TRIAGE.md`.**

Counters in `.feature/state.json`: `planReviewRounds=2`, `branchReviewRounds=2`.
Always `bash scripts/feature-state.sh incr-round <kind>` BEFORE dispatching a
review wave; never restart the count.

## All eight tasks landed

`T1` eval · `T2` migration 098 · `T3` display seam · `T4` admin service+routes ·
`T5` owner paths · `T6` admin console · `T7` owner surface · `T8` docs — plus
five review-fix commits. Gate GREEN at every checkpoint; the `reclassify` row
WARNs by design (owner decision, D-A10).

## Step 8 SHIP — in progress (2026-08-04)

**Done:**

1. ✅ **`main` merged in.** `5f285125` (#658 admin console Phase 3) had landed
   while the branch sat at `gate_green`. D-A2's predicted conflict on
   `tenant-scope-allowlist.ts` did **not** happen (append-only handling held);
   the one content conflict was `docs/directory.md`. Two real defects surfaced
   and were fixed — see **D-A12** and the `formatAdminDateTime` commit.
2. ✅ **Migration 098 applied to staging** (`kubdiqdhqbhwmqfditeg`), verified by
   schema introspection. The migrations-log **LOCAL-ONLY marker is removed** —
   the immutability guard is now ARMED, correctly: staging holds the schema, so
   098 must never be edited in place. Prod is explicitly called out as unapplied.
3. ✅ **Pushed to `staging`** — fast-forward `5f285125..5749c826`. Railway staging
   worker redeployed clean (`repworth-worker-staging.up.railway.app`, Success).
4. ✅ **DB-half smoke against real staging Postgres** — the shipped
   `correctSuppression` CTE run verbatim: correct → `corrected` with the D-A11
   evidence trio and `created_by_user_id ≠ removed_by_user_id`; replay → 0 rows /
   `not_found` / **no orphan**; tab-only reason → CHECK rejects **and the
   suppression survives** (the D-A4 property `length(btrim(...)) > 0` would have
   missed). Smoke data removed; both tables verified back to 0 rows.
5. ✅ **PR #659 opened** to `main`.

**Remaining:**

6. ⏸️ **UI-half smoke needs an AAL2 admin session** — the `/admin/suppressions`
   lookup → manual entry → correction ritual, and the owner mark/clear on
   `/dashboard/requests/contacts`. Route *deployment* is verified (302 not 404 on
   all five; POST lookup returns 401 unauthed, so the gate is live and the
   handler exists), but the click-through ritual has NOT been exercised. This is
   the one gap in the staging evidence — do not describe the smoke as complete.
7. ⏸️ **Confirm CI green on #659**, then **PAUSE for explicit merge approval**.
8. ⏸️ At promotion: apply 098 to prod Supabase (`udeyaqnvpojbwgoaxwdg`) in
   lockstep, then add `PRODUCTION <date>` to the 098 migrations-log entry.
9. **Merge order is fixed: #645 → #656** (D-A3 — #656 renumbered its migration to
   099 on the understanding this branch lands first).

## Follow-ups to promote after merge (step 8 sweep)

- **Harness bug (D-A9):** `verify-gate.sh` truncates suite keys to ~40 chars, so
  two suites in one directory sharing a prefix collide on one coverage directory
  and fail with an ENOENT race. Worked around by renaming; the sanitizer should
  hash or use the full path, and a collision should be a loud error.
- **Estimate lesson (D-A10):** an admin console client with lookup + entry + a
  confirmed destructive action runs 400–550 lines, not ~230; "add a control to an
  existing list component" must be estimated as a refactor of that component.
- **Process lesson:** run the gate between parallel task batches, not only at the
  end — T3's stale allowlist snippet was found by T4 as "already red on arrival".
- **Deferred finding:** `PRIMARY_BUTTON` is a fifth copy of the admin
  primary-button recipe; belongs in `src/components/admin/ui/` once
  `admin-console-phase3` has merged.
- **`.claude/CLAUDE.md`** suppression row should point at `channels-rollout.md` §6
  so the §7.2 servicing contract is discoverable from the index.

## Standing constraints for any session picking this up

- Every Bash call prefixed `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths && …`; every Edit/Write an absolute path inside that worktree. Inspect the parent checkout with `git -C`, never a bare `cd`.
- Repo file changes go through Edit/Write only — no `sed -i`, no shell redirects over repo files.
- Cross-worktree conflict on `scripts/ci/tenant-scope-allowlist.ts` with `admin-console-phase3`; handling agreed in the deviations file (D-A2). `src/components/admin/ui/DataTable.tsx` is that worktree's — read, never modify.
- Surface amendments used: **1 of 2** (D-A1). A second one fires the abort criteria.
- `pnpm test:db:setup` is the gate's job, never a `verification_commands` entry.
- Ship lane: RISK = high → staging ride first, migration to staging Supabase first, then PR to `main` and PAUSE for explicit merge approval; prod migration applies in lockstep at promotion.
