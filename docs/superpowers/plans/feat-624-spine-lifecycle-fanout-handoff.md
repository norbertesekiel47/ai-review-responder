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
| 3 Plan | **DONE.** Three gate rounds (20 → 11 → 6 findings, all REVISE). 36 of 37 findings accepted, 1 rejected. Owner closed the gate and signed off rather than spending a 4th round. |
| 4 Execute | **IN PROGRESS — T1 and T2 DONE.** T3–T8 remain. |

## Status at 2026-07-29 resume #2 — T1 IS COMPLETE, all four defects closed

`docs/superpowers/plans/feat-624-spine-lifecycle-fanout-deviations.md` carries the full
analysis of each. All four are now resolved; the doc's per-entry `### APPLIED` headers
record what landed and the evidence.

| # | Defect | State |
|---|---|---|
| 1 | 091's approval/halt consistency CHECKs reject every **unapproved** and every **non-halted** batch — `FALSE = NULL` collapses the conjunction and the `IS TRUE` wrapper turns that NULL into a rejection | **FIXED** — inner `IS TRUE` on both arms |
| 2 | 091's persona CHECK dropped D19 Correction 2's three cross-column exclusions, so promised title 15 cannot pass | **FIXED** — exclusions merged, title 15 green |
| 3 | The 088 shape suite applied 088 twice and committed, reverting 091's widening of three constraints on the shared test DB | **FIXED** in `b9ad24a6` |
| 4 | 091 is not re-runnable — §3's unconditional `DROP CONSTRAINT` fails once the outreach FK depends on it | **FIXED** — guarded `DO` block; three consecutive applies proven |

Defects 1, 2 and 4 were hook-blocked in the prior session: `migration-immutability-guard.sh`
treats 091 as applied, because T1 bumped `migrations-log.md` to head **091** in the same commit
as the migration (the documented convention) while staging and prod remain in lockstep at
**090**. The guard's own header names this exact false positive, and the map owner approved its
documented escape hatch (`MIGRATION_GUARD_DISABLE=1` at session launch) rather than shipping a
corrective 092, since 091 has never been pushed nor applied anywhere but the local test DB.
**Any future session that needs to amend 091 must be launched the same way.**

> The local test DB was re-provisioned from scratch (`pnpm test:db:setup`) **after** the patches
> landed, so it is now at-091-as-checked-in with no hand-patching. The earlier ad-hoc DDL is gone.

**Verification run at 2026-07-29 11:12, all green:** 091 suite **16/16** → 088 suite **7/7** →
091 suite **16/16** again (the ordering-independence proof) → 090 suite **15/15** →
`pnpm typecheck`, `pnpm lint`, `pnpm ci:live-db-suites`, `pnpm ci:outbox-status` all clean.
Re-runnability proven separately: `psql -f 091` twice more against the at-head DB, both
reaching `COMMIT` with exit 0.

## T2 is DONE (commit `4c91b352`)

