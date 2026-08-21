# Handoff — feat-898-solicitation-send-governors

**Ticket:** #898 (wayfinder map #617, child of #630, decomposed 2026-08-18).
**Lane:** RISK = high · SURFACE = mixed · `db_touching: true` · SIZE = normal.
**Worktree:** `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-898-solicitation-send-governors`
**Branch:** `feat-898-solicitation-send-governors` (forked from `main` @ `fc2d43f9`).

A resumed session bootstraps from this doc, then the artifacts below **by path**.
It never needs the prior transcript.

---

## Read these, in this order

| Artifact | Path |
|---|---|
| Intake contract (arming copy) | `.feature/intake.json` |
| Intake contract (audit copy) | `docs/superpowers/plans/feat-898-solicitation-send-governors-intake.json` |
| Implementation plan | `docs/superpowers/plans/2026-08-19-solicitation-send-governors.md` |
| Machine phase record | `.feature/state.json` |
| Deviations | `docs/superpowers/plans/feat-898-solicitation-send-governors-deviations.md` |
| Plan review (round 1) | `docs/reviews/feat-898-solicitation-send-governors/plan-round1-codex.md` |
| Glossary excerpt | plan § "Glossary excerpt — use these terms verbatim" |

**Governing specs** (do not re-derive from memory):
`docs/superpowers/specs/2026-07-28-sender-deliverability-design.md` §3.2A/§3.2B/§3.3/§3.4/§4 ·
`docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` D19/D20 ·
`docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` **B3/B6/B13** — the amendments doc wins on conflict.

---

## Seven decisions locked in grilling

These are **not** re-litigable. A later session that thinks one is wrong surfaces it
to the owner as a map-level question; it does not quietly change it.

| # | Decision |
|---|---|
| 1 | Hard vs soft bounce is discriminated by a **new `bounce_kind` column**, not by prefix-matching `provider_error` — `recordFailure` COALESCEs `failed:…` into that column and would mask a real hard bounce (fail-open on a fail-closed governor). |
| 2 | The `withheld` CHECK gains exactly **two** members: `no_postal_address`, `postal_address_mismatch`. Dispatch gate item 3 (`subscriptionGrantsFullAccess`) gets **no** member — a lapsed subscription defers, `send_window_elapsed` terminalizes. |
| 3 | `solicitation_send_breaker` is **append-only** with a one-open partial unique index — not a mutable singleton, which would overwrite the very record an operator reviews after a breach. |
| 4 | **No new runbook file.** `docs/runbooks/solicitation-sending-domain.md` gains §8; its §5 ramp table and §6 seed gate keep their single owner. |
| 5 | Breaker window basis is **asymmetric**: denominator send-dated (`sent_at`), numerators signal-dated (`bounced_at`/`complained_at`). Errs toward tripping. |
| 6 | **HealthAlertPoller trips and pages**; #900's releaser is a pure reader. Bounded trip latency of one poll interval (5 min) is accepted and stated. |
| 7 | Admin reset lives on a **new `/admin/solicitation` page** (Safety group), not folded into `/admin/autonomy`. |

