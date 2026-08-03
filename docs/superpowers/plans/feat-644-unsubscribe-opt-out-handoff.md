# #644 handoff — unsubscribe opt-out path

**Branch** `feat-644-unsubscribe-opt-out` · **Worktree** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-644-unsubscribe-opt-out`
**Phase at handoff:** `worktree_ready` — step 3 (plan). The plan file's own header is the
authoritative revision label; do not restate it here.
**CLEARED TO IMPLEMENT — owner decision 2026-08-03.** Six adversarial passes ran (three
programmatic codex rounds, then three owner-run `/codex:adversarial-review` passes after the
programmatic path failed four consecutive ways). Every one returned REVISE / needs-attention
and **every finding is folded into plan revision 7**.

The owner has **declined a seventh review pass** and directed that implementation start.
Rationale, recorded because it reverses this document's previous instruction: four of the
six rounds were triggered by defects introduced in the *preceding revision*, not by new
ground; revision 7 is the first revision that made the design smaller (it deleted the
bulkhead and dissolved two findings with one structural change); and the remaining risk is
better surfaced by real code against 70 promised tests, the live-DB gate, and step 7's two
independent reviewers than by a seventh prose review.

**Start at step 4.** Do not open another plan-review round.
**Mutable facts are NOT restated here** — they drifted twice and were flagged twice by
review. Read them from their one authoritative source instead:

| Fact | Authoritative source |
|---|---|
| HEAD, phase, commit count | `jq . .feature/state.json` · `git rev-list --count main..HEAD` |
| Current plan revision | the revision header at the top of the plan file itself |
| Promised-test count | `jq '.tests_to_add\|length' .feature/intake.json` |
| Whether enforcement is armed | `bash scripts/arm-check.sh` |

Invariant that holds regardless: **every commit on this branch is documentation. No
implementation code exists.** If `git diff main --stat` ever shows a non-doc path, this
handoff is stale and the tree is ahead of it.
**Worktree is PARKED between sessions:** `.feature/intake.json` may be renamed to
`.feature/intake.parked.json`. If `arm-check.sh` reports DISARMED, rename it back before
doing anything else — `/feature-resume` depends on it.

Resume with `/feature-resume feat-644-unsubscribe-opt-out`. Everything needed is on disk;
the grilling transcript is not required.

## Read these, in this order

| Artifact | Path |
|---|---|
| Intake contract (drift detector, authoritative) | `.feature/intake.json` (audit copy in `docs/superpowers/plans/feat-644-unsubscribe-opt-out-intake.json`) |
| Plan (revision stated in its own header) | `docs/superpowers/plans/2026-08-03-644-unsubscribe-opt-out.md` |
| Adversarial review round 1 + triage | `docs/reviews/feat-644-unsubscribe-opt-out/plan-adversarial-round1.md` |
| Adversarial review round 2 | `docs/reviews/feat-644-unsubscribe-opt-out/plan-adversarial-round2.md` |
| Adversarial review round 3 | `docs/reviews/feat-644-unsubscribe-opt-out/plan-adversarial-round3.md` |
| Owner-run review #1 | `docs/reviews/feat-644-unsubscribe-opt-out/plan-adversarial-owner-run.md` |
| **Owner-run review #2 (latest — read before touching the plan)** | `docs/reviews/feat-644-unsubscribe-opt-out/plan-adversarial-owner-run-2.md` |
| Locked spec | `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md` §5.1–5.5, §9.1–9.5, §10, DR1 |
| Glossary | `CONTEXT.md` → "Solicitation suppression & unsubscribe" |
| Ticket | `gh issue view 644` |

## State of play

- **Steps 0–2 complete.** RISK=high / SURFACE=mixed / db_touching=true. Worktree armed
  (`scripts/arm-check.sh` clean), no cross-worktree surface overlap.
- **Step 3 in progress.** Five adversarial passes ran (3 programmatic codex rounds + 2
  owner-run); every one returned REVISE / needs-attention and every finding is folded in.
  See the review-history table below.
- **Nothing implemented.** No source file has been created or modified.

## Owner decisions locked so far

1. Success state uses a plain form POST → 303 → success page; no client component (works
   with JS disabled). **Amended after the owner-run review:** the redirect carries a
   **signed receipt**, not a bare `?done=1` — a hand-crafted `?done=1` would otherwise
   claim "You're unsubscribed" with no suppression written.
2. Business name falls back to "the business that contacted you" when provenance is gone.
3. `SOLICITATION_UNSUBSCRIBE_MAILTO` is introduced by this ticket, dual-lane.
4. **Reversed after round 1, refined twice since:** unknown tokens fail honestly — `503` at
   the ingress (so a #630 mint-race is recoverable via provider retry), and the human POST
   redirects to the neutral page rather than claiming a success that did not happen.
   **There is deliberately NO Sentry event for an unknown token** (round-3 finding 8): the
   route is unauthenticated and unrate-limited, and worker Sentry has no error sampling or
   dedup. Telemetry is a replica-tagged windowed aggregate — see plan §1.6.
5. §5.5 vs §5.4 conflict: §5.4 wins. The **button** page names the business; the
   **success** page uses the generic sentence. Deliberate deviation from §5.5's quoted copy.

## Amendment ledger (abort criteria: a 2nd surface amendment forces a re-plan)

| # | Kind | What |
|---|---|---|
| — | behavior only | §5.5/§5.4 resolution: `user_visible_behavior`, `invariants`, `edge_cases`, `tests_to_add`. **Not** a surface amendment. |
| **1** | **surface** | Added `src/lib/shared/sentry-scrub.ts` + `src/lib/shared/__tests__/**` (round-1 finding 3 — the raw token reaches Sentry otherwise). |

| **2** | **surface** | Added `worker/config/fastify-options.ts` + `worker/config/__tests__/**` (owner-run #3 finding 1 — route-level silencing cannot reach unmatched 404s). |

**Both surface amendments are spent.** A third would normally force a re-plan; the owner has
directed that all findings be resolved in this ticket, which supersedes that stop. Any
further surface need must be raised with the owner explicitly.

## Gate status

Last run was a pre-implementation baseline: **RED**, correctly. Everything that can pass
does — lint, typecheck, full test suite, `pnpm build`, and every `ci:*` audit including
`rls-audit`, `tenant-scope`, `static-policy`. The only red rows are `promised-tests`
(count via `jq '.tests_to_add|length' .feature/intake.json`; none written yet) and the declared integration-suite command (file does not
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

## Review history (all reports in `docs/reviews/feat-644-unsubscribe-opt-out/`)

| Round | Verdict | Outcome |
|---|---|---|
| 1 | REVISE, 7 findings | Rate-limit exclusion was broken by URL decoding; "propagate → Sentry" leaked the raw token; `redeemed_at` racy. All folded into rev 2. |
| 2 | REVISE, 7 | Closed 5/6/7. Showed rev 2's log fix was **false** (Fastify logs before the handler) and its ordering let a spent token undo an audited Correction path removal. → rev 3. |
| 3 | REVISE, 5 | Closed 3/9 + GET/HEAD. Found rev 3's `SELECT 1` **recreated the mint race**, its scrub broke two shipped `/approve/` contracts, and its counter rested on a false single-replica premise. → rev 4. |
| 4 | **not run** | Codex tooling failed 4×. Replaced by the owner-run pass below. |
| owner-run #3 | **needs-attention**, 4 high | Raw token logged on unmatched 404s (route-level silencing is post-routing); Vercel DB path unbounded; the bulkhead was an intentional loss path contradicting §1.7; a receipt could outlive its suppression — the **3rd** false-success vector. Triggered a post-mortem, then lifted by owner decision. → **rev 7**: self-authenticating tokens, global request serializer, render-time ledger read. |
| owner-run #2 | **needs-attention**, 3 high + 1 med | Spent-token replay after a Correction-path removal still minted a success receipt; the limiter-exempt route had unbounded body/DB workload; **test titles** still contradicted the revised behaviour (same drift class as owner-run #1, in the field I had not swept); handoff drifted a 3rd time → now fixed structurally. → **rev 6**. Report: `plan-adversarial-owner-run-2.md`. |
| owner-run #1 | **needs-attention**, 3 high | `?done=1` could render a **false unsubscribe success**; unknown-token logging was an unbounded amplification path (my "like every other ingress route" justification was a false equivalence — they keep the limiter, this route does not); handoff/state drifted to a superseded revision. All 3 accepted → **rev 5**. Report: `plan-adversarial-owner-run.md`. |

**Empirically verified in place of round 4** (commit `ae28c6e5`) — the two riskiest claims,
measured rather than argued:
- **Mint-race branch** against the live test DB (PG16, Read Committed, real concurrent
  connections): 6/6 pass, including a mint landing *inside* the race window → 503 → the
  provider's retry succeeds. No permanent-503 trap; a rolled-back redemption leaves the
  token claimable.
- **Sentry scrub**: 12/12, all four shipped `/approve/` contracts byte-for-byte intact
  while the new prefixes cover encoded spellings and `%2F` tokens. Rule order is pinned in
  plan §1.5 because "decode for matching, redact the raw string" corrupts offsets.

## Superseded — required for revision 3 (round 2's findings, now addressed)

Round 2 closed findings 5, 6, 7 and cleared the crash-net interaction and the
`suppressionId` removal. Still open:

1. **Finding 3 — reopened and harder than revision 2 assumed.** Fastify logs
   `incoming request` **before** `onRequest` and before the handler, so *catching does not
   prevent the raw token being logged*. Revision 2's claim is false. Fix = disable request
   logging for this route or install a token-redacting request serializer. The fact that
   prod runs at `warn` (which happens to suppress it) is a coincidence, not an invariant.
2. **Finding 4 — reorder the transaction.** `recordSuppression` must NOT run before the
   claim. Ordering it first lets a spent token silently undo an audited **Correction path**
   removal, and lets a concurrent purge produce a suppression row with stale non-null
   provenance (violating §5.2's `account_id = NULL`). Make the claim serialize first and
   return the provenance it locked, then feed `recordSuppression` from that row.
3. **Finding 2 — exempt the GET route too.** The flag is on `app.post` only; the worker GET
   redirect is a separate route and its inherited HEAD route is still rate-limited.
4. **Finding 9 — add the TypeScript module augmentation** for
   `FastifyContextConfig.skipIngressRateLimit`, or a typed seam. Without it the plan does
   not typecheck.
5. **Finding 10 — the Sentry scrub must match encoded route spellings**, not just literal
   `/ingress/unsubscribe`, or an event retains the raw token.
6. **Finding 8 — design bounded observability** for unknown tokens: the route is
   deliberately unrate-limited, so per-request Sentry events plus one log line each is an
   amplification vector. Needs aggregation, dedup, or sampling.
7. **Finding 1 — soften the claim.** 503 makes mint-race recovery *possible*, not
   guaranteed; no provider retry contract exists in-repo. State it honestly.

## Next actions

1. `bash scripts/feature-state.sh set-phase executing`, then run **T1** (domain module +
   Railway ingress, end to end) via `superpowers:subagent-driven-development`, TDD, against
   the live test DB.
2. **First-task spot check is MANDATORY**: after T1's first subagent returns, diff
   `git status --porcelain` against `allowed_edit_surface`. An out-of-surface file means
   enforcement did not bind for subagent tool calls — STOP and report, do not dispatch more.
3. Then T2 (landing path) and T3 (registry/runbook/glossary).
4. `scripts/verify-gate.sh` must be fully green before any review; `--review` for the last
   run before step 7.

**§1.4a is new in revision 7 and has never been reviewed.** Treat it as the highest-risk
slice of T1: verify empirically that a forged token opens no DB connection on *both*
surfaces, and confirm whether a `SESSION_COOKIE_SECRET` rotation would invalidate delivered
links (tokens must operate ≥30 days by statute — if it would, that needs a runbook note).

### Superseded next-actions from earlier rounds
3. `bash scripts/feature-state.sh set-phase plan_approved`, then `set-phase executing`, and
   run step 4 as three tracer tickets (T1 ingress path, T2 landing path, T3 docs) via
   `superpowers:subagent-driven-development`.
4. **First-task spot check is mandatory:** after T1, diff `git status --porcelain` against
   `allowed_edit_surface`. An out-of-surface file means enforcement did not bind for
   subagent tool calls — STOP and report.