ADR 0014 at status `accepted`, cross-spec amendments **B9/B10/B11** appended to the binding doc
(with §D's consequences list rewritten so `outreach_id` has exactly one owner, #626), and
`CONTEXT.md`'s new `## Solicitation (send-mode)` section defining Outreach row, Send batch
parent, Lazy child, Settled batch, Batch state, Body redaction and Halt latch.

**Remaining: T3 → T8.** T1 (which they were all blocked by) and T2 are done.

## Execution state — read this before touching anything

`.feature/state.json` phase is **`executing`**. Code now exists; this is no
longer a docs-only tree.

**T1 is COMPLETE** (commits `bac7340f`, `b9ad24a6`, plus the resume-session patches):
- `supabase/migrations/091_send_mode_spine_lifecycle.sql` — all seven parts, with
  defects 1/2/4 patched. Applies cleanly through the full local sequence
  (bootstrap + 001…091) and is genuinely re-runnable.
- `.claude/reference/migrations-log.md` — head 090 → 091, the full 091 entry, and
  a `solicitation_outreach` retention row.
- `src/lib/shared/__tests__/helpers/schema-ready.ts` — 091's migration→objects map entry.
- `src/lib/shared/__tests__/migration-091-send-mode-spine.integration.test.ts` —
  the shape suite, promised titles 1–16, all green. Holds `acquireLiveDbLock` and
  rolls back its re-apply, per the #573 convention.

**Verification already banked** (do not redo, but do encode as tests):
- Frozen constraints confirmed by introspection: `agent_runs_terminal_consistency`
  and `agent_runs_one_active_per_subject` still 071's;
  `agent_outcomes_unit_count_check` still 088's; `agent_runs_status_check` widened.
- The `auto_approval_policies` pairing CHECK rejects `reply+60`, `reply+sending`,
  `solicitation+15`; accepts `reply/posting/30`, `solicitation/sending/60`.
- The `IS TRUE` totality fix was proved empirically on the test DB.

> **Corrected 2026-07-29 (resume).** An earlier revision of this doc claimed here that the
> phase was still `worktree_ready` and that "round 2 has not returned a verdict". Both were
> stale — rounds 2 and 3 closed (see below, commits `fc4d533e` / `3e920a6b`), the owner closed
> the gate, and `state.json` is now **`executing`**.

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

## Round 2 is also done — `VERDICT: REVISE`, 11 findings, all accepted

Verbatim: `docs/reviews/feat-624-spine-lifecycle-fanout/plan-gate-codex-round2.md`.
Folded in at commit `fc4d533e`. 4 High / 6 Medium / 1 Low.

**Round 2 cleared every round-1 fix**, naming the riskiest explicitly: the `constructBatch`
lock-order flip preserves the ownership CAS and removes the ABBA edge. `IS TRUE` mechanics,
widened `deriveRunDisplayState`, `STEP_PERSONA`, the no-parent guard, the bounded archival CTE,
attempt uniqueness and lifecycle pairings all check out.

The four that mattered most:
- **`sent` is terminal but takes no reason** (`executor-design:377`). The plan conflated
  "terminal" with "reason-bearing", and the intake promised a test that **could not pass**
  against the intended CHECK. Both corrected; a positive `sent`-takes-NULL test added.
- **The veto widening loosened a live lane** — global `(15,30,60)` would let a `reply` row
  store 60, which `074:54` pins to `(15,30)`. The pairing CHECK now fixes action class *and*
  window per persona.
- **The redaction index was inverted** — Postgres B-trees index NULL keys, so
  `WHERE body_redacted_at IS NULL` alone holds every never-sent row forever. Needs
  `sent_at IS NOT NULL`.
- **`closeBatchIfSettled` was not idempotent** — `appendRunStep` always appends
  (`run-spine.ts:294`), so writing the step before the CAS let a second caller add a duplicate
  receipt. All writes now gate on the winning `send_closed_at` CAS.

**The procedural lesson, which applies to how round 1 was handled:** a rationale in the plan
**cannot amend a binding spec**. G1's deferral contradicts the §1066 checklist and the round-1
answer merely argued for it in a lower-precedence doc. It now ships as an amendment. Same
class of error produced the `B8` label collision.

## Round 3 — CLOSED, `VERDICT: REVISE`, all 6 findings folded in

Verbatim: `docs/reviews/feat-624-spine-lifecycle-fanout/plan-gate-codex-round3.md`.
Folded in at `3e920a6b`. **The owner then closed the gate** rather than spending a
fourth round — convergence was clear (20 → 11 → 6; High 13 → 4 → 2) and no finding
was disputed. Remaining review budget goes to the step-7 dual review of real code.

Two round-3 findings corrected **round-2 edits of mine**, which is the pattern to
watch if anyone reopens this:
- `closeBatchIfSettled` takes `{batchId, accountId, businessId}`. Round 2's answer
  ("it locks the batch row first, so it has the ids") fails because *that lock
  query is itself unscoped* and `solicitation_batches` is audited.
- `(business_id, queued_at)` was wrongly dropped in round 2. B3 removes the default
  *constant*; D19/D20's two-level cap survives via location-override rows.

Round 3 also settled the migration-safety question as a **proof**: 074 already pins
`persona='reply'`, `action_class='posting'`, `veto_window_minutes IN (15,30)`, so
the new reply arm cannot reject an existing row. No pre-flight data check needed.

## Superseded — how round 3 was dispatched (kept for the recovery recipe)

Dispatched as a detached `codex exec --sandbox read-only` against the twice-revised plan.

- Prompt: `<scratchpad>/codex-round3-prompt.txt`
- Live output: `<scratchpad>/codex-round3-out.txt`
- Codex session logs live under `~/.codex/sessions/2026/07/29/`

**If round 3 returns `REVISE`, do NOT start a round 4.** The rule is to stop and surface the
disagreement to the map owner — with a recommendation on each surviving finding, not just the
list. Round 3 was told it is the final round and asked to distinguish defects from stylistic
or speculative objections.

Round 3 was pointed at the likeliest self-inflicted wounds: whether pinning `reply` to
`(15,30)` **rejects a row that exists in production today** (i.e. is the constraint safe to
apply, or does it need a data check first — this is the one that could block the migration),
whether the CAS-first reordering breaks the no-send-parent guard or the settled-predicate
ordering, the new FK indexes, and whether B9/B10/B11 are internally consistent against the
binding doc's existing content.

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

**From round 2** — the dispatch-vs-purge race (finding 4). D6d's real race is purge during a
**live send**, and the send worker's provider call sits between two transactions where no
`pg_advisory_xact_lock` holds. #624 builds no send worker and cannot close it. **Decision:
#624 defines the contract, #630 is bound to it** — the helper is documented as
transaction-scoped with the trap named at the helper, ADR 0014 records that an in-flight send
must be visible to purge in *committed state*, and amendment **B11** makes it #630's
obligation. Explicitly out of scope for #624; do not let a subagent build it.

**From round 1** — three findings landed on ground the owner had already locked. All resolved:

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

## The revisions most likely to matter during execution

Full detail is in the plan; these are the ones a subagent could silently get wrong.

- **`sent` is terminal AND takes a NULL reason.** "Terminal" and "reason-bearing" are
  different partitions. Reason-bearing is `withheld|cancelled|failed|unknown`; NULL-reason is
  `rendered|queued|sending|sent`.
- **Pin the veto window per persona**, not globally — `reply` stays `(15,30)`.
- **Gate every `closeBatchIfSettled` write on the `send_closed_at` CAS**, because
  `appendRunStep` always appends.
- **Two queries need `tenant-scope-allowlist.ts` entries** (T6's redaction sweep, T7's health
  query). The audit matches SQL text **exactly**, so the entry and the query must be edited in
  lockstep — this is a live tripwire, not a one-time chore.
- **Amendments are B9/B10/B11**; `B8` exists. B9 must also edit §D's consequences list.

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

## Two things carried out of #624 that are NOT #624's to fix

- **Migration 088 has a live NULL hole.** `solicitation_asks_status_reason_consistency`
  admits `('withhold', NULL)` — that arm evaluates to NULL and `FALSE OR NULL` is
  NULL, which a CHECK accepts. Proved empirically against the test DB while
  writing 091. 091 is immune (`IS TRUE` throughout); the asks table is not.
  Pre-existing, deliberately out of scope, worth its own ticket. Flagged to the
  owner; no decision taken.
- ~~**`.env.local` declares `TEST_DATABASE_POOL_URL` twice**~~ — **withdrawn on resume, this
  was wrong.** Line 292 is *commented out*; line 301 is the single active declaration. dotenv
  never sees two values, so there is no silent-skip risk and nothing to clean up.

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
stays red until every title in the intake's `tests_to_add` exists verbatim — **52** as re-signed,
not the 48 an earlier revision of this doc quoted. Read the count from `.feature/intake.json`,
never from here. The intake's `verification_commands` are now
the authoritative list (18 entries) and include `pnpm typecheck`, `pnpm build`,
`ci:db-imports`, `ci:feature-surface`, `ci:live-db-suites` and `ci:outbox-seam`.

## Ship lane

RISK=high: staging first (migration applies to the **staging** Supabase project first), verify,
then PR to `main` and PAUSE for explicit merge approval; apply to prod Supabase in lockstep at
promotion. This ticket holds the **only** migration slot — #625/#626/#627 are blocked until it
lands, and #626 now also owes B8's unsubscribe column.
