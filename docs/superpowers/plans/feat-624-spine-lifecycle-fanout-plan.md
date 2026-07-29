# #624 — Spine lifecycle + physical fan-out primitives (implementation plan)

Ticket #624 of wayfinder map #617. Governing docs, in precedence order:

1. `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` (**BINDING** — supersedes the specs where they conflict)
2. `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` §9 (migration shape), §1/§3/§5, §9A, §10
3. Gap analysis #618: `git show origin/research/send-mode-executor-gap:docs/research/2026-07-28-send-mode-executor-gap.md`

Intake contract: `.feature/intake.json` (arming copy) / `docs/superpowers/plans/feat-624-spine-lifecycle-fanout-intake.json` (audit copy).

This ticket owns **the one migration slot**. #625/#626/#627 queue behind it.

---

## Verified facts (checked against the worktree, not assumed)

These were confirmed before planning; a reviewer should not have to re-derive them.

| Claim | Verified |
|---|---|
| Migration head is 090; next is 091 | `.claude/reference/migrations-log.md:4` |
| ADR head is 0013; next is 0014 | `ls docs/adr/` |
| `agent_runs_status_check` is an **inline column CHECK** in 071 (auto-named), text `status IN ('running','completed','failed')` | `071:22-23` |
| `agent_runs_terminal_consistency` is `(status='running') = (ended_at IS NULL)` — a terminal `cancelled` row with `ended_at` set is `FALSE = FALSE`, **unchanged** | `071:28-29` |
| `agent_runs_one_active_per_subject` is `WHERE status='running'` — never covered terminal rows, so **unchanged** | `071:40-42` |
| Current `agent_runs_kind_check` / `subject_type_check` / `kind_subject_type_pairing` text is **088's**, not 071's | `088:63-77` |
| `agent_outcomes_unit_count_check` was already widened by **088** to `unit_count > 0 OR (outcome_kind='solicitation_batch_built' AND unit_count=0)` — "unchanged" means leaving *this* text | `088:104-109` |
| `agent_runs (account_id, business_id, id)` composite unique **exists** (088) | `088:20-33` |
| `solicitation_batches (id, account_id, business_id)` composite unique **exists** (088) | `088:128` |
| `solicitation_asks` carries **only** the unique constraints PK + `(batch_id, contact_id)` — it does also carry FKs and CHECKs, but the composite unique genuinely does **not** exist | uniques `088:159`; FKs/CHECKs `088:160-178` |
| `ci:outbox-topics` scans `src/lib`+`src/app`+`worker` only — a migration-only index cannot trip it | `scripts/ci/outbox-topics-audit.ts:23` |
| `ci:outbox-status` **does** scan `supabase/migrations/` for the in-flight literal, members-and-order | `outbox-status-audit.ts:49,54` |
| `deriveRunDisplayState` has exactly **one** production caller, `getReviewTimeline`, whose query is hard-filtered `ar.kind = 'review_handler'` | `read.ts:326,390` |
| `RunDisplayState` is consumed by `RunStateBadge.tsx` via `Record<RunDisplayState, string>` (adding a member is a compile error) + 5 CSS selectors | `RunStateBadge.tsx:3`, `console.css:644-658` |
| Purge takes `acquireCsvIngestLock` per business; `solicitation_asks` has **no** explicit DELETE (cascades from uploads→batches) | `purge-stages.ts:259-290` |
| `acquireCsvIngestLock` is the named-helper precedent, owned by `ingest.ts`, and the purge imports it | declared `ingest.ts:374-379`; imported `purge-stages.ts:11` |
| The `solicitation_batch_<business>` advisory key is currently **hand-spelled inline** in batch-builder | `batch-builder.ts:605-609` |

Six further facts were established by the round-1 plan gate (all independently re-verified
against this worktree before being encoded below):

| Claim | Verified |
|---|---|
| A Postgres CHECK rejects only `FALSE`; it **passes on NULL**. 088's own `solicitation_asks_status_reason_consistency` therefore admits `('withhold', NULL)` — the `IN (...)` arm evaluates to NULL and `FALSE OR NULL` is NULL | idiom `088:169-178`; the trap is documented at `090:23-27` |
| `job_outbox` has **no `batch_id` column** — only `topic`, `aggregate_type`, `aggregate_id`, `payload` | `001:301-306` |
| `constructBatch` takes the batch **row lock first**, then the advisory lock; `prepareBatch` is a **separate** `sql.begin()` transaction, so `pg_advisory_xact_lock` taken there is released before construction runs | `batch-builder.ts:190`, `:589-609` |
| Every existing `ArchivalPoller` arm bounds work with a `LIMIT 5000` candidate CTE | `ArchivalPoller.ts:39` |
| `STEP_PERSONA` has **no** send-close key, and `RecordStepInput` accepts only that closed union — an unnamed step key is a compile error, not a runtime one | `run-spine.ts:54-67`, `:285` |
| `solicitation_outreach` is absent from `TENANT_TABLES`, from which **both** `ci:rls-audit` and `ci:tenant-scope` derive coverage; its siblings `solicitation_batches`/`solicitation_asks` are present | `tenant-tables.ts:30-36`; consumers `rls-audit.ts:5`, `tenant-scope-audit.ts:257` |

