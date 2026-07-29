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
| `solicitation_asks` has **only** its PK and `(batch_id, contact_id)` — the composite unique genuinely does **not** exist | `088:159` |
| `ci:outbox-topics` scans `src/lib`+`src/app`+`worker` only — a migration-only index cannot trip it | `scripts/ci/outbox-topics-audit.ts:52` |
| `ci:outbox-status` **does** scan `supabase/migrations/` for the in-flight literal, members-and-order | `outbox-status-audit.ts:49,54` |
| `deriveRunDisplayState` has exactly **one** production caller, `getReviewTimeline`, whose query is hard-filtered `ar.kind = 'review_handler'` | `read.ts:326,390` |
| `RunDisplayState` is consumed by `RunStateBadge.tsx` via `Record<RunDisplayState, string>` (adding a member is a compile error) + 5 CSS selectors | `RunStateBadge.tsx:3`, `console.css:644-658` |
| Purge takes `acquireCsvIngestLock` per business; `solicitation_asks` has **no** explicit DELETE (cascades from uploads→batches) | `purge-stages.ts:259-290` |
| `acquireCsvIngestLock` is the named-helper precedent, owned by `ingest.ts`, imported by the purge | `ingest.ts:374-379` |
| The `solicitation_batch_<business>` advisory key is currently **hand-spelled inline** in batch-builder | `batch-builder.ts:605-609` |

---

## Decisions locked in grilling (deltas the spec left open)

Nine forks were resolved with the map owner. Recorded here because downstream tickets inherit them.

