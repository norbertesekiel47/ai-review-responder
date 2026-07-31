# #625 Consent-Ledger Schema + Ingest Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `solicitation_consent` (migration **093**) and its wiring so consent
resolution becomes a ledger lookup gated by `SEND_ELIGIBLE_ATTESTATION_VERSIONS`,
killing the `consent_attested` tautology and the §1.2 re-upload trap.

**Architecture:** Every change deepens an existing module — no new seams. The ledger
is written only by `ingestContactsCsvUpload`'s existing advisory-locked transaction
(guarded monotone upsert), read only by `loadCandidateWindow`'s derivation (LEFT JOIN
replaces the tautological expression). `evaluateAsk` stays pure and its interface
gains only the two nullable evidence fields the spec mandates. Contact delete and
offboarding purge get explicit consent sweeps (consent fails closed — DR1).

**Spec:** `docs/superpowers/specs/2026-07-28-consent-ledger-design.md` Part I (all §
references below are to it). Amendments: `2026-07-28-send-mode-cross-spec-amendments.md`
(consent snapshot stamps at dispatch by #630 — nothing here touches
`solicitation_outreach`). Intake: `docs/superpowers/plans/feat-625-consent-ledger-intake.json`.

**Deferred by map-owner decision 2026-07-30:** spec §10 test 7 (dispatch gate) and the
`solicitation_consent_missing_at_dispatch` event ride with #630.

**Tech stack:** Postgres migration (raw SQL, immutable once applied), Postgres.js
transactions, Vitest (unit + `*.integration.test.ts` live-DB suites).

**Verbatim glossary terms** (use exactly): *consent ledger*, *guarded monotone upsert*,
*send-eligible attestation version*, *no_consent case (a)/(b)*, *the §1.2 re-upload trap*,
*consent fails closed; suppression fails open (DR1)*, *Batch candidate window*.

---

## Blocking edges

```
Task 1 (migration 093 + schema-ready + log)  ──► Tasks 3, 4, 5, 6
Task 2 (attestation constants)               ──► Tasks 3, 4
Task 3 (ingest write path)                   ──► Task 4's integration tests only
Tasks 5, 6 independent of 2/3/4 (need only Task 1)
Task 7 (gate + docs sweep) last
```

---

### Task 1: Migration 093 — `solicitation_consent`

**Files:**
- Create: `supabase/migrations/093_solicitation_consent.sql`
- Modify: `src/lib/shared/__tests__/helpers/schema-ready.ts` (add `MIGRATION_093_SOLICITATION_CONSENT`)
- Modify: `.claude/reference/migrations-log.md` (head 092 → **093**, new entry, retention-policy row)
- Create: `src/lib/shared/__tests__/migration-093-solicitation-consent.integration.test.ts`

**Precedents:** `086_solicitation_contacts.sql` (lane conventions, comment style),
`092`'s shape suite (`migration-092-terminal-body-redaction.integration.test.ts`) for
the live-db-lock + no-committed-re-apply pattern.

