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

## Review ledger

| Round | Kind | Verdict | Report |
|---|---|---|---|
| plan 1 | Codex adversarial, eval-first + cited-artifact check | _pending_ | `docs/reviews/feat-645-manual-suppression-paths/plan-review-round1.md` |

Codex session id: _recorded on completion of round 1._

Counter lives in `.feature/state.json` (`planReviewRounds`, `branchReviewRounds`)
and survives a resume — always `bash scripts/feature-state.sh incr-round <kind>`
BEFORE dispatching a review wave, never restart the count.

## Standing constraints for any session picking this up

- Every Bash call prefixed `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-645-manual-suppression-paths && …`; every Edit/Write an absolute path inside that worktree. Inspect the parent checkout with `git -C`, never a bare `cd`.
- Repo file changes go through Edit/Write only — no `sed -i`, no shell redirects over repo files.
- Cross-worktree conflict on `scripts/ci/tenant-scope-allowlist.ts` with `admin-console-phase3`; handling agreed in the deviations file (D-A2). `src/components/admin/ui/DataTable.tsx` is that worktree's — read, never modify.
- Surface amendments used: **1 of 2** (D-A1). A second one fires the abort criteria.
- `pnpm test:db:setup` is the gate's job, never a `verification_commands` entry.
- Ship lane: RISK = high → staging ride first, migration to staging Supabase first, then PR to `main` and PAUSE for explicit merge approval; prod migration applies in lockstep at promotion.
