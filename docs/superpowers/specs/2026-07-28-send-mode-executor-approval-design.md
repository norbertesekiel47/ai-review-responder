# Send-mode executor + batch approval/veto/halt — LOCKED SPEC (ticket #619)

> **AMENDED 2026-07-28 — read `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` first.** Amended
> here: D5's column list (B1 — absorbs #623's provenance + consent snapshot,
> drops `policy_version`), D13 (B2 — `superseded` cancel member; lint classes
> collapse to `lint_failed` + `lint_detail`), §8 caps (B3 — account default 10,
> business default dropped, counting on `queued_at`), D9's cap counting (B3),
> D7's tick duties (B7 — expired-unapproved sweep), D18 (B6 union; already
> amended by #620 §6.3), D22 stands / regenerate added (B2).

Locked in the 2026-07-28 grilling session. Part of wayfinder map **#617**
(Solicitation SEND-MODE, Phase 2b §9.3). Seeded by the **#618** gap analysis
(`docs/research/2026-07-28-send-mode-executor-gap.md (branch `research/send-mode-executor-gap`)`), whose §8 list of 14 open
decisions is resolved here in full, plus six additional forks raised at the
grilling.

Bound by (LOCKED, not re-litigated here): map #617 "Decisions so far" 1–8 —
two lanes, generate-then-approve, drip + halt, veto window, Judge availability
as a precondition for auto batches, email-only, `review_attributed` as
shadow/no-charge, `SOLICITATION_SEND_ENABLED` + a separate auto-approval flag.

References: ADR 0011 (`docs/adr/0011-watch-mode-executor-shape.md`); watch-mode
executor spec (`docs/superpowers/specs/2026-07-23-run-engine-executor-shape.md`);
May reference design (`docs/future-plans/2026-05-22-saas-2-0-vertical-agent-platform-design.md`
§3.1/§3.2/§6.2–6.6); compliance constraints (#531,
`docs/research/2026-07-23-solicitation-policy-constraints.md`).

All refs against `main` @ `a2bc6f60`. **Migrations head 090, next 091.**
**ADR head 0013, next 0014.** Precedent for format: #534.

---

## 0. Decision index

| # | Decision | One line |
|---|---|---|
| D1 | Approval state home | `solicitation_batches` columns, not spine states |
| D2 | Batch lifecycle model | derived timestamps, no status column; two windows (7d approval / 72h send) |
| D3 | Run topology | lazy children; new parent kind `solicitation_send_batch` |
| D4 | Spine enum | adds `cancelled` (terminal only); no active states |
| D5 | Per-ask send lifecycle | new `solicitation_outreach` table, created at render |
| D6 | PII posture | moderation carve-out RLS, 90d body redaction, purge + lock, never-log |
| D7 | Drip pacing | Shape B releaser poller; subsumes the veto window |
| D8 | Velocity control | one active send batch per business (partial unique index) |
| D9 | Veto window | 60min auto / 15min owner; auto fails closed on notice delivery |
| D10 | Halt | one monotone latch, two entry points; no resume |
| D11 | Join | inline last-writer + releaser backstop, one `closeBatchIfSettled` |
| D12 | Exhaustion | single-tx defense + provider idempotency key + `unknown` terminal |
| D13 | Vocabularies | four closed enums; one `disposition_reason` column |
| D14 | Outcomes | two kinds, both on children, `unit_count=1` |
| D15 | Long-running parent | kind-aware 11-day stalled threshold |
| D16 | Attribution window | 14d lookback filter at review-ingest, not a timer |
| D17 | Steps | stay receipts; tripwire re-check at Phase 3 |
| D18 | `consent_recheck` | 7-check dispatch gate; Judge downgrade/hold split |
| D19 | Autopilot policy | widen `auto_approval_policies` |
| D20 | Trust dial | adjustable toward restraint only |
| D21 | Generation trigger | automatic on build, both lanes |
| D22 | Owner edit of a rendered ask | out of scope; approve-or-exclude only |
| D23 | Partial approval | owner may exclude individual asks |

---

## 1. Spine posture (D1, D3, D4) — the ADR 0014 decision family

### D1 — Batch approval state lives on the domain entity

Approval, veto, and halt state are additive nullable columns on
`solicitation_batches`. `agent_runs.status` gains **no active state**.

