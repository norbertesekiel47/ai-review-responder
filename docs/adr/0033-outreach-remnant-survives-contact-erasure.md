# ADR 0033 — A contact delete erases the person and keeps the signal

## Status

Accepted — 2026-09-19. Answers #1144, which asked whether Solicitation outreach
history should outlive a per-contact hard delete.

Terms: `docs/context/solicitation-contacts-visits.md` → **Contact (Solicitation)**,
**Normalized handle**, **Consent ledger**. `docs/context/solicitation-suppression-unsubscribe.md`
→ **Suppression ledger**, **Attestation never overrides suppression**.
`docs/context/solicitation-send-mode-batch-and-delivery-seam.md` → **Outreach row**,
**Body redaction**, and this ADR's new term **Outreach remnant**.
`docs/context/solicitation-send-mode-breaker-release-attribution.md` → **Send breaker**,
**Breaker window**, **Attribution window**. `docs/context/restraint-policy.md` →
**Withhold reason** (`over_contacted`).

Schema: migrations `088_solicitation_batch_executor.sql`,
`091_send_mode_spine_lifecycle.sql`. Prior decision: #541 §5 (the hard delete),
#625 §7.1 (the consent sweep). Incident that surfaced it: #965, closed as owner
action. Map: #617.

## Context

The owner's per-row **Delete** on the contacts page removes the
`solicitation_contacts` row. Both `solicitation_asks` and `solicitation_outreach`
carry `ON DELETE CASCADE` from it, so every Ask and every **Outreach row** for
that person goes too. The **Consent ledger** rows for the **Normalized handle**
are swept in the same transaction.

#965 was filed as data loss and closed as owner action. Eight
`DELETE /api/dashboard/contacts/<id>` requests appeared in the Vercel runtime
log, each erasing that contact's history exactly as §5 specifies. The behaviour
was correct. The question the incident left open is whether the design is.

### The asymmetry that made this a decision

RepWorth makes a deleted person two different promises, and today it keeps one
and drops the other. Nobody chose that split. It fell out of where each promise
happened to be stored.

The **Suppression ledger** survives a contact delete. It keys on the
**Normalized handle**, never on `contact_id`, and the code states the reason:

> `contact_id — delete + re-upload must not un-suppress an opted-out person.`
> — `src/lib/solicitation/handles.ts:5`

The `over_contacted` **Withhold reason** — the 30-day minimum gap — keys on
`solicitation_asks.contact_id`. It dies. Delete the contact, re-upload the same
handle, and the platform may ask that person again inside the gap it promised
not to.

### The claim the breaker makes about itself is false today

`send-breaker.ts` reads the 7-day bounce and complaint window and describes the
table it scans:

> `row solicitation_outreach has ever held — an append-only, retained table`
> — `src/lib/solicitation/send-breaker.ts:321`

It is not retained. An owner clicking Delete removes rows from it. The cascade
and the breaker's stated premise contradict each other in writing.

### What the breaker actually needs

The window query (`send-breaker.ts:375-390`) reads exactly four columns from
`solicitation_outreach`:

`sent_at`, `bounced_at`, `complained_at`, `bounce_kind`

It never reads `contact_id`. It never reads the handle. It never reads the
rendered body. **None of the four is personal data.** The **Send breaker** can
therefore be made erasure-proof without retaining one byte about the person.

## Decisions

### 1. Erasure stays the rule. The person is erased, not retained

The owner's Delete means *forget this person entirely*, and an erasure
obligation applies. A retained record naming a person who asked to be forgotten
is the thing §5 exists to prevent. That does not change.

### 2. A handle snapshot is rejected, hashed or not

#1144's option B proposed snapshotting the **Normalized handle**, or a hash of
it, onto the outreach row so the 30-day gap keeps working.

A hash of an email address remains personal data when the controller can
re-link it. Email addresses are drawn from a guessable set, so an unsalted
digest is recoverable by enumeration, and a salted digest whose salt we keep is
re-linkable by us. Pseudonymised data stays in scope. Hashing does not exit the
obligation.

Option B would therefore pay for a migration **and** weaken the erasure posture.
It is rejected on both counts.

> This ADR states the standard regulatory reading, not legal advice. Confirm the
> position with counsel before the build ticket lands.

### 3. The 30-day gap does not survive a delete, and that is defensible

The gap and the suppression look like the same promise. They are not.

| | **Suppression** | **30-day gap** |
|---|---|---|
| Who asked for it | The recipient | Nobody; it is our courtesy rule |
| Does the recipient know it exists | Yes, they created it | No |
| Cost of forgetting it | Unlimited contact after "stop" | One extra ask |
| Recipient's own backstop | — | Unsubscribe, which survives |

Forgetting a suppression is an unbounded failure against an explicit request.
Forgetting the gap costs at most one additional message, after which the
recipient's own unsubscribe — which outlives every delete — ends it for good.

Retaining an identifier for marketing frequency management, against a person who
asked to be forgotten, is far weaker ground than retaining a suppression record,
which regulators accept precisely because honouring "stop" requires memory.

So the gap reset is **accepted**, not merely tolerated. `over_contacted` may key
on a `contact_id` that is gone.

### 4. Attribution loss inside the window is accepted

#632 matches a later review against SENT outreach in a 14-day **Attribution
window**. A contact deleted inside that window cannot match, and D3's "lossless
by design" does not survive it.

Accepted. Attributing an erased person's review back to them is itself hard to
defend under the obligation that erased them.

### 5. The outreach row survives its contact, stripped of the person

This is the one consequence worth paying a migration for, because it costs
nothing in retained personal data.