`new-migration` skill obligations baked in: head verified 092 (so this is 093, never
re-derive); UUIDv7 worker-supplied PK; the unique index is **total, not partial** (§3.1
— no byte-for-byte `ON CONFLICT` hazard); CHECKs pair with `NOT NULL`; new-table RLS
posture decided (deny-all, invariant #14 posture); migrations-log head bump + entry +
retention row in the same change.

- [ ] **Step 1: Write the shape suite (failing)** — follow 092's suite: `acquireLiveDbLock`,
  `assertSchemaReady(MIGRATION_092…)` precondition, then assert via `information_schema`/
  `pg_indexes`: table exists; columns + nullability per §3.1; CHECK `channel IN ('email')`;
  CHECK `basis IN ('owner_attested')`; unique index on `(channel, normalized_handle,
  business_id)`; FK `business_id → businesses(id) ON DELETE CASCADE`; FK
  `source_upload_id → contact_csv_uploads(id) ON DELETE SET NULL`; **no FK on
  `attested_by_user_id`** (assert absence — §3.4 is the reason this table survives the
  086 users cascade); `rowsecurity = true` with zero permissive policies.
- [ ] **Step 2: Run it** — expected FAIL (table absent).
- [ ] **Step 3: Write the migration:**

```sql
-- 093_solicitation_consent.sql
-- Consent ledger (#625, spec docs/superpowers/specs/2026-07-28-consent-ledger-design.md §3).
-- Current-state rows, monotone forward (D3); email-only channel (DR3); business-scoped,
-- deliberately NO account_id (§3.2, 086's denormalization warning). attested_by_user_id
-- is a PLAIN UUID with NO FK: 086's users(id) ON DELETE CASCADE must never reach the
-- ledger — deleting a staff member must not revoke consent (§3.4). Revocation lives in
-- the suppression ledger, never here (D7): no revoked_at column, ever.

CREATE TABLE solicitation_consent (
  id UUID PRIMARY KEY,                       -- UUIDv7, worker-supplied (repo convention)
  channel TEXT NOT NULL CHECK (channel IN ('email')),
  normalized_handle TEXT NOT NULL,           -- normalizeEmail output; same normalizer as ingest
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  basis TEXT NOT NULL CHECK (basis IN ('owner_attested')),
  attestation_version TEXT NOT NULL,         -- captured, not joined: the eligibility gate input (§3.4)
  attested_at TIMESTAMPTZ NOT NULL,          -- also the §4.2 monotonicity guard
  attested_by_user_id UUID,                  -- captured; NO FK by design (§3.4)
  source_upload_id UUID REFERENCES contact_csv_uploads(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Total (not partial) unique key: consent resolution is plain equality on the same
-- shape as solicitation_contacts_email_uniq (§3.2).
CREATE UNIQUE INDEX solicitation_consent_scope_uniq
  ON solicitation_consent (channel, normalized_handle, business_id);

-- Server-owned: deny-all to the browser (invariant #14 posture, same as
-- auto_approval_policies). Owner-facing consent state reaches the UI only as a
-- withhold reason on an ask (§3.1).
ALTER TABLE solicitation_consent ENABLE ROW LEVEL SECURITY;
```

  (No index on `source_upload_id` FK is needed for correctness, but 087 added FK
  covering indexes for the contact tables — add `CREATE INDEX
  idx_solicitation_consent_source_upload ON solicitation_consent (source_upload_id)`
  to keep the `ON DELETE SET NULL` from seq-scanning, matching 087's precedent.)

- [ ] **Step 4: Apply to the LOCAL test DB** — `pnpm test:db:setup`, then run the shape
  suite: expected PASS. (Staging/prod application is step 8 of the workflow — NOT now.)
- [ ] **Step 5: `schema-ready.ts`** — add `MIGRATION_093_SOLICITATION_CONSENT:
  SchemaRequirement` (migration `'093_solicitation_consent'`; require the table, the
  unique index, the FK-covering index), following `MIGRATION_091`'s entry shape.
- [ ] **Step 6: migrations-log** — bump head line to 093, add the entry (what/why/spec
  pointer/shape-suite path), add the retention-policy row: hard-deletes on contact
  delete and purge (DR1 — consent fails closed), no TTL (§7.3).
- [ ] **Step 7: Commit** — `feat(#625): migration 093 — solicitation_consent ledger`.

---

### Task 2: Attestation v2 + the send-eligibility allowlist

**Files:**
- Modify: `src/lib/solicitation/attestation.ts`
- Test: `src/lib/solicitation/__tests__/attestation.test.ts` (create if absent)

- [ ] **Step 1: Failing tests** — (a) `CONSENT_ATTESTATION_VERSION` is
  `'consent_attestation_v2'`; (b) the text names email, opt-outs, and RepWorth sending
  on the business's behalf, and no longer contains "watch-mode"; (c)
  `SEND_ELIGIBLE_ATTESTATION_VERSIONS` contains v2 and **not** v1; (d)
  `isSendEligibleAttestation('consent_attestation_v1')` is false, `(…_v2)` true,
  `(null)` false.
- [ ] **Step 2: Implement:**

```ts
/**
 * Consent attestation text — versioned code constant (#535 contract §4).
 * v2 (#620 §2.3): engineering placeholder pending counsel (Part II flag 7); names
 * email, the sender-agent relationship, and the opt-out. Changing the wording MUST
 * bump CONSENT_ATTESTATION_VERSION. The version string is stored on every upload row
 * AND captured onto solicitation_consent rows: "which attestation covers this person"
 * is a query, not a guess.
 */
export const CONSENT_ATTESTATION_VERSION = 'consent_attestation_v2' as const;

export const CONSENT_ATTESTATION_TEXT =
  'I confirm these are real customers of this business who provided their contact '
  + 'information directly to us, that I am authorized to upload their details, and '
  + 'that RepWorth may send review requests to them by email on this business\'s '
  + 'behalf. Recipients may opt out of these emails at any time, and RepWorth will '
  + 'honor those opt-outs.';

/**
 * Attestation versions whose coverage authorizes a SEND (#620 §2.2). Widened only
 * when a new attestation text ships; membership is the send-eligibility gate.
 * Deliberately a code constant, never an env var: staging and prod must agree on
 * what an attestation authorizes. v1 is deliberately ABSENT — its text disclaimed
 * sending ("No review requests will be sent in watch-mode"); the owner remedy is
 * re-upload under v2, which the consent ledger makes effective (§1.3).
 */
export const SEND_ELIGIBLE_ATTESTATION_VERSIONS = ['consent_attestation_v2'] as const;

export function isSendEligibleAttestation(version: string | null): boolean {
  return version !== null
    && (SEND_ELIGIBLE_ATTESTATION_VERSIONS as readonly string[]).includes(version);
}
```

- [ ] **Step 3: Run tests** (PASS), plus `rg -l "consent_attestation_v1|watch-mode"
  src/` to catch any fixture/copy asserting the v1 text verbatim — update those
  assertions to v2 (pre-launch: no compatibility shim for the old text).
- [ ] **Step 4: Commit** — `feat(#625): v2 attestation + SEND_ELIGIBLE_ATTESTATION_VERSIONS`.

---

### Task 3: Ingest writes the ledger (guarded monotone upsert)

**Files:**
- Modify: `src/lib/solicitation/ingest.ts`
- Modify: `src/lib/analytics/events.ts` (register `solicitation_consent_recorded`,
  `solicitation_consent_upgraded` as durable server-side names — follow the file's
  existing registration structure; they must NOT enter `CLIENT_ENQUEUEABLE_EVENT_NAMES`)
- Test: `src/lib/solicitation/__tests__/ingest.integration.test.ts` (extend)

**Precedent:** `upsertVisit` (ingest.ts:301) for the upsert-in-tx shape;
`enqueueAnalyticsEvent` (`src/lib/analytics/enqueue.ts`) for durable events.

- [ ] **Step 1: Failing integration tests** (live-DB suite already exists — extend it;
  it asserts schema via `assertSchemaReady`, now including `MIGRATION_093…`):
  - **"the §1.2 re-upload trap: re-uploading the identical CSV under v2 inserts zero
    visits AND upgrades the consent row"** — seed an upload row with
    `attestation_version = 'consent_attestation_v1'`, ingest; seed a second upload of
    the same CSV with v2 and later `attested_at`, ingest; assert `visitsAdded = 0`,
    `duplicateVisits > 0`, and the consent row reads v2. (Send-eligibility end-to-end
    is Task 4's test.)
  - **"monotonicity guard: a v1 write with an earlier attested_at cannot downgrade a
    v2 consent row"** — ingest v2 first, then a v1 upload with earlier `attested_at`
    (the in-flight pre-deploy job, §4.2); assert the row still reads v2 and
    `updated_at` did not churn.
  - **"monotone upsert idempotency: replaying the same csv_ingest job is a no-op
    without updated_at churn"** — run `ingestContactsCsvUpload` twice for one upload;
    assert one consent row, unchanged `updated_at`, and no duplicate analytics rows
    (same `event_key`).
  - **"no SMS rows: a CSV with phone handles produces zero channel='sms' consent
    rows"** (DR3) — phone-only rows produce contacts + visits and **no** consent row;
    assert `SELECT count(*) FROM solicitation_consent` covers email rows only.
  - **"contact rows without email mint no consent row"** (case inside DR3 test is fine).
- [ ] **Step 2: Widen the upload read** — `UploadRow` + the `SELECT` in
  `ingestContactsCsvUpload` gain `attested_at`, `attestation_version`,
  `attested_by_user_id` (all `NOT NULL` on 086).
- [ ] **Step 3: Implement `upsertConsent`** (private to ingest.ts — internal to the
  module, not interface) and call it from `upsertCandidates` for every candidate with
  a non-null email, after the visit upsert:

```ts
/** §4.2 guarded monotone upsert — the consent ledger's ONLY writer (D8). Email rows
 *  only (DR3): a phone-only candidate mints no row. Serialized per business by the
 *  caller's advisory lock, so the pre-read for event derivation cannot race the
 *  upsert. Last attestation wins, and "last" is attested_at, not arrival order: an
 *  in-flight pre-deploy v1 job must not overwrite a v2 row. */
async function upsertConsent(
  tx: TransactionSql,
  businessId: string,
  upload: Pick<UploadRow, 'id' | 'attested_at' | 'attestation_version' | 'attested_by_user_id'>,
  normalizedEmail: string,
): Promise<void> {
  const [existing] = await tx<{ id: string; attestation_version: string }[]>`
    SELECT id, attestation_version FROM solicitation_consent
    WHERE channel = 'email' AND normalized_handle = ${normalizedEmail}
      AND business_id = ${businessId}
  `;
  const [written] = await tx<{ id: string }[]>`
    INSERT INTO solicitation_consent
      (id, channel, normalized_handle, business_id, basis,
       attestation_version, attested_at, attested_by_user_id, source_upload_id)
    VALUES
      (${uuidv7()}, 'email', ${normalizedEmail}, ${businessId}, 'owner_attested',
       ${upload.attestation_version}, ${upload.attested_at},
       ${upload.attested_by_user_id}, ${upload.id})
    ON CONFLICT (channel, normalized_handle, business_id)
    DO UPDATE SET
      basis               = EXCLUDED.basis,
      attestation_version = EXCLUDED.attestation_version,
      attested_at         = EXCLUDED.attested_at,
      attested_by_user_id = EXCLUDED.attested_by_user_id,
      source_upload_id    = EXCLUDED.source_upload_id,
      updated_at          = NOW()
    WHERE EXCLUDED.attested_at > solicitation_consent.attested_at
    RETURNING id
  `;
  // written is undefined when the guard rejected the update (older attestation) —
  // deliberate no-op, no event.
  if (written === undefined) return;
  if (existing === undefined) {
    await enqueueAnalyticsEvent(tx, {
      eventKey: `solicitation_consent_recorded_${written.id}`,
      eventName: 'solicitation_consent_recorded',
      distinctId: businessId,
      businessId,
      properties: { channel: 'email', basis: 'owner_attested',
                    attestation_version: upload.attestation_version }, // NEVER the handle (§8.1)
    });
    return;
  }
  if (existing.attestation_version !== upload.attestation_version) {
    await enqueueAnalyticsEvent(tx, {
      eventKey: `solicitation_consent_upgraded_${written.id}_${upload.attestation_version}`,
      eventName: 'solicitation_consent_upgraded',
      distinctId: businessId,
      businessId,
      properties: { channel: 'email', from_version: existing.attestation_version,
                    to_version: upload.attestation_version },
    });
  }
}
```

  (Adjust `enqueueAnalyticsEvent`'s input fields to its actual `EnqueueAnalyticsEventInput`
  shape — read the file; `distinctId` may need the account/owner id per existing callers'
  precedent. The postgres.js microsecond gotcha does NOT apply to the guard: both
  operands sit in one SQL statement (§4.2) — keep that as a comment only if the module's
  comment style warrants it.)

- [ ] **Step 4: Run the extended integration suite** with `TEST_DATABASE_POOL_URL` set:
  expected PASS. Also re-run `ingest.test.ts` (unit).
- [ ] **Step 5: Commit** — `feat(#625): consent ledger writes join the csv_ingest transaction`.

---

### Task 4: Derivation swap + evidence fields + `.3` bump

**Files:**
- Modify: `src/lib/solicitation/restraint-policy.ts`
- Modify: `src/lib/solicitation/batch-builder.ts`
- Modify: `src/lib/solicitation/batch-view.ts` (`parseEvidence`)
- Tests: `src/lib/solicitation/__tests__/restraint-policy.test.ts` (or wherever
  `evaluateAsk` unit tests live), `batch-builder.integration.test.ts`, `batch-view.test.ts`

- [ ] **Step 1: Failing unit tests:**
  - **"suppression outranks a fresh attestation: an attested candidate with a
    suppression present still withholds as suppressed"** — `evaluateAsk` with
    `consent: { attested: true, uploadId: 'u', attestationVersion: 'consent_attestation_v2' }`
    and `suppression: { source: 'unsubscribe', suppressedAt: … }` → `reason: 'suppressed'` (§5.2).
  - `no_consent` evidence carries both nullable fields: case (a)
    `{ upload_id: null, attestation_version: null }`, case (b) both populated.
  - `RESTRAINT_POLICY_VERSION === 'restraint_v_watch_2026-07-23.3'`.
- [ ] **Step 2: `restraint-policy.ts`:**
  - `AskCandidate.consent` → `{ attested: boolean; uploadId: string | null;
    attestationVersion: string | null }`.
  - `WithholdEvidence` first member → `{ reason: 'no_consent'; upload_id: string | null;
    attestation_version: string | null }` (§6.1 — case (a) both null: no row; case (b)
    both populated: row exists, version not send-eligible).
  - `evaluateAsk`'s branch returns
    `{ …envelope, decision: 'withhold', reason: 'no_consent', upload_id:
    candidate.consent.uploadId, attestation_version: candidate.consent.attestationVersion }`.
  - `RESTRAINT_POLICY_VERSION = 'restraint_v_watch_2026-07-23.3'` with a doc-comment
    line following the `.2` precedent: `.3` (#620 §6.2) — no_consent gains discriminating
    power (ledger + allowlist derivation) and the evidence serialization changed; a
    candidate deciding send under `.2` can decide withhold/no_consent under `.3`.
  - Update the header's v-watch footnote (lines ~19–22): `no_consent` CAN now fire —
    the tautology note describes the pre-#625 world; rewrite to point at the ledger.
- [ ] **Step 3: `batch-builder.ts`:**
  - Replace the `consent_attested` expression in `loadCandidateWindow` with a LEFT JOIN
    (import `SEND_ELIGIBLE_ATTESTATION_VERSIONS` from `./attestation`):

```sql
    LEFT JOIN solicitation_consent consent
      ON consent.channel = 'email'
     AND consent.normalized_handle = c.email
     AND consent.business_id = ${businessId}::uuid
```
  and in the SELECT list:
```sql
      (consent.id IS NOT NULL
        AND consent.attestation_version = ANY(${sendEligibleVersions}::text[])
      ) AS consent_attested,
      consent.source_upload_id::text AS consent_upload_id,
      consent.attestation_version AS consent_attestation_version
```
  with `const sendEligibleVersions = [...SEND_ELIGIBLE_ATTESTATION_VERSIONS]` bound as
  a parameter. Drop the now-unused `u.attested_at/attestation_version` conjuncts (keep
  the `u` join — it still scopes `latest_visit` to completed uploads). The old
  `upload_id AS upload_id` column stays for other uses only if referenced; `toCandidate`
  now maps `consent: { attested: row.consent_attested, uploadId: row.consent_upload_id,
  attestationVersion: row.consent_attestation_version }`. Update `CandidateWindowRow`.
- [ ] **Step 4: `batch-view.ts` `parseEvidence`** — accept the widened `no_consent`
  evidence (nullable `upload_id`, nullable `attestation_version`); a non-object or
  discriminant-less value still throws (existing posture).
- [ ] **Step 5: Failing integration tests** (batch-builder.integration.test.ts):
  - **"consent_attested is no longer a tautology: a contact covered only by
    consent_attestation_v1 yields attested: false"** — ingest under v1, build the
    batch, assert the ask is `withhold`/`no_consent` **case (b)** (`upload_id` and
    `attestation_version` populated). The §1.1 regression test.
  - **"the §1.2 re-upload trap end-to-end: after a v2 re-upload the contact is
    send-eligible"** — continue the same fixture: re-ingest under v2, rebuild, assert
    the decision is `send` (or withheld by a LATER precedence reason only — pick fixture
    dates so it is a clean `send`).
  - **"tenant scope: a consent row at business A does not make the same handle
    eligible at business B in the same account"** — same handle ingested at A under
    v2; a v1-era row at B; assert B's candidate withholds `no_consent`.
  - **"evidence shape: both no_consent cases round-trip through parseEvidence and
    satisfy migration 090's CHECK"** — persist one case-(a) and one case-(b) ask via
    the real writer, read back through the batch view, assert fields; the 090 CHECK is
    exercised by the INSERT succeeding.
- [ ] **Step 6: Run everything** — unit + integration (`TEST_DATABASE_POOL_URL` set).
- [ ] **Step 7: Commit** — `feat(#625): consent derivation via ledger + allowlist; policy .3`.

---

### Task 5: Contact delete sweeps consent (by handle, same tx)

**Files:**
- Modify: `src/lib/solicitation/contacts-repo.ts` (`deleteContact`)
- Test: `src/lib/solicitation/__tests__/contacts-repo.integration.test.ts` (extend)

**Why explicit:** no FK links consent to contacts (handle-keyed by design, §3.2); a
missing sweep is SILENT — the stale row grants consent on a future re-upload of the
same handle (§7.1). Contract-tested for exactly that.

- [ ] **Step 1: Failing integration test:** **"contact delete sweeps consent rows by
  handle; re-uploading after delete requires a fresh attestation"** — ingest a contact
  under v2 (consent row exists), `deleteContact`, assert the consent row is gone; then
  re-ingest the same handle and assert the NEW consent row derives from the new
  upload's attestation (fresh `source_upload_id`), i.e. the stale row did not survive
  to grant consent the owner did not re-give. Also assert a sibling contact at the
  same business is untouched.
- [ ] **Step 2: Implement** — `deleteContact` becomes one transaction; sweep matches
  the deleted contact's stored (already-normalized) email across ALL channels for that
  handle at that business:

```ts
export async function deleteContact(
  sql: Sql,
  accountId: string,
  businessId: string,
  contactId: string,
): Promise<boolean> {
  return sql.begin(async (tx) => {
    const deleted = await tx<{ id: string; email: string | null }[]>`
      DELETE FROM solicitation_contacts c
      USING businesses b
      WHERE c.id = ${contactId}
        AND c.business_id = ${businessId}
        AND b.id = c.business_id
        AND b.account_id = ${accountId}
      RETURNING c.id, c.email
    `;
    const [row] = deleted;
    if (row === undefined) return false;
    // §7.1: consent fails closed (DR1) — a retained row would be a residual record
    // of a deleted person AND would silently grant consent on a future re-upload of
    // the same handle. No FK reaches solicitation_consent, so this sweep is the only
    // deleter. Handle-wide (all channels), matching the contact's stored normalized email.
    if (row.email !== null) {
      await tx`
        DELETE FROM solicitation_consent
        WHERE normalized_handle = ${row.email}
          AND business_id = ${businessId}
      `;
    }
    return true;
  });
}
```

- [ ] **Step 3: Run** contacts-repo integration suite (PASS) + `rg -n "deleteContact("
  src/ worker/` to confirm no caller depended on the single-statement shape.
- [ ] **Step 4: Commit** — `feat(#625): contact hard-delete sweeps consent rows by handle`.

---

### Task 6: Offboarding disposition entry

**Files:**
- Modify: `src/lib/account-offboarding/table-disposition.ts`
- Test: whichever existing suite pins `TABLE_DISPOSITIONS` completeness (find via
  `rg -l "TABLE_DISPOSITIONS" src/lib/account-offboarding/__tests__/`) — extend its
  expectations; the purge-verification machinery derives from the entry.

- [ ] **Step 1: Failing test** (the completeness/verification suite red-bars on the
  new table once the expectation list gains it).
- [ ] **Step 2: Add the entry** next to the other solicitation tables (§7.2):

```ts
  {
    table: 'solicitation_consent',
    disposition: 'hard_delete',
    scopeEvidence: 'direct_business_id',
    purgeVerification: 'must_be_absent',
    reason: 'Consent fails closed (DR1): ledger rows are residual records of owner-uploaded customers and leave with the business via the businesses(id) cascade.',
  },
```

- [ ] **Step 3: Run** the account-offboarding suites; if a live-DB purge-verification
  suite exists, run it with `TEST_DATABASE_POOL_URL` set.
- [ ] **Step 4: Commit** — `feat(#625): solicitation_consent offboarding disposition`.

---

### Task 7: Gate + bookkeeping sweep

- [ ] **Step 1:** Confirm NO new JSONB parse sites were introduced (the ledger has no
  JSONB column) — the CLAUDE.md carve-out list needs no change. Confirm no env vars
  added (env-vars.md untouched, §8.3).
- [ ] **Step 2:** `bash scripts/verify-gate.sh` in the worktree — full green required
  (lint, typecheck, test, every `ci:*` audit incl. `ci:tenant-scope`, `ci:rls-audit`,
  promised-tests row against the intake's `tests_to_add`).
- [ ] **Step 3:** Fix anything red; re-run. Commit any residue.

---

## Self-review notes (spec coverage)

- §2 (v2 + allowlist) → Task 2. §3 (schema) → Task 1. §4 (write path) → Task 3.
- §6.1/§6.2 (derivation, evidence, `.3`) → Task 4. §7.1 → Task 5. §7.2 → Task 6.
- §7.3 (no TTL) → nothing to build; recorded in migrations-log retention row (Task 1).
- §8.1 events → Task 3 (two of three; third deferred to #630 with test 7 — map-owner
  decision). §8.2 (never log the handle) → honored in Tasks 3/5 (ids only). §8.3 → Task 7.
- Spec §10 tests: 1→T4, 2→T3+T4, 3→T3, 4→T4, 5→T5, 6→T4 (pure), 7→deferred (#630),
  8→T4, 9→T3. Intake's added idempotency test →T3.
