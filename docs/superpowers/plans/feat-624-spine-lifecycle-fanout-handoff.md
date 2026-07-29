# Handoff — #624 spine lifecycle + physical fan-out primitives

Resume with `/feature-resume feat-624-spine-lifecycle-fanout` **from the worktree**:
`/Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-624-spine-lifecycle-fanout`

This doc references artifacts by path; it does not restate them. Every decision is on disk.

## Where the run stopped

| Step | State |
|---|---|
| 0 Classify | done — RISK=high, surface=mixed, db_touching=true |
| 1 Grill | done — 10 forks locked (G1–G10), intake signed off, `open_questions: []` |
| 2 Setup | done — worktree armed, no cross-worktree surface overlap |
| 3 Plan | written; **gate round 1 CLOSED (REVISE), plan revised, round 2 IN FLIGHT** |
| 4 Execute | not started — no code written, tree is docs-only |

`.feature/state.json` phase is still `worktree_ready`, **not** `plan_approved`: round 2 has
not returned a verdict, and even an `APPROVED` needs owner sign-off before the phase moves.

## Round 1 is done — do NOT re-run it

The round-1 gate completed at 00:23 on 2026-07-29, minutes after the session that dispatched
it ended. Its verdict was recovered from the Codex session log, not re-run.

**`VERDICT: REVISE`** — 20 findings (13 High / 4 Medium / 3 Low). Verbatim review:
`docs/reviews/feat-624-spine-lifecycle-fanout/plan-gate-codex-round1.md`.

19 accepted and folded into the plan (commit `d62331ff`); **finding 20 rejected** as a false
positive — it reported `.feature/intake.json` missing, which was only the deliberate park.
Both intake copies were verified byte-identical.

Eight findings were independently re-verified against the worktree before being encoded,
because a review's citations are hints and not facts. All eight held. The plan's
"Verified facts" section now carries those six new rows with their own citations.

## Round 2 — in flight when the session ended

Dispatched as a detached `codex exec --sandbox read-only` against the revised plan.

- Prompt: `<scratchpad>/codex-round2-prompt.txt`
- Live output: `<scratchpad>/codex-round2-out.txt`
- Codex session logs live under `~/.codex/sessions/2026/07/29/`

**On resume, first check whether it finished** — the round-1 lesson is that these complete
after the session does. Look for a trailing `VERDICT:` line in the out-file, or find the
newest session jsonl and extract the last assistant message:

```
jq -r 'select(.payload.type=="message" and .payload.role=="assistant")
       | .payload.content[]?.text? // empty' <session.jsonl> | tail -c 40000
```

Only re-dispatch if no verdict exists anywhere. Round 2 of **max 3**; after three, surface the
disagreement to the map owner rather than looping.

Round 2 was asked to do three things, and its answer on each is what matters:
1. Verify each claimed fix actually holds in the revised text (an asserted-but-absent fix is
   itself a finding).
2. Hunt for defects **introduced** by the revisions — especially the `constructBatch`
   lock-order flip, the `IS TRUE` wrapping (does it reject anything intended to pass?), the
   new indexes, the `STEP_PERSONA` addition, and the widened `deriveRunDisplayState`.
3. Re-check anything it did not reach in round 1.

Then: get owner sign-off, run `bash scripts/feature-state.sh set-phase plan_approved`, and
only then begin T1.

## Owner decisions taken this session — do NOT re-litigate

Three round-1 findings landed on ground the owner had already locked. All three resolved:

- **G10 overruled (finding 7).** The original decision shipped `stalledThresholdMsForKind`
  unwired. Binding D15b (`executor-design:797`) requires `deriveRunDisplayState` itself to be
  kind-aware, and the gate read "deliberate dead code" as a knowing spec violation. **Now
  wired**: the input gains `kind`, `getReviewTimeline` passes it, `review_handler` resolves to
  the existing threshold so no display behaviour changes.
