# Contacts/Visits CSV Ingestion + Consent Attestation (#541) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owner-uploaded Contacts/visits CSV ingestion with per-upload blocking Consent attestation per the locked #535 contract (`docs/superpowers/specs/2026-07-23-contacts-csv-contract-design.md`).

**Architecture:** A Next.js route persists the upload row (raw CSV + attestation) and a `csv_ingest` outbox row in ONE transaction (invariants #1/#2); the Railway worker parses, validates, matches/merges, and upserts **Contact** + **Visit** rows, then writes the terminal report and NULLs the raw CSV in ONE transaction. All domain logic lives in deep modules under `src/lib/solicitation/` taking `sql`/`tx` as an explicit parameter (invariant #15). Everything is gated by server-authoritative `SOLICITATION_WATCH_ENABLED` (default OFF; #544 flips staging).

**Tech Stack:** Postgres.js transactions, BullMQ via `QUEUE_NAMES`/outbox, Next.js App Router, Vitest.

**Intake contract:** `docs/superpowers/plans/feat-541-contacts-csv-intake.json` — its `allowed_edit_surface`, `tests_to_add` (titles VERBATIM), and glossary terms bind every task. Glossary (CONTEXT.md "Solicitation contacts & visits", use verbatim): **Contact**, **Visit**, **Normalized handle**, **Consent attestation**.

**Non-goals (do NOT build):** `solicitation_batches` INSERT / `build_solicitation_batch` trigger (#543 extends the completion tx later), batch UI (#544), suppression ledger, per-row consent columns, upload-undo, any send path.

---

## Codex plan-review triage (round 1, 2026-07-24)

Findings 1–7, 9, 11, 12: ACCEPTED and folded into the tasks below (tightened
terminal CHECK; failed-hook terminalizer; per-business advisory xact lock;
idempotency wording; JSONB report guard + allowlist entry; business_id scoping
on status reads; contacts drop account_id + composite visit FK; worker byte
re-check; letters reject in normalizePhone; worker derives gate from the
upload row + pairing assert).
Finding 8 REJECTED: double-submit duplicate uploads are by-design harmless —
contract §1.3/§2.2 makes overlapping re-uploads fully idempotent at the visit
level; the UI additionally disables submit while a request is in flight.
Finding 10 REJECTED: the deletes-via-upload-CASCADE scenario requires deleting
an upload row and no such code path exists (upload-undo is contractually
impossible); the CASCADE exists solely for offboarding sweep — now stated in
the migration comment.

Round 2: findings 1, 4–8, 12 verified resolved; both rejections upheld. Three
residual fixes folded in: failed-hook mirrors zernio ingest-failed-hook's
crash-safe shape with explicit `on('failed')` registration; failed-hook and
ingest both take the per-business advisory lock FIRST and re-read status under
it (terminalization can't race an in-flight retry); `ingestContactsCsvUpload`
signature corrected to `(sql, uploadId, expectedBusinessId)`.

## Task graph

| Task | Slice | Blocking edges |
|---|---|---|
| 1 | Migration 086 (three tables) + migrations-log entry | — |
| 2 | Pure kernel: normalized handles + CSV parse (TDD) | — |
| 3 | Wiring constants: attestation, flag, queue name, payload, enqueue helper | — |
| 4 | Upload lane: create-upload module + POST/GET routes | 1, 3 |
| 5 | Ingest lane: match/merge/upsert module + worker job + registration | 1, 2, 3 |
| 6 | Contacts read/delete: repo + routes | 1 |
| 7 | Dashboard page `/dashboard/contacts` | 4, 6 |
| 8 | Offboarding purge wiring | 1 |
| 9 | Docs registry sweep + full gate | 1–8 |

Every Bash command: `cd /Users/norbertesekiel/Developer/startups/RepWorth-worktrees/feat-541-contacts-csv && …`. All Edit/Write paths absolute into this worktree.

---

### Task 1: Migration 086 — `contact_csv_uploads`, `solicitation_contacts`, `solicitation_visits`

**Files:**
- Create: `supabase/migrations/086_solicitation_contacts.sql`
- Modify: `.claude/reference/migrations-log.md` (append entry; head becomes 086)

Before writing: invoke the `new-migration` skill and follow it (numbering, verification procedure). Style precedent: `supabase/migrations/084_competitor_snapshots.sql` (header comment states contract + concurrency reasoning; UUIDv7 PKs supplied by app code; RLS owner-read-only via `owner_account_id()`).

- [ ] **Step 1: Write the migration**

```sql
-- 086_solicitation_contacts.sql
-- Contacts/visits CSV ingestion + consent attestation (#541, map #528;
-- contract locked in #535: docs/superpowers/specs/2026-07-23-contacts-csv-contract-design.md).
--
-- Contact = deduped identity of one person at one location, keyed
-- (business_id, normalized handle) — enforced as TWO partial unique indexes
-- (email, phone) because either handle identifies the contact (§1.2).
-- Visit = append-only ledger row unique on (contact_id, visit_date) (§1.3):
-- re-uploads are idempotent by construction.
-- contact_csv_uploads.raw_csv exists only for transport: the worker NULLs it
-- in the SAME transaction that writes the terminal report (§3). Metadata
-- (filename, byte_size, content_sha256, counts, report, attestation) is kept.
-- Consent attestation is per-upload (§4): attesting user + timestamp +
-- versioned attestation-text constant. NO per-row consent columns (counsel).
-- All deletes are hard deletes with CASCADE (§5); offboarding purge sweeps
-- all three tables (table-disposition entries ride this PR).
-- RLS: owner read-only, mirroring competitor_snapshots (084). All writes come
-- from the Railway worker / server routes over the direct Postgres connection.

CREATE TABLE IF NOT EXISTS contact_csv_uploads (
  id UUID PRIMARY KEY,                 -- UUIDv7 supplied by the route
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  content_sha256 TEXT NOT NULL,
  raw_csv TEXT,                        -- NULLed at terminal state (§3)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'completed', 'failed')),
  report JSONB,                        -- terminal ingest report (§3)
  attested_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attested_at TIMESTAMPTZ NOT NULL,
  attestation_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  -- Terminal state carries a report and no raw CSV; pending carries the raw
  -- CSV and no report. A pending row without raw_csv is unprocessable and
  -- unrepresentable (codex plan-review finding 1).
  CONSTRAINT contact_csv_uploads_terminal_consistency CHECK (
    (status = 'pending' AND report IS NULL AND completed_at IS NULL
     AND raw_csv IS NOT NULL)
    OR (status IN ('completed', 'failed') AND report IS NOT NULL
        AND completed_at IS NOT NULL AND raw_csv IS NULL)
  )
);
-- NOTE: contact/visit FKs below CASCADE from this table. There is NO
-- individual-upload delete path anywhere in the app (upload-undo is
-- contractually impossible, #535 §1.3) — the CASCADE exists solely so
-- account/business offboarding deletion sweeps cleanly.

CREATE INDEX IF NOT EXISTS idx_contact_csv_uploads_business
  ON contact_csv_uploads (business_id, created_at DESC);

-- Contacts are BUSINESS-scoped only: businesses.account_id is the single
-- authoritative owner of the business→account pairing (codex finding 7 —
-- a denormalized account_id here could drift from it). Account-level
-- queries (RLS, offboarding purge) join through businesses.
CREATE TABLE IF NOT EXISTS solicitation_contacts (
  id UUID PRIMARY KEY,                 -- UUIDv7 supplied by the worker
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,                          -- Normalized handle: lowercased/trimmed
  phone TEXT,                          -- Normalized handle: E.164
  created_by_upload_id UUID NOT NULL REFERENCES contact_csv_uploads(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT solicitation_contacts_handle_present CHECK (email IS NOT NULL OR phone IS NOT NULL),
  -- Composite-FK target so visits are provably same-location as their contact.
  CONSTRAINT solicitation_contacts_id_business_uniq UNIQUE (id, business_id)
);

-- Partial unique indexes enforce (business_id, normalized handle) identity
-- (§1.1). Ingest NEVER writes ON CONFLICT against these (the per-business
-- advisory lock in Task 5 serializes read-then-write instead), so the
-- byte-for-byte ON CONFLICT/predicate gotcha does not apply here.
CREATE UNIQUE INDEX IF NOT EXISTS solicitation_contacts_email_uniq
  ON solicitation_contacts (business_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS solicitation_contacts_phone_uniq
  ON solicitation_contacts (business_id, phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS solicitation_visits (
  id UUID PRIMARY KEY,                 -- UUIDv7 supplied by the worker
  contact_id UUID NOT NULL,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  visit_date DATE NOT NULL,
  note TEXT,
  upload_id UUID NOT NULL REFERENCES contact_csv_uploads(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT solicitation_visits_contact_date_uniq UNIQUE (contact_id, visit_date),
  -- Composite FK: a visit can only reference a contact at the SAME location
  -- (codex finding 7 — DB-enforced tenant integrity, not just app-enforced).
  CONSTRAINT solicitation_visits_contact_business_fk
    FOREIGN KEY (contact_id, business_id)
    REFERENCES solicitation_contacts (id, business_id) ON DELETE CASCADE
);

ALTER TABLE contact_csv_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE solicitation_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE solicitation_visits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_csv_uploads_owner_select ON contact_csv_uploads;
CREATE POLICY contact_csv_uploads_owner_select ON contact_csv_uploads
  FOR SELECT TO authenticated
  USING (account_id = owner_account_id());

DROP POLICY IF EXISTS solicitation_contacts_owner_select ON solicitation_contacts;
CREATE POLICY solicitation_contacts_owner_select ON solicitation_contacts
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id()));

DROP POLICY IF EXISTS solicitation_visits_owner_select ON solicitation_visits;
CREATE POLICY solicitation_visits_owner_select ON solicitation_visits
  FOR SELECT TO authenticated
  USING (business_id IN (SELECT id FROM businesses WHERE account_id = owner_account_id()));
```

- [ ] **Step 2: Append the migrations-log entry** (follow the file's existing entry format: number, date, tables, key semantics, applied-to columns left unticked — application happens at ship time, staging first).
- [ ] **Step 3: Run `pnpm ci:rls-audit && pnpm ci:tenant-scope`** — expect PASS (audits read migrations).
- [ ] **Step 4: Commit** `feat(#541): migration 086 — contacts/visits/uploads tables`

---

### Task 2: Pure kernel — Normalized handles + CSV parser (TDD)

**Files:**
- Create: `src/lib/solicitation/handles.ts`
- Create: `src/lib/solicitation/contacts-csv.ts`
- Test: `src/lib/solicitation/__tests__/handles.test.ts`
- Test: `src/lib/solicitation/__tests__/contacts-csv.test.ts`

Both modules are PURE (no DB, no clock reads — "today" arrives as a parameter, mirroring `restraint-policy.ts`'s documented no-clock convention).

- [ ] **Step 1: Write failing tests** for `handles.ts`, titles VERBATIM from intake:
  - `normalizes a 10-digit US phone to E.164`
  - `lowercases and trims email handles`

```typescript
import { describe, expect, it } from 'vitest';
import { normalizeEmail, normalizePhone } from '../handles';

describe('normalizePhone', () => {
  it('normalizes a 10-digit US phone to E.164', () => {
    expect(normalizePhone('(415) 555-2671')).toBe('+14155552671');
    expect(normalizePhone('415.555.2671')).toBe('+14155552671');
  });
  it('keeps an existing E.164 number', () => {
    expect(normalizePhone('+442071838750')).toBe('+442071838750');
  });
  it('accepts 11 digits with a leading 1 as US', () => {
    expect(normalizePhone('14155552671')).toBe('+14155552671');
  });
  it('returns null for an unparseable phone', () => {
    expect(normalizePhone('call the desk')).toBeNull();
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('ext. 4155552671')).toBeNull();  // letters reject
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims email handles', () => {
    expect(normalizeEmail('  Ada.Lovelace@Example.COM ')).toBe('ada.lovelace@example.com');
  });
  it('returns null for implausible syntax', () => {
    expect(normalizeEmail('not-an-email')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests, verify FAIL** (`pnpm vitest run src/lib/solicitation/__tests__/handles.test.ts`).
- [ ] **Step 3: Implement `handles.ts`**

```typescript
/**
 * Normalized handle — the canonical Contact identifier (#535 contract §1.1/§6).
 * Computed ONCE at CSV ingest and stored; every downstream join (dedupe, the
 * future suppression ledger) is a plain equality on the stored value. The
 * suppression ledger keys on the normalized handle per channel, NEVER on
 * contact_id — delete + re-upload must not un-suppress an opted-out person.
 */

const EMAIL_PLAUSIBLE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Lowercased/trimmed email, or null when syntax is implausible. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > 320 || !EMAIL_PLAUSIBLE.test(email)) return null;
  return email;
}

/** E.164 phone (10-digit numbers assume US), or null when unparseable.
 *  Letters anywhere reject (codex finding 11): silently normalizing
 *  "ext. 4155552671"-style junk would mint a wrong handle; a visible
 *  invalid_phone row in the report is safer than a wrong identity. */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || /[a-z]/i.test(trimmed)) return null;
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (hasPlus) {
    if (digits.length < 8 || digits.length > 15) return null;
    return `+${digits}`;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}
```

- [ ] **Step 4: Run tests, verify PASS. Commit** `feat(#541): normalized-handle kernel`
- [ ] **Step 5: Write failing tests** for `contacts-csv.ts`, intake titles VERBATIM:
  - `rejects a future last_visit_date with future_date`
  - `accepts both YYYY-MM-DD and MM/DD/YYYY visit dates`
  - `ignores unknown columns and matches header aliases case-insensitively`
  - `rejects the whole file when a required header is missing`
  - `rejects the whole file when data rows exceed the 5,000-row cap`
  Plus: `missing_name`, `missing_handle`, `invalid_email`, `invalid_phone`, `invalid_date`, `note_too_long` row-rejection cases, and an empty-file structural case.

```typescript
import { describe, expect, it } from 'vitest';
import { parseContactsCsv, MAX_DATA_ROWS, MAX_NOTE_LENGTH } from '../contacts-csv';

const TODAY = '2026-07-24';

function csv(lines: string[]): string {
  return lines.join('\n');
}

describe('parseContactsCsv', () => {
  it('parses a valid row into a normalized candidate', () => {
    const result = parseContactsCsv(csv([
      'name,email,phone,last_visit_date,note',
      'Ada Lovelace,Ada@Example.com,(415) 555-2671,2026-07-01,Regular',
    ]), TODAY);
    expect(result).toMatchObject({
      candidates: [{
        rowIndex: 1,
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: '+14155552671',
        visitDate: '2026-07-01',
        note: 'Regular',
      }],
      rejected: [],
    });
  });

  it('accepts both YYYY-MM-DD and MM/DD/YYYY visit dates', () => {
    const result = parseContactsCsv(csv([
      'name,email,last_visit_date',
      'A,a@example.com,2026-07-01',
      'B,b@example.com,07/01/2026',
    ]), TODAY);
    if ('structuralFailure' in result) throw new Error('unexpected structural failure');
    expect(result.candidates.map((c) => c.visitDate)).toEqual(['2026-07-01', '2026-07-01']);
  });

  it('rejects a future last_visit_date with future_date', () => {
    const result = parseContactsCsv(csv([
      'name,email,last_visit_date',
      'A,a@example.com,2026-08-01',
    ]), TODAY);
    if ('structuralFailure' in result) throw new Error('unexpected structural failure');
    expect(result.rejected).toEqual([{ row: 1, reason: 'future_date' }]);
  });

  it('ignores unknown columns and matches header aliases case-insensitively', () => {
    const result = parseContactsCsv(csv([
      'Customer Name,E-Mail,POS Terminal,Last Visit',
      'Ada,ada@example.com,7,2026-07-01',
    ]), TODAY);
    if ('structuralFailure' in result) throw new Error('unexpected structural failure');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.name).toBe('Ada');
  });

  it('rejects the whole file when a required header is missing', () => {
    const result = parseContactsCsv(csv(['email,phone', 'a@example.com,+14155552671']), TODAY);
    expect(result).toEqual({ structuralFailure: 'missing_required_header' });
  });

  it('rejects the whole file when data rows exceed the 5,000-row cap', () => {
    const rows = Array.from({ length: MAX_DATA_ROWS + 1 }, (_, i) => `P${i},p${i}@example.com,2026-07-01`);
    const result = parseContactsCsv(csv(['name,email,last_visit_date', ...rows]), TODAY);
    expect(result).toEqual({ structuralFailure: 'row_count_over_cap' });
  });

  it('rejects rows per the closed rejection enum', () => {
    const result = parseContactsCsv(csv([
      'name,email,phone,last_visit_date,note',
      ',a@example.com,,2026-07-01,',                    // missing_name
      'B,,,2026-07-01,',                                // missing_handle
      'C,not-an-email,,2026-07-01,',                    // invalid_email
      'D,,12345,2026-07-01,',                           // invalid_phone
      'E,e@example.com,,yesterday,',                    // invalid_date
      `F,f@example.com,,2026-07-01,${'x'.repeat(MAX_NOTE_LENGTH + 1)}`, // note_too_long
    ]), TODAY);
    if ('structuralFailure' in result) throw new Error('unexpected structural failure');
    expect(result.rejected).toEqual([
      { row: 1, reason: 'missing_name' },
      { row: 2, reason: 'missing_handle' },
      { row: 3, reason: 'invalid_email' },
      { row: 4, reason: 'invalid_phone' },
      { row: 5, reason: 'invalid_date' },
      { row: 6, reason: 'note_too_long' },
    ]);
  });

  it('rejects an empty file structurally', () => {
    expect(parseContactsCsv('', TODAY)).toEqual({ structuralFailure: 'missing_required_header' });
  });
});
```

- [ ] **Step 6: Run tests, verify FAIL.**
- [ ] **Step 7: Implement `contacts-csv.ts`.** Interface (everything a caller must know):

```typescript
/**
 * Contacts CSV parser (#535 contract §2) — the pure ingest kernel.
 * Validates SYNTAX only: staleness is the restraint policy's judgment, never
 * ingest's (§2 "Ingestion validates syntax; policy judges").
 * `todayUtc` (YYYY-MM-DD) arrives as a parameter — no clock reads here
 * (restraint-policy.ts convention), so identical inputs parse identically.
 *
 * NOTE on the private RFC-4180 tokenizer below: src/lib/admin/csv-import.ts
 * has its own private tokenizer (parseCsvRecords). Deliberate containment:
 * exporting it cross-domain is outside this ticket's edit surface; a shared
 * extraction is proposed as a follow-up (see PR description).
 */

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_DATA_ROWS = 5000;
export const MAX_NOTE_LENGTH = 500;

export const ROW_REJECTION_REASONS = [
  'missing_name', 'missing_handle', 'invalid_email', 'invalid_phone',
  'invalid_date', 'future_date', 'ambiguous_identity', 'note_too_long',
] as const;
export type RowRejectionReason = (typeof ROW_REJECTION_REASONS)[number];

export const STRUCTURAL_FAILURES = [
  'missing_required_header', 'row_count_over_cap', 'byte_size_over_cap', 'undecodable_encoding',
] as const;
export type StructuralFailure = (typeof STRUCTURAL_FAILURES)[number];

export interface ContactCandidate {
  rowIndex: number;            // 1-based data-row number (header excluded)
  name: string;
  email: string | null;        // Normalized handle or null
  phone: string | null;        // Normalized handle or null
  visitDate: string;           // canonical YYYY-MM-DD
  note: string | null;
}

export interface RejectedRow { row: number; reason: RowRejectionReason; }

export type ParseContactsCsvResult =
  | { candidates: ContactCandidate[]; rejected: RejectedRow[] }
  | { structuralFailure: StructuralFailure };

export function parseContactsCsv(csvText: string, todayUtc: string): ParseContactsCsvResult
```

Implementation requirements (all covered by Step 5 tests):
  - Private RFC-4180 tokenizer (quoted fields, CRLF/LF, escaped quotes) — mirror the shape of `parseCsvRecords` in `src/lib/admin/csv-import.ts:142` without importing it. Strip a UTF-8 BOM if present. A U+FFFD replacement character anywhere in `csvText` → `{ structuralFailure: 'undecodable_encoding' }` (the route decodes bytes; broken decoding surfaces as U+FFFD).
  - Header aliases, matched lowercased/trimmed: `name` ← `name | customer name | customer | full name | client name`; `email` ← `email | email address | e-mail`; `phone` ← `phone | phone number | mobile | cell | telephone`; `last_visit_date` ← `last_visit_date | last visit date | last visit | visit date | date`; `note` ← `note | notes | job | job note | staff note | details | detail`. Required headers: `name`, `last_visit_date`, and at least one of `email`/`phone` → else `missing_required_header`. Unknown columns ignored.
  - Row validation order (first failure wins): empty name → `missing_name`; both handles empty → `missing_handle`; non-empty email failing `normalizeEmail` → `invalid_email`; non-empty phone failing `normalizePhone` → `invalid_phone`; date failing both formats or not a real calendar date → `invalid_date`; date > `todayUtc` → `future_date`; note longer than `MAX_NOTE_LENGTH` → `note_too_long`.
  - Date parsing: `YYYY-MM-DD` or `MM/DD/YYYY` → canonical `YYYY-MM-DD`; validate as a real calendar date by string round-trip (no `Date` timezone pitfalls: build `new Date(Date.UTC(y, m-1, d))` and compare components).
  - `ambiguous_identity` is NOT produced here — it is a DB-match decision (Task 5). It lives in the enum because the report unions both sources.
  - More than `MAX_DATA_ROWS` data rows → `row_count_over_cap`. (`byte_size_over_cap` is produced by the route/ingest bounds check, not the parser — the constant lives here as the single owner.)

- [ ] **Step 8: Run tests, verify PASS. Run `pnpm lint && pnpm typecheck`. Commit** `feat(#541): contacts CSV parse kernel`

---

### Task 3: Wiring constants — attestation, flag, topic, payload, enqueue helper

**Files:**
- Create: `src/lib/solicitation/attestation.ts`
- Create: `src/lib/solicitation/flags.ts`
- Modify: `src/lib/shared/queue-names.ts` (add `CSV_INGEST: 'csv_ingest'`)
- Modify: `src/lib/shared/worker-types.ts` (add `CsvIngestPayload`)
- Modify: `src/lib/shared/job-outbox-helpers.ts` (add `enqueueCsvIngest`)
- Test: `src/lib/shared/__tests__/job-outbox-helpers.test.ts` (extend)

- [ ] **Step 1: `attestation.ts`**

```typescript
/**
 * Consent attestation text — versioned code constant (#535 contract §4).
 * Engineering placeholder until counsel reviews; changing the wording MUST
 * bump CONSENT_ATTESTATION_VERSION. The version string is stored on every
 * upload row: "which attestation covers this person" is a query, not a guess.
 */
export const CONSENT_ATTESTATION_VERSION = 'consent_attestation_v1' as const;

export const CONSENT_ATTESTATION_TEXT =
  'I confirm these are real customers of this business who provided their ' +
  'contact information directly to us, and that I am authorized to upload ' +
  'their details for review-request evaluation. No review requests will be ' +
  'sent in watch-mode.' as const;
```

- [ ] **Step 2: `flags.ts`** (mirror `src/lib/reviews/flags.ts`)

```typescript
import { readFlag } from '@/lib/config/flags';

/** Solicitation watch-mode master switch (design §9.1 decision 4). Default off;
 *  staging flip rides #544 via the flag-flip skill. Gates the contacts upload
 *  surface (routes 404, page hidden) — server-authoritative, invariant #13. */
export function solicitationWatchEnabled(): boolean {
  return readFlag('SOLICITATION_WATCH_ENABLED');
}
```

- [ ] **Step 3: queue name + payload + helper.** In `queue-names.ts` add `CSV_INGEST: 'csv_ingest',` to `QUEUE_NAMES` (alphabetical-ish placement near other ingest topics). In `worker-types.ts` add:

```typescript
export interface CsvIngestPayload extends BasePayload {
  uploadId: string;
  businessId: string;
}
```

In `job-outbox-helpers.ts` add (mirror the smallest existing enqueue helper's exact INSERT shape, e.g. the pending-post-notice one — same columns, `tx.json` for payload, deterministic idempotency key with `_` separator per the BullMQ `:` gotcha):

```typescript
const AGGREGATE_TYPE_CONTACT_CSV_UPLOAD = 'contact_csv_upload';

export interface EnqueueCsvIngestInput {
  outboxId?: string;
  uploadId: string;
  businessId: string;
  correlationId?: string;
}

/** Enqueue csv_ingest in the SAME transaction that persists the upload row
 *  (invariant #2). Deterministic key: one ingest job per upload. */
export async function enqueueCsvIngest(tx: TxClient, input: EnqueueCsvIngestInput): Promise<string>
// INSERT INTO job_outbox (id, topic, aggregate_type, aggregate_id, payload, status, idempotency_key)
// VALUES (outboxId ?? uuidv7(), QUEUE_NAMES.CSV_INGEST, 'contact_csv_upload', uploadId,
//         tx.json({ uploadId, businessId, correlationId }), 'pending', `csv_ingest_${uploadId}`)
// — copy the exact column list/ON CONFLICT semantics from the nearest existing helper in this file.
```

- [ ] **Step 4: Test** (intake title VERBATIM in Task 4's route test covers the tx pairing; here add to `job-outbox-helpers.test.ts`, mirroring its existing per-helper cases): `enqueueCsvIngest writes a csv_ingest outbox row with the deterministic idempotency key`.
- [ ] **Step 5: Run `pnpm vitest run src/lib/shared/__tests__/job-outbox-helpers.test.ts && pnpm ci:outbox-topics && pnpm typecheck`** — expect PASS.
- [ ] **Step 6: Commit** `feat(#541): csv_ingest topic, payload, attestation + flag constants`

---

### Task 4: Upload lane — create-upload module + POST/GET routes

**Files:**
- Create: `src/lib/solicitation/uploads.ts`
- Create: `src/app/api/dashboard/contacts/uploads/route.ts` (POST)
- Create: `src/app/api/dashboard/contacts/uploads/[id]/route.ts` (GET status/report)
- Test: `src/lib/solicitation/__tests__/uploads.test.ts`
- Test: colocated route tests only if the neighboring dashboard routes have them (mirror; otherwise module tests carry the logic)

Precedents to READ first: `src/app/api/dashboard/kpis/route.ts` (auth via `withDashboardOwnerRead`, subscription gate, `errorResponse`/`jsonResponse`); `src/app/api/admin/locations/csv-import/route.ts` (multipart file receipt + size precheck); `src/app/api/dashboard/policy.ts` (location resolution). Routes parse input, call ONE module function, return output (repworth.md) — every branch of logic lives in `uploads.ts`.

- [ ] **Step 1: Failing module tests** (DB-free: transaction mocked with the same stub style used in `src/lib/shared/__tests__/job-outbox-helpers.test.ts`; if that style is a live-DB integration suite, follow it and mark the file `.integration.test.ts`). Intake titles VERBATIM:
  - `upload route rejects when the attestation is not accepted`
  - `upload route persists the upload row and csv_ingest outbox row in one transaction`
- [ ] **Step 2: Implement `uploads.ts`**

```typescript
import { createHash } from 'node:crypto';   // invariant #10: node:crypto only
import { v7 as uuidv7 } from 'uuid';
import type { Sql, TransactionSql } from 'postgres';
import { MAX_UPLOAD_BYTES } from './contacts-csv';
import { CONSENT_ATTESTATION_VERSION } from './attestation';
import { enqueueCsvIngest } from '@/lib/shared/job-outbox-helpers';

export type CreateUploadResult =
  | { ok: true; uploadId: string }
  | { ok: false; error: 'attestation_required' | 'file_too_large' | 'empty_file' };

/** Persists the upload row (raw CSV + Consent attestation) AND the csv_ingest
 *  outbox row in ONE transaction (invariants #1/#2). The route has already
 *  authenticated the owner and resolved businessId to their account. */
export async function createContactsCsvUpload(sql: Sql, input: {
  accountId: string; businessId: string; attestedByUserId: string;
  attestationAccepted: boolean; filename: string; csvText: string;
}): Promise<CreateUploadResult> {
  if (!input.attestationAccepted) return { ok: false, error: 'attestation_required' };
  const byteSize = Buffer.byteLength(input.csvText, 'utf8');
  if (byteSize === 0) return { ok: false, error: 'empty_file' };
  if (byteSize > MAX_UPLOAD_BYTES) return { ok: false, error: 'file_too_large' };
  const uploadId = uuidv7();
  const sha256 = createHash('sha256').update(input.csvText).digest('hex');
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO contact_csv_uploads
        (id, account_id, business_id, filename, byte_size, content_sha256,
         raw_csv, status, attested_by_user_id, attested_at, attestation_version)
      VALUES
        (${uploadId}, ${input.accountId}, ${input.businessId}, ${input.filename},
         ${byteSize}, ${sha256}, ${input.csvText}, 'pending',
         ${input.attestedByUserId}, NOW(), ${CONSENT_ATTESTATION_VERSION})
    `;
    await enqueueCsvIngest(tx as TransactionSql, {
      uploadId, businessId: input.businessId,
    });
  });
  return { ok: true, uploadId };
}

/** Tenant-scoped status/report read (never returns raw_csv). Scoped by BOTH
 *  account_id AND business_id (codex finding 6 — per-location data,
 *  invariant #8): the route passes the business resolved from its location
 *  context, so a location-scoped user cannot read another location's upload. */
export async function getUploadStatus(sql: Sql, accountId: string, businessId: string,
  uploadId: string): Promise<{
  id: string; status: string; filename: string; createdAt: string;
  completedAt: string | null; report: IngestReport | null;
} | null>
// SELECT id, status, filename, created_at, completed_at, report
// FROM contact_csv_uploads
// WHERE id = ${uploadId} AND account_id = ${accountId} AND business_id = ${businessId}
// `report` is a production JSONB field-to-parser site (PgBouncer may return it
// as a string): guard with `typeof report === 'string' ? JSON.parse(report) : report`
// then narrow to IngestReport. This is a NEW entry for the CLAUDE.md JSONB
// allowlist — .claude/CLAUDE.md must be amended in the SAME change (surface
// amendment approved at plan sign-off; see plan header note).
```

- [ ] **Step 3: Implement routes.** POST: flag check first (`solicitationWatchEnabled()` false → 404 via `errorResponse('Not found', 404)`); owner auth (mirror kpis route's `withDashboardOwnerRead` — if a write-flavored wrapper exists in `policy.ts`, use it); subscription gate mirroring kpis (`subscriptionAllowsDashboardRead` equivalent for writes — mirror what the nearest owner-write dashboard route uses); validate `businessId` belongs to the account with an explicit `SELECT id FROM businesses WHERE id = ... AND account_id = ...` (this pairing is app-enforced at write time — the uploads table denormalizes both ids, so this SELECT is the integrity gate; comment it); read `formData()` file + `attestationAccepted === 'true'` + `businessId`; enforce `MAX_UPLOAD_BYTES` BEFORE buffering into a string where the precedent admin route does; call `createContactsCsvUpload`; map `attestation_required` → 400, `file_too_large` → 413, `empty_file` → 400. GET `[id]`: flag check → 404; owner auth; resolve the location context to a `businessId` exactly as kpis does; `getUploadStatus(sql, accountId, businessId, uploadId)`; null → 404.
- [ ] **Step 4: Intake title VERBATIM** — `contacts API routes return 404 when SOLICITATION_WATCH_ENABLED is off`: one test file covering POST + both GETs (this task's two, Task 6 extends it), flag unset via `vi.stubEnv`.
- [ ] **Step 5: Run suite + `pnpm lint && pnpm typecheck`. Commit** `feat(#541): upload lane — create-upload tx + routes`

---

### Task 5: Ingest lane — match/merge/upsert module + worker job + registration

**Files:**
- Create: `src/lib/solicitation/ingest.ts`
- Create: `worker/jobs/csv-ingest/index.ts`
- Create: `worker/jobs/csv-ingest/failed-hook.ts` (retry-exhaustion terminalizer — see Step 5)
- Modify: `worker/queues.ts` (Queue instance + `topicToQueue['csv_ingest']`)
- Modify: `worker/index.ts` (Worker registration + emitter-error listener via `attachEmitterErrorLogger`, mirroring `judgeVerdictWorker`)
- Test: `src/lib/solicitation/__tests__/ingest.test.ts` (pure match kernel)
- Test: `src/lib/solicitation/__tests__/ingest.integration.test.ts` (live-DB, self-skips without `TEST_DATABASE_POOL_URL` — mirror an existing `*.integration.test.ts` harness, e.g. the governor scheduler's)

**The pure match kernel** (unit-tested without DB). Intake titles VERBATIM:
  - `rejects a row whose email and phone match two different contacts with ambiguous_identity`
  - `merges a missing handle into the matched contact`
  - `latest non-empty name wins on a matched contact`

- [ ] **Step 1: Failing kernel tests**

```typescript
import { describe, expect, it } from 'vitest';
import { resolveContactMatch } from '../ingest';

const X = { id: 'contact-x', name: 'Ada', email: 'ada@example.com', phone: null };
const Y = { id: 'contact-y', name: 'Bob', email: null, phone: '+14155552671' };

describe('resolveContactMatch', () => {
  it('creates a new contact when neither handle matches', () => {
    expect(resolveContactMatch(
      { name: 'Ada', email: 'ada@example.com', phone: null }, null, null,
    )).toEqual({ action: 'create' });
  });

  it('rejects a row whose email and phone match two different contacts with ambiguous_identity', () => {
    expect(resolveContactMatch(
      { name: 'Ada', email: 'ada@example.com', phone: '+14155552671' }, X, Y,
    )).toEqual({ action: 'reject', reason: 'ambiguous_identity' });
  });

  it('merges a missing handle into the matched contact', () => {
    const result = resolveContactMatch(
      { name: 'Ada', email: 'ada@example.com', phone: '+14155552671' }, X, null,
    );
    expect(result).toEqual({
      action: 'update', contactId: 'contact-x',
      set: { name: 'Ada', phone: '+14155552671' },
    });
  });

  it('latest non-empty name wins on a matched contact', () => {
    const result = resolveContactMatch(
      { name: 'Ada L.', email: 'ada@example.com', phone: null }, X, null,
    );
    expect(result).toEqual({
      action: 'update', contactId: 'contact-x', set: { name: 'Ada L.' },
    });
    const unchanged = resolveContactMatch(
      { name: '', email: 'ada@example.com', phone: null }, X, null,
    );
    expect(unchanged).toEqual({ action: 'update', contactId: 'contact-x', set: {} });
  });

  it('same contact matched by both handles is a plain update', () => {
    const both = { ...X, phone: '+14155552671' };
    expect(resolveContactMatch(
      { name: 'Ada', email: 'ada@example.com', phone: '+14155552671' }, both, both,
    )).toEqual({ action: 'update', contactId: 'contact-x', set: {} });
  });
});
```

- [ ] **Step 2: Verify FAIL, then implement.** `ingest.ts` interface:

```typescript
export interface ExistingContact { id: string; name: string; email: string | null; phone: string | null; }

export type ContactMatchDecision =
  | { action: 'create' }
  | { action: 'reject'; reason: 'ambiguous_identity' }
  | { action: 'update'; contactId: string; set: Partial<{ name: string; email: string; phone: string }> };

/** Pure §1.2 matching decision: byEmail/byPhone are the lookup results for the
 *  candidate's normalized handles (null when handle absent or no match).
 *  NEVER merges two existing contacts — distinct matches reject. */
export function resolveContactMatch(
  candidate: { name: string; email: string | null; phone: string | null },
  byEmail: ExistingContact | null,
  byPhone: ExistingContact | null,
): ContactMatchDecision

export interface IngestReport {
  contactsCreated: number; contactsMerged: number; visitsAdded: number;
  duplicateVisits: number; rejected: RejectedRow[];
  structuralFailure: StructuralFailure | null;
}

/** Worker-facing single entry point: loads the upload row, parses, matches,
 *  upserts Contacts + Visits, writes the terminal report AND NULLs raw_csv in
 *  ONE transaction. Idempotent: a retried job re-processing an upload finds
 *  visits/handles already present (visit unique key + handle merge are natural
 *  upserts) and terminal uploads (status != 'pending') no-op immediately. */
export async function ingestContactsCsvUpload(
  sql: Sql, uploadId: string, expectedBusinessId: string,
): Promise<IngestReport | null>
```

Implementation requirements for `ingestContactsCsvUpload`:
  - ALL work happens inside ONE `sql.begin` transaction whose FIRST two
    statements are (round-2 finding: lock BEFORE any status read):
    1. `SELECT pg_advisory_xact_lock(hashtext('csv_ingest_' || ${expectedBusinessId}))`
       — serializes concurrent ingests AND the failed-hook for the same
       business, so read-then-write matching cannot double-create a contact
       and terminalization cannot race an in-flight retry (plain `FOR UPDATE`
       can't cover not-yet-existing contact rows; the PgBouncer FOR-UPDATE
       gotcha doesn't apply because the lock is xact-scoped INSIDE sql.begin).
       Holding the lock across the whole ≤5,000-row transaction is the
       intended semantics: one ingest per business at a time, bounded by the
       row cap.
    2. THEN load the upload row (post-lock re-read — never trust a pre-lock
       peek). Missing → log + return null. `status != 'pending'` → return the
       stored report (idempotent retry / lost race against a concurrent run:
       both are the same no-op).
  - Assert `upload.business_id === expectedBusinessId` — mismatch is an
    impossible state (the route wrote both in one tx): `throw` with context.
  - `raw_csv IS NULL` while pending is unrepresentable (DB CHECK, Task 1) — `throw` with context if ever observed, don't branch around it.
  - Defensive bounds re-check (codex finding 9): `byte_size > MAX_UPLOAD_BYTES` → terminal-fail with `structuralFailure: 'byte_size_over_cap'` (the route already enforces it; a boundary re-check is one line).
  - Retried jobs re-read under the lock and take the update path — that is the idempotency mechanism (the contact INSERT itself is deliberately not an ON CONFLICT upsert; codex finding 4).
  - Compute `todayUtc` from `new Date().toISOString().slice(0, 10)` ONCE, pass to the parser.
  - Structural failure → in one tx: `UPDATE contact_csv_uploads SET status='failed', report=${tx.json(report)}, raw_csv=NULL, completed_at=NOW() WHERE id=...` (use `tx.json`, never `JSON.stringify(...)::jsonb`).
  - Otherwise process ALL candidates inside ONE `sql.begin` transaction: for each candidate, look up `byEmail`/`byPhone` (`SELECT ... WHERE business_id = ... AND email = ...` / `phone = ...`), apply `resolveContactMatch`; `create` → INSERT contact (uuidv7, `created_by_upload_id = uploadId`); `update` → UPDATE the non-empty `set` fields + `updated_at = NOW()` (skip UPDATE when `set` is `{}` and just use the id); `reject` → push `{row, reason}` onto the report. Then visit upsert:
    `INSERT INTO solicitation_visits (id, contact_id, business_id, visit_date, note, upload_id) VALUES (...) ON CONFLICT (contact_id, visit_date) DO UPDATE SET note = COALESCE(NULLIF(EXCLUDED.note, ''), solicitation_visits.note)` with `RETURNING (xmax = 0) AS inserted` to count `visitsAdded` vs `duplicateVisits` (xmax=0 ⇔ fresh insert; this is the one non-obvious SQL trick — comment it).
  - Same tx, after the loop: write report, `status='completed'`, `raw_csv=NULL`, `completed_at=NOW()`.
  - Bounded memory: 5,000-row cap makes whole-file in-memory processing fine (state the bound in a comment).
  - Logging via `createWorkerLogger('csv-ingest', correlationId)`: counts and reason histogram ONLY — never names/handles/notes (PII).
- [ ] **Step 3: Kernel tests PASS. Commit** `feat(#541): ingest kernel + module`
- [ ] **Step 4: Integration test** (live-DB; self-skip without `TEST_DATABASE_POOL_URL`). Intake titles VERBATIM:
  - `re-uploading an overlapping export adds no new visits and reports duplicate_visit`
  - `a non-empty note on a duplicate visit refreshes the stored note`
  - `partial accept: valid rows land while invalid rows are reported`
  - `clears raw CSV text in the same transaction as the terminal report`
  Seed account/business fixtures the way the existing integration suite does; run `ingestContactsCsvUpload` twice on overlapping CSVs; assert visit counts, note refresh, report contents, and `raw_csv IS NULL` + `status='completed'` after the first run.
- [ ] **Step 5: Worker job `worker/jobs/csv-ingest/index.ts`** (mirror `worker/jobs/judge/` handler shape + `withJobLogContext`):

```typescript
// Composition root: subscription gate + delegate to the ingest module.
// Invariant #11: gate on subscriptionGrantsFullAccess — pending_payment /
// cancelled accounts get no ingest work (their upload stays pending until
// resubscription re-upload; watch-mode sends nothing either way).
export async function handleCsvIngest(sql: Sql, job: Job<CsvIngestPayload>): Promise<void>
// 1. Derive the subscription gate FROM THE UPLOAD ROW, not the raw payload
//    (codex finding 12): SELECT u.business_id, a.subscription_status
//    FROM contact_csv_uploads u JOIN businesses b ON b.id = u.business_id
//    JOIN accounts a ON a.id = b.account_id WHERE u.id = payload.uploadId
// 2. missing upload/business → log warn, return (deleted mid-flight; nothing to do)
// 3. !subscriptionGrantsFullAccess(status) → log + return WITHOUT touching the upload
//    (no-op per invariant #11 — same posture as NotificationWorker)
// 4. await ingestContactsCsvUpload(sql, payload.uploadId, payload.businessId)

// ALSO create worker/jobs/csv-ingest/failed-hook.ts (codex finding 2; precedent:
// worker/jobs/zernio/ingest-failed-hook.ts — READ IT FIRST and mirror its
// crash-safe shape exactly: the hook owns its own error handling (log-and-
// swallow around Sentry/telemetry so a secondary failure can't crash the
// 'failed' listener), takes `sql` explicitly, and does all its work in one tx).
// Behavior on BullMQ retry EXHAUSTION, in ONE transaction that FIRST takes the
// SAME advisory lock (`pg_advisory_xact_lock(hashtext('csv_ingest_' ||
// businessId))`) and re-reads status under it — so terminalization can never
// race an in-flight retry (codex round-2 finding 2):
//   UPDATE contact_csv_uploads SET status='failed',
//     report = ${tx.json({ contactsCreated: 0, contactsMerged: 0,
//       visitsAdded: 0, duplicateVisits: 0, rejected: [],
//       structuralFailure: null, error: 'ingest_failed' })},
//     raw_csv = NULL, completed_at = NOW()
//   WHERE id = ${uploadId} AND status = 'pending'
// (the status='pending' predicate makes it a no-op if the job actually
// completed after the failure was recorded). Registration in worker/index.ts:
// csvIngestWorker.on('failed', ...) at the SAME site the zernio ingest worker
// attaches its failed-hook — mirror that wiring line-for-line, including how
// it guards `job !== undefined` and max-attempts exhaustion. Without this, a
// permanent DB error leaves the upload pending forever — the intake's
// observability contract ("uploads stuck in processing" is the broken-in-prod
// signal) requires stuck to mean BROKEN, not routine. Extend IngestReport with
// `error?: 'ingest_failed'` so the UI can render a terminal failure state.
```

  Intake title VERBATIM (unit test with stubbed sql, mirroring how sibling worker handlers are tested): `csv ingest worker no-ops for subscriptions without full access`.
- [ ] **Step 6: Registration.** `worker/queues.ts`: add `csvIngest: new Queue(QUEUE_NAMES.CSV_INGEST, { connection: opts, defaultJobOptions })` and the `topicToQueue` entry. `worker/index.ts`: `const csvIngestWorker = new Worker<CsvIngestPayload>(QUEUE_NAMES.CSV_INGEST, withJobLogContext((job) => handleCsvIngest(sql, job)), workerOpts);` + attach the emitter-error listener + the `'failed'` exhaustion hook (`csvIngestWorker.on('failed', ...)` → `failed-hook.ts`, mirroring the zernio ingest worker's wiring) + add to the shutdown list — mirror `judgeVerdictWorker`/the zernio ingest worker at every one of those sites.
- [ ] **Step 7: Run `pnpm ci:outbox-topics && pnpm lint && pnpm typecheck && pnpm vitest run src/lib/solicitation worker` and (with `TEST_DATABASE_POOL_URL` set) the integration file directly. Commit** `feat(#541): csv_ingest worker + registration`

---

### Task 6: Contacts read/delete — repo + routes

**Files:**
- Create: `src/lib/solicitation/contacts-repo.ts`
- Create: `src/app/api/dashboard/contacts/route.ts` (GET list)
- Create: `src/app/api/dashboard/contacts/[id]/route.ts` (DELETE)
- Test: `src/lib/solicitation/__tests__/contacts-repo.integration.test.ts`
- Test: extend the Task 4 flag-404 route test to these routes

- [ ] **Step 1: `contacts-repo.ts`** — three tenant-scoped functions, `sql` as explicit param:

```typescript
export interface ContactListItem {
  id: string; name: string; email: string | null; phone: string | null;
  lastVisitDate: string; visitCount: number;
}

/** Bounded page (LIMIT clamped ≤ 100, default 50) ordered by most recent visit. */
export async function listContacts(sql: Sql, accountId: string, businessId: string,
  page: { limit: number; offset: number }): Promise<{ contacts: ContactListItem[]; total: number }>
// SELECT c.id, c.name, c.email, c.phone,
//        MAX(v.visit_date)::text AS last_visit_date, COUNT(v.id)::int AS visit_count
// FROM solicitation_contacts c JOIN solicitation_visits v ON v.contact_id = c.id
// JOIN businesses b ON b.id = c.business_id
// WHERE c.business_id = ${businessId} AND b.account_id = ${accountId}
// GROUP BY c.id ORDER BY MAX(v.visit_date) DESC, c.id
// (contacts carry no account_id — businesses.account_id is the single owner of
//  that pairing; the join IS the account scope check.)
// LIMIT/OFFSET clamped in code; total via COUNT(*) OVER() or a second scoped count.

/** §5 hard delete: visits CASCADE via FK. Returns false when not found/not owned. */
export async function deleteContact(sql: Sql, accountId: string, businessId: string,
  contactId: string): Promise<boolean>
// DELETE FROM solicitation_contacts c
// USING businesses b
// WHERE c.id = ${contactId} AND c.business_id = ${businessId}
//   AND b.id = c.business_id AND b.account_id = ${accountId}
// RETURNING c.id — tenant scope in the WHERE via the businesses join,
// never trust the id alone.
```

- [ ] **Step 2: Routes.** GET list: flag → 404; owner auth (mirror kpis); resolve businessId from the location context exactly as kpis does via `resolveDashboardRequest`/`resolveDashboardLocation`; clamp `limit`/`offset` query params before SQL. DELETE: flag → 404; owner auth; `deleteContact`; false → 404, true → 204.
- [ ] **Step 3: Integration tests**, intake title VERBATIM: `hard delete removes the contact and cascades its visits` (seed contact + visits, delete, assert both tables empty for that id; also assert a different account's delete attempt returns false and deletes nothing).
- [ ] **Step 4: Run suite + `pnpm ci:tenant-scope`. Commit** `feat(#541): contacts list + hard delete`

---

### Task 7: Dashboard page `/dashboard/contacts`

**Files:**
- Create: `src/app/(authenticated)/dashboard/contacts/page.tsx` (server component: flag + auth gate)
- Create: `src/app/(authenticated)/dashboard/contacts/ContactsClient.tsx` (client island)
- Test: only if neighboring dashboard pages have colocated tests — mirror them

FIRST: invoke the `repworth-brand-design` skill and follow it (island layout, tokens, no-slop rules). Mirror the nearest existing dashboard page's server/client split and data-fetch style before writing any JSX — name the page you mirrored in the task summary.

- [ ] **Step 1: Server component `page.tsx`**: `solicitationWatchEnabled()` false → `notFound()`. Resolve owner/account/location the way the mirrored dashboard page does. Render the client island with the businessId context it needs.
- [ ] **Step 2: Client island** behavior (all API calls to the Task 4/6 routes):
  - Upload card: file input (`.csv`), the `CONSENT_ATTESTATION_TEXT` rendered beside a REQUIRED checkbox (import both constants — text lives server-side; pass text+version to the island as props from the server component so the client bundle doesn't import server-only modules if the module graph complains); submit disabled until a file is chosen AND the checkbox is ticked (Consent attestation is blocking, §4).
  - After POST: poll GET `/api/dashboard/contacts/uploads/[id]` every ~2s while `status === 'pending'` (bounded: stop after 5 minutes with a "still processing — check back" state); then render the report: contacts created/merged, visits added, `duplicate_visit` count, rejected rows table, and a "Download rejected rows" button that client-side assembles `row,reason` CSV from the report JSON into a Blob download (no extra endpoint).
  - Contact list below: paginated table (name, email, phone, last visit, visit count) from GET `/api/dashboard/contacts`; per-row Delete with a confirm step ("Hard delete — removes this person and all their visits permanently"); DELETE then refetch.
  - Error states: 413 → "File exceeds 5 MB", 400 attestation → inline "attestation required", generic failure → retry affordance.
- [ ] **Step 3: `pnpm lint && pnpm typecheck && pnpm build`** (surface includes ui → build must pass).
- [ ] **Step 4: Commit** `feat(#541): /dashboard/contacts upload + report + list UI`

---

### Task 8: Offboarding purge wiring

**Files:**
- Modify: `src/lib/account-offboarding/table-disposition.ts` (three entries)
- Modify: `src/lib/account-offboarding/purge-verification.ts` (only if entries there are maintained per-table — read it first and mirror `competitor_snapshots`)
- Test: `src/lib/account-offboarding/__tests__/` — extend the suite that locks table coverage (find the test asserting every table has a disposition; it will FAIL after Task 1's migration until this task lands — if no such auto-coverage test exists, extend the disposition unit test with the three new tables)

- [ ] **Step 1: Add entries** (mirror the `competitor_snapshots` entry shape at `table-disposition.ts:193`):

```typescript
{
  table: 'contact_csv_uploads',
  disposition: 'hard_delete',
  scopeEvidence: 'direct_account_id',
  purgeVerification: 'must_be_absent',
  reason: 'Upload metadata + consent attestation reference owner-supplied customer PII context and are removed.',
},
{
  table: 'solicitation_contacts',
  disposition: 'hard_delete',
  scopeEvidence: 'direct_business_id',
  purgeVerification: 'must_be_absent',
  reason: 'Owner-uploaded customer contact PII (names, emails, phones) is removed entirely.',
},
{
  table: 'solicitation_visits',
  disposition: 'hard_delete',
  scopeEvidence: 'direct_business_id',
  purgeVerification: 'must_be_absent',
  reason: 'Visit ledger rows carry customer activity notes and are removed with their contacts.',
},
```

- [ ] **Step 2: Test**, intake title VERBATIM: `offboarding purge sweeps uploads, contacts, and visits` — assert the three tables appear in the disposition registry with `hard_delete`/`must_be_absent`, in whatever style the existing disposition tests use.
- [ ] **Step 3: Run the offboarding suite + `pnpm typecheck`. Commit** `feat(#541): offboarding purge covers contacts tables`

---

### Task 9: Registry sweep + full gate

**Files:**
- Modify: `.claude/reference/env-vars.md` (add `SOLICITATION_WATCH_ENABLED` — server-only flag, default off, owner #544 flips staging; follow the file's entry format)
- Modify: `docs/directory.md` (new files under `src/lib/solicitation/`, `worker/jobs/csv-ingest/`, the contacts routes/page — follow existing format)

- [ ] **Step 1: Write both registry entries.**
- [ ] **Step 2: Run the full verify gate**: `bash scripts/verify-gate.sh` with `TEST_DATABASE_POOL_URL` set (db_touching intake ⇒ a SKIP-warning gate is NOT review-ready).
- [ ] **Step 3: Commit** `docs(#541): env-vars + directory entries`

---

## Self-review notes (spec coverage)

- Contract §1.1/§1.2/§1.3 → Tasks 2, 5. §2/§2.1/§2.2 → Tasks 2, 4 (byte cap at route), 5 (`ambiguous_identity`). §3 → Tasks 4, 5, 7. §4 → Tasks 3, 4, 7 (blocking checkbox). §5 → Tasks 1 (CASCADE), 6 (hard delete), 8 (offboarding). §6 → Task 2 (`handles.ts` doc comment carries the commitment). §7 non-goals → excluded everywhere; the ingest completion tx deliberately does NOT insert batch rows (#543's seam is "extend Task 5's terminal-report transaction").
- All 20 intake `tests_to_add` titles appear VERBATIM in Tasks 2, 4, 5, 6, 8.
- `future_date` semantics, `duplicate_visit` note refresh, partial accept, raw-CSV NULLing, flag-404, subscription no-op, CASCADE delete: each has a named test.
