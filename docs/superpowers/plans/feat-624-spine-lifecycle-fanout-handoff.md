# Handoff — #624 spine lifecycle + physical fan-out primitives

Resume with `/feature-resume feat-624-spine-lifecycle-fanout` **from the worktree**:
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout`

This doc references artifacts by path; it does not restate them. The grilling transcript is
no longer needed — every decision is on disk.

## Where the run stopped

| Step | State |
|---|---|
| 0 Classify | done — RISK=high, surface=mixed, db_touching=true, est. +1550/−40 |
| 1 Grill | done — 10 forks locked (G1–G10), intake signed off, `open_questions: []` |
| 2 Setup | done — worktree armed, no cross-worktree surface overlap |
| 3 Plan | **written and committed; adversarial gate INCOMPLETE** |
| 4 Execute | not started — no code written, tree is docs-only |

`.feature/state.json` phase is deliberately still `worktree_ready`, **not** `plan_approved`:
the RISK=high plan gate has not returned a verdict.

## Read these, in this order

1. `docs/superpowers/plans/feat-624-spine-lifecycle-fanout-plan.md` — the plan. Contains a
   **Verified facts** table (16 claims with file:line), the G1–G10 decision table, module
   design notes, 8 tracer bullets T1–T8 with blocking edges, and a risk table.
2. `.feature/intake.json` — the contract. 33 promised test titles, matched **verbatim** by the
   gate. `allowed_edit_surface` is 24 globs.
3. `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` — **BINDING**,
   supersedes the specs where they conflict.
4. `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` — §9 (migration
   shape), §3 (D5 column list, D13 vocabularies, D6 PII), §5 (D11 join, D12 exhaustion, D14
   outcomes, D15 long parent), §9A (layout/invariants/test obligations), §10 (per-ticket
   bindings).
5. `git show origin/research/send-mode-executor-gap:docs/research/2026-07-28-send-mode-executor-gap.md`
   — gap analysis #618, only if a plan claim needs re-deriving.

## BLOCKING — do this first

The RISK=high plan gate did not complete. A `codex:codex-rescue` agent was dispatched
read-only against the plan (agent id `ad30e956a71455756`); it backgrounded its Codex run and
returned a status message instead of findings. A follow-up `SendMessage` was sent and had not
returned when the session ended.

**Do not start T1 until the gate closes.** Either:
- recover the findings (`SendMessage` to `ad30e956a71455756`, or read
  `/private/tmp/claude-501/-Users-norbertesekiel-Developer-startups-RepWorth/f5fcca9e-069b-45f8-9a33-7551b5013424/tasks/ad30e956a71455756.output`), or
- re-dispatch a fresh adversarial review of the plan.

Require an explicit `VERDICT: APPROVED` or `VERDICT: REVISE`. Max 3 revise rounds, then
surface the disagreement to the map owner rather than looping. **Then get owner sign-off on
the approved plan**, run `bash scripts/feature-state.sh set-phase plan_approved`, and only then
begin T1.

The review prompt asked Codex to attack five areas; the two most suspect, flagged by me:
- **G1** — 091 creates two `job_outbox` in-flight indexes but ships no `QUEUE_NAMES` entry and
  no typed helper (those go with their producers, #628/#630).
- **G10** — `stalledThresholdMsForKind` ships unwired because D15b has no reachable consumer.

## Pending plan correction (verified, not yet folded in)

Spec §3 D5 calls the outreach `agent_run_id` FK "the `judge_verdicts` / asks pattern". Those
are **two different shapes** and only one is right here:
- `judge_verdicts` (`076:21`) — simple single-column `REFERENCES agent_runs(id) ON DELETE SET NULL`
- `solicitation_asks` (`088:191`) — **composite** FK with column-scoped `ON DELETE SET NULL (agent_run_id)`

The outreach table needs the **asks** shape. Confirmed the column-scoped syntax is already
proven in this codebase at `088:191`, so it is not a PG-version risk. Fold this into T1
alongside the Codex findings.

## Decisions locked with the owner — do NOT re-litigate

Full table is in the plan (G1–G10). One-line each:

- **G1** indexes only in 091; helpers/QUEUE_NAMES with their producers
- **G2** `RunDisplayState` gains a real `'cancelled'` member
- **G3** body-presence CHECK keyed on `delivery_status` too (withholds never had a body)
- **G4** `deriveBatchState` ships in #624 with `closeBatchIfSettled`
- **G5** `unknown` ⇒ `send_indeterminate` exclusively
- **G6** constants co-located with consumers; §8's cap constants omitted (conflict with B3)
- **G7** `startOrGetSolicitationAskRun` thin seam; depth is type-level
- **G8** `acquireSolicitationBatchLock` exported from `batch-builder.ts`
- **G9** purge = cascade + inventory + verification + lock; no explicit DELETE
- **G10** export `stalledThresholdMsForKind`; do NOT widen `deriveRunDisplayState`

## Enforcement state

Hooks were **parked** at session end (`.feature/intake.json` → `.feature/intake.parked.json`)
because the session finished mid-feature with no gate evidence, which is the sanctioned way to
park red work. **Re-arm before writing any code:**

```
cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout
mv .feature/intake.parked.json .feature/intake.json
bash scripts/arm-check.sh          # any DISARMED output ⇒ STOP and report
```

`/feature-resume` re-runs the arm check itself; do it manually only if resuming another way.

## Reminders that bit during planning

- Shell cwd resets between Bash calls — prefix **every** command with
  `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout &&`,
  and use absolute worktree paths for every Edit/Write. An edit against the parent checkout
  silently lands in `main`'s tree.
- Replicate CHECK text from the **current** definition (088), never from 071 — 088 already
  widened `kind`, `subject_type`, the pairing, `outcome_kind`, and `unit_count`.
- Live-DB suites: `*.integration.test.ts`, apply **no** migration SQL, `assertSchemaReady`;
  the migration-shape suite also needs `acquireLiveDbLock`. `TEST_DATABASE_POOL_URL` must be
  set or the gate's integration row is a loud SKIP and the work is **not** review-ready.
- Run `pnpm test:db:setup` after 091 lands, before the integration suites.

## Step 5 gate expectations

`bash scripts/verify-gate.sh` (and `--review` for the final pass). The `promised-tests` row
will stay red until all 33 titles exist verbatim. Extra verification commands from the intake:
`pnpm test:db:setup`, the 091 integration suite, `pnpm ci:tenant-scope`, `pnpm ci:rls-audit`.

## Ship lane

RISK=high: staging first (migration applies to the **staging** Supabase project first), verify,
then PR to `main` and PAUSE for explicit merge approval; apply to prod Supabase in lockstep at
promotion. This ticket holds the **only** migration slot — #625/#626/#627 are blocked until it
lands.