- **B4's unsubscribe column moves to #626 (finding 12).** B4 assigned #624 a column on
  `solicitation_unsubscribe_tokens`, but #626 owns that table's `CREATE TABLE` and it does not
  exist yet. T2 now ships cross-spec amendment **B8** recording the move; #630 depends on #626.
- **Intake re-signed (finding 6, with 17 folded in).** `solicitation_outreach` was absent from
  `TENANT_TABLES`, from which **both** `ci:rls-audit` and `ci:tenant-scope` derive coverage —
  the intake's own verification commands would have passed vacuously over the new table.
  Surface 24 → 27 globs, verification commands 4 → 14, `tests_to_add` 33 → 40, diff estimate
  bumped to `+1780/−60`, and the rollback plan corrected (finding 13) to restore **088's**
  constraint text, not 071's.

G1–G9 otherwise stand as locked. G1 now carries an explicit reconciliation note against
executor-spec §1066 so the deferred `QUEUE_NAMES`/helper is tracked debt, not an omission.

## The four revisions most likely to matter during execution

Full detail is in the plan; these are the ones a subagent could silently get wrong.

- **Lock order is the whole risk in T8.** One global order: **advisory lock first, then row
  locks.** The advisory lock **stays in `constructBatch`** — `prepareBatch` is a *separate*
  `sql.begin()`, so acquiring there releases it before the protected work runs. And
  `constructBatch` **flips** to take it above the `FOR UPDATE OF sb`, else purge
  (advisory→row) and construction (row→advisory) deadlock ABBA.
- **A Postgres CHECK passes on NULL.** 088's own asks idiom admits `('withhold', NULL)`.
  Every multi-arm CHECK in 091 is `IS TRUE`-wrapped, and the suite must assert NULL rejection
  against **every** reason-bearing status, not just the happy pairs.
- **`job_outbox` has no `batch_id` column** — only `topic`/`aggregate_type`/`aggregate_id`/
  `payload`. Both in-flight indexes are keyed `(topic, aggregate_id)`.
- **The archival redaction UPDATE must be bounded** — `LIMIT 5000` + `ORDER BY sent_at` +
  `FOR UPDATE SKIP LOCKED`, matching every other arm of that poller, and log saturation at the
  cap.

## Enforcement state

Hooks are **parked** (`.feature/intake.json` → `.feature/intake.parked.json`) — the sanctioned
way to end a session mid-feature with no gate evidence. The parked copy is byte-identical to
the committed audit copy; verify with `diff` on resume before trusting either.

**Re-arm before writing any code:**

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
- Replicate constraint text from the **current** definition. Which source is "current" differs
  per constraint — see the corrected reviewer note in T1. `terminal_consistency` and
  `one_active_per_subject` are frozen at **071**; the kind/subject/pairing/outcome constraints
  at **088**.
- Catalog queries use `pg_get_constraintdef` / `pg_get_expr`. **`pg_constraint.consrc` does not
  exist** — removed in Postgres 12.
- Live-DB suites: `*.integration.test.ts`, apply **no** migration SQL, `assertSchemaReady`;
  the migration-shape suite also needs `acquireLiveDbLock`. `TEST_DATABASE_POOL_URL` must be
  set or the gate's integration row is a loud SKIP and the work is **not** review-ready.
- Run `pnpm test:db:setup` after 091 lands, before the integration suites.

## Step 5 gate expectations

`bash scripts/verify-gate.sh` (and `--review` for the final pass). The `promised-tests` row
stays red until all **40** titles exist verbatim. The intake's `verification_commands` are now
the authoritative list (14 entries) and include `pnpm typecheck` and `pnpm build`.

## Ship lane

RISK=high: staging first (migration applies to the **staging** Supabase project first), verify,
then PR to `main` and PAUSE for explicit merge approval; apply to prod Supabase in lockstep at
promotion. This ticket holds the **only** migration slot — #625/#626/#627 are blocked until it
lands, and #626 now also owes B8's unsubscribe column.
