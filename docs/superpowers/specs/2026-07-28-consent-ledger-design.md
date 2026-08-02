# Consent Ledger Semantics + Counsel Brief — LOCKED SPEC (#620)

> **AMENDED 2026-07-28 — read `docs/superpowers/specs/2026-07-28-send-mode-cross-spec-amendments.md` first.** Amended
> here: the §3.5/§9 stamp-timing ambiguity resolves to **dispatch (#630)**, not
> render/#628 (B1); Part II §B's staging wording corrected in place (B8).

> **Status:** Locked 2026-07-28 via grilling session. Resolves wayfinder ticket **#620**
> (part of map **#617**, Solicitation SEND-MODE Phase 2b, design doc §9.3).
> Binding compliance reference: `docs/research/2026-07-23-solicitation-policy-constraints.md`
> (#531, branch `research/solicitation-policy-constraints`) — this spec cites its **§4** and
> **§5 rows 6–8** rather than re-deriving them, and packages its **§6** as Part II.
> Attestation model inherited from **#535**
> (`docs/superpowers/specs/2026-07-23-contacts-csv-contract-design.md` §4/§5/§6).
> Reference design: `docs/future-plans/2026-05-22-saas-2-0-vertical-agent-platform-design.md` §6.5.
>
> **Consumes:** `docs/superpowers/specs/2026-07-28-suppression-unsubscribe-design.md` (§1.2 lookup contract, §4.3 dispatch gate, §6.3
> purge dispositions, §8.1 the precedence sentence); `docs/superpowers/specs/2026-07-28-send-mode-executor-approval-design.md` (D5
> `solicitation_outreach`, D18 the dispatch precondition bundle).
> **Feeds:** #625 (consent-ledger schema + ingest wiring — the primary implementation
> ticket), #630 (dispatch/drip worker — the consent half of the gate), #629 (owner approval
> surface — withhold copy), #628 (ask generation — the outreach snapshot), #633 (staging
> flip evidence).
>
> This is engineering research and product spec, **not legal advice.** Counsel gates the
> PROD flip only (map decision 5), never the staging destination.

---

## Part I — The consent ledger

## 0. Decision register

Ten decisions, each locked in the #620 grilling session, plus three rules derived from
them. Everything below is derivation.

| # | Decision | Locked value |
|---|---|---|
| D1 | Attestation version | `consent_attestation_v2` is a **send precondition**; a `SEND_ELIGIBLE_ATTESTATION_VERSIONS` allowlist gates eligibility; **v1 is not on it** |
| D2 | Consent resolution | The **ledger** resolves consent. Ingest writes rows at email-v1 — the table is load-bearing on day one, not empty-until-SMS |
| D3 | Shape | **Current-state rows, monotone forward.** Point-in-time proof is stamped on `solicitation_outreach` at dispatch, never folded from an event log |
| D4 | Scope key | `(channel, normalized_handle, business_id)` — location-scoped. **No `account_id` column.** Contact hard-delete deletes the row |
| D5 | Basis enum | Column ships; **exactly one value**, `owner_attested`. May §6.5's three become counsel brief flag 1's payload |
| D6 | Provenance | **Capture** `attestation_version` / `attested_at` / `attested_by_user_id` on the row; `source_upload_id` is a nullable FK, `ON DELETE SET NULL` |
| D7 | Revocation | **Distinct from consent, permanently.** #621's suppression ledger owns revocation entirely. No `revoked_at` column, ever |
| D8 | Write path | Ingest is the **sole writer**, inside its existing per-business-locked transaction; **email rows only**; guarded monotone upsert |
| D9 | Counsel brief | All six #531 §6 flags **verbatim**, tiered by what each gates, plus two RepWorth-authored questions. Self-contained (Part II) |
| D10 | Evidence + policy version | `no_consent` evidence gains nullable `upload_id` + `attestation_version`; `RESTRAINT_POLICY_VERSION` bumps to `.3` |

---

**Derived rule DR1 — consent fails closed; suppression fails open. That asymmetry decides
every retention question in both specs.**

Consent is the **owner** asserting a relationship. Its absence means *do not send*, so
losing a consent row is safe and keeping a stale one is not. Suppression is the
**recipient** revoking one. Its absence means *send*, so losing a suppression row mails
somebody who opted out, and keeping a stale one costs nothing.