| # | Fork | Decision |
|---|---|---|
| G1 | Where the outbox topic constants + typed helpers land | **091 creates the two in-flight indexes only.** `QUEUE_NAMES` entries and `enqueueSolicitationSend`/`enqueueGenerateSolicitationAsks` ship with their producers (#628/#630). Safe because `ci:outbox-topics` does not scan migrations. |
| G2 | What a `cancelled` run displays as | **New `RunDisplayState` member `'cancelled'`.** Folding it into `completed` would reintroduce the exact lie D4 exists to prevent. |
| G3 | Body-presence CHECK vs withheld rows | **Keyed on `delivery_status` too.** A `render_failed`/`moderation_high` withhold never had a body; the literal spec wording would force #628 to synthesize one. |
| G4 | `deriveBatchState` ownership | **Ships in #624** alongside `closeBatchIfSettled`, in `src/lib/solicitation/outreach.ts`. It is a pure function over columns 091 creates. |
| G5 | `unknown` ↔ reason | **`unknown` ⇒ `send_indeterminate` exclusively**; `failed` ⇒ `send_failed`/`send_exhausted`. An `unknown`/`send_failed` row is a contradiction and is made unrepresentable. |
| G6 | Constants placement | **Co-located with consumers** (windows → `outreach.ts`, `BODY_RETENTION_DAYS` → `ArchivalPoller.ts` beside `AGENT_SPINE_RETENTION_DAYS`, threshold → `read.ts` beside `STALLED_RUNNING_THRESHOLD_MS`). §8's cap constants are **omitted** — they conflict with amendment B3 and belong to #630/#631. |
| G7 | Lazy child writer | **Thin focused seam** `startOrGetSolicitationAskRun`, mirroring `startOrGetSolicitationBatchRun`. Its job is type-level: make `businessId`/`parentRunId` non-optional so a NULL cannot reach `agent_runs_parent_business_required`. |
| G8 | Advisory lock helper home | **`batch-builder.ts`, exported** — the `ingest.ts`/`acquireCsvIngestLock` precedent exactly. |
| G9 | Purge shape | **Cascade + inventory entry + verification query + the lock.** No explicit DELETE, matching how `solicitation_asks` is already handled. |

### G10 — D15b has no consumer (raised to the map owner during planning)

D15b asks `deriveRunDisplayState` to gain a kind-aware 11-day stalled threshold, but its only
caller filters `kind='review_handler'`, so no send-batch run can reach it — D15a is precisely
why (owner-facing send display goes through `deriveBatchState`). **Decision: export
`stalledThresholdMsForKind(kind)` as a tested pure function; do NOT widen
`deriveRunDisplayState`'s signature** until a caller genuinely surfaces send-batch runs.
D15c's `HealthAlertPoller` check queries `agent_runs` directly and is unaffected.
Flag for the map: whichever ticket first lists send-batch runs owns the widening.

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

- **`stalledThresholdMsForKind(kind)` — a pure lookup, deliberately not wired.** One owner for
  "how long may a run of this kind legitimately run," ready for its consumer. See G10.

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
5. **`solicitation_outreach`** — the new table. Column list is **#619 §3 D5 as amended by
   B1/B2**: D5's columns, **minus `policy_version`** (dropped per B1), **plus** `source TEXT NOT
   NULL CHECK (source IN ('llm'))` (no `'owner_edit'` — struck by B2), `ask_lint_version`,
   `lint_detail JSONB NOT NULL`, `moderation_status` (`clean|flagged|error|disabled`),
   `moderation_detail JSONB NOT NULL`, `interpolation_inputs JSONB NOT NULL`, `prompt_hash`,
   and the nullable consent snapshot `consent_basis` / `consent_attestation_version` /
   `consent_row_id` (stamped at dispatch by #630, not here). Five composite tenant FKs exactly
   as §3 spells them. Then:
   - `delivery_status` CHECK: `rendered|queued|sending|sent|withheld|cancelled|failed|unknown`
   - `disposition_reason` ↔ status consistency CHECK in the
     `solicitation_asks_status_reason_consistency` idiom, per **G5**: withhold set for
     `withheld`; cancel set **including `superseded`** (B2) for `cancelled`;
     `send_failed|send_exhausted` for `failed`; `send_indeterminate` **only** for `unknown`;
     `IS NULL` for `rendered|queued|sending|sent`
   - body-presence CHECK per **G3**: `body_redacted_at IS NOT NULL OR delivery_status =
     'withheld' OR (rendered_subject IS NOT NULL AND rendered_body IS NOT NULL)`
   - partial unique `(ask_id) WHERE delivery_status IN ('rendered','queued','sending')`
   - `(batch_id, delivery_status)`; `(business_id, sent_at)`
   - RLS: owner SELECT with the D6a moderation carve-out; service role full
6. **`auto_approval_policies`** — widen `persona` with `'solicitation'`, `action_class` with
   `'sending'`, `veto_window_minutes` to `(15,30,60)`; add `daily_send_cap SMALLINT` (`NULL OR
   1..50`); add D19's cross-persona consistency CHECK.
7. **`job_outbox`** — the two partial unique in-flight indexes (`solicitation_send` keyed on
   `aggregate_id`, `generate_solicitation_asks` keyed on `batch_id`), each spelling
   `status IN ('pending','dispatching','dispatched')` in **members-and-order** per
   `src/lib/shared/job-outbox-status.ts`. Per **G1**, no `QUEUE_NAMES` entry and no helper.

Also in T1: update `src/lib/shared/__tests__/helpers/schema-ready.ts`'s migration→objects map,
and add the 091 entry to `.claude/reference/migrations-log.md`.

Live-DB suite `src/lib/shared/__tests__/migration-091-send-mode-spine.integration.test.ts`,
following the 090 precedent: `*.integration.test.ts`, **no migration SQL applied at run time**,
`assertSchemaReady`, and `acquireLiveDbLock` since it is a migration-shape suite. Covers
promised titles 1–16.

> Reviewer note: the constraint-frozen assertions must read `pg_constraint.consrc`/
> `pg_get_constraintdef` and `pg_indexes.indexdef` and compare to the **088** text, not 071's.

### T2 — ADR 0014 + CONTEXT.md glossary
**Blocks:** none · **Blocked by:** none (can run in parallel with T1)

Extract Appendix A verbatim to `docs/adr/0014-send-mode-spine-lifecycle.md`, status
`accepted` (Appendix A says "proposed (accept with #624)" — this *is* #624). Fix the two
malformed nested-backtick references to the gap analysis that Appendix A carries. Add a
Consequences bullet recording **G10** (D15b has no consumer; the threshold ships unwired).

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

Covers promised titles 17–19.

### T4 — `cancelled` display state + `stalledThresholdMsForKind`
**Blocks:** none · **Blocked by:** T3

- `read.ts`: `RunDisplayState` += `'cancelled'`; the run row `status` type widens; a
  `run.status === 'cancelled'` branch returns `'cancelled'` (placed with the existing
  completed/failed early returns, before the waiting-on-owner check).
- `read.ts`: export `stalledThresholdMsForKind(kind)` + `STALLED_THRESHOLD_SEND_BATCH_DAYS = 11`
  beside `STALLED_RUNNING_THRESHOLD_MS`. **`deriveRunDisplayState`'s signature is unchanged**
  (G10).
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

Property test with `fast-check` for `deriveBatchState` (house style: the `invariants` describe
block in `src/lib/reviews/__tests__/sentiment.test.ts`) — arbitrary combinations of the eight
timestamps yield exactly one state, and the precedence order holds pairwise.
The concurrent-close test is a live-DB `*.integration.test.ts`.

Covers promised titles 23–28.

### T6 — ArchivalPoller body redaction (D6c)
**Blocks:** none · **Blocked by:** T1

`worker/background/pollers/ArchivalPoller.ts`: add `BODY_RETENTION_DAYS = 90` beside
`AGENT_SPINE_RETENTION_DAYS = 180`, and a redaction step inside the existing `runArchival`
cycle — `UPDATE solicitation_outreach SET rendered_subject = NULL, rendered_body = NULL,
body_redacted_at = NOW() WHERE sent_at < NOW() - make_interval(days => 90) AND
body_redacted_at IS NULL`, following the existing `make_interval` idiom. **No new poller**
(D6c: this map grows the P2 single-replica list by exactly one, and D7 already spent it).
Emit the redacted row count into the existing cycle log. Never log a body (D6e: string args
are logged verbatim).

Covers promised titles 29–30.

### T7 — HealthAlertPoller stalled-send-batch check (D15c)
**Blocks:** none · **Blocked by:** T1

`worker/background/pollers/health-alert/checks.ts`: `checkStalledSendBatches(sql, cfg)`
returning a `HealthFinding | null`, one query, registered in `runHealthChecks` alongside the
other core checks (sequential, per that file's documented shared-fate reasoning). Finding key
`solicitation_send_batch_stalled`. Threshold sourced from the same 11-day constant as T4 so
there is one owner. Detail carries run id + age; never PII.

Covers promised title 31.

### T8 — Offboarding purge: lock extraction + inventory + verification (D6d)
**Blocks:** none · **Blocked by:** T1

- `batch-builder.ts`: extract the inline `hashtext('solicitation_batch_' || business_id)` at
  line ~606 into exported `acquireSolicitationBatchLock(tx, businessId)`, and call it from
  `prepareBatch` — so exactly one derivation of the key exists (#582's lesson: two derivations
  is how a lock silently stops contending while still looking taken).
- `purge-stages.ts`: take `acquireSolicitationBatchLock` per business in the same ordered loop
  that already takes `acquireCsvIngestLock` (ordered by id so two purges cannot deadlock).
  **No new DELETE** (G9) — outreach cascades via batches, exactly as `solicitation_asks` does.
  Extend the existing comment block to state the outreach cascade path explicitly.
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
| Redaction or health check silently no-ops forever | Both emit counts/findings; T6 logs the redacted count, T7's key is greppable |
| Diff sprawls past the ticket | Eight bounded tasks; step 5 re-checks actual diff against `+1550/-40` |

## Out of scope — restated so a subagent cannot drift

No rendering, no releaser, no send worker, no approval routes/UI, no auto-approval resolver,
no cap constants, no `QUEUE_NAMES`/enqueue helpers, no `unknown` sweep, no Judge path, no
owner-edit surface. Nothing in this ticket sends an email or calls an LLM.