**Two deliberate deviations from the ticket text, both owner-approved:** no new runbook file (#4); `bounce_kind` widens the **Solicitation lane**'s declared write surface by one column (#1), so `CONTEXT.md`'s lane entry is amended in Task 8.

---

## Plan shape

Eight tracer tasks. Task 1 is the eval task — 27 failing tests that are the spec in
executable form. The `promised-tests` gate row matches those titles **verbatim**, so a
retitle is a plan change, not a typo fix.

```
T1 (eval) ──┬──> T2 (migration 110) ──┬──> T3 (lane bounce_kind) ─┐
            │                         └──> T5 (send-breaker) ─────┼──> T6 (health check) ─┐
            └──> T4 (send-caps) ──────────────────────────────────┘                       ├──> T8 (docs)
                                                                   └──> T7 (admin surface)┘
```

**Dispatch order:** T1 alone (its completion is the first-task enforcement spot check),
then `{T2, T4}` parallel, then `{T3, T5}` parallel, then `{T6, T7}` parallel, then T8 alone.
Pairs are marked independent because they have no blocking edge **and** disjoint file sets.

---

## Plan review — round 1

**Counter:** `planReviewRounds = 1` (in `.feature/state.json`; a resumed session continues
this count, it does not restart at 1).

**Reviewer:** `codex exec`, read-only sandbox, dispatched directly (not via the companion
wrapper, which has lost task ids across resumes).

- **First attempt thread id:** `01a01908-f132-7f70-8a67-b83731ff035a` — hit the 10-minute
  foreground cap mid-turn and was killed. Partial output only; not the review of record.
- **Round-1 thread id:** _recorded below once the background run returns._
- **Brief:** `/private/tmp/claude-501/-Users-norbertesekiel-Developer-startups-RepWorth/dd946b53-15ec-4b29-886e-10fa973b80e3/scratchpad/codex-plan-brief.md`
- **Raw output:** `…/scratchpad/codex-plan-r1.jsonl`
- **Report of record:** `docs/reviews/feat-898-solicitation-send-governors/plan-round1-codex.md`

**Verdict:** _pending._

The brief leads with the eval-first question — *can these 27 tests pass while the feature
is still wrong?* — and requires a **cited-artifact check** (every file, symbol, constraint,
index and runbook section the plan cites must be EXISTS / CREATED-BY-TASK-N / MISSING).
That check is in the brief because three #643 plan rounds each re-reviewed plan-internal
consistency and all missed a cited `CONTEXT.md` section that had never been written.

---

## State — step 8 in progress (PR open)

| Field | Value |
|---|---|
| Phase | `reviewed` |
| Gate | **GREEN**, 30/30, diff-coverage 100%, 44 promised tests |
| Commits | 34 on branch |
| Plan review rounds | 1 (codex wedged; orchestrator ran it — see deviations) |
| Branch review rounds | 2 |
| Gate-fail rounds | 1 of 3 |
| Surface amendments | **3** (budget 2; over-spent with owner sign-off, step-0 re-run performed and classification held) |

## Review outcome

Round 1: 23 findings (6 high). Round 2: verification-only, confirmed the round-1 fixes and caught
that one of them was incomplete. Everything accepted is fixed on-branch; 10 follow-ups filed.

Reports and triage: `docs/reviews/feat-898-solicitation-send-governors/`
(`round1-triage.md`, `round2-triage.md`, three round-1 axis reports, two round-2 reports,
`blast-radius.md`).

**The three defects worth remembering** — none was catchable by the tests as written, because in
each case the test and the implementation shared the same wrong assumption:

1. **UTC-day boundary** — the fixture used the same expression as production, so both were wrong
   together. Found by a subagent escalating instead of silently deviating.
2. **Breaker recovery** — the asymmetric window was optimised to err toward tripping and never
   checked in the other direction. Fixed once (denominator only), then fixed properly in round 2
   with two floors. The first fix's own test seeded `bouncedDaysAgo: 1` and could not see the gap.
3. **Edge-triggered paging** — the plan specified the bug as a feature and the eval test asserted
   it, so a dropped Sentry event meant a silent permanent platform-wide halt.

## Step 8 — status (2026-08-21)

**PR: #904** — https://github.com/RepWorth/ai-review-responder/pull/904 (open, not draft).
Branch rebased onto `main`; gate **GREEN 28/28** at `8376722c`.

| Item | State |
|---|---|
| 1. Land on `staging` | **DONE** — 898 code rode staging as `fd539b36` on 2026-08-19 |
| 1b. Migration 110 → **staging** Supabase | **DONE** 2026-08-21, verified by introspection (md5 matches local head byte-for-byte) |
| 2. Smoke the breaker path on staging | **DONE** — 9-assertion latch smoke + 13-assertion admin smoke, all PASS |
| 3. Open the PR, CI green, **PAUSE for owner merge approval** | PR open; **awaiting owner approval** |
| 3b. Migration 110 → **prod** Supabase, in the merge window | **PENDING** |
| 4. Post-merge sweep | **PENDING** |

Ride evidence: `docs/runbooks/evidence/2026-08-21-898-send-governors-staging.md`.

**The staging ride produced one finding worth carrying forward.** The 898 code sat
on the staging worker for two days while the database was still pre-110, so the
breaker check queried a table that did not exist. It logged a warning finding on
every one of five `HealthAlertPoller` ticks and never crashed, then went silent on
the first tick after 110 applied. That is a live proof of the round-1 try/catch
isolation under exactly the failure class it was written for — and it was free,
because nobody planned it.

**Post-merge, still to do:** `git pull --ff-only`; re-sync `staging` per
`deployment-guide.md` (after a squash merge use `git reset --hard origin/main` +
`--force-with-lease`, **NOT** a sync merge); `scripts/feature-cleanup.sh` dry-run
then `--apply`; promote the deviations lessons to lab-notes; `document-feature`;
domain sweep; increment the arch-review counter.

## Lessons queued for lab-notes at step 8

- **A SQL statement and its `tenant-scope-allowlist` entry are ONE unit.** Four for four on this
  branch: every SQL edit broke the byte-matched snippet. Any brief authorising a SQL change must
  authorise the allowlist too, or the task cannot finish.
- **Every new admin page implies a `nav-config.ts` row; every migration implies a `schema-ready`
  requirement.** Both are filesystem-walked by tests. Both caused surface amendments here.
- **`verify-gate.sh --review` is load-fragile** — parallel rows plus coverage instrumentation on a
  busy box yields exit 143 and coverage `.tmp` ENOENT that read as product failures. Use
  `MAX_PARALLEL=2 VITEST_WORKERS=2`.
- **A client component importing a value from a module with a module-scope worker logger breaks the
  Turbopack route build**, and no lint/typecheck/boundary audit catches it — invariant #1's ESLint
  rule lists packages, not `node:` builtins reached transitively.
- **No backticks inside a tagged template literal**, including in comments. It terminates the
  string and the file stops parsing.
