# ADR 0023 — The Refusal ledger surfaces a category, never a reason

## Status

Accepted — 2026-08-29. Records the decisions that govern what may cross from a
**Refusal** to the owner's screen.

Terms: `CONTEXT.md` → **Refusal**, **Refusal category**, **Refusal source**,
**Restraint tab**. Schema: migration `116_refusal_events.sql` (locked in #1001).
Map: #994.

**Carried and corrected from the parked branch `feat/refusal-log`.** That
version was written against a projection over seven existing tables, and three
of its claims are now false. They are corrected in place below and flagged
where the correction matters, because a reader who trusts a stale ADR is worse
off than one who has none.

## Context

RepWorth's product claim has two halves — "we answer your reviews" and "we
never post something you would regret." The dashboard showed the first. The
second was invisible: reasons existed in seven tables and the owner saw almost
none of them. In one case the hiding was active rather than passive — a held
draft is **subtracted** from the owner's pending count
(`src/lib/dashboard/pending-count.ts`), so a draft we refused to send simply
vanished from a number the owner watches.

Two of those tables are admin-only by design, and their reason columns can
quote unsafe generated text.

**Correction 1 — the projection does not work, and that is why a table
exists.** The parked ADR assumed the surface could be derived on read. It
cannot be ordered: two of the seven lanes carry no immutable timestamp of their
own, and `account_audit_log` has no location key, so joining it through
`businesses` multiplied one account-wide suspension by the location count.
Migration 116 records a **Refusal** at the moment it is decided instead.
`occurred_at` and the biconditional CHECK C3 exist because of those two
defects, specifically.

## Decisions

### 1. A category crosses the boundary; a reason never does

`flagged_responses` keeps deny-all RLS. No policy is added. The read reaches it
only through the RLS-bypassing `postgres` role, scoped in the application layer
(invariant #8), and `flagged_responses.reason` is **never selected** — not
projected, not filtered on, not logged.

The owner sees the **Refusal category** plus the subject *id* (which review),
and can follow a link to it. They never see the draft text, the review text, or
the moderation reason.

Nothing on a `refusal_events` row is reason text. `refusal_code` and
`all_refusal_codes` are closed enum members, not prose, and both stay
server-side regardless under decision 5. `flagged_responses.reason` is the one
true prose field in the domain and it is deliberately not on this table.

The precedent is `src/components/dashboard/timeline/step-facts.ts`: a per-key
allowlist with a closed `allowed` set, so what may cross is enumerated rather
than what may not.

### 2. A judge verdict is not a refusal

The Judge runs on **already-posted** replies (`judge-policy.ts`,
`judge-store.ts` `WHERE r.status = 'posted'`, `worker/jobs/judge/context.ts`).

A verdict is therefore a post-publication observation, not something RepWorth
chose not to do. Counting one would be false on a screen whose only value is
being trustworthy, and it would double-count: a judge flag triggers an autonomy
suspension, which *is* a **Refusal** and is already recorded on the
`autonomy_suspended` lane.

`judge_verdicts` was in the original brief's source list. It was dropped after
the timing was checked. Its deny-all RLS is untouched.

### 3. Two axes, not one flat enum

A flat enum over every source reaches ~40 members and the screen becomes a
lookup table. Instead:

- **Axis A** — **Refusal category**, closed, precedence-ordered, on the
  `WITHHOLD_REASONS` model. This is what the owner reads.
- **Axis B** — **Refusal source**, the lane plus the verbatim code. **Per-lane,
  not global**, because one code means different things in different lanes.

`admin_halt` and `platform_halt` are why the split is per-lane rather than a
convenience. `latchHalt` copies a batch's halt reason through to every affected
Outreach row as its `disposition_reason`, so the same code string appears on two
different tables. On `batch_halted` it maps to `autonomy_paused`; on the Outreach
copies it maps to `null`, and a global code→category map would report one halt
once at the batch and again per recipient.

**Precise about which Outreach rows, because the imprecise version misleads a
writer.** Migration 111's `solicitation_outreach_status_reason_consistency`
admits `admin_halt` and `platform_halt` on the **cancelled** arm only, never the
withheld one. So the copies are `cancelled` rows, and a `cancelled` row is not
an `outreach_withheld` **Refusal** at all — it is an act that was called off,
which the **Refusal** term already excludes. The `null` mapping is therefore
belt-and-braces over a lane those rows never enter, and it is kept for the
reason §4 gives: `null` records the decision "not a refusal", so a future reader
finds an answer rather than an omission.

**Correction 2 — the counts.** The parked text said seven categories and six
lanes. It is **eight categories** (`owner_review_required`, #998) and **seven
lanes** (`policy_gate_held`, #1003). Migration 116's two column CHECKs are the
storage-level authority for both closed sets.

### 4. `null` is a decision, never an omission

Every source code maps to a **Refusal category** or to explicit `null` with a
one-line reason. The test uses `Object.hasOwn`, not truthiness, so a member
nobody decided about fails rather than silently reading as "not a refusal".

**A `null`-mapped code writes no row at all.** It never reaches the schema, so
there is no such thing as a `refusal_events` row with a null category —
`refusal_category` is `NOT NULL`.

The resolver **throws** on an unrecognised code. A default would file an
unmapped refusal under a plausible-looking heading, and the owner could not tell
the difference.

**Two owners, one fact each.** The closed category set lives in a storage CHECK,
migration-bearing on ADD and on nothing else. The code→category *map* lives in
TypeScript. A CHECK pinning `held_draft` to `unsafe_content` was rejected for
exactly that reason: true today, but it would make a future lane re-map
migration-bearing, against #995.

### 5. `all_refusal_codes` is never owner-facing, and deny-all RLS is what makes that a guarantee

**This decision is new here.** The parked ADR predates the column.

`refusal_events.all_refusal_codes` holds the full set of co-occurring
`AutoApprovalBlockReason` codes for a `policy_gate_held` **Refusal** — the
losing gates as well as the winner recorded in `refusal_code`. Its consumers
are support and trust-dial tuning. It is **not** owner-facing.

`refusal_events` therefore has `ENABLE ROW LEVEL SECURITY` and **zero
policies** — deny-all, the `auto_approval_policies` and
`solicitation_suppressions` posture. The **Restraint tab** reads through a
server route that projects the category, `occurred_at` and the link target.

Deny-all is load-bearing, not a default. **RLS filters rows, not columns.** An
owner-readable policy scoped by `account_id` would still expose every column of
every row it admitted, so withholding `all_refusal_codes` would require a view
or a column GRANT — and this guarantee would stop being one line.

The array's **members** are deliberately not constrained against the 22
`AutoApprovalBlockReason` values. That enum lives in TypeScript and has no
migration owner; spelling it into a CHECK would create a second authority that
drifts. An exhaustiveness test guards it at the type layer, where it belongs.

## Limits, stated rather than papered over

### The subject link can expire; the Refusal cannot

The subject is stored as `(subject_type, subject_id)` with **no foreign key and
no referential action**. `NULL` means "this lane points at nothing"
(`autonomy_suspended`, by design); a non-null id that no longer resolves means
"the subject aged away". `ON DELETE SET NULL` collapses the second into the
first and the owner cannot tell them apart.

The read rule follows: **the Restraint tab drops the link, never the row.** The
category and `occurred_at` are always true; only the link is contingent.

No lane's link expires today — every subject sits in a table `ArchivalPoller`
does not sweep, and the outreach row survives its 90-day body redaction because
the ledger never reads that content. The rule exists for the lane that
eventually does.

### One timestamp can still drift

`solicitation_outreach` has no disposition timestamp, and its withheld arm has
**two writers** with two different correct answers:

**The reason does NOT determine the writer, and an earlier version of this
table said it did.** Corrected 2026-08-29 after a red-team pass proved the two
sets intersect:

| Reason | Writer(s) | Anchor |
|---|---|---|
| `render_failed` | `ask-generation.ts` only — inserts the row already withheld | `rendered_at` — `NOT NULL`, never updated |
| `lint_failed`, `moderation_high` | **BOTH.** `ask-generation.ts` at render time, and `dispatch.ts` `commitWithhold` at dispatch time — they are members of `OutreachWithheldReason` (`dispatch.ts:149-155`) and are emitted by the dispatch gate (`:254-255`) | **depends on which writer wrote the row**, not on the reason |
| `suppressed`, `no_consent`, `no_postal_address`, `postal_address_mismatch` | `dispatch.ts` `commitWithhold`, which sets `agent_run_id` atomically | `COALESCE(agent_runs.started_at, updated_at)` |
| `unsubscribed` | **NEITHER — and no other site: it has NO WRITER TODAY.** Every production `disposition_reason` write is one of the arms above or a cancelled/failed/unknown arm (migration 111's CHECK has FIVE arms — `release.ts:618-620` and `solicitation-send/failed-hook.ts:232-234` both write the fifth, `send_indeterminate`); `OutreachWithheldReason` (`dispatch.ts:149-155`) has six members and excludes it, and `worker/ingress/unsubscribe.ts` and `suppression.ts` never name `solicitation_outreach`. Migration 111 ADMITS the value in the withheld arm; nothing yet emits it. | none to choose until a writer exists |

Eight members, and the eighth is easy to lose: an earlier draft of this table
counted "the other five" and a later one listed only seven, because
`unsubscribed` belongs to neither writer. `OutreachWithheldReason`'s own
comment says so — it deliberately excludes `render_failed` and `unsubscribed`
from the six the dispatch gate can produce, "because re-spelling them here
would invite a gate arm that has no item."

The superseded claim was "the partition is exactly `RenderWithholdReason`, so
the split is the shape of the data rather than a special case." It is not a
partition at all: two reasons have two writers.

**Why this was a P0 rather than a documentation nit.** A writer built by
reading that table — #1012 is the slice that will do exactly this — would map
`moderation_high` to `rendered_at` unconditionally, and stamp a
dispatch-time decision with a render-time clock. That is a write timestamp
wearing a decision timestamp's name, on the column that is the **single
retention clock**, in the one lane the column was added for.

**The correct rule, and it is a rule about writers rather than reasons:** each
of the two writers stamps `occurred_at` from its own decision point.
`ask-generation.ts` passes `rendered_at`; `commitWithhold` passes the dispatch
decision time. This is why #1009's helper takes
`occurredAt: Date | 'transaction_time'` as a REQUIRED parameter with no
default — the anchor is not derivable from any column on the row, so a lane
must say which one it means.

`updated_at` is a general mutation timestamp a later write can move, and
survives only as the fallback for a dispatch-time withhold whose best-effort
lazy-child attach left `agent_run_id` NULL.

**Correction 3 — this is now a writer problem, not a schema one.** The parked
ADR said closing it "needs a column, which this ADR's no-migration decision
excludes". `refusal_events.occurred_at` **is** that column. It is `NOT NULL` and
writer-supplied, so each of the two writers stamps the anchor that is correct
for it, at the moment it decides. The parked text's other limit — "the Refusal
Log reports THAT a draft was held, never WHY" — is likewise closed: #1003 added
the `policy_gate_held` lane, `refusal_code` and `all_refusal_codes`.

### `created_at` is not a retention clock, and that is deliberate

`occurred_at` is the decision time and the **only** clock retention runs on.
`created_at` is the insert stamp. The skew between the two is the only
measurement that would catch a writer stamping `occurred_at` with insert time,
which is otherwise unmeasurable — which is why dropping `created_at` under the
strict one-clock reading was rejected.

## Consequences

- The owner gets a durable record of restraint. A competitor copies a feature in
  a weekend; a two-year record of principled refusals is a time series, not a
  function.
- The two admin-only tables stay admin-only. Widening either is a separate
  decision requiring its own ADR.
- Adding a member to any mapped source enum breaks the build until it is
  mapped. Adding one to a migration CHECK breaks a test. Both are intentional:
  an unmapped refusal is a refusal nobody decided about.
- Adding an eighth **Refusal source** requires editing migration 116's source
  CHECK **and** CHECK C1's `CASE`. C1 is wrapped in `IS TRUE` precisely so
  forgetting the second is a rejection rather than a silent acceptance.

## Alternatives rejected

- **One flat ~40-member enum.** Maximum fidelity, but the owner reads 40 strings
  and the screen becomes a lookup table.
- **Category only, source dropped.** Zero leak surface, but nobody can debug
  which gate fired and admin support loses the drill-down.
- **Widening `flagged_responses` RLS.** Would let the owner read moderation prose
  that can quote unsafe generated text. The whole point of the hold is that the
  text should not be shown.
- **Owner-readable RLS on `refusal_events`, scoped by `account_id`.** Saves a
  server hop, and cannot withhold `all_refusal_codes` — because RLS filters rows
  and not columns.
- **A read-time projection over the seven source tables.** The original design.
  Unorderable for two lanes, and it multiplied account-wide suspensions by the
  location count.