Rationale (verified in #618 §1.2, §3): a new *active* state rewrites
`agent_runs_terminal_consistency` (written as an equivalence on `'running'`, so
`FALSE = TRUE` for an active non-running row), rebuilds
`agent_runs_one_active_per_subject`, and forces a byte-for-byte edit of the
writer's `ON CONFLICT … WHERE status='running'` — where a mismatch **silently**
stops enforcing uniqueness rather than erroring. Every `WHERE status='running'`
reader (`findActiveReviewRun`, `prepareBatch`'s parent lock at
`batch-builder.ts:240`, `read.ts`) moves with it.

Map decision 4 independently points here: approval attaches to concrete rendered
messages, which live on the domain side regardless. Splitting the approval
*state* onto the spine would put one fact in two tables.

**ADR 0011's promise ("send-mode adds states/verbs, not columns-plus-rework")
survives on the spine.** It does not survive on the domain side, and the reason
is recorded honestly in §11: migration 090 (#593), which landed four days after
ADR 0011, welded `solicitation_asks.status` to `evidence->>'decision'`.

### D3 — Run topology: lazy children

- **One new parent kind `solicitation_send_batch`** (`subject_type =
  'solicitation_batch'`, `subject_id` = batch UUID). Sequential sibling to
  watch-mode's terminal `solicitation_batch` build run. Starts when the send
  lane engages (generation), spans the approval wait, terminalizes when the
  drip closes. Bounded by D2's two windows, so it cannot run forever.
- **Children are created lazily at release**, one per dispatch attempt,
  reusing kind `solicitation_ask`. They live for minutes: consent-recheck →
  dispatch → provider result → terminal.
- **The plan is not in the spine.** `solicitation_asks` (ADR 0011 D5) is the
  authoritative enumeration and already outlives runs. The spine records work
  *performed*, not work *planned*.
- **`waiting_on_owner` is derived, not stored** — from `approved_at IS NULL` on
  the batch, using the WS5 derived-display machinery. This is the concrete
  mechanism that lets us refuse `held_for_approval` without lying about state.
- **Generation (render) is recorded as steps on the parent**, not as a second
  child fan-out, plus `api_costs` rows per render. A render failure is a step
  with `status='failed'` (already supported) and that ask never becomes
  releasable.

Consequences taken deliberately:

- Halt has **nothing to cancel** in the spine — unreleased asks were never runs.
- The join has a real termination condition that does not depend on
  pre-enumerating children (D11).
- No child is ever long-lived enough to be misread as `stalled`.
- `recordCompletedChildRuns`'s hardcoded `'completed'` (#618 V2) stops being a
  blocker on the common path; a running-child writer is still needed, but for
  **one** child at a time, not a bulk set-based running-child insert.
- Cost accepted: the spine cannot answer "how many children will this batch
  have." Only `solicitation_asks` can. That is correct placement.

### D4 — The spine gains `cancelled` (terminal only)

| Terminal status | Means |
|---|---|
| `completed` | the run's plan ran to **natural exhaustion** (drip released everything releasable; a child evaluated and concluded, *including withhold at dispatch*) |
| `cancelled` | the plan was **stopped early by a decision or a deadline** — owner halt, owner veto, `send_window_elapsed`, `batch_expired` |
| `failed` | **execution error** — investigate |

Applied without judgment at call sites: the parent's terminal status is a
lookup from D14's `disposition` union.

Why it earns its place: an owner who ignores a batch until the 7-day approval
window closes is the **common** case, not an edge case. Without `cancelled`
that terminalizes as `completed` (claims sending work never done) or `failed`
(floods `checkFailedOutboxByTopic`, the team summary, and health alerting with
a correct, expected outcome). Keeping `failed` trustworthy is the deciding
concern.

Why it is cheap (the asymmetry #618 §4 point 5 found and ADR 0011 never
claimed): `agent_runs_terminal_consistency` is
`(status='running') = (ended_at IS NULL)`, so a terminal state with `ended_at`
set is `FALSE = FALSE`, **unchanged**. `agent_runs_one_active_per_subject`
never covered terminal rows, so it and the writer's `ON CONFLICT` stay
**byte-for-byte frozen**. What actually moves: one CHECK widening, two TS
unions (`transitionRunToTerminal`, `read.ts`), one display-state branch.

---

## 2. Batch lifecycle (D2, D8)

### D2 — Derived timestamps, no status column; two windows

`solicitation_batches` gains monotone timestamp facts only. One
`deriveBatchState(row, now)` returns a closed union with fixed precedence:

```
halted > closed > sending > veto_window > approved > expired > built > pending
```

No `status` column: it would be a second owner of a fact the timestamps already
carry, requiring its own transition CHECK to stay consistent with them. The
timestamps also give the audit trail ("when was this approved") for free.

**Two windows, each with one job:**

| Window | Anchor | Value | Effect when elapsed |
|---|---|---|---|
| Approval window | `built_at` | **7 days** | batch is `expired`; **neither lane may approve it** |
| Send window | `approved_at` | **72 hours** | every unsent child terminalizes through the **halt path** with reason `send_window_elapsed` |

One window measured from `built_at` and enforced at both approval and dispatch
was rejected: a late-approved batch would get an arbitrarily short send runway,
which is surprising to the owner and hard to explain in the UI.

Payoff: **a drip is bounded by construction (≤ 10 days total).** That bounds the
parent run (D15), guarantees the join fires (D11), and makes halt and expiry
*one mechanism with two reasons* rather than two mechanisms.

This is ADR 0011 D4's "send-mode revisits when expiry has behavioral force"
revisit. Note the derived `expired` state D4 specified was **never implemented**
in `batch-view.ts`; it is defined here for the first time.

### D8 — One active send batch per business

```sql
CREATE UNIQUE INDEX solicitation_batches_one_active_send_per_business
  ON solicitation_batches (business_id)
  WHERE approved_at IS NOT NULL
    AND send_closed_at IS NULL
    AND halted_at IS NULL;
```

**This is the velocity control, and it closes a real hole in the locked map.**

Reframe that produced it: drip pacing does **not** meaningfully control
review-arrival velocity — 25 asks over 3 days versus 1 hour yield the same ~25
reviews within a fortnight. The drip protects **deliverability** on the shared
sending domain (map decision 6). What controls the velocity #531 §1.5 worries
about is **batch size × batch frequency** — and batch frequency was
**unbounded**: batches are keyed `source_upload_id UNIQUE`, so batch cadence =
upload cadence. An owner uploading a CSV daily gets a 25-ask batch daily
(~175 asks/week) with nothing stopping it.

With the index plus D2's 72h send window: a hard ceiling of **25 asks per 72h
per location (~8/day worst case)**, enforced by the database rather than by a
cap that can be misconfigured. It also makes the releaser query trivial and
makes "which batch does halt apply to" unambiguous.

**#531 §1.5's proportional-to-transaction-volume pacing is NOT implemented.**
v1 keeps flat `BATCH_CAP = 25` (map decision 7) and this index is the standing
structural substitute. Recorded as a decision, not a gap.

---

## 3. Artifact, generation, and approval surface (D5, D6, D13, D21–D23)

### D5 — One table, created at render

One row per ask per attempt, created when the message is rendered
(**pre-approval**, because generate-then-approve requires the artifact to exist
before approval). It carries the whole arc: rendered artifact → delivery →
provider result.

Why not `delivery_status` on `solicitation_asks` (#618 D3 option a): 090 made
the ask's `status` a **provenance** column welded to `evidence->>'decision'`. A
delivery column there can hold only one attempt, cannot carry a provider
message id or a bounce, and puts delivery facts on the table whose contract is
"the frozen restraint-policy decision."

Why not a separate rendered-message table plus a sends table: generate-then-
approve means the body exists before any send does, so a release-time sends
table would need a third table for artifacts.

**What this buys:**

- *"What was approved is byte-for-byte what sent"* becomes **structurally
  true** — the approved artifact and the delivery outcome are the same row.
  Map decision 4 made unfalsifiable rather than merely intended.
- Answers #618 **S5** (per-send record): bounces/complaints get a home for
  #626's suppression feed, #622's deliverability, #632's attribution anchor.
- Touches **none** of the three welded constraints
  (`solicitation_asks_status_reason_consistency`,
  `solicitation_asks_evidence_matches_columns`, `parseEvidence`'s read-time
  throw). The "three in lockstep" cascade never fires.
- Re-render (lint failure, owner edit) is a **new row**, not a mutation — the
  decision provenance 090 protects gets an append-only sibling, not a
  competitor.

`agent_run_id` FK with `ON DELETE SET NULL` (the `judge_verdicts` / asks
pattern) so outreach facts outlive 180-day run archival.

**Column list** (authoritative for #624; UUIDv7 app-supplied PK per
`.claude/reference/migrations-log.md`):

```sql
CREATE TABLE solicitation_outreach (
  id                  UUID PRIMARY KEY,              -- app-supplied UUIDv7
  account_id          UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id         UUID NOT NULL,
  batch_id            UUID NOT NULL,
  ask_id              UUID NOT NULL,
  contact_id          UUID NOT NULL,

  channel             TEXT NOT NULL DEFAULT 'email', -- CHECK ('email') — SMS widens, per map #617
  attempt_no          SMALLINT NOT NULL DEFAULT 1,

  -- artifact (D5): what was approved IS what sends
  rendered_subject    TEXT,
  rendered_body       TEXT,
  prompt_version      TEXT NOT NULL,                 -- prompt-policy version hash
  policy_version      TEXT NOT NULL,                 -- restraint/compliance-lint version
  rendered_at         TIMESTAMPTZ NOT NULL,
  body_redacted_at    TIMESTAMPTZ,                   -- D6b, 90 days

  -- lifecycle (D13)
  delivery_status     TEXT NOT NULL,
  disposition_reason  TEXT,

  -- delivery + provider result
  queued_at           TIMESTAMPTZ,
  sending_at          TIMESTAMPTZ,
  sent_at             TIMESTAMPTZ,
  provider_message_id TEXT,
  provider_error      TEXT,                          -- bounded; never a raw body

  -- async provider signals (D13: columns, NOT statuses)
  bounced_at          TIMESTAMPTZ,
  complained_at       TIMESTAMPTZ,
  unsubscribed_at     TIMESTAMPTZ,                   -- #626 feeds this

  agent_run_id        UUID,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Composite tenant FKs, replicating 088's solicitation_asks shape exactly.
  CONSTRAINT solicitation_outreach_business_account_fk
    FOREIGN KEY (business_id, account_id)
    REFERENCES businesses (id, account_id) ON DELETE CASCADE,
  CONSTRAINT solicitation_outreach_batch_tenant_fk
    FOREIGN KEY (batch_id, account_id, business_id)
    REFERENCES solicitation_batches (id, account_id, business_id) ON DELETE CASCADE,
  CONSTRAINT solicitation_outreach_contact_business_fk
    FOREIGN KEY (contact_id, business_id)
    REFERENCES solicitation_contacts (id, business_id) ON DELETE CASCADE,
  CONSTRAINT solicitation_outreach_ask_tenant_fk
    FOREIGN KEY (ask_id, account_id, business_id)
    REFERENCES solicitation_asks (id, account_id, business_id) ON DELETE CASCADE,
  CONSTRAINT solicitation_outreach_run_tenant_fk
    FOREIGN KEY (account_id, business_id, agent_run_id)
    REFERENCES agent_runs (account_id, business_id, id) ON DELETE SET NULL (agent_run_id)
);
```

> **`solicitation_asks` has no `(id, account_id, business_id)` unique constraint
> today** — 088 gave that shape to `solicitation_batches` and (via 088 §1) to
> `agent_runs`, but the asks table has only its PK and
> `(batch_id, contact_id)`. Migration 091 must **add
> `solicitation_asks_account_business_id_uniq UNIQUE (id, account_id, business_id)`**
> before the ask-tenant FK above can be created. Cheap and additive, but it is a
> prerequisite a reviewer should expect to see in the migration, not a surprise
> at apply time.

Notes a reviewer will check:

- `rendered_subject` / `rendered_body` are nullable **only** so D6b's redaction
  can NULL them; a `rendered` row must have both. Enforce with a CHECK keyed on
  `body_redacted_at IS NULL`.
- `provider_error` is bounded diagnostic text. It must never carry a rendered
  body (D6e).
- `unsubscribed_at` is written by #626's landing page / RFC 8058 ingress, not by
  this lane. It exists here so the suppression feed and the per-contact history
  read from one row.
- `contact_id` duplicates a fact reachable via `ask_id`. Kept because the daily
  cap, over-contact history, and suppression join all read it directly, and the
  ask row may be archived on a different schedule.
- The contact table is **`solicitation_contacts`** (migration 086), not
  `contacts`, and every tenant FK in this lane is **composite** — 088 uses
  `(contact_id, business_id)`, `(batch_id, account_id, business_id)` and
  `(business_id, account_id)`. Single-column FKs would be a silent tenancy
  regression against the house pattern.

### D13 — Four closed vocabularies, each with one owner

| Vocabulary | Owner | Members |
|---|---|---|
| run terminal status | spine | `completed \| cancelled \| failed` |
| `delivery_status` | outreach | `rendered \| queued \| sending \| sent \| withheld \| cancelled \| failed \| unknown` |
| `disposition_reason` | outreach | see below |
| child failure attribution | run `error` JSONB | the failure set below |

`disposition_reason` sets:

- **withhold:** `moderation_high`, `lint_failed`, `render_failed`,
  `budget_exceeded`, `consent_revoked`, `suppressed_at_dispatch`,
  `no_postal_address`
- **cancel:** `owner_veto`, `owner_halt`, `admin_halt`, `owner_excluded`,
  `send_window_elapsed`, `batch_expired`
- **failure:** `send_failed`, `send_exhausted`, `send_indeterminate`

**One `disposition_reason` column**, governed by a status↔reason consistency
CHECK in exactly the `solicitation_asks_status_reason_consistency` idiom — a
house pattern, so a reader who understands the ask table understands this one.

**The child-run failure vocabulary is three members, not #618 V4's seven.**
`moderation_withheld`, `lint_failed`, `budget_exceeded`, `render_failed` all
happen at *render* time, which D3 put on the parent as steps — no child run
exists yet. `consent_revoked` / `suppressed_at_dispatch` are `completed` under
D4 (the child evaluated and concluded, matching watch-mode's withhold
precedent). `halted` is `cancelled`.

**`bounced_at` / `complained_at` are additive columns, not statuses.** They are
post-send provider signals arriving asynchronously after `sent`; modelling them
as transitions creates a "sent → bounced → complained" ordering problem and
breaks the join's terminal set. #626's suppression feed reads
`bounced_at IS NOT NULL OR complained_at IS NOT NULL`.

Terminal set (for D11's join): `sent, withheld, cancelled, failed, unknown`.
Non-terminal: `rendered, queued, sending`.

### D6 — PII posture

**(a) Owner-readable pre-approval, with one carve-out.** Generate-then-approve
*requires* the owner read the body to approve it, so #618's S4 concern ("ask
RLS has no lifecycle gate ⇒ readable pre-approval") **inverts into a
requirement**. The carve-out: a body withheld by **moderation high-severity**
must not be owner-readable — invariant #4 read straight across (high-severity
reply drafts go to `flagged_responses` under admin-only deny-all RLS precisely
so the owner is never nudged to approve something unsafe; `/admin/flagged` is
the only re-notify path).

```sql
CREATE POLICY solicitation_outreach_owner_select ON solicitation_outreach
  FOR SELECT USING (
    account_id = owner_account_id()
    AND NOT (delivery_status = 'withheld' AND disposition_reason = 'moderation_high')
  );
```

The owner still sees the **count** of moderation-withheld asks (aggregate, no
body). Compliance-lint failures stay owner-visible: a deterministic,
explainable rule the owner benefits from seeing, not an unsafe-content hold.

**(b) Body survives send, then redacts.** Kept for dispute resolution and
deliverability forensics, then `rendered_subject` / `rendered_body` are NULLed
and `body_redacted_at` stamped, metadata row kept forever. **90 days** —
comfortably past the 14-day attribution window and past bounce/complaint
feedback lag. Data minimization on third-party PII held on the contact's
behalf.

**(c) No new poller for redaction** — folded into the existing
**ArchivalPoller**. CLAUDE.md's single-replica caveat means every new poller
grows the P2 duplicate-processing list; D7 already spends that budget once, and
this map grows it by **exactly one**.

**(d) Offboarding purge, and the #582 lesson applies directly.**
`delete_data` / `purge` must reach `solicitation_outreach` by `account_id`,
added to the purge inventory with a test. The purge **must take the
per-business solicitation advisory lock** before deleting — #582's failure was
purging `contact_csv_uploads` without the `csv_ingest` lock, and the analog
here is purging outreach rows while a dispatch transaction is mid-flight, i.e.
a send with no record of it.

**(e) Logging.** `rendered_subject` / `rendered_body` join the never-logged list
alongside raw review/response text. The rule is **"never interpolate a body
into a log string"**, not "the sanitizer will catch it" — object args pass
through the analytics blocked-key sanitizer, **string args are logged
verbatim**.

### D21 — Generation is triggered automatically on build, both lanes

The transaction that sets `built_at` also enqueues the generation lane
(`generate_solicitation_asks` topic, standard outbox pattern — invariant #2).
No owner "prepare" step.

**This is nearly forced by D2.** The approval window is anchored on `built_at`;
if rendering were owner-triggered, that 7-day clock would tick while nothing was
renderable. It is also the only shape compatible with the auto lane, which has
no owner in the loop by definition.

Consequences taken:

- LLM spend on batches nobody opens. Bounded by `BATCH_CAP` (25 renders),
  per-render cost guard (#628), and gated entirely by `SOLICITATION_SEND_ENABLED`.
- **A batch whose asks are all `withhold` produces nothing to render.** The
  build transaction does not enqueue generation when the batch has zero
  `status='send'` asks; no `solicitation_send_batch` parent is started and the
  batch is complete as a watch-mode spoilage report. This is the only path where
  the send lane never engages at all.
- If **every** render fails or is withheld, the send parent terminalizes
  `failed` with `disposition='generation_failed'` (D14) — nothing is releasable
  and the owner has nothing to approve.

### D22 — Owner edit of a rendered ask is out of scope

The owner may **approve** or **exclude** (D23). They may not rewrite the body.

Rationale: an edited body must re-enter the fail-closed compliance lint and
provider moderation before it can send — the lint is deterministic and
fail-closed precisely because an owner might type incentive language ("5 stars
for 10% off"), review-content steering, or gating-funnel phrasing, all of which
#531 §5 makes binding. Accepting an edit therefore means a second generation
path with its own failure modes, its own re-validation, and a superseding rule
for the one-live-attempt-per-ask index.

Deferred deliberately, not overlooked — May §6.3 [6b] specifies "edit +
approval." D23 removes the pressure: a single unacceptable message no longer
forces rejecting the batch.

### D23 — Partial approval: the owner may exclude individual asks

At approval, the owner may deselect any subset. Excluded asks are written
`delivery_status='cancelled'`, `disposition_reason='owner_excluded'`, in the
**same transaction** as the approval, and are therefore never releasable and
counted as settled by D11's join.

Cheap by construction: exclusion needs **no re-lint and no re-moderation**
because it only ever moves toward restraint, consistent with D20's principle.
It is the reason all-or-nothing approval is unnecessary and the reason D22 costs
the owner nothing real.

Approval writes are idempotent: `approved_at`, `approval_method`,
`approved_by_user_id` and `sending_started_at`'s precondition are all CAS'd on
`approved_at IS NULL`, so a double-submit cannot re-approve or re-exclude.

---

## 4. Dispatch (D7, D9, D10)

### D7 — Shape B: `SolicitationReleasePoller`

A Postgres-state-driven poller under `worker/background/pollers/` (correctly a
poller, not a scheduler). Each tick, per active batch: release what is due,
apply `send_window_elapsed` to what is overdue, and run the backstop join.

**Shape A (pre-computed `available_at` schedule) rejected on three grounds:**

1. **Halt has nowhere to go.** There is no `cancelled` outbox status, and
   `ci:outbox-status` guards `('pending','dispatching','dispatched')` for
   members *and order* across ~26 SQL sites and ~19 migrations — that
   vocabulary is effectively closed. `completed` is a lie; `failed` trips
   `checkFailedOutboxByTopic` for a deliberate owner action.
2. **The wake-up-and-no-op workaround** leaves a halted 3-day batch waking
   workers for 3 days and 25 `completed` outbox rows that never did work.
3. **It makes the send topic unobservable.** `checkOldestPendingOutbox` filters
   `available_at <= NOW()`, so a genuinely stuck send would hide among 25
   legitimately-future rows. Shape B keeps every in-flight send row due-now, so
   `checkOldestPendingOutbox` and `checkFailedOutboxByTopic` work on the send
   topic **unmodified**.

**The releaser subsumes the veto window.** The Reply lane needs
`veto-window-gate.ts`'s "complete this row, enqueue a fresh delayed one at
`first_sent + window`" trick precisely *because* nothing polls responses. Here
something does — so the veto window is `WHERE now() >= veto_deadline_at` in the
release predicate. Simpler than the precedent, not a deviation from it.

**Release transaction (one tx, invariant #2):**

```sql
-- guard 1: CAS on the outreach row
UPDATE solicitation_outreach SET delivery_status='queued'
  WHERE id = $1 AND delivery_status = 'rendered';
-- + typed helper enqueueSolicitationSend(...) → INSERT INTO job_outbox
```

**Guard 2 (#618 S10)** — the send topic is the one place in the system where a
duplicate outbox row means a **duplicate email to a real customer**, so it gets
both guards:

```sql
CREATE UNIQUE INDEX idx_jo_solicitation_send_inflight
  ON job_outbox (topic, aggregate_id)
  WHERE topic = 'solicitation_send'
    AND status IN ('pending', 'dispatching', 'dispatched');
```

byte-for-byte with the helper's `ON CONFLICT`. `ci:outbox-seam` (#568) forces
the typed helper: once `enqueueSolicitationSend` exists, no raw INSERT for that
topic may remain. `ci:outbox-topics` requires the matching `QUEUE_NAMES` entry.

**No `poller_cursors` row** — this is a state query (approved, unhalted,
in-window batches with releasable asks), not a cursor scan. The CAS plus the
partial unique index are the real defenses.

**Cost accepted, stated plainly:** one new poller on the P2 single-replica list
in `docs/future-plans/2026-06-17-worker-scaling-hardening-backlog.md`. Exactly
one for this whole map.

**Send worker shape** (production.md: never hold a lock across a slow remote
call; and `FOR UPDATE` outside `sql.begin()` is a no-op under PgBouncer):

```
tx1 (short): lock batch row → evaluate D18 dispatch gate → CAS queued → sending
provider call: NO lock held, provider idempotency key = outreach row id
tx2 (short): CAS sending → sent|failed  +  child run terminal  +  outcome
             +  outbox row completion   +  closeBatchIfSettled     ← ONE tx
```

### D9 — Veto window

| Lane | Window | Anchor |
|---|---|---|
| auto (`auto_policy`) | **60 minutes** | **first confirmed-delivered veto notice** |
| owner | **15 minutes** | `approved_at` |

Different lengths because the window does a different job in each. The auto
window is the owner's **only** chance to see-and-stop before something
irreversible reaches 25 real customers; the Reply lane's 15/30 covers a single
post that can be deleted afterwards, and an email cannot be recalled. The owner
window is an *undo* — the owner has already read every rendered message.

**Fail-closed condition (the load-bearing part).** #618 §1.8 records the Reply
lane's real discipline: the window is *elapsed-since-first-**delivered**-notice*,
read from immutable metadata — not a bare existence check, not a mutable delta.
Ported exactly:

> **Auto lane: `veto_deadline_at` is set when the veto notice is confirmed
> delivered, not at approval. No delivered notice ⇒ the releaser never
> releases.** The batch sits until its 72h send window expires and terminalizes
> `cancelled`. No email is sent.

Without it, a broken notification channel turns the Autopilot lane into silent
unreviewed sends — exactly what invariant #3 and the map's "never a silent
send" posture forbid.

**Immutability without widening a core table.** `approval_audit_log.response_id`
is `NOT NULL REFERENCES responses(id)` — hard-welded to the Reply lane; reusing
it means nulling a NOT NULL on a core table. Instead: `veto_deadline_at` is
written **once** via CAS (`WHERE veto_deadline_at IS NULL`) and never
recomputed, **and** the grant is recorded as an append-only step on the
`solicitation_send_batch` parent run with actor and granted-window detail. The
step is the immutable record; the column is the index.

**Daily-cap counting needs no audit log.** Count `solicitation_outreach` rows
with `sent_at` in the day — a send is an immutable fact no veto can refund.
Structurally better than the Reply lane's approval-row count, which exists only
*because* a veto NULLs `responses.approval_method`.

**Who may veto:** any owner-scoped user on the account (scoped by `account_id`
and, per-location, `business_id` — invariant #8), plus admin/support via the
admin surface. Not only the approver: multi-location accounts have several
staff, and "only the approver may stop it" creates a hole exactly when that
person is unreachable. Actor recorded on the batch row (`halted_by`) and in the
run step.

### D10 — Halt

**One monotone latch, two entry points.** A veto during the window and a halt
mid-drip are the **same write with different reasons** — a veto is "halt at zero
sends." Second halt is a no-op. System-initiated expiry rides the identical
path, which is why D2's send window was shaped this way.

Reason vocabulary: `owner_veto | owner_halt | admin_halt | send_window_elapsed
| batch_expired`.

**The disposition is written on `solicitation_outreach`, and nowhere else** —
this is the direct answer to the "withhold reason vs new terminal state" fork:
**neither.** `solicitation_asks.status` / `withheld_reason` is the frozen
restraint-policy decision, welded by 090 to `evidence->>'decision'`. A halt is
not a restraint-policy decision. Adding `halted` to `withheld_reason` would
require rewriting `evidence` on a row whose entire contract is that it never
changes — destroying `policy_version` attributability and firing the
three-constraint cascade. The ask keeps saying what the policy decided; the
outreach row says what happened.

**Halt transaction:**

```
lock batch row
SET halted_at, halt_reason, halted_by            -- CAS on NULL, monotone
UPDATE solicitation_outreach
  SET delivery_status='cancelled', disposition_reason=<reason>
  WHERE batch_id = $1 AND delivery_status IN ('rendered','queued')   -- NOT 'sending'
closeBatchIfSettled(tx, batchId)
```

**`'sending'` is excluded on purpose.** A row in `sending` is past the point of
no return and resolves itself. The honest contract (#618 §6): **halt means "no
further sends," not "undo," and the residual exposure is one child's
send-transaction duration** — the same contract the Reply lane's veto already
has.

**`pending` outbox rows for queued asks need no cancellation** — and this is
where D7 pays off concretely. Under Shape B they are due-now and few (K per
tick), so at halt time a handful exist; they dispatch within seconds, find
`delivery_status='cancelled'`, no-op, and complete normally. Under Shape A
there would be 25 future-dated rows lingering for days with no legal status to
move them to.

**Halt does not terminalize the parent directly** — it calls
`closeBatchIfSettled`, same as any child's terminal transaction. One
authoritative owner for parent terminalization, not two racing writers.

**No resume, and it is structurally prevented.** `halted_at` is monotone, the
releaser predicate requires `halted_at IS NULL`, and cancelled outreach rows are
terminal. Map decision 2 says "halt-able," not "resumable." Resuming re-opens
every gate — is consent still valid, is the rendered body stale, has the send
window expired — for zero proven demand. To contact those people the owner
builds a new batch.

---

## 5. Lifecycle correctness (D11, D12, D14, D15, D16)

### D11 — Join: inline last-writer + releaser backstop

The join condition is a **domain-table question**, not a spine question:

```sql
-- settled iff:
SELECT NOT EXISTS (
  SELECT 1 FROM solicitation_outreach
  WHERE batch_id = $1 AND delivery_status IN ('rendered','queued','sending')
);
```

`rendered` covers "still releasable," `queued`/`sending` cover "in flight." The
join never inspects `agent_runs` — so **#618 S9's proposed partial index
`(parent_run_id, status)` is not needed.** One less schema change than the gap
analysis budgeted.

- Every writer that terminalizes an outreach row (send worker's terminal tx,
  halt tx, failed-hook) calls **one** function, `closeBatchIfSettled(tx,
  batchId)`, **in the same transaction**. Because terminalization and the join
  check commit together, there is no window where a writer terminalizes and
  then crashes before joining. This kills #618 §7's "two children each see the
  other as non-terminal" hazard outright.
- **Serialized by the batch row lock**, taken first — domain-before-spine,
  matching `batch-builder`'s documented lock order and ADR 0011 D5's ordering
  rule. Stricter than leaning on `recordStep`'s lock-then-count trick, and it is
  the lock the halt path already takes.
- Parent terminal status per D4's rule, looked up from D14's `disposition`.

**Backstop costs nothing new.** The releaser already ticks every 60s over
exactly the set of active batches; it calls the *same* `closeBatchIfSettled`
for anything settled that was not closed inline. One implementation, two
callers — the backstop cannot drift from the inline path.

**No join poller, no reaper, no second loop.**

### D12 — Exhaustion

The dangerous orphan is not the child run; it is an outreach row stuck in
`sending`, because that is the state where we do not know whether a real
customer received an email.

**(a) One transaction is the whole defense.** Terminal outreach CAS + child run
terminal + `solicitation_sent` outcome + **outbox row completion** +
`closeBatchIfSettled` commit together. If that tx does not commit, the outbox
row is not completed either, so existing machinery still owns the work — the
watchdog re-pends `dispatched` rows older than 15 min while
`attempts < max_attempts`. The orphan class is closed by construction, not by
sweeping.

**(b) Provider-side idempotency key, derived from the outreach row id.** A retry
finding `delivery_status='sending'` cannot know whether the provider call
landed; CLAUDE.md names the answer ("drop the lock and use provider-side
idempotency keys"). Resend supports them. The retry re-issues with the same key
and gets the original result instead of sending twice. **Without this,
at-least-once outbox delivery means at-least-once email** — the one failure
this map cannot ship with.

**(c) Retry classification, locked here rather than left to the adapter:**

| Condition | Class |
|---|---|
| provider 4xx invalid-recipient / hard bounce | **terminal, zero retries** → `failed` + `bounced_at`, feeds #626 |
| provider 5xx, timeout, rate-limit | retryable under standard `max_attempts` |
| pre-LLM Redis transport failure (render lane) | retryable — `CostInfraUnavailableError` (#255) |
| budget exceeded | **terminal**, and must still count toward the join |

**(d) `unknown`.** If the releaser finds a `sending` row with no in-flight
outbox row past a grace period, (a) was violated. Terminalizing it `failed`
would be a lie with teeth: the restraint policy's `over_contacted` check reads
prior sends, so calling a possible send "not sent" can put that customer in a
*future* batch and email them twice. So: terminalize as **`unknown`**, raise a
Sentry alert, and treat `unknown` as "possibly contacted" for over-contact
purposes but **not** as a confirmed send for metrics or `review_attributed`.

`unknown` also resolves a deadlock this spec would otherwise ship: D10
deliberately excludes `sending` from the halt sweep, so without an escape a
wedged `sending` row would block `closeBatchIfSettled` forever and permanently
consume the account's one-active-batch slot (D8).

### D14 — Outcomes: two kinds, both on children

**Added:** `solicitation_sent`, `review_attributed`. Both on **child** runs,
both `unit_count = 1`.

`agent_outcomes_once_per_run_kind` forces per-child value events onto children —
emitting on the parent would collapse 25 sends into one row. Because both carry
`unit_count = 1`, **`agent_outcomes_unit_count_check` is untouched**: #618
§1.2(c)'s warning about a second zero-legal kind rewriting that CHECK never
fires. Both land in migration 091 even though `review_attributed` has no writer
until #632 — an unused kind is inert, and one-migration-in-flight makes a second
migration just for it expensive.

**NOT added (deliberate deviation from May §6.4):** `solicitation_skipped_policy`
and a batch-level `solicitation_batch_completed`. `agent_outcomes` is the
**value ledger** — the substrate outcome billing will read (design §8.5). A skip
has no value; an informational summary has no value. Both already have better
homes: the skip is the outreach row's `withheld` + `disposition_reason`, the
summary is the parent's terminal step. Adding valueless kinds to a value ledger
is how a billing substrate becomes untrustworthy.

**Parent attribution rides the existing step-`detail` precedent — zero new
schema.** `completeSolicitationBatchRun` already writes `withheld_by_reason`
into a step `detail` JSONB; the send parent writes the same shape:

```jsonc
{ "disposition": "exhausted",
  "sent": 18, "withheld": 4, "cancelled": 2, "failed": 1, "unknown": 0,
  "withheld_by_reason": { "suppressed_at_dispatch": 3, "moderation_high": 1 } }
```

`disposition` is a closed union mapping 1:1 onto the parent's terminal status:

| `disposition` | Parent status |
|---|---|
| `exhausted` | `completed` |
| `halted`, `expired` | `cancelled` |
| `gate_closed`, `generation_failed` | `failed` |

No "all-succeeded vs partial" discriminant — derivable from the counts in the
same object, and a stored one would be a second owner.

### D15 — The long-running parent

The parent spans generation → approval wait → veto → drip → close: worst case
~10 days (7d approval + 72h send). It trips `deriveRunDisplayState`'s 48h
`stalled` rule on every healthy batch. Split by audience:

**(a) Owner-facing display does not use `deriveRunDisplayState`.** It uses D2's
`deriveBatchState` over `solicitation_batches`. The owner's question is "what is
my batch doing" — a domain question with a domain answer. No duplication: the
run helper answers a different question for a different surface.

**(b) `deriveRunDisplayState` gains a kind-aware `stalled` threshold**, and the
number is derived from the contract: **11 days** for `solicitation_send_batch`.
D2's windows *guarantee* terminalization by day 10, so a run still `running` at
day 11 is genuinely stalled — the releaser backstop must have failed. The 48h
default is unchanged for every other kind.

> This is the trap #618 V5 flagged. The tempting fix is "raise the threshold";
> the right fix is "the threshold is a function of the run kind's contractual
> maximum lifetime."

**(c) One new health check, no new loop.** A `solicitation_send_batch` running
past 11 days holds the account's one-active-batch slot (D8) hostage. Added to
`HealthAlertPoller`'s existing check set.

### D16 — Attribution window

**(a) The child completes at send.** Minutes, not days.

**(b) There is no 14-day timer and no `wait_for_event`.** May §6.3's
`wait_for_async_signals` presumes an engine that can park a step; we have none
and D17 declines to build one. Instead, **attribution is a lookback evaluated
when a review arrives**: the review-ingest path checks `solicitation_outreach`
rows for that business with `sent_at` within the last 14 days and attempts a
match. The window is a **filter constant**, not a scheduled wait — no new
poller, no open run, no parked step, and strictly more correct because it
evaluates when the evidence exists.

**(c) The `review_attributed` outcome attaches to the (terminal) child run.**
`agent_outcomes_once_per_run_kind` forbids the parent. Attaching a value event
to a terminal run is the model's grain: outcomes are a **ledger of value
attributed to work**, not a sub-state of execution — which is exactly why
`agent_run_id` is `ON DELETE SET NULL`. 14 days versus 180-day archival carries
no timing risk.

**(d) Inherited, not solved here:** there is **no deterministic contact↔review
identity seam** — reviews carry no email/phone handle and name matching is
ambiguous, which is why `already_reviewed` was specified but inert in
watch-mode. `review_attributed` matching will be heuristic, which is exactly why
map decision 1 keeps it **shadow / no-charge**. This spec adds the *anchor*
(`solicitation_outreach.sent_at` + contact reference) and the outcome kind; it
does not claim to solve identity, and **#632 must not treat the anchor as having
solved it.**

---

## 6. Scope (D17)

**Steps stay receipts. Deliberate, recorded deviation from May §3.1.**

May's step shape presumes a step can represent work *in progress* — that is what
`wait_for_event`, `pending`/`running` step states, and `input`/`output` are for.
Our substrate already has **two** durable in-flight representations:
`job_outbox` status and `solicitation_outreach.delivery_status`. A third on
`agent_run_steps` would be a third owner of the same fact. D16 removed the last
thing that genuinely wanted a parked step.

Same argument kills `cost_cents`: **`api_costs` is the cost system of record**,
carrying the prompt-policy version hash on every row. A `cost_cents` column on
steps would be a second owner of spend, and the two would diverge the first time
a retry double-counted.

Taken anyway (neither is May's shape): generation writes ~25 steps on the
parent, so use the **existing bulk step writer** rather than 25 sequential
`recordStep` calls (each locks the parent row `FOR UPDATE`). Nothing else — no
new step columns, no `step_kind` taxonomy.

**Tripwire restated** (#529 Q6: ~2–3k LOC before buying Inngest/Temporal;
watch-mode spent ~600–800):

| Run-layer component | Est. LOC |
|---|---|
| migration 091 (outreach table, batch columns, `cancelled`, outcome kinds, indexes) | ~250 |
| `run-spine.ts` widening (`cancelled`, extended fail union, lazy child creator) | ~150 |
| `SolicitationReleasePoller` (release + expiry + backstop join) | ~250 |
| send worker + failed hook + `closeBatchIfSettled` | ~350 |
| **send-mode run-layer subtotal** | **~1,000** |
| **cumulative in-house run engine** | **~1,600–1,800** |

The remainder of the map (~2k: generation lane, approval UI, email adapter,
suppression, consent, attribution) is **domain code, not run-engine code**, and
does not count against a tripwire about buying a workflow engine.

**Decision: do not buy Inngest/Temporal now.** The margin is now visible; the
explicit re-check point is the **Phase 3 Reply migration**, when the run engine
takes on its highest-volume tenant.

---

## 7. Gates and policy (D18, D19, D20)

### D18 — `consent_recheck` has real content, but not May's content

#618 S6 is right that the upload attestation is **immutable**, so re-reading it
at dispatch is inert. What can actually change between approval and dispatch is
a bundle. Specified as one named **dispatch precondition gate**, re-evaluated
inside every child's short pre-send transaction:

1. **suppression ledger** (#626) — the real consent content
2. **postal address on file** (map decision 6 makes it a send precondition; no
   address ⇒ `withheld` / `no_postal_address`)
3. `subscriptionGrantsFullAccess` (invariant #11)
4. `SOLICITATION_SEND_ENABLED`
5. batch not halted (D10's latch)
6. per-business / per-account daily caps (D20)
7. contact still exists and not offboarding-purged

**This confirms the map's blocking edge is already correct.** #630 is listed as
blocked by #626, and #618 D12 asked whether that is a correctness dependency or
just the unsubscribe link. It is **correctness**: without the suppression
ledger, item 1 is empty and `consent_recheck` degenerates into ceremony. No map
edit needed.

**Judge — interpretation of locked map decision 7.** The map says Judge
unavailability ⇒ "downgrade to owner review, never silent send
(`ResponsePublisherWorker` precedent)." That precedent scopes the downgrade to
**unposted** rows; a batch mid-drip has no analog, and un-approving a batch that
has already sent 12 of 25 emails produces an incoherent state. Split by whether
anything has been sent:

- **Before the first child dispatches:** Judge off/unhealthy ⇒ **downgrade** —
  clear `approved_at` / `approval_method`, return the batch to owner review.
  Direct port of the unposted-row precedent.
- **Mid-drip (≥1 send):** the releaser **holds** — no releases while Judge is
  unhealthy, no state change, resumes on recovery. If Judge never returns, the
  72h send window expires and the batch terminalizes `cancelled` with
  `send_window_elapsed`. Fail-closed, never a silent send.

**Judge writes no verdicts in v1.** Availability is the precondition, full stop.
Per-ask Judge review and Judge auditing of withholds are §9.4 / the map's "Not
yet specified" list. #631 must not grow a verdict path.

### D19 — Widen `auto_approval_policies`

074's own column comments sanction it ("Solicitation widens the CHECK in its own
migration — design §3.3"), and both uniqueness indexes already carry
`(persona, action_class)` in their predicates, so the scoping model needs no
change.

**The decisive argument is the Governor.** `suspended_at` / `suspended_reason`
is the per-account autonomy kill switch. A separate policy table means the
Governor must learn a second surface to suspend — and a safety mechanism that
must be taught about each new persona will eventually miss one.

**Correction 1 — do not overload `daily_auto_post_cap`.** Its name is
Reply-specific; reusing it for sends is a lie a future reader will trip on. Add
nullable **`daily_send_cap SMALLINT`** (`NULL OR 1..50`). The existing scoping
gives D20's two-level cap for free: the **account-default row**
(`location_id IS NULL`) carries the per-account cap; a **location-override row**
carries the per-business cap. One column, both caps, existing machinery.

**Correction 2 — cross-persona consistency CHECK** (same idiom used three times
in this spec):

```sql
CHECK ( (persona = 'reply'        AND daily_send_cap IS NULL)
     OR (persona = 'solicitation' AND auto_approve_min_star IS NULL
                                  AND daily_auto_post_cap IS NULL
                                  AND veto_window_minutes IN (30, 60)) )
```

Otherwise rows carry a star threshold for an agent that does not read stars —
inert nonsense that reads as intent.

Plus: widen `auto_approval_policies_veto_window_check` from `(15,30)` to
`(15,30,60)`.

**The Governor needs zero code changes.** The send lane's auto-approval gate
checks for an active suspension on **any** policy row for the account, not just
the solicitation row. Design §8 calls the Governor "per-account autonomy
suspension," so "the account's autonomy is suspended ⇒ no persona acts
autonomously" is the faithful reading; per-gate/per-persona suspension is
explicitly §9.4-deferred. Conservative, fail-closed, and a Governor trip during
the Reply rollout automatically protects Solicitation.

### D20 — Trust dial: adjustable toward restraint only

| Knob | Owner-adjustable? | Bound |
|---|---|---|
| `daily_send_cap` | **yes** | 1–50; **effective = `LEAST(configured, platform default for scope)`** |
| `veto_window_minutes` (solicitation) | **yes** | 30 or 60 — **not 15** |
| `BATCH_CAP` (25) | **no** | code constant |
| min send interval, approval window, send window, one-active-batch | **no** | mechanism, not policy |

**Principle: the dial moves toward more restraint, never less.**

`daily_send_cap` keeps a simple `1..50` CHECK; the principle is enforced in the
**resolver** via `LEAST(configured, platform default)`, so an account-default row
cannot exceed 50 and a location-override row cannot exceed 25 without a
per-scope CHECK the schema cannot cleanly express. One function owns the
ceiling.

**Veto window:** 30/60 only for solicitation. 15 minutes is defensible for a
single reply the owner can delete afterwards; it is not defensible as the entire
review period for 25 irreversible emails. Default 60.

**`BATCH_CAP` stays fixed** — it is the self-protective guardrail against the
Google enforcement pattern #531 documents, whose failure mode is an account's
reviews being wiped or its profile suspended. If it were owner-adjustable, the
owner most motivated to raise it is precisely the one who should not. Owners
already have a legitimate way to send less (upload fewer contacts); they get no
lever to send more. Asymmetric by design.

**How the owner turns the auto lane on:** **absence of a `persona='solicitation'`
policy row = auto lane off.** The owner opts in through server routes
(invariant #14 — never a direct client write to `auto_approval_policies`), and
it still requires the Autopilot tier via `tierGrantsAutopilot` plus both server
flags. **Four independent things must be true** before a batch can auto-approve.

---

## 8. Constants

All code constants. **No env vars** — env vars are for flags, not tuning
(`flag-flip` discipline); a tuning knob in Railway config is an untested
production change.

| Constant | Value | Job |
|---|---|---|
| `BATCH_APPROVAL_WINDOW` | 7 days | D2 |
| `BATCH_SEND_WINDOW` | 72 hours | D2 |
| `RELEASE_TICK_MS` | 60_000 | D7 poller cadence |
| `MIN_SEND_INTERVAL_MINUTES` | 15 | ~6h for 25 asks, wide margin inside 72h |
| `DEFAULT_DAILY_SEND_CAP_BUSINESS` | 25 | one full batch/day ceiling |
| `DEFAULT_DAILY_SEND_CAP_ACCOUNT` | 50 | shared-domain blast radius (map decision 6) |
| `VETO_WINDOW_MINUTES_AUTO` | 60 | D9 |
| `VETO_WINDOW_MINUTES_OWNER` | 15 | D9 |
| `ATTRIBUTION_LOOKBACK_DAYS` | 14 | D16 |
| `BODY_RETENTION_DAYS` | 90 | D6 |
| `STALLED_THRESHOLD_SEND_BATCH_DAYS` | 11 | D15 |
| `UNKNOWN_GRACE_MINUTES` | 30 | D12d — how long a `sending` row may sit with no in-flight outbox row before it terminalizes `unknown`. Must exceed the outbox watchdog's 15-min re-pend window, or a normally-recovering row would be declared indeterminate |
| `BATCH_CAP` | 25 | existing, `restraint-policy.ts:78` |

---

## 9. Migration 091 shape (owned by #624)

One migration, additive, re-runnable, transactional. **One migration ticket in
flight at a time** (map #617 Notes) — #625 and #626 follow with their own.

1. **`agent_runs`** — replicate 071's `agent_runs_status_check` text with
   `'cancelled'` appended. Add `'solicitation_send_batch'` to the `kind` CHECK
   and the pair `('solicitation_send_batch','solicitation_batch')` to
   `agent_runs_kind_subject_type_pairing`. **`agent_runs_terminal_consistency`
   and `agent_runs_one_active_per_subject` are NOT touched** — verify in review.
2. **`agent_outcomes`** — replicate the `outcome_kind` CHECK with
   `'solicitation_sent'` and `'review_attributed'` appended.
   **`agent_outcomes_unit_count_check` is NOT touched.**
3. **`solicitation_batches`** — add `approved_at`, `approval_method`
   (`CHECK IN ('owner','auto_policy')`), `approved_by_user_id`,
   `veto_deadline_at`, `sending_started_at`, `send_closed_at`, `halted_at`,
   `halt_reason` (closed CHECK), `halted_by`. Ordering CHECKs in the style of
   the existing `built_at`/`reviewed_at` pair. Plus D8's partial unique index.
4. **`solicitation_asks`** — add
   `UNIQUE (id, account_id, business_id)`. Prerequisite for the outreach→ask
   composite tenant FK; 088 gave this shape to `solicitation_batches` and
   `agent_runs` but not to asks. Additive, no data change.
5. **`solicitation_outreach`** — new table with the full column list and the
   five composite tenant FKs in §3, plus:
   - `delivery_status` ↔ `disposition_reason` consistency CHECK (the
     `solicitation_asks_status_reason_consistency` idiom)
   - body-presence CHECK keyed on `body_redacted_at IS NULL`
   - partial unique `(ask_id) WHERE delivery_status IN ('rendered','queued','sending')`
     — at most one live attempt per ask
   - `(batch_id, delivery_status)` for release + join
   - `(business_id, sent_at)` for daily-cap counting
   - RLS: owner SELECT with the moderation carve-out (§3 D6a); service role full
6. **`auto_approval_policies`** — widen `persona` CHECK with `'solicitation'`,
   `action_class` with `'sending'`, `veto_window_minutes` to `(15,30,60)`; add
   `daily_send_cap`; add the cross-persona consistency CHECK (D19).
7. **`job_outbox`** — D7's partial unique in-flight index for the
   `solicitation_send` topic, byte-for-byte with the helper's `ON CONFLICT`.
   A second in-flight index for `generate_solicitation_asks` keyed on
   `batch_id`: a duplicate there costs 25 wasted LLM renders rather than a
   duplicate email, but it is the same one-line guard and
   `enqueueBuildSolicitationBatch` is the local example of what omitting it
   looks like (#618 §1.7).

Review checklist for this migration:

- [ ] `ci:outbox-status` passes — in-flight literal re-spelled in members-and-order
- [ ] `ci:outbox-topics` — `solicitation_send` in `QUEUE_NAMES`
- [ ] `ci:outbox-seam` — `enqueueSolicitationSend` helper exists; no raw INSERT for the topic
- [ ] `ci:rls-audit`, `ci:tenant-scope` pass for the new table
- [ ] `ci:db-imports` — new modules take `sql`/`tx` explicitly (invariant #15)
- [ ] offboarding purge inventory updated + test
- [ ] `pnpm test:db:setup` re-run; `assertSchemaReady` map updated (migration→objects)
- [ ] applied **staging first**, both Supabase projects in lockstep

---

## 9A. Code layout, invariants touched, test obligations

### Layout (CLAUDE.md "Worker layout" conventions)

| Path | Contents |
|---|---|
| `worker/jobs/solicitation-send/` | send worker + helpers; **`failed-hook.ts`** colocated with its worker per the sanctioned `'failed'`-exhaustion pattern (sibling of `publisher/failed-hook.ts`) |
| `worker/jobs/solicitation-generate/` | generation lane (#628): render → moderation → compliance lint → outreach row |
| `worker/background/pollers/solicitation-release/` | D7 releaser: release + `send_window_elapsed` + backstop join + D12d `unknown` sweep |
| `src/lib/solicitation/outreach.ts` | `closeBatchIfSettled`, `deriveBatchState`, release/CAS helpers |
| `src/lib/shared/job-outbox-helpers.ts` | `enqueueSolicitationSend`, `enqueueGenerateSolicitationAsks` |
| `src/lib/shared/queue-names.ts` | `solicitation_send`, `generate_solicitation_asks` |

Two new topics, two new queues, one new poller. Every module under
`src/lib/**` and every worker helper takes `sql` / `tx` as an **explicit
parameter** (invariant #15) — only `worker/index.ts` and route handlers import
the singleton. `ci:db-imports` is strict with no baseline.

### Invariants touched, and how

| Invariant | Interaction |
|---|---|
| **#2 outbox** | build tx enqueues generation (D21); release tx writes the CAS + outbox row together; the send worker's terminal tx completes its own outbox row (D12a). Two new typed helpers; `ci:outbox-seam` then forbids raw INSERTs for those topics |
| **#3 no unapproved posting** | its *letter* governs replies reaching Google. The send lane is a **different public action** and adopts the same discipline **by analogy**: no email may leave without `approval_method ∈ ('owner','auto_policy')` recorded on the batch, the auto lane gated by tier + flags + Judge availability + veto window. Stated explicitly so a reviewer does not read the analogy as scope creep |
| **#4 high-severity held, not notified** | ported to rendered asks: moderation-high ⇒ `withheld`/`moderation_high`, body not owner-readable (D6a), no notification, admin-only visibility |
| **#8 tenant scope** | every read/write scoped by `account_id` and, per-location, `business_id`. New table carries both |
| **#9 businesses = location** | batches and the one-active-send index are **per business**; account-level caps resolve through `auto_approval_policies`' existing default/override scoping (D19) |
| **#11 subscription guard** | `subscriptionGrantsFullAccess` checked at build, at generation, at approval, and again at dispatch (D18 item 3). Never a raw `=== 'active'` |
| **#12 entry points orchestrate** | the send worker maps errors and delegates; retry classification (D12c) lives in a named module with focused tests |
| **#14 policy access is server-owned** | solicitation policy rows are written only through server routes; `ci:static-policy` blocks client references to `auto_approval_policies` |
| **#15 explicit DB client** | see Layout |

**`agent_runs_parent_business_required`**: lazy children carry `parent_run_id`,
so their `business_id` **must be non-NULL**. Batches are per-business, so this
is satisfied by construction — but the child writer must pass `business_id`
explicitly, and a NULL would fail the CHECK at insert rather than silently
skipping FK validation (MATCH SIMPLE composite FKs skip validation on any NULL
column, which is exactly why 088 added that CHECK).

**`sending_started_at`** is written by the **first successful release** for the
batch, CAS'd on `sending_started_at IS NULL`, in the release transaction. It is
the fact that distinguishes `approved` from `sending` in `deriveBatchState`, and
the fact D18's Judge split reads to decide downgrade-vs-hold.

### Test obligations (repworth.md "Always do")

Required, not optional — these are the categories that list names explicitly:

- **Idempotency keys**: release CAS double-fire; provider idempotency key on
  retry (D12b) — the test that a re-dispatched job does **not** send twice
- **Outbox transitions**: the partial-unique in-flight guard rejects a duplicate
  `solicitation_send` row; the byte-for-byte `ON CONFLICT`/index pairing
- **Tenant-scoped queries**: every `solicitation_outreach` read is
  `account_id`-scoped; RLS moderation carve-out (D6a) hides the body and shows
  the count
- **Subscription guards**: each of the four checkpoints above, incl. `trialing`
  treated as full access
- **Approval-token / approval paths**: veto authorization (D9d), the CAS
  idempotency of approve and exclude (D23)
- **Halt**: monotone latch; second halt is a no-op; `sending` rows excluded;
  `pending` outbox rows no-op cleanly
- **Join**: last-writer closes exactly once under concurrent child terminals;
  the backstop and inline paths agree (same `closeBatchIfSettled`)
- **Windows**: approval expiry blocks both lanes; `send_window_elapsed`
  terminalizes through the halt path
- **Fail-closed**: no delivered notice ⇒ auto lane never releases (D9)

Live-DB suites must be named `*.integration.test.ts`, must **not** apply
migration SQL, and must `assertSchemaReady` — `ci:live-db-suites` enforces both.
Run the matching integration file explicitly with `TEST_DATABASE_POOL_URL` set;
`pnpm test:integration` hard-gates only the publisher suite.

---

## 10. Per-ticket bindings

| Ticket | Bound by |
|---|---|
| **#624** spine lifecycle + fan-out primitives | migration 091 (§9); `cancelled` + D4 rule; extended `failSolicitationBatchRun` union; lazy running-child writer (one at a time, through `ON CONFLICT`); `closeBatchIfSettled`; kind-aware stalled threshold (D15b); `HealthAlertPoller` check (D15c); ArchivalPoller redaction hook (D6c); purge + advisory lock (D6d) |
| **#628** ask-generation lane | **triggered automatically by the build tx (D21)**, not by the owner; skipped entirely when a batch has zero `send` asks; renders into `solicitation_outreach` (D5); moderation-high ⇒ `withheld`/`moderation_high`, never owner-readable (D6a); lint fail ⇒ `withheld`/`lint_failed`, owner-visible; per-render cost guard → `api_costs`, **not** step `cost_cents` (D17); generation steps bulk-written on the parent (D3, D17); all-renders-failed ⇒ parent `failed` / `generation_failed` (D14) |
| **#629** owner approval lane | approval writes D2 columns, CAS'd on `approved_at IS NULL` (D23); **no edit surface (D22)**; **per-ask exclusion (D23)** writing `cancelled`/`owner_excluded` in the approval tx; `deriveBatchState` is the owner-facing display (D15a), never `deriveRunDisplayState`; halt/veto affordance is D10's single latch; owner reads bodies pre-approval subject to D6a |
| **#630** dispatch/drip worker — **first ticket that SENDS** | Shape B releaser (D7); release CAS + partial-unique double guard; send worker tx shape (§4); **provider idempotency key (D12b)**; retry classification (D12c); D18's 7-check dispatch gate; D18's Judge downgrade/hold split; `unknown` (D12d); inline join (D11) |
| **#631** auto-approval lane | D19 policy widening; D9's 60-min window **anchored on confirmed notice delivery, fail-closed**; `tierGrantsAutopilot`; account-wide suspension read; four-condition opt-in (D20) |
| **#632** `review_attributed` shadow attribution | D16 lookback-at-ingest, no timer; outcome on the terminal child run; **must not treat the anchor as having solved the identity seam** (D16d); `unknown` rows are not confirmed sends |
| **#633** staging flip + evidence | both lanes proven; flip evidence per the watch-mode precedent |
| **#621 / #626** suppression | feed is `bounced_at IS NOT NULL OR complained_at IS NOT NULL` (D13); #626 is a **correctness** blocker for #630 (D18) |
| **#622** sender identity + deliverability | inherits the **quiet-hours** decision and the finding that **`businesses` has no timezone column** (D-Q8d) |

---

## 11. Deviations from the May reference design — deliberate, recorded

| May §  | Reference design | This spec | Why |
|---|---|---|---|
| §3.1 | 6-state run enum incl. `pending`, `held_for_approval`, `cancelled` | one new **terminal** state only; active states derived | active growth rewrites a CHECK, rebuilds an index, and edits a writer's `ON CONFLICT` where a mismatch fails **silently** (D1) |
| §3.1 | `step_kind`, `input`/`output`, `cost_cents`, `tool_authorization_id` | steps stay receipts | two durable in-flight representations already exist; `api_costs` owns spend (D17) |
| §3.2 | `solicitation_outreach` created at send | created at **render** | generate-then-approve puts the artifact before the send; one row makes "approved = sent" structurally true (D5) |
| §6.2 | `throttled_fan_out` creating N children | lazy children at release | the plan lives in `solicitation_asks`; halt gets nothing to cancel (D3) |
| §6.2/§6.3 | `wait_for_children`, `wait_for_async_signals` | inline join; 14d **lookback**, no timer | no engine to park a step, and none is needed (D11, D16) |
| §6.3 [6b] | `hold_for_approval` → owner **edit** + approve | approve or **exclude** only | an edited body must re-enter the fail-closed lint + moderation; per-ask exclusion removes the pressure (D22, D23) |
| §6.4 | `solicitation_skipped_policy`, `solicitation_batch_completed` outcome kinds | not added | `agent_outcomes` is the value ledger; valueless kinds erode it (D14) |
| §6.5 | per-account/day caps as policy rules | policy caps **plus** a structural one-active-batch index | batch *frequency* was unbounded; the index is not bypassable (D8) |

---

## 12. Deliberately NOT in this map

- **Resume / un-halt** (D10) — halt is monotone; build a new batch.
- **Owner editing of a rendered ask** (D22) — an edit must re-enter the
  fail-closed compliance lint and provider moderation; D23's per-ask exclusion
  removes the pressure. May §6.3 [6b] deferred deliberately.
- **Proportional-to-transaction-volume pacing** (#531 §1.5) — D8's index is the
  standing structural substitute.
- **Quiet hours** — → #622; blocked on a missing `businesses` timezone column.
- **Judge verdicts on solicitation asks**; Judge auditing of withholds; Governor
  per-gate suspension (§9.4).
- **Attribution precision / billable-grade gate** (May §6.4 M3) —
  `review_attributed` stays shadow/no-charge.
- **The contact↔review identity seam** — inherited unsolved (D16d).
- **Buying Inngest/Temporal** — re-check at the Phase 3 Reply migration (D17).
- **SMS/voice, billing/metering, custom sending domains, voice-conditioned asks,
  booking integrations, position read-model** — map #617 "Out of scope".

---

## 13. Known-soft decisions (flagged for revisit)

Recorded so a future reader finds a judgment, not an assumption:

1. **The 60-minute auto veto window (D9)** is a judgment, not a derived number.
   The Reply lane's 15/30 is the only precedent and it covers a reversible
   action. Revisit with staging evidence on notice-delivery latency.
2. **`unknown` (D12d)** is a low-probability state with a real consequence. If
   staging shows it never fires, it stays as the deadlock escape; if it fires
   regularly, (a)'s single-transaction discipline is broken somewhere and that
   is the bug to fix.
3. **The Judge downgrade/hold split (D18)** is an *interpretation* of locked map
   decision 7, which states downgrade without distinguishing pre-first-send from
   mid-drip. If the owner intended downgrade in both cases, D18 changes and #631
   must handle a half-sent batch returning to owner review.

---

## Appendix A — ADR 0014 draft (extract to `docs/adr/0014-…` in #624)

> **0014 — Send-mode: one terminal spine state, no active ones; batch lifecycle
> stays on the domain entity; children are lazy**
>
> Date: 2026-07-28 · Status: proposed (accept with #624)
> Context: ticket #619 (wayfinder map #617); spec
> `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md`; gap analysis
> `docs/research/2026-07-28-send-mode-executor-gap.md (branch `research/send-mode-executor-gap`)` (#618). Supersedes nothing;
> completes ADR 0011's deferred set.
>
> **Context.** ADR 0011 deferred physical fan-out, join, halt/lifecycle verbs,
> and status growth to send-mode as "their first real requirement," and
> promised send-mode would add *states and verbs, not columns-plus-rework*.
> #618 verified that promise against `main` and found the cost of enum growth
> is **asymmetric**: `agent_runs_terminal_consistency` is written as an
> equivalence on `'running'`, so a new **terminal** state satisfies it
> unchanged while a new **active** state rewrites it, rebuilds
> `agent_runs_one_active_per_subject`, and forces a byte-for-byte edit of the
> writer's `ON CONFLICT` — where a mismatch stops enforcing uniqueness
> **silently**.
>
> **Decision.**
> 1. The spine gains exactly one new status, `cancelled`, terminal. No active
>    states. `completed` = plan exhausted naturally; `cancelled` = stopped
>    early by a decision or a deadline; `failed` = execution error.
> 2. Batch approval, veto, and halt state live on `solicitation_batches` as
>    monotone timestamps with a read-time `deriveBatchState`. `held_for_approval`
>    is **derived** (`waiting_on_owner`, WS5 precedent), never stored.
> 3. Send-mode children are created **lazily at release**, one per dispatch
>    attempt, under a new parent kind `solicitation_send_batch`. The plan lives
>    in `solicitation_asks` (ADR 0011 D5); the spine records work performed.
> 4. Halt is a monotone latch on the batch with two entry points (owner veto
>    pre-first-send, owner/admin halt mid-drip) and a system entry
>    (`send_window_elapsed`). No resume.
> 5. Per-ask send lifecycle and rendered artifacts live in a new
>    `solicitation_outreach` table, not on `solicitation_asks`.
>
> **Consequences.**
> - **ADR 0011's promise holds on the spine and does not hold on the domain
>   tables** — and the reason is not ADR 0011's error. Migration 090 (#593,
>   four days later) welded `solicitation_asks.status` to
>   `evidence->>'decision'`, making the ask's status a provenance column. That
>   forecloses reusing it for a send lifecycle regardless of any spine
>   decision. Recorded rather than papered over.
> - Both coupled constraints stay byte-for-byte frozen; the writer's
>   `ON CONFLICT` is untouched. #618's S9 parent-join index is not needed
>   because the join is a domain-table question.
> - Lazy children mean halt has nothing to cancel in the spine, no child is
>   long-lived enough to be misread as `stalled`, and a bulk *running*-child
>   writer is not required.
> - The parent is legitimately long-lived (≤10 days by construction), so
>   `deriveRunDisplayState`'s `stalled` threshold becomes **kind-aware**, set
>   from the kind's contractual maximum lifetime rather than raised by feel.
> - Cost of reversal: moving batch lifecycle onto the spine later requires the
>   coupled CHECK/index/writer change this ADR avoids, plus a backfill — the
>   same deliberate trade ADR 0011 made, taken again with the evidence that the
>   asymmetry is real.
