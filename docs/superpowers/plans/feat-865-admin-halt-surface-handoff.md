# feat-865 — handoff

A resumed session bootstraps from THIS file, then the artifacts it references.
It never needs the prior transcript. Everything below is a pointer, not a
restatement — read the referenced file, do not trust a summary of it.

**Resume with:** `/feature-resume feat-865-admin-halt-surface`

---

## Where things are

| What | Path |
|---|---|
| Worktree root | `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-865-admin-halt-surface` |
| Branch | `feat-865-admin-halt-surface`, based on `f28451ee` |
| Source ticket | GitHub issue #865 (`gh issue view 865`) |
| Intake contract (audit copy) | `docs/superpowers/plans/feat-865-admin-halt-surface-intake.json` |
| Intake contract (arming copy) | `.feature/intake.json` — verified byte-identical to the audit copy |
| Plan | `docs/superpowers/plans/feat-865-admin-halt-surface.md` (**revision 3, LOCKED**) |
| Deviations | `docs/superpowers/plans/feat-865-admin-halt-surface-deviations.md` (D1–D5) |
| Review reports | `docs/reviews/feat-865-admin-halt-surface/` (plan rounds 1, 2, 3) |
| Machine state | `.feature/state.json` |
| Glossary excerpt | `CONTEXT.md` — **Halt latch**, **Batch state**, **Send batch parent**, **Settled batch**, **Outreach row**, **Ask**, **Lazy child**. Re-read these before any task; do not paraphrase them. |

## Current position

**STEP 8 IS ALL BUT DONE. The staging ride is COMPLETE and VERIFIED, PR #876 is
open with every CI check green, and the ONLY remaining action is the owner's
explicit merge approval. Do not merge without it.**

State as of 2026-08-18, HEAD `f23dafbe`, `phase: reviewed`, gate GREEN
(28 PASS + the owner-accepted `reclassify` WARN, D8).

- **Rebased onto `main` a SECOND time** after #875 landed mid-ship. #875 rewrote
  this branch's own enforcement machinery (`ci:feature-surface`,
  `edit-surface-guard.sh`, `arm-check.sh`), so the rebase + full gate re-run was
  substantive, not ceremonial. Zero file overlap; clean rebase.
- **Staging ride done and torn down.** A two-batch fixture was seeded, smoked
  and removed; staging is back to zero solicitation rows. The halt write is
  verified end to end — audit row, spine step, exactly 2 cancellations, the
  `sent` row untouched, parent run `cancelled`.
- **The smoke found two real defects the whole review apparatus missed** —
  see deviations **D10**, fixed in `bbbfb67a` and `f23dafbe`. Both existed only
  in the composition (write → refetch → render). This is the single most
  important thing on this branch for a future session to absorb: the staging
  ride is a real gate, not a formality.
- If anything needs re-verifying on staging, the seed and teardown SQL are
  disposable and were kept out of the repo; re-derive them from D10's
  description rather than hunting for them.

**Next action is step 8's merge pause, then the entire "After merge" list
below — none of which has been done yet.**

- Steps 1-6: done. Plan locked at revision 3 (owner's call substituted for
  APPROVED after the round-3 cap; plan §6 records it).
- Step 4: all 5 tasks committed.
- **Rebased onto `main` after #860 merged** (PR #873). D1's obligation is
  discharged: the rebase happened and the full gate re-ran on the rebased tree.
  It caught a real defect — see D7.
- Step 5: `scripts/verify-gate.sh --review` **GREEN**, 28 PASS + 1 WARN. The
  WARN is `reclassify` (production 925 lines vs a 420 estimate) and is
  **owner-accepted** — see D8. It will fire on every future run; it is not a
  regression.
- Step 6: deviations read-back complete, **9 entries, all ACCEPT**.
- Step 7: **round 1 complete, 3 axes, 10 findings, 8 accepted + 2 rejected.**
  `branchReviewRounds: 1`. Verdicts are committed in each report under a
  `# TRIAGE` heading — a resumed session inherits them and must NOT re-litigate.

## What step 7 changed, and why it matters

Two findings came from the adversarial axis and **both contradicted a locked
artifact**, so both went to the owner, who approved fixing them in-branch:

