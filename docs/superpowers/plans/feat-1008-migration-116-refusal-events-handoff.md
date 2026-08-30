# Handoff — feat/1008-migration-116-refusal-events

Written 2026-08-29 at HEAD `683e152b`, gate **GREEN 30/30**, phase
`gate_green`. The prior session's context was exhausted; this file plus the
artifacts it names is everything a fresh session needs. Do **not** try to
recover the transcript.

## Read these, in this order

| Path | What it is |
|---|---|
| `.feature/intake.json` | the locked contract — 23 promised tests, 18-path surface |
| `docs/superpowers/plans/feat-1008-migration-116-refusal-events-plan.md` | the plan, revision 3; Task 1 inlines the full DDL; **§"Step 8 — the ship order"** is the shipping procedure |
| `docs/superpowers/plans/feat-1008-migration-116-refusal-events-deviations.md` | **D1–D15, all ACCEPT.** Triage table at the top |
| `docs/reviews/feat-1008-migration-116-refusal-events/triage.md` | step-7 review verdicts, 8 findings, all accepted |
| `docs/reviews/red-team/feat-1008-migration-116-refusal-events-cbbac6/` | red-team rounds 1 and 2 — `findings.md` + `findings.json` |
| `CONTEXT.md` → `## Refusal ledger` | the four LOCKED terms this branch introduces |

Ticket #1008 · map #994 · schema locked in #1001 · next slice #1009.

## THE ONE THING TO DO NEXT

**Run a documentation-only red-team round 3.**

This **overrides the skill's hard cap of 2 rounds**, and the owner authorised
that explicitly on 2026-08-29 in response to a stated choice between accepting
the staleness and overriding the cap. Record it as `AUTH-1008-02`.

### Why a third round exists at all

The checker currently FAILS, and both reasons are true rather than cosmetic:

```
intake_sha256 does not match .feature/intake.json — an amended intake voids the evidence
the tree moved since 6a7fc65010c3 outside this run's own two artifacts —
  the red-team evidence is stale, re-run it
```

Red-team round 2 ran at `6a7fc650`. Its own fixes then landed as `683e152b`,
so its evidence is one commit stale. The checker also recomputes
`status: CLEAR` — 13 fixed, 2 accepted-risk, 1 rejected, **zero open**. Nothing
is unresolved; the evidence is simply older than the tree.

**The prior session refused to write the newer SHA into the sidecar**, because
that would claim a pass ran at a commit where it did not. Do not do that
either.

### Scope of round 3 — narrow, and enforce it

`git diff 6a7fc650..683e152b` is the entire scope. It is **documentation
only** — `git diff --name-only 6a7fc650..683e152b | grep -E '\.(ts|tsx|sql)$'
| grep -v '^docs/'` returns nothing. Re-run that command as your first act; if
it returns anything, the premise for a doc-only round is void and you must
widen.

The six corrections to verify, each of which fixed a fact stated in two
artifacts and previously corrected in only one:

1. line→symbol citations, now in the **intake** as well as the plan
2. "nine probe rows" → eight, in `arch-review-log.md`
3. "22 promised tests" → 23, in `arch-review-log.md` and `plan.md`
4. the `deployment-guide.md` §II.5 attribution, in `arch-review-log.md` —
   §II.5 states PR-first and staging-DDL-before-**prod**-DDL; the
   production-DDL-before-**merge** step is this branch's own inference
5. ADR 0023's writer/anchor table regained `unsubscribed`, its eighth member
6. `findings.json` dispositions and the D15 entry

Duty 3 (docs vs reality) is the whole round. Duty 1 has no production hunk to
mutate — say so rather than padding.

### Then, in this exact order

1. `node .agents/skills/red-team/scripts/mutation-runner.mjs round-start`
   — it refuses a third round. **The override is deliberate**: reset
   `.feature/state.json`'s red-team round counter, or run the pass and write
   the round-3 sidecar directly. Record the override as `AUTH-1008-02` in the
   sidecar's `authorizations` array with the owner's words.