A contact delete no longer removes the outreach row. It converts it into an
**Outreach remnant**: `contact_id` and `ask_id` nulled, every person-bearing
column redacted, and the anonymous lifecycle timestamps kept.

Kept — none of it identifies anyone:

`sent_at`, `bounced_at`, `complained_at`, `bounce_kind`, `delivery_status`,
`disposition_reason`, `channel`, `attempt_no`, `queued_at`, `sending_at`,
`rendered_at`, `created_at`

Redacted in the same transaction:

`rendered_subject`, `rendered_body`, `interpolation_inputs`,
`provider_message_id`, `provider_error`, `consent_row_id`, and
`solicitation_asks.evidence`

**Body redaction** is the precedent, not a new idea. `ArchivalPoller` already
empties outreach bodies at 90 days and keeps the row, stamping
`body_redacted_at`. A remnant is the same move, triggered by a delete rather
than by age.

### 6. Both cascade edges must change, not one

Deleting a contact destroys the outreach row **twice over**, by two independent
paths:

1. `solicitation_outreach_contact_business_fk` → `solicitation_contacts`,
   `ON DELETE CASCADE` (`091:250`)
2. `solicitation_outreach_ask_tenant_fk` → `solicitation_asks`,
   `ON DELETE CASCADE` (`091:256`), and `solicitation_asks_contact_business_fk`
   → `solicitation_contacts`, `ON DELETE CASCADE` (`088:166`)

Changing only the direct edge saves nothing: the ask still cascades and takes
the outreach row with it. Any implementation that reads #1144's option B as one
FK change is wrong.

### 7. Nulling one column of a composite FK is already proven here

`contact_id` is `NOT NULL` on both tables, and both FKs are composite on
`(contact_id, business_id)`. A bare `ON DELETE SET NULL` would null
`business_id` too, destroying tenant scope.

Postgres 15's column-scoped form is the answer, and migration 091 already uses
it eleven lines below the FK in question:

```sql
CONSTRAINT solicitation_outreach_run_tenant_fk
  FOREIGN KEY (account_id, business_id, agent_run_id)
  REFERENCES agent_runs (account_id, business_id, id)
  ON DELETE SET NULL (agent_run_id)
```
— `091:211-214`

The technique is house precedent, not a novelty.

### 8. Per-contact delete is not account purge, and this does not weaken purge

`solicitation_outreach.account_id` references `accounts(id) ON DELETE CASCADE`
(`091:194`). An account-level purge still removes every remnant through that
edge. The `delete_data` / `purge` offboarding path and its verifier arms
(`src/lib/account-offboarding/purge-verification.ts:674`) keep asserting
absence, unchanged.

A remnant outlives **one contact**. It does not outlive the account.

## Limits, stated rather than papered over

### A remnant is anonymous only if the redaction is complete

The decision rests entirely on the claim that no retained column identifies
anyone. That claim is only as good as the redaction list in decision 5. A future
column added to `solicitation_outreach` that carries a name, an address or a
quoted message body silently breaks it, and no existing test would notice.

The build ticket owes a guard that fails when a new column joins the table
without being classified as kept or redacted.

### `interpolation_inputs` is the likeliest leak

It is `JSONB NOT NULL` and holds whatever the prompt interpolated, which is
where a first name most plausibly lives. It is redacted rather than kept for
that reason. Nulling it is not possible without dropping `NOT NULL`; the build
must decide between an empty object and a nullable column, and say which.

### The unique constraint tolerates remnants only by default behaviour

`solicitation_asks_batch_contact_uniq UNIQUE (batch_id, contact_id)` (`088:159`)
permits many nulled rows per batch only because Postgres treats NULLs as
distinct by default. A later change to `NULLS NOT DISTINCT` would make the
second remnant in a batch fail the delete. This is a live trap, not a
hypothetical.

### The gap reset is bounded at one ask per delete, not per lifetime

Decision 3's "one extra email" holds for a single delete. An owner who deletes
and re-uploads repeatedly resets the gap each time. That is an owner acting
against their own recipients with a durable audit trail, not an arithmetic hole
this ADR must close — the same reasoning `send-breaker.ts:314` applies to an
admin resetting the breaker in a loop.

## Consequences

- The **Send breaker** stops being erasable by owner action. Its stated premise
  at `send-breaker.ts:321` becomes true.
- Bounce stamps, delivery dispositions and veto-notice anchors survive a delete
  as anonymous facts. Provider message ids do not.
- `over_contacted` and #632 attribution keep their current behaviour. Nothing
  about them changes.
- One migration, on both Supabase projects in lockstep, staging first. It alters
  two foreign keys, drops two `NOT NULL`s, and adds a redaction write to
  `deleteContact`.
- Every reader of `contact_id` on those two tables must handle the nullable
  case: `batch-builder.ts` prior-send lookup, `attribution.ts`,
  `worker/ingress/resend/solicitation-lane.ts`, and the Requests panel.
- The Delete confirm copy must say that history goes too. It does not today.

## Alternatives rejected

**A, unchanged status quo.** Document all four consequences and change nothing.
Rejected only in its fourth consequence: leaving platform health erasable by an
owner click, while the breaker's own documentation claims otherwise, is a
defect and not a trade-off. Decisions 3 and 4 adopt A's answer for the other
three.

**B, SET NULL plus a handle snapshot.** Rejected by decision 2. The snapshot is
still personal data, so it buys a migration and a weaker posture.

**C, soft-delete the contact.** Rejected. It contradicts the owner's intent and
the erasure obligation directly: the row, the name and the handle all remain,
hidden rather than gone.