- **F1 (High)** — `readAdminBatchSummary` selected the NEWEST batch, but 091's
  partial unique index lets a newer `pending` batch coexist with and outrank an
  older live one. Support would open this feature's own page and be unable to
  stop the batch in flight. Now ordered on the live-send predicate first.
- **F2 (Medium)** — the owner arm's `pending` hole was API-reachable:
  `readLatestBatch` hands the owner the unbuilt batch's id and the halt endpoint
  accepts any valid `batchId`. `haltBatch` now refuses `pending` like
  `adminHaltBatch`. **This contradicted an intake `non_goals` entry** — recorded
  as D9.

**F2's fix desynced four documents, all corrected in `6741c1ab`**: `CONTEXT.md`
**Halt latch**, plan §2 D11, plan §7, and the `docs/directory.md` `approval.ts`
row. **Plan §7's follow-up ticket is now MOOT — do not file it.**

## Task ledger

| Task | What | State |
|---|---|---|
| 0 | eval — 30 titles as executable failing tests | **done** `834457a3` (pre-rebase sha) |
| 1 | `latchHalt` extraction + `adminHaltBatch` | **done** |
| 2 | the admin route | **done** |
| 3 | `readAdminBatchSummary` + panel + page wiring | **done** |
| 4 | docs sweep (`CONTEXT.md`, `docs/directory.md`) | **done** |
| 7-fix | F1, F2, 3 panel mediums, 3 lows | **done** `084ea8cb`, `b9fc9e03`, `6741c1ab` |

## Codex review thread

Rounds 1–3 ran in **one** codex session so each round could verify its own prior
findings:

```
thread id: 01a01308-efa1-7542-81f3-3a974d3b1c5d
```

That thread is CLOSED for plan review — the cap is spent. It is the correct
thread to resume for a **branch** review at step 7, which has its own counter
(`branchReviewRounds`, currently 0).

**Invocation gotcha, learned the hard way.** Global flags must precede the
`resume` subcommand. This fails with `error: unexpected argument '--sandbox'`:

```
codex exec resume <id> --sandbox read-only --json …     # WRONG
```

This is correct:

```
codex exec --sandbox read-only --json --cd "$W" resume <id> "$(cat brief.md)"
```

Reports are extracted from the JSONL by concatenating every `item.completed`
event whose `item.type` is `agent_message` — the final message alone is NOT the
report; the substantive findings arrive in earlier messages.

## The four owner-locked decisions

Do **not** re-litigate these. Full reasoning in the plan's §2 (D1–D11).

1. `halted_by` = the acting admin's `users.id`.
2. Tenant ids body-supplied (`accountId` + `businessId` + `batchId`).
3. #858 landed (PR #868); canonicalise at the public entry point anyway.
4. The surface is a panel on `/admin/businesses/[id]`.

## Cross-branch obligation — STILL OPEN

`feat-860-ask-regeneration-surface` overlaps `approval.ts` and `batch-view.ts`.
**Agreed order: #860 merges FIRST; this branch rebases onto `main` and re-runs
the full gate before review round 1 counts.** See deviations D1.

- #860's PR is **#873, OPEN** as of 2026-08-18. Re-check with
  `gh pr view 873 --json state`.
- The overlap is mechanical (a shared file-header comment and a shared append
  point), not semantic — which is why #865 implements in parallel rather than
  idling. D1 has the file-by-file evidence.
- The counterpart note lives on the sibling branch, committed at `db89a700`,
  section "Surface overlap with feat-865". It is unresolvable from THIS review
  root by construction.

## Two things that must not be lost

1. **Task 0 forbids `.todo` and `.skip`.** All 30 tests must execute and fail,
   and the red run must be recorded in the deviations file. A `.todo` satisfies
   the gate's `promised-tests` row while asserting nothing — that is the hole
   round 1 opened with. The final gate additionally requires recorded
   **`30 passed / 0 skipped / 0 todo`** evidence, because `diff-coverage` does
   NOT gate a test-only commit (`scripts/diff-coverage.ts:62-65` excludes test
   paths; `104-106` exits PASS when no production line changed).
