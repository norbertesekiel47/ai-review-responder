# #644 handoff — unsubscribe opt-out path

**Branch** `feat-644-unsubscribe-opt-out` · **Worktree** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-644-unsubscribe-opt-out`
**Phase at handoff:** `worktree_ready` — step 3 (plan), adversarial round 2 in flight.
**HEAD** `d8373026`

Resume with `/feature-resume feat-644-unsubscribe-opt-out`. Everything needed is on disk;
the grilling transcript is not required.

## Read these, in this order

| Artifact | Path |
|---|---|
| Intake contract (drift detector, authoritative) | `.feature/intake.json` (audit copy in `docs/superpowers/plans/feat-644-unsubscribe-opt-out-intake.json`) |
| Plan, revision 2 | `docs/superpowers/plans/2026-08-03-644-unsubscribe-opt-out.md` |
| Adversarial review round 1 + triage | `docs/reviews/feat-644-unsubscribe-opt-out/plan-adversarial-round1.md` |
| Locked spec | `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md` §5.1–5.5, §9.1–9.5, §10, DR1 |
| Glossary | `CONTEXT.md` → "Solicitation suppression & unsubscribe" |
| Ticket | `gh issue view 644` |

## State of play

- **Steps 0–2 complete.** RISK=high / SURFACE=mixed / db_touching=true. Worktree armed
  (`scripts/arm-check.sh` clean), no cross-worktree surface overlap.
- **Step 3 in progress.** Plan at revision 2. Round 1 returned **REVISE** with 7 findings;
  all 7 are folded in. Round 2 (fresh codex rescue agent) was in flight at handoff — its
  verdict must be recorded in `docs/reviews/feat-644-unsubscribe-opt-out/` before step 4.
- **Nothing implemented.** No source file has been created or modified. The only commit on
  the branch is `d8373026` (docs only).

## Owner decisions locked so far

1. Success state uses a plain form POST → 303 → `/u/<token>?done=1`; no client component
   (works with JS disabled).
2. Business name falls back to "the business that contacted you" when provenance is gone.
3. `SOLICITATION_UNSUBSCRIBE_MAILTO` is introduced by this ticket, dual-lane.
4. **Reversed after round 1:** unknown tokens fail honestly — `503` + Sentry at the
   ingress (so a #630 mint-race is recoverable via provider retry), and the human POST
   redirects to the neutral page rather than claiming a success that did not happen.
5. §5.5 vs §5.4 conflict: §5.4 wins. The **button** page names the business; the
   **success** page uses the generic sentence. Deliberate deviation from §5.5's quoted copy.

## Amendment ledger (abort criteria: a 2nd surface amendment forces a re-plan)

| # | Kind | What |
|---|---|---|
| — | behavior only | §5.5/§5.4 resolution: `user_visible_behavior`, `invariants`, `edge_cases`, `tests_to_add`. **Not** a surface amendment. |
| **1** | **surface** | Added `src/lib/shared/sentry-scrub.ts` + `src/lib/shared/__tests__/**` (round-1 finding 3 — the raw token reaches Sentry otherwise). |

**One surface amendment remains before the workflow's abort criteria fire.**

## Gate status

Last run was a pre-implementation baseline: **RED**, correctly. Everything that can pass
does — lint, typecheck, full test suite, `pnpm build`, and every `ci:*` audit including
`rls-audit`, `tenant-scope`, `static-policy`. The only red rows are `promised-tests`
(40 titles, none written yet) and the declared integration-suite command (file does not
exist yet). Both resolve on completion of step 4.

`TEST_DATABASE_POOL_URL` is present in `.env.local` and the DB is at migrations head
(`solicitation_unsubscribe_tokens` queries clean), so the live-DB suite will really run
rather than self-skip.

## Sharp edges for whoever picks this up

- **Verified empirically, do not re-litigate:** on Fastify 5.8.5, `request.routeOptions.config`
  IS available at `onRequest`; `/ingress/%75nsubscribe/abc` routes to the unsubscribe
  handler and carries the skip flag; `/ingress/unsubscribe/x/extra` gets `config = {}` and
  404s. The URL-string prefix approach is withdrawn — do not reintroduce it.
- **`recordSuppression` returns `null` for two different reasons**, so its return value
  must not drive the `redeemed_at` stamp. Use the atomic claim in plan §1.3.
- **Do not pass a prompt containing backticks to the codex companion through a
  double-quoted shell argument** — zsh performs command substitution and silently mangles
  it. Write the prompt to a file and pass `"$(cat file)"`, or dispatch via the Agent tool.
- **`codex-companion task --resume-last` reported a job id twice but never registered the
  job.** A fresh dispatch through the `codex:codex-rescue` agent works. Prefer that.
- The `Agent` tool's task registry and the codex companion's job registry are **separate**;
  `TaskList` showing nothing does not mean a codex job died. Use
  `codex-companion status --all`.

## Next actions

1. Read round 2's verdict; if REVISE, triage and revise (max 3 rounds, then escalate to
   the owner instead of looping).
2. On APPROVED, present the plan to the owner for sign-off.
3. `bash scripts/feature-state.sh set-phase plan_approved`, then `set-phase executing`, and
   run step 4 as three tracer tickets (T1 ingress path, T2 landing path, T3 docs) via
   `superpowers:subagent-driven-development`.
4. **First-task spot check is mandatory:** after T1, diff `git status --porcelain` against
   `allowed_edit_surface`. An out-of-surface file means enforcement did not bind for
   subagent tool calls — STOP and report.
