# Step 7 — Spec & correctness review (`feat-624-spine-lifecycle-fanout`)

Reviewer: fresh-eyes spec/correctness agent, step 7 of the `/feature` run.
Diff under review: `2c8b021a53c50d3120d3b95fcbae6c70b170c914..af44b093` — 46 files,
+7967 / −82.

## What I checked, and how

| Axis | Method |
|---|---|
| Intake fidelity | Opened `.feature/intake.json` and walked every field (see §2). Test titles matched **programmatically** (verbatim substring search over the 24 changed test files), not by eye. |
| Migration 091 | Read the file end to end, then read the **applied** definitions back out of the live local test DB (`pg_get_constraintdef`, `pg_indexes.indexdef`, `pg_policies`, `information_schema.columns`) — read-only, no DDL, no writes. |
| CHECK totality | For the one constraint I suspected of under-enforcing, evaluated its exact predicate as a `SELECT` over a `VALUES` list of hypothetical rows (read-only). Result table in Finding 1. |
| Blast radius | Read `blast-radius.md` and traced each changed export against its listed callers (§3). |
| Prior findings | Read `adversarial-review-codex.md` (F1–F5) and the 850-line deviations log end to end so nothing already triaged is re-reported. Two findings below are explicitly framed as **extensions** of F4 / F5. |
| Gates | Ran `pnpm typecheck`, `pnpm lint`, `ci:db-imports`, `ci:feature-surface`, `ci:live-db-suites`, `ci:outbox-seam`, `ci:outbox-status`, `ci:rls-audit`, `ci:tenant-scope`, `ci:static-policy` — **all pass**. Ran the seven unit suites (238 tests, 24 files) — **all pass**. |

I modified no source file.

---

## 1. Findings

| Severity | file:line | Finding |
|---|---|---|
| Medium | `supabase/migrations/091_send_mode_spine_lifecycle.sql:340-352` | `solicitation_outreach_status_timestamp_consistency` enforces no `status → stamp` implication except for `sent_at`, contradicting its own comment; a `sent`/`queued`/`sending` row with `queued_at IS NULL` is legal and is invisible to the `queued_at`-keyed daily-send-cap count (B3). Extends F4. |
| Medium | `worker/background/pollers/ArchivalPoller.ts:266-272` + `supabase/migrations/091_send_mode_spine_lifecycle.sql:360-372` | Body redaction is reachable **only** for `delivery_status='sent'`. A `cancelled`/`superseded` attempt keeps its full rendered body forever, and every non-`sent` row keeps `interpolation_inputs` (`contact_first_name`, `visit_note`) forever. Extends F5. |
| Low | `docs/security/rls-inventory.md:34` | Changed file matched by no `allowed_edit_surface` glob; it clears `ci:feature-surface` only via the audit's blanket `^docs/` exemption (`scripts/ci/feature-surface-audit.ts:49`), while the intake enumerates specific `docs/**` paths. |

### Finding 1 (Medium) — the F4 status↔timestamp CHECK is not total in the `status → stamp` direction

`091:340-352` as applied (read back from `pg_constraint`):

```
CHECK (((
    ((delivery_status = 'sent') = (sent_at IS NOT NULL))
AND ((sending_at IS NULL) OR (queued_at IS NOT NULL))
AND ((sending_at IS NULL) OR (sending_at >= queued_at))
AND ((sent_at IS NULL) OR (sending_at IS NULL) OR (sent_at >= sending_at))
AND ((delivery_status <> 'rendered') OR ((queued_at IS NULL) AND (sending_at IS NULL)))
AND ((delivery_status <> 'queued')   OR (sending_at IS NULL))
) IS TRUE))
```

The comment immediately above it (`091:344-345`) states the contract as
*"queued/sending/sent imply the preceding stamp, in order."* Only the **ordering**
half and the `sent ⇔ sent_at` equivalence shipped. The forward implications
`delivery_status='queued' ⇒ queued_at IS NOT NULL`, `'sending' ⇒ sending_at IS NOT NULL`,
and `'sent' ⇒ queued_at IS NOT NULL` are absent.

Proved by evaluating the exact predicate read-only against hypothetical rows:

| Row | CHECK passes |
|---|---|
| `sent`, `queued_at` NULL, `sending_at` NULL, `sent_at = NOW()` | **true** |
| `queued`, no `queued_at` | **true** |
| `sending`, no stamps at all | **true** |
| `withheld` carrying a `queued_at` | **true** |
| `unknown`, no stamps | **true** |

Concrete failure scenario: #630 (or a bug in it) writes a completed dispatch as
`delivery_status='sent'` with `sent_at` stamped but `queued_at` left NULL. The row
is legal. The daily-send cap is counted **by dispatch attempt on `queued_at`** — that
is the stated rationale for `idx_solicitation_outreach_account_queued` /
`idx_solicitation_outreach_business_queued` (`091:398-404`, amendment B3). A
`queued_at`-NULL send is therefore not counted, and the account can exceed its
`daily_send_cap` by exactly the number of such rows. The `withheld`-carrying-`queued_at`
row is the mirror error: it inflates the same count for an attempt that was never
dispatched.

Why this is in scope and not already closed: F4 was ACCEPTED on the basis of
*"a total status↔timestamp consistency-and-ordering CHECK"*
(`adversarial-review-codex.md:123`). The shipped constraint is the ordering half.
The two promised tests (`solicitation_outreach requires sent_at exactly for a sent
row`, `…rejects a live attempt carrying dispatch timestamps`,
`…rejects out-of-order dispatch timestamps`) all assert cases the constraint *does*
cover; none asserts the forward implication, so the gap is green-by-omission rather
than green-by-mis-assertion. `091:336` ("Arm 1 subsumes hole 2") is correct as far
as it goes — it does close the F4 hole Codex named — but it does not make the arm
set total.

Fix shape: add `(delivery_status NOT IN ('queued','sending','sent') OR queued_at IS NOT NULL)`
and `(delivery_status NOT IN ('sending','sent') OR sending_at IS NOT NULL)` inside the
same `IS TRUE` wrapper, plus a test that a `sent` row with a NULL `queued_at` is
rejected. Decide deliberately whether `withheld`/`cancelled` may carry a `queued_at`
(a cancelled-after-queue row legitimately may; a withheld one cannot).

### Finding 2 (Medium) — redaction reaches only `sent` rows, so superseded bodies and all `interpolation_inputs` are retained forever

Three facts compose:

1. `solicitation_outreach_body_presence` (`091:360-372`): a `body_redacted_at` stamp
   requires `rendered_subject IS NULL AND sent_at IS NOT NULL`.
2. `solicitation_outreach_status_timestamp_consistency` (`091:343`):
   `(delivery_status='sent') = (sent_at IS NOT NULL)` — so `sent_at` is present on
   `sent` rows and **only** on `sent` rows.
3. The sweep (`ArchivalPoller.ts:266-272`) selects `WHERE sent_at < NOW() - 90 days
   AND body_redacted_at IS NULL`.

Therefore a row can be redacted **iff** its `delivery_status` is `sent`. Every other
row is permanently outside the sweep, and the schema makes redacting it a constraint
violation rather than merely unreached.

The consequences that matter:

- **`cancelled` / `superseded`.** B2's regenerate contract (`091:374-376`,
  CONTEXT.md "Outreach row") terminalizes the prior attempt `cancelled`/`superseded`
  and inserts `attempt_no + 1`. That prior row had a fully rendered body, and
  `body_presence`'s third arm (`body_redacted_at IS NOT NULL OR delivery_status =
  'withheld' OR rendered_subject IS NOT NULL`) **requires** it to keep it — a
  cancelled row may be neither bodyless nor redacted. Every superseded attempt
  therefore retains `rendered_subject` and `rendered_body` indefinitely. Regeneration
  is a first-class flow, so this is the common case, not a corner.
- **`interpolation_inputs` on every non-`sent` row.** The column is `NOT NULL`
  (`091:209`) on *all* rows including `withheld` ones, and per the ask-generation
  spec it carries `contact_first_name` and `visit_note`. The F5 fix empties it
  (`= '{}'::jsonb`) only inside the sent-only sweep. So a `withheld`
  (`moderation_high`, `no_consent`, `unsubscribed`, …), `cancelled`, `failed` or
  `unknown` row keeps that third-party PII forever.
- **`unknown`.** The intake's own edge case is that an `unknown`/`send_failed` pairing
  is unrepresentable because it *"would assert a send did not land while claiming
  indeterminacy"* — i.e. an `unknown` row **may well have been delivered**. Yet for
  retention purposes the schema and the sweep treat it as never-sent, and
  `ArchivalPoller.ts:262-265`'s justification ("a never-sent row has no send to
  minimize") does not hold for it.

Why this extends F5 rather than repeating it: F5 was ACCEPTED with the objective
quoted from CONTEXT.md — *"data minimization on third-party PII held on the contact's
behalf"* — and closed for `interpolation_inputs` **on sent rows**. The applied fix
narrows the objective to the sent subset without saying so. CONTEXT.md's own new
"Body redaction" entry does assert *"Redaction implies sent: a redacted row always
has `sent_at`"*, so the owner may want to accept this as designed; if so it should be
recorded as a deliberate scope of the retention promise rather than left implied,
because the CHECK now makes widening it a migration.

Fix shape (either): (a) key the sweep and the `body_presence` redaction arm on
"terminal" rather than "sent" (`delivery_status IN ('sent','withheld','cancelled',
'failed','unknown')`, aged off `COALESCE(sent_at, rendered_at)`); or (b) leave bodies
sent-only but empty `interpolation_inputs` on any terminal row past the window,
which needs only the `body_presence` arm relaxed for the inputs column.

### Finding 3 (Low) — one changed file outside the declared surface

`docs/security/rls-inventory.md` (+1 line) is not matched by any glob in
`allowed_edit_surface`. The intake enumerates docs paths individually
(`docs/adr/**`, `docs/reviews/**`, `docs/superpowers/plans/**`, one specific spec
file, `CONTEXT.md`, `.claude/reference/migrations-log.md`), so `docs/security/` was
not declared. `ci:feature-surface` passes because the audit carries a blanket
`ALWAYS_ALLOWED = [/^docs\//, /^CONTEXT\.md$/, /^\.feature\//]`
(`scripts/ci/feature-surface-audit.ts:49`).

The edit itself is correct and required by repo convention (a new RLS-bearing table
must appear in the inventory), and its content matches the applied policy. Flagged
only because the remit asks for surface drift, and because the intake's enumerated
docs globs and the audit's blanket docs exemption disagree about what a docs-path
declaration means.

---

## 2. Field-by-field intake walkthrough

### `goal`
Every named deliverable is present: migration 091 (`supabase/migrations/091_send_mode_spine_lifecycle.sql`),
`solicitation_outreach` (`091:192-260`), the batch approval/veto/halt columns
(`091:98-107`), `agent_runs` `cancelled` (`091:32-34`, `run-spine.ts:417/444`), the
lazy child seam (`run-spine.ts:182-211` `startOrGetSolicitationAskRun`),
`closeBatchIfSettled` + `deriveBatchState` (`outreach.ts:83-95`, `:291-390`), and the
four operational hooks — kind-aware stalled threshold (`read.ts:28-40`),
`checkStalledSendBatches` (`checks.ts:283-309`), ArchivalPoller redaction
(`ArchivalPoller.ts:239-272`), offboarding purge inventory + advisory lock
(`table-disposition.ts:374-380`, `purge-verification.ts:596-604`,
`purge-stages.ts:280-284`, `batch-builder.ts:172-196`). **PASS.**

### `non_goals`
No ask-rendering worker, no LLM call, no `api_costs` write, no approval/veto routes or
UI, no release poller / send worker / dispatch gate, no auto-approval resolver or
`tierGrantsAutopilot` wiring, no `review_attributed` writer, no `QUEUE_NAMES` entries,
no typed `enqueueSolicitationSend` / `enqueueGenerateSolicitationAsks` helpers, no
Judge path, no owner-edit source. `AGENT_OUTCOME_KINDS` gains `solicitation_sent` and
`review_attributed` as *vocabulary only* — grep confirms no writer. `ci:outbox-seam`
passes with 14 helper-owned topics (unchanged), confirming the two new topics ship
index-only per B10. **PASS — no non-goal breached.**

### `user_visible_behavior`
One item promised: the `Cancelled` badge state. Delivered at
`RunStateBadge.tsx:8` plus `console.css:659-662` (token `--rw-tray` verified to exist
at `_styles/tokens.css:36`). Unreachable in production as stated: `getReviewTimeline`
filters `ar.kind = 'review_handler'` (`read.ts:349`) and no writer produces a
`cancelled` run outside `closeBatchIfSettled`, which has no producer until #628/#629.

I looked specifically for behaviour that shipped **without** being promised:
- The new owner RLS SELECT policy on `solicitation_outreach` grants owners read access
  — but no route, page, or read model queries the table (grep: only 091 and test
  fixtures reference it), so nothing is user-visible.
- `deriveRunDisplayState`'s new required `kind` parameter changes no rendered state for
  the one live caller (`review_handler` → the unchanged 48h threshold), and
  `read.test.ts:149-181` pins exactly that.
- `checkStalledSendBatches` and the ArchivalPoller count are operator-facing and both
  appear in `observability`.
**PASS — no unpromised user-visible behaviour found.**

### `invariants`
| Invariant | Verdict |
|---|---|
| `agent_runs_terminal_consistency` / `agent_runs_one_active_per_subject` byte-for-byte untouched, verified by reading `pg_constraint`/`pg_indexes` | PASS — `migration-091…test.ts:436-492` reads both definitions AND probes behaviour; I independently confirmed both definitions in the live DB |
| `agent_outcomes_unit_count_check` untouched | PASS — asserted at `:494-523` incl. negative (`not.toContain('solicitation_sent')`) |
| #2 — both new `job_outbox` partial uniques spell the in-flight set in members-and-order | PASS — `091:520-528`; `ci:outbox-status` green; test derives the expectation from `OUTBOX_IN_FLIGHT_STATUSES` |
| #4 read across — a `moderation_high` withheld body is not owner-readable, at the DB | PASS — policy verified in `pg_policies`; `FALSE AND NULL = FALSE` so there is no NULL hole; the test asserts both directions (visible row IS returned) |
| #8 — every tenant reference is a composite FK (5 of them) | PASS with a wording caveat: 5 composite FKs confirmed, but a 6th single-column `solicitation_outreach_account_id_fkey → accounts(id)` exists. It mirrors `solicitation_asks_account_id_fkey` from 088 exactly, so it is precedent, not drift. See appendix A5. |
| #15 — `outreach.ts` and every new helper take `sql`/`tx` explicitly | PASS — `ci:db-imports` strict, green |
| `agent_runs_parent_business_required` unrepresentable at the type level | PASS — `StartSolicitationAskRunInput` makes both fields required (`run-spine.ts:182-187`) |
| One advisory-lock key derivation | PASS — `acquireSolicitationBatchLock` is the sole owner (`batch-builder.ts:190-196`); the previous hand-spelled derivation was deleted; `purge-stages.ts:283` imports it |

### `edge_cases`
| Edge case | Verdict |
|---|---|
| Withheld row never had a body / never redacted; presence CHECK keyed on `delivery_status` too | PASS — `091:369` third arm |
| `unknown` takes `send_indeterminate` exclusively; `unknown`/`send_failed` unrepresentable | PASS — `091:317`; tested both ways |
| `solicitation_asks (id, account_id, business_id)` unique must precede the FK | PASS — guarded `DO` block at `091:81-94`, before §5 |
| Two kinds share the `solicitation_batch` subject; one-active predicate includes kind | PASS — index is `btree (kind, subject_type, subject_id) WHERE status='running'`, confirmed live |
| `superseded` joins the cancel set; lint classes collapse to `lint_failed` + `lint_detail` | PASS — `091:312`, `091:214-215` |
| `closeBatchIfSettled` callable on a zero-outreach batch without terminalizing an unstarted parent | PASS — the send-parent resolve precedes the settled predicate (`outreach.ts:318-329`), and the test asserts no step row and no `send_closed_at` |
| Both hooks no-op on empty sets, logging a zero count rather than erroring | **PASS with a caveat** — both are aggregate queries that return one row over zero rows, so neither errors. But ArchivalPoller only emits the count when *some* arm is non-zero; an all-zero cycle logs `Nothing to archive`, not a zero count. Pre-existing log shape. Appendix A6. |
| Purge sweeps outreach transitively via the batches cascade; verification proves it fired | PASS — `purge-verification.ts:596-604` + `purge-stages.ts:307-310`; FK cascade confirmed live |

### `tests_to_add`
**52 / 52 promised titles exist verbatim** (matched programmatically). I then read every
one of them looking for the "green while covering nothing" class named in the brief.

Titles I judged **discriminating** after reading the assertions (highlights):
- the two frozen-constraint titles read `pg_get_constraintdef` / `pg_get_expr` **and**
  probe behaviour, including the negative `not.toContain('solicitation_sent')`;
- the NULL-side titles (`rejects a null disposition_reason for every reason-bearing
  delivery status`) loop all four reason-bearing statuses and are exactly the
  `IS TRUE`-wrapper probe the brief asks for;
- the RLS title grants `SELECT` and redefines `auth.uid()` inside a rolled-back tx and
  asserts the **visible** row is returned, so it cannot pass vacuously on a
  deny-everything policy;
- `checkStalledSendBatches reports a solicitation_send_batch still running past 11 days`
  is mock-based, but the T7 coverage gap is closed by three live-DB cases
  (`checks.integration.test.ts:309-338`) that seed through the real spine writer and
  include two negative controls (inside-threshold, already-terminal);
- `the offboarding purge takes the solicitation batch advisory lock for every business`
  holds the lock on the **second** location — precisely the case a single-business
  shortcut would miss — and proves a real block plus non-deletion behind it;
- `terminalizes the parent exactly once under concurrent child terminals` uses two
  genuinely concurrent transactions on separate connections.

Non-discriminating / weak titles found — all **minor**, none rising to a finding, all in
Appendix A. Notably the already-documented F3 redundant-arm case is *not* re-reported.

### `verification_commands`
All 18 either ran green here or are live-DB suites already proven in the gate. I ran
every `ci:*` plus `typecheck`, `lint`, and the unit suites; live-DB suites were
verified by reading, not re-running (they hold a cross-process lock and the brief
forbids DB writes from me).

### `estimated_diff_size` / `dependencies_added` / `rollback_plan` / `observability` / `open_questions`
- Diff is +7967 / −82 vs the estimate `+1900 / −70`. Almost all of the overage is docs
  (deviations 850, handoff 502, plan 629, review artefacts ~650) and tests (~3100).
  Production code is ~700 lines net. Not a correctness issue; noted for calibration.
- `dependencies_added: []` — confirmed, `package.json` untouched.
- `rollback_plan` — verified accurate against the file: 091 is additive only, no drops,
  no backfill; the pre-091 origins it names (088 for kind/subject/pairing/outcome-kind,
  071 for status) match what I read out of `pg_constraint`.
- `observability` — three of four delivered as described. The log key is
  `solicitation_outreach_bodies`, not the `outreach_bodies_redacted` the intake names
  (Appendix A6).
- `open_questions: []` — the deviations log carries one deliberate open follow-up (a
  cosmetic backtick fix in an off-surface spec), correctly declared.

---

## 3. Blast-radius caller analysis

The changed exports with semantics that could break a caller, and what I found:

| Changed export | Callers checked | Verdict |
|---|---|---|
| `deriveRunDisplayState` — gained a **required** `kind` field | only `getReviewTimeline` (`read.ts:410-415`) in production; 3 test files | Safe. The one production caller selects `ar.kind` and passes it, and its query is pinned to `kind='review_handler'` (`read.ts:349`), which maps to the unchanged 48h threshold. `read.test.ts:149-181` regression-pins that. |
| `RunDisplayState` — gained `'cancelled'` | `RunStateBadge.tsx` (`Record<RunDisplayState, …>` — exhaustive, updated), `RunTimeline.tsx`, `TimelineContent.tsx`, `TimelineEscalationActions.tsx`, `TimelineStepRow.tsx`, `checks.ts` | Safe. Only `RunStateBadge` maps the union exhaustively (typecheck would have failed otherwise, and it passes). The CSS class `timeline-run-state--cancelled` matches the `timeline-run-state--${displayState}` template at `RunStateBadge.tsx:24`. |
| `AGENT_RUN_KINDS` — gained `'solicitation_send_batch'` | `read.ts`, `checks.ts` only (grep across non-test source) | Safe. No production code iterates the array; both uses are `(typeof AGENT_RUN_KINDS)[number]` in type position. `checks.ts:270` deliberately types the literal against it so a rename breaks the build rather than silently matching zero rows. |
| `AGENT_OUTCOME_KINDS` — gained two kinds | same two files | Safe. No exhaustive runtime map over outcome kinds; no writer for either new kind. |
| `completeRun` / `transitionRunToTerminal` — status widened to include `'cancelled'` | 41 importers of `run-spine.ts` | Safe — a widened parameter union breaks no existing call. I checked the one behavioural subtlety: `transitionRunToTerminal` no-ops (does **not** throw) when the row exists but is already terminal, and throws only when the row is absent — unchanged. |
| `failSolicitationBatchRun` — union gained `generation_failed`; error mapping extracted to `failureToError` | `batch-builder.ts:648`, `worker/jobs/solicitation-batch/failed-hook.ts`, `outreach.ts:384` | Safe. `gate_closed` and `build_failed` map to byte-identical payloads (`{code, error_class}` / passthrough); `run-spine.test.ts` pins both. |
| `acquireSolicitationBatchLock` — **new** export, and `batch-builder.ts` moved the advisory lock from *after* the batch row lock to *before* it | `purge-stages.ts:283`, `batch-purge-concurrency.integration.test.ts`, `offboarding-lifecycle.integration.test.ts` | **The riskiest semantic change in the diff, and it holds.** I verified the key derivation is identical to the deleted inline one (`hashtext('solicitation_batch_' || businessId)`) and that the new call uses `preparation.businessId`, which the batch `SELECT … FOR UPDATE` scopes on (`batch-builder.ts:633`) — so it is the same value the old `batch.business_id` produced, and it is now taken *before* the row exists check rather than after, which is what makes the order global. I also checked for a fresh ABBA against `job_outbox`: `constructBatch` takes a `job_outbox` row lock (the ownership CAS) *before* the advisory, so a holder of that advisory must not wait on a `job_outbox` row. `runContentPurgeStage` — the only advisory holder on the purge side — touches no `job_outbox` row; `runRawPayloadPurgeStage` does, but in a separate transaction that takes no advisory lock. No cycle. |
| `runContentPurgeStage` — now acquires a second advisory key per business | `PurgeWorker.ts`, two integration suites | Safe. Both keys are taken in one pass in a fixed order (`csv_ingest` then `solicitation_batch`) over businesses ordered by id, so two concurrent purges cannot invert them. Waiting is the intended behaviour and is bounded by the builder's transaction. |
| `runArchival` — newly **exported** (was module-private) and gained a 9th arm | `worker/index.ts` (via `startArchivalPoller`), two test files | Safe. Export widening only; the poller still goes through `createGuardedPoll`. The new arm's count joins `totalArchived` and the saturation list, both of which existing tests pin (the "8 queries" assertions were updated to 9 — a genuine update, not a loosening). |
| `checks.ts` — `runHealthChecks` gained an 8th sequential check | `HealthAlertPoller.ts`, `NotificationFailoverPoller.ts`, `emit.ts`, `replica-cardinality.ts`, `scripts/health-bundle-differential.ts` | Safe. `emitHealthFindings` tags on `finding.key` generically — no per-key registry to update. `checkStalledSendBatches` is not wrapped in its own `try/catch`, matching every check except the deliberately-isolated backlog probe; the mock suites were updated to push the extra queue entry in dispatch order (a real ordering dependency, correctly maintained). |
| `TABLE_DISPOSITIONS` / `ACCOUNT_OFFBOARDING_TABLES` — gained a row | `purge-verification.ts`, two test files | Safe. `verificationQuery` gained the matching `case`, so no `missing_purge_verification_sql` throw. `table-disposition.test.ts` (unchanged, green) is the schema-completeness gate that deviation entry 3 records as having been red before this row landed. |

Nothing in the blast radius relied on the old behaviour of anything changed here.

---

## 4. Prior findings F1–F5 — status as I read the tree

Not re-reported. For the record, what I verified about each applied fix:

- **F1 (closed).** `closeBatchIfSettled` now takes `failure` as a parameter
  (`outreach.ts:145-171`) and every `agent_runs` write happens after the batch
  `FOR UPDATE` (`:295-387`). The terminalization branches on the **resolved
  disposition**, not on `input.failure` being present (`:383`) — and
  `deriveDisposition` only returns a `failed`-mapping disposition when `failure` is
  present, so the `else` arm can never call `completeRun` with `'failed'`. The
  anchor-pairing carve-out comment was rewritten and its old false claim explicitly
  retracted (`outcome-anchor-pairing.test.ts:64-90`); the pin test still bites.
- **F2 (rejected, deferred to #630 via B11).** Not re-litigated.
- **F3 (closed).** All the missing implication/chronology arms are present
  (`091:161-176`) and I confirmed the applied text. The redundant first arm is
  already documented in the deviations log with probe evidence; not re-reported.
- **F4 (closed for the hole Codex named; see Finding 1 for the remaining gap).**
- **F5 (closed for `sent` rows; see Finding 2 for the remaining gap).** The
  `interpolation_inputs = '{}'::jsonb` write is present in both the poller
  (`ArchivalPoller.ts:268`) and the tenant-scope allowlist snippet, and
  `ArchivalPoller.integration.test.ts:254/271` asserts erasure **and** non-erasure
  inside the window, so it is not vacuous.

---

## Appendix A — low-confidence observations (deliberately NOT in the table)

**A1. `stalledThresholdMsForKind returns the 48-hour default for every other run kind`
enumerates four kinds literally** (`read.test.ts:139-145`) instead of deriving from
`AGENT_RUN_KINDS` minus the send batch. A sixth kind added later ships uncovered by a
test whose title claims "every other run kind". Cheap to fix; no current defect.

**A2. The `deriveBatchState` property test's oracle re-implements the precedence.**
`activeStates` (`outreach.test.ts:147-170`) restates each state's condition in the same
order the implementation uses, so "exactly one state" is close to tautological. It does
still catch a precedence inversion or a dropped branch, and the pairwise test adds
value, so this is an observation rather than a defect.

**A3. `closeBatchIfSettled` on an unbuilt batch would abort its caller's transaction.**
`send_closed_at IS NULL OR built_at IS NOT NULL` (`091:170`) means the CAS
`SET send_closed_at = NOW()` (`outreach.ts:344-352`) raises a constraint violation
rather than returning a result, if a send parent somehow exists for a batch with
`built_at` NULL. Not reachable through any lane I can see (a send parent starts at
generation, which follows build; unbuilt batches are deleted on `gate_closed`), so I
am well under 80% that it is reachable — but it is an unguarded raise inside a
function whose other failure modes are all returned values.

**A4. `batch-purge-concurrency.integration.test.ts:295,313` asserts
`solicitation_outreach` count is 0** when no outreach row was ever inserted. Vacuous
as a cascade proof. The real cascade proof lives in `purge-verification.test.ts`, so
nothing is lost.

**A5. The intake's #8 wording is imprecise.** "every solicitation_outreach tenant
reference is a composite FK (5 of them), never a single-column FK" — a 6th,
single-column `account_id → accounts(id) ON DELETE CASCADE` exists, exactly mirroring
`solicitation_asks_account_id_fkey` (088). A composite FK to `accounts` is impossible
(it has only `id`). Precedent, not drift; the intake sentence, not the code, is what
is loose.

**A6. Two small intake/implementation naming mismatches.** The observability field
names the log key `outreach_bodies_redacted`; the shipped key is
`solicitation_outreach_bodies` (`ArchivalPoller.ts:307`). And the edge case says each
hook must "log a zero count" — the ArchivalPoller only emits per-target counts when
`totalArchived > 0`, otherwise logging `Nothing to archive` (pre-existing shape).

**A7. `ArchivalPoller.integration.test.ts` drives the whole `runArchival` cycle**
against the shared local test DB, so it prunes *every* suite's aged fixtures
platform-wide (agent runs >180d, api_costs, notifications, …). Mitigated by the
cross-process live-DB lock and acknowledged in the file header, but it is a broader
side effect than the title suggests.

**A8. Deviations entry 11's verdict text is now stale.** It records "T5 reads the
disposition source off `agent_runs.error` … Pins a caller ordering that #628/#630 must
honour" — superseded by F1's parameter fix, which retired exactly that ordering. Docs
only; the surviving code and its docstring are correct.

**A9. `read.ts` imports `AGENT_RUN_KINDS` as a value** (`read.ts:7`) but uses it only
in `typeof` positions. Harmless today (client components import `read.ts` type-only, so
nothing is bundled), but `import type` would express the intent and remove the
possibility.