Everything follows: consent rows are `hard_delete` on contact deletion and on offboarding
purge; suppression rows are `retain_compliance_limited_pii` through purge (#621 §6.3).
Same domain, opposite dispositions, one reason.

**Derived rule DR2 — the ledger is a derived index over attestations, not a new legal
basis.**

Map decision 5 is locked and is **not** reopened here: for email v1 the operative legal
basis remains the per-upload attestation (#535 §4) plus the suppression ledger (#621),
under CAN-SPAM's opt-out regime (#531 §2). The consent ledger is the *mechanism* that
answers "which attestation covers this handle, for this channel, at this location" —
which #535 §4 already claimed was "a query, not a guess" but which the shipped query gets
wrong (§1.2). Nothing about the legal claim changes. Counsel still gates the prod flip
only.

**Derived rule DR3 — no consent row is ever minted for a channel the attestation text did
not name.**

A contact with a phone number gets **no** `channel='sms'` row, even though we hold the
handle and could write one. Email and SMS sit under different regimes (#531 §5 rows 6 vs
7); an attestation whose text speaks of email says nothing about TCPA. Minting a row
anyway produces exactly the record #535 §4 forbids: *"owner-guessed consent flags …
legally-meaningless records that read as real consent downstream."* The `channel` column
is widened per channel, alongside a new attestation text and counsel's answer to Part II
flag 1 — never by default.

---

## 1. Why the ledger is load-bearing at email-v1

Map decision 5 calls the ledger "forward infrastructure for SMS." That framing is correct
about the *legal basis* and wrong about the *code*: shipping the table empty would leave
two shipped defects in place. Both were found by reading the code, not by reasoning from
the design docs.

### 1.1 `consent_attested` is tautologically true today

`loadCandidateWindow` (`src/lib/solicitation/batch-builder.ts:346-351`) computes:

```sql
(
  u.status = 'completed'
  AND u.attested_at IS NOT NULL
  AND u.attestation_version IS NOT NULL
) AS consent_attested
```

Migration 086 declares both `attested_at` and `attestation_version` as `NOT NULL`
(`supabase/migrations/086_solicitation_contacts.sql:32-33`), and the join two lines above
already constrains `u.status = 'completed'`. **All three conjuncts are true by
construction.** `consent_attested` is a constant.

The restraint policy's own header says as much — *"`no_consent` (like `suppressed`) cannot
fire in v-watch — the #535 consent attestation is blocking, so every uploaded candidate is
covered by construction"* (`src/lib/solicitation/restraint-policy.ts:19-22`) — and that
was the right call for watch-mode, where nothing sends. At send-mode, a consent gate with
no discriminating power is a gate in name only. D1 gives it content for the first time.

### 1.2 The re-upload dead end

D1 alone is not enough, because the remedy it implies — "re-upload under v2" — does not
work against the shipped ingest.

`upsertVisit` (`src/lib/solicitation/ingest.ts:309-315`) is:

```sql
INSERT INTO solicitation_visits (id, contact_id, business_id, visit_date, note, upload_id)
VALUES (…)
ON CONFLICT (contact_id, visit_date)
DO UPDATE SET note = COALESCE(NULLIF(EXCLUDED.note, ''), solicitation_visits.note)
RETURNING (xmax = 0) AS inserted
```

The conflict branch updates `note` and **not `upload_id`**. Re-uploading the same CSV
under v2 therefore produces `duplicate_visit` on every row and leaves each visit still
pointing at its original **v1** upload. Since `loadCandidateWindow` derives consent from
`latest_visit.upload_id`, the contact stays non-send-eligible **permanently**. The only
escape available to an owner would be uploading rows with visit dates that never happened.

That is a trap, and it is not acceptable to ship it and document it.

### 1.3 Why the ledger is the right layer to fix it

Two other fixes were considered and rejected:

- **Widen the visit join** — "consent = *any* completed upload touching this contact
  carries a send-eligible version." Smallest diff, but it turns a per-candidate scalar into
  a fan-out over the whole visit history on every batch build, and leaves the `no_consent`
  evidence's `upload_id` ambiguous (which of the N uploads is being named?).
- **`DO UPDATE SET upload_id = EXCLUDED.upload_id`** — one line, and it rewrites the
  append-only visits ledger's provenance to solve a consent problem. It destroys "which
  upload first reported this visit," which is the visits ledger's entire job (#535 decision
  1). Wrong layer.

The ledger fixes it at the right layer because **a ledger row is written for every valid
CSV row regardless of whether its visit deduped.** Re-upload under v2 upgrades the consent
row even when zero visits are inserted. Consent resolution becomes a plain equality lookup
on a key that already exists in the schema, and the fan-out disappears.

---

## 2. Attestation versioning (D1)

### 2.1 v1 disclaims the thing send-mode does

`CONSENT_ATTESTATION_TEXT` (`src/lib/solicitation/attestation.ts`) currently ends:

> "…and that I am authorized to upload their details for review-request evaluation.
> **No review requests will be sent in watch-mode.**"

Sending under that attestation would send mail under a text that told the owner nothing
would be sent. The version constant exists precisely so a wording change is traceable
(*"changing the wording MUST bump `CONSENT_ATTESTATION_VERSION`"*); send-mode is its first
real forcing event.

### 2.2 The allowlist

```ts
/** Attestation versions whose coverage authorizes a SEND. Widened only when a
 *  new attestation text ships; membership is the send-eligibility gate. */
export const SEND_ELIGIBLE_ATTESTATION_VERSIONS = ['consent_attestation_v2'] as const;
```

`consent_attestation_v1` is deliberately **absent**. A contact covered only by v1 withholds
with `no_consent` (§6.1 case (a)/(b)), and the owner's remedy is to re-upload the list
under v2 — which now works, per §1.3.

The allowlist is a **code constant, not an env var.** There is no legitimate per-environment
value: staging and prod must agree on what an attestation authorizes, and invariant #13
would in any case forbid a `NEXT_PUBLIC_*` companion. Widening it is a code change with a
diff, which is the reviewability we want on this particular list.

### 2.3 Proposed v2 text — pending counsel (Part II flag 7)

Ships to staging as-is; counsel reviews it before the prod flip. Marked in code, as v1 is,
as an engineering placeholder.

> "I confirm these are real customers of this business who provided their contact
> information directly to us, that I am authorized to upload their details, and that
> RepWorth may send review requests to them by email on this business's behalf.
> Recipients may opt out of these emails at any time, and RepWorth will honor those
> opt-outs."

Three deliberate properties:

- **Names the sender-agent relationship.** This is the email-relevant half of #531 §6.1 —
  CAN-SPAM §7 makes both the promoted business and the sender liable, and we send from a
  RepWorth-owned shared domain (#622 D2).
- **Names email explicitly.** DR3 depends on the text being channel-specific. SMS gets its
  own text and its own version, or the allowlist claim is hollow.
- **Names the opt-out.** The owner is being told their customers can leave, and that we
  will honor it — which is what #621's ledger actually does, globally.

**Recursion, and its answer:** if counsel's review changes the wording materially, that is
`consent_attestation_v3`, and whether v2-covered contacts remain send-eligible is
**Part II flag 8** — not an engineering call. The allowlist is the mechanism that
implements either answer; getting it wrong strands every contact uploaded during the
staging campaign.

---

## 3. Ledger shape (D3, D4, D5, D6)

> The migration is **#625's** to write, under the one-migration-in-flight rule and the
> `new-migration` skill. Migrations head at spec time is **090**; **#624 owns 091**
> (619 §9), so #625's is **092** unless the order changes. This section is the contract
> that migration must satisfy, not the DDL.

### 3.1 `solicitation_consent`

| Column | Type | Notes |
|---|---|---|
| `id` | `UUID` PK | UUIDv7, worker-supplied (repo convention) |
| `channel` | `TEXT NOT NULL` | `CHECK (channel IN ('email'))` — widened per channel per DR3, never by default |
| `normalized_handle` | `TEXT NOT NULL` | Output of `normalizeEmail` (`src/lib/solicitation/handles.ts`) — the same normalizer ingest and #621 use |
| `business_id` | `UUID NOT NULL` | `REFERENCES businesses(id) ON DELETE CASCADE` — the scope (§3.2) |
| `basis` | `TEXT NOT NULL` | `CHECK (basis IN ('owner_attested'))` (§3.3) |
| `attestation_version` | `TEXT NOT NULL` | Captured, not joined. **The eligibility gate input** (§2.2) |
| `attested_at` | `TIMESTAMPTZ NOT NULL` | Captured from the upload row; also the monotonicity guard (§4.2) |
| `attested_by_user_id` | `UUID` | Captured. **Plain UUID, no FK** — see §3.4 |
| `source_upload_id` | `UUID` | `REFERENCES contact_csv_uploads(id) ON DELETE SET NULL` — audit pointer only |
| `created_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | |
| `updated_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | Touched by the upgrade upsert |

**One unique index**, and it is total rather than partial:

- `UNIQUE (channel, normalized_handle, business_id)`

No partial predicate, so the byte-for-byte `ON CONFLICT` hazard (CLAUDE.md gotcha) does not
arise here as it does for #621's two partial indexes — but §4.2's upsert still carries a
`WHERE` clause on the `DO UPDATE` branch, which is a different construct and unaffected.

**RLS: enabled, deny-all to the browser.** Server-owned, the same posture as
`auto_approval_policies` (invariant #14) and #621's ledger. Owner-facing consent state
reaches the UI only as a withhold reason on an ask (§6.1), never as a direct table read.

### 3.2 Why `business_id`, and why no `account_id`

Suppression is **global** because the recipient authored it against a shared sending
identity (#621 §1.1). Consent is its mirror: #531 §4 records that TCPA consent "belongs to
the *business*, is arguably non-transferable," and the attestation is signed by one user
against one business's upload. A customer of Joe's Diner never consented to Sally's Salon.

`business_id` rather than `account_id` because **transferability is the open counsel
question** (Part II flag 1), and scoping *below* the unknown is the fail-closed choice. A
multi-location account whose consent genuinely is brand-level simply uploads the contact at
each location; a chain that cannot honestly do that should not be silently doing it through
a schema default. If counsel says consent is account-transferable, widening the lookup is a
query change, not a migration.

The key shape `(business_id, handle)` mirrors `solicitation_contacts`' identity key
(`solicitation_contacts_email_uniq`) exactly, so the join is plain equality on a shape the
schema already carries.

**No `account_id` column.** Migration 086's comment is directly on point:

> "Contacts are BUSINESS-scoped only: `businesses.account_id` is the single authoritative
> owner of the business→account pairing (a denormalized `account_id` here could drift from
> it)."

Account-level queries — RLS, offboarding purge — join through `businesses`, as the contacts
tables already do. (#621's ledger *does* carry `account_id`, legitimately: there it is the
scope itself and the row hangs off no business. Different table, different reasoning; the
086 warning applies here and not there.)

### 3.3 `basis` — one column, one value

May §6.5 proposes three bases: `existing_customer` / `direct_consent` / `prior_relationship`.
At email-v1 **nothing populates them.** There is no per-row consent column (#535 §4,
deliberately) and no per-basis capture UI — the owner ticks one blocking checkbox with one
fixed text. And that text asserts two of the three *conjunctively*:

> "I confirm these are **real customers of this business** who **provided their contact
> information directly to us**…"

That is `existing_customer` **and** `direct_consent` at once, and `prior_relationship` not
at all. Choosing one by fiat is #535 §4's warning arriving one layer up: a
legally-meaningless record that reads as a real legal distinction downstream.

So: **ship the column, ship one value.** `owner_attested` names who asserted it and asserts
nothing about legal character — which is precisely what counsel has not yet told us. The
column is widened per basis exactly as `channel` is widened per channel (#621 §1.3), and
for the same reason: retrofitting a *column* onto a live compliance record is the expensive
mistake, while minting *values* nothing can populate is the cheap-looking one.

May's three values are not discarded — they become Part II flag 1's payload, which is a
better use of them than an unexercised `CHECK`.

### 3.4 Provenance: capture, do not join (D6)

There is no separate attestations table; the attestation *is* three columns on
`contact_csv_uploads`. So "attestation FK" and "upload FK" are one pointer, and the real
question is FK-only versus capturing the values. Two facts settle it:

1. **`attestation_version` is a hot-path gate input** — read on every batch build, for every
   candidate, by the §2.2 allowlist check. Leaving it on the upload reinstates the join that
   §1.3 exists to remove.
2. **Migration 086 line 31 is
   `attested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE`.** Deleting a
   staff user **deletes every upload they ever made.** With FK-only provenance, offboarding
   one employee would silently destroy the consent record for all their lists — and with a
   `NOT NULL` FK, cascade the ledger rows away with them. Nobody designed "removing a staff
   member revokes consent"; it would simply happen. The ledger must be self-sufficient
   against that.

Capturing is therefore **point-in-time capture, not a DRY violation** — the same pattern
invariant #9a already mandates for billing (read the *stored* quota and price from
`accounts`, never live `TIER_CONFIG`). The upload is the source at write time; the ledger
row is what the sender relied upon.

`attested_by_user_id` is a **plain UUID with no FK**, precisely so the 086 user cascade
cannot reach it. `source_upload_id` keeps its FK as `ON DELETE SET NULL` — a vanished
upload nulls the audit pointer without destroying the record.

**The attestation text itself is not stored.** It is a version-pinned code constant whose
own contract forbids changing wording without bumping the version; duplicating it per row
buys nothing that `attestation_version` does not already buy.

### 3.5 Monotone forward, and where point-in-time proof lives (D3)

The ledger holds **current state**, upserted, and moves in one direction only: granted,
then upgraded to a newer attestation version. It never moves backward, because **revocation
is not in this table** (D7, §5).

The case for event-sourcing is "prove you had consent at the moment you sent." That proof
does not belong here. #619 D5 ships `solicitation_outreach`, one row per rendered ask; the
consent basis, `attestation_version`, and resolving consent-row id are **stamped onto the
outreach row at dispatch**. That is strictly better evidence than a fold over an event log,
because it proves what the sender *actually relied upon* rather than what was merely
derivable — and it reuses #621 §4.4's "two records of two moments" pattern rather than
inventing a second one.

A forward-only current-state row needs no event log. A hybrid (log + projection) was
rejected outright: a dual-write consistency failure mode on a compliance record, for a table
with one writer until SMS.

---

## 4. The write path (D8)

### 4.1 One writer, one transaction

`src/lib/solicitation/ingest.ts` already runs under a per-business advisory lock inside one
transaction that upserts contacts and visits. **The consent write joins that transaction**
— one authoritative writer, the `run-spine.ts` posture.

Written **per valid CSV row**, keyed `(channel, normalized_handle, business_id)`, for the
email handle only (DR3). A row whose email is absent but phone present produces contacts and
visits as today and **no consent row**.

**No owner-facing "grant consent" action at v1.** The attestation checkbox *is* that
surface. A second writer to a compliance table, with a second attestation surface, before
any non-CSV contact source exists, is abstraction ahead of the second concrete use case
(repworth.md "Never do").

### 4.2 The guarded upsert

```sql
INSERT INTO solicitation_consent
  (id, channel, normalized_handle, business_id, basis,
   attestation_version, attested_at, attested_by_user_id, source_upload_id)
VALUES (…)
ON CONFLICT (channel, normalized_handle, business_id)
DO UPDATE SET
  basis               = EXCLUDED.basis,
  attestation_version = EXCLUDED.attestation_version,
  attested_at         = EXCLUDED.attested_at,
  attested_by_user_id = EXCLUDED.attested_by_user_id,
  source_upload_id    = EXCLUDED.source_upload_id,
  updated_at          = NOW()
WHERE EXCLUDED.attested_at > solicitation_consent.attested_at
```

**The `WHERE` guard is not theoretical.** An upload row created *before* the v2 deploy
carries `attestation_version = 'consent_attestation_v1'` stamped at route time; its
`csv_ingest` outbox job can dispatch *after* the deploy. An unguarded upsert would let that
in-flight v1 job overwrite a v2 consent row and silently make the contact non-send-eligible
— a downgrade nobody would ever look for. Last attestation wins, and "last" is `attested_at`,
not arrival order.

**The postgres.js microsecond gotcha was considered and does not apply.** It bites when a row
is compared against a window or anchor derived from that same row. Here both operands sit in
one statement, and a false ordering needs two attestations under 1 ms apart on the same
handle at the same location. Recorded so the next reader does not have to re-derive it.

Note the contrast with `solicitation_contacts`, whose ingest **deliberately avoids**
`ON CONFLICT` because the advisory lock serializes read-then-write (086 comment). The consent
ledger genuinely wants the upsert: the upgrade semantics *are* the feature.

### 4.3 Idempotency

Re-running a `csv_ingest` job is already idempotent for contacts and visits; the consent
upsert preserves that. A replay writes the same values, the guard's `>` makes the second
attempt a no-op, and `updated_at` does not churn. No `job_outbox` row is added — there is no
asynchronous follow-up work (#621 §9.3's reasoning, unchanged).

---

## 5. Consent vs suppression (D7)

### 5.1 Distinct, permanently

#621 §8.1 already wrote the governing sentence, and this spec adopts it verbatim as the
boundary between the two tables:

> **Attestation is the owner asserting a relationship; suppression is the recipient
> revoking one. The second outranks the first, permanently.**

| | Consent ledger (#620) | Suppression ledger (#621) |
|---|---|---|
| Asserted by | the **owner** | the **recipient** |
| Scope | `business_id` — non-transferable | global `(channel, handle)` — shared sending identity |
| Direction | monotone forward | monotone forward |
| Deletion | fails **closed** → deleted on contact delete and purge | fails **open** → retained through purge |
| Send requires | **present** | **absent** |

Both tables are monotone forward. They point opposite ways, and DR1 is that observation
stated once.

### 5.2 The hard rules

- **The consent ledger never gets a `revoked_at` column.** A mirrored copy of a compliance
  fact with two owners drifts, and drift here means somebody gets mailed. One authoritative
  owner per fact (engineering.md).
- **No consent write ever reads or mirrors suppression**, and no suppression write ever
  reads or mirrors consent. They are independent inputs, joined only at the two evaluation
  points (§6).
- **A new attestation never overrides suppression.** #621 §8.1 states this; #620 restates it
  because #620 is the spec that makes re-attestation a *routine* owner action (§2.2's
  remedy). "They re-attested, so we're covered" is now a live misreading, not a hypothetical
  one. Re-attestation upgrades a consent row; it does not touch, clear, or outrank a
  suppression row.
- **The withhold precedence order (`no_consent` before `suppressed`) is not an override
  relationship.** It governs only which reason is *reported* when both apply.

---

## 6. Evaluation points

Consent is checked exactly twice, and the two checks are different questions.

### 6.1 Build time — the restraint policy (D10)

`toCandidate` (`src/lib/solicitation/batch-builder.ts:289-298`) keeps its shape;
`loadCandidateWindow`'s `consent_attested` expression (§1.1) is **replaced** by a left join
to `solicitation_consent` on `(channel = 'email', normalized_handle = c.email, business_id)`,
with:

- `attested` = a row exists **and** its `attestation_version` is in
  `SEND_ELIGIBLE_ATTESTATION_VERSIONS`
- `uploadId` = the row's `source_upload_id` (nullable)
- `attestationVersion` = the row's `attestation_version` (nullable)

`evaluateAsk` itself is unchanged — it still reads `candidate.consent.attested` at precedence
1. The pure module stays pure; the derivation is the caller's, as it already was.

**Evidence gains two nullable fields:**

```ts
| { reason: 'no_consent'; upload_id: string | null; attestation_version: string | null }
```

This distinguishes the two causes that now exist, and the distinction is load-bearing for
#629's copy:

| Case | Evidence | Meaning | Owner remedy |
|---|---|---|---|
| (a) | both `null` | No consent row for this handle at this location | Upload this contact under the current attestation |
| (b) | both populated | Row exists, version not send-eligible | **Re-upload this list** — the attestation predates send-mode |

A bare `upload_id` is not actionable by an owner, and "re-upload this list" is only truthful
in case (b). A **new withhold reason** for case (b) was rejected: #621 §4.1's argument that
the closed enum is already correct still holds, and a new member would force a precedence
decision against `no_consent` for no gain over an evidence field.

**No migration is needed for the evidence change.** Migration 090's
`solicitation_asks_evidence_matches_columns` pins only the `decision` and `reason` keys
against their columns — it does not constrain the rest of the object.

### 6.2 `RESTRAINT_POLICY_VERSION` bumps to `.3`

**This supersedes #621 §4.1's "no bump."** The difference between the two specs is real:
#621 only *populated* an existing field (`candidate.suppression`) within an unchanged
evidence shape. #620 changes the `WithholdEvidence` serialization contract **and** changes
the derivation such that a candidate deciding `send` under `.2` decides
`withhold` / `no_consent` under `.3`.

That is verbatim the constant's own documented bump criterion:

> "a decision made under `.1` is not reproducible under `.2`, and stored evidence must stay
> attributable to the ruleset that produced it."

Not bumping would leave stored watch-mode evidence attributed to a ruleset that no longer
produces it. The cost — watch-mode and send-mode decisions are no longer directly comparable
— is the correct cost, and it is exactly what a version string is for.

New value: `restraint_v_watch_2026-07-23.3`. The date still names the locked spec, which is
unchanged; the serial names the ruleset. #625 updates the constant's doc comment to record
the `.3` reason, following the `.2` precedent.

### 6.3 Dispatch time — a precondition, not a policy re-run

#621 §4.3 is **correct as written** and this spec supplies its second check's content: the
dispatch gate performs a **consent-row existence + `attestation_version` allowlist check**
for `(channel, handle, business_id)`, inside the child's short pre-send transaction. It does
**not** call `evaluateAsk` (#621 §4.3's reasoning — `stale_visit` and `over_contacted` both
fire spuriously after a drip).

**This amends #619 D18.** D18 held that "the upload attestation is *immutable*, so re-reading
it at dispatch is inert," and its 7-check bundle carries consent only obliquely, as check 7
("contact still exists and not offboarding-purged"). With the ledger load-bearing, **consent
can change between approval and dispatch** — D4 locks that contact hard-delete deletes the
consent row, and #535 §5's per-contact delete is a dashboard action an owner can take
mid-drip. The consent check is therefore *not* inert, and it **subsumes D18 check 7 on the
consent axis**: a deleted contact has no consent row, so the consent check fails first and
by construction. D18 checks 1–6 are unaffected.

On a consent miss the ask transitions to a **terminal not-sent state** and emits no restraint
decision — the same posture #621 §4.3 sets for suppression, and the same
`ResponsePublisherWorker` precedent: approval is a permission preconditions can still revoke.
Whether consent-at-dispatch and suppression-at-dispatch share one terminal status or take
two is #619/#624's status-vocabulary call; this spec requires only that the dispatch miss be
distinguishable from a build-time `withheld` (#621 §4.4's requirement, inherited).

---

## 7. Retention, deletion, and offboarding

### 7.1 Contact hard-delete deletes the consent row

#535 §5 locked: *"a deleted person vanishes entirely — no soft delete, no residual hash, no
tombstone."* A retained consent row is a residual record of that person, so the per-contact
delete path must delete matching `solicitation_consent` rows for
`(channel, contact's handles, business_id)` in the **same transaction** as the contact delete.

This is safe **only** because of DR1: deleting consent fails closed. The identical action on
a suppression row would fail open, which is why #621 §6.3 retains those through purge and
this spec destroys these. Stating the two rules next to each other is the point — read alone,
each looks arbitrary.

Note the delete is by **handle**, not by FK cascade: there is no FK from consent to
`solicitation_contacts` (the ledger is handle-keyed by design, §3.2), so #625 must wire this
explicitly rather than inherit it. **A missing explicit delete here is silent** — nothing
errors, and the stale row is inert until the same handle is re-uploaded, at which point it
grants consent the owner did not re-give. Contract-test it.

### 7.2 Offboarding purge

| Rows | Disposition | Purge verification | Scope evidence |
|---|---|---|---|
| `solicitation_consent` (all) | `hard_delete` | `must_be_absent` | `direct_business_id` |

Every member already exists in `src/lib/account-offboarding/table-disposition.ts`; this table
needs no new enum values (unlike #621, which is the first caller of
`retain_compliance_limited_pii` / `compliance_handle_hash` / `allowed_limited_retention`).

> **CORRECTED AS BUILT (2026-08-01, #625 ship).** The locked text below said the rows
> "leave with the business" via the `businesses(id)` cascade — that assumption is WRONG on
> the offboarding purge path: `worker/jobs/account-offboarding/purge-stages.ts` TOMBSTONES
> `businesses` (`retain_deidentified` — UPDATE, never DELETE), so the cascade never fires
> during purge, and nothing else sweeps the ledger (`source_upload_id` is `SET NULL`;
> consent has no FK to contacts). As built, the content-purge stage runs an explicit
> `deleteByBusiness(tx, 'solicitation_consent', account_id)` sweep (the
> flagged_responses/agent_runs precedent), pinned by `PurgeWorker.test.ts` and a live-DB
> absent-vs-bystander assertion pair. The cascade fires only on real location deletion.
> Either way `must_be_absent` fails closed.

`business_id` is a real FK with `ON DELETE CASCADE`, so the rows leave with a genuinely
deleted location. #625 adds the explicit `TABLE_DISPOSITIONS` entry, the purge-stage sweep
(see the correction above), and the purge-verification predicate — a delete that no
inventory records is a table the verifier cannot assert on.

**Legacy cohort — decision recorded at ship (2026-08-01): no backfill.** Pre-#625 contacts
have no `solicitation_consent` rows and get none: they read as `no_consent` case (a) —
both evidence fields null — **by design** (Codex adversarial M2, accepted alternative).
The owner remedy "upload under the current attestation" is truthful and sufficient for
that cohort, so **#629's case (a) copy must be self-sufficient** (an owner seeing it needs
no other context to act). Pinned by the batch-builder integration test "legacy pre-ledger
contacts read as no_consent case (a): visits without a ledger row yield null evidence".

**The purge receipt says nothing about consent rows.** They are gone; there is nothing to
disclose. Contrast #621 §6.3, whose receipt *must* report retained suppression rows in
aggregate precisely because they survive.

### 7.3 No TTL

Consent rows do not expire. #535 §5 set "no automatic TTL/expiry on contacts in v1," and a
consent row outliving or predeceasing its contact would desynchronize the two. Retention
posture for the ToS/DPA follow-up is Part II flag 4.

---

## 8. Observability

### 8.1 Analytics

Durable server-side events (never client-postable), idempotent on `event_key`:

| Event | Emitted when | Properties |
|---|---|---|
| `solicitation_consent_recorded` | A consent row is inserted | `channel`, `basis`, `attestation_version` — **never the handle** |
| `solicitation_consent_upgraded` | The §4.2 `DO UPDATE` branch fires **and the version changed** (as built: a same-version re-attestation bumps `attested_at` silently — no event; verified in the 2026-07-31 staging smoke, PR #640) | `channel`, `from_version`, `to_version` |
| `solicitation_consent_missing_at_dispatch` | The §6.3 gate fires | `channel`, `ask_id` |

`solicitation_consent_upgraded` is the metric that tells us whether the v1→v2 re-upload
migration is actually happening in staging, which is #633 flip evidence rather than a nice
number.

### 8.2 Logging

Never log the raw handle. `createWorkerLogger` object args pass through the analytics
blocked-key sanitizer; **string args do not**, so a handle must never be interpolated into a
log message. Log the consent row id when correlation is needed.

### 8.3 Configuration surface

**No new environment variables.** `SEND_ELIGIBLE_ATTESTATION_VERSIONS` and
`CONSENT_ATTESTATION_VERSION` / `_TEXT` are code constants (§2.2). Nothing in the consent
path reads `SOLICITATION_SEND_ENABLED` at write time — ingest keeps recording consent whether
or not sending is enabled, which is correct: the attestation happened.

---

## 9. Constraint hand-offs to sibling tickets

| Ticket | What #620 binds |
|---|---|
| **#625** (consent-ledger schema + ingest wiring) | All of §3, §4, §6.1, §6.2, §7. Migration 092 (head 090, #624 owns 091). The `v2` text + version constant, the `SEND_ELIGIBLE_ATTESTATION_VERSIONS` allowlist, the ingest write in the existing transaction, the `loadCandidateWindow` derivation swap, the `WithholdEvidence` field additions, the `RESTRAINT_POLICY_VERSION` `.3` bump, the contact-delete sweep (§7.1), the `TABLE_DISPOSITIONS` entry |
| **#630** (dispatch/drip worker) | §6.3 — the consent half of the dispatch gate is a **row-existence + version-allowlist check, never `evaluateAsk`**; runs in the same pre-send transaction as #621's suppression check; fails closed |
| **#628** (ask generation) | §3.5 — stamp `basis`, `attestation_version`, and the resolving consent-row id onto the `solicitation_outreach` row. That stamp is the point-in-time proof; without it the ledger's current-state shape loses its justification |
| **#629** (owner approval surface) | §6.1 — render case (a) and case (b) `no_consent` differently; "re-upload this list" is truthful only in case (b). Never surface consent rows directly (§3.1 RLS) |
| **#624** (spine lifecycle) | §6.3 — consent-missing-at-dispatch must be distinguishable from build-time `withheld`; whether it shares a terminal status with suppression-at-dispatch is #624's call |
| **#633** (staging flip evidence) | §2.2 — prove a v1-covered contact withholds `no_consent` case (b) and becomes send-eligible after a v2 re-upload. This is the whole §1.2 trap, tested |
| **#626** (suppression ledger) | No new constraint. §5.2 restates #621 §8.1's precedence; #621 needs no change for it |

**Amendments to locked sibling specs:**

- **#619 D18** — "re-reading the immutable attestation at dispatch is inert" is superseded
  (§6.3). Consent *can* change between approval and dispatch. The consent check subsumes
  D18's check 7 on the consent axis; checks 1–6 unaffected.
- **#621 §4.1** — "`RESTRAINT_POLICY_VERSION` does not bump" is superseded (§6.2).
- **#621 §4.3** — confirmed correct as written; #620 supplies its second check's content.
- **#535 §4** — upheld, not amended. "No per-row consent columns" stands: the ledger is
  per-handle-per-channel, **derived** from the per-upload attestation, never owner-entered
  per row. The distinction #535 was protecting is intact.
- **Map #617 decision 5** — not reopened. Operative legal basis for email v1 remains
  attestation + suppression (DR2). What changes is only *how the code resolves which
  attestation applies*.

**Scope note for #625.** D1 and D10 put work in #625 that the map's one-line description
("consent-ledger schema + ingest wiring") did not anticipate: the v2 constant, the allowlist,
the batch-builder derivation swap, the evidence-shape change, the policy-version bump, and
the contact-delete sweep. It remains **one migration plus its wiring**, so the
one-migration-in-flight rule is unaffected — but it is a fatter ticket than the map line
reads, and it should be sized accordingly.

---

## 10. Test obligations (#625)

Per repworth.md "Always do" — tenant-scoped queries, idempotency keys, and gate paths all
appear here.

1. **`consent_attested` is no longer a tautology** — a contact covered only by v1 yields
   `attested: false`. This is the regression test for §1.1.
2. **The §1.2 trap, end to end** — upload under v1, re-upload the identical CSV under v2,
   assert zero visits inserted **and** the contact send-eligible. This is the test the whole
   spec exists for.
3. **Monotonicity guard** — apply a v2 write, then a v1 write with an earlier `attested_at`;
   assert the row still reads v2. Simulates the in-flight pre-deploy job (§4.2).
4. **Tenant scope** — a consent row at business A does not make the same handle eligible at
   business B in the same account.
5. **Contact delete sweeps consent** (§7.1) — and the negative: re-uploading after a delete
   requires a fresh attestation, i.e. the stale row did not survive to grant consent.
6. **Suppression outranks a fresh attestation** (§5.2) — suppress a handle, re-upload under
   v2, assert `withhold`. The most likely accidental re-subscribe path.
7. **Dispatch gate** (§6.3) — approve a batch, delete the contact mid-drip, assert the child
   terminalizes not-sent and emits no restraint decision. Live-DB; per CLAUDE.md this must be
   a `*.integration.test.ts` that asserts schema via `assertSchemaReady` and applies no
   migration SQL.
8. **Evidence shape** — both `no_consent` cases round-trip through `parseEvidence` and
   satisfy migration 090's CHECK.
9. **No SMS rows** (DR3) — a CSV with phone handles produces zero `channel='sms'` rows.

---

## 11. Flagged follow-ups — out of scope for #620

| # | Item | Why deferred |
|---|---|---|
| FU-1 | SMS consent rows and their attestation text | DR3. Blocked on Part II flag 1; the `channel` column and the allowlist exist so this needs no migration over a compliance record |
| FU-2 | Per-basis capture UI (May §6.5's three values) | Blocked on Part II flag 1. `basis` widens by `CHECK` change once counsel says which bases are real and what evidence each needs |
| FU-3 | Bulk re-attestation of existing uploads without re-upload | The §2.2 remedy (re-upload) works and is honest. A re-attest-in-place action needs its own provenance model and UI; revisit if staging shows re-upload friction is real |
| FU-4 | Account-scoped (brand-level) consent | §3.2 scopes below the unknown deliberately. If counsel says consent is transferable within an account, this becomes a lookup widening, not a migration |
| FU-5 | Owner-visible consent-coverage report ("N of your contacts are send-eligible") | Genuinely useful, and it is a #629 surface question with no schema implication. Not needed to send |
| FU-6 | Consent for contacts from non-CSV sources (booking integrations) | §9.4 defers the sources themselves; the second writer question (§4.1) returns with them |

---

## 12. Open questions this spec does NOT answer

- **Which terminal status a consent-miss-at-dispatch takes.** §6.3 requires only that it be
  distinguishable from build-time `withheld`. The enum is **#619 / #624's**.
- **Whether v2-attested contacts survive a counsel-driven v3.** Part II flag 8 — not an
  engineering call. The allowlist implements either answer.
- **Whether consent is transferable within an account, or to RepWorth as sender-agent.**
  Part II flag 1 — **THE** question, and the reason for §3.2's scoping and §3.3's single
  basis value.
- **The legal character of `owner_attested`.** Deliberately unnamed (§3.3). Counsel names it,
  or it stays unnamed.

---
---

# Part II — Counsel brief

> **Self-contained.** This part may be extracted and sent on its own; it assumes no
> knowledge of Part I or of RepWorth's codebase. Written by RepWorth engineering. **It is
> not legal advice and does not purport to be** — it is a compilation of the questions we
> could not answer ourselves, with our current default behavior stated for each so that you
> can correct a position rather than design one from scratch.
>
> Source for flags 1–6: `docs/research/2026-07-23-solicitation-policy-constraints.md` §6
> (RepWorth internal research, 2026-07-23), reproduced **verbatim**. Flags 7–8 are
> RepWorth-authored.

## A. What RepWorth is

RepWorth is a subscription software product for small and medium-sized businesses (SMBs) —
restaurants, salons, clinics, auto shops, home-services companies. It manages their online
reputation on Google Business Profile: it ingests their Google reviews, drafts replies, and
either presents those replies to the owner for approval ("Copilot") or posts them within
bounded, audited autonomy ("Autopilot"). Every automated public action is reviewed by an
internal LLM checker and is suspendable per account.

We are a **vendor acting on the SMB's behalf**. The SMB is our customer; the SMB's customers
are the people any outbound message would reach. We hold the SMB's customer list only
because the SMB uploaded it to us.

## B. What we are about to turn on

A feature we call **review solicitation**: an SMB uploads a CSV of its own past customers
(name, email and/or phone, visit date), and RepWorth sends those customers a short,
individually-written **email** asking them to leave a Google review — dripped out over
hours-to-days, in batches the owner approves.

Precise scope of what we are asking you about:

- **Email only.** No SMS, no voice, no messaging apps. That is a hard product constraint of
  this phase, not a sequencing choice.
- **Sent from a RepWorth-owned sending domain**, with the business's name as the display
  name and the owner's address as Reply-To.
- **Two phases.** It runs first on a **staging** environment with test data and no real
  consumers — the only recipients are seed mailboxes we ourselves control. Turning it on in
  **production**, against real consumers, is what your sign-off gates. Nothing in this brief
  blocks the staging work.

## C. What we already do, unasked

Listed so you can see the compliance floor and tell us where it is wrong — not as questions.

**Consent and records.** An owner cannot upload a list without ticking a blocking
attestation. We record who attested, when, and the exact version of the text they agreed to,
and we can trace any individual recipient back to the attestation that covers them. We
deliberately do **not** ask owners to record per-person consent flags, on the view that
owner-guessed per-row consent would create records that read as real consent without being
it. The proposed attestation text is at flag 7.

**Opt-outs.** Every email carries an unsubscribe link and RFC 8058 one-click unsubscribe. An
opt-out is recorded immediately, **never expires**, and there is **no self-serve re-subscribe
path in any surface**. Opt-outs are recorded **globally across our whole platform**, not
merely for the business that sent the message — deliberately stricter than CAN-SPAM's
per-sender requirement, because every business sends from one shared RepWorth domain and a
recipient cannot tell them apart. A later attestation by any business never overrides an
existing opt-out. Hard bounces and spam complaints also suppress. We service opt-out replies
to our mailbox by hand on a daily business-day cycle.

**Message content.** Every email carries the business's physical postal address (no address
on file means the business cannot send at all), an honest subject line, and accurate headers.
An automated content check blocks, before send: any incentive or reward language; any attempt
to suggest review wording, keywords, or a star rating; and any "if you were happy, review us;
if not, contact us privately" construction.

**Who gets asked.** Recipient selection is **sentiment-blind by design** — we never predict
or use a customer's likely rating to decide whether to ask them. Selection uses only recency
of visit, whether the person already reviewed, whether they were recently asked, and whether
they have opted out. Sending is rate-shaped over days rather than blasted.

**Data handling.** Raw uploaded CSV text is deleted as soon as it is processed; only derived
contact records and upload metadata persist. Owners can hard-delete any individual contact.
Account closure purges the customer list, with opt-out records deliberately retained so those
opt-outs continue to be honored.

## D. What we need back

For **Tier 1**, a yes / no / yes-with-caveats per question is sufficient to proceed to
production. **Tier 2** shapes a database schema we are freezing now, so a directional answer
now is worth substantially more than a precise answer in six months. **Tier 3** is recorded
so a future engagement does not rediscover it; no answer needed today.

---

## Tier 1 — Gates the production launch

### Flag 2 — Primary-purpose classification

> **Verbatim (#531 §6.2):** "Primary-purpose classification of a review ask email (commercial
> vs transactional/relationship) — we default to commercial-compliant regardless."

**RepWorth framing.** A message to a past customer saying "thanks for visiting on the 3rd —
would you leave us a review?" arguably has a transactional or relationship flavor, but the
FTC's primary-purpose test looks at content and presentation. We would rather be told we are
over-complying than discover we mis-classified.

**What we do today absent your answer.** We treat every solicitation email as **commercial**
and comply fully with CAN-SPAM: valid physical postal address, honest subject and headers,
conspicuous opt-out honored immediately and permanently, no fee or login wall to opt out.
This costs us little and we intend to keep doing it regardless of the answer. **The question
is whether that is sufficient, not whether it is necessary.**

### Flag 4 — Our role under state privacy law

> **Verbatim (#531 §6.4):** "RepWorth's role under CCPA/CPRA family for uploaded lists
> (service provider/processor terms in ToS/DPA), retention and deletion SLAs for watch-mode
> data."

**RepWorth framing — please note this one already binds.** The upload-and-analyze half of
this product ("watch-mode") is **already live**, so we are already holding SMB customer lists
today, with no messages sent. Data-protection obligations attach at collection, not at send.
Whatever the answer, part of it is retroactive.

**What we do today absent your answer.** We treat ourselves as a **service provider /
processor** for the SMB's customer list. We delete raw uploaded files immediately after
processing, retain only derived contact records plus upload metadata, support per-contact
hard delete, and purge on account closure. We have **not yet** written processor terms into
our ToS/DPA, and we have **no stated retention SLA**. We need: (a) confirmation of the role,
(b) the contract terms that role requires, and (c) a retention/deletion SLA we can implement
and state publicly.

### Flag 5 — Could analytics facilitate review gating?

> **Verbatim (#531 §6.5):** "Whether watch-mode sentiment analytics shown to the owner (with
> no ask-list output) could still be construed as facilitating gating if the owner manually
> solicits from it."

**RepWorth framing.** Google prohibits merchants from "selectively soliciting positive
reviews," and the FTC's review rule covers the downstream conduct. We have designed our
*automated* selection to be sentiment-blind (§C). The residual question is our **owner-facing
analytics**: if we show an owner sentiment or satisfaction insight and the owner then asks
people by hand, have we facilitated gating? This also binds today, since those analytics are
already live.

**What we do today absent your answer.** Our automated candidate selection uses no sentiment
or rating signal of any kind, enforced in code and tested. We frame owner-facing outputs as
insight — segments, timing, volume — never as a "here are your happiest customers, ask these"
list. We need to know whether that framing line is in the right place, and whether any
sentiment-adjacent analytic should be withheld from owners entirely once sending is live.

---

## Tier 2 — Gates the SMS product; asked now because it freezes schema

We are, this quarter, designing the database table that will record consent for **all**
channels. Email does not strictly need it (our email basis is attestation plus opt-out). We
are building it now so that SMS can adopt it later without migrating a live compliance
record. **Your answers to these two determine whether that table is shaped correctly**, so a
directional answer now is worth far more than a precise one after the schema is frozen.

### Flag 1 — Consent transferability and the "maker" of the call

> **Verbatim (#531 §6.1):** "Consent model for SMS: what consent record must the SMB attest
> to / upload, is it transferable to RepWorth as sender-agent, and who is the 'maker' of the
> call under TCPA when our agent sends?"

**RepWorth framing — this is the single most consequential question in this brief, and part
of it binds email today.**

Three sub-questions, in descending order of how much they cost us:

1. **Is consent transferable at all?** The SMB's customer gave contact details to the SMB, not
   to RepWorth. When RepWorth sends, is that consent available to us as the SMB's agent, and
   does that answer change if we send from **our own** domain rather than the SMB's? *(This
   half is not SMS-specific — it is our email posture today.)*
2. **Is consent transferable within one customer's account?** Some of our customers are
   multi-location businesses. If a person is a customer of location A, may location B in the
   same business contact them? **We have currently answered this "no" in our schema** —
   consent is scoped to the single location the person actually visited, and a business
   wanting broader reach must upload the contact at each location. That is the conservative
   choice and it is reversible; we would like to know whether it is the correct one.
3. **Who is the "maker" of the call/text under the TCPA when our software composes and sends
   it — the SMB, RepWorth, or both?** This determines who carries per-message exposure at
   $500–$1,500 per message, and it shapes what our contracts must say.

**Bearing on the schema.** May's design proposed three consent bases —
`existing_customer`, `direct_consent`, `prior_relationship`. **We could not defend any of
them**, because our single attestation text asserts two of the three at once and the third
not at all, and because the owner never selects a basis. Rather than record a distinction we
invented, we ship one value meaning literally "the business owner attested to this,"
and we are asking you: **which bases are legally real, and what evidence must an SMB
supply for each to rely on it?**

**What we do today absent your answer.** Email only, on an attestation-plus-opt-out basis.
No SMS. Consent scoped to a single location. One basis value with no legal claim attached
to its name.

### Flag 3 — Per-state mini-TCPA matrix

> **Verbatim (#531 §6.3):** "Per-state mini-TCPA matrix (FL, OK, WA, MD, TX at minimum) vs
> strictest-common-denominator sending policy."

**RepWorth framing.** Our internal research identifies roughly fifteen states with
mini-TCPA statutes stricter than federal law in at least one respect — Florida's FTSA
(broader autodialer definition, express written consent, the main SMS class-action venue),
Washington's ten-second DNC hangup rule, Maryland and Oklahoma's three-contact-per-day caps,
Texas's 2025 update. There is a build decision underneath: **per-recipient-state awareness**
(we determine each recipient's state and apply that state's rules) versus a
**strictest-common-denominator** policy (one rule set, everywhere, set to the tightest). The
first is materially more engineering and requires reliable state determination we do not
currently have; the second is simpler and safer but more restrictive.

**We should also ask the analogous email question**, which #531 §4 flags but §6 does not: to
what extent do **state anti-spam email statutes** (Washington's CEMA, California
§ 17529.5) survive CAN-SPAM preemption for falsity- and deception-based claims, and does our
current posture satisfy them?

**What we do today absent your answer.** Email only, single federal-compliant policy, no
per-state logic, no state determination for recipients. Quiet-hours logic is not implemented
because we do not currently believe it binds email.

---

## Tier 3 — Recorded, not asked today

### Flag 6 — Future AI-voice solicitation

> **Verbatim (#531 §6.6):** "Future AI-voice solicitation: FCC artificial-voice ruling (2024)
> + state AI-disclosure laws."

**RepWorth framing.** Out of scope for both the current product and the SMS product that
follows it. Recorded here only so that a future engagement does not start from zero. Our
understanding is that the FCC confirmed in 2024 that AI-generated voices are "artificial"
under the TCPA, which would place any AI-voice solicitation squarely inside the
artificial-voice prohibition. **No answer needed today.**

---

## RepWorth-authored questions

### Flag 7 — Review the attestation text

The text below is what an SMB owner must affirmatively tick before uploading a customer
list, and before any email may be sent to anyone on it. It is currently **engineering-drafted
placeholder wording** and has never been reviewed by counsel. Under our design, an upload's
attestation text version is what authorizes sending — so this sentence is a gate, not a
disclaimer.

> "I confirm these are real customers of this business who provided their contact
> information directly to us, that I am authorized to upload their details, and that
> RepWorth may send review requests to them **by email** on this business's behalf.
> Recipients may opt out of these emails at any time, and RepWorth will honor those
> opt-outs."

We are asking for: wording corrections; anything material that is missing; and specifically
whether it adequately establishes the **sender-agent relationship** that flag 1.1 turns on.
Note that it names **email** deliberately — an SMS product would ship a separate text, so
that an email-era attestation can never be read as TCPA consent.

**Context you may want:** the prior version of this text ended "No review requests will be
sent in watch-mode," because at the time nothing sent. That sentence is why lists uploaded
under it are, in our current design, **not** eligible to be mailed at all until re-uploaded
under the new text. Which leads directly to:

### Flag 8 — Does a wording change strand prior attestations?

If your review of flag 7 changes the wording materially, that is a new version. **Do
customers whose lists were uploaded under the prior version remain covered, or must they
re-attest under the new text?**

This is not hypothetical and it is not cheap. We have built the mechanism that implements
either answer — an explicit list of which attestation versions authorize sending — so we can
follow your ruling exactly. But we need the ruling **before** the production launch, because
in the interim our staging campaign will accumulate contacts attested under whatever version
is current, and answering "they must re-attest" afterwards strands all of them.

A general rule would serve us better than a one-time answer: **what kind of change to this
text requires re-attestation, and what kind does not?**

---

*Part II compiled 2026-07-28 by RepWorth engineering. Flags 1–6 reproduced verbatim from
`docs/research/2026-07-23-solicitation-policy-constraints.md` §6 (internal research compiled
2026-07-23 from Google policy pages, statutory text via Cornell LII, FTC/FCC guidance, and
eCFR/Federal Register). That full research document is available on request and is the
better starting point for the statutory citations behind each flag.*