2. The INVOKING agent runs `finalize`, never the subagent.
3. Commit the report artifacts only.
4. `bash scripts/verify-gate.sh --review` as the LAST serialized step.
5. `node .agents/skills/feature/scripts/red-team-status.mjs`
6. `bash scripts/feature-state.sh set-phase reviewed`

**A known checker bug, found by round 2 — do not chase it.**
`red-team-status.mjs`'s `makeGit` `.trim()`s `git status --porcelain` output,
stripping the leading space of the first line, so `line.slice(3)` yields a
truncated path that never matches the exclusion list. It will report a *false*
unrestored mutation for whichever artifact git lists first. It does not move
`status`. The file is untouched by this branch; fixing it is out of surface.

## Then step 8 — ship. RISK = high

The order is in the plan's §"Step 8" and **no step may be reordered**. Two
properties must hold together: the migration reaches a database before the code
that names it, AND no SQL reaches production before CI is green and the owner
has approved.

1. `gh pr create --draft`, then `gh pr ready` (draft PRs run no CI)
2. every required check green — **this is the gate on the SQL**
3. apply 116 to **staging** Supabase; verify by introspection, never
   `list_migrations`
4. push the branch to `staging`
5. smoke: run an offboarding purge, confirm no `refusal_events` violation
6. **pause for owner merge approval**
7. apply 116 to **production** Supabase; verify by introspection
8. merge
9. remove the LOCAL-ONLY marker from the 116 entry, record both promotion lines
10. re-sync `staging` per `deployment-guide.md` — squash-merge diverges, so
    `--ff-only` aborts; use `git reset --hard origin/main` + `--force-with-lease`

**#1009 unblocks at step 7**, not at merge and not at step 9.

### The PR description must carry

- **Red-team findings rejected**: RT-11 (C5's `IS NOT NULL` and `cardinality`
  clauses are redundant given their siblings, kept deliberately — each states a
  fact the next editor needs, and the same reasoning keeps the `IS TRUE`
  wrapper, which is now pinned structurally).
- **Accepted risk** `AUTH-1008-01`: RT-05 and RT-08 —
  `account_offboarding_purge_failed` is routed by no runbook rule and neither
  generic sink catches it, so a terminally-failed purge pages nobody.
  Pre-existing; filed as **#1016**.
- **The adversarial approach review never completed.** It was dispatched twice
  and killed after ~25 and ~40 minutes with zero output. Its design-level
  challenges — record-vs-derive, the slice boundary, business policy in CHECK
  constraints, whether `all_refusal_codes` should have been JSONB or a child
  table — went unanswered. `triage.md` states what that costs.

## After merge

- `git pull --ff-only` on local `main`; re-sync `staging`
- `bash scripts/feature-cleanup.sh` (dry run first, then `--apply`)
- **Promote five lessons** from the deviations file into
  `.claude/reference/lab-notes.md` or the CLAUDE.md gotchas — D9, D11, D12,
  D14 and D15. The strongest is **D15**: in this repo a documentation fix is a
  *sweep*, never an edit, because the artifacts duplicate deliberately.
  Also worth promoting: the four-registry chain a new tenant table forces
  (D13's generalisable half).
- Invoke `document-feature`, then `domain-modeling`
- Increment the merge counter in `.claude/reference/arch-review-log.md`
- **Delete branch `feat/refusal-log`** rather than merging it. It holds a
  now-stale `CONTEXT.md` block and ADR 0023, both superseded here.

## State

| | |
|---|---|
| worktree | `/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-1008-migration-116-refusal-events` |
| HEAD | `683e152b` · fork point `5ab6bfee` |
| phase | `gate_green` |
| surface amendments | **2 of 2 used** (`rls-inventory.md` + `PurgeWorker.test.ts`; then `arch-review-log.md` with owner sign-off, D13). A third needs the owner. |
| plan-review rounds | 3 (round 3 killed unfinished) |
| branch-review rounds | 1 |
| red-team rounds | 2, plus this authorised doc-only third |

Local `TEST_DATABASE_POOL_URL` and `DATABASE_POOL_URL` must both be exported or
live-DB suites silently skip. Extract from `.env.local` into a variable, never
as a literal argument. If a suite reports "test database is behind head", run
`pnpm test:db:setup` — a red-team pass can leave the container behind.