---

## Decisions locked in grilling (deltas the spec left open)

Nine forks were resolved with the map owner. Recorded here because downstream tickets inherit them.

| # | Fork | Decision |
|---|---|---|
| G1 | Where the outbox topic constants + typed helpers land | **091 creates the two in-flight indexes only.** `QUEUE_NAMES` entries and `enqueueSolicitationSend`/`enqueueGenerateSolicitationAsks` ship with their producers (#628/#630). Safe because `ci:outbox-topics` does not scan migrations. **Reconciliation with executor spec §1066** (which bundles index+helper+`QUEUE_NAMES` in one step): the spec's checklist assumes one ticket owns topic and producer; here the map splits them across the migration slot and the producers. The index is inert until a producer exists, so the split is safe in the only direction that matters — an index with no writer costs nothing, a writer with no index races. #628/#630 inherit the obligation to add `QUEUE_NAMES` + the typed helper **in the same PR as their first raw insert**, or `ci:outbox-seam` fails them. Recorded here so the deferral is a tracked debt, not an omission. |
| G2 | What a `cancelled` run displays as | **New `RunDisplayState` member `'cancelled'`.** Folding it into `completed` would reintroduce the exact lie D4 exists to prevent. |
| G3 | Body-presence CHECK vs withheld rows | **Keyed on `delivery_status` too.** A `render_failed`/`moderation_high` withhold never had a body; the literal spec wording would force #628 to synthesize one. |
| G4 | `deriveBatchState` ownership | **Ships in #624** alongside `closeBatchIfSettled`, in `src/lib/solicitation/outreach.ts`. It is a pure function over columns 091 creates. |
| G5 | `unknown` ↔ reason | **`unknown` ⇒ `send_indeterminate` exclusively**; `failed` ⇒ `send_failed`/`send_exhausted`. An `unknown`/`send_failed` row is a contradiction and is made unrepresentable. |
| G6 | Constants placement | **Co-located with consumers** (windows → `outreach.ts`, `BODY_RETENTION_DAYS` → `ArchivalPoller.ts` beside `AGENT_SPINE_RETENTION_DAYS`, threshold → `read.ts` beside `STALLED_RUNNING_THRESHOLD_MS`). §8's cap constants are **omitted** — they conflict with amendment B3 and belong to #630/#631. |
| G7 | Lazy child writer | **Thin focused seam** `startOrGetSolicitationAskRun`, mirroring `startOrGetSolicitationBatchRun`. Its job is type-level: make `businessId`/`parentRunId` non-optional so a NULL cannot reach `agent_runs_parent_business_required`. |
| G8 | Advisory lock helper home | **`batch-builder.ts`, exported** — the `ingest.ts`/`acquireCsvIngestLock` precedent exactly. |
| G9 | Purge shape | **Cascade + inventory entry + verification query + the lock.** No explicit DELETE, matching how `solicitation_asks` is already handled. |

### G10 — D15b's consumer question (revised after the round-1 plan gate)

D15b asks `deriveRunDisplayState` to gain a kind-aware 11-day stalled threshold. Planning
observed that its only caller filters `kind='review_handler'`, so no send-batch run can reach
it today, and originally resolved to export `stalledThresholdMsForKind(kind)` while leaving
`deriveRunDisplayState`'s signature alone.

**The plan gate rejected that** (round-1 finding 7): D15b is binding
(`executor-design:797`), and the original resolution shipped the helper as deliberate dead
code — which the gate correctly read as a knowing spec violation rather than a deferral.

**Revised decision, confirmed with the map owner: follow D15b and wire it now.**
`deriveRunDisplayState` takes `kind` as an input, `getReviewTimeline` selects and passes it,
and the derivation calls `stalledThresholdMsForKind` instead of the bare
`STALLED_RUNNING_THRESHOLD_MS`. Behaviour for the one live caller is **unchanged** —
`review_handler` maps to the existing threshold — so this is a pure widening with no display
change, and the helper has a real consumer on the day it lands. D15c's `HealthAlertPoller`
check queries `agent_runs` directly and is unaffected either way.

---

## Module design (deep-module discipline)

Applying the deletion test to each new interface:

- **`closeBatchIfSettled(tx, batchId)` — genuinely deep, and the module of this ticket.**
  One function + one id hides: the settled predicate, the batch-row lock taken first
  (domain-before-spine, matching `batch-builder`'s documented order), counting outreach rows
  by status, deriving D14's `disposition` from those counts, mapping disposition → parent
  terminal status, writing the parent step with `withheld_by_reason`, and terminalizing.
  Deleting it makes that complexity reappear in **four** future call sites (#630's send-worker
  terminal tx, the halt tx, the failed-hook, and the releaser backstop) which would all have
  to agree exactly. D11 explicitly demands one implementation with two-plus callers so the
  backstop cannot drift from the inline path.

- **`deriveBatchState(row, now)` — deep enough, and pure.** Hides D2's 8-way precedence
  (`halted > closed > sending > veto_window > approved > expired > built > pending`) and both
  window computations. Takes `now` as a parameter rather than reading the clock — that is what
  makes the property test possible and keeps it a result-returning function rather than a
  side-effecting one.

- **`startOrGetSolicitationAskRun` — shallow by the letter, and that is stated honestly.**
  It delegates to the existing `startOrGetActiveRunInternal`. It earns its place the same way
  its sibling `startOrGetSolicitationBatchRun` does (see that function's own docstring): the
  depth is **type-level**, not behavioural. The generic writer types `businessId` as
  `string | null` and `parentRunId` as optional; this seam makes both required, so
  `agent_runs_parent_business_required` cannot be violated and MATCH SIMPLE composite FKs
  cannot silently skip validation on a NULL. Not invention — precedent plus an invariant.

- **`stalledThresholdMsForKind(kind)` — a pure lookup with a real consumer.** One owner for
  "how long may a run of this kind legitimately run," called from inside
  `deriveRunDisplayState` (T4) and reused by T7's health check so the 11-day number is spelled
  once. See G10.

No new top-level directory. One new file (`src/lib/solicitation/outreach.ts`), justified: its
contents are the batch-lifecycle read model and the join primitive, which belong neither in
`batch-builder.ts` (build-time, already 600+ lines and carrying a fallow complexity finding)
nor in `batch-view.ts` (the watch-mode Requests read model, whose `parseEvidence` contract is
about ask evidence, not delivery).

---

## Tracer bullets

Each task is a thin vertical slice — schema + code + tests together where possible — and
declares its blocking edges. Glossary terms (**Outreach**, **Solicitation batch**, **Ask**,
**Restraint policy**, **Withhold reason**) are used verbatim per `CONTEXT.md`.

### T1 — Migration 091 + schema-ready map + migrations-log entry
**Blocks:** T3, T5, T6, T7, T8 · **Blocked by:** none

Invoke the `new-migration` skill before writing SQL, and `outbox-pattern` before the two
`job_outbox` indexes.

`supabase/migrations/091_send_mode_spine_lifecycle.sql`, additive / re-runnable / transactional,
in this order (FK prerequisites first):

1. **`agent_runs`** — drop+add `agent_runs_status_check` with `'cancelled'` appended
   (`status IN ('running','completed','cancelled','failed')`). Drop+add `agent_runs_kind_check`
   replicating **088's** text plus `'solicitation_send_batch'`. Drop+add
   `agent_runs_kind_subject_type_pairing` replicating 088's four pairs plus
   `(kind='solicitation_send_batch' AND subject_type='solicitation_batch')` — note
   `subject_type` needs **no** change, `'solicitation_batch'` is already a member and now
   pairs with two kinds. **`agent_runs_terminal_consistency` and
   `agent_runs_one_active_per_subject` are NOT touched** — a header comment must say so, in
   088's own idiom ("intentionally not replaced").
2. **`agent_outcomes`** — drop+add `agent_outcomes_outcome_kind_check` replicating 088's text
   plus `'solicitation_sent'`, `'review_attributed'`. **`agent_outcomes_unit_count_check` is
   NOT touched** — leave 088's `unit_count > 0 OR (outcome_kind='solicitation_batch_built' AND
   unit_count=0)` exactly as-is; both new kinds carry `unit_count=1`, so #618 §1.2(c)'s
   second-zero-legal-kind hazard never fires.
3. **`solicitation_asks`** — `ADD CONSTRAINT solicitation_asks_account_business_id_uniq
   UNIQUE (id, account_id, business_id)`, guarded `IF NOT EXISTS`-style per 088's
   `pg_constraint` `DO` block. **Must precede §5's ask FK** or apply fails.
4. **`solicitation_batches`** — add `approved_at`, `approval_method`
   (`CHECK IN ('owner','auto_policy')`), `approved_by_user_id`, `veto_deadline_at`,
   `sending_started_at`, `send_closed_at`, `halted_at`, `halt_reason` (closed CHECK:
   `owner_veto|owner_halt|admin_halt|send_window_elapsed|batch_expired`), `halted_by`.
   Ordering CHECKs in the existing `built_at`/`reviewed_at` idiom. Plus D8's partial unique
   `solicitation_batches_one_active_send_per_business ON (business_id) WHERE approved_at IS NOT
   NULL AND send_closed_at IS NULL AND halted_at IS NULL`.

   > **Lifecycle pairing CHECKs — spell these NULL-safely and exactly** (round-1 finding 4).
   > A bare `approval_method IN (...)` plus a halt-reason domain leaves approved batches with
   > no method and halted batches with no reason. Both pairings are therefore two-way and
   > written so NULL cannot slip through:
   > - `(approved_at IS NULL) = (approval_method IS NULL)` — and `approved_by_user_id IS NOT
   >   NULL` exactly when `approval_method = 'owner'` (an `auto_policy` approval has no user).
   > - `(halted_at IS NULL) = (halt_reason IS NULL)`, with `halted_by IS NOT NULL` exactly when
   >   `halt_reason IN ('owner_veto','owner_halt','admin_halt')` — `send_window_elapsed` and
   >   `batch_expired` are system-derived and have no actor.
   >
   > **Do not add a blanket "closed implies approved" CHECK.** Two legitimate closures precede
   > approval: D14's `generation_failed` and B7's batch expiry
   > (`amendments:161`). `send_closed_at IS NOT NULL` must be legal with `approved_at IS NULL`.
   > `sending_started_at IS NOT NULL` is the one that genuinely implies `approved_at IS NOT
   > NULL`, and that is the only ordering CHECK tying the two halves together.
5. **`solicitation_outreach`** — the new table. Column list is **#619 §3 D5 as amended by
   B1/B2**: D5's columns, **minus `policy_version`** (dropped per B1), **plus** `source TEXT NOT
   NULL CHECK (source IN ('llm'))` (no `'owner_edit'` — struck by B2), `ask_lint_version`,
   `lint_detail JSONB NOT NULL`, `moderation_status` (`clean|flagged|error|disabled`),
   `moderation_detail JSONB NOT NULL`, `interpolation_inputs JSONB NOT NULL`, `prompt_hash`,
   and the nullable consent snapshot `consent_basis` / `consent_attestation_version` /
   `consent_row_id` (stamped at dispatch by #630, not here). Five composite tenant FKs exactly
   as §3 spells them. Then:
   - `delivery_status` CHECK: `rendered|queued|sending|sent|withheld|cancelled|failed|unknown`
   - `disposition_reason` ↔ status consistency CHECK per **G5**: withhold set for
     `withheld`; cancel set **including `superseded`** (B2) for `cancelled`;
     `send_failed|send_exhausted` for `failed`; `send_indeterminate` **only** for `unknown`;
     `IS NULL` for `rendered|queued|sending|sent`.

     > **Follow the asks idiom's *shape*, not its text — it has a NULL hole**
     > (round-1 finding 1). `status = 'withhold' AND withheld_reason IN (…)` evaluates to
     > NULL when the reason is NULL, and `FALSE OR NULL` is NULL, which a CHECK **accepts**.
     > 088 admits `('withhold', NULL)` today for exactly this reason. Over an 8-value
     > `delivery_status` domain that hole is much wider. Close it by wrapping the whole
     > disjunction in `IS TRUE` — `CHECK ((… OR … OR …) IS TRUE)` — which is one edit, cannot
     > be forgotten per-arm, and is the same defensive move 090 made with
     > `IS NOT DISTINCT FROM`. The integration suite must assert a NULL reason is rejected
     > against **every** reason-bearing status, and accepted against all four non-terminal ones.
   - body-presence CHECK per **G3**, stated as three exhaustive rules rather than one
     disjunction (round-1 finding 3 — the original wording admitted a `queued` row with both
     bodies NULL and a redaction stamp):
     - bodies are **paired**: `(rendered_subject IS NULL) = (rendered_body IS NULL)`
     - redaction means gone **and** sent: `body_redacted_at IS NOT NULL` implies
       `rendered_subject IS NULL AND sent_at IS NOT NULL` (per `executor-design:403`)
     - every unredacted, non-`withheld` row **has** its bodies: `body_redacted_at IS NULL AND
       delivery_status <> 'withheld'` implies `rendered_subject IS NOT NULL`.
       `queued`/`sending` are dispatchable (`executor-design:377`) and must never be bodyless.

     Wrap in `IS TRUE` on the same reasoning as above.
   - partial unique `(ask_id) WHERE delivery_status IN ('rendered','queued','sending')` — the
     **live-attempt** unique. Per B2, attempt identity must also be durable across
     supersession (round-1 finding 14), so add `CHECK (attempt_no > 0)` and
     `UNIQUE (ask_id, attempt_no)`. The two coexist: the partial unique says "one live attempt
     per ask", the full unique says "attempt numbers are never reused". Header comment states
     the writer contract B2 requires — **update the old row to a terminal status first, then
     insert `attempt_no + 1`**, both in one transaction.
   - `(batch_id, delivery_status)` — serves `closeBatchIfSettled`'s settled predicate and count
   - `(account_id, queued_at)` — the daily-cap index. **Not `(business_id, sent_at)`**
     (round-1 finding 2): B3 supersedes D9's `sent_at` counting with **dispatch attempts by
     `queued_at`**, and drops `DEFAULT_DAILY_SEND_CAP_BUSINESS` as a dead knob, leaving a
     single account-wide ceiling (`amendments:90`). A per-business index would serve no
     reviewed query and #630 would need another migration slot to fix it.
   - `(sent_at) WHERE body_redacted_at IS NULL` — the partial index T6's redaction sweep needs;
     it stays small because rows leave it permanently once redacted
   - RLS: owner SELECT with the D6a moderation carve-out; service role full
   - **register the table in `scripts/ci/tenant-tables.ts`** (round-1 finding 6). Without it
     both `ci:rls-audit` and `ci:tenant-scope` derive zero coverage for the new table and the
     intake's own verification commands pass vacuously. Its siblings
     `solicitation_batches`/`solicitation_asks` are already registered.
6. **`auto_approval_policies`** — widen `persona` with `'solicitation'`, `action_class` with
   `'sending'`, `veto_window_minutes` to `(15,30,60)`; add `daily_send_cap SMALLINT` (`NULL OR
   1..50`); add D19's cross-persona consistency CHECK. **Widening the two columns independently
   admits nonsense pairs** — `reply`+`sending` and `solicitation`+`posting` (round-1 finding
   15). D19's proposed CHECK constrains only the dial columns, so add the pairing explicitly:
   `(persona='reply' AND action_class='posting') OR (persona='solicitation' AND
   action_class='sending')`, `IS TRUE`-wrapped. `daily_send_cap` is meaningful only for the
   solicitation arm; the resolver's platform ceiling of 10 (B3) lives in code, not the CHECK,
   so the `1..50` column domain stays as spec'd.
7. **`job_outbox`** — the two partial unique in-flight indexes, each spelling
   `status IN ('pending','dispatching','dispatched')` in **members-and-order** per
   `src/lib/shared/job-outbox-status.ts`. Both are keyed `(topic, aggregate_id)`:
   **`job_outbox` has no `batch_id` column** (round-1 finding 11 — the table carries only
   `topic`, `aggregate_type`, `aggregate_id`, `payload`, `001:301`), so the original wording
   was invalid SQL. `generate_solicitation_asks` stores the batch id in `aggregate_id`,
   matching the existing batch helper at `job-outbox-helpers.ts:604`; `solicitation_send`
   stores the outreach id. Per **G1**, no `QUEUE_NAMES` entry and no helper.

Also in T1: update `src/lib/shared/__tests__/helpers/schema-ready.ts`'s migration→objects map,
and add the 091 entry to `.claude/reference/migrations-log.md`.

Live-DB suite `src/lib/shared/__tests__/migration-091-send-mode-spine.integration.test.ts`,
following the 090 precedent: `*.integration.test.ts`, **no migration SQL applied at run time**,
`assertSchemaReady`, and `acquireLiveDbLock` since it is a migration-shape suite. Covers
promised titles 1–16.

> Reviewer note (corrected after round 1, finding 19): the constraint-frozen assertions must
> read **`pg_get_constraintdef`** and `pg_get_expr`/`pg_indexes.indexdef` — **not
> `pg_constraint.consrc`**, which Postgres removed in 12 and does not exist on our 16. The
> precedent to copy is `migration-088-solicitation-batch-executor.integration.test.ts:145`.
>
> On *which* text to compare against, both sources are in play and the earlier one-line
> instruction was too coarse:
> - `agent_runs_terminal_consistency` and `agent_runs_one_active_per_subject` are frozen at
>   their **071** definitions — 088 never touched them, and 091 must not either.
> - `agent_runs_kind_check`, `subject_type_check`, `kind_subject_type_pairing`, and
>   `agent_outcomes_unit_count_check` are frozen at their **088** definitions.
>
> The suite asserts each against its own origin. Replicating a 088-widened constraint from
> 071's text is the specific regression this guards.

> **Not in 091 — B4's unsubscribe column** (round-1 finding 12). Binding amendment B4
> (`amendments:208`) assigns #624 a `solicitation_unsubscribe_tokens.outreach_id UUID UNIQUE`,
> but #626's suppression spec owns that table's `CREATE TABLE`
> (`suppression-unsubscribe-design:735`) and it does not exist yet — 091 cannot add a column to
> it. **Resolved with the map owner: the column moves to #626's `CREATE TABLE`.** A
> cross-spec amendment recording this ships in T2 alongside the ADR; #630 depends on #626 for
> it, not on #624.

### T2 — ADR 0014 + CONTEXT.md glossary
**Blocks:** none · **Blocked by:** none (can run in parallel with T1)

Extract Appendix A verbatim to `docs/adr/0014-send-mode-spine-lifecycle.md`, status
`accepted` (Appendix A says "proposed (accept with #624)" — this *is* #624). Fix the two
malformed nested-backtick references to the gap analysis that Appendix A carries. Add a
Consequences bullet recording the revised **G10** (D15b wired at its one caller, behaviour
unchanged for `review_handler`).

Also in T2 — **one cross-spec amendment**, appended to
`docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` as B8: B4's
`solicitation_unsubscribe_tokens.outreach_id` moves from #624 to **#626**, which owns that
table's creation. Ticket #630 takes its dependency on #626 accordingly. Amending the binding
doc rather than silently diverging from it is the point — see the T1 note.

Add a `## Solicitation (send-mode)` section to `CONTEXT.md` defining the terms this ticket
makes real, extending — not contradicting — the existing watch-mode entries, which already
reserve "Outreach" for send-mode's actual sends:
**Outreach row**, **Send batch parent**, **Lazy child**, **Settled batch**, **Batch state**
(naming that watch-mode's deferred `expired` lands here), **Body redaction**, **Halt latch**.

### T3 — run-spine: `cancelled`, new kinds/outcomes, fail union, lazy child seam
**Blocks:** T4, T5 · **Blocked by:** T1

`src/lib/agents/run-spine.ts`:
- `AGENT_RUN_KINDS` += `'solicitation_send_batch'`; `StartRunInput` gains the discriminated
  arm `{ kind: 'solicitation_send_batch'; subjectType: 'solicitation_batch' }` — keeping the
  DB pairing CHECK unrepresentable to violate in TS, as the existing comment promises.
- `AGENT_OUTCOME_KINDS` += `'solicitation_sent'`, `'review_attributed'`.
- `transitionRunToTerminal` / `completeRun` status param widens to
  `'completed' | 'cancelled' | 'failed'`. The `WHERE status='running'` CAS and the
  already-terminal no-op branch are unchanged.
- `SolicitationBatchRunFailure` gains the `generation_failed` arm (D14).
- **New** `startOrGetSolicitationAskRun(tx, {askId, accountId, businessId, parentRunId})` per
  **G7** — `businessId` and `parentRunId` both required, delegating to
  `startOrGetActiveRunInternal`. Docstring states the type-level job explicitly.
- **New `STEP_PERSONA` key `send_batch_closed: 'solicitation'`** (round-1 finding 8). T5's
  `closeBatchIfSettled` must write a terminal parent step, but `RecordStepInput` accepts only
  the closed `AgentStepKey` union derived from `STEP_PERSONA` (`run-spine.ts:285`), which has
  no send-close member — so as planned T5 could not compile. Adding the key here rather than
  in T5 keeps the spine's single-writer vocabulary owned by the spine module. Its attribution
  (`solicitation`) and detail contract are tested alongside the other keys.

Covers promised titles 17–19.

### T4 — `cancelled` display state + `stalledThresholdMsForKind`
**Blocks:** none · **Blocked by:** T3

- `read.ts`: `RunDisplayState` += `'cancelled'`; the run row `status` type widens; a
  `run.status === 'cancelled'` branch returns `'cancelled'` (placed with the existing
  completed/failed early returns, before the waiting-on-owner check).
- `read.ts`: export `stalledThresholdMsForKind(kind)` + `STALLED_THRESHOLD_SEND_BATCH_DAYS = 11`
  beside `STALLED_RUNNING_THRESHOLD_MS`, and **wire it into `deriveRunDisplayState`** per the
  revised **G10** (round-1 finding 7): the input gains `kind`, `getReviewTimeline` selects
  `ar.kind` and passes it, and the stalled branch compares against
  `stalledThresholdMsForKind(kind)` rather than the bare constant. `review_handler` resolves to
  the existing threshold, so **no display behaviour changes** for the one live caller — the
  test for that non-change is one of the promised titles.
- `RunStateBadge.tsx`: `STATE_LABELS` gains `cancelled: 'Cancelled'` (the `Record` type makes
  this a compile error until done — that is the intended forcing function).
- `console.css`: a `.timeline-run-state--cancelled` selector. Distinct from both the
  sage completed group and the danger failed group — cancelled is neither success nor error.
  Use existing `--rw-*` tokens only; invoke `repworth-brand-design` before picking.

Covers promised titles 20–22.

### T5 — `src/lib/solicitation/outreach.ts`
**Blocks:** none · **Blocked by:** T1, T3

New module, `sql`/`tx` as explicit parameters (invariant #15), no `@/lib/db/server` import.

- `BATCH_APPROVAL_WINDOW_DAYS = 7`, `BATCH_SEND_WINDOW_HOURS = 72` (G6).
- `deriveBatchState(row, now)` → the D2 precedence union. Pure; `now` is a parameter.
- `closeBatchIfSettled(tx, batchId)` → lock the batch row **first** (domain-before-spine),
  evaluate the settled predicate (`NOT EXISTS … delivery_status IN ('rendered','queued',
  'sending')`), and when settled: count by status, derive D14's `disposition`, write the
  parent step carrying `{disposition, sent, withheld, cancelled, failed, unknown,
  withheld_by_reason}`, stamp `send_closed_at`, and terminalize the parent via the D4 lookup
  (`exhausted`→`completed`; `halted`/`expired`→`cancelled`;
  `gate_closed`/`generation_failed`→`failed`). Idempotent: a second call on an already-closed
  batch is a no-op, since `transitionRunToTerminal` already no-ops on a terminal run and
  `send_closed_at` is CAS'd on NULL.

  > **Guard the zero-outreach case before the settled predicate** (round-1 finding 9).
  > `NOT EXISTS` is **vacuously true** over zero rows, so a batch with no outreach and no send
  > parent would sail through, get counted, stamped `send_closed_at`, and terminalized —
  > contradicting the intake, which requires no mutation when no send parent exists. Order the
  > function: resolve the send parent run **first**; if there is none, return
  > `{ status: 'no_send_parent' }` without touching a row. Only then take the settled
  > predicate. The omitted live-DB test for this is added to the promised titles.

Property test with `fast-check` for `deriveBatchState` (house style: the `invariants` describe
block in `src/lib/reviews/__tests__/sentiment.test.ts`) — arbitrary combinations of the eight
timestamps yield exactly one state, and the precedence order holds pairwise.
The concurrent-close test is a live-DB `*.integration.test.ts`.

Covers promised titles 23–28.

### T6 — ArchivalPoller body redaction (D6c)
**Blocks:** none · **Blocked by:** T1

`worker/background/pollers/ArchivalPoller.ts`: add `BODY_RETENTION_DAYS = 90` beside
`AGENT_SPINE_RETENTION_DAYS = 180`, and a redaction step inside the existing `runArchival`
cycle, following the existing `make_interval` idiom. **The UPDATE must be bounded** exactly
like every other arm of this poller (round-1 finding 10 — `ArchivalPoller.ts:39` caps at
`LIMIT 5000`; an unbounded first sweep over a large backlog can hit the 30s
`statement_timeout` repeatedly and never make progress, which is a silent no-op dressed as a
running poller):

```
WITH candidates AS (
  SELECT id FROM solicitation_outreach
  WHERE sent_at < NOW() - make_interval(days => 90)
    AND body_redacted_at IS NULL
  ORDER BY sent_at
  LIMIT 5000
  FOR UPDATE SKIP LOCKED
)
UPDATE solicitation_outreach SET rendered_subject = NULL, rendered_body = NULL,
  body_redacted_at = NOW() WHERE id IN (SELECT id FROM candidates)
```

`ORDER BY sent_at` makes progress monotonic (oldest first), `SKIP LOCKED` keeps it from
blocking on a row a send worker holds, and the partial index from T1 §5 serves the candidate
scan. When the count comes back at the cap, log it as **saturated** so a persistent backlog is
visible rather than inferred. **No new poller**
(D6c: this map grows the P2 single-replica list by exactly one, and D7 already spent it).
Emit the redacted row count into the existing cycle log. Never log a body (D6e: string args
are logged verbatim).

Covers promised titles 29–30.

### T7 — HealthAlertPoller stalled-send-batch check (D15c)
**Blocks:** none · **Blocked by:** T1, **T4** (round-1 finding 16 — T7 consumes the
`stalledThresholdMsForKind` constant T4 creates; the edge was missing)

`worker/background/pollers/health-alert/checks.ts`: `checkStalledSendBatches(sql, cfg)`
returning a `HealthFinding | null`, one query, registered in `runHealthChecks` alongside the
other core checks (sequential, per that file's documented shared-fate reasoning). Finding key
`solicitation_send_batch_stalled`. Threshold sourced from the same 11-day constant as T4 so
there is one owner. Detail carries run id + age; never PII.

Covers promised title 31.

### T8 — Offboarding purge: lock extraction + inventory + verification (D6d)
**Blocks:** none · **Blocked by:** T1

> **Lock order is the whole risk in this task** (round-1 finding 5 — the original wording had
> two independent defects). Establish and document **one global order: advisory lock first,
> then row locks.** Both defects follow from violating it:
>
> 1. *Do **not** move the acquire into `prepareBatch`.* `prepareBatch` and `constructBatch` are
>    **separate** `sql.begin()` transactions (`batch-builder.ts:190`, `:579`), and
>    `pg_advisory_xact_lock` releases at transaction end — so acquiring in `prepareBatch` would
>    release the lock *before* the work it protects ever runs. The lock stays in
>    `constructBatch`, the transaction that needs it.
> 2. *Flip `constructBatch` to take the advisory lock before the batch row lock.* It currently
>    does row-then-advisory (`:589` then `:605`). Purge takes advisory-then-row (it holds
>    `csv_ingest_<business>` and then cascades deletes, which take row locks on batches). Adding
>    a second advisory lock to purge without flipping this gives a textbook ABBA deadlock:
>    purge holds `solicitation_batch_<business>` and wants the batch row, construction holds
>    the batch row and wants `solicitation_batch_<business>`. Move the acquire to just after
>    the ownership CAS and before the `FOR UPDATE OF sb` SELECT — this preserves that file's
>    documented "CAS is the first statement" intent while making the order global.

- `batch-builder.ts`: extract the inline `hashtext('solicitation_batch_' || business_id)` at
  line ~606 into exported `acquireSolicitationBatchLock(tx, businessId)` — so exactly one
  derivation of the key exists (#582's lesson: two derivations is how a lock silently stops
  contending while still looking taken) — and call it from `constructBatch` at the new
  position above. Its docstring states the global order.
- `purge-stages.ts`: take `acquireSolicitationBatchLock` per business in the same ordered loop
  that already takes `acquireCsvIngestLock` (ordered by id so two purges cannot deadlock), and
  in the same advisory-before-row position. **No new DELETE** (G9) — outreach cascades via
  batches, exactly as `solicitation_asks` does. Extend the existing comment block to state the
  outreach cascade path and the global lock order explicitly.
- A **concurrent build-versus-purge** live-DB `*.integration.test.ts` proving the two contend
  rather than deadlock. This is the test that would have caught the original ordering, so it is
  added to the promised titles rather than left implicit.
- `table-disposition.ts`: add `solicitation_outreach` as
  `hard_delete` / `direct_account_id` / `must_be_absent`.
- `purge-verification.ts`: add the matching absence query.

Covers promised titles 32–33.

---

## Risks and how each is contained

| Risk | Containment |
|---|---|
| A CHECK is replicated from 071 instead of 088, silently narrowing a domain | T1's integration test asserts the **088** text for the two frozen constraints; the plan's verified-facts table names the line numbers |
| The ask composite unique is added after the FK that needs it | Explicit ordering in T1 (§3 before §5), and the migration fails loudly at apply if wrong |
| The in-flight index predicate drifts from `job-outbox-status.ts` | `ci:outbox-status` scans migrations for members-and-order; runs in the verify gate |
| An index exists with no producer for one ticket (G1) | Verified `ci:outbox-topics` does not scan migrations; the index is inert until #630 writes rows |
| `cancelled` reaches a UI `Record` that does not handle it | `Record<RunDisplayState, string>` makes it a typecheck failure, not a runtime one |
| Live-DB suites deadlock against each other (#573 class) | T1 and T5's integration suites are `*.integration.test.ts`, apply no DDL, use `assertSchemaReady`; T1 also takes `acquireLiveDbLock` as a migration-shape suite |
| Redaction or health check silently no-ops forever | Both emit counts/findings; T6 logs the redacted count **and flags saturation at the 5000 cap**, T7's key is greppable |
| A CHECK passes on NULL and admits the row it exists to reject | Every multi-arm CHECK in 091 is `IS TRUE`-wrapped (T1 §5); the integration suite asserts NULL rejection against each reason-bearing status rather than only the happy pairs |
| Purge and batch construction deadlock on the two advisory locks | One documented global order (advisory→row) applied to both sites in T8, plus a concurrent build-vs-purge live-DB test |
| Redaction sweep stalls on a large first backlog | Bounded `LIMIT 5000` + `ORDER BY sent_at` + `SKIP LOCKED`, matching every existing arm of the same poller |
| The new table escapes both tenant audits | Registered in `TENANT_TABLES` in T1; `ci:tenant-scope` + `ci:rls-audit` are in the gate's verification commands, and now actually cover it |
| Diff sprawls past the ticket | Eight bounded tasks; step 5 re-checks actual diff against the re-signed estimate |

## Out of scope — restated so a subagent cannot drift

No rendering, no releaser, no send worker, no approval routes/UI, no auto-approval resolver,
no cap constants, no `QUEUE_NAMES`/enqueue helpers, no `unknown` sweep, no Judge path, no
owner-edit surface. Nothing in this ticket sends an email or calls an LLM.
