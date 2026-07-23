# Contacts CSV + Consent Attestation Contract (Solicitation watch-mode)

> **Status:** Locked — resolves wayfinder ticket #535 (part of map #528).
> Outcome of the 2026-07-23 grilling session. Implementation ticket **#541**
> builds exactly this contract; the restraint policy module (#533/#542) and the
> run-engine batch builder (#534/#543) consume its rows. Design of record:
> `docs/future-plans/2026-07-01-agentic-reputation-platform-design.md` §9
> (decision 3: owner CSV upload with explicit consent attestation, doubling as
> the visits-ledger tracer). Policy constraints cited from
> `docs/research/2026-07-23-solicitation-policy-constraints.md` (#531).

## 1. Domain model

Two concepts, two tables, both per-location (invariant #8 scoping):

- **Contact** — the deduped identity of one person at one location, keyed by
  `(business_id, normalized handle)`. Carries `name`, optional `email` and
  `phone` (at least one present), each stored in normalized form.
- **Visit** — one append-only ledger row per contact per calendar date, unique
  on `(contact_id, visit_date)`, carrying the optional staff/job `note` and an
  FK to the upload it arrived on. This is the visits-ledger tracer that later
  powers attribution and memory-jog details (§9.4) — details are
  template-interpolated from these validated rows, never LLM-generated.

Future watch-mode batch-decision rows (#542/#543) reference `contact_id` plus a
withhold-reason enum only — **no PII is ever copied** out of the contact row.

### 1.1 Normalized handle

The canonical contact identifier: lowercased/trimmed email, or phone in E.164
(10-digit numbers assume US). Normalization happens **once at ingest** and the
normalized form is what's stored — every downstream join (dedupe, future
suppression ledger) is a plain equality on it.

### 1.2 Contact matching (dedupe across and within uploads)

- An incoming row matches an existing contact if **either** normalized handle
  matches (same location).
- A matched contact **merges in** a new handle it lacked (an email-only contact
  gains the row's phone).
- If the row's email matches contact X and its phone matches a *different*
  contact Y, the row is rejected with reason `ambiguous_identity`. **Never
  auto-merge two existing contacts** — an auto-merge on a typo'd handle
  destroys two identities irreversibly.
- A name difference on a matched contact is a non-event: latest non-empty name
  wins.

### 1.3 Visit dedupe / idempotency

- Visit uniqueness is `(contact_id, visit_date)`. Re-uploading an overlapping
  export is **fully idempotent**: duplicate `(contact, date)` pairs are counted
  as `duplicate_visit` in the report (informational, not an error). A non-empty
  incoming `note` on a duplicate refreshes the stored note.
- Consequence: there is **no upload-undo**. Once a row merges a handle into an
  existing contact, clean reversal is impossible; correction is per-contact
  deletion (§5).

## 2. CSV columns and validation

| Column | Required | Validation |
|---|---|---|
| `name` | yes | non-empty |
| `email` | ≥1 of email/phone | RFC-plausible syntax; lowercased/trimmed |
| `phone` | ≥1 of email/phone | normalizable to E.164 (US assumed for 10-digit) |
| `last_visit_date` | yes | `YYYY-MM-DD` or `MM/DD/YYYY`; not in the future |
| `note` | no | length-capped free text (staff/job detail) |

- Headers: canonical names above plus a small alias set, matched
  case-insensitively. **Unknown columns are ignored** (POS exports carry
  extras).
- **Staleness is NOT rejected at ingest.** An old visit date is valid data;
  whether it's too stale to ask rides the restraint policy module's freshness
  defaults (#533). Ingestion validates syntax; policy judges.

### 2.1 Rejection reasons (closed enum)

Per-row: `missing_name`, `missing_handle`, `invalid_email`, `invalid_phone`,
`invalid_date`, `future_date`, `ambiguous_identity`, `note_too_long`.
Informational (not a rejection): `duplicate_visit`.

Whole-file (structural — nothing is imported): missing required headers,
row-count over cap, byte-size over cap, undecodable encoding.

### 2.2 Bounds

5 MB and 5,000 data rows per upload. Bigger lists split across uploads — visit
idempotency makes overlap harmless. No per-location total-contact cap in v1;
revisit on evidence of abuse.

## 3. Ingest lane and owner UX

Async, per invariants #1 and #2:

1. The Next.js route validates auth/entitlement, persists the **upload row**
   (raw CSV text + attestation record, §4) and a `csv_ingest` outbox job in
   **one transaction**.
2. The Railway worker parses, validates, matches, and upserts
   contacts/visits, then writes the report onto the upload row.
3. The UI shows processing status, then the report: contacts created/merged,
   visits added, `duplicate_visit` count, rejected rows with `{row, reason}`
   (downloadable). Partial accept — valid rows land even when others reject
   (precedent: `src/lib/admin/csv-import.ts`).

**Raw CSV retention:** the raw text exists only for transport. In the same
transaction that writes the terminal report (success *or* terminal failure),
the raw text is cleared (NULLed). Upload **metadata is kept**: filename, byte
size, SHA-256, row counts, report, attestation. CCPA-family duties attach at
upload (#531 §4 row 8) — the raw blob is the largest PII surface and its
lifetime is bounded by processing.

## 4. Consent attestation

- **Per-upload**, recorded on the upload row: attesting user id, timestamp,
  and the **attestation text version**. The text itself is a versioned code
  constant (engineering placeholder until counsel; changing the wording bumps
  the version).
- The attestation checkbox is **blocking** — no upload without it.
- Every contact and visit row inherits attestation provenance via its upload
  FK: "which attestation covers this person" is a query, not a guess.
- **No per-row consent columns.** TCPA consent provenance is THE open counsel
  question for send-mode (#531 §6.1); storing owner-guessed per-row consent
  flags now would create legally-meaningless records that read as real consent
  downstream. The send-mode map designs that model with counsel.

## 5. Deletion and retention

- **Per-contact hard delete** from the dashboard: visits CASCADE; future
  batch-decision rows CASCADE too. Watch-mode sent nothing, so a deleted
  person vanishes entirely — no soft delete, no residual hash, no tombstone.
- **Offboarding:** the account offboarding `delete_data`/purge path must sweep
  uploads, contacts, and visits (#541 wires this against
  `docs/superpowers/specs/2026-06-05-owner-offboarding-design.md`).
- No automatic TTL/expiry on contacts in v1 (retention posture documented for
  the ToS/DPA follow-up flagged in #531 §6.4).

## 6. Suppression-ledger join (send-mode foresight, locked now)

The future suppression ledger (opt-outs, bounces, do-not-contact) keys on the
**normalized handle per channel** — never on `contact_id`. Delete + re-upload
mints a new contact row; keying on the row id would silently un-suppress an
opted-out person. The only commitment #541 inherits: normalization is
canonical, computed once at ingest, stored on the contact row, so the ledger
join is a plain equality. Ledger scope (account vs location) and the
deletion→suppression interplay are send-mode questions for counsel.

## 7. Explicitly NOT in this contract

- Per-row consent semantics or any consent-ledger model (send-mode + counsel).
- The suppression ledger itself.
- Upload-undo (impossible post-merge, §1.3).
- Booking-system integrations as candidate sources (§9.4).
- Any send path, veto window, or ask copy.

## Decision log (grilling 2026-07-23)

1. Identity model: contact + append-only visits ledger (honors map decision
   3's visits-ledger tracer; rejected contact-only and visit-only shapes).
2. Tenancy: per-location contacts, keyed `(business_id, normalized handle)`.
3. Handle shape: separate `email`/`phone` columns, ≥1 valid required.
4. Matching: either-handle match, merge new handle, reject
   `ambiguous_identity`; never auto-merge contacts.
5. Visit dedupe: unique `(contact_id, visit_date)`; idempotent re-uploads.
6. Ingest lane: async outbox → worker; partial accept; closed rejection enum.
7. Bounds: 5 MB / 5,000 rows; structural failures reject the whole file.
8. Raw CSV cleared at terminal state; metadata retained.
9. Attestation: per-upload, versioned text constant, blocking, provenance via
   upload FK; no per-row consent columns.
10. Deletion: hard delete + CASCADE + offboarding purge sweep; no soft delete.
11. Suppression join key: normalized handle per channel, never contact row id.