2. **The owner-arm `pending` defect is a scheduled follow-up, not a silent
   drop.** `haltBatch` permits halting a batch with `built_at IS NULL`, which
   makes `batch-builder.ts:782-786` violate `091:176` later. The admin arm
   refuses it (D11); the owner arm is carved out in `non_goals` and must be
   filed as a ticket at step 8. Plan §7 owns this.

## Step 8 — SHIP (RISK = high lane)

**There is NO migration on this branch** (`non_goals`: "No migration — every
value this needs already exists in migrations 091 and 108"), so the
apply-to-staging-Supabase-first step does not engage.

1. **Ride staging first.** Land the branch on `staging`; the push auto-deploys
   both the Railway staging worker and the Vercel staging Custom Env.
2. **Smoke the touched path on staging**: open `/admin/businesses/<id>`, confirm
   the panel renders the live batch (not a newer `pending` one — that is F1),
   stop a batch with a note, confirm the `account_audit_log` row
   (`solicitation_batch_admin_halted`) and the `batch_halted` spine step.
3. **Open the PR to `main`**, confirm every GitHub CI check green, then **PAUSE
   for the owner's explicit merge approval.** Do not merge without it.

## After merge — do not skip, and two of these are easy to lose

- `git pull --ff-only` on local `main`, then realign `staging`:
  after a squash merge the branches have DIVERGED, so `git merge --ff-only`
  aborts and the runbook's answer is `git reset --hard origin/main` +
  `--force-with-lease`. **Do NOT substitute a sync merge** — that is how staging
  reached 101 commits ahead (#719).
- `bash scripts/feature-cleanup.sh` from the MAIN checkout (dry run first).
- **Promote the durable lessons** out of the deviations file into
  `.claude/reference/lab-notes.md` / CLAUDE.md gotchas. The strong candidates:
  D4's `@vite-ignore` idiom (a literal dynamic `import()` does NOT survive a
  missing module — the file collects as `(0 test)` while satisfying the gate's
  title row), D5/D6 (an eval stubbing an unwritten module cannot type its
  fixtures, so the type errors land on whichever task writes it — twice here),
  D7 (a cross-branch overlap analysis has a shelf life; write the obligation,
  not just the analysis), and D8 (estimate production from enumerated
  behaviours, not from a precedent file's size).
- Invoke `document-feature`, then `domain-modeling` for the final sweep.
- Increment the merge counter in `.claude/reference/arch-review-log.md`.

## Follow-up tickets to file at step 8

1. **`withSameOrigin` should be return-type-preserving** (one generic parameter).
   Would delete the whole class of widening that D5 hit. Touches every wrapped
   route, so it is its own ticket.
2. **`useAdminActionForm`** — the `useReducer` + 7-action-type boilerplate is now
   duplicated across FIVE admin surfaces. #865 correctly followed the pattern
   rather than diverging.
3. **`docs/progresstracking.md:4375` is stale** — still says `admin_halt` is "a
   CHECK member with no writer — a live-but-dead enum arm". Outside this
   branch's `allowed_edit_surface`; the `document-feature` sweep owns it.
4. **`scripts/verify-gate.sh` races `db-provision` against the parallel rows.**
   Observed 2026-08-18: `ci:rls-audit`'s live check ran while `db-provision` had
   schema `public` dropped and reported 20+ unrelated tables "missing from
   pg_class". `db-provision` is documented to run SERIALLY before the parallel
   rows, so either the ordering is not actually enforced or rls-audit escapes
   it. Re-running the gate was green; standalone against the head DB it passes.
   This produces false failures on any `db_touching` feature, and a false
   failure that clears on retry is the kind a future session will learn to
   ignore — which is the real cost.
5. **A `staging` push no longer produces a `target:"staging"` deploy.** Both
   `deployment-guide.md` and CLAUDE.md state it does, "verified 2026-06-02".
   Every recent staging deploy returns `target: null` (generic preview) and is
   aliased to `staging.repworth.net`, so the stack still works — but the
   documented mechanism is not what is running, and the runbook's
   "deploy the custom env explicitly" instructions are written against the
   claimed behaviour.

**Do NOT file** the plan §7 pending-batch ticket. F2 fixed it; §7 now says so.
